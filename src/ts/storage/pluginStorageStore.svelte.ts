import { untrack } from "svelte";
import { PLUGIN_STORAGE_DICTIONARIES } from "../../../shared/pluginStorage.ts";
import { settings } from "./settingsViews.svelte";
import { detach, MutationValidationError, requireJsonData, requireObject, writeEntries } from "./mutationValidation";
import { batchRecordWrites, pluginStorageRevision } from "./records.svelte";

/**
 * The `pluginStorage` mutations. `pluginCustomStorage` holds shared `setDatabase` custom keys,
 * legacy `_pluginStorage`, owned v3 `_ownedPluginStorage`, and shared `_safeLocalPluginStorage`.
 * Owned data keys are `<plugin name>\u0000<key>`; a separator-free owner key holds `{ legacyHidden: true }`
 * after clear(), leaving the empty user key available. Reads fall through to legacy until clear();
 * writes claim visible legacy keys. Names containing U+0000 use the shared legacy area for every
 * storage call because their owner prefix would be ambiguous. Administrative deletion removes the
 * owner's values and marker; it never claims or deletes legacy keys.
 * Owned writes (`setOwnedPluginStorageItem`) are refused unless the owner is in `settings.plugins`,
 * so a removed plugin still running in another tab cannot restore its deleted data; removal and
 * clear calls stay allowed.
 * Replacing `pluginCustomStorage` through either database setter removes omitted custom keys but
 * keeps reserved names absent as own keys of the input, retaining their stored values unchanged.
 * Supplied reserved names are applied normally, including `undefined` removing the field.
 * This is the runtime mutation boundary; `src/ts/bootstrap.ts:installBootRecords` installs the
 * server's record unchanged before `src/ts/storage/resourceSync.svelte.ts:startResourceSync` marks it.
 * Each function checks its value (JSON data) and queues the record's write once (`records.svelte.ts`);
 * mutations with multiple writes use one `batchRecordWrites` scope. Reads return
 * detached copies and never create the record. Any string is a valid key: a key
 * that assigning would not store (`__proto__`, or an inherited name such as `constructor`) gets an
 * own property through a rebuilt dictionary (`writeEntries`).
 * Owned key enumeration indexes all owners in one pass per record revision, then caches each
 * owner's visible order: owned keys first, followed by unshadowed legacy keys unless hidden.
 * Count and indexed reads reuse that list; key-list reads return a fresh, mutable copy.
 * Array-shaped namespaces: `dictionary`.
 */

/** Where unowned legacy values live inside `pluginCustomStorage`. */
export const PLUGIN_STORAGE_KEY = "_pluginStorage";
export const OWNED_PLUGIN_STORAGE_KEY = "_ownedPluginStorage";
/** Where the `getLocalPluginStorage()` values live inside `pluginCustomStorage`. */
export const SAFE_LOCAL_PLUGIN_STORAGE_KEY = "_safeLocalPluginStorage";

type Dictionary = Record<string, unknown>;

function storage(): Dictionary {
    settings.pluginStorage ??= {};
    return settings.pluginStorage;
}

/**
 * The dictionary `name` inside `pluginCustomStorage`. A plugin can replace it with any JSON value
 * through `setDatabase` (`setPluginCustomValue`): a list is read as the dictionary of its own entries
 * (its indexes), and turned into that dictionary, entries kept, before a write; any other value is
 * no dictionary and is replaced by an empty one on a write.
 */
function dictionary(name: string, create: true): Dictionary;
function dictionary(name: string, create: false): Dictionary | undefined;
function dictionary(name: string, create: boolean): Dictionary | undefined {
    if (create) {
        const root = storage();
        const current = root[name];
        if (Array.isArray(current)) {
            root[name] = Object.fromEntries(Object.entries(current));
        } else if (typeof current !== "object" || current === null) {
            root[name] = {};
        }
    }
    const value = settings.pluginStorage?.[name];
    if (Array.isArray(value)) {
        // Only the create path installs a dictionary; a read sees the list's entries, not its `length`.
        return Object.fromEntries(Object.entries(value));
    }
    return typeof value === "object" && value !== null ? (value as Dictionary) : undefined;
}

