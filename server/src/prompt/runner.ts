import { randomUUID } from "node:crypto";
import type { ChatOp, CheckpointOutcome, MessageGeneration } from "../../../shared/chats.ts";
import type { Chat, character, groupChat, Message, MessageGenerationInfo } from "../../../shared/database.ts";
import type { StreamResponseChunk } from "../../../shared/llm/request.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { ChatTokenCounter } from "../../../shared/prompt/chatTokens.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import { jobModules } from "../jobs/cbsHost.ts";
import type { OwnedGeneration } from "../jobs/chatResult.ts";
import { GenerationRunnerError, JobWriteConflictError, type RunningJob } from "../jobs/generationJobs.ts";
import { type JobScope, loadJobScope, refreshCharacter, refreshChat, scopeChat } from "../jobs/jobScope.ts";
import {
    createJobRunState,
    createRunSetup,
    type GenerationRunnerDeps,
    type JobRunState,
    type RunSetup,
} from "../jobs/runSetup.ts";
import { mainModelTakesImages, tokenScopeFor } from "../llm/settings.ts";
import { LuaJobFatalError } from "../lua/bindings.ts";
import { readStorageFile } from "../routes/storage.ts";
import { type AssembledPrompt, assemblePrompt, getGenerationModelString } from "./assemble.ts";
import { createScriptProcessor } from "./scripts.ts";

/** How often a streaming reply's raw text is checkpointed (the client's `CHECKPOINT_INTERVAL_MS`). */
export const CHECKPOINT_INTERVAL_MS = 3000;

/** `isLastCharPunctuation` of `src/ts/util.ts`. */
export function isLastCharPunctuation(s: string): boolean {
    const lastChar = s.trim().at(-1);
    const punctuation = [
        ".",
        "!",
        "?",
        "。",
        "！",
        "？",
        "…",
        "@",
        "#",
        "$",
        "%",
        "^",
        "&",
        "*",
        "(",
        ")",
        "-",
        "_",
        "+",
        "=",
        "{",
        "}",
        "[",
        "]",
        "|",
        "\\",
        ":",
        ";",
        "<",
        ">",
        ",",
        ".",
        "/",
        "~",
        "`",
        " ",
        "¡",
        "¿",
        "‽",
        "⁉",
        "'",
        '"',
    ];
    if (
        lastChar &&
        !(
            punctuation.indexOf(lastChar) !== -1 ||
            // spacing modifier letters
            (lastChar.charCodeAt(0) >= 0x02b0 && lastChar.charCodeAt(0) <= 0x02ff) ||
            // combining diacritical marks
            (lastChar.charCodeAt(0) >= 0x0300 && lastChar.charCodeAt(0) <= 0x036f) ||
            // hebrew punctuation
            (lastChar.charCodeAt(0) >= 0x0590 && lastChar.charCodeAt(0) <= 0x05cf) ||
            // CJK symbols and punctuation
            (lastChar.charCodeAt(0) >= 0x3000 && lastChar.charCodeAt(0) <= 0x303f)
        )
    ) {
        return false;
    }
    return true;
}

/** `trimUntilPunctuation` of `src/ts/util.ts`. */
export function trimUntilPunctuation(s: string): string {
    let result = s;
    while (result.length > 0 && !isLastCharPunctuation(result)) {
        result = result.slice(0, -1);
    }
    return result;
}

type GroupOrder = { id: string; talkness: number; index: number };

/** lodash's `shuffle` (a copy, Fisher-Yates from the front) over `random`. */
function shuffle<T>(array: readonly T[], random: () => number): T[] {
    const result = array.slice();
    const lastIndex = result.length - 1;
    for (let index = 0; index < result.length; index++) {
        const rand = index + Math.floor(random() * (lastIndex - index + 1));
        const value = result[rand];
        result[rand] = result[index];
        result[index] = value;
    }
    return result;
}

function getWords(data: string) {
    const matches = data.split(/\n| /g);
    const words: string[] = [];
    if (!matches) {
        return [data];
    }
    for (const match of matches) {
        words.push(match.toLocaleLowerCase());
    }
    return words;
}

