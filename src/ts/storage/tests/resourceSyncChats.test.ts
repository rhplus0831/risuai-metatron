import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_EPOCH_HEADER, RESOURCE_KIND } from "../../../../shared/resources.ts";
import { StoreBackedServer } from "./storeBackedServer";

// The save adapter (`resourceSync.svelte.ts`) together with the chat module (`chatStore.svelte.ts`)
// against the real server store: mixed batches, the request caps, quarantine, conflicts, deferral,
// hydration, and the flush barrier. Each test boots a fresh module graph, as `resourceSync.test.ts`
// does; that file keeps the resource-only behavior.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type Stores = typeof import("../../stores.svelte");
type ChatModule = typeof import("../chatStore.svelte");
type Bootstrap = typeof import("../../bootstrap");

const KINDS = Object.values(RESOURCE_KIND);
const m = (id: string | undefined, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const refK = { chaId: "c", chatId: "k" };
const refJ = { chaId: "c", chatId: "j" };

/**
 * Boots the adapter and the chat module the way `loadData` does: the server holds the collections
 * and a character `c` with chats `k` (messages a, b, c) and `j` (empty); read with chats, seed,
 * assemble, select, start, and let the boot compare pass run (`bootBatches` is what it sent).
 */
async function boot(prepare?: (server: StoreBackedServer) => void) {
    vi.resetModules();
    const fake = await StoreBackedServer.create();
    // The store materialized the sections and collections when it opened; there is no `root` record
    // since slice 6, and the sample singleton edit of these tests is `ui.theme`.
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.store.applyChanges({
        ops: [{ kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "k",
                            name: "K",
                            note: "",
                            localLore: [],
                            message: [m("a", "A", "char"), m("b", "B"), m("c", "C", "char")],
                        } as any,
                    },
                ],
            },
            {
                characterId: "c",
                chatId: "j",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "j", name: "J", note: "", localLore: [], message: [] } as any }],
            },
        ],
    });
    prepare?.(fake);
    server.current = fake;

    const stores: Stores = await import("../../stores.svelte");
    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chat: ChatModule = await import("../chatStore.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    // `assembleDatabase` also assembles the chats into the characters.
    stores.DBState.db = bootstrap.assembleDatabase(snapshot);
    stores.selectedCharID.set(-1);
    chat.initializeChats();
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    const bootBatches = fake.batchBodies();
    fake.requests.length = 0;
    const db = () => stores.DBState.db as any;
    const mirrorIds = () => db().characters[0].chats.map((entry: any) => entry.id) as string[];
    return { fake, stores, client, sync, chat, bootBatches, db, mirrorIds };
}

