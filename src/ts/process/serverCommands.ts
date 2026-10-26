import type { AnyClientCharacter } from "../storage/characterStore.svelte";
import {
    chatBinding,
    chatBindingProblems,
    chatBindingRefusalText,
    chatContextIds,
} from "../storage/chatBinding.svelte";
import type {
    GenerationCommand,
    GenerationContext,
    GenerationFollowUp,
    GenerationKind,
    GenerationTerminalEvent,
} from "../../../shared/jobs.ts";
import { language } from "src/lang";
import { writable } from "svelte/store";
import { alertError, alertJobError, alertToast } from "../alert";
import {
    abortGenerationJob,
    applyGenerationEvent,
    ChatBindingRefusedError,
    ChatLoreOverrideOrphanedError,
    createGenerationJob,
    followGenerationJob,
    type GenerationFollow,
    GenerationBusyError,
    readGenerationJob,
    releaseGenerationJob,
    savedGenerationJobIds,
} from "../network/generationJobs";
import { compareRevision } from "../../../shared/resources.ts";
import {
    type ChatRef,
    ensureChatLoaded,
    heldChatRevision,
    isChatStale,
    loadChat,
    markChatStale,
    pinChat,
} from "../storage/chatStore.svelte";
import { getResourceEpoch, ResourceRequestError } from "../storage/resourceClient";
import {
    flushResources,
    GenerationBlockedError,
    generatingNoticeCount,
    refreshStaleChat,
    watchForRestore,
} from "../storage/resourceSync.svelte";
import { sleep } from "../util";
import { recordClientEvent } from "../diagnostics/collector";
import { chatStatusKey as chatKeyOf, noteJobDone, noteJobLost } from "src/ts/process/chatStatus.svelte";
import { dropJobStage } from "./jobStages";
import { chatLoreOverrideRefusalText } from "./loreOverrides";

/**
 * How often a follow whose socket closed before the job's end attaches, and the wait before each
 * attach after the first (doubling, so a network still waking up gets about 15 s). The status reads
 * of `discover` and the chat loads of `loadJobChat` retry on the same schedule.
 */
const MAX_ATTACHES = 5;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
/** The longest a status read or the chat's read after a lost follow may take. */
const STEP_DEADLINE_MS = 10_000;

/** The wait before retry `attempt` (1-based). */
const retryDelay = (attempt: number) => RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1];

/**
 * How a follow ended: a terminal (`applied` when the socket delivered it through the events, else
 * read from the job's status: `kept` when it is the server's kept outcome of a collected job), a job
 * the server does not know (`"gone"`: collected long ago, the server restarted, another epoch), or
 * a server that could not be reached through every attach (`"lost"`).
 */
type FollowEnd = { terminal: GenerationTerminalEvent; applied: boolean; kept: boolean } | "gone" | "lost";

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A `language` message with the error's text in its `{0}` (a function replacer, so `$` patterns stay literal). */
function withError(message: string, error: unknown): string {
    return message.replace("{0}", () => errorText(error));
}

/**
 * The jobs whose `/multisend` follow-ups this tab has started: a job's are started once, however
 * often its terminal is seen. Kept for the tab's lifetime (only jobs that had follow-ups).
 */
const followedUp = new Set<string>();

/** The one lifecycle of each job this tab follows to its end, shared by every caller. */
const following = new Map<string, Promise<GenerationTerminalEvent | "lost">>();

/** The followed jobs whose chats are known, keyed by job id so overlapping follows stay visible. */
export const followedJobs = writable<ReadonlyMap<string, string>>(new Map());

/** The jobs this tab follows for a chat. */
export function followedJobsOf(jobs: ReadonlyMap<string, string>, ref: ChatRef): string[] {
    const key = chatKeyOf(ref);
    const ids: string[] = [];
    for (const [jobId, chatKey] of jobs) {
        if (chatKey === key) {
            ids.push(jobId);
        }
    }
    return ids;
}

