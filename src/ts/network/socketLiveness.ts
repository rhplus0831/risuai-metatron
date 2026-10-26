/**
 * Liveness of this tab's long-lived sockets (the live-update feed, `eventFeed.ts`, and job follows,
 * `generationJobs.ts`). After a mobile freeze a socket can stay `OPEN` with no frames until TCP gives
 * up, minutes later, or stall in `CONNECTING`. The server pings both sockets every 15 s, so a socket
 * with no frame for three heartbeats is taken as dead, and a page that comes back replaces its
 * sockets instead of waiting for them.
 *
 * Stamps read `livenessClock.now()` (tests replace it); the timers are plain `setTimeout` and
 * `setInterval`.
 */

/** How long a connection may take to open, from its start (authentication included). */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How long an open socket may go without a frame (pings included) before it is taken as dead. */
export const STALE_AFTER_MS = 45_000;
/** How often an open socket's last frame is checked. */
export const WATCHDOG_INTERVAL_MS = 15_000;
/** How long the page must have been hidden for its return to visible to count as a resume (two heartbeats). */
export const RESUME_AFTER_HIDDEN_MS = 30_000;
/** The window after a resume trigger in which further triggers are folded into it. */
export const RESUME_FOLD_MS = 250;

export const livenessClock = { now: () => Date.now() };

export type SocketWatch = {
    /** The socket opened: the connect timeout ends and the watchdog starts. */
    opened(): void;
    /** A frame arrived (pings included). */
    frame(): void;
    /** Ends the watch; nothing fires after it. A stopped watch stays stopped. */
    stop(): void;
};

/** The subscribers a pending fold calls (those subscribed when its first trigger came), or null. */
let folding: Set<() => void> | null = null;

/**
 * Watches one connection from its start: `onConnectTimeout` when it has not opened within
 * `CONNECT_TIMEOUT_MS`; once open, `onStale` when it had no frame for `STALE_AFTER_MS`, checked every
 * `WATCHDOG_INTERVAL_MS` while the page is visible (a hidden page's timers are throttled or frozen;
 * the stamp is kept, so the first check after the page is shown again sees a socket that stayed
 * silent meanwhile). The stale check yields while a resume fold is pending, so the resume replaces
 * the socket at the end of its window. Each fires at most once and ends the watch; the caller
 * abandons the socket.
 */
export function watchSocket(handlers: { onConnectTimeout(): void; onStale(): void }): SocketWatch {
    let stopped = false;
    let lastFrame = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        timeout = undefined;
        watch.stop();
        handlers.onConnectTimeout();
    }, CONNECT_TIMEOUT_MS);
    const watch: SocketWatch = {
        opened() {
            if (stopped || interval !== undefined) {
                return;
            }
            clearTimeout(timeout);
            timeout = undefined;
            lastFrame = livenessClock.now();
            interval = setInterval(() => {
                // A pending resume replaces the socket at the end of its fold window.
                if (document.visibilityState !== "visible" || folding) {
                    return;
                }
                if (livenessClock.now() - lastFrame >= STALE_AFTER_MS) {
                    watch.stop();
                    handlers.onStale();
                }
            }, WATCHDOG_INTERVAL_MS);
        },
        frame() {
            if (!stopped) {
                lastFrame = livenessClock.now();
            }
        },
        stop() {
            stopped = true;
            clearTimeout(timeout);
            clearInterval(interval);
            timeout = undefined;
            interval = undefined;
        },
    };
    return watch;
}

/** When the page was hidden (null while it is visible), tracked once for every subscriber. */
let hiddenAt: number | null = null;
let tracking = false;
const subscribers = new Set<() => void>();

function trigger() {
    if (folding) {
        return;
    }
    const due = new Set(subscribers);
    folding = due;
    setTimeout(() => {
        folding = null;
        for (const onResume of due) {
            // One that unsubscribed meanwhile (its socket ended) is not called.
            if (subscribers.has(onResume)) {
                onResume();
            }
        }
    }, RESUME_FOLD_MS);
}

function track() {
    if (tracking) {
        return;
    }
    tracking = true;
    if (document.visibilityState === "hidden") {
        hiddenAt = livenessClock.now();
    }
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            hiddenAt ??= livenessClock.now();
            return;
        }
        if (document.visibilityState !== "visible") {
            return;
        }
        const since = hiddenAt;
        hiddenAt = null;
        if (since !== null && livenessClock.now() - since >= RESUME_AFTER_HIDDEN_MS) {
            trigger();
        }
    });
    // Page Lifecycle: the page was frozen and runs again.
    document.addEventListener("resume", trigger);
    window.addEventListener("online", trigger);
}

/**
 * Calls `onResume` when the page comes back: it becomes visible after being hidden for at least
 * `RESUME_AFTER_HIDDEN_MS` (measured for the page, whenever the subscription started), it resumes
 * from a freeze (Page Lifecycle `resume`), or the browser goes `online`. Triggers within
 * `RESUME_FOLD_MS` of the first are folded into one call, made at the end of that window (a later
 * trigger starts a new one). Returns the unsubscribe; an unsubscribed callback is not called, even
 * by a fold already under way.
 */
export function watchResume(onResume: () => void): () => void {
    track();
    // A wrapper, so the same callback subscribed twice is two subscriptions.
    const subscriber = () => onResume();
    subscribers.add(subscriber);
    return () => {
        subscribers.delete(subscriber);
    };
}
