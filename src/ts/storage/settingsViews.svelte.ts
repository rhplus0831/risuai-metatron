import { untrack } from "svelte";
import isEqual from "lodash/isEqual";
import type {
    AuxModelMode,
    botPreset,
    Database,
    ModelPreset,
    ModelProfile,
    ModelSlot,
    RisuPersona,
} from "../../../shared/database.ts";
import {
    definitionNeedsProfile,
    resolveSlotProfile,
    type SlotProfileResolution,
} from "../../../shared/llm/modelSlots.ts";
import type { ModelModeExtended } from "../../../shared/llm/request.ts";
import {
    MODEL_PRESET_FIELDS,
    MODEL_PROFILE_FIELDS,
    MODEL_PROFILE_DEFAULT_NAME,
    PERSONA_ROOT_ALIASES,
    PRESET_ROOT_ALIASES,
    presetFieldValue,
    plainClone,
    PROMPT_PRESET_FIELDS,
    type ModelPresetField,
    type ModelProfileField,
    type PresetField,
    type PromptPresetField,
} from "../../../shared/presets.ts";
import { PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    FORWARDED_MODEL_PRESET_KEYS,
    FORWARDED_PRESET_KEYS,
    MODEL_PROFILE_ROOT_FIELDS,
    modelIdOfSlot,
    modelPresetRootValue,
    SECTION_FIELDS,
    SECTION_KIND,
    type CollectionKind,
    type SectionKind,
    type ModelPresetRootKey,
} from "../../../shared/sections.ts";
import { batchRecordWrites, replaceRecord, trackedRecord, writeRecordField, type RecordKind } from "./records.svelte";
import { selectLoreBookPage, selectModelPreset, selectPersona, selectPreset, selection } from "./selection.svelte";
import { isJsonData } from "./mutationValidation";

/**
 * The settings record views (Phase 6 slice 6): what a settings reader binds to (the whole-database
 * aggregate they replaced is gone since slice 10). They resolve the selected prompt preset, model
 * preset, and persona with the selection functions below:
 *
 * - `settings.<section>.<field>`: a section record's field (`SECTION_FIELDS`); a write is
 *   `writeRecordField` (credentials routed or refused by the records).
 * - `settings.<collection>`: a collection record's wrapper (`undefined` while absent); an assignment
 *   replaces the record. `settings.translatorPresets`/`settings.hypaV3Presets` are `{ items, selectedId }`.
 *   `settings.presets`, `settings.modules`, `settings.plugins`, `settings.pluginStorage` are the
 *   Phase 1 lists.
 * - `activePreset.<field>`: the selected prompt preset under its own field names (`name`, `image`,
 *   `PROMPT_PRESET_FIELDS`: `NAISettings`, `reasonEffort`, `regex`, ...). A read resolves
 *   the selection (the first preset when it names none, which becomes the selection) and gives a
 *   missing value its default as a fresh copy, so a change inside a default object saves nothing
 *   (assign the field whole). A write goes to the preset the selection names now, never redirected:
 *   none, and it is dropped. The views follow the selection; a handler that must keep its record
 *   across an await captures `activePreset.id` (or `currentPresetRecord()`) first.
 * - `activeModelPreset.<field>`: the selected model preset (`name`, `MODEL_PRESET_FIELDS`), likewise
 *   (`docs/plan/split-preset.md`); a handler that must keep it across an await captures
 *   `activeModelPreset.id`.
 * - `activePersona.<field>`: the selected persona, likewise (`name`, `icon`, `note`,
 *   `personaPrompt` with `PERSONA_DEFAULTS`, `largePortrait` as stored).
 *
 * Profile views resolve a slot's profile by id; missing and bare slots serve schema defaults and
 * refuse changed writes. Every getter looks its record up when it runs (nothing is captured), so
 * templates and `$derived` track the record reads; every setter runs untracked. LLM key values stay
 * off these views: an `llmSecrets` credential written to a section field is routed or refused by
 * the records. The auxiliary credentials of the `secrets`
 * section are ordinary readable fields (`settings.secrets.<field>`), bound like any other.
 */

type SectionView<S extends SectionKind> = Pick<Database, (typeof SECTION_FIELDS)[S][number]>;
type SelectableKind = keyof typeof COLLECTION_SELECTION_FIELDS;
type PlainCollectionKind = Exclude<CollectionKind, SelectableKind>;

