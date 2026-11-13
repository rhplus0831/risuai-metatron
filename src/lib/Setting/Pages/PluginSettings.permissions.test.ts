// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RisuPlugin } from "src/ts/plugins/plugins.svelte";

const mocks = vi.hoisted(() => ({
    loadPlugins: vi.fn<typeof import("src/ts/plugins/plugins.svelte").loadPlugins>(),
    resetPluginPermissions: vi.fn<typeof import("src/ts/plugins/apiV3/v3.svelte").resetPluginPermissions>(),
    checkPluginUpdate: vi.fn<typeof import("src/ts/plugins/plugins.svelte").checkPluginUpdate>(),
    updatePlugin: vi.fn<typeof import("src/ts/plugins/plugins.svelte").updatePlugin>(),
}));

vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({ alertConfirm: vi.fn(async () => true) }),
);
vi.mock("src/ts/plugins/plugins.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/plugins/plugins.svelte")>()),
    loadPlugins: mocks.loadPlugins,
    checkPluginUpdate: mocks.checkPluginUpdate,
    updatePlugin: mocks.updatePlugin,
}));
vi.mock("src/ts/plugins/apiV3/v3.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/plugins/apiV3/v3.svelte")>()),
    resetPluginPermissions: mocks.resetPluginPermissions,
}));

import { language } from "src/lang";
import { alertConfirm } from "src/ts/alert";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { applyRaw } from "src/ts/storage/records.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import PluginSettings from "./PluginSettings.svelte";

let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    vi.clearAllMocks();
    mocks.loadPlugins.mockResolvedValue();
    const plugin: RisuPlugin = {
        name: "reset-plugin",
        script: "plugin script",
        version: "3.0",
        enabled: true,
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
    };
    installFlatDatabase({ characters: [], plugins: [plugin] });
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(PluginSettings, { target });
    flushSync();
});

afterEach(async () => {
    await unmount(instance);
    target.remove();
    vi.useRealTimers();
});

it.each(["fulfills", "rejects"] as const)(
    "reloads plugins after the confirmed permission reset %s",
    async (outcome) => {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const resetting = new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        mocks.resetPluginPermissions.mockReturnValueOnce(resetting);
        const button = [...target.querySelectorAll("button")].find(
            (element) => element.textContent?.trim() === language.pluginResetPermissions,
        );
        expect(button, "Reset permissions button").toBeDefined();

        button!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.resetPluginPermissions).toHaveBeenCalledExactlyOnceWith("reset-plugin", "plugin script");
        expect(mocks.loadPlugins).not.toHaveBeenCalled();

        if (outcome === "fulfills") resolve();
        else reject(new Error("revoke failed"));
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.loadPlugins).toHaveBeenCalledExactlyOnceWith();
    },
);

it("does not update a surviving plugin when the confirmed plugin is removed remotely", async () => {
    const plugin = (name: string): RisuPlugin => ({
        name,
        script: `${name} script`,
        version: "3.0",
        enabled: true,
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        updateURL: `https://example.invalid/${name}`,
    });
    const beta = plugin("beta");
    mocks.checkPluginUpdate.mockResolvedValue({ version: "4.0.0", updateURL: "https://example.invalid/update" });
    settings.plugins = [plugin("alpha"), beta];
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    let answer!: (value: boolean) => void;
    vi.mocked(alertConfirm).mockReturnValueOnce(new Promise<boolean>((resolve) => (answer = resolve)));
    target.querySelector<HTMLButtonElement>("button.text-green-400")!.click();
    expect(alertConfirm).toHaveBeenLastCalledWith(language.pluginUpdateFoundInstallIt);
    applyRaw("plugins", [beta]);
    flushSync();
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(mocks.updatePlugin).not.toHaveBeenCalled();
    expect(settings.plugins).toEqual([beta]);
});
