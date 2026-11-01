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
    GenerationKind,
    GenerationTerminalEvent,
    GenerationStatus,
} from "../../../shared/jobs.ts";
import { language } from "src/lang";
import { get, writable } from "svelte/store";
import { alertConfirm, alertError, alertJobError, alertToast } from "../alert";
import {
    abortGenerationJob,
    applyGenerationEvent,
    ChatBindingRefusedError,
    ChatLoreOverrideOrphanedError,
    createGenerationJob,
    cancelGenerationRequest,
    GenerationCreateError,
    GenerationStaleError,
    type GenerationCreateResult,
    followGenerationJob,
    type GenerationFollow,
    GenerationBusyError,
    readGenerationJob,
    readChatGeneration,
    stopChatGeneration,
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
import { getResourceEpoch, ResourceEpochMismatchError, ResourceRequestError } from "../storage/resourceClient";
import {
    flushResources,
    GenerationBlockedError,
    generatingNoticeCount,
    refusedItems,
    refreshStaleChat,
    watchForRestore,
} from "../storage/resourceSync.svelte";
import { sleep } from "../util";
import { recordClientEvent } from "../diagnostics/collector";
import {
    chatStatusKey as chatKeyOf,
    noteJobDone,
    noteJobLost,
    noteForeignJob,
    clearForeignJob,
} from "src/ts/process/chatStatus.svelte";
import { installReplyAlternatives } from "./serverGeneration";
import { incrementStatic } from "../storage/collectionStore.svelte";
import { dropJobStage } from "./jobStages";
import { chatLoreOverrideRefusalText } from "./loreOverrides";

/**
 * How many attaches a follow whose socket closed before the job's end may spend on a server it
 * cannot reach, and the wait before each attach after the first (doubling, so a network still waking
 * up gets about 15 s). A socket that delivered a frame reached the server and starts the count
 * again; a close while the page is hidden or the browser is offline spends nothing (`followOnce`).
 * The status reads of `discover` and the chat loads of `loadJobChat` retry on the same schedule.
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

/** The one lifecycle of each job this tab follows to its end, shared by every caller. */
const following = new Map<string, Promise<GenerationTerminalEvent | "lost">>();
const replayedStatuses = new Map<string, GenerationStatus>();

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

const stoppingChats = new Set<string>();

/** Names the current job before stopping it; each changed job requires its own confirmation. */
export async function stopChatJob(ref: ChatRef): Promise<void> {
    ref = { ...ref };
    const key = chatKeyOf(ref);
    if (stoppingChats.has(key)) return;
    stoppingChats.add(key);
    try {
        for (;;) {
            const current = await readChatGeneration(ref);
            if (!current) {
                clearForeignJob(ref);
                alertToast(language.serverJob.stopOther.idle);
                return;
            }
            if (current.owned || get(followedJobs).has(current.jobId)) clearForeignJob(ref);
            else noteForeignJob(ref, current.jobId);
            const text = language.serverJob.stopOther;
            const progress = current.sequence;
            const sequence = progress
                ? text.sequence.replace(/\{(part|total)\}/g, (_, field: "part" | "total") =>
                      String(
                          {
                              part: Math.min(progress.sent + 1, progress.total),
                              total: progress.total,
                          }[field],
                      ),
                  )
                : "";
            const confirm = text.confirm.replace(
                /\{(kind|stage|sequence)\}/g,
                (_, field: "kind" | "stage" | "sequence") =>
                    ({
                        kind: text.kinds[current.kind],
                        stage: current.stage ? text.stages[current.stage] : text.running,
                        sequence,
                    })[field],
            );
            if (!(await alertConfirm(confirm))) return;
            const result = await stopChatGeneration(ref, current.jobId);
            if (result === "idle") clearForeignJob(ref, current.jobId);
            if (result !== "changed") return;
        }
    } catch (error) {
        alertError(errorText(error));
    } finally {
        stoppingChats.delete(key);
    }
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
 * read when the attaches ran out, the boot resume's first read included). The end is reported once:
 * an error terminal as it is when watched live, a server that stayed unreachable as
 * `serverJob.lost`. A job the server no longer knows shows no alert: its chat is read again, then
 * `serverJob.endedAway`. After a lost or gone follow, and after an end from the status that this
 * tab's copy may lack, the chat is marked stale and read again (`recoverJobChat`). Returns the terminal event, or `"lost"` (also for a gone job:
 * its outcome is unknown); a lost job is released as its end would release it. The job's chat is
 * pinned and loaded before the follow attaches (a load that keeps failing makes the job lost) and
 * stays pinned through every reconnect, the terminal's hydration, and the chat's read again, so no
 * event of the job finds its chat evicted.
 */
export function followJobToEnd(
    jobId: string,
    ref?: ChatRef,
    initialStatus?: GenerationStatus,
): Promise<GenerationTerminalEvent | "lost"> {
    if (initialStatus?.state === "ended" && initialStatus.terminal) replayedStatuses.set(jobId, initialStatus);
    let shared = following.get(jobId);
    if (!shared) {
        shared = (async () => {
            let release: (() => void) | null = ref ? pinChat(ref) : null;
            try {
                const discovered = ref ? { ref, status: undefined } : await discover(jobId);
                if (discovered === "gone") {
                    // No chat known (the boot resume): the page has just read its data.
                    recordClientEvent({ kind: "jobLink", phase: "gone", jobId });
                    releaseGenerationJob(jobId);
                    return "lost";
                }
                const target: ChatRef | "lost" = discovered === "lost" ? "lost" : discovered.ref;
                if (target !== "lost") {
                    const key = chatKeyOf(target);
                    clearForeignJob(target);
                    followedJobs.update((jobs) => new Map(jobs).set(jobId, key));
                    release ??= pinChat(target);
                }
                // A terminal already received is authoritative even if the chat cannot be loaded.
                const loaded = target !== "lost" && (replayedStatuses.has(jobId) || (await loadJobChat(target)));
                const replay = replayedStatuses.get(jobId);
                // Discovery's ended status stands, as a replay does, when the chat cannot be loaded.
                const read = discovered === "lost" ? undefined : discovered.status;
                let result: FollowEnd = replay?.terminal
                    ? { terminal: replay.terminal, applied: false, kept: replay.kept === true }
                    : !loaded
                      ? read?.state === "ended" && read.terminal
                          ? { terminal: read.terminal, applied: false, kept: read.kept === true }
                          : "lost"
                      : await followOnce(jobId, target as ChatRef, read);
                if (typeof result === "string") {
                    // Another caller may have registered an ended replay while followOnce was awaiting the network.
                    const replayAfterFollow = replayedStatuses.get(jobId);
                    if (replayAfterFollow?.terminal) {
                        result = {
                            terminal: replayAfterFollow.terminal,
                            applied: false,
                            kept: replayAfterFollow.kept === true,
                        };
                    }
                }
                const end = typeof result === "string" ? "lost" : result.terminal;
                if (typeof result === "string") {
                    recordClientEvent({ kind: "jobLink", phase: result, jobId });
                    releaseGenerationJob(jobId);
                    // No longer a follow that covers its chat: a completion push for the chat during
                    // the read below must read it again (`refreshChatAfterPush`).
                    followedJobs.update((jobs) => {
                        const next = new Map(jobs);
                        next.delete(jobId);
                        return next;
                    });
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
                if (target !== "lost" && (replayedStatuses.has(jobId) || needsChatRead(result, target))) {
                    await recoverJobChat(target, jobId, typeof result === "string" ? result : "outcome");
                }
                return end;
            } finally {
                following.delete(jobId);
                replayedStatuses.delete(jobId);
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

/** The recovery reads out per chat (`readRecoveringChat`), by chat key. */
const chatReads = new Map<string, Promise<boolean>>();

/**
 * One recovery read of a chat (`refreshStaleChat`), after the chat's earlier recovery read has
 * settled: the chat is marked stale again right before it, since the earlier read's copy may have
 * taken meanwhile (an ended recovery's read still writes the mirror) and cleared the mark this read
 * needs (`finishIdleChatRefresh` adopts only a stale or noticed chat). Reads of one chat therefore
 * never overlap, and the newest always sees the server's newest copy. A read that throws is false.
 */
function readRecoveringChat(ref: ChatRef): Promise<boolean> {
    const key = chatKeyOf(ref);
    const previous = chatReads.get(key) ?? Promise.resolve(false);
    const read = previous.then(async () => {
        if (!markChatStale(ref)) {
            return false;
        }
        try {
            return await refreshStaleChat(ref);
        } catch (error) {
            console.error("[Generation]", error);
            return false;
        }
    });
    chatReads.set(key, read);
    void read.finally(() => {
        if (chatReads.get(key) === read) {
            chatReads.delete(key);
        }
    });
    return read;
}

/**
 * Reads a followed job's chat again (the caller pinned it): it is marked stale, whether or not the
 * job still locked anything in it, and read through the idle refresh's rules (`refreshStaleChat`: no
 * local work, the epoch and revision fences), within `STEP_DEADLINE_MS`. Resolves true when the chat
 * is current within that time. After a lost or gone follow a read that took is recorded
 * (`recovered`), and a gone job then shows `serverJob.endedAway`. A read that did not take (offline,
 * local work, a read past the deadline) is tried once more, at the next `visibilitychange` to visible
 * or `online` (one listener pair); a chat whose stale mark is gone by then was read another way, and
 * nothing more is done. A read past the deadline still counts when it takes. One recovery per chat:
 * a newer one ends the older, whose late results and listeners then report nothing; the reads
 * themselves run one at a time per chat (`readRecoveringChat`), the newer after the older's copy has
 * settled. A chat this tab does not hold (it could not be loaded) is not read: its next load reads
 * it whole.
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
    const refresh = () => readRecoveringChat(ref);
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
 * Reads a chat again, as a lost chat is read: for a lost chat that is viewed (`chatStatus.svelte.ts`
 * clears its recovery mark, which `serverJob.lost` asks the user to do) and for a completion push
 * (`refreshChatAfterPush`), since the lost job may have been writing still (the server was out of
 * reach, not stopped). One serialized recovery read (`readRecoveringChat`), pinned for at most the
 * step deadline; a read that did not take leaves the stale mark to the idle refresh. It is not a
 * recovery of its own: a pending one (a gone job's, with its notice) goes on unchanged.
 */
export function readChatAgain(ref: ChatRef): void {
    const release = pinChat(ref);
    void (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                readRecoveringChat(ref),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, STEP_DEADLINE_MS);
                }),
            ]);
        } finally {
            clearTimeout(timer);
            release();
        }
    })();
}

