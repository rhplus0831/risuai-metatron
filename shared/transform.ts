import type { CbsConditions } from "./cbs/types.ts";
import type { GenerationClientEnv } from "./jobs.ts";

/**
 * The script transform: the read-only batch endpoint that runs the display transform
 * (`editdisplay`: Lua `editDisplay`, the `display` trigger, CBS, the regex scripts, the dynamic
 * assets) and the `editprocess` transform (CBS, the regex scripts) of `processScriptFull` on the
 * server. Both runtimes compile this file: no DOM types, no Svelte runes.
 *
 * `POST /api/transform` takes a `TransformRequest`. Without `handlers` it answers every target. With
 * `handlers` (the tab has plugin handlers for the mode), the server runs the stages before them,
 * keeps the targets' state as a snapshot, and answers `snapshotId` with the pending texts; the tab
 * runs `pluginHooks[mode]` on each and sends `POST /api/transform/continue` with a
 * `TransformContinueRequest`, which answers the rest. Both answer `TransformResponse`.
 * A target's `knownKey` confirms an exact cache hit in `same`, without downloading its text again.
 */

/** Display runs the display hooks before CBS/regex/assets; process runs plugin handlers before CBS/regex. */
export type TransformMode = "editdisplay" | "editprocess";

/**
 * `message`: a chat message (by id); `background`: background HTML; `translation`: translated text;
 * `text`: the rest.
 */
export type TransformTargetKind = "message" | "background" | "translation" | "text";

/** The wire allowlist shared by the tab's targets and `server/src/routes/transform.ts` validation. */
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

/**
 * One isolated transform on the supplied source, correlated by id; its overlays never persist.
 */
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
    /**
     * The `key` of this target's earlier result (64 lowercase hex characters): when the server's
     * ordinary successful cache hit holds exactly that key, it is answered in `same` instead of
     * `results`. The key identifies inputs; output can differ after eviction or a forced re-render.
     * Fresh runs, failures and noCache targets answer in full (or await handlers in pending).
     */
    knownKey?: string;
};

/** A read-only first call: handlers opt cache misses into the two-call protocol, not cache hits. */
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

/** Every pending id exactly once: its handler text, failure, or cancellation (no tail or result). */
export type TransformContinueRequest = {
    clientId: string;
    snapshotId: string;
    texts: ({ id: string; text: string } | { id: string; error: string } | { id: string; cancelled: true })[];
};

/** An `@@emo` effect: the emotion's name and image, in the order the regex scripts produced them. */
export type TransformEmotion = { name: string; image: string };

/** A full target answer; successes carry text and ordered emotion effects, failures are never cached. */
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
    | {
          id: string;
          ok: false;
          error: string;
          /**
           * The target is expected to fail again until its source, context, or stored data changes (a
           * text or scope over a limit on its own): the tab does not retry it on its own.
           */
          permanent?: true;
      };

/**
 * Each first-call target is answered exactly once in results, same or pending. `same` is a separate
 * { id, key }[] (no text or emotions), omitted when empty. A continuation always answers its
 * non-cancelled pending targets in full in results, without same, snapshotId or pending.
 * An all-cancelled continuation drops the snapshot and answers { results: [] }.
 */
export type TransformResponse = {
    results: TransformResult[];
    /**
     * Exact successful cache-hit confirmations of the target's knownKey, on the first call only.
     */
    same?: { id: string; key: string }[];
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
/** Pending plugin snapshots retained per client; the tab admits two-call chunks within this cap. */
export const MAX_TRANSFORM_SNAPSHOTS_PER_CLIENT = 4;
/** How long a snapshot waits for its second call, from the first call's start. */
export const TRANSFORM_SNAPSHOT_TTL_MS = 30_000;
