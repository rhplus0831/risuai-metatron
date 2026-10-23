import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { BackupSnapshotInfo } from "../../../shared/resources.ts";
import { mkdirDurableSync, syncDir, syncFile } from "./durableWrite.ts";
import type { ResourceStore } from "./resourceStore.ts";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_KEEP = 20;
const snapshotNameRegex = /^resources-(\d{8}T\d{9}Z)-[0-9a-f]{8}\.sqlite$/;

/**
 * A mutation arrived while a restore or an import holds the store, or a backup operation arrived
 * while the server shuts down; the route answers 503.
 */
export class MaintenanceError extends Error {
    constructor(message = "Maintenance in progress") {
        super(message);
        this.name = "MaintenanceError";
    }
}

/**
 * Resource mutations call `assertOpen` right before their synchronous write. Storage mutations,
 * whose file work is asynchronous, call `enter` first and the returned function when they are done:
 * maintenance waits until every entered mutation has left before it starts.
 */
export type MaintenanceGate = {
    readonly active: boolean;
    assertOpen(): void;
    /** Admits an asynchronous mutation (throws `MaintenanceError` while closed); call the result to leave. */
    enter(): () => void;
};

export type SnapshotManager = ReturnType<typeof createSnapshotManager>;

function stamp(date: Date): string {
    const pad = (value: number, length = 2) => String(value).padStart(length, "0");
    return (
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
        `${pad(date.getUTCMilliseconds(), 3)}Z`
    );
}

function parseStamp(value: string): string {
    const [, y, mo, d, h, mi, s, ms] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(value)!;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
}

/**
 * Periodic snapshots of the resource database under `dir` (`save/backups/`) and the lock that
 * serializes every operation touching the whole database: snapshots, export copies, restores, and
 * imports. A snapshot is written to a hidden temporary name, flushed, renamed into place, and its
 * directory synced; the list only shows finished files and the newest `keep` are retained. While
 * `withMaintenance` runs, `gate.assertOpen` throws, so resource mutations answer 503.
 */
