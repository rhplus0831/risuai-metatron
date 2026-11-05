import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { type GenerationHooks, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";

// The client transport of server generation jobs (`generationJobs.ts`): the tab's identity and
// saved jobs, the create/status/abort requests and their errors (a status read's deadline), the
// owner socket's lifetime (cancellation before and after authentication, `opened`, supersession,
// stamps, event filtering), its liveness (`socketLiveness.ts`, real: the connect timeout, the
// watchdog, the page's return, a terminal that stands), the event
// dispatcher's wiring, and the resume after a reload. The chat module, the save adapter, and the
// channel dispatcher (`jobChannel.ts`, whose `registeredHooks` fills a create body's `hooks`) are
// stubbed here; the hydration contracts are in `src/ts/storage/tests/resourceSyncHydration.test.ts`.

const EPOCH = "11111111-2222-4333-8444-555555555555";

const stubs = vi.hoisted(() => ({
    /** Pending `getNodeServerProxyAuth` calls, settled by the test. */
    auth: [] as { resolve: (token: string) => void; reject: (error: unknown) => void }[],
    fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
    applyServerGeneration: vi.fn(() => true),
    /** `applyServerGenerationChunk`: false when the chat module lacks the delta's base text. */
    applyServerGenerationChunk: vi.fn<(...args: unknown[]) => boolean>(() => true),
    endServerJob: vi.fn(),
    applyHydration: vi.fn<typeof import("../storage/resourceSync.svelte").applyHydration>(() => true),
    applyPatchHydration: vi.fn<typeof import("../storage/resourceSync.svelte").applyPatchHydration>(() => "applied"),
    /** `flushResources`: the recovery's save of the local work that kept a job chat copy out. */
    flushResources: vi.fn<typeof import("../storage/resourceSync.svelte").flushResources>(async () => ({
        discarded: [],
        refused: [],
    })),
    /** `isChatStale` and `chatHydrationHold`: what the recovery reads of the chat module. */
    isChatStale: vi.fn<() => boolean>(() => false),
    chatHydrationHold: vi.fn<() => "none" | "saving" | "held">(() => "none"),
    registeredHooks: vi.fn<() => Promise<GenerationHooks>>(),
    handleChannelEvent: vi.fn(),
    rememberHydration: vi.fn(),
    rememberJobStreaming: vi.fn(),
    endJobChannel: vi.fn(),
    changeToPreset: vi.fn(),
    /** `recordClientEvent`: the job link's diagnostics. */
    record: vi.fn<(input: unknown) => void>(),
}));

vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: (path: string, init?: RequestInit) => stubs.fetch(path, init),
        getNodeServerProxyAuth: () =>
            new Promise<string>((resolve, reject) => {
                stubs.auth.push({ resolve, reject });
            }),
    }),
);
vi.mock("../storage/chatStore.svelte", async () =>
    (await import("../storage/tests/chatStoreMock")).createChatStoreMock({
        applyServerGeneration: stubs.applyServerGeneration,
        applyServerGenerationChunk: stubs.applyServerGenerationChunk,
        endServerJob: stubs.endServerJob,
        isChatStale: stubs.isChatStale,
        chatHydrationHold: stubs.chatHydrationHold,
    }),
);
vi.mock("../storage/resourceSync.svelte", async () =>
    (await import("../tests/bootMocks")).createBootMock("resourceSync", {
        applyHydration: stubs.applyHydration,
        applyPatchHydration: stubs.applyPatchHydration,
        flushResources: stubs.flushResources,
    }),
);
vi.mock("./jobChannel", () => ({
    registeredHooks: stubs.registeredHooks,
    handleChannelEvent: stubs.handleChannelEvent,
    rememberHydration: stubs.rememberHydration,
    rememberJobStreaming: stubs.rememberJobStreaming,
    endJobChannel: stubs.endJobChannel,
}));
// A job's `preset` event applies the preset through the preset actions module.
vi.mock("../storage/presets.svelte", () => ({ changeToPreset: stubs.changeToPreset }));
vi.mock("../diagnostics/collector", async () =>
    (await import("../diagnostics/tests/collectorMock")).createCollectorMock({
        recordClientEvent: (input: unknown) => stubs.record(input),
    }),
);

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
/** A few microtask turns, for a check under fake timers (`flush` would wait on a faked timer). */
const microtasks = async () => {
    for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve();
    }
};
const settled = async <T>(promise: Promise<T>) =>
    Promise.race([promise.then(() => "settled" as const), flush().then(() => "pending" as const)]);
const json = (status: number, body: unknown) => Response.json(body, { status });
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

let transport: Transport;
let client: Client;

/** The follows a test started: each owns a connect timer and a resume subscription, so the test's end closes them. */
const startedFollows: ReturnType<Transport["followGenerationJob"]>[] = [];
const startFollow: Transport["followGenerationJob"] = (jobId, onEvent, options) => {
    const follow = transport.followGenerationJob(jobId, onEvent, options);
    startedFollows.push(follow);
    return follow;
};

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
    for (const follow of startedFollows.splice(0)) {
        follow.close();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    stubs.isChatStale.mockReset().mockReturnValue(false);
    stubs.chatHydrationHold.mockReset().mockReturnValue("none");
    stubs.flushResources.mockReset().mockResolvedValue({ discarded: [], refused: [] });
    stubs.applyPatchHydration.mockReset().mockReturnValue("applied");
    stubs.applyHydration.mockReset().mockReturnValue(true);
    stubs.applyServerGenerationChunk.mockReset().mockReturnValue(true);
});

