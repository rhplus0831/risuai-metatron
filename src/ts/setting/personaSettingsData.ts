import type { SettingItem } from "./types";

// The Persona page (`PersonaSettings.svelte`, handwritten) renders this item above the note field it
// reveals; moved from Advanced (settings UI plan slice 4).
export const personaSettingsItems: SettingItem[] = [
    {
        id: "adv.personaNote",
        type: "check",
        labelKey: "personaNote",
        bindKey: "personaNote",
        showExperimental: true,
        classes: "mb-2",
    },
];
