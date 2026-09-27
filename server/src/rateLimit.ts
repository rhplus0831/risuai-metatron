import type { Context, MiddlewareHandler } from "hono";
import ipaddr from "ipaddr.js";
import type { AppEnv } from "./types.ts";

type Hits = { count: number; resetAt: number };

export type RateLimiter = {
    middleware: MiddlewareHandler<AppEnv>;
    dispose: () => void;
};

/**
 * Key like express-rate-limit v8 `ipKeyGenerator(ip, 56)`: IPv4-mapped IPv6 collapses to IPv4,
 * other IPv6 addresses share a key per /56.
 */
export function rateLimitKey(ip: string | undefined): string {
    if (!ip) {
        return "unknown";
    }
    try {
        const parsed = ipaddr.parse(ip);
        if (parsed.kind() !== "ipv6") {
            return ip;
        }
        const v6 = parsed as ipaddr.IPv6;
        if (v6.isIPv4MappedAddress()) {
            return v6.toIPv4Address().toString();
        }
        const parts = v6.parts.slice();
        parts[3] &= 0xff00;
        parts.fill(0, 4);
        return `${new ipaddr.IPv6(parts).toString()}/56`;
    } catch {
        return ip;
    }
}

function setHeaders(res: Response, headers: Record<string, string>): Response {
    try {
        for (const [k, v] of Object.entries(headers)) {
            res.headers.set(k, v);
        }
        return res;
    } catch {
        // Immutable headers: re-wrap once.
        const copy = new Response(res.body, res);
        for (const [k, v] of Object.entries(headers)) {
            copy.headers.set(k, v);
        }
        return copy;
    }
}

/**
 * In-memory limiter matching the express-rate-limit v8 defaults this server used:
 * MemoryStore windows start at a key's first hit, requests beyond `limit` get 429,
 * and `standardHeaders: true` emits the draft-6 `RateLimit-*` headers.
 */
export function createRateLimiter(arg: {
    windowMs: number;
    limit: number;
    message: string;
    keyOf: (c: Context<AppEnv>) => string | undefined;
}): RateLimiter {
    const store = new Map<string, Hits>();
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, hits] of store) {
            if (hits.resetAt <= now) {
                store.delete(key);
            }
        }
    }, arg.windowMs);
    sweep.unref();

    const middleware: MiddlewareHandler<AppEnv> = async (c, next) => {
        const now = Date.now();
        const key = rateLimitKey(arg.keyOf(c));
        let hits = store.get(key);
        if (!hits || hits.resetAt <= now) {
            hits = { count: 0, resetAt: now + arg.windowMs };
            store.set(key, hits);
        }
        hits.count++;

        const resetSec = Math.max(0, Math.ceil((hits.resetAt - now) / 1000));
        const headers: Record<string, string> = {
            "RateLimit-Policy": `${arg.limit};w=${Math.ceil(arg.windowMs / 1000)}`,
            "RateLimit-Limit": String(arg.limit),
            "RateLimit-Remaining": String(Math.max(0, arg.limit - hits.count)),
            "RateLimit-Reset": String(resetSec),
        };

        if (hits.count > arg.limit) {
            return c.json({ error: arg.message }, 429, { ...headers, "Retry-After": String(resetSec) });
        }

        await next();
        const res = setHeaders(c.res, headers);
        if (res !== c.res) {
            c.res = res;
        }
    };

    return {
        middleware,
        dispose: () => {
            clearInterval(sweep);
            store.clear();
        },
    };
}
