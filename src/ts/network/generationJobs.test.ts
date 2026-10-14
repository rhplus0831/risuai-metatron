import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GenerationHooks, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";

// The client transport of server generation jobs (`generationJobs.ts`): the tab's identity and
// saved jobs, the create/status/abort requests and their errors, the owner socket's lifetime
// (cancellation before and after authentication, supersession, stamps, event filtering), the event
// dispatcher's wiring, and the resume after a reload. The chat module, the save adapter, and the
// channel dispatcher (`jobChannel.ts`, whose `registeredHooks` fills a create body's `hooks`) are
// stubbed here; the hydration contracts are in `src/ts/storage/tests/resourceSyncHydration.test.ts`.

const EPOCH = "11111111-2222-4333-8444-555555555555";

const stubs = vi.hoisted(() => ({
    /** Pending `getNodeServerProxyAuth` calls, settled by the test. */
    auth: [] as { resolve: (token: string) => void; reject: (error: unknown) => void }[],
    fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
    applyServerGeneration: vi.fn(() => true),
    endServerJob: vi.fn(),
    applyHydration: vi.fn(() => true),
    applyPatchHydration: vi.fn<() => "applied" | "busy" | "mismatch" | "old">(() => "applied"),
    /** `flushResources`: the recovery's save of the local work that kept a job chat copy out. */
    flushResources: vi.fn<() => Promise<{ discarded: string[] }>>(async () => ({ discarded: [] })),
    /** `isChatStale` and `chatHydrationHold`: what the recovery reads of the chat module. */
    isChatStale: vi.fn<() => boolean>(() => false),
    chatHydrationHold: vi.fn<() => "none" | "saving" | "held">(() => "none"),
    registeredHooks: vi.fn<() => Promise<GenerationHooks>>(),
    handleChannelEvent: vi.fn(),
    rememberHydration: vi.fn(),
    endJobChannel: vi.fn(),
    changeToPreset: vi.fn(),
    /** `recordClientEvent`: the job link's diagnostics (request history slice 8). */
    record: vi.fn<(input: unknown) => void>(),
}));

vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => stubs.fetch(path, init),
    getNodeServerProxyAuth: () =>
        new Promise<string>((resolve, reject) => {
            stubs.auth.push({ resolve, reject });
        }),
}));
vi.mock("../storage/chatStore.svelte", () => ({
    applyServerGeneration: stubs.applyServerGeneration,
    endServerJob: stubs.endServerJob,
    isChatStale: stubs.isChatStale,
    chatHydrationHold: stubs.chatHydrationHold,
}));
vi.mock("../storage/resourceSync.svelte", () => ({
    applyHydration: stubs.applyHydration,
    applyPatchHydration: stubs.applyPatchHydration,
    flushResources: stubs.flushResources,
}));
vi.mock("./jobChannel", () => ({
    registeredHooks: stubs.registeredHooks,
    handleChannelEvent: stubs.handleChannelEvent,
    rememberHydration: stubs.rememberHydration,
    endJobChannel: stubs.endJobChannel,
}));
// A job's `preset` event applies the preset through the preset actions module (Phase 6 slice 10).
vi.mock("../storage/presets.svelte", () => ({ changeToPreset: stubs.changeToPreset }));
vi.mock("../diagnostics/collector", () => ({ recordClientEvent: (input: unknown) => stubs.record(input) }));

type Transport = typeof import("./generationJobs");
type Client = typeof import("../storage/resourceClient");

/** A WebSocket double: the test opens it, feeds it messages, and sees what was sent and closed. */
class FakeSocket {
    static instances: FakeSocket[] = [];
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    sent: string[] = [];
    closeCalls = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    constructor(readonly url: string) {
        FakeSocket.instances.push(this);
    }
    open() {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.();
    }
    message(event: unknown) {
        this.onmessage?.({ data: JSON.stringify(event) });
    }
    send(text: string) {
        this.sent.push(text);
    }
    close() {
        this.closeCalls += 1;
        this.readyState = FakeSocket.CLOSED;
        queueMicrotask(() => this.onclose?.({ code: 1000 }));
    }
    get stamp() {
        return Number(new URL(this.url).searchParams.get("attach"));
    }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settled = async <T>(promise: Promise<T>) =>
    Promise.race([promise.then(() => "settled" as const), flush().then(() => "pending" as const)]);
const json = (status: number, body: unknown) => Response.json(body, { status });

let transport: Transport;
let client: Client;

beforeEach(async () => {
    vi.resetModules();
    stubs.auth.length = 0;
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { protocol: "https:", host: "risu.test" });
    sessionStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubs.registeredHooks.mockResolvedValue(NO_GENERATION_HOOKS);
    client = await import("../storage/resourceClient");
    client.setResourceEpoch(EPOCH);
    transport = await import("./generationJobs");
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    stubs.isChatStale.mockReset().mockReturnValue(false);
    stubs.chatHydrationHold.mockReset().mockReturnValue("none");
    stubs.flushResources.mockReset().mockResolvedValue({ discarded: [] });
    stubs.applyPatchHydration.mockReset().mockReturnValue("applied");
    stubs.applyHydration.mockReset().mockReturnValue(true);
});

