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

/** New-chat toggle values: inherit the selected chat's stored map unless explicitly starting empty. */
export function initialChatToggles(chaId: string): Pick<Chat, "GLGlobalVariables"> {
    return untrack(() => {
        if (settings.ui.newChatBinding === "empty") {
            return {};
        }
        const chatId = selectedChatId(chaId);
        const chat = chatId === null ? undefined : findChat({ chaId, chatId });
        // Do not load or seed values here: an unavailable source starts with legacy/default reads.
        // `chatEntry` cannot provide this map because it is not a summary field.
        return chat?.GLGlobalVariables ? { GLGlobalVariables: { ...$state.snapshot(chat.GLGlobalVariables) } } : {};
    });
}
