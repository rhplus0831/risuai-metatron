import { randomUUID } from "node:crypto";
import { CHAT_META_FORBIDDEN_KEYS } from "../../../shared/chats.ts";
import { isValidResourceId, ResourceValidationError } from "./resourceStore.ts";

/**
 * Pure normalizers for chats (Phase 2). Minimum shapes only, as for the Phase 1 kinds: the client
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
 * streaming flags, with `id` set and `name`, `note`, `localLore` defaulted. A present `id` must equal
 * the chat id.
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
    if (meta.fmIndex !== undefined && typeof meta.fmIndex !== "number") {
        throw new ResourceValidationError("chat.fmIndex must be a number");
    }
    return meta;
}

/** Checks a `meta` op's field names: no identity, messages, or streaming flags. */
export function assertPatchableMetaKeys(keys: readonly string[]) {
    for (const key of keys) {
        if (forbiddenMetaKeys.has(key)) {
            throw new ResourceValidationError(`chat meta cannot change ${key}`);
        }
    }
}

/** One message as stored: a `user` or `char` role, string `data`, and a valid `chatId`. */
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
