import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../../../shared/database.ts";
import type { GenerationEvent } from "../../../../shared/jobs.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { StoreBackedServer } from "./storeBackedServer";

// Phase 5 Stop D fixes, two tabs of one browser. C3: a server job's owner tab announces each chat
// the job wrote and the job's end (`chatChangeNotices.ts`), and another tab reads the chat again
// once it is idle there (`markChatNoticed`, `idleChatRefreshes`, `finishIdleChatRefresh` with the
// notice sequence taken before the read). C2: a send whose flush is refused because a change
// waits for another tab's job shows `chatGenerating` (`GenerationBlockedError`). The save adapter,
// the chat module, the job transport, and `runServerJob` run for real against the real server
// store guarded by the real generation lock; `BroadcastChannel` is a recording stand-in.

/** A BroadcastChannel stand-in: posts are recorded; `deliver` hands a message to the receivers. */
class FakeChannel {
    static instances: FakeChannel[] = [];
    posted: unknown[] = [];
    listeners = new Set<(event: MessageEvent) => void>();
    closed = false;
    constructor(readonly name: string) {
        FakeChannel.instances.push(this);
    }
    postMessage(data: unknown) {
        this.posted.push(data);
    }
    addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        this.listeners.add(listener);
    }
    removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
        this.listeners.delete(listener);
    }
    close() {
        this.closed = true;
    }
}
const deliver = (data: unknown) => {
    for (const channel of FakeChannel.instances) {
        for (const listener of channel.listeners) {
            listener({ data } as MessageEvent);
        }
    }
};

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
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", chatGenerating: "generating" },
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
type Transport = typeof import("../../network/generationJobs");

const KINDS = Object.values(RESOURCE_KIND);
const m = (id: string | undefined, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const refK = { chaId: "c", chatId: "k" };
const B = { characterId: "c", chatId: "k", messageId: "b" };
/**
 * Boots the adapter, the chat module, and the transport the way `loadData` does: the server holds
 * the collections and a character `c` with chats `k` (messages a, b, c) and `j` (empty), guarded by
 * the generation lock; read with chats, seed, assemble, select, start, and let the boot pass run.
 */
async function boot() {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ lock: true });
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
                            message: [m("a", "A", "char"), m("b", "B", "char"), m("c", "C")],
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
    server.current = fake;

    const stores: Stores = await import("../../stores.svelte");
    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chat: ChatModule = await import("../chatStore.svelte");
    const transport: Transport = await import("../../network/generationJobs");
    const bootstrap: Bootstrap = await import("../../bootstrap");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    stores.DBState.db = bootstrap.assembleDatabase(snapshot);
    stores.selectedCharID.set(0);
    chat.initializeChats();
    fake.requests.length = 0;
    // Each boot's graph would register its page lifecycle listeners on the shared window and
    // document; they are kept off so an earlier test's graph never saves for this one.
    const adding = vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    const addingDocument = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    sync.startResourceSync();
    adding.mockRestore();
    addingDocument.mockRestore();
    await tick();
    await sync.flushResources();
    expect(fake.batchCount()).toBe(0);
    fake.requests.length = 0;
    const db = () => stores.DBState.db as any;
    const character = () => db().characters.find((entry: any) => entry.chaId === "c");
    const mirrorChat = (id = "k") => character().chats.find((entry: any) => entry.id === id) as Chat | undefined;
    const epoch = fake.store.epoch();
    /** A chat `resource` event of job `jobId` with the server's copy of `k` and the given streaming list. */
    const chatEvent = (
        jobId: string,
        streaming: { messageId: string; generationId: string; seq: number }[],
        override: { revision?: string; data?: Chat } = {},
    ): GenerationEvent & { type: "resource"; kind: "chats" } => {
        const record = fake.chat("c", "k")!;
        return {
            type: "resource",
            epoch,
            kind: "chats",
            characterId: "c",
            id: "k",
            revision: override.revision ?? record.revision,
            data: override.data ?? record.data,
            streaming,
        } as any;
    };
    const apply = (jobId: string, event: GenerationEvent) => transport.applyGenerationEvent(jobId, refK, event);
    return { fake, sync, chat, transport, character, mirrorChat, epoch, chatEvent, apply };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // `Date` too: the job-retry block compares `Date.now()` with its deadline.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("location", { reload: vi.fn(), protocol: "http:", host: "test" });
    FakeChannel.instances.length = 0;
    vi.stubGlobal("BroadcastChannel", FakeChannel);
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

