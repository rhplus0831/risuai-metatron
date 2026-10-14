/**
 * Bot Settings - Parameters Tab Data
 *
 * Data-driven definition for the Prompt page's Parameters tab (`PromptPresetSettings.svelte`, submenu 1)
 * and the Model page's model parameters (`modelParameterItems`).
 * Contains standard parameter settings like context size, temperature, etc.
 */

import type { SettingItem } from "./types";
import { LLMFlags } from "../model/types";

/**
 * Basic parameter settings that are always visible
 */
export const basicParameterItems: SettingItem[] = [
    {
        id: "params.maxResponse",
        type: "number",
        labelKey: "maxResponseSize",
        bindKey: "maxResponse",
        options: { min: 0, max: 2048 },
        keywords: ["response", "size", "output", "length"],
    },
    {
        id: "params.maxContextOverride",
        type: "check",
        labelKey: "maxContextOverride",
        helpKey: "maxContextOverride",
        getValue: (ctx) => ctx.preset.maxContextOverride,
        // Ticking an unset (0) size seeds it with the main profile's context size.
        setValue: (value, ctx) => {
            if (value === true && !((ctx.preset.maxContextOverrideSize ?? 0) > 0)) {
                ctx.preset.maxContextOverrideSize = ctx.modelProfile.maxContext;
            }
            ctx.preset.maxContextOverride = value;
        },
        keywords: ["context", "size", "token", "limit", "override"],
    },
    {
        id: "params.maxContextOverrideSize",
        type: "number",
        labelKey: "maxContextSize",
        bindKey: "maxContextOverrideSize",
        options: { min: 0 },
        condition: (ctx) => ctx.preset.maxContextOverride === true,
        keywords: ["context", "size", "token", "limit", "override"],
    },
];

/**
 * Seed setting - only for certain models
 */
export const seedSetting: SettingItem = {
    id: "params.seed",
    type: "number",
    labelKey: "seed",
    bindKey: "generationSeed",
    condition: (ctx) =>
        ctx.modelInfo.id.startsWith("gpt") || ctx.modelInfo.id === "reverse_proxy" || ctx.modelInfo.id === "openrouter",
    keywords: ["seed", "random", "deterministic"],
};

/**
 * Temperature and common sampling parameters
 */
