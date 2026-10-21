import { flushSync, untrack } from "svelte";
import {
    FLAT_SECRET_FIELDS,
    isMaskedLeaf,
    NESTED_SECRET_FIELDS,
    type FlatSecretField,
    type MaskedLlmSecrets,
    type SecretPath,
} from "../../../../shared/llmSecrets.ts";
import { PRESET_ROOT_ALIASES } from "../../../../shared/presets.ts";
import { compareRevision, RESOURCE_EPOCH_HEADER, SINGLETON_RESOURCE_ID } from "../../../../shared/resources.ts";
import { FORWARDED_PRESET_KEYS, SECTION_FIELDS, SECTION_KIND, type SectionKind } from "../../../../shared/sections.ts";
import { prototypeRoot } from "./prototypeRoot.svelte";
import type { Database } from "../database.svelte";
import {
    clearSecret,
    llmSecretState,
    llmSecretsText,
    mirrorFields,
    setMaskedSecrets,
    setSecret,
} from "../llmSecrets.svelte";
import { writeEntries } from "../mutationValidation";
import type { StoreBackedServer } from "./storeBackedServer";

// Test-only prototype of the per-resource records. Nothing here is production code:
// `src/ts/storage/records.svelte.ts` and the real save loop were written from what
// `projectionBindings.test.ts` showed, not by copying this file.
//
// Pieces:
// - The record store: one `$state` slot per `(kind, id)`, holding the record's data. `applyRaw`
//   replaces a slot (boot, hydration, conflict reload) and never queues a write.
// - Two wrapper implementations over a record, measured on the same cases:
//   1. `projectRecord(kind, id)`, accessor-backed: a plain object (an array for an array record)
//      with one enumerable accessor per top-level field (per index); the setter writes the field
//      and calls `queueRecordWrite`. Nested containers are the raw `$state` sub-objects, so a nested
//      write bypasses the queue (measured, not worked around).
//   2. `trackedRecord(kind, id)`, deep write-through: a JS `Proxy` whose every trap resolves the
//      record's current `$state` data; `get` returns cached nested wrappers; `set`,
//      `deleteProperty`, and `defineProperty` forward to the Svelte proxy and call
//      `queueRecordWrite` in the same task. Array mutators run through the traps.
// - The root facade (`mountFacade`): a raw object with enumerable accessors, installed before
//   `prototypeRoot.db = raw` proxies it (as the removed `forwarding.svelte.ts` did), so the real
//   `getSettingValue`/`setSettingValue` and real components run against it.
// - `queueRecordWrite` and a reduced transport prototype over `StoreBackedServer` that mirrors the
//   save loop's capture, flush, acknowledgement, conflict, and hydration rules
//   (`src/ts/storage/resourceSync.svelte.ts`, cited at each rule). Not modeled: quarantine,
//   generation blocks, restore (epoch) handling, the credential writes' acknowledgement, and the
//   batching limits; the production save loop's own tests cover those.

/**
 * `accessor` uses top-level getters and setters; `tracked` validates its path on every access;
 * `tracked-cached` uses the resolve cache (`resolve`): outside a tracking context a
 * nested wrapper reuses its last resolution while no structural write happened since.
 */
export type Candidate = "accessor" | "tracked" | "tracked-cached";
export const CANDIDATES: readonly Candidate[] = ["accessor", "tracked", "tracked-cached"];

/** The sections the facade forwards (each a singleton `main` record). */
export const FACADE_SECTIONS = [
    SECTION_KIND.ui,
    SECTION_KIND.providers,
    SECTION_KIND.secrets,
    SECTION_KIND.llmSecrets,
] as const satisfies readonly SectionKind[];

export const PRESETS_KIND = "presets";
export const CHARACTERS_KIND = "characters";

/** The record key the harness uses (the real loop's `recordKey` joins with `\u0000`; `/` reads better in assertions). */
export function keyOf(kind: string, id: string): string {
    return `${kind}/${id}`;
}

function splitKey(key: string): { kind: string; id: string } {
    const slash = key.indexOf("/");
    return { kind: key.slice(0, slash), id: key.slice(slash + 1) };
}

// ---------------------------------------------------------------------------------------------
// Svelte internals the harness needs.

/**
 * Svelte's `STATE_SYMBOL` (`node_modules/svelte/src/internal/client/constants.js`), which the
 * package does not export. `proxy()` (`internal/client/proxy.js`) asks `STATE_SYMBOL in value` of
 * any object it is given, so a probe proxy assigned into a `$state` sees the symbol in its `has`
 * trap. Used to tell a Svelte proxy from a plain object when unwrapping a written value.
 */
const STATE: symbol = (() => {
    let found: symbol | null = null;
    const probe = new Proxy(
        {},
        {
            has(target, prop) {
                if (typeof prop === "symbol" && prop.description === "$state") {
                    found = prop;
                }
                return Reflect.has(target, prop);
            },
        },
    );
    const holder = $state({ value: null as unknown });
    holder.value = probe;
    if (found === null) {
        throw new Error("Svelte's $state symbol was not observed");
    }
    return found;
})();

/**
 * `Object.is`, not `===`, wherever a value may be a wrapper: in dev, Svelte compiles `===` and
 * `!==` in a `.svelte.ts` file to `strict_equals` (`dev/equality.js:77`), which calls
 * `get_proxied_value` and so the wrapper's `has` trap (a resolution, which refreshes its target).
 * The harness must not depend on that side effect, which a production build does not have.
 */
const isObject = (value: unknown): value is object => typeof value === "object" && !Object.is(value, null);

/** Whether `value` is a Svelte `$state` proxy (never a tracked wrapper, which answers `has` from its target). */
export function isStateProxy(value: unknown): boolean {
    return isObject(value) && !nodeOf.has(value) && STATE in value;
}

/** Whether `value` is a tracked wrapper. */
export function isTrackedWrapper(value: unknown): boolean {
    return isObject(value) && nodeOf.has(value);
}

/** Whether `value` is a accessor view. */
export function isAccessorView(value: unknown): boolean {
    return isObject(value) && viewKeys.has(value);
}

// ---------------------------------------------------------------------------------------------
// The record store.

/** Each record's data, as `$state`: a read of `records[key]` is tracked, so a replacement re-renders. */
const records: Record<string, unknown> = $state({});
/**
 * Per record (not reactive): `epoch`, bumped by every `applyRaw` (a nested wrapper uses it to tell
 * a raw replacement from a local edit), and the tracked wrapper cache (the nested wrapper of
 * each `$state` sub-object). Held by reference on every wrapper node.
 */
interface RecordMeta {
    epoch: number;
    children: WeakMap<object, TrackedNode>;
    /** The `$state` objects this record's wrappers have reached (a written proxy that is one is stored as is). */
    owned: WeakSet<object>;
    /** Objects a write through a wrapper overwrote or deleted in the current task, and the latest per id. */
    displaced: Set<object>;
    displacedById: Map<string, object>;
    clearScheduled: boolean;
}
const metas = new Map<string, RecordMeta>();

function metaOf(key: string): RecordMeta {
    let meta = metas.get(key);
    if (!meta) {
        meta = {
            epoch: 0,
            children: new WeakMap(),
            owned: new WeakSet(),
            displaced: new Set(),
            displacedById: new Map(),
            clearScheduled: false,
        };
        metas.set(key, meta);
    }
    return meta;
}

