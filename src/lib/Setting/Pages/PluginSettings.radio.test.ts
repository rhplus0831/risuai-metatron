// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RisuPlugin } from "src/ts/plugins/plugins.svelte";

vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import PluginSettings from "./PluginSettings.svelte";

let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;

beforeEach(() => {
    vi.useFakeTimers();
    const plugin: RisuPlugin = {
        name: "radio-plugin",
        script: "plugin script",
        version: "3.0",
        enabled: true,
        arguments: { mode: "int" },
        realArg: { mode: 0 },
        customLink: [],
        argMeta: { mode: { radio: "Finite|7,Malformed|not-a-number" } },
    };
    installFlatDatabase({ characters: [], plugins: [plugin] });
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(PluginSettings, { target });
    flushSync();
    target.querySelector<HTMLElement>('[role="button"][aria-labelledby="show-params"]')!.click();
    flushSync();
});

afterEach(async () => {
    await unmount(instance);
    target.remove();
    vi.useRealTimers();
});

it("stores a finite int radio value or default 0 for a malformed suffix, and checks the stored option", () => {
    const finite = target.querySelector<HTMLInputElement>('input[alt="Finite"]')!;
    const malformed = target.querySelector<HTMLInputElement>('input[alt="Malformed"]')!;
    expect([finite.checked, malformed.checked]).toEqual([false, true]);

    for (const [option, expected, checked] of [
        [finite, 7, [true, false]],
        [malformed, 0, [false, true]],
    ] as const) {
        option.click();
        flushSync();
        expect(settings.plugins[0].realArg.mode).toBe(expected);
        expect(JSON.parse(JSON.stringify(settings.plugins[0].realArg))).toEqual({ mode: expected });
        expect([finite.checked, malformed.checked]).toEqual(checked);
    }
});