/**
 * A completion push for a chat (`pushNotifications.ts`): the job that ended may be one this tab lost
 * (its follow gave up while the page was away; a lost follow leaves `followedJobs` before its
 * recovery read) or another device's, so unless a follow of this tab covers the chat (its own
 * terminal brings the reply), the chat is read again (`readChatAgain`). Records `push` `chatRefresh`.
 */
export function refreshChatAfterPush(ref: ChatRef): void {
    if (followedJobsOf(get(followedJobs), ref).length > 0) {
        return;
    }
    recordClientEvent({ kind: "push", phase: "chatRefresh" });
    readChatAgain(ref);
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

/**
 * The chat of a saved job from its status, with the status read (the follow starts from it):
 * `"gone"` when the server does not know it, `"lost"` after the retries (each read bounded by
 * `STEP_DEADLINE_MS`).
 */
async function discover(jobId: string): Promise<{ ref: ChatRef; status: GenerationStatus } | "gone" | "lost"> {
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
        return { ref: { chaId: status.characterId, chatId: status.chatId }, status };
    }
    return "lost";
}

/** Whether the page is hidden or the browser reports itself offline: a failed link then says nothing about the server. */
function pageAway(): boolean {
    return document.visibilityState === "hidden" || navigator.onLine === false;
}

