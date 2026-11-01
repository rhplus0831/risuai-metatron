import { randomUUID } from "node:crypto";
import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import type { ChatGroup, ChatOp } from "../../../../../shared/chats.ts";
import type { Chat, Message } from "../../../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import type { OpenAIChat } from "../../../../../shared/openai.ts";
import { MAX_READ_RESPONSE_BYTES } from "../../../../../shared/resources.ts";
import {
    type MemoryAnchoredSource,
    type MemoryReceipt,
    type MemoryRun,
    type MemoryThread,
    memoryThreadEnded,
    normalizeStructuredMemorySettings,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    structuredMemoryLanguageOverride,
} from "../../../../../shared/structuredMemory.ts";
import type { MemoryChanges, MemoryContents, MemoryEventWrite } from "../../../data/memoryStore.ts";
import { ResourceBatchConflictError, ResourceConflictError, type ResourceStore } from "../../../data/resourceStore.ts";
import { JobWriteConflictError } from "../../../jobs/generationJobs.ts";
import { scopeChat } from "../../../jobs/jobScope.ts";
import { resolveJobRequestModel } from "../../../llm/request.ts";
import { HypaProcesser } from "../../embeddings.ts";
import type { MemoryHost } from "../host.ts";
import { MemoryHostFailure, type MemoryTaskHostDeps } from "../memoryTaskHost.ts";
import type { StructuredMemoryCommit, StructuredMemoryWriter, StructuredMemoryWriterResult } from "../memoryTasks.ts";
import { admitAnalysis, parseAnalysis } from "./analysis.ts";
import { analysisSlots, assembleAnalysisPrompt } from "./prompts.ts";
import { windowStillConfirmed, type WriterCeiling, type WriterWindow } from "./window.ts";

/**
 * The Structured Memory writer: one analysis call per window, and a `memory_runs` row that shows how it
 * went. The rows are the writer's whole state: a restart loses nothing, and pausing needs no table of
 * its own.
 *
 * - Interrupted runs: one task runs per chat, so a `pending` row found at a start is abandoned (a
 *   cancel, a checkpoint load, maintenance, a restart, a deadline). The write that opens the new run
 *   closes it `skipped` (`interrupted`). It proves nothing about the model, so it is no failure.
 * - Pause: `consecutiveFailures` failed rows at the end of the runs, with skipped rows neither counting
 *   nor resetting and a recorded one resetting, stop an automatic run with no call and no row
 *   (`writerPaused`). A manual start runs past it.
 * - Replay: the newest row that did not record is the only one read. Its input is sent again, exactly,
 *   when its window (by message id and hash) and its settings are still this run's; otherwise, so that
 *   fixed instructions take effect and a regrouped window rebuilds, the prompt is built anew.
 * - Snapshot: no call is made before its exact input is stored in a `pending` row. An input too large
 *   for a record fails the run with no call.
 * - Failure: a provider failure, an empty or unexpected answer, or an answer `parseAnalysis` refuses
 *   ends the run `failed`, with a redacted error and no event. A `MemoryHostFailure` does too, and goes
 *   on to end the task. Any other throw, which is an ended task or an abort, leaves the row `pending`
 *   for the next run to close, and `commit`'s own check throws once the task ended: that is how output
 *   after the deadline is discarded.
 * - Success: one commit writes the event, its threads, and the recorded run. A refusal for the revision
 *   admits the answer again against fresh records, with no call.
 * - Receipt: a recorded or failed run carries one, and that commit copies it onto the window's assistant
 *   messages (`commitWindow`), where a person reads it. The writer itself never touches the chat.
 * - Warming: the committed event's summary and key lines are embedded into the shared vector cache. A
 *   failure keeps the event.
 */

type WriterArg = Parameters<StructuredMemoryWriter>[0];

/** A run whose snapshot is stored: what the call and the later commits work from. */
type OpenedRun = { run: MemoryRun; formated: OpenAIChat[]; revision: string };

/** A write's tries while the memory revision keeps moving. */
const WRITE_ATTEMPTS = 3;
/**
 * What a stored snapshot leaves of a record for the rest of its run. The analysis, the receipt, and the
 * error are bounded by `STRUCTURED_MEMORY_LIMITS`: about 2 MiB with every text at its longest in escapes.
 */
const RUN_RECORD_MARGIN_BYTES = 3 * 1024 * 1024;

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

const writerSettings = (host: MemoryHost) =>
    normalizeStructuredMemorySettings(selectedHypaV3Preset(host.db)?.settings?.structured);

/** How many runs at the end of `runs` failed, recorded ones ending the count; others say nothing. */
function trailingFailures(runs: MemoryContents["runs"]): number {
    let failures = 0;
    for (let index = runs.length - 1; index >= 0 && runs[index].result !== "recorded"; index--) {
        if (runs[index].result === "failed") {
            failures++;
        }
    }
    return failures;
}

/** Whether automatic recording is paused: `consecutiveFailures` failed runs at the end of `runs`. */
export function writerPaused(runs: MemoryContents["runs"]): boolean {
    return trailingFailures(runs) >= LIMITS.consecutiveFailures;
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

/** The prompt for `arg.window`, from the records as `contents` lists them. */
function buildPrompt(store: Pick<ResourceStore, "memory">, arg: WriterArg, contents: MemoryContents): OpenAIChat[] {
    const { scope, host, input, window } = arg;
    const { chaId, chatId } = input.chatRef;
    const chat = scopeChat(scope);
    const owner = scope.db.characters.find((entry) => entry?.chaId === chaId);
    const settings = writerSettings(host);
    const scenePage = contents.pages.find(({ type }) => type === "scene");
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
        language:
            structuredMemoryLanguageOverride(chat) ??
            structuredMemoryLanguageOverride(owner) ??
            (settings.language || host.db.language),
        pages: contents.pages,
        scene: scenePage ? (store.memory.readRecord(chaId, chatId, "pages", scenePage.id)?.data ?? null) : null,
        threads,
        previousTitle: contents.events.findLast(({ status }) => status === "active")?.title,
        messages: chat?.message ?? [],
        window,
        speaker: speakerLabels(arg, owner?.name ?? ""),
    });
    return assembleAnalysisPrompt(host, settings.instructions, slots);
}

