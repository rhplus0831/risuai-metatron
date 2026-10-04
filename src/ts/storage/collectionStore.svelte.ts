import { untrack } from "svelte";
import { v4 } from "uuid";
import type { Database, RisuPersona } from "../../../shared/database.ts";
import { ModuleShapeError, normalizeModule, type RisuModule } from "../../../shared/modules.ts";
import type { RisuPlugin } from "../../../shared/plugins.ts";
import { normalizePersonas, PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import {
    newPersonaId,
    newPresetId,
    normalizePreset,
    PRESET_FIELD_KINDS,
    PRESET_NULLABLE_FIELDS,
    type PresetField,
} from "../../../shared/presets.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { SECTION_FIELDS } from "../../../shared/sections.ts";
import { valueKindOf } from "../../../shared/valueKinds.ts";
import { DBState } from "../stores.svelte";
import { forwardedPresetField, hasPreset, reconcileSelection, writePresetField } from "./forwarding.svelte";
import {
    detach,
    MutationTargetGoneError,
    detachPatch,
    MutationValidationError,
    requireArray,
    requireJsonData,
    requireObject,
    writeEntries,
} from "./mutationValidation";
import { batchRecordWrites } from "./records.svelte";
import { selection } from "./selection.svelte";

/**
 * The mutations of the settings sections, the small collections, presets, modules, and plugins
 * (Phase 4). The external contracts write these records only through the functions here. Each
 * validates its whole input before the mirror changes (a refusal throws `MutationValidationError`
 * and changes nothing), detaches the caller's data, and writes by id through `DBState.db`, whose
 * fields are the settings records (`records.svelte.ts`, Phase 6 slice 4): a write queues its record's
 * save, and a function that writes several times does so in one `batchRecordWrites` scope, so each
 * record it changed is queued once. The checks refuse what they can see (JSON data, the kind of a preset field,
 * the shape of a list); the server's normalizers may still rewrite a value that passes (a
 * non-canonical one then stays different in the mirror until reload, as Phase 3 accepted).
 */

const SETTING_SECTIONS = ["providers", "ui", "memoryTranslateMedia", "secrets"] as const;
const sectionKeys = new Set<string>(
    SETTING_SECTIONS.flatMap((section) => SECTION_FIELDS[section] as readonly string[]),
);
const llmSecretKeys = new Set<string>([...(SECTION_FIELDS.llmSecrets as readonly string[]), "proxyKey"]);
const personaKeys = new Set(["username", "userIcon", "userNote", "personaPrompt"]);
const selectionKeys = new Set(["botPresetsId", "selectedPersona", "loreBookPage"]);
const nullablePresetFields = new Set<PresetField>(PRESET_NULLABLE_FIELDS);

function db(): Database & Record<string, unknown> {
    return DBState.db as Database & Record<string, unknown>;
}

function checkPresetValue(key: string, field: PresetField, value: unknown) {
    if (value === undefined) {
        throw new MutationValidationError(key, "a preset field cannot be unset");
    }
    if (value === null) {
        if (!nullablePresetFields.has(field)) {
            throw new MutationValidationError(key, "this preset field cannot be null");
        }
        return;
    }
    requireJsonData(key, value);
    if (valueKindOf(value) !== PRESET_FIELD_KINDS[field]) {
        throw new MutationValidationError(key, `expected a value of kind ${PRESET_FIELD_KINDS[field]}`);
    }
}

function checkSettingKey(key: string, value: unknown): "preset" | "section" {
    const field = forwardedPresetField(key);
    if (field !== undefined) {
        checkPresetValue(key, field, value);
        return "preset";
    }
    if (sectionKeys.has(key)) {
        if (value === null || value === undefined) {
            throw new MutationValidationError(key, "this setting cannot be cleared");
        }
        requireJsonData(key, value);
        return "section";
    }
    if (llmSecretKeys.has(key)) {
        throw new MutationValidationError(key, "LLM credentials are not written through updateSettings");
    }
    if (personaKeys.has(key)) {
        throw new MutationValidationError(key, "a persona field is written through updatePersona");
    }
    if (selectionKeys.has(key)) {
        throw new MutationValidationError(key, "the selection is changed through selectPreset or selectPersona");
    }
    throw new MutationValidationError(key, "not a setting");
}

/**
 * Sets settings fields. A key is a field of the `providers`, `ui`, `memoryTranslateMedia`, or
 * `secrets` section (written there), or a forwarded preset field (`FORWARDED_PRESET_KEYS`, by its
 * root name), written into the preset `options.presetId` names, else the selected one: a caller
 * that captured its preset before an await passes it. Every key is checked first, and the preset
 * must exist when a preset field is set (`MutationTargetGoneError` otherwise); nothing is written
 * unless everything passes. `llmSecrets` fields, `proxyKey`, the persona fields, and the selection
 * indexes are refused.
 */
export function updateSettings(patch: Record<string, unknown>, options: { presetId?: string } = {}) {
    requireObject("patch", patch);
    const entries = Object.entries(patch).map(([key, value]) => ({ key, value, target: checkSettingKey(key, value) }));
    const prepared = entries.map((entry) => ({ ...entry, value: detach(entry.value) }));
    const presetId = options.presetId ?? untrack(() => selection.presetId);
    if (entries.some((entry) => entry.target === "preset") && !hasPreset(DBState.db, presetId)) {
        throw new MutationTargetGoneError(`preset ${presetId}`);
    }
    batchRecordWrites(() => {
        for (const { key, value, target } of prepared) {
            if (target === "preset") {
                writePresetField(DBState.db, presetId, key, value);
            } else {
                db()[key] = value;
            }
        }
    });
}

/** Raises a usage counter (`statics.imports` or `statics.messages`) by one. A whole-record write, not an atomic counter. */
export function incrementStatic(name: "imports" | "messages") {
    const statics = (DBState.db.statics ?? {}) as Record<string, unknown>;
    const current = statics[name];
    DBState.db.statics = {
        ...(detach(statics) as Database["statics"]),
        [name]: (typeof current === "number" && Number.isFinite(current) ? current : 0) + 1,
    };
}

/**
 * Replaces the persona list. It gets the collection's contract (`shared/personas.ts`, which the
 * server applies too): never empty, the four persona fields strings, unique ids (existing ones
 * kept). The selection is then resolved against the new list.
 */
export function setPersonas(list: unknown) {
    requireArray("personas", list);
    requireJsonData("personas", list);
    DBState.db.personas = normalizePersonas(detach(list));
    reconcileSelection(DBState.db);
}

/** Adds a persona under the same contract; an id that is missing, invalid, or taken gets a new one. Returns the id. */
export function addPersona(persona: unknown): string {
    requireObject("persona", persona);
    requireJsonData("persona", persona);
    const [entry] = normalizePersonas([detach(persona)]);
    if ((DBState.db.personas ?? []).some((other) => other?.id === entry.id)) {
        entry.id = newPersonaId();
    }
    DBState.db.personas.push(entry);
    return entry.id;
}

/** Sets fields of the persona with `id` (not the id itself). Throws `MutationTargetGoneError` when it does not exist. */
export function updatePersona(id: string, patch: Record<string, unknown>) {
    const prepared = detachPatch(patch, (field, value) => {
        if (field === "id") {
            throw new MutationValidationError(field, "a persona's id cannot be changed");
        }
        if (Object.hasOwn(PERSONA_DEFAULTS, field) && typeof value !== "string") {
            throw new MutationValidationError(field, "expected a string");
        }
    });
    const index = (DBState.db.personas ?? []).findIndex((entry) => entry?.id === id);
    if (index === -1) {
        throw new MutationTargetGoneError(`persona ${id}`);
    }
    batchRecordWrites(() => {
        const next = writeEntries(DBState.db.personas[index] as unknown as Record<string, unknown>, prepared);
        if (next) {
            DBState.db.personas[index] = next as unknown as RisuPersona;
        }
    });
}

/** A module in its canonical form (`normalizeModule`), as `MutationValidationError` when malformed. */
function canonicalModule(key: string, module: unknown, newId?: () => string): RisuModule {
    try {
        return normalizeModule(module, newId);
    } catch (error) {
        if (error instanceof ModuleShapeError) {
            throw new MutationValidationError(key, error.message);
        }
        throw error;
    }
}

/** A detached, checked module in its canonical form; a missing or empty id is assigned. */
function checkedModule(key: string, module: unknown): RisuModule {
    requireObject(key, module);
    requireJsonData(key, module);
    return canonicalModule(key, detach(module), v4);
}

/** The mirror record of a module, typed read-only: change it through `updateModule`. */
export function findModule(id: string): DeepReadonly<RisuModule> | undefined {
    return (DBState.db.modules ?? []).find((module) => module?.id === id);
}

/** Replaces the module list (each entry an object; a missing id is assigned). */
export function setModules(list: unknown) {
    requireArray("modules", list);
    DBState.db.modules = Array.from(list, (module, index) => checkedModule(`modules[${index}]`, module));
}

/** Adds a module (a missing id is assigned). Returns the id. */
export function addModule(module: unknown): string {
    const entry = checkedModule("module", module);
    DBState.db.modules ??= [];
    DBState.db.modules.push(entry);
    return entry.id;
}

/**
 * Sets fields of the module with `id` (`undefined` removes one; the id cannot change). Returns
 * `false`, changing nothing, when no module has that id.
 */
export function updateModule(id: string, patch: Record<string, unknown>): boolean {
    const prepared = detachPatch(patch, (field) => {
        if (field === "id") {
            throw new MutationValidationError(field, "a module's id cannot be changed");
        }
    });
    const index = (DBState.db.modules ?? []).findIndex((entry) => entry?.id === id);
    if (index === -1) {
        return false;
    }
    // The patched module is checked on a copy (the shape an added module gets), then the patch goes
    // into the live module in place, so a retained reference to it stays current.
    const copy = detach(DBState.db.modules[index]) as unknown as Record<string, unknown>;
    canonicalModule(`modules[${index}]`, writeEntries(copy, prepared) ?? copy);
    batchRecordWrites(() => {
        const next = writeEntries(DBState.db.modules[index] as unknown as Record<string, unknown>, prepared);
        if (next) {
            DBState.db.modules[index] = next as unknown as RisuModule;
        }
    });
    return true;
}

/** Deletes the module with `id`. Returns `false` when there is none. */
export function removeModule(id: string): boolean {
    const index = (DBState.db.modules ?? []).findIndex((module) => module?.id === id);
    if (index === -1) {
        return false;
    }
    DBState.db.modules.splice(index, 1);
    return true;
}

/** Replaces the list of globally enabled module ids. */
export function setEnabledModules(ids: unknown) {
    requireArray("enabledModules", ids);
    if (!Array.from(ids).every((id) => typeof id === "string")) {
        throw new MutationValidationError("enabledModules", "expected a list of module ids");
    }
    DBState.db.enabledModules = [...new Set(ids as string[])];
}

/** Enables or disables a module globally. */
export function setModuleEnabled(id: string, on: boolean) {
    const ids = new Set(DBState.db.enabledModules ?? []);
    if (on) {
        ids.add(id);
    } else {
        ids.delete(id);
    }
    DBState.db.enabledModules = [...ids];
}

/** Replaces the character order (character ids and folders). */
export function setCharacterOrder(order: unknown) {
    requireArray("characterOrder", order);
    requireJsonData("characterOrder", order);
    // Stricter than the server (which takes any object as a folder): a folder needs its member list,
    // which the order repair (`checkCharOrder`) walks.
    const valid = Array.from(order).every(
        (entry) =>
            typeof entry === "string" ||
            (typeof entry === "object" &&
                entry !== null &&
                !Array.isArray(entry) &&
                Array.isArray((entry as { data?: unknown }).data) &&
                ((entry as { data: unknown[] }).data as unknown[]).every((id) => typeof id === "string")),
    );
    if (!valid) {
        throw new MutationValidationError("characterOrder", "expected character ids and folders with member lists");
    }
    DBState.db.characterOrder = detach(order) as Database["characterOrder"];
}

/** Checks a plugin a contract hands in, without changing it: an object of JSON data with a name. For a caller's preflight of a list. */
export function checkPluginInput(plugin: unknown, key = "plugin"): asserts plugin is Record<string, unknown> {
    requireObject(key, plugin);
    requireJsonData(key, plugin);
    if (typeof plugin.name !== "string" || plugin.name === "") {
        throw new MutationValidationError(key, "a plugin needs a name");
    }
}

function checkedPlugin(key: string, plugin: unknown): RisuPlugin {
    checkPluginInput(plugin, key);
    return detach(plugin) as unknown as RisuPlugin;
}

/** Replaces the installed plugin list (each entry an object with a name). */
export function setPlugins(list: unknown) {
    requireArray("plugins", list);
    DBState.db.plugins = Array.from(list, (plugin, index) => checkedPlugin(`plugins[${index}]`, plugin));
}

/** Installs a plugin, replacing the installed one with the same name. */
export function upsertPlugin(plugin: unknown) {
    const entry = checkedPlugin("plugin", plugin);
    DBState.db.plugins ??= [];
    const index = DBState.db.plugins.findIndex((other) => other?.name === entry.name);
    if (index === -1) {
        DBState.db.plugins.push(entry);
    } else {
        DBState.db.plugins[index] = entry;
    }
}

/** Sets an argument value of the installed plugin(s) named `pluginName`. Returns `false` when there is none. */
export function setPluginArgument(pluginName: string, key: string, value: unknown): boolean {
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
        throw new MutationValidationError(key, "a plugin argument is a string or a finite number");
    }
    let found = false;
    batchRecordWrites(() => {
        for (const plugin of DBState.db.plugins ?? []) {
            if (plugin?.name === pluginName) {
                plugin.realArg ??= {};
                const next = writeEntries(plugin.realArg, [[key, value]]);
                if (next) {
                    plugin.realArg = next as RisuPlugin["realArg"];
                }
                found = true;
            }
        }
    });
    return found;
}

