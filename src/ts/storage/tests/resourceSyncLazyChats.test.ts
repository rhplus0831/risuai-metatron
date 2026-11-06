import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { textHash } from "../../../../shared/textHash.ts";
import { warmMutationGraph } from "./mutationStoresHarness";
import { type ServerFeedEvent, StoreBackedServer } from "./storeBackedServer";

// The save adapter and the chat module booted from summaries, as `loadData` boots them (`readKinds`
// with `chatSummaries`), against the real server store and its change feed, with the save loop
// running for real:
// - the boot pass writes nothing, and selecting a character reads its selected chat only;
// - a live notice for an unloaded chat refreshes its summary through the character's list (no
//   whole-chat read), a loaded chat is read whole; nothing is written back and no notice is shown;
// - an unloaded chat with list-field work keeps its summary and its notice through the live update;
//   its stale acknowledgement is rebased through the list, and the loop converges without polling;
// - `readChatsDetached` and `exportAsDataset` are complete over chats that are not loaded (beyond the
//   LRU's cap) and load none of them;
// - `editChat` on an unloaded chat loads it, keeps it loaded through its callback, and applies
//   nothing to a character whose chats were replaced meanwhile.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
}));

vi.mock("../serverAuth", () => ({
    authFetch: async (path: string, init?: RequestInit, options: { beforeDispatch?: () => void } = {}) => {
        options.beforeDispatch?.();
        return server.current.fetch(path, init);
    },
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertTerminal: alerts.terminal,
    }),
);
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", async () => (await import("../../tests/globalApiMock")).createGlobalApiMock());

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type ChatModule = typeof import("../chatStore.svelte");
type Bootstrap = typeof import("../../bootstrap");
type Selection = typeof import("../selection.svelte");

