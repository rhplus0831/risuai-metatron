// Measurement for the character records in a production build, as `measureRecords.mjs` does for the
// settings records: the characters are deep write-through records (`records.svelte.ts`), and
// `characterList()` is their list's wrapper.
//
// Against the production build (`pnpm build` first: the server serves `dist/`), in headless Chrome,
// through the real UI, with 300 characters (one of them "Big": a 300-entry lorebook and a chat of 400
// messages):
// - selecting a character from the sidebar (alternating "Big" and "Small"): `changeChar`, closing
//   the other character's open chat, and its closed-chat screen; then, timed on its own, opening its
//   chat with "Open most recent chat": the chat screen rendering its default visible window of the
//   400 messages (`loadPages`), not the whole history, until the rows' bodies show (`rendered`).
//   Before the closed-chat screen one select timed both, so neither number compares directly with
//   such a baseline;
// - 100 keystrokes into Big's description (`bind:value` on the character record), 50 ms apart;
// - the character lorebook drag (300 entries) through the list's sort handler (`LoreBookList.svelte`'s
//   `onEnd`: one assignment of `globalLore`).
// Timed as in `measureRecords.mjs` (task latency, paint, and the drag's completion; 3 warm-up and 10
// measured runs). Compare with a baseline build (`RISU_DIST=<dist of an earlier commit>`; it needs the
// closed-chat screen, or the first step waits for its button in vain: measure an older build with
// this script's version before 2026-10-16). The checks:
// the typed description and the dragged order are on the server, no page error, no unexpected egress.
//
// Usage: pnpm build && node util/playwright/measureCharacters.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, repoRoot, unexpectedEgress } from "./stack.mjs";

const FRAME_MS = 16;
const WARMUP = 3;
const RUNS = 10;
const port = 6262;
const base = `http://localhost:${port}`;

// `RISU_DIST` measures another build (a baseline built from an earlier commit).
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
// A measurement, not a check: compare it with a baseline build (`RISU_DIST`).
const budget = (name, sample) =>
    console.log(
        `${sample.task.p95 <= FRAME_MS ? "within" : "OVER"} a ${FRAME_MS} ms frame: ${name} (task latency p95 ${sample.task.p95} ms, median ${sample.task.median} ms)`,
    );
const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { n: sorted.length, median: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +sorted.at(-1).toFixed(2) };
};

