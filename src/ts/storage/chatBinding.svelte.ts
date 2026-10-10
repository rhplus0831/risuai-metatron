import { untrack } from "svelte";
import { language } from "src/lang";
import type { Chat } from "../../../shared/database.ts";
import {
    readChatBindingIds,
    resolveChatBinding,
    type ChatBindingField,
    type ChatBindingIds,
    type ChatBindingLookup,
    type ChatBindingProblem,
    type ChatBindingResult,
} from "../../../shared/chatBinding.ts";
import { chatEntry, countChatEntries, selectedChatId, setChatMeta, type ChatRef } from "./chatStore.svelte";
import { trackedRecord, type RecordKind } from "./records.svelte";
import { settings, tabSelectionIds } from "./settingsViews.svelte";

/*
 * A chat's binding on the client (`docs/plan/chat-binding.md`): read from the chat's list entry, so
 * it resolves synchronously also for a chat that is not loaded. `undefined` means the chat is not a
 * member (gone or not listed), never "use the tab's selection". `settingsViews.svelte.ts` must not
 * import this module (`chatStore.svelte.ts` imports the views): the views get the selected chat's
 * binding from `chatStore.svelte.ts`'s registration. This module reads the tab's selection only for
 * the display rule's fallback.
 */

function hasRecord(kind: RecordKind, id: string): boolean {
    const list = trackedRecord<unknown[]>(kind);
    return Array.isArray(list) && list.some((record) => (record as { id?: unknown } | null | undefined)?.id === id);
}

/** Whether the bound records exist (tracked: a reader re-runs when a list changes). */
const lookup: ChatBindingLookup = {
    modelPreset: (id) => hasRecord("modelPresets", id),
    promptPreset: (id) => hasRecord("presets", id),
    persona: (id) => hasRecord("personas", id),
};

/** Whether the chat can be sent, and with which ids (strict; see `resolveChatBinding`). */
export function chatBinding(ref: ChatRef): ChatBindingResult | undefined {
    const entry = chatEntry(ref);
    return entry ? resolveChatBinding(entry, lookup) : undefined;
}

/** The ids a job, request, or transform context names (`presetId` is the prompt preset). */
export type ChatContextIds = { presetId: string; modelPresetId: string; personaId: string };

/** A complete binding's ids as a context names them. */
export function chatContextIds(ids: Extract<ChatBindingResult, { ok: true }>["ids"]): ChatContextIds {
    return { presetId: ids.promptPresetId, modelPresetId: ids.modelPresetId, personaId: ids.personaId };
}

/**
 * The ids a render of the chat uses (the display rule): per field, the bound id when it names a
 * record that exists, else the tab's selection (`""` when it has none), never another chat's
 * binding. For the selected chat these are the settings views' ids. Equal to the binding when that
 * is complete; never for a send, which refuses an incomplete binding (`chatBinding`). Tracked.
 */
export function chatDisplayIds(ref: ChatRef): ChatContextIds {
    const bound = chatBindingIds(ref);
    const tab = tabSelectionIds();
    const pick = (id: string | null | undefined, exists: (id: string) => boolean, fallback: string) =>
        id && exists(id) ? id : fallback;
    return {
        presetId: pick(bound?.promptPresetId, lookup.promptPreset, tab.presetId),
        modelPresetId: pick(bound?.modelPresetId, lookup.modelPreset, tab.modelPresetId),
        personaId: pick(bound?.personaId, lookup.persona, tab.personaId),
    };
}

/**
 * Why a chat cannot be sent, as the alert shows it: the refusal and one line per problem. A chat
 * that is not a member has no problems listed.
 */
export function chatBindingRefusalText(problems: readonly ChatBindingProblem[]): string {
    const strings = language.chatBinding;
    const lines = problems.map((problem) =>
        problem.field === "review"
            ? strings.review
            : `${strings.fields[problem.field]}: ${problem.reason === "unset" ? strings.unset : strings.gone}`,
    );
    return [strings.refused, ...lines].join("\n");
}

/** The problems of `result` (none when the chat is not a member or the binding is complete). */
export function chatBindingProblems(result: ChatBindingResult | undefined): readonly ChatBindingProblem[] {
    return result && "problems" in result ? result.problems : [];
}

/** The chat's bound ids as stored, field by field, for a display or a picker (not for a send). */
export function chatBindingIds(ref: ChatRef): ChatBindingIds | undefined {
    const entry = chatEntry(ref);
    return entry ? readChatBindingIds(entry) : undefined;
}

