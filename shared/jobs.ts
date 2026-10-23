import type { Chat } from "./database.ts";
import type { LLMModel } from "./llm.ts";
import type { OpenAIChat } from "./openai.ts";
import type { ChatPatchBody } from "./resources.ts";

/**
 * The generation job contract: `POST /api/generations` creates a job for one chat, its owner (the
 * tab's `clientId`) follows it over `/api/generations/:id/ws`, and `DELETE /api/generations/:id`
 * aborts it. One chat has at most one running job.
 */

export type GenerationKind = "send" | "continue" | "reroll" | "group" | "preview" | "previewPrompt" | "command";

export const GENERATION_KINDS: readonly GenerationKind[] = [
    "send",
    "continue",
    "reroll",
    "group",
    "preview",
    "previewPrompt",
    "command",
];

/** The execution context a job runs in, plus the chat revision the client last saw. */
export type GenerationContext = {
    characterId: string;
    chatId: string;
    /** The prompt preset (`presets`). */
    presetId: string | null;
    /** The model preset (`modelPresets`). */
    modelPresetId: string | null;
    /** The effective persona (a bound persona wins). */
    personaId: string | null;
    mode: string;
    input: string;
    continueMessageId?: string;
    speakerChaId?: string;
    /**
     * A send's user message: the id the job appends `input` under after the input trigger and
     * `editinput`. The input stage is skipped when the chat already holds a user message with this
     * id (a job created again after the first one appended it).
     */
    userMessageId?: string;
    /** A command job's trigger (buttons, manual triggers). */
    triggerId?: string;
    chatRevision: string;
    /**
     * The tab's selected persona (the forwarded `db.username` and `db.personaPrompt`), which
     * `personaId` differs from when the chat binds a persona. Absent or null: `personaId`.
     */
    selectedPersonaId?: string | null;
    /** What CBS reads of the tab (`{{screenwidth}}`, `{{metadata::browserlanguage}}`). Absent: 0×0 and `en`. */
    client?: GenerationClientEnv;
};

/**
 * The tab's viewport (CSS pixels) and `navigator.language` when the job was created, and the
 * emotions it showed last (`CharEmotion`) for the chat's character or each member of its group, by
 * character id, oldest first (the emotion modes penalize a recent choice).
 */
export type GenerationClientEnv = {
    viewport: { width: number; height: number };
    browserLanguage: string;
    emotions?: Record<string, string[]>;
};

/** How many shown emotions per character `GenerationClientEnv.emotions` carries (`CharEmotion` keeps five). */
export const MAX_CLIENT_EMOTIONS = 5;

/** The longest emotion name `GenerationClientEnv.emotions` carries, in characters. */
export const MAX_CLIENT_EMOTION_NAME_CHARS = 256;

/** The largest `command.data`, in UTF-8 bytes (a `risu-btn` attribute). */
export const MAX_COMMAND_DATA_BYTES = 64 * 1024;

/** The longest manual trigger name (a trigger's comment) and `context.triggerId`, in UTF-8 bytes. */
export const MAX_TRIGGER_NAME_BYTES = 4096;

/**
 * What a `command` job runs: a Lua button (`risu-btn`) with its attribute's text, or a manual
 * trigger (`risu-trigger`, `/trigger`) by name (its `risu-id` is `context.triggerId`).
 */
export type GenerationCommand = { type: "button"; data: string } | { type: "manual"; name: string };

export type ScriptHookMode = "editinput" | "editprocess" | "editoutput" | "editdisplay";

export const SCRIPT_HOOK_MODES: readonly ScriptHookMode[] = ["editinput", "editprocess", "editoutput", "editdisplay"];

/**
 * The plugin hooks registered on the client when it created the job (`job-channel`): the server
 * calls back only for these. Membership inside a hook set is read when a callback runs.
 */
export type GenerationHooks = {
    replacers: { beforeRequest: boolean; afterRequest: boolean };
    scripts: ScriptHookMode[];
    interceptors: boolean;
    chatOutput: boolean;
    /** Each provider with its model descriptor as it was at creation. */
    providers: { name: string; model: LLMModel }[];
    /** The plugin MCP identifiers (`plugin:...`). */
    mcpTools: string[];
};

