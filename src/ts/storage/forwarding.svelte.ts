import { untrack } from "svelte";
import type { botPreset, Database, RisuPersona } from "../../../shared/database.ts";
import {
    PERSONA_ROOT_ALIASES,
    PRESET_ROOT_ALIASES,
    presetFieldValue,
    type PresetField,
} from "../../../shared/presets.ts";
import { FORWARDED_PRESET_KEYS, SECTION_FIELDS, SECTION_KIND, type SectionKind } from "../../../shared/sections.ts";
import {
    CHARACTERS,
    RECORD_ROOT_FIELDS,
    SELECTABLE_ROOT_FIELDS,
    assignCharacters,
    replaceRecord,
    trackedCharacters,
    trackedRecord,
    writeRecordField,
    type RecordKind,
} from "./records.svelte";
import { clearSecret, setSecret } from "./llmSecrets.svelte";
import { PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import { selectLoreBookPage, selectPersona, selectPreset, selection } from "./selection.svelte";

/**
 * The forwarding layer (Phase 3, `PLAN.md` Decision 3). `DBState.db` keeps the old flat preset
 * fields (`db.temperature`, `db.NAIsettings`, ...), but they are no longer root copies: each is an
 * accessor on the database object that reads and writes the selected preset (`selection.presetId`)
 * in `db.botPresets`. `db.proxyKey` reads `""` and writes that preset's `llmSecrets` entry (queued); the
 * four persona fields (`db.username`, `db.userIcon`, `db.userNote`, `db.personaPrompt`,
 * `PERSONA_ROOT_ALIASES`) read and write the selected persona (`selection.personaId`) in
 * `db.personas`; and `db.botPresetsId`, `db.selectedPersona`, and `db.loreBookPage` read and write
 * the per-client selection. `FORWARDED_ROOT_KEYS`
 * (`shared/sections.ts`) lists them all. The spike (`docs/plan/phases/slices/phase-3-settings-sections/spike-forwarding-layer.md`)
 * proved the mechanism over the installed Svelte proxy.
 *
 * Rules:
 * - `installForwarding` runs on the raw object before `$state` proxies it: defining an accessor
 *   through the proxy throws. It skips a key that already has a getter, which also recognizes the
 *   proxy over an installed object (the plugin setters and `checkNewFormat` pass it back).
 * - Every access resolves the record anew from the current collection (nothing is cached), so a
 *   collection replaced by a conflict reload or a splice is honored at once.
 * - When the selected id names no record, a read falls back to the first record and makes it the
 *   selection (untracked: the read may come from a `$derived`, where a tracked write throws). A
 *   write made while the id names no record is dropped, never redirected to another record. Every
 *   path in the app reads (renders) before it writes, and `setDatabaseLite` resolves the selection
 *   when it installs a database, so only a plugin that removes the selected preset and writes in
 *   the same tick loses a write.
 * - Writes resolve untracked: an `$effect` that assigns a forwarded field must not rerun, and write
 *   again, into the next preset when the selection changes.
 * - A read never writes a record. The presets arrive normalized (`normalizePreset` gives every
 *   field its value, a `null` only where one is a value), so the fallbacks here only cover a record
 *   between a local write and its normalization: a value the preset lacks reads as its default
 *   (`PRESET_DEFAULTS`), and a `null` in an object or array field that has no `null` value (a
 *   plugin's) reads as a fresh default. A `null` in any other field reads as `null`, so a number
 *   input the user cleared stays empty until it is typed into again.
 * - Never `delete` a forwarded key: the proxy then shadows it for good (spike, "Proxy behavior").
 */

type Db = Record<string, unknown> & { botPresets?: botPreset[]; personas?: RisuPersona[]; loreBook?: unknown[] };
type PresetRecord = Record<string, unknown> & { id: string };
type PersonaRecord = Record<string, unknown> & { id: string };

const presetFieldOf: Record<string, string> = PRESET_ROOT_ALIASES;

function presetList(db: Db): PresetRecord[] {
    return Array.isArray(db.botPresets) ? (db.botPresets as unknown as PresetRecord[]) : [];
}

function findPreset(db: Db, id: string): PresetRecord | undefined {
    return presetList(db).find((preset) => preset?.id === id);
}

/** The selected preset: the one `selection.presetId` names, else the first, which becomes the selection. */
function resolvePreset(db: Db): PresetRecord | undefined {
    const record = findPreset(db, selection.presetId);
    if (record !== undefined) {
        return record;
    }
    const first = presetList(db)[0];
    if (first === undefined || typeof first?.id !== "string") {
        return undefined;
    }
    untrack(() => selectPreset(first.id));
    return first;
}

/** The record a write goes to: the one the selection names now, or none (the write is dropped). */
function presetForWrite(db: Db): PresetRecord | undefined {
    return untrack(() => findPreset(db, selection.presetId));
}

/**
 * The preset a write to the selected preset goes to, without the read fallback: `undefined` when
 * the selection names no record (the write is then dropped, never redirected).
 */
export function selectedPresetForWrite(db: Database): botPreset | undefined {
    return presetForWrite(db as unknown as Db) as unknown as botPreset | undefined;
}

function personaList(db: Db): PersonaRecord[] {
    return Array.isArray(db.personas) ? (db.personas as unknown as PersonaRecord[]) : [];
}

function findPersona(db: Db, id: string): PersonaRecord | undefined {
    return personaList(db).find((persona) => persona?.id === id);
}

/** The selected persona: the one `selection.personaId` names, else the first, which becomes the selection. */
function resolvePersona(db: Db): PersonaRecord | undefined {
    const record = findPersona(db, selection.personaId);
    if (record !== undefined) {
        return record;
    }
    const first = personaList(db)[0];
    if (first === undefined || typeof first?.id !== "string") {
        return undefined;
    }
    untrack(() => selectPersona(first.id));
    return first;
}

function personaForWrite(db: Db): PersonaRecord | undefined {
    return untrack(() => findPersona(db, selection.personaId));
}

function readPresetField(db: Db, field: PresetField): unknown {
    return presetFieldValue(resolvePreset(db), field);
}

function isInstalled(target: object, key: string): boolean {
    return typeof Object.getOwnPropertyDescriptor(target, key)?.get === "function";
}

function defineForwarded(raw: object, key: string, get: (db: Db) => unknown, set: (db: Db, value: unknown) => void) {
    if (isInstalled(raw, key)) {
        return;
    }
    Object.defineProperty(raw, key, {
        enumerable: true,
        configurable: true,
        get(this: Db) {
            return get(this);
        },
        set(this: Db, value: unknown) {
            set(this, value);
        },
    });
}

/** Every root field the record accessors serve. */
const RECORD_ROOT_KEYS: readonly string[] = [
    ...(Object.values(SECTION_KIND) as SectionKind[]).flatMap(
        (section) => SECTION_FIELDS[section] as readonly string[],
    ),
    ...Object.values(RECORD_ROOT_FIELDS),
    ...Object.values(SELECTABLE_ROOT_FIELDS).flatMap((names) => [names.items, names.selectedId]),
    CHARACTERS,
];

/**
 * The record accessors (Phase 6 slice 4, `records.svelte.ts`): every section field reads and writes
 * its section record; a collection field and `botPresets`, `modules`, `plugins`,
 * `pluginCustomStorage` are their record's wrapper (`undefined` while the record is absent), and an
 * assignment replaces the record; `translatorPresets`/`hypaV3Presets` and their selected ids are the
 * record's `items` and `selectedId`. Every write queues the record's write. `characters` (Phase 6
 * slice 5) is the character list's wrapper: a write under a character queues that character; the
 * list's membership changes through `characterStore` (an assignment of the list itself is a no-op,
 * any other is refused).
 */
function installRecordAccessors(raw: object) {
    for (const key of RECORD_ROOT_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (descriptor && "value" in descriptor) {
            // Its value would be lost under the accessor: `setDatabaseLite` moves it into the records.
            throw new Error(`${key} is a record field: initialize the records before installing the accessors`);
        }
    }
    for (const section of Object.values(SECTION_KIND) as SectionKind[]) {
        for (const field of SECTION_FIELDS[section] as readonly string[]) {
            defineForwarded(
                raw,
                field,
                () => trackedRecord<Record<string, unknown>>(section)?.[field],
                (_db, value) => untrack(() => writeRecordField(section, field, value)),
            );
        }
    }
    for (const [kind, field] of Object.entries(RECORD_ROOT_FIELDS)) {
        defineForwarded(
            raw,
            field,
            () => trackedRecord(kind as RecordKind),
            (_db, value) => untrack(() => replaceRecord(kind as RecordKind, value)),
        );
    }
    defineForwarded(
        raw,
        CHARACTERS,
        () => trackedCharacters(),
        (_db, value) => untrack(() => assignCharacters(value)),
    );
    for (const [kind, names] of Object.entries(SELECTABLE_ROOT_FIELDS)) {
        defineForwarded(
            raw,
            names.items,
            () => trackedRecord<Record<string, unknown>>(kind as RecordKind)?.items,
            (_db, value) => untrack(() => writeRecordField(kind as RecordKind, "items", value)),
        );
        defineForwarded(
            raw,
            names.selectedId,
            () => trackedRecord<Record<string, unknown>>(kind as RecordKind)?.selectedId,
            (_db, value) => untrack(() => writeRecordField(kind as RecordKind, "selectedId", value)),
        );
    }
}

/**
 * Installs the forwarding accessors on `raw` (before it is proxied); idempotent. It only defines
 * accessors: the records behind them are initialized by the installation (`setDatabaseLite`).
 */
export function installForwarding<T extends object>(raw: T): T {
    installRecordAccessors(raw);
    for (const rootKey of FORWARDED_PRESET_KEYS) {
        const field = (presetFieldOf[rootKey] ?? rootKey) as PresetField;
        defineForwarded(
            raw,
            rootKey,
            (db) => readPresetField(db, field),
            (db, value) => {
                const record = presetForWrite(db);
                if (record !== undefined) {
                    record[field] = value;
                }
            },
        );
    }
    defineForwarded(
        raw,
        "proxyKey",
        (db) => {
            // Write-only (Phase 5 slice 7b): the tab never holds the key (`secretStatus` says whether
            // the preset has one). The read still resolves the selection, as every preset read does.
            resolvePreset(db);
            return "";
        },
        (db, value) => {
            const record = presetForWrite(db);
            if (record === undefined) {
                return;
            }
            untrack(() => {
                if (typeof value === "string" && value !== "") {
                    setSecret({ kind: "entry", field: "presets", id: record.id }, value);
                } else {
                    clearSecret({ kind: "entry", field: "presets", id: record.id });
                }
            });
        },
    );
    defineForwarded(
        raw,
        "botPresetsId",
        (db) => {
            const record = resolvePreset(db);
            return record === undefined
                ? 0
                : Math.max(
                      0,
                      presetList(db).findIndex((preset) => preset?.id === record.id),
                  );
        },
        (db, value) => {
            const record = untrack(() => (typeof value === "number" ? presetList(db)[value] : undefined));
            if (record !== undefined) {
                untrack(() => selectPreset(record.id));
            }
        },
    );
    for (const [rootKey, field] of Object.entries(PERSONA_ROOT_ALIASES)) {
        defineForwarded(
            raw,
            rootKey,
            (db) => {
                const value = resolvePersona(db)?.[field];
                return typeof value === "string" ? value : PERSONA_DEFAULTS[field];
            },
            (db, value) => {
                const record = personaForWrite(db);
                if (record !== undefined) {
                    record[field] = value;
                }
            },
        );
    }
    defineForwarded(
        raw,
        "selectedPersona",
        (db) => {
            const record = resolvePersona(db);
            return record === undefined
                ? 0
                : Math.max(
                      0,
                      personaList(db).findIndex((persona) => persona?.id === record.id),
                  );
        },
        (db, value) => {
            const record = untrack(() => (typeof value === "number" ? personaList(db)[value] : undefined));
            if (record !== undefined) {
                untrack(() => selectPersona(record.id));
            }
        },
    );
    defineForwarded(
        raw,
        "loreBookPage",
        (db) => {
            const page = selection.loreBookPage;
            const length = Array.isArray(db.loreBook) ? db.loreBook.length : 0;
            if (page < length) {
                return page;
            }
            if (page !== 0) {
                untrack(() => selectLoreBookPage(0));
            }
            return 0;
        },
        (_db, value) => {
            if (Number.isInteger(value) && (value as number) >= 0) {
                untrack(() => selectLoreBookPage(value as number));
            }
        },
    );
    return raw;
}

/** Resolves the selection against `db` now, so a write before the first read has a record to go to. */
export function reconcileSelection(db: Database) {
    untrack(() => {
        resolvePreset(db as unknown as Db);
        resolvePersona(db as unknown as Db);
        void db.loreBookPage;
    });
}

/** The selected preset of `DBState.db`-shaped `db` (the proxy), resolved as the accessors do. */
export function selectedPreset(db: Database): botPreset | undefined {
    return resolvePreset(db as unknown as Db) as unknown as botPreset | undefined;
}

/** The selected persona of `db` (the proxy), resolved as the accessors do. */
export function selectedPersona(db: Database): RisuPersona | undefined {
    return resolvePersona(db as unknown as Db) as unknown as RisuPersona | undefined;
}

/** The persona a write to the selected persona goes to, without the read fallback. */
export function selectedPersonaForWrite(db: Database): RisuPersona | undefined {
    return personaForWrite(db as unknown as Db) as unknown as RisuPersona | undefined;
}

const forwardedPresetKeys = new Set<string>(FORWARDED_PRESET_KEYS);

/** The preset field a forwarded root key mirrors (`PRESET_ROOT_ALIASES`), or `undefined` for a key that is not forwarded. */
export function forwardedPresetField(rootKey: string): PresetField | undefined {
    return forwardedPresetKeys.has(rootKey) ? ((presetFieldOf[rootKey] ?? rootKey) as PresetField) : undefined;
}

/** Whether a preset with `id` exists in `db` (untracked). */
export function hasPreset(db: Database, id: string): boolean {
    return untrack(() => findPreset(db as unknown as Db, id)) !== undefined;
}

/**
 * Reads a forwarded preset field (by its root name) from the preset with `presetId`, as the accessor
 * reads the selected one (the same fallbacks): for a caller that captured its preset (a plugin
 * hook's `getDatabase`). `undefined` when the key is not forwarded or no preset has that id.
 */
export function readPresetFieldOf(db: Database, presetId: string, rootKey: string): unknown {
    const field = forwardedPresetField(rootKey);
    const record = untrack(() => findPreset(db as unknown as Db, presetId));
    return field === undefined || record === undefined ? undefined : presetFieldValue(record, field);
}

/**
 * Writes a forwarded preset field (by its root name, `FORWARDED_PRESET_KEYS`) into the preset with
 * `presetId`, whatever is selected: the mutation form of the accessor, for a caller that captured
 * its preset (`collectionStore`'s `updateSettings`). Returns `false`, writing nothing, when no preset
 * has that id or the key is not forwarded; never redirects.
 */
export function writePresetField(db: Database, presetId: string, rootKey: string, value: unknown): boolean {
    const field = forwardedPresetField(rootKey);
    const record = untrack(() => findPreset(db as unknown as Db, presetId));
    if (field === undefined || record === undefined) {
        return false;
    }
    record[field] = value;
    return true;
}
