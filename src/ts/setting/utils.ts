import type { SettingItem, SettingContext, SettingSection } from "./types";
import type { LLMModel } from "../model/types";
import {
    activeMainProfile,
    activeModelPreset,
    activePersona,
    activePreset,
    readSettingsRoot,
    settings,
    writeSettingsRoot,
    type ModelProfileView,
} from "../storage/settingsViews.svelte";
import { language } from "src/lang";
import { accessibilitySettingsItems } from "./accessibilitySettingsData";
import { advancedSettingsItems } from "./advancedSettingsData";
import { interactionSettingsItems } from "./interactionSettingsData";
import {
    basicParameterItems,
    modelParameterItems,
    modelSpecificParameterItems,
    penaltyParameterItems,
    samplingParameterItems,
    seedSetting,
} from "./botSettingsParamsData";
import { chatFormatSettingsItems } from "./chatFormatSettingsData";
import { displaySettingsItems } from "./displaySettingsData.svelte";
import { languageSettingsItems } from "./languageSettingsData.svelte";
import { translationSettingsItems } from "./translationSettingsData";
import { memorySettingsItems } from "./memorySettingsData";
import { modelSettingsItems } from "./modelSettingsData";
import { promptSettingsItems } from "./promptSettingsData";
import { voiceSettingsItems } from "./voiceSettingsData";
import { storageSettingsItems } from "./storageSettingsData";

/** Resolve a flat or dotted language key to a string; missing and non-string values have no label. */
export function resolveLanguageText(source: unknown, key: string | undefined): string {
    if (!key) return "";
    let value = source;
    for (const segment of key.split(".")) {
        if (value === null || typeof value !== "object") return "";
        value = (value as Record<string, unknown>)[segment];
    }
    return typeof value === "string" ? value : "";
}

/** The current language's string for a flat or dotted key, or `""` when it has none. */
export function languageText(key: string | undefined): string {
    return resolveLanguageText(language, key);
}

/** The current language's `labelKey`, then `fallbackLabel`, else an empty label. */
export function getLabel(item: SettingItem): string {
    return languageText(item.labelKey) || (item.fallbackLabel ?? "");
}

/**
 * The context the conditions and wrappers read (`SettingRenderer`, `SettingsSections`): the settings
 * views, the selected (or chat-bound) presets and persona, the given model profile or else the main
 * slot's, and the model info the caller derived. Call it inside `$derived` so it follows the views.
 */
export function settingContext(parts: {
    modelProfile?: ModelProfileView;
    modelInfo: LLMModel;
    subModelInfo: LLMModel;
}): SettingContext {
    return {
        settings,
        preset: activePreset,
        modelPreset: activeModelPreset,
        modelProfile: parts.modelProfile ?? activeMainProfile,
        persona: activePersona,
        modelInfo: parts.modelInfo,
        subModelInfo: parts.subModelInfo,
    };
}

/**
 * Value precedence: `getValue`, then `bindPath`, then `bindKey`. Bindings read their root through
 * `readSettingsRoot` in `src/ts/storage/settingsViews.svelte.ts`.
 */
export function getSettingValue(item: SettingItem, ctx: SettingContext): any {
    if (item.getValue) {
        return item.getValue(ctx);
    }
    if (item.bindPath) {
        const [root, ...parts] = item.bindPath.split(".");
        let value: any = readSettingsRoot(root);
        for (const part of parts) {
            value = value?.[part];
        }
        return value;
    }
    if (item.bindKey) {
        return readSettingsRoot(item.bindKey);
    }
    return undefined;
}

/**
 * Write through `setValue`, else `bindPath`, else `bindKey`, then call `onChange`. Bindings use
 * `src/ts/storage/settingsViews.svelte.ts`'s root readers/writers; dotted paths create missing objects
 * and mutate the resolved root's leaf. Unlike `updateSettingValue`, this does not skip equal values.
 */
export function setSettingValue(item: SettingItem, newValue: any, ctx: SettingContext): void {
    if (item.setValue) {
        item.setValue(newValue, ctx);
    } else if (item.bindPath) {
        const [root, ...parts] = item.bindPath.split(".");
        if (parts.length === 0) {
            writeSettingsRoot(root, newValue);
        } else {
            let obj: any = readSettingsRoot(root);
            if (obj === undefined || obj === null) {
                obj = {};
                writeSettingsRoot(root, obj);
                obj = readSettingsRoot(root);
            }
            for (let i = 0; i < parts.length - 1; i++) {
                obj = obj[parts[i]] ??= {};
            }
            obj[parts[parts.length - 1]] = newValue;
        }
    } else if (item.bindKey) {
        writeSettingsRoot(item.bindKey, newValue);
    }

    if (item.onChange) {
        item.onChange(newValue, ctx);
    }
}

/**
 * The write of a settings wrapper's function binding: the user's edit goes through
 * `setSettingValue` synchronously, in the same task as the input, so a forwarded field lands in the
 * preset selected at that moment (a copy written back from an `$effect` could land after a
 * switch). A write of the value already there is skipped, so `onChange` fires once per edit.
 */
export function updateSettingValue(item: SettingItem, newValue: any, ctx: SettingContext): void {
    if (newValue !== getSettingValue(item, ctx)) {
        setSettingValue(item, newValue, ctx);
    }
}

/**
 * Check if item should be visible based on condition
 */
export function checkCondition(item: SettingItem, ctx: SettingContext): boolean {
    if (!item.condition) return true;
    return item.condition(ctx);
}

/** Whether any item of the section passes its condition; a section with none renders nothing. */
export function sectionHasVisibleItems(section: SettingSection, ctx: SettingContext): boolean {
    return section.items.some((item) => checkCondition(item, ctx));
}

/**
 * Every page's leaf arrays, including Language and Translation, each item once. The optional
 * label/keyword filter has no UI caller; `src/ts/setting/searchIndex.ts` searches the unfiltered catalog.
 */
export function getFullSettingsData(searchTerm = "") {
    const full = accessibilitySettingsItems.concat(
        advancedSettingsItems,
        modelParameterItems,
        basicParameterItems,
        seedSetting,
        samplingParameterItems,
        penaltyParameterItems,
        modelSpecificParameterItems,
        chatFormatSettingsItems,
        displaySettingsItems,
        languageSettingsItems,
        translationSettingsItems,
        modelSettingsItems,
        promptSettingsItems,
        memorySettingsItems,
        voiceSettingsItems,
        interactionSettingsItems,
        storageSettingsItems,
    );

    if (!searchTerm) return full;

    const lowerSearch = searchTerm.toLowerCase();
    return full.filter((item) => {
        const label = getLabel(item).toLowerCase();
        const keywords = item.keywords?.map((k) => k.toLowerCase()) || [];
        return label.includes(lowerSearch) || keywords.some((k) => k.includes(lowerSearch));
    });
}
