import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../../shared/chats.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { type ServerFeedEvent, StoreBackedServer } from "./storeBackedServer";

// Real store commits reach the real save adapter synchronously, as the live feed does.

const { server, alerts, dispatch } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
    /** When set, a request waits here after authentication and before `beforeDispatch`. */
    dispatch: { gate: null as Promise<void> | null },
}));

vi.mock("../serverAuth", () => ({
    // `authFetch`'s contract: `beforeDispatch` runs after authentication and signing, right before the request.
    authFetch: async (path: string, init?: RequestInit, options: { beforeDispatch?: () => void } = {}) => {
        if (dispatch.gate) {
            await dispatch.gate;
        }
        options.beforeDispatch?.();
        return server.current.fetch(path, init);
    },
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertReloadNotice: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertTerminal: alerts.terminal,
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", chatGenerating: "generating" },
    changeLanguage: vi.fn(),
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
type ChatModule = typeof import("../chatStore.svelte");
type Bootstrap = typeof import("../../bootstrap");
type Selection = typeof import("../selection.svelte");

const KINDS = Object.values(RESOURCE_KIND);
const m = (id: string, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const chat = (id: string, messages: any[] = []) =>
    ({ id, name: id, note: "", localLore: [], message: messages }) as any;
const create = (characterId: string, id: string, messages: any[] = []) => ({
    characterId,
    chatId: id,
    baseRevision: null,
    ops: [{ op: "create", chat: chat(id, messages) }],
});
const refK = { chaId: "c", chatId: "k" };

/**
 * Boots the adapter and the chat module the way `loadData` does, against a store-backed server
 * with the change feed: presets `pa` and `pb`, character `c` (chats `k` with messages a, b, c and
 * `j`, empty) and character `d` (chat `m`), at home. Then live delivery starts.
 */
async function boot(options: { summaries?: boolean } = {}) {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ lock: true, feed: true });
    fake.set("presets", "main", [
        { id: "pa", name: "p1" },
        { id: "pb", name: "p2" },
    ]);
    fake.set("modelPresets", "main", [
        { id: "ma", name: "m1" },
        { id: "mb", name: "m2" },
    ]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.store.applyChanges({
        ops: [
            { kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } },
            { kind: fake.kind("characters"), id: "d", baseRevision: null, data: { chaId: "d", name: "D" } },
        ],
        chats: [
            create("c", "k", [m("a", "A", "char"), m("b", "B", "char"), m("c", "C")]),
            create("c", "j"),
            create("d", "m", [m("x", "X")]),
        ],
    });
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chatModule: ChatModule = await import("../chatStore.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const selection: Selection = await import("../selection.svelte");

    const snapshot = await client.readKinds(KINDS, options.summaries ? { chatSummaries: true } : { chats: true });
    sync.seedResources(snapshot);
    chatModule.seedChats(
        (options.summaries ? snapshot.chatSummaries : snapshot.chats) ?? [],
        snapshot.chatOrders ?? [],
    );
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    chatModule.initializeChats();
    const adding = vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    const addingDocument = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    sync.startResourceSync();
    adding.mockRestore();
    addingDocument.mockRestore();
    await tick();
    await sync.flushResources();
    expect(fake.batchCount()).toBe(0);
    fake.requests.length = 0;
    fake.feedEvents.length = 0;

    // The live-update socket's stand-in: each `change` of the loaded epoch goes to `noteRemoteChanges`.
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

    return { fake, sync, client, chat: chatModule, live, flushFeed };
}
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    dispatch.gate = null;
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

type Booted = Awaited<ReturnType<typeof boot>>;
const remote = (b: Booted, ops: ChatOp[]) =>
    b.fake.chatBatch([{ characterId: "c", chatId: "k", baseRevision: b.fake.chat("c", "k")!.revision, ops }]);
const reads = (b: Booted) =>
    b.fake.requests.filter((request) => request.path === "/api/resources/read").map((request) => request.body);
const mirror = (b: Booted) => b.chat.findChat(refK)!;
const latest = (b: Booted) => {
    const event = b.fake.feedEvents.at(-1)!;
    if (event.type !== "change") throw new Error("expected a committed change");
    const notice = event.changes.chats[0];
    expect(notice.patch).toBeDefined();
    return { ...notice.patch!, characterId: "c", id: "k", revision: notice.revision! };
};
const quiet = (b: Booted) => {
    expect(b.chat.hasUnsavedChatWork()).toBe(false);
    expect(alerts.normal).not.toHaveBeenCalled();
    expect(alerts.error).not.toHaveBeenCalled();
};

describe("feed patches through the tab save adapter", () => {
    it("applies a loaded idle patch immediately without a notice, read, outgoing work, or discard", async () => {
        const b = await boot();
        const scope = b.sync.beginMutationScope();
        remote(b, [
            { op: "remove", ids: ["a"] },
            { op: "setText", id: "b", text: "checkpoint😀" },
            { op: "append", anchor: { after: "b" }, messages: [m("inserted", "I")] },
            { op: "meta", set: { note: "remote note" } },
        ]);
        expect(mirror(b).message.map((row) => [row.chatId, row.data])).toEqual([
            ["b", "checkpoint😀"],
            ["inserted", "I"],
            ["c", "C"],
        ]);
        expect(mirror(b).note).toBe("remote note");
        expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
        expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await b.sync.flushResources({ scope })).toEqual({ discarded: [] });
        expect(b.fake.requests).toEqual([]);
        quiet(b);
    });

    it.each(["another revision", "stale", "local work", "generating", "summary only"])(
        "falls back to the existing notice/read path for %s",
        async (state) => {
            const b = await boot({ summaries: state === "summary only" });
            const scope = b.sync.beginMutationScope();
            const base = b.fake.chat("c", "k")!.revision;
            if (state === "another revision") {
                b.live.paused = true;
                remote(b, [{ op: "meta", set: { note: "unseen prior change" } }]);
                b.live.queue.length = 0;
                b.live.paused = false;
            }
            if (state === "stale") {
                const future = base.replace(/:\d+$/, ":999");
                expect(
                    b.sync.applyPatchHydration({
                        characterId: "c",
                        id: "k",
                        baseRevision: future,
                        revision: future.replace(/999$/, "1000"),
                        count: 3,
                    }),
                ).toBe("mismatch");
                expect(b.chat.isChatStale(refK)).toBe(true);
            }
            if (state === "local work") b.chat.setChatMeta(refK, { note: "local note" });
            if (state === "generating")
                b.chat.applyServerGeneration(refK, {
                    jobId: "J",
                    messageId: "b",
                    generationId: "g",
                    seq: 1,
                    text: "raw streaming",
                });
            remote(b, [{ op: "setText", id: "b", text: "stored checkpoint" }]);
            latest(b);
            expect(b.chat.heldChatRevision(refK)).toBe(base);
            expect(b.chat.isChatBehind(refK)).toBe(true);
            expect(reads(b)).toEqual([]);
            if (state === "summary only") expect(b.chat.findChat(refK)).toBeUndefined();
            else expect(mirror(b).message[1].data).toBe(state === "generating" ? "raw streaming" : "B");
            if (state === "generating") {
                await vi.advanceTimersByTimeAsync(600);
                expect(reads(b)).toEqual([]);
                b.chat.endServerJob("J");
            }
            expect(await b.sync.flushResources({ scope })).toEqual({ discarded: [] });
            await vi.advanceTimersByTimeAsync(1200);
            expect(reads(b)).toHaveLength(1);
            if (state === "summary only") {
                expect(reads(b)[0]).toMatchObject({ chatSummaryCollections: ["c"] });
                expect(reads(b)[0].chats ?? []).toEqual([]);
                expect(b.chat.findChat(refK)).toBeUndefined();
            } else {
                expect(reads(b)[0]).toMatchObject({ chats: [{ characterId: "c", id: "k" }] });
                expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
                expect(mirror(b).message[1].data).toBe("stored checkpoint");
                if (state === "local work") expect(mirror(b).note).toBe("local note");
                if (state === "another revision") expect(mirror(b).note).toBe("unseen prior change");
            }
            expect(b.chat.isChatBehind(refK)).toBe(false);
            expect(b.fake.batchCount()).toBe(state === "local work" ? 1 : 0);
            quiet(b);
        },
    );

    it("lets the owner's later job patch fit both a locked feed notice and an already applied unlocked feed patch", async () => {
        const b = await boot();
        const scope = b.sync.beginMutationScope();
        b.chat.applyServerGeneration(refK, { jobId: "J", messageId: "b", generationId: "g", seq: 1, text: "raw" });
        remote(b, [{ op: "setText", id: "b", text: "stored checkpoint" }]);
        const locked = latest(b);
        expect(mirror(b).message[1].data).toBe("raw");
        expect(b.chat.heldChatRevision(refK)).toBe(locked.baseRevision);
        expect(b.chat.isChatBehind(refK)).toBe(true);
        expect(b.sync.applyPatchHydration(locked, { jobId: "J", streaming: [] })).toBe("applied");
        expect(mirror(b).message[1].data).toBe("stored checkpoint");
        expect(b.chat.isChatGenerating(refK)).toBe(false);
        remote(b, [{ op: "setText", id: "b", text: "unlocked update" }]);
        const unlocked = latest(b);
        expect(mirror(b).message[1].data).toBe("unlocked update");
        expect(b.chat.heldChatRevision(refK)).toBe(unlocked.revision);
        expect(b.sync.applyPatchHydration(unlocked, { jobId: "J", streaming: [] })).toBe("applied");
        expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await b.sync.flushResources({ scope })).toEqual({ discarded: [] });
        expect(b.fake.requests).toEqual([]);
        quiet(b);
    });
    it.each(["in-flight", "quarantined", "blocked", "deferred"])(
        "retains the ordinary notice while a chat is %s",
        async (state) => {
            const b = await boot();
            b.chat.setChatMeta(refK, { note: "local work" });
            const work = b.chat.takeChatWork(new Set());
            expect(work.groups).toHaveLength(1);
            const group = work.groups[0];
            if (state === "quarantined") b.chat.quarantineChat(group);
            if (state === "blocked") b.chat.recoverChatConflicts(work, new Set(), new Set(), [], new Set([group.key]));
            if (state === "deferred") {
                b.chat.applyServerGeneration(refK, {
                    jobId: "J",
                    messageId: "b",
                    generationId: "g",
                    seq: 1,
                    text: "raw",
                });
                b.chat.recoverChatConflicts(work, new Set([group.key]), new Set(), [b.fake.chat("c", "k")!]);
                // Remove the generation lock so it is the deferral that prevents feed admission.
                b.chat.endServerJob("J");
            }
            const before = JSON.stringify(mirror(b));
            const held = b.chat.heldChatRevision(refK);
            const scope = b.sync.beginMutationScope();
            remote(b, [{ op: "setText", id: "b", text: "remote checkpoint" }]);
            latest(b);
            expect(JSON.stringify(mirror(b))).toBe(before);
            expect(b.chat.heldChatRevision(refK)).toBe(held);
            expect(b.chat.isChatBehind(refK)).toBe(true);
            expect(b.sync.beginMutationScope()).toEqual(scope);
            expect(b.fake.requests).toEqual([]);
            expect(alerts.normal).not.toHaveBeenCalled();
        },
    );
});