/**
 * One follow of a job to its end through at most `MAX_ATTACHES` attaches on a server that cannot be
 * reached. The transport gives up an attach whose socket does not open within 10 s, or that goes
 * silent (`followGenerationJob`). Only a failed link spends the budget: an opened socket the
 * transport replaced because the page came back (`resumed`) is not counted and the next attach does
 * not wait; a socket that delivered a frame (`received`) reached the server, so the budget starts
 * again at its close (the link failed afterwards, not the server); and a close while the page is
 * hidden or the browser is offline (a phone that cuts the app's network in the background) is not
 * counted either, since the server was not tried: the follow keeps attaching on the retry schedule
 * (its last wait repeated) until the page is back and the attaches fail in front of the user. After
 * every close without the terminal the job's status is read (bounded by `STEP_DEADLINE_MS`): a
 * failed read attaches again (the server may be out of reach), a job the server does not know is
 * `"gone"`, its kept outcome is the end, and a job still running or ended but still live is attached
 * again. When the attaches run out, or the job is no longer known after an ended status was read,
 * the terminal of the last ended status read is the end, if there was one; `"lost"` (or `"gone"`)
 * otherwise. `read` is a status read before the follow (the boot resume's discovery): its kept
 * outcome is the end without an attach (one would be refused), and its ended terminal is the first
 * one known.
 */
