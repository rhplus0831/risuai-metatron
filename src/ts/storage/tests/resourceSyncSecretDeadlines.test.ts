import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { SecretPath } from "../../../../shared/llmSecrets.ts";
import { bootMutations, refJ, warmMutationGraph } from "./mutationStoresHarness";
import type { StoreBackedServer } from "./storeBackedServer";

const send = vi.hoisted(() => vi.fn<StoreBackedServer["fetch"]>());
vi.mock("../serverAuth", async () =>
    (await import("./serverAuthMock")).createServerAuthMock({
        authFetch: (path, init, options) => {
            options?.beforeDispatch?.();
            return send(path, init);
        },
    }),
);
vi.mock("../../alert", async () => (await import("../../tests/alertMock")).createAlertMock());

const secretPath = { kind: "flat", field: "openAIKey" } satisfies SecretPath;
const secretRoute = "/api/llm-secrets/openAIKey";
const key = "test-key";
let server: StoreBackedServer | undefined;
let stopSync: (() => void) | undefined;

beforeAll(() => warmMutationGraph(), 60_000);

afterEach(() => {
    stopSync?.();
    server?.close();
    stopSync = undefined;
    server = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    send.mockReset();
});

async function boot() {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const harness = await bootMutations((fake) => {
        server = fake;
        send.mockImplementation(fake.fetch);
    });
    stopSync = harness.sync.stopResourceSync;
    return { ...harness, secrets: await import("../llmSecrets.svelte") };
}

function unanswered(signal?: AbortSignal | null): Promise<never> {
    return new Promise((_, reject) => {
        signal?.throwIfAborted();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

function observeRejection(work: Promise<unknown>) {
    const rejected = vi.fn();
    void work.catch(rejected);
    return rejected;
}

it("releases the save loop and credential barrier on expiry, then refuses the late PUT", async () => {
    const { chat, fake, record, secrets, sync } = await boot();
    let deliverOriginal: (() => Promise<Response>) | undefined;
    send.mockImplementation((path, init) => {
        if (path === secretRoute && !deliverOriginal) {
            // Abort ends the client's wait. The already dispatched request can still reach the store.
            deliverOriginal = () => fake.fetch(path, init);
            return unanswered(init?.signal);
        }
        return fake.fetch(path, init);
    });

    const opId = secrets.setSecret(secretPath, key);
    const flush = observeRejection(sync.flushResources());
    await vi.advanceTimersByTimeAsync(0);
    expect(deliverOriginal).toBeTypeOf("function");
    const barrier = observeRejection(sync.awaitSecretWrites());
    chat.setChatMeta(refJ, { note: "edited while the PUT was unanswered" });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(fake.chat("c", "j")!.data.note).toBe("");
    expect(flush).not.toHaveBeenCalled();
    expect(barrier).not.toHaveBeenCalled();
    // The short key and base revision add a few milliseconds of JSON upload allowance.
    await vi.advanceTimersByTimeAsync(20);
    expect(flush).toHaveBeenCalledOnce();
    expect(barrier).toHaveBeenCalledOnce();
    expect(secrets.llmSecretState.queue.map((op) => op.id)).toEqual([opId]);

    // The automatic retry takes the network backoff before it can send the later edit.
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.chat("c", "j")!.data.note).toBe("");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.chat("c", "j")!.data.note).toBe("edited while the PUT was unanswered");
    expect(secrets.llmSecretState.queue).toEqual([]);
    expect(record("llmSecrets").openAIKey).toBe(key);

    const committedRevision = fake.record("llmSecrets", "main")!.revision;
    expect((await deliverOriginal!()).status).toBe(409);
    expect(fake.record("llmSecrets", "main")).toMatchObject({
        revision: committedRevision,
        data: { openAIKey: key },
    });
});

it("doubles the deadline for a requeued PUT and resets it after a stale-revision answer", async () => {
    const { fake, record, secrets, sync } = await boot();
    const put = vi.fn<StoreBackedServer["fetch"]>((_path, init) => unanswered(init?.signal));
    send.mockImplementation((path, init) => (path === secretRoute ? put(path, init) : fake.fetch(path, init)));
    const staleBase = fake.record("llmSecrets", "main")!.revision;

    secrets.setSecret(secretPath, key);
    const first = observeRejection(sync.flushResources());
    await vi.advanceTimersByTimeAsync(45_020);
    expect(first).toHaveBeenCalledOnce();

    const second = observeRejection(sync.flushResources());
    await vi.advanceTimersByTimeAsync(90_000);
    expect(second).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40);
    expect(second).toHaveBeenCalledOnce();

    fake.set("llmSecrets", "main", { ...record("llmSecrets"), openAIKey: "other-tab-key" });
    const freshBase = fake.record("llmSecrets", "main")!.revision;
    put.mockImplementationOnce(fake.fetch);

    const afterConflict = observeRejection(sync.flushResources());
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.secretRequests()).toEqual([
        { method: "PUT", path: secretRoute, body: { value: key, baseRevision: staleBase } },
    ]);
    expect(JSON.parse(String(put.mock.lastCall?.[1]?.body))).toEqual({ value: key, baseRevision: freshBase });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(afterConflict).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(afterConflict).toHaveBeenCalledOnce();
});
