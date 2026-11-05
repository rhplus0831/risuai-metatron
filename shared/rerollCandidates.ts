import { parseContextReport } from "./contextReport.ts";
import type { Chat, Message, MessageCandidate, ScriptstateSnapshot } from "./database.ts";
import { translationSourceHash } from "./translation/hash.ts";
import { isMessageTranslation } from "./translation/messageTranslation.ts";

/** Pure candidate copies, size bounds, optional-field validation, and per-key variable restoration. */
export const MAX_MESSAGE_CANDIDATES = 16;
export const MAX_CANDIDATE_BYTES = 256 * 1024;
export const MAX_SCRIPTSTATE_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_CANDIDATES_BYTES_PER_MESSAGE = 192 * 1024;
export type CandidateNoticeCode = "rerollCandidateDropped" | "rerollCandidateTooLarge" | "scriptstateCheckpointSkipped";

export const candidateBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const plain = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const optional = (object: Record<string, unknown>, key: string, check: (value: unknown) => boolean) =>
    object[key] === undefined || check(object[key]);
const string = (value: unknown) => typeof value === "string";

export function isScriptstateSnapshot(value: unknown): value is ScriptstateSnapshot {
    return (
        (value === null ||
            (plain(value) &&
                Object.values(value).every(
                    (entry) => typeof entry === "string" || typeof entry === "boolean" || finite(entry),
                ))) &&
        candidateBytes(value) <= MAX_SCRIPTSTATE_SNAPSHOT_BYTES
    );
}

function generationInfo(value: unknown): boolean {
    return (
        plain(value) &&
        ["model", "generationId"].every((key) => optional(value, key, string)) &&
        ["inputTokens", "outputTokens", "maxContext"].every((key) => optional(value, key, finite)) &&
        optional(value, "context", (context) => parseContextReport(context) !== null) &&
        optional(
            value,
            "stageTiming",
            (timing) =>
                plain(timing) && ["stage1", "stage2", "stage3", "stage4"].every((key) => optional(timing, key, finite)),
        )
    );
}
function promptInfo(value: unknown): boolean {
    return (
        plain(value) &&
        optional(value, "promptName", string) &&
        optional(
            value,
            "promptToggles",
            (toggles) =>
                Array.isArray(toggles) &&
                toggles.every((toggle) => plain(toggle) && string(toggle.key) && string(toggle.value)),
        ) &&
        optional(
            value,
            "promptText",
            (messages) =>
                Array.isArray(messages) &&
                messages.every(
                    (message) =>
                        plain(message) &&
                        ["system", "user", "assistant", "function"].includes(message.role as string) &&
                        string(message.content),
                ),
        )
    );
}
function candidate(value: unknown): value is MessageCandidate {
    return (
        plain(value) &&
        string(value.id) &&
        (value.id as string).length > 0 &&
        (value.id as string).length <= 32 &&
        string(value.data) &&
        optional(value, "generationInfo", generationInfo) &&
        optional(value, "promptInfo", promptInfo) &&
        optional(value, "translation", isMessageTranslation) &&
        optional(value, "scriptstateAfter", isScriptstateSnapshot) &&
        candidateBytes(value) <= MAX_CANDIDATE_BYTES
    );
}

