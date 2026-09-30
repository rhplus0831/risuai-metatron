import { get } from "svelte/store";
import { checkNullish, decryptBuffer, encryptBuffer, selectSingleFile } from "../util";
import { changeLanguage, language } from "../../lang";
import { downloadFile, saveAsset as saveImageGlobal } from "../globalApi.svelte";
import { defaultAutoSuggestPrompt, defaultJailbreak, defaultMainPrompt } from "./defaultPrompts";
import { alertNormal } from "../alert";
import { prebuiltNAIpresets, prebuiltPresets } from "../process/templates/templates";
import {
    defaultAIN,
    defaultOoba,
    newPresetId,
    normalizePreset,
    normalizePresets,
    normalizePromptTemplate,
    presetTemplate,
} from "../../../shared/presets.ts";
import { safeStructuredClone } from "../polyfill";
import { markCharacterDirtyAt } from "./resourceSync.svelte";
import type { botPreset, Chat, character, Database, groupChat, Message } from "../../../shared/database.ts";

//APP_VERSION_POINT is to locate the app version in the database file for version bumping
export let appVer = "2026.8.250"; //<APP_VERSION_POINT>
export let appSubVer = "";

export type * from "../../../shared/database.ts";
export { defaultAIN, defaultOoba, presetTemplate };
export type { DeepReadonly } from "../../../shared/readonly.ts";

/**
 * Installs `data` as `DBState.db` after the client-side defaults that remain: the Phase 1
 * collection guards, the removed-feature deletions, and the residual `root` fields
 * (`RESIDUAL_ROOT_KEYS`: the preset and persona working copies and the selection indexes, until
 * the forwarding slices of Phase 3 remove them). The sections and the small collections arrive
 * normalized by the server (`server/src/data/normalize/`), which owns their defaults.
 */
