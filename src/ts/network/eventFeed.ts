import { EVENT_FEED_PATH, type EventFeedFrame } from "../../../shared/events.ts";
import { revisionDigest, type ChangeSet, type ResourceRevisionListing } from "../../../shared/resources.ts";
import {
    epochMismatch,
    getResourceEpoch,
    listChanges,
    listRevisions,
    ResourceEpochMismatchError,
} from "../storage/resourceClient";
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
 * changes arrive as refs and revisions and go to `src/ts/storage/resourceSync.svelte.ts`
 * (`noteRemoteChanges`), which reads and applies what this tab holds. On every `hello` (connect,
 * reconnect, a server restart) the tab reconciles against server revisions: its advertised map when
 * the hello's digest matches, otherwise a bounded log replay into a copy frozen at hello. Only a
 * replay matching that digest can replace the whole listing read. The map tracks advertised
 * revisions independently of held records and overlays changes received during either read, after
 * the hello-time listing has reached reconciliation and memory fences. Every connection signs a
 * fresh JWT (they live five minutes). A `hello` or `epoch` frame of another epoch means a restore replaced the data: the
 * save loop halts and the page reloads; `change` and `memoryTask` frames of another epoch are
 * ignored. A `change` frame's refs are dispatched before its generation locks (`streaming`) go to
 * `src/ts/storage/chatStore.svelte.ts` (`noteRemoteStreaming`), so a fitting `begin` patch puts the
 * row in the mirror before its lock. For a chat the mirror lacks, an unloaded chat, or a patch that
 * does not fit, the lock is installed by id and the row arrives locked with the read. A `hello`
 * replaces the feed's whole lock set with the server's snapshot before reconciliation starts.
 *
 * One connection is current at a time (`generation`). A connection that has not opened within 10 s
 * (authentication included) or that has had no frame for 45 s while the page is visible is
 * abandoned without waiting for its `close`, and reconnects with the backoff. Liveness and resume
 * triggers are in `src/ts/network/socketLiveness.ts`. When the page comes back (visible after 30 s
 * hidden, a Page Lifecycle `resume`, `online`; triggers that come together are folded) the
 * connection is replaced after that fold, even during a retry's wait: a half-open socket after a
 * freeze would otherwise deliver nothing until TCP gives up.
 *
 * HypaV3 memory task statuses go to `src/ts/process/memoryTasks.svelte.ts`: a `memoryTask` frame of
 * the loaded epoch as it comes, a `hello`'s snapshot as the whole status set, and the fetched or
 * replayed or digest-matched revision listing (before reconciliation) for the chats whose fences
 * wait for it. A mismatching `hello`/`epoch` or read epoch error resets them and the advertised map.
 */

const MAX_BACKOFF_MS = 30_000;
/**
 * How long a connection's replay and fallback listing together may take. Heartbeats keep a socket
 * alive while its HTTP read is stuck, so reconciliation has its own bound: past it the read is
 * aborted and the socket closed (reconnecting reconciles again).
 */
export const RECONCILE_DEADLINE_MS = 30_000;

let started = false;
let stopped = false;
/**
 * The current connection's number. A connection's authentication, socket, `hello`, reconcile, and
 * `close` act only while it is current: a new connection, an abandoned one, an ended attempt (its
 * close, a failed authentication), and the stop each move it on, so every late result of an older
 * connection does nothing, except that an epoch-mismatch error of an older connection's read
 * still resets the memory tasks and advertised map (the data was replaced, whichever connection read it).
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

type RevisionMap = {
    [K in keyof ChangeSet]: Map<string, ResourceRevisionListing[K][number] | null>;
};
/** All rows at the server's advertised revisions, never this tab's held revisions. */
let advertised: { epoch: string; rows: RevisionMap } | null = null;
/** Newest cursor advertised with this map, cleared with it; absent on older servers. */
let heldCursor: number | null = null;
/** Changes since this connection's hello while replay or listing is pending; null rows are tombstones. */
let listingOverlay: RevisionMap | null = null;

function emptyRevisionMap(): RevisionMap {
    return { resources: new Map(), chats: new Map(), chatOrders: new Map() };
}