/** `groupOrder` of `src/ts/process/group.ts`: named members first, then by chance, never none. */
function groupOrder(
    chars: GroupOrder[],
    input: string | undefined,
    nameOf: (id: string) => string,
    random: () => number,
): GroupOrder[] {
    const order: GroupOrder[] = [];
    const ids: string[] = [];
    if (input) {
        const words = getWords(input);
        for (const word of words) {
            for (const char of chars) {
                const charNameChunks = getWords(nameOf(char.id));
                if (charNameChunks.includes(word)) {
                    order.push(char);
                    ids.push(char.id);
                    break;
                }
            }
        }
    }
    const shuffled = shuffle(chars, random);
    for (const char of shuffled) {
        if (ids.includes(char.id)) {
            continue;
        }
        const chance = char.talkness ?? 0.5;
        if (chance >= random()) {
            order.push(char);
            ids.push(char.id);
        }
    }
    while (order.length === 0) {
        order.push(chars[Math.floor(random() * chars.length)]);
    }
    return order;
}

/** `findCharacterbyId`: a character by id, or a blank "Unknown Character". */
function findCharacter(scope: JobScope, id: string | undefined): character {
    for (const char of scope.db.characters) {
        if (char.type !== "group" && char.chaId === id) {
            return char;
        }
    }
    return { name: "Unknown Character", chats: [], chatPage: 0 } as unknown as character;
}

/** The kinds that run the input stage (a send's `userMessageId`). */
const INPUT_KINDS = new Set(["send", "continue", "reroll", "group"]);

/** The fields `setPreset` keeps on a preset change unless its toggle says otherwise, with the default each gets. */
const KEEP_RULES = [
    { flag: "doNotChangeSeperateModels", field: "seperateModelsForAxModels", fallback: () => false },
    {
        flag: "doNotChangeSeperateModels",
        field: "seperateModels",
        fallback: () => ({ memory: "", emotion: "", translate: "", otherAx: "" }),
    },
    {
        flag: "doNotChangeFallbackModels",
        field: "fallbackModels",
        fallback: () => ({ memory: [], emotion: [], translate: [], otherAx: [], model: [] }),
    },
    { flag: "doNotChangeFallbackModels", field: "fallbackWhenBlankResponse", fallback: () => false },
    {
        flag: "disableSeperateParameterChangeOnPresetChange",
        field: "seperateParameters",
        fallback: () => ({ memory: {}, emotion: {}, translate: {}, otherAx: {}, overrides: {} }),
    },
] as const;

/**
 * The job's preset after a `presetChain` pick (`changeToPreset(id, true)`): the scope of that preset,
 * whose five "keep on preset change" root fields take the new preset's values unless their toggle
 * keeps them. Picking the selected preset changes nothing (its working values were just saved into
 * it). Nothing is written: the tab applies the switch to its own selection (`preset` event).
 */
function applyPresetKeepRules(scope: JobScope, previousPresetId: string) {
    if (scope.preset.id === previousPresetId) {
        return;
    }
    const preset = scope.preset as unknown as Record<string, unknown>;
    for (const target of [
        scope.db as unknown as Record<string, unknown>,
        scope.request.db as Record<string, unknown>,
    ]) {
        for (const rule of KEEP_RULES) {
            if (!scope.db[rule.flag]) {
                target[rule.field] =
                    preset[rule.field] !== undefined && preset[rule.field] !== null
                        ? structuredClone(preset[rule.field])
                        : rule.fallback();
            }
        }
    }
}

/** The error a send's `throwError` shows when `inlayErrorResponse` is off. */
class SendError extends GenerationRunnerError {
    constructor(message: string) {
        super(500, message);
        this.name = "SendError";
    }
}

