import {
    compareRevision,
    type PluginPermissionGrants,
    RESOURCE_KIND,
    SINGLETON_RESOURCE_ID,
} from "../../../../shared/resources.ts";
import { getResource, putResource, ResourceConflictError } from "../../storage/resourceClient";

/**
 * v3 plugin permission grants, kept in the server-owned `pluginPermissions` resource. The record is
 * outside the settings records, so no plugin database API, snapshot, or `pluginCustomStorage` write reaches
 * it; only the host's consent flow calls `recordPermissionGrants`. Grants are append-only.
 */

type Loaded = { revision: string | null; data: PluginPermissionGrants };

const MAX_ATTEMPTS = 5;

let current: Loaded = { revision: null, data: emptyGrants() };
let queue: Promise<unknown> = Promise.resolve();

function emptyGrants(): PluginPermissionGrants {
    return { grants: Object.create(null), lastGrantTime: Object.create(null) };
}

/** Copies a record into null-prototype maps, so a plugin name such as `__proto__` stays a plain key. */
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
    return copy;
}

async function fetchGrants(): Promise<Loaded> {
    const record = await getResource<PluginPermissionGrants>(RESOURCE_KIND.pluginPermissions, SINGLETON_RESOURCE_ID);
    return record
        ? { revision: record.revision, data: copyGrants(record.data) }
        : { revision: null, data: emptyGrants() };
}

/** Loads the grants from the server. Call at boot before plugins load. */
export async function loadPluginPermissions(): Promise<void> {
    current = await fetchGrants();
}

export function hasPermissionGrant(key: string): boolean {
    return Object.hasOwn(current.data.grants, key);
}

export function getLastGrantTime(key: string): number | undefined {
    return Object.hasOwn(current.data.lastGrantTime, key) ? current.data.lastGrantTime[key] : undefined;
}

/**
 * Adds grants (and the newest periodic grant times) to the server record: read, merge, write; a
 * conflict with another tab re-reads and merges again. Calls run one at a time.
 */
export function recordPermissionGrants(added: {
    grants?: readonly string[];
    lastGrantTime?: Readonly<Record<string, number>>;
}): Promise<void> {
    const run = queue.then(async () => {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            const next = copyGrants(current.data);
            let changed = false;
            for (const key of added.grants ?? []) {
                if (next.grants[key] !== true) {
                    next.grants[key] = true;
                    changed = true;
                }
            }
            for (const [key, time] of Object.entries(added.lastGrantTime ?? {})) {
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
                current = { revision: saved.revision, data: next };
                return;
            } catch (error) {
                if (!(error instanceof ResourceConflictError)) {
                    throw error;
                }
                current = await fetchGrants();
            }
        }
        throw new Error("Could not save the plugin permission grant");
    });
    queue = run.catch(() => {});
    return run;
}

/**
 * A live update: another tab or device committed the grants at `revision` (Phase 6). Read again
 * unless this tab already holds that revision or a newer one; the read runs in the same queue as
 * `recordPermissionGrants`, and an answer older than what this tab holds by then is not taken.
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
            current = fetched;
        }
    });
    queue = run.catch(() => {});
    return run;
}
