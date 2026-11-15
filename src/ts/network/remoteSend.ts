import { get } from "svelte/store";
import { language } from "src/lang";
import type { EventFeedFrame } from "../../../shared/events.ts";
import {
    REMOTE_COMMAND_PICKUP_MS,
    REMOTE_COMMANDS_PATH,
    REMOTE_COMMAND_STATES,
    type RemoteCommandPostBody,
    type RemoteCommandStatusAnswer,
    type RemoteSendResult,
} from "../../../shared/remoteCommands.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import type { ServerSendArg, ServerSendResult } from "../process/serverGeneration";
import { epochMismatch, getResourceEpoch, ResourceEpochMismatchError } from "../storage/resourceClient";
import { connectedClients, hostTargets, preference } from "./handoff";
import { hostMode } from "./remoteHost";

/**
 * Routes ordinary composer sends through a host under the caller's local-send reservation. The chat
 * stays pinned through preflight, relay reconciliation and any definite-failure fallback. Frames are
 * wakeups for HTTP status reads, never results; an uncertain transition cannot be upgraded by a later
 * result. Stop cancels both the command and the generation request without creating a local job.
 * Send, store and alert modules load only inside the adapter, keeping the feed's import graph light.
 */
export const remoteSend = preference<boolean>("risu-remote-send", false);
export const remoteSendHost = preference<string>("risu-remote-send-host", "");
export const remoteSendFallback = preference<boolean>("risu-remote-send-fallback", true);

const REQUEST_DEADLINE_MS = 15_000;
const HOST_ABSENCE_MS = 60_000;
type EligibleSend = ServerSendArg & { input: string; userMessageId: string; requestId: string };
type StateFrame = Extract<EventFeedFrame, { type: "remoteCommandState" }>;
type Waiter = { epoch: string; frame: (frame: StateFrame) => void; reconcile: () => void };
type RememberedCommand = { epoch: string; hostId?: string; hostName: string; shown: Set<string> };
const waiters = new Map<string, Waiter>();
const commands = new Map<string, RememberedCommand>();

/** Remote sending must be enabled; host work, previews and non-composer actions stay local. */
export function remoteSendEligible(arg: ServerSendArg): arg is EligibleSend {
    return (
        get(remoteSend) &&
        !get(hostMode) &&
        !arg.localOnly &&
        typeof arg.input === "string" &&
        !!arg.userMessageId &&
        !!arg.requestId &&
        arg.continue !== true &&
        !arg.continueMessageId &&
        !arg.rerollMessageId &&
        !arg.speakerChaId &&
        !arg.preview &&
        !arg.previewPrompt &&
        !arg.pluginContext
    );
}

/** Only a live waiter in the loaded epoch can consume a frame. */
export function receiveRemoteCommandState(frame: StateFrame): void {
    const waiter = waiters.get(frame.commandId);
    if (frame.epoch === getResourceEpoch() && waiter?.epoch === frame.epoch) waiter.frame(frame);
}

/** Every matching hello reconciles outstanding commands, including ones whose frame was lost. */
export function reconcileRemoteSends(epoch: string): void {
    if (epoch !== getResourceEpoch()) return;
    for (const waiter of waiters.values()) if (waiter.epoch === epoch) waiter.reconcile();
}

async function loadSend() {
    const [generation, jobs, chats, auth, transport, alerts] = await Promise.all([
        import("../process/serverGeneration"),
        import("../process/serverCommands"),
        import("../storage/chatStore.svelte"),
        import("../storage/serverAuth"),
        import("./generationJobs"),
        import("../alert"),
    ]);
    return {
        sendChatOnServer: generation.sendChatOnServer,
        prepareServerJob: jobs.prepareServerJob,
        readRecoveringChat: jobs.readRecoveringChat,
        chats,
        authFetch: auth.authFetch,
        clientId: transport.generationClientId(),
        alertToast: alerts.alertToast,
        alertError: alerts.alertError,
    };
}
type SendModules = Awaited<ReturnType<typeof loadSend>>;
type RelayReply = { status: number; ok: boolean; answer: unknown } | { error: unknown };

