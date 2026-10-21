import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";

// The Prompt page's Others tab (`PromptPresetSettings.svelte`) below its handwritten accordions: the
// prompt options moved from Advanced. They are global (`providers` and `ui` fields), not fields of
// the prompt preset the page edits, so their section says it applies to every preset.
export const promptSettingsItems: SettingItem[] = [
    {
        id: "adv.addPrompt",
        type: "text",
        labelKey: "additionalPrompt",
        bindKey: "additionalPrompt",
        helpKey: "additionalPrompt",
        classes: "mt-4",
    },
    {
        id: "adv.descPrefix",
        type: "text",
        labelKey: "descriptionPrefix",
        bindKey: "descriptionPrefix",
    },
    {
        id: "adv.presetChain",
        type: "text",
        labelKey: "presetChain",
        bindKey: "presetChain",
        helpKey: "presetChain",
        options: { placeholder: "Leave it blank to not use" },
    },
    {
        id: "adv.sayNothing",
        type: "check",
        labelKey: "sayNothing",
        bindKey: "useSayNothing",
        helpKey: "sayNothing",
        classes: "mt-4",
    },
    {
        id: "adv.cot",
        type: "check",
        labelKey: "cot",
        bindKey: "chainOfThought",
        condition: (ctx) => ctx.settings.ui.showUnrecommended,
        helpKey: "customChainOfThought",
        helpUnrecommended: true,
        classes: "mt-4",
    },
    // From Display, by way of Advanced.
    {
        id: "display.showPromptComparison",
        type: "check",
        labelKey: "showPromptComparison",
        bindKey: "showPromptComparison",
        keywords: ["prompt", "comparison"],
        classes: "mt-4",
    },
    // In a collapsible section, so without its own accordion.
    {
        type: "custom",
        id: "adv.banChar",
        componentId: "BanCharacterSetSettings",
        componentProps: { noAccordion: true },
    },
];

/** The Others tab's sections, below its handwritten accordions. */
export const promptSettingsSections: SettingSection[] = [
    {
        id: "prompt.advanced",
        labelKey: "settingsSectionPromptAdvanced",
        descriptionKey: "settingsSectionPromptAdvancedDesc",
        collapsible: true,
        items: itemsById(promptSettingsItems, [
            "adv.addPrompt",
            "adv.descPrefix",
            "adv.presetChain",
            "adv.sayNothing",
            "adv.cot",
            "display.showPromptComparison",
            "adv.banChar",
        ]),
    },
];
