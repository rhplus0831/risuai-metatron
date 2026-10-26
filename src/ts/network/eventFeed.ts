import { EVENT_FEED_PATH, type EventFeedFrame } from "../../../shared/events.ts";
import { epochMismatch, getResourceEpoch, listRevisions, ResourceEpochMismatchError } from "../storage/resourceClient";
import { getNodeServerProxyAuth } from "../storage/serverAuth";
import { noteRemoteChanges, reconcileRemote } from "../storage/resourceSync.svelte";
import { noteRemoteStreaming, replaceFeedLocks } from "../storage/chatStore.svelte";
import { recordClientEvent } from "../diagnostics/collector";
import { type SocketWatch, watchResume, watchSocket } from "./socketLiveness";
import {
    noteMemoryTaskFrame,
    noteMemoryTaskHello,
    noteMemoryTaskListing,
    resetMemoryTasks,
} from "../process/memoryTasks.svelte";

/**
 * The live-update socket (`server/src/routes/events.ts`): another tab's or device's committed
 * changes arrive as refs and revisions and go to the save loop (`noteRemoteChanges`), which reads
 * and applies what this tab holds. On every `hello` (connect, reconnect, a server restart) the tab
 * reconciles against the revision listing, so nothing committed while it was disconnected is
 * missed. Every connection signs a fresh JWT (they live five minutes). A frame of another epoch, or
 * an `epoch` frame, means a restore replaced the data: the save loop halts and the page reloads. A
 * `change` frame's refs are dispatched before its generation locks (`streaming`) go to the chat
 * module (`noteRemoteStreaming`), so a fitting `begin` patch puts the row in the mirror before its
 * lock. For a chat the mirror lacks, an unloaded chat, or a patch that does not fit, the lock is
 * installed by id and the row arrives locked with the read. A `hello` replaces the feed's whole
 * lock set with the server's snapshot before reconciliation starts.
 *
 * One connection is current at a time (`generation`). A connection that has not opened within 10 s
 * (authentication included) or that has had no frame for 45 s while the page is visible is abandoned
 * without waiting for its `close`, and reconnects with the backoff (`socketLiveness.ts`). When the
 * page comes back (visible after 30 s hidden, a Page Lifecycle `resume`, `online`; triggers that come
 * together are folded) the connection is replaced at once, even during a retry's wait: a half-open
 * socket after a freeze would otherwise deliver nothing until TCP gives up.
 *
 * HypaV3 memory task statuses go to `memoryTasks.svelte.ts`: a `memoryTask` frame of the loaded epoch
 * as it comes, a `hello`'s snapshot as the whole status set, and the revision listing that follows
 * the `hello` (before it is reconciled) for the chats whose fences wait for it. Another epoch resets
 * them.
 */

const MAX_BACKOFF_MS = 30_000;

let started = false;
let stopped = false;
/**
 * The current connection's number. A connection's authentication, socket, `hello`, reconcile, and
 * `close` act only while it is current: a new connection, an abandoned one, an ended attempt (its
 * close, a failed authentication), and the stop each move it on, so every late result of an older
 * connection does nothing, except that an epoch-mismatch error of an older connection's listing
 * still resets the memory tasks (the data was replaced, whichever connection read it).
 */
let generation = 0;
let socket: WebSocket | null = null;
/** The current connection's liveness watch (`socketLiveness.ts`). */
let liveness: SocketWatch | null = null;
let stopResume: (() => void) | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** The socket that got its `hello` (recorded `connected` once), and the attempt it was. */
let connectedSocket: WebSocket | null = null;

function isFrame(value: unknown): value is EventFeedFrame {
    return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/**
 * Ends the current connection's attempt without closing anything: its late results do nothing,
 * except that an epoch-mismatch error of its listing still resets the memory tasks.
 */
function retire() {
    generation += 1;
    liveness?.stop();
    liveness = null;
    socket = null;
}

function scheduleReconnect() {
    if (stopped || retryTimer) {
        return;
    }
    const baseDelay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 5));
    const delay = baseDelay / 2 + Math.random() * (baseDelay / 2);
    attempt += 1;
    const timer = setTimeout(() => {
        if (retryTimer !== timer) {
            return;
        }
        retryTimer = null;
        void connect();
    }, delay);
    retryTimer = timer;
}

/**
 * Gives up the current connection without waiting for its `close` (a socket that went silent, or
 * one that did not open in time): the event is recorded and the reconnect is scheduled as after a
 * close.
 */
function abandon(gen: number, phase: "stale" | "connectTimeout", connectAttempt: number) {
    if (gen !== generation) {
        return;
    }
    const ws = socket;
    retire();
    ws?.close();
    recordClientEvent({ kind: "feed", phase, attempt: connectAttempt });
    scheduleReconnect();
}

