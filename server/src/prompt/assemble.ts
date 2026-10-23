import { createHash } from "node:crypto";
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
import type {
    GenerationStage,
    MemoryBlockingReason,
    MemoryGapChoice,
    MemoryTaskInput,
    SummaryWriterLease,
} from "../../../shared/jobs.ts";
import { mergeHypaV2Write, mergeHypaV3SelectionWrite, type SerializableHypaV3Data } from "../../../shared/memory.ts";
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
import type { MemoryControl } from "../jobs/generationJobs.ts";
import { HypaProcesser } from "./embeddings.ts";
import { hanuraiMemory } from "./memory/hanurai.ts";
import type { MemoryHost, MemoryTokenizer } from "./memory/host.ts";
import { hypaMemoryV2 } from "./memory/hypav2.ts";
import {
    createHypaV3SourceValidator,
    emptyHypaV3Execution,
    executeHypaV3Plan,
    getCurrentHypaV3Preset,
    type HypaV3Checkpoint,
    type HypaV3CurrentSource,
    type HypaV3EntrySource,
    type HypaV3ExecutionHooks,
    type HypaV3ExecutionResult,
    type HypaV3Prepared,
    type HypaV3SelectOptions,
    type HypaV3Selection,
    hypaV3SourceHash,
    planHypaV3Summaries,
    prepareHypaV3,
    selectHypaV3,
} from "./memory/hypav3.ts";
import { supaMemory } from "./memory/supaMemory.ts";
import type { ScriptProcessor } from "./scripts.ts";
import { stripThoughtsBlock } from "./thoughts.ts";
import { parseChatML, type TriggerResult } from "./triggers.ts";

/**
 * The prompt of one send, assembled on the server: the body of `sendChatInner` (the former
 * `src/ts/process/index.svelte.ts`) from the prompt-info snapshot to `generationInfo`, for one
 * speaker, statement by statement with the client's order and quirks. Everything it reads of the job
 * comes through `AssemblyHost`. The memory step, `additionalInformations`, and the caption of an
 * image a model cannot take run with the job's memory services: the same gate, priority, and
 * persistence as the client's, each result written before the provider request.
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
    moduleAssets(): readonly (readonly [string, string, string])[];
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
     * `setChatMeta(chatTarget, set)` of the memory step: `build` gets the chat as stored now (read
     * again right before the write, in the same turn) and returns the fields to set (nothing for
     * null). A value an algorithm computed before an await is placed onto that stored value
     * (`mergeHypaV3Write`, `mergeHypaV2Write`), never written over it.
     */
    writeMemory(build: (chat: Chat) => Record<string, unknown> | null): void;
    /** The memory step ended (a result, an error, an abort): a progress notice left open is closed. */
    endMemoryProgress(): void;
    /** Reports the job's presentation stage during assembly. */
    stage(stage: GenerationStage): void;
    /** `runImageEmbedding(dataUrl)[0].generated_text`: the caption of an image a model cannot take. */
    captionImage(dataUrl: string): Promise<string>;
    tokenizer: ChatTokenCounter;
    getModelInfo(id: string): LLMModel;
    /** Raises after an abort or a latched failure (after every await). */
    fence(): void;
    /**
     * The job's side of the HypaV3 step (`hypaV3Step`). Absent: the step summarizes inside the job
     * without progress, source validation, or a task input.
     */
    memoryJob?: AssemblyMemoryJob;
};

/** What the HypaV3 step asks of its job. */
export type AssemblyMemoryJob = {
    /** A `preview` or `previewPrompt` job. */
    preview: boolean;
    /** A send, continue, reroll, or group job. */
    input: boolean;
    /**
     * Whether the job has a memory task service. Without one every HypaV3 step summarizes inside the
     * job (blocking); with one a preview and an input job without a blocking reason select only.
     */
    tasks: boolean;
    /** The source generation of the chat snapshot `chat()` returned last, read with it. */
    sourceGeneration(): number | undefined;
    /**
     * The chat as stored now with its owner's stored greeting (a source validation's read), or null
     * when the chat or the owner is gone. Synchronous.
     */
    readSource(): HypaV3CurrentSource | null;
    /** Why the summary requests must run inside this job: a Plugin `memory` model, a `request` trigger; or null. */
    blockingReason(): MemoryBlockingReason | null;
    /** The job's `memoryGap` question (asked at most once a job; see the runner's `confirmMemoryGap`). */
    confirmGap(payload: { gapTokens: number; plannedCalls: number }): Promise<MemoryGapChoice>;
    /** The owner stopped an initial run: the job's later steps select only. */
    markStopped(): void;
    /** The chat's summary writer lease (a no-op one without a service); the caller releases it. */
    acquireWriter(): Promise<SummaryWriterLease>;
    /** A new memory run of the job (a fresh `runId`): its `memoryProgress` notices. */
    openRun(phase: "blocking" | "initial" | "selection", reason: MemoryBlockingReason | null): AssemblyMemoryRun;
    /** The job's memory task input around the step's captured history, or null without a service. */
    taskInput(
        part: Pick<MemoryTaskInput, "history" | "sources" | "historyStart" | "currentTokens" | "sourceGeneration">,
    ): MemoryTaskInput | null;
};