/** The input to send again, from the newest run that did not record, when it is still this run's. */
function replayedInput(
    store: Pick<ResourceStore, "memory">,
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
    return formated && { text: run.input, formated };
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
 * hash still matches, and its receipt could not land.
 *
 * A run in `changes` with a receipt puts that receipt on the window's assistant messages, each with
 * its other generation info as stored. A receipt moves the chat's revision and no source hash, so it
 * keeps every window valid. A receipt that conflicts all the same is logged and left to the run, which
 * keeps it: the memory commit stands and the window is neither failed nor run again.
 */
export function commitWindow(
    store: Pick<ResourceStore, "memory" | "readChatSource" | "messagesLocked">,
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
        store.messagesLocked(chaId, chatId, sources)
    ) {
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
async function openRun(
    store: Pick<ResourceStore, "memory">,
    arg: WriterArg,
): Promise<OpenedRun | StructuredMemoryWriterResult> {
    const { input, tokenizer, commit } = arg;
    const { chaId, chatId } = input.chatRef;
    const memoryModel = resolveJobRequestModel(arg.scope.request.db, "memory");
    const id = randomUUID();
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const contents = store.memory.readContents(chaId, chatId);
        if (!contents) {
            return { outcome: "skipped", reason: "chatGone" };
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
    store: Pick<ResourceStore, "memory">,
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

/** What admission reads of the records `contents` lists: every page id, the threads `named`, the last event. */
function admissionState(
    store: Pick<ResourceStore, "memory">,
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
    const last = contents.events.at(-1);
    return {
        pages: new Set(contents.pages.map(({ id }) => id)),
        threads,
        lastEvent: (last && store.memory.readRecord(chaId, chatId, "events", last.id)?.data) ?? null,
    };
}

/**
 * Embeds `event`'s summary and key lines into the vector cache, unless the preset gives the events lane
 * nothing. Answers the text of a failure, which keeps the event; an ended task or a host failure is
 * thrown.
 */
async function warmEvent(host: MemoryHost, event: MemoryEventWrite) {
    if (writerSettings(host).laneTargets.events === 0) {
        return undefined;
    }
    const texts = [event.summary, ...event.keyLines.map(({ text }) => text)].map((text) => text.trim());
    try {
        await new HypaProcesser(host.embeddings, host.db.hypaModel).addText([...new Set(texts)].filter(Boolean));
        host.fence();
        return undefined;
    } catch (error) {
        if (host.signal.aborted || error instanceof MemoryHostFailure) {
            throw error;
        }
        console.warn("[memory] warming the new event failed");
        return host.redact(error instanceof Error ? error.message : String(error));
    }
}

/** The production writer. `now` times the runs. */
export function createStructuredWriter(
    store: Pick<ResourceStore, "memory">,
    options: { now?: () => number } = {},
): StructuredMemoryWriter {
    const now = options.now ?? Date.now;
    return async (arg) => {
        const { host, window } = arg;
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

        let parsed: ReturnType<typeof parseAnalysis>;
        try {
            const response = await host.request(opened.formated);
            run = { ...run, model: response.model ?? run.model };
            if (response.type === "fail") {
                return fail("requestFailed", response.result);
            }
            if (response.type !== "success") {
                return fail("unexpectedResponse", `Unexpected response type: ${response.type}`);
            }
            if (response.result.trim() === "") {
                return fail("emptyResponse", "The model's answer is empty");
            }
            run = { ...run, outputTokens: await host.tokenize(response.result) };
            parsed = parseAnalysis(response.result);
        } catch (error) {
            if (error instanceof MemoryHostFailure) {
                fail("hostFailure", error.message);
            }
            throw error;
        }
        if (!parsed.ok) {
            return fail(parsed.reason, parsed.error);
        }

        const { analysis, warnings } = parsed;
        const durationMs = now() - startedAt;
        const named = new Set([
            ...analysis.event.openThreads.close,
            ...analysis.event.openThreads.transitions.map(({ threadId }) => threadId),
        ]);
        let event: MemoryEventWrite | undefined;
        const answer = commitFresh(store, arg, opened.revision, (contents) => {
            const admission = admitAnalysis({
                draft: analysis.event,
                warnings,
                window,
                runId: run.id,
                ...admissionState(store, arg, contents, named),
                messages: scopeChat(arg.scope)?.message ?? [],
                newId: randomUUID,
            });
            ({ event } = admission);
            const receipt: MemoryReceipt = {
                state: "recorded",
                runId: run.id,
                eventId: admission.event.id,
                pages: [],
                refused: [],
                unverified: admission.unverified,
                warnings: admission.warnings,
                model: run.model,
                inputTokens: run.inputTokens,
                outputTokens: run.outputTokens,
            };
            const recorded: MemoryRun = {
                ...run,
                result: "recorded",
                durationMs,
                analysis,
                eventId: admission.event.id,
                receipt,
            };
            return { events: [admission.event], threads: admission.threads, runs: [recorded] };
        });
        if (answer.outcome !== "committed") {
            return answer;
        }
        const warmingError = await warmEvent(host, event!);
        return warmingError === undefined ? { outcome: "recorded" } : { outcome: "recorded", warmingError };
    };
}
