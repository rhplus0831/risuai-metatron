import { randomUUID } from "node:crypto";
import { CharacterShapeError, normalizeCharacter } from "../../../../shared/characters.ts";
import type { Chat } from "../../../../shared/database.ts";
import type { ChatGroup } from "../../../../shared/chats.ts";
import { ModuleShapeError, upgradeLorebook } from "../../../../shared/modules.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import type { UpstreamImportReport, UpstreamImportSelection } from "../../../../shared/upstreamBackup.ts";
import { isPlainObject } from "../../../../shared/valueKinds.ts";
import { prepareChatGroups } from "../chatStore.ts";
import { assertToolCalls, normalizeChatMeta, normalizeMessage } from "../chats.ts";
import { isValidResourceId, ResourceValidationError } from "../resourceStore.ts";
import type { ColdRecordResult } from "./archive.ts";
import { kindOf, ownCopy, PendingReport, setOwn, storedValue, tryNormalize } from "./importRecords.ts";

/**
 * The characters, groups, and chats of an upstream RisuAI database, for `convertUpstreamDatabase`
 * (`importDatabase.ts`). Upstream is read from RisuAI `669b12ce`: "U" is its `src/ts/`. No I/O: the
 * cold-storage payloads come in as `readColdEntry` results (`archive.ts`).
 *
 * Per character, in upstream order:
 * - `null` entries are dropped (as upstream's boot does), and `§temp`/`§playground` (multiuser and
 *   playground leftovers, U `globalApi.svelte.ts` `checkCharOrder`) are dropped and reported.
 * - A cold stub (`coldstorage: <key>`) is replaced by its payload's `character` when the payload
 *   names the stub's `chaId` (U `characters.ts` `changeChar`) and that character converts; otherwise
 *   the stub is kept (name, image, a fresh empty chat) and `cold-missing` reported.
 * - The client's creation steps (`characterStore.svelte.ts` `prepareNewCharacter`, ported, not
 *   imported): `normalizeCharacter`, `ttsMode` `"none"` → `""`, `creation_date` when absent, the
 *   `globalLore` conversion (`upgradeLorebook`), a first chat when none is left, each chat's `fmIndex`
 *   (the character's `firstMsgIndex`) and `localLore`, and `postHistoryInstructions` moved into the note
 *   of the chat at `chatPage` (else the first kept chat). Upstream's `checkNewFormat` repair of image
 *   paths runs for a database without `formatversion`.
 * - The record is the `characters` kind's normalizer output without `chats`, `chatPage`,
 *   `coldstorage`, `coldStoragedChats`, `realmId`, and `reloadKeys`. A character it refuses is left
 *   out with its chats (`invalid-character`).
 * - Ids: a valid `chaId` is kept by the first kept character holding it; a missing, invalid, or
 *   repeated one gets a new id. An invalid id held by one character only is rewritten where it is
 *   referenced (group members, message speakers, `renamed` for `characterOrder`); a repeated one keeps
 *   pointing at its first holder.
 * - Groups: member ids that name no kept character are removed with their `characterTalks` and
 *   `characterActive` entries (`group-member-missing`).
 *
 * Per chat, in upstream order (the order a staged store's sequential creates give the chat order):
 * - A cold chat (`message[0].data` is `U+EF01 COLDSTORAGE U+EF01 <key>`, U `coldstorage.svelte.ts`)
 *   takes its payload as upstream's `preLoadChat` does: a list is the messages; an object with a
 *   `message` list gives `message`, `hypaV2Data`, `hypaV3Data`, `scriptstate`, and `localLore` (a
 *   missing one is unset). A missing payload keeps the chat without messages (`cold-missing`).
 * - Ids: a valid chat id unique in its character is kept, else replaced; message `chatId`s likewise
 *   within the chat (`normalizeMessage` then drops an invalid stored translation).
 * - Bindings: the converted selected prompt and model preset, `bindedPersona` when it names a
 *   converted persona and else the selected persona, no `bindingReview`.
 * - Toggles: upstream reads a chat's `GLGlobalVariables` value first whenever it is not `""` or
 *   `"null"`, with or without `useLocallySetGlobalVariables` (which only steers its writes, U
 *   `parser/chatVar.svelte.ts` `getGlobalChatVar`); metatron reads it the same way
 *   (`resolveGlobalChatVar`), except that a `""` toggle value counts as set. So the flag is dropped,
 *   the map kept, and its `""` `toggle_*` values removed so the global value still applies.
 * - A message that is not an object, has a role other than `user`/`char`, a `data` that is not a
 *   string (a missing one becomes `""`), or no stored form is left out; a chat field of the wrong kind
 *   is reset (`invalid-data`). The finished chat passes `prepareChatGroups`, the batch's own check, or
 *   is left out (`invalid-chat`).
 * - A chat whose messages show an inlay (`{{inlay::id}}`, `{{inlayed::id}}`, `{{inlayeddata::id}}`)
 *   is counted once (`inlays-not-in-backup`): upstream keeps inlays outside its backups.
 */

