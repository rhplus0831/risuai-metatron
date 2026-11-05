// Manual plugin data costs in headless system Chrome against an isolated dev stack.
// Reuses measureBoot's audit fixture: 300 characters, 3,000 chats, 20 modules, 50 presets,
// ten disabled ~100 KiB plugins and ~2 MiB plugin history, plus one enabled measurement plugin.
// Order: fresh load, getDatabase() cold/second; fresh load, getDatabase(["characters"])
// cold/second; small pluginStorage write; UI-equivalent plugin toggle; developer recorder check.
// Cold means the first database call after boot, with the real db permission pre-granted.
// Each read reports guest wall time, POST /api/resources/read counts and body bytes, CDP
// loadingFinished encoded response bytes (including headers), and dataReceived decoded bytes.
// No response bodies are fetched through CDP/Playwright. Heap is Runtime.getHeapUsage usedSize,
// sampled about every 50 ms, with collectGarbage before each baseline. An OOPIF is sampled on
// its own target; an in-process iframe shares the page heap. Sampling can miss short peaks.
// Writes count every POST /api/resources/... except read/boot from invocation through flushResources.
// Output is Markdown tables and one JSON line; failures exit nonzero. All data is temporary.
// SERVER_PORT=6266 VITE_PORT=5366 (must be free); RISU_CHROME=/usr/bin/google-chrome;
// DEBUG=1 prints server/Vite output. Only one dev stack may run on the machine at a time.
// Usage: node util/playwright/measurePluginData.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import { seedBootFixture } from "./measureBoot.mjs";
import { chromePath, isolateContext, openApp, startStack, unexpectedEgress } from "./stack.mjs";

function messageSignature(messages) {
    const text = JSON.stringify(messages.map(({ chatId, role, data, time }) => [chatId, role, data, time]));
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return [messages.length, hash >>> 0];
}
const pluginName = "BrowserPluginDataMeasurement";
const storageKey = "browserMeasurementCounter";
const pluginScript = `//@name ${pluginName}
//@api 3.0
const signature = ${messageSignature.toString()};
globalThis.__pluginDataMeasurement = {
    result: null,
    async read(includeOnly) {
        const start = performance.now();
        const result = includeOnly === null ? await risuai.getDatabase() : await risuai.getDatabase(includeOnly);
        const wallMs = performance.now() - start;
        this.result = result;
        return wallMs;
    },
    check() {
        if (!Array.isArray(this.result?.characters)) throw new Error('getDatabase returned no characters');
        return {
            characters: this.result.characters.map(character => character.chaId).sort(),
            chats: this.result.characters.flatMap(character => {
                if (!Array.isArray(character.chats)) throw new Error('Missing character chats');
                return character.chats.map(chat => [character.chaId + '/' + chat.id, ...signature(chat.message)]);
            }).sort((a, b) => a[0].localeCompare(b[0])),
        };
    },
    write() { return risuai.pluginStorage.setItem('${storageKey}', 1); },
    async recordAccess() {
        const result = await risuai.getDatabase(['characters']);
        void result.characters[0].chats;
    },
};
`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, read, predicate = Boolean, timeout = 120_000) {
    let last;
    for (const end = Date.now() + timeout; Date.now() < end;) {
        last = await read();
        if (predicate(last)) return last;
        await delay(50);
    }
    throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}
async function requireFreePort(port) {
    const listener = createServer();
    await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, resolve);
    });
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
}

