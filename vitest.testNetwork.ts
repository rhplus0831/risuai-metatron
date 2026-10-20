// Network policy for unit tests. `vitest.setup.ts` routes the global `fetch`, `WebSocket`, Node's
// undici dispatcher, and happy-dom's own loader (XHR, scripts, iframes) through
// `testNetwork.check`, so a test that would reach a provider, Realm, a CDN, or the open internet
// fails instead of passing or failing with the network. Allowed: `data:` and `blob:` URLs, and the
// exact loopback origins a test registered with `allowTestLoopbackOrigin` (a server it started
// itself). Everything else is refused, relative URLs included. Raw `node:http`/`https`/`net`/`tls`
// sockets are not guarded.
//
// Ported from RisuNest `tests/support/testNetwork.ts`. Unlike there, `finish` (after each test)
// clears only the recorded refusals: suites start an upstream in `beforeAll` and reuse it, so a
// registration lasts until its unregister call.
//
// This file imports nothing: `vitest.setup.ts` loads it before its happy-dom shim runs.

const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];

function requestUrl(input: unknown): unknown {
    return typeof input === "object" && input !== null && "url" in input ? input.url : input;
}

function describeInput(input: unknown): string {
    const text = String(requestUrl(input));
    return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** Returns why the request is refused, or null when it is allowed. */
export function classifyTestRequest(input: unknown, origins: { has(origin: string): boolean }): string | null {
    let url: URL;
    try {
        url = new URL(String(requestUrl(input)));
    } catch {
        return "relative or invalid URL";
    }
    if (url.protocol === "data:" || url.protocol === "blob:") return null;
    // A socket is allowed when its origin's HTTP requests are.
    if (url.protocol === "ws:") url = new URL(`http:${url.href.slice("ws:".length)}`);
    else if (url.protocol === "wss:") url = new URL(`https:${url.href.slice("wss:".length)}`);
    if ((url.protocol === "http:" || url.protocol === "https:") && origins.has(url.origin)) return null;
    return "unregistered origin";
}

export function createTestNetworkPolicy() {
    // Origin -> registration count, so two registrations of one origin need two unregisters.
    const origins = new Map<string, number>();
    const refused: string[] = [];
    return {
        /**
         * Allows requests to `origin`, an exact `http(s)://127.0.0.1|[::1]|localhost:<port>` origin,
         * until the returned function is called. `ws:`/`wss:` follow their HTTP origin.
         */
        allowLoopbackOrigin(origin: string): () => void {
            let url: URL;
            try {
                url = new URL(origin);
            } catch {
                throw new Error(`Expected an exact loopback origin, got ${origin}`);
            }
            if (
                (url.protocol !== "http:" && url.protocol !== "https:") ||
                !LOOPBACK_HOSTS.includes(url.hostname) ||
                url.origin !== origin
            ) {
                throw new Error(`Expected an exact loopback origin, got ${origin}`);
            }
            origins.set(origin, (origins.get(origin) ?? 0) + 1);
            let active = true;
            return () => {
                if (!active) return;
                active = false;
                const count = (origins.get(origin) ?? 0) - 1;
                if (count > 0) origins.set(origin, count);
                else origins.delete(origin);
            };
        },
        /** Throws (and records the refusal) when `input` is not allowed. */
        check(input: unknown): void {
            const reason = classifyTestRequest(input, origins);
            if (!reason) return;
            const message = `Blocked test network request (${reason}): ${describeInput(input)}`;
            refused.push(message);
            throw new Error(
                `${message}. Stub fetch (or the module that fetches), or register a server the test started with allowTestLoopbackOrigin.`,
            );
        },
        /** Throws when a request was refused since the last call, even if the caller caught it. */
        finish(): void {
            const failures = refused.splice(0);
            if (failures.length) {
                throw new Error(`Blocked test network requests (${failures.length}):\n${failures.join("\n")}`);
            }
        },
        /** Origins still registered. */
        registeredOrigins(): string[] {
            return [...origins.keys()];
        },
    };
}

export type TestNetworkPolicy = ReturnType<typeof createTestNetworkPolicy>;

export const testNetwork = createTestNetworkPolicy();

/** See `TestNetworkPolicy.allowLoopbackOrigin`. */
export function allowTestLoopbackOrigin(origin: string): () => void {
    return testNetwork.allowLoopbackOrigin(origin);
}
