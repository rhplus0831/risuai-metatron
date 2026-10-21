import type { Chat } from "./database.ts";

/**
 * A chat's binding: the model preset, prompt preset, and persona a chat is sent with. A chat whose
 * binding is not complete cannot be sent; nothing falls back to the tab's selection.
 */

/** How a new chat starts (`Database.newChatBinding`, the `ui` section). */
export type NewChatBinding = "inherit" | "empty";

export const NEW_CHAT_BINDING_VALUES: readonly NewChatBinding[] = ["inherit", "empty"];

export const DEFAULT_NEW_CHAT_BINDING: NewChatBinding = "inherit";

export function isNewChatBinding(value: unknown): value is NewChatBinding {
    return (NEW_CHAT_BINDING_VALUES as readonly unknown[]).includes(value);
}

/** The binding fields of a chat, a chat summary, or a chat list entry. `bindedPersona` is the persona's (D3). */
export type ChatBindingFields = Pick<Chat, "modelPresetId" | "promptPresetId" | "bindedPersona" | "bindingReview">;

export type ChatBindingField = "modelPresetId" | "promptPresetId" | "personaId";

/**
 * A chat's bound ids as stored, each `null` when unset (absent, not a string, or blank), whether or not
 * the record still exists, and whether the binding awaits the user's confirmation (an imported chat).
 * For a display or a picker that shows each field on its own; a send uses `resolveChatBinding`.
 */
export type ChatBindingIds = {
    modelPresetId: string | null;
    promptPresetId: string | null;
    personaId: string | null;
    review: boolean;
};

export type ChatBindingProblem = { field: ChatBindingField; reason: "unset" | "gone" } | { field: "review" };

export type ChatBindingResult =
    | { ok: true; ids: { modelPresetId: string; promptPresetId: string; personaId: string } }
    | { ok: false; problems: ChatBindingProblem[] };

/** Which bound records exist, by id. */
export type ChatBindingLookup = {
    modelPreset(id: string): boolean;
    promptPreset(id: string): boolean;
    persona(id: string): boolean;
};

/** An id as stored: a blank or whitespace-only string is unset; any other string is kept unchanged. */
function boundId(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function readChatBindingIds(chat: ChatBindingFields): ChatBindingIds {
    return {
        modelPresetId: boundId(chat.modelPresetId),
        promptPresetId: boundId(chat.promptPresetId),
        personaId: boundId(chat.bindedPersona),
        review: chat.bindingReview === true,
    };
}

/**
 * Whether a chat can be sent: every field bound to a record that exists and no confirmation pending.
 * Every problem is reported, in field order (model preset, prompt preset, persona, then review). There
 * is no fallback: a caller that gets `ok: false` refuses.
 */
export function resolveChatBinding(chat: ChatBindingFields, exists: ChatBindingLookup): ChatBindingResult {
    const ids = readChatBindingIds(chat);
    const problems: ChatBindingProblem[] = [];
    const check = (field: ChatBindingField, id: string | null, found: (id: string) => boolean) => {
        if (id === null) {
            problems.push({ field, reason: "unset" });
        } else if (!found(id)) {
            problems.push({ field, reason: "gone" });
        }
    };
    check("modelPresetId", ids.modelPresetId, (id) => exists.modelPreset(id));
    check("promptPresetId", ids.promptPresetId, (id) => exists.promptPreset(id));
    check("personaId", ids.personaId, (id) => exists.persona(id));
    if (ids.review) {
        problems.push({ field: "review" });
    }
    if (problems.length > 0) {
        return { ok: false, problems };
    }
    return {
        ok: true,
        ids: { modelPresetId: ids.modelPresetId!, promptPresetId: ids.promptPresetId!, personaId: ids.personaId! },
    };
}
