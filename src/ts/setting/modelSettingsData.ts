import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";

// The Model page's Preset tab (`ModelSettings.svelte`) below its handwritten controls: the request
// and provider options moved from Advanced (settings UI plan slice 4). They are global (`providers`
// fields and the custom model list), not fields of the model preset the tab edits, so their sections
// say they apply to every preset.
export const modelSettingsItems: SettingItem[] = [
    {
        id: "adv.retries",
        type: "number",
        labelKey: "requestretrys",
        bindKey: "requestRetrys",
        helpKey: "requestretrys",
        options: { min: 0, max: 20 },
        classes: "mt-4",
    },
    {
        id: "adv.genTime",
        type: "number",
        labelKey: "genTimes",
        bindKey: "genTime",
        helpKey: "genTimes",
        options: { min: 0, max: 4096 },
    },
    {
        id: "adv.visionQual",
        type: "select",
        fallbackLabel: "Vision Quality",
        bindKey: "gptVisionQuality",
        helpKey: "gptVisionQuality",
        options: {
            selectOptions: [
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
            ],
        },
    },
    {
        id: "adv.autoFill",
        type: "check",
        labelKey: "autoFillRequestURL",
        bindKey: "autofillRequestUrl",
        helpKey: "autoFillRequestURL",
        classes: "mt-4",
    },
    {
        id: "adv.autoCont",
        type: "check",
        labelKey: "autoContinueChat",
        bindKey: "autoContinueChat",
        helpKey: "autoContinueChat",
        classes: "mt-4",
    },
    {
        id: "adv.autoContinueMin",
        type: "number",
        labelKey: "autoContinueMinTokens",
        bindKey: "autoContinueMinTokens",
        options: { min: 0 },
        classes: "mt-2",
    },
    {
        id: "adv.remIncomp",
        type: "check",
        labelKey: "removeIncompleteResponse",
        bindKey: "removeIncompleteResponse",
        classes: "mt-4",
    },
    { id: "adv.newOai", type: "check", labelKey: "newOAIHandle", bindKey: "newOAIHandle", classes: "mt-4" },
    {
        id: "adv.dynamicModelRegistry",
        type: "check",
        labelKey: "dynamicModelRegistry",
        bindKey: "dynamicModelRegistry",
        classes: "mt-4",
    },
    {
        id: "adv.antiOverload",
        type: "check",
        labelKey: "antiServerOverload",
        bindKey: "antiServerOverloads",
        classes: "mt-4",
    },
    {
        id: "adv.openAIFlex",
        type: "check",
        labelKey: "openAIFlexProcessing",
        bindKey: "openAIFlexProcessing",
        helpKey: "openAIFlexProcessing",
        showExperimental: true,
        classes: "mt-4",
    },
    {
        id: "adv.claudeCache",
        type: "check",
        labelKey: "claude1HourCaching",
        bindKey: "claude1HourCaching",
        classes: "mt-4",
    },
    {
        id: "adv.claudeBatch",
        type: "check",
        labelKey: "claudeBatching",
        bindKey: "claudeBatching",
        showExperimental: true,
        classes: "mt-4",
    },
    // In a collapsible section, so without its own accordion.
    {
        type: "custom",
        id: "adv.customModels",
        componentId: "CustomModelsSettings",
        componentProps: { noAccordion: true },
    },
];

/** The Preset tab's sections, below its handwritten controls. */
export const modelSettingsSections: SettingSection[] = [
    {
        id: "model.advanced",
        labelKey: "settingsSectionModelAdvanced",
        descriptionKey: "settingsSectionModelAdvancedDesc",
        collapsible: true,
        items: itemsById(modelSettingsItems, [
            "adv.retries",
            "adv.genTime",
            "adv.visionQual",
            "adv.autoFill",
            "adv.autoCont",
            "adv.autoContinueMin",
            "adv.remIncomp",
            "adv.newOai",
            "adv.dynamicModelRegistry",
            "adv.antiOverload",
            "adv.openAIFlex",
            "adv.claudeCache",
            "adv.claudeBatch",
        ]),
    },
    {
        id: "model.customModels",
        labelKey: "customModels",
        descriptionKey: "settingsSectionCustomModelsDesc",
        collapsible: true,
        items: itemsById(modelSettingsItems, ["adv.customModels"]),
    },
];
