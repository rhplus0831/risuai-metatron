import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";

/**
 * Registry items below the handwritten controls in `src/lib/Setting/Pages/ModelSettings.svelte`'s
 * Preset tab: global provider settings and the custom model list, shared by every model preset.
 */

export const modelSettingsItems: SettingItem[] = [
    {
        id: "adv.retries",
        type: "number",
        labelKey: "requestretrys",
        bindKey: "requestRetrys",
        helpKey: "requestretrys",
        options: { min: 0, max: 20 },
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
        labelKey: "visionQuality",
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
    },
    {
        id: "adv.autoCont",
        type: "check",
        labelKey: "autoContinueChat",
        bindKey: "autoContinueChat",
        helpKey: "autoContinueChat",
    },
    {
        id: "adv.autoContinueMin",
        type: "number",
        labelKey: "autoContinueMinTokens",
        bindKey: "autoContinueMinTokens",
        options: { min: 0 },
    },
    {
        id: "adv.remIncomp",
        type: "check",
        labelKey: "removeIncompleteResponse",
        bindKey: "removeIncompleteResponse",
    },
    { id: "adv.newOai", type: "check", labelKey: "newOAIHandle", bindKey: "newOAIHandle" },
    {
        id: "adv.dynamicModelRegistry",
        type: "check",
        labelKey: "dynamicModelRegistry",
        bindKey: "dynamicModelRegistry",
    },
    {
        id: "adv.antiOverload",
        type: "check",
        labelKey: "antiServerOverload",
        bindKey: "antiServerOverloads",
    },
    {
        id: "adv.openAIFlex",
        type: "check",
        labelKey: "openAIFlexProcessing",
        bindKey: "openAIFlexProcessing",
        helpKey: "openAIFlexProcessing",
        showExperimental: true,
    },
    {
        id: "adv.claudeCache",
        type: "check",
        labelKey: "claude1HourCaching",
        bindKey: "claude1HourCaching",
    },
    {
        id: "adv.claudeBatch",
        type: "check",
        labelKey: "claudeBatching",
        bindKey: "claudeBatching",
        showExperimental: true,
    },
    // In a collapsible section, so without its own accordion.
    {
        type: "custom",
        id: "adv.customModels",
        componentId: "CustomModelsSettings",
        componentProps: { noAccordion: true },
    },
    // From Accessibility.
    {
        id: "acc.applyAdditionalParamsToAll",
        type: "check",
        labelKey: "applyAdditionalParamsToAll",
        bindKey: "applyAdditionalParamsToAll",
        keywords: ["apply", "additional", "parameters", "to", "all", "models"],
    },
];

/**
 * Rendered in place inside the Additional Params accordion, under its table (outside any section):
 * whether that table applies to every model, not only the reverse proxy (`getAdditionalParameters`).
 */
export const modelAdditionalParamsItems: SettingItem[] = itemsById(modelSettingsItems, [
    "acc.applyAdditionalParamsToAll",
]);

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