/**
 * Follows a job until its end, once per job however many callers ask (a button, a busy job of this
 * tab, the boot resume): the lifecycle is reserved before anything else, so only it discovers the
 * job, retries, reports, and releases. Without `ref` (the boot resume) it reads the job's status
 * first to learn its chat, retrying a failed read; a job the server does not know (or of another
 * epoch) is released. Every event is applied to the chat and the channel (the follow is the
 * channel's transport). A socket that closes before the end attaches again, a bounded number of
 * times with growing waits, without creating the job again; the job's status is read after every
 * such close: a failed read is retried; a job that ended meanwhile and is still live is attached
 * again too (its attach sends its final records and its terminal); the server's kept outcome of a
 * collected job is its end, applied as the socket's terminal would be (as is the last ended status
 * read when the attaches ran out). The end is reported once: an error terminal as it is when
 * watched live, a server that stayed unreachable as `serverJob.lost`. A job the server no longer
 * knows shows no alert: its chat is read again, then `serverJob.endedAway`. After a lost or gone
 * follow, and after an end from the status that this tab's copy may lack, the chat is marked stale
 * and read again (`recoverJobChat`). Returns the terminal event, or `"lost"` (also for a gone job:
 * its outcome is unknown); a lost job is released as its end would release it. The job's chat is
 * pinned and loaded before the follow attaches (a load that keeps failing makes the job lost) and
 * stays pinned through every reconnect, the terminal's hydration, and the chat's read again, so no
 * event of the job finds its chat evicted.
 */
export function followJobToEnd(jobId: string, ref?: ChatRef): Promise<GenerationTerminalEvent | "lost"> {
    let shared = following.get(jobId);
    if (!shared) {
        shared = (async () => {
            let release: (() => void) | null = ref ? pinChat(ref) : null;
            try {
                const discovered = ref ?? (await discover(jobId));
                if (discovered === "gone") {
                    // No chat known (the boot resume): the page has just read its data.
                    recordClientEvent({ kind: "jobLink", phase: "gone", jobId });
                    releaseGenerationJob(jobId);
                    return "lost";
                }
                const target: ChatRef | "lost" = discovered;
                if (target !== "lost") {
                    const key = chatKeyOf(target);
                    followedJobs.update((jobs) => new Map(jobs).set(jobId, key));
                    release ??= pinChat(target);
                }
                const result: FollowEnd =
                    target === "lost" || !(await loadJobChat(target)) ? "lost" : await followOnce(jobId, target);
                const end = typeof result === "string" ? "lost" : result.terminal;
                if (typeof result === "string") {
                    recordClientEvent({ kind: "jobLink", phase: result, jobId });
                    releaseGenerationJob(jobId);
                } else if (!result.applied) {
                    if (result.kept) {
                        recordClientEvent({ kind: "jobLink", phase: "kept", jobId });
                    }
                    // Released as the socket's terminal releases the job (its locks, channel, saved job).
                    applyGenerationEvent(jobId, target as ChatRef, result.terminal);
                }
                if (result !== "gone") {
                    reportEnd(end, jobId);
                }
                if (target !== "lost") {
                    if (end === "lost") {
                        noteJobLost(target, jobId);
                    } else {
                        noteJobDone(target, end);
                    }
                }
                // Before the follow-ups: they clear and append on the chat as the job left it, so a
                // chat this tab could not read again runs none of them.
                const current =
                    target === "lost" ||
                    !needsChatRead(result, target) ||
                    (await recoverJobChat(target, jobId, typeof result === "string" ? result : "outcome"));
                if (end !== "lost" && end.type === "done" && target !== "lost" && !followedUp.has(jobId)) {
                    if (end.followUpsDropped || (end.followUps?.length && !current)) {
                        // A kept outcome whose `/multisend` parts were too large to keep, or whose chat
                        // could not be read again: none is sent.
                        followedUp.add(jobId);
                        alertError(language.serverJob.followUpsNotRun);
                    } else if (end.followUps?.length) {
                        // `/multisend` of a command job: sent now, once per job in this tab (a job
                        // followed again later gets the same terminal), not awaited by the job's
                        // caller. A reload meanwhile drops what is left.
                        followedUp.add(jobId);
                        // Pinned before the follow-ups' first await (this follow's pin ends below).
                        const followUpRelease = pinChat(target);
                        void runFollowUps(target, end.followUps)
                            .catch((error) => console.error("[Generation]", error))
                            .finally(followUpRelease);
                    }
                }
                return end;
            } finally {
                following.delete(jobId);
                followedJobs.update((jobs) => {
                    const next = new Map(jobs);
                    next.delete(jobId);
                    return next;
                });
                dropJobStage(jobId);
                release?.();
            }
        })();
        following.set(jobId, shared);
    }
    return shared;
}

/**
 * Whether the job's chat is read again after the follow: always after a lost or gone follow (the
 * job may have written anything); after an end read from the status (the socket's final chat
 * hydration never came), for an error (it carries no revision, and an abort keeps the text so far)
 * or a done whose revision is newer than the one this tab holds.
 */
