// Walk asset ownership, orphan inlays, deletion, immutable browser caching, and snapshot restore
// on one isolated dev stack. Keep the default seven-day grace; advance only the development
// lifecycle clock, restarting to drop in-memory leases. Youth is a root: day 8 starts the asset
// ledger, and day 16 permits deletion. Removing the orphan record at day 8 lets both files go
// in the same day-16 sweep. Days 24 and 32 drop any leases from snapshot/restore UI rendering.
// No Playwright routes: routing disables the HTTP cache this check needs to observe.
//
// Usage: node util/playwright/checkAssetLifecycle.mjs [--server-port 6267] [--vite-port 5367]
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { ASSET_GRACE_DEFAULT_DAYS, ASSET_LEASE_MS } from "../../shared/assetLifecycle.ts";
import { chatBindingFixture } from "./modelProfiles.mjs";
import { chromePath, clearSafeBootAttempts, openApp, openCharacterChat, startStack } from "./stack.mjs";

const { values } = parseArgs({
    options: {
        "server-port": { type: "string", default: "6267" },
        "vite-port": { type: "string", default: "5367" },
    },
});
const DAY = 24 * 60 * 60 * 1000;
const GRACE = ASSET_GRACE_DEFAULT_DAYS * DAY;
const results = [];
const sweeps = [];
const serverLogs = [];
const browserErrors = [];
const requestStarts = new WeakMap();
const fixture = { a: randomUUID(), c: randomUUID(), chat: randomUUID(), inlay: randomUUID() };
let stack;
let browser;
let page;
let panel;
let auth;
let epoch;
let offset = 0;
let activeCase = "setup";
let imageURL;
let documentId;

async function until(read, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    let value;
    do {
        value = await read();
        if (value) return value;
        await delay(100);
    } while (Date.now() < deadline);
    throw new Error(`${label}: timed out; last=${JSON.stringify(value)}`);
}

async function settle() {
    let idlePolls = 0;
    await until(async () => {
        const idle = await page
            .evaluate(async () => (await import("/src/ts/storage/resourceSync.svelte.ts")).resourceSyncIdle())
            .catch(() => false);
        idlePolls = idle ? idlePolls + 1 : 0;
        return idlePolls >= 2;
    }, "resource sync idle on two polls");
}