const readsOf = (fake: StoreBackedServer) => fake.requests.filter((r) => r.path === "/api/resources/read").length;

describe("a chat another tab announced", () => {
    it("keeps a notice that arrives during an idle read: a later read reaches the final revision, then no more reads or writes", async () => {
        const { fake, sync, chat, mirrorChat, epoch } = await boot();
        const held = { gate: null as null | (() => void), hold: false };
        const real = fake.fetch;
        server.current = Object.assign(Object.create(fake), {
            fetch: async (path: string, init?: RequestInit) => {
                const response = real(path, init); // snapshot taken synchronously
                if (path === "/api/resources/read" && held.hold) {
                    held.hold = false;
                    await new Promise<void>((resolve) => (held.gate = resolve));
                }
                return response;
            },
            close: () => fake.close(),
        });
        const r0 = fake.chat("c", "k")!.revision;
        // Another tab's job commits R1 and announces.
        fake.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: r0, ops: [{ op: "setText", id: "c", text: "R1" } as any] },
        ]);
        held.hold = true;
        deliver({ epoch, chaId: "c", chatId: "k" });
        await vi.advanceTimersByTimeAsync(600);
        expect(held.gate).not.toBeNull();
        const r1 = fake.chat("c", "k")!.revision;
        fake.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: r1, ops: [{ op: "setText", id: "c", text: "R2" } as any] },
        ]);
        // A second commit and its notice arrive while the read (its answer is the R1 copy) is held.
        deliver({ epoch, chaId: "c", chatId: "k" });
        held.gate!();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1500);
        expect(mirrorChat()!.message.map((m) => m.data)).toEqual(["A", "B", "R2"]);
        const reads = readsOf(fake);
        await vi.advanceTimersByTimeAsync(5000);
        expect(readsOf(fake)).toBe(reads);
        expect(fake.batchCount()).toBe(0);
    });

    it("does not read or poll a chat whose work is blocked by a job until the block expires, then saves and reads it", async () => {
        const { fake, sync, chat, mirrorChat, epoch } = await boot();
        fake.lock!.addToken("T");
        fake.lock!.acquire(B, { jobId: "J", generationId: "g1", token: "T" });
        chat.setMessageText(refK, "b", "edited");
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        const reads = readsOf(fake);
        const timeouts = vi.spyOn(globalThis, "setTimeout");
        const r0 = fake.chat("c", "k")!.revision;
        fake.store.applyChanges(
            {
                chats: [
                    { characterId: "c", chatId: "k", baseRevision: r0, ops: [{ op: "setText", id: "c", text: "R1" }] },
                ],
            } as any,
            { jobToken: "T" } as any,
        );
        for (let i = 0; i < 4; i += 1) {
            deliver({ epoch, chaId: "c", chatId: "k" });
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(readsOf(fake)).toBe(reads);
        const short = timeouts.mock.calls.filter(([, d]) => typeof d === "number" && d <= 500).length;
        expect(short).toBeLessThanOrEqual(4);
        fake.lock!.endJob("T");
        await vi.advanceTimersByTimeAsync(3000);
        expect(fake.texts("c", "k")).toEqual(["A", "edited", "R1"]);
        expect(mirrorChat()!.message.map((m) => m.data)).toEqual(["A", "edited", "R1"]);
        const after = readsOf(fake);
        await vi.advanceTimersByTimeAsync(5000);
        expect(readsOf(fake)).toBe(after);
    });

    it("does not read a chat with a running client generation; reads it after the generation ends, keeping the final", async () => {
        const { fake, sync, chat, mirrorChat, epoch } = await boot();
        chat.beginGeneration(refK, "c", "cg");
        await sync.flushResources().catch(() => {});
        await vi.advanceTimersByTimeAsync(1000);
        const r0 = fake.chat("c", "k")!.revision;
        fake.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: r0, ops: [{ op: "setText", id: "a", text: "A2" } as any] },
        ]);
        const reads = readsOf(fake);
        deliver({ epoch, chaId: "c", chatId: "k" });
        await vi.advanceTimersByTimeAsync(3000);
        expect(readsOf(fake) - reads).toBe(0);
        chat.setMessageText(refK, "c", "final", { generationId: "cg" });
        chat.endGeneration(refK, "c", "cg");
        await vi.advanceTimersByTimeAsync(3000);
        expect(fake.texts("c", "k")).toEqual(["A2", "B", "final"]);
        expect(mirrorChat()!.message.map((m) => m.data)).toEqual(["A2", "B", "final"]);
    });

    it("ignores a notice of another epoch, a malformed notice, and an unknown chat, and owns no job", async () => {
        const { fake, transport, epoch } = await boot();
        const reads = readsOf(fake);
        deliver({ epoch: "other", chaId: "c", chatId: "k" });
        deliver({ epoch, chaId: "c" });
        deliver({ epoch, chaId: "", chatId: "k" });
        deliver("x");
        deliver(null);
        deliver({ epoch, chaId: "c", chatId: "missing" });
        await vi.advanceTimersByTimeAsync(3000);
        expect(readsOf(fake)).toBe(reads);
        expect(fake.batchCount()).toBe(0);
        expect(transport.savedGenerationJobIds()).toEqual([]);
    });

    it("removes a chat the server deleted", async () => {
        const { fake, character, epoch } = await boot();
        const r0 = fake.chat("c", "j")!.revision;
        fake.chatBatch([{ characterId: "c", chatId: "j", baseRevision: r0, ops: [{ op: "delete" } as any] }]);
        deliver({ epoch, chaId: "c", chatId: "j" });
        await vi.advanceTimersByTimeAsync(3000);
        expect(character().chats.map((c: any) => c.id)).toEqual(["k"]);
    });

    it("announces from the owner tab each chat `resource` event (throttled) and the job's end at once", async () => {
        const { apply, chatEvent, epoch } = await boot();
        apply("J", chatEvent("J", []));
        apply("J", chatEvent("J", []));
        apply("J", { type: "done", epoch, revision: null } as any);
        const posted = FakeChannel.instances.flatMap((c) => c.posted);
        expect(posted).toEqual([
            { epoch, chaId: "c", chatId: "k" },
            { epoch, chaId: "c", chatId: "k" },
        ]);
    });

    it("saves this tab's pending edit before reading the announced chat: both changes kept, no discard", async () => {
        const { fake, sync, chat, mirrorChat, epoch } = await boot();
        const r0 = fake.chat("c", "k")!.revision;
        fake.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: r0, ops: [{ op: "setText", id: "c", text: "R1" } as any] },
        ]);
        chat.setMessageText(refK, "a", "local");
        deliver({ epoch, chaId: "c", chatId: "k" });
        await vi.advanceTimersByTimeAsync(3000);
        expect(fake.texts("c", "k")).toEqual(["local", "B", "R1"]);
        expect(mirrorChat()!.message.map((m) => m.data)).toEqual(["local", "B", "R1"]);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(chat.hasUnsavedChatWork()).toBe(false);
        expect(await sync.flushResources()).toEqual({ discarded: [] });
    });
});

