import { get } from "svelte/store";
import { checkNullish, decryptBuffer, encryptBuffer, selectSingleFile } from "../util";
import { changeLanguage, language } from "../../lang";
import { downloadFile, saveAsset as saveImageGlobal } from "../globalApi.svelte";
import { defaultAutoSuggestPrompt, defaultJailbreak, defaultMainPrompt } from "./defaultPrompts";
import { alertNormal } from "../alert";
import { prebuiltNAIpresets, prebuiltPresets } from "../process/templates/templates";
import { defaultColorScheme } from "../gui/colorscheme";
import type { PromptItem } from "../process/prompt";
import { createHypaV3Preset } from "../process/memory/hypav3";
import { normalizeTranslatorPresetState } from "../translator/presets";
import { safeStructuredClone } from "../polyfill";
import {
    DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
    DEFAULT_CHAT_LOAD_INITIAL_PAGES,
    normalizeChatLoadPages,
} from "../chatLoadPages";
import type {
    AINsettings,
    botPreset,
    Chat,
    character,
    Database,
    groupChat,
    Message,
    OobaSettings,
    StreamingDisplayOptimizationMode,
} from "../../../shared/database.ts";

//APP_VERSION_POINT is to locate the app version in the database file for version bumping
export let appVer = "2026.8.250"; //<APP_VERSION_POINT>
export let appSubVer = "";

export type * from "../../../shared/database.ts";

