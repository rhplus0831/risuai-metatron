import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { cardV3, characterBook, charx } from "../storage/tests/importFixtures";
import { bootMutations, plain } from "../storage/tests/mutationStoresHarness";

// The old-lorebook conversion (`upgradeLorebook`, what the startup `updateLorebooks` step did
// before) runs on every module import path through `prepareModuleImport`, before `addModule`: the
// module dialog's `.risum`, CharX, module JSON, native lore JSON, and external lore JSON, and the
// module links of `characterURLImport` (`#import_module=`, `#share_module`, a `.risum` behind
// `#import=`). A lorebook that is not a list is reported and imported empty only when the user
// agrees; one whose entries cannot be read is refused with `noData`. Ordinary module mutations
// never convert (`settingsRecords.test.ts`).

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
vi.mock("../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertConfirm: alerts.confirm,
        alertStore: alerts.store,
    }),
);
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
    // The dialog answers the picked `File` itself, built from `picker.file`.
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

const OLD = "<char> greets <user>\n@@end";
const UPGRADED = "{{char}} greets {{user}}\n@@depth 0";
const oldLore = (comment: string) => ({ ...lore(comment, OLD), activationPercent: 30 });
const expectUpgraded = (entry: any) => {
    expect(entry.content).toBe(`@@probability 30\n${UPGRADED}`);
    expect(entry.bookVersion).toBe(2);
    expect(entry.activationPercent).toBeNull();
};

describe("importModule converts an old-format lorebook on every file kind", () => {
    it(".risum", async () => {
        const { modules, imported } = await boot();
        const bytes = await modules.exportModuleLegacy(
            { name: "Packed", description: "", id: "f", lorebook: [oldLore("Packed")], regex: [], trigger: [] } as any,
            { saveData: false, alertEnd: false },
        );
        const { module } = await imported({ name: "old.risum", data: bytes });
        expectUpgraded(module.lorebook[0]);
    });

    it("module JSON, native lore JSON, and external lore JSON", async () => {
        const { imported } = await boot();
        const native = await imported({
            name: "module.json",
            data: encode({ type: "risuModule", name: "N", id: "x", lorebook: [oldLore("N")] }),
        });
        expectUpgraded(native.module.lorebook[0]);
        const lorebook = await imported({
            name: "lore.json",
            data: encode({ type: "risu", ver: 1, data: [oldLore("L")] }),
        });
        expectUpgraded(lorebook.module.lorebook[0]);
        const external = await imported({
            name: "world.json",
            data: encode({ name: "World", entries: { "0": { keys: ["w"], content: OLD, comment: "W" } } }),
        });
        expect(external.module.lorebook[0].content).toBe(UPGRADED);
        expect(external.module.lorebook[0].bookVersion).toBe(2);
    });

    it("CharX", async () => {
        const { imported } = await boot();
        const card = cardV3("Mod", { character_book: characterBook("Mod lore", OLD) });
        const { module } = await imported({ name: "mod.charx", data: charx(card) });
        expect(module.lorebook[0].comment).toBe("Mod lore");
        expect(module.lorebook[0].content).toBe(UPGRADED);
        expect(module.lorebook.every((entry: any) => entry.bookVersion === 2)).toBe(true);
    });

    it("keeps an entry already at version 2 as it is (the conversion is idempotent)", async () => {
        const { imported } = await boot();
        const current = { ...lore("Current", OLD), bookVersion: 2 };
        const { module } = await imported({
            name: "module.json",
            data: encode({ type: "risuModule", name: "C", id: "x", lorebook: [current] }),
        });
        expect(module.lorebook).toEqual([current]);
    });
});

describe("importModule with a lorebook it cannot convert", () => {
    it("asks before importing a non-list lorebook as an empty one, and adds nothing when declined", async () => {
        const { modules, list, sync, record } = await boot();
        const before = list();
        alerts.confirm.mockResolvedValueOnce(false);
        picker.file = {
            name: "bad.json",
            data: encode({ type: "risuModule", name: "Corrupt", id: "x", lorebook: { a: 1 } }),
        };
        await modules.importModule();
        expect(alerts.error).toHaveBeenCalledWith(language.bootstrap.dataCorruptionDetected("Corrupt", "object"));
        expect(alerts.confirm).toHaveBeenLastCalledWith(language.bootstrap.resetLorebookQuestion);
        expect(list()).toEqual(before);
        await sync.flushResources();
        expect(record("modules")).toEqual(before);

        alerts.confirm.mockResolvedValueOnce(true);
        picker.file = {
            name: "bad.json",
            data: encode({ type: "risuModule", name: "Corrupt", id: "x", lorebook: "x" }),
        };
        await modules.importModule();
        const added = list().filter((module) => !before.some((old: any) => old.id === module.id));
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ name: "Corrupt", lorebook: [] });
        await sync.flushResources();
        expect(record("modules")).toEqual(list());
    });

    it("refuses a lorebook whose entries cannot be read with noData, never success, and adds nothing", async () => {
        const { modules, list, sync, record } = await boot();
        const before = list();
        picker.file = {
            name: "bad.json",
            data: encode({ type: "risuModule", name: "Nulls", id: "x", lorebook: [null] }),
        };
        await modules.importModule();
        expect(alerts.error).toHaveBeenCalledWith(language.errors.noData);
        expect(alerts.normal).not.toHaveBeenCalledWith(language.successImport);
        expect(list()).toEqual(before);
        await sync.flushResources();
        expect(record("modules")).toEqual(before);
    });
});

describe("the module links of characterURLImport convert too", () => {
    const linkLocation = (hash: string) =>
        vi.stubGlobal("location", { search: "", hash, href: "http://local/", origin: "http://local", reload: vi.fn() });

    it("#import_module=", async () => {
        const { cards, list } = await boot();
        const before = list().length;
        const payload = Buffer.from(JSON.stringify({ name: "Linked", lorebook: [oldLore("Linked")] })).toString(
            "base64",
        );
        linkLocation(`#import_module=${encodeURIComponent(payload)}`);
        await cards.characterURLImport();
        expect(list()).toHaveLength(before + 1);
        expectUpgraded(list().at(-1).lorebook[0]);
    });

    it("#share_module (a pending share in Cache Storage) and a .risum behind #import=", async () => {
        const { cards, modules, list } = await boot();
        const bytes = await modules.exportModuleLegacy(
            { name: "Shared", description: "", id: "s", lorebook: [oldLore("Shared")], regex: [], trigger: [] } as any,
            { saveData: false, alertEnd: false },
        );
        // The share target's worker stored the file; the page reads it from Cache Storage and
        // consumes it once imported. The `fetch` stub below serves only the `#import=` link.
        const shareUrl = "http://local/sw/share/module";
        const pending = new Map([[shareUrl, new Response(new Uint8Array(bytes))]]);
        vi.stubGlobal("caches", {
            open: async () => ({
                match: async (key: URL) => pending.get(String(key))?.clone(),
                delete: async (key: URL) => pending.delete(String(key)),
            }),
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(new Uint8Array(bytes), {
                        headers: { "content-disposition": 'attachment; filename="shared.risum"' },
                    }),
            ),
        );
        const before = list().length;
        linkLocation("#share_module");
        await cards.characterURLImport();
        expect(list()).toHaveLength(before + 1);
        expectUpgraded(list().at(-1).lorebook[0]);
        expect(pending.has(shareUrl)).toBe(false);
        linkLocation("#import=http%3A%2F%2Flocal%2Fshared.risum");
        await cards.characterURLImport();
        expect(list()).toHaveLength(before + 2);
        expectUpgraded(list().at(-1).lorebook[0]);
    });
});