export type SettingsViews = { [S in SectionKind]: SectionView<S> } & {
    [K in PlainCollectionKind]: Database[(typeof COLLECTION_FIELDS)[K]];
} & {
    [K in SelectableKind]: {
        items: Database[(typeof COLLECTION_FIELDS)[K]];
        selectedId: Database[(typeof COLLECTION_SELECTION_FIELDS)[K]];
    };
} & {
    presets: Database["botPresets"];
    modules: Database["modules"];
    plugins: Database["plugins"];
    pluginStorage: Database["pluginCustomStorage"];
};

export type ActivePresetField = "name" | "image" | PromptPresetField;
export type ActivePreset = Pick<botPreset, ActivePresetField> & { readonly id: string | undefined };
export type ActiveModelPresetField = "name" | ModelPresetField;
export type ActiveModelPreset = Pick<ModelPreset, ActiveModelPresetField> & { readonly id: string | undefined };
export type ModelProfileView = Pick<ModelProfile, "name" | ModelProfileField> & { readonly id: string | undefined };
/** A captured pair of presets (a plugin hook's, a request's): the prompt preset and the model preset. */
export type PresetScope = { readonly presetId: string; readonly modelPresetId: string };
export type ActivePersonaField = "name" | "icon" | "note" | "personaPrompt" | "largePortrait";
export type ActivePersona = Pick<RisuPersona, ActivePersonaField> & { readonly id: string | undefined };

// ---------------------------------------------------------------------------------------------
// The selected prompt preset, model preset, and persona (Phase 3's forwarding rules, over the records)
//
// - Every access resolves the record anew from the current collection (nothing is cached), so a
//   collection replaced by a conflict reload or a splice is honored at once.
// - When the selected id names no record, a read falls back to the first record and makes it the
//   selection (untracked: the read may come from a `$derived`, where a tracked write throws). A
//   write made while the id names no record is dropped, never redirected to another record.
// - Writes resolve untracked: an `$effect` that writes must not rerun, and write again, into the
//   next record when the selection changes.

type PresetRecord = Record<string, unknown> & { id: string };
type ModelPresetRecord = ModelPreset & Record<string, unknown>;
type PersonaRecord = Record<string, unknown> & { id: string };

function presetList(): PresetRecord[] {
    const list = trackedRecord<PresetRecord[]>("presets");
    return Array.isArray(list) ? list : [];
}

function findPreset(id: string): PresetRecord | undefined {
    return presetList().find((preset) => preset?.id === id);
}

/** The selected preset: the one `selection.presetId` names, else the first, which becomes the selection. */
function resolvePreset(): PresetRecord | undefined {
    const record = findPreset(selection.presetId);
    if (record !== undefined) {
        return record;
    }
    const first = presetList()[0];
    if (first === undefined || typeof first?.id !== "string") {
        return undefined;
    }
    untrack(() => selectPreset(first.id));
    return first;
}

function modelPresetList(): ModelPresetRecord[] {
    const list = trackedRecord<ModelPresetRecord[]>("modelPresets");
    return Array.isArray(list) ? list : [];
}

function findModelPreset(id: string): ModelPresetRecord | undefined {
    return modelPresetList().find((preset) => preset?.id === id);
}

function modelProfileList(): ModelProfile[] {
    const list = trackedRecord<ModelProfile[]>("modelProfiles");
    return Array.isArray(list) ? list : [];
}

/** A slot's live profile wrapper; a bare, unset, or dangling slot has no profile. */
export function modelProfileRecordForSlot(slot: ModelSlot | undefined): ModelProfile | undefined {
    return slot && "profileId" in slot
        ? modelProfileList().find((profile) => profile.id === slot.profileId)
        : undefined;
}

/** Shared request routing over the selected or captured model preset; never redirects a captured id. */
export function resolveModelSlot(
    mode: ModelModeExtended,
    scope?: PresetScope,
    staticModel?: string,
): SlotProfileResolution {
    const preset = scope ? findModelPreset(scope.modelPresetId) : resolveModelPreset();
    if (!preset) {
        throw new PresetTargetGoneError("model preset");
    }
    return resolveSlotProfile(preset, modelProfileList(), mode, staticModel);
}

/** The selected model preset: the one `selection.modelPresetId` names, else the first, which becomes the selection. */
function resolveModelPreset(): ModelPresetRecord | undefined {
    const record = findModelPreset(selection.modelPresetId);
    if (record !== undefined) {
        return record;
    }
    const first = modelPresetList()[0];
    if (first === undefined || typeof first?.id !== "string") {
        return undefined;
    }
    untrack(() => selectModelPreset(first.id));
    return first;
}

