/** The retired command consumes the rest of its pipeline, including any legacy pipe separators. */
export function isRetiredMultisend(segment: string): boolean {
    return /^\s*\/?multisend(?=[\s|]|$)/.test(segment);
}
