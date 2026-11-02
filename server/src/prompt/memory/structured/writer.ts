import { randomUUID } from "node:crypto";
import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import type { ChatGroup, ChatOp } from "../../../../../shared/chats.ts";
import type { Chat, Message } from "../../../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import type { OpenAIChat } from "../../../../../shared/openai.ts";
import { MAX_READ_RESPONSE_BYTES } from "../../../../../shared/resources.ts";
import {
    type MemoryAnalysisResult,
    type MemoryAnchoredSource,
    type MemoryPage,
    type MemoryReceipt,
    type MemoryRun,
    type MemoryThread,
    memoryThreadEnded,
    normalizeStructuredMemorySettings,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    structuredMemoryHighlightOverride,
    structuredMemoryWriterLanguage,
    writerPaused,
} from "../../../../../shared/structuredMemory.ts";
import type { MemoryChanges, MemoryContents, MemoryEventWrite } from "../../../data/memoryStore.ts";
import { ResourceBatchConflictError, ResourceConflictError, type ResourceStore } from "../../../data/resourceStore.ts";
import { jobModuleLorebooks } from "../../../jobs/cbsHost.ts";
import { JobWriteConflictError } from "../../../jobs/generationJobs.ts";
import { scopeChat } from "../../../jobs/jobScope.ts";
import { resolveJobRequestModel } from "../../../llm/request.ts";
import { HypaProcesser } from "../../embeddings.ts";
import type { MemoryHost } from "../host.ts";
import { MemoryHostFailure, type MemoryTaskHostDeps } from "../memoryTaskHost.ts";
import type { StructuredMemoryCommit, StructuredMemoryWriter, StructuredMemoryWriterResult } from "../memoryTasks.ts";
import { adoptedEvents } from "./adopt.ts";
import { admitAnalysis, type Admission, parseAnalysis } from "./analysis.ts";
import { type Compaction, compactionTargets, readCompaction } from "./compact.ts";
import {
    type AliasSeed,
    aliasSeeds,
    castSlice,
    type HighlightRule,
    type PagePlan,
    planPages,
    sectionWarning,
    storedText,
    type Warning,
    windowSpeaker,
    withoutFrozenTargets,
} from "./pages.ts";
import { commitPages, parsePatches, showTargets } from "./patches.ts";
import {
    analysisSlots,
    assembleAnalysisPrompt,
    assembleCompactPrompt,
    assemblePatchPrompt,
    compactSlots,
    patchSlots,
    sceneTakenBackLines,
} from "./prompts.ts";
import { eventVectorTexts } from "./retrieve.ts";
import { windowStillConfirmed, type WriterCeiling, type WriterWindow } from "./window.ts";

export { writerPaused };