/** The per-client preset selection (the harness's `selection.presetId`, `src/ts/storage/selection.svelte.ts`). */
export const selection = $state({ presetId: "a" });

/** Assigns a record's `$state` slot directly (the direct baseline of a collection replacement; never queues). */
export function setLiveRecord(kind: string, id: string, value: unknown): void {
    records[keyOf(kind, id)] = value;
}

/** The live `$state` data of a record (the direct-write baseline; never queues). */
export function liveRecord<T = any>(kind: string, id: string = SINGLETON_RESOURCE_ID): T {
    return records[keyOf(kind, id)] as T;
}

/**
 * The raw application path (boot, hydration, conflict reload): replaces the record's data and
 * never calls `queueRecordWrite`. Accessor views re-sync their accessors to the new field set.
 * A masked `llmSecrets` record from the server is split as the client does: its status goes to
 * `setMaskedSecrets`, the record holds the mirror form (`mirrorFields`: credentials read `""`).
 */
export function applyRaw(kind: string, id: string, data: unknown): void {
    const key = keyOf(kind, id);
    if (kind === SECTION_KIND.llmSecrets && isObject(data) && isMaskedLeaf((data as any).openAIKey)) {
        setMaskedSecrets(data as MaskedLlmSecrets);
        data = mirrorFields(data as Record<string, unknown>);
    }
    metaOf(key).epoch += 1;
    structureVersion += 1;
    records[key] = data;
    const view = views.get(key);
    if (view) {
        syncAccessors(view, kind, id);
    }
}

/**
 * A local whole-record replacement (the facade's `botPresets = [...]`, or a rebuilt root for an
 * own inherited-name key): a write of the record, so it is queued. Not a raw application.
 */
function replaceLocal(kind: string, id: string, value: unknown): void {
    const key = keyOf(kind, id);
    // Accessor mode's own view assigned back (`db.botPresets = models` after an indexed swap through
    // its index accessors) stands for the record's data, never the accessor object itself.
    records[key] = Object.is(value, views.get(key)) ? untrack(() => records[key]) : unwrap(value, key);
    structureVersion += 1;
    const view = views.get(key);
    if (view) {
        syncAccessors(view, kind, id);
    }
    queueRecordWrite(kind, id);
}

// ---------------------------------------------------------------------------------------------
// The write queue and its counters.

export interface FlushReport {
    /** Records serialized by this flush's collection step (one per captured key). */
    serialized: number;
    ops: { kind: string; id: string; baseRevision: string | null; data: any }[];
    /** The batch response status, or null when nothing was sent. */
    status: number | null;
    /** The records a 409 reloaded (`acceptRemote`). */
    conflicts: string[];
}

export const stats = {
    /** `queueRecordWrite` calls per record key. */
    queueCalls: new Map<string, number>(),
    /** Every serialization of a record (flush, hydration check, persisted text after a raw application). */
    serializations: 0,
    flushes: [] as FlushReport[],
    /** The raw batch bodies, as sent. */
    bodies: [] as string[],
    /** Records whose local edit a conflict discarded (`acceptRemote`'s `discarded`). */
    discarded: [] as string[],
    /** Credential writes the wrappers routed to the `llmSecrets` queue (`setSecret`) instead of the record. */
    routedSecrets: [] as SecretPath[],
};

/** What the server last acknowledged for a record (`persisted` in `resourceSync.svelte.ts`). */
const persisted = new Map<string, { revision: string; text: string }>();
/** Dirty keys and the generation of their last mark (`dirty`, `markKey`, `resourceSync.svelte.ts:276`). */
const dirty = new Map<string, number>();
let generation = 0;
/** Keys in the batch in flight (`sendingKeys`). */
const sending = new Set<string>();
/** The newest remote record refused for a local change, re-checked after the next flush (`deferredHydrations`). */
const deferred = new Map<string, { kind: string; id: string; revision: string; data: unknown }>();
let inFlight: Promise<FlushReport> | null = null;
let epoch = "";
let server: StoreBackedServer | null = null;

/**
 * Marks a record for the next flush: the record identity is captured here, at the write;
 * its text and base revision are taken at flush. Like `markKey` (`resourceSync.svelte.ts:276`).
 */
export function queueRecordWrite(kind: string, id: string): void {
    const key = keyOf(kind, id);
    generation += 1;
    dirty.set(key, generation);
    stats.queueCalls.set(key, (stats.queueCalls.get(key) ?? 0) + 1);
}

export function queuedKeys(): string[] {
    return [...stats.queueCalls.keys()];
}

export function dirtyKeys(): string[] {
    return [...dirty.keys()];
}

export function persistedOf(kind: string, id: string = SINGLETON_RESOURCE_ID) {
    return persisted.get(keyOf(kind, id));
}

/**
 * A record's text as the client writes and compares it: the JSON of the live proxy (not
 * `$state.snapshot`, which drops an own `__proto__` key; `projectCollection`,
 * `resourceSync.svelte.ts`), except `llmSecrets`, whose text is its readable siblings
 * (`llmSecretsText`).
 */
function serialize(key: string): string {
    stats.serializations += 1;
    const { kind } = splitKey(key);
    const data = untrack(() => records[key]);
    return kind === SECTION_KIND.llmSecrets ? llmSecretsText(data as Record<string, unknown>) : JSON.stringify(data);
}

/** Resets every piece of harness state (records, views, wrappers, queue, counters, selection). */
export function resetProjection(): void {
    for (const key of Object.keys(untrack(() => records))) {
        delete records[key];
    }
    metas.clear();
    views.clear();
    viewKeys = new WeakMap();
    rootNodes.clear();
    persisted.clear();
    dirty.clear();
    generation = 0;
    sending.clear();
    deferred.clear();
    inFlight = null;
    epoch = "";
    server = null;
    stats.queueCalls.clear();
    stats.serializations = 0;
    stats.flushes = [];
    stats.bodies = [];
    stats.discarded = [];
    stats.routedSecrets = [];
    selection.presetId = "a";
    llmSecretState.queue.splice(0);
    llmSecretState.masked = null;
    llmSecretState.versions = {};
    resolveCache = false;
    mutatorDepth = 0;
    displacedReinsertion = true;
    structureVersion = 0;
}

/** Clears the counters only (after boot and setup, so a case counts its own writes). */
export function resetCounters(): void {
    stats.queueCalls.clear();
    stats.serializations = 0;
    stats.flushes = [];
    stats.bodies = [];
    stats.discarded = [];
    stats.routedSecrets = [];
}

/** Records a record as saved at `revision` with its live text (boot, a reload). */
function adoptSaved(key: string, revision: string): void {
    persisted.set(key, { revision, text: serialize(key) });
}

/**
 * Boot: reads the kinds from the server (`GET /api/resources`, the masked `llmSecrets` record
 * included), applies each record raw, and records it as saved (`seedResources`).
 */
export async function bootRecords(target: StoreBackedServer, kinds: readonly string[]): Promise<void> {
    server = target;
    const response = await target.fetch(`/api/resources?kinds=${kinds.join(",")}`);
    const read = (await response.json()) as {
        epoch: string;
        kinds: Record<string, { id: string; revision: string; data: unknown }[]>;
    };
    epoch = read.epoch;
    for (const [kind, list] of Object.entries(read.kinds)) {
        for (const record of list) {
            applyRaw(kind, record.id, record.data);
            adoptSaved(keyOf(kind, record.id), record.revision);
        }
    }
}

