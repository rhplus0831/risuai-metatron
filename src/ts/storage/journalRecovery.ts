import { changeLanguage, language } from "src/lang";
import type { ChatOp } from "../../../shared/chats.ts";
import { CHAT_META_FORBIDDEN_KEYS, CHAT_META_MERGE_KEYS } from "../../../shared/chats.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { isMessageTranslation, dropInvalidTranslation } from "../../../shared/translation/messageTranslation.ts";
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
    heldChatRevision,
    heldOrderRevision,
    installRecoveredChat,
    installRecoveredOrder,
    isCharacterGenerating,
    isChatGenerating,
    mergeChatMeta,
    patchMessage,
    pinChat,
    removeMessagesUnasked,
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
    type JournalChatOp,
    type JournalRelease,
} from "./draftJournal";
import { isJournalEligible } from "./journalEligibility";
import { replaceRecord, type RecordKind } from "./records.svelte";
import { recoveryDrafts } from "./recoveryDrafts.svelte";
import { getResourceEpoch } from "./resourceClient";
import {
    adoptRecoveredRecord,
    adoptRecoveredChat,
    MAX_BATCH_OPERATIONS,
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

type ChatDecision =
    | { action: "draft" }
    | { action: "satisfied" }
    | { action: "load" }
    | { action: "create"; snapshot: Chat; groupId: string }
    | { action: "replay"; ops: ChatOp[]; baseRevision: string | null; groupId: string; splitPending: boolean };
type RecoveryChatState = { revision: string; data?: DeepReadonly<Chat> } | null;
type OrderDecision = { action: "draft" | "satisfied" } | { action: "replay"; ids: string[] };

const recoveryId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
const revisionOrNull = (value: unknown) => value === null || (typeof value === "string" && value.length > 0);
const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((id) => typeof id === "string");
const ids = (value: unknown): value is string[] =>
    strings(value) && value.every(recoveryId) && new Set(value).size === value.length;
const equal = (a: unknown, b: unknown) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left === right || (left !== undefined && right !== undefined && sameJson(left, right));
};
const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function validMessage(value: unknown): value is Message {
    return (
        isPlainObject(value) &&
        recoveryId(value.chatId) &&
        (value.role === "user" || value.role === "char") &&
        typeof value.data === "string"
    );
}

function validChat(value: unknown, chatId: string): value is Chat {
    return (
        isPlainObject(value) &&
        value.id === chatId &&
        Array.isArray(value.message) &&
        value.message.every(validMessage) &&
        new Set(value.message.map((message) => message.chatId)).size === value.message.length &&
        (value.name == null || typeof value.name === "string") &&
        (value.note == null || typeof value.note === "string") &&
        (value.localLore == null || Array.isArray(value.localLore)) &&
        (value.fmIndex == null || typeof value.fmIndex === "number")
    );
}