beforeEach(() => {
    localStorage.clear();
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

describe("boot and mixed batches", () => {
    it("hydrates the chats without echoing anything back, and keeps chats out of the character record", async () => {
        const { fake, sync, db, bootBatches, mirrorIds } = await boot();
        expect(bootBatches).toEqual([]);
        expect(mirrorIds()).toEqual(["k", "j"]);
        expect(db().characters[0].chatPage).toBe(0);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        db().characters[0].name = "renamed";
        db().characters[0].chatPage = 1;
        sync.markCharactersDirty(["c"]);
        await sync.flushResources();
        const saved = fake.record("characters", "c")!.data as any;
        expect(saved.name).toBe("renamed");
        expect(saved).not.toHaveProperty("chats");
        expect(saved).not.toHaveProperty("chatPage");
    });

    it("sends resource ops, chat groups, and reorders in one request, without touching the character revision", async () => {
        const { fake, sync, chat, db, mirrorIds } = await boot();
        const characterRevision = fake.record("characters", "c")!.revision;
        db().theme = "edited";
        chat.appendMessage(refK, m("d", "D"));
        chat.setChatMeta(refJ, { note: "j note" });
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "X")] } as any, { index: 0 });
        chat.reorderChats("c", ["j", "n", "k"]);
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(fake.batchCount()).toBe(1);
        const [body] = fake.batchBodies();
        expect(body.ops.map((op: any) => op.kind)).toEqual(["ui"]);
        expect(body.chats.map((group: any) => [group.chatId, group.ops.map((op: any) => op.op)])).toEqual([
            ["n", ["create"]],
            ["k", ["append"]],
            ["j", ["meta"]],
        ]);
        expect(body.chatOrders).toHaveLength(1);
        expect(fake.record("ui", "main")!.data).toMatchObject({ theme: "edited" });
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C", "D"]);
        expect(fake.texts("c", "n")).toEqual(["X"]);
        expect((fake.chat("c", "j")!.data as any).note).toBe("j note");
        expect(fake.order("c")!.ids).toEqual(["j", "n", "k"]);
        expect(mirrorIds()).toEqual(["j", "n", "k"]);
        expect(fake.record("characters", "c")!.revision).toBe(characterRevision);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
    });

    it("creates a new character's chats exactly once, with the record holding none of them", async () => {
        const { fake, sync, db } = await boot();
        db().characters.push({
            chaId: "d",
            name: "D",
            type: "character",
            chats: [
                { id: "d1", name: "One", message: [m("x", "X")] },
                { name: "Two", message: [] },
            ],
            chatPage: 1,
        });
        await sync.flushResources();
        expect(fake.record("characters", "d")!.data).not.toHaveProperty("chats");
        const order = fake.order("d")!;
        expect(order.ids).toHaveLength(2);
        expect(order.ids[0]).toBe("d1");
        expect(fake.texts("d", "d1")).toEqual(["X"]);
        expect(db().characters[1].chats.map((entry: any) => entry.id)).toEqual(order.ids);
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
        expect(fake.store.readKinds([fake.kind("characters")], { chats: true }).chats).toHaveLength(4);
    });

    it("renames a message id the server refuses and redirects the edit queued meanwhile", async () => {
        const { fake, sync, chat } = await boot();
        const ref = { chaId: "c", chatId: "n" };
        fake.holdNextBatch = true;
        chat.createChat("c", { id: "n", name: "N", message: [m("bad\tid", "old")] } as any);
        const first = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        chat.setMessageText(ref, "bad\tid", "edited during the create");
        fake.releaseBatch!();
        await first;
        const serverId = fake.chat("c", "n")!.data.message[0].chatId as string;
        expect(serverId).not.toBe("bad\tid");
        expect(chat.findChat(ref)!.message[0].chatId).toBe(serverId);
        await vi.waitFor(() => expect(fake.texts("c", "n")).toEqual(["edited during the create"]), { timeout: 3000 });
    });
});

describe("the flush barrier", () => {
    it("waits for chat work already in flight", async () => {
        const { fake, sync, chat } = await boot();
        fake.holdNextBatch = true;
        chat.setChatMeta(refK, { note: "in flight" });
        const first = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        let secondSettled = false;
        const second = sync.flushResources().then((result) => {
            secondSettled = true;
            return result;
        });
        await vi.advanceTimersByTimeAsync(50);
        expect(secondSettled).toBe(false);
        expect((fake.chat("c", "k")!.data as any).note).toBe("");
        fake.releaseBatch!();
        await first;
        expect((await second).discarded).toEqual([]);
        expect((fake.chat("c", "k")!.data as any).note).toBe("in flight");
    });

    it("keeps a chat edit made during a request queued and sends it in the next cycle", async () => {
        const { fake, sync, chat } = await boot();
        fake.holdNextBatch = true;
        chat.setMessageText(refK, "a", "first");
        const flushed = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        chat.setMessageText(refK, "a", "second");
        chat.setChatMeta(refK, { note: "meanwhile" });
        fake.releaseBatch!();
        await flushed;
        expect(fake.texts("c", "k")[0]).toBe("first");
        await vi.waitFor(() => expect(fake.texts("c", "k")[0]).toBe("second"), { timeout: 3000 });
        expect((fake.chat("c", "k")!.data as any).note).toBe("meanwhile");
        expect(fake.batchCount()).toBe(2);
    });

    it("treats a create whose answer was lost as landed", async () => {
        const { fake, sync, chat } = await boot();
        fake.dropNextBatchResponse = true;
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "old")] } as any);
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.chat("c", "n")).not.toBeNull();
        chat.setMessageText({ chaId: "c", chatId: "n" }, "x", "newer");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(fake.texts("c", "n")).toEqual(["newer"]);
        expect(alerts.normal).not.toHaveBeenCalled();
    });
});