/**
 * The conflict reload (a minimal `acceptRemote`, `resourceSync.svelte.ts:1235`): the server's
 * copy replaces the record through `applyRaw`, becomes the saved state, and the local edit is
 * recorded as discarded.
 */
export async function reloadRecord(kind: string, id: string): Promise<void> {
    const key = keyOf(kind, id);
    const response = await server!.fetch(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
    const item = (await response.json()) as { revision: string; data: unknown };
    applyRaw(kind, id, item.data);
    adoptSaved(key, item.revision);
    dirty.delete(key);
    stats.discarded.push(key);
}

/**
 * The hydration prototype (`applyHydration`, `resourceSync.svelte.ts:1766-1830`): applies a
 * server record through `applyRaw` only when its revision is newer (`compareRevision`) and the
 * record has no local change (not in flight, its serialization equal to the saved text: a dirty
 * mark alone is no change). Otherwise the newest event is kept and re-checked after the next
 * flush. Never calls `queueRecordWrite`.
 */
export function applyRemote(kind: string, id: string, revision: string, data: unknown): boolean {
    const key = keyOf(kind, id);
    const held = persisted.get(key);
    if (!held) {
        return false;
    }
    const order = compareRevision(revision, held.revision);
    if (order === null || order <= 0) {
        return false;
    }
    if (sending.has(key) || serialize(key) !== held.text) {
        const waiting = deferred.get(key);
        if (!waiting || (compareRevision(revision, waiting.revision) ?? 0) > 0) {
            deferred.set(key, { kind, id, revision, data });
        }
        return false;
    }
    applyRaw(kind, id, data);
    adoptSaved(key, revision);
    return true;
}

/** Whether a remote record waits for the next flush (`deferredHydrations`). */
export function deferredRevision(kind: string, id: string = SINGLETON_RESOURCE_ID): string | undefined {
    return deferred.get(keyOf(kind, id))?.revision;
}

/**
 * One save cycle (`runCycle`): a flush already running is joined, not doubled. Afterwards the
 * deferred remote records are re-checked (`runCycle`'s `finally`).
 */
export function flush(): Promise<FlushReport> {
    if (inFlight) {
        return inFlight;
    }
    inFlight = (async () => {
        try {
            const report = await cycle();
            stats.flushes.push(report);
            return report;
        } finally {
            inFlight = null;
            sending.clear();
            for (const record of [...deferred.values()]) {
                deferred.delete(keyOf(record.kind, record.id));
                applyRemote(record.kind, record.id, record.revision, record.data);
            }
        }
    })();
    return inFlight;
}

async function cycle(): Promise<FlushReport> {
    // `collectOperations` (`resourceSync.svelte.ts:608-700`): the generations are captured, each
    // captured record is serialized now from the live record, skipped when its text equals the
    // saved text, and based on the saved revision as it is now. One whole-record op per record.
    const captured = new Map(dirty);
    const report: FlushReport = { serialized: 0, ops: [], status: null, conflicts: [] };
    const ops: { key: string; kind: string; id: string; baseRevision: string | null; text: string }[] = [];
    for (const key of captured.keys()) {
        if (untrack(() => records[key]) === undefined) {
            continue;
        }
        const text = serialize(key);
        report.serialized += 1;
        const current = persisted.get(key);
        if (text === current?.text) {
            continue;
        }
        const { kind, id } = splitKey(key);
        ops.push({ key, kind, id, baseRevision: current?.revision ?? null, text });
    }
    if (ops.length > 0) {
        // `pendingOp` and `batchBody`: the record text goes into the body as it was serialized.
        const parts = ops.map(
            (op) =>
                `{"kind":${JSON.stringify(op.kind)},"id":${JSON.stringify(op.id)},"baseRevision":${JSON.stringify(op.baseRevision)},"data":${op.text}}`,
        );
        const body = `{"ops":[${parts.join(",")}],"chats":[],"chatOrders":[]}`;
        stats.bodies.push(body);
        report.ops = ops.map((op) => ({
            kind: op.kind,
            id: op.id,
            baseRevision: op.baseRevision,
            data: JSON.parse(op.text),
        }));
        for (const op of ops) {
            sending.add(op.key);
        }
        const response = await server!.fetch("/api/resources/batch", {
            method: "POST",
            headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: epoch },
            body,
        });
        report.status = response.status;
        const result = (await response.json()) as {
            results?: { revision: string | null }[];
            conflicts?: { kind: string; id: string }[];
            error?: string;
        };
        if (response.status === 409) {
            // `recoverFromConflict`: nothing of the batch was applied; each conflicting record is
            // reloaded (and its edit discarded); the others stay dirty for the next cycle.
            for (const conflict of result.conflicts ?? []) {
                await reloadRecord(conflict.kind, conflict.id);
                report.conflicts.push(keyOf(conflict.kind, conflict.id));
            }
            return report;
        }
        if (!response.ok) {
            throw new Error(`batch failed ${response.status}: ${result.error}`);
        }
        ops.forEach((op, index) => {
            const revision = result.results?.[index]?.revision;
            if (typeof revision === "string") {
                persisted.set(op.key, { revision, text: op.text });
            }
        });
    }
    // `settle` and `dirty.get(key) === marked` (`resourceSync.svelte.ts:916-927`): a key marked
    // again while its batch was in flight stays dirty.
    for (const [key, marked] of captured) {
        if (dirty.get(key) === marked) {
            dirty.delete(key);
        }
    }
    return report;
}

// ---------------------------------------------------------------------------------------------
// Credentials (`llmSecrets` is write-only: `shared/llmSecrets.ts`).
//
// The boundary: through a record wrapper a credential is never stored in the record
// and never silently lost. The record holds the mirror form (`mirrorFields`: every credential
// field reads `""`), the masked status lives in `llmSecretState` (read-only here), and a credential
// reaches the server only through `setSecret` / `clearSecret`. Each credential path is either
// routed to those or refused (a `TypeError`) before any state changes:
// - a flat credential (`openAIKey`, ...): a string is set (`""` clears), `null`/`undefined` clears,
//   anything else is refused;
// - a nested leaf (`google.accessToken`, `hordeConfig.apiKey`, `novelai.token`): the same;
// - a whole container (`google = { projectId, accessToken }`): the siblings go to the record (the
//   leaf stored blank), a non-empty string leaf is set, a blank or absent leaf changes nothing (it
//   is what the mirror reads, so `{ ...db.google, projectId }` never clears the key), any other
//   leaf value refuses the whole write;
// - `OaiCompAPIKeys.<id>` (and a whole `OaiCompAPIKeys` map, entry by entry): as a flat credential;
// - the entry maps (`presets`, `customModels`) are not in the mirror record: a write of them is
//   refused; a preset's key goes through the facade's `proxyKey` (`forwarding.svelte.ts`);
//   `customModels.<id>.key` is not modeled;
// - `delete` of any credential path (a flat field, a leaf, a container holding a leaf, the map or
//   one of its entries) is refused: use `clearSecret`.

const flatSecretFields = new Set<string>(FLAT_SECRET_FIELDS);
const nestedSecretLeaf: Record<string, string> = NESTED_SECRET_FIELDS;
const ENTRY_MAP_FIELDS = new Set(["presets", "customModels"]);