/** One memory run's progress and stop control. */
export type AssemblyMemoryRun = {
    /** An open `memoryProgress` notice: summaries done of total, or an embedding queue's text. */
    update(progress: { done: number; total: number } | { text: string }): void;
    /** Ends the run's entry (`open: false`) when a notice opened it; once. */
    close(): void;
    /** The run's stop control (`RunningJob.registerMemoryControl`), or null when the job has none. */
    registerStop(): MemoryControl | null;
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
          /**
           * The HypaV3 step's task input (captured before the step) and whether its lookahead plan
           * says summaries are due; only for an input job with a memory task service.
           */
          memoryTask?: { input: MemoryTaskInput; due: boolean };
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

/** A summary write the stored value refused (a reset, a moved cursor, a damaged value). */
const HYPAV3_WRITE_SKIPPED = "[HypaV3] The memory data changed during the summary; this summary is not saved";
/** The retryable end of a summarization whose source messages changed (D15). */
const HYPAV3_SOURCE_CHANGED =
    "[HypaV3] The chat changed during summarization: the summaries from the changed messages on were not saved. Send again to continue.";

type HypaV3StepResult =
    | { type: "error"; error: string }
    | {
          type: "done";
          chats: OpenAIChat[];
          currentTokens: number;
          /** The history entries the final re-check never removes (a select-only or initial selection's tail). */
          protectedEntries: OpenAIChat[];
          memoryTask?: { input: MemoryTaskInput; due: boolean };
      };

/** `hypaMemoryV3`'s error wrapping: the job's own end first, then the algorithm's prefix. */
function rethrowHypaV3(memory: MemoryHost, error: unknown): never {
    memory.fence();
    if (error instanceof Error) {
        error.message = `[HypaV3] ${error.message}`;
        throw error;
    }
    let errorMessage: string;
    try {
        errorMessage = JSON.stringify(error);
    } catch {
        errorMessage = String(error);
    }
    throw new Error(`[HypaV3] ${errorMessage}`);
}

/**
 * The HypaV3 memory step of a job. Without a memory task service (`memoryJob.tasks`) it summarizes
 * inside the job (blocking) for every job kind. With one: a preview selects only; an input job
 * blocks when its summary requests must run in the job (`blockingReason`), else it selects only and,
 * when the history it leaves out (the gap) is over the preset's `gapConfirmTokens`, asks the owner
 * whether to summarize it now (an initial run, sequential, with the stop control) or go on.
 *
 * Every summary is saved as it is made (checkpoints, after a source validation of its window);
 * blocking and initial runs hold the chat's summary writer lease. A refused save ends the
 * summarization: the step selects only from the memory stored now (D16). A changed source ends it
 * with a retryable error and no selection write. Otherwise the selection is written last
 * (`mergeHypaV3SelectionWrite`). A select-only or initial selection returns its protected tail.
 */
async function hypaV3Step(
    host: AssemblyHost,
    arg: {
        chats: OpenAIChat[];
        currentTokens: number;
        maxContextTokens: number;
        room: Chat;
        tokenizer: MemoryTokenizer;
        /** One per entry of `chats`, or null when they could not be aligned. */
        sources: HypaV3EntrySource[] | null;
        historyStart: number;
        /** The history snapshot's source generation; undefined when its entries came from different ones. */
        sourceGeneration: number | undefined;
    },
): Promise<HypaV3StepResult> {
    const memory = host.memory;
    const job = host.memoryJob;
    const { chats, currentTokens, maxContextTokens, tokenizer } = arg;
    // A missing preset is thrown without the algorithm's prefix.
    getCurrentHypaV3Preset(memory);

    // The task input, captured before the step changes anything.
    const input =
        job?.tasks && job.input && arg.sources && arg.sourceGeneration !== undefined
            ? job.taskInput({
                  history: structuredClone(chats),
                  sources: structuredClone(arg.sources),
                  historyStart: arg.historyStart,
                  currentTokens,
                  sourceGeneration: arg.sourceGeneration,
              })
            : null;
    const validate = job && arg.sources ? createHypaV3SourceValidator(arg.sources, () => job.readSource()) : undefined;

    const part = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (error) {
            rethrowHypaV3(memory, error);
        }
    };
    const failed = (error: string | undefined): HypaV3StepResult => ({
        type: "error",
        error: error ?? "[HypaV3] The memory step failed",
    });
    // With a task service the summarized-prefix cursor is looked up among history entries only (the
    // legacy lookup can match an example's missing memo for the greeting's); without one, as before.
    const prepareOptions = job?.tasks ? {} : undefined;
    const prepare = async (room: Chat) =>
        part(() => prepareHypaV3(memory, chats, currentTokens, maxContextTokens, room, tokenizer, prepareOptions));
    /** The chat as stored now (a lease holder's read of the memory the task may have written). */
    const storedRoom = () => structuredClone(host.chat());

    /** A selection; an experimental embedding queue's legacy notices also report as a `selection` run. */
    const select = async (
        prepared: HypaV3Prepared,
        execution: HypaV3ExecutionResult,
        options?: HypaV3SelectOptions,
    ): Promise<HypaV3Selection> => {
        let run: AssemblyMemoryRun | null = null;
        const selectionHost: MemoryHost = {
            ...memory,
            progress: (payload) => {
                if (!job) {
                    memory.progress(payload);
                    return;
                }
                if (payload.open) {
                    run ??= job.openRun("selection", null);
                    run.update({ text: payload.subMsg });
                } else {
                    run?.close();
                    run = null;
                }
                memory.progress(payload);
            },
        };
        try {
            return await part(() => selectHypaV3(selectionHost, prepared, execution, options));
        } finally {
            (run as AssemblyMemoryRun | null)?.close();
        }
    };

    const checkpoint = (write: HypaV3Checkpoint): "committed" | "skipped" => {
        let outcome: "committed" | "skipped" = "skipped";
        host.writeMemory((stored) => {
            const merged = write.merge(stored.hypaV3Data);
            outcome = merged ? "committed" : "skipped";
            if (!merged) {
                console.warn(HYPAV3_WRITE_SKIPPED);
            }
            return merged ? { hypaV3Data: merged } : null;
        });
        return outcome;
    };
    const hooks = (run: AssemblyMemoryRun | null, extra: HypaV3ExecutionHooks = {}): HypaV3ExecutionHooks => ({
        progress: (done, total) => run?.update({ done, total }),
        checkpoint,
        ...(validate ? { validate } : {}),
        ...extra,
    });
    /** The final write: the selection and the orphan removals placed onto the value stored now. */
    const writeSelection = (
        baseline: SerializableHypaV3Data | null | undefined,
        data: SerializableHypaV3Data | undefined,
    ) => {
        if (!data) {
            return;
        }
        host.writeMemory((stored) => {
            const merged = mergeHypaV3SelectionWrite(baseline, data, stored.hypaV3Data, {
                selectionMade: data.summaries.length > 0,
            });
            if (!merged) {
                console.warn(HYPAV3_WRITE_SKIPPED);
            }
            return merged ? { hypaV3Data: merged } : null;
        });
    };
    /** Whether the next sends need summaries: a lookahead plan of `prepared` with a summary request. */
    const dueFrom = async (prepared: HypaV3Prepared) =>
        input ? (await part(() => planHypaV3Summaries(prepared, { lookahead: true }))).llmCalls > 0 : false;
    const finish = (selection: HypaV3Selection, protect: boolean, due: boolean): HypaV3StepResult => {
        if (selection.error) {
            return failed(selection.error);
        }
        const count = protect && selection.trim ? selection.trim.protected.count : 0;
        return {
            type: "done",
            chats: selection.chats,
            currentTokens: selection.currentTokens,
            protectedEntries: count > 0 ? selection.chats.slice(-count) : [],
            ...(input ? { memoryTask: { input, due } } : {}),
        };
    };

    /** Select-only from the memory stored in `room`: the stored summaries, the uncovered history trimmed. */
    const selectOnly = async (room: Chat, correction?: string) => {
        const outcome = await prepare(room);
        if (!outcome.ok) {
            return { ok: false as const, error: outcome.result.error };
        }
        const prepared = outcome.prepared;
        const selection = await select(prepared, emptyHypaV3Execution(prepared), {
            trimUncovered: { tooMuchToken: TOO_MUCH_TOKEN },
            ...(correction !== undefined ? { correction } : {}),
        });
        return { ok: true as const, prepared, selection };
    };
    /** After a refused save (D16): select only from the memory stored now, without asking. */
    const recover = async (correction?: string): Promise<HypaV3StepResult> => {
        const result = await selectOnly(storedRoom(), correction);
        if (!result.ok) {
            return failed(result.error);
        }
        if (result.selection.error) {
            return failed(result.selection.error);
        }
        writeSelection(result.prepared.snapshot, result.selection.memory);
        return finish(result.selection, true, await dueFrom(result.prepared));
    };
    /** Releases in order, each even when an earlier one throws. */
    const releaseAll = (...steps: (() => void)[]) => {
        const [first, ...rest] = steps;
        if (!first) {
            return;
        }
        try {
            first();
        } finally {
            releaseAll(...rest);
        }
    };

    /** Summarizing inside the job: today's composition, each summary saved as it is made. */
    const blocking = async (reason: MemoryBlockingReason | null): Promise<HypaV3StepResult> => {
        const lease = job?.tasks ? await job.acquireWriter() : null;
        let run: AssemblyMemoryRun | null = null;
        try {
            run = job?.openRun("blocking", reason) ?? null;
            // A lease holder reads the memory a task wrote before the lease.
            const outcome = await prepare(lease ? storedRoom() : arg.room);
            if (!outcome.ok) {
                return failed(outcome.result.error);
            }
            const prepared = outcome.prepared;
            const plan = await part(() => planHypaV3Summaries(prepared));
            // The experimental implementation reports a planning error before summarizing anything.
            if (plan.error !== undefined && prepared.implementation === "experimental") {
                return failed(plan.error);
            }
            const execution = await part(() => executeHypaV3Plan(memory, prepared, plan, hooks(run)));
            run?.close();
            switch (execution.endReason) {
                case "providerFailed":
                    return failed(execution.error);
                case "sourceInvalid":
                    return failed(HYPAV3_SOURCE_CHANGED);
                case "writeSkipped":
                    return await recover();
            }
            // The standard implementation reports it after summarizing the windows before it.
            if (plan.error !== undefined) {
                return failed(plan.error);
            }
            const selection = await select(prepared, execution);
            if (selection.error) {
                return failed(selection.error);
            }
            writeSelection(execution.baseline, selection.memory);
            return finish(selection, false, false);
        } finally {
            releaseAll(
                () => lease?.release(),
                () => run?.close(),
            );
        }
    };

    /** The approved summarization of the gap: sequential, stoppable, then a trimmed selection. */
    const initial = async (memoryJob: AssemblyMemoryJob, correction: string | undefined) => {
        const lease = await memoryJob.acquireWriter();
        let run: AssemblyMemoryRun | null = null;
        let control: MemoryControl | null = null;
        try {
            run = memoryJob.openRun("initial", "gap");
            // Prepared and planned again on the memory stored now, not the gap measurement's.
            const room = storedRoom();
            const outcome = await prepare(room);
            if (!outcome.ok) {
                return failed(outcome.result.error);
            }
            const prepared = outcome.prepared;
            const plan = await part(() => planHypaV3Summaries(prepared));
            // A scan that cannot advance is an error; a plan that reaches the protected tail over the
            // context runs its windows, and the selection trims the rest.
            if (plan.stopReason === "noProgress") {
                return failed(plan.error);
            }
            control = run.registerStop();
            const stop = control;
            const execution = await part(() =>
                executeHypaV3Plan(
                    memory,
                    prepared,
                    plan,
                    hooks(run, { sequential: true, shouldStop: () => stop?.stopRequested() ?? false }),
                ),
            );
            // A stop asked during the last window still counts for the job's later steps.
            const stopped = execution.endReason === "stopped" || (stop?.stopRequested() ?? false);
            releaseAll(
                () => stop?.release(),
                () => run?.close(),
            );
            control = null;
            if (stopped) {
                memoryJob.markStopped();
            }
            switch (execution.endReason) {
                case "providerFailed":
                    return failed(execution.error);
                case "sourceInvalid":
                    return failed(HYPAV3_SOURCE_CHANGED);
                case "writeSkipped":
                    return await recover(correction);
            }
            const selection = await select(prepared, execution, {
                trimUncovered: { tooMuchToken: TOO_MUCH_TOKEN },
                ...(correction !== undefined ? { correction } : {}),
            });
            if (selection.error) {
                return failed(selection.error);
            }
            writeSelection(execution.baseline, selection.memory);
            let due = stopped;
            if (!due && input) {
                // Planned again on what the run saved: an ordinary plan can end above the lookahead line.
                const after = await prepare({ ...room, hypaV3Data: execution.baseline ?? undefined });
                due = after.ok ? await dueFrom(after.prepared) : false;
            }
            return finish(selection, true, due);
        } finally {
            releaseAll(
                () => control?.release(),
                () => lease.release(),
                () => run?.close(),
            );
        }
    };

    /** Stored summaries only; the gap question for an input job. */
    const selectOnlyStep = async (memoryJob: AssemblyMemoryJob): Promise<HypaV3StepResult> => {
        const result = await selectOnly(arg.room);
        if (!result.ok) {
            return failed(result.error);
        }
        const { prepared, selection } = result;
        if (selection.error) {
            return failed(selection.error);
        }
        const gap = selection.trim?.gap;
        if (memoryJob.input && gap && gap.tokens > prepared.settings.gapConfirmTokens) {
            const planned = await part(() => planHypaV3Summaries(prepared));
            const choice = await memoryJob.confirmGap({ gapTokens: gap.tokens, plannedCalls: planned.llmCalls });
            memory.fence();
            if (choice === "generate") {
                return initial(memoryJob, selection.correction);
            }
        }
        writeSelection(prepared.snapshot, selection.memory);
        return finish(selection, true, await dueFrom(prepared));
    };

    if (!job?.tasks) {
        return blocking(null);
    }
    if (job.preview) {
        return selectOnlyStep(job);
    }
    const reason = job.input ? job.blockingReason() : null;
    return reason ? blocking(reason) : selectOnlyStep(job);
}

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
    // The source generation of the snapshot the history is built from (HypaV3's task input).
    let currentChatGeneration = host.memoryJob?.sourceGeneration();
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
    /** The greeting entry's source: the stored greeting text and `fmIndex`, from the snapshot of its generation. */
    let greetingSource: { fmIndex: Chat["fmIndex"]; text: string; generation: number | undefined } | null = null;

    if (nowChatroom.type !== "group" && !msReseted) {
        const firstMsg =
            currentChat.fmIndex === -1
                ? nowChatroom.firstMessage
                : nowChatroom.alternateGreetings[currentChat.fmIndex as number];
        greetingSource = { fmIndex: currentChat.fmIndex, text: firstMsg ?? "", generation: currentChatGeneration };
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
        const stored = host.chat();
        currentChatGeneration = stored ? host.memoryJob?.sourceGeneration() : undefined;
        currentChat = stored ?? triggerResult.chat;
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
            const assets = [...(currentChar.additionalAssets ?? []), ...moduleAssets];
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

    /**
     * The history entries the final re-check never removes (HypaV3's select-only or initial tail),
     * by identity; a system message `pushPrompts` merges one into joins them.
     */
    const protectedEntries = new Set<OpenAIChat>();
    let memoryTask: { input: MemoryTaskInput; due: boolean } | undefined;
    if (useMemory) {
        input.stageTimings.stage1Duration = Date.now() - stage1Start;
        const stage2Start = Date.now();
        host.stage("memory");
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
                const room = detachedChat();
                // The value the algorithm reads: its result is placed onto the value stored at the write.
                const baseline = structuredClone(room.hypaV2Data);
                const sp = await hypaMemoryV2(
                    memory,
                    chats,
                    currentTokens,
                    maxContextTokens,
                    room,
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
                    host.writeMemory((stored) => {
                        const merged = mergeHypaV2Write(baseline, data, stored.hypaV2Data);
                        if (!merged) {
                            console.warn(
                                "[HypaV2] The memory data changed during the summary; this summary is not saved",
                            );
                        }
                        return merged ? { hypaV2Data: merged } : null;
                    });
                }

                currentChat = host.chat();
            } else if (db.hypaV3) {
                const sources = hypaV3Sources(chats, historyStart, greetingSource, ms);
                const step = await hypaV3Step(host, {
                    chats,
                    currentTokens,
                    maxContextTokens,
                    room: detachedChat(),
                    tokenizer: memoryTokenizer,
                    sources,
                    historyStart,
                    sourceGeneration:
                        greetingSource && greetingSource.generation !== currentChatGeneration
                            ? undefined
                            : currentChatGeneration,
                });
                host.fence();
                if (step.type === "error") {
                    return { type: "error", error: step.error };
                }
                chats = step.chats;
                currentTokens = step.currentTokens;
                for (const entry of step.protectedEntries) {
                    protectedEntries.add(entry);
                }
                memoryTask = step.memoryTask;

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
        host.stage("preparing");
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
                if (!protectedEntries.has(v)) {
                    v.removable = true;
                }
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
                    if (protectedEntries.has(chat)) {
                        delete endf.removable;
                        protectedEntries.add(endf);
                    }
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

    // With protected entries, an entry `editRequest` returns stays removable only when it is one the
    // prompt marked removable (the same role, text, and media, never shared with an entry that was not
    // removable): a changed, new, or ambiguous entry is not.
    const removableBefore = protectedEntries.size > 0 ? removableEntryCounts(formated) : null;
    formated = await host.runEditRequest(formated);
    host.fence();
    if (removableBefore) {
        for (const chat of formated) {
            if (!chat?.removable) {
                continue;
            }
            const key = removableEntryKey(chat);
            const left = removableBefore.get(key) ?? 0;
            if (left > 0) {
                removableBefore.set(key, left - 1);
            } else {
                delete chat.removable;
            }
        }
    }

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

    return {
        type: "prompt",
        formated,
        biases,
        generationInfo,
        promptInfo,
        maxContextTokens,
        ...(memoryTask ? { memoryTask } : {}),
    };
}

/** The identity of a prompt entry across `editRequest`: a digest of its role, text, and media. */
function removableEntryKey(chat: OpenAIChat): string {
    return createHash("sha256")
        .update(JSON.stringify([chat.role, chat.content, chat.multimodals ?? null]))
        .digest("base64url");
}

/** How many removable entries of each identity `formated` holds; none for an identity an unremovable entry shares. */
function removableEntryCounts(formated: readonly OpenAIChat[]): Map<string, number> {
    const counts = new Map<string, number>();
    const kept = new Set<string>();
    for (const chat of formated) {
        const key = removableEntryKey(chat);
        if (chat.removable) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
        } else {
            kept.add(key);
        }
    }
    for (const key of kept) {
        counts.delete(key);
    }
    return counts;
}

/**
 * The source of each entry of the history HypaV3 gets (D15): the example dialogue and the new-chat
 * marker by memo, the greeting by its `fmIndex` and stored text, each message by its id and stored
 * text, from the snapshots the entries were built from. Null when the entries do not line up with
 * them.
 */
function hypaV3Sources(
    chats: readonly OpenAIChat[],
    historyStart: number,
    greeting: { fmIndex: Chat["fmIndex"]; text: string } | null,
    ms: readonly Message[],
): HypaV3EntrySource[] | null {
    const sources: HypaV3EntrySource[] = chats
        .slice(0, historyStart)
        .map((chat) => ({ kind: "other", memo: chat.memo }));
    if (greeting) {
        sources.push({ kind: "greeting", fmIndex: greeting.fmIndex, textHash: hypaV3SourceHash(greeting.text) });
    }
    for (const message of ms) {
        sources.push({ kind: "message", id: message.chatId, textHash: hypaV3SourceHash(message.data) });
    }
    if (sources.length !== chats.length) {
        return null;
    }
    for (const [index, source] of sources.entries()) {
        const memo = chats[index].memo;
        if (source.kind === "message" ? memo !== source.id : source.kind === "greeting" && memo !== undefined) {
            return null;
        }
    }
    return sources;
}