const KINDS = Object.values(RESOURCE_KIND);
const m = (id: string, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const create = (characterId: string, id: string, chat: Record<string, unknown>) => ({
    characterId,
    chatId: id,
    baseRevision: null,
    ops: [{ op: "create", chat: { id, name: id.toUpperCase(), note: "", localLore: [], message: [], ...chat } }],
});
const refK = { chaId: "c", chatId: "k" };
const EXTRA = 8;
/** `c`'s chat ids in server order: `k`, `j`, then `n0`..`n7`. */
const C_IDS = ["k", "j", ...Array.from({ length: EXTRA }, (_, i) => `n${i}`)];

/**
 * Boots the adapter and the chat module from summaries, the way `loadData` does, against a
 * store-backed server with the change feed: character `c` with chats `k` (messages a, b, c), `j`
 * (empty), and `n0`..`n7` (one message each; `n1` in folder `f`), and character `d` with chat `m`.
 * Nothing is selected. Then live delivery starts.
 */
async function boot() {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ lock: true, feed: true });
    fake.set("presets", "main", [{ id: "pa", name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.store.applyChanges({
        ops: [
            { kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } },
            { kind: fake.kind("characters"), id: "d", baseRevision: null, data: { chaId: "d", name: "D" } },
        ],
        chats: [
            create("c", "k", { message: [m("a", "A", "char"), m("b", "B", "char"), m("c", "C")] }),
            create("c", "j", {}),
            ...Array.from({ length: EXTRA }, (_, i) =>
                create("c", `n${i}`, { message: [m(`n${i}-0`, `N${i}`)], ...(i === 1 ? { folderId: "f" } : {}) }),
            ),
            create("d", "m", { message: [m("x", "X")] }),
        ],
    });
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chat: ChatModule = await import("../chatStore.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const selection: Selection = await import("../selection.svelte");
    const chatEdits = await import("../chatEdits");
    const dataset = await import("../exportAsDataset");
    const globalApi = await import("../../globalApi.svelte");

    const snapshot = await client.readKinds(KINDS, { chatSummaries: true });
    expect(snapshot.chats).toBeUndefined();
    expect(snapshot.chatSummaries).toHaveLength(C_IDS.length + 1);
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chatSummaries ?? [], snapshot.chatOrders ?? []);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    chat.initializeChats();
    const adding = vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    const addingDocument = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    sync.startResourceSync();
    adding.mockRestore();
    addingDocument.mockRestore();
    await tick();
    await sync.flushResources();
    const bootBatches = fake.batchCount();
    fake.requests.length = 0;
    fake.feedEvents.length = 0;

    const live = { paused: false, queue: [] as ServerFeedEvent[] };
    const deliver = (event: ServerFeedEvent) => {
        if (event.type === "change" && event.epoch === client.getResourceEpoch()) {
            sync.noteRemoteChanges(event.changes);
        }
    };
    fake.onFeed = (event) => (live.paused ? live.queue.push(event) : deliver(event));
    const flushFeed = () => {
        for (const event of live.queue.splice(0)) {
            deliver(event);
        }
    };
    const downloads: { name: string; data: string }[] = [];
    vi.mocked(globalApi.downloadFile).mockImplementation((async (name: string, data: Uint8Array | string) => {
        downloads.push({ name, data: typeof data === "string" ? data : Buffer.from(data).toString("utf-8") });
    }) as any);

    /** The `/api/resources/read` requests so far: the chats and the summary lists each asked for. */
    const reads = () =>
        fake.requests
            .filter((request) => request.path === "/api/resources/read")
            .map((request) => ({
                chats: ((request.body.chats ?? []) as { characterId: string; id: string }[]).map(
                    (entry) => `${entry.characterId}/${entry.id}`,
                ),
                summaries: (request.body.chatSummaryCollections ?? []) as string[],
                collections: (request.body.chatCollections ?? []) as string[],
            }));
    const loadedIds = (chaId: string) =>
        chat
            .chatList(chaId)
            .map((entry) => entry.id)
            .filter((id) => chat.findChat({ chaId, chatId: id }) !== undefined);
    /** Another tab's `meta` write on a chat. */
    const remoteMeta = (chaId: string, chatId: string, set: Record<string, unknown>) =>
        fake.chatBatch([
            {
                characterId: chaId,
                chatId,
                baseRevision: fake.chat(chaId, chatId)!.revision,
                ops: [{ op: "meta", set, unset: [] } as any],
            },
        ]);
    return {
        fake,
        sync,
        chat,
        selection,
        chatEdits,
        dataset,
        downloads,
        live,
        flushFeed,
        bootBatches,
        reads,
        loadedIds,
        remoteMeta,
    };
}

beforeAll(() => warmMutationGraph(() => import("../exportAsDataset")), 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("location", { reload: vi.fn(), protocol: "http:", host: "test" });
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

/** Advances past the cycle's delay and lets it finish; then asserts that nothing else follows (no polling). */
async function settle(fake: StoreBackedServer) {
    await vi.advanceTimersByTimeAsync(1500);
    const before = { batches: fake.batchCount(), all: fake.requests.length };
    await vi.advanceTimersByTimeAsync(5000);
    expect({ batches: fake.batchCount(), all: fake.requests.length }).toEqual(before);
}
const noNotice = () => {
    expect(alerts.normal).not.toHaveBeenCalled();
    expect(alerts.error).not.toHaveBeenCalled();
};

describe("the boot from summaries", () => {
    it("writes nothing at boot; selecting a character reads its selected chat only; the chat's by-id live update applies as a patch and a whole-chat one refreshes it whole", async () => {
        const { fake, chat, selection, reads, remoteMeta } = await boot();
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(C_IDS);
        expect(chat.chatEntry({ chaId: "c", chatId: "n1" })).toEqual({
            id: "n1",
            name: "N1",
            fmIndex: -1,
            folderId: "f",
        });
        expect(C_IDS.every((id) => chat.findChat({ chaId: "c", chatId: id }) === undefined)).toBe(true);
        expect(reads()).toEqual([]);
        await settle(fake);
        expect(fake.batchCount()).toBe(0);
        expect(reads()).toEqual([]);

        selection.selectCharacter("c");
        await vi.advanceTimersByTimeAsync(50);
        expect(chat.selectedChat()?.id).toBe("k");
        expect(reads()).toEqual([{ chats: ["c/k"], summaries: [], collections: [] }]);
        await settle(fake);
        expect(fake.batchCount()).toBe(0);
        // Another tab edits the selected (loaded, idle) chat's metadata by id: the feed's patch applies
        // at the revision this tab holds, with no read, no write back, and no notice.
        remoteMeta("c", "k", { name: "K remote" });
        const metaEntry = (fake.feedEvents.at(-1) as Extract<ServerFeedEvent, { type: "change" }>).changes.chats[0];
        expect(metaEntry.patch).toMatchObject({ meta: { name: "K remote" } });
        await settle(fake);
        expect(chat.selectedChat()?.name).toBe("K remote");
        expect(reads()).toEqual([{ chats: ["c/k"], summaries: [], collections: [] }]);
        expect(fake.batchCount()).toBe(0);
        noNotice();
        // A whole-chat write (`replace`) carries no patch: the chat is read whole.
        const replaced = JSON.parse(JSON.stringify(fake.chat("c", "k")!.data));
        replaced.name = "K replaced";
        replaced.message[0].data = "A replaced";
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "replace", chat: replaced } as any],
            },
        ]);
        const replaceEntry = (fake.feedEvents.at(-1) as Extract<ServerFeedEvent, { type: "change" }>).changes.chats[0];
        expect(replaceEntry).not.toHaveProperty("patch");
        await settle(fake);
        expect(chat.selectedChat()?.name).toBe("K replaced");
        expect(chat.selectedChat()?.message.map((message) => message.data)).toEqual(["A replaced", "B", "C"]);
        expect(reads()).toEqual([
            { chats: ["c/k"], summaries: [], collections: [] },
            { chats: ["c/k"], summaries: [], collections: [] },
        ]);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });
});

