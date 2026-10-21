import { v4 as uuidv4 } from "uuid";
import type { ChatBindingProblem } from "../../../shared/chatBinding.ts";
import {
    type ChatResyncRequest,
    type ReplyResyncRequest,
    type GenerationCreateBody,
    type GenerationEvent,
    type GenerationStatus,
    type GenerationTerminalEvent,
} from "../../../shared/jobs.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    applyServerGeneration,
    applyServerGenerationChunk,
    type ChatRef,
    chatHydrationHold,
    endServerJob,
    isChatStale,
} from "../storage/chatStore.svelte";
import { authFetch, getNodeServerProxyAuth } from "../storage/serverAuth";
import { epochMismatch, getResourceEpoch, ResourceRequestError } from "../storage/resourceClient";
import { applyHydration, applyPatchHydration, flushResources } from "../storage/resourceSync.svelte";
import type { ChannelTransport } from "./jobChannel";
import { recordClientEvent } from "../diagnostics/collector";

/**
 * The channel dispatcher (UI, plugin registries) loads on first use, so this transport stays free of
 * the UI modules. Its work runs on one chain, in the order the socket delivered the events.
 */
let dispatcher: Promise<typeof import("./jobChannel")> | null = null;
let channelWork: Promise<unknown> = Promise.resolve();
function onChannel(work: (channel: typeof import("./jobChannel")) => void) {
    dispatcher ??= import("./jobChannel");
    const loaded = dispatcher;
    // A callback queued here is plugin work until it reaches the channel's `outstanding` (in `work`).
    queuedChannelWork++;
    channelWork = channelWork
        .then(() => loaded)
        .then(work)
        .catch((error) => console.error("[Channel]", error))
        .finally(() => {
            queuedChannelWork--;
            notifyPluginWork();
        });
}

/*
 * Plugin work of this tab's jobs (`plugins-mcp.md`): a job calls the hooks it listed at its
 * creation until it ends, so a plugin reload waits while any of these is held. A job is held from
 * before its hooks are listed (`createGenerationJob`) or from its follow (`followGenerationJob`),
 * and while it is saved for this tab (a reload resumes it), until `releaseGenerationJob`; a busy
 * job this tab may own, until its status read answers; queued channel work; and the channel's
 * running callbacks.
 */
let creatingJobs = 0;
const liveJobs = new Set<string>();
const busyJobs = new Map<string, Set<{ reading: boolean }>>();
let queuedChannelWork = 0;
let channelCallbacks = 0;
const pluginWorkListeners = new Set<() => void>();

function notifyPluginWork() {
    for (const listener of [...pluginWorkListeners]) {
        try {
            listener();
        } catch (error) {
            console.error("[Generation]", error);
        }
    }
}

/** Whether a job of this tab may still call a plugin hook (see above). */
export function generationPluginWorkActive(): boolean {
    return (
        creatingJobs > 0 ||
        liveJobs.size > 0 ||
        busyJobs.size > 0 ||
        queuedChannelWork > 0 ||
        channelCallbacks > 0 ||
        savedGenerationJobIds().length > 0
    );
}

/** Called after any of the above may have ended; returns the unsubscribe function. */
export function onGenerationPluginWork(listener: () => void): () => void {
    pluginWorkListeners.add(listener);
    return () => {
        pluginWorkListeners.delete(listener);
    };
}

/** The job channel's count of running callbacks (`jobChannel.ts` `outstanding`). */
export function noteChannelCallbacks(count: number) {
    if (count === channelCallbacks) {
        return;
    }
    channelCallbacks = count;
    notifyPluginWork();
}

/**
 * The client transport of server generation jobs (`shared/jobs.ts`): create, status, abort, and the
 * owner socket, plus `applyGenerationEvent`, which mirrors a job's events into the chat module and
 * the save loop without any outgoing write. The tab's `clientId` and its jobs (one per chat) are
 * kept in `sessionStorage`, so a reloaded tab can attach again (`resumeSavedGenerations`). Its
 * callers are the server command and send jobs of `process/serverCommands.ts` (the only generation
 * path).
 */

const CLIENT_ID_KEY = "risu-generation-client";
const JOBS_KEY = "risu-generation-jobs";

