import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";

// The Memory page (`MemorySettings.svelte`, handwritten) renders these items, moved from Advanced
// (settings UI plan slice 4): the lorebook limits in their own section at the end of the page, and
// the punctuation removal inside the SupaMemory block (`supaMemory.ts` is its only reader).
export const memorySettingsItems: SettingItem[] = [
    {
        id: "adv.lbDepth",
        type: "number",
        labelKey: "loreBookDepth",
        bindKey: "loreBookDepth",
        options: { min: 0, max: 20 },
        classes: "mt-4",
    },
    {
        id: "adv.lbToken",
        type: "number",
        labelKey: "loreBookToken",
        bindKey: "loreBookToken",
        options: { min: 0, max: 4096 },
    },
    {
        id: "adv.remPunc",
        type: "check",
        labelKey: "removePunctuationHypa",
        bindKey: "removePunctuationHypa",
        helpKey: "removePunctuationHypa",
        classes: "mb-4",
    },
];

/** Rendered in place inside the SupaMemory block, outside any section. */
export const memorySupaMemoryItems: SettingItem[] = itemsById(memorySettingsItems, ["adv.remPunc"]);

/** The page's sections, after its handwritten memory controls. */
export const memorySettingsSections: SettingSection[] = [
    {
        id: "memory.lorebook",
        labelKey: "loreBook",
        items: itemsById(memorySettingsItems, ["adv.lbDepth", "adv.lbToken"]),
    },
];
