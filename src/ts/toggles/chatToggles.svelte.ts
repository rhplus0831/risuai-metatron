import { untrack } from "svelte";
import type { Chat } from "../../../shared/database.ts";
import { globalToggleDefinitions } from "../parser/chatVar.svelte";
import { type ChatRef, findChat, mergeChatMeta, selectedChatId } from "../storage/chatStore.svelte";
import { settings, type PresetScope } from "../storage/settingsViews.svelte";

/** The same ref/scope definitions used by the global-variable readers. */
export function chatToggleDefinitions(ref: ChatRef | null, scope?: PresetScope): string {
    return globalToggleDefinitions(ref, scope);
}

/** Writes one stored `toggle_<key>` entry without replacing another writer's entries. */
export function setChatToggle(ref: ChatRef, key: string, value: string): boolean {
    const chat = findChat(ref);
    // Compare the stored value: a first explicit value must be saved even if it equals the default.
    if (!chat || chat.GLGlobalVariables?.[key] === value) {
        return false;
    }
    mergeChatMeta(ref, "GLGlobalVariables", { [key]: value });
    return true;
}

/** New-chat toggles: inherit the selected loaded chat's map and preset link unless starting empty. */
export function initialChatToggles(chaId: string): Pick<Chat, "GLGlobalVariables" | "togglePresetId"> {
    return untrack(() => {
        if (settings.ui.newChatBinding === "empty") {
            return {};
        }
        const chatId = selectedChatId(chaId);
        const chat = chatId === null ? undefined : findChat({ chaId, chatId });
        // Do not load or seed values here: an unavailable source starts with legacy/default reads.
        // `chatEntry` cannot provide the map or link because neither is a summary field.
        return {
            ...(chat?.GLGlobalVariables ? { GLGlobalVariables: { ...$state.snapshot(chat.GLGlobalVariables) } } : {}),
            ...(typeof chat?.togglePresetId === "string" ? { togglePresetId: chat.togglePresetId } : {}),
        };
    });
}

/** Keeps an imported chat's toggle preset link only when the preset exists here. Mutates `chat`. Untracked. */
export function importedChatTogglePreset(chat: Chat) {
    untrack(() => {
        const id = chat.togglePresetId;
        if (typeof id !== "string" || !settings.togglePresets.some((preset) => preset.id === id)) {
            delete chat.togglePresetId;
        }
    });
}
