// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

// Phase 3, slice 5: the per-client selection store (`selection.svelte.ts`). It is browser state,
// never sent to the server: `sessionStorage` holds this tab's choice (read first), `localStorage`
// the browser's last choice (the start of a new tab). Storage that is missing, throws, or holds
// junk must never break the app: the selection then starts empty and the forwarding layer resolves
// it against the collections (Astra challenge point 6 and its testing advice).

import { loadSelection, selection, selectLoreBookPage, selectPreset } from "../selection.svelte";

const KEY = "risu-selection";
const stored = (storage: Storage) => JSON.parse(storage.getItem(KEY) ?? "null");

/** Runs `run` while both storages throw on every call (a quota error, a denied private mode). */
function withThrowingStorages(run: () => void) {
    const throwing = new Proxy({} as Storage, {
        get() {
            return () => {
                throw new Error("storage unavailable");
            };
        },
    });
    const descriptors = ["sessionStorage", "localStorage"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(window, name),
    ]) as [string, PropertyDescriptor | undefined][];
    for (const [name] of descriptors) {
        Object.defineProperty(window, name, { configurable: true, get: () => throwing });
    }
    try {
        run();
    } finally {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(window, name, descriptor);
            }
        }
    }
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectLoreBookPage(0);
    sessionStorage.clear();
    localStorage.clear();
});

describe("loadSelection", () => {
    it("starts empty when nothing is stored", () => {
        loadSelection();
        expect(selection).toEqual({ presetId: "", loreBookPage: 0 });
    });

    it("reads this tab's sessionStorage first and the browser's localStorage otherwise", () => {
        localStorage.setItem(KEY, JSON.stringify({ presetId: "last", loreBookPage: 2 }));
        loadSelection();
        expect(selection).toEqual({ presetId: "last", loreBookPage: 2 });

        sessionStorage.setItem(KEY, JSON.stringify({ presetId: "mine", loreBookPage: 1 }));
        loadSelection();
        expect(selection).toEqual({ presetId: "mine", loreBookPage: 1 });
    });

    it("falls back field by field on junk: not JSON, not an object, or wrong types", () => {
        for (const junk of ["not json", "[1]", "42", "null", '"text"']) {
            localStorage.setItem(KEY, junk);
            loadSelection();
            expect(selection, junk).toEqual({ presetId: "", loreBookPage: 0 });
        }
        localStorage.setItem(KEY, JSON.stringify({ presetId: 5, loreBookPage: "1" }));
        loadSelection();
        expect(selection).toEqual({ presetId: "", loreBookPage: 0 });
        localStorage.setItem(KEY, JSON.stringify({ presetId: "ok", loreBookPage: -1 }));
        loadSelection();
        expect(selection).toEqual({ presetId: "ok", loreBookPage: 0 });
        localStorage.setItem(KEY, JSON.stringify({ presetId: "ok", loreBookPage: 1.5 }));
        loadSelection();
        expect(selection).toEqual({ presetId: "ok", loreBookPage: 0 });
        // A junk sessionStorage entry does not hide a good localStorage one.
        sessionStorage.setItem(KEY, "[]");
        localStorage.setItem(KEY, JSON.stringify({ presetId: "good", loreBookPage: 3 }));
        loadSelection();
        expect(selection).toEqual({ presetId: "good", loreBookPage: 3 });
    });

    it("starts empty when storage throws on access", () => {
        withThrowingStorages(() => {
            expect(() => loadSelection()).not.toThrow();
            expect(selection).toEqual({ presetId: "", loreBookPage: 0 });
        });
    });
});

describe("selectPreset and selectLoreBookPage", () => {
    it("write the whole selection to both storages on every change, and nothing for an unchanged value", () => {
        selectPreset("p1");
        expect(stored(sessionStorage)).toEqual({ presetId: "p1", loreBookPage: 0 });
        expect(stored(localStorage)).toEqual({ presetId: "p1", loreBookPage: 0 });

        selectLoreBookPage(2);
        expect(stored(sessionStorage)).toEqual({ presetId: "p1", loreBookPage: 2 });
        expect(stored(localStorage)).toEqual({ presetId: "p1", loreBookPage: 2 });

        // The same choice again writes nothing.
        sessionStorage.clear();
        localStorage.clear();
        selectPreset("p1");
        selectLoreBookPage(2);
        expect(sessionStorage.getItem(KEY)).toBeNull();
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("keep the in-memory selection when storage throws on write", () => {
        withThrowingStorages(() => {
            expect(() => selectPreset("p2")).not.toThrow();
            expect(() => selectLoreBookPage(1)).not.toThrow();
            expect(selection).toEqual({ presetId: "p2", loreBookPage: 1 });
        });
    });

    it("keep the in-memory selection when the storage object itself is unavailable", () => {
        const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
        Object.defineProperty(window, "sessionStorage", {
            configurable: true,
            get() {
                throw new Error("SecurityError");
            },
        });
        try {
            expect(() => selectPreset("p3")).not.toThrow();
            expect(selection.presetId).toBe("p3");
            // The other storage still got the value.
            expect(stored(localStorage)).toEqual({ presetId: "p3", loreBookPage: 0 });
            expect(() => loadSelection()).not.toThrow();
            expect(selection.presetId).toBe("p3");
        } finally {
            if (descriptor) {
                Object.defineProperty(window, "sessionStorage", descriptor);
            }
        }
    });
});
