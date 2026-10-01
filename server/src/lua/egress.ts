import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

/**
 * The egress guard of Lua's `request(id, url)`, ported from the previous attempt's runtime: HTTPS
 * only, at most 120 characters, the client's three banned prefixes, no `localhost`, and every
 * resolved address public; the connection is pinned to a validated address, so DNS cannot rebind
 * it. It runs on the main thread, so its rate counter is the server's, whichever worker asks.
 */
export const MAX_URL_LENGTH = 120;
export const MAX_REQUESTS_PER_WINDOW = 30;
export const REQUEST_WINDOW_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 2_000_000;

const BANNED_URL_PREFIXES = ["https://realm.risuai.net", "https://risuai.net", "https://risuai.xyz"];

/** Seams for tests: name resolution, the fetch against validated addresses, and the clock. */
export type EgressDeps = {
    lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
    fetchImpl?: (url: string, addresses: string[], signal?: AbortSignal) => Promise<{ status: number; data: string }>;
    now?: () => number;
};

export type EgressVerdict = { ok: true; addresses: string[] } | { ok: false; status: number; data: string };

export class EgressAbortError extends Error {
    constructor() {
        super("request aborted");
    }
}

/** Unicast ranges that are still not public targets: benchmarking, site-local, local-use NAT64,
 * IPv4-compatible, discard-only, documentation, IETF protocol assignments, ORCHIDv2, and SRv6. */
const BLOCKED_UNICAST = [
    "198.18.0.0/15",
    "fec0::/10",
    "64:ff9b:1::/48",
    "::/96",
    "100::/64",
    "3fff::/20",
    "2001::/23",
    "5f00::/16",
].map((cidr) => ipaddr.parseCIDR(cidr));

/**
 * True for an address the server must not connect to: anything `ipaddr.js` does not class as
 * unicast (private, loopback, link-local, CGNAT, multicast, reserved and documentation, broadcast,
 * unspecified, ULA, Teredo), the unicast ranges above, and the IPv4-mapped, NAT64, and 6to4 forms
 * whose embedded IPv4 address is blocked. An address that does not parse is blocked.
 */
export function isBlockedAddress(addr: string): boolean {
    if (typeof addr !== "string") {
        return true;
    }
    const zone = addr.indexOf("%");
    let parsed: ipaddr.IPv4 | ipaddr.IPv6;
    try {
        parsed = ipaddr.parse((zone === -1 ? addr : addr.slice(0, zone)).trim());
    } catch {
        return true;
    }
    if (parsed.kind() === "ipv6") {
        const v6 = parsed as ipaddr.IPv6;
        const range = v6.range();
        if (range === "ipv4Mapped" || range === "rfc6052") {
            const [hi, lo] = v6.parts.slice(6);
            return isBlockedAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
        }
        if (range === "6to4") {
            const [hi, lo] = v6.parts.slice(1, 3);
            return isBlockedAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
        }
    }
    if (parsed.range() !== "unicast") {
        return true;
    }
    return BLOCKED_UNICAST.some(([network, bits]) =>
        parsed.kind() === "ipv4"
            ? network.kind() === "ipv4" && (parsed as ipaddr.IPv4).match(network as ipaddr.IPv4, bits)
            : network.kind() === "ipv6" && (parsed as ipaddr.IPv6).match(network as ipaddr.IPv6, bits),
    );
}

/** A historical prefix, or the same hosts after URL parsing (case, user info). */
function isBannedTarget(url: string, hostname: string): boolean {
    const host = hostname.toLowerCase();
    return BANNED_URL_PREFIXES.some(
        (prefix) => url.startsWith(prefix) || host.startsWith(prefix.slice("https://".length)),
    );
}

/** Settles with `promise`, or rejects when `signal` aborts first (the late answer is ignored). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        return Promise.reject(new EgressAbortError());
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new EgressAbortError());
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

/** Checks a URL before any socket opens, and returns the addresses to pin the connection to. */
export async function validateEgressUrl(
    url: string,
    deps: EgressDeps = {},
    signal?: AbortSignal,
): Promise<EgressVerdict> {
    if (typeof url !== "string" || url.length > MAX_URL_LENGTH) {
        return { ok: false, status: 413, data: "URL to large. max is 120 characters" };
    }
    if (!url.startsWith("https://")) {
        return { ok: false, status: 400, data: "Only https requests are allowed" };
    }
    let hostname: string;
    try {
        hostname = new URL(url).hostname;
    } catch {
        return { ok: false, status: 400, data: "Invalid URL" };
    }
    if (isBannedTarget(url, hostname)) {
        return { ok: false, status: 400, data: "request to " + url + " is not allowed" };
    }
    const host = hostname.replace(/^\[|\]$/g, "");
    const lower = host.toLowerCase();
    if (lower === "localhost" || lower.endsWith(".localhost")) {
        return { ok: false, status: 403, data: "Requests to localhost are not allowed" };
    }
    const blocked: EgressVerdict = {
        ok: false,
        status: 403,
        data: "Requests to private or reserved addresses are not allowed",
    };
    if (isIP(host)) {
        return isBlockedAddress(host) ? blocked : { ok: true, addresses: [host] };
    }
    let resolved: Array<{ address: string; family: number }>;
    try {
        resolved = await raceAbort(deps.lookup ? deps.lookup(host) : dnsLookup(host, { all: true }), signal);
    } catch (error) {
        if (error instanceof EgressAbortError) {
            throw error;
        }
        return { ok: false, status: 400, data: "DNS resolution failed" };
    }
    if (!resolved || resolved.length === 0) {
        return { ok: false, status: 400, data: "DNS resolution failed" };
    }
    if (resolved.some((entry) => isBlockedAddress(entry.address))) {
        return blocked;
    }
    return { ok: true, addresses: resolved.map((entry) => entry.address) };
}

