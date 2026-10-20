// Korean-aware text matching for list filters and settings search.
// Derived forms of each text are computed per call and never cached: a cache keyed
// by text would keep every searched name alive.
import { canBeChoseong, convertQwertyToHangul, disassemble, getChoseong } from "es-hangul";

export interface PreparedQuery {
    /** NFC, trimmed, lowercased, whitespace removed. */
    text: string;
    /** `disassemble(text)`: matches a half-composed last syllable. */
    jamo: string;
    /** Every character is an initial consonant (ㅎㅈ for 해적). */
    choseong: boolean;
    /** Hangul typed on a QWERTY layout (`gowjr` → 해적), only for all-Latin queries. */
    qwerty: string[];
}

/** Scores `matchText` returns, best first; 0 is no match. */
export const MATCH_SCORE = {
    exact: 7,
    prefix: 6,
    substring: 5,
    spaceInsensitive: 4,
    choseong: 3,
    jamo: 2,
    qwerty: 1,
} as const;

const WHITESPACE = /\s+/gu;
const LATIN_LETTERS = /^[a-z]+$/i;
const FINAL_SIGMA = /ς/gu;

// `toLowerCase` maps a word-final Σ to ς, so a query that ends where the text
// goes on would miss; folding ς to σ makes the mapping context-free.
function foldCase(text: string): string {
    return text.toLowerCase().replace(FINAL_SIGMA, "σ");
}

export function prepareQuery(query: string): PreparedQuery | null {
    const typed = query.normalize("NFC").replace(WHITESPACE, "");
    if (typed === "") return null;
    const text = foldCase(typed);
    const qwerty: string[] = [];
    if (LATIN_LETTERS.test(typed)) {
        // Shift keys type double consonants and ㅒ/ㅖ, so the typed case comes
        // first; the lowercased form covers a capitalized first letter.
        for (const keys of [typed, text]) {
            let converted: string;
            try {
                converted = convertQwertyToHangul(keys);
            } catch {
                // `convertQwertyToHangul` throws on key runs it cannot assemble (`jinja`); such
                // a query is not Hangul typed in English mode, so it only loses this tier.
                continue;
            }
            if (converted !== "" && !qwerty.includes(converted)) qwerty.push(converted);
        }
    }
    return {
        text,
        jamo: disassemble(text),
        choseong: [...text].every((char) => canBeChoseong(char)),
        qwerty,
    };
}

export function matchText(text: string, query: PreparedQuery): number {
    const lowered = foldCase(text.normalize("NFC"));
    const compact = lowered.replace(WHITESPACE, "");
    const q = query.text;
    // The query has no whitespace, so exact and prefix ignore the text's too: a
    // multi-word label is still reachable by those tiers.
    if (compact === q) return MATCH_SCORE.exact;
    if (compact.startsWith(q)) return MATCH_SCORE.prefix;
    if (lowered.includes(q)) return MATCH_SCORE.substring;
    if (compact.includes(q)) return MATCH_SCORE.spaceInsensitive;
    if (query.choseong) {
        // An all-choseong query matches initials only, never a final consonant
        // (ㅎ does not find 좋다).
        return getChoseong(compact, { keepNonHangul: true }).includes(q) ? MATCH_SCORE.choseong : 0;
    }
    if (disassemble(compact).includes(query.jamo)) return MATCH_SCORE.jamo;
    if (query.qwerty.some((converted) => compact.includes(converted))) return MATCH_SCORE.qwerty;
    return 0;
}

export function matchesAny(texts: (string | undefined)[], query: PreparedQuery): boolean {
    return texts.some((text) => text !== undefined && matchText(text, query) > 0);
}