describe("a send while another tab's job holds the chat (C2)", () => {
    it("refuses pending locked work through the typed error with one notice per send, posts no job, and keeps the work", async () => {
        const { fake, sync, chat, character } = await boot();
        const commands = await import("../../process/serverCommands");
        fake.lock!.addToken("T");
        fake.lock!.acquire(B, { jobId: "J", generationId: "g1", token: "T" });
        chat.setMessageText(refK, "b", "edited");
        const first = await commands.runServerJob(character(), refK, {
            kind: "send",
            label: "send",
            context: { input: "x" },
        } as any);
        // The flush's conflict recovery showed the notice: the send does not show a second one.
        expect(first.outcome).toBe("refused");
        expect(alerts.normal.mock.calls).toEqual([["generating"]]);
        expect(alerts.error).not.toHaveBeenCalled();
        // The work is blocked now and the flush refuses at once: the send shows the notice itself,
        // never the wrapped save error.
        const second = await commands.runServerJob(character(), refK, {
            kind: "send",
            label: "send",
            context: { input: "x" },
        } as any);
        expect(second.outcome).toBe("refused");
        expect(alerts.error.mock.calls).toEqual([["generating"]]);
        // Two sends sharing one refused flush: each explicit send gets its notice.
        const [c1, c2] = await Promise.all([
            commands.runServerJob(character(), refK, { kind: "send", label: "send", context: { input: "x" } } as any),
            commands.runServerJob(character(), refK, { kind: "send", label: "send", context: { input: "x" } } as any),
        ]);
        expect([c1.outcome, c2.outcome]).toEqual(["refused", "refused"]);
        expect(alerts.error).toHaveBeenCalledTimes(3);
        expect(fake.requests.filter((r) => r.path.includes("generation") || r.path.includes("jobs"))).toEqual([]);
        expect(chat.hasUnsavedChatWork()).toBe(true);
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
    });
});
