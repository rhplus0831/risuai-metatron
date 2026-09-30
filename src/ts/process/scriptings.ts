import { asBuffer } from "src/ts/util";
import { getChatVarOf, getGlobalChatVar, getGlobalChatVarOf, setChatVarOf } from "../parser/chatVar.svelte";
import { hasher, type simpleCharacterArgument, risuChatParser } from "../parser/parser.svelte";
import { LuaEngine, LuaFactory } from "wasmoon";
import {
    getCurrentCharacter,
    getCurrentChat,
    getDatabase,
    setDatabase,
    type Chat,
    type character,
    type groupChat,
    type loreBook,
    type Message,
    type triggerscript,
} from "../storage/database.svelte";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import {
    appendMessage,
    type ChatRef,
    currentChatRef,
    findChat,
    removeMessages,
    replaceChat,
    replaceMessage,
    setChatMeta,
    setMessageText,
} from "../storage/chatStore.svelte";
import { get } from "svelte/store";
import { DBState, ReloadChatPointer, ReloadGUIPointer, selectedCharID } from "../stores.svelte";
import { alertSelect, alertError, alertInput, alertNormal, alertConfirm } from "../alert";
import { HypaProcesser } from "./memory/hypamemory";
import { generateAIImage } from "./stableDiff";
import { writeInlayImage, getInlayAsset } from "./files/inlays";
import type { OpenAIChat, MultiModal } from "./index.svelte";
import { requestChatData, type StreamResponseChunk } from "./request/request";
import { v4 } from "uuid";
import { getModuleLorebooks, getModuleTriggers } from "./modules";
import { Mutex } from "../mutex";
import { tokenize } from "../tokenizer";
import { fetchNative, readImage } from "../globalApi.svelte";
import { loadLoreBookV3Prompt } from "./lorebook.svelte";
import { getPersonaPrompt, getUserName, getUserIcon } from "../util";
import { findCharacter, updateCharacter } from "../storage/characterStore.svelte";
let luaFactory: LuaFactory;
let ScriptingSafeIds = new Set<string>();
let ScriptingEditDisplayIds = new Set<string>();
let ScriptingLowLevelIds = new Set<string>();
let lastRequestResetTime = 0;
let lastRequestsCount = 0;

interface BasicScriptingEngineState {
    code?: string;
    mutex: Mutex;
    chat?: DeepReadonly<Chat>;
    /**
     * Set when `chat` is the live selected chat (edit hooks, buttons): chat writes go through the
     * chat module. Unset when a trigger passed its own working copy, which the script edits directly.
     */
    chatRef?: ChatRef | null;
    /** The chat CBS parses read (`cbs`): the live chat, or the chat a trigger's working copy is of. */
    contextRef?: ChatRef | null;
    setVar?: (key: string, value: string) => boolean | void;
    getVar?: (key: string) => string;
    /**
     * The character the run executes for (its `char` argument, else the selection at entry; in a
     * group send, the speaking member): the character getters and setters address it by this id.
     * Unset for a `simple` argument (a run without a writable character). Set on every run, since
     * engines are reused.
     */
    characterId?: string;
    /** The run's character argument as given, for the calls that take a whole character (`generateImage`). */
    runCharacter?: character | groupChat | simpleCharacterArgument;
}

interface ScriptingEngineState extends BasicScriptingEngineState {
    engine?: LuaEngine;
}

let ScriptingEngines = new Map<string, ScriptingEngineState>();
let luaFactoryPromise: Promise<void> | null = null;
let pendingEngineCreations = new Map<string, Promise<ScriptingEngineState>>();

