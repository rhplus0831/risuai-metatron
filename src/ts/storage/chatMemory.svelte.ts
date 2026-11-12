import { untrack } from "svelte";
import {
    chatMemoryEnabled,
    chatMemorySummary,
    type ChatMemoryFields,
    type ChatMemorySettings,
} from "../../../shared/chatMemory.ts";
import { chatEntry, selectedChatId, setChatMeta, type ChatRef } from "./chatStore.svelte";
import { findCharacter } from "./characterStore.svelte";
import { settings } from "./settingsViews.svelte";

/** The small flat settings input shared with server memory readers. */
export function chatMemorySettings(): ChatMemorySettings {
    return {
        memoryAlgorithmType: settings.ui.memoryAlgorithmType,
        hanuraiEnable: settings.memoryTranslateMedia.hanuraiEnable,
        hypav2: settings.memoryTranslateMedia.hypav2,
        hypaV3: settings.memoryTranslateMedia.hypaV3,
        supaModelType: settings.memoryTranslateMedia.supaModelType,
        hypaV3Presets: settings.hypaV3Presets.items,
        hypaV3PresetId: settings.hypaV3Presets.selectedId,
    };
}

/** Store an explicit switch, invalidating only this chat's trim acknowledgement when enabling. */
export function setChatMemoryEnabled(ref: ChatRef, on: boolean) {
    setChatMeta(ref, { memoryEnabled: on }, on ? ["memoryTrimAck"] : []);
}

/** Store an explicit algorithm choice; Legacy is the absence of a stored mode, including on list entries. */
export function setChatMemoryMode(ref: ChatRef, mode: ChatMemoryFields["memoryMode"]) {
    if (mode === undefined) setChatMeta(ref, {}, ["memoryMode"]);
    else setChatMeta(ref, { memoryMode: mode });
}

/** A new chat inherits its source's memory choices independently of the model binding preference. */
export function initialChatMemory(chaId: string): ChatMemoryFields {
    return untrack(() => {
        const chatId = selectedChatId(chaId);
        const source = chatId === null ? undefined : chatEntry({ chaId, chatId });
        if (!source) return {};
        const { memoryTrimAck: _ack, ...fields } = chatMemorySummary(source);
        return { ...fields, memoryEnabled: chatMemoryEnabled(source, findCharacter(chaId), chatMemorySettings()) };
    });
}
