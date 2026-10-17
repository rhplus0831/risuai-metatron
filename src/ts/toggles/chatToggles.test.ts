// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("../storage/serverAuth", () => ({ authFetch, getNodeServerProxyAuth: async () => "signed-token" }));
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleToggles: vi.fn(() => ""),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../alert", () => ({ alertError: vi.fn(), alertNormal: vi.fn() }));

const ref = { chaId: "c", chatId: "k" };
const legacy = { toggle_flag: "0", toggle_title: "legacy title" };
const servers: StoreBackedServer[] = [];
let fixture: Awaited<ReturnType<typeof boot>>;

async function boot() {
    const server = await StoreBackedServer.create();
    servers.push(server);
    authFetch.mockImplementation((path, init) => server.fetch(path, init));
    server.store.applyChanges({
        ops: ["c", "empty"].map((id) => ({
            kind: server.kind("characters"),
            id,
            baseRevision: null,
            data: { chaId: id, name: id },
        })),
        chats: ["k", "j", "no-map"].map((id) => ({
            characterId: "c",
            chatId: id,
            baseRevision: null,
            ops: [
                {
                    op: "create",
                    chat: {
                        id,
                        name: id,
                        note: "",
                        localLore: [],
                        message: [],
                        ...(id === "k" ? { GLGlobalVariables: { toggle_keep: "original" } } : {}),
                        ...(id === "j"
                            ? { GLGlobalVariables: { toggle_flag: "0", toggle_title: "selected source" } }
                            : {}),
                    },
                },
            ],
        })),
    });
    const chat = await import("../storage/chatStore.svelte");
    const { installFlatDatabase } = await import("../storage/tests/installFlatDatabase");
    const { settings } = await import("../storage/settingsViews.svelte");
    const { setRecordWriteListener } = await import("../storage/records.svelte");
    const toggles = await import("./chatToggles.svelte");
    const read = server.store.readKinds([server.kind("characters")], { chats: true });
    installFlatDatabase({
        characters: read.kinds.characters.map((record) => record.data),
        botPresets: [{ id: "p", name: "P", customPromptTemplateToggle: "flag=Flag\ntitle=Title=text" }],
        globalChatVariables: { ...legacy },
    });
    const summaries = server.store.readKinds([], { chatSummaries: true }).chatSummaries!;
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats([{ chaId: "c" }, { chaId: "empty" }], read.chats!, read.chatOrders!);
    const unload = () => chat.assembleChats([{ chaId: "c" }, { chaId: "empty" }], summaries, read.chatOrders!);
    // Do not initializeChats: a character without chats must stay chatless in these tests.
    const recordsWritten = vi.fn();
    setRecordWriteListener(recordsWritten);
    const take = () => chat.takeChatWork(new Set());
    const commit = () => {
        const work = take();
        const result = server.store.applyChanges({ chats: work.groups, chatOrders: work.orders });
        chat.ackChatWork(work, result.chats, result.chatOrders);
        return { work, result };
    };
    return { server, chat, settings, recordsWritten, take, commit, unload, ...toggles };
}

// Cold Svelte/server imports belong to setup, outside each synchronous behavior test's timeout.
beforeEach(async () => {
    vi.resetModules();
    authFetch.mockReset();
    localStorage.clear();
    sessionStorage.clear();
    fixture = await boot();
}, 20_000);
afterEach(() => {
    for (const server of servers.splice(0)) server.close();
});

