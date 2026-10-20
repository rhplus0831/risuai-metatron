import { readFileSync } from "node:fs";
import path from "node:path";
import { get } from "svelte/store";
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

const { server, alerts, picker } = vi.hoisted(() => {
    // The alert helpers write the booted graph's `stores.svelte` `alertStore` as the real ones do
    // (`boot` installs it in `current`): `addImportedModule` reads it back to replace only its own
    // wait alert (data-loss plan slice 5b). The `vi.fn` wrappers keep the calls for the assertions.
    const alerts = {
        current: null as null | { set: (data: { type: string; msg: string }) => void },
        show: (type: string) => (msg: unknown) => alerts.current?.set({ type, msg: String(msg) }),
        error: vi.fn((msg: unknown) => alerts.show("error")(msg)),
        normal: vi.fn((msg: unknown) => alerts.show("normal")(msg)),
        wait: vi.fn((msg: unknown) => alerts.show("wait")(msg)),
        clear: vi.fn(() => alerts.current?.set({ type: "none", msg: "" })),
        reload: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        store: { set: vi.fn(), subscribe: vi.fn() },
    };
    return {
        server: { current: null as any },
        alerts,
        picker: { file: null as { name: string; data: Uint8Array } | null },
    };
});

vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: alerts.confirm,
    alertReloadNotice: alerts.reload,
    alertStore: alerts.store,
    alertWait: alerts.wait,
    alertInput: vi.fn(async () => ""),
    alertSelect: vi.fn(async () => ""),
    alertAddCharacter: vi.fn(),
    alertCardExport: vi.fn(),
    alertClear: alerts.clear,
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
    alerts.current = booted.stores.alertStore;
    /** The alert on screen (the booted graph's `alertStore`), as `{ type, msg }`. */
    const shown = () => {
        const { type, msg } = get(booted.stores.alertStore);
        return { type, msg };
    };
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
    return { ...booted, modules, cards, list, imported, order, shown };
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
    alerts.current = null;
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