/** 409 `chatBusy`: the chat has a running job; its owner can attach to `jobId`. */
export class GenerationBusyError extends Error {
    readonly jobId: string;
    constructor(jobId: string) {
        super("This chat is generating a reply");
        this.name = "GenerationBusyError";
        this.jobId = jobId;
    }
}

/** 409 `stale`: the chat changed on the server since the revision sent. */
export class GenerationStaleError extends Error {
    constructor() {
        super("The chat changed on the server; reload it and send again");
        this.name = "GenerationStaleError";
    }
}

/**
 * 409 `chatBindingIncomplete` (with the chat's binding `problems`) or `chatBindingMismatch`: the job's
 * ids are not its chat's complete binding. Nothing ran.
 */
export class ChatBindingRefusedError extends Error {
    readonly code: "chatBindingIncomplete" | "chatBindingMismatch";
    readonly problems: readonly ChatBindingProblem[];
    constructor(code: ChatBindingRefusedError["code"], problems: readonly ChatBindingProblem[] = []) {
        super(code === "chatBindingMismatch" ? "The chat's binding changed" : "The chat's binding is incomplete");
        this.name = "ChatBindingRefusedError";
        this.code = code;
        this.problems = problems;
    }
}

function storage(): Storage | null {
    try {
        return globalThis.sessionStorage ?? null;
    } catch {
        return null;
    }
}

let fallbackClientId: string | null = null;

/** This tab's id, created once and kept across reloads of the tab. */
export function generationClientId(): string {
    const store = storage();
    const saved = store?.getItem(CLIENT_ID_KEY);
    if (saved) {
        return saved;
    }
    const id = fallbackClientId ?? uuidv4();
    fallbackClientId = id;
    store?.setItem(CLIENT_ID_KEY, id);
    return id;
}

/** Ids may contain `/`, so the saved key is a JSON pair. */
const chatKey = (ref: ChatRef) => JSON.stringify([ref.chaId, ref.chatId]);

function readSavedJobs(): Record<string, string> {
    try {
        const parsed = JSON.parse(storage()?.getItem(JOBS_KEY) ?? "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
        return {};
    }
}

function writeSavedJobs(jobs: Record<string, string>) {
    try {
        storage()?.setItem(JOBS_KEY, JSON.stringify(jobs));
    } catch {}
}

/** The saved jobs of this tab, by chat (`JSON.stringify([chaId, chatId])` → job id). */
export function savedGenerationJobs(): Record<string, string> {
    return readSavedJobs();
}

/** This tab's saved jobs (one per chat), as `rememberGenerationJob` keeps them. */
export function savedGenerationJobIds(): string[] {
    return [...new Set(Object.values(readSavedJobs()))];
}

export function rememberGenerationJob(ref: ChatRef, jobId: string) {
    writeSavedJobs({ ...readSavedJobs(), [chatKey(ref)]: jobId });
}

export function forgetGenerationJob(jobId: string) {
    const jobs = readSavedJobs();
    for (const [key, id] of Object.entries(jobs)) {
        if (id === jobId) {
            delete jobs[key];
        }
    }
    writeSavedJobs(jobs);
}

async function failure(response: Response): Promise<never> {
    let body: { error?: string; jobId?: string; epoch?: string; problems?: ChatBindingProblem[] } = {};
    try {
        body = await response.json();
    } catch {}
    if (response.status === 409 && body.error === "chatBusy" && typeof body.jobId === "string") {
        throw new GenerationBusyError(body.jobId);
    }
    if (response.status === 409 && body.error === "stale") {
        throw new GenerationStaleError();
    }
    if (response.status === 409 && (body.error === "chatBindingIncomplete" || body.error === "chatBindingMismatch")) {
        throw new ChatBindingRefusedError(body.error, Array.isArray(body.problems) ? body.problems : []);
    }
    if (response.status === 412 && body.error === "EpochMismatch") {
        // The restore notice and reload, as for any other resource request.
        throw epochMismatch(body.epoch ?? "");
    }
    throw new ResourceRequestError(response.status, body.error ?? `Request failed (${response.status})`);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
        response = await authFetch(path, { ...init, cache: "no-store" });
    } catch (error) {
        throw new ResourceRequestError(0, error instanceof Error ? error.message : String(error));
    }
    return response.ok ? response : failure(response);
}

