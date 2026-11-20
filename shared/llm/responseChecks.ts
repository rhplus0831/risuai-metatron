import type { Database } from "../database.ts";
import type { ModelModeExtended } from "./request.ts";

/**
 * The checks of a completed (buffered) answer that the provider returned as a success: the banned scripts
 * (`Database.banCharacterset`) and the minimum length of the request's kind. Both outer request loops
 * (`server/src/llm/outer.ts` `requestChatDataOuter`, `src/ts/process/request/request.ts` `requestChatData`) call
 * `responseRejection` and treat a message as a failed attempt, so the tab and a server job reject the same answers
 * with the same text.
 */

/** The settings field holding each request kind's minimum answer length (0: no minimum). */
export const MIN_RESPONSE_LENGTH_FIELDS = {
    model: "minResponseLengthModel",
    submodel: "minResponseLengthSubmodel",
    memory: "minResponseLengthMemory",
    emotion: "minResponseLengthEmotion",
    otherAx: "minResponseLengthOtherAx",
    translate: "minResponseLengthTranslate",
} as const satisfies Record<ModelModeExtended, keyof Database>;

export type MinResponseLengthField = (typeof MIN_RESPONSE_LENGTH_FIELDS)[ModelModeExtended];

/** The largest minimum a field can hold. */
export const MAX_MIN_RESPONSE_LENGTH = 100_000;

/**
 * A stored or typed minimum as the whole number that is enforced: 0 (off) for anything that is not a finite number
 * or is below 1, else the value without its fraction, at most `MAX_MIN_RESPONSE_LENGTH`. The server normalizer and
 * `responseRejection` both apply it, so a value that was never normalized is enforced as the stored one would be.
 */
export function normalizeMinResponseLength(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
        return 0;
    }
    return Math.min(Math.trunc(value), MAX_MIN_RESPONSE_LENGTH);
}

/** The settings `responseRejection` reads. */
export type ResponseCheckSettings = Pick<Database, "banCharacterset" | MinResponseLengthField>;

const THOUGHTS_TAG = /<\/?Thoughts>/g;
const THOUGHTS_OPEN = "<Thoughts>";
const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";

/**
 * An inlay marker, with literal braces or with the braces `risuEscape` writes (`{` as U+E9B8, `}` as U+E9B9). An
 * escaped answer has every brace escaped, so a marker never mixes the two spellings.
 */
const INLAY_MARKER =
    /\{\{(?:inlay|inlayed|inlayeddata)::.+?\}\}|\uE9B8\uE9B8(?:inlay|inlayed|inlayeddata)::.+?\uE9B9\uE9B9/g;

/**
 * `text` without its `<Thoughts>…</Thoughts>` blocks, paired as the tab renderer pairs them (`parseThoughtsAndTools`
 * in `src/ts/parser/parser.svelte.ts`): an opening tag closes where the count of exact tags after it returns to
 * zero, so a nested block leaves with its outer block, two blocks in a row leave separately (the text between them
 * stays), and a tag without a partner stays as text. Pairing every closing tag with the nearest open one still
 * waiting gives the same pairs in one pass over the tags.
 */
function removeThoughtsBlocks(text: string): string {
    if (!text.includes("</Thoughts>")) {
        return text;
    }
    // Per opening tag, in text order: where it starts, and where its block ends (-1 without a closing tag).
    const blockStart: number[] = [];
    const blockEnd: number[] = [];
    const waiting: number[] = [];
    for (const tag of text.matchAll(THOUGHTS_TAG)) {
        if (tag[0] === THOUGHTS_OPEN) {
            waiting.push(blockStart.length);
            blockStart.push(tag.index);
            blockEnd.push(-1);
            continue;
        }
        const opening = waiting.pop();
        if (opening !== undefined) {
            blockEnd[opening] = tag.index + tag[0].length;
        }
    }
    let kept = "";
    let cursor = 0;
    for (let block = 0; block < blockStart.length; block++) {
        // A block that starts before the cursor is inside one already removed.
        if (blockEnd[block] < 0 || blockStart[block] < cursor) {
            continue;
        }
        kept += text.slice(cursor, blockStart[block]);
        cursor = blockEnd[block];
    }
    return kept + text.slice(cursor);
}

/** `text` without its `<tool_call>…</tool_call>` records: each runs from an opening tag to the first closing tag. */
function removeToolCallRecords(text: string): string {
    let kept = "";
    let cursor = 0;
    while (true) {
        const start = text.indexOf(TOOL_CALL_OPEN, cursor);
        if (start < 0) {
            break;
        }
        const end = text.indexOf(TOOL_CALL_CLOSE, start + TOOL_CALL_OPEN.length);
        if (end < 0) {
            break;
        }
        kept += text.slice(cursor, start);
        cursor = end + TOOL_CALL_CLOSE.length;
    }
    return kept + text.slice(cursor);
}

/**
 * The length of an answer for the minimum: its Unicode code points after the parts that are not the visible answer
 * are taken out of a copy, in this order: `<Thoughts>` blocks, `<tool_call>` records, and inlay markers
 * (`{{inlay::…}}`, `{{inlayed::…}}`, `{{inlayeddata::…}}`: a thought signature, an image), and the rest is trimmed.
 * The answer may already be escaped (`risuEscape`), so a marker is recognized in both spellings; the text is not
 * unescaped as a whole, which would turn other private-use characters into longer text. An answer that is only an
 * image therefore measures 0.
 */
export function measureResponseLength(text: string): number {
    const visible = removeToolCallRecords(removeThoughtsBlocks(text)).replace(INLAY_MARKER, "").trim();
    return [...visible].length;
}

/**
 * Why a completed answer is rejected, or `null` when it passes.
 *
 * - Banned scripts, for every request: the first entry of `banCharacterset` with a character of that Unicode script
 *   anywhere in `text` as given (thoughts and markers included). An entry that is not a script name throws, as the
 *   regular expression does.
 * - The minimum of the request's kind (`MIN_RESPONSE_LENGTH_FIELDS`, read through `normalizeMinResponseLength`),
 *   against `measureResponseLength`. A continue request is not measured: its answer is only the added text, which
 *   may rightly be a few characters.
 *
 * The caller decides which answers are checked at all: a request whose success is not an answer (`previewBody`)
 * does not call this.
 */
export function responseRejection(
    text: string,
    settings: ResponseCheckSettings,
    request: { mode: ModelModeExtended; continue?: boolean },
): string | null {
    for (const set of settings.banCharacterset ?? []) {
        if (new RegExp(`\\p{Script=${set}}`, "gu").test(text)) {
            return `The model answered in a banned script (${set})`;
        }
    }
    if (request.continue) {
        return null;
    }
    const minimum = normalizeMinResponseLength(settings[MIN_RESPONSE_LENGTH_FIELDS[request.mode]]);
    if (minimum === 0) {
        return null;
    }
    const length = measureResponseLength(text);
    return length < minimum ? `The model's answer was shorter than the minimum (${length} < ${minimum})` : null;
}