/** The page came back (`watchResume`): the connection is replaced at once, even during a retry's wait. */
function resumeReconnect() {
    if (stopped) {
        return;
    }
    recordClientEvent({ kind: "feed", phase: "resumeReconnect", attempt });
    void connect();
}

async function reconcile(gen: number, ws: WebSocket, hello: number) {
    try {
        const listing = await listRevisions();
        if (gen === generation) {
            noteMemoryTaskListing(hello, listing);
            reconcileRemote(listing);
            // Only a reconciled connection resets the backoff: a server that accepts the socket but fails the reconcile keeps backing off.
            attempt = 0;
        }
    } catch (error) {
        // The data was replaced, whichever connection read it.
        if (error instanceof ResourceEpochMismatchError) {
            resetMemoryTasks();
            return;
        }
        if (gen !== generation) {
            return;
        }
        console.error("[Live updates]", error);
        // Reconnecting reconciles again.
        ws.close();
    }
}

function receive(gen: number, ws: WebSocket, frame: EventFeedFrame, connectAttempt: number) {
    const loaded = getResourceEpoch();
    switch (frame.type) {
        case "hello":
            if (frame.epoch !== loaded) {
                resetMemoryTasks();
                epochMismatch(frame.epoch);
                return;
            }
            replaceFeedLocks(Array.isArray(frame.streaming) ? frame.streaming : []);
            const hello = noteMemoryTaskHello(frame.memoryTasks);
            if (connectedSocket !== ws) {
                connectedSocket = ws;
                recordClientEvent({ kind: "feed", phase: "connected", attempt: connectAttempt });
            }
            void reconcile(gen, ws, hello);
            return;
        case "change":
            if (frame.epoch === loaded) {
                noteRemoteChanges(frame.changes);
                if (frame.streaming) {
                    noteRemoteStreaming(frame.streaming, frame.changes);
                }
            }
            return;
        case "memoryTask":
            if (frame.epoch === loaded) {
                noteMemoryTaskFrame(frame);
            }
            return;
        case "epoch":
            if (frame.epoch !== loaded) {
                resetMemoryTasks();
                epochMismatch(frame.epoch);
            }
            return;
        case "ping":
            return;
    }
}

/**
 * Starts a new connection: the previous one is retired before its socket is closed, and a pending
 * retry is dropped. The connection is watched from its start (`watchSocket`): one that has not
 * opened within the connect timeout (authentication included) or goes silent while open is
 * abandoned.
 */
async function connect() {
    if (stopped) {
        return;
    }
    const previous = socket;
    retire();
    const gen = generation;
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    previous?.close();
    // The attempt this connection is (0 for the first after a reconciled `hello`), for its events.
    const connectAttempt = attempt;
    const watch = watchSocket({
        onConnectTimeout: () => abandon(gen, "connectTimeout", connectAttempt),
        onStale: () => abandon(gen, "stale", connectAttempt),
    });
    liveness = watch;
    let token: string;
    try {
        token = await getNodeServerProxyAuth();
    } catch (error) {
        if (gen !== generation) {
            return;
        }
        console.error("[Live updates]", error);
        retire();
        recordClientEvent({ kind: "feed", phase: "connectFailed", attempt: connectAttempt });
        scheduleReconnect();
        return;
    }
    if (gen !== generation || stopped) {
        return;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try {
        ws = new WebSocket(`${protocol}//${location.host}${EVENT_FEED_PATH}?risu-auth=${encodeURIComponent(token)}`);
    } catch (error) {
        console.error("[Live updates]", error);
        retire();
        recordClientEvent({ kind: "feed", phase: "connectFailed", attempt: connectAttempt });
        scheduleReconnect();
        return;
    }
    socket = ws;
    ws.addEventListener("open", () => {
        if (gen === generation) {
            watch.opened();
        }
    });
    ws.addEventListener("message", (event) => {
        if (gen !== generation) {
            return;
        }
        watch.frame();
        let frame: unknown;
        try {
            frame = JSON.parse(String(event.data));
        } catch {
            return;
        }
        if (isFrame(frame)) {
            receive(gen, ws, frame, connectAttempt);
        }
    });
    ws.addEventListener("close", (event) => {
        if (gen === generation) {
            retire();
            // A socket that never got its `hello` did not connect.
            recordClientEvent({
                kind: "feed",
                phase: connectedSocket === ws ? "disconnected" : "connectFailed",
                attempt: connectAttempt,
                code: event.code,
            });
            scheduleReconnect();
        }
    });
}

/**
 * Opens the socket (after the boot read and `startResourceSync`) and replaces it whenever the page
 * comes back (`watchResume`); a second call does nothing.
 */
export function startEventFeed() {
    if (started) {
        return;
    }
    started = true;
    stopResume = watchResume(resumeReconnect);
    void connect();
}

/** Closes the socket and stops reconnecting (tests). */
export function stopEventFeed() {
    stopped = true;
    stopResume?.();
    stopResume = null;
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    const ws = socket;
    retire();
    ws?.close();
}