function validRecoveryOp(value: unknown, chatId: string): value is ChatOp {
    if (!isPlainObject(value)) return false;
    if (
        value.generation !== undefined &&
        (!isPlainObject(value.generation) ||
            !recoveryId(value.generation.id) ||
            !Number.isSafeInteger(value.generation.seq) ||
            (value.generation.seq as number) < 0 ||
            (value.generation.final !== undefined && typeof value.generation.final !== "boolean"))
    )
        return false;
    switch (value.op) {
        case "create":
            return (
                validChat(value.chat, chatId) &&
                (value.index === undefined || (Number.isSafeInteger(value.index) && (value.index as number) >= 0))
            );
        case "replace":
            return validChat(value.chat, chatId);
        case "delete":
            return true;
        case "begin":
            return recoveryId(value.id) && recoveryId(value.generationId);
        case "setText":
            return recoveryId(value.id) && typeof value.text === "string";
        case "setMessage":
            return validMessage(value.message);
        case "setTranslation":
            return recoveryId(value.id) && (value.translation === null || isMessageTranslation(value.translation));
        case "remove":
            return ids(value.ids) && value.ids.length > 0 && (value.retract === undefined || value.retract === true);
        case "append": {
            const anchor = value.anchor;
            return (
                Array.isArray(value.messages) &&
                value.messages.length > 0 &&
                value.messages.every(validMessage) &&
                new Set(value.messages.map((message) => message.chatId)).size === value.messages.length &&
                isPlainObject(anchor) &&
                Object.keys(anchor).length === 1 &&
                (anchor.start === true || anchor.end === true || recoveryId(anchor.after))
            );
        }
        case "meta":
        case "patchMessage": {
            const set = value.set ?? {};
            const unset = value.unset ?? [];
            if (!isPlainObject(set) || !strings(unset) || unset.some((key) => Object.hasOwn(set, key))) return false;
            const fields = [...Object.keys(set), ...unset];
            if (fields.includes("__proto__")) return false;
            if (value.op === "patchMessage") {
                return (
                    recoveryId(value.id) &&
                    fields.length > 0 &&
                    !fields.some((field) => field === "chatId" || field === "translation") &&
                    !unset.some((field) => field === "role" || field === "data") &&
                    (!Object.hasOwn(set, "data") || typeof set.data === "string") &&
                    (!Object.hasOwn(set, "role") || set.role === "user" || set.role === "char")
                );
            }
            const merge = value.merge ?? {};
            const mergeUnset = value.mergeUnset ?? {};
            return (
                !fields.some((field) => CHAT_META_FORBIDDEN_KEYS.includes(field)) &&
                isPlainObject(merge) &&
                isPlainObject(mergeUnset) &&
                Object.entries(merge).every(
                    ([key, map]) => CHAT_META_MERGE_KEYS.includes(key) && !fields.includes(key) && isPlainObject(map),
                ) &&
                Object.entries(mergeUnset).every(
                    ([key, keys]) => CHAT_META_MERGE_KEYS.includes(key) && !fields.includes(key) && strings(keys),
                )
            );
        }
        default:
            return false;
    }
}

