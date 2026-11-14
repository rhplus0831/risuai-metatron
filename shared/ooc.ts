import { toggleStorageKey } from "./prompt/toggles.ts";
import { isPlainObject } from "./valueKinds.ts";

/**
 * OOC exchanges, the current segment, and forced toggle values live in chat metadata, never in
 * stored messages. Both runtimes use this module's types, limits, readers, and validation.
 */

/**
 * One question and optional answer, its segment's Message.chatId anchor, millisecond time,
 * and earlier-segment attachments.
 */
export type OocExchange = {
    id: string;
    segment: string;
    anchorMessageId: string | null;
    question: string;
    answer?: string;
    time: number;
    attached?: string[];
};

/** The current segment and its anchor message id; null means the chat had no stored message. */
export type OocSegment = { id: string; anchorMessageId: string | null };

/** Exchanges keyed by their own ids, kept beside the chat's story state. */
export type OocLog = { [id: string]: OocExchange };

/** A question or answer row derived from an exchange for an OOC question's context. */
export type OocTailRow = { id: string; role: "user" | "char"; data: string };

/** Maximum size of one exchange as serialized JSON in UTF-8 bytes. */
export const MAX_OOC_EXCHANGE_BYTES = 256 * 1024;

/** Maximum number of exchanges stored in one chat's log. */
export const MAX_OOC_EXCHANGES = 200;

/** Maximum exchange and segment id length in UTF-16 units. */
export const MAX_OOC_ID_LENGTH = 256;

function compareExchanges(a: OocExchange, b: OocExchange): number {
    return a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Builds the question's rows; the caller must ensure their derived ids name no stored message. */
export function oocTail(log: OocLog | undefined, exchangeId: string): OocTailRow[] {
    if (!log || !Object.hasOwn(log, exchangeId)) {
        return [];
    }
    const target = log[exchangeId];
    const exchanges = Object.values(log)
        .filter((exchange) => exchange.segment === target.segment)
        .sort(compareExchanges);
    const placed = new Set<string>();
    const rows: OocTailRow[] = [];
    function place(exchange: OocExchange): void {
        if (placed.has(exchange.id)) {
            return;
        }
        rows.push({ id: `ooc-q:${exchange.id}`, role: "user", data: exchange.question });
        if (exchange.answer !== undefined) {
            rows.push({ id: `ooc-a:${exchange.id}`, role: "char", data: exchange.answer });
        }
        placed.add(exchange.id);
    }
    for (const exchange of exchanges) {
        if (exchange.id !== target.id && exchange.answer === undefined) {
            continue;
        }
        for (const id of exchange.attached ?? []) {
            const attached = Object.hasOwn(log, id) ? log[id] : undefined;
            if (attached && attached.segment !== target.segment && attached.answer !== undefined) {
                place(attached);
            }
        }
        place(exchange);
        if (exchange.id === target.id) {
            break;
        }
    }
    return rows;
}

/** A plain chat map replaces the whole preset map; only string values become forced toggle variables. */
export function oocToggleValues(chatMap: unknown, presetMap: unknown): Record<string, string> {
    const map = isPlainObject(chatMap) ? chatMap : isPlainObject(presetMap) ? presetMap : {};
    return Object.fromEntries(
        Object.entries(map).flatMap(([key, value]) =>
            typeof value === "string" ? [[toggleStorageKey(key), value]] : [],
        ),
    );
}

/** Oldest removable ids to fit one more exchange, protecting the current segment, its attachments, and keep. */
export function oocPrune(
    log: OocLog | undefined,
    currentSegment: OocSegment | undefined,
    keep: Iterable<string>,
): string[] | null {
    const exchanges = Object.values(log ?? {});
    const needed = exchanges.length + 1 - MAX_OOC_EXCHANGES;
    if (needed <= 0) {
        return [];
    }
    const protectedIds = new Set(keep);
    for (const exchange of exchanges) {
        if (exchange.segment === currentSegment?.id) {
            for (const id of exchange.attached ?? []) {
                protectedIds.add(id);
            }
        }
    }
    const candidates = exchanges
        .filter((exchange) => exchange.segment !== currentSegment?.id && !protectedIds.has(exchange.id))
        .sort(compareExchanges);
    return candidates.length < needed ? null : candidates.slice(0, needed).map((exchange) => exchange.id);
}

function isOocId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_OOC_ID_LENGTH &&
        value !== "." &&
        value !== ".." &&
        !/[\u0000-\u001f\u007f]/.test(value)
    );
}

function isAnchor(value: unknown): value is string | null {
    return value === null || (typeof value === "string" && value.length > 0 && value.length <= 512);
}

/** Checks an exchange's fields, identity, and serialized byte limit without throwing a server error. */
export function oocExchangeError(id: string, value: unknown): string | null {
    if (!isPlainObject(value)) {
        return "a chat.oocLog entry must be a plain object";
    }
    if (!isOocId(id) || value.id !== id) {
        return "a chat.oocLog entry must have a valid id equal to its key";
    }
    if (!isOocId(value.segment)) {
        return "a chat.oocLog entry must have a valid segment id";
    }
    if (!isAnchor(value.anchorMessageId)) {
        return "a chat.oocLog entry anchorMessageId must be null or a non-empty string of at most 512 units";
    }
    if (typeof value.question !== "string" || (value.answer !== undefined && typeof value.answer !== "string")) {
        return "a chat.oocLog entry must have a string question and an optional string answer";
    }
    if (typeof value.time !== "number" || !Number.isFinite(value.time)) {
        return "a chat.oocLog entry time must be a finite number";
    }
    if (
        value.attached !== undefined &&
        (!Array.isArray(value.attached) || !value.attached.every((id) => typeof id === "string"))
    ) {
        return "a chat.oocLog entry attached must be an array of strings";
    }
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            return "a chat.oocLog entry must be JSON serializable";
        }
        if (new TextEncoder().encode(serialized).length > MAX_OOC_EXCHANGE_BYTES) {
            return `a chat.oocLog entry must be at most ${MAX_OOC_EXCHANGE_BYTES} bytes`;
        }
    } catch {
        return "a chat.oocLog entry must be JSON serializable";
    }
    return null;
}

/** Checks the whole log's entry count and each exchange without changing stored data. */
export function oocLogError(value: unknown): string | null {
    if (!isPlainObject(value)) {
        return "chat.oocLog must be a plain object";
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_OOC_EXCHANGES) {
        return `chat.oocLog holds at most ${MAX_OOC_EXCHANGES} exchanges`;
    }
    for (const [id, exchange] of entries) {
        const error = oocExchangeError(id, exchange);
        if (error !== null) {
            return error;
        }
    }
    return null;
}

/** Checks the current segment's id and anchor, which is null for a chat with no stored message. */
export function oocSegmentError(value: unknown): string | null {
    if (!isPlainObject(value) || !isOocId(value.id) || !isAnchor(value.anchorMessageId)) {
        return "chat.oocSegment must be a plain object with a valid id and a null or non-empty anchorMessageId of at most 512 units";
    }
    return null;
}

/** Checks a chat's own forced toggle map of bare keys and string values. */
export function oocTogglesError(value: unknown): string | null {
    if (!isPlainObject(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
        return "chat.oocToggles must be a plain object with string values";
    }
    return null;
}
