// Starts an isolated app stack for browser checks: the self-host server in a fresh temporary
// working directory (so it gets an empty `save/`, see `server/src/main.ts` `rootDir`; `public/` and
// `version.json` are linked and copied in) and the Vite
// dev server proxying to it. Used by `playwright.config.ts` and the `util/playwright/` scripts.
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const chromePath = process.env.RISU_CHROME ?? "/usr/bin/google-chrome";

/** Hosts a check may reach: the app, its server, and the checks' local mocks. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);

/**
 * The server's egress guard for the dev stack (an `--import` preload, the harness only): `fetch` to
 * a non-local host is refused and the URL appended to `denied`. It is a tripwire, not a boundary: it
 * sees `fetch` (every provider, hub, and auxiliary call of the server) but not a redirect a local
 * answer gives, nor Node `http`/`https` requests (the local-network streaming route, Lua's `request`).
 * The boundary is `offline.sh` (no network but loopback); the checks count the attempts the guard
 * and `isolateContext` intercepted.
 */
function egressGuard(denied) {
    return `const local = new Set(${JSON.stringify([...LOCAL_HOSTS])});
const realFetch = globalThis.fetch;
const { appendFileSync } = await import("node:fs");
globalThis.fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.protocol === "data:" || url.protocol === "blob:" || local.has(url.hostname)) return realFetch(input, init);
    try { appendFileSync(${JSON.stringify(denied)}, url.href + "\\n"); } catch {}
    throw new TypeError("egress denied by the check harness: " + url.origin);
};
`;
}

/** Refused on purpose, not a failure: the CDN stylesheets the page loads, the home screen's hub listing. */
const EXPECTED_BLOCKED = new Set(["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"]);
const EXPECTED_DENIED = new Set(["sv.risuai.xyz"]);

/** The refused requests that were not expected (`isolateContext`'s list and the server's `deniedEgress()`). */
export function unexpectedEgress(blocked, denied = []) {
    return [
        ...blocked.filter((href) => !EXPECTED_BLOCKED.has(new URL(href).hostname)),
        ...denied.filter((href) => !EXPECTED_DENIED.has(new URL(href).hostname)),
    ];
}

/**
 * Keeps a browser context's HTTP requests on local hosts (the app and the checks' mocks): any other
 * is aborted and recorded in the returned list (fonts and CDN stylesheets are expected there).
 * WebSockets are not routed (the app opens its own only), and the app's own service worker is not
 * blocked: the built app needs it at boot (`/sw/init`) and reloads without it.
 */
export async function isolateContext(context) {
    const blocked = [];
    await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === "data:" || url.protocol === "blob:" || LOCAL_HOSTS.has(url.hostname)) {
            return route.continue();
        }
        blocked.push(url.href);
        return route.abort();
    });
    return blocked;
}

