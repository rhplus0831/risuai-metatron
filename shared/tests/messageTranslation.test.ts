// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MessageTranslation } from "../database.ts";
import { translationSourceHash } from "../translation/hash.ts";
import { dropInvalidTranslation, isMessageTranslation, storedTranslation } from "../translation/messageTranslation.ts";

// `docs/plan/translation.md`, "Data model" (slice 1.1): the pinned source hash and the read helpers
// both runtimes share. The hash vectors are cyrb53 (seed 0, UTF-16 code units, 14 hex digits) as the
// reference implementation computes them; a change here makes every stored translation stale.

const translation = (text: string, source: string, extra: Partial<MessageTranslation> = {}): MessageTranslation => ({
    text,
    sourceHash: translationSourceHash(source),
    targetLanguage: "ko",
    translatedAt: 1,
    ...extra,
});

describe("translationSourceHash", () => {
    it("is cyrb53 with seed 0 over the UTF-16 code units, written as 14 lowercase hex digits", () => {
        expect(translationSourceHash("")).toBe("0bdcb81aee8d83");
        expect(translationSourceHash("a")).toBe("1c2ba782c97901");
        expect(translationSourceHash("A")).toBe("0fc47ff46a017d");
        expect(translationSourceHash("Hello, world!")).toBe("0a97f2ae6d011c");
        // Non-ASCII text and a surrogate pair hash by code unit; a lone surrogate is a text too.
        expect(translationSourceHash("안녕하세요 😀")).toBe("177ce0c0f5e7b1");
        expect(translationSourceHash("\ud83d")).toBe("19505fd8ab22d6");
        for (const text of ["", "a", "x".repeat(10_000), "\u0000", "😀😀"]) {
            expect(translationSourceHash(text)).toMatch(/^[0-9a-f]{14}$/);
        }
        expect(translationSourceHash("abc")).not.toBe(translationSourceHash("abd"));
    });
});

describe("isMessageTranslation", () => {
    it("accepts the stored shape with or without the optional fields and with unknown extra keys", () => {
        expect(isMessageTranslation(translation("t", "s"))).toBe(true);
        expect(isMessageTranslation(translation("", "s", { presetId: "p", edited: true }))).toBe(true);
        expect(isMessageTranslation({ ...translation("t", "s"), later: { any: 1 } })).toBe(true);
    });

    it("rejects anything that is not that shape", () => {
        const valid = translation("t", "s");
        const invalid: unknown[] = [
            undefined,
            null,
            "legacy string",
            1,
            [],
            [valid],
            { text: "t" },
            { ...valid, text: 1 },
            { ...valid, sourceHash: "" },
            { ...valid, sourceHash: 5 },
            { ...valid, targetLanguage: undefined },
            { ...valid, translatedAt: "1" },
            { ...valid, translatedAt: Number.NaN },
            { ...valid, translatedAt: Number.POSITIVE_INFINITY },
            { ...valid, presetId: 1 },
            { ...valid, presetId: null },
            { ...valid, edited: "yes" },
            { ...valid, edited: null },
        ];
        for (const value of invalid) {
            expect(isMessageTranslation(value), JSON.stringify(value) ?? String(value)).toBe(false);
        }
    });
});

describe("storedTranslation", () => {
    it("returns the text only while the hash matches the current data, an empty text included", () => {
        const message = { role: "char", data: "Hello", translation: translation("안녕", "Hello") };
        expect(storedTranslation(message)).toBe("안녕");
        // An empty translated text is a fresh translation, not a missing one.
        expect(storedTranslation({ data: "Hello", translation: translation("", "Hello") })).toBe("");
        // Freshness depends on the text alone: the edit is not recorded anywhere else.
        expect(storedTranslation({ ...message, data: "Hello!" })).toBeNull();
        expect(storedTranslation({ ...message, data: "Hello" })).toBe("안녕");
        // The metadata never decides it.
        expect(
            storedTranslation({
                data: "Hello",
                translation: translation("안녕", "Hello", { presetId: "gone", edited: true }),
            }),
        ).toBe("안녕");
    });

    it("returns null for a missing or malformed translation", () => {
        expect(storedTranslation({ data: "Hello" })).toBeNull();
        expect(storedTranslation({ data: "Hello", translation: null })).toBeNull();
        expect(storedTranslation({ data: "Hello", translation: "legacy" })).toBeNull();
        expect(
            storedTranslation({
                data: "Hello",
                translation: { text: "x", sourceHash: translationSourceHash("Hello") },
            }),
        ).toBeNull();
    });
});

describe("dropInvalidTranslation", () => {
    it("removes a translation that is not a MessageTranslation and keeps a valid one, stale included", () => {
        for (const value of [null, undefined, "legacy", { text: "x" }, []]) {
            const message: { data: string; translation?: unknown } = { data: "A", translation: value };
            expect(dropInvalidTranslation(message), String(value)).toBe(true);
            expect(message).toEqual({ data: "A" });
            expect(message).not.toHaveProperty("translation");
        }
        const fresh = { data: "A", translation: translation("ㄱ", "A") };
        expect(dropInvalidTranslation(fresh)).toBe(false);
        expect(fresh.translation).toEqual(translation("ㄱ", "A"));
        const stale = { data: "A edited", translation: translation("ㄱ", "A") };
        expect(dropInvalidTranslation(stale)).toBe(false);
        expect(stale.translation).toEqual(translation("ㄱ", "A"));
        const without: { data: string; translation?: unknown } = { data: "A" };
        expect(dropInvalidTranslation(without)).toBe(false);
        expect(without).toEqual({ data: "A" });
    });
});
