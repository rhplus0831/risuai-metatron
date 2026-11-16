// Checks the real headless host's auth, presence, dialog denial, profile reuse, reload and shutdown.
// Outside the test gate. Usage: util/playwright/offline.sh node util/playwright/checkHeadlessHost.mjs
// Optional: SERVER_PORT=6293 VITE_PORT=5393 RISU_CHROME=/usr/bin/google-chrome DEBUG=1.
// Ports must be free. Uses disposable server storage and profiles; never changes a real host profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import {
    chromePath,
    isolateContext,
    openApp,
    pluginFixtureOp,
    repoRoot,
    startStack,
    unexpectedEgress,
} from "./stack.mjs";

const serverPort = Number(process.env.SERVER_PORT ?? 6293);
const vitePort = Number(process.env.VITE_PORT ?? 5393);
const bootDeadline = 150_000;
const dialogDeadline = 45_000;
const exitDeadline = 20_000;
const settleMs = 12_000;
const nonce = randomUUID();
const name = `Headless check ${nonce.slice(0, 8)}`;
const pluginName = `HeadlessCheck${nonce.slice(0, 8)}`;
const marker = `headless-check:${nonce}`;
const password = `headless-${nonce}`;
const pluginScript = `//@name ${pluginName}
//@api 3.0
await risuai.alert("${marker}:alert:${nonce}");
const db = await risuai.getDatabase();
await risuai.alert("${marker}:db:" + (db === null ? "denied" : "granted"));
`;
const hash = createHash("sha256").update(pluginScript).digest("hex");
const cases = [
    "unset",
    "presence",
    "plugin alert",
    "permission denied",
    "restart on same profile",
    "reload command",
    "SIGINT end",
];
const results = new Map();
const runs = [];
const profiles = [];
const blocked = [];
const feed = [];
const remotePosts = [];
const stackLog = [];
const A = { auth: null, epoch: null };
let stack;
let browser;
let first;
let second;
let firstReady;
let secondReady;
let fixtureReady = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, read, timeout = bootDeadline) {
    const end = Date.now() + timeout;
    do {
        const value = await read();
        if (value) return value;
        await delay(100);
    } while (Date.now() < end);
    throw new Error(`${label} timed out after ${timeout / 1000}s`);
}

function report(label, error, reason) {
    results.set(label, !error);
    if (error) process.exitCode = 1;
    console.log(`${error ? "FAIL" : "PASS"} ${label}: ${error?.message ?? reason}`);
}

async function runCase(label, dependency, work) {
    if (dependency) return report(label, new Error(`skipped: ${dependency}`));
    try {
        report(label, null, await work());
    } catch (error) {
        report(label, error);
        if (process.env.DEBUG) console.error(error.stack);
    }
}

async function freePort(port) {
    const listener = createServer();
    await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, resolve);
    });
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
}

// Chrome can rewrite argv into one space-separated process title. Match the complete profile flag
// in either form, never a process name or a prefix of another check's profile.
async function profileProcesses(profile) {
    const argument = `--user-data-dir=${profile}`;
    const flag = new RegExp(`(?:^|[\\0\\s])${escaped(argument)}(?=[\\0\\s]|$)`);
    const entries = await readdir("/proc");
    const matches = await Promise.all(
        entries
            .filter((entry) => /^\d+$/.test(entry))
            .map(async (entry) => {
                try {
                    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
                    return flag.test(cmdline) ? Number(entry) : null;
                } catch (error) {
                    if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return null;
                    throw error;
                }
            }),
    );
    return matches.filter((pid) => pid !== null);
}

async function newProfile(label) {
    const profile = await mkdtemp(path.join(os.tmpdir(), `risu-headless-check-${label}-`));
    profiles.push(profile);
    return profile;
}

