import type { character, groupChat } from "../../../shared/database.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import type { triggerscript } from "../../../shared/triggers.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { LlmRequests } from "../llm/requests.ts";
import { createLuaBindings, type LuaBindings, LuaJobFatalError, type LuaWorkingCopy } from "../lua/bindings.ts";
import { createCommandExecutor } from "../prompt/commands.ts";
import type { TokenCounter } from "../prompt/tokens.ts";
import { createTriggerRuntime } from "../prompt/triggers.ts";
import type { RegexOp } from "../scripts/worker.ts";
import { createLuaBudget, type HostContext, type LuaBudget, type ScriptWorkerPool } from "../scripts/workerPool.ts";
import { jobModules } from "./cbsHost.ts";
import { applyTriggerChat } from "./chatResult.ts";
import { type GenerationRunner, GenerationRunnerError, type RunningJob, unavailableRunner } from "./generationJobs.ts";
import type { MessageGuard } from "./generationLock.ts";
import { type JobScope, loadJobScope, refreshChat, scopeChat } from "./jobScope.ts";

export type GenerationRunnerDeps = {
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    rootDir: string;
    savePath: string;
    scriptWorkers: ScriptWorkerPool;
    llm: LlmRequests;
    tokens: TokenCounter;
    /** The generation lock: a trigger's reorder replaces the chat only while no message of it is generated. */
    lock: MessageGuard;
};

/**
 * The server's generation runner (Phase 5): `command` jobs run here (buttons from slice 8a, manual
 * triggers from slice 8b); every other kind answers 501 until prompt assembly (slice 9).
 */
export function createGenerationRunner(deps: GenerationRunnerDeps): GenerationRunner {
    return async (job) => {
        if (job.kind === "command") {
            await runCommand(job, deps);
            return;
        }
        await unavailableRunner(job);
    };
}

/** Rejects with the signal's reason when it aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

/** What every command run shares: the scope, the run's character, one budget, the fatal abort, the bindings. */
type CommandSetup = {
    scope: JobScope;
    character: character;
    budget: LuaBudget;
    runSignal: AbortSignal;
    bindings: LuaBindings;
    /** The context of the runner's own (native) calls: the run signal and the worker's regex tasks. */
    nativeCtx: HostContext;
};

/**
 * Loads the job's scope and sends `accepted`; refuses a group chat (as `Chat.svelte` refuses
 * buttons and manual triggers) or a missing character; sets up the run.
 */
function prepare(job: RunningJob, deps: GenerationRunnerDeps): CommandSetup {
    const { store, kinds } = deps;
    const { characterId, chatId } = job.context;
    const scope = loadJobScope(store, kinds, job.context);
    job.emit({ type: "accepted", jobId: job.id, revision: scope.chatRevision, text: "" });

    const found = scope.db.characters.find((entry) => entry?.chaId === characterId);
    if (!found || found.type === "group") {
        throw new GenerationRunnerError(
            400,
            job.command?.type === "manual"
                ? "Manual triggers do not run in a group chat"
                : "Buttons do not run in a group chat",
        );
    }
    const budget = createLuaBudget();
    // The first fatal host failure stops the run in progress at once (the Lua hook raises), so a
    // script that catches it cannot go on writing.
    const fatalAbort = new AbortController();
    const runSignal = AbortSignal.any([job.signal, fatalAbort.signal]);
    const bindings = createLuaBindings({
        job,
        scope,
        store,
        kinds,
        rootDir: deps.rootDir,
        savePath: deps.savePath,
        llm: deps.llm,
        tokens: deps.tokens,
        // The chat screen's character, which owns the chat.
        runCharacterId: characterId,
        engineCharacterId: characterId,
        triggerId: job.context.triggerId ?? null,
        onFatal: (error) => fatalAbort.abort(error),
    });
    const nativeCtx: HostContext = {
        identity: { characterId, chatId, presetId: scope.preset.id, personaId: scope.effectivePersona.id },
        access: "lowLevel",
        signal: runSignal,
        regex: (op: RegexOp) => untilAborted(deps.scriptWorkers.regex(op), runSignal),
    };
    return { scope, character: found, budget, runSignal, bindings, nativeCtx };
}