/** Upstream's cold-chat marker (U `process/coldstorageData.ts` `coldStorageHeader`). */
const COLD_CHAT_HEADER = "COLDSTORAGE";
/** The chat fields a cold chat's object payload carries (U `coldstorage.svelte.ts` `preLoadChat`). */
const COLD_CHAT_FIELDS = ["message", "hypaV2Data", "hypaV3Data", "scriptstate", "localLore"];
const TEMPORARY_IDS = new Set(["§temp", "§playground"]);
const STRIPPED_FIELDS = ["chats", "chatPage", "coldstorage", "coldStoragedChats", "realmId", "reloadKeys"];
const INLAY_REFERENCE = /{{(?:inlay|inlayed|inlayeddata)::(.+?)}}/;
const TOGGLE_PREFIX = "toggle_";
/** The id a candidate character is checked under before its final id is known. */
const CHECK_ID = "upstream-import-check";

export type ConvertedCharacters = {
    /** `characters` records (id = `chaId`), in upstream order. */
    characters: { id: string; data: Record<string, unknown> }[];
    /** One create group per chat, each character's chats in upstream order. */
    chats: ChatGroup[];
    /** The final ids of the kept characters. */
    ids: ReadonlySet<string>;
    /** An upstream id rewritten to a new one (an invalid id held by one character). */
    renamed: ReadonlyMap<string, string>;
};

export type CharacterContext = {
    report: UpstreamImportReport;
    cold: ReadonlyMap<string, ColdRecordResult> | undefined;
    /** Upstream's `formatversion` (the image path repair runs when it is falsy). */
    formatVersion: unknown;
    now: number;
    selection: UpstreamImportSelection;
    personaIds: ReadonlySet<string>;
};

type PreparedChat = { index: number; chat: Record<string, unknown>; messages: Record<string, unknown>[] };

type Candidate = {
    /** The character record before its final id: checked under `CHECK_ID`. */
    record: Record<string, unknown>;
    chats: PreparedChat[];
    notes: PendingReport;
};

type Kept = Candidate & { sourceId: unknown };