describe("live updates of chats that are not loaded", () => {
    it("keeps a row delta's chat unloaded while advancing its known summary without reads", async () => {
        const b = await boot();
        const data = "x".repeat(100 * 1024);
        const writeText = (text: string) =>
            b.fake.chatBatch([
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: b.fake.chat("c", "k")!.revision,
                    ops: [{ op: "setText", id: "b", text }],
                },
            ]);
        writeText(data);
        const summary = JSON.parse(JSON.stringify(b.chat.chatEntry(refK)));
        const baseRevision = b.chat.heldChatRevision(refK);
        writeText(data + " appended");
        const event = b.fake.feedEvents.at(-1)!;
        if (event.type !== "change") throw new Error("expected a committed change");
        expect(event.changes.chats).toEqual([
            {
                characterId: "c",
                id: "k",
                revision: b.fake.chat("c", "k")!.revision,
                summaryBase: baseRevision,
                rowDelta: {
                    baseRevision,
                    count: 3,
                    rowDiffs: [
                        {
                            id: "b",
                            text: {
                                keep: data.length,
                                text: " appended",
                                base: { length: data.length, hash: textHash(data) },
                            },
                        },
                    ],
                },
            },
        ]);
        expect(b.chat.findChat(refK)).toBeUndefined();
        expect(b.reads()).toEqual([]);
        await settle(b.fake);
        expect(b.chat.findChat(refK)).toBeUndefined();
        expect(b.chat.chatEntry(refK)).toEqual(summary);
        expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        expect(b.reads()).toEqual([]);
        expect(b.fake.batchCount()).toBe(0);
        expect(b.chat.hasChatWork()).toBe(false);
        noNotice();
    });

    it("installs known summaries and advances matching summary bases without collection reads or writes", async () => {
        const b = await boot();
        const order = b.chat.heldOrderRevision("c");
        const base = b.chat.heldChatRevision(refK);
        b.remoteMeta("c", "k", {
            name: "Renamed",
            folderId: "folder",
            pinned: true,
            modelPresetId: "model",
            bindingReview: false,
        });
        const entry = {
            id: "k",
            name: "Renamed",
            fmIndex: -1,
            folderId: "folder",
            pinned: true,
            modelPresetId: "model",
            bindingReview: false,
        };
        expect(b.chat.chatEntry(refK)).toEqual(entry);
        expect(b.chat.heldChatRevision(refK)).not.toBe(base);
        const renamed = b.chat.heldChatRevision(refK);
        b.fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: renamed,
                ops: [{ op: "setText", id: "b", text: "checkpoint" }],
            },
        ]);
        expect(b.chat.chatEntry(refK)).toEqual(entry);
        expect(b.chat.heldChatRevision(refK)).not.toBe(renamed);
        expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        b.fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: b.fake.chat("c", "k")!.revision,
                ops: [{ op: "append", anchor: { end: true }, messages: [{ ...m("dated", "D"), time: 100 }] }],
            },
        ]);
        expect(b.chat.characterLastChattedAt("c", 777)).toBe(100);
        b.fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: b.fake.chat("c", "k")!.revision,
                ops: [{ op: "remove", ids: ["dated"] }],
            },
        ]);
        expect(b.chat.characterLastChattedAt("c", 777)).toBe(777);
        await settle(b.fake);
        expect(b.chat.chatEntry(refK)).toEqual(entry);
        expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
        expect(b.chat.heldOrderRevision("c")).toBe(order);
        expect(b.chat.chatList("c").map(({ id }) => id)).toEqual(C_IDS);
        expect(b.chat.findChat(refK)).toBeUndefined();
        expect(b.reads()).toEqual([]);
        expect(b.fake.batchCount()).toBe(0);
        expect(b.chat.hasChatWork()).toBe(false);
        noNotice();
    });

    it("reads the summary collection after a missed rename, an unknown notice or a reconnect listing", async () => {
        for (const notice of ["missed rename", "unknown notice", "reconnect listing"]) {
            const b = await boot();
            const base = b.chat.heldChatRevision(refK);
            b.live.paused = true;
            b.remoteMeta("c", "k", { name: "Missed rename" });
            b.live.queue.length = 0;
            if (notice === "missed rename") {
                b.live.paused = false;
                b.fake.chatBatch([
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: b.fake.chat("c", "k")!.revision,
                        ops: [{ op: "setText", id: "b", text: "checkpoint" }],
                    },
                ]);
            } else if (notice === "reconnect listing") {
                b.sync.reconcileRemote(b.fake.store.listRevisions());
            } else {
                b.sync.noteRemoteChanges({
                    resources: [],
                    chats: [{ characterId: "c", id: "k", revision: b.fake.chat("c", "k")!.revision }],
                    chatOrders: [],
                });
            }
            expect(b.chat.chatEntry(refK)?.name, notice).toBe("K");
            expect(b.chat.heldChatRevision(refK), notice).toBe(base);
            expect(b.chat.isChatBehind(refK), notice).toBe(true);
            await settle(b.fake);
            expect(b.reads(), notice).toEqual([{ chats: [], summaries: ["c"], collections: [] }]);
            expect(b.chat.chatEntry(refK)?.name).toBe("Missed rename");
            expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
            expect(b.chat.findChat(refK)).toBeUndefined();
            expect(b.fake.batchCount()).toBe(0);
            expect(b.chat.hasChatWork()).toBe(false);
            noNotice();
            b.fake.close();
        }
    });

    it("reads membership for an unheld chat with a summary and for a deletion even without an order notice", async () => {
        const b = await boot();
        b.live.paused = true;
        b.fake.store.applyChanges({ chats: [create("c", "new", {})] });
        b.live.queue.length = 0;
        b.remoteMeta("c", "new", { name: "New remote" });
        const created = b.live.queue[0];
        if (created.type !== "change") throw new Error("expected a committed change");
        expect(created.changes.chats[0]).toHaveProperty("summary");
        b.sync.noteRemoteChanges({ ...created.changes, chatOrders: [] });
        expect(b.chat.chatEntry({ chaId: "c", chatId: "new" })).toBeUndefined();
        await settle(b.fake);
        expect(b.reads()).toEqual([{ chats: [], summaries: ["c"], collections: [] }]);
        expect(b.chat.chatList("c").map(({ id }) => id)).toEqual([...C_IDS, "new"]);
        expect(b.chat.chatEntry({ chaId: "c", chatId: "new" })?.name).toBe("New remote");
        expect(b.chat.findChat({ chaId: "c", chatId: "new" })).toBeUndefined();
        b.fake.requests.length = 0;
        b.live.queue.length = 0;
        b.fake.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: b.fake.chat("c", "k")!.revision, ops: [{ op: "delete" }] },
        ]);
        const deleted = b.live.queue[0];
        if (deleted.type !== "change") throw new Error("expected a committed change");
        b.sync.noteRemoteChanges({ ...deleted.changes, chatOrders: [] });
        await settle(b.fake);
        expect(b.reads()).toEqual([{ chats: [], summaries: ["c"], collections: [] }]);
        expect(b.chat.chatList("c").map(({ id }) => id)).toEqual([...C_IDS.filter((id) => id !== "k"), "new"]);
        expect(b.chat.heldChatRevision(refK)).toBeNull();
        expect(b.fake.batchCount()).toBe(0);
        expect(b.chat.hasChatWork()).toBe(false);
        noNotice();
    });

    it("keeps local work and stale summaries on the collection refresh path", async () => {
        for (const state of ["local work", "stale"]) {
            const b = await boot();
            const base = b.chat.heldChatRevision(refK);
            if (state === "local work") b.chat.setChatMeta(refK, { folderId: "mine" });
            else expect(b.chat.markChatStale(refK)).toBe(true);
            b.remoteMeta("c", "k", { name: "Remote" });
            expect(b.chat.chatEntry(refK)?.name, state).toBe("K");
            expect(b.chat.heldChatRevision(refK), state).toBe(base);
            expect(b.chat.isChatBehind(refK), state).toBe(true);
            if (state === "local work") expect(b.chat.chatEntry(refK)?.folderId).toBe("mine");
            await settle(b.fake);
            expect(b.reads().length).toBeGreaterThan(0);
            expect(
                b
                    .reads()
                    .every(
                        (read) =>
                            read.chats.length === 0 && read.collections.length === 0 && read.summaries.includes("c"),
                    ),
            ).toBe(true);
            expect(b.chat.chatEntry(refK)?.name).toBe("Remote");
            if (state === "local work") expect(b.chat.chatEntry(refK)?.folderId).toBe("mine");
            expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
            expect(b.chat.findChat(refK)).toBeUndefined();
            expect(b.fake.batchCount()).toBe(state === "local work" ? 1 : 0);
            expect(b.chat.hasChatWork()).toBe(false);
            noNotice();
            b.fake.close();
        }
    });

    it("a rename of an unloaded chat installs the feed's summary with no read, never the chat whole; a deleted one leaves the list and a new one arrives as a summary through the character's list", async () => {
        const { fake, chat, selection, reads, remoteMeta } = await boot();
        selection.selectCharacter("c");
        await settle(fake);
        fake.requests.length = 0;
        // The binding fields travel with the summary too, `false` kept.
        remoteMeta("c", "n0", { name: "N0 remote", folderId: "g", modelPresetId: "m1", bindingReview: false });
        await settle(fake);
        expect(chat.chatEntry({ chaId: "c", chatId: "n0" })).toEqual({
            id: "n0",
            name: "N0 remote",
            fmIndex: -1,
            folderId: "g",
            modelPresetId: "m1",
            bindingReview: false,
        });
        expect(chat.findChat({ chaId: "c", chatId: "n0" })).toBeUndefined();
        expect(chat.heldChatRevision({ chaId: "c", chatId: "n0" })).toBe(fake.chat("c", "n0")!.revision);
        // The rename's feed entry carries the new summary: neither the list nor the chat is read.
        expect(reads()).toEqual([]);
        expect(fake.batchCount()).toBe(0);

        // Deleted and created by another tab: the list follows; the new chat is a summary.
        fake.requests.length = 0;
        fake.store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "n7",
                    baseRevision: fake.chat("c", "n7")!.revision,
                    ops: [{ op: "delete" }],
                },
                create("c", "n8", { message: [m("n8-0", "N8")] }),
            ],
        });
        await settle(fake);
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual([...C_IDS.filter((id) => id !== "n7"), "n8"]);
        expect(chat.findChat({ chaId: "c", chatId: "n8" })).toBeUndefined();
        expect(chat.heldChatRevision({ chaId: "c", chatId: "n7" })).toBeNull();
        expect(reads().some((read) => read.summaries.includes("c"))).toBe(true);
        expect(reads().every((read) => read.chats.length === 0)).toBe(true);
        expect(fake.batchCount()).toBe(0);
        // The idle loop afterwards: nothing.
        expect(chat.hasChatWork()).toBe(false);
        noNotice();
    });

    it("an unloaded chat with list-field work keeps its summary and notice through the live update; its stale acknowledgement is rebased through the list, and the loop converges without polling or a write back", async () => {
        const { fake, chat, selection, live, flushFeed, reads, remoteMeta } = await boot();
        selection.selectCharacter("c");
        await settle(fake);
        fake.requests.length = 0;
        const target = { chaId: "c", chatId: "n1" };
        // The local refile is queued (the cycle has not run yet); another tab renames the chat meanwhile.
        live.paused = true;
        chat.setChatMeta(target, { folderId: "mine" });
        remoteMeta("c", "n1", { name: "N1 remote" });
        flushFeed();
        live.paused = false;
        // The notice went to the list; the busy chat keeps its summary.
        expect(chat.chatEntry(target)).toEqual({ id: "n1", name: "N1", fmIndex: -1, folderId: "mine" });
        await settle(fake);
        // Converged: the local folder and the remote name, the server's revision held, no marks left.
        expect(chat.chatEntry(target)).toEqual({ id: "n1", name: "N1 remote", fmIndex: -1, folderId: "mine" });
        expect(chat.findChat(target)).toBeUndefined();
        expect(fake.chat("c", "n1")!.data).toMatchObject({ name: "N1 remote", folderId: "mine" });
        expect(chat.heldChatRevision(target)).toBe(fake.chat("c", "n1")!.revision);
        expect(chat.hasChatWork()).toBe(false);
        // One batch (the refile, acknowledged stale), summary lists only, never the chat whole.
        expect(fake.batchCount()).toBe(1);
        expect(reads().every((read) => read.chats.length === 0 && read.collections.length === 0)).toBe(true);
        expect(reads().length).toBeGreaterThan(0);
        expect(reads().length).toBeLessThanOrEqual(3);
        noNotice();
    });

    it("this tab's own save of an unloaded chat's list field: the echo costs at most one summary list read, and nothing is written back", async () => {
        const { fake, chat, selection, reads } = await boot();
        selection.selectCharacter("c");
        await settle(fake);
        fake.requests.length = 0;
        const target = { chaId: "c", chatId: "n2" };
        chat.setChatMeta(target, { name: "Mine" });
        await settle(fake);
        expect(fake.chat("c", "n2")!.data.name).toBe("Mine");
        expect(chat.chatEntry(target)?.name).toBe("Mine");
        expect(chat.findChat(target)).toBeUndefined();
        expect(fake.batchCount()).toBe(1);
        expect(reads().every((read) => read.chats.length === 0)).toBe(true);
        expect(reads().length).toBeLessThanOrEqual(1);
        expect(chat.hasChatWork()).toBe(false);
        noNotice();
    });
});