function setRevisionRow<T>(rows: Map<string, T | null>, key: string, row: T | null, keepDeletes: boolean) {
    if (row === null && !keepDeletes) rows.delete(key);
    else rows.set(key, row);
}

/** Copy revision information only; neither the map nor its overlay retains patches. */
function applyRevisionChanges(rows: RevisionMap, changes: ChangeSet, keepDeletes = false) {
    for (const { kind, id, revision } of changes.resources) {
        setRevisionRow(
            rows.resources,
            JSON.stringify([kind, id]),
            revision === null ? null : { kind, id, revision },
            keepDeletes,
        );
    }
    for (const { characterId, id, revision } of changes.chats) {
        setRevisionRow(
            rows.chats,
            JSON.stringify([characterId, id]),
            revision === null ? null : { characterId, id, revision },
            keepDeletes,
        );
    }
    for (const { characterId, revision } of changes.chatOrders) {
        setRevisionRow(rows.chatOrders, characterId, revision === null ? null : { characterId, revision }, keepDeletes);
    }
}

function overlayRevisionRows<T>(rows: Map<string, T | null>, overlay: Map<string, T | null>) {
    for (const [key, row] of overlay) setRevisionRow(rows, key, row, false);
}

function seedAdvertised(listing: ResourceRevisionListing, overlay: RevisionMap) {
    const rows = emptyRevisionMap();
    applyRevisionChanges(rows, listing);
    overlayRevisionRows(rows.resources, overlay.resources);
    overlayRevisionRows(rows.chats, overlay.chats);
    overlayRevisionRows(rows.chatOrders, overlay.chatOrders);
    advertised = { epoch: listing.epoch, rows };
}

function advertisedListing(): ResourceRevisionListing | null {
    if (!advertised) return null;
    return revisionListing(advertised.epoch, advertised.rows);
}

function revisionListing(epoch: string, rows: RevisionMap): ResourceRevisionListing {
    return {
        epoch,
        resources: [...rows.resources.values()].filter((row) => row !== null),
        chats: [...rows.chats.values()].filter((row) => row !== null),
        chatOrders: [...rows.chatOrders.values()].filter((row) => row !== null),
    };
}

function clearAdvertised() {
    advertised = null;
    heldCursor = null;
    listingOverlay = null;
}