export function setDatabase(data: Database) {
    // Risu Account was removed; drop the login token older saves still carry.
    delete (data as Database & { account?: unknown }).account;
    // Cold storage was removed; drop its flag and the orphaned plugin-storage pointer map.
    delete (data as Database & { coldstorage?: unknown }).coldstorage;
    // Remote saving was removed with the save file; drop its flag.
    delete (data as Database & { enableRemoteSaving?: unknown }).enableRemoteSaving;
    if (data.pluginCustomStorage) {
        delete data.pluginCustomStorage._coldplugin;
    }
    if (checkNullish(data.characters)) {
        data.characters = [];
    }
    if (checkNullish(data.apiType)) {
        data.apiType = "gemini-3-flash-preview";
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
    if (checkNullish(data.username)) {
        data.username = "User";
    }
    if (checkNullish(data.userIcon)) {
        data.userIcon = "";
    }
    if (checkNullish(data.userNote)) {
        data.userNote = "";
    }
    if (checkNullish(data.forceReplaceUrl)) {
        data.forceReplaceUrl = "";
    }
    if (checkNullish(data.currentPluginProvider)) {
        data.currentPluginProvider = "";
    }
    if (checkNullish(data.plugins)) {
        data.plugins = [];
    }
    if (checkNullish(data.textgenWebUIStreamURL)) {
        data.textgenWebUIStreamURL = "wss://localhost/api/";
    }
    if (checkNullish(data.textgenWebUIBlockingURL)) {
        data.textgenWebUIBlockingURL = "https://localhost/api/";
    }
    if (checkNullish(data.subModel)) {
        data.subModel = "gemini-3-flash-preview";
    }
    if (checkNullish(data.proxyKey)) {
        data.proxyKey = "";
    }
    // Every preset gets an id and the canonical fields (ids are assigned at creation from Phase 3 on;
    // this also backstops records saved before that). An empty list becomes one default preset.
    data.botPresets = normalizePresets(data.botPresets);
    if (checkNullish(data.botPresetsId)) {
        data.botPresetsId = 0;
    }
    if (Array.isArray(data.promptTemplate)) {
        data.promptTemplate = normalizePromptTemplate(data.promptTemplate);
    }
    if (checkNullish(data.bias)) {
        data.bias = [];
    }
    if (checkNullish(data.loreBookPage) || (data.loreBook?.length ?? 0) < data.loreBookPage) {
        data.loreBookPage = 0;
    }
    data.autoSuggestPrompt ??= defaultAutoSuggestPrompt;
    if (!data.formatingOrder.includes("personaPrompt")) {
        data.formatingOrder.splice(data.formatingOrder.indexOf("main"), 0, "personaPrompt");
    }
    data.selectedPersona ??= 0;
    data.personaPrompt ??= "";
    data.ooba ??= safeStructuredClone(defaultOoba);
    data.ainconfig ??= safeStructuredClone(defaultAIN);
    data.openrouterRequestModel ??= "openai/gpt-3.5-turbo";
    data.NAIsettings ??= safeStructuredClone(prebuiltNAIpresets);
    data.NAIsettings.starter ??= "";
    data.NAIadventure ??= false;
    data.NAIappendName ??= true;
    data.NAIsettings.cfg_scale ??= 1;
    data.NAIsettings.mirostat_tau ??= 0;
    data.NAIsettings.mirostat_lr ??= 1;
    data.customProxyRequestModel ??= "";
    data.localNetworkMode ??= false;
    if (typeof data.localNetworkMode !== "boolean") {
        data.localNetworkMode = false;
    }
    data.localNetworkTimeoutSec ??= 600;
    if (typeof data.localNetworkTimeoutSec !== "number" || Number.isNaN(data.localNetworkTimeoutSec)) {
        data.localNetworkTimeoutSec = 600;
    }
    data.presetRegex ??= [];
    data.reverseProxyOobaArgs ??= {
        mode: "instruct",
    };
    data.top_p ??= 1;
    if (typeof data.top_p !== "number") {
        //idk why type changes, but it does so this is a fix
        data.top_p = 1;
    }
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
    data.modules ??= [];
    data.repetition_penalty ??= 1;
    data.min_p ??= 0;
    data.top_a ??= 0;
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
    data.openrouterProvider ??= {
        order: [],
        only: [],
        ignore: [],
    };
    data.useInstructPrompt ??= false;
    data.customPromptTemplateToggle ??= "";
    data.templateDefaultVariables ??= "";
    data.strictJsonSchema ??= true;
    data.groupOtherBotRole ??= "user";
    data.customAPIFormat ??= LLMFormat.OpenAICompatible;
    data.systemContentReplacement ??= `system: {{slot}}`;
    data.systemRoleReplacement ??= "user";
    data.seperateParametersEnabled ??= false;
    data.customFlags ??= [];
    data.enableCustomFlags ??= false;
    data.reasoningEffort ??= 0;
    data.verbosity ??= 1;
    data.thinkingType ??= "budget";
    data.deepseekThinkingType ??= "off";
    data.adaptiveThinkingEffort ??= "high";
    data.deepseekReasoningEffort ??= "high";
    data.modelTools ??= [];

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

/**
 * Replaces a character's own fields with `char`'s, for the character with `char.chaId` (the one a
 * caller captured, not whatever is selected now). The mirror keeps its chats, selection, and render
 * key: chats are written only through the chat module, and a caller's copy may hold stale ones.
 */
export function setCurrentCharacter(char: character | groupChat) {
    if (!DBState.db.characters) {
        DBState.db.characters = [];
    }
    const index = DBState.db.characters.findIndex((entry) => entry?.chaId === char.chaId);
    if (index === -1) {
        return;
    }
    replaceCharacterFields(index, char);
    // It may no longer be the selected character, which alone the save adapter watches.
    markCharacterDirtyAt(index);
}

export function getCharacterByIndex(index: number, options: getDatabaseOptions = {}): character | groupChat {
    const db = getDatabase(options);
    if (!db.characters) {
        db.characters = [];
    }
    const char = db.characters?.[index];
    return char;
}

/** `setCurrentCharacter` for the character at an index (the mirror's chats are kept the same way). */
export function setCharacterByIndex(index: number, char: character | groupChat) {
    if (!DBState.db.characters) {
        DBState.db.characters = [];
    }
    replaceCharacterFields(index, char);
    markCharacterDirtyAt(index);
}

function replaceCharacterFields(index: number, char: character | groupChat) {
    const current = DBState.db.characters[index];
    if (current === char) {
        return;
    }
    if (!current) {
        DBState.db.characters[index] = char;
        return;
    }
    DBState.db.characters[index] = {
        ...char,
        chats: current.chats,
        chatPage: current.chatPage,
        reloadKeys: current.reloadKeys,
    } as character | groupChat;
}

export function getCurrentChat() {
    const char = getCurrentCharacter();
    return char?.chats?.[char.chatPage];
}

export const saveImage = saveImageGlobal;

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
    const current = pres?.[db.botPresetsId];
    // Only the canonical preset fields, normalized, so the saved text is what the server keeps.
    const savedPreset = normalizePreset(
        {
            name: current?.name,
            apiType: db.apiType,
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
        } satisfies Omit<botPreset, "id">,
        { id: current?.id ?? newPresetId() },
    );

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
    const source = $state.snapshot(pres[id]);
    db.botPresets.push(normalizePreset({ ...source, name: `${source.name} Copy` }, { id: newPresetId() }));
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

export function setPreset(db: Database, newPres: Omit<botPreset, "id">) {
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

export async function downloadPreset(id: number, type: "json" | "risupreset" | "return" = "json") {
    saveCurrentPreset();
    let db = getDatabase();
    let pres = safeStructuredClone(db.botPresets[id]);
    // The `.risup` format carries no id (D5); the credentials are blanked as before.
    delete pres.id;
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
        db.botPresets.push(normalizePreset(pr, { id: newPresetId() }));
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
        db.botPresets.push(normalizePreset(pr, { id: newPresetId() }));
        return;
    }
    pre.name ??= "Imported";
    if (!Array.isArray(db.botPresets)) {
        db.botPresets = [];
    }
    // An imported preset always gets a fresh id, even when the file carries one.
    db.botPresets.push(normalizePreset(pre, { id: newPresetId() }));
}