async function api(route, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${stack.serverURL}${route}`, {
        method,
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    });
    assert(response.ok, `${method} ${route}: ${response.status} ${await response.clone().text()}`);
    const result = await response.json();
    if (result.epoch) epoch = result.epoch;
    return result;
}

async function resources(refs, chats = []) {
    return api("/api/resources/read", { method: "POST", body: { refs, chats } });
}

async function exists(file) {
    return stat(file).then(
        () => true,
        (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
        },
    );
}

const assetFile = (key) => path.join(stack.workDir, "save", key);
const candidates = (report) => report.unreferenced.candidates.map((item) => item.key);
const button = (name) => panel.getByRole("button", { name, exact: true });
const snapshotRow = (label) => panel.locator("li").filter({ has: page.getByText(label, { exact: true }) });

async function panelReady() {
    await until(() => button("Scan").isEnabled(), "Storage panel ready");
    assert.equal(await panel.getByRole("alert").count(), 0, await panel.innerText());
}

async function openStorage() {
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.SettingsMenuIndex.set(6);
        stores.settingsOpen.set(true);
    });
    panel = page.locator('[data-settings-section="advanced.storage"]');
    await panel.waitFor({ state: "visible" });
    await panelReady();
}

// Listen without intercepting: HTTP cache entries must survive all the way to the deletion case.
async function panelRequest(control, method, route, confirmation) {
    const responsePromise = page.waitForResponse(
        (response) => response.request().method() === method && new URL(response.url()).pathname === route,
    );
    // If a UI assertion fails before dispatch, cleanup closes the page before this listener settles.
    void responsePromise.catch(() => {});
    await control.click();
    if (confirmation) {
        await page.getByText(confirmation, { exact: typeof confirmation === "string" }).waitFor();
        await page.getByRole("button", { name: "YES", exact: true }).click();
    }
    const response = await responsePromise;
    await response.finished();
    const wallMs = Math.round((performance.now() - requestStarts.get(response.request())) * 100) / 100;
    const result = await response.json();
    if (route === "/api/assets/sweep") {
        const timing = { offsetDays: offset / DAY, wallMs, status: response.status(), ...result };
        sweeps.push(timing);
        console.log(`SWEEP ${JSON.stringify(timing)}`);
    }
    assert(response.ok(), `${method} ${route}: ${response.status()} ${JSON.stringify(result)}`);
    if (result.epoch) epoch = result.epoch;
    return result;
}

async function scan() {
    await panelReady();
    const before = await api("/api/assets/report");
    await panelRequest(button("Scan"), "POST", "/api/assets/scan");
    const report = await until(async () => {
        const value = await api("/api/assets/report");
        return !value.running && value.generatedAt !== before.generatedAt && value;
    }, "fresh complete scan");
    assert(report.complete, JSON.stringify(report.reasons));
    await panelReady();
    return report;
}

async function advance(days) {
    const next = days * DAY;
    assert(next - offset > GRACE + ASSET_LEASE_MS, "each clock step exceeds grace plus lease");
    await settle();
    await stack.restartServer({ serverEnv: { RISU_AGENT_DEV_ASSET_CLOCK_OFFSET_MS: String(next) } });
    offset = next;
    assert(serverLogs.join("").includes(`Development asset clock offset: ${offset} ms`), "server accepted offset");
    console.log(`CLOCK day ${days}: ${offset} ms; restart dropped in-memory leases`);
}

async function removeCharacter(id) {
    await settle();
    const state = await resources([
        { kind: "characters", id },
        { kind: "characterOrder", id: "main" },
    ]);
    const character = state.items.find((item) => item.kind === "characters" && item.id === id);
    const order = state.items.find((item) => item.kind === "characterOrder");
    assert(character?.revision, "character exists before deletion");
    await api("/api/resources/batch", {
        method: "POST",
        body: {
            ops: [
                { kind: "characters", id, baseRevision: character.revision, delete: true },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: order.data.filter((entry) => entry !== id),
                },
            ],
        },
    });
    const removed = await resources([{ kind: "characters", id }]);
    assert(
        removed.items.every((item) => item.id !== id || item.data === null),
        "character removed",
    );
}

async function removeUnpinnedSnapshots() {
    const removed = [];
    for (const snapshot of (await api("/api/backups")).items) {
        if (snapshot.pinned) continue;
        await api(`/api/backups/${snapshot.id}`, { method: "DELETE" });
        removed.push(snapshot.id);
    }
    assert((await api("/api/backups")).items.every((snapshot) => snapshot.pinned));
    console.log(`SNAPSHOTS removed unpinned: ${JSON.stringify(removed)}`);
}

async function loadImage(id) {
    return page.evaluate(
        async ({ id, url }) => {
            const img = new Image();
            img.id = id;
            const loaded = new Promise((resolve) => {
                img.onload = () => resolve(true);
                img.onerror = () => resolve(false);
            });
            img.src = url;
            document.body.append(img);
            return { loaded: await loaded, naturalWidth: img.naturalWidth, url: img.src };
        },
        { id, url: imageURL },
    );
}

async function runCase(name, run) {
    activeCase = name;
    const evidence = await run();
    results.push(true);
    console.log(`PASS ${name} ${JSON.stringify(evidence)}`);
}

try {
    assert(!process.env.RISU_ASSET_GRACE_DAYS?.trim(), "unset RISU_ASSET_GRACE_DAYS to check the default grace");
    process.env.CHOKIDAR_USEPOLLING ??= "1";
    stack = await startStack({
        serverPort: Number(values["server-port"]),
        vitePort: Number(values["vite-port"]),
        serverEnv: { RISU_HOST: "127.0.0.1", RISU_AGENT_DEV_ASSET_CLOCK_OFFSET_MS: "0" },
        log: (text) => {
            serverLogs.push(text);
            if (serverLogs.length > 500) serverLogs.shift();
        },
    });
    console.log(`STACK ${stack.serverURL} / ${stack.baseURL}; default grace ${ASSET_GRACE_DEFAULT_DAYS} days`);
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
    context.setDefaultTimeout(30_000);
    await clearSafeBootAttempts(context);
    page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(String(error)));
    page.on("requestfailed", (request) => {
        const url = new URL(request.url());
        browserErrors.push(`${url.origin}${url.pathname}: ${request.failure()?.errorText}`);
    });
    page.on("console", (message) => {
        if (message.type() === "error")
            browserErrors.push(message.text().replace(/risu-auth=[^&'\s]+/g, "risu-auth=<redacted>"));
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: ["https://*", "http://sv.risuai.xyz/*"] });
    page.on("request", (request) => {
        requestStarts.set(request, performance.now());
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
    });
    page.on("response", (response) => {
        const value = response.headers()["x-resource-epoch"];
        if (value) epoch = value;
    });
    await openApp(page, stack.baseURL);
    await settle();
    assert(auth && epoch, "authenticated resource session");

    await runCase("a: seed profile images and a chat naming an inlay (day 0)", async () => {
        const images = [];
        for (const [index, background] of ["#cb3545", "#32a865", "#395fc7"].entries()) {
            const bytes = await sharp({ create: { width: 96, height: 96, channels: 3, background } })
                .png()
                .toBuffer();
            const hash = createHash("sha256").update(bytes).digest("hex");
            const key = `assets/${index === 1 ? "inlay_" : ""}${hash}.png`;
            await api("/api/write", {
                method: "POST",
                headers: { "file-path": Buffer.from(key).toString("hex"), "content-type": "application/octet-stream" },
                body: bytes,
            });
            assert.deepEqual(await readFile(assetFile(key)), bytes);
            images.push({ key, bytes });
        }
        [fixture.profile, fixture.media, fixture.third] = images;
        const initial = await resources(
            ["ui", "characterOrder", "modelPresets", "presets", "personas"].map((kind) => ({ kind, id: "main" })),
        );
        const record = (kind) => initial.items.find((item) => item.kind === kind);
        const character = (id, name, image) => ({
            chaId: id,
            type: "character",
            name,
            image,
            firstMessage: "",
            desc: "",
            notes: "",
            chatFolders: [],
            emotionImages: [],
            bias: [],
            viewScreen: "none",
            globalLore: [],
            customscript: [],
            triggerscript: [],
            utilityBot: false,
            firstMsgIndex: -1,
        });
        await api("/api/resources/batch", {
            method: "POST",
            body: {
                ops: [
                    {
                        kind: "ui",
                        id: "main",
                        baseRevision: record("ui").revision,
                        data: { ...record("ui").data, language: "en", didFirstSetup: true, useLegacyGUI: false },
                    },
                    {
                        kind: "characterOrder",
                        id: "main",
                        baseRevision: record("characterOrder").revision,
                        data: [fixture.a, fixture.c],
                    },
                    {
                        kind: "characters",
                        id: fixture.a,
                        baseRevision: null,
                        data: character(fixture.a, "Lifecycle A", fixture.profile.key),
                    },
                    {
                        kind: "characters",
                        id: fixture.c,
                        baseRevision: null,
                        data: character(fixture.c, "Lifecycle C", fixture.third.key),
                    },
                    {
                        kind: "inlays",
                        id: fixture.inlay,
                        baseRevision: null,
                        data: {
                            name: "Lifecycle inlay",
                            type: "image",
                            ext: "png",
                            width: 96,
                            height: 96,
                            size: fixture.media.bytes.length,
                            asset: fixture.media.key,
                        },
                    },
                ],
                chats: [
                    {
                        characterId: fixture.a,
                        chatId: fixture.chat,
                        baseRevision: null,
                        ops: [
                            {
                                op: "create",
                                chat: {
                                    id: fixture.chat,
                                    name: "Lifecycle chat",
                                    fmIndex: -1,
                                    message: [
                                        {
                                            role: "char",
                                            data: `Media {{inlay::${fixture.inlay}}}`,
                                            chatId: randomUUID(),
                                        },
                                    ],
                                    ...chatBindingFixture(
                                        record("modelPresets"),
                                        record("presets"),
                                        record("personas"),
                                    ),
                                },
                            },
                        ],
                    },
                ],
            },
        });
        const readback = await resources(
            [
                { kind: "characters", id: fixture.a },
                { kind: "characters", id: fixture.c },
                { kind: "inlays", id: fixture.inlay },
            ],
            [{ characterId: fixture.a, id: fixture.chat }],
        );
        assert.equal(readback.items.find((item) => item.id === fixture.a).data.image, fixture.profile.key);
        assert.equal(readback.items.find((item) => item.id === fixture.c).data.image, fixture.third.key);
        assert.equal(readback.items.find((item) => item.id === fixture.inlay).data.asset, fixture.media.key);
        assert.equal(readback.chats[0].data.message[0].data, `Media {{inlay::${fixture.inlay}}}`);
        return { keys: images.map((image) => image.key), boundChat: fixture.chat };
    });

    await runCase("b: render A's direct image and populate its thumbnail directory", async () => {
        await openApp(page, stack.baseURL);
        await settle();
        await openCharacterChat(page, fixture.a);
        // The first dev-module import can trigger Vite dependency optimization and reload the tab.
        const source = async () =>
            page.evaluate(
                async (key) => (await import("/src/ts/globalApi.svelte.ts")).getFileSrc(key),
                fixture.profile.key,
            );
        try {
            imageURL = await source();
        } catch (error) {
            if (!/Execution context was destroyed/.test(String(error))) throw error;
            await openApp(page, stack.baseURL);
            await settle();
            imageURL = await source();
        }
        assert.equal(imageURL, `/api/asset/${Buffer.from(fixture.profile.key).toString("hex")}`);
        const rendered = await loadImage("lifecycle-original");
        assert(rendered.loaded && rendered.naturalWidth > 0, JSON.stringify(rendered));
        const immutable = await fetch(`${stack.serverURL}${imageURL}`, { headers: { "risu-auth": auth } });
        assert(immutable.ok);
        await immutable.arrayBuffer();
        assert.match(immutable.headers.get("cache-control"), /immutable/);
        const thumbnail = await fetch(`${stack.serverURL}${imageURL}?w=256`, { headers: { "risu-auth": auth } });
        assert(thumbnail.ok);
        await thumbnail.arrayBuffer();
        fixture.thumbnailDir = path.join(
            stack.workDir,
            "save/cache/thumbnails",
            createHash("sha256").update(fixture.profile.key).digest("hex"),
        );
        assert((await readdir(fixture.thumbnailDir)).length > 0, "thumbnail cache directory populated");
        documentId = randomUUID();
        await page.evaluate((id) => {
            window.__assetLifecycleDocument = id;
        }, documentId);
        return { ...rendered, cacheControl: immutable.headers.get("cache-control"), thumbnailDirectory: true };
    });

    await runCase("c: Storage Scan attributes profile and inlay media to A", async () => {
        await openStorage();
        const report = await scan();
        const owner = report.owners.find((item) => item.kind === "character" && item.id === fixture.a);
        assert.equal(owner?.count, 2, "A owns its profile and the inlay resolved through the message's id");
        assert.equal(owner.bytes, fixture.profile.bytes.length + fixture.media.bytes.length);
        const row = panel.getByRole("row").filter({ hasText: "Lifecycle A" });
        assert.equal(await row.count(), 1);
        assert.equal(await row.getByRole("cell").nth(2).innerText(), "2");
        assert.equal(await row.getByRole("cell").nth(3).innerText(), `${owner.bytes} B`);
        assert.equal(report.unreferenced.count, 0);
        assert.equal(report.orphanInlays.count, 0);
        return { owner, referenced: report.referenced.count };
    });

    await runCase("d: youth, orphan grace, and orphan removal through Storage", async () => {
        await removeCharacter(fixture.a);
        await removeUnpinnedSnapshots();
        let report = await scan();
        assert.equal(report.unreferenced.count, 0, "young A image is referenced, not unreferenced");
        assert.equal(report.unreferenced.pastGrace.count, 0);
        assert.equal(report.orphanInlays.count, 1);
        const orphanSince = report.orphanInlays.records[0].since;
        assert.equal(report.orphanInlays.records[0].id, fixture.inlay);
        assert(orphanSince + GRACE > report.generatedAt, "orphan is not yet deletable");
        assert(await button("Delete selected assets").isDisabled());
        assert(await exists(assetFile(fixture.profile.key)));
        console.log("OBSERVE day 0: A image young/referenced; orphan inlay listed but within grace");
        await advance(8);
        report = await scan();
        assert.equal(report.unreferenced.count, 1);
        assert.equal(report.unreferenced.bytes, fixture.profile.bytes.length);
        assert.deepEqual(candidates(report), [], "A's ledger grace starts only now");
        fixture.sinceA = report.generatedAt;
        assert.equal(report.orphanInlays.records[0].since, orphanSince);
        assert(orphanSince + GRACE <= report.generatedAt, "orphan past grace");
        await panel.locator(`input[value="${fixture.inlay}"]`).check();
        const removed = await panelRequest(
            button("Delete selected inlay records"),
            "POST",
            "/api/assets/sweep",
            "Delete 1 selected orphan inlay records?",
        );
        assert.deepEqual(removed.removedInlays, [fixture.inlay]);
        assert.deepEqual(removed.deleted, []);
        assert.deepEqual(removed.skippedInlays, []);
        report = await scan();
        assert.equal(report.orphanInlays.count, 0);
        assert.equal(report.unreferenced.count, 2);
        assert.equal(report.unreferenced.bytes, fixture.profile.bytes.length + fixture.media.bytes.length);
        assert.deepEqual(candidates(report), []);
        fixture.sinceMedia = report.generatedAt;
        const inlay = await resources([{ kind: "inlays", id: fixture.inlay }]);
        assert(
            inlay.items.every((item) => item.data === null),
            "orphan metadata removed",
        );
        return { offsetsDays: [0, 8], imageSince: fixture.sinceA, mediaSince: fixture.sinceMedia, deletableAssets: 0 };
    });

    await runCase("e: day-16 sweep deletes both media files; immutable cache survives until cleared", async () => {
        await advance(16);
        const report = await scan();
        assert.deepEqual(candidates(report).sort(), [fixture.profile.key, fixture.media.key].sort());
        assert.equal(
            report.unreferenced.candidates.find((item) => item.key === fixture.profile.key).since,
            fixture.sinceA,
        );
        assert.equal(
            report.unreferenced.candidates.find((item) => item.key === fixture.media.key).since,
            fixture.sinceMedia,
        );
        const expectedBytes = fixture.profile.bytes.length + fixture.media.bytes.length;
        const removed = await panelRequest(
            button("Delete selected assets"),
            "POST",
            "/api/assets/sweep",
            `Delete 2 selected asset files (${expectedBytes} B)?`,
        );
        assert.deepEqual(removed.deleted.sort(), [fixture.profile.key, fixture.media.key].sort());
        assert.equal(removed.freedBytes, expectedBytes);
        assert.deepEqual(removed.skipped, []);
        assert.equal(await exists(assetFile(fixture.profile.key)), false);
        assert.equal(await exists(assetFile(fixture.media.key)), false);
        assert.equal(await exists(fixture.thumbnailDir), false, "thumbnail directory removed with its source");
        assert.equal(
            await page.evaluate(() => window.__assetLifecycleDocument),
            documentId,
            "same open document since rendering A",
        );
        const cached = await loadImage("lifecycle-cached");
        assert(cached.loaded && cached.naturalWidth > 0, JSON.stringify(cached));
        await cdp.send("Network.clearBrowserCache");
        // Remove decoded image holders too, so a new element must consult the cleared HTTP cache.
        await page.locator("#lifecycle-original, #lifecycle-cached").evaluateAll((images) =>
            images.forEach((img) => {
                img.removeAttribute("src");
                img.remove();
            }),
        );
        const missingResponse = page.waitForResponse(
            (response) => new URL(response.url()).pathname === imageURL && response.status() === 404,
        );
        void missingResponse.catch(() => {});
        const missing = await loadImage("lifecycle-uncached");
        assert.equal((await missingResponse).status(), 404);
        assert.equal(missing.loaded, false);
        assert.equal(missing.naturalWidth, 0);
        return { deletedInSameSweep: 2, thumbnailDirectoryRemoved: true, cached, afterCacheClear: missing };
    });

    await runCase("f: pinned snapshot holds C, restores its bytes, and releases the last root", async () => {
        await panelReady();
        let label = "Lifecycle pinned C";
        await panel.getByRole("textbox", { name: "Optional snapshot label", exact: true }).fill(label);
        const taken = await panelRequest(button("Take snapshot"), "POST", "/api/backups/snapshot");
        const id = taken.snapshot.id;
        await panelReady();
        await panelRequest(
            snapshotRow(label).getByRole("button", { name: "Pin", exact: true }),
            "PATCH",
            `/api/backups/${id}`,
        );
        await panelReady();
        await snapshotRow(label).getByRole("button", { name: "Label", exact: true }).click();
        const newLabel = "Lifecycle retained C";
        await snapshotRow(label).getByRole("textbox", { name: "Label", exact: true }).fill(newLabel);
        await panelRequest(
            snapshotRow(label).getByRole("button", { name: "Save", exact: true }),
            "PATCH",
            `/api/backups/${id}`,
        );
        label = newLabel;
        assert.equal((await api("/api/backups")).items.find((item) => item.id === id).pinned, true);
        await removeCharacter(fixture.c);
        await removeUnpinnedSnapshots();
        // Old browser renders can lease C even after deletion. A restart removes those leases so
        // the snapshot's exclusive heldBytes, not recent use, proves what is keeping the file alive.
        await advance(24);
        let report = await scan();
        assert.equal(report.unreferenced.count, 0);
        assert(!candidates(report).includes(fixture.third.key));
        const held = report.snapshots.find((snapshot) => snapshot.id === id);
        assert.equal(held.pinned, true);
        assert.equal(held.heldBytes, fixture.third.bytes.length);
        assert.equal(await snapshotRow(label).getByText(`${held.heldBytes} B`, { exact: true }).count(), 1);
        assert.deepEqual(await readFile(assetFile(fixture.third.key)), fixture.third.bytes);
        await panelRequest(
            snapshotRow(label).getByRole("button", { name: "Restore", exact: true }),
            "POST",
            `/api/backups/${id}/restore`,
            /Restore the resource snapshot from/,
        );
        await page.getByText("Resource snapshot restored. The app will reload.", { exact: true }).waitFor();
        // The epoch change opens the app's terminal restore notice above the panel's success alert.
        // Only that notice's OK acknowledges the restore and lets the normal reload proceed.
        await Promise.all([
            page.waitForEvent("domcontentloaded"),
            page
                .getByRole("dialog", {
                    name: "The server data was restored from a backup. The app will reload.",
                    exact: true,
                })
                .getByRole("button", { name: "OK", exact: true })
                .click(),
        ]);
        await openApp(page, stack.baseURL);
        await settle();
        const restored = await resources([{ kind: "characters", id: fixture.c }]);
        assert.equal(restored.items.find((item) => item.id === fixture.c).data.image, fixture.third.key);
        assert.deepEqual(await readFile(assetFile(fixture.third.key)), fixture.third.bytes);
        await openStorage();
        await removeCharacter(fixture.c);
        await panelRequest(
            snapshotRow(label).getByRole("button", { name: "Unpin", exact: true }),
            "PATCH",
            `/api/backups/${id}`,
        );
        await panelReady();
        await panelRequest(
            snapshotRow(label).getByRole("button", { name: "Delete", exact: true }),
            "DELETE",
            `/api/backups/${id}`,
            /Delete the resource snapshot from/,
        );
        await panelReady();
        await removeUnpinnedSnapshots();
        assert.deepEqual((await api("/api/backups")).items, []);
        // Restore reloads the tab, potentially rendering C again; discard that new lease too.
        await advance(32);
        report = await scan();
        assert.equal(report.unreferenced.count, 1);
        assert.equal(report.unreferenced.bytes, fixture.third.bytes.length);
        assert.deepEqual(candidates(report), [], "freed C starts its own ledger grace");
        assert.deepEqual(await readFile(assetFile(fixture.third.key)), fixture.third.bytes);
        return {
            snapshot: id,
            heldBytes: held.heldBytes,
            restoredBytesEqual: true,
            freed: fixture.third.key,
            offsetsDays: [24, 32],
        };
    });
} catch (error) {
    results.push(false);
    console.error(`FAIL ${activeCase} ${error.stack ?? error}`);
    console.error(`EVIDENCE browser ${JSON.stringify(browserErrors.slice(-20))}`);
    if (page) console.error(`EVIDENCE page ${(await page.locator("body").innerText().catch(String)).slice(0, 2000)}`);
    if (stack) {
        console.error(`EVIDENCE report ${JSON.stringify(await api("/api/assets/report").catch(String))}`);
        console.error(`EVIDENCE server log tail\n${serverLogs.slice(-12).join("")}`);
    }
} finally {
    try {
        if (browser) await browser.close();
    } finally {
        if (stack) await stack.stop();
    }
}
console.log(`SWEEP SUMMARY ${JSON.stringify(sweeps)}`);
console.log(`${results.filter(Boolean).length}/${results.length} cases passed`);
process.exitCode = results.length === 6 && results.every(Boolean) ? 0 : 1;
