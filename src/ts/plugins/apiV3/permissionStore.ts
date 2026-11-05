import {
    compareRevision,
    type PluginPermissionGrants,
    RESOURCE_KIND,
    type ResourceRecord,
    SINGLETON_RESOURCE_ID,
} from "../../../../shared/resources.ts";
import { getResource, putResource, ResourceConflictError } from "../../storage/resourceClient";

/**
 * v3 plugin permission grants, kept in the server-owned `pluginPermissions` resource. The record is
 * outside the settings records, so no plugin database API, snapshot, or `pluginCustomStorage` write reaches
 * it; only the host's consent flow and the legacy browser-permission import (`browserLocalImport.ts`) call
 * `recordPermissionGrants`. Host resets persist per-plugin counts even without existing grants.
 * Record installs synchronously report removed grant keys and changed reset counts, invalidating
 * cached answers and pending consent across tabs. Queued writes check consent's optional validity
 * predicate before each attempt; renewals never restore keys removed since the call began, while
 * unrelated new grants still merge on conflicts.
 */

type Loaded = { revision: string | null; data: PluginPermissionGrants };

const MAX_ATTEMPTS = 5;

let current: Loaded = { revision: null, data: emptyGrants() };
let queue: Promise<unknown> = Promise.resolve();
type RemovalListener = (keys: ReadonlySet<string>, resetPlugins: ReadonlySet<string>) => void;
const removalListeners = new Set<RemovalListener>();

/** Synchronously reports removed grant keys and plugin names whose persisted reset counts changed. */
export function onPermissionGrantsRemoved(listener: RemovalListener): () => void {
    removalListeners.add(listener);
    return () => {
        removalListeners.delete(listener);
    };
}

/** Installs grants before notifying listeners, including reset counts that appeared or disappeared. */
function installGrants(next: Loaded): void {
    const removed = new Set(Object.keys(current.data.grants).filter((key) => !Object.hasOwn(next.data.grants, key)));
    const resetPlugins = new Set(
        [...new Set([...Object.keys(current.data.resets ?? {}), ...Object.keys(next.data.resets ?? {})])].filter(
            (name) => current.data.resets?.[name] !== next.data.resets?.[name],
        ),
    );
    current = next;
    if (removed.size > 0 || resetPlugins.size > 0) {
        for (const listener of removalListeners) listener(removed, resetPlugins);
    }
}

function emptyGrants(): PluginPermissionGrants {
    return { grants: Object.create(null), lastGrantTime: Object.create(null) };
}

/** Copies grants, finite times and optional finite reset counts into maps safe for names like `__proto__`. */
function copyGrants(source: PluginPermissionGrants | null | undefined): PluginPermissionGrants {
    const copy = emptyGrants();
    for (const [key, value] of Object.entries(source?.grants ?? {})) {
        if (value === true) {
            copy.grants[key] = true;
        }
    }
    for (const [key, value] of Object.entries(source?.lastGrantTime ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) {
            copy.lastGrantTime[key] = value;
        }
    }
    if (source?.resets !== undefined) {
        copy.resets = Object.create(null) as Record<string, number>;
        for (const [name, value] of Object.entries(source.resets)) {
            if (typeof value === "number" && Number.isFinite(value)) {
                copy.resets[name] = value;
            }
        }
    }
    return copy;
}

async function fetchGrants(): Promise<Loaded> {
    const record = await getResource<PluginPermissionGrants>(RESOURCE_KIND.pluginPermissions, SINGLETON_RESOURCE_ID);
    return record
        ? { revision: record.revision, data: copyGrants(record.data) }
        : { revision: null, data: emptyGrants() };
}

/**
 * Initializes grants once from the boot read, before any grant write is queued. This is not a general
 * reset: a grant write already in flight would overwrite the seeded state.
 */
export function seedPluginPermissions(record: ResourceRecord | undefined): void {
    current = record
        ? { revision: record.revision, data: copyGrants(record.data as PluginPermissionGrants) }
        : { revision: null, data: emptyGrants() };
}

/** Reloads grants from the server after the legacy browser-permission migration merges them. */
export async function loadPluginPermissions(): Promise<void> {
    installGrants(await fetchGrants());
}

export function hasPermissionGrant(key: string): boolean {
    return Object.hasOwn(current.data.grants, key);
}

export function getLastGrantTime(key: string): number | undefined {
    return Object.hasOwn(current.data.lastGrantTime, key) ? current.data.lastGrantTime[key] : undefined;
}

/**
 * Adds grants (and the newest periodic grant times) to the server record: read, merge, write; a
 * conflict with another tab re-reads and merges again. Calls run one at a time. The optional
 * `isCurrent` predicate is checked after waiting in the queue and after conflict reads; false
 * resolves without writing. Keys present at call time are renewals: once missing from a merge
 * target, they are dropped from this operation. New keys still merge independently.
 */
