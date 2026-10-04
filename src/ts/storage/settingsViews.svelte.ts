import { untrack } from "svelte";
import type { botPreset, Database, RisuPersona } from "../../../shared/database.ts";
import {
    PERSONA_ROOT_ALIASES,
    PRESET_FIELDS,
    PRESET_KEEP_ON_SWITCH_FIELDS,
    PRESET_ROOT_ALIASES,
    presetFieldValue,
    type PresetField,
} from "../../../shared/presets.ts";
import { PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    FORWARDED_PRESET_KEYS,
    SECTION_FIELDS,
    SECTION_KIND,
    type CollectionKind,
    type SectionKind,
} from "../../../shared/sections.ts";
import { selectedPersona, selectedPersonaForWrite, selectedPreset, selectedPresetForWrite } from "./forwarding.svelte";
import { replaceRecord, trackedRecord, writeRecordField, type RecordKind } from "./records.svelte";
import { selectLoreBookPage, selection } from "./selection.svelte";

/**
 * The settings record views (Phase 6 slice 6): what a settings reader binds to instead of the
 * `DBState.db` aggregate. They serve the same records with the same rules as the facade's accessors
 * (`forwarding.svelte.ts`), and resolve the selected preset and persona with the same functions:
 *
 * - `settings.<section>.<field>`: a section record's field (`SECTION_FIELDS`); a write is
 *   `writeRecordField` (credentials routed or refused by the records).
 * - `settings.<collection>`: a collection record's wrapper (`undefined` while absent); an assignment
 *   replaces the record. `settings.translatorPresets`/`settings.hypaV3Presets` are `{ items, selectedId }`.
 *   `settings.presets`, `settings.modules`, `settings.plugins`, `settings.pluginStorage` are the
 *   Phase 1 lists.
 * - `activePreset.<field>`: the selected preset under its own field names (`NAISettings`,
 *   `reasonEffort`, `regex`, ...; the keep-on-switch group is `settings.providers`). A read resolves
 *   the selection (the first preset when it names none, which becomes the selection) and gives a
 *   missing value its default as a fresh copy, so a change inside a default object saves nothing
 *   (assign the field whole). A write goes to the preset the selection names now, never redirected:
 *   none, and it is dropped. The views follow the selection; a handler that must keep its record
 *   across an await captures `activePreset.id` (or `currentPresetRecord()`) first.
 * - `activePersona.<field>`: the selected persona, likewise (`name`, `icon`, `note`,
 *   `personaPrompt` with `PERSONA_DEFAULTS`, `largePortrait` as stored).
 *
 * Every getter looks its record up when it runs (nothing is captured), so templates and `$derived`
 * track the record reads; every setter runs untracked. The LLM credentials stay off these views: a
 * preset's `proxyKey` is the facade's (`SecretInput` edits it), and an `llmSecrets` credential written
 * to a section field is routed or refused by the records. The auxiliary credentials of the `secrets`
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

type KeepOnSwitchField = (typeof PRESET_KEEP_ON_SWITCH_FIELDS)[number];
export type ActivePresetField = Exclude<PresetField, KeepOnSwitchField>;
export type ActivePreset = Pick<botPreset, ActivePresetField> & { readonly id: string | undefined };
export type ActivePersonaField = "name" | "icon" | "note" | "personaPrompt" | "largePortrait";
export type ActivePersona = Pick<RisuPersona, ActivePersonaField> & { readonly id: string | undefined };

/** The facade's resolution functions take a database; this one reads the records directly. */
const recordsDb = {
    get botPresets() {
        return trackedRecord("presets");
    },
    get personas() {
        return trackedRecord("personas");
    },
} as unknown as Database;

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

const keepOnSwitch = new Set<string>(PRESET_KEEP_ON_SWITCH_FIELDS);

/** The preset fields `activePreset` serves (every preset field but the keep-on-switch group). */
export const ACTIVE_PRESET_FIELDS = PRESET_FIELDS.filter((field) => !keepOnSwitch.has(field)) as ActivePresetField[];

function buildActivePreset(): ActivePreset {
    const view = {};
    for (const field of ACTIVE_PRESET_FIELDS) {
        defineView(
            view,
            field,
            () => presetFieldValue(selectedPreset(recordsDb) as unknown as Record<string, unknown> | undefined, field),
            (value) => {
                const record = selectedPresetForWrite(recordsDb) as unknown as Record<string, unknown> | undefined;
                if (record !== undefined) {
                    record[field] = value;
                }
            },
        );
    }
    defineView(view, "id", () => selectedPreset(recordsDb)?.id);
    return Object.freeze(view) as ActivePreset;
}

export const activePreset: ActivePreset = buildActivePreset();

function buildActivePersona(): ActivePersona {
    const view = {};
    const fields: readonly ActivePersonaField[] = ["name", "icon", "note", "personaPrompt", "largePortrait"];
    for (const field of fields) {
        defineView(
            view,
            field,
            () => {
                const value = selectedPersona(recordsDb)?.[field];
                if (field in PERSONA_DEFAULTS) {
                    return typeof value === "string" ? value : PERSONA_DEFAULTS[field as keyof typeof PERSONA_DEFAULTS];
                }
                return value;
            },
            (value) => {
                const record = selectedPersonaForWrite(recordsDb) as unknown as Record<string, unknown> | undefined;
                if (record !== undefined) {
                    record[field] = value;
                }
            },
        );
    }
    defineView(view, "id", () => selectedPersona(recordsDb)?.id);
    return Object.freeze(view) as ActivePersona;
}

export const activePersona: ActivePersona = buildActivePersona();

/** The selected preset's record (its wrapper), resolved as `activePreset` reads it; `undefined` when there is none. */
export function currentPresetRecord(): botPreset | undefined {
    return selectedPreset(recordsDb);
}

/** The selected persona's record (its wrapper); `undefined` when there is none. */
export function currentPersonaRecord(): RisuPersona | undefined {
    return selectedPersona(recordsDb);
}

/**
 * The global lorebook page this client shows: the selection, or 0 when it is past the list's end
 * (then also selected, untracked), as the facade's `loreBookPage` reads it.
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

/** The preset fields the facade forwards (every preset field but `name`, `image`, the keep-on-switch group). */
type ForwardedPresetField = Exclude<ActivePresetField, "name" | "image">;
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

/** Reads a root name through its view (a section field, the selected preset's or persona's field, a collection). */
export function readSettingsRoot(key: SettingsRootKey | string): unknown {
    const route = routeOf(key);
    return route.target()[route.field];
}

/** Writes a root name through its view, with the view's rules (a dropped preset write, a replaced record). */
export function writeSettingsRoot(key: SettingsRootKey | string, value: unknown) {
    const route = routeOf(key);
    route.target()[route.field] = value;
}