describe("request caps", () => {
    it("sends more than 5,000 unsent ops of one chat over several requests without losing any or blocking other chats", async () => {
        const { fake, sync, chat } = await boot();
        for (let index = 0; index <= 5000; index += 1) {
            if (index % 2 === 1) {
                chat.setChatMeta(refK, { note: `note ${index}` });
            } else {
                chat.setMessageText(refK, "a", `text ${index}`);
            }
        }
        chat.setChatMeta(refJ, { note: "must persist" });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(fake.texts("c", "k")[0]).toBe("text 5000");
        expect((fake.chat("c", "k")!.data as any).note).toBe("note 4999");
        expect((fake.chat("c", "j")!.data as any).note).toBe("must persist");
        const nested = fake
            .batchBodies()
            .map((body) => body.chats.reduce((sum: number, group: any) => sum + group.ops.length, 0));
        expect(nested.length).toBeGreaterThanOrEqual(2);
        expect(Math.max(...nested)).toBeLessThanOrEqual(5000);
        expect(nested.reduce((sum, count) => sum + count, 0)).toBe(5002);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("bases a reorder sent in a later request on the order revision its own earlier request produced", async () => {
        const { fake, sync, chat, mirrorIds } = await boot();
        chat.reorderChats("c", ["j", "k"]);
        chat.createChat("c", { id: "n", name: "N", message: [] } as any);
        for (let index = 0; index < 4999; index += 1) {
            if (index % 2 === 1) {
                chat.setChatMeta(refK, { note: `note ${index}` });
            } else {
                chat.setMessageText(refK, "a", `text ${index}`);
            }
        }
        expect(mirrorIds()).toEqual(["j", "k", "n"]);
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
        const bodies = fake.batchBodies();
        expect(bodies.length).toBeGreaterThanOrEqual(2);
        // The create went in an earlier request than the reorder.
        const createRequest = bodies.findIndex((body) => body.chats.some((group: any) => group.chatId === "n"));
        const orderRequest = bodies.findIndex((body) => body.chatOrders.length > 0);
        expect(createRequest).toBeGreaterThanOrEqual(0);
        expect(orderRequest).toBeGreaterThan(createRequest);
        expect(fake.order("c")!.ids).toEqual(["j", "k", "n"]);
        expect(mirrorIds()).toEqual(["j", "k", "n"]);
    });
});

describe("one chat's trouble does not block the rest", () => {
    it("quarantines a chat whose data the server refuses and keeps saving the others and the ui section", async () => {
        // The per-chat quarantine relies on the server naming the group (`chats[i]...`) in every
        // validation error of a chat group, including one found while applying the group (a `meta`
        // patch whose merged result the normalizer refuses).
        const { fake, sync, chat, db } = await boot();
        chat.setChatMeta(refK, { fmIndex: "not a number" as any });
        chat.setChatMeta(refJ, { note: "fine" });
        db().theme = "section edit";
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["chats/c/k"]);
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.error.mock.calls[0][0]).toMatch(/chat k could not be saved: chats\[0\]\.ops\[0\]/);
        expect((fake.chat("c", "j")!.data as any).note).toBe("fine");
        expect(fake.record("ui", "main")!.data).toMatchObject({ theme: "section edit" });
        expect((fake.chat("c", "k")!.data as any).fmIndex).toBeUndefined();
        expect(chat.hasChatWork()).toBe(false);
        chat.setChatMeta(refJ, { note: "still saving" });
        await sync.flushResources();
        expect((fake.chat("c", "j")!.data as any).note).toBe("still saving");
    });

    it("defers the conflict of a chat a server job streams into, saves the rest on its own, and reloads the chat once the job ends", async () => {
        const { fake, sync, chat, db } = await boot();
        chat.applyServerGeneration(refK, { jobId: "J", messageId: "a", generationId: "g", text: "streamed", seq: 0 });
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { note: "remote" } }],
            },
        ]);
        chat.removeMessages(refK, ["b", "c"]);
        chat.setChatMeta(refJ, { note: "j saved" });
        db().theme = "section saved";
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        await vi.waitFor(() => expect(fake.record("ui", "main")!.data).toMatchObject({ theme: "section saved" }), {
            timeout: 5000,
        });
        await vi.waitFor(() => expect((fake.chat("c", "j")!.data as any).note).toBe("j saved"), { timeout: 5000 });
        expect(chat.findChat(refK)!.message.map((message) => message.data)).toEqual(["streamed"]);
        expect(chat.isMessageLocked(refK, "a")).toBe(true);

        chat.endServerJob("J");
        expect(chat.isMessageLocked(refK, "a")).toBe(false);
        const result = await sync.flushResources();
        // The bulk removal is discarded with the reload; the server's copy replaces the chat.
        expect(result.discarded).toEqual(["chats/c/k"]);
        expect(chat.findChat(refK)!.message.map((message) => message.data)).toEqual(["A", "B", "C"]);
        expect((chat.findChat(refK) as any).note).toBe("remote");
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("re-bases a chat acknowledged on an older revision once it is idle, so a later revision-bound op does not conflict", async () => {
        const { fake, sync, chat } = await boot();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "b", text: "remote" }],
            },
        ]);
        chat.setChatMeta(refK, { note: "mine" });
        const stale = await sync.flushResources();
        expect(stale.discarded).toEqual([]);
        await vi.waitFor(() => expect(chat.findChat(refK)!.message[1].data).toBe("remote"), { timeout: 5000 });
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect((chat.findChat(refK) as any).note).toBe("mine");
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");

        chat.removeMessages(refK, ["b", "c"]);
        const bulk = await sync.flushResources();
        expect(bulk.discarded).toEqual([]);
        expect(fake.texts("c", "k")).toEqual(["A"]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
    });

    it("removes a character another tab deleted, with its chats, and moves the selection home", async () => {
        const { fake, sync, chat, db, stores } = await boot();
        fake.store.delete(fake.kind("characters"), "c", fake.record("characters", "c")!.revision);
        stores.selectedCharID.set(0);
        await tick();
        chat.setChatMeta(refK, { note: "edit on a deleted character's chat" });
        const result = await sync.flushResources();
        expect(result.discarded.sort()).toEqual(["characters/c", "chats/c/k"]);
        expect(db().characters).toEqual([]);
        expect(get(stores.selectedCharID)).toBe(-1);
        expect(chat.hasChatWork()).toBe(false);
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
    });

    it("learns about chats another tab created when its own create is acknowledged, and keeps saving", async () => {
        const { fake, sync, chat, mirrorIds } = await boot();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "r",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "r", name: "R", message: [] } as any }],
            },
        ]);
        chat.createChat("c", { id: "local", name: "L", message: [] } as any);
        await sync.flushResources();
        chat.reorderChats("c", ["local", "k", "j"]);
        chat.setChatMeta(refJ, { note: "must save" });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(mirrorIds()).toEqual(fake.order("c")!.ids);
        expect(mirrorIds()).toContain("r");
        expect((fake.chat("c", "j")!.data as any).note).toBe("must save");
    });
});

