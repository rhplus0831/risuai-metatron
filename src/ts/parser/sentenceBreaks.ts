import { MAX_BILINGUAL_SENTENCES } from "../../../shared/translation/chatSettings.ts";

/*
 * Paragraph breaks every N sentences (ported from the Fastify fork): the bilingual display pairs the
 * source and its translation by these paragraphs. Pure.
 */

interface QuoteState {
    curlyDepth: number;
    straightOpen: boolean;
}

const INLINE_PROTECTED_PATTERN = /(`+)(.*?)\1|https?:\/\/[^\s<>"']+|<[^>\n]*>|\{\{.*?\}\}/g;

function isHorizontalRule(line: string): boolean {
    return /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isProtectedLine(line: string): boolean {
    return (
        /^\s*$/.test(line) ||
        /^\s*</.test(line) ||
        /^\s*#/.test(line) ||
        /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line) ||
        /^\s*>/.test(line) ||
        /^\s*\|/.test(line) ||
        isHorizontalRule(line)
    );
}

function maskInlineSpans(line: string): { masked: string; restore: (text: string) => string } {
    let tokenPrefix = "RISUINLINESPANTOKEN";
    while (line.includes(tokenPrefix)) tokenPrefix += "X";

    const values: string[] = [];
    const masked = line.replace(INLINE_PROTECTED_PATTERN, (matched) => {
        let protectedValue = matched;
        let trailing = "";

        if (matched.startsWith("http")) {
            const trailingMatch = matched.match(/[.,!;:]+$/);
            if (trailingMatch) {
                trailing = trailingMatch[0];
                protectedValue = matched.slice(0, -trailing.length);
            }
        }

        const token = `${tokenPrefix}${values.length}END`;
        values.push(protectedValue);
        return token + trailing;
    });

    return {
        masked,
        restore: (text) => {
            let restored = text;
            for (let index = 0; index < values.length; index += 1) {
                // Function replacement keeps `$&`-style sequences in the protected span literal.
                restored = restored.replace(`${tokenPrefix}${index}END`, () => values[index]);
            }
            return restored;
        },
    };
}

function isEscaped(text: string, index: number): boolean {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
        backslashes += 1;
    }
    return backslashes % 2 === 1;
}

function updateQuoteState(text: string, state: QuoteState): void {
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"' && !isEscaped(text, index)) {
            state.straightOpen = !state.straightOpen;
        } else if (character === "“") {
            state.curlyDepth += 1;
        } else if (character === "”" && state.curlyDepth > 0) {
            state.curlyDepth -= 1;
        }
    }
}

function quotesAreOpen(state: QuoteState): boolean {
    return state.straightOpen || state.curlyDepth > 0;
}

function splitProseLine(line: string, sentencesPerParagraph: number, segmenter: Intl.Segmenter): string {
    const { masked, restore } = maskInlineSpans(line);
    const sentences = [...segmenter.segment(masked)].map(({ segment }) => segment);
    if (sentences.length <= sentencesPerParagraph) return line;

    const chunks: string[] = [];
    const quoteState: QuoteState = { curlyDepth: 0, straightOpen: false };
    let chunk = "";
    let chunkSentenceCount = 0;

    for (let index = 0; index < sentences.length; index += 1) {
        const sentence = sentences[index];
        chunk += sentence;
        chunkSentenceCount += 1;
        updateQuoteState(sentence, quoteState);

        const hasMoreSentences = index < sentences.length - 1;
        if (hasMoreSentences && chunkSentenceCount >= sentencesPerParagraph && !quotesAreOpen(quoteState)) {
            chunks.push(chunks.length === 0 ? chunk.trimEnd() : chunk.trim());
            chunk = "";
            chunkSentenceCount = 0;
        }
    }

    if (chunk) chunks.push(chunks.length === 0 ? chunk.trimEnd() : chunk.trim());
    return restore(chunks.join("\n\n"));
}

/**
 * Splits each prose line of `text` into paragraphs of `sentencesPerParagraph` sentences (1 to
 * `MAX_BILINGUAL_SENTENCES`; anything below 1 returns the text as it is), with `Intl.Segmenter`. A
 * break never falls inside an open quote. Code fences, HTML, headings, lists, quotes, tables, and rules
 * are kept as they are, and inline code, URLs, tags, and `{{...}}` are never split. Without
 * `Intl.Segmenter` the text is returned as it is.
 */
export function insertSentenceParagraphBreaks(text: string, sentencesPerParagraph: number, locale?: string): string {
    if (!Number.isFinite(sentencesPerParagraph) || sentencesPerParagraph < 1) return text;
    if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return text;

    const clampedSentenceCount = Math.min(MAX_BILINGUAL_SENTENCES, Math.trunc(sentencesPerParagraph));
    let segmenter: Intl.Segmenter;
    try {
        segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
    } catch {
        return text;
    }

    let insideCodeFence = false;
    return text
        .split("\n")
        .map((line) => {
            if (/^\s*```/.test(line)) {
                insideCodeFence = !insideCodeFence;
                return line;
            }
            if (insideCodeFence || isProtectedLine(line)) return line;
            return splitProseLine(line, clampedSentenceCount, segmenter);
        })
        .join("\n");
}
