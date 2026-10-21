import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GenerationHooks, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";

// The jobs' plugin-work lease (`plugins-mcp.md` Flows step 6): a reload after a remote plugin
// change waits while `generationPluginWorkActive()` and hears each change through
// `onGenerationPluginWork`. A job is held from its creation request (before the hooks are listed)
// or its follow until `releaseGenerationJob`; a saved job counts; each busy attempt holds its own
// reservation until its own status read answers, and a late read promotes nothing after the
// release; a queued channel event is held until the dispatcher ran it; the channel's running
// callbacks are reported through `noteChannelCallbacks`. The same stubs as
// `generationJobs.test.ts`.

const EPOCH = "11111111-2222-4333-8444-555555555555";

const stubs = vi.hoisted(() => ({
    auth: [] as { resolve: (token: string) => void; reject: (error: unknown) => void }[],
    fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
    registeredHooks: vi.fn<() => Promise<GenerationHooks>>(),
    handleChannelEvent: vi.fn(),
    rememberHydration: vi.fn(),
    endJobChannel: vi.fn(),
}));

vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => stubs.fetch(path, init),
    getNodeServerProxyAuth: () =>
        new Promise<string>((resolve, reject) => {
            stubs.auth.push({ resolve, reject });
        }),
}));
vi.mock("../storage/chatStore.svelte", () => ({
    applyServerGeneration: vi.fn(() => true),
    applyServerGenerationChunk: vi.fn(() => true),
    endServerJob: vi.fn(),
    isChatStale: vi.fn(() => false),
    chatHydrationHold: vi.fn(() => "none"),
}));
vi.mock("../storage/resourceSync.svelte", () => ({
    applyHydration: vi.fn(() => true),
    applyPatchHydration: vi.fn(() => "applied"),
    flushResources: vi.fn(async () => ({ discarded: [] })),
}));
vi.mock("./jobChannel", () => ({
    registeredHooks: stubs.registeredHooks,
    handleChannelEvent: stubs.handleChannelEvent,
    rememberHydration: stubs.rememberHydration,
    endJobChannel: stubs.endJobChannel,
}));
vi.mock("../storage/presets.svelte", () => ({ changeToPreset: vi.fn() }));
vi.mock("../diagnostics/collector", () => ({ recordClientEvent: vi.fn() }));

type Transport = typeof import("./generationJobs");