/** Whether a bound id names a record that exists (tracked). */
export function chatBindingTargetExists(field: "modelPresetId" | "promptPresetId" | "personaId", id: string): boolean {
    switch (field) {
        case "modelPresetId":
            return lookup.modelPreset(id);
        case "promptPresetId":
            return lookup.promptPreset(id);
        case "personaId":
            return lookup.persona(id);
    }
}

/**
 * A change of a chat's binding. An omitted (or `undefined`) member is left as it is; `null` unbinds the
 * field; `review: false` clears a pending confirmation.
 */
export type ChatBindingPatch = {
    modelPresetId?: string | null;
    promptPresetId?: string | null;
    personaId?: string | null;
    review?: boolean;
};

/**
 * Changes a chat's binding through `setChatMeta`, by chat id (the fields are list fields, so a chat
 * that is not loaded takes it too). A chat that is not a member throws, as `setChatMeta` does.
 */
export function chatBindingPatch(ref: ChatRef, patch: ChatBindingPatch) {
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    const apply = (key: string, value: string | null | undefined) => {
        if (value === null) {
            unset.push(key);
        } else if (value !== undefined) {
            set[key] = value;
        }
    };
    apply("modelPresetId", patch.modelPresetId);
    apply("promptPresetId", patch.promptPresetId);
    apply("bindedPersona", patch.personaId);
    if (patch.review === true) {
        set.bindingReview = true;
    } else if (patch.review === false) {
        unset.push("bindingReview");
    }
    setChatMeta(ref, set, unset);
}

/**
 * The id a picker marks as chosen: in chat mode (`ref` set) the chat's bound id when it names a record
 * that exists, else none (the view's tab fallback is not the chat's); at home `viewId`, the tab's
 * selection the view shows. Tracked.
 */
export function pickedId(field: ChatBindingField, ref: ChatRef | null, viewId: string | undefined): string | null {
    if (!ref) {
        return viewId ?? null;
    }
    const id = chatBindingIds(ref)?.[field] ?? null;
    return id !== null && chatBindingTargetExists(field, id) ? id : null;
}

/**
 * How many chats (of every character, loaded or not, review pending or not) bind `field` to `id`.
 * Untracked: for a deletion's confirmation.
 */
export function chatsBoundTo(field: ChatBindingField, id: string): number {
    return countChatEntries((entry) => readChatBindingIds(entry)[field] === id);
}

/** The stored binding fields a new chat starts with (each omitted when unset). */
export type InitialChatBinding = Pick<Chat, "modelPresetId" | "promptPresetId" | "bindedPersona">;

/**
 * How a fresh chat of `chaId` starts (`docs/plan/chat-binding.md`, decision 4), read before the chat
 * is created: with `newChatBinding` `inherit` (anything but `empty`, the normalizer's default) the
 * binding of the character's selected chat (else its first, as `selectedChatId` answers), keeping
 * only ids that name records that exist and never `bindingReview` (a source still awaiting its
 * confirmation stays blocked; its new chat does not). With `empty`, or a character without chats,
 * nothing. Never the tab's selection. Untracked.
 */
export function initialChatBinding(chaId: string): InitialChatBinding {
    return untrack(() => {
        if (settings.ui.newChatBinding === "empty") {
            return {};
        }
        const chatId = selectedChatId(chaId);
        const ids = chatId === null ? undefined : chatBindingIds({ chaId, chatId });
        if (!ids) {
            return {};
        }
        const binding: InitialChatBinding = {};
        if (ids.modelPresetId !== null && lookup.modelPreset(ids.modelPresetId)) {
            binding.modelPresetId = ids.modelPresetId;
        }
        if (ids.promptPresetId !== null && lookup.promptPreset(ids.promptPresetId)) {
            binding.promptPresetId = ids.promptPresetId;
        }
        if (ids.personaId !== null && lookup.persona(ids.personaId)) {
            binding.bindedPersona = ids.personaId;
        }
        return binding;
    });
}

/**
 * Prepares an imported chat's binding before it is created (decision 6): drops each bound id that
 * does not name a record here (or is not a non-blank string) and sets `bindingReview`, so the chat
 * waits for the user's confirmation before its first send. Mutates `chat`. Untracked.
 */
export function importedChatBinding(chat: Chat) {
    untrack(() => {
        const ids = readChatBindingIds(chat);
        const keep = (
            key: "modelPresetId" | "promptPresetId" | "bindedPersona",
            id: string | null,
            exists: (id: string) => boolean,
        ) => {
            if (id === null || !exists(id)) {
                delete chat[key];
            }
        };
        keep("modelPresetId", ids.modelPresetId, lookup.modelPreset);
        keep("promptPresetId", ids.promptPresetId, lookup.promptPreset);
        keep("bindedPersona", ids.personaId, lookup.persona);
        chat.bindingReview = true;
    });
}
