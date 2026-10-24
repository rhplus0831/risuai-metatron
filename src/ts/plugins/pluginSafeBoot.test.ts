import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmModules } from "src/ts/storage/tests/mutationStoresHarness";

// Safe boot's plugin side (`plugins-mcp.md`): `loadPluginsForBoot` captures
// the startup of the guests its own serialized load started (not whatever a later reload applied), a
// replaced boot guest is followed to its replacement after the `pluginReload` chain, a guest stopped
// because its plugin was disabled or removed counts as started, and with plugins off nothing loads,
// no remote listener is registered, and a queued deferred reload does nothing. The v3 loader and the
// instance registry are simulated; the safe-boot flag is controlled directly.

type Startup = "ready" | "failed" | "stopped";

const mocks = vi.hoisted(() => ({
    off: new Set<string>(),
    /** Whether the loader registers an instance per plugin (false: a guest that never got an instance). */
    register: true,
    /** When set, the loader throws it instead of starting the list. */
    loadError: null as Error | null,
    instances: new Map<string, { host: { startup: Promise<Startup>; settle: (result: Startup) => void } }>(),
    loads: [] as string[][],
    remoteListeners: new Set<(kind: string, id: string) => void>(),
}));

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/util", () => ({ selectSingleFile: vi.fn() }));
vi.mock("src/ts/stores.svelte", async () =>
    (await import("src/ts/tests/storesMock")).createStoresMock({ hotReloading: [] as string[] }),
);
vi.mock("./apiV3/transpiler", () => ({ pluginCodeTranspiler: vi.fn(async (code: string) => code) }));
vi.mock("src/ts/safeBoot", () => ({ safeBootOff: (category: string) => mocks.off.has(category) }));
vi.mock("./apiV3/v3.svelte", () => ({
    loadV3Plugins: async (plugins: { name: string }[]) => {
        // As the real loader: terminate what runs (their start ends `stopped`), wait for the unload
        // callbacks and the termination (a task, not a microtask), then start the list.
        for (const [name, instance] of mocks.instances) {
            instance.host.settle("stopped");
            mocks.instances.delete(name);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (mocks.loadError) throw mocks.loadError;
        mocks.loads.push(plugins.map((plugin) => plugin.name));
        if (!mocks.register) return;
        for (const plugin of plugins) {
            let settle!: (result: Startup) => void;
            const startup = new Promise<Startup>((resolve) => (settle = resolve));
            mocks.instances.set(plugin.name, { host: { startup, settle } });
        }
    },
    getV3PluginInstance: (name: string) => mocks.instances.get(name),
    pluginWorkIdle: () => true,
    onPluginWorkChange: () => () => {},
}));

const plugin = (name: string, overrides: Record<string, unknown> = {}) =>
    ({ name, version: "3.0", enabled: true, script: `script of ${name}`, ...overrides }) as any;
/** Lets every queued microtask and chain step run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Whether `promise` is still pending after the queued work ran. */
const pending = (promise: Promise<unknown>) => Promise.race([promise.then(() => false), settle().then(() => true)]);
const guest = (name: string) => mocks.instances.get(name)!.host;

/** A fresh plugin module per test: the reload chain and the remote listener are module state. */
async function fresh() {
    vi.resetModules();
    // The remote listener is a spy on this registry's own `resourceSync`: a mocked module outlives
    // `vi.resetModules()`, so a partial mock would keep the module the first registry loaded (the
    // warm-up's) for every test.
    vi.spyOn(await import("src/ts/storage/resourceSync.svelte"), "onRemoteRecordApplied").mockImplementation(
        (listener) => {
            mocks.remoteListeners.add(listener);
            return () => mocks.remoteListeners.delete(listener);
        },
    );
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    const { installFlatDatabase } = await import("src/ts/storage/tests/installFlatDatabase");
    installFlatDatabase({ characters: [], plugins: [] });
    const { loadPlugins, loadPluginsForBoot } = await import("./plugins.svelte");
    return { settings, loadPlugins, loadPluginsForBoot };
}

beforeAll(
    () =>
        warmModules(() =>
            Promise.all([
                import("src/ts/storage/settingsViews.svelte"),
                import("src/ts/storage/tests/installFlatDatabase"),
                import("./plugins.svelte"),
            ]),
        ),
    60_000,
);

beforeEach(() => {
    mocks.off.clear();
    mocks.register = true;
    mocks.loadError = null;
    mocks.instances.clear();
    mocks.loads.length = 0;
    mocks.remoteListeners.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("loadPluginsForBoot", () => {
    it("resolves true at once without plugins", async () => {
        const { loadPluginsForBoot } = await fresh();
        const boot = await loadPluginsForBoot();
        await expect(boot.guestsStarted).resolves.toBe(true);
        expect(mocks.loads).toEqual([[]]);
    });

    it("waits for its guests, true when every one reported ready, false at the first failed", async () => {
        const { settings, loadPluginsForBoot } = await fresh();
        settings.plugins = [plugin("a"), plugin("b")];
        const boot = await loadPluginsForBoot();
        expect(await pending(boot.guestsStarted)).toBe(true);
        guest("a").settle("ready");
        expect(await pending(boot.guestsStarted)).toBe(true);
        guest("b").settle("ready");
        await expect(boot.guestsStarted).resolves.toBe(true);

        const failing = await loadPluginsForBoot();
        guest("a").settle("ready");
        guest("b").settle("failed");
        await expect(failing.guestsStarted).resolves.toBe(false);
    });

    it("judges the guests its own load started, not what a reload applied while the boot still waited", async () => {
        const { settings, loadPlugins, loadPluginsForBoot } = await fresh();
        // An enabled unsupported plugin: its report hashes the script, and the boot call waits for that
        // report after its own load applied, a gap in which another load can replace the registry.
        let hashed!: (digest: ArrayBuffer) => void;
        vi.spyOn(crypto.subtle, "digest").mockImplementation(() => new Promise((resolve) => (hashed = resolve)));
        settings.plugins = [plugin("a"), plugin("old", { version: "2.0" })];
        const booting = loadPluginsForBoot();
        // The boot's own load lands (the loader's task); the boot call still waits for the report.
        await vi.waitFor(() => expect(mocks.loads).toEqual([["a"]]));
        expect(await pending(booting)).toBe(true);
        guest("a").settle("failed");
        settings.plugins = [];
        await loadPlugins();
        expect(mocks.loads).toEqual([["a"], []]);
        hashed(new ArrayBuffer(32));
        const boot = await booting;
        await expect(boot.guestsStarted).resolves.toBe(false);
    });

    it("fails closed for a plugin that got no instance", async () => {
        const { settings, loadPluginsForBoot } = await fresh();
        settings.plugins = [plugin("a")];
        mocks.register = false;
        const boot = await loadPluginsForBoot();
        await expect(boot.guestsStarted).resolves.toBe(false);
    });

    it("rejects as loadPlugins does when the loader fails, and the next load still runs", async () => {
        const { settings, loadPlugins, loadPluginsForBoot } = await fresh();
        settings.plugins = [plugin("a")];
        mocks.loadError = new Error("loader broke");
        await expect(loadPluginsForBoot()).rejects.toThrow("loader broke");
        mocks.loadError = null;
        await loadPlugins();
        expect(mocks.loads).toEqual([["a"]]);
    });
});

describe("a boot guest replaced before it reported", () => {
    it("is followed to its replacement: ready counts, failed counts against the boot", async () => {
        const { settings, loadPlugins, loadPluginsForBoot } = await fresh();
        settings.plugins = [plugin("a")];
        const boot = await loadPluginsForBoot();
        await loadPlugins();
        expect(mocks.loads).toEqual([["a"], ["a"]]);
        expect(await pending(boot.guestsStarted)).toBe(true);
        guest("a").settle("ready");
        await expect(boot.guestsStarted).resolves.toBe(true);

        const failing = await loadPluginsForBoot();
        await loadPlugins();
        guest("a").settle("failed");
        await expect(failing.guestsStarted).resolves.toBe(false);
    });

    it("is followed through a chain of replacements", async () => {
        const { settings, loadPlugins, loadPluginsForBoot } = await fresh();
        settings.plugins = [plugin("a")];
        const boot = await loadPluginsForBoot();
        await loadPlugins();
        await loadPlugins();
        expect(mocks.loads).toHaveLength(3);
        expect(await pending(boot.guestsStarted)).toBe(true);
        guest("a").settle("ready");
        await expect(boot.guestsStarted).resolves.toBe(true);
    });

    it("counts as started when its plugin was disabled or removed, not when it is still enabled without an instance", async () => {
        const { settings, loadPlugins, loadPluginsForBoot } = await fresh();
        settings.plugins = [plugin("a")];
        const disabled = await loadPluginsForBoot();
        settings.plugins = [plugin("a", { enabled: false })];
        await loadPlugins();
        await expect(disabled.guestsStarted).resolves.toBe(true);

        settings.plugins = [plugin("a")];
        const removed = await loadPluginsForBoot();
        settings.plugins = [];
        await loadPlugins();
        await expect(removed.guestsStarted).resolves.toBe(true);

        settings.plugins = [plugin("a")];
        const missing = await loadPluginsForBoot();
        mocks.register = false;
        await loadPlugins();
        await expect(missing.guestsStarted).resolves.toBe(false);
    });

    it("is no longer followed once the boot stopped following (the settle window ended)", async () => {
        const { settings, loadPlugins, loadPluginsForBoot } = await fresh();
        settings.plugins = [plugin("a")];
        const boot = await loadPluginsForBoot();
        await loadPlugins();
        boot.stopFollowingGuests();
        guest("a").settle("ready");
        await expect(boot.guestsStarted).resolves.toBe(false);
    });
});

describe("plugins off for this page load", () => {
    it("loads nothing, registers no remote listener, and the boot counts as started", async () => {
        const { settings, loadPlugins, loadPluginsForBoot } = await fresh();
        mocks.off.add("plugins");
        settings.plugins = [plugin("a")];
        const boot = await loadPluginsForBoot();
        await expect(boot.guestsStarted).resolves.toBe(true);
        await loadPlugins();
        expect(mocks.loads).toEqual([]);
        expect(mocks.instances.size).toBe(0);
        expect(mocks.remoteListeners.size).toBe(0);
    });

    it("stops a queued deferred reload before it clears anything", async () => {
        const { settings, loadPluginsForBoot } = await fresh();
        settings.plugins = [plugin("a")];
        await loadPluginsForBoot();
        expect(mocks.remoteListeners.size).toBe(1);
        mocks.off.add("plugins");
        settings.plugins = [plugin("a"), plugin("b")];
        for (const listener of [...mocks.remoteListeners]) listener("plugins", "plugins");
        await settle();
        await settle();
        expect(mocks.loads).toEqual([["a"]]);
        expect(mocks.instances.has("a")).toBe(true);
    });
});
