import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The client of the live-update socket (`eventFeed.ts`): a freshly signed JWT on every connection
// (they live five minutes), `hello` of the loaded epoch → the revision listing → `reconcileRemote`,
// `change` of the loaded epoch → `noteRemoteChanges`, another epoch (or an `epoch` frame) → the
// epoch-mismatch halt, malformed frames ignored, reconnect with backoff, and a failed reconcile
// closing the socket so the reconnect reconciles again. The save loop behind it is in
// `src/ts/storage/tests/resourceSyncLive.test.ts`.

const mocks = vi.hoisted(() => {
    class EpochMismatch extends Error {}
    return {
        epoch: { current: "E1" },
        tokens: { next: 0 },
        listRevisions: vi.fn(),
        epochMismatch: vi.fn(),
        noteRemoteChanges: vi.fn(),
        reconcileRemote: vi.fn(),
        /** The chat module's side of a frame's generation locks. */
        noteRemoteStreaming: vi.fn(),
        releaseFeedLocks: vi.fn(),
        EpochMismatch,
        /** `recordClientEvent`: the feed's diagnostics. */
        record: vi.fn<(input: unknown) => void>(),
        /** The chat module's view of chat `c`/`k` for the memory task module's fence predicate. */
        held: { revision: null as string | null, loaded: true },
    };
});

vi.mock("../storage/resourceClient", () => ({
    epochMismatch: mocks.epochMismatch,
    getResourceEpoch: () => mocks.epoch.current,
    listRevisions: mocks.listRevisions,
    ResourceEpochMismatchError: mocks.EpochMismatch,
}));
vi.mock("../storage/serverAuth", () => ({
    getNodeServerProxyAuth: vi.fn(async () => `jwt-${++mocks.tokens.next}-${Date.now()}`),
}));
vi.mock("../storage/resourceSync.svelte", () => ({
    noteRemoteChanges: mocks.noteRemoteChanges,
    reconcileRemote: mocks.reconcileRemote,
}));
vi.mock("../storage/chatStore.svelte", () => ({
    noteRemoteStreaming: mocks.noteRemoteStreaming,
    releaseFeedLocks: mocks.releaseFeedLocks,
    chatEntry: () => ({ id: "k" }),
    findChat: () => (mocks.held.loaded ? { id: "k" } : undefined),
    heldChatRevision: () => mocks.held.revision,
}));
vi.mock("../diagnostics/collector", () => ({ recordClientEvent: mocks.record }));

class FakeSocket {
    static instances: FakeSocket[] = [];
    readonly url: string;
    closed = false;
    private listeners = new Map<string, ((event: any) => void)[]>();
    constructor(url: string) {
        this.url = url;
        FakeSocket.instances.push(this);
    }
    addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.emit("close", {});
    }
    emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
    frame(value: unknown) {
        this.emit("message", { data: typeof value === "string" ? value : JSON.stringify(value) });
    }
}

const listing = { epoch: "E1", resources: [], chats: [], chatOrders: [] };
const change = { resources: [{ kind: "ui", id: "main", revision: "E1:1:2" }], chats: [], chatOrders: [] };
let feed: typeof import("./eventFeed");

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.resetModules();
    FakeSocket.instances = [];
    mocks.epoch.current = "E1";
    mocks.tokens.next = 0;
    mocks.listRevisions.mockReset().mockResolvedValue(listing);
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { protocol: "https:", host: "risu.test" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    feed = await import("./eventFeed");
});