class CredentialRefusedError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = "CredentialRefusedError";
    }
}
export { CredentialRefusedError };

/** Routes one credential write to the `llmSecrets` queue (the plaintext never enters the record). */
function routeSecret(path: SecretPath, value: string): void {
    if (value === "") {
        clearSecret(path);
    } else {
        setSecret(path, value);
    }
    stats.routedSecrets.push(path);
}

/** A credential value's meaning: a string to set (`""` clears), or refused. */
function credentialValue(value: unknown, what: string): string {
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return "";
    }
    throw new CredentialRefusedError(`${what}: a credential must be a string`);
}

/**
 * The credential rule for a write of `field` on the `llmSecrets` record (`container` null: a
 * top-level field; else the top-level container it is in). Returns the value to store in the
 * record, or `NOT_STORED` when the write is fully routed. Validates everything before routing.
 */
const NOT_STORED = Symbol("not stored");
function credentialWrite(container: string | null, field: string, value: unknown): unknown {
    if (container === null) {
        if (flatSecretFields.has(field)) {
            routeSecret({ kind: "flat", field: field as FlatSecretField }, credentialValue(value, field));
            return NOT_STORED;
        }
        if (ENTRY_MAP_FIELDS.has(field)) {
            throw new CredentialRefusedError(`${field}: credential entries are written through setSecret`);
        }
        if (field === "OaiCompAPIKeys") {
            if (!isObject(value) || Array.isArray(value)) {
                throw new CredentialRefusedError("OaiCompAPIKeys must be a map");
            }
            const entries = Object.entries(value).map(
                ([id, entry]) => [id, credentialValue(entry, `OaiCompAPIKeys.${id}`)] as const,
            );
            for (const [id, entry] of entries) {
                routeSecret({ kind: "map", field: "OaiCompAPIKeys", id }, entry);
            }
            return NOT_STORED;
        }
        if (Object.hasOwn(nestedSecretLeaf, field)) {
            if (!isObject(value) || Array.isArray(value)) {
                throw new CredentialRefusedError(`${field}: a credential container must be an object`);
            }
            const leaf = nestedSecretLeaf[field];
            let secret = "";
            if (Object.hasOwn(value, leaf)) {
                const leafValue = (value as Record<string, unknown>)[leaf];
                if (typeof leafValue === "string") {
                    secret = leafValue;
                } else if (leafValue !== null && leafValue !== undefined) {
                    throw new CredentialRefusedError(`${field}.${leaf}: a credential must be a string`);
                }
            }
            const stored: Record<string, unknown> = {};
            for (const [key, entry] of Object.entries(unwrapPlain(value) as object)) {
                if (key !== leaf) {
                    Object.defineProperty(stored, key, {
                        value: entry,
                        enumerable: true,
                        writable: true,
                        configurable: true,
                    });
                }
            }
            stored[leaf] = "";
            if (secret !== "") {
                routeSecret({ kind: "nested", field: field as keyof typeof NESTED_SECRET_FIELDS }, secret);
            }
            return stored;
        }
        return value;
    }
    if (Object.hasOwn(nestedSecretLeaf, container) && nestedSecretLeaf[container] === field) {
        routeSecret(
            { kind: "nested", field: container as keyof typeof NESTED_SECRET_FIELDS },
            credentialValue(value, `${container}.${field}`),
        );
        return NOT_STORED;
    }
    if (container === "OaiCompAPIKeys") {
        routeSecret(
            { kind: "map", field: "OaiCompAPIKeys", id: field },
            credentialValue(value, `OaiCompAPIKeys.${field}`),
        );
        return NOT_STORED;
    }
    return value;
}