export function setDatabase(data: Database) {
    // Risu Account was removed; drop the login token older saves still carry.
    delete (data as Database & { account?: unknown }).account;
    // Cold storage was removed; drop its flag and the orphaned plugin-storage pointer map.
    delete (data as Database & { coldstorage?: unknown }).coldstorage;
    if (data.pluginCustomStorage) {
        delete data.pluginCustomStorage._coldplugin;
    }
    if (checkNullish(data.characters)) {
        data.characters = [];
    }
    if (checkNullish(data.apiType)) {
        data.apiType = "gemini-3-flash-preview";
    }
    if (checkNullish(data.openAIKey)) {
        data.openAIKey = "";
    }
    if (checkNullish(data.mainPrompt)) {
        data.mainPrompt = defaultMainPrompt;
    }
    if (checkNullish(data.jailbreak)) {
        data.jailbreak = defaultJailbreak;
    }
    if (checkNullish(data.globalNote)) {
        data.globalNote = ``;
    }
    if (checkNullish(data.temperature)) {
        data.temperature = 80;
    }
    if (checkNullish(data.maxContext)) {
        data.maxContext = 4000;
    }
    if (checkNullish(data.maxResponse)) {
        data.maxResponse = 500;
    }
    if (checkNullish(data.frequencyPenalty)) {
        data.frequencyPenalty = 70;
    }
    if (checkNullish(data.PresensePenalty)) {
        data.PresensePenalty = 70;
    }
    if (checkNullish(data.aiModel)) {
        data.aiModel = "gemini-3-flash-preview";
    }
    if (checkNullish(data.jailbreakToggle)) {
        data.jailbreakToggle = false;
    }
    if (checkNullish(data.formatingOrder)) {
        data.formatingOrder = [
            "main",
            "description",
            "personaPrompt",
            "chats",
            "lastChat",
            "jailbreak",
            "lorebook",
            "globalNote",
            "authorNote",
        ];
    }
    if (checkNullish(data.loreBookDepth)) {
        data.loreBookDepth = 5;
    }
    if (checkNullish(data.loreBookToken)) {
        data.loreBookToken = 800;
    }
    if (checkNullish(data.username)) {
        data.username = "User";
    }
    if (checkNullish(data.userIcon)) {
        data.userIcon = "";
    }
    if (checkNullish(data.userNote)) {
        data.userNote = "";
    }
    if (checkNullish(data.additionalPrompt)) {
        data.additionalPrompt = "The assistant must act as {{char}}. user is {{user}}.";
    }
    if (checkNullish(data.descriptionPrefix)) {
        data.descriptionPrefix = "description of {{char}}: ";
    }
    if (checkNullish(data.forceReplaceUrl)) {
        data.forceReplaceUrl = "";
    }
    if (checkNullish(data.language)) {
        data.language = "en";
    }
    if (checkNullish(data.swipe)) {
        data.swipe = true;
    }
    if (checkNullish(data.translator)) {
        data.translator = "";
    }
    if (checkNullish(data.translatorMaxResponse)) {
        data.translatorMaxResponse = 1000;
    }
    if (checkNullish(data.currentPluginProvider)) {
        data.currentPluginProvider = "";
    }
    if (checkNullish(data.plugins)) {
        data.plugins = [];
    }
    if (checkNullish(data.zoomsize)) {
        data.zoomsize = 100;
    }
    if (checkNullish(data.customBackground)) {
        data.customBackground = "";
    }
    if (checkNullish(data.textgenWebUIStreamURL)) {
        data.textgenWebUIStreamURL = "wss://localhost/api/";
    }
    if (checkNullish(data.textgenWebUIBlockingURL)) {
        data.textgenWebUIBlockingURL = "https://localhost/api/";
    }
    if (checkNullish(data.autoTranslate)) {
        data.autoTranslate = false;
    }
    if (checkNullish(data.fullScreen)) {
        data.fullScreen = false;
    }
    if (checkNullish(data.playMessage)) {
        data.playMessage = false;
    }
    if (checkNullish(data.iconsize)) {
        data.iconsize = 100;
    }
    if (checkNullish(data.theme)) {
        data.theme = "";
    }
    if (checkNullish(data.subModel)) {
        data.subModel = "gemini-3-flash-preview";
    }
    if (checkNullish(data.waifuWidth)) {
        data.waifuWidth = 100;
    }
    if (checkNullish(data.waifuWidth2)) {
        data.waifuWidth2 = 100;
    }
    if (checkNullish(data.emotionPrompt)) {
        data.emotionPrompt = "";
    }
    if (checkNullish(data.proxyKey)) {
        data.proxyKey = "";
    }
    if (checkNullish(data.botPresets)) {
        let defaultPreset = presetTemplate;
        defaultPreset.name = "Default";
        data.botPresets = [defaultPreset];
    }
    if (checkNullish(data.botPresetsId)) {
        data.botPresetsId = 0;
    }
    if (Array.isArray(data.promptTemplate)) {
        data.promptTemplate = normalizePromptTemplate(data.promptTemplate);
    }
    if (checkNullish(data.sdProvider)) {
        data.sdProvider = "";
    }
    if (checkNullish(data.webUiUrl)) {
        data.webUiUrl = "http://127.0.0.1:7860/";
    }
    if (checkNullish(data.sdSteps)) {
        data.sdSteps = 30;
    }
    if (checkNullish(data.sdCFG)) {
        data.sdCFG = 7;
    }
    if (checkNullish(data.NAIImgUrl)) {
        data.NAIImgUrl = "https://image.novelai.net/ai/generate-image";
    }
    if (checkNullish(data.NAIApiKey)) {
        data.NAIApiKey = "";
    }
    if (checkNullish(data.NAIImgModel)) {
        data.NAIImgModel = "nai-diffusion-4-5-full";
    }
    if (checkNullish(data.NAII2I)) {
        data.NAII2I = false;
    }
    if (checkNullish(data.NAIREF)) {
        data.NAIREF = false;
    }
    if (checkNullish(data.textTheme)) {
        data.textTheme = "standard";
    }
    if (checkNullish(data.emotionPrompt2)) {
        data.emotionPrompt2 = "";
    }
    if (checkNullish(data.requestRetrys)) {
        data.requestRetrys = 2;
    }
    if (checkNullish(data.useSayNothing)) {
        data.useSayNothing = true;
    }
    if (checkNullish(data.bias)) {
        data.bias = [];
    }
    if (checkNullish(data.showUnrecommended)) {
        data.showUnrecommended = false;
    }
    if (checkNullish(data.elevenLabKey)) {
        data.elevenLabKey = "";
    }
    if (checkNullish(data.voicevoxUrl)) {
        data.voicevoxUrl = "";
    }
    if (checkNullish(data.supaMemoryPrompt)) {
        data.supaMemoryPrompt = "";
    }
    if (checkNullish(data.showMemoryLimit)) {
        data.showMemoryLimit = false;
    }
    if (checkNullish(data.showFirstMessagePages)) {
        data.showFirstMessagePages = false;
    }
    if (checkNullish(data.supaMemoryKey)) {
        data.supaMemoryKey = "";
    }
    if (checkNullish(data.hypaMemoryKey)) {
        data.hypaMemoryKey = "";
    }
    if (checkNullish(data.voyageApiKey)) {
        data.voyageApiKey = "";
    }
    if (checkNullish(data.supaModelType)) {
        data.supaModelType = "none";
    }
    if (checkNullish(data.askRemoval)) {
        data.askRemoval = true;
    }
    if (checkNullish(data.sdConfig)) {
        data.sdConfig = {
            width: 512,
            height: 512,
            sampler_name: "Euler a",
            script_name: "",
            denoising_strength: 0.7,
            enable_hr: false,
            hr_scale: 1.25,
            hr_upscaler: "Latent",
        };
    }
    if (checkNullish(data.NAIImgConfig)) {
        data.NAIImgConfig = {
            width: 1024,
            height: 1024,
            sampler: "k_euler_ancestral",
            noise_schedule: "karras",
            steps: 28,
            scale: 5,
            cfg_rescale: 0,
            sm: true,
            sm_dyn: false,
            noise: 0.0,
            strength: 0.6,
            image: "",
            base64image: "",
            InfoExtracted: 1,
            //add 4
            autoSmea: false,
            legacy_uc: false,
            use_coords: false,
            v4_prompt: {
                caption: {
                    base_caption: "",
                    char_captions: [],
                },
                use_coords: false,
                use_order: true,
            },
            v4_negative_prompt: {
                caption: {
                    base_caption: "",
                    char_captions: [],
                },
                legacy_uc: false,
            },
            variety_plus: false,
            decrisp: false,
            reference_mode: "",
            character_image: "",
            character_base64image: "",
            style_aware: false,
        };
    }
    //add NAI v4 (사용중인 사람용 추가 DB Init)
    if (checkNullish(data.NAIImgConfig.v4_prompt)) {
        data.NAIImgConfig.autoSmea = false;
        data.NAIImgConfig.use_coords = false;
        data.NAIImgConfig.legacy_uc = false;
        data.NAIImgConfig.v4_prompt = {
            caption: {
                base_caption: "",
                char_captions: [],
            },
            use_coords: false,
            use_order: true,
        };
        data.NAIImgConfig.v4_negative_prompt = {
            caption: {
                base_caption: "",
                char_captions: [],
            },
            legacy_uc: false,
        };
    }
    if (checkNullish(data.customTextTheme)) {
        data.customTextTheme = {
            FontColorStandard: "#f8f8f2",
            FontColorBold: "#f8f8f2",
            FontColorItalic: "#8C8D93",
            FontColorItalicBold: "#8C8D93",
            FontColorQuote1: "#8BE9FD",
            FontColorQuote2: "#FFB86C",
        };
    }
    if (checkNullish(data.hordeConfig)) {
        data.hordeConfig = {
            apiKey: "",
            model: "",
            softPrompt: "",
        };
    }
    if (checkNullish(data.novelai)) {
        data.novelai = {
            token: "",
            model: "clio-v1",
        };
    }
    if (checkNullish(data.loreBook)) {
        data.loreBookPage = 0;
        data.loreBook = [
            {
                name: "My First LoreBook",
                data: [],
            },
        ];
    }
    if (checkNullish(data.loreBookPage) || data.loreBook.length < data.loreBookPage) {
        data.loreBookPage = 0;
    }
    data.globalscript ??= [];
    data.sendWithEnter ??= true;
    data.autoSuggestPrompt ??= defaultAutoSuggestPrompt;
    data.autoSuggestPrefix ??= "";
    data.OAIPrediction ??= "";
    data.autoSuggestClean ??= true;
    data.imageCompression ??= true;
    data.enableBlockPartialEdit ??= false;
    data.enableDragPartialEdit ??= false;
    if (!data.formatingOrder.includes("personaPrompt")) {
        data.formatingOrder.splice(data.formatingOrder.indexOf("main"), 0, "personaPrompt");
    }
    data.selectedPersona ??= 0;
    data.personaPrompt ??= "";
    data.personas ??= [
        {
            name: data.username,
            personaPrompt: "",
            icon: data.userIcon,
            note: data.userNote,
            largePortrait: false,
        },
    ];
    data.classicMaxWidth ??= false;
    data.ooba ??= safeStructuredClone(defaultOoba);
    data.ainconfig ??= safeStructuredClone(defaultAIN);
    data.openrouterKey ??= "";
    data.openrouterRequestModel ??= "openai/gpt-3.5-turbo";
    data.nanogptKey ??= "";
    data.nanogptRequestModel ??= "";
    data.nanogptRequestModelName ??= "";
    data.nanogptProvider ??= "";
    data.nanogptSubscriptionState ??= "";
    data.nanogptUseSubscriptionEndpoint ??= false;
    data.NAIsettings ??= safeStructuredClone(prebuiltNAIpresets);
    data.assetWidth ??= -1;
    data.animationSpeed ??= 0.4;
    data.colorScheme ??= safeStructuredClone(defaultColorScheme);
    data.colorSchemeName ??= "default";
    data.customColorScheme ??= safeStructuredClone(
        data.colorSchemeName === "custom" ? data.colorScheme : defaultColorScheme,
    );
    data.NAIsettings.starter ??= "";
    data.hypaModel ??= "MiniLM";
    data.mancerHeader ??= "";
    data.emotionProcesser ??= "submodel";
    data.translatorType ??= "google";
    data.htmlTranslation ??= false;
    data.deeplOptions ??= {
        key: "",
        freeApi: false,
    };
    data.deeplXOptions ??= {
        url: "",
        token: "",
    };
    data.NAIadventure ??= false;
    data.NAIappendName ??= true;
    data.NAIsettings.cfg_scale ??= 1;
    data.NAIsettings.mirostat_tau ??= 0;
    data.NAIsettings.mirostat_lr ??= 1;
    data.autofillRequestUrl ??= true;
    data.customProxyRequestModel ??= "";
    data.generationSeed ??= -1;
    data.newOAIHandle ??= true;
    data.localNetworkMode ??= false;
    if (typeof data.localNetworkMode !== "boolean") {
        data.localNetworkMode = false;
    }
    data.localNetworkTimeoutSec ??= 600;
    if (typeof data.localNetworkTimeoutSec !== "number" || Number.isNaN(data.localNetworkTimeoutSec)) {
        data.localNetworkTimeoutSec = 600;
    }
    data.gptVisionQuality ??= "low";
    data.huggingfaceKey ??= "";
    data.fishSpeechKey ??= "";
    data.presetRegex ??= [];
    data.reverseProxyOobaArgs ??= {
        mode: "instruct",
    };
    data.top_p ??= 1;
    if (typeof data.top_p !== "number") {
        //idk why type changes, but it does so this is a fix
        data.top_p = 1;
    }
    //@ts-expect-error data.google has required fields (accessToken, projectId), but we use empty object as default and populate below
    data.google ??= {};
    data.google.accessToken ??= "";
    data.google.projectId ??= "";
    data.genTime ??= 1;
    data.promptSettings ??= {
        assistantPrefill: "",
        postEndInnerFormat: "",
        sendChatAsSystem: false,
        sendName: false,
        utilOverride: false,
        customChainOfThought: false,
        maxThoughtTagDepth: -1,
    };
    data.top_k ??= 0;
    data.promptSettings.maxThoughtTagDepth ??= -1;
    data.openrouterFallback ??= true;
    data.openrouterMiddleOut ??= false;
    data.removePunctuationHypa ??= true;
    data.memoryLimitThickness ??= 1;
    data.modules ??= [];
    data.enabledModules ??= [];
    data.additionalParams ??= [];
    data.heightMode ??= "normal";
    data.antiClaudeOverload ??= false;
    data.maxSupaChunkSize ??= 1200;
    data.ollamaURL ??= "";
    data.ollamaModel ??= "";
    data.ollamaModelSource ??= data.aiModel === "ollama-cloud" || data.subModel === "ollama-cloud" ? "cloud" : "local";
    data.ollamaInputMode ??= "manual";
    data.ollamaRequestFormat ??= LLMFormat.Ollama;
    data.ollamaApiKey ??= "";
    data.ollamaModelName ??= "";
    data.ollamaCloudModel ??= "";
    data.ollamaCloudModelName ??= "";
    data.ollamaThinkingMode ??= "auto";
    if ((data.aiModel === "ollama-cloud" || data.subModel === "ollama-cloud") && !data.ollamaCloudModel) {
        data.ollamaCloudModel = data.ollamaModel;
        data.ollamaCloudModelName = data.ollamaModelName;
    }
    data.autoContinueChat ??= false;
    data.autoContinueMinTokens ??= 0;
    data.repetition_penalty ??= 1;
    data.min_p ??= 0;
    data.top_a ??= 0;
    data.customTokenizer ??= "tik";
    data.instructChatTemplate ??= "chatml";
    // Migration: convert old string type into new provider object
    if (typeof data.openrouterProvider === "string") {
        const oldProvider = data.openrouterProvider as unknown as string;
        data.openrouterProvider = {
            order: oldProvider ? [oldProvider] : [],
            only: [],
            ignore: [],
        };
    }
    if (data.botPresets) {
        for (const preset of data.botPresets) {
            if (Array.isArray(preset.promptTemplate)) {
                preset.promptTemplate = normalizePromptTemplate(preset.promptTemplate);
            }
            preset.localNetworkMode ??= false;
            preset.localNetworkTimeoutSec ??= 600;
            if (typeof preset.localNetworkMode !== "boolean") {
                preset.localNetworkMode = false;
            }
            if (typeof preset.localNetworkTimeoutSec !== "number" || Number.isNaN(preset.localNetworkTimeoutSec)) {
                preset.localNetworkTimeoutSec = 600;
            }
            if (typeof preset.openrouterProvider === "string") {
                const oldProvider = preset.openrouterProvider as unknown as string;
                preset.openrouterProvider = {
                    order: oldProvider ? [oldProvider] : [],
                    only: [],
                    ignore: [],
                };
            }
        }
    }
    data.openrouterProvider ??= {
        order: [],
        only: [],
        ignore: [],
    };
    data.useInstructPrompt ??= false;
    data.hanuraiEnable ??= false;
    data.hanuraiSplit ??= false;
    data.hanuraiTokens ??= 1000;
    data.textAreaSize ??= 0;
    data.sideBarSize ??= 0;
    data.textAreaTextSize ??= 0;
    data.combineTranslation ??= false;
    data.customPromptTemplateToggle ??= "";
    data.globalChatVariables ??= {};
    data.templateDefaultVariables ??= "";
    data.hypaAllocatedTokens ??= 3000;
    data.hypaChunkSize ??= 3000;
    data.dallEQuality ??= "standard";
    data.customTextTheme.FontColorQuote1 ??= "#8BE9FD";
    data.customTextTheme.FontColorQuote2 ??= "#FFB86C";
    data.font ??= "default";
    data.customFont ??= "";
    data.lineHeight ??= 1.25;
    data.stabilityModel ??= "sd3-large";
    data.stabllityStyle ??= "";
    data.legacyTranslation ??= false;
    data.comfyUiUrl ??= "http://localhost:8188";
    data.comfyConfig ??= {
        workflow: "",
        posNodeID: "",
        posInputName: "text",
        negNodeID: "",
        negInputName: "text",
        timeout: 30,
    };
    data.hideApiKey ??= true;
    data.unformatQuotes ??= false;
    data.ttsAutoSpeech ??= false;
    data.translatorInputLanguage ??= "auto";
    data.falModel ??= "fal-ai/flux/dev";
    data.falLoraScale ??= 1;
    data.customCSS ??= "";
    data.strictJsonSchema ??= true;
    data.statics ??= {
        messages: 0,
        imports: 0,
    };
    data.customQuotes ??= false;
    data.customQuotesData ??= ["“", "”", "‘", "’"];
    data.groupOtherBotRole ??= "user";
    data.customGUI ??= "";
    data.customAPIFormat ??= LLMFormat.OpenAICompatible;
    data.systemContentReplacement ??= `system: {{slot}}`;
    data.systemRoleReplacement ??= "user";
    data.vertexAccessToken ??= "";
    data.vertexAccessTokenExpires ??= 0;
    data.vertexClientEmail ??= "";
    data.vertexPrivateKey ??= "";
    data.vertexRegion ??= "global";
    data.seperateParametersEnabled ??= false;
    data.seperateParameters ??= {
        memory: {},
        emotion: {},
        translate: {},
        otherAx: {},
        overrides: {},
    };
    data.seperateParameters.overrides ??= {};
    data.customFlags ??= [];
    data.enableCustomFlags ??= false;
    data.assetMaxDifference ??= 4;
    data.showSavingIcon ??= false;
    data.banCharacterset ??= [];
    data.showPromptComparison ??= false;
    data.OaiCompAPIKeys ??= {};
    data.reasoningEffort ??= 0;
    data.verbosity ??= 1;
    data.hypaV3Presets ??= [
        createHypaV3Preset("Default", {
            summarizationPrompt: data.supaMemoryPrompt ? data.supaMemoryPrompt : "",
            ...data.hypaV3Settings,
        }),
    ];
    if (data.hypaV3Presets.length > 0) {
        data.hypaV3Presets = data.hypaV3Presets.map((preset, i) =>
            createHypaV3Preset(preset.name || `Preset ${i + 1}`, preset.settings || {}),
        );
    }
    data.hypaV3PresetId ??= 0;
    normalizeTranslatorPresetState(data);
    data.showDeprecatedTriggerV2 ??= false;
    data.returnCSSError ??= true;
    data.realmDirectOpen ??= false;
    data.checkCorruption ??= false;
    data.toggleConfirmRecommendedPreset ??= false;
    data.useExperimentalGoogleTranslator ??= false;
    data.thinkingType ??= "budget";
    data.deepseekThinkingType ??= "off";
    data.adaptiveThinkingEffort ??= "high";
    data.deepseekReasoningEffort ??= "high";
    if (data.antiClaudeOverload) {
        //migration
        data.antiClaudeOverload = false;
        data.antiServerOverloads = true;
    }
    data.hypaCustomSettings = {
        url: data.hypaCustomSettings?.url ?? "",
        key: data.hypaCustomSettings?.key ?? "",
        model: data.hypaCustomSettings?.model ?? "",
    };
    data.doNotChangeSeperateModels ??= false;
    data.modelTools ??= [];
    data.enableScrollToActiveChar ??= true;

    // Merge existing hotkeys with new default hotkeys
    if (!data.hotkeys) {
        data.hotkeys = safeStructuredClone(defaultHotkeys);
    } else {
        const existingActions = new Set(data.hotkeys.map((h) => h.action));
        const newHotkeys = defaultHotkeys.filter((h) => !existingActions.has(h.action));
        if (newHotkeys.length > 0) {
            data.hotkeys.push(...safeStructuredClone(newHotkeys));
        }
    }

    // Remove scrollToActiveChar hotkey if feature is disabled
    if (data.enableScrollToActiveChar === false) {
        data.hotkeys = data.hotkeys.filter((h) => h.action !== "scrollToActiveChar");
    }

    data.fallbackModels ??= {
        memory: [],
        emotion: [],
        translate: [],
        otherAx: [],
        model: [],
    };
    data.fallbackModels = {
        model: data.fallbackModels.model.filter((v) => v !== ""),
        memory: data.fallbackModels.memory.filter((v) => v !== ""),
        emotion: data.fallbackModels.emotion.filter((v) => v !== ""),
        translate: data.fallbackModels.translate.filter((v) => v !== ""),
        otherAx: data.fallbackModels.otherAx.filter((v) => v !== ""),
    };
    data.customModels ??= [];
    data.authRefreshes ??= [];
    data.openAIFlexProcessing ??= false;
    data.rememberToolUsage ??= true;
    data.simplifiedToolUse ??= false;
    data.streamGeminiThoughts ??= false;
    data.settingsCloseButtonSize ??= 24;
    data.hideAllImages ??= false;
    data.ImagenModel ??= "imagen-4.0-generate-001";
    data.ImagenImageSize ??= "1K";
    data.ImagenAspectRatio ??= "1:1";
    data.ImagenPersonGeneration ??= "allow_all";
    data.openaiCompatImage ??= {
        url: "",
        key: "",
        model: "",
        size: "1024x1024",
        quality: "auto",
    };
    data.wavespeedImage ??= {
        key: "",
        model: "",
        loras: [],
        reference_mode: "",
        reference_image: "",
        reference_base64image: "",
    };
    data.autoScrollToNewMessage ??= true;
    data.alwaysScrollToNewMessage ??= false;
    data.newMessageButtonStyle ??= "bottom-center";
    data.chatLoadInitialPages = normalizeChatLoadPages(data.chatLoadInitialPages, DEFAULT_CHAT_LOAD_INITIAL_PAGES);
    data.chatLoadAdditionalPages = normalizeChatLoadPages(
        data.chatLoadAdditionalPages,
        DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
    );
    data.streamingDisplayOptimizationMode ??=
        (data as { largeChatPerformanceMode?: StreamingDisplayOptimizationMode }).largeChatPerformanceMode ?? "off";
    delete (data as { largeChatPerformanceMode?: unknown }).largeChatPerformanceMode;
    data.echoMessage ??= "Echo Message";
    data.echoDelay ??= 0;
    data.createFolderOnBranch ??= true;
    data.hamburgerButtonBottom ??= false;
    data.dynamicModelRegistry ??= true;
    data.saveSignatures ??= false;
    // If the user uses plugins, its probably better to enable RisuAI Pro Tools by default
    // Because its likely they are power users who would benefit from the features
    data.enableRisuaiProTools ??= data.plugins.length > 0;
    data.keepSessionAlive ??= "off";
    data.longPressToPopupEditor ??= false;
    data.customSidebarItems ??= [];
    data.moveInsteadOfCopyOnCMPConvert ??= false;
    for (const char of data.characters) {
        for (const chat of char.chats ?? []) {
            chat.isStreaming = false;
            chat.activeStreamingDisplayOptimizationMode = undefined;
        }
    }
    changeLanguage(data.language);
    setDatabaseLite(data);
}

