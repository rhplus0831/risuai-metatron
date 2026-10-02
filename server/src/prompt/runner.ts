import { randomUUID } from "node:crypto";
import type { ChatOp, CheckpointOutcome, MessageGeneration } from "../../../shared/chats.ts";
import type { Chat, character, groupChat, Message, MessageGenerationInfo } from "../../../shared/database.ts";
import type { CallbackPayloads, CallbackResult } from "../../../shared/jobs.ts";
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
    emotionHistory,
    type GenerationRunnerDeps,
    type JobRunState,
    MAX_SEND_ROUNDS,
    type RunSetup,
    showEmotion,
    untilAborted,
} from "../jobs/runSetup.ts";
import { messages } from "../llm/messages.ts";
import { mainModelTakesImages, tokenScopeFor } from "../llm/settings.ts";
import { LuaJobFatalError } from "../lua/bindings.ts";
import { readStorageFile } from "../routes/storage.ts";
import { type AssembledPrompt, assemblePrompt, getGenerationModelString } from "./assemble.ts";
import { postJson } from "./embeddings.ts";
import type { MemoryHost } from "./memory/host.ts";
import { runEmotionMode, runInlayScreen } from "./postProcess.ts";
import { createScriptProcessor } from "./scripts.ts";
import { parseChatML } from "./triggers.ts";

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
 *    end, after an abort (inside the grace), or after a read failure.
 * 6. The tail of a completed reply (slice 11a), in the tab's order on each path: `editoutput` once on
 *    the completed text, the output trigger, inlays, the `chatOutput` listeners, TTS; the
 *    auto-continue decision, `igp`, a trigger's resend, the notification, the emotion modes or the
 *    image view; the generation info with its timings; the final write. An auto-continue or a resend
 *    is another round of the same speaker (`MAX_SEND_ROUNDS` for the job).
 * 7. `done` with the last reply's id and the reroll alternatives: the reply is persisted.
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
                    assetMatches: state.assetMatches,
                    showEmotion: (chaId, name, image) => showEmotion(job, state, chaId, name, image),
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
    speakers: for (const speakerId of speakers) {
        // One speaker's turn: its send, then the rounds it asks for (an auto-continue of its reply, a
        // trigger's resend), each a whole run as the tab's recursive `sendChat` is. The preset stays
        // the job's (the tab's recursion would pick `presetChain` again).
        let round: { continueSend: boolean; continueMessageId?: string; usedContinueTokens: number } = {
            // A group send does not forward a continue to its speakers.
            continueSend: job.kind === "continue" && sendOwner.type !== "group",
            usedContinueTokens: 0,
        };
        for (;;) {
            const result = await runSpeaker({
                job,
                deps,
                state,
                scope,
                owner: sendOwner,
                speakerId,
                chatAdditonalTokens: caculatedChatTokens,
                continueSend: round.continueSend,
                ...(round.continueMessageId ? { continueMessageId: round.continueMessageId } : {}),
                usedContinueTokens: round.usedContinueTokens,
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
                break speakers;
            }
            if (result.type === "removed") {
                // The reply is gone: nothing of this turn to continue.
                break;
            }
            // The reply of the last round is the one the job reports, with that round's alternatives.
            last = {
                messageId: result.messageId,
                ...(result.alternatives ? { alternatives: result.alternatives } : {}),
            };
            if (preview || !result.next) {
                break;
            }
            state.rounds.count += 1;
            round =
                result.next.type === "continue"
                    ? {
                          continueSend: true,
                          continueMessageId: result.messageId,
                          usedContinueTokens: result.next.usedContinueTokens,
                      }
                    : { continueSend: false, usedContinueTokens: 0 };
        }
        if (preview) {
            break;
        }
    }
    // A reply an output trigger removed afterwards is not reported.
    refreshChat(store, scope);
    if (last && !scopeChat(scope)?.message.some((message) => message.chatId === last!.messageId)) {
        last = null;
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
    | {
          type: "reply";
          messageId: string;
          alternatives?: string[];
          /**
           * The next round of this speaker: a continue of this reply (auto-continue, with the tokens
           * counted so far), or a fresh send (a trigger's `sendAIprompt`). None: the reply is done.
           */
          next?: { type: "continue"; usedContinueTokens: number } | { type: "resend" };
      }
    | { type: "preview"; result: unknown }
    /** The output trigger removed the reply: this speaker's turn ends with the removal. */
    | { type: "removed" }
    /** The send ended for this speaker (an error shown, stopped by a trigger, nothing to continue). */
    | { type: "stop" };

/** How long the tab may take for an image of the tail (an inlay image, the image view). */
const IMAGE_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

async function runSpeaker(arg: {
    job: RunningJob;
    deps: GenerationRunnerDeps;
    state: JobRunState;
    scope: JobScope;
    owner: character | groupChat;
    speakerId: string;
    chatAdditonalTokens: number;
    continueSend: boolean;
    /** The message a continue extends: the reply of the round before (auto-continue), else the job's. */
    continueMessageId?: string;
    /** `usedContinueTokens`: the tokens of the replies this auto-continue chain produced so far. */
    usedContinueTokens: number;
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
    /**
     * The newest streamed chunk the stored reply includes, once its stream is complete. Every later
     * generation write claims it, or the tab would put its streamed text over the processed one.
     */
    let coverSeq: number | undefined;
    const cover = () =>
        generation && coverSeq !== undefined
            ? [{ messageId: generation.messageId, generationId: generation.generationId, seq: coverSeq }]
            : undefined;
    const owned: OwnedGeneration = {
        get messageId() {
            return generation?.messageId ?? "";
        },
        next(): MessageGeneration {
            generation!.seq += 1;
            return { id: generation!.generationId, seq: generation!.seq };
        },
        covers: () =>
            generation && coverSeq !== undefined ? { generationId: generation.generationId, seq: coverSeq } : undefined,
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
                writeOwn(
                    [
                        {
                            op: "setText",
                            id: lastMessage.chatId!,
                            text: lastMessage.data + suffix,
                            generation: owned.next(),
                        },
                    ],
                    cover(),
                );
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
    const finalize = (text?: string, covers: number | undefined = coverSeq) => {
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
            // A later round names its target (the reply it continues); the first one is the job's.
            const continueMessageId =
                arg.continueMessageId ?? job.context.continueMessageId ?? chat?.message.at(-1)?.chatId;
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
            assetMatches: state.assetMatches,
            showEmotion: (chaId, name, image) => showEmotion(job, state, chaId, name, image),
        });
        /** `runCurrentChatFunction`: every message through CBS with variables, the changed ones written. */
        const runCurrentChatFunction = () => {
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
                    writeOwn([{ op: "setText", id, text: data, generation: owned.next() }], cover());
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
        };
        const stageTimings = { stage1Duration: 0, stage2Duration: 0 };
        // The memory algorithms' services of this run (`memory-on-server`): the job's settings, its
        // own requests and embeddings, its chat's CBS, and its abort.
        const embeddingEnv = services.embeddings(nativeCtx);
        let memoryProgressOpen = false;
        const memory: MemoryHost = {
            db,
            tokenize: (text) => services.tokenize(text),
            request: async (memoryPrompt) => {
                setup.check();
                const response = await services.request(
                    {
                        formated: memoryPrompt,
                        bias: {},
                        useStreaming: false,
                        noMultiGen: true,
                        chatRef,
                    } as Parameters<typeof services.request>[0],
                    "memory",
                    nativeCtx,
                );
                setup.check();
                return response;
            },
            completions: async (body) => {
                setup.check();
                const response = await postJson(
                    embeddingEnv,
                    "https://api.openai.com/v1/completions",
                    { headers: { Authorization: "Bearer " + embeddingEnv.supaMemoryKey }, body },
                    { strictJson: true },
                );
                setup.check();
                // The browser path's proxy refuses a successful answer that carries the stored key
                // (`routes/proxy.ts`): a summary must not put it into the chat or the next request.
                if (response.ok && embeddingEnv.carries(response.data)) {
                    return {
                        ok: false,
                        data: { error: "The openai-completions answer carried the stored credential; it is not sent" },
                    };
                }
                return response;
            },
            summarizer: async (text) => {
                setup.check();
                try {
                    return await deps.transformers.runSummarizer(text, nativeCtx.signal);
                } finally {
                    setup.check();
                }
            },
            embeddings: embeddingEnv,
            parseChatML: (text) => parseChatML(text, (part) => services.parse(part, undefined)),
            userName: () => scope.effectivePersona.name,
            progress: (payload) => {
                memoryProgressOpen = payload.open;
                services.notice({ kind: "progress", payload });
            },
            random: deps.random ?? Math.random,
            redact: (text) => embeddingEnv.redact(text),
            fence: () => setup.check(),
            signal: nativeCtx.signal,
        };
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
                runCurrentChatFunction,
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
                memory,
                writeMemory: (build) => {
                    services.writeChat((chat) => {
                        const fields = build(chat);
                        if (!fields) {
                            return null;
                        }
                        // A field without a value (no stored fallback either) is not written.
                        const set = Object.fromEntries(
                            Object.entries(fields).filter(([, value]) => value !== undefined),
                        );
                        return Object.keys(set).length > 0 ? [{ op: "meta", set }] : null;
                    }, nativeCtx);
                },
                endMemoryProgress: () => {
                    if (memoryProgressOpen) {
                        memoryProgressOpen = false;
                        services.notice({
                            kind: "progress",
                            payload: { open: false, miniMsg: "", msg: "", subMsg: "" },
                        });
                    }
                },
                captionImage: async (dataUrl) => {
                    setup.check();
                    try {
                        return await deps.transformers.runImageCaption(dataUrl, nativeCtx.signal);
                    } finally {
                        setup.check();
                    }
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
        if (assembled.type === "alert") {
            // The client's `alertError` and `return false`: the job's error, never an inlay error message.
            throw new SendError(assembled.error);
        }
        const { formated, biases, promptInfo } = assembled;
        generationInfo = assembled.generationInfo;
        if (job.kind === "preview") {
            return { type: "preview", result: formated };
        }

        const stage3Start = Date.now();
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

        // ---- The tail (`post-generation-and-plugin-callbacks`, slice 11a): what `sendChatInner` does
        // after the provider answers, in its order on each path.

        /** The client's `result`: the reply's text as the later stages read it (see each path). */
        let result = "";
        let emoChanged = false;
        /** The output trigger asked for another send (`sendAIprompt`). */
        let resend = false;
        let replyId: string | undefined;
        let alternatives: string[] | undefined;

        const storedReply = () => {
            const id = generation?.messageId;
            return id ? chatNow()?.message.find((message) => message.chatId === id) : undefined;
        };
        const indexOfMessage = (id: string | undefined) =>
            id ? (chatNow()?.message.findIndex((message) => message.chatId === id) ?? -1) : -1;
        /** A write of the reply's text as a checkpoint of its generation (nothing once it is gone or closed). */
        const writeReplyText = (text: string) => {
            if (!generation || generation.final || !storedReply()) {
                return;
            }
            writeOwn([{ op: "setText", id: generation.messageId, text, generation: owned.next() }], cover());
        };
        /** `throwError` where the client goes on afterwards: the error is shown, the send is not stopped. */
        const showError = (error: string) => {
            if (db.inlayErrorResponse) {
                throwError(error);
            } else {
                services.notice({ kind: "alertError", payload: { message: error } });
            }
        };
        /**
         * A callback of the tail. Answered: its value. Null: the hook is not registered, the hook itself
         * failed (logged), or no tab is attached (the Safety Contract: listeners and images of a reply
         * that completes while its client is away are skipped). A barrier or protocol failure, a
         * timeout, or an abort ends the job.
         */
        const tailCallback = async <N extends "chatOutput" | "imggen">(
            name: N,
            payload: CallbackPayloads[N],
            options: { timeoutMs?: number } = {},
        ): Promise<{ value: unknown } | null> => {
            setup.check();
            let outcome: CallbackResult;
            try {
                outcome = await untilAborted(job.channel.callback(name, payload, options), nativeCtx.signal);
            } finally {
                services.refresh();
            }
            setup.check();
            switch (outcome.outcome) {
                case "answered":
                    return { value: outcome.value };
                case "disconnected":
                    return null;
                case "refused":
                    if (outcome.refusal === "unregistered") {
                        return null;
                    }
                    throw services.latch(
                        new LuaJobFatalError(`The ${name} callback was refused (${outcome.refusal ?? "unknown"})`),
                    );
                case "failed":
                    if (outcome.failure === "hook") {
                        console.error(`[Generation] The ${name} callback failed: ${outcome.error}`);
                        return null;
                    }
                    throw services.latch(
                        new LuaJobFatalError(`The ${name} callback failed (${outcome.failure}): ${outcome.error}`),
                    );
                default:
                    throw services.latch(new LuaJobFatalError(`The ${name} callback ended: ${outcome.outcome}`));
            }
        };
        /** One image of an inlay command: the tab generates and stores it; null leaves the command out. */
        const generateInlayImage = (prompt: string, negative: string) =>
            services.generateImageInlay(prompt, negative, currentChar.chaId, nativeCtx, {
                timeoutMs: IMAGE_CALLBACK_TIMEOUT_MS,
                skipDisconnected: true,
            });
        /** The `output` trigger on a copy of the chat, its changes applied with the reply's generation. */
        const runOutputTrigger = async () => {
            const triggerResult = await setup.runOnCopy(
                currentChar,
                "output",
                {},
                generation && !generation.final ? { generation: owned } : {},
            );
            setup.check();
            if (triggerResult && triggerResult.sendAIprompt) {
                resend = true;
            }
        };
        /** The `chatOutput` listeners, in the tab (none registered when the job was created: nothing). */
        const runChatOutputListeners = async (messageId: string) => {
            if (!job.hooks.chatOutput) {
                return;
            }
            await tailCallback("chatOutput", { messageId, speakerId: currentChar.chaId });
        };
        const sayTTS = (text: string) => {
            if (db.ttsAutoSpeech) {
                services.notice({ kind: "tts", payload: { chaId: currentChar.chaId, text } });
            }
        };
        /** Writes the final generation info (timings) onto the reply, as a checkpoint of its generation. */
        const writeReplyGenerationInfo = () => {
            const reply = storedReply();
            if (reply?.generationInfo && generationInfo && generation && !generation.final) {
                writeOwn(
                    [
                        {
                            op: "setMessage",
                            message: { ...structuredClone(reply), generationInfo: structuredClone(generationInfo) },
                            generation: owned.next(),
                        },
                    ],
                    cover(),
                );
            }
        };

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
            if (stream.error !== undefined || job.signal.aborted) {
                // An abort or a read failure: the final write carries the text so far; nothing after
                // the stream runs.
                finalize(stream.text, stream.seq);
                if (stream.error !== undefined && !job.signal.aborted) {
                    throw new GenerationRunnerError(500, stream.error);
                }
                return { type: "stop" };
            }
            // The completed raw text is stored before any hook runs: a failure in the tail keeps it.
            // Every later write of the reply claims the stream's last chunk.
            coverSeq = stream.seq;
            writeReplyText(stream.text);
            result = stream.result;
            replyId = messageId;
            alternatives = Object.values(stream.lastChunk);

            // `editoutput` once, on the completed text (per chunk in the tab; the Safety Contract).
            const processed = await scripts.process(owner, stream.text, "editoutput", indexOfMessage(messageId));
            setup.check();
            writeReplyText(processed.data);
            emoChanged = processed.emoChanged;

            runCurrentChatFunction();
            await runOutputTrigger();
            const outputMessage = storedReply();
            if (!outputMessage) {
                // The trigger removed the reply: the turn ends with the removal.
                generation!.final = true;
                return { type: "removed" };
            }
            const inlay = runInlayScreen(currentChar, outputMessage.data);
            writeReplyText(inlay.text);
            if (inlay.images) {
                const withImages = await inlay.images(generateInlayImage);
                setup.check();
                writeReplyText(withImages);
            }
            await runChatOutputListeners(messageId);
            sayTTS(result);
        } else {
            // Non-streaming: the first text is the reply; every text is a reroll alternative.
            const msgs: readonly (readonly ["user" | "char", string])[] =
                req.type === "success" ? [["char", req.result]] : req.type === "multiline" ? req.result : [];
            const mrerolls: string[] = [];
            let outputMessageId: string | undefined;
            for (let i = 0; i < msgs.length; i++) {
                const [role, mess] = msgs[i];
                // The message a continue extends (locked since the send started).
                const lastMessage = generation ? storedReply() : chatNow()?.message.at(-1);
                let result2 = await scripts.process(owner, mess.trim(), "editoutput", chatNow()?.message.length ?? 0);
                setup.check();
                if (i === 0 && arg.continueSend) {
                    result2 = await scripts.process(
                        owner,
                        ((lastMessage?.data ?? "") + mess).trim(),
                        "editoutput",
                        indexOfMessage(lastMessage?.chatId),
                    );
                    setup.check();
                }
                if (db.removeIncompleteResponse) {
                    result2.data = trimUntilPunctuation(result2.data);
                }
                result = result2.data;
                const inlayResult = runInlayScreen(currentChar, result);
                result = inlayResult.text;
                emoChanged = result2.emoChanged;
                if (i === 0 && generation) {
                    if (!lastMessage) {
                        // The message to continue is gone.
                        generation.final = true;
                        return { type: "stop" };
                    }
                    // Continue keeps the message's id (its metadata replaced, as the client's `replaceMessage`).
                    outputMessageId = generation.messageId;
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
                                chatId: outputMessageId,
                            },
                            generation: owned.next(),
                        },
                    ]);
                } else if (i === 0) {
                    outputMessageId = generationId;
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
                                    chatId: outputMessageId,
                                },
                            ],
                            anchor: { end: true },
                        },
                        // Locked until its final write (the tail may still write it).
                        { op: "begin", id: outputMessageId, generationId },
                    ]);
                    generation = { messageId: outputMessageId, generationId, seq: 0, final: false };
                    mrerolls.push(result);
                } else {
                    mrerolls.push(result);
                }
                // The images of the reply only: an alternative keeps its `[Generating...]` text (the tab
                // starts their images too and never uses them).
                if (i === 0 && inlayResult.images) {
                    const withImages = await inlayResult.images(generateInlayImage);
                    setup.check();
                    writeReplyText(withImages);
                }
                sayTTS(result);
            }
            if (!outputMessageId) {
                return { type: "stop" };
            }
            replyId = outputMessageId;
            if (mrerolls.length > 1) {
                alternatives = mrerolls;
            }

            runCurrentChatFunction();
            await runOutputTrigger();
            if (!storedReply()) {
                generation!.final = true;
                return { type: "removed" };
            }
            await runChatOutputListeners(outputMessageId);
        }

        // Auto-continue: the reply is closed and the next round continues it.
        let needsAutoContinue = false;
        const resultTokens = (await services.tokenize(result)) + arg.usedContinueTokens;
        setup.check();
        if (db.autoContinueMinTokens > 0 && resultTokens < db.autoContinueMinTokens) {
            needsAutoContinue = true;
        }
        if (db.autoContinueChat && !isLastCharPunctuation(result)) {
            //if result doesn't end with punctuation or special characters, auto continue
            needsAutoContinue = true;
        }
        /** Whether the job may run another round; past the cap the reply is finished as it stands. */
        const roundLeft = () => {
            if (state.rounds.count < MAX_SEND_ROUNDS) {
                return true;
            }
            if (!state.rounds.noticed) {
                state.rounds.noticed = true;
                services.notice({
                    kind: "alertToast",
                    payload: { message: `Auto-continue and resend stopped after ${MAX_SEND_ROUNDS} rounds` },
                });
            }
            return false;
        };
        if (needsAutoContinue && roundLeft()) {
            // The continue takes the reply over as a new generation (a resend this round's trigger
            // asked for is dropped with it, as the tab's recursion drops it).
            finalize();
            return {
                type: "reply",
                messageId: replyId,
                ...(alternatives ? { alternatives } : {}),
                next: { type: "continue", usedContinueTokens: resultTokens },
            };
        }
        const willResend = resend && roundLeft();

        // `igp`: once, on the reply no further round follows (the plan's "after the loop").
        if (!willResend) {
            const igp = evaluator.risuChatParser(db.igpPrompt ?? "", { chatRef });
            if (igp) {
                const igpFormated = parseChatML(igp, (part) => services.parse(part, undefined));
                let appended: string | undefined;
                if (!igpFormated) {
                    // The tab hands the request `null` here and fails inside it.
                    services.notice({ kind: "alertError", payload: { message: "The IGP prompt is not ChatML" } });
                } else {
                    const rq = await services.request(
                        { formated: igpFormated, bias: {}, chatRef } as Parameters<typeof services.request>[0],
                        "emotion",
                        nativeCtx,
                    );
                    setup.check();
                    if (rq.type === "success") {
                        appended = rq.result;
                    } else if (rq.type === "multiline") {
                        appended = rq.result[0]?.[1];
                    } else {
                        if (rq.type === "streaming") {
                            // Never read: the request is released.
                            void rq.result.cancel().catch(() => {});
                        }
                        services.notice({
                            kind: "alertError",
                            payload: { message: rq.type === "fail" ? rq.result : "Unexpected response type" },
                        });
                    }
                }
                // Appended to this send's reply (not whatever message is last now).
                const reply = storedReply();
                if (reply && appended !== undefined) {
                    writeReplyText(reply.data + appended);
                }
            }
        }

        const stage3Duration = Date.now() - stage3Start;
        if (generationInfo.stageTiming) {
            generationInfo.stageTiming.stage3 = stage3Duration;
        }
        const stage4Start = Date.now();
        const setStageTimings = () => {
            if (generationInfo!.stageTiming) {
                generationInfo!.stageTiming.stage1 = stageTimings.stage1Duration;
                generationInfo!.stageTiming.stage2 = stageTimings.stage2Duration;
                generationInfo!.stageTiming.stage3 = stage3Duration;
                generationInfo!.stageTiming.stage4 = Date.now() - stage4Start;
            }
        };
        const reply = (next?: { type: "resend" }): SpeakerResult => ({
            type: "reply",
            messageId: replyId!,
            ...(alternatives ? { alternatives } : {}),
            ...(next ? { next } : {}),
        });

        if (willResend) {
            setStageTimings();
            writeReplyGenerationInfo();
            finalize();
            return reply({ type: "resend" });
        }

        if (db.notification) {
            services.notice({ kind: "notification", payload: { chaId: currentChar.chaId, body: result } });
        }

        if (req.special?.emotion) {
            // The tab drops its oldest shown emotion here whether or not the name matches.
            const shown = emotionHistory(state, currentChar.chaId);
            if (shown.length > 4) {
                shown.splice(0, 1);
            }
            for (const emo of currentChar.emotionImages ?? []) {
                if (emo[0] === req.special.emotion) {
                    showEmotion(job, state, currentChar.chaId, emo[0], emo[1]);
                    emoChanged = true;
                    break;
                }
            }
        }

        if (!currentChar.inlayViewScreen) {
            if (currentChar.viewScreen === "emotion" && !emoChanged && !job.signal.aborted) {
                await runEmotionMode(
                    {
                        emotionProcesser: db.emotionProcesser,
                        emotionPrompt2: db.emotionPrompt2,
                        history: () => emotionHistory(state, currentChar.chaId),
                        show: (emo) => showEmotion(job, state, currentChar.chaId, emo[0], emo[1]),
                        embeddings: () => services.embeddings(nativeCtx),
                        tokenizeNum: (text) => deps.tokens.encode(text, tokenScopeFor(requestDb)),
                        request: async (emotionPrompt, bias) => {
                            const rq = await services.request(
                                { formated: emotionPrompt, bias, currentChar, maxTokens: 30, chatRef } as Parameters<
                                    typeof services.request
                                >[0],
                                "emotion",
                                nativeCtx,
                            );
                            setup.check();
                            return rq;
                        },
                        random: deps.random ?? Math.random,
                        showError,
                        aborted: () => job.signal.aborted,
                        fence: () => setup.check(),
                        httpError: messages.errors.httpError,
                    },
                    currentChar,
                    result,
                );
                setup.check();
                // As the tab: these modes end the send before its last generation-info write.
                finalize();
                return reply();
            } else if (currentChar.viewScreen === "imggen") {
                if (owner.type === "group") {
                    showError("Stable diffusion in group chat is not supported");
                }
                const chatMessages = chatNow()?.message ?? [];
                let msgStr = "";
                for (let i = chatMessages.length - 1; i >= 0; i--) {
                    if (chatMessages[i].role === "char") {
                        msgStr = `character: ${chatMessages[i].data.replace(/\n/g, " ")} \n` + msgStr;
                    } else {
                        msgStr = `user: ${chatMessages[i].data.replace(/\n/g, " ")} \n` + msgStr;
                        break;
                    }
                }
                // The tab runs `stableDiff` with its own image settings and shows the image.
                await tailCallback(
                    "imggen",
                    { characterId: currentChar.chaId, text: msgStr },
                    { timeoutMs: IMAGE_CALLBACK_TIMEOUT_MS },
                );
            }
        }

        setStageTimings();
        writeReplyGenerationInfo();
        finalize();
        return reply();
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
): Promise<{ text: string; result: string; seq: number; lastChunk: StreamResponseChunk; error?: string }> {
    const reader = stream.getReader();
    let text = options.prefix.trim();
    /** The client's `result`: the newest chunk's first value (trimmed to punctuation), without the prefix. */
    let chunkResult = "";
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
                chunkResult = result;
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
        return job.signal.aborted
            ? { text, result: chunkResult, seq, lastChunk, error: "request aborted" }
            : { text, result: chunkResult, seq, lastChunk };
    } catch (error) {
        return {
            text,
            result: chunkResult,
            seq,
            lastChunk,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        clearInterval(timer);
        job.signal.removeEventListener("abort", onAbort);
        void reader.cancel().catch(() => {});
    }
}
