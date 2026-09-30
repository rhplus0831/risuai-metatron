import { flushSync, untrack } from "svelte";
import { DBState } from "../../stores.svelte";
import type { Database } from "../database.svelte";

// Test-only prototype of the Phase 3 forwarding layer (spike, slice 1). Nothing here is production
// code: the layer that slice 5 installs on the real database is written from the verdict of
// `forwardingSpike.test.ts`, not copied from this file.
//
// Shape (spike "Proposed decisions"): `installForwarding(raw)` defines, on the raw object before
// Svelte proxies it, one enumerable and configurable accessor per forwarded root key. The getter
// resolves the selected record from the selection id and the current collection on every access
// (no cached record) and returns `record[aliasOf(rootKey)]`. The setter captures the selected id
// synchronously, resolves the record by that id, and writes into it through the proxy. Both use
// `this`, which is the Svelte proxy whenever the accessor is reached through `DBState.db`
// (`Reflect.get(target, prop, receiver)` and `descriptor.set.call(receiver, value)` in
// `node_modules/svelte/src/internal/client/proxy.js`), so the collection reads are tracked and the
// record writes notify.
//
// A15 (lazy reconciliation inside accessor resolution): when the selected id names no record, the
// getter falls back to the first record and persists that fallback to the selection. A setter call
// whose captured id names no record is dropped, never redirected to another record.

export interface SpikePromptSettings {
    postEndInnerFormat: string;
    sendChatAsSystem: boolean;
}

export interface SpikePreset {
    id: string;
    name: string;
    temperature: number;
    maxContext: number;
    reasonEffort: number;
    promptSettings: SpikePromptSettings | null;
}

export interface SpikePersona {
    id: string;
    name: string;
    icon: string;
    personaPrompt: string;
}

/** The forwarded root keys the harness defines. Slice 5 forwards the full lists. */
export interface SpikeForwardedRoot {
    temperature: number;
    maxContext: number;
    reasoningEffort: number;
    promptSettings: SpikePromptSettings | null;
    username: string;
    userIcon: string;
    personaPrompt: string;
}

export interface SpikeRawDb {
    botPresets: SpikePreset[];
    botPresetId: string;
    personas: SpikePersona[];
    personaId: string;
    /** A plain (not forwarded) root key, to show that ordinary keys are untouched. */
    plainKey: string;
}

export type SpikeDb = SpikeRawDb & SpikeForwardedRoot;

interface ForwardedKey {
    rootKey: keyof SpikeForwardedRoot;
    collection: "botPresets" | "personas";
    selection: "botPresetId" | "personaId";
    recordKey: string;
}

/** Root key -> preset record key. `reasoningEffort` is the renamed one (`reasonEffort` on the preset). */
export const PRESET_ALIASES: Readonly<Record<string, string>> = {
    temperature: "temperature",
    maxContext: "maxContext",
    reasoningEffort: "reasonEffort",
    promptSettings: "promptSettings",
};

/** Root key -> persona record key. */
export const PERSONA_ALIASES: Readonly<Record<string, string>> = {
    username: "name",
    userIcon: "icon",
    personaPrompt: "personaPrompt",
};

export const FORWARDED_KEYS: readonly ForwardedKey[] = [
    ...Object.entries(PRESET_ALIASES).map(([rootKey, recordKey]): ForwardedKey => ({
        rootKey: rootKey as keyof SpikeForwardedRoot,
        collection: "botPresets",
        selection: "botPresetId",
        recordKey,
    })),
    ...Object.entries(PERSONA_ALIASES).map(([rootKey, recordKey]): ForwardedKey => ({
        rootKey: rootKey as keyof SpikeForwardedRoot,
        collection: "personas",
        selection: "personaId",
        recordKey,
    })),
];

export function createRawDb(): SpikeRawDb {
    return {
        botPresets: [
            {
                id: "a",
                name: "Preset A",
                temperature: 80,
                maxContext: 4000,
                reasonEffort: 1,
                promptSettings: { postEndInnerFormat: "a-format", sendChatAsSystem: false },
            },
            {
                id: "b",
                name: "프리셋 B",
                temperature: 50,
                maxContext: 8000,
                reasonEffort: 2,
                promptSettings: null,
            },
        ],
        botPresetId: "a",
        personas: [
            { id: "p1", name: "User One", icon: "icon-1", personaPrompt: "I am one." },
            { id: "p2", name: "User Two", icon: "icon-2", personaPrompt: "I am two." },
        ],
        personaId: "p1",
        plainKey: "plain",
    };
}

type Record_ = Record<string, unknown> & { id: string };

function findRecord(list: unknown, id: unknown): Record_ | undefined {
    if (!Array.isArray(list)) {
        return undefined;
    }
    return (list as Record_[]).find((record) => record?.id === id);
}

/**
 * Resolves the selected record for a getter. When the selection names no record, falls back to
 * the first record and persists that fallback to the selection (A15). The persist runs under
 * `untrack` because a getter can be reached from a `$derived` or a block effect, where Svelte's
 * `set` guard (`state_unsafe_mutation` in `reactivity/sources.js`) forbids a tracked write.
 */
