import { newId } from "../../../../shared/ids.ts";
import { ModuleShapeError, normalizeModule } from "../../../../shared/modules.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { COLLECTION_KIND } from "../../../../shared/sections.ts";
import type { UpstreamImportReport } from "../../../../shared/upstreamBackup.ts";
import { isPlainObject } from "../../../../shared/valueKinds.ts";
import type { ColdRecordResult } from "./archive.ts";
import { convertLorebook } from "./importCharacters.ts";
import { kindOf, normalizeRecord, ownCopy, PendingReport, setOwn, storedValue, tryNormalize } from "./importRecords.ts";

/**
 * The upstream collections that name characters or modules, and the module, plugin, and plugin
 * storage records (`docs/plan/upstream-bin-compat.md` S4), for `convertUpstreamDatabase`. Each entry
 * is recovered on its own: one bad entry never costs the others.
 */

/** Where metatron keeps the v3 `pluginStorage` values (`src/ts/storage/pluginStorageStore.svelte.ts`). */
const PLUGIN_STORAGE_KEY = "_pluginStorage";
const SAFE_LOCAL_PLUGIN_STORAGE_KEY = "_safeLocalPluginStorage";
/** Upstream's map of v3 `pluginStorage` keys to cold-storage keys (U `plugins/apiV3/v3.svelte.ts`). */
const COLD_PLUGIN_KEY = "_coldplugin";

function invalidSetting(report: UpstreamImportReport, path: string) {
    const pending = new PendingReport();
    pending.excluded("invalid-setting", path);
    pending.flush(report);
}

/**
 * `characterOrder` with the ids rewritten (`renamed`) and only those of kept characters, at the top
 * level and in each folder's `data`. Folders are kept; another entry is dropped and reported.
 */
export function convertCharacterOrder(
    value: unknown,
    ids: ReadonlySet<string>,
    renamed: ReadonlyMap<string, string>,
    report: UpstreamImportReport,
): unknown {
    const invalid = (path: string) => invalidSetting(report, path);
    if (value === undefined || value === null) {
        return normalizeRecord(COLLECTION_KIND.characterOrder, [], invalid, "characterOrder");
    }
    if (!Array.isArray(value)) {
        invalid("characterOrder");
        return normalizeRecord(COLLECTION_KIND.characterOrder, [], invalid, "characterOrder");
    }
    const resolve = (id: string) => renamed.get(id) ?? id;
    const kind = kindOf(COLLECTION_KIND.characterOrder);
    const entries: unknown[] = [];
    value.forEach((entry, index) => {
        if (typeof entry === "string") {
            const id = resolve(entry);
            if (ids.has(id)) {
                entries.push(id);
            }
            return;
        }
        if (!isPlainObject(entry)) {
            invalid(`characterOrder[${index}]`);
            return;
        }
        const folder = ownCopy(entry);
        if (Array.isArray(folder.data)) {
            folder.data = folder.data.flatMap((member) => {
                const id = typeof member === "string" ? resolve(member) : null;
                return id !== null && ids.has(id) ? [id] : [];
            });
        } else if (folder.data !== undefined) {
            invalid(`characterOrder[${index}].data`);
            folder.data = [];
        }
        const checked = tryNormalize(kind, [folder]);
        if (checked.ok) {
            if (checked.copied) {
                const pending = new PendingReport();
                pending.excluded("invalid-data", `characterOrder[${index}]`);
                pending.flush(report);
            }
            entries.push((checked.data as unknown[])[0]);
        } else {
            invalid(`characterOrder[${index}]`);
        }
    });
    return normalizeRecord(COLLECTION_KIND.characterOrder, entries, invalid, "characterOrder");
}

/**
 * The modules record: each module's lorebook converted (`upgradeLorebook`, which upstream's boot runs
 * on module lorebooks every start), a missing id assigned (`normalizeModule`), and checked as a
 * one-module record; a module that fails is left out (`invalid-module`).
 */
