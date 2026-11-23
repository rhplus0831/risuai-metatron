import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { SAVE_DEBOUNCE_MS, warmMutationGraph } from "./mutationStoresHarness";
import { materialize } from "./serverKinds";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("../serverAuth").authFetch>() }));
vi.mock("../serverAuth", async () => (await import("./serverAuthMock")).createServerAuthMock({ authFetch }));
vi.mock("../../alert", async () => (await import("../../tests/alertMock")).createAlertMock());
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", async () => (await import("../../tests/globalApiMock")).createGlobalApiMock());

let stopSync: (() => void) | undefined;
async function boot() {
    vi.resetModules();
    const fake = new FakeResourceServer();
    fake.set("presets", "main", [{ name: "Default" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    await materialize(fake);
    const dispatch: typeof import("../serverAuth").authFetch = (path, init, options) => {
        options?.beforeDispatch?.();
        return fake.fetch(path, init);
    };
    authFetch.mockReset().mockImplementation(dispatch);

    const client = await import("../resourceClient");
    const sync = await import("../resourceSync.svelte");
    const bootstrap = await import("../../bootstrap");
    const { settings } = await import("../settingsViews.svelte");
    const { selectCharacter } = await import("../selection.svelte");
    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    bootstrap.installBootRecords(snapshot);
    selectCharacter(null);
    sync.startResourceSync();
    stopSync = sync.stopResourceSync;
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;
    return { fake, sync, settings, dispatch };
}

beforeAll(() => warmMutationGraph(), 60_000);

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    stopSync?.();
    stopSync = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("flushes immediately, waits out the retry backoff, and resolves after a lost batch answer", async () => {
    const { fake, sync, settings } = await boot();
    fake.dropNextBatchResponse = true;
    settings.ui.theme = "saved with a lost answer";

    const resolved = vi.fn();
    const rejected = vi.fn();
    void sync.flushResources().then(resolved, rejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.batchCount()).toBe(1);
    expect(fake.data("ui", "main").theme).toBe("saved with a lost answer");
    expect(resolved).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(fake.batchCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.batchCount()).toBe(2);
    expect(resolved).toHaveBeenCalledExactlyOnceWith({ discarded: [], refused: [] });
    expect(rejected).not.toHaveBeenCalled();
});

it("rejects with the last error after ten failed save cycles", async () => {
    const { fake, sync, settings, dispatch } = await boot();
    const isBatch = (path: string) => path === "/api/resources/batch";
    fake.failNext = { status: 0, times: 9, match: isBatch };
    authFetch.mockImplementation((path, init, options) => {
        if (isBatch(path) && fake.batchCount() === 9) {
            fake.failNext = { status: 503, times: 1, match: isBatch, body: { error: "Last save cycle unavailable" } };
        }
        return dispatch(path, init, options);
    });
    settings.ui.theme = "unsaved";

    const resolved = vi.fn();
    const rejected = vi.fn();
    void sync.flushResources().then(resolved, (error: unknown) => rejected(error, fake.batchCount()));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(resolved).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: 503, message: "Last save cycle unavailable" }),
        10,
    );
});
