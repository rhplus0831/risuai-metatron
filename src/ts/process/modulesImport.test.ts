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

vi.mock("../storage/nodeStorage", () => ({
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
    // the first graph's `DBState`); the asset store, `sleep`, and the file dialog are spied per graph.
    const globalApi = await import("../globalApi.svelte");
    vi.spyOn(globalApi, "saveAsset").mockResolvedValue("asset");
    const util = await import("../util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    vi.spyOn(util, "selectSingleFile").mockImplementation(async () => picker.file as any);
    const modules = await import("./modules");
    const cards = await import("../characterCards");
    const { db, sync, record } = booted;
    const list = () => plain(db().modules) as any[];
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
    const order = () => plain(db().characterOrder) as unknown[];
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
        const { imported, db, order } = await boot();
        const characters = db().characters.length;
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
        expect(db().characters).toHaveLength(characters);
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
