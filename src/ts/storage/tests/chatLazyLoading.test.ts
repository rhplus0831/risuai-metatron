import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "./storeBackedServer";

// The chat module booted from summaries, against the real server store in memory, with the save loop
// driven by hand (`take` → `applyChanges` → `ack`, as `chatStore.test.ts` does) and the module's own
// reads answered by the server through `authFetch`, held where a case needs an interleaving. Covered
// here:
// - the boot holds every chat as its summary (exact list entries, prototype-named ids, no read, no
//   work); selecting a character reads its selected chat only; the facade view holds loaded chats;
// - selection is immediate: a slower earlier load never selects, a failed load shows its error and a
//   retry (which joins a running load), a chat gone on the server shows "unavailable" or falls back;
// - list-field writes on an unloaded chat change its summary and queue one `meta` op; a non-list
//   field or a wrong type is refused as a whole;
// - loads: an older read is read again (bounded), a busy install lays the summary over the read and
//   marks the chat stale so the idle refresh converges in both acknowledgement orders, a load is
//   fenced on the owner's lifetime, concurrent loads share one read, `loadChats` and `withChatsCopy`;
// - the LRU: eight idle loaded chats, the exclusions one by one, recency, revisions and versions kept,
//   nothing written;
// - server copies never load a chat: the live and recovery collections over summaries, a hydration
//   of an unloaded member.

const { serverHolder, gate } = vi.hoisted(() => ({
    serverHolder: { current: null as any },
    /**
     * Holds the answers of the requests `hold` matches (the server answered them already: each is a
     * snapshot of that moment) until the test releases them one by one (`releases`, in order).
     */
    gate: {
        hold: null as null | ((path: string, body: any) => boolean),
        releases: [] as (() => void)[],
    },
}));

