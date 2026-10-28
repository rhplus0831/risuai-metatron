// Manual production-build boot measurements in headless Chrome (`pnpm build` first).
// FIXTURE=reported (default): 14 modules (~130k asset tuples), 18 ~250 KB characters,
// one chat each, 50 presets. FIXTURE=audit: 300 characters, 3,000 chats, 20 modules,
// 50 presets, ten disabled ~100 KiB plugins, ~2 MiB plugin history and 300 image inlays.
// Each audit chat has ten ~1 KiB memory summaries with message ids, ten scriptstate keys,
// two local lore entries (~13 KiB metadata total), and twenty ~500-byte messages; the
// first chat instead has 2,000 ~2 KiB messages. Asset keys refer to synthetic files.
// The exported builder and byte/op-limited seeder also serve checkBootCache's small `check` fixture.
//
// RUNS=3; THROTTLE_MBPS=10 (0 disables); LATENCY_MS=40; PORT=6264; RISU_DIST=dist;
// DEBUG=1 prints server output. SCENARIOS is a comma list (default all): plain (identity
// fallback), cold (empty IndexedDB), warm, module/character (route edits), send (composer
// send then reload), otherDevice (measured page closed during another client's send),
// selfEdit (description saved through the sidebar), resume (>30 s hidden, no reload),
// scripts (HTTP cache cleared, IndexedDB kept, including late static imports).
//
// Per boot: resource timing, IndexedDB times, actual content coding, whole-answer bytes
// compressed with the server's threshold/coding rules, per-kind decoded bytes and compressed
// omission deltas (these do not add up). Node repeats the exact read unthrottled for median
// server TTFB. Summary timing reports both HTTP incremental cost (estimate) and direct
// readKinds([], { chatSummaries: true }) first/median time after shutdown on the temp-dir SQLite file,
// with its filesystem reported (tmpfs is memory-backed).
// Resume reports all API reads and hello WebSocket payload bytes; scripts reports same-origin
// non-API transfer/decoded bytes after network idle. Final Markdown tables use median bytes/ms.
// Every cached boot checks its request, expanded answer and written cache against a plain read;
// warm claims every eligible character and module. External page requests are blocked through
// CDP so Chrome's HTTP cache stays enabled. A busy port refuses startup; each run owns its store.
// Usage: pnpm build && FIXTURE=reported node util/playwright/measureBoot.mjs
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, statfs, symlink } from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { chromium } from "playwright-core";
import { chromePath, clearSafeBootAttempts, openCharacterChat, repoRoot } from "./stack.mjs";
import { modelFixtureOps, chatBindingFixture, promptFixture } from "./modelProfiles.mjs";

// The reported shape: tuples of [name ~38, "assets/<64 hex>.png", ext], all unique.
const hex = (seed) => createHash("sha256").update(seed).digest("hex");
export const assetTuples = (prefix, count) =>
    Array.from({ length: count }, (_, i) => [
        `${prefix} asset ${String(i).padStart(5, "0")} ${hex(`${prefix}${i}n`).slice(0, 21)}`,
        `assets/${hex(`${prefix}${i}`)}.png`,
        "png",
    ]);
const moduleData = (index, count) => ({
    id: randomUUID(),
    name: `Module ${index}`,
    description: `Synthetic module ${index}.`,
    lorebook: [],
    assets: assetTuples(`m${index}`, count),
});
const characterData = (index) => {
    const chaId = randomUUID();
    const name = `Character ${index}`;
    return {
        chaId,
        name,
        type: "character",
        desc: `The description of ${name}. `.repeat(1000),
        firstMessage: "Hello.",
        globalLore: Array.from({ length: 30 }, (_, i) => ({
            key: `key${i}`,
            secondkey: "",
            insertorder: 100,
            comment: `Entry ${i}`,
            content: `Lore entry ${i} of ${name}. `.repeat(82),
            mode: "normal",
            alwaysActive: false,
            selective: false,
            bookVersion: 2,
        })),
        customscript: Array.from({ length: 20 }, (_, i) => ({
            comment: `Script ${i}`,
            in: `pattern ${i} `.repeat(60),
            out: `replacement ${i} `.repeat(60),
            type: "editdisplay",
            ableFlag: false,
        })),
        additionalAssets: assetTuples(`c${index}`, 860),
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        chatFolders: [],
        firstMsgIndex: -1,
    };
};

const size = (value) => Buffer.byteLength(JSON.stringify(value));
const textOfSize = (bytes) =>
    "A character remembers the moon and speaks softly. ".repeat(Math.ceil(bytes / 49)).slice(0, bytes);
const loreEntries = (count, content) =>
    Array.from({ length: count }, (_, i) => ({
        key: `lore-${i}`,
        secondkey: "",
        content,
        insertorder: 100,
        comment: `Entry ${i}`,
        mode: "normal",
        alwaysActive: false,
        selective: false,
        bookVersion: 2,
    }));
const smallAssetTuples = (prefix, count) =>
    Array.from({ length: count }, (_, i) => [`${prefix} asset ${i}`, `assets/${hex(`${prefix}${i}`)}.png`, "png"]);
const smallCharacter = (index) => ({
    ...characterData(index),
    desc: `The description of character ${index}. `.repeat(50),
    globalLore: [],
    customscript: [],
    additionalAssets: smallAssetTuples(`c${index}`, 50),
});