export const NO_GENERATION_HOOKS: GenerationHooks = {
    replacers: { beforeRequest: false, afterRequest: false },
    scripts: [],
    interceptors: false,
    chatOutput: false,
    providers: [],
    mcpTools: [],
};

type GenerationCreateBase = {
    context: GenerationContext;
    /** The client's registered hooks; missing means none. */
    hooks?: GenerationHooks;
    clientId: string;
};

/** A create body: a `command` job carries its `command`; every other kind has none. */
export type GenerationCreateBody =
    | (GenerationCreateBase & { kind: Exclude<GenerationKind, "command">; command?: undefined })
    | (GenerationCreateBase & { kind: "command"; command: GenerationCommand });

export type GenerationCreated = { jobId: string };

/** 409: the chat has a running job (the owner can attach to it). */
export type GenerationBusyBody = { error: "chatBusy"; jobId: string };

/** 409: the chat changed since the revision the client sent. */
export type GenerationStaleBody = { error: "stale" };

export const GENERATION_ERROR_REASONS = ["failed", "aborted", "shutdown", "maintenance", "timeout"] as const;

export type GenerationErrorReason = (typeof GENERATION_ERROR_REASONS)[number];

/**
 * Where a job failed: the job's setup (its scope, bindings, and speakers), the input stage, prompt
 * assembly, an LLM request, a script (Lua, a trigger, a regex script, a plugin hook), a write, or
 * the tail after the reply.
 */
export const GENERATION_ERROR_STAGES = ["setup", "input", "assembly", "request", "script", "persist", "tail"] as const;

export type GenerationErrorStage = (typeof GENERATION_ERROR_STAGES)[number];

/** A job's or a request's id as the server makes them (`randomUUID`). */
export const GENERATION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** `accepted`: a reply the job writes (a command job emits one without a message). */
export type GenerationAcceptedEvent = {
    type: "accepted";
    epoch: string;
    jobId: string;
    messageId?: string;
    /** The user message the job appended for this send. */
    userMessageId?: string;
    generationId?: string;
    revision: string;
    text: string;
    /** The sequence of the newest chunk `text` holds (0 before the first chunk). */
    seq?: number;
};

/**
 * A delta from this reply's text at sequence `base`: keep its first `keep` UTF-16 code units and
 * append `text` to reconstruct the full text at `seq`. The base is the preceding accepted/chunk
 * text, including rewrites and truncations. A client missing that base asks for `ReplyResyncRequest`.
 */
export type GenerationChunkEvent = {
    type: "chunk";
    epoch: string;
    messageId: string;
    generationId: string;
    base: number;
    keep: number;
    text: string;
    seq: number;
};

/**
 * A message a job is still generating, and the newest chunk its stored text includes. The job's
 * chat events list the job's own; the change feed's `ChatStreaming` lists every job's in a chat.
 */
export type StreamingMessage = { messageId: string; generationId: string; seq: number };

/** A record the job changed, as the server holds it (updates only: never a deletion). */
export type GenerationResourceEvent =
    | {
          type: "resource";
          epoch: string;
          kind: "chats";
          characterId: string;
          id: string;
          revision: string;
          data: unknown;
          /**
           * The job's messages in this chat still generating, each with the newest chunk `seq` of its
           * generation this copy already holds (a streamed text with a higher `seq` is newer than
           * the copy). Any other message of the job is final here and is released.
           */
          streaming?: StreamingMessage[];
      }
    | {
          type: "resource";
          epoch: string;
          kind: string;
          characterId?: undefined;
          id: string;
          revision: string;
          data: unknown;
      };

/**
 * The job chat's change since the last copy the server handed the owner's socket (`baseRevision`),
 * up to `revision`: a diff of two stored states, applied by the client only when it holds exactly
 * one of the two revisions. `messages`, in stored order, holds every message that is new or changed
 * since `baseRevision`, plus every message the job has begun a generation on (changed or not: the
 * client's copy of those can hold streamed text), each with the id of the message right before it
 * (`after`, null at the start). `meta` (the chat's fields without `message`) is present only when
 * it changed. `count` is the message count at `revision`. `streaming` is as in the chat `resource`
 * event. A client that cannot apply it sends `ChatResyncRequest`.
 */