describe("setChatToggle", () => {
    it("sends only the changed entry as meta.merge and preserves another writer's newer entry", () => {
        const { server, chat, setChatToggle, commit, recordsWritten, settings } = fixture;
        const base = server.chat("c", "k")!.revision;
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: base,
                ops: [{ op: "meta", merge: { GLGlobalVariables: { toggle_remote: "other tab" } } }],
            },
        ]);
        expect(setChatToggle(ref, "toggle_title", "this tab")).toBe(true);
        expect(chat.findChat(ref)!.GLGlobalVariables).toEqual({ toggle_keep: "original", toggle_title: "this tab" });
        const { work } = commit();
        expect(work.groups).toHaveLength(1);
        expect(work.groups[0]).toMatchObject({ characterId: "c", chatId: "k", baseRevision: base });
        expect(work.groups[0].ops).toEqual([
            { op: "meta", merge: { GLGlobalVariables: { toggle_title: "this tab" } } },
        ]);
        expect(server.chat("c", "k")!.data.GLGlobalVariables).toEqual({
            toggle_keep: "original",
            toggle_remote: "other tab",
            toggle_title: "this tab",
        });
        expect(settings.globalChatVariables).toEqual(legacy);
        expect(recordsWritten).not.toHaveBeenCalled();
    });

    it("stores the first explicit default zero, then skips an unchanged stored value without queuing work", () => {
        const { server, chat, setChatToggle, commit, take, recordsWritten } = fixture;
        expect(chat.findChat(ref)!.GLGlobalVariables).not.toHaveProperty("toggle_flag");
        expect(setChatToggle(ref, "toggle_flag", "0")).toBe(true);
        commit();
        expect(server.chat("c", "k")!.data.GLGlobalVariables).toEqual({ toggle_keep: "original", toggle_flag: "0" });
        expect(setChatToggle(ref, "toggle_flag", "0")).toBe(false);
        expect(chat.hasChatWork()).toBe(false);
        expect(take()).toMatchObject({ groups: [], orders: [] });
        expect(recordsWritten).not.toHaveBeenCalled();
    });

    it("returns false for an unloaded or missing chat without loading it or writing anything", () => {
        const { server, chat, setChatToggle, take, recordsWritten, settings, unload } = fixture;
        unload();
        expect(chat.chatEntry(ref)).toMatchObject({ id: "k" });
        for (const chatId of ["k", "missing"]) {
            expect(chat.findChat({ chaId: "c", chatId })).toBeUndefined();
            expect(setChatToggle({ chaId: "c", chatId }, "toggle_flag", "1")).toBe(false);
        }
        expect(take()).toMatchObject({ groups: [], orders: [] });
        expect(authFetch).not.toHaveBeenCalled();
        expect(recordsWritten).not.toHaveBeenCalled();
        expect(settings.globalChatVariables).toEqual(legacy);
        expect(server.chat("c", "k")!.data.GLGlobalVariables).toEqual({ toggle_keep: "original" });
    });
});

describe("initialChatToggles", () => {
    it("inherits a plain detached map from the character's selected loaded chat without writing", () => {
        const { chat, initialChatToggles, settings, recordsWritten, take, setChatToggle } = fixture;
        chat.selectChat("c", "j");
        // Unset policy also inherits; it must not take the first chat's map or legacy settings.
        const initial = initialChatToggles("c");
        expect(initial).toEqual({ GLGlobalVariables: { toggle_flag: "0", toggle_title: "selected source" } });
        expect(Object.getPrototypeOf(initial.GLGlobalVariables)).toBe(Object.prototype);
        expect(structuredClone(initial)).toEqual(initial);
        expect(initial.GLGlobalVariables).not.toBe(chat.findChat({ chaId: "c", chatId: "j" })!.GLGlobalVariables);
        expect(take()).toMatchObject({ groups: [], orders: [] });
        expect(recordsWritten).not.toHaveBeenCalled();
        settings.ui.newChatBinding = "inherit";
        expect(initialChatToggles("c")).toEqual(initial);
        initial.GLGlobalVariables!.toggle_title = "changed copy";
        expect(chat.findChat({ chaId: "c", chatId: "j" })!.GLGlobalVariables!.toggle_title).toBe("selected source");
        setChatToggle({ chaId: "c", chatId: "j" }, "toggle_flag", "1");
        expect(initial.GLGlobalVariables!.toggle_flag).toBe("0");
    });

    it("starts without a map under the empty policy even when the selected chat owns toggles", () => {
        const { chat, initialChatToggles, settings, take } = fixture;
        chat.selectChat("c", "j");
        settings.ui.newChatBinding = "empty";
        expect(initialChatToggles("c")).toEqual({});
        expect(chat.findChat({ chaId: "c", chatId: "j" })!.GLGlobalVariables).toEqual({
            toggle_flag: "0",
            toggle_title: "selected source",
        });
        expect(take()).toMatchObject({ groups: [], orders: [] });
    });

    it("starts without a map for an unloaded, mapless, or absent source and does not fetch or seed one", () => {
        const { server, chat, initialChatToggles, settings, take, recordsWritten, unload } = fixture;
        unload();
        chat.selectChat("c", "j");
        expect(chat.chatEntry({ chaId: "c", chatId: "j" })).toBeDefined();
        expect(chat.findChat({ chaId: "c", chatId: "j" })).toBeUndefined();
        expect(initialChatToggles("c")).toEqual({});
        expect(chat.selectedChatId("empty")).toBeNull();
        expect(initialChatToggles("empty")).toEqual({});
        // Install the existing mapless chat as loaded, without selecting a character or fetching.
        const read = server.store.readKinds([], { chats: true });
        chat.assembleChats([{ chaId: "c" }, { chaId: "empty" }], read.chats!, read.chatOrders!);
        chat.selectChat("c", "no-map");
        expect(chat.findChat({ chaId: "c", chatId: "no-map" })).toBeDefined();
        expect(initialChatToggles("c")).toEqual({});
        expect(take()).toMatchObject({ groups: [], orders: [] });
        expect(authFetch).not.toHaveBeenCalled();
        expect(recordsWritten).not.toHaveBeenCalled();
        expect(settings.globalChatVariables).toEqual(legacy);
    });
});
