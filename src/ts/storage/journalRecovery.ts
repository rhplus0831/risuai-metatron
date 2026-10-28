import { changeLanguage, language } from "src/lang";
import type { ChatOp } from "../../../shared/chats.ts";
import { SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { COLLECTION_KIND, COLLECTION_SELECTION_FIELDS, SECTION_KIND } from "../../../shared/sections.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { recordClientEvent } from "../diagnostics/collector";
import {
    characterList,
    addCharacter,
    checkCharacterInput,
    findCharacter,
    removeCharacters,
    replaceCharacterFields,
    writeCharacterFieldsAt,
    type AnyClientCharacter,
} from "./characterStore.svelte";
import {
    appendMessage,
    chatEntry,
    chatList,
    chatOwnerToken,
    createChat,
    ensureChatLoaded,
    findChat,
    isCharacterGenerating,
    isChatGenerating,
    mergeChatMeta,
    patchMessage,
    pinChat,
    removeMessages,
    reorderChats,
    replaceMessage,
    setChatMeta,
    setMessageText,
    setMessageTranslation,
    type ChatRef,
} from "./chatStore.svelte";
import {
    JOURNAL_ENTRY_TTL_MS,
    pageDraftJournal,
    type DraftEntry,
    type DraftJournal,
    type DraftMove,
    type MutationEntry,
    type RecordLayerValues,
    type StoredLayers,
} from "./draftJournal";
import { isJournalEligible } from "./journalEligibility";
import { replaceRecord, type RecordKind } from "./records.svelte";
import { recoveryDrafts } from "./recoveryDrafts.svelte";
import { getResourceEpoch } from "./resourceClient";
import {
    adoptRecoveredRecord,
    assertSaveAdmission,
    beginMutationScope,
    flushResources,
    heldRecordSnapshot,
    sameJson,
} from "./resourceSync.svelte";
import { reconcileSelection, settings } from "./settingsViews.svelte";

type RecordEntry = Extract<MutationEntry, { scope: "record" }>;
type ServerRecord = ReturnType<typeof heldRecordSnapshot>;
type Intent = RecordLayerValues["latest"];
type Decision =
    | { action: "draft" }
    | { action: "satisfied" }
    | { action: "replay"; text: string | null; unresolvedSent?: RecordLayerValues["sent"] };

function validIntent(intent: Intent): boolean {
    return (
        (intent.baseRevision === null || (typeof intent.baseRevision === "string" && intent.baseRevision.length > 0)) &&
        (intent.op === "delete"
            ? intent.text === null
            : typeof intent.text === "string" &&
              (intent.op === "create"
                  ? intent.baseRevision === null
                  : intent.op === "update" && intent.baseRevision !== null))
    );
}

/**
 * Classifies adapter-produced compact JSON against the untouched boot snapshot. Layer roles order
 * intent; versions only fence storage. A sent update can still land after this snapshot was read.
 */
export function decideRecordRecovery(layers: StoredLayers<"record">, server: ServerRecord): Decision {
    const sent = layers.sent?.value;
    const latest = layers.latest?.value;
    const draft: Decision = { action: "draft" };
    const satisfied: Decision = { action: "satisfied" };
    if (sent?.op === "create" && !server) return draft;
    if (layers.refused || (!sent && !latest)) return draft;
    if (
        (sent && (!validIntent(sent) || sent.dispatched !== true || typeof sent.inDoubt !== "boolean")) ||
        (latest && !validIntent(latest))
    )
        return draft;

    const final = latest ?? sent!;
    // An update cannot authorize resurrection, including a re-add behind an unanswered delete.
    if (!server && (sent?.op === "update" || final.op === "update")) return draft;
    if (sent?.op === "delete" && !server) return final.text === null ? satisfied : draft;

    const sentMatches = sent?.text != null && server !== null && sameJson(sent.text, server.text);
    if (sent && latest) {
        // Newer intent is based on the original request, or on its recognized current value.
        if (latest.baseRevision !== sent.baseRevision && !(sentMatches && latest.baseRevision === server!.revision))
            return draft;
        if (latest.op === "create" && sent.op !== "create") return draft;
    }
    const finalMatches = final.text === null ? server === null : server !== null && sameJson(final.text, server.text);
    if (sentMatches) {
        return finalMatches ? satisfied : { action: "replay", text: final.text };
    }
    if (sent?.op === "update" && server?.revision === sent.baseRevision) {
        // Even a final value equal to the snapshot must wait behind the unresolved sent value.
        return { action: "replay", text: final.text, unresolvedSent: sent };
    }
    if (sent?.op === "delete" && server?.revision === sent.baseRevision && finalMatches) {
        // The unanswered delete can still remove this revision. A re-add equal to the snapshot
        // produces no local diff, and the adapter cannot hold a null in-doubt value: preserve it.
        return draft;
    }
    if (finalMatches) return satisfied;
    if (sent && (!server || sent.baseRevision !== server.revision)) return draft;
    if (!server) {
        return final.op === "create" && !sent ? { action: "replay", text: final.text } : draft;
    }
    return final.baseRevision === server.revision ? { action: "replay", text: final.text } : draft;
}

const singletonKinds = new Set<string>([
    ...Object.values(SECTION_KIND),
    ...Object.values(COLLECTION_KIND),
    "presets",
    "modules",
]);
const objectKinds = new Set<string>([...Object.values(SECTION_KIND), "globalChatVariables", "statics"]);

/** Validate without normalizing: the normal save collector owns character canonicalization. */
function checkedValue(kind: string, id: string, text: string): unknown {
    const value: unknown = JSON.parse(text);
    if (kind === "characters") {
        checkCharacterInput(value);
        if (value.chaId !== id || ["chats", "chatPage", "reloadKeys"].some((key) => Object.hasOwn(value, key))) {
            throw new Error("Recovery requires a character's own fields with the exact target id");
        }
    } else if (Object.hasOwn(COLLECTION_SELECTION_FIELDS, kind)) {
        if (!isPlainObject(value) || !Array.isArray(value.items) || typeof value.selectedId !== "string") {
            throw new Error("Recovery requires the whole selectable collection");
        }
    } else if (objectKinds.has(kind) ? !isPlainObject(value) : !Array.isArray(value)) {
        throw new Error("Unsupported recovered record shape");
    }
    return value;
}

type Installation = {
    entry: RecordEntry;
    kind: string;
    id: string;
    server: ServerRecord;
    decision: Exclude<Decision, { action: "draft" }>;
    value?: unknown;
};

function recordAddress(target: string): { kind: string; id: string } | null {
    const [kind, id, extra] = target.split("\u0000");
    if (
        !kind ||
        !id ||
        extra !== undefined ||
        (kind !== "characters" && (!singletonKinds.has(kind) || id !== SINGLETON_RESOURCE_ID))
    ) {
        return null;
    }
    return { kind, id };
}

function prepare(entry: RecordEntry): Installation | null {
    const address = recordAddress(entry.target);
    if (!address) return null;
    const { kind, id } = address;
    // Use the existing boundary for every layer, including an earlier sent value. Ineligible rows
    // go through moveToDrafts, which removes them without copying their content into a draft.
    for (const layer of Object.values(entry.layers)) {
        if (!isJournalEligible({ scope: "record", kind, text: layer.value.text })) return null;
        if (layer.value.text === null) {
            if (kind !== "characters") return null;
        } else {
            checkedValue(kind, id, layer.value.text);
        }
    }
    const server = heldRecordSnapshot(kind, id);
    const decision = decideRecordRecovery(entry.layers, server);
    if (decision.action === "draft") return null;
    const text = decision.action === "replay" ? decision.text : server?.text;
    return {
        entry,
        kind,
        id,
        server,
        decision,
        value: text != null ? checkedValue(kind, id, text) : undefined,
    };
}

function install(item: Installation) {
    const { entry, kind, id, server, decision, value } = item;
    // A satisfied whole record also wins over any first-boot overlay. It still compares equal to
    // the server baseline, so the initial save pass sends nothing for it.
    if (decision.action === "replay" || server) {
        if (kind === "characters") {
            const characters = characterList();
            const index = characters.findIndex((character) => character.chaId === id);
            if (index >= 0 !== (server !== null)) throw new Error("Recovered character membership changed");
            if (decision.action === "replay" && decision.text === null) {
                if (!removeCharacters([id]).includes(id)) throw new Error("Recovered character could not be removed");
            } else {
                // The index is resolved and used in this task, with no asynchronous gap. Appending
                // fields avoids import transforms and leaves the first chat to initializeChats.
                writeCharacterFieldsAt(index < 0 ? characters.length : index, value as AnyClientCharacter);
            }
        } else {
            replaceRecord(kind as RecordKind, value);
        }
    }
    adoptRecoveredRecord(entry, decision.action === "replay" ? decision.unresolvedSent : undefined);
}

type RecordDraft = Extract<DraftEntry, { scope: "record" }>;
type ChatDraft = Extract<DraftEntry, { scope: "chat" }>;

function draftRecord(entry: RecordDraft) {
    const address = recordAddress(entry.target);
    if (!address) throw new Error(language.recoveryDrafts.invalid);
    const { kind, id } = address;
    for (const layer of Object.values(entry.layers)) {
        if (
            !isJournalEligible({ scope: "record", kind, text: layer.value.text }) ||
            (layer.value.text === null && kind !== "characters")
        ) {
            throw new Error(language.recoveryDrafts.invalid);
        }
        if (layer.value.text !== null) checkedValue(kind, id, layer.value.text);
    }
    const intent = (entry.layers.latest ?? entry.layers.sent ?? entry.layers.refused)?.value;
    if (!intent || (intent.text === null && kind !== "characters")) {
        throw new Error(language.recoveryDrafts.invalid);
    }
    return {
        ...address,
        text: intent.text,
        value: intent.text === null ? undefined : checkedValue(kind, id, intent.text),
    };
}

function draftChat(entry: ChatDraft) {
    const [chaId, chatId, extra] = entry.target.split("\u0000");
    if (!chaId || !chatId || extra !== undefined) throw new Error(language.recoveryDrafts.invalid);
    const ops = [
        ...(entry.layers.resend?.value.ops ?? []),
        ...(entry.layers.refused?.value.ops ?? []),
        ...(entry.layers.pending?.value.ops.map((item) => item.op) ?? []),
    ];
    let snapshot = entry.layers.pending?.value.createSnapshot;
    if (!snapshot) {
        for (const op of ops) {
            if (op.op === "create" || op.op === "replace") snapshot = op.chat;
        }
    }
    return { ref: { chaId, chatId }, ops, snapshot };
}

function draftOrder(entry: Extract<DraftEntry, { scope: "order" }>) {
    const ids = (entry.layers.latest ?? entry.layers.sent ?? entry.layers.refused)?.value.ids;
    if (!entry.target || entry.target.includes("\u0000") || !ids || !ids.every((id) => typeof id === "string")) {
        throw new Error(language.recoveryDrafts.invalid);
    }
    return ids;
}

/** Live names and Apply availability; malformed intent remains available for Export and Discard. */
export function recoveryDraftDetails(entry: DraftEntry): {
    name: string;
    canApply: boolean;
    blocked: boolean;
    reason?: string;
} {
    let name = entry.target.split("\u0000")[0];
    let reason: string | undefined;
    try {
        if (entry.scope === "record") {
            const address = recordAddress(entry.target);
            if (address?.kind === "characters") {
                const intent = (entry.layers.latest ?? entry.layers.sent ?? entry.layers.refused)?.value;
                let draftName: unknown;
                try {
                    draftName = intent?.text ? JSON.parse(intent.text).name : undefined;
                } catch {
                    // A malformed text can still use the live character's name.
                }
                name =
                    (typeof draftName === "string" && draftName) ||
                    findCharacter(address.id)?.name ||
                    language.unnamedCharacter;
            }
            const { kind, id } = draftRecord(entry);
            if (kind === "characters" && isCharacterGenerating(id)) reason = language.chatGenerating;
        } else if (entry.scope === "chat") {
            const { ref, snapshot } = draftChat(entry);
            const character = findCharacter(ref.chaId);
            const chat = chatEntry(ref);
            name = `${chat?.name || snapshot?.name || language.unnamedCharacter} · ${character?.name || language.unnamedCharacter}`;
            if (!character) reason = language.recoveryDrafts.missingCharacter;
            else if (chat && isChatGenerating(ref)) reason = language.chatGenerating;
            else if (!chat && !snapshot) reason = language.recoveryDrafts.noSnapshot;
        } else {
            const character = findCharacter(entry.target);
            name = `${character?.name || language.unnamedCharacter} · ${language.recoveryDrafts.chatOrder}`;
            draftOrder(entry);
            if (!character) reason = language.recoveryDrafts.missingCharacter;
        }
    } catch {
        reason = language.recoveryDrafts.invalid;
    }
    if (entry.epoch !== getResourceEpoch()) reason = language.recoveryDrafts.otherEpoch;
    return { name, canApply: reason === undefined, blocked: reason === language.chatGenerating, reason };
}

function applyChatOps(ref: ChatRef, ops: ChatOp[]): string[] {
    const skipped: string[] = [];
    for (const op of ops) {
        const present = new Set(findChat(ref)!.message.map((message) => message.chatId));
        if (op.op === "begin") continue;
        if (op.op === "create" || op.op === "replace" || op.op === "delete") {
            skipped.push(op.op);
            continue;
        }
        if (op.op === "append") {
            const existing = op.messages.filter((message) => present.has(message.chatId));
            if (existing.length > 0) skipped.push(`${op.op}: ${existing.map((message) => message.chatId).join(", ")}`);
            const messages = op.messages.filter((message) => !present.has(message.chatId));
            if (messages.length === 0) continue;
            if ("after" in op.anchor && !present.has(op.anchor.after)) {
                skipped.push(`${op.op}: ${op.anchor.after}`);
            } else appendMessage(ref, messages, { anchor: op.anchor });
        } else if (op.op === "remove") {
            const ids = op.ids.filter((id) => present.has(id));
            const missing = op.ids.filter((id) => !present.has(id));
            if (missing.length > 0) skipped.push(`${op.op}: ${missing.join(", ")}`);
            if (ids.length > 0) removeMessages(ref, ids);
        } else if (op.op === "meta") {
            setChatMeta(ref, op.set ?? {}, op.unset ?? []);
            const fields = new Set([...Object.keys(op.merge ?? {}), ...Object.keys(op.mergeUnset ?? {})]);
            for (const field of fields)
                mergeChatMeta(ref, field, op.merge?.[field] ?? {}, op.mergeUnset?.[field] ?? []);
        } else {
            const id = op.op === "setMessage" ? op.message.chatId : op.id;
            if (!id || !present.has(id)) {
                skipped.push(`${op.op}: ${id ?? ""}`);
                continue;
            }
            switch (op.op) {
                case "setText":
                    setMessageText(ref, id, op.text);
                    break;
                case "setMessage":
                    replaceMessage(ref, op.message);
                    break;
                case "patchMessage":
                    patchMessage(ref, id, op.set, op.unset);
                    break;
                case "setTranslation":
                    if (!setMessageTranslation(ref, id, op.translation)) skipped.push(`${op.op}: ${id}`);
                    break;
            }
        }
    }
    return skipped;
}

/** Applies confirmed intent through the normal writers, retaining the draft until saving succeeds. */
export async function applyRecoveryDraft(entry: DraftEntry): Promise<{ skipped: string[] }> {
    assertSaveAdmission();
    const details = recoveryDraftDetails(entry);
    if (!details.canApply) throw new Error(details.reason);
    if (entry.createdAt + JOURNAL_ENTRY_TTL_MS <= Date.now()) throw new Error(language.recoveryDrafts.expired);
    const scope = beginMutationScope();
    const keys = new Set<string>();
    const changedMembership = new Set<string>();
    let skipped: string[] = [];
    let release: (() => void) | undefined;
    try {
        if (entry.scope === "record") {
            const { kind, id, text, value } = draftRecord(entry);
            keys.add(`${kind}/${id}`);
            if (kind === "characters") {
                if (isCharacterGenerating(id)) throw new Error(language.chatGenerating);
                if (text === null) {
                    changedMembership.add(id);
                    keys.add(`characterOrder/${SINGLETON_RESOURCE_ID}`);
                    if (!removeCharacters([id]).includes(id)) throw new Error(language.recoveryDrafts.missingCharacter);
                } else if (findCharacter(id)) {
                    if (!replaceCharacterFields(value)) throw new Error(language.recoveryDrafts.missingCharacter);
                } else {
                    addCharacter(value);
                    changedMembership.add(id);
                    keys.add(`characterOrder/${SINGLETON_RESOURCE_ID}`);
                }
            } else replaceRecord(kind as RecordKind, value);
            reconcileSelection();
            changeLanguage(settings.ui.language);
        } else if (entry.scope === "order") {
            const vector = draftOrder(entry);
            const current = chatList(entry.target).map((chat) => chat.id);
            const present = new Set(current);
            const ids = [...new Set(vector)].filter((id) => present.has(id));
            const included = new Set(ids);
            ids.push(...current.filter((id) => !included.has(id)));
            keys.add(`chats/${entry.target}`);
            if (!ids.every((id, index) => current[index] === id)) reorderChats(entry.target, ids);
        } else {
            const { ref, ops, snapshot } = draftChat(entry);
            keys.add(`chats/${ref.chaId}`);
            if (!chatEntry(ref)) {
                if (!snapshot) throw new Error(language.recoveryDrafts.noSnapshot);
                const chat = createChat(ref.chaId, { ...snapshot, id: "" });
                keys.add(`chats/${ref.chaId}/${chat.id}`);
            } else {
                const owner = chatOwnerToken(ref.chaId);
                release = pinChat(ref);
                if (!(await ensureChatLoaded(ref)) || chatOwnerToken(ref.chaId) !== owner || !findChat(ref)) {
                    throw new Error(language.recoveryDrafts.unavailable);
                }
                assertSaveAdmission();
                if (entry.epoch !== getResourceEpoch()) throw new Error(language.recoveryDrafts.otherEpoch);
                if (isChatGenerating(ref)) throw new Error(language.chatGenerating);
                keys.add(`chats/${ref.chaId}/${ref.chatId}`);
                skipped = applyChatOps(ref, ops);
            }
        }
        const result = await flushResources({ scope });
        // Flush reports kind/id for records and chats/characterId[/chatId] for chat work.
        const affected = (key: string) => {
            const normalized = key.replaceAll("\u0000", "/");
            return (
                keys.has(normalized) ||
                [...changedMembership].some(
                    (id) => normalized === `chats/${id}` || normalized.startsWith(`chats/${id}/`),
                )
            );
        };
        if (result.discarded.some(affected) || result.refused.some(affected)) {
            throw new Error(language.recoveryDrafts.notSaved);
        }
        await recoveryDrafts.remove(entry.id);
        return { skipped };
    } finally {
        release?.();
    }
}

class RecoveryTimeout extends Error {}

/**
 * Claims and classifies durable intent before any recovered local write. The deadline covers all
 * reads and moves; failure closes the journal (its bounded drain adds at most its open timeout).
 */
export async function recoverJournal(
    options: { journal?: DraftJournal; timeoutMs?: number; now?: () => number } = {},
): Promise<void> {
    const journal = options.journal ?? pageDraftJournal();
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = now() + timeoutMs;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
        if (!active || now() >= deadline) throw new RecoveryTimeout();
    };
    const recover = async () => {
        const enabled = await journal.start();
        check();
        if (!enabled || !journal.enabled) return;
        await journal.adoptOrphans();
        check();
        const rows = await journal.readOwn();
        check();
        const epoch = getResourceEpoch();
        const moves: DraftMove[] = [];
        const installations: Installation[] = [];
        for (const entry of rows) {
            check();
            if (entry.epoch === epoch && entry.scope !== "record") continue;
            let item: Installation | null = null;
            if (entry.epoch === epoch && entry.scope === "record") {
                try {
                    item = prepare(entry);
                } catch {
                    // One malformed row becomes a draft; it never blocks another target's recovery.
                }
            }
            if (item) installations.push(item);
            else moves.push({ epoch: entry.epoch, scope: entry.scope, target: entry.target, version: entry.version });
        }
        check();
        const moved = moves.length ? await journal.moveToDrafts(moves) : [];
        check();
        // Adoption may itself have drafted a collision, even when this tab has no mutation rows.
        const drafts = await journal.listDrafts();
        check();

        // No more awaits: characters precede their order vector, then selection and locale see the
        // final records. The server baseline and the boot cache's captured snapshot stay untouched.
        installations.sort((a, b) => rank(a.kind) - rank(b.kind));
        let recovered = moved.filter((id) => id !== null).length;
        for (const item of installations) {
            try {
                install(item);
                recovered += 1;
            } catch {
                // A local writer can refuse a malformed row. Keep its durable layers for another
                // boot, continue the other targets, and never claim that this row was recovered.
                recordClientEvent({ kind: "sync", phase: "journalSkipped", reason: "format", entries: 1 });
            }
        }
        reconcileSelection();
        changeLanguage(settings.ui.language);
        recoveryDrafts.replace(drafts, epoch);
        // Adoption has its own reason: orphan. This count describes only this boot's decisions.
        if (recovered > 0) recordClientEvent({ kind: "sync", phase: "journalRecovered", entries: recovered });
    };
    try {
        await Promise.race([
            recover(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    active = false;
                    reject(new RecoveryTimeout());
                }, timeoutMs);
            }),
        ]);
    } catch (error) {
        active = false;
        recordClientEvent({
            kind: "sync",
            phase: "journalFailed",
            reason: error instanceof RecoveryTimeout ? "timeout" : "readFailed",
        });
        // close() disables calls synchronously before waiting for its bounded drain. A late read
        // cannot pass check(), and the save adapter checks enabled beside start()'s cached answer.
        await journal.close();
    } finally {
        active = false;
        clearTimeout(timer);
    }
}

function rank(kind: string) {
    return kind === "characters" ? 0 : kind === "characterOrder" ? 2 : 1;
}
