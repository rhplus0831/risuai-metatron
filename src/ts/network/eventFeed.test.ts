import { revisionDigest, type ResourceRevisionListing } from "../../../shared/resources.ts";
import { ResourceEpochMismatchError } from "../storage/resourceClient";
import { FakeSocket } from "./tests/eventSocket";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// The client of the live-update socket (`eventFeed.ts`): a freshly signed JWT on every connection
// (they live five minutes), `hello` of the loaded epoch → the revision listing → `reconcileRemote`,
// `change` of the loaded epoch → `noteRemoteChanges`, another epoch (or an `epoch` frame) → the
// epoch-mismatch halt, malformed frames ignored, reconnect with backoff, a failed reconcile
// closing the socket so the reconnect reconciles again, and the connection generation with the
// liveness helpers (`socketLiveness.ts`, real): a silent or never-opening connection abandoned
// without its `close`, the page's return replacing the connection, late results of a replaced
// connection doing nothing. The save loop behind it is in
// `src/ts/storage/tests/resourceSyncLive.test.ts`.

const mocks = vi.hoisted(() => {
    return {
        epoch: { current: "E1" },
        tokens: { next: 0 },
        listRevisions: vi.fn(),
        listChanges: vi.fn(),
        epochMismatch: vi.fn(),
        noteRemoteChanges: vi.fn(),
        reconcileRemote: vi.fn(),
        /** The chat module's side of a frame's generation locks. */
        noteRemoteStreaming: vi.fn(),
        replaceFeedLocks: vi.fn(),
        /** `recordClientEvent`: the feed's diagnostics. */
        record: vi.fn<(input: unknown) => void>(),
        /** The chat module's view of chat `c`/`k` for the memory task module's fence predicate. */
        held: { revision: null as string | null, loaded: true },
    };
});

vi.mock("../storage/resourceClient", async () =>
    (await import("../storage/tests/resourceClientMock")).createResourceClientMock({
        epochMismatch: mocks.epochMismatch,
        getResourceEpoch: () => mocks.epoch.current,
        listRevisions: mocks.listRevisions,
        listChanges: mocks.listChanges,
    }),
);
vi.mock("../storage/serverAuth", () => ({
    getNodeServerProxyAuth: vi.fn(async () => `jwt-${++mocks.tokens.next}-${Date.now()}`),
}));
vi.mock("../storage/resourceSync.svelte", () => ({
    noteRemoteChanges: mocks.noteRemoteChanges,
    reconcileRemote: mocks.reconcileRemote,
}));
vi.mock("../storage/chatStore.svelte", async () =>
    (await import("../storage/tests/chatStoreMock")).createChatStoreMock({
        noteRemoteStreaming: mocks.noteRemoteStreaming,
        replaceFeedLocks: mocks.replaceFeedLocks,
        chatEntry: () => ({ id: "k" }),
        findChat: () => (mocks.held.loaded ? { id: "k" } : undefined),
        heldChatRevision: () => mocks.held.revision,
    }),
);
vi.mock("../diagnostics/collector", async () =>
    (await import("../diagnostics/tests/collectorMock")).createCollectorMock({ recordClientEvent: mocks.record }),
);

