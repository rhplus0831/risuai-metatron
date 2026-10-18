import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { cardV3, charx } from "./storage/tests/importFixtures";
import { bootMutations, plain } from "./storage/tests/mutationStoresHarness";

const { server, alerts } = vi.hoisted(() => {
    // The alert helpers write the booted graph's `stores.svelte` `alertStore` as the real ones do
    // (`boot` installs it in `current`): the module dialog's `addImportedModule` reads it back to
    // replace only its own wait alert (data-loss plan slice 5b). The `vi.fn` wrappers keep the calls.
    const alerts = {
        current: null as null | { set: (data: { type: string; msg: string }) => void },
        show: (type: string) => (msg: unknown) => alerts.current?.set({ type, msg: String(msg) }),
        error: vi.fn((msg: unknown) => alerts.show("error")(msg)),
        normal: vi.fn((msg: unknown) => alerts.show("normal")(msg)),
        wait: vi.fn((msg: unknown) => alerts.show("wait")(msg)),
        clear: vi.fn(() => alerts.current?.set({ type: "none", msg: "" })),
        confirm: vi.fn(async () => true),
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
    alertInput: vi.fn(async () => ""),
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

const route = "/api/import/charx";
const line = (value: unknown) => JSON.stringify(value) + "\n";
const keyOf = (data: Uint8Array) => `assets/${createHash("sha256").update(data).digest("hex")}.png`;
const payload = new Uint8Array([0, 255, 128, 80, 75, 3, 4]);
const fixtureCard = () =>
    cardV3("Uploaded", {
        assets: [{ type: "x-risu-asset", name: "Backdrop", uri: "embeded://assets/background.webp", ext: "webp" }],
    });
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
    const uploads = () => fetch.mock.calls.filter(([url]) => url === route);
    const ids = () => booted.characterList().map((c) => c.chaId);
    return { ...booted, cards, modules, util, saveAsset, fetch, realFetch, uploads, ids };
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

describe("CharX files through the server and real records", () => {
    it.each([
        "character dialog",
        "dropped .charx",
        "dropped .jpg",
        "dropped .jpeg",
        "module dialog",
        "share",
        "deep link",
        "launch queue",
    ])("%s uploads the File/Blob once and persists embedded assets and module fields", async (entry) => {
        const b = await boot();
        const module = await b.modules.exportModuleLegacy(embedded as any, { saveData: false, alertEnd: false });
        const zip = charx(fixtureCard(), { "assets/background.webp": payload, "module.risum": module });
        const extension = entry === "dropped .jpg" ? "jpg" : entry === "dropped .jpeg" ? "jpeg" : "charx";
        // JPEG parsing itself is covered at the real route. Here the fake route reads the ZIP;
        // these names exercise the same public File handoff used by App.svelte's drop handler.
        const file = new File([new Uint8Array(zip)], `uploaded.${extension}`);
        const response = new Response(new Uint8Array(zip), {
            headers: {
                "content-disposition": 'attachment; filename="uploaded.charx"',
                "content-type": "application/charx",
            },
        });
        // Response.blob() is a different realm's Blob in this harness. The importer must
        // dispatch by bytes/stream, not by instanceof Blob.
        const downloaded = await response.blob();
        vi.spyOn(response, "blob").mockResolvedValue(downloaded);
        const responseRead = vi.spyOn(response, "arrayBuffer");
        const input = ["share", "deep link"].includes(entry) ? downloaded : file;
        const wholeRead = vi.spyOn(input, "arrayBuffer");
        const fileReader = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
        const before = b.ids();
        const removeShare = vi.fn(async () => true);
        if (entry === "character dialog") {
            vi.spyOn(b.util, "selectFileByDom").mockResolvedValue([file]);
            await b.cards.importCharacter();
        } else if (entry === "module dialog") {
            vi.spyOn(b.util, "selectSingleFileHandle").mockResolvedValue(file);
            await b.modules.importModule();
        } else if (entry.startsWith("dropped")) {
            await b.cards.importCharacterProcess({ name: file.name, data: file });
        } else if (entry === "launch queue") {
            const setConsumer = vi.fn();
            vi.stubGlobal("launchQueue", { setConsumer });
            await b.cards.characterURLImport();
            setConsumer.mock.calls[0][0]({ files: [{ name: file.name, getFile: async () => file }] });
            await vi.advanceTimersByTimeAsync(0);
        } else {
            vi.stubGlobal(
                "location",
                new URL(
                    "http://localhost/" +
                        (entry === "share" ? "#share_character" : "#import=https://example.test/uploaded.charx"),
                ),
            );
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => response),
            );
            vi.stubGlobal("caches", { open: async () => ({ match: async () => response, delete: removeShare }) });
            await b.cards.characterURLImport();
        }
        expect(b.uploads()).toHaveLength(1);
        expect(b.uploads()[0][1].body).toBe(input);
        expect(b.uploads()[0][1].method).toBe("POST");
        // The sole whole read belongs to the fake server after it receives the body.
        expect(wholeRead).toHaveBeenCalledTimes(1);
        const uploadIndex = b.fetch.mock.calls.findIndex(([url]) => url === route);
        expect(wholeRead.mock.invocationCallOrder[0]).toBeGreaterThan(b.fetch.mock.invocationCallOrder[uploadIndex]);
        expect(responseRead).not.toHaveBeenCalled();
        expect(fileReader).not.toHaveBeenCalled();
        expect(b.saveAsset).not.toHaveBeenCalled();
        expect(alerts.wait).toHaveBeenCalledWith(language.charxImportUploading);
        expect(alerts.wait).toHaveBeenCalledWith("Loading... (Saving Assets 1/1)");
        expect(alerts.error).not.toHaveBeenCalled();
        await b.sync.flushResources();
        const expectedAssets = [["Backdrop", keyOf(payload), "webp"]];
        if (entry === "module dialog") {
            expect(b.ids()).toEqual(before);
            expect(b.record("modules")).toEqual([
                expect.objectContaining({
                    name: "Uploaded",
                    assets: expectedAssets,
                    regex: embedded.regex,
                    trigger: embedded.trigger,
                    lorebook: expect.arrayContaining([expect.objectContaining({ content: "kept lore" })]),
                }),
            ]);
            expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
        } else {
            expect(b.ids()).toHaveLength(before.length + 1);
            const id = b.ids().at(-1);
            expect(b.record("characters", id)).toMatchObject({
                name: "Uploaded",
                nickname: "Uploaded nick",
                additionalAssets: expectedAssets,
                customscript: embedded.regex,
                triggerscript: embedded.trigger,
                globalLore: [expect.objectContaining({ content: "kept lore" })],
            });
            expect(b.record("characterOrder")).toContain(id);
            const chat = b.character(id).chats[0];
            expect(b.fake.chat(id, chat.id)).not.toBeNull();
        }
        if (entry === "share") expect(removeShare).toHaveBeenCalledTimes(1);
    });

    it.each(["Uint8Array", "ReadableStream"])(
        "keeps %s inputs on the in-tab reader with the same embedded assets",
        async (kind) => {
            const b = await boot();
            const zip = charx(fixtureCard(), {
                "assets/background.webp": payload,
                "x_meta/ignored.json": new Uint8Array([1]),
            });
            const input =
                kind === "Uint8Array"
                    ? zip
                    : new ReadableStream<Uint8Array>({
                          start(c) {
                              c.enqueue(zip);
                              c.close();
                          },
                      });
            const id = await b.cards.importCharacterProcess({ name: "local.charx", data: input });
            expect(b.uploads()).toEqual([]);
            expect(b.saveAsset).toHaveBeenCalledTimes(1);
            expect(b.character(id)).toMatchObject({ additionalAssets: [["Backdrop", keyOf(payload), "webp"]] });
            expect(alerts.error).not.toHaveBeenCalled();
        },
    );

    it.each([true, false])(
        "asks a card's lowLevelAccess before its data URI assets are saved (accepted: %s)",
        async (accepted) => {
            const b = await boot();
            const inline = Buffer.from("inline asset bytes");
            const card = cardV3(
                "Powerful",
                {
                    assets: [
                        {
                            type: "x-risu-asset",
                            name: "Inline",
                            uri: `data:image/png;base64,${inline.toString("base64")}`,
                            ext: "png",
                        },
                    ],
                },
                { lowLevelAccess: true },
            );
            alerts.confirm.mockImplementation(async () => accepted);
            // The fake server has no batch asset write: the queue answers content keys here.
            const assetQueue = await import("./storage/assetQueue");
            const saveAssets = vi.spyOn(assetQueue, "saveAssets").mockImplementation(async (items) => {
                const keys: string[] = [];
                for await (const item of items as Iterable<{ load: () => Uint8Array | Promise<Uint8Array> }>) {
                    keys.push(keyOf(await item.load()));
                }
                return keys;
            });
            const saved = () => saveAssets.mock.calls.filter(([items]) => (items as unknown[]).length > 0);
            const before = b.ids();
            const id = await b.cards.importCharacterProcess({ name: "local.charx", data: charx(card, {}) });
            expect(alerts.confirm).toHaveBeenCalledExactlyOnceWith(language.lowLevelAccessConfirm);
            expect(alerts.error).not.toHaveBeenCalled();
            if (accepted) {
                expect(saved()).toHaveLength(1);
                const call = saveAssets.mock.calls.indexOf(saved()[0]);
                expect(saveAssets.mock.invocationCallOrder[call]).toBeGreaterThan(
                    alerts.confirm.mock.invocationCallOrder[0],
                );
                expect(b.character(id)).toMatchObject({
                    lowLevelAccess: true,
                    additionalAssets: [["Inline", keyOf(inline), "png"]],
                });
            } else {
                expect(id).toBeFalsy();
                expect(saved()).toEqual([]);
                expect(b.saveAsset).not.toHaveBeenCalled();
                expect(b.ids()).toEqual(before);
            }
        },
    );

    it("shows progress before the result arrives and adds no record until the card is available", async () => {
        const b = await boot();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const realFetch = b.realFetch;
        b.fetch.mockImplementation((url, init) =>
            url === route
                ? Promise.resolve(
                      new Response(
                          new ReadableStream({
                              start(c) {
                                  controller = c;
                              },
                          }),
                      ),
                  )
                : realFetch(url, init),
        );
        const before = b.ids();
        const importing = b.cards.importCharacterProcess({ name: "progress.charx", data: new Blob(["opaque"]) });
        await vi.advanceTimersByTimeAsync(0);
        expect(alerts.wait).toHaveBeenLastCalledWith(language.charxImportUploading);
        for (let done = 1; done <= 2; done++) {
            controller.enqueue(new TextEncoder().encode(line({ done, total: 2 })));
            await vi.advanceTimersByTimeAsync(0);
            expect(alerts.wait).toHaveBeenLastCalledWith(`Loading... (Saving Assets ${done}/2)`);
            expect(b.ids()).toEqual(before);
        }
        controller.enqueue(
            new TextEncoder().encode(
                line({ card: JSON.stringify(cardV3("Progress")), moduleData: null, assets: {}, excluded: [] }),
            ),
        );
        controller.close();
        expect(await importing).toBe(b.ids().at(-1));
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(b.uploads()).toHaveLength(1);
    });

    it.each([
        { name: "invalid file", status: 400, error: "Invalid character file", message: () => language.errors.noData },
        { name: "too large", status: 413, error: "File too large", message: () => language.charxImportFileTooLarge },
        { name: "timeout", status: 408, message: () => language.moduleImportTimeout },
        { name: "busy", status: 409, message: () => language.moduleImportBusy },
        { name: "rate limit", status: 429, message: () => language.moduleImportBusy },
        { name: "maintenance", status: 503, message: () => language.moduleImportMaintenance },
        {
            name: "other server error",
            status: 400,
            error: "Authentication required",
            message: () => "Authentication required",
        },
        {
            name: "proxy error",
            status: 502,
            message: () => language.charxImportRequestFailed.replace("{{status}}", "502"),
        },
        {
            name: "invalid failure line",
            body: line({ error: "Invalid character file" }),
            message: () => language.errors.noData,
        },
        {
            name: "other failure line",
            body: line({ error: "Import failed" }),
            message: () => language.charxImportStopped.replace("{{error}}", "Import failed"),
        },
        { name: "fetch TypeError", network: "fetch", message: () => language.moduleImportInterrupted },
        { name: "body TypeError", network: "body", message: () => language.moduleImportInterrupted },
        {
            name: "malformed answer",
            body: line({ card: null, moduleData: null, assets: [], excluded: [] }),
            message: () => language.errors.noData,
        },
    ])("returns null and alerts once without adding records or retrying: $name", async (testCase) => {
        const b = await boot();
        const realFetch = b.realFetch;
        b.fetch.mockImplementation(async (url, init) => {
            if (url !== route) return realFetch(url, init);
            if (testCase.network === "fetch") throw new TypeError("lost upload");
            if (testCase.network === "body")
                return new Response(
                    new ReadableStream({
                        start(c) {
                            c.error(new TypeError("lost response"));
                        },
                    }),
                );
            if (testCase.status)
                return new Response(testCase.error ? JSON.stringify({ error: testCase.error }) : "proxy failure", {
                    status: testCase.status,
                });
            return new Response(testCase.body);
        });
        const before = b.ids();
        const order = plain(b.settings.characterOrder);
        const importing = b.cards.importCharacterProcess({ name: "refused.charx", data: new Blob(["opaque"]) });
        await vi.advanceTimersByTimeAsync(180_000);
        expect(await importing).toBeNull();
        expect(b.uploads()).toHaveLength(1);
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(testCase.message());
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(b.ids()).toEqual(before);
        expect(plain(b.settings.characterOrder)).toEqual(order);
        await b.sync.flushResources();
        expect(b.record("characterOrder")).toEqual(order);
        expect(b.record("modules")).toEqual([]);
        expect(b.saveAsset).not.toHaveBeenCalled();
    });

    it("the module dialog keeps the upload's alert without adding a second noData alert", async () => {
        const b = await boot();
        const before = b.ids();
        b.fake.failNext = { status: 503, times: 1, match: (url) => url === route };
        vi.spyOn(b.util, "selectSingleFileHandle").mockResolvedValue(new File(["opaque"], "refused.charx"));
        await b.modules.importModule();
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(language.moduleImportMaintenance);
        expect(b.uploads()).toHaveLength(1);
        expect(b.ids()).toEqual(before);
        expect(b.record("modules")).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it.each([null, JSON.stringify({ spec: "chara_card_v2", data: {} })])(
        "rejects a missing or non-V3 card with noData and no id: %s",
        async (card) => {
            const b = await boot();
            const realFetch = b.realFetch;
            b.fetch.mockImplementation((url, init) =>
                url === route
                    ? Promise.resolve(new Response(line({ card, moduleData: null, assets: {}, excluded: [] })))
                    : realFetch(url, init),
            );
            const before = b.ids();
            const result = await b.cards.importCharacterProcess({ name: "invalid-card.charx", data: new Blob() });
            expect(alerts.error).toHaveBeenCalledExactlyOnceWith(language.errors.noData);
            expect(b.ids()).toEqual(before);
            expect(b.uploads()).toHaveLength(1);
            expect(result).toBeFalsy();
        },
    );
});