function personaList(): PersonaRecord[] {
    const list = trackedRecord<PersonaRecord[]>("personas");
    return Array.isArray(list) ? list : [];
}

function findPersona(id: string): PersonaRecord | undefined {
    return personaList().find((persona) => persona?.id === id);
}

/** The selected persona: the one `selection.personaId` names, else the first, which becomes the selection. */
function resolvePersona(): PersonaRecord | undefined {
    const record = findPersona(selection.personaId);
    if (record !== undefined) {
        return record;
    }
    const first = personaList()[0];
    if (first === undefined || typeof first?.id !== "string") {
        return undefined;
    }
    untrack(() => selectPersona(first.id));
    return first;
}

/**
 * The preset a write to the selected preset goes to, without the read fallback: `undefined` when
 * the selection names no record (the write is then dropped, never redirected).
 */
export function presetRecordForWrite(): botPreset | undefined {
    return untrack(() => findPreset(selection.presetId)) as unknown as botPreset | undefined;
}

/** The model preset a write to the selected model preset goes to, without the read fallback. */
export function modelPresetRecordForWrite(): ModelPreset | undefined {
    return untrack(() => findModelPreset(selection.modelPresetId)) as unknown as ModelPreset | undefined;
}

/** The persona a write to the selected persona goes to, without the read fallback. */
export function personaRecordForWrite(): RisuPersona | undefined {
    return untrack(() => findPersona(selection.personaId)) as unknown as RisuPersona | undefined;
}

/**
 * The selected preset's index in the list (the plugin API's and the report's `botPresetsId`): the
 * selection resolved first, 0 when there is none.
 */
export function selectedPresetIndex(): number {
    const record = resolvePreset();
    return record === undefined
        ? 0
        : Math.max(
              0,
              presetList().findIndex((preset) => preset?.id === record.id),
          );
}

/** The selected persona's index in the list (the plugin API's `selectedPersona`), likewise. */
export function selectedPersonaIndex(): number {
    const record = resolvePersona();
    return record === undefined
        ? 0
        : Math.max(
              0,
              personaList().findIndex((persona) => persona?.id === record.id),
          );
}

/** Resolves the selection against the records now, so a write before the first read has a record to go to. */
export function reconcileSelection() {
    untrack(() => {
        resolvePreset();
        resolveModelPreset();
        resolvePersona();
        selectedLoreBookPage();
    });
}

const forwardedPresetKeys = new Set<string>(FORWARDED_PRESET_KEYS);
const modelRootKeys = new Set<string>(FORWARDED_MODEL_PRESET_KEYS);
const profileRootKeys = new Set<string>(MODEL_PROFILE_ROOT_FIELDS);
const auxModes: readonly AuxModelMode[] = ["memory", "translate", "emotion", "otherAx"];
const presetFieldOfRoot: Record<string, string> = PRESET_ROOT_ALIASES;

/** A legacy root derived from model slots or their main profile. */
export function isModelPresetRootKey(rootKey: string): rootKey is ModelPresetRootKey {
    return modelRootKeys.has(rootKey);
}

/** A prompt or model/profile root, including model ids that are no longer stored schema fields. */
export function isForwardedPresetRoot(rootKey: string): boolean {
    return forwardedPresetKeys.has(rootKey) || modelRootKeys.has(rootKey);
}

/**
 * The schema field a forwarded root mirrors, including profile options. Derived model ids and
 * auxiliary model ids have no stored schema field and return undefined.
 */
export function forwardedPresetField(rootKey: string): PresetField | undefined {
    if (profileRootKeys.has(rootKey) || rootKey === "seperateModelsForAxModels") {
        return rootKey as PresetField;
    }
    return forwardedPresetKeys.has(rootKey) ? ((presetFieldOfRoot[rootKey] ?? rootKey) as PresetField) : undefined;
}

function readModelRoot(rootKey: ModelPresetRootKey, scope?: Pick<PresetScope, "modelPresetId">): unknown {
    const preset = scope ? findModelPreset(scope.modelPresetId) : resolveModelPreset();
    return modelPresetRootValue(preset, modelProfileList(), rootKey);
}

function refuseModelRoot(rootKey: string, reason: string): false {
    console.warn(`[Settings] Refused ${rootKey}; the previous value was kept: ${reason}`);
    return false;
}

