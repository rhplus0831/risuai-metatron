import type { StreamingMessage } from "./jobs.ts";
import type { ChangeSet } from "./resources.ts";

/** The path of the live-update socket (`/api/events/ws?risu-auth=<JWT>`). */
export const EVENT_FEED_PATH = "/api/events/ws";

/**
 * A chat's generation locks after a job's write or end: every message of the chat a generation job
 * still owns, each with its generation and the newest chunk `seq` its stored text includes (the
 * shape of a job's chat events). Empty: no message of the chat is locked.
 */
export type ChatStreaming = { characterId: string; id: string; streaming: StreamingMessage[] };

/**
 * A frame of the live-update socket, server to client:
 * - `hello`: sent once on every connection with the database epoch; the client reconciles its
 *   revisions against `GET /api/resources/revisions` (nothing is replayed);
 * - `change`: one committed write's refs and revisions, optionally with record or by-id chat patches;
 *   `streaming` lists the locks of every chat a generation job's write touched, or whose locks the
 *   job's end released (then `changes` may be empty);
 * - `epoch`: a restore or import replaced the database; the client reloads;
 * - `ping`: the heartbeat.
 */
export type EventFeedFrame =
    | { type: "hello"; epoch: string }
    | { type: "change"; epoch: string; changes: ChangeSet; streaming?: ChatStreaming[] }
    | { type: "epoch"; epoch: string }
    | { type: "ping"; ts: number };