export type GenerationChatPatchEvent = ChatPatchBody & {
    type: "chatPatch";
    epoch: string;
    characterId: string;
    id: string;
    revision: string;
    streaming: StreamingMessage[];
};

/** The owner asks for the job chat whole (client to server): a `chatPatch` did not apply. */
export type ChatResyncRequest = { type: "resync" };

/**
 * The owner cannot reconstruct a chunk (client to server). Answers only the live job's current
 * reply as a full-text `accepted`, if it has a message id; never sends the chat or changes its base.
 */
export type ReplyResyncRequest = { type: "resyncReply" };

export type GenerationTerminalEvent =
    | {
          type: "done";
          epoch: string;
          revision: string | null;
          messageId?: string;
          alternatives?: string[];
          /** A preview's result (`preview`: the assembled messages; `previewPrompt`: the provider body). */
          result?: unknown;
          /**
           * A send that ended without counting as sent (a trigger's stop, an error written into the
           * chat, nothing to continue): the tab's `sendChat` returns false.
           */
          stopped?: true;
          /**
           * `/multisend` commands a command job ran, in order: the tab sends each part after the
           * job (the user message appended, then a send), `clear` removing the chat's messages
           * before each part, and stops at the first part that does not send.
           */
          followUps?: GenerationFollowUp[];
      }
    | {
          type: "error";
          epoch: string;
          message: string;
          status: number;
          reason: GenerationErrorReason;
          /**
           * A runner's failure only (an abort, a timeout, shutdown, or maintenance has none): where
           * it failed, the LLM request that failed when it was one (the request history's id), and
           * the provider's error code (`isProviderCode`).
           */
          stage?: GenerationErrorStage;
          requestId?: string;
          providerCode?: string;
      };

/** One `/multisend` of a command job: the texts to send in turn. */
export type GenerationFollowUp = { clear: boolean; parts: string[] };

/** The most parts all the follow-ups of one job carry, and the longest part in characters. */
export const MAX_FOLLOW_UP_PARTS = 64;
export const MAX_FOLLOW_UP_PART_CHARS = 100_000;

// ---------------------------------------------------------------------------------------------
// The job channel (`job-channel`): notices one way; questions and plugin callbacks are requests
// the owner answers. Every request has one deadline from the moment it is dispatched; the server alone
// decides `timedOut`, `disconnected`, `aborted`, and `refused`.

/** A notice: a UI effect the job asks the owner's tab to show. */
export type GenerationNotice =
    | { kind: "alertNormal" | "alertError" | "alertToast" | "alertMd" | "alertWait"; payload: { message: string } }
    | { kind: "alertClear"; payload: Record<string, never> }
    | { kind: "reloadDisplay" | "updateGUI"; payload: Record<string, never> }
    | { kind: "reloadChat"; payload: { chaId: string; chatId: string; messageId: string } }
    | { kind: "emotion"; payload: { chaId: string; name: string; image: string } }
    | { kind: "progress"; payload: { open: boolean; miniMsg: string; msg: string; subMsg: string } }
    | { kind: "tts"; payload: { chaId: string; text: string } }
    /**
     * A reply finished: `chaId`/`chatId` are the job's chat (a group's, not the speaking member's);
     * the text is the server's (`shared/notifications.ts`).
     */
    | {
          kind: "notification";
          payload: { chaId: string; chatId: string; title: string; body: string; url: string; tag: string };
      }
    /** Opens a web page in the tab (an MCP server's OAuth authorization page); `http(s)` only. */
    | { kind: "openURL"; payload: { url: string } }
    /**
     * The send's messages handed to the translation runner: the tab shows them loading and follows
     * their runs.
     */
    | { kind: "translating"; payload: { chaId: string; chatId: string; messageIds: string[] } }
    /** The job's HypaV3 summarization or selection for its chat (beside the legacy `progress`). */
    | { kind: "memoryProgress"; payload: MemoryProgress };

/** A chat as the memory contracts name it (the job notices' shape). */
export type MemoryChatRef = { chaId: string; chatId: string };

