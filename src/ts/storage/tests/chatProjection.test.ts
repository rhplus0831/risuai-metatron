import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isRecordWrapper } from "../records.svelte";
import { bootMutations, m, refJ, refK } from "./mutationStoresHarness";

// Phase 6 slice 9a (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/chat-projection-and-lazy-loading.md`,
// "Implementation notes, 9a" and "After the challenge"): the chats left the character records for
// the chat module's own store. Against the real save adapter and server store
// (`storeBackedServer.ts`): character `c` with chats `k` (messages A, B, C) and `j` (empty).
// - The records are chat-free: a wrapper's keys, spread, and JSON carry no chats, the facade view
//   answers them, a write of either field is refused, and the saved record has none.
// - `chatList` follows the listed fields, the membership, and the order, not a message; the
//   selection is by id, kept across a reorder, falls back when its chat leaves, and a read never
//   writes it.
// - `ensureChatLoaded` answers a listed chat with no request; `loadChat` adopts a newer server copy,
//   keeps a chat with unsent work, and never applies across its owner's retirement.
// - Pins count per lifetime; a removal, a replacement, and ids named like `Object.prototype`
//   members; `withChatsCopy`; the remote collections over the held store.
// - `readChatsDetached` saves first and reads every chat of several characters in the server
//   order, refuses after a discard of a requested character's chat or a failed save; and
//   `exportAsDataset` over it.
// The reactive probe and `flushSync` come from the test's module graph (`vi.resetModules()`), the
// one the chat module's `$state` belongs to.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertSelect: vi.fn(),
    alertSelectChar: vi.fn(),
    alertConfirm: vi.fn(),
    alertModuleSelect: vi.fn(),
    alertAddCharacter: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
    alertWait: vi.fn(),
    alertMd: vi.fn(),
    alertInput: vi.fn(async () => ""),
    waitAlert: vi.fn(),
}));
vi.mock("../../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn((text: string) => text),
}));
vi.mock("../../process/index.svelte", async () => ({ doingChat: (await import("svelte/store")).writable(false) }));
vi.mock("../../translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("../../process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("../../tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));

/** A promise the test resolves itself. */
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}

const settleMicrotasks = async () => {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
};

const newChat = (id: string, name: string, texts: string[] = []) => ({
    id,
    name,
    note: "",
    localLore: [],
    message: texts.map((text, i) => m(`${id}-${i}`, text)),
});

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const chatEdits = await import("../chatEdits");
    const globalApi = await import("../../globalApi.svelte");
    const downloads: { name: string; data: string }[] = [];
    vi.spyOn(globalApi, "downloadFile").mockImplementation((async (name: string, data: Uint8Array | string) => {
        downloads.push({ name, data: typeof data === "string" ? data : Buffer.from(data).toString("utf-8") });
    }) as any);
    const dataset = await import("../exportAsDataset");
    const probe = await import("./reactiveProbe.svelte");
    const { flushSync } = await import("svelte");
    const ids = (chaId: string) => booted.chat.chatList(chaId).map((entry) => entry.id);
    return { ...booted, chatEdits, dataset, downloads, ids, createProbe: probe.createProbe, flushSync };
}

beforeAll(async () => {
    await import("../../stores.svelte");
    await import("../database.svelte");
}, 60_000);

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

