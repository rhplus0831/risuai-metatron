import { describe, expect, it } from "vitest";

import { MATCH_SCORE, matchesAny, matchText, prepareQuery, type PreparedQuery } from "./koreanSearch";

function query(text: string): PreparedQuery {
    const prepared = prepareQuery(text);
    if (!prepared) throw new Error(`empty query: ${JSON.stringify(text)}`);
    return prepared;
}

function score(text: string, q: string): number {
    return matchText(text, query(q));
}

describe("prepareQuery", () => {
    it("answers null for an empty or whitespace-only query", () => {
        expect(prepareQuery("")).toBeNull();
        expect(prepareQuery("   ")).toBeNull();
        expect(prepareQuery(" \t\n ")).toBeNull();
    });

    it("normalizes to NFC, lowercases, and removes whitespace", () => {
        expect(query("  Long NA ").text).toBe("longna");
        // 해 as decomposed jamo (NFD) composes to the precomposed syllable.
        expect(query("해적").text).toBe("해적");
    });
});

describe("matchText", () => {
    it("matches 해적 by choseong, the half-composed syllable, the word itself, a longer word, and QWERTY", () => {
        for (const q of ["ㅎㅈ", "해저", "해적", "gowjr"]) {
            expect(score("해적", q), q).toBeGreaterThan(0);
        }
        expect(score("바다해적", "해적")).toBeGreaterThan(0);
    });

    it("does not match 해적 with another initial or another vowel", () => {
        expect(score("해적", "ㅎㅂ")).toBe(0);
        expect(score("해적", "해자")).toBe(0);
    });

    it("matches English case- and space-insensitively", () => {
        expect(score("Long Name", "longna")).toBeGreaterThan(0);
        expect(score("long name", "LONG NAME")).toBeGreaterThan(0);
        expect(score("Long Name", "gname")).toBe(MATCH_SCORE.spaceInsensitive);
        expect(score("Long Name", "short")).toBe(0);
    });

    it("folds a final sigma so Greek matches in either case", () => {
        expect(score("ΟΣΚΑΡ", "ΟΣ")).toBe(MATCH_SCORE.prefix);
        expect(score("οσκαρ", "ΟΣ")).toBe(MATCH_SCORE.prefix);
    });

    it("ranks one text per tier in the documented order", () => {
        const tiers: [keyof typeof MATCH_SCORE, string, string][] = [
            ["exact", "해적", "해적"],
            ["prefix", "해적선", "해적"],
            ["substring", "바다해적", "해적"],
            ["spaceInsensitive", "바다 해 적", "해적"],
            ["choseong", "바다해적", "ㅎㅈ"],
            // 해저기 is ㅎㅐ ㅈㅓ ㄱㅣ: the query's jamo run, but not its syllables.
            ["jamo", "해저기", "해적"],
            ["qwerty", "바다해적", "gowjr"],
        ];
        const scores = tiers.map(([tier, text, q]) => {
            const actual = score(text, q);
            expect(actual, tier).toBe(MATCH_SCORE[tier]);
            return actual;
        });
        for (let i = 1; i < scores.length; i++) {
            expect(scores[i - 1]).toBeGreaterThan(scores[i]);
        }
    });

    it("matches a lone jamo by choseong only", () => {
        expect(score("해적", "ㅎ")).toBe(MATCH_SCORE.choseong);
        // ㅎ is 좋다's final consonant, not an initial.
        expect(score("좋다", "ㅎ")).toBe(0);
    });

    it("keeps Shift-typed double consonants in the QWERTY conversion", () => {
        expect(score("까치", "Rkcl")).toBe(MATCH_SCORE.qwerty);
        // A capitalized first letter that is not a Shift key still converts.
        expect(score("해적", "Gowjr")).toBe(MATCH_SCORE.qwerty);
    });

    it("matches decomposed (NFD) text", () => {
        expect(score("해적", "ㅎㅈ")).toBe(MATCH_SCORE.choseong);
    });
});

describe("matchesAny", () => {
    it("answers whether any defined text matches", () => {
        expect(matchesAny([undefined, "바다", "해적선"], query("ㅎㅈ"))).toBe(true);
        expect(matchesAny([undefined, "바다"], query("ㅎㅈ"))).toBe(false);
        expect(matchesAny([], query("ㅎㅈ"))).toBe(false);
    });
});