/** Sets `key` of the dictionary `name` inside `pluginCustomStorage` (created on demand). */
function setEntry(name: string, key: string, value: unknown) {
    batchRecordWrites(() => {
        const next = writeEntries(dictionary(name, true), [[key, value]]);
        if (next) {
            storage()[name] = next;
        }
    });
}

function removeEntry(name: string, key: string) {
    const values = dictionary(name, false);
    if (values && Object.hasOwn(values, key)) {
        batchRecordWrites(() => {
            delete dictionary(name, true)[key];
        });
    }
}

function readEntry(name: string, key: string): unknown {
    const values = dictionary(name, false);
    return values && Object.hasOwn(values, key) ? detach(values[key]) : null;
}

export type PluginStorageInventoryEntry = { key: string; bytes: number };

/** A size snapshot of the server namespaces. Owned groups include marker-only owners, without exposing markers. */
export function pluginStorageInventory(): {
    custom: PluginStorageInventoryEntry[];
    pluginStorage: PluginStorageInventoryEntry[];
    ownedPluginStorage: Record<string, PluginStorageInventoryEntry[]>;
    safeLocalPluginStorage: PluginStorageInventoryEntry[];
} {
    const encoder = new TextEncoder();
    const entries = (values: Dictionary) =>
        Object.entries(values).map(([key, value]) => ({
            key,
            bytes: encoder.encode(JSON.stringify(value)).byteLength,
        }));
    const custom = Object.fromEntries(
        Object.entries(settings.pluginStorage ?? {}).filter(
            ([key, value]) =>
                !PLUGIN_STORAGE_DICTIONARIES.some((name) => name === key) ||
                typeof value !== "object" ||
                value === null,
        ),
    );
    const owned = new Map<string, PluginStorageInventoryEntry[]>();
    for (const entry of entries(dictionary(OWNED_PLUGIN_STORAGE_KEY, false) ?? {})) {
        const separator = entry.key.indexOf("\u0000");
        const owner = separator === -1 ? entry.key : entry.key.slice(0, separator);
        if (!owned.has(owner)) owned.set(owner, []);
        if (separator !== -1) owned.get(owner)!.push({ ...entry, key: entry.key.slice(separator + 1) });
    }
    return {
        custom: entries(custom),
        pluginStorage: entries(dictionary(PLUGIN_STORAGE_KEY, false) ?? {}),
        ownedPluginStorage: Object.fromEntries(owned),
        safeLocalPluginStorage: entries(dictionary(SAFE_LOCAL_PLUGIN_STORAGE_KEY, false) ?? {}),
    };
}

/** A top-level custom value (a detached copy), or `null`. */
export function getPluginCustomValue(key: string): unknown {
    const values = settings.pluginStorage;
    return values && Object.hasOwn(values, key) ? detach(values[key]) : null;
}

/** A legacy value (a copy), or `null`. */
export function getPluginStorageValue(key: string): unknown {
    return readEntry(PLUGIN_STORAGE_KEY, key);
}

/** The legacy keys, in insertion order. */
export function pluginStorageKeys(): string[] {
    return Object.keys(dictionary(PLUGIN_STORAGE_KEY, false) ?? {});
}

/** Stores a legacy value (JSON data). */
export function setPluginStorageItem(key: string, value: unknown) {
    requireJsonData(key, value);
    setEntry(PLUGIN_STORAGE_KEY, key, detach(value));
}

export function removePluginStorageItem(key: string) {
    removeEntry(PLUGIN_STORAGE_KEY, key);
}

export function clearPluginStorage() {
    batchRecordWrites(() => {
        storage()[PLUGIN_STORAGE_KEY] = {};
    });
}