export async function runScripted(
    code: string,
    arg: {
        char?: character | groupChat | simpleCharacterArgument;
        chat?: DeepReadonly<Chat>;
        /** The live chat to run on (default: the selected chat); ignored when `chat` (a working copy) is given. */
        chatRef?: ChatRef | null;
        data?: string | OpenAIChat[];
        setVar?: (key: string, value: string) => boolean | void;
        getVar?: (key: string) => string;
        lowLevelAccess?: boolean;
        meta?: object;
        mode?: string;
    },
) {
    const char = arg.char ?? getCurrentCharacter();
    // The run's character by id, captured before the first await (the argument object may change meanwhile).
    const characterId = char && char.type !== "simple" ? char.chaId : undefined;
    const data = arg.data ?? "";
    const meta = arg.meta ?? {};
    const mode = arg.mode ?? "manual";

    const chatRef = arg.chat ? null : (arg.chatRef ?? currentChatRef());
    let chat = arg.chat ?? (chatRef ? findChat(chatRef) : getCurrentChat());
    const contextRef = arg.chatRef ?? chatRef;
    // Chat variables follow the chat this run captured (a trigger passes its own working-copy
    // accessors), never whatever is selected when a callback runs.
    const setVar = arg.setVar ?? ((key: string, value: string) => setChatVarOf(chatRef, key, value));
    const getVar = arg.getVar ?? ((key: string) => getChatVarOf(chatRef, key));
    let stopSending = false;
    let lowLevelAccess = arg.lowLevelAccess ?? false;

    await ensureLuaFactory();
    let ScriptingEngineState = await getOrCreateEngineState(mode);

    return await ScriptingEngineState.mutex.runExclusive(async () => {
        ScriptingEngineState.chat = chat;
        ScriptingEngineState.chatRef = chatRef;
        ScriptingEngineState.contextRef = contextRef;
        ScriptingEngineState.setVar = setVar;
        ScriptingEngineState.getVar = getVar;
        ScriptingEngineState.characterId = characterId;
        ScriptingEngineState.runCharacter = char;
        if (code !== ScriptingEngineState.code) {
            console.log("Creating new Lua engine for mode:", mode);
            ScriptingEngineState.engine?.global.close();
            ScriptingEngineState.code = code;
            ScriptingEngineState.engine = await luaFactory.createEngine({ injectObjects: true });
            const luaEngine = ScriptingEngineState.engine;
            const declareAPI = (name: string, func: Function) => {
                luaEngine.global.set(name, func);
            };
            /**
             * The chat the script reads: the live chat as it is now (looked up on every call, since a
             * replacement or reload installs a new object), or the caller's working copy.
             */
            /** The character the run's chat belongs to (the selected one when the run has no chat ref). */
            const engineCharacter = () => {
                const ref = ScriptingEngineState.contextRef;
                return ref
                    ? getDatabase().characters.find((entry) => entry?.chaId === ref.chaId)
                    : getDatabase().characters[get(selectedCharID)];
            };
            /** The mirror record of the run's character (`characterId`), read at call time; none for a `simple` run. */
            const runCharacter = () => {
                const id = ScriptingEngineState.characterId;
                return id ? findCharacter(id) : undefined;
            };
            const engineChat = (): DeepReadonly<Chat> =>
                (ScriptingEngineState.chatRef ? findChat(ScriptingEngineState.chatRef) : undefined) ??
                ScriptingEngineState.chat;
            declareAPI("getChatVar", (id: string, key: string) => {
                return ScriptingEngineState.getVar(key);
            });
            declareAPI("setChatVar", (id: string, key: string, value: string) => {
                if (!ScriptingSafeIds.has(id) && !ScriptingEditDisplayIds.has(id)) {
                    return;
                }
                ScriptingEngineState.setVar(key, value);
            });
            declareAPI("setChatVarChanged", (id: string, key: string, value: string) => {
                if (!ScriptingSafeIds.has(id) && !ScriptingEditDisplayIds.has(id)) {
                    return;
                }
                if (ScriptingEngineState.setVar(key, value) === true) {
                    return true;
                }
            });
            declareAPI("getGlobalVar", (id: string, key: string) => {
                const ref = ScriptingEngineState.contextRef;
                return ref ? getGlobalChatVarOf(ref, key) : getGlobalChatVar(key);
            });
            declareAPI("stopChat", (id: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                stopSending = true;
            });
            declareAPI("alertError", (id: string, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                alertError(value);
            });
            declareAPI("alertNormal", (id: string, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                alertNormal(value);
            });
            declareAPI("alertInput", (id: string, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                return alertInput(value);
            });
            declareAPI("alertSelect", (id: string, value: string[]) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                return alertSelect(value);
            });
            declareAPI("alertConfirm", (id: string, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                return alertConfirm(value).then((res) => (res ? true : false));
            });

            declareAPI("getChatMain", (id: string, index: number) => {
                const chat = engineChat().message.at(index);
                if (!chat) {
                    return JSON.stringify(null);
                }
                const data = {
                    role: chat.role,
                    data: chat.data,
                    time: chat.time ?? 0,
                };
                return JSON.stringify(data);
            });

            declareAPI("getChatData", (id: string, index: number) => {
                const chat = engineChat().message.at(index);
                return chat?.data ?? "";
            });

            declareAPI("getChatRole", (id: string, index: number) => {
                const chat = engineChat().message.at(index);
                return chat?.role ?? "";
            });

            declareAPI("getRecentChatsMain", (id: string, count: number) => {
                const chats = engineChat().message;
                const safeCount = Math.max(0, Math.floor(count || 0));
                const start = Math.max(0, chats.length - safeCount);
                return JSON.stringify(
                    chats.slice(start).map((v) => ({
                        role: v.role,
                        data: v.data,
                        time: v.time ?? 0,
                    })),
                );
            });

            // On the live chat (`chatRef`) these write through the chat module, resolving the index to
            // a message id when called; a write the module refuses (a message being generated) is
            // skipped with a warning. On a trigger's working copy they edit the copy.
            /** The trigger's working copy (no `chatRef`); its message objects may be shared, so replace them. */
            const workingCopy = () => ScriptingEngineState.chat as Chat;
            const replaceCopyMessage = (index: number, message: DeepReadonly<Message>) => {
                const messages = workingCopy().message;
                messages[index < 0 ? messages.length + index : index] = message as Message;
            };
            const liveWrite = (write: (ref: ChatRef) => void) => {
                try {
                    write(ScriptingEngineState.chatRef!);
                } catch (error) {
                    console.warn("[Lua] A chat change was refused", error);
                }
            };
            declareAPI("setChat", (id: string, index: number, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                const message = engineChat().message?.at(index);
                if (!message) {
                    return;
                }
                if (ScriptingEngineState.chatRef) {
                    liveWrite((ref) => setMessageText(ref, message.chatId, value ?? ""));
                } else {
                    replaceCopyMessage(index, { ...message, data: value ?? "" });
                }
            });
            declareAPI("setChatRole", (id: string, index: number, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                const message = engineChat().message?.at(index);
                if (!message) {
                    return;
                }
                const role: "user" | "char" = value === "user" ? "user" : "char";
                if (ScriptingEngineState.chatRef) {
                    liveWrite((ref) => replaceMessage(ref, { ...JSON.parse(JSON.stringify(message)), role }));
                } else {
                    replaceCopyMessage(index, { ...message, role });
                }
            });
            declareAPI("cutChat", (id: string, start: number, end: number) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                const messages = engineChat().message;
                if (ScriptingEngineState.chatRef) {
                    const kept = new Set(messages.slice(start, end));
                    const removed = messages.filter((message) => !kept.has(message)).map((message) => message.chatId);
                    liveWrite((ref) => removeMessages(ref, removed));
                } else {
                    workingCopy().message = workingCopy().message.slice(start, end);
                }
            });
            declareAPI("removeChat", (id: string, index: number) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                if (ScriptingEngineState.chatRef) {
                    const message = engineChat().message.at(index);
                    if (message) {
                        liveWrite((ref) => removeMessages(ref, [message.chatId]));
                    }
                } else {
                    workingCopy().message.splice(index, 1);
                }
            });
            declareAPI("addChat", (id: string, role: string, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                let roleData: "user" | "char" = role === "user" ? "user" : "char";
                if (ScriptingEngineState.chatRef) {
                    liveWrite((ref) => appendMessage(ref, { role: roleData, data: value ?? "" }));
                } else {
                    workingCopy().message.push({ role: roleData, data: value ?? "" });
                }
            });
            declareAPI("insertChat", (id: string, index: number, role: string, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                let roleData: "user" | "char" = role === "user" ? "user" : "char";
                if (ScriptingEngineState.chatRef) {
                    // Where `splice(index, 0, ...)` would insert.
                    const messages = engineChat().message;
                    const position =
                        index < 0 ? Math.max(messages.length + index, 0) : Math.min(index, messages.length);
                    const anchor = position === 0 ? { start: true as const } : { after: messages[position - 1].chatId };
                    liveWrite((ref) => appendMessage(ref, { role: roleData, data: value ?? "" }, { anchor }));
                } else {
                    workingCopy().message.splice(index, 0, { role: roleData, data: value ?? "" });
                }
            });

            declareAPI("getTokens", async (id: string, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                return await tokenize(value);
            });

            declareAPI("getChatLength", (id: string) => {
                return engineChat().message.length;
            });

            declareAPI("getFullChatMain", (id: string) => {
                const data = JSON.stringify(
                    engineChat().message.map((v) => {
                        return {
                            role: v.role,
                            data: v.data,
                            time: v.time ?? 0,
                        };
                    }),
                );
                return data;
            });

            declareAPI("sleep", (id: string, time: number) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                return new Promise((resolve) => {
                    setTimeout(() => {
                        resolve(true);
                    }, time);
                });
            });

            declareAPI("cbs", (value) => {
                return risuChatParser(value, {
                    chara: engineCharacter(),
                    chatRef: ScriptingEngineState.contextRef,
                });
            });

            declareAPI("setFullChatMain", (id: string, value: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                const realValue = JSON.parse(value);
                const messages = realValue.map((v) => {
                    return {
                        role: v.role,
                        data: v.data,
                    };
                });
                if (ScriptingEngineState.chatRef) {
                    // A whole-list replacement (the messages get new ids, as before).
                    liveWrite((ref) =>
                        replaceChat(ref, {
                            ...JSON.parse(JSON.stringify(engineChat())),
                            message: messages,
                        }),
                    );
                } else {
                    workingCopy().message = messages;
                }
            });

            declareAPI("logMain", (value: string) => {
                console.log(JSON.parse(value));
            });

            declareAPI("reloadDisplay", (id: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                ReloadGUIPointer.set(get(ReloadGUIPointer) + 1);
            });

            declareAPI("reloadChat", (id: string, index: number) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                ReloadChatPointer.update((v) => {
                    v[index] = (v[index] ?? 0) + 1;
                    return v;
                });
            });

            //Low Level Access
            declareAPI("similarity", async (id: string, source: string, value: string[]) => {
                if (!ScriptingLowLevelIds.has(id)) {
                    return;
                }
                const processer = new HypaProcesser();
                await processer.addText(value);
                return await processer.similaritySearch(source);
            });

            declareAPI("request", async (id: string, url: string) => {
                if (!ScriptingLowLevelIds.has(id)) {
                    return;
                }

                if (lastRequestResetTime + 60000 < Date.now()) {
                    lastRequestsCount = 0;
                    lastRequestResetTime = Date.now();
                }

                if (lastRequestsCount > 5) {
                    return JSON.stringify({
                        status: 429,
                        data: "Too many requests. you can request 5 times per minute",
                    });
                }

                lastRequestsCount++;

                try {
                    //for security and other reasons, only get request in 120 char is allowed
                    if (url.length > 120) {
                        return JSON.stringify({
                            status: 413,
                            data: "URL to large. max is 120 characters",
                        });
                    }

                    if (!url.startsWith("https://")) {
                        return JSON.stringify({
                            status: 400,
                            data: "Only https requests are allowed",
                        });
                    }

                    const bannedURL = ["https://realm.risuai.net", "https://risuai.net", "https://risuai.xyz"];

                    for (const burl of bannedURL) {
                        if (url.startsWith(burl)) {
                            return JSON.stringify({
                                status: 400,
                                data: "request to " + url + " is not allowed",
                            });
                        }
                    }

                    //browser fetch
                    const d = await fetchNative(url, {
                        method: "GET",
                    });
                    const text = await d.text();
                    return JSON.stringify({
                        status: d.status,
                        data: text,
                    });
                } catch (error) {
                    return JSON.stringify({
                        status: 400,
                        data: "internal error",
                    });
                }
            });

            declareAPI("generateImage", async (id: string, value: string, negValue: string = "") => {
                if (!ScriptingLowLevelIds.has(id)) {
                    return;
                }
                const target = runCharacter() ?? ScriptingEngineState.runCharacter;
                const gen = await generateAIImage(value, target as character, negValue, "inlay");
                if (!gen) {
                    return "Error: Image generation failed";
                }
                const imgHTML = new Image();
                imgHTML.src = gen;
                const inlay = await writeInlayImage(imgHTML);
                return `{{inlay::${inlay}}}`;
            });

            declareAPI("getCharacterImageMain", async (id: string) => {
                try {
                    const db = getDatabase();
                    const selectedChar = get(selectedCharID);

                    if (selectedChar < 0 || selectedChar >= db.characters.length) {
                        return "";
                    }

                    const character = db.characters[selectedChar];

                    if (!character || character.type === "group" || !character.image) {
                        return "";
                    }

                    const img = await readImage(character.image);
                    const imgObj = new Image();
                    const extention = character.image.split(".").at(-1);

                    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], { type: `image/${extention}` }));

                    const imgid = await writeInlayImage(imgObj, {
                        name: character.image,
                        ext: extention,
                        id: character.image,
                    });

                    if (imgid) {
                        return `{{inlayed::${imgid}}}`;
                    }
                    console.warn("Failed to create character image inlay");
                    return "";
                } catch (error) {
                    console.error("Error in getCharacterImageMain:", error);
                    return "";
                }
            });

            declareAPI("getPersonaImageMain", async (id: string) => {
                try {
                    const icon = getUserIcon();

                    if (!icon) {
                        return "";
                    }

                    const img = await readImage(icon);
                    const imgObj = new Image();
                    const extention = icon.split(".").at(-1);

                    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], { type: `image/${extention}` }));

                    const imgid = await writeInlayImage(imgObj, { name: icon, ext: extention, id: icon });

                    if (imgid) {
                        return `{{inlayed::${imgid}}}`;
                    }

                    console.warn("Failed to create character image inlay");
                    return "";
                } catch (error) {
                    console.error("Error in getCharacterImageMain:", error);
                    return "";
                }
            });

            declareAPI("hash", async (id: string, value: string) => {
                return await hasher(new TextEncoder().encode(value));
            });

            const parseLuaOptions = (optionsStr?: string) => {
                if (!optionsStr) {
                    return {};
                }

                try {
                    const parsed = JSON.parse(optionsStr);
                    return parsed && typeof parsed === "object" ? parsed : {};
                } catch {
                    return {};
                }
            };

            const collectLuaStreamText = async (stream: ReadableStream<StreamResponseChunk>) => {
                const reader = stream.getReader();
                let text = "";

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }
                        if (value && typeof value["0"] === "string") {
                            text = value["0"];
                        }
                    }
                } finally {
                    reader.releaseLock();
                }

                return text;
            };

            declareAPI(
                "LLMMain",
                async (id: string, promptStr: string, useMultimodal: boolean = false, optionsStr: string = "") => {
                    let prompt: {
                        role: string;
                        content: string;
                    }[] = JSON.parse(promptStr);
                    if (!ScriptingLowLevelIds.has(id)) {
                        return;
                    }
                    let promptbody: OpenAIChat[] = prompt.map((dict) => {
                        let role: "system" | "user" | "assistant" = "assistant";
                        switch (dict["role"]) {
                            case "system":
                            case "sys":
                                role = "system";
                                break;
                            case "user":
                                role = "user";
                                break;
                            case "assistant":
                            case "bot":
                            case "char": {
                                role = "assistant";
                                break;
                            }
                        }

                        return {
                            content: dict["content"] ?? "",
                            role: role,
                        };
                    });

                    if (useMultimodal) {
                        for (const msg of promptbody) {
                            const inlays: string[] = [];
                            msg.content = msg.content.replace(
                                /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
                                (match: string, p1: string, p2: string) => {
                                    if (msg.role === "assistant") {
                                        if (p2 && p1 === "inlayeddata") {
                                            inlays.push(p2);
                                        }
                                    } else {
                                        if (p2) {
                                            inlays.push(p2);
                                        }
                                    }
                                    return "";
                                },
                            );

                            const multimodals: MultiModal[] = [];
                            for (const inlay of inlays) {
                                const inlayData = await getInlayAsset(inlay);
                                multimodals.push({
                                    type: inlayData?.type,
                                    base64: inlayData?.data,
                                    width: inlayData?.width,
                                    height: inlayData?.height,
                                });
                            }

                            msg.multimodals = multimodals.length > 0 ? multimodals : undefined;
                        }
                    }

                    const options = parseLuaOptions(optionsStr) as { streaming?: boolean };
                    const result = await requestChatData(
                        {
                            formated: promptbody,
                            bias: {},
                            useStreaming: options.streaming === true,
                            forceStreaming: options.streaming === true,
                            noMultiGen: true,
                            chatRef: ScriptingEngineState.contextRef,
                        },
                        "model",
                    );

                    if (result.type === "fail") {
                        return JSON.stringify({
                            success: false,
                            result: "Error: " + result.result,
                        });
                    }

                    if (result.type === "streaming") {
                        try {
                            return JSON.stringify({
                                success: true,
                                result: await collectLuaStreamText(result.result),
                            });
                        } catch (error) {
                            return JSON.stringify({
                                success: false,
                                result: "Error: " + error,
                            });
                        }
                    }

                    if (result.type === "multiline") {
                        return JSON.stringify({
                            success: false,
                            result: result.result,
                        });
                    }

                    return JSON.stringify({
                        success: true,
                        result: result.result,
                    });
                },
            );

            declareAPI("simpleLLM", async (id: string, prompt: string) => {
                if (!ScriptingLowLevelIds.has(id)) {
                    return;
                }
                const result = await requestChatData(
                    {
                        formated: [
                            {
                                role: "user",
                                content: prompt,
                            },
                        ],
                        bias: {},
                        useStreaming: false,
                        noMultiGen: true,
                        chatRef: ScriptingEngineState.contextRef,
                    },
                    "model",
                );

                if (result.type === "fail") {
                    return {
                        success: false,
                        result: "Error: " + result.result,
                    };
                }

                if (result.type === "streaming" || result.type === "multiline") {
                    return {
                        success: false,
                        result: result.result,
                    };
                }

                return {
                    success: true,
                    result: result.result,
                };
            });

            // The character getters and setters address the run's character (`characterId`), never
            // the tab's selection. A run without one reads "" and writes nothing.
            declareAPI("getName", (id: string) => {
                const target = runCharacter();
                return target ? target.name : "";
            });

            declareAPI("setName", (id: string, name: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                if (typeof name !== "string") {
                    throw "Invalid data type";
                }
                const target = runCharacter();
                if (target) {
                    updateCharacter(target.chaId, { name });
                }
            });

            declareAPI("getDescription", (id: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                const target = runCharacter();
                if (target?.type === "group") {
                    throw "Character is a group";
                }
                return target ? target.desc : "";
            });

            declareAPI("setDescription", (id: string, desc: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                if (typeof desc !== "string") {
                    throw "Invalid data type";
                }
                const target = runCharacter();
                if (target?.type === "group") {
                    throw "Character is a group";
                }
                if (target) {
                    updateCharacter(target.chaId, { desc });
                }
            });

            declareAPI("getCharacterFirstMessage", (id: string) => {
                const target = runCharacter();
                return target ? target.firstMessage : "";
            });

            declareAPI("setCharacterFirstMessage", (id: string, data: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                if (typeof data !== "string") {
                    return false;
                }
                const target = runCharacter();
                return target ? updateCharacter(target.chaId, { firstMessage: data }) : false;
            });

            declareAPI("getPersonaName", (id: string) => {
                return getUserName(ScriptingEngineState.contextRef);
            });

            declareAPI("getPersonaDescription", (id: string) => {
                return risuChatParser(getPersonaPrompt(ScriptingEngineState.contextRef), {
                    chara: engineCharacter(),
                    chatRef: ScriptingEngineState.contextRef,
                });
            });

            declareAPI("getAuthorsNote", (id: string) => {
                return engineChat()?.note ?? "";
            });

            declareAPI("getBackgroundEmbedding", (id: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                const target = runCharacter();
                return target ? target.backgroundHTML : "";
            });

            declareAPI("setBackgroundEmbedding", (id: string, data: string) => {
                if (!ScriptingSafeIds.has(id)) {
                    return;
                }
                if (typeof data !== "string") {
                    return false;
                }
                const target = runCharacter();
                return target ? updateCharacter(target.chaId, { backgroundHTML: data }) : false;
            });

            // Lore books
            declareAPI("getLoreBooksMain", (id: string, search: string) => {
                const db = getDatabase();
                const selectedChar = engineCharacter();
                if (selectedChar.type !== "character") {
                    return;
                }

                // The run's chat: the live chat, or a trigger's working copy.
                const loreSources = [
                    engineChat()?.localLore ?? [],
                    selectedChar.globalLore,
                    getModuleLorebooks(ScriptingEngineState.contextRef),
                ];

                const found = [];
                for (const source of loreSources) {
                    for (const b of source) {
                        if (b.comment === search) {
                            found.push({
                                ...b,
                                content: risuChatParser(b.content, {
                                    chara: selectedChar,
                                    chatRef: ScriptingEngineState.contextRef,
                                }),
                            });
                        }
                    }
                }

                return JSON.stringify(found);
            });

            type upsertLoreBookOptions = {
                alwaysActive?: boolean;
                insertOrder?: number;
                key?: string;
                secondKey?: string;
                regex?: boolean;
            };

            declareAPI(
                "upsertLocalLoreBook",
                (id: string, name: string, content: string, options: upsertLoreBookOptions) => {
                    if (!ScriptingSafeIds.has(id)) {
                        return;
                    }

                    if (runCharacter()?.type !== "character") {
                        return;
                    }

                    const {
                        alwaysActive = false,
                        insertOrder = 100,
                        key = "",
                        regex = false,
                        secondKey = "",
                    } = options;

                    // This run's chat: the live one through the chat module, or the trigger's working copy.
                    const target = ScriptingEngineState.chatRef;
                    const currentChat = engineChat();
                    if (!currentChat) {
                        return;
                    }

                    const newLocalLoreBooks = (
                        JSON.parse(JSON.stringify(currentChat.localLore ?? [])) as loreBook[]
                    ).filter((book) => book.comment !== name);
                    newLocalLoreBooks.push({
                        alwaysActive,
                        comment: name,
                        content: content,
                        insertorder: insertOrder,
                        mode: "normal",
                        key,
                        secondkey: secondKey,
                        selective: !!secondKey,
                        useRegex: regex,
                    });
                    if (!target) {
                        workingCopy().localLore = newLocalLoreBooks;
                        return;
                    }
                    try {
                        setChatMeta(target, { localLore: newLocalLoreBooks });
                    } catch (error) {
                        console.warn("[Lua] A local lorebook change was refused", error);
                    }
                },
            );

            declareAPI("loadLoreBooksMain", async (id: string, reserve: number) => {
                if (!ScriptingLowLevelIds.has(id)) {
                    return;
                }

                const db = getDatabase();

                const selectedChar = engineCharacter();

                if (selectedChar?.type !== "character") {
                    return;
                }

                const fullLoreBooks = (await loadLoreBookV3Prompt(ScriptingEngineState.contextRef)).actives;
                const maxContext = db.maxContext - reserve;
                if (maxContext < 0) {
                    return JSON.stringify([]);
                }

                let totalTokens = 0;
                const loreBooks = [];

                for (const book of fullLoreBooks) {
                    const parsed = risuChatParser(book.prompt, {
                        chara: selectedChar,
                        chatRef: ScriptingEngineState.contextRef,
                    }).trim();
                    if (parsed.length === 0) {
                        continue;
                    }

                    const tokens = await tokenize(parsed);

                    if (totalTokens + tokens > maxContext) {
                        break;
                    }
                    totalTokens += tokens;
                    loreBooks.push({
                        data: parsed,
                        role: book.role === "assistant" ? "char" : book.role,
                    });
                }

                return JSON.stringify(loreBooks);
            });

            declareAPI(
                "axLLMMain",
                async (id: string, promptStr: string, useMultimodal: boolean = false, optionsStr: string = "") => {
                    let prompt: {
                        role: string;
                        content: string;
                    }[] = JSON.parse(promptStr);
                    if (!ScriptingLowLevelIds.has(id)) {
                        return;
                    }
                    let promptbody: OpenAIChat[] = prompt.map((dict) => {
                        let role: "system" | "user" | "assistant" = "assistant";
                        switch (dict["role"]) {
                            case "system":
                            case "sys":
                                role = "system";
                                break;
                            case "user":
                                role = "user";
                                break;
                            case "assistant":
                            case "bot":
                            case "char": {
                                role = "assistant";
                                break;
                            }
                        }

                        return {
                            content: dict["content"] ?? "",
                            role: role,
                        };
                    });

                    if (useMultimodal) {
                        for (const msg of promptbody) {
                            const inlays: string[] = [];
                            msg.content = msg.content.replace(
                                /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
                                (match: string, p1: string, p2: string) => {
                                    if (msg.role === "assistant") {
                                        if (p2 && p1 === "inlayeddata") {
                                            inlays.push(p2);
                                        }
                                    } else {
                                        if (p2) {
                                            inlays.push(p2);
                                        }
                                    }
                                    return "";
                                },
                            );

                            const multimodals: MultiModal[] = [];
                            for (const inlay of inlays) {
                                const inlayData = await getInlayAsset(inlay);
                                multimodals.push({
                                    type: inlayData?.type,
                                    base64: inlayData?.data,
                                    width: inlayData?.width,
                                    height: inlayData?.height,
                                });
                            }

                            msg.multimodals = multimodals.length > 0 ? multimodals : undefined;
                        }
                    }

                    const options = parseLuaOptions(optionsStr) as { streaming?: boolean };
                    const result = await requestChatData(
                        {
                            formated: promptbody,
                            bias: {},
                            useStreaming: options.streaming === true,
                            forceStreaming: options.streaming === true,
                            noMultiGen: true,
                            chatRef: ScriptingEngineState.contextRef,
                        },
                        "otherAx",
                    );

                    if (result.type === "fail") {
                        return JSON.stringify({
                            success: false,
                            result: "Error: " + result.result,
                        });
                    }

                    if (result.type === "streaming") {
                        try {
                            return JSON.stringify({
                                success: true,
                                result: await collectLuaStreamText(result.result),
                            });
                        } catch (error) {
                            return JSON.stringify({
                                success: false,
                                result: "Error: " + error,
                            });
                        }
                    }

                    if (result.type === "multiline") {
                        return JSON.stringify({
                            success: false,
                            result: result.result,
                        });
                    }

                    return JSON.stringify({
                        success: true,
                        result: result.result,
                    });
                },
            );

            declareAPI("getCharacterLastMessage", (id: string) => {
                const chat = engineChat();
                if (!chat) {
                    return "";
                }

                const db = getDatabase();
                const selchar = db.characters[get(selectedCharID)];

                let pointer = chat.message.length - 1;
                while (pointer >= 0) {
                    if (chat.message[pointer].role === "char") {
                        const messageData = chat.message[pointer].data;
                        return messageData;
                    }
                    pointer--;
                }

                return selchar.firstMessage;
            });

            declareAPI("getUserLastMessage", (id: string) => {
                const chat = engineChat();
                if (!chat) {
                    return "";
                }

                let pointer = chat.message.length - 1;
                while (pointer >= 0) {
                    if (chat.message[pointer].role === "user") {
                        const messageData = chat.message[pointer].data;
                        return messageData;
                    }
                    pointer--;
                }

                return "";
            });

            declareAPI("getCharacterLastMessage", (id: string) => {
                const chat = engineChat();
                if (!chat) {
                    return "";
                }

                const db = getDatabase();
                const selchar = db.characters[get(selectedCharID)];

                let pointer = chat.message.length - 1;
                while (pointer >= 0) {
                    if (chat.message[pointer].role === "char") {
                        const messageData = chat.message[pointer].data;
                        return messageData;
                    }
                    pointer--;
                }

                return selchar.firstMessage;
            });

            declareAPI("getUserLastMessage", (id: string) => {
                const chat = engineChat();
                if (!chat) {
                    return "";
                }

                let pointer = chat.message.length - 1;
                while (pointer >= 0) {
                    if (chat.message[pointer].role === "user") {
                        const messageData = chat.message[pointer].data;
                        return messageData;
                    }
                    pointer--;
                }
                return "";
            });

            console.log("Running Lua code:", code);
            await ScriptingEngineState.engine?.doString(luaCodeWrapper(code));
            ScriptingEngineState.code = code;
        }
        let accessKey = v4();
        if (mode === "editDisplay") {
            ScriptingEditDisplayIds.add(accessKey);
        } else {
            ScriptingSafeIds.add(accessKey);
            if (lowLevelAccess) {
                ScriptingLowLevelIds.add(accessKey);
            }
        }
        let res: any;
        const luaEngine = ScriptingEngineState.engine;
        try {
            switch (mode) {
                case "input": {
                    const func = luaEngine.global.get("onInput");
                    if (func) {
                        res = await func(accessKey);
                    }
                    break;
                }
                case "output": {
                    const func = luaEngine.global.get("onOutput");
                    if (func) {
                        res = await func(accessKey);
                    }
                    break;
                }
                case "start": {
                    const func = luaEngine.global.get("onStart");
                    if (func) {
                        res = await func(accessKey);
                    }
                    break;
                }
                case "onButtonClick": {
                    const func = luaEngine.global.get("onButtonClick");
                    if (func) {
                        res = await func(accessKey, data);
                    }
                    break;
                }
                case "editRequest":
                case "editDisplay":
                case "editInput":
                case "editOutput": {
                    const func = luaEngine.global.get("callListenMain");
                    if (func) {
                        res = await func(mode, accessKey, JSON.stringify(data), JSON.stringify(meta));
                        res = JSON.parse(res);
                    }
                    break;
                }
                default: {
                    const func = luaEngine.global.get(mode);
                    if (func) {
                        res = await func(accessKey);
                    }
                    break;
                }
            }
            if (res === false) {
                stopSending = true;
            }
        } catch (error) {
            console.error(error);
        }
        ScriptingSafeIds.delete(accessKey);
        ScriptingLowLevelIds.delete(accessKey);
        chat = ScriptingEngineState.chat;

        return {
            stopSending,
            chat,
            res,
        };
    });
}