/** Checks before values in order and the final touched values, without changing the boot mirror. */
export function decideChatOpsRecovery(
    ops: JournalChatOp[],
    chat: DeepReadonly<Chat>,
): "replay" | "satisfied" | "draft" {
    const observed = copyJson<Chat>(chat as Chat);
    const scratch = copyJson(observed);
    const touched = new Map<string, Set<string> | null>();
    const appended = new Set<string>();
    let append: Extract<ChatOp, { op: "append" }> | undefined;
    let notApplied = true;
    const message = (state: Chat, id: string) => state.message.find((row) => row.chatId === id);
    const touch = (id: string, fields?: string[]) => {
        if (!fields) touched.set(id, null);
        else if (touched.get(id) !== null) touched.set(id, new Set([...(touched.get(id) ?? []), ...fields]));
    };
    const fieldsOf = (value: object, fields: string[]) =>
        Object.fromEntries(
            fields
                .filter((field) => Object.hasOwn(value, field))
                .map((field) => [field, (value as Record<string, unknown>)[field]]),
        );
    for (const item of ops) {
        const { op, before } = item;
        if (!validRecoveryOp(op, chat.id!) || !before || !isPlainObject(before)) return "draft";
        if (op.op === "setTranslation" || op.op === "begin" || ("generation" in op && op.generation !== undefined))
            return "draft";
        if (op.op === "append") {
            // Mixed membership edits need an order history that the before sidecars do not carry.
            if (
                append ||
                ops.some(({ op: other }) => other.op === "remove") ||
                !("absent" in before) ||
                before.absent !== true
            )
                return "draft";
            append = op;
            for (const row of op.messages) {
                if (touched.has(row.chatId!)) return "draft";
                appended.add(row.chatId!);
                if (message(scratch, row.chatId!)) notApplied = false;
                touch(row.chatId!);
            }
            scratch.message = scratch.message.filter((row) => !appended.has(row.chatId!));
            const at =
                "start" in op.anchor
                    ? 0
                    : "end" in op.anchor
                      ? scratch.message.length
                      : scratch.message.findIndex((row) => row.chatId === op.anchor["after"]) + 1;
            if ("after" in op.anchor && at === 0) return "draft";
            const added = copyJson(op.messages);
            added.forEach(dropInvalidTranslation);
            scratch.message.splice(at, 0, ...added);
            continue;
        }
        if (!("value" in before)) return "draft";
        if (op.op === "meta" || op.op === "patchMessage") {
            const target = op.op === "meta" ? scratch : message(scratch, op.id);
            const id = op.op === "meta" ? "" : op.id;
            if (!target || appended.has(id) || !isPlainObject(before.value)) return "draft";
            const fields = [
                ...new Set([
                    ...Object.keys(op.set ?? {}),
                    ...(op.unset ?? []),
                    ...(op.op === "meta" ? [...Object.keys(op.merge ?? {}), ...Object.keys(op.mergeUnset ?? {})] : []),
                ]),
            ];
            if (fields.length === 0 || Object.keys(before.value).some((key) => !fields.includes(key))) return "draft";
            // These fields have server defaults or normalization beyond a plain assignment.
            if (
                op.op === "meta" &&
                (fields.includes("loreOverrides") ||
                    fields.some(
                        (field) =>
                            ["name", "note", "localLore", "fmIndex"].includes(field) &&
                            ((op.unset ?? []).includes(field) || op.set?.[field] == null),
                    ))
            )
                return "draft";
            if (!equal(fieldsOf(target, fields), before.value)) notApplied = false;
            const record = target as unknown as Record<string, unknown>;
            for (const key of op.unset ?? []) delete record[key];
            for (const [key, value] of Object.entries(op.set ?? {})) record[key] = copyJson(value);
            if (op.op === "meta") {
                for (const key of new Set([...Object.keys(op.merge ?? {}), ...Object.keys(op.mergeUnset ?? {})])) {
                    const prior = before.value[key];
                    if (!isPlainObject(prior) && !Object.hasOwn(op.merge ?? {}, key)) {
                        if (Object.hasOwn(before.value, key)) record[key] = copyJson(prior);
                        else delete record[key];
                        continue;
                    }
                    const map = isPlainObject(prior) ? copyJson(prior) : {};
                    for (const name of op.mergeUnset?.[key] ?? []) delete map[name];
                    record[key] = { ...map, ...copyJson(op.merge?.[key] ?? {}) };
                }
            }
            touch(id, fields);
            continue;
        }
        if (op.op === "create" || op.op === "replace" || op.op === "delete") return "draft";
        const id = op.op === "setMessage" ? op.message.chatId! : op.op === "remove" ? op.ids[0] : op.id;
        if (appended.has(id)) return "draft";
        const row = message(scratch, id);
        if (op.op === "remove") {
            if (op.ids.length !== 1 || !validMessage(before.value) || before.value.chatId !== id) return "draft";
            if (!equal(row, before.value)) notApplied = false;
            scratch.message = scratch.message.filter((row) => row.chatId !== id);
            touch(id);
        } else if (!row) return "draft";
        else if (op.op === "setText") {
            if (typeof before.value !== "string") return "draft";
            if (row.data !== before.value) notApplied = false;
            row.data = op.text;
            touch(id, ["data"]);
        } else if (op.op === "setMessage") {
            if (
                !validMessage(before.value) ||
                before.value.chatId !== id ||
                [row, before.value, op.message].some((value) => Object.hasOwn(value, "translation"))
            )
                return "draft";
            if (!equal(row, before.value)) notApplied = false;
            scratch.message[scratch.message.indexOf(row)] = copyJson(op.message);
            touch(id);
        } else return "draft";
    }
    const landed =
        [...touched].every(([id, fields]) => {
            const current = id ? message(observed, id) : observed;
            const final = id ? message(scratch, id) : scratch;
            return fields === null
                ? equal(current, final)
                : !!current && !!final && equal(fieldsOf(current, [...fields]), fieldsOf(final, [...fields]));
        }) &&
        (!append ||
            [...appended].every(
                (id) =>
                    observed.message.findIndex((row) => row.chatId === id) ===
                    scratch.message.findIndex((row) => row.chatId === id),
            ));
    return landed ? "satisfied" : notApplied ? "replay" : "draft";
}

