import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PermissionRemovalListener = Parameters<typeof import("./apiV3/permissionStore").onPermissionGrantsRemoved>[0];

// The reload after a remote `plugins` change (`plugin-sandbox.md` Deferred reload): `loadPlugins`
// registers the remote listener once; a change to the load signature of the enabled 3.0 plugins
// requests one reload, which waits until `pluginWorkIdle` (running work is never interrupted),
// checks idleness again on the `pluginReload` chain, loads the newest list, and skips a
// list equal to what runs. A local `loadPlugins` cancels it; a remote change while a local load is
// queued is reconciled after that load. Permission resets of running plugins force the same deferred
// reload even with an unchanged signature. The v3 loader, idle predicate, storage listener, and
// permission removal listener are controlled here.

const mocks = vi.hoisted(() => ({
    alertError: vi.fn(),
    loadV3Plugins: vi.fn(async (_plugins: any[]) => {}),
    idle: true,
    workListeners: new Set<() => void>(),
    remoteListeners: new Set<(kind: string, id: string) => void>(),
    permissionListeners: new Set<PermissionRemovalListener>(),
}));

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: vi.fn(async () => true),
        alertError: mocks.alertError,
    }),
);
vi.mock("src/ts/util", () => ({ selectSingleFile: vi.fn() }));
vi.mock("src/ts/stores.svelte", async () =>
    (await import("src/ts/tests/storesMock")).createStoresMock({ hotReloading: [] as string[] }),
);
vi.mock("./apiV3/transpiler", () => ({ pluginCodeTranspiler: vi.fn(async (code: string) => code) }));
vi.mock("./apiV3/permissionStore", async () =>
    (await import("./apiV3/tests/permissionStoreMock")).createPermissionStoreMock({
        onPermissionGrantsRemoved: (listener) => {
            mocks.permissionListeners.add(listener);
            return () => mocks.permissionListeners.delete(listener);
        },
    }),
);
vi.mock("./apiV3/v3.svelte", () => ({
    loadV3Plugins: mocks.loadV3Plugins,
    pluginWorkIdle: () => mocks.idle,
    onPluginWorkChange: (listener: () => void) => {
        mocks.workListeners.add(listener);
        return () => mocks.workListeners.delete(listener);
    },
}));
vi.mock("src/ts/storage/resourceSync.svelte", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    onRemoteRecordApplied: (listener: (kind: string, id: string) => void) => {
        mocks.remoteListeners.add(listener);
        return () => mocks.remoteListeners.delete(listener);
    },
}));

import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { loadPlugins } from "./plugins.svelte";
import { pluginHooks } from "./pluginHooks";

installFlatDatabase({ characters: [], plugins: [] });

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const plugin = (name: string, overrides: Record<string, unknown> = {}) =>
    ({ name, version: "3.0", enabled: true, script: `script of ${name}`, ...overrides }) as any;