function resolveForRead(db: Record<string, unknown>, key: ForwardedKey): Record_ | undefined {
    const list = db[key.collection];
    const id = db[key.selection];
    const record = findRecord(list, id);
    if (record !== undefined) {
        return record;
    }
    const first = Array.isArray(list) ? (list[0] as Record_ | undefined) : undefined;
    if (first !== undefined && first.id !== id) {
        untrack(() => {
            db[key.selection] = first.id;
        });
    }
    return first;
}

/** The descriptor check that makes the install idempotent and recognizes a proxy over an installed object. */
function isInstalled(target: object, rootKey: string): boolean {
    return typeof Object.getOwnPropertyDescriptor(target, rootKey)?.get === "function";
}

/**
 * Installs the forwarding accessors on `raw`. Must run before `raw` is proxied by `$state`:
 * `defineProperty` through the Svelte proxy throws `state_descriptors_fixed` for any accessor
 * descriptor. Idempotent: a key whose own descriptor already has a getter is skipped, which also
 * covers being handed the proxy over an installed object.
 */
export function installForwarding<T extends object>(raw: T): T {
    for (const key of FORWARDED_KEYS) {
        if (isInstalled(raw, key.rootKey)) {
            continue;
        }
        Object.defineProperty(raw, key.rootKey, {
            enumerable: true,
            configurable: true,
            get(this: Record<string, unknown>) {
                const record = resolveForRead(this, key);
                return record === undefined ? undefined : record[key.recordKey];
            },
            set(this: Record<string, unknown>, value: unknown) {
                // Capture the selected id synchronously; a missing record drops the write (A15).
                const id = this[key.selection];
                const record = findRecord(this[key.collection], id);
                if (record === undefined) {
                    return;
                }
                record[key.recordKey] = value;
            },
        });
    }
    return raw;
}

/** Installs the layer on a fresh raw object, makes it `DBState.db`, and returns the proxy. */
export function mountSpikeDb(raw: SpikeRawDb = createRawDb()): SpikeDb {
    installForwarding(raw);
    DBState.db = raw as unknown as Database;
    return DBState.db as unknown as SpikeDb;
}

export function currentDb(): SpikeDb {
    return DBState.db as unknown as SpikeDb;
}

/** Changes only the preset selection. No root copy (Astra P10). */
export function switchTo(id: string): void {
    currentDb().botPresetId = id;
}

/** Changes only the persona selection. */
export function switchPersona(id: string): void {
    currentDb().personaId = id;
}

export function preset(id: string): SpikePreset | undefined {
    return currentDb().botPresets.find((p) => p.id === id);
}

export function persona(id: string): SpikePersona | undefined {
    return currentDb().personas.find((p) => p.id === id);
}

/** Harness copy of `setPluginDatabaseLite` (`src/ts/plugins/apiV3/v3.svelte.ts`): per-key assignment on the proxy, then `DBState.db = db`. */
export function pluginSetDatabaseLite(newDb: Record<string, unknown>): void {
    const db = DBState.db as unknown as Record<string, unknown>;
    for (const key of Object.keys(newDb)) {
        db[key] = newDb[key];
    }
    DBState.db = db as unknown as Database;
}

/** Defaults the harness copy of `setDatabase` applies where `checkNullish` finds a nullish value. */
export const SPIKE_DEFAULTS: Readonly<Partial<SpikeForwardedRoot>> = {
    temperature: 80,
    maxContext: 4000,
    reasoningEffort: 0,
    promptSettings: { postEndInnerFormat: "default-format", sendChatAsSystem: false },
    username: "User",
    userIcon: "",
    personaPrompt: "",
};

const checkNullish = (data: unknown) => data === undefined || data === null;

/**
 * Harness copy of `setPluginDatabase`: the same per-key assignment plus a `checkNullish` pass that
 * reads each forwarded key through the getter and assigns the default through the setter when the
 * value is nullish (what `setDatabase` in `database.svelte.ts` does for every field).
 */
export function pluginSetDatabase(newDb: Record<string, unknown>): void {
    const db = DBState.db as unknown as Record<string, unknown>;
    for (const key of Object.keys(newDb)) {
        db[key] = newDb[key];
    }
    for (const [key, fallback] of Object.entries(SPIKE_DEFAULTS)) {
        if (checkNullish(db[key])) {
            db[key] = fallback;
        }
    }
    DBState.db = db as unknown as Database;
}

/** `$state.snapshot` for the test file, which may not use runes (STRUCTURE.md T3). */
export function snapshot<T>(value: T): T {
    return $state.snapshot(value) as T;
}

export interface Probe<T> {
    /** Every value the `$effect` observed, in order (the first entry is the initial run). */
    readonly seen: readonly T[];
    /** Reads through a `$derived`, so the getter runs inside a derived reaction. */
    derived(): T;
    dispose(): void;
}

/**
 * Observes `read()` from a `$effect` and a `$derived` inside an `$effect.root`, so the test file
 * (a plain `.test.ts`, no runes: STRUCTURE.md T3) can check that accessor reads are tracked.
 */
export function createProbe<T>(read: () => T): Probe<T> {
    const seen: T[] = [];
    let derivedValue: () => T = read;
    const dispose = $effect.root(() => {
        const value = $derived.by(read);
        derivedValue = () => value;
        $effect(() => {
            seen.push(read());
        });
    });
    flushSync();
    return {
        seen,
        derived: () => derivedValue(),
        dispose,
    };
}
