// Measurement of the Blob memory the page keeps for file sources, with and without the service
// worker. A file shown through `getFileSrc` (avatars, inlay images, chat assets) is pinned for the
// page: with a capable worker its URL is `/api/asset/…` and no Blob is kept; without it the source
// is an object URL of the file's bytes, never revoked. Inlay audio and video also use direct asset
// URLs with the worker, and typed object URLs per asset key otherwise.
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
// from the mode's kind of source (`/api/asset/` or `blob:`), its audio inlays use that same kind, the
// second opening created no new object URL (one source per path), and no page error or unexpected
// egress.
//
// Then `thumb`: add `THUMB_AVATARS` characters with distinct `THUMB_WIDTH` × `THUMB_HEIGHT` PNGs
// (smooth gradients with random corner colors and a small random block, rather than pure noise,
// for more card-like encoded sizes; decoded pixel bytes depend only on dimensions). In fresh
// browsers, open the catalog and scroll every row into view: `sw-original` strips thumbnail
// queries at the DOM boundary as the baseline, then `sw` uses the shipped thumbnails; `no-sw`
// uses originals through object URLs. Counts distinct image URLs throughout the page, including
// CSS backgrounds and the sidebar, at naturalWidth × naturalHeight × 4; reports short sides,
// server-reaching response body bytes and requests by route/variant, redirects, heap and URLs.
// Checks the stored avatars, their decoded dimensions/sources, and the baseline's lack of any
// thumbnail request. This measures cold browser loads, not thumbnail generation time.
//
// Env: `RISU_DIST` (another build), `FILESRC_MODES` (comma-separated, default `sw,no-sw`),
// `FILESRC_STEPS` (comma-separated `files,thumb`, default both; `thumb` alone skips the old seed),
// `DEBUG` (server output). The port is 6265 (the heap driver's is 6264).
//
// Usage: pnpm build && node util/playwright/measureFileSources.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
const THUMB_AVATARS = 100;
const THUMB_WIDTH = 1024;
const THUMB_HEIGHT = 1536;
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
const STEPS = (process.env.FILESRC_STEPS ?? "files,thumb")
    .split(",")
    .map((step) => step.trim())
    .filter(Boolean);