/** Classifies a chat against the boot revision, requesting a whole read only for by-id predicates. */
export function decideChatRecovery(
    layers: StoredLayers<"chat">,
    server: RecoveryChatState,
    context: { parent: boolean; chatId: string; canDelete: boolean },
): ChatDecision {
    const draft: ChatDecision = { action: "draft" };
    const resend = layers.resend?.value;
    const pending = layers.pending?.value;
    if (!context.parent || layers.refused || (!resend && !pending)) return draft;
    const validBatch = (batch: { groupId: string; baseRevision: string | null }, ops: unknown[]) =>
        recoveryId(batch.groupId) &&
        revisionOrNull(batch.baseRevision) &&
        Array.isArray(ops) &&
        ops.every((op) => validRecoveryOp(op, context.chatId));
    if (
        resend &&
        (!validBatch(resend, resend.ops) ||
            resend.ops.length === 0 ||
            typeof resend.inDoubt !== "boolean" ||
            !Number.isSafeInteger(resend.seq))
    )
        return draft;
    if (
        pending &&
        (!Array.isArray(pending.ops) ||
            pending.ops.some((item) => !isPlainObject(item)) ||
            !validBatch(
                pending,
                pending.ops.map((item) => item.op),
            ) ||
            (pending.delete !== undefined && typeof pending.delete !== "boolean") ||
            (pending.createSnapshot !== undefined && !validChat(pending.createSnapshot, context.chatId)))
    )
        return draft;
    if (resend) {
        if (
            !server ||
            (resend.ops[0].op === "create") !== (resend.baseRevision === null) ||
            resend.ops.slice(1).some((op) => op.op === "create") ||
            (resend.ops.some((op) => op.op === "delete") && !context.canDelete)
        )
            return draft;
        return {
            action: "replay",
            ops: resend.ops,
            baseRevision: resend.baseRevision,
            groupId: resend.groupId,
            splitPending: !!pending,
        };
    }
    if (pending!.ops.length > MAX_BATCH_OPERATIONS) return draft;
    if (pending!.createSnapshot) {
        return !server &&
            pending!.baseRevision === null &&
            !pending!.delete &&
            !pending!.ops.some(
                ({ op }) =>
                    op.op === "delete" ||
                    op.op === "create" ||
                    op.op === "begin" ||
                    ("generation" in op && op.generation !== undefined),
            )
            ? { action: "create", snapshot: pending!.createSnapshot, groupId: pending!.groupId }
            : draft;
    }
    const ops = pending!.ops.map((item) => item.op);
    if (!server || pending!.baseRevision === null || ops.some((op) => op.op === "create")) return draft;
    if (pending!.delete && !ops.some((op) => op.op === "delete")) return draft;
    if (ops.some((op) => op.op === "delete") && !context.canDelete) return draft;
    const whole = ops.some(
        (op) =>
            op.op === "replace" ||
            op.op === "delete" ||
            op.op === "begin" ||
            (op.op === "remove" && op.ids.length > 1) ||
            ("generation" in op && op.generation !== undefined),
    );
    if (whole) {
        if (server.revision !== pending!.baseRevision) return draft;
    } else {
        if (!server.data) return { action: "load" };
        const action = decideChatOpsRecovery(pending!.ops, server.data);
        if (action !== "replay") return { action };
    }
    return {
        action: "replay",
        ops,
        baseRevision: pending!.baseRevision,
        groupId: pending!.groupId,
        splitPending: false,
    };
}

