// Measurement for the heap memory plan (`docs/plan/heap-memory.md`, slice M0): the page's JS heap
// with large modules and characters, in the shape of the user's 2026-10-19 snapshots but with
// generated content.
//
// Against the production build (`pnpm build` first: the server serves `dist/`), in headless Chrome,
// through the real UI. Seeds 12 enabled modules of 11,000 `[name, path, "avif"]` assets each, two
// ~2 MB characters (a 300-entry lorebook) with 300 additional assets, 60 emotion images and 24
// `ccAssets` icons each, and five small characters whose chats' replies (three per chat) each carry
// the same `<style>` of 120 `@font-face` rules and an `@import`ed font service stylesheet of 120 more
// (a remote URL a context route answers). Then takes a CDP
// heap snapshot (after a forced GC) at each step, without reloading the page after boot:
// 1. `boot`: the app loaded;
// 2. `character-assets`: a big character's emotion and additional asset lists (its settings' second
//    tab);
// 3. `character-asset-edit`: after renaming that character's first additional asset by typing
//    (timed per keystroke), deleting its second, and the save;
// 4. `chats`: after opening the five small characters' chats, one after another (their three styled
//    replies share one stylesheet, slice C2; `HEAP_STYLE_COPIES=3` for a build before it);
// 5. `module-assets`: the module editor's asset list of the first module (one page of rows);
// 6. `module-asset-edit`: after renaming its first asset by typing (timed per keystroke), deleting
//    its second, and the save;
// 7. `module-edit`: after typing into that module's description and its save;
// 8. `home`: back on the home screen (the sidebar's Home button);
// 9. `character-recreate`: after three times a new ~2 MB character from the server, its settings'
//    asset lists opened, and its deletion by the server (compare with `home`);
// 10. `boot-character-delete`: after the server deleted the second big character, loaded at boot (its
//    settings opened first; compare with `character-recreate`);
// 11. `boot-module-delete`: after the server deleted the last module, loaded at boot.
// Each snapshot is analysed by `util/heap/analyze.mjs report` in its own process and printed as one
// table row: JS self size, `JSProxy` count, proxies of asset tuples, proxies retaining 256 KB or
// more (count, and the outermost ones' retained size), likely duplicated large strings (same size and first 1,024 characters:
// a snapshot keeps no more of a string), `FontFace`/`CSSStyleSheet`. The numbers are measurements: compare
// them with a baseline build (`RISU_DIST=<dist of an earlier commit>`). The checks are that the seed
// was stored, the asset and description edits reached the server, the chat styles' faces are counted
// on the chat screen and back to the boot count after it, the deleted characters leave nothing
// (`character-recreate` within 2 MiB of `home`), the booted big character deleted frees at least 2 MiB, and no
// page error or unexpected egress.
//
// Env: `RISU_DIST` (another build), `HEAP_OUT` (keep the snapshots in this directory; by default they
// go to a temporary directory and are deleted), `HEAP_ANALYZE_MB` (the analysis heap, default 16000),
// `HEAP_STEPS` (comma-separated step names: only these, and `boot`, are captured and analysed; every
// step's UI actions still run, since each starts from the state the one before left, and a check that
// compares a step not captured prints SKIP), `HEAP_STYLE_COPIES` (the copies of a chat's style the
// build keeps: 1, the default, since slice C2; 3, one per styled reply, before it), `DEBUG` (server
// output).
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
const CC_ASSETS = 24;
const FONT_FACES = 120;
const STYLED_REPLIES = 3;
// A row's faces: its style's inline and imported ones.
const ROW_FONT_FACES = 2 * FONT_FACES;
// The copies of a chat's style on its screen: one shared stylesheet since slice C2 (`chatStyles.ts`),
// one per styled reply before it.
const STYLE_COPIES = Number(process.env.HEAP_STYLE_COPIES ?? 1);
if (STYLE_COPIES !== 1 && STYLE_COPIES !== STYLED_REPLIES) {
    console.error(`HEAP_STYLE_COPIES is 1 or ${STYLED_REPLIES}.`);
    process.exit(1);
}
const CHAT_FONT_FACES = STYLE_COPIES * ROW_FONT_FACES;
const RECREATED_CHARACTERS = 3;
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