describe("the records are chat-free", () => {
    it("a wrapper's keys, spread, and JSON carry no chats; the facade answers them; a write is refused; the saved record has none", async () => {
        const { chat, characterStore, character, sync, record } = await boot();
        const c = character("c");
        expect(Object.keys(c)).not.toContain("chats");
        expect(Object.keys(c)).not.toContain("chatPage");
        expect({ ...c }).not.toHaveProperty("chats");
        expect(JSON.parse(JSON.stringify(c))).not.toHaveProperty("chats");
        expect(characterStore.characterSnapshot("c")).not.toHaveProperty("chats");
        expect(characterStore.characterSnapshot("c")).not.toHaveProperty("chatPage");
        // The facade view: the held chats in order and the selected chat's index.
        expect(c.chats.map((entry: any) => entry.id)).toEqual(["k", "j"]);
        expect(c.chats[0]).toBe(chat.findChat(refK));
        expect(isRecordWrapper(c.chats[0])).toBe(false);
        expect(c.chatPage).toBe(0);
        chat.selectChat("c", "j");
        expect(c.chatPage).toBe(1);
        for (const write of [
            () => (c.chats = []),
            () => (c.chatPage = 0),
            () => delete c.chats,
            () => Object.defineProperty(c, "chatPage", { value: 0, configurable: true, writable: true }),
        ]) {
            expect(write).toThrow(TypeError);
        }
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["k", "j"]);
        characterStore.updateCharacter("c", { desc: "described" });
        await sync.flushResources();
        const saved = record("characters", "c");
        expect(saved.desc).toBe("described");
        expect(saved).not.toHaveProperty("chats");
        expect(saved).not.toHaveProperty("chatPage");
    });
});

describe("the readers", () => {
    it("chatList follows the listed fields, the membership, and the order, and not a message; selectedChat follows the selection", async () => {
        const { chat, characterStore, createProbe, flushSync } = await boot();
        characterStore.selectCharacter("c");
        const list = createProbe(() =>
            chat
                .chatList("c")
                .map((entry) => `${entry.id}:${entry.name}`)
                .join(","),
        );
        const selected = createProbe(() => chat.selectedChat()?.id ?? "");
        try {
            expect(list.seen).toEqual(["k:K,j:J"]);
            expect(selected.seen).toEqual(["k"]);

            // A message appended and a message streamed by a server job do not recompute the list.
            chat.appendMessage(refK, m("d", "D"));
            flushSync();
            chat.applyServerGeneration(refK, {
                jobId: "J1",
                messageId: "d",
                generationId: "g1",
                text: "D streamed",
                seq: 0,
            });
            flushSync();
            chat.endServerJob("J1");
            flushSync();
            expect(chat.findChat(refK)!.message.map((message) => message.data)).toEqual(["A", "B", "C", "D streamed"]);
            expect(list.seen).toEqual(["k:K,j:J"]);

            chat.setChatMeta(refK, { name: "K renamed" });
            flushSync();
            expect(list.seen.at(-1)).toBe("k:K renamed,j:J");
            chat.reorderChats("c", ["j", "k"]);
            flushSync();
            expect(list.seen.at(-1)).toBe("j:J,k:K renamed");
            chat.createChat("c", newChat("n", "N"), { index: 0 });
            flushSync();
            expect(list.seen.at(-1)).toBe("n:N,j:J,k:K renamed");
            chat.deleteChat({ chaId: "c", chatId: "n" });
            flushSync();
            expect(list.seen).toEqual([
                "k:K,j:J",
                "k:K renamed,j:J",
                "j:J,k:K renamed",
                "n:N,j:J,k:K renamed",
                "j:J,k:K renamed",
            ]);

            // The selected chat stayed `k` through the list's changes above (the effect follows the
            // membership, so it may run again with the same chat); it moves with the selection.
            expect(selected.seen.every((id) => id === "k")).toBe(true);
            expect(selected.derived()).toBe("k");
            chat.selectChat("c", "j");
            flushSync();
            expect(selected.seen.at(-1)).toBe("j");
            characterStore.selectCharacter(null);
            flushSync();
            expect(selected.seen.at(-1)).toBe("");
        } finally {
            list.dispose();
            selected.dispose();
        }
    });

    it("selection: by id or index, kept across a reorder, falls back to the first chat when its chat leaves, and a read never writes it", async () => {
        const { chat, characterStore } = await boot();
        characterStore.selectCharacter("c");
        chat.selectChat("c", "j");
        expect([chat.selectedChatId("c"), chat.selectedChatIndex("c")]).toEqual(["j", 1]);
        expect(chat.currentChatRef()).toEqual(refJ);
        chat.reorderChats("c", ["j", "k"]);
        expect([chat.selectedChatId("c"), chat.selectedChatIndex("c")]).toEqual(["j", 0]);
        chat.selectChat("c", 1);
        expect(chat.selectedChatId("c")).toBe("k");
        chat.selectChat("c", 5);
        chat.selectChat("c", "nope");
        expect(chat.selectedChatId("c")).toBe("k");
        chat.deleteChat(refK);
        expect([chat.selectedChatId("c"), chat.selectedChat()?.id]).toEqual(["j", "j"]);
        // A remembered chat that is not in the list reads as the first chat, without a write: once
        // the chat is listed again it is the selection.
        chat.createChat("c", newChat("k", "K back"));
        expect(chat.selectedChatId("c")).toBe("j");
        chat.selectChat("c", "k");
        chat.deleteChat(refJ);
        expect(chat.selectedChatId("c")).toBe("k");
        expect(chat.chatCount("c")).toBe(1);
        expect(chat.chatCount("nobody")).toBe(0);
        expect(chat.selectedChatId("nobody")).toBeNull();
    });

    it("withChatsCopy builds the legacy shape detached: the chats in order and chatPage the given chat's index or the selection's", async () => {
        const { chat, characterStore } = await boot();
        chat.selectChat("c", "j");
        const copy = chat.withChatsCopy(characterStore.characterSnapshot("c")!);
        expect(copy.chats.map((entry) => entry.id)).toEqual(["k", "j"]);
        expect(copy.chats[0].message.map((message) => message.data)).toEqual(["A", "B", "C"]);
        expect(copy.chatPage).toBe(1);
        expect(chat.withChatsCopy({ chaId: "c" }, "k").chatPage).toBe(0);
        expect(chat.withChatsCopy({ chaId: "c" }, "unknown").chatPage).toBe(1);
        expect(chat.withChatsCopy({ chaId: "nobody" })).toEqual({ chaId: "nobody", chats: [], chatPage: 0 });
        copy.chats[0].message.push(m("z", "Z"));
        copy.chats[0].name = "changed in the copy";
        expect(chat.findChat(refK)!.message).toHaveLength(3);
        expect(chat.findChat(refK)!.name).toBe("K");
    });
});

