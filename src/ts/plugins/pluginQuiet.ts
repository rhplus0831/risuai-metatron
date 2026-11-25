// Waits for per-plugin quiet periods before a completion notification. Activity and timers are
// injected so the wait can run without a sandbox, and no always-on quiet clocks are needed.

export type PluginQuietTarget = { name: string; quietMs: number };
export type PluginQuietOutcome = "quiet" | "cap" | "aborted";

/** Starts each quiet clock now, restarting only the clocks named by an activity report. */
export function waitForPluginsQuiet(
    targets: readonly PluginQuietTarget[],
    options: {
        capMs: number;
        signal?: AbortSignal;
        busy: (name: string) => boolean;
        onActivity: (listener: (name: string) => void) => () => void;
        timers?: {
            setTimeout: (fn: () => void, ms: number) => unknown;
            clearTimeout: (handle: unknown) => void;
        };
        now?: () => number;
    },
): Promise<PluginQuietOutcome> {
    if (targets.length === 0) return Promise.resolve("quiet");
    if (options.signal?.aborted) return Promise.resolve("aborted");

    const { capMs, signal, busy, onActivity, now = Date.now } = options;
    const timers = options.timers ?? {
        setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
        clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    };
    const startedAt = now();
    const clocks = targets.map(({ name, quietMs }) => ({ name, quietMs, lastActivity: startedAt, busy: false }));

    return new Promise((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | undefined;
        // Wrappers distinguish an absent timer from an injected timer whose handle is undefined.
        let quietTimer: { handle: unknown } | undefined;
        let capTimer: { handle: unknown } | undefined;

        const clearQuietTimer = () => {
            if (quietTimer) {
                timers.clearTimeout(quietTimer.handle);
                quietTimer = undefined;
            }
        };
        const finish = (outcome: PluginQuietOutcome) => {
            if (settled) return;
            settled = true;
            unsubscribe?.();
            clearQuietTimer();
            if (capTimer) {
                timers.clearTimeout(capTimer.handle);
                capTimer = undefined;
            }
            signal?.removeEventListener("abort", abort);
            resolve(outcome);
        };
        const abort = () => finish("aborted");
        const evaluate = (activityName?: string) => {
            if (settled) return;
            clearQuietTimer();
            let anyBusy = false;
            let quietAt = startedAt;
            for (const clock of clocks) {
                // Busy plugins report when work settles; do not poll them on another plugin's report.
                if (!clock.busy || clock.name === activityName) {
                    clock.busy = busy(clock.name);
                }
                anyBusy ||= clock.busy;
                quietAt = Math.max(quietAt, clock.lastActivity + clock.quietMs);
            }
            if (anyBusy) return;
            const remaining = quietAt - now();
            if (remaining <= 0) {
                finish("quiet");
            } else {
                quietTimer = { handle: timers.setTimeout(() => evaluate(), remaining) };
            }
        };
        const activity = (name: string) => {
            if (settled) return;
            const reportedAt = now();
            let matched = false;
            for (const clock of clocks) {
                if (clock.name === name) {
                    clock.lastActivity = reportedAt;
                    matched = true;
                }
            }
            if (matched) evaluate(name);
        };

        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
            finish("aborted");
            return;
        }
        capTimer = { handle: timers.setTimeout(() => finish("cap"), capMs) };
        // Subscription may report activity or abort synchronously, before it returns its cleanup.
        unsubscribe = onActivity(activity);
        if (settled) {
            unsubscribe();
        } else {
            evaluate();
        }
    });
}
