import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    alertConfirm: vi.fn(async (_message: string) => true),
    loadV3Plugins: vi.fn(async (_plugins: any[]) => {}),
    reviewPluginPermissions: vi.fn(
        async (
            _plugin: { name: string; script: string },
            _options?: { previousScript?: string; installing?: boolean; stillCurrent?: () => boolean },
        ) => false,
    ),
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

// The update check and download go through `globalFetch`.
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/stores.svelte", async () =>
    (await import("src/ts/tests/storesMock")).createStoresMock({
        hotReloading: [] as string[],
    }),
);

vi.mock("./apiV3/v3.svelte", () => ({
    loadV3Plugins: mocks.loadV3Plugins,
    reviewPluginPermissions: mocks.reviewPluginPermissions,
}));

vi.mock("./apiV3/transpiler", () => ({
    pluginCodeTranspiler: vi.fn(async (code: string) => code),
}));

import { changeLanguage, language } from "src/lang";
import { hotReloading } from "src/ts/stores.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { globalFetch } from "src/ts/globalApi.svelte";
import {
    checkPluginUpdate,
    handlePluginInstallViaPlugin,
    importPlugin,
    loadPlugins,
    updatePlugin,
    type RisuPlugin,
} from "./plugins.svelte";
import { pluginHooks } from "./pluginHooks";

// The plugin functions read and write the plugin list through the settings views: the records are
// installed as the app installs them, and `settings.plugins` is that record.
installFlatDatabase({ characters: [], plugins: [] });

const script = (header: string) => `//@name test_plugin\n${header}\nconsole.log("hi");\n`;

beforeEach(() => {
    settings.plugins = [];
    mocks.alertError.mockClear();
    mocks.loadV3Plugins.mockClear();
    mocks.reviewPluginPermissions.mockClear();
    mocks.reviewPluginPermissions.mockResolvedValue(false);
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

describe("importPlugin permission review", () => {
    const body = (version: string) => script(`//@api 3.0\n//@version ${version}`);

    const heldReview = () => {
        let answer!: (saved: boolean) => void;
        mocks.reviewPluginPermissions.mockImplementationOnce(
            () => new Promise<boolean>((resolve) => (answer = resolve)),
        );
        return (saved: boolean) => answer(saved);
    };

    it("shows a new plugin's permission list before it is saved and loaded", async () => {
        const answer = heldReview();
        const importing = importPlugin(body("1.0.0"));
        await vi.waitFor(() => expect(mocks.reviewPluginPermissions).toHaveBeenCalledTimes(1));
        expect(settings.plugins).toEqual([]);
        expect(mocks.loadV3Plugins).not.toHaveBeenCalled();
        answer(true);
        await importing;

        expect(mocks.reviewPluginPermissions).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ name: "test_plugin", script: body("1.0.0") }),
            { previousScript: undefined, installing: true, stillCurrent: expect.any(Function) },
        );
        expect(settings.plugins).toHaveLength(1);
        expect(mocks.loadV3Plugins).toHaveBeenCalledTimes(1);
    });

    it("passes the replaced version's script on an update, so its grants can be carried over", async () => {
        await importPlugin(body("1.0.0"));
        mocks.reviewPluginPermissions.mockClear();

        await importPlugin(body("2.0.0"), { isUpdate: true, originalPluginName: "test_plugin" });

        expect(mocks.reviewPluginPermissions).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ script: body("2.0.0") }),
            { previousScript: body("1.0.0"), installing: true, stillCurrent: expect.any(Function) },
        );
    });

    it("drops an update whose plugin was removed while its permission list was open", async () => {
        await importPlugin(body("1.0.0"));
        mocks.loadV3Plugins.mockClear();
        const answer = heldReview();
        const updating = importPlugin(body("2.0.0"), { isUpdate: true, originalPluginName: "test_plugin" });
        await vi.waitFor(() => expect(mocks.reviewPluginPermissions).toHaveBeenCalledTimes(2));
        settings.plugins = [];
        answer(false);
        await updating;

        expect(settings.plugins).toEqual([]);
        expect(mocks.loadV3Plugins).not.toHaveBeenCalled();
        expect(mocks.alertError).not.toHaveBeenCalled();
    });

    it("installs nothing over a plugin that was replaced while the permission list was open", async () => {
        await importPlugin(body("1.0.0"));
        mocks.loadV3Plugins.mockClear();
        const answer = heldReview();
        const updating = importPlugin(body("2.0.0"), { isUpdate: true, originalPluginName: "test_plugin" });
        await vi.waitFor(() => expect(mocks.reviewPluginPermissions).toHaveBeenCalledTimes(2));
        const stillCurrent = mocks.reviewPluginPermissions.mock.calls[1][1]!.stillCurrent!;
        expect(stillCurrent()).toBe(true);
        // Another tab finished a later update meanwhile.
        settings.plugins = [{ ...settings.plugins[0], script: body("3.0.0"), versionOfPlugin: "3.0.0" }];
        expect(stillCurrent()).toBe(false);
        answer(false);
        await updating;

        expect(settings.plugins.map((p) => p.versionOfPlugin)).toEqual(["3.0.0"]);
        expect(mocks.loadV3Plugins).not.toHaveBeenCalled();
        expect(mocks.alertError).toHaveBeenCalledExactlyOnceWith(language.pluginChangedDuringImport);
    });

    it("installs the plugin and reports the error when saving the permissions fails", async () => {
        mocks.reviewPluginPermissions.mockRejectedValueOnce(new Error("write failed"));

        await importPlugin(body("1.0.0"));

        expect(mocks.alertError).toHaveBeenCalledExactlyOnceWith(
            language.pluginPermissionSaveError.replace("{error}", "Error: write failed"),
        );
        expect(settings.plugins).toHaveLength(1);
        expect(mocks.loadV3Plugins).toHaveBeenCalledTimes(1);
    });

    it("asks nothing for a hot reload, a skipped review, or an update of a plugin that is not installed", async () => {
        await importPlugin(body("1.0.0"), { isHotReload: true });
        // A hot reload lists the plugin in `hotReloading`, which later tests read.
        hotReloading.length = 0;
        await importPlugin(body("1.0.1"), { skipPermissionReview: true });
        settings.plugins = [];
        await importPlugin(body("1.0.2"), { isUpdate: true });

        expect(mocks.reviewPluginPermissions).not.toHaveBeenCalled();
        expect(settings.plugins).toEqual([]);
    });
});

