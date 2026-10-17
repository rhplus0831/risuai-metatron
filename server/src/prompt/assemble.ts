import type { CbsParseArg } from "../../../shared/cbs/evaluator.ts";
import type {
    Chat,
    character,
    Database,
    groupChat,
    Message,
    MessageGenerationInfo,
    MessagePresetInfo,
} from "../../../shared/database.ts";
import { LLMFlags, type LLMModel } from "../../../shared/llm.ts";
import type { LoreActivation } from "../../../shared/lore/activation.ts";
import type { MultiModal, OpenAIChat } from "../../../shared/openai.ts";
import type { PromptItem, PromptItemPlain, PromptItemTyped } from "../../../shared/prompt.ts";
import type { ChatTokenCounter } from "../../../shared/prompt/chatTokens.ts";
import {
    parseToggleSyntax,
    resolveGlobalChatVar,
    toggleDefinitionsText,
    toggleStorageKey,
    valueToggles,
} from "../../../shared/prompt/toggles.ts";
import { HypaProcesser } from "./embeddings.ts";
import { hanuraiMemory } from "./memory/hanurai.ts";
import type { MemoryHost } from "./memory/host.ts";
import { hypaMemoryV2 } from "./memory/hypav2.ts";
import { hypaMemoryV3 } from "./memory/hypav3.ts";
import { supaMemory } from "./memory/supaMemory.ts";
import type { ScriptProcessor } from "./scripts.ts";
import { stripThoughtsBlock } from "./thoughts.ts";
import { parseChatML, type TriggerResult } from "./triggers.ts";

/**
 * The prompt of one send, assembled on the server (Phase 5 slice 9): the body of `sendChatInner`
 * (the former `src/ts/process/index.svelte.ts`) from the prompt-info snapshot to `generationInfo`, for one
 * speaker, statement by statement with the client's order and quirks. Everything it reads of the
 * job comes through `AssemblyHost`. The memory step, `additionalInformations`, and the caption of an
 * image a model cannot take run with the job's memory services (Phase 5 slice 10): the same gate,
 * priority, and persistence as the client's, each result written before the provider request.
 */

/** The English text of `language.errors.toomuchtoken`. */
const TOO_MUCH_TOKEN = "Error: The minimum required token is greater than the max context size.";

/** `prebuiltAssetCommand` of `src/ts/util.ts`. */
const PREBUILT_ASSET_COMMAND = `
<Image Tag Instruction>Insert HTML image tags between paragraphs based on context.
Set src as keywords from the list below that matches current character, outfit, situation sentiment and etc.
print as many different images as possible. Use only available keywords.
if there are no matching keywords, try to put clostest matching image src.
try to put at least 1 image per output.
<keywords>{{join::{{chardisplayasset}}::,}}</keywords>
Example: <img src="{{ele::{{chardisplayasset}}::0}}">
<Image Tag Instruction>
`;

export type AssemblyHost = {
    /** The job's database projection (the preset's fields forwarded). */
    db: Database;
    /** The chat's owner (`nowChatroom`): the character, or the group. */
    owner: character | groupChat;
    /** The speaker (`currentChar`): the owner, or a group's member. */
    speaker: character;
    chatRef: { chaId: string; chatId: string };
    /** `risuChatParser` with the job's chat as its default `chatRef`. */
    parse(text: string, arg?: CbsParseArg): string;
    /** The job's chat as stored now (`chatNow()`). */
    chat(): Chat;
    /** `findCharacterbyId`: a blank "Unknown Character" when there is none. */
    findCharacter(id: string | undefined): character;
    /** `getUserName(chatRef)`, `getPersonaPrompt(chatRef)`. */
    userName(): string;
    personaPrompt(): string;
    /** `loadLoreBookV3Prompt(chatRef)` of the chat as stored now. */
    activateLore(): Promise<LoreActivation>;
    scripts: ScriptProcessor;
    /** The `start` trigger on a copy of the chat, applied; its result. */
    runStartTrigger(): Promise<TriggerResult | null | undefined>;
    /** `runLuaEditTrigger(currentChar, "editRequest", formated)`. */
    runEditRequest(formated: OpenAIChat[]): Promise<OpenAIChat[]>;
    /** `getInlayAsset`. */
    readInlay(id: string): Promise<{ type: string; data: string; width?: number; height?: number } | null>;
    /** `readImage` of a stored asset path. */
    readAsset(path: string): Promise<Uint8Array | null>;
    /** `getModuleAssets(chatRef)`. */
    moduleAssets(): [string, string, string][];
    /** `getModuleToggles(chatRef)`. */
    moduleToggles(): string;
    /** `runCurrentChatFunction`: every message through CBS with variables, the changed ones written. */
    runCurrentChatFunction(): void;
    /** Sets or removes the chat's `lastMemory` (the no-memory trim). */
    setLastMemory(memo: string | undefined): void;
    /**
     * The no-memory trim question of the job. `enabled`: the user turned the owner's memory on in
     * this job (the job's `owner` is a frozen projection). `confirm`: asked when a memory method is
     * set, the owner's memory is off, and the trim would cut chat history; "memory" to run memory
     * instead (the toggle is on now), "trim" to trim as before. One answer serves the whole job.
     */
    memoryTrim: { enabled(): boolean; confirm(): Promise<"memory" | "trim"> };
    /** The memory algorithms' services of this run (`memory-on-server`). */
    memory: MemoryHost;
    /**
     * `setChatMeta(chatTarget, set)` of the memory step: `build` gets the chat as stored now and
     * returns the fields to set (nothing for null).
     */
    writeMemory(build: (chat: Chat) => Record<string, unknown> | null): void;
    /** The memory step ended (a result, an error, an abort): a progress notice left open is closed. */
    endMemoryProgress(): void;
    /** `runImageEmbedding(dataUrl)[0].generated_text`: the caption of an image a model cannot take. */
    captionImage(dataUrl: string): Promise<string>;
    tokenizer: ChatTokenCounter;
    getModelInfo(id: string): LLMModel;
    /** Raises after an abort or a latched failure (after every await). */
    fence(): void;
};

export type AssembleInput = {
    chatAdditonalTokens: number;
    continue: boolean;
    generationId: string;
    stageTimings: { stage1Duration: number; stage2Duration: number };
};

