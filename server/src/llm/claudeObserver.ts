/**
 * The Claude cache-warming observer (`registerClaudeObserver` in `src/ts/observer.svelte.ts`) as one
 * server service: after a request with `claudeRetrivalCaching`, the last body (with `max_tokens`
 * 10) is sent again every 4.5 minutes, at most five times, each retried up to three times on an
 * HTTP error. The client kept one per tab; the server keeps one for all tabs, and its warming
 * requests are not in any tab's request log (recorded). `dispose` stops the timer and any warming
 * request in flight.
 */
export type ClaudeObserver = ReturnType<typeof createClaudeObserver>;

const CHECK_INTERVAL_MS = 20_000;
const WARM_AFTER_MS = 1000 * 60 * 4.5;

export function createClaudeObserver(options: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? Date.now;
    let timer: ReturnType<typeof setInterval> | undefined;
    /** One per registration period: `reset` and `dispose` abort it, so an older attempt never retries. */
    let controller = new AbortController();
    let disposed = false;
    let lastLoad = 0;
    let requestTimes = 0;
    let payload: any = null;
    let headers: { [key: string]: string } = {};
    let url = "";

    const fetchIt = async (
        owner: AbortController,
        target: { url: string; body: string; headers: { [key: string]: string } },
        tries = 0,
    ): Promise<void> => {
        let status = 400;
        try {
            const res = await fetchImpl(target.url, {
                body: target.body,
                headers: { "Content-Type": "application/json", ...target.headers },
                method: "POST",
                signal: owner.signal,
            });
            status = res.status;
            await res.arrayBuffer();
        } catch {
            // A network error retries as an HTTP error does (the client's `globalFetch` answers 400).
        }
        if (owner.signal.aborted || owner !== controller || disposed) {
            return;
        }
        if (status >= 400 && tries < 3) {
            void fetchIt(owner, target, tries + 1);
        }
    };

    const tick = () => {
        if (!payload || lastLoad > now() - WARM_AFTER_MS) {
            return;
        }
        if (requestTimes > 4) {
            return;
        }
        void fetchIt(controller, { url, body: JSON.stringify(payload), headers });
        lastLoad = now();
        requestTimes += 1;
    };

    /** Forgets the registered request (its body and credentials) and stops every warming attempt. */
    const forget = () => {
        controller.abort();
        controller = new AbortController();
        payload = null;
        headers = {};
        url = "";
        requestTimes = 0;
    };

    return {
        register(arg: { url: string; body: any; headers: { [key: string]: string } }) {
            if (disposed) {
                return;
            }
            requestTimes = 0;
            lastLoad = now();
            payload = structuredClone(arg.body);
            headers = { ...arg.headers };
            url = arg.url;
            payload.max_tokens = 10;
            if (!timer) {
                timer = setInterval(tick, CHECK_INTERVAL_MS);
                timer.unref?.();
            }
        },
        /** Maintenance replaced the settings: the old request (and its key) is not warmed again. */
        reset() {
            forget();
        },
        /** Stops for good: later registrations are ignored. */
        dispose() {
            disposed = true;
            clearInterval(timer);
            timer = undefined;
            forget();
        },
    };
}