export function setDatabaseLite(data: Database) {
    DBState.db = data;
}

interface getDatabaseOptions {
    snapshot?: boolean;
}

export function getDatabase(options: getDatabaseOptions = {}): Database {
    if (options.snapshot) {
        return $state.snapshot(DBState.db) as Database;
    }
    return DBState.db as Database;
}

export function getCurrentCharacter(options: getDatabaseOptions = {}): character | groupChat {
    const db = getDatabase(options);
    if (!db.characters) {
        db.characters = [];
    }
    const char = db.characters?.[get(selectedCharID)];
    return char;
}

export function setCurrentCharacter(char: character | groupChat) {
    if (!DBState.db.characters) {
        DBState.db.characters = [];
    }
    DBState.db.characters[get(selectedCharID)] = char;
}

export function getCharacterByIndex(index: number, options: getDatabaseOptions = {}): character | groupChat {
    const db = getDatabase(options);
    if (!db.characters) {
        db.characters = [];
    }
    const char = db.characters?.[index];
    return char;
}

export function setCharacterByIndex(index: number, char: character | groupChat) {
    if (!DBState.db.characters) {
        DBState.db.characters = [];
    }
    DBState.db.characters[index] = char;
}

export function getCurrentChat() {
    const char = getCurrentCharacter();
    return char?.chats?.[char.chatPage];
}

