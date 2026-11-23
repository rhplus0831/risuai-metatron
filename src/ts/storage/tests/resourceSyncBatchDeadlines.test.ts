import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { parseRevisionToken } from "../../../../shared/resources.ts";
import { advanceUntil, settleFlush } from "./flushRetry";
import { bootMutations, m, refJ, refK, SAVE_DEBOUNCE_MS, warmMutationGraph } from "./mutationStoresHarness";
import type { StoreBackedServer } from "./storeBackedServer";

const authFetch = vi.hoisted(() => vi.fn<typeof import("../serverAuth").authFetch>());
vi.mock("../serverAuth", async () => (await import("./serverAuthMock")).createServerAuthMock({ authFetch }));
vi.mock("../../alert", async () => (await import("../../tests/alertMock")).createAlertMock());

const batchPath = "/api/resources/batch";
let server: StoreBackedServer | undefined;
let stopSync: (() => void) | undefined;

beforeAll(() => warmMutationGraph(), 60_000);

afterEach(() => {
    stopSync?.();
    server?.close();
    server = undefined;
    stopSync = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    authFetch.mockReset();
});

async function boot() {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const batch = vi.fn<(init: RequestInit) => Promise<Response>>();
    const harness = await bootMutations((fake) => {
        server = fake;
        batch.mockImplementation((init) => fake.fetch(batchPath, init));
        authFetch.mockImplementation((path, init = {}, options) => {
            options?.beforeDispatch?.();
            return path === batchPath ? batch(init) : fake.fetch(path, init);
        });
    });
    stopSync = harness.sync.stopResourceSync;
    batch.mockClear();
    return { ...harness, batch };
}