/** Orders use the untouched server vector and revision, with membership after recovered creates/deletes. */
export function decideOrderRecovery(
    layers: StoredLayers<"order">,
    server: { revision: string | null; ids: string[] },
    membership: string[],
    parent: boolean,
): OrderDecision {
    const draft: OrderDecision = { action: "draft" };
    const sent = layers.sent?.value;
    const latest = layers.latest?.value;
    if (
        !parent ||
        layers.refused ||
        (!sent && !latest) ||
        [sent, latest].some((value) => value && (!revisionOrNull(value.baseRevision) || !ids(value.ids)))
    )
        return draft;
    const final = latest ?? sent!;
    if (final.ids.length !== membership.length || !final.ids.every((id) => membership.includes(id))) return draft;
    const replay: OrderDecision = { action: "replay", ids: final.ids };
    if (sent) {
        if (server.revision === sent.baseRevision) return equal(final.ids, sent.ids) ? replay : draft;
        if (!equal(server.ids, sent.ids)) return draft;
        if (!latest) return { action: "satisfied" };
        return latest.baseRevision === server.revision ? replay : draft;
    }
    if (equal(server.ids, final.ids)) return { action: "satisfied" };
    return final.baseRevision === server.revision ? replay : draft;
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
                // fields avoids import transforms; chat recovery or initializeChats supplies its chats.
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
    let snapshotEnd = ops.length;
    if (!snapshot) {
        for (const [index, op] of ops.entries()) {
            if (op.op === "create" || op.op === "replace") {
                snapshot = op.chat;
                snapshotEnd = index + 1;
            }
        }
    }
    // A pending create snapshot already projects every edit in the live mirror.
    return { ref: { chaId, chatId }, ops, snapshot, tail: ops.slice(snapshotEnd) };
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
            const destination = chatEntry({ chaId: ref.chaId, chatId: entry.id });
            const chat = destination ?? chatEntry(ref);
            name = `${chat?.name || snapshot?.name || language.unnamedCharacter} · ${character?.name || language.unnamedCharacter}`;
            if (!character) reason = language.recoveryDrafts.missingCharacter;
            else if (!destination && chat && isChatGenerating(ref)) reason = language.chatGenerating;
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
    if (recoveryDrafts.isApplied(entry.id)) reason = language.recoveryDrafts.appliedNotRemoved;
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
            if (ids.length > 0) removeMessagesUnasked(ref, ids, op.retract ? { retract: true } : {});
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
            const { ref, ops, snapshot, tail } = draftChat(entry);
            const destination = { chaId: ref.chaId, chatId: entry.id };
            keys.add(`chats/${ref.chaId}`);
            if (chatEntry(destination)) {
                // A previous Apply queued the complete create; its lost answer only needs a flush.
                keys.add(`chats/${destination.chaId}/${destination.chatId}`);
            } else if (!chatEntry(ref)) {
                if (!snapshot) throw new Error(language.recoveryDrafts.noSnapshot);
                const chat = createChat(ref.chaId, { ...snapshot, id: entry.id });
                keys.add(`chats/${ref.chaId}/${chat.id}`);
                skipped = applyChatOps({ chaId: ref.chaId, chatId: chat.id }, tail);
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
        try {
            await recoveryDrafts.remove(entry.id);
        } catch {
            // The changes are saved; applying the kept draft again would repeat them.
            recoveryDrafts.markApplied(entry.id);
            throw new Error(language.recoveryDrafts.appliedNotRemoved);
        }
        return { skipped };
    } finally {
        release?.();
    }
}

class RecoveryTimeout extends Error {}

/**
 * Claims and classifies durable intent before any recovered local write. The deadline covers all
 * reads, moves, and handoff; failure closes the journal (its bounded drain adds at most its open timeout).
 */