export function convertCharacters(value: unknown, context: CharacterContext): ConvertedCharacters {
    const { report } = context;
    let entries: readonly unknown[] = [];
    if (Array.isArray(value)) {
        entries = value;
    } else if (value !== undefined && value !== null) {
        const pending = new PendingReport();
        pending.excluded("invalid-setting", "characters");
        pending.flush(report);
    }

    // Convert every candidate first: the id a character keeps depends on which ones survive.
    const kept: Kept[] = [];
    entries.forEach((entry, index) => {
        if (entry === null || entry === undefined) {
            return;
        }
        const pending = new PendingReport();
        if (!isPlainObject(entry)) {
            pending.excluded("invalid-character", `characters[${index}]`);
            pending.flush(report);
            return;
        }
        const label = nameOf(entry, `characters[${index}]`);
        if (typeof entry.chaId === "string" && TEMPORARY_IDS.has(entry.chaId)) {
            pending.excluded("temporary-character", label);
            pending.flush(report);
            return;
        }
        const candidate = convertCandidate(entry, label, context);
        if (candidate === null) {
            pending.excluded("invalid-character", label);
            pending.flush(report);
            return;
        }
        kept.push({ ...candidate, sourceId: entry.chaId });
    });

    // Ids: the first kept holder of a valid id keeps it.
    const ids = new Set<string>();
    const renamed = new Map<string, string>();
    const invalidHolders = new Map<string, number>();
    for (const { sourceId } of kept) {
        if (typeof sourceId === "string" && !isValidResourceId(sourceId)) {
            invalidHolders.set(sourceId, (invalidHolders.get(sourceId) ?? 0) + 1);
        }
    }
    const finalIds = kept.map(({ sourceId, record, notes }) => {
        if (isValidResourceId(sourceId) && !ids.has(sourceId)) {
            ids.add(sourceId);
            return sourceId;
        }
        let id = randomUUID();
        while (ids.has(id)) {
            id = randomUUID();
        }
        ids.add(id);
        if (sourceId !== undefined && sourceId !== null) {
            notes.converted("character-id-replaced", nameOf(record, id));
        }
        if (typeof sourceId === "string" && !isValidResourceId(sourceId) && invalidHolders.get(sourceId) === 1) {
            renamed.set(sourceId, id);
        }
        return id;
    });
    const resolve = (id: string) => renamed.get(id) ?? id;

    const characters: ConvertedCharacters["characters"] = [];
    const chats: ChatGroup[] = [];
    kept.forEach((candidate, position) => {
        const id = finalIds[position];
        const record = ownCopy(candidate.record);
        record.chaId = id;
        if (record.type === "group") {
            removeMissingMembers(record, ids, resolve, candidate.notes);
        }
        const checked = tryNormalize(kindOf(RESOURCE_KIND.characters), record, id);
        if (!checked.ok) {
            // Only the members changed since the candidate's check, so this does not happen.
            throw new ResourceValidationError(`An upstream character failed its final check: ${id}`);
        }
        candidate.notes.flush(report);
        characters.push({ id, data: checked.data as Record<string, unknown> });
        for (const { chat, messages } of candidate.chats) {
            for (const message of messages) {
                if (typeof message.saying === "string") {
                    message.saying = resolve(message.saying);
                }
            }
            chats.push({
                characterId: id,
                chatId: chat.id as string,
                baseRevision: null,
                ops: [{ op: "create", chat: { ...chat, message: messages } as unknown as Chat }],
            });
        }
        if (record.type === "group") {
            report.counts.groups += 1;
        } else {
            report.counts.characters += 1;
        }
    });
    report.counts.chats += chats.length;
    for (const group of chats) {
        const op = group.ops[0];
        report.counts.messages += op.op === "create" ? op.chat.message.length : 0;
    }
    return { characters, chats, ids, renamed };
}

function nameOf(source: Record<string, unknown>, fallback: string): string {
    return typeof source.name === "string" && source.name.trim() !== "" ? source.name : fallback;
}

/**
 * The converted candidate for one upstream entry: a cold stub's payload character when it converts,
 * else the entry itself (for a stub without a usable payload, the stub with a fresh chat).
 */
function convertCandidate(entry: Record<string, unknown>, label: string, context: CharacterContext): Candidate | null {
    const coldKey = entry.coldstorage;
    if (typeof coldKey !== "string" || coldKey === "") {
        return convertCharacter(entry, label, context);
    }
    const result = context.cold?.get(coldKey);
    if (result?.ok && isPlainObject(result.value) && isPlainObject(result.value.character)) {
        const restored = result.value.character;
        if (restored.chaId === entry.chaId) {
            const candidate = convertCharacter(restored, nameOf(restored, label), context);
            if (candidate !== null) {
                candidate.notes.converted("cold-character-restored", nameOf(restored, label));
                return candidate;
            }
        }
    }
    // The stub stays (its name, image, and id); its placeholder chat (one empty reply) does not.
    const stub = ownCopy(entry);
    stub.chats = [];
    const candidate = convertCharacter(stub, label, context);
    candidate?.notes.excluded("cold-missing", label);
    return candidate;
}

