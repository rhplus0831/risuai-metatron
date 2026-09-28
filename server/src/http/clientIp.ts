import type { Context } from "hono";
import proxyaddr from "proxy-addr";
import type { AppEnv } from "../types.ts";

export type TrustFn = (addr: string, hop: number) => boolean;

/**
 * Same conversion Express got from `app.set("trust proxy", Number(v) || v)`.
 * Unset keeps Express's default (`false`): trust no proxy, use the socket address.
 */
export function parseTrustProxyEnv(value: string | undefined): number | string | false {
    if (!value) {
        return false;
    }
    return Number(value) || value;
}

/**
 * Port of `compileTrust` from express/lib/utils.js, so TRUST_PROXY keeps its Express meaning:
 * a number trusts that many hops, a string is a comma list of addresses, CIDRs, or the
 * proxy-addr names (`loopback`, `linklocal`, `uniquelocal`).
 */
export function compileTrust(value: number | string | boolean): TrustFn {
    if (value === true) {
        return () => true;
    }
    if (typeof value === "number") {
        return (_addr, hop) => hop < value;
    }
    const list = typeof value === "string" ? value.split(",").map((v) => v.trim()) : [];
    return proxyaddr.compile(list);
}

/** Express `req.ip`. Undefined when the request has no Node socket (e.g. `app.request()`). */
export function getClientIp(c: Context<AppEnv>, trust: TrustFn): string | undefined {
    const incoming = c.env?.incoming;
    if (!incoming?.socket) {
        return undefined;
    }
    return proxyaddr(incoming, trust);
}
