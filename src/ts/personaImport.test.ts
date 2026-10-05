import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { pngWithText } from "./storage/tests/importFixtures";
import { bootMutations, plain } from "./storage/tests/mutationStoresHarness";

// Phase 4, slice 7 (`docs/plan/phases/slices/phase-4-external-contracts/imports-through-the-module.md`):
// `importUserPersona` reads the `persona` chunk of a PNG (the real chunk reader), saves the icon
// first (Phase 3's order), then adds the persona through `addPersona`, over the real save adapter
// and the real server store (`storeBackedServer.ts`). The persona gets an id, the saved icon, and
// its fields, keeps the selection, and is on the server after one cycle. A collection replaced while
// the icon was being saved receives the persona (the add reads the live list). A PNG without the
// chunk reports `noData` and adds nothing.

const { server, alerts, picker, saving } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        store: { set: vi.fn(), subscribe: vi.fn() },
    },
    picker: { file: null as { name: string; data: Uint8Array } | null },
    /** `saveAsset`: answers `icon` after `hold` resolves (a test sets `hold` to keep the save open). */
    saving: { hold: Promise.resolve(), icon: "icon-1", calls: 0 },
}));

vi.mock("./storage/nodeStorage", () => ({
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
// `database.svelte.ts` copies `saveAsset` into `saveImage` when it loads, so the asset store is
// replaced by a mock (its factory outlives `vi.resetModules`, which is fine: only the closures
// below are reached; `saveImage` never touches the first graph's state).
vi.mock("./globalApi.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./globalApi.svelte")>()),
    saveAsset: vi.fn(async () => {
        saving.calls += 1;
        await saving.hold;
        return saving.icon;
    }),
    downloadFile: vi.fn(),
    readImage: vi.fn(),
}));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const personaPng = () =>
    pngWithText({ persona: { name: "Imported", personaPrompt: "imported prompt", note: "imported note" } });

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    // `util` stays real (a `vi.mock` wrapper would outlive `vi.resetModules`); the dialog is spied per graph.
    const util = await import("./util");
    vi.spyOn(util, "selectSingleFile").mockImplementation(async () => picker.file as any);
    const persona = await import("./persona");
    const personas = () => plain(booted.db().personas) as any[];
    // The harness seeds no `personas` record: one persona added and saved gives the server a record to compare.
    booted.collectionStore.addPersona({ name: "Seed", icon: "", personaPrompt: "seed", note: "" });
    await booted.sync.flushResources();
    booted.fake.requests.length = 0;
    expect(booted.record("personas")).toEqual(personas());
    return { ...booted, persona, personas };
}

