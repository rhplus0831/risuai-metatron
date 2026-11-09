import { randomUUID } from "node:crypto";
import type { Chat, character } from "../../../shared/database.ts";
import type { GenerationCommand, SkippedHook } from "../../../shared/jobs.ts";
import type { triggerscript } from "../../../shared/triggers.ts";
import { LuaJobFatalError } from "../lua/bindings.ts";
import { runMemoryRebuild } from "../prompt/memory/structured/rebuild.ts";
import { runMemoryRecord } from "../prompt/memory/structured/recordJob.ts";
import { runMemoryTest } from "../prompt/memory/structured/testRun.ts";
import { runPromptJob, runPromptSend } from "../prompt/runner.ts";
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

/**
 * Dispatches generation jobs and runs command interactions under their one registry lifetime.
 * `/multisend` queued by `server/src/jobs/runSetup.ts` runs on the server after the interaction;
 * its parts keep one job id, chat slot, owner, hook set and channel. Each part delegates to
 * `server/src/prompt/runner.ts` runPromptSend, so parts without browser callbacks continue without
 * the page; a needed callback uses the channel's owner-absence rules.
 */

export type { GenerationRunnerDeps } from "./runSetup.ts";

/**
 * The server's generation runner: `command` jobs run here (Lua buttons, forms, and manual triggers),
 * but for a start of the memory writer (`recordJob.ts`), a test run of it (`testRun.ts`), or a chat's
 * rebuild (`rebuild.ts`); every other kind (a send, a continue, a reroll, a group chat's send, or a
 * preview) is a prompt job (`prompt/runner.ts` `runPromptJob`).
 */