vi.mock("../serverAuth", () => ({
    authFetch: async (path: string, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const response = serverHolder.current.fetch(path, init);
        if (gate.hold?.(path, body)) {
            await new Promise<void>((resolve) => gate.releases.push(resolve));
        }
        return response;
    },
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
vi.mock("../../plugins/plugins.svelte", () => ({ loadPlugins: vi.fn() }));
vi.mock("../../characterCards", () => ({ characterURLImport: vi.fn() }));
vi.mock("../../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

type ChatModule = typeof import("../chatStore.svelte");

const m = (id: string, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const texts = (chat: { message: readonly { data: string }[] } | undefined) =>
    chat!.message.map((message) => message.data);
const ref = (chaId: string, chatId: string) => ({ chaId, chatId });
const kRef = (index: number) => ref("c", `k${index}`);
/** How many chats `c` holds (more than the LRU keeps plus the protections one case takes). */
const C_CHATS = 15;

const create = (characterId: string, id: string, chat: Record<string, unknown>) => ({
    characterId,
    chatId: id,
    baseRevision: null,
    ops: [{ op: "create", chat: { id, note: "", localLore: [], message: [], ...chat } }],
});

/** The microtasks of a few chained loads (each fetch, its response's JSON, the module's steps), no timer. */
const settleMicrotasks = async () => {
    for (let i = 0; i < 200; i++) {
        await Promise.resolve();
    }
};

/**
 * Boots the module from the summaries the way `loadData` does (`readKinds` with `chatSummaries`,
 * `seedChats`, `assembleChats`, `initializeChats`) against a server holding: `c` with chats `k0`
 * (messages A, B, C) to `k14` (one message each; `k1` with `fmIndex` 2, `k3` in folder `f` bound
 * to persona `p`, prompt preset `pp`, and model preset `mp` with its review pending), `d` with chats
 * `m` and `constructor` (an id named like an `Object.prototype` member), and `e` with its only chat
 * `only`. Nothing is selected.
 */
async function boot(initialMeta: Record<string, unknown> = {}) {
    vi.resetModules();
    const server = await StoreBackedServer.create();
    serverHolder.current = server;
    const characters = server.kind("characters");
    server.store.applyChanges({
        ops: [
            { kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } },
            { kind: characters, id: "d", baseRevision: null, data: { chaId: "d", name: "D" } },
            { kind: characters, id: "e", baseRevision: null, data: { chaId: "e", name: "E" } },
        ],
        chats: [
            ...Array.from({ length: C_CHATS }, (_, i) =>
                create("c", `k${i}`, {
                    name: `K${i}`,
                    message:
                        i === 0
                            ? [m("a", "A", "char"), m("b", "B"), m("c", "C", "char")]
                            : [m(`k${i}-0`, `K${i} text`)],
                    ...(i === 1 ? { fmIndex: 2 } : {}),
                    ...(i === 2 ? initialMeta : {}),
                    ...(i === 3
                        ? {
                              folderId: "f",
                              bindedPersona: "p",
                              promptPresetId: "pp",
                              modelPresetId: "mp",
                              bindingReview: true,
                          }
                        : {}),
                }),
            ),
            create("d", "m", { name: "M", message: [m("x", "X")] }),
            create("d", "constructor", { name: "Proto", message: [m("y", "Y")] }),
            create("e", "only", { name: "Only", message: [m("z", "Z")] }),
        ],
    });
    const chat: ChatModule = await import("../chatStore.svelte");
    const records = await import("../records.svelte");
    const selection = await import("../selection.svelte");
    const characterStore = await import("../characterStore.svelte");
    const read = server.store.readKinds([characters], { chatSummaries: true });
    expect(read.chats).toBeUndefined();
    records.initializeRecords(
        records.takeRecordFields({ characters: read.kinds.characters.map((record) => record.data) }),
    );
    chat.seedChats(read.chatSummaries!, read.chatOrders!);
    chat.assembleChats(characterStore.characterList() as any, read.chatSummaries!, read.chatOrders!);
    chat.initializeChats();
    server.requests.length = 0;

    const character = (chaId = "c") =>
        characterStore.characterList().find((entry: any) => entry?.chaId === chaId) as any;
    const take = () => chat.takeChatWork(new Set());
    const apply = (work: ReturnType<typeof take>) =>
        work.groups.length + work.orders.length === 0
            ? { results: [], chats: [], chatOrders: [] }
            : server.store.applyChanges({
                  chats: work.groups.map(({ characterId, chatId, baseRevision, ops }) => ({
                      characterId,
                      chatId,
                      baseRevision,
                      ops,
                  })),
                  chatOrders: work.orders.map(({ characterId, baseRevision, ids }) => ({
                      characterId,
                      baseRevision,
                      ids,
                  })),
              });
    const ack = (work: ReturnType<typeof take>, result: ReturnType<typeof apply>) =>
        chat.ackChatWork(work, result.chats, result.chatOrders);
    /** One save cycle: take, apply on the server, acknowledge. */
    const commit = () => {
        const work = take();
        const result = apply(work);
        ack(work, result);
        return { work, result };
    };
    /** The idle refresh of one loaded chat, as the save loop runs it (`finishIdleChatRefresh`). */
    const refreshIdle = (target: { chaId: string; chatId: string }) => {
        const notice = chat.chatNoticeSeq(target);
        const issued = chat.heldChatRevision(target);
        const server_ = server.store.readRefs([], { chats: [{ characterId: target.chaId, id: target.chatId }] });
        return chat.finishIdleChatRefresh(server_.chats[0] as any, notice, issued);
    };
    /** The summary list of a character, as the save loop reads it. */
    const summaryList = (chaId: string) =>
        server.store.readRefs([], { chatSummaryCollections: [chaId] }).chatSummaryCollections![0];
    /** Another tab's `meta` write on a chat (its revision moves on). */
    const remoteMeta = (chaId: string, chatId: string, set: Record<string, unknown>) =>
        server.chatBatch([
            {
                characterId: chaId,
                chatId,
                baseRevision: server.chat(chaId, chatId)!.revision,
                ops: [{ op: "meta", set, unset: [] } as any],
            },
        ]);
    /** The `/api/resources/read` requests so far, with the chats and the summary lists each asked for. */
    const reads = () =>
        server.requests
            .filter((request) => request.path === "/api/resources/read")
            .map((request) => ({
                chats: ((request.body.chats ?? []) as { characterId: string; id: string }[]).map(
                    (entry) => `${entry.characterId}/${entry.id}`,
                ),
                summaries: (request.body.chatSummaryCollections ?? []) as string[],
            }));
    const loadedIds = (chaId: string) =>
        chat
            .chatList(chaId)
            .map((entry) => entry.id)
            .filter((id) => chat.findChat({ chaId, chatId: id }) !== undefined);
    /** Holds the answers of the chat reads naming `chatId` until `release` is called (once per read). */
    const holdChatReads = (chatId: string) => {
        gate.hold = (path, body) =>
            path === "/api/resources/read" &&
            ((body?.chats ?? []) as { id: string }[]).some((entry) => entry.id === chatId);
        return {
            release: () => {
                gate.releases.shift()?.();
            },
            stop: () => {
                gate.hold = null;
            },
        };
    };
    /**
     * The trim: the one scheduled (a load, a pin's release, a selection), and the one the save
     * cycle schedules after an acknowledgement or a refresh (the loop is driven by hand here).
     */
    const runTrim = () => {
        vi.runOnlyPendingTimers();
        chat.trimLoadedChats();
    };
    return {
        server,
        chat,
        selection,
        characterStore,
        character,
        take,
        apply,
        ack,
        commit,
        refreshIdle,
        summaryList,
        remoteMeta,
        reads,
        loadedIds,
        holdChatReads,
        runTrim,
    };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    gate.hold = null;
    gate.releases.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    for (const release of gate.releases.splice(0)) {
        release();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    serverHolder.current?.close();
});

describe("user-pinned chats", () => {
    it("exposes a persisted pin in list entries before and after loading the chat", async () => {
        const { chat, reads } = await boot({ pinned: true });
        expect(chat.chatEntry(kRef(2))).toEqual({ id: "k2", name: "K2", fmIndex: -1, pinned: true });
        expect(chat.chatList("c").find((entry) => entry.id === "k2")).toEqual({
            id: "k2",
            name: "K2",
            fmIndex: -1,
            pinned: true,
        });
        expect(chat.findChat(kRef(2))).toBeUndefined();
        expect(reads()).toEqual([]);

        await chat.ensureChatLoaded(kRef(2));
        expect(chat.findChat(kRef(2))).toHaveProperty("pinned", true);
        expect(chat.chatEntry(kRef(2))).toHaveProperty("pinned", true);
        expect(chat.chatList("c").find((entry) => entry.id === "k2")).toHaveProperty("pinned", true);
    });

    it("pins and unpins an unloaded chat with server-applied meta ops, removing the key without a default", async () => {
        const { server, chat, commit, reads } = await boot();
        expect(chat.chatEntry(kRef(2))).not.toHaveProperty("pinned");
        chat.setChatMeta(kRef(2), { pinned: true });
        expect(chat.chatEntry(kRef(2))).toHaveProperty("pinned", true);
        expect(chat.chatList("c").find((entry) => entry.id === "k2")).toHaveProperty("pinned", true);
        const pinned = commit();
        expect(pinned.work.groups).toHaveLength(1);
        expect(pinned.work.groups[0]).toMatchObject({
            characterId: "c",
            chatId: "k2",
            ops: [{ op: "meta", set: { pinned: true }, unset: [] }],
        });
        expect(server.chat("c", "k2")!.data).toHaveProperty("pinned", true);
        expect(chat.findChat(kRef(2))).toBeUndefined();
        expect(reads()).toEqual([]);

        chat.setChatMeta(kRef(2), {}, ["pinned"]);
        expect(chat.chatEntry(kRef(2))).not.toHaveProperty("pinned");
        expect(chat.chatList("c").find((entry) => entry.id === "k2")).not.toHaveProperty("pinned");
        const unpinned = commit();
        expect(unpinned.work.groups).toHaveLength(1);
        expect(unpinned.work.groups[0]).toMatchObject({
            characterId: "c",
            chatId: "k2",
            ops: [{ op: "meta", set: {}, unset: ["pinned"] }],
        });
        expect(server.chat("c", "k2")!.data).not.toHaveProperty("pinned");
        expect(chat.findChat(kRef(2))).toBeUndefined();
        expect(reads()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
        await chat.ensureChatLoaded(kRef(2));
        expect(chat.findChat(kRef(2))).not.toHaveProperty("pinned");
    });

    it("generic createChat preserves a supplied pin and leaves an omitted pin absent", async () => {
        const { server, chat, commit } = await boot();
        for (const fields of [{ id: "created-pin", pinned: true }, { id: "created-plain" }]) {
            chat.createChat("c", { ...fields, name: fields.id, note: "", localLore: [], message: [] });
        }
        expect(chat.findChat(ref("c", "created-pin"))).toHaveProperty("pinned", true);
        expect(chat.chatEntry(ref("c", "created-pin"))).toHaveProperty("pinned", true);
        expect(chat.findChat(ref("c", "created-plain"))).not.toHaveProperty("pinned");
        commit();
        expect(server.chat("c", "created-pin")!.data).toHaveProperty("pinned", true);
        expect(server.chat("c", "created-plain")!.data).not.toHaveProperty("pinned");
    });

    it("openPinnedChat opens the target across characters without loading the previous chat first", async () => {
        const { chat, selection, reads, server } = await boot({ pinned: true });
        const { openPinnedChat } =
            await vi.importActual<typeof import("../../globalApi.svelte")>("../../globalApi.svelte");
        const { PlaygroundStore, OpenRealmStore, ReloadGUIPointer } = await import("../../stores.svelte");
        const { get } = await import("svelte/store");
        selection.selectCharacter("d");
        await settleMicrotasks();
        selection.setChatOpen(false);
        PlaygroundStore.set(1);
        OpenRealmStore.set(true);
        ReloadGUIPointer.set(-1);
        server.requests.length = 0;
        expect(chat.selectedChatId("c")).toBe("k0");
        const reset = vi.fn(() => {
            expect(selection.selection.characterId).toBe("d");
            expect(chat.selectedChatId("c")).toBe("k0");
        });

        openPinnedChat(kRef(2), reset);
        expect(reset).toHaveBeenCalledOnce();
        expect(selection.selection.characterId).toBe("c");
        expect(chat.selectedChatId("c")).toBe("k2");
        expect(selection.selection.chatOpen).toBe(true);
        expect(get(PlaygroundStore)).toBe(0);
        expect(get(OpenRealmStore)).toBe(false);
        expect(get(ReloadGUIPointer)).not.toBe(-1);
        await settleMicrotasks();
        expect(reads()).toEqual([{ chats: ["c/k2"], summaries: [] }]);
        expect(chat.findChat(kRef(0))).toBeUndefined();
        expect(chat.selectedChat()?.id).toBe("k2");
    });

    it("openPinnedChat ignores an unknown character or a chat outside the character's list", async () => {
        const { chat, selection, reads, server } = await boot();
        const { openPinnedChat } =
            await vi.importActual<typeof import("../../globalApi.svelte")>("../../globalApi.svelte");
        const { PlaygroundStore, OpenRealmStore, ReloadGUIPointer } = await import("../../stores.svelte");
        const { get } = await import("svelte/store");
        selection.selectCharacter("d");
        await settleMicrotasks();
        selection.setChatOpen(false);
        PlaygroundStore.set(1);
        OpenRealmStore.set(true);
        ReloadGUIPointer.set(-1);
        server.requests.length = 0;
        const reset = vi.fn();

        for (const target of [ref("missing", "k2"), ref("c", "m")]) {
            openPinnedChat(target, reset);
            expect(reset).not.toHaveBeenCalled();
            expect(selection.selection.characterId).toBe("d");
            expect(chat.selectedChatId("d")).toBe("m");
            expect(chat.selectedChatId("c")).toBe("k0");
            expect(selection.selection.chatOpen).toBe(false);
            expect(get(PlaygroundStore)).toBe(1);
            expect(get(OpenRealmStore)).toBe(true);
            expect(get(ReloadGUIPointer)).toBe(-1);
        }
        await settleMicrotasks();
        expect(reads()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("the boot from summaries", () => {
    it("holds every chat as its summary with exact list entries and no read or work; selecting a character reads its selected chat only", async () => {
        const { server, chat, selection, character, reads } = await boot();
        const entries = chat.chatList("c");
        expect(entries).toHaveLength(C_CHATS);
        expect(entries[0]).toEqual({ id: "k0", name: "K0", fmIndex: -1 });
        expect(entries[1]).toEqual({ id: "k1", name: "K1", fmIndex: 2 });
        // The binding fields are list fields: on the summary, as stored.
        expect(entries[3]).toEqual({
            id: "k3",
            name: "K3",
            fmIndex: -1,
            folderId: "f",
            bindedPersona: "p",
            promptPresetId: "pp",
            modelPresetId: "mp",
            bindingReview: true,
        });
        expect(chat.chatCount("c")).toBe(C_CHATS);
        expect(chat.chatsLoaded("c")).toBe(false);
        expect(entries.every((entry) => chat.findChat(ref("c", entry.id)) === undefined)).toBe(true);
        // The ids named like `Object.prototype` members are ordinary members.
        expect(chat.chatEntry(ref("d", "constructor"))).toEqual({ id: "constructor", name: "Proto", fmIndex: -1 });
        expect(chat.chatEntry(ref("d", "hasOwnProperty"))).toBeUndefined();
        expect(chat.chatEntry(ref("nobody", "m"))).toBeUndefined();
        // Every server chat has its revision held, loaded or not (the save loop's membership rules).
        expect(chat.heldChatRevision(kRef(9))).toBe(server.chat("c", "k9")!.revision);
        expect(chat.heldOrderRevision("c")).toBe(server.order("c")!.revision);
        expect(reads()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
        // The facade view: no loaded chat, the selected chat's index among them -1.
        expect(character("c").chats).toEqual([]);
        expect(character("c").chatPage).toBe(-1);
        expect(chat.selectedChat()).toBeNull();
        expect(chat.selectedChatLoad()).toBeNull();

        // Selecting the character loads its selected chat, nothing else.
        selection.selectCharacter("c");
        expect(chat.currentChatRef()).toEqual(kRef(0));
        expect(chat.selectedChat()).toBeNull();
        expect(chat.selectedChatLoad()).toEqual({ error: null });
        expect(reads()).toEqual([{ chats: ["c/k0"], summaries: [] }]);
        await settleMicrotasks();
        expect(chat.selectedChat()?.id).toBe("k0");
        expect(texts(chat.selectedChat()!)).toEqual(["A", "B", "C"]);
        expect(chat.selectedChatLoad()).toBeNull();
        expect(chat.findChat(kRef(1))).toBeUndefined();
        expect(character("c").chats.map((entry: any) => entry.id)).toEqual(["k0"]);
        expect(character("c").chatPage).toBe(0);
        expect(reads()).toHaveLength(1);
        expect(server.batchCount()).toBe(0);
        expect(chat.hasChatWork()).toBe(false);
        // Home: nothing loads, nothing is read.
        selection.selectCharacter(null);
        expect(chat.selectedChat()).toBeNull();
        expect(chat.selectedChatLoad()).toBeNull();
        expect(reads()).toHaveLength(1);
    });

    it("assembleChats holds a whole record loaded and a summary unloaded; ensureChatLoaded answers a listed chat with one read and an unlisted one with none", async () => {
        const { server, chat, reads } = await boot();
        const whole = server.store.readRefs([], { chats: [{ characterId: "d", id: "m" }] }).chats[0];
        const summaries = server.store.readKinds([server.kind("characters")], { chatSummaries: true });
        chat.assembleChats(
            [{ chaId: "d" }],
            [
                whole as any,
                ...summaries.chatSummaries!.filter((entry) => entry.characterId === "d" && entry.id !== "m"),
            ],
            summaries.chatOrders!,
        );
        expect(chat.findChat(ref("d", "m"))).toBeDefined();
        expect(chat.findChat(ref("d", "constructor"))).toBeUndefined();
        expect(chat.chatList("d").map((entry) => entry.id)).toEqual(["m", "constructor"]);
        expect(await chat.ensureChatLoaded(ref("d", "nope"))).toBeUndefined();
        expect(reads()).toEqual([]);
        const loaded = await chat.ensureChatLoaded(ref("d", "constructor"));
        expect(texts(loaded)).toEqual(["Y"]);
        expect(reads()).toEqual([{ chats: ["d/constructor"], summaries: [] }]);
        expect(await chat.ensureChatLoaded(ref("d", "constructor"))).toBe(loaded);
        expect(reads()).toHaveLength(1);
    });
});

describe("selection", () => {
    it("selectChat on an unloaded chat is immediate: the selection moves, the screen reports loading, and a slower earlier load never selects", async () => {
        const { chat, selection, character, reads, holdChatReads } = await boot();
        selection.selectCharacter("c");
        await settleMicrotasks();
        expect(chat.selectedChat()?.id).toBe("k0");

        const held = holdChatReads("k1");
        chat.selectChat("c", "k1");
        held.stop();
        expect(chat.selectedChatId("c")).toBe("k1");
        expect(chat.currentChatRef()).toEqual(kRef(1));
        expect(chat.selectedChat()).toBeNull();
        expect(chat.selectedChatLoad()).toEqual({ error: null });
        expect(character("c").chatPage).toBe(-1);
        // A newer selection while the first load is out: it loads and shows; the first never selects.
        chat.selectChat("c", "k2");
        await settleMicrotasks();
        expect(chat.selectedChat()?.id).toBe("k2");
        expect(chat.selectedChatLoad()).toBeNull();
        expect(texts(chat.selectedChat()!)).toEqual(["K2 text"]);
        held.release();
        await settleMicrotasks();
        expect(chat.selectedChatId("c")).toBe("k2");
        expect(chat.selectedChat()?.id).toBe("k2");
        expect(chat.findChat(kRef(1))).toBeDefined();
        expect(reads().map((read) => read.chats)).toEqual([["c/k0"], ["c/k1"], ["c/k2"]]);
        // By index too, and a chat that is loaded already selects without a read.
        chat.selectChat("c", 1);
        expect(chat.selectedChat()?.id).toBe("k1");
        expect(reads()).toHaveLength(3);
        // The selection version moves with every selection (an action selecting after an await compares it).
        const version = chat.chatSelectionVersion("c");
        chat.selectChat("c", "k0");
        expect(chat.chatSelectionVersion("c")).toBe(version + 1);
    });

    it("a failed load of the selected chat shows its error with a retry; a retry joins a running load; a chat the server no longer has shows unavailable, or its replacement is selected", async () => {
        const { server, chat, selection, reads, holdChatReads } = await boot();
        server.failNext = { status: 500, times: 1, match: (path) => path === "/api/resources/read" };
        selection.selectCharacter("c");
        await settleMicrotasks();
        expect(chat.selectedChat()).toBeNull();
        expect(chat.selectedChatLoad()?.error).toMatch(/500/);
        // The retry: joined while it runs (one read), then the chat shows.
        const held = holdChatReads("k0");
        chat.retrySelectedChatLoad();
        chat.retrySelectedChatLoad();
        held.stop();
        expect(chat.selectedChatLoad()).toEqual({ error: null });
        expect(reads()).toHaveLength(2);
        held.release();
        await settleMicrotasks();
        expect(chat.selectedChat()?.id).toBe("k0");
        expect(chat.selectedChatLoad()).toBeNull();

        // Another tab deleted `e`'s only chat and gave it none: the read says gone, the list is
        // kept (no write), and the screen says the chat is not available.
        server.store.applyChanges({
            chats: [
                {
                    characterId: "e",
                    chatId: "only",
                    baseRevision: server.chat("e", "only")!.revision,
                    ops: [{ op: "delete" }],
                },
            ],
        });
        selection.selectCharacter("e");
        await settleMicrotasks();
        expect(chat.selectedChat()).toBeNull();
        expect(chat.selectedChatLoad()?.error).toMatch(/not available/);
        expect(chat.chatList("e").map((entry) => entry.id)).toEqual(["only"]);
        expect(reads().slice(-2)).toEqual([
            { chats: ["e/only"], summaries: [] },
            { chats: [], summaries: ["e"] },
        ]);
        expect(server.batchCount()).toBe(0);
        expect(chat.hasChatWork()).toBe(false);

        // Another tab deleted `c`'s selected chat `k0` and created `k_new` in front: the null read
        // removes `k0`, the selection falls back to the next chat and loads it, and the summary list
        // brings `k_new` as a summary.
        server.store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "k0",
                    baseRevision: server.chat("c", "k0")!.revision,
                    ops: [{ op: "delete" }],
                },
                create("c", "k_new", { name: "New", message: [m("n", "N")] }),
            ],
            chatOrders: [
                {
                    characterId: "c",
                    baseRevision: server.order("c")!.revision,
                    ids: ["k_new", ...Array.from({ length: C_CHATS - 1 }, (_, i) => `k${i + 1}`)],
                },
            ],
        });
        expect(chat.selectedChatId("c")).toBe("k0");
        selection.selectCharacter("c");
        // `k0` is loaded (it was selected before), so the screen shows it until the list says it is
        // gone: the deletion notice and the list's live update, as the save loop applies them.
        await settleMicrotasks();
        expect(chat.selectedChat()?.id).toBe("k0");
        expect(chat.noteRemoteChat(kRef(0), null)).toBe("noticed");
        const issued = chat.heldChatRevisionsOf("c");
        chat.applyRemoteCollection(
            server.store.readRefs([], { chatSummaryCollections: ["c"] }).chatSummaryCollections![0],
            issued,
        );
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual([
            "k_new",
            ...Array.from({ length: C_CHATS - 1 }, (_, i) => `k${i + 1}`),
        ]);
        expect(chat.findChat(ref("c", "k_new"))).toBeUndefined();
        expect(chat.selectedChatId("c")).toBe("k_new");
        expect(chat.selectedChatLoad()).toEqual({ error: null });
        await settleMicrotasks();
        expect(chat.selectedChat()?.id).toBe("k_new");
        expect(texts(chat.selectedChat()!)).toEqual(["N"]);
        expect(server.batchCount()).toBe(0);
    });

    it("an unloaded chat gone on the server while selected: the null read removes it, the selection falls back and loads, and the summary list brings the replacement", async () => {
        const { server, chat, selection, reads } = await boot();
        server.store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "k0",
                    baseRevision: server.chat("c", "k0")!.revision,
                    ops: [{ op: "delete" }],
                },
                create("c", "k_new", { name: "New", message: [m("n", "N")] }),
            ],
            chatOrders: [
                {
                    characterId: "c",
                    baseRevision: server.order("c")!.revision,
                    ids: ["k_new", ...Array.from({ length: C_CHATS - 1 }, (_, i) => `k${i + 1}`)],
                },
            ],
        });
        selection.selectCharacter("c");
        await settleMicrotasks();
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual([
            "k_new",
            ...Array.from({ length: C_CHATS - 1 }, (_, i) => `k${i + 1}`),
        ]);
        // The fallback at the removal was the first chat of the list then (`k1`), kept by the list;
        // its load starts at the removal, before the summary list is read.
        expect(chat.selectedChatId("c")).toBe("k1");
        expect(chat.selectedChat()?.id).toBe("k1");
        expect(chat.selectedChatLoad()).toBeNull();
        expect(chat.findChat(ref("c", "k_new"))).toBeUndefined();
        expect(chat.chatEntry(ref("c", "k_new"))).toEqual({ id: "k_new", name: "New", fmIndex: -1 });
        expect(chat.heldChatRevision(kRef(0))).toBeNull();
        expect(reads().map((read) => [read.chats, read.summaries])).toEqual([
            [["c/k0"], []],
            [["c/k1"], []],
            [[], ["c"]],
        ]);
        expect(server.batchCount()).toBe(0);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("list-field writes on unloaded chats", () => {
    it("setChatMeta on a summary sets and unsets the list fields, queues one meta op, skips equal values, and the loaded copy shows them later", async () => {
        const { server, chat, take, commit, reads, summaryList } = await boot();
        const target = kRef(5);
        const before = server.chat("c", "k5")!;
        const listFields = {
            name: "Renamed",
            folderId: "g",
            bindedPersona: "q",
            promptPresetId: "p2",
            modelPresetId: "m2",
            bindingReview: false,
            fmIndex: 1,
        };
        chat.setChatMeta(target, listFields);
        expect(chat.chatEntry(target)).toEqual({ id: "k5", ...listFields });
        expect(chat.findChat(target)).toBeUndefined();
        expect(reads()).toEqual([]);
        expect(chat.hasChatWork()).toBe(true);
        const { work } = commit();
        expect(work.groups).toHaveLength(1);
        expect(work.groups[0].ops).toEqual([{ op: "meta", set: listFields, unset: [] }]);
        expect(work.groups[0].baseRevision).toBe(before.revision);
        const after = server.chat("c", "k5")!;
        expect(after.data).toMatchObject(listFields);
        // The server's summary of the chat lists the same fields (`bindingReview: false` included).
        expect(summaryList("c").chats.find((summary) => summary.id === "k5")).toEqual({
            characterId: "c",
            id: "k5",
            revision: after.revision,
            ...listFields,
        });
        expect(server.texts("c", "k5")).toEqual(["K5 text"]);
        expect(chat.heldChatRevision(target)).toBe(after.revision);
        expect(chat.hasChatWork()).toBe(false);

        // Unsets: the server-defaulted fields go to their defaults, the others are removed.
        chat.setChatMeta(target, {}, [
            "folderId",
            "bindedPersona",
            "promptPresetId",
            "modelPresetId",
            "bindingReview",
            "name",
            "fmIndex",
        ]);
        expect(chat.chatEntry(target)).toEqual({ id: "k5", name: "", fmIndex: -1 });
        const second = commit();
        expect(second.work.groups[0].ops).toEqual([
            {
                op: "meta",
                set: { name: "", fmIndex: -1 },
                unset: ["folderId", "bindedPersona", "promptPresetId", "modelPresetId", "bindingReview"],
            },
        ]);
        for (const field of ["folderId", "bindedPersona", "promptPresetId", "modelPresetId", "bindingReview"]) {
            expect(server.chat("c", "k5")!.data, field).not.toHaveProperty(field);
        }
        expect(server.chat("c", "k5")!.data.name).toBe("");
        // Equal values queue nothing.
        chat.setChatMeta(target, { name: "", fmIndex: -1 });
        chat.setChatMeta(target, {}, ["folderId"]);
        expect(take().groups).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
        // Nothing was read for these writes; the load afterwards shows the fields and the messages.
        expect(reads()).toEqual([]);
        const loaded = await chat.ensureChatLoaded(target);
        expect(loaded).toMatchObject({ id: "k5", name: "", fmIndex: -1 });
        expect(loaded).not.toHaveProperty("folderId");
        expect(texts(loaded)).toEqual(["K5 text"]);
        expect(chat.heldChatRevision(target)).toBe(server.chat("c", "k5")!.revision);
    });

    it("a non-list field, a wrong type, or an unknown chat is refused as a whole before anything changes; message writes need the chat loaded", async () => {
        const { chat, take } = await boot();
        const target = kRef(6);
        expect(() => chat.setChatMeta(target, { name: "X", note: "n" })).toThrow(/not loaded/);
        expect(() => chat.setChatMeta(target, { fmIndex: "1" as any })).toThrow(/number/);
        expect(() => chat.setChatMeta(target, { bindingReview: "yes" as any })).toThrow(/boolean/);
        expect(() => chat.setChatMeta(target, { modelPresetId: 1 as any })).toThrow(/string/);
        expect(() => chat.setChatMeta(target, {}, ["note"])).toThrow(/not loaded/);
        expect(() => chat.setChatMeta(ref("c", "nope"), { name: "X" })).toThrow(/No chat/);
        expect(() => chat.appendMessage(target, m("q", "Q"))).toThrow(/No chat/);
        expect(() => chat.setMessageText(target, "k6-0", "Q")).toThrow(/No chat/);
        expect(() => chat.replaceChat(target, { id: "k6", message: [] } as any)).toThrow(/No chat/);
        expect(() => chat.captureChatBaseline(target)).toThrow(/No chat/);
        expect(() => chat.reconcileCharacterChats("c", [])).toThrow(/not loaded/);
        expect(chat.chatEntry(target)).toEqual({ id: "k6", name: "K6", fmIndex: -1 });
        expect(take().groups).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("loading", () => {
    it("a read older than the held revision does not complete the load: it is read again, and after three older answers the load rejects", async () => {
        const { server, chat, commit, reads, holdChatReads } = await boot();
        const target = kRef(7);
        chat.setChatMeta(target, { name: "Renamed" });
        const held = holdChatReads("k7");
        const load = chat.ensureChatLoaded(target);
        await settleMicrotasks();
        expect(reads().map((read) => read.chats)).toEqual([["c/k7"]]);
        // The rename lands while the read's answer (a snapshot older than it) is held.
        commit();
        expect(chat.heldChatRevision(target)).toBe(server.chat("c", "k7")!.revision);
        held.stop();
        held.release();
        const loaded = await load;
        expect(reads().map((read) => read.chats)).toEqual([["c/k7"], ["c/k7"]]);
        expect(loaded?.name).toBe("Renamed");
        expect(chat.findChat(target)?.name).toBe("Renamed");
        expect(chat.heldChatRevision(target)).toBe(server.chat("c", "k7")!.revision);
        expect(chat.idleChatRefreshes()).toEqual([]);

        // Three answers in a row older than what landed meanwhile: the load fails, the summary stays.
        const other = kRef(8);
        const again = holdChatReads("k8");
        const failing = chat.ensureChatLoaded(other);
        for (let attempt = 0; attempt < 3; attempt++) {
            await settleMicrotasks();
            chat.setChatMeta(other, { name: `Renamed ${attempt}` });
            commit();
            again.release();
            await settleMicrotasks();
        }
        again.stop();
        await expect(failing).rejects.toThrow(/older copy/);
        expect(chat.findChat(other)).toBeUndefined();
        expect(chat.chatEntry(other)?.name).toBe("Renamed 2");
        expect(reads().filter((read) => read.chats[0] === "c/k8")).toHaveLength(3);
        // The next load (nothing moves meanwhile) succeeds.
        expect((await chat.ensureChatLoaded(other))?.name).toBe("Renamed 2");
    });

    it("a load installed while the chat has list-field work lays the summary over the read and marks it stale; the idle refresh after the acknowledgement brings the other writer's fields (read before the ack)", async () => {
        const { server, chat, commit, refreshIdle, remoteMeta } = await boot();
        const target = kRef(3);
        chat.setChatMeta(target, { name: "Renamed" });
        // Another writer refiles the chat meanwhile.
        remoteMeta("c", "k3", { folderId: "f2" });
        const remote = server.chat("c", "k3")!;
        const loaded = await chat.ensureChatLoaded(target);
        // The copy: the local list fields over the read, the read's revision held, the chat stale.
        expect(loaded).toMatchObject({
            name: "Renamed",
            folderId: "f",
            bindedPersona: "p",
            promptPresetId: "pp",
            modelPresetId: "mp",
            bindingReview: true,
        });
        expect(texts(loaded)).toEqual(["K3 text"]);
        expect(chat.heldChatRevision(target)).toBe(remote.revision);
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.hasChatWork()).toBe(true);
        // The rename saves on the read's revision (not stale), and the stale mark stays.
        const { result } = commit();
        expect(result.chats[0].stale).toBeFalsy();
        expect(chat.heldChatRevision(target)).toBe(server.chat("c", "k3")!.revision);
        expect(chat.idleChatRefreshes()).toEqual([target]);
        expect(chat.hasChatWork()).toBe(true);
        // The idle refresh accepts the equal revision and repairs the masked field.
        expect(refreshIdle(target)).toBe(true);
        expect(chat.findChat(target)).toMatchObject({
            name: "Renamed",
            folderId: "f2",
            bindedPersona: "p",
            promptPresetId: "pp",
            modelPresetId: "mp",
            bindingReview: true,
        });
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
        expect(server.chat("c", "k3")!.data).toMatchObject({ name: "Renamed", folderId: "f2" });
    });

    it("the same with the acknowledgement after the read: a delayed older acknowledgement never moves the held revision back, and the refresh converges", async () => {
        const { server, chat, take, apply, ack, refreshIdle, remoteMeta } = await boot();
        const target = kRef(4);
        chat.setChatMeta(target, { name: "Renamed" });
        // The rename is applied on the server, its acknowledgement still on its way.
        const work = take();
        const result = apply(work);
        const acked = server.chat("c", "k4")!.revision;
        // Another writer refiles the chat after it.
        remoteMeta("c", "k4", { folderId: "f2" });
        const newer = server.chat("c", "k4")!.revision;
        const loaded = await chat.ensureChatLoaded(target);
        // In flight: the summary (no folder) is laid over the read, the newer revision held, stale.
        expect(loaded?.name).toBe("Renamed");
        expect(loaded).not.toHaveProperty("folderId");
        expect(chat.heldChatRevision(target)).toBe(newer);
        // The delayed acknowledgement does not move the revision back to its own.
        ack(work, result);
        expect(result.chats[0].revision).toBe(acked);
        expect(chat.heldChatRevision(target)).toBe(newer);
        expect(chat.idleChatRefreshes()).toEqual([target]);
        expect(refreshIdle(target)).toBe(true);
        expect(chat.findChat(target)).toMatchObject({ name: "Renamed", folderId: "f2" });
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("a load is fenced on the owner's lifetime: a character whose chats are installed again under the same ids gets nothing from an older read, the load resolves undefined, and a baseline of the old owner is dropped", async () => {
        const { chat, character, take, holdChatReads } = await boot();
        const target = kRef(8);
        const owner = chat.chatOwnerToken("c");
        const held = holdChatReads("k8");
        const load = chat.ensureChatLoaded(target);
        await settleMicrotasks();
        held.stop();
        // A re-import under the same ids: the chats are installed again (all loaded, new owner).
        chat.installCharacterChats(
            "c",
            Array.from({ length: C_CHATS }, (_, i) => ({
                id: `k${i}`,
                name: `K${i} again`,
                note: "",
                localLore: [],
                message: [],
            })) as any,
            character("c"),
        );
        expect(chat.chatOwnerToken("c")).not.toBe(owner);
        const baseline = chat.captureChatBaseline(kRef(0));
        held.release();
        expect(await load).toBeUndefined();
        expect(chat.findChat(target)?.name).toBe("K8 again");
        expect(texts(chat.findChat(target))).toEqual([]);
        // A baseline of the old owner: the result is dropped, nothing queued.
        const old = { ...baseline, owner };
        chat.applyChatResult(old, { ...baseline.chat, note: "from the old owner" } as any);
        expect(chat.findChat(kRef(0))?.note).toBe("");
        expect(take().groups.every((group) => group.ops.every((op) => op.op !== "meta"))).toBe(true);
        // The baseline of the new owner applies.
        chat.applyChatResult(baseline, { ...baseline.chat, note: "from the new owner" } as any);
        expect(chat.findChat(kRef(0))?.note).toBe("from the new owner");
    });

    it("concurrent loads of one chat share one read; loadChats reads every unloaded member in one request, pinned meanwhile; withChatsCopy refuses an incomplete character", async () => {
        const { chat, selection, reads, holdChatReads } = await boot();
        const held = holdChatReads("k9");
        const first = chat.ensureChatLoaded(kRef(9));
        const second = chat.loadChat(kRef(9));
        await settleMicrotasks();
        held.stop();
        expect(reads().map((read) => read.chats)).toEqual([["c/k9"]]);
        held.release();
        const [a, b] = await Promise.all([first, second]);
        expect(a).toBe(b);
        expect(a?.id).toBe("k9");

        expect(() => chat.withChatsCopy({ chaId: "c" })).toThrow(/not loaded/);
        selection.selectCharacter("c");
        chat.selectChat("c", "k2");
        await settleMicrotasks();
        expect(chat.selectedChat()?.id).toBe("k2");
        const all = await chat.loadChats("c");
        expect(all.map((entry) => entry.id)).toEqual(Array.from({ length: C_CHATS }, (_, i) => `k${i}`));
        expect(chat.chatsLoaded("c")).toBe(true);
        expect(chat.isChatPinned("c")).toBe(false);
        // One request for the members that were not loaded (`k0`, `k2`, and `k9` were).
        const bulk = reads().at(-1)!;
        expect(bulk.chats).toHaveLength(C_CHATS - 3);
        expect(bulk.chats).not.toContain("c/k9");
        expect(bulk.chats).not.toContain("c/k2");
        const copy = chat.withChatsCopy({ chaId: "c", name: "C" });
        expect(copy.chats.map((entry) => entry.id)).toEqual(all.map((entry) => entry.id));
        expect(copy.chatPage).toBe(2);
        expect(chat.withChatsCopy({ chaId: "c" }, "k9").chatPage).toBe(9);
        // Loaded already: no read.
        const count = reads().length;
        await chat.loadChats("c");
        expect(reads()).toHaveLength(count);
    });
});

describe("a chat not in the list", () => {
    it("loadChat of a chat the list lacks reads the character's summary list, then loads it if it is listed now; ensureChatLoaded reads nothing for it", async () => {
        const { server, chat, reads } = await boot();
        server.store.applyChanges({ chats: [create("c", "k_new", { name: "New", message: [m("n", "N")] })] });
        const target = ref("c", "k_new");
        expect(await chat.ensureChatLoaded(target)).toBeUndefined();
        expect(reads()).toEqual([]);
        const loaded = await chat.loadChat(target);
        expect(loaded?.id).toBe("k_new");
        expect(texts(loaded)).toEqual(["N"]);
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual([
            ...Array.from({ length: C_CHATS }, (_, i) => `k${i}`),
            "k_new",
        ]);
        expect(chat.heldChatRevision(target)).toBe(server.chat("c", "k_new")!.revision);
        expect(reads().map((read) => [read.chats, read.summaries])).toEqual([
            [[], ["c"]],
            [["c/k_new"], []],
        ]);
        // One the server does not have either: the list is applied, nothing is loaded, nothing appended.
        expect(await chat.loadChat(ref("c", "nope"))).toBeUndefined();
        expect(chat.chatList("c")).toHaveLength(C_CHATS + 1);
        expect(reads()).toHaveLength(3);
        expect(server.batchCount()).toBe(0);
    });
});

describe("eviction", () => {
    it("the trim keeps the eight most recently used idle loaded chats; an evicted chat keeps its list entry, revision, and version, and nothing is written", async () => {
        const { server, chat, selection, loadedIds, runTrim } = await boot();
        selection.selectCharacter("c");
        await settleMicrotasks();
        await chat.loadChats("c");
        expect(loadedIds("c")).toHaveLength(C_CHATS);
        const revision = chat.heldChatRevision(kRef(1));
        const version = chat.chatSaveVersion(kRef(1));
        // The scheduled trim (after the pin's release) runs after the current task.
        runTrim();
        // The selected chat and the eight most recently loaded stay (the loads installed k1..k14 in order).
        expect(loadedIds("c")).toEqual(["k0", ...Array.from({ length: 8 }, (_, i) => `k${C_CHATS - 8 + i}`)]);
        expect(chat.findChat(kRef(1))).toBeUndefined();
        expect(chat.chatEntry(kRef(1))).toEqual({ id: "k1", name: "K1", fmIndex: 2 });
        expect(chat.chatEntry(kRef(3))).toEqual({
            id: "k3",
            name: "K3",
            fmIndex: -1,
            folderId: "f",
            bindedPersona: "p",
            promptPresetId: "pp",
            modelPresetId: "mp",
            bindingReview: true,
        });
        expect(chat.heldChatRevision(kRef(1))).toBe(revision);
        expect(chat.chatSaveVersion(kRef(1))).toBe(version);
        expect(chat.chatList("c")).toHaveLength(C_CHATS);
        expect(server.batchCount()).toBe(0);
        expect(chat.hasChatWork()).toBe(false);
        expect(chat.MAX_LOADED_CHATS).toBe(8);

        // Recency: a cached `ensureChatLoaded` marks a chat as used, so the next eviction takes another.
        await chat.ensureChatLoaded(kRef(7));
        await chat.ensureChatLoaded(kRef(1));
        runTrim();
        expect(chat.findChat(kRef(7))).toBeDefined();
        expect(chat.findChat(kRef(1))).toBeDefined();
        expect(chat.findChat(kRef(8))).toBeUndefined();
        expect(loadedIds("c")).toHaveLength(9);
        // Across characters: the cap is per tab.
        await chat.loadChats("d");
        runTrim();
        expect(loadedIds("c").length + loadedIds("d").length).toBe(9);
        expect(loadedIds("d")).toEqual(["m", "constructor"]);
        // An evicted chat loads again on demand.
        expect(texts(await chat.ensureChatLoaded(kRef(8)))).toEqual(["K8 text"]);
    });

    it("never evicts the selected chat, a pinned chat, a chat of a pinned character, one with unsent or in-flight work, a noticed or stale one, a generating one, or one not saved yet; the end of each protection lets a trim take it", async () => {
        const { server, chat, selection, loadedIds, runTrim, commit, take, apply, ack, refreshIdle, remoteMeta } =
            await boot();
        selection.selectCharacter("c");
        await settleMicrotasks();
        await chat.loadChats("c");
        await chat.loadChats("d");
        // The protections (k0 is selected).
        const releaseChat = chat.pinChat(kRef(1));
        const releaseCharacter = chat.pinChats("d");
        chat.setChatMeta(kRef(3), { note: "in flight" });
        const inflight = take();
        const inflightResult = apply(inflight);
        expect(inflight.groups.map((group) => group.chatId)).toEqual(["k3"]);
        chat.setChatMeta(kRef(2), { note: "unsent" });
        remoteMeta("c", "k4", { name: "K4 remote" });
        expect(chat.noteRemoteChat(kRef(4), server.chat("c", "k4")!.revision)).toBe("noticed");
        chat.applyServerGeneration(kRef(5), { jobId: "J", messageId: "k5-0", generationId: "g", text: "...", seq: 0 });
        const created = chat.createChat("c", { id: "new", name: "New", note: "", localLore: [], message: [] } as any);
        runTrim();
        for (const id of ["k0", "k1", "k2", "k3", "k4", "k5", created.id]) {
            expect(chat.findChat(ref("c", id)), id).toBeDefined();
        }
        expect(loadedIds("d")).toEqual(["m", "constructor"]);
        // Eight idle ones remain among k6..k14 (nine candidates): the least recently used went.
        expect(chat.findChat(kRef(6))).toBeUndefined();
        expect(loadedIds("c")).toHaveLength(C_CHATS - 1 + 1);

        // Each protection's end: the next trim takes the chat (it is then the least recently used).
        releaseChat();
        runTrim();
        expect(chat.findChat(kRef(1))).toBeUndefined();
        // The character's chats become evictable; they were loaded last, so the trim takes the two
        // least recently used idle chats of `c` instead.
        releaseCharacter();
        runTrim();
        expect(loadedIds("d")).toEqual(["m", "constructor"]);
        expect(chat.findChat(kRef(7))).toBeUndefined();
        expect(chat.findChat(kRef(8))).toBeUndefined();
        // The commit takes `k2`'s unsent work and the new chat's create.
        const committed = commit();
        expect(committed.work.groups.map((group) => group.chatId).sort()).toEqual(["k2", created.id].sort());
        runTrim();
        expect(chat.findChat(kRef(2))).toBeUndefined();
        ack(inflight, inflightResult);
        runTrim();
        expect(chat.findChat(kRef(3))).toBeUndefined();
        expect(refreshIdle(kRef(4))).toBe(true);
        expect(chat.findChat(kRef(4))?.name).toBe("K4 remote");
        runTrim();
        expect(chat.findChat(kRef(4))).toBeUndefined();
        chat.endServerJob("J");
        // The job's end marks the chat stale: still kept until its refresh.
        runTrim();
        expect(chat.findChat(kRef(5))).toBeDefined();
        expect(refreshIdle(kRef(5))).toBe(true);
        runTrim();
        expect(chat.findChat(kRef(5))).toBeUndefined();
        // The new chat, saved by the commit above, has a revision and is evictable like any other.
        expect(chat.heldChatRevision(ref("c", created.id))).toBe(server.chat("c", created.id)!.revision);
        expect(chat.findChat(ref("c", created.id))).toBeUndefined();
        expect(chat.chatEntry(ref("c", created.id))?.name).toBe("New");
        // The selected chat stayed throughout; eight idle ones remain across both characters.
        expect(chat.selectedChat()?.id).toBe("k0");
        expect(loadedIds("c")).toEqual(["k0", ...Array.from({ length: 6 }, (_, i) => `k${i + 9}`)]);
        expect(loadedIds("d")).toEqual(["m", "constructor"]);
        expect(server.batchCount()).toBe(0);
    });
});

describe("server copies never load a chat", () => {
    it("the live collection over summaries: a new chat arrives as a summary, an unloaded member takes the newer summary and settles its notice, a loaded member shown newer is marked stale and read whole", async () => {
        const { server, chat, selection, summaryList, refreshIdle, remoteMeta, reads } = await boot();
        selection.selectCharacter("c");
        await settleMicrotasks();
        await chat.ensureChatLoaded(kRef(9));
        // Another tab: a new chat, a rename of the unloaded `k1`, a rename of the loaded `k9`.
        server.store.applyChanges({ chats: [create("c", "k_new", { name: "New", message: [m("n", "N")] })] });
        remoteMeta("c", "k1", { name: "K1 remote" });
        remoteMeta("c", "k9", { name: "K9 remote" });
        expect(chat.noteRemoteChat(kRef(1), server.chat("c", "k1")!.revision)).toBe("collection");
        expect(chat.noteRemoteChat(kRef(9), server.chat("c", "k9")!.revision)).toBe("noticed");
        expect(chat.noteRemoteChat(ref("c", "k_new"), server.chat("c", "k_new")!.revision)).toBe("collection");
        // An unloaded noticed member is refreshed through its summary list, a loaded one whole.
        expect(chat.idleSummaryRefreshes()).toEqual(["c"]);
        expect(chat.idleChatRefreshes()).toEqual([kRef(9)]);
        const notices = chat.summaryRefreshNotices(["c"]);
        const issued = chat.heldChatRevisionsOf("c");
        const collection = summaryList("c");
        expect(chat.applyRemoteCollection(collection, issued)).toBe(true);
        chat.settleSummaryRefresh(collection, notices);
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual([
            ...Array.from({ length: C_CHATS }, (_, i) => `k${i}`),
            "k_new",
        ]);
        expect(chat.findChat(ref("c", "k_new"))).toBeUndefined();
        expect(chat.chatEntry(ref("c", "k_new"))).toEqual({ id: "k_new", name: "New", fmIndex: -1 });
        expect(chat.chatEntry(kRef(1))?.name).toBe("K1 remote");
        expect(chat.findChat(kRef(1))).toBeUndefined();
        expect(chat.heldChatRevision(kRef(1))).toBe(server.chat("c", "k1")!.revision);
        expect(chat.heldChatRevision(ref("c", "k_new"))).toBe(server.chat("c", "k_new")!.revision);
        expect(chat.idleSummaryRefreshes()).toEqual([]);
        // The loaded `k9` kept its copy and held revision, marked stale for the whole-chat read.
        expect(chat.findChat(kRef(9))?.name).toBe("K9");
        expect(chat.idleChatRefreshes()).toEqual([kRef(9)]);
        expect(refreshIdle(kRef(9))).toBe(true);
        expect(chat.findChat(kRef(9))?.name).toBe("K9 remote");
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
        expect(reads()).toEqual([
            { chats: ["c/k0"], summaries: [] },
            { chats: ["c/k9"], summaries: [] },
        ]);
        expect(server.batchCount()).toBe(0);

        // A busy unloaded member keeps its summary and its notice; once idle, the summary refresh covers it.
        chat.setChatMeta(kRef(2), { folderId: "mine" });
        remoteMeta("c", "k2", { name: "K2 remote" });
        expect(chat.noteRemoteChat(kRef(2), server.chat("c", "k2")!.revision)).toBe("collection");
        expect(chat.idleSummaryRefreshes()).toEqual([]);
        const busyIssued = chat.heldChatRevisionsOf("c");
        const busyNotices = chat.summaryRefreshNotices(["c"]);
        const busyList = summaryList("c");
        expect(chat.applyRemoteCollection(busyList, busyIssued)).toBe(true);
        chat.settleSummaryRefresh(busyList, busyNotices);
        expect(chat.chatEntry(kRef(2))).toEqual({ id: "k2", name: "K2", fmIndex: -1, folderId: "mine" });
        expect(chat.hasChatWork()).toBe(true);
        // The refile saves (stale: another writer's change is not held), then the list refresh converges.
        const work = chat.takeChatWork(new Set());
        const result = server.store.applyChanges({
            chats: work.groups.map(({ characterId, chatId, baseRevision, ops }) => ({
                characterId,
                chatId,
                baseRevision,
                ops,
            })),
        });
        expect(result.chats[0].stale).toBe(true);
        chat.ackChatWork(work, result.chats, result.chatOrders);
        expect(chat.idleSummaryRefreshes()).toEqual(["c"]);
        const settledIssued = chat.heldChatRevisionsOf("c");
        const settledNotices = chat.summaryRefreshNotices(["c"]);
        const settledList = summaryList("c");
        expect(chat.applyRemoteCollection(settledList, settledIssued)).toBe(true);
        chat.settleSummaryRefresh(settledList, settledNotices);
        expect(chat.chatEntry(kRef(2))).toEqual({ id: "k2", name: "K2 remote", fmIndex: -1, folderId: "mine" });
        expect(chat.heldChatRevision(kRef(2))).toBe(server.chat("c", "k2")!.revision);
        expect(chat.idleSummaryRefreshes()).toEqual([]);
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
        expect(server.chat("c", "k2")!.data).toMatchObject({ name: "K2 remote", folderId: "mine" });
    });

    it("the recovery collection over summaries takes the server's summaries for idle unloaded chats and marks a loaded chat shown newer stale; a hydration of an unloaded member takes its revision and summary", async () => {
        const { server, chat, selection, summaryList, refreshIdle, remoteMeta } = await boot();
        selection.selectCharacter("c");
        await settleMicrotasks();
        await chat.ensureChatLoaded(kRef(9));
        remoteMeta("c", "k1", { name: "K1 remote" });
        remoteMeta("c", "k9", { name: "K9 remote" });
        server.store.applyChanges({ chats: [create("c", "k_new", { name: "New", message: [m("n", "N")] })] });
        chat.acceptRemoteCollection(summaryList("c"));
        expect(chat.chatEntry(kRef(1))?.name).toBe("K1 remote");
        expect(chat.findChat(kRef(1))).toBeUndefined();
        expect(chat.findChat(ref("c", "k_new"))).toBeUndefined();
        expect(chat.chatEntry(ref("c", "k_new"))?.name).toBe("New");
        expect(chat.heldOrderRevision("c")).toBe(server.order("c")!.revision);
        expect(chat.findChat(kRef(9))?.name).toBe("K9");
        expect(chat.idleChatRefreshes()).toEqual([kRef(9)]);
        expect(refreshIdle(kRef(9))).toBe(true);
        expect(chat.findChat(kRef(9))?.name).toBe("K9 remote");
        expect(chat.selectedChat()?.id).toBe("k0");

        // A job's chat event for an unloaded member: applied as its summary and revision only.
        remoteMeta("c", "k2", { name: "K2 job" });
        const remote = server.chat("c", "k2")!;
        expect(chat.hydrateChat({ characterId: "c", id: "k2", revision: remote.revision, data: remote.data })).toBe(
            true,
        );
        expect(chat.findChat(kRef(2))).toBeUndefined();
        expect(chat.chatEntry(kRef(2))?.name).toBe("K2 job");
        expect(chat.heldChatRevision(kRef(2))).toBe(remote.revision);
        // One with list-field work keeps its summary, is marked stale, and reads nothing on its own.
        chat.setChatMeta(kRef(3), { name: "Mine" });
        remoteMeta("c", "k3", { folderId: "f2" });
        const busy = server.chat("c", "k3")!;
        expect(chat.hydrateChat({ characterId: "c", id: "k3", revision: busy.revision, data: busy.data })).toBe(false);
        expect(chat.chatEntry(kRef(3))).toMatchObject({ name: "Mine", folderId: "f" });
        expect(chat.heldChatRevision(kRef(3))).not.toBe(busy.revision);
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.idleSummaryRefreshes()).toEqual([]);
        expect(server.batchCount()).toBe(0);
    });
});
