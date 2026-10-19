// The address `util/agentDev.mjs` binds both of its processes to: loopback unless
// `RISU_AGENT_DEV_HOST` names another one. `localhost` is a secure context, which the tab's login
// (`crypto.subtle`, `src/ts/storage/serverAuth.ts`) and the service worker need; a plain-HTTP
// Tailscale or LAN address is not, so binding to one is opt-in (`RISU_AGENT_DEV_HOST=tailscale`
// looks this machine's Tailscale IPv4 address up and binds only to it, never to the public or LAN
// interfaces).
import { execFileSync } from "node:child_process";
import net from "node:net";

/** @typedef {{ host: string, source: "configured" | "tailscale" | "loopback" }} AgentDevHost */

/** Tailscale's CGNAT range, `100.64.0.0/10`. */
export function isTailscaleIpv4(host) {
    if (!net.isIPv4(host)) {
        return false;
    }
    const [first, second] = host.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127;
}

/** This machine's Tailscale IPv4 address from `tailscale ip -4`, or undefined. */
export function detectTailscaleIpv4() {
    try {
        const output = execFileSync("tailscale", ["ip", "-4"], {
            encoding: "utf8",
            maxBuffer: 4_096,
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2_000,
        });
        return output.split(/\s+/).find(isTailscaleIpv4);
    } catch {
        return undefined;
    }
}

/**
 * `RISU_AGENT_DEV_HOST`: unset is `127.0.0.1`, `tailscale` is the Tailscale address (an error
 * without one), anything else is bound as it is. An IPv6 address is written without brackets (Node
 * and Vite would take `[::1]` for a name to resolve).
 *
 * @param {string | undefined} configured
 * @param {() => string | undefined} [lookupTailscaleIpv4]
 * @returns {AgentDevHost}
 */
export function resolveAgentDevHost(configured, lookupTailscaleIpv4 = detectTailscaleIpv4) {
    const value = configured?.trim();
    if (!value) {
        return { host: "127.0.0.1", source: "loopback" };
    }
    if (value.startsWith("[")) {
        throw new Error(`RISU_AGENT_DEV_HOST: write an IPv6 address without brackets (got ${value})`);
    }
    if (value.toLowerCase() !== "tailscale") {
        return { host: value, source: "configured" };
    }
    const tailscale = lookupTailscaleIpv4();
    if (!tailscale || !isTailscaleIpv4(tailscale)) {
        throw new Error("RISU_AGENT_DEV_HOST=tailscale, but `tailscale ip -4` gave no Tailscale IPv4 address");
    }
    return { host: tailscale, source: "tailscale" };
}
