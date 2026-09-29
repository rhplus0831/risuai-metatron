import { parseChatML } from "../parser/chatML";
import { risuChatParser } from "../parser/parser.svelte";
import {
    getCurrentCharacter,
    getDatabase,
    setCurrentCharacter,
    setDatabase,
    type Chat,
    type character,
} from "../storage/database.svelte";
import { type ChatRef, setChatMeta } from "../storage/chatStore.svelte";
import { tokenize } from "../tokenizer";
import { getModuleTriggers } from "./modules";
import { get } from "svelte/store";
import { ReloadChatPointer, ReloadGUIPointer, selectedCharID, CurrentTriggerIdStore, DBState } from "../stores.svelte";
import { processMultiCommand } from "./command";
import { parseKeyValue, sleep } from "../util";
import { alertInput, alertNormal, alertSelect } from "../alert";
import type { OpenAIChat } from "./index.svelte";
import { HypaProcesser } from "./memory/hypamemory";
import { requestChatData } from "./request/request";
import { generateAIImage } from "./stableDiff";
import { writeInlayImage } from "./files/inlays";
import { runScripted } from "./scriptings";
import { calcString } from "./infunctions";
import type { triggerEffectV2, triggerscript } from "../../../shared/triggers.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";

export type * from "../../../shared/triggers.ts";

type triggerMode = "start" | "manual" | "output" | "input" | "display" | "request";

export type additonalSysPrompt = {
    start: string;
    historyend: string;
    promptend: string;
};

const safeSubset = [
    "v2SetVar",
    "v2If",
    "v2IfAdvanced",
    "v2Else",
    "v2EndIndent",
    "v2LoopNTimes",
    "v2BreakLoop",
    "v2ConsoleLog",
    "v2StopTrigger",
    "v2Random",
    "v2ExtractRegex",
    "v2RegexTest",
    "v2GetCharAt",
    "v2GetCharCount",
    "v2ToLowerCase",
    "v2ToUpperCase",
    "v2SetCharAt",
    "v2SplitString",
    "v2JoinArrayVar",
    "v2ConcatString",
    "v2MakeArrayVar",
    "v2GetArrayVarLength",
    "v2GetArrayVar",
    "v2SetArrayVar",
    "v2PushArrayVar",
    "v2PopArrayVar",
    "v2ShiftArrayVar",
    "v2UnshiftArrayVar",
    "v2SpliceArrayVar",
    "v2SliceArrayVar",
    "v2GetIndexOfValueInArrayVar",
    "v2RemoveIndexFromArrayVar",
    "v2Calculate",
    "v2Comment",
    "v2DeclareLocalVar",
];

export const displayAllowList = ["v2GetDisplayState", "v2SetDisplayState", ...safeSubset];

export const requestAllowList = [
    "v2GetRequestState",
    "v2SetRequestState",
    "v2GetRequestStateRole",
    "v2SetRequestStateRole",
    "v2GetRequestStateLength",
    ...safeSubset,
];

async function collectStreamingText(stream: ReadableStream<{ [key: string]: string }>): Promise<string> {
    const reader = stream.getReader();
    let lastChunk = "";

    while (true) {
        const { done, value } = await reader.read();
        if (value) {
            const firstKey = Object.keys(value)[0];
            if (firstKey) {
                lastChunk = value[firstKey] ?? lastChunk;
            }
        }
        if (done) {
            break;
        }
    }

    return lastChunk;
}