export function setCurrentChat(chat: Chat) {
    const char = getCurrentCharacter();
    char.chats[char.chatPage] = chat;
    setCurrentCharacter(char);
}

export const saveImage = saveImageGlobal;

export const defaultAIN: AINsettings = {
    top_p: 0.7,
    rep_pen: 1.0625,
    top_a: 0.08,
    rep_pen_slope: 1.7,
    rep_pen_range: 1024,
    typical_p: 1.0,
    badwords: "",
    stoptokens: "",
    top_k: 140,
};

export const defaultOoba: OobaSettings = {
    max_new_tokens: 180,
    do_sample: true,
    temperature: 0.7,
    top_p: 0.9,
    typical_p: 1,
    repetition_penalty: 1.15,
    encoder_repetition_penalty: 1,
    top_k: 20,
    min_length: 0,
    no_repeat_ngram_size: 0,
    num_beams: 1,
    penalty_alpha: 0,
    length_penalty: 1,
    early_stopping: false,
    seed: -1,
    add_bos_token: true,
    truncation_length: 4096,
    ban_eos_token: false,
    skip_special_tokens: true,
    top_a: 0,
    tfs: 1,
    epsilon_cutoff: 0,
    eta_cutoff: 0,
    formating: {
        header: "Below is an instruction that describes a task. Write a response that appropriately completes the request.",
        systemPrefix: "### Instruction:",
        userPrefix: "### Input:",
        assistantPrefix: "### Response:",
        seperator: "",
        useName: false,
    },
};

