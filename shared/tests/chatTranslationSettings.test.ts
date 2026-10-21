// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTranslatorPreset } from "../translatorPresets.ts";
import {
    CHAT_TRANSLATION_FIELD_TYPES,
    CHAT_TRANSLATION_FIELDS,
    chatTranslationSummary,
    MAX_BILINGUAL_SENTENCES,
    readChatTranslationSettings,
    resolveTranslatorPreset,
    selectedTranslatorPreset,
} from "../translation/chatSettings.ts";

// The pure readers both sides run over a chat's translation fields. A missing or malformed field
// reads as off; the resolver takes the chat's preset when it names one that exists, else the global
// rule (the selected preset, else the first valid one, else a default), reporting `missing` only
// for a non-blank id that names nothing; the summary projection keeps typed values only, `false`
// and `0` included, and defaults nothing. None of them writes its inputs.

const A = createTranslatorPreset("A", { id: "a", prompt: "A {{slot::content}}" });
const B = createTranslatorPreset("B", { id: "b", prompt: "B {{slot::content}}" });
const MALFORMED = { id: "m", name: "M", steps: [] };

const OFF = {
    translatorPresetId: null,
    autoTranslate: false,
    translateBotOnly: false,
    bilingualDisplay: false,
    bilingualEmphasis: "original",
    bilingualSentences: 0,
};

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
        Object.freeze(value);
        for (const entry of Object.values(value as object)) {
            deepFreeze(entry);
        }
    }
    return value;
}

describe("the field table", () => {
    it("names the six fields with their stored types, in one order, with the bilingual cap at 10", () => {
        expect(CHAT_TRANSLATION_FIELD_TYPES).toEqual({
            translatorPresetId: "string",
            autoTranslate: "boolean",
            translateBotOnly: "boolean",
            bilingualDisplay: "boolean",
            bilingualEmphasis: "string",
            bilingualSentences: "number",
        });
        expect(CHAT_TRANSLATION_FIELDS).toEqual(Object.keys(CHAT_TRANSLATION_FIELD_TYPES));
        expect(MAX_BILINGUAL_SENTENCES).toBe(10);
    });
});

describe("readChatTranslationSettings", () => {
    it("defaults everything for no chat or a chat without the fields", () => {
        expect(readChatTranslationSettings(undefined)).toEqual(OFF);
        expect(readChatTranslationSettings(null)).toEqual(OFF);
        expect(readChatTranslationSettings({})).toEqual(OFF);
        expect(readChatTranslationSettings({ name: "K", message: [] } as never)).toEqual(OFF);
    });

    it("reads each stored field as set, and anything else as off", () => {
        expect(
            readChatTranslationSettings({
                translatorPresetId: "b",
                autoTranslate: true,
                translateBotOnly: true,
                bilingualDisplay: true,
                bilingualEmphasis: "translation",
                bilingualSentences: 3,
            }),
        ).toEqual({
            translatorPresetId: "b",
            autoTranslate: true,
            translateBotOnly: true,
            bilingualDisplay: true,
            bilingualEmphasis: "translation",
            bilingualSentences: 3,
        });
        // The flags: exactly `true`.
        for (const value of [false, "true", 1, null, {}, []]) {
            const read = readChatTranslationSettings({
                autoTranslate: value,
                translateBotOnly: value,
                bilingualDisplay: value,
            } as never);
            expect([read.autoTranslate, read.translateBotOnly, read.bilingualDisplay], JSON.stringify(value)).toEqual([
                false,
                false,
                false,
            ]);
        }
        // The emphasis: one of the two, else `original`.
        expect(readChatTranslationSettings({ bilingualEmphasis: "original" }).bilingualEmphasis).toBe("original");
        for (const value of ["Translation", "weird", "", 1, null, true]) {
            expect(
                readChatTranslationSettings({ bilingualEmphasis: value } as never).bilingualEmphasis,
                JSON.stringify(value),
            ).toBe("original");
        }
        // The sentences: an integer 1–10, else 0 (pair by line).
        expect(readChatTranslationSettings({ bilingualSentences: 1 }).bilingualSentences).toBe(1);
        expect(readChatTranslationSettings({ bilingualSentences: 10 }).bilingualSentences).toBe(10);
        for (const value of [0, 11, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, true]) {
            expect(
                readChatTranslationSettings({ bilingualSentences: value } as never).bilingualSentences,
                JSON.stringify(value),
            ).toBe(0);
        }
        // The preset id: a non-blank string as stored (not trimmed), else null.
        expect(readChatTranslationSettings({ translatorPresetId: " b " }).translatorPresetId).toBe(" b ");
        for (const value of ["", "   ", 5, null, {}, true]) {
            expect(
                readChatTranslationSettings({ translatorPresetId: value } as never).translatorPresetId,
                JSON.stringify(value),
            ).toBeNull();
        }
    });
});

describe("selectedTranslatorPreset (the global rule)", () => {
    it("answers the valid preset whose id is selected, else the first valid one, else a fresh default; never writes", () => {
        const presets = deepFreeze([MALFORMED, A, B]);
        expect(selectedTranslatorPreset(presets, "b")).toBe(B);
        expect(selectedTranslatorPreset(presets, "a")).toBe(A);
        // A selection that names nothing valid (gone, malformed, blank, not a string): the first valid one.
        for (const selected of ["gone", "m", "", null, undefined, 3]) {
            expect(selectedTranslatorPreset(presets, selected), JSON.stringify(selected)).toBe(A);
        }
        // No valid preset, or not a list: a default with one step, a fresh id each time.
        const fallback = selectedTranslatorPreset([MALFORMED], "m");
        expect(fallback).toMatchObject({ name: "Default" });
        expect(fallback.steps).toHaveLength(1);
        expect(selectedTranslatorPreset([], "a").name).toBe("Default");
        expect(selectedTranslatorPreset(undefined, "a").name).toBe("Default");
        expect(selectedTranslatorPreset({ a: A }, "a").name).toBe("Default");
        expect(selectedTranslatorPreset([], "a").id).not.toBe(selectedTranslatorPreset([], "a").id);
        expect(presets).toEqual([MALFORMED, A, B]);
    });
});

