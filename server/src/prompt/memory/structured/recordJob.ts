import { eligibleHistory } from "../../../../../shared/contextReport.ts";
import { summarizesLocally } from "../../../../../shared/hypaV3Presets.ts";
import type {
    MemoryBlockingReason,
    MemoryTaskRecordAnswer,
    StructuredMemoryTaskInput,
} from "../../../../../shared/jobs.ts";
import { STRUCTURED_MEMORY_ALGORITHM } from "../../../../../shared/structuredMemory.ts";
import type { MemoryChanges } from "../../../data/memoryStore.ts";
import {
    GenerationRunnerError,
    markFailure,
    type MemoryControl,
    type RunningJob,
} from "../../../jobs/generationJobs.ts";
import {
    admitProviderModels,
    flushChatMetadata,
    type JobScope,
    loadJobScope,
    refreshChat,
    refreshChatAfterWrite,
    scopeChat,
} from "../../../jobs/jobScope.ts";
import { createJobRunState, createRunSetup, type GenerationRunnerDeps, type RunSetup } from "../../../jobs/runSetup.ts";
import {
    acquireJobWriter,
    createJobMemoryHost,
    jobChatTokenCounter,
    jobMemoryBlockingReason,
    jobMemoryTaskBase,
    openJobMemoryRun,
} from "../../runner.ts";
import type { MemoryHost, MemoryTokenizer } from "../host.ts";
import { MEMORY_TASK_LIMITS, type StructuredMemoryCommit } from "../memoryTasks.ts";
import { retireRerecorded } from "./reconcile.ts";
import {
    confirmedWindows,
    historicalWindow,
    readRecordedMessages,
    readRerecordEvents,
    writerCadence,
    writerCeiling,
    type WriterCeiling,
    type WriterWindow,
} from "./window.ts";
import { chatAdoptionHold, commitWindow, createStructuredWriter, writerRequestDb } from "./writer.ts";

/**
 * A person's start of Structured Memory's writer as a command job (`memoryRecord`): "record now" names
 * a message, which the press confirms, and resume names none. A job and not a call on the service,
 * because only a job has a fresh scope: the service retains no input across a restart, and it cannot
 * tell a slot that needs the tab.
 *
 * - Refused: another algorithm is selected, the owner's memory is off, the summarization model is a
 *   local one, which the writer cannot serve here either, the chat waits for a person to adopt or
 *   decline its HypaV3 summaries (`chatAdoptionHold`, a 409), so a stale tab's press with no such choice
 *   gets an answer, or the named message is not an eligible assistant message. The chat is this job's,
 *   so no generation runs at admission. With nothing confirmed there is nothing to do: the job ends
 *   `done`.
 * - With a service and nothing that needs the tab: the input goes to `MemoryTasks.record`. The job ends
 *   at once, and the task starts after its terminal.
 * - A Plugin `memory` slot, a `request` trigger, or no service: the writer runs here on the chat's
 *   writer lease, as a blocking HypaV3 summary does, because only the job's requests reach the plugin
 *   provider and the trigger. Repair windows run first, then ordinary windows oldest first, up to
 *   `maxWriterWindows` with a task's request policy. The first nonrecorded window ends the job; any run
 *   or receipt already written stays stored, and a skipped window need not create either.
 *   Windows left past the cap are an ordinary `done`. No task fence applies: the job holds the chat's
 *   slot and the lease, and a panel write checks the memory revision.
 * - A press also re-records the marked events, here as on the service: their windows come first
 *   (`confirmedWindows`), and a commit retires what each replaces (`retireRerecorded`), refused
 *   `windowChanged` when that event no longer wants it.
 *
 * A send's approved gap (`recordGapInJob`) shares those windows, inside the send: the person who said
 * yes to the question waits for it, so it takes their stop control, and a window that does not record
 * only ends the run and the send goes on with the gap. Any run or receipt already written stays stored;
 * a skipped window need not create either. It re-records nothing: marks wait for a press or hand-off.
 */

type RecordRefusal = Extract<MemoryTaskRecordAnswer, { outcome: "refused" }>["reason"];

/** Service refusals become command errors, so a press gets an answer instead of a silent hand-off. */
export const RECORD_REFUSALS: Readonly<Record<RecordRefusal, { status: number; message: string }>> = {
    shuttingDown: { status: 503, message: "The server is shutting down" },
    maintenance: { status: 503, message: "The server is under maintenance" },
    staleInput: { status: 409, message: "The chat changed while the recording was being set up" },
    queueFull: { status: 503, message: "Too many chats are waiting for memory work. Try again later." },
};