export type AssembledPrompt =
    | {
          type: "prompt";
          formated: OpenAIChat[];
          biases: [string, number][];
          generationInfo: MessageGenerationInfo;
          promptInfo: MessagePresetInfo;
          maxContextTokens: number;
      }
    /** The `start` trigger's `stopSending`: the send ends quietly. */
    | { type: "stopped" }
    /** `throwError(error)` and `return false`. */
    | { type: "error"; error: string }
    /** `alertError(error)` and `return false` (Hanurai's): the send ends with the text, never as a chat message. */
    | { type: "alert"; error: string };

/**
 * `additionalInformations` of `src/ts/process/embedding/addinfo.ts`: the three paragraphs of the
 * character's `additionalText` nearest to the chat's first four messages.
 */
async function additionalInformations(host: AssemblyHost, char: character, chats: Chat): Promise<string> {
    const processer = new HypaProcesser(host.memory.embeddings);

    const info = char.additionalText;
    if (info) {
        const infos = info.split("\n\n");

        await processer.addText(infos);
        host.fence();
        const filteredChat = chats.message
            .slice(0, 4)
            .map((chat) => {
                let name = chat.saying ?? "";

                if (!name) {
                    if (chat.role === "user") {
                        name = host.userName();
                    } else {
                        name = char.name;
                    }
                }

                return `${name}: ${chat.data}`;
            })
            .join("\n\n");
        const searched = await processer.similaritySearch(filteredChat);
        host.fence();
        const result = searched.slice(0, 3).join("\n\n");
        return result;
    }

    return "";
}

/** `getAuthorNoteDefaultText` of `src/ts/util.ts`. */
function getAuthorNoteDefaultText(db: Database): string {
    const template = db.promptTemplate;
    if (!template) {
        return "";
    }
    for (const v of template) {
        if (v.type === "authornote") {
            return v.defaultText ?? "";
        }
    }
    return "";
}

/** `getGenerationModelString` of `src/ts/process/models/modelString.ts`. */
export function getGenerationModelString(db: Database, name?: string): string {
    switch (name ?? db.aiModel) {
        case "reverse_proxy":
            return "custom-" + (db.reverseProxyOobaMode ? "ooba" : db.customProxyRequestModel);
        case "openrouter":
            return "openrouter-" + db.openrouterRequestModel;
        case "nanogpt": {
            const modelLabel = db.nanogptRequestModelName || db.nanogptRequestModel;
            return "NanoGPT " + modelLabel + (db.nanogptUseSubscriptionEndpoint ? " [SUB]" : "");
        }
        case "ollama-hosted":
        case "ollama-cloud": {
            const modelLabel =
                name === "ollama-cloud"
                    ? db.ollamaCloudModelName || db.ollamaCloudModel
                    : db.ollamaModelName || db.ollamaModel;
            return `Ollama ${name === "ollama-cloud" ? "Cloud" : "Local"} ${modelLabel}`;
        }
        default:
            return name ?? db.aiModel;
    }
}

/** `exampleMessage` of the former `src/ts/process/exampleMessages.ts`. */
function exampleMessage(char: character, parse: AssemblyHost["parse"]): OpenAIChat[] {
    if (char.exampleMessage === "") {
        return [];
    }
    const messages = char.exampleMessage.split("\n");
    let result: OpenAIChat[] = [];
    let currentMessage: OpenAIChat | null = null;
    function add() {
        if (currentMessage) {
            result.push(currentMessage);
        }
    }
    for (const mes of messages) {
        const trimed = mes.trim();
        const lowered = trimed.toLocaleLowerCase();
        if (lowered === "<start>") {
            add();
            result.push({ role: "system", content: "[Start a new chat]", memo: "NewChatExample" });
            currentMessage = null;
        } else if (
            lowered.startsWith("{{char}}:") ||
            lowered.startsWith("<bot>:") ||
            lowered.startsWith(`${char.name}:`)
        ) {
            add();
            currentMessage = {
                role: "assistant",
                content: trimed.split(":", 2)[1].trimStart(),
                name: "example_assistant",
            };
        } else if (lowered.startsWith("{{user}}:") || lowered.startsWith("<user>:")) {
            add();
            currentMessage = { role: "user", content: trimed.split(":", 2)[1].trimStart(), name: "example_user" };
        } else {
            if (currentMessage) {
                currentMessage.content += "\n" + trimed;
            }
        }
    }
    add();
    result = result.map((r) => ({
        role: r.role,
        content: parse(r.content, { chara: char }),
        name: r.name,
        memo: r.memo,
    }));
    return result;
}

/** `systemizeChat` of the former `src/ts/process/index.svelte.ts`. */
function systemizeChat(chat: OpenAIChat[]) {
    for (let i = 0; i < chat.length; i++) {
        if (chat[i].role === "user" || chat[i].role === "assistant") {
            const attr = chat[i].attr ?? [];
            if (chat[i].name?.startsWith("example_")) {
                chat[i].content = chat[i].name + ": " + chat[i].content;
            } else if (!attr.includes("nameAdded")) {
                chat[i].content = chat[i].role + ": " + chat[i].content;
            }
            chat[i].role = "system";
            delete chat[i].memo;
            delete chat[i].name;
        }
    }
    return chat;
}

/** The client's `safeStructuredClone` of prompt data. */
const clone = <T>(value: T): T => structuredClone(value);