const STEPS = [
    "boot",
    "character-assets",
    "character-asset-edit",
    "chats",
    "module-assets",
    "module-asset-edit",
    "module-edit",
    "home",
    "character-recreate",
    "boot-character-delete",
    "boot-module-delete",
];
// Checked before anything starts, so a typo does not cost a run that measures nothing.
const capturedSteps = process.env.HEAP_STEPS
    ? new Set([
          "boot",
          ...process.env.HEAP_STEPS.split(",")
              .map((step) => step.trim())
              .filter(Boolean),
      ])
    : new Set(STEPS);
const unknownSteps = [...capturedSteps].filter((step) => !STEPS.includes(step));
if (unknownSteps.length > 0) {
    console.error(`Unknown HEAP_STEPS: ${unknownSteps.join(", ")} (steps: ${STEPS.join(", ")}).`);
    process.exit(1);
}

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
// The font service the chat styles `@import`: a remote stylesheet URL, answered by a context route
// (no egress), as the user's chats import one.
const FONT_HOST = "fonts.heap-check.invalid";
const importedCss = (url) => fontFaces(`${new URL(url).searchParams.get("family")}Imported`);
// A chat style with inline faces and an `@import`ed stylesheet of more. Every reply of a chat carries
// the same style, as a character's reply format repeats it.
const fontStyle = (family) =>
    `<style>@import url("https://${FONT_HOST}/css?family=${family}");` +
    `${fontFaces(family)}.heap-font{font-family:"${family}","${family}Imported";}</style>` +
    `<p class="heap-font">가나다라마바사</p>`;