/**
 * Applies one legacy model-root write (Model Profiles O8), to the selected or captured preset.
 * Same values never re-match a slot. Auxiliary modes may clear or go bare; main/sub require one
 * matching profile. Refusals warn, keep the old value, and return false without throwing, so other
 * keys still apply. A whole `seperateModels` object applies its supplied modes independently.
 */
export function writeModelRoot(
    rootKey: ModelPresetRootKey | `seperateModels.${AuxModelMode}`,
    value: unknown,
    scope?: Pick<PresetScope, "modelPresetId">,
): boolean {
    return untrack(() => {
        if (!modelRootKeys.has(rootKey) && !rootKey.startsWith("seperateModels.")) {
            return refuseModelRoot(rootKey, "not a model root field");
        }
        const preset = findModelPreset(scope?.modelPresetId ?? selection.modelPresetId);
        const profiles = modelProfileList();
        if (rootKey === "seperateModels") {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                return refuseModelRoot(rootKey, "expected an object of auxiliary model ids");
            }
            let accepted = true;
            batchRecordWrites(() => {
                for (const [mode, modelId] of Object.entries(value)) {
                    if (!auxModes.includes(mode as AuxModelMode)) {
                        accepted = refuseModelRoot(`${rootKey}.${mode}`, "not an auxiliary model mode");
                    } else if (!writeModelRoot(`seperateModels.${mode as AuxModelMode}`, modelId, scope)) {
                        accepted = false;
                    }
                }
            });
            return accepted;
        }
        if (rootKey.startsWith("seperateModels.")) {
            const mode = rootKey.slice("seperateModels.".length) as AuxModelMode;
            if (!auxModes.includes(mode)) {
                return refuseModelRoot(rootKey, "not an auxiliary model mode");
            }
            const current = modelIdOfSlot(preset?.auxSlots?.[mode], profiles);
            if (Object.is(value, current)) {
                return true;
            }
            if (typeof value !== "string") {
                return refuseModelRoot(rootKey, "expected a model id string");
            }
            if (!preset) {
                return refuseModelRoot(rootKey, "the model preset no longer exists");
            }
            if (value === "") {
                if (preset.auxSlots?.[mode] !== undefined) {
                    delete preset.auxSlots[mode];
                }
                return true;
            }
            const matches = profiles.filter((profile) => profile.modelId === value);
            if (matches.length === 1) {
                preset.auxSlots ??= {};
                preset.auxSlots[mode] = { profileId: matches[0].id };
                return true;
            }
            if (matches.length === 0) {
                if (definitionNeedsProfile(value)) {
                    return refuseModelRoot(rootKey, "this model definition requires a profile");
                }
                preset.auxSlots ??= {};
                preset.auxSlots[mode] = { modelId: value };
                return true;
            }
            return refuseModelRoot(rootKey, "several profiles use that model id");
        }
        const current = modelPresetRootValue(preset, profiles, rootKey as ModelPresetRootKey);
        if (isEqual(value, current)) {
            return true;
        }
        if (!preset) {
            return refuseModelRoot(rootKey, "the model preset no longer exists");
        }
        if (rootKey === "aiModel" || rootKey === "subModel") {
            if (typeof value !== "string") {
                return refuseModelRoot(rootKey, "expected a model id string");
            }
            const matches = profiles.filter((profile) => profile.modelId === value);
            if (matches.length !== 1) {
                return refuseModelRoot(rootKey, "the model id must name exactly one profile");
            }
            preset[rootKey === "aiModel" ? "mainSlot" : "subSlot"] = { profileId: matches[0].id };
            return true;
        }
        if (rootKey === "seperateModelsForAxModels") {
            if (typeof value !== "boolean") {
                return refuseModelRoot(rootKey, "expected a boolean");
            }
            preset.seperateModelsForAxModels = value;
            return true;
        }
        const profile = modelProfileRecordForSlot(preset.mainSlot);
        if (!profile) {
            return refuseModelRoot(rootKey, "the main model profile no longer exists");
        }
        if (!isJsonData(value, true)) {
            return refuseModelRoot(rootKey, "expected JSON data");
        }
        (profile as unknown as Record<string, unknown>)[rootKey] = plainClone(value);
        return true;
    });
}

function seperateModelsView(scope?: Pick<PresetScope, "modelPresetId">): Database["seperateModels"] {
    const view = {};
    for (const mode of auxModes) {
        defineView(
            view,
            mode,
            () => {
                const preset = scope ? findModelPreset(scope.modelPresetId) : resolveModelPreset();
                return modelIdOfSlot(preset?.auxSlots?.[mode], modelProfileList());
            },
            (value) => writeModelRoot(`seperateModels.${mode}`, value, scope),
        );
    }
    return Object.freeze(view) as Database["seperateModels"];
}

