import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";
import { recoveryDrafts } from "../storage/recoveryDrafts.svelte";

export const advancedSettingsItems: SettingItem[] = [
    { type: "header", id: "adv.header", labelKey: "advancedSettings", options: { level: "h2" }, classes: "!mb-0" },
    { type: "header", id: "adv.warn", labelKey: "advancedSettingsWarn", options: { level: "warning" } },
    {
        id: "adv.recoveredChanges",
        type: "button",
        labelKey: "recoveredChanges",
        condition: () => recoveryDrafts.entries.length > 0,
        options: { onClick: () => recoveryDrafts.open() },
        keywords: ["recovery", "recovered", "drafts", "changes", "복구", "변경"],
    },

    // Media
    {
        id: "adv.assetAlloc",
        type: "number",
        labelKey: "assetMaxDifference",
        bindKey: "assetMaxDifference",
    },

    // Chat Loading
    {
        id: "adv.chatLoadInitial",
        type: "number",
        labelKey: "chatLoadInitialPages",
        bindKey: "chatLoadInitialPages",
        helpKey: "chatLoadInitialPages",
        options: { min: 1 },
    },
    {
        id: "adv.chatLoadAdditional",
        type: "number",
        labelKey: "chatLoadAdditionalPages",
        bindKey: "chatLoadAdditionalPages",
        helpKey: "chatLoadAdditionalPages",
        options: { min: 1 },
    },

    // Toggles
    {
        id: "adv.showUnrec",
        type: "check",
        labelKey: "showUnrecommended",
        bindKey: "showUnrecommended",
        helpKey: "showUnrecommended",
    },
    {
        id: "adv.imgComp",
        type: "check",
        labelKey: "imageCompression",
        bindKey: "imageCompression",
        helpKey: "imageCompression",
    },
    {
        id: "adv.useExp",
        type: "check",
        labelKey: "useExperimental",
        bindKey: "useExperimental",
        helpKey: "useExperimental",
    },
    // From Display.
    {
        id: "display.hideApiKey",
        type: "check",
        labelKey: "hideApiKeys",
        bindKey: "hideApiKey",
        keywords: ["api", "key", "hide"],
    },
    {
        id: "adv.legacyMedia",
        type: "check",
        labelKey: "legacyMediaFindings",
        bindKey: "legacyMediaFindings",
        helpKey: "legacyMediaFindings",
    },
    {
        id: "adv.streamingDisplayOpt",
        type: "segmented",
        labelKey: "streamingDisplayOptimizationMode",
        bindKey: "streamingDisplayOptimizationMode",
        helpKey: "streamingDisplayOptimizationMode",
        condition: (ctx) => ctx.settings.ui.useExperimental,
        showExperimental: true,
        options: {
            segmentOptions: [
                { value: "off", labelKey: "streamingDisplayOptimizationOff" },
                { value: "balanced", labelKey: "streamingDisplayOptimizationBalanced" },
                { value: "strong", labelKey: "streamingDisplayOptimizationStrong" },
            ],
        },
    },
    {
        id: "adv.newImgBeta",
        type: "check",
        labelKey: "newImageHandlingBeta",
        bindKey: "newImageHandlingBeta",
    },
    {
        id: "adv.allowExt",
        type: "check",
        labelKey: "allowAllExtentionFiles",
        bindKey: "allowAllExtentionFiles",
    },
    {
        id: "adv.requestHistoryContent",
        type: "check",
        labelKey: "requestHistoryContent",
        bindKey: "requestHistoryContent",
        helpKey: "requestHistoryContent",
    },
    {
        id: "adv.requestHistoryLimit",
        type: "number",
        labelKey: "requestHistoryLimit",
        bindKey: "requestHistoryLimit",
        helpKey: "requestHistoryLimit",
        options: { min: 10, max: 10000 },
    },

    // Experimental Section (visible when useExperimental is true)
    {
        id: "adv.exp.googleToken",
        type: "check",
        labelKey: "googleCloudTokenization",
        bindKey: "googleClaudeTokenizing",
        condition: (ctx) => ctx.settings.ui.useExperimental,
        showExperimental: true,
    },
    {
        id: "adv.exp.cachePoint",
        type: "check",
        labelKey: "automaticCachePoint",
        bindKey: "automaticCachePoint",
        condition: (ctx) => ctx.settings.ui.useExperimental,
        helpKey: "automaticCachePoint",
        showExperimental: true,
    },
    // More Toggles
    { id: "adv.devTools", type: "check", labelKey: "enableDevTools", bindKey: "enableDevTools" },

    // Node Specific
    {
        id: "adv.promptInfo",
        type: "check",
        labelKey: "promptInfoInsideChat",
        bindKey: "promptInfoInsideChat",
        helpKey: "promptInfoInsideChatDesc",
    },
    {
        id: "adv.promptTextInfo",
        type: "check",
        labelKey: "promptTextInfoInsideChat",
        bindKey: "promptTextInfoInsideChat",
        condition: (ctx) => ctx.settings.ui.promptInfoInsideChat,
    },

    // Dynamic Assets & Others
    {
        id: "adv.dynAssets",
        type: "check",
        labelKey: "dynamicAssets",
        bindKey: "dynamicAssets",
        helpKey: "dynamicAssets",
    },
    { id: "adv.cssErr", type: "check", labelKey: "returnCSSError", bindKey: "returnCSSError" },
    // From Accessibility.
    {
        id: "acc.requestInfoInsideChat",
        type: "check",
        labelKey: "requestInfoInsideChat",
        bindKey: "requestInfoInsideChat",
        keywords: ["request", "info", "chat"],
    },
    {
        id: "acc.inlayErrorResponse",
        type: "check",
        labelKey: "inlayErrorResponse",
        bindKey: "inlayErrorResponse",
        keywords: ["inlay", "error", "response"],
    },
    {
        id: "adv.toolUsage",
        type: "check",
        labelKey: "rememberToolUsage",
        bindKey: "rememberToolUsage",
    },
    {
        id: "adv.simpleTool",
        type: "check",
        labelKey: "simplifiedToolUse",
        bindKey: "simplifiedToolUse",
    },
    {
        id: "adv.tokCache",
        type: "check",
        labelKey: "useTokenizerCaching",
        bindKey: "useTokenizerCaching",
    },

    // More Experimental (Condition: useExperimental)
    {
        id: "adv.exp.claudeRet",
        type: "check",
        labelKey: "claudeCachingRetrival",
        bindKey: "claudeRetrivalCaching",
        condition: (ctx) => ctx.settings.ui.useExperimental,
        helpKey: "unrecommended",
        helpUnrecommended: true,
    },

    // Dynamic Assets Edit (Condition: dynamicAssets)
    {
        id: "adv.dynAssetsEdit",
        type: "check",
        labelKey: "dynamicAssetsEditDisplay",
        bindKey: "dynamicAssetsEditDisplay",
        condition: (ctx) => ctx.settings.memoryTranslateMedia.dynamicAssets,
        helpKey: "dynamicAssetsEditDisplay",
    },

    // Unrecommended Extra (Condition: showUnrecommended)
    {
        id: "adv.plainFetch",
        type: "check",
        labelKey: "forcePlainFetch",
        bindKey: "usePlainFetch",
        condition: (ctx) => ctx.settings.ui.showUnrecommended,
        helpKey: "forcePlainFetch",
        helpUnrecommended: true,
    },
    // From Display.
    {
        id: "display.useLegacyGUI",
        type: "check",
        labelKey: "useLegacyGUI",
        bindKey: "useLegacyGUI",
        keywords: ["legacy", "gui"],
    },

    { type: "custom", id: "adv.export", componentId: "SettingsExportButtons" },

    // Diagnostics; the "Developer & diagnostics" section is its heading (it has no
    // `adv.diagnostics` header of its own).
    {
        type: "custom",
        id: "adv.diagnosticsPanel",
        labelKey: "diagnostics",
        componentId: "DiagnosticsPanel",
        keywords: ["diagnostics", "report", "debug", "support", "진단", "보고서"],
    },
];