function needsChatRead(result: FollowEnd, ref: ChatRef): boolean {
    if (typeof result === "string") {
        return true;
    }
    if (result.applied) {
        return false;
    }
    const { terminal } = result;
    if (terminal.type === "error") {
        return true;
    }
    if (terminal.revision === null) {
        return false;
    }
    const held = heldChatRevision(ref);
    return held === null || (compareRevision(terminal.revision, held) ?? 1) > 0;
}

/** The chat reads after a follow that have not ended, one per chat: chat key → its end (a newer one ends it). */
const recoveries = new Map<string, () => void>();

/**
 * Reads a followed job's chat again (the caller pinned it): it is marked stale, whether or not the
 * job still locked anything in it, and read through the idle refresh's rules (`refreshStaleChat`: no
 * local work, the epoch and revision fences), within `STEP_DEADLINE_MS`. Resolves true when the chat
 * is current within that time. After a lost or gone follow a read that took is recorded
 * (`recovered`), and a gone job then shows `serverJob.endedAway`. A read that did not take (offline,
 * local work, a read past the deadline) is tried once more, at the next `visibilitychange` to visible
 * or `online` (one listener pair); a chat whose stale mark is gone by then was read another way, and
 * nothing more is done. A read past the deadline still counts when it takes. One recovery per chat:
 * a newer one ends the older, whose late results and listeners then do nothing. A chat this tab does
 * not hold (it could not be loaded) is not read: its next load reads it whole.
 */
async function recoverJobChat(ref: ChatRef, jobId: string, after: "lost" | "gone" | "outcome"): Promise<boolean> {
    const key = chatKeyOf(ref);
    recoveries.get(key)?.();
    if (!markChatStale(ref)) {
        return false;
    }
    let active = true;
    const removeListeners = () => {
        document.removeEventListener("visibilitychange", retry);
        window.removeEventListener("online", retry);
    };
    const end = () => {
        active = false;
        removeListeners();
        if (recoveries.get(key) === end) {
            recoveries.delete(key);
        }
    };
    recoveries.set(key, end);
    const recovered = () => {
        if (!active) {
            return;
        }
        end();
        if (after !== "outcome") {
            recordClientEvent({ kind: "jobLink", phase: "recovered", jobId });
        }
        if (after === "gone") {
            alertToast(language.serverJob.endedAway);
            recordClientEvent({ kind: "notice", notice: "serverJobEndedAway" });
        }
    };
    const refresh = () =>
        refreshStaleChat(ref).catch((error) => {
            console.error("[Generation]", error);
            return false;
        });
    const retry = () => {
        if (document.visibilityState !== "visible") {
            return;
        }
        removeListeners();
        if (!active) {
            return;
        }
        if (!isChatStale(ref)) {
            end();
            return;
        }
        void refresh().then((current) => (current ? recovered() : end()));
    };
    const read = refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inTime = await Promise.race([
        read,
        new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), STEP_DEADLINE_MS);
        }),
    ]);
    clearTimeout(timer);
    if (!active) {
        return false;
    }
    if (inTime) {
        recovered();
        return true;
    }
    if (inTime === null) {
        void read.then((current) => current && recovered());
    }
    document.addEventListener("visibilitychange", retry);
    window.addEventListener("online", retry);
    return false;
}

/**
 * The job's chat, loaded (the caller pinned it): a failed read is retried like `discover`; false when
 * it is gone or could not be loaded.
 */
async function loadJobChat(ref: ChatRef): Promise<boolean> {
    for (let read = 0; read < MAX_ATTACHES; read++) {
        if (read > 0) {
            await sleep(retryDelay(read));
        }
        try {
            return (await ensureChatLoaded(ref)) !== undefined;
        } catch (error) {
            console.error("[Generation]", error);
        }
    }
    return false;
}

/** The parts a command job's `/multisend` queued, sent as the tab's own `/multisend` sends them (the caller pinned the chat). */
async function runFollowUps(ref: ChatRef, followUps: readonly GenerationFollowUp[]): Promise<void> {
    const { runMultisend } = await import("./command");
    if (!(await ensureChatLoaded(ref))) {
        return;
    }
    for (const followUp of followUps) {
        if (!(await runMultisend(ref, followUp.clear, followUp.parts))) {
            return;
        }
    }
}

/**
 * The chat of a saved job from its status: `"gone"` when the server does not know it, `"lost"` after
 * the retries (each read bounded by `STEP_DEADLINE_MS`).
 */
