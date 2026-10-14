import type { ChangeSet } from "./resources.ts";

/** The path of the live-update socket (`/api/events/ws?risu-auth=<JWT>`). */
export const EVENT_FEED_PATH = "/api/events/ws";

/**
 * A frame of the live-update socket (Phase 6), server to client:
 * - `hello`: sent once on every connection with the database epoch; the client reconciles its
 *   revisions against `GET /api/resources/revisions` (nothing is replayed);
 * - `change`: one committed write's refs and revisions (a record patch's changed fields or items with it);
 * - `epoch`: a restore or import replaced the database; the client reloads;
 * - `ping`: the heartbeat.
 */
export type EventFeedFrame =
    | { type: "hello"; epoch: string }
    | { type: "change"; epoch: string; changes: ChangeSet }
    | { type: "epoch"; epoch: string }
    | { type: "ping"; ts: number };
