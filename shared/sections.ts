import type { Database, ModelPreset, ModelProfile, ModelSlot } from "./database.ts";
import {
    MODEL_PROFILE_FIELDS,
    PERSONA_ROOT_ALIASES,
    PRESET_ROOT_ALIASES,
    presetFieldValue,
    plainClone,
    PROMPT_PRESET_FIELDS,
    type PresetField,
    type ModelProfileField,
} from "./presets.ts";

/**
 * The field-to-resource map: which resource owns each top-level `Database` field (the flat legacy
 * shape the plugin API and the server's job projection keep); these lists say where each one is
 * stored. Together with the per-item collections (`ITEM_RECORD_FIELDS`) they partition `keyof Database`:
 *
 * - `SECTION_FIELDS`: five singleton section resources.
 * - `COLLECTION_FIELDS`: small collection resources, each holding one field (two for the preset
 *   collections that carry their selection).
 * - `FORWARDED_ROOT_KEYS`: the fields of the removed `root` resource (the working copies before
 *   the settings were split into section records), not stored under their own names. The client's
 *   views serve them under those names (`src/ts/storage/settingsViews.svelte.ts`: the prompt fields
 *   from the selected prompt preset, the model ids from the selected model preset's slots, the
 *   profile fields from its main profile, the persona fields from the selected persona); the three
 *   selection indexes come from the per-client selection store. The two auto-suggest fields are
 *   `ui` fields, not forwarded.
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
    /** Provider and request settings outside the presets. */
    providers: [
        "loreBookToken",
        "additionalPrompt",
        "descriptionPrefix",
        "requestRetrys",
        "useStreaming",
        "usePlainFetch",
        "openrouterMiddleOut",
        "openrouterFallback",
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
        "ollamaThinkingMode",
        "autoContinueChat",
        "autoContinueMinTokens",
        "removeIncompleteResponse",
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
        "saveSignatures",
        "presetChain",
        "requestHistoryContent",
        "requestHistoryLimit",
    ],
    /** Write-only LLM provider defaults; named-key values live in the `credentials` entry map. */
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
        "llmTranslationTarget",
        "translatorHistoryMaxTokens",
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
        "chatScreenWidth",
        "useChatSticker",
        "useAdditionalAssetsPreview",
        "personaNote",
        "assetWidth",
        "animationSpeed",
        "botSettingAtStart",
        "hideRealm",
        "blockedRealmCreators",
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
        "menuSideBar",
        "showSavingIcon",
        "showPromptComparison",
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
        "scrollToReplyStartAfterStreaming",
        "newMessageButtonStyle",
        "chatLoadInitialPages",
        "chatLoadAdditionalPages",
        "streamingDisplayOptimizationMode",
        "createFolderOnBranch",
        "newChatBinding",
        "hamburgerButtonBottom",
        "blockquoteStyling",
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
    characterOrder: "characterOrder",
    authRefreshes: "authRefreshes",
    globalChatVariables: "globalChatVariables",
    personas: "personas",
    translatorPresets: "translatorPresets",
    hypaV3Presets: "hypaV3Presets",
    togglePresets: "togglePresets",
    customModels: "customModels",
    credentials: "credentials",
    enabledModules: "enabledModules",
    statics: "statics",
    modelPresets: "modelPresets",
    modelProfiles: "modelProfiles",
} as const;

export type CollectionKind = (typeof COLLECTION_KIND)[keyof typeof COLLECTION_KIND];

