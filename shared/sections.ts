import type { Database } from "./database.ts";
import { PRESET_FIELDS, PRESET_KEEP_ON_SWITCH_FIELDS, PRESET_ROOT_ALIASES, PERSONA_ROOT_ALIASES } from "./presets.ts";

/**
 * The field-to-resource map of Phase 3 (`docs/plan/phases/phase-3-settings-sections.md`): which
 * resource owns each top-level `Database` field. `DBState.db` keeps every field flat under its old
 * name (D3); these lists say where each one is stored. Together with the Phase 1 collections
 * (`PHASE1_FIELDS`) they partition `keyof Database`:
 *
 * - `SECTION_FIELDS`: five singleton section resources.
 * - `COLLECTION_FIELDS`: small collection resources, each holding one field (two for the preset
 *   collections that carry their selection).
 * - `FORWARDED_ROOT_KEYS`: the fields of the removed `root` resource (the working copies before
 *   Phase 3), not stored under their own names. The client forwards them
 *   (`src/ts/storage/forwarding.svelte.ts`): the preset fields to the selected preset, `proxyKey`
 *   to that preset's `llmSecrets.presets` entry, the persona fields to the selected persona, and the
 *   three selection indexes to the per-client selection store. The keep-on-switch preset fields are
 *   `providers` fields and the two auto-suggest fields are `ui` fields; neither is forwarded.
 * - `DROPPED_FIELDS`: no longer persisted (no reader, write-only, migrated, or legacy mirrors).
 */

export const SECTION_KIND = {
    providers: "providers",
    secrets: "secrets",
    llmSecrets: "llmSecrets",
    ui: "ui",
    memoryTranslateMedia: "memoryTranslateMedia",
} as const;

export type SectionKind = (typeof SECTION_KIND)[keyof typeof SECTION_KIND];