class FakeSocket {
    static instances: FakeSocket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    constructor(readonly url: string) {
        FakeSocket.instances.push(this);
    }
    open() {
        this.onopen?.();
    }
    message(event: unknown) {
        this.onmessage?.({ data: JSON.stringify(event) });
    }
    send() {}
    close() {
        queueMicrotask(() => this.onclose?.({ code: 1000 }));
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const json = (status: number, body: unknown) => Response.json(body, { status });
const ref = { chaId: "c", chatId: "k" };
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
const busy = (jobId: string) => json(409, { error: "chatBusy", jobId });
const status = (jobId: string, state: "running" | "ended", epoch = EPOCH) =>
    json(200, { jobId, kind: "send", characterId: "c", chatId: "k", epoch, state });

let transport: Transport;
let active: () => boolean;
let listener: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
    vi.resetModules();
    stubs.auth.length = 0;
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { protocol: "https:", host: "risu.test" });
    sessionStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubs.registeredHooks.mockResolvedValue(NO_GENERATION_HOOKS);
    const client = await import("../storage/resourceClient");
    client.setResourceEpoch(EPOCH);
    transport = await import("./generationJobs");
    active = () => transport.generationPluginWorkActive();
    listener = vi.fn<() => void>();
    transport.onGenerationPluginWork(listener);
    expect(active()).toBe(false);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("a job of this tab", () => {
    it("is held from before its hooks are listed, through the creation request, until its release", async () => {
        const hooks = deferred<GenerationHooks>();
        stubs.registeredHooks.mockReturnValueOnce(hooks.promise);
        const answer = deferred<Response>();
        stubs.fetch.mockReturnValueOnce(answer.promise);

        const creating = transport.createGenerationJob(body);
        expect(active()).toBe(true);
        expect(stubs.fetch).not.toHaveBeenCalled();
        hooks.resolve(NO_GENERATION_HOOKS);
        await flush();
        expect(stubs.fetch).toHaveBeenCalledTimes(1);
        expect(active()).toBe(true);

        answer.resolve(json(200, { jobId: "j1" }));
        await expect(creating).resolves.toBe("j1");
        expect(active()).toBe(true);
        // The saved copy is one hold, the created job another: forgetting the save keeps it held.
        transport.forgetGenerationJob("j1");
        expect(active()).toBe(true);

        listener.mockClear();
        transport.releaseGenerationJob("j1");
        expect(active()).toBe(false);
        expect(listener).toHaveBeenCalled();
    });

    it("holds nothing after a refused or failed creation", async () => {
        stubs.fetch.mockResolvedValueOnce(json(409, { error: "stale" }));
        await expect(transport.createGenerationJob(body)).rejects.toMatchObject({ name: "GenerationStaleError" });
        expect(active()).toBe(false);
        stubs.fetch.mockRejectedValueOnce(new Error("offline"));
        await expect(transport.createGenerationJob(body)).rejects.toMatchObject({ status: 0 });
        expect(active()).toBe(false);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("is held while saved for this tab (a reload resumes it)", () => {
        transport.rememberGenerationJob(ref, "j7");
        expect(active()).toBe(true);
        transport.releaseGenerationJob("j7");
        expect(active()).toBe(false);
    });

    it("is held from its follow until its terminal event releases it", async () => {
        const follow = transport.followGenerationJob("j1", (event) =>
            transport.applyGenerationEvent("j1", ref, event, follow),
        );
        expect(active()).toBe(true);
        stubs.auth[0].resolve("token");
        await flush();
        const socket = FakeSocket.instances[0];
        socket.open();
        listener.mockClear();
        socket.message({ type: "done", epoch: EPOCH, revision: null });
        await flush();
        expect(active()).toBe(false);
        expect(listener).toHaveBeenCalled();
        await expect(follow.closed).resolves.toEqual({ terminal: { type: "done", epoch: EPOCH, revision: null } });
    });
});

describe("a busy job this tab may own", () => {
    it("holds one reservation per attempt, each decided by its own status read", async () => {
        stubs.fetch.mockResolvedValueOnce(busy("j9")).mockResolvedValueOnce(busy("j9"));
        await expect(transport.createGenerationJob(body)).rejects.toMatchObject({ name: "GenerationBusyError" });
        await expect(transport.createGenerationJob(body)).rejects.toMatchObject({ name: "GenerationBusyError" });
        expect(active()).toBe(true);

        const first = deferred<Response>();
        const second = deferred<Response>();
        stubs.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const readA = transport.readGenerationJob("j9");
        const readB = transport.readGenerationJob("j9");

        // The first attempt's read fails: the second attempt still holds its reservation.
        first.reject(new Error("offline"));
        await expect(readA).rejects.toMatchObject({ status: 0 });
        expect(active()).toBe(true);

        // The second read confirms a running job of this tab: held until released.
        second.resolve(status("j9", "running"));
        await expect(readB).resolves.toMatchObject({ state: "running" });
        expect(active()).toBe(true);
        transport.releaseGenerationJob("j9");
        expect(active()).toBe(false);
    });

    it("is dropped when the read says it is not this tab's, ended, or of another epoch", async () => {
        for (const answer of [json(404, { error: "unknown" }), status("j9", "ended"), status("j9", "running", "old")]) {
            stubs.fetch.mockResolvedValueOnce(busy("j9"));
            await expect(transport.createGenerationJob(body)).rejects.toMatchObject({ name: "GenerationBusyError" });
            expect(active()).toBe(true);
            stubs.fetch.mockResolvedValueOnce(answer);
            await transport.readGenerationJob("j9");
            expect(active()).toBe(false);
        }
    });

    it("is not resurrected by a status read that answers after the job was released", async () => {
        stubs.fetch.mockResolvedValueOnce(busy("j9"));
        await expect(transport.createGenerationJob(body)).rejects.toMatchObject({ name: "GenerationBusyError" });
        const answer = deferred<Response>();
        stubs.fetch.mockReturnValueOnce(answer.promise);
        const read = transport.readGenerationJob("j9");
        expect(active()).toBe(true);

        // The job's terminal event (its follow) releases everything held for it, the reservation included.
        transport.releaseGenerationJob("j9");
        expect(active()).toBe(false);
        answer.resolve(status("j9", "running"));
        await expect(read).resolves.toMatchObject({ state: "running" });
        expect(active()).toBe(false);
    });

    it("promotes nothing from a status read without a reservation (a follow's own read)", async () => {
        stubs.fetch.mockResolvedValueOnce(status("j5", "running"));
        await expect(transport.readGenerationJob("j5")).resolves.toMatchObject({ state: "running" });
        expect(active()).toBe(false);
    });
});

describe("the channel's work", () => {
    const callback = {
        type: "callback" as const,
        epoch: EPOCH,
        jobId: "j1",
        id: "cb-1",
        name: "provider" as const,
        targets: { chatRef: ref, presetId: "p", modelPresetId: "m", personaId: null },
        revisions: [],
        payload: {},
        deadline: 0,
    };
    const channel = { send: () => true };

    it("holds a queued channel event until the dispatcher ran it, even when the run fails", async () => {
        transport.applyGenerationEvent("j1", ref, callback, channel);
        expect(active()).toBe(true);
        await flush();
        expect(stubs.handleChannelEvent).toHaveBeenCalledTimes(1);
        expect(active()).toBe(false);
        expect(listener).toHaveBeenCalled();

        stubs.handleChannelEvent.mockImplementationOnce(() => {
            throw new Error("dispatch failed");
        });
        transport.applyGenerationEvent("j1", ref, callback, channel);
        expect(active()).toBe(true);
        await flush();
        expect(active()).toBe(false);
    });

    it("keeps a callback queued before the job's terminal held until it was dispatched", async () => {
        transport.followGenerationJob("j1", () => {});
        transport.applyGenerationEvent("j1", ref, callback, channel);
        // The terminal releases the job at once; the queued callback still reaches the dispatcher.
        transport.releaseGenerationJob("j1");
        expect(active()).toBe(true);
        await flush();
        expect(stubs.handleChannelEvent).toHaveBeenCalledTimes(1);
        expect(stubs.endJobChannel).toHaveBeenCalledWith("j1");
        expect(active()).toBe(false);
    });

    it("holds while the channel reports running callbacks, notifying on each change", () => {
        transport.noteChannelCallbacks(1);
        expect(active()).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
        transport.noteChannelCallbacks(1);
        expect(listener).toHaveBeenCalledTimes(1);
        transport.noteChannelCallbacks(0);
        expect(active()).toBe(false);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("stops notifying an unsubscribed listener", () => {
        const other = vi.fn();
        const off = transport.onGenerationPluginWork(other);
        transport.noteChannelCallbacks(2);
        expect(other).toHaveBeenCalledTimes(1);
        off();
        transport.noteChannelCallbacks(0);
        expect(other).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
