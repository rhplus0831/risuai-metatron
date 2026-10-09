import { modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
// Measurement for Phase 6 slice 9 (chat projection and lazy loading; `docs/plan/phases/slices/
// phase-6-thin-client-and-closeout/chat-projection-and-lazy-loading.md`): the chats left the
// character records for the chat module's own store (9a), and boot reads summaries, a chat loads
// when it is selected, and idle loaded chats are evicted beyond eight (9b).
//
// Against the production build (`pnpm build` first: the server serves `dist/`), in headless Chrome,
// through the real UI, with a character "Many" of 30 chats (one of them "Long", 2,000 messages; the
// others 20 each) among 50 characters, and a character "Stream" whose chat a local mock provider
// streams into (the server's generation job, 200 chunks 20 ms apart):
// - the boot: a fresh page until the sidebar shows "Many" (3 runs), and the JS heap after a forced
//   garbage collection;
// - switching Many's chats from its chat list (alternating "Long" and a 20-message chat, both
//   loaded after the first switch), and cold switches: each of 28 other 20-message chats once, until
//   its chat screen shows (9b: it loads first; with eight idle loaded chats kept, each is a load);
// - a streamed reply: the frame intervals while it streams (each chunk renders through the chat
//   screen's readers) and the long tasks;
// - opening the chat list (the list entries of 30 chats).
// Timed as in `measureCharacters.mjs` (task latency, paint; 3 warm-up and 10 measured runs). Compare
// with a baseline build (`RISU_DIST=<dist of an earlier commit>`). The checks: the streamed reply is
// on the server, no page error, no unexpected egress.
//
// Usage: pnpm build && node util/playwright/measureChats.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, repoRoot, unexpectedEgress } from "./stack.mjs";

const WARMUP = 3;
const RUNS = 10;
const port = 6263;
const base = `http://localhost:${port}`;
const CHUNKS = 200;
const CHUNK_MS = 20;

const dist = process.env.RISU_DIST ?? path.join(repoRoot, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
    console.error("No production build: run `pnpm build` first.");
    process.exit(1);
}

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { n: sorted.length, median: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +sorted.at(-1).toFixed(2) };
};

// The provider: an OpenAI-style stream of CHUNKS words.
const provider = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < CHUNKS; i++) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `word${i} ` } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, CHUNK_MS));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "end." } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
});
await new Promise((r) => provider.listen(0, "127.0.0.1", () => r()));
const providerBase = `http://127.0.0.1:${provider.address().port}`;

