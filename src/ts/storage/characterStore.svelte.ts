import { untrack } from "svelte";
import { v4 } from "uuid";
import type { character, groupChat } from "../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../shared/hypaV3Presets.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { DBState } from "../stores.svelte";
import { isCharacterGenerating, normalizeNewCharacter } from "./chatStore.svelte";
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
import { onCharacterSelected, selectCharacter, selection } from "./selection.svelte";

export { selectCharacter };

/**
 * The character mutations (Phase 4): the external contracts (plugins, MCP, Lua, triggers, imports)
 * write characters only through these functions. Each validates its whole input and prepares a
 * detached copy before the mirror changes (a refusal throws `MutationValidationError` and changes
 * nothing) and writes the character record by `chaId`. Since Phase 6 slice 5 the characters are
 * write-through records (`records.svelte.ts`): every write of a character's own fields queues its
 * save, and the list's membership changes only here (add, replace at an index, remove). An existing
 * character's chats are the chat module's (`chatStore.svelte.ts`): only a character new to the
 * mirror brings its chats with it.
 */

type AnyCharacter = character | groupChat;

/** Fields a character patch may not set (`CHARACTER_FIXED_FIELDS`, shared with the server's RisuAccess host). */
const FIXED_FIELDS = CHARACTER_FIXED_FIELDS;
/** Fields the mirror keeps when a character's own fields are replaced (chats are written only through the chat module). */
const LOCAL_FIELDS = new Set(["chats", "chatPage", "reloadKeys"]);

function list(): AnyCharacter[] {
    return DBState.db.characters ?? [];
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

/** A checked, detached copy of `char` with its `chaId` (assigned on the copy when missing or empty). */
function prepareCharacter(char: unknown): { copy: AnyCharacter; chaId: string } {
    checkCharacterInput(char);
    const copy = detach({ ...char, reloadKeys: undefined }) as unknown as AnyCharacter;
    if (typeof copy.chaId !== "string" || copy.chaId === "") {
        copy.chaId = v4();
    }
    return { copy, chaId: copy.chaId };
}

/** The mirror record of a character, typed read-only: change it through `updateCharacter`. */
export function findCharacter(chaId: string): DeepReadonly<AnyCharacter> | undefined {
    return list().find((entry) => entry?.chaId === chaId);
}

/**
 * Adds a character (with its chats) to the mirror, gives its chats ids, and puts it into the
 * character order. A `chaId` another character has is refused. Returns the id.
 */
export function addCharacter(char: unknown): string {
    const { copy, chaId } = prepareCharacter(char);
    if (indexOf(chaId) !== -1) {
        throw new MutationValidationError("character", `a character with chaId ${chaId} already exists`);
    }
    insertCharacterRecord(copy as unknown as Record<string, unknown>);
    normalizeNewCharacter(chaId);
    checkCharOrder();
    return chaId;
}

/**
 * Sets own fields of a character: the whole patch is checked and detached first, then assigned on
 * the mirror record (`undefined` removes the field). `chats`, `chatPage`, `reloadKeys`, `chaId`,
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
 * wins), keeping the mirror's chats, chat selection, and render key. `char` must name its
 * character. Returns `false`, changing nothing, when no character has that id.
 */
export function replaceCharacterFields(char: unknown): boolean {
    checkCharacterInput(char);
    const chaId = char.chaId;
    if (typeof chaId !== "string" || chaId === "") {
        throw new MutationValidationError("character", "chaId must name the character to replace");
    }
    const fields = detach(Object.fromEntries(Object.entries(char).filter(([field]) => !LOCAL_FIELDS.has(field))));
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
    const { copy, chaId } = prepareCharacter(char);
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
    replaceCharacterRecordAt(index, copy as unknown as Record<string, unknown>);
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
    checkCharOrder();
    return removed;
}

/** The selected character's record (its wrapper), or `undefined` at home. */
export function selectedCharacter(): AnyCharacter | undefined {
    const chaId = selection.characterId;
    return chaId === null ? undefined : list().find((entry) => entry?.chaId === chaId);
}

// The HypaV3 preset that turns memory on for every chat does so when a character is selected.
onCharacterSelected((chaId) => {
    untrack(() => {
        const db = DBState.db;
        if (
            db?.hypaV3 &&
            selectedHypaV3Preset(db)?.settings?.alwaysToggleOn &&
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
 * `char`'s, keeping the mirror's chats, selection, and render key (one queued save). Not validated
 * or detached. External contracts never call it.
 */
export function writeCharacterFieldsAt(index: number, char: AnyCharacter) {
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
        chats: current.chats,
        chatPage: current.chatPage,
        reloadKeys: current.reloadKeys,
    } as unknown as Record<string, unknown>);
}
