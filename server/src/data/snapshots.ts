import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { BackupSnapshotInfo } from "../../../shared/resources.ts";
import { mkdirDurableSync, syncDir, syncFile, writeFileDurable } from "./durableWrite.ts";
import { ensureFreeSpace, InsufficientStorageError, liveDatabaseBytes, type DiskStatfs } from "../http/diskSpace.ts";
import { ResourceValidationError, type ResourceStore } from "./resourceStore.ts";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_KEEP = 20;
const MAX_PINNED_SNAPSHOTS = 20;
export const MAX_SNAPSHOT_LABEL_LENGTH = 200;
const snapshotNameRegex = /^resources-(\d{8}T\d{9}Z)-[0-9a-f]{8}\.sqlite$/;
type SnapshotMetadata = { pinned: boolean; label: string | null };

export class SnapshotConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SnapshotConflictError";
    }
}

function normalizeLabel(label: string | null): string | null {
    if (label === null) return null;
    const trimmed = label.trim();
    if (trimmed.length > MAX_SNAPSHOT_LABEL_LENGTH) {
        throw new ResourceValidationError(`Snapshot label must be at most ${MAX_SNAPSHOT_LABEL_LENGTH} characters`);
    }
    return trimmed || null;
}

/** Only a missing metadata file is empty: losing unreadable pins would make rotation unsafe. */
function readMetadata(file: string): Map<string, SnapshotMetadata> {
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
        throw new Error(`Cannot read snapshot metadata ${file}`, { cause: error });
    }
    const isObject = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value);
    try {
        const data: unknown = JSON.parse(text);
        if (!isObject(data) || data.version !== 1 || !isObject(data.entries) || Object.keys(data).length !== 2) {
            throw new Error("Expected version 1 and entries");
        }
        const entries = new Map<string, SnapshotMetadata>();
        for (const [id, entry] of Object.entries(data.entries)) {
            if (
                !snapshotNameRegex.test(`${id}.sqlite`) ||
                !isObject(entry) ||
                Object.keys(entry).length !== 2 ||
                typeof entry.pinned !== "boolean" ||
                (entry.label !== null && typeof entry.label !== "string") ||
                (typeof entry.label === "string" &&
                    (entry.label.length > MAX_SNAPSHOT_LABEL_LENGTH ||
                        !entry.label ||
                        entry.label.trim() !== entry.label)) ||
                (!entry.pinned && entry.label === null)
            ) {
                throw new Error(`Invalid entry ${id}`);
            }
            entries.set(id, { pinned: entry.pinned, label: entry.label });
        }
        return entries;
    } catch (error) {
        throw new Error(`Invalid snapshot metadata ${file}: ${String(error)}`, { cause: error });
    }
}

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
 * directory synced; retention keeps the newest `keep` unpinned files plus every pinned file and
 * restore-retained id. Pins (at most 20) and labels live in durable pins.json, outside restores;
 * unreadable metadata refuses startup. Listing prunes missing entries in memory; the next metadata
 * write persists that pruning. Metadata changes and deletions share the lock, and removal listeners
 * run synchronously after unlink. stageCopy links a snapshot for work outside the lock.
 * After the maintenance listeners finish, the gate closes while admitted storage writes drain and
 * the maintenance callback runs; resource mutations then answer 503.
 * Defaults: a ten-minute timer and the newest 20 unpinned snapshots. A periodic tick writes only when the
 * committed store.writeCount changed since the previous periodic snapshot; starting the timer alone
 * takes no initial snapshot. A disk preflight includes main + WAL; a shortage logs once and skips
 * without advancing the write count. Restore retention holds keep their sources listed as asset roots.
 * Manual snapshots run the same disk preflight and propagate a shortage. Safety snapshots skip it;
 * neither manual nor safety snapshots are conditional on the write count.
 */