export async function assemblePrompt(host: AssemblyHost, input: AssembleInput): Promise<AssembledPrompt> {
    const { db, owner: nowChatroom, speaker: currentChar, chatRef: chatTarget, tokenizer } = host;
    const parse = host.parse;
    const findCharacterbyIdwithCache = (() => {
        const cache: { [key: string]: character } = {};
        return (id: string | undefined) => {
            const key = String(id);
            if (cache[key]) {
                return cache[key];
            }
            const found = host.findCharacter(id);
            cache[key] = found;
            return found;
        };
    })();

    let promptInfo: MessagePresetInfo = {};
    if (db.promptInfoInsideChat) {
        const initialPresetNameForPromptInfo = db.botPresets[db.botPresetsId]?.name ?? "";
        const definitions = toggleDefinitionsText(
            db.customPromptTemplateToggle,
            host.moduleToggles(),
            nowChatroom.type !== "group" ? nowChatroom.customModuleToggle : "",
        );
        const chatVariables = host.chat().GLGlobalVariables;
        const initialPromptTogglesForPromptInfo = valueToggles(parseToggleSyntax(definitions)).flatMap((toggle) => {
            const raw = resolveGlobalChatVar(
                toggleStorageKey(toggle.key),
                chatVariables,
                db.globalChatVariables,
                definitions,
            );
            if (toggle.type === "select") {
                return [{ key: toggle.value, value: toggle.options[raw as unknown as number] }];
            }
            if (toggle.type === "text" || toggle.type === "textarea") {
                return [{ key: toggle.value, value: raw }];
            }
            if (raw === "1") {
                return [{ key: toggle.value, value: "ON" }];
            }
            return [];
        });
        promptInfo = {
            promptName: initialPresetNameForPromptInfo,
            promptToggles: initialPromptTogglesForPromptInfo,
        };
    }

    const chatAdditonalTokens = input.chatAdditonalTokens;
    host.runCurrentChatFunction();
    let currentChat = host.chat();
    const maxContextTokens = db.maxContext;

    const stage1Start = Date.now();
    const unformated = {
        main: [] as OpenAIChat[],
        jailbreak: [] as OpenAIChat[],
        chats: [] as OpenAIChat[],
        lorebook: [] as OpenAIChat[],
        globalNote: [] as OpenAIChat[],
        authorNote: [] as OpenAIChat[],
        lastChat: [] as OpenAIChat[],
        description: [] as OpenAIChat[],
        postEverything: [] as OpenAIChat[],
        personaPrompt: [] as OpenAIChat[],
    };

    let promptTemplate: PromptItem[] | null | undefined = db.promptTemplate
        ? clone(db.promptTemplate)
        : db.promptTemplate;
    const usingPromptTemplate = !!promptTemplate;
    if (promptTemplate) {
        let hasPostEverything = false;
        for (const card of promptTemplate) {
            if (card.type === "postEverything") {
                hasPostEverything = true;
                break;
            }
        }
        if (!hasPostEverything) {
            promptTemplate.push({ type: "postEverything" });
        }
    }
    if (currentChar.utilityBot && !(usingPromptTemplate && db.promptSettings.utilOverride)) {
        promptTemplate = [
            { type: "plain", text: "", role: "system", type2: "main" },
            { type: "description" },
            { type: "lorebook" },
            { type: "chat", rangeStart: 0, rangeEnd: "end" },
            { type: "plain", text: "", role: "system", type2: "globalNote" },
            { type: "postEverything" },
        ];
    }

    if (!currentChar.utilityBot && !promptTemplate) {
        const mainp = currentChar.systemPrompt?.replaceAll("{{original}}", db.mainPrompt) || db.mainPrompt;

        function formatPrompt(data: string) {
            if (!data.startsWith("@@")) {
                data = "@@system\n" + data;
            }
            const parts = data.split(/@@@?(user|assistant|system)\n/);
            const chatObjects: OpenAIChat[] = [];
            for (let i = 1; i < parts.length; i += 2) {
                const role = parts[i] as "user" | "assistant" | "system";
                const content = parts[i + 1]?.trim() || "";
                chatObjects.push({ role, content });
            }
            return chatObjects;
        }

        unformated.main.push(
            ...formatPrompt(
                parse(mainp + (db.additionalPrompt === "" || !db.promptPreprocess ? "" : `\n${db.additionalPrompt}`), {
                    chatRef: chatTarget,
                    chara: currentChar,
                }),
            ),
        );
        if (db.jailbreakToggle) {
            unformated.jailbreak.push(
                ...formatPrompt(parse(db.jailbreak, { chatRef: chatTarget, chara: currentChar })),
            );
        }
        unformated.globalNote.push(
            ...formatPrompt(
                parse(currentChar.replaceGlobalNote?.replaceAll("{{original}}", db.globalNote) || db.globalNote, {
                    chatRef: chatTarget,
                    chara: currentChar,
                }),
            ),
        );
    }

    let baseDescriptionPrompt: OpenAIChat | null = null;
    const beforeDescriptionPrompts: OpenAIChat[] = [];
    const afterDescriptionPrompts: OpenAIChat[] = [];

    if (currentChat.note) {
        unformated.authorNote.push({
            role: "system",
            content: parse(currentChat.note, { chatRef: chatTarget, chara: currentChar }),
        });
    } else if (getAuthorNoteDefaultText(db) !== "") {
        unformated.authorNote.push({
            role: "system",
            content: parse(getAuthorNoteDefaultText(db), { chatRef: chatTarget, chara: currentChar }),
        });
    }

    if (db.chainOfThought && !(usingPromptTemplate && db.promptSettings.customChainOfThought)) {
        unformated.postEverything.push({
            role: "system",
            content: `<instruction> - before respond everything, Think step by step as a ai assistant how would you respond inside <Thoughts> xml tag. this must be less than 5 paragraphs.</instruction>`,
        });
    }

    {
        let description = parse((db.promptPreprocess ? db.descriptionPrefix : "") + currentChar.desc, {
            chatRef: chatTarget,
            chara: currentChar,
        });
        const additionalInfo = await additionalInformations(host, currentChar, currentChat);

        if (additionalInfo) {
            description += "\n\n" + parse(additionalInfo, { chatRef: chatTarget, chara: currentChar });
        }

        if (currentChar.personality) {
            description += parse("\n\nDescription of {{char}}: " + currentChar.personality, {
                chatRef: chatTarget,
                chara: currentChar,
            });
        }
        if (currentChar.scenario) {
            description += parse("\n\nCircumstances and context of the dialogue: " + currentChar.scenario, {
                chatRef: chatTarget,
                chara: currentChar,
            });
        }
        baseDescriptionPrompt = { role: "system", content: description };
        unformated.description.push(baseDescriptionPrompt);
        if (nowChatroom.type === "group") {
            unformated.postEverything.push({
                role: "system",
                content: `[Write the next reply only as ${currentChar.name}]`,
            });
        }
    }

    const lorepmt = await host.activateLore();
    host.fence();

    const positionRegex = /{{position::(.+?)}}/g;
    const replaceposition = (text: string): { text: string; replaced: boolean } => {
        let replaced = false;
        const result = text.replace(positionRegex, (match, p1) => {
            replaced = true;
            const posMatch = "pt_" + p1;
            const matchingPrompts: string[] = [];
            for (const v of lorepmt.actives) {
                if (v.pos === posMatch) {
                    matchingPrompts.push(v.prompt);
                }
            }
            return matchingPrompts.join("\n");
        });
        return { text: result, replaced };
    };
    const resolvePosition = (text: string, maxDepth: number = 5) => {
        let result = text;
        for (let i = 0; i < maxDepth; i++) {
            const r = replaceposition(result);
            result = r.text;
            if (!r.replaced) break;
        }
        result = result.replace(positionRegex, "");
        return result;
    };

    const normalActives = lorepmt.actives.filter((v) => v.pos === "" && v.inject === null);
    for (const lorebook of normalActives) {
        unformated.lorebook.push({
            role: lorebook.role,
            content: parse(resolvePosition(lorebook.prompt), { chatRef: chatTarget, chara: currentChar }),
        });
    }

    const descActives = lorepmt.actives.filter(
        (v) => v.pos === "after_desc" || v.pos === "before_desc" || v.pos === "personality" || v.pos === "scenario",
    );
    for (const lorebook of descActives) {
        const c: OpenAIChat = {
            role: lorebook.role,
            content: parse(resolvePosition(lorebook.prompt), { chatRef: chatTarget, chara: currentChar }),
        };
        if (lorebook.pos === "before_desc") {
            beforeDescriptionPrompts.unshift(c);
            unformated.description.unshift(c);
        } else {
            afterDescriptionPrompts.push(c);
            unformated.description.push(c);
        }
    }

    if (db.personaPrompt) {
        unformated.personaPrompt.push({
            role: "system",
            content: parse(host.personaPrompt(), { chatRef: chatTarget, chara: currentChar }),
        });
    }

    if (currentChar.inlayViewScreen) {
        if (currentChar.viewScreen === "emotion") {
            unformated.postEverything.push({
                role: "system",
                content: currentChar.newGenData!.emotionInstructions.replaceAll(
                    "{{slot}}",
                    currentChar.emotionImages.map((v) => v[0]).join(", "),
                ),
            });
        }
        if (currentChar.viewScreen === "imggen") {
            unformated.postEverything.push({ role: "system", content: currentChar.newGenData!.instructions });
        }
    }

    const postEverythingLorebooks = lorepmt.actives.filter(
        (v) => v.pos === "depth" && v.depth === 0 && v.role !== "assistant",
    );
    for (const lorebook of postEverythingLorebooks) {
        unformated.postEverything.push({
            role: lorebook.role,
            content: parse(resolvePosition(lorebook.prompt), { chatRef: chatTarget, chara: currentChar }),
        });
    }

    // Since assistant needs to be prefill, we need to add assistant lorebooks after user/system lorebooks
    const postEverythingAssistantLorebooks = lorepmt.actives.filter(
        (v) => v.pos === "depth" && v.depth === 0 && v.role === "assistant",
    );
    const injectionLorebooks = lorepmt.actives.filter((v) => v.inject && !v.inject.lore);
    const injectionLorePosSet = new Set<string>();
    for (const lorebook of injectionLorebooks) {
        injectionLorePosSet.add(lorebook.inject!.location);
    }
    for (const lorebook of postEverythingAssistantLorebooks) {
        unformated.postEverything.push({
            role: lorebook.role,
            content: parse(resolvePosition(lorebook.prompt), { chatRef: chatTarget, chara: currentChar }),
        });
    }

    let currentTokens = db.maxResponse;
    let supaMemoryCardUsed = false;
    // for unexpected error
    currentTokens += 50;

    const positionParser = (text: string, loc: string) => {
        if (injectionLorePosSet.has(loc)) {
            const matchings = injectionLorebooks.filter((v) => v.inject!.location === loc);
            for (const lore of matchings) {
                switch (lore.inject!.operation) {
                    case "append": {
                        text += " " + lore.prompt;
                        break;
                    }
                    case "prepend": {
                        text = lore.prompt + " " + text;
                        break;
                    }
                    case "replace": {
                        text = text.replace(lore.inject!.param, lore.prompt);
                        break;
                    }
                }
            }
        }
        return resolvePosition(text);
    };

    let hasCachePoint = false;
    const convertPromptRole = { system: "system", user: "user", bot: "assistant" } as const;

    function applyPromptBlockRole(chats: OpenAIChat[], role?: "user" | "bot" | "system") {
        if (!role) {
            return;
        }
        for (const chat of chats) {
            chat.role = convertPromptRole[role];
        }
    }

    function getDescriptionPrompts(role?: "user" | "bot" | "system") {
        const pmt = [
            ...clone(beforeDescriptionPrompts),
            ...(baseDescriptionPrompt ? [clone(baseDescriptionPrompt)] : []),
            ...clone(afterDescriptionPrompts),
        ];
        if (baseDescriptionPrompt) {
            applyPromptBlockRole([pmt[beforeDescriptionPrompts.length]], role);
        }
        return pmt;
    }

    const chatRange = (card: { rangeStart: number; rangeEnd: number | "end" }) => {
        let start = card.rangeStart;
        let end = card.rangeEnd === "end" ? unformated.chats.length : card.rangeEnd;
        if (start === -1000) {
            start = 0;
            end = unformated.chats.length;
        }
        if (start < 0) {
            start = unformated.chats.length + start;
            if (start < 0) {
                start = 0;
            }
        }
        if (end < 0) {
            end = unformated.chats.length + end;
            if (end < 0) {
                end = 0;
            }
        }
        return { start, end };
    };

    /** The `plain`/`jailbreak`/`cot` card's prompt (both template passes build it the same way). */
    const plainCardPrompt = (card: PromptItemPlain): OpenAIChat => {
        const posType = card.type === "plain" ? card.type2 : card.type;
        let content = positionParser(card.text, posType);
        if (card.type2 === "globalNote") {
            if (currentChar.replaceGlobalNote) {
                content = positionParser(currentChar.replaceGlobalNote, posType).replaceAll("{{original}}", content);
            }
            if (currentChar.prebuiltAssetCommand && !card.text.includes("{{//@customimageinstruction}}")) {
                content += PREBUILT_ASSET_COMMAND;
            }
            content = parse(content, { chatRef: chatTarget, chara: currentChar, role: card.role });
        } else if (card.type2 === "main") {
            content = parse(content, { chatRef: chatTarget, chara: currentChar, role: card.role });
        } else {
            content = parse(content, { chatRef: chatTarget, chara: currentChar, role: card.role });
        }
        return { role: convertPromptRole[card.role], content };
    };

    const tokenizeChat = async (chat: OpenAIChat) => {
        const tokens = await tokenizer.tokenizeChat(chat);
        host.fence();
        return tokens;
    };

    if (promptTemplate) {
        const template = promptTemplate;
        async function tokenizeChatArray(chats: OpenAIChat[]) {
            for (const chat of chats) {
                const tokens = await tokenizeChat(chat);
                currentTokens += tokens;
            }
        }
        for (const card of template) {
            switch (card.type) {
                case "persona": {
                    const pmt = clone(unformated.personaPrompt);
                    applyPromptBlockRole(pmt, card.role2);
                    if (card.innerFormat && pmt.length > 0) {
                        for (let i = 0; i < pmt.length; i++) {
                            pmt[i].content = parse(positionParser(card.innerFormat, card.type), {
                                chatRef: chatTarget,
                                chara: currentChar,
                            }).replace("{{slot}}", pmt[i].content);
                        }
                    }
                    await tokenizeChatArray(pmt);
                    break;
                }
                case "description": {
                    const pmt = getDescriptionPrompts(card.role2);
                    if (card.innerFormat && pmt.length > 0) {
                        for (let i = 0; i < pmt.length; i++) {
                            pmt[i].content = parse(positionParser(card.innerFormat, card.type), {
                                chatRef: chatTarget,
                                chara: currentChar,
                            }).replace("{{slot}}", pmt[i].content);
                        }
                    }
                    await tokenizeChatArray(pmt);
                    break;
                }
                case "authornote": {
                    const pmt = clone(unformated.authorNote);
                    applyPromptBlockRole(pmt, card.role2);
                    if (card.innerFormat && pmt.length > 0) {
                        for (let i = 0; i < pmt.length; i++) {
                            pmt[i].content = parse(positionParser(card.innerFormat, card.type), {
                                chatRef: chatTarget,
                                chara: currentChar,
                            }).replace("{{slot}}", pmt[i].content || card.defaultText || "");
                        }
                    }
                    await tokenizeChatArray(pmt);
                    break;
                }
                case "lorebook": {
                    await tokenizeChatArray(unformated.lorebook);
                    break;
                }
                case "postEverything": {
                    await tokenizeChatArray(unformated.postEverything);
                    if (usingPromptTemplate && db.promptSettings.postEndInnerFormat) {
                        await tokenizeChatArray([{ role: "system", content: db.promptSettings.postEndInnerFormat }]);
                    }
                    break;
                }
                case "plain":
                case "jailbreak":
                case "cot": {
                    if (!db.jailbreakToggle && card.type === "jailbreak") {
                        continue;
                    }
                    if (!db.chainOfThought && card.type === "cot") {
                        continue;
                    }
                    await tokenizeChatArray([plainCardPrompt(card)]);
                    break;
                }
                case "chatML": {
                    const prompts = parseChatML(card.text, (text) => parse(text));
                    await tokenizeChatArray(prompts!);
                    break;
                }
                case "chat": {
                    const { start, end } = chatRange(card);
                    if (start >= end) {
                        break;
                    }
                    let chats = unformated.chats.slice(start, end);
                    if (usingPromptTemplate && db.promptSettings.sendChatAsSystem && !card.chatAsOriginalOnSystem) {
                        chats = systemizeChat(chats);
                    }
                    await tokenizeChatArray(chats);
                    break;
                }
                case "memory": {
                    supaMemoryCardUsed = true;
                    break;
                }
                case "cache": {
                    hasCachePoint = true;
                    break;
                }
            }
        }
    } else {
        for (const key in unformated) {
            const chats = unformated[key as keyof typeof unformated] as OpenAIChat[];
            for (const chat of chats) {
                currentTokens += await tokenizeChat(chat);
            }
        }
    }

    const examples = exampleMessage(currentChar, parse);
    for (const example of examples) {
        currentTokens += await tokenizeChat(example);
    }

    let chats: OpenAIChat[] = examples;

    if (!db.aiModel.startsWith("novelai") && !db?.promptSettings?.trimStartNewChat) {
        chats.push({ role: "system", content: "[Start a new chat]", memo: "NewChat" });
    }
    // Where the chat history (the greeting, then the stored messages) starts; the example dialogue and
    // the new-chat marker before it are not history the trim question protects.
    const historyStart = chats.length;

    let msReseted = false;
    const makeMs = (currentChat: Chat) => {
        const mss: Message[] = [];
        msReseted = false;
        for (let i = currentChat.message.length - 1; i >= 0; i--) {
            const d = currentChat.message[i];
            if (d.disabled === true) {
                continue;
            }
            if (d.disabled === "allBefore") {
                msReseted = true;
                break;
            }
            mss.unshift(d);
        }
        return mss;
    };

    let ms: Message[] = makeMs(currentChat);

    if (nowChatroom.type !== "group" && !msReseted) {
        const firstMsg =
            currentChat.fmIndex === -1
                ? nowChatroom.firstMessage
                : nowChatroom.alternateGreetings[currentChat.fmIndex as number];
        const chat: OpenAIChat = {
            role: "assistant",
            content: (
                await host.scripts.process(
                    nowChatroom,
                    parse(firstMsg, { chatRef: chatTarget, chara: currentChar }),
                    "editprocess",
                    -1,
                    {},
                )
            ).data,
        };
        host.fence();
        if (usingPromptTemplate && db.promptSettings.sendName) {
            chat.content = `${currentChar.name}: ${chat.content}`;
            chat.attr = ["nameAdded"];
        }
        chats.push(chat);
        currentTokens += await tokenizeChat(chat);
    }

    const triggerResult = await host.runStartTrigger();
    host.fence();
    if (triggerResult) {
        currentChat = host.chat() ?? triggerResult.chat;
        ms = makeMs(currentChat);
        currentTokens += triggerResult.tokens;
        if (triggerResult.stopSending) {
            return { type: "stopped" };
        }
    }

    const modelinfo = host.getModelInfo(db.aiModel);
    let index = 0;
    for (const msg of ms) {
        let formatedChat = (
            await host.scripts.process(
                nowChatroom,
                parse(msg.data, { chatRef: chatTarget, chara: currentChar, role: msg.role }),
                "editprocess",
                index,
                { chatRole: msg.role },
            )
        ).data;
        host.fence();
        const inlays: string[] = [];
        if (msg.role === "char") {
            formatedChat = formatedChat.replace(
                /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
                (match: string, p1: string, p2: string) => {
                    if (p2 && p1 === "inlayeddata") {
                        inlays.push(p2);
                    }
                    return "";
                },
            );
        } else {
            const inlayMatch = formatedChat.match(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g);
            if (inlayMatch) {
                for (const inlay of inlayMatch) {
                    inlays.push(inlay);
                }
            }
        }

        const multimodal: MultiModal[] = [];
        if (inlays.length > 0) {
            for (const inlay of inlays) {
                const inlayName = inlay
                    .replace("{{inlayed::", "")
                    .replace("{{inlay::", "")
                    .replace("}}", "")
                    .replace("{{inlayeddata::", "");
                const inlayData = await host.readInlay(inlayName);
                host.fence();
                if (inlayData?.type === "image") {
                    if (modelinfo.flags.includes(LLMFlags.hasImageInput)) {
                        multimodal.push({
                            type: "image",
                            base64: inlayData.data,
                            width: inlayData.width,
                            height: inlayData.height,
                        });
                    } else {
                        const caption = await host.captionImage(inlayData.data);
                        host.fence();
                        formatedChat += `[${caption}]`;
                    }
                }
                if (inlayData?.type === "video" || inlayData?.type === "audio") {
                    if (multimodal.length === 0) {
                        multimodal.push({ type: inlayData.type, base64: inlayData.data });
                    }
                }
                if (inlayData?.type === "signature") {
                    multimodal.push({ type: "signature", base64: inlayData.data });
                }
                formatedChat = formatedChat.replace(inlay, "");
            }
        }

        const attr: string[] = [];
        let role: "user" | "assistant" | "system" = msg.role === "user" ? "user" : "assistant";

        if (
            (nowChatroom.type === "group" && findCharacterbyIdwithCache(msg.saying).chaId !== currentChar.chaId) ||
            (nowChatroom.type === "group" && db.groupOtherBotRole === "assistant") ||
            (usingPromptTemplate && db.promptSettings.sendName)
        ) {
            const form = db.groupTemplate || `<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`;
            formatedChat = parse(form, {
                chatRef: chatTarget,
                chara: findCharacterbyIdwithCache(msg.saying).name,
            }).replace("{{slot}}", formatedChat);
            switch (db.groupOtherBotRole) {
                case "user":
                case "assistant":
                case "system":
                    role = db.groupOtherBotRole;
                    break;
                default:
                    role = "assistant";
                    break;
            }
        }
        const thoughts: string[] = [];
        const maxThoughtDepth = db.promptSettings?.maxThoughtTagDepth ?? -1;
        const stripped = stripThoughtsBlock(formatedChat);
        formatedChat = stripped.text;
        for (const p1 of stripped.thoughts) {
            if (maxThoughtDepth === -1 || maxThoughtDepth - ms.length <= index) {
                thoughts.push(p1);
            }
        }

        const assetPromises: Promise<void>[] = [];
        formatedChat = formatedChat.replace(/\{\{asset_?prompt::(.+?)\}\}/gimsu, (match, p1) => {
            const moduleAssets = host.moduleAssets();
            const assets = (currentChar.additionalAssets ?? []).concat(moduleAssets);
            const asset = assets.find((v) => v[0] === p1);
            const readInto = (path: string) =>
                assetPromises.push(
                    (async () => {
                        const assetDataBuf = (await host.readAsset(path)) ?? new Uint8Array();
                        multimodal.push({
                            type: "image",
                            base64: `data:image/png;base64,${Buffer.from(assetDataBuf).toString("base64")}`,
                        });
                    })(),
                );
            if (asset) {
                readInto(asset[1]);
            } else if (p1 === "icon") {
                readInto(currentChar.image ?? "");
            }
            return "";
        });
        await Promise.all(assetPromises);
        host.fence();

        const chat: OpenAIChat = {
            role: role,
            content: formatedChat,
            memo: msg.chatId,
            attr: attr,
            multimodals: multimodal,
            thoughts: thoughts,
        };
        if (chat.multimodals!.length === 0) {
            delete chat.multimodals;
        }
        chats.push(chat);
        currentTokens += await tokenizeChat(chat);
        index++;
    }

    const depthPrompts = lorepmt.actives.filter((v) => (v.pos === "depth" && v.depth > 0) || v.pos === "reverse_depth");
    for (const depthPrompt of depthPrompts) {
        const chat: OpenAIChat = {
            role: depthPrompt.role,
            content: parse(resolvePosition(depthPrompt.prompt), { chatRef: chatTarget, chara: currentChar }),
        };
        currentTokens += await tokenizeChat(chat);
    }

    const memoryConfigured = db.supaModelType !== "none" || db.hanuraiEnable || db.hypav2 || db.hypaV3;
    let useMemory = memoryConfigured && (!!nowChatroom.supaMemory || host.memoryTrim.enabled());
    if (memoryConfigured && !useMemory && currentTokens > maxContextTokens) {
        // The entries the trim below would drop, counted as it counts them: the question is asked only
        // when they reach the chat history.
        let tokens = currentTokens;
        let dropped = 0;
        while (tokens > maxContextTokens && chats.length - dropped > 1) {
            tokens -= await tokenizeChat(chats[dropped]);
            dropped++;
        }
        if (dropped > historyStart) {
            useMemory = (await host.memoryTrim.confirm()) === "memory";
            host.fence();
        }
    }

    if (useMemory) {
        input.stageTimings.stage1Duration = Date.now() - stage1Start;
        const stage2Start = Date.now();
        // The algorithms count through the job's tokenizer and repair and extend the chat they are
        // given: a detached copy (the result is saved below).
        const memoryTokenizer = { tokenizeChat };
        const detachedChat = () => structuredClone(currentChat);
        const memory = host.memory;
        try {
            if (db.hanuraiEnable) {
                const hn = await hanuraiMemory(memory, chats, {
                    currentTokens,
                    maxContextTokens,
                    tokenizer: memoryTokenizer,
                    tooMuchToken: TOO_MUCH_TOKEN,
                });
                host.fence();

                if ("alert" in hn) {
                    return { type: "alert", error: hn.alert };
                }

                chats = hn.chats;
                currentTokens = hn.tokens;
            } else if (db.hypav2) {
                const sp = await hypaMemoryV2(
                    memory,
                    chats,
                    currentTokens,
                    maxContextTokens,
                    detachedChat(),
                    nowChatroom,
                    memoryTokenizer,
                );
                host.fence();
                if (sp.error) {
                    return { type: "error", error: sp.error };
                }
                chats = sp.chats;
                currentTokens = sp.currentTokens;
                if (sp.memory) {
                    const data = sp.memory;
                    host.writeMemory(() => ({ hypaV2Data: data }));
                }

                currentChat = host.chat();
            } else if (db.hypaV3) {
                const sp = await hypaMemoryV3(
                    memory,
                    chats,
                    currentTokens,
                    maxContextTokens,
                    detachedChat(),
                    nowChatroom,
                    memoryTokenizer,
                );
                host.fence();
                if (sp.error) {
                    // Save new summary
                    if (sp.memory) {
                        const data = sp.memory;
                        host.writeMemory(() => ({ hypaV3Data: data }));
                    }
                    return { type: "error", error: sp.error };
                }
                chats = sp.chats;
                currentTokens = sp.currentTokens;
                if (sp.memory) {
                    const data = sp.memory;
                    host.writeMemory(() => ({ hypaV3Data: data }));
                }

                currentChat = host.chat();
            } else {
                const sp = await supaMemory(
                    memory,
                    chats,
                    currentTokens,
                    maxContextTokens,
                    detachedChat(),
                    nowChatroom,
                    memoryTokenizer,
                    {
                        asHyper: db.hypaMemory,
                    },
                );
                host.fence();
                if (sp.error) {
                    return { type: "error", error: sp.error };
                }
                chats = sp.chats;
                currentTokens = sp.currentTokens;
                if (sp.memory || sp.lastId) {
                    // The client's fallbacks (`currentChat`'s fields), read from the chat as stored now.
                    host.writeMemory((stored) => ({
                        supaMemoryData: sp.memory ?? stored.supaMemoryData,
                        lastMemory: sp.lastId ?? stored.lastMemory,
                    }));
                }
                currentChat = host.chat();
            }
        } finally {
            host.endMemoryProgress();
        }
        input.stageTimings.stage2Duration = Date.now() - stage2Start;
    } else {
        input.stageTimings.stage1Duration = Date.now() - stage1Start;
        while (currentTokens > maxContextTokens) {
            if (chats.length <= 1) {
                return { type: "error", error: TOO_MUCH_TOKEN + "\n\nRequired Tokens: " + currentTokens };
            }
            currentTokens -= await tokenizeChat(chats[0]);
            chats.splice(0, 1);
        }
        // The first kept message's memo, or none (a stale one would outlive the trim).
        host.setLastMemory(chats[0]?.memo);
    }

    const biases: [string, number][] = db.bias.concat(currentChar.bias).map((v) => [
        parse(v[0].replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\\\", "\\"), {
            chatRef: chatTarget,
            chara: currentChar,
        }),
        v[1],
    ]);

    const memories: OpenAIChat[] = [];

    if (!promptTemplate) {
        unformated.lastChat.push(chats[chats.length - 1]);
        chats.splice(chats.length - 1, 1);
    }

    unformated.chats = chats
        .map((v) => {
            if (v.memo !== "supaMemory" && v.memo !== "hypaMemory") {
                v.removable = true;
            } else if (supaMemoryCardUsed) {
                memories.push(v);
                return { role: "system", content: "" } as OpenAIChat;
            } else {
                v.content = `<Previous Conversation>${v.content}</Previous Conversation>`;
            }
            return v;
        })
        .filter((v) => v.content.trim() !== "" || (v.multimodals && v.multimodals.length > 0));

    for (const depthPrompt of depthPrompts) {
        const chat: OpenAIChat = {
            role: depthPrompt.role,
            content: parse(resolvePosition(depthPrompt.prompt), { chatRef: chatTarget, chara: currentChar }),
        };
        const depth = depthPrompt.pos === "depth" ? depthPrompt.depth : unformated.chats.length - depthPrompt.depth;
        unformated.chats.splice(depth, 0, chat);
    }

    if (triggerResult) {
        if (triggerResult.additonalSysPrompt.promptend) {
            unformated.postEverything.push({ role: "system", content: triggerResult.additonalSysPrompt.promptend });
        }
        if (triggerResult.additonalSysPrompt.historyend) {
            unformated.lastChat.push({ role: "system", content: triggerResult.additonalSysPrompt.historyend });
        }
        if (triggerResult.additonalSysPrompt.start) {
            unformated.lastChat.unshift({ role: "system", content: triggerResult.additonalSysPrompt.start });
        }
    }

    let formated: OpenAIChat[] = [];
    const formatOrder = db.formatingOrder ? clone(db.formatingOrder) : db.formatingOrder;
    if (formatOrder) {
        formatOrder.push("postEverything");
    }

    // continue chat model
    if (
        input.continue &&
        (db.aiModel.startsWith("claude") ||
            db.aiModel.startsWith("gpt") ||
            db.aiModel.startsWith("openrouter") ||
            db.aiModel.startsWith("reverse_proxy"))
    ) {
        unformated.postEverything.push({ role: "system", content: "[Continue the last response]" });
    }

    function pushPrompts(cha: OpenAIChat[]) {
        for (const chat of cha) {
            if (!chat.content.trim() && !(chat.multimodals && chat.multimodals.length > 0)) {
                continue;
            }
            if (!(
                db.aiModel.startsWith("gpt") ||
                db.aiModel.startsWith("claude") ||
                db.aiModel === "openrouter" ||
                db.aiModel === "reverse_proxy"
            )) {
                formated.push(chat);
                continue;
            }
            if (chat.role === "system") {
                const endf = formated.at(-1);
                if (endf && endf.role === "system" && endf.memo === chat.memo && endf.name === chat.name) {
                    formated[formated.length - 1].content += "\n\n" + chat.content;
                } else {
                    formated.push(chat);
                }
                formated.at(-1)!.content += "";
            } else {
                formated.push(chat);
            }
        }
    }

    let promptBodyformatedForChatStore: OpenAIChat[] = [];
    function pushPromptInfoBody(
        role: "function" | "system" | "user" | "assistant",
        fmt: string,
        promptBody: OpenAIChat[],
    ) {
        if (!fmt.trim()) {
            return;
        }
        promptBody.push({ role: role, content: parse(fmt, { chatRef: chatTarget }) });
    }
    const promptText = db.promptInfoInsideChat && db.promptTextInfoInsideChat;

    /** The `persona`/`description`/`authornote`/`memory` card's inner format over `pmt`. */
    const innerFormat = (
        pmt: OpenAIChat[],
        card: PromptItemTyped | { type: "authornote"; innerFormat?: string; defaultText?: string },
        position: boolean,
        slot: (content: string) => string,
    ) => {
        if (card.innerFormat && pmt.length > 0) {
            for (let i = 0; i < pmt.length; i++) {
                pmt[i].content = parse(position ? positionParser(card.innerFormat, card.type) : card.innerFormat, {
                    chatRef: chatTarget,
                    chara: currentChar,
                }).replace("{{slot}}", slot(pmt[i].content));
                if (promptText) {
                    pushPromptInfoBody(pmt[i].role, card.innerFormat, promptBodyformatedForChatStore);
                }
            }
        }
    };

    if (promptTemplate) {
        const template = promptTemplate;
        for (const card of template) {
            switch (card.type) {
                case "persona": {
                    const pmt = clone(unformated.personaPrompt);
                    applyPromptBlockRole(pmt, card.role2);
                    innerFormat(pmt, card, true, (content) => content);
                    pushPrompts(pmt);
                    break;
                }
                case "description": {
                    const pmt = getDescriptionPrompts(card.role2);
                    innerFormat(pmt, card, true, (content) => content);
                    pushPrompts(pmt);
                    break;
                }
                case "authornote": {
                    const pmt = clone(unformated.authorNote);
                    applyPromptBlockRole(pmt, card.role2);
                    innerFormat(pmt, card, true, (content) => content || card.defaultText || "");
                    pushPrompts(pmt);
                    break;
                }
                case "lorebook": {
                    pushPrompts(unformated.lorebook);
                    break;
                }
                case "postEverything": {
                    pushPrompts(unformated.postEverything);
                    if (usingPromptTemplate && db.promptSettings.postEndInnerFormat) {
                        pushPrompts([{ role: "system", content: db.promptSettings.postEndInnerFormat }]);
                    }
                    break;
                }
                case "plain":
                case "jailbreak":
                case "cot": {
                    if (!db.jailbreakToggle && card.type === "jailbreak") {
                        continue;
                    }
                    if (!db.chainOfThought && card.type === "cot") {
                        continue;
                    }
                    const prompt = plainCardPrompt(card);
                    if (promptText && card.type2 !== "globalNote") {
                        pushPromptInfoBody(prompt.role, prompt.content, promptBodyformatedForChatStore);
                    }
                    pushPrompts([prompt]);
                    break;
                }
                case "chatML": {
                    const prompts = parseChatML(card.text, (text) => parse(text));
                    pushPrompts(prompts!);
                    break;
                }
                case "chat": {
                    const { start, end } = chatRange(card);
                    if (start >= end) {
                        break;
                    }
                    let chats = unformated.chats.slice(start, end);
                    if (usingPromptTemplate && db.promptSettings.sendChatAsSystem && !card.chatAsOriginalOnSystem) {
                        chats = systemizeChat(chats);
                    }
                    pushPrompts(chats);
                    if (db.automaticCachePoint && !hasCachePoint) {
                        let pointer = formated.length - 1;
                        let depthRemaining = 3;
                        while (pointer >= 0) {
                            if (depthRemaining === 0) {
                                break;
                            }
                            if (formated[pointer].role === "user") {
                                formated[pointer].cachePoint = true;
                                depthRemaining--;
                            }
                            pointer--;
                        }
                    }
                    break;
                }
                case "memory": {
                    const pmt = clone(memories);
                    applyPromptBlockRole(pmt, card.role2);
                    innerFormat(pmt, card, false, (content) => content);
                    pushPrompts(pmt);
                    break;
                }
                case "cache": {
                    let pointer = formated.length - 1;
                    let depthRemaining = card.depth;
                    while (pointer >= 0) {
                        if (depthRemaining === 0) {
                            break;
                        }
                        if (formated[pointer].role === card.role || card.role === "all") {
                            formated[pointer].cachePoint = true;
                            depthRemaining--;
                        }
                        pointer--;
                    }
                    break;
                }
            }
        }
    } else {
        for (let i = 0; i < formatOrder.length; i++) {
            const cha = unformated[formatOrder[i] as keyof typeof unformated];
            pushPrompts(cha);
        }
    }

    formated = formated.map((v) => {
        v.content = v.content.trim();
        return v;
    });

    if (promptText) {
        promptBodyformatedForChatStore = promptBodyformatedForChatStore.map((v) => {
            v.content = v.content.trim();
            return v;
        });
    }

    if (currentChar.depth_prompt && currentChar.depth_prompt.prompt && currentChar.depth_prompt.prompt.length > 0) {
        const depthPrompt = currentChar.depth_prompt;
        formated.splice(formated.length - depthPrompt.depth, 0, {
            role: "system",
            content: parse(depthPrompt.prompt, { chatRef: chatTarget, chara: currentChar }),
        });
    }

    formated = await host.runEditRequest(formated);
    host.fence();

    if (promptText) {
        promptBodyformatedForChatStore = await host.runEditRequest(promptBodyformatedForChatStore);
        host.fence();
        promptInfo.promptText = promptBodyformatedForChatStore;
    }

    // token rechecking
    let inputTokens = 0;
    for (const chat of formated) {
        inputTokens += await tokenizeChat(chat);
    }
    if (inputTokens > maxContextTokens) {
        let pointer = 0;
        while (inputTokens > maxContextTokens) {
            if (pointer >= formated.length) {
                return {
                    type: "error",
                    error: TOO_MUCH_TOKEN + "\n\nAt token rechecking. Required Tokens: " + inputTokens,
                };
            }
            if (formated[pointer].removable) {
                inputTokens -= await tokenizeChat(formated[pointer]);
                formated[pointer].content = "";
                delete formated[pointer].multimodals;
            }
            pointer++;
        }
        formated = formated.filter((v) => v.content !== "" || (v.multimodals && v.multimodals.length > 0));
    }

    // estimate tokens
    let outputTokens = db.maxResponse;
    if (inputTokens + outputTokens > maxContextTokens) {
        outputTokens = maxContextTokens - inputTokens;
    }
    const generationInfo: MessageGenerationInfo = {
        model: getGenerationModelString(db),
        generationId: input.generationId,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        maxContext: maxContextTokens,
        stageTiming: {
            stage1: input.stageTimings.stage1Duration,
            stage2: input.stageTimings.stage2Duration,
            stage3: 0,
            stage4: 0,
        },
    };

    return { type: "prompt", formated, biases, generationInfo, promptInfo, maxContextTokens };
}