describe("pagehide", () => {
    it("sends pending by-id work with keepalive requests, one per chat, and a page that survives settles its revision so a later current-revision op does not conflict with its own write", async () => {
        const { fake, sync, chat } = await boot();
        // The unload request bypasses `authFetch` (a pre-signed token, `keepalive`): the raw fetch.
        // Listeners of earlier module graphs stay on the shared window; only this graph's epoch counts.
        const keepalive: RequestInit[] = [];
        vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
            if (new Headers(init.headers).get(RESOURCE_EPOCH_HEADER) === fake.store.epoch()) {
                keepalive.push(init);
            }
            return fake.fetch(path, init);
        });
        chat.setMessageText(refK, "a", "unload write");
        chat.setChatMeta(refJ, { note: "j is not held" });
        const batches = fake.batchCount();

        window.dispatchEvent(new Event("pagehide"));
        // The pending by-id work of each existing chat in its own request.
        expect(keepalive).toHaveLength(2);
        expect(keepalive.map((init) => init.keepalive)).toEqual([true, true]);
        expect(new Headers(keepalive[0].headers).get("risu-auth")).toBe("signed-token");
        expect(JSON.parse(keepalive[0].body as string)).toEqual({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: expect.any(String),
                    ops: [{ op: "setText", id: "a", text: "unload write" }],
                },
            ],
        });
        expect(JSON.parse(keepalive[1].body as string)).toEqual({
            chats: [
                {
                    characterId: "c",
                    chatId: "j",
                    baseRevision: expect.any(String),
                    ops: [{ op: "meta", set: { note: "j is not held" }, unset: [] }],
                },
            ],
        });
        await vi.waitFor(() => expect(fake.texts("c", "k")[0]).toBe("unload write"));
        await vi.waitFor(() => expect((fake.chat("c", "j")!.data as any).note).toBe("j is not held"));

        // The page survived (back-forward cache): the answers settle k and j, and k's later work
        // goes out on the revision the unload write produced.
        chat.setChatMeta(refK, { note: "after the page came back" });
        await vi.waitFor(() => expect(chat.hasChatWork()).toBe(true));
        await sync.flushResources();
        expect((fake.chat("c", "j")!.data as any).note).toBe("j is not held");
        expect((fake.chat("c", "k")!.data as any).note).toBe("after the page came back");
        const groupsSent = fake
            .batchBodies()
            .slice(batches)
            .flatMap((body) => body.chats ?? [])
            .filter((group: any) => group.chatId === "k");
        // The unload request's group, then the note; the text the unload request carried is not sent again.
        expect(groupsSent.map((group: any) => group.ops.map((op: any) => op.op))).toEqual([["setText"], ["meta"]]);

        // A current-revision op (a bulk removal) needs the current revision (a self-conflict would
        // reload the chat with the notice and discard its work).
        chat.removeMessages(refK, ["b", "c"]);
        const flushed = await sync.flushResources();
        expect(flushed.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(fake.texts("c", "k")).toEqual(["unload write"]);
    });

    it("sends nothing without pending work, and resumes a chat's saving when the unload request fails", async () => {
        const { fake, sync, chat } = await boot();
        let calls = 0;
        vi.stubGlobal("fetch", (_path: string, init: RequestInit) => {
            if (new Headers(init.headers).get(RESOURCE_EPOCH_HEADER) === fake.store.epoch()) {
                calls += 1;
            }
            return Promise.reject(new TypeError("Failed to fetch"));
        });
        window.dispatchEvent(new Event("pagehide"));
        expect(calls).toBe(0);

        chat.setMessageText(refK, "a", "unload write");
        window.dispatchEvent(new Event("pagehide"));
        expect(calls).toBe(1);
        // A chat whose unload request is out sends nothing until the answer or the failure.
        chat.setChatMeta(refK, { note: "queued behind the unload request" });
        await vi.waitFor(() => expect(chat.hasChatWork()).toBe(true));
        await sync.flushResources();
        expect((fake.chat("c", "k")!.data as any).note).toBe("queued behind the unload request");
        expect(fake.texts("c", "k")[0]).toBe("unload write");
    });
});