export const SECTION_FIELDS = {
    /** Provider and request settings, including the keep-on-switch group and its three toggles. */
    providers: [
        "loreBookToken",
        "additionalPrompt",
        "descriptionPrefix",
        "requestRetrys",
        "useStreaming",
        "usePlainFetch",
        "openrouterMiddleOut",
        "openrouterFallback",
        "nanogptRequestModel",
        "nanogptRequestModelName",
        "nanogptProvider",
        "nanogptUseSubscriptionEndpoint",
        "nanogptSubscriptionState",
        "autofillRequestUrl",
        "generationSeed",
        "newOAIHandle",
        "gptVisionQuality",
        "reverseProxyOobaMode",
        "chainOfThought",
        "genTime",
        "additionalParams",
        "applyAdditionalParamsToAll",
        "ollamaURL",
        "ollamaModel",
        "ollamaModelSource",
        "ollamaInputMode",
        "ollamaRequestFormat",
        "ollamaModelName",
        "ollamaCloudModel",
        "ollamaCloudModelName",
        "ollamaThinkingMode",
        "autoContinueChat",
        "autoContinueMinTokens",
        "removeIncompleteResponse",
        "customTokenizer",
        "useTokenizerCaching",
        "OAIPrediction",
        "vertexRegion",
        "googleClaudeTokenizing",
        "banCharacterset",
        "inlayErrorResponse",
        "antiServerOverloads",
        "automaticCachePoint",
        "claudeRetrivalCaching",
        "claudeBatching",
        "claude1HourCaching",
        "igpPrompt",
        "openAIFlexProcessing",
        "rememberToolUsage",
        "simplifiedToolUse",
        "streamGeminiThoughts",
        "echoMessage",
        "echoDelay",
        "dynamicModelRegistry",
        "seperateParametersByModel",
        "saveSignatures",
        "presetChain",
        "seperateModels",
        "seperateModelsForAxModels",
        "fallbackModels",
        "fallbackWhenBlankResponse",
        "seperateParameters",
        "doNotChangeSeperateModels",
        "doNotChangeFallbackModels",
        "disableSeperateParameterChangeOnPresetChange",
    ],
    /** LLM provider credentials (Decision 6). Client-readable until Phase 5 makes the section write-only; it also holds each preset's `proxyKey` by preset id (`presets`). */
    llmSecrets: [
        "openAIKey",
        "claudeAPIKey",
        "openrouterKey",
        "nanogptKey",
        "mistralKey",
        "cohereAPIKey",
        "ollamaApiKey",
        "novellistAPI",
        "mancerHeader",
        "supaMemoryKey",
        "google",
        "hordeConfig",
        "novelai",
        "vertexPrivateKey",
        "vertexClientEmail",
        "vertexAccessToken",
        "vertexAccessTokenExpires",
        "OaiCompAPIKeys",
    ],
    /** Auxiliary credentials (TTS, image generation, DeepL, embeddings, Google search). Stay client-readable. */
    secrets: [
        "NAIApiKey",
        "elevenLabKey",
        "voyageApiKey",
        "deeplOptions",
        "deeplXOptions",
        "huggingfaceKey",
        "fishSpeechKey",
        "stabilityKey",
        "falToken",
        "hypaCustomSettings",
        "openaiCompatImage",
        "wavespeedImage",
        "googleSearchCredentials",
    ],
    /** Memory, lorebook depth, translation, TTS, and image-generation settings. */
    memoryTranslateMedia: [
        "loreBookDepth",
        "supaMemoryPrompt",
        "translator",
        "autoTranslate",
        "sdProvider",
        "webUiUrl",
        "sdSteps",
        "sdCFG",
        "sdConfig",
        "NAIImgUrl",
        "NAIImgModel",
        "NAII2I",
        "NAIImgConfig",
        "ttsAutoSpeech",
        "emotionPrompt2",
        "voicevoxUrl",
        "supaModelType",
        "useAutoTranslateInput",
        "imageCompression",
        "hypaMemory",
        "hypav2",
        "hypaModel",
        "emotionProcesser",
        "translatorType",
        "translatorInputLanguage",
        "htmlTranslation",
        "removePunctuationHypa",
        "noWaitForTranslate",
        "maxSupaChunkSize",
        "hanuraiTokens",
        "hanuraiSplit",
        "hanuraiEnable",
        "combineTranslation",
        "dynamicAssets",
        "hypaAllocatedTokens",
        "hypaChunkSize",
        "dallEQuality",
        "stabilityModel",
        "stabllityStyle",
        "legacyTranslation",
        "comfyConfig",
        "comfyUiUrl",
        "falModel",
        "falLora",
        "falLoraScale",
        "translateBeforeHTMLFormatting",
        "autoTranslateCachedOnly",
        "hypaV3",
        "useExperimentalGoogleTranslator",
        "playMessageOnTranslateEnd",
        "newImageHandlingBeta",
        "ImagenModel",
        "ImagenImageSize",
        "ImagenAspectRatio",
        "ImagenPersonGeneration",
    ],
    /** Display and interaction preferences, plus `irisDialogue`. */
    ui: [
        "askRemoval",
        "jailbreakToggle",
        "language",
        "zoomsize",
        "customBackground",
        "playMessage",
        "iconsize",
        "theme",
        "waifuWidth",
        "waifuWidth2",
        "swipe",
        "instantRemove",
        "textTheme",
        "customTextTheme",
        "useSayNothing",
        "didFirstSetup",
        "showUnrecommended",
        "useExperimental",
        "roundIcons",
        "textScreenColor",
        "textBorder",
        "textScreenRounded",
        "textScreenBorder",
        "sendWithEnter",
        "fixedChatTextarea",
        "clickToEdit",
        "enableBlockPartialEdit",
        "enableDragPartialEdit",
        "useAutoSuggestions",
        "autoSuggestPrefix",
        "autoSuggestClean",
        "useChatCopy",
        "classicMaxWidth",
        "useChatSticker",
        "useAdditionalAssetsPreview",
        "personaNote",
        "assetWidth",
        "animationSpeed",
        "botSettingAtStart",
        "hideRealm",
        "colorScheme",
        "colorSchemeName",
        "customColorScheme",
        "showMenuChatList",
        "allowAllExtentionFiles",
        "memoryLimitThickness",
        "sideMenuRerollButton",
        "requestInfoInsideChat",
        "heightMode",
        "textAreaSize",
        "sideBarSize",
        "textAreaTextSize",
        "dynamicAssetsEditDisplay",
        "goCharacterOnImport",
        "font",
        "customFont",
        "lineHeight",
        "useLegacyGUI",
        "hideApiKey",
        "unformatQuotes",
        "enableDevTools",
        "customCSS",
        "customQuotes",
        "customQuotesData",
        "guiHTML",
        "notification",
        "assetMaxDifference",
        "auxModelUnderModelSettings",
        "menuSideBar",
        "showSavingIcon",
        "showPromptComparison",
        "realmDirectOpen",
        "bulkEnabling",
        "showTranslationLoading",
        "returnCSSError",
        "localActivationInGlobalLorebook",
        "showFolderName",
        "showMenuHypaMemoryModal",
        "promptInfoInsideChat",
        "promptTextInfoInsideChat",
        "showFirstMessagePages",
        "enableScrollToActiveChar",
        "settingsCloseButtonSize",
        "promptDiffPrefs",
        "enableBookmark",
        "hideAllImages",
        "autoScrollToNewMessage",
        "alwaysScrollToNewMessage",
        "newMessageButtonStyle",
        "chatLoadInitialPages",
        "chatLoadAdditionalPages",
        "streamingDisplayOptimizationMode",
        "createFolderOnBranch",
        "hamburgerButtonBottom",
        "blockquoteStyling",
        "enableRisuaiProTools",
        "epEnabled",
        "keepSessionAlive",
        "longPressToPopupEditor",
        "irisDialogue",
        "legacyMediaFindings",
        "showMemoryLimit",
        "showDeprecatedTriggerV2",
        "moveInsteadOfCopyOnCMPConvert",
        "pluginDevelopMode",
        "memoryAlgorithmType",
        "forceProxyAsOpenAI",
    ],
} as const satisfies Record<SectionKind, readonly (keyof Database)[]>;