export function recordPermissionGrants(
    added: {
        grants?: readonly string[];
        lastGrantTime?: Readonly<Record<string, number>>;
    },
    isCurrent?: () => boolean,
): Promise<void> {
    const pendingGrants = new Set(added.grants ?? []);
    const pendingTimes = new Map(Object.entries(added.lastGrantTime ?? {}));
    const renewingGrants = new Set([...pendingGrants].filter((key) => Object.hasOwn(current.data.grants, key)));
    const renewingTimes = new Set(
        [...pendingTimes.keys()].filter((key) => Object.hasOwn(current.data.lastGrantTime, key)),
    );
    const run = queue.then(async () => {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            if (isCurrent?.() === false) return;
            const next = copyGrants(current.data);
            let changed = false;
            for (const key of pendingGrants) {
                if (renewingGrants.has(key) && !Object.hasOwn(next.grants, key)) {
                    pendingGrants.delete(key);
                    continue;
                }
                if (next.grants[key] !== true) {
                    next.grants[key] = true;
                    changed = true;
                }
            }
            for (const [key, time] of pendingTimes) {
                if (renewingTimes.has(key) && !Object.hasOwn(next.lastGrantTime, key)) {
                    pendingTimes.delete(key);
                    continue;
                }
                if (!(key in next.lastGrantTime) || next.lastGrantTime[key] < time) {
                    next.lastGrantTime[key] = time;
                    changed = true;
                }
            }
            if (!changed) {
                return;
            }
            try {
                const saved = await putResource(
                    RESOURCE_KIND.pluginPermissions,
                    SINGLETON_RESOURCE_ID,
                    next,
                    current.revision,
                );
                installGrants({ revision: saved.revision, data: next });
                return;
            } catch (error) {
                if (!(error instanceof ResourceConflictError)) {
                    throw error;
                }
                installGrants(await fetchGrants());
                if (isCurrent?.() === false) return;
            }
        }
        throw new Error("Could not save the plugin permission grant");
    });
    queue = run.catch(() => {});
    return run;
}

/**
 * Revokes matching grants and times against a fresh server read, including keys learned on a
 * conflict retry. Shares the write queue with consent and live updates. Naming a reset plugin
 * increments its persisted reset count against each attempt's fresh state and always writes,
 * even with no matching keys. Without a reset plugin, empty matches write nothing and reset
 * counts remain untouched.
 */
export function revokePermissionGrants(
    grants: (key: string) => boolean,
    lastGrantTime: (key: string) => boolean,
    resetPlugin?: string,
): Promise<void> {
    const run = queue.then(async () => {
        installGrants(await fetchGrants());
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            const next = copyGrants(current.data);
            let changed = false;
            if (resetPlugin !== undefined) {
                const resets = (next.resets ??= Object.create(null) as Record<string, number>);
                resets[resetPlugin] = (resets[resetPlugin] ?? 0) + 1;
                changed = true;
            }
            for (const key of Object.keys(next.grants)) {
                if (grants(key)) {
                    delete next.grants[key];
                    changed = true;
                }
            }
            for (const key of Object.keys(next.lastGrantTime)) {
                if (lastGrantTime(key)) {
                    delete next.lastGrantTime[key];
                    changed = true;
                }
            }
            if (!changed) return;
            try {
                const saved = await putResource(
                    RESOURCE_KIND.pluginPermissions,
                    SINGLETON_RESOURCE_ID,
                    next,
                    current.revision,
                );
                installGrants({ revision: saved.revision, data: next });
                return;
            } catch (error) {
                if (!(error instanceof ResourceConflictError)) throw error;
                installGrants(await fetchGrants());
            }
        }
        throw new Error("Could not revoke the plugin permission grants");
    });
    queue = run.catch(() => {});
    return run;
}

/**
 * A live update: another tab or device committed the grants at `revision`. Read again unless this
 * tab already holds that revision or a newer one; the read runs in the same queue as
 * grant writes and revocations, and an answer older than what this tab holds by then is not taken.
 */
export function refreshPluginPermissions(revision: string | null): Promise<void> {
    const run = queue.then(async () => {
        if (revision !== null && current.revision !== null && (compareRevision(revision, current.revision) ?? 0) <= 0) {
            return;
        }
        const fetched = await fetchGrants();
        if (
            fetched.revision === null ||
            current.revision === null ||
            (compareRevision(fetched.revision, current.revision) ?? 1) > 0
        ) {
            installGrants(fetched);
        }
    });
    queue = run.catch(() => {});
    return run;
}