describe("the tab's identity and saved jobs", () => {
    it("creates the client id once per tab and keeps it in sessionStorage", async () => {
        const id = transport.generationClientId();
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(transport.generationClientId()).toBe(id);
        expect(sessionStorage.getItem("risu-generation-client")).toBe(id);
        vi.resetModules();
        const again: Transport = await import("./generationJobs");
        expect(again.generationClientId()).toBe(id);
    });

    it("keys saved jobs by a JSON pair, so ids with slashes never collide, and forgets a job by its id", () => {
        transport.rememberGenerationJob({ chaId: "a/b", chatId: "c" }, "j1");
        transport.rememberGenerationJob({ chaId: "a", chatId: "b/c" }, "j2");
        expect(transport.savedGenerationJobs()).toEqual({ '["a/b","c"]': "j1", '["a","b/c"]': "j2" });
        transport.forgetGenerationJob("j1");
        expect(transport.savedGenerationJobs()).toEqual({ '["a","b/c"]': "j2" });
        transport.forgetGenerationJob("nope");
        expect(transport.savedGenerationJobs()).toEqual({ '["a","b/c"]': "j2" });
    });
});

describe("the requests", () => {
    const body = {
        kind: "send" as const,
        context: {
            characterId: "c",
            chatId: "k",
            presetId: null,
            modelPresetId: null,
            personaId: null,
            mode: "normal",
            input: "",
            chatRevision: "r",
        },
    };

    it("creates a job with the epoch, the client id, and the hooks, remembers it, and maps the refusals to typed errors", async () => {
        // Without a `hooks` list, the body carries the dispatcher's registered hooks.
        const registered: GenerationHooks = { ...NO_GENERATION_HOOKS, scripts: ["editoutput"], mcpTools: ["plugin:t"] };
        stubs.registeredHooks.mockResolvedValueOnce(registered);
        stubs.fetch.mockResolvedValueOnce(json(200, { jobId: "j1" }));
        await expect(transport.createGenerationJob(body)).resolves.toBe("j1");
        const [path, init] = stubs.fetch.mock.calls[0];
        expect(path).toBe("/api/generations");
        expect((init!.headers as Record<string, string>)[RESOURCE_EPOCH_HEADER]).toBe(EPOCH);
        expect(JSON.parse(String(init!.body))).toEqual({
            ...body,
            hooks: registered,
            clientId: transport.generationClientId(),
        });
        expect(transport.savedGenerationJobs()).toEqual({ '["c","k"]': "j1" });

        // An explicit list is sent as given, without asking the dispatcher.
        stubs.fetch.mockResolvedValueOnce(json(409, { error: "chatBusy", jobId: "j9" }));
        await expect(transport.createGenerationJob({ ...body, hooks: NO_GENERATION_HOOKS })).rejects.toMatchObject({
            name: "GenerationBusyError",
            jobId: "j9",
        });
        expect(JSON.parse(String(stubs.fetch.mock.calls[1][1]!.body)).hooks).toEqual(NO_GENERATION_HOOKS);
        expect(stubs.registeredHooks).toHaveBeenCalledTimes(1);
        stubs.fetch.mockResolvedValueOnce(json(409, { error: "stale" }));
        await expect(transport.createGenerationJob(body)).rejects.toMatchObject({ name: "GenerationStaleError" });
        // A 412 runs the resource client's restore halt, as any other resource request would.
        const listener = vi.fn();
        client.setEpochMismatchListener(listener);
        stubs.fetch.mockResolvedValueOnce(json(412, { error: "EpochMismatch", epoch: "other" }));
        await expect(transport.createGenerationJob(body)).rejects.toBeInstanceOf(client.ResourceEpochMismatchError);
        expect(listener).toHaveBeenCalledWith("other");
        stubs.fetch.mockResolvedValueOnce(json(503, { error: "not now" }));
        await expect(transport.createGenerationJob(body)).rejects.toMatchObject({
            name: "ResourceRequestError",
            status: 503,
            message: "not now",
        });
        stubs.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        await expect(transport.createGenerationJob(body)).rejects.toMatchObject({ status: 0 });
        // The saved job survives the refusals.
        expect(transport.savedGenerationJobs()).toEqual({ '["c","k"]': "j1" });
    });

    it("reads a status (null when the server does not know the job) and aborts (a 404 is fine)", async () => {
        stubs.fetch.mockResolvedValueOnce(json(200, { jobId: "j1", state: "running" }));
        await expect(transport.readGenerationJob("j1")).resolves.toMatchObject({ jobId: "j1", state: "running" });
        expect(stubs.fetch.mock.calls[0][0]).toBe(`/api/generations/j1?clientId=${transport.generationClientId()}`);
        stubs.fetch.mockResolvedValueOnce(json(404, { error: "Generation not found" }));
        await expect(transport.readGenerationJob("j1")).resolves.toBeNull();
        stubs.fetch.mockResolvedValueOnce(json(500, { error: "boom" }));
        await expect(transport.readGenerationJob("j1")).rejects.toMatchObject({ status: 500 });
        stubs.fetch.mockResolvedValueOnce(json(200, { aborted: true }));
        await expect(transport.abortGenerationJob("j1")).resolves.toBeUndefined();
        expect(stubs.fetch.mock.calls.at(-1)![1]).toMatchObject({ method: "DELETE" });
        stubs.fetch.mockResolvedValueOnce(json(404, { error: "gone" }));
        await expect(transport.abortGenerationJob("j1")).resolves.toBeUndefined();
        stubs.fetch.mockResolvedValueOnce(json(500, { error: "boom" }));
        await expect(transport.abortGenerationJob("j1")).rejects.toMatchObject({ status: 500 });
    });
});