/** Refuses a `delete` of a credential path on the `llmSecrets` record. */
function credentialDelete(container: string | null, field: string): void {
    const refused =
        container === null
            ? flatSecretFields.has(field) ||
              Object.hasOwn(nestedSecretLeaf, field) ||
              field === "OaiCompAPIKeys" ||
              ENTRY_MAP_FIELDS.has(field)
            : (Object.hasOwn(nestedSecretLeaf, container) && nestedSecretLeaf[container] === field) ||
              container === "OaiCompAPIKeys";
    if (refused) {
        throw new CredentialRefusedError(
            `${container ? `${container}.` : ""}${field}: delete a credential with clearSecret`,
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Accessor mode: the accessor-backed record.

const views = new Map<string, any>();
/** Each view's own accessor keys (to drop the ones a raw application removed). */
let viewKeys = new WeakMap<object, Set<string>>();

function defineFieldAccessor(view: any, kind: string, id: string, field: string): void {
    const key = keyOf(kind, id);
    Object.defineProperty(view, field, {
        enumerable: true,
        configurable: true,
        get() {
            return (records[key] as Record<string, unknown>)[field];
        },
        set(value: unknown) {
            // The top-level setter is the accessor mode's mutation: it applies the credential rule too.
            const stored = kind === SECTION_KIND.llmSecrets ? credentialWrite(null, field, value) : value;
            if (stored === NOT_STORED) {
                return;
            }
            untrack(() => {
                (records[key] as Record<string, unknown>)[field] = stored;
            });
            queueRecordWrite(kind, id);
        },
    });
}

/** Defines an accessor for every own key of the record's data and removes the ones it no longer has. */
function syncAccessors(view: any, kind: string, id: string): void {
    const data = untrack(() => records[keyOf(kind, id)]) as Record<string, unknown>;
    const keys = viewKeys.get(view) ?? new Set<string>();
    viewKeys.set(view, keys);
    const fields = new Set(Object.keys(data));
    for (const field of [...keys]) {
        if (!fields.has(field)) {
            delete view[field];
            keys.delete(field);
        }
    }
    for (const field of fields) {
        if (!keys.has(field)) {
            defineFieldAccessor(view, kind, id, field);
            keys.add(field);
        }
    }
    if (Array.isArray(view) && Array.isArray(data) && view.length > data.length) {
        view.length = data.length;
    }
}

/** Accessor mode: one accessor view per record (cached), its fields synced at every raw application. */
export function projectRecord<T = any>(kind: string, id: string = SINGLETON_RESOURCE_ID): T {
    const key = keyOf(kind, id);
    let view = views.get(key);
    if (!view) {
        const data = untrack(() => records[key]);
        view = Array.isArray(data) ? [] : {};
        views.set(key, view);
        syncAccessors(view, kind, id);
    }
    return view as T;
}

// ---------------------------------------------------------------------------------------------
// Tracked mode: the deep write-through record.

/** Thrown when a retained nested wrapper names an element that no longer exists in its record. */
export class DetachedWrapperError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DetachedWrapperError";
    }
}

type Step =
    | { type: "root" }
    /** A property key (an object field, or an array index for elements without an id). */
    | { type: "key"; key: string }
    /** An element of an allowlisted by-id field (`BY_ID_FIELDS`), resolved by its id; `index` is where it last was. */
    | { type: "id"; field: "id" | "chaId"; id: string; index: number };

interface TrackedNode {
    kind: string;
    id: string;
    key: string;
    meta: RecordMeta;
    parent: TrackedNode | null;
    step: Step;
    isArray: boolean;
    /** The `$state` object this node last resolved to. */
    target: object | undefined;
    /** The record's raw epoch at that resolution. */
    epoch: number;
    /** `structureVersion` at the last full resolution (the resolve cache). */
    version: number;
    /** Canonical child wrappers: by field for an object, by id for id-bearing array elements. */
    keyChildren: Map<string, TrackedNode>;
    idChildren: Map<string, TrackedNode>;
    /** The id-less array element wrappers by the index they last stood at. */
    indexChildren: Map<string, TrackedNode>;
    /** The array mutators handed out for this node (each runs in a mutator scope). */
    mutators: Map<string, (...args: unknown[]) => unknown>;
    proxy: any;
}

const nodeOf = new WeakMap<object, TrackedNode>();
const rootNodes = new Map<string, TrackedNode>();

const isIndex = (key: string) => /^(0|[1-9]\d*)$/.test(key);

/**
 * The resolve cache: bumped by every raw application, local replacement, and structural write
 * through a wrapper (an object value written or replaced, any array write, a delete, a define).
 * Valid only while every write to the records goes through a wrapper or `applyRaw` (a raw write
 * into the `$state` data does not bump it).
 */
let structureVersion = 0;
let resolveCache = false;

/** Turns the resolve cache on or off (`tracked-cached` against `tracked`). */
export function setResolveCache(enabled: boolean): void {
    resolveCache = enabled;
}

/**
 * The array mutators a wrapper runs in a mutator scope: their arguments are unwrapped first (a
 * retained wrapper resolves its current identity, as an ordinary assignment does), then the
 * native method runs through the traps, and the elements it displaces during its own run are
 * written back as the objects it read (`sort` and `copyWithin` rewrite the array in place, so a
 * displaced element is briefly absent and a path or id resolution would miss it).
 */
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
let mutatorDepth = 0;

/**
 * Whether a same-task re-insertion of a displaced element is allowed (`setDisplacedReinsertion`).
 * The indexed swap of `CustomModelsSettings.svelte` (`temp = list[i]; list[i] = list[i - 1];
 * list[i - 1] = temp`) is an ordinary assignment, not a mutator: when `temp` is assigned, its
 * element is absent from the array. With this on, an element displaced by a write through a wrapper
 * in the current task can be assigned back (an id element as the latest object that held its id in
 * this task, an id-less element as itself); after the task it is gone and an assignment throws.
 */
let displacedReinsertion = true;
export function setDisplacedReinsertion(enabled: boolean): void {
    displacedReinsertion = enabled;
}

/** Records an object a write through a wrapper overwrote or deleted (cleared at the end of the task). */
function displace(meta: RecordMeta, old: unknown): void {
    if (!isObject(old)) {
        return;
    }
    meta.displaced.add(old);
    const record = old as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : typeof record.chaId === "string" ? record.chaId : null;
    if (id !== null) {
        meta.displacedById.set(id, old);
    }
    if (!meta.clearScheduled) {
        meta.clearScheduled = true;
        queueMicrotask(() => {
            meta.displaced.clear();
            meta.displacedById.clear();
            meta.clearScheduled = false;
        });
    }
}

/**
 * The `$state` object a node stands for now. Rules:
 * - the root resolves the record by `(kind, id)` from the store on every access, so a cached
 *   wrapper always reaches the current record;
 * - an id step (a preset by `id`) resolves the element by its id, wherever it is now; a missing id
 *   throws (a write never lands in another element);
 * - a key step follows the same path after a raw replacement (`applyRaw`), and after a local
 *   reassignment of an object field; for an array index whose element a local array operation
 *   moved, it follows the element by identity, and throws when the element was removed.
 */
function resolve(node: TrackedNode): any {
    // The cache is skipped inside a tracking context (a template, `$derived`, `$effect`): there the
    // full walk reads the root slot and every step, so a raw replacement re-runs the reaction.
    if (resolveCache && node.version === structureVersion && node.target !== undefined && !$effect.tracking()) {
        return node.target;
    }
    const resolved = resolveFully(node);
    node.version = structureVersion;
    return resolved;
}

function adopt(node: TrackedNode, target: object, epoch: number): void {
    node.target = target;
    node.epoch = epoch;
    node.meta.owned.add(target);
}

function resolveFully(node: TrackedNode): any {
    if (node.parent === null) {
        const data = records[node.key];
        if (!isObject(data)) {
            throw new DetachedWrapperError(`${node.key} is not loaded`);
        }
        adopt(node, data, node.meta.epoch);
        return data;
    }
    const parent = resolve(node.parent);
    const epoch = node.meta.epoch;
    const step = node.step;
    if (step.type === "id") {
        if (node.target !== undefined && parent[step.index] === node.target) {
            return node.target;
        }
        const index = Array.isArray(parent)
            ? parent.findIndex((entry: any) => isObject(entry) && (entry as any)[step.field] === step.id)
            : -1;
        if (index === -1) {
            throw new DetachedWrapperError(`${node.key}: no element with ${step.field} ${step.id}`);
        }
        step.index = index;
        adopt(node, parent[index], epoch);
        return node.target;
    }
    if (step.type !== "key") {
        throw new Error("unreachable");
    }
    const current = parent[step.key];
    if (current === node.target) {
        return current;
    }
    if (node.epoch !== epoch || !Array.isArray(parent) || !isIndex(step.key)) {
        // A raw replacement of the record (same logical record, same path), or a local
        // reassignment of an object field (the path holds the new container).
        if (!isObject(current)) {
            throw new DetachedWrapperError(`${node.key}: nothing at ${step.key} any more`);
        }
        adopt(node, current, epoch);
        if (Array.isArray(parent)) {
            // The canonical wrapper of the element now at this path (identity across a raw replacement).
            node.meta.children.set(current, node);
        }
        return current;
    }
    // A local array operation moved or removed the element: follow it by identity.
    const index = Array.prototype.indexOf.call(parent, node.target);
    if (index === -1) {
        throw new DetachedWrapperError(`${node.key}: the element at [${step.key}] was removed`);
    }
    moveIndexChild(node, String(index));
    return node.target;
}

/**
 * The `$state` object an assignment of a wrapper stores: its current identity (an ordinary
 * assignment never restores what the wrapper stood for earlier). Inside a mutator scope, the
 * object the mutator read during its own run. A wrapper whose element is gone throws, unless the
 * element was displaced by a write in the current task (`setDisplacedReinsertion`).
 */
function assignedTarget(node: TrackedNode): object {
    if (node.parent !== null && mutatorDepth > 0 && node.target !== undefined) {
        return node.target;
    }
    try {
        return untrack(() => resolve(node));
    } catch (error) {
        if (!(error instanceof DetachedWrapperError) || !displacedReinsertion || node.parent === null) {
            throw error;
        }
        const step = node.step;
        const displaced =
            step.type === "id"
                ? node.meta.displacedById.get(step.id)
                : node.target !== undefined && node.meta.displaced.has(node.target)
                  ? node.target
                  : undefined;
        if (displaced === undefined) {
            throw error;
        }
        return displaced;
    }
}

/** A plain, detached copy (own `__proto__` kept as a key) of a value, through wrappers and Svelte proxies. */
function detachedCopy(value: object, seen = new Map<object, unknown>()): unknown {
    const node = nodeOf.get(value);
    const source = node ? assignedTarget(node) : value;
    if (seen.has(source)) {
        return seen.get(source);
    }
    const out: any = Array.isArray(source) ? [] : {};
    seen.set(source, out);
    untrack(() => {
        for (const key of Reflect.ownKeys(source)) {
            if (typeof key === "symbol" || (Array.isArray(source) && key === "length")) {
                continue;
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
            if (!descriptor?.enumerable) {
                continue;
            }
            const entry = (source as any)[key];
            Object.defineProperty(out, key, {
                value: isObject(entry) ? detachedCopy(entry, seen) : entry,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
    });
    return out;
}

/**
 * A value written into record `destKey` through a wrapper follows these rules:
 * - a wrapper of the same record stores its current `$state` object (`assignedTarget`);
 * - a wrapper of another record stores a detached copy (no record aliases another record's state);
 * - a Svelte proxy the destination record owns (reached through its wrappers) is stored as is;
 * - any other Svelte proxy (a component's `$state` editing copy, another record's raw data) is
 *   normalized: stored as a detached copy, with the wrappers in it resolved, so the record never
 *   holds a wrapper and never shares an editing copy's state;
 * - a plain object or array is kept, with the wrappers in it replaced in place by these rules.
 */
function unwrap(value: unknown, destKey: string, seen = new Set<object>()): unknown {
    if (!isObject(value)) {
        return value;
    }
    const node = nodeOf.get(value);
    if (node) {
        return node.key === destKey ? assignedTarget(node) : detachedCopy(value);
    }
    if (STATE in value) {
        const meta = metas.get(destKey);
        const owned = (meta && meta.owned.has(value)) || untrack(() => records[destKey]) === value;
        return owned ? value : detachedCopy(value);
    }
    if (seen.has(value)) {
        return value;
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor && "value" in descriptor && isObject(descriptor.value)) {
            const inner = unwrap(descriptor.value, destKey, seen);
            // `Object.is`, not `!==`: in dev, Svelte compiles `===` in a `.svelte.ts` file to
            // `strict_equals`, which warns (`state_proxy_equality_mismatch`) when a wrapper and the
            // `$state` object it stands for are compared (both unwrap to the same raw object).
            if (!Object.is(inner, descriptor.value)) {
                // `defineProperty`, never an assignment: an own `__proto__` key stays a key.
                Object.defineProperty(value, key, { ...descriptor, value: inner });
            }
        }
    }
    return value;
}

/** A plain value with every wrapper in it replaced (for the credential container rule). */
function unwrapPlain(value: unknown): unknown {
    return isObject(value) && (nodeOf.has(value) || STATE in value) ? detachedCopy(value) : value;
}

/** Moves an id-less element wrapper to the index it stands at now. */
function moveIndexChild(node: TrackedNode, index: string): void {
    const step = node.step as { key: string };
    const parent = node.parent!;
    if (parent.indexChildren.get(step.key) === node) {
        parent.indexChildren.delete(step.key);
    }
    step.key = index;
    parent.indexChildren.set(index, node);
}

function createChild(parentNode: TrackedNode, step: Step, value: object): TrackedNode {
    const node = createNode(parentNode.kind, parentNode.id, parentNode, step, value, parentNode.meta.epoch);
    node.version = structureVersion;
    parentNode.meta.owned.add(value);
    return node;
}

/**
 * The record fields whose array elements get by-id identity. Only a field whose ids the
 * server normalizer makes unique (a repeated id is re-keyed) is listed. Every other array element,
 * with or without an `id` (lorebook entries: `loreBook.id` is optional, an export keeps it, and a
 * re-import duplicates it; no normalizer dedupes `globalLore`), uses object/path identity.
 * - `presets` (the record root): `normalizePresets`, `shared/presets.ts` ("a duplicate id
 *   re-keyed", the `seen` set).
 * The selectable collections (`translatorPresets`, `hypaV3Presets`: `selectableList`,
 * `server/src/data/normalize/collections.ts`, the `seen` set) qualify too, but they are not among
 * the harness's records, so they are not modeled.
 */
const BY_ID_FIELDS: readonly { kind: string; field: null; idField: "id"; normalizer: string }[] = [
    { kind: PRESETS_KIND, field: null, idField: "id", normalizer: "shared/presets.ts normalizePresets" },
];

/** The id field of `parentNode`'s array elements when the array is an allowlisted by-id field, else null. */
function byIdField(parentNode: TrackedNode): "id" | null {
    for (const entry of BY_ID_FIELDS) {
        if (entry.kind === parentNode.kind && entry.field === null && parentNode.parent === null) {
            return entry.idField;
        }
    }
    return null;
}

/** Thrown when a write goes through a by-id wrapper whose id matches more than one element. */
export class DuplicateIdError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DuplicateIdError";
    }
}

/**
 * Refuses, before any state changes, a write through a wrapper with a by-id step (itself or an
 * ancestor) whose id now matches more than one element of its array: the uniqueness the
 * normalizer guarantees can be broken between a local write and the next normalization (a local
 * `push` of a copy), and then the write's element is ambiguous.
 */
function assertUniqueIds(node: TrackedNode): void {
    for (let current: TrackedNode | null = node; current !== null; current = current.parent) {
        const step = current.step;
        if (step.type !== "id" || current.parent === null) {
            continue;
        }
        const list = untrack(() => resolve(current!.parent!));
        let matches = 0;
        for (let index = 0; index < list.length; index += 1) {
            const entry = list[index];
            if (isObject(entry) && Object.is((entry as any)[step.field], step.id)) {
                matches += 1;
            }
        }
        if (matches > 1) {
            throw new DuplicateIdError(`${current.key}: ${matches} elements have ${step.field} ${step.id}`);
        }
    }
}

/**
 * The nested wrapper for `value` at `prop` of `parentNode`. One canonical wrapper per logical item:
 * per field for an object's child; per id for an element of an allowlisted by-id field
 * (`BY_ID_FIELDS`: a retained and a freshly fetched wrapper of the same preset are the same object
 * across reorders and raw replacements); per `$state` object for any other array element, id-bearing
 * or not (canonical within the record's local life, following the element through local moves and
 * an id it gains; after a raw replacement, the wrapper that stood at the index claims the element
 * now there).
 */
function childWrapper(parentNode: TrackedNode, parentTarget: any, prop: string, value: object): any {
    const epoch = parentNode.meta.epoch;
    const refresh = (node: TrackedNode) => {
        if (node.target !== value) {
            node.meta.owned.add(value);
        }
        node.target = value;
        node.epoch = epoch;
        // Just read from its freshly resolved parent: valid for the current structure.
        node.version = structureVersion;
        return node.proxy;
    };
    if (Array.isArray(parentTarget)) {
        const record = value as Record<string, unknown>;
        const allowlisted = byIdField(parentNode);
        const field = allowlisted !== null && typeof record[allowlisted] === "string" ? allowlisted : null;
        if (field) {
            const id = record[field] as string;
            const existing = parentNode.idChildren.get(id);
            if (existing && existing.isArray === Array.isArray(value)) {
                (existing.step as { index: number }).index = Number(prop);
                return refresh(existing);
            }
            const node = createChild(parentNode, { type: "id", field, id, index: Number(prop) }, value);
            parentNode.idChildren.set(id, node);
            return node.proxy;
        }
        let existing = parentNode.meta.children.get(value);
        if (!existing || existing.parent !== parentNode) {
            // After a raw replacement, the wrapper that stood at this index before it stands for
            // the element now there (the same-path rule of `resolveFully`), so a retained and a
            // freshly fetched wrapper of the element are one object.
            const previous = parentNode.indexChildren.get(prop);
            existing =
                previous && previous.epoch !== epoch && previous.isArray === Array.isArray(value)
                    ? previous
                    : undefined;
        }
        if (existing) {
            moveIndexChild(existing, prop);
            parentNode.meta.children.set(value, existing);
            return refresh(existing);
        }
        const node = createChild(parentNode, { type: "key", key: prop }, value);
        parentNode.meta.children.set(value, node);
        parentNode.indexChildren.set(prop, node);
        return node.proxy;
    }
    const existing = parentNode.keyChildren.get(prop);
    if (existing && existing.isArray === Array.isArray(value)) {
        return refresh(existing);
    }
    const node = createChild(parentNode, { type: "key", key: prop }, value);
    parentNode.keyChildren.set(prop, node);
    return node.proxy;
}

/** The top-level container of `node` in the `llmSecrets` record (null for the root). */
function llmContainer(node: TrackedNode): string | null | undefined {
    if (node.kind !== SECTION_KIND.llmSecrets) {
        return undefined;
    }
    if (node.parent === null) {
        return null;
    }
    if (node.parent.parent === null && node.step.type === "key") {
        return node.step.key;
    }
    return undefined;
}

/**
 * Whether assigning `prop` on `target` would not create an own key (`assignsInherited`,
 * `shared/mutationValidation.ts`): the Svelte proxy accepts such an assignment without storing it.
 */
function assignsInheritedName(target: object, prop: string): boolean {
    return prop === "__proto__" || (prop in Object.prototype && !Object.hasOwn(target, prop));
}

/** Puts a rebuilt container where `node`'s object was (the caller of `writeEntries` does this). */
function install(node: TrackedNode, next: object): void {
    structureVersion += 1;
    if (node.parent === null) {
        records[node.key] = next;
        return;
    }
    const parent = resolve(node.parent);
    const step = node.step;
    const slot = step.type === "id" ? step.index : (step as { key: string }).key;
    displace(node.meta, parent[slot]);
    parent[slot] = next;
}

function writeThrough(node: TrackedNode, prop: string, value: unknown): boolean {
    assertUniqueIds(node);
    const target = resolve(node);
    const container = llmContainer(node);
    let incoming = value;
    if (container !== undefined) {
        incoming = credentialWrite(container, prop, value);
        if (incoming === NOT_STORED) {
            return true;
        }
    }
    // Unwrapped (and validated: a gone wrapper throws) before anything changes.
    const plain = unwrap(incoming, node.key);
    if (!Array.isArray(target) && assignsInheritedName(target, prop)) {
        // An own `__proto__` (or `constructor`, ...) key: rebuilt the way `writeEntries` does it,
        // then installed in the parent, so it becomes an own key and no prototype changes.
        install(node, writeEntries(target, [[prop, plain]])!);
    } else {
        if (isObject(plain) || Array.isArray(target) || node.keyChildren.has(prop)) {
            structureVersion += 1;
            displace(node.meta, target[prop]);
        }
        target[prop] = plain;
    }
    queueRecordWrite(node.kind, node.id);
    return true;
}

function createNode(
    kind: string,
    id: string,
    parent: TrackedNode | null,
    step: Step,
    target: object | undefined,
    epoch: number,
): TrackedNode {
    const isArray = Array.isArray(target);
    const node: TrackedNode = {
        kind,
        id,
        key: keyOf(kind, id),
        meta: metaOf(keyOf(kind, id)),
        parent,
        step,
        isArray,
        target,
        epoch,
        version: -1,
        keyChildren: new Map(),
        idChildren: new Map(),
        indexChildren: new Map(),
        mutators: new Map(),
        proxy: null,
    };
    // The proxy target is a stand-in of the same shape (an array keeps `Array.isArray` and
    // `JSON.stringify` treating the wrapper as an array); every trap answers from the resolved
    // `$state` object, which keeps the proxy invariants (the stand-in's only fixed property is an
    // array's writable `length`, which the resolved array also has).
    const standIn = isArray ? [] : {};
    node.proxy = new Proxy(standIn, {
        get(_, prop) {
            const resolved = resolve(node);
            if (typeof prop === "symbol") {
                return Reflect.get(resolved, prop);
            }
            const value = resolved[prop];
            if (typeof value === "function" && Array.isArray(resolved) && MUTATORS.has(prop)) {
                let mutator = node.mutators.get(prop);
                if (!mutator) {
                    const native = value as (...args: unknown[]) => unknown;
                    mutator = (...args: unknown[]) => {
                        const plainArgs = untrack(() => args.map((arg) => unwrap(arg, node.key)));
                        mutatorDepth += 1;
                        try {
                            return Reflect.apply(native, node.proxy, plainArgs);
                        } finally {
                            mutatorDepth -= 1;
                        }
                    };
                    node.mutators.set(prop, mutator);
                }
                return mutator;
            }
            // An inherited `__proto__` read returns the prototype, which is never wrapped.
            if (isObject(value) && (prop !== "__proto__" || Object.hasOwn(resolved, prop))) {
                return childWrapper(node, resolved, prop, value);
            }
            return value;
        },
        set(_, prop, value) {
            if (typeof prop === "symbol") {
                return Reflect.set(
                    untrack(() => resolve(node)),
                    prop,
                    value,
                );
            }
            // Writes resolve untracked (as the forwarding setters do): an `$effect` that writes
            // through a wrapper must not subscribe to the path it writes.
            return untrack(() => writeThrough(node, prop, value));
        },
        deleteProperty(_, prop) {
            return untrack(() => {
                assertUniqueIds(node);
                const resolved = resolve(node);
                const container = llmContainer(node);
                if (container !== undefined && typeof prop === "string") {
                    credentialDelete(container, prop);
                }
                structureVersion += 1;
                displace(node.meta, resolved[prop]);
                const done = Reflect.deleteProperty(resolved, prop);
                queueRecordWrite(node.kind, node.id);
                return done;
            });
        },
        defineProperty(_, prop, descriptor) {
            return untrack(() => {
                assertUniqueIds(node);
                const resolved = resolve(node);
                if (
                    typeof prop === "string" &&
                    "value" in descriptor &&
                    (llmContainer(node) !== undefined ||
                        (!Array.isArray(resolved) && assignsInheritedName(resolved, prop)))
                ) {
                    // The credential rule and an own inherited-name key go the `set` way: a
                    // `defineProperty` of `__proto__` through the Svelte proxy stores a source that
                    // its `ownKeys` never lists (`'__proto__' in target`), so JSON would drop it.
                    return writeThrough(node, prop, descriptor.value);
                }
                structureVersion += 1;
                const prepared =
                    "value" in descriptor ? { ...descriptor, value: unwrap(descriptor.value, node.key) } : descriptor;
                const done = Reflect.defineProperty(resolved, prop, prepared);
                queueRecordWrite(node.kind, node.id);
                return done;
            });
        },
        has(_, prop) {
            return Reflect.has(resolve(node), prop);
        },
        ownKeys() {
            return Reflect.ownKeys(resolve(node));
        },
        getOwnPropertyDescriptor(_, prop) {
            const resolved = resolve(node);
            const descriptor = Reflect.getOwnPropertyDescriptor(resolved, prop);
            if (descriptor && "value" in descriptor && typeof prop === "string" && isObject(descriptor.value)) {
                // Svelte's `getOwnPropertyDescriptor` returns the raw target's descriptor (an
                // unproxied value) for a key it has no source for yet; the value is read through
                // the proxy instead, so the wrapper stands for the `$state` object.
                descriptor.value = childWrapper(node, resolved, prop, resolved[prop]);
            }
            return descriptor;
        },
        getPrototypeOf() {
            return Reflect.getPrototypeOf(resolve(node));
        },
        setPrototypeOf() {
            return false;
        },
        preventExtensions() {
            return false;
        },
    });
    nodeOf.set(node.proxy, node);
    if (target !== undefined) {
        node.meta.owned.add(target);
    }
    return node;
}

/** Tracked mode: the record's root wrapper (cached), resolving the record by `(kind, id)` on every access. */
export function trackedRecord<T = any>(kind: string, id: string = SINGLETON_RESOURCE_ID): T {
    const key = keyOf(kind, id);
    let node = rootNodes.get(key);
    if (!node) {
        node = createNode(kind, id, null, { type: "root" }, untrack(() => records[key]) as object, metaOf(key).epoch);
        rootNodes.set(key, node);
    }
    return node.proxy as T;
}

/** The chosen mode's record wrapper. */
export function recordView<T = any>(candidate: Candidate, kind: string, id: string = SINGLETON_RESOURCE_ID): T {
    return candidate === "accessor" ? projectRecord<T>(kind, id) : trackedRecord<T>(kind, id);
}

// ---------------------------------------------------------------------------------------------
// Inspection helpers for the test file (which may not use runes, STRUCTURE.md T3).

/**
 * The paths in the live `$state` records (read through the Svelte proxies, not a snapshot) that
 * hold a tracked wrapper or a accessor view, at any depth. Ordinary Svelte proxies are fine.
 */
export function findLiveWrappers(): string[] {
    const found: string[] = [];
    const seen = new Set<object>();
    const walk = (value: unknown, path: string) => {
        if (!isObject(value)) {
            return;
        }
        if (isTrackedWrapper(value) || isAccessorView(value)) {
            found.push(path);
            return;
        }
        if (seen.has(value)) {
            return;
        }
        seen.add(value);
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key === "symbol") {
                continue;
            }
            walk((value as any)[key], `${path}.${key}`);
        }
    };
    untrack(() => {
        for (const key of Object.keys(records)) {
            walk(records[key], key);
        }
    });
    return found;
}

