import { readFileSync } from "node:fs";
import path from "node:path";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { cardV3, charx } from "./storage/tests/importFixtures";
import { bootMutations, plain } from "./storage/tests/mutationStoresHarness";

// WEB-01: the page consumes pending shares through Cache Storage, including before SW control.
// Keep the importers and record writes real; stub only external services and user decisions.
const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        store: { set: vi.fn(), subscribe: vi.fn() },
    },
}));

vi.mock("./storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("./alert", () => ({
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
vi.mock("./rpack/rpack_js", () => {
    const map = new Uint8Array(readFileSync(path.resolve(__dirname, "rpack/rpack_map.bin")));
    const apply = (table: Uint8Array) => async (data: Uint8Array) => {
        const result = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = table[data[i]];
        }
        return result;
    };
    return { encodeRPack: apply(map.slice(0, 256)), decodeRPack: apply(map.slice(256, 512)) };
});

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const globalApi = await import("./globalApi.svelte");
    vi.spyOn(globalApi, "saveAsset").mockResolvedValue("asset");
    vi.spyOn(await import("./util"), "sleep").mockResolvedValue(undefined);
    const modules = await import("./process/modules");
    const presets = await import("./storage/presets.svelte");
    const cards = await import("./characterCards");
    booted.stores.settingsOpen.set(false);
    booted.stores.SettingsMenuIndex.set(-1);
    return { ...booted, cards, modules, presets };
}

function pendingShare(kind: string, bytes?: Uint8Array) {
    vi.stubGlobal("location", {
        search: "",
        hash: `#share_${kind}`,
        href: "http://local/",
        origin: "http://local",
        pathname: "/",
        reload: vi.fn(),
    });
    const url = `http://local/sw/share/${kind}`;
    const entries = new Map<string, Response>();
    if (bytes) entries.set(url, new Response(new Uint8Array(bytes)));
    const cache = {
        match: vi.fn(async (key: URL) => entries.get(String(key))?.clone()),
        delete: vi.fn(async (key: URL) => entries.delete(String(key))),
    };
    const open = vi.fn(async () => cache);
    const fetch = vi.fn(() => {
        throw new Error("Share imports must not fetch");
    });
    vi.stubGlobal("caches", { open });
    vi.stubGlobal("fetch", fetch);
    return { url, entries, cache, open, fetch };
}

function expectRead(share: ReturnType<typeof pendingShare>) {
    expect(share.open).toHaveBeenCalledWith("risuCache");
    expect(share.cache.match).toHaveBeenCalledTimes(1);
    expect(String(share.cache.match.mock.calls[0][0])).toBe(share.url);
    expect(share.fetch).not.toHaveBeenCalled();
}

async function moduleBytes(booted: Awaited<ReturnType<typeof boot>>, lorebook: unknown = []) {
    return booted.modules.exportModuleLegacy(
        { name: "Shared module", description: "", id: "source-id", lorebook, regex: [], trigger: [] } as any,
        { saveData: false, alertEnd: false },
    );
}