try {
    await waitForServer();
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const blocked = await isolateContext(context);
    // Registered after `isolateContext`, so it runs first for the font service's URLs. Only the
    // stylesheet is served (and counted); its faces' font files are not.
    let importsServed = 0;
    await context.route(`https://${FONT_HOST}/**`, (route) => {
        const url = route.request().url();
        if (new URL(url).pathname !== "/css") return route.fulfill({ status: 404 });
        importsServed++;
        return route.fulfill({ contentType: "text/css", body: importedCss(url) });
    });
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
    const bigCharacter = (id, name, i) =>
        character(id, name, {
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
            ccAssets: assetList(CC_ASSETS, `Icon${i}`, 300 + i).map(([name, uri, ext]) => ({
                type: "icon",
                uri,
                name,
                ext,
            })),
        });
    const characters = [
        ...bigIds.map((id, i) => bigCharacter(id, `Big ${i}`, i)),
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
                        data: k % 2 === 1 ? fontStyle(`HeapFont${i}`) : `Message ${k} of chat ${i}.`,
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
        if (!STEPS.includes(step)) throw new Error(`snapshot of an unlisted step: ${step}`);
        // The wait stays for a step not captured, so the steps after it keep their timing.
        await page.waitForTimeout(1500);
        if (!capturedSteps.has(step)) return;
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

    // 3. The big character's additional assets: rename the first by typing (each keystroke replaces
    // the whole list: timed per key), delete the second, and wait for the save.
    const menu = (label) => page.locator(`button:has(> span:text-is("${label}"))`).first();
    await menu("Additional Assets")
        .click({ timeout: 10_000 })
        .catch(async (error) => {
            await dump("character asset tab");
            throw error;
        });
    await page.locator('input[placeholder="..."]').first().waitFor({ timeout: 30_000 });
    const originalCharacterAssets = characters[0].additionalAssets;
    await page.locator('input[placeholder="..."]').first().click();
    await page.keyboard.press("End");
    const characterKeyTimes = [];
    for (const key of "renm") {
        const at = Date.now();
        await page.keyboard.type(key);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
        characterKeyTimes.push(Date.now() - at);
    }
    console.log(`character asset rename: ${characterKeyTimes.join(", ")} ms per keystroke`);
    const beforeCharacterDelete = batches();
    await page
        .locator('input[placeholder="..."]')
        .nth(1)
        .locator("xpath=ancestor::tr[1]")
        .locator("button")
        .first()
        .click();
    await busy("character asset delete");
    for (let i = 0; i < 100 && batches() === beforeCharacterDelete; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(2500);
    const editedCharacter = (await api(`/api/resources/characters/${bigIds[0]}`)).body?.data;
    check(
        "character asset rename and delete: saved",
        editedCharacter?.additionalAssets?.length === originalCharacterAssets.length - 1 &&
            editedCharacter.additionalAssets[0][0] === `${originalCharacterAssets[0][0]}renm` &&
            editedCharacter.additionalAssets[0][1] === originalCharacterAssets[0][1] &&
            editedCharacter.additionalAssets[1][1] === originalCharacterAssets[2][1],
        {
            length: editedCharacter?.additionalAssets?.length,
            first: editedCharacter?.additionalAssets?.[0]?.[0],
        },
    );
    await snapshot("character-asset-edit");

    // 4. Open the small characters' chats, one after another. Back on the "Chat" tab first: the
    // character settings of a character switched to on its closed-chat screen alert a tokenizer
    // `TypeError` (`CharConfig.svelte` `loadTokenize` gets an undefined note without a chat).
    await page.getByRole("button", { name: "Chat", exact: true }).first().click({ timeout: 60_000 });
    // Opens a character's chat and waits for its styled replies and their faces.
    const openChat = async (id, family) => {
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
        // The rows render after their wrapper: wait for the styled replies' paragraphs (the parser
        // prefixes their class names), and for every stylesheet of this chat's family (found by its
        // text, in the rows or shared) with all its faces. Earlier chats' families are left out.
        const chatFonts = (family) => {
            const sheets = [...document.querySelectorAll("style")].filter((style) =>
                style.textContent.includes(`"${family}"`),
            );
            return {
                paragraphs: document.querySelectorAll(".default-chat-screen .chattext .x-risu-heap-font").length,
                sheets: sheets.length,
                inRows: sheets.filter((style) => style.closest(".chattext")).length,
                faces: [...document.fonts].filter((face) => face.family.includes(family)).length,
            };
        };
        await page
            .waitForFunction(
                ([family, replies, rowFaces]) => {
                    const sheets = [...document.querySelectorAll("style")].filter((style) =>
                        style.textContent.includes(`"${family}"`),
                    ).length;
                    const faces = [...document.fonts].filter((face) => face.family.includes(family)).length;
                    return (
                        document.querySelectorAll(".default-chat-screen .chattext .x-risu-heap-font").length ===
                            replies &&
                        sheets > 0 &&
                        faces === sheets * rowFaces
                    );
                },
                [family, STYLED_REPLIES, ROW_FONT_FACES],
                { timeout: 30_000 },
            )
            .catch(async (error) => {
                console.error("chat fonts:", await page.evaluate(chatFonts, family));
                throw error;
            });
        await page.waitForTimeout(1000);
        return page.evaluate(chatFonts, family);
    };
    // `chatOf` numbers the families over all characters, the big ones first.
    const chatSheets = [];
    for (const [i, id] of smallIds.entries()) {
        chatSheets.push(await openChat(id, `HeapFont${BIG_CHARACTERS + i}`));
    }
    // Slice C2: every chat's three styled replies keep the build's copies of the style (one, shared
    // outside the rows, since C2), with exactly their faces.
    check(
        `fonts: ${STYLE_COPIES} copy of each chat's style`,
        chatSheets.every(
            (sheets) =>
                sheets.sheets === STYLE_COPIES &&
                sheets.inRows === (STYLE_COPIES === 1 ? 0 : STYLE_COPIES) &&
                sheets.faces === STYLE_COPIES * ROW_FONT_FACES,
        ),
        chatSheets,
    );
    await snapshot("chats");

    // 5. The first module's asset list.
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

    // 6. Rename the first asset by typing (each keystroke replaces the whole list: timed per key),
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

    // 7. Type into the module's description and wait for its save.
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

    // 8. Home, through the sidebar's Home button (inside its menu by default), without a reload.
    const homeButton = page.locator(".rs-sidebar button:has(svg.lucide-house)").first();
    if ((await homeButton.count()) === 0) {
        await page.locator(".rs-sidebar button:has(svg.lucide-list)").first().click();
    }
    await homeButton.click({ timeout: 10_000 });
    await snapshot("home");

    // 9. Three times: a new ~2 MB character arrives from the server, its settings and asset lists
    // are opened, and the server deletes it (the raw path; the selected character's removal selects
    // home). Compared with `home`, whatever the page still holds of the deleted characters.
    // One batch built from fresh revisions, again after a revision conflict (the app saves the
    // character order too); any other answer stops the run.
    const batchRetrying = async (what, build) => {
        for (let attempt = 0; attempt < 5; attempt++) {
            const response = await api("/api/resources/batch", {
                method: "POST",
                body: JSON.stringify(await build()),
            });
            if (response.status === 200) {
                check(what, true);
                return;
            }
            if (response.status !== 409)
                throw new Error(`${what}: ${response.status} ${JSON.stringify(response.body)}`);
            await page.waitForTimeout(500);
        }
        throw new Error(`${what}: the revisions kept conflicting`);
    };
    // A character's deletion through the routes, with its place in the order; then its sidebar entry
    // and its closed-chat screen leave the page (the selected character's removal selects home, so
    // the screen's "Character" tab goes: the client applied the deletion, not only the order).
    const deleteCharacter = async (what, id) => {
        // Back on the "Chat" tab first, as in step 4: the next character selected would otherwise open
        // on the character settings, which alert the tokenizer `TypeError` for a character with a chat.
        await page.getByRole("button", { name: "Chat", exact: true }).first().click({ timeout: 60_000 });
        await page.waitForTimeout(500);
        await batchRetrying(what, async () => {
            const revision = (await api(`/api/resources/characters/${id}`)).body?.revision;
            const order = await single("characterOrder");
            return {
                ops: [
                    { kind: "characters", id, baseRevision: revision, delete: true },
                    {
                        kind: "characterOrder",
                        id: "main",
                        baseRevision: order.revision,
                        data: order.data.filter((entry) => entry !== id),
                    },
                ],
            };
        });
        await page.locator(`[data-char-id="${id}"]`).waitFor({ state: "detached", timeout: 60_000 });
        await page
            .getByRole("button", { name: "Character", exact: true })
            .first()
            .waitFor({ state: "detached", timeout: 60_000 });
        await page.waitForTimeout(500);
    };
    for (let k = 0; k < RECREATED_CHARACTERS; k++) {
        const id = randomUUID();
        // The sidebar lists the characters of the character order.
        await batchRetrying(`recreate ${k}: created`, async () => {
            const order = await single("characterOrder");
            return {
                ops: [
                    {
                        kind: "characters",
                        id,
                        baseRevision: null,
                        data: bigCharacter(id, `Recreated ${k}`, BIG_CHARACTERS + k),
                    },
                    { kind: "characterOrder", id: "main", baseRevision: order.revision, data: [...order.data, id] },
                ],
            };
        });
        const entry = page.locator(`[data-char-id="${id}"]`).first();
        await entry.waitFor({ timeout: 60_000 });
        await entry.click();
        await page.getByRole("button", { name: "Character", exact: true }).first().click({ timeout: 120_000 });
        await page.waitForTimeout(500);
        await page.locator("button:has(svg.lucide-smile)").first().click({ timeout: 120_000 });
        await page.waitForTimeout(1500);
        await deleteCharacter(`recreate ${k}: deleted`, id);
    }
    if (await homeButton.isVisible().catch(() => false)) await homeButton.click({ timeout: 10_000 });
    await snapshot("character-recreate");

    // 10. Data the page booted with, deleted through the routes: the second big character (its
    // settings opened first) and the last module (with its enabled entry).
    await page.locator(`[data-char-id="${bigIds[1]}"]`).first().click();
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "Character", exact: true }).first().click({ timeout: 120_000 });
    await page.waitForTimeout(500);
    await page.locator("button:has(svg.lucide-smile)").first().click({ timeout: 120_000 });
    await page.waitForTimeout(1500);
    await deleteCharacter("boot delete: big character", bigIds[1]);
    if (await homeButton.isVisible().catch(() => false)) await homeButton.click({ timeout: 10_000 });
    await snapshot("boot-character-delete");
    const lastModule = moduleList[MODULES - 1].id;
    await batchRetrying("boot delete: last module", async () => {
        const stored = await single("modules");
        const enabledNow = await single("enabledModules");
        return {
            ops: [
                {
                    kind: "modules",
                    id: "main",
                    baseRevision: stored.revision,
                    data: stored.data.filter((module) => module.id !== lastModule),
                },
                {
                    kind: "enabledModules",
                    id: "main",
                    baseRevision: enabledNow.revision,
                    data: enabledNow.data.filter((id) => id !== lastModule),
                },
            ],
        };
    });
    await page.waitForTimeout(2000);
    if (await homeButton.isVisible().catch(() => false)) await homeButton.click({ timeout: 10_000 });
    await snapshot("boot-module-delete");

    // Slice D1, bounds declared before the fix was measured: nothing of the deleted characters stays
    // (within 2 MiB of `home`), and deleting the booted big character frees at least 2 MiB (it is more
    // than that). The module deletion is a measurement only: the server's copy of the modules is new
    // data, and Svelte keeps the old module assets through the parser's asset inputs (see the plan's D1
    // entry).
    const bytes = Object.fromEntries(rows.map((row) => [row.step, row.totalBytes]));
    const MiB = 1048576;
    // A check comparing snapshots runs only when `HEAP_STEPS` captured all of them.
    const compared = (name, steps, run) => {
        const missing = steps.filter((step) => !capturedSteps.has(step));
        if (missing.length === 0) run();
        else console.log(`SKIP ${name} (not captured: ${missing.join(", ")})`);
    };
    compared("deletes: the recreated characters leave nothing", ["home", "character-recreate"], () =>
        check("deletes: the recreated characters leave nothing", bytes["character-recreate"] <= bytes.home + 2 * MiB, {
            home: bytes.home,
            "character-recreate": bytes["character-recreate"],
        }),
    );
    compared("deletes: the booted character is freed", ["character-recreate", "boot-character-delete"], () =>
        check(
            "deletes: the booted character is freed",
            bytes["boot-character-delete"] <= bytes["character-recreate"] - 2 * MiB,
            {
                "character-recreate": bytes["character-recreate"],
                "boot-character-delete": bytes["boot-character-delete"],
            },
        ),
    );

    // Slice C1: the chat styles' faces (inline and imported) are on the chat screen, and leave with it.
    const faces = Object.fromEntries(rows.map((row) => [row.step, row.fontFaces]));
    check("fonts: the chat styles' import was fetched", importsServed > 0, { importsServed });
    compared("fonts: on the chat screen, the style's copies", ["chats"], () =>
        check("fonts: on the chat screen, the style's copies", faces.chats === faces.boot + CHAT_FONT_FACES, {
            boot: faces.boot,
            chats: faces.chats,
            expected: faces.boot + CHAT_FONT_FACES,
        }),
    );
    compared("fonts: gone after the chat", ["module-assets", "home"], () =>
        check("fonts: gone after the chat", faces["module-assets"] === faces.boot && faces.home === faces.boot, faces),
    );

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
