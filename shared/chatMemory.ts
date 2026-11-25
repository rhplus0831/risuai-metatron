import type { Chat } from "./database.ts";
import type { HypaV3Preset } from "./memory.ts";
import { selectedHypaV3Preset } from "./hypaV3Presets.ts";
import { STRUCTURED_MEMORY_ALGORITHM } from "./structuredMemory.ts";

/** Flat settings accepted by both the server database and the tab's section adapter. */
export type ChatMemorySettings = Readonly<{
    memoryAlgorithmType?: unknown;
    hanuraiEnable?: boolean;
    hypav2?: boolean;
    hypaV3?: boolean;
    supaModelType?: string;
    hypaV3Presets?: HypaV3Preset[];
    hypaV3PresetId?: string;
}>;

/** Unknown stored values are accepted here so readers, rather than migrations, supply defaults. */
export type ChatMemoryInput = Readonly<{
    memoryEnabled?: unknown;
    memoryMode?: unknown;
    memoryPresetId?: unknown;
    memoryProfileId?: unknown;
    memoryTrimAck?: unknown;
}>;
export type ChatMemoryFields = Pick<Chat, "memoryEnabled" | "memoryMode" | "memoryPresetId" | "memoryProfileId">;
export type ChatMemorySummary = ChatMemoryFields & Pick<Chat, "memoryTrimAck">;

/** The legacy server order, using the persisted selector vocabulary. */
export function legacyMemoryAlgorithm(settings: ChatMemorySettings) {
    if (settings.memoryAlgorithmType === STRUCTURED_MEMORY_ALGORITHM) return STRUCTURED_MEMORY_ALGORITHM;
    if (settings.hanuraiEnable) return "hanuraiMemory";
    if (settings.hypav2) return "hypaMemoryV2";
    if (settings.hypaV3) return "hypaMemoryV3";
    return settings.supaModelType !== "none" ? "supaMemory" : "none";
}

export function chatMemoryMode(chat: ChatMemoryInput | null | undefined): Chat["memoryMode"] {
    const mode = chat?.memoryMode;
    return mode === "hypaV3" || mode === STRUCTURED_MEMORY_ALGORITHM ? mode : undefined;
}

/** A valid stored mode selects the chat's algorithm; absent or malformed modes follow the global settings. */
export function chatMemoryAlgorithm(settings: ChatMemorySettings, chat: ChatMemoryInput | null | undefined) {
    const mode = chatMemoryMode(chat);
    if (mode === STRUCTURED_MEMORY_ALGORITHM) return STRUCTURED_MEMORY_ALGORITHM;
    if (mode === "hypaV3") return "hypaMemoryV3";
    return legacyMemoryAlgorithm(settings);
}

/** The chat's named preset when it exists; absent, malformed, or deleted ids use the Settings default. */
export function chatHypaV3Preset(
    presets: HypaV3Preset[] | undefined,
    selectedId: string | undefined,
    chat: ChatMemoryInput | null | undefined,
) {
    const id = chat?.memoryPresetId;
    const preset = typeof id === "string" ? presets?.find((preset) => preset.id === id) : undefined;
    return preset ?? selectedHypaV3Preset({ hypaV3Presets: presets, hypaV3PresetId: selectedId });
}

/** A non-empty named connection, including a deleted id so request routing refuses instead of falling back. */
export function chatMemoryProfileId(chat: ChatMemoryInput | null | undefined): string | undefined {
    const id = chat?.memoryProfileId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** An explicit chat switch wins over the preset default and then the owner's legacy switch. */
export function chatMemoryEnabled(
    chat: ChatMemoryInput | null | undefined,
    owner: Readonly<{ supaMemory?: unknown }> | null | undefined,
    settings: ChatMemorySettings,
): boolean {
    if (typeof chat?.memoryEnabled === "boolean") return chat.memoryEnabled;
    const algorithm = chatMemoryAlgorithm(settings, chat);
    if (
        (algorithm === "hypaMemoryV3" || algorithm === STRUCTURED_MEMORY_ALGORITHM) &&
        chatHypaV3Preset(settings.hypaV3Presets, settings.hypaV3PresetId, chat)?.settings?.alwaysToggleOn
    )
        return true;
    return owner?.supaMemory === true;
}

/** Valid metadata for list entries, without changing the stored chat. */
export function chatMemorySummary(chat: ChatMemoryInput): ChatMemorySummary {
    const result: ChatMemorySummary = {};
    if (typeof chat.memoryEnabled === "boolean") result.memoryEnabled = chat.memoryEnabled;
    const mode = chatMemoryMode(chat);
    if (mode !== undefined) result.memoryMode = mode;
    if (typeof chat.memoryPresetId === "string") result.memoryPresetId = chat.memoryPresetId;
    if (typeof chat.memoryProfileId === "string") result.memoryProfileId = chat.memoryProfileId;
    if (typeof chat.memoryTrimAck === "number" && Number.isFinite(chat.memoryTrimAck))
        result.memoryTrimAck = chat.memoryTrimAck;
    return result;
}