export const samplingParameterItems: SettingItem[] = [
    {
        id: "params.temperature",
        type: "slider",
        labelKey: "temperature",
        helpKey: "tempature",
        bindKey: "temperature",
        condition: (ctx) => ctx.modelInfo.parameters.includes("temperature"),
        options: {
            min: 0,
            max: 200,
            multiple: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ["temperature", "creativity", "randomness"],
    },
];

/**
 * OpenAI-style penalty parameters
 * These are conditionally shown based on modelInfo.parameters
 */
export const penaltyParameterItems: SettingItem[] = [
    {
        id: "params.frequencyPenalty",
        type: "slider",
        labelKey: "frequencyPenalty",
        bindKey: "frequencyPenalty",
        condition: (ctx) => ctx.modelInfo.parameters.includes("frequency_penalty"),
        options: {
            min: 0,
            max: 200,
            multiple: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ["frequency", "penalty", "repetition"],
    },
    {
        id: "params.presencePenalty",
        type: "slider",
        labelKey: "presensePenalty",
        bindKey: "PresensePenalty",
        condition: (ctx) => ctx.modelInfo.parameters.includes("presence_penalty"),
        options: {
            min: 0,
            max: 200,
            multiple: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ["presence", "penalty"],
    },
    {
        id: "params.topP",
        type: "slider",
        fallbackLabel: "Top P",
        bindKey: "top_p",
        condition: (ctx) => ctx.modelInfo.parameters.includes("top_p"),
        options: {
            min: 0,
            max: 1,
            step: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ["top", "p", "nucleus", "sampling"],
    },
];

/**
 * Model-specific parameters that depend on modelInfo.parameters
 */
export const modelSpecificParameterItems: SettingItem[] = [
    {
        id: "params.thinkingType",
        type: "segmented",
        labelKey: "thinkingType",
        bindKey: "thinkingType",
        condition: (ctx) =>
            ctx.modelInfo.flags.includes(LLMFlags.claudeThinking) ||
            ctx.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking),
        options: {
            segmentOptions: [
                { value: "off", label: "Off" },
                {
                    value: "budget",
                    label: "Budget (Manual Tokens)",
                    condition: (ctx) => ctx.modelInfo.flags.includes(LLMFlags.claudeThinking),
                },
                {
                    value: "adaptive",
                    label: "Adaptive",
                    condition: (ctx) => ctx.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking),
                },
            ],
        },
        keywords: ["thinking", "type", "mode", "adaptive", "budget"],
    },
    {
        id: "params.deepseekThinkingType",
        type: "segmented",
        fallbackLabel: "Thinking Mode",
        bindKey: "deepseekThinkingType",
        condition: (ctx) => ctx.modelInfo.flags.includes(LLMFlags.deepSeekThinkingToggle),
        options: {
            segmentOptions: [
                { value: "off", label: "Off" },
                { value: "enabled", label: "Enabled" },
            ],
        },
        keywords: ["thinking", "type", "mode", "deepseek", "reasoning"],
    },
    {
        id: "params.thinkingTokens",
        type: "slider",
        labelKey: "thinkingTokens",
        bindKey: "thinkingTokens",
        condition: (ctx) =>
            ctx.modelInfo.parameters.includes("thinking_tokens") && ctx.preset.thinkingType === "budget",
        options: {
            min: -1,
            max: 64000,
            step: 200,
            disableable: true,
        },
        keywords: ["thinking", "tokens", "reasoning"],
    },
    {
        id: "params.adaptiveThinkingEffort",
        type: "segmented",
        labelKey: "adaptiveThinkingEffort",
        bindKey: "adaptiveThinkingEffort",
        condition: (ctx) =>
            ctx.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking) && ctx.preset.thinkingType === "adaptive",
        options: {
            segmentOptions: [
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
                {
                    value: "xhigh",
                    label: "XHigh",
                    condition: (ctx) => ctx.modelInfo.flags.includes(LLMFlags.claudeXHighEffort),
                },
                { value: "max", label: "Max" },
            ],
        },
        keywords: ["adaptive", "thinking", "effort"],
    },
    {
        id: "params.deepseekReasoningEffort",
        type: "segmented",
        fallbackLabel: "Reasoning Effort",
        bindKey: "deepseekReasoningEffort",
        condition: (ctx) =>
            ctx.modelInfo.flags.includes(LLMFlags.deepSeekThinkingToggle) &&
            ctx.preset.deepseekThinkingType === "enabled",
        options: {
            segmentOptions: [
                { value: "high", label: "High" },
                { value: "max", label: "Max" },
            ],
        },
        keywords: ["deepseek", "reasoning", "effort"],
    },
    {
        id: "params.topK",
        type: "slider",
        fallbackLabel: "Top K",
        bindKey: "top_k",
        condition: (ctx) => ctx.modelInfo.parameters.includes("top_k"),
        options: {
            min: 0,
            max: 100,
            step: 1,
            disableable: true,
        },
        keywords: ["top", "k", "sampling"],
    },
    {
        id: "params.minP",
        type: "slider",
        fallbackLabel: "Min P",
        bindKey: "min_p",
        condition: (ctx) => ctx.modelInfo.parameters.includes("min_p"),
        options: {
            min: 0,
            max: 1,
            step: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ["min", "p", "sampling"],
    },
    {
        id: "params.topA",
        type: "slider",
        fallbackLabel: "Top A",
        bindKey: "top_a",
        condition: (ctx) => ctx.modelInfo.parameters.includes("top_a"),
        options: {
            min: 0,
            max: 1,
            step: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ["top", "a", "sampling"],
    },
    {
        id: "params.repetitionPenalty",
        type: "slider",
        fallbackLabel: "Repetition penalty",
        bindKey: "repetition_penalty",
        condition: (ctx) => ctx.modelInfo.parameters.includes("repetition_penalty"),
        options: {
            min: 0,
            max: 2,
            step: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ["repetition", "penalty"],
    },
    {
        id: "params.reasoningEffort",
        type: "segmented",
        fallbackLabel: "Reasoning Effort",
        bindKey: "reasoningEffort",
        condition: (ctx) =>
            ctx.modelInfo.parameters.includes("reasoning_effort") ||
            ctx.modelInfo.parameters.includes("reasoning_effort_min_medium") ||
            ctx.modelInfo.parameters.includes("reasoning_effort_none") ||
            ctx.modelInfo.parameters.includes("reasoning_effort_xhigh"),
        options: {
            segmentOptions: [
                {
                    value: -1,
                    label: "Minimal",
                    condition: (ctx) =>
                        !ctx.modelInfo.parameters.includes("reasoning_effort_none") &&
                        !ctx.modelInfo.parameters.includes("reasoning_effort_min_medium"),
                },
                {
                    value: -1,
                    label: "None",
                    condition: (ctx) => ctx.modelInfo.parameters.includes("reasoning_effort_none"),
                },
                {
                    value: 0,
                    label: "Low",
                    condition: (ctx) => !ctx.modelInfo.parameters.includes("reasoning_effort_min_medium"),
                },
                { value: 1, label: "Medium" },
                { value: 2, label: "High" },
                {
                    value: 3,
                    label: "XHigh",
                    condition: (ctx) => ctx.modelInfo.parameters.includes("reasoning_effort_xhigh"),
                },
            ],
        },
        keywords: ["reasoning", "effort", "xhigh"],
    },
    {
        id: "params.verbosity",
        type: "segmented",
        fallbackLabel: "Verbosity",
        bindKey: "verbosity",
        condition: (ctx) => ctx.modelInfo.parameters.includes("verbosity"),
        options: {
            segmentOptions: [
                { value: 0, label: "Low" },
                { value: 1, label: "Medium" },
                { value: 2, label: "High" },
            ],
        },
        keywords: ["verbosity", "length"],
    },
];

/**
 * The model profile's parameters, on the Model page (`ModelSettings.svelte`): the context size
 * belongs to the model profile (`docs/plan/split-preset.md`).
 */
export const modelParameterItems: SettingItem[] = [
    {
        id: "params.maxContext",
        type: "number",
        labelKey: "maxContextSize",
        getValue: (ctx) => ctx.modelProfile.maxContext,
        setValue: (value, ctx) => {
            ctx.modelProfile.maxContext = value;
        },
        options: { min: 0 },
        keywords: ["context", "size", "token", "limit"],
    },
];

/**
 * All basic parameter items combined for Parameters tab
 * Order: maxResponse, seed, thinkingType, thinkingTokens, adaptiveThinkingEffort, temperature, topK, minP, topA, repetitionPenalty, reasoningEffort, verbosity, topP, frequencyPenalty, presencePenalty
 */
export const allBasicParameterItems: SettingItem[] = [
    // Basic settings (always shown)
    ...basicParameterItems,
    seedSetting,

    // Model-specific sampling parameters (in user-specified order)
    modelSpecificParameterItems.find((i) => i.id === "params.thinkingType")!,
    modelSpecificParameterItems.find((i) => i.id === "params.deepseekThinkingType")!,
    modelSpecificParameterItems.find((i) => i.id === "params.thinkingTokens")!,
    modelSpecificParameterItems.find((i) => i.id === "params.adaptiveThinkingEffort")!,
    modelSpecificParameterItems.find((i) => i.id === "params.deepseekReasoningEffort")!,
    ...samplingParameterItems, // temperature
    modelSpecificParameterItems.find((i) => i.id === "params.topK")!,
    modelSpecificParameterItems.find((i) => i.id === "params.minP")!,
    modelSpecificParameterItems.find((i) => i.id === "params.topA")!,
    modelSpecificParameterItems.find((i) => i.id === "params.repetitionPenalty")!,
    modelSpecificParameterItems.find((i) => i.id === "params.reasoningEffort")!,
    modelSpecificParameterItems.find((i) => i.id === "params.verbosity")!,
    penaltyParameterItems.find((i) => i.id === "params.topP")!,
    penaltyParameterItems.find((i) => i.id === "params.frequencyPenalty")!,
    penaltyParameterItems.find((i) => i.id === "params.presencePenalty")!,
];