const listing = { epoch: "E1", resources: [], chats: [], chatOrders: [] };
const change = { resources: [{ kind: "ui", id: "main", revision: "E1:1:2" }], chats: [], chatOrders: [] };
let feed: typeof import("./eventFeed");

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.resetModules();
    FakeSocket.instances = [];
    mocks.epoch.current = "E1";
    mocks.tokens.next = 0;
    mocks.listRevisions.mockReset().mockResolvedValue(listing);
    mocks.listChanges.mockReset();
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
        // The longest jitter: every wait is (just under) its full delay.
        vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON);
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
        // The reconciled `hello` reset the backoff: the next reconnect is 1 s later.
        latest.close();
        await vi.advanceTimersByTimeAsync(1000);
        expect(FakeSocket.instances.at(-1)).not.toBe(latest);
    });

    it("doubles the reconnect delay when consecutive hellos fail to reconcile", async () => {
        vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON);
        mocks.listRevisions.mockRejectedValue(new Error("offline"));
        let ws = await started();
        for (const base of [1000, 2000]) {
            ws.frame({ type: "hello", epoch: "E1" });
            await vi.advanceTimersByTimeAsync(0);
            expect(ws.closed).toBe(true);
            expect(mocks.reconcileRemote).not.toHaveBeenCalled();
            const count = FakeSocket.instances.length;
            await vi.advanceTimersByTimeAsync(base - 2);
            expect(FakeSocket.instances).toHaveLength(count);
            await vi.advanceTimersByTimeAsync(2);
            expect(FakeSocket.instances).toHaveLength(count + 1);
            ws = FakeSocket.instances.at(-1)!;
        }
    });

    it("resets the backoff only after the current socket's reconcile succeeds", async () => {
        vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON);
        let ws = await started();
        for (const base of [1000, 2000, 4000]) {
            mocks.listRevisions.mockRejectedValueOnce(new Error("offline"));
            ws.frame({ type: "hello", epoch: "E1" });
            await vi.advanceTimersByTimeAsync(0);
            expect(ws.closed).toBe(true);
            await vi.advanceTimersByTimeAsync(base);
            ws = FakeSocket.instances.at(-1)!;
        }

        let staleAnswer!: (value: unknown) => void;
        mocks.listRevisions.mockReturnValueOnce(new Promise((resolve) => (staleAnswer = resolve)));
        ws.frame({ type: "hello", epoch: "E1" });
        // A hello whose listing is still pending does not reset the backoff.
        ws.close();
        await vi.advanceTimersByTimeAsync(7998);
        expect(FakeSocket.instances).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(2);
        expect(FakeSocket.instances).toHaveLength(5);
        staleAnswer(listing);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).not.toHaveBeenCalled();

        // The replaced socket's late listing does not reset the next wait either.
        FakeSocket.instances.at(-1)!.close();
        await vi.advanceTimersByTimeAsync(15998);
        expect(FakeSocket.instances).toHaveLength(5);
        await vi.advanceTimersByTimeAsync(2);
        expect(FakeSocket.instances).toHaveLength(6);

        let answer!: (value: unknown) => void;
        mocks.listRevisions.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        ws = FakeSocket.instances.at(-1)!;
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).not.toHaveBeenCalled();
        answer(listing);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).toHaveBeenCalledTimes(1);
        expect(mocks.reconcileRemote).toHaveBeenCalledWith(listing);
        ws.close();
        await vi.advanceTimersByTimeAsync(998);
        expect(FakeSocket.instances).toHaveLength(6);
        await vi.advanceTimersByTimeAsync(2);
        expect(FakeSocket.instances).toHaveLength(7);
    });

    it("jitters reconnects between half and all of the delay", async () => {
        const random = vi.spyOn(Math, "random").mockReturnValue(0);
        const ws = await started();
        ws.close();
        await vi.advanceTimersByTimeAsync(499);
        expect(FakeSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeSocket.instances).toHaveLength(2);

        // The second reconnect's 2 s delay, at the longest jitter.
        random.mockReturnValue(1 - Number.EPSILON);
        FakeSocket.instances[1].close();
        await vi.advanceTimersByTimeAsync(1998);
        expect(FakeSocket.instances).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(2);
        expect(FakeSocket.instances).toHaveLength(3);
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
        mocks.listRevisions.mockRejectedValueOnce(new ResourceEpochMismatchError("restored"));
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
// loaded epoch replaces the feed's whole lock set with its snapshot (a release may have been sent
// while disconnected, and a running job may write nothing for a while).
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

    it("replaces the feed's locks with every `hello`'s snapshot of the loaded epoch before reconciling, and touches no lock for another epoch's frames", async () => {
        const ws = await started();
        ws.frame({ type: "change", epoch: "E1", changes: chats, streaming });
        expect(mocks.noteRemoteStreaming).toHaveBeenCalledTimes(1);
        const snapshot = [{ ...streaming[0], revision: "E1:1:5" }];
        ws.frame({ type: "hello", epoch: "E1", streaming: snapshot, memoryTasks: [] });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.replaceFeedLocks).toHaveBeenCalledTimes(1);
        expect(mocks.replaceFeedLocks).toHaveBeenLastCalledWith(snapshot);
        expect(mocks.replaceFeedLocks.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.reconcileRemote.mock.invocationCallOrder[0],
        );
        // A reconnect's hello replaces again; one without a snapshot leaves no feed lock.
        ws.close();
        await vi.advanceTimersByTimeAsync(1000);
        const next = FakeSocket.instances.at(-1)!;
        next.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.replaceFeedLocks).toHaveBeenCalledTimes(2);
        expect(mocks.replaceFeedLocks).toHaveBeenLastCalledWith([]);
        // Another epoch halts: its locks are neither installed nor replaced here.
        next.frame({ type: "change", epoch: "E0", changes: chats, streaming });
        next.frame({ type: "hello", epoch: "E2", streaming: snapshot, memoryTasks: [] });
        expect(mocks.epochMismatch).toHaveBeenCalledWith("E2");
        expect(mocks.noteRemoteStreaming).toHaveBeenCalledTimes(1);
        expect(mocks.replaceFeedLocks).toHaveBeenCalledTimes(2);
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

    it("resets the module for an epoch mismatch of a replaced connection's listing too: the data was replaced, whichever connection read it", async () => {
        const tasks = await import("../process/memoryTasks.svelte");
        const ws = await started();
        let fail!: (error: unknown) => void;
        mocks.listRevisions.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
        ws.frame({
            type: "hello",
            epoch: "E1",
            memoryTasks: [{ characterId: "c", chatId: "k", status: status("running") }],
        });
        expect(tasks.memoryTaskStatus(ref)?.state).toBe("running");
        // The page comes back: the connection is replaced while its listing is still pending.
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(250);
        expect(ws.closed).toBe(true);
        fail(new ResourceEpochMismatchError("restored"));
        await vi.advanceTimersByTimeAsync(0);
        expect(tasks.memoryTaskStatus(ref)).toBeNull();
        // Any other failure of a replaced listing is dropped: the current socket stays, nothing is logged.
        const next = FakeSocket.instances.at(-1)!;
        let failNext!: (error: unknown) => void;
        mocks.listRevisions.mockReturnValueOnce(new Promise((_, reject) => (failNext = reject)));
        next.frame({ type: "hello", epoch: "E1", memoryTasks: [] });
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(250);
        expect(next.closed).toBe(true);
        failNext(new Error("offline"));
        await vi.advanceTimersByTimeAsync(0);
        expect(FakeSocket.instances.at(-1)!.closed).toBe(false);
        expect(console.error).not.toHaveBeenCalled();
    });
});