const remoteChange = (kind = "plugins") => {
    for (const listener of [...mocks.remoteListeners]) listener(kind, kind);
};
const workChanged = () => {
    for (const listener of [...mocks.workListeners]) listener();
};
const permissionReset = (...names: string[]) => {
    // A reset count can change even when there were no persisted grants to remove.
    for (const listener of [...mocks.permissionListeners]) listener(new Set(), new Set(names));
};
/** The lists loaded so far, by plugin name. */
const loads = () => mocks.loadV3Plugins.mock.calls.map(([plugins]) => plugins.map((p: any) => p.name));
/** Lets every queued microtask and chain step run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    mocks.idle = true;
    mocks.loadV3Plugins.mockReset().mockImplementation(async () => {});
    mocks.alertError.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("the reload after a remote plugins change", () => {
    it("reloads once with the new list when a remote change disables a loaded plugin, resetting the hooks first", async () => {
        settings.plugins = [plugin("a1"), plugin("a2")];
        await loadPlugins();
        expect(loads()).toEqual([["a1", "a2"]]);
        expect(mocks.remoteListeners.size).toBeGreaterThan(0);

        const handler = async (text: string) => text;
        pluginHooks.editinput.add(handler);
        const hooksWhenLoading: number[] = [];
        mocks.loadV3Plugins.mockImplementationOnce(async () => {
            hooksWhenLoading.push(pluginHooks.editinput.size);
        });
        settings.plugins = [plugin("a1"), plugin("a2", { enabled: false })];
        remoteChange();
        await settle();
        expect(loads()).toEqual([["a1", "a2"], ["a1"]]);
        expect(hooksWhenLoading).toEqual([0]);

        // The same list again: nothing to do.
        remoteChange();
        await settle();
        expect(loads()).toHaveLength(2);
    });

    it("ignores a change to a disabled plugin, a non-3.0 plugin, a plugin's arguments, or another record kind", async () => {
        settings.plugins = [plugin("b1"), plugin("b2", { enabled: false }), plugin("b3", { version: "2.1" })];
        await loadPlugins();
        expect(loads()).toEqual([["b1"]]);

        settings.plugins = [
            plugin("b1", { realArg: { key: "changed" } }),
            plugin("b2", { enabled: false, script: "changed" }),
            plugin("b3", { version: "2.1", script: "changed" }),
        ];
        remoteChange();
        await settle();
        settings.plugins = [
            plugin("b1", { script: "changed" }),
            plugin("b2", { enabled: false }),
            plugin("b3", { version: "2.1" }),
        ];
        remoteChange("characters");
        await settle();
        expect(loads()).toEqual([["b1"]]);
    });

    it("waits while plugin work runs and reloads once it is idle", async () => {
        settings.plugins = [plugin("c1"), plugin("c2")];
        await loadPlugins();
        mocks.idle = false;
        settings.plugins = [plugin("c1")];
        remoteChange();
        await settle();
        expect(loads()).toEqual([["c1", "c2"]]);

        // A notification while still busy changes nothing.
        workChanged();
        await settle();
        expect(loads()).toEqual([["c1", "c2"]]);

        mocks.idle = true;
        workChanged();
        await settle();
        expect(loads()).toEqual([["c1", "c2"], ["c1"]]);
    });

    it("reloads once with the newest list after two changes while waiting", async () => {
        settings.plugins = [plugin("d1"), plugin("d2")];
        await loadPlugins();
        mocks.idle = false;
        settings.plugins = [plugin("d1")];
        remoteChange();
        settings.plugins = [plugin("d1"), plugin("d3")];
        remoteChange();
        await settle();
        expect(loads()).toEqual([["d1", "d2"]]);

        mocks.idle = true;
        workChanged();
        await settle();
        expect(loads()).toEqual([
            ["d1", "d2"],
            ["d1", "d3"],
        ]);
    });

    it("is cancelled by a local loadPlugins, which loads the list as it is", async () => {
        settings.plugins = [plugin("e1"), plugin("e2")];
        await loadPlugins();
        mocks.idle = false;
        settings.plugins = [plugin("e1")];
        remoteChange();
        await settle();
        settings.plugins = [plugin("e1"), plugin("e3")];
        await loadPlugins();
        expect(loads()).toEqual([
            ["e1", "e2"],
            ["e1", "e3"],
        ]);

        mocks.idle = true;
        workChanged();
        await settle();
        expect(loads()).toHaveLength(2);
    });

    it("reconciles a remote change that arrives while a local load is queued", async () => {
        settings.plugins = [plugin("f1"), plugin("f2")];
        await loadPlugins();

        // The local load captured [f1]; before its chain step starts, the record is back to the running list.
        settings.plugins = [plugin("f1")];
        const local = loadPlugins();
        settings.plugins = [plugin("f1"), plugin("f2")];
        remoteChange();
        await local;
        await settle();
        expect(loads()).toEqual([["f1", "f2"], ["f1"], ["f1", "f2"]]);
    });

    it("checks idleness again on the chain and waits when work started meanwhile", async () => {
        settings.plugins = [plugin("g1")];
        await loadPlugins();
        const gate = deferred<void>();
        mocks.loadV3Plugins.mockImplementationOnce(() => gate.promise);
        settings.plugins = [plugin("g1"), plugin("g2")];
        const local = loadPlugins();
        await settle();
        expect(loads()).toEqual([["g1"], ["g1", "g2"]]);

        // Idle when the change arrives: the reload is queued behind the running local load.
        settings.plugins = [plugin("g1"), plugin("g2"), plugin("g3")];
        remoteChange();
        await settle();
        // Work starts before the chain reaches it.
        mocks.idle = false;
        gate.resolve();
        await local;
        await settle();
        expect(loads()).toEqual([["g1"], ["g1", "g2"]]);

        mocks.idle = true;
        workChanged();
        await settle();
        expect(loads()).toEqual([["g1"], ["g1", "g2"], ["g1", "g2", "g3"]]);
    });

    it("leaves the running signature unset after a failed load, so the next change reloads", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        settings.plugins = [plugin("h1"), plugin("h2")];
        await loadPlugins();
        mocks.loadV3Plugins.mockRejectedValueOnce(new Error("start failed"));
        settings.plugins = [plugin("h1")];
        remoteChange();
        await settle();
        expect(loads()).toEqual([["h1", "h2"], ["h1"]]);
        expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: "start failed" }));

        // Nothing is known to run: even a change to a disabled plugin reloads the list.
        settings.plugins = [plugin("h1"), plugin("h2", { enabled: false })];
        remoteChange();
        await settle();
        expect(loads()).toEqual([["h1", "h2"], ["h1"], ["h1"]]);
    });
});

describe("the reload after a permission reset", () => {
    it("reloads once for a running plugin's reset with an unchanged load signature", async () => {
        settings.plugins = [plugin("reset-running", { allowedIPC: ["peer"] })];
        await loadPlugins();
        expect(loads()).toEqual([["reset-running"]]);

        permissionReset("reset-running");
        permissionReset("reset-running");
        expect(loads()).toEqual([["reset-running"]]);
        await settle();
        expect(loads()).toEqual([["reset-running"], ["reset-running"]]);

        workChanged();
        remoteChange();
        await settle();
        expect(loads()).toEqual([["reset-running"], ["reset-running"]]);
    });

    it("ignores resets of plugins not running in this tab", async () => {
        settings.plugins = [
            plugin("reset-active"),
            plugin("reset-disabled", { enabled: false }),
            plugin("reset-unsupported", { version: "2.1" }),
        ];
        await loadPlugins();
        expect(loads()).toEqual([["reset-active"]]);

        permissionReset("reset-disabled", "reset-unsupported", "reset-absent");
        await settle();
        workChanged();
        await settle();
        expect(loads()).toEqual([["reset-active"]]);
    });

    it("keeps the forced reload through busy retries and work resuming on the reload chain", async () => {
        settings.plugins = [plugin("reset-busy")];
        await loadPlugins();
        const gate = deferred<void>();
        mocks.loadV3Plugins.mockImplementationOnce(() => gate.promise);
        const local = loadPlugins();
        await settle();
        expect(loads()).toEqual([["reset-busy"], ["reset-busy"]]);

        mocks.idle = false;
        permissionReset("reset-busy");
        await settle();
        workChanged();
        await settle();
        expect(loads()).toEqual([["reset-busy"], ["reset-busy"]]);

        // Queue behind the local load, then become busy before that chain step can run.
        mocks.idle = true;
        workChanged();
        await settle();
        mocks.idle = false;
        gate.resolve();
        await local;
        await settle();
        expect(loads()).toEqual([["reset-busy"], ["reset-busy"]]);

        mocks.idle = true;
        workChanged();
        await settle();
        expect(loads()).toEqual([["reset-busy"], ["reset-busy"], ["reset-busy"]]);
        workChanged();
        await settle();
        expect(loads()).toHaveLength(3);
    });

    it("lets a local load supersede a forced reload waiting for idle", async () => {
        settings.plugins = [plugin("reset-local")];
        await loadPlugins();
        mocks.idle = false;
        permissionReset("reset-local");
        await settle();
        expect(loads()).toEqual([["reset-local"]]);

        await loadPlugins();
        expect(loads()).toEqual([["reset-local"], ["reset-local"]]);
        mocks.idle = true;
        workChanged();
        await settle();
        expect(loads()).toEqual([["reset-local"], ["reset-local"]]);
    });
});