if (STEPS.length === 0 || STEPS.some((step) => step !== "files" && step !== "thumb")) {
    console.error("FILESRC_STEPS is a comma-separated list of files and thumb.");
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

// The file-source fixtures stay incompressible; the thumbnail fixtures use a colored gradient.
const png = (width, height = width, gradient = false) => {
    const chunk = (type, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(type, 4, "ascii");
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
        return Buffer.concat([head, data, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    const stride = 3 * width + 1;
    const rows = Buffer.alloc(stride * height);
    const colors = gradient ? randomBytes(12) : null;
    for (let y = 0; y < height; y++) {
        if (!gradient) {
            randomBytes(3 * width).copy(rows, y * stride + 1);
            continue;
        }
        const v = y / (height - 1);
        for (let x = 0; x < width; x++) {
            const u = x / (width - 1);
            for (let c = 0; c < 3; c++) {
                const top = colors[c] * (1 - u) + colors[c + 3] * u;
                const bottom = colors[c + 6] * (1 - u) + colors[c + 9] * u;
                rows[y * stride + 1 + x * 3 + c] = Math.round(top * (1 - v) + bottom * v);
            }
        }
        if (y < 64) randomBytes(3 * Math.min(64, width)).copy(rows, y * stride + 1);
    }
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
await mkdir(path.join(workDir, "server"));
await symlink(path.join(repoRoot, "server/assets"), path.join(workDir, "server/assets"), "dir");
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

// Svelte 5's set_style uses cssText and setProperty; set_attribute uses setAttribute for src.
// Patch before boot, including direct property assignments, so no thumbnail can start loading.
const forceOriginals = () => {
    const strip = (value) => {
        if (typeof value !== "string") return value;
        return value.replace(/(?:(?:https?:)?\/\/[^\s"'()]+)?\/api\/asset\/[0-9a-f]+\?[^\s"'()]*/gi, (src) => {
            const url = new URL(src, location.href);
            if (
                url.origin !== location.origin ||
                !/^\/api\/asset\/[0-9a-f]+$/i.test(url.pathname) ||
                !["256", "512"].includes(url.searchParams.get("w"))
            )
                return src;
            url.searchParams.delete("w");
            return src.startsWith("/") ? url.pathname + url.search + url.hash : url.href;
        });
    };
    const setter = (prototype, name) => {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        Object.defineProperty(prototype, name, {
            ...descriptor,
            set(value) {
                descriptor.set.call(this, strip(value));
            },
        });
    };
    setter(HTMLImageElement.prototype, "src");
    setter(CSSStyleDeclaration.prototype, "cssText");
    const attribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        return attribute.call(this, name, /^(src|style)$/i.test(name) ? strip(value) : value);
    };
    const property = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
        return property.call(this, name, strip(value), priority);
    };
};

// One entry per resource, including backgrounds on elements outside the catalog.
const trackImages = () => {
    performance.setResourceTimingBufferSize(5000);
    const backgroundUrls = (element) =>
        [...getComputedStyle(element).backgroundImage.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g)].map(
            (match) => new URL(match[1] ?? match[2] ?? match[3], location.href).href,
        );
    window.__imageSources = (root = document) => {
        const sources = new Map();
        for (const element of [root, ...root.querySelectorAll("*")]) {
            if (!(element instanceof Element)) continue;
            if (element instanceof HTMLImageElement && (element.currentSrc || element.getAttribute("src"))) {
                sources.set(element.currentSrc || element.src, element);
            }
            for (const url of backgroundUrls(element)) {
                if (!sources.has(url)) sources.set(url, null);
            }
        }
        return sources;
    };
    window.__imageDetails = (root) => {
        const backgrounds = new Set(
            [root, ...root.querySelectorAll("*")]
                .filter((element) => element instanceof Element)
                .flatMap(backgroundUrls),
        );
        return [...window.__imageSources(root)].map(([url, image]) => ({
            url,
            img: !!image,
            background: backgrounds.has(url),
            complete: image?.complete ?? null,
            naturalWidth: image?.naturalWidth ?? null,
            naturalHeight: image?.naturalHeight ?? null,
            timing: performance.getEntriesByName(url).map((entry) => entry.toJSON()),
        }));
    };
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
    const credentials = (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
    };
    const writeAsset = async (key, bytes) =>
        (
            await api("/api/write", {
                method: "POST",
                body: bytes,
                headers: {
                    "content-type": "application/octet-stream",
                    "file-path": Buffer.from(key, "utf-8").toString("hex"),
                },
            })
        ).status;
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
    const open = async (page) => {
        const settingsButton = page.locator("button:has(svg.lucide-settings)").first();
        const welcome = page.getByText("Welcome to Risuai!");
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

    const avatarIds = Array.from({ length: AVATARS }, () => randomUUID());
    const galleryId = randomUUID();
    let seededBytes = { avatars: 0, inlayImages: 0, audio: 0, chatAssets: 0 };
    let seeded = false;
    const seed = async () => {
        const writes = [];
        const ui = await single("ui");
        epoch = ui.epoch ?? epoch;
        // The gallery's additional assets, shown by name in a reply.
        const additionalAssets = [];
        for (let k = 0; k < CHAT_ASSETS; k++) {
            const bytes = png(INLAY_SIDE);
            const key = `assets/${sha(bytes)}.png`;
            writes.push(await writeAsset(key, bytes));
            seededBytes.chatAssets += bytes.length;
            additionalAssets.push([`scene${k}`, key, "png"]);
        }
        const characters = [];
        for (const [i, id] of [...avatarIds, galleryId].entries()) {
            const bytes = png(AVATAR_SIDE);
            const key = `assets/${sha(bytes)}.png`;
            writes.push(await writeAsset(key, bytes));
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
            writes.push(await writeAsset(key, bytes));
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
    for (const mode of STEPS.includes("files") ? MODES : []) {
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
        page.on("request", credentials);
        page.on("request", (r) => {
            const h = r.headers();
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
        await open(page);
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
        await open(page);
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
                const kind = (src) => {
                    if (src.startsWith("blob:")) return "blob:";
                    const pathname = new URL(src, location.href).pathname;
                    if (pathname.startsWith("/api/asset/")) return "/api/asset/";
                    if (pathname.startsWith("/sw/img/")) return "/sw/img/";
                    return "other";
                };
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
                    kinds: [...new Set(imgs.map((img) => kind(img.src)))],
                    audio: sources.length,
                    audioKinds: [...new Set(sources.map((source) => kind(source.src)))],
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
        const expectedKind = mode === "sw" ? "/api/asset/" : "blob:";
        const galleryDecoded = (shown) =>
            shown.decoded === images && shown.kinds.length === 1 && shown.kinds[0] === expectedKind;
        const audioReady = (shown) =>
            shown.audio === AUDIO_INLAYS && shown.audioKinds.length === 1 && shown.audioKinds[0] === expectedKind;
        check(`${mode}: the gallery's images decoded from ${expectedKind} sources`, galleryDecoded(gallery), gallery);
        check(
            `${mode}: the gallery's audio inlays have ${mode === "sw" ? "/api/asset/ sources" : "object URLs"}`,
            audioReady(gallery),
            gallery,
        );
        const galleryRow = await measure("gallery");
        if (mode === "sw") {
            check(
                "sw: direct mode uses no object URLs or /api/read",
                galleryDecoded(gallery) &&
                    audioReady(gallery) &&
                    galleryRow.urls.created === 0 &&
                    galleryRow.reads === 0,
                { urls: galleryRow.urls.created, reads: galleryRow.reads },
            );
        }

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
        check(`${mode}: the gallery shown again`, galleryDecoded(again) && audioReady(again), again);
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

    const thumbRows = [];
    if (STEPS.includes("thumb")) {
        // With files skipped, establish the account before seeding; measured runs still start fresh.
        if (!auth) {
            browser = await chromium.launch({ executablePath: chromePath, headless: true });
            const context = await browser.newContext({ serviceWorkers: "block" });
            const blocked = await isolateContext(context);
            const page = await context.newPage();
            const errors = [];
            page.on("request", credentials);
            page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
            await open(page);
            await page.waitForTimeout(1500);
            check("thumb setup: no page errors", errors.length === 0, errors.length ? errors : undefined);
            const egress = unexpectedEgress(blocked);
            check("thumb setup: no unexpected egress", egress.length === 0, egress.length ? egress : undefined);
            await browser.close();
            browser = null;
        }

        const thumbs = [];
        const writes = [];
        let bytesStored = 0;
        const ui = await single("ui");
        epoch = ui.epoch ?? epoch;
        for (let i = 0; i < THUMB_AVATARS; i++) {
            const bytes = png(THUMB_WIDTH, THUMB_HEIGHT, true);
            const key = `assets/${sha(bytes)}.png`;
            writes.push(await writeAsset(key, bytes));
            bytesStored += bytes.length;
            thumbs.push(character(randomUUID(), `Thumb ${String(i).padStart(3, "0")}`, key));
        }
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
                    ...thumbs.map((data) => ({ kind: "characters", id: data.chaId, baseRevision: null, data })),
                ],
            }),
        });
        const characters = await api("/api/resources/characters");
        const saved = new Map((characters.body?.items ?? []).map((record) => [record.data.chaId, record.data]));
        check(
            `thumb seed: ${THUMB_AVATARS} characters stored`,
            stored.status === 200 &&
                characters.status === 200 &&
                writes.every((status) => status === 200) &&
                thumbs.every((character) => saved.get(character.chaId)?.image === character.image),
            { writes: writes.length, stored: thumbs.filter((character) => saved.has(character.chaId)).length },
        );
        console.log(`thumb seeded: ${THUMB_AVATARS} ${THUMB_WIDTH}x${THUMB_HEIGHT} PNGs, ${mb(bytesStored)} MB`);

        const runs = MODES.flatMap((mode) => (mode === "sw" ? ["sw-original", "sw"] : ["no-sw"]));
        for (const mode of runs) {
            const usingSw = mode !== "no-sw";
            const label = `${mode} thumb`;
            browser = await chromium.launch({ executablePath: chromePath, headless: true });
            const context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
                serviceWorkers: usingSw ? "allow" : "block",
            });
            // Routing disables the HTTP cache. Each run has a fresh profile anyway: these are cold
            // transfers, not a warm-cache comparison; the server's generated thumbnail cache stays.
            const blocked = await isolateContext(context);
            await context.addInitScript(trackObjectUrls);
            await context.addInitScript(trackImages);
            if (mode === "sw-original") await context.addInitScript(forceOriginals);
            const requests = [];
            const inFlight = new Set();
            const finishedUrls = new Set();
            const pageErrors = [];
            let lastActivity = Date.now();
            const assetUrl = (request) => {
                const url = new URL(request.url());
                return url.origin === base && (url.pathname === "/api/read" || url.pathname.startsWith("/api/asset/"))
                    ? url
                    : null;
            };
            context.on("request", (request) => {
                if (!assetUrl(request)) return;
                requests.push(request);
                inFlight.add(request);
                lastActivity = Date.now();
            });
            const done = (request) => {
                if (inFlight.delete(request)) lastActivity = Date.now();
            };
            context.on("requestfinished", (request) => {
                if (assetUrl(request)) finishedUrls.add(request.url());
                done(request);
            });
            context.on("requestfailed", done);
            const page = await context.newPage();
            page.on("request", credentials);
            page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
            const settle = async () => {
                const deadline = Date.now() + 240_000;
                while (inFlight.size > 0 || Date.now() - lastActivity < 2000) {
                    if (Date.now() > deadline) throw new Error(`${label}: assets did not settle (${inFlight.size})`);
                    await page.waitForTimeout(250);
                }
            };
            await open(page);
            await page.locator(`[data-char-id="${thumbs[0].chaId}"]`).first().waitFor({ timeout: 120_000 });
            check(
                `${label}: the service worker ${usingSw ? "controls" : "does not control"} the page`,
                (await page.evaluate(() => !!navigator.serviceWorker?.controller)) === usingSw,
            );
            const grid = page.locator("svg.lucide-layout-grid").first();
            if (!(await grid.isVisible())) await page.locator("svg.lucide-list").first().click();
            await grid.click();
            await page.getByPlaceholder("Search").waitFor();
            const firstRow = page.locator("button").filter({ has: page.locator("span", { hasText: /^Thumb 000$/ }) });
            await firstRow.waitFor({ state: "attached" });
            const catalogRows = firstRow.locator("..").locator(":scope > button");
            check(`${label}: every character has a catalog row`, (await catalogRows.count()) === saved.size, {
                rows: await catalogRows.count(),
                stored: saved.size,
            });
            const catalog = new Map();
            const rowState = (root) => {
                const { top, bottom, width, height } = root.getBoundingClientRect();
                return {
                    name: root.querySelector("span")?.textContent,
                    connected: root.isConnected,
                    rect: { top, bottom, width, height },
                    iconStyle: root.querySelector(".ico")?.getAttribute("style") ?? null,
                    sources: window.__imageDetails(root),
                };
            };
            for (const row of await catalogRows.all()) {
                const deadline = Date.now() + 60_000;
                let recenterAt = 0;
                for (;;) {
                    if (Date.now() >= recenterAt) {
                        await row.evaluate((root) =>
                            root.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
                        );
                        recenterAt = Date.now() + 1000;
                    }
                    const state = await row.evaluate(rowState);
                    // Resource Timing can omit a reused background or leave responseEnd at zero.
                    // Context completion also covers a URL the sidebar loaded first. Blob bytes
                    // are already in the tab; decode every source below, after the request snapshot.
                    if (
                        state.sources.length > 0 &&
                        state.sources.every((source) =>
                            source.img
                                ? source.complete && source.naturalWidth > 0
                                : source.url.startsWith("blob:") || finishedUrls.has(source.url),
                        )
                    ) {
                        catalog.set(
                            state.name,
                            state.sources.map((source) => source.url),
                        );
                        break;
                    }
                    if (Date.now() >= deadline) {
                        const network = requests
                            .filter((request) => state.sources.some((source) => source.url === request.url()))
                            .map((request) => ({ url: request.url(), failure: request.failure() }));
                        throw new Error(`${label}: catalog row did not load ${JSON.stringify({ ...state, network })}`);
                    }
                    await page.waitForTimeout(100);
                }
            }
            await settle();
            const measuredRequests = requests.slice();
            const traffic = {
                read: { bytes: 0, count: 0 },
                original: { bytes: 0, count: 0 },
                variant: { bytes: 0, count: 0 },
                redirects: {},
            };
            const failedRequests = [];
            for (const request of measuredRequests) {
                const url = assetUrl(request);
                const response = await request.response();
                if (!response || response.status() >= 400) {
                    failedRequests.push({ url: url.href, status: response?.status(), error: request.failure() });
                    continue;
                }
                if (response.fromServiceWorker()) continue;
                // Count the worker's signed fetch, not the page request it answered. /api/read is
                // a page request in fallback mode; retain any such reads in sw mode to expose them.
                if (url.pathname.startsWith("/api/asset/") && usingSw && !request.serviceWorker()) continue;
                const sizes = await request.sizes().catch(() => null);
                if (sizes && sizes.responseHeadersSize + sizes.responseBodySize === 0) continue;
                // responseBodySize is transferred body bytes (no headers); content-length is only
                // a fallback if Chromium cannot supply sizes, never a substitute for a cache hit.
                const length = response.headers()["content-length"];
                const bytes = sizes?.responseBodySize ?? (length === undefined ? NaN : Number(length));
                if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`${label}: no body size for ${url.href}`);
                const kind = url.pathname === "/api/read" ? "read" : url.searchParams.has("w") ? "variant" : "original";
                traffic[kind].bytes += bytes;
                traffic[kind].count++;
                if (response.status() >= 300 && response.status() < 400) {
                    const reason = response.headers()["x-risu-thumbnail"] ?? "(none)";
                    traffic.redirects[reason] = (traffic.redirects[reason] ?? 0) + 1;
                }
            }
            check(
                `${label}: asset requests succeeded`,
                failedRequests.length === 0,
                failedRequests.length ? failedRequests : undefined,
            );
            const inspected = await page.evaluate(async () => {
                const images = [];
                for (const [url, existing] of window.__imageSources()) {
                    const image = existing ?? new Image();
                    if (!existing) image.src = url;
                    let timer;
                    try {
                        await Promise.race([
                            image.decode(),
                            new Promise((_, reject) => {
                                timer = setTimeout(
                                    () => reject(new Error("image decode timed out after 60 s")),
                                    60_000,
                                );
                            }),
                        ]);
                    } catch (error) {
                        return {
                            images,
                            failure: {
                                url,
                                error: String(error),
                                complete: image.complete,
                                naturalWidth: image.naturalWidth,
                                naturalHeight: image.naturalHeight,
                                sources: window.__imageDetails(document).filter((source) => source.url === url),
                            },
                        };
                    } finally {
                        clearTimeout(timer);
                    }
                    images.push({ url, width: image.naturalWidth, height: image.naturalHeight });
                }
                return { images, failure: null };
            });
            if (inspected.failure) {
                const affected = [...catalog].filter(([, urls]) => urls.includes(inspected.failure.url));
                const states = [];
                for (const [name] of affected) {
                    states.push(
                        await catalogRows.filter({ has: page.getByText(name, { exact: true }) }).evaluate(rowState),
                    );
                }
                throw new Error(
                    `${label}: image decode failed ${JSON.stringify({ ...inspected.failure, rows: states })}`,
                );
            }
            const decoded = inspected.images;
            await settle();
            const byUrl = new Map(decoded.map((image) => [image.url, image]));
            const avatarOk = thumbs.filter((character) => {
                const urls = catalog.get(character.name) ?? [];
                if (urls.length !== 1) return false;
                const image = byUrl.get(urls[0]);
                if (!image) return false;
                const original = `${base}/api/asset/${Buffer.from(character.image).toString("hex")}`;
                if (mode === "sw") {
                    return image.url === original + "?w=256" && Math.min(image.width, image.height) === 256;
                }
                return (
                    (mode === "sw-original" ? image.url === original : image.url.startsWith("blob:")) &&
                    image.width === THUMB_WIDTH &&
                    image.height === THUMB_HEIGHT
                );
            }).length;
            check(
                `${label}: ${THUMB_AVATARS} catalog avatars decoded from ${mode === "sw" ? "?w=256 at short side 256" : mode === "sw-original" ? "originals at full size" : "blob: at full size"}`,
                avatarOk === THUMB_AVATARS,
                { decoded: avatarOk },
            );
            if (mode === "sw-original") {
                const variants = requests.filter((request) => assetUrl(request).searchParams.has("w"));
                check(`${label}: no ?w= request by page or worker`, variants.length === 0, {
                    requests: variants.length,
                });
            } else if (mode === "sw") {
                const requested = new Set(
                    measuredRequests
                        .filter(
                            (request) => request.serviceWorker() && assetUrl(request).searchParams.get("w") === "256",
                        )
                        .map((request) => assetUrl(request).pathname),
                );
                check(
                    `${label}: the worker requested ?w=256 for every catalog avatar`,
                    thumbs.every((character) =>
                        requested.has(`/api/asset/${Buffer.from(character.image).toString("hex")}`),
                    ),
                );
            }
            const cdp = await context.newCDPSession(page);
            await cdp.send("HeapProfiler.enable");
            await cdp.send("HeapProfiler.collectGarbage");
            const { usedSize } = await cdp.send("Runtime.getHeapUsage");
            const urls = await page.evaluate(() => window.__objectUrls());
            if (usingSw) {
                check(
                    `${label}: direct mode uses no object URLs or /api/read`,
                    urls.created === 0 && traffic.read.count === 0,
                );
            }
            const sides = { 256: 0, 512: 0, other: 0 };
            let pixels = 0;
            for (const image of decoded) {
                pixels += image.width * image.height * 4;
                const side = Math.min(image.width, image.height);
                sides[side === 256 || side === 512 ? side : "other"]++;
            }
            thumbRows.push({ mode, pixels, images: decoded.length, sides, traffic, heap: usedSize, urls });
            console.log(
                `${label}: object URLs ${urls.live} live (${mb(urls.bytes)} MB), ${urls.created} created; heap ${mb(usedSize)} MB`,
            );
            check(`${label}: no page errors`, pageErrors.length === 0, pageErrors.length ? pageErrors : undefined);
            const egress = unexpectedEgress(blocked);
            check(`${label}: no unexpected egress`, egress.length === 0, egress.length ? egress : undefined);
            await browser.close();
            browser = null;
        }
    }

    if (rows.length)
        console.log("\nmode   step           URLs live  URL MB  created  blobs  blob MB  heap MB  files read  by type");
    for (const row of rows) {
        console.log(
            `${row.mode.padEnd(6)} ${row.step.padEnd(14)} ${String(row.urls.live).padStart(9)} ${mb(row.urls.bytes).padStart(7)} ${String(row.urls.created).padStart(8)} ${String(row.registry.count).padStart(6)} ${mb(row.registry.bytes).padStart(8)} ${mb(row.heap).padStart(8)} ${String(row.reads).padStart(11)}  ${JSON.stringify(row.urls.byType)}`,
        );
    }
    if (thumbRows.length) {
        console.log(
            "\nthumb mode    decoded MB  images  short side 256/512/other  /api/read MB (n)  original MB (n)  variant MB (n)  redirects (n by reason)",
        );
        for (const row of thumbRows) {
            const { read, original, variant, redirects } = row.traffic;
            const redirected = Object.values(redirects).reduce((sum, count) => sum + count, 0);
            console.log(
                `${row.mode.padEnd(13)} ${mb(row.pixels).padStart(10)} ${String(row.images).padStart(7)} ${`${row.sides[256]}/${row.sides[512]}/${row.sides.other}`.padStart(25)} ${`${mb(read.bytes)} (${read.count})`.padStart(17)} ${`${mb(original.bytes)} (${original.count})`.padStart(16)} ${`${mb(variant.bytes)} (${variant.count})`.padStart(15)}  ${redirected} ${JSON.stringify(redirects)}`,
            );
        }
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
