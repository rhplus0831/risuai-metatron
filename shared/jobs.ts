import type { LLMModel } from "./llm.ts";
import type { OpenAIChat } from "./openai.ts";

/**
 * The generation job contract (Phase 5, `generation-jobs`): `POST /api/generations` creates a job
 * for one chat, its owner (the tab's `clientId`) follows it over `/api/generations/:id/ws`, and
 * `DELETE /api/generations/:id` aborts it. One chat has at most one running job.
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

/** The execution context of PLAN.md Decision 5, plus the chat revision the client last saw. */
export type GenerationContext = {
    characterId: string;
    chatId: string;
    presetId: string | null;
    /** The effective persona (a bound persona wins). */
    personaId: string | null;
    mode: string;
    input: string;
    continueMessageId?: string;
    speakerChaId?: string;
    /** A command job's trigger (buttons, manual triggers). */
    triggerId?: string;
    chatRevision: string;
};

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

export type GenerationCreateBody = {
    kind: GenerationKind;
    context: GenerationContext;
    /** The client's registered hooks; missing means none. */
    hooks?: GenerationHooks;
    clientId: string;
};

export type GenerationCreated = { jobId: string };

/** 409: the chat has a running job (the owner can attach to it). */
export type GenerationBusyBody = { error: "chatBusy"; jobId: string };

/** 409: the chat changed since the revision the client sent. */
export type GenerationStaleBody = { error: "stale" };

export type GenerationErrorReason = "failed" | "aborted" | "shutdown" | "maintenance" | "timeout";

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

export type GenerationChunkEvent = {
    type: "chunk";
    epoch: string;
    messageId: string;
    generationId: string;
    text: string;
    seq: number;
};

/** A message a job is still generating, and the newest chunk its stored text includes. */
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

export type GenerationTerminalEvent =
    | {
          type: "done";
          epoch: string;
          revision: string | null;
          messageId?: string;
          alternatives?: string[];
          /** A preview's result (`preview`: the assembled messages; `previewPrompt`: the provider body). */
          result?: unknown;
      }
    | { type: "error"; epoch: string; message: string; status: number; reason: GenerationErrorReason };

// ---------------------------------------------------------------------------------------------
// The job channel (`job-channel`): notices one way; questions and plugin callbacks are requests
// the owner answers. Every request has one deadline from the moment it is queued; the server alone
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
    | { kind: "notification"; payload: { chaId: string; body: string } }
    /** The secret-free request projection (`request-layer-and-llm-secrets`). */
    | { kind: "requestLog"; payload: unknown };

export type GenerationQuestion =
    | { kind: "alertInput"; payload: { message: string; datalist?: [string, string][]; defaultValue?: string } }
    | { kind: "alertSelect"; payload: { options: string[]; display?: string } }
    | { kind: "alertConfirm"; payload: { message: string } }
    | { kind: "alertSelectChar"; payload: Record<string, never> }
    | { kind: "alertModuleSelect"; payload: Record<string, never> };

export type CallbackName =
    | "replacerbeforeRequest"
    | "replacerafterRequest"
    | "bodyIntercepter"
    | ScriptHookMode
    | "chatOutput"
    | "provider"
    | "mcpTool"
    | "generateImage";

/** A callback's payload by name; `chatOutput`, `provider`, and `generateImage` are defined by slices 11 and 8a. */
export type CallbackPayloads = {
    replacerbeforeRequest: { messages: OpenAIChat[]; model: string };
    replacerafterRequest: { text: string; model: string };
    bodyIntercepter: { body: unknown; type: string };
    editinput: { text: string };
    editprocess: { text: string };
    editoutput: { text: string };
    editdisplay: { text: string };
    chatOutput: unknown;
    provider: { name: string } & Record<string, unknown>;
    mcpTool: { identifier: string; tool: string; args: unknown };
    generateImage: unknown;
};

/** The chat, preset, and persona a callback acts on (the Phase 4 hook context). */
export type CallbackTargets = { chatRef: { chaId: string; chatId: string }; presetId: string; personaId: string };

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