function legacyHidden(owner: string): boolean {
    const values = dictionary(OWNED_PLUGIN_STORAGE_KEY, false);
    const marker = values && Object.hasOwn(values, owner) ? values[owner] : null;
    return isLegacyHiddenMarker(marker);
}

function isLegacyHiddenMarker(marker: unknown): boolean {
    return typeof marker === "object" && marker !== null && "legacyHidden" in marker && marker.legacyHidden === true;
}

/** Checks owned presence, including a stored null, without reading through to legacy. */
export function hasOwnedPluginStorageItem(owner: string, key: string): boolean {
    if (owner.includes("\u0000")) return false;
    const values = dictionary(OWNED_PLUGIN_STORAGE_KEY, false);
    return values !== undefined && Object.hasOwn(values, `${owner}\u0000${key}`);
}

export function getOwnedPluginStorageValue(owner: string, key: string): unknown {
    if (owner.includes("\u0000")) return getPluginStorageValue(key);
    if (hasOwnedPluginStorageItem(owner, key)) return readEntry(OWNED_PLUGIN_STORAGE_KEY, `${owner}\u0000${key}`);
    return legacyHidden(owner) ? null : getPluginStorageValue(key);
}

let keyIndexRevision = -1;
const ownedKeyIndex = new Map<string, string[]>();
const visibleKeyIndex = new Map<string, readonly string[]>();
const hiddenLegacyOwners = new Set<string>();
let legacyKeyIndex: string[] = [];

/** Reuses the owner's visible order until any write or installation changes the storage record. */
function visibleOwnedPluginStorageKeys(owner: string): readonly string[] {
    const revision = pluginStorageRevision();
    return untrack(() => {
        if (keyIndexRevision !== revision) {
            ownedKeyIndex.clear();
            visibleKeyIndex.clear();
            hiddenLegacyOwners.clear();
            const owned = dictionary(OWNED_PLUGIN_STORAGE_KEY, false);
            for (const key of Object.keys(owned ?? {})) {
                const separator = key.indexOf("\u0000");
                if (separator === -1) {
                    if (isLegacyHiddenMarker(owned![key])) hiddenLegacyOwners.add(key);
                    continue;
                }
                const name = key.slice(0, separator);
                let keys = ownedKeyIndex.get(name);
                if (!keys) ownedKeyIndex.set(name, (keys = []));
                keys.push(key.slice(separator + 1));
            }
            legacyKeyIndex = pluginStorageKeys();
            keyIndexRevision = revision;
        }
        if (owner.includes("\u0000")) return legacyKeyIndex;
        let keys = visibleKeyIndex.get(owner);
        if (!keys) {
            const owned = ownedKeyIndex.get(owner) ?? [];
            keys = hiddenLegacyOwners.has(owner) ? owned : [...new Set([...owned, ...legacyKeyIndex])];
            visibleKeyIndex.set(owner, keys);
        }
        return keys;
    });
}

/** Fresh, mutable copy: owned keys first, then unshadowed visible legacy keys, each in insertion order. */
export function ownedPluginStorageKeys(owner: string): string[] {
    return [...visibleOwnedPluginStorageKeys(owner)];
}

/** Visible key count, reusing the owner's cached order without copying it. */
export function ownedPluginStorageKeyCount(owner: string): number {
    return visibleOwnedPluginStorageKeys(owner).length;
}

/** A visible key at `index`, or null, reusing the owner's cached order without copying it. */
export function ownedPluginStorageKeyAt(owner: string, index: number): string | null {
    return visibleOwnedPluginStorageKeys(owner)[index] ?? null;
}

/** Throws unless `owner` is installed (enabled or disabled), then writes as the owner. */
export function setOwnedPluginStorageItem(owner: string, key: string, value: unknown) {
    if (!(settings.plugins ?? []).some((plugin) => plugin.name === owner)) {
        throw new MutationValidationError(key, `${owner} is not installed`);
    }
    if (owner.includes("\u0000")) return setPluginStorageItem(key, value);
    requireJsonData(key, value);
    const copy = detach(value);
    batchRecordWrites(() => {
        setEntry(OWNED_PLUGIN_STORAGE_KEY, `${owner}\u0000${key}`, copy);
        if (!legacyHidden(owner)) removePluginStorageItem(key);
    });
}

