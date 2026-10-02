import type { character } from "../../../shared/database.ts";
import type { triggerscript } from "../../../shared/triggers.ts";
import { LuaJobFatalError } from "../lua/bindings.ts";
import { runPromptJob } from "../prompt/runner.ts";
import { type GenerationRunner, GenerationRunnerError, type RunningJob } from "./generationJobs.ts";
import { loadJobScope } from "./jobScope.ts";
import {
    createJobRunState,
    createRunSetup,
    type GenerationRunnerDeps,
    type JobRunState,
    moduleTriggers,
    type RunSetup,
} from "./runSetup.ts";

export type { GenerationRunnerDeps } from "./runSetup.ts";

/**
 * The server's generation runner (Phase 5): `command` jobs run here (buttons from slice 8a, manual
 * triggers from slice 8b); every other kind is a send, a continue, or a preview (slice 9,
 * `src/server/prompt/runner.ts`).
 */
export function createGenerationRunner(deps: GenerationRunnerDeps): GenerationRunner {
    return async (job) => {
        if (job.kind === "command") {
            await runCommand(job, deps);
            return;
        }
        await runPromptJob(job, deps);
    };
}

/**
 * Loads the job's scope and sends `accepted`; refuses a group chat (as `Chat.svelte` refuses
 * buttons and manual triggers) or a missing character; sets up the run on the chat's character.
 */
function prepare(
    job: RunningJob,
    deps: GenerationRunnerDeps,
): { setup: RunSetup; state: JobRunState; character: character } {
    const { characterId } = job.context;
    const scope = loadJobScope(deps.store, deps.kinds, job.context);
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
    const state = createJobRunState(job);
    // The chat screen's character, which owns the chat.
    const setup = createRunSetup(job, deps, state, scope, {
        runCharacterId: characterId,
        engineCharacterId: characterId,
    });
    return { setup, state, character: found };
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
    const { setup, state, character } = prepare(job, deps);
    const { scope, bindings } = setup;
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
            { host: bindings.host, signal: state.runSignal, budget: state.budget },
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
    const { characterId, chatId } = job.context;
    const { setup, character } = prepare(job, deps);
    try {
        await setup.runOnCopy(character, "manual", { manualName: name });
    } catch (error) {
        const fatal = setup.bindings.fatal();
        if (fatal) {
            throw fatal;
        }
        if (job.signal.aborted || error instanceof GenerationRunnerError || error instanceof LuaJobFatalError) {
            throw error;
        }
        throw new GenerationRunnerError(500, `Trigger: ${error instanceof Error ? error.message : String(error)}`);
    }
    setup.check();
    job.emit({ type: "done", revision: deps.store.chatRevision(characterId, chatId) });
}