describe("detached reads and exports over unloaded chats", () => {
    it("readChatsDetached and exportAsDataset answer every chat of every character complete, beyond the LRU's cap, and load none of them", async () => {
        const { fake, chat, chatEdits, dataset, downloads, reads, loadedIds } = await boot();
        const detached = await chatEdits.readChatsDetached(["c", "d"]);
        expect(detached.get("c")!.map((entry) => entry.id)).toEqual(C_IDS);
        expect(detached.get("c")![0].message.map((entry) => entry.data)).toEqual(["A", "B", "C"]);
        expect(
            detached
                .get("c")!
                .slice(2)
                .every((entry) => entry.message.length === 1),
        ).toBe(true);
        expect(detached.get("d")!.map((entry) => entry.id)).toEqual(["m"]);
        expect(loadedIds("c")).toEqual([]);
        expect(loadedIds("d")).toEqual([]);
        expect(reads()).toEqual([{ chats: [], summaries: [], collections: ["c", "d"] }]);

        await dataset.exportAsDataset();
        expect(downloads).toHaveLength(1);
        const entries = JSON.parse(downloads[0].data) as { name: string; chats: { data: string }[] }[];
        expect(entries).toHaveLength(C_IDS.length + 1);
        expect(entries.filter((entry) => entry.name === "C")).toHaveLength(C_IDS.length);
        expect(entries[0].chats.map((entry) => entry.data)).toEqual(["A", "B", "C"]);
        expect(entries.at(-1)!.chats.map((entry) => entry.data)).toEqual(["X"]);
        expect(loadedIds("c")).toEqual([]);
        expect(fake.batchCount()).toBe(0);
        expect(alerts.error).not.toHaveBeenCalled();
    });
});

