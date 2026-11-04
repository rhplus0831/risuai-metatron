import type { Chat, Message } from "../../../../../shared/database.ts";
import type { GenerationCommand, MemoryChatRef, StructuredMemoryTaskInput } from "../../../../../shared/jobs.ts";
import {
    ADOPTED_WRITER_RUN,
    memoryCostTokens,
    type MemoryEvent,
    type MemoryPage,
    memoryScreenReason,
    type MemorySection,
    type MemoryThread,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    storedMemorySources,
    type StructuredMemoryCostAnswer,
    type StructuredMemoryCostMode,
    type StructuredMemoryRebuildMode,
} from "../../../../../shared/structuredMemory.ts";
import type { MemoryChanges, MemoryContents, MemoryEventWrite } from "../../../data/memoryStore.ts";
import type { ResourceStore } from "../../../data/resourceStore.ts";
import { GenerationRunnerError, type RunningJob } from "../../../jobs/generationJobs.ts";
import { scopeChat } from "../../../jobs/jobScope.ts";
import type { GenerationRunnerDeps } from "../../../jobs/runSetup.ts";
import { jobMemoryBlockingReason, jobMemoryTaskBase } from "../../runner.ts";
import { MEMORY_TASK_LIMITS } from "../memoryTasks.ts";
import { admitRecord, RECORD_REFUSALS } from "./recordJob.ts";
import {
    anchoredMessages,
    confirmedWindows,
    readRecordedMessages,
    readRerecordEvents,
    recordedMessages,
    turnsOf,
    windowOf,
    type WriterCadence,
    writerCadence,
    writerCeiling,
    type WriterCeiling,
    type WriterWindow,
} from "./window.ts";
import type { WriterMemory } from "./writer.ts";

/**
 * A chat's rebuild: its records made again from its transcript, a window at a time, into staged tables
 * (`store.memory.rebuild`), so the live records and the memory revision stay as they are until one
 * atomic swap, and a run that fails or is abandoned leaves them so. The run is a row, not a task, so it
 * outlives a process. `rebuild` takes every confirmed turn and replaces what the transcript can
 * reproduce; `backfill` takes only the turns no event cites and adds to the records.
 *
 * - The plan: the windows are worked out once, at the start, as message ids (`rebuildPlan`), so a step
 *   parses no event to find what is next. A window then reads the chat as stored (`rebuildWindow`).
 * - What a rebuild keeps: a person's work is seeded at the start (`rebuildSeed`), so the writer sees those
 *   pages and a lock binds it. No event is seeded: carrying is decided at the swap (`rebuildChanges`), so a
 *   retraction that lands during the run counts, and the writer reads only what the run wrote.
 * - A backfill stands behind records that already exist, so each of its windows is a historical write
 *   (`server/src/prompt/memory/structured/writer.ts`) on a copy of the live pages, and its swap adds events
 *   and new pages and nothing else.
 *   Rebuilding is what refreshes pages.
 * - Neither touches `hypaV3Data` or any chat: no receipt is written, so a stopped run leaves nothing on
 *   messages, and an adopted chat's stored summaries wait for a reset.
 * - The rest of a run is `rebuildWork` in `server/src/prompt/memory/memoryTasks.ts`, its start and resume a
 *   command job (`runMemoryRebuild`), and its lock the run row (`server/src/jobs/generationJobs.ts`).
 */

/** A chat's pages, events, and threads, whole. */
export type MemoryRecordSet = { pages: MemoryPage[]; events: MemoryEvent[]; threads: MemoryThread[] };

/** Every record `memory` holds of a chat but its runs, with the contents listing them; null without any. */
export function readRecordSet(
    memory: Pick<WriterMemory, "readContents" | "readRecord">,
    chaId: string,
    chatId: string,
): (MemoryRecordSet & { contents: MemoryContents }) | null {
    const contents = memory.readContents(chaId, chatId);
    return (
        contents && {
            contents,
            pages: contents.pages.flatMap(({ id }) => memory.readRecord(chaId, chatId, "pages", id)?.data ?? []),
            events: contents.events.flatMap(({ id }) => memory.readRecord(chaId, chatId, "events", id)?.data ?? []),
            threads: contents.threads.flatMap(({ id }) => memory.readRecord(chaId, chatId, "threads", id)?.data ?? []),
        }
    );
}

/**
 * The messages a rebuild leaves out: cited by a retracted event and by no event that is not. So a person's
 * retraction keeps its messages out, while the event a re-record retired, whose replacement cites the same
 * messages, does not.
 */