/** Checks only candidate fields, leaving unrelated legacy fields alone. A refusal callback makes writes strict. */
export function normalizeCandidateFields<T extends object>(input: T, refuse?: (field: string) => never): T {
    let result = input as T & Record<string, unknown>;
    const drop = (key: string) => {
        refuse?.(key);
        if (result === input) result = { ...input } as T & Record<string, unknown>;
        delete result[key];
    };
    if (Object.hasOwn(result, "candidates")) {
        const values = result.candidates;
        if (
            !Array.isArray(values) ||
            values.length < 2 ||
            values.length > MAX_MESSAGE_CANDIDATES ||
            !Array.from(values).every(candidate) ||
            new Set(values.map((entry) => entry.id)).size !== values.length
        )
            drop("candidates");
    }
    if (
        Object.hasOwn(result, "selected") &&
        (!Array.isArray(result.candidates) ||
            !Number.isInteger(result.selected) ||
            (result.selected as number) < 0 ||
            (result.selected as number) >= result.candidates.length)
    )
        drop("selected");
    if (
        Object.hasOwn(result, "candidatesRevision") &&
        (!Number.isSafeInteger(result.candidatesRevision) || (result.candidatesRevision as number) < 0)
    )
        drop("candidatesRevision");
    if (Object.hasOwn(result, "scriptstateCheckpoint")) {
        const value = result.scriptstateCheckpoint;
        if (!plain(value) || !isScriptstateSnapshot(value.before) || !optional(value, "after", isScriptstateSnapshot))
            drop("scriptstateCheckpoint");
    }
    if (
        candidateBytes({ candidates: result.candidates, scriptstateCheckpoint: result.scriptstateCheckpoint }) >
        MAX_CANDIDATES_BYTES_PER_MESSAGE
    ) {
        drop("candidates");
        if (Object.hasOwn(result, "selected")) drop("selected");
    }
    return result;
}

/** The selected reply's bounded metadata copy; the caller supplies a new id or the slot's existing id. */
export function candidateOf(message: Message, id: string): MessageCandidate {
    const result: MessageCandidate = { id, data: message.data };
    if (message.generationInfo) {
        const { context: _context, ...info } = message.generationInfo;
        result.generationInfo = structuredClone(info);
    }
    if (message.promptInfo) {
        const { promptText: _prompt, ...info } = message.promptInfo;
        result.promptInfo = structuredClone(info);
    }
    if (message.translation) result.translation = structuredClone(message.translation);
    if (message.scriptstateCheckpoint?.after !== undefined)
        result.scriptstateAfter = structuredClone(message.scriptstateCheckpoint.after);
    return result;
}

/** Refreshes a selected slot without changing its stable id. */
export function withCandidate(message: Message): Message {
    if (!message.candidates) return message;
    const selected = message.selected ?? 0;
    const candidates = [...message.candidates];
    candidates[selected] = candidateOf(message, candidates[selected].id);
    return { ...message, candidates };
}

/** Switches by stable id, refreshing the leaving slot and restoring only variables still owned by it. */
export function selectCandidateChange(
    message: Message,
    candidateId: string,
    scriptstate: Chat["scriptstate"],
): { message: Message; merge: Record<string, string | number | boolean>; mergeUnset: string[] } | null {
    try {
        const selected = message.selected ?? 0;
        if (!Array.isArray(message.candidates)) return null;
        const index = message.candidates.findIndex((candidate) => candidate.id === candidateId);
        if (index < 0 || !message.candidates[selected]) return null;
        const leavingAfter = message.scriptstateCheckpoint?.after;
        const target = message.candidates[index];
        const copy = withCandidate(structuredClone(message));
        copy.data = target.data;
        for (const field of ["generationInfo", "promptInfo", "translation"] as const) delete copy[field];
        if (target.generationInfo !== undefined) copy.generationInfo = structuredClone(target.generationInfo);
        if (target.promptInfo !== undefined) copy.promptInfo = structuredClone(target.promptInfo);
        if (target.translation?.sourceHash === translationSourceHash(target.data))
            copy.translation = structuredClone(target.translation);
        copy.selected = index;
        if (copy.scriptstateCheckpoint) {
            delete copy.scriptstateCheckpoint.after;
            if (target.scriptstateAfter !== undefined)
                copy.scriptstateCheckpoint.after = structuredClone(target.scriptstateAfter);
        }
        normalizeCandidateFields(copy, (field) => {
            throw new Error(`Invalid candidate field: ${field}`);
        });
        // Even a no-op checks the refreshed row's bounds, but never rewrites the selected reply.
        if (selected === index) return { message: structuredClone(message), merge: {}, mergeUnset: [] };
        const patch =
            leavingAfter !== undefined && target.scriptstateAfter !== undefined
                ? scriptstateRestorePatch(target.scriptstateAfter, leavingAfter, scriptstate)
                : { merge: {}, mergeUnset: [] };
        return { message: copy, ...patch };
    } catch {
        return null;
    }
}