describe("editChat on an unloaded chat", () => {
    it("loads the chat, keeps it loaded through the callback (a trim meanwhile takes others), applies the change by id, and applies nothing to a character whose chats were replaced during the callback", async () => {
        const { fake, chat, chatEdits, selection, loadedIds } = await boot();
        selection.selectCharacter("c");
        await settle(fake);
        const target = { chaId: "c", chatId: "n3" };
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const editing = chatEdits.editChat(target, async (draft) => {
            draft.note = "edited";
            await gate;
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(chat.findChat(target)).toBeDefined();
        // Eviction pressure while the callback waits: nine other idle chats loaded, then a trim.
        await chat.loadChats("c");
        await chat.loadChats("d");
        await vi.advanceTimersByTimeAsync(10);
        chat.trimLoadedChats();
        expect(loadedIds("c")).toContain("n3");
        expect(loadedIds("c")).toContain("k");
        expect(loadedIds("c").length + loadedIds("d").length).toBe(C_IDS.length);
        expect(loadedIds("c")).not.toContain("j");
        release();
        await editing;
        expect(chat.findChat(target)?.note).toBe("edited");
        await settle(fake);
        expect(fake.chat("c", "n3")!.data.note).toBe("edited");
        expect(fake.chat("c", "n3")!.data.message.map((entry: any) => entry.data)).toEqual(["N3"]);
        // Released: the next trim may take it.
        chat.trimLoadedChats();
        expect(loadedIds("c")).not.toContain("n3");

        // The character's chats replaced under the same ids while the callback waits: nothing applies.
        const other = { chaId: "c", chatId: "n4" };
        let releaseOther!: () => void;
        const otherGate = new Promise<void>((resolve) => (releaseOther = resolve));
        const batches = fake.batchCount();
        const otherEdit = chatEdits.editChat(other, async (draft) => {
            draft.note = "lost";
            await otherGate;
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(chat.findChat(other)).toBeDefined();
        chat.installCharacterChats(
            "c",
            C_IDS.map((id) => ({ id, name: id.toUpperCase(), note: "", localLore: [], message: [] })) as any,
            { firstMsgIndex: -1 },
        );
        releaseOther();
        await otherEdit;
        expect(chat.findChat(other)?.note).toBe("");
        await settle(fake);
        expect(fake.chat("c", "n4")!.data.note).toBe("");
        // The replacement's chats are unsaved creates in this tab (their own saves); the lost edit queued nothing of its own.
        expect(
            fake
                .batchBodies()
                .slice(batches)
                .flatMap((body: any) => body.chats ?? [])
                .some((group: any) => group.chatId === "n4" && group.ops.some((op: any) => op.op === "meta")),
        ).toBe(false);
    });
});

describe("continued reads over the store", () => {
    it("exports whole collections in character and chat order across rounds without loading them", async () => {
        const b = await boot();
        b.fake.readResponseBytes = 1;
        const detached = await b.chatEdits.readChatsDetached(["d", "c", "d"]);
        expect([...detached.keys()]).toEqual(["d", "c"]);
        expect(detached.get("d")!.map(({ id }) => id)).toEqual(["m"]);
        expect(detached.get("d")![0].message).toEqual([m("x", "X")]);
        expect(detached.get("c")!.map(({ id }) => id)).toEqual(C_IDS);
        expect(detached.get("c")!.map(({ message }) => message.map(({ data }) => data))).toEqual([
            ["A", "B", "C"],
            [],
            ...Array.from({ length: EXTRA }, (_, i) => [`N${i}`]),
        ]);
        expect(b.reads().map(({ collections }) => collections)).toEqual([["d", "c"], ["c"]]);
        expect(b.loadedIds("c")).toEqual([]);
        expect(b.loadedIds("d")).toEqual([]);
        await b.dataset.exportAsDataset();
        expect(b.downloads).toHaveLength(1);
        const dataset = JSON.parse(b.downloads[0].data) as { name: string; chats: { data: string }[] }[];
        expect(dataset.map(({ name }) => name)).toEqual([...C_IDS.map(() => "C"), "D"]);
        expect(dataset.map(({ chats }) => chats.map(({ data }) => data))).toEqual([
            ["A", "B", "C"],
            [],
            ...Array.from({ length: EXTRA }, (_, i) => [`N${i}`]),
            ["X"],
        ]);
        expect(b.reads().map(({ collections }) => collections)).toEqual([["d", "c"], ["c"], ["c", "d"], ["d"]]);
        expect(b.loadedIds("c")).toEqual([]);
        expect(b.fake.batchCount()).toBe(0);
    });

    it("refreshes every stale summary collection when one queue read needs continuation", async () => {
        const b = await boot();
        b.fake.readResponseBytes = 1;
        const fetch = b.fake.fetch;
        let round = 0;
        let release!: () => void;
        let reached!: () => void;
        const secondRequest = new Promise<void>((resolve) => {
            reached = resolve;
        });
        vi.spyOn(b.fake, "fetch").mockImplementation(async (path, init) => {
            const response = await fetch(path, init);
            if (path === "/api/resources/read" && ++round === 2) {
                reached();
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
            }
            return response;
        });
        b.live.paused = true;
        b.remoteMeta("c", "k", { name: "C remote" });
        b.remoteMeta("d", "m", { name: "D remote" });
        // Revision-only notices force the queue to fetch both collections together.
        b.sync.noteRemoteChanges({
            resources: [],
            chats: [
                { characterId: "c", id: "k", revision: b.fake.chat("c", "k")!.revision },
                { characterId: "d", id: "m", revision: b.fake.chat("d", "m")!.revision },
            ],
            chatOrders: [],
        });
        await vi.advanceTimersByTimeAsync(6500);
        await secondRequest;
        try {
            // Neither character is refreshed while the transport is collecting its remaining answer.
            expect(b.chat.chatEntry({ chaId: "c", chatId: "k" })?.name).toBe("K");
            expect(b.chat.chatEntry({ chaId: "d", chatId: "m" })?.name).toBe("M");
        } finally {
            release();
        }
        await settle(b.fake);
        expect(b.reads()).toEqual([
            { chats: [], summaries: ["c", "d"], collections: [] },
            { chats: [], summaries: ["d"], collections: [] },
        ]);
        for (const [chaId, chatId, name] of [
            ["c", "k", "C remote"],
            ["d", "m", "D remote"],
        ]) {
            expect(b.chat.chatEntry({ chaId, chatId })?.name).toBe(name);
            expect(b.chat.heldChatRevision({ chaId, chatId })).toBe(b.fake.chat(chaId, chatId)!.revision);
            expect(b.chat.isChatBehind({ chaId, chatId })).toBe(false);
            expect(b.loadedIds(chaId)).toEqual([]);
        }
        expect(b.chat.chatList("c").map(({ id }) => id)).toEqual(C_IDS);
        expect(b.fake.batchCount()).toBe(0);
        noNotice();
    });
});