/**
 * A send, continue, group send, or preview (Phase 5 slice 9): `sendMain`'s input stage and
 * `sendChat` up to the provider call and the raw reply, on the server. The sequence:
 *
 * 1. `accepted` (no message) with the chat's revision.
 * 2. The input stage (a send with a nonempty `input`, unless the chat already holds the user message
 *    `userMessageId`): for a character, the `input` trigger on a copy of the chat as stored, then
 *    `editinput`, then the user message appended under that id; a group appends the input as it came.
 *    `accepted { userMessageId }` follows. It runs on the admitted preset, before `presetChain`, as
 *    the tab runs it before `sendChat`.
 * 3. `presetChain` (by name, with `deps.random`): the job's scope becomes the picked preset's (the
 *    keep rules of `setPreset`), later callbacks name it, and `preset { presetId }` tells the tab.
 * 4. The speakers: the character, or the group's members in `groupChat`'s order (one budget, one
 *    effect count, each speaker's own bindings and request projection). A preview stops after the
 *    first; a speaker that fails ends the loop.
 * 5. Per speaker: a continue's message is locked first (`begin`, `accepted`); the prompt is assembled
 *    (`assemblePrompt`); `preview` ends with the messages, `previewPrompt` with the provider body.
 *    Otherwise the request runs, and the reply is appended (or the continued message extended) and
 *    streamed: `chunk` per provider chunk, a raw checkpoint every 3 s, and the final raw write at the
 *    end, after an abort (inside the grace), or after a read failure. Non-streaming replies are
 *    written once. `editoutput`, the output trigger, inlays, listeners, TTS, auto-continue, the
 *    resend, `igp`, and emotion are `post-generation-and-plugin-callbacks`'s: the stored reply is raw.
 * 6. `done` with the last reply's id and the reroll alternatives.
 *
 * `throwError` with `inlayErrorResponse` writes the error into the chat as the client does; without
 * it the job ends with the error.
 */
export async function runPromptJob(job: RunningJob, deps: GenerationRunnerDeps): Promise<void> {
    const state = createJobRunState(job);
    let setup: RunSetup | null = null;
    try {
        await runSend(job, deps, state, (next) => {
            setup = next;
        });
    } catch (error) {
        const fatal = (setup as RunSetup | null)?.bindings.fatal();
        if (fatal) {
            throw fatal;
        }
        if (job.signal.aborted || error instanceof GenerationRunnerError || error instanceof LuaJobFatalError) {
            throw error;
        }
        throw new GenerationRunnerError(500, error instanceof Error ? error.message : String(error));
    }
}

/** A message the job generates: its generation id and the checkpoint counter of its writes. */
type Generation = { messageId: string; generationId: string; seq: number; final: boolean };