async function discover(jobId: string): Promise<ChatRef | "gone" | "lost"> {
    for (let read = 0; read < MAX_ATTACHES; read++) {
        if (read > 0) {
            await sleep(retryDelay(read));
        }
        let status;
        try {
            status = await readGenerationJob(jobId, { deadlineMs: STEP_DEADLINE_MS });
        } catch (error) {
            console.error("[Generation]", error);
            continue;
        }
        if (!status || status.epoch !== getResourceEpoch()) {
            return "gone";
        }
        return { chaId: status.characterId, chatId: status.chatId };
    }
    return "lost";
}

/**
 * One follow of a job to its end through at most `MAX_ATTACHES` attaches. The transport gives up an
 * attach whose socket does not open within 10 s, or that goes silent (`followGenerationJob`). An
 * opened socket the transport replaced because the page came back (`resumed`) is not counted and
 * the next attach does not wait: only failed links spend the budget. After every close without the
 * terminal the job's status is read (bounded by `STEP_DEADLINE_MS`): a failed read attaches again
 * (the server may be out of reach), a job the server does not know is `"gone"`, its kept outcome is
 * the end, and a job still running or ended but still live is attached again. When the attaches run
 * out, or the job is no longer known after an ended status was read, the terminal of the last ended
 * status read is the end, if there was one; `"lost"` (or `"gone"`) otherwise.
 */
async function followOnce(jobId: string, ref: ChatRef): Promise<FollowEnd> {
    let known: GenerationTerminalEvent | null = null;
    // Attaches counted against the budget, and whether the last socket was replaced on the page's return.
    let attach = 0;
    let resumed = false;
    while (attach < MAX_ATTACHES) {
        if (attach > 0 || resumed) {
            if (!resumed) {
                await sleep(retryDelay(attach));
            }
            recordClientEvent({ kind: "jobLink", phase: "reattach", jobId, attempt: attach });
        }
        const follow: GenerationFollow = followGenerationJob(jobId, (event) =>
            applyGenerationEvent(jobId, ref, event, follow),
        );
        const closed = await follow.closed;
        if (closed.terminal) {
            return { terminal: closed.terminal, applied: true, kept: false };
        }
        resumed = closed.resumed === true;
        if (!resumed) {
            attach += 1;
        }
        let status;
        try {
            status = await readGenerationJob(jobId, { deadlineMs: STEP_DEADLINE_MS });
        } catch {
            // A failed read (the network, the server restarting): attach again.
            continue;
        }
        if (!status) {
            // Not known any more (the server restarted meanwhile): an end an earlier read named stands.
            return known && known.epoch === getResourceEpoch()
                ? { terminal: known, applied: false, kept: false }
                : "gone";
        }
        if (status.epoch !== getResourceEpoch()) {
            return "gone";
        }
        if (status.kept && status.terminal) {
            return { terminal: status.terminal, applied: false, kept: true };
        }
        known = status.state === "ended" ? (status.terminal ?? null) : null;
    }
    return known ? { terminal: known, applied: false, kept: false } : "lost";
}

/**
 * What the tab shows at a server job's end: its error, or that it was lost. A job a restore or
 * import ended (`maintenance`) shows the restore notice once the data is replaced
 * (`watchForRestore`), or its error when nothing was replaced.
 */
function reportEnd(end: GenerationTerminalEvent | "lost", jobId: string) {
    if (end === "lost") {
        alertError(language.serverJob.lost);
        recordClientEvent({ kind: "notice", notice: "serverJobLost" });
    } else if (end.type === "error" && end.reason === "maintenance") {
        // The debug info's time is the end's, not the alert's (the restore watch may take minutes).
        const at = Date.now();
        void watchForRestore().then((restored) => {
            if (!restored) {
                alertJobError(jobId, end, at);
            }
        });
    } else if (end.type === "error" && end.reason !== "aborted") {
        alertJobError(jobId, end);
    }
}

/** Attaches again to this tab's saved server jobs after a reload, each through its one lifecycle. */
export async function resumeServerJobs(): Promise<void> {
    await Promise.all(
        savedGenerationJobIds().map((jobId) => {
            recordClientEvent({ kind: "jobLink", phase: "resume", jobId });
            return followJobToEnd(jobId);
        }),
    );
}

/**
 * How a server job ended for the caller: it ran (`started`), this tab's busy job (another action) was
 * followed instead, it did not run (`refused`), or the create request failed without an answer, so it
 * may have run (`unknown`).
 */