/**
 * Why a send summarizes inside the job: the `memory` slot is a Plugin model (its requests run in the
 * job's tab), the chat owner has a `request` trigger that applies to them, or the user approved
 * summarizing a gap now (`memoryGap`). Null: an ordinary blocking run or a selection.
 */
export type MemoryBlockingReason = "pluginModel" | "requestTrigger" | "gap";

/**
 * One memory run of a job in `chatRef`, identified by `runId` (fresh for each run). `open: false`
 * ends that run's entry. `blocking` and `initial` runs summarize (`done` of `total` summaries);
 * `selection` is the selection's embedding queue (its `text`, no counts). Only an `initial` run
 * takes the stop control (`POST /api/generations/:id/memory-stop` with its `runId`).
 */
export type MemoryProgress =
    | { chatRef: MemoryChatRef; runId: string; open: false }
    | {
          chatRef: MemoryChatRef;
          runId: string;
          open: true;
          phase: "blocking" | "initial" | "selection";
          reason: MemoryBlockingReason | null;
          done?: number;
          total?: number;
          text?: string;
      };

export type GenerationQuestion =
    | { kind: "alertInput"; payload: { message: string; datalist?: [string, string][]; defaultValue?: string } }
    | { kind: "alertSelect"; payload: { options: string[]; display?: string } }
    | { kind: "alertConfirm"; payload: { message: string } }
    | { kind: "alertSelectChar"; payload: Record<string, never> }
    | { kind: "alertModuleSelect"; payload: Record<string, never> }
    /**
     * The no-memory trim question: a memory method is set, the owner's memory toggle is off, and the
     * prompt is over the context size, so the oldest chat history would be cut. The tab shows its own
     * localized text and answers a `MemoryTrimChoice`.
     */
    | { kind: "memoryTrim"; payload: Record<string, never> }
    /**
     * The HypaV3 gap question: a send that uses stored summaries only would leave out `gapTokens`
     * tokens of history no summary covers (more than the preset's `gapConfirmTokens`). Summarizing
     * them now takes about `plannedCalls` summary requests; `lastTaskError` is the chat's last
     * background memory failure, when there is one. The tab answers a `MemoryGapChoice`.
     */
    | { kind: "memoryGap"; payload: { gapTokens: number; plannedCalls: number; lastTaskError?: string } };

/**
 * The answer to `memoryTrim`: turn the owner's memory on and send with it, trim this send only, or
 * trim and do not ask again in this chat (until the owner's memory is turned on again).
 */
export type MemoryTrimChoice = "memory" | "once" | "ignore";
export const MEMORY_TRIM_CHOICES: readonly MemoryTrimChoice[] = ["memory", "once", "ignore"];

/**
 * The answer to `memoryGap`: summarize the gap in this send (with progress and the stop control), or
 * send now with the stored summaries and leave the gap to the background memory task.
 */
export type MemoryGapChoice = "generate" | "continue";
export const MEMORY_GAP_CHOICES: readonly MemoryGapChoice[] = ["generate", "continue"];

// ---------------------------------------------------------------------------------------------
// The background memory task: a job hands its chat's memory input to a detached service, which
// writes the summaries the job left out. Data only: the service rebuilds its host from a fresh
// scope, never from the job.

/**
 * A history entry's source, captured from the snapshot the entry was built from: a chat message
 * (its id and the hash of its stored text), the greeting (the `fmIndex` and the hash of the selected
 * greeting's text), or anything else (examples, the new-chat marker). The prompt history holds
 * enabled messages only; the summary writer compares the chat as it is then.
 */
export type MemoryEntrySource =
    | { readonly kind: "message"; readonly id: string | undefined; readonly textHash: string }
    | { readonly kind: "greeting"; readonly fmIndex: Chat["fmIndex"]; readonly textHash: string }
    | { readonly kind: "other"; readonly memo: string | undefined };

/**
 * How the job counted tokens, without credentials: the `ChatTokenCounter` arguments and host answers
 * (`chatAdditionalTokens`, the name rule, the main model's descriptor as the job resolved it, an
 * admitted Plugin descriptor's metadata included, the request model, the image rules) and the
 * tokenizer-selecting fields of the job's token scope. Built by an explicit projection (never the
 * scope object itself, which carries `googleAccessToken`); the task adds the credential from its own
 * fresh scope.
 */
