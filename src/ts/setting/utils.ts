import type { SettingItem, SettingContext } from "./types";
import { readSettingsRoot, writeSettingsRoot } from "../storage/settingsViews.svelte";
import { language } from "src/lang";
import { accessibilitySettingsItems } from "./accessibilitySettingsData";
import { advancedSettingsItems } from "./advancedSettingsData";
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

export function getLabel(item: SettingItem): string {
    if (item.labelKey && (language as any)[item.labelKey]) {
        return (language as any)[item.labelKey];
    }
    return item.fallbackLabel ?? "";
}

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
 * preset selected at that moment (Phase 3: a copy written back from an `$effect` could land after a
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
    );

    if (!searchTerm) return full;

    const lowerSearch = searchTerm.toLowerCase();
    return full.filter((item) => {
        const label = getLabel(item).toLowerCase();
        const keywords = item.keywords?.map((k) => k.toLowerCase()) || [];
        return label.includes(lowerSearch) || keywords.some((k) => k.includes(lowerSearch));
    });
}
