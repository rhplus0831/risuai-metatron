import { DBState } from "../stores.svelte";
import { detach, requireJsonData, requireObject, writeEntries } from "./mutationValidation";
import { markPluginStorageDirty } from "./resourceSync.svelte";

/**
 * The `pluginStorage` mutations (Phase 4). `pluginCustomStorage` holds three things: the custom keys
 * a plugin's `setDatabase` stores at its top level, the v3 `pluginStorage` values under
 * `_pluginStorage`, and the shared `getLocalPluginStorage()` values under `_safeLocalPluginStorage`.
 * Each function checks its value (JSON data), writes the mirror, and marks the record dirty, so the
 * record is saved without a watcher (`PLAN.md` Invariant 2: `pluginStorage` is the collection that
 * switches to explicit mutations). Reads return detached copies. Any string is a valid key: a key
 * that assigning would not store (`__proto__`, or an inherited name such as `constructor`) gets an
 * own property through a rebuilt dictionary (`writeEntries`).
 */

/** Where the v3 `pluginStorage` values live inside `pluginCustomStorage`. */
export const PLUGIN_STORAGE_KEY = "_pluginStorage";
/** Where the `getLocalPluginStorage()` values live inside `pluginCustomStorage`. */
export const SAFE_LOCAL_PLUGIN_STORAGE_KEY = "_safeLocalPluginStorage";

type Dictionary = Record<string, unknown>;

function storage(): Dictionary {
    DBState.db.pluginCustomStorage ??= {};
    return DBState.db.pluginCustomStorage;
}

function dictionary(name: string, create: true): Dictionary;
function dictionary(name: string, create: false): Dictionary | undefined;
function dictionary(name: string, create: boolean): Dictionary | undefined {
    if (create) {
        const root = storage();
        const current = root[name];
        if (typeof current !== "object" || current === null || Array.isArray(current)) {
            root[name] = {};
        }
    }
    const value = DBState.db.pluginCustomStorage?.[name];
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dictionary) : undefined;
}

/** Sets `key` of the dictionary `name` inside `pluginCustomStorage` (created on demand). */
function setEntry(name: string, key: string, value: unknown) {
    const next = writeEntries(dictionary(name, true), [[key, value]]);
    if (next) {
        storage()[name] = next;
    }
    markPluginStorageDirty();
}

function removeEntry(name: string, key: string) {
    const values = dictionary(name, false);
    if (values && Object.hasOwn(values, key)) {
        delete values[key];
        markPluginStorageDirty();
    }
}

function readEntry(name: string, key: string): unknown {
    const values = dictionary(name, false);
    return values && Object.hasOwn(values, key) ? detach(values[key]) : null;
}

/** A v3 `pluginStorage` value (a copy), or `null`. */
export function getPluginStorageValue(key: string): unknown {
    return readEntry(PLUGIN_STORAGE_KEY, key);
}

/** The v3 `pluginStorage` keys, in insertion order. */
export function pluginStorageKeys(): string[] {
    return Object.keys(dictionary(PLUGIN_STORAGE_KEY, false) ?? {});
}

/** Stores a v3 `pluginStorage` value (JSON data). */
export function setPluginStorageItem(key: string, value: unknown) {
    requireJsonData(key, value);
    setEntry(PLUGIN_STORAGE_KEY, key, detach(value));
}

export function removePluginStorageItem(key: string) {
    removeEntry(PLUGIN_STORAGE_KEY, key);
}

export function clearPluginStorage() {
    storage()[PLUGIN_STORAGE_KEY] = {};
    markPluginStorageDirty();
}

/** A `getLocalPluginStorage()` value (a copy), or `null`. */
export function getSafeLocalPluginValue(key: string): unknown {
    return readEntry(SAFE_LOCAL_PLUGIN_STORAGE_KEY, key);
}

/** Whether `getLocalPluginStorage()` holds `key`. */
export function hasSafeLocalPluginValue(key: string): boolean {
    const values = dictionary(SAFE_LOCAL_PLUGIN_STORAGE_KEY, false);
    return values !== undefined && Object.hasOwn(values, key);
}

export function safeLocalPluginKeys(): string[] {
    return Object.keys(dictionary(SAFE_LOCAL_PLUGIN_STORAGE_KEY, false) ?? {});
}

/** Stores a `getLocalPluginStorage()` value (JSON data). */
export function setSafeLocalPluginValue(key: string, value: unknown) {
    requireJsonData(key, value);
    setEntry(SAFE_LOCAL_PLUGIN_STORAGE_KEY, key, detach(value));
}

export function removeSafeLocalPluginValue(key: string) {
    removeEntry(SAFE_LOCAL_PLUGIN_STORAGE_KEY, key);
}

export function clearSafeLocalPluginStorage() {
    storage()[SAFE_LOCAL_PLUGIN_STORAGE_KEY] = {};
    markPluginStorageDirty();
}

/**
 * Stores a custom key at the top level of `pluginCustomStorage` (a key outside `allowedDbKeys` in a
 * plugin's `setDatabase`). `undefined` removes it. As before, any key is accepted, including the
 * names of the two dictionaries above (a plugin can replace them this way).
 */
export function setPluginCustomValue(key: string, value: unknown) {
    requireJsonData(key, value, true);
    if (value === undefined) {
        const current = DBState.db.pluginCustomStorage;
        if (current && Object.hasOwn(current, key)) {
            delete current[key];
            markPluginStorageDirty();
        }
        return;
    }
    const next = writeEntries(storage(), [[key, detach(value)]]);
    if (next) {
        DBState.db.pluginCustomStorage = next;
    }
    markPluginStorageDirty();
}

/** Replaces the whole `pluginCustomStorage` object (the `pluginCustomStorage` key of a plugin's `setDatabase`). */
export function replacePluginCustomStorage(value: unknown) {
    requireObject("pluginCustomStorage", value);
    requireJsonData("pluginCustomStorage", value);
    DBState.db.pluginCustomStorage = detach(value);
    markPluginStorageDirty();
}
