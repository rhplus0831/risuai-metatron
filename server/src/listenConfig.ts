import net from "node:net";
import path from "node:path";

/**
 * Where `main.ts` listens and stores, from its environment. `PORT` (default 6001) and `RISU_HOST`
 * (unset: every interface, Node's default) pick the listener; `RISU_SAVE_DIR` (relative to the root)
 * replaces `cwd/save`. `RISU_AGENT_DEV_AUTH_BYPASS=TRUE` lets every protected route through without a
 * login (`pnpm dev:agent`, `util/agentDev.mjs`); it is refused unless `RISU_HOST` is a loopback
 * address, so the bypass can never answer another machine. `parsePasswordSeed` validates
 * `RISU_PASSWORD_SHA256` for `createServerContext`: a password digest that seeds only a missing file.
 */
export type ListenConfig = {
    port: number;
    hostname: string | undefined;
    savePath: string;
    authBypass: boolean;
};

export function readListenConfig(env: NodeJS.ProcessEnv, rootDir: string): ListenConfig {
    const hostname = env.RISU_HOST?.trim() || undefined;
    const authBypass = parseFlag(env.RISU_AGENT_DEV_AUTH_BYPASS, "RISU_AGENT_DEV_AUTH_BYPASS");
    if (authBypass && !(hostname && isLoopbackHost(hostname))) {
        throw new Error(
            `RISU_AGENT_DEV_AUTH_BYPASS needs RISU_HOST set to a numeric loopback address such as 127.0.0.1 (got ${hostname ?? "unset, every interface"})`,
        );
    }
    const saveDir = env.RISU_SAVE_DIR?.trim();
    return {
        port: Number(env.PORT || 6001),
        hostname,
        savePath: saveDir ? path.resolve(rootDir, saveDir) : path.join(rootDir, "save"),
        authBypass,
    };
}

export function parsePasswordSeed(raw: string | undefined): string | undefined {
    const value = raw?.trim();
    if (!value) {
        return undefined;
    }
    if (!/^[0-9a-f]{64}$/i.test(value)) {
        throw new Error(
            "Invalid RISU_PASSWORD_SHA256: expected the 64-character SHA-256 hex of the password, as printf '%s' '<password>' | sha256sum prints it",
        );
    }
    return value.toLowerCase();
}

/**
 * A numeric loopback address: `127.0.0.0/8` or `::1` (without brackets). A name such as `localhost`,
 * or a bracketed `[::1]`, is refused: Node hands either to the resolver (`/etc/hosts`, NSS), which
 * could map it to another interface.
 */
export function isLoopbackHost(host: string): boolean {
    if (net.isIPv4(host)) {
        return host.split(".")[0] === "127";
    }
    return net.isIPv6(host) && new net.SocketAddress({ address: host, family: "ipv6" }).address === "::1";
}

function parseFlag(raw: string | undefined, name: string): boolean {
    const value = raw?.trim().toLowerCase();
    if (!value || value === "false" || value === "0") {
        return false;
    }
    if (value === "true" || value === "1") {
        return true;
    }
    throw new Error(`Invalid ${name}: ${raw} (expected TRUE or FALSE)`);
}