export function createGenerationRunner(deps: GenerationRunnerDeps): GenerationRunner {
    return async (job) => {
        if (job.command?.type === "memoryRecord") {
            await runMemoryRecord(job, job.command.messageId, deps);
            return;
        }
        if (job.command?.type === "memoryTest") {
            await runMemoryTest(job, deps);
            return;
        }
        if (job.command?.type === "memoryRebuild") {
            await runMemoryRebuild(job, job.command, deps);
            return;
        }
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
 * aggregate budget. A trigger stops the loop when the chat is gone or Lua calls `stopChat`. A load failure
 * ends the job with its error (as the client's former `doString` threw out of the loop), as do a spent budget and a worker
 * failure; a failure inside the handler is logged and the next trigger runs (as the client's former
 * catch did); a fatal host failure (a write conflict, a lost owner, an abort) ends the job.
 * `accepted` carries no message; queued sequence parts run after the handlers and supply the final
 * reply when there is one.
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
        if (result.stopSending) {
            break;
        }
    }
    flushChatMetadata(job);
    await finishCommand(job, deps, state);
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
    await finishCommand(job, deps, state);
}

/**
 * Sends queued parts after a button, form or manual trigger, under the command's one lifetime.
 * `RunningJob.sequence.beginPart` in `server/src/jobs/generationJobs.ts` preflights each part
 * synchronously. With no await between it and the token-owned write, clear removes all messages
 * (omitted for an empty chat) and the user text is appended with a fresh id and no timestamp in
 * that one write; the owner receives the chat afterwards. A refused boundary writes nothing.
 *
 * Pending metadata is flushed before switching views. Each send view keeps registry methods and
 * the signal, drops the command/trigger/speaker/user/continue ids, and uses empty input (no input
 * trigger or editinput), fresh run state and script budget, carrying emotion history forward.
 * Each part has its own generation ids, reply locks, stages and request-history rows. Translations
 * and memory hand off before it returns; removed replies' locks release without ending the job.
 *
 * Progress updates memory and best-effort receipts before the first part (sent: 0) and after each
 * returned part, before the live-only sequence event: zero-based index, total, sent, optional
 * reply messageId. A removed reply counts as sent; a stopped send does not.
 * One done terminal carries sequence { total, sent, stopped? }: boundary refusals use their code,
 * a stopped send uses notSent. Throws and registry aborts retain error terminals with current
 * progress; the first abort wins. No queued parts means no sequence. The registry runs one
 * auto-checkpoint after a done sequence with an attempted part, after releasing the slot, never
 * between parts.
 */
async function finishCommand(job: RunningJob, deps: GenerationRunnerDeps, commandState: JobRunState): Promise<void> {
    const { characterId, chatId } = job.context;
    const parts = commandState.sequence.flatMap(({ clear, parts }) => parts.map((part) => ({ clear, part })));
    /** The command's own skipped reply hooks (a Lua request's), then each part's (its own state). */
    const skipped: SkippedHook[] = [...commandState.skippedHooks];
    const missed = [...commandState.missedHooks];
    if (parts.length === 0) {
        job.emit({
            type: "done",
            revision: deps.store.chatRevision(characterId, chatId),
            ...(skipped.length > 0 ? { skipped } : {}),
            ...(missed.length > 0 ? { missed } : {}),
        });
        return;
    }
    const sequence = job.sequence;
    if (!sequence) throw new Error("A command sequence needs a registry job");
    const total = parts.length;
    let sent = 0;
    let messageId: string | undefined;
    let previous = job;
    const finish = (stopped?: string) => {
        const chat = deps.store.readChatSource(characterId, chatId);
        const present =
            messageId && (chat.data as Chat | null)?.message.some((message) => message.chatId === messageId);
        job.emit({
            type: "done",
            revision: chat.revision,
            ...(present ? { messageId } : {}),
            sequence: { total, sent, ...(stopped ? { stopped } : {}) },
            ...(skipped.length > 0 ? { skipped } : {}),
            ...(missed.length > 0 ? { missed } : {}),
        });
    };
    sequence.progress({ total, sent });
    for (const [index, { clear, part }] of parts.entries()) {
        // Metadata belongs to the facade that queued it; no batch crosses into the next send's scope.
        flushChatMetadata(previous);
        job.setPendingFlush?.(null);
        const boundary = sequence.beginPart();
        if (!boundary.ok) {
            if (boundary.stopped) finish(boundary.stopped);
            return;
        }
        job.write(() => {
            const chat = deps.store.readChatSource(characterId, chatId);
            const ids = (chat.data as Chat).message.map((message) => message.chatId!);
            return {
                chats: [
                    {
                        characterId,
                        chatId,
                        baseRevision: chat.revision,
                        ops: [
                            ...(clear && ids.length > 0 ? [{ op: "remove" as const, ids }] : []),
                            {
                                op: "append",
                                messages: [{ role: "user", data: part, chatId: randomUUID() }],
                                anchor: { end: true },
                            },
                        ],
                    },
                ],
            };
        });
        job.emitRecords({ chats: [{ characterId, id: chatId }] });
        const { userMessageId, continueMessageId, triggerId, speakerChaId, ...context } = job.context;
        const send: RunningJob = {
            ...job,
            kind: "send",
            command: null,
            context: { ...context, input: "", mode: "send" },
        };
        const state = createJobRunState(send, deps.scriptWorkers.createBudget());
        state.emotions = commandState.emotions;
        previous = send;
        const result = await runPromptSend(send, deps, state);
        if (result.type !== "reply") throw new Error("A sequence send returned a preview");
        flushChatMetadata(send);
        sequence.releaseRemovedReplies();
        messageId = result.messageId;
        if (result.skipped) skipped.push(...result.skipped);
        if (result.missed) missed.push(...result.missed);
        if (!result.stopped) sent += 1;
        sequence.progress({ total, sent });
        job.emit({
            type: "sequence",
            index,
            total,
            sent,
            ...(messageId ? { messageId } : {}),
        });
        if (result.stopped) {
            finish("notSent");
            return;
        }
    }
    finish();
}
