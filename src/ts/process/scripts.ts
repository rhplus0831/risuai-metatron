import { get } from "svelte/store";
import { CharEmotion, selectedCharID } from "../stores.svelte";
import {
    type character,
    type customscript,
    type groupChat,
    getDatabase,
    getCurrentCharacter,
    getCurrentChat,
} from "../storage/database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { alertError, alertNormal } from "../alert";
import { language } from "src/lang";
import { selectSingleFile } from "../util";
import {
    assetRegex,
    type CbsConditions,
    risuChatParser as risuChatParserOrg,
    type simpleCharacterArgument,
} from "../parser/parser.svelte";
import { getModuleAssets, getModuleRegexScripts } from "./modules";
import { HypaProcesser } from "./memory/hypamemory";
import { runLuaEditTrigger } from "./scriptings";
import { capturePluginContext, invokeHook, type PluginCallContext } from "../plugins/apiV3/pluginContext";
import { pluginHooks } from "../plugins/pluginHooks";
import { resetTransformEffects } from "../parser/transformClient";
import { runTrigger } from "./triggers";
import { type ChatRef, currentChatRef, findChat, setMessageText } from "../storage/chatStore.svelte";
import {
    createScriptCache,
    regexScriptCacheKey,
    runRegexScripts,
    type RegexScriptEffect,
    type RegexScriptMode,
} from "../../../shared/scripts/regex.ts";

export type ScriptMode = RegexScriptMode;

export async function processScript(
    char: character | groupChat,
    data: string,
    mode: ScriptMode,
    cbsConditions: CbsConditions = {},
    chatRef?: ChatRef | null,
    pluginContext?: PluginCallContext,
) {
    return (await processScriptFull(char, data, mode, -1, cbsConditions, chatRef, pluginContext)).data;
}

export function exportRegex(s?: customscript[]) {
    let db = getDatabase();
    const script = s ?? db.globalscript;
    const data = Buffer.from(
        JSON.stringify({
            type: "regex",
            data: script,
        }),
        "utf-8",
    );
    downloadFile(`regexscript_export.json`, data);
    alertNormal(language.successExport);
}

export async function importRegex(o?: customscript[]): Promise<customscript[]> {
    o = o ?? [];
    const filedata = (await selectSingleFile(["json"])).data;
    if (!filedata) {
        return o;
    }
    let db = getDatabase();
    try {
        const imported = JSON.parse(Buffer.from(filedata).toString("utf-8"));
        if (imported.type === "regex" && imported.data) {
            const datas: customscript[] = imported.data;
            const script = o;
            for (const data of datas) {
                script.push(data);
            }
            return o;
        } else {
            alertError("File invaid or corrupted");
        }
    } catch (error) {
        alertError(error);
    }
    return o;
}

let bestMatchCache = new Map<string, string>();
const processScriptCache = createScriptCache();

export function resetScriptCache() {
    processScriptCache.reset();
    resetTransformEffects();
}

