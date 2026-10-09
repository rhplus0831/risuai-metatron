/**
 * Chat Format Settings Data
 *
 * Data-driven definition for ChatFormatSettings page.
 */

import type { SettingItem } from "./types";

export const chatFormatSettingsItems: SettingItem[] = [
    {
        id: "chatFormat.template",
        type: "select",
        labelKey: "chatFormating",
        getValue: (ctx) => ctx.modelProfile.instructChatTemplate,
        setValue: (value, ctx) => {
            ctx.modelProfile.instructChatTemplate = value;
        },
        options: {
            selectOptions: [
                { value: "chatml", label: "ChatML" },
                { value: "llama3", label: "Llama3" },
                { value: "gpt2", label: "GPT2" },
                { value: "gemma", label: "Gemma" },
                { value: "mistral", label: "Mistral" },
                { value: "llama2", label: "Llama2" },
                { value: "vicuna", label: "Vicuna" },
                { value: "alpaca", label: "Alpaca" },
                { value: "jinja", label: "Custom (Jinja)" },
            ],
        },
        keywords: ["chat", "format", "template", "chatml", "llama", "jinja"],
    },
    {
        id: "chatFormat.jinjaTemplate",
        type: "textarea",
        fallbackLabel: "Jinja Template",
        getValue: (ctx) => ctx.modelProfile.JinjaTemplate,
        setValue: (value, ctx) => {
            ctx.modelProfile.JinjaTemplate = value;
        },
        condition: (ctx) => ctx.modelProfile.instructChatTemplate === "jinja",
        keywords: ["jinja", "template", "custom"],
    },
];