/** A value held as `$state` (a component's editing copy). */
export function stateContainer<T>(value: T): T {
    const box = $state({ value });
    return box.value;
}

/**
 * Observes `read()` through a `$derived` inside an `$effect.root`; `current()` is the derived
 * value now, `runs` how many times it was computed.
 */
export function derivedProbe<T>(read: () => T): { current: () => T; runs: () => number; dispose: () => void } {
    let runs = 0;
    let current: () => T = read;
    const dispose = $effect.root(() => {
        const value = $derived.by(() => {
            runs += 1;
            return read();
        });
        current = () => value;
        $effect(() => {
            void value;
        });
    });
    flushSync();
    return { current: () => current(), runs: () => runs, dispose };
}

// ---------------------------------------------------------------------------------------------
// The root facade.

const presetFieldOf: Record<string, string> = PRESET_ROOT_ALIASES;

/** The index of the selected preset in the presets record (tracked), or -1. */
function selectedPresetIndex(): number {
    const list = records[keyOf(PRESETS_KIND, SINGLETON_RESOURCE_ID)];
    return Array.isArray(list) ? list.findIndex((preset: any) => preset?.id === selection.presetId) : -1;
}

function defineAccessor(raw: object, key: string, get: () => unknown, set: (value: unknown) => void): void {
    Object.defineProperty(raw, key, { enumerable: true, configurable: true, get, set });
}

