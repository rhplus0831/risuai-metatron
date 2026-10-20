import { beforeEach, describe, expect, it, vi } from "vitest";

// The reload after a remote `plugins` change (RisuNest small wins P2, `plugins-mcp.md` Flows step
// 6): `loadPlugins` registers the remote listener once; a change to the load signature of the
// enabled 3.0 plugins requests one reload, which waits until `pluginWorkIdle` (decision D4: never
// interrupted), checks idleness again on the `pluginReload` chain, loads the newest list, and skips a
// list equal to what runs. A local `loadPlugins` cancels it; a remote change while a local load is
// queued is reconciled after that load. The v3 loader, the idle predicate, and the storage listener
// are controlled here.

const mocks = vi.hoisted(() => ({
    alertError: vi.fn(),
    loadV3Plugins: vi.fn(async (_plugins: any[]) => {}),
    idle: true,
    workListeners: new Set<() => void>(),
    remoteListeners: new Set<(kind: string, id: string) => void>(),
}));

vi.mock("src/ts/alert", () => ({
    alertConfirm: vi.fn(async () => true),
    alertError: mocks.alertError,
}));
vi.mock("src/ts/util", () => ({ selectSingleFile: vi.fn() }));
vi.mock("src/ts/stores.svelte", () => ({ hotReloading: [] as string[] }));
vi.mock("./apiV3/transpiler", () => ({ pluginCodeTranspiler: vi.fn(async (code: string) => code) }));
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
/** The lists loaded so far, by plugin name. */
const loads = () => mocks.loadV3Plugins.mock.calls.map(([plugins]) => plugins.map((p: any) => p.name));
/** Lets every queued microtask and chain step run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
    mocks.idle = true;
    mocks.loadV3Plugins.mockReset().mockImplementation(async () => {});
    mocks.alertError.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
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