/** The `Database` field each collection resource holds. */
export const COLLECTION_FIELDS = {
    loreBook: "loreBook",
    globalscript: "globalscript",
    hotkeys: "hotkeys",
    characterOrder: "characterOrder",
    authRefreshes: "authRefreshes",
    globalChatVariables: "globalChatVariables",
    personas: "personas",
    translatorPresets: "translatorPresets",
    hypaV3Presets: "hypaV3Presets",
    togglePresets: "togglePresets",
    customModels: "customModels",
    credentials: "credentials",
    enabledModules: "enabledModules",
    statics: "statics",
    modelPresets: "modelPresets",
    modelProfiles: "modelProfiles",
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
const presetFieldOfRoot: Record<string, string> = PRESET_ROOT_ALIASES;

/**
 * Root fields that mirror the selected prompt preset one to one (by their root name): every
 * `PROMPT_PRESET_FIELDS` field (`name` and `image` are the record's own).
 */
export const FORWARDED_PRESET_KEYS = PROMPT_PRESET_FIELDS.map(
    (field) => (presetRootNames[field] ?? field) as keyof Database,
);

/** Profile options with legacy root names; record metadata and credential bindings stay on profiles. */
export const MODEL_PROFILE_ROOT_FIELDS = MODEL_PROFILE_FIELDS.filter(
    (field): field is Exclude<ModelProfileField, "modelId" | "credentialId"> =>
        field !== "modelId" && field !== "credentialId",
);

/**
 * Derived model roots: slot model ids and the auxiliary toggle from the preset, and every profile
 * option (including NanoGPT, Ollama, and tokenizer fields) from its main profile. Slots and profile
 * metadata are never forwarded under their stored names.
 */
export const FORWARDED_MODEL_PRESET_KEYS = [
    "aiModel",
    "subModel",
    "seperateModels",
    "seperateModelsForAxModels",
    ...MODEL_PROFILE_ROOT_FIELDS,
] as const satisfies readonly (keyof Database)[];

export type ModelPresetRootKey = (typeof FORWARDED_MODEL_PRESET_KEYS)[number];

/**
 * A detached overlay of profile options, or their schema defaults when no profile is supplied.
 * Both root forwarding and request-local contexts use this, so a bare slot never inherits the
 * main profile's URL, flags, or templates, and adapters cannot mutate a captured profile's containers.
 */
export function forwardProfileRoots(target: Record<string, unknown>, profile: ModelProfile | undefined): void {
    for (const field of MODEL_PROFILE_ROOT_FIELDS) {
        target[field] = plainClone(presetFieldValue(profile as unknown as Record<string, unknown> | undefined, field));
    }
}

/** A stored slot's model id for legacy roots, without request-time auxiliary fallback. */
export function modelIdOfSlot(slot: ModelSlot | undefined, profiles: readonly ModelProfile[]): string {
    if (!slot) {
        return "";
    }
    return "modelId" in slot
        ? slot.modelId
        : (profiles.find((profile) => profile.id === slot.profileId)?.modelId ?? "");
}

/**
 * One derived model root, shared by server projections and the tab's live views. Profile containers
 * remain live here so a nested view write reaches its record; a snapshot caller copies the value.
 */
export function modelPresetRootValue(
    modelPreset: ModelPreset | undefined,
    profiles: readonly ModelProfile[],
    rootKey: ModelPresetRootKey,
): unknown {
    switch (rootKey) {
        case "aiModel":
            return modelIdOfSlot(modelPreset?.mainSlot, profiles);
        case "subModel":
            return modelIdOfSlot(modelPreset?.subSlot, profiles);
        case "seperateModels":
            return Object.fromEntries(
                (["memory", "translate", "emotion", "otherAx"] as const).map((mode) => [
                    mode,
                    modelIdOfSlot(modelPreset?.auxSlots?.[mode], profiles),
                ]),
            );
        case "seperateModelsForAxModels":
            return presetFieldValue(
                modelPreset as unknown as Record<string, unknown> | undefined,
                "seperateModelsForAxModels",
            );
        default: {
            const profile = profiles.find((entry) => entry.id === modelPreset?.mainSlot?.profileId);
            return presetFieldValue(profile as unknown as Record<string, unknown> | undefined, rootKey);
        }
    }
}

/**
 * The legacy roots for the selected records: prompt fields, the preset's slot model ids and
 * auxiliary toggle, and its main profile's options (`presetFieldValue`'s defaults when missing).
 * A dangling or unset slot reads as an empty model id; auxiliary roots describe the stored choices
 * regardless of the toggle. The server's job projection and request settings share these rules.
 * The prompt preset's context size override (`maxContextOverrideOf`) replaces the main profile's
 * `maxContext`.
 */
export function forwardPresetRoots(
    target: Record<string, unknown>,
    promptPreset: Record<string, unknown>,
    modelPreset: ModelPreset,
    profiles: readonly ModelProfile[],
) {
    for (const rootKey of FORWARDED_PRESET_KEYS) {
        target[rootKey] = presetFieldValue(promptPreset, (presetFieldOfRoot[rootKey] ?? rootKey) as PresetField);
    }
    for (const rootKey of FORWARDED_MODEL_PRESET_KEYS) {
        target[rootKey] = plainClone(modelPresetRootValue(modelPreset, profiles, rootKey));
    }
    const override = maxContextOverrideOf(promptPreset);
    if (override !== undefined) {
        target.maxContext = override;
    }
}

/**
 * The prompt preset's main-model context size (`maxContextOverride` on and a finite
 * `maxContextOverrideSize` above 0, which is unset), or `undefined` when the main profile's
 * `maxContext` applies. Reads a prompt preset record or any object carrying the two fields under
 * their root names (a job or request database).
 */
export function maxContextOverrideOf(promptPreset: Record<string, unknown> | undefined): number | undefined {
    if (presetFieldValue(promptPreset, "maxContextOverride") !== true) {
        return undefined;
    }
    const size = presetFieldValue(promptPreset, "maxContextOverrideSize");
    return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : undefined;
}

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
    ...FORWARDED_MODEL_PRESET_KEYS,
    ...PERSONA_ROOT_KEYS,
    ...SELECTION_KEYS,
];

/**
 * Fields no longer persisted or forwarded, including retired inline keys and the legacy binding
 * name removed from `Database`. Never list the same root twice in the partition.
 */
export const DROPPED_FIELDS = [
    "apiType",
    "modelCredentials",
    "proxyCredentialId",
    "proxyKey",
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
    "realmDirectOpen",
    "auxModelUnderModelSettings",
    "htmlTranslation",
    "autoTranslate",
] as const satisfies readonly (keyof Database | "modelCredentials")[];

/** The per-item collection fields (`presets`, `modules`, `plugins`, `pluginStorage`, `characters`). */
export const ITEM_RECORD_FIELDS = [
    "characters",
    "botPresets",
    "modules",
    "plugins",
    "pluginCustomStorage",
] as const satisfies readonly (keyof Database)[];
