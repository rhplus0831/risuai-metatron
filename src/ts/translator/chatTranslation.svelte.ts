import { untrack } from "svelte";
import type { Chat } from "../../../shared/database.ts";
import type { TranslatorPreset } from "../../../shared/settings.ts";
import {
    type ChatTranslationFields,
    type ChatTranslationSettings,
    chatTranslationSummary,
    readChatTranslationSettings,
    resolveTranslatorPreset,
    type ResolvedTranslatorPreset,
    selectedTranslatorPreset,
} from "../../../shared/translation/chatSettings.ts";
import { type ChatRef, chatEntry, currentChatRef, selectedChatId, setChatMeta } from "../storage/chatStore.svelte";
import { settings } from "../storage/settingsViews.svelte";

/*
 * A chat's translation settings on the tab (`docs/plan/translation.md` slices 2.1 and 2.2), read from
 * the chat's list entry, so they resolve for a chat that is not loaded (or still loading) too.
 */

/** The chat's translation settings (defaults when it is not a member). Tracked. */
export function chatTranslationSettings(ref: ChatRef | null | undefined): ChatTranslationSettings {
    return readChatTranslationSettings(ref ? chatEntry(ref) : undefined);
}

/**
 * Whether the chat's translations show without a click: its `autoTranslate`, while a target language
 * is set (with none, every translation control is hidden). Tracked.
 */
export function chatAutoTranslate(ref: ChatRef | null | undefined): boolean {
    return settings.memoryTranslateMedia.translator !== "" && chatTranslationSettings(ref).autoTranslate;
}

/** The translator preset the chat translates with (`resolveTranslatorPreset`). Tracked. */
export function chatTranslatorPreset(ref: ChatRef | null | undefined): ResolvedTranslatorPreset {
    return resolveTranslatorPreset(
        ref ? chatEntry(ref) : undefined,
        settings.translatorPresets.items,
        settings.translatorPresets.selectedId,
    );
}

/** The global translator preset (a translation that is not a chat's, such as the playground's). Tracked. */
export function globalTranslatorPreset(): TranslatorPreset {
    return selectedTranslatorPreset(settings.translatorPresets.items, settings.translatorPresets.selectedId);
}

/** The selected chat's translator preset, else the global one (the tab's translations). Tracked. */
export function currentTranslatorPreset(): TranslatorPreset {
    return chatTranslatorPreset(currentChatRef()).preset;
}

/**
 * A change of a chat's translation settings. An omitted member is left as it is; `null` unsets the
 * field (back to its default; for `translatorPresetId`, the global selection).
 */
export type ChatTranslationPatch = { [K in keyof ChatTranslationFields]?: ChatTranslationFields[K] | null };

/** Changes a chat's translation settings through `setChatMeta` (list fields: a chat not loaded takes it too). */
export function setChatTranslationSettings(ref: ChatRef, patch: ChatTranslationPatch) {
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            unset.push(key);
        } else if (value !== undefined) {
            set[key] = value;
        }
    }
    setChatMeta(ref, set, unset);
}

/**
 * How a fresh chat of `chaId` starts its translation settings (decision 3), read before the chat is
 * created: with `newChatBinding` `inherit` (anything but `empty`) the settings of the character's
 * selected chat as stored (a preset that was deleted is kept: it falls back as it did there); with
 * `empty`, or a character without chats, none (translation off). Never a global value. Untracked.
 */
export function initialChatTranslation(chaId: string): ChatTranslationFields {
    return untrack(() => {
        if (settings.ui.newChatBinding === "empty") {
            return {};
        }
        const chatId = selectedChatId(chaId);
        const entry = chatId === null ? undefined : chatEntry({ chaId, chatId });
        return entry ? chatTranslationSummary(entry) : {};
    });
}

/**
 * Prepares an imported chat's translation settings before it is created (slice 2.1): a
 * `translatorPresetId` that names no preset here is dropped (the chat uses the global selection); the
 * other fields are kept as imported (a malformed one reads as unset). Mutates `chat`. Untracked.
 */
export function importedChatTranslation(chat: Chat) {
    untrack(() => {
        const id = readChatTranslationSettings(chat).translatorPresetId;
        if (id === null || resolveTranslatorPreset(chat, settings.translatorPresets.items, null).source !== "chat") {
            delete chat.translatorPresetId;
        }
    });
}
