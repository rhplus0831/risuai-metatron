import type { CbsUsage } from "../../../shared/cbs/limits.ts";
import {
    type GenerationErrorStage,
    type GenerationFollowUp,
    MAX_FOLLOW_UP_PART_CHARS,
    MAX_FOLLOW_UP_PARTS,
} from "../../../shared/jobs.ts";
import type { character, Chat } from "../../../shared/database.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { createScriptCache } from "../../../shared/scripts/regex.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import type { triggerscript } from "../../../shared/triggers.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { LlmRequests } from "../llm/requests.ts";
import { createLuaBindings, type LuaBindings, LuaJobFatalError, type LuaWorkingCopy } from "../lua/bindings.ts";
import { createCommandExecutor } from "../prompt/commands.ts";
import type { EmbeddingsService } from "../prompt/embeddings.ts";
import type { TokenCounter } from "../prompt/tokens.ts";
import type { TransformersService } from "../prompt/transformers.ts";
import {
    createTriggerRuntime,
    type TriggerArg,
    TriggerEffectLimitError,
    type TriggerMode,
    type TriggerResult,
} from "../prompt/triggers.ts";
import type { RegexOp } from "../scripts/worker.ts";
import { createLuaBudget, type HostContext, type LuaBudget, type ScriptWorkerPool } from "../scripts/workerPool.ts";
import { jobModules } from "./cbsHost.ts";
import { applyTriggerChat, type OwnedGeneration } from "./chatResult.ts";
import { GenerationRunnerError, markFailure, type RunningJob } from "./generationJobs.ts";
import type { MessageGuard } from "./generationLock.ts";
import { flushChatMetadata, type JobScope, refreshCharacter, refreshChat, scopeChat } from "./jobScope.ts";
import { createJobToolState, type JobToolState } from "../mcp/jobTools.ts";
import type { DiagnosticsRecorder } from "../diagnostics/log.ts";
import type { McpRegistry } from "../mcp/registry.ts";
import type { PushService } from "../push/pushService.ts";
import type { TranslationRunner } from "../translation/runner.ts";

export type GenerationRunnerDeps = {
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    rootDir: string;
    savePath: string;
    scriptWorkers: ScriptWorkerPool;
    llm: LlmRequests;
    tokens: TokenCounter;
    /** The embeddings of the memory algorithms and the similarity searches. */
    embeddings: EmbeddingsService;
    /** The local models: the summarizer and the image captioner of prompt assembly. */
    transformers: TransformersService;
    /** The remote MCP clients of the process; without them a job's requests offer no tools. */
    mcp?: McpRegistry;
    /** The generation lock: a trigger's reorder replaces the chat only while no message of it is generated. */
    lock: MessageGuard;
    /** The random source of `presetChain` and the group order (default `Math.random`). */
    random?: () => number;
    /** The translation runner a send hands its messages to. */
    translations?: Pick<TranslationRunner, "handOff">;
    /** Web Push for chat completions; without it only the tab is notified. */
    push?: Pick<PushService, "send">;
    /** The diagnostics journal (its caught faults). */
    diagnostics?: DiagnosticsRecorder;
};

/** Rejects with the signal's reason when it aborts first. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        promise.catch(() => {});
        return Promise.reject(signal.reason ?? new Error("request aborted"));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("request aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

/**
 * What every run of one job shares, whatever its speaker: one aggregate Lua budget, its CBS
 * evaluation time, the effect count of its native triggers, the fatal abort (the first fatal host failure stops the run in progress at
 * once: the Lua hook raises, so a script that catches it cannot go on writing), and the regex
 * scripts' cache.
 */
