import type { character } from "../../../shared/database.ts";
import type { GenerationCommand } from "../../../shared/jobs.ts";
import type { triggerscript } from "../../../shared/triggers.ts";
import { LuaJobFatalError } from "../lua/bindings.ts";
import { runPromptJob } from "../prompt/runner.ts";
import { localModelRefusal } from "../prompt/transformers.ts";
import {
    failureOf,
    type GenerationRunner,
    GenerationRunnerError,
    markFailure,
    type RunningJob,
} from "./generationJobs.ts";
import { admitProviderModels, flushChatMetadata, loadJobScope } from "./jobScope.ts";
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
 * The server's generation runner: `command` jobs run here (Lua buttons, forms, and manual triggers); every
 * other kind is a send, a continue, or a preview (`src/server/prompt/runner.ts`).
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
 * buttons, forms, and manual triggers) or a missing character; sets up the run on the chat's character.
 */
function prepare(
    job: RunningJob,
    deps: GenerationRunnerDeps,
): { setup: RunSetup; state: JobRunState; character: character } {
    try {
        return prepareRun(job, deps);
    } catch (error) {
        throw markFailure(error, { stage: "setup" });
    }
}

function prepareRun(
    job: RunningJob,
    deps: GenerationRunnerDeps,
): { setup: RunSetup; state: JobRunState; character: character } {
    const { characterId } = job.context;
    const scope = loadJobScope(deps.store, deps.kinds, job.context);
    admitProviderModels(scope, job.hooks.providers);
    job.emit({ type: "accepted", jobId: job.id, revision: scope.chatRevision, text: "" });

    const found = scope.db.characters.find((entry) => entry?.chaId === characterId);
    if (!found || found.type === "group") {
        throw new GenerationRunnerError(
            400,
            job.command?.type === "manual"
                ? "Manual triggers do not run in a group chat"
                : job.command?.type === "form"
                  ? "Forms do not run in a group chat"
                  : "Buttons do not run in a group chat",
        );
    }
    const state = createJobRunState(job, deps.scriptWorkers.createBudget());
    // The chat screen's character, which owns the chat.
    const setup = createRunSetup(job, deps, state, scope, {
        runCharacterId: characterId,
        engineCharacterId: characterId,
    });
    return { setup, state, character: found };
}

/**
 * A command job's failure names its stage: its setup (`prepare`), else the script it runs, unless
 * a site nearer the failure named one (a write, a request).
 */
async function runCommand(job: RunningJob, deps: GenerationRunnerDeps): Promise<void> {
    const command = job.command;
    if (command?.type !== "button" && command?.type !== "form" && command?.type !== "manual") {
        throw new GenerationRunnerError(400, "A command job needs a button, form, or manual trigger command", {
            stage: "setup",
        });
    }
    try {
        if (command.type === "button" || command.type === "form") {
            await runLuaInteractionTrigger(job, deps, command);
        } else {
            await runManualTrigger(job, deps, command.name);
        }
    } catch (error) {
        throw markFailure(error, { stage: "script" });
    }
}

/**
 * A Lua button or form as a command job: each Lua trigger of the character and of its modules, in
 * the client's order, runs `onButtonClick` with the button's data or `onFormSubmit` with the form's
 * key and values as metadata on a fresh engine (no Lua global survives between runs), all under one
 * aggregate budget. A trigger stops the loop when the chat is gone. A load failure ends the job with its error
 * (the client's `doString` throws out of the loop), as do a spent budget and a worker failure; a
 * failure inside the handler is logged and the next trigger runs (the client's catch); a fatal host
 * failure (a write conflict, a lost owner, an abort) ends the job. `accepted` and `done` carry no
 * message.
 */
async function runLuaInteractionTrigger(
    job: RunningJob,
    deps: GenerationRunnerDeps,
    command: Extract<GenerationCommand, { type: "button" | "form" }>,
): Promise<void> {
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
                mode: command.type === "button" ? "onButtonClick" : "onFormSubmit",
                data: command.type === "button" ? command.data : command.key,
                ...(command.type === "form" ? { meta: { data: command.values } } : {}),
                lowLevelAccess: !!trigger.lowLevelAccess,
                identity: {
                    characterId,
                    chatId,
                    presetId: scope.promptPreset.id,
                    personaId: scope.effectivePersona.id,
                },
            },
            { host: bindings.host, signal: state.runSignal, budget: state.budget },
        );
        flushChatMetadata(job);
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
    flushChatMetadata(job);
    job.emit({
        type: "done",
        revision: store.chatRevision(characterId, chatId),
        ...(state.followUps.length > 0 ? { followUps: state.followUps } : {}),
    });
}

/**
 * A manual trigger (`risu-trigger` in `Chat.svelte`, `/trigger` from the chat input) as a
 * command job: the trigger runtime runs the chat's character's triggers named `name` (and
 * every Lua trigger, with the name as its Lua function) on a copy of the chat as stored, and the
 * copy is applied afterwards (`applyTriggerChat`), as the client's `captureChatBaseline`,
 * `runTrigger`, and `applyChatResult`. Chat variables, the author's note, character, and persona
 * effects are written as the run goes; `{{trigger_id}}` reads `context.triggerId`. A trigger error
 * (an invalid regex the client would throw on, a question not answered, the effect limit) ends the
 * job with it; a fatal host failure or an abort ends it as in a button.
 */
async function runManualTrigger(job: RunningJob, deps: GenerationRunnerDeps, name: string): Promise<void> {
    const { characterId, chatId } = job.context;
    const { setup, state, character } = prepare(job, deps);
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
        const refusal = localModelRefusal(error);
        throw new GenerationRunnerError(
            refusal?.status ?? 500,
            refusal?.message ?? `Trigger: ${error instanceof Error ? error.message : String(error)}`,
            failureOf(error),
        );
    }
    setup.check();
    flushChatMetadata(job);
    job.emit({
        type: "done",
        revision: deps.store.chatRevision(characterId, chatId),
        ...(state.followUps.length > 0 ? { followUps: state.followUps } : {}),
    });
}
