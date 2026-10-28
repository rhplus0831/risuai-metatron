import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain, refJ, refK, SAVE_DEBOUNCE_MS, warmMutationGraph } from "./mutationStoresHarness";
import type { StoreBackedServer } from "./storeBackedServer";

const { server, alerts, diagnostics } = vi.hoisted(() => ({
    server: { current: null as StoreBackedServer | null },
    alerts: { error: vi.fn(), reload: vi.fn() },
    diagnostics: { record: vi.fn() },
}));

vi.mock("../serverAuth", async () =>
    (await import("./serverAuthMock")).createServerAuthMock({
        authFetch: (path, init) => server.current!.fetch(path, init),
    }),
);
vi.mock("../../alert", async () =>
    (await import("../../tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertReloadNotice: alerts.reload,
    }),
);
vi.mock("../../diagnostics/collector", async () =>
    (await import("../../diagnostics/tests/collectorMock")).createCollectorMock({
        recordClientEvent: diagnostics.record,
    }),
);

type Harness = Awaited<ReturnType<typeof bootMutations>>;

async function boot() {
    vi.resetModules();
    // Each boot owns its lifecycle handlers; no earlier graph may save into this test's server.
    const windowListeners = vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    const documentListeners = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    try {
        return await bootMutations((fake) => {
            server.current = fake;
        });
    } finally {
        windowListeners.mockRestore();
        documentListeners.mockRestore();
    }
}

function announceChat({ fake, sync }: Harness) {
    fake.chatBatch([
        {
            characterId: "c",
            chatId: "k",
            baseRevision: fake.chat("c", "k")!.revision,
            ops: [{ op: "meta", set: { note: "remote" } }],
        },
    ]);
    sync.noteRemoteChanges({
        resources: [],
        chats: [{ characterId: "c", id: "k", revision: fake.chat("c", "k")!.revision }],
        chatOrders: [],
    });
}

/** A response latch at the same HTTP boundary as the other adapter suites. */
function holdRead(fake: StoreBackedServer) {
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
        release = resolve;
    });
    const held = { started: false, signal: undefined as AbortSignal | undefined, release };
    const fetch = fake.fetch;
    vi.spyOn(fake, "fetch").mockImplementation(async (path, init) => {
        const result = fetch(path, init);
        if (path === "/api/resources/read" && !held.started) {
            held.started = true;
            held.signal = init?.signal ?? undefined;
            await response;
        }
        return result;
    });
    return held;
}

/** Observe a barrier without awaiting it: a regression must fail an assertion, not hang the test. */
function observe<T>(promise: Promise<T>) {
    const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
    void promise.then(
        (value) => {
            state.value = value;
            state.settled = true;
        },
        (error) => {
            state.error = error;
            state.settled = true;
        },
    );
    return state;
}

const reads = (fake: StoreBackedServer) => fake.requests.filter((request) => request.path === "/api/resources/read");

beforeAll(() => warmMutationGraph(), 60_000);
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("location", { reload: vi.fn() });
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