describe("resolveTranslatorPreset", () => {
    const presets = deepFreeze([MALFORMED, A, B]);

    it("takes the chat's own preset when it exists, the same object, whatever the global selection", () => {
        expect(resolveTranslatorPreset({ translatorPresetId: "b" }, presets, "a")).toEqual({
            preset: B,
            source: "chat",
            missing: false,
        });
        expect(resolveTranslatorPreset({ translatorPresetId: "b" }, presets, "a").preset).toBe(B);
        expect(resolveTranslatorPreset({ translatorPresetId: "a" }, presets, "b").preset).toBe(A);
        // The chat naming the global selection is still the chat's own.
        expect(resolveTranslatorPreset({ translatorPresetId: "a" }, presets, "a").source).toBe("chat");
    });

    it("falls back to the global selection for no chat, a chat without a preset, or a blank or non-string id, without `missing`", () => {
        const global = { preset: A, source: "global", missing: false };
        expect(resolveTranslatorPreset(undefined, presets, "a")).toEqual(global);
        expect(resolveTranslatorPreset(null, presets, "a")).toEqual(global);
        expect(resolveTranslatorPreset({}, presets, "a")).toEqual(global);
        expect(resolveTranslatorPreset({ autoTranslate: true }, presets, "a")).toEqual(global);
        for (const id of ["", "  ", 5, null, {}, false]) {
            expect(
                resolveTranslatorPreset({ translatorPresetId: id } as never, presets, "a"),
                JSON.stringify(id),
            ).toEqual(global);
        }
        expect(resolveTranslatorPreset({}, presets, "b").preset).toBe(B);
        expect(resolveTranslatorPreset({}, presets, "gone").preset).toBe(A);
    });

    it("reports `missing` and uses the global selection for an id that names no preset, a malformed one, or one in a list that is not a list", () => {
        expect(resolveTranslatorPreset({ translatorPresetId: "gone" }, presets, "b")).toEqual({
            preset: B,
            source: "global",
            missing: true,
        });
        // A malformed entry under the chat's id is not a preset the chat can use.
        expect(resolveTranslatorPreset({ translatorPresetId: "m" }, presets, "a")).toEqual({
            preset: A,
            source: "global",
            missing: true,
        });
        // A padded id names nothing (ids are compared as stored).
        expect(resolveTranslatorPreset({ translatorPresetId: " b " }, presets, "a").missing).toBe(true);
        // An empty list or no list: missing, and the default preset.
        const empty = resolveTranslatorPreset({ translatorPresetId: "b" }, [], "b");
        expect(empty).toMatchObject({ source: "global", missing: true, preset: { name: "Default" } });
        expect(resolveTranslatorPreset({ translatorPresetId: "b" }, undefined, "b")).toMatchObject({
            source: "global",
            missing: true,
            preset: { name: "Default" },
        });
        expect(resolveTranslatorPreset({}, "nope" as never, "b")).toMatchObject({
            source: "global",
            missing: false,
            preset: { name: "Default" },
        });
    });

    it("writes neither the chat nor the presets", () => {
        const chat = deepFreeze({ translatorPresetId: "gone", autoTranslate: true });
        const before = JSON.stringify([chat, presets]);
        resolveTranslatorPreset(chat, presets, "a");
        resolveTranslatorPreset(chat, presets, "gone");
        readChatTranslationSettings(chat);
        chatTranslationSummary(chat);
        expect(JSON.stringify([chat, presets])).toBe(before);
    });
});

describe("chatTranslationSummary", () => {
    it("keeps each stored field of its type, `false` and `0` included, drops the others, and defaults nothing", () => {
        expect(chatTranslationSummary({})).toEqual({});
        expect(chatTranslationSummary({ name: "K", message: [], fmIndex: 2 })).toEqual({});
        const full = {
            translatorPresetId: "b",
            autoTranslate: false,
            translateBotOnly: true,
            bilingualDisplay: false,
            bilingualEmphasis: "translation",
            bilingualSentences: 0,
        };
        expect(chatTranslationSummary({ ...full, name: "K", note: "n" })).toEqual(full);
        expect(Object.keys(chatTranslationSummary(full))).toEqual(Object.keys(full));
        // A wrong type is left out, never coerced or defaulted; a padded id and an out-of-range number
        // are typed values, kept as stored (the reader defaults them).
        expect(
            chatTranslationSummary({
                translatorPresetId: 5,
                autoTranslate: "true",
                translateBotOnly: null,
                bilingualDisplay: 1,
                bilingualEmphasis: true,
                bilingualSentences: "3",
            }),
        ).toEqual({});
        expect(
            chatTranslationSummary({ translatorPresetId: " b ", bilingualEmphasis: "weird", bilingualSentences: 99 }),
        ).toEqual({ translatorPresetId: " b ", bilingualEmphasis: "weird", bilingualSentences: 99 });
        // A blank id is a string too: the summary carries it and the reader reads it as none.
        expect(chatTranslationSummary({ translatorPresetId: "" })).toEqual({ translatorPresetId: "" });
        expect(readChatTranslationSettings(chatTranslationSummary({ translatorPresetId: "" })).translatorPresetId).toBe(
            null,
        );
    });
});
