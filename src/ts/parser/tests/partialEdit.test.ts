import { describe, expect, it } from "vitest";
import { findAllOriginalRangesFromHtml, findAllOriginalRangesFromText, replaceRange } from "../partialEdit";

/*
 * The partial-edit matcher's source targeting: every distinct occurrence of the selection comes
 * back, on one source line too, so the controller can ask which one; a selection ending in a
 * typographic ellipsis maps to the ellipsis character only, never to the character after it.
 */
const spans = (original: string, matches: { start: number; end: number }[]) =>
    matches.map((match) => [match.start, match.end, original.slice(match.start, match.end)]);

describe("findAllOriginalRangesFromText occurrences", () => {
    it("answers both identical occurrences on one source line, in position order", () => {
        const original = "one apple; two apple";
        const matches = findAllOriginalRangesFromText(original, "apple");
        expect(spans(original, matches)).toEqual([
            [4, 9, "apple"],
            [15, 20, "apple"],
        ]);
        expect(matches.map((match) => [match.method, match.confidence, match.lineNumber])).toEqual([
            ["exact", 1, 1],
            ["exact", 1, 1],
        ]);
        expect(replaceRange(original, matches[1], "EDIT")).toBe("one apple; two EDIT");
    });

    it("still answers both when the occurrences sit on different lines", () => {
        const original = "one apple\ntwo apple";
        expect(spans(original, findAllOriginalRangesFromText(original, "apple"))).toEqual([
            [4, 9, "apple"],
            [14, 19, "apple"],
        ]);
    });

    it("answers two identical rendered blocks on one line from the block's HTML", () => {
        const original = "<p>Hello</p><p>Hello</p>";
        const block = document.createElement("p");
        block.textContent = "Hello";
        const matches = findAllOriginalRangesFromHtml(original, block);
        expect(spans(original, matches)).toEqual([
            [3, 8, "Hello"],
            [15, 20, "Hello"],
        ]);
        expect(replaceRange(original, matches[1], "EDIT")).toBe("<p>Hello</p><p>EDIT</p>");
    });

    it("caps the answer at maxResults from the start of the line", () => {
        const original = Array.from({ length: 12 }, (_, i) => `w${i} apple`).join(" ");
        const matches = findAllOriginalRangesFromText(original, "apple", { maxResults: 10 });
        expect(matches).toHaveLength(10);
        expect(matches.map((match) => match.start)).toEqual(
            [...matches.map((match) => match.start)].sort((a, b) => a - b),
        );
        expect(matches[0].start).toBe(original.indexOf("apple"));
    });
});

describe("findAllOriginalRangesFromText ellipsis", () => {
    it.each([
        ["before text", "Wait…Next", "Wait…", [0, 5], "EDITNext"],
        ["before a space", "Wait… Next", "Wait…", [0, 5], "EDIT Next"],
        ["before a paragraph break", "Hello…\n\nNext", "Hello…", [0, 6], "EDIT\n\nNext"],
        ["before another ellipsis", "Wait……Next", "Wait…", [0, 5], "EDIT…Next"],
        ["at the end of the message", "Wait…", "Wait…", [0, 5], "EDIT"],
        ["selected as three ASCII dots", "Wait…Next", "Wait...", [0, 5], "EDITNext"],
    ])("maps a selection ending in an ellipsis %s to the ellipsis only", (_, original, selection, span, edited) => {
        const matches = findAllOriginalRangesFromText(original, selection);
        expect(spans(original, matches)).toEqual([[span[0], span[1], original.slice(span[0], span[1])]]);
        expect(matches[0].method).toBe("exact");
        expect(replaceRange(original, matches[0], "EDIT")).toBe(edited);
    });

    it("keeps three ASCII dots in the source as three characters, for either spelling of the selection", () => {
        const original = "Wait...Next";
        for (const selection of ["Wait...", "Wait…"]) {
            const matches = findAllOriginalRangesFromText(original, selection);
            expect(spans(original, matches)).toEqual([[0, 7, "Wait..."]]);
            expect(replaceRange(original, matches[0], "EDIT")).toBe("EDITNext");
        }
    });

    it("keeps the whole ruby source for its rendered text", () => {
        const original = "{{ruby::漢字::かんじ}}";
        const matches = findAllOriginalRangesFromText(original, "漢字(かんじ)");
        expect(spans(original, matches)).toEqual([[0, 17, original]]);
    });
});
