import type { MemoryTaskStatus, StreamingMessage } from "./jobs.ts";
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
 * A chat's HypaV3 memory task status on the live-update socket: the running task, else the queued
 * one, else the last terminal (kept 10 minutes). A terminal carries `terminalRevision`, the chat's
 * revision when the task's writes closed (null: the chat is gone).
 */
export type MemoryTaskEntry = { characterId: string; chatId: string; status: MemoryTaskStatus };

/**
 * A frame of the live-update socket, server to client:
 * - `hello`: sent once on every connection with the database epoch and every chat's memory task
 *   status (`memoryTasks`, the whole set: it replaces what the client held); the client reconciles
 *   its revisions against `GET /api/resources/revisions` (nothing is replayed);
 * - `change`: one committed write's refs and revisions, optionally with record or by-id chat patches;
 *   `streaming` lists the locks of every chat a generation job's write touched, or whose locks the
 *   job's end released (then `changes` may be empty);
 * - `memoryTask`: a chat's memory task status changed (in `epoch`); a task's summary write reaches
 *   the client as its `change` frame first;
 * - `epoch`: a restore or import replaced the database; the client reloads;
 * - `ping`: the heartbeat.
 */
export type EventFeedFrame =
    | { type: "hello"; epoch: string; memoryTasks: MemoryTaskEntry[] }
    | { type: "change"; epoch: string; changes: ChangeSet; streaming?: ChatStreaming[] }
    | ({ type: "memoryTask"; epoch: string } & MemoryTaskEntry)
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
