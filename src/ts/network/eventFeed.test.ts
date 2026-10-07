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
        EpochMismatch,
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
