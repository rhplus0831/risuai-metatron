// Measurement for the boot resource cache: the boot read on a server shaped like the reported one
// (synthetic data: 14 modules of ~9.3k asset tuples of ~125 bytes each (130k in all), 18 characters
// of ~250 KB with one chat each, 50 presets: a ~21.6 MB plain read), over a throttled network.
//
// Against the production build (`pnpm build` first: the server serves `dist/`), in headless Chrome,
// with the page's network throttled through CDP (`THROTTLE_MBPS`, default 10, both ways; `LATENCY_MS`,
// default 40; `THROTTLE_MBPS=0` turns throttling off), the server on `PORT` (default 6264). The
// browser's HTTP cache stays on (no request routing), as in a real reload. The scenarios, each `RUNS`
// times (default 3):
// - `plain`: the boot request blocked (the app falls back to the plain read) and every request sent
//   with `Accept-Encoding: identity` (CDP extra headers): the uncompressed fallback baseline, close
//   to the boot before the boot cache;
// - `cold`: the boot cache deleted, then a reload: the boot request claims nothing, compressed answer;
// - `warm`: a reload with the cache the previous boot wrote, nothing changed on the server;
// - `module`: one module's assets edited through the routes, then a reload;
// - `character`: one character's description edited through the routes, then a reload.
// Per boot: the read's transferred and decoded bytes and its time (resource timing), the time to the
// main screen (the loading screen gone, from navigation start), the IndexedDB read (`risu-boot-cache:read-start`
// → `:read`) and write (`:write-start` → `:written`) times. Medians are printed per scenario.
//
// The checks, per cached boot: the boot route answered with no fallback read, and the cache was read
// and written; the boot request the tab sent is the one the cache the tab wrote gives
// (`prepareBootRequest` on the IndexedDB contents read back from the page), and that answer expanded
// against those contents in Node (`expandBootAnswer`) equals a plain read, text for text (an answer
// over Chrome's 10 MB body buffer is fetched again with the same request); what the tab then wrote to
// IndexedDB (texts captured from its own expanded snapshot) equals a plain read record for record; the
// `warm` boot claims every character, the modules and presets records, and every module's hash; no
// page error, no page request to a host other than the four blocked ones. If the port is taken, the
// script refuses to start.
//
// Usage: pnpm build && node util/playwright/measureBoot.mjs
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { chromePath, repoRoot } from "./stack.mjs";

const { checkCacheMeta, checkCachedRecord, expandBootAnswer, isCurrentMeta, itemKey, prepareBootRequest } =
    await import(path.join(repoRoot, "src/ts/storage/bootCache.ts"));
const { BOOT_CACHED_KINDS, RESOURCE_KIND } = await import(path.join(repoRoot, "shared/resources.ts"));
const { bootItemHash } = await import(path.join(repoRoot, "server/src/routes/resourceBoot.ts"));

const RUNS = Number(process.env.RUNS ?? 3);
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

// The reported shape: tuples of [name ~38, "assets/<64 hex>.png", ext], all unique.
const hex = (seed) => createHash("sha256").update(seed).digest("hex");
const assetTuples = (prefix, count) =>
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