export type MemoryTokenPolicy = {
    chatAdditionalTokens: number;
    useName: "name" | "noName";
    mainModel: LLMModel;
    /** OpenRouter's or NanoGPT's selected wire model, else absent. */
    requestModel?: string;
    supportsInlayImage: boolean;
    gptVisionQuality?: string;
    tokenizer: {
        aiModel: string;
        currentPluginProvider: string;
        model: { tokenizer: LLMModel["tokenizer"]; internalID?: string };
        pluginTokenizer: string;
        customTokenizer: string;
        googleClaudeTokenizing: boolean;
        useTokenizerCaching: boolean;
    };
};

/**
 * What a job hands to the memory task service, captured just before its memory step and deep-copied:
 *
 * - `history`: the processed prompt history the memory step gets (message-id memos), `sources` one per
 *   entry (same length), and `historyStart`, the index of its first chat history entry;
 * - the counts: `currentTokens` (the prompt before memory), `maxContext`, `maxResponse`, and the
 *   token policy; `settingsFingerprint`, a digest of the memory-relevant settings (the Hypa preset,
 *   the `memory` slot, the embedding model);
 * - `binding`: the ids the job was admitted with; `effective`: the presets it ran with and whether a
 *   `presetChain` picked the prompt preset;
 * - `speakerId`: the character the job replied as (null for none);
 * - freshness: the `epoch`, `admittedRevision` (the chat revision the job was admitted at, the job's
 *   `context.chatRevision`, never a revision read later), and `sourceGeneration`, the chat's source
 *   generation read in the same synchronous chat read that produced the history's source snapshot.
 */
export type MemoryTaskInput = {
    chatRef: MemoryChatRef;
    epoch: string;
    admittedRevision: string;
    sourceGeneration: number;
    speakerId: string | null;
    binding: { presetId: string | null; modelPresetId: string | null; personaId: string | null };
    effective: { presetId: string; modelPresetId: string; fromChain: boolean };
    history: OpenAIChat[];
    sources: MemoryEntrySource[];
    historyStart: number;
    currentTokens: number;
    maxContext: number;
    maxResponse: number;
    tokenPolicy: MemoryTokenPolicy;
    settingsFingerprint: string;
};

export type MemoryTaskState = "queued" | "running" | "done" | "failed" | "cancelled" | "skipped";

/**
 * A chat's memory task as the service reports it: `done` of `total` summaries; for a terminal state
 * the reason (`skipped`) or redacted error (`failed`), and `terminalRevision`, the chat's revision
 * read in the step that closed the task's writes and published the terminal (null: the chat is
 * gone), with `lastCommittedRevision` when the task committed a summary.
 */
export type MemoryTaskStatus =
    | { taskId: string; state: "queued" | "running"; done: number; total: number }
    | {
          taskId: string;
          state: "done" | "failed" | "cancelled" | "skipped";
          done: number;
          total: number;
          reason?: string;
          error?: string;
          terminalRevision: string | null;
          lastCommittedRevision?: string;
      };

/** A held summary writer lease (`MemoryTaskService.acquireSummaryWriter`). */
export type SummaryWriterLease = { release(): void };

/**
 * The detached memory task service a job talks to. `handOff` queues the chat's latest input (a newer
 * one replaces a pending one); `status` is the chat's current or last task (null for none);
 * `acquireSummaryWriter` closes the write fence of the chat's running task, waits (bounded) for its
 * last write to settle, and resolves the lease `ownerId` (the job) holds until `release` (hand-offs
 * and manual starts for the chat only queue meanwhile); `pendingManual` tells whether a manual start
 * waits for the chat's next input.
 */
export interface MemoryTaskService {
    handOff(input: MemoryTaskInput): void;
    status(chatRef: MemoryChatRef): MemoryTaskStatus | null;
    acquireSummaryWriter(chatRef: MemoryChatRef, ownerId: string): Promise<SummaryWriterLease>;
    pendingManual(chatRef: MemoryChatRef): boolean;
}