export function convertModules(
    value: unknown,
    report: UpstreamImportReport,
): { list: unknown[]; ids: ReadonlySet<string>; namespaces: ReadonlySet<string> } {
    const list: unknown[] = [];
    const ids = new Set<string>();
    const namespaces = new Set<string>();
    if (value !== undefined && value !== null && !Array.isArray(value)) {
        invalidSetting(report, "modules");
    }
    const kind = kindOf(RESOURCE_KIND.modules);
    (Array.isArray(value) ? value : []).forEach((entry, index) => {
        if (entry === null || entry === undefined) {
            return;
        }
        const pending = new PendingReport();
        const label =
            isPlainObject(entry) && typeof entry.name === "string" && entry.name.trim() !== ""
                ? entry.name
                : `modules[${index}]`;
        if (!isPlainObject(entry)) {
            pending.excluded("invalid-module", label);
            pending.flush(report);
            return;
        }
        const copy = ownCopy(entry);
        if (Array.isArray(copy.lorebook)) {
            copy.lorebook = convertLorebook(copy.lorebook, label, pending);
        }
        let module: Record<string, unknown>;
        try {
            module = normalizeModule(copy, newId) as unknown as Record<string, unknown>;
        } catch (error) {
            if (!(error instanceof ModuleShapeError)) {
                throw error;
            }
            const failed = new PendingReport();
            failed.excluded("invalid-module", label);
            failed.flush(report);
            return;
        }
        const checked = tryNormalize(kind, [module]);
        if (!checked.ok) {
            const failed = new PendingReport();
            failed.excluded("invalid-module", label);
            failed.flush(report);
            return;
        }
        if (checked.copied) {
            pending.excluded("invalid-data", label);
        }
        pending.flush(report);
        const kept = (checked.data as Record<string, unknown>[])[0];
        list.push(kept);
        ids.add(kept.id as string);
        if (typeof kept.namespace === "string" && kept.namespace !== "") {
            namespaces.add(kept.namespace);
        }
    });
    report.counts.modules = list.length;
    return { list, ids, namespaces };
}

/**
 * `enabledModules` without the entries that name no kept module. An entry selects a module by id or
 * by namespace (U `process/modules.ts` `getModules`, as metatron's reader does), so both count.
 */
export function convertEnabledModules(
    value: unknown,
    modules: { ids: ReadonlySet<string>; namespaces: ReadonlySet<string> },
    report: UpstreamImportReport,
): unknown {
    const invalid = (path: string) => invalidSetting(report, path);
    if (value !== undefined && value !== null && !Array.isArray(value)) {
        invalid("enabledModules");
    }
    const pending = new PendingReport();
    const kept: string[] = [];
    (Array.isArray(value) ? value : []).forEach((entry, index) => {
        if (typeof entry === "string" && (modules.ids.has(entry) || modules.namespaces.has(entry))) {
            kept.push(entry);
        } else {
            pending.excluded(
                "module-reference-missing",
                typeof entry === "string" ? entry : `enabledModules[${index}]`,
            );
        }
    });
    pending.flush(report);
    return normalizeRecord(COLLECTION_KIND.enabledModules, kept, invalid, "enabledModules");
}

/**
 * The plugins record: each plugin object kept as stored, a plugin whose API version is not `3.0`
 * reported as kept but not run, and the plugin data upstream keeps outside the file reported once.
 */
export function convertPlugins(value: unknown, report: UpstreamImportReport): unknown[] {
    const pending = new PendingReport();
    if (value !== undefined && value !== null && !Array.isArray(value)) {
        invalidSetting(report, "plugins");
    }
    const kind = kindOf(RESOURCE_KIND.plugins);
    const list: unknown[] = [];
    (Array.isArray(value) ? value : []).forEach((entry, index) => {
        const label =
            isPlainObject(entry) && typeof entry.name === "string" && entry.name !== ""
                ? entry.name
                : `plugins[${index}]`;
        const checked = isPlainObject(entry) ? tryNormalize(kind, [entry]) : { ok: false as const };
        if (!checked.ok) {
            pending.excluded("invalid-plugin", label);
            return;
        }
        if (checked.copied) {
            pending.excluded("invalid-data", label);
        }
        const plugin = (checked.data as Record<string, unknown>[])[0];
        if (plugin.version !== "3.0") {
            pending.excluded("plugin-unsupported-version", label);
        }
        list.push(plugin);
    });
    if (list.length > 0) {
        pending.excluded("plugin-device-storage");
    }
    pending.flush(report);
    report.counts.plugins = list.length;
    return list;
}

/**
 * The `pluginStorage` record (`pluginCustomStorage`), or null when upstream had none. Upstream's v3
 * `pluginStorage` lived at the top level of `pluginCustomStorage` (U `plugins.svelte.ts`
 * `pluginStorage`) until `cad8595a` moved it to cold storage behind `_coldplugin`, next to the
 * `setDatabase` custom keys (U `plugins.svelte.ts` ~681), which the old format does not tell apart;
 * metatron keeps v3 values in `_pluginStorage`. So the top-level values stay where they are (the
 * custom keys' place in metatron too) and, in a file without `_pluginStorage` (one upstream wrote),
 * are also copied into `_pluginStorage` (`legacy-plugin-storage`), and each `_coldplugin` value found in the backup goes into
 * `_pluginStorage`, over a copied one (`cold-plugin-storage-restored`; else `cold-missing`).
 * `_coldplugin` itself is dropped. The top-level `_safeLocalPluginStorage` is not copied into v3
 * storage: it is metatron's reserved SafeLocal key. An array `_pluginStorage` becomes a dictionary
 * via `Object.fromEntries(Object.entries(array))`, as the client reads it. Any other non-dictionary
 * `_pluginStorage` is kept as it is and nothing is folded into it.
 */
