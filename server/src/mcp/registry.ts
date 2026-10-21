import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { JobChanges } from "../jobs/generationJobs.ts";
import { McpClient, type McpRefresh } from "./client.ts";

/** A remote client nobody has used for this long is closed (its session stream, its token). */
export const MCP_IDLE_MS = 15 * 60_000;

/**
 * The remote MCP clients of the server process, one per module identifier (the module's `mcp.url` as
 * written, which is also its `authRefreshes` key). A client is used only inside `use`, which counts
 * the operations in progress: a client is closed when it has been idle for `MCP_IDLE_MS`, when the
 * database epoch changes (`sync`: its tokens belong to the old data), or at shutdown, and the next
 * `use` creates a new one. A session lives in this process only: a restart drops it and the next
 * call handshakes again.
 */
export type McpRegistry = {
    use<T>(identifier: string, url: string, run: (client: McpClient) => Promise<T>): Promise<T>;
    /** The `authRefreshes` write of a completed login: the entry of `identifier` replaced (every one with that URL). */
    refreshChanges(identifier: string, entry: McpRefresh): JobChanges;
    sync(epoch: string): void;
    dispose(): void;
};

type Entry = { client: McpClient; active: number; timer: NodeJS.Timeout | null };

export function createMcpRegistry(options: {
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    fetchImpl?: typeof fetch;
    idleMs?: number;
    requestTimeoutMs?: number;
}): McpRegistry {
    const { store, kinds } = options;
    const idleMs = options.idleMs ?? MCP_IDLE_MS;
    const clients = new Map<string, Entry>();
    let boundEpoch: string | null = null;
    let disposed = false;

    const refreshKind = () => {
        const kind = kinds.get(RESOURCE_KIND.authRefreshes);
        if (!kind) {
            throw new Error("Unknown resource kind authRefreshes");
        }
        return kind;
    };
    const storedRefreshes = () => {
        const row = store.get(refreshKind(), SINGLETON_RESOURCE_ID);
        const list = Array.isArray(row?.data) ? (row.data as Record<string, unknown>[]) : [];
        return { row, list };
    };

    const close = (identifier: string, entry: Entry) => {
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        if (clients.get(identifier) === entry) {
            clients.delete(identifier);
        }
        entry.client.destroy();
    };
    const closeAll = () => {
        for (const [identifier, entry] of [...clients]) {
            close(identifier, entry);
        }
    };

    return {
        async use(identifier, url, run) {
            if (disposed) {
                throw new Error("The server is shutting down");
            }
            let entry = clients.get(identifier);
            if (!entry || entry.client.isClosed) {
                entry = {
                    client: new McpClient(url, {
                        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                        ...(options.requestTimeoutMs !== undefined
                            ? { requestTimeoutMs: options.requestTimeoutMs }
                            : {}),
                        // The record as stored now: another job's login or the tab's is seen.
                        readRefresh: () =>
                            storedRefreshes().list.find((refresh) => refresh?.url === identifier) as
                                McpRefresh | undefined,
                    }),
                    active: 0,
                    timer: null,
                };
                clients.set(identifier, entry);
            }
            const held = entry;
            held.active++;
            if (held.timer) {
                clearTimeout(held.timer);
                held.timer = null;
            }
            try {
                return await run(held.client);
            } finally {
                held.active--;
                // Idle from the last release on; a client closed meanwhile has no timer to keep.
                if (held.active === 0 && clients.get(identifier) === held) {
                    held.timer = setTimeout(() => close(identifier, held), idleMs);
                    held.timer.unref();
                }
            }
        },

        refreshChanges(identifier, entry) {
            const { row, list } = storedRefreshes();
            if (!row) {
                throw new Error("The server has no authRefreshes record");
            }
            const record = { url: identifier, ...entry };
            const first = list.findIndex((refresh) => refresh?.url === identifier);
            const others = list.filter((refresh) => refresh?.url !== identifier);
            const next =
                first === -1
                    ? [...others, record]
                    : [
                          ...list.slice(0, first).filter((refresh) => refresh?.url !== identifier),
                          record,
                          ...list.slice(first + 1).filter((refresh) => refresh?.url !== identifier),
                      ];
            return {
                ops: [{ kind: refreshKind(), id: SINGLETON_RESOURCE_ID, baseRevision: row.revision, data: next }],
            };
        },

        sync(epoch) {
            if (boundEpoch !== null && boundEpoch !== epoch) {
                closeAll();
            }
            boundEpoch = epoch;
        },

        dispose() {
            disposed = true;
            closeAll();
        },
    };
}