function unanswered(signal?: AbortSignal | null): Promise<never> {
    return new Promise((_, reject) => {
        signal?.throwIfAborted();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

function baseAllowance(init: RequestInit) {
    return 45_000 + (1000 * Buffer.byteLength(String(init.body))) / (32 * 1024);
}

// Only a completed transfer can pass its JSON to the store. The production deadline drives the abort.
async function transfer(ms: number, signal?: AbortSignal | null) {
    let timer: ReturnType<typeof setTimeout>;
    try {
        await Promise.race([
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, ms);
            }),
            unanswered(signal),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

it.each(["before", "after"] as const)(
    "saves a later chat edit when the held batch reaches the store %s the resend",
    async (order) => {
        const { fake, chat, settings, batch } = await boot();
        const revision = () => parseRevisionToken(fake.record("ui", "main")!.revision)!.revision;
        const initialRevision = revision();
        if (order === "before") fake.holdNextBatchResponse = true;
        else fake.holdNextBatch = true;
        let original!: Promise<Response>;
        batch.mockImplementationOnce((init) => {
            original = fake.fetch(batchPath, init);
            return Promise.race([original, unanswered(init.signal)]);
        });
        settings.ui.theme = "held theme";
        chat.appendMessage(refJ, m("once", "only append"));
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        const release = order === "before" ? fake.releaseBatchResponse : fake.releaseBatch;
        expect(release).toBeTypeOf("function");
        try {
            expect(revision()).toBe(initialRevision + (order === "before" ? 1 : 0));
            chat.setChatMeta(refK, { note: "edited while waiting" });
            // Even the waiting edit's debounce cannot bypass the lost-answer backoff.
            const [first] = batch.mock.calls[0];
            await vi.advanceTimersByTimeAsync(Math.ceil(baseAllowance(first)) + SAVE_DEBOUNCE_MS);
            expect(batch).toHaveBeenCalledTimes(1);
            expect(fake.chat("c", "k")!.data.note).toBe("");

            await vi.advanceTimersByTimeAsync(30_000);
            expect(fake.chat("c", "k")!.data.note).toBe("edited while waiting");
            const [sent, resent] = fake.batchBodies();
            expect(resent.ops).toContainEqual(sent.ops[0]);
            expect(sent.chats[0].groupId).toEqual(expect.any(String));
            expect(resent.chats).toContainEqual({ ...sent.chats[0], retry: true });
        } finally {
            release!();
            await original;
        }
        expect(fake.record("ui", "main")!.data.theme).toBe("held theme");
        expect(revision()).toBe(initialRevision + 1);
        expect(fake.texts("c", "j")).toEqual(["only append"]);
    },
);

it.each([
    { rate: 64, attempts: 1 },
    { rate: 16, attempts: 2 },
])("saves an 8 MiB upload at $rate KiB/s on attempt $attempts", async ({ rate, attempts }) => {
    const { fake, batch, chat, settings, sync } = await boot();
    const size = 8 * 1024 * 1024;
    const uploads: RequestInit[] = [];
    const uploadMs = (init: RequestInit) => (1000 * Buffer.byteLength(String(init.body))) / (rate * 1024);
    batch.mockImplementation(async (init) => {
        if (Buffer.byteLength(String(init.body)) >= size) {
            uploads.push(init);
            await transfer(uploadMs(init), init.signal);
        }
        return fake.fetch(batchPath, init);
    });
    chat.appendMessage(refJ, m("large", "x".repeat(size)));
    const flushing = sync.flushResources();
    await vi.advanceTimersByTimeAsync(0);
    expect(uploads).toHaveLength(1);
    if (attempts === 2) {
        // An answer for this independent record must preserve the chat group's doubled allowance.
        settings.ui.theme = "edited during upload";
        await vi.advanceTimersByTimeAsync(Math.ceil(baseAllowance(uploads[0])));
        expect(uploads[0].signal?.aborted).toBe(true);
        expect(fake.texts("c", "j")).toEqual([]);
        await advanceUntil(() => uploads.length === 2);
        expect(uploads).toHaveLength(2);
        expect(fake.record("ui", "main")!.data.theme).toBe("edited during upload");
    }
    await vi.advanceTimersByTimeAsync(Math.ceil(uploadMs(uploads[attempts - 1])));
    expect(fake.texts("c", "j").map((text) => text.length)).toEqual([size]);
    expect(uploads.map(({ signal }) => signal?.aborted)).toEqual(attempts === 1 ? [false] : [true, false]);
    await expect(settleFlush(flushing)).resolves.toEqual({ discarded: [], refused: [] });
});

it.each([
    { priorDispatch: false, doubt: "absent" },
    { priorDispatch: true, doubt: "preserved" },
])("leaves record doubt $doubt when signing times out", async ({ priorDispatch }) => {
    const { batch, fake, settings, sync } = await boot();
    const signing = vi.fn((_path: string, init: RequestInit) => unanswered(init.signal));
    if (priorDispatch) batch.mockImplementationOnce((init) => unanswered(init.signal));
    else authFetch.mockImplementationOnce(signing);
    settings.ui.theme = "original";
    const flushing = sync.flushResources();
    if (priorDispatch) {
        await vi.advanceTimersByTimeAsync(0);
        expect(batch).toHaveBeenCalledTimes(1);
        authFetch.mockImplementationOnce(signing);
    }
    await advanceUntil(() => signing.mock.calls.length === 1);
    const init = signing.mock.calls[0][1];
    settings.ui.theme = "newer text";
    const stored: string[] = [];
    batch.mockImplementation(async (request) => {
        const response = await fake.fetch(batchPath, request);
        stored.push(fake.record("ui", "main")!.data.theme);
        return response;
    });
    const allowance = baseAllowance(init) * (priorDispatch ? 2 : 1);
    await vi.advanceTimersByTimeAsync(Math.floor(allowance) - 1);
    expect(init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(init.signal?.aborted).toBe(true);
    await expect(settleFlush(flushing)).resolves.toEqual({ discarded: [], refused: [] });
    expect(stored).toEqual(priorDispatch ? ["original", "newer text"] : ["newer text"]);
});

it("extends a batch carrying a retried reorder and resets its allowance on an answer", async () => {
    const { batch, fake, chat, settings, sync } = await boot();
    const delayedAnswer = async (init: RequestInit) => {
        await transfer(60_000, init.signal);
        return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    };
    batch
        .mockImplementationOnce((init) => unanswered(init.signal))
        .mockImplementationOnce(delayedAnswer)
        .mockImplementationOnce(delayedAnswer);
    chat.reorderChats("c", ["j", "k"]);
    const flushing = sync.flushResources();
    await vi.advanceTimersByTimeAsync(0);
    // The new record has had no aborts. The reorder extends the mixed batch's deadline.
    settings.ui.theme = "saved with reorder";
    await expect(settleFlush(flushing)).resolves.toEqual({ discarded: [], refused: [] });
    expect(batch.mock.calls.map(([init]) => init.signal?.aborted)).toEqual([true, false, true, false]);
    expect(fake.order("c")!.ids).toEqual(["j", "k"]);
    expect(fake.record("ui", "main")!.data.theme).toBe("saved with reorder");
});
