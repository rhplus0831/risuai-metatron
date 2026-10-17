import { resolveGlobalChatVar } from "../../../shared/prompt/toggles.ts";
import {
    captureToggleValues,
    createTogglePreset,
    toggleValuesForChat,
    type TogglePreset,
} from "../../../shared/togglePresets.ts";
import { findChat, mergeChatMeta, setChatMeta, type ChatRef } from "../storage/chatStore.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { chatToggleDefinitions } from "./chatToggles.svelte";

function captureChat(ref: ChatRef) {
    const chat = findChat(ref);
    if (!chat) return undefined;
    const definitionsText = chatToggleDefinitions(ref);
    return captureToggleValues(definitionsText, (key) =>
        resolveGlobalChatVar(key, chat.GLGlobalVariables, settings.globalChatVariables, definitionsText),
    );
}

export function saveTogglePresetFromChat(ref: ChatRef, name: string): TogglePreset | undefined {
    name = name.trim();
    if (!name) return undefined;
    const captured = captureChat(ref);
    if (!captured) return undefined;
    const preset = createTogglePreset(name, captured.values, captured.kinds);
    (settings.togglePresets ??= []).push(preset);
    setChatMeta(ref, { togglePresetId: preset.id });
    return preset;
}

export function overwriteTogglePreset(ref: ChatRef, id: string): boolean {
    const preset = settings.togglePresets?.find((entry) => entry.id === id);
    if (!preset) return false;
    const captured = captureChat(ref);
    if (!captured) return false;
    preset.values = captured.values;
    preset.kinds = captured.kinds;
    preset.updatedAt = Date.now();
    setChatMeta(ref, { togglePresetId: id });
    return true;
}

export function applyTogglePreset(ref: ChatRef, id: string): boolean {
    const chat = findChat(ref);
    const preset = settings.togglePresets?.find((entry) => entry.id === id);
    if (!chat || !preset) return false;
    const definitionsText = chatToggleDefinitions(ref);
    const projected = toggleValuesForChat(preset, definitionsText);
    const changed = Object.fromEntries(
        Object.entries(projected).filter(([key, value]) => chat.GLGlobalVariables?.[key] !== value),
    );
    // Preserve other writers' keys. These two metadata operations coalesce into one queued op.
    if (Object.keys(changed).length > 0) {
        mergeChatMeta(ref, "GLGlobalVariables", changed);
    }
    setChatMeta(ref, { togglePresetId: id });
    return true;
}

export function unlinkTogglePreset(ref: ChatRef): boolean {
    if (!findChat(ref)) return false;
    setChatMeta(ref, {}, ["togglePresetId"]);
    return true;
}

export function renameTogglePreset(id: string, name: string): boolean {
    name = name.trim();
    const preset = settings.togglePresets?.find((entry) => entry.id === id);
    if (!preset || !name) return false;
    preset.name = name;
    preset.updatedAt = Date.now();
    return true;
}

export function deleteTogglePreset(id: string): boolean {
    const index = settings.togglePresets?.findIndex((entry) => entry.id === id) ?? -1;
    if (index === -1) return false;
    settings.togglePresets.splice(index, 1);
    return true;
}