function isCursor(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFrame(value: unknown): value is EventFeedFrame {
    return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/**
 * Ends the current connection's attempt without closing anything: its late results do nothing,
 * except that an epoch-mismatch error of its read still resets the memory tasks and advertised map.
 */
function retire() {
    generation += 1;
    listingOverlay = null;
    liveness?.stop();
    liveness = null;
    socket = null;
}

/**
 * Retry with a base of 1 s doubling to 30 s, jittered between half that base and the base. Only a
 * successful reconcile resets the attempt count: accepting a socket without a usable revision
 * listing must keep backing off. A pending retry is shared until it fires or a resume replaces it.
 */
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

/**
 * The HTTP replay and fallback listing share a deadline even while socket pings arrive. A failure
 * other than an epoch mismatch closes this connection and schedules its retry here, since a dead
 * link may never deliver `close`. The replayed or fetched snapshot goes unchanged to `src/ts/process/memoryTasks.svelte.ts`
 * and `src/ts/storage/resourceSync.svelte.ts`; only the advertised map receives the concurrent
 * overlay.
 */
async function reconcile(
    gen: number,
    ws: WebSocket,
    hello: number,
    digest: string | undefined,
    helloCursor: number | undefined,
    connectAttempt: number,
) {
    try {
        if (gen !== generation) return;
        let listing = advertised?.epoch === getResourceEpoch() ? advertisedListing() : null;
        let overlay: RevisionMap | null = null;
        if (!listing || typeof digest !== "string" || revisionDigest(listing) !== digest) {
            // Freeze before the first await: live frames keep changing advertised and the overlay,
            // but cannot enter the map whose digest must describe the hello's committed state.
            const since = heldCursor;
            const frozen =
                listing && advertised && since !== null && isCursor(helloCursor) && typeof digest === "string"
                    ? {
                          resources: new Map(advertised.rows.resources),
                          chats: new Map(advertised.rows.chats),
                          chatOrders: new Map(advertised.rows.chatOrders),
                      }
                    : null;
            const epoch = listing?.epoch;
            listing = null;
            overlay = emptyRevisionMap();
            listingOverlay = overlay;
            // A replaced connection's read is not aborted early: its epoch-mismatch error still counts.
            const abort = new AbortController();
            const timer = setTimeout(
                () => abort.abort(new Error("Live update listing timed out")),
                RECONCILE_DEADLINE_MS,
            );
            // The abort settles either wait even if the transport does not stop at it.
            const read = <T>(request: () => Promise<T>): Promise<T> =>
                new Promise((resolve, reject) => {
                    if (abort.signal.aborted) return reject(abort.signal.reason);
                    const onAbort = () => reject(abort.signal.reason);
                    abort.signal.addEventListener("abort", onAbort, { once: true });
                    request()
                        .then(resolve, reject)
                        .finally(() => abort.signal.removeEventListener("abort", onAbort));
                });
            try {
                if (frozen && epoch !== undefined && since !== null && isCursor(helloCursor)) {
                    const replay = await read(() =>
                        listChanges({ since, until: helloCursor, epoch, signal: abort.signal }),
                    );
                    if (gen !== generation) return;
                    if (!replay.expired && replay.changes && replay.cursor === helloCursor) {
                        applyRevisionChanges(frozen, replay.changes, true);
                        const replayed = revisionListing(epoch, frozen);
                        if (revisionDigest(replayed) === digest) listing = replayed;
                    }
                }
                if (!listing) listing = await read(() => listRevisions({ signal: abort.signal }));
            } finally {
                clearTimeout(timer);
            }
            if (gen !== generation) return;
        }
        if (gen === generation) {
            // Fences use the replayed or fetched listing, never its overlay: a stale deletion in that
            // overlay must not release a fence for a chat the server has since recreated.
            noteMemoryTaskListing(hello, listing);
            reconcileRemote(listing);
            // Only the advertised map takes post-hello changes; fences and reconciliation saw the
            // unoverlaid replay or listing, including the final incarnation of every recreated chat.
            if (overlay) seedAdvertised(listing, overlay);
            listingOverlay = null;
            if (isCursor(helloCursor)) heldCursor = Math.max(heldCursor ?? 0, helloCursor);
            // Only a reconciled connection resets the backoff: a server that accepts the socket but fails the reconcile keeps backing off.
            attempt = 0;
        }
    } catch (error) {
        // The data was replaced, whichever connection read it.
        if (error instanceof ResourceEpochMismatchError) {
            clearAdvertised();
            resetMemoryTasks();
            return;
        }
        if (gen !== generation) {
            return;
        }
        console.error("[Live updates]", error);
        // Reconnecting reconciles again. It is scheduled here rather than by the socket's `close`,
        // which a dead link may never fire.
        retire();
        ws.close();
        recordClientEvent({ kind: "feed", phase: "disconnected", attempt: connectAttempt });
        scheduleReconnect();
    }
}

function receive(gen: number, ws: WebSocket, frame: EventFeedFrame, connectAttempt: number) {
    const loaded = getResourceEpoch();
    switch (frame.type) {
        case "hello":
            if (frame.epoch !== loaded) {
                clearAdvertised();
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
            void reconcile(gen, ws, hello, frame.digest, frame.cursor, connectAttempt);
            return;
        case "change":
            if (frame.epoch === loaded) {
                if (isCursor(frame.cursor)) heldCursor = Math.max(heldCursor ?? 0, frame.cursor);
                if (advertised?.epoch === loaded) applyRevisionChanges(advertised.rows, frame.changes);
                if (listingOverlay) applyRevisionChanges(listingOverlay, frame.changes, true);
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
                clearAdvertised();
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
        ws = new WebSocket(
            `${protocol}//${location.host}${EVENT_FEED_PATH}?risu-auth=${encodeURIComponent(token)}&proto=1`,
        );
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
    clearAdvertised();
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
