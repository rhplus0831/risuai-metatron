import type { Message } from "./database.ts";

/**
 * How one request spent the model's context: written by the server's `assemblePrompt` into
 * `MessageGenerationInfo.context`, read by the tab's context meter. Counts are the ones assembly
 * already made (the server tokenizer's estimates); attribution is exact only when every entry could
 * be traced, and the signed `adjustment` carries the rest.
 */

export type ContextSectionKind =
    | "main"
    | "globalNote"
    | "jailbreak"
    | "cot"
    | "plain"
    | "chatML"
    | "persona"
    | "description"
    | "authornote"
    | "lorebook"
    | "postEverything"
    | "memory"
    | "examples"
    | "triggers"
    | "history";

/** What the meter counts as a turn: kept user messages, or every kept message. */
export type ContextMeterTurnUnit = "user" | "message";

export type ContextTrimEntry = { tokens: number; kind: "example" | "marker" | "message"; user: boolean };

export type ContextReport = {
    v: 1;
    /** Effective context size and the response reservation the request used. */
    maxContext: number;
    maxResponse: number;
    /** Final counted input (= generationInfo.inputTokens). */
    input: number;
    /** One row per kind, in first-counted order; kinds that counted nothing are left out. */
    sections: readonly { kind: ContextSectionKind; tokens: number }[];
    /** input − sum(sections); signed. */
    adjustment: number;
    /** False when editRequest changed the list or a removal or merge could not be traced. */
    attributionExact: boolean;
    history: {
        /** Eligible stored messages (not disabled, from the last allBefore); the greeting counts as one. */
        total: number;
        kept: number;
        totalUser: number;
        keptUser: number;
        /**
         * Tokens of eligible messages not in the final prompt, as counted when assembled: trimmed,
         * summarized away, removed by the recheck or editRequest, or outside every chat range.
         */
        droppedTokens: number;
    };
    /** No-memory trim ledger, when queued messages survive formatting, for the displacement estimate. */
    trim?: {
        /** maxContext − currentTokens after the trim loop. */
        headroom: number;
        /**
         * The entries the next send's trim loop would drop first, in order, at most 8: examples, the
         * new-chat marker, then messages (the greeting is a message). Each is the count the loop
         * subtracts for it, its per-message overhead included.
         */
        queue: readonly ContextTrimEntry[];
        /** On a continue: the continued message's count already in the ledger (overhead included). */
        replyPrefix?: { messageId: string; tokens: number };
        /** The per-message overhead each new message adds. */
        perMessage: number;
    };
    memory?: {
        kind: "hypaV3" | "hypaV2" | "supa" | "hanurai";
        /** The memory entries as sent (inner format and wrappers included); 0 when none was sent. */
        tokens: number;
        /** HypaV3's memory budget (`floor(maxContext × memoryTokensRatio)`). */
        budget?: number;
        /** "gap" when HypaV3 left uncovered history; "unknown" when it cannot tell. */
        coverage: "covered" | "gap" | "unknown";
    };
    lore: {
        /** The budget pass total, before @@inject_lore edits; not the emitted lore tokens. */
        budgetUsed: number;
        budget: number;
        rejectedCount: number;
        rejectedTokens: number;
        /** Returned actives (injectors excluded). */
        active: number;
    };
    /** tokenizerIdentityKey of the job scope (pluginTokenizer "none"). */
    tokenScope: string;
    /**
     * historyDigest() of the chat's messages as assembled; on a continue, without the continued
     * message (the tab compares it with the messages before the last reply).
     */
    historyDigest: string;
};

const SECTION_KINDS: readonly ContextSectionKind[] = [
    "main",
    "globalNote",
    "jailbreak",
    "cot",
    "plain",
    "chatML",
    "persona",
    "description",
    "authornote",
    "lorebook",
    "postEverything",
    "memory",
    "examples",
    "triggers",
    "history",
];
const TRIM_KINDS: readonly ContextTrimEntry["kind"][] = ["example", "marker", "message"];
const MEMORY_KINDS: readonly NonNullable<ContextReport["memory"]>["kind"][] = ["hypaV3", "hypaV2", "supa", "hanurai"];
const COVERAGES: readonly NonNullable<ContextReport["memory"]>["coverage"][] = ["covered", "gap", "unknown"];

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isCount = (value: unknown): value is number => isNumber(value) && value >= 0;
const counts = (record: Fields, keys: readonly string[]) => keys.every((key) => isCount(record[key]));
const oneOf = <T>(values: readonly T[], value: unknown): value is T => values.includes(value as T);

