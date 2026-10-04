import { EVENT_FEED_PATH, type EventFeedFrame } from "../../../shared/events.ts";
import { epochMismatch, getResourceEpoch, listRevisions, ResourceEpochMismatchError } from "../storage/resourceClient";
import { getNodeServerProxyAuth } from "../storage/nodeStorage";
import { noteRemoteChanges, reconcileRemote } from "../storage/resourceSync.svelte";

/**
 * The live-update socket (Phase 6, `server/src/routes/events.ts`): another tab's or device's
 * committed changes arrive as refs and revisions and go to the save loop (`noteRemoteChanges`), which
 * reads and applies what this tab holds. On every `hello` (connect, reconnect, a server restart) the
 * tab reconciles against the revision listing, so nothing committed while it was disconnected is
 * missed. Every connection signs a fresh JWT (they live five minutes). A frame of another epoch, or
 * an `epoch` frame, means a restore replaced the data: the save loop halts and the page reloads.
 */

const MAX_BACKOFF_MS = 30_000;

let started = false;
let stopped = false;
let socket: WebSocket | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

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

async function reconcile(ws: WebSocket) {
    try {
        const listing = await listRevisions();
        if (socket === ws) {
            reconcileRemote(listing);
        }
    } catch (error) {
        if (error instanceof ResourceEpochMismatchError) {
            return;
        }
        console.error("[Live updates]", error);
        // Reconnecting reconciles again.
        ws.close();
    }
}

function receive(ws: WebSocket, frame: EventFeedFrame) {
    const loaded = getResourceEpoch();
    switch (frame.type) {
        case "hello":
            if (frame.epoch !== loaded) {
                epochMismatch(frame.epoch);
                return;
            }
            attempt = 0;
            void reconcile(ws);
            return;
        case "change":
            if (frame.epoch === loaded) {
                noteRemoteChanges(frame.changes);
            }
            return;
        case "epoch":
            if (frame.epoch !== loaded) {
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
    let token: string;
    try {
        token = await getNodeServerProxyAuth();
    } catch (error) {
        console.error("[Live updates]", error);
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
            receive(ws, frame);
        }
    });
    ws.addEventListener("close", () => {
        if (socket === ws) {
            socket = null;
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