function convertCharacter(source: Record<string, unknown>, label: string, context: CharacterContext): Candidate | null {
    const notes = new PendingReport();
    const character = ownCopy(source);
    const rawChats = character.chats;
    const chatPage = character.chatPage;
    for (const field of STRIPPED_FIELDS) {
        delete character[field];
    }
    if (!context.formatVersion) {
        repairImagePaths(character);
    }
    if (
        character.type !== undefined &&
        character.type !== null &&
        character.type !== "character" &&
        character.type !== "group"
    ) {
        // The client refuses any other type (`checkCharacterInput`); upstream treats it as a character.
        notes.excluded("invalid-data", label);
        character.type = "character";
    }
    if (character.type === "group" && character.characters !== undefined && character.characters !== null) {
        if (!Array.isArray(character.characters)) {
            notes.excluded("invalid-data", label);
            character.characters = [];
        }
    }
    let normalized: Record<string, unknown>;
    try {
        normalized = normalizeCharacter(character);
    } catch (error) {
        if (error instanceof CharacterShapeError) {
            return null;
        }
        throw error;
    }
    if (normalized.ttsMode === "none") {
        normalized.ttsMode = "";
    }
    if (normalized.creation_date === undefined || normalized.creation_date === null) {
        normalized.creation_date = context.now;
    }
    normalized.globalLore = convertLorebook(normalized.globalLore, label, notes);

    // Chats: a non-list is no chats; each one converted on its own, keeping its upstream position.
    const chats: PreparedChat[] = [];
    let list: readonly unknown[] = [];
    if (Array.isArray(rawChats)) {
        list = rawChats;
    } else if (rawChats !== undefined && rawChats !== null) {
        notes.excluded("invalid-data", label);
    }
    const chatIds = new Set<string>();
    list.forEach((raw, index) => {
        const chatNotes = new PendingReport();
        const chat = convertChat(raw, normalized, label, chatIds, context, chatNotes);
        if (chat === null) {
            notes.excluded("invalid-chat", label);
            return;
        }
        chatIds.add(chat.chat.id as string);
        notes.take(chatNotes);
        chats.push({ index, ...chat });
    });
    if (chats.length === 0) {
        const chat = convertChat(
            { message: [], note: "", name: "Chat 1", localLore: [] },
            normalized,
            label,
            chatIds,
            context,
            new PendingReport(),
        );
        if (chat === null) {
            throw new ResourceValidationError("The first chat of an upstream character failed its check");
        }
        chats.push({ index: -1, ...chat });
    }
    const instructions = normalized.postHistoryInstructions;
    if (typeof instructions === "string" && instructions !== "") {
        const target = chats.find((chat) => chat.index === chatPage) ?? chats[0];
        const note = typeof target.chat.note === "string" ? target.chat.note : "";
        target.chat.note = (note + "\n" + instructions).trim();
        normalized.postHistoryInstructions = "";
        notes.converted("post-history-instructions-to-note", label);
    }

    normalized.chaId = CHECK_ID;
    const checked = tryNormalize(kindOf(RESOURCE_KIND.characters), normalized, CHECK_ID);
    if (!checked.ok) {
        return null;
    }
    if (checked.copied) {
        notes.excluded("invalid-data", label);
    }
    return { record: checked.data as Record<string, unknown>, chats, notes };
}

/** U `bootstrap.ts` `checkNewFormat`: the image paths of a database saved before `formatversion` 2. */
function repairImagePaths(character: Record<string, unknown>): void {
    if (typeof character.image === "string" && character.image !== "") {
        character.image = checkClean(character.image);
    }
    if (Array.isArray(character.emotionImages)) {
        character.emotionImages = character.emotionImages.map((entry) =>
            Array.isArray(entry) && entry.length >= 2 && typeof entry[1] === "string"
                ? [entry[0], checkClean(entry[1]), ...entry.slice(2)]
                : entry,
        );
    }
}

/** U `bootstrap.ts` `checkNewFormat`'s `checkClean`. */
export function checkClean(data: string): string {
    if (data.startsWith("assets") || data.length < 3) {
        return data;
    }
    return "assets/" + data.replace(/\\/g, "/").split("assets/")[1];
}

/** A lorebook list for a kept record: non-object entries left out, old entries converted (`upgradeLorebook`). */
export function convertLorebook(value: unknown, label: string, notes: PendingReport): unknown[] {
    if (!Array.isArray(value)) {
        notes.excluded("invalid-data", label);
        return [];
    }
    const entries = value.filter(isPlainObject).map((entry) => {
        const percent = entry.activationPercent;
        if ((typeof percent !== "object" || percent === null) && typeof percent !== "symbol") {
            return entry;
        }
        const copy = ownCopy(entry);
        delete copy.activationPercent;
        notes.excluded("invalid-data", label);
        return copy;
    });
    if (entries.length !== value.length) {
        notes.excluded("invalid-data", label);
    }
    try {
        return upgradeLorebook(entries);
    } catch (error) {
        if (error instanceof ModuleShapeError) {
            notes.excluded("invalid-data", label);
            return [];
        }
        throw error;
    }
}