afterEach(() => {
    feed.stopEventFeed();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

async function started() {
    feed.startEventFeed();
    await vi.advanceTimersByTimeAsync(0);
    return FakeSocket.instances.at(-1)!;
}

describe("the live-update socket client", () => {
    it("connects once to the feed path with a signed JWT, reconciles on `hello`, and passes changes of the loaded epoch", async () => {
        const ws = await started();
        feed.startEventFeed();
        await vi.advanceTimersByTimeAsync(0);
        expect(FakeSocket.instances).toHaveLength(1);
        expect(ws.url).toMatch(/^wss:\/\/risu\.test\/api\/events\/ws\?risu-auth=jwt-1-/);
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(1);
        expect(mocks.reconcileRemote).toHaveBeenCalledWith(listing);
        ws.frame({ type: "change", epoch: "E1", changes: change });
        expect(mocks.noteRemoteChanges).toHaveBeenCalledWith(change);
        ws.frame({ type: "ping", ts: 1 });
        expect(mocks.epochMismatch).not.toHaveBeenCalled();
    });

    it("ignores a change of another epoch and malformed frames; another epoch's `hello` or an `epoch` frame halts", async () => {
        const ws = await started();
        ws.frame({ type: "change", epoch: "E0", changes: change });
        for (const bad of ["not json", "null", "5", '"x"', "{}", { type: 3 }]) {
            ws.frame(bad);
        }
        expect(mocks.noteRemoteChanges).not.toHaveBeenCalled();
        expect(mocks.listRevisions).not.toHaveBeenCalled();
        ws.frame({ type: "epoch", epoch: "E1" });
        expect(mocks.epochMismatch).not.toHaveBeenCalled();
        ws.frame({ type: "epoch", epoch: "E2" });
        expect(mocks.epochMismatch).toHaveBeenCalledWith("E2");
        ws.frame({ type: "hello", epoch: "E3" });
        expect(mocks.epochMismatch).toHaveBeenLastCalledWith("E3");
        expect(mocks.listRevisions).not.toHaveBeenCalled();
    });

    it("reconnects with backoff, and a connection after more than five minutes signs a fresh JWT and reconciles again", async () => {
        const start = Date.now();
        const first = await started();
        first.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        // The server goes away for six minutes: every attempt's socket closes at once.
        const delays: number[] = [];
        let last = Date.now();
        while (Date.now() - start < 6 * 60_000) {
            const count = FakeSocket.instances.length;
            FakeSocket.instances.at(-1)!.close();
            while (FakeSocket.instances.length === count) {
                await vi.advanceTimersByTimeAsync(500);
            }
            delays.push(Date.now() - last);
            last = Date.now();
        }
        // 1 s doubling, capped at 30 s.
        expect(delays.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        expect(Math.max(...delays)).toBe(30000);
        const tokens = FakeSocket.instances.map((ws) => new URL(ws.url).searchParams.get("risu-auth")!);
        expect(new Set(tokens).size).toBe(tokens.length);
        // The newest token was signed after the outage (more than the JWT's five minutes later).
        const signedAt = (token: string) => Number(token.split("-")[2]);
        expect(signedAt(tokens.at(-1)!) - signedAt(tokens[0])).toBeGreaterThan(5 * 60_000);
        const latest = FakeSocket.instances.at(-1)!;
        latest.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(2);
        expect(mocks.reconcileRemote).toHaveBeenCalledTimes(2);
        // A `hello` reset the backoff: the next reconnect is 1 s later.
        latest.close();
        await vi.advanceTimersByTimeAsync(1000);
        expect(FakeSocket.instances.at(-1)).not.toBe(latest);
    });

    it("closes the socket when the reconcile fails, so the reconnect reconciles again; a stale socket's answer is dropped", async () => {
        mocks.listRevisions.mockRejectedValueOnce(new Error("offline"));
        const ws = await started();
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(ws.closed).toBe(true);
        expect(mocks.reconcileRemote).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        const next = FakeSocket.instances.at(-1)!;
        expect(next).not.toBe(ws);
        let answer!: (value: unknown) => void;
        mocks.listRevisions.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        next.frame({ type: "hello", epoch: "E1" });
        // The socket drops before its listing answers: the late answer is not applied.
        next.close();
        answer(listing);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).not.toHaveBeenCalled();
        // Frames of a replaced socket are ignored.
        next.frame({ type: "change", epoch: "E1", changes: change });
        expect(mocks.noteRemoteChanges).not.toHaveBeenCalled();
    });

    it("does not close the socket for an epoch mismatch during the reconcile, and stops reconnecting once stopped", async () => {
        mocks.listRevisions.mockRejectedValueOnce(new mocks.EpochMismatch("restored"));
        const ws = await started();
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(ws.closed).toBe(false);
        feed.stopEventFeed();
        expect(ws.closed).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(FakeSocket.instances).toHaveLength(1);
    });
});

// A `change` frame's generation locks go to the chat module after its refs, and a `hello` of the
// loaded epoch drops the feed's locks (a release may have been sent while disconnected).
describe("the frame's generation locks", () => {
    const streaming = [{ characterId: "c", id: "k", streaming: [{ messageId: "r", generationId: "g1", seq: 0 }] }];
    const chats = { resources: [], chats: [{ characterId: "c", id: "k", revision: "E1:1:5" }], chatOrders: [] };

    it("passes a change's `streaming` with its refs after the refs were dispatched, and nothing without it", async () => {
        const ws = await started();
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        ws.frame({ type: "change", epoch: "E1", changes: chats, streaming });
        expect(mocks.noteRemoteChanges).toHaveBeenCalledWith(chats);
        expect(mocks.noteRemoteStreaming).toHaveBeenCalledWith(streaming, chats);
        expect(mocks.noteRemoteStreaming.mock.invocationCallOrder[0]).toBeGreaterThan(
            mocks.noteRemoteChanges.mock.invocationCallOrder[0],
        );
        // A release without a write: empty refs, the lists alone.
        const release = [{ characterId: "c", id: "k", streaming: [] }];
        ws.frame({ type: "change", epoch: "E1", changes: listing, streaming: release });
        expect(mocks.noteRemoteStreaming).toHaveBeenLastCalledWith(release, listing);
        ws.frame({ type: "change", epoch: "E1", changes: change });
        expect(mocks.noteRemoteChanges).toHaveBeenCalledTimes(3);
        expect(mocks.noteRemoteStreaming).toHaveBeenCalledTimes(2);
    });

    it("drops the feed's locks on every `hello` of the loaded epoch, and touches no lock for another epoch's frames", async () => {
        const ws = await started();
        ws.frame({ type: "change", epoch: "E1", changes: chats, streaming });
        expect(mocks.noteRemoteStreaming).toHaveBeenCalledTimes(1);
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.releaseFeedLocks).toHaveBeenCalledTimes(1);
        expect(mocks.releaseFeedLocks.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.reconcileRemote.mock.invocationCallOrder[0],
        );
        // A reconnect's hello drops again.
        ws.close();
        await vi.advanceTimersByTimeAsync(1000);
        const next = FakeSocket.instances.at(-1)!;
        next.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.releaseFeedLocks).toHaveBeenCalledTimes(2);
        // Another epoch halts: its locks are neither installed nor dropped here.
        next.frame({ type: "change", epoch: "E0", changes: chats, streaming });
        next.frame({ type: "hello", epoch: "E2" });
        expect(mocks.epochMismatch).toHaveBeenCalledWith("E2");
        expect(mocks.noteRemoteStreaming).toHaveBeenCalledTimes(1);
        expect(mocks.releaseFeedLocks).toHaveBeenCalledTimes(2);
    });
});

