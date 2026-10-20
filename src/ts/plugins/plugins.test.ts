import { beforeEach, describe, expect, it, vi } from "vitest";

// Plugin API 2.0/2.1 was removed. Two contracts replaced it:
// - `importPlugin` installs a script only when one of its `//@api` tokens is
//   exactly `3.0`; anything else (no header, `2.0`, `2.1`) is rejected with the
//   localized `pluginApiVersionUnsupported` message and nothing is stored or
//   loaded. A list that also carries `3.0` is accepted, and the stored entry
//   always records `version: "3.0"`.
// - `loadPlugins` resets the shared hook registries before it starts the v3
//   plugins, and starts only the enabled `"3.0"` entries. v3 script handlers
//   and providers have no per-plugin unload cleanup, so that reset is what
//   keeps a reload from running every handler twice.

const mocks = vi.hoisted(() => ({
    alertError: vi.fn(),
    alertConfirm: vi.fn(async () => true),
    loadV3Plugins: vi.fn(async (_plugins: any[]) => {}),
}));

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: mocks.alertConfirm,
        alertError: mocks.alertError,
    }),
);

vi.mock("src/ts/util", () => ({
    selectSingleFile: vi.fn(),
}));

vi.mock("src/ts/stores.svelte", () => ({
    hotReloading: [] as string[],
}));

vi.mock("./apiV3/v3.svelte", () => ({
    loadV3Plugins: mocks.loadV3Plugins,
}));

vi.mock("./apiV3/transpiler", () => ({
    pluginCodeTranspiler: vi.fn(async (code: string) => code),
}));

import { language } from "src/lang";
import { hotReloading } from "src/ts/stores.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { importPlugin, loadPlugins } from "./plugins.svelte";
import { pluginHooks } from "./pluginHooks";

// The plugin functions read and write the plugin list through the settings views (Phase 6 slice
// 7): the records are installed as the app installs them, and `settings.plugins` is that record.
installFlatDatabase({ characters: [], plugins: [] });

const script = (header: string) => `//@name test_plugin\n${header}\nconsole.log("hi");\n`;

beforeEach(() => {
    settings.plugins = [];
    mocks.alertError.mockClear();
    mocks.loadV3Plugins.mockClear();
});

describe("importPlugin API version gate", () => {
    it.each([
        ["no //@api header", ""],
        ["//@api 2.0", "//@api 2.0"],
        ["//@api 2.1", "//@api 2.1"],
        ["//@api 2.0 2.1", "//@api 2.0 2.1"],
    ])("rejects a plugin with %s", async (_label, header) => {
        await importPlugin(script(header));

        expect(mocks.alertError).toHaveBeenCalledTimes(1);
        expect(mocks.alertError).toHaveBeenCalledWith(language.pluginApiVersionUnsupported);
        expect(settings.plugins).toEqual([]);
        expect(mocks.loadV3Plugins).not.toHaveBeenCalled();
    });

    it.each([
        ["//@api 3.0", "//@api 3.0"],
        ["//@api 2.1 3.0", "//@api 2.1 3.0"],
    ])("installs a plugin with %s as version 3.0 and loads it", async (_label, header) => {
        await importPlugin(script(header));

        expect(mocks.alertError).not.toHaveBeenCalled();
        // The plugin lands in the `plugins` record (`settings.plugins`) through `upsertPlugin`.
        expect(settings.plugins).toHaveLength(1);
        expect(settings.plugins[0]).toMatchObject({
            name: "test_plugin",
            version: "3.0",
            enabled: true,
        });
        expect(mocks.loadV3Plugins).toHaveBeenCalledTimes(1);
    });
});

