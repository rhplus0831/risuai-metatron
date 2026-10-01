import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";

// The client transport of server generation jobs (`generationJobs.ts`): the tab's identity and
// saved jobs, the create/status/abort requests and their errors, the owner socket's lifetime
// (cancellation before and after authentication, supersession, stamps, event filtering), the event
// dispatcher's wiring, and the resume after a reload. The chat module and the save adapter are
// stubbed here; their hydration contracts are in `src/ts/storage/tests/resourceSyncHydration.test.ts`.

const EPOCH = "11111111-2222-4333-8444-555555555555";

const stubs = vi.hoisted(() => ({
    /** Pending `getNodeServerProxyAuth` calls, settled by the test. */
    auth: [] as { resolve: (token: string) => void; reject: (error: unknown) => void }[],
    fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
    applyServerGeneration: vi.fn(() => true),
    endServerJob: vi.fn(),
    applyHydration: vi.fn(() => true),
}));

vi.mock("../storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => stubs.fetch(path, init),
    getNodeServerProxyAuth: () =>
        new Promise<string>((resolve, reject) => {
            stubs.auth.push({ resolve, reject });
        }),
}));
vi.mock("../storage/chatStore.svelte", () => ({
    applyServerGeneration: stubs.applyServerGeneration,
    endServerJob: stubs.endServerJob,
}));
vi.mock("../storage/resourceSync.svelte", () => ({ applyHydration: stubs.applyHydration }));

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
    client = await import("../storage/resourceClient");
    client.setResourceEpoch(EPOCH);
    transport = await import("./generationJobs");
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
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
            personaId: null,
            mode: "normal",
            input: "",
            chatRevision: "r",
        },
    };

    it("creates a job with the epoch and the client id, remembers it, and maps the refusals to typed errors", async () => {
        stubs.fetch.mockResolvedValueOnce(json(200, { jobId: "j1" }));
        await expect(transport.createGenerationJob(body)).resolves.toBe("j1");
        const [path, init] = stubs.fetch.mock.calls[0];
        expect(path).toBe("/api/generations");
        expect((init!.headers as Record<string, string>)[RESOURCE_EPOCH_HEADER]).toBe(EPOCH);
        expect(JSON.parse(String(init!.body))).toEqual({ ...body, clientId: transport.generationClientId() });
        expect(transport.savedGenerationJobs()).toEqual({ '["c","k"]': "j1" });

        stubs.fetch.mockResolvedValueOnce(json(409, { error: "chatBusy", jobId: "j9" }));
        await expect(transport.createGenerationJob(body)).rejects.toMatchObject({
            name: "GenerationBusyError",
            jobId: "j9",
        });
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