export async function processScriptFull(
    char: character | groupChat | simpleCharacterArgument,
    data: string,
    mode: ScriptMode,
    chatID = -1,
    cbsConditions: CbsConditions = {},
    chatRef?: ChatRef | null,
    pluginContext: PluginCallContext | undefined = capturePluginContext(chatRef),
) {
    let db = getDatabase();
    let emoChanged = false;
    // `@@inject` writes the message at `chatID` of `chatRef` (the caller's chat; default: the
    // selected one): resolve it to a message id now, before the awaits, so a message removed
    // meanwhile cannot redirect the write.
    const injectTarget = chatID === -1 ? null : (chatRef ?? currentChatRef());
    const injectMessageId = injectTarget ? findChat(injectTarget)?.message[chatID]?.chatId : undefined;
    data = await runLuaEditTrigger(char, mode, data, { index: chatID }, chatRef);

    if (mode === "editdisplay") {
        const currentChar = getCurrentCharacter();
        if (currentChar.type !== "group") {
            try {
                const perf = performance.now();
                const d = await runTrigger(currentChar, "display", {
                    chat: getCurrentChat(),
                    displayMode: true,
                    displayData: data,
                });

                data = d?.displayData ?? data;
                console.log("Trigger time", performance.now() - perf);
            } catch (e) {
                console.error(e);
            }
        }
    }

    if (pluginHooks[mode].size > 0) {
        for (const plugin of pluginHooks[mode]) {
            const res = await invokeHook(plugin, pluginContext, data);
            if (res !== null && res !== undefined) {
                data = res;
            }
        }
    }

    data = risuChatParser(data, { chatID: chatID, cbsConditions, chatRef });
    const scripts = (db.presetRegex ?? []).concat(char.customscript).concat(getModuleRegexScripts(chatRef));
    // Dynamic (`<cbs>`) inputs are expanded for the same chat the scripts then run for, and that chat
    // is part of the key (`chatID` indexes it).
    const parse = (text: string) => risuChatParser(text, { chatID: chatID, cbsConditions, chatRef });
    const hash = regexScriptCacheKey(
        scripts,
        data,
        mode,
        chatID,
        chatRef ? `${chatRef.chaId}/${chatRef.chatId}` : "",
        parse,
    );
    const cached = processScriptCache.get(hash);
    if (cached) {
        return { data: cached, emoChanged: false };
    }

    if (scripts.length === 0) {
        processScriptCache.set(hash, data);
        return { data, emoChanged };
    }

    function applyScriptEffect(effect: RegexScriptEffect) {
        if (effect.kind === "emotion") {
            let charemotions = get(CharEmotion);
            let tempEmotion = charemotions[char.chaId];
            if (!tempEmotion) {
                tempEmotion = [];
            }
            if (tempEmotion.length > 4) {
                tempEmotion.splice(0, 1);
            }
            if (char.type !== "simple") {
                for (const emo of char.emotionImages) {
                    if (emo[0] === effect.name) {
                        const emos: [string, string, number] = [emo[0], emo[1], Date.now()];
                        tempEmotion.push(emos);
                        charemotions[char.chaId] = tempEmotion;
                        CharEmotion.set(charemotions);
                        emoChanged = true;
                        break;
                    }
                }
            }
        } else if (injectTarget && injectMessageId) {
            try {
                setMessageText(injectTarget, injectMessageId, effect.text);
            } catch (error) {
                // The message is being generated (its own stream sets its text).
                console.warn("[Script] @@inject skipped a message being generated", error);
            }
        }
    }

    const result = runRegexScripts(data, scripts, {
        mode,
        chatID,
        parse,
        repeatBackSource: () => {
            // The chat `chatID` indexes: the caller's (`chatRef`), or the selected one.
            const selchar = chatRef
                ? db.characters.find((entry) => entry?.chaId === chatRef.chaId)
                : db.characters[get(selectedCharID)];
            const chat = chatRef ? findChat(chatRef) : selchar.chats[selchar.chatPage];
            let lastChat = chat.fmIndex === -1 ? selchar.firstMessage : selchar.alternateGreetings[chat.fmIndex];
            let pointer = chatID - 1;
            while (pointer >= 0) {
                if (chat.message[pointer].role === chat.message[chatID].role) {
                    lastChat = chat.message[pointer].data;
                    break;
                }
                pointer--;
            }
            return lastChat;
        },
        // Applied where the script matched, as before: later scripts' CBS reads the write.
        applyEffect: applyScriptEffect,
    });
    data = result.data;

    if (
        db.dynamicAssets &&
        (char.type === "simple" || char.type === "character") &&
        char.additionalAssets &&
        char.additionalAssets.length > 0
    ) {
        if (
            (!db.dynamicAssetsEditDisplay && mode === "editdisplay") ||
            mode === "editinput" ||
            mode === "editprocess"
        ) {
            processScriptCache.set(hash, data);
            return { data, emoChanged };
        }
        const assetNames = char.additionalAssets.map((v) => v[0]);

        const moduleAssets = getModuleAssets(chatRef);
        if (moduleAssets.length > 0) {
            for (const asset of moduleAssets) {
                assetNames.push(asset[0]);
            }
        }

        const processer = new HypaProcesser();
        await processer.addText(assetNames);
        const matches = data.matchAll(assetRegex);

        for (const match of matches) {
            const type = match[1];
            const assetName = match[2];
            const cacheKey = char.chaId + "::" + assetName;
            if (type !== "emotion" && type !== "source") {
                if (bestMatchCache.has(cacheKey)) {
                    data = data.replaceAll(match[0], `{{${type}::${bestMatchCache.get(cacheKey)}}}`);
                } else if (!assetNames.includes(assetName)) {
                    const searched = await processer.similaritySearch(assetName);
                    const bestMatch = searched[0];
                    if (bestMatch) {
                        data = data.replaceAll(match[0], `{{${type}::${bestMatch}}}`);
                        bestMatchCache.set(cacheKey, bestMatch);
                    }
                }
            }
        }
    }

    processScriptCache.set(hash, data);

    return { data, emoChanged };
}

const rgx = /(?:{{|<)(.+?)(?:}}|>)/gm;
export const risuChatParser = risuChatParserOrg;