export async function runTrigger(
    char: character,
    mode: triggerMode,
    arg: {
        chat: DeepReadonly<Chat>;
        /**
         * The live chat `chat` is a copy of, captured by the caller: chat variables and the author's
         * note are also written there as the trigger runs. Without it nothing live is written (the
         * caller's `applyChatResult` carries every change).
         */
        chatRef?: ChatRef | null;
        recursiveCount?: number;
        additonalSysPrompt?: additonalSysPrompt;
        stopSending?: boolean;
        manualName?: string;
        triggerId?: string;
        displayMode?: boolean;
        displayData?: string;
        tempVars?: Record<string, string>;
    },
) {
    arg.recursiveCount ??= 0;
    char = arg.displayMode ? char : safeStructuredClone(char);
    let varChanged = false;
    let stopSending = arg.stopSending ?? false;
    const CharacterlowLevelAccess = char.lowLevelAccess ?? false;
    let sendAIprompt = false;
    // The caller's chat: CBS in effects and trigger Lua read it (also in display and request runs).
    const contextRef: ChatRef | null = arg.chatRef ?? null;
    // Chat variables and the author's note are written to it as the trigger runs (so later effects and
    // CBS read them), except in display and request runs; the caller applies the rest of the result.
    const chatTarget: ChatRef | null = arg.displayMode ? null : contextRef;
    const writeChatMeta = (patch: Partial<Chat>) => {
        if (!chatTarget) {
            return;
        }
        try {
            setChatMeta(chatTarget, patch);
        } catch (error) {
            console.warn("[Trigger] The chat is gone; a variable change was not saved", error);
        }
    };
    let additonalSysPrompt: additonalSysPrompt = arg.additonalSysPrompt ?? {
        start: "",
        historyend: "",
        promptend: "",
    };
    const triggers = char.triggerscript
        .map((v) => {
            v.lowLevelAccess = CharacterlowLevelAccess;
            return v;
        })
        .concat(getModuleTriggers(contextRef));
    const db = getDatabase();
    const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(db.templateDefaultVariables));
    // The trigger's working copy. A display run copies only the chat and its message list (it runs
    // for every rendered message); its effects replace messages instead of editing them in place.
    let chat = (
        arg.displayMode
            ? { ...arg.chat, message: [...arg.chat.message] }
            : safeStructuredClone(arg.chat ?? char.chats[char.chatPage])
    ) as Chat;

    const previousTriggerId = get(CurrentTriggerIdStore);
    const shouldSetTriggerId = !arg.displayMode && mode !== "display";
    if (shouldSetTriggerId) {
        CurrentTriggerIdStore.set(arg.triggerId || null);
    }

    if (!triggers || triggers.length === 0) {
        if (shouldSetTriggerId) {
            CurrentTriggerIdStore.set(previousTriggerId);
        }
        return null;
    }

    let tempVars: Record<string, string> = arg.tempVars ?? {};

    let localVarScopes: Record<number, Record<string, string>>[] = [{}];
    let currentIndent = 0;

    function getLocalVar(key: string): string | null {
        if (!localVarScopes || localVarScopes.length === 0) {
            return null;
        }
        const currentScope = localVarScopes[localVarScopes.length - 1];
        if (!currentScope) {
            return null;
        }
        for (let indent = currentIndent; indent >= 0; indent--) {
            if (currentScope[indent] && currentScope[indent][key] !== undefined) {
                const value = currentScope[indent][key];
                return value;
            }
        }
        return null;
    }

    function setLocalVar(key: string, value: string, indent: number): boolean {
        if (!localVarScopes || localVarScopes.length === 0) {
            localVarScopes = [{}];
        }
        const currentScope = localVarScopes[localVarScopes.length - 1];
        if (!currentScope) {
            return false;
        }

        const finalValue = value === null || value === undefined ? "null" : value;

        let foundIndent = -1;
        for (let i = indent; i >= 0; i--) {
            if (currentScope[i] && currentScope[i][key] !== undefined) {
                foundIndent = i;
                break;
            }
        }

        const targetIndent = foundIndent !== -1 ? foundIndent : indent;

        if (!currentScope[targetIndent]) {
            currentScope[targetIndent] = {};
        }

        if (currentScope[targetIndent][key] === finalValue) {
            return false;
        }

        currentScope[targetIndent][key] = finalValue;
        return true;
    }

    function declareLocalVar(key: string, value: string, indent: number) {
        setLocalVar(key, value, indent);
    }

    function clearLocalVarsAtIndent(indent: number) {
        if (!localVarScopes || localVarScopes.length === 0) {
            return;
        }
        const currentScope = localVarScopes[localVarScopes.length - 1];
        if (!currentScope) {
            return;
        }
        const indentsToDelete: string[] = [];
        for (const scopeIndent in currentScope) {
            if (Number(scopeIndent) >= indent) {
                indentsToDelete.push(scopeIndent);
            }
        }
        indentsToDelete.forEach((indentKey) => {
            delete currentScope[indentKey];
        });
    }

    function getVar(key: string) {
        const localVar = getLocalVar(key);
        if (localVar !== null) {
            return localVar;
        }

        const state = chat.scriptstate?.["$" + key];
        if (state === undefined || state === null) {
            const findResult = defaultVariables.find((f) => {
                return f[0] === key;
            });
            if (findResult) {
                return findResult[1];
            }
            if (arg.displayMode) {
                return tempVars[key] ?? "null";
            }
            return "null";
        }
        return state.toString();
    }

    function setVar(key: string, value: string): boolean {
        if (arg.displayMode) {
            if (tempVars[key] === value) {
                return false;
            }
            tempVars[key] = value;
            return true;
        }

        const localVar = getLocalVar(key);
        if (localVar !== null) {
            return setLocalVar(key, value, currentIndent);
        }

        chat.scriptstate ??= {};
        const stateKey = "$" + key;
        if (chat.scriptstate[stateKey] === value) {
            return false;
        }

        varChanged = true;
        chat.scriptstate[stateKey] = value;
        writeChatMeta({ scriptstate: safeStructuredClone(chat.scriptstate) });
        return true;
    }

    for (const trigger of triggers) {
        let tempVars: Record<string, number> = {};

        if (trigger.effect[0]?.type === "triggercode" || trigger.effect[0]?.type === "triggerlua") {
            //
        } else if (arg.manualName) {
            if (trigger.comment !== arg.manualName) {
                continue;
            }
        } else if (mode !== trigger.type) {
            continue;
        }

        // Legacy conditional triggers are no longer supported; skip rather than run unconditionally.
        if (trigger.conditions?.length > 0) {
            continue;
        }

        for (let index = 0; index < trigger.effect.length; index++) {
            const effect = trigger.effect[index];
            if (mode === "display" && !displayAllowList.includes(effect.type)) {
                continue;
            }
            if (mode === "request" && !requestAllowList.includes(effect.type)) {
                continue;
            }

            if (effect && "indent" in effect && typeof effect.indent === "number" && effect.indent >= 0) {
                currentIndent = effect.indent;
            } else if (!effect || !("indent" in effect)) {
                currentIndent = 0;
            }

            switch (effect.type) {
                case "v2StopPromptSending": {
                    stopSending = true;
                    break;
                }

                case "triggerlua": {
                    const triggerCodeResult = await runScripted(effect.code, {
                        chatRef: contextRef,
                        lowLevelAccess: trigger.lowLevelAccess,
                        mode: mode === "manual" ? arg.manualName : mode,
                        setVar: setVar,
                        getVar: getVar,
                        char: char,
                        chat: chat,
                    });

                    if (triggerCodeResult.stopSending) {
                        stopSending = true;
                    }
                    // The script edited this working copy (`runScripted` was given it).
                    chat = triggerCodeResult.chat as Chat;
                    break;
                }

                //V2 triggers
                case "v2Header": {
                    //Header for V2 triggers to identify the start of a new trigger
                    break;
                }
                case "v2SetVar": {
                    const effectValue =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    const varKey = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                    let originalVar = Number(getVar(varKey));
                    if (Number.isNaN(originalVar)) {
                        originalVar = 0;
                    }
                    let resultValue = "";
                    switch (effect.operator) {
                        case "=": {
                            resultValue = effectValue;
                            break;
                        }
                        case "+=": {
                            resultValue = (originalVar + Number(effectValue)).toString();
                            break;
                        }
                        case "-=": {
                            resultValue = (originalVar - Number(effectValue)).toString();
                            break;
                        }
                        case "*=": {
                            resultValue = (originalVar * Number(effectValue)).toString();
                            break;
                        }
                        case "/=": {
                            resultValue = (originalVar / Number(effectValue)).toString();
                            break;
                        }
                        case "%=": {
                            resultValue = (originalVar % Number(effectValue)).toString();
                            break;
                        }
                    }
                    setVar(varKey, resultValue);
                    break;
                }
                case "v2DeclareLocalVar": {
                    const effectValue =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    const varKey = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                    const finalValue = effectValue === null || effectValue === undefined ? "null" : effectValue;
                    declareLocalVar(varKey, finalValue, effect.indent);
                    break;
                }
                case "v2If":
                case "v2IfAdvanced": {
                    const sourceValue =
                        effect.type === "v2If" || effect.sourceType === "var"
                            ? getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }))
                            : risuChatParser(effect.source, { chara: char, chatRef: contextRef });
                    const targetValue =
                        effect.targetType === "value"
                            ? risuChatParser(effect.target, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.target, { chara: char, chatRef: contextRef }));
                    let pass = false;
                    switch (effect.condition) {
                        case "=": {
                            if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) {
                                //to check like 1.0 = 1
                                pass = Number(sourceValue) === Number(targetValue);
                            } else {
                                pass = sourceValue === targetValue;
                            }
                            break;
                        }
                        case "!=": {
                            if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) {
                                //to check like 1.0 = 1
                                pass = Number(sourceValue) !== Number(targetValue);
                            } else {
                                pass = sourceValue !== targetValue;
                            }
                            break;
                        }
                        case ">": {
                            pass = Number(sourceValue) > Number(targetValue);
                            break;
                        }
                        case "<": {
                            pass = Number(sourceValue) < Number(targetValue);
                            break;
                        }
                        case ">=": {
                            pass = Number(sourceValue) >= Number(targetValue);
                            break;
                        }
                        case "<=": {
                            pass = Number(sourceValue) <= Number(targetValue);
                            break;
                        }
                        case "∈": {
                            try {
                                pass = JSON.parse(targetValue).includes(sourceValue);
                            } catch (error) {
                                pass = false;
                            }
                            break;
                        }
                        case "∋": {
                            try {
                                pass = JSON.parse(sourceValue).includes(targetValue);
                            } catch (error) {
                                pass = false;
                            }
                            break;
                        }
                        case "∉": {
                            try {
                                pass = !JSON.parse(targetValue).includes(sourceValue);
                            } catch (error) {
                                pass = true;
                            }
                            break;
                        }
                        case "∌": {
                            try {
                                pass = !JSON.parse(sourceValue).includes(targetValue);
                            } catch (error) {
                                pass = true;
                            }
                            break;
                        }
                        case "≒": {
                            const num1 = Number(sourceValue);
                            const num2 = Number(targetValue);
                            if (Number.isNaN(num1) || Number.isNaN(num2)) {
                                pass =
                                    sourceValue.toLocaleLowerCase().replace(/ /g, "") ===
                                    targetValue.toLocaleLowerCase().replace(/ /g, "");
                            } else {
                                pass = Math.abs(num1 - num2) < 0.0001;
                            }
                            break;
                        }
                        case "≡": {
                            if (targetValue === "true") {
                                pass = sourceValue === "true" || sourceValue === "1";
                            } else if (targetValue === "false") {
                                pass = !(sourceValue === "true" || sourceValue === "1");
                            } else {
                                pass = sourceValue === targetValue;
                            }
                        }
                    }

                    if (!pass) {
                        let indent = effect.indent + 1;
                        for (; index < trigger.effect.length; index++) {
                            const ef = trigger.effect[index] as triggerEffectV2;
                            if (ef.type === "v2EndIndent" && indent === ef.indent) {
                                const nextEf = trigger.effect[index + 1] as triggerEffectV2;
                                indent--;
                                if (nextEf?.type === "v2Else" && nextEf?.indent === indent) {
                                    index++;
                                }

                                break;
                            }
                        }
                    }
                    break;
                }
                case "v2Else": {
                    //since if handles the else if the if is false, we can skip the else
                    const indent = effect.indent + 1;
                    for (; index < trigger.effect.length; index++) {
                        const ef = trigger.effect[index] as triggerEffectV2;
                        if (ef.type === "v2EndIndent" && indent === ef.indent) {
                            break;
                        }
                    }
                    break;
                }
                case "v2EndIndent": {
                    if (effect.endOfLoop) {
                        const indent = effect.indent - 1;
                        const originalIndex = index;
                        for (; index >= 0; index--) {
                            const ef = trigger.effect[index] as triggerEffectV2;
                            if ((ef.type === "v2Loop" || ef.type === "v2LoopNTimes") && indent === ef.indent) {
                                if (ef.type === "v2LoopNTimes") {
                                    let value =
                                        ef.valueType === "value"
                                            ? risuChatParser(ef.value, { chara: char, chatRef: contextRef })
                                            : getVar(risuChatParser(ef.value, { chara: char, chatRef: contextRef }));
                                    let valueNum = Number(value);
                                    if (Number.isNaN(valueNum)) {
                                        valueNum = 0;
                                    }
                                    tempVars[index + "LoopNTimes"] = (tempVars[index + "LoopNTimes"] ?? 0) + 1;
                                    if (tempVars[index + "LoopNTimes"] >= valueNum) {
                                        index = originalIndex;
                                    } else {
                                        break;
                                    }
                                }

                                break;
                            }
                        }

                        //this is for preventing lagging
                        tempVars["loopTimes"] = (tempVars["loopTimes"] ?? 0) + 1;
                        if (tempVars["loopTimes"] > 100) {
                            await sleep(1);
                            tempVars["loopTimes"] = 0;
                        }
                    }

                    clearLocalVarsAtIndent(effect.indent);

                    break;
                }
                case "v2Loop":
                case "v2LoopNTimes": {
                    //Looping is handled by the v2EndIndent
                    break;
                }
                case "v2BreakLoop": {
                    for (; index < trigger.effect.length; index++) {
                        const ef = trigger.effect[index] as triggerEffectV2;
                        if (ef.type === "v2EndIndent" && ef.endOfLoop) {
                            break;
                        }
                    }
                    break;
                }
                case "v2RunTrigger": {
                    if (arg.recursiveCount < 10 || trigger.lowLevelAccess) {
                        arg.recursiveCount++;
                        const r = await runTrigger(char, "manual", {
                            chat,
                            chatRef: chatTarget,
                            recursiveCount: arg.recursiveCount,
                            additonalSysPrompt,
                            stopSending,
                            manualName: effect.target,
                        });
                        if (r) {
                            additonalSysPrompt = r.additonalSysPrompt;
                            chat = r.chat;
                            stopSending = r.stopSending;
                        }
                    }
                    break;
                }
                case "v2ConsoleLog": {
                    const sourceValue =
                        effect.sourceType === "value"
                            ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                    console.log(sourceValue);
                    break;
                }
                case "v2StopTrigger": {
                    index = trigger.effect.length;
                    break;
                }
                case "v2CutChat": {
                    let start =
                        effect.startType === "value"
                            ? Number(risuChatParser(effect.start, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.start, { chara: char, chatRef: contextRef })));
                    let end =
                        effect.endType === "value"
                            ? Number(risuChatParser(effect.end, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.end, { chara: char, chatRef: contextRef })));
                    if (isNaN(start)) {
                        start = 0;
                    }
                    if (isNaN(end)) {
                        end = chat.message.length;
                    }

                    chat.message = chat.message.slice(start, end);
                    break;
                }
                case "v2ModifyChat": {
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    if (chat.message[index]) {
                        chat.message[index] = { ...chat.message[index], data: value };
                    }
                    break;
                }
                case "v2SystemPrompt": {
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    additonalSysPrompt[effect.location] += value + "\n\n";
                    break;
                }
                case "v2Impersonate": {
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    if (effect.role === "user") {
                        chat.message.push({ role: "user", data: value });
                    } else if (effect.role === "char") {
                        chat.message.push({ role: "char", data: value });
                    }
                    break;
                }
                case "v2Command": {
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    // Its writes go to this trigger's chat (display runs cannot run commands).
                    await processMultiCommand(value, chatTarget ?? undefined);
                    break;
                }
                case "v2SendAIprompt": {
                    if (!trigger.lowLevelAccess) {
                        break;
                    }
                    sendAIprompt = true;
                    break;
                }
                case "v2ImgGen": {
                    if (!trigger.lowLevelAccess) {
                        break;
                    }
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    let negValue =
                        effect.negValueType === "value"
                            ? risuChatParser(effect.negValue, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.negValue, { chara: char, chatRef: contextRef }));
                    let gen = await generateAIImage(value, char, negValue, "inlay");
                    if (!gen) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "null");
                        break;
                    }
                    let imgHTML = new Image();
                    imgHTML.src = gen;
                    let inlay = await writeInlayImage(imgHTML);
                    let res = `{{inlay::${inlay}}}`;
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), res);
                    break;
                }
                case "v2CheckSimilarity": {
                    if (!trigger.lowLevelAccess) {
                        break;
                    }
                    let source =
                        effect.sourceType === "value"
                            ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    let processer = new HypaProcesser();
                    await processer.addText(value.split("§"));
                    let val = await processer.similaritySearch(source);
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), val.join("§"));
                    break;
                }
                case "v2RunLLM": {
                    if (!trigger.lowLevelAccess) {
                        break;
                    }
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    let promptbody = parseChatML(value);
                    if (!promptbody) {
                        promptbody = [{ role: "user", content: value }];
                    }
                    let result = await requestChatData(
                        {
                            formated: promptbody,
                            bias: {},
                            useStreaming: effect.streaming ?? false,
                            noMultiGen: true,
                            chatRef: contextRef,
                        },
                        effect.model,
                    );

                    if (result.type === "fail" || result.type === "multiline") {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "null");
                    } else if (result.type === "streaming") {
                        const text = await collectStreamingText(result.result);
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), text);
                    } else {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), result.result);
                    }
                    break;
                }
                case "v2ShowAlert": {
                    if (arg.displayMode) {
                        return;
                    }
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    alertNormal(value);
                    break;
                }
                case "v2ExtractRegex": {
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    let regexValue =
                        effect.regexType === "value"
                            ? risuChatParser(effect.regex, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.regex, { chara: char, chatRef: contextRef }));
                    let flagsValue =
                        effect.flagsType === "value"
                            ? risuChatParser(effect.flags, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.flags, { chara: char, chatRef: contextRef }));
                    let regex = new RegExp(regexValue, flagsValue);
                    let regexResult = regex.exec(value);
                    let resultValue =
                        effect.resultType === "value"
                            ? risuChatParser(effect.result, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.result, { chara: char, chatRef: contextRef }));

                    let result = "";
                    if (regexResult !== null) {
                        result = resultValue
                            .replace(/\$[0-9]+/g, (match) => {
                                let index = Number(match.slice(1));
                                return regexResult[index] || "";
                            })
                            .replace(/\$&/g, regexResult[0] || "")
                            .replace(/\$\$/g, "$");
                    } else {
                        result = resultValue
                            .replace(/\$[0-9]+/g, "")
                            .replace(/\$&/g, "")
                            .replace(/\$\$/g, "$");
                    }

                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), result);
                    break;
                }
                case "v2GetLastMessage": {
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        chat.message[chat.message.length - 1]?.data ?? "null",
                    );
                    break;
                }
                case "v2GetMessageAtIndex": {
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        chat.message[index]?.data ?? "null",
                    );
                    break;
                }
                case "v2GetMessageCount": {
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        chat.message.length.toString(),
                    );
                    break;
                }
                case "v2ModifyLorebook": {
                    char.globalLore = char.globalLore ?? [];
                    const target =
                        effect.targetType === "value"
                            ? risuChatParser(effect.target, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.target, { chara: char, chatRef: contextRef }));
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));

                    const index = char.globalLore.findIndex((v) => v[0] === target);
                    if (index !== -1) {
                        char.globalLore[index][1] = value;
                    }

                    const db = getDatabase();
                    const selectedCharId = get(selectedCharID);
                    db.characters[selectedCharId].globalLore = char.globalLore;
                    setCurrentCharacter(db.characters[selectedCharId]);
                    break;
                }
                case "v2GetLorebook": {
                    char.globalLore = char.globalLore ?? [];
                    const target =
                        effect.targetType === "value"
                            ? risuChatParser(effect.target, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.target, { chara: char, chatRef: contextRef }));
                    const index = char.globalLore.findIndex((v) => v[0] === target);
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        index === -1 ? "null" : char.globalLore[index][1],
                    );
                    break;
                }
                case "v2GetLorebookCount": {
                    char.globalLore = char.globalLore ?? [];
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        char.globalLore.length.toString(),
                    );
                    break;
                }
                case "v2GetLorebookEntry": {
                    char.globalLore = char.globalLore ?? [];
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    if (Number.isNaN(index)) {
                        index = 0;
                    }
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        char.globalLore[index]?.[1] ?? "null",
                    );
                    break;
                }
                case "v2SetLorebookActivation": {
                    char.globalLore = char.globalLore ?? [];
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    let value = effect.value;
                    char.globalLore[index][2] = value;

                    const selectedCharId = get(selectedCharID);
                    const db = getDatabase();
                    db.characters[selectedCharId].globalLore = char.globalLore;
                    setCurrentCharacter(char);

                    break;
                }
                case "v2GetLorebookIndexViaName": {
                    char.globalLore = char.globalLore ?? [];
                    let name =
                        effect.nameType === "value"
                            ? risuChatParser(effect.name, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.name, { chara: char, chatRef: contextRef }));
                    let index = char.globalLore.findIndex((v) => v[0] === name);
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), index.toString());
                    break;
                }
                case "v2Random": {
                    let min =
                        effect.minType === "value"
                            ? Number(risuChatParser(effect.min, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.min, { chara: char, chatRef: contextRef })));
                    let max =
                        effect.maxType === "value"
                            ? Number(risuChatParser(effect.max, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.max, { chara: char, chatRef: contextRef })));

                    let output = Math.floor(Math.random() * (max - min + 1) + min);
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), output.toString());
                    break;
                }
                case "v2GetCharAt": {
                    let source =
                        effect.sourceType === "value"
                            ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        source[index] ?? "null",
                    );
                    break;
                }
                case "v2GetCharCount": {
                    let source =
                        effect.sourceType === "value"
                            ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        source.length.toString(),
                    );
                    break;
                }
                case "v2ToLowerCase": {
                    let source =
                        effect.sourceType === "value"
                            ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        source.toLowerCase(),
                    );
                    break;
                }
                case "v2ToUpperCase": {
                    let source =
                        effect.sourceType === "value"
                            ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        source.toUpperCase(),
                    );
                    break;
                }
                case "v2SetCharAt": {
                    let source =
                        effect.sourceType === "value"
                            ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    const source2 = [...source];
                    source2[index] = value;
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), source2.join(""));
                    break;
                }
                case "v2SplitString": {
                    let source =
                        effect.sourceType === "value"
                            ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                    let delimiter: string;

                    if (effect.delimiterType === "value") {
                        delimiter = risuChatParser(effect.delimiter, { chara: char, chatRef: contextRef });
                    } else if (effect.delimiterType === "var") {
                        delimiter = getVar(risuChatParser(effect.delimiter, { chara: char, chatRef: contextRef }));
                    } else {
                        delimiter = risuChatParser(effect.delimiter, { chara: char, chatRef: contextRef });
                    }

                    let result: string[];
                    if (effect.delimiterType === "regex") {
                        try {
                            const regexMatch = delimiter.match(/^\/(.+)\/([gimuy]*)$/);
                            if (regexMatch) {
                                const [, pattern, flags] = regexMatch;
                                const regex = new RegExp(pattern, flags);
                                result = source.split(regex);
                            } else {
                                const regex = new RegExp(delimiter);
                                result = source.split(regex);
                            }
                        } catch (error) {
                            result = [source];
                        }
                    } else {
                        result = source.split(delimiter);
                    }

                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        JSON.stringify(result),
                    );
                    break;
                }
                case "v2JoinArrayVar": {
                    try {
                        let varValue =
                            effect.varType === "value"
                                ? risuChatParser(effect.var, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }));
                        let arr = JSON.parse(varValue);
                        let delimiter =
                            effect.delimiterType === "value"
                                ? risuChatParser(effect.delimiter, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.delimiter, { chara: char, chatRef: contextRef }));
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            arr.join(delimiter),
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "");
                    }
                    break;
                }
                case "v2GetCharacterDesc": {
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), char.desc);
                    break;
                }
                case "v2SetCharacterDesc": {
                    let value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    char.desc = value;
                    const selectedCharId = get(selectedCharID);
                    const db = getDatabase();
                    (db.characters[selectedCharId] as character).desc = value;
                    setCurrentCharacter(char);
                    break;
                }
                case "v2GetPersonaDesc": {
                    const db = getDatabase();
                    const currentPersonaPrompt = db.personaPrompt ?? "";
                    const savedPersonaPrompt = db.personas[db.selectedPersona]?.personaPrompt ?? "";
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        currentPersonaPrompt || savedPersonaPrompt,
                    );
                    break;
                }
                case "v2SetPersonaDesc": {
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    if (DBState.db.personas[DBState.db.selectedPersona]) {
                        DBState.db.personas[DBState.db.selectedPersona].personaPrompt = value;
                        DBState.db.personaPrompt = value;
                    }
                    break;
                }
                case "v2GetReplaceGlobalNote": {
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        char.replaceGlobalNote ?? "",
                    );
                    break;
                }
                case "v2SetReplaceGlobalNote": {
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    char.replaceGlobalNote = value;
                    const selectedCharId = get(selectedCharID);
                    const db = getDatabase();
                    (db.characters[selectedCharId] as character).replaceGlobalNote = value;
                    setCurrentCharacter(char);
                    break;
                }
                case "v2MakeArrayVar": {
                    const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                    if (varName.startsWith("[") && varName.endsWith("]")) {
                        return;
                    }

                    setVar(varName, "[]");
                    break;
                }
                case "v2GetArrayVarLength": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            arr.length.toString(),
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "0");
                    }
                    break;
                }
                case "v2GetArrayVar": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        let index =
                            effect.indexType === "value"
                                ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                                : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            arr[index] ?? "null",
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "null");
                    }
                    break;
                }
                case "v2PushArrayVar": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        let value =
                            effect.valueType === "value"
                                ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                        arr.push(value);
                        setVar(varName, JSON.stringify(arr));
                    } catch (error) {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        setVar(varName, "[]");
                    }
                    break;
                }
                case "v2PopArrayVar": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            arr.pop() ?? "null",
                        );
                        setVar(varName, JSON.stringify(arr));
                    } catch (error) {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        setVar(varName, "[]");
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "null");
                    }
                    break;
                }
                case "v2ShiftArrayVar": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            arr.shift() ?? "null",
                        );
                        setVar(varName, JSON.stringify(arr));
                    } catch (error) {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        setVar(varName, "[]");
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "null");
                    }
                    break;
                }
                case "v2UnshiftArrayVar": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        let value =
                            effect.valueType === "value"
                                ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                        arr.unshift(value);
                        setVar(varName, JSON.stringify(arr));
                    } catch (error) {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        setVar(varName, "[]");
                    }
                    break;
                }
                case "v2SpliceArrayVar": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        let start =
                            effect.startType === "value"
                                ? Number(risuChatParser(effect.start, { chara: char, chatRef: contextRef }))
                                : Number(getVar(risuChatParser(effect.start, { chara: char, chatRef: contextRef })));
                        let value =
                            effect.itemType === "value"
                                ? risuChatParser(effect.item, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.item, { chara: char, chatRef: contextRef }));
                        arr.splice(start, 0, value);
                        setVar(varName, JSON.stringify(arr));
                    } catch (error) {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        setVar(varName, "[]");
                    }
                    break;
                }
                case "v2SliceArrayVar": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        let start =
                            effect.startType === "value"
                                ? Number(risuChatParser(effect.start, { chara: char, chatRef: contextRef }))
                                : Number(getVar(risuChatParser(effect.start, { chara: char, chatRef: contextRef })));
                        let end =
                            effect.endType === "value"
                                ? Number(risuChatParser(effect.end, { chara: char, chatRef: contextRef }))
                                : Number(getVar(risuChatParser(effect.end, { chara: char, chatRef: contextRef })));

                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            JSON.stringify(arr.slice(start, end)),
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "[]");
                    }
                    break;
                }
                case "v2GetIndexOfValueInArrayVar": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        let value =
                            effect.valueType === "value"
                                ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            arr.indexOf(value).toString(),
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "-1");
                    }
                    break;
                }
                case "v2RemoveIndexFromArrayVar": {
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        let index =
                            effect.indexType === "value"
                                ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                                : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                        arr.splice(index, 1);
                        setVar(varName, JSON.stringify(arr));
                    } catch (error) {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        setVar(varName, "[]");
                    }
                    break;
                }
                case "v2ConcatString": {
                    let source1 =
                        effect.source1Type === "value"
                            ? risuChatParser(effect.source1, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source1, { chara: char, chatRef: contextRef }));
                    let source2 =
                        effect.source2Type === "value"
                            ? risuChatParser(effect.source2, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.source2, { chara: char, chatRef: contextRef }));
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), source1 + source2);
                    break;
                }
                case "v2GetLastUserMessage": {
                    let lastUserMessage = chat.message
                        .slice()
                        .reverse()
                        .find((v) => v.role === "user");
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        lastUserMessage?.data ?? "null",
                    );
                    break;
                }
                case "v2GetLastCharMessage": {
                    let lastCharMessage = chat.message
                        .slice()
                        .reverse()
                        .find((v) => v.role === "char");
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        lastCharMessage?.data ?? "null",
                    );
                    break;
                }
                case "v2GetFirstMessage": {
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        chat.fmIndex === -1 ? char.firstMessage : char.alternateGreetings[chat.fmIndex],
                    );
                    break;
                }
                case "v2GetAlertInput": {
                    if (arg.displayMode) {
                        return;
                    }
                    let value = await alertInput(
                        effect.displayType === "value"
                            ? risuChatParser(effect.display, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.display, { chara: char, chatRef: contextRef })),
                    );
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), value);
                    break;
                }
                case "v2GetAlertSelect": {
                    if (arg.displayMode) {
                        return;
                    }
                    const display =
                        effect.displayType === "value"
                            ? risuChatParser(effect.display, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.display, { chara: char, chatRef: contextRef }));
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    const options = value.split("|");
                    let result = await alertSelect(options, display);
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), result);
                    break;
                }
                case "v2SetArrayVar": {
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    const index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    if (Number.isNaN(index)) {
                        break;
                    }
                    try {
                        const varName = risuChatParser(effect.var, { chara: char, chatRef: contextRef });
                        let varValue = getVar(varName);
                        let arr = JSON.parse(varValue);
                        arr[index] = value;
                        setVar(varName, JSON.stringify(arr));
                    } catch (error) {}
                    break;
                }
                case "v2GetDisplayState": {
                    if (!arg.displayMode) {
                        return;
                    }

                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        arg.displayData ?? "null",
                    );
                    break;
                }
                case "v2SetDisplayState": {
                    if (!arg.displayMode) {
                        return;
                    }
                    arg.displayData =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    break;
                }
                case "v2UpdateGUI": {
                    ReloadGUIPointer.set(get(ReloadGUIPointer) + 1);
                    break;
                }
                case "v2UpdateChatAt": {
                    ReloadChatPointer.update((v) => {
                        v[effect.index] = (v[effect.index] ?? 0) + 1;
                        return v;
                    });
                    break;
                }
                case "v2Wait": {
                    let value =
                        effect.valueType === "value"
                            ? Number(risuChatParser(effect.value, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef })));
                    await sleep(value * 1000);
                    break;
                }
                case "v2GetRequestState": {
                    if (!arg.displayMode) {
                        return;
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[];
                    const index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    const content = json?.[index]?.content ?? "null";
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), content);
                    break;
                }
                case "v2SetRequestState": {
                    if (!arg.displayMode) {
                        return;
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[];
                    const index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    json[index].content = value;
                    arg.displayData = JSON.stringify(json);
                    break;
                }
                case "v2GetRequestStateRole": {
                    if (!arg.displayMode) {
                        return;
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[];
                    const index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    const content = json?.[index]?.role ?? "null";
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), content);
                    break;
                }
                case "v2SetRequestStateRole": {
                    if (!arg.displayMode) {
                        return;
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[];
                    const index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    if (value === "user" || value === "assistant" || value === "system") {
                        json[index].role = value;
                    }
                    arg.displayData = JSON.stringify(json);
                    break;
                }

                case "v2GetRequestStateLength": {
                    if (!arg.displayMode) {
                        return;
                    }
                    const json = JSON.parse(arg.displayData) as OpenAIChat[];
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        json.length.toString(),
                    );
                    break;
                }
                case "v2QuickSearchChat": {
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    const depth =
                        effect.depthType === "value"
                            ? Number(risuChatParser(effect.depth, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.depth, { chara: char, chatRef: contextRef })));
                    const condition = effect.condition;

                    if (isNaN(depth)) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "0");
                        break;
                    }
                    let pass = false;
                    let da = chat.message
                        .slice(0 - depth)
                        .map((v) => v.data)
                        .join(" ");
                    if (condition === "strict") {
                        pass = da.split(" ").includes(value);
                    } else if (condition === "loose") {
                        pass = da.toLowerCase().includes(value.toLowerCase());
                    } else if (condition === "regex") {
                        pass = new RegExp(value).test(da);
                    }
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), pass ? "1" : "0");
                    break;
                }
                case "v2Tokenize": {
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        (await tokenize(value)).toString(),
                    );
                    break;
                }
                case "v2GetAllLorebooks": {
                    char.globalLore = char.globalLore ?? [];
                    const allPrompts: string[] = [];
                    for (const lore of char.globalLore) {
                        if (lore && lore.content !== undefined) {
                            allPrompts.push(lore.content);
                        }
                    }
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        JSON.stringify(allPrompts),
                    );
                    break;
                }
                case "v2GetLorebookByName": {
                    char.globalLore = char.globalLore ?? [];
                    const name =
                        effect.nameType === "value"
                            ? risuChatParser(effect.name, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.name, { chara: char, chatRef: contextRef }));
                    const regex = new RegExp(name, "i");
                    const matchingIndices: number[] = [];
                    for (let i = 0; i < char.globalLore.length; i++) {
                        const lore = char.globalLore[i];
                        if (lore && lore.comment !== undefined && regex.test(lore.comment)) {
                            matchingIndices.push(i);
                        }
                    }
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        JSON.stringify(matchingIndices),
                    );
                    break;
                }
                case "v2GetLorebookByIndex": {
                    char.globalLore = char.globalLore ?? [];
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));
                    if (Number.isNaN(index) || index < 0 || index >= char.globalLore.length) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "null");
                    } else {
                        const loreEntry = char.globalLore[index];
                        if (loreEntry && loreEntry.content !== undefined) {
                            setVar(
                                risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                                loreEntry.content,
                            );
                        } else {
                            setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "null");
                        }
                    }
                    break;
                }
                case "v2CreateLorebook": {
                    char.globalLore = char.globalLore ?? [];
                    const name =
                        effect.nameType === "value"
                            ? risuChatParser(effect.name, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.name, { chara: char, chatRef: contextRef }));
                    const key =
                        effect.keyType === "value"
                            ? risuChatParser(effect.key, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.key, { chara: char, chatRef: contextRef }));
                    const content =
                        effect.contentType === "value"
                            ? risuChatParser(effect.content, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.content, { chara: char, chatRef: contextRef }));
                    const insertOrder =
                        effect.insertOrderType === "value"
                            ? Number(risuChatParser(effect.insertOrder, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.insertOrder, { chara: char, chatRef: contextRef })));

                    char.globalLore.push({
                        key: key,
                        comment: name,
                        content: content,
                        mode: "normal",
                        insertorder: Number.isNaN(insertOrder) ? 100 : insertOrder,
                        alwaysActive: false,
                        secondkey: "",
                        selective: false,
                    });

                    const selectedCharId = get(selectedCharID);
                    const db = getDatabase();
                    db.characters[selectedCharId].globalLore = char.globalLore;
                    setCurrentCharacter(char);
                    break;
                }
                case "v2ModifyLorebookByIndex": {
                    char.globalLore = char.globalLore ?? [];
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));

                    if (
                        Number.isNaN(index) ||
                        index < 0 ||
                        index >= char.globalLore.length ||
                        !char.globalLore[index]
                    ) {
                        break;
                    }

                    const currentLore = char.globalLore[index];

                    let name =
                        effect.nameType === "value"
                            ? risuChatParser(effect.name, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.name, { chara: char, chatRef: contextRef }));
                    name = name.replace(/{{slot}}/g, currentLore.comment || "");
                    char.globalLore[index].comment = name;

                    let key =
                        effect.keyType === "value"
                            ? risuChatParser(effect.key, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.key, { chara: char, chatRef: contextRef }));
                    key = key.replace(/{{slot}}/g, currentLore.key || "");
                    char.globalLore[index].key = key;

                    let content =
                        effect.contentType === "value"
                            ? risuChatParser(effect.content, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.content, { chara: char, chatRef: contextRef }));
                    content = content.replace(/{{slot}}/g, currentLore.content || "");
                    char.globalLore[index].content = content;

                    let insertOrder =
                        effect.insertOrderType === "value"
                            ? risuChatParser(effect.insertOrder, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.insertOrder, { chara: char, chatRef: contextRef }));
                    insertOrder = insertOrder.replace(/{{slot}}/g, (currentLore.insertorder || 100).toString());
                    const insertOrderNum = Number(insertOrder);
                    if (!Number.isNaN(insertOrderNum)) {
                        char.globalLore[index].insertorder = insertOrderNum;
                    }

                    const selectedCharId = get(selectedCharID);
                    const db = getDatabase();
                    db.characters[selectedCharId].globalLore = char.globalLore;
                    setCurrentCharacter(char);
                    break;
                }
                case "v2DeleteLorebookByIndex": {
                    char.globalLore = char.globalLore ?? [];
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));

                    if (
                        Number.isNaN(index) ||
                        index < 0 ||
                        index >= char.globalLore.length ||
                        !char.globalLore[index]
                    ) {
                        break;
                    }

                    char.globalLore.splice(index, 1);

                    const selectedCharId = get(selectedCharID);
                    const db = getDatabase();
                    db.characters[selectedCharId].globalLore = char.globalLore;
                    setCurrentCharacter(char);
                    break;
                }
                case "v2GetLorebookCountNew": {
                    char.globalLore = char.globalLore ?? [];
                    setVar(
                        risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                        char.globalLore.length.toString(),
                    );
                    break;
                }
                case "v2SetLorebookAlwaysActive": {
                    char.globalLore = char.globalLore ?? [];
                    let index =
                        effect.indexType === "value"
                            ? Number(risuChatParser(effect.index, { chara: char, chatRef: contextRef }))
                            : Number(getVar(risuChatParser(effect.index, { chara: char, chatRef: contextRef })));

                    if (
                        Number.isNaN(index) ||
                        index < 0 ||
                        index >= char.globalLore.length ||
                        !char.globalLore[index]
                    ) {
                        break;
                    }

                    char.globalLore[index].alwaysActive = effect.value;

                    const selectedCharId = get(selectedCharID);
                    const db = getDatabase();
                    db.characters[selectedCharId].globalLore = char.globalLore;
                    setCurrentCharacter(char);
                    break;
                }
                case "v2RegexTest": {
                    try {
                        const value =
                            effect.valueType === "value"
                                ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                        const regexPattern =
                            effect.regexType === "value"
                                ? risuChatParser(effect.regex, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.regex, { chara: char, chatRef: contextRef }));
                        const flags =
                            effect.flagsType === "value"
                                ? risuChatParser(effect.flags, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.flags, { chara: char, chatRef: contextRef }));
                        const regex = new RegExp(regexPattern, flags);
                        const result = regex.test(value);
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            result ? "1" : "0",
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "0");
                    }
                    break;
                }
                case "v2GetAuthorNote": {
                    setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), chat.note ?? "");
                    break;
                }
                case "v2SetAuthorNote": {
                    const value =
                        effect.valueType === "value"
                            ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                            : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                    chat.note = value;
                    writeChatMeta({ note: value });
                    break;
                }
                case "v2MakeDictVar": {
                    if (effect.var.startsWith("{") && effect.var.endsWith("}")) {
                        return;
                    }

                    setVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }), "{}");
                    break;
                }
                case "v2GetDictVar": {
                    try {
                        let varValue =
                            effect.varType === "value"
                                ? risuChatParser(effect.var, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }));
                        let dict = JSON.parse(varValue);
                        let key =
                            effect.keyType === "value"
                                ? risuChatParser(effect.key, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.key, { chara: char, chatRef: contextRef }));
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            dict[key] ?? "null",
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "null");
                    }
                    break;
                }
                case "v2SetDictVar": {
                    try {
                        const value =
                            effect.valueType === "value"
                                ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                        const key =
                            effect.keyType === "value"
                                ? risuChatParser(effect.key, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.key, { chara: char, chatRef: contextRef }));

                        if (effect.varType === "value") {
                            break;
                        }

                        let varValue = getVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }));
                        let dict = JSON.parse(varValue);
                        dict[key] = value;
                        setVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }), JSON.stringify(dict));
                    } catch (error) {
                        if (effect.varType === "var") {
                            const value =
                                effect.valueType === "value"
                                    ? risuChatParser(effect.value, { chara: char, chatRef: contextRef })
                                    : getVar(risuChatParser(effect.value, { chara: char, chatRef: contextRef }));
                            const key =
                                effect.keyType === "value"
                                    ? risuChatParser(effect.key, { chara: char, chatRef: contextRef })
                                    : getVar(risuChatParser(effect.key, { chara: char, chatRef: contextRef }));
                            let dict = {};
                            dict[key] = value;
                            setVar(
                                risuChatParser(effect.var, { chara: char, chatRef: contextRef }),
                                JSON.stringify(dict),
                            );
                        }
                    }
                    break;
                }
                case "v2DeleteDictKey": {
                    try {
                        if (effect.varType === "value") {
                            break;
                        }

                        let varValue = getVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }));
                        let dict = JSON.parse(varValue);
                        let key =
                            effect.keyType === "value"
                                ? risuChatParser(effect.key, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.key, { chara: char, chatRef: contextRef }));
                        delete dict[key];
                        setVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }), JSON.stringify(dict));
                    } catch (error) {
                        if (effect.varType === "var") {
                            setVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }), "{}");
                        }
                    }
                    break;
                }
                case "v2HasDictKey": {
                    try {
                        let varValue =
                            effect.varType === "value"
                                ? risuChatParser(effect.var, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }));
                        let dict = JSON.parse(varValue);
                        let key =
                            effect.keyType === "value"
                                ? risuChatParser(effect.key, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.key, { chara: char, chatRef: contextRef }));
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            Object.hasOwn(dict, key) ? "1" : "0",
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "0");
                    }
                    break;
                }
                case "v2ClearDict": {
                    if (effect.var.startsWith("{") && effect.var.endsWith("}")) {
                        return;
                    }
                    setVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }), "{}");
                    break;
                }
                case "v2GetDictSize": {
                    try {
                        let varValue =
                            effect.varType === "value"
                                ? risuChatParser(effect.var, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }));
                        let dict = JSON.parse(varValue);
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            Object.keys(dict).length.toString(),
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "0");
                    }
                    break;
                }
                case "v2GetDictKeys": {
                    try {
                        let varValue =
                            effect.varType === "value"
                                ? risuChatParser(effect.var, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }));
                        let dict = JSON.parse(varValue);
                        let keys = Object.keys(dict);
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            JSON.stringify(keys),
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "[]");
                    }
                    break;
                }
                case "v2GetDictValues": {
                    try {
                        let varValue =
                            effect.varType === "value"
                                ? risuChatParser(effect.var, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.var, { chara: char, chatRef: contextRef }));
                        let dict = JSON.parse(varValue);
                        let values = Object.values(dict);
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            JSON.stringify(values),
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "[]");
                    }
                    break;
                }
                case "v2Calculate": {
                    try {
                        let expression =
                            effect.expressionType === "value"
                                ? risuChatParser(effect.expression, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.expression, { chara: char, chatRef: contextRef }));
                        expression = expression.replace(/\$([a-zA-Z0-9_]+)/g, (_, varName) => {
                            const varValue = getVar(varName);
                            const parsed = parseFloat(varValue);
                            return isNaN(parsed) ? "0" : parsed.toString();
                        });

                        const result = calcString(expression);
                        setVar(
                            risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }),
                            result.toString(),
                        );
                    } catch (error) {
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), "0");
                    }
                    break;
                }
                case "v2ReplaceString": {
                    try {
                        const source =
                            effect.sourceType === "value"
                                ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                        const regexPattern =
                            effect.regexType === "value"
                                ? risuChatParser(effect.regex, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.regex, { chara: char, chatRef: contextRef }));
                        const resultFormat =
                            effect.resultType === "value"
                                ? risuChatParser(effect.result, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.result, { chara: char, chatRef: contextRef }));
                        const replacement =
                            effect.replacementType === "value"
                                ? risuChatParser(effect.replacement, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.replacement, { chara: char, chatRef: contextRef }));
                        const flags =
                            effect.flagsType === "value"
                                ? risuChatParser(effect.flags, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.flags, { chara: char, chatRef: contextRef }));

                        const regex = new RegExp(regexPattern, flags);
                        const result = source.replace(regex, (...args) => {
                            const match = args[0];
                            const groups = args.slice(1, -2);

                            const targetGroupMatch = resultFormat.match(/^\$(\d+)$/);
                            if (targetGroupMatch) {
                                const targetIndex = Number(targetGroupMatch[1]);
                                if (targetIndex === 0) {
                                    return replacement;
                                } else {
                                    const targetGroup = groups[targetIndex - 1];
                                    if (targetGroup) {
                                        return match.replace(targetGroup, replacement);
                                    }
                                }
                            }

                            return resultFormat
                                .replace(/\$[0-9]+/g, (placeholder) => {
                                    const index = Number(placeholder.slice(1));
                                    return index === 0 ? match : groups[index - 1] || "";
                                })
                                .replace(/\$&/g, match)
                                .replace(/\$\$/g, "$");
                        });
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), result);
                    } catch (error) {
                        const source =
                            effect.sourceType === "value"
                                ? risuChatParser(effect.source, { chara: char, chatRef: contextRef })
                                : getVar(risuChatParser(effect.source, { chara: char, chatRef: contextRef }));
                        setVar(risuChatParser(effect.outputVar, { chara: char, chatRef: contextRef }), source);
                    }
                    break;
                }
                case "v2Comment": {
                    break;
                }
            }
        }
    }

    let caculatedTokens = 0;
    if (additonalSysPrompt.start) {
        caculatedTokens += await tokenize(additonalSysPrompt.start);
    }
    if (additonalSysPrompt.historyend) {
        caculatedTokens += await tokenize(additonalSysPrompt.historyend);
    }
    if (additonalSysPrompt.promptend) {
        caculatedTokens += await tokenize(additonalSysPrompt.promptend);
    }
    if (varChanged) {
        ReloadGUIPointer.set(get(ReloadGUIPointer) + 1);
    }

    if (shouldSetTriggerId && mode !== "manual") {
        CurrentTriggerIdStore.set(previousTriggerId);
    }

    return {
        additonalSysPrompt,
        chat,
        tokens: caculatedTokens,
        stopSending,
        sendAIprompt,
        displayData: arg.displayData,
        tempVars: arg.tempVars,
    };
}