describe("following a job", () => {
    it("connects with a fresh JWT, the client id, and an increasing attach stamp; delivers events of this epoch and closes on the terminal", async () => {
        const seen: unknown[] = [];
        const follow = transport.followGenerationJob("j1", (event) => seen.push(event));
        expect(FakeSocket.instances).toHaveLength(0);
        expect(follow.send({ x: 1 })).toBe(false);
        stubs.auth[0].resolve("jwt-1");
        await flush();
        const [socket] = FakeSocket.instances;
        const url = new URL(socket.url);
        expect(url.protocol).toBe("wss:");
        expect(url.host).toBe("risu.test");
        expect(url.pathname).toBe("/api/generations/j1/ws");
        expect(url.searchParams.get("risu-auth")).toBe("jwt-1");
        expect(url.searchParams.get("clientId")).toBe(transport.generationClientId());
        expect(socket.stamp).toBeGreaterThan(0);
        expect(follow.send({ x: 1 })).toBe(false);
        socket.open();
        expect(follow.send({ x: 1 })).toBe(true);
        expect(socket.sent).toEqual([JSON.stringify({ x: 1 })]);
        socket.message({ type: "ping", ts: 1 });
        socket.message({ type: "progress", epoch: "other-epoch", payload: 1 });
        socket.message({ type: "progress", epoch: EPOCH, payload: 2 });
        socket.onmessage!({ data: "not json" });
        expect(seen).toEqual([{ type: "progress", epoch: EPOCH, payload: 2 }]);
        expect(await settled(follow.closed)).toBe("pending");
        socket.message({ type: "done", epoch: EPOCH, revision: null });
        expect(socket.closeCalls).toBe(1);
        await expect(follow.closed).resolves.toEqual({ terminal: { type: "done", epoch: EPOCH, revision: null } });
        expect(follow.send({ late: true })).toBe(false);
        // Another follow's stamp is higher.
        const next = transport.followGenerationJob("j1", () => {});
        stubs.auth[1].resolve("jwt-2");
        await flush();
        expect(FakeSocket.instances[1].stamp).toBeGreaterThan(socket.stamp);
        next.close();
    });

    it("settles `closed` when cancelled before authentication, and never builds a socket afterwards", async () => {
        const follow = transport.followGenerationJob("j1", () => {});
        expect(await settled(follow.closed)).toBe("pending");
        follow.close();
        await expect(follow.closed).resolves.toEqual({ terminal: null });
        stubs.auth[0].resolve("jwt");
        await flush();
        expect(FakeSocket.instances).toHaveLength(0);
        // A rejected authentication after cancellation is handled too; one that fails on its own
        // ends the follow with no socket.
        const second = transport.followGenerationJob("j2", () => {});
        second.close();
        stubs.auth[1].reject(new Error("no auth"));
        await flush();
        const third = transport.followGenerationJob("j3", () => {});
        stubs.auth[2].reject(new Error("no auth"));
        await expect(third.closed).resolves.toEqual({ terminal: null });
        expect(FakeSocket.instances).toHaveLength(0);
        expect(console.error).toHaveBeenCalled();
    });

    it("lets a newer follow of the job supersede an older one, whichever authenticates first, with one usable stream", async () => {
        const seenA: unknown[] = [];
        const seenB: unknown[] = [];
        const a = transport.followGenerationJob("j1", (event) => seenA.push(event));
        const b = transport.followGenerationJob("j1", (event) => seenB.push(event));
        // Superseding settles the older follow at once, even before its authentication.
        await expect(a.closed).resolves.toEqual({ terminal: null });
        // The newer one authenticates first, then the older one: only the newer builds a socket.
        stubs.auth[1].resolve("jwt-b");
        await flush();
        stubs.auth[0].resolve("jwt-a");
        await flush();
        expect(FakeSocket.instances).toHaveLength(1);
        const socketB = FakeSocket.instances[0];
        expect(new URL(socketB.url).searchParams.get("risu-auth")).toBe("jwt-b");
        socketB.open();
        socketB.message({ type: "progress", epoch: EPOCH, payload: "b" });
        expect(seenB).toEqual([{ type: "progress", epoch: EPOCH, payload: "b" }]);
        expect(seenA).toEqual([]);
        expect(a.send({})).toBe(false);
        expect(b.send({})).toBe(true);
        // A third follow supersedes the open one: its socket is closed and its queued message ignored.
        const seenC: unknown[] = [];
        const c = transport.followGenerationJob("j1", (event) => seenC.push(event));
        expect(socketB.closeCalls).toBe(1);
        socketB.message({ type: "progress", epoch: EPOCH, payload: "late for b" });
        expect(seenB).toHaveLength(1);
        expect(b.send({})).toBe(false);
        await expect(b.closed).resolves.toEqual({ terminal: null });
        stubs.auth[2].resolve("jwt-c");
        await flush();
        expect(FakeSocket.instances).toHaveLength(2);
        const socketC = FakeSocket.instances[1];
        expect(socketC.stamp).toBeGreaterThan(socketB.stamp);
        socketC.open();
        socketC.message({ type: "progress", epoch: EPOCH, payload: "c" });
        expect(seenC).toEqual([{ type: "progress", epoch: EPOCH, payload: "c" }]);
        // Closing the newest follow explicitly; a follow of another job is independent.
        c.close();
        expect(socketC.closeCalls).toBe(1);
        await expect(c.closed).resolves.toEqual({ terminal: null });
    });

    it("cancels a socket that is still connecting when superseded", async () => {
        const a = transport.followGenerationJob("j1", () => {});
        stubs.auth[0].resolve("jwt-a");
        await flush();
        const socketA = FakeSocket.instances[0];
        expect(socketA.readyState).toBe(FakeSocket.CONNECTING);
        transport.followGenerationJob("j1", () => {});
        expect(socketA.closeCalls).toBe(1);
        await expect(a.closed).resolves.toEqual({ terminal: null });
    });
});

