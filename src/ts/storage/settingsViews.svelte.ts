import { untrack } from "svelte";
import type { botPreset, Database, ModelPreset, RisuPersona } from "../../../shared/database.ts";
import {
    MODEL_PRESET_FIELDS,
    PERSONA_ROOT_ALIASES,
    PRESET_ROOT_ALIASES,
    presetFieldOwner,
    presetFieldValue,
    PROMPT_PRESET_FIELDS,
    type ModelPresetField,
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
    SECTION_FIELDS,
    SECTION_KIND,
    type CollectionKind,
    type SectionKind,
} from "../../../shared/sections.ts";
import { replaceRecord, trackedRecord, writeRecordField, type RecordKind } from "./records.svelte";
import { selectLoreBookPage, selectModelPreset, selectPersona, selectPreset, selection } from "./selection.svelte";

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
 * Every getter looks its record up when it runs (nothing is captured), so templates and `$derived`
 * track the record reads; every setter runs untracked. The LLM credentials stay off these views: a
 * model preset's `proxyKey` is written through `llmSecrets.svelte.ts` (its secret path), and an
 * `llmSecrets` credential written to a section field is routed or refused by the records. The auxiliary credentials of the `secrets`
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
type ModelPresetRecord = Record<string, unknown> & { id: string };
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

const forwardedPresetKeys = new Set<string>([...FORWARDED_PRESET_KEYS, ...FORWARDED_MODEL_PRESET_KEYS]);
const presetFieldOfRoot: Record<string, string> = PRESET_ROOT_ALIASES;

/**
 * The preset field a root name mirrors (`PRESET_ROOT_ALIASES`), of either preset (`presetFieldOwner`
 * says which), or `undefined` for a root name that is not a forwarded preset field.
 */
export function forwardedPresetField(rootKey: string): PresetField | undefined {
    return forwardedPresetKeys.has(rootKey) ? ((presetFieldOfRoot[rootKey] ?? rootKey) as PresetField) : undefined;
}

/** Whether a prompt preset with `id` exists (untracked). */
export function hasPreset(id: string): boolean {
    return untrack(() => findPreset(id)) !== undefined;
}

/** Whether a model preset with `id` exists (untracked). */
export function hasModelPreset(id: string): boolean {
    return untrack(() => findModelPreset(id)) !== undefined;
}

/** The record of `scope` that owns the forwarded root name `rootKey` (untracked), with its field. */
function scopedPresetRecord(
    scope: PresetScope,
    rootKey: string,
): { field: PresetField; record: Record<string, unknown> | undefined } | undefined {
    const field = forwardedPresetField(rootKey);
    if (field === undefined) {
        return undefined;
    }
    const record = untrack(() =>
        presetFieldOwner(field) === "model" ? findModelPreset(scope.modelPresetId) : findPreset(scope.presetId),
    );
    return { field, record };
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
        const found = scopedPresetRecord(scope, rootKey);
        if (found !== undefined && found.record === undefined) {
            return presetFieldOwner(found.field) === "model" ? "model preset" : "preset";
        }
    }
    return undefined;
}

/**
 * Reads a preset field (by its root name) from the owning preset of `scope`, as the active views read
 * the selected ones (the same fallbacks): for a caller that captured its presets (a plugin hook).
 * `undefined` when the name is not a preset field or its preset is gone.
 */
export function readPresetFieldOf(scope: PresetScope, rootKey: string): unknown {
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

/** The preset fields served under root names: every field of either preset but `name` and `image`. */
type ForwardedPresetField = PromptPresetField | ModelPresetField;
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
    for (const rootKey of FORWARDED_MODEL_PRESET_KEYS as readonly string[]) {
        routes.set(rootKey, {
            target: () => activeModelPreset as unknown as Record<string, unknown>,
            field: presetAliases[rootKey] ?? rootKey,
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
 * (`readSettingsRoot`). A captured preset that is gone reads the selection's value; the server
 * refuses such a request by its ids, so the value only steers the tab's own decisions.
 */
export function scopedPresetRoot(scope: PresetScope | undefined, rootKey: SettingsRootKey): unknown {
    if (scope !== undefined) {
        const value = readPresetFieldOf(scope, rootKey);
        if (value !== undefined) {
            return value;
        }
    }
    return readSettingsRoot(rootKey);
}

/** Writes a root name through its view, with the view's rules (a dropped preset write, a replaced record). */
export function writeSettingsRoot(key: SettingsRootKey | string, value: unknown) {
    const route = routeOf(key);
    route.target()[route.field] = value;
}
