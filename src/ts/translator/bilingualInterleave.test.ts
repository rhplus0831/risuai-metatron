/*
 * The bilingual display's pure helpers, ported from the Fastify fork with its cases; the pruning
 * cases are new.
 */
import { describe, expect, it } from "vitest";
import {
    BILINGUAL_MUTED_CLASS,
    BILINGUAL_PAIR_CLASS,
    BILINGUAL_TRANSLATION_CLASS,
    bilingualInterleave,
    pruneEmptyBilingualPairs,
} from "./bilingualInterleave";

const wrapped = (text: string, classes: readonly string[]) => `<div class="${classes.join(" ")}">\n\n${text}\n\n</div>`;
const pair = (...sides: string[]) => wrapped(sides.join("\n\n"), [BILINGUAL_PAIR_CLASS]);
const translated = (text: string, muted = false) =>
    wrapped(text, [BILINGUAL_TRANSLATION_CLASS, ...(muted ? [BILINGUAL_MUTED_CLASS] : [])]);
const muted = (text: string) => wrapped(text, [BILINGUAL_MUTED_CLASS]);

describe("bilingualInterleave", () => {
    it("pairs equal non-empty line counts with original emphasized by default", () => {
        expect(bilingualInterleave("Hello\nBye", "안녕하세요\n안녕히 가세요")).toBe(
            [pair("Hello", translated("안녕하세요", true)), pair("Bye", translated("안녕히 가세요", true))].join("\n"),
        );
    });

    it("uses the same output for the default and explicit original emphasis", () => {
        expect(bilingualInterleave("Original", "Translation")).toBe(
            bilingualInterleave("Original", "Translation", { emphasize: "original" }),
        );
    });

    it("puts emphasized translations first and wraps the original as muted", () => {
        expect(bilingualInterleave("Original", "Translation", { emphasize: "translation" })).toBe(
            pair(translated("Translation"), muted("Original")),
        );
    });

    it("appends unmatched original lines when the translation is shorter", () => {
        expect(
            bilingualInterleave(
                "Hello\nI'm Claude\nBye!\nSee you later!",
                "안녕하세요\n저는 클로드입니다. 잘가! 나중에 봐요!",
            ),
        ).toBe(
            [
                pair("Hello", translated("안녕하세요", true)),
                pair("I'm Claude", translated("저는 클로드입니다. 잘가! 나중에 봐요!", true)),
                pair("Bye!"),
                pair("See you later!"),
            ].join("\n"),
        );
    });

    it("puts each unmatched translated line in its own muted pair under original emphasis", () => {
        expect(bilingualInterleave("One", "하나\n둘\n셋")).toBe(
            [pair("One", translated("하나", true)), pair(translated("둘", true)), pair(translated("셋", true))].join(
                "\n",
            ),
        );
    });

    it("keeps unmatched translated lines emphasized under translation emphasis", () => {
        expect(bilingualInterleave("One", "하나\n둘", { emphasize: "translation" })).toBe(
            [pair(translated("하나"), muted("One")), pair(translated("둘"))].join("\n"),
        );
    });

    it("preserves the original's blank-line paragraph separation", () => {
        expect(bilingualInterleave("First paragraph\n\nSecond paragraph", "첫 문단\n\n둘째 문단")).toBe(
            [
                pair("First paragraph", translated("첫 문단", true)),
                "",
                pair("Second paragraph", translated("둘째 문단", true)),
            ].join("\n"),
        );
    });

    it("sentence-splits both sides before pairing them positionally", () => {
        const original = "원문 하나. 원문 둘. 원문 셋. 원문 넷. 원문 다섯. 원문 여섯. 원문 일곱. 원문 여덟.";
        const translation =
            "Translation one. Translation two. Translation three. Translation four. Translation five. Translation six. Translation seven. Translation eight.";

        expect(
            bilingualInterleave(original, translation, {
                sentenceBreaks: { sentencesPerParagraph: 3 },
            }),
        ).toBe(
            [
                pair(
                    "원문 하나. 원문 둘. 원문 셋.",
                    translated("Translation one. Translation two. Translation three.", true),
                ),
                "",
                pair(
                    "원문 넷. 원문 다섯. 원문 여섯.",
                    translated("Translation four. Translation five. Translation six.", true),
                ),
                "",
                pair("원문 일곱. 원문 여덟.", translated("Translation seven. Translation eight.", true)),
            ].join("\n"),
        );
    });

    it("keeps authored paragraph pairing when sentence breaks are not requested", () => {
        const original = "원문 하나. 원문 둘. 원문 셋. 원문 넷.";
        const translation = "Translation one. Translation two. Translation three. Translation four.";

        expect(bilingualInterleave(original, translation)).toBe(pair(original, translated(translation, true)));
    });

    it("keeps sentence-split tails unpaired when either side has more chunks", () => {
        const sentenceBreaks = { sentenceBreaks: { sentencesPerParagraph: 3 } };

        expect(
            bilingualInterleave(
                "원문 하나. 원문 둘. 원문 셋. 원문 넷. 원문 다섯. 원문 여섯. 원문 일곱.",
                "Translation one. Translation two. Translation three. Translation four.",
                sentenceBreaks,
            ),
        ).toBe(
            [
                pair(
                    "원문 하나. 원문 둘. 원문 셋.",
                    translated("Translation one. Translation two. Translation three.", true),
                ),
                "",
                pair("원문 넷. 원문 다섯. 원문 여섯.", translated("Translation four.", true)),
                "",
                pair("원문 일곱."),
            ].join("\n"),
        );

        expect(
            bilingualInterleave(
                "원문 하나. 원문 둘. 원문 셋. 원문 넷.",
                "Translation one. Translation two. Translation three. Translation four. Translation five. Translation six. Translation seven.",
                sentenceBreaks,
            ),
        ).toBe(
            [
                pair(
                    "원문 하나. 원문 둘. 원문 셋.",
                    translated("Translation one. Translation two. Translation three.", true),
                ),
                "",
                pair("원문 넷.", translated("Translation four. Translation five. Translation six.", true)),
                pair(translated("Translation seven.", true)),
            ].join("\n"),
        );
    });

    it("treats fenced code blocks as indivisible units on either side", () => {
        const originalFence = '```ts\nconst greeting = "hello"\nconst farewell = "bye"\n```';
        const translatedFence = '```ts\nconst greeting = "안녕"\n```';
        const composite = bilingualInterleave(`Before\n${originalFence}\nAfter`, `이전\n${translatedFence}\n이후`);

        expect(composite).toContain(originalFence);
        expect(composite).toContain(translated(translatedFence, true));
        expect(composite.indexOf(originalFence)).toBeLessThan(composite.indexOf(translated(translatedFence, true)));
        expect(composite.indexOf(translated(translatedFence, true))).toBeLessThan(composite.indexOf("After"));
    });
});

