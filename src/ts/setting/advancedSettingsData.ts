import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";

export const advancedSettingsItems: SettingItem[] = [
    { type: "header", id: "adv.header", labelKey: "advancedSettings", options: { level: "h2" }, classes: "!mb-0" },
    { type: "header", id: "adv.warn", labelKey: "advancedSettingsWarn", options: { level: "warning" } },

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
        classes: "mt-4",
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
        classes: "mt-4",
    },
    {
        id: "adv.imgComp",
        type: "check",
        labelKey: "imageCompression",
        bindKey: "imageCompression",
        helpKey: "imageCompression",
        classes: "mt-4",
    },
    {
        id: "adv.useExp",
        type: "check",
        labelKey: "useExperimental",
        bindKey: "useExperimental",
        helpKey: "useExperimental",
        classes: "mt-4",
    },
    // From Display (settings UI plan slice 7)
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
        classes: "mt-4",
    },
    {
        id: "adv.streamingDisplayOpt",
        type: "segmented",
        labelKey: "streamingDisplayOptimizationMode",
        bindKey: "streamingDisplayOptimizationMode",
        helpKey: "streamingDisplayOptimizationMode",
        condition: (ctx) => ctx.settings.ui.useExperimental,
        showExperimental: true,
        classes: "mt-4",
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
        classes: "mt-4",
    },
    {
        id: "adv.allowExt",
        type: "check",
        fallbackLabel: "Allow all in file select",
        bindKey: "allowAllExtentionFiles",
        classes: "mt-4",
    },
    {
        id: "adv.requestHistoryContent",
        type: "check",
        labelKey: "requestHistoryContent",
        bindKey: "requestHistoryContent",
        helpKey: "requestHistoryContent",
        classes: "mt-4",
    },
    {
        id: "adv.requestHistoryLimit",
        type: "number",
        labelKey: "requestHistoryLimit",
        bindKey: "requestHistoryLimit",
        helpKey: "requestHistoryLimit",
        options: { min: 10, max: 10000 },
        classes: "mt-4",
    },

    // Experimental Section (visible when useExperimental is true)
    {
        id: "adv.exp.googleToken",
        type: "check",
        labelKey: "googleCloudTokenization",
        bindKey: "googleClaudeTokenizing",
        condition: (ctx) => ctx.settings.ui.useExperimental,
        showExperimental: true,
        classes: "mt-4",
    },
    {
        id: "adv.exp.cachePoint",
        type: "check",
        labelKey: "automaticCachePoint",
        bindKey: "automaticCachePoint",
        condition: (ctx) => ctx.settings.ui.useExperimental,
        helpKey: "automaticCachePoint",
        showExperimental: true,
        classes: "mt-4",
    },
    // More Toggles
    { id: "adv.devTools", type: "check", labelKey: "enableDevTools", bindKey: "enableDevTools", classes: "mt-4" },

    // Node Specific
    {
        id: "adv.promptInfo",
        type: "check",
        labelKey: "promptInfoInsideChat",
        bindKey: "promptInfoInsideChat",
        helpKey: "promptInfoInsideChatDesc",
        classes: "mt-4",
    },
    {
        id: "adv.promptTextInfo",
        type: "check",
        labelKey: "promptTextInfoInsideChat",
        bindKey: "promptTextInfoInsideChat",
        condition: (ctx) => ctx.settings.ui.promptInfoInsideChat,
        classes: "mt-4",
    },

    // Dynamic Assets & Others
    {
        id: "adv.dynAssets",
        type: "check",
        labelKey: "dynamicAssets",
        bindKey: "dynamicAssets",
        helpKey: "dynamicAssets",
        classes: "mt-4",
    },
    { id: "adv.cssErr", type: "check", labelKey: "returnCSSError", bindKey: "returnCSSError", classes: "mt-4" },
    // From Accessibility (settings UI plan slice 5), with Advanced's spacing.
    {
        id: "acc.requestInfoInsideChat",
        type: "check",
        labelKey: "requestInfoInsideChat",
        bindKey: "requestInfoInsideChat",
        keywords: ["request", "info", "chat"],
        classes: "mt-4",
    },
    {
        id: "acc.inlayErrorResponse",
        type: "check",
        labelKey: "inlayErrorResponse",
        bindKey: "inlayErrorResponse",
        keywords: ["inlay", "error", "response"],
        classes: "mt-4",
    },
    {
        id: "adv.toolUsage",
        type: "check",
        labelKey: "rememberToolUsage",
        bindKey: "rememberToolUsage",
        classes: "mt-4",
    },
    {
        id: "adv.simpleTool",
        type: "check",
        labelKey: "simplifiedToolUse",
        bindKey: "simplifiedToolUse",
        classes: "mt-4",
    },
    {
        id: "adv.tokCache",
        type: "check",
        labelKey: "useTokenizerCaching",
        bindKey: "useTokenizerCaching",
        classes: "mt-4",
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
        classes: "mt-4",
    },

    // Dynamic Assets Edit (Condition: dynamicAssets)
    {
        id: "adv.dynAssetsEdit",
        type: "check",
        labelKey: "dynamicAssetsEditDisplay",
        bindKey: "dynamicAssetsEditDisplay",
        condition: (ctx) => ctx.settings.memoryTranslateMedia.dynamicAssets,
        helpKey: "dynamicAssetsEditDisplay",
        classes: "mt-4",
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
        classes: "mt-4",
    },
    // From Display (settings UI plan slice 7)
    {
        id: "display.useLegacyGUI",
        type: "check",
        labelKey: "useLegacyGUI",
        bindKey: "useLegacyGUI",
        keywords: ["legacy", "gui"],
    },

    { type: "custom", id: "adv.export", componentId: "SettingsExportButtons" },

    // Diagnostics (docs/plan/request-history-diagnostics.md slice 9); the "Developer & diagnostics"
    // section is its heading (its own `adv.diagnostics` header went with settings UI plan slice 2).
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

/** The Advanced page's sections (archived, `docs/archived-plan/README.md`, slice 2), over `advancedSettingsItems`. */
export const advancedSettingsSections: SettingSection[] = [
    {
        id: "advanced.featureAccess",
        labelKey: "settingsSectionFeatureAccess",
        descriptionKey: "settingsSectionFeatureAccessDesc",
        items: itemsById(advancedSettingsItems, ["adv.showUnrec", "adv.useExp", "display.hideApiKey"]),
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