/** Removes variable copies while retaining candidate texts and metadata. */
export function withoutCandidateCheckpoints(message: Message): Message {
    const { scriptstateCheckpoint: _checkpoint, ...copy } = message;
    if (copy.candidates) copy.candidates = copy.candidates.map(({ scriptstateAfter: _after, ...entry }) => entry);
    return copy;
}

/** Drops oldest unselected slots until both bounds fit, keeping the previous reply when starting a reroll if it fits. A sole or oversized selected slot is not persisted. */
export function trimCandidates(
    message: Message,
    notice: (code: CandidateNoticeCode) => void,
    previousId?: string,
): Message {
    let copy = { ...message };
    if (
        copy.scriptstateCheckpoint &&
        (!isScriptstateSnapshot(copy.scriptstateCheckpoint.before) ||
            (copy.scriptstateCheckpoint.after !== undefined &&
                !isScriptstateSnapshot(copy.scriptstateCheckpoint.after)))
    ) {
        copy = withoutCandidateCheckpoints(copy);
        notice("scriptstateCheckpointSkipped");
    }
    if (!copy.candidates) return copy;
    let selected = copy.selected ?? 0;
    const candidates = [...copy.candidates];
    for (let index = candidates.length - 1; index >= 0; index--) {
        if (
            candidateBytes(candidates[index]) > MAX_CANDIDATE_BYTES ||
            candidateBytes({ candidates: [candidates[index]], scriptstateCheckpoint: copy.scriptstateCheckpoint }) >
                MAX_CANDIDATES_BYTES_PER_MESSAGE
        ) {
            notice("rerollCandidateTooLarge");
            if (index === selected) {
                delete copy.candidates;
                delete copy.selected;
                return copy;
            }
            candidates.splice(index, 1);
            if (index < selected) selected--;
        }
    }
    while (
        candidates.length > MAX_MESSAGE_CANDIDATES ||
        candidateBytes({ candidates, scriptstateCheckpoint: copy.scriptstateCheckpoint }) >
            MAX_CANDIDATES_BYTES_PER_MESSAGE
    ) {
        let index = candidates.findIndex((entry, index) => index !== selected && entry.id !== previousId);
        if (index < 0) index = candidates.findIndex((_entry, index) => index !== selected);
        if (index < 0) break;
        candidates.splice(index, 1);
        if (index < selected) selected--;
        notice("rerollCandidateDropped");
    }
    if (candidates.length < 2) {
        delete copy.candidates;
        delete copy.selected;
    } else {
        copy.candidates = candidates;
        copy.selected = selected;
    }
    return copy;
}

/** Restore only keys whose stored value still matches the selected reply's after state. */
export function scriptstateRestorePatch(
    before: ScriptstateSnapshot,
    after: ScriptstateSnapshot,
    current: Chat["scriptstate"],
): { merge: Record<string, string | number | boolean>; mergeUnset: string[] } {
    const merge: Record<string, string | number | boolean> = Object.create(null);
    const mergeUnset: string[] = [];
    for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
        if (
            (current && Object.hasOwn(current, key) ? current[key] : undefined) !==
            (after && Object.hasOwn(after, key) ? after[key] : undefined)
        )
            continue;
        if (before && Object.hasOwn(before, key)) merge[key] = before[key];
        else mergeUnset.push(key);
    }
    return { merge, mergeUnset };
}

/** The last non-comment message must be the only reply since the last user message. */
export function isRerollCarrier(
    chat: { readonly message: readonly Pick<Message, "chatId" | "role" | "isComment">[] },
    id: string,
): boolean {
    let foundReply = false;
    for (let index = chat.message.length - 1; index >= 0; index--) {
        const message = chat.message[index];
        if (message.isComment) continue;
        if (foundReply) return message.role === "user";
        if (message.chatId !== id || message.role !== "char") return false;
        foundReply = true;
    }
    return foundReply;
}

/** Whether a later non-comment message has committed the reply's variable state. */
export function isLatestReply(chat: Chat, id: string): boolean {
    for (let index = chat.message.length - 1; index >= 0; index--) {
        const message = chat.message[index];
        if (!message.isComment) return message.chatId === id;
    }
    return false;
}
