import { insertSentenceParagraphBreaks } from "../parser/sentenceBreaks";

/**
 * Bilingual display pairs source and stored translation by position before the display transform
 * in `src/lib/ChatScreens/ChatBody.svelte`, then prunes empty pairs after rendering. Sentence
 * grouping uses `src/ts/parser/sentenceBreaks.ts`; styling lives under `.chattext` in `src/styles.css`.
 * Wrapper classes must retain the sanitizer's `x-risu-` prefix so they survive rendering.
 */

/** Marks the translated side independently of emphasis, for post-render pruning. */
export const BILINGUAL_TRANSLATION_CLASS = "x-risu-bilingual-translation";
/** Pair boundary shared by pre-render wrapping and post-render pruning. */
export const BILINGUAL_PAIR_CLASS = "x-risu-bilingual-pair";
/** De-emphasized side; visual-only pair collapse removes it from the surviving side. */
export const BILINGUAL_MUTED_CLASS = "x-risu-bilingual-muted";

const BILINGUAL_SIDE_SELECTOR = `.${BILINGUAL_TRANSLATION_CLASS}, .${BILINGUAL_MUTED_CLASS}`;
const VISUAL_CONTENT_SELECTOR =
    'img, svg, video, audio, iframe, canvas, embed, object, picture, hr, [style*="background"]';

/**
 * Emphasis changes side order as well as muting (default original); sentence grouping is applied
 * independently to both texts before positional pairing, without semantic alignment.
 */
export interface BilingualInterleaveOptions {
    emphasize?: "original" | "translation";
    sentenceBreaks?: {
        sentencesPerParagraph: number;
    };
}

interface BilingualUnit {
    content: string;
    blank: boolean;
}

function splitBilingualUnits(text: string): BilingualUnit[] {
    const lines = text.replaceAll("\r\n", "\n").split("\n");
    const units: BilingualUnit[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!/^\s*```/.test(line)) {
            units.push({ content: line, blank: line.trim().length === 0 });
            continue;
        }

        const fenceLines = [line];
        while (index + 1 < lines.length) {
            index += 1;
            fenceLines.push(lines[index]);
            if (/^\s*```\s*$/.test(lines[index])) break;
        }
        units.push({ content: fenceLines.join("\n"), blank: false });
    }

    return units;
}

function wrappedUnit(content: string, classes: readonly string[]): string {
    return `<div class="${classes.join(" ")}">\n\n${content}\n\n</div>`;
}

function pairedUnit(
    original: string | undefined,
    translation: string | undefined,
    emphasize: "original" | "translation",
): string {
    const sides: string[] = [];
    if (emphasize === "translation") {
        if (translation !== undefined) {
            sides.push(wrappedUnit(translation, [BILINGUAL_TRANSLATION_CLASS]));
        }
        if (original !== undefined) {
            sides.push(wrappedUnit(original, [BILINGUAL_MUTED_CLASS]));
        }
    } else {
        if (original !== undefined) sides.push(original);
        if (translation !== undefined) {
            sides.push(wrappedUnit(translation, [BILINGUAL_TRANSLATION_CLASS, BILINGUAL_MUTED_CLASS]));
        }
    }
    return wrappedUnit(sides.join("\n\n"), [BILINGUAL_PAIR_CLASS]);
}

function hasBilingualRenderedContent(element: Element): boolean {
    return (
        (element.textContent ?? "").trim().length > 0 ||
        element.matches(VISUAL_CONTENT_SELECTOR) ||
        element.querySelector(VISUAL_CONTENT_SELECTOR) !== null
    );
}

function collapseVisualOnlyPair(pair: Element): void {
    if ((pair.textContent ?? "").trim().length > 0) return;

    const sides = [...pair.querySelectorAll(BILINGUAL_SIDE_SELECTOR)];
    if (sides.length === 0) return;

    const hasBareOriginal = [...pair.children].some(
        (child) => !child.matches(BILINGUAL_SIDE_SELECTOR) && hasBilingualRenderedContent(child),
    );
    const kept = hasBareOriginal
        ? null
        : (sides.find(
              (side) =>
                  side.classList.contains(BILINGUAL_MUTED_CLASS) &&
                  !side.classList.contains(BILINGUAL_TRANSLATION_CLASS),
          ) ?? sides[0]);

    for (const side of sides) {
        if (side !== kept) side.remove();
    }
    kept?.classList.remove(BILINGUAL_MUTED_CLASS);
}

/**
 * After rendering: drops each side that renders nothing, then each pair that renders nothing; a pair
 * that only shows visual content (an image) keeps one side, unmuted. Untouched without a pair.
 * Parse as a template fragment so a leading `<style>` restored by display scripts is not lost
 * into a document head. Call `pruneEmptyBilingualPairsIn` when the caller already has a tree.
 */
export function pruneEmptyBilingualPairs(html: string): string {
    if (!html.includes(BILINGUAL_PAIR_CLASS)) return html;

    // A fragment, not a document: a document parse would move a leading `<style>` (CSS a display
    // script restored) into its head, and the body alone would drop it.
    const template = document.createElement("template");
    template.innerHTML = html;
    pruneEmptyBilingualPairsIn(template.content);
    return template.innerHTML;
}

/** `pruneEmptyBilingualPairs` on a parsed tree, in place (a chat row's before its styles are taken out). */
export function pruneEmptyBilingualPairsIn(root: ParentNode): void {
    const pairs = root.querySelectorAll(`.${BILINGUAL_PAIR_CLASS}`);

    for (const pair of pairs) {
        for (const side of pair.querySelectorAll(BILINGUAL_SIDE_SELECTOR)) {
            if (!hasBilingualRenderedContent(side)) side.remove();
        }

        if (!hasBilingualRenderedContent(pair)) {
            pair.remove();
            continue;
        }

        collapseVisualOnlyPair(pair);
    }
}

/**
 * The source and the translation as one Markdown text: each non-blank unit (a line, or a whole code
 * fence) of the source paired with the next non-blank unit of the translation, the leftover
 * translation units appended as pairs of their own; the source's blank lines kept between pairs.
 * `emphasize: "original"` shows the source as it is and the translation muted; `"translation"` the
 * translation first and the source muted. `sentenceBreaks` first splits both texts every N sentences
 * (`insertSentenceParagraphBreaks`).
 */
export function bilingualInterleave(
    originalText: string,
    translatedText: string,
    options: BilingualInterleaveOptions = {},
): string {
    const emphasize = options.emphasize ?? "original";
    const sentenceBreaks = options.sentenceBreaks;
    const preparedOriginalText = sentenceBreaks
        ? insertSentenceParagraphBreaks(originalText, sentenceBreaks.sentencesPerParagraph)
        : originalText;
    const preparedTranslatedText = sentenceBreaks
        ? insertSentenceParagraphBreaks(translatedText, sentenceBreaks.sentencesPerParagraph)
        : translatedText;
    const originalUnits = splitBilingualUnits(preparedOriginalText);
    const translatedUnits = splitBilingualUnits(preparedTranslatedText).filter((unit) => !unit.blank);
    const composite: string[] = [];
    let translatedIndex = 0;

    for (const original of originalUnits) {
        if (original.blank) {
            composite.push(original.content);
            continue;
        }
        const translation = translatedUnits[translatedIndex]?.content;
        composite.push(pairedUnit(original.content, translation, emphasize));
        if (translation !== undefined) {
            translatedIndex += 1;
        }
    }

    while (translatedIndex < translatedUnits.length) {
        composite.push(pairedUnit(undefined, translatedUnits[translatedIndex].content, emphasize));
        translatedIndex += 1;
    }

    return composite.join("\n");
}