/** Whether a prompt preset with `id` exists (untracked). */
export function hasPreset(id: string): boolean {
    return untrack(() => findPreset(id)) !== undefined;
}

/** Whether a model preset with `id` exists (untracked). */
export function hasModelPreset(id: string): boolean {
    return untrack(() => findModelPreset(id)) !== undefined;
}

/** A forwarded prompt root's record and field (untracked); model/profile roots use the shared derived reader. */
function scopedPresetRecord(
    scope: PresetScope,
    rootKey: string,
): { field: PresetField; record: Record<string, unknown> | undefined } | undefined {
    if (!forwardedPresetKeys.has(rootKey)) {
        return undefined;
    }
    const field = (presetFieldOfRoot[rootKey] ?? rootKey) as PromptPresetField;
    return { field, record: untrack(() => findPreset(scope.presetId)) };
}

/**
 * The first target of `scope` that `rootKeys` need and that no longer exists: `"preset"` (a prompt
 * field's preset) or `"model preset"`, else `undefined`. For a caller that captured its presets (a
 * plugin hook) and refuses rather than redirects.
 */
export function missingPresetTarget(
    scope: PresetScope,
    rootKeys: readonly string[],
): "preset" | "model preset" | undefined {
    for (const rootKey of rootKeys) {
        if (modelRootKeys.has(rootKey)) {
            if (untrack(() => findModelPreset(scope.modelPresetId)) === undefined) {
                return "model preset";
            }
            continue;
        }
        const found = scopedPresetRecord(scope, rootKey);
        if (found !== undefined && found.record === undefined) {
            return "preset";
        }
    }
    return undefined;
}

/**
 * Which record of `scope` no longer exists: `"preset"` (the prompt preset) or `"model preset"`, else
 * `undefined`. For a request that captured its pair and refuses once either is gone, as the server does.
 */
export function missingScopeTarget(scope: PresetScope): "preset" | "model preset" | undefined {
    return untrack(() =>
        findPreset(scope.presetId) === undefined
            ? "preset"
            : findModelPreset(scope.modelPresetId) === undefined
              ? "model preset"
              : undefined,
    );
}

/** A request's captured preset no longer exists; the request is refused rather than redirected to the selection. */
export class PresetTargetGoneError extends Error {
    constructor(target: "preset" | "model preset") {
        super(`The ${target} this request runs with no longer exists`);
        this.name = "PresetTargetGoneError";
    }
}

/**
 * Reads a preset field (by its root name) from the owning preset of `scope`, as the active views read
 * the selected ones (the same fallbacks): for a caller that captured its presets (a plugin hook).
 * `undefined` when the name is not a preset field or its preset is gone.
 */
export function readPresetFieldOf(scope: PresetScope, rootKey: string): unknown {
    if (isModelPresetRootKey(rootKey)) {
        return findModelPreset(scope.modelPresetId) === undefined ? undefined : readModelRoot(rootKey, scope);
    }
    const found = scopedPresetRecord(scope, rootKey);
    return found === undefined || found.record === undefined ? undefined : presetFieldValue(found.record, found.field);
}

/**
 * Writes a preset field (by its root name, `FORWARDED_PRESET_KEYS` or `FORWARDED_MODEL_PRESET_KEYS`)
 * into the owning preset of `scope`, whatever is selected, for a caller that captured its presets
 * (`collectionStore`'s `updateSettings`). Returns `false`, writing nothing, when that preset is gone
 * or the name is not a preset field; never redirects.
 */
export function writePresetField(scope: PresetScope, rootKey: string, value: unknown): boolean {
    if (isModelPresetRootKey(rootKey)) {
        return writeModelRoot(rootKey, value, scope);
    }
    const found = scopedPresetRecord(scope, rootKey);
    if (found === undefined || found.record === undefined) {
        return false;
    }
    found.record[found.field] = value;
    return true;
}

function defineView(target: object, key: string, get: () => unknown, set?: (value: unknown) => void) {
    Object.defineProperty(target, key, {
        enumerable: true,
        configurable: false,
        get,
        set: set
            ? (value: unknown) => {
                  untrack(() => set(value));
              }
            : undefined,
    });
}