// Listen on the page target, where resource requests originate, retaining only counters/metadata.
async function resourceTraffic(session) {
    let active;
    const pending = new Map();
    await session.send("Network.enable", { maxPostDataSize: 100 * 1024 * 1024 });
    session.on("Network.requestWillBeSent", ({ requestId, request }) => {
        const route = new URL(request.url).pathname;
        if (!active || request.method !== "POST" || !route.startsWith("/api/resources/")) return;
        const entry = {
            route,
            requestBytes: Buffer.byteLength(request.postData ?? ""),
            encodedResponseBytes: 0,
            decodedResponseBytes: 0,
            finished: false,
        };
        assert(!request.hasPostData || request.postData !== undefined, `CDP omitted request body: ${route}`);
        active.push(entry);
        pending.set(requestId, entry);
    });
    session.on("Network.dataReceived", ({ requestId, dataLength }) => {
        const entry = pending.get(requestId);
        if (entry) entry.decodedResponseBytes += dataLength;
    });
    session.on("Network.responseReceived", ({ requestId, response }) => {
        const entry = pending.get(requestId);
        if (entry) entry.status = response.status;
    });
    session.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
        const entry = pending.get(requestId);
        if (!entry) return;
        entry.encodedResponseBytes = encodedDataLength;
        entry.finished = true;
        pending.delete(requestId);
    });
    session.on("Network.loadingFailed", ({ requestId, errorText }) => {
        const entry = pending.get(requestId);
        if (!entry) return;
        entry.error = errorText;
        entry.finished = true;
        pending.delete(requestId);
    });
    return {
        begin() {
            assert(!active, "Traffic measurement already active");
            active = [];
        },
        async end() {
            const entries = active;
            await until("resource responses finished", () => entries.every((entry) => entry.finished));
            active = null;
            for (const entry of entries) {
                assert(!entry.error, `${entry.route}: ${entry.error}`);
                assert.equal(entry.status, 200, `${entry.route}: HTTP ${entry.status}`);
            }
            return entries;
        },
    };
}
async function heapTargets(context, pageSession, frame) {
    const targets = [{ name: "page", session: pageSession }];
    let iframeSession;
    try {
        iframeSession = await context.newCDPSession(frame);
    } catch (error) {
        if (!error.message.includes("does not have a separate CDP session")) throw error;
        return { targets, iframe: "in process (shares page heap)", close: async () => {} };
    }
    const pageId = (await pageSession.send("Target.getTargetInfo")).targetInfo.targetId;
    const frameId = (await iframeSession.send("Target.getTargetInfo")).targetInfo.targetId;
    if (pageId !== frameId) targets.push({ name: "plugin iframe", session: iframeSession });
    return {
        targets,
        iframe: pageId === frameId ? "in process (shares page heap)" : "out of process (separate heap)",
        close: () => iframeSession.detach(),
    };
}
async function sampleHeap(targets, call) {
    for (const { session } of targets) await session.send("HeapProfiler.collectGarbage");
    const heaps = await Promise.all(
        targets.map(async ({ name, session }) => {
            const { usedSize } = await session.send("Runtime.getHeapUsage");
            return { target: name, baselineUsedSize: usedSize, peakUsedSize: usedSize, samples: 1 };
        }),
    );
    let sampling = true;
    let wake;
    const sample = async () => {
        await Promise.all(
            targets.map(async ({ session }, index) => {
                const { usedSize } = await session.send("Runtime.getHeapUsage");
                heaps[index].peakUsedSize = Math.max(heaps[index].peakUsedSize, usedSize);
                heaps[index].samples++;
            }),
        );
    };
    const sampler = (async () => {
        while (sampling) {
            await sample();
            if (sampling)
                await new Promise((resolve) => {
                    wake = resolve;
                    const timer = setTimeout(resolve, 50);
                    wake = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                });
        }
    })();
    try {
        const result = await call();
        await sample();
        return { result, heaps };
    } finally {
        sampling = false;
        wake?.();
        await sampler;
    }
}
const sum = (entries, key) => entries.reduce((total, entry) => total + entry[key], 0);
const writeRoute = (route) => route !== "/api/resources/read" && route !== "/api/resources/boot";