export type JobRunState = {
    budget: LuaBudget;
    /**
     * The no-memory trim question's outcome for the job (`AssemblyHost.memoryTrim`): the user's answer
     * (asked at most once a job), serving every later speaker and round, or "memory" once the owner's
     * memory was found or turned on. A chat's stored "don't ask again" is not kept here.
     */
    memoryTrim?: "memory" | "trim";
    /** The CBS evaluation time of the job, across its runs (`serverCbsLimits`). */
    cbsUsage: CbsUsage;
    effects: { count: number };
    fatalAbort: AbortController;
    runSignal: AbortSignal;
    /** The regex scripts' result cache of the job (the client keeps one per tab). */
    scriptCache: ReturnType<typeof createScriptCache>;
    /** The dynamic-asset matches of the job (the client's `bestMatchCache`, one per tab). */
    assetMatches: Map<string, string>;
    /**
     * The emotions shown last per character (the tab's `CharEmotion` names when the job was created,
     * `context.client.emotions`, plus every emotion the job showed since), oldest first.
     */
    emotions: Map<string, string[]>;
    /** The `/multisend` commands a command job ran: its tab sends their parts after the job. */
    followUps: GenerationFollowUp[];
    /** The auto-continue and resend rounds the job has run (at most `MAX_SEND_ROUNDS`). */
    rounds: { count: number; noticed?: boolean };
    /** The job's MCP tool sets and the tool calls its models asked for. */
    tools: JobToolState;
    /**
     * Where the send runner is: the stage a failure that names none gets (`runPromptJob`).
     */
    stage: GenerationErrorStage;
};

/**
 * Runs a script (Lua, a trigger, a plugin hook): a failure that names no stage yet is the script's.
 * A failure inside it that already names one (a write, a request) keeps it.
 */
export async function asScript<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        throw markFailure(error, { stage: "script" });
    }
}

/** The auto-continue and resend rounds one job may run beyond its speakers' own turns. */
export const MAX_SEND_ROUNDS = 8;

/**
 * Shows an emotion of `chaId` (the client's `CharEmotion` update): the job's history gets the name
 * as the tab's store does (the oldest dropped when there are five), and the tab gets the notice.
 */
export function showEmotion(job: RunningJob, state: JobRunState, chaId: string, name: string, image: string): void {
    const list = emotionHistory(state, chaId);
    if (list.length > 4) {
        list.splice(0, 1);
    }
    list.push(name);
    job.channel.notice({ kind: "emotion", payload: { chaId, name, image } });
}

/** The job's list of the emotions shown last for `chaId` (the list itself: trimmed and extended in place). */
export function emotionHistory(state: JobRunState, chaId: string): string[] {
    let list = state.emotions.get(chaId);
    if (!list) {
        list = [];
        state.emotions.set(chaId, list);
    }
    return list;
}

export function createJobRunState(job: RunningJob): JobRunState {
    const fatalAbort = new AbortController();
    return {
        budget: createLuaBudget(),
        cbsUsage: { usedMs: 0 },
        effects: { count: 0 },
        fatalAbort,
        runSignal: AbortSignal.any([job.signal, fatalAbort.signal]),
        scriptCache: createScriptCache(),
        assetMatches: new Map(),
        emotions: new Map(Object.entries(job.context.client?.emotions ?? {}).map(([id, names]) => [id, [...names]])),
        followUps: [],
        rounds: { count: 0 },
        tools: createJobToolState(),
        stage: "setup",
    };
}

/** What a Lua run returned that its caller decides on (a fatal failure or an abort has already thrown). */
export type LuaOutcome = {
    res: unknown;
    stopSending: boolean;
    /** The script's own failure: where it failed (`undefined`: the pool, a crash, or no worker). */
    error?: { message: string; failedAt?: "load" | "dispatch"; timedOut?: boolean };
};

/**
 * One run's services: the bindings for its character (`runCharacterId`, the speaker in a group send)
 * on the job's chat (`engineCharacterId`, the chat's owner), the native context, the Lua runner, the
 * trigger runtime with its command executor, and the native `request` trigger every request of the
 * bindings runs.
 */
export type RunSetup = {
    scope: JobScope;
    bindings: LuaBindings;
    nativeCtx: HostContext;
    /** A Lua run on the job's chat (on `working` when given); throws a latched fatal failure or an abort. */
    runLua(
        code: string,
        options: { mode: string; lowLevelAccess: boolean; working?: LuaWorkingCopy; data?: unknown; meta?: unknown },
    ): Promise<LuaOutcome>;
    /** `runTrigger` of the trigger runtime. */
    runTrigger(char: character, mode: TriggerMode, arg: TriggerArg): Promise<TriggerResult | null | undefined>;
    /**
     * `captureChatBaseline`, `runTrigger(char, mode, { chat })`, and `applyChatResult` on the chat as
     * stored now; the result (or undefined when the chat is gone or the trigger returned nothing).
     */
    runOnCopy(
        char: character,
        mode: TriggerMode,
        arg?: Omit<TriggerArg, "chat">,
        options?: { generation?: OwnedGeneration },
    ): Promise<TriggerResult | null | undefined>;
    /** Raises a latched fatal failure and fences the run. */
    check(): void;
};