describe("background resource refreshes", () => {
    it("saves another chat and settings while a deferred chat reload is unanswered", async () => {
        const h = await boot();
        const { fake, sync, chat, settings } = h;
        chat.applyServerGeneration(refK, { jobId: "job", messageId: "a", generationId: "g", text: "streamed", seq: 0 });
        announceChat(h);
        chat.removeMessages(refK, ["b", "c"]);
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        const held = holdRead(fake);
        chat.endServerJob("job");
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(held.started).toBe(true);

        chat.setChatMeta(refJ, { note: "saved beside a read" });
        settings.ui.theme = "saved beside a read";
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(fake.chat("c", "j")!.data.note).toBe("saved beside a read");
        expect(fake.record("ui", "main")!.data.theme).toBe("saved beside a read");
        expect(chat.findChat(refK)!.message).toHaveLength(1);

        held.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(chat.findChat(refK)!.message.map((message) => message.data)).toEqual(["A", "B", "C"]);
        expect(alerts.reload).toHaveBeenCalled();
    });

    it("backs off failed reads while edits save on the normal debounce and flush ignores their failures", async () => {
        const h = await boot();
        const { fake, sync, chat, settings } = h;
        fake.failNext = { status: 500, times: 12, match: (path) => path === "/api/resources/read" };
        announceChat(h);
        await vi.advanceTimersByTimeAsync(50);
        expect(reads(fake)).toHaveLength(1);
        settings.ui.theme = "saved during read backoff";
        chat.setChatMeta(refJ, { note: "also saved" });
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(reads(fake)).toHaveLength(1);
        expect(fake.record("ui", "main")!.data.theme).toBe("saved during read backoff");
        expect(fake.chat("c", "j")!.data.note).toBe("also saved");
        fake.holdNextBatchResponse = true;
        settings.ui.theme = "flushed during read backoff";
        const flushed = observe(sync.flushResources());
        await vi.advanceTimersByTimeAsync(0);
        expect(fake.record("ui", "main")!.data.theme).toBe("flushed during read backoff");
        expect(fake.releaseBatchResponse).not.toBeNull();

        // More than the flush's ten write attempts: none of these unrelated failures may spend one.
        // Thirty seconds is the documented maximum refresh backoff, all on the fake clock.
        await vi.advanceTimersByTimeAsync(12 * 30_000);
        expect(reads(fake)).toHaveLength(13);
        expect(chat.findChat(refK)!.note).toBe("remote");
        expect(flushed.settled).toBe(false);
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(0);
        expect(flushed).toEqual({ settled: true, value: { discarded: [], refused: [] }, error: undefined });
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it.each(["record", "chat"] as const)(
        "recovers a dirty noticed %s through 409 after a failed refresh and a refused write",
        async (kind) => {
            const h = await boot();
            const { fake, sync, chat, settings } = h;
            const statuses: number[] = [];
            const fetch = fake.fetch;
            vi.spyOn(fake, "fetch").mockImplementation(async (path, init) => {
                const response = await fetch(path, init);
                if (path === "/api/resources/batch") {
                    statuses.push(response.status);
                }
                return response;
            });
            fake.failNext = { status: 500, times: 1, match: (path) => path === "/api/resources/read" };
            if (kind === "record") {
                fake.set("ui", "main", { ...fake.record("ui", "main")!.data, theme: "remote" });
                sync.noteRemoteChanges({
                    resources: [{ kind: "ui", id: "main", revision: fake.record("ui", "main")!.revision }],
                    chats: [],
                    chatOrders: [],
                });
            } else {
                announceChat(h);
            }
            await vi.advanceTimersByTimeAsync(50);
            expect(reads(fake)).toHaveLength(1);
            const edit = (text: string) => {
                if (kind === "record") {
                    settings.ui.theme = text;
                } else {
                    chat.replaceChat(refK, { ...plain(chat.findChat(refK)), note: text });
                }
            };
            fake.failNext = {
                status: 400,
                times: 1,
                match: (path) => path === "/api/resources/batch",
                body: { error: kind === "record" ? "ops[0] is refused" : "chats[0] is refused" },
            };
            edit("refused local edit");
            await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
            expect(statuses).toEqual([400]);
            expect(sync.refusedItems()).toHaveLength(1);
            expect(alerts.error).toHaveBeenCalled();
            alerts.reload.mockClear();

            edit("retry local edit");
            const flushed = observe(sync.flushResources());
            await vi.advanceTimersByTimeAsync(0);
            expect(statuses).toEqual([400, 409]);
            expect(flushed).toEqual({
                settled: true,
                value: { discarded: [kind === "record" ? "ui/main" : "chats/c/k"], refused: [] },
                error: undefined,
            });
            expect(kind === "record" ? settings.ui.theme : chat.findChat(refK)!.note).toBe("remote");
            expect(kind === "record" ? fake.record("ui", "main")!.data.theme : fake.chat("c", "k")!.data.note).toBe(
                "remote",
            );
            expect(alerts.reload).toHaveBeenCalledTimes(1);
        },
    );

    it("flushes captured generations at their acknowledgements without waiting for an idle read", async () => {
        const h = await boot();
        const { fake, sync, settings } = h;
        const held = holdRead(fake);
        announceChat(h);
        await vi.advanceTimersByTimeAsync(50);
        expect(held.started).toBe(true);
        fake.holdNextBatchResponse = true;
        settings.ui.theme = "first generation";
        const first = observe(sync.flushResources());
        await vi.advanceTimersByTimeAsync(0);
        expect(fake.releaseBatchResponse).not.toBeNull();
        expect(first.settled).toBe(false);

        settings.ui.theme = "second generation";
        const second = observe(sync.flushResources());
        await vi.advanceTimersByTimeAsync(0);
        fake.holdNextBatchResponse = true;
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(0);
        expect(first).toEqual({ settled: true, value: { discarded: [], refused: [] }, error: undefined });
        expect(second.settled).toBe(false);
        expect(fake.record("ui", "main")!.data.theme).toBe("second generation");
        expect(fake.releaseBatchResponse).not.toBeNull();
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(0);
        expect(second).toEqual({ settled: true, value: { discarded: [], refused: [] }, error: undefined });
        held.release();
        await vi.advanceTimersByTimeAsync(0);
    });

    it("aborts a stuck read at twenty seconds and applies the retried refresh", async () => {
        const h = await boot();
        const { fake, chat } = h;
        const held = holdRead(fake);
        announceChat(h);
        await vi.advanceTimersByTimeAsync(50);
        expect(held.started).toBe(true);
        expect(held.signal).toBeDefined();
        await vi.advanceTimersByTimeAsync(19_999);
        expect(held.signal!.aborted).toBe(false);
        expect(chat.findChat(refK)!.note).toBe("");
        await vi.advanceTimersByTimeAsync(1);
        expect(held.signal!.aborted).toBe(true);
        expect(reads(fake)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(reads(fake)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(reads(fake)).toHaveLength(2);
        expect(chat.findChat(refK)!.note).toBe("remote");
        held.release();
        await vi.advanceTimersByTimeAsync(0);
    });

    it.each([1_000, 3_000])(
        "reports saveWait only for writes held over two seconds by an in-flight write (%i ms)",
        async (waitMs) => {
            const { fake, sync, settings, chat } = await boot();
            fake.holdNextBatchResponse = true;
            settings.ui.theme = "first";
            const first = observe(sync.flushResources());
            await vi.advanceTimersByTimeAsync(0);
            expect(fake.releaseBatchResponse).not.toBeNull();
            settings.ui.theme = "delayed";
            chat.setChatMeta(refJ, { note: "delayed" });
            chat.reorderChats("c", ["j", "k"]);
            await vi.advanceTimersByTimeAsync(waitMs);
            fake.releaseBatchResponse!();
            await vi.advanceTimersByTimeAsync(0);
            expect(first.error).toBeUndefined();
            await sync.flushResources();
            expect(fake.record("ui", "main")!.data.theme).toBe("delayed");
            expect(fake.chat("c", "j")!.data.note).toBe("delayed");
            const events = diagnostics.record.mock.calls
                .map(([event]) => event)
                .filter((event) => event.phase === "saveWait");
            expect(events).toEqual(
                waitMs > 2_000
                    ? [
                          {
                              kind: "sync",
                              phase: "saveWait",
                              reason: "inFlight",
                              records: 1,
                              chats: 1,
                              orders: 1,
                              durationMs: waitMs,
                          },
                      ]
                    : [],
            );
        },
    );
});
