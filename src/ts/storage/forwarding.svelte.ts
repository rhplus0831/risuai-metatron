import { untrack } from "svelte";
import type { botPreset, Database, RisuPersona } from "../../../shared/database.ts";
import {
    PRESET_DEFAULTS,
    PRESET_FIELD_KINDS,
    PRESET_NULLABLE_FIELDS,
    PERSONA_ROOT_ALIASES,
    PRESET_ROOT_ALIASES,
    plainClone,
    type PresetField,
} from "../../../shared/presets.ts";
import { FORWARDED_PRESET_KEYS } from "../../../shared/sections.ts";
import { deletePresetSecret, getPresetSecret, setPresetSecret } from "./llmSecrets.svelte";
import { PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import { selectLoreBookPage, selectPersona, selectPreset, selection } from "./selection.svelte";

/**
 * The forwarding layer (Phase 3, `PLAN.md` Decision 3). `DBState.db` keeps the old flat preset
 * fields (`db.temperature`, `db.NAIsettings`, ...), but they are no longer root copies: each is an
 * accessor on the database object that reads and writes the selected preset (`selection.presetId`)
 * in `db.botPresets`. `db.proxyKey` reads and writes that preset's entry of `llmSecretPresets`; the
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

const nullableFields = new Set<PresetField>(PRESET_NULLABLE_FIELDS);

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
    const record = resolvePreset(db);
    const fallback = PRESET_DEFAULTS[field];
    if (record === undefined) {
        return plainClone(fallback);
    }
    const value = record[field];
    if (value === undefined) {
        return plainClone(fallback);
    }
    const container = PRESET_FIELD_KINDS[field] === "object" || PRESET_FIELD_KINDS[field] === "array";
    if (value === null && container && !nullableFields.has(field)) {
        return plainClone(fallback);
    }
    return value;
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

/** Installs the forwarding accessors on `raw` (before it is proxied); idempotent. */
export function installForwarding<T extends object>(raw: T): T {
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
            const record = resolvePreset(db);
            return record === undefined ? "" : (getPresetSecret(record.id)?.proxyKey ?? "");
        },
        (db, value) => {
            const record = presetForWrite(db);
            if (record === undefined) {
                return;
            }
            untrack(() => {
                if (typeof value === "string" && value !== "") {
                    setPresetSecret(record.id, { proxyKey: value });
                } else {
                    deletePresetSecret(record.id);
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
