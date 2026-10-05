import { untrack } from "svelte";
import { v4 } from "uuid";
import type { character, groupChat } from "../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../shared/hypaV3Presets.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
// Before `../stores.svelte`: its module effects read `selectedCharacter()` while this module is still loading.
import { onCharacterSelected, selectCharacter, selection } from "./selection.svelte";
import { DBState } from "../stores.svelte";
import { CharacterShapeError, normalizeCharacter } from "../../../shared/characters.ts";
import { ModuleShapeError, upgradeLorebook } from "../../../shared/modules.ts";
import type { Chat } from "../../../shared/database.ts";
import {
    forgetCharacterChats,
    installCharacterChats,
    isCharacterGenerating,
    normalizeNewCharacter,
    prepareChatInput,
} from "./chatStore.svelte";
import { checkCharOrder } from "./characterOrder";
import {
    CHARACTER_FIXED_FIELDS,
    detach,
    detachPatch,
    MutationValidationError,
    requireArray,
    requireJsonData,
    requireObject,
    writeEntries,
} from "./mutationValidation";
import {
    batchRecordWrites,
    insertCharacterRecord,
    removeCharacterRecords,
    replaceCharacterRecordAt,
} from "./records.svelte";
import { settings } from "./settingsViews.svelte";

export { selectCharacter };

/**
 * The character mutations (Phase 4): the external contracts (plugins, MCP, Lua, triggers, imports)
 * write characters only through these functions. Each validates its whole input and prepares a
 * detached copy before the mirror changes (a refusal throws `MutationValidationError` and changes
 * nothing) and writes the character record by `chaId`. Since Phase 6 slice 5 the characters are
 * write-through records (`records.svelte.ts`): every write of a character's own fields queues its
 * save, and the list's membership changes only here (add, replace at an index, remove). The chats
 * are the chat module's (`chatStore.svelte.ts`; Phase 6 slice 9a): a character new to the list hands
 * its chats to it (`installCharacterChats`), and the records hold no chats.
 */

type AnyCharacter = character | groupChat;

/**
 * The client's view of a character (Phase 6 slice 9a): a character record without its chats, which
 * the chat module holds (`chatList`, `selectedChat`, `findChat`). It keeps the render key
 * `reloadKeys`, which the UI reads and is never saved; it is not the persisted record type. The shared
 * `character`/`groupChat` shapes keep `chats`/`chatPage` for the server, cards, and plugin snapshots.
 */
export type ClientCharacter = Omit<character, "chats" | "chatPage">;
export type ClientGroup = Omit<groupChat, "chats" | "chatPage">;
export type AnyClientCharacter = ClientCharacter | ClientGroup;

/** Fields a character patch may not set (`CHARACTER_FIXED_FIELDS`, shared with the server's RisuAccess host). */
const FIXED_FIELDS = CHARACTER_FIXED_FIELDS;
/** Fields of an input that never become record fields (the chats go to the chat module; the render key is client-only). */
const INPUT_EXCLUDED = new Set(["chats", "chatPage", "reloadKeys"]);

function list(): AnyClientCharacter[] {
    return (DBState.db.characters ?? []) as AnyClientCharacter[];
}

function indexOf(chaId: string): number {
    return list().findIndex((entry) => entry?.chaId === chaId);
}

/**
 * Checks a character a contract hands in, without changing it: an object of JSON data whose
 * `type`, when present, is `"character"` or `"group"`, whose `chaId`, when present, is a string,
 * and whose `chats`, when present, is a list of chat objects with lists of message objects (what
 * the chat module needs to give them ids). For a caller's preflight of a whole list. The render key
 * (`reloadKeys`) is not checked: it is never saved or taken from the input, and a character a plugin
 * read back carries whatever the mirror had there.
 */