/** The user's abort never aborts the reads needed to establish what the host did. */
async function relayRequest(modules: SendModules, epoch: string, path: string, body?: unknown): Promise<RelayReply> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // Bound even a transport that fails to reject on abort, including an unanswered response body.
        return await Promise.race([
            (async () => {
                const response = await modules.authFetch(path, {
                    method: body === undefined ? "GET" : "POST",
                    headers: {
                        [RESOURCE_EPOCH_HEADER]: epoch,
                        ...(body === undefined ? {} : { "content-type": "application/json" }),
                    },
                    cache: "no-store",
                    signal: controller.signal,
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
                const answer: unknown = await response.json().catch(() => null);
                if (response.status === 412) {
                    throw epochMismatch(isPlainObject(answer) && typeof answer.epoch === "string" ? answer.epoch : "");
                }
                return { status: response.status, ok: response.ok, answer };
            })(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error("Remote command request timed out"));
                }, REQUEST_DEADLINE_MS);
            }),
        ]);
    } catch (error) {
        return { error };
    } finally {
        clearTimeout(timer);
    }
}

function refusal(uncertain: boolean, blockedChats?: ServerSendResult["blockedChats"]): ServerSendResult {
    return {
        ok: false,
        outcome: "refused",
        settled: !uncertain,
        refusal: uncertain ? "ambiguous" : "definite",
        requestUncertain: uncertain,
        ...(blockedChats ? { blockedChats } : {}),
    };
}

function uncertain(): ServerSendResult {
    return { ...refusal(true), outcome: "unknown" };
}

function remoteResult(value: unknown): RemoteSendResult | undefined {
    if (
        !isPlainObject(value) ||
        typeof value.ok !== "boolean" ||
        typeof value.settled !== "boolean" ||
        typeof value.requestUncertain !== "boolean" ||
        typeof value.outcome !== "string" ||
        !["started", "replayed", "followed", "refused", "unknown"].includes(value.outcome) ||
        !Array.isArray(value.reports) ||
        !value.reports.every(
            (report) =>
                isPlainObject(report) &&
                (report.kind === "notice" || report.kind === "error") &&
                typeof report.text === "string",
        ) ||
        !Array.isArray(value.blockedChats) ||
        !value.blockedChats.every(
            (ref) => isPlainObject(ref) && typeof ref.chaId === "string" && typeof ref.chatId === "string",
        )
    )
        return undefined;
    return value as RemoteSendResult;
}

type RelayEnd =
    | { kind: "host"; result: RemoteSendResult; uncertain: boolean }
    | { kind: "definite"; reason: string }
    | { kind: "uncertain" }
    | { kind: "epoch" }
    | { kind: "changed" }
    | { kind: "stopped"; result: ServerSendResult };
type Wake =
    | { kind: "post"; reply: RelayReply }
    | { kind: "status"; reply: Promise<RelayReply>; frame?: StateFrame }
    | { kind: "absent" };

