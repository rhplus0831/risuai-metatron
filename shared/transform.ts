/**
 * The script transform (Phase 5 slice 13): the read-only batch endpoint that runs the display
 * transform (`editdisplay`: Lua `editDisplay`, the `display` trigger, CBS, the regex scripts, the
 * dynamic assets) and the `editprocess` transform (CBS, the regex scripts) of `processScriptFull` on
 * the server. Both runtimes compile this file: no DOM types, no Svelte runes.
 *
 * `POST /api/transform` takes a `TransformRequest`. Without `handlers` it answers every target. With
 * `handlers` (the tab has plugin handlers for the mode), the server runs the stages before them,
 * keeps the targets' state as a snapshot, and answers `snapshotId` with the pending texts; the tab
 * runs `pluginHooks[mode]` on each and sends `POST /api/transform/continue` with a
 * `TransformContinueRequest`, which answers the rest. Both answer `TransformResponse`.
 */
import type { CbsConditions } from "./cbs/types.ts";
import type { GenerationClientEnv } from "./jobs.ts";

export type TransformMode = "editdisplay" | "editprocess";

/** `message`: a chat message (by id); `background`: background HTML; `translation`: translated text; `text`: the rest. */
export type TransformTargetKind = "message" | "background" | "translation" | "text";

export const TRANSFORM_TARGET_KINDS: readonly TransformTargetKind[] = ["message", "background", "translation", "text"];

/** The chat the transform runs for (the tab captures it before its first await), and its preset and personas. */
export type TransformContext = {
    characterId: string;
    chatId: string;
    /** The prompt preset. */
    presetId: string;
    /** The model preset. */
    modelPresetId: string;
    /** The effective persona (the chat's bound persona wins). */
    personaId: string;
    /** The tab's selected persona. */
    selectedPersonaId: string;
};

export type TransformTarget = {
    /** The request's correlation id (unique in the request; never a cache identity). */
    id: string;
    kind: TransformTargetKind;
    /** The character whose scripts run (the chat owner, or the speaking member of a group chat). */
    sourceId: string;
    /** `processScriptFull`'s `chatID`: the message's index in the chat, or -1. */
    chatIndex: number;
    /** A `message` target's id (resolved by the tab before its first await). */
    messageId?: string;
    source: string;
    cbsConditions?: CbsConditions;
    /** Skips the cache and replaces its entry ("Re-render"). */
    noCache?: boolean;
};

export type TransformRequest = {
    clientId: string;
    mode: TransformMode;
    context: TransformContext;
    /** What CBS reads of the tab (the viewport, the browser language); its `emotions` are not read. */
    client?: GenerationClientEnv;
    targets: TransformTarget[];
    /** The tab's plugin handler set for `mode` (a value that changes when the set changes); absent: none. */
    handlers?: string;
};

/** The texts after the tab's plugin handlers, one per pending target: the text, or the handler's failure. */
export type TransformContinueRequest = {
    clientId: string;
    snapshotId: string;
    texts: ({ id: string; text: string } | { id: string; error: string })[];
};

/** An `@@emo` effect: the emotion's name and image, in the order the regex scripts produced them. */
export type TransformEmotion = { name: string; image: string };

export type TransformResult =
    | {
          id: string;
          ok: true;
          text: string;
          emotions: TransformEmotion[];
          /** The cache key (a digest): the tab applies a key's emotions once. */
          key: string;
          cached: boolean;
      }
    | { id: string; ok: false; error: string };

export type TransformResponse = {
    results: TransformResult[];
    /** Present when targets wait for the tab's plugin handlers (`POST /api/transform/continue`). */
    snapshotId?: string;
    pending?: { id: string; text: string }[];
};

/** The targets of one request. */
export const MAX_TRANSFORM_TARGETS = 64;
/** The UTF-8 bytes of one target's source, or of one text after the plugin handlers. */
export const MAX_TRANSFORM_TEXT_BYTES = 512 * 1024;
/** The UTF-8 bytes of a request's sources (or texts) together. */
export const MAX_TRANSFORM_REQUEST_TEXT_BYTES = 4 * 1024 * 1024;
/** The request body. */
export const MAX_TRANSFORM_BODY_BYTES = 8 * 1024 * 1024;
/** How long a snapshot waits for its second call, from the first call's start. */
export const TRANSFORM_SNAPSHOT_TTL_MS = 30_000;