/** Plain synthetic data; importing this module never starts a server or browser. */
export function buildBootFixture(
    name = "reported",
    { preset = {}, bindings = {}, cacheCheck = name === "check" } = {},
) {
    if (!["reported", "audit", "check"].includes(name)) throw new Error(`Unknown fixture: ${name}`);
    const audit = name === "audit";
    const small = name === "check";
    const characters = Array.from({ length: audit ? 300 : small ? 6 : 18 }, (_, i) => {
        if (small) return smallCharacter(i);
        if (!audit) return characterData(i);
        return {
            ...smallCharacter(i),
            desc: textOfSize(8192),
            firstMessage: textOfSize(2048),
            globalLore: loreEntries(100, textOfSize(1024)),
            customscript: [],
            additionalAssets: assetTuples(`c${i}`, 100),
            emotionImages: Array.from({ length: 20 }, (_, j) => [
                `emotion-${j}`,
                `assets/${hex(`emotion-${i}-${j}`)}.png`,
            ]),
        };
    });
    const modules = Array.from({ length: audit ? 20 : 14 }, (_, i) => ({
        ...moduleData(i, audit ? 500 : small ? 300 : i % 2 === 0 ? 9100 : 9493),
        ...(audit
            ? { lorebook: loreEntries(300, textOfSize(1024)) }
            : small
              ? { description: "", assets: smallAssetTuples(`m${i}`, 300) }
              : {}),
    }));
    if (cacheCheck) {
        const credentialCharacter = small ? characters[0] : smallCharacter(characters.length);
        if (!small) characters.push(credentialCharacter);
        credentialCharacter.oaiTTSConfig = { model: "tts-1", voice: "alloy", speed: "1", apiKey: "sk-check" };
        modules.push(modules[3]);
    }
    const presets = Array.from({ length: small ? 20 : 50 }, (_, i) => ({
        ...preset,
        id: i === 0 && preset.id ? preset.id : randomUUID(),
        name: `Preset ${i}`,
        ...(!small ? { mainPrompt: audit ? textOfSize(16384) : `The main prompt of preset ${i}. `.repeat(400) } : {}),
        ...(audit ? { jailbreak: textOfSize(8192) } : {}),
    }));
    const chats = characters.flatMap((character, c) =>
        Array.from({ length: audit ? 10 : 1 }, (_, j) => {
            const id = audit ? randomUUID() : `${character.chaId}-chat${j === 0 ? "" : `-${j}`}`;
            const message = audit
                ? Array.from({ length: c === 0 && j === 0 ? 2000 : 20 }, (_, m) => ({
                      chatId: randomUUID(),
                      role: m % 2 === 0 ? "user" : "char",
                      data: textOfSize(c === 0 && j === 0 ? 2048 : 500),
                      time: 1700000000000 + m,
                  }))
                : [];
            return {
                characterId: character.chaId,
                chat: {
                    id,
                    name: `Chat ${j + 1}`,
                    note: "",
                    fmIndex: -1,
                    ...bindings,
                    message,
                    localLore: audit ? loreEntries(2, textOfSize(512)) : [],
                    ...(audit
                        ? {
                              hypaV3Data: {
                                  summaries: Array.from({ length: 10 }, (_, m) => ({
                                      text: textOfSize(1024),
                                      chatMemos: message.slice(m, m + 3).map((entry) => entry.chatId),
                                      isImportant: false,
                                  })),
                              },
                              scriptstate: Object.fromEntries(
                                  Array.from({ length: 10 }, (_, k) => [`state-${k}`, `value-${k}`]),
                              ),
                          }
                        : {}),
                },
            };
        }),
    );
    return {
        name,
        characters,
        modules,
        presets,
        chats,
        plugins: audit
            ? Array.from({ length: 10 }, (_, i) => ({
                  name: `Plugin ${i}`,
                  version: "3.0",
                  enabled: false,
                  script: `//${textOfSize(102398)}`,
                  realArg: {},
              }))
            : [],
        pluginStorage: audit
            ? { _pluginStorage: { history: Array.from({ length: 1000 }, () => textOfSize(2048)) } }
            : {},
        inlays: audit
            ? Array.from({ length: 300 }, (_, i) => ({
                  id: randomUUID(),
                  data: {
                      name: `Image ${i}`,
                      ext: "png",
                      type: "image",
                      asset: `assets/${hex(`inlay-${i}`)}.png`,
                      width: 512,
                      height: 512,
                  },
              }))
            : [],
    };
}

/** Seed by serialized bytes and operation count; a large singleton is sent alone (<100 MiB). */
export async function seedBootFixture(api, name, { providerUrl, cacheCheck } = {}) {
    const current = {};
    for (const kind of [
        "ui",
        "presets",
        "modules",
        "plugins",
        "pluginStorage",
        "modelPresets",
        "modelProfiles",
        "personas",
        "providers",
    ])
        current[kind] = (await api(`/api/resources/${kind}/main`)).body;
    const fixture = buildBootFixture(name, {
        preset: current.presets.data[0],
        bindings: chatBindingFixture(current.modelPresets, current.presets, current.personas),
        cacheCheck,
    });
    const singleton = (kind, data) => ({ kind, id: "main", baseRevision: current[kind]?.revision ?? null, data });
    const ops = [
        singleton("ui", { ...current.ui.data, didFirstSetup: true, useLegacyGUI: true, useSayNothing: false }),
        singleton("presets", fixture.presets),
        singleton("modules", fixture.modules),
        ...fixture.characters.map((data) => ({ kind: "characters", id: data.chaId, baseRevision: null, data })),
        ...fixture.inlays.map(({ id, data }) => ({ kind: "inlays", id, baseRevision: null, data })),
    ];
    if (name === "audit")
        ops.push(singleton("plugins", fixture.plugins), singleton("pluginStorage", fixture.pluginStorage));
    if (providerUrl) {
        const config = {
            aiModel: "reverse_proxy",
            subModel: "reverse_proxy",
            forceReplaceUrl: providerUrl,
            customProxyRequestModel: "mock",
            customTokenizer: "tik",
            maxContext: 1_000_000,
            maxResponse: 100,
        };
        ops.push(...modelFixtureOps(config, current.modelPresets, current.modelProfiles));
        // Context limits belong to the prompt preset; connection options go into the model profile.
        fixture.presets[0] = promptFixture({ ...fixture.presets[0], maxContext: 1_000_000, maxResponse: 100 });
        ops.push(singleton("providers", { ...current.providers.data, useStreaming: true }));
    }
    const chats = fixture.chats.map(({ characterId, chat }) => ({
        characterId,
        chatId: chat.id,
        baseRevision: null,
        ops: [{ op: "create", chat }],
    }));
    let batch = { ops: [], chats: [], chatOrders: [] };
    let bytes = size(batch),
        count = 0,
        requests = 0,
        maxBytes = 0;
    const flush = async () => {
        if (!count) return;
        const body = JSON.stringify(batch);
        const result = await api("/api/resources/batch", { method: "POST", body });
        if (result.status !== 200) throw new Error(`Fixture batch ${requests + 1}: ${JSON.stringify(result)}`);
        requests++;
        maxBytes = Math.max(maxBytes, Buffer.byteLength(body));
        batch = { ops: [], chats: [], chatOrders: [] };
        bytes = size(batch);
        count = 0;
    };
    for (const [key, entries] of [
        ["ops", ops],
        ["chats", chats],
    ]) {
        for (const entry of entries) {
            const entryBytes = size(entry) + 1;
            const entryOps = key === "chats" ? entry.ops.length : 1;
            if (count && (bytes + entryBytes > 4_000_000 || count + entryOps >= 5000)) await flush();
            if (entryBytes > 90_000_000 || entryOps >= 5000)
                throw new Error("Fixture operation exceeds safe batch limits");
            batch[key].push(entry);
            bytes += entryBytes;
            count += entryOps;
        }
    }
    await flush();
    console.log(
        `fixture ${name}: seeded in ${requests} batches, largest ${maxBytes} bytes; chat metadata ${size({ ...fixture.chats[0].chat, message: undefined })} bytes`,
    );
    return fixture;
}