export const presetTemplate: botPreset = {
    name: "New Preset",
    apiType: "gemini-3-flash-preview",
    openAIKey: "",
    localNetworkMode: false,
    localNetworkTimeoutSec: 600,
    mainPrompt: defaultMainPrompt,
    jailbreak: defaultJailbreak,
    globalNote: "",
    temperature: 80,
    maxContext: 4000,
    maxResponse: 300,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    formatingOrder: [
        "main",
        "description",
        "personaPrompt",
        "chats",
        "lastChat",
        "jailbreak",
        "lorebook",
        "globalNote",
        "authorNote",
    ],
    aiModel: "gemini-3-flash-preview",
    subModel: "gemini-3-flash-preview",
    currentPluginProvider: "",
    textgenWebUIStreamURL: "",
    textgenWebUIBlockingURL: "",
    forceReplaceUrl: "",
    forceReplaceUrl2: "",
    promptPreprocess: false,
    proxyKey: "",
    bias: [],
    ooba: safeStructuredClone(defaultOoba),
    ainconfig: safeStructuredClone(defaultAIN),
    reverseProxyOobaArgs: {
        mode: "instruct",
    },
    top_p: 1,
    useInstructPrompt: false,
    verbosity: 1,
};

const defaultSdData: [string, string][] = [
    ["always", "solo, 1girl"],
    ["negative", ""],
    ["|character\'s appearance", ""],
    ["current situation", ""],
    ["$character's pose", ""],
    ["$character's emotion", ""],
    ["current location", ""],
];

export const defaultSdDataFunc = () => {
    return safeStructuredClone(defaultSdData);
};