// Phase 5 cutover: a row rendered before its chat's first save had no transform context, so the
// chat module counts the first revision it holds for a chat (`chatSaveVersion`, reactive), and
// `Chat.svelte` renders the chat's rows again when that count moves.
describe("a chat's first save (chatSaveVersion)", () => {
    const refN = { chaId: "c", chatId: "n" };

    it("moves once when a new chat's create is acknowledged (a reactive change), never for the boot seed, a later save, or another chat", async () => {
        const { fake, sync, chat } = await boot();
        // Loaded after the boot's module reset, so the probe and the chat module share one Svelte runtime.
        const { createProbe } = await import("./reactiveProbe.svelte");
        const { flushSync } = await import("svelte");
        expect(chat.chatSaveVersion(refK)).toBe(0);
        chat.setChatMeta(refK, { note: "saved again" });
        await sync.flushResources();
        expect(chat.chatSaveVersion(refK)).toBe(0);

        const probe = createProbe(() => chat.chatSaveVersion(refN));
        fake.holdNextBatch = true;
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "X")] } as any);
        const first = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        expect(chat.heldChatRevision(refN)).toBeNull();
        expect(chat.chatSaveVersion(refN)).toBe(0);
        fake.releaseBatch!();
        await first;
        flushSync();
        expect(chat.heldChatRevision(refN)).not.toBeNull();
        expect(probe.seen).toEqual([0, 1]);

        chat.setMessageText(refN, "x", "Y");
        chat.setChatMeta(refK, { note: "and again" });
        await sync.flushResources();
        flushSync();
        expect(fake.texts("c", "n")).toEqual(["Y"]);
        expect(probe.seen).toEqual([0, 1]);
        expect(chat.chatSaveVersion(refK)).toBe(0);
        expect(chat.chatSaveVersion({ chaId: "c", chatId: "j" })).toBe(0);
        probe.dispose();
    });

    it("moves once for a create whose answer was lost, when the next flush recognizes it as landed", async () => {
        const { fake, sync, chat } = await boot();
        fake.dropNextBatchResponse = true;
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "X")] } as any);
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.chat("c", "n")).not.toBeNull();
        expect(chat.chatSaveVersion(refN)).toBe(0);
        chat.setMessageText(refN, "x", "after the lost answer");
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.texts("c", "n")).toEqual(["after the lost answer"]);
        expect(chat.chatSaveVersion(refN)).toBe(1);
        chat.setMessageText(refN, "x", "later");
        await sync.flushResources();
        expect(chat.chatSaveVersion(refN)).toBe(1);
    });
});