/**
 * The Structured Memory writer: an analysis call per window, a patch call when a page candidate was
 * accepted, a compaction call for each section a patch left past its budget, and a `memory_runs` row
 * that shows how it went. The rows are the writer's whole state: a restart loses nothing, and pausing
 * needs no table of its own.
 *
 * - Hold: a chat with HypaV3 summaries and no records waits for a person to adopt or decline them in the
 *   memory panel (`adoptionHold`), which keeps one owner per chat. No run opens, a manual one included,
 *   with no call and no row (`awaitingAdoption`), and `commitWindow` refuses a run that met the hold
 *   later. Nothing is lost by waiting: the summaries stay stored, and so do the turns.
 * - Interrupted runs: one task runs per chat, so a `pending` row found at a start is abandoned (a
 *   cancel, a checkpoint load, maintenance, a restart, a deadline). The write that opens the new run
 *   closes it `skipped` (`interrupted`). It proves nothing about the model, so it is no failure.
 * - Pause: `consecutiveFailures` failed rows at the end of the runs, with skipped rows neither counting
 *   nor resetting and a recorded one resetting, stop an automatic run with no call and no row
 *   (`writerPaused`). A manual start runs past it.
 * - Replay: the newest row that did not record is the only one read. Its input is sent again, exactly,
 *   when its window (by message id and hash) and its settings are still this run's, and it lists all a
 *   person took back of the scene since; otherwise, so that fixed instructions take effect, a regrouped
 *   window rebuilds, and a reverted scene stays reverted, the prompt is built anew.
 * - Snapshot: no analysis call is made before its exact input is stored in a `pending` row. An input too
 *   large for a record fails the run with no call.
 * - Failure: a provider failure, an empty or unexpected answer, or an answer `parseAnalysis` refuses
 *   ends the run `failed`, with a redacted error and no event. A `MemoryHostFailure` does too, and goes
 *   on to end the task. Any other throw, which is an ended task or an abort, leaves the row `pending`
 *   for the next run to close, and `commit`'s own check throws once the task ended: that is how output
 *   after the deadline is discarded.
 * - Patch call: it comes after admission, so it holds the admitted event and everything on a page traces
 *   to that event. It has no snapshot of its own: a retry replays the analysis, and the closing write
 *   keeps what it sent. It fails as the analysis call does, `patchFailed`, because an event committed
 *   without it would close the window for good. A page it may not touch is no such failure: that page is
 *   listed and the rest commit.
 * - Compaction: it comes before the commit, in the one run, so the event, its pages, and the recorded run
 *   stay one commit. A dry run of that commit names the sections, each gets one call, and every attempt of
 *   the commit works everything out again, so no id of the dry run reaches a record and a compaction
 *   the records no longer allow is dropped (`compact.ts`). A failed call, or an answer that is not kept,
 *   is a warning and the run goes on: a compaction is never why a window stays open. A `MemoryHostFailure`
 *   or any other throw goes as for the patch call. Its prompt and answer stay out of the run, whose record
 *   margin does not cover them.
 * - Success: one commit writes the event, its threads, its pages, and the recorded run. A refusal for
 *   the revision admits the answer again against fresh records, with no call, and a new page keeps its
 *   id, which the patches name.
 * - Receipt: a recorded or failed run carries one, and that commit copies it onto the window's assistant
 *   messages (`commitWindow`), where a person reads it. The writer itself never touches the chat.
 * - Warming: the committed event's summary and key lines and the sections it changed are embedded into
 *   the shared vector cache. A failure keeps the records.
 * - Store: a run reads and writes through the `memory` it is given, the live records or a rebuild's staged
 *   set (`createStructuredWriter`). So a rebuild's writer stands on what the run wrote, and a chat's run is
 *   defended at the writer's one live write (`commitWindow`).
 * - A historical write (`historical`, a backfill) records a window that lies before records that already
 *   exist, so it must leave current state alone: it merges into no later event, rewrites no scene, moves
 *   no thread, and patches no page in `frozenPages`. It still makes new pages, which later windows patch.
 */

type WriterArg = Parameters<StructuredMemoryWriter>[0];

/** What a run reads and writes of a chat's memory: its live records or a rebuild's staged set. */
export type WriterMemory = Pick<ResourceStore["memory"], "readContents" | "readRecord" | "write">;

type WriterStore = { memory: WriterMemory } & Pick<ResourceStore, "chatMeta">;

/** A run whose snapshot is stored: what the call and the later commits work from. */
type OpenedRun = { run: MemoryRun; formated: OpenAIChat[]; revision: string };

/** What every admission of one run's answer works from. */
type Recording = {
    analysis: MemoryAnalysisResult;
    /** What bounding the answer cut. */
    warnings: readonly Warning[];
    seeds: readonly AliasSeed[];
    /** The group member who spoke the window. */
    speaker: { name: string; nickname?: string } | undefined;
    /** The threads the draft moves. */
    named: ReadonlySet<string>;
    /** A new page's id by its name key, the same on every attempt, because the patches name it. */
    newPageId(key: string): string;
};

/** A write's tries while the memory revision keeps moving. */
const WRITE_ATTEMPTS = 3;
/**
 * What a stored snapshot leaves of a record for the rest of its run. The analysis, the patches and what
 * their call sent, the receipt, and the error are bounded by `STRUCTURED_MEMORY_LIMITS`: about 3.5 MiB
 * with every text at its longest in escapes.
 */
const RUN_RECORD_MARGIN_BYTES = 4 * 1024 * 1024;

/**
 * A request's settings as the writer takes them: temperature 0 and without the preset's structured
 * output, because `jsonSchemaEnabled` and `extractJson` shape the chat's replies, not the writer's
 * fixed format, and would keep its JSON from arriving. All three are root fields of the prompt preset
 * that a request reads from its db.
 */
export function writerRequestDb<T extends object>(db: T) {
    return { ...db, temperature: 0, jsonSchemaEnabled: false, extractJson: "" };
}

/**
 * A writer task's host dependencies: every request gets its own copy of `writerRequestDb`, so
 * `MemoryHost` stays the same for both task kinds.
 */
export function writerHostDeps(deps: MemoryTaskHostDeps): MemoryTaskHostDeps {
    return {
        ...deps,
        llm: {
            runInJob: (spec) =>
                deps.llm.runInJob({ ...spec, loaded: { ...spec.loaded, db: writerRequestDb(spec.loaded.db) } }),
        },
    };
}