export function saveCurrentPreset() {
    let db = DBState.db;
    let pres = db.botPresets;

    if (db.botPresetsId === -1) {
        return;
    }
    const savedPreset: botPreset = {
        name: pres[db.botPresetsId].name,
        apiType: db.apiType,
        openAIKey: db.openAIKey,
        localNetworkMode: db.localNetworkMode,
        localNetworkTimeoutSec: db.localNetworkTimeoutSec,
        mainPrompt: db.mainPrompt,
        jailbreak: db.jailbreak,
        globalNote: db.globalNote,
        temperature: db.temperature,
        maxContext: db.maxContext,
        maxResponse: db.maxResponse,
        frequencyPenalty: db.frequencyPenalty,
        PresensePenalty: db.PresensePenalty,
        formatingOrder: db.formatingOrder,
        aiModel: db.aiModel,
        subModel: db.subModel,
        currentPluginProvider: db.currentPluginProvider,
        textgenWebUIStreamURL: db.textgenWebUIStreamURL,
        textgenWebUIBlockingURL: db.textgenWebUIBlockingURL,
        forceReplaceUrl: db.forceReplaceUrl,
        promptPreprocess: db.promptPreprocess,
        bias: db.bias,
        koboldURL: db.koboldURL,
        proxyKey: db.proxyKey,
        ooba: safeStructuredClone(db.ooba),
        ainconfig: safeStructuredClone(db.ainconfig),
        proxyRequestModel: db.proxyRequestModel,
        openrouterRequestModel: db.openrouterRequestModel,
        NAISettings: safeStructuredClone(db.NAIsettings),
        promptTemplate: normalizePromptTemplate(db.promptTemplate) ?? null,
        NAIadventure: db.NAIadventure ?? false,
        NAIappendName: db.NAIappendName ?? false,
        localStopStrings: db.localStopStrings,
        autoSuggestPrompt: db.autoSuggestPrompt,
        customProxyRequestModel: db.customProxyRequestModel,
        reverseProxyOobaArgs: safeStructuredClone(db.reverseProxyOobaArgs) ?? null,
        top_p: db.top_p ?? 1,
        promptSettings: safeStructuredClone(db.promptSettings) ?? null,
        repetition_penalty: db.repetition_penalty,
        min_p: db.min_p,
        top_a: db.top_a,
        openrouterProvider: db.openrouterProvider,
        useInstructPrompt: db.useInstructPrompt,
        customPromptTemplateToggle: db.customPromptTemplateToggle ?? "",
        templateDefaultVariables: db.templateDefaultVariables ?? "",
        moduleIntergration: db.moduleIntergration ?? "",
        top_k: db.top_k,
        instructChatTemplate: db.instructChatTemplate,
        JinjaTemplate: db.JinjaTemplate ?? "",
        jsonSchemaEnabled: db.jsonSchemaEnabled ?? false,
        jsonSchema: db.jsonSchema ?? "",
        strictJsonSchema: db.strictJsonSchema ?? true,
        extractJson: db.extractJson ?? "",
        groupOtherBotRole: db.groupOtherBotRole ?? "user",
        groupTemplate: db.groupTemplate ?? "",
        seperateParametersEnabled: db.seperateParametersEnabled ?? false,
        seperateParameters: safeStructuredClone(db.seperateParameters),
        customAPIFormat: safeStructuredClone(db.customAPIFormat),
        systemContentReplacement: db.systemContentReplacement,
        systemRoleReplacement: db.systemRoleReplacement,
        customFlags: safeStructuredClone(db.customFlags),
        enableCustomFlags: db.enableCustomFlags,
        regex: db.presetRegex,
        image: pres?.[db.botPresetsId]?.image ?? "",
        reasonEffort: db.reasoningEffort ?? 0,
        thinkingTokens: db.thinkingTokens ?? null,
        thinkingType: db.thinkingType ?? "budget",
        deepseekThinkingType: db.deepseekThinkingType ?? "off",
        adaptiveThinkingEffort: db.adaptiveThinkingEffort ?? "high",
        deepseekReasoningEffort: db.deepseekReasoningEffort ?? "high",
        outputImageModal: db.outputImageModal ?? false,
        seperateModelsForAxModels: db.doNotChangeSeperateModels ? false : (db.seperateModelsForAxModels ?? false),
        seperateModels: db.doNotChangeSeperateModels ? null : safeStructuredClone(db.seperateModels),
        modelTools: safeStructuredClone(db.modelTools),
        fallbackModels: safeStructuredClone(db.fallbackModels),
        fallbackWhenBlankResponse: db.fallbackWhenBlankResponse ?? false,
        verbosity: db.verbosity ?? 1,
        dynamicOutput: db.dynamicOutput ?? null,
    };

    if (!Array.isArray(pres)) {
        pres = [];
    }
    //if out of bounds, create a new preset
    if (db.botPresetsId >= pres.length) {
        pres.push(savedPreset);
    } else {
        pres[db.botPresetsId] = savedPreset;
    }
    db.botPresets = pres;
}

export function copyPreset(id: number) {
    saveCurrentPreset();
    let db = DBState.db;
    let pres = db.botPresets;
    const newPres = safeStructuredClone(pres[id]);
    newPres.name += " Copy";
    db.botPresets.push(newPres);
}

export function changeToPreset(id = 0, savecurrent = true) {
    if (savecurrent) {
        saveCurrentPreset();
    }
    let db = DBState.db;
    let pres = db.botPresets;
    const newPres = pres[id];
    db.botPresetsId = id;
    setPreset(db, newPres);
}