export async function recoverJournal(
    options: { journal?: DraftJournal; timeoutMs?: number; now?: () => number } = {},
): Promise<void> {
    const journal = options.journal ?? pageDraftJournal();
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = now() + timeoutMs;
    const unpin: (() => void)[] = [];
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
        await journal.purgeExpired();
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
        const parents = new Set(characterList().map((character) => character.chaId));
        for (const item of installations) {
            if (item.kind !== "characters" || item.decision.action !== "replay") continue;
            if (item.decision.text === null) parents.delete(item.id);
            else parents.add(item.id);
        }
        const membership = new Map([...parents].map((id) => [id, chatList(id).map((chat) => chat.id)]));
        const orders = rows
            .filter((entry) => entry.epoch === epoch && entry.scope === "order")
            .map((entry) => ({
                entry: entry as Extract<MutationEntry, { scope: "order" }>,
                server: {
                    revision: heldOrderRevision(entry.target) ?? null,
                    ids: [...(membership.get(entry.target) ?? [])],
                },
            }));
        const chats: {
            entry: Extract<MutationEntry, { scope: "chat" }>;
            ref: ChatRef;
            decision: Exclude<ChatDecision, { action: "draft" | "satisfied" | "load" }> | { action: "satisfied" };
            splitIndex?: number;
        }[] = [];
        const candidates = rows
            .filter((entry) => entry.epoch === epoch && entry.scope === "chat")
            .map((entry) => {
                const [chaId, chatId, extra] = entry.target.split("\u0000");
                const ref = { chaId, chatId };
                const revision = heldChatRevision(ref);
                return { entry: entry as Extract<MutationEntry, { scope: "chat" }>, ref, extra, revision };
            });
        for (const { entry, ref, extra, revision } of candidates) {
            check();
            const context = {
                parent: parents.has(ref.chaId),
                chatId: ref.chatId,
                canDelete: (membership.get(ref.chaId)?.length ?? 0) > 1 && !isChatGenerating(ref),
            };
            let decision: ChatDecision = { action: "draft" };
            if (recoveryId(ref.chaId) && recoveryId(ref.chatId) && extra === undefined) {
                const decide = (server: RecoveryChatState): ChatDecision => {
                    try {
                        return decideChatRecovery(entry.layers, server, context);
                    } catch {
                        return { action: "draft" };
                    }
                };
                decision = decide(revision ? { revision } : null);
                const deleting = decision.action === "replay" && decision.ops.some((op) => op.op === "delete");
                if (decision.action === "load" || deleting) {
                    unpin.push(pinChat(ref));
                    const data = await ensureChatLoaded(ref);
                    check();
                    context.canDelete = context.canDelete && !isChatGenerating(ref);
                    decision = data
                        ? decide({ revision: deleting ? heldChatRevision(ref)! : revision!, data })
                        : { action: "draft" };
                }
            }
            if (decision.action === "draft" || decision.action === "load") {
                moves.push({ epoch, scope: entry.scope, target: entry.target, version: entry.version });
                continue;
            }
            let splitIndex: number | undefined;
            if (decision.action === "replay" && decision.splitPending) {
                splitIndex = moves.length;
                moves.push({ epoch, scope: "chat", target: entry.target, version: entry.version, layers: ["pending"] });
            }
            chats.push({ entry, ref, decision, splitIndex });
            if (decision.action === "create") membership.get(ref.chaId)!.push(ref.chatId);
            if (decision.action === "replay" && decision.ops.some((op) => op.op === "delete")) {
                membership.set(
                    ref.chaId,
                    membership.get(ref.chaId)!.filter((id) => id !== ref.chatId),
                );
            }
        }
        // A whole read can discover a remote deletion. Build the order's membership from that
        // mirror plus the staged installations, and recheck deletes against the remaining chats.
        for (const id of parents)
            membership.set(
                id,
                chatList(id).map((chat) => chat.id),
            );
        for (let index = 0; index < chats.length;) {
            const item = chats[index];
            const { entry, ref, decision, splitIndex } = item;
            const members = membership.get(ref.chaId)!;
            if (decision.action === "create") members.push(ref.chatId);
            if (decision.action === "replay" && decision.ops.some((op) => op.op === "delete")) {
                if (!members.includes(ref.chatId) || members.length <= 1 || isChatGenerating(ref)) {
                    const move: DraftMove = { epoch, scope: "chat", target: entry.target, version: entry.version };
                    if (splitIndex !== undefined) moves[splitIndex] = move;
                    else moves.push(move);
                    chats.splice(index, 1);
                    continue;
                }
                membership.set(
                    ref.chaId,
                    members.filter((id) => id !== ref.chatId),
                );
            }
            index += 1;
        }
        const recoveredOrders: { entry: Extract<MutationEntry, { scope: "order" }>; decision: OrderDecision }[] = [];
        for (const { entry, server } of orders) {
            const decision = decideOrderRecovery(
                entry.layers,
                server,
                membership.get(entry.target) ?? [],
                parents.has(entry.target) && recoveryId(entry.target),
            );
            if (decision.action === "draft")
                moves.push({ epoch, scope: "order", target: entry.target, version: entry.version });
            else recoveredOrders.push({ entry, decision });
        }
        check();
        const moved = moves.length ? await journal.moveToDrafts(moves) : [];
        check();
        if (moves.some((move, index) => move.scope !== "record" && !move.layers && !moved[index])) {
            throw new Error("Chat recovery could not preserve its drafts");
        }
        // Adoption may itself have drafted a collision, even when this tab has no mutation rows.
        const drafts = await journal.listDrafts();
        check();

        // Install synchronously before handing reservations over. The server baseline and the boot
        // cache's captured snapshot stay untouched.
        installations.sort((a, b) => rank(a.kind) - rank(b.kind));
        let recovered = moved.filter((id) => id !== null).length;
        const failedParents = new Set<string>();
        for (const item of installations) {
            try {
                install(item);
                recovered += 1;
            } catch {
                if (item.kind === "characters") failedParents.add(item.id);
                // A local writer can refuse a malformed row. Keep its durable layers for another
                // boot, continue the other targets, and never claim that this row was recovered.
                recordClientEvent({ kind: "sync", phase: "journalSkipped", reason: "format", entries: 1 });
            }
        }
        const released: JournalRelease[] = [];
        for (const { entry, ref, decision, splitIndex } of chats) {
            try {
                if (failedParents.has(ref.chaId) || !findCharacter(ref.chaId))
                    throw new Error("Recovered parent was not installed");
                if (splitIndex !== undefined && !moved[splitIndex])
                    throw new Error("Dependent chat work was not drafted");
                if (decision.action === "create")
                    installRecoveredChat(
                        ref,
                        { groupId: decision.groupId, snapshot: decision.snapshot },
                        entry.createdAt,
                    );
                else if (decision.action === "replay") installRecoveredChat(ref, decision, entry.createdAt);
                const layers = { ...entry.layers };
                if (splitIndex !== undefined) delete layers.pending;
                adoptRecoveredChat(entry, layers);
                released.push(entry);
                recovered += 1;
            } catch {
                recordClientEvent({ kind: "sync", phase: "journalSkipped", reason: "format", entries: 1 });
            }
        }
        for (const { entry, decision } of recoveredOrders) {
            try {
                if (failedParents.has(entry.target) || !findCharacter(entry.target))
                    throw new Error("Recovered parent was not installed");
                const vector = (entry.layers.latest ?? entry.layers.sent)!.value.ids;
                const current = chatList(entry.target).map((chat) => chat.id);
                if (vector.length !== current.length || !vector.every((id) => current.includes(id)))
                    throw new Error("Recovered chat membership was not installed");
                if (decision.action === "replay") installRecoveredOrder(entry.target, decision.ids);
                adoptRecoveredChat(entry, entry.layers);
                released.push(entry);
                recovered += 1;
            } catch {
                recordClientEvent({ kind: "sync", phase: "journalSkipped", reason: "format", entries: 1 });
            }
        }
        reconcileSelection();
        changeLanguage(settings.ui.language);
        recoveryDrafts.replace(drafts, epoch);
        if (released.length > 0) {
            const layers = await journal.release(released);
            check();
            if (layers.length !== released.length) throw new Error("Chat recovery could not release installed rows");
        }
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
        for (const release of unpin) release();
    }
}

function rank(kind: string) {
    return kind === "characters" ? 0 : kind === "characterOrder" ? 2 : 1;
}