/** The character's Lua triggers (with its `lowLevelAccess`) and its modules' (each with its module's). */
export function moduleTriggers(scope: JobScope): triggerscript[] {
    return jobModules(scope).flatMap((module) =>
        (module?.trigger ?? []).map((trigger) => ({ ...trigger, lowLevelAccess: module.lowLevelAccess })),
    );
}

export function createRunSetup(
    job: RunningJob,
    deps: GenerationRunnerDeps,
    state: JobRunState,
    scope: JobScope,
    ids: { runCharacterId: string; engineCharacterId: string },
    /** `frozen`: a render's snapshot (the script transform; `LuaBindingDeps.frozen`). */
    options: { frozen?: boolean } = {},
): RunSetup {
    const { store, kinds } = deps;
    const { characterId, chatId } = job.context;
    const bindings = createLuaBindings({
        job,
        scope,
        store,
        kinds,
        rootDir: deps.rootDir,
        savePath: deps.savePath,
        llm: deps.llm,
        tokens: deps.tokens,
        runCharacterId: ids.runCharacterId,
        engineCharacterId: ids.engineCharacterId,
        triggerId: job.context.triggerId ?? null,
        cbsUsage: state.cbsUsage,
        embeddings: deps.embeddings,
        ...(deps.mcp ? { mcp: { registry: deps.mcp, state: state.tools } } : {}),
        lock: deps.lock,
        onFatal: (error) => state.fatalAbort.abort(error),
        ...(options.frozen ? { frozen: true } : {}),
    });
    const { services } = bindings;
    const identity = { characterId, chatId, presetId: scope.promptPreset.id, personaId: scope.effectivePersona.id };
    const nativeCtx: HostContext = {
        identity,
        access: "lowLevel",
        signal: state.runSignal,
        regex: (op: RegexOp) => untilAborted(deps.scriptWorkers.regex(op), state.runSignal),
    };
    const check = () => {
        const fatal = bindings.fatal();
        if (fatal) {
            throw fatal;
        }
        services.fence(nativeCtx);
    };

    const runLua: RunSetup["runLua"] = async (code, options) => {
        const run = async (): Promise<LuaOutcome> => {
            const result = await deps.scriptWorkers.runLua(
                {
                    code,
                    mode: options.mode,
                    lowLevelAccess: options.lowLevelAccess,
                    identity,
                    ...(options.data !== undefined ? { data: options.data } : {}),
                    ...(options.meta !== undefined ? { meta: options.meta } : {}),
                },
                { host: bindings.host, signal: state.runSignal, budget: state.budget },
            );
            flushChatMetadata(job);
            check();
            if (result.aborted) {
                throw services.latch(new LuaJobFatalError("request aborted"));
            }
            return {
                res: result.res,
                stopSending: result.stopSending,
                ...(result.error !== undefined
                    ? {
                          error: {
                              message: result.error,
                              ...(result.failedAt ? { failedAt: result.failedAt } : {}),
                              ...(result.timedOut ? { timedOut: true } : {}),
                          },
                      }
                    : {}),
            };
        };
        return asScript(() => (options.working ? bindings.withWorking(options.working, run) : run()));
    };

    const storedCharacter = () => {
        if (!options.frozen) {
            refreshCharacter(store, kinds, scope, characterId);
        }
        return scope.db.characters.find((entry) => entry?.chaId === characterId);
    };

    const runOnCopy: RunSetup["runOnCopy"] = async (char, mode, arg = {}, options = {}) => {
        flushChatMetadata(job);
        services.fence(nativeCtx);
        if (!refreshChat(store, scope)) {
            return undefined;
        }
        const baseline = { chat: structuredClone(scopeChat(scope)!) as Chat, revision: scope.chatRevision };
        let result: TriggerResult | null | undefined;
        let threw = false;
        try {
            result = await asScript(() => runtime.runTrigger(char, mode, { ...arg, chat: baseline.chat }));
        } catch (error) {
            threw = true;
            throw error;
        } finally {
            if (threw) {
                try {
                    flushChatMetadata(job);
                } catch {
                    // The flush has latched its failure; preserve the trigger's original error.
                }
            } else {
                flushChatMetadata(job);
            }
        }
        services.fence(nativeCtx);
        if (result) {
            applyTriggerChat({ job, store, scope, lock: deps.lock }, baseline, result.chat, options);
        }
        return result;
    };

    /** `/trigger`: a manual run of the chat's character, as stored now (none in a group chat). */
    const runManual = async (triggerName: string) => {
        const owner = storedCharacter();
        if (!owner || owner.type === "group") {
            services.fence(nativeCtx);
            return;
        }
        await runOnCopy(owner, "manual", { manualName: triggerName });
    };

    const executor = createCommandExecutor({
        services,
        ctx: nativeCtx,
        character: storedCharacter,
        runManualTrigger: runManual,
        multisend: (clear, parts) => {
            // In the tab `/multisend` does nothing while a send runs; a send job is that send.
            if (job.kind !== "command") {
                return;
            }
            const queued = state.followUps.reduce((count, entry) => count + entry.parts.length, 0);
            if (
                queued + parts.length > MAX_FOLLOW_UP_PARTS ||
                parts.some((part) => part.length > MAX_FOLLOW_UP_PART_CHARS)
            ) {
                services.notice({
                    kind: "alertError",
                    payload: { message: "/multisend: too many or too long parts for one command" },
                });
                return;
            }
            state.followUps.push({ clear, parts: [...parts] });
        },
    });
    const runtime = createTriggerRuntime({
        services,
        chatRef: { chaId: characterId, chatId },
        ctx: nativeCtx,
        observeCharacterPatches: (listener) => bindings.observeCharacterPatches(listener),
        runLua: async (code, options) => {
            const outcome = await runLua(code, options);
            if (outcome.error) {
                // A failure inside the handler is the script's own (logged, as `runScripted` catches
                // it); a load failure, a spent budget, or a pool failure ends the job.
                if (outcome.error.failedAt !== "dispatch" || outcome.error.timedOut) {
                    throw new GenerationRunnerError(500, `Lua: ${outcome.error.message}`, { stage: "script" });
                }
                console.error("[Lua]", outcome.error.message);
            }
            return { stopSending: outcome.stopSending };
        },
        moduleTriggers: () => moduleTriggers(scope),
        templateDefaultVariables: scope.db.templateDefaultVariables,
        selectedPersonaPrompt: scope.db.personaPrompt ?? "",
        effectivePersonaId: scope.effectivePersona.id ?? null,
        runCommand: (line) => executor.processMultiCommand(line),
        effects: state.effects,
    });

    // `requestChatData`'s `request` trigger: the chat owner's (none for a group), in display mode on
    // the chat as it is now, before every attempt; an invalid result keeps the messages.
    bindings.setRequestTrigger(async (formated: OpenAIChat[]) => {
        const owner = scope.db.characters.find((entry) => entry?.chaId === characterId);
        if (!owner || owner.type === "group" || !services.chatExists()) {
            return formated;
        }
        let result: TriggerResult | null | undefined;
        try {
            result = await runtime.runTrigger(owner, "request", {
                chat: services.liveChat(),
                displayMode: true,
                displayData: JSON.stringify(formated),
            });
        } catch (error) {
            markFailure(error, { stage: "script" });
            // The effect limit is the job's, not the script's: it ends the job (latched, so the request
            // and everything after it stop).
            if (error instanceof TriggerEffectLimitError) {
                throw services.latch(error);
            }
            throw error;
        }
        services.fence(nativeCtx);
        const got = JSON.parse(result?.displayData ?? "null");
        if (!got || !Array.isArray(got)) {
            throw new Error("Invalid return");
        }
        return got as OpenAIChat[];
    });

    return {
        scope,
        bindings,
        nativeCtx,
        runLua,
        runTrigger: (char, mode, arg) => asScript(() => runtime.runTrigger(char, mode, arg)),
        runOnCopy,
        check,
    };
}