async function waitForHost(
    arg: EligibleSend,
    command: RemoteCommandPostBody,
    remembered: RememberedCommand,
    modules: SendModules,
    post: boolean,
    cancelGeneration: () => Promise<ServerSendResult>,
): Promise<RelayEnd> {
    const epoch = remembered.epoch;
    const path = `${REMOTE_COMMANDS_PATH}/${encodeURIComponent(arg.requestId)}`;
    let ended = false;
    let frameSeen = false;
    let uncertainFrame: StateFrame | undefined;
    const dispatchedAt = Date.now();
    let postPending = post;
    let repostUntil = post && arg.requestUncertain ? dispatchedAt + REMOTE_COMMAND_PICKUP_MS : 0;
    let heldUncertain: RemoteCommandStatusAnswer | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let absenceTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping: Promise<ServerSendResult> | undefined;
    let wake: (() => void) | undefined;
    const queue: Wake[] = [];
    const enqueue = (event: Wake) => {
        if (ended) return;
        queue.push(event);
        wake?.();
    };
    const readStatus = () =>
        relayRequest(modules, epoch, `${path}/status?clientId=${encodeURIComponent(modules.clientId)}`);
    const reconcile = () => enqueue({ kind: "status", reply: readStatus() });
    const waiter: Waiter = {
        epoch,
        reconcile,
        frame: (frame) => {
            frameSeen = true;
            if (frame.state === "uncertain") uncertainFrame ??= frame;
            enqueue({ kind: "status", frame, reply: readStatus() });
        },
    };
    const poll = () => {
        pollTimer = setTimeout(() => {
            reconcile();
            poll();
        }, REMOTE_COMMAND_PICKUP_MS);
    };
    let finishStopped: (end: RelayEnd) => void;
    const stopped = new Promise<RelayEnd>((resolve) => {
        finishStopped = resolve;
    });
    const onAbort = () => {
        if (ended || stopping) return;
        stopping = cancelGeneration();
        void stopping.then((result) => {
            if (!ended && result.settled) finishStopped({ kind: "stopped", result });
        });
    };
    const hostEnd = (answer: RemoteCommandStatusAnswer): RelayEnd | undefined => {
        switch (answer.state) {
            case "done": {
                const result = remoteResult(answer.result);
                return result ? { kind: "host", result, uncertain: false } : { kind: "uncertain" };
            }
            case "uncertain": {
                const result = remoteResult(answer.result);
                return result ? { kind: "host", result, uncertain: true } : { kind: "uncertain" };
            }
            case "expired":
                return { kind: "definite", reason: "expired" };
            case "refused":
                return { kind: "definite", reason: answer.code ?? "refused" };
            case "cancelled":
                return { kind: "uncertain" };
        }
    };
    const consume = async (): Promise<RelayEnd> => {
        while (!ended) {
            if (!queue.length)
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            wake = undefined;
            if (ended) break;
            const event = queue.shift();
            if (!event) continue;
            if (event.kind === "absent") return { kind: "uncertain" };
            const frame = event.kind === "status" ? event.frame : undefined;
            if (uncertainFrame && frame !== uncertainFrame) continue;
            // A fresh terminal transition owns the outcome even if a later status has moved on.
            if (frame?.state === "forgotten" || frame?.state === "cancelled") return { kind: "uncertain" };
            if (frame?.state === "expired" || frame?.state === "refused") {
                return { kind: "definite", reason: frame.code ?? frame.state };
            }
            const reply = await event.reply;
            if (ended) break;
            if ("error" in reply) {
                return { kind: reply.error instanceof ResourceEpochMismatchError ? "epoch" : "uncertain" };
            }
            if (uncertainFrame && frame !== uncertainFrame) continue;
            if (event.kind === "post") postPending = false;
            const answer = reply.answer;
            if (event.kind === "post" && !reply.ok) {
                if (reply.status === 409 && isPlainObject(answer) && answer.error === "commandChanged")
                    return { kind: "changed" };
                if (reply.status === 413) return { kind: "definite", reason: "tooLarge" };
                if (
                    isPlainObject(answer) &&
                    ((reply.status === 404 && answer.error === "targetUnavailable") ||
                        (reply.status === 409 && answer.error === "targetFull"))
                )
                    return { kind: "definite", reason: answer.error };
            }
            if (!reply.ok || !isPlainObject(answer) || !REMOTE_COMMAND_STATES.some((state) => state === answer.state))
                return { kind: "uncertain" };
            const status = answer as RemoteCommandStatusAnswer;
            if (frame?.state === "uncertain") {
                // The read is for this transition's reports, never for a later successful outcome.
                return status.state === "uncertain" ? hostEnd(status)! : { kind: "uncertain" };
            }
            if (event.kind === "post" && ["queued", "delivered", "running", "uncertain"].includes(status.state)) {
                if (status.state === "uncertain") repostUntil = dispatchedAt + REMOTE_COMMAND_PICKUP_MS;
                else repostUntil = 0;
                if (heldUncertain && (!repostUntil || frameSeen)) return hostEnd(heldUncertain)!;
                heldUncertain = undefined;
                continue;
            }
            if (status.state === "uncertain" && !frame && !frameSeen) {
                if (postPending) {
                    heldUncertain = status;
                    continue;
                }
                if (Date.now() < repostUntil) continue;
            }
            const result = hostEnd(status);
            if (result) return result;
        }
        return { kind: "uncertain" };
    };
    // Install before dispatch: the host's first frame may beat the POST response.
    waiters.set(arg.requestId, waiter);
    const unsubscribe = connectedClients.subscribe((clients) => {
        const present = clients.some((client) => client.clientId === remembered.hostId && client.host === true);
        if (present) {
            clearTimeout(absenceTimer);
            absenceTimer = undefined;
        } else absenceTimer ??= setTimeout(() => enqueue({ kind: "absent" }), HOST_ABSENCE_MS);
    });
    arg.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        if (post)
            void relayRequest(modules, epoch, REMOTE_COMMANDS_PATH, command).then((reply) =>
                enqueue({ kind: "post", reply }),
            );
        else reconcile();
        poll();
        if (arg.signal?.aborted) onAbort();
        const result = await Promise.race([consume(), stopped]);
        // A cancelled relay command cannot preempt generation cancellation's definite answer.
        if (stopping) {
            const resolved = await stopping;
            if (resolved.settled) return { kind: "stopped", result: resolved };
        }
        return result;
    } finally {
        ended = true;
        wake?.();
        clearTimeout(pollTimer);
        clearTimeout(absenceTimer);
        unsubscribe();
        arg.signal?.removeEventListener("abort", onAbort);
        if (waiters.get(arg.requestId) === waiter) waiters.delete(arg.requestId);
    }
}

