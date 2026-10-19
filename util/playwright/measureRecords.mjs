// Measurement for Phase 6 slice 4 (settings ownership): the spike verdict's obligation
// (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/spike-projection-bindings.md`, "Verdict")
// to time the deep write-through records in a production build before the reader slices start.
//
// Against the production build (`pnpm build` first: the server serves `dist/`), in headless Chrome,
// through the real UI:
// - the NovelAI image settings mounting (the Image Generation page: the nested `NAIImgConfig`
//   controls), and 100 keystrokes into its width (`NAIImgConfig.width`, a nested section
//   field bound with `bind:value`), spaced 50 ms apart;
// - preset reorder: a drop on the preset list (`botpreset.svelte`'s handler, `moveRecordListItem`)
//   with 50 presets;
// - lorebook drag: the module lorebook list's sort handler (`LoreBookList.svelte`'s `onEnd`, through
//   the module record's wrapper, `replaceRecordList`) with 300 entries. (The global lorebook settings
//   page has no menu entry, so a module's lorebook stands for a settings-record lorebook.)
// Each is timed from the input: the task latency (to a message-channel callback: the handler and
// Svelte's update ran), through paint (to the second animation frame, which includes waiting for the
// frame boundary), and for the drag its completion (the handler awaits its DOM stabilization and the
// Sortable recreation). 3 warm-up and 10 measured runs (typing: every keystroke of one run), median and
// p95, reported against a 16 ms frame. The numbers are measurements: compare them with a baseline
// build (`RISU_DIST=<dist of an earlier commit>`). The checks are that the reorder and the drag left
// exactly the expected order on the server, that typing saved, and no page error or unexpected
// egress. The save batches are counted separately (network, not interaction time); the record
// notifications are not observable in a production build.
//
// Usage: pnpm build && node util/playwright/measureRecords.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, repoRoot, unexpectedEgress } from "./stack.mjs";

const FRAME_MS = 16;
const WARMUP = 3;
const RUNS = 10;
const port = 6261;
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

