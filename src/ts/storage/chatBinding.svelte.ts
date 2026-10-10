import { language } from "src/lang";
import {
    readChatBindingIds,
    resolveChatBinding,
    type ChatBindingIds,
    type ChatBindingLookup,
    type ChatBindingProblem,
    type ChatBindingResult,
} from "../../../shared/chatBinding.ts";
import { chatEntry, setChatMeta, type ChatRef } from "./chatStore.svelte";
import { trackedRecord, type RecordKind } from "./records.svelte";
import { activeModelPreset, activePersona, activePreset } from "./settingsViews.svelte";

/*
 * A chat's binding on the client (`docs/plan/chat-binding.md`): read from the chat's list entry, so
 * it resolves synchronously also for a chat that is not loaded. `undefined` means the chat is not a
 * member (gone or not listed), never "use the tab's selection". `settingsViews.svelte.ts` must not
 * import this module (`chatStore.svelte.ts` imports the views): the views will reach it through a
 * registered getter. This module reads the views only for the display rule's fallback.
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
 * record that exists, else the tab's (`""` when it has none). Equal to the binding when that is
 * complete; never for a send, which refuses an incomplete binding (`chatBinding`). Tracked.
 */
export function chatDisplayIds(ref: ChatRef): ChatContextIds {
    const bound = chatBindingIds(ref);
    const pick = (id: string | null | undefined, exists: (id: string) => boolean, tab: string | undefined) =>
        id && exists(id) ? id : (tab ?? "");
    return {
        presetId: pick(bound?.promptPresetId, lookup.promptPreset, activePreset.id),
        modelPresetId: pick(bound?.modelPresetId, lookup.modelPreset, activeModelPreset.id),
        personaId: pick(bound?.personaId, lookup.persona, activePersona.id),
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
