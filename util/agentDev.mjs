#!/usr/bin/env node
// `pnpm dev:agent` / `pnpm dev:human` (`node util/agentDev.mjs <agent|human>`): the self-host server
// (`node --watch`, so a server edit restarts it) and the Vite dev server in one command, with the dev
// server's proxy pointed at that server. Ctrl+C or SIGTERM stops both; when one of them ends, the
// other is stopped too.
//
//   agent  server 6419 and Vite 6418, auth bypassed (the server refuses that off loopback), storage
//          in a disposable `save-agent/` cloned from `save/` (`util/agentDataSandbox.mjs`), Vite
//          cache `node_modules/.vite-agent` (so it can run beside a human stack).
//   human  server 6001 and Vite 5174, the normal login, storage in `save/`.
//
// Both bind to 127.0.0.1 (`util/agentDevHost.mjs`; `RISU_AGENT_DEV_HOST=tailscale` binds human mode to
// the Tailscale address instead, which is no secure context over plain HTTP).
//
// Overrides: RISU_AGENT_DEV_HOST, RISU_AGENT_DEV_PORT (Vite), RISU_AGENT_API_PORT (server),
// RISU_AGENT_DEV_AUTH_BYPASS, RISU_AGENT_DATA_MODE (clone, keep, fresh), RISU_SAVE_DIR (used as it is,
// no clone), RISU_VITE_CACHE_DIR. See `docs/structure/build-test-platforms.md`.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentDataSandboxMode, prepareAgentDataSandbox } from "./agentDataSandbox.mjs";
import { resolveAgentDevHost } from "./agentDevHost.mjs";
import { readListenConfig } from "../server/src/listenConfig.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHUTDOWN_GRACE_MS = 10_000;
const SERVER_READY_MS = 120_000;

const DEFAULTS = {
    agent: { vitePort: 6418, serverPort: 6419, authBypass: "TRUE", viteCacheDir: "node_modules/.vite-agent" },
    human: { vitePort: 5174, serverPort: 6001, authBypass: "FALSE", viteCacheDir: undefined },
};

const mode = process.argv[2];
if (mode !== "agent" && mode !== "human") {
    process.stderr.write("usage: node util/agentDev.mjs <agent|human>\n");
    process.exit(2);
}
const defaults = DEFAULTS[mode];
const log = (line) => process.stdout.write(`[dev:${mode}] ${line}\n`);

/**
 * The children started; each leads a process group (its pid), kept after the leader exits, since
 * members may remain.
 *
 * @type {import("node:child_process").ChildProcess[]}
 */
const groups = [];
let shuttingDown = false;
/** The sandbox lock this runner holds (`acquireSandboxLock`), removed when it exits. */
let heldLock = null;

