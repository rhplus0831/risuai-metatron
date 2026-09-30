// Starts an isolated app stack for browser checks: the self-host server in a fresh temporary
// working directory (so it gets an empty `save/`, see `server/src/main.ts` `rootDir`) and the Vite
// dev server proxying to it. Used by `playwright.config.ts` and the `util/playwright/` scripts.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const chromePath = process.env.RISU_CHROME ?? "/usr/bin/google-chrome";

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
 * @param {{ serverPort?: number, vitePort?: number, log?: (text: string) => void }} [options]
 * @returns {Promise<{ baseURL: string, serverURL: string, workDir: string, restartServer: () => Promise<void>, stop: () => Promise<void> }>}
 */
export async function startStack({ serverPort = 6101, vitePort = 5201, log } = {}) {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "risu-playwright-"));
    const serverURL = `http://localhost:${serverPort}`;
    const baseURL = `http://localhost:${vitePort}`;
    const startServer = () =>
        run(
            process.execPath,
            [path.join(repoRoot, "server/src/main.ts")],
            { cwd: workDir, env: { ...process.env, PORT: String(serverPort) } },
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