const workDir = await mkdtemp(path.join(os.tmpdir(), "risu-measure-"));
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

    // Seed through the routes: setup done, 50 presets, a module with a 300-entry lorebook, NovelAI.
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const presets = await single("presets");
    const modules = await single("modules");
    const media = await single("memoryTranslateMedia");
    const presetList = Array.from({ length: 50 }, (_, i) => ({
        ...presets.data[0],
        id: i === 0 ? presets.data[0].id : randomUUID(),
        name: `Preset ${i}`,
    }));
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
                { kind: "presets", id: "main", baseRevision: presets.revision, data: presetList },
                {
                    kind: "modules",
                    id: "main",
                    baseRevision: modules?.revision ?? null,
                    data: [{ id: randomUUID(), name: "Big Module", description: "", lorebook }],
                },
                {
                    kind: "memoryTranslateMedia",
                    id: "main",
                    baseRevision: media.revision,
                    data: { ...media.data, sdProvider: "novelai" },
                },
            ],
            chats: [],
            chatOrders: [],
        }),
    });
    check("seed: stored", seeded.status === 200, seeded.status === 200 ? undefined : seeded);
    await open();
    // The sidebar starts collapsed: its toggle shows the settings button.
    if (!(await settingsButton.isVisible().catch(() => false))) {
        await page.locator("button:has(svg.lucide-list)").first().click();
    }
    await settingsButton.waitFor({ timeout: 30_000 }).catch(async (error) => {
        console.error((await page.locator("body").innerText()).slice(0, 500));
        console.error(
            await page.evaluate(() =>
                [...document.querySelectorAll("button svg")].map((svg) => svg.getAttribute("class")).join(" | "),
            ),
        );
        throw error;
    });
    await page.waitForTimeout(2000);

    // The in-page timers. `__untilPaint`: from `start` to the second animation frame (through paint;
    // it includes waiting for the frame boundary, so even no work reads up to two frame periods).
    // `__untilIdle`: from `start` to a message-channel callback, the task latency (the handler and
    // Svelte's update ran; it is not isolated script time: layout or other tasks may run first).
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
    const menu = (label) => page.locator(`button:has(> span:text-is("${label}"))`).first();

    // 1. The NovelAI image settings (the Image Generation page: the nested `NAIImgConfig` controls)
    // mounting, and typing into a nested section field.
    await settingsButton.click();
    await page.waitForTimeout(500);
    const mounts = [];
    for (let run = 0; run < WARMUP + RUNS; run++) {
        await menu("Voice & Emotion").click();
        await page.waitForTimeout(300);
        const handle = await menu("Image Generation").elementHandle();
        const ms = await page.evaluate((tab) => {
            const start = performance.now();
            tab.click();
            return window.__time(start);
        }, handle);
        if (run >= WARMUP) mounts.push(ms);
        await page.waitForTimeout(200);
    }
    const width = page
        .locator('xpath=//span[normalize-space(.)="Width"]/following-sibling::*[1]/descendant-or-self::input')
        .first();
    await width.waitFor({ timeout: 10_000 }).catch(async (error) => {
        console.error((await page.locator("body").innerText()).slice(0, 1500));
        throw error;
    });
    await width.click();
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
        await page.keyboard.press(i % 2 === 0 ? "Backspace" : String(i % 10));
        // Spaced, so a keystroke's timer is not queued behind the next one's input.
        await page.waitForTimeout(50);
    }
    await page.waitForTimeout(1500);
    const keys = await page.evaluate(() => window.__keys);
    const typingBatches = batches() - before;
    const mount = split(mounts);
    const typing = split(keys);
    console.log("NovelAI image settings mount", mount);
    console.log("typing, NAIImgConfig.width", typing, `batches: ${typingBatches}`);
    budget("typing", typing);
    const typed = Number(await width.inputValue());
    const savedMedia = await api("/api/resources/memoryTranslateMedia/main");
    check("typing: the server holds the width typed last", savedMedia.body?.data?.NAIImgConfig?.width === typed, {
        typed,
        saved: savedMedia.body?.data?.NAIImgConfig?.width,
        typingBatches,
    });

    // 2. The preset reorder (50 presets).
    await menu("Chat Bot").click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Presets", exact: true }).first().click();
    await page.locator('[role="listitem"]').nth(49).waitFor({ timeout: 10_000 });
    before = batches();
    const reorders = [];
    for (let run = 0; run < WARMUP + RUNS; run++) {
        const ms = await page.evaluate((run) => {
            const items = document.querySelectorAll('[role="listitem"]');
            const [from, to] = run % 2 === 0 ? [0, 49] : [48, 0];
            const transfer = new DataTransfer();
            transfer.setData("application/x-risu-preset-drag", String(from));
            const start = performance.now();
            items[to].dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
            return window.__time(start);
        }, run);
        if (run >= WARMUP) reorders.push(ms);
        await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1500);
    const reorderBatches = batches() - before;
    const order = await api("/api/resources/presets/main");
    const reorder = split(reorders);
    console.log("preset reorder, 50 presets", reorder, `batches: ${reorderBatches}`);
    budget("preset reorder", reorder);
    // The handler's moves (`movePreset`: to the slot before the drop target), replayed on the ids.
    const expectedPresets = presetList.map((preset) => preset.id);
    for (let run = 0; run < WARMUP + RUNS; run++) {
        const [from, to] = run % 2 === 0 ? [0, 49] : [48, 0];
        const [moved] = expectedPresets.splice(from, 1);
        expectedPresets.splice(from < to ? to - 1 : to, 0, moved);
    }
    check(
        "preset reorder: the server holds the order of the 13 moves",
        JSON.stringify(order.body?.data?.map((preset) => preset.id)) === JSON.stringify(expectedPresets),
        { reorderBatches },
    );
    await page.locator("div.z-40 button:has(svg.lucide-x)").first().click();
    await page.waitForTimeout(300);
    if (
        !(await menu("Modules")
            .isVisible()
            .catch(() => false))
    ) {
        await settingsButton.click();
        await page.waitForTimeout(500);
    }

    // 3. The module lorebook drag (300 entries), through the list's sort handler.
    await menu("Modules").click();
    await page.waitForTimeout(500);
    await page.locator('div:has(> span:text-is("Big Module")) button:has(svg.lucide-square-pen)').first().click();
    await page.waitForTimeout(500);
    await menu("Lorebook").click();
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
            // The handler awaits its DOM stabilization and the Sortable recreation: its completion.
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
    console.log("module lorebook drag, 300 entries", drag, `batches: ${dragBatches}`);
    budget("lorebook drag", drag);
    const expectedLore = lorebook.map((entry) => entry.comment);
    for (let run = 0; run < WARMUP + RUNS; run++) {
        const [from, to] = run % 2 === 0 ? [0, 299] : [299, 0];
        const [moved] = expectedLore.splice(from, 1);
        expectedLore.splice(to, 0, moved);
    }
    const savedModules = await api("/api/resources/modules/main");
    check(
        "lorebook drag: the server holds the order of the 13 drags",
        JSON.stringify(savedModules.body?.data?.[0]?.lorebook?.map((entry) => entry.comment)) ===
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