function parsePort(raw, fallback, name) {
    if (!raw?.trim()) {
        return fallback;
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid ${name}: ${raw}`);
    }
    return port;
}

const urlHost = (host) => (host.includes(":") ? `[${host}]` : host);

/** Fails early with a clear message, since `node --watch` would keep waiting after EADDRINUSE. */
function assertPortFree(host, port, name) {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", (error) =>
            reject(
                new Error(`${name} port ${urlHost(host)}:${port} is not available (${error.code ?? error.message})`),
            ),
        );
        probe.listen(port, host, () => probe.close(() => resolve()));
    });
}

/** Resolves once `host:port` accepts a connection; rejects after `timeoutMs` or when the stack stops. */
async function waitForListener(host, port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!shuttingDown) {
        const open = await new Promise((resolve) => {
            const socket = net.connect({ host, port });
            socket.once("connect", () => {
                socket.destroy();
                resolve(true);
            });
            socket.once("error", () => resolve(false));
        });
        if (open) {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error(
                `the server did not listen on ${urlHost(host)}:${port} within ${timeoutMs / 1000} s (see its output above)`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("stopped before the server was ready");
}

/**
 * One runner per sandbox: a second `dev:agent` (other ports, the same checkout) would otherwise
 * replace the directory under a running server. The lock file (`wx`) holds the owner's pid and is
 * removed when the runner exits. A lock left by a runner that was killed is not taken over (two
 * runners could both read the dead pid, and one would then remove the other's new lock): the message
 * says to delete it.
 */
function acquireSandboxLock(sandboxDir) {
    const lockPath = `${sandboxDir}.lock`;
    try {
        writeFileSync(lockPath, String(process.pid), { flag: "wx" });
        heldLock = lockPath;
        return;
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }
    }
    const owner = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
        throw new Error(`another dev:agent (pid ${owner}) uses ${sandboxDir}; stop it first (lock ${lockPath})`);
    }
    throw new Error(
        `${lockPath} is left from a dev:agent that is no longer running (pid ${owner || "unknown"}); delete it and start again`,
    );
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

function releaseSandboxLock() {
    if (!heldLock) {
        return;
    }
    try {
        if (readFileSync(heldLock, "utf8").trim() === String(process.pid)) {
            unlinkSync(heldLock);
        }
    } catch {}
    heldLock = null;
}

/** Whether any process is left in the group `pgid` (`kill(-pgid, 0)`: ESRCH once it is empty). */
function groupAlive(pgid) {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

// Each child leads its own process group, so a stop reaches the server under the `node --watch`
// supervisor too, also after the supervisor itself has exited, and a terminal's Ctrl+C reaches only
// this runner, which stops them. Nothing is started once the stack is stopping.
function spawnManaged(name, command, args, env) {
    if (shuttingDown) {
        return;
    }
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: "inherit", detached: true });
    if (child.pid !== undefined) {
        groups.push(child);
    }
    child.once("exit", (code, signal) => {
        if (shuttingDown) {
            return;
        }
        log(`${name} stopped (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}); stopping the rest`);
        void shutdown(code && code > 0 ? code : 1);
    });
    child.once("error", (error) => {
        log(`${name} could not start: ${error.message}`);
        void shutdown(1);
    });
}

/**
 * SIGTERM to the group's leader (the supervisor passes it on), then waits until every process of the
 * group has exited; after the grace period, SIGKILL to the whole group.
 */
async function stopGroup(leader) {
    const pgid = leader.pid;
    // A live leader gets it alone (the supervisor passes it on). After the leader exited, its pid is
    // only signalled as a group that still has members: Linux reuses no pid that still names a group.
    if (leader.exitCode === null && leader.signalCode === null) {
        leader.kill("SIGTERM");
    } else if (groupAlive(pgid)) {
        try {
            process.kill(-pgid, "SIGTERM");
        } catch {}
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (groupAlive(pgid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!groupAlive(pgid)) {
        return;
    }
    try {
        process.kill(-pgid, "SIGKILL");
    } catch {}
    const killDeadline = Date.now() + 2_000;
    while (groupAlive(pgid) && Date.now() < killDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function shutdown(exitCode) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    await Promise.all(groups.map(stopGroup));
    releaseSandboxLock();
    process.exit(exitCode);
}

async function main() {
    const vitePort = parsePort(process.env.RISU_AGENT_DEV_PORT, defaults.vitePort, "RISU_AGENT_DEV_PORT");
    const serverPort = parsePort(process.env.RISU_AGENT_API_PORT, defaults.serverPort, "RISU_AGENT_API_PORT");
    const { host, source } = resolveAgentDevHost(process.env.RISU_AGENT_DEV_HOST);
    if (source !== "loopback" && !/^(127\.|::1$|localhost$)/i.test(host)) {
        log(`binding to ${host}: over plain HTTP the login and the service worker need a secure context`);
    }
    const explicitSaveDir = process.env.RISU_SAVE_DIR?.trim() || undefined;
    const sandboxDir = mode === "agent" && !explicitSaveDir ? path.join(repoRoot, "save-agent") : undefined;
    const saveDir = explicitSaveDir ?? sandboxDir;
    const serverEnv = {
        ...process.env,
        PORT: String(serverPort),
        RISU_HOST: host,
        ...(saveDir ? { RISU_SAVE_DIR: saveDir } : {}),
        RISU_AGENT_DEV_AUTH_BYPASS: process.env.RISU_AGENT_DEV_AUTH_BYPASS ?? defaults.authBypass,
    };
    // The server's own rules (a bypass off loopback, a bad flag), before anything is prepared.
    readListenConfig(serverEnv, repoRoot);
    const dataMode = sandboxDir ? parseAgentDataSandboxMode(process.env.RISU_AGENT_DATA_MODE) : undefined;
    if (sandboxDir) {
        acquireSandboxLock(sandboxDir);
    }
    await assertPortFree(host, serverPort, "Server");
    await assertPortFree(host, vitePort, "Vite");

    // Prepared here, not in the server, so a `--watch` restart keeps the same sandbox for the session.
    if (sandboxDir) {
        const summary = await prepareAgentDataSandbox({
            sourceDir: path.join(repoRoot, "save"),
            sandboxDir,
            mode: dataMode,
        });
        log(`storage (${dataMode}): ${summary}`);
    }

    // `main.ts` serves HTTPS when it finds this certificate pair, and the proxy has to follow.
    const certDir = path.join(repoRoot, "server/ssl/certificate");
    const tls = existsSync(path.join(certDir, "server.key")) && existsSync(path.join(certDir, "server.crt"));
    const serverURL = `${tls ? "https" : "http"}://${urlHost(host)}:${serverPort}`;
    log(`app: http://${urlHost(host)}:${vitePort}/`);
    log(`server: ${serverURL}/ (proxied by Vite)`);

    spawnManaged("server", process.execPath, ["--watch", "server/src/main.ts"], serverEnv);
    // `node --watch` keeps waiting for an edit after a failed start, so the first start is checked
    // here; later restarts may fail while code is being edited.
    await waitForListener(host, serverPort, SERVER_READY_MS);
    if (shuttingDown) {
        return;
    }
    const viteCacheDir = process.env.RISU_VITE_CACHE_DIR ?? defaults.viteCacheDir;
    spawnManaged(
        "vite",
        path.join(repoRoot, "node_modules/.bin/vite"),
        ["--host", host, "--port", String(vitePort), "--strictPort"],
        {
            ...process.env,
            RISU_DEV_SERVER: serverURL,
            ...(viteCacheDir ? { RISU_VITE_CACHE_DIR: viteCacheDir } : {}),
        },
    );
}

process.once("exit", releaseSandboxLock);
process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
main().catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    void shutdown(1);
});
