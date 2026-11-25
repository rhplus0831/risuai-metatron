// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RisuPlugin } from "src/ts/plugins/plugins.svelte";

const boundary = vi.hoisted(() => ({
    fetch: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: (path, init, options) => {
            options?.beforeDispatch?.();
            return boundary.fetch!(path, init);
        },
    }),
);
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { language } from "src/lang";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { installBootRecords } from "src/ts/bootstrap";
import { applyRaw } from "src/ts/storage/records.svelte";
import { readKinds } from "src/ts/storage/resourceClient";
import { flushResources, seedResources, startResourceSync, stopResourceSync } from "src/ts/storage/resourceSync.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { StoreBackedServer } from "src/ts/storage/tests/storeBackedServer";
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

it("keeps the last finite plain int through a blank draft and save, then saves a later number", async () => {
    settings.plugins[0].argMeta.mode = {};
    const fake = await StoreBackedServer.create();
    boundary.fetch = fake.fetch;
    try {
        fake.set("plugins", "main", JSON.parse(JSON.stringify(settings.plugins)));
        const snapshot = await readKinds(Object.values(RESOURCE_KIND));
        seedResources(snapshot);
        installBootRecords(snapshot);
        startResourceSync();
        flushSync();
        const input = target.querySelector<HTMLInputElement>('input[type="number"]')!;
        const type = (value: string) => {
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            flushSync();
        };
        input.focus();
        type("7");
        expect(settings.plugins[0].realArg.mode).toBe(7);
        type("");
        expect(input.value).toBe("");
        expect(settings.plugins[0].realArg.mode).toBe(7);

        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        flushSync();
        expect(input.value).toBe("7");
        await tick();
        await flushResources();
        expect(fake.record("plugins", "main")!.data[0].realArg).toEqual({ mode: 7 });

        input.focus();
        type("12");
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        await tick();
        await flushResources();
        expect(fake.record("plugins", "main")!.data[0].realArg).toEqual({ mode: 12 });
    } finally {
        stopResourceSync();
        boundary.fetch = null;
        fake.close();
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
