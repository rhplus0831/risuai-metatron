// Measurement for the heap memory plan (`docs/plan/heap-memory.md`, slice D2b): the Blob memory the
// page keeps for file sources, with and without the service worker. A file shown through
// `getFileSrc` (avatars, inlay images, chat assets) is pinned for the page: with the worker its URL
// is `/sw/img/…` and no Blob is kept; without it the source is an object URL of the file's bytes,
// never revoked. Inlay audio and video use typed object URLs per asset key (`inlays.ts`
// `mediaObjectUrls`), never revoked either way.
//
// Against the production build (`pnpm build` first: the server serves `dist/`), in headless Chrome,
// through the real UI. Seeds `AVATARS` characters with a PNG avatar each (random pixels, so the
// bytes are what is stored), and one more, "Gallery", whose chat has `INLAY_REPLIES` replies of
// `INLAYS_PER_REPLY` inlay images each, one reply with `AUDIO_INLAYS` audio inlays, and one showing
// `CHAT_ASSETS` of the character's additional assets (`{{img::…}}`, through the parser's
// `fileSrcCache`). Then, once per mode (`sw`: the worker allowed, as the built app registers it;
// `no-sw`: registration blocked, as when it is blocked or fails), in a fresh browser, the steps:
// 1. `boot`: the home screen with the sidebar's avatars;
// 2. `gallery`: the Gallery chat opened, every image in it decoded (each scrolled into view: the
//    parser makes chat images lazy);
// 3. `home`: back on the home screen;
// 4. `gallery-again`: the Gallery chat opened again.
// Each step, after a forced GC: the page's live object URLs (an init script wraps
// `URL.createObjectURL`/`revokeObjectURL`: count and bytes, and how many were ever created), the
// browser's Blob registry (`chrome://blob-internals`: its Blob entries and their items' logical
// bytes, every Blob of the browser, URL or not), the JS heap in use, and the distinct asset files
// the page read (`/api/read`, every read answered first). The numbers are measurements. The checks are that the seed was stored, the gallery's images decoded
// from the mode's kind of source (`/sw/img/` or `blob:`), its audio inlays got object URLs, the
// second opening created no new object URL (one source per path), and no page error or unexpected
// egress.
//
// Env: `RISU_DIST` (another build), `FILESRC_MODES` (comma-separated, default `sw,no-sw`), `DEBUG`
// (server output). The port is 6265 (the heap driver's is 6264).
//
// Usage: pnpm build && node util/playwright/measureFileSources.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, repoRoot, unexpectedEgress } from "./stack.mjs";

const AVATARS = 20;
const AVATAR_SIDE = 400;
const INLAY_REPLIES = 3;
const INLAYS_PER_REPLY = 8;
const INLAY_SIDE = 600;
const AUDIO_INLAYS = 2;
const AUDIO_BYTES = 1048576;
const CHAT_ASSETS = 4;
const port = 6265;
const base = `http://localhost:${port}`;
const MODES = (process.env.FILESRC_MODES ?? "sw,no-sw")
    .split(",")
    .map((mode) => mode.trim())
    .filter(Boolean);
if (MODES.length === 0 || MODES.some((mode) => mode !== "sw" && mode !== "no-sw")) {
    console.error("FILESRC_MODES is a comma-separated list of sw and no-sw.");
    process.exit(1);
}

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

