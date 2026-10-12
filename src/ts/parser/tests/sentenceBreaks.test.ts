import { describe, expect, it } from "vitest";
import { MAX_BILINGUAL_SENTENCES } from "../../../../shared/translation/chatSettings.ts";
import { insertSentenceParagraphBreaks } from "../sentenceBreaks";

/* The bilingual display's sentence pairing (`docs/plan/translation.md` slice 2.4). */
describe("insertSentenceParagraphBreaks", () => {
    it("splits a prose line every N sentences", () => {
        expect(insertSentenceParagraphBreaks("One. Two. Three. Four.", 2, "en")).toBe("One. Two.\n\nThree. Four.");
        expect(insertSentenceParagraphBreaks("One. Two. Three.", 1, "en")).toBe("One.\n\nTwo.\n\nThree.");
    });

    it("leaves the text alone below one sentence or with no more sentences than N", () => {
        expect(insertSentenceParagraphBreaks("One. Two.", 0, "en")).toBe("One. Two.");
        expect(insertSentenceParagraphBreaks("One. Two.", Number.NaN, "en")).toBe("One. Two.");
        expect(insertSentenceParagraphBreaks("One. Two.", 2, "en")).toBe("One. Two.");
    });

    it("caps N at MAX_BILINGUAL_SENTENCES", () => {
        const sentences = Array.from({ length: MAX_BILINGUAL_SENTENCES + 1 }, (_, index) => `S${index}.`);
        const result = insertSentenceParagraphBreaks(sentences.join(" "), 50, "en");
        expect(result.split("\n\n")).toEqual([
            sentences.slice(0, MAX_BILINGUAL_SENTENCES).join(" "),
            sentences[MAX_BILINGUAL_SENTENCES],
        ]);
    });

    it("never breaks inside an open quote", () => {
        expect(insertSentenceParagraphBreaks('"One. Two." Three.', 1, "en")).toBe('"One. Two."\n\nThree.');
    });

    it("keeps code fences, HTML, headings, lists, quotes, tables, and rules as they are", () => {
        const kept = [
            "```",
            "One. Two. Three.",
            "```",
            "<div>One. Two.</div>",
            "# One. Two.",
            "- One. Two.",
            "1. One. Two.",
            "> One. Two.",
            "| One. Two. |",
            "---",
        ].join("\n");
        expect(insertSentenceParagraphBreaks(kept, 1, "en")).toBe(kept);
    });

    it("never splits inside inline code, a URL, a tag, or a CBS call", () => {
        expect(insertSentenceParagraphBreaks("See `a. b` here. Next.", 1, "en")).toBe("See `a. b` here.\n\nNext.");
        expect(insertSentenceParagraphBreaks("Go to https://a.example/x.y now. Next.", 1, "en")).toBe(
            "Go to https://a.example/x.y now.\n\nNext.",
        );
        expect(insertSentenceParagraphBreaks("Say {{getvar::a. b}} now. Next.", 1, "en")).toBe(
            "Say {{getvar::a. b}} now.\n\nNext.",
        );
    });
});
