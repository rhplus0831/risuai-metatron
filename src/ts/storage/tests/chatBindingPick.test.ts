import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmMutationGraph } from "./mutationStoresHarness";
import { StoreBackedServer } from "./storeBackedServer";

// The pickers' action (`chatBindingPick.ts` `pickBinding`), the picker highlight (`pickedId`), and
// the deletion count (`chatsBoundTo` over `countChatEntries`), over the chat module booted from
// summaries against the real server store (nothing loaded, as `chatBindingViews.test.ts` boots it).
// Covered:
// - the target rule: `undefined` is the open chat at the call, else the tab's selection at home;
//   `null` is the tab's selection even while a chat is open; a ref is that chat, selected or not,
//   loaded or not;
// - a chat's pick sets that one field through the list entry, leaves the tab's selection, the other
//   chats, and `bindingReview` as they are, and returns true; a gone record or a gone chat changes
//   nothing and returns false;
// - a target captured before an await keeps its chat (or home) after the selection moved on;
// - `pickedId`: at home the view's id; in chat mode the bound id that exists, none when unset or
//   gone; a reader re-runs when the binding is patched or the record is removed;
// - `chatsBoundTo` counts every character's chats, loaded or summary, review pending or not, and
//   reading it inside an effect subscribes to nothing.

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
type PickModule = typeof import("../chatBindingPick");
type RecordsModule = typeof import("../records.svelte");
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
 * `partial` (model preset `m1`, prompt preset `p-gone`, persona unset, review pending), and character
 * `d` with the chat `other` (`m2`, `p2`, `u2`).
 */
async function createServer() {
    const server = await StoreBackedServer.create();
    serverHolder.current = server;
    server.store.applyChanges({
        ops: [
            { kind: server.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } },
            { kind: server.kind("characters"), id: "d", baseRevision: null, data: { chaId: "d", name: "D" } },
        ],
        chats: [
            create("c", "unbound", {}),
            create("c", "bound", { modelPresetId: "m2", promptPresetId: "p2", bindedPersona: "u2" }),
            create("c", "partial", { modelPresetId: "m1", promptPresetId: "p-gone", bindingReview: true }),
            create("d", "other", { modelPresetId: "m2", promptPresetId: "p2", bindedPersona: "u2" }),
        ],
    });
    return server;
}

async function boot() {
    vi.resetModules();
    const server = await createServer();
    const records: RecordsModule = await import("../records.svelte");
    const selectionModule: SelectionModule = await import("../selection.svelte");
    const read = server.store.readKinds([server.kind("characters")], { chatSummaries: true });
    records.initializeRecords(
        records.takeRecordFields({
            characters: read.kinds.characters.map((record) => record.data),
            botPresets: [
                { id: "p1", name: "P1" },
                { id: "p2", name: "P2" },
            ],
            modelPresets: [
                { id: "m1", name: "M1" },
                { id: "m2", name: "M2" },
            ],
            personas: [
                { id: "u1", name: "U1" },
                { id: "u2", name: "U2" },
            ],
        }),
    );
    selectionModule.selectPreset("p1");
    selectionModule.selectModelPreset("m1");
    selectionModule.selectPersona("u1");
    const chat: ChatModule = await import("../chatStore.svelte");
    const characterStore = await import("../characterStore.svelte");
    chat.seedChats(read.chatSummaries!, read.chatOrders!);
    chat.assembleChats(characterStore.characterList() as any, read.chatSummaries!, read.chatOrders!);
    chat.initializeChats();
    server.requests.length = 0;
    const binding: BindingModule = await import("../chatBinding.svelte");
    const pick: PickModule = await import("../chatBindingPick");
    const probes = await import("./reactiveProbe.svelte");
    const { flushSync } = await import("svelte");
    /** The tab's selection as stored. */
    const selected = () => ({
        presetId: selectionModule.selection.presetId,
        modelPresetId: selectionModule.selection.modelPresetId,
        personaId: selectionModule.selection.personaId,
    });
    /** The raw binding fields of a chat's list entry. */
    const entryIds = (target: { chaId: string; chatId: string }) => {
        const entry = chat.chatEntry(target);
        return entry
            ? {
                  modelPresetId: entry.modelPresetId,
                  promptPresetId: entry.promptPresetId,
                  bindedPersona: entry.bindedPersona,
                  bindingReview: entry.bindingReview,
              }
            : undefined;
    };
    /** Selects character `c` and its chat `chatId` (the chat screen's selection). */
    const open = (chatId: string, chaId = "c") => {
        selectionModule.selectCharacter(chaId);
        chat.selectChat(chaId, chatId);
    };
    return { server, chat, binding, pick, records, selectionModule, probes, flushSync, selected, entryIds, open };
}