describe("pruneEmptyBilingualPairs", () => {
    const pairHtml = (inner: string) => `<div class="${BILINGUAL_PAIR_CLASS}">${inner}</div>`;
    const sideHtml = (inner: string, classes: readonly string[]) => `<div class="${classes.join(" ")}">${inner}</div>`;

    it("returns HTML without a pair as it is", () => {
        const html = '<style>.x{}</style><p>Hello</p><div class="other"></div>';
        expect(pruneEmptyBilingualPairs(html)).toBe(html);
    });

    it("drops a side that renders nothing and keeps the rest of the pair", () => {
        const html = pairHtml(
            `<p>Hello</p>${sideHtml("<p> </p>", [BILINGUAL_TRANSLATION_CLASS, BILINGUAL_MUTED_CLASS])}`,
        );
        expect(pruneEmptyBilingualPairs(html)).toBe(pairHtml("<p>Hello</p>"));
    });

    it("drops a pair that renders nothing at all", () => {
        const empty = pairHtml(`<p></p>${sideHtml("", [BILINGUAL_TRANSLATION_CLASS, BILINGUAL_MUTED_CLASS])}`);
        expect(pruneEmptyBilingualPairs(`<p>Before</p>${empty}<p>After</p>`)).toBe("<p>Before</p><p>After</p>");
    });

    it("keeps one unmuted side of a pair that only shows an image", () => {
        const html = pairHtml(
            `${sideHtml('<img src="a.png">', [BILINGUAL_TRANSLATION_CLASS])}${sideHtml('<img src="a.png">', [BILINGUAL_MUTED_CLASS])}`,
        );
        expect(pruneEmptyBilingualPairs(html)).toBe(pairHtml(sideHtml('<img src="a.png">', [])));
    });

    it("keeps a leading <style> that a display script restored (a fragment parse, not a document)", () => {
        const html = `<style>.chattext p{color:red}</style>${pairHtml(`<p>Hello</p>${sideHtml("<p></p>", [BILINGUAL_MUTED_CLASS])}`)}`;
        expect(pruneEmptyBilingualPairs(html)).toBe(`<style>.chattext p{color:red}</style>${pairHtml("<p>Hello</p>")}`);
    });
});
