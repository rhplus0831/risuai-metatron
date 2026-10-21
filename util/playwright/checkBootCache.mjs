// Check for the boot resource cache: the snapshot a real tab hands to `seedResources` after a boot
// through the IndexedDB boot cache equals a plain read, text for text. `measureBoot.mjs` measures
// the same boots on a production build, where the app's modules cannot be reached; this check runs
// the dev stack (`startStack`) and wraps `loadBootSnapshot` as Vite serves
// `src/ts/storage/bootCache.ts` (the module text is fulfilled with the export renamed and a wrapper
// that keeps `JSON.stringify(snapshot)` on `window.__risuBootSnapshot`), so what it compares is
// exactly what `loadData` installs.
//
// Data: 14 modules of 300 asset tuples (one listed twice), 6 characters (one with a TTS API key, which is
// never cached), 20 presets. Boots, each a reload: `cold` (cache deleted), `warm`, after one module's
// assets change, after a module reorder, after a character's edit, after a character's deletion, after
// a character's creation, and `fallback` (the boot route aborted: the plain read). Per boot: the
// snapshot equals a plain read taken right after it; a cached boot read through the boot route and
// claimed what the cache held (from `warm` on, every module and the presets record; never the
// credential character); the fallback boot read the plain route after the failed boot request. No
// page error. Wait for `loadedStore` after each reload without navigating again; if the app or Vite
// reloads, compare the snapshot of the document that finished loading. Check every boot request's
// credential claims, and the full-cache claims of the compared document.
//
// Usage: node util/playwright/checkBootCache.mjs
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright-core";
import { chromePath, openApp, repoRoot, startStack } from "./stack.mjs";

const { RESOURCE_KIND } = await import(path.join(repoRoot, "shared/resources.ts"));
const BOOT_PATH = "/api/resources/boot";
const PLAIN_READ_PATH = "/api/resources";
const BOOT_MODULE = "/src/ts/storage/bootCache.ts";

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};

const hex = (seed) => createHash("sha256").update(seed).digest("hex");
const assetTuples = (prefix, count) =>
    Array.from({ length: count }, (_, i) => [`${prefix} asset ${i}`, `assets/${hex(`${prefix}${i}`)}.png`, "png"]);
const character = (index, extra = {}) => ({
    chaId: randomUUID(),
    name: `Character ${index}`,
    type: "character",
    desc: `The description of character ${index}. `.repeat(50),
    firstMessage: "Hello.",
    globalLore: [],
    customscript: [],
    additionalAssets: assetTuples(`c${index}`, 50),
    emotionImages: [],
    bias: [],
    viewScreen: "none",
    chatFolders: [],
    firstMsgIndex: -1,
    ...extra,
});

