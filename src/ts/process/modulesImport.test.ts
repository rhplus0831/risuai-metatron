import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { cardV3, characterBook, charx } from "../storage/tests/importFixtures";
import { bootMutations, plain } from "../storage/tests/mutationStoresHarness";

// Phase 4, slice 7 (`docs/plan/phases/slices/phase-4-external-contracts/imports-through-the-module.md`):
// `importModule` creates its record through `addModule` for every file kind, over the real save
// adapter and the real server store (`storeBackedServer.ts`): a `.risum` (written by
// `exportModuleLegacy`, read by the real reader with the RPack map from disk), a CharX (the real zip
// importer, converted by `convertCharacterToModule`; no character is created), a native module JSON
// (its `lowLevelAccess` confirmation kept), a native lore file, an external lore file, and a regex
// file. The collection holds the module with a fresh id and is on the server after one cycle. A CharX
// whose converted module `addModule` refuses reports `noData` only, never success, and inserts nothing
// (Astra challenge point 1).

const { server, alerts, picker } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        store: { set: vi.fn(), subscribe: vi.fn() },
    },
    picker: { file: null as { name: string; data: Uint8Array } | null },
}));

vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: alerts.confirm,
    alertStore: alerts.store,
    alertWait: vi.fn(),
    alertInput: vi.fn(async () => ""),
    alertSelect: vi.fn(async () => ""),
    alertAddCharacter: vi.fn(),
    alertCardExport: vi.fn(),
    alertClear: vi.fn(),
    alertModuleSelect: vi.fn(),
    alertMd: vi.fn(),
    waitAlert: vi.fn(),
}));
vi.mock("../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("./index.svelte", () => ({ doingChat: { set: vi.fn(), subscribe: vi.fn() } }));
vi.mock("../translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("./inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("./files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("../tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));
vi.mock("../rpack/rpack_js", () => {
    const map = new Uint8Array(readFileSync(path.resolve(__dirname, "../rpack/rpack_map.bin")));
    const apply = (table: Uint8Array) => async (data: Uint8Array) => {
        const result = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = table[data[i]];
        }
        return result;
    };
    return { encodeRPack: apply(map.slice(0, 256)), decodeRPack: apply(map.slice(256, 512)) };
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const lore = (comment: string, content: string) => ({
    key: comment.toLowerCase(),
    comment,
    content,
    mode: "normal",
    insertorder: 100,
    alwaysActive: false,
    secondkey: "",
    selective: false,
});
const regex = (comment: string) => ({
    comment,
    in: `${comment}In`,
    out: `${comment}Out`,
    type: "editdisplay",
    flag: "",
    ableFlag: true,
});

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    // `globalApi` and `util` stay real (a `vi.mock` wrapper would outlive `vi.resetModules` and keep
    // the first graph's records); the asset store, `sleep`, and the file dialog are spied per graph.
    const globalApi = await import("../globalApi.svelte");
    vi.spyOn(globalApi, "saveAsset").mockResolvedValue("asset");
    const util = await import("../util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    // The dialog answers the picked `File` itself (large-asset-import slice 2c), built from `picker.file`.
    vi.spyOn(util, "selectSingleFileHandle").mockImplementation(async () =>
        picker.file ? new File([new Uint8Array(picker.file.data)], picker.file.name) : null,
    );
    const modules = await import("./modules");
    const cards = await import("../characterCards");
    const { settings, sync, record } = booted;
    const list = () => plain(settings.modules) as any[];
    /** Imports `file` and returns the module added (the only new entry), checked on the server after a cycle. */
    const imported = async (file: { name: string; data: Uint8Array }) => {
        const before = list().map((module) => module.id);
        picker.file = file;
        const result = await modules.importModule();
        const added = list().filter((module) => !before.includes(module.id));
        expect(added).toHaveLength(1);
        expect(added[0].id).toMatch(UUID_V4);
        await sync.flushResources();
        expect(record("modules")).toEqual(list());
        return { module: added[0], result };
    };
    const order = () => plain(settings.characterOrder) as unknown[];
    return { ...booted, modules, cards, list, imported, order };
}

// The first boot compiles the module graph; done once here so no test pays for it, in the
// harness's order (the stores before the modules that reach back into them at load).
beforeAll(async () => {
    await import("../stores.svelte");
    await import("../storage/database.svelte");
    await import("./modules");
}, 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.stubGlobal("safeStructuredClone", (value: unknown) =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    picker.file = null;
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("importModule adds the module through addModule", () => {
    it("a .risum save exhausted by retries makes readModule throw; a refused upload makes importModule add nothing after one request", async () => {
        const { modules, list, sync, record } = await boot();
        const { encodeRPack } = await import("../rpack/rpack_js");
        const main = await encodeRPack(
            encode({
                type: "risuModule",
                module: { name: "Failed assets", id: "file-id", lorebook: [], assets: [["icon", "", "png"]] },
            }),
        );
        const asset = await encodeRPack(new Uint8Array([137, 80, 78, 71]));
        const length = (n: number) => {
            const bytes = Buffer.alloc(4);
            bytes.writeUInt32LE(n);
            return bytes;
        };
        const bytes = Buffer.concat([
            Buffer.from([111, 0]),
            length(main.length),
            main,
            Buffer.from([1]),
            length(asset.length),
            asset,
            Buffer.from([0]),
        ]);
        const globalApi = await import("../globalApi.svelte");
        // Keep the batched asset write real; only the authenticated server response is replaced.
        vi.mocked(globalApi.saveAsset).mockRestore();
        const realFetch = server.current.fetch.bind(server.current) as (
            url: string,
            init?: RequestInit,
        ) => Promise<Response>;
        const fetch = vi.spyOn(server.current, "fetch");
        fetch.mockImplementation((url: string, init?: RequestInit) =>
            url === "/api/assets/write" ? Promise.resolve(new Response(null, { status: 503 })) : realFetch(url, init),
        );
        const before = list();
        const reading = modules.readModule(bytes).then(
            (value) => ({ value }),
            (error) => ({ error }),
        );
        for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
            await vi.advanceTimersByTimeAsync(wait);
        expect(await reading).toMatchObject({
            error: {
                name: "AssetSaveError",
                failed: 1,
                cause: "setItem Error",
            },
        });
        expect(fetch.mock.calls.filter(([url]) => url === "/api/assets/write")).toHaveLength(8);
        // The dialog's `.risum` goes to the import route as the file itself (large-asset-import slice
        // 2c): one request, never retried, no asset write; a 503 is the maintenance alert.
        server.current.failNext = { status: 503, times: 1, match: (p: string) => p === "/api/import/module" };
        picker.file = { name: "failed.risum", data: bytes };
        const importing = modules.importModule();
        for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
            await vi.advanceTimersByTimeAsync(wait);
        expect(await importing).toBe(false);
        expect(fetch.mock.calls.filter(([url]) => url === "/api/import/module")).toHaveLength(1);
        expect(fetch.mock.calls.filter(([url]) => url === "/api/assets/write")).toHaveLength(8);
        expect(server.current.failNext).toBeNull();
        expect(list()).toEqual(before);
        expect(alerts.error).toHaveBeenLastCalledWith(language.moduleImportMaintenance);
        expect(alerts.normal).not.toHaveBeenCalled();
        await sync.flushResources();
        expect(record("modules")).toEqual(before);
    });

    it(".risum: the module the file carries, under a fresh id", async () => {
        const { modules, imported } = await boot();
        const source = {
            name: "Packed",
            description: "packed module",
            id: "file-id",
            lorebook: [lore("Packed lore", "p")],
            regex: [regex("Packed regex")],
            trigger: [],
        };
        const bytes = await modules.exportModuleLegacy(source as any, { saveData: false, alertEnd: false });
        const { module } = await imported({ name: "packed.risum", data: bytes });
        expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
        expect(module.id).not.toBe("file-id");
        expect(module).toMatchObject({
            name: "Packed",
            description: "packed module",
            lorebook: [lore("Packed lore", "p")],
            regex: [regex("Packed regex")],
            assets: [],
        });
    });

    it("CharX: the card is converted to a module (its lore, description, greeting, and regex) and no character is created", async () => {
        const { imported, characterList, order } = await boot();
        const characters = characterList().length;
        const orderBefore = order();
        const card = cardV3(
            "Mod",
            { description: "mod desc", first_mes: "mod hi", character_book: characterBook("Mod lore", "m") },
            { customScripts: [regex("Mod regex")] },
        );
        const { module } = await imported({ name: "mod.charx", data: charx(card) });
        expect(module.name).toBe("Mod");
        expect(module.regex).toEqual([regex("Mod regex")]);
        expect(module.lorebook.map((entry: any) => entry.comment)).toEqual([
            "Mod lore",
            "From Character Description",
            "From First Messages",
        ]);
        expect(module.lorebook[1].content).toContain("mod desc");
        expect(module.lorebook[2].content).toContain("mod hi");
        expect(characterList()).toHaveLength(characters);
        expect(order()).toEqual(orderBefore);
        expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("native module JSON: a fresh id, the lowLevelAccess confirmation kept", async () => {
        const { imported, list, modules, sync, record } = await boot();
        const file = {
            type: "risuModule",
            name: "Native",
            id: "old",
            description: "n",
            lorebook: [],
            lowLevelAccess: true,
        };
        const { module } = await imported({ name: "native.json", data: encode(file) });
        expect(module.id).not.toBe("old");
        expect(module).toMatchObject({ name: "Native", description: "n", lowLevelAccess: true });
        expect(alerts.confirm).toHaveBeenCalledWith(language.lowLevelAccessConfirm);

        // Declined: nothing is added.
        alerts.confirm.mockResolvedValueOnce(false);
        const before = list();
        picker.file = { name: "native.json", data: encode(file) };
        expect(await modules.importModule()).toBe(false);
        expect(list()).toEqual(before);
        await sync.flushResources();
        expect(record("modules")).toEqual(before);
    });

    it("native lore JSON (type risu) becomes a lorebook module", async () => {
        const { imported } = await boot();
        const { module } = await imported({
            name: "lore.json",
            data: encode({ type: "risu", ver: 1, data: [lore("Native lore", "n")] }),
        });
        expect(module).toMatchObject({
            name: "Imported Lorebook",
            description: "Converted from risu lorebook",
            lorebook: [lore("Native lore", "n")],
        });
    });

    it("external lore JSON (entries) is converted into a lorebook module", async () => {
        const { imported } = await boot();
        const { module } = await imported({
            name: "world.json",
            data: encode({
                name: "World",
                entries: {
                    "0": { keys: ["ext", "ernal"], content: "external content", comment: "External", order: 7 },
                },
            }),
        });
        expect(module.name).toBe("World");
        expect(module.lorebook).toEqual([
            expect.objectContaining({
                key: "ext, ernal",
                comment: "External",
                content: "external content",
                insertorder: 7,
            }),
        ]);
    });

    it("regex JSON becomes a regex module", async () => {
        const { imported } = await boot();
        const { module } = await imported({
            name: "regex.json",
            data: encode({ type: "regex", name: "Rules", data: [regex("Rule")] }),
        });
        expect(module).toMatchObject({ name: "Rules", regex: [regex("Rule")] });
    });

    it("a module JSON without a name reports noData and adds nothing", async () => {
        const { modules, list, sync, record } = await boot();
        const before = list();
        picker.file = { name: "bad.json", data: encode({ type: "risuModule", id: "x" }) };
        await modules.importModule();
        expect(alerts.error).toHaveBeenCalledWith(language.errors.noData);
        expect(list()).toEqual(before);
        await sync.flushResources();
        expect(record("modules")).toEqual(before);
    });
});

describe("a CharX whose converted module is refused", () => {
    it("reports noData only, never success, and inserts nothing (Astra challenge point 1)", async () => {
        const { modules, cards, list, sync, record, mirrorText } = await boot();
        const before = list();
        const mirror = mirrorText();
        // The card decodes; its regex list carries a value that is not JSON data, which `addModule` refuses.
        vi.spyOn(cards, "importCharacterProcess").mockResolvedValueOnce({
            name: "Broken",
            chaId: "broken",
            globalLore: [],
            customscript: [{ ...regex("Broken"), flag: Number.POSITIVE_INFINITY }],
            triggerscript: [],
        } as any);
        picker.file = { name: "broken.charx", data: charx(cardV3("Broken")) };
        await modules.importModule();
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.error).toHaveBeenCalledWith(language.errors.noData);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(list()).toEqual(before);
        expect(mirrorText()).toBe(mirror);
        await sync.flushResources();
        expect(record("modules")).toEqual(before);
    });
});

// Slice 2c: drive the file boundary and its callers, keeping the module/save stores real.
async function packedMain(text: string) {
    const { encodeRPack } = await import("../rpack/rpack_js");
    const main = await encodeRPack(new TextEncoder().encode(text));
    const header = Buffer.alloc(6);
    header[0] = 111;
    header.writeUInt32LE(main.length, 2);
    return Buffer.concat([header, main, Buffer.from([0])]);
}

const ndjson = (value: unknown) => JSON.stringify(value) + "\n";

describe("server module file imports", () => {
    // One case per local check: the header, the main record's length against the file, its content
    // (the shared reader's other refusals are covered by server/src/tests/importModule.test.ts).
    it.each(["magic", "short main", "wrong type"])("refuses an invalid %s locally before any upload", async (fault) => {
        const { modules, list } = await boot();
        let bytes = await packedMain(
            JSON.stringify({ type: "risuModule", module: { name: "Invalid", id: "file-id" } }),
        );
        if (fault === "magic") bytes[0] = 0;
        if (fault === "short main") bytes = bytes.subarray(0, bytes.length - 2);
        if (fault === "wrong type") bytes = await packedMain('{"type":"character","module":{}}');
        const before = list();
        const fetch = vi.spyOn(server.current, "fetch");
        expect(await modules.importModuleFile(new Blob([new Uint8Array(bytes)]))).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(language.errors.noData);
        expect(alerts.confirm).not.toHaveBeenCalled();
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(list()).toEqual(before);
    });

    it("declining low-level access stops before lorebook preparation or upload", async () => {
        const { modules, list } = await boot();
        const bytes = await modules.exportModuleLegacy(
            { name: "Permission", id: "file-id", lowLevelAccess: true, lorebook: "corrupt" } as any,
            { saveData: false, alertEnd: false },
        );
        const before = list();
        const fetch = vi.spyOn(server.current, "fetch");
        alerts.confirm.mockResolvedValueOnce(false);
        picker.file = { name: "permission.risum", data: bytes };
        await modules.importModule();
        expect(alerts.confirm).toHaveBeenCalledExactlyOnceWith(language.lowLevelAccessConfirm);
        expect(fetch).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(list()).toEqual(before);
    });

    it("reads only header and main, confirms before upload, streams progress, and keeps prepared fields with server keys", async () => {
        const { modules, list, sync, record } = await boot();
        const source = {
            id: "file-id",
            name: "Local name",
            description: "Local description",
            lowLevelAccess: true,
            lorebook: "corrupt",
            assets: [
                ["Local icon", "", "webp"],
                ["Local banner", "", "jpg"],
            ],
        };
        const bytes = await packedMain(JSON.stringify({ type: "risuModule", module: source }));
        const file = new File([new Uint8Array(bytes)], "bounded.risum");
        const wholeRead = vi.spyOn(file, "arrayBuffer");
        const slices = vi.spyOn(file, "slice");
        const fileReader = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
        const util = await import("../util");
        vi.mocked(util.selectSingleFileHandle).mockResolvedValueOnce(file);
        const { alertWait } = await import("../alert");
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(value) {
                    controller = value;
                },
            }),
        );
        const realFetch = server.current.fetch.bind(server.current);
        const fetch = vi.spyOn(server.current, "fetch").mockImplementation((url, init) => {
            if (url !== "/api/import/module") return realFetch(url, init);
            expect(alerts.confirm.mock.calls).toEqual([
                [language.lowLevelAccessConfirm],
                [language.bootstrap.resetLorebookQuestion],
            ]);
            return Promise.resolve(response);
        });
        const before = list();
        const importing = modules.importModule();
        await vi.advanceTimersByTimeAsync(0);
        const requests = fetch.mock.calls.filter(([url]) => url === "/api/import/module");
        expect(requests).toHaveLength(1);
        expect((requests[0][1] as RequestInit).body).toBe(file);
        expect(slices.mock.calls).toEqual([
            [0, 6],
            [6, 6 + bytes.readUInt32LE(2)],
        ]);
        expect(wholeRead).not.toHaveBeenCalled();
        expect(fileReader).not.toHaveBeenCalled();
        for (let done = 1; done <= 2; done++) {
            controller.enqueue(encode({ done, total: 2 }));
            controller.enqueue(new TextEncoder().encode("\n"));
            await vi.advanceTimersByTimeAsync(0);
            expect(alertWait).toHaveBeenLastCalledWith(`Loading... (Adding Assets ${done} / 2)`);
            expect(list()).toEqual(before);
            expect(alerts.normal).not.toHaveBeenCalled();
        }
        controller.enqueue(
            new TextEncoder().encode(
                ndjson({
                    module: {
                        ...source,
                        id: "server-id",
                        name: "Server name",
                        description: "Server description",
                        lowLevelAccess: false,
                        assets: [
                            ["Server icon", "assets/icon.png", "png"],
                            ["Server banner", "assets/banner.png", "png"],
                        ],
                    },
                    assetsWritten: 1,
                    assetsSkipped: 1,
                }),
            ),
        );
        controller.close();
        await importing;
        const added = list().filter((module) => !before.some((old) => old.id === module.id));
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
            ...source,
            lorebook: [],
            id: expect.stringMatching(UUID_V4),
            assets: [
                ["Local icon", "assets/icon.png", "webp"],
                ["Local banner", "assets/banner.png", "jpg"],
            ],
        });
        expect(added[0].id).not.toBe(source.id);
        expect(alerts.normal).toHaveBeenCalledExactlyOnceWith(language.successImport);
        await sync.flushResources();
        expect(record("modules")).toEqual(list());
    });

    it.each([
        { name: "invalid file", status: 400, error: "Invalid module file", message: () => language.errors.noData },
        {
            name: "file too large",
            status: 413,
            error: "File too large",
            message: () => language.moduleImportFileTooLarge,
        },
        {
            name: "asset too large",
            status: 413,
            error: "Asset too large",
            message: () => language.moduleImportAssetTooLarge,
        },
        { name: "conflict", status: 409, error: "busy", message: () => language.moduleImportBusy },
        { name: "rate limit", status: 429, error: "busy", message: () => language.moduleImportBusy },
        { name: "timeout", status: 408, error: "expired", message: () => language.moduleImportTimeout },
        {
            name: "authentication text",
            status: 400,
            error: "Invalid authentication",
            message: () => "Invalid authentication",
        },
        { name: "other 413 text", status: 413, error: "Proxy limit", message: () => "Proxy limit" },
        { name: "other HTTP error text", status: 500, error: "Store unavailable", message: () => "Store unavailable" },
        {
            name: "non-JSON HTTP error",
            status: 502,
            message: () => language.moduleImportRequestFailed.replace("{{status}}", "502"),
        },
        {
            name: "failure line",
            body: ndjson({ error: "Disk full" }),
            message: () => language.moduleImportStopped.replace("{{error}}", "Disk full"),
        },
        { name: "fetch disconnected", network: "fetch", message: () => language.moduleImportInterrupted },
        { name: "body disconnected", network: "body", message: () => language.moduleImportInterrupted },
        { name: "malformed answer", body: "not NDJSON\n", message: () => language.errors.noData },
        {
            name: "different asset count",
            body: ndjson({
                module: { id: "server-id", name: "Wrong", assets: [] },
                assetsWritten: 0,
                assetsSkipped: 0,
            }),
            message: () => language.errors.noData,
        },
    ])("alerts and adds nothing after one request: $name", async (testCase) => {
        const { modules, list } = await boot();
        // A shorter server list must be refused, even though copying zero keys would not throw.
        const bytes = await packedMain(
            JSON.stringify({
                type: "risuModule",
                module: { name: "Refused", id: "file-id", assets: [["icon", "", "png"]] },
            }),
        );
        picker.file = { name: "refused.risum", data: bytes };
        const before = list();
        const realFetch = server.current.fetch.bind(server.current);
        const fetch = vi.spyOn(server.current, "fetch").mockImplementation(async (url, init) => {
            if (url !== "/api/import/module") return realFetch(url, init);
            if (testCase.network === "fetch") throw new TypeError("network lost");
            if (testCase.network === "body")
                return new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.error(new TypeError("body lost"));
                        },
                    }),
                );
            if (testCase.status)
                return new Response(
                    testCase.error ? JSON.stringify({ error: testCase.error }) : "<html>proxy failure</html>",
                    { status: testCase.status },
                );
            return new Response(testCase.body);
        });
        let settled = false;
        const importing = modules.importModule().finally(() => (settled = true));
        await vi.advanceTimersByTimeAsync(180_000);
        expect(settled).toBe(true);
        await importing;
        expect(fetch.mock.calls.filter(([url]) => url === "/api/import/module")).toHaveLength(1);
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(testCase.message());
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(list()).toEqual(before);
    });

    it("launch queue uploads the File and adds a fresh module with a success alert", async () => {
        const { modules, cards, list } = await boot();
        const bytes = await modules.exportModuleLegacy(
            { id: "launch-id", name: "Launched", description: "" },
            { saveData: false, alertEnd: false },
        );
        const file = new File([new Uint8Array(bytes)], "launched.risum");
        const read = vi.spyOn(file, "arrayBuffer");
        const fetch = vi.spyOn(server.current, "fetch");
        const setConsumer = vi.fn();
        vi.stubGlobal("launchQueue", { setConsumer });
        vi.stubGlobal("location", new URL("http://localhost/"));
        const before = list();
        await cards.characterURLImport();
        expect(setConsumer).toHaveBeenCalledTimes(1);
        setConsumer.mock.calls[0][0]({ files: [{ name: file.name, getFile: async () => file }] });
        await vi.advanceTimersByTimeAsync(0);
        const requests = fetch.mock.calls.filter(([url]) => url === "/api/import/module");
        expect(requests).toHaveLength(1);
        expect((requests[0][1] as RequestInit).body).toBe(file);
        // The fake server consumes the body once; the tab only reads slices.
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.invocationCallOrder[0]).toBeGreaterThan(fetch.mock.invocationCallOrder[0]);
        expect(list()).toHaveLength(before.length + 1);
        expect(list().at(-1)).toMatchObject({ name: "Launched", id: expect.stringMatching(UUID_V4) });
        expect(list().at(-1).id).not.toBe("launch-id");
        expect(alerts.normal).toHaveBeenCalledExactlyOnceWith(language.successImport);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it.each(["#share_module", "#import=http://localhost/module.risum"])(
        "%s hands the response Blob to importModuleFile without reading its bytes",
        async (hash) => {
            const { modules, cards, list } = await boot();
            const file = new Blob(["opaque .risum bytes"]);
            const response = new Response("opaque response", {
                headers: { "content-disposition": 'attachment; filename="module.risum"' },
            });
            vi.spyOn(response, "blob").mockResolvedValue(file);
            const readResponse = vi.spyOn(response, "arrayBuffer");
            const readFile = vi.spyOn(file, "arrayBuffer");
            // Stop at the handoff: successful link imports already have their own coverage.
            const importFile = vi.spyOn(modules, "importModuleFile").mockResolvedValueOnce(null);
            vi.stubGlobal("location", new URL("http://localhost/" + hash));
            vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => response),
            );
            vi.stubGlobal("caches", {
                open: async () => ({ match: async () => response, delete: vi.fn() }),
            });
            const before = list();
            await cards.characterURLImport();
            expect(importFile).toHaveBeenCalledTimes(1);
            expect(importFile.mock.calls[0][0]).toBe(file);
            expect(readResponse).not.toHaveBeenCalled();
            expect(readFile).not.toHaveBeenCalled();
            expect(list()).toEqual(before);
            expect(alerts.error).not.toHaveBeenCalled();
            expect(alerts.normal).not.toHaveBeenCalled();
        },
    );

    it("CharX still reads its embedded module.risum locally", async () => {
        const { modules, cards, characterList } = await boot();
        const embedded = {
            id: "embedded",
            name: "Embedded",
            lorebook: [lore("Embedded lore", "embedded content")],
            regex: [regex("Embedded regex")],
            trigger: [],
        };
        const bytes = await modules.exportModuleLegacy(embedded as any, { saveData: false, alertEnd: false });
        const before = characterList().length;
        const fetch = vi.spyOn(server.current, "fetch");
        await cards.importCharacterProcess({
            name: "embedded.charx",
            data: charx(cardV3("Embedded card"), { "module.risum": bytes }),
        });
        expect(characterList()).toHaveLength(before + 1);
        expect(characterList().at(-1)).toMatchObject({
            globalLore: [expect.objectContaining(lore("Embedded lore", "embedded content"))],
            customscript: embedded.regex,
        });
        expect(fetch.mock.calls.filter(([url]) => url === "/api/import/module")).toHaveLength(0);
        expect(alerts.error).not.toHaveBeenCalled();
    });
});