/** Loads the job's scope, sends `accepted`, and refuses what no writer can serve. */
export function admitRecord(job: RunningJob, deps: GenerationRunnerDeps, messageId: string | undefined): JobScope {
    try {
        const scope = loadJobScope(deps.store, deps.kinds, job.context);
        admitProviderModels(scope, job.hooks.providers);
        job.emit({ type: "accepted", jobId: job.id, revision: scope.chatRevision, text: "" });
        const { db } = scope;
        if (db.memoryAlgorithmType !== STRUCTURED_MEMORY_ALGORITHM) {
            throw new GenerationRunnerError(400, "Structured memory is not this chat's memory");
        }
        if (!db.characters.find((entry) => entry?.chaId === scope.characterId)?.supaMemory) {
            throw new GenerationRunnerError(400, "Memory is turned off for this character");
        }
        if (summarizesLocally(db)) {
            throw new GenerationRunnerError(400, "The memory writer cannot run a local summarization model");
        }
        const { characterId, chatId } = job.context;
        const contents = deps.store.memory.readContents(characterId, chatId);
        if (contents && chatAdoptionHold(deps.store, characterId, chatId, contents) > 0) {
            throw new GenerationRunnerError(
                409,
                "Adopt or decline this chat's HypaV3 summaries in the memory panel before recording",
            );
        }
        if (messageId !== undefined) {
            const eligible = eligibleHistory(scopeChat(scope)?.message ?? []).messages;
            if (eligible.find((message) => message.chatId === messageId)?.role !== "char") {
                throw new GenerationRunnerError(409, "This message cannot be recorded");
            }
        }
        return scope;
    } catch (error) {
        throw markFailure(error, { stage: "setup" });
    }
}

/**
 * How `runWindows` ended, with the windows it recorded. `done` ran every window, or stopped between two
 * when the owner asked; `gone` found the ceiling no longer an eligible message; the other two are the
 * first window that did not record.
 */
type WindowsEnd = { recorded: number } & (
    { outcome: "done" | "gone" } | { outcome: "failed"; error: string } | { outcome: "skipped"; reason: string }
);

/**
 * The writer's windows through `ceiling`, on the job's lease, in order, after those of the marked
 * events when `rerecords` says a press started it. Only an `initial` run takes the stop control, as the
 * job's memory runs do. A throw is the job's own end, not a window's.
 */
async function runWindows(
    job: RunningJob,
    deps: GenerationRunnerDeps,
    setup: RunSetup,
    host: MemoryHost,
    arg: {
        input: StructuredMemoryTaskInput;
        ceiling: WriterCeiling;
        phase: "blocking" | "initial";
        reason: MemoryBlockingReason | null;
        rerecords: boolean;
    },
): Promise<WindowsEnd> {
    const { store } = deps;
    const { scope } = setup;
    const { input, ceiling } = arg;
    const { characterId, chatId } = job.context;
    const counter = jobChatTokenCounter(deps, scope, input.tokenPolicy.chatAdditionalTokens);
    const tokenizer: MemoryTokenizer = {
        tokenizeChat: async (chat) => {
            const tokens = await counter.tokenizeChat(chat);
            setup.check();
            return tokens;
        },
    };
    const refreshed = () => {
        if (!refreshChat(store, scope)) {
            throw new GenerationRunnerError(404, "The job's chat no longer exists");
        }
    };
    const commitFor =
        (window: WriterWindow) =>
        (baseRevision: string, changes: MemoryChanges): StructuredMemoryCommit => {
            setup.check();
            job.assertWritable?.();
            if (
                store.epoch() !== input.epoch ||
                store.chatSourceGeneration(characterId, chatId) !== input.sourceGeneration
            ) {
                return { outcome: "refused", reason: "staleInput" };
            }
            const retired = retireRerecorded(store, input.chatRef, window, changes);
            if (!retired) {
                return { outcome: "refused", reason: "windowChanged" };
            }
            return commitWindow(store, {
                input,
                window,
                ceiling,
                baseRevision,
                changes: retired,
                writeReceipt: (group) => {
                    const applied = job.write(() => ({ chats: [group] }));
                    refreshChatAfterWrite(store, scope, applied.chats[0], applied.written?.chats[0]);
                    job.emitRecords({ chats: [{ characterId, id: chatId }] });
                },
            });
        };

    const lease = await acquireJobWriter(job, deps, setup);
    const run = openJobMemoryRun(job, setup, arg.phase, arg.reason);
    let stop: MemoryControl | null = null;
    try {
        stop = arg.phase === "initial" ? run.registerStop() : null;
        // A lease holder reads what the chat's task wrote before the lease.
        refreshed();
        const windows = await confirmedWindows({
            messages: scopeChat(scope)?.message ?? [],
            confirmedBefore: ceiling.id,
            inclusive: ceiling.inclusive,
            recorded: readRecordedMessages(store, characterId, chatId),
            cadence: writerCadence(scope.db),
            maxContext: input.maxContext,
            tokenizer,
            limit: MEMORY_TASK_LIMITS.maxWriterWindows,
            manual: true,
            ...(arg.rerecords ? { rerecord: readRerecordEvents(store, characterId, chatId) } : {}),
        });
        setup.check();
        if (!windows) {
            return { outcome: "gone", recorded: 0 };
        }
        const writer = createStructuredWriter(store);
        let recorded = 0;
        for (const [index, window] of windows.entries()) {
            if (stop?.stopRequested()) {
                break;
            }
            run.update({ done: index, total: windows.length });
            refreshed();
            const historical = historicalWindow(store, characterId, chatId, scopeChat(scope)?.message ?? [], window);
            const result = await writer({
                scope,
                input,
                host,
                tokenizer,
                window,
                manual: true,
                ...(historical ? { historical } : {}),
                commit: commitFor(window),
            });
            setup.check();
            if (result.outcome !== "recorded") {
                return { ...result, recorded };
            }
            recorded++;
        }
        return { outcome: "done", recorded };
    } finally {
        try {
            stop?.release();
        } finally {
            try {
                lease.release();
            } finally {
                run.close();
            }
        }
    }
}