const workDir = await mkdtemp(path.join(os.tmpdir(), "risu-measure-chars-"));
await symlink(path.join(repoRoot, "public"), path.join(workDir, "public"), "dir");
await mkdir(path.join(workDir, "server"));
await symlink(path.join(repoRoot, "server/assets"), path.join(workDir, "server/assets"), "dir");
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
    const requests = [];
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    page.on("request", (r) => {
        const h = r.headers();
        if (h["risu-auth"]) auth = h["risu-auth"];
        if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
        requests.push({ method: r.method(), path: new URL(r.url()).pathname });
    });
    const batches = () => requests.filter((r) => r.method === "POST" && r.path === "/api/resources/batch").length;
    const api = async (p, init = {}) => {
        const r = await fetch(base + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;

    const settingsButton = page.locator("button:has(svg.lucide-settings)").first();
    // Loaded: the main screen (its "Welcome to RisuAI!" sidebar header).
    const welcome = page.getByText("Welcome to Risuai!");
    const open = async () => {
        await page.goto(base);
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            if (await settingsButton.isVisible().catch(() => false)) return;
            if (
                await page
                    .locator("button:has(svg.lucide-list)")
                    .isVisible()
                    .catch(() => false)
            )
                return;
            if (auth && (await welcome.isVisible().catch(() => false))) return;
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

    // Seed through the routes: setup done, 300 characters (Big first), Big's chat of 400 messages.
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const lorebook = Array.from({ length: 300 }, (_, i) => ({
        key: `key${i}`,
        secondkey: "",
        insertorder: 100,
        comment: `Entry ${i}`,
        content: `Content of entry ${i} `.repeat(20),
        mode: "normal",
        alwaysActive: false,
        selective: false,
        bookVersion: 2,
    }));
    const character = (chaId, name, extra = {}) => ({
        chaId,
        name,
        type: "character",
        desc: `The description of ${name}. `.repeat(10),
        firstMessage: "Hello.",
        globalLore: [],
        customscript: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        chatFolders: [],
        firstMsgIndex: -1,
        ...extra,
    });
    const bigId = randomUUID();
    const smallId = randomUUID();
    const characters = [
        character(bigId, "Big", { globalLore: lorebook }),
        character(smallId, "Small"),
        ...Array.from({ length: 298 }, (_, i) => character(randomUUID(), `Character ${i}`)),
    ];
    const messages = Array.from({ length: 400 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "char",
        data: `Message ${i}: ${"some words of the conversation ".repeat(8)}`,
        chatId: randomUUID(),
    }));
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
                ...characters.map((data) => ({ kind: "characters", id: data.chaId, baseRevision: null, data })),
            ],
            chats: characters.map((data) => ({
                characterId: data.chaId,
                chatId: `${data.chaId}-chat`,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: `${data.chaId}-chat`,
                            name: "Chat 1",
                            note: "",
                            localLore: [],
                            message: data.chaId === bigId ? messages : [],
                        },
                    },
                ],
            })),
            chatOrders: [],
        }),
    });
    check("seed: stored", seeded.status === 200, seeded.status === 200 ? undefined : seeded);
    await open();
    await page.locator(`[data-char-id="${bigId}"]`).first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2000);

    // The in-page timers (as in `measureRecords.mjs`).
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
        // Until the opened chat's rows show their bodies, then a frame: a body is empty until its
        // server transform answers (`ChatBody.svelte`), so every row's `.chattext` has text and the
        // chat's last message (`needle`) shows. Rejects after 10 s.
        window.__untilRendered = (start, needle) =>
            new Promise((resolve, reject) => {
                const frame = () => {
                    const screen = document.querySelector(".default-chat-screen");
                    const bodies = screen ? [...screen.querySelectorAll(".chattext")] : [];
                    if (
                        bodies.length > 0 &&
                        bodies.every((body) => body.textContent.trim() !== "") &&
                        screen.innerText.includes(needle)
                    ) {
                        requestAnimationFrame(() => resolve(performance.now() - start));
                    } else if (performance.now() - start > 10_000) {
                        reject(new Error(`the chat did not render "${needle}" within 10 s`));
                    } else {
                        requestAnimationFrame(frame);
                    }
                };
                requestAnimationFrame(frame);
            });
    });
    const split = (samples) =>
        Object.fromEntries(Object.keys(samples[0]).map((key) => [key, stats(samples.map((sample) => sample[key]))]));

    // 1. Selecting a character from the sidebar (Big: 400 messages and a 300-entry lorebook; Small),
    // which closes the other character's open chat and lands on its closed-chat screen, then opening
    // its chat from there (task and paint as above, and `rendered`: until the bodies show). The wait
    // for the button between the two is not timed.
    const selects = { big: [], small: [] };
    const opens = { big: [], small: [] };
    const openButton = page.getByRole("button", { name: /Open most recent chat/ });
    const select = (avatar) =>
        page.evaluate((element) => {
            const start = performance.now();
            element.closest('[role="button"]').click();
            return window.__time(start);
        }, avatar);
    const openChat = (button, needle) =>
        page.evaluate(
            async ([element, text]) => {
                const start = performance.now();
                element.click();
                const [timed, rendered] = await Promise.all([
                    window.__time(start),
                    window.__untilRendered(start, text),
                ]);
                return { ...timed, rendered };
            },
            [button, needle],
        );
    for (let run = 0; run < WARMUP + RUNS; run++) {
        for (const [label, chaId, needle] of [
            ["small", smallId, "Hello."],
            ["big", bigId, "Message 399:"],
        ]) {
            const avatar = await page.locator(`[data-char-id="${chaId}"]`).first().elementHandle();
            const selected = await select(avatar);
            await openButton.waitFor({ timeout: 15_000 });
            const opened = await openChat(await openButton.elementHandle(), needle);
            if (run >= WARMUP) {
                selects[label].push(selected);
                opens[label].push(opened);
            }
            await page.waitForTimeout(400);
        }
    }
    const selectSmall = split(selects.small);
    const openSmall = split(opens.small);
    console.log("select Big from Small's open chat (Big's closed-chat screen)", split(selects.big));
    console.log("open Big's chat (a 400-message history, the default visible window)", split(opens.big));
    console.log("select Small from Big's open chat (Small's closed-chat screen)", selectSmall);
    console.log("open Small's chat", openSmall);
    budget("select Small", selectSmall);
    budget("open Small's chat", openSmall);

    // 2. Typing into Big's description (the character editor).
    await page.getByRole("button", { name: "Character", exact: true }).first().click();
    await page.waitForTimeout(1000);
    const description = page
        .locator('xpath=//span[starts-with(normalize-space(.), "Description")]/following::textarea[1]')
        .first();
    await description.waitFor({ timeout: 10_000 });
    await description.click();
    await page.keyboard.press("End");
    await page.evaluate(() => {
        window.__keys = [];
        document.addEventListener(
            "keydown",
            () => {
                const start = performance.now();
                window.__time(start).then((sample) => window.__keys.push(sample));
            },
            true,
        );
    });
    let before = batches();
    for (let i = 0; i < 100; i++) {
        await page.keyboard.press(i % 2 === 0 ? "x" : "Backspace");
        await page.waitForTimeout(50);
    }
    await page.keyboard.press("y");
    await page.waitForTimeout(1500);
    const typingBatches = batches() - before;
    const typing = split(await page.evaluate(() => window.__keys));
    console.log("typing, Big's description", typing, `batches: ${typingBatches}`);
    budget("typing", typing);
    const typed = await description.inputValue();
    const savedBig = await api(`/api/resources/characters/${bigId}`);
    check("typing: the server holds the description typed last", savedBig.body?.data?.desc === typed, {
        typingBatches,
        tail: typed.slice(-5),
    });

    // 3. The character lorebook drag (300 entries), through the list's sort handler.
    await page.locator("button:has(svg.lucide-book)").first().click();
    await page.waitForTimeout(1500);
    before = batches();
    const drags = [];
    for (let run = 0; run < WARMUP + RUNS; run++) {
        const ms = await page.evaluate(async (run) => {
            const lists = [...document.querySelectorAll("*")].filter((el) =>
                Object.keys(el).some((key) => key.startsWith("Sortable")),
            );
            const list = lists.find((el) => el.children.length >= 300) ?? lists[0];
            const instance = list[Object.keys(list).find((key) => key.startsWith("Sortable"))];
            const [oldIndex, newIndex] = run % 2 === 0 ? [0, 299] : [299, 0];
            const start = performance.now();
            const done = instance.options.onEnd({
                from: list,
                to: list,
                oldIndex,
                newIndex,
                item: list.children[oldIndex],
            });
            const complete = Promise.resolve(done).then(() => performance.now() - start);
            const sample = await window.__time(start);
            return { ...sample, complete: await complete };
        }, run);
        if (run >= WARMUP) drags.push(ms);
        await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1500);
    const dragBatches = batches() - before;
    const drag = split(drags);
    console.log("character lorebook drag, 300 entries", drag, `batches: ${dragBatches}`);
    budget("lorebook drag", drag);
    const expectedLore = lorebook.map((entry) => entry.comment);
    for (let run = 0; run < WARMUP + RUNS; run++) {
        const [from, to] = run % 2 === 0 ? [0, 299] : [299, 0];
        const [moved] = expectedLore.splice(from, 1);
        expectedLore.splice(to, 0, moved);
    }
    const savedLore = await api(`/api/resources/characters/${bigId}`);
    check(
        "lorebook drag: the server holds the order of the 13 drags",
        JSON.stringify(savedLore.body?.data?.globalLore?.map((entry) => entry.comment)) ===
            JSON.stringify(expectedLore),
        { dragBatches },
    );

    const denied = unexpectedEgress(blocked, []);
    check("no unexpected outbound request", denied.length === 0, denied.length === 0 ? undefined : denied);
    check("no page error", pageErrors.length === 0, pageErrors.length === 0 ? undefined : pageErrors);
} catch (error) {
    console.error(error);
    results.push(false);
} finally {
    await browser.close();
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    await rm(workDir, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