// The first boot compiles the module graph; done once here so no test pays for it, in the
// harness's order (the stores before the modules that reach back into them at load).
beforeAll(async () => {
    await import("./stores.svelte");
    await import("./storage/database.svelte");
    await import("./persona");
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
    saving.hold = Promise.resolve();
    saving.calls = 0;
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("importUserPersona adds the persona through addPersona", () => {
    it("the persona gets an id, the saved icon, and its fields; the selection stays; it is saved", async () => {
        const { persona, personas, selection, sync, record } = await boot();
        const before = personas();
        const selected = selection.personaId;
        expect(selected).toBe(before[0].id);
        picker.file = { name: "persona.png", data: personaPng() };
        await persona.importUserPersona();
        const list = personas();
        expect(list).toHaveLength(before.length + 1);
        const added = list.at(-1);
        expect(added.id).toMatch(UUID_V4);
        expect(before.some((entry) => entry.id === added.id)).toBe(false);
        expect(added).toMatchObject({
            name: "Imported",
            icon: "icon-1",
            personaPrompt: "imported prompt",
            note: "imported note",
        });
        expect(saving.calls).toBe(1);
        expect(selection.personaId).toBe(selected);
        expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
        expect(alerts.error).not.toHaveBeenCalled();
        await sync.flushResources();
        expect(record("personas")).toEqual(list);
    });

    it("a collection replaced while the icon was being saved receives the persona (the add reads the live list)", async () => {
        const { persona, personas, collectionStore, selection, sync, record } = await boot();
        let release!: () => void;
        saving.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        picker.file = { name: "persona.png", data: personaPng() };
        const run = persona.importUserPersona();
        for (let i = 0; i < 100 && saving.calls === 0; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(saving.calls).toBe(1);
        // Another tab, or the settings page: the list is replaced while the save is open.
        collectionStore.setPersonas([
            { id: "kept", name: "Kept", icon: "", personaPrompt: "kept", note: "" },
            { id: "other", name: "Other", icon: "", personaPrompt: "other", note: "" },
        ]);
        const selected = selection.personaId;
        release();
        await run;
        const list = personas();
        expect(list.map((entry) => entry.name)).toEqual(["Kept", "Other", "Imported"]);
        expect(list[2].icon).toBe("icon-1");
        expect(list[2].id).toMatch(UUID_V4);
        expect(selection.personaId).toBe(selected);
        await sync.flushResources();
        expect(record("personas")).toEqual(list);
    });

    it("a PNG without a persona chunk reports noData and adds nothing", async () => {
        const { persona, personas, sync, record } = await boot();
        const before = personas();
        picker.file = { name: "plain.png", data: pngWithText({}) };
        await persona.importUserPersona();
        expect(alerts.error).toHaveBeenCalledWith(language.errors.noData);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(personas()).toEqual(before);
        expect(saving.calls).toBe(0);
        await sync.flushResources();
        expect(record("personas")).toEqual(before);
    });
});

// Phase 6 slice 7: `exportUserPersona` reads the selected persona's four fields through
// `activePersona` once, before its first await (it took a snapshot of the whole database for them).
// A selection change, or an edit of the persona, while the icon is being read changes nothing in
// the export: the image read, the card in the PNG, and the file name are all the persona that was
// selected when the export started.
describe("exportUserPersona", () => {
    it("exports the persona selected at its start, though the selection and the persona change while its icon is read", async () => {
        const { persona, collectionStore, selection } = await boot();
        const globalApi = await import("./globalApi.svelte");
        const { PngChunk } = await import("./pngChunk");
        const { selectPersona } = await import("./storage/selection.svelte");
        collectionStore.setPersonas([
            { id: "pa", name: "Al:ice", icon: "icon-a", personaPrompt: "prompt a", note: "note a" },
            { id: "pb", name: "Bob", icon: "icon-b", personaPrompt: "prompt b", note: "note b" },
        ]);
        selectPersona("pa");
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(globalApi.readImage).mockImplementation(async () => {
            await held;
            return pngWithText({});
        });
        const downloads: { name: string; data: Uint8Array }[] = [];
        vi.mocked(globalApi.downloadFile).mockImplementation(async (name: string, data: any) => {
            downloads.push({ name, data });
        });

        let settled = false;
        const run = persona.exportUserPersona().finally(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(vi.mocked(globalApi.readImage).mock.calls).toEqual([["icon-a"]]);
        // While the icon is read: another persona is selected, and the exported one is edited.
        selectPersona("pb");
        collectionStore.updatePersona("pa", { name: "Changed", personaPrompt: "changed", note: "changed" });
        expect(selection.personaId).toBe("pb");
        release();
        for (let i = 0; i < 100 && !settled; i++) {
            await vi.advanceTimersByTimeAsync(10);
        }
        await run;

        expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.normal).toHaveBeenCalledWith(language.successExport);
        expect(downloads.map((entry) => entry.name)).toEqual(["Alice_export.png"]);
        let card: unknown;
        for await (const chunk of PngChunk.readGenerator(downloads[0].data)) {
            if (chunk && typeof chunk === "object" && "key" in chunk && chunk.key === "persona") {
                card = JSON.parse(Buffer.from(chunk.value, "base64").toString("utf-8"));
                break;
            }
        }
        expect(card).toEqual({ name: "Al:ice", personaPrompt: "prompt a", note: "note a" });
    });

    it("refuses a persona without a name or a prompt and reads nothing", async () => {
        const { persona, collectionStore } = await boot();
        const globalApi = await import("./globalApi.svelte");
        const { selectPersona } = await import("./storage/selection.svelte");
        collectionStore.setPersonas([{ id: "pa", name: "A", icon: "icon-a", personaPrompt: "", note: "" }]);
        selectPersona("pa");
        await persona.exportUserPersona();
        expect(alerts.error).toHaveBeenCalledWith("username or persona prompt is empty");
        expect(globalApi.readImage).not.toHaveBeenCalled();
        expect(globalApi.downloadFile).not.toHaveBeenCalled();
    });
});
