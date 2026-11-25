import { isToggleKey } from "../../../shared/chatCheckpoints.ts";
import type { ChatMeta } from "../../../shared/chats.ts";
import type { Chat } from "../../../shared/database.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";

/**
 * A settings-only copy of a chat: a new chat that starts without its source's conversation and keeps how the
 * source was set up. The table below decides every persisted chat field, so a new field cannot be left out.
 * This is not the checkpoint split (`CHECKPOINT_CHAT_FIELDS`), which treats the note and the chat's lore as
 * story state: here they are part of the setup the user carries over.
 */

/**
 * What a settings-only copy does with each persisted chat field. `copy` takes the source's value as stored,
 * `drop` leaves the field out (conversation state, memory data, and what the caller or the chat module
 * assigns), and `toggles` takes only the prompt toggle entries of a variable map.
 */
export const SETTINGS_COPY_CHAT_FIELDS: Record<keyof ChatMeta, "copy" | "drop" | "toggles"> = {
    note: "copy",
    localLore: "copy",
    loreOverrides: "copy",
    modules: "copy",
    GLGlobalVariables: "toggles",
    togglePresetId: "copy",
    oocToggles: "copy",
    bindedPersona: "copy",
    promptPresetId: "copy",
    modelPresetId: "copy",
    bindingReview: "copy",
    draftHookId: "copy",
    translatorPresetId: "copy",
    autoTranslate: "copy",
    translateBotOnly: "copy",
    bilingualDisplay: "copy",
    bilingualEmphasis: "copy",
    bilingualSentences: "copy",
    memoryEnabled: "copy",
    memoryMode: "copy",
    memoryPresetId: "copy",
    memoryProfileId: "copy",
    loreBudgetWarnOff: "copy",
    structuredMemoryLanguage: "copy",
    structuredMemoryHighlight: "copy",
    folderId: "copy",
    fmIndex: "copy",
    id: "drop",
    name: "drop",
    pinned: "drop",
    lastDate: "drop",
    scriptstate: "drop",
    supaMemoryData: "drop",
    hypaV2Data: "drop",
    hypaV3Data: "drop",
    lastMemory: "drop",
    memoryTrimAck: "drop",
    bookmarks: "drop",
    bookmarkNames: "drop",
    toolCalls: "drop",
    suggestMessages: "drop",
    sdData: "drop",
    oocLog: "drop",
    oocSegment: "drop",
};

/**
 * The input of a new chat that keeps `source`'s settings and none of its conversation: no messages, variables,
 * memory data, bookmarks, or OOC log. A variable map keeps only its prompt toggles (`isToggleKey`) and is left
 * out when it has none. The caller gives the name and the id, and the messages a group chat starts with.
 * Values are shared with `source`, so pass a detached chat or hand the result to `createChat`, which clones it.
 */
export function chatSettingsCopy(source: DeepReadonly<Chat>, name: string, id: string): Chat {
    const fields: Record<string, unknown> = {};
    for (const [key, behavior] of Object.entries(SETTINGS_COPY_CHAT_FIELDS)) {
        const value = (source as Record<string, unknown>)[key];
        if (value === undefined) {
            continue;
        }
        if (behavior === "copy") {
            fields[key] = value;
        } else if (behavior === "toggles" && typeof value === "object" && value !== null) {
            const toggles = Object.entries(value).filter(([entry]) => isToggleKey(entry));
            if (toggles.length > 0) {
                fields[key] = Object.fromEntries(toggles);
            }
        }
    }
    return { note: "", localLore: [], ...fields, message: [], name, id };
}