export type ServerCommandOutcome = "started" | "followed" | "refused" | "unknown";

/** What a server job runs as, for its refusal alerts: a send (every send kind), a Lua button, or a manual trigger. */
export type ServerJobLabel = "send" | "button" | "trigger";

/** What a server job of this tab runs: its kind, its command, and the context fields of the caller. */
export type ServerJobRequest = {
    kind: GenerationKind;
    command?: GenerationCommand;
    /** What did not run, for the refusal alert (`language.serverJob.discarded`). */
    label: ServerJobLabel;
    context?: Partial<Pick<GenerationContext, "mode" | "input" | "userMessageId" | "continueMessageId" | "triggerId">>;
};

/**
 * A server job of this tab: the target and the settings ids are taken before the first await, from
 * the chat's binding (`identity` gives a plugin call's own captured ids). A chat whose binding is
 * not complete runs nothing (the problems are shown), never the tab's selection; the server refuses
 * it too (409, shown the same way). Every pending write is saved first (a refused or a discarding
 * flush runs nothing), then the job runs and its events are applied until it ends. Its chat and
 * record changes arrive as the server's records; its alerts and questions through the job's
 * channel. An error ends with `alertError`. `onStart` runs once the job exists, before it is
 * followed. `signal` aborts the job (`DELETE`), also when it fires while the job is being created,
 * and the busy job of this tab followed instead; an abort before the flush ends runs nothing. The
 * target chat is pinned from the start until the follow ends and is loaded before the job is
 * created (a failed load runs nothing). A flush refused for a generation gives the chats it waited on
 * (`blockedChats`); a create refused for another tab's job gives the target.
 */
export async function runServerJob(
    char: AnyClientCharacter,
    ref: ChatRef | null,
    request: ServerJobRequest,
    options: ServerJobOptions = {},
): Promise<ServerJobResult> {
    if (!ref) {
        return { outcome: "refused", terminal: null };
    }
    const release = pinChat(ref);
    try {
        return await runPinnedServerJob(char, ref, request, options);
    } finally {
        release();
    }
}

type ServerJobResult = {
    outcome: ServerCommandOutcome;
    terminal: GenerationTerminalEvent | "lost" | null;
    blockedChats?: readonly ChatRef[];
};

type ServerJobOptions = {
    onStart?: () => void;
    signal?: AbortSignal;
    identity?: { presetId: string | null; modelPresetId: string | null; personaId: string | null };
};