/** Stores an MCP server's OAuth refresh entry: the server's own entry is replaced (one per `url`). */
export function addAuthRefresh(entry: unknown) {
    requireObject("authRefresh", entry);
    requireJsonData("authRefresh", entry);
    for (const field of ["url", "tokenUrl", "refreshToken", "clientId", "clientSecret"]) {
        if (entry[field] !== undefined && typeof entry[field] !== "string") {
            throw new MutationValidationError(`authRefresh.${field}`, "expected a string");
        }
    }
    const next = detach(entry) as unknown as Database["authRefreshes"][number];
    // One entry per server: a new login replaces the server's entry (every one with its URL). Built
    // on a copy and installed once.
    const list = detach(DBState.db.authRefreshes ?? []) as Database["authRefreshes"];
    const first = list.findIndex((refresh) => refresh?.url === next.url);
    if (typeof next.url !== "string" || first === -1) {
        list.push(next);
    } else {
        list[first] = next;
        for (let index = list.length - 1; index > first; index--) {
            if (list[index]?.url === next.url) {
                list.splice(index, 1);
            }
        }
    }
    DBState.db.authRefreshes = list;
}

/** Adds a preset: the canonical fields (`normalizePreset`) under a fresh id. Returns the id. */
export function addPreset(preset: unknown): string {
    requireObject("preset", preset);
    requireJsonData("preset", preset);
    const id = newPresetId();
    DBState.db.botPresets.push(normalizePreset(detach(preset), { id }));
    return id;
}