/**
 * An HTTPS GET pinned to the first validated address (the URL's hostname still drives SNI and the
 * certificate check), without redirects, capped at 2 MB. `signal` carries the whole request's
 * deadline; the promise settles once, on the body's end or on any failure.
 */
export function pinnedHttpsFetch(
    url: string,
    addresses: string[],
    signal?: AbortSignal,
): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new EgressAbortError());
            return;
        }
        const pinned = addresses[0];
        const family = isIP(pinned);
        // Node may ask for every address (`all: true`, for family autoselection) or for one.
        const pinnedLookup = (_hostname: string, options: unknown, callback?: unknown) => {
            const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
            if (typeof options === "object" && options !== null && (options as { all?: boolean }).all) {
                cb(null, [{ address: pinned, family }]);
            } else {
                cb(null, pinned, family);
            }
        };
        let settled = false;
        const settle = (error: Error | null, value?: { status: number; data: string }) => {
            if (settled) {
                return;
            }
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            if (error) {
                req.destroy();
                reject(error);
            } else {
                resolve(value!);
            }
        };
        const req = httpsRequest(url, { method: "GET", lookup: pinnedLookup as never }, (res) => {
            let body = "";
            let size = 0;
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                size += Buffer.byteLength(chunk, "utf8");
                if (size > MAX_RESPONSE_BYTES) {
                    settle(new Error("response too large"));
                    return;
                }
                body += chunk;
            });
            res.on("end", () => settle(null, { status: res.statusCode ?? 0, data: body }));
            res.on("aborted", () => settle(new Error("response aborted")));
            res.on("error", (error) => settle(error));
            res.on("close", () => settle(new Error("response closed before its end")));
        });
        const onAbort = () => settle(new EgressAbortError());
        signal?.addEventListener("abort", onAbort, { once: true });
        req.on("error", (error) => settle(error));
        req.end();
    });
}

/** A fixed window from its first request: 30 validated requests per minute. */
export type RequestLimiter = { exhausted(now: number): boolean; take(now: number): boolean };

export function createRequestLimiter(): RequestLimiter {
    let count = 0;
    let resetAt = 0;
    const roll = (now: number) => {
        if (resetAt + REQUEST_WINDOW_MS < now) {
            count = 0;
            resetAt = now;
        }
    };
    return {
        exhausted(now) {
            roll(now);
            return count >= MAX_REQUESTS_PER_WINDOW;
        },
        take(now) {
            roll(now);
            if (count >= MAX_REQUESTS_PER_WINDOW) {
                return false;
            }
            count++;
            return true;
        },
    };
}

/**
 * The `request` host function's body: check the window, validate, count, fetch, within one 10 s
 * deadline. It answers the client's `{ status, data }` JSON string (408 on the deadline, 400 on
 * another failure). Only a validated request counts against the window, so a blocked URL cannot
 * use up the budget. An abort rejects instead of answering, so the Lua run unwinds.
 */
export async function serverLuaRequest(
    url: string,
    options: { limiter: RequestLimiter; deps?: EgressDeps; signal?: AbortSignal },
): Promise<string> {
    const deps = options.deps ?? {};
    const now = () => (deps.now ? deps.now() : Date.now());
    const tooMany = JSON.stringify({ status: 429, data: "Too many requests. you can request 30 times per minute" });
    if (options.limiter.exhausted(now())) {
        return tooMany;
    }
    // One deadline covers name resolution, the connection, and the body.
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
        const verdict = await validateEgressUrl(url, deps, signal);
        if (!verdict.ok) {
            return JSON.stringify({ status: verdict.status, data: verdict.data });
        }
        // Another run may have taken the last slot while this one resolved its name.
        if (!options.limiter.take(now())) {
            return tooMany;
        }
        const result = await raceAbort((deps.fetchImpl ?? pinnedHttpsFetch)(url, verdict.addresses, signal), signal);
        if (Buffer.byteLength(result.data, "utf8") > MAX_RESPONSE_BYTES) {
            throw new Error("response too large");
        }
        return JSON.stringify({ status: result.status, data: result.data });
    } catch (error) {
        if (options.signal?.aborted) {
            throw new EgressAbortError();
        }
        if (deadline.aborted) {
            return JSON.stringify({ status: 408, data: "request timeout" });
        }
        return JSON.stringify({ status: 400, data: "internal error" });
    }
}