export function checkCharacterInput(char: unknown, key = "character"): asserts char is Record<string, unknown> {
    requireObject(key, char);
    // The copy that leaves out the render key would hide the input's own prototype: check it first.
    const proto = Object.getPrototypeOf(char);
    if (proto !== Object.prototype && proto !== null) {
        throw new MutationValidationError(key, "expected a plain object");
    }
    requireJsonData(key, { ...char, reloadKeys: undefined });
    if (char.type !== undefined && char.type !== "character" && char.type !== "group") {
        throw new MutationValidationError(key, 'type must be "character" or "group"');
    }
    if (char.chaId !== undefined && typeof char.chaId !== "string") {
        throw new MutationValidationError(key, "chaId must be a string");
    }
    if (char.type === "group" && char.characters !== undefined && char.characters !== null) {
        requireArray(`${key}.characters`, char.characters);
    }
    if (char.chats === undefined) {
        return;
    }
    requireArray(`${key}.chats`, char.chats);
    Array.from(char.chats, (chat, i) => {
        requireObject(`${key}.chats[${i}]`, chat);
        if (chat.message !== undefined) {
            requireArray(`${key}.chats[${i}].message`, chat.message);
            Array.from(chat.message, (message, j) => requireObject(`${key}.chats[${i}].message[${j}]`, message));
        }
    });
}

/** A character ready to be installed: checked, detached, normalized, its creation steps done; its chats apart. */
export interface PreparedCharacter {
    readonly copy: AnyClientCharacter;
    readonly chaId: string;
    readonly chats: Chat[];
}

const preparedCharacters = new WeakSet<PreparedCharacter>();

/** `normalizeCharacter` with its shape refusal as a `MutationValidationError`. */
function normalizedFields<T extends Record<string, unknown>>(fields: T, key: string): T {
    try {
        return normalizeCharacter(fields);
    } catch (error) {
        if (error instanceof CharacterShapeError) {
            throw new MutationValidationError(key, error.message);
        }
        throw error;
    }
}

/**
 * Prepares a character that enters the list (Phase 6 slice 5b; every creator and importer goes
 * through `addCharacter` or `replaceCharacterAt`), on a detached copy and before anything is
 * installed, so a refusal changes nothing: the checks; a `chaId` when missing; the shared defaults
 * (`normalizeCharacter`); then the creation steps, each run once here: `ttsMode` `"none"` becomes
 * `""`, `creation_date` is set when absent, old lorebook entries are converted (`upgradeLorebook`:
 * never on later updates, which keep their content), a character without chats gets its first chat,
 * every chat gets its `fmIndex` (the greeting, `firstMsgIndex`) and `localLore` when absent, and
 * `postHistoryInstructions` moves into the note of the chat at `chatPage` (else the first).
 */
export function prepareNewCharacter(char: unknown, key = "character"): PreparedCharacter {
    checkCharacterInput(char, key);
    const detached = detach({ ...char, reloadKeys: undefined }) as Record<string, unknown>;
    if (typeof detached.chaId !== "string" || detached.chaId === "") {
        detached.chaId = v4();
    }
    const copy = normalizedFields(detached, key);
    if (copy.ttsMode === "none") {
        copy.ttsMode = "";
    }
    if (copy.creation_date === undefined || copy.creation_date === null) {
        copy.creation_date = Date.now();
    }
    if (!Array.isArray(copy.globalLore)) {
        throw new MutationValidationError(`${key}.globalLore`, "must be a list");
    }
    try {
        copy.globalLore = upgradeLorebook(copy.globalLore);
    } catch (error) {
        if (error instanceof ModuleShapeError) {
            throw new MutationValidationError(`${key}.globalLore`, error.message);
        }
        throw error;
    }
    const chats = (Array.isArray(copy.chats) ? copy.chats : []) as Chat[];
    if (chats.length === 0) {
        chats.push({ id: v4(), message: [], note: "", name: "Chat 1", localLore: [] });
    }
    copy.chats = chats;
    for (const chat of chats) {
        prepareChatInput(chat, copy);
    }
    const instructions = copy.postHistoryInstructions;
    if (typeof instructions === "string" && instructions !== "") {
        const page = typeof copy.chatPage === "number" ? copy.chatPage : 0;
        const chat = chats[page] ?? chats[0];
        chat.note = ((chat.note ?? "") + "\n" + instructions).trim();
        copy.postHistoryInstructions = "";
    }
    delete copy.chats;
    delete copy.chatPage;
    const prepared: PreparedCharacter = {
        copy: copy as unknown as AnyClientCharacter,
        chaId: copy.chaId as string,
        chats,
    };
    preparedCharacters.add(prepared);
    return prepared;
}

function requirePrepared(prepared: PreparedCharacter) {
    if (!preparedCharacters.has(prepared)) {
        throw new MutationValidationError("character", "not prepared by prepareNewCharacter");
    }
}