async function runSend(
    job: RunningJob,
    deps: GenerationRunnerDeps,
    state: JobRunState,
    onSetup: (setup: RunSetup) => void,
): Promise<void> {
    const { store, kinds } = deps;
    const { characterId, chatId } = job.context;
    const random = deps.random ?? Math.random;
    let scope = loadJobScope(store, kinds, job.context);
    job.emit({ type: "accepted", jobId: job.id, revision: scope.chatRevision, text: "" });
    const owner = scope.db.characters.find((entry) => entry?.chaId === characterId);
    if (!owner) {
        throw new GenerationRunnerError(404, "The job's character no longer exists");
    }
    const preview = job.kind === "preview" || job.kind === "previewPrompt";

    // `presetChain` (the tab's top-level send picks one preset for the whole send): picked and read
    // with the admitted configuration, applied after the input stage, where the tab's `sendChat` picks it.
    let chain: { scope: JobScope; presetId: string } | { missing: string } | null = null;
    if (scope.db.presetChain) {
        const names = scope.db.presetChain.split(",").map((v) => v.trim());
        const ele = names[Math.floor(random() * names.length)];
        const found = scope.db.botPresets.find((preset) => preset.name === ele);
        if (!found) {
            chain = { missing: ele };
        } else {
            const picked = loadJobScope(store, kinds, { ...job.context, presetId: found.id });
            applyPresetKeepRules(picked, scope.preset.id);
            chain = { scope: picked, presetId: found.id };
        }
    }

    /** Writes the job's chat as the job itself (no Lua fence: the abort grace may still persist text). */
    const writeOwn = (ops: ChatOp[], covers?: { messageId: string; generationId: string; seq: number }[]) => {
        refreshChat(store, scope);
        const applied = job.write(
            () => ({
                chats: [{ characterId, chatId, baseRevision: scope.chatRevision, ops }],
            }),
            covers ? { covers } : undefined,
        );
        refreshChat(store, scope);
        job.emitRecords({ chats: [{ characterId, id: chatId }] });
        return applied.chats[0]?.checkpoints ?? [];
    };

    // The input stage, on the admitted preset.
    if (INPUT_KINDS.has(job.kind) && job.context.input !== "") {
        const userMessageId = job.context.userMessageId ?? randomUUID();
        const existing = scopeChat(scope)?.message.find((message) => message.chatId === userMessageId);
        if (!existing || existing.role !== "user") {
            if (existing) {
                throw new GenerationRunnerError(409, "The user message id belongs to another message");
            }
            const setup = createRunSetup(job, deps, state, scope, {
                runCharacterId: characterId,
                engineCharacterId: characterId,
            });
            onSetup(setup);
            let data = job.context.input;
            if (owner.type === "character") {
                await setup.runOnCopy(owner, "input");
                if (!setup.bindings.services.refresh()) {
                    throw new GenerationRunnerError(404, "The job's chat no longer exists");
                }
                const processor = createScriptProcessor({
                    job,
                    setup,
                    scriptWorkers: deps.scriptWorkers,
                    lock: deps.lock,
                    cache: state.scriptCache,
                });
                data = (await processor.process(owner, data, "editinput")).data;
                if (!setup.bindings.services.refresh()) {
                    throw new GenerationRunnerError(404, "The job's chat no longer exists");
                }
            }
            setup.check();
            writeOwn([
                {
                    op: "append",
                    messages: [{ role: "user", data, time: Date.now(), chatId: userMessageId }],
                    anchor: { end: true },
                },
            ]);
            job.emit({ type: "accepted", jobId: job.id, userMessageId, revision: scope.chatRevision, text: "" });
        }
    }

    if (chain && "missing" in chain) {
        job.channel.notice({ kind: "alertToast", payload: { message: `Cannot find preset: ${chain.missing}` } });
    } else if (chain) {
        // The working state as the input stage left it, on the picked preset's configuration.
        scope = chain.scope;
        refreshChat(store, scope);
        refreshCharacter(store, kinds, scope, characterId);
        job.setCallbackPreset?.(chain.presetId);
        job.emit({ type: "preset", presetId: chain.presetId });
    }

    const caculatedChatTokens = scope.db.aiModel.startsWith("gpt") ? 5 : 3;
    // The owner as the input stage and the preset pick left the projection.
    const sendOwner = scope.db.characters.find((entry) => entry?.chaId === characterId);
    if (!sendOwner) {
        throw new GenerationRunnerError(404, "The job's character no longer exists");
    }

    // The speakers.
    let speakers: string[];
    if (sendOwner.type === "group") {
        const group = sendOwner;
        if (job.context.speakerChaId) {
            speakers = [job.context.speakerChaId];
        } else {
            const messages = scopeChat(scope)?.message ?? [];
            const lastMessage = messages[messages.length - 1];
            let order = group.characters
                .map((v, i) => ({ id: v, talkness: group.characterActive[i] ? group.characterTalks[i] : -1, index: i }))
                .filter((v) => v.talkness > 0);
            if (!group.orderByOrder) {
                order = groupOrder(order, lastMessage?.data, (id) => findCharacter(scope, id).name, random).filter(
                    (v) => v.id !== lastMessage?.saying,
                );
            }
            speakers = order.map((v) => v.id);
        }
    } else {
        speakers = [sendOwner.chaId];
    }

    const baseRequest = scope.request;
    let last: { messageId: string; alternatives?: string[] } | null = null;
    let stopped = false;
    for (const speakerId of speakers) {
        const result = await runSpeaker({
            job,
            deps,
            state,
            scope,
            owner: sendOwner,
            speakerId,
            chatAdditonalTokens: caculatedChatTokens,
            // A group send does not forward a continue to its speakers.
            continueSend: job.kind === "continue" && sendOwner.type !== "group",
            baseRequest,
            onSetup,
            writeOwn,
        });
        if (result.type === "preview") {
            job.emit({ type: "done", revision: store.chatRevision(characterId, chatId), result: result.result });
            return;
        }
        if (result.type === "stop") {
            stopped = true;
            break;
        }
        last = { messageId: result.messageId, ...(result.alternatives ? { alternatives: result.alternatives } : {}) };
        if (preview) {
            break;
        }
    }
    job.emit({
        type: "done",
        revision: store.chatRevision(characterId, chatId),
        ...(last ? { messageId: last.messageId } : {}),
        ...(last?.alternatives ? { alternatives: last.alternatives } : {}),
        ...(stopped ? { stopped: true as const } : {}),
    });
}

type SpeakerResult =
    | { type: "reply"; messageId: string; alternatives?: string[] }
    | { type: "preview"; result: unknown }
    /** The send ended for this speaker (an error shown, stopped by a trigger, nothing to continue). */
    | { type: "stop" };