describe("handoff transport", () => {
    it("posts a manual handoff for the named job with this tab, the chosen target and the loaded epoch", async () => {
        vi.useFakeTimers();
        stubs.fetch.mockResolvedValue(Response.json({ offered: true }));
        expect(await transport.requestGenerationHandoff("job/one", "chosen-worker")).toBe("offered");
        expect(stubs.fetch).toHaveBeenCalledTimes(1);
        const [path, request] = stubs.fetch.mock.calls[0];
        expect(path).toBe("/api/generations/job%2Fone/handoff");
        expect(request?.method).toBe("POST");
        expect(new Headers(request?.headers).get(RESOURCE_EPOCH_HEADER)).toBe(EPOCH);
        expect(JSON.parse(String(request?.body))).toEqual({
            clientId: transport.generationClientId(),
            target: "chosen-worker",
        });
    });

    it("posts a takeover with this client, treats 409 and 404 as unavailable, and preserves handedOff on reads", async () => {
        vi.useFakeTimers();
        const jobId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        stubs.fetch.mockResolvedValueOnce(json(200, { ticket: "one-use / ticket" }));
        expect(await transport.takeoverGenerationJob(jobId)).toBe("one-use / ticket");
        const [path, request] = stubs.fetch.mock.calls.at(-1)!;
        expect(path).toBe(`/api/generations/${jobId}/takeover`);
        expect(request?.method).toBe("POST");
        expect(JSON.parse(String(request?.body))).toEqual({ clientId: transport.generationClientId() });
        for (const code of [409, 404]) {
            stubs.fetch.mockResolvedValueOnce(json(code, { error: "unavailable" }));
            expect(await transport.takeoverGenerationJob(jobId)).toBeNull();
        }
        stubs.fetch.mockResolvedValueOnce(json(200, { jobId, kind: "send", owned: true, handedOff: true }));
        expect(await transport.readChatGeneration({ chaId: "c", chatId: "k" })).toEqual({
            jobId,
            kind: "send",
            owned: true,
            handedOff: true,
        });
        stubs.fetch.mockResolvedValueOnce(
            json(200, {
                jobId,
                kind: "send",
                characterId: "c",
                chatId: "k",
                state: "running",
                epoch: EPOCH,
                handedOff: true,
            }),
        );
        expect(await transport.readGenerationJob(jobId)).toMatchObject({ jobId, handedOff: true });
        expect(FakeSocket.instances).toHaveLength(0);
    });

    it("attaches with the ticket and uses the latest role for callbacks while ignoring unknown job events", async () => {
        vi.useFakeTimers();
        const ref = { chaId: "c", chatId: "k" };
        const follow = startFollow("worker", (event) => transport.applyGenerationEvent("worker", ref, event, follow), {
            ticket: "ticket / + ?",
        });
        expect(follow.viewing()).toBe(true);
        stubs.auth[0].resolve("jwt");
        await microtasks();
        const ws = FakeSocket.instances[0];
        expect(new URL(ws.url).searchParams.get("ticket")).toBe("ticket / + ?");
        ws.open();
        for (const [fields, role, viewing] of [
            [{ owner: "other", pending: true }, "pending", true],
            [{ owner: "self" }, "owner", false],
            [{ owner: "other" }, "viewer", true],
            [{ owner: "self" }, "owner", false],
        ] as const) {
            ws.message({ type: "handoff", epoch: EPOCH, ...fields });
            expect(follow.role).toBe(role);
            expect(follow.viewing()).toBe(viewing);
            ws.message({
                type: "callback",
                epoch: EPOCH,
                id: `callback-${stubs.handleChannelEvent.mock.calls.length}`,
            });
            await vi.dynamicImportSettled();
            await vi.advanceTimersByTimeAsync(0);
            expect(stubs.handleChannelEvent.mock.calls.at(-1)?.[2].viewing()).toBe(viewing);
        }
        const calls = stubs.handleChannelEvent.mock.calls.length;
        ws.message({ type: "future-job-event", epoch: EPOCH, owner: "other", pending: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(follow.role).toBe("owner");
        expect(follow.viewing()).toBe(false);
        expect(stubs.handleChannelEvent).toHaveBeenCalledTimes(calls);
        expect(stubs.applyServerGeneration).not.toHaveBeenCalled();
        expect(stubs.endServerJob).not.toHaveBeenCalled();
        expect(ws.closeCalls).toBe(0);
        ws.message({ type: "done", epoch: EPOCH, revision: "e:1:2" });
        expect((await follow.closed).terminal?.type).toBe("done");
    });
});

describe("the tab's identity and saved jobs", () => {
    it("creates the client id once per tab and keeps it in sessionStorage", async () => {
        const id = transport.generationClientId();
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(transport.generationClientId()).toBe(id);
        expect(sessionStorage.getItem("risu-generation-client")).toBe(id);
        // A reload: the old page releases the id on pagehide before the next page claims it.
        window.dispatchEvent(new Event("pagehide"));
        vi.resetModules();
        const again: Transport = await import("./generationJobs");
        expect(again.generationClientId()).toBe(id);
    });

    it.each([
        ["copied live page", "generationClientId"],
        ["copied live page", "savedGenerationJobs"],
        ["copied live page", "savedGenerationJobIds"],
        ["reload after pagehide", "savedGenerationJobIds"],
        ["discarded page", "savedGenerationJobIds"],
    ] as const)("isolates copied owners and preserves recovery on a %s reading %s first", async (page, firstRead) => {
        const originalId = transport.generationClientId();
        transport.rememberGenerationJob({ chaId: "c", chatId: "k" }, "active-job");
        const saved = { '["c","k"]': "active-job" };
        if (page === "reload after pagehide") window.dispatchEvent(new Event("pagehide"));

        // Each page gets its own session storage, copied by the browser before its scripts run.
        const values = new Map<string, string>();
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i)!;
            values.set(key, sessionStorage.getItem(key)!);
        }
        const copiedStorage: Storage = {
            get length() {
                return values.size;
            },
            key: (index) => [...values.keys()][index] ?? null,
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => {
                values.set(key, value);
            },
            removeItem: (key) => {
                values.delete(key);
            },
            clear: () => values.clear(),
        };
        vi.stubGlobal("sessionStorage", copiedStorage);
        vi.stubGlobal("window", new EventTarget());
        const discarded = Object.getOwnPropertyDescriptor(document, "wasDiscarded");
        Object.defineProperty(document, "wasDiscarded", { configurable: true, value: page === "discarded page" });
        try {
            vi.resetModules();
            const next: Transport = await import("./generationJobs");
            const copied = page === "copied live page";
            const first = next[firstRead]();
            if (firstRead === "savedGenerationJobIds") expect(first).toEqual(copied ? [] : ["active-job"]);
            if (firstRead === "savedGenerationJobs") expect(first).toEqual(copied ? {} : saved);
            const nextId = next.generationClientId();
            if (copied) expect(nextId).not.toBe(originalId);
            else expect(nextId).toBe(originalId);
            expect(next.generationClientId()).toBe(nextId);
            expect(next.savedGenerationJobs()).toEqual(copied ? {} : saved);
            expect(next.savedGenerationJobIds()).toEqual(copied ? [] : ["active-job"]);
            expect(transport.generationClientId()).toBe(originalId);
            expect(transport.savedGenerationJobs()).toEqual(saved);
        } finally {
            if (discarded) Object.defineProperty(document, "wasDiscarded", discarded);
            else Reflect.deleteProperty(document, "wasDiscarded");
        }
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

    it.each([
        { status: 503, refusal: { error: "The server is not accepting generations now" }, uncertain: true },
        { status: 503, refusal: { error: "The server is shutting down" }, uncertain: true },
        { status: 409, refusal: { error: "chatBusy", jobId: "busy-job" }, uncertain: true },
        { status: 409, refusal: { error: "memoryRebuilding" }, uncertain: true },
        {
            status: 409,
            refusal: { error: "chatBindingIncomplete", problems: [{ field: "personaId", reason: "gone" }] },
            uncertain: true,
        },
        {
            status: 409,
            refusal: { error: "chatLoreOverrideOrphaned", entries: [{ id: "lost", name: "Lost entry" }] },
            uncertain: true,
        },
        { status: 409, refusal: { error: "requestCancelled" }, uncertain: false },
        { status: 409, refusal: { error: "requestIdReused" }, uncertain: false },
        { status: 409, refusal: { error: "stale" }, uncertain: false },
        { status: 409, refusal: { error: "chatBindingMismatch" }, uncertain: false },
        { status: 404, refusal: { error: "Chat not found" }, uncertain: false },
    ])(
        "keeps uncertainty=$uncertain after an unanswered create followed by $status $refusal.error",
        async ({ status, refusal, uncertain }) => {
            vi.useFakeTimers();
            const auth = await import("../storage/serverAuth");
            vi.spyOn(auth, "authFetch").mockImplementation((path, init, options) => {
                options?.beforeDispatch?.();
                return stubs.fetch(path, init);
            });
            const first = deferred<Response>();
            stubs.fetch.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(json(status, refusal));
            const result = transport
                .createGenerationJob({ ...body, requestId: "same-request", hooks: NO_GENERATION_HOOKS })
                .then(
                    () => undefined,
                    (error: unknown) => error,
                );
            await vi.advanceTimersByTimeAsync(0);
            expect(stubs.fetch).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(11_000);
            expect(stubs.fetch).toHaveBeenCalledTimes(2);
            const error = await result;
            const cause = error instanceof transport.GenerationCreateError ? error.cause : error;
            expect(error).toBeInstanceOf(uncertain ? transport.GenerationCreateError : Error);
            expect(error instanceof transport.GenerationCreateError && error.uncertain).toBe(uncertain);
            const expected =
                status === 409 && refusal.error === "chatBusy"
                    ? { name: "GenerationBusyError", jobId: "busy-job" }
                    : refusal.error === "stale"
                      ? { name: "GenerationStaleError" }
                      : refusal.error === "chatBindingIncomplete" || refusal.error === "chatBindingMismatch"
                        ? { name: "ChatBindingRefusedError", code: refusal.error }
                        : refusal.error === "chatLoreOverrideOrphaned"
                          ? { name: "ChatLoreOverrideOrphanedError", entries: refusal.entries }
                          : { name: "ResourceRequestError", status, message: refusal.error };
            expect(cause).toMatchObject(expected);
            expect(stubs.fetch.mock.calls[1][1]!.body).toBe(stubs.fetch.mock.calls[0][1]!.body);
            expect(JSON.parse(String(stubs.fetch.mock.calls[1][1]!.body)).requestId).toBe("same-request");
            first.resolve(json(200, { jobId: "late-job" }));
            await vi.advanceTimersByTimeAsync(0);
        },
    );

    it.each([
        ["lookup", "authentication"],
        ["lookup", "fetch"],
        ["lookup", "body"],
        ["stop", "authentication"],
        ["stop", "fetch"],
        ["stop", "body"],
    ] as const)("bounds the chat %s exchange including stalled %s to ten seconds", async (operation, phase) => {
        vi.useFakeTimers();
        const auth = await import("../storage/serverAuth");
        const authentication = deferred();
        const fetched = deferred<Response>();
        const parsed = deferred<unknown>();
        const response = json(200, {});
        const parse = vi.spyOn(response, "json").mockImplementation(() => parsed.promise);
        const dispatch = vi.fn(() => fetched.promise);
        vi.spyOn(auth, "authFetch").mockImplementation(async () => {
            await authentication.promise;
            return dispatch();
        });
        const observed = vi.fn();
        const request =
            operation === "lookup"
                ? transport.readChatGeneration({ chaId: "c", chatId: "k" })
                : transport.stopChatGeneration({ chaId: "c", chatId: "k" }, "confirmed-job");
        void request.then(observed, observed);
        await vi.advanceTimersByTimeAsync(3_000);
        if (phase !== "authentication") authentication.resolve();
        await vi.advanceTimersByTimeAsync(3_000);
        if (phase === "body") fetched.resolve(response);
        await vi.advanceTimersByTimeAsync(3_999);
        expect(dispatch).toHaveBeenCalledTimes(phase === "authentication" ? 0 : 1);
        expect(parse).toHaveBeenCalledTimes(phase === "body" ? 1 : 0);
        expect(observed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(observed).toHaveBeenCalledExactlyOnceWith(expect.any(client.ResourceRequestError));
        expect(observed.mock.calls[0][0]).toMatchObject({ status: 0 });
        authentication.resolve();
        fetched.resolve(response);
        parsed.resolve(
            operation === "lookup"
                ? { jobId: "confirmed-job", kind: "send", owned: false, state: "running" }
                : { aborted: true },
        );
        await vi.advanceTimersByTimeAsync(0);
    });

    it("never saves, stages or holds a replay owned by another tab", async () => {
        vi.useFakeTimers();
        const { jobStages, chatStageOf } = await import("../process/jobStages");
        const running = {
            jobId: "foreign-job",
            kind: "send",
            characterId: "c",
            chatId: "k",
            epoch: EPOCH,
            state: "running",
        };
        for (const status of [
            running,
            { ...running, state: "ended", terminal: { type: "done", epoch: EPOCH, revision: "r" } },
            null,
        ]) {
            stubs.fetch.mockResolvedValueOnce(
                json(200, { jobId: "foreign-job", replayed: true, owned: false, status }),
            );
            expect(await transport.createGenerationJob({ ...body, hooks: NO_GENERATION_HOOKS })).toMatchObject({
                outcome: "replayed",
                owned: false,
                status,
            });
            expect(transport.savedGenerationJobIds()).toEqual([]);
            expect(sessionStorage.getItem("risu-generation-jobs") ?? "{}").toBe("{}");
            expect(chatStageOf(get(jobStages), { chaId: "c", chatId: "k" })).toBeNull();
            // This public lease includes liveJobs even after creation has settled.
            expect(transport.generationPluginWorkActive()).toBe(false);
        }
    });

    it("sends a request cancellation when stopped during create backoff and sends nothing when stopped before dispatch", async () => {
        vi.useFakeTimers();
        const auth = await import("../storage/serverAuth");
        vi.spyOn(auth, "authFetch").mockImplementation((path, init, options) => {
            options?.beforeDispatch?.();
            return stubs.fetch(path, init);
        });
        const before = new AbortController();
        before.abort();
        expect(
            await transport.createGenerationJob({ ...body, hooks: NO_GENERATION_HOOKS }, { signal: before.signal }),
        ).toEqual({ outcome: "cancelled" });
        expect(stubs.fetch).not.toHaveBeenCalled();
        stubs.fetch
            .mockRejectedValueOnce(new TypeError("answer lost"))
            .mockResolvedValueOnce(json(200, { state: "cancelled" }));
        const stop = new AbortController();
        const creating = transport.createGenerationJob(
            { ...body, requestId: "stop-request", hooks: NO_GENERATION_HOOKS },
            { signal: stop.signal },
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(stubs.fetch).toHaveBeenCalledTimes(1);
        stop.abort();
        expect(await creating).toEqual({ outcome: "cancelled" });
        expect(stubs.fetch.mock.calls.map(([path]) => path)).toEqual(["/api/generations", "/api/generations/cancel"]);
        expect(JSON.parse(String(stubs.fetch.mock.calls[1][1]!.body))).toEqual({
            requestId: "stop-request",
            clientId: transport.generationClientId(),
        });
        await vi.advanceTimersByTimeAsync(7000);
        expect(stubs.fetch).toHaveBeenCalledTimes(2);
        expect(transport.generationPluginWorkActive()).toBe(false);
    });

    it("shows preparing when creation returns, preserves a stage received before the create response, and clears each released job", async () => {
        const { jobStages, chatStageOf } = await import("../process/jobStages");
        const ref = { chaId: body.context.characterId, chatId: body.context.chatId };
        stubs.fetch.mockResolvedValueOnce(json(200, { jobId: "new-job" }));
        await transport.createGenerationJob(body);
        expect(chatStageOf(get(jobStages), ref)).toBe("preparing");
        transport.releaseGenerationJob("new-job");
        expect(chatStageOf(get(jobStages), ref)).toBeNull();

        const requested = deferred();
        const response = deferred<Response>();
        stubs.fetch.mockImplementationOnce(() => {
            requested.resolve();
            return response.promise;
        });
        const creating = transport.createGenerationJob(body);
        await requested.promise;
        transport.applyGenerationEvent("early-stage", ref, { type: "stage", epoch: EPOCH, stage: "memory" });
        response.resolve(json(200, { jobId: "early-stage" }));
        await creating;
        expect(chatStageOf(get(jobStages), ref)).toBe("memory");
        transport.releaseGenerationJob("early-stage");
        expect(chatStageOf(get(jobStages), ref)).toBeNull();
    });

    it("creates a job with the epoch, the client id, and the hooks, remembers it, and maps the refusals to typed errors", async () => {
        // Without a `hooks` list, the body carries the dispatcher's registered hooks.
        const registered: GenerationHooks = { ...NO_GENERATION_HOOKS, scripts: ["editoutput"], mcpTools: ["plugin:t"] };
        stubs.registeredHooks.mockResolvedValueOnce(registered);
        stubs.fetch.mockResolvedValueOnce(json(200, { jobId: "j1" }));
        await expect(transport.createGenerationJob(body)).resolves.toEqual({ outcome: "created", jobId: "j1" });
        const [path, init] = stubs.fetch.mock.calls[0];
        expect(path).toBe("/api/generations");
        expect((init!.headers as Record<string, string>)[RESOURCE_EPOCH_HEADER]).toBe(EPOCH);
        // A body without its own request id gets a fresh one.
        expect(JSON.parse(String(init!.body))).toEqual({
            ...body,
            hooks: registered,
            requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
        // A request without an answer is sent again after 1, 2, and 4 s with the same body and request id,
        // then fails as one whose outcome is not known.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        const before = stubs.fetch.mock.calls.length;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            stubs.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        }
        const unanswered = transport.createGenerationJob({ ...body, hooks: NO_GENERATION_HOOKS }).then(
            () => "answered",
            (error: unknown) => error,
        );
        await microtasks();
        expect(stubs.fetch).toHaveBeenCalledTimes(before + 1);
        for (const [delay, attempts] of [
            [1_000, 2],
            [2_000, 3],
            [4_000, 4],
        ] as const) {
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(stubs.fetch).toHaveBeenCalledTimes(before + attempts - 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(stubs.fetch).toHaveBeenCalledTimes(before + attempts);
        }
        const failed = await unanswered;
        expect(failed).toBeInstanceOf(transport.GenerationCreateError);
        expect(failed).toMatchObject({ uncertain: true, cause: { name: "ResourceRequestError", status: 0 } });
        const sent = stubs.fetch.mock.calls.slice(before).map(([, init]) => String(init!.body));
        expect(new Set(sent).size).toBe(1);
        expect(JSON.parse(sent[0]).requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(stubs.fetch.mock.calls.slice(before).every(([sentPath]) => sentPath === "/api/generations")).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stubs.fetch).toHaveBeenCalledTimes(before + 4);
        // The saved job survives the refusals.
        expect(transport.savedGenerationJobs()).toEqual({ '["c","k"]': "j1" });
    });

    it("parses an orphaned lore override 409 into a typed refusal with all entry ids and names", async () => {
        const entries = [
            { id: "deleted-title", name: "Lost title" },
            { id: "deleted-key", name: "Lost key" },
            { id: "deleted-off", name: "deleted-off" },
        ];
        stubs.fetch.mockResolvedValueOnce(json(409, { error: "chatLoreOverrideOrphaned", entries }));

        const creating = transport.createGenerationJob(body);
        await expect(creating).rejects.toBeInstanceOf(transport.ChatLoreOverrideOrphanedError);
        await expect(creating).rejects.toMatchObject({ entries });
        expect(transport.savedGenerationJobs()).toEqual({});
    });

    it("reads a status (null when the server does not know the job) and aborts (a 404 is fine)", async () => {
        // The Stop is bounded (`boundedAttempt`): a controlled clock, so its deadline never races the test.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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

    it("bounds the owner's Stop to the control deadline: a hanging DELETE is aborted and the stop fails", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        let signal: AbortSignal | null | undefined;
        stubs.fetch.mockImplementationOnce((_path, init) => {
            signal = init?.signal;
            return new Promise<Response>(() => {});
        });
        const outcome = transport.abortGenerationJob("j1").then(
            () => "answered",
            (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(9_999);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const error = await Promise.race([outcome, microtasks().then(() => "pending")]);
        expect(error).toBeInstanceOf(client.ResourceRequestError);
        expect((error as InstanceType<Client["ResourceRequestError"]>).status).toBe(0);
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("bounds a status read to its deadline (the request and its body): past it the request is aborted and the read fails as one without an answer; an answer in time leaves no timer", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        let signal: AbortSignal | null | undefined;
        stubs.fetch.mockImplementationOnce((_path, init) => {
            signal = init?.signal;
            return new Promise<Response>(() => {});
        });
        const outcome = transport.readGenerationJob("j1", { deadlineMs: 10_000 }).then(
            () => "answered",
            (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(9_999);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        // Settled by the deadline's timer, not by any answer.
        const error = await Promise.race([outcome, microtasks().then(() => "pending")]);
        expect(error).toBeInstanceOf(client.ResourceRequestError);
        expect((error as InstanceType<Client["ResourceRequestError"]>).status).toBe(0);
        expect(signal?.aborted).toBe(true);
        // A body that never arrives is bounded too.
        stubs.fetch.mockResolvedValueOnce(
            new Response(new ReadableStream({ start() {} }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        );
        const hanging = transport.readGenerationJob("j1", { deadlineMs: 10_000 }).then(
            () => "answered",
            (error: { status: number }) => error.status,
        );
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await Promise.race([hanging, microtasks().then(() => "pending")])).toBe(0);
        // In time: the status, and the deadline's timer cleared; a 404 is still null.
        stubs.fetch.mockResolvedValueOnce(json(200, { jobId: "j1", state: "running" }));
        await expect(transport.readGenerationJob("j1", { deadlineMs: 10_000 })).resolves.toMatchObject({ jobId: "j1" });
        expect(vi.getTimerCount()).toBe(0);
        stubs.fetch.mockResolvedValueOnce(json(404, { error: "Generation not found" }));
        await expect(transport.readGenerationJob("j1", { deadlineMs: 10_000 })).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        // Without a deadline: no timer at all.
        stubs.fetch.mockResolvedValueOnce(json(200, { jobId: "j1", state: "running" }));
        await transport.readGenerationJob("j1");
        expect(vi.getTimerCount()).toBe(0);
    });

    it("reports a cancelled callback drained to the job's route with the client id, and never fails: a 404 (the job is gone) is silent, any other failure is logged", async () => {
        stubs.fetch.mockResolvedValueOnce(json(200, { drained: true }));
        await expect(transport.reportCallbackDrained("j/1", "cb-1")).resolves.toBeUndefined();
        expect(stubs.fetch.mock.calls[0]).toEqual([
            `/api/generations/j%2F1/drained?clientId=${encodeURIComponent(transport.generationClientId())}`,
            {
                method: "POST",
                cache: "no-store",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ callbackId: "cb-1" }),
            },
        ]);
        const errors = vi.mocked(console.error);
        stubs.fetch.mockResolvedValueOnce(json(404, { error: "Generation not found" }));
        await expect(transport.reportCallbackDrained("j1", "cb-1")).resolves.toBeUndefined();
        expect(errors).not.toHaveBeenCalled();
        stubs.fetch.mockResolvedValueOnce(json(500, { error: "boom" }));
        await expect(transport.reportCallbackDrained("j1", "cb-1")).resolves.toBeUndefined();
        stubs.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        await expect(transport.reportCallbackDrained("j1", "cb-1")).resolves.toBeUndefined();
        expect(errors).toHaveBeenCalledTimes(2);
    });
});

describe("following a job", () => {
    it("advertises patch hydration beside owner liveness and echoes each ping timestamp even across an epoch filter", async () => {
        vi.useFakeTimers();
        const seen = vi.fn();
        const follow = startFollow("j1", seen);
        stubs.auth[0].resolve("jwt");
        await microtasks();
        const [socket] = FakeSocket.instances;
        expect(new URL(socket.url).searchParams.get("liveness")).toBe("1");
        expect(new URL(socket.url).searchParams.get("hydration")).toBe("patch");
        socket.open();
        // The pong uses the server timestamp, not this tab's clock or its loaded resource epoch.
        vi.setSystemTime(new Date("2030-01-01"));
        socket.message({ type: "ping", ts: 17 });
        socket.message({ type: "ping", ts: 29, epoch: "another-epoch" });
        expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
            { type: "pong", ts: 17 },
            { type: "pong", ts: 29 },
        ]);
        expect(seen).not.toHaveBeenCalled();
        follow.close();
        await follow.closed;
    });

    it("ignores unknown job frames without changing the followed job and continues applying later frames", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
        const { jobStages } = await import("../process/jobStages");
        const ref = { chaId: "c", chatId: "k" };
        transport.rememberGenerationJob(ref, "j1");
        const dispatch = vi.fn((event: Parameters<Transport["applyGenerationEvent"]>[2]) =>
            transport.applyGenerationEvent("j1", ref, event),
        );
        const follow = startFollow("j1", dispatch);
        stubs.auth[0].resolve("jwt");
        await vi.advanceTimersByTimeAsync(0);
        const [socket] = FakeSocket.instances;
        socket.open();
        socket.message({ type: "stage", epoch: EPOCH, stage: "generating" });
        expect(() =>
            socket.message({
                type: "future-frame",
                epoch: EPOCH,
                stage: "finishing",
                revision: null,
                data: { bad: true },
            }),
        ).not.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        expect(get(jobStages).get("j1")).toEqual({ chatKey: "c\u0000k", stage: "generating" });
        expect(transport.savedGenerationJobs()).toEqual({ '["c","k"]': "j1" });
        expect(stubs.applyHydration).not.toHaveBeenCalled();
        expect(stubs.applyServerGeneration).not.toHaveBeenCalled();
        expect(stubs.endServerJob).not.toHaveBeenCalled();
        expect(stubs.handleChannelEvent).not.toHaveBeenCalled();
        expect(socket.closeCalls).toBe(0);
        socket.message({ type: "stage", epoch: EPOCH, stage: "finishing" });
        expect(get(jobStages).get("j1")).toEqual({ chatKey: "c\u0000k", stage: "finishing" });
        socket.message({ type: "done", epoch: EPOCH, revision: null });
        await vi.advanceTimersByTimeAsync(0);
        expect(stubs.endServerJob).toHaveBeenCalledExactlyOnceWith("j1");
        expect(transport.savedGenerationJobs()).toEqual({});
    });

    it("drops another epoch's stage before dispatch and keeps the followed job's stage", async () => {
        const { jobStages } = await import("../process/jobStages");
        const ref = { chaId: "c", chatId: "k" };
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        const dispatch = vi.fn((event: Parameters<Transport["applyGenerationEvent"]>[2]) =>
            transport.applyGenerationEvent("j1", ref, event),
        );
        const follow = startFollow("j1", dispatch);
        try {
            stubs.auth[0].resolve("jwt");
            // Not every timer: the follow's connect timeout would give the socket up before it opens.
            await vi.advanceTimersByTimeAsync(0);
            const [socket] = FakeSocket.instances;
            socket.open();

            socket.message({ type: "stage", epoch: "other-epoch", stage: "memory" });
            expect(dispatch).not.toHaveBeenCalled();
            expect(get(jobStages).size).toBe(0);

            socket.message({ type: "stage", epoch: EPOCH, stage: "generating" });
            expect(get(jobStages).get("j1")).toEqual({ chatKey: "c\u0000k", stage: "generating" });
            dispatch.mockClear();

            socket.message({ type: "stage", epoch: "other-epoch", stage: "finishing" });
            expect(dispatch).not.toHaveBeenCalled();
            expect(get(jobStages).get("j1")).toEqual({ chatKey: "c\u0000k", stage: "generating" });
        } finally {
            follow.close();
            await follow.closed;
        }
    });

    it("connects with a fresh JWT, the client id, and an increasing attach stamp; delivers events of this epoch and closes on the terminal", async () => {
        const seen: unknown[] = [];
        const follow = startFollow("j1", (event) => seen.push(event));
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
        expect(url.searchParams.get("rows")).toBe("streamed");
        expect(url.searchParams.get("proto")).toBe("1");
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
        await expect(follow.closed).resolves.toEqual({
            terminal: { type: "done", epoch: EPOCH, revision: null },
            received: true,
        });
        expect(follow.send({ late: true })).toBe(false);
        // Another follow's stamp is higher.
        const next = startFollow("j1", () => {});
        stubs.auth[1].resolve("jwt-2");
        await flush();
        expect(FakeSocket.instances[1].stamp).toBeGreaterThan(socket.stamp);
        next.close();
    });

    it("settles `closed` when cancelled before authentication, and never builds a socket afterwards", async () => {
        const follow = startFollow("j1", () => {});
        expect(await settled(follow.closed)).toBe("pending");
        follow.close();
        await expect(follow.closed).resolves.toEqual({ terminal: null });
        stubs.auth[0].resolve("jwt");
        await flush();
        expect(FakeSocket.instances).toHaveLength(0);
        // A rejected authentication after cancellation is handled too; one that fails on its own
        // ends the follow with no socket.
        const second = startFollow("j2", () => {});
        second.close();
        stubs.auth[1].reject(new Error("no auth"));
        await flush();
        const third = startFollow("j3", () => {});
        stubs.auth[2].reject(new Error("no auth"));
        await expect(third.closed).resolves.toEqual({ terminal: null });
        expect(FakeSocket.instances).toHaveLength(0);
        expect(console.error).toHaveBeenCalled();
    });

    it("settles `opened` true once the socket opens, and false when the follow ends before that: cancelled before authentication, closed while connecting, a failed authentication, or a socket the server closed unopened", async () => {
        const open = startFollow("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await flush();
        expect(await settled(open.opened)).toBe("pending");
        FakeSocket.instances[0].open();
        expect(await settled(open.opened)).toBe("settled");
        await expect(open.opened).resolves.toBe(true);
        FakeSocket.instances[0].onclose!({ code: 1000 });
        await open.closed;
        await expect(open.opened).resolves.toBe(true);

        const early = startFollow("j2", () => {});
        early.close();
        expect(await settled(early.opened)).toBe("settled");
        await expect(early.opened).resolves.toBe(false);
        stubs.auth[1].resolve("jwt");
        await flush();

        const connecting = startFollow("j3", () => {});
        stubs.auth[2].resolve("jwt");
        await flush();
        expect(await settled(connecting.opened)).toBe("pending");
        connecting.close();
        await expect(connecting.opened).resolves.toBe(false);
        await expect(connecting.closed).resolves.toEqual({ terminal: null });

        const unauthenticated = startFollow("j4", () => {});
        stubs.auth[3].reject(new Error("no auth"));
        await expect(unauthenticated.opened).resolves.toBe(false);

        const refused = startFollow("j5", () => {});
        stubs.auth[4].resolve("jwt");
        await flush();
        FakeSocket.instances.at(-1)!.onclose!({ code: 1006 });
        await expect(refused.opened).resolves.toBe(false);
        await expect(refused.closed).resolves.toEqual({ terminal: null });
    });

    it("lets a newer follow of the job supersede an older one, whichever authenticates first, with one usable stream", async () => {
        const seenA: unknown[] = [];
        const seenB: unknown[] = [];
        const a = startFollow("j1", (event) => seenA.push(event));
        const b = startFollow("j1", (event) => seenB.push(event));
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
        const c = startFollow("j1", (event) => seenC.push(event));
        expect(socketB.closeCalls).toBe(1);
        socketB.message({ type: "progress", epoch: EPOCH, payload: "late for b" });
        expect(seenB).toHaveLength(1);
        expect(b.send({})).toBe(false);
        await expect(b.closed).resolves.toEqual({ terminal: null, received: true });
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
        await expect(c.closed).resolves.toEqual({ terminal: null, received: true });
    });

    it("cancels a socket that is still connecting when superseded", async () => {
        const a = startFollow("j1", () => {});
        stubs.auth[0].resolve("jwt-a");
        await flush();
        const socketA = FakeSocket.instances[0];
        expect(socketA.readyState).toBe(FakeSocket.CONNECTING);
        startFollow("j1", () => {});
        expect(socketA.closeCalls).toBe(1);
        await expect(a.closed).resolves.toEqual({ terminal: null });
    });
});

describe("the event dispatcher and the resume", () => {
    const ref = { chaId: "c", chatId: "k" };

    it("shows preparing on accepted until the first stage event, preserves that stage on reaccept, and removes it on release", async () => {
        const { jobStages, chatStageOf } = await import("../process/jobStages");
        const accepted = {
            type: "accepted" as const,
            epoch: EPOCH,
            jobId: "accepted-job",
            revision: "r",
            text: "",
        };
        transport.applyGenerationEvent("accepted-job", ref, accepted);
        expect(chatStageOf(get(jobStages), ref)).toBe("preparing");
        transport.applyGenerationEvent("accepted-job", ref, accepted);
        expect(chatStageOf(get(jobStages), ref)).toBe("preparing");
        transport.applyGenerationEvent("accepted-job", ref, { type: "stage", epoch: EPOCH, stage: "generating" });
        expect(chatStageOf(get(jobStages), ref)).toBe("generating");
        transport.applyGenerationEvent("accepted-job", ref, accepted);
        expect(chatStageOf(get(jobStages), ref)).toBe("generating");
        transport.releaseGenerationJob("accepted-job");
        expect(chatStageOf(get(jobStages), ref)).toBeNull();
    });

    it("drops only the released job's presentation stage, including a followed job's", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        const { jobStages, chatStageOf } = await import("../process/jobStages");
        transport.rememberGenerationJob(ref, "resumed");
        const follow: ReturnType<Transport["followGenerationJob"]> = transport.followGenerationJob("resumed", (event) =>
            transport.applyGenerationEvent("resumed", ref, event, follow),
        );
        try {
            stubs.auth[0].resolve("jwt");
            await vi.advanceTimersByTimeAsync(0);
            const [socket] = FakeSocket.instances;
            socket.open();
            socket.message({ type: "stage", epoch: EPOCH, stage: "generating" });
            const other = { chaId: "other", chatId: "chat" };
            transport.applyGenerationEvent("other-job", other, { type: "stage", epoch: EPOCH, stage: "memory" });
            expect(chatStageOf(get(jobStages), ref)).toBe("generating");

            transport.releaseGenerationJob("resumed");

            expect(chatStageOf(get(jobStages), ref)).toBeNull();
            expect([...get(jobStages)]).toEqual([["other-job", { chatKey: "other\u0000chat", stage: "memory" }]]);
        } finally {
            follow.close();
        }
    });

    it("records stage events under their job and chat, replacing the job's previous stage", async () => {
        const { jobStages } = await import("../process/jobStages");
        transport.applyGenerationEvent("j1", ref, { type: "stage", epoch: EPOCH, stage: "preparing" });
        expect([...get(jobStages)]).toEqual([["j1", { chatKey: "c\u0000k", stage: "preparing" }]]);

        transport.applyGenerationEvent("j1", ref, { type: "stage", epoch: EPOCH, stage: "memory" });
        expect([...get(jobStages)]).toEqual([["j1", { chatKey: "c\u0000k", stage: "memory" }]]);
    });

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
        const chunk = {
            type: "chunk" as const,
            epoch: EPOCH,
            messageId: "r",
            generationId: "g",
            seq: 1,
            base: 0,
            keep: 0,
            text: "one",
        };
        transport.applyGenerationEvent("j1", ref, chunk);
        // `accepted` carries the full text; a chunk is a delta the chat module rebuilds from its held text.
        expect(stubs.applyServerGeneration.mock.calls).toEqual([
            [ref, { jobId: "j1", messageId: "r", generationId: "g", text: "", seq: 0 }],
        ]);
        expect(stubs.applyServerGenerationChunk.mock.calls).toEqual([[ref, "j1", chunk]]);
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

    it("asks the follow for the reply only (`resyncReply`) when a chunk's base is missing, once until an `accepted` re-arms it", () => {
        const follow = { send: vi.fn(() => true) };
        const chunk = (seq: number) => ({
            type: "chunk" as const,
            epoch: EPOCH,
            messageId: "r",
            generationId: "g",
            seq,
            base: seq - 1,
            keep: 0,
            text: "x",
        });
        const accepted = {
            type: "accepted" as const,
            epoch: EPOCH,
            jobId: "j1",
            messageId: "r",
            generationId: "g",
            revision: "x",
            text: "full",
            seq: 3,
        };
        // A chunk the chat module rebuilt asks nothing.
        transport.applyGenerationEvent("j1", ref, chunk(1), follow);
        expect(follow.send).not.toHaveBeenCalled();
        // A missing base asks once; a second miss before an `accepted` asks nothing more.
        stubs.applyServerGenerationChunk.mockReturnValue(false);
        transport.applyGenerationEvent("j1", ref, chunk(2), follow);
        expect(follow.send.mock.calls).toEqual([[{ type: "resyncReply" }]]);
        transport.applyGenerationEvent("j1", ref, chunk(3), follow);
        expect(follow.send).toHaveBeenCalledTimes(1);
        // Without a transport nothing can be asked.
        transport.applyGenerationEvent("j1", ref, chunk(3));
        expect(follow.send).toHaveBeenCalledTimes(1);
        // The full-text `accepted` (the answer) applies whole and re-arms the request.
        transport.applyGenerationEvent("j1", ref, accepted, follow);
        expect(stubs.applyServerGeneration).toHaveBeenLastCalledWith(ref, {
            jobId: "j1",
            messageId: "r",
            generationId: "g",
            text: "full",
            seq: 3,
        });
        transport.applyGenerationEvent("j1", ref, chunk(5), follow);
        expect(follow.send.mock.calls).toEqual([[{ type: "resyncReply" }], [{ type: "resyncReply" }]]);
        // A send the follow could not make (no open socket) does not count as asked: the next miss asks again.
        const closed = { send: vi.fn(() => false) };
        transport.applyGenerationEvent("j1", ref, chunk(6), closed);
        transport.applyGenerationEvent("j1", ref, chunk(7), closed);
        expect(closed.send).toHaveBeenCalledTimes(2);
        // After the job's end nothing more is asked through the follow.
        transport.applyGenerationEvent("j1", ref, { type: "done", epoch: EPOCH, revision: null }, closed);
        transport.applyGenerationEvent("j1", ref, chunk(8), closed);
        expect(closed.send).toHaveBeenCalledTimes(2);
    });

    it("applies a `chatPatch` through the save adapter and remembers only its streaming list for the barrier, and asks the follow for the chat whole once per follow on a mismatch, until a whole job chat arrives on that follow", async () => {
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
        expect(stubs.rememberJobStreaming).toHaveBeenCalledWith("j1", {
            characterId: "c",
            id: "k",
            revision: "x",
            streaming,
        });
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
                    new Promise<Awaited<ReturnType<typeof stubs.flushResources>>>((resolve, reject) => {
                        settle = { resolve: () => resolve({ discarded: [], refused: [] }), reject };
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
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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
            const follow = startFollow("j1", () => {});
            stubs.flushResources.mockRejectedValueOnce(new Error("offline"));
            transport.applyGenerationEvent("j1", ref, patch, follow);
            await microtasks();
            expect(stubs.flushResources).toHaveBeenCalledTimes(1);
            // The recovery's wait, beside the follow's own connect timeout.
            expect(vi.getTimerCount()).toBe(2);
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
            const next = startFollow("j1", () => {});
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

    it("leaves the selection alone on a job's `preset` event: a presetChain pick is the job's own", async () => {
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
        stubs.rememberHydration.mockImplementation((jobId: string, record: { id: string }) =>
            order.push(`hydration:${jobId}:${record.id}`),
        );
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
        // The hydration is kept as the job's own copy (its id first), for that job's callback barriers.
        expect(order).toEqual(["hydration:j1:c", "notice", "callback", "cancel", "end"]);
        expect(stubs.rememberHydration).toHaveBeenCalledWith("j1", {
            kind: "characters",
            id: "c",
            characterId: undefined,
            revision: "y",
            data: { chaId: "c" },
        });
        expect(stubs.handleChannelEvent.mock.calls.map((call) => [call[0], call[2]])).toEqual([
            ["j1", follow],
            ["j1", follow],
            ["j1", follow],
        ]);
        expect(stubs.endJobChannel).toHaveBeenCalledWith("j1");
    });
});

// The follow's liveness (`socketLiveness.ts`, the real module, under fake timers): a socket that does
// not open in time or goes silent is given up as the caller's `close()` would (the job stays live,
// its channel open), the page's return replaces an opened socket (`closed` carries `resumed`), and
// a terminal that arrived stands.
describe("the follow's liveness", () => {
    const ref = { chaId: "c", chatId: "k" };
    const links = () => stubs.record.mock.calls.map(([input]) => input);
    const tick = () => vi.advanceTimersByTimeAsync(0);
    /** Whether a promise settled, without a timer (`settled` waits on a faked one). */
    const state = async <T>(promise: Promise<T>) =>
        Promise.race([promise.then(() => "settled" as const), microtasks().then(() => "pending" as const)]);
    /** What a released job would show: its end told to the chat module and the channel. */
    const released = () => stubs.endServerJob.mock.calls.length + stubs.endJobChannel.mock.calls.length;
    let visibility: MockInstance<() => DocumentVisibilityState>;
    const show = (value: "visible" | "hidden") => {
        visibility.mockReturnValue(value);
        document.dispatchEvent(new Event("visibilitychange"));
    };

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
        visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    });

    it("gives up a socket not open within 10 s of the follow's start, authentication included (`connectTimeout`): `closed` settles without a terminal, the job is not released, a late authentication builds no socket, and one that opened in time is left alone", async () => {
        transport.rememberGenerationJob(ref, "j1");
        const unauthenticated = startFollow("j1", () => {});
        await vi.advanceTimersByTimeAsync(9_999);
        expect(await state(unauthenticated.closed)).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        await expect(unauthenticated.closed).resolves.toEqual({ terminal: null });
        await expect(unauthenticated.opened).resolves.toBe(false);
        expect(links()).toEqual([{ kind: "jobLink", phase: "connectTimeout", jobId: "j1" }]);
        stubs.auth[0].resolve("jwt");
        await tick();
        expect(FakeSocket.instances).toHaveLength(0);
        expect(released()).toBe(0);
        expect(transport.savedGenerationJobs()).toEqual({ '["c","k"]': "j1" });

        // Authenticated at 5 s and still connecting at 10 s: closed, and its own close is no `attachFailed`.
        const connecting = startFollow("j2", () => {});
        await vi.advanceTimersByTimeAsync(5_000);
        stubs.auth[1].resolve("jwt");
        await tick();
        const [socket] = FakeSocket.instances;
        await vi.advanceTimersByTimeAsync(4_999);
        expect(socket.closeCalls).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(socket.closeCalls).toBe(1);
        await expect(connecting.closed).resolves.toEqual({ terminal: null });
        await tick();
        expect(links()).toEqual([
            { kind: "jobLink", phase: "connectTimeout", jobId: "j1" },
            { kind: "jobLink", phase: "connectTimeout", jobId: "j2" },
        ]);

        const opened = startFollow("j3", () => {});
        stubs.auth[2].resolve("jwt");
        await tick();
        FakeSocket.instances[1].open();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await state(opened.closed)).toBe("pending");
        expect(FakeSocket.instances[1].closeCalls).toBe(0);
    });

    it("gives up an opened socket with no frame for 45 s while the page is visible (`stale`): pings keep it alive, a hidden page is not checked, the job is not released", async () => {
        transport.rememberGenerationJob(ref, "j1");
        const follow = startFollow("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await tick();
        const [socket] = FakeSocket.instances;
        socket.open();
        // The server's pings, every 15 s, for a minute: alive.
        for (let ping = 0; ping < 4; ping += 1) {
            await vi.advanceTimersByTimeAsync(15_000);
            socket.message({ type: "ping", ts: ping });
        }
        // Then silence: 40 s of it visible (the checks at 15 and 30 s pass), 20 s hidden (not checked),
        // shown again after a short absence (no return): the next check sees 75 s and gives it up.
        await vi.advanceTimersByTimeAsync(40_000);
        show("hidden");
        await vi.advanceTimersByTimeAsync(20_000);
        expect(socket.closeCalls).toBe(0);
        show("visible");
        await vi.advanceTimersByTimeAsync(14_999);
        expect(socket.closeCalls).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(socket.closeCalls).toBe(1);
        await expect(follow.closed).resolves.toEqual({ terminal: null, received: true });
        await tick();
        expect(links()).toEqual([
            { kind: "jobLink", phase: "attach", jobId: "j1" },
            { kind: "jobLink", phase: "stale", jobId: "j1" },
        ]);
        expect(released()).toBe(0);
        expect(transport.savedGenerationJobs()).toEqual({ '["c","k"]': "j1" });
    });

    it("gives an opened socket up when the page comes back (`resumeReconnect`), `closed` carrying `resumed`; a socket that had not opened closes without it; a follow started after the trigger is left alone", async () => {
        transport.rememberGenerationJob(ref, "j1");
        const opened = startFollow("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await tick();
        FakeSocket.instances[0].open();
        show("hidden");
        await vi.advanceTimersByTimeAsync(30_000);
        const connecting = startFollow("j2", () => {});
        stubs.auth[1].resolve("jwt");
        await tick();
        show("visible");
        await vi.advanceTimersByTimeAsync(249);
        expect(await state(opened.closed)).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        await expect(opened.closed).resolves.toEqual({ terminal: null, resumed: true });
        await expect(connecting.closed).resolves.toEqual({ terminal: null });
        expect(FakeSocket.instances.map((socket) => socket.closeCalls)).toEqual([1, 1]);
        await tick();
        expect(links()).toEqual([
            { kind: "jobLink", phase: "attach", jobId: "j1" },
            { kind: "jobLink", phase: "resumeReconnect", jobId: "j1" },
            { kind: "jobLink", phase: "resumeReconnect", jobId: "j2" },
        ]);
        expect(released()).toBe(0);
        expect(transport.savedGenerationJobs()).toEqual({ '["c","k"]': "j1" });

        // The caller's next attach, started inside the return's window, is not given up by it.
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(100);
        const next = startFollow("j1", () => {});
        await vi.advanceTimersByTimeAsync(150);
        expect(await state(next.closed)).toBe("pending");
        expect(links()).toHaveLength(3);
    });

    it("leaves a socket that fell silent while the page was away to the page's return when the stale check runs inside the return's window: `closed` carries `resumed`, no `stale`", async () => {
        const follow = startFollow("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await tick();
        const [socket] = FakeSocket.instances;
        socket.open();
        socket.message({ type: "ping", ts: 0 });
        await vi.advanceTimersByTimeAsync(5_000);
        show("hidden");
        await vi.advanceTimersByTimeAsync(54_900);
        // Shown again 100 ms before the check that finds 60 s of silence: a thawed page's overdue check.
        show("visible");
        await vi.advanceTimersByTimeAsync(100);
        expect(await state(follow.closed)).toBe("pending");
        expect(socket.closeCalls).toBe(0);
        await vi.advanceTimersByTimeAsync(150);
        await expect(follow.closed).resolves.toEqual({ terminal: null, resumed: true, received: true });
        await tick();
        expect(links()).toEqual([
            { kind: "jobLink", phase: "attach", jobId: "j1" },
            { kind: "jobLink", phase: "resumeReconnect", jobId: "j1" },
        ]);
    });

    it("leaves a follow whose terminal arrived alone: neither the page's return nor the silence after it gives the socket up before its close, and `closed` carries the terminal", async () => {
        const follow = startFollow("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await tick();
        const [socket] = FakeSocket.instances;
        socket.open();
        // The close handshake after the terminal never ends (a frozen link).
        socket.close = () => {
            socket.closeCalls += 1;
        };
        const done = { type: "done", epoch: EPOCH, revision: null };
        socket.message(done);
        expect(socket.closeCalls).toBe(1);
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await state(follow.closed)).toBe("pending");
        expect(socket.closeCalls).toBe(1);
        expect(links()).toEqual([{ kind: "jobLink", phase: "attach", jobId: "j1" }]);
        socket.onclose!({ code: 1000 });
        await expect(follow.closed).resolves.toEqual({ terminal: done, received: true });
    });
});

describe("the job link's diagnostics", () => {
    const links = () => stubs.record.mock.calls.map(([input]) => input);

    it("records `attach` once when the socket opens, and `detach` with the close code when it closes before the job's end", async () => {
        const follow = startFollow("j1", () => {});
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
        const first = startFollow("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await flush();
        const a = FakeSocket.instances[0];
        a.open();
        a.message({ type: "done", epoch: EPOCH, revision: null });
        await first.closed;
        await flush();
        expect(links()).toEqual([{ kind: "jobLink", phase: "attach", jobId: "j1" }]);

        const second = startFollow("j1", () => {});
        stubs.auth[1].resolve("jwt");
        await flush();
        FakeSocket.instances[1].open();
        second.close();
        await second.closed;
        await flush();
        expect(links()).toHaveLength(2);
        expect(links()[1]).toEqual({ kind: "jobLink", phase: "attach", jobId: "j1" });

        const third = startFollow("j1", () => {});
        stubs.auth[2].resolve("jwt");
        await flush();
        FakeSocket.instances[2].open();
        const fourth = startFollow("j1", () => {});
        await third.closed;
        await flush();
        expect(links()).toHaveLength(3);
        fourth.close();
        stubs.auth[3].resolve("jwt");
        await flush();
        expect(links()).toHaveLength(3);
    });

    it("records `attachFailed` for a close before the socket opened (with the code) and for a failed authentication (without), never after a cancel", async () => {
        const first = startFollow("j1", () => {});
        stubs.auth[0].resolve("jwt");
        await flush();
        FakeSocket.instances[0].onclose!({ code: 1006 });
        await first.closed;
        expect(links()).toEqual([{ kind: "jobLink", phase: "attachFailed", jobId: "j1", code: 1006 }]);
        const second = startFollow("j2", () => {});
        stubs.auth[1].reject(new Error("no auth"));
        await second.closed;
        await flush();
        expect(links()).toEqual([
            { kind: "jobLink", phase: "attachFailed", jobId: "j1", code: 1006 },
            { kind: "jobLink", phase: "attachFailed", jobId: "j2" },
        ]);
        const third = startFollow("j3", () => {});
        third.close();
        stubs.auth[2].reject(new Error("no auth"));
        await flush();
        expect(links()).toHaveLength(2);
    });
});