async function makeLuaFactory() {
    const _luaFactory = new LuaFactory();
    async function mountFile(name: string) {
        let code = "";
        for (let i = 0; i < 3; i++) {
            try {
                const res = await fetch("/lua/" + name);
                if (res.status >= 200 && res.status < 300) {
                    code = await res.text();
                    break;
                }
            } catch (error) {}
        }
        await _luaFactory.mountFile(name, code);
    }

    await mountFile("json.lua");
    luaFactory = _luaFactory;
}

async function ensureLuaFactory() {
    if (luaFactory) return;

    if (luaFactoryPromise) {
        try {
            await luaFactoryPromise;
        } catch (error) {
            luaFactoryPromise = null;
        }
        return;
    }

    try {
        luaFactoryPromise = makeLuaFactory();
        await luaFactoryPromise;
    } finally {
        luaFactoryPromise = null;
    }
}

async function getOrCreateEngineState(mode: string): Promise<ScriptingEngineState> {
    let engineState = ScriptingEngines.get(mode);
    if (engineState) {
        return engineState;
    }

    let pendingCreation = pendingEngineCreations.get(mode);
    if (pendingCreation) {
        return pendingCreation;
    }

    const creationPromise = (() => {
        const engineState: ScriptingEngineState = {
            mutex: new Mutex(),
        };
        ScriptingEngines.set(mode, engineState);

        pendingEngineCreations.delete(mode);

        return Promise.resolve(engineState);
    })();

    pendingEngineCreations.set(mode, creationPromise);

    return creationPromise;
}

