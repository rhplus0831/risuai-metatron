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

vi.mock("src/ts/alert", () => ({
    alertConfirm: mocks.alertConfirm,
    alertError: mocks.alertError,
}));

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
