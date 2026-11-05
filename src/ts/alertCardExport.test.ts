import { flushSync, mount, tick, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AlertComp from "src/lib/Others/AlertComp.svelte";
import { alertCardExport } from "./alert";
import { exportChar } from "./characterCards";
import * as globalApi from "./globalApi.svelte";
import { initHotkey } from "./hotkey";
import { selectCharacter } from "./storage/selection.svelte";
import { installFlatDatabase } from "./storage/tests/installFlatDatabase";
import { alertStore } from "./stores.svelte";

beforeAll(() => {
    initHotkey();
});

beforeEach(() => {
    vi.useFakeTimers();
    installFlatDatabase({
        characters: [
            { chaId: "exported-character", type: "character", name: "Export me", image: "assets/portrait.png" },
        ],
    });
});

afterEach(() => {
    alertStore.answer("");
    alertStore.clearStatus();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("card export dismissal", () => {
    it("cancels on a backdrop click, leaving panel clicks open", async () => {
        selectCharacter("exported-character");
        const target = document.createElement("div");
        document.body.append(target);
        const pending = alertCardExport();
        const settled = vi.fn();
        void pending.then(settled);
        const component = mount(AlertComp, { target });
        try {
            flushSync();
            await tick();
            expect(get(alertStore).type).toBe("cardexport");
            const backdrop = target.querySelector<HTMLElement>("[data-alert-dialog]")!;
            const panel = backdrop.querySelector<HTMLElement>(":scope > div")!;
            panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await tick();
            expect(settled).not.toHaveBeenCalled();
            expect(get(alertStore).type).toBe("cardexport");
            expect(backdrop.isConnected).toBe(true);

            expect(() => backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
            flushSync();
            await tick();
            expect(get(alertStore).type).not.toBe("cardexport");
            expect(target.querySelector("[data-alert-dialog]")).toBeNull();
            await expect(pending).resolves.toEqual({ type: "cancel", type2: expect.any(String) });
        } finally {
            await unmount(component);
            target.remove();
        }
    });

    it("resolves an empty dialog answer with the close button's cancel shape", async () => {
        const pending = alertCardExport();
        expect(get(alertStore).type).toBe("cardexport");
        alertStore.answer("");
        await expect(pending).resolves.toEqual({ type: "cancel", type2: expect.any(String) });
    });

    it("exports nothing when Escape dismisses the character export dialog", async () => {
        const readImage = vi.spyOn(globalApi, "readImage").mockResolvedValue(new Uint8Array());
        const writerInit = vi.spyOn(globalApi.LocalWriter.prototype, "init").mockResolvedValue(true);
        const downloadFile = vi.spyOn(globalApi, "downloadFile").mockResolvedValue(undefined);
        const pending = exportChar("exported-character");
        expect(get(alertStore).type).toBe("cardexport");

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
        await pending;

        expect(readImage).not.toHaveBeenCalled();
        expect(writerInit).not.toHaveBeenCalled();
        expect(downloadFile).not.toHaveBeenCalled();
    });
});