function retractedMessages(events: readonly MemoryEvent[]): Set<string> {
    const standing = recordedMessages(events.filter(({ status }) => status !== "retracted"));
    const retracted = recordedMessages(events.filter(({ status }) => status === "retracted"));
    return new Set([...retracted].filter((id) => !standing.has(id)));
}

/**
 * The windows of a run, oldest first, each the message ids of `turns` turns. The confirmed messages run
 * through the newest eligible reply, inclusive, because a person's start confirms it, as a press of record
 * now does. Unlike the writer's own windows, a turn does not drop out for a recorded reply: each lists the
 * messages `mode` does not exclude, and one with any left counts, which is what takes the user messages an
 * adopted chat's summaries left uncovered. A reply `screening` keeps out of the writer's windows is dropped
 * before the turns are made, so the user message before it folds into the next turn. Empty when there is
 * nothing to do.
 */
export function rebuildPlan({
    messages,
    events,
    mode,
    turns,
    screening,
}: {
    messages: readonly Message[];
    events: readonly MemoryEvent[];
    mode: StructuredMemoryRebuildMode;
    turns: 1 | 2;
    screening: WriterCadence["screening"];
}): string[][] {
    const anchored = anchoredMessages(messages);
    const confirmed = anchored
        .slice(0, anchored.findLastIndex(({ message }) => message.role === "char") + 1)
        .filter(({ message }) => memoryScreenReason(message, screening) === null);
    const excluded = mode === "rebuild" ? retractedMessages(events) : recordedMessages(events);
    const open = turnsOf(confirmed)
        .map((turn) => turn.flatMap(({ id }) => (excluded.has(id) ? [] : [id])))
        .filter((ids) => ids.length > 0);
    const plan: string[][] = [];
    for (let start = 0; start < open.length; start += turns) {
        plan.push(open.slice(start, start + turns).flat());
    }
    return plan;
}

/** Whether a person marked `section`: such a section outlives a rebuild whole. */
const sectionMarked = ({ locked, pinned, suppressed, userCorrected }: MemorySection) =>
    locked || !!pinned || !!suppressed || !!userCorrected;

/**
 * What a rebuild keeps of `page` at its start, or null when nothing of it is a person's: its identity,
 * its marked sections whole, those headings' history, and no links, and of the scene no attendance. Only
 * a marked section seeds the scene page: its `always` is code's, not a choice. A page a person merged or
 * split (`reshaped`) seeds with all of its sections and history: the arrangement is theirs, and a page
 * seeded without it would be written anew or, with nothing marked, removed at the swap.
 * A non-scene page also seeds when its grade is a person's (`gradeByUser`) or its `contextMode` is not
 * `auto`, even with no marked section: these are choices the rebuild must not discard.
 */
function seededPage(page: MemoryPage): MemoryPage | null {
    const sections = page.reshaped ? page.sections : page.sections.filter(sectionMarked);
    const chosen = page.type !== "scene" && (page.gradeByUser === true || page.contextMode !== "auto");
    if (sections.length === 0 && !chosen && !page.reshaped) {
        return null;
    }
    const headings = new Set(sections.map(({ heading }) => heading));
    const { participants, ...identity } = page;
    return {
        ...identity,
        sections,
        links: [],
        history: page.reshaped
            ? page.history
            : page.history.filter(({ heading }) => heading !== null && headings.has(heading)),
        ...(page.type === "scene" ? { participants: [] } : {}),
    };
}

/**
 * The staged records a run starts from. A rebuild keeps the pages with a person's work on them
 * (`seededPage`) and the threads a person added, so a page it does not name is written anew and a language
 * change retitles it. A backfill takes the live pages verbatim, so its cast is real, and no thread, since it
 * moves none.
 * Seeded pages keep their ids for patches by `server/src/prompt/memory/structured/writer.ts`; their locks
 * still bind that writer.
 */
export function rebuildSeed(
    mode: StructuredMemoryRebuildMode,
    { pages, threads }: Pick<MemoryRecordSet, "pages" | "threads">,
): Pick<MemoryChanges, "pages" | "threads"> {
    return mode === "backfill"
        ? { pages }
        : {
              pages: pages.flatMap((page) => seededPage(page) ?? []),
              threads: threads.filter(({ openedBy }) => openedBy === undefined),
          };
}

/** A window of the plan as the chat stands now, with the ceiling its commit reads it under. */
export type RebuildWindow = { window: WriterWindow; ceiling: WriterCeiling };

/**
 * The plan's window `ids` from `messages` as stored: those a send still reads and `screening` leaves in,
 * since a reply can be edited after the plan was taken, in chat order, with fresh anchors. Its own last
 * message is its ceiling, inclusive. Null with none left.
 */