async function runSpeaker(arg: {
    job: RunningJob;
    deps: GenerationRunnerDeps;
    state: JobRunState;
    scope: JobScope;
    owner: character | groupChat;
    speakerId: string;
    chatAdditonalTokens: number;
    continueSend: boolean;
    /** The job's request projection (frozen configuration) the speakers' projections derive from. */
    baseRequest: JobScope["request"];
    onSetup: (setup: RunSetup) => void;
    writeOwn: (
        ops: ChatOp[],
        covers?: { messageId: string; generationId: string; seq: number }[],
    ) => CheckpointOutcome[];
}): Promise<SpeakerResult> {
    const { job, deps, state, scope, owner, speakerId, writeOwn } = arg;
    const { store, kinds } = deps;
    const { characterId, chatId } = job.context;
    const db = scope.db;

    const chatRef = { chaId: characterId, chatId };
    const generationId = randomUUID();
    let generation: Generation | null = null;
    let generationInfo: MessageGenerationInfo | undefined;
    const chatNow = (): Chat | undefined => {
        refreshChat(store, scope);
        return scopeChat(scope);
    };
    const owned: OwnedGeneration = {
        get messageId() {
            return generation?.messageId ?? "";
        },
        next(): MessageGeneration {
            generation!.seq += 1;
            return { id: generation!.generationId, seq: generation!.seq };
        },
    };

    const currentChar = owner.type === "group" ? findCharacter(scope, speakerId) : owner;
    if (!currentChar.chaId) {
        return throwError(`cannot find character: ${speakerId}`);
    }
    if (owner.type === "group") {
        // The request projection names this speaker (its `speakerName`); its settings stay the job's.
        scope.request = { ...arg.baseRequest, speakerName: currentChar.name };
    }
    const setup = createRunSetup(job, deps, state, scope, {
        runCharacterId: currentChar.chaId,
        engineCharacterId: characterId,
    });
    arg.onSetup(setup);
    const { bindings, nativeCtx } = setup;
    const { services, evaluator } = bindings;

    /** `throwError`: into the chat with `inlayErrorResponse` (the last reply or a new message), else the job's error. */
    function throwError(error: string): SpeakerResult {
        if (!db.inlayErrorResponse) {
            throw new SendError(error);
        }
        const chat = chatNow();
        if (!chat) {
            throw new SendError(error);
        }
        const lastMessage = chat.message[chat.message.length - 1];
        const suffix = `\n\`\`\`risuerror\n${error}\n\`\`\``;
        if (lastMessage?.role === "char") {
            const mine = generation && !generation.final && generation.messageId === lastMessage.chatId;
            if (mine) {
                writeOwn([
                    {
                        op: "setText",
                        id: lastMessage.chatId!,
                        text: lastMessage.data + suffix,
                        generation: owned.next(),
                    },
                ]);
            } else if (deps.lock.holder(characterId, chatId, lastMessage.chatId!) === null) {
                writeOwn([{ op: "setText", id: lastMessage.chatId!, text: lastMessage.data + suffix }]);
            }
            return { type: "stop" };
        }
        const message: Message = {
            role: "char",
            data: `\`\`\`risuerror\n${error}\n\`\`\``,
            time: Date.now(),
            chatId: randomUUID(),
        };
        if (currentChar?.chaId) {
            message.saying = currentChar.chaId;
        }
        if (generationInfo) {
            message.generationInfo = generationInfo;
        }
        writeOwn([{ op: "append", messages: [message], anchor: { end: true } }]);
        return { type: "stop" };
    }

    /**
     * Closes the generation (its final write, the text as stored when none is given). A final write the
     * store ignored (another write closed the generation first) did not persist the reply: an error.
     */
    const finalize = (text?: string, covers?: number) => {
        if (!generation || generation.final) {
            return;
        }
        const stored = scopeChat(scope)?.message.find((message) => message.chatId === generation!.messageId);
        if (!stored) {
            generation.final = true;
            return;
        }
        generation.seq += 1;
        const gen = { id: generation.generationId, seq: generation.seq, final: true };
        generation.final = true;
        const outcomes = writeOwn(
            [{ op: "setText", id: generation.messageId, text: text ?? stored.data, generation: gen }],
            covers !== undefined
                ? [{ messageId: generation.messageId, generationId: generation.generationId, seq: covers }]
                : undefined,
        );
        if (outcomes.at(-1) === "ignored") {
            throw new GenerationRunnerError(409, "The reply was closed by another write before it was finished");
        }
    };

    try {
        // A continue locks the message it extends before anything else (the client's `startGeneration`).
        if (arg.continueSend && !(job.kind === "preview" || job.kind === "previewPrompt")) {
            const chat = chatNow();
            const continueMessageId = job.context.continueMessageId ?? chat?.message.at(-1)?.chatId;
            const target = chat?.message.find((message) => message.chatId === continueMessageId);
            if (!continueMessageId || !target) {
                return { type: "stop" };
            }
            setup.check();
            writeOwn([{ op: "begin", id: continueMessageId, generationId }]);
            generation = { messageId: continueMessageId, generationId, seq: 0, final: false };
            job.emit({
                type: "accepted",
                jobId: job.id,
                messageId: continueMessageId,
                generationId,
                revision: scope.chatRevision,
                text: target.data,
            });
        }

        const requestDb = scope.request.db;
        const scripts = createScriptProcessor({
            job,
            setup,
            scriptWorkers: deps.scriptWorkers,
            lock: deps.lock,
            cache: state.scriptCache,
        });
        const stageTimings = { stage1Duration: 0, stage2Duration: 0 };
        const assembled: AssembledPrompt = await assemblePrompt(
            {
                db,
                owner,
                speaker: currentChar,
                chatRef,
                parse: (text, parseArg) => evaluator.risuChatParser(text, { chatRef, ...parseArg }),
                chat: () => chatNow() ?? services.liveChat(),
                findCharacter: (id) => findCharacter(scope, id),
                userName: () => scope.effectivePersona.name,
                personaPrompt: () => scope.effectivePersona.personaPrompt,
                activateLore: () => services.activateLore(nativeCtx),
                scripts,
                runStartTrigger: () =>
                    setup.runOnCopy(currentChar, "start", {}, generation ? { generation: owned } : {}),
                runEditRequest: (formated) => scripts.editRequest(currentChar, formated),
                readInlay: (id) => bindings.readInlay(id),
                readAsset: (path) => readStorageFile(deps.savePath, path),
                moduleAssets: () => {
                    let assets: [string, string, string][] = [];
                    for (const module of jobModules(scope)) {
                        if (module?.assets) {
                            assets = assets.concat(module.assets);
                        }
                    }
                    return assets;
                },
                moduleToggles: () => {
                    let toggles = "";
                    for (const module of jobModules(scope)) {
                        if (module?.customModuleToggle) {
                            toggles += "\n" + module.customModuleToggle + "\n";
                        }
                    }
                    return toggles;
                },
                runCurrentChatFunction: () => {
                    const chat = chatNow();
                    if (!chat) {
                        return;
                    }
                    for (const message of chat.message) {
                        const data = evaluator.risuChatParser(message.data, {
                            chatRef,
                            chara: currentChar,
                            runVar: true,
                        });
                        if (data === message.data) {
                            continue;
                        }
                        const id = message.chatId!;
                        if (generation && !generation.final && generation.messageId === id) {
                            setup.check();
                            writeOwn([{ op: "setText", id, text: data, generation: owned.next() }]);
                        } else {
                            services.writeChat(
                                (current) =>
                                    current.message.some((entry) => entry.chatId === id)
                                        ? [{ op: "setText", id, text: data }]
                                        : null,
                                nativeCtx,
                            );
                        }
                    }
                },
                setLastMemory: (memo) => {
                    services.writeChat((chat) => {
                        if (chat.lastMemory === memo) {
                            return null;
                        }
                        return memo !== undefined
                            ? [{ op: "meta", set: { lastMemory: memo } }]
                            : [{ op: "meta", unset: ["lastMemory"] }];
                    }, nativeCtx);
                },
                tokenizer: new ChatTokenCounter(
                    arg.chatAdditonalTokens,
                    db.aiModel.startsWith("gpt") ? "noName" : "name",
                    {
                        encode: (text) => deps.tokens.encode(text, tokenScopeFor(requestDb)),
                        supportsInlayImage: () => mainModelTakesImages(requestDb),
                        gptVisionQuality: () => db.gptVisionQuality,
                    },
                ),
                getModelInfo: (model) =>
                    resolveModelInfo(model, {
                        enableCustomFlags: db.enableCustomFlags,
                        customFlags: db.customFlags,
                        customModels: db.customModels,
                    }),
                fence: () => setup.check(),
            },
            { chatAdditonalTokens: arg.chatAdditonalTokens, continue: arg.continueSend, generationId, stageTimings },
        );
        setup.check();
        if (assembled.type === "stopped") {
            return { type: "stop" };
        }
        if (assembled.type === "error") {
            return throwError(assembled.error);
        }
        const { formated, biases, promptInfo } = assembled;
        generationInfo = assembled.generationInfo;
        if (job.kind === "preview") {
            return { type: "preview", result: formated };
        }

        const req = await services.request(
            {
                formated,
                biasString: biases,
                currentChar,
                useStreaming: true,
                isGroupChat: owner.type === "group",
                bias: {},
                continue: arg.continueSend,
                chatId: generationId,
                chatRef,
                imageResponse: db.outputImageModal,
                previewBody: job.kind === "previewPrompt",
                escape: owner.type === "character" && owner.escapeOutput,
                rememberToolUsage: db.rememberToolUsage,
            } as Parameters<typeof services.request>[0],
            "model",
            nativeCtx,
        );
        setup.check();
        if (req.model) {
            generationInfo.model = getGenerationModelString(db, req.model);
        }
        if (job.kind === "previewPrompt" && req.type === "success") {
            return { type: "preview", result: req.result };
        }
        if (!chatNow()) {
            // The chat was deleted while the request ran: the send is cancelled.
            return { type: "stop" };
        }
        const prefixOf = (id: string) => scopeChat(scope)?.message.find((message) => message.chatId === id)?.data ?? "";

        if (req.type === "fail") {
            return throwError(req.result);
        }
        if (req.type === "streaming") {
            let messageId: string;
            let prefix = "";
            if (generation) {
                // Continue keeps the message's id and text (read now, after the hooks).
                messageId = generation.messageId;
                prefix = prefixOf(messageId);
            } else {
                messageId = generationId;
                writeOwn([
                    {
                        op: "append",
                        messages: [
                            {
                                role: "char",
                                data: "",
                                saying: currentChar.chaId,
                                time: Date.now(),
                                generationInfo,
                                promptInfo,
                                chatId: messageId,
                            },
                        ],
                        anchor: { end: true },
                    },
                    { op: "begin", id: messageId, generationId },
                ]);
                generation = { messageId, generationId, seq: 0, final: false };
                job.emit({
                    type: "accepted",
                    jobId: job.id,
                    messageId,
                    generationId,
                    revision: scope.chatRevision,
                    text: "",
                });
            }
            const stream = await readReply(job, req.result, {
                prefix,
                removeIncompleteResponse: !!db.removeIncompleteResponse,
                emitChunk: (text, seq) => job.emit({ type: "chunk", messageId, generationId, text, seq }),
                checkpoint: (text, seq) => {
                    generation!.seq += 1;
                    writeOwn(
                        [
                            {
                                op: "setText",
                                id: messageId,
                                text,
                                generation: { id: generationId, seq: generation!.seq },
                            },
                        ],
                        [{ messageId, generationId, seq }],
                    );
                },
            });
            finalize(stream.text, stream.seq);
            if (stream.error !== undefined) {
                if (job.signal.aborted) {
                    return { type: "stop" };
                }
                throw new GenerationRunnerError(500, stream.error);
            }
            if (job.signal.aborted) {
                return { type: "stop" };
            }
            return { type: "reply", messageId, alternatives: Object.values(stream.lastChunk) };
        }

        // Non-streaming: the first text is the reply; every text is a reroll alternative.
        const msgs: readonly (readonly ["user" | "char", string])[] =
            req.type === "success" ? [["char", req.result]] : req.type === "multiline" ? req.result : [];
        const mrerolls: string[] = [];
        let messageId: string | undefined;
        for (let i = 0; i < msgs.length; i++) {
            const [role, mess] = msgs[i];
            let result = mess.trim();
            if (i === 0 && generation) {
                result = (prefixOf(generation.messageId) + mess).trim();
            }
            if (db.removeIncompleteResponse) {
                result = trimUntilPunctuation(result);
            }
            if (i === 0 && generation) {
                // Continue keeps the message's id (its metadata replaced, as the client's `replaceMessage`).
                messageId = generation.messageId;
                generation.seq += 1;
                generation.final = true;
                writeOwn([
                    {
                        op: "setMessage",
                        message: {
                            role: "char",
                            data: result,
                            saying: currentChar.chaId,
                            time: Date.now(),
                            generationInfo,
                            promptInfo,
                            chatId: messageId,
                        },
                        generation: { id: generationId, seq: generation.seq, final: true },
                    },
                ]);
            } else if (i === 0) {
                messageId = generationId;
                generation = { messageId, generationId, seq: 1, final: true };
                writeOwn([
                    {
                        op: "append",
                        messages: [
                            {
                                role,
                                data: result,
                                saying: currentChar.chaId,
                                time: Date.now(),
                                generationInfo,
                                promptInfo,
                                chatId: messageId,
                            },
                        ],
                        anchor: { end: true },
                    },
                    { op: "begin", id: messageId, generationId },
                    {
                        op: "setText",
                        id: messageId,
                        text: result,
                        generation: { id: generationId, seq: 1, final: true },
                    },
                ]);
                mrerolls.push(result);
            } else {
                mrerolls.push(result);
            }
        }
        if (!messageId) {
            return { type: "stop" };
        }
        return { type: "reply", messageId, ...(mrerolls.length > 1 ? { alternatives: mrerolls } : {}) };
    } catch (error) {
        if (error instanceof JobWriteConflictError) {
            throw new GenerationRunnerError(409, "The send's write conflicted with another change");
        }
        throw error;
    } finally {
        // A generation the send did not close (a continue that failed or stopped) is released as stored.
        if (generation && !generation.final) {
            try {
                finalize();
            } catch (error) {
                console.error("[Generation]", error);
            }
        }
    }
}