/**
 * The character list (each element a character record's wrapper, in creation order; `[]` before an
 * installation). Read it for display and lookups; change membership only through this module. Its
 * chats are the chat module's (`chatList`).
 */
export function characterList(): AnyClientCharacter[] {
    return list();
}

/** A detached copy of the character with `chaId`, without chats (add them from the chat module), or `undefined`. */
export function characterSnapshot(chaId: string): AnyClientCharacter | undefined {
    const record = untrack(() => list().find((entry) => entry?.chaId === chaId));
    return record === undefined ? undefined : ($state.snapshot(record) as AnyClientCharacter);
}

/** The record of a character, typed read-only: change it through `updateCharacter`. */
export function findCharacter(chaId: string): DeepReadonly<AnyClientCharacter> | undefined {
    return list().find((entry) => entry?.chaId === chaId);
}

/**
 * Adds a character to the list, prepared as a creation (`prepareNewCharacter`): its chats go to the
 * chat module, which gives them ids, and it goes into the character order. A `chaId` another
 * character has is refused. Returns the id.
 */
export function addCharacter(char: unknown): string {
    return addPreparedCharacter(prepareNewCharacter(char));
}

/** `addCharacter` for a character prepared before (a caller's preflight of a whole list). */
export function addPreparedCharacter(prepared: PreparedCharacter): string {
    requirePrepared(prepared);
    const { copy, chaId, chats } = prepared;
    if (indexOf(chaId) !== -1) {
        throw new MutationValidationError("character", `a character with chaId ${chaId} already exists`);
    }
    installCharacterChats(chaId, chats, copy);
    try {
        insertCharacterRecord(copy as unknown as Record<string, unknown>);
    } catch (error) {
        forgetCharacterChats(chaId);
        throw error;
    }
    normalizeNewCharacter(chaId);
    checkCharOrder();
    return chaId;
}

/**
 * Sets own fields of a character: the whole patch is checked and detached first, then assigned on
 * the record (`undefined` removes the field). `chats`, `chatPage`, `reloadKeys`, `chaId`,
 * and `type` are refused. Returns `false`, changing nothing, when no character has `chaId`.
 */
export function updateCharacter(chaId: string, patch: Record<string, unknown>): boolean {
    const prepared = detachPatch(patch, (field) => {
        if (FIXED_FIELDS.has(field)) {
            throw new MutationValidationError(field, "this character field cannot be patched");
        }
    });
    const index = indexOf(chaId);
    if (index === -1) {
        return false;
    }
    batchRecordWrites(() => {
        const next = writeEntries(list()[index] as unknown as Record<string, unknown>, prepared);
        if (next) {
            replaceCharacterRecordAt(index, next);
        }
    });
    return true;
}

/**
 * Replaces every own field of the existing character with `char.chaId` by `char`'s (last writer
 * wins), keeping its render key (its chats and chat selection are the chat module's). `char` must name its
 * character. Returns `false`, changing nothing, when no character has that id.
 */
export function replaceCharacterFields(char: unknown): boolean {
    checkCharacterInput(char);
    const chaId = char.chaId;
    if (typeof chaId !== "string" || chaId === "") {
        throw new MutationValidationError("character", "chaId must name the character to replace");
    }
    // A whole replacement gets the shared defaults at once, so what is saved is what the server holds.
    const fields = normalizedFields(
        detach(Object.fromEntries(Object.entries(char).filter(([field]) => !INPUT_EXCLUDED.has(field)))),
        "character",
    );
    const index = indexOf(chaId);
    if (index === -1) {
        return false;
    }
    writeCharacterFieldsAt(index, fields as unknown as AnyCharacter);
    return true;
}

/**
 * Puts a character with another `chaId` at `index` (an existing index, or the list's length to
 * append) in place of the one there: a plugin's `setCharacterToIndex` with a different character.
 * Refused when `char` has the id of the character there (that is `replaceCharacterFields` plus the
 * chat module's `reconcileCharacterChats`), when the character there is generating a reply, or when
 * another character already has the new `chaId`. Returns the new id.
 */