export function createSnapshotManager(options: {
    store: ResourceStore;
    dir: string;
    intervalMs?: number;
    keep?: number;
    databaseFile?: string;
    statfs?: DiskStatfs;
}) {
    const { store, dir } = options;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const keep = options.keep ?? DEFAULT_KEEP;
    mkdirDurableSync(dir);
    const metadataFile = path.join(dir, "pins.json");
    let metadata = readMetadata(metadataFile);
    let metadataDirty = false;

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
    let shortDiskLogged = false;
    const retained = new Map<string, number>();
    const removalListeners = new Set<(id: string) => void>();

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
                const id = name.slice(0, -".sqlite".length);
                items.push({ id, createdAt: parseStamp(match[1]), size: stat.size, ...metadataFor(id) });
            }
        }
        const present = new Set(items.map((item) => item.id));
        for (const id of metadata.keys()) {
            if (!present.has(id)) {
                metadata.delete(id);
                metadataDirty = true;
            }
        }
        return items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    }

    function metadataFor(id: string): SnapshotMetadata {
        return metadata.get(id) ?? { pinned: false, label: null };
    }

    /** Caller holds exclusive. A failed flush may follow rename, so either state's pins survive. */
    async function writeMetadata(next: Map<string, SnapshotMetadata>): Promise<void> {
        const previous = new Map(metadata);
        const install = (state: Map<string, SnapshotMetadata>, dirty: boolean) => {
            // list() may prune a missing file while the durable write yields; keep that pruning.
            for (const id of previous.keys()) {
                if (!metadata.has(id) && state.delete(id)) dirty = true;
            }
            metadata = state;
            metadataDirty = dirty;
        };
        try {
            await writeFileDurable(metadataFile, JSON.stringify({ version: 1, entries: Object.fromEntries(next) }));
        } catch (error) {
            const conservative = new Map(previous);
            for (const [id, entry] of next) {
                if (entry.pinned) conservative.set(id, { pinned: true, label: previous.get(id)?.label ?? null });
            }
            install(conservative, true);
            throw error;
        }
        install(next, false);
    }

    /** Caller holds exclusive and has checked pins and restore retention. */
    async function unlinkSnapshot(id: string): Promise<void> {
        try {
            await fs.unlink(path.join(dir, `${id}.sqlite`));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
            for (const listener of removalListeners) listener(id);
        } finally {
            await syncDir(dir);
            if (metadata.has(id) || metadataDirty) {
                const next = new Map(metadata);
                next.delete(id);
                await writeMetadata(next);
            }
        }
    }

    function setPinned(
        id: string,
        update: { pinned?: boolean; label?: string | null },
    ): Promise<BackupSnapshotInfo | null> {
        assertRunning();
        return exclusive(async () => {
            const items = list();
            const snapshot = items.find((item) => item.id === id);
            if (!snapshot) return null;
            const pinned = update.pinned ?? snapshot.pinned;
            const label = update.label === undefined ? snapshot.label : normalizeLabel(update.label);
            if (!snapshot.pinned && pinned && items.filter((item) => item.pinned).length >= MAX_PINNED_SNAPSHOTS) {
                throw new SnapshotConflictError(`At most ${MAX_PINNED_SNAPSHOTS} snapshots may be pinned`);
            }
            const next = new Map(metadata);
            if (pinned || label !== null) next.set(id, { pinned, label });
            else next.delete(id);
            await writeMetadata(next);
            return { ...snapshot, pinned, label };
        });
    }

    function remove(id: string): Promise<boolean> {
        assertRunning();
        return exclusive(async () => {
            if (resolve(id) === null) return false;
            if (metadataFor(id).pinned) throw new SnapshotConflictError("Snapshot is pinned; unpin it first");
            if (retained.has(id)) throw new SnapshotConflictError("Snapshot is retained by a restore");
            await unlinkSnapshot(id);
            return true;
        });
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

    /**
     * Stages the listed snapshot `id` at `target` under the lock, so retention cannot take its file from
     * a restore that works outside the lock: a hard link, or a copy across devices or where links are
     * refused (EXDEV or EPERM only). False for any id that is not a listed snapshot; the restore
     * route in `routes/backups.ts` maps that to 404. beforeCopy rechecks remaining disk allocations
     * immediately before a fallback copy. Never call it while holding the lock.
     */
    function stageCopy(
        id: string,
        target: string,
        options: { beforeCopy?: (bytes: number) => Promise<void> } = {},
    ): Promise<boolean> {
        return exclusive(async () => {
            const file = resolve(id);
            if (file === null) {
                return false;
            }
            try {
                await fs.link(file, target);
            } catch (error) {
                const { code } = error as NodeJS.ErrnoException;
                if (code !== "EXDEV" && code !== "EPERM") {
                    throw error;
                }
                await options.beforeCopy?.((await fs.stat(file)).size);
                await fs.copyFile(file, target);
            }
            return true;
        });
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
        for (const old of list()
            .filter((item) => !item.pinned)
            .slice(keep)) {
            if (retained.has(old.id)) continue;
            await unlinkSnapshot(old.id);
        }
        shortDiskLogged = false;
        const size = (await fs.stat(path.join(dir, name))).size;
        const id = name.slice(0, -".sqlite".length);
        return { id, createdAt: now.toISOString(), size, ...metadataFor(id) };
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
            if (options.databaseFile) {
                try {
                    await ensureFreeSpace(dir, await liveDatabaseBytes(dir, options.databaseFile), {
                        statfs: options.statfs,
                    });
                } catch (error) {
                    if (!(error instanceof InsufficientStorageError)) throw error;
                    if (!shortDiskLogged)
                        console.error("[Server] Resource snapshot skipped: insufficient storage", {
                            needed: error.needed,
                            free: error.free,
                        });
                    shortDiskLogged = true;
                    return;
                }
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
        stageCopy,
        setPinned,
        remove,
        /** Synchronous cleanup after unlink, under exclusive; listeners must not take the lock. */
        onRemoved(listener: (id: string) => void): () => void {
            removalListeners.add(listener);
            return () => {
                removalListeners.delete(listener);
            };
        },
        /**
         * Keeps a source listed as an asset root through a restore's staging lifetime. Acquire before
         * stageCopy; release after staging cleanup. Rotation skips held ids; this does not take exclusive.
         */
        retain(id: string): () => void {
            retained.set(id, (retained.get(id) ?? 0) + 1);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                const count = retained.get(id)! - 1;
                if (count) retained.set(id, count);
                else retained.delete(id);
            };
        },
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

        /** Takes an unpinned snapshot after a disk preflight, then durably labels it in the same turn. */
        snapshotNow(snapshotOptions: { label?: string | null } = {}): Promise<BackupSnapshotInfo> {
            assertRunning();
            return exclusive(async () => {
                const label = normalizeLabel(snapshotOptions.label ?? null);
                if (options.databaseFile) {
                    await ensureFreeSpace(dir, await liveDatabaseBytes(dir, options.databaseFile), {
                        statfs: options.statfs,
                    });
                }
                const snapshot = await takeLocked();
                if (label !== null) {
                    const next = new Map(metadata);
                    next.set(snapshot.id, { pinned: false, label });
                    await writeMetadata(next);
                }
                return { ...snapshot, label };
            });
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
