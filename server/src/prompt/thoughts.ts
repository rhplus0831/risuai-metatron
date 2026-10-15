/**
 * Mirrors the former greedy regex: remove at most one block, from the first exact,
 * case-sensitive <Thoughts> to the last </Thoughts>, with at least one UTF-16 code
 * unit inside. Inner tags stay in the capture; empty blocks stay unchanged.
 * Two index scans keep this linear even with many unmatched opening tags.
 */
export function stripThoughtsBlock(text: string): { text: string; thoughts: string[] } {
    const openingTag = "<Thoughts>";
    const closingTag = "</Thoughts>";
    const openingIndex = text.indexOf(openingTag);
    if (openingIndex < 0) {
        return { text, thoughts: [] };
    }

    const contentStart = openingIndex + openingTag.length;
    const closingIndex = text.lastIndexOf(closingTag);
    if (closingIndex <= contentStart) {
        return { text, thoughts: [] };
    }

    return {
        text: text.slice(0, openingIndex) + text.slice(closingIndex + closingTag.length),
        thoughts: [text.slice(contentStart, closingIndex)],
    };
}