async function runPinnedServerJob(
    char: AnyClientCharacter,
    ref: ChatRef,
    request: ServerJobRequest,
    options: ServerJobOptions,
): Promise<ServerJobResult> {
    const refused = { outcome: "refused" as const, terminal: null };
    // The send guard: every job of a chat (send, continue, reroll, group, preview, command) runs on
    // the chat's complete binding or not at all.
    const binding = chatBinding(ref);
    if (!binding?.ok) {
        alertError(chatBindingRefusalText(chatBindingProblems(binding)));
        return refused;
    }
    const { presetId, modelPresetId, personaId } = options.identity ?? chatContextIds(binding.ids);
    const client = {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        browserLanguage: navigator.language,
    };
    const notices = generatingNoticeCount();
    // Saved first; then a chat this tab knows is behind the server (a job's chat patch that did not
    // fit, a stale acknowledgement, a live notice) is read whole, so the job is not created on its
    // old revision. A change made while that read was in flight is saved and the read tried once
    // more; a chat still behind then goes as it is, and the server refuses its old revision.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { discarded } = await flushResources();
            if (discarded.length > 0) {
                alertError(language.serverJob.discarded[request.label]);
                return refused;
            }
        } catch (error) {
            if (error instanceof GenerationBlockedError) {
                // The chat or character is being generated (another tab's job): the same notice as a
                // busy chat, unless this flush's conflict recovery has just shown it.
                if (generatingNoticeCount() === notices) {
                    alertError(language.chatGenerating);
                }
                return { ...refused, blockedChats: error.chats };
            }
            alertError(withError(language.serverJob.saveFailed, error));
            return refused;
        }
        let current: boolean;
        try {
            current = await refreshStaleChat(ref);
        } catch (error) {
            alertError(withError(language.serverJob.chatLoadFailed, error));
            return refused;
        }
        if (current) {
            break;
        }
    }
    let target;
    try {
        target = await ensureChatLoaded(ref);
    } catch (error) {
        alertError(withError(language.serverJob.chatLoadFailed, error));
        return refused;
    }
    if (!target || options.signal?.aborted) {
        return refused;
    }
    const chatRevision = heldChatRevision(ref);
    if (chatRevision === null) {
        alertError(language.serverJob.chatNotSaved);
        return refused;
    }
    let jobId: string;
    let outcome: "started" | "followed" = "started";
    try {
        jobId = await createGenerationJob({
            kind: request.kind,
            context: {
                characterId: ref.chaId,
                chatId: ref.chatId,
                presetId,
                modelPresetId,
                personaId,
                mode: request.kind,
                input: "",
                chatRevision,
                client,
                ...request.context,
            },
            ...(request.command ? { command: request.command } : {}),
        } as Parameters<typeof createGenerationJob>[0]);
    } catch (error) {
        if (error instanceof ChatBindingRefusedError) {
            if (error.code === "chatBindingMismatch") {
                // The server holds a newer binding than this tab: read the chat again, and the user sends again.
                void loadChat(ref).catch((loadError) => console.error("[Generation]", loadError));
                alertError(language.chatBinding.mismatch);
            } else {
                alertError(chatBindingRefusalText(error.problems));
            }
            return refused;
        }
        if (error instanceof ChatLoreOverrideOrphanedError) {
            alertError(chatLoreOverrideRefusalText(error.entries));
            return refused;
        }
        if (error instanceof GenerationBusyError) {
            // This tab's own job (one a reload lost track of): follow it instead; another's is busy.
            const owned = await readGenerationJob(error.jobId, { deadlineMs: STEP_DEADLINE_MS }).catch(() => null);
            if (!owned) {
                alertError(language.chatGenerating);
                // Another tab's job runs in this chat, with or without a lock this tab knows of yet.
                return { ...refused, blockedChats: [ref] };
            }
            jobId = error.jobId;
            outcome = "followed";
        } else {
            alertError(errorText(error));
            // No answer (the network, or a body that did not arrive whole): the job may exist.
            const unanswered = !(error instanceof ResourceRequestError) || error.status === 0;
            return { outcome: unanswered ? "unknown" : "refused", terminal: null };
        }
    }
    const onAbort = () => {
        void abortGenerationJob(jobId).catch((error) => console.error("[Generation]", error));
    };
    if (options.signal?.aborted) {
        onAbort();
    } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    try {
        if (outcome === "started") {
            try {
                options.onStart?.();
            } catch (error) {
                // The job runs anyway: it is still followed to its end, which releases what this tab
                // holds for it (a plugin reload waits for a job that is never released).
                void followJobToEnd(jobId, ref).catch((followError) => console.error("[Generation]", followError));
                throw error;
            }
        }
        const terminal = await followJobToEnd(jobId, ref);
        return { outcome, terminal };
    } finally {
        options.signal?.removeEventListener("abort", onAbort);
    }
}

/**
 * A command job: `runServerJob` with the command; a group chat refuses it.
 */
async function runServerCommand(
    char: AnyClientCharacter,
    command: GenerationCommand,
    ref: ChatRef | null,
    options: { triggerId?: string; onStart?: () => void } = {},
): Promise<ServerCommandOutcome> {
    if (!ref || char.type === "group") {
        return "refused";
    }
    const { outcome } = await runServerJob(
        char,
        ref,
        {
            kind: "command",
            command,
            label: commandLabel(command),
            context: {
                mode: command.type === "button" ? "button" : "manual",
                ...(options.triggerId ? { triggerId: options.triggerId } : {}),
            },
        },
        { onStart: options.onStart },
    );
    return outcome;
}

function commandLabel(command: GenerationCommand): ServerJobLabel {
    return command.type === "button" ? "button" : "trigger";
}

/** A Lua button (`risu-btn`) run by the server. */
export async function runServerButton(
    char: AnyClientCharacter,
    data: string,
    ref: ChatRef | null,
): Promise<ServerCommandOutcome> {
    return await runServerCommand(char, { type: "button", data }, ref);
}

/**
 * A manual trigger (`risu-trigger`, `/trigger`) run by the server: its `risu-id` is the job's
 * `triggerId` (`{{trigger_id}}`). `onStart` runs once the job exists.
 */
export async function runServerManualTrigger(
    char: AnyClientCharacter,
    name: string,
    ref: ChatRef | null,
    options: { triggerId?: string; onStart?: () => void } = {},
): Promise<ServerCommandOutcome> {
    return await runServerCommand(char, { type: "manual", name }, ref, options);
}
