import {
    forwardedPresetField,
    isModelPresetRootKey,
    missingPresetTarget,
    reconcileSelection,
    settings,
    writePresetField,
    writeSettingsRoot,
} from "./settingsViews.svelte";
import { untrack } from "svelte";
import isEqual from "lodash/isEqual";
import { v4 } from "uuid";
import {
    CREDENTIAL_TYPES,
    type Credential,
    type CredentialType,
    type Database,
    type AuxModelMode,
    type ModelPreset,
    type ModelProfile,
    type ModelSlot,
    type RisuPersona,
} from "../../../shared/database.ts";
import { isRecordId } from "../../../shared/ids.ts";
import { ModuleShapeError, normalizeModule, type RisuModule } from "../../../shared/modules.ts";
import type { RisuPlugin } from "../../../shared/plugins.ts";
import { normalizePersonas, PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import {
    newPersonaId,
    newPresetId,
    normalizeModelPreset,
    normalizeModelProfile,
    MODEL_PROFILE_FIELDS,
    PRESET_DEFAULTS,
    normalizePreset,
    PRESET_FIELD_KINDS,
    PRESET_NULLABLE_FIELDS,
    type PresetField,
} from "../../../shared/presets.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { SECTION_FIELDS } from "../../../shared/sections.ts";
import { valueKindOf } from "../../../shared/valueKinds.ts";
import { definitionNeedsProfile } from "../../../shared/llm/modelSlots.ts";
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
import { deleteEntrySecret } from "./llmSecrets.svelte";

/**
 * The mutations of the settings sections, the small collections, presets, modules, and plugins
 * (Phase 4). The external contracts write these records only through the functions here. Each
 * validates its whole input before the mirror changes (a refusal throws `MutationValidationError`
 * and changes nothing), detaches the caller's data, and writes by id into the settings records
 * (`records.svelte.ts`, Phase 6 slice 4) through their views (`settingsViews.svelte.ts`): a write
 * queues its record's save, and a function that writes several times does so in one `batchRecordWrites` scope, so each
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
    if (isModelPresetRootKey(key)) {
        if (key === "aiModel" || key === "subModel") {
            if (typeof value !== "string") {
                throw new MutationValidationError(key, "expected a model id string");
            }
        } else if (key === "seperateModels") {
            requireObject(key, value);
            requireJsonData(key, value);
        } else {
            checkPresetValue(key, key as PresetField, value);
        }
        return "preset";
    }
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
        throw new MutationValidationError(
            key,
            "the selection is changed through selectPreset, selectModelPreset, or selectPersona",
        );
    }
    throw new MutationValidationError(key, "not a setting");
}

/**
 * Sets settings fields. A key is a field of the `providers`, `ui`, `memoryTranslateMedia`, or
 * `secrets` section (written there), or a forwarded preset field (`FORWARDED_PRESET_KEYS` or
 * `FORWARDED_MODEL_PRESET_KEYS`, by its root name). Prompt fields write their preset; model roots
 * use the slot/profile rules in `writeModelRoot`. The ids in `options` name the captured pair,
 * otherwise the selected pair is used. A caller that captured its presets before an await passes them. Every key is checked
 * first, and the owning preset must exist when a preset field is set (`MutationTargetGoneError`
 * otherwise); nothing is written unless everything passes. `llmSecrets` fields, `proxyKey`, the
 * persona fields, and the selection indexes are refused.
 */
export function updateSettings(
    patch: Record<string, unknown>,
    options: { presetId?: string; modelPresetId?: string } = {},
) {
    requireObject("patch", patch);
    const entries = Object.entries(patch).map(([key, value]) => ({ key, value, target: checkSettingKey(key, value) }));
    const prepared = entries.map((entry) => ({ ...entry, value: detach(entry.value) }));
    const scope = {
        presetId: options.presetId ?? untrack(() => selection.presetId),
        modelPresetId: options.modelPresetId ?? untrack(() => selection.modelPresetId),
    };
    const missing = missingPresetTarget(
        scope,
        entries.filter((entry) => entry.target === "preset").map((entry) => entry.key),
    );
    if (missing !== undefined) {
        throw new MutationTargetGoneError(`${missing} ${missing === "preset" ? scope.presetId : scope.modelPresetId}`);
    }
    batchRecordWrites(() => {
        for (const { key, value, target } of prepared) {
            if (target === "preset") {
                writePresetField(scope, key, value);
            } else {
                writeSettingsRoot(key, value);
            }
        }
    });
}

/** Raises a usage counter (`statics.imports` or `statics.messages`) by one. A whole-record write, not an atomic counter. */
export function incrementStatic(name: "imports" | "messages") {
    const statics = (settings.statics ?? {}) as Record<string, unknown>;
    const current = statics[name];
    settings.statics = {
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
    settings.personas = normalizePersonas(detach(list));
    reconcileSelection();
}

/** Adds a persona under the same contract; an id that is missing, invalid, or taken gets a new one. Returns the id. */
export function addPersona(persona: unknown): string {
    requireObject("persona", persona);
    requireJsonData("persona", persona);
    const [entry] = normalizePersonas([detach(persona)]);
    if ((settings.personas ?? []).some((other) => other?.id === entry.id)) {
        entry.id = newPersonaId();
    }
    settings.personas.push(entry);
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
    const index = (settings.personas ?? []).findIndex((entry) => entry?.id === id);
    if (index === -1) {
        throw new MutationTargetGoneError(`persona ${id}`);
    }
    batchRecordWrites(() => {
        const next = writeEntries(settings.personas[index] as unknown as Record<string, unknown>, prepared);
        if (next) {
            settings.personas[index] = next as unknown as RisuPersona;
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
    return (settings.modules ?? []).find((module) => module?.id === id);
}

/** Replaces the module list (each entry an object; a missing id is assigned). */
export function setModules(list: unknown) {
    requireArray("modules", list);
    settings.modules = Array.from(list, (module, index) => checkedModule(`modules[${index}]`, module));
}

/** Adds a module (a missing id is assigned). Returns the id. */
export function addModule(module: unknown): string {
    const entry = checkedModule("module", module);
    settings.modules ??= [];
    settings.modules.push(entry);
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
    const index = (settings.modules ?? []).findIndex((entry) => entry?.id === id);
    if (index === -1) {
        return false;
    }
    // The patched module is checked on a copy (the shape an added module gets), then the patch goes
    // into the live module in place, so a retained reference to it stays current.
    const copy = detach(settings.modules[index]) as unknown as Record<string, unknown>;
    canonicalModule(`modules[${index}]`, writeEntries(copy, prepared) ?? copy);
    batchRecordWrites(() => {
        const next = writeEntries(settings.modules[index] as unknown as Record<string, unknown>, prepared);
        if (next) {
            settings.modules[index] = next as unknown as RisuModule;
        }
    });
    return true;
}

/** Deletes the module with `id`. Returns `false` when there is none. */
export function removeModule(id: string): boolean {
    const index = (settings.modules ?? []).findIndex((module) => module?.id === id);
    if (index === -1) {
        return false;
    }
    settings.modules.splice(index, 1);
    return true;
}

/** Replaces the list of globally enabled module ids. */
export function setEnabledModules(ids: unknown) {
    requireArray("enabledModules", ids);
    if (!Array.from(ids).every((id) => typeof id === "string")) {
        throw new MutationValidationError("enabledModules", "expected a list of module ids");
    }
    settings.enabledModules = [...new Set(ids as string[])];
}

/** Enables or disables a module globally. */
export function setModuleEnabled(id: string, on: boolean) {
    const ids = new Set(settings.enabledModules ?? []);
    if (on) {
        ids.add(id);
    } else {
        ids.delete(id);
    }
    settings.enabledModules = [...ids];
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
    settings.characterOrder = detach(order) as Database["characterOrder"];
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
    settings.plugins = Array.from(list, (plugin, index) => checkedPlugin(`plugins[${index}]`, plugin));
}

/** Installs a plugin, replacing the installed one with the same name. */
export function upsertPlugin(plugin: unknown) {
    const entry = checkedPlugin("plugin", plugin);
    settings.plugins ??= [];
    const index = settings.plugins.findIndex((other) => other?.name === entry.name);
    if (index === -1) {
        settings.plugins.push(entry);
    } else {
        settings.plugins[index] = entry;
    }
}

/** Sets an argument value of the installed plugin(s) named `pluginName`. Returns `false` when there is none. */
export function setPluginArgument(pluginName: string, key: string, value: unknown): boolean {
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
        throw new MutationValidationError(key, "a plugin argument is a string or a finite number");
    }
    let found = false;
    batchRecordWrites(() => {
        for (const plugin of settings.plugins ?? []) {
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
    const list = detach(settings.authRefreshes ?? []) as Database["authRefreshes"];
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
    settings.authRefreshes = list;
}

/** Adds a prompt preset: the canonical fields (`normalizePreset`) under a fresh id. Returns the id. */
export function addPreset(preset: unknown): string {
    requireObject("preset", preset);
    requireJsonData("preset", preset);
    const id = newPresetId();
    settings.presets.push(normalizePreset(detach(preset), { id }));
    return id;
}

/** Adds a model preset: the canonical fields (`normalizeModelPreset`) under a fresh id. Returns the id. */
export function addModelPreset(preset: unknown): string {
    requireObject("modelPreset", preset);
    requireJsonData("modelPreset", preset);
    const id = newPresetId();
    settings.modelPresets.push(normalizeModelPreset(detach(preset), { id }));
    return id;
}

/** Adds a model profile with schema defaults and a fresh id; any secret fields are dropped. */
export function addModelProfile(profile: unknown): string {
    requireObject("modelProfile", profile);
    requireJsonData("modelProfile", profile);
    const id = newPresetId();
    settings.modelProfiles ??= [];
    settings.modelProfiles.push(normalizeModelProfile(detach(profile), { id }));
    return id;
}

/** Updates profile fields by id; optional fields may be removed, and credential ids may dangle. */
export function updateModelProfile(id: string, patch: Record<string, unknown>): boolean {
    const prepared = detachPatch(patch, (field, value) => {
        if (field !== "name" && !(MODEL_PROFILE_FIELDS as readonly string[]).includes(field)) {
            throw new MutationValidationError(field, "not an editable model profile field");
        }
        if (value === undefined && PRESET_DEFAULTS[field as PresetField] === undefined) {
            return;
        }
        checkPresetValue(field, field as PresetField, value);
    });
    const index = (settings.modelProfiles ?? []).findIndex((profile) => profile.id === id);
    if (index === -1) {
        return false;
    }
    batchRecordWrites(() => {
        const next = writeEntries(settings.modelProfiles[index] as unknown as Record<string, unknown>, prepared);
        if (next) {
            settings.modelProfiles[index] = next as unknown as ModelProfile;
        }
    });
    return true;
}

/** Copies a profile and its named-key binding under a fresh id; no secret is copied. */
export function copyModelProfile(id: string): string | undefined {
    const source = (settings.modelProfiles ?? []).find((profile) => profile.id === id);
    return source ? addModelProfile({ ...detach(source), name: `${source.name} Copy` }) : undefined;
}

/** Removes a profile, leaving every slot dangling. Like model presets, the last record is kept. */
export function deleteModelProfile(id: string): boolean {
    const profiles = settings.modelProfiles;
    const index = profiles?.findIndex((profile) => profile.id === id) ?? -1;
    if (!profiles || index === -1 || profiles.length <= 1) {
        return false;
    }
    profiles.splice(index, 1);
    return true;
}

/** Presets naming a profile, including disabled auxiliary slots; a bare model id is not a reference. */
export function presetsUsingModelProfile(id: string): readonly DeepReadonly<ModelPreset>[] {
    const uses = (slot: ModelSlot | undefined) => slot && "profileId" in slot && slot.profileId === id;
    return (settings.modelPresets ?? []).filter((preset) =>
        [preset.mainSlot, preset.subSlot, ...Object.values(preset.auxSlots ?? {})].some(uses),
    );
}

function setRequiredModelSlot(presetId: string, field: "mainSlot" | "subSlot", profileId: string): boolean {
    if (!isRecordId(profileId)) {
        throw new MutationValidationError(field, "expected a non-empty profile id");
    }
    const preset = (settings.modelPresets ?? []).find((entry) => entry.id === presetId);
    if (!preset) {
        return false;
    }
    if (preset[field]?.profileId !== profileId) {
        preset[field] = { profileId };
    }
    return true;
}

export function setMainModelSlot(presetId: string, profileId: string): boolean {
    return setRequiredModelSlot(presetId, "mainSlot", profileId);
}

export function setSubModelSlot(presetId: string, profileId: string): boolean {
    return setRequiredModelSlot(presetId, "subSlot", profileId);
}

/** Sets an auxiliary profile id, an explicit bare definition, or null to clear; tags are never guessed. */
export function setAuxModelSlot(
    presetId: string,
    mode: AuxModelMode,
    slot: string | { modelId: string } | null,
): boolean {
    if (!["memory", "translate", "emotion", "otherAx"].includes(mode)) {
        throw new MutationValidationError("mode", "not an auxiliary model mode");
    }
    let value: ModelSlot | undefined;
    if (typeof slot === "string" && isRecordId(slot)) {
        value = { profileId: slot };
    } else if (slot !== null) {
        requireObject("slot", slot);
        if (Object.keys(slot).length !== 1 || !isRecordId(slot.modelId)) {
            throw new MutationValidationError("slot", "expected a profile id, a bare { modelId }, or null");
        }
        if (definitionNeedsProfile(slot.modelId)) {
            throw new MutationValidationError("slot", "this model definition requires a profile");
        }
        value = { modelId: slot.modelId };
    }
    const preset = (settings.modelPresets ?? []).find((entry) => entry.id === presetId);
    if (!preset) {
        return false;
    }
    if (value) {
        preset.auxSlots ??= {};
        if (!isEqual(preset.auxSlots[mode], value)) {
            preset.auxSlots[mode] = value;
        }
    } else if (preset.auxSlots?.[mode] !== undefined) {
        delete preset.auxSlots[mode];
    }
    return true;
}

/** Adds named credential metadata under a fresh record id. Set its key separately through `setSecret`. */
export function addCredential(input: unknown): string {
    requireObject("credential", input);
    requireJsonData("credential", input);
    for (const field of Object.keys(input)) {
        if (!["name", "type", "clientEmail", "projectId"].includes(field)) {
            throw new MutationValidationError(field, "not a credential metadata field");
        }
    }
    if (typeof input.name !== "string") {
        throw new MutationValidationError("name", "expected a string");
    }
    if (!(CREDENTIAL_TYPES as readonly unknown[]).includes(input.type)) {
        throw new MutationValidationError("type", "expected a known credential type");
    }
    if (input.type === "vertex") {
        for (const field of ["clientEmail", "projectId"]) {
            if (input[field] !== undefined && typeof input[field] !== "string") {
                throw new MutationValidationError(field, "expected a string");
            }
        }
    }
    const metadata = detach(input);
    const id = newPresetId();
    const entry: Credential =
        metadata.type === "vertex"
            ? {
                  id,
                  name: metadata.name as string,
                  type: "vertex",
                  ...(metadata.clientEmail !== undefined ? { clientEmail: metadata.clientEmail as string } : {}),
                  ...(metadata.projectId !== undefined ? { projectId: metadata.projectId as string } : {}),
              }
            : { id, name: metadata.name as string, type: metadata.type as Exclude<CredentialType, "vertex"> };
    settings.credentials.push(entry);
    return id;
}

/** Updates a credential's metadata (`undefined` removes optional Vertex fields); its type is fixed. */
export function updateCredential(id: string, patch: Record<string, unknown>): boolean {
    requireObject("patch", patch);
    requireJsonData("patch", patch);
    const index = settings.credentials.findIndex((entry) => entry.id === id);
    if (index === -1) {
        return false;
    }
    const record = settings.credentials[index];
    const prepared = detachPatch(patch, (field, value) => {
        if (field === "type") {
            if (value !== record.type) {
                throw new MutationValidationError(field, "a credential's type cannot be changed");
            }
        } else if (field === "name") {
            if (typeof value !== "string") {
                throw new MutationValidationError(field, "expected a string");
            }
        } else if (field === "clientEmail" || field === "projectId") {
            if (record.type !== "vertex") {
                throw new MutationValidationError(field, "only a Vertex credential has this field");
            }
            if (value !== undefined && typeof value !== "string") {
                throw new MutationValidationError(field, "expected a string");
            }
        } else {
            throw new MutationValidationError(field, "not an editable credential metadata field");
        }
    }).filter(([field]) => field !== "type");
    batchRecordWrites(() => {
        const next = writeEntries(record as unknown as Record<string, unknown>, prepared);
        if (next) {
            settings.credentials[index] = next as Credential;
        }
    });
    return true;
}

/** Removes the record and queues its secret cleanup; bindings deliberately remain dangling. */
export function deleteCredential(id: string): boolean {
    const index = settings.credentials.findIndex((entry) => entry.id === id);
    if (index === -1) {
        return false;
    }
    settings.credentials.splice(index, 1);
    deleteEntrySecret("credentials", id);
    return true;
}

function checkCredentialId(credentialId: string | null) {
    if (credentialId !== null && !isRecordId(credentialId)) {
        throw new MutationValidationError("credentialId", "expected a non-empty credential id or null");
    }
}

/** Sets a profile's named-key binding synchronously; null deletes it, and missing keys may be named. */
export function setProfileCredential(profileId: string, credentialId: string | null): boolean {
    checkCredentialId(credentialId);
    const record = (settings.modelProfiles ?? []).find((profile) => profile.id === profileId);
    if (!record) {
        return false;
    }
    if (credentialId === null) {
        delete record.credentialId;
    } else {
        record.credentialId = credentialId;
    }
    return true;
}