export function removeOwnedPluginStorageItem(owner: string, key: string) {
    if (owner.includes("\u0000")) return removePluginStorageItem(key);
    batchRecordWrites(() => {
        deleteOwnedPluginStorageItem(owner, key);
        if (!legacyHidden(owner)) removePluginStorageItem(key);
    });
}

export function clearOwnedPluginStorage(owner: string) {
    if (owner.includes("\u0000")) return clearPluginStorage();
    batchRecordWrites(() => {
        deleteOwnedPluginStorage(owner);
        setEntry(OWNED_PLUGIN_STORAGE_KEY, owner, { legacyHidden: true });
    });
}

/** Administrative deletion touches only the owned entry, even when a legacy value has the same key. */
export function deleteOwnedPluginStorageItem(owner: string, key: string) {
    if (!owner.includes("\u0000")) removeEntry(OWNED_PLUGIN_STORAGE_KEY, `${owner}\u0000${key}`);
}

/** Removes an owner's data and clear marker, including after uninstall. Shared legacy data stays. */
export function deleteOwnedPluginStorage(owner: string) {
    if (owner.includes("\u0000")) return;
    const prefix = `${owner}\u0000`;
    batchRecordWrites(() => {
        for (const key of Object.keys(dictionary(OWNED_PLUGIN_STORAGE_KEY, false) ?? {})) {
            if (key === owner || key.startsWith(prefix)) removeEntry(OWNED_PLUGIN_STORAGE_KEY, key);
        }
    });
}

/** Moves a legacy entry into an owner, even if that owner has hidden legacy reads. */
export function assignLegacyPluginStorageItem(owner: string, key: string): boolean {
    if (owner.includes("\u0000")) return false;
    const legacy = dictionary(PLUGIN_STORAGE_KEY, false);
    if (!legacy || !Object.hasOwn(legacy, key)) return false;
    requireJsonData(key, legacy[key]);
    const value = detach(legacy[key]);
    batchRecordWrites(() => {
        setEntry(OWNED_PLUGIN_STORAGE_KEY, `${owner}\u0000${key}`, value);
        removePluginStorageItem(key);
    });
    return true;
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
    batchRecordWrites(() => {
        storage()[SAFE_LOCAL_PLUGIN_STORAGE_KEY] = {};
    });
}

/**
 * Stores a custom key at the top level of `pluginCustomStorage` (a key outside `allowedDbKeys` in a
 * plugin's `setDatabase`). `undefined` removes it. As before, any key is accepted, including the
 * reserved dictionary names (a plugin can replace them this way).
 */
export function setPluginCustomValue(key: string, value: unknown) {
    requireJsonData(key, value, true);
    if (value === undefined) {
        const current = settings.pluginStorage;
        if (current && Object.hasOwn(current, key)) {
            delete current[key];
        }
        return;
    }
    batchRecordWrites(() => {
        const next = writeEntries(storage(), [[key, detach(value)]]);
        if (next) {
            settings.pluginStorage = next;
        }
    });
}

/**
 * Replaces the top-level custom keys through a plugin's `setDatabase` or `setDatabaseLite`.
 * Reserved names absent as own keys of `value` keep their stored values unchanged; supplied names
 * are applied normally, including an own `undefined` removing the field.
 */
export function replacePluginCustomStorage(value: unknown) {
    requireObject("pluginCustomStorage", value);
    requireJsonData("pluginCustomStorage", value);
    const next = detach(value);
    const current = settings.pluginStorage;
    for (const name of PLUGIN_STORAGE_DICTIONARIES) {
        if (!Object.hasOwn(value, name) && current && Object.hasOwn(current, name)) {
            // Same-record wrappers unwrap to their existing state, preserving dictionary key order.
            next[name] = current[name];
        }
    }
    settings.pluginStorage = next;
}
