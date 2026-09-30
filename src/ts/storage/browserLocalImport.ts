import localforage from "localforage";
import type { Database } from "../../../shared/database.ts";
import { type InlayResource, RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { DBState } from "../stores.svelte";
import {
    hasPermissionGrant,
    getLastGrantTime,
    loadPluginPermissions,
    recordPermissionGrants,
} from "../plugins/apiV3/permissionStore";
import { isJsonValue, SAFE_LOCAL_PLUGIN_STORAGE_KEY, setSafeLocalPluginValue } from "../plugins/pluginSafeClass";
import {
    getInlayMetadata,
    repairInlayMedia,
    setInlayAsset,
    verifyInlay,
    type InlayAsset,
} from "../process/files/inlays";
import { getResource, ResourceEpochMismatchError } from "./resourceClient";
import { flushResources } from "./resourceSync.svelte";

/**
 * Moves user data that older versions kept only in this browser to the server, once per boot:
 * inlays, `SafeLocalPluginStorage` values, v3 plugin permission grants, the Iris dialogue, and the
 * Google search credentials. Per entry: when the server already holds it, the server copy wins;
 * otherwise the entry is written, read back from the server and compared, and only then deleted
 * locally. A local entry is deleted only when it still holds the value that was imported (another
 * tab may have changed it meanwhile). Anything that fails stays in the browser for the next boot.
 * A restore meanwhile (412) stops the import.
 */

const LOCAL_PREFIX = "safe_plugin_";

function store(name: string, storeName: string) {
    return localforage.createInstance({ name, storeName });
}

async function entries(instance: LocalForage): Promise<[string, unknown][]> {
    const list: [string, unknown][] = [];
    await instance.iterate((value, key) => {
        list.push([key, value]);
    });
    return list;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) {
        return false;
    }
    for (let index = 0; index < a.byteLength; index += 1) {
        if (a[index] !== b[index]) {
            return false;
        }
    }
    return true;
}

/** Structural equality of two LocalForage values (a Blob by type and bytes; objects and arrays by content). */
export async function sameLocalValue(a: unknown, b: unknown): Promise<boolean> {
    if (a instanceof Blob || b instanceof Blob) {
        if (!(a instanceof Blob && b instanceof Blob) || a.size !== b.size || a.type !== b.type) {
            return false;
        }
        const [first, second] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
        return sameBytes(new Uint8Array(first), new Uint8Array(second));
    }
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
        if (Array.isArray(a) !== Array.isArray(b)) {
            return false;
        }
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length) {
            return false;
        }
        for (const key of keys) {
            if (
                !Object.hasOwn(b, key) ||
                !(await sameLocalValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
            ) {
                return false;
            }
        }
        return true;
    }
    return Object.is(a, b);
}

/** Deletes a legacy entry only if it still holds the value that was imported; otherwise it stays for the next boot. */
async function removeIfUnchanged(legacy: LocalForage, key: string, imported: unknown) {
    const current = await legacy.getItem(key);
    if (await sameLocalValue(current, imported)) {
        await legacy.removeItem(key);
    } else {
        console.warn(`[Import] ${key} changed in this browser while it was being moved; it stays for the next boot.`);
    }
}

/** The section record that holds each imported field (`SECTION_FIELDS`). */
const importedFieldSection = {
    irisDialogue: RESOURCE_KIND.ui,
    googleSearchCredentials: RESOURCE_KIND.secrets,
} as const;

async function readServerField<K extends keyof typeof importedFieldSection>(field: K): Promise<unknown> {
    const record = await getResource<Partial<Database>>(importedFieldSection[field], SINGLETON_RESOURCE_ID);
    return record?.data?.[field];
}

async function importInlays() {
    const legacy = store("inlay", "inlay");
    for (const [id, value] of await entries(legacy)) {
        const asset = value as InlayAsset | null;
        if (!asset || typeof asset !== "object" || !asset.type) {
            continue;
        }
        const existing = await getInlayMetadata(id);
        if (existing) {
            // The server wins, but only when it really holds the media too; a partially restored
            // archive may have the metadata alone, and then this browser's copy can supply the file.
            if (await verifyInlay(id, existing)) {
                await removeIfUnchanged(legacy, id, value);
            } else if ((await repairInlayMedia(id, asset)) && (await verifyInlay(id, existing))) {
                await removeIfUnchanged(legacy, id, value);
            } else {
                console.warn(`[Import] Inlay ${id} exists on the server without its media; the browser copy is kept.`);
            }
            continue;
        }
        await setInlayAsset(id, asset);
        const written = await getInlayMetadata(id);
        if (written && (await verifyInlay(id, written as InlayResource))) {
            await removeIfUnchanged(legacy, id, value);
        }
    }
}

