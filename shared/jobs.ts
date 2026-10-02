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
    /**
     * A send's user message (Phase 5 slice 9): the id the job appends `input` under after the input
     * trigger and `editinput`. The input stage is skipped when the chat already holds a user message
     * with this id (a job created again after the first one appended it).
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
 * character id, oldest first (Phase 5 slice 11: the emotion modes penalize a recent choice).
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
 * trigger (`risu-trigger`, `/trigger`) by name (Phase 5 slice 8b; its `risu-id` is `context.triggerId`).
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
          /**
           * A send that ended without counting as sent (a trigger's stop, an error written into the
           * chat, nothing to continue): the tab's `sendChat` returns false (Phase 5 slice 9).
           */
          stopped?: true;
          /**
           * `/multisend` commands a command job ran (slice 11b), in order: the tab sends each part
           * after the job (the user message appended, then a send), `clear` removing the chat's
           * messages before each part, and stops at the first part that does not send.
           */
          followUps?: GenerationFollowUp[];
      }
    | { type: "error"; epoch: string; message: string; status: number; reason: GenerationErrorReason };

/** One `/multisend` of a command job: the texts to send in turn. */
export type GenerationFollowUp = { clear: boolean; parts: string[] };

/** The most parts all the follow-ups of one job carry, and the longest part in characters. */
export const MAX_FOLLOW_UP_PARTS = 64;
export const MAX_FOLLOW_UP_PART_CHARS = 100_000;

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
    /** Opens a web page in the tab (an MCP server's OAuth authorization page, slice 12); `http(s)` only. */
    | { kind: "openURL"; payload: { url: string } }
    /** The secret-free request projection (`request-layer-and-llm-secrets`). */
    | { kind: "requestLog"; payload: unknown };

export type GenerationQuestion =
    | { kind: "alertInput"; payload: { message: string; datalist?: [string, string][]; defaultValue?: string } }
    | { kind: "alertSelect"; payload: { options: string[]; display?: string } }
    | { kind: "alertConfirm"; payload: { message: string } }
    | { kind: "alertSelectChar"; payload: Record<string, never> }
    | { kind: "alertModuleSelect"; payload: Record<string, never> };

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
    | "generateImage"
    | "inlayImage"
    | "imggen";

/** A callback's payload by name; `provider` is defined by slice 11b. */
export type CallbackPayloads = {
    replacerbeforeRequest: { messages: OpenAIChat[]; model: string };
    replacerafterRequest: { text: string; model: string };
    bodyIntercepter: { body: unknown; type: string };
    editinput: { text: string };
    editprocess: { text: string };
    editoutput: { text: string };
    editdisplay: { text: string };
    /**
     * The `chatOutput` listeners for the reply `messageId` of `speakerId` (slice 11): the tab runs
     * them in order, each with a fresh snapshot of the character and chat and fresh indices, and
     * answers `true`.
     */
    chatOutput: { messageId: string; speakerId: string };
    /**
     * A plugin provider model's request (slice 11b): the tab calls the provider `name` with
     * `argument` (the prompt and the parameters, built on the server from the job's frozen settings).
     * A provider that answers text: the callback's answer is `{ success, content }`. One that answers
     * a stream: the tab sends `chunk` messages with the cumulative text (the first one, possibly
     * empty, as soon as the stream exists) and then answers `{ success: true, streamed: true }`. No
     * answer from the provider at all: `{ none: true }`.
     */
    provider: { name: string; argument: Record<string, unknown> };
    /**
     * The tools of an MCP that lives in the tab (slice 12): a plugin MCP of the job's hook list, or one
     * of `TAB_MCP_IDENTIFIERS`. The tab handshakes it (a directory picker, a credential prompt) and
     * answers its tools as `{ name, description, inputSchema }` entries.
     */
    mcpList: { identifier: string };
    /** A call of one of those tools: answered with the tool's content. */
    mcpTool: { identifier: string; tool: string; args: unknown };
    /** Lua `generateImage`: the client generates for `characterId`, writes the inlay, and answers `{ id }`. */
    generateImage: { prompt: string; negative: string; characterId: string };
    /**
     * An image inlay drawn by the client's canvas (`writeInlayImage`: PNG, at most 1024² pixels),
     * written under `id`, answered `{ id }`: a stored image `asset` (Lua `getCharacterImage`/
     * `getPersonaImage`, whose inlay id is the asset key) or a model's base64 image.
     */
    inlayImage: { id: string; asset: string } | { id: string; mimeType: string; data: string };
    /**
     * The image view of a reply (`viewScreen === "imggen"`, slice 11): the tab runs `stableDiff` for
     * `characterId` with `text` (the last user message and the character messages after it) and its
     * own image settings, shows the image, and answers whether one was made.
     */
    imggen: { characterId: string; text: string };
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