/**
 * One chat of `character`, ready to create: its metadata as `normalizeChatMeta` stores it and its
 * messages as `normalizeMessage` does, checked with `prepareChatGroups`; or null when it cannot be.
 */
function convertChat(
    raw: unknown,
    character: Record<string, unknown>,
    label: string,
    chatIds: ReadonlySet<string>,
    context: CharacterContext,
    notes: PendingReport,
): { chat: Record<string, unknown>; messages: Record<string, unknown>[] } | null {
    if (!isPlainObject(raw)) {
        return null;
    }
    const chat = ownCopy(raw);
    foldColdChat(chat, label, context, notes);
    delete chat.useLocallySetGlobalVariables;
    delete chat.bindingReview;

    // Ids and bindings.
    chat.id = isValidResourceId(chat.id) && !chatIds.has(chat.id) ? chat.id : uniqueId(chatIds);
    chat.promptPresetId = context.selection.promptPresetId;
    chat.modelPresetId = context.selection.modelPresetId;
    chat.bindedPersona =
        typeof chat.bindedPersona === "string" && context.personaIds.has(chat.bindedPersona)
            ? chat.bindedPersona
            : context.selection.personaId;

    // `prepareChatInput`'s defaults, then the fields `normalizeChatMeta` refuses, reset.
    if (chat.fmIndex === undefined || chat.fmIndex === null) {
        chat.fmIndex = typeof character.firstMsgIndex === "number" ? character.firstMsgIndex : -1;
    }
    chat.localLore ??= [];
    const reset = (field: string, value?: unknown) => {
        if (value === undefined) {
            delete chat[field];
        } else {
            chat[field] = value;
        }
        notes.excluded("invalid-data", label);
    };
    for (const field of ["name", "note"]) {
        if (chat[field] !== undefined && chat[field] !== null && typeof chat[field] !== "string") {
            reset(field);
        }
    }
    if (!Array.isArray(chat.localLore)) {
        reset("localLore", []);
    }
    if (typeof chat.fmIndex !== "number") {
        reset("fmIndex", -1);
    }
    if (chat.toolCalls !== undefined) {
        const stored = storedValue(chat.toolCalls);
        if (!stored.ok) {
            reset("toolCalls");
        } else {
            chat.toolCalls = stored.value;
            if (stored.copied) {
                notes.excluded("invalid-data", label);
            }
            try {
                assertToolCalls(chat.toolCalls);
            } catch (error) {
                if (!(error instanceof ResourceValidationError)) {
                    throw error;
                }
                reset("toolCalls");
            }
        }
    }
    if (isPlainObject(chat.GLGlobalVariables)) {
        chat.GLGlobalVariables = withoutEmptyToggles(chat.GLGlobalVariables);
    }

    const messages = convertMessages(chat.message, label, notes);
    delete chat.message;
    const stored = storedValue(chat);
    if (!stored.ok || !isPlainObject(stored.value)) {
        return null;
    }
    if (stored.copied) {
        notes.excluded("invalid-data", label);
    }
    let meta: Record<string, unknown>;
    try {
        meta = normalizeChatMeta(stored.value, chat.id as string);
        // The batch's own check of the whole create (sizes and nesting included).
        prepareChatGroups([
            {
                characterId: CHECK_ID,
                chatId: chat.id,
                baseRevision: null,
                ops: [{ op: "create", chat: { ...meta, message: messages } }],
            },
        ]);
    } catch (error) {
        if (error instanceof ResourceValidationError) {
            return null;
        }
        throw error;
    }
    if (messages.some((message) => typeof message.data === "string" && INLAY_REFERENCE.test(message.data))) {
        notes.excluded("inlays-not-in-backup", label);
    }
    return { chat: meta, messages };
}