describe("the event dispatcher and the resume", () => {
    const ref = { chaId: "c", chatId: "k" };

    it("routes accepted and chunk to the chat module, resource to the save adapter (with the job's streaming list), and the terminal to the job's end", () => {
        transport.rememberGenerationJob(ref, "j1");
        transport.applyGenerationEvent("j1", ref, {
            type: "accepted",
            epoch: EPOCH,
            jobId: "j1",
            messageId: "r",
            generationId: "g",
            revision: "x",
            text: "",
        });
        transport.applyGenerationEvent("j1", ref, {
            type: "accepted",
            epoch: EPOCH,
            jobId: "j1",
            revision: "x",
            text: "",
        });
        transport.applyGenerationEvent("j1", ref, {
            type: "chunk",
            epoch: EPOCH,
            messageId: "r",
            generationId: "g",
            text: "one",
            seq: 1,
        });
        expect(stubs.applyServerGeneration.mock.calls).toEqual([
            [ref, { jobId: "j1", messageId: "r", generationId: "g", text: "", seq: 0 }],
            [ref, { jobId: "j1", messageId: "r", generationId: "g", text: "one", seq: 1 }],
        ]);
        const streaming = [{ messageId: "r", generationId: "g", seq: 1 }];
        transport.applyGenerationEvent("j1", ref, {
            type: "resource",
            epoch: EPOCH,
            kind: "chats",
            characterId: "c",
            id: "k",
            revision: "x",
            data: { id: "k" },
            streaming,
        });
        transport.applyGenerationEvent("j1", ref, {
            type: "resource",
            epoch: EPOCH,
            kind: "characters",
            id: "c",
            revision: "y",
            data: { chaId: "c" },
        });
        expect(stubs.applyHydration.mock.calls).toEqual([
            [
                {
                    kind: "chats",
                    id: "k",
                    characterId: "c",
                    revision: "x",
                    data: { id: "k" },
                    job: { jobId: "j1", streaming },
                },
            ],
            [{ kind: "characters", id: "c", characterId: undefined, revision: "y", data: { chaId: "c" } }],
        ]);
        transport.applyGenerationEvent("j1", ref, { type: "progress", epoch: EPOCH, payload: 1 });
        transport.applyGenerationEvent("j1", ref, { type: "preset", epoch: EPOCH, presetId: "p" });
        expect(stubs.endServerJob).not.toHaveBeenCalled();
        transport.applyGenerationEvent("j1", ref, {
            type: "error",
            epoch: EPOCH,
            message: "x",
            status: 499,
            reason: "aborted",
        });
        expect(stubs.endServerJob).toHaveBeenCalledWith("j1");
        expect(transport.savedGenerationJobs()).toEqual({});
    });

    it("applies a `chatPatch` through the save adapter without remembering it for the barrier, and asks the follow for the chat whole once per follow on a mismatch, until a whole job chat arrives on that follow", async () => {
        const follow = { send: vi.fn(() => true) };
        const streaming = [{ messageId: "r", generationId: "g", seq: 1 }];
        const patch = {
            type: "chatPatch" as const,
            epoch: EPOCH,
            characterId: "c",
            id: "k",
            baseRevision: "b",
            revision: "x",
            meta: { name: "K" },
            removed: ["z"],
            messages: [{ after: "a", message: { chatId: "r", data: "R" } }],
            count: 2,
            streaming,
        };
        const whole = (id: string) => ({
            type: "resource" as const,
            epoch: EPOCH,
            kind: "chats" as const,
            characterId: "c",
            id,
            revision: "y",
            data: { id },
            streaming: [],
        });
        // The earlier tests' resource events reach the lazily loaded dispatcher after they ended.
        await flush();
        stubs.rememberHydration.mockClear();
        transport.applyGenerationEvent("j1", ref, patch, follow);
        expect(stubs.applyPatchHydration.mock.calls).toEqual([
            [
                {
                    characterId: "c",
                    id: "k",
                    baseRevision: "b",
                    revision: "x",
                    meta: { name: "K" },
                    removed: ["z"],
                    messages: [{ after: "a", message: { chatId: "r", data: "R" } }],
                    count: 2,
                },
                { jobId: "j1", streaming },
            ],
        ]);
        await flush();
        expect(stubs.rememberHydration).not.toHaveBeenCalled();
        expect(follow.send).not.toHaveBeenCalled();
        // Local work kept it out (`busy`) and nothing saves that work (the chat is held): nothing is
        // asked now, and no recovery saves anything (the recovery itself is covered below).
        stubs.applyPatchHydration.mockReturnValue("busy");
        stubs.chatHydrationHold.mockReturnValue("held");
        transport.applyGenerationEvent("j1", ref, patch, follow);
        expect(follow.send).not.toHaveBeenCalled();
        expect(stubs.flushResources).not.toHaveBeenCalled();
        stubs.chatHydrationHold.mockReturnValue("none");
        // A mismatch of a stale chat asks once; a second mismatch on the same follow does not ask again.
        stubs.isChatStale.mockReturnValue(true);
        stubs.applyPatchHydration.mockReturnValue("mismatch");
        transport.applyGenerationEvent("j1", ref, patch, follow);
        transport.applyGenerationEvent("j1", ref, patch, follow);
        expect(follow.send.mock.calls).toEqual([[{ type: "resync" }]]);
        // A whole copy of another chat does not answer the request; the job chat's does, so a later
        // mismatch asks again.
        transport.applyGenerationEvent("j1", ref, whole("j"), follow);
        transport.applyGenerationEvent("j1", ref, patch, follow);
        expect(follow.send).toHaveBeenCalledTimes(1);
        transport.applyGenerationEvent("j1", ref, whole("k"), follow);
        transport.applyGenerationEvent("j1", ref, patch, follow);
        expect(follow.send).toHaveBeenCalledTimes(2);
        // A request the follow could not send (its socket is not open) is not counted as outstanding.
        const broken = { send: vi.fn(() => false) };
        transport.applyGenerationEvent("j1", ref, patch, broken);
        transport.applyGenerationEvent("j1", ref, patch, broken);
        expect(broken.send).toHaveBeenCalledTimes(2);
        // Another follow of the job asks on its own; without a follow there is nothing to ask.
        const other = { send: vi.fn(() => true) };
        transport.applyGenerationEvent("j1", ref, patch, other);
        expect(other.send.mock.calls).toEqual([[{ type: "resync" }]]);
        expect(() => transport.applyGenerationEvent("j1", ref, patch)).not.toThrow();
        expect(follow.send).toHaveBeenCalledTimes(2);
        // A mismatch of a chat that is not stale any more (a copy arrived meanwhile), or one whose
        // local work would refuse the copy, asks nothing.
        stubs.isChatStale.mockReturnValue(false);
        transport.applyGenerationEvent("j1", ref, patch, other);
        stubs.isChatStale.mockReturnValue(true);
        stubs.chatHydrationHold.mockReturnValue("saving");
        transport.applyGenerationEvent("j1", ref, patch, other);
        expect(other.send).toHaveBeenCalledTimes(1);
        // Nothing is asked through a follow whose job ended.
        stubs.chatHydrationHold.mockReturnValue("none");
        transport.applyGenerationEvent("j1", ref, { type: "done", epoch: EPOCH, revision: null }, other);
        transport.applyGenerationEvent("j1", ref, patch, other);
        expect(other.send).toHaveBeenCalledTimes(1);
    });

    // The fix round of the `chatPatch` change: a copy refused for local work (`busy`, or a whole job
    // chat `resource` that did not apply while the chat is stale) starts one recovery per follow,
    // which saves the local work and then asks for the chat whole, since a stalled stream may send no
    // other patch; it retries a failed save or new local work with a growing wait while the follow lasts.
    describe("the recovery after a copy refused for local work", () => {
        const streaming: { messageId: string; generationId: string; seq: number }[] = [];
        const patch = {
            type: "chatPatch" as const,
            epoch: EPOCH,
            characterId: "c",
            id: "k",
            baseRevision: "b",
            revision: "x",
            count: 2,
            streaming,
        };
        const whole = {
            type: "resource" as const,
            epoch: EPOCH,
            kind: "chats" as const,
            characterId: "c",
            id: "k",
            revision: "y",
            data: { id: "k" },
            streaming,
        };
        /** A `flushResources` the test settles. */
        const pendingFlush = () => {
            let settle!: { resolve: () => void; reject: (error: unknown) => void };
            stubs.flushResources.mockImplementationOnce(
                () =>
                    new Promise<{ discarded: string[] }>((resolve, reject) => {
                        settle = { resolve: () => resolve({ discarded: [] }), reject };
                    }),
            );
            return () => settle;
        };
        const microtasks = async () => {
            for (let round = 0; round < 4; round += 1) {
                await Promise.resolve();
            }
        };

        beforeEach(() => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            stubs.isChatStale.mockReturnValue(true);
            stubs.applyPatchHydration.mockReturnValue("busy");
        });

        it("saves once for every busy copy of the follow (coalesced), then asks for the chat whole when the chat is still stale and nothing local holds it", async () => {
            const follow = { send: vi.fn(() => true) };
            stubs.chatHydrationHold.mockReturnValue("saving");
            const settle = pendingFlush();
            transport.applyGenerationEvent("j1", ref, patch, follow);
            transport.applyGenerationEvent("j1", ref, patch, follow);
            expect(stubs.flushResources).toHaveBeenCalledTimes(1);
            expect(follow.send).not.toHaveBeenCalled();
            stubs.chatHydrationHold.mockReturnValue("none");
            settle().resolve();
            await microtasks();
            expect(follow.send.mock.calls).toEqual([[{ type: "resync" }]]);
            // One request at a time: the recovery ended, a later busy copy starts a new one, and its
            // request waits for the whole copy of the first one.
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(2);
            expect(follow.send).toHaveBeenCalledTimes(1);
            stubs.applyHydration.mockReturnValue(true);
            transport.applyGenerationEvent("j1", ref, whole, follow);
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(follow.send).toHaveBeenCalledTimes(2);
        });

        it("asks nothing and saves nothing for a chat held by work no save settles, or one no longer stale after the save", async () => {
            const follow = { send: vi.fn(() => true) };
            stubs.chatHydrationHold.mockReturnValue("held");
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).not.toHaveBeenCalled();
            expect(follow.send).not.toHaveBeenCalled();
            // Saved, and a copy applied meanwhile (not stale any more): nothing to ask; the recovery
            // ended, so a later busy copy starts a new one.
            stubs.chatHydrationHold.mockReturnValue("none");
            stubs.isChatStale.mockReturnValue(false);
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(1);
            expect(follow.send).not.toHaveBeenCalled();
            stubs.isChatStale.mockReturnValue(true);
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(2);
            expect(follow.send).toHaveBeenCalledTimes(1);
            // The save settled but the chat is held now: the recovery gives way without asking.
            stubs.applyHydration.mockReturnValue(true);
            transport.applyGenerationEvent("j1", ref, whole, follow);
            stubs.chatHydrationHold.mockReturnValue("held");
            stubs.chatHydrationHold.mockReturnValueOnce("saving");
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(3);
            expect(follow.send).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        });

        it("tries again with a doubling wait, capped at 15 s, while the chat still has work after the save or the save failed, as long as the follow lasts", async () => {
            const follow = { send: vi.fn(() => true) };
            stubs.chatHydrationHold.mockReturnValue("saving");
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(1);
            // Still saving after each save: 1 s, 2 s, 4 s, 8 s, 15 s, 15 s.
            for (const [wait, calls] of [
                [999, 1],
                [1, 2],
                [2000, 3],
                [4000, 4],
                [8000, 5],
                [15_000, 6],
                [15_000, 7],
            ] as const) {
                await vi.advanceTimersByTimeAsync(wait);
                expect(stubs.flushResources, `after ${wait} ms`).toHaveBeenCalledTimes(calls);
            }
            expect(follow.send).not.toHaveBeenCalled();
            // A failed save is tried again too; a busy copy meanwhile joins the running recovery.
            stubs.flushResources.mockRejectedValueOnce(new Error("offline"));
            await vi.advanceTimersByTimeAsync(15_000);
            expect(stubs.flushResources).toHaveBeenCalledTimes(8);
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(8);
            expect(vi.getTimerCount()).toBe(1);
            // The work settled: the next try asks.
            stubs.chatHydrationHold.mockReturnValue("none");
            await vi.advanceTimersByTimeAsync(15_000);
            expect(stubs.flushResources).toHaveBeenCalledTimes(9);
            expect(follow.send.mock.calls).toEqual([[{ type: "resync" }]]);
            expect(vi.getTimerCount()).toBe(0);
        });

        it("ends with the job (`done`, `error`): a pending save asks nothing, a waiting try is dropped, and later copies start nothing", async () => {
            const follow = { send: vi.fn(() => true) };
            const settle = pendingFlush();
            transport.applyGenerationEvent("j1", ref, patch, follow);
            transport.applyGenerationEvent("j1", ref, { type: "done", epoch: EPOCH, revision: null }, follow);
            settle().resolve();
            await microtasks();
            expect(follow.send).not.toHaveBeenCalled();
            transport.applyGenerationEvent("j1", ref, patch, follow);
            stubs.applyPatchHydration.mockReturnValue("mismatch");
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(1);
            expect(follow.send).not.toHaveBeenCalled();
            // A waiting try is dropped by the end.
            const other = { send: vi.fn(() => true) };
            stubs.applyPatchHydration.mockReturnValue("busy");
            stubs.flushResources.mockRejectedValueOnce(new Error("offline"));
            transport.applyGenerationEvent("j2", ref, patch, other);
            await microtasks();
            expect(vi.getTimerCount()).toBe(1);
            transport.applyGenerationEvent(
                "j2",
                ref,
                { type: "error", epoch: EPOCH, message: "x", status: 500, reason: "failed" },
                other,
            );
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(stubs.flushResources).toHaveBeenCalledTimes(2);
            expect(other.send).not.toHaveBeenCalled();
        });

        it("ends when the follow closes (a superseded or closed socket): its waiting try is dropped and nothing more is asked through it", async () => {
            const follow = transport.followGenerationJob("j1", () => {});
            stubs.flushResources.mockRejectedValueOnce(new Error("offline"));
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(1);
            follow.close();
            await follow.closed;
            await microtasks();
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(stubs.flushResources).toHaveBeenCalledTimes(1);
            transport.applyGenerationEvent("j1", ref, patch, follow);
            stubs.applyPatchHydration.mockReturnValue("mismatch");
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(1);
            // A new follow of the same job recovers on its own.
            const next = transport.followGenerationJob("j1", () => {});
            stubs.applyPatchHydration.mockReturnValue("busy");
            transport.applyGenerationEvent("j1", ref, patch, next);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(2);
            next.close();
        });

        it("starts a recovery for a whole job chat copy that did not apply while the chat is stale (local work kept it out), not for one of another chat or an applied one", async () => {
            const follow = { send: vi.fn(() => true) };
            stubs.applyHydration.mockReturnValue(false);
            transport.applyGenerationEvent("j1", ref, { ...whole, id: "j" }, follow);
            stubs.isChatStale.mockReturnValue(false);
            transport.applyGenerationEvent("j1", ref, whole, follow);
            await microtasks();
            expect(stubs.flushResources).not.toHaveBeenCalled();
            stubs.isChatStale.mockReturnValue(true);
            stubs.applyHydration.mockReturnValue(true);
            transport.applyGenerationEvent("j1", ref, whole, follow);
            await microtasks();
            expect(stubs.flushResources).not.toHaveBeenCalled();
            stubs.applyHydration.mockReturnValue(false);
            transport.applyGenerationEvent("j1", ref, whole, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(1);
            expect(follow.send.mock.calls).toEqual([[{ type: "resync" }]]);
        });
    });

    it("leaves the selection alone on a job's `preset` event: a presetChain pick is the job's own (`docs/plan/chat-binding.md`, decision 9)", async () => {
        await flush();
        stubs.changeToPreset.mockClear();
        const preset = { type: "preset" as const, epoch: EPOCH, presetId: "pa" };
        transport.applyGenerationEvent("jp1", ref, preset);
        transport.applyGenerationEvent("jp1", ref, preset);
        transport.applyGenerationEvent("jp2", ref, { ...preset, presetId: "pb" });
        await flush();
        expect(stubs.changeToPreset).not.toHaveBeenCalled();
        expect(stubs.endServerJob).not.toHaveBeenCalled();
    });

    it("hands channel events to the lazily loaded dispatcher with the follow as transport, in socket order with the hydrations, and ends the channel on the terminal", async () => {
        const follow = { send: vi.fn(() => true) };
        const order: string[] = [];
        stubs.rememberHydration.mockImplementation((record: { id: string }) => order.push(`hydration:${record.id}`));
        stubs.handleChannelEvent.mockImplementation((_jobId: string, event: { type: string }) =>
            order.push(event.type),
        );
        stubs.endJobChannel.mockImplementation(() => order.push("end"));
        const resource = {
            type: "resource" as const,
            epoch: EPOCH,
            kind: "characters",
            id: "c",
            revision: "y",
            data: { chaId: "c" },
        };
        const notice = {
            type: "notice" as const,
            epoch: EPOCH,
            kind: "alertToast" as const,
            payload: { message: "m" },
        };
        const callback = {
            type: "callback" as const,
            epoch: EPOCH,
            id: "cb",
            jobId: "j1",
            name: "editoutput" as const,
            targets: { chatRef: ref, presetId: "", modelPresetId: "", personaId: "" },
            revisions: [],
            payload: { text: "t" },
            deadline: 1,
        };
        // Without a transport nothing can be answered, so channel events are not dispatched.
        transport.applyGenerationEvent("j1", ref, notice);
        transport.applyGenerationEvent("j1", ref, resource, follow);
        transport.applyGenerationEvent("j1", ref, notice, follow);
        transport.applyGenerationEvent("j1", ref, callback, follow);
        transport.applyGenerationEvent("j1", ref, { type: "cancel", epoch: EPOCH, id: "cb" }, follow);
        transport.applyGenerationEvent("j1", ref, { type: "done", epoch: EPOCH, revision: null }, follow);
        // The hydration itself is applied at once; the dispatcher's work follows on its chain.
        expect(stubs.applyHydration).toHaveBeenCalledTimes(1);
        expect(order).toEqual([]);
        await vi.waitFor(() => expect(order).toContain("end"));
        expect(order).toEqual(["hydration:c", "notice", "callback", "cancel", "end"]);
        expect(stubs.handleChannelEvent.mock.calls.map((call) => [call[0], call[2]])).toEqual([
            ["j1", follow],
            ["j1", follow],
            ["j1", follow],
        ]);
        expect(stubs.endJobChannel).toHaveBeenCalledWith("j1");
    });

    it("attaches again to the saved jobs the server still knows in this epoch, forgetting the others", async () => {
        transport.rememberGenerationJob({ chaId: "c", chatId: "k" }, "known");
        transport.rememberGenerationJob({ chaId: "c", chatId: "j" }, "gone");
        transport.rememberGenerationJob({ chaId: "d", chatId: "q" }, "old-epoch");
        stubs.fetch.mockImplementation(async (path) => {
            if (path.startsWith("/api/generations/known")) {
                return json(200, {
                    jobId: "known",
                    kind: "send",
                    characterId: "c",
                    chatId: "k",
                    epoch: EPOCH,
                    state: "running",
                });
            }
            if (path.startsWith("/api/generations/old-epoch")) {
                return json(200, {
                    jobId: "old-epoch",
                    kind: "send",
                    characterId: "d",
                    chatId: "q",
                    epoch: "other",
                    state: "running",
                });
            }
            return json(404, { error: "Generation not found" });
        });
        const seen: [string, unknown, string][] = [];
        const follows = await transport.resumeSavedGenerations((jobId, target, event) =>
            seen.push([jobId, target, event.type]),
        );
        expect(follows).toHaveLength(1);
        expect(transport.savedGenerationJobs()).toEqual({ '["c","k"]': "known" });
        stubs.auth[0].resolve("jwt");
        await flush();
        const [socket] = FakeSocket.instances;
        expect(socket.url).toContain("/api/generations/known/ws");
        socket.open();
        socket.message({ type: "chunk", epoch: EPOCH, messageId: "r", generationId: "g", text: "t", seq: 1 });
        expect(stubs.applyServerGeneration).toHaveBeenCalledWith(
            { chaId: "c", chatId: "k" },
            { jobId: "known", messageId: "r", generationId: "g", text: "t", seq: 1 },
        );
        expect(seen).toEqual([["known", { chaId: "c", chatId: "k" }, "chunk"]]);
        follows[0].close();
    });
});