/** The page heading, above the sections. */
export const advancedSettingsHeader: SettingItem[] = itemsById(advancedSettingsItems, ["adv.header", "adv.warn"]);

/** The Advanced page's sections, over `advancedSettingsItems`. */
export const advancedSettingsSections: SettingSection[] = [
    {
        id: "advanced.featureAccess",
        labelKey: "settingsSectionFeatureAccess",
        descriptionKey: "settingsSectionFeatureAccessDesc",
        items: itemsById(advancedSettingsItems, [
            "adv.recoveredChanges",
            "adv.showUnrec",
            "adv.useExp",
            "display.hideApiKey",
        ]),
    },
    {
        id: "advanced.performance",
        labelKey: "settingsSectionPerformanceMedia",
        items: itemsById(advancedSettingsItems, [
            "adv.chatLoadInitial",
            "adv.chatLoadAdditional",
            "adv.assetAlloc",
            "adv.imgComp",
            "adv.legacyMedia",
            "adv.allowExt",
            "adv.dynAssets",
            "adv.dynAssetsEdit",
            "adv.newImgBeta",
            "adv.tokCache",
        ]),
    },
    {
        id: "advanced.requests",
        labelKey: "settingsSectionRequestsTools",
        items: itemsById(advancedSettingsItems, [
            "adv.toolUsage",
            "adv.simpleTool",
            "adv.requestHistoryContent",
            "adv.requestHistoryLimit",
        ]),
    },
    {
        id: "advanced.developer",
        labelKey: "settingsSectionDeveloperDiagnostics",
        descriptionKey: "settingsSectionDeveloperDiagnosticsDesc",
        collapsible: true,
        items: itemsById(advancedSettingsItems, [
            "adv.devTools",
            "adv.promptInfo",
            "adv.promptTextInfo",
            "adv.cssErr",
            "acc.requestInfoInsideChat",
            "acc.inlayErrorResponse",
            "adv.export",
            "adv.diagnosticsPanel",
        ]),
    },
    {
        id: "advanced.experimental",
        labelKey: "settingsSectionExperimental",
        descriptionKey: "settingsSectionExperimentalDesc",
        collapsible: true,
        items: itemsById(advancedSettingsItems, [
            "adv.streamingDisplayOpt",
            "adv.exp.googleToken",
            "adv.exp.cachePoint",
            "adv.exp.claudeRet",
        ]),
    },
    {
        id: "advanced.legacy",
        labelKey: "settingsSectionLegacy",
        descriptionKey: "settingsSectionLegacyDesc",
        collapsible: true,
        items: itemsById(advancedSettingsItems, ["adv.plainFetch", "display.useLegacyGUI"]),
    },
];