/** The character's Lua triggers (with its `lowLevelAccess`) and its modules' (each with its module's). */
function moduleTriggers(scope: JobScope): triggerscript[] {
    return jobModules(scope).flatMap((module) =>
        (module?.trigger ?? []).map((trigger) => ({ ...trigger, lowLevelAccess: module.lowLevelAccess })),
    );
}

async function runCommand(job: RunningJob, deps: GenerationRunnerDeps): Promise<void> {
    const command = job.command;
    if (command?.type === "button") {
        await runButton(job, deps, command.data);
        return;
    }
    if (command?.type === "manual") {
        await runManualTrigger(job, deps, command.name);
        return;
    }
    throw new GenerationRunnerError(400, "A command job needs a button or a manual trigger command");
}

/**
 * A Lua button (`runLuaButtonTrigger` of `src/ts/process/scriptings.ts`) as a command job: each Lua
 * trigger of the character and of its modules, in the client's order, runs `onButtonClick` with the
 * button's data on a fresh engine (no Lua global survives between runs), all under one aggregate
 * budget. A trigger stops the loop when the chat is gone. A load failure ends the job with its error
 * (the client's `doString` throws out of the loop), as do a spent budget and a worker failure; a
 * failure inside the handler is logged and the next trigger runs (the client's catch); a fatal host
 * failure (a write conflict, a lost owner, an abort) ends the job. `accepted` and `done` carry no
 * message.
 */
async function runButton(job: RunningJob, deps: GenerationRunnerDeps, data: string): Promise<void> {
    const { store } = deps;
    const { characterId, chatId } = job.context;
    const { scope, character, budget, runSignal, bindings } = prepare(job, deps);
    const triggers: triggerscript[] = [
        ...(character.triggerscript ?? []).map((trigger) => ({
            ...trigger,
            lowLevelAccess: character.lowLevelAccess ?? false,
        })),
        ...moduleTriggers(scope),
    ];
    for (const trigger of triggers) {
        if (job.signal.aborted) {
            return;
        }
        if (store.chatRevision(characterId, chatId) === null) {
            break;
        }
        const effect = trigger?.effect?.[0];
        if (effect?.type !== "triggerlua") {
            continue;
        }
        const result = await deps.scriptWorkers.runLua(
            {
                code: effect.code,
                mode: "onButtonClick",
                data,
                lowLevelAccess: !!trigger.lowLevelAccess,
                identity: {
                    characterId,
                    chatId,
                    presetId: scope.preset.id,
                    personaId: scope.effectivePersona.id,
                },
            },
            { host: bindings.host, signal: runSignal, budget },
        );
        const fatal = bindings.fatal();
        if (fatal) {
            throw fatal;
        }
        if (job.signal.aborted || result.aborted) {
            // The registry ends an aborted job with its abort's terminal.
            return;
        }
        if (result.error !== undefined) {
            // Only a failure inside the handler is the script's own (logged, as the client logs it);
            // a load failure, a spent budget, or a pool failure (no worker, a crash) ends the job.
            if (result.failedAt !== "dispatch" || result.timedOut) {
                throw new GenerationRunnerError(500, `Lua: ${result.error}`);
            }
            console.error("[Lua]", result.error);
        }
    }
    job.emit({ type: "done", revision: store.chatRevision(characterId, chatId) });
}

/**
 * A manual trigger (`risu-trigger` in `Chat.svelte`, `/trigger` from the chat input; Phase 5 slice
 * 8b) as a command job: the trigger runtime runs the chat's character's triggers named `name` (and
 * every Lua trigger, with the name as its Lua function) on a copy of the chat as stored, and the
 * copy is applied afterwards (`applyTriggerChat`), as the client's `captureChatBaseline`,
 * `runTrigger`, and `applyChatResult`. Chat variables, the author's note, character, and persona
 * effects are written as the run goes; `{{trigger_id}}` reads `context.triggerId`. A trigger error
 * (an invalid regex the client would throw on, a question not answered, the effect limit) ends the
 * job with it; a fatal host failure or an abort ends it as in a button.
 */
