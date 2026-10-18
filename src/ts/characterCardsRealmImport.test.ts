import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { REALM_DOWNLOAD_FAILED, REALM_IMPORT_PATH } from "../../shared/realmImport.ts";
import { cardV2, cardV3 } from "./storage/tests/importFixtures";
import { bootMutations, plain } from "./storage/tests/mutationStoresHarness";

/**
 * `downloadRisuHub` over the real records with the server's Realm download answered by the test
 * (`POST /api/import/realm` intercepted on the fake server's `fetch`): the tab sends the id only,
 * never fetches Realm itself, builds the character from the server's result (CharX: the module's
 * fields merged, the asset keys as stored; PNG: the stored image key without a `saveAsset`, an `rcc`
 * card decrypted, an off-spec card converted; legacy JSON: the hub import with its portrait through
 * `/hub-proxy`), counts the import once for a binary answer, and alerts each failure once with the
 * Realm texts.
 */

const { server, alerts } = vi.hoisted(() => {
    const alerts = {
        current: null as null | { set: (data: { type: string; msg: string }) => void },
        show: (type: string) => (msg: unknown) => alerts.current?.set({ type, msg: String(msg) }),
        error: vi.fn((msg: unknown) => alerts.show("error")(msg)),
        normal: vi.fn((msg: unknown) => alerts.show("normal")(msg)),
        wait: vi.fn((msg: unknown) => alerts.show("wait")(msg)),
        clear: vi.fn(() => alerts.current?.set({ type: "none", msg: "" })),
        confirm: vi.fn(async () => true),
        input: vi.fn(async () => ""),
        store: { set: vi.fn(), subscribe: vi.fn() },
    };
    return { server: { current: null as any }, alerts };
});
vi.mock("./storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("./alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertWait: alerts.wait,
    alertNormalWait: vi.fn(async () => undefined),
    alertConfirm: alerts.confirm,
    alertReloadNotice: vi.fn(),
    alertStore: alerts.store,
    alertInput: alerts.input,
    alertSelect: vi.fn(async () => ""),
    alertAddCharacter: vi.fn(),
    alertCardExport: vi.fn(),
    alertClear: alerts.clear,
    alertModuleSelect: vi.fn(),
    alertMd: vi.fn(),
    waitAlert: vi.fn(),
}));
vi.mock("./parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("./process/index.svelte", () => ({ doingChat: { set: vi.fn(), subscribe: vi.fn() } }));
vi.mock("./translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("./process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("./process/files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("./tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));

const route = REALM_IMPORT_PATH;
const line = (value: unknown) => JSON.stringify(value) + "\n";
const keyOf = (data: Uint8Array) => `assets/${createHash("sha256").update(data).digest("hex")}.png`;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
const payload = new Uint8Array([0, 255, 128, 80, 75, 3, 4]);
const embedded = {
    id: "embedded-id",
    name: "Embedded",
    lorebook: [
        {
            key: "lore",
            secondkey: "",
            comment: "Embedded lore",
            content: "kept lore",
            mode: "normal",
            insertorder: 100,
            alwaysActive: false,
            selective: false,
        },
    ],
    regex: [{ comment: "Embedded regex", in: "hello", out: "hi", type: "editdisplay", flag: "", ableFlag: true }],
    trigger: [{ comment: "Embedded trigger", type: "start", conditions: [], effect: [] }],
};
const charxResult = (card: unknown, moduleData: string | null, assets: Record<string, string>) => ({
    kind: "charx",
    card: JSON.stringify(card),
    moduleData,
    assets,
    excluded: [],
});
const pngResult = (card: string | null, image: string, assets: Record<string, string> = {}) => ({
    kind: "png",
    card,
    image,
    assets,
});

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    alerts.current = booted.stores.alertStore;
    const globalApi = await import("./globalApi.svelte");
    const saveAsset = vi.spyOn(globalApi, "saveAsset").mockImplementation(async (data: Uint8Array) => keyOf(data));
    const util = await import("./util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    const cards = await import("./characterCards");
    const modules = await import("./process/modules");
    const realFetch = booted.fake.fetch.bind(booted.fake);
    const fetch = vi.spyOn(booted.fake, "fetch");
    /** The server's answer to the next Realm download: a `Response`, or lines of its NDJSON body. */
    const answer = (response: Response | string) => {
        fetch.mockImplementation((url, init) =>
            url === route
                ? Promise.resolve(typeof response === "string" ? new Response(response) : response)
                : realFetch(url, init),
        );
    };
    const downloads = () => fetch.mock.calls.filter(([url]) => url === route);
    const ids = () => booted.characterList().map((c) => c.chaId);
    const imports = () => (booted.settings.statics as any)?.imports ?? 0;
    // The tab never fetches Realm (or anything else) itself for a binary answer.
    const globalFetch = vi.fn(async (input: unknown): Promise<Response> => {
        throw new Error(`unexpected fetch of ${String(input)}`);
    });
    vi.stubGlobal("fetch", globalFetch);
    return { ...booted, cards, modules, util, saveAsset, fetch, answer, downloads, ids, imports, globalFetch };
}

beforeAll(async () => {
    await import("./stores.svelte");
    await import("./storage/database.svelte");
    await import("./characterCards");
}, 60_000);
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    alerts.current = null;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", new URL("http://localhost/"));
    vi.stubGlobal("safeStructuredClone", (value: unknown) =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
    );
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("the Realm download through the server (downloadRisuHub)", () => {
    it("sends the id only and builds a CharX card from the server's result: module fields merged, keys as stored", async () => {
        const b = await boot();
        const module = await b.modules.exportModuleLegacy(embedded as any, { saveData: false, alertEnd: false });
        const card = cardV3("Downloaded", {
            assets: [{ type: "x-risu-asset", name: "Backdrop", uri: "embeded://assets/background.webp", ext: "webp" }],
        });
        b.answer(
            line({ done: 1, total: 1 }) +
                line(
                    charxResult(card, Buffer.from(module).toString("base64"), {
                        "assets/background.webp": keyOf(payload),
                    }),
                ),
        );
        const before = b.ids();
        const imports = b.imports();
        await b.cards.downloadRisuHub("fixture-id");
        expect(b.downloads()).toHaveLength(1);
        const [, init] = b.downloads()[0];
        expect(init.method).toBe("POST");
        expect(init.body).toBe(JSON.stringify({ id: "fixture-id" }));
        expect(new Headers(init.headers).get("content-type")).toBe("application/json");
        expect(b.globalFetch).not.toHaveBeenCalled();
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(alerts.store.set).toHaveBeenCalledWith({ type: "wait", msg: "Downloading..." });
        expect(alerts.wait).toHaveBeenCalledWith("Loading... (Saving Assets 1/1)");
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(b.imports()).toBe(imports + 1);
        await b.sync.flushResources();
        const id = b.ids().at(-1);
        expect(b.record("characters", id)).toMatchObject({
            name: "Downloaded",
            nickname: "Downloaded nick",
            additionalAssets: [["Backdrop", keyOf(payload), "webp"]],
            customscript: embedded.regex,
            triggerscript: embedded.trigger,
            globalLore: [expect.objectContaining({ content: "kept lore" })],
        });
        expect(b.record("characterOrder")).toContain(id);
        expect(b.fake.chat(id, b.character(id).chats[0].id)).not.toBeNull();
    });

    it("builds a PNG card from the stored image key and asset keys without saving anything itself", async () => {
        const b = await boot();
        const card = cardV3("Portrait", {
            assets: [{ type: "x-risu-asset", name: "Asset 0", uri: "__asset:0", ext: "png" }],
        });
        b.answer(
            line({ done: 1, total: 1 }) + line(pngResult(b64(card), "assets/image-key.png", { "0": "assets/a0.png" })),
        );
        const before = b.ids();
        const imports = b.imports();
        await b.cards.downloadRisuHub("png-id");
        expect(b.globalFetch).not.toHaveBeenCalled();
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(b.imports()).toBe(imports + 1);
        const id = b.ids().at(-1)!;
        expect(plain(b.character(id))).toMatchObject({
            name: "Portrait",
            image: "assets/image-key.png",
            additionalAssets: [["Asset 0", "assets/a0.png", "png"]],
        });
        await b.sync.flushResources();
        expect(b.record("characters", id)).toMatchObject({ image: "assets/image-key.png" });
    });

    it("decrypts an rcc card and uses the stored image key", async () => {
        const b = await boot();
        const card = cardV2("Encrypted");
        const encrypted = new Uint8Array(await b.util.encryptBuffer(Buffer.from(JSON.stringify(card)), "RISU_NONE"));
        // `hasher` is mocked to "" here, so the checksum part is "".
        const rcc = ["rcc", "rccv1", Buffer.from(encrypted).toString("base64"), "", b64({ usePassword: false })].join(
            "||",
        );
        b.answer(line(pngResult(rcc, "assets/encrypted.png")));
        const before = b.ids();
        await b.cards.downloadRisuHub("rcc-id");
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(plain(b.character(b.ids().at(-1)!))).toMatchObject({ name: "Encrypted", image: "assets/encrypted.png" });
    });

    it("converts an off-spec (Tavern) PNG card with the stored image key", async () => {
        const b = await boot();
        const tavern = {
            name: "Tavern",
            description: "an old card",
            first_mes: "hello",
            personality: "",
            scenario: "",
        };
        b.answer(line(pngResult(b64(tavern), "assets/tavern.png")));
        const before = b.ids();
        await b.cards.downloadRisuHub("tavern-id");
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(alerts.normal).toHaveBeenCalledWith(language.importedCharacter);
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(plain(b.character(b.ids().at(-1)!))).toMatchObject({ name: "Tavern", image: "assets/tavern.png" });
    });

    it.each([
        ["a PNG without a card", pngResult(null, "assets/no-card.png")],
        ["a CharX without a card", { ...charxResult(cardV2("Old"), null, {}), card: null }],
        ["a CharX whose card is not V3", charxResult(cardV2("Old"), null, {})],
    ])("alerts noData for %s and adds no record", async (_name, result) => {
        const b = await boot();
        b.answer(line(result));
        const before = b.ids();
        await b.cards.downloadRisuHub("no-card");
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(language.errors.noData);
        expect(b.ids()).toEqual(before);
        expect(b.saveAsset).not.toHaveBeenCalled();
        await b.sync.flushResources();
        expect(b.record("characterOrder")).not.toContain(expect.not.stringMatching(/^c$/));
    });

    it("imports a legacy JSON answer in hub mode: the portrait through /hub-proxy, no import count", async () => {
        const b = await boot();
        const portrait = new Uint8Array([1, 2, 3, 4]);
        b.globalFetch.mockImplementation(async (input: unknown) => {
            if (String(input) === "/hub-proxy/resource/portrait-id") return new Response(portrait);
            throw new Error(`unexpected fetch of ${String(input)}`);
        });
        b.answer(line({ kind: "json", body: JSON.stringify({ card: cardV3("Legacy"), img: "portrait-id" }) }));
        const before = b.ids();
        const imports = b.imports();
        await b.cards.downloadRisuHub("legacy-id");
        expect(alerts.error).not.toHaveBeenCalled();
        expect(b.globalFetch).toHaveBeenCalledExactlyOnceWith("/hub-proxy/resource/portrait-id");
        expect(b.saveAsset).toHaveBeenCalledTimes(1);
        expect(Buffer.from(b.saveAsset.mock.calls[0][0])).toEqual(Buffer.from(portrait));
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(b.imports()).toBe(imports);
        expect(plain(b.character(b.ids().at(-1)!))).toMatchObject({ name: "Legacy", image: keyOf(portrait) });
    });

    it("shows the download alert only without forceRedirect and the progress lines as they arrive", async () => {
        const b = await boot();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        b.answer(
            new Response(
                new ReadableStream({
                    start(c) {
                        controller = c;
                    },
                }),
            ),
        );
        const before = b.ids();
        const importing = b.cards.downloadRisuHub("slow-id", { forceRedirect: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(alerts.store.set).not.toHaveBeenCalledWith({ type: "wait", msg: "Downloading..." });
        for (let done = 1; done <= 2; done++) {
            controller.enqueue(new TextEncoder().encode(line({ done, total: 2 })));
            await vi.advanceTimersByTimeAsync(0);
            expect(alerts.wait).toHaveBeenLastCalledWith(`Loading... (Saving Assets ${done}/2)`);
            expect(b.ids()).toEqual(before);
        }
        controller.enqueue(new TextEncoder().encode(line(charxResult(cardV3("Progress"), null, {}))));
        controller.close();
        await importing;
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it.each([
        { name: "invalid file", status: 400, error: "Invalid character file", message: () => language.errors.noData },
        { name: "invalid id", status: 400, error: "Invalid Realm id", message: () => "Invalid Realm id" },
        { name: "too large", status: 413, error: "File too large", message: () => language.realmImportFileTooLarge },
        { name: "busy", status: 409, error: "Another import is running", message: () => language.moduleImportBusy },
        { name: "rate limit", status: 429, message: () => language.moduleImportBusy },
        { name: "maintenance", status: 503, message: () => language.moduleImportMaintenance },
        {
            name: "download failed",
            status: 502,
            error: REALM_DOWNLOAD_FAILED,
            message: () => language.realmImportDownloadFailed,
        },
        {
            name: "Realm's refusal",
            status: 502,
            error: "Realm says: no such card",
            message: () => "Realm says: no such card",
        },
        {
            name: "a reverse proxy's 502",
            status: 502,
            message: () => language.realmImportRequestFailed.replace("{{status}}", "502"),
        },
        {
            name: "invalid failure line",
            body: line({ error: "Invalid character file" }),
            message: () => language.errors.noData,
        },
        {
            name: "other failure line",
            body: line({ error: "Import failed" }),
            message: () => language.realmImportStopped.replace("{{error}}", "Import failed"),
        },
        { name: "fetch TypeError", network: "fetch", message: () => language.realmImportInterrupted },
        { name: "body TypeError", network: "body", message: () => language.realmImportInterrupted },
        {
            name: "malformed result",
            body: line({ kind: "png", card: 1, image: null, assets: {} }),
            message: () => language.errors.noData,
        },
        { name: "no result line", body: line({ done: 1, total: 1 }), message: () => language.errors.noData },
    ])("alerts once, adds no record, counts nothing, and does not retry: $name", async (testCase) => {
        const b = await boot();
        b.answer(
            testCase.network === "fetch"
                ? new Response(null, { status: 599 })
                : testCase.network === "body"
                  ? new Response(
                        new ReadableStream({
                            start(c) {
                                c.error(new TypeError("lost response"));
                            },
                        }),
                    )
                  : testCase.status
                    ? new Response(testCase.error ? JSON.stringify({ error: testCase.error }) : "proxy failure", {
                          status: testCase.status,
                      })
                    : new Response(testCase.body),
        );
        if (testCase.network === "fetch") {
            b.fetch.mockImplementation(async () => {
                throw new TypeError("lost request");
            });
        }
        const before = b.ids();
        const imports = b.imports();
        const order = plain(b.settings.characterOrder);
        await b.cards.downloadRisuHub("refused-id");
        expect(b.fetch.mock.calls.filter(([url]) => url === route)).toHaveLength(1);
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(testCase.message());
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(b.ids()).toEqual(before);
        expect(b.imports()).toBe(imports);
        expect(plain(b.settings.characterOrder)).toEqual(order);
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(b.globalFetch).not.toHaveBeenCalled();
        await b.sync.flushResources();
        expect(b.record("characterOrder")).toEqual(order);
    });
});
