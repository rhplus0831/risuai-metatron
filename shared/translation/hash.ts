import { textHash } from "../textHash.ts";

/**
 * The source hash of a stored translation (`MessageTranslation.sourceHash`): cyrb53 with seed 0 over
 * the text's UTF-16 code units, a 53-bit value written as 14 lowercase hexadecimal digits.
 *
 * Synchronous and without `crypto.subtle`: the tab computes it while rendering, and plain-HTTP
 * origins have no `crypto.subtle`. It is not a security boundary, only an "is this still the text
 * that was translated" check. Stored translations carry it, so changing the algorithm makes every
 * stored translation stale.
 */
export function translationSourceHash(text: string): string {
    return textHash(text);
}