/**
 * How many events a chat's stored HypaV3 summaries would adopt while the chat waits for a person's
 * choice, 0 for a chat that does not wait. It waits with no page, event, or thread, a run not counting,
 * as in the adopt route, while it has not declined, and only when `adoptedEvents` makes an event of the
 * summaries, so a sealed value, or summaries with no text, hold nothing, and this and the route cannot
 * drift apart. `hypaV3Data` reads the stored value, and only a chat with no records and no decline
 * reaches it, so a chat with records costs nothing.
 */
export function adoptionHold(contents: MemoryContents, hypaV3Data: () => unknown): number {
    const { pages, events, threads, adoptionDeclined } = contents;
    if (adoptionDeclined || [pages, events, threads].some(({ length }) => length > 0)) {
        return 0;
    }
    return adoptedEvents({ data: hypaV3Data(), messages: [], hashOf: () => "", newId: () => "" }).length;
}

/** `adoptionHold` of the chat `contents` lists, from its stored metadata. */
export function chatAdoptionHold(
    store: Pick<ResourceStore, "chatMeta">,
    chaId: string,
    chatId: string,
    contents: MemoryContents,
): number {
    return adoptionHold(contents, () => store.chatMeta(chaId, chatId)?.data.hypaV3Data);
}

const writerSettings = (host: MemoryHost) =>
    normalizeStructuredMemorySettings(selectedHypaV3Preset(host.db)?.settings?.structured);

/**
 * How a run highlights what it writes: the chat's mode, else the preset's. A rebuild or a backfill writes
 * a chat's past over again, so it asks nobody to look at each change.
 */
function highlightRule({ host, input, scope }: WriterArg): HighlightRule {
    const { highlightMode, highlightKinds, highlightChangeGrade } = writerSettings(host);
    return {
        mode: input.rebuild ? "none" : (structuredMemoryHighlightOverride(scopeChat(scope)) ?? highlightMode),
        kinds: highlightKinds,
        changeGrade: highlightChangeGrade,
    };
}

const sameWindow = (a: readonly MemoryAnchoredSource[], b: readonly MemoryAnchoredSource[]) =>
    a.length === b.length && a.every(({ messageId, hash }, i) => messageId === b[i].messageId && hash === b[i].hash);

/** A stored input as messages; null for one a run could not have written. */
function parsedInput(text: string): OpenAIChat[] | null {
    try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? (parsed as OpenAIChat[]) : null;
    } catch {
        return null;
    }
}

/** A message's speaker label: the persona, the group member who said it when known, else the chat's owner. */
function speakerLabels(arg: WriterArg, ownerName: string) {
    return (message: Message): string => {
        if (message.role === "user") {
            return arg.host.userName();
        }
        const member = message.saying
            ? arg.scope.db.characters.find((entry) => entry?.chaId === message.saying)
            : undefined;
        return member?.name || ownerName;
    };
}

/** Every page `contents` lists, whole: the store has no bulk read. */
function readPages(store: Pick<WriterStore, "memory">, arg: WriterArg, contents: MemoryContents): MemoryPage[] {
    const { chaId, chatId } = arg.input.chatRef;
    return contents.pages.flatMap(({ id }) => store.memory.readRecord(chaId, chatId, "pages", id)?.data ?? []);
}

/** The language a run writes in: the chat's override, its owner's, the preset's, then the app's. */
function writerLanguage({ scope, host, input }: WriterArg): string {
    const owner = scope.db.characters.find((entry) => entry?.chaId === input.chatRef.chaId);
    return structuredMemoryWriterLanguage(scopeChat(scope), owner, writerSettings(host).language, host.db.language);
}

/** The prompt for `arg.window`, from the records as `contents` lists them. */
function buildPrompt(store: Pick<WriterStore, "memory">, arg: WriterArg, contents: MemoryContents): OpenAIChat[] {
    const { scope, host, input, window } = arg;
    const { chaId, chatId } = input.chatRef;
    const chat = scopeChat(scope);
    const owner = scope.db.characters.find((entry) => entry?.chaId === chaId);
    const pages = readPages(store, arg, contents);
    const threads: MemoryThread[] = [];
    for (const { id } of contents.threads
        .filter(({ state }) => !memoryThreadEnded(state))
        .slice(-LIMITS.promptThreads)) {
        const thread = store.memory.readRecord(chaId, chatId, "threads", id)?.data;
        if (thread) {
            threads.push(thread);
        }
    }
    const slots = analysisSlots({
        language: writerLanguage(arg),
        cast: castSlice(pages, window.messages),
        scene: pages.find(({ type }) => type === "scene") ?? null,
        threads,
        previousTitle: contents.events.findLast(({ status }) => status === "active")?.title,
        messages: chat?.message ?? [],
        window,
        speaker: speakerLabels(arg, owner?.name ?? ""),
    });
    return assembleAnalysisPrompt(host, writerSettings(host).instructions, slots);
}

