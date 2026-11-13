// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RisuPlugin } from "src/ts/plugins/plugins.svelte";

vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { language } from "src/lang";
import { applyRaw } from "src/ts/storage/records.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { closePopupEditorSession, popUpEditorStore } from "src/ts/stores.svelte";
import PluginSettings from "./PluginSettings.svelte";

let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;
const initialPopup = { ...popUpEditorStore };

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
    Object.assign(popUpEditorStore, initialPopup);
    vi.clearAllTimers();
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

it.each(["reorder", "removal", "replacement"] as const)(
    "discards a duplicate-name plugin's popup draft after outside row %s",
    async (change) => {
        const plugins: RisuPlugin[] = ["first", "second"].map((displayName) => ({
            name: "same-name",
            displayName,
            script: `// ${displayName}`,
            version: "3.0",
            enabled: false,
            arguments: { text: "string" },
            realArg: { text: "same initial" },
            customLink: [],
            argMeta: { text: { textarea: "1" } },
        }));
        applyRaw("plugins", plugins);
        flushSync();
        target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`)!.click();
        flushSync();
        expect(popUpEditorStore).toMatchObject({ open: true, value: "same initial" });
        popUpEditorStore.value = "draft for first";

        // A field update on the same backing row must keep its popup context stable.
        settings.plugins[0].displayName = "renamed first";
        flushSync();
        await vi.advanceTimersByTimeAsync(100);
        expect(popUpEditorStore.open).toBe(true);

        const replacement: RisuPlugin[] = JSON.parse(JSON.stringify(settings.plugins));
        if (change === "reorder") replacement.reverse();
        if (change === "removal") replacement.shift();
        const expected = structuredClone(replacement);
        // A live update replaces raw rows while their record wrappers keep the same paths.
        applyRaw("plugins", replacement);
        flushSync();
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        const stayedOpen = popUpEditorStore.open;
        closePopupEditorSession(popUpEditorStore.sessionId);
        await vi.advanceTimersByTimeAsync(100);
        flushSync();

        expect(JSON.parse(JSON.stringify(settings.plugins))).toEqual(expected);
        expect(stayedOpen).toBe(false);
        expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("same initial");
    },
);