async function followOnce(jobId: string, ref: ChatRef, read?: GenerationStatus): Promise<FollowEnd> {
    if (read?.kept && read.terminal) return { terminal: read.terminal, applied: false, kept: true };
    let known: GenerationTerminalEvent | null = read?.state === "ended" ? (read.terminal ?? null) : null;
    // Attaches counted against the budget since the server was last reached, the closes without a
    // frame since then (the wait before the next attach), and whether the last socket was replaced on
    // the page's return.
    let attach = 0;
    let failures = 0;
    let resumed = false;
    let attached = false;
    while (attach < MAX_ATTACHES) {
        const replay = replayedStatuses.get(jobId);
        if (replay?.terminal) return { terminal: replay.terminal, applied: false, kept: replay.kept === true };
        if (attached) {
            if (!resumed) {
                await sleep(retryDelay(Math.max(failures, 1)));
            }
            recordClientEvent({ kind: "jobLink", phase: "reattach", jobId, attempt: attach });
        }
        attached = true;
        const follow: GenerationFollow = followGenerationJob(jobId, (event) => {
            applyGenerationEvent(jobId, ref, event, follow);
            if (event.type === "sequence") {
                incrementStatic("messages");
                if (event.messageId && event.alternatives) {
                    installReplyAlternatives(ref, event.messageId, event.alternatives);
                }
            }
        });
        const closed = await follow.closed;
        if (closed.terminal) {
            return { terminal: closed.terminal, applied: true, kept: false };
        }
        resumed = closed.resumed === true;
        if (closed.received) {
            attach = 0;
            failures = 0;
        }
        if (!resumed && !closed.received) {
            failures += 1;
            if (pageAway()) {
                recordClientEvent({ kind: "jobLink", phase: "closedAway", jobId });
            } else {
                attach += 1;
            }
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
    } else if (end.type === "done" && end.sequence?.stopped) {
        const { sent, total, stopped } = end.sequence;
        const reasons = language.serverJob.sequenceReasons;
        const reason = Object.hasOwn(reasons, stopped) ? reasons[stopped as keyof typeof reasons] : stopped;
        alertError(
            language.serverJob.sequenceStopped.replace(
                /\{(sent|total|reason)\}/g,
                (_, key: "sent" | "total" | "reason") => String({ sent, total, reason }[key]),
            ),
        );
    } else if (end.type === "error" && end.reason === "maintenance") {
        // The debug info's time is the end's, not the alert's (the restore watch may take minutes).
        const at = Date.now();
        void watchForRestore().then((restored) => {
            if (!restored) {
                alertJobError(jobId, end, at);
            }
        });
    } else if (end.type === "error" && end.reason === "aborted" && end.abortedBy === "other") {
        alertToast(language.serverJob.stoppedElsewhere);
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
 * How a server job ended for the caller: it ran (`started`) or was found by request id (`replayed`),
 * this tab's busy job (another action) was followed instead, it did not run (`refused`), or the create failed without an answer, so it
 * may have run (`unknown`).
 */
export type ServerCommandOutcome = "started" | "replayed" | "followed" | "refused" | "unknown";

/**
 * What a server job runs as, for its refusal alerts: a send (every send kind), a Lua button, a manual
 * trigger, or a start of the memory writer.
 */
export type ServerJobLabel = "send" | "button" | "trigger" | "memoryRecord";

/** What a server job of this tab runs: its kind, its command, and the context fields of the caller. */
export type ServerJobRequest = {
    /** Identifies this action across unanswered creates; the transport mints one when omitted. */
    requestId?: string;
    /** An earlier dispatched attempt under this id has no known end. */
    requestUncertain?: boolean;
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
 * followed. `signal` cancels a dispatched create by request id; once following a known owned job,
 * it aborts that job (`DELETE`), including a busy job followed instead. An abort before dispatch
 * runs nothing; an already uncertain request is still cancelled during preflight. The
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
        return { outcome: "refused", terminal: null, requestUncertain: request.requestUncertain === true };
    }
    const release = pinChat(ref);
    try {
        return await runPinnedServerJob(char, ref, request, options);
    } finally {
        release();
    }
}

type ServerJobResult = {
    requestUncertain?: boolean;
    /** A replay with no usable owner terminal was reconciled against the chat. */
    reconciled?: boolean;
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
    let previousCancel: Promise<GenerationCreateResult> | undefined;
    const cancelPrevious = () => {
        if (request.requestId && request.requestUncertain) {
            previousCancel ??= cancelGenerationRequest(request.requestId, ref);
            // The preflight may still be awaiting a flush when cancellation fails.
            void previousCancel.catch(() => {});
        }
    };
    options.signal?.addEventListener("abort", cancelPrevious, { once: true });
    if (options.signal?.aborted) cancelPrevious();
    const prepare = async () => {
        const refused = {
            outcome: "refused" as const,
            terminal: null,
            requestUncertain: request.requestUncertain === true,
        };
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
            if (
                refusedItems().some(
                    (item) =>
                        (item.kind === "chat" && item.chaId === ref.chaId && item.chatId === ref.chatId) ||
                        (item.kind === "order" && item.chaId === ref.chaId),
                )
            ) {
                alertError(language.serverJob.refusedDraft);
                return refused;
            }
            try {
                const { discarded, refused: refusedKeys } = await flushResources();
                if (discarded.length > 0) {
                    alertError(language.serverJob.discarded[request.label]);
                    return refused;
                }
                if (
                    refusedKeys.includes(`chats/${ref.chaId}/${ref.chatId}`) ||
                    refusedKeys.includes(`chats/${ref.chaId}`)
                ) {
                    alertError(language.serverJob.refusedDraft);
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
        return {
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
        };
    };
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
        prepared = await prepare();
    } finally {
        options.signal?.removeEventListener("abort", cancelPrevious);
    }
    if (!previousCancel && "outcome" in prepared) return prepared;
    const refused = { outcome: "refused" as const, terminal: null, requestUncertain: false };
    let jobId: string;
    let initialStatus: GenerationStatus | undefined;
    let outcome: "started" | "replayed" | "followed" = "started";
    let cancelled = false;
    try {
        const created = previousCancel
            ? await previousCancel
            : await createGenerationJob(
                  {
                      kind: request.kind,
                      requestId: request.requestId,
                      context: (prepared as { context: GenerationContext }).context,
                      ...(request.command ? { command: request.command } : {}),
                  } as Parameters<typeof createGenerationJob>[0],
                  {
                      signal: options.signal,
                      requestUncertain: request.requestUncertain,
                  },
              );
        if (created.outcome === "cancelled") return refused;
        jobId = created.jobId;
        if (created.outcome === "replayed") {
            outcome = "replayed";
            cancelled = created.cancelled === true;
            if (!created.owned && created.status?.state === "running") noteForeignJob(ref, jobId);
            if (!created.owned && created.status?.state === "running" && !cancelled) {
                alertError(language.chatGenerating);
                return { ...refused, blockedChats: [ref], requestUncertain: true };
            }
            if (!created.owned || created.status === null) {
                const reconciled = await recoverJobChat(ref, jobId, "outcome");
                // An abort acknowledgement does not mean a foreign job has stopped writing yet.
                const requestUncertain = !reconciled || created.status?.state === "running";
                return { outcome, terminal: null, reconciled, requestUncertain };
            }
            initialStatus = created.status;
        }
    } catch (failure) {
        const error = failure instanceof GenerationCreateError ? failure.cause : failure;
        const requestUncertain = failure instanceof GenerationCreateError && failure.uncertain;
        const refusal = { ...refused, requestUncertain };
        const admissionRefused =
            error instanceof GenerationBusyError ||
            (error instanceof ChatBindingRefusedError && error.code === "chatBindingIncomplete") ||
            error instanceof ChatLoreOverrideOrphanedError ||
            (error instanceof ResourceRequestError &&
                error.status === 503 &&
                ["The server is not accepting generations now", "The server is shutting down"].includes(error.message));
        if (requestUncertain && !admissionRefused) {
            if (!options.signal?.aborted) alertError(language.serverJob.lost);
            return { outcome: "unknown", terminal: null, requestUncertain: true };
        }
        if (error instanceof ChatBindingRefusedError) {
            if (error.code === "chatBindingMismatch") {
                // The server holds a newer binding than this tab: read the chat again, and the user sends again.
                void loadChat(ref).catch((loadError) => console.error("[Generation]", loadError));
                alertError(language.chatBinding.mismatch);
            } else {
                alertError(chatBindingRefusalText(error.problems));
            }
            return refusal;
        }
        if (error instanceof ChatLoreOverrideOrphanedError) {
            alertError(chatLoreOverrideRefusalText(error.entries));
            return refusal;
        }
        if (error instanceof GenerationBusyError) {
            if (requestUncertain) {
                // Identity replay precedes busy lookup, so this job belongs to another action.
                noteForeignJob(ref, error.jobId);
                alertError(language.chatGenerating);
                return { ...refusal, blockedChats: [ref] };
            }
            // This tab's own job (one a reload lost track of): follow it instead; another's is busy.
            const owned = await readGenerationJob(error.jobId, { deadlineMs: STEP_DEADLINE_MS }).catch(() => null);
            if (!owned) {
                noteForeignJob(ref, error.jobId);
                alertError(language.chatGenerating);
                // Another tab's job runs in this chat, with or without a lock this tab knows of yet.
                return { ...refused, blockedChats: [ref] };
            }
            jobId = error.jobId;
            outcome = "followed";
        } else {
            if (error instanceof ResourceRequestError && error.message === "requestCancelled") return refused;
            alertError(
                error instanceof ResourceRequestError && error.message === "requestIdReused"
                    ? language.serverJob.requestIdReused
                    : errorText(error),
            );
            if (requestUncertain && admissionRefused) return refusal;
            // No answer (the network, or a body that did not arrive whole): the job may exist.
            // The exchange also keeps pre-lookup failures uncertain after an unanswered attempt.
            const unanswered =
                failure instanceof GenerationCreateError
                    ? failure.uncertain
                    : !(
                          error instanceof GenerationStaleError ||
                          error instanceof ResourceEpochMismatchError ||
                          (error instanceof ResourceRequestError && error.status !== 0)
                      );
            return { outcome: unanswered ? "unknown" : "refused", terminal: null, requestUncertain: unanswered };
        }
    }
    const onAbort = () => {
        void abortGenerationJob(jobId).catch((error) => console.error("[Generation]", error));
    };
    if (options.signal?.aborted) {
        if (!cancelled) onAbort();
    } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    try {
        if (outcome === "started" || (outcome === "replayed" && initialStatus?.state === "running" && !cancelled)) {
            try {
                options.onStart?.();
            } catch (error) {
                // The job runs anyway: it is still followed to its end, which releases what this tab
                // holds for it (a plugin reload waits for a job that is never released).
                void followJobToEnd(jobId, ref, initialStatus).catch((followError) =>
                    console.error("[Generation]", followError),
                );
                throw error;
            }
        }
        const terminal = await followJobToEnd(jobId, ref, initialStatus);
        return { outcome, terminal, requestUncertain: outcome !== "followed" && terminal === "lost" };
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