/**
 * The input to send again, from the newest run that did not record, when it is still this run's. An input
 * must hold every line the scene now lists as taken back: compared with its parsed text, so that JSON's
 * escapes cannot hide one. Its scene slot quoting the same text as the scene does not count.
 */
function replayedInput(
    store: Pick<WriterStore, "memory">,
    arg: WriterArg,
    contents: MemoryContents,
): { text: string; formated: OpenAIChat[] } | null {
    const { chaId, chatId } = arg.input.chatRef;
    const newest = contents.runs.findLast(({ result }) => result !== "recorded");
    const run = newest && store.memory.readRecord(chaId, chatId, "runs", newest.id)?.data;
    if (
        !run?.input ||
        run.settingsFingerprint !== arg.input.settingsFingerprint ||
        !sameWindow(run.window, arg.window.sources)
    ) {
        return null;
    }
    const formated = parsedInput(run.input);
    const sceneRow = contents.pages.find(({ type }) => type === "scene");
    const scene = sceneRow ? (store.memory.readRecord(chaId, chatId, "pages", sceneRow.id)?.data ?? null) : null;
    const lists = (line: string) => formated?.some(({ content }) => content.includes(line));
    return formated && sceneTakenBackLines(scene).every(lists) ? { text: run.input, formated } : null;
}

/** `run` as a failure, with the receipt a later reader shows; `reason` is a stored code. */
function failedRun(run: MemoryRun, reason: string, error: string): MemoryRun {
    const receipt: MemoryReceipt = {
        state: "failed",
        reason,
        runId: run.id,
        pages: [],
        refused: [],
        unverified: [],
        warnings: [],
        model: run.model,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
    };
    return { ...run, result: "failed", error, receipt };
}

/**
 * A writer's one write for `window`, read under `ceiling`, once its caller's fence has passed
 * (synchronous). `writeReceipt` applies a chat group on the caller's own write path.
 *
 * The source generation moves only on a whole-chat replace or a delete, so an edit, a removal, a
 * disabled flag, or a continue since the window was read shows only in the chat as stored now, which is
 * checked here under the ceiling the window was computed with. A continue takes its message's lock
 * before it changes the text, so a window holding a message a generation job owns is refused too: its
 * hash still matches, and its receipt could not land. A chat that waits for its adoption choice is
 * refused here as well: `openRun` looked before it awaited, and a metadata write can land after that. So
 * is a write of a chat that holds a rebuild's run, whichever job holds it: a job admitted under another
 * algorithm can reach this after a switch back, and the swap would lose what it wrote. `rebuild.status`
 * reads the chat's run, and the rebuild's own store answers that it has none.
 *
 * A run in `changes` with a receipt puts that receipt on the window's assistant messages, each with
 * its other generation info as stored. A receipt moves the chat's revision and no source hash, so it
 * keeps every window valid. A receipt that conflicts all the same is logged and left to the run, which
 * keeps it: the memory commit stands and the window is neither failed nor run again.
 */
