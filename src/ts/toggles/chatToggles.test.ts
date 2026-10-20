// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../../shared/database.ts";
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
vi.mock("../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

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
    const togglePresets = await import("./togglePresets.svelte");
    const { activePreset } = await import("../storage/settingsViews.svelte");
    const read = server.store.readKinds([server.kind("characters")], { chats: true });
    installFlatDatabase({
        characters: read.kinds.characters.map((record) => record.data),
        botPresets: [{ id: "p", name: "P", customPromptTemplateToggle: "flag=Flag\ntitle=Title=text" }],
        globalChatVariables: { ...legacy },
        togglePresets: [],
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
    return { server, chat, settings, activePreset, recordsWritten, take, commit, unload, ...toggles, ...togglePresets };
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
    vi.restoreAllMocks();
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
    it("inherits the selected loaded chat's preset link, even if deleted, independently of its map", () => {
        const { chat, initialChatToggles, settings, commit, recordsWritten } = fixture;
        chat.setChatMeta(ref, { togglePresetId: "first-chat-preset" });
        chat.setChatMeta({ chaId: "c", chatId: "j" }, { togglePresetId: "deleted-preset" });
        chat.setChatMeta({ chaId: "c", chatId: "no-map" }, { togglePresetId: "mapless-preset" });
        commit();
        expect(settings.togglePresets).toEqual([]);
        chat.selectChat("c", "j");
        for (const policy of [undefined, "inherit"] as const) {
            settings.ui.newChatBinding = policy;
            recordsWritten.mockClear();
            expect(initialChatToggles("c")).toEqual({
                GLGlobalVariables: { toggle_flag: "0", toggle_title: "selected source" },
                togglePresetId: "deleted-preset",
            });
            expect(recordsWritten).not.toHaveBeenCalled();
        }
        chat.selectChat("c", "no-map");
        expect(initialChatToggles("c")).toEqual({ togglePresetId: "mapless-preset" });
        expect(chat.hasChatWork()).toBe(false);
        expect(recordsWritten).not.toHaveBeenCalled();
    });

    it("omits the preset link under empty policy and when the linked source is unloaded", () => {
        const { chat, initialChatToggles, settings, commit, unload } = fixture;
        chat.setChatMeta({ chaId: "c", chatId: "j" }, { togglePresetId: "linked" });
        commit();
        chat.selectChat("c", "j");
        settings.ui.newChatBinding = "empty";
        expect(initialChatToggles("c")).toEqual({});
        expect(chat.findChat({ chaId: "c", chatId: "j" })!.togglePresetId).toBe("linked");
        settings.ui.newChatBinding = "inherit";
        unload();
        expect(initialChatToggles("c")).toEqual({});
        expect(authFetch).not.toHaveBeenCalled();
        expect(chat.hasChatWork()).toBe(false);
    });

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

describe("importedChatTogglePreset", () => {
    it("keeps only exact local preset ids and leaves imported toggle values untouched", () => {
        const { settings, importedChatTogglePreset, recordsWritten, chat } = fixture;
        settings.togglePresets = [{ id: "local", name: "Local", values: {}, kinds: {}, createdAt: 0, updatedAt: 0 }];
        recordsWritten.mockClear();
        const values = { toggle_title: "imported text", toggle_flag: "0" };
        for (const id of ["local", "missing", " local ", "", null, 7, undefined]) {
            const imported = {
                name: "Imported",
                message: [],
                note: "note",
                localLore: [],
                GLGlobalVariables: { ...values },
                togglePresetId: id,
            } as unknown as Chat;
            importedChatTogglePreset(imported);
            expect(imported).toEqual({
                name: "Imported",
                message: [],
                note: "note",
                localLore: [],
                GLGlobalVariables: values,
                ...(id === "local" ? { togglePresetId: "local" } : {}),
            });
            expect(Object.hasOwn(imported, "togglePresetId")).toBe(id === "local");
        }
        expect(recordsWritten).not.toHaveBeenCalled();
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("toggle preset operations", () => {
    // Assertions come from slice 4: captures use resolved values; chat writes must
    // remain per-field metadata operations, never a replacement of the toggle map.
    const definitions = "flag=Flag\nmode=Mode=select=First,Second\ntitle=Title=text\nnotes=Notes=textarea";
    const saved = (id = "saved") => ({
        id,
        name: "Saved",
        values: { flag: "1", title: "saved title", stale: "drop" },
        kinds: { flag: "checkbox" as const, title: "text" as const, staleKind: "textarea" as const },
        createdAt: 10,
        updatedAt: 20,
    });

    it("saves a trimmed named capture of the addressed chat's resolved values and links it without seeding its map", () => {
        const { settings, activePreset, chat, saveTogglePresetFromChat, recordsWritten, take } = fixture;
        activePreset.customPromptTemplateToggle = definitions;
        chat.selectChat("c", "j");
        recordsWritten.mockClear();
        vi.spyOn(Date, "now").mockReturnValue(100);
        const result = saveTogglePresetFromChat(ref, "  My toggles  ")!;
        expect(result).toEqual({
            id: expect.any(String),
            name: "My toggles",
            values: { flag: "0", mode: "0", title: "legacy title", notes: "" },
            kinds: { flag: "checkbox", mode: "select", title: "text", notes: "textarea" },
            createdAt: 100,
            updatedAt: 100,
        });
        expect(result.id).not.toBe("");
        expect(settings.togglePresets).toEqual([result]);
        expect(chat.findChat(ref)!.GLGlobalVariables).toEqual({ toggle_keep: "original" });
        expect(chat.findChat({ chaId: "c", chatId: "j" })!.togglePresetId).toBeUndefined();
        expect(take().groups.map(({ chatId, ops }) => ({ chatId, ops }))).toEqual([
            { chatId: "k", ops: [expect.objectContaining({ op: "meta", set: { togglePresetId: result.id } })] },
        ]);
        expect(recordsWritten.mock.calls.map(([key]) => key)).toEqual(["togglePresets"]);
        expect(settings.globalChatVariables).toEqual(legacy);
    });

    it("overwrites both saved maps with the current capture, drops stale keys, advances updatedAt and links the chat", () => {
        const { settings, activePreset, chat, overwriteTogglePreset, commit, recordsWritten } = fixture;
        settings.togglePresets = [saved(), saved("other")];
        activePreset.customPromptTemplateToggle = definitions;
        chat.setChatMeta(ref, { GLGlobalVariables: { toggle_title: "", toggle_notes: "chat notes" } });
        commit();
        recordsWritten.mockClear();
        vi.spyOn(Date, "now").mockReturnValue(200);
        expect(overwriteTogglePreset(ref, "saved")).toBe(true);
        expect(settings.togglePresets).toEqual([
            {
                id: "saved",
                name: "Saved",
                createdAt: 10,
                updatedAt: 200,
                values: { flag: "0", mode: "0", title: "", notes: "chat notes" },
                kinds: { flag: "checkbox", mode: "select", title: "text", notes: "textarea" },
            },
            saved("other"),
        ]);
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([expect.objectContaining({ op: "meta", set: { togglePresetId: "saved" } })]);
        expect(chat.findChat(ref)!.GLGlobalVariables).toEqual({ toggle_title: "", toggle_notes: "chat notes" });
        expect(new Set(recordsWritten.mock.calls.map(([key]) => key))).toEqual(new Set(["togglePresets"]));
        expect(settings.globalChatVariables).toEqual(legacy);
    });

    it("applies only changed raw entries and coalesces merge plus link while preserving another writer's keys", () => {
        const { settings, activePreset, server, chat, applyTogglePreset, commit, recordsWritten } = fixture;
        activePreset.customPromptTemplateToggle = definitions;
        settings.togglePresets = [
            {
                ...saved(),
                values: { flag: "1", mode: "8", title: "wrong kind", stale: "ignore" },
                kinds: { flag: "checkbox", mode: "select", title: "textarea" },
            },
        ];
        chat.setChatMeta(ref, {
            GLGlobalVariables: { toggle_keep: "original", toggle_flag: "1", toggle_title: "before" },
        });
        commit();
        recordsWritten.mockClear();
        const base = server.chat("c", "k")!.revision;
        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: base,
                ops: [{ op: "meta", merge: { GLGlobalVariables: { toggle_remote: "other tab" } } }],
            },
        ]);
        expect(applyTogglePreset(ref, "saved")).toBe(true);
        const { work } = commit();
        expect(work.groups).toHaveLength(1);
        expect(work.groups[0]).toMatchObject({ characterId: "c", chatId: "k", baseRevision: base });
        expect(work.groups[0].ops).toEqual([
            expect.objectContaining({
                op: "meta",
                set: { togglePresetId: "saved" },
                merge: { GLGlobalVariables: { toggle_mode: "0", toggle_title: "", toggle_notes: "" } },
            }),
        ]);
        expect(server.chat("c", "k")!.data).toMatchObject({
            togglePresetId: "saved",
            GLGlobalVariables: {
                toggle_keep: "original",
                toggle_flag: "1",
                toggle_title: "",
                toggle_mode: "0",
                toggle_notes: "",
                toggle_remote: "other tab",
            },
        });
        expect(settings.globalChatVariables).toEqual(legacy);
        expect(recordsWritten).not.toHaveBeenCalled();
    });

    it("materializes resolved defaults on first apply, skips unchanged raw values on relink, and queues nothing on repeated apply", () => {
        const { settings, chat, applyTogglePreset, commit, take, recordsWritten } = fixture;
        settings.togglePresets = [saved(), saved("other")].map((entry) => ({
            ...entry,
            values: { flag: "0", title: "legacy title" },
            kinds: { flag: "checkbox", title: "text" },
        }));
        recordsWritten.mockClear();
        expect(applyTogglePreset(ref, "saved")).toBe(true);
        expect(commit().work.groups[0].ops).toEqual([
            expect.objectContaining({
                op: "meta",
                set: { togglePresetId: "saved" },
                merge: { GLGlobalVariables: { toggle_flag: "0", toggle_title: "legacy title" } },
            }),
        ]);
        expect(applyTogglePreset(ref, "other")).toBe(true);
        const relink = commit().work.groups[0].ops;
        expect(relink).toEqual([expect.objectContaining({ op: "meta", set: { togglePresetId: "other" } })]);
        expect(relink[0]).not.toHaveProperty("merge");
        expect(applyTogglePreset(ref, "other")).toBe(true);
        expect(take()).toMatchObject({ groups: [], orders: [] });
        expect(chat.findChat(ref)!.GLGlobalVariables).toEqual({
            toggle_keep: "original",
            toggle_flag: "0",
            toggle_title: "legacy title",
        });
        expect(recordsWritten).not.toHaveBeenCalled();
    });

    it("unlinks by unsetting the field while retaining values and saved presets", () => {
        const { settings, chat, unlinkTogglePreset, commit, recordsWritten } = fixture;
        settings.togglePresets = [saved()];
        chat.setChatMeta(ref, { togglePresetId: "saved" });
        commit();
        recordsWritten.mockClear();
        expect(unlinkTogglePreset(ref)).toBe(true);
        expect(commit().work.groups[0].ops).toEqual([
            expect.objectContaining({ op: "meta", unset: ["togglePresetId"] }),
        ]);
        expect(Object.hasOwn(chat.findChat(ref)!, "togglePresetId")).toBe(false);
        expect(chat.findChat(ref)!.GLGlobalVariables).toEqual({ toggle_keep: "original" });
        expect(settings.togglePresets).toEqual([saved()]);
        expect(recordsWritten).not.toHaveBeenCalled();
    });

    it("renames and deletes by id without changing chat values or dangling links", () => {
        const { settings, chat, renameTogglePreset, deleteTogglePreset, commit, take, recordsWritten } = fixture;
        settings.togglePresets = [saved("other"), saved()];
        chat.setChatMeta(ref, { togglePresetId: "saved" });
        commit();
        recordsWritten.mockClear();
        expect(renameTogglePreset("saved", "  Renamed  ")).toBe(true);
        expect(settings.togglePresets.map(({ id, name }) => ({ id, name }))).toEqual([
            { id: "other", name: "Saved" },
            { id: "saved", name: "Renamed" },
        ]);
        expect(deleteTogglePreset("saved")).toBe(true);
        expect(settings.togglePresets).toEqual([saved("other")]);
        expect(chat.findChat(ref)).toMatchObject({
            togglePresetId: "saved",
            GLGlobalVariables: { toggle_keep: "original" },
        });
        expect(take()).toMatchObject({ groups: [], orders: [] });
        expect(new Set(recordsWritten.mock.calls.map(([key]) => key))).toEqual(new Set(["togglePresets"]));
        expect(settings.globalChatVariables).toEqual(legacy);
    });

    it("refuses blank names, missing presets and every chat operation on unloaded or absent chats without writes or fetches", () => {
        const {
            settings,
            chat,
            saveTogglePresetFromChat,
            overwriteTogglePreset,
            applyTogglePreset,
            unlinkTogglePreset,
            renameTogglePreset,
            deleteTogglePreset,
            recordsWritten,
            take,
            unload,
        } = fixture;
        settings.togglePresets = [saved()];
        recordsWritten.mockClear();
        for (const name of ["", " \n\t "]) {
            expect(saveTogglePresetFromChat(ref, name)).toBeUndefined();
            expect(renameTogglePreset("saved", name)).toBe(false);
        }
        expect(overwriteTogglePreset(ref, "missing")).toBe(false);
        expect(applyTogglePreset(ref, "missing")).toBe(false);
        expect(renameTogglePreset("missing", "Name")).toBe(false);
        expect(deleteTogglePreset("missing")).toBe(false);
        unload();
        expect(chat.chatEntry(ref)).toBeDefined();
        for (const chatId of ["k", "missing"]) {
            const target = { chaId: "c", chatId };
            expect(chat.findChat(target)).toBeUndefined();
            expect(saveTogglePresetFromChat(target, "New")).toBeUndefined();
            expect(overwriteTogglePreset(target, "saved")).toBe(false);
            expect(applyTogglePreset(target, "saved")).toBe(false);
            expect(unlinkTogglePreset(target)).toBe(false);
        }
        expect(settings.togglePresets).toEqual([saved()]);
        expect(settings.globalChatVariables).toEqual(legacy);
        expect(take()).toMatchObject({ groups: [], orders: [] });
        expect(recordsWritten).not.toHaveBeenCalled();
        expect(authFetch).not.toHaveBeenCalled();
    });
});