function luaCodeWrapper(code: string) {
    return `
json = require 'json'

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function getRecentChats(id, count)
    return json.decode(getRecentChatsMain(id, count))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end


function loadLoreBooks(id)
    return json.decode(loadLoreBooksMain(id):await())
end

function LLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function axLLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function getCharacterImage(id)
    return getCharacterImageMain(id):await()
end

function getPersonaImage(id)
    return getPersonaImageMain(id):await()
end

local editRequestFuncs = {}
local editDisplayFuncs = {}
local editInputFuncs = {}
local editOutputFuncs = {}

function listenEdit(type, func)
    if type == 'editRequest' then
        editRequestFuncs[#editRequestFuncs + 1] = func
        return
    end

    if type == 'editDisplay' then
        editDisplayFuncs[#editDisplayFuncs + 1] = func
        return
    end

    if type == 'editInput' then
        editInputFuncs[#editInputFuncs + 1] = func
        return
    end

    if type == 'editOutput' then
        editOutputFuncs[#editOutputFuncs + 1] = func
        return
    end

    throw('Invalid type')
end

function getState(id, name)
    local escapedName = "__"..name
    return json.decode(getChatVar(id, escapedName))
end

function setState(id, name, value)
    local escapedName = "__"..name
    setChatVar(id, escapedName, json.encode(value))
end

function setStateChanged(id, name, value)
    local escapedName = "__"..name
    return setChatVarChanged(id, escapedName, json.encode(value))
end

function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)

        return Promise.create(function(resolve, reject)
            local checkresult
            local step = function()
                if coroutine.status(co) == "dead" then
                    local send = safe and resolve or reject
                    return send(result)
                end

                safe, result = coroutine.resume(co)
                checkresult()
            end

            checkresult = function()
                if safe and result == Promise.resolve(result) then
                    result:finally(step)
                else
                    step()
                end
            end

            checkresult()
        end)
    end
end

callListenMain = async(function(type, id, value, meta)
    local realValue = json.decode(value)
    local realMeta = json.decode(meta)

    if type == 'editRequest' then
        for _, func in ipairs(editRequestFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editDisplay' then
        for _, func in ipairs(editDisplayFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editInput' then
        for _, func in ipairs(editInputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editOutput' then
        for _, func in ipairs(editOutputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    return json.encode(realValue)
end)

${code}
`;
}

