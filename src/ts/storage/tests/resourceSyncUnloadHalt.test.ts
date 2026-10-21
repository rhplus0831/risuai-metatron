import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize } from "./serverKinds";

// Once saving halted for a restore, `beforeunload` asks for no warning, so the reload the restore
// notice's OK starts goes through (before the fix the browser asked "Leave site?" for the work a
// halted loop can never save, and "Stay" left a halted page without the notice). Its own file, as
// `resourceSyncUnload.test.ts` (the unhalted warning) is: the window listeners come from exactly
// one module graph.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertTerminal: alerts.terminal,
    }),
);
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

describe("page lifecycle after a restore", () => {
    it("asks for no unload warning once saving halted, before and after the notice's OK, while the unsaved work stays", async () => {
        let acknowledge: () => void = () => {};
        alerts.terminal.mockImplementationOnce(
            () => new Promise<undefined>((resolve) => (acknowledge = () => resolve(undefined))),
        );
        const { fake, sync, settings } = await boot();
        const themeBefore = fake.data("ui", "main").theme;
        const reload = (location as any).reload;

        // Unsaved work on an ordinary page: the warning is asked for.
        settings.ui.theme = "edited before the restore";
        await tick();
        expect(warns()).toBe(true);

        // The restore refuses the save: the loop halts and the notice waits for its OK. The edit is
        // never saved, and no warning is asked for any more.
        fake.restore("epoch-2");
        await expect(sync.flushResources()).rejects.toThrow();
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
        expect(reload).not.toHaveBeenCalled();
        expect(warns()).toBe(false);
        // Work added while the notice shows is unsaved too, and still no warning.
        settings.ui.theme = "edited behind the notice";
        await tick();
        expect(warns()).toBe(false);

        // The OK reloads; the unload that follows asks for no warning.
        acknowledge();
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(warns()).toBe(false);
        expect(fake.data("ui", "main").theme).toBe(themeBefore);
    });
});
