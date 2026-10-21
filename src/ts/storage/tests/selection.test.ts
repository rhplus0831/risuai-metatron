// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

// The per-client selection store (`selection.svelte.ts`). It is browser state, never sent to the
// server: `sessionStorage` holds this tab's choice (read first), `localStorage` the browser's last
// choice (the start of a new tab). Storage that is missing, throws, or holds junk must never break
// the app: the selection then starts empty and is resolved against the collections
// (`reconcileSelection`). The stored shape holds the prompt preset, the model preset, the persona,
// and the lorebook page.

import {
    loadSelection,
    persistSelection,
    selection,
    selectLoreBookPage,
    selectModelPreset,
    selectPersona,
    selectPreset,
} from "../selection.svelte";

const KEY = "risu-selection";
const stored = (storage: Storage) => JSON.parse(storage.getItem(KEY) ?? "null");
// The in-memory selection also holds the tab's character, which is never stored.
const empty = { presetId: "", modelPresetId: "", personaId: "", loreBookPage: 0, characterId: null, chatOpen: false };

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
    selectModelPreset("");
    selectPersona("");
    selectLoreBookPage(0);
    sessionStorage.clear();
    localStorage.clear();
});

describe("loadSelection", () => {
    it("starts empty when nothing is stored", () => {
        loadSelection();
        expect(selection).toEqual(empty);
    });

    it("reads this tab's sessionStorage first and the browser's localStorage otherwise", () => {
        localStorage.setItem(
            KEY,
            JSON.stringify({ presetId: "last", modelPresetId: "last-m", personaId: "last-p", loreBookPage: 2 }),
        );
        loadSelection();
        expect(selection).toEqual({
            presetId: "last",
            modelPresetId: "last-m",
            personaId: "last-p",
            loreBookPage: 2,
            characterId: null,
            chatOpen: false,
        });

        sessionStorage.setItem(
            KEY,
            JSON.stringify({ presetId: "mine", modelPresetId: "mine-m", personaId: "mine-p", loreBookPage: 1 }),
        );
        loadSelection();
        expect(selection).toEqual({
            presetId: "mine",
            modelPresetId: "mine-m",
            personaId: "mine-p",
            loreBookPage: 1,
            characterId: null,
            chatOpen: false,
        });
        // A selection stored before the preset split names no model preset: it starts empty and the
        // views resolve it against the collection.
        sessionStorage.setItem(KEY, JSON.stringify({ presetId: "old", personaId: "old-p", loreBookPage: 0 }));
        loadSelection();
        expect(selection).toEqual({
            presetId: "old",
            modelPresetId: "",
            personaId: "old-p",
            loreBookPage: 0,
            characterId: null,
            chatOpen: false,
        });
    });

    it("falls back field by field on junk: not JSON, not an object, or wrong types", () => {
        for (const junk of ["not json", "[1]", "42", "null", '"text"']) {
            localStorage.setItem(KEY, junk);
            loadSelection();
            expect(selection, junk).toEqual(empty);
        }
        localStorage.setItem(KEY, JSON.stringify({ presetId: 5, modelPresetId: 7, personaId: 6, loreBookPage: "1" }));
        loadSelection();
        expect(selection).toEqual(empty);
        localStorage.setItem(KEY, JSON.stringify({ presetId: "ok", loreBookPage: -1 }));
        loadSelection();
        expect(selection).toEqual({
            presetId: "ok",
            modelPresetId: "",
            personaId: "",
            loreBookPage: 0,
            characterId: null,
            chatOpen: false,
        });
        localStorage.setItem(KEY, JSON.stringify({ presetId: "ok", personaId: "ok-p", loreBookPage: 1.5 }));
        loadSelection();
        expect(selection).toEqual({
            presetId: "ok",
            modelPresetId: "",
            personaId: "ok-p",
            loreBookPage: 0,
            characterId: null,
            chatOpen: false,
        });
        // A junk sessionStorage entry does not hide a good localStorage one.
        sessionStorage.setItem(KEY, "[]");
        localStorage.setItem(KEY, JSON.stringify({ presetId: "good", personaId: "good-p", loreBookPage: 3 }));
        loadSelection();
        expect(selection).toEqual({
            presetId: "good",
            modelPresetId: "",
            personaId: "good-p",
            loreBookPage: 3,
            characterId: null,
            chatOpen: false,
        });
    });

    it("starts empty when storage throws on access", () => {
        withThrowingStorages(() => {
            expect(() => loadSelection()).not.toThrow();
            expect(selection).toEqual(empty);
        });
    });
});