export async function runLuaEditTrigger<T extends string | OpenAIChat[]>(
    char: character | groupChat | simpleCharacterArgument,
    mode: string,
    content: T,
    meta?: object,
    /** The chat the hook runs for (default: the selected chat). */
    chatRef?: ChatRef | null,
): Promise<T> {
    switch (mode) {
        case "editinput":
            mode = "editInput";
            break;
        case "editoutput":
            mode = "editOutput";
            break;
        case "editdisplay":
            mode = "editDisplay";
            break;
        case "editprocess":
            return content;
    }

    try {
        let data = content;

        const triggers =
            char.type === "group"
                ? getModuleTriggers(chatRef)
                : char.triggerscript
                      .map((v) => {
                          v.lowLevelAccess = false;
                          return v;
                      })
                      .concat(getModuleTriggers(chatRef));

        for (let trigger of triggers) {
            if (trigger?.effect?.[0]?.type === "triggerlua") {
                const runResult = await runScripted(trigger.effect[0].code, {
                    char: char,
                    lowLevelAccess: false,
                    mode: mode,
                    data,
                    meta,
                    chatRef,
                });
                data = runResult.res ?? data;
            }
        }

        return data;
    } catch (error) {
        return content;
    }
}

export async function runLuaButtonTrigger(
    char: character | groupChat | simpleCharacterArgument,
    data: string,
    /** The chat the button was clicked in (default: the selected chat when the click is handled). */
    chatRef: ChatRef | null = currentChatRef(),
): Promise<any> {
    let runResult;
    try {
        const triggers =
            char.type === "group"
                ? getModuleTriggers(chatRef)
                : char.triggerscript
                      .map<triggerscript>((v) => ({
                          ...v,
                          lowLevelAccess: char.type !== "simple" ? (char.lowLevelAccess ?? false) : false,
                      }))
                      .concat(getModuleTriggers(chatRef));

        for (let trigger of triggers) {
            if (chatRef && !findChat(chatRef)) {
                // The chat went away while an earlier script ran; the later ones do not run elsewhere.
                break;
            }
            if (trigger?.effect?.[0]?.type === "triggerlua") {
                runResult = await runScripted(trigger.effect[0].code, {
                    char: char,
                    chatRef,
                    lowLevelAccess: trigger.lowLevelAccess,
                    mode: "onButtonClick",
                    data: data,
                });
            }
        }
    } catch (error) {
        throw error;
    }
    return runResult;
}