export function rebuildWindow(
    messages: readonly Message[],
    ids: readonly string[],
    screening: WriterCadence["screening"],
): RebuildWindow | null {
    const wanted = new Set(ids);
    const entries = anchoredMessages(messages).filter(
        ({ id, message }) => wanted.has(id) && memoryScreenReason(message, screening) === null,
    );
    const last = entries.at(-1);
    return last ? { window: windowOf(entries), ceiling: { id: last.id, inclusive: true } } : null;
}

const sourceIds = ({ sources }: Pick<MemoryEvent, "sources">) =>
    storedMemorySources(sources).map(({ messageId }) => messageId);

/** `staged` with its sections a person marked on `live` put back whole, each with that heading's history. */
function withMarkedSections(staged: MemoryPage, live: MemoryPage): MemoryPage {
    const marked = new Map(live.sections.filter(sectionMarked).map((section) => [section.heading, section]));
    if (marked.size === 0) {
        return staged;
    }
    const written = new Set(staged.sections.map(({ heading }) => heading));
    return {
        ...staged,
        sections: [
            ...staged.sections.map((section) => marked.get(section.heading) ?? section),
            ...[...marked.values()].filter(({ heading }) => !written.has(heading)),
        ],
        history: [
            ...live.history.filter(({ heading }) => heading !== null && marked.has(heading)),
            ...staged.history.filter(({ heading }) => heading === null || !marked.has(heading)),
        ].slice(-LIMITS.pageHistoryEntries),
    };
}

/**
 * A staged event as it goes live, with no revision, which the store stamps. `pinned`, `suppressed` and
 * `userCorrected` are the union from standing overlapping live events, carried ones included, so a
 * partially rebuilt suppressed event cannot expose its surviving text. Adoption lineage is separate:
 * `ADOPTED_WRITER_RUN` or `adoptedSummaries` on any overlapping event, retracted ones included, keeps
 * the stored summaries resettable through later rebuilds.
 */
function swappedEvent(
    { createdRevision, ...event }: MemoryEvent,
    overlapping: readonly MemoryEvent[],
): MemoryEventWrite {
    const standing = overlapping.filter(({ status }) => status !== "retracted");
    return {
        ...event,
        ...(standing.some(({ pinned }) => pinned) ? { pinned: true } : {}),
        ...(standing.some(({ suppressed }) => suppressed) ? { suppressed: true } : {}),
        ...(standing.some(({ userCorrected }) => userCorrected) ? { userCorrected: true } : {}),
        ...(overlapping.some(({ writerRun, adoptedSummaries }) => writerRun === ADOPTED_WRITER_RUN || adoptedSummaries)
            ? { adoptedSummaries: true }
            : {}),
    };
}

/**
 * What the swap writes of `staged` over `live`, or null for a run that recorded no event, which must leave
 * the live records alone. Called in the swap's synchronous step, so each list is read once in the run's life.
 *
 * A rebuild replaces a live event only when it is not retracted, has a source, and every source's message
 * is cited by a staged event: a replacement committed for everything it said. Any other is carried, left
 * in the table as it is, which takes in every retracted event and an adopted summary with a source that is
 * gone or disabled, past the plan, or none. Each staged event takes the marks of every standing live event
 * it shares a message with, carried ones included, so rebuilding what survives of a suppressed event does
 * not expose it, and the adoption's lineage from any such event, so a chat rebuilt any number of times
 * keeps the reset of its stored summaries. Pages and threads not in the staged set go: an event carried
 * may then name a page that is gone and a page's `provenance` an event that is, and dangling ids are legal.
 * A section a person marked goes back whole from the live page, a corrected one too although a patch may
 * replace it in an ordinary run, with its heading's history, so the history never sits under a body it
 * does not lead to.
 *
 * A backfill writes the staged events and the pages that are not live: a page that is stays as it stands,
 * with any flag it gained during the run, and a link a historical event would add to it is dropped.
 * Trashed pages stay untouched: `live.pages` comes from `contents.pages`, which excludes trash in
 * `server/src/data/memoryStore.ts`, so their ids are never removed here.
 */