export const COLLECTION_KIND = {
    loreBook: "loreBook",
    globalscript: "globalscript",
    hotkeys: "hotkeys",
    customSidebarItems: "customSidebarItems",
    characterOrder: "characterOrder",
    authRefreshes: "authRefreshes",
    globalChatVariables: "globalChatVariables",
    personas: "personas",
    translatorPresets: "translatorPresets",
    hypaV3Presets: "hypaV3Presets",
    customModels: "customModels",
    enabledModules: "enabledModules",
    statics: "statics",
} as const;

export type CollectionKind = (typeof COLLECTION_KIND)[keyof typeof COLLECTION_KIND];

/** The `Database` field each collection resource holds. */
export const COLLECTION_FIELDS = {
    loreBook: "loreBook",
    globalscript: "globalscript",
    hotkeys: "hotkeys",
    customSidebarItems: "customSidebarItems",
    characterOrder: "characterOrder",
    authRefreshes: "authRefreshes",
    globalChatVariables: "globalChatVariables",
    personas: "personas",
    translatorPresets: "translatorPresets",
    hypaV3Presets: "hypaV3Presets",
    customModels: "customModels",
    enabledModules: "enabledModules",
    statics: "statics",
} as const satisfies Record<CollectionKind, keyof Database>;

/**
 * The selection field that travels with a collection: the record is `{ items, selectedId }`, and
 * the mirror unpacks it into these two `Database` names.
 */
export const COLLECTION_SELECTION_FIELDS = {
    translatorPresets: "translatorPresetId",
    hypaV3Presets: "hypaV3PresetId",
} as const satisfies Partial<Record<CollectionKind, keyof Database>>;

const presetRootNames: Record<string, string> = Object.fromEntries(
    Object.entries(PRESET_ROOT_ALIASES).map(([root, preset]) => [preset, root]),
);
const notForwarded = new Set<string>(["name", "image", ...PRESET_KEEP_ON_SWITCH_FIELDS]);

/**
 * Root fields that mirror the selected preset one to one (by their root name): every preset field
 * except `name`, `image`, and the keep-on-switch group. `proxyKey` is forwarded too, to the
 * selected preset's `llmSecrets.presets` entry (`FORWARDED_ROOT_KEYS`).
 */
export const FORWARDED_PRESET_KEYS = PRESET_FIELDS.filter((field) => !notForwarded.has(field)).map(
    (field) => (presetRootNames[field] ?? field) as keyof Database,
);

/** Root fields that mirror the selected persona (`PERSONA_ROOT_ALIASES`). */
export const PERSONA_ROOT_KEYS = Object.keys(PERSONA_ROOT_ALIASES) as (keyof typeof PERSONA_ROOT_ALIASES)[];

/**
 * The per-client selection indexes, served by the selection store
 * (`src/ts/storage/selection.svelte.ts`) and never persisted in a resource.
 */
export const SELECTION_KEYS = [
    "botPresetsId",
    "selectedPersona",
    "loreBookPage",
] as const satisfies readonly (keyof Database)[];

/** The fields the client forwarding layer serves (the old `root` working copies and selections). */
export const FORWARDED_ROOT_KEYS: readonly (keyof Database)[] = [
    ...FORWARDED_PRESET_KEYS,
    "proxyKey",
    ...PERSONA_ROOT_KEYS,
    ...SELECTION_KEYS,
];

/** Fields no longer persisted; the assembly never produces them. */
export const DROPPED_FIELDS = [
    "saveTime",
    "lastPatchNoteCheckVersion",
    "hubServerType",
    "disableAprilFools",
    "geminiStream",
    "claudeAws",
    "falLoraName",
    "fullScreen",
    "NAIREF",
    "customGUI",
    "checkCorruption",
    "toggleConfirmRecommendedPreset",
    "hypaMemoryKey",
    "cipherChat",
    "claudeCachingExperimental",
    "antiClaudeOverload",
    "emotionPrompt",
    "translatorPrompt",
    "translatorMaxResponse",
    "hypaV3Settings",
    "formatversion",
] as const satisfies readonly (keyof Database)[];

/** The Phase 1 collection fields (`presets`, `modules`, `plugins`, `pluginStorage`, `characters`). */
export const PHASE1_FIELDS = [
    "characters",
    "botPresets",
    "modules",
    "plugins",
    "pluginCustomStorage",
] as const satisfies readonly (keyof Database)[];