export function convertPluginStorage(
    value: unknown,
    cold: ReadonlyMap<string, ColdRecordResult> | undefined,
    report: UpstreamImportReport,
): Record<string, unknown> | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!isPlainObject(value)) {
        invalidSetting(report, "pluginCustomStorage");
        return null;
    }
    const pending = new PendingReport();
    const kind = kindOf(RESOURCE_KIND.pluginStorage);
    const out: Record<string, unknown> = {};
    const hasStorage = Object.hasOwn(value, PLUGIN_STORAGE_KEY);
    const existing = value[PLUGIN_STORAGE_KEY];
    const dictionary = Array.isArray(existing) ? Object.fromEntries(Object.entries(existing)) : existing;
    const foldable = existing === undefined || isPlainObject(dictionary);
    const v3: Record<string, unknown> = {};
    // Each value in its real envelope, so a value past the depth limit costs only itself.
    const keep = (target: Record<string, unknown>, key: string, entry: unknown, path: string) => {
        const envelope = { [key]: entry };
        const stored = storedValue(target === v3 ? { [PLUGIN_STORAGE_KEY]: envelope } : envelope);
        const data = stored.ok ? (stored.value as Record<string, unknown>) : undefined;
        const values = target === v3 ? (data?.[PLUGIN_STORAGE_KEY] as Record<string, unknown> | undefined) : data;
        if (!stored.ok || !values || !Object.hasOwn(values, key)) {
            pending.excluded("invalid-setting", path);
            return false;
        }
        if (stored.copied) {
            pending.excluded("invalid-data", path);
        }
        setOwn(target, key, values[key]);
        return true;
    };
    for (const key of Object.keys(value)) {
        if (key !== COLD_PLUGIN_KEY && (key !== PLUGIN_STORAGE_KEY || !foldable)) {
            keep(out, key, value[key], `pluginCustomStorage.${key}`);
        }
    }
    if (isPlainObject(dictionary)) {
        for (const key of Object.keys(dictionary)) {
            keep(v3, key, dictionary[key], `pluginCustomStorage.${PLUGIN_STORAGE_KEY}.${key}`);
        }
    }
    if (!foldable) {
        pending.excluded("invalid-setting", `pluginCustomStorage.${PLUGIN_STORAGE_KEY}`);
    }
    const legacyKeys = new Set<string>();
    const coldKeys = new Set<string>();
    // Only a file upstream wrote: a metatron backup from before Phase 1 already has `_pluginStorage`,
    // and its top-level keys are `setDatabase` custom keys only.
    if (!hasStorage) {
        for (const key of Object.keys(out)) {
            if (key === PLUGIN_STORAGE_KEY || key === SAFE_LOCAL_PLUGIN_STORAGE_KEY || Object.hasOwn(v3, key)) {
                continue;
            }
            if (keep(v3, key, out[key], `pluginCustomStorage.${PLUGIN_STORAGE_KEY}.${key}`)) {
                legacyKeys.add(key);
            }
        }
    }
    const pointers = value[COLD_PLUGIN_KEY];
    if (isPlainObject(pointers)) {
        for (const key of Object.keys(pointers)) {
            const pointer = pointers[key];
            const result = typeof pointer === "string" ? cold?.get(pointer) : undefined;
            if (!result?.ok || !foldable) {
                pending.excluded("cold-missing", key);
                continue;
            }
            if (keep(v3, key, result.value, `pluginCustomStorage.${COLD_PLUGIN_KEY}.${key}`)) {
                legacyKeys.delete(key);
                coldKeys.add(key);
            }
        }
    } else if (pointers !== undefined && pointers !== null) {
        pending.excluded("invalid-setting", `pluginCustomStorage.${COLD_PLUGIN_KEY}`);
    }
    if (isPlainObject(dictionary) || legacyKeys.size > 0 || coldKeys.size > 0) {
        setOwn(out, PLUGIN_STORAGE_KEY, v3);
    }
    const checked = tryNormalize(kind, out);
    if (!checked.ok) {
        pending.excluded("invalid-setting", "pluginCustomStorage");
        pending.flush(report);
        return null;
    }
    for (const key of legacyKeys) {
        pending.converted("legacy-plugin-storage", key);
    }
    for (const key of coldKeys) {
        pending.converted("cold-plugin-storage-restored", key);
    }
    pending.flush(report);
    return checked.data as Record<string, unknown>;
}