export function rebuildChanges(
    mode: StructuredMemoryRebuildMode,
    live: MemoryRecordSet,
    staged: MemoryRecordSet,
): MemoryChanges | null {
    if (staged.events.length === 0) {
        return null;
    }
    const livePages = new Map(live.pages.map((page) => [page.id, page]));
    if (mode === "backfill") {
        return {
            events: staged.events.map((event) => swappedEvent(event, [])),
            pages: staged.pages.filter(({ id }) => !livePages.has(id)),
        };
    }
    const cited = new Set(staged.events.flatMap(sourceIds));
    const replaced = live.events.filter((event) => {
        const ids = sourceIds(event);
        return event.status !== "retracted" && ids.length > 0 && ids.every((id) => cited.has(id));
    });
    const citing = new Map<string, MemoryEvent[]>();
    for (const event of live.events) {
        for (const id of sourceIds(event)) {
            citing.set(id, [...(citing.get(id) ?? []), event]);
        }
    }
    const stagedPages = new Set(staged.pages.map(({ id }) => id));
    const stagedThreads = new Set(staged.threads.map(({ id }) => id));
    return {
        events: staged.events.map((event) =>
            swappedEvent(
                event,
                sourceIds(event).flatMap((id) => citing.get(id) ?? []),
            ),
        ),
        pages: staged.pages.map((page) => {
            const stored = livePages.get(page.id);
            return stored ? withMarkedSections(page, stored) : page;
        }),
        threads: staged.threads,
        remove: {
            events: replaced.map(({ id }) => id),
            pages: live.pages.flatMap(({ id }) => (stagedPages.has(id) ? [] : [id])),
            threads: live.threads.flatMap(({ id }) => (stagedThreads.has(id) ? [] : [id])),
        },
    };
}

/**
 * The store a rebuild's writer and its commits work on: the staged records in place of the live ones, with
 * a closing commit, the one with a `recorded` run, moving the cursor, so progress and what it stands for
 * commit together. It answers that the chat has no run: a run's own commits must pass `commitWindow`.
 */
export function rebuildStore(store: Pick<ResourceStore, "memory" | "chatMeta" | "readChatSource" | "messagesLocked">) {
    const { staged } = store.memory.rebuild;
    return {
        chatMeta: store.chatMeta,
        readChatSource: store.readChatSource,
        messagesLocked: store.messagesLocked,
        memory: {
            ...staged,
            write: (
                chaId: string,
                chatId: string,
                options: { epoch: string | undefined; baseRevision: string },
                changes: MemoryChanges,
            ) =>
                staged.write(
                    chaId,
                    chatId,
                    { ...options, advance: changes.runs?.some(({ result }) => result === "recorded") ?? false },
                    changes,
                ),
            rebuild: { status: () => null },
        },
    };
}

/** What `windows` come to as a preview. */
function windowsCost(windows: readonly (readonly Pick<Message, "data">[])[]): StructuredMemoryCostAnswer {
    const messages = windows.flat();
    const bytes = messages.reduce((total, { data }) => total + Buffer.byteLength(data, "utf8"), 0);
    return {
        calls: windows.length,
        messages: messages.length,
        estimatedTokens: memoryCostTokens(bytes, windows.length),
    };
}

/**
 * What a press would cost, from the chat as stored and its live records; null for a missing chat. Reads only.
 * `turns` is what the tab would ask of a rebuild or a backfill. Record now's windows are the writer's own,
 * in windows of `turns` turns, because a route has no job scope to read the cadence from, up to
 * `maxWriterWindows`, marked events first.
 */
export async function memoryWorkCost(
    store: Pick<ResourceStore, "memory" | "readChatSource">,
    { chaId, chatId }: MemoryChatRef,
    { mode, turns, through }: { mode: StructuredMemoryCostMode; turns: 1 | 2; through?: string },
): Promise<StructuredMemoryCostAnswer | null> {
    const chat = store.readChatSource(chaId, chatId).data as Chat | null;
    if (!chat) {
        return null;
    }
    // A route has no job scope, so the preset's screening is read from the store.
    const { screening } = store.memory.readWriterSettings();
    if (mode !== "record") {
        const listed = store.memory.readContents(chaId, chatId)?.events ?? [];
        const events = listed.flatMap(({ id }) => store.memory.readRecord(chaId, chatId, "events", id)?.data ?? []);
        return windowsCost(
            rebuildPlan({ messages: chat.message, events, mode, turns, screening }).map(
                (ids) => rebuildWindow(chat.message, ids, screening)?.window.messages ?? [],
            ),
        );
    }
    const confirmedBefore = through ?? writerCeiling(chat.message);
    const windows =
        confirmedBefore === null
            ? null
            : await confirmedWindows({
                  messages: chat.message,
                  confirmedBefore,
                  inclusive: through !== undefined,
                  recorded: readRecordedMessages(store, chaId, chatId),
                  cadence: { cadence: "everyK", cadenceTurns: turns, cadenceTokens: 1, cadenceRatio: 0.5, screening },
                  maxContext: 0,
                  tokenizer: { tokenizeChat: () => Promise.resolve(0) },
                  limit: MEMORY_TASK_LIMITS.maxWriterWindows,
                  manual: true,
                  rerecord: readRerecordEvents(store, chaId, chatId),
              });
    return windowsCost((windows ?? []).map(({ messages }) => messages));
}