let stack;
let browser;
let blocked = [];
const errors = [];
const recorderLines = [];
const serverTail = [];
let stage = "setup";
try {
    const serverPort = Number(process.env.SERVER_PORT ?? 6266);
    const vitePort = Number(process.env.VITE_PORT ?? 5366);
    await Promise.all([requireFreePort(serverPort), requireFreePort(vitePort)]);
    stack = await startStack({
        serverPort,
        vitePort,
        log: (line) => {
            serverTail.push(line);
            if (serverTail.length > 100) serverTail.shift();
            if (process.env.DEBUG) process.stderr.write(line);
        },
    });
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    blocked = await isolateContext(context);
    await context.addInitScript(() => {
        // Opaque-origin sandbox documents cannot access localStorage.
        if (window === window.top) localStorage.removeItem("risu.safeBoot.attempts");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
        if (message.type() === "log" && message.text().startsWith(`[RisuAI Plugin: ${pluginName}] getDatabase #`))
            recorderLines.push(message.text());
    });
    let auth;
    let epoch;
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
    });
    page.on("response", (response) => {
        if (response.headers()["x-resource-epoch"]) epoch = response.headers()["x-resource-epoch"];
    });
    async function api(route, options = {}) {
        // Readback uses identity HTTP directly; it never enters the measured browser traffic.
        return new Promise((resolve, reject) => {
            const request = httpRequest(
                stack.serverURL + route,
                {
                    method: options.method ?? "GET",
                    agent: false,
                    headers: {
                        "risu-auth": auth,
                        "x-resource-epoch": epoch,
                        "content-type": "application/json",
                        "accept-encoding": "identity",
                    },
                },
                (response) => {
                    const chunks = [];
                    response.on("data", (chunk) => chunks.push(chunk));
                    response.on("error", reject);
                    response.on("end", () => {
                        try {
                            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                            if (body.epoch) epoch = body.epoch;
                            resolve({ status: response.statusCode, body });
                        } catch (error) {
                            reject(error);
                        }
                    });
                },
            );
            request.on("error", reject);
            request.setTimeout(120_000, () => request.destroy(new Error(`${route}: HTTP timeout`)));
            request.end(options.body);
        });
    }
    async function post(route, body) {
        const response = await api(route, { method: "POST", body: JSON.stringify(body) });
        assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body).slice(0, 1000)}`);
        return response.body;
    }
    async function single(kind) {
        const response = await api(`/api/resources/${kind}/main`);
        assert.equal(response.status, 200, `Missing ${kind}: HTTP ${response.status}`);
        return response.body;
    }
    async function flush() {
        const result = await page.evaluate(async () => {
            const { flushResources } = await import("/src/ts/storage/resourceSync.svelte.ts");
            return flushResources();
        });
        assert.deepEqual(result, { discarded: [], refused: [] }, "Resource writes did not settle cleanly");
    }
    async function sandbox() {
        return until("measurement plugin sandbox", async () => {
            for (const frame of page.frames()) {
                if (await frame.evaluate(() => !!globalThis.__pluginDataMeasurement).catch(() => false)) return frame;
            }
            return null;
        });
    }
    async function reload() {
        await openApp(page, stack.baseURL);
        const frame = await sandbox();
        await flush();
        return frame;
    }
    await openApp(page, stack.baseURL);
    await until("authenticated resource request", () => auth && epoch);
    await flush();
    stage = "seed";
    const fixture = await seedBootFixture(api, "audit");
    const plugins = await single("plugins");
    const ui = await single("ui");
    const permissionResponse = await api("/api/resources/pluginPermissions/main");
    assert([200, 404].includes(permissionResponse.status), "Could not read plugin permissions");
    const permissions =
        permissionResponse.status === 404
            ? { revision: null, data: { grants: {}, lastGrantTime: {} } }
            : permissionResponse.body;
    const grant = createHash("sha256").update(pluginScript).digest("hex") + "_db";
    await post("/api/resources/batch", {
        ops: [
            {
                kind: "plugins",
                id: "main",
                baseRevision: plugins.revision,
                data: [
                    ...plugins.data,
                    {
                        name: pluginName,
                        script: pluginScript,
                        version: "3.0",
                        enabled: true,
                        realArg: {},
                        arguments: {},
                        argMeta: {},
                        customLink: [],
                    },
                ],
            },
            { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, enableDevTools: false } },
            {
                kind: "pluginPermissions",
                id: "main",
                baseRevision: permissions.revision,
                // Seed the same script hash and periodic timestamp the real consent flow persists.
                data: {
                    grants: { ...permissions.data.grants, [grant]: true },
                    lastGrantTime: {
                        ...permissions.data.lastGrantTime,
                        [`${pluginName}_db_lastGrantTime`]: Date.now(),
                    },
                },
            },
        ],
    });
    const expected = {
        characters: fixture.characters.map(({ chaId }) => chaId).sort(),
        chats: fixture.chats
            .map(({ characterId, chat }) => [`${characterId}/${chat.id}`, ...messageSignature(chat.message)])
            .sort((a, b) => a[0].localeCompare(b[0])),
    };
    assert.equal(expected.characters.length, 300);
    assert.equal(expected.chats.length, 3000);
    // Check the server independently of both the fixture writer and the plugin's read path.
    assert.equal((await single("plugins")).data.length, 11);
    assert.deepEqual((await single("plugins")).data.slice(0, 10), fixture.plugins);
    assert.deepEqual((await single("pluginStorage")).data, fixture.pluginStorage);
    assert.deepEqual(
        (await single("modules")).data.map(({ id }) => id),
        fixture.modules.map(({ id }) => id),
    );
    assert.deepEqual(
        (await single("presets")).data.map(({ id }) => id),
        fixture.presets.map(({ id }) => id),
    );
    const stored = { characters: [], chats: [] };
    let remaining = {
        refs: expected.characters.map((id) => ({ kind: "characters", id })),
        chatCollections: expected.characters,
    };
    while (remaining.refs.length || remaining.chatCollections.length) {
        const answer = await post("/api/resources/read", { ...remaining, continue: true });
        stored.characters.push(
            ...answer.items.filter(({ kind }) => kind === "characters").map(({ data }) => data.chaId),
        );
        for (const collection of answer.chatCollections ?? [])
            for (const chat of collection.chats)
                stored.chats.push([`${collection.characterId}/${chat.id}`, ...messageSignature(chat.data.message)]);
        const next = answer.unanswered ?? { refs: [], chatCollections: [] };
        assert(
            next.refs.length + next.chatCollections.length < remaining.refs.length + remaining.chatCollections.length,
            "Seed readback made no progress",
        );
        remaining = next;
    }
    stored.characters.sort();
    stored.chats.sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(stored, expected, "Seed characters/chats/messages did not reach the server");
    console.log(
        "PASS seed stored (300 characters, 3,000 chats with messages, 20 modules, 50 presets, 11 plugins, plugin history)",
    );

    const pageSession = await context.newCDPSession(page);
    const traffic = await resourceTraffic(pageSession);
    const reads = [];
    for (const includeOnly of [null, ["characters"]]) {
        let frame = await reload();
        const heap = await heapTargets(context, pageSession, frame);
        try {
            for (const temperature of ["cold", "second"]) {
                stage = `${includeOnly === null ? "getDatabase()" : 'getDatabase(["characters"])'} ${temperature}`;
                await frame.evaluate(() => {
                    globalThis.__pluginDataMeasurement.result = null;
                });
                const { result: wallMs, heaps } = await sampleHeap(heap.targets, async () => {
                    traffic.begin();
                    return frame.evaluate((include) => globalThis.__pluginDataMeasurement.read(include), includeOnly);
                });
                const requests = (await traffic.end()).filter(({ route }) => route === "/api/resources/read");
                const actual = await frame.evaluate(() => globalThis.__pluginDataMeasurement.check());
                assert.deepEqual(actual, expected, `${stage}: incomplete characters/chats/messages`);
                reads.push({
                    call: includeOnly === null ? "getDatabase()" : 'getDatabase(["characters"])',
                    temperature,
                    wallMs,
                    readRequests: requests.length,
                    requestBytes: sum(requests, "requestBytes"),
                    encodedResponseBytes: sum(requests, "encodedResponseBytes"),
                    decodedResponseBytes: sum(requests, "decodedResponseBytes"),
                    iframe: heap.iframe,
                    heaps,
                });
            }
        } finally {
            await heap.close();
        }
    }
    assert.equal(recorderLines.length, 0, "Recorder ran with Dev Tools off");
    const writes = [];
    async function measureWrite(name, call) {
        stage = name;
        await flush();
        traffic.begin();
        await call();
        await flush();
        const requests = (await traffic.end()).filter(({ route }) => writeRoute(route));
        assert(requests.length > 0, `${name}: no resource save requests`);
        writes.push({
            call: name,
            requests: requests.map(({ route, requestBytes }) => ({ route, requestBytes })),
            requestBytes: sum(requests, "requestBytes"),
        });
    }
    let frame = await sandbox();
    await frame.evaluate(() => {
        globalThis.__pluginDataMeasurement.result = null;
    });
    await measureWrite("pluginStorage.setItem", () => frame.evaluate(() => globalThis.__pluginDataMeasurement.write()));
    const storage = (await single("pluginStorage")).data;
    assert.equal(
        storage._ownedPluginStorage[`${pluginName}\u0000${storageKey}`],
        1,
        "setItem did not reach the server",
    );
    assert.deepEqual(
        storage._pluginStorage.history,
        fixture.pluginStorage._pluginStorage.history,
        "setItem lost history",
    );
    await measureWrite("plugin enabled toggle", () =>
        page.evaluate(async () => {
            const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
            const { loadPlugins } = await import("/src/ts/plugins/plugins.svelte.ts");
            const i = settings.plugins.findIndex((plugin) => plugin.name === "Plugin 0");
            if (i < 0) throw new Error("Fixture plugin missing");
            const plugin = settings.plugins[i];
            plugin.enabled = !plugin.enabled;
            settings.plugins[i] = plugin;
            await loadPlugins();
        }),
    );
    assert.equal(
        (await single("plugins")).data.find((plugin) => plugin.name === "Plugin 0").enabled,
        true,
        "Plugin toggle did not reach the server",
    );
    console.log("PASS writes read back from server (small storage key, retained history, enabled toggle)");

    stage = "developer recorder";
    await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.enableDevTools = true;
    });
    await flush();
    frame = await reload();
    const consoleStart = recorderLines.length;
    await frame.evaluate(() => globalThis.__pluginDataMeasurement.recordAccess());
    await until("one recorder console line", () => recorderLines.length > consoleStart);
    // A second quiet period catches duplicate timers or an unwanted update without further accesses.
    await delay(2200);
    const lines = recorderLines.slice(consoleStart);
    assert.equal(lines.length, 1, `Expected one recorder line: ${JSON.stringify(lines)}`);
    assert(
        lines[0].includes('includeOnly=["characters"]') &&
            lines[0].includes('keys=["characters"]') &&
            lines[0].includes("characters[i].chats touched=true; characters=1"),
        lines[0],
    );
    console.log(`PASS recorder: ${lines[0]}`);
    assert.deepEqual(errors, [], "Browser page errors");
    const denied = await stack.deniedEgress();
    assert.deepEqual(unexpectedEgress(blocked, denied), [], "Unexpected egress");
    console.log(
        `PASS page errors and egress (${blocked.length} expected browser requests blocked, ${denied.length} expected server attempts denied)`,
    );
    console.log(
        'Order: fresh load → getDatabase() cold → second; fresh load → getDatabase(["characters"]) cold → second; storage write; toggle; recorder. GC before every heap baseline.',
    );
    console.log(
        "Bytes are integers; encoded response bytes include headers; heap is sampled usedSize, not allocation totals.",
    );
    for (const read of reads) console.log(`Iframe for ${read.call} ${read.temperature}: ${read.iframe}.`);
    console.log(
        "| Call | Run | Guest ms | Read POSTs | Request bytes | Response encoded bytes | Response decoded bytes | Heap target | Baseline bytes | Peak bytes |",
    );
    console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |");
    for (const read of reads) {
        for (const heap of read.heaps)
            console.log(
                `| ${read.call} | ${read.temperature} | ${read.wallMs.toFixed(2)} | ${read.readRequests} | ${read.requestBytes} | ${read.encodedResponseBytes} | ${read.decodedResponseBytes} | ${heap.target} | ${heap.baselineUsedSize} | ${heap.peakUsedSize} |`,
            );
    }
    console.log("\n| Write | Save POSTs | Route(s) | Request bytes |\n| --- | ---: | --- | ---: |");
    for (const write of writes)
        console.log(
            `| ${write.call} | ${write.requests.length} | ${[...new Set(write.requests.map(({ route }) => route))].join(", ")} | ${write.requestBytes} |`,
        );
    console.log(
        JSON.stringify({
            reads,
            writes,
            recorder: lines,
            checks: { seed: true, messages: true, writes: true, pageErrors: errors, unexpectedEgress: [] },
        }),
    );
} catch (error) {
    process.exitCode = 1;
    console.error(`FAIL ${stage}: ${error.stack}`);
    console.error("Server/Vite tail:", serverTail.join("").slice(-5000));
} finally {
    try {
        assert.deepEqual(errors, [], "Browser page errors");
        if (stack) assert.deepEqual(unexpectedEgress(blocked, await stack.deniedEgress()), [], "Unexpected egress");
    } catch (error) {
        process.exitCode = 1;
        console.error(`FAIL final checks: ${error.message}`);
    } finally {
        await browser?.close();
        await stack?.stop();
    }
}