export function commitWindow(
    store: Pick<ResourceStore, "readChatSource" | "messagesLocked"> & {
        memory: Pick<WriterMemory, "readContents" | "write"> & {
            rebuild: Pick<ResourceStore["memory"]["rebuild"], "status">;
        };
    },
    arg: {
        input: WriterArg["input"];
        window: WriterWindow;
        ceiling: WriterCeiling;
        baseRevision: string;
        changes: MemoryChanges;
        writeReceipt(group: ChatGroup): void;
    },
): StructuredMemoryCommit {
    const { input, window, ceiling, changes } = arg;
    const { chaId, chatId } = input.chatRef;
    const chat = store.readChatSource(chaId, chatId);
    const stored = chat.data as Chat | null;
    const sources = window.sources.map(({ messageId }) => messageId);
    if (
        !stored ||
        chat.revision === null ||
        !windowStillConfirmed(window, stored.message, ceiling.id, { inclusive: ceiling.inclusive }) ||
        store.messagesLocked(chaId, chatId, sources) ||
        store.memory.rebuild.status(chaId, chatId)
    ) {
        return { outcome: "refused", reason: "windowChanged" };
    }
    const contents = store.memory.readContents(chaId, chatId);
    if (contents && adoptionHold(contents, () => stored.hypaV3Data) > 0) {
        return { outcome: "refused", reason: "windowChanged" };
    }
    let revision: string;
    try {
        revision = store.memory.write(chaId, chatId, { epoch: input.epoch, baseRevision: arg.baseRevision }, changes);
    } catch (error) {
        if (error instanceof ResourceConflictError) {
            return { outcome: "refused", reason: "revisionConflict" };
        }
        throw error;
    }
    const receipt = changes.runs?.findLast((run) => run.receipt)?.receipt;
    if (receipt) {
        const inWindow = new Set(sources);
        const ops: ChatOp[] = stored.message
            .filter(({ role, chatId: id }) => role === "char" && id !== undefined && inWindow.has(id))
            .map((message) => ({
                op: "patchMessage",
                id: message.chatId!,
                set: { generationInfo: { ...message.generationInfo, memory: receipt } },
            }));
        try {
            arg.writeReceipt({ characterId: chaId, chatId, baseRevision: chat.revision, ops });
        } catch (error) {
            if (!(error instanceof ResourceBatchConflictError || error instanceof JobWriteConflictError)) {
                throw error;
            }
            console.warn("[memory] a receipt could not be written to the chat; its run keeps it");
        }
    }
    return { outcome: "committed", revision };
}

/**
 * Starts a run: from the records as stored, closes what an earlier run left `pending` and commits this
 * one with its snapshot, in one write. Answers the run, or how the writer ended without a call. Nothing
 * awaited here costs a model call, so a moved revision just starts over.
 */
async function openRun(store: WriterStore, arg: WriterArg): Promise<OpenedRun | StructuredMemoryWriterResult> {
    const { input, tokenizer, commit } = arg;
    const { chaId, chatId } = input.chatRef;
    const memoryModel = resolveJobRequestModel(arg.scope.request.db, "memory");
    const id = randomUUID();
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const contents = store.memory.readContents(chaId, chatId);
        if (!contents) {
            return { outcome: "skipped", reason: "chatGone" };
        }
        if (chatAdoptionHold(store, chaId, chatId, contents) > 0) {
            return { outcome: "skipped", reason: "awaitingAdoption" };
        }
        if (!arg.manual && writerPaused(contents.runs)) {
            return { outcome: "skipped", reason: "writerPaused" };
        }
        const interrupted: MemoryRun[] = [];
        for (const row of contents.runs.filter(({ result }) => result === "pending")) {
            const leftover = store.memory.readRecord(chaId, chatId, "runs", row.id)?.data;
            if (leftover) {
                interrupted.push({ ...leftover, result: "skipped", reason: "interrupted" });
            }
        }
        const replayed = replayedInput(store, arg, contents);
        const formated = replayed?.formated ?? buildPrompt(store, arg, contents);
        const run: MemoryRun = {
            id,
            window: arg.window.sources,
            model: memoryModel.kind === "resolved" ? memoryModel.aiModel : "",
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 0,
            result: "pending",
            input: replayed?.text ?? JSON.stringify(formated),
            settingsFingerprint: input.settingsFingerprint,
            language: writerLanguage(arg),
        };
        const bytes = Buffer.byteLength(JSON.stringify(run), "utf8");
        if (bytes > MAX_READ_RESPONSE_BYTES - RUN_RECORD_MARGIN_BYTES) {
            const error = `The prompt of ${bytes} bytes is too large to store, so it was not sent`;
            const failed = failedRun({ ...run, input: undefined }, "inputTooLarge", error);
            const answer = commit(contents.revision, { runs: [...interrupted, failed] });
            if (answer.outcome === "committed") {
                return { outcome: "failed", error };
            }
            if (answer.reason !== "revisionConflict") {
                return { outcome: "skipped", reason: answer.reason };
            }
            continue;
        }
        for (const message of formated) {
            run.inputTokens += await tokenizer.tokenizeChat(message);
        }
        const answer = commit(contents.revision, { runs: [...interrupted, run] });
        if (answer.outcome === "committed") {
            return { run, formated, revision: answer.revision };
        }
        if (answer.reason !== "revisionConflict") {
            return { outcome: "skipped", reason: answer.reason };
        }
    }
    return { outcome: "skipped", reason: "revisionConflict" };
}

/**
 * Commits what `changes` makes of the records as stored: on `revision`, the one the last commit
 * returned, then after a refusal for the revision on a fresh read, at most `WRITE_ATTEMPTS` times.
 */
