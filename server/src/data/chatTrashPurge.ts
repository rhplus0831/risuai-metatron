import { setImmediate as yieldImmediate } from "node:timers/promises";
import { normalizeChatTrashDays } from "../../../shared/database.ts";
import { SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import type { ResourceKind } from "./kinds.ts";
import { ResourceEpochError, ResourceStoreClosedError, type ResourceStore } from "./resourceStore.ts";
import type { MaintenanceGate } from "./snapshots.ts";

const DAY_MS = 86_400_000;

function logUnexpectedError(error: unknown) {
    if (!(error instanceof ResourceEpochError || error instanceof ResourceStoreClosedError)) {
        console.error("[Server] Chat trash purge failed:", error);
    }
}

/** Deletes expired trashed chats in separate transactions, yielding between candidates. */
export function createChatTrashPurge(options: {
    store: ResourceStore;
    gate: Pick<MaintenanceGate, "active">;
    uiKind: ResourceKind | undefined;
    chatHeld: (characterId: string, chatId: string) => boolean;
    now?: () => number;
    firstRunDelayMs?: number;
    intervalMs?: number;
}) {
    const { store, gate, uiKind, chatHeld, now = Date.now, firstRunDelayMs = 60_000, intervalMs = 3_600_000 } = options;
    let started = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<number | void> | undefined;

    async function purgeExpiredChats(): Promise<number | void> {
        if (closed || gate.active) return;
        const ui = uiKind
            ? (store.get(uiKind, SINGLETON_RESOURCE_ID)?.data as Record<string, unknown> | undefined)
            : undefined;
        const cutoff = now() - normalizeChatTrashDays(ui?.chatTrashDays) * DAY_MS;
        const epoch = store.epoch();
        const candidates = store.expiredTrashedChats(cutoff);
        let deleted = 0;
        for (const [index, { characterId, id, revision, trashedAt }] of candidates.entries()) {
            if (index > 0) await yieldImmediate();
            if (closed || gate.active) break;
            try {
                const result = store.changeChatTrash("delete", { characterId, chatId: id, revision }, epoch, chatHeld, {
                    trashedAt,
                    cutoff,
                });
                if (!("error" in result)) deleted++;
            } catch (error) {
                logUnexpectedError(error);
            }
        }
        return deleted;
    }

    async function run(): Promise<number | void> {
        if (closed || active || gate.active) return;
        active = Promise.resolve()
            .then(purgeExpiredChats)
            .catch(logUnexpectedError)
            .finally(() => {
                active = undefined;
            });
        return active;
    }

    function schedule(delay: number) {
        timer = setTimeout(() => {
            if (closed) return;
            schedule(intervalMs);
            void run();
        }, delay);
        timer.unref();
    }

    function beginShutdown() {
        closed = true;
        clearTimeout(timer);
        timer = undefined;
    }

    return {
        start() {
            if (started || closed) return;
            started = true;
            schedule(firstRunDelayMs);
        },
        beginShutdown,
        async close(): Promise<void> {
            beginShutdown();
            await active;
        },
        run,
    };
}