/**
 * The internal MCPs that run in the tab for a job (they need the browser: a directory handle, the
 * tab's own search credentials): a capability of every tab, not a plugin hook.
 */
export const TAB_MCP_IDENTIFIERS: readonly string[] = ["internal:fs", "internal:googlesearch"];

export type CallbackName =
    | "replacerbeforeRequest"
    | "replacerafterRequest"
    | "bodyIntercepter"
    | ScriptHookMode
    | "chatOutput"
    | "provider"
    | "mcpList"
    | "mcpTool"
    | "selectedChat"
    | "generateImage"
    | "inlayImage"
    | "imggen";

/** A callback's payload by name. */
export type CallbackPayloads = {
    replacerbeforeRequest: { messages: OpenAIChat[]; model: string };
    replacerafterRequest: { text: string; model: string };
    bodyIntercepter: { body: unknown; type: string };
    editinput: { text: string };
    editprocess: { text: string };
    editoutput: { text: string };
    editdisplay: { text: string };
    /**
     * The `chatOutput` listeners for the reply `messageId` of `speakerId`: the tab runs them in
     * order, each with a fresh snapshot of the character and chat and fresh indices, and answers
     * `true`.
     */
    chatOutput: { messageId: string; speakerId: string };
    /**
     * A plugin provider model's request: the tab calls the provider `name` with `argument` (the
     * prompt and the parameters, built on the server from the job's frozen settings). A provider
     * that answers text: the callback's answer is `{ success, content }`. One that answers a
     * stream: the tab sends `chunk` messages with the cumulative text (the first one, possibly
     * empty, as soon as the stream exists) and then answers `{ success: true, streamed: true }`. No
     * answer from the provider at all: `{ none: true }`.
     */
    provider: { name: string; argument: Record<string, unknown> };
    /**
     * The tools of an MCP that lives in the tab: a plugin MCP of the job's hook list, or one of
     * `TAB_MCP_IDENTIFIERS`. The tab handshakes it (a directory picker, a credential prompt) and
     * answers its tools as `{ name, description, inputSchema }` entries.
     */
    mcpList: { identifier: string };
    /** A call of one of those tools: answered with the tool's content. */
    mcpTool: { identifier: string; tool: string; args: unknown };
    /**
     * The chat of `characterId` this tab has selected (RisuAccess's chat history of a character
     * other than the job's; the selection is per tab), answered `{ chatId }`, or `null` when the
     * tab has no such character or chat.
     */
    selectedChat: { characterId: string };
    /** Lua `generateImage`: the client generates for `characterId`, writes the inlay, and answers `{ id }`. */
    generateImage: { prompt: string; negative: string; characterId: string };
    /**
     * An image inlay drawn by the client's canvas (`writeInlayImage`: PNG, at most 1024² pixels),
     * written under `id`, answered `{ id }`: a stored image `asset` (Lua `getCharacterImage`/
     * `getPersonaImage`, whose inlay id is the asset key) or a model's base64 image.
     */
    inlayImage: { id: string; asset: string } | { id: string; mimeType: string; data: string };
    /**
     * The image view of a reply (`viewScreen === "imggen"`): the tab runs `stableDiff` for
     * `characterId` with `text` (the last user message and the character messages after it) and its
     * own image settings, shows the image, and answers whether one was made.
     */
    imggen: { characterId: string; text: string };
};

/** The chat, prompt and model presets, and persona a callback acts on (the hook context). */
export type CallbackTargets = {
    chatRef: { chaId: string; chatId: string };
    presetId: string;
    modelPresetId: string;
    personaId: string;
};

/** A record the job hydrated before a callback, at the revision sent: the client must hold it at least that new. */
export type HydrationReceipt = { kind: string; id: string; characterId?: string; revision: string };

export type GenerationQuestionEvent = {
    type: "question";
    epoch: string;
    id: string;
    deadline: number;
    replay?: true;
} & GenerationQuestion;