function uniqueId(used: ReadonlySet<string>): string {
    let id = randomUUID();
    while (used.has(id)) {
        id = randomUUID();
    }
    return id;
}

/** A cold chat's messages and memory from its payload (U `coldstorage.svelte.ts` `preLoadChat`), in place on the copy. */
function foldColdChat(chat: Record<string, unknown>, label: string, context: CharacterContext, notes: PendingReport) {
    const first = Array.isArray(chat.message) ? chat.message[0] : undefined;
    if (!isPlainObject(first) || typeof first.data !== "string" || !first.data.startsWith(COLD_CHAT_HEADER)) {
        return;
    }
    const result = context.cold?.get(first.data.slice(COLD_CHAT_HEADER.length));
    const value = result?.ok ? result.value : undefined;
    if (Array.isArray(value)) {
        chat.message = value;
    } else if (isPlainObject(value) && Array.isArray(value.message)) {
        for (const field of COLD_CHAT_FIELDS) {
            if (value[field] === undefined) {
                delete chat[field];
            } else {
                chat[field] = value[field];
            }
        }
    } else {
        // The chat stays, with its metadata and no messages.
        chat.message = [];
        notes.excluded("cold-missing", label);
        return;
    }
    notes.converted("cold-chat-restored", label);
}

/** A copy of a chat's toggle map without its `""` `toggle_*` values (see the module comment). */
function withoutEmptyToggles(map: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(map)) {
        if (!(key.startsWith(TOGGLE_PREFIX) && map[key] === "")) {
            setOwn(copy, key, map[key]);
        }
    }
    return copy;
}

/** A chat's messages, each in its stored form with a valid `chatId` unique in the chat; the others left out. */
function convertMessages(value: unknown, label: string, notes: PendingReport): Record<string, unknown>[] {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        notes.excluded("invalid-data", label);
        return [];
    }
    const seen = new Set<string>();
    const messages: Record<string, unknown>[] = [];
    for (const entry of value) {
        if (!isPlainObject(entry) || (entry.role !== "user" && entry.role !== "char")) {
            notes.excluded("invalid-data", label);
            continue;
        }
        const message = ownCopy(entry);
        if (message.data === undefined || message.data === null) {
            message.data = "";
        } else if (typeof message.data !== "string") {
            notes.excluded("invalid-data", label);
            continue;
        }
        // The store serializes the message list, whose wrapper counts toward its depth limit.
        const stored = storedValue([message]);
        if (!stored.ok || !Array.isArray(stored.value) || !isPlainObject(stored.value[0])) {
            notes.excluded("invalid-data", label);
            continue;
        }
        if (stored.copied) {
            notes.excluded("invalid-data", label);
        }
        const copy = stored.value[0];
        if (!isValidResourceId(copy.chatId) || seen.has(copy.chatId)) {
            copy.chatId = uniqueId(seen);
        }
        seen.add(copy.chatId as string);
        const normalized = normalizeMessage(copy);
        if (Object.hasOwn(copy, "translation") && !Object.hasOwn(normalized, "translation")) {
            notes.excluded("invalid-data", label);
        }
        messages.push(normalized);
    }
    return messages;
}

/**
 * A group's members without the ids that name no kept character (an id rewritten by `resolve` first),
 * with `characterTalks` and `characterActive` cut the same way when they run parallel to the members.
 */
function removeMissingMembers(
    group: Record<string, unknown>,
    ids: ReadonlySet<string>,
    resolve: (id: string) => string,
    notes: PendingReport,
): void {
    if (!Array.isArray(group.characters)) {
        return;
    }
    const members = group.characters;
    const keep: boolean[] = [];
    const next: string[] = [];
    for (const member of members) {
        const id = typeof member === "string" ? resolve(member) : null;
        const kept = id !== null && ids.has(id);
        keep.push(kept);
        if (kept) {
            next.push(id);
        } else {
            notes.excluded("group-member-missing", nameOf(group, String(group.chaId)));
        }
    }
    if (next.length === members.length && next.every((id, index) => id === members[index])) {
        return;
    }
    group.characters = next;
    for (const field of ["characterTalks", "characterActive"]) {
        const list = group[field];
        if (Array.isArray(list) && list.length === members.length) {
            group[field] = list.filter((_, index) => keep[index]);
        }
    }
}