// A PNG of random RGB pixels: incompressible, so its file is about `3 * side²` bytes.
const png = (side) => {
    const chunk = (type, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(type, 4, "ascii");
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
        return Buffer.concat([head, data, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(side, 0);
    header.writeUInt32BE(side, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    const rows = Buffer.alloc((3 * side + 1) * side);
    for (let y = 0; y < side; y++) randomBytes(3 * side).copy(rows, y * (3 * side + 1) + 1);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MiB = 1048576;
const mb = (bytes) => (bytes / MiB).toFixed(1);

const workDir = await mkdtemp(path.join(os.tmpdir(), "risu-filesrc-"));
await symlink(path.join(repoRoot, "public"), path.join(workDir, "public"), "dir");
await symlink(dist, path.join(workDir, "dist"), "dir");
await copyFile(path.join(repoRoot, "version.json"), path.join(workDir, "version.json"));
// The store stays in `workDir` whatever the shell exports (as `startStack` in `stack.mjs` does).
const { RISU_HOST, RISU_SAVE_DIR, RISU_AGENT_DEV_AUTH_BYPASS, ...inheritedEnv } = process.env;
// Not `<workDir>/save`: the server logs a store path other than `<cwd>/save` (see `listening`).
const savePath = path.join(workDir, "filesrc-save");
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

// Wraps the page's object URL calls before any app script runs: live URLs with their Blob sizes, and
// the count ever created.
const trackObjectUrls = () => {
    const live = new Map();
    let created = 0;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
        const url = create(object);
        created++;
        live.set(url, { size: object instanceof Blob ? object.size : 0, type: object?.type ?? "" });
        return url;
    };
    URL.revokeObjectURL = (url) => {
        live.delete(url);
        return revoke(url);
    };
    Object.defineProperty(window, "__objectUrls", {
        value: () => {
            const byType = {};
            let bytes = 0;
            for (const { size, type } of live.values()) {
                const key = type || "(none)";
                byType[key] = (byType[key] ?? 0) + 1;
                bytes += size;
            }
            return { live: live.size, bytes, created, byType };
        },
    });
};

let browser = null;
try {
    await waitForServer();

    // One mode in a fresh browser (a fresh profile: no worker, no Cache Storage from the last one).
    let auth = null;
    let epoch = null;
    const api = async (p, init = {}) => {
        const r = await fetch(base + p, {
            ...init,
            headers: {
                "risu-auth": auth,
                "x-resource-epoch": epoch,
                "content-type": "application/json",
                ...init.headers,
            },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;

    const avatarIds = Array.from({ length: AVATARS }, () => randomUUID());
    const galleryId = randomUUID();
    let seededBytes = { avatars: 0, inlayImages: 0, audio: 0, chatAssets: 0 };
    let seeded = false;
    const seed = async () => {
        const writes = [];
        const writeAsset = async (key, bytes) => {
            const response = await api("/api/write", {
                method: "POST",
                body: bytes,
                headers: {
                    "content-type": "application/octet-stream",
                    "file-path": Buffer.from(key, "utf-8").toString("hex"),
                },
            });
            writes.push(response.status);
        };
        const ui = await single("ui");
        epoch = ui.epoch ?? epoch;
        const character = (chaId, name, image, extra = {}) => ({
            chaId,
            name,
            type: "character",
            desc: `The description of ${name}.`,
            firstMessage: "Hello.",
            globalLore: [],
            customscript: [],
            emotionImages: [],
            bias: [],
            viewScreen: "none",
            chatFolders: [],
            firstMsgIndex: -1,
            image,
            ...extra,
        });
        // The gallery's additional assets, shown by name in a reply.
        const additionalAssets = [];
        for (let k = 0; k < CHAT_ASSETS; k++) {
            const bytes = png(INLAY_SIDE);
            const key = `assets/${sha(bytes)}.png`;
            await writeAsset(key, bytes);
            seededBytes.chatAssets += bytes.length;
            additionalAssets.push([`scene${k}`, key, "png"]);
        }
        const characters = [];
        for (const [i, id] of [...avatarIds, galleryId].entries()) {
            const bytes = png(AVATAR_SIDE);
            const key = `assets/${sha(bytes)}.png`;
            await writeAsset(key, bytes);
            seededBytes.avatars += bytes.length;
            characters.push(
                id === galleryId
                    ? character(id, "Gallery", key, { additionalAssets })
                    : character(id, `Avatar ${i}`, key),
            );
        }
        const inlayOps = [];
        const inlay = async (bytes, ext, type, extra = {}) => {
            const id = randomUUID();
            const key = `assets/inlay_${sha(bytes)}.${ext}`;
            await writeAsset(key, bytes);
            inlayOps.push({
                kind: "inlays",
                id,
                baseRevision: null,
                data: { name: `${id}.${ext}`, ext, type, asset: key, size: bytes.length, ...extra },
            });
            return id;
        };
        const replies = [];
        for (let r = 0; r < INLAY_REPLIES; r++) {
            const ids = [];
            for (let k = 0; k < INLAYS_PER_REPLY; k++) {
                const bytes = png(INLAY_SIDE);
                seededBytes.inlayImages += bytes.length;
                ids.push(await inlay(bytes, "png", "image", { width: INLAY_SIDE, height: INLAY_SIDE }));
            }
            replies.push(ids.map((id) => `{{inlay::${id}}}`).join("\n"));
        }
        const audio = [];
        for (let k = 0; k < AUDIO_INLAYS; k++) {
            const bytes = randomBytes(AUDIO_BYTES);
            seededBytes.audio += bytes.length;
            audio.push(await inlay(bytes, "mp3", "audio"));
        }
        replies.push(audio.map((id) => `{{inlay::${id}}}`).join("\n"));
        replies.push(additionalAssets.map(([name]) => `{{img::${name}}}`).join("\n"));
        const message = replies.flatMap((data, k) => [
            { role: "user", data: `Show me set ${k}.`, chatId: randomUUID() },
            { role: "char", data, chatId: randomUUID() },
        ]);
        const stored = await api("/api/resources/batch", {
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
                    ...inlayOps,
                ],
                chats: [
                    {
                        characterId: galleryId,
                        chatId: `${galleryId}-chat`,
                        baseRevision: null,
                        ops: [
                            {
                                op: "create",
                                chat: { id: `${galleryId}-chat`, name: "Chat 1", note: "", localLore: [], message },
                            },
                        ],
                    },
                ],
                chatOrders: [],
            }),
        });
        check(
            "seed: stored",
            stored.status === 200 && writes.every((status) => status === 200),
            stored.status === 200 ? { writes: writes.length } : stored,
        );
        console.log(
            `seeded: avatars ${mb(seededBytes.avatars)} MB (${AVATARS + 1}), inlay images ${mb(seededBytes.inlayImages)} MB (${INLAY_REPLIES * INLAYS_PER_REPLY}), audio ${mb(seededBytes.audio)} MB (${AUDIO_INLAYS}), chat assets ${mb(seededBytes.chatAssets)} MB (${CHAT_ASSETS})`,
        );
    };

    const rows = [];
    for (const mode of MODES) {
        browser = await chromium.launch({ executablePath: chromePath, headless: true });
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            serviceWorkers: mode === "sw" ? "allow" : "block",
        });
        const blocked = await isolateContext(context);
        await context.addInitScript(trackObjectUrls);
        const pageErrors = [];
        const assetReads = new Set();
        let readsInFlight = 0;
        const isRead = (r) => new URL(r.url()).pathname === "/api/read" && !!r.headers()["file-path"];
        const page = await context.newPage();
        page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
        page.on("request", (r) => {
            const h = r.headers();
            if (h["risu-auth"]) auth = h["risu-auth"];
            if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
            if (isRead(r)) {
                readsInFlight++;
                assetReads.add(Buffer.from(h["file-path"], "hex").toString("utf-8"));
            }
        });
        const readDone = (r) => {
            if (isRead(r)) readsInFlight--;
        };
        page.on("requestfinished", readDone);
        page.on("requestfailed", readDone);
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
        if (!seeded) {
            await page.waitForTimeout(1500);
            await seed();
            seeded = true;
        }

        const cdp = await context.newCDPSession(page);
        await cdp.send("HeapProfiler.enable");
        const internals = await context.newPage();
        // Every Blob of the browser: `chrome://blob-internals` lists each under its UUID, with a
        // `Length:` per item (logical bytes: items may share backing data).
        const blobRegistry = async () => {
            await internals.goto("chrome://blob-internals");
            const text = await internals.locator("body").innerText();
            const lengths = [...text.matchAll(/^Length: ([\d,]+)$/gm)].map((m) => Number(m[1].replaceAll(",", "")));
            return {
                count: [...text.matchAll(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/gm)].length,
                bytes: lengths.reduce((a, b) => a + b, 0),
            };
        };
        // Settled when every asset read was answered and no new file was read for 2 s.
        const settle = async () => {
            const deadline = Date.now() + 240_000;
            let seen = -1;
            while (seen !== assetReads.size || readsInFlight > 0) {
                if (Date.now() > deadline) throw new Error(`asset reads did not settle (${readsInFlight} in flight)`);
                seen = readsInFlight > 0 ? -1 : assetReads.size;
                await page.waitForTimeout(2000);
            }
        };
        const measure = async (step) => {
            await settle();
            await cdp.send("HeapProfiler.collectGarbage");
            await page.waitForTimeout(500);
            const urls = await page.evaluate(() => window.__objectUrls());
            const registry = await blobRegistry();
            const { usedSize } = await cdp.send("Runtime.getHeapUsage");
            const row = { mode, step, urls, registry, heap: usedSize, reads: assetReads.size };
            rows.push(row);
            console.log(
                `${mode} ${step}: object URLs ${urls.live} live (${mb(urls.bytes)} MB), ${urls.created} created; blobs ${registry.count} (${mb(registry.bytes)} MB); ${assetReads.size} files read`,
            );
            return row;
        };

        // 1. Boot: the home screen and the sidebar's avatars.
        await open();
        await page.locator(`[data-char-id="${galleryId}"]`).first().waitFor({ timeout: 120_000 });
        const usingSw = await page.evaluate(() => !!navigator.serviceWorker?.controller);
        check(
            `${mode}: the service worker ${mode === "sw" ? "controls" : "does not control"} the page`,
            usingSw === (mode === "sw"),
        );
        await measure("boot");

        // 2. The gallery chat, every inlay image decoded and the audio inlays' sources set.
        const images = INLAY_REPLIES * INLAYS_PER_REPLY + CHAT_ASSETS;
        const openGallery = async () => {
            await page.locator(`[data-char-id="${galleryId}"]`).first().click();
            await page.getByRole("button", { name: /Open most recent chat/ }).click({ timeout: 10_000 });
            await page.locator(".default-chat-screen .chattext").first().waitFor({ timeout: 30_000 });
            const shown = () => {
                const imgs = [...document.querySelectorAll(".default-chat-screen .chattext img")];
                const sources = [...document.querySelectorAll(".default-chat-screen .chattext audio source")];
                return {
                    images: imgs.length,
                    rows: document.querySelectorAll(".default-chat-screen .chattext").length,
                    pending: imgs
                        .filter((img) => !(img.complete && img.naturalWidth > 0))
                        .slice(0, 3)
                        .map((img) => ({
                            src: img.src.slice(0, 60),
                            complete: img.complete,
                            loading: img.loading,
                            far: !!img.closest(".far"),
                        })),
                    decoded: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
                    kinds: [
                        ...new Set(
                            imgs.map((img) =>
                                img.src.startsWith("blob:") ? "blob:" : new URL(img.src).pathname.slice(0, 8),
                            ),
                        ),
                    ],
                    audio: sources.filter((source) => source.src.startsWith("blob:")).length,
                };
            };
            // The parser makes chat images lazy: each one not decoded yet is scrolled into view in turn.
            const deadline = Date.now() + 90_000;
            for (;;) {
                const done = await page.evaluate(
                    ([images, audio]) => {
                        const imgs = [...document.querySelectorAll(".default-chat-screen .chattext img")];
                        const pending = imgs.filter((img) => !(img.complete && img.naturalWidth > 0));
                        pending[0]?.scrollIntoView({ block: "center" });
                        return (
                            imgs.length === images &&
                            pending.length === 0 &&
                            document.querySelectorAll(".default-chat-screen .chattext audio source").length === audio
                        );
                    },
                    [images, AUDIO_INLAYS],
                );
                if (done) break;
                if (Date.now() > deadline) {
                    console.error("gallery:", await page.evaluate(shown));
                    throw new Error("the gallery's images did not all decode");
                }
                await page.waitForTimeout(300);
            }
            return page.evaluate(shown);
        };
        const gallery = await openGallery();
        check(
            `${mode}: the gallery's images decoded from ${mode === "sw" ? "/sw/img/" : "blob:"} sources`,
            gallery.decoded === images &&
                gallery.kinds.length === 1 &&
                gallery.kinds[0] === (mode === "sw" ? "/sw/img/" : "blob:"),
            gallery,
        );
        check(`${mode}: the gallery's audio inlays have object URLs`, gallery.audio === AUDIO_INLAYS, gallery);
        await measure("gallery");

        // 3. Home, through the sidebar's Home button (inside its menu by default), without a reload.
        const homeButton = page.locator(".rs-sidebar button:has(svg.lucide-house)").first();
        if ((await homeButton.count()) === 0) {
            await page.locator(".rs-sidebar button:has(svg.lucide-list)").first().click();
        }
        await homeButton.click({ timeout: 10_000 });
        await page.locator(".default-chat-screen").waitFor({ state: "detached", timeout: 30_000 });
        const home = await measure("home");

        // 4. The gallery again: its sources are shared per path, so nothing new is created.
        const again = await openGallery();
        check(`${mode}: the gallery shown again`, again.decoded === images && again.audio === AUDIO_INLAYS, again);
        const galleryAgain = await measure("gallery-again");
        check(
            `${mode}: no new object URL for the gallery shown again`,
            galleryAgain.urls.created === home.urls.created,
            {
                home: home.urls.created,
                again: galleryAgain.urls.created,
            },
        );

        check(`${mode}: no page errors`, pageErrors.length === 0, pageErrors.length ? pageErrors : undefined);
        const egress = unexpectedEgress(blocked);
        check(`${mode}: no unexpected egress`, egress.length === 0, egress.length ? egress : undefined);
        await browser.close();
        browser = null;
    }

    console.log("\nmode   step           URLs live  URL MB  created  blobs  blob MB  heap MB  files read  by type");
    for (const row of rows) {
        console.log(
            `${row.mode.padEnd(6)} ${row.step.padEnd(14)} ${String(row.urls.live).padStart(9)} ${mb(row.urls.bytes).padStart(7)} ${String(row.urls.created).padStart(8)} ${String(row.registry.count).padStart(6)} ${mb(row.registry.bytes).padStart(8)} ${mb(row.heap).padStart(8)} ${String(row.reads).padStart(11)}  ${JSON.stringify(row.urls.byType)}`,
        );
    }
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
}

const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