export function replaceCharacterAt(index: number, char: unknown): string {
    const characters = list();
    if (!Number.isInteger(index) || index < 0 || index > characters.length) {
        throw new MutationValidationError("index", "no character at this index");
    }
    const { copy, chaId, chats } = prepareNewCharacter(char);
    const current = characters[index];
    if (current && current.chaId === chaId) {
        throw new MutationValidationError("character", "the character at this index has this chaId already");
    }
    if (current && isCharacterGenerating(current.chaId)) {
        throw new MutationValidationError("character", "the character at this index is generating a reply");
    }
    if (characters.some((other, i) => i !== index && other?.chaId === chaId)) {
        throw new MutationValidationError("character", `a character with chaId ${chaId} already exists`);
    }
    // Read before the replacement: the old wrapper is detached once its character leaves the list.
    const replacedId = current?.chaId;
    installCharacterChats(chaId, chats, copy);
    try {
        replaceCharacterRecordAt(index, copy as unknown as Record<string, unknown>);
    } catch (error) {
        forgetCharacterChats(chaId);
        throw error;
    }
    if (replacedId !== undefined) {
        // The character that left the list: its chats are no longer held (the save loop deletes it
        // with them on the server).
        forgetCharacterChats(replacedId);
    }
    normalizeNewCharacter(chaId);
    return chaId;
}

/**
 * Deletes a character for good (with its chats) and drops it from the character order. Refused
 * while it is generating a reply. The selection keeps its character (it is held by id); removing
 * the selected character selects home. Trash and restore are `updateCharacter(chaId, { trashTime })`.
 * Returns `false` when no character has `chaId`.
 */
export function removeCharacter(chaId: string): boolean {
    const index = indexOf(chaId);
    if (index === -1) {
        return false;
    }
    if (isCharacterGenerating(chaId)) {
        throw new MutationValidationError("character", "the character is generating a reply");
    }
    removeCharacterRecords([chaId]);
    // Its chats are no longer held (the save loop deletes the character with them on the server).
    forgetCharacterChats(chaId);
    checkCharOrder();
    return true;
}

/**
 * Deletes several characters for good in one change of the list (the boot's trash pruning): the
 * ones generating a reply are kept. The order is repaired once. Returns the ids it removed.
 */
export function removeCharacters(ids: readonly string[]): string[] {
    const removable = ids.filter((chaId) => indexOf(chaId) !== -1 && !isCharacterGenerating(chaId));
    if (removable.length === 0) {
        return [];
    }
    const removed = removeCharacterRecords(removable);
    for (const chaId of removed) {
        forgetCharacterChats(chaId);
    }
    checkCharOrder();
    return removed;
}

/** The selected character's record (its wrapper), or `undefined` at home. */
export function selectedCharacter(): AnyClientCharacter | undefined {
    const chaId = selection.characterId;
    return chaId === null ? undefined : list().find((entry) => entry?.chaId === chaId);
}

// The HypaV3 preset that turns memory on for every chat does so when a character is selected.
onCharacterSelected((chaId) => {
    untrack(() => {
        if (
            settings.memoryTranslateMedia.hypaV3 &&
            selectedHypaV3Preset({
                hypaV3Presets: settings.hypaV3Presets.items,
                hypaV3PresetId: settings.hypaV3Presets.selectedId,
            })?.settings?.alwaysToggleOn &&
            findCharacter(chaId)?.supaMemory !== true
        ) {
            updateCharacter(chaId, { supaMemory: true });
        }
    });
});

/**
 * Legacy only: the shared body of `setCurrentCharacter` and `setCharacterByIndex`
 * (`database.svelte.ts`, the core-app wrappers until `aggregate-removal`), and of
 * `replaceCharacterFields` after its checks. Replaces the own fields of the record at `index` with
 * `char`'s, keeping the render key (one queued save; any `chats`/`chatPage` in `char` are not record
 * fields and are dropped). Not validated or detached. External contracts never call it.
 */
export function writeCharacterFieldsAt(index: number, char: AnyCharacter | AnyClientCharacter) {
    const current = list()[index];
    if (current === char) {
        return;
    }
    if (!current) {
        replaceCharacterRecordAt(index, char as unknown as Record<string, unknown>);
        return;
    }
    replaceCharacterRecordAt(index, {
        ...char,
        reloadKeys: current.reloadKeys,
    } as unknown as Record<string, unknown>);
}