const refusal = (message: string) => new GenerationRunnerError(409, message, { stage: "setup" });

/**
 * The `memoryRebuild` command: a person's start or resume of a chat's rebuild. A job because it brings the
 * tab's context, the chat's slot, and the whole of admission, and because the service keeps no input across
 * a restart, so a resume after one takes a fresh input.
 *
 * Admitted as record now is, so a chat that waits for its adoption choice stays held. Past that it is
 * refused when the memory model needs the tab, which a chained task cannot reach, with no service, while
 * the chat's task is live, when a start finds a run there, and when a resume finds none, or one the whole
 * chat was replaced under: only abandoning is left then. The run's first write and its task are one
 * synchronous step: a start refused there abandons what it began, and a refused resume leaves the run.
 * A resume takes the settings as they stand, so a language change mid-run leaves a mix.
 */
export async function runMemoryRebuild(
    job: RunningJob,
    command: Extract<GenerationCommand, { type: "memoryRebuild" }>,
    deps: GenerationRunnerDeps,
): Promise<void> {
    const { store, memoryTasks } = deps;
    const { characterId, chatId } = job.context;
    const chatRef = { chaId: characterId, chatId };
    const scope = admitRecord(job, deps, undefined);
    if (jobMemoryBlockingReason(scope) !== null) {
        throw refusal("The memory model needs this tab, so a rebuild cannot run on the server");
    }
    if (!memoryTasks) {
        throw refusal("Rebuilding needs the server's memory tasks, which are off");
    }
    const task = memoryTasks.status(chatRef)?.state;
    if (task === "queued" || task === "running") {
        throw refusal("The memory writer is working in this chat. Try again when it ends.");
    }
    const queue = (plan: readonly (readonly string[])[]) => {
        const owner = scope.db.characters.find((entry) => entry?.chaId === characterId);
        const input: StructuredMemoryTaskInput = {
            ...jobMemoryTaskBase({
                job,
                scope,
                sourceGeneration: scope.chatSourceGeneration!,
                speakerId: owner?.type === "group" ? null : characterId,
                fromChain: false,
                chatAdditionalTokens: 0,
            }),
            kind: "structuredMemory",
            confirmedBefore: plan.at(-1)?.at(-1) ?? "",
            rebuild: true,
        };
        return memoryTasks.rebuild(input);
    };
    const queueRefusal = (reason: keyof typeof RECORD_REFUSALS) => {
        const { status, message } = RECORD_REFUSALS[reason];
        return new GenerationRunnerError(status, message, { stage: "setup" });
    };
    const run = store.memory.rebuild.status(characterId, chatId);
    if ("resume" in command) {
        if (!run) {
            throw refusal("This chat has no rebuild to resume");
        }
        if (!run.resumable) {
            throw refusal("This chat was replaced after its rebuild began, so the rebuild can only be abandoned");
        }
        job.assertWritable?.();
        const answer = queue(store.memory.rebuild.plan(characterId, chatId) ?? []);
        if (answer.outcome === "refused") {
            throw queueRefusal(answer.reason);
        }
        store.memory.rebuild.noteStop(characterId, chatId, { epoch: job.epoch });
    } else {
        if (run) {
            throw refusal("This chat already holds a rebuild");
        }
        const { mode, turns } = command;
        const records = readRecordSet(store.memory, characterId, chatId);
        const plan = rebuildPlan({
            messages: scopeChat(scope)?.message ?? [],
            events: records?.events ?? [],
            mode,
            turns,
            screening: writerCadence(scope.db).screening,
        });
        if (!records || plan.length === 0) {
            throw refusal("This chat has no turn to record");
        }
        job.assertWritable?.();
        store.memory.rebuild.begin(characterId, chatId, { epoch: job.epoch, mode, plan }, rebuildSeed(mode, records));
        const answer = queue(plan);
        if (answer.outcome === "refused") {
            store.memory.rebuild.abandon(characterId, chatId, job.epoch);
            throw queueRefusal(answer.reason);
        }
    }
    // Synchronous after queueing: the service starts a queued input on a later turn, so after this terminal.
    job.emit({ type: "done", revision: store.chatRevision(characterId, chatId) });
}