beforeAll(
    () => warmMutationGraph(() => Promise.all([import("../chatBindingPick"), import("./reactiveProbe.svelte")])),
    60_000,
);

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

describe("pickBinding's target", () => {
    it("at home an undefined target is the tab's selection, per field; a gone record changes nothing", async () => {
        const { chat, pick, selected } = await boot();
        expect(pick.pickBinding("promptPresetId", "p2")).toBe(true);
        expect(pick.pickBinding("modelPresetId", "m2")).toBe(true);
        expect(pick.pickBinding("personaId", "u2")).toBe(true);
        expect(selected()).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u2" });

        expect(pick.pickBinding("promptPresetId", "p-nope")).toBe(false);
        expect(pick.pickBinding("modelPresetId", "m-nope")).toBe(false);
        expect(pick.pickBinding("personaId", "u-nope")).toBe(false);
        expect(selected()).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u2" });
        // No chat was written.
        expect(chat.hasChatWork()).toBe(false);
    });

    it("with an open chat an undefined target binds that chat only (unloaded, from its summary); the tab's selection stays", async () => {
        const { chat, binding, pick, selected, entryIds, open } = await boot();
        open("unbound");
        expect(chat.findChat(ref("unbound"))).toBeUndefined();

        expect(pick.pickBinding("promptPresetId", "p2")).toBe(true);
        expect(entryIds(ref("unbound"))).toMatchObject({ promptPresetId: "p2" });
        expect(entryIds(ref("unbound"))!.modelPresetId).toBeUndefined();
        expect(entryIds(ref("unbound"))!.bindedPersona).toBeUndefined();
        expect(pick.pickBinding("modelPresetId", "m2")).toBe(true);
        expect(pick.pickBinding("personaId", "u2")).toBe(true);
        expect(binding.chatBinding(ref("unbound"))).toEqual({
            ok: true,
            ids: { modelPresetId: "m2", promptPresetId: "p2", personaId: "u2" },
        });
        expect(selected()).toEqual(TAB);
        // The other chats are untouched; the chat is still not loaded.
        expect(entryIds(ref("bound"))).toMatchObject({
            modelPresetId: "m2",
            promptPresetId: "p2",
            bindedPersona: "u2",
        });
        expect(entryIds(ref("partial"))).toMatchObject({ promptPresetId: "p-gone", bindingReview: true });
        expect(chat.findChat(ref("unbound"))).toBeUndefined();
        expect(chat.hasChatWork()).toBe(true);
    });

    it("a chat's pick leaves a pending review and the other fields; a gone record changes nothing", async () => {
        const { binding, pick, entryIds, open } = await boot();
        open("partial");
        expect(pick.pickBinding("promptPresetId", "p1")).toBe(true);
        expect(entryIds(ref("partial"))).toMatchObject({
            modelPresetId: "m1",
            promptPresetId: "p1",
            bindingReview: true,
        });
        expect(entryIds(ref("partial"))!.bindedPersona).toBeUndefined();
        // Still refused: the persona is unset and the review is pending; only the explicit confirm clears it.
        expect(binding.chatBinding(ref("partial"))).toEqual({
            ok: false,
            problems: [{ field: "personaId", reason: "unset" }, { field: "review" }],
        });

        expect(pick.pickBinding("personaId", "u-nope")).toBe(false);
        expect(entryIds(ref("partial"))!.bindedPersona).toBeUndefined();
    });

    it("an explicit ref binds that chat, selected or not, loaded or not, and of another character; the open chat and the tab stay", async () => {
        const { chat, pick, selected, entryIds, open } = await boot();
        open("bound");
        expect(pick.pickBinding("promptPresetId", "p1", ref("unbound"))).toBe(true);
        expect(pick.pickBinding("personaId", "u1", ref("other", "d"))).toBe(true);
        expect(entryIds(ref("unbound"))).toMatchObject({ promptPresetId: "p1" });
        expect(entryIds(ref("other", "d"))).toMatchObject({
            modelPresetId: "m2",
            promptPresetId: "p2",
            bindedPersona: "u1",
        });
        expect(entryIds(ref("bound"))).toMatchObject({
            modelPresetId: "m2",
            promptPresetId: "p2",
            bindedPersona: "u2",
        });
        expect(selected()).toEqual(TAB);
        expect(chat.findChat(ref("unbound"))).toBeUndefined();
        expect(chat.findChat(ref("other", "d"))).toBeUndefined();

        // A loaded chat takes it the same way.
        await chat.ensureChatLoaded(ref("bound"));
        expect(pick.pickBinding("modelPresetId", "m1", ref("bound"))).toBe(true);
        expect(chat.findChat(ref("bound"))).toMatchObject({ modelPresetId: "m1", promptPresetId: "p2" });
        expect(entryIds(ref("bound"))).toMatchObject({ modelPresetId: "m1" });
    });

    it("a null target is the tab's selection even while a chat is open", async () => {
        const { chat, pick, selected, entryIds, open } = await boot();
        open("bound");
        expect(pick.pickBinding("promptPresetId", "p2", null)).toBe(true);
        expect(pick.pickBinding("modelPresetId", "m2", null)).toBe(true);
        expect(pick.pickBinding("personaId", "u2", null)).toBe(true);
        expect(selected()).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u2" });
        expect(entryIds(ref("bound"))).toMatchObject({
            modelPresetId: "m2",
            promptPresetId: "p2",
            bindedPersona: "u2",
        });
        expect(chat.hasChatWork()).toBe(false);
    });

    it("a gone chat (deleted, or never a member) changes nothing and returns false", async () => {
        const { chat, pick, selected, entryIds, open } = await boot();
        open("bound");
        const captured = chat.currentChatRef()!;
        expect(captured).toEqual(ref("bound"));
        chat.deleteChat(captured);
        expect(chat.chatEntry(captured)).toBeUndefined();
        // The selection fell back to the first chat; the captured ref is not re-resolved to it.
        expect(chat.currentChatRef()).toEqual(ref("unbound"));
        expect(pick.pickBinding("promptPresetId", "p1", captured)).toBe(false);
        expect(entryIds(ref("unbound"))!.promptPresetId).toBeUndefined();
        expect(pick.pickBinding("promptPresetId", "p1", ref("nope"))).toBe(false);
        expect(pick.pickBinding("promptPresetId", "p1", ref("bound", "nobody"))).toBe(false);
        expect(selected()).toEqual(TAB);
    });

    it("a target captured before an await keeps its chat, or home, after the selection moved on", async () => {
        const { chat, pick, selected, entryIds, open } = await boot();
        // Captured for `bound`, picked after the screen moved to `unbound`.
        open("bound");
        const forChat = chat.currentChatRef();
        open("unbound");
        await Promise.resolve();
        expect(pick.pickBinding("personaId", "u1", forChat)).toBe(true);
        expect(entryIds(ref("bound"))).toMatchObject({ bindedPersona: "u1" });
        expect(entryIds(ref("unbound"))!.bindedPersona).toBeUndefined();
        expect(selected()).toEqual(TAB);

        // Captured at home (null), picked after a chat was opened: the tab's selection, not the chat.
        open("unbound");
        chat.selectChat("c", "unbound");
        const { selectCharacter } = await import("../selection.svelte");
        selectCharacter(null);
        const atHome = chat.currentChatRef();
        expect(atHome).toBeNull();
        open("unbound");
        await Promise.resolve();
        expect(pick.pickBinding("personaId", "u2", atHome)).toBe(true);
        expect(selected()).toEqual({ ...TAB, personaId: "u2" });
        expect(entryIds(ref("unbound"))!.bindedPersona).toBeUndefined();
    });
});

