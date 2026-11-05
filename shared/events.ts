import type { MemoryTaskStatus, StreamingMessage } from "./jobs.ts";
import type { ChangeSet } from "./resources.ts";

/**
 * The path of the live-update socket (`/api/events/ws?risu-auth=<JWT>`). Optional `proto` is a finite
 * non-negative integer recorded per socket and logged (invalid or absent: none), never enforced.
 */
export const EVENT_FEED_PATH = "/api/events/ws";

/** Presence names are capped in UTF-16 code units, on both the tab and server. */
export const MAX_FEED_CLIENT_NAME = 64;
export const MAX_FEED_CLIENTS = 64;

/** A registered live-update socket's tab identity and worker preference. */
export type FeedClient = { clientId: string; name: string; worker: boolean };
export type EventFeedClientMessage = { type: "register" } & FeedClient;

/**
 * A chat's generation locks after a job's write or end: every message of the chat a generation job
 * still owns, each with its generation and the newest chunk `seq` its stored text includes (the
 * shape of a job's chat events). Empty: no message of the chat is locked.
 */
export type ChatStreaming = { characterId: string; id: string; streaming: StreamingMessage[] };

/**
 * A chat's current generation locks. `revision` is the chat's stored revision sampled in the same
 * synchronous step as the ownership, not a version of the ownership (null: the chat is gone).
 */
export type ChatStreamingSnapshot = ChatStreaming & { revision: string | null };

/**
 * A chat's HypaV3 memory task status on the live-update socket: the running task, else the queued
 * one, else the last terminal (kept 10 minutes). A terminal carries `terminalRevision`, the chat's
 * revision when the task's writes closed (null: the chat is gone).
 */
export type MemoryTaskEntry = { characterId: string; chatId: string; status: MemoryTaskStatus };

/** An offer contains only job identity and routing, never chat content. */
export type HandoffOffer = {
    epoch: string;
    jobId: string;
    characterId: string;
    chatId: string;
    state: "open" | "closed";
    reason: "absent" | "preferred" | "requested";
    target?: string;
};

/**
 * A frame of the live-update socket, server to client:
 * - `hello`: sent once on every connection with the database epoch, current generation locks
 *   (`streaming`), every chat's memory task status (`memoryTasks`), and optional open handoff offers
 *   (`handoffs`) and connected clients (`clients`); these snapshots replace the
 *   client's whole sets. The optional `digest` fingerprints the revision listing sampled with those
 *   snapshots. A matching advertised map reconciles locally; otherwise the client reads
 *   `GET /api/resources/revisions`, as a digest-checked log replay up to the optional `cursor`
 *   (the change log's high-water mark) or as the whole listing;
 * - `change`: one committed write's refs and revisions, optionally with record or by-id chat patches;
 *   `streaming` lists the locks of every chat a generation job's write touched, or whose locks the
 *   job's end released (then `changes` may be empty); the optional `cursor` is the newest log row
 *   of its refs, absent from a lock-only frame and on older servers;
 * - `memoryTask`: a chat's memory task status changed (in `epoch`); a task's summary write reaches
 *   the client as its `change` frame first;
 * - `handoff`: a content-free job handoff offer opened or closed;
 * - `clients`: the whole registered-client list; presence is process-local and has no epoch;
 * - `epoch`: a restore or import replaced the database; the client reloads;
 * - `ping`: the heartbeat.
 */
export type EventFeedFrame =
    | {
          type: "hello";
          rerollInPlace?: true;
          epoch: string;
          streaming: ChatStreamingSnapshot[];
          memoryTasks: MemoryTaskEntry[];
          digest?: string;
          /** Optional on older servers; the log high-water cursor sampled with the digest. */
          cursor?: number;
          handoffs?: HandoffOffer[];
          clients?: FeedClient[];
      }
    | { type: "change"; epoch: string; changes: ChangeSet; streaming?: ChatStreaming[]; cursor?: number }
    | ({ type: "memoryTask"; epoch: string } & MemoryTaskEntry)
    | ({ type: "handoff" } & HandoffOffer)
    | { type: "clients"; clients: FeedClient[] }
    | { type: "epoch"; epoch: string }
    | { type: "ping"; ts: number };

/**
 * The memory task routes: `POST` starts a chat's task (`MemoryTaskStartBody`), `DELETE
 * <path>/:characterId/:chatId` cancels it. Both are refused with 503 `notEnabled` only on a server
 * without a memory task service (`memoryTasks: "disabled"`).
 */
export const MEMORY_TASKS_PATH = "/api/memory/tasks";

export type MemoryTaskStartBody = { characterId: string; chatId: string };

/**
 * A manual start's answer: the chat's task runs or is queued (also a retained input queued now), or
 * no usable input is retained and the chat's next send hands one off (`pendingManual`).
 */
export type MemoryTaskStartAnswer =
    { outcome: "running" | "queued"; status: MemoryTaskStatus } | { outcome: "pendingManual" };

/** A cancel's answer: whether a queued or running task, or a waiting manual start, was cancelled. */
export type MemoryTaskCancelAnswer = { cancelled: boolean };