describe("the feed's diagnostics", () => {
    const feedEvents = () => mocks.record.mock.calls.map(([input]) => input);

    it("records `connected` once per socket with the attempt it was, `disconnected` with the close code, and `connectFailed` for a socket closed before its hello", async () => {
        const first = await started();
        first.frame({ type: "hello", epoch: "E1" });
        first.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(feedEvents()).toEqual([{ kind: "feed", phase: "connected", attempt: 0 }]);
        first.closed = true;
        first.emit("close", { code: 1006 });
        expect(feedEvents()[1]).toEqual({ kind: "feed", phase: "disconnected", attempt: 0, code: 1006 });
        // The first reconnect (attempt 1) closes before its hello: it never connected.
        await vi.advanceTimersByTimeAsync(1000);
        const second = FakeSocket.instances[1];
        second.closed = true;
        second.emit("close", { code: 1006 });
        expect(feedEvents()[2]).toEqual({ kind: "feed", phase: "connectFailed", attempt: 1, code: 1006 });
        // The next (attempt 2) connects; its events carry that attempt, even after the reset.
        await vi.advanceTimersByTimeAsync(2000);
        const third = FakeSocket.instances[2];
        third.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(feedEvents()[3]).toEqual({ kind: "feed", phase: "connected", attempt: 2 });
        third.closed = true;
        third.emit("close", { code: 1001 });
        expect(feedEvents()[4]).toEqual({ kind: "feed", phase: "disconnected", attempt: 2, code: 1001 });
        expect(feedEvents()).toHaveLength(5);
    });

    it("records `connectFailed` for a token failure (not after a stop) and for a socket that cannot be built, and nothing for the stop's own close", async () => {
        const auth = (await import("../storage/serverAuth")).getNodeServerProxyAuth as ReturnType<typeof vi.fn>;
        auth.mockRejectedValueOnce(new Error("no token"));
        feed.startEventFeed();
        await vi.advanceTimersByTimeAsync(0);
        expect(feedEvents()).toEqual([{ kind: "feed", phase: "connectFailed", attempt: 0 }]);
        vi.stubGlobal(
            "WebSocket",
            class {
                constructor() {
                    throw new Error("blocked");
                }
            },
        );
        await vi.advanceTimersByTimeAsync(1000);
        expect(feedEvents()[1]).toEqual({ kind: "feed", phase: "connectFailed", attempt: 1 });
        vi.stubGlobal("WebSocket", FakeSocket);
        let fail!: (error: unknown) => void;
        auth.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
        await vi.advanceTimersByTimeAsync(2000);
        feed.stopEventFeed();
        fail(new Error("late"));
        await vi.advanceTimersByTimeAsync(0);
        expect(feedEvents()).toHaveLength(2);

        vi.resetModules();
        mocks.record.mockClear();
        FakeSocket.instances = [];
        feed = await import("./eventFeed");
        const ws = await started();
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        feed.stopEventFeed();
        expect(ws.closed).toBe(true);
        expect(feedEvents()).toEqual([{ kind: "feed", phase: "connected", attempt: 0 }]);
    });
});