function startHost(label, profile, suppliedPassword) {
    const env = { ...process.env };
    delete env.RISU_HOST;
    delete env.PORT;
    delete env.RISU_HEADLESS_HOST_PASSWORD;
    Object.assign(env, {
        RISU_HEADLESS_HOST_PORT: String(vitePort),
        RISU_HEADLESS_HOST_PROFILE: profile,
        RISU_HEADLESS_HOST_NAME: name,
        RISU_CHROME: chromePath,
    });
    if (suppliedPassword !== undefined) env.RISU_HEADLESS_HOST_PASSWORD = suppliedPassword;
    const child = spawn(process.execPath, ["util/headlessHost.mjs"], {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const run = { label, profile, child, lines: [], ended: null, seenPids: new Set() };
    runs.push(run);
    for (const [source, stream] of [
        ["stdout", child.stdout],
        ["stderr", child.stderr],
    ]) {
        createInterface({ input: stream }).on("line", (text) => {
            const line = { index: run.lines.length, at: Date.now(), source, text };
            run.lines.push(line);
            if (process.env.DEBUG) console.error(`${new Date(line.at).toISOString()} [${label} ${source}] ${text}`);
        });
    }
    child.once("error", (error) => {
        run.spawnError = error;
    });
    child.once("close", (code, signal) => {
        run.ended = { code, signal };
    });
    // Sample while even a short fatal run is alive, to verify the actual Chromium argv convention.
    run.monitor = (async () => {
        do {
            const pids = await profileProcesses(profile);
            const added = pids.filter((pid) => !run.seenPids.has(pid));
            for (const pid of pids) run.seenPids.add(pid);
            if (added.length)
                console.log(`INFO ${label}: Chrome PIDs ${added.join(",")} matched --user-data-dir=${profile}`);
            if (run.ended) break;
            await delay(100);
        } while (true);
    })().catch((error) => {
        run.monitorError = error;
    });
    return run;
}

function alive(run) {
    assert.ok(!run.spawnError, `${run.label}: ${run.spawnError?.message}`);
    assert.ok(!run.ended, `${run.label} exited ${JSON.stringify(run.ended)}`);
}

function tail(run) {
    return run.lines
        .slice(-6)
        .map((line) => line.text)
        .join(" | ");
}

function findLog(run, pattern, after = -1) {
    return run.lines.find((line) => line.index > after && line.source === "stdout" && pattern.test(line.text));
}

async function waitLog(run, pattern, after = -1, timeout = bootDeadline) {
    return await until(
        `${run.label} log ${pattern} after index ${after}`,
        () => {
            const found = findLog(run, pattern, after);
            if (found) return found;
            alive(run);
        },
        timeout,
    );
}

function noLog(run, pattern, after = -1) {
    assert.ok(!findLog(run, pattern, after), `${run.label}: unexpected ${findLog(run, pattern, after)?.text}`);
}

async function waitExit(run) {
    await until(`${run.label} exit; ${tail(run)}`, () => run.ended, exitDeadline);
    await run.monitor;
    return run.ended;
}

async function noChrome(run, end) {
    let left = [];
    try {
        await until(
            `${run.label} Chrome cleanup`,
            async () => {
                left = await profileProcesses(run.profile);
                return left.length === 0;
            },
            5_000,
        );
    } finally {
        console.log(
            `INFO ${end}: ${left.length} Chrome processes left${left.length ? ` (PIDs ${left.join(",")})` : ""}; --user-data-dir=${run.profile}; live PIDs observed=${[...run.seenPids].join(",") || "none"}`,
        );
    }
    if (run.monitorError) throw run.monitorError;
    assert.ok(run.seenPids.size, `${run.label}: never observed a live --user-data-dir=${run.profile} process`);
}

async function stopAndCheck(run, signal) {
    alive(run);
    run.child.kill(signal);
    const ended = await waitExit(run);
    // Inspect cleanup even if the exit status or shutdown message is wrong.
    await noChrome(run, signal);
    assert.deepEqual(ended, { code: 0, signal: null });
    assert.ok(findLog(run, new RegExp(`Stopped by ${signal}`)), `missing Stopped by ${signal}`);
}

async function api(url, body) {
    const response = await fetch(stack.baseURL + url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "risu-auth": A.auth, "x-resource-epoch": A.epoch, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json();
    A.epoch = response.headers.get("x-resource-epoch") ?? data?.epoch ?? A.epoch;
    return { status: response.status, body: data };
}

async function single(kind) {
    const res = await api(`/api/resources/${kind}/main`);
    if (res.status === 404 && ["plugins", "pluginPermissions"].includes(kind)) {
        return { revision: null, data: kind === "plugins" ? [] : { grants: {}, lastGrantTime: {} } };
    }
    assert.equal(res.status, 200, JSON.stringify(res));
    return res.body;
}

function hostEntry(frame) {
    return frame?.clients.find((client) => client.name === name && client.host === true);
}

function currentHost() {
    return hostEntry(feed.findLast((frame) => frame.type === "clients"));
}

async function waitHostReturn(run, afterFeedIndex) {
    const absent = await until(`${run.label} host disappears after trigger`, () => {
        alive(run);
        return feed.find((frame, index) => index >= afterFeedIndex && frame.type === "clients" && !hostEntry(frame));
    });
    const absentIndex = feed.indexOf(absent);
    await until(`${run.label} host returns after disappearance`, () => {
        alive(run);
        return feed.find((frame, index) => index > absentIndex && frame.type === "clients" && hostEntry(frame));
    });
}

const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dismissed = (text) => new RegExp(`Dismiss dialog with Escape: .*${escaped(text)}`);

async function settle(run) {
    await until(`${run.label} remains up for safe boot to settle`, () => {
        alive(run);
        const latest = run.lines.findLast(
            (line) => line.source === "stdout" && /Remote Host ready|Dismiss dialog with Escape:/.test(line.text),
        );
        return latest && Date.now() - latest.at >= settleMs;
    });
}

try {
    await Promise.all([freePort(serverPort), freePort(vitePort)]);
    stack = await startStack({
        serverPort,
        vitePort,
        serverEnv: { RISU_PASSWORD_SHA256: "" },
        log: (line) => {
            stackLog.push(line);
            if (process.env.DEBUG) process.stderr.write(line);
        },
    });
    await runCase("unset", null, async () => {
        const run = startHost("unset", await newProfile("unset"), password);
        let ended;
        try {
            await until("unset host exits", () => run.ended, bootDeadline);
            ended = await waitExit(run);
        } finally {
            // A timed-out fatal exit must not leave this run active during password setup.
            if (!run.ended) {
                run.child.kill("SIGTERM");
                await waitExit(run);
            }
            await noChrome(run, "unset exit");
        }
        const response = await fetch(`${stack.serverURL}/api/test_auth`, { signal: AbortSignal.timeout(20_000) });
        const body = await response.json();
        console.log(`INFO unset exit: code=${ended.code}; /api/test_auth=${JSON.stringify(body)}`);
        assert.equal(ended.code, 3, tail(run));
        assert.equal(ended.signal, null);
        assert.equal(response.status, 200);
        assert.deepEqual(body, { status: "unset" });
        return "exit 3, password still unset, no Chrome left";
    });

    try {
        browser = await chromium.launch({ executablePath: chromePath, headless: true });
        const context = await browser.newContext();
        const isolated = await isolateContext(context);
        // Keep the returned mutable list: requests after navigation are recorded here too.
        blocked.push(isolated);
        const page = (A.page = await context.newPage());
        page.setDefaultTimeout(20_000);
        page.on("request", (req) => {
            const headers = req.headers();
            if (headers["risu-auth"]) A.auth = headers["risu-auth"];
            if (headers["x-resource-epoch"]) A.epoch = headers["x-resource-epoch"];
            if (req.method() === "POST" && new URL(req.url()).pathname === "/api/remote-commands") {
                remotePosts.push({
                    at: Date.now(),
                    after: (second?.lines.length ?? 0) - 1,
                    feedIndex: feed.length,
                    body: req.postDataJSON(),
                });
            }
        });
        page.on("response", (res) => {
            if (res.headers()["x-resource-epoch"]) A.epoch = res.headers()["x-resource-epoch"];
        });
        page.on("websocket", (socket) => {
            if (!new URL(socket.url()).pathname.startsWith("/api/events/")) return;
            socket.on("framereceived", ({ payload }) => {
                try {
                    const frame = { ...JSON.parse(String(payload)), at: Date.now() };
                    feed.push(frame);
                    if (process.env.DEBUG && frame.type === "clients")
                        console.error(`A clients: ${JSON.stringify(frame)}`);
                } catch {}
            });
        });
        await openApp(page, stack.baseURL + "/?safe=plugins", password);
        await until("A auth and epoch", () => A.auth && A.epoch);
        const notice = page.locator("[data-alert-dialog]:visible");
        if (await notice.count()) await page.keyboard.press("Escape");
        await until("A safe-boot notice closed", async () => (await notice.count()) === 0, dialogDeadline);
        assert.deepEqual(
            await page.evaluate(async () => (await import("/src/ts/storage/resourceSync.svelte.ts")).flushResources()),
            { discarded: [], refused: [] },
        );
        const [ui, plugins] = await Promise.all([single("ui"), single("plugins")]);
        const seeded = await api("/api/resources/batch", {
            ops: [
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: { ...ui.data, didFirstSetup: true, language: "en" },
                },
                pluginFixtureOp(pluginName, pluginScript, plugins),
            ],
        });
        assert.equal(seeded.status, 200, JSON.stringify(seeded));
        fixtureReady = true;
        first = startHost("first", await newProfile("main"), password);
    } catch (error) {
        report("setup", error);
    }

    await runCase("presence", !first && "fixture/first host startup", async () => {
        firstReady = await waitLog(first, /Remote Host ready/);
        await until("host presence in A's feed", () => {
            alive(first);
            return currentHost();
        });
        return `${name} has host=true; Remote Host ready logged`;
    });
    await runCase("plugin alert", !first && "fixture/first host startup", async () => {
        const alert = await waitLog(first, dismissed(`${marker}:alert:${nonce}`), -1, dialogDeadline);
        await waitLog(first, dismissed(pluginName), alert.index, dialogDeadline);
        noLog(first, /Dialog not dismissable/);
        return "alert logged; subsequent permission prompt proves the alert closed";
    });
    await runCase("permission denied", !first && "fixture/first host startup", async () => {
        const permission = await waitLog(first, dismissed(pluginName), -1, dialogDeadline);
        await waitLog(first, dismissed(`${marker}:db:denied`), permission.index, dialogDeadline);
        noLog(first, new RegExp(escaped(`${marker}:db:granted`)));
        noLog(first, /Dialog not dismissable/);
        const permissions = (await single("pluginPermissions")).data;
        assert.ok(!Object.hasOwn(permissions.grants, `${hash}_db`), "db grant was written");
        assert.ok(
            !Object.hasOwn(permissions.lastGrantTime, `${pluginName}_db_lastGrantTime`),
            "db lastGrantTime was written",
        );
        return "permission and denied result dismissed; no grant or lastGrantTime written";
    });
    await runCase(
        "restart on same profile",
        !firstReady
            ? "first host ready"
            : !findLog(first, dismissed(`${marker}:db:denied`)) && "last plugin dialog dismissal",
        async () => {
            await settle(first);
            const feedIndex = feed.length;
            await stopAndCheck(first, "SIGTERM");
            second = startHost("second", first.profile);
            secondReady = await waitLog(second, /Remote Host ready/);
            await waitHostReturn(second, feedIndex);
            await waitLog(second, dismissed(`${marker}:db:denied`), -1, dialogDeadline);
            await settle(second);
            noLog(second, /Server password submitted|Plugins are off|Dialog not dismissable/);
            alive(second);
            return "SIGTERM exit 0, no Chrome left; same profile ready, host left and returned, no password or plugins-off";
        },
    );
    await runCase("reload command", !secondReady && "second host ready", async () => {
        await settle(second);
        noLog(second, /Plugins are off/);
        const target = await until("current host clientId", () => currentHost());
        const postIndex = remotePosts.length;
        await A.page.evaluate(
            async (target) => {
                const { requestHostReload } = await import("/src/ts/network/remoteHost.ts");
                window.__headlessReload = { done: false };
                void requestHostReload(target, "page").then(
                    () => {
                        window.__headlessReload.done = true;
                    },
                    (error) => {
                        window.__headlessReload.error = String(error);
                    },
                );
            },
            { clientId: target.clientId, name },
        );
        const confirmation = A.page.locator("[data-alert-dialog]:visible").filter({ hasText: name });
        await confirmation.getByRole("button", { name: /^(yes|ok)$/i }).click();
        const sent = await until("A's page reload POST", () => {
            alive(second);
            return remotePosts
                .slice(postIndex)
                .find(
                    (post) =>
                        post.body.target === target.clientId &&
                        post.body.command?.type === "reload" &&
                        post.body.command.mode === "page",
                );
        });
        assert.equal(typeof sent.body.commandId, "string");
        // The one-second poll may see the recovered command row only after the new ready event.
        // Both logs must be new since sending, but either order is valid.
        const command = await waitLog(
            second,
            new RegExp(`Command ${escaped(sent.body.commandId)} reload:`),
            sent.after,
        );
        await waitLog(second, /Remote Host ready/, sent.after);
        await waitHostReturn(second, sent.feedIndex);
        noLog(second, /Plugins are off|Restart in|Server password submitted|Dialog not dismissable/, sent.after);
        return `${command.text}; new ready; host disappeared then reappeared after sending`;
    });
    await runCase("SIGINT end", !second && "second host startup", async () => {
        await stopAndCheck(second, "SIGINT");
        return "exit 0, Stopped by SIGINT logged, no Chrome left";
    });
} catch (error) {
    report("setup", error);
} finally {
    for (const label of cases) if (!results.has(label)) report(label, new Error("skipped: setup"));
    // Every cleanup is attempted even when a preceding one fails. Only our child PIDs and profiles qualify.
    for (const run of runs) {
        try {
            if (!run.ended) {
                run.child.kill("SIGTERM");
                try {
                    await waitExit(run);
                } catch {
                    report(`cleanup ${run.label}`, new Error("child needed SIGKILL"));
                    run.child.kill("SIGKILL");
                    await waitExit(run);
                }
            }
            await run.monitor;
            if (run.monitorError) throw run.monitorError;
        } catch (error) {
            report(`cleanup ${run.label}`, error);
        }
    }
    for (const profile of profiles) {
        try {
            const left = await profileProcesses(profile);
            if (left.length) {
                report(
                    "cleanup Chrome",
                    new Error(
                        `PIDs ${left.join(",")} still hold --user-data-dir=${profile}; killing these profile holders only`,
                    ),
                );
                for (const pid of left) {
                    try {
                        process.kill(pid, "SIGKILL");
                    } catch (error) {
                        if (error.code !== "ESRCH") throw error;
                    }
                }
                await until(
                    "cleanup profile holders",
                    async () => (await profileProcesses(profile)).length === 0,
                    5_000,
                );
            }
        } catch (error) {
            report("cleanup Chrome", error);
        }
    }
    try {
        await browser?.close();
    } catch (error) {
        report("cleanup browser A", error);
    }
    if (stack) {
        await runCase("egress", null, async () => {
            const denied = await stack.deniedEgress();
            assert.deepEqual(unexpectedEgress(blocked.flat(), denied), []);
            return `${denied.length} expected server attempts denied (offline namespace covers child Chrome)`;
        });
        try {
            await stack.stop();
        } catch (error) {
            report("cleanup stack", error);
        }
    }
    for (const profile of profiles) {
        try {
            await rm(profile, { recursive: true, force: true });
        } catch (error) {
            report("cleanup profile", error);
        }
    }
    if (process.exitCode) {
        for (const run of runs)
            console.error(
                `${run.label} log tail:\n${run.lines
                    .slice(-16)
                    .map((line) => `[${line.source}] ${line.text}`)
                    .join("\n")}`,
            );
        if (!fixtureReady) console.error(`Stack tail:\n${stackLog.join("").slice(-4000)}`);
    }
}
