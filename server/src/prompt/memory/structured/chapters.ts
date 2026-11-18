import { randomUUID } from "node:crypto";
import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import type { Message } from "../../../../../shared/database.ts";
import type { MemoryChatRef, MemoryTaskBase } from "../../../../../shared/jobs.ts";
import {
    type MemoryChapter,
    type MemoryEvent,
    type MemoryStoryDate,
    type StructuredMemoryChaptersResult,
    memoryChapterMark,
    memoryChapterUnits,
    storedStoryDate,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";
import { orderMemoryEvents } from "../../../data/memoryStore.ts";
import { ResourceValidationError, type ResourceStore } from "../../../data/resourceStore.ts";
import { GenerationRunnerError, markFailure, type RunningJob } from "../../../jobs/generationJobs.ts";
import type { JobScope } from "../../../jobs/jobScope.ts";
import type { GenerationRunnerDeps } from "../../../jobs/runSetup.ts";
import { jobMemoryBlockingReason, jobMemoryTaskBase } from "../../runner.ts";
import type { MemoryHost } from "../host.ts";
import { createMemoryTaskHost, MemoryHostFailure } from "../memoryTaskHost.ts";
import { answerJson } from "./analysis.ts";
import { storedText } from "./pages.ts";
import { assembleChapterPrompt, chapterSlots } from "./prompts.ts";
import { admitRecord } from "./recordJob.ts";
import { detachedHostDeps } from "./testRun.ts";
import { writerHostDeps, writerLanguage, writerSettings } from "./writer.ts";

/**
 * Makes display chapters from older Timeline events, or remakes a chapter from its surviving
 * members. Each request reads one ordered set of events and writes no writer run or token totals.
 * The caller's guard checks cancellation, maintenance, epoch and chat source generation before
 * requests and writes. One process owns the database and its store calls are synchronous, so no
 * writer lease is needed: nothing can write between checking the current ids and marks and saving
 * the chapter. A refused guard or a thrown host failure ends the call. Earlier chapters and the
 * initial removal of orphaned chapters stay committed.
 */

type ChapterStore = Pick<ResourceStore, "memory" | "readChatSource">;
type ChapterCall = Pick<MemoryTaskBase, "chatRef" | "epoch"> & {
    store: ChapterStore;
    scope: JobScope;
    host: MemoryHost;
    guard: () => void;
};
type ChapterEvent = { id: string; mark: string; date?: MemoryStoryDate; title: string; summary: string };
type ChapterText = Pick<MemoryChapter, "title" | "synopsis">;

function listChapters(store: ChapterStore, { chaId, chatId }: MemoryChatRef): MemoryChapter[] {
    const listed = store.memory.chapters.list(chaId, chatId);
    if (listed === "tooLarge") throw new Error("Chapter list exceeded an unbounded read");
    return listed?.chapters ?? [];
}

/** Read event bodies in storage order, the tie breaker when several share a source. */
function readEvents(store: ChapterStore, { chaId, chatId }: MemoryChatRef, members?: ReadonlySet<string>) {
    const listed = store.memory.readKinds(chaId, chatId, ["events"]);
    const events: MemoryEvent[] = [];
    for (const { id } of listed?.events ?? []) {
        if (members && !members.has(id)) continue;
        const event = store.memory.readRecord(chaId, chatId, "events", id)?.data;
        if (event) events.push(event);
    }
    return events;
}

function placedEvents(events: readonly MemoryEvent[], messages: readonly Message[]): ChapterEvent[] {
    return orderMemoryEvents(events, messages).flatMap(({ event, position }) => {
        if (event.status === "retracted" || position === Infinity) return [];
        const date = storedStoryDate(event.storyTime?.date);
        const title = storedText(event.title);
        const summary = storedText(event.summary);
        return [{ id: event.id, mark: memoryChapterMark(title, summary, date), date, title, summary }];
    });
}

/** Currently eligible units, oldest first, or null for a missing chat. Covered events bound the loose runs. */
export function chapterUnits(store: ChapterStore, chatRef: MemoryChatRef): ChapterEvent[][] | null {
    const chat = store.readChatSource(chatRef.chaId, chatRef.chatId).data;
    if (!chat) return null;
    const covered = new Set(listChapters(store, chatRef).flatMap(({ events }) => events.map(({ id }) => id)));
    const events = placedEvents(readEvents(store, chatRef), chat.message);
    const { eventsPerGroup } = store.memory.readWriterSettings(chat.memoryPresetId);
    return memoryChapterUnits(
        events.map((event) => ({ ...event, chaptered: covered.has(event.id) })),
        eventsPerGroup,
        LIMITS.chapterRecentEvents,
    );
}

/** A usable title and synopsis from the model's answer, within their stored UTF-16 limits. */
export function readChapter(text: string): ChapterText | null {
    const json = answerJson(text);
    if (!json.ok || !isPlainObject(json.value)) return null;
    const title = clampText(storedText(json.value.title).trim(), LIMITS.eventTitleChars).trimEnd();
    const synopsis = clampText(storedText(json.value.synopsis).trim(), LIMITS.chapterSynopsisChars).trimEnd();
    return title && synopsis ? { title, synopsis } : null;
}

async function requestChapter(
    { host, scope, chatRef, guard }: ChapterCall,
    events: ChapterEvent[],
): Promise<ChapterText | { reason: string }> {
    const slots = chapterSlots({ language: writerLanguage({ scope, host, input: { chatRef } }), events });
    const messages = assembleChapterPrompt(host, writerSettings(host).instructions, slots);
    guard();
    const response = await host.request(messages);
    if (response.type === "fail") return { reason: host.redact(response.result) };
    if (response.type !== "success") return { reason: host.redact(`Unexpected response type: ${response.type}`) };
    if (typeof response.result !== "string" || !response.result.trim()) {
        return { reason: host.redact("The model's answer is empty") };
    }
    return readChapter(response.result) ?? { reason: host.redact("The answer needs a chapter title and synopsis") };
}

function sameMembers(current: ChapterEvent[], sent: ChapterEvent[]): boolean {
    return (
        current.length === sent.length && current.every(({ id, mark }, i) => id === sent[i].id && mark === sent[i].mark)
    );
}

function newChapter(text: ChapterText, events: ChapterEvent[]): MemoryChapter {
    return { id: randomUUID(), ...text, events: events.map(({ id, mark }) => ({ id, mark })) };
}

/** Remove orphaned chapters first, then attempt each ordered unit at most once, up to the request limit. */
export async function makeChapters(arg: ChapterCall & { limit: number }) {
    const { store, chatRef, epoch, guard, limit } = arg;
    const { chaId, chatId } = chatRef;
    guard();
    const orphans = listChapters(store, chatRef).filter(
        (chapter) =>
            !chapter.events.some(({ id }) => {
                const event = store.memory.readRecord(chaId, chatId, "events", id)?.data;
                return event && event.status !== "retracted";
            }),
    );
    if (orphans.length) {
        store.memory.chapters.remove(
            chaId,
            chatId,
            epoch,
            orphans.map(({ id }) => id),
        );
    }

    const attempted = new Set<string>();
    let made = 0;
    let failed = 0;
    const unitKey = (unit: ChapterEvent[]) => JSON.stringify(unit.map(({ id }) => id));
    for (;;) {
        const units = chapterUnits(store, chatRef) ?? [];
        const unit = attempted.size < limit && units.find((events) => !attempted.has(unitKey(events)));
        if (!unit) return { made, failed, left: units.length };
        attempted.add(unitKey(unit));
        const answer = await requestChapter(arg, unit);
        guard();
        if ("reason" in answer || !chapterUnits(store, chatRef)?.some((events) => sameMembers(events, unit))) {
            failed++;
            continue;
        }
        try {
            store.memory.chapters.add(chaId, chatId, epoch, newChapter(answer, unit));
            made++;
        } catch (error) {
            if (!(error instanceof ResourceValidationError)) throw error;
            failed++;
        }
    }
}

/** Unretracted listed events may keep the chapter alive even when no message places them. */
function remakeMembers(store: ChapterStore, chatRef: MemoryChatRef, chapterId: string) {
    const chapter = listChapters(store, chatRef).find(({ id }) => id === chapterId);
    if (!chapter) return null;
    const chat = store.readChatSource(chatRef.chaId, chatRef.chatId).data;
    if (!chat) return null;
    const members = new Set(chapter.events.map(({ id }) => id));
    const live = readEvents(store, chatRef, members).filter(({ status }) => status !== "retracted");
    return { live: live.length, placed: placedEvents(live, chat.message) };
}

/** A repeat after removal answers "removed" without a write. A failed or outdated remake keeps the old chapter. */
export async function remakeChapter(
    arg: ChapterCall & { chapterId: string },
): Promise<"replaced" | "removed" | "kept"> {
    const { store, chatRef, epoch, chapterId, guard } = arg;
    const { chaId, chatId } = chatRef;
    guard();
    const members = remakeMembers(store, chatRef, chapterId);
    if (!members) return "removed";
    if (!members.live) {
        store.memory.chapters.remove(chaId, chatId, epoch, [chapterId]);
        return "removed";
    }
    if (!members.placed.length) return "kept";
    const answer = await requestChapter(arg, members.placed);
    guard();
    if ("reason" in answer) return "kept";
    const current = remakeMembers(store, chatRef, chapterId);
    if (!current || !sameMembers(current.placed, members.placed)) return "kept";
    try {
        store.memory.chapters.replace(chaId, chatId, epoch, chapterId, newChapter(answer, members.placed));
        return "replaced";
    } catch (error) {
        if (!(error instanceof ResourceValidationError)) throw error;
        return "kept";
    }
}

const CHAPTER_REFUSALS: Readonly<Record<NonNullable<ReturnType<typeof jobMemoryBlockingReason>>, string>> = {
    pluginModel: "The memory model is a plugin model, which needs this tab, so it cannot make chapters",
    requestTrigger:
        "A request trigger applies to this chat's requests, which needs this tab, so it cannot make chapters",
};

/** Run a chapter command under record admission and the detached writer's model request policy. */
export async function runMemoryChapters(job: RunningJob, deps: GenerationRunnerDeps): Promise<void> {
    const { command } = job;
    if (command?.type !== "memoryChapters") {
        throw new GenerationRunnerError(400, "Expected a memoryChapters command", { stage: "setup" });
    }
    const { store } = deps;
    const { characterId, chatId } = job.context;
    const scope = admitRecord(job, deps, undefined);
    try {
        const blocking = jobMemoryBlockingReason(scope);
        if (blocking !== null) throw new GenerationRunnerError(409, CHAPTER_REFUSALS[blocking]);
        const status = deps.memoryTasks?.status({ chaId: characterId, chatId });
        if (status?.state === "queued" || status?.state === "running") {
            throw new GenerationRunnerError(409, "The memory writer is working in this chat. Try again when it ends.");
        }
    } catch (error) {
        throw markFailure(error, { stage: "setup" });
    }
    job.emit({ type: "stage", stage: "memory" });
    const owner = scope.db.characters.find((entry) => entry?.chaId === characterId);
    const base = jobMemoryTaskBase({
        job,
        scope,
        sourceGeneration: scope.chatSourceGeneration!,
        speakerId: owner?.type === "group" ? null : characterId,
        fromChain: false,
        chatAdditionalTokens: 0,
    });
    const guard = () => {
        if (job.signal.aborted) throw job.signal.reason ?? new Error("The chapter command was aborted");
        job.assertWritable?.();
        if (store.epoch() !== base.epoch || store.chatSourceGeneration(characterId, chatId) !== base.sourceGeneration) {
            throw new GenerationRunnerError(409, "The chat changed while making chapters");
        }
    };
    const { host } = createMemoryTaskHost({
        scope,
        input: base,
        deps: writerHostDeps(detachedHostDeps(deps)),
        signal: job.signal,
        fence: guard,
    });
    try {
        const arg = { store, scope, host, chatRef: base.chatRef, epoch: base.epoch, guard };
        const result: StructuredMemoryChaptersResult =
            "limit" in command
                ? { kind: "memoryChapters", ...(await makeChapters({ ...arg, limit: command.limit })) }
                : { kind: "memoryChapters", remade: await remakeChapter({ ...arg, chapterId: command.remake }) };
        guard();
        job.emit({ type: "done", revision: store.chatRevision(characterId, chatId), result });
    } catch (error) {
        if (error instanceof MemoryHostFailure) {
            throw new GenerationRunnerError(500, error.message, { stage: "request" });
        }
        throw error;
    }
}
