import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain } from "../storage/tests/mutationStoresHarness";

// Phase 4, slice 7 (`docs/plan/phases/slices/phase-4-external-contracts/imports-through-the-module.md`):
// `importLoreBook("global")` appends the file's entries to the character selected when the dialog
// opened, by the id captured before it, through `updateCharacter`, over the real save adapter and
// the real server store (`storeBackedServer.ts`). With the selection moved meanwhile the entries land
// in the captured character (not selected, so the write reaches the server through its mark) and the
// selected one is untouched; a record replaced with newer lore while the dialog was open gets the
// entries appended to its current list; a character deleted meanwhile gets nothing and is not
// recreated. The local mode (the chat module) is unchanged and not covered here.

const { server, alerts, picker } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
    /** What the next `selectSingleFile` answers with; a test's answer runs its "while the dialog is open" step first. */
    picker: { answer: async (): Promise<{ name: string; data: Uint8Array }> => ({ name: "", data: new Uint8Array() }) },
}));

vi.mock("../storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: vi.fn(async () => true),
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));
vi.mock("./modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleTriggers: vi.fn(() => []),
    getModuleMcps: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("../tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

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
const nativeFile = (entries: unknown[]) => ({
    name: "lore.json",
    data: new TextEncoder().encode(JSON.stringify({ type: "risu", ver: 1, data: entries })),
});

/** Boots the harness with Alpha (one lore entry) selected and Beta (one entry), and loads `lorebook.svelte.ts`. */
async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { characterStore, stores, db, sync, fake } = booted;
    const index = (chaId: string) => db().characters.findIndex((entry: any) => entry?.chaId === chaId);
    const alpha = characterStore.addCharacter({ type: "character", name: "Alpha", globalLore: [lore("A", "a")] });
    const beta = characterStore.addCharacter({ type: "character", name: "Beta", globalLore: [lore("B", "b")] });
    stores.selectedCharID.set(index(alpha));
    await sync.flushResources();
    fake.requests.length = 0;
    // `util` stays real (a `vi.mock` wrapper would outlive `vi.resetModules`); the dialog is spied per graph.
    const util = await import("../util");
    vi.spyOn(util, "selectSingleFile").mockImplementation(() => picker.answer() as any);
    const lorebook = await import("./lorebook.svelte");
    const loreOf = (chaId: string) => plain(booted.character(chaId)?.globalLore);
    const run = async (file: { name: string; data: Uint8Array }, during: () => Promise<void> | void = () => {}) => {
        picker.answer = async () => {
            await during();
            return file;
        };
        await lorebook.importLoreBook("global");
    };
    return { ...booted, lorebook, alpha, beta, index, loreOf, run };
}

// The first boot compiles the module graph; done once here so no test pays for it, in the
// harness's order (the stores before the modules that reach back into them at load).
beforeAll(async () => {
    await import("../stores.svelte");
    await import("../storage/database.svelte");
    await import("./lorebook.svelte");
}, 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("importLoreBook(global) writes the character captured before the dialog", () => {
    it("appends the entries to that character after the selection moved, and the write is saved", async () => {
        const { run, alpha, beta, index, stores, loreOf, sync, record, fake } = await boot();
        await run(nativeFile([lore("New", "n")]), () => stores.selectedCharID.set(index(beta)));
        expect(loreOf(alpha)).toEqual([lore("A", "a"), lore("New", "n")]);
        expect(loreOf(beta)).toEqual([lore("B", "b")]);
        expect(get(stores.selectedCharID)).toBe(index(beta));
        expect(alerts.error).not.toHaveBeenCalled();
        await sync.flushResources();
        expect(record("characters", alpha).globalLore).toEqual([lore("A", "a"), lore("New", "n")]);
        expect(record("characters", beta).globalLore).toEqual([lore("B", "b")]);
        const sent = fake.batchBodies().flatMap((batch: any) => (batch.ops ?? []).map((op: any) => op.id));
        expect(sent).toContain(alpha);
        expect(sent).not.toContain(beta);
    });

    it("appends to the record's current lore when it was replaced while the dialog was open", async () => {
        const { run, alpha, characterStore, loreOf, sync, record } = await boot();
        await run(nativeFile([lore("New", "n")]), () => {
            characterStore.updateCharacter(alpha, { globalLore: [lore("A", "a"), lore("Newer", "x")] });
        });
        expect(loreOf(alpha)).toEqual([lore("A", "a"), lore("Newer", "x"), lore("New", "n")]);
        await sync.flushResources();
        expect(record("characters", alpha).globalLore).toEqual(loreOf(alpha));
    });

    it("a character deleted while the dialog was open gets nothing and is not recreated", async () => {
        const { run, alpha, beta, characterStore, loreOf, sync, mirrorText, serverText, fake, db } = await boot();
        let mirror = "";
        let serverBefore = "";
        let batches = 0;
        await run(nativeFile([lore("New", "n")]), async () => {
            expect(characterStore.removeCharacter(alpha)).toBe(true);
            await sync.flushResources();
            mirror = mirrorText();
            serverBefore = serverText();
            batches = fake.batchCount();
        });
        expect(alerts.error).not.toHaveBeenCalled();
        expect(mirrorText()).toBe(mirror);
        await sync.flushResources();
        expect(serverText()).toBe(serverBefore);
        expect(fake.batchCount()).toBe(batches);
        expect(db().characters.some((entry: any) => entry.chaId === alpha)).toBe(false);
        expect(fake.record("characters", alpha)).toBeNull();
        expect(loreOf(beta)).toEqual([lore("B", "b")]);
    });
});