// The HypaV3 memory task statuses on the socket go to `memoryTasks.svelte.ts` (the real module, over
// the mocked storage): the `hello` snapshot, `memoryTask` frames of the loaded epoch, the reconnect's
// listing before `reconcileRemote`, and the reset on another epoch.
describe("the memory task frames", () => {
    const E = "0f3d4b9a-0000-4000-8000-000000000001";
    const rev = (n: number) => `${E}:1:${n}`;
    const ref = { chaId: "c", chatId: "k" };
    const status = (state: string, extra: Record<string, unknown> = {}) => ({
        taskId: "A",
        state,
        done: 0,
        total: 0,
        ...extra,
    });
    const taskFrame = (epoch: string, value: ReturnType<typeof status>) => ({
        type: "memoryTask",
        epoch,
        characterId: "c",
        chatId: "k",
        status: value,
    });

    beforeEach(() => {
        mocks.held.revision = rev(2);
        mocks.held.loaded = true;
    });

    it("takes the hello's snapshot and the loaded epoch's frames, asks the loop to read a terminal's revision, and resets on another epoch", async () => {
        const tasks = await import("../process/memoryTasks.svelte");
        const ws = await started();
        const running = status("running", { done: 1, total: 2 });
        ws.frame({ type: "hello", epoch: "E1", memoryTasks: [{ characterId: "c", chatId: "k", status: running }] });
        await vi.advanceTimersByTimeAsync(0);
        expect(tasks.memoryTaskStatus(ref)).toEqual(running);
        expect(tasks.memoryTaskFenced(ref)).toBe(true);

        // A frame of another epoch is ignored; one of the loaded epoch is the chat's status.
        ws.frame(taskFrame("E0", status("done", { terminalRevision: rev(3) })));
        expect(tasks.memoryTaskStatus(ref)?.state).toBe("running");
        expect(mocks.noteRemoteChanges).not.toHaveBeenCalled();
        ws.frame(taskFrame("E1", status("done", { terminalRevision: rev(3) })));
        expect(tasks.memoryTaskStatus(ref)?.state).toBe("done");
        // The mirror holds an older revision: the loop is told to read the chat; fenced until it did.
        expect(mocks.noteRemoteChanges).toHaveBeenCalledWith({
            resources: [],
            chats: [{ characterId: "c", id: "k", revision: rev(3) }],
            chatOrders: [],
        });
        expect(tasks.memoryTaskAwaitingSync(ref)).toBe(true);

        // Another epoch's `hello` resets the module as it halts.
        ws.frame({ type: "hello", epoch: "E2" });
        expect(mocks.epochMismatch).toHaveBeenCalledWith("E2");
        expect(tasks.memoryTaskStatus(ref)).toBeNull();
        expect(tasks.memoryTaskFenced(ref)).toBe(false);
    });

    it("gives the module the reconnect's listing before the loop reconciles it", async () => {
        const tasks = await import("../process/memoryTasks.svelte");
        const ws = await started();
        ws.frame({ type: "hello", epoch: "E1", memoryTasks: [] });
        await vi.advanceTimersByTimeAsync(0);
        ws.frame(taskFrame("E1", status("done", { terminalRevision: rev(3) })));
        expect(tasks.memoryTaskFenced(ref)).toBe(true);

        // The socket drops and comes back; the mirror adopted the revision meanwhile. At the time the
        // loop reconciles, the module has already matched the listing against the mirror.
        ws.close();
        await vi.advanceTimersByTimeAsync(1000);
        const next = FakeSocket.instances.at(-1)!;
        mocks.listRevisions.mockResolvedValueOnce({
            ...listing,
            chats: [{ characterId: "c", id: "k", revision: rev(3) }],
        });
        let fencedAtReconcile: boolean | null = null;
        mocks.reconcileRemote.mockImplementationOnce(() => {
            fencedAtReconcile = tasks.memoryTaskFenced(ref);
        });
        next.frame({ type: "hello", epoch: "E1", memoryTasks: [] });
        expect(tasks.memoryTaskFenced(ref)).toBe(true);
        mocks.held.revision = rev(3);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).toHaveBeenCalledTimes(2);
        expect(fencedAtReconcile).toBe(false);
        expect(tasks.memoryTaskFenced(ref)).toBe(false);
    });
});