describe("pickedId", () => {
    it("at home the view's id; in chat mode the bound id that exists, none when unset or gone", async () => {
        const { binding } = await boot();
        expect(binding.pickedId("promptPresetId", null, "p1")).toBe("p1");
        expect(binding.pickedId("promptPresetId", null, undefined)).toBeNull();
        expect(binding.pickedId("promptPresetId", ref("bound"), "p1")).toBe("p2");
        expect(binding.pickedId("modelPresetId", ref("bound"), "m1")).toBe("m2");
        expect(binding.pickedId("personaId", ref("bound"), "u1")).toBe("u2");
        // Unset, gone, and a chat that is not a member: no highlight, never the view's fallback.
        expect(binding.pickedId("promptPresetId", ref("unbound"), "p1")).toBeNull();
        expect(binding.pickedId("promptPresetId", ref("partial"), "p1")).toBeNull();
        expect(binding.pickedId("personaId", ref("partial"), "u1")).toBeNull();
        expect(binding.pickedId("modelPresetId", ref("partial"), "m2")).toBe("m1");
        expect(binding.pickedId("promptPresetId", ref("nope"), "p1")).toBeNull();
    });

    it("a reader re-runs when the chat's binding is patched and when the record goes or comes back", async () => {
        const { binding, records, probes, flushSync } = await boot();
        const probe = probes.createProbe(() => binding.pickedId("personaId", ref("bound"), "u1"));
        expect(probe.seen).toEqual(["u2"]);

        binding.chatBindingPatch(ref("bound"), { personaId: "u1" });
        flushSync();
        expect(probe.seen.at(-1)).toBe("u1");
        expect(probe.derived()).toBe("u1");

        records.trackedRecord<any[]>("personas")!.splice(0, 1);
        flushSync();
        expect(probe.seen.at(-1)).toBeNull();

        records.trackedRecord<any[]>("personas")!.push({ id: "u1", name: "U1 again" });
        flushSync();
        expect(probe.seen.at(-1)).toBe("u1");

        binding.chatBindingPatch(ref("bound"), { personaId: null });
        flushSync();
        expect(probe.seen.at(-1)).toBeNull();
        probe.dispose();
    });
});

