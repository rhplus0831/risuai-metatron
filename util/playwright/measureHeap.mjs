// Measurement for the heap memory plan (`docs/plan/heap-memory.md`, slice M0): the page's JS heap
// with large modules and characters, in the shape of the user's 2026-10-19 snapshots but with
// generated content.
//
// Against the production build (`pnpm build` first: the server serves `dist/`), in headless Chrome,
// through the real UI. Seeds 12 enabled modules of 11,000 `[name, path, "avif"]` assets each, two
// ~2 MB characters (a 300-entry lorebook) with 300 additional assets and 60 emotion images each, and
// five small characters whose chats carry a `<style>` of 120 `@font-face` rules and an `@import`ed
// stylesheet (a `data:` URL) of 120 more. Then takes a CDP
// heap snapshot (after a forced GC) at each step, without reloading the page after boot:
// 1. `boot`: the app loaded;
// 2. `character-assets`: a big character's emotion and additional asset lists (its settings' second
//    tab);
// 3. `chats`: after opening the five small characters' chats, one after another;
// 4. `module-assets`: the module editor's asset list of the first module (one page of rows);
// 5. `module-asset-edit`: after renaming its first asset by typing (timed per keystroke), deleting
//    its second, and the save;
// 6. `module-edit`: after typing into that module's description and its save;
// 7. `home`: back on the home screen (the sidebar's Home button).
// Each snapshot is analysed by `util/heap/analyze.mjs report` in its own process and printed as one
// table row: JS self size, `JSProxy` count, proxies of asset tuples, proxies retaining 256 KB or
// more (count, and the outermost ones' retained size), likely duplicated large strings (same size and first 1,024 characters:
// a snapshot keeps no more of a string), `FontFace`/`CSSStyleSheet`. The numbers are measurements: compare
// them with a baseline build (`RISU_DIST=<dist of an earlier commit>`). The checks are that the seed
// was stored, the asset and description edits reached the server, and no page error or unexpected
// egress.
//
// Env: `RISU_DIST` (another build), `HEAP_OUT` (keep the snapshots in this directory; by default they
// go to a temporary directory and are deleted), `HEAP_ANALYZE_MB` (the analysis heap, default 16000),
// `DEBUG` (server output).
//
// Usage: pnpm build && node util/playwright/measureHeap.mjs
import { spawn, execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, repoRoot, unexpectedEgress } from "./stack.mjs";

const MODULES = 12;
const ASSETS_PER_MODULE = 11_000;
const BIG_CHARACTERS = 2;
const SMALL_CHARACTERS = 5;
const FONT_FACES = 120;
const port = 6264;
const base = `http://localhost:${port}`;

const dist = process.env.RISU_DIST ? path.resolve(process.env.RISU_DIST) : path.join(repoRoot, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
    console.error("No production build: run `pnpm build` first.");
    process.exit(1);
}

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};

// Another server on the port would be seeded and measured instead of this one.
if (
    await fetch(`${base}/api/test_auth`).then(
        () => true,
        () => false,
    )
) {
    console.error(`Port ${port} is in use: stop the other server first.`);
    process.exit(1);
}

const keepSnapshots = process.env.HEAP_OUT !== undefined;
const snapshotDir = keepSnapshots
    ? path.resolve(process.env.HEAP_OUT)
    : await mkdtemp(path.join(os.tmpdir(), "risu-heap-"));
await mkdir(snapshotDir, { recursive: true });
const analyzeHeapMB = Number(process.env.HEAP_ANALYZE_MB ?? 16000);

