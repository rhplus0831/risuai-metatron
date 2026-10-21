import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmMutationGraph } from "./mutationStoresHarness";
import { StoreBackedServer } from "./storeBackedServer";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets";

// The settings views follow the selected chat's binding (`settingsViews.svelte.ts` with the source
// `chatStore.svelte.ts` registers), over the chat module booted from summaries against the real
// server store (as `chatBinding.test.ts` boots it). Covered:
// - per field, the selected chat's bound record wins over the tab's selection, and a read never writes
//   the selection or the chat (the tab's ids stay what `tabSelectionIds` answers);
// - a partial binding falls through per field, a pending review does not matter, and a bound record
//   that is deleted or replaced falls through until it is back;
// - a write through a view, a root name (a prompt field, a profile field through the model preset's
//   main slot), or the write resolvers goes to the record a read shows, never to the tab's;
// - the closed-chat screen keeps the binding, home restores the tab's, and switching chats, loading
//   the selected chat, or patching its binding re-runs a reader;
// - `chatDisplayIds` of a background chat falls back to the tab's selection, never to the selected
//   chat's binding;
// - a reader created before the chat module registered its source re-runs once it does;
// - `applyParameters` with a captured scope reads that preset, and without one the views.

const serverHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("../serverAuth", () => ({
    authFetch: async (path: string, init?: RequestInit) => serverHolder.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

type ChatModule = typeof import("../chatStore.svelte");
type BindingModule = typeof import("../chatBinding.svelte");
type RecordsModule = typeof import("../records.svelte");
type ViewsModule = typeof import("../settingsViews.svelte");
type SelectionModule = typeof import("../selection.svelte");

const m = (id: string, data: string) => ({ role: "user", data, chatId: id }) as any;
const ref = (chatId: string, chaId = "c") => ({ chaId, chatId });
const TAB = { presetId: "p1", modelPresetId: "m1", personaId: "u1" };

const create = (characterId: string, id: string, chat: Record<string, unknown>) => ({
    characterId,
    chatId: id,
    baseRevision: null,
    ops: [
        {
            op: "create",
            chat: {
                id,
                name: id.toUpperCase(),
                note: "",
                localLore: [],
                message: [m(`${id}-0`, `${id} text`)],
                ...chat,
            },
        },
    ],
});

/**
 * The server: character `c` with the chats `unbound` (no binding), `bound` (`m2`, `p2`, `u2`), and
 * `partial` (model preset `" m1 "` and prompt preset `p-gone`, both gone, persona `u2`, review pending).
 */
async function createServer() {
    const server = await StoreBackedServer.create();
    serverHolder.current = server;
    server.store.applyChanges({
        ops: [{ kind: server.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            create("c", "unbound", {}),
            create("c", "bound", { modelPresetId: "m2", promptPresetId: "p2", bindedPersona: "u2" }),
            create("c", "partial", {
                modelPresetId: " m1 ",
                promptPresetId: "p-gone",
                bindedPersona: "u2",
                bindingReview: true,
            }),
        ],
    });
    return server;
}

/**
 * The records: the prompt presets `p1`/`p2` (their own `temperature` and `mainPrompt`), the model
 * presets `m1`/`m2` whose main slots name the profiles `f1`/`f2` (their own model id and
 * `maxContext`), and the personas `u1`/`u2`. The tab selects `p1`, `m1`, `u1`.
 */
async function installRecords(server: StoreBackedServer) {
    const records: RecordsModule = await import("../records.svelte");
    const selectionModule: SelectionModule = await import("../selection.svelte");
    const read = server.store.readKinds([server.kind("characters")], { chatSummaries: true });
    records.initializeRecords(
        records.takeRecordFields({
            characters: read.kinds.characters.map((record) => record.data),
            botPresets: [
                { id: "p1", name: "P1", temperature: 50, mainPrompt: "main 1" },
                { id: "p2", name: "P2", temperature: 80, mainPrompt: "main 2" },
            ],
            modelPresets: [
                normalizeModelPreset(
                    { name: "M1", mainSlot: { profileId: "f1" }, subSlot: { profileId: "f1" } },
                    { id: "m1" },
                ),
                normalizeModelPreset(
                    { name: "M2", mainSlot: { profileId: "f2" }, subSlot: { profileId: "f2" } },
                    { id: "m2" },
                ),
            ],
            modelProfiles: [
                normalizeModelProfile({ id: "f1", name: "F1", modelId: "model-1", maxContext: 1000 }),
                normalizeModelProfile({ id: "f2", name: "F2", modelId: "model-2", maxContext: 2000 }),
            ],
            personas: [
                { id: "u1", name: "U1", icon: "icon-1", personaPrompt: "prompt 1" },
                { id: "u2", name: "U2", icon: "icon-2", personaPrompt: "prompt 2" },
            ],
        }),
    );
    selectionModule.selectPreset("p1");
    selectionModule.selectModelPreset("m1");
    selectionModule.selectPersona("u1");
    return { records, selectionModule, read };
}

/** Boots the chat module from the summaries (nothing loaded) and selects nothing. */
async function bootChats(server: StoreBackedServer, read: ReturnType<StoreBackedServer["store"]["readKinds"]>) {
    const chat: ChatModule = await import("../chatStore.svelte");
    const characterStore = await import("../characterStore.svelte");
    chat.seedChats(read.chatSummaries!, read.chatOrders!);
    chat.assembleChats(characterStore.characterList() as any, read.chatSummaries!, read.chatOrders!);
    chat.initializeChats();
    server.requests.length = 0;
    return chat;
}

async function boot() {
    vi.resetModules();
    const server = await createServer();
    const { records, selectionModule, read } = await installRecords(server);
    const chat = await bootChats(server, read);
    const binding: BindingModule = await import("../chatBinding.svelte");
    const views: ViewsModule = await import("../settingsViews.svelte");
    const probes = await import("./reactiveProbe.svelte");
    // Svelte is part of the reset module graph: the flush must be the instance the records use.
    const { flushSync } = await import("svelte");
    const preset = (id: string) => records.trackedRecord<any[]>("presets")!.find((entry) => entry.id === id);
    const modelPreset = (id: string) => records.trackedRecord<any[]>("modelPresets")!.find((entry) => entry.id === id);
    const profile = (id: string) => records.trackedRecord<any[]>("modelProfiles")!.find((entry) => entry.id === id);
    const persona = (id: string) => records.trackedRecord<any[]>("personas")!.find((entry) => entry.id === id);
    /** The three ids the views answer now. */
    const viewIds = () => ({
        presetId: views.activePreset.id,
        modelPresetId: views.activeModelPreset.id,
        personaId: views.activePersona.id,
    });
    /** The tab's selection as stored (never resolved here). */
    const selected = () => ({
        presetId: selectionModule.selection.presetId,
        modelPresetId: selectionModule.selection.modelPresetId,
        personaId: selectionModule.selection.personaId,
    });
    /** Selects character `c` and its chat `chatId` (the chat screen's selection). */
    const open = (chatId: string) => {
        selectionModule.selectCharacter("c");
        chat.selectChat("c", chatId);
    };
    return {
        server,
        chat,
        binding,
        records,
        views,
        selectionModule,
        probes,
        flushSync,
        preset,
        modelPreset,
        profile,
        persona,
        viewIds,
        selected,
        open,
    };
}

/** `seen` without consecutive repeats (an effect re-runs on a dependency change, also to the same value). */
const distinct = <T>(seen: T[]) =>
    seen.filter((value, index) => index === 0 || JSON.stringify(value) !== JSON.stringify(seen[index - 1]));

beforeAll(() => warmMutationGraph(() => import("./reactiveProbe.svelte")), 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    serverHolder.current?.close();
});

describe("the views follow the selected chat's binding", () => {
    it("the selected chat's bound records win per field; the tab's selection and the chat are not written", async () => {
        const { chat, binding, views, viewIds, selected, open } = await boot();
        // At home: the tab's.
        expect(viewIds()).toEqual(TAB);
        expect(views.tabSelectionIds()).toEqual(TAB);

        open("bound");
        expect(viewIds()).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u2" });
        expect(views.activePreset.temperature).toBe(80);
        expect(views.activePreset.name).toBe("P2");
        expect(views.activePersona.name).toBe("U2");
        expect(views.activePersona.icon).toBe("icon-2");
        expect(views.currentPresetRecord()?.id).toBe("p2");
        expect(views.currentModelPresetRecord()?.id).toBe("m2");
        expect(views.currentPersonaRecord()?.id).toBe("u2");
        expect(views.selectedPresetIndex()).toBe(1);
        expect(views.selectedPersonaIndex()).toBe(1);
        // The model roots and the profile roots resolve through the bound model preset's main slot.
        expect(views.activeMainProfile.id).toBe("f2");
        expect(views.readSettingsRoot("aiModel")).toBe("model-2");
        expect(views.readSettingsRoot("maxContext")).toBe(2000);
        expect(views.readSettingsRoot("mainPrompt")).toBe("main 2");
        expect(views.resolveModelSlot("model").modelId).toBe("model-2");
        // The display ids of the selected chat are the views' ids.
        expect(binding.chatDisplayIds(ref("bound"))).toEqual(viewIds());

        // The tab's selection is untouched, and so is the chat.
        expect(selected()).toEqual(TAB);
        expect(views.tabSelectionIds()).toEqual(TAB);
        expect(views.tabPersonaRecord()?.id).toBe("u1");
        expect(chat.chatEntry(ref("bound"))).toMatchObject({
            modelPresetId: "m2",
            promptPresetId: "p2",
            bindedPersona: "u2",
        });
        expect(chat.hasChatWork()).toBe(false);
    });

    it("a partial binding falls through per field to the tab's, whatever the review says; the send guard stays strict", async () => {
        const { binding, views, viewIds, selected, open } = await boot();
        open("partial");
        // The gone model preset and prompt preset fall back; the persona holds; the review is ignored.
        expect(viewIds()).toEqual({ presetId: "p1", modelPresetId: "m1", personaId: "u2" });
        expect(views.readSettingsRoot("aiModel")).toBe("model-1");
        expect(views.activePreset.temperature).toBe(50);
        expect(views.activePersona.name).toBe("U2");
        expect(binding.chatDisplayIds(ref("partial"))).toEqual(viewIds());
        expect(selected()).toEqual(TAB);
        expect(binding.chatBinding(ref("partial"))).toMatchObject({ ok: false });

        // A complete binding under review: the views show it all the same.
        binding.chatBindingPatch(ref("bound"), { review: true });
        open("bound");
        expect(viewIds()).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u2" });
        expect(binding.chatBinding(ref("bound"))).toEqual({ ok: false, problems: [{ field: "review" }] });
    });

    it("a bound record deleted or replaced falls through to the tab's until it is back; neither the selection nor the chat is written", async () => {
        const { chat, records, views, probes, flushSync, viewIds, selected, open } = await boot();
        open("bound");
        const probe = probes.createProbe(viewIds);
        expect(probe.seen).toEqual([{ presetId: "p2", modelPresetId: "m2", personaId: "u2" }]);

        records.trackedRecord<any[]>("personas")!.splice(1, 1);
        flushSync();
        expect(probe.seen.at(-1)).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u1" });
        expect(probe.derived()).toEqual(probe.seen.at(-1));
        expect(views.activePersona.name).toBe("U1");

        records.replaceRecordList(records.trackedRecord<any[]>("modelPresets")!, [
            normalizeModelPreset(
                { name: "M1", mainSlot: { profileId: "f1" }, subSlot: { profileId: "f1" } },
                { id: "m1" },
            ),
        ]);
        flushSync();
        expect(probe.seen.at(-1)).toEqual({ presetId: "p2", modelPresetId: "m1", personaId: "u1" });
        expect(views.readSettingsRoot("aiModel")).toBe("model-1");

        // The selection keeps the tab's ids and the chat keeps its raw ids: nothing was redirected.
        expect(selected()).toEqual(TAB);
        expect(chat.chatEntry(ref("bound"))).toMatchObject({ modelPresetId: "m2", bindedPersona: "u2" });
        expect(chat.hasChatWork()).toBe(false);

        // The records come back: the binding applies again.
        records
            .trackedRecord<any[]>("modelPresets")!
            .push(
                normalizeModelPreset(
                    { name: "M2 again", mainSlot: { profileId: "f2" }, subSlot: { profileId: "f2" } },
                    { id: "m2" },
                ),
            );
        records.trackedRecord<any[]>("personas")!.push({ id: "u2", name: "U2 again" });
        flushSync();
        expect(probe.seen.at(-1)).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u2" });
        expect(views.activePersona.name).toBe("U2 again");
        expect(views.activeModelPreset.name).toBe("M2 again");
        probe.dispose();
    });

    it("the tab's gone record is replaced by the first one in the selection, the chat's bound one never", async () => {
        const { records, views, selected, open } = await boot();
        open("bound");
        records.trackedRecord<any[]>("presets")!.splice(0, 1);
        // The view still shows the bound preset; the tab's resolution falls back to the first record
        // (now `p2`) and makes it the selection: the tab's own rule, for the tab's ids only.
        expect(views.activePreset.id).toBe("p2");
        expect(views.tabSelectionIds().presetId).toBe("p2");
        expect(selected()).toEqual({ ...TAB, presetId: "p2" });
    });
});

describe("writes go to the record a read shows", () => {
    it("a view, a root name (a prompt field and a profile field), and the write resolvers target the bound records; at home the tab's", async () => {
        const { views, preset, modelPreset, profile, persona, selectionModule, open } = await boot();
        open("bound");
        expect(views.presetRecordForWrite()?.id).toBe("p2");
        expect(views.modelPresetRecordForWrite()?.id).toBe("m2");
        expect(views.personaRecordForWrite()?.id).toBe("u2");

        views.activePreset.temperature = 65;
        views.activePreset.name = "P2 edited";
        views.activeModelPreset.name = "M2 edited";
        views.activePersona.name = "U2 edited";
        views.writeSettingsRoot("mainPrompt", "main 2 edited");
        // A profile root is written into the bound model preset's main profile (`writeModelRoot` without a scope).
        views.writeSettingsRoot("maxContext", 2500);
        views.activeMainProfile.name = "F2 edited";

        expect(preset("p2")).toMatchObject({ temperature: 65, name: "P2 edited", mainPrompt: "main 2 edited" });
        expect(preset("p1")).toMatchObject({ temperature: 50, name: "P1", mainPrompt: "main 1" });
        expect(modelPreset("m2").name).toBe("M2 edited");
        expect(modelPreset("m1").name).toBe("M1");
        expect(persona("u2").name).toBe("U2 edited");
        expect(persona("u1").name).toBe("U1");
        expect(profile("f2")).toMatchObject({ maxContext: 2500, name: "F2 edited" });
        expect(profile("f1")).toMatchObject({ maxContext: 1000, name: "F1" });
        expect(views.readSettingsRoot("maxContext")).toBe(2500);

        // Home: the same writes go to the tab's records.
        selectionModule.selectCharacter(null);
        expect(views.presetRecordForWrite()?.id).toBe("p1");
        expect(views.modelPresetRecordForWrite()?.id).toBe("m1");
        expect(views.personaRecordForWrite()?.id).toBe("u1");
        views.activePreset.temperature = 55;
        views.activePersona.name = "U1 edited";
        views.writeSettingsRoot("maxContext", 1500);
        expect(preset("p1").temperature).toBe(55);
        expect(preset("p2").temperature).toBe(65);
        expect(persona("u1").name).toBe("U1 edited");
        expect(persona("u2").name).toBe("U2 edited");
        expect(profile("f1").maxContext).toBe(1500);
        expect(profile("f2").maxContext).toBe(2500);
    });

    it("a write while the bound record is gone goes to the tab's record, as the read falls through; a write with no tab record is dropped", async () => {
        const { records, views, preset, open } = await boot();
        open("bound");
        records.trackedRecord<any[]>("presets")!.splice(1, 1);
        expect(views.activePreset.id).toBe("p1");
        expect(views.presetRecordForWrite()?.id).toBe("p1");
        views.activePreset.temperature = 42;
        expect(preset("p1").temperature).toBe(42);
        // No prompt preset at all: the read's first-record fallback has nothing, the write is dropped.
        records.trackedRecord<any[]>("presets")!.splice(0, 1);
        expect(views.presetRecordForWrite()).toBeUndefined();
        expect(() => {
            views.activePreset.temperature = 1;
        }).not.toThrow();
    });
});

describe("the selected chat changes", () => {
    it("the closed-chat screen keeps the binding, home restores the tab's, and another chat of the character shows its own", async () => {
        const { views, probes, flushSync, selectionModule, chat, open } = await boot();
        const probe = probes.createProbe(() => views.activePreset.id);
        expect(probe.seen).toEqual(["p1"]);

        open("bound");
        flushSync();
        expect(probe.seen.at(-1)).toBe("p2");
        selectionModule.setChatOpen(true);
        flushSync();
        selectionModule.setChatOpen(false);
        flushSync();
        // The closed-chat screen: still the selected chat's (`currentChatRef`, not `chatOpen`).
        expect(probe.seen.at(-1)).toBe("p2");
        expect(views.activePreset.id).toBe("p2");

        selectionModule.selectCharacter(null);
        flushSync();
        expect(probe.seen.at(-1)).toBe("p1");
        // Back to the character: its selected chat is remembered.
        selectionModule.selectCharacter("c");
        flushSync();
        expect(probe.seen.at(-1)).toBe("p2");
        chat.selectChat("c", "unbound");
        flushSync();
        expect(probe.seen.at(-1)).toBe("p1");
        expect(distinct(probe.seen)).toEqual(["p1", "p2", "p1", "p2", "p1"]);
        probe.dispose();
    });

    it("a chat selected from its summary resolves as the loaded chat does, and a patch of the selected chat's binding re-runs a reader (a background chat's does not)", async () => {
        const { chat, binding, views, probes, flushSync, viewIds, open } = await boot();
        open("bound");
        const probe = probes.createProbe(viewIds);
        const bound = { presetId: "p2", modelPresetId: "m2", personaId: "u2" };
        expect(probe.seen).toEqual([bound]);

        // From the summary, then loaded: the same answer, with no change seen in between.
        expect(chat.chatEntry(ref("bound"))).toMatchObject({ promptPresetId: "p2" });
        await chat.ensureChatLoaded(ref("bound"));
        flushSync();
        expect(chat.findChat(ref("bound"))).toMatchObject({ promptPresetId: "p2", modelPresetId: "m2" });
        expect(viewIds()).toEqual(bound);
        expect(distinct(probe.seen)).toEqual([bound]);

        binding.chatBindingPatch(ref("bound"), { promptPresetId: "p1", personaId: null });
        flushSync();
        expect(probe.seen.at(-1)).toEqual({ presetId: "p1", modelPresetId: "m2", personaId: "u1" });
        expect(views.activePersona.name).toBe("U1");

        const runs = probe.seen.length;
        binding.chatBindingPatch(ref("unbound"), { promptPresetId: "p2", modelPresetId: "m2", personaId: "u2" });
        flushSync();
        expect(probe.seen.length).toBe(runs);
        expect(viewIds()).toEqual({ presetId: "p1", modelPresetId: "m2", personaId: "u1" });
        probe.dispose();
    });

    it("chatDisplayIds of a background chat falls back to the tab's selection, never to the selected chat's binding", async () => {
        const { binding, open, views } = await boot();
        open("bound");
        expect(views.activePreset.id).toBe("p2");
        expect(binding.chatDisplayIds(ref("unbound"))).toEqual(TAB);
        expect(binding.chatDisplayIds(ref("partial"))).toEqual({ ...TAB, personaId: "u2" });
        expect(binding.chatDisplayIds(ref("nope"))).toEqual(TAB);
        // Captured for `bound` and read after the selection moved on: still its own.
        const captured = ref("bound");
        open("unbound");
        expect(views.activePreset.id).toBe("p1");
        expect(binding.chatDisplayIds(captured)).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u2" });
    });

    it("a reader created before the chat module registered its source re-runs once it does", async () => {
        vi.resetModules();
        const server = await createServer();
        const { selectionModule, read } = await installRecords(server);
        const views: ViewsModule = await import("../settingsViews.svelte");
        const probes = await import("./reactiveProbe.svelte");
        const { flushSync } = await import("svelte");
        const probe = probes.createProbe(() => views.activePreset.id);
        expect(probe.seen).toEqual(["p1"]);
        const chat = await bootChats(server, read);
        selectionModule.selectCharacter("c");
        chat.selectChat("c", "bound");
        flushSync();
        expect(probe.seen.at(-1)).toBe("p2");
        probe.dispose();
    });
});

describe("applyParameters", () => {
    it("reads the captured scope's preset, not the views, and without a scope the views (the selected chat's); a gone scope preset throws", async () => {
        const { records, views, open } = await boot();
        const { applyParameters } = await import("../../process/request/shared");
        const parameters = ["temperature"] as const;
        const tabScope = { presetId: "p1", modelPresetId: "m1" };
        open("bound");
        expect(views.activePreset.temperature).toBe(80);
        expect(applyParameters({}, [...parameters], {}, { modelId: "x", scope: tabScope })).toEqual({
            temperature: 0.5,
        });
        expect(applyParameters({}, [...parameters], {}, { modelId: "x" })).toEqual({ temperature: 0.8 });
        expect(
            applyParameters({}, [...parameters], {}, { modelId: "x", scope: { presetId: "p2", modelPresetId: "m2" } }),
        ).toEqual({
            temperature: 0.8,
        });
        records.trackedRecord<any[]>("presets")!.splice(0, 1);
        expect(() => applyParameters({}, [...parameters], {}, { modelId: "x", scope: tabScope })).toThrow(
            views.PresetTargetGoneError,
        );
    });
});
