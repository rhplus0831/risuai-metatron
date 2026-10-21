import type { SettingItem } from "./types";

// The Voice & Emotion page (`VoiceSettings.svelte`, handwritten) renders this item in its Emotion
// section, under the emotion method: the auxiliary model's emotion prompt, moved from Advanced.
export const voiceSettingsItems: SettingItem[] = [
    {
        id: "adv.emoPrompt",
        type: "text",
        labelKey: "emotionPrompt",
        bindKey: "emotionPrompt2",
        helpKey: "emotionPrompt",
        options: { placeholder: "Leave it blank to use default" },
    },
];
