// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The popup editor's Monaco/textarea choice is per device: a stored choice wins, a device without one
// starts on the textarea when its pointer is coarse (touch), and a choice storage refuses still holds
// for the page.

const KEY = "risu-popup-editor-monaco";

function setPointer(coarse: boolean) {
    vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) => ({ matches: query === "(pointer: coarse)" && coarse }) as MediaQueryList,
    );
}

async function load() {
    vi.resetModules();
    return import("./popupEditorMode");
}

beforeEach(() => localStorage.clear());
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe("popup editor mode", () => {
    it("starts on Monaco with a fine pointer and on the textarea with a coarse one", async () => {
        setPointer(false);
        expect((await load()).readPopupEditorMonaco()).toBe(true);
        setPointer(true);
        expect((await load()).readPopupEditorMonaco()).toBe(false);
    });

    it("keeps the stored choice over the pointer default", async () => {
        setPointer(true);
        const mode = await load();
        mode.writePopupEditorMonaco(true);
        expect(localStorage.getItem(KEY)).toBe("true");
        expect((await load()).readPopupEditorMonaco()).toBe(true);

        setPointer(false);
        mode.writePopupEditorMonaco(false);
        expect((await load()).readPopupEditorMonaco()).toBe(false);
    });

    it("holds a choice storage refused until the page reloads", async () => {
        setPointer(false);
        const mode = await load();
        const storage = window.localStorage;
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => storage.getItem(key),
            setItem: () => {
                throw new Error("quota");
            },
        });
        mode.writePopupEditorMonaco(false);
        expect(mode.readPopupEditorMonaco()).toBe(false);
        expect(storage.getItem(KEY)).toBeNull();
        expect((await load()).readPopupEditorMonaco()).toBe(true);
    });
});