describe("loading", () => {
    it("ensureChatLoaded answers a listed chat with no request and an unlisted one with undefined; loadChat adopts a newer server copy and keeps a chat with unsent work", async () => {
        const { fake, chat } = await boot();
        fake.requests.length = 0;
        expect(await chat.ensureChatLoaded(refK)).toBe(chat.findChat(refK));
        expect(await chat.ensureChatLoaded({ chaId: "c", chatId: "nope" })).toBeUndefined();
        expect(await chat.ensureChatLoaded({ chaId: "nobody", chatId: "k" })).toBeUndefined();
        expect(fake.requests).toEqual([]);

        // Another tab changed the chat: a load adopts the server copy (the held revision too).
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { note: "remote" } }],
            },
        ]);
        expect(chat.findChat(refK)!.note).toBe("");
        const loaded = await chat.loadChat(refK);
        expect(loaded).toBe(chat.findChat(refK));
        expect(chat.findChat(refK)!.note).toBe("remote");
        expect(chat.heldChatRevision(refK)).toBe(fake.chat("c", "k")!.revision);
        expect(fake.requests.map((request) => request.path)).toEqual(["/api/resources/read"]);

        // A chat with unsent work keeps its copy: the read is issued, nothing is applied.
        chat.appendMessage(refK, m("d", "D"));
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { note: "remote again" } }],
            },
        ]);
        await chat.loadChat(refK);
        expect(chat.findChat(refK)!.note).toBe("remote");
        expect(chat.findChat(refK)!.message.map((message) => message.data)).toEqual(["A", "B", "C", "D"]);
        expect(await chat.loadChat({ chaId: "c", chatId: "nope" })).toBeUndefined();
    });

    it("a load never applies across its owner's retirement: the chat of the character installed again meanwhile is kept", async () => {
        const { fake, chat, characterStore } = await boot();
        const held = gate();
        const direct = fake;
        server.current = {
            fetch: async (path: string, init?: RequestInit) => {
                if (path.includes("/api/resources/read")) {
                    await held.promise;
                }
                return direct.fetch(path, init);
            },
        };
        const running = chat.loadChat(refK);
        await settleMicrotasks();
        characterStore.removeCharacter("c");
        characterStore.addCharacter({ chaId: "c", name: "C again", chats: [newChat("k", "fresh")] });
        expect(chat.findChat(refK)!.name).toBe("fresh");
        held.resolve();
        await running;
        expect(chat.findChat(refK)!.name).toBe("fresh");
        expect(chat.findChat(refK)!.message).toEqual([]);
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["k"]);
        server.current = direct;
    });

    it("pins count per lifetime: a release from before a reset never takes a later pin, and a release is idempotent", async () => {
        const { chat, characterStore } = await boot();
        const first = chat.pinChats("c");
        const second = chat.pinChats("c");
        expect(chat.isChatPinned("c")).toBe(true);
        first();
        first();
        expect(chat.isChatPinned("c")).toBe(true);
        second();
        expect(chat.isChatPinned("c")).toBe(false);

        const stale = chat.pinChats("c");
        characterStore.removeCharacter("c");
        expect(chat.isChatPinned("c")).toBe(false);
        characterStore.addCharacter({ chaId: "c", name: "C again", chats: [newChat("k", "K")] });
        const fresh = chat.pinChats("c");
        stale();
        expect(chat.isChatPinned("c")).toBe(true);
        fresh();
        expect(chat.isChatPinned("c")).toBe(false);
    });
});