function commitFresh(
    store: Pick<WriterStore, "memory">,
    arg: WriterArg,
    revision: string,
    changes: (contents: MemoryContents) => MemoryChanges,
): { outcome: "committed" } | { outcome: "skipped"; reason: string } {
    const { chaId, chatId } = arg.input.chatRef;
    let base: string | null = revision;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const contents = store.memory.readContents(chaId, chatId);
        if (!contents) {
            return { outcome: "skipped", reason: "chatGone" };
        }
        const answer = arg.commit(base ?? contents.revision, changes(contents));
        if (answer.outcome === "committed") {
            return { outcome: "committed" };
        }
        if (answer.reason !== "revisionConflict") {
            return { outcome: "skipped", reason: answer.reason };
        }
        base = null;
    }
    return { outcome: "skipped", reason: "revisionConflict" };
}

/**
 * What admission reads of the records `contents` lists: every page id, the threads `named`, the last event.
 * A historical write has none: the window lies before it, and a merge would append older sources after
 * newer ones, which reconciliation reads as moved.
 */
function admissionState(
    store: Pick<WriterStore, "memory">,
    arg: WriterArg,
    contents: MemoryContents,
    named: ReadonlySet<string>,
) {
    const { chaId, chatId } = arg.input.chatRef;
    const threads = new Map<string, MemoryThread>();
    for (const id of named) {
        const thread = store.memory.readRecord(chaId, chatId, "threads", id)?.data;
        if (thread) {
            threads.set(id, thread);
        }
    }
    const last = arg.historical ? undefined : contents.events.at(-1);
    return {
        pages: new Set(contents.pages.map(({ id }) => id)),
        threads,
        lastEvent: (last && store.memory.readRecord(chaId, chatId, "events", last.id)?.data) ?? null,
    };
}

/** The alias seeds of the chat: the lore of its owner, of the chat, and of its modules, and a group's members. */
function chatSeeds({ scope, input }: WriterArg): AliasSeed[] {
    const { characters } = scope.db;
    const owner = characters.find((entry) => entry?.chaId === input.chatRef.chaId);
    const members =
        owner?.type === "group"
            ? owner.characters.flatMap((id) => characters.find((entry) => entry?.chaId === id) ?? [])
            : [];
    const lore = [owner?.globalLore, scopeChat(scope)?.localLore, jobModuleLorebooks(scope)];
    return aliasSeeds(
        lore.flatMap((list) => (Array.isArray(list) ? list : [])),
        members,
    );
}

/** The group member who spoke every reply of the window; none in a solo chat. */
function groupSpeaker({ scope, input, window }: WriterArg): Recording["speaker"] {
    const { characters } = scope.db;
    if (characters.find((entry) => entry?.chaId === input.chatRef.chaId)?.type !== "group") {
        return undefined;
    }
    const speaker = windowSpeaker(window.messages);
    const member = speaker === undefined ? undefined : characters.find((entry) => entry?.chaId === speaker);
    const name = storedText(member?.name);
    return name.trim() === "" ? undefined : { name, nickname: storedText(member?.nickname) };
}

/**
 * What `recording`'s answer comes to against the records as `contents` lists them, `pages` being the
 * chat's pages, whole. Admission tells a repeat, and it needs the plan to read the participants. A repeat
 * makes no page, so it is planned and admitted again: a thread it keeps must not name a page that never
 * came.
 */
function admitRecording(
    store: Pick<WriterStore, "memory">,
    arg: WriterArg,
    runId: string,
    recording: Recording,
    contents: MemoryContents,
    pages: readonly MemoryPage[],
): { plan: PagePlan; admission: Admission } {
    const { analysis, warnings, seeds, speaker, named, newPageId } = recording;
    const state = admissionState(store, arg, contents, named);
    const frozen = new Set(arg.historical?.frozenPages);
    const planned = (repeated: boolean) =>
        withoutFrozenTargets(
            planPages({ pages, candidates: analysis.pageCandidates, seeds, speaker, repeated, newPageId }),
            frozen,
        );
    const admitted = ({ plan, warnings: dropped }: ReturnType<typeof planned>) =>
        admitAnalysis({
            draft: analysis.event,
            warnings: [...warnings, ...dropped],
            window: arg.window,
            runId,
            ...state,
            created: plan.names,
            scene: analysis.scene,
            speakerId: plan.speakerId,
            messages: scopeChat(arg.scope)?.message ?? [],
            newId: randomUUID,
        });
    const first = planned(false);
    const admission = admitted(first);
    if (!admission.repeated) {
        return { plan: first.plan, admission };
    }
    const repeat = planned(true);
    return { plan: repeat.plan, admission: admitted(repeat) };
}