const workDir = await mkdtemp(path.join(os.tmpdir(), "risu-measure-chats-"));
await symlink(path.join(repoRoot, "public"), path.join(workDir, "public"), "dir");
await symlink(dist, path.join(workDir, "dist"), "dir");
await copyFile(path.join(repoRoot, "version.json"), path.join(workDir, "version.json"));
const server = spawn(process.execPath, [path.join(repoRoot, "server/src/main.ts")], {
    cwd: workDir,
    env: { ...process.env, PORT: String(port) },
    stdio: process.env.DEBUG ? "inherit" : "ignore",
});
const waitForServer = async () => {
    for (let i = 0; i < 150; i++) {
        try {
            const response = await fetch(`${base}/api/test_auth`);
            if (response.status) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the server did not start");
};
const browser = await chromium.launch({ executablePath: chromePath, headless: true });

try {
    await waitForServer();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const blocked = await isolateContext(context);
    const pageErrors = [];
    let auth = null;
    let epoch = null;
    const watch = (page) => {
        page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
        page.on("request", (r) => {
            const h = r.headers();
            if (h["risu-auth"]) auth = h["risu-auth"];
            if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
        });
    };
    let page = await context.newPage();
    watch(page);
    const api = async (p, init = {}) => {
        const r = await fetch(base + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;

    const settingsButton = () => page.locator("button:has(svg.lucide-settings)").first();
    const open = async () => {
        await page.goto(base);
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            if (
                await settingsButton()
                    .isVisible()
                    .catch(() => false)
            )
                return;
            if (
                await page
                    .locator("button:has(svg.lucide-list)")
                    .isVisible()
                    .catch(() => false)
            )
                return;
            if (
                auth &&
                (await page
                    .getByText("Welcome to Risuai!")
                    .isVisible()
                    .catch(() => false))
            )
                return;
            const input = page.locator("input:visible").first();
            const ok = page.getByRole("button", { name: "OK", exact: true });
            if ((await ok.count()) > 0 && (await input.count()) > 0) {
                await input.fill("measure");
                await ok.first().click();
            }
            await page.waitForTimeout(300);
        }
        throw new Error("the app did not load");
    };
    await open();
    await page.waitForTimeout(1500);

    // Seed through the routes.
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const presets = await single("presets");
    const modelPresets = await single("modelPresets");
    const modelProfiles = await single("modelProfiles");
    const preset = {
        ...presets.data[0],
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        forceReplaceUrl: `${providerBase}/v1/chat/completions`,
        customProxyRequestModel: "mock",
        maxContext: 900,
        maxResponse: 100,
    };
    const providers = await single("providers");
    const character = (chaId, name) => ({
        chaId,
        name,
        type: "character",
        desc: `The description of ${name}.`,
        firstMessage: "Hello.",
        globalLore: [],
        customscript: [],
        triggerscript: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        chatFolders: [],
        firstMsgIndex: -1,
    });
    const message = (i) => ({
        role: i % 2 === 0 ? "user" : "char",
        data: `Message ${i}: ${"some words of the conversation ".repeat(8)}`,
        chatId: randomUUID(),
    });
    const manyId = randomUUID();
    const streamId = randomUUID();
    const characters = [
        character(manyId, "Many"),
        character(streamId, "Stream"),
        ...Array.from({ length: 48 }, (_, i) => character(randomUUID(), `Character ${i}`)),
    ];
    const manyChats = Array.from({ length: 30 }, (_, i) => ({
        id: i === 0 ? "long" : `short-${i}`,
        name: i === 0 ? "Long" : `Short ${i}`,
        count: i === 0 ? 2000 : 20,
    }));
    const chatCreate = (characterId, id, name, count) => ({
        characterId,
        chatId: id,
        baseRevision: null,
        ops: [
            ...modelFixtureOps({ ...preset, customTokenizer: "tik" }, modelPresets, modelProfiles),
            {
                op: "create",
                chat: {
                    id,
                    name,
                    note: "",
                    localLore: [],
                    message: Array.from({ length: count }, (_, i) => message(i)),
                },
            },
        ],
    });
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: { ...ui.data, didFirstSetup: true, useLegacyGUI: true },
                },
                {
                    kind: "presets",
                    id: "main",
                    baseRevision: presets.revision,
                    data: [promptFixture(preset)],
                },
                {
                    kind: "providers",
                    id: "main",
                    baseRevision: providers.revision,
                    data: { ...providers.data, useStreaming: true },
                },
                ...characters.map((data) => ({ kind: "characters", id: data.chaId, baseRevision: null, data })),
            ],
            chats: [
                ...manyChats.map((chat) => chatCreate(manyId, chat.id, chat.name, chat.count)),
                ...characters
                    .filter((data) => data.chaId !== manyId)
                    .map((data) =>
                        chatCreate(data.chaId, `${data.chaId}-chat`, "Chat 1", data.chaId === streamId ? 2 : 0),
                    ),
            ],
            chatOrders: [],
        }),
    });
    check("seed: stored", seeded.status === 200, seeded.status === 200 ? undefined : seeded);

    // 1. The boot: a fresh page until the sidebar shows Many, then the heap after a collection.
    const boots = [];
    let heap = null;
    for (let run = 0; run < 3; run++) {
        await page.close();
        page = await context.newPage();
        watch(page);
        const start = Date.now();
        await page.goto(base);
        await page.locator(`[data-char-id="${manyId}"]`).first().waitFor({ timeout: 120_000 });
        boots.push(Date.now() - start);
        await page.waitForTimeout(2000);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
        await cdp.send("HeapProfiler.collectGarbage");
        const metrics = await cdp.send("Performance.getMetrics");
        heap = metrics.metrics.find((entry) => entry.name === "JSHeapUsedSize")?.value ?? heap;
        await cdp.detach();
    }
    console.log("boot until the sidebar shows (ms)", stats(boots));
    console.log("JS heap after a collection (MB)", heap === null ? null : +(heap / 1024 / 1024).toFixed(1));

    await page.evaluate(() => {
        window.__untilPaint = (start) =>
            new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))),
            );
        window.__untilIdle = (start) =>
            new Promise((resolve) => {
                const channel = new MessageChannel();
                channel.port1.onmessage = () => resolve(performance.now() - start);
                channel.port2.postMessage(null);
            });
        window.__time = async (start) => {
            const [task, paint] = await Promise.all([window.__untilIdle(start), window.__untilPaint(start)]);
            return { task, paint };
        };
    });
    const split = (samples) =>
        Object.fromEntries(Object.keys(samples[0]).map((key) => [key, stats(samples.map((sample) => sample[key]))]));

    // 2. Switching Many's chats from its chat list (the sidebar's chats panel).
    const selectCharacter = async (chaId) => {
        const handle = await page.locator(`[data-char-id="${chaId}"]`).first().elementHandle();
        await page.evaluate((avatar) => (avatar.closest('[role="button"]') ?? avatar).click(), handle);
    };
    await selectCharacter(manyId);
    await page.waitForTimeout(1500);
    const chatRow = (name) =>
        page
            .locator("button[data-risu-chat-idx]")
            .filter({ has: page.getByText(name, { exact: true }) })
            .first();
    const switches = { long: [], short: [] };
    for (let run = 0; run < WARMUP + RUNS; run++) {
        for (const [label, name] of [
            ["short", "Short 1"],
            ["long", "Long"],
        ]) {
            const handle = await chatRow(name).elementHandle();
            const ms = await page.evaluate((row) => {
                const start = performance.now();
                row.click();
                return window.__time(start);
            }, handle);
            if (run >= WARMUP) switches[label].push(ms);
            await page.waitForTimeout(400);
        }
    }
    console.log("switch to Long (2,000 messages, the default visible window)", split(switches.long));
    console.log("switch to a 20-message chat", split(switches.short));

    // 2b. Cold switches: until the chat screen shows the chat (after its load, when it was not loaded).
    await page.evaluate(() => {
        window.__untilChat = (start) =>
            new Promise((resolve) => {
                const frame = () => {
                    if (document.querySelector(".default-chat-screen")) {
                        requestAnimationFrame(() => resolve(performance.now() - start));
                    } else {
                        requestAnimationFrame(frame);
                    }
                };
                requestAnimationFrame(frame);
            });
    });
    const cold = [];
    for (let i = 2; i < 30; i++) {
        const handle = await chatRow(`Short ${i}`).elementHandle();
        const ms = await page.evaluate((row) => {
            const start = performance.now();
            row.click();
            return window.__untilChat(start);
        }, handle);
        cold.push(ms);
        await page.waitForTimeout(200);
    }
    console.log("cold switch until the chat shows (28 chats, each once)", stats(cold));

    // 3. A streamed reply into Stream's chat: frame intervals and long tasks while it streams.
    await selectCharacter(streamId);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
        window.__frames = [];
        window.__longTasks = [];
        window.__sampling = true;
        let last = performance.now();
        const frame = (now) => {
            if (!window.__sampling) return;
            window.__frames.push(now - last);
            last = now;
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
        }).observe({ type: "longtask", buffered: false });
    });
    const input = page.locator("textarea.input-text").first();
    await input.fill("Stream please");
    await input.press("Enter");
    await page.getByText("word0").first().waitFor({ timeout: 30_000 });
    await page.getByText("end.").first().waitFor({ timeout: 60_000 });
    const streamed = await page.evaluate(() => {
        window.__sampling = false;
        return { frames: window.__frames, longTasks: window.__longTasks };
    });
    console.log("frame interval while streaming (ms)", stats(streamed.frames));
    console.log(
        "long tasks while streaming",
        streamed.longTasks.length,
        "total ms",
        +streamed.longTasks.reduce((a, b) => a + b, 0).toFixed(1),
    );
    await page.waitForTimeout(3000);
    const read = await api("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({ chats: [{ characterId: streamId, id: `${streamId}-chat` }] }),
    });
    const reply = read.body?.chats?.[0]?.data?.message?.at(-1)?.data;
    check("stream: the server holds the streamed reply", typeof reply === "string" && reply.includes("end."), {
        tail: typeof reply === "string" ? reply.slice(-20) : reply,
    });

    // 4. Opening Many's chat list panel again (30 entries) after selecting it.
    const opens = [];
    for (let run = 0; run < WARMUP + RUNS; run++) {
        await selectCharacter(streamId);
        await page.waitForTimeout(300);
        const back = await page.locator(`[data-char-id="${manyId}"]`).first().elementHandle();
        const ms = await page.evaluate((avatar) => {
            const start = performance.now();
            (avatar.closest('[role="button"]') ?? avatar).click();
            return window.__time(start);
        }, back);
        if (run >= WARMUP) opens.push(ms);
        await page.waitForTimeout(300);
    }
    console.log("select Many (its 30-chat list and the Long chat's window)", split(opens));

    const denied = unexpectedEgress(blocked, []);
    check("no unexpected outbound request", denied.length === 0, denied.length === 0 ? undefined : denied);
    check("no page error", pageErrors.length === 0, pageErrors.length === 0 ? undefined : pageErrors);
} catch (error) {
    console.error(error);
    results.push(false);
} finally {
    await browser.close();
    server.kill("SIGTERM");
    provider.close();
    await new Promise((r) => setTimeout(r, 500));
    await rm(workDir, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