describe("membership of the store", () => {
    it("a removed or replaced character's chats leave the store at once: lookups answer nothing and a write is refused", async () => {
        const { chat, characterStore, character } = await boot();
        characterStore.addCharacter({ chaId: "d", name: "D", chats: [newChat("kd", "KD", ["hello"])] });
        const kd = { chaId: "d", chatId: "kd" };
        expect(chat.findChat(kd)!.message.map((message) => message.data)).toEqual(["hello"]);

        characterStore.removeCharacter("c");
        expect(chat.findChat(refK)).toBeUndefined();
        expect(chat.chatList("c")).toEqual([]);
        expect(chat.selectedChatId("c")).toBeNull();
        expect(await chat.ensureChatLoaded(refK)).toBeUndefined();
        expect(() => chat.appendMessage(refK, m("z", "Z"))).toThrow(/No chat k/);

        const index = characterStore.characterList().findIndex((entry) => entry?.chaId === "d");
        characterStore.replaceCharacterAt(index, { chaId: "e", name: "E", chats: [newChat("ke", "KE")] });
        expect(chat.findChat(kd)).toBeUndefined();
        expect(chat.chatList("d")).toEqual([]);
        expect(chat.chatList("e").map((entry) => entry.id)).toEqual(["ke"]);
        expect(character("e").chats[0]).toBe(chat.findChat({ chaId: "e", chatId: "ke" }));
    });

    it("ids named like Object.prototype members are ordinary ids of the store", async () => {
        const { chat, characterStore, sync, fake } = await boot();
        characterStore.addCharacter({
            chaId: "constructor",
            name: "Proto",
            chats: [newChat("__proto__", "P", ["proto text"]), newChat("toString", "T")],
        });
        expect(chat.chatList("constructor").map((entry) => entry.id)).toEqual(["__proto__", "toString"]);
        expect(chat.findChat({ chaId: "constructor", chatId: "__proto__" })!.name).toBe("P");
        expect(chat.findChat({ chaId: "constructor", chatId: "valueOf" })).toBeUndefined();
        expect(chat.findChat({ chaId: "c", chatId: "constructor" })).toBeUndefined();
        expect(chat.findChat({ chaId: "hasOwnProperty", chatId: "k" })).toBeUndefined();
        expect(chat.chatCount("valueOf")).toBe(0);
        chat.selectChat("constructor", "toString");
        expect(chat.selectedChatId("constructor")).toBe("toString");
        chat.appendMessage({ chaId: "constructor", chatId: "__proto__" }, m("p2", "more"));
        await sync.flushResources();
        expect(fake.texts("constructor", "__proto__")).toEqual(["proto text", "more"]);
        expect(fake.order("constructor")!.ids).toEqual(["__proto__", "toString"]);
    });

    it("the remote collections over the held store: the live form keeps an unchanged chat by identity, the recovery form takes the server's copies; both keep the selection by id", async () => {
        const { chat, fake, character } = await boot();
        chat.selectChat("c", "j");
        const heldK = chat.findChat(refK);
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "n",
                baseRevision: null,
                ops: [{ op: "create", chat: newChat("n", "N", ["new"]) as any }],
            },
        ]);
        fake.store.applyChanges({
            chatOrders: [{ characterId: "c", baseRevision: fake.order("c")!.revision, ids: ["j", "n", "k"] }],
        });
        const collection = () => fake.store.readRefs([], { chatCollections: ["c"] }).chatCollections[0];

        // The live form (an idle refresh of the list): `k` and `j` are at their held revisions, so
        // they are kept as they are; `n` is new.
        expect(chat.applyRemoteCollection(collection())).toBe(true);
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["j", "n", "k"]);
        expect(chat.findChat(refK)).toBe(heldK);
        // The new chat is held as its summary (Phase 6 slice 9b): listed, in the facade (the loaded
        // chats) only once it is loaded.
        expect(chat.findChat({ chaId: "c", chatId: "n" })).toBeUndefined();
        expect(character("c").chats.map((entry: any) => entry.id)).toEqual(["j", "k"]);
        await chat.ensureChatLoaded({ chaId: "c", chatId: "n" });
        expect(chat.findChat({ chaId: "c", chatId: "n" })!.message.map((message) => message.data)).toEqual(["new"]);
        expect([chat.selectedChatId("c"), chat.selectedChatIndex("c")]).toEqual(["j", 0]);
        expect(character("c").chats.map((entry: any) => entry.id)).toEqual(["j", "n", "k"]);

        // The recovery form (after a conflict): every idle chat is the server's copy, at its revision.
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { note: "remote" } }],
            },
        ]);
        chat.acceptRemoteCollection(collection());
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["j", "n", "k"]);
        expect(chat.findChat(refK)!.note).toBe("remote");
        expect(chat.heldChatRevision(refK)).toBe(fake.chat("c", "k")!.revision);
        expect([chat.selectedChatId("c"), chat.selectedChat()?.id ?? null]).toEqual(["j", null]);
    });
});

