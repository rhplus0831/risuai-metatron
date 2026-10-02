import type { triggerscript } from "../../../shared/database.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { LlmRequests } from "../llm/requests.ts";
import { createLuaBindings } from "../lua/bindings.ts";
import type { TokenCounter } from "../prompt/tokens.ts";
import { createLuaBudget, type ScriptWorkerPool } from "../scripts/workerPool.ts";
import { jobModules } from "./cbsHost.ts";
import { type GenerationRunner, GenerationRunnerError, type RunningJob, unavailableRunner } from "./generationJobs.ts";
import { loadJobScope } from "./jobScope.ts";

export type GenerationRunnerDeps = {
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    rootDir: string;
    savePath: string;
    scriptWorkers: ScriptWorkerPool;
    llm: LlmRequests;
    tokens: TokenCounter;
};

/**
 * The server's generation runner (Phase 5): `command` jobs run here from slice 8a; every other kind
 * answers 501 until prompt assembly (slice 9).
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

/**
 * A Lua button (`runLuaButtonTrigger` of `src/ts/process/scriptings.ts`) as a command job: refused
 * in a group chat (as `Chat.svelte` refuses it), then each Lua trigger of the character (with the
 * character's `lowLevelAccess`) and of its modules (each with its module's), in the client's order,
 * runs `onButtonClick` with the button's data on a fresh engine (no Lua global survives between
 * runs), all under one aggregate budget. A trigger stops the loop when the chat is gone. A load
 * failure ends the job with its error (the client's `doString` throws out of the loop), as do a
 * spent budget and a worker failure; a failure inside the handler is logged and the next trigger
 * runs (the client's catch); a fatal host failure (a write conflict, a lost owner, an abort) ends
 * the job. `accepted` and `done` carry no message.
 */
async function runCommand(job: RunningJob, deps: GenerationRunnerDeps): Promise<void> {
    const command = job.command;
    if (!command || command.type !== "button") {
        throw new GenerationRunnerError(400, "A command job needs a button command");
    }
    const { store, kinds } = deps;
    const { characterId, chatId } = job.context;
    const scope = loadJobScope(store, kinds, job.context);
    job.emit({ type: "accepted", jobId: job.id, revision: scope.chatRevision, text: "" });

    const character = scope.db.characters.find((entry) => entry?.chaId === characterId);
    if (!character || character.type === "group") {
        throw new GenerationRunnerError(400, "Buttons do not run in a group chat");
    }
    const triggers: triggerscript[] = [
        ...(character.triggerscript ?? []).map((trigger) => ({
            ...trigger,
            lowLevelAccess: character.lowLevelAccess ?? false,
        })),
        ...jobModules(scope).flatMap((module) =>
            (module?.trigger ?? []).map((trigger) => ({ ...trigger, lowLevelAccess: module.lowLevelAccess })),
        ),
    ];

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
        // A button runs for the chat screen's character, which owns the chat.
        runCharacterId: characterId,
        engineCharacterId: characterId,
        onFatal: (error) => fatalAbort.abort(error),
    });
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
                data: command.data,
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