const workDir = await mkdtemp(path.join(os.tmpdir(), "risu-measure-"));
await symlink(path.join(repoRoot, "public"), path.join(workDir, "public"), "dir");
await symlink(dist, path.join(workDir, "dist"), "dir");
await copyFile(path.join(repoRoot, "version.json"), path.join(workDir, "version.json"));
// The store stays in `workDir` whatever the shell exports (as `startStack` in `stack.mjs` does).
const { RISU_HOST, RISU_SAVE_DIR, RISU_AGENT_DEV_AUTH_BYPASS, ...inheritedEnv } = process.env;
// Not `<workDir>/save`: the server logs a store path other than `<cwd>/save` (see `listening`).
const savePath = path.join(workDir, "heap-save");
const server = spawn(process.execPath, [path.join(repoRoot, "server/src/main.ts")], {
    cwd: workDir,
    env: { ...inheritedEnv, PORT: String(port), RISU_SAVE_DIR: savePath },
    stdio: ["ignore", "pipe", process.env.DEBUG ? "inherit" : "ignore"],
});
// This child's own listen callback (`server/src/main.ts`) logs its URL and, the store not being
// `<cwd>/save`, its storage path: both lines prove that the port answering is this child.
let serverOutput = "";
const listening = new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
        if (process.env.DEBUG) process.stdout.write(chunk);
        serverOutput += chunk;
        if (serverOutput.includes(`:${port}/`) && serverOutput.includes(`[Server] Storage: ${savePath}`)) resolve();
    });
    server.once("exit", (code) => reject(new Error(`the server exited (${code})`)));
});
listening.catch(() => {});
const waitForServer = async () => {
    await Promise.race([
        listening,
        new Promise((_, reject) => setTimeout(() => reject(new Error("the server did not start")), 30_000)),
    ]);
    for (let i = 0; i < 150; i++) {
        try {
            const response = await fetch(`${base}/api/test_auth`);
            if (response.status && server.exitCode === null) return;
        } catch {}
        if (server.exitCode !== null) throw new Error(`the server exited (${server.exitCode})`);
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the server did not answer");
};
let browser = null;

const hex = (i, salt) => ((i * 2654435761 + salt * 40503) >>> 0).toString(16).padStart(8, "0");
const assetList = (count, prefix, salt) =>
    Array.from({ length: count }, (_, i) => [
        `${prefix}_${i % 97}.Expression_${i}`,
        `assets/${hex(i, salt)}${hex(i + 1, salt)}${hex(i + 2, salt)}${hex(i + 3, salt)}.avif`,
        "avif",
    ]);
// `FONT_FACES` subset faces of a web font, as a font service's stylesheet declares them.
const fontFaces = (family) =>
    Array.from(
        { length: FONT_FACES },
        (_, i) =>
            `@font-face{font-family:"${family}";font-weight:400;font-display:swap;` +
            `src:url(/fonts/${family}-${i}.woff2) format("woff2");` +
            `unicode-range:U+${(0xac00 + i * 96).toString(16)}-${(0xac00 + i * 96 + 95).toString(16)};}`,
    ).join("");
// A chat style with inline faces and an `@import`ed stylesheet of more (a `data:` URL: no egress).
const fontStyle = (family) =>
    `<style>@import url("data:text/css;base64,${Buffer.from(fontFaces(`${family}Imported`)).toString("base64")}");` +
    `${fontFaces(family)}.heap-font{font-family:"${family}","${family}Imported";}</style>` +
    `<p class="heap-font">가나다라마바사</p>`;

try {
    await waitForServer();
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const blocked = await isolateContext(context);
    const pageErrors = [];
    let auth = null;
    let epoch = null;
    const requests = [];
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    page.on(
        "console",
        (m) => process.env.DEBUG_CONSOLE && m.type() === "error" && console.error("console:", m.text().slice(0, 500)),
    );
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
    const dump = async (what) => {
        console.error(`--- ${what}: visible text`);
        console.error((await page.locator("body").innerText()).slice(0, 1500));
        console.error(
            await page.evaluate(() =>
                [...document.querySelectorAll("button svg")].map((svg) => svg.getAttribute("class")).join(" | "),
            ),
        );
    };

    const settingsButton = page.locator("button:has(svg.lucide-settings)").first();
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

    // Seed through the routes.
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const modules = await single("modules");
    const enabled = await single("enabledModules");
    const moduleList = Array.from({ length: MODULES }, (_, m) => ({
        id: randomUUID(),
        name: `Heap Module ${m}`,
        description: "",
        lorebook: [],
        assets: assetList(ASSETS_PER_MODULE, `Module${m}`, m + 1),
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
    const bigIds = Array.from({ length: BIG_CHARACTERS }, () => randomUUID());
    const smallIds = Array.from({ length: SMALL_CHARACTERS }, () => randomUUID());
    const characters = [
        ...bigIds.map((id, i) =>
            character(id, `Big ${i}`, {
                // ~2 MB of UTF-16 text, as the user's large characters. In lorebook entries: the
                // character settings tokenize the description and first message on the main thread
                // (~20 s for 1.7 MB), which would measure the tokenizer instead of the heap.
                globalLore: Array.from({ length: 300 }, (_, k) => ({
                    key: `key${k}`,
                    secondkey: "",
                    insertorder: 100,
                    comment: `Entry ${k}`,
                    content: `큰 캐릭터 ${i}의 설정 ${k}. `.repeat(240),
                    mode: "normal",
                    alwaysActive: false,
                    selective: false,
                    bookVersion: 2,
                })),
                additionalAssets: assetList(300, `Big${i}`, 100 + i),
                emotionImages: assetList(60, `Emotion${i}`, 200 + i).map(([name, file]) => [name, file]),
            }),
        ),
        ...smallIds.map((id, i) => character(id, `Small ${i}`)),
    ];
    const chatOf = (id, i) => ({
        characterId: id,
        chatId: `${id}-chat`,
        baseRevision: null,
        ops: [
            {
                op: "create",
                chat: {
                    id: `${id}-chat`,
                    name: "Chat 1",
                    note: "",
                    localLore: [],
                    message: Array.from({ length: 6 }, (_, k) => ({
                        role: k % 2 === 0 ? "user" : "char",
                        data: k === 1 ? fontStyle(`HeapFont${i}`) : `Message ${k} of chat ${i}.`,
                        chatId: randomUUID(),
                    })),
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
                { kind: "modules", id: "main", baseRevision: modules?.revision ?? null, data: moduleList },
                {
                    kind: "enabledModules",
                    id: "main",
                    baseRevision: enabled?.revision ?? null,
                    data: moduleList.map((module) => module.id),
                },
                ...characters.map((data) => ({ kind: "characters", id: data.chaId, baseRevision: null, data })),
            ],
            chats: characters.map((data, i) => chatOf(data.chaId, i)),
            chatOrders: [],
        }),
    });
    check("seed: stored", seeded.status === 200, seeded.status === 200 ? undefined : seeded);

    // How long the page's main thread stays busy after an action (a measurement, printed).
    const busy = async (what) => {
        const at = Date.now();
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
        await page.waitForTimeout(500);
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
        console.log(`${what}: page busy ${Date.now() - at - 500} ms`);
    };
    const cdp = await context.newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    const rows = [];
    const snapshot = async (step) => {
        await page.waitForTimeout(1500);
        await cdp.send("HeapProfiler.collectGarbage");
        const file = path.join(snapshotDir, `${step}.heapsnapshot`);
        const out = createWriteStream(file);
        const written = new Promise((resolve, reject) => {
            out.on("error", reject);
            out.on("finish", resolve);
        });
        // Handled now (a write error can come while the capture is still running), awaited below.
        written.catch(() => {});
        const onChunk = ({ chunk }) => out.write(chunk);
        cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
        try {
            await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
        } finally {
            cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
            out.end();
        }
        await written;
        const { stdout } = await promisify(execFile)(
            process.execPath,
            [
                `--max-old-space-size=${analyzeHeapMB}`,
                path.join(repoRoot, "util/heap/analyze.mjs"),
                "report",
                file,
                "--json",
            ],
            { maxBuffer: 1 << 20 },
        );
        const report = JSON.parse(stdout);
        rows.push({ step, fileBytes: (await stat(file)).size, ...report });
        if (!keepSnapshots) await rm(file);
        console.log(
            `snapshot ${step}: ${(report.totalBytes / 1048576).toFixed(1)} MB, ${report.tupleProxies} tuple proxies`,
        );
    };

    // 1. Boot.
    await open();
    await page.locator(`[data-char-id="${bigIds[0]}"]`).first().waitFor({ timeout: 120_000 });
    await snapshot("boot");

    // 2. A big character's emotion and additional asset lists (the character settings' second tab).
    await page.locator(`[data-char-id="${bigIds[0]}"]`).first().click();
    await busy("big character select");
    // The closed-chat panel's "Character" tab shows the character settings.
    const characterTabAt = Date.now();
    await page
        .getByRole("button", { name: "Character", exact: true })
        .first()
        .click({ timeout: 120_000 })
        .catch(async (error) => {
            if (process.env.HEAP_SCREENSHOT) await page.screenshot({ path: process.env.HEAP_SCREENSHOT });
            await dump("closed-chat screen");
            throw error;
        });
    console.log(`character tab: ${Date.now() - characterTabAt} ms to click`);
    await page.waitForTimeout(500);
    await page
        .locator("button:has(svg.lucide-smile)")
        .first()
        .click({ timeout: 120_000 })
        .catch(async (error) => {
            await dump("character settings");
            throw error;
        });
    await page.waitForTimeout(1500);
    await snapshot("character-assets");

    // 3. Open the small characters' chats, one after another. Back on the "Chat" tab first: the
    // character settings of a character switched to on its closed-chat screen alert a tokenizer
    // `TypeError` (`CharConfig.svelte` `loadTokenize` gets an undefined note without a chat).
    await page.getByRole("button", { name: "Chat", exact: true }).first().click({ timeout: 60_000 });
    for (const id of smallIds) {
        await page.locator(`[data-char-id="${id}"]`).first().click();
        await page
            .getByRole("button", { name: /Open most recent chat/ })
            .click({ timeout: 10_000 })
            .catch(async (error) => {
                await page
                    .getByText("Show Error Details")
                    .click()
                    .catch(() => {});
                await page.waitForTimeout(500);
                console.error(
                    await page
                        .locator("div.z-50")
                        .first()
                        .innerText()
                        .catch(() => "(no overlay)"),
                );
                await dump("open chat");
                throw error;
            });
        await page.locator(".default-chat-screen .chattext").first().waitFor({ timeout: 30_000 });
        await page.waitForTimeout(1000);
    }
    await snapshot("chats");

    // 4. The first module's asset list.
    const menu = (label) => page.locator(`button:has(> span:text-is("${label}"))`).first();
    if (!(await settingsButton.isVisible().catch(() => false))) {
        await page.locator("button:has(svg.lucide-list)").first().click();
    }
    await settingsButton.click();
    await page.waitForTimeout(500);
    await menu("Modules")
        .click({ timeout: 10_000 })
        .catch(async (error) => {
            await dump("settings menu");
            throw error;
        });
    await page.waitForTimeout(500);
    await page
        .locator('div:has(> span:text-is("Heap Module 0")) button:has(svg.lucide-square-pen)')
        .first()
        .click({ timeout: 10_000 })
        .catch(async (error) => {
            await dump("module list");
            throw error;
        });
    await page.waitForTimeout(500);
    await menu("Additional Assets").click({ timeout: 10_000 });
    await page.locator('input[placeholder="..."]').first().waitFor({ timeout: 30_000 });
    await snapshot("module-assets");

    // 5a. Rename the first asset by typing (each keystroke replaces the whole list: timed per key),
    // delete the second, and wait for the save.
    const originalAssets = moduleList[0].assets;
    const nameInput = page.locator('input[placeholder="..."]').first();
    await nameInput.click();
    await page.keyboard.press("End");
    const keyTimes = [];
    for (const key of "renm") {
        const at = Date.now();
        await page.keyboard.type(key);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
        keyTimes.push(Date.now() - at);
    }
    console.log(`asset rename: ${keyTimes.join(", ")} ms per keystroke`);
    const beforeDelete = batches();
    await page
        .locator('input[placeholder="..."]')
        .nth(1)
        .locator("xpath=ancestor::tr[1]")
        .locator("button")
        .first()
        .click();
    await busy("asset delete");
    for (let i = 0; i < 100 && batches() === beforeDelete; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(2500);
    const edited = (await single("modules"))?.data?.find((module) => module.id === moduleList[0].id);
    check(
        "module asset rename and delete: saved",
        edited?.assets?.length === originalAssets.length - 1 &&
            edited.assets[0][0] === `${originalAssets[0][0]}renm` &&
            edited.assets[0][1] === originalAssets[0][1] &&
            edited.assets[1][1] === originalAssets[2][1],
        { length: edited?.assets?.length, first: edited?.assets?.[0]?.[0] },
    );
    await snapshot("module-asset-edit");

    // 5. Type into the module's description and wait for its save.
    await menu("Basic Info").click();
    const description = page
        .locator('xpath=//span[normalize-space(.)="Description"]/following-sibling::*[1]/descendant-or-self::input')
        .first();
    await description.waitFor({ timeout: 10_000 });
    const before = batches();
    await description.click();
    await page.keyboard.type("heap", { delay: 30 });
    for (let i = 0; i < 100 && batches() === before; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(2500);
    const stored = (await single("modules"))?.data?.find((module) => module.id === moduleList[0].id);
    check("module edit: saved", stored?.description === "heap", { description: stored?.description });
    await snapshot("module-edit");

    // The settings close button (top right, `Settings.svelte`).
    await page.locator("button.absolute.top-2.right-2:has(svg.lucide-circle-x)").last().click({ timeout: 10_000 });
    await busy("settings close");

    // 6. Home, through the sidebar's Home button (inside its menu by default), without a reload.
    const homeButton = page.locator(".rs-sidebar button:has(svg.lucide-house)").first();
    if ((await homeButton.count()) === 0) {
        await page.locator(".rs-sidebar button:has(svg.lucide-list)").first().click();
    }
    await homeButton.click({ timeout: 10_000 });
    await snapshot("home");

    check("no page errors", pageErrors.length === 0, pageErrors.length ? pageErrors : undefined);
    const egress = unexpectedEgress(blocked);
    check("no unexpected egress", egress.length === 0, egress.length ? egress : undefined);

    const mb = (bytes) => (bytes / 1048576).toFixed(1);
    console.log(
        "\nstep              self MB  file MB  proxies  tuple  large(n/MB)   dup strings(n/MB)  FontFace  sheets",
    );
    for (const row of rows) {
        console.log(
            `${row.step.padEnd(16)} ${mb(row.totalBytes).padStart(8)} ${mb(row.fileBytes).padStart(8)} ${String(row.proxies).padStart(8)} ${String(row.tupleProxies).padStart(6)}  ${`${row.largeProxies.count}/${mb(row.largeProxies.retainedBytes)}`.padStart(11)}  ${`${row.duplicateStrings.groups}/${mb(row.duplicateStrings.extraBytes)}`.padStart(17)}  ${String(row.fontFaces).padStart(8)}  ${String(row.styleSheets).padStart(6)}`,
        );
    }
    if (keepSnapshots) console.log(`\nsnapshots kept in ${snapshotDir}`);
} finally {
    await browser?.close().catch((error) => console.error(`closing the browser: ${error}`));
    if (server.exitCode === null) {
        const exited = new Promise((resolve) => server.once("exit", () => resolve(true)));
        server.kill();
        if (!(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(false), 10_000))]))) {
            server.kill("SIGKILL");
            await exited;
        }
    }
    await rm(workDir, { recursive: true, force: true, maxRetries: 5 }).catch((error) => console.error(`${error}`));
    if (!keepSnapshots) {
        await rm(snapshotDir, { recursive: true, force: true }).catch((error) => console.error(`${error}`));
    }
}

const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