export function setPreset(db: Database, newPres: botPreset) {
    db.apiType = newPres.apiType ?? db.apiType;
    db.localNetworkMode = newPres.localNetworkMode ?? db.localNetworkMode;
    db.localNetworkTimeoutSec = newPres.localNetworkTimeoutSec ?? db.localNetworkTimeoutSec;
    db.mainPrompt = newPres.mainPrompt ?? db.mainPrompt;
    db.jailbreak = newPres.jailbreak ?? db.jailbreak;
    db.globalNote = newPres.globalNote ?? db.globalNote;
    db.temperature = newPres.temperature ?? db.temperature;
    db.maxContext = newPres.maxContext ?? db.maxContext;
    db.maxResponse = newPres.maxResponse ?? db.maxResponse;
    db.frequencyPenalty = newPres.frequencyPenalty ?? db.frequencyPenalty;
    db.PresensePenalty = newPres.PresensePenalty ?? db.PresensePenalty;
    db.formatingOrder = newPres.formatingOrder ?? db.formatingOrder;
    db.aiModel = newPres.aiModel ?? db.aiModel;
    db.subModel = newPres.subModel ?? db.subModel;
    db.currentPluginProvider = newPres.currentPluginProvider ?? db.currentPluginProvider;
    db.textgenWebUIStreamURL = newPres.textgenWebUIStreamURL ?? db.textgenWebUIStreamURL;
    db.textgenWebUIBlockingURL = newPres.textgenWebUIBlockingURL ?? db.textgenWebUIBlockingURL;
    db.forceReplaceUrl = newPres.forceReplaceUrl ?? db.forceReplaceUrl;
    db.promptPreprocess = newPres.promptPreprocess ?? db.promptPreprocess;
    db.bias = newPres.bias ?? db.bias;
    db.koboldURL = newPres.koboldURL ?? db.koboldURL;
    db.proxyKey = newPres.proxyKey ?? db.proxyKey;
    db.ooba = safeStructuredClone(newPres.ooba ?? db.ooba);
    db.ainconfig = safeStructuredClone(newPres.ainconfig ?? db.ainconfig);
    db.openrouterRequestModel = newPres.openrouterRequestModel ?? db.openrouterRequestModel;
    db.proxyRequestModel = newPres.proxyRequestModel ?? db.proxyRequestModel;
    db.NAIsettings = newPres.NAISettings ?? db.NAIsettings;
    db.autoSuggestPrompt = newPres.autoSuggestPrompt ?? db.autoSuggestPrompt;
    db.autoSuggestPrefix = newPres.autoSuggestPrefix ?? db.autoSuggestPrefix;
    db.autoSuggestClean = newPres.autoSuggestClean ?? db.autoSuggestClean;
    db.promptTemplate = normalizePromptTemplate(newPres.promptTemplate);
    db.NAIadventure = newPres.NAIadventure;
    db.NAIappendName = newPres.NAIappendName;
    db.NAIsettings.cfg_scale ??= 1;
    db.NAIsettings.mirostat_tau ??= 0;
    db.NAIsettings.mirostat_lr ??= 1;
    db.localStopStrings = newPres.localStopStrings;
    db.customProxyRequestModel = newPres.customProxyRequestModel ?? "";
    db.reverseProxyOobaArgs = safeStructuredClone(newPres.reverseProxyOobaArgs) ?? {
        mode: "instruct",
    };
    db.top_p = newPres.top_p ?? 1;
    db.promptSettings = safeStructuredClone(newPres.promptSettings) ?? {
        assistantPrefill: "",
        postEndInnerFormat: "",
        sendChatAsSystem: false,
        sendName: false,
        utilOverride: false,
    };
    db.promptSettings.maxThoughtTagDepth ??= -1;
    db.repetition_penalty = newPres.repetition_penalty;
    db.min_p = newPres.min_p;
    db.top_a = newPres.top_a;
    db.openrouterProvider = newPres.openrouterProvider;
    db.useInstructPrompt = newPres.useInstructPrompt ?? false;
    db.customPromptTemplateToggle = newPres.customPromptTemplateToggle ?? "";
    db.templateDefaultVariables = newPres.templateDefaultVariables ?? "";
    db.moduleIntergration = newPres.moduleIntergration ?? "";
    db.top_k = newPres.top_k ?? db.top_k;
    db.instructChatTemplate = newPres.instructChatTemplate ?? db.instructChatTemplate;
    db.JinjaTemplate = newPres.JinjaTemplate ?? db.JinjaTemplate;
    db.jsonSchemaEnabled = newPres.jsonSchemaEnabled ?? false;
    db.jsonSchema = newPres.jsonSchema ?? "";
    db.strictJsonSchema = newPres.strictJsonSchema ?? true;
    db.extractJson = newPres.extractJson ?? "";
    db.groupOtherBotRole = newPres.groupOtherBotRole ?? "user";
    db.groupTemplate = newPres.groupTemplate ?? "";
    db.seperateParametersEnabled = newPres.seperateParametersEnabled ?? false;
    db.customAPIFormat = safeStructuredClone(newPres.customAPIFormat) ?? LLMFormat.OpenAICompatible;
    db.systemContentReplacement = newPres.systemContentReplacement ?? "";
    db.systemRoleReplacement = newPres.systemRoleReplacement ?? "user";
    db.customFlags = safeStructuredClone(newPres.customFlags) ?? [];
    db.enableCustomFlags = newPres.enableCustomFlags ?? false;
    db.presetRegex = newPres.regex ?? [];
    db.reasoningEffort = newPres.reasonEffort ?? 0;
    db.thinkingTokens = newPres.thinkingTokens ?? null;
    db.thinkingType = newPres.thinkingType ?? "budget";
    db.deepseekThinkingType = newPres.deepseekThinkingType ?? "off";
    db.adaptiveThinkingEffort = newPres.adaptiveThinkingEffort ?? "high";
    db.deepseekReasoningEffort = newPres.deepseekReasoningEffort ?? "high";
    db.outputImageModal = newPres.outputImageModal ?? false;
    if (!db.doNotChangeSeperateModels) {
        db.seperateModelsForAxModels = newPres.seperateModelsForAxModels ?? false;
        db.seperateModels = safeStructuredClone(newPres.seperateModels) ?? {
            memory: "",
            emotion: "",
            translate: "",
            otherAx: "",
        };
    }
    if (!db.doNotChangeFallbackModels) {
        db.fallbackModels = safeStructuredClone(newPres.fallbackModels) ?? {
            memory: [],
            emotion: [],
            translate: [],
            otherAx: [],
            model: [],
        };
        db.fallbackWhenBlankResponse = newPres.fallbackWhenBlankResponse ?? false;
    }
    if (db.disableSeperateParameterChangeOnPresetChange) {
        db.seperateParameters = safeStructuredClone(db.seperateParameters);
    } else {
        db.seperateParameters = newPres.seperateParameters
            ? safeStructuredClone(newPres.seperateParameters)
            : {
                  memory: {},
                  emotion: {},
                  translate: {},
                  otherAx: {},
                  overrides: {},
              };
    }
    db.modelTools = safeStructuredClone(newPres.modelTools ?? []);
    db.verbosity = newPres.verbosity ?? 1;
    db.dynamicOutput = newPres.dynamicOutput;

    return db;
}

import { encode as encodeMsgpack, decode as decodeMsgpack } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { decodeRPack, encodeRPack } from "../rpack/rpack_js";
import { DBState, selectedCharID } from "../stores.svelte";
import { LLMFormat } from "../model/modellist";
import { defaultHotkeys } from "../defaulthotkeys";

export async function downloadPreset(id: number, type: "json" | "risupreset" | "return" = "json") {
    saveCurrentPreset();
    let db = getDatabase();
    let pres = safeStructuredClone(db.botPresets[id]);
    console.log(pres);
    pres.openAIKey = "";
    pres.forceReplaceUrl = "";
    pres.forceReplaceUrl2 = "";
    pres.proxyKey = "";
    pres.textgenWebUIStreamURL = "";
    pres.textgenWebUIBlockingURL = "";

    if (type === "json") {
        downloadFile(pres.name + "_preset.json", Buffer.from(JSON.stringify(pres, null, 2)));
    } else if (type === "risupreset" || type === "return") {
        const buf = fflate.compressSync(
            encodeMsgpack({
                presetVersion: 2,
                type: "preset",
                preset: await encryptBuffer(encodeMsgpack(pres), "risupreset"),
            }),
        );

        const buf2 = await encodeRPack(buf);

        if (type === "risupreset") {
            downloadFile(pres.name + "_preset.risup", buf2);
        } else {
            return {
                data: pres,
                buf: buf2,
            };
        }
    }

    alertNormal(language.successExport);

    return {
        data: pres,
        buf: null,
    };
}

