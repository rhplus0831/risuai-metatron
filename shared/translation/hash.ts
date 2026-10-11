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
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return value.toString(16).padStart(14, "0");
}