async function measureBoot() {
    const { checkCacheMeta, checkCachedRecord, expandBootAnswer, isCurrentMeta, itemKey, prepareBootRequest } =
        await import(path.join(repoRoot, "src/ts/storage/bootCache.ts"));
    const { BOOT_CACHED_KINDS, RESOURCE_KIND } = await import(path.join(repoRoot, "shared/resources.ts"));
    const { bootItemHash } = await import(path.join(repoRoot, "server/src/routes/resourceBoot.ts"));

    const RUNS = Number(process.env.RUNS ?? 3);
    const FIXTURE = process.env.FIXTURE ?? "reported";
    const allScenarios = [
        "plain",
        "cold",
        "warm",
        "module",
        "character",
        "send",
        "otherDevice",
        "selfEdit",
        "resume",
        "scripts",
    ];
    const SCENARIOS = process.env.SCENARIOS?.split(",").map((value) => value.trim()) ?? allScenarios;
    if (
        !["reported", "audit"].includes(FIXTURE) ||
        !Number.isInteger(RUNS) ||
        RUNS < 1 ||
        SCENARIOS.some((name) => !allScenarios.includes(name))
    )
        throw new Error("Use FIXTURE=reported|audit, positive integer RUNS and known SCENARIOS");
    const { COMPRESS_MIN_BYTES, pickEncoding } = await import(path.join(repoRoot, "server/src/http/compressedJson.ts"));
    const THROTTLE_MBPS = Number(process.env.THROTTLE_MBPS ?? 10);
    const LATENCY_MS = Number(process.env.LATENCY_MS ?? 40);
    const port = Number(process.env.PORT ?? 6264);
    const base = `http://localhost:${port}`;
    const PLAIN_READ_PATH = "/api/resources";
    const BOOT_PATH = "/api/resources/boot";
    // The public hosts the production page asks for (its CDN stylesheets and fonts, the hub listing): blocked
    // through CDP, not `isolateContext`, because Playwright's request routing turns the HTTP cache off and
    // every boot would download the app's scripts again.
    const EXPECTED_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com", "sv.risuai.xyz"];
    const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
    const median = (values) => {
        const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
        return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
    };
    const mb = (bytes) => (bytes === null ? "-" : `${(bytes / 1e6).toFixed(2)} MB`);
    const ms = (value) => (value === null ? "-" : `${Math.round(value)} ms`);

    // A server left on the port (an interrupted run) would answer in place of this one.
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", () => reject(new Error(`Port ${port} is in use`)));
        probe.listen(port, () => probe.close(resolve));
    });
    const workDir = await mkdtemp(path.join(os.tmpdir(), "risu-measure-boot-"));
    await symlink(path.join(repoRoot, "public"), path.join(workDir, "public"), "dir");
    await mkdir(path.join(workDir, "server"));
    await symlink(path.join(repoRoot, "server/assets"), path.join(workDir, "server/assets"), "dir");
    await symlink(dist, path.join(workDir, "dist"), "dir");
    await copyFile(path.join(repoRoot, "version.json"), path.join(workDir, "version.json"));
    const {
        RISU_HOST,
        RISU_SAVE_DIR,
        RISU_AGENT_DEV_AUTH_BYPASS,
        RISU_PASSWORD_SHA256,
        NODE_OPTIONS,
        ...inheritedEnv
    } = process.env;
    const server = spawn(process.execPath, [path.join(repoRoot, "server/src/main.ts")], {
        cwd: workDir,
        env: { ...inheritedEnv, PORT: String(port), RISU_SAVE_DIR: path.join(workDir, "save") },
        stdio: ["ignore", "pipe", process.env.DEBUG ? "inherit" : "ignore"],
    });
    let serverError = null;
    server.on("error", (error) => (serverError = error));
    let serverListening = false;
    let serverOutput = "";
    server.stdout.on("data", (chunk) => {
        if (process.env.DEBUG) process.stdout.write(chunk);
        serverOutput += chunk.toString();
        // main.ts prints this URL from serve's listening callback, only after this child binds.
        serverListening ||= serverOutput.includes(`[Server] ${base}/\n`);
        serverOutput = serverOutput.slice(-1024);
    });
    const waitForServer = async () => {
        for (let i = 0; i < 150; i++) {
            // A child that died (say the port was taken after the probe) is not the server that answers.
            if (serverError || server.exitCode !== null || server.signalCode !== null)
                throw new Error(`the server exited: ${serverError ?? server.exitCode ?? server.signalCode}`);
            if (serverListening) {
                try {
                    const response = await fetch(`${base}/api/test_auth`);
                    if (response.status && server.exitCode === null && server.signalCode === null && !serverError)
                        return;
                } catch {}
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error("the server did not start");
    };
    const stopServer = () =>
        new Promise((resolve) => {
            if (server.exitCode !== null || server.signalCode !== null) return resolve();
            const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
            server.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
            server.kill("SIGTERM");
        });
    let browser = null;
    const providerRequests = [];
    const provider = http.createServer(async (req, res) => {
        try {
            const parts = [];
            for await (const part of req) parts.push(part);
            const body = JSON.parse(Buffer.concat(parts).toString());
            providerRequests.push(body);
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "Deterministic boot reply." } }] })}\n\ndata: [DONE]\n\n`,
            );
        } catch (error) {
            res.writeHead(500);
            res.end(String(error));
        }
    });

    try {
        await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
        const providerUrl = `http://127.0.0.1:${provider.address().port}/v1/chat/completions`;
        browser = await chromium.launch({ executablePath: chromePath, headless: true });
        await waitForServer();
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        // The main screen: the loading screen (`App.svelte`, `!$loadedStore`) seen, then gone; from
        // navigation start. Polled per frame until then.
        await clearSafeBootAttempts(context);
        await context.addInitScript(() => {
            performance.setResourceTimingBufferSize(10000);
            let visibility = "visible";
            Object.defineProperty(document, "visibilityState", { get: () => visibility });
            Object.defineProperty(document, "hidden", { get: () => visibility === "hidden" });
            window.__setVisibility = (state) => {
                visibility = state;
                document.dispatchEvent(new Event("visibilitychange"));
            };
            const spinner = () => document.querySelector("div.bg-gray-900.flex-col svg.animate-spin");
            const poll = () => {
                if (spinner()) {
                    window.__risuLoadingSeen ??= performance.now();
                } else if (window.__risuLoadingSeen !== undefined) {
                    window.__risuLoaded = performance.now();
                    return;
                }
                requestAnimationFrame(poll);
            };
            requestAnimationFrame(poll);
        });
        let page;
        let cdp;
        const blockHosts = (paths = []) =>
            cdp.send("Network.setBlockedURLs", {
                urls: [
                    ...EXPECTED_HOSTS.map((host) => `*://${host}/*`),
                    ...paths.map((p) => `*://localhost:${port}${p}`),
                ],
            });
        // The four blocked public hosts are expected; sends reach only the local mock provider.
        const external = [];
        const pageErrors = [];
        let auth = null;
        let epoch = null;
        let boot = null;
        let plainEncoding = null;
        let socketNumber = 0;
        const hellos = [];
        const network = async (throttled = true) => {
            if (THROTTLE_MBPS > 0)
                await cdp.send("Network.emulateNetworkConditions", {
                    offline: false,
                    latency: throttled ? LATENCY_MS : 0,
                    downloadThroughput: throttled ? (THROTTLE_MBPS * 1e6) / 8 : -1,
                    uploadThroughput: throttled ? (THROTTLE_MBPS * 1e6) / 8 : -1,
                });
        };
        const attachPage = async (target, throttled = true) => {
            page = target;
            cdp = await context.newCDPSession(page);
            await cdp.send("Network.enable");
            await blockHosts();
            await network(throttled);
            page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
            page.on("websocket", (socket) => {
                const number = ++socketNumber;
                socket.on("framereceived", ({ payload }) => {
                    try {
                        if (JSON.parse(payload.toString()).type === "hello")
                            hellos.push({ socket: number, bytes: Buffer.byteLength(payload), time: Date.now() });
                    } catch {}
                });
            });
            page.on("request", (request) => {
                const url = new URL(request.url());
                if (url.protocol.startsWith("http") && !LOCAL_HOSTS.has(url.hostname)) external.push(url.href);
                const headers = request.headers();
                if (headers["risu-auth"]) auth = headers["risu-auth"];
                if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
                if (request.method() === "POST" && url.pathname === BOOT_PATH) {
                    boot = {
                        request: JSON.parse(request.postData() ?? "null"),
                        headers: request.allHeaders(),
                        answer: null,
                    };
                }
            });
            page.on("response", (response) => {
                if (response.request().method() === "GET" && new URL(response.url()).pathname === PLAIN_READ_PATH)
                    plainEncoding = response.headers()["content-encoding"] ?? "identity";
                if (response.request().method() === "POST" && new URL(response.url()).pathname === BOOT_PATH && boot) {
                    boot.encoding = response.headers()["content-encoding"] ?? "identity";
                    boot.answer = response.text().then(
                        (text) => JSON.parse(text),
                        () => null,
                    );
                }
            });
        };
        await attachPage(await context.newPage(), false);
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
        const plainRead = async () => {
            const r = await fetch(
                `${base}${PLAIN_READ_PATH}?kinds=${Object.values(RESOURCE_KIND).join(",")}&chatSummaries=1`,
                { headers: { "risu-auth": auth } },
            );
            return r.text();
        };

        // First open: answers the node-password prompt (a fresh server sets it).
        const open = async (target = page) => {
            await target.goto(base);
            const deadline = Date.now() + 180_000;
            while (Date.now() < deadline) {
                if (await target.evaluate(() => window.__risuLoaded !== undefined).catch(() => false)) return;
                const input = target.locator("input:visible").first();
                const ok = target.getByRole("button", { name: "OK", exact: true });
                if ((await ok.count()) > 0 && (await input.count()) > 0) {
                    await input.fill("measure");
                    await ok.first().click();
                }
                await target.waitForTimeout(300);
            }
            throw new Error("the app did not load");
        };
        await open();
        await page.waitForTimeout(1500);
        const single = async (kind, id = "main") => (await api(`/api/resources/${kind}/${id}`)).body;
        epoch = (await single("ui")).epoch ?? epoch;
        const fixture = await seedBootFixture(api, FIXTURE, { providerUrl });
        const { characters, modules: moduleList, presets: presetList } = fixture;
        const listing = (await api("/api/resources/revisions")).body;
        console.log(
            `counts: resources ${listing.resources.length}, chats ${listing.chats.length}, inlays ${listing.resources.filter((record) => record.kind === "inlays").length}`,
        );
        const plainBytes = Buffer.byteLength(await plainRead());
        console.log(
            `plain read body: ${mb(plainBytes)} (modules ${mb(size(moduleList))}, characters ${mb(size(characters))}, presets ${mb(size(presetList))})`,
        );
        await page.reload();
        await page.waitForFunction(() => window.__risuLoaded !== undefined, null, { timeout: 180_000 });
        await page.waitForFunction(() => performance.getEntriesByName("risu-boot-cache:written").length > 0, null, {
            timeout: 30000,
        });
        await page.waitForLoadState("networkidle");
        await network();

        // Raw HTTP keeps content coding intact and times receipt of headers, before consuming the body.
        const rawRead = (pathname, { method = "GET", body, headers = {} } = {}) =>
            new Promise((resolve, reject) => {
                const start = performance.now();
                const req = http.request(
                    base + pathname,
                    { method, headers: { "risu-auth": auth, "content-type": "application/json", ...headers } },
                    (res) => {
                        const ttfb = performance.now() - start;
                        const parts = [];
                        res.on("data", (part) => parts.push(part));
                        res.on("error", reject);
                        res.on("end", () => {
                            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${pathname}`));
                            let data = Buffer.concat(parts);
                            const encoding = res.headers["content-encoding"] ?? "identity";
                            if (encoding === "zstd") data = zlib.zstdDecompressSync(data);
                            else if (encoding === "gzip") data = zlib.gunzipSync(data);
                            resolve({ ttfb, encoding, body: JSON.parse(data.toString()) });
                        });
                    },
                );
                req.on("error", reject);
                req.end(body);
            });
        const summaryCosts = [];
        for (let i = 0; i < 7; i++) {
            const paths = ["/api/resources?kinds=ui", "/api/resources?kinds=ui&chatSummaries=1"];
            const times = [];
            // Alternate order to reduce systematic warmup bias.
            for (const j of i % 2 ? [1, 0] : [0, 1])
                times[j] = (await rawRead(paths[j], { headers: { "Accept-Encoding": "identity" } })).ttfb;
            summaryCosts.push(times[1] - times[0]);
        }
        console.log(
            `readSummaries HTTP incremental cost (estimate): ${median(summaryCosts).toFixed(2)} ms (7 paired TTFB differences, identity, unthrottled)`,
        );
        const zstdCompress = promisify(zlib.zstdCompress);
        const gzipCompress = promisify(zlib.gzip);
        const encodedSize = async (value, accept) => {
            const data = Buffer.from(JSON.stringify(value));
            const encoding = data.length < COMPRESS_MIN_BYTES ? null : pickEncoding(accept);
            // The async API matches the server: sync zstd pledges the input size, changing both
            // the frame header and (for smaller answers) the compression parameters and payload.
            if (encoding === "zstd")
                return (
                    await zstdCompress(data, {
                        params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 },
                    })
                ).length;
            if (encoding === "gzip") return (await gzipCompress(data, { level: 1 })).length;
            return data.length;
        };
        const answerSizes = async (answer, accept) => {
            const compressed = await encodedSize(answer, accept);
            const identity = size(answer) < COMPRESS_MIN_BYTES || !pickEncoding(accept);
            // Removing a JSON member also removes its key, colon and (unless alone) one comma.
            // Every reduction of an identity answer is identity too, so no recompression is needed.
            const identityOmission = (key, value, count) => size(key) + 1 + size(value) + (count > 1 ? 1 : 0);
            const kinds = {};
            for (const [kind, value] of Object.entries(answer.kinds)) {
                const rest = { ...answer.kinds };
                delete rest[kind];
                kinds[kind] = {
                    decoded: size(value),
                    omission: identity
                        ? identityOmission(kind, value, Object.keys(answer.kinds).length)
                        : compressed - (await encodedSize({ ...answer, kinds: rest }, accept)),
                };
            }
            for (const [key, value] of Object.entries(answer)) {
                if (key === "kinds") continue;
                const rest = { ...answer };
                delete rest[key];
                kinds[key] = {
                    decoded: size(value),
                    omission: identity
                        ? identityOmission(key, value, Object.keys(answer).length)
                        : compressed - (await encodedSize(rest, accept)),
                };
            }
            return { compressed, kinds };
        };

        // The boot cache as the page's IndexedDB holds it (raw, as the adapter wrote it).
        const readCache = () =>
            page.evaluate(
                () =>
                    new Promise((resolve, reject) => {
                        const open = indexedDB.open("risu-boot-cache");
                        // No cache yet: leave it absent (creating it here would give the app a database
                        // without its stores).
                        open.onupgradeneeded = () => open.transaction.abort();
                        open.onerror = () => (open.error?.name === "AbortError" ? resolve(null) : reject(open.error));
                        open.onsuccess = () => {
                            const db = open.result;
                            const names = [...db.objectStoreNames];
                            if (!names.includes("records")) {
                                db.close();
                                resolve(null);
                                return;
                            }
                            const tx = db.transaction(names, "readonly");
                            const reads = names.map((name) => [
                                name,
                                tx.objectStore(name).getAllKeys(),
                                tx.objectStore(name).getAll(),
                            ]);
                            tx.oncomplete = () => {
                                db.close();
                                resolve(
                                    Object.fromEntries(
                                        reads.map(([name, keys, values]) => [
                                            name,
                                            keys.result.map((key, i) => [key, values.result[i]]),
                                        ]),
                                    ),
                                );
                            };
                            tx.onerror = () => reject(tx.error);
                        };
                    }),
            );
        // What `indexedDbBootCacheStore.load` gives for those contents.
        const contentsOf = (raw) => {
            if (!raw) return { meta: null, records: [], items: new Map() };
            const metaEntry = raw.meta?.[0]?.[1];
            const meta = checkCacheMeta(metaEntry);
            if (!meta || !isCurrentMeta(meta, meta.appVer)) return { meta, records: [], items: new Map() };
            const records = raw.records.map(([, value]) => checkCachedRecord(value)).filter(Boolean);
            const stored = new Map(raw.items.map(([key, value]) => [key, value]));
            const items = new Map();
            for (const record of records) {
                for (const hash of record.hashes ?? []) {
                    const key = itemKey(record.kind, hash);
                    if (typeof stored.get(key) === "string") items.set(key, stored.get(key));
                }
            }
            return { meta, records, items };
        };
        const deleteCache = () =>
            page.evaluate(
                () =>
                    new Promise((resolve, reject) => {
                        const request = indexedDB.deleteDatabase("risu-boot-cache");
                        request.onsuccess = () => resolve();
                        request.onerror = () => reject(request.error);
                    }),
            );

        const samples = {};
        const bootOnce = async (scenario, { expectWrite = true, before = undefined, navigate = false } = {}) => {
            before ??= await readCache();
            boot = null;
            plainEncoding = null;
            if (navigate) await page.goto(base);
            else await page.reload();
            await page.waitForFunction(() => window.__risuLoaded !== undefined, null, { timeout: 180_000 });
            if (expectWrite) {
                await page
                    .waitForFunction(() => performance.getEntriesByName("risu-boot-cache:written").length > 0, null, {
                        timeout: 30_000,
                    })
                    .catch(() => {});
            } else {
                await page.waitForTimeout(2000);
            }
            if (scenario === "scripts") await page.waitForLoadState("networkidle");
            const metrics = await page.evaluate(
                ({ plainPath, bootPath }) => {
                    const mark = (name) => performance.getEntriesByName(name)[0]?.startTime ?? null;
                    const span = (from, to) =>
                        mark(from) === null || mark(to) === null ? null : mark(to) - mark(from);
                    const reads = performance
                        .getEntriesByType("resource")
                        .filter((entry) => [plainPath, bootPath].includes(new URL(entry.name).pathname))
                        .map((entry) => ({
                            path: new URL(entry.name).pathname,
                            transfer: entry.transferSize,
                            encoded: entry.encodedBodySize,
                            decoded: entry.decodedBodySize,
                            duration: entry.responseEnd - entry.startTime,
                            end: entry.responseEnd,
                            waiting: entry.responseStart - entry.requestStart,
                        }))
                        .filter((entry) => entry.decoded > 0);
                    // Everything else the page fetched before the main screen (the app's scripts and styles).
                    const other = performance
                        .getEntriesByType("resource")
                        .filter(
                            (entry) =>
                                entry.startTime < window.__risuLoaded &&
                                ![plainPath, bootPath].includes(new URL(entry.name).pathname),
                        );
                    return {
                        loaded: window.__risuLoaded,
                        bootStart: mark("risu-boot-cache:read-start"),
                        otherBytes: other.reduce((sum, entry) => sum + entry.transferSize, 0),
                        otherCount: other.length,
                        reads,
                        staticReads: [
                            ...performance.getEntriesByType("resource"),
                            ...performance.getEntriesByType("navigation"),
                        ]
                            .filter(
                                (entry) =>
                                    new URL(entry.name).origin === location.origin &&
                                    !new URL(entry.name).pathname.startsWith("/api/"),
                            )
                            .map((entry) => ({
                                path: new URL(entry.name).pathname,
                                transfer: entry.transferSize,
                                decoded: entry.decodedBodySize,
                            })),
                        written: mark("risu-boot-cache:written") !== null,
                        cacheRead: span("risu-boot-cache:read-start", "risu-boot-cache:read"),
                        cacheWrite: span("risu-boot-cache:write-start", "risu-boot-cache:written"),
                    };
                },
                { plainPath: PLAIN_READ_PATH, bootPath: BOOT_PATH },
            );
            const read = metrics.reads.at(-1) ?? null;
            const sample = {
                loaded: metrics.loaded,
                bootStart: metrics.bootStart,
                afterRead: read === null ? null : metrics.loaded - read.end,
                otherBytes: metrics.otherBytes,
                transfer: read?.transfer ?? null,
                decoded: read?.decoded ?? null,
                readTime: read?.duration ?? null,
                waiting: read?.waiting ?? null,
                cacheRead: metrics.cacheRead,
                cacheWrite: metrics.cacheWrite,
                path: read?.path ?? null,
                staticTransfer: metrics.staticReads.reduce((sum, entry) => sum + entry.transfer, 0),
                staticDecoded: metrics.staticReads.reduce((sum, entry) => sum + entry.decoded, 0),
            };
            (samples[scenario] ??= []).push(sample);
            console.log(
                `${scenario}: main screen ${ms(sample.loaded)}, ${sample.path} ${mb(sample.transfer)} on the wire ` +
                    `(${mb(sample.decoded)} decoded) in ${ms(sample.readTime)} (server ${ms(sample.waiting)}), ` +
                    `IndexedDB read ${ms(sample.cacheRead)}, write ${ms(sample.cacheWrite)}; the boot read starts at ` +
                    `${ms(sample.bootStart)}, ${metrics.otherCount} other requests before the main screen ${mb(sample.otherBytes)}`,
            );
            const sentHeaders = scenario === "plain" ? { "accept-encoding": "identity" } : await boot.headers;
            const accept = sentHeaders["accept-encoding"];
            const timings = [];
            let repeated;
            for (let i = 0; i < 3; i++) {
                repeated = await rawRead(
                    scenario === "plain"
                        ? `${PLAIN_READ_PATH}?kinds=${Object.values(RESOURCE_KIND).join(",")}&chatSummaries=1`
                        : BOOT_PATH,
                    {
                        method: scenario === "plain" ? "GET" : "POST",
                        body: scenario === "plain" ? undefined : JSON.stringify(boot.request),
                        headers: { "Accept-Encoding": accept },
                    },
                );
                timings.push(repeated.ttfb);
            }
            const answer = (await boot?.answer) ?? repeated.body;
            Object.assign(sample, await answerSizes(answer, accept), {
                ttfb: median(timings),
                encoding: scenario === "plain" ? plainEncoding : boot.encoding,
            });
            check(
                `${scenario}: coding matches server rules`,
                sample.encoding ===
                    (size(answer) < COMPRESS_MIN_BYTES ? "identity" : (pickEncoding(accept) ?? "identity")),
                { encoding: sample.encoding },
            );
            check(
                `${scenario}: computed answer size equals browser encoded body`,
                sample.compressed === read?.encoded,
                { computed: sample.compressed, browser: read?.encoded },
            );
            console.log(
                `${scenario}: whole answer ${sample.compressed} bytes (${sample.encoding}), unthrottled server TTFB ${sample.ttfb.toFixed(2)} ms`,
            );
            if (scenario === "scripts")
                console.log(
                    `scripts: static files ${sample.staticTransfer} bytes on the wire / ${sample.staticDecoded} decoded (${metrics.staticReads.length} requests, after network idle)`,
                );
            if (scenario !== "plain") {
                check(
                    `${scenario}: the boot route answered, no fallback read, the cache was read and written`,
                    metrics.reads.length === 1 &&
                        read.path === BOOT_PATH &&
                        metrics.cacheRead !== null &&
                        metrics.written,
                    {
                        reads: metrics.reads.map((entry) => entry.path),
                        cacheRead: metrics.cacheRead,
                        written: metrics.written,
                    },
                );
                const contents = contentsOf(before);
                const prepared = prepareBootRequest(contents);
                check(
                    `${scenario}: the boot request is the one the cache gives`,
                    JSON.stringify(boot?.request) === JSON.stringify(prepared.request),
                );
                let same = false;
                try {
                    const expanded = expandBootAnswer(answer, prepared);
                    same = JSON.stringify(expanded.snapshot) === (await plainRead());
                } catch (error) {
                    console.error(error);
                }
                check(`${scenario}: the expanded answer equals a plain read`, same);
                // What the tab itself wrote from its expanded snapshot: every record of a cached kind at the
                // plain read's revision with its text (an item record: its item texts in order).
                const plain = JSON.parse(await plainRead());
                const written = contentsOf(await readCache());
                const mismatched = [];
                let expected = 0;
                for (const kind of BOOT_CACHED_KINDS) {
                    for (const record of plain.kinds[kind] ?? []) {
                        expected++;
                        const cached = written.records.find((entry) => entry.kind === kind && entry.id === record.id);
                        const text =
                            cached?.text ??
                            (cached
                                ? `[${cached.hashes.map((hash) => written.items.get(itemKey(kind, hash))).join(",")}]`
                                : null);
                        if (cached?.revision !== record.revision || text !== JSON.stringify(record.data)) {
                            mismatched.push(`${kind}/${record.id}`);
                        }
                    }
                }
                check(
                    `${scenario}: the cache the tab wrote equals a plain read`,
                    mismatched.length === 0 && written.records.length === expected,
                    mismatched.length === 0 ? undefined : { mismatched, records: written.records.length, expected },
                );
                if (scenario === "warm") {
                    const claimed = new Set((boot?.request?.known?.records ?? []).map((r) => `${r.kind}/${r.id}`));
                    const hashes = boot?.request?.known?.items?.find((entry) => entry.kind === "modules")?.hashes ?? [];
                    const stored = new Set((await single("modules")).data.map((item) => bootItemHash(item)));
                    check(
                        "warm: every character, the modules and presets records, and every module's hash are claimed",
                        characters.every((c) => claimed.has(`characters/${c.chaId}`)) &&
                            claimed.has("modules/main") &&
                            claimed.has("presets/main") &&
                            hashes.length === stored.size &&
                            hashes.every((hash) => stored.has(hash)),
                        { records: claimed.size, moduleHashes: hashes.length },
                    );
                }
            }
            return sample;
        };

        // `plain`: the boot request blocked, no content coding accepted (the read is sent uncompressed).
        if (SCENARIOS.includes("plain")) {
            await blockHosts([BOOT_PATH]);
            await cdp.send("Network.setExtraHTTPHeaders", { headers: { "Accept-Encoding": "identity" } });
            for (let run = 0; run < RUNS; run++) await bootOnce("plain", { expectWrite: false });
            await cdp.send("Network.setExtraHTTPHeaders", { headers: {} });
            await blockHosts();
            const plainEncodings = samples.plain.map((sample) => sample.transfer >= plainBytes);
            check("plain: the read was uncompressed", plainEncodings.every(Boolean));
        }

        if (SCENARIOS.includes("cold"))
            for (let run = 0; run < RUNS; run++) {
                await deleteCache();
                await bootOnce("cold");
            }
        if (SCENARIOS.includes("warm")) for (let run = 0; run < RUNS; run++) await bootOnce("warm");
        if (SCENARIOS.includes("module"))
            for (let run = 0; run < RUNS; run++) {
                const current = await single("modules");
                const data = structuredClone(current.data);
                data[run % moduleList.length].assets.push(...assetTuples(`edit${run}`, 1));
                const edited = await api("/api/resources/modules/main", {
                    method: "PUT",
                    body: JSON.stringify({ baseRevision: current.revision, data }),
                });
                check(`module edit ${run}: stored`, edited.status === 200, edited.status === 200 ? undefined : edited);
                await bootOnce("module");
            }
        if (SCENARIOS.includes("character"))
            for (let run = 0; run < RUNS; run++) {
                const id = characters[run % characters.length].chaId;
                const current = (await api(`/api/resources/characters/${id}`)).body;
                const edited = await api(`/api/resources/characters/${id}`, {
                    method: "PUT",
                    body: JSON.stringify({
                        baseRevision: current.revision,
                        data: { ...current.data, desc: `${current.data.desc} Edited ${run}.` },
                    }),
                });
                check(
                    `character edit ${run}: stored`,
                    edited.status === 200,
                    edited.status === 200 ? undefined : edited,
                );
                await bootOnce("character");
            }

        const idle = async (target = page) => {
            await target.waitForLoadState("networkidle");
            await target.waitForFunction(() => !document.querySelector('button[aria-labelledby="cancel"]'));
        };
        const homeOnReload = () => page.evaluate(() => history.replaceState(null, "", "/"));
        const send = async (target, run, label) => {
            const character = characters[1 + (run % (characters.length - 1))];
            const chat = fixture.chats.find((entry) => entry.characterId === character.chaId).chat;
            await openCharacterChat(target, character.chaId);
            const input = target.locator("textarea.input-text").first();
            await input.fill(`Boot measurement ${label} ${run}`);
            const previous = providerRequests.length;
            await input.press("Enter");
            let stored = false;
            for (const until = Date.now() + 120_000; Date.now() < until;) {
                const result = await api("/api/resources/read", {
                    method: "POST",
                    body: JSON.stringify({ chats: [{ characterId: character.chaId, id: chat.id }] }),
                });
                const messages = result.body?.chats?.[0]?.data?.message ?? [];
                stored =
                    messages.at(-1)?.role === "char" &&
                    messages.at(-1)?.data === "Deterministic boot reply." &&
                    messages.at(-2)?.data === `Boot measurement ${label} ${run}` &&
                    providerRequests.length > previous;
                if (stored) break;
                await target.waitForTimeout(500);
            }
            check(`${label} ${run}: composer send reply stored`, stored);
            if (!stored) throw new Error(`${label}: send did not store its reply`);
            await idle(target);
        };
        if (SCENARIOS.includes("send"))
            for (let run = 0; run < RUNS; run++) {
                await send(page, run, "send");
                await homeOnReload();
                await bootOnce("send");
            }
        if (SCENARIOS.includes("otherDevice"))
            for (let run = 0; run < RUNS; run++) {
                await idle();
                const before = await readCache();
                await page.close();
                const second = await browser.newContext({ viewport: { width: 1280, height: 800 } });
                try {
                    await clearSafeBootAttempts(second);
                    // Reuse only the loading/visibility observer; no measured network listeners or throttling.
                    await second.addInitScript(() => {
                        const poll = () => {
                            if (document.querySelector("div.bg-gray-900.flex-col svg.animate-spin"))
                                window.__risuLoadingSeen = true;
                            else if (window.__risuLoadingSeen) {
                                window.__risuLoaded = performance.now();
                                return;
                            }
                            requestAnimationFrame(poll);
                        };
                        requestAnimationFrame(poll);
                    });
                    const other = await second.newPage();
                    other.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
                    other.on("request", (request) => {
                        const url = new URL(request.url());
                        if (url.protocol.startsWith("http") && !LOCAL_HOSTS.has(url.hostname)) external.push(url.href);
                    });
                    const otherCdp = await second.newCDPSession(other);
                    await otherCdp.send("Network.enable");
                    await otherCdp.send("Network.setBlockedURLs", {
                        urls: EXPECTED_HOSTS.map((host) => `*://${host}/*`),
                    });
                    await open(other);
                    await idle(other);
                    await send(other, run, "otherDevice");
                } finally {
                    await second.close();
                }
                await attachPage(await context.newPage());
                await bootOnce("otherDevice", { before, navigate: true });
            }
        if (SCENARIOS.includes("selfEdit"))
            for (let run = 0; run < RUNS; run++) {
                const character = characters[1 + (run % (characters.length - 1))];
                const current = await single("characters", character.chaId);
                const description = `${current.data.desc} Saved in the tab ${run}.`;
                await page.locator(`[data-char-id="${character.chaId}"]`).first().click();
                await page.getByRole("button", { name: "Character", exact: true }).click();
                // Character Name is in the basic panel; its following textbox edits the description.
                // The first icon tab returns to that panel if a prior selection left another one open.
                if (!(await page.getByPlaceholder("Character Name").count()))
                    await page.locator("button:has(svg.lucide-user)").first().click();
                const name = page.getByPlaceholder("Character Name");
                await name.waitFor();
                const descriptionInput = name.locator(
                    'xpath=following::*[@contenteditable="true" or self::textarea][1]',
                );
                await descriptionInput.fill(description);
                await descriptionInput.press("Tab");
                let saved = false;
                for (const until = Date.now() + 60000; Date.now() < until;) {
                    const record = await single("characters", character.chaId);
                    if (record.data?.desc === description && record.revision !== current.revision) {
                        saved = true;
                        break;
                    }
                    await page.waitForTimeout(300);
                }
                check(`selfEdit ${run}: description saved from sidebar`, saved);
                if (!saved) throw new Error("The sidebar description was not saved");
                await homeOnReload();
                await bootOnce("selfEdit");
            }
        if (SCENARIOS.includes("resume"))
            for (let run = 0; run < RUNS; run++) {
                await idle();
                // At least one hello and its listing have reconciled before starting the hidden interval.
                await page.waitForFunction(() =>
                    performance
                        .getEntriesByType("resource")
                        .some(
                            (entry) =>
                                new URL(entry.name).pathname === "/api/resources/revisions" && entry.responseEnd > 0,
                        ),
                );
                const previousSocket = socketNumber;
                await page.evaluate(() => window.__setVisibility("hidden"));
                console.log(`resume ${run}: hidden for 31 s`);
                await page.waitForTimeout(31000);
                const start = await page.evaluate(() => performance.now());
                const listingDone = page.waitForResponse(
                    (response) =>
                        new URL(response.url()).pathname === "/api/resources/revisions" && response.status() === 200,
                );
                await page.evaluate(() => window.__setVisibility("visible"));
                const response = await listingDone;
                await response.finished();
                for (
                    const until = Date.now() + 30000;
                    Date.now() < until && !hellos.some((hello) => hello.socket > previousSocket);
                )
                    await page.waitForTimeout(50);
                await idle();
                const reads = await page.evaluate(
                    (start) =>
                        performance
                            .getEntriesByType("resource")
                            .filter(
                                (entry) => entry.startTime >= start && new URL(entry.name).pathname.startsWith("/api/"),
                            )
                            .map((entry) => ({
                                path: new URL(entry.name).pathname,
                                transfer: entry.transferSize,
                                decoded: entry.decodedBodySize,
                            })),
                    start,
                );
                const listings = reads.filter((entry) => entry.path === "/api/resources/revisions");
                const hello = hellos.find((entry) => entry.socket > previousSocket);
                check(
                    `resume ${run}: new socket hello and completed revision listing`,
                    !!hello && listings.length === 1 && listings[0].decoded > 0,
                    { hello, reads },
                );
                const sample = {
                    transfer: listings.reduce((sum, entry) => sum + entry.transfer, 0),
                    decoded: listings.reduce((sum, entry) => sum + entry.decoded, 0),
                    hello: hello?.bytes ?? 0,
                    apiTransfer: reads.reduce((sum, entry) => sum + entry.transfer, 0),
                    apiDecoded: reads.reduce((sum, entry) => sum + entry.decoded, 0),
                };
                (samples.resume ??= []).push(sample);
                console.log(
                    `resume: listing ${sample.transfer} wire / ${sample.decoded} decoded bytes, hello ${sample.hello} WebSocket payload bytes; all API reads ${sample.apiTransfer} wire / ${sample.apiDecoded} decoded bytes`,
                );
            }
        if (SCENARIOS.includes("scripts"))
            for (let run = 0; run < RUNS; run++) {
                await idle();
                await cdp.send("Network.clearBrowserCache");
                await bootOnce("scripts");
            }

        console.log(
            `\nmedians (${THROTTLE_MBPS > 0 ? `${THROTTLE_MBPS} Mbps, ${LATENCY_MS} ms latency` : "unthrottled"}, ${RUNS} runs):`,
        );
        for (const [scenario, list] of Object.entries(samples)) {
            const pick = (key) => median(list.map((sample) => sample[key]));
            console.log(
                `  ${scenario.padEnd(9)} main screen ${ms(pick("loaded")).padStart(8)}  read ${mb(pick("transfer")).padStart(9)} ` +
                    `on the wire, ${mb(pick("decoded")).padStart(9)} decoded, ${ms(pick("readTime")).padStart(8)} ` +
                    `(server ${ms(pick("waiting"))})  IndexedDB read ${ms(pick("cacheRead"))}, write ${ms(pick("cacheWrite"))}  ` +
                    `boot read at ${ms(pick("bootStart"))}, main screen ${ms(pick("afterRead"))} after the read ended, other transfers ${mb(pick("otherBytes"))}`,
            );
        }

        console.log(
            `\nfixture ${FIXTURE}: median bytes and milliseconds; wire includes browser-reported transfer overhead`,
        );
        console.log(
            "| Scenario | Boot wire B | Decoded B | Compressed answer B | Encoding | Server TTFB ms | Main screen ms | Listing wire / decoded B | Hello WS payload B | Static wire / decoded B |",
        );
        console.log("| --- | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: | --- |");
        for (const [scenario, list] of Object.entries(samples)) {
            const pick = (key) => median(list.map((sample) => sample[key]));
            const value = (key) => (pick(key) === null ? "-" : Number(pick(key).toFixed(2)));
            console.log(
                `| ${scenario} | ${scenario === "resume" ? "-" : value("transfer")} | ${scenario === "resume" ? "-" : value("decoded")} | ${value("compressed")} | ${[...new Set(list.map((sample) => sample.encoding).filter(Boolean))].join(", ") || "-"} | ${value("ttfb")} | ${value("loaded")} | ${scenario === "resume" ? `${value("transfer")} / ${value("decoded")}` : "-"} | ${value("hello")} | ${scenario === "scripts" ? `${value("staticTransfer")} / ${value("staticDecoded")}` : "-"} |`,
            );
        }
        console.log(
            "\nPer-kind medians (decoded member bytes; whole-answer compression omission delta, possibly negative):",
        );
        console.log("| Scenario | Member | Decoded B | Omission delta B |");
        console.log("| --- | --- | ---: | ---: |");
        const kindMedian = (scenario, kind, key) =>
            median((samples[scenario] ?? []).map((sample) => sample.kinds?.[kind]?.[key]));
        for (const scenario of ["cold", "warm", "send", "otherDevice", "selfEdit"]) {
            const kinds = Object.keys(samples[scenario]?.[0]?.kinds ?? {});
            for (const kind of kinds) {
                const decoded = kindMedian(scenario, kind, "decoded");
                const omission = kindMedian(scenario, kind, "omission");
                if (
                    !["cold", "warm"].includes(scenario) &&
                    decoded === kindMedian("warm", kind, "decoded") &&
                    omission === kindMedian("warm", kind, "omission")
                )
                    continue;
                console.log(`| ${scenario} | ${kind} | ${decoded} | ${omission} |`);
            }
        }
        await browser.close();
        browser = null;
        await stopServer();
        const { createResourceStore } = await import(path.join(repoRoot, "server/src/data/resourceStore.ts"));
        const { createKindRegistry, DEFAULT_RESOURCE_KINDS } = await import(
            path.join(repoRoot, "server/src/data/kinds.ts")
        );
        const file = path.join(workDir, "save/data/resources.sqlite");
        if (!existsSync(file)) throw new Error(`Missing measurement store: ${file}`);
        const filesystem = await statfs(workDir);
        const storage =
            filesystem.type === 0x01021994
                ? "temp-dir SQLite on tmpfs (memory-backed)"
                : `temp-dir SQLite (filesystem type 0x${filesystem.type.toString(16)})`;
        const store = createResourceStore({ file, kinds: createKindRegistry(DEFAULT_RESOURCE_KINDS) });
        try {
            const direct = [];
            let summaries;
            for (let i = 0; i < 8; i++) {
                const start = performance.now();
                summaries = store.readKinds([], { chatSummaries: true });
                direct.push(performance.now() - start);
            }
            check(
                "direct readSummaries: all seeded chats read",
                summaries.chatSummaries.length === fixture.chats.length,
            );
            console.log(
                `readSummaries direct: first ${direct[0].toFixed(2)} ms, subsequent median ${median(direct.slice(1)).toFixed(2)} ms (7 calls); ${storage}, ${file}`,
            );
            console.log("| Summary measurement | ms |");
            console.log("| --- | ---: |");
            console.log(
                `| HTTP incremental cost (estimate; 7 paired identity TTFBs) | ${median(summaryCosts).toFixed(2)} |`,
            );
            console.log(`| Direct first call (${storage}) | ${direct[0].toFixed(2)} |`);
            console.log(`| Direct subsequent median (7 calls) | ${median(direct.slice(1)).toFixed(2)} |`);
        } finally {
            store.close();
        }

        const denied = external.filter((href) => !EXPECTED_HOSTS.includes(new URL(href).hostname));
        check("no unexpected outbound request", denied.length === 0, denied.length === 0 ? undefined : denied);
        check("no page error", pageErrors.length === 0, pageErrors.length === 0 ? undefined : pageErrors);
    } catch (error) {
        console.error(error);
        results.push(false);
    } finally {
        try {
            await browser?.close();
        } finally {
            await stopServer();
            await new Promise((resolve) => provider.close(resolve));
            await rm(workDir, { recursive: true, force: true });
        }
    }
    const failed = results.filter((ok) => !ok).length;
    console.log(
        failed === 0 ? `\nall ${results.length} checks passed` : `\n${failed} of ${results.length} checks failed`,
    );
    process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await measureBoot();