export async function importPreset(
    f: {
        name: string;
        data: Uint8Array;
    } | null = null,
) {
    if (!f) {
        f = await selectSingleFile(["json", "preset", "risupreset", "risup"]);
    }
    if (!f) {
        return;
    }
    let pre: any;
    if (f.name.endsWith(".risupreset") || f.name.endsWith(".risup")) {
        let data = f.data;
        if (f.name.endsWith(".risup")) {
            data = await decodeRPack(data);
        }
        const decoded = await decodeMsgpack(fflate.decompressSync(data));
        console.log(decoded);
        if ((decoded.presetVersion === 0 || decoded.presetVersion === 2) && decoded.type === "preset") {
            pre = {
                ...presetTemplate,
                ...decodeMsgpack(Buffer.from(await decryptBuffer(decoded.preset ?? decoded.pres, "risupreset"))),
            };
        }
    } else {
        pre = { ...presetTemplate, ...JSON.parse(Buffer.from(f.data).toString("utf-8")) };
        console.log(pre);
    }
    if (pre?.promptTemplate !== undefined) {
        pre.promptTemplate = normalizePromptTemplate(pre.promptTemplate);
    }
    let db = DBState.db;
    if (pre.presetVersion && pre.presetVersion >= 3) {
        //NAI preset
        const pr = safeStructuredClone(prebuiltPresets.NAI);
        pr.temperature = pre.parameters.temperature * 100;
        pr.maxResponse = pre.parameters.max_length;
        pr.NAISettings.topK = pre.parameters.top_k;
        pr.NAISettings.topP = pre.parameters.top_p;
        pr.NAISettings.topA = pre.parameters.top_a;
        pr.NAISettings.typicalp = pre.parameters.typical_p;
        pr.NAISettings.tailFreeSampling = pre.parameters.tail_free_sampling;
        pr.NAISettings.repetitionPenalty = pre.parameters.repetition_penalty;
        pr.NAISettings.repetitionPenaltyRange = pre.parameters.repetition_penalty_range;
        pr.NAISettings.repetitionPenaltySlope = pre.parameters.repetition_penalty_slope;
        pr.NAISettings.frequencyPenalty = pre.parameters.repetition_penalty_frequency;
        pr.NAISettings.repostitionPenaltyPresence = pre.parameters.repetition_penalty_presence;
        pr.PresensePenalty = pre.parameters.repetition_penalty_presence * 100;
        pr.NAISettings.cfg_scale = pre.parameters.cfg_scale;
        pr.NAISettings.mirostat_lr = pre.parameters.mirostat_lr;
        pr.NAISettings.mirostat_tau = pre.parameters.mirostat_tau;
        pr.name = pre.name ?? "Imported";
        db.botPresets.push(pr);
        return;
    }

    if (Array.isArray(pre?.prompt_order?.[0]?.order) && Array.isArray(pre?.prompts)) {
        //ST preset
        const pr = safeStructuredClone(presetTemplate);
        pr.promptTemplate = [];

        function findPrompt(identifier: number) {
            return pre.prompts.find((p: any) => p.identifier === identifier);
        }
        pr.temperature = (pre.temperature ?? 0.8) * 100;
        pr.frequencyPenalty = (pre.frequency_penalty ?? 0.7) * 100;
        pr.PresensePenalty = pre.presence_penalty * 0.7 * 100;
        pr.top_p = pre.top_p ?? 1;

        for (const prompt of pre.prompt_order[0].order) {
            if (!prompt?.enabled) {
                continue;
            }
            const p = findPrompt(prompt?.identifier ?? "");
            if (p) {
                switch (p.identifier) {
                    case "main": {
                        pr.promptTemplate.push({
                            type: "plain",
                            type2: "main",
                            text: p.content ?? "",
                            role: p.role ?? "system",
                        });
                        break;
                    }
                    case "jailbreak":
                    case "nsfw": {
                        pr.promptTemplate.push({
                            type: "jailbreak",
                            type2: "normal",
                            text: p.content ?? "",
                            role: p.role ?? "system",
                        });
                        break;
                    }
                    case "dialogueExamples":
                    case "charPersonality":
                    case "scenario": {
                        break; //ignore
                    }
                    case "chatHistory": {
                        pr.promptTemplate.push({
                            type: "chat",
                            rangeEnd: "end",
                            rangeStart: 0,
                        });
                        break;
                    }
                    case "worldInfoBefore": {
                        pr.promptTemplate.push({
                            type: "lorebook",
                        });
                        break;
                    }
                    case "worldInfoAfter": {
                        break;
                    }
                    case "charDescription": {
                        pr.promptTemplate.push({
                            type: "description",
                        });
                        break;
                    }
                    case "personaDescription": {
                        pr.promptTemplate.push({
                            type: "persona",
                        });
                        break;
                    }
                    default: {
                        console.log(p);
                        pr.promptTemplate.push({
                            type: "plain",
                            type2: "normal",
                            text: p.content ?? "",
                            role: p.role ?? "system",
                        });
                    }
                }
            } else {
                console.log("Prompt not found", prompt);
            }
        }
        if (pre?.assistant_prefill) {
            pr.promptTemplate.push({
                type: "postEverything",
            });
            pr.promptTemplate.push({
                type: "plain",
                type2: "main",
                text: `{{#if {{prefill_supported}}}}${pre?.assistant_prefill}{{/if}}`,
                role: "bot",
            });
        }
        pr.promptTemplate = normalizePromptTemplate(pr.promptTemplate);
        pr.name = "Imported ST Preset";
        db.botPresets.push(pr);
        return;
    }
    pre.name ??= "Imported";
    if (!Array.isArray(db.botPresets)) {
        db.botPresets = [];
    }
    db.botPresets.push(pre);
}

function normalizePromptRole(role: unknown): "user" | "bot" | "system" | null {
    if (role === "user" || role === "bot" || role === "system") {
        return role;
    }
    if (role === "assistant" || role === "char") {
        return "bot";
    }
    return null;
}

function normalizeCacheRole(role: unknown): "user" | "assistant" | "system" | "all" {
    if (role === "user" || role === "assistant" || role === "system" || role === "all") {
        return role;
    }
    if (role === "bot" || role === "char") {
        return "assistant";
    }
    return "all";
}

function normalizePromptTemplate(template: PromptItem[] | null | undefined): PromptItem[] | null {
    if (!Array.isArray(template)) {
        return null;
    }
    const normalized = safeStructuredClone(template) as any[];
    for (const item of normalized) {
        if (!item || typeof item !== "object") {
            continue;
        }
        switch (item.type) {
            case "plain":
            case "jailbreak":
            case "cot": {
                item.role = normalizePromptRole(item.role) ?? "system";
                break;
            }
            case "persona":
            case "description":
            case "authornote":
            case "memory": {
                if (item.role2 !== undefined && item.role2 !== null) {
                    item.role2 = normalizePromptRole(item.role2) ?? "system";
                }
                break;
            }
            case "cache": {
                item.role = normalizeCacheRole(item.role);
                break;
            }
        }
    }
    return normalized as PromptItem[];
}