/**
 * Embeds what a commit wrote into the vector cache: the event's texts, unless the preset gives the
 * events lane nothing, and `sectionTexts`, unless it gives the pages lane nothing. Answers the text of a
 * failure, which keeps the records; an ended task or a host failure is thrown.
 */
async function warmRecords(host: MemoryHost, event: MemoryEventWrite, sectionTexts: readonly string[]) {
    const { laneTargets } = writerSettings(host);
    const texts = [
        ...(laneTargets.events === 0 ? [] : eventVectorTexts(event)),
        ...(laneTargets.pages === 0 ? [] : sectionTexts),
    ];
    if (texts.length === 0) {
        return undefined;
    }
    try {
        await new HypaProcesser(host.embeddings, host.db.hypaModel).addText([...new Set(texts)]);
        host.fence();
        return undefined;
    } catch (error) {
        if (host.signal.aborted || error instanceof MemoryHostFailure) {
            throw error;
        }
        console.warn("[memory] warming the new records failed");
        return host.redact(error instanceof Error ? error.message : String(error));
    }
}

/** What a historical write takes of a model's answer: nothing that moves a thread or the scene. */
function historicalAnalysis(analysis: MemoryAnalysisResult): MemoryAnalysisResult {
    return {
        ...analysis,
        event: { ...analysis.event, openThreads: { add: [], close: [], transitions: [] } },
        scene: null,
    };
}

