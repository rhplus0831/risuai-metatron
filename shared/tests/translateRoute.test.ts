// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MessageTranslation } from "../database.ts";
import { translationSourceHash } from "../translation/hash.ts";
import { isTranslateMessageAnswer, TRANSLATE_MESSAGE_PATH } from "../translation/route.ts";

// The contract the tab's caller (`storedTranslation.svelte.ts`) and the server route
// (`server/src/routes/translate.ts`) share. The tab validates every 200 answer with
// `isTranslateMessageAnswer` before it reads it.

const translation: MessageTranslation = {
    text: "ㄱ",
    sourceHash: translationSourceHash("A"),
    targetLanguage: "ko",
    translatedAt: 1,
};

describe("TRANSLATE_MESSAGE_PATH", () => {
    it("is the stored-translation route", () => {
        expect(TRANSLATE_MESSAGE_PATH).toBe("/api/translate/message");
    });
});

describe("isTranslateMessageAnswer", () => {
    it("accepts `applied` and `fresh` with a message translation (an empty text included), and `ignored` with null", () => {
        expect(isTranslateMessageAnswer({ outcome: "applied", translation })).toBe(true);
        expect(isTranslateMessageAnswer({ outcome: "fresh", translation })).toBe(true);
        expect(isTranslateMessageAnswer({ outcome: "applied", translation: { ...translation, text: "" } })).toBe(true);
        expect(
            isTranslateMessageAnswer({
                outcome: "applied",
                translation: { ...translation, presetId: "p", edited: true },
            }),
        ).toBe(true);
        expect(isTranslateMessageAnswer({ outcome: "ignored", translation: null })).toBe(true);
    });

    it("refuses anything else: not an object, an unknown outcome, `ignored` with a translation, or a stored outcome without a valid translation", () => {
        for (const value of [null, undefined, "applied", 1, [], {}]) {
            expect(isTranslateMessageAnswer(value), JSON.stringify(value)).toBe(false);
        }
        expect(isTranslateMessageAnswer({ outcome: "done", translation })).toBe(false);
        expect(isTranslateMessageAnswer({ outcome: "ignored", translation })).toBe(false);
        expect(isTranslateMessageAnswer({ outcome: "ignored" })).toBe(false);
        expect(isTranslateMessageAnswer({ outcome: "applied", translation: null })).toBe(false);
        expect(isTranslateMessageAnswer({ outcome: "applied" })).toBe(false);
        expect(isTranslateMessageAnswer({ outcome: "fresh", translation: { text: "x" } })).toBe(false);
        expect(isTranslateMessageAnswer({ outcome: "applied", translation: { ...translation, sourceHash: "" } })).toBe(
            false,
        );
        expect(
            isTranslateMessageAnswer({ outcome: "applied", translation: { ...translation, translatedAt: "1" } }),
        ).toBe(false);
    });
});
