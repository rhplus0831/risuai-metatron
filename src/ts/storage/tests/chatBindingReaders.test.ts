import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, refJ, refK, warmMutationGraph } from "./mutationStoresHarness";

// The readers that take a chat ref read that chat's display ids (its bound records, else the tab's
// selection), never the selected chat's binding, over the real stores (`mutationStoresHarness.ts`:
// character `c` with chats `k` and `j`). Covered: the persona helpers (`util.ts`), a plugin's
// `updateSettings` without captured ids (the record a view shows), `getChatVarOf` (the chat's
// preset defaults), and `getModules(chatRef)` (the chat's preset's integration list).

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertConfirm: vi.fn(async () => true),
    }),
);
vi.mock("../../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("../../process/index.svelte", () => ({}));
vi.mock("../../translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("../../process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("../../process/files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("../../tokenizer", () => ({ tokenize: vi.fn(async (text: string) => text.length) }));
vi.mock("../../rpack/rpack_js", () => {
    const map = new Uint8Array(readFileSync(path.resolve(__dirname, "../../rpack/rpack_map.bin")));
    const apply = (table: Uint8Array) => async (data: Uint8Array) => {
        const result = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = table[data[i]];
        }
        return result;
    };
    return { encodeRPack: apply(map.slice(0, 256)), decodeRPack: apply(map.slice(256, 512)) };
});

/**
 * Boots the stores with the tab selecting the first preset and persona, persona `Mina` added, and
 * chat `k` bound to the second prompt preset and to `Mina`; chat `j` stays unbound. The character
 * is selected with chat `k`.
 */
async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { settings, collectionStore, chat, selectionModule, settingsViews } = booted;
    const [p1, p2] = settings.presets.map((preset: any) => preset.id as string);
    const tabPersonaId = settingsViews.activePersona.id!;
    settingsViews.activePersona.name = "User";
    settingsViews.activePersona.icon = "user-icon";
    settingsViews.activePersona.personaPrompt = "the user";
    const minaId = collectionStore.addPersona({ name: "Mina", personaPrompt: "the mina", icon: "mina-icon" });
    // The modules before the integration lists name them: `getModules` caches its result by the
    // joined id list, so a list resolved while a module was missing would stay empty.
    for (const id of ["modA", "modB"]) {
        collectionStore.addModule({ id, name: `Module ${id}`, description: "", lorebook: [] });
    }
    collectionStore.updateSettings({ templateDefaultVariables: "x=one", moduleIntergration: "modA" }, { presetId: p1 });
    collectionStore.updateSettings({ templateDefaultVariables: "x=two", moduleIntergration: "modB" }, { presetId: p2 });
    const binding = await import("../chatBinding.svelte");
    binding.chatBindingPatch(refK, { promptPresetId: p2, personaId: minaId });
    selectionModule.selectCharacter("c");
    chat.selectChat("c", "k");
    const util = await import("../../util");
    return { ...booted, binding, util, p1, p2, tabPersonaId, minaId };
}

beforeAll(() => warmMutationGraph(), 60_000);

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
    vi.clearAllMocks();
    server.current?.close();
});

describe("the persona helpers", () => {
    it("read the ref's bound persona, else the tab's; a background chat never gets the selected chat's; a captured ref holds after a switch", async () => {
        const { util, chat, activePersona, settingsViews, selection, tabPersonaId, minaId } = await boot();
        // The selected chat `k` binds Mina: the view and the helpers without a ref show her.
        expect(activePersona.id).toBe(minaId);
        expect(selection.personaId).toBe(tabPersonaId);
        expect(util.getUserName()).toBe("Mina");
        expect(util.getUserIcon()).toBe("mina-icon");
        expect(util.getPersonaPrompt()).toBe("the mina");
        expect(util.getUserName(refK)).toBe("Mina");
        // Chat `j` in the background is unbound: the tab's persona, not the selected chat's.
        expect(util.getUserName(refJ)).toBe("User");
        expect(util.getUserIcon(refJ)).toBe("user-icon");
        expect(util.getPersonaPrompt(refJ)).toBe("the user");
        expect(util.getUserIconProtrait(refJ)).toBe(settingsViews.tabPersonaRecord()?.largePortrait ?? false);

        // The user switches to `j`: the view follows; a ref captured for `k` still reads Mina.
        chat.selectChat("c", "j");
        expect(activePersona.id).toBe(tabPersonaId);
        expect(util.getUserName()).toBe("User");
        expect(util.getUserName(refK)).toBe("Mina");
        expect(util.getUserIcon(refK)).toBe("mina-icon");
        expect(util.getPersonaPrompt(refK)).toBe("the mina");
    });
});

describe("a plugin's updateSettings without captured ids", () => {
    it("writes the preset a view shows (the selected chat's bound one), and with ids that preset", async () => {
        const { collectionStore, sync, record, settings, activePreset, p1, p2 } = await boot();
        expect(activePreset.id).toBe(p2);
        collectionStore.updateSettings({ temperature: 7 });
        collectionStore.updateSettings({ temperature: 9 }, { presetId: p1 });
        const preset = (id: string): any => settings.presets.find((entry: any) => entry.id === id);
        expect(preset(p2).temperature).toBe(7);
        expect(preset(p1).temperature).toBe(9);
        await sync.flushResources();
        expect(record("presets").find((entry: any) => entry.id === p2).temperature).toBe(7);
        expect(record("presets").find((entry: any) => entry.id === p1).temperature).toBe(9);
    });
});

describe("the chat-scoped preset readers", () => {
    it("getChatVarOf defaults from the chat's display preset, and getChatVar from the selected chat's", async () => {
        const { chat } = await boot();
        const chatVar = await import("../../parser/chatVar.svelte");
        expect(chatVar.getChatVar("x")).toBe("two");
        expect(chatVar.getChatVarOf(refK, "x")).toBe("two");
        expect(chatVar.getChatVarOf(refJ, "x")).toBe("one");
        chat.selectChat("c", "j");
        expect(chatVar.getChatVar("x")).toBe("one");
        expect(chatVar.getChatVarOf(refK, "x")).toBe("two");
        // A stored variable wins over any preset default.
        chatVar.setChatVarOf(refJ, "x", "stored");
        expect(chatVar.getChatVarOf(refJ, "x")).toBe("stored");
    });

    it("getModules(chatRef) takes the integration list from the chat's display preset", async () => {
        const { chat } = await boot();
        const modules = await import("../../process/modules");
        const ids = (chatRef?: { chaId: string; chatId: string }) =>
            modules.getModules(chatRef).map((entry) => entry.id);
        expect(ids()).toEqual(["modB"]);
        expect(ids(refK)).toEqual(["modB"]);
        expect(ids(refJ)).toEqual(["modA"]);
        chat.selectChat("c", "j");
        expect(ids()).toEqual(["modA"]);
        expect(ids(refK)).toEqual(["modB"]);
    });
});