/** The report in `value`, or null when its shape or any number is wrong (old or imported data). */
export function parseContextReport(value: unknown): ContextReport | null {
    if (!isRecord(value) || value.v !== 1) {
        return null;
    }
    if (!counts(value, ["maxContext", "maxResponse", "input"]) || !isNumber(value.adjustment)) {
        return null;
    }
    if (typeof value.attributionExact !== "boolean" || typeof value.tokenScope !== "string") {
        return null;
    }
    if (typeof value.historyDigest !== "string") {
        return null;
    }
    const sections = value.sections;
    if (!Array.isArray(sections)) {
        return null;
    }
    const kinds = new Set<ContextSectionKind>();
    for (let i = 0; i < sections.length; i++) {
        const row: unknown = sections[i];
        if (
            !Object.hasOwn(sections, i) ||
            !isRecord(row) ||
            !oneOf(SECTION_KINDS, row.kind) ||
            !isCount(row.tokens) ||
            kinds.has(row.kind)
        ) {
            return null;
        }
        kinds.add(row.kind);
    }
    const history = value.history;
    if (!isRecord(history) || !counts(history, ["total", "kept", "totalUser", "keptUser", "droppedTokens"])) {
        return null;
    }
    const lore = value.lore;
    if (!isRecord(lore) || !counts(lore, ["budgetUsed", "budget", "rejectedCount", "rejectedTokens", "active"])) {
        return null;
    }
    if (value.trim !== undefined) {
        const trim = value.trim;
        if (!isRecord(trim) || !counts(trim, ["headroom", "perMessage"]) || !Array.isArray(trim.queue)) {
            return null;
        }
        if (trim.queue.length > 8) {
            return null;
        }
        for (let i = 0; i < trim.queue.length; i++) {
            const entry: unknown = trim.queue[i];
            if (
                !Object.hasOwn(trim.queue, i) ||
                !isRecord(entry) ||
                !isCount(entry.tokens) ||
                !oneOf(TRIM_KINDS, entry.kind) ||
                typeof entry.user !== "boolean"
            ) {
                return null;
            }
        }
        const prefix = trim.replyPrefix;
        if (
            prefix !== undefined &&
            !(isRecord(prefix) && typeof prefix.messageId === "string" && isCount(prefix.tokens))
        ) {
            return null;
        }
    }
    if (value.memory !== undefined) {
        const memory = value.memory;
        if (
            !isRecord(memory) ||
            !oneOf(MEMORY_KINDS, memory.kind) ||
            !isCount(memory.tokens) ||
            !oneOf(COVERAGES, memory.coverage) ||
            (memory.budget !== undefined && !isCount(memory.budget))
        ) {
            return null;
        }
    }
    return value as ContextReport;
}

type HistoryMessage = Pick<Message, "chatId" | "role" | "data" | "disabled">;

/**
 * The messages a send reads: from the end back to the last `allBefore` message (excluded), skipping
 * disabled ones. `reset` is true when an `allBefore` message cut the history (the greeting is then
 * left out too).
 */
export function eligibleHistory<T extends Pick<Message, "disabled">>(
    messages: readonly T[],
): { messages: T[]; reset: boolean } {
    const eligible: T[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.disabled === true) {
            continue;
        }
        if (message.disabled === "allBefore") {
            return { messages: eligible, reset: true };
        }
        eligible.unshift(message);
    }
    return { messages: eligible, reset: false };
}

/** cyrb53: a fast 53-bit string hash (not cryptographic), as base 36. */
function hashString(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A digest of the history a send of `messages` reads: the eligible messages' id, role, disabled
 * flag, and text, and whether an `allBefore` message cut it. The server and the tab compute it the
 * same way, so an edit, a deletion, or a changed disabled flag changes it.
 */
export function historyDigest(messages: readonly HistoryMessage[]): string {
    const { messages: eligible, reset } = eligibleHistory(messages);
    return hashString(
        JSON.stringify([
            reset,
            ...eligible.map((message) => [message.chatId ?? null, message.role, !!message.disabled, message.data]),
        ]),
    );
}

/** The kept and total turns in `unit`. */
export function turnCount(report: ContextReport, unit: ContextMeterTurnUnit): { kept: number; total: number } {
    return unit === "user"
        ? { kept: report.history.keptUser, total: report.history.totalUser }
        : { kept: report.history.kept, total: report.history.total };
}

/**
 * The share of the prompt budget (`maxContext − maxResponse`) the fixed sections take: every
 * section but history and memory, `adjustment` left out. In [0, 1]; 1 without a budget.
 */
export function fixedShare(report: ContextReport): number {
    const budget = report.maxContext - report.maxResponse;
    if (budget <= 0) {
        return 1;
    }
    let fixed = 0;
    for (const section of report.sections) {
        if (section.kind !== "history" && section.kind !== "memory") {
            fixed += section.tokens;
        }
    }
    return Math.min(1, Math.max(0, fixed / budget));
}

/**
 * What adding `added` tokens to the ledger would push out, as the trim loop drops entries: the
 * messages (and user messages) among the dropped queue entries. "beyondQueue" when the known queue
 * runs out first; "unavailable" without a reliable trim ledger (including when memory is on).
 */
export function displacement(
    report: ContextReport,
    added: number,
): { messages: number; userMessages: number } | "beyondQueue" | "unavailable" {
    const trim = report.trim;
    if (!trim) {
        return "unavailable";
    }
    let over = added - trim.headroom;
    let messages = 0;
    let userMessages = 0;
    for (const entry of trim.queue) {
        if (over <= 0) {
            break;
        }
        over -= entry.tokens;
        if (entry.kind === "message") {
            messages++;
            if (entry.user) {
                userMessages++;
            }
        }
    }
    return over > 0 ? "beyondQueue" : { messages, userMessages };
}
