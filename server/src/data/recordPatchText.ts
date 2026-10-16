import { diffFields, diffItems, itemIds } from "../../../shared/recordPatch.ts";
import type { RecordItemFieldPatch } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";

/** Only JSON whitespace; compact stored text returns immediately, without scanning its contents. */
function skipWhitespace(text: string, start: number): number {
    while (text[start] === " " || text[start] === "\t" || text[start] === "\r" || text[start] === "\n") {
        start++;
    }
    return start;
}

/** End of a JSON string in already validated stored text. Skip its body with native string search. */
function stringEnd(text: string, start: number): number {
    let quote = start;
    for (;;) {
        quote = text.indexOf('"', quote + 1);
        if (quote === -1) {
            throw new SyntaxError("Unterminated JSON string");
        }
        let slash = quote - 1;
        while (text[slash] === "\\") {
            slash--;
        }
        if ((quote - slash) % 2 === 1) {
            return quote + 1;
        }
    }
}

/** End of one value in valid JSON; strings are skipped without scanning their prompt text in JS. */
function valueEnd(text: string, start: number): number {
    if (text[start] === '"') {
        return stringEnd(text, start);
    }
    if (text[start] !== "{" && text[start] !== "[") {
        const delimiter = /[,}\]]/g;
        delimiter.lastIndex = start;
        return delimiter.exec(text)?.index ?? text.length;
    }
    const token = /["{}\[\]]/g;
    token.lastIndex = start + 1;
    let depth = 1;
    for (;;) {
        const match = token.exec(text)!;
        if (match[0] === '"') {
            token.lastIndex = stringEnd(text, match.index);
        } else if (match[0] === "{" || match[0] === "[") {
            depth++;
        } else if (--depth === 0) {
            return token.lastIndex;
        }
    }
}

/** Top-level field texts of a serialized object, parsing only its keys. */
function fields(text: string): Map<string, string> {
    const parts = new Map<string, string>();
    let start = skipWhitespace(text, 1);
    while (text[start] !== "}") {
        if (text[start] !== '"') {
            throw new SyntaxError("Expected a JSON object key");
        }
        const end = stringEnd(text, start);
        const key = JSON.parse(text.slice(start, end)) as string;
        start = skipWhitespace(text, end);
        if (text[start] !== ":") {
            throw new SyntaxError("Expected a JSON object colon");
        }
        start = skipWhitespace(text, start + 1);
        const value = valueEnd(text, start);
        parts.set(key, text.slice(start, value));
        start = skipWhitespace(text, value);
        if (text[start] === "}") {
            break;
        }
        if (text[start] !== ",") {
            throw new SyntaxError("Expected a JSON object separator");
        }
        start = skipWhitespace(text, start + 1);
    }
    return parts;
}

/** Top-level item texts of a serialized array, with no parse of the items. */
function items(text: string): string[] {
    const parts: string[] = [];
    let start = skipWhitespace(text, 1);
    while (text[start] !== "]") {
        const end = valueEnd(text, start);
        parts.push(text.slice(start, end));
        start = skipWhitespace(text, end);
        if (text[start] === "]") {
            break;
        }
        if (text[start] !== ",") {
            throw new SyntaxError("Expected a JSON array separator");
        }
        start = skipWhitespace(text, start + 1);
    }
    return parts;
}

/**
 * Compare by stored text first. Only differing fields are parsed and compared as values, retaining
 * diffFields' semantics for nested key order and numeric spellings such as -0 versus 0.
 */
function fieldDiff(before: string, after: string) {
    const old = fields(before);
    const next = fields(after);
    const changedOld: Record<string, unknown> = {};
    const changedNext: Record<string, unknown> = {};
    for (const key of new Set([...old.keys(), ...next.keys()])) {
        const a = old.get(key);
        const b = next.get(key);
        if (a === b) {
            continue;
        }
        // Own properties, including __proto__: diffFields decides when the patch must be omitted.
        if (a !== undefined) {
            Object.defineProperty(changedOld, key, { value: JSON.parse(a), enumerable: true });
        }
        if (b !== undefined) {
            Object.defineProperty(changedNext, key, { value: JSON.parse(b), enumerable: true });
        }
    }
    return diffFields(changedOld, changedNext);
}

/**
 * The slow write path has already parsed both records, but normalization cloned their nested values.
 * Diff their stored texts so equal parts need neither another parse nor another serialization. Item
 * ids come from those already parsed values, including unchanged/reordered items; only changed field
 * values and whole new/replaced items are parsed for the feed. Text scanning is only an optimization:
 * if it cannot scan a representation, use the already parsed values, never fail the write for it.
 * The caller caps the final feed JSON.
 */
export function diffRecordText(oldText: string, nextText: string, old: unknown, next: unknown) {
    try {
        // trim returns compact texts unchanged and also accepts whitespace around the root value.
        return scanRecordDiff(oldText.trim(), nextText.trim(), old, next);
    } catch {
        return isPlainObject(old) && isPlainObject(next) ? diffFields(old, next) : diffItems(old, next);
    }
}

function scanRecordDiff(oldText: string, nextText: string, old: unknown, next: unknown) {
    if (oldText[0] === "{" && nextText[0] === "{") {
        return fieldDiff(oldText, nextText);
    }
    if (oldText[0] !== "[" || nextText[0] !== "[") {
        // Includes a kind whose normalizer changed the record's shape.
        return isPlainObject(old) && isPlainObject(next) ? diffFields(old, next) : diffItems(old, next);
    }
    const oldIds = itemIds(old);
    const nextIds = itemIds(next);
    if (!oldIds || !nextIds) {
        return null;
    }
    const oldParts = items(oldText);
    const nextParts = items(nextText);
    const byId = new Map(oldIds.map((id, index) => [id, oldParts[index]]));
    const replaced: Record<string, unknown>[] = [];
    const changes: RecordItemFieldPatch[] = [];
    nextIds.forEach((id, index) => {
        const before = byId.get(id);
        const after = nextParts[index];
        if (before === after) {
            return;
        }
        const diff = before === undefined ? null : fieldDiff(before, after);
        if (!diff) {
            replaced.push(JSON.parse(after) as Record<string, unknown>);
        } else if (Object.keys(diff.set).length > 0 || diff.remove.length > 0) {
            changes.push({ id, ...diff });
        }
    });
    const reordered = oldIds.length !== nextIds.length || oldIds.some((id, index) => id !== nextIds[index]);
    return { items: replaced, changes, ...(reordered ? { order: nextIds } : {}) };
}
