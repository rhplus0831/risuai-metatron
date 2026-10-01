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

export type GenerationCreateBody = {
    kind: GenerationKind;
    context: GenerationContext;
    /** The client's registered hooks (`job-channel`); accepted and not read yet. */
    hooks?: unknown;
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

export type GenerationEvent =
    | GenerationAcceptedEvent
    | GenerationChunkEvent
    | { type: "preset"; epoch: string; presetId: string }
    | GenerationResourceEvent
    | { type: "progress"; epoch: string; payload: unknown }
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