describe("selectPreset, selectModelPreset, selectPersona, and selectLoreBookPage", () => {
    it("write the whole selection to both storages on every change, and nothing for an unchanged value", () => {
        selectPreset("p1");
        expect(stored(sessionStorage)).toEqual({ presetId: "p1", modelPresetId: "", personaId: "", loreBookPage: 0 });
        expect(stored(localStorage)).toEqual({ presetId: "p1", modelPresetId: "", personaId: "", loreBookPage: 0 });

        // The model preset is selected independently of the prompt preset.
        selectModelPreset("m1");
        expect(stored(sessionStorage)).toEqual({ presetId: "p1", modelPresetId: "m1", personaId: "", loreBookPage: 0 });
        expect(selection.presetId).toBe("p1");

        selectPersona("u1");
        expect(stored(sessionStorage)).toEqual({
            presetId: "p1",
            modelPresetId: "m1",
            personaId: "u1",
            loreBookPage: 0,
        });
        expect(stored(localStorage)).toEqual({ presetId: "p1", modelPresetId: "m1", personaId: "u1", loreBookPage: 0 });

        selectLoreBookPage(2);
        expect(stored(sessionStorage)).toEqual({
            presetId: "p1",
            modelPresetId: "m1",
            personaId: "u1",
            loreBookPage: 2,
        });
        expect(stored(localStorage)).toEqual({ presetId: "p1", modelPresetId: "m1", personaId: "u1", loreBookPage: 2 });

        // The same choice again writes nothing.
        sessionStorage.clear();
        localStorage.clear();
        selectPreset("p1");
        selectPersona("u1");
        selectLoreBookPage(2);
        expect(sessionStorage.getItem(KEY)).toBeNull();
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("keep the in-memory selection when storage throws on write", () => {
        withThrowingStorages(() => {
            expect(() => selectPreset("p2")).not.toThrow();
            expect(() => selectModelPreset("m2")).not.toThrow();
            expect(() => selectPersona("u2")).not.toThrow();
            expect(() => selectLoreBookPage(1)).not.toThrow();
            expect(selection).toEqual({
                presetId: "p2",
                modelPresetId: "m2",
                personaId: "u2",
                loreBookPage: 1,
                characterId: null,
                chatOpen: false,
            });
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
            expect(stored(localStorage)).toEqual({ presetId: "p3", modelPresetId: "", personaId: "", loreBookPage: 0 });
            expect(() => loadSelection()).not.toThrow();
            expect(selection.presetId).toBe("p3");
        } finally {
            if (descriptor) {
                Object.defineProperty(window, "sessionStorage", descriptor);
            }
        }
    });
});

describe("persistSelection", () => {
    it("stores a selection for the next load in both storages without applying it here", () => {
        selectPreset("live");
        selectPersona("live-p");
        persistSelection({ presetId: "imported", modelPresetId: "imported-m", personaId: "imported-p" });
        const expected = {
            presetId: "imported",
            modelPresetId: "imported-m",
            personaId: "imported-p",
            loreBookPage: 0,
        };
        expect(stored(sessionStorage)).toEqual(expected);
        expect(stored(localStorage)).toEqual(expected);
        // The live selection is untouched until the reload that follows reads the stored one.
        expect(selection).toEqual({ ...empty, presetId: "live", personaId: "live-p" });
        loadSelection();
        expect(selection).toEqual({ ...empty, ...expected });
    });

    it("survives storages that throw", () => {
        withThrowingStorages(() => {
            expect(() =>
                persistSelection({ presetId: "imported", modelPresetId: "imported-m", personaId: "imported-p" }),
            ).not.toThrow();
        });
    });
});