beforeAll(async () => {
    await import("./stores.svelte");
    await import("./storage/database.svelte");
    await import("./process/modules");
}, 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    alerts.confirm.mockResolvedValue(true);
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("characterURLImport pending shares", () => {
    it("imports a module, opens module settings, then consumes its entry", async () => {
        const app = await boot();
        const share = pendingShare("module", await moduleBytes(app));
        share.cache.delete.mockImplementation(async (key) => {
            expect(app.settings.modules.map((module) => module.name)).toEqual(["Shared module"]);
            expect(get(app.stores.settingsOpen)).toBe(true);
            expect(get(app.stores.SettingsMenuIndex)).toBe(14);
            expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
            return share.entries.delete(String(key));
        });
        await app.cards.characterURLImport();
        expectRead(share);
        expect(share.entries.has(share.url)).toBe(false);
        expect(app.settings.modules[0].id).not.toBe("source-id");
    });

    it("imports a preset, opens prompt settings, then consumes its entry", async () => {
        const app = await boot();
        const ids = app.settings.presets.map((preset) => preset.id);
        const bytes = new Uint8Array(
            readFileSync(path.resolve(__dirname, "storage/tests/fixtures/phase3/custom.risup")),
        );
        const before = app.settings.presets.length;
        const share = pendingShare("preset", bytes);
        share.cache.delete.mockImplementation(async (key) => {
            expect(app.settings.presets).toHaveLength(before + 1);
            expect(app.settings.presets.at(-1).name).toBe("커스텀 プリセット ✓");
            expect(ids).not.toContain(app.settings.presets.at(-1).id);
            expect(get(app.stores.settingsOpen)).toBe(true);
            expect(get(app.stores.SettingsMenuIndex)).toBe(app.stores.PROMPT_SETTINGS_MENU);
            return share.entries.delete(String(key));
        });
        await app.cards.characterURLImport();
        expectRead(share);
        expect(share.entries.has(share.url)).toBe(false);
    });

    it("imports a CharX character before consuming its entry", async () => {
        const app = await boot();
        const before = app.characterList().length;
        const share = pendingShare("character", charx(cardV3("Shared character")));
        share.cache.delete.mockImplementation(async (key) => {
            expect(app.characterList()).toHaveLength(before + 1);
            expect(app.characterList().at(-1).name).toBe("Shared character");
            return share.entries.delete(String(key));
        });
        await app.cards.characterURLImport();
        expectRead(share);
        expect(share.entries.has(share.url)).toBe(false);
    });

    it("retains a cancelled module for a later successful import", async () => {
        const app = await boot();
        const bytes = await moduleBytes(app, "corrupt lorebook");
        const share = pendingShare("module", bytes);
        alerts.confirm.mockResolvedValueOnce(false);
        await app.cards.characterURLImport();
        expectRead(share);
        expect(alerts.confirm).toHaveBeenCalledWith(language.bootstrap.resetLorebookQuestion);
        expect(app.settings.modules).toHaveLength(0);
        expect(get(app.stores.settingsOpen)).toBe(false);
        expect(share.cache.delete).not.toHaveBeenCalled();
        expect(new Uint8Array(await share.entries.get(share.url)!.clone().arrayBuffer())).toEqual(bytes);
        expect(alerts.normal).not.toHaveBeenCalled();
        await app.cards.characterURLImport();
        expect(app.settings.modules).toHaveLength(1);
        expect(share.entries.has(share.url)).toBe(false);
        expect(share.fetch).not.toHaveBeenCalled();
    });

    it("retains a preset when its importer returns no id", async () => {
        const app = await boot();
        const importer = vi.spyOn(app.presets, "importPreset").mockResolvedValue(undefined);
        const bytes = new Uint8Array([1, 2, 3]);
        const share = pendingShare("preset", bytes);
        await app.cards.characterURLImport();
        expect(importer).toHaveBeenCalledWith({ name: "shared.risup", data: bytes });
        expectRead(share);
        expect(share.entries.has(share.url)).toBe(true);
        expect(share.cache.delete).not.toHaveBeenCalled();
        expect(get(app.stores.settingsOpen)).toBe(false);
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("retains a character when its importer refuses the card", async () => {
        const app = await boot();
        const before = plain(app.characterList());
        const share = pendingShare("character", charx({ spec: "unsupported" }));
        await app.cards.characterURLImport();
        expectRead(share);
        expect(app.characterList()).toEqual(before);
        expect(share.entries.has(share.url)).toBe(true);
        expect(share.cache.delete).not.toHaveBeenCalled();
    });

    it("retains a share when its importer throws", async () => {
        const app = await boot();
        const error = new Error("import failed");
        vi.spyOn(app.modules, "readModule").mockRejectedValueOnce(error);
        const share = pendingShare("module", new Uint8Array([1, 2, 3]));
        await expect(app.cards.characterURLImport()).rejects.toBe(error);
        expectRead(share);
        expect(share.entries.has(share.url)).toBe(true);
        expect(share.cache.delete).not.toHaveBeenCalled();
        expect(app.settings.modules).toHaveLength(0);
    });

    it.each(["character", "preset", "module"])(
        "ignores a missing %s entry or unavailable Cache Storage silently",
        async (kind) => {
            const app = await boot();
            const before = app.mirrorText();
            const share = pendingShare(kind);
            await app.cards.characterURLImport();
            expectRead(share);
            expect(share.cache.delete).not.toHaveBeenCalled();
            vi.stubGlobal("caches", undefined);
            await app.cards.characterURLImport();
            expect(app.mirrorText()).toBe(before);
            expect(alerts.normal).not.toHaveBeenCalled();
            expect(alerts.error).not.toHaveBeenCalled();
            expect(alerts.store.set).not.toHaveBeenCalled();
            expect(share.fetch).not.toHaveBeenCalled();
        },
    );
});