// The connection generation and the liveness helpers (`socketLiveness.ts`, the real module, under
// fake timers): a connection that goes silent or does not open in time is abandoned without its
// `close` and reconnected with the backoff; the page's return replaces the connection at once; and
// every late result of a replaced connection (its authentication, listing, `close`) does nothing.
describe("the connection's liveness and the resume reconnect", () => {
    const feedEvents = () => mocks.record.mock.calls.map(([input]) => input);
    let visibility: MockInstance<() => DocumentVisibilityState>;
    const show = (state: "visible" | "hidden") => {
        visibility.mockReturnValue(state);
        document.dispatchEvent(new Event("visibilitychange"));
    };

    beforeEach(() => {
        // The longest jitter: every wait is (just under) its full delay.
        vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON);
        visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    });

    it("abandons a socket silent for 45 s while the page is visible without waiting for its `close` (`stale`, the reconnect with the backoff); pings keep it alive; a hidden page is not checked", async () => {
        const ws = await started();
        ws.open();
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        // The server's pings, every 15 s, for a minute: alive.
        for (let ping = 0; ping < 4; ping += 1) {
            await vi.advanceTimersByTimeAsync(15_000);
            ws.frame({ type: "ping", ts: ping });
        }
        expect(FakeSocket.instances).toHaveLength(1);
        // Then silence: the checks 15 and 30 s after the last ping pass, the one at 45 s abandons.
        ws.silent = true;
        await vi.advanceTimersByTimeAsync(44_999);
        expect(ws.closed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(ws.closed).toBe(true);
        expect(feedEvents()).toEqual([
            { kind: "feed", phase: "connected", attempt: 0 },
            { kind: "feed", phase: "stale", attempt: 0 },
        ]);
        // No `close` of the dead socket came, and the reconnect (1 s at attempt 0) comes anyway.
        expect(FakeSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(FakeSocket.instances).toHaveLength(2);
        // The dead socket's late `close` is nothing: no event, no second reconnect.
        ws.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(FakeSocket.instances).toHaveLength(2);
        expect(feedEvents()).toHaveLength(2);

        // Hidden: not checked. Shown again after a short absence (no return): the next check sees it all.
        const next = FakeSocket.instances[1];
        next.open();
        next.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(40_000);
        show("hidden");
        await vi.advanceTimersByTimeAsync(20_000);
        expect(next.closed).toBe(false);
        show("visible");
        await vi.advanceTimersByTimeAsync(15_000);
        expect(next.closed).toBe(true);
        expect(feedEvents().at(-1)).toEqual({ kind: "feed", phase: "stale", attempt: 1 });
    });

    it("gives up a connection whose listing has not answered by its deadline although pings keep it alive, aborts the read, and reconciles on the reconnect, without waiting for a `close`", async () => {
        const ws = await started();
        ws.open();
        // A dead link: closing it fires no `close`, so the reconnect must not wait for one.
        ws.silent = true;
        mocks.listRevisions.mockReturnValueOnce(new Promise(() => {}));
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        const signal: AbortSignal = mocks.listRevisions.mock.calls[0][0].signal;
        let elapsed = 0;
        while (elapsed + 15_000 < feed.RECONCILE_DEADLINE_MS) {
            await vi.advanceTimersByTimeAsync(15_000);
            elapsed += 15_000;
            ws.frame({ type: "ping", ts: elapsed });
        }
        await vi.advanceTimersByTimeAsync(feed.RECONCILE_DEADLINE_MS - elapsed - 1);
        expect(ws.closed).toBe(false);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal.aborted).toBe(true);
        expect(ws.closed).toBe(true);
        expect(mocks.reconcileRemote).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        const next = FakeSocket.instances.at(-1)!;
        expect(next).not.toBe(ws);
        next.open();
        next.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).toHaveBeenCalledWith(listing);
    });

    it("abandons a connection not open within 10 s of its start, authentication included (`connectTimeout`), and a delayed authentication of the abandoned connection builds no socket", async () => {
        const auth = (await import("../storage/serverAuth")).getNodeServerProxyAuth as ReturnType<typeof vi.fn>;
        let answer!: (token: string) => void;
        auth.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        feed.startEventFeed();
        await vi.advanceTimersByTimeAsync(9_999);
        expect(feedEvents()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(feedEvents()).toEqual([{ kind: "feed", phase: "connectTimeout", attempt: 0 }]);
        expect(FakeSocket.instances).toHaveLength(0);
        // The retry (1 s) signs its own token; the first connection's token, arriving later, builds nothing.
        await vi.advanceTimersByTimeAsync(1000);
        expect(FakeSocket.instances).toHaveLength(1);
        answer("jwt-late");
        await vi.advanceTimersByTimeAsync(0);
        expect(FakeSocket.instances).toHaveLength(1);
        // A socket built but not open in time is closed and abandoned the same way; its own `close` records nothing.
        const ws = FakeSocket.instances[0];
        await vi.advanceTimersByTimeAsync(9_998);
        expect(ws.closed).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(ws.closed).toBe(true);
        expect(feedEvents()).toEqual([
            { kind: "feed", phase: "connectTimeout", attempt: 0 },
            { kind: "feed", phase: "connectTimeout", attempt: 1 },
        ]);
        // The backoff doubled (2 s), and a connection that opens in time is watched no further for that.
        await vi.advanceTimersByTimeAsync(1_997);
        expect(FakeSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(3);
        expect(FakeSocket.instances).toHaveLength(2);
        const opened = FakeSocket.instances[1];
        opened.open();
        opened.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(opened.closed).toBe(false);
        expect(feedEvents()).toHaveLength(3);
        expect(feedEvents()[2]).toEqual({ kind: "feed", phase: "connected", attempt: 2 });
    });

    it("replaces the connection at once when the page comes back (visible after 30 s hidden, `resume`, `online`; overlapping triggers build one socket), during a retry's wait too, without resetting the backoff", async () => {
        const ws = await started();
        ws.open();
        ws.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        show("hidden");
        await vi.advanceTimersByTimeAsync(30_000);
        ws.silent = true;
        show("visible");
        document.dispatchEvent(new Event("resume"));
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(249);
        expect(FakeSocket.instances).toHaveLength(1);
        expect(ws.closed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeSocket.instances).toHaveLength(2);
        expect(ws.closed).toBe(true);
        expect(feedEvents()).toEqual([
            { kind: "feed", phase: "connected", attempt: 0 },
            { kind: "feed", phase: "resumeReconnect", attempt: 0 },
        ]);
        const second = FakeSocket.instances[1];
        second.open();
        second.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(2);
        expect(mocks.reconcileRemote).toHaveBeenCalledTimes(2);
        // A shorter absence is not a return.
        show("hidden");
        await vi.advanceTimersByTimeAsync(29_999);
        show("visible");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(FakeSocket.instances).toHaveLength(2);

        // The socket drops (a 1 s retry is pending); `online` connects now, and the retry never fires.
        second.close();
        await vi.advanceTimersByTimeAsync(100);
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(250);
        expect(FakeSocket.instances).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(FakeSocket.instances).toHaveLength(3);
        expect(feedEvents().slice(2)).toEqual([
            { kind: "feed", phase: "connected", attempt: 0 },
            { kind: "feed", phase: "disconnected", attempt: 0, code: undefined },
            { kind: "feed", phase: "resumeReconnect", attempt: 1 },
        ]);
        // The resume did not reset the backoff: the next drop waits the second delay (2 s).
        FakeSocket.instances[2].close();
        await vi.advanceTimersByTimeAsync(1_998);
        expect(FakeSocket.instances).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(2);
        expect(FakeSocket.instances).toHaveLength(4);
    });

    it("lets a replaced connection's late results do nothing: its listing neither reconciles nor resets the backoff, and its `close` records nothing and schedules no reconnect", async () => {
        const ws = await started();
        ws.close();
        await vi.advanceTimersByTimeAsync(1000);
        const second = FakeSocket.instances[1];
        second.open();
        let answer!: (value: unknown) => void;
        mocks.listRevisions.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        second.frame({ type: "hello", epoch: "E1" });
        second.silent = true;
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(250);
        expect(FakeSocket.instances).toHaveLength(3);
        expect(second.closed).toBe(true);
        answer(listing);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).not.toHaveBeenCalled();
        second.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(FakeSocket.instances).toHaveLength(3);
        expect(feedEvents()).toEqual([
            { kind: "feed", phase: "connectFailed", attempt: 0, code: undefined },
            { kind: "feed", phase: "connected", attempt: 1 },
            { kind: "feed", phase: "resumeReconnect", attempt: 1 },
        ]);
        // The backoff still stands at its second delay: the third socket's drop waits 2 s.
        FakeSocket.instances[2].close();
        await vi.advanceTimersByTimeAsync(1_998);
        expect(FakeSocket.instances).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(2);
        expect(FakeSocket.instances).toHaveLength(4);
    });
});

