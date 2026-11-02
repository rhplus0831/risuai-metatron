import { selectedHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import type { MemoryBlockingReason, MemoryTaskBase, StructuredMemoryTaskInput } from "../../../../../shared/jobs.ts";
import {
    type MemoryAnchoredSource,
    type MemoryRun,
    memoryScreenReason,
    normalizeStructuredMemorySettings,
    storedMemorySources,
    type StructuredMemorySlotWarnings,
    type StructuredMemoryTestResult,
} from "../../../../../shared/structuredMemory.ts";
import type { MemoryChanges } from "../../../data/memoryStore.ts";
import { GenerationRunnerError, markFailure, type RunningJob } from "../../../jobs/generationJobs.ts";
import { type JobScope, scopeChat } from "../../../jobs/jobScope.ts";
import type { GenerationRunnerDeps } from "../../../jobs/runSetup.ts";
import { jobMemoryBlockingReason, jobMemoryTaskBase } from "../../runner.ts";
import type { MemoryHost, MemoryTokenizer } from "../host.ts";
import { createMemoryTaskHost, MemoryHostFailure, type MemoryTaskHostDeps } from "../memoryTaskHost.ts";
import type { StructuredMemoryCommit, StructuredMemoryWriterResult } from "../memoryTasks.ts";
import { parseCustomFrame } from "./prompts.ts";
import { admitRecord } from "./recordJob.ts";
import {
    anchoredMessages,
    confirmedWindows,
    readRecordedMessages,
    windowOf,
    windowStillConfirmed,
    writerCadence,
    writerCeiling,
    type WriterWindow,
} from "./window.ts";
import { createStructuredWriter, writerHostDeps } from "./writer.ts";

/**
 * A test run of Structured Memory's writer as a command job (`memoryTest`): the chat's last window
 * again, with nothing saved, so a person tuning the prompts sees what the model answered and what the
 * validator made of it. The answer is the job's `done.result` (`StructuredMemoryTestResult`).
 *
 * - Admission is record now's (`admitRecord`): another algorithm, memory off, a local summarization
 *   model, and an adoption hold refuse it. Then a `memory` slot or a `request` trigger that needs the
 *   tab refuses it, naming which, because a tab callback's effects persist and a test keeps nothing. So
 *   does a queued or running memory task of the chat. It takes no writer lease: acquiring one cancels a
 *   running task, and the job holds the chat's slot, so nothing starts meanwhile; a rebuild's lock and a
 *   busy chat refuse the job before it runs.
 * - It runs on the detached task host (`createMemoryTaskHost`) under the writer's request policy, with
 *   the job's signal as its end and no tab: no tools, no inlays, no chat variable written, no callback.
 *   Not the job's own host, which reaches those.
 * - The window is the newest run's when every message it names is still an eligible message with the
 *   same hash (`windowStillConfirmed` through the window's own last message), rebuilt from the stored
 *   messages by id. A test saves nothing, so it needs no confirmation past the window itself: a run
 *   recorded through the newest reply, or a chat with no user message after it, still has that window.
 *   Else the first window the cadence would close before the chat's ceiling (`writerCeiling`), closed as
 *   a manual start closes it; with no ceiling, or no such window, there is nothing to test, which the
 *   result says. The input's `confirmedBefore` is the window's last message, which the writer does not
 *   read.
 * - The writer is the real one with `dryRun`: it builds its prompt anew, admits the answer as if the
 *   window were new, and makes no compaction call. Its `commit` here keeps the changes and answers
 *   committed at the base it was given, so no run, event, page, receipt, or chat metadata is written; the
 *   request history row is the call's own log. The result is read from the kept run: its analysis, its
 *   patches, its receipt's lists, and how it ended.
 * - The slot warnings of custom frames (the default slots a frame does not quote, the names it quotes
 *   that are no slot) are read from the frames again, for the result alone: a run never reports them.
 */

const TEST_REFUSALS: Readonly<Record<MemoryBlockingReason, string>> = {
    pluginModel: "The memory model is a plugin model, which needs this tab, so a test run cannot call it",
    requestTrigger:
        "A request trigger applies to this chat's requests, which needs this tab, so a test run cannot make them",
    gap: "A test run cannot start here",
};

const NO_SLOT_WARNINGS: StructuredMemorySlotWarnings = { unquoted: [], unknown: [] };

/** The host dependencies of a detached run from the job runner's. */
function detachedHostDeps(deps: GenerationRunnerDeps): MemoryTaskHostDeps {
    return {
        llm: deps.llm,
        embeddings: deps.embeddings,
        scriptWorkers: deps.scriptWorkers,
        tokens: deps.tokens,
        rootDir: deps.rootDir,
        ...(deps.cbsTimeLimits ? { cbsTimeLimits: deps.cbsTimeLimits } : {}),
        ...(deps.hypaV3SeparatorLimits ? { separatorLimits: deps.hypaV3SeparatorLimits } : {}),
    };
}

/** What each custom frame leaves out or misnames; nothing while the defaults are in use or for a frame a run refuses. */
function slotWarnings(host: MemoryHost): StructuredMemoryTestResult["slots"] {
    const settings = normalizeStructuredMemorySettings(selectedHypaV3Preset(host.db)?.settings?.structured);
    if (!settings.fineTuning) {
        return { analysis: NO_SLOT_WARNINGS, patch: NO_SLOT_WARNINGS };
    }
    const of = (text: string, call: "analysis" | "patch"): StructuredMemorySlotWarnings => {
        const frame = parseCustomFrame(host, text, call);
        return frame.ok ? { unquoted: frame.unquoted, unknown: frame.unknown } : NO_SLOT_WARNINGS;
    };
    return { analysis: of(settings.analysisPrompt, "analysis"), patch: of(settings.patchPrompt, "patch") };
}

/** The window to test: see the file's comment. */
async function testWindow(
    deps: GenerationRunnerDeps,
    scope: JobScope,
    base: MemoryTaskBase,
    tokenizer: MemoryTokenizer,
): Promise<WriterWindow | null> {
    const { store } = deps;
    const { chaId, chatId } = base.chatRef;
    const messages = scopeChat(scope)?.message ?? [];
    const newest = store.memory.readContents(chaId, chatId)?.runs.at(-1);
    const run = newest && store.memory.readRecord(chaId, chatId, "runs", newest.id)?.data;
    const sources = storedMemorySources(run?.window).filter(
        (source): source is MemoryAnchoredSource => source.hash !== null,
    );
    const last = sources.at(-1);
    const cadence = writerCadence(scope.db);
    if (last && windowStillConfirmed({ sources }, messages, last.messageId, { inclusive: true })) {
        const byId = new Map(anchoredMessages(messages).map((entry) => [entry.id, entry]));
        const entries = sources.map(({ messageId }) => byId.get(messageId)!);
        // A reply the screening lists now match leaves the newest run's window behind: the test takes
        // the window the cadence would close instead, as a run would.
        if (entries.every(({ message }) => memoryScreenReason(message, cadence.screening) === null)) {
            return windowOf(entries);
        }
    }
    const ceiling = writerCeiling(messages);
    if (ceiling === null) {
        return null;
    }
    const windows = await confirmedWindows({
        messages,
        confirmedBefore: ceiling,
        recorded: readRecordedMessages(store, chaId, chatId),
        cadence,
        maxContext: base.maxContext,
        tokenizer,
        limit: 1,
        manual: true,
    });
    return windows?.[0] ?? null;
}

/** The result of one run from how it ended and the run its last commit held. */
function testResult(
    arg: {
        customPrompt: boolean;
        slots: StructuredMemoryTestResult["slots"];
        window: WriterWindow;
        ended: StructuredMemoryWriterResult;
        run: MemoryRun | undefined;
    },
    redact: (text: string) => string,
): StructuredMemoryTestResult {
    const { customPrompt, slots, window, ended, run } = arg;
    const receipt = run?.receipt;
    const reason = ended.outcome === "skipped" ? ended.reason : receipt?.reason;
    return {
        kind: "memoryTest",
        customPrompt,
        slots,
        messageIds: window.sources.map(({ messageId }) => messageId),
        outcome: ended.outcome,
        ...(reason !== undefined ? { reason } : {}),
        ...(ended.outcome === "failed" ? { error: redact(ended.error) } : {}),
        ...(run?.analysis ? { analysis: run.analysis } : {}),
        ...(run?.patches ? { patches: run.patches } : {}),
        patchCalled: run?.patchInput !== undefined,
        warnings: receipt?.warnings ?? [],
        unverified: receipt?.unverified ?? [],
        refused: receipt?.refused ?? [],
        ...(run?.model ? { model: run.model } : {}),
        inputTokens: run?.inputTokens ?? 0,
        outputTokens: run?.outputTokens ?? 0,
    };
}

/** The `memoryTest` command: see the file's comment. */
export async function runMemoryTest(job: RunningJob, deps: GenerationRunnerDeps): Promise<void> {
    const { store } = deps;
    const { characterId, chatId } = job.context;
    const scope = admitRecord(job, deps, undefined);
    try {
        const blocking = jobMemoryBlockingReason(scope);
        if (blocking !== null) {
            throw new GenerationRunnerError(409, TEST_REFUSALS[blocking]);
        }
        const status = deps.memoryTasks?.status({ chaId: characterId, chatId });
        if (status?.state === "queued" || status?.state === "running") {
            throw new GenerationRunnerError(409, "The memory writer is working in this chat. Try again when it ends.");
        }
    } catch (error) {
        throw markFailure(error, { stage: "setup" });
    }
    job.emit({ type: "stage", stage: "memory" });
    const owner = scope.db.characters.find((entry) => entry?.chaId === characterId);
    const base: MemoryTaskBase = jobMemoryTaskBase({
        job,
        scope,
        sourceGeneration: scope.chatSourceGeneration!,
        speakerId: owner?.type === "group" ? null : characterId,
        fromChain: false,
        chatAdditionalTokens: 0,
    });
    const fence = () => {
        if (job.signal.aborted) {
            throw job.signal.reason ?? new Error("The test run was aborted");
        }
    };
    const { host, tokenizer } = createMemoryTaskHost({
        scope,
        input: base,
        deps: writerHostDeps(detachedHostDeps(deps)),
        signal: job.signal,
        fence,
    });
    const customPrompt = normalizeStructuredMemorySettings(
        selectedHypaV3Preset(scope.db)?.settings?.structured,
    ).fineTuning;
    const done = (result: StructuredMemoryTestResult) =>
        job.emit({ type: "done", revision: store.chatRevision(characterId, chatId), result });
    try {
        const window = await testWindow(deps, scope, base, tokenizer);
        if (!window) {
            done({
                kind: "memoryTest",
                customPrompt,
                slots: slotWarnings(host),
                messageIds: [],
                outcome: "none",
                patchCalled: false,
                warnings: [],
                unverified: [],
                refused: [],
                inputTokens: 0,
                outputTokens: 0,
            });
            return;
        }
        let kept: MemoryChanges | undefined;
        const commit = (baseRevision: string, changes: MemoryChanges): StructuredMemoryCommit => {
            fence();
            kept = changes;
            return { outcome: "committed", revision: baseRevision };
        };
        const input: StructuredMemoryTaskInput = {
            ...base,
            kind: "structuredMemory",
            confirmedBefore: window.sources.at(-1)!.messageId,
        };
        const ended = await createStructuredWriter(store)({
            scope,
            input,
            host,
            tokenizer,
            window,
            manual: true,
            dryRun: true,
            commit,
        });
        fence();
        done(
            testResult(
                { customPrompt, slots: slotWarnings(host), window, ended, run: kept?.runs?.at(-1) },
                host.redact,
            ),
        );
    } catch (error) {
        if (error instanceof MemoryHostFailure) {
            throw new GenerationRunnerError(500, error.message, { stage: "request" });
        }
        throw error;
    }
}