// A server left on the port (an interrupted run) would answer in place of this one.
if (
    await fetch(`${base}/api/test_auth`).then(
        () => true,
        () => false,
    )
) {
    console.error(`Port ${port} is in use: stop the process listening there first.`);
    process.exit(1);
}
const workDir = await mkdtemp(path.join(os.tmpdir(), "risu-measure-boot-"));
await symlink(path.join(repoRoot, "public"), path.join(workDir, "public"), "dir");
await symlink(dist, path.join(workDir, "dist"), "dir");
await copyFile(path.join(repoRoot, "version.json"), path.join(workDir, "version.json"));
const server = spawn(process.execPath, [path.join(repoRoot, "server/src/main.ts")], {
    cwd: workDir,
    env: { ...process.env, PORT: String(port) },
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
                if (response.status && server.exitCode === null && server.signalCode === null && !serverError) return;
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

try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    await waitForServer();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // The main screen: the loading screen (`App.svelte`, `!$loadedStore`) seen, then gone; from
    // navigation start. Polled per frame until then.
    await context.addInitScript(() => {
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
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const blockHosts = (paths = []) =>
        cdp.send("Network.setBlockedURLs", {
            urls: [...EXPECTED_HOSTS.map((host) => `*://${host}/*`), ...paths.map((p) => `*://localhost:${port}${p}`)],
        });
    await blockHosts();
    // The page's requests to other hosts (the four blocked ones are expected). The server's own egress is
    // not watched: nothing in these scenarios asks it to fetch.
    const external = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.protocol.startsWith("http") && !LOCAL_HOSTS.has(url.hostname)) external.push(url.href);
    });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    let auth = null;
    let epoch = null;
    // The boot request and answer of the current boot.
    let boot = null;
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
        if (request.method() === "POST" && new URL(request.url()).pathname === BOOT_PATH) {
            boot = { request: JSON.parse(request.postData() ?? "null"), answer: null };
        }
    });
    page.on("response", (response) => {
        if (response.request().method() === "POST" && new URL(response.url()).pathname === BOOT_PATH && boot) {
            boot.answer = response.text().then(
                (text) => JSON.parse(text),
                () => null,
            );
        }
    });
    const api = async (p, init = {}) => {
        const r = await fetch(base + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
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
    const open = async () => {
        await page.goto(base);
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
            if (await page.evaluate(() => window.__risuLoaded !== undefined).catch(() => false)) return;
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
    const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const presets = await single("presets");
    const modules = await single("modules");
    const moduleList = Array.from({ length: 14 }, (_, i) => moduleData(i, i % 2 === 0 ? 9_100 : 9_493));
    const characters = Array.from({ length: 18 }, (_, i) => characterData(i));
    const presetList = Array.from({ length: 50 }, (_, i) => ({
        ...presets.data[0],
        id: i === 0 ? presets.data[0].id : randomUUID(),
        name: `Preset ${i}`,
        mainPrompt: `The main prompt of preset ${i}. `.repeat(400),
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
                { kind: "modules", id: "main", baseRevision: modules?.revision ?? null, data: moduleList },
                ...characters.map((data) => ({ kind: "characters", id: data.chaId, baseRevision: null, data })),
            ],
            chats: characters.map((data) => ({
                characterId: data.chaId,
                chatId: `${data.chaId}-chat`,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: { id: `${data.chaId}-chat`, name: "Chat 1", note: "", localLore: [], message: [] },
                    },
                ],
            })),
            chatOrders: [],
        }),
    });
    check("seed: stored", seeded.status === 200, seeded.status === 200 ? undefined : seeded);
    const plainBytes = Buffer.byteLength(await plainRead());
    console.log(
        `plain read body: ${mb(plainBytes)} (modules ${mb(Buffer.byteLength(JSON.stringify(moduleList)))}, ` +
            `characters ${mb(Buffer.byteLength(JSON.stringify(characters)))}, presets ${mb(Buffer.byteLength(JSON.stringify(presetList)))})`,
    );
    // Boot once unthrottled so the app's own first-boot writes (defaults, chats) are done.
    await page.reload();
    await page.waitForFunction(() => window.__risuLoaded !== undefined, null, { timeout: 120_000 });
    await page.waitForTimeout(3000);

    if (THROTTLE_MBPS > 0) {
        const bytesPerSecond = (THROTTLE_MBPS * 1e6) / 8;
        await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: LATENCY_MS,
            downloadThroughput: bytesPerSecond,
            uploadThroughput: bytesPerSecond,
        });
    }

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
    const bootOnce = async (scenario, { expectWrite = true } = {}) => {
        const before = await readCache();
        boot = null;
        await page.reload();
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
        const metrics = await page.evaluate(
            ({ plainPath, bootPath }) => {
                const mark = (name) => performance.getEntriesByName(name)[0]?.startTime ?? null;
                const span = (from, to) => (mark(from) === null || mark(to) === null ? null : mark(to) - mark(from));
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
        };
        (samples[scenario] ??= []).push(sample);
        console.log(
            `${scenario}: main screen ${ms(sample.loaded)}, ${sample.path} ${mb(sample.transfer)} on the wire ` +
                `(${mb(sample.decoded)} decoded) in ${ms(sample.readTime)} (server ${ms(sample.waiting)}), ` +
                `IndexedDB read ${ms(sample.cacheRead)}, write ${ms(sample.cacheWrite)}; the boot read starts at ` +
                `${ms(sample.bootStart)}, ${metrics.otherCount} other requests before the main screen ${mb(sample.otherBytes)}`,
        );
        if (scenario !== "plain") {
            check(
                `${scenario}: the boot route answered, no fallback read, the cache was read and written`,
                metrics.reads.length === 1 && read.path === BOOT_PATH && metrics.cacheRead !== null && metrics.written,
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
                // Chrome keeps no response body over its 10 MB per-resource buffer (a cold boot's
                // answer): the same request is sent again (the server has not changed since).
                const answer =
                    (await boot?.answer) ??
                    (await api(BOOT_PATH, { method: "POST", body: JSON.stringify(boot?.request) })).body;
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
    await blockHosts([BOOT_PATH]);
    await cdp.send("Network.setExtraHTTPHeaders", { headers: { "Accept-Encoding": "identity" } });
    for (let run = 0; run < RUNS; run++) await bootOnce("plain", { expectWrite: false });
    await cdp.send("Network.setExtraHTTPHeaders", { headers: {} });
    await blockHosts();
    const plainEncodings = samples.plain.map((sample) => sample.transfer >= plainBytes);
    check("plain: the read was uncompressed", plainEncodings.every(Boolean));

    for (let run = 0; run < RUNS; run++) {
        await deleteCache();
        await bootOnce("cold");
    }
    for (let run = 0; run < RUNS; run++) await bootOnce("warm");
    for (let run = 0; run < RUNS; run++) {
        const current = await single("modules");
        const data = structuredClone(current.data);
        data[run].assets.push(...assetTuples(`edit${run}`, 1));
        const edited = await api("/api/resources/modules/main", {
            method: "PUT",
            body: JSON.stringify({ baseRevision: current.revision, data }),
        });
        check(`module edit ${run}: stored`, edited.status === 200, edited.status === 200 ? undefined : edited);
        await bootOnce("module");
    }
    for (let run = 0; run < RUNS; run++) {
        const id = characters[run].chaId;
        const current = (await api(`/api/resources/characters/${id}`)).body;
        const edited = await api(`/api/resources/characters/${id}`, {
            method: "PUT",
            body: JSON.stringify({
                baseRevision: current.revision,
                data: { ...current.data, desc: `${current.data.desc} Edited ${run}.` },
            }),
        });
        check(`character edit ${run}: stored`, edited.status === 200, edited.status === 200 ? undefined : edited);
        await bootOnce("character");
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
        await rm(workDir, { recursive: true, force: true });
    }
}
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? `\nall ${results.length} checks passed` : `\n${failed} of ${results.length} checks failed`);
process.exit(failed === 0 ? 0 : 1);