/** Records in the job: see the file's comment. */
async function recordInJob(
    job: RunningJob,
    deps: GenerationRunnerDeps,
    scope: JobScope,
    arg: { input: StructuredMemoryTaskInput; ceiling: WriterCeiling; reason: MemoryBlockingReason | null },
): Promise<void> {
    const { characterId } = job.context;
    const state = createJobRunState(job, deps.scriptWorkers.createBudget());
    const setup = createRunSetup(job, deps, state, scope, {
        runCharacterId: characterId,
        engineCharacterId: characterId,
    });
    // The input's fingerprint was taken from the settings as they stand: a request reads the scope's
    // copy, and only that copy takes the writer's policy.
    scope.request = { ...scope.request, db: writerRequestDb(scope.request.db) };
    const host = createJobMemoryHost({
        deps,
        setup,
        chatRef: arg.input.chatRef,
        embeddingEnv: setup.bindings.services.embeddings(setup.nativeCtx),
    });
    try {
        job.emit({ type: "stage", stage: "memory" });
        const ended = await runWindows(job, deps, setup, host, { ...arg, phase: "blocking", rerecords: true });
        if (ended.outcome === "gone") {
            throw new GenerationRunnerError(409, "This message can no longer be recorded", { stage: "persist" });
        }
        if (ended.outcome === "failed") {
            throw new GenerationRunnerError(500, host.redact(ended.error), { stage: "request" });
        }
        if (ended.outcome === "skipped") {
            throw new GenerationRunnerError(409, `The recording stopped: ${ended.reason}`, { stage: "persist" });
        }
    } catch (error) {
        // A latched failure is the job's own, whatever surfaced first.
        throw markFailure(setup.bindings.fatal() ?? error, { stage: "request" });
    }
    flushChatMetadata(job);
}

/**
 * A send's approved gap: the windows open before the input's ceiling, up to `maxWriterWindows`, in the
 * send, with the writer's request policy around them alone, so the reply's own request keeps its
 * temperature and schema. Answers how many it recorded, whichever way the run ended.
 */
export async function recordGapInJob(
    job: RunningJob,
    deps: GenerationRunnerDeps,
    setup: RunSetup,
    host: MemoryHost,
    input: StructuredMemoryTaskInput,
): Promise<number> {
    const { scope } = setup;
    const request = scope.request;
    scope.request = { ...request, db: writerRequestDb(request.db) };
    try {
        const { recorded } = await runWindows(job, deps, setup, host, {
            input,
            ceiling: { id: input.confirmedBefore, inclusive: false },
            phase: "initial",
            reason: "gap",
            rerecords: false,
        });
        return recorded;
    } finally {
        scope.request = request;
    }
}

/** The `memoryRecord` command, `messageId` its message: see the file's comment. */
export async function runMemoryRecord(
    job: RunningJob,
    messageId: string | undefined,
    deps: GenerationRunnerDeps,
): Promise<void> {
    const { store } = deps;
    const { characterId, chatId } = job.context;
    const scope = admitRecord(job, deps, messageId);
    const confirmedBefore = messageId ?? writerCeiling(scopeChat(scope)?.message ?? []);
    if (confirmedBefore === null) {
        job.emit({ type: "done", revision: store.chatRevision(characterId, chatId) });
        return;
    }
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
        confirmedBefore,
    };
    const reason = jobMemoryBlockingReason(scope);
    if (!deps.memoryTasks || reason !== null) {
        const ceiling = { id: confirmedBefore, inclusive: messageId !== undefined };
        await recordInJob(job, deps, scope, { input, ceiling, reason });
    } else {
        const answer = deps.memoryTasks.record(input, messageId !== undefined ? { through: messageId } : {});
        if (answer.outcome === "refused") {
            const { status, message } = RECORD_REFUSALS[answer.reason];
            throw new GenerationRunnerError(status, message, { stage: "setup" });
        }
    }
    // Synchronous after queueing: the service starts a queued input on a later turn, so after this terminal.
    job.emit({ type: "done", revision: store.chatRevision(characterId, chatId) });
}