describe("advertised revision reconciliation", () => {
    const initial: ResourceRevisionListing = {
        epoch: "E1",
        resources: [
            { kind: "ui", id: "main", revision: "E1:1:1" },
            { kind: "characters", id: "c", revision: "E1:2:1" },
        ],
        chats: [{ characterId: "c", id: "k", revision: "E1:3:1" }],
        chatOrders: [
            { characterId: "c", revision: "E1:4:1" },
            { characterId: "d", revision: "E1:6:1" },
        ],
    };
    const latest: ResourceRevisionListing = {
        epoch: "E1",
        resources: [{ kind: "ui", id: "main", revision: "E1:1:3" }],
        chats: [{ characterId: "c", id: "j", revision: "E1:5:1" }],
        chatOrders: [{ characterId: "c", revision: "E1:4:3" }],
    };
    const changes = {
        resources: [...latest.resources, { kind: "characters", id: "c", revision: null }],
        chats: [...latest.chats, { characterId: "c", id: "k", revision: null }],
        chatOrders: [...latest.chatOrders, { characterId: "d", revision: null }],
    };
    const hello = (ws: FakeSocket, rows = initial) =>
        ws.frame({ type: "hello", epoch: rows.epoch, digest: revisionDigest(rows), memoryTasks: [], streaming: [] });
    async function reconnect(ws: FakeSocket, delay = 1000) {
        ws.close();
        await vi.advanceTimersByTimeAsync(delay);
        const next = FakeSocket.instances.at(-1)!;
        expect(next).not.toBe(ws);
        return next;
    }
    beforeEach(() => {
        vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON);
        mocks.listRevisions.mockResolvedValue(initial);
    });

    it("reconciles a matching hello from advertised rows and resets reconnect backoff", async () => {
        const tasks = await import("../process/memoryTasks.svelte");
        const noted = vi.spyOn(tasks, "noteMemoryTaskListing");
        let ws = await started();
        hello(ws);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(1); // Even a matching unseeded map must read.
        ws.frame({ type: "change", epoch: "E1", changes });
        ws = await reconnect(ws);
        ws = await reconnect(ws, 2000); // An unsuccessful connection grew the backoff.
        hello(ws, latest);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(1);
        expect(noted).toHaveBeenLastCalledWith(expect.any(Number), latest);
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(latest);
        const count = FakeSocket.instances.length;
        ws.close();
        await vi.advanceTimersByTimeAsync(998);
        expect(FakeSocket.instances).toHaveLength(count);
        await vi.advanceTimersByTimeAsync(2);
        expect(FakeSocket.instances).toHaveLength(count + 1);
    });

    it("reads the listing when a dropped middle frame changed a row no later frame covered", async () => {
        const ws = await started();
        hello(ws);
        await vi.advanceTimersByTimeAsync(0);
        for (const revision of ["E1:1:2", "E1:1:3"]) {
            ws.frame({
                type: "change",
                epoch: "E1",
                changes: {
                    resources: [{ kind: "ui", id: "main", revision }],
                    chats: [],
                    chatOrders: [],
                },
            });
        }
        // The missing middle frame changed the character, independently of both UI changes.
        const serverRows = structuredClone(initial);
        serverRows.resources[0].revision = "E1:1:3";
        serverRows.resources[1].revision = "E1:2:2";
        mocks.listRevisions.mockResolvedValue(serverRows);
        hello(await reconnect(ws), serverRows);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(2);
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(serverRows);
    });

    it("ignores a superseded socket's listing and frames without seeding the advertised map", async () => {
        let resolve!: (rows: ResourceRevisionListing) => void;
        mocks.listRevisions.mockReturnValueOnce(new Promise<ResourceRevisionListing>((done) => (resolve = done)));
        const stale = await started();
        hello(stale);
        const current = await reconnect(stale);
        resolve(initial);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).not.toHaveBeenCalled();
        hello(current);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(2);
        stale.frame({ type: "change", epoch: "E1", changes });
        current.frame({ type: "change", epoch: "E0", changes });
        expect(mocks.noteRemoteChanges).not.toHaveBeenCalled();
        hello(await reconnect(current));
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(2);
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(initial);
    });

    it("overlays frames during a pending listing but reconciles and settles fences from the fetched listing unchanged", async () => {
        const tasks = await import("../process/memoryTasks.svelte");
        const noted = vi.spyOn(tasks, "noteMemoryTaskListing");
        let resolve!: (rows: ResourceRevisionListing) => void;
        mocks.listRevisions.mockReturnValueOnce(new Promise<ResourceRevisionListing>((done) => (resolve = done)));
        const ws = await started();
        hello(ws);
        ws.frame({
            type: "change",
            epoch: "E1",
            changes: {
                resources: [{ kind: "ui", id: "main", revision: "E1:1:2" }],
                chats: [],
                chatOrders: [],
            },
        });
        ws.frame({ type: "change", epoch: "E1", changes });
        resolve(initial);
        await vi.advanceTimersByTimeAsync(0);
        expect(noted).toHaveBeenLastCalledWith(expect.any(Number), initial);
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(initial);
        hello(await reconnect(ws), latest);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(1);
        expect(noted).toHaveBeenLastCalledWith(expect.any(Number), latest);
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(latest);
    });

    it("reads the listing when an older server omits the hello digest despite a seeded map", async () => {
        const ws = await started();
        hello(ws);
        await vi.advanceTimersByTimeAsync(0);
        const next = await reconnect(ws);
        next.frame({ type: "hello", epoch: "E1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(2);
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(initial);
    });

    it.each(["hello", "epoch", "listing error"])(
        "clears the advertised map and memory fences after an epoch change via %s",
        async (via) => {
            const tasks = await import("../process/memoryTasks.svelte");
            const ws = await started();
            hello(ws);
            await vi.advanceTimersByTimeAsync(0);
            ws.frame({
                type: "memoryTask",
                epoch: "E1",
                characterId: "c",
                chatId: "k",
                status: { taskId: "t", state: "running", done: 0, total: 1 },
            });
            expect(tasks.memoryTaskFenced({ chaId: "c", chatId: "k" })).toBe(true);
            if (via === "listing error") {
                mocks.listRevisions.mockRejectedValueOnce(new ResourceEpochMismatchError("restored"));
                ws.frame({ type: "hello", epoch: "E1" });
            } else {
                ws.frame({ type: via, epoch: "E2", digest: revisionDigest(initial) });
                expect(mocks.epochMismatch).toHaveBeenCalledWith("E2");
            }
            await vi.advanceTimersByTimeAsync(0);
            expect(tasks.memoryTaskFenced({ chaId: "c", chatId: "k" })).toBe(false);
            const reads = mocks.listRevisions.mock.calls.length;
            // The real epoch-mismatch handler reloads. While that reload is pending, old evidence is unusable.
            hello(await reconnect(ws));
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.listRevisions).toHaveBeenCalledTimes(reads + 1);
        },
    );
});