function sectionView(section: SectionKind): object {
    const view = {};
    for (const field of SECTION_FIELDS[section] as readonly string[]) {
        defineView(
            view,
            field,
            () => trackedRecord<Record<string, unknown>>(section)?.[field],
            (value) => writeRecordField(section, field, value),
        );
    }
    return Object.freeze(view);
}

function selectableView(kind: SelectableKind): object {
    const view = {};
    for (const field of ["items", "selectedId"]) {
        defineView(
            view,
            field,
            () => trackedRecord<Record<string, unknown>>(kind)?.[field],
            (value) => writeRecordField(kind, field, value),
        );
    }
    return Object.freeze(view);
}

function buildSettings(): SettingsViews {
    const views = {};
    for (const section of Object.values(SECTION_KIND)) {
        const view = sectionView(section);
        defineView(views, section, () => view);
    }
    for (const kind of Object.values(COLLECTION_KIND)) {
        if (Object.hasOwn(COLLECTION_SELECTION_FIELDS, kind)) {
            const view = selectableView(kind as SelectableKind);
            defineView(views, kind, () => view);
        } else {
            defineView(
                views,
                kind,
                () => trackedRecord(kind),
                (value) => replaceRecord(kind, value),
            );
        }
    }
    for (const [name, kind] of [
        ["presets", "presets"],
        ["modules", "modules"],
        ["plugins", "plugins"],
        ["pluginStorage", "pluginStorage"],
    ] as const satisfies readonly (readonly [string, RecordKind])[]) {
        defineView(
            views,
            name,
            () => trackedRecord(kind),
            (value) => replaceRecord(kind, value),
        );
    }
    return Object.freeze(views) as SettingsViews;
}

export const settings: SettingsViews = buildSettings();

/** The fields `activePreset` serves: the prompt preset's `name`, `image`, and `PROMPT_PRESET_FIELDS`. */
export const ACTIVE_PRESET_FIELDS: readonly ActivePresetField[] = ["name", "image", ...PROMPT_PRESET_FIELDS];

/** The fields `activeModelPreset` serves: the model preset's `name` and `MODEL_PRESET_FIELDS`. */
export const ACTIVE_MODEL_PRESET_FIELDS: readonly ActiveModelPresetField[] = ["name", ...MODEL_PRESET_FIELDS];

function buildPresetView<T>(
    fields: readonly PresetField[],
    resolve: () => Record<string, unknown> | undefined,
    forWrite: () => Record<string, unknown> | undefined,
): T {
    const view = {};
    for (const field of fields) {
        defineView(
            view,
            field,
            () => presetFieldValue(resolve(), field),
            (value) => {
                const record = untrack(forWrite);
                if (record !== undefined) {
                    record[field] = value;
                }
            },
        );
    }
    defineView(view, "id", () => resolve()?.id);
    return Object.freeze(view) as T;
}

export const activePreset: ActivePreset = buildPresetView<ActivePreset>(ACTIVE_PRESET_FIELDS, resolvePreset, () =>
    findPreset(selection.presetId),
);

export const activeModelPreset: ActiveModelPreset = buildPresetView<ActiveModelPreset>(
    ACTIVE_MODEL_PRESET_FIELDS,
    resolveModelPreset,
    () => findModelPreset(selection.modelPresetId),
);

/**
 * A live profile view for an explicit slot or a slot getter (the active main/sub views). Its id
 * stays a profile id, and no missing profile is redirected. Defaults are read-only copies until
 * the whole field is assigned; changed writes on a missing or bare slot warn and are dropped.
 */
export function profileForSlot(
    slot: ModelSlot | undefined | (() => ModelSlot | undefined),
    forWrite: () => ModelSlot | undefined = () => (typeof slot === "function" ? slot() : slot),
): ModelProfileView {
    const resolve = () => modelProfileRecordForSlot(typeof slot === "function" ? slot() : slot);
    const view = {};
    for (const field of ["name", ...MODEL_PROFILE_FIELDS] as const) {
        const valueOf = (record: ModelProfile | undefined) =>
            field === "name" && record?.name === undefined
                ? MODEL_PROFILE_DEFAULT_NAME
                : presetFieldValue(record as unknown as Record<string, unknown> | undefined, field);
        defineView(
            view,
            field,
            () => valueOf(resolve()),
            (value) => {
                // Resolve writes before a read can repair the selection; never compare with a fallback profile.
                const record = modelProfileRecordForSlot(forWrite());
                if (isEqual(value, valueOf(record))) {
                    return;
                }
                if (!record) {
                    refuseModelRoot(field, "the model profile no longer exists");
                    return;
                }
                if (!isJsonData(value, true)) {
                    refuseModelRoot(field, "expected JSON data");
                    return;
                }
                (record as unknown as Record<string, unknown>)[field] = plainClone(value);
            },
        );
    }
    defineView(view, "id", () => resolve()?.id);
    return Object.freeze(view) as ModelProfileView;
}

