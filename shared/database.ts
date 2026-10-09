// Persisted shapes of the database, characters, chats, and presets. Both the client and the server
// compile this folder: keep it free of DOM types, runes, enums, and non-relative imports (see
// `persistence.md`). Never rename persisted keys (STRUCTURE D3).

import type { LLMFlags, LLMFormat, LLMTokenizer } from "./llm.ts";
import type {
    HypaModel,
    HypaV3Preset,
    HypaV3Settings,
    SerializableHypaV2Data,
    SerializableHypaV3Data,
} from "./memory.ts";
import type { ToolCallRecord } from "./llm/request.ts";
import type { RisuModule } from "./modules.ts";
import type { DeepReadonly } from "./readonly.ts";
import type { OpenAIChat } from "./openai.ts";
import type { RisuPlugin } from "./plugins.ts";
import type { PromptItem, PromptSettings } from "./prompt.ts";
import type {
    ColorScheme,
    Hotkey,
    NAISettings,
    OnnxModelFiles,
    OobaChatCompletionRequestParams,
    TranslatorPreset,
} from "./settings.ts";
import type { triggerscript } from "./triggers.ts";

export type StreamingDisplayOptimizationMode = "off" | "balanced" | "strong";

/** The named LLM credential types, shared with the server's collection normalizer. */
export const CREDENTIAL_TYPES = [
    "openai",
    "anthropic",
    "bedrock",
    "google",
    "vertex",
    "openrouter",
    "nanogpt",
    "mistral",
    "cohere",
    "ollama",
    "novelai",
    "custom",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/** Readable credential metadata; its value is in `llmSecrets.credentials.<id>.key`. */
export type Credential = { id: string; name: string } & (
    | { type: "vertex"; clientEmail?: string; projectId?: string }
    | { type: Exclude<CredentialType, "vertex">; clientEmail?: never; projectId?: never }
);

export interface DynamicOutput {
    autoAdjustSchema: boolean;
    dynamicMessages: boolean;
    dynamicMemory: boolean;
    dynamicResponseTiming: boolean;
    dynamicOutputPrompt: boolean;
    showTypingEffect: boolean;
    dynamicRequest: boolean;
}

/** A custom model (`CustomModelsSettings.svelte`); its key is a write-only `llmSecrets` credential. */
export interface CustomModel {
    id: string;
    credentialId?: string;
    internalId: string;
    url: string;
    format: LLMFormat;
    tokenizer: LLMTokenizer;
    name: string;
    params: string;
    flags: LLMFlags[];
}

export interface RisuPersona {
    personaPrompt: string;
    name: string;
    icon: string;
    largePortrait?: boolean;
    /** Assigned at creation (`newPersonaId`); chats bind to it (`Chat.bindedPersona`). */
    id: string;
    note?: string;
    embeddedModule?: RisuModule;
}

export interface Database {
    characters: (character | groupChat)[];
    apiType: string;
    openAIKey: string;
    proxyKey: string;
    proxyCredentialId?: string;
    mainPrompt: string;
    jailbreak: string;
    globalNote: string;
    temperature: number;
    askRemoval: boolean;
    maxContext: number;
    maxResponse: number;
    frequencyPenalty: number;
    PresensePenalty: number;
    formatingOrder: FormatingOrderItem[];
    aiModel: string;
    jailbreakToggle: boolean;
    loreBookDepth: number;
    loreBookToken: number;
    cipherChat: boolean;
    loreBook: {
        name: string;
        data: loreBook[];
    }[];
    loreBookPage: number;
    supaMemoryPrompt: string;
    username: string;
    userIcon: string;
    userNote: string;
    additionalPrompt: string;
    descriptionPrefix: string;
    forceReplaceUrl: string;
    language: string;
    translator: string;
    plugins: RisuPlugin[];
    currentPluginProvider: string;
    zoomsize: number;
    customBackground: string;
    textgenWebUIStreamURL: string;
    textgenWebUIBlockingURL: string;
    autoTranslate: boolean;
    fullScreen: boolean;
    playMessage: boolean;
    iconsize: number;
    theme: string;
    subModel: string;
    emotionPrompt: string;
    formatversion: number;
    waifuWidth: number;
    waifuWidth2: number;
    /** The prompt presets (`presets` resource); the selected one per client is `botPresetsId`. */
    botPresets: botPreset[];
    botPresetsId: number;
    /** The model presets (`modelPresets` collection, `docs/plan/split-preset.md`), selected per client. */
    modelPresets: ModelPreset[];
    sdProvider: string;
    webUiUrl: string;
    sdSteps: number;
    sdCFG: number;
    sdConfig: sdConfig;
    NAIImgUrl: string;
    NAIApiKey: string;
    NAIImgModel: string;
    NAII2I: boolean;
    NAIREF: boolean;
    NAIImgConfig: NAIImgConfig;
    ttsAutoSpeech?: boolean;
    promptPreprocess: boolean;
    bias: [string, number][];
    swipe: boolean;
    instantRemove: boolean;
    textTheme: string;
    customTextTheme: {
        FontColorStandard: string;
        FontColorBold: string;
        FontColorItalic: string;
        FontColorItalicBold: string;
        FontColorQuote1: string;
        FontColorQuote2: string;
    };
    requestRetrys: number;
    localNetworkMode: boolean;
    localNetworkTimeoutSec: number;
    emotionPrompt2: string;
    useSayNothing: boolean;
    didFirstSetup: boolean;
    showUnrecommended: boolean;
    elevenLabKey: string;
    voicevoxUrl: string;
    useExperimental: boolean;
    showMemoryLimit: boolean;
    roundIcons: boolean;
    useStreaming: boolean;
    supaMemoryKey: string;
    hypaMemoryKey: string;
    voyageApiKey: string;
    supaModelType: string;
    textScreenColor?: string;
    textBorder?: boolean;
    textScreenRounded?: boolean;
    textScreenBorder?: string;
    characterOrder: (string | folder)[];
    hordeConfig: hordeConfig;
    novelai: {
        token: string;
        model: string;
    };
    globalscript: customscript[];
    sendWithEnter: boolean;
    fixedChatTextarea: boolean;
    clickToEdit: boolean;
    enableBlockPartialEdit: boolean;
    enableDragPartialEdit: boolean;
    koboldURL: string;
    useAutoSuggestions: boolean;
    autoSuggestPrompt: string;
    autoSuggestPrefix: string;
    autoSuggestClean: boolean;
    claudeAPIKey: string;
    useChatCopy: boolean;
    novellistAPI: string;
    useAutoTranslateInput: boolean;
    imageCompression: boolean;
    classicMaxWidth: boolean;
    chatScreenWidth: number;
    useChatSticker: boolean;
    useAdditionalAssetsPreview: boolean;
    usePlainFetch: boolean;
    hypaMemory: boolean;
    hypav2: boolean;
    memoryAlgorithmType: string; // To enable new memory module/algorithms
    proxyRequestModel: string;
    ooba: OobaSettings;
    ainconfig: AINsettings;
    personaPrompt: string;
    openrouterRequestModel: string;
    openrouterKey: string;
    openrouterMiddleOut: boolean;
    nanogptKey: string;
    nanogptRequestModel: string;
    nanogptRequestModelName: string;
    nanogptProvider: string;
    nanogptSubscriptionState: string;
    nanogptUseSubscriptionEndpoint: boolean;
    openrouterFallback: boolean;
    selectedPersona: number;
    personas: RisuPersona[];
    personaNote: boolean;
    assetWidth: number;
    animationSpeed: number;
    botSettingAtStart: false;
    NAIsettings: NAISettings;
    hideRealm: boolean;
    colorScheme: ColorScheme;
    colorSchemeName: string;
    customColorScheme: ColorScheme;
    promptTemplate?: PromptItem[];
    forceProxyAsOpenAI?: boolean;
    hypaModel: HypaModel;
    saveTime?: number;
    mancerHeader: string;
    emotionProcesser: "submodel" | "embedding";
    showMenuChatList?: boolean;
    translatorType: "google" | "deepl" | "none" | "llm" | "deeplX" | "bergamot";
    translatorInputLanguage?: string;
    htmlTranslation?: boolean;
    NAIadventure?: boolean;
    NAIappendName?: boolean;
    deeplOptions: {
        key: string;
        freeApi: boolean;
    };
    deeplXOptions: {
        url: string;
        token: string;
    };
    localStopStrings?: string[];
    autofillRequestUrl: boolean;
    customProxyRequestModel: string;
    generationSeed: number;
    newOAIHandle: boolean;
    gptVisionQuality: string;
    reverseProxyOobaMode: boolean;
    reverseProxyOobaArgs: OobaChatCompletionRequestParams;
    huggingfaceKey: string;
    fishSpeechKey: string;
    allowAllExtentionFiles?: boolean;
    translatorPrompt: string;
    translatorMaxResponse: number;
    translatorPresets: TranslatorPreset[];
    /** The selected `translatorPresets` entry, by id (travels in the `translatorPresets` record). */
    translatorPresetId: string;
    top_p: number;
    google: {
        accessToken: string;
        projectId: string;
    };
    mistralKey?: string;
    chainOfThought?: boolean;
    genTime: number;
    promptSettings: PromptSettings;
    top_k: number;
    repetition_penalty: number;
    min_p: number;
    top_a: number;
    claudeAws: boolean;
    lastPatchNoteCheckVersion?: string;
    removePunctuationHypa?: boolean;
    memoryLimitThickness?: number;
    modules: RisuModule[];
    enabledModules: string[];
    sideMenuRerollButton?: boolean;
    requestInfoInsideChat?: boolean;
    additionalParams: [string, string][];
    applyAdditionalParamsToAll: boolean;
    heightMode: string;
    noWaitForTranslate: boolean;
    antiClaudeOverload: boolean;
    maxSupaChunkSize: number;
    ollamaURL: string;
    ollamaModel: string;
    ollamaModelSource: "local" | "cloud";
    ollamaInputMode: "list" | "manual";
    ollamaRequestFormat: LLMFormat;
    ollamaApiKey: string;
    ollamaModelName: string;
    ollamaCloudModel: string;
    ollamaCloudModelName: string;
    ollamaThinkingMode: "auto" | "off" | "on" | "low" | "medium" | "high";
    autoContinueChat: boolean;
    autoContinueMinTokens: number;
    removeIncompleteResponse: boolean;
    customTokenizer: string;
    instructChatTemplate: string;
    JinjaTemplate: string;
    openrouterProvider: {
        order: string[];
        only: string[];
        ignore: string[];
    };
    useInstructPrompt: boolean;
    hanuraiTokens: number;
    hanuraiSplit: boolean;
    hanuraiEnable: boolean;
    textAreaSize: number;
    sideBarSize: number;
    textAreaTextSize: number;
    combineTranslation: boolean;
    dynamicAssets: boolean;
    dynamicAssetsEditDisplay: boolean;
    customPromptTemplateToggle: string;
    globalChatVariables: { [key: string]: string };
    templateDefaultVariables: string;
    hypaAllocatedTokens: number;
    hypaChunkSize: number;
    cohereAPIKey: string;
    goCharacterOnImport: boolean;
    dallEQuality: string;
    font: string;
    customFont: string;
    lineHeight: number;
    stabilityModel: string;
    stabilityKey: string;
    stabllityStyle: string;
    legacyTranslation: boolean;
    comfyConfig: ComfyConfig;
    comfyUiUrl: string;
    useLegacyGUI: boolean;
    claudeCachingExperimental: boolean;
    hideApiKey: boolean;
    unformatQuotes: boolean;
    enableDevTools: boolean;
    falToken: string;
    falModel: string;
    falLora: string;
    falLoraName: string;
    falLoraScale: number;
    moduleIntergration: string;
    customCSS: string;
    jsonSchemaEnabled: boolean;
    jsonSchema: string;
    strictJsonSchema: boolean;
    extractJson: string;
    statics: {
        messages: number;
        imports: number;
    };
    customQuotes: boolean;
    customQuotesData?: [string, string, string, string];
    groupTemplate?: string;
    groupOtherBotRole?: string;
    customGUI: string;
    guiHTML: string;
    OAIPrediction: string;
    customAPIFormat: LLMFormat;
    systemContentReplacement: string;
    systemRoleReplacement: "user" | "assistant";
    vertexPrivateKey: string;
    vertexClientEmail: string;
    vertexAccessToken: string;
    vertexAccessTokenExpires: number;
    vertexRegion: string;
    /** The removed per-role parameters: kept for saved data and preset files, never read. */
    seperateParametersEnabled: boolean;
    seperateParameters: {
        memory: SeparateParameters;
        emotion: SeparateParameters;
        translate: SeparateParameters;
        otherAx: SeparateParameters;
        /** The removed per-model parameters: kept for saved data and preset files, never read. */
        overrides: Record<string, SeparateParameters>;
    };
    translateBeforeHTMLFormatting: boolean;
    autoTranslateCachedOnly: boolean;
    notification: boolean;
    customFlags: LLMFlags[];
    enableCustomFlags: boolean;
    googleClaudeTokenizing: boolean;
    presetChain: string;
    legacyMediaFindings?: boolean;
    geminiStream?: boolean;
    assetMaxDifference: number;
    auxModelUnderModelSettings: boolean; // legacy
    menuSideBar: boolean;
    showSavingIcon: boolean;
    presetRegex: customscript[];
    banCharacterset: string[];
    showPromptComparison: boolean;
    hypaV3: boolean;
    hypaV3Settings: HypaV3Settings; // legacy
    hypaV3Presets: HypaV3Preset[];
    /** The selected `hypaV3Presets` entry, by id (travels in the `hypaV3Presets` record). */
    hypaV3PresetId: string;
    realmDirectOpen: boolean; // legacy
    OaiCompAPIKeys: { [key: string]: string };
    inlayErrorResponse: boolean;
    reasoningEffort: number;
    bulkEnabling: boolean;
    showTranslationLoading: boolean;
    showDeprecatedTriggerV2: boolean;
    returnCSSError: boolean;
    checkCorruption?: boolean;
    toggleConfirmRecommendedPreset?: boolean;
    useExperimentalGoogleTranslator: boolean;
    thinkingTokens: number;
    thinkingType: "off" | "budget" | "adaptive";
    deepseekThinkingType: "off" | "enabled";
    adaptiveThinkingEffort: "low" | "medium" | "high" | "xhigh" | "max";
    deepseekReasoningEffort: "high" | "max";
    antiServerOverloads: boolean;
    hypaCustomSettings: {
        url: string;
        key: string;
        model: string;
    };
    localActivationInGlobalLorebook: boolean;
    showFolderName: boolean;
    automaticCachePoint: boolean;
    claudeRetrivalCaching: boolean;
    outputImageModal: boolean;
    playMessageOnTranslateEnd: boolean;
    seperateModelsForAxModels: boolean;
    seperateModels: {
        memory: string;
        emotion: string;
        translate: string;
        otherAx: string;
    };
    modelTools: string[];
    hotkeys: Hotkey[];
    /** The custom models; each one's key is in `llmSecrets.customModels.<id>.key` (Phase 5 slice 7b). */
    customModels: CustomModel[];
    credentials: Credential[];
    /** Catalogue model ids bound to named credentials; absent bindings use the existing defaults. */
    modelCredentials: Record<string, string>;
    igpPrompt: string;
    useTokenizerCaching: boolean;
    showMenuHypaMemoryModal: boolean;
    authRefreshes: {
        url: string;
        tokenUrl: string;
        refreshToken: string;
        clientId: string;
        clientSecret: string;
    }[];
    promptInfoInsideChat: boolean;
    promptTextInfoInsideChat: boolean;
    openAIFlexProcessing: boolean;
    claudeBatching: boolean;
    claude1HourCaching: boolean;
    rememberToolUsage: boolean;
    simplifiedToolUse: boolean;
    newImageHandlingBeta?: boolean;
    showFirstMessagePages: boolean;
    streamGeminiThoughts: boolean;
    verbosity: number;
    dynamicOutput?: DynamicOutput;
    hubServerType?: string;
    pluginCustomStorage: { [key: string]: any };
    ImagenModel: string;
    ImagenImageSize: string;
    ImagenAspectRatio: string;
    ImagenPersonGeneration: string;
    enableScrollToActiveChar: boolean;
    openaiCompatImage: {
        url: string;
        key: string;
        model: string;
        size: string;
        quality: string;
    };
    wavespeedImage: {
        key: string;
        model: string;
        loras: Array<{ path: string; scale: number }>;
        reference_mode: string;
        reference_image: string;
        reference_base64image: string;
    };
    settingsCloseButtonSize: number;
    promptDiffPrefs: PromptDiffPrefs;
    enableBookmark?: boolean;
    hideAllImages?: boolean;
    autoScrollToNewMessage?: boolean;
    alwaysScrollToNewMessage?: boolean;
    newMessageButtonStyle?: string;
    chatLoadInitialPages?: number;
    chatLoadAdditionalPages?: number;
    streamingDisplayOptimizationMode?: StreamingDisplayOptimizationMode;
    pluginDevelopMode?: boolean;
    echoMessage?: string;
    echoDelay?: number;
    createFolderOnBranch?: boolean;
    hamburgerButtonBottom?: boolean;
    /** The Iris help dialogue (`IrisModal.svelte`); absent until the first line is saved. */
    irisDialogue?: { speaker: string; text: string; tip?: string }[];
    /** Google Custom Search credentials of the internal MCP client; absent until entered. */
    googleSearchCredentials?: { apiKey: string; searchEngineId: string };
    blockquoteStyling?: boolean;
    dynamicModelRegistry?: boolean;
    saveSignatures?: boolean;
    keepSessionAlive: "off" | "pip" | "sound";
    longPressToPopupEditor?: boolean;
    disableAprilFools?: boolean;
    moveInsteadOfCopyOnCMPConvert?: boolean;
}

export interface SeparateParameters {
    temperature?: number;
    top_k?: number;
    repetition_penalty?: number;
    min_p?: number;
    top_a?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    reasoning_effort?: number;
    thinking_tokens?: number;
    thinking_type?: "off" | "budget" | "adaptive";
    deepseek_thinking_type?: "off" | "enabled";
    adaptive_thinking_effort?: "low" | "medium" | "high" | "xhigh" | "max";
    deepseek_reasoning_effort?: "high" | "max";
    outputImageModal?: boolean;
    verbosity?: number;
}

type OutputModal = "image" | "audio" | "video";

export interface customscript {
    comment: string;
    in: string;
    out: string;
    type: string;
    flag?: string;
    ableFlag?: boolean;
}

export type { triggerscript };

export interface loreBook {
    key: string;
    secondkey: string;
    insertorder: number;
    comment: string;
    content: string;
    mode: "multiple" | "constant" | "normal" | "child" | "folder";
    alwaysActive: boolean;
    selective: boolean;
    extentions?: {
        risu_case_sensitive: boolean;
    };
    activationPercent?: number;
    loreCache?: {
        key: string;
        data: string[];
    };
    useRegex?: boolean;
    bookVersion?: number;
    id?: string;
    folder?: string;
}

export interface character {
    type?: "character";
    name: string;
    image?: string;
    firstMessage: string;
    desc: string;
    notes: string;
    /** The chat mirror: change it through the chat module (`chatStore.svelte.ts`), never directly. */
    readonly chats: readonly DeepReadonly<Chat>[];
    chatFolders: ChatFolder[];
    /** Derived from this tab's selected chat id; select with `selectChat`. */
    readonly chatPage: number;
    viewScreen: "emotion" | "none" | "imggen";
    bias: [string, number][];
    emotionImages: [string, string][];
    globalLore: loreBook[];
    chaId: string;
    sdData: [string, string][];
    newGenData?: {
        prompt: string;
        negative: string;
        instructions: string;
        emotionInstructions: string;
    };
    customscript: customscript[];
    triggerscript: triggerscript[];
    utilityBot: boolean;
    exampleMessage: string;
    removedQuotes?: boolean;
    creatorNotes: string;
    systemPrompt: string;
    postHistoryInstructions: string;
    alternateGreetings: string[];
    tags: string[];
    creator: string;
    characterVersion: string;
    personality: string;
    scenario: string;
    firstMsgIndex: number;
    loreSettings?: loreSettings;
    loreExt?: any;
    additionalData?: {
        tag?: string[];
        creator?: string;
        character_version?: string;
    };
    ttsMode?: string;
    ttsSpeech?: string;
    voicevoxConfig?: {
        speaker?: string;
        SPEED_SCALE?: number;
        PITCH_SCALE?: number;
        INTONATION_SCALE?: number;
        VOLUME_SCALE?: number;
    };
    naittsConfig?: {
        customvoice?: boolean;
        voice?: string;
        version?: string;
    };
    gptSoVitsConfig?: {
        url?: string;
        use_auto_path?: boolean;
        ref_audio_path?: string;
        use_long_audio?: boolean;
        ref_audio_data?: {
            fileName: string;
            assetId: string;
        };
        volume?: number;
        text_lang?:
            "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko";
        text?: string;
        use_prompt?: boolean;
        prompt?: string | null;
        prompt_lang?:
            "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko";
        top_p?: number;
        temperature?: number;
        speed?: number;
        top_k?: number;
        text_split_method?: "cut0" | "cut1" | "cut2" | "cut3" | "cut4" | "cut5";
    };
    fishSpeechConfig?: {
        model?: {
            _id: string;
            title: string;
            description: string;
        };
        chunk_length: number;
        normalize: boolean;
    };
    supaMemory?: boolean;
    additionalAssets?: [string, string, string][];
    ttsReadOnlyQuoted?: boolean;
    replaceGlobalNote: string;
    backgroundHTML?: string;
    reloadKeys?: number;
    backgroundCSS?: string;
    license?: string;
    private?: boolean;
    additionalText: string;
    oaiVoice?: string;
    oaiTTSConfig?: {
        /** User opted into advanced OpenAI-compatible settings. When false/absent,
         *  tts.ts ignores the other fields and uses the legacy oaiVoice + db.openAIKey path. */
        enabled?: boolean;
        /** Base URL, trailing slash trimmed at runtime. Falls back to 'https://api.openai.com/v1'. */
        baseURL?: string;
        /** Per-character API key. Falls back to db.openAIKey; the Authorization header is omitted entirely when both are empty. */
        apiKey?: string;
        /** Model ID. Falls back to 'tts-1'. */
        model?: string;
        /** Freeform voice ID for custom endpoints. Falls back to character.oaiVoice, then to 'alloy'. */
        voice?: string;
        /** Response format. Falls back to 'mp3'. */
        format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
    };
    scriptstate?: { [key: string]: string | number | boolean };
    depth_prompt?: { depth: number; prompt: string };
    extentions?: { [key: string]: any };
    largePortrait?: boolean;
    lorePlus?: boolean;
    inlayViewScreen?: boolean;
    hfTTS?: {
        model: string;
        language: string;
    };
    vits?: OnnxModelFiles;
    imported?: boolean;
    trashTime?: number;
    nickname?: string;
    source?: string[];
    group_only_greetings?: string[];
    creation_date?: number;
    modification_date?: number;
    ccAssets?: Array<{
        type: string;
        uri: string;
        name: string;
        ext: string;
    }>;
    defaultVariables?: string;
    lowLevelAccess?: boolean;
    hideChatIcon?: boolean;
    lastInteraction?: number;
    translatorNote?: string;
    doNotChangeSeperateModels?: boolean;
    escapeOutput?: boolean;
    prebuiltAssetCommand?: boolean;
    prebuiltAssetStyle?: string;
    prebuiltAssetExclude?: string[];
    modules?: string[];
    moduleNamespace?: string;
    customModuleToggle?: string;
}

export interface loreSettings {
    tokenBudget: number;
    scanDepth: number;
    recursiveScanning: boolean;
    fullWordMatching?: boolean;
}

export interface groupChat {
    type: "group";
    image?: string;
    firstMessage: string;
    /** The chat mirror: change it through the chat module (`chatStore.svelte.ts`), never directly. */
    readonly chats: readonly DeepReadonly<Chat>[];
    chatFolders: ChatFolder[];
    /** Derived from this tab's selected chat id; select with `selectChat`. */
    readonly chatPage: number;
    name: string;
    viewScreen: "single" | "multiple" | "none" | "emp";
    characters: string[];
    characterTalks: number[];
    characterActive: boolean[];
    globalLore: loreBook[];
    autoMode: boolean;
    useCharacterLore: boolean;
    emotionImages: [string, string][];
    customscript: customscript[];
    chaId: string;
    alternateGreetings?: string[];
    creatorNotes?: string;
    removedQuotes?: boolean;
    firstMsgIndex?: number;
    loreSettings?: loreSettings;
    supaMemory?: boolean;
    ttsMode?: string;
    suggestMessages?: string[];
    orderByOrder?: boolean;
    backgroundHTML?: string;
    reloadKeys?: number;
    backgroundCSS?: string;
    oneAtTime?: boolean;
    lorePlus?: boolean;
    trashTime?: number;
    nickname?: string;
    defaultVariables?: string;
    lowLevelAccess?: boolean;
    hideChatIcon?: boolean;
    lastInteraction?: number;

    //lazy hack for typechecking
    voicevoxConfig?: any;
    ttsSpeech?: string;
    naittsConfig?: any;
    oaiVoice?: string;
    oaiTTSConfig?: any;
    hfTTS?: any;
    vits?: OnnxModelFiles;
    gptSoVitsConfig?: any;
    fishSpeechConfig?: any;
    ttsReadOnlyQuoted?: boolean;
    exampleMessage?: string;
    systemPrompt?: string;
    replaceGlobalNote?: string;
    additionalText?: string;
    personality?: string;
    scenario?: string;
    translatorNote?: string;
    additionalData?: any;
    depth_prompt?: { depth: number; prompt: string };
    additionalAssets?: [string, string, string][];
    utilityBot?: boolean;
    license?: string;
    prebuiltAssetCommand?: boolean;
    prebuiltAssetStyle?: string;
    prebuiltAssetExclude?: string[];
    modules?: string[];
}

/**
 * A prompt preset (the `presets` resource; `docs/plan/split-preset.md`). It stores only the
 * prompt-owned fields (`PROMPT_PRESET_FIELDS`) and `name`/`image`; the model fields below
 * (`MODEL_PRESET_FIELDS`) are read only from old files and imports, and `normalizePreset` drops them.
 */
export interface botPreset {
    /** Assigned at creation (`normalizePreset`, `shared/presets.ts`); stripped from `.risup` exports. */
    id: string;
    name?: string;
    apiType?: string;
    openAIKey?: string;
    proxyCredentialId?: string;
    localNetworkMode?: boolean;
    localNetworkTimeoutSec?: number;
    mainPrompt: string;
    jailbreak: string;
    globalNote: string;
    temperature: number;
    maxContext?: number;
    maxResponse: number;
    frequencyPenalty: number;
    PresensePenalty: number;
    formatingOrder: FormatingOrderItem[];
    aiModel?: string;
    subModel?: string;
    currentPluginProvider?: string;
    textgenWebUIStreamURL?: string;
    textgenWebUIBlockingURL?: string;
    forceReplaceUrl?: string;
    forceReplaceUrl2?: string;
    promptPreprocess: boolean;
    bias: [string, number][];
    proxyRequestModel?: string;
    openrouterRequestModel?: string;
    proxyKey?: string;
    ooba: OobaSettings;
    ainconfig: AINsettings;
    koboldURL?: string;
    NAISettings?: NAISettings;
    autoSuggestPrompt?: string;
    promptTemplate?: PromptItem[];
    NAIadventure?: boolean;
    NAIappendName?: boolean;
    localStopStrings?: string[];
    customProxyRequestModel?: string;
    reverseProxyOobaArgs?: OobaChatCompletionRequestParams;
    top_p?: number;
    promptSettings?: PromptSettings;
    repetition_penalty?: number;
    min_p?: number;
    top_a?: number;
    openrouterProvider?: {
        order: string[];
        only: string[];
        ignore: string[];
    };
    useInstructPrompt?: boolean;
    customPromptTemplateToggle?: string;
    templateDefaultVariables?: string;
    moduleIntergration?: string;
    top_k?: number;
    instructChatTemplate?: string;
    JinjaTemplate?: string;
    jsonSchemaEnabled?: boolean;
    jsonSchema?: string;
    strictJsonSchema?: boolean;
    extractJson?: string;
    groupTemplate?: string;
    groupOtherBotRole?: string;
    /** The removed per-role parameters: kept for saved data and preset files, never read. */
    seperateParametersEnabled?: boolean;
    seperateParameters?: {
        memory: SeparateParameters;
        emotion: SeparateParameters;
        translate: SeparateParameters;
        otherAx: SeparateParameters;
        /** The removed per-model parameters: kept for saved data and preset files, never read. */
        overrides: Record<string, SeparateParameters>;
    };
    customAPIFormat?: LLMFormat;
    systemContentReplacement?: string;
    systemRoleReplacement?: "user" | "assistant";
    enableCustomFlags?: boolean;
    customFlags?: LLMFlags[];
    image?: string;
    regex?: customscript[];
    reasonEffort?: number;
    thinkingTokens?: number;
    thinkingType?: "off" | "budget" | "adaptive";
    deepseekThinkingType?: "off" | "enabled";
    adaptiveThinkingEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    deepseekReasoningEffort?: "high" | "max";
    outputImageModal?: boolean;
    seperateModelsForAxModels?: boolean;
    seperateModels?: {
        memory: string;
        emotion: string;
        translate: string;
        otherAx: string;
    };
    modelTools?: string[];
    verbosity?: number;
    dynamicOutput?: DynamicOutput;
}

/**
 * A model preset (the `modelPresets` collection; `docs/plan/split-preset.md`): what selects and
 * reaches the model (`MODEL_PRESET_FIELDS`), with the `botPreset` field types. Its `proxyKey` is the
 * write-only `llmSecrets.modelPresets.<id>.proxyKey` entry, never stored here.
 */
export type ModelPreset = { id: string; name: string } & Required<
    Pick<
        botPreset,
        | "aiModel"
        | "subModel"
        | "apiType"
        | "currentPluginProvider"
        | "forceReplaceUrl"
        | "customProxyRequestModel"
        | "customAPIFormat"
        | "textgenWebUIStreamURL"
        | "textgenWebUIBlockingURL"
        | "localNetworkMode"
        | "localNetworkTimeoutSec"
        | "openrouterRequestModel"
        | "openrouterProvider"
        | "useInstructPrompt"
        | "enableCustomFlags"
        | "customFlags"
        | "systemContentReplacement"
        | "systemRoleReplacement"
        | "instructChatTemplate"
        | "JinjaTemplate"
        | "outputImageModal"
        | "modelTools"
        | "maxContext"
        | "seperateModelsForAxModels"
        | "seperateModels"
    >
> &
    Pick<botPreset, "koboldURL" | "proxyRequestModel" | "proxyCredentialId">;

interface hordeConfig {
    apiKey: string;
    model: string;
    softPrompt: string;
}

export interface folder {
    name: string;
    data: string[];
    color: string;
    id: string;
    imgFile?: string;
    img?: string;
}

interface sdConfig {
    width: number;
    height: number;
    sampler_name: string;
    script_name: string;
    denoising_strength: number;
    enable_hr: boolean;
    hr_scale: number;
    hr_upscaler: string;
}

export interface NAIImgConfig {
    width: number;
    height: number;
    sampler: string;
    noise_schedule: string;
    steps: number;
    scale: number;
    cfg_rescale: number;
    sm: boolean;
    sm_dyn: boolean;
    noise: number;
    strength: number;
    image: string;
    base64image: string;
    InfoExtracted: number;
    //add 4
    autoSmea: boolean;
    use_coords: boolean;
    legacy_uc: boolean;
    v4_prompt: NAIImgConfigV4Prompt;
    v4_negative_prompt: NAIImgConfigV4NegativePrompt;
    //add vibe
    reference_image_multiple?: string[];
    reference_strength_multiple?: number[];
    vibe_data?: NAIVibeData;
    vibe_model_selection?: string;
    //add variety+ and decrisp options
    variety_plus: boolean;
    decrisp: boolean;
    //add character reference
    reference_mode: string;
    character_image: string;
    character_base64image: string;
    style_aware: boolean;
}

//add 4
interface NAIImgConfigV4Prompt {
    caption: NAIImgConfigV4Caption;
    use_coords: boolean;
    use_order: boolean;
}
//add 4
interface NAIImgConfigV4NegativePrompt {
    caption: NAIImgConfigV4Caption;
    legacy_uc: boolean;
}
//add 4
interface NAIImgConfigV4Caption {
    base_caption: string;
    char_captions: NAIImgConfigV4CharCaption[];
}
//add 4
interface NAIImgConfigV4CharCaption {
    char_caption: string;
    centers: {
        x: number;
        y: number;
    }[];
}

// NAI Vibe Data interfaces
interface NAIVibeData {
    identifier: string;
    version: number;
    type: string;
    image: string;
    id: string;
    encodings: {
        [key: string]: {
            [key: string]: NAIVibeEncoding;
        };
    };
    name: string;
    thumbnail: string;
    createdAt: number;
    importInfo: {
        model: string;
        information_extracted: number;
        strength: number;
    };
}

interface NAIVibeEncoding {
    encoding: string;
    params: {
        information_extracted: number;
    };
}

interface ComfyConfig {
    workflow: string;
    posNodeID: string;
    posInputName: string;
    negNodeID: string;
    negInputName: string;
    timeout: number;
}

export type FormatingOrderItem =
    | "main"
    | "jailbreak"
    | "chats"
    | "lorebook"
    | "globalNote"
    | "authorNote"
    | "lastChat"
    | "description"
    | "postEverything"
    | "personaPrompt";

export interface Chat {
    message: Message[];
    note: string;
    name: string;
    localLore: loreBook[];
    sdData?: string;
    supaMemoryData?: string;
    hypaV2Data?: SerializableHypaV2Data;
    lastMemory?: string;
    suggestMessages?: string[];
    isStreaming?: boolean;
    activeStreamingDisplayOptimizationMode?: StreamingDisplayOptimizationMode;
    scriptstate?: { [key: string]: string | number | boolean };
    modules?: string[];
    id?: string;
    bindedPersona?: string;
    fmIndex?: number;
    hypaV3Data?: SerializableHypaV3Data;
    folderId?: string;
    lastDate?: number;
    bookmarks?: string[];
    bookmarkNames?: { [chatId: string]: string };
    useLocallySetGlobalVariables?: boolean;
    GLGlobalVariables?: { [key: string]: string };
    /**
     * The remembered tool calls of this chat (`rememberToolUsage`), by call id: what a
     * `<tool_call>` marker in a message stands for (Phase 5 slice 11b). Conversation data: stored
     * and deleted with the chat.
     */
    toolCalls?: { [id: string]: ToolCallRecord };
}

export interface ChatFolder {
    id: string;
    name?: string;
    color?: string;
    folded: boolean;
}

export interface Message {
    role: "user" | "char";
    data: string;
    saying?: string;
    chatId?: string;
    time?: number;
    generationInfo?: MessageGenerationInfo;
    promptInfo?: MessagePresetInfo;
    name?: string;
    disabled?: false | true | "allBefore";
    isComment?: boolean;
}

export interface MessageGenerationInfo {
    model?: string;
    generationId?: string;
    inputTokens?: number;
    outputTokens?: number;
    maxContext?: number;
    stageTiming?: {
        stage1?: number;
        stage2?: number;
        stage3?: number;
        stage4?: number;
    };
}

export interface MessagePresetInfo {
    promptName?: string;
    promptToggles?: { key: string; value: string }[];
    promptText?: OpenAIChat[];
}

export interface PromptDiffPrefs {
    diffStyle: "line" | "intraline";
    formatStyle: "raw" | "card";
    viewStyle: "unified" | "split";
    isGrouped: boolean;
    showOnlyChanges: boolean;
    contextRadius: number;
}

export interface AINsettings {
    top_p: number;
    rep_pen: number;
    top_a: number;
    rep_pen_slope: number;
    rep_pen_range: number;
    typical_p: number;
    badwords: string;
    stoptokens: string;
    top_k: number;
}

export interface OobaSettings {
    max_new_tokens: number;
    do_sample: boolean;
    temperature: number;
    top_p: number;
    typical_p: number;
    repetition_penalty: number;
    encoder_repetition_penalty: number;
    top_k: number;
    min_length: number;
    no_repeat_ngram_size: number;
    num_beams: number;
    penalty_alpha: number;
    length_penalty: number;
    early_stopping: boolean;
    seed: number;
    add_bos_token: boolean;
    truncation_length: number;
    ban_eos_token: boolean;
    skip_special_tokens: boolean;
    top_a: number;
    tfs: number;
    epsilon_cutoff: number;
    eta_cutoff: number;
    formating: {
        header: string;
        systemPrefix: string;
        userPrefix: string;
        assistantPrefix: string;
        seperator: string;
        useName: boolean;
    };
}