describe("bounded reconnect replay", () => {
    const empty = { resources: [], chats: [], chatOrders: [] };
    const initial: ResourceRevisionListing = {
        epoch: "E1",
        ...empty,
        resources: [
            { kind: "ui", id: "main", revision: "E1:1:1" },
            { kind: "characters", id: "c", revision: "E1:2:1" },
        ],
        chats: [{ characterId: "c", id: "k", revision: "E1:3:1" }],
        chatOrders: [{ characterId: "c", revision: "E1:4:1" }],
    };
    const away: ResourceRevisionListing = {
        ...initial,
        resources: [{ kind: "ui", id: "main", revision: "E1:1:2" }],
        chats: [],
        chatOrders: [],
    };
    const replay = {
        resources: [...away.resources, { kind: "characters", id: "c", revision: null }],
        chats: [{ characterId: "c", id: "k", revision: null }],
        chatOrders: [{ characterId: "c", revision: null }],
    };
    const hello = (ws: FakeSocket, rows: ResourceRevisionListing, cursor?: number) =>
        ws.frame({ type: "hello", epoch: "E1", digest: revisionDigest(rows), cursor, memoryTasks: [], streaming: [] });
    async function reconnect(ws: FakeSocket) {
        ws.close();
        await vi.advanceTimersByTimeAsync(1000);
        const next = FakeSocket.instances.at(-1)!;
        expect(next).not.toBe(ws);
        next.open();
        return next;
    }
    async function seed(cursor?: number) {
        mocks.listRevisions.mockResolvedValue(initial);
        const ws = await started();
        ws.open();
        hello(ws, initial, cursor);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listRevisions).toHaveBeenCalledTimes(1);
        expect(mocks.listChanges).not.toHaveBeenCalled();
        mocks.listRevisions.mockClear();
        mocks.reconcileRemote.mockClear();
        return ws;
    }
    beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON));

    it("reconciles a frozen hello-time replay while later frames survive in the advertised map and advance the next cursor", async () => {
        let ws = await seed(10);
        // A connected frame advances the replay start even though hello last advertised 10.
        ws.frame({
            type: "change",
            epoch: "E1",
            cursor: 11,
            changes: { ...empty, resources: [{ kind: "ui", id: "main", revision: "E1:1:2" }] },
        });
        ws = await reconnect(ws);
        let answer!: (value: unknown) => void;
        mocks.listChanges.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        hello(ws, away, 14);
        expect(mocks.listChanges).toHaveBeenCalledExactlyOnceWith({
            since: 11,
            until: 14,
            epoch: "E1",
            signal: expect.any(AbortSignal),
        });
        const later = {
            ...empty,
            resources: [{ kind: "ui", id: "main", revision: "E1:1:3" }],
            chats: [{ characterId: "d", id: "j", revision: "E1:9:1" }],
        };
        ws.frame({ type: "change", epoch: "E1", cursor: 16, changes: later });
        expect(mocks.noteRemoteChanges).toHaveBeenLastCalledWith(later);
        expect(mocks.reconcileRemote).not.toHaveBeenCalled();
        answer({ epoch: "E1", cursor: 14, changes: replay });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).toHaveBeenCalledExactlyOnceWith(away);
        expect(mocks.listRevisions).not.toHaveBeenCalled();
        const current = { epoch: "E1", ...later };
        ws = await reconnect(ws);
        hello(ws, current, 16);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(current);
        expect(mocks.listRevisions).not.toHaveBeenCalled();
        expect(mocks.listChanges).toHaveBeenCalledTimes(1); // Digest match reads nothing.
        ws = await reconnect(ws);
        const newest = { ...current, resources: [{ kind: "ui", id: "main", revision: "E1:1:4" }] };
        mocks.listChanges.mockResolvedValueOnce({
            epoch: "E1",
            cursor: 17,
            changes: { ...empty, resources: newest.resources },
        });
        hello(ws, newest, 17);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listChanges).toHaveBeenLastCalledWith({
            since: 16,
            until: 17,
            epoch: "E1",
            signal: expect.any(AbortSignal),
        });
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(newest);
        expect(mocks.listRevisions).not.toHaveBeenCalled();
    });

    it("reads the whole listing once when replay expires or cannot explain the digest", async () => {
        let ws = await seed(10);
        for (const reason of ["expired", "digest mismatch"]) {
            ws = await reconnect(ws);
            const rows = reason === "expired" ? away : initial;
            mocks.listChanges.mockResolvedValueOnce(
                reason === "expired"
                    ? { epoch: "E1", cursor: 20, expired: true }
                    : { epoch: "E1", cursor: 21, changes: empty },
            );
            mocks.listRevisions.mockResolvedValueOnce(rows);
            hello(ws, rows, reason === "expired" ? 20 : 21);
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.listChanges).toHaveBeenCalledTimes(1);
            expect(mocks.listRevisions).toHaveBeenCalledTimes(1);
            expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(rows);
            mocks.listChanges.mockClear();
            mocks.listRevisions.mockClear();
        }
    });

    it("reads the listing on first connection and when either the held cursor or an older server's hello cursor is absent", async () => {
        let ws = await seed();
        ws = await reconnect(ws);
        mocks.listRevisions.mockResolvedValueOnce(away);
        hello(ws, away, 20); // No held cursor from the older connection.
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listChanges).not.toHaveBeenCalled();
        expect(mocks.listRevisions).toHaveBeenCalledTimes(1);
        ws = await reconnect(ws);
        mocks.listRevisions.mockResolvedValueOnce(initial);
        hello(ws, initial); // A cursor is held now, but this server omits it.
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listChanges).not.toHaveBeenCalled();
        expect(mocks.listRevisions).toHaveBeenCalledTimes(2);
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(initial);
    });

    it("ignores unknown live frames without changing refs, locks, memory tasks or the resume cursor", async () => {
        const tasks = await import("../process/memoryTasks.svelte");
        let ws = await seed(10);
        ws.frame({
            type: "memoryTask",
            epoch: "E1",
            characterId: "c",
            chatId: "k",
            status: { taskId: "t", state: "running", done: 0, total: 1 },
        });
        const locks = mocks.replaceFeedLocks.mock.calls.length;
        expect(() =>
            ws.frame({
                type: "future-frame",
                epoch: "E2",
                cursor: 999,
                changes: replay,
                streaming: [],
                memoryTasks: [],
            }),
        ).not.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.noteRemoteChanges).not.toHaveBeenCalled();
        expect(mocks.noteRemoteStreaming).not.toHaveBeenCalled();
        expect(mocks.replaceFeedLocks).toHaveBeenCalledTimes(locks);
        expect(mocks.reconcileRemote).not.toHaveBeenCalled();
        expect(mocks.epochMismatch).not.toHaveBeenCalled();
        expect(tasks.memoryTaskFenced({ chaId: "c", chatId: "k" })).toBe(true);
        ws = await reconnect(ws);
        mocks.listChanges.mockResolvedValueOnce({ epoch: "E1", cursor: 14, changes: replay });
        hello(ws, away, 14);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listChanges).toHaveBeenCalledExactlyOnceWith({
            since: 10,
            until: 14,
            epoch: "E1",
            signal: expect.any(AbortSignal),
        });
        expect(mocks.listRevisions).not.toHaveBeenCalled();
        expect(mocks.reconcileRemote).toHaveBeenLastCalledWith(away);
        ws.frame({ type: "change", epoch: "E1", cursor: 15, changes: change });
        expect(mocks.noteRemoteChanges).toHaveBeenCalledExactlyOnceWith(change);
    });
});