describe("plugin updates through globalFetch", () => {
    const updateURL = "https://plugins.test/test_plugin.js";
    const bytes = (text: string) => ({ ok: true, status: 200, headers: {}, data: new TextEncoder().encode(text) });
    beforeEach(() => vi.mocked(globalFetch).mockClear());

    it("reads the newer version from the first bytes of the update URL", async () => {
        vi.mocked(globalFetch).mockResolvedValueOnce({
            ...bytes("//@name version_probe\n//@version 1.2.0\n"),
            status: 206,
        });
        const plugin = { name: "version_probe", updateURL, versionOfPlugin: "1.0.0" } as RisuPlugin;

        await expect(checkPluginUpdate(plugin)).resolves.toEqual({ version: "1.2.0", updateURL });
        expect(globalFetch).toHaveBeenCalledExactlyOnceWith(updateURL, {
            method: "GET",
            headers: { Range: "bytes=0-512" },
            rawResponse: true,
        });
    });

    it("installs the script the update URL answers in place of the installed one", async () => {
        await importPlugin(script("//@api 3.0\n//@version 1.0.0"));
        vi.mocked(globalFetch).mockResolvedValueOnce(bytes(script("//@api 3.0\n//@version 2.0.0")));

        await expect(updatePlugin({ ...settings.plugins[0], updateURL })).resolves.toBe(true);
        expect(globalFetch).toHaveBeenLastCalledWith(updateURL, { method: "GET", rawResponse: true });
        expect(settings.plugins).toHaveLength(1);
        expect(settings.plugins[0].versionOfPlugin).toBe("2.0.0");
    });
});

describe("handlePluginInstallViaPlugin", () => {
    const plugin: RisuPlugin = {
        name: "Dialog Test Plugin",
        script: 'console.log("incoming script");',
        version: "3.0",
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
    };

    beforeEach(() => {
        mocks.alertConfirm.mockClear();
    });

    describe.each(["en", "ko", "zh-Hant"])("%s confirmations", (locale) => {
        beforeEach(() => changeLanguage(locale));
        afterEach(() => changeLanguage("en"));

        it("names a new plugin using install wording", async () => {
            await handlePluginInstallViaPlugin([{ ...plugin }]);

            expect(mocks.alertConfirm).toHaveBeenCalledTimes(1);
            const message = mocks.alertConfirm.mock.calls[0][0];
            expect(message).toContain(plugin.name);
            expect(message).toBe(language.confirmInstallPluginViaPlugin.replace("{plugin}", plugin.name));
        });

        it("names an installed plugin with a changed script using distinct replace wording", async () => {
            settings.plugins = [{ ...plugin, script: 'console.log("installed script");' }];

            await handlePluginInstallViaPlugin([{ ...plugin }]);

            expect(mocks.alertConfirm).toHaveBeenCalledTimes(1);
            const message = mocks.alertConfirm.mock.calls[0][0];
            expect(message).toContain(plugin.name);
            expect(message).toBe(language.confirmReplacePluginViaPlugin.replace("{plugin}", plugin.name));
        });
    });

    it("does not ask about an installed plugin with the same name and script", async () => {
        settings.plugins = [{ ...plugin }];

        await handlePluginInstallViaPlugin([{ ...plugin }]);

        expect(mocks.alertConfirm).not.toHaveBeenCalled();
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
        // Whichever load finishes hashing first reports, in its own order; the hashes settle on
        // crypto's thread pool, so either order is right. What matters is one alert naming both.
        expect(mocks.alertError.mock.calls).toHaveLength(1);
        expect([
            reported("overlap-a (API 2.1)", "overlap-b (API 2.1)"),
            reported("overlap-b (API 2.1)", "overlap-a (API 2.1)"),
        ]).toContain(mocks.alertError.mock.calls[0][0]);
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