let stack = null;
let browser = null;
try {
    stack = await startStack({ serverPort: 6141, vitePort: 5241 });
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    let auth = null;
    let epoch = null;
    let boots = [];
    let documentNumber = 0;
    // The boot's reads (the plain GET and the boot POST), from the request events: the dev page's
    // hundreds of module requests overflow the resource-timing buffer.
    let reads = [];
    page.on("request", (request) => {
        // History updates also emit framenavigated; only a navigation request starts a new document.
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentNumber++;
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
        if (request.method() === "POST" && new URL(request.url()).pathname === BOOT_PATH) {
            boots.push({ document: documentNumber, body: JSON.parse(request.postData() ?? "null") });
        }
        const pathname = new URL(request.url()).pathname;
        if (
            (request.method() === "POST" && pathname === BOOT_PATH) ||
            (request.method() === "GET" && pathname === PLAIN_READ_PATH)
        ) {
            reads.push(pathname);
        }
    });
    // The wrapper: the module as Vite serves it, `loadBootSnapshot` renamed and wrapped.
    let wrapped = 0;
    await page.route(
        (url) => url.pathname === BOOT_MODULE,
        async (route) => {
            const response = await route.fetch();
            const source = await response.text();
            const declaration = "export async function loadBootSnapshot(";
            if (source.split(declaration).length !== 2) {
                await route.fulfill({ response });
                return;
            }
            wrapped++;
            const body =
                source.replace(declaration, "async function __checkedLoadBootSnapshot(") +
                "\nexport async function loadBootSnapshot(deps) {" +
                "\n    const result = await __checkedLoadBootSnapshot(deps);" +
                "\n    window.__risuBootSnapshot = JSON.stringify(result.snapshot);" +
                "\n    return result;\n}\n";
            await route.fulfill({ response, body });
        },
    );
    const api = async (p, init = {}) => {
        const r = await fetch(stack.serverURL + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const plainRead = async () =>
        (
            await fetch(
                `${stack.serverURL}${PLAIN_READ_PATH}?kinds=${Object.values(RESOURCE_KIND).join(",")}&chatSummaries=1`,
                { headers: { "risu-auth": auth } },
            )
        ).text();
    const single = async (kind, id = "main") => (await api(`/api/resources/${kind}/${id}`)).body;

    await openApp(page, stack.baseURL);
    await page.waitForTimeout(1500);

    // Seed.
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const presets = await single("presets");
    const modules = await single("modules");
    const moduleList = Array.from({ length: 14 }, (_, i) => ({
        id: randomUUID(),
        name: `Module ${i}`,
        description: "",
        lorebook: [],
        assets: assetTuples(`m${i}`, 300),
    }));
    moduleList.push(moduleList[3]);
    const keyed = character(0, { oaiTTSConfig: { model: "tts-1", voice: "alloy", speed: "1", apiKey: "sk-check" } });
    const characters = [keyed, ...Array.from({ length: 5 }, (_, i) => character(i + 1))];
    const presetList = Array.from({ length: 20 }, (_, i) => ({
        ...presets.data[0],
        id: i === 0 ? presets.data[0].id : randomUUID(),
        name: `Preset ${i}`,
    }));
    const chatOps = (list) =>
        list.map((data) => ({
            characterId: data.chaId,
            chatId: `${data.chaId}-chat`,
            baseRevision: null,
            ops: [
                {
                    op: "create",
                    chat: { id: `${data.chaId}-chat`, name: "Chat 1", note: "", localLore: [], message: [] },
                },
            ],
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
            chats: chatOps(characters),
            chatOrders: [],
        }),
    });
    check("seed: stored", seeded.status === 200, seeded.status === 200 ? undefined : seeded);
    const deleteCache = () =>
        page.evaluate(
            () =>
                new Promise((resolve, reject) => {
                    const request = indexedDB.deleteDatabase("risu-boot-cache");
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                }),
        );

    const bootOnce = async (name, { cached = true, full = false } = {}) => {
        boots = [];
        reads = [];
        await page.reload();
        const deadline = Date.now() + 120_000;
        let snapshot;
        let comparedDocument;
        while (Date.now() < deadline) {
            const document = documentNumber;
            try {
                const state = await page.evaluate(async () => {
                    const stores = await import("/src/ts/stores.svelte.ts");
                    let loaded = false;
                    stores.loadedStore.subscribe((value) => (loaded = value))();
                    return { loaded, snapshot: window.__risuBootSnapshot };
                });
                if (document === documentNumber && state.loaded && state.snapshot !== undefined) {
                    snapshot = state.snapshot;
                    comparedDocument = document;
                    break;
                }
            } catch (error) {
                // A Vite or app reload invalidates the old document; poll the new one instead.
                if (!String(error).includes("Execution context was destroyed")) throw error;
            }
            await page.waitForTimeout(250);
        }
        if (snapshot === undefined)
            throw new Error(`${name}: the app did not finish loading with a snapshot within 120 s`);
        // The tab's later writes (the cache's own, after the boot) never touch the server: the plain
        // read now is the state the boot read.
        check(`${name}: the snapshot the tab installed equals a plain read`, snapshot === (await plainRead()));
        const claims = boots.map(({ document, body }) => ({
            document,
            records: new Set((body?.known?.records ?? []).map((r) => `${r.kind}/${r.id}`)),
            moduleHashes: body?.known?.items?.find((entry) => entry.kind === "modules")?.hashes ?? [],
        }));
        const comparedClaims = claims.filter((claim) => claim.document === comparedDocument);
        const noCredential = claims.every((claim) => !claim.records.has(`characters/${keyed.chaId}`));
        const detail = {
            reads,
            comparedDocument,
            boots: claims.map((claim) => ({
                document: claim.document,
                records: claim.records.size,
                moduleHashes: claim.moduleHashes.length,
            })),
        };
        if (cached) {
            check(
                `${name}: read through the boot route${full ? ", claiming every module and the presets record" : ""}, never the credential character`,
                reads.length >= 1 &&
                    reads.every((p) => p === BOOT_PATH) &&
                    comparedClaims.length > 0 &&
                    noCredential &&
                    (!full ||
                        comparedClaims.every(
                            (claim) =>
                                claim.records.has("modules/main") &&
                                claim.records.has("presets/main") &&
                                claim.moduleHashes.length >= 14,
                        )),
                detail,
            );
        } else {
            check(
                `${name}: the boot route failed, read through the plain route, never claimed the credential character`,
                reads.length >= 2 &&
                    reads.every((p, i) => p === (i % 2 === 0 ? BOOT_PATH : PLAIN_READ_PATH)) &&
                    comparedClaims.length > 0 &&
                    noCredential,
                detail,
            );
        }
        // Let the cache write land before the next boot.
        await page
            .waitForFunction(() => performance.getEntriesByName("risu-boot-cache:written").length > 0, null, {
                timeout: 15_000,
            })
            .catch(() => {});
    };

    await deleteCache();
    await bootOnce("cold");
    await bootOnce("warm", { full: true });

    let current = await single("modules");
    let data = structuredClone(current.data);
    data[2].assets.push(...assetTuples("edit", 1));
    check(
        "module edit: stored",
        (
            await api("/api/resources/modules/main", {
                method: "PUT",
                body: JSON.stringify({ baseRevision: current.revision, data }),
            })
        ).status === 200,
    );
    await bootOnce("module edit", { full: true });

    current = await single("modules");
    data = [...current.data].reverse();
    check(
        "module reorder: stored",
        (
            await api("/api/resources/modules/main", {
                method: "PUT",
                body: JSON.stringify({ baseRevision: current.revision, data }),
            })
        ).status === 200,
    );
    await bootOnce("module reorder", { full: true });

    const edited = await single("characters", characters[1].chaId);
    check(
        "character edit: stored",
        (
            await api(`/api/resources/characters/${characters[1].chaId}`, {
                method: "PUT",
                body: JSON.stringify({ baseRevision: edited.revision, data: { ...edited.data, desc: "Edited." } }),
            })
        ).status === 200,
    );
    await bootOnce("character edit", { full: true });

    const removed = await single("characters", characters[2].chaId);
    const deleted = await api(
        `/api/resources/characters/${characters[2].chaId}?baseRevision=${encodeURIComponent(removed.revision)}`,
        { method: "DELETE" },
    );
    check("character delete: stored", deleted.status === 200, deleted.status === 200 ? undefined : deleted);
    await bootOnce("character delete", { full: true });

    const added = character(9);
    const created = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [{ kind: "characters", id: added.chaId, baseRevision: null, data: added }],
            chats: chatOps([added]),
            chatOrders: [],
        }),
    });
    check("character create: stored", created.status === 200, created.status === 200 ? undefined : created);
    await bootOnce("character create", { full: true });

    await page.route(
        (url) => url.pathname === BOOT_PATH,
        (route) => route.abort(),
    );
    await bootOnce("fallback", { cached: false });

    check("the module was wrapped on every load", wrapped >= 8, { wrapped });
    check("no page error", pageErrors.length === 0, pageErrors.length === 0 ? undefined : pageErrors);
} catch (error) {
    console.error(error);
    results.push(false);
} finally {
    try {
        await browser?.close();
    } finally {
        await stack?.stop();
    }
}
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? `\nall ${results.length} checks passed` : `\n${failed} of ${results.length} checks failed`);
process.exit(failed === 0 ? 0 : 1);