/** Returns the same refusal and completion contract as the local send, without touching composer state. */
export async function sendChatRemotely(arg: EligibleSend): Promise<ServerSendResult> {
    const result = await runRemoteSend(arg);
    // Only a retryable request needs to retain its host and already displayed reports.
    if (result.settled && !result.requestUncertain) commands.delete(arg.requestId);
    return result;
}

async function runRemoteSend(arg: EligibleSend): Promise<ServerSendResult> {
    const modules = await loadSend();
    const ref = arg.target ?? modules.chats.currentChatRef();
    if (!ref || !modules.chats.chatEntry(ref)) return refusal(arg.requestUncertain === true);
    arg = { ...arg, target: ref };
    const release = modules.chats.pinChat(ref);
    const epoch = getResourceEpoch();
    for (const [id, command] of commands) if (command.epoch !== epoch) commands.delete(id);
    const remembered: RememberedCommand = commands.get(arg.requestId) ?? {
        epoch,
        hostName: get(remoteSendHost),
        shown: new Set<string>(),
    };
    commands.set(arg.requestId, remembered);
    let posted = false;
    let cancellation: Promise<ServerSendResult> | undefined;
    const cancelGeneration = () =>
        (cancellation ??= modules
            .sendChatOnServer({ ...arg, requestUncertain: true, reports: [] })
            .catch(() => uncertain()));
    const onAbort = () => {
        if (posted || arg.requestUncertain) {
            void relayRequest(modules, epoch, `${REMOTE_COMMANDS_PATH}/${encodeURIComponent(arg.requestId)}/cancel`, {
                clientId: modules.clientId,
            });
        }
        if (posted || arg.requestUncertain) void cancelGeneration();
    };
    arg.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        if (arg.signal?.aborted) onAbort();
        const prepared = await modules.prepareServerJob(
            ref,
            { kind: "send", label: "send", requestUncertain: arg.requestUncertain },
            { signal: arg.signal, reports: arg.reports },
        );
        if (arg.signal?.aborted) {
            if (!arg.requestUncertain) return refusal(false);
            const resolved = await cancelGeneration();
            if (resolved.settled) return resolved;
        } else if ("outcome" in prepared) {
            return refusal(
                arg.requestUncertain === true,
                "blockedChats" in prepared ? prepared.blockedChats : undefined,
            );
        }
        if (epoch !== getResourceEpoch()) return refusal(arg.requestUncertain === true);
        const clients = get(connectedClients);
        const prior = clients.find(
            (client) =>
                client.clientId === remembered.hostId && client.host === true && client.clientId !== modules.clientId,
        );
        const host =
            prior ?? hostTargets(clients, modules.clientId).find((client) => client.name === get(remoteSendHost));
        if (host) remembered.hostId = host.clientId;
        remembered.hostName = host?.name ?? get(remoteSendHost);
        const hostName = remembered.hostName || language.serverJob.remoteSend.unnamed;
        const toast = (reason: string) => {
            if (!arg.signal?.aborted)
                modules.alertToast(
                    language.serverJob.remoteSend.failed
                        .replace("{host}", () => hostName)
                        .replace("{reason}", () => reason),
                );
        };
        const definite = (reason: string): Promise<ServerSendResult> | ServerSendResult => {
            const reasons = language.serverJob.remoteSend.reasons;
            const reasonText = reasons[reason as keyof typeof reasons] ?? reasons.refused;
            if (arg.requestUncertain) {
                toast(`${reasonText} ${language.serverJob.remoteSend.uncertain}`);
                return refusal(true);
            }
            if (!arg.signal?.aborted && get(remoteSendFallback)) return modules.sendChatOnServer(arg);
            toast(reasonText);
            return refusal(false);
        };
        if (!host && !arg.signal?.aborted) return await definite("targetUnavailable");
        const command: RemoteCommandPostBody = {
            clientId: modules.clientId,
            target: host?.clientId ?? remembered.hostId ?? "",
            commandId: arg.requestId,
            command: {
                type: "send",
                chaId: ref.chaId,
                chatId: ref.chatId,
                input: arg.input,
                userMessageId: arg.userMessageId,
                requestId: arg.requestId,
                ...(arg.inputOriginal !== undefined ? { inputOriginal: arg.inputOriginal } : {}),
                ...(arg.stopOverLoreBudget !== undefined ? { stopOverLoreBudget: arg.stopOverLoreBudget } : {}),
            },
            ...(arg.requestUncertain ? { uncertain: true } : {}),
        };
        posted = !arg.signal?.aborted;
        const end = await waitForHost(arg, command, remembered, modules, posted, cancelGeneration);
        if (end.kind === "stopped") return end.result;
        if (end.kind === "epoch") return refusal(arg.requestUncertain === true);
        if (end.kind === "changed") {
            if (!arg.signal?.aborted) modules.alertError(language.serverJob.remoteSend.commandChanged);
            return refusal(true);
        }
        if (end.kind === "definite") return await definite(end.reason);
        if (end.kind === "uncertain") {
            toast(language.serverJob.remoteSend.uncertain);
            return uncertain();
        }
        const result = end.result;
        const fresh = (text: string) => {
            if (!text || remembered.shown.has(text) || arg.signal?.aborted) return false;
            remembered.shown.add(text);
            return true;
        };
        const notices = result.reports.filter((report) => report.kind === "notice" && fresh(report.text));
        if (notices.length) modules.alertToast(notices.map((report) => report.text).join("\n"));
        const reconciled = await modules.readRecoveringChat(ref);
        if (cancellation) {
            const resolved = await cancellation;
            if (resolved.settled) return resolved;
        }
        if (!result.ok && !result.loreStop && !arg.signal?.aborted) {
            const errors = result.reports.filter((report) => report.kind === "error");
            if (errors.length) {
                for (const error of errors) if (fresh(error.text)) modules.alertError(error.text);
            } else if (result.reportShownElsewhere) {
                const text = language.serverJob.remoteSend.shownElsewhere.replace("{host}", () => hostName);
                if (fresh(text)) modules.alertError(text);
            }
        }
        const { reports, truncated, ...mapped } = result;
        if (end.uncertain || (!result.ok && !reconciled))
            return { ...mapped, ok: false, settled: false, requestUncertain: true };
        return mapped;
    } finally {
        arg.signal?.removeEventListener("abort", onAbort);
        release();
    }
}