async function waitForHttp(url, child, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`${url}: process exited with ${child.exitCode}`);
        }
        try {
            const res = await fetch(url);
            if (res.ok) {
                // A leaked stack on the same port could answer while this child dies on EADDRINUSE;
                // give the child a moment and require it to still be running.
                await new Promise((resolve) => setTimeout(resolve, 500));
                if (child.exitCode !== null) {
                    throw new Error(`${url}: process exited with ${child.exitCode}`);
                }
                return;
            }
        } catch {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${url} did not answer within ${timeoutMs} ms`);
}

function run(command, args, options, log) {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => log?.(chunk.toString()));
    child.stderr.on("data", (chunk) => log?.(chunk.toString()));
    return child;
}

function stop(child) {
    if (!child || child.exitCode !== null) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        child.once("exit", () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill("SIGTERM");
    });
}

/**
 * `restartServer` stops the server (SIGTERM, so it shuts down gracefully) and starts it again over
 * the same `save/`, leaving the dev server running: for checks of what a server start does to
 * stored data.
 *
 * `serverEnv` adds variables to the server's environment only (e.g. `NODE_OPTIONS` with an `--import`
 * preload for a check's harness). Without its own `NODE_OPTIONS` the server gets the egress guard:
 * no public service is reached (`deniedEgress()` lists what was refused).
 *
 * @param {{ serverPort?: number, vitePort?: number, log?: (text: string) => void, serverEnv?: Record<string, string> }} [options]
 * @returns {Promise<{ baseURL: string, serverURL: string, workDir: string, deniedEgress: () => Promise<string[]>, restartServer: () => Promise<void>, stop: () => Promise<void> }>}
 */
export async function startStack({ serverPort = 6101, vitePort = 5201, log, serverEnv = {} } = {}) {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "risu-playwright-"));
    // What the server reads from its root besides `save/` (the script workers' `public/lua/json.lua`,
    // the tokenizer payloads, the app version), as in the repository; `rm` removes the link only.
    await symlink(path.join(repoRoot, "public"), path.join(workDir, "public"), "dir");
    await copyFile(path.join(repoRoot, "version.json"), path.join(workDir, "version.json"));
    const deniedFile = path.join(workDir, "denied-egress.log");
    if (!serverEnv.NODE_OPTIONS) {
        const guard = path.join(workDir, "egress-guard.mjs");
        await writeFile(guard, egressGuard(deniedFile));
        serverEnv = { ...serverEnv, NODE_OPTIONS: `--import=${guard}` };
    }
    const serverURL = `http://localhost:${serverPort}`;
    const baseURL = `http://localhost:${vitePort}`;
    const startServer = () =>
        run(
            process.execPath,
            [path.join(repoRoot, "server/src/main.ts")],
            { cwd: workDir, env: { ...process.env, ...serverEnv, PORT: String(serverPort) } },
            log,
        );
    let server = startServer();
    let vite;
    try {
        await waitForHttp(`${serverURL}/api/test_auth`, server, 30_000);
        vite = run(
            path.join(repoRoot, "node_modules/.bin/vite"),
            ["--port", String(vitePort), "--strictPort"],
            { cwd: repoRoot, env: { ...process.env, RISU_DEV_SERVER: serverURL } },
            log,
        );
        await waitForHttp(`${baseURL}/`, vite, 60_000);
    } catch (error) {
        await stop(vite);
        await stop(server);
        await rm(workDir, { recursive: true, force: true });
        throw error;
    }
    return {
        baseURL,
        serverURL,
        workDir,
        async deniedEgress() {
            return (await readFile(deniedFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
        },
        async restartServer() {
            await stop(server);
            server = startServer();
            await waitForHttp(`${serverURL}/api/test_auth`, server, 30_000);
        },
        async stop() {
            await stop(vite);
            await stop(server);
            await rm(workDir, { recursive: true, force: true });
        },
    };
}

/**
 * Opens the app in `page`, answers the node-password prompts (set on a fresh server, input on a new
 * browser context), and resolves once `loadedStore` is true. Vite may reload the page once while it
 * optimizes dependencies, so the prompt can appear again; it is answered each time.
 *
 * @param {import("playwright-core").Page} page
 * @param {string} baseURL
 * @param {string} [password]
 */
export async function openApp(page, baseURL, password = "playwright") {
    await page.goto(baseURL);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const loaded = await page
            .evaluate(async () => {
                const stores = await import("/src/ts/stores.svelte.ts");
                let value = false;
                stores.loadedStore.subscribe((v) => (value = v))();
                return value;
            })
            .catch(() => false);
        if (loaded) {
            return;
        }
        const input = page.locator("input:visible").first();
        const ok = page.getByRole("button", { name: "OK", exact: true });
        if ((await ok.count()) > 0 && (await input.count()) > 0) {
            await input.fill(password);
            await ok.first().click();
        }
        await page.waitForTimeout(500);
    }
    throw new Error("The app did not finish loading within 120 s");
}