/** The production writer, over the records `store` holds. `now` times the runs. */
export function createStructuredWriter(
    store: WriterStore,
    options: { now?: () => number } = {},
): StructuredMemoryWriter {
    const now = options.now ?? Date.now;
    return async (arg) => {
        const { host, input, tokenizer, window } = arg;
        const { chaId, chatId } = input.chatRef;
        const opened = await openRun(store, arg);
        if ("outcome" in opened) {
            return opened;
        }
        const startedAt = now();
        let run = opened.run;
        const fail = (reason: string, text: string): StructuredMemoryWriterResult => {
            const error = clampText(host.redact(text), LIMITS.runErrorChars);
            const failed = failedRun({ ...run, durationMs: now() - startedAt }, reason, error);
            const answer = commitFresh(store, arg, opened.revision, () => ({ runs: [failed] }));
            return answer.outcome === "committed" ? { outcome: "failed", error } : answer;
        };
        /** One model call: its text, or why it gave none, as a stored code and the unredacted error. */
        const call = async (formated: OpenAIChat[]): Promise<{ text: string } | { reason: string; error: string }> => {
            try {
                const response = await host.request(formated);
                run = { ...run, model: response.model ?? run.model };
                if (response.type === "fail") {
                    return { reason: "requestFailed", error: response.result };
                }
                if (response.type !== "success") {
                    return { reason: "unexpectedResponse", error: `Unexpected response type: ${response.type}` };
                }
                if (response.result.trim() === "") {
                    return { reason: "emptyResponse", error: "The model's answer is empty" };
                }
                run = { ...run, outputTokens: run.outputTokens + (await host.tokenize(response.result)) };
                return { text: response.result };
            } catch (error) {
                if (error instanceof MemoryHostFailure) {
                    fail("hostFailure", error.message);
                }
                throw error;
            }
        };
        /** A call the run needs: its text, or how the run ended. `failure` replaces a failed call's own code. */
        const ask = async (
            formated: OpenAIChat[],
            failure?: string,
        ): Promise<{ text: string } | { ended: StructuredMemoryWriterResult }> => {
            const answer = await call(formated);
            return "reason" in answer ? { ended: fail(failure ?? answer.reason, answer.error) } : answer;
        };

        const answered = await ask(opened.formated);
        if ("ended" in answered) {
            return answered.ended;
        }
        const parsed = parseAnalysis(answered.text);
        if (!parsed.ok) {
            return fail(parsed.reason, parsed.error);
        }
        const { warnings } = parsed;
        run = { ...run, analysis: parsed.analysis };
        const analysis = arg.historical ? historicalAnalysis(parsed.analysis) : parsed.analysis;

        const newPageIds = new Map<string, string>();
        const recording: Recording = {
            analysis,
            warnings,
            seeds: chatSeeds(arg),
            speaker: groupSpeaker(arg),
            named: new Set([
                ...analysis.event.openThreads.close,
                ...analysis.event.openThreads.transitions.map(({ threadId }) => threadId),
            ]),
            newPageId(key) {
                const id = newPageIds.get(key) ?? randomUUID();
                newPageIds.set(key, id);
                return id;
            },
        };
        const sceneId = randomUUID();
        const contents = store.memory.readContents(chaId, chatId);
        if (!contents) {
            return { outcome: "skipped", reason: "chatGone" };
        }
        const first = admitRecording(store, arg, run.id, recording, contents, readPages(store, arg, contents));
        const shown = showTargets(first.plan.targets);
        let patchWarnings: Warning[] = [];
        if (shown.rows.length > 0) {
            const language = writerLanguage(arg);
            const slots = patchSlots({ language, rows: shown.rows, event: first.admission.event });
            const formated = assemblePatchPrompt(host, writerSettings(host).instructions, slots);
            run = { ...run, patchInput: JSON.stringify(formated) };
            for (const message of formated) {
                run = { ...run, inputTokens: run.inputTokens + (await tokenizer.tokenizeChat(message)) };
            }
            const patchAnswer = await ask(formated, "patchFailed");
            if ("ended" in patchAnswer) {
                return patchAnswer.ended;
            }
            const patched = parsePatches(patchAnswer.text);
            if (!patched.ok) {
                return fail("patchFailed", patched.error);
            }
            run = { ...run, patches: patched.patches };
            patchWarnings = patched.warnings;
        }

        /** What one attempt at the commit makes of the records `fresh` lists, with nothing written yet. */
        const attempt = (fresh: MemoryContents, compactions: readonly Compaction[]) => {
            const pages = readPages(store, arg, fresh);
            const { plan, admission } = admitRecording(store, arg, run.id, recording, fresh, pages);
            const written = commitPages({
                pages,
                plan,
                admission,
                patches: run.patches ?? [],
                seen: shown.seen,
                compactions,
                sceneId,
                stamp: {
                    eventId: admission.event.id,
                    sources: window.sources,
                    at: now(),
                    newId: randomUUID,
                    highlight: highlightRule(arg),
                    grade: admission.event.grade,
                },
            });
            return { plan, admission, written };
        };

        const compactions: Compaction[] = [];
        const compactionWarnings: Warning[] = [];
        if (run.patches?.length) {
            const fresh = store.memory.readContents(chaId, chatId);
            if (!fresh) {
                return { outcome: "skipped", reason: "chatGone" };
            }
            const { written } = attempt(fresh, []);
            const { targets, warnings: skipped } = compactionTargets(written.pages, written.receipts);
            compactionWarnings.push(...skipped);
            const language = writerLanguage(arg);
            for (const target of targets) {
                const slots = compactSlots({ language, target });
                const formated = assembleCompactPrompt(host, writerSettings(host).instructions, slots);
                for (const message of formated) {
                    run = { ...run, inputTokens: run.inputTokens + (await tokenizer.tokenizeChat(message)) };
                }
                const compactAnswer = await call(formated);
                if ("reason" in compactAnswer) {
                    compactionWarnings.push(sectionWarning("compactionFailed", target.page, target.heading));
                    continue;
                }
                const read = readCompaction(target, compactAnswer.text);
                if (read.ok) {
                    compactions.push(read.compaction);
                } else {
                    compactionWarnings.push(read.warning);
                }
            }
        }

        const durationMs = now() - startedAt;
        let event: MemoryEventWrite | undefined;
        let sectionTexts: string[] = [];
        const answer = commitFresh(store, arg, opened.revision, (fresh) => {
            const { plan, admission, written } = attempt(fresh, compactions);
            ({ event } = admission);
            sectionTexts = written.vectorTexts;
            const receipt: MemoryReceipt = {
                state: "recorded",
                runId: run.id,
                eventId: admission.event.id,
                pages: written.receipts,
                refused: [...plan.refused, ...shown.refused],
                unverified: admission.unverified,
                warnings: [...admission.warnings, ...patchWarnings, ...compactionWarnings, ...written.warnings],
                model: run.model,
                inputTokens: run.inputTokens,
                outputTokens: run.outputTokens,
            };
            const recorded: MemoryRun = {
                ...run,
                result: "recorded",
                durationMs,
                eventId: admission.event.id,
                receipt,
            };
            return { events: [admission.event], threads: admission.threads, pages: written.pages, runs: [recorded] };
        });
        if (answer.outcome !== "committed") {
            return answer;
        }
        const warmingError = await warmRecords(host, event!, sectionTexts);
        return warmingError === undefined ? { outcome: "recorded" } : { outcome: "recorded", warmingError };
    };
}