// Data-loss plan slice 5b: `importModule` adds through `addImportedModule`, which flushes the save
// in a mutation scope and alerts only after the acknowledgement: `successImport` (`.risum`, CharX) or
// a cleared wait alert (the JSON kinds) while its own `moduleImportSaving` wait alert is still on
// screen; `moduleImportDiscarded` when a conflict replaced this tab's modules (also when the flush
// fails afterwards); `moduleImportUnconfirmed` when the flush fails with the module still listed.
describe("the import alert waits for the acknowledgement (data-loss plan slice 5b)", () => {
    const names = (list: any[]) => list.map((entry) => entry.name);
    /**
     * Whether `alertClear` ran after the last `moduleImportSaving` wait alert (the `.risum` upload
     * clears its own progress alert before the add, which is not the helper's clear).
     */
    const clearedAfterSaving = () => {
        const saving = alerts.wait.mock.calls.flatMap((call, index) =>
            call[0] === language.moduleImportSaving ? [alerts.wait.mock.invocationCallOrder[index]] : [],
        );
        expect(saving.length).toBeGreaterThan(0);
        const last = Math.max(...saving);
        return alerts.clear.mock.invocationCallOrder.some((order) => order > last);
    };
    /** A `.risum` of a module named `name` (the dialog's announcing branch). */
    const risum = async (modules: Awaited<ReturnType<typeof boot>>["modules"], name: string) => ({
        name: `${name}.risum`,
        data: await modules.exportModuleLegacy(
            { id: "file-id", name, description: "" },
            { saveData: false, alertEnd: false },
        ),
    });
    /** A native module JSON (the dialog's silent branch). */
    const json = (name: string) => ({
        name: `${name}.json`,
        data: encode({ type: "risuModule", name, id: "old", description: "", lorebook: [] }),
    });
    /** Routes every request through the real server, with `around` run per request (a hook before, or a hold after, the answer). */
    const intercept = (around: (url: string, answer: () => Promise<Response>) => Promise<Response>) => {
        const realFetch = server.current.fetch.bind(server.current) as (
            url: string,
            init?: RequestInit,
        ) => Promise<Response>;
        return vi
            .spyOn(server.current, "fetch")
            .mockImplementation((url: string, init?: RequestInit) => around(url, () => realFetch(url, init)));
    };
    /** Saves a module `m0` so a later conflict has a saved item to be about. */
    const saved = async (h: Awaited<ReturnType<typeof boot>>) => {
        const id = h.collectionStore.addModule({ id: "m0", name: "m0", lorebook: [] });
        await h.sync.flushResources();
        h.fake.requests.length = 0;
        return id;
    };
    /** Another tab's write of the server's modules: `change` applied to the stored list. */
    const remote = (fake: any, change: (list: any[]) => void) => {
        const list = JSON.parse(JSON.stringify(fake.record("modules", "main").data));
        change(list);
        fake.set("modules", "main", list);
    };

    it("shows successImport only once the batch is acknowledged: the saving wait alert meanwhile, one batch, the module on the server", async () => {
        const h = await boot();
        const { modules, list, record, fake, shown } = h;
        picker.file = await risum(modules, "Waited");
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        intercept(async (url, answer) => {
            const response = await answer();
            if (url === "/api/resources/batch") {
                await held;
            }
            return response;
        });
        let settled = false;
        const importing = modules.importModule().finally(() => (settled = true));
        await vi.advanceTimersByTimeAsync(2_000);
        // The server applied the batch; its answer is held: the module is listed, nothing announced yet.
        expect(settled).toBe(false);
        expect(names(list())).toEqual(["Waited"]);
        expect(names(record("modules"))).toEqual(["Waited"]);
        expect(shown()).toEqual({ type: "wait", msg: language.moduleImportSaving });
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(clearedAfterSaving()).toBe(false);
        release();
        await importing;
        expect(alerts.normal).toHaveBeenCalledExactlyOnceWith(language.successImport);
        expect(shown()).toEqual({ type: "normal", msg: language.successImport });
        expect(alerts.error).not.toHaveBeenCalled();
        expect(fake.batchCount()).toBe(1);
    });

    it("a JSON import stays silent: its wait alert is cleared after the acknowledgement, no success alert", async () => {
        const { modules, list, record, shown } = await boot();
        picker.file = json("Quiet");
        await modules.importModule();
        expect(names(list())).toEqual(["Quiet"]);
        expect(names(record("modules"))).toEqual(["Quiet"]);
        expect(alerts.wait).toHaveBeenCalledWith(language.moduleImportSaving);
        expect(alerts.clear).toHaveBeenCalledTimes(1);
        expect(shown()).toEqual({ type: "none", msg: "" });
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("an import alone survives another tab's rename of a different module: both saved, success announced, no notice", async () => {
        const h = await boot();
        const { modules, list, record, fake, sync } = h;
        await saved(h);
        remote(fake, (modules) => (modules[0].name = "theirs"));
        picker.file = await risum(modules, "Mine");
        await modules.importModule();
        expect(names(list())).toEqual(["theirs", "Mine"]);
        expect(names(record("modules"))).toEqual(["theirs", "Mine"]);
        expect(sync.heldRecordRevision("modules", "main")).toBe(fake.record("modules", "main")!.revision);
        expect(alerts.normal).toHaveBeenCalledExactlyOnceWith(language.successImport);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.reload).not.toHaveBeenCalled();
        // The rejected batch and the merged retry.
        expect(fake.batchCount()).toBe(2);
    });

    it("a conflict that discards this tab's modules (an unsent edit of a saved module alongside the import) reports moduleImportDiscarded, never success", async () => {
        const h = await boot();
        const { modules, list, record, fake, collectionStore } = h;
        const m0 = await saved(h);
        collectionStore.updateModule(m0, { name: "mine" });
        remote(fake, (modules) => (modules[0].name = "theirs"));
        picker.file = await risum(modules, "Lost");
        await modules.importModule();
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(language.moduleImportDiscarded);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(clearedAfterSaving()).toBe(false);
        expect(alerts.reload).toHaveBeenCalledTimes(1);
        expect(names(list())).toEqual(["theirs"]);
        expect(names(record("modules"))).toEqual(["theirs"]);
    });

    it("a discard followed by a failing flush (another record's save) still reports the discard, not an unconfirmed save", async () => {
        const h = await boot();
        const { modules, list, record, fake, sync, collectionStore } = h;
        const m0 = await saved(h);
        collectionStore.updateModule(m0, { name: "mine" });
        collectionStore.addPreset({ name: "p3" });
        remote(fake, (modules) => (modules[0].name = "theirs"));
        // The first batch (modules and presets) conflicts; the presets retry fails.
        let batches = 0;
        intercept(async (url, answer) => {
            if (url === "/api/resources/batch" && ++batches === 2) {
                return Response.json({ error: "down" }, { status: 503 });
            }
            return answer();
        });
        picker.file = await risum(modules, "Lost");
        await modules.importModule();
        expect(batches).toBe(2);
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(language.moduleImportDiscarded);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(names(list())).toEqual(["theirs"]);
        expect(names(record("modules"))).toEqual(["theirs"]);
        // The preset is saved by the ordinary retry.
        await vi.advanceTimersByTimeAsync(35_000);
        await sync.flushResources();
        expect(names(record("presets"))).toContain("p3");
    });

    it("a failed flush with the module still listed reports moduleImportUnconfirmed with the reason; the module is saved later", async () => {
        const h = await boot();
        const { modules, list, record, fake, sync } = h;
        fake.failNext = { status: 0, times: 1, match: (path: string) => path === "/api/resources/batch" };
        picker.file = await risum(modules, "Unconfirmed");
        await modules.importModule();
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(
            language.moduleImportUnconfirmed.replace("{{error}}", "Failed to fetch"),
        );
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(names(list())).toEqual(["Unconfirmed"]);
        expect(record("modules") ?? []).toEqual([]);
        await vi.advanceTimersByTimeAsync(35_000);
        await sync.flushResources();
        expect(names(record("modules"))).toEqual(["Unconfirmed"]);
    });

    it("keeps an error alert that appeared while the import waited: no success alert and no clear over it", async () => {
        const { modules, list, record, fake, shown } = await boot();
        // An unrelated failure alerted during the save (as a refused credential write would be).
        intercept(async (url, answer) => {
            const response = await answer();
            if (url === "/api/resources/batch") {
                alerts.error("unrelated failure");
            }
            return response;
        });
        picker.file = await risum(modules, "Announced");
        await modules.importModule();
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(clearedAfterSaving()).toBe(false);
        expect(shown()).toEqual({ type: "error", msg: "unrelated failure" });
        expect(names(list())).toEqual(["Announced"]);
        expect(names(record("modules"))).toEqual(["Announced"]);

        alerts.error.mockClear();
        picker.file = json("Silent");
        await modules.importModule();
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(clearedAfterSaving()).toBe(false);
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith("unrelated failure");
        expect(shown()).toEqual({ type: "error", msg: "unrelated failure" });
        expect(names(record("modules"))).toEqual(["Announced", "Silent"]);
        expect(fake.batchCount()).toBe(2);
    });

    // Open-bug-fixes slice C5: the link and file entry points in `characterCards.ts` add through
    // `addImportedModule` too, and open the module settings only once the save is acknowledged.
    const ENTRIES = ["#import_module=", "#import=", "launch queue"] as const;
    /**
     * Starts `entry`'s import of a module named `name`. `importing` is the hash import's own promise;
     * the launch queue's consumer returns nothing, so its import ends with the timers advanced after it.
     */
    const startEntry = async (
        h: Awaited<ReturnType<typeof boot>>,
        entry: (typeof ENTRIES)[number],
        name: string,
    ): Promise<{ importing: Promise<unknown> }> => {
        const { modules, cards, stores } = h;
        stores.settingsOpen.set(false);
        stores.SettingsMenuIndex.set(-1);
        if (entry === "#import_module=") {
            const data = Buffer.from(
                JSON.stringify({ type: "risuModule", name, id: "link-id", description: "", lorebook: [] }),
            ).toString("base64");
            vi.stubGlobal("location", new URL(`http://localhost/#import_module=${encodeURIComponent(data)}`));
            return { importing: cards.characterURLImport() };
        }
        const file = new File([new Uint8Array((await risum(modules, name)).data)], `${name}.risum`);
        if (entry === "#import=") {
            vi.stubGlobal("location", new URL("http://localhost/#import=http://localhost/linked.risum"));
            vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
            const response = new Response("opaque", {
                headers: { "content-disposition": `attachment; filename="${name}.risum"` },
            });
            vi.spyOn(response, "blob").mockResolvedValue(file);
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => response),
            );
            return { importing: cards.characterURLImport() };
        }
        const setConsumer = vi.fn();
        vi.stubGlobal("launchQueue", { setConsumer });
        vi.stubGlobal("location", new URL("http://localhost/"));
        await cards.characterURLImport();
        setConsumer.mock.calls[0][0]({ files: [{ name: file.name, getFile: async () => file }] });
        return { importing: Promise.resolve() };
    };
    const settingsShown = (h: Awaited<ReturnType<typeof boot>>) =>
        get(h.stores.settingsOpen) === true && get(h.stores.SettingsMenuIndex) === 14;

    it.each(ENTRIES)(
        "%s shows successImport and the module settings only once the batch is acknowledged",
        async (entry) => {
            const h = await boot();
            const { list, record, fake, shown } = h;
            let release!: () => void;
            const held = new Promise<void>((resolve) => (release = resolve));
            intercept(async (url, answer) => {
                const response = await answer();
                if (url === "/api/resources/batch") {
                    await held;
                }
                return response;
            });
            let settled = false;
            const importing = (await startEntry(h, entry, "Linked")).importing.finally(() => (settled = true));
            await vi.advanceTimersByTimeAsync(2_000);
            // The server applied the batch; its answer is held: the module is listed, nothing announced yet.
            expect(names(list())).toEqual(["Linked"]);
            expect(names(record("modules"))).toEqual(["Linked"]);
            expect(shown()).toEqual({ type: "wait", msg: language.moduleImportSaving });
            expect(alerts.normal).not.toHaveBeenCalled();
            expect(settingsShown(h)).toBe(false);
            if (entry !== "launch queue") {
                expect(settled).toBe(false);
            }
            release();
            await vi.advanceTimersByTimeAsync(0);
            await importing;
            expect(alerts.normal).toHaveBeenCalledExactlyOnceWith(language.successImport);
            expect(shown()).toEqual({ type: "normal", msg: language.successImport });
            expect(settingsShown(h)).toBe(true);
            expect(alerts.error).not.toHaveBeenCalled();
            expect(fake.batchCount()).toBe(1);
        },
    );

    it.each(ENTRIES)(
        "%s reports moduleImportDiscarded when a conflict discards this tab's modules: no success, no settings",
        async (entry) => {
            const h = await boot();
            const { list, record, fake, collectionStore } = h;
            const m0 = await saved(h);
            collectionStore.updateModule(m0, { name: "mine" });
            remote(fake, (modules) => (modules[0].name = "theirs"));
            const { importing } = await startEntry(h, entry, "Lost");
            await vi.advanceTimersByTimeAsync(2_000);
            await importing;
            expect(alerts.error).toHaveBeenCalledExactlyOnceWith(language.moduleImportDiscarded);
            expect(alerts.normal).not.toHaveBeenCalled();
            expect(clearedAfterSaving()).toBe(false);
            expect(settingsShown(h)).toBe(false);
            expect(names(list())).toEqual(["theirs"]);
            expect(names(record("modules"))).toEqual(["theirs"]);
        },
    );
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

    it("readModule fills keys into copies of the file's tuples: a pair and an extended tuple keep their shape, metadata past the records keeps its key", async () => {
        const { modules } = await boot();
        const { encodeRPack } = await import("../rpack/rpack_js");
        const main = await encodeRPack(
            encode({
                type: "risuModule",
                module: {
                    name: "Shapes",
                    id: "file-id",
                    lorebook: [],
                    assets: [
                        ["Pair", ""],
                        ["Quad", "", "png", "extra"],
                        ["Tail", "kept-key", "png"],
                    ],
                },
            }),
        );
        const record = await encodeRPack(new Uint8Array([137, 80, 78, 71]));
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
            length(record.length),
            record,
            Buffer.from([1]),
            length(record.length),
            record,
            Buffer.from([0]),
        ]);
        const globalApi = await import("../globalApi.svelte");
        let saved = 0;
        vi.spyOn(globalApi, "assetKey").mockImplementation(async () => `key-${saved++}`);
        vi.spyOn(globalApi, "saveAssetBatch").mockResolvedValue(undefined);
        const read = await modules.readModule(bytes);
        expect(read.assets).toEqual([
            ["Pair", "key-0"],
            ["Quad", "key-1", "png", "extra"],
            ["Tail", "kept-key", "png"],
        ]);
        expect(read.id).toMatch(UUID_V4);
    });

    it("importModuleFile takes the server's keys into copies of the file's tuples, keeping a pair's and an extended tuple's shape; the stored list is frozen", async () => {
        const { modules, list, sync, record, settings } = await boot();
        const source = {
            id: "file-id",
            name: "Shapes",
            description: "",
            lorebook: [],
            assets: [
                ["Pair", "", "png"],
                ["Quad", "", "png", "extra"],
                ["Short", ""],
            ],
        };
        const bytes = await packedMain(JSON.stringify({ type: "risuModule", module: source }));
        const realFetch = server.current.fetch.bind(server.current);
        const fetch = vi.spyOn(server.current, "fetch").mockImplementation((url, init) =>
            url !== "/api/import/module"
                ? realFetch(url, init)
                : Promise.resolve(
                      new Response(
                          ndjson({
                              module: {
                                  ...source,
                                  id: "server-id",
                                  assets: [
                                      ["Pair", "assets/pair.png", "png"],
                                      ["Quad", "assets/quad.png", "png", "extra"],
                                      ["Short", "assets/short.png"],
                                  ],
                              },
                              assetsWritten: 3,
                              assetsSkipped: 0,
                          }),
                      ),
                  ),
        );
        const before = list();
        picker.file = { name: "shapes.risum", data: bytes };
        await modules.importModule();
        expect(fetch.mock.calls.filter(([url]) => url === "/api/import/module")).toHaveLength(1);
        const added = list().filter((module) => !before.some((old) => old.id === module.id));
        expect(added).toHaveLength(1);
        expect(added[0].assets).toEqual([
            ["Pair", "assets/pair.png", "png"],
            ["Quad", "assets/quad.png", "png", "extra"],
            ["Short", "assets/short.png"],
        ]);
        const stored = settings.modules.find((module) => module.id === added[0].id)!;
        expect(Object.isFrozen(stored.assets)).toBe(true);
        expect(stored.assets!.every((tuple) => Object.isFrozen(tuple))).toBe(true);
        expect(alerts.error).not.toHaveBeenCalled();
        await sync.flushResources();
        expect(record("modules")).toEqual(list());
    });

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