export type GenerationCallbackEvent = {
    type: "callback";
    epoch: string;
    id: string;
    jobId: string;
    /** The outstanding callback this one runs inside (an aux request's callback), at most one level. */
    parentId?: string;
    name: CallbackName;
    targets: CallbackTargets;
    /** Every record the job hydrated right before this callback. */
    revisions: HydrationReceipt[];
    payload: unknown;
    /** Epoch milliseconds (server clock) after which the server stops waiting. */
    deadline: number;
    /** Sent again on a reattach: a page without this request's state must not run it. */
    replay?: true;
};

export type GenerationChannelEvent =
    | ({ type: "notice"; epoch: string } & GenerationNotice)
    | GenerationQuestionEvent
    | GenerationCallbackEvent
    /** The server stopped waiting for a request (timeout, job end): close it and drop its answer. */
    | { type: "cancel"; epoch: string; id: string };

export type QuestionOutcome = "answered" | "cancelled" | "timedOut" | "disconnected" | "aborted" | "refused";

export type QuestionResult =
    { outcome: "answered"; value: unknown } | { outcome: Exclude<QuestionOutcome, "answered">; error?: string };

/**
 * Why a callback failed on the client: the hook threw or was unavailable (`hook`); the barrier
 * (hydration not held, discarded keys, a rejected flush: `barrier`, which ends the job whatever the
 * hook's policy); a protocol rule (`protocol`: a replay without state, a bad nesting, an unknown name).
 */
export type CallbackFailure = "hook" | "barrier" | "protocol";

/** Why the server refused a callback: the job's hook list lacks it, or a nesting or queue rule. */
export type CallbackRefusal = "unregistered" | "nesting" | "queue";

export type CallbackResult =
    | { outcome: "answered"; value: unknown }
    | { outcome: "failed"; failure: CallbackFailure; error: string; discarded?: string[] }
    | { outcome: "refused"; refusal?: CallbackRefusal; error?: string }
    | { outcome: "timedOut" | "disconnected" | "aborted"; error?: string };

/**
 * How long a callback the server cancelled after delivering it keeps its client's lane at most: the
 * tab's hook may still run (a cancel only asks it to stop), and the client runs one root callback at
 * a time, so the next root waits until the tab reports the cancelled one drained
 * (`ChannelDrainedBody`) or this bound passes, measured from the cancel.
 */
export const CANCELLED_CALLBACK_DRAIN_MS = 60_000;

/**
 * `POST /api/generations/:id/drained?clientId=` (client to server): a callback of that job the server
 * cancelled is no longer running in the tab (its hook settled, or it had answered before the cancel).
 * Sent over HTTP, not the job's socket: the tab closes that socket at the job's end, which is when a
 * Stop cancels the callback.
 */
export type ChannelDrainedBody = { callbackId: string };

/** A streaming `provider` callback's text so far (client to server), before its answer. */
export type ChannelChunk = { type: "chunk"; id: string; text: string };

/** The longest cumulative text a `provider` callback may stream, in characters. */
export const MAX_PROVIDER_TEXT_CHARS = 4 * 1024 * 1024;

/** The owner's answer to a question or callback (client to server). */
export type ChannelAnswer =
    | { type: "answer"; id: string; outcome: "answered"; value: unknown }
    | { type: "answer"; id: string; outcome: "cancelled" }
    | { type: "answer"; id: string; outcome: "failed"; failure: CallbackFailure; error: string; discarded?: string[] };

export type GenerationEvent =
    | GenerationAcceptedEvent
    | GenerationChunkEvent
    | { type: "preset"; epoch: string; presetId: string }
    | GenerationResourceEvent
    | GenerationChatPatchEvent
    | { type: "progress"; epoch: string; payload: unknown }
    | GenerationChannelEvent
    | GenerationTerminalEvent
    | { type: "ping"; ts: number };

/** `GET /api/generations/:id`: what the owner needs to attach again. */
export type GenerationStatus = {
    jobId: string;
    kind: GenerationKind;
    characterId: string;
    chatId: string;
    epoch: string;
    state: "running" | "ended";
    messageId?: string;
    generationId?: string;
    terminal?: GenerationTerminalEvent;
};

/** Record kinds a job never sends as `resource` events (credentials stay on the server). */
export const HIDDEN_HYDRATION_KINDS: readonly string[] = ["llmSecrets", "authRefreshes"];