async function runManualTrigger(job: RunningJob, deps: GenerationRunnerDeps, name: string): Promise<void> {
    const { store, kinds } = deps;
    const { characterId, chatId } = job.context;
    const { scope, budget, runSignal, bindings, nativeCtx } = prepare(job, deps);
    const { services } = bindings;
    const charactersKind = kinds.get(RESOURCE_KIND.characters)!;
    const storedCharacter = () => store.get(charactersKind, characterId)?.data as character | groupChat | undefined;
    const effects = { count: 0 };
    const identity = nativeCtx.identity;

    const runLua = (code: string, options: { mode: string; lowLevelAccess: boolean; working: LuaWorkingCopy }) =>
        bindings.withWorking(options.working, async () => {
            const result = await deps.scriptWorkers.runLua(
                { code, mode: options.mode, lowLevelAccess: options.lowLevelAccess, identity },
                { host: bindings.host, signal: runSignal, budget },
            );
            const fatal = bindings.fatal();
            if (fatal) {
                throw fatal;
            }
            services.fence(nativeCtx);
            if (result.aborted) {
                throw services.latch(new LuaJobFatalError("request aborted"));
            }
            if (result.error !== undefined) {
                // A failure inside the handler is the script's own (logged, as `runScripted` catches
                // it); a load failure, a spent budget, or a pool failure ends the job.
                if (result.failedAt !== "dispatch" || result.timedOut) {
                    throw new GenerationRunnerError(500, `Lua: ${result.error}`);
                }
                console.error("[Lua]", result.error);
            }
            return { stopSending: result.stopSending };
        });

    /** `captureChatBaseline`, `runTrigger(…, "manual", …)`, and `applyChatResult` on the chat as stored now. */
    const runManual = async (triggerName: string) => {
        services.fence(nativeCtx);
        const owner = storedCharacter();
        if (!refreshChat(store, scope) || !owner || owner.type === "group") {
            return;
        }
        const baseline = { chat: structuredClone(scopeChat(scope)!), revision: scope.chatRevision };
        const result = await runtime.runTrigger(owner, "manual", {
            chat: baseline.chat,
            manualName: triggerName,
        });
        services.fence(nativeCtx);
        if (result) {
            applyTriggerChat({ job, store, scope, lock: deps.lock }, baseline, result.chat);
        }
    };

    const executor = createCommandExecutor({
        services,
        ctx: nativeCtx,
        character: storedCharacter,
        runManualTrigger: runManual,
    });
    const runtime = createTriggerRuntime({
        services,
        chatRef: { chaId: characterId, chatId },
        ctx: nativeCtx,
        observeCharacterPatches: (listener) => bindings.observeCharacterPatches(listener),
        runLua,
        moduleTriggers: () => moduleTriggers(scope),
        templateDefaultVariables: scope.db.templateDefaultVariables,
        selectedPersonaPrompt: scope.db.personaPrompt ?? "",
        effectivePersonaId: scope.effectivePersona.id ?? null,
        runCommand: (line) => executor.processMultiCommand(line),
        effects,
    });

    try {
        await runManual(name);
    } catch (error) {
        const fatal = bindings.fatal();
        if (fatal) {
            throw fatal;
        }
        if (job.signal.aborted || error instanceof GenerationRunnerError || error instanceof LuaJobFatalError) {
            throw error;
        }
        throw new GenerationRunnerError(500, `Trigger: ${error instanceof Error ? error.message : String(error)}`);
    }
    const fatal = bindings.fatal();
    if (fatal) {
        throw fatal;
    }
    services.fence(nativeCtx);
    job.emit({ type: "done", revision: store.chatRevision(characterId, chatId) });
}