export function createSnapshotManager(options: {
    store: ResourceStore;
    dir: string;
    intervalMs?: number;
    keep?: number;
}) {
    const { store, dir } = options;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const keep = options.keep ?? DEFAULT_KEEP;
    mkdirDurableSync(dir);

    let tail: Promise<unknown> = Promise.resolve();
    let maintenance = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let tickQueued = false;
    let stopped = false;
    let stopping: Promise<void> | null = null;
    /** Resource handlers and backup operations admitted and not yet finished. */
    const active = new Set<Promise<unknown>>();
    /** Run by `withMaintenance` before mutations close (the generation jobs end there). */
    const maintenanceListeners = new Set<() => Promise<(() => void) | void>>();
    /** `store.writeCount()` covered by the last periodic snapshot (none is taken before the first write). */
    let snapshotWrites = store.writeCount();

    /** Runs `fn` after every earlier exclusive operation has settled. */
    function exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = tail.then(fn, fn);
        tail = run.catch(() => {});
        return run;
    }

    function list(): BackupSnapshotInfo[] {
        const items: BackupSnapshotInfo[] = [];
        for (const name of readdirSync(dir)) {
            const match = snapshotNameRegex.exec(name);
            if (!match) {
                continue;
            }
            const stat = lstatSync(path.join(dir, name), { throwIfNoEntry: false });
            if (stat?.isFile()) {
                items.push({ id: name.slice(0, -".sqlite".length), createdAt: parseStamp(match[1]), size: stat.size });
            }
        }
        return items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    }

    /** The file of a listed snapshot, or null for any id that is not one. */
    function resolve(id: string): string | null {
        const name = `${id}.sqlite`;
        if (!snapshotNameRegex.test(name)) {
            return null;
        }
        const file = path.join(dir, name);
        return lstatSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
    }

    /** Takes one snapshot. Only call it while holding the lock (`exclusive`). */
    async function takeLocked(): Promise<BackupSnapshotInfo> {
        const now = new Date();
        const name = `resources-${stamp(now)}-${randomBytes(4).toString("hex")}.sqlite`;
        const temporary = path.join(dir, `.${name}.tmp`);
        try {
            await store.backupTo(temporary);
            await syncFile(temporary);
            await fs.rename(temporary, path.join(dir, name));
            await syncDir(dir);
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => {});
            throw error;
        }
        for (const old of list().slice(keep)) {
            await fs.rm(path.join(dir, `${old.id}.sqlite`), { force: true });
        }
        const size = (await fs.stat(path.join(dir, name))).size;
        return { id: name.slice(0, -".sqlite".length), createdAt: now.toISOString(), size };
    }

    function tick() {
        if (tickQueued || stopped) {
            return;
        }
        tickQueued = true;
        void exclusive(async () => {
            tickQueued = false;
            const writes = store.writeCount();
            if (stopped || writes === snapshotWrites) {
                return;
            }
            await takeLocked();
            snapshotWrites = writes;
        }).catch((error) => {
            console.error("[Server] Resource snapshot failed:", error);
        });
    }

    /** Storage mutations admitted by `gate.enter` and not yet done. */
    let entered = 0;
    let drainWaiters: (() => void)[] = [];

    const gate: MaintenanceGate = {
        get active() {
            return maintenance;
        },
        assertOpen() {
            if (maintenance) {
                throw new MaintenanceError();
            }
        },
        enter() {
            gate.assertOpen();
            entered += 1;
            let left = false;
            return () => {
                if (left) {
                    return;
                }
                left = true;
                entered -= 1;
                if (entered === 0) {
                    const waiters = drainWaiters;
                    drainWaiters = [];
                    for (const wake of waiters) {
                        wake();
                    }
                }
            };
        },
    };

    /** Resolves once no entered storage mutation is left. Only call it with `maintenance` set. */
    function drained(): Promise<void> {
        return entered === 0 ? Promise.resolve() : new Promise((resolve) => drainWaiters.push(resolve));
    }

    function assertRunning() {
        if (stopped) {
            throw new MaintenanceError("The server is shutting down");
        }
    }

    return {
        gate,
        list,
        resolve,
        exclusive,

        /**
         * Admits a resource handler or backup operation and starts it: `stop`
         * waits for it. Once the server is shutting down, `start` is never called and
         * `MaintenanceError` is thrown, so no work of a refused operation begins.
         */
        track<T>(start: () => Promise<T>): Promise<T> {
            assertRunning();
            const operation = start();
            active.add(operation);
            operation.then(
                () => active.delete(operation),
                () => active.delete(operation),
            );
            return operation;
        },

        /** Takes a snapshot now (after any running exclusive operation). */
        snapshotNow(): Promise<BackupSnapshotInfo> {
            assertRunning();
            return exclusive(takeLocked);
        },

        /**
         * Registers work `withMaintenance` runs under the lock before it closes mutations: the
         * generation jobs are aborted and end there, so their abort checkpoints still land in the
         * database being replaced (and in the safety snapshot). A listener may return a function,
         * called once the maintenance ends (the jobs reopen admission). Returns the unregister function.
         */
        onMaintenance(listener: () => Promise<(() => void) | void>): () => void {
            maintenanceListeners.add(listener);
            return () => {
                maintenanceListeners.delete(listener);
            };
        },

        /**
         * Runs `fn` under the lock with mutations closed: new ones answer 503, and storage mutations
         * admitted earlier finish before `fn` starts. `fn` gets a snapshot function that is safe to
         * call inside (a safety snapshot before a restore). The `onMaintenance` listeners run first,
         * under the lock, while mutations are still open.
         */
        withMaintenance<T>(fn: (tools: { snapshot(): Promise<BackupSnapshotInfo> }) => Promise<T>): Promise<T> {
            return exclusive(async () => {
                const ends: (() => void)[] = [];
                try {
                    for (const listener of [...maintenanceListeners]) {
                        const end = await listener();
                        if (end) {
                            ends.push(end);
                        }
                    }
                    maintenance = true;
                    await drained();
                    return await fn({ snapshot: takeLocked });
                } finally {
                    maintenance = false;
                    for (const end of ends) {
                        end();
                    }
                }
            });
        },

        /** Starts the periodic snapshot: every interval, when anything was written since the last one. */
        start() {
            if (timer || stopped) {
                return;
            }
            timer = setInterval(tick, intervalMs);
            timer.unref();
        },

        /**
         * Stops the timer, refuses new backup operations, and waits for the admitted ones and every
         * queued exclusive operation to settle. Calling it again returns the same promise.
         */
        stop(): Promise<void> {
            stopping ??= (async () => {
                stopped = true;
                if (timer) {
                    clearInterval(timer);
                    timer = null;
                }
                while (active.size > 0) {
                    await Promise.allSettled([...active]);
                }
                await tail;
            })();
            return stopping;
        },
    };
}