/** Creates a job for `body.context`'s chat and remembers it for this tab (`hooks`: the registered ones by default). */
type CreateInput = GenerationCreateBody extends infer T ? (T extends unknown ? Omit<T, "clientId"> : never) : never;

export async function createGenerationJob(body: CreateInput): Promise<string> {
    creatingJobs++;
    try {
        const jobId = await createJob(body);
        liveJobs.add(jobId);
        return jobId;
    } catch (error) {
        if (error instanceof GenerationBusyError) {
            // Maybe this tab's own job (the caller reads its status, then follows it).
            let reservations = busyJobs.get(error.jobId);
            if (!reservations) {
                reservations = new Set();
                busyJobs.set(error.jobId, reservations);
            }
            reservations.add({ reading: false });
        }
        throw error;
    } finally {
        creatingJobs--;
        notifyPluginWork();
    }
}

async function createJob(body: CreateInput): Promise<string> {
    let hooks = body.hooks;
    let context = body.context;
    if (!hooks) {
        // The tab's own job: its registered hooks, and the emotions it showed last (the server's
        // emotion modes penalize a recent choice as the tab's do).
        const channel = await import("./jobChannel");
        // The job's model preset (its chat's binding), not the settings views'.
        const { presetId, modelPresetId } = context;
        hooks = await channel.registeredHooks(
            presetId !== null && modelPresetId !== null ? { presetId, modelPresetId } : undefined,
        );
        if (context.client && !context.client.emotions) {
            context = {
                ...context,
                client: { ...context.client, emotions: channel.recentEmotions(context.characterId) },
            };
        }
    }
    const response = await request("/api/generations", {
        method: "POST",
        headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
        body: JSON.stringify({ ...body, context, hooks, clientId: generationClientId() }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    rememberGenerationJob({ chaId: body.context.characterId, chatId: body.context.chatId }, jobId);
    return jobId;
}

const jobPath = (jobId: string) =>
    `/api/generations/${encodeURIComponent(jobId)}?clientId=${encodeURIComponent(generationClientId())}`;

/** This tab's job, or null when the server does not know it (ended long ago, or another tab's). */
export async function readGenerationJob(jobId: string): Promise<GenerationStatus | null> {
    const reservations = busyJobs.get(jobId);
    const reservation = reservations && [...reservations].find((entry) => !entry.reading);
    if (reservation) {
        reservation.reading = true;
    }
    let status: GenerationStatus | null = null;
    try {
        status = (await (await request(jobPath(jobId))).json()) as GenerationStatus;
        return status;
    } catch (error) {
        if (error instanceof ResourceRequestError && error.status === 404) {
            return null;
        }
        throw error;
    } finally {
        // Each read decides only its reservation. Release invalidates the whole set, including late reads.
        if (reservation && reservations && busyJobs.get(jobId) === reservations && reservations.delete(reservation)) {
            if (status?.state === "running" && status.epoch === getResourceEpoch()) {
                liveJobs.add(jobId);
            }
            if (reservations.size === 0) {
                busyJobs.delete(jobId);
            }
            notifyPluginWork();
        }
    }
}

/** Aborts this tab's job (the server persists the text so far). */
export async function abortGenerationJob(jobId: string): Promise<void> {
    try {
        await request(jobPath(jobId), { method: "DELETE" });
    } catch (error) {
        if (!(error instanceof ResourceRequestError && error.status === 404)) {
            throw error;
        }
    }
}

export type GenerationFollow = {
    /** Sends a JSON message to the job (the `job-channel` answers); false while the socket is not open. */
    send(message: unknown): boolean;
    close(): void;
    /** Resolves when the socket closes, with the terminal event if one arrived. */
    closed: Promise<{ terminal: GenerationTerminalEvent | null }>;
};

/**
 * Follows a job over its socket: on every attach the server sends the job chat and the records it
 * changed (fresh), the chosen preset, the current reply with its text, and the result if the job
 * ended. Events of another epoch than the loaded one are dropped, as are pings.
 */
/** The newest follow of each job: a newer follow cancels the older one (its socket, events, and sends). */
const currentFollows = new Map<string, { cancel(): void }>();

/** Orders this tab's attaches across reloads (a later page's stamp is higher): the server keeps the newest. */
let lastStamp = 0;
function attachStamp(): number {
    const now = performance.timeOrigin + performance.now();
    lastStamp = Math.max(now, lastStamp + 0.001);
    return lastStamp;
}

export function followGenerationJob(jobId: string, onEvent: (event: GenerationEvent) => void): GenerationFollow {
    liveJobs.add(jobId);
    let ws: WebSocket | null = null;
    let cancelled = false;
    let terminal: GenerationTerminalEvent | null = null;
    // Settles on the socket's close or on cancellation, whichever comes first (even before auth).
    let resolveClosed!: (value: { terminal: GenerationTerminalEvent | null }) => void;
    const closed = new Promise<{ terminal: GenerationTerminalEvent | null }>((resolve) => {
        resolveClosed = resolve;
    });
    const finish = () => resolveClosed({ terminal });
    const handle = {
        cancel() {
            cancelled = true;
            // Closing a CONNECTING socket aborts its handshake; a socket not built yet never is.
            ws?.close();
            finish();
        },
    };
    // A newer follow of the job supersedes this one at once (its events, sends, and connection).
    currentFollows.get(jobId)?.cancel();
    currentFollows.set(jobId, handle);
    const stamp = attachStamp();
    void (async () => {
        const auth = await getNodeServerProxyAuth();
        if (cancelled) {
            return;
        }
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const url =
            `${protocol}//${location.host}/api/generations/${encodeURIComponent(jobId)}/ws` +
            `?risu-auth=${encodeURIComponent(auth)}&clientId=${encodeURIComponent(generationClientId())}` +
            `&attach=${stamp}`;
        const socket = new WebSocket(url);
        ws = socket;
        let opened = false;
        socket.onopen = () => {
            opened = true;
            if (!cancelled) {
                recordClientEvent({ kind: "jobLink", phase: "attach", jobId });
            }
        };
        socket.onmessage = (message) => {
            if (cancelled) {
                return;
            }
            let event: GenerationEvent;
            try {
                event = JSON.parse(String(message.data)) as GenerationEvent;
            } catch {
                return;
            }
            if (!event || typeof event !== "object" || event.type === "ping") {
                return;
            }
            if (event.epoch !== getResourceEpoch()) {
                return;
            }
            if (event.type === "done" || event.type === "error") {
                terminal = event;
            }
            onEvent(event);
            if (terminal) {
                socket.close();
            }
        };
        socket.onerror = () => {};
        socket.onclose = (event) => {
            // The tab's own close (a newer follow, the caller) and the close after the job's end are not
            // a lost link; a close before the socket opened is an attach that failed.
            if (!cancelled && !terminal) {
                recordClientEvent({
                    kind: "jobLink",
                    phase: opened ? "detach" : "attachFailed",
                    jobId,
                    code: event.code,
                });
            }
            if (currentFollows.get(jobId) === handle) {
                currentFollows.delete(jobId);
            }
            finish();
        };
    })().catch((error) => {
        // Authentication failed (or the socket could not be built): no socket; the follow is over.
        console.error("[Generation]", error);
        if (!cancelled) {
            recordClientEvent({ kind: "jobLink", phase: "attachFailed", jobId });
        }
        if (currentFollows.get(jobId) === handle) {
            currentFollows.delete(jobId);
        }
        finish();
    });
    const follow: GenerationFollow = {
        send(message) {
            const socket = ws as WebSocket | null;
            if (cancelled || !socket || socket.readyState !== WebSocket.OPEN) {
                return false;
            }
            socket.send(JSON.stringify(message));
            return true;
        },
        close() {
            if (currentFollows.get(jobId) === handle) {
                currentFollows.delete(jobId);
            }
            handle.cancel();
        },
        closed,
    };
    // A closed or superseded follow asks nothing more of its job.
    void closed.then(() => endFollowRecovery(follow));
    return follow;
}

/**
 * The follows that asked their job for its chat whole (`resync`) and have not received it yet: one
 * request at a time per follow (a new follow starts without one).
 */
const resyncing = new WeakSet<ChannelTransport>();

/** One reply-only recovery at a time per follow, cleared by any full-text accepted event. */
const resyncingReplies = new WeakSet<ChannelTransport>();

/** The follows whose job ended or that closed: nothing more is asked through them. */
const endedFollows = new WeakSet<ChannelTransport>();

/** The first wait before a recovery tries again (doubled each time, up to `MAX_RESYNC_WAIT_MS`). */
const RESYNC_RETRY_MS = 1000;
const MAX_RESYNC_WAIT_MS = 15_000;

/** A follow's recovery of its chat after a copy refused for local work (`resyncAfterLocalWork`). */
type Recovery = { ref: ChatRef; attempt: number; timer: ReturnType<typeof setTimeout> | null };

/** One recovery per follow, from a refused copy until it asks for the chat whole or gives way. */
const recoveries = new WeakMap<ChannelTransport, Recovery>();

/** Ends a follow's recovery and its asking: its job ended, or the follow closed. */
function endFollowRecovery(transport: ChannelTransport) {
    const recovery = recoveries.get(transport);
    if (recovery?.timer) {
        clearTimeout(recovery.timer);
    }
    recoveries.delete(transport);
    resyncing.delete(transport);
    resyncingReplies.delete(transport);
    endedFollows.add(transport);
}

function requestReplyResync(transport: ChannelTransport) {
    if (endedFollows.has(transport) || resyncingReplies.has(transport)) {
        return;
    }
    const request: ReplyResyncRequest = { type: "resyncReply" };
    if (transport.send(request)) {
        resyncingReplies.add(transport);
    }
}

/**
 * Asks the follow's job for its chat whole, once at a time, while the chat is still stale and
 * nothing local would refuse the copy (`chatHydrationHold`).
 */
function requestResync(transport: ChannelTransport, ref: ChatRef) {
    if (
        endedFollows.has(transport) ||
        resyncing.has(transport) ||
        !isChatStale(ref) ||
        chatHydrationHold(ref) !== "none"
    ) {
        return;
    }
    const request: ChatResyncRequest = { type: "resync" };
    if (transport.send(request)) {
        resyncing.add(transport);
    }
}

/**
 * A job chat copy refused for local work (`busy`): once the chat's queued or in-flight work is saved
 * (`flushResources`), the chat still stale asks for its chat whole, since a stalled stream may send
 * no other patch. A failed save, or new local work meanwhile, is tried again with a growing wait,
 * for as long as the follow lasts; one recovery per follow at a time. A chat held by work no save
 * settles (deferred, quarantined, refused for a generating message) asks nothing: the job's end
 * (the idle refresh) or the next send reads it.
 */
function resyncAfterLocalWork(transport: ChannelTransport, ref: ChatRef) {
    if (recoveries.has(transport) || endedFollows.has(transport) || chatHydrationHold(ref) === "held") {
        return;
    }
    const recovery: Recovery = { ref, attempt: 0, timer: null };
    recoveries.set(transport, recovery);
    runRecovery(transport, recovery);
}

function runRecovery(transport: ChannelTransport, recovery: Recovery) {
    recovery.timer = null;
    const again = () => {
        recovery.timer = setTimeout(
            () => runRecovery(transport, recovery),
            Math.min(RESYNC_RETRY_MS * 2 ** recovery.attempt, MAX_RESYNC_WAIT_MS),
        );
        recovery.attempt += 1;
    };
    void flushResources().then(
        () => {
            if (recoveries.get(transport) !== recovery) {
                return;
            }
            const hold = isChatStale(recovery.ref) ? chatHydrationHold(recovery.ref) : null;
            if (hold === "saving") {
                again();
                return;
            }
            recoveries.delete(transport);
            if (hold === "none") {
                requestResync(transport, recovery.ref);
            }
        },
        () => {
            if (recoveries.get(transport) === recovery) {
                again();
            }
        },
    );
}

/**
 * Mirrors one event of a job on `ref`'s chat: the reply's text and lock (`accepted`, `chunk`), the
 * records the job changed (`resource`, through `applyHydration`; the job chat's changes as
 * `chatPatch`, through `applyPatchHydration`), and the end (`done`, `error`: every lock of the job
 * is released and the saved job is forgotten). A patch the mirror cannot take asks the job for its
 * chat whole through `transport` (`resync`); a missing chunk base asks only for the reply (`resyncReply`).
 */
export function applyGenerationEvent(
    jobId: string,
    ref: ChatRef,
    event: GenerationEvent,
    transport?: ChannelTransport,
) {
    switch (event.type) {
        case "accepted":
            if (transport) {
                resyncingReplies.delete(transport);
            }
            if (event.messageId && event.generationId) {
                applyServerGeneration(ref, {
                    jobId,
                    messageId: event.messageId,
                    generationId: event.generationId,
                    text: event.text,
                    seq: event.seq ?? 0,
                });
            }
            return;
        case "chunk":
            if (!applyServerGenerationChunk(ref, jobId, event) && transport) {
                requestReplyResync(transport);
            }
            return;
        case "resource": {
            const record = {
                kind: event.kind,
                id: event.id,
                characterId: event.characterId,
                revision: event.revision,
                data: event.data,
                ...("streaming" in event && event.streaming ? { job: { jobId, streaming: event.streaming } } : {}),
            };
            const applied = applyHydration(record);
            // Kept for a later callback's barrier, which applies it again after local work settles.
            onChannel((channel) => channel.rememberHydration(jobId, record));
            if (transport && event.kind === "chats" && event.characterId === ref.chaId && event.id === ref.chatId) {
                resyncing.delete(transport);
                if (!applied && isChatStale(ref)) {
                    // A whole copy refused for local work: asked for again once that work is saved.
                    resyncAfterLocalWork(transport, ref);
                }
            }
            return;
        }
        case "chatPatch": {
            // Not kept for the barrier: a patch fits only the copy it was made against.
            const outcome = applyPatchHydration(
                {
                    characterId: event.characterId,
                    id: event.id,
                    baseRevision: event.baseRevision,
                    revision: event.revision,
                    meta: event.meta,
                    removed: event.removed,
                    messages: event.messages,
                    count: event.count,
                },
                { jobId, streaming: event.streaming },
            );
            if (transport && outcome === "mismatch") {
                requestResync(transport, ref);
            } else if (transport && outcome === "busy") {
                resyncAfterLocalWork(transport, ref);
            }
            return;
        }
        case "notice":
        case "question":
        case "callback":
        case "cancel":
            if (transport) {
                onChannel((channel) => channel.handleChannelEvent(jobId, event, transport));
            }
            return;
        case "preset":
            // A `presetChain` pick is the job's own: neither the tab's selection nor the chat's binding
            // changes.
            return;
        case "done":
        case "error":
            if (transport) {
                endFollowRecovery(transport);
            }
            releaseGenerationJob(jobId);
            return;
    }
}

/**
 * Everything this tab holds for a job, released as its end releases it: the channel's outstanding
 * questions and callbacks (cancelled), the job's message locks, and the saved job. Also for a job
 * the tab stopped following without its end (lost).
 */
export function releaseGenerationJob(jobId: string) {
    if (dispatcher) {
        onChannel((channel) => channel.endJobChannel(jobId));
    }
    endServerJob(jobId);
    forgetGenerationJob(jobId);
    liveJobs.delete(jobId);
    busyJobs.delete(jobId);
    notifyPluginWork();
}

/**
 * Attaches again to this tab's saved jobs (after a reload): each one the server still knows is
 * followed and its events applied; an unknown one is forgotten. Returns the follows started.
 */
export async function resumeSavedGenerations(
    onEvent?: (jobId: string, ref: ChatRef, event: GenerationEvent) => void,
): Promise<GenerationFollow[]> {
    const follows: GenerationFollow[] = [];
    for (const jobId of Object.values(readSavedJobs())) {
        const status = await readGenerationJob(jobId);
        if (!status || status.epoch !== getResourceEpoch()) {
            forgetGenerationJob(jobId);
            continue;
        }
        const ref = { chaId: status.characterId, chatId: status.chatId };
        // The follow is the channel's transport: its answers go out on the job's current socket.
        const follow: GenerationFollow = followGenerationJob(jobId, (event) => {
            applyGenerationEvent(jobId, ref, event, follow);
            onEvent?.(jobId, ref, event);
        });
        follows.push(follow);
    }
    return follows;
}