async function importSafeLocalPluginStorage() {
    const legacy = store("plugin", "plugin");
    const moved: [string, string, unknown][] = [];
    for (const [localKey, value] of await entries(legacy)) {
        if (!localKey.startsWith(LOCAL_PREFIX)) {
            continue;
        }
        const key = localKey.slice(LOCAL_PREFIX.length);
        if (!isJsonValue(value)) {
            console.warn(`[Import] Plugin storage value ${key} is not JSON; it stays in this browser.`);
            continue;
        }
        const target = DBState.db.pluginCustomStorage?.[SAFE_LOCAL_PLUGIN_STORAGE_KEY] as
            Record<string, unknown> | undefined;
        if (!target || !Object.hasOwn(target, key)) {
            setSafeLocalPluginValue(key, JSON.parse(JSON.stringify(value)));
        }
        moved.push([localKey, key, value]);
    }
    if (moved.length === 0) {
        return;
    }
    await flushResources();
    const server = await getResource<Record<string, unknown>>(RESOURCE_KIND.pluginStorage, SINGLETON_RESOURCE_ID);
    const saved = (server?.data?.[SAFE_LOCAL_PLUGIN_STORAGE_KEY] ?? {}) as Record<string, unknown>;
    for (const [localKey, key, value] of moved) {
        // Present on the server (ours, or the server's own value that won) → the local copy can go.
        if (Object.hasOwn(saved, key)) {
            await removeIfUnchanged(legacy, localKey, value);
        }
    }
}

async function importPermissions() {
    const legacy = store("plugin_permissions", "plugin_permissions");
    const list = await entries(legacy);
    if (list.length === 0) {
        return;
    }
    const grants: string[] = [];
    const lastGrantTime: Record<string, number> = {};
    for (const [key, value] of list) {
        if (key.endsWith("_lastGrantTime") && typeof value === "number") {
            lastGrantTime[key] = value;
        } else if (value === true) {
            grants.push(key);
        }
    }
    await recordPermissionGrants({ grants, lastGrantTime });
    await loadPluginPermissions();
    for (const [key, value] of list) {
        const kept =
            key.endsWith("_lastGrantTime") && typeof value === "number"
                ? (getLastGrantTime(key) ?? -Infinity) >= value
                : value === true
                  ? hasPermissionGrant(key)
                  : true;
        if (kept) {
            await removeIfUnchanged(legacy, key, value);
        }
    }
}

async function importSectionField<K extends keyof typeof importedFieldSection>(
    field: K,
    legacy: LocalForage,
    legacyKey: string,
    accept: (value: unknown) => value is NonNullable<Database[K]>,
) {
    const value = await legacy.getItem(legacyKey);
    if (value === null) {
        return;
    }
    if (!accept(value)) {
        return;
    }
    if (DBState.db[field] === undefined) {
        DBState.db[field] = JSON.parse(JSON.stringify(value));
        await flushResources();
    }
    if ((await readServerField(field)) !== undefined) {
        await removeIfUnchanged(legacy, legacyKey, value);
    }
}

function isDialogue(value: unknown): value is NonNullable<Database["irisDialogue"]> {
    return (
        Array.isArray(value) &&
        value.every(
            (line) =>
                line && typeof line === "object" && typeof line.speaker === "string" && typeof line.text === "string",
        )
    );
}

function isGoogleCredentials(value: unknown): value is NonNullable<Database["googleSearchCredentials"]> {
    return (
        !!value &&
        typeof value === "object" &&
        typeof (value as { apiKey?: unknown }).apiKey === "string" &&
        typeof (value as { searchEngineId?: unknown }).searchEngineId === "string"
    );
}

/** Runs every import step; one failing step does not stop the others (except a restore). */
export async function importBrowserLocalData() {
    const steps: [string, () => Promise<void>][] = [
        ["inlays", importInlays],
        ["plugin storage", importSafeLocalPluginStorage],
        ["plugin permissions", importPermissions],
        [
            "Iris dialogue",
            () =>
                importSectionField(
                    "irisDialogue",
                    store("iris_dialogues", "iris_dialogues"),
                    "current_dialogue",
                    isDialogue,
                ),
        ],
        [
            "Google search credentials",
            () =>
                importSectionField(
                    "googleSearchCredentials",
                    store("google-search-credentials", "credentials"),
                    "google-search-creds",
                    isGoogleCredentials,
                ),
        ],
    ];
    for (const [name, step] of steps) {
        try {
            await step();
        } catch (error) {
            if (error instanceof ResourceEpochMismatchError) {
                throw error;
            }
            console.error(`[Import] Moving ${name} to the server failed; it stays in this browser.`, error);
        }
    }
    // Obsolete caches of the removed save codec and the old proxy-auth token copy.
    try {
        await localforage.dropInstance({ name: "risuSaveCache" });
    } catch {}
    try {
        localStorage.removeItem("risuauth");
    } catch {}
}