/** The main profile of the selected model preset, with no write fallback when its preset is gone. */
export const activeMainProfile = profileForSlot(
    () => currentModelPresetRecord()?.mainSlot,
    () => modelPresetRecordForWrite()?.mainSlot,
);

/** The sub profile of the selected model preset, likewise. */
export const activeSubProfile = profileForSlot(
    () => currentModelPresetRecord()?.subSlot,
    () => modelPresetRecordForWrite()?.subSlot,
);

function buildActivePersona(): ActivePersona {
    const view = {};
    const fields: readonly ActivePersonaField[] = ["name", "icon", "note", "personaPrompt", "largePortrait"];
    for (const field of fields) {
        defineView(
            view,
            field,
            () => {
                const value = resolvePersona()?.[field];
                if (field in PERSONA_DEFAULTS) {
                    return typeof value === "string" ? value : PERSONA_DEFAULTS[field as keyof typeof PERSONA_DEFAULTS];
                }
                return value;
            },
            (value) => {
                const record = untrack(() => findPersona(selection.personaId));
                if (record !== undefined) {
                    record[field] = value;
                }
            },
        );
    }
    defineView(view, "id", () => resolvePersona()?.id);
    return Object.freeze(view) as ActivePersona;
}

export const activePersona: ActivePersona = buildActivePersona();

/** The selected preset's record (its wrapper), resolved as `activePreset` reads it; `undefined` when there is none. */
export function currentPresetRecord(): botPreset | undefined {
    return resolvePreset() as unknown as botPreset | undefined;
}

/** The selected model preset's record (its wrapper), resolved as `activeModelPreset` reads it. */
export function currentModelPresetRecord(): ModelPreset | undefined {
    return resolveModelPreset() as unknown as ModelPreset | undefined;
}

/** The selected persona's record (its wrapper); `undefined` when there is none. */
export function currentPersonaRecord(): RisuPersona | undefined {
    return resolvePersona() as unknown as RisuPersona | undefined;
}

/**
 * The global lorebook page this client shows: the selection, or 0 when it is past the list's end
 * (then also selected, untracked).
 */
export function selectedLoreBookPage(): number {
    const page = selection.loreBookPage;
    const list = trackedRecord<unknown[]>("loreBook");
    const length = Array.isArray(list) ? list.length : 0;
    if (page < length) {
        return page;
    }
    if (page !== 0) {
        untrack(() => selectLoreBookPage(0));
    }
    return 0;
}

// ---------------------------------------------------------------------------------------------
// Root names (the settings registry's `bindKey`/`bindPath`, a dynamic field name)

/** The prompt preset fields served under root names, excluding its record fields. */
type ForwardedPresetField = PromptPresetField;
type PresetAliasRoot = keyof typeof PRESET_ROOT_ALIASES;
/** Their root names (`FORWARDED_PRESET_KEYS`, which is typed `keyof Database`): the aliases' roots for theirs. */
type ForwardedPresetRootKey =
    | Exclude<ForwardedPresetField, (typeof PRESET_ROOT_ALIASES)[PresetAliasRoot]>
    | {
          [R in PresetAliasRoot]: (typeof PRESET_ROOT_ALIASES)[R] extends ForwardedPresetField ? R : never;
      }[PresetAliasRoot];

/** A root `Database` name a settings view serves (the registry's `bindKey`, `bindPath`'s first segment). */
export type SettingsRootKey =
    | (typeof SECTION_FIELDS)[SectionKind][number]
    | ForwardedPresetRootKey
    | ModelPresetRootKey
    | keyof typeof PERSONA_ROOT_ALIASES
    | (typeof COLLECTION_FIELDS)[CollectionKind]
    | (typeof COLLECTION_SELECTION_FIELDS)[SelectableKind]
    | "botPresets"
    | "modules"
    | "plugins"
    | "pluginCustomStorage";

interface RootRoute {
    target: () => Record<string, unknown>;
    field: string;
}

