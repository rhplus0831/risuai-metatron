import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alertCardExport } from "./alert";
import { exportChar } from "./characterCards";
import * as globalApi from "./globalApi.svelte";
import { initHotkey } from "./hotkey";
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
