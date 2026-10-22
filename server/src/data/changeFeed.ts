import type { ChatStreaming, MemoryTaskEntry } from "../../../shared/events.ts";
import type { ChangeSet } from "../../../shared/resources.ts";

/**
 * The live updates: what the resource store publishes after a commit, a write's refs and revisions
 * (`change`, with the generation locks of the chats a job's write touched or a job's end released:
 * `streaming`) or a new database epoch after a restore or import (`epoch`), and a chat's memory task
 * status change, which the memory task service publishes in the epoch of its transition (`memoryTask`).
 */
export type ChangeFeedEvent =
    | { type: "change"; epoch: string; changes: ChangeSet; streaming?: ChatStreaming[] }
    | ({ type: "memoryTask"; epoch: string } & MemoryTaskEntry)
    | { type: "epoch"; epoch: string };

export type ChangeFeedListener = (event: ChangeFeedEvent) => void;

export type ChangeFeed = ReturnType<typeof createChangeFeed>;

/**
 * The listeners of committed changes. Listeners only: there is no buffer and no replay, so a client
 * that was disconnected reconciles from the revision listing. A listener that throws is logged and
 * never fails the write that published (the write has committed already).
 */
export function createChangeFeed() {
    const listeners = new Set<ChangeFeedListener>();
    return {
        /** Adds a listener; returns its removal. */
        subscribe(listener: ChangeFeedListener): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        publish(event: ChangeFeedEvent) {
            for (const listener of [...listeners]) {
                try {
                    listener(event);
                } catch (error) {
                    console.error("[ChangeFeed]", error);
                }
            }
        },
    };
}