function buildRootRoutes(): ReadonlyMap<string, RootRoute> {
    const routes = new Map<string, RootRoute>();
    const views = settings as unknown as Record<string, Record<string, unknown>>;
    for (const section of Object.values(SECTION_KIND)) {
        for (const field of SECTION_FIELDS[section] as readonly string[]) {
            routes.set(field, { target: () => views[section], field });
        }
    }
    const presetAliases: Record<string, string> = PRESET_ROOT_ALIASES;
    for (const rootKey of FORWARDED_PRESET_KEYS as readonly string[]) {
        routes.set(rootKey, {
            target: () => activePreset as unknown as Record<string, unknown>,
            field: presetAliases[rootKey] ?? rootKey,
        });
    }
    const modelRoots = {};
    const auxView = seperateModelsView();
    for (const rootKey of FORWARDED_MODEL_PRESET_KEYS) {
        defineView(
            modelRoots,
            rootKey,
            () => (rootKey === "seperateModels" ? auxView : readModelRoot(rootKey)),
            (value) => writeModelRoot(rootKey, value),
        );
        routes.set(rootKey, {
            target: () => modelRoots,
            field: rootKey,
        });
    }
    for (const [rootKey, field] of Object.entries(PERSONA_ROOT_ALIASES)) {
        routes.set(rootKey, { target: () => activePersona as unknown as Record<string, unknown>, field });
    }
    for (const [kind, rootKey] of Object.entries(COLLECTION_FIELDS)) {
        const selectedId = (COLLECTION_SELECTION_FIELDS as Record<string, string>)[kind];
        if (selectedId) {
            routes.set(rootKey, { target: () => views[kind], field: "items" });
            routes.set(selectedId, { target: () => views[kind], field: "selectedId" });
        } else {
            routes.set(rootKey, { target: () => views as unknown as Record<string, unknown>, field: kind });
        }
    }
    for (const [rootKey, name] of [
        ["botPresets", "presets"],
        ["modules", "modules"],
        ["plugins", "plugins"],
        ["pluginCustomStorage", "pluginStorage"],
    ]) {
        routes.set(rootKey, { target: () => views as unknown as Record<string, unknown>, field: name });
    }
    return routes;
}

const rootRoutes = buildRootRoutes();

/**
 * Every root name the views serve (the section fields, both presets' fields under their root names,
 * the persona fields, the collections and the selectable ones' selected ids, the Phase 1 lists):
 * the flat names of the legacy database shape, for a builder of that shape (`snapshots.svelte.ts`).
 */
export const SETTINGS_ROOT_KEYS: readonly string[] = Object.freeze([...rootRoutes.keys()]);

/** Whether `key` is a root name the views serve. */
export function isSettingsRootKey(key: string): key is SettingsRootKey {
    return rootRoutes.has(key);
}

function routeOf(key: string): RootRoute {
    const route = rootRoutes.get(key);
    if (route === undefined) {
        throw new Error(`${key} is not a settings field`);
    }
    return route;
}

/** Reads a root name through its view (a section field, a selected preset's or persona's field, a collection). */
export function readSettingsRoot(key: SettingsRootKey | string): unknown {
    const route = routeOf(key);
    return route.target()[route.field];
}

/**
 * A forwarded preset field (by its root name) as a request sees it: from the owning preset of
 * `scope` (a plugin hook's or request's captured pair) when there is one, else from the selection
 * (`readSettingsRoot`). A captured preset that is gone throws `PresetTargetGoneError`: the request is
 * refused, never redirected to the selection (the server refuses it by its ids alike).
 */
export function scopedPresetRoot(scope: PresetScope | undefined, rootKey: SettingsRootKey): unknown {
    if (scope && isModelPresetRootKey(rootKey)) {
        if (!findModelPreset(scope.modelPresetId)) {
            throw new PresetTargetGoneError("model preset");
        }
        return rootKey === "seperateModels" ? seperateModelsView(scope) : readModelRoot(rootKey, scope);
    }
    const found = scope === undefined ? undefined : scopedPresetRecord(scope, rootKey);
    if (found === undefined) {
        return readSettingsRoot(rootKey);
    }
    if (found.record === undefined) {
        throw new PresetTargetGoneError("preset");
    }
    return presetFieldValue(found.record, found.field);
}

/** Writes a root name through its view, with the view's rules (a dropped preset write, a replaced record). */
export function writeSettingsRoot(key: SettingsRootKey | string, value: unknown) {
    const route = routeOf(key);
    route.target()[route.field] = value;
}