describe("the job link's diagnostics (request history slice 8)", () => {
    const links = () => stubs.record.mock.calls.map(([input]) => input);

    it("records `attach` once when the socket opens, and `detach` with the close code when it closes before the job's end", async () => {
        const follow = transport.followGenerationJob("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await flush();
        const [socket] = FakeSocket.instances;
        expect(links()).toEqual([]);
        socket.open();
        expect(links()).toEqual([{ kind: "jobLink", phase: "attach", jobId: "j1" }]);
        socket.onclose!({ code: 1006 });
        await expect(follow.closed).resolves.toEqual({ terminal: null });
        expect(links()).toEqual([
            { kind: "jobLink", phase: "attach", jobId: "j1" },
            { kind: "jobLink", phase: "detach", jobId: "j1", code: 1006 },
        ]);
    });

    it("records no detach for the close after the terminal, the caller's close, or a superseding follow", async () => {
        const first = transport.followGenerationJob("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await flush();
        const a = FakeSocket.instances[0];
        a.open();
        a.message({ type: "done", epoch: EPOCH, revision: null });
        await first.closed;
        await flush();
        expect(links()).toEqual([{ kind: "jobLink", phase: "attach", jobId: "j1" }]);

        const second = transport.followGenerationJob("j1", () => {});
        stubs.auth[1].resolve("jwt");
        await flush();
        FakeSocket.instances[1].open();
        second.close();
        await second.closed;
        await flush();
        expect(links()).toHaveLength(2);
        expect(links()[1]).toEqual({ kind: "jobLink", phase: "attach", jobId: "j1" });

        const third = transport.followGenerationJob("j1", () => {});
        stubs.auth[2].resolve("jwt");
        await flush();
        FakeSocket.instances[2].open();
        const fourth = transport.followGenerationJob("j1", () => {});
        await third.closed;
        await flush();
        expect(links()).toHaveLength(3);
        fourth.close();
        stubs.auth[3].resolve("jwt");
        await flush();
        expect(links()).toHaveLength(3);
    });

    it("records `attachFailed` for a close before the socket opened (with the code) and for a failed authentication (without), never after a cancel", async () => {
        const first = transport.followGenerationJob("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await flush();
        FakeSocket.instances[0].onclose!({ code: 1006 });
        await first.closed;
        expect(links()).toEqual([{ kind: "jobLink", phase: "attachFailed", jobId: "j1", code: 1006 }]);
        const second = transport.followGenerationJob("j2", () => {});
        stubs.auth[1].reject(new Error("no auth"));
        await second.closed;
        await flush();
        expect(links()).toEqual([
            { kind: "jobLink", phase: "attachFailed", jobId: "j1", code: 1006 },
            { kind: "jobLink", phase: "attachFailed", jobId: "j2" },
        ]);
        const third = transport.followGenerationJob("j3", () => {});
        third.close();
        stubs.auth[2].reject(new Error("no auth"));
        await flush();
        expect(links()).toHaveLength(2);
    });
});
