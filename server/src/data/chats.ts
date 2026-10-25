import { randomUUID } from "node:crypto";
import { CHAT_META_FORBIDDEN_KEYS, MAX_TOOL_CALL_RECORD_BYTES } from "../../../shared/chats.ts";
import { isToolContentEntry } from "../../../shared/llm/validate.ts";
import { dropInvalidTranslation, isMessageTranslation } from "../../../shared/translation/messageTranslation.ts";
import { isValidResourceId, ResourceValidationError } from "./resourceStore.ts";

/**
 * Pure normalizers for chats. Minimum shapes only, as for the plain record kinds: the client
 * keeps building chats and messages; the server checks what it needs to store and address them and
 * fills the three defaults every reader relies on (`name`, `note`, `localLore`).
 */

/** Version of the stored chat metadata, kept in `chats.schemaVersion`. */
export const CHAT_SCHEMA_VERSION = 1;

const messageRoles = new Set(["user", "char"]);
const forbiddenMetaKeys = new Set(CHAT_META_FORBIDDEN_KEYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stored metadata of chat `id`: every field of the input except `message` and the client-only
 * streaming flags, with `id` set and `name`, `note`, `localLore`, `fmIndex` (-1) defaulted. A present `id`
 * must equal the chat id.
 */
export function normalizeChatMeta(input: unknown, id: string): Record<string, unknown> {
    if (!isPlainObject(input)) {
        throw new ResourceValidationError("chat must be an object");
    }
    if (Object.hasOwn(input, "id") && input.id !== id) {
        throw new ResourceValidationError("chat.id must equal the chat id");
    }
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (!forbiddenMetaKeys.has(key)) {
            meta[key] = value;
        }
    }
    meta.id = id;
    meta.name ??= "";
    meta.note ??= "";
    meta.localLore ??= [];
    if (typeof meta.name !== "string" || typeof meta.note !== "string") {
        throw new ResourceValidationError("chat.name and chat.note must be strings");
    }
    if (!Array.isArray(meta.localLore)) {
        throw new ResourceValidationError("chat.localLore must be an array");
    }
    if (meta.loreOverrides !== undefined) {
        assertLoreOverrides(meta.loreOverrides);
        meta.loreOverrides = firstOverridePerId(meta.loreOverrides);
    }
    // The greeting the chat starts from (-1: the first message). The client gives a chat it creates its
    // character's `firstMsgIndex` (`prepareChatInput`); a chat written without one starts from the first
    // message, as a selection's formatter gave it before characters were normalized by the shared
    // `normalizeCharacter`.
    meta.fmIndex ??= -1;
    if (typeof meta.fmIndex !== "number") {
        throw new ResourceValidationError("chat.fmIndex must be a number");
    }
    if (meta.toolCalls !== undefined) {
        assertToolCalls(meta.toolCalls);
    }
    return meta;
}

/**
 * `chat.toolCalls`: a map of call id to `{ call: { id, name, arg }, response: [...] }`, each under
 * its own call id (the request adapters read these fields without checking them).
 */
export function assertToolCalls(value: unknown): void {
    if (!isPlainObject(value)) {
        throw new ResourceValidationError("chat.toolCalls must be an object");
    }
    for (const id of Object.keys(value)) {
        assertToolCallRecord(id, value[id]);
    }
}

/** `chat.loreOverrides`: full lore copies linked to their owner's entries by non-empty ids. */
export function assertLoreOverrides(value: unknown): asserts value is { entry: { id: string }; off: boolean }[] {
    if (!Array.isArray(value)) {
        throw new ResourceValidationError("chat.loreOverrides must be an array");
    }
    for (const override of value) {
        if (
            !isPlainObject(override) ||
            !isPlainObject(override.entry) ||
            typeof override.entry.id !== "string" ||
            override.entry.id.length === 0 ||
            typeof override.off !== "boolean"
        ) {
            throw new ResourceValidationError(
                "chat.loreOverrides must be an array of { entry: { id: non-empty string }, off: boolean }",
            );
        }
    }
}

/**
 * The first override per `entry.id`, in array order. The merge already applies only the first
 * (`shared/lore/overrides.ts`), so dropping the later ones changes no behavior.
 */
function firstOverridePerId<T extends { entry: { id: string } }>(overrides: T[]): T[] {
    const seen = new Set<string>();
    return overrides.filter((override) => {
        if (seen.has(override.entry.id)) {
            return false;
        }
        seen.add(override.entry.id);
        return true;
    });
}

/** One entry of `chat.toolCalls`, and its size (`MAX_TOOL_CALL_RECORD_BYTES`). */
export function assertToolCallRecord(id: string, record: unknown): void {
    const call = isPlainObject(record) ? record.call : undefined;
    if (
        !isPlainObject(record) ||
        !isPlainObject(call) ||
        call.id !== id ||
        id === "" ||
        typeof call.name !== "string" ||
        !Array.isArray(record.response) ||
        // Each piece as the request adapters read it (text; an image or audio with data and MIME type;
        // a resource). `call.arg` is whatever the provider sent: not checked.
        !record.response.every(isToolContentEntry)
    ) {
        throw new ResourceValidationError(
            "chat.toolCalls entries must be { call: { id, name, arg }, response: [tool content] }",
        );
    }
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_TOOL_CALL_RECORD_BYTES) {
        throw new ResourceValidationError(`a chat.toolCalls entry must be at most ${MAX_TOOL_CALL_RECORD_BYTES} bytes`);
    }
}

/** Checks a `meta` op's field names: no identity, messages, or streaming flags. */
export function assertPatchableMetaKeys(keys: readonly string[]) {
    for (const key of keys) {
        if (forbiddenMetaKeys.has(key)) {
            throw new ResourceValidationError(`chat meta cannot change ${key}`);
        }
    }
}

/**
 * One message as stored: a `user` or `char` role, string `data`, and a valid `chatId`. A `translation`
 * that is not a `MessageTranslation` is dropped (a copy without it is returned), never refused: an
 * imported chat keeps its messages (the tab's chat module drops it the same way, `prepareMessages`).
 */
export function normalizeMessage(input: unknown): Record<string, unknown> {
    if (!isPlainObject(input)) {
        throw new ResourceValidationError("message must be an object");
    }
    if (typeof input.role !== "string" || !messageRoles.has(input.role)) {
        throw new ResourceValidationError("message.role must be user or char");
    }
    if (typeof input.data !== "string") {
        throw new ResourceValidationError("message.data must be a string");
    }
    if (!isValidResourceId(input.chatId)) {
        throw new ResourceValidationError("message.chatId must be a valid id");
    }
    if (Object.hasOwn(input, "translation") && !isMessageTranslation(input.translation)) {
        const message = { ...input };
        dropInvalidTranslation(message);
        return message;
    }
    return input;
}

/**
 * The messages of a whole-chat payload (`create`, `replace`): a message without a valid `chatId`
 * gets a new one, and a later duplicate within the list is renamed (the first keeps its id). Returns
 * copies; the input is not changed.
 */
export function normalizeMessageList(input: unknown): Record<string, unknown>[] {
    if (input === undefined) {
        return [];
    }
    if (!Array.isArray(input)) {
        throw new ResourceValidationError("chat.message must be an array");
    }
    const seen = new Set<string>();
    return input.map((entry) => {
        if (!isPlainObject(entry)) {
            throw new ResourceValidationError("message must be an object");
        }
        const message = { ...entry };
        if (!isValidResourceId(message.chatId) || seen.has(message.chatId)) {
            message.chatId = randomUUID();
        }
        seen.add(message.chatId as string);
        return normalizeMessage(message);
    });
}
