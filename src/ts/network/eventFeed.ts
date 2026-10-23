import { EVENT_FEED_PATH, type EventFeedFrame } from "../../../shared/events.ts";
import { epochMismatch, getResourceEpoch, listRevisions, ResourceEpochMismatchError } from "../storage/resourceClient";
import { getNodeServerProxyAuth } from "../storage/serverAuth";
import { noteRemoteChanges, reconcileRemote } from "../storage/resourceSync.svelte";
import { noteRemoteStreaming, releaseFeedLocks } from "../storage/chatStore.svelte";
import { recordClientEvent } from "../diagnostics/collector";
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
 * installed by id and the row arrives locked with the read. A `hello` drops the feed's locks, since
 * a release may have been sent while disconnected.
 *
 * HypaV3 memory task statuses go to `memoryTasks.svelte.ts`: a `memoryTask` frame of the loaded epoch
 * as it comes, a `hello`'s snapshot as the whole status set, and the revision listing that follows
 * the `hello` (before it is reconciled) for the chats whose fences wait for it. Another epoch resets
 * them.
 */

const MAX_BACKOFF_MS = 30_000;

let started = false;
let stopped = false;
let socket: WebSocket | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** The socket that got its `hello` (recorded `connected` once), and the attempt it was. */
let connectedSocket: WebSocket | null = null;

function isFrame(value: unknown): value is EventFeedFrame {
    return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function scheduleReconnect() {
    if (stopped || retryTimer) {
        return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
    }, delay);
}

async function reconcile(ws: WebSocket, hello: number) {
    try {
        const listing = await listRevisions();
        if (socket === ws) {
            noteMemoryTaskListing(hello, listing);
            reconcileRemote(listing);
        }
    } catch (error) {
        if (error instanceof ResourceEpochMismatchError) {
            resetMemoryTasks();
            return;
        }
        console.error("[Live updates]", error);
        // Reconnecting reconciles again.
        ws.close();
    }
}

function receive(ws: WebSocket, frame: EventFeedFrame, connectAttempt: number) {
    const loaded = getResourceEpoch();
    switch (frame.type) {
        case "hello":
            if (frame.epoch !== loaded) {
                resetMemoryTasks();
                epochMismatch(frame.epoch);
                return;
            }
            // Nothing is replayed: a running job announces its locks again with its next write.
            releaseFeedLocks();
            const hello = noteMemoryTaskHello(frame.memoryTasks);
            if (connectedSocket !== ws) {
                connectedSocket = ws;
                recordClientEvent({ kind: "feed", phase: "connected", attempt: connectAttempt });
            }
            attempt = 0;
            void reconcile(ws, hello);
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

async function connect() {
    if (stopped) {
        return;
    }
    // The attempt this connection is (0 for the first after a `hello`), for its events.
    const connectAttempt = attempt;
    let token: string;
    try {
        token = await getNodeServerProxyAuth();
    } catch (error) {
        console.error("[Live updates]", error);
        if (!stopped) {
            recordClientEvent({ kind: "feed", phase: "connectFailed", attempt: connectAttempt });
        }
        scheduleReconnect();
        return;
    }
    if (stopped) {
        return;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try {
        ws = new WebSocket(`${protocol}//${location.host}${EVENT_FEED_PATH}?risu-auth=${encodeURIComponent(token)}`);
    } catch (error) {
        console.error("[Live updates]", error);
        recordClientEvent({ kind: "feed", phase: "connectFailed", attempt: connectAttempt });
        scheduleReconnect();
        return;
    }
    socket = ws;
    ws.addEventListener("message", (event) => {
        if (socket !== ws) {
            return;
        }
        let frame: unknown;
        try {
            frame = JSON.parse(String(event.data));
        } catch {
            return;
        }
        if (isFrame(frame)) {
            receive(ws, frame, connectAttempt);
        }
    });
    ws.addEventListener("close", (event) => {
        if (socket === ws) {
            socket = null;
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

/** Opens the socket (after the boot read and `startResourceSync`); a second call does nothing. */
export function startEventFeed() {
    if (started) {
        return;
    }
    started = true;
    void connect();
}

/** Closes the socket and stops reconnecting (tests). */
export function stopEventFeed() {
    stopped = true;
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    const ws = socket;
    socket = null;
    ws?.close();
}
