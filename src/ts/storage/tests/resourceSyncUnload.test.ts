import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize } from "./serverKinds";

// The save adapter's page lifecycle handlers: a hidden page saves at once, and `beforeunload` asks
// for the browser's warning only while work is unsaved. Its own file, so the window listeners come
// from exactly one module graph (`resourceSync.test.ts` boots many, and their listeners share the
// window).

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type Bootstrap = typeof import("../../bootstrap");
type SettingsViews = typeof import("../settingsViews.svelte");

async function boot() {
    vi.resetModules();
    const fake = new FakeResourceServer();
    // No `root` record since slice 6: the sections and collections are the records the server
    // materializes; the sample edit is `ui.theme`.
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.set("characters", "a", { chaId: "a", name: "Alice", type: "character" });
    await materialize(fake);
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const { settings }: SettingsViews = await import("../settingsViews.svelte");

    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    // The records and the selection (at home), as `loadData` installs them.
    bootstrap.installBootRecords(snapshot);
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;
    return { fake, sync, settings };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

const warns = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
};

describe("page lifecycle", () => {
    it("saves at once when the page is hidden, and warns before unload only while work is unsaved", async () => {
        const { fake, settings } = await boot();
        expect(warns()).toBe(false);
        settings.ui.theme = "hidden";
        await tick();
        expect(warns()).toBe(true);
        expect(fake.batchCount()).toBe(0);

        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        try {
            document.dispatchEvent(new Event("visibilitychange"));
            // The cycle runs without the 500 ms debounce (never advanced here).
            for (let i = 0; i < 10; i++) {
                await vi.advanceTimersByTimeAsync(1);
            }
        } finally {
            delete (document as any).visibilityState;
        }
        expect(fake.batchCount()).toBe(1);
        expect(fake.data("ui", "main").theme).toBe("hidden");
        expect(warns()).toBe(false);
    });
});