/**
 * Builds the facade for `candidate` and makes it `prototypeRoot.db`:
 * - each section field forwards to its section record's wrapper;
 * - `botPresets` is the presets record wrapper (an assignment replaces the record locally, queued);
 * - each forwarded preset field (by its root name, `PRESET_ROOT_ALIASES`) reads the selected preset
 *   and writes the preset selected at the write (resolved untracked), through the presets wrapper;
 * - `characters` is a read-only list of the character record wrappers (membership changes only
 *   through explicit mutation functions, as in production).
 */
export function mountFacade(candidate: Candidate, characterIds: readonly string[]): Database {
    setResolveCache(candidate === "tracked-cached");
    const raw: Record<string, unknown> = {};
    const view = (kind: string, id: string = SINGLETON_RESOURCE_ID) => recordView<any>(candidate, kind, id);
    for (const kind of FACADE_SECTIONS) {
        for (const field of SECTION_FIELDS[kind] as readonly string[]) {
            defineAccessor(
                raw,
                field,
                () => view(kind)[field],
                (value) => {
                    view(kind)[field] = value;
                },
            );
        }
    }
    defineAccessor(
        raw,
        "botPresets",
        () => view(PRESETS_KIND),
        (value) => replaceLocal(PRESETS_KIND, SINGLETON_RESOURCE_ID, value),
    );
    for (const rootKey of FORWARDED_PRESET_KEYS as readonly string[]) {
        const field = presetFieldOf[rootKey] ?? rootKey;
        defineAccessor(
            raw,
            rootKey,
            () => {
                const index = selectedPresetIndex();
                return index === -1 ? undefined : view(PRESETS_KIND)[index][field];
            },
            (value) => {
                // The preset selected at the write (`presetForWrite`, untracked); none: dropped.
                const index = untrack(selectedPresetIndex);
                if (index !== -1) {
                    view(PRESETS_KIND)[index][field] = value;
                }
            },
        );
    }
    // `proxyKey` (as the removed `forwarding.svelte.ts` served it): reads `""` (the tab never holds
    // the key; the read still resolves the selection), a write goes to the selected preset's
    // `llmSecrets` entry through `setSecret` (a blank or non-string value clears it), resolved
    // untracked. The prototype predates the preset split: its one presets record stands in for the
    // model preset that owns the entry, so the path names the `modelPresets` map. Production has no
    // such map since the model profiles replaced per-preset keys; the prototype keeps its historical
    // model, so the path is cast (the queue it reaches is never sent here).
    defineAccessor(
        raw,
        "proxyKey",
        () => {
            selectedPresetIndex();
            return "";
        },
        (value) => {
            untrack(() => {
                const index = selectedPresetIndex();
                const preset =
                    index === -1 ? undefined : (records[keyOf(PRESETS_KIND, SINGLETON_RESOURCE_ID)] as any[])[index];
                if (preset === undefined) {
                    return;
                }
                routeSecret(
                    { kind: "entry", field: "modelPresets", id: preset.id } as unknown as SecretPath,
                    typeof value === "string" ? value : "",
                );
            });
        },
    );
    const characters = Object.freeze(characterIds.map((id) => view(CHARACTERS_KIND, id)));
    defineAccessor(
        raw,
        "characters",
        () => characters,
        () => {
            throw new TypeError("character membership is not a facade write");
        },
    );
    prototypeRoot.db = raw as unknown as Database;
    return prototypeRoot.db;
}

/** Switches the preset selection only (no copy). */
export function switchPreset(id: string): void {
    selection.presetId = id;
}

/** `$state.snapshot` for the test file, which may not use runes (STRUCTURE.md T3). */
export function snapshot<T>(value: T): T {
    return $state.snapshot(value) as T;
}
