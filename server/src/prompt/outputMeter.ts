import type { GenerationProgressEntry } from "../../../shared/events.ts";
import { logEvent } from "../diagnostics/log.ts";

/** Minimum time between the starts of local output counts. */
export const OUTPUT_COUNT_INTERVAL_MS = 500;

/**
 * Counts cumulative raw reply snapshots without blocking their delivery. Extensions count only their
 * suffix; rewrites replace the total. Pending text is counted when the interval and any active count
 * allow it, even if the provider stalls. Stopping discards pending work and late results.
 */
export function createOutputMeter(options: {
    count: (text: string) => Promise<number>;
    report: (output: NonNullable<GenerationProgressEntry["output"]>) => void | Promise<void>;
    now?: () => number;
    log?: (error: unknown) => void;
    setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
    const now = options.now ?? Date.now;
    const log = options.log ?? ((error: unknown) => logEvent("generation.outputCount", {}, error));
    const schedule = options.setTimeout ?? setTimeout;
    const cancel = options.clearTimeout ?? clearTimeout;
    let newest = "";
    let counted = "";
    let tokens = 0;
    let since: number | undefined;
    let lastStarted = -Infinity;
    let inFlight = false;
    let stopped = false;
    let logged = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function logOnce(error: unknown) {
        if (logged) return;
        logged = true;
        try {
            log(error);
        } catch {}
    }

    function clearTimer() {
        const pending = timer;
        timer = null;
        if (pending !== null) cancel(pending);
    }

    function stop() {
        stopped = true;
        try {
            clearTimer();
        } catch (error) {
            logOnce(error);
        }
    }

    function fail(error: unknown) {
        stop();
        logOnce(error);
    }

    async function countText(text: string, suffix: string, base: number) {
        try {
            const count = await options.count(suffix);
            if (stopped) return;
            tokens = base + count;
            counted = text;
            await options.report({ tokens, since: since!, at: now() });
        } catch (error) {
            fail(error);
        } finally {
            inFlight = false;
            pump();
        }
    }

    function pump() {
        try {
            if (stopped || inFlight || newest === counted) return;
            const at = now();
            const delay = OUTPUT_COUNT_INTERVAL_MS - (at - lastStarted);
            if (delay > 0) {
                timer ??= schedule(() => {
                    timer = null;
                    pump();
                }, delay);
                return;
            }
            clearTimer();
            const text = newest;
            const extendsCounted = text.startsWith(counted);
            lastStarted = at;
            inFlight = true;
            void countText(text, extendsCounted ? text.slice(counted.length) : text, extendsCounted ? tokens : 0);
        } catch (error) {
            fail(error);
        }
    }

    return {
        note(raw: string) {
            try {
                if (stopped) return;
                newest = raw;
                if (raw.length > 0) since ??= now();
                pump();
            } catch (error) {
                fail(error);
            }
        },
        stop,
    };
}