describe("detached reads", () => {
    it("readChatsDetached saves first and answers every chat of several characters in the server order; an empty request reads nothing; a character without an order gets []", async () => {
        const { chat, characterStore, chatEdits, sync, fake, ids } = await boot();
        characterStore.addCharacter({ chaId: "d", name: "D", chats: [newChat("kd", "KD")] });
        for (let i = 0; i < 5; i++) {
            chat.createChat("c", newChat(`c${i}`, `C${i}`, [`text c${i}`]));
            chat.createChat("d", newChat(`d${i}`, `D${i}`));
        }
        await sync.flushResources();
        // Unsent work and a reorder are saved before the read; the result follows the saved order.
        chat.appendMessage(refK, m("d", "D"));
        chat.reorderChats("c", [...ids("c")].reverse());
        fake.requests.length = 0;
        const result = await chatEdits.readChatsDetached(["d", "c", "nobody"]);
        expect([...result.keys()].sort()).toEqual(["c", "d", "nobody"]);
        expect(result.get("c")!.map((entry) => entry.id)).toEqual(ids("c"));
        expect(result.get("c")!.map((entry) => entry.id)).toEqual(fake.order("c")!.ids);
        expect(
            result
                .get("c")!
                .find((entry) => entry.id === "k")!
                .message.map((message) => message.data),
        ).toEqual(["A", "B", "C", "D"]);
        expect(result.get("d")!.map((entry) => entry.id)).toEqual(ids("d"));
        expect(result.get("c")!.length + result.get("d")!.length).toBe(13);
        expect(result.get("nobody")).toEqual([]);
        expect(fake.requests.map((request) => request.path)).toContain("/api/resources/read");
        // The copies are detached from the store.
        result.get("c")![0].name = "changed in the copy";
        expect(chat.chatList("c").map((entry) => entry.name)).not.toContain("changed in the copy");

        fake.requests.length = 0;
        expect((await chatEdits.readChatsDetached([])).size).toBe(0);
        expect(fake.requests).toEqual([]);
    });

    it("readChatsDetached refuses after a discard of a requested character's chat (not another's), and after a failed save", async () => {
        const { chat, characterStore, chatEdits, fake, sync } = await boot();
        characterStore.addCharacter({ chaId: "d", name: "D", chats: [newChat("kd", "KD")] });
        await sync.flushResources();
        // Another tab changed `k`; the local bulk removal needs the current revision, conflicts, and is discarded.
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { note: "remote" } }],
            },
        ]);
        chat.removeMessages(refK, ["b", "c"]);
        // Another tab replaced `d`; the local edit conflicts and is discarded too.
        fake.set("characters", "d", { ...fake.record("characters", "d")!.data, name: "D remote" });
        characterStore.updateCharacter("d", { name: "D local" });
        await expect(chatEdits.readChatsDetached(["c"])).rejects.toThrow(/discarded.*chats\/c\/k/);
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
        // Only the requested characters' discards refuse: `d`'s was reported by that same save.
        expect(alerts.error).not.toHaveBeenCalled();
        const read = await chatEdits.readChatsDetached(["d"]);
        expect(read.get("d")!.map((entry) => entry.id)).toEqual(["kd"]);

        chat.appendMessage(refK, m("z", "Z"));
        fake.failNext = { status: 500, times: 3, match: (path) => path.includes("/api/resources/batch") };
        await expect(chatEdits.readChatsDetached(["c"])).rejects.toThrow();
        fake.failNext = null;
    });

    it("exportAsDataset exports every chat of every non-group character as saved, read from the server; a refused read exports nothing", async () => {
        const { chat, characterStore, dataset, downloads, sync, fake } = await boot();
        characterStore.updateCharacter("c", { desc: "about C", globalLore: [{ key: "lore", content: "the lore" }] });
        characterStore.addCharacter({ chaId: "d", name: "D", chats: [newChat("kd", "KD", ["from d"])] });
        characterStore.addCharacter({
            chaId: "g",
            type: "group",
            name: "G",
            characters: ["c"],
            chats: [newChat("kg", "KG", ["group"])],
        });
        chat.appendMessage(refK, m("z", "Z"));
        await dataset.exportAsDataset();
        expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.normal).toHaveBeenCalledTimes(1);
        expect(downloads).toHaveLength(1);
        expect(downloads[0].name).toBe("dataset.json");
        const exported = JSON.parse(downloads[0].data) as {
            name: string;
            description: string;
            chats: any[];
            lorebook: any[];
        }[];
        expect(exported.map((entry) => entry.name)).toEqual(["C", "C", "D"]);
        expect(exported[0]).toMatchObject({ description: "about C", lorebook: [{ key: "lore", content: "the lore" }] });
        expect(exported[0].chats.map((message) => message.data)).toEqual(["A", "B", "C", "Z"]);
        expect(exported[1].chats).toEqual([]);
        expect(exported[2].chats.map((message) => message.data)).toEqual(["from d"]);
        // The unsent message was saved by the export's read.
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C", "Z"]);

        chat.appendMessage(refK, m("y", "Y"));
        fake.failNext = { status: 500, times: 3, match: (path) => path.includes("/api/resources/batch") };
        await dataset.exportAsDataset();
        fake.failNext = null;
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(downloads).toHaveLength(1);
        await sync.flushResources();
    });
});