describe("chatsBoundTo", () => {
    it("counts every character's chats, loaded or summary, review pending or not; a read inside an effect subscribes to nothing", async () => {
        const { chat, binding, probes, flushSync } = await boot();
        expect(binding.chatsBoundTo("promptPresetId", "p2")).toBe(2);
        expect(binding.chatsBoundTo("modelPresetId", "m2")).toBe(2);
        expect(binding.chatsBoundTo("modelPresetId", "m1")).toBe(1);
        expect(binding.chatsBoundTo("personaId", "u2")).toBe(2);
        expect(binding.chatsBoundTo("personaId", "u1")).toBe(0);
        // A gone id is counted too (the chats that show it as deleted).
        expect(binding.chatsBoundTo("promptPresetId", "p-gone")).toBe(1);

        // One loaded, the rest summaries: the same count.
        await chat.ensureChatLoaded(ref("bound"));
        expect(binding.chatsBoundTo("promptPresetId", "p2")).toBe(2);

        binding.chatBindingPatch(ref("unbound"), { promptPresetId: "p2" });
        expect(binding.chatsBoundTo("promptPresetId", "p2")).toBe(3);
        expect(chat.countChatEntries(() => true)).toBe(4);

        // Untracked: an effect reading the count runs once and not again after a binding change.
        const writer = probes.createWriterEffect(() => {
            binding.chatsBoundTo("promptPresetId", "p2");
        });
        expect(writer.runs()).toBe(1);
        binding.chatBindingPatch(ref("partial"), { promptPresetId: "p2" });
        flushSync();
        expect(writer.runs()).toBe(1);
        expect(binding.chatsBoundTo("promptPresetId", "p2")).toBe(4);
        writer.dispose();
    });
});