describe("loadPlugins", () => {
    it("clears the hook registries before starting only the enabled 3.0 plugins", async () => {
        const handler = async (s: string) => s;
        pluginHooks.editinput.add(handler);
        pluginHooks.editoutput.add(handler);
        pluginHooks.editprocess.add(handler);
        pluginHooks.editdisplay.add(handler);
        pluginHooks.chatOutput.add(async () => {});
        pluginHooks.providers.set("stale", async () => ({ success: true, content: "" }));

        settings.plugins = [
            { name: "v3-enabled", version: "3.0", enabled: true, script: "" },
            { name: "legacy-2.1", version: "2.1", enabled: true, script: "" },
            { name: "legacy-2", version: 2, enabled: true, script: "" },
            { name: "v3-disabled", version: "3.0", enabled: false, script: "" },
        ] as any;

        const sizesWhenLoading: number[] = [];
        mocks.loadV3Plugins.mockImplementationOnce(async () => {
            sizesWhenLoading.push(
                pluginHooks.editinput.size,
                pluginHooks.editoutput.size,
                pluginHooks.editprocess.size,
                pluginHooks.editdisplay.size,
                pluginHooks.chatOutput.size,
                pluginHooks.providers.size,
            );
        });

        await loadPlugins();

        expect(mocks.loadV3Plugins).toHaveBeenCalledTimes(1);
        const loaded = mocks.loadV3Plugins.mock.calls[0][0];
        expect(loaded.map((p: any) => p.name)).toEqual(["v3-enabled"]);
        expect(sizesWhenLoading).toEqual([0, 0, 0, 0, 0, 0]);
    });
});

// A stored plugin that is not API 3.0 (an upstream backup's `2`, `"2.1"`, or no version) never loads;
// while enabled it is reported once per page load per identity (name, version, script hash).
// Each test uses its own names: the reported identities live for the module's lifetime.
describe("loadPlugins reports enabled non-3.0 plugins", () => {
    const stored = (name: string, version: unknown, script = "old script", enabled = true) =>
        ({ name, version, script, enabled }) as any;
    const reported = (...lines: string[]) =>
        language.pluginApiVersionUnsupportedLoad.replace("{plugins}", lines.join("\n"));

    it("reports a plugin once over two loads, and again after its script changes", async () => {
        settings.plugins = [
            stored("once-legacy", "2.1"),
            stored("once-v3", "3.0"),
            stored("once-disabled", "2.1", "old script", false),
        ];
        await loadPlugins();
        await loadPlugins();
        expect(mocks.alertError.mock.calls).toEqual([[reported("once-legacy (API 2.1)")]]);
        expect(mocks.loadV3Plugins.mock.calls.map(([plugins]) => plugins.map((p: any) => p.name))).toEqual([
            ["once-v3"],
            ["once-v3"],
        ]);

        settings.plugins = [stored("once-legacy", "2.1", "new script"), stored("once-v3", "3.0")];
        await loadPlugins();
        expect(mocks.alertError).toHaveBeenCalledTimes(2);
        expect(mocks.alertError).toHaveBeenLastCalledWith(reported("once-legacy (API 2.1)"));
    });

    it("lists a load's plugins in one alert, whatever their version field", async () => {
        settings.plugins = [stored("list-number", 2), stored("list-none", undefined)];
        await loadPlugins();
        expect(mocks.alertError.mock.calls).toEqual([[reported("list-number (API 2)", "list-none (API ?)")]]);
    });

    it("reports overlapping loads of the same plugins in one alert", async () => {
        settings.plugins = [stored("overlap-a", "2.1"), stored("overlap-b", "2.1")];
        const first = loadPlugins();
        settings.plugins = [stored("overlap-b", "2.1"), stored("overlap-a", "2.1")];
        await Promise.all([first, loadPlugins()]);
        expect(mocks.alertError.mock.calls).toEqual([[reported("overlap-a (API 2.1)", "overlap-b (API 2.1)")]]);
    });

    it("never reports when only 3.0 plugins are enabled", async () => {
        settings.plugins = [stored("only-v3", "3.0"), stored("only-off", "2.1", "old script", false)];
        await loadPlugins();
        expect(mocks.alertError).not.toHaveBeenCalled();
    });

    it("only logs while a plugin hot-reloads", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        hotReloading.push("someone");
        try {
            settings.plugins = [stored("hot-legacy", "2.1")];
            await loadPlugins();
        } finally {
            hotReloading.length = 0;
        }
        expect(mocks.alertError).not.toHaveBeenCalled();
        expect(logged).toHaveBeenCalledWith(reported("hot-legacy (API 2.1)"));
        logged.mockRestore();
    });
});