/**
 * Reads a streaming reply to its end, an abort, or a read failure: each chunk's first value
 * (`trimUntilPunctuation` with `removeIncompleteResponse`) after `prefix`, trimmed, is sent as a
 * `chunk`. Text not yet stored is checkpointed `CHECKPOINT_INTERVAL_MS` after the last checkpoint
 * (a timer, so a provider that stalls after a chunk does not hold it back). Returns the text, the
 * newest chunk's sequence, the last chunk, and the read failure (an abort, or a checkpoint that
 * failed, is one).
 */
async function readReply(
    job: RunningJob,
    stream: ReadableStream<StreamResponseChunk>,
    options: {
        prefix: string;
        removeIncompleteResponse: boolean;
        emitChunk: (text: string, seq: number) => void;
        checkpoint: (text: string, seq: number) => void;
    },
): Promise<{ text: string; seq: number; lastChunk: StreamResponseChunk; error?: string }> {
    const reader = stream.getReader();
    let text = options.prefix.trim();
    let seq = 0;
    let lastChunk: StreamResponseChunk = {};
    let lastCheckpoint = Date.now();
    let checkpointed = 0;
    let checkpointError: unknown = null;
    const onAbort = () => {
        void reader.cancel().catch(() => {});
    };
    job.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setInterval(
        () => {
            if (job.signal.aborted || checkpointError !== null || checkpointed >= seq) {
                return;
            }
            if (Date.now() - lastCheckpoint < CHECKPOINT_INTERVAL_MS) {
                return;
            }
            lastCheckpoint = Date.now();
            checkpointed = seq;
            try {
                options.checkpoint(text, seq);
            } catch (error) {
                checkpointError = error;
                void reader.cancel().catch(() => {});
            }
        },
        Math.min(250, CHECKPOINT_INTERVAL_MS),
    );
    try {
        while (!job.signal.aborted && checkpointError === null) {
            const read = await reader.read();
            if (read.value) {
                lastChunk = read.value;
                let result = lastChunk[Object.keys(lastChunk)[0]] ?? "";
                if (options.removeIncompleteResponse) {
                    result = trimUntilPunctuation(result);
                }
                text = (options.prefix + result).trim();
                seq += 1;
                options.emitChunk(text, seq);
            }
            if (read.done) {
                break;
            }
        }
        if (checkpointError !== null) {
            throw checkpointError;
        }
        return job.signal.aborted ? { text, seq, lastChunk, error: "request aborted" } : { text, seq, lastChunk };
    } catch (error) {
        return { text, seq, lastChunk, error: error instanceof Error ? error.message : String(error) };
    } finally {
        clearInterval(timer);
        job.signal.removeEventListener("abort", onAbort);
        void reader.cancel().catch(() => {});
    }
}
