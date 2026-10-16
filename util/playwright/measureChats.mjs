import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
// Measurement for Phase 6 slice 9 (chat projection and lazy loading; `docs/plan/phases/slices/
// phase-6-thin-client-and-closeout/chat-projection-and-lazy-loading.md`): the chats left the
// character records for the chat module's own store (9a), and boot reads summaries, a chat loads
// when it is selected, and idle loaded chats are evicted beyond eight (9b).
//
// Against the production build (`pnpm build` first: the server serves `dist/`), in headless Chrome,
// through the real UI, with a character "Many" of 30 chats (one of them "Long", 2,000 messages; the
// others 20 each) among 50 characters, and a character "Stream" whose chat a local mock provider
// streams into (the server's generation job, CHUNKS chunks CHUNK_MS ms apart):
// - the boot: a fresh page until the sidebar shows "Many" (3 runs), and the JS heap after a forced
//   garbage collection;
// - switching Many's chats from its chat list (alternating "Long" and a 20-message chat, both
//   loaded after the first switch; each switch opens the chat from the list, after an untimed Go Back
//   has closed the one before, so these timings are not comparable with builds before the
//   closed-chat screen, which switched from one open chat to the next), and cold switches: each of
//   28 other 20-message chats once, until its chat screen shows (9b: it loads first; with eight
//   idle loaded chats kept, each is a load);
// - a streamed reply: the frame intervals while it streams (each chunk renders through the chat
//   screen's readers) and the long tasks, labeled with the chat and chunk settings;
// - Long's mounted row count and JS heap after a forced collection at the initial 30-row window,
//   the first load-more step past 500 rows, and the end (all 2,000 messages, or MAX_ROWS). Load-more
//   task/paint latency starts at the scroll and waits for new rows before calling window.__time;
//   the initial sample loads 30 -> 45 rows, and later checkpoints summarize the intervening steps;
// - a second streamed reply into Long, after scrolling to the bottom with its loaded rows still
//   mounted, with the same frame-interval and long-task reports as Stream, the trim task and retained heap;
// - a residual stream while scrolled up with up to 600 rows already mounted (no eligible trim);
// - opening the chat list (the list entries of 30 chats).
// Timed as in `measureCharacters.mjs` (task latency, paint; 3 warm-up and 10 measured runs). Compare
// with a baseline build (`RISU_DIST=<dist of an earlier commit>`). The checks: both streamed replies
// are on the server, Long reaches its requested row window, trims at the bottom and retains it when scrolled up, no page error, no unexpected
// egress.
//
// Usage: pnpm build && node util/playwright/measureChats.mjs
// Environment: CHUNKS=200, CHUNK_MS=20 (0 writes back to back, awaiting only socket backpressure),
// MAX_ROWS=2000 (all; smaller limits round up in 15-row steps, with at least the initial 30 rows),
// RISU_DIST=<production build directory>, RISU_CHROME=<Chrome executable>, DEBUG=1 (server logs).
// Fast-chunk example: CHUNK_MS=0 MAX_ROWS=600 node util/playwright/measureChats.mjs
import { CHAT_ROW_CAP } from "../../shared/chatLoadPages.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
const CHUNKS = Number(process.env.CHUNKS ?? 200);
const CHUNK_MS = Number(process.env.CHUNK_MS ?? 20);
const MAX_ROWS = Number(process.env.MAX_ROWS ?? 2000);
if (
    !Number.isSafeInteger(CHUNKS) ||
    CHUNKS < 1 ||
    !Number.isFinite(CHUNK_MS) ||
    CHUNK_MS < 0 ||
    !Number.isSafeInteger(MAX_ROWS) ||
    MAX_ROWS < 1
) {
    throw new Error("CHUNKS and MAX_ROWS must be positive integers; CHUNK_MS must be a nonnegative number.");
}
const streamSettings = `CHUNKS=${CHUNKS}, CHUNK_MS=${CHUNK_MS}`;

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
        if (!res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `word${i} ` } }] })}\n\n`)) {
            await once(res, "drain");
        }
        if (CHUNK_MS > 0) await new Promise((r) => setTimeout(r, CHUNK_MS));
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
    const personas = await single("personas");
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
            {
                op: "create",
                chat: {
                    id,
                    name,
                    note: "",
                    localLore: [],
                    message: Array.from({ length: count }, (_, i) => message(i)),
                    // Bound: Stream's and Long's chats are sent in, and a send refuses an unbound chat
                    // (`docs/plan/chat-binding.md`).
                    ...chatBindingFixture(modelPresets, presets, personas),
                },
            },
        ],
    });
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                ...modelFixtureOps({ ...preset, customTokenizer: "tik" }, modelPresets, modelProfiles),
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
    // A chat row of the list. While a chat is open the sidebar's chat tab shows Go Back in place of
    // the list: Go Back (untimed) closes the chat, which stays loaded, and shows the list.
    const chatRow = async (name) => {
        const back = page.getByRole("button", { name: "Go Back" });
        if (await back.isVisible()) {
            await back.click();
        }
        return page
            .locator("button[data-risu-chat-idx]")
            .filter({ has: page.getByText(name, { exact: true }) })
            .first()
            .elementHandle();
    };
    const switches = { long: [], short: [] };
    for (let run = 0; run < WARMUP + RUNS; run++) {
        for (const [label, name] of [
            ["short", "Short 1"],
            ["long", "Long"],
        ]) {
            const handle = await chatRow(name);
            const ms = await page.evaluate((row) => {
                const start = performance.now();
                row.click();
                return window.__time(start);
            }, handle);
            if (run >= WARMUP) switches[label].push(ms);
            await page.waitForTimeout(400);
        }
    }
    console.log("open Long from the list (2,000 messages, the default visible window)", split(switches.long));
    console.log("open a 20-message chat from the list", split(switches.short));

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
        const handle = await chatRow(`Short ${i}`);
        const ms = await page.evaluate((row) => {
            const start = performance.now();
            row.click();
            return window.__untilChat(start);
        }, handle);
        cold.push(ms);
        await page.waitForTimeout(200);
    }
    console.log("cold switch until the chat shows (28 chats, each once)", stats(cold));

    // 3. A streamed reply into Stream's chat: frame intervals and long tasks while it streams. The
    // character lands on its closed-chat screen; "Open most recent chat" opens its chat.
    await selectCharacter(streamId);
    await page.getByRole("button", { name: /Open most recent chat/ }).click();
    await page.waitForTimeout(1500);
    const streamReply = async ({ scrolledUp = false } = {}) => {
        const input = page.locator("textarea.input-text").first();
        await input.fill("Stream please");
        if (scrolledUp) {
            await page.evaluate(() => {
                const scroller = document.querySelector(".default-chat-screen");
                scroller.scrollTop = -(scroller.scrollHeight - scroller.clientHeight) + 200;
                return window.__time(performance.now());
            });
        }
        await page.evaluate(() => {
            window.__streamStart = performance.now();
            window.__previousReply = document.querySelector(".default-chat-screen .chat-message-container");
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
            window.__longTaskObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries())
                    window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
            });
            window.__longTaskObserver.observe({ type: "longtask", buffered: false });
        });
        // DOM click preserves the scrolled-up viewport (Playwright would scroll the composer into view).
        await page.evaluate(() => document.querySelector("button.button-icon-send").click());
        const waitForReply = (word, timeout) =>
            page.waitForFunction(
                (word) => {
                    const row = document.querySelector(".default-chat-screen .chat-message-container");
                    return row !== window.__previousReply && row?.textContent.includes(word);
                },
                word,
                { polling: 250, timeout },
            );
        // Text-engine locators scan the whole transcript and distort the frame measurements.
        await waitForReply("word0", 30_000);
        await waitForReply("end.", 60_000);
        return page.evaluate(() => {
            window.__sampling = false;
            for (const entry of window.__longTaskObserver.takeRecords())
                window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
            window.__longTaskObserver.disconnect();
            return {
                frames: window.__frames,
                longTasks: window.__longTasks.map((entry) => entry.duration),
                firstSecondMax: Math.max(
                    0,
                    ...window.__longTasks
                        .filter((entry) => entry.start < window.__streamStart + 1000)
                        .map((entry) => entry.duration),
                ),
            };
        });
    };
    const streamed = await streamReply();
    console.log(`frame interval while streaming (ms) (Stream, ${streamSettings})`, stats(streamed.frames));
    console.log(
        `long tasks while streaming (Stream, ${streamSettings})`,
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

    // 3b. Open Long from the list, then grow its row window using the real reversed scroller.
    await selectCharacter(manyId);
    await (await chatRow("Long")).click();
    const rowSelector = ".default-chat-screen .chat-message-container";
    await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 30, rowSelector);
    const mountedRows = () => page.evaluate((selector) => document.querySelectorAll(selector).length, rowSelector);
    const collectedHeapMB = async () => {
        const cdp = await context.newCDPSession(page);
        try {
            await cdp.send("Performance.enable");
            await cdp.send("HeapProfiler.collectGarbage");
            const metrics = await cdp.send("Performance.getMetrics");
            const bytes = metrics.metrics.find((entry) => entry.name === "JSHeapUsedSize").value;
            return +(bytes / 1024 / 1024).toFixed(1);
        } finally {
            await cdp.detach();
        }
    };
    let secondScrollSteps = 0;
    const loadMore = async () => {
        const step = await page.evaluate(async (selector) => {
            const scroller = document.querySelector(".default-chat-screen");
            const before = document.querySelectorAll(selector).length;
            let start;
            let secondScroll = false;
            // Observe before scrolling so synchronous mounts are included. A late layout shift
            // can make onscroll miss the top threshold; retry once, like another wheel tick.
            const rows = await new Promise((resolve, reject) => {
                let timeout;
                const observer = new MutationObserver(() => {
                    const rows = document.querySelectorAll(selector).length;
                    if (rows <= before) return;
                    clearTimeout(timeout);
                    observer.disconnect();
                    resolve(rows);
                });
                // flex-col-reverse: 0 is the bottom; 50 px from the top triggers onscroll's < 100 check.
                const scroll = () => {
                    scroller.scrollTop = -(scroller.scrollHeight - scroller.clientHeight) + 50;
                };
                observer.observe(scroller, { childList: true, subtree: true });
                start = performance.now();
                scroll();
                timeout = setTimeout(() => {
                    secondScroll = true;
                    scroll();
                    timeout = setTimeout(() => {
                        observer.disconnect();
                        reject(new Error(`Long load-more stalled at ${before} rows`));
                    }, 3000);
                }, 3000);
            });
            return { rows, time: await window.__time(start), secondScroll };
        }, rowSelector);
        if (step.secondScroll) secondScrollSteps++;
        return step;
    };
    let longRows = await mountedRows();
    console.log("Long mounted rows (initial window)", { rows: longRows, heapMB: await collectedHeapMB() });
    const targetRows = Math.min(2000, MAX_ROWS);
    let loadSamples = [];
    let lastLoad = null;
    let reported500 = false;
    while (longRows < targetRows) {
        const previousRows = longRows;
        const step = await loadMore();
        longRows = step.rows;
        lastLoad = step.time;
        loadSamples.push(step.time);
        if (previousRows === 30) {
            console.log(`Long load-more from initial window (30 -> ${longRows} rows) (ms)`, split([step.time]));
        }
        if (!reported500 && longRows > 500) {
            console.log("Long mounted rows (first step past 500)", {
                rows: longRows,
                heapMB: await collectedHeapMB(),
                loadMoreMs: split(loadSamples),
            });
            loadSamples = [];
            reported500 = true;
        }
    }
    console.log("Long mounted rows (end)", {
        rows: longRows,
        heapMB: await collectedHeapMB(),
        loadMoreMs: lastLoad === null ? null : split(loadSamples.length ? loadSamples : [lastLoad]),
    });
    check("Long: loaded the requested row window", longRows >= targetRows && longRows <= 2000, {
        rows: longRows,
        targetRows,
    });

    // 3c. Stream into the same Long chat without closing it or resetting its loaded row window.
    await page.evaluate(() => {
        document.querySelector(".default-chat-screen").scrollTop = 0;
        return window.__time(performance.now());
    });
    const longStreamed = await streamReply();
    console.log(
        `frame interval while streaming into Long (${longRows} rows mounted, ${streamSettings}) (ms)`,
        stats(longStreamed.frames),
    );
    console.log(
        `long tasks while streaming into Long (${longRows} rows mounted, ${streamSettings})`,
        longStreamed.longTasks.length,
        "total ms",
        +longStreamed.longTasks.reduce((a, b) => a + b, 0).toFixed(1),
    );
    const rowsAfterStreaming = await mountedRows();
    console.log(
        "Long longest long task in the first second after send (trim, ms; 0 = none >= 50 ms)",
        longStreamed.firstSecondMax,
    );
    console.log("Long mounted rows after streaming", { rows: rowsAfterStreaming, heapMB: await collectedHeapMB() });
    check("Long: the row window is capped after streaming", rowsAfterStreaming <= CHAT_ROW_CAP + 2, {
        before: longRows,
        after: rowsAfterStreaming,
    });
    await page.waitForTimeout(3000);
    const longRead = await api("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({ chats: [{ characterId: manyId, id: "long" }] }),
    });
    const longReply = longRead.body?.chats?.[0]?.data?.message?.at(-1)?.data;
    check("Long: the server holds the streamed reply", typeof longReply === "string" && longReply.includes("end."), {
        tail: typeof longReply === "string" ? longReply.slice(-20) : longReply,
    });

    // 3d. Keep hundreds mounted while sending from a scrolled-up viewport. No append trim is
    // eligible here, including with back-to-back chunks: the window is ready before the send.
    const residualTarget = Math.min(targetRows, 600);
    let residualRows = await mountedRows();
    while (residualRows < residualTarget) residualRows = (await loadMore()).rows;
    // Both the initial window and the residual scenario use loadMore; report their total once.
    console.log("Long load-more steps needing a second scroll:", secondScrollSteps);
    const residual = await streamReply({ scrolledUp: true });
    console.log(
        `frame interval while streaming into Long scrolled up (${residualRows} rows mounted, ${streamSettings}) (ms)`,
        stats(residual.frames),
    );
    console.log(
        `long tasks while streaming into Long scrolled up (${residualRows} rows mounted, ${streamSettings})`,
        residual.longTasks.length,
        "total ms",
        +residual.longTasks.reduce((a, b) => a + b, 0).toFixed(1),
    );
    check("Long: scrolled-up streaming keeps the loaded window", (await mountedRows()) >= residualRows, {
        before: residualRows,
        after: await mountedRows(),
    });
    await page.waitForTimeout(3000);

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
    console.log("select Many (its closed-chat screen and 30-chat list)", split(opens));

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
