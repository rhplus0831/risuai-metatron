import { untrack } from "svelte";
import {
    FLAT_SECRET_FIELDS,
    NESTED_SECRET_FIELDS,
    SECRET_ENTRY_MAPS,
    type FlatSecretField,
    type SecretEntryMap,
    type SecretPath,
} from "../../../shared/llmSecrets.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    SECTION_FIELDS,
    SECTION_KIND,
    type CollectionKind,
    type SectionKind,
} from "../../../shared/sections.ts";
import { clearSecret, setSecret } from "./llmSecrets.svelte";
import { writeEntries } from "./mutationValidation";

/**
 * The settings records (Phase 6 slice 4, `settings-ownership`): the source of truth of the five
 * sections, the thirteen settings collections, and `presets`, `modules`, `plugins`, `pluginStorage`
 * (all singletons). Each record is a deep write-through record, the pattern the Phase 6 spike chose
 * and the owner confirmed at Stop A (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/
 * spike-projection-bindings.md`, "Verdict"): `trackedRecord(kind)` is a JS `Proxy` over the record's
 * `$state` data whose every trap resolves the current data; a read of a nested container returns its
 * own wrapper; a write, `delete`, or `defineProperty` at any depth goes into the `$state` data and
 * queues the record's write in the same task (`setRecordWriteListener`: the save loop's `markKey`).
 * `DBState.db`'s root fields for these kinds are accessors onto the records (`forwarding.svelte.ts`).
 *
 * Paths into a record:
 * - `initializeRecords` (an installation: boot, a test fixture) replaces the whole set and
 *   `applyRaw` (a server copy: a conflict reload, a live update, a job hydration) replaces one
 *   record; neither queues a write.
 * - `replaceRecord` (a local whole-record replacement, `db.botPresets = [...]`) and every write
 *   through a wrapper queue one.
 * - `batchRecordWrites(fn)` runs a bulk writer: the record writes inside it are queued once per
 *   kind when it ends.
 *
 * Wrapper rules (the spike's, `src/ts/storage/tests/projectionHarness.svelte.ts`):
 * - Identity: the root wrapper resolves its record by kind on every trap, so a retained wrapper
 *   reaches the record after a replacement. One wrapper per logical item: an object's child by its
 *   field; an element of an allowlisted by-id list (`BY_ID_FIELDS`) by its id, wherever it moved; any
 *   other element by its `$state` object (followed through local moves), and across a raw replacement
 *   by its path. A write through a wrapper whose item is gone throws `DetachedWrapperError`, and one
 *   through a by-id wrapper whose id now matches several elements `DuplicateIdError`, before anything
 *   changes.
 * - Assignment: a wrapper of the same record stores its item's current object; a wrapper of another
 *   record, or a `$state` object the record does not own (a component's editing copy), is stored as a
 *   detached copy, so a record never holds a wrapper or shares another object's state. Array mutators
 *   run in a mutator scope (the elements they displace are written back as they were read), and an
 *   element a write displaced in the current task may be assigned back (an indexed swap).
 * - An own `__proto__` (or other inherited-name) key is rebuilt through `writeEntries`.
 * - Writes and replacements run untracked; comparisons use `Object.is` (in dev, Svelte compiles `===`
 *   in a `.svelte.ts` file to a check that reads through the wrapper's traps).
 * - Credentials never enter a record: on `llmSecrets` every credential path is routed to `setSecret`
 *   / `clearSecret` or refused (the record holds the mirror form, `mirrorFields`); a preset's
 *   `proxyKey` and a custom model's `key` likewise (`SECRET_ENTRY_MAPS`), on a leaf write and on any
 *   element or list written whole (a non-empty one is routed with the element's id, a blank or absent
 *   one changes nothing, a leaf assignment of `""` clears). Every value is validated before either the
 *   record or the credential queue changes.
 * - A read never writes, and nothing is wrapped while its record is absent (`hasRecord`).
 */

/** Every kind held here. */
export const RECORD_KINDS = [
    "presets",
    "modules",
    "plugins",
    "pluginStorage",
    ...Object.values(SECTION_KIND),
    ...Object.values(COLLECTION_KIND),
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

const recordKinds = new Set<string>(RECORD_KINDS);

/** Whether `kind` is held by the records (the save loop's settings kinds). */
export function isRecordKind(kind: string): kind is RecordKind {
    return recordKinds.has(kind);
}

/** The root field of each record that is one value (`botPresets` is the `presets` record, ...). */
export const RECORD_ROOT_FIELDS: Readonly<Record<string, string>> = {
    presets: "botPresets",
    modules: "modules",
    plugins: "plugins",
    pluginStorage: "pluginCustomStorage",
    ...Object.fromEntries(
        Object.entries(COLLECTION_FIELDS).filter(([kind]) => !Object.hasOwn(COLLECTION_SELECTION_FIELDS, kind)),
    ),
};

/** The selectable collections: the record is `{ items, selectedId }`, the root has two fields. */
export const SELECTABLE_ROOT_FIELDS: Readonly<Record<string, { items: string; selectedId: string }>> =
    Object.fromEntries(
        Object.entries(COLLECTION_SELECTION_FIELDS).map(([kind, selectedId]) => [
            kind,
            { items: COLLECTION_FIELDS[kind as CollectionKind], selectedId },
        ]),
    );

/**
 * Takes the record fields out of a database object that has no record accessors yet (boot's
 * assembled object, a test fixture): each own data property of a record field is removed from
 * `raw`, and the records it describes are returned for `initializeRecords` (a section from the
 * section fields present, in `SECTION_FIELDS` order; a selectable collection from its two fields).
 */
export function takeRecordFields(raw: Record<string, unknown>): Partial<Record<RecordKind, unknown>> {
    const fields: Partial<Record<RecordKind, unknown>> = {};
    const take = (key: string): { found: boolean; value: unknown } => {
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (!descriptor || !("value" in descriptor)) {
            return { found: false, value: undefined };
        }
        delete raw[key];
        return { found: true, value: descriptor.value };
    };
    for (const section of Object.values(SECTION_KIND) as SectionKind[]) {
        const record: Record<string, unknown> = {};
        let any = false;
        for (const field of SECTION_FIELDS[section] as readonly string[]) {
            const { found, value } = take(field);
            if (found) {
                any = true;
                if (value !== undefined) {
                    record[field] = value;
                }
            }
        }
        if (any) {
            fields[section] = record;
        }
    }
    for (const [kind, field] of Object.entries(RECORD_ROOT_FIELDS)) {
        const { found, value } = take(field);
        if (found && value !== undefined) {
            fields[kind as RecordKind] = value;
        }
    }
    for (const [kind, names] of Object.entries(SELECTABLE_ROOT_FIELDS)) {
        const items = take(names.items);
        const selectedId = take(names.selectedId);
        if (items.found || selectedId.found) {
            fields[kind as RecordKind] = { items: items.value ?? [], selectedId: selectedId.value ?? null };
        }
    }
    return fields;
}

// ---------------------------------------------------------------------------------------------
// Svelte internals.

/**
 * Svelte's `STATE_SYMBOL` (`svelte/src/internal/client/constants.js`), which the package does not
 * export: `proxy()` asks `STATE_SYMBOL in value` of any object it is given, so a probe assigned into
 * a `$state` sees the symbol in its `has` trap. Used to tell a Svelte proxy from a plain object.
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

const isObject = (value: unknown): value is object => typeof value === "object" && !Object.is(value, null);

/** Whether `value` is a record wrapper. */
export function isRecordWrapper(value: unknown): boolean {
    return isObject(value) && nodeOf.has(value);
}

// ---------------------------------------------------------------------------------------------
// The store.

/** Each record's data, as `$state`: a read of `records[kind]` is tracked, so a replacement re-renders. */
const records: Record<string, unknown> = $state({});

/** Per record (not reactive): the raw-application epoch and the wrapper bookkeeping. */
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

function metaOf(kind: string): RecordMeta {
    let meta = metas.get(kind);
    if (!meta) {
        meta = {
            epoch: 0,
            children: new WeakMap(),
            owned: new WeakSet(),
            displaced: new Set(),
            displacedById: new Map(),
            clearScheduled: false,
        };
        metas.set(kind, meta);
    }
    return meta;
}

let writeListener: ((kind: RecordKind) => void) | null = null;
let batchDepth = 0;
const batchedKinds = new Set<RecordKind>();

/** Registers the save loop's hook: called with a record's kind whenever a local write changed it. */
export function setRecordWriteListener(listener: ((kind: RecordKind) => void) | null) {
    writeListener = listener;
}

/** Queues the record's write (inside `batchRecordWrites`, once per kind when it ends). */
export function queueRecordWrite(kind: RecordKind) {
    if (batchDepth > 0) {
        batchedKinds.add(kind);
        return;
    }
    writeListener?.(kind);
}

/**
 * Runs a bulk writer (`fn` is synchronous): its record writes are queued once per kind when the
 * outermost scope ends, also when `fn` throws (what it wrote is queued).
 */
export function batchRecordWrites<T>(fn: () => T): T {
    batchDepth += 1;
    try {
        return fn();
    } finally {
        batchDepth -= 1;
        if (batchDepth === 0 && batchedKinds.size > 0) {
            const kinds = [...batchedKinds];
            batchedKinds.clear();
            for (const kind of kinds) {
                writeListener?.(kind);
            }
        }
    }
}

/** Whether the record is loaded (tracked). */
export function hasRecord(kind: RecordKind): boolean {
    return isObject(records[kind]);
}

/** The record's live `$state` data, read untracked (serialization, comparisons); undefined when absent. */
export function recordData<T = unknown>(kind: RecordKind): T | undefined {
    return untrack(() => records[kind]) as T | undefined;
}

/**
 * The application path of a server copy (a conflict reload, a live update, a job hydration):
 * replaces the record and never queues a write; `undefined` removes it. `llmSecrets` takes the
 * mirror form (`mirrorFields`). The caller keeps its admission rules (revision, in-flight, local
 * change).
 */
export function applyRaw(kind: RecordKind, data: unknown) {
    const meta = metaOf(kind);
    meta.epoch += 1;
    untrack(() => {
        if (data === undefined) {
            delete records[kind];
        } else {
            records[kind] = data;
        }
    });
}

/**
 * An installation (boot, a test fixture): replaces the whole record set with `fields` (a kind it
 * lacks is removed) and never queues a write.
 */
export function initializeRecords(fields: Partial<Record<RecordKind, unknown>>) {
    for (const kind of RECORD_KINDS) {
        applyRaw(kind, Object.hasOwn(fields, kind) ? fields[kind] : undefined);
    }
}

/**
 * Forgets every record, wrapper, and the write listener (a test's fresh start: the save loop is
 * started again, or its module loaded afresh). Wrappers a test still holds from before stay detached.
 */
export function resetRecords() {
    writeListener = null;
    untrack(() => {
        for (const kind of Object.keys(records)) {
            delete records[kind];
        }
    });
    metas.clear();
    rootNodes.clear();
    batchDepth = 0;
    batchedKinds.clear();
    mutatorDepth = 0;
}

/**
 * A local whole-record replacement (`db.botPresets = [...]`): the value is prepared (credentials
 * routed and stripped, wrappers resolved) before anything changes, stored, and the write queued.
 */
export function replaceRecord(kind: RecordKind, value: unknown) {
    untrack(() => {
        if (kind === SECTION_KIND.llmSecrets) {
            assertNoLlmCredential(value);
        }
        const prepared = prepareEntryCredentials(kind, value, true);
        const plain = unwrap(prepared.value, kind);
        records[kind] = plain;
        prepared.route();
    });
    queueRecordWrite(kind);
}

/**
 * Writes `field` of a record object through its wrapper; when the record is absent (a sparse test
 * fixture) it is created holding that field, after the value passed the same checks (credentials
 * routed or refused, wrappers resolved), so a refusal creates nothing.
 */
export function writeRecordField(kind: RecordKind, field: string, value: unknown) {
    const record = untrack(() => trackedRecord<Record<string, unknown>>(kind));
    if (record !== undefined) {
        record[field] = value;
        return;
    }
    untrack(() => {
        let stored: unknown = value;
        let route: () => void = () => {};
        if (kind === SECTION_KIND.llmSecrets) {
            const write = llmSecretWrite(null, field, value);
            if (write === NOT_STORED) {
                records[kind] = {};
                return;
            }
            stored = write.value;
            route = write.route;
        }
        const plain = unwrap(stored, kind);
        const created: Record<string, unknown> = {};
        Object.defineProperty(created, field, { value: plain, enumerable: true, writable: true, configurable: true });
        records[kind] = created;
        route();
    });
    queueRecordWrite(kind);
}

/**
 * Refuses a whole `llmSecrets` value that carries a credential (a non-blank flat field, nested leaf,
 * or `OaiCompAPIKeys` entry, or an entry map): a local replacement holds the mirror form only, and a
 * credential is written through `setSecret`.
 */
function assertNoLlmCredential(value: unknown) {
    if (!isObject(value) || Array.isArray(value)) {
        throw new CredentialRefusedError("llmSecrets must be an object");
    }
    const record = unwrapPlain(value) as Record<string, unknown>;
    const blank = (entry: unknown) => entry === undefined || entry === null || entry === "";
    for (const field of flatSecretFields) {
        if (!blank(record[field])) {
            throw new CredentialRefusedError(`${field}: credentials are written through setSecret`);
        }
    }
    for (const [field, leaf] of Object.entries(nestedSecretLeaf)) {
        const container = record[field];
        if (container === undefined) {
            continue;
        }
        if (!isObject(container) || Array.isArray(container)) {
            throw new CredentialRefusedError(`${field}: a credential container must be an object`);
        }
        if (!blank((container as Record<string, unknown>)[leaf])) {
            throw new CredentialRefusedError(`${field}.${leaf}: credentials are written through setSecret`);
        }
    }
    const map = record.OaiCompAPIKeys;
    if (map !== undefined && (!isObject(map) || Array.isArray(map))) {
        throw new CredentialRefusedError("OaiCompAPIKeys must be a map");
    }
    if (isObject(map) && Object.values(map).some((entry) => !blank(entry))) {
        throw new CredentialRefusedError("OaiCompAPIKeys: credentials are written through setSecret");
    }
    for (const field of Object.keys(entryLeaf)) {
        if (record[field] !== undefined) {
            throw new CredentialRefusedError(`${field}: credential entries are written through setSecret`);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Credentials (`llmSecrets` is write-only: `shared/llmSecrets.ts`, Phase 5 slice 7b).
//
// Through a wrapper a credential is never stored in a record and never silently lost:
// - `llmSecrets` holds the mirror form (`mirrorFields`: every credential field reads `""`):
//   - a flat credential (`openAIKey`, ...): a string is set (`""` clears), `null`/`undefined` clears,
//     anything else is refused;
//   - a nested leaf (`google.accessToken`, `hordeConfig.apiKey`, `novelai.token`): the same;
//   - a whole container (`google = { projectId, accessToken }`): the siblings go to the record (the
//     leaf stored blank), a non-empty string leaf is set, a blank or absent leaf changes nothing (it
//     is what the mirror reads, so `{ ...db.google, projectId }` never clears the key), any other
//     leaf value refuses the whole write;
//   - `OaiCompAPIKeys.<id>` (and a whole `OaiCompAPIKeys` map, entry by entry): as a flat credential;
//   - the entry maps (`presets`, `customModels`) are not in this record: a write of them is refused;
//   - `delete` of any credential path is refused (use `clearSecret`).
// - `presets[].proxyKey` and `customModels[].key` (`SECRET_ENTRY_MAPS`): see `prepareEntryCredentials`.

class CredentialRefusedError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = "CredentialRefusedError";
    }
}
export { CredentialRefusedError };

const flatSecretFields = new Set<string>(FLAT_SECRET_FIELDS);
const nestedSecretLeaf: Record<string, string> = NESTED_SECRET_FIELDS;
const entryLeaf: Record<string, string> = SECRET_ENTRY_MAPS;

function routeSecret(path: SecretPath, value: string) {
    if (value === "") {
        clearSecret(path);
    } else {
        setSecret(path, value);
    }
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

const NOT_STORED = Symbol("not stored");

/**
 * The credential rule for a write of `field` on the `llmSecrets` record (`container` null: a
 * top-level field; else the top-level container it is in). Returns the value to store and the
 * routing to run once it is stored, or `NOT_STORED` when the write is only routed. Validates
 * everything before anything is routed.
 */
function llmSecretWrite(
    container: string | null,
    field: string,
    value: unknown,
): { value: unknown; route: () => void } | typeof NOT_STORED {
    if (container === null) {
        if (flatSecretFields.has(field)) {
            const secret = credentialValue(value, field);
            routeSecret({ kind: "flat", field: field as FlatSecretField }, secret);
            return NOT_STORED;
        }
        if (Object.hasOwn(entryLeaf, field)) {
            throw new CredentialRefusedError(`${field}: credential entries are written through setSecret`);
        }
        if (field === "OaiCompAPIKeys") {
            if (!isObject(value) || Array.isArray(value)) {
                throw new CredentialRefusedError("OaiCompAPIKeys must be a map");
            }
            const entries = Object.entries(unwrapPlain(value) as object).map(
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
            const plain = unwrapPlain(value) as Record<string, unknown>;
            let secret = "";
            if (Object.hasOwn(plain, leaf)) {
                const leafValue = plain[leaf];
                if (typeof leafValue === "string") {
                    secret = leafValue;
                } else if (leafValue !== null && leafValue !== undefined) {
                    throw new CredentialRefusedError(`${field}.${leaf}: a credential must be a string`);
                }
            }
            const stored: Record<string, unknown> = {};
            for (const [key, entry] of Object.entries(plain)) {
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
            return {
                value: stored,
                route: () => {
                    if (secret !== "") {
                        routeSecret({ kind: "nested", field: field as keyof typeof NESTED_SECRET_FIELDS }, secret);
                    }
                },
            };
        }
        return { value, route: () => {} };
    }
    if (Object.hasOwn(nestedSecretLeaf, container) && nestedSecretLeaf[container] === field) {
        const secret = credentialValue(value, `${container}.${field}`);
        routeSecret({ kind: "nested", field: container as keyof typeof NESTED_SECRET_FIELDS }, secret);
        return NOT_STORED;
    }
    if (container === "OaiCompAPIKeys") {
        const secret = credentialValue(value, `OaiCompAPIKeys.${field}`);
        routeSecret({ kind: "map", field: "OaiCompAPIKeys", id: field }, secret);
        return NOT_STORED;
    }
    return { value, route: () => {} };
}

/** Refuses a `delete` of a credential path on the `llmSecrets` record. */
function llmSecretDelete(container: string | null, field: string) {
    const refused =
        container === null
            ? flatSecretFields.has(field) ||
              Object.hasOwn(nestedSecretLeaf, field) ||
              field === "OaiCompAPIKeys" ||
              Object.hasOwn(entryLeaf, field)
            : (Object.hasOwn(nestedSecretLeaf, container) && nestedSecretLeaf[container] === field) ||
              container === "OaiCompAPIKeys";
    if (refused) {
        throw new CredentialRefusedError(
            `${container ? `${container}.` : ""}${field}: delete a credential with clearSecret`,
        );
    }
}

/**
 * The entry credential rule for a value written into `presets` or `customModels`
 * (`SECRET_ENTRY_MAPS`; other kinds pass through): `value` is the whole list (`listLevel`) or one
 * whole element (`elementLevel`). An element's non-empty string credential is routed with its string `id` and left
 * out of what is stored; a blank or absent one is left out and changes nothing; a non-string one, or
 * a credential on an element without a string id, refuses the whole write. Nothing is routed until
 * `route` runs (after the value is stored). A whole element or list is stored as a copy without the
 * credential when it had one.
 */
function prepareEntryCredentials(
    kind: RecordKind,
    value: unknown,
    listLevel: boolean,
    elementLevel = false,
): { value: unknown; route: () => void; owners: string[] } {
    const leaf = Object.hasOwn(entryLeaf, kind) ? entryLeaf[kind] : undefined;
    if (leaf === undefined) {
        return { value, route: () => {}, owners: [] };
    }
    const field = kind as SecretEntryMap;
    const routes: [string, string][] = [];
    const strip = (entry: unknown): unknown => {
        if (!isObject(entry) || Array.isArray(entry)) {
            return entry;
        }
        // A wrapper of this record stands for a stored element, which never holds the credential (and
        // may be a displaced one, which only its assignment resolves); a wrapper of another record is
        // read as the copy it is stored as. A Svelte proxy or plain object without the credential
        // passes as it is, uncopied.
        const node = nodeOf.get(entry);
        if (node?.kind === kind) {
            return entry;
        }
        const source = (node ? detachedCopy(entry) : entry) as Record<string, unknown>;
        if (!Object.hasOwn(source, leaf)) {
            return entry;
        }
        const secret = source[leaf];
        if (secret !== null && secret !== undefined && typeof secret !== "string") {
            throw new CredentialRefusedError(`${field}.${leaf}: a credential must be a string`);
        }
        if (typeof secret === "string" && secret !== "") {
            const id = source.id;
            if (typeof id !== "string" || id === "") {
                throw new CredentialRefusedError(`${field}.${leaf}: its owner has no id`);
            }
            routes.push([id, secret]);
        }
        const copy: Record<string, unknown> = {};
        for (const [key, entryValue] of Object.entries(source)) {
            if (key !== leaf) {
                Object.defineProperty(copy, key, {
                    value: entryValue,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
        }
        return copy;
    };
    let prepared = value;
    if (listLevel) {
        if (Array.isArray(value) || isRecordWrapper(value)) {
            const list = Array.from(value as ArrayLike<unknown>);
            const next = list.map(strip);
            if (next.some((entry, index) => !Object.is(entry, list[index]))) {
                prepared = next;
            }
            assertCredentialOwners(
                kind,
                routes.map(([id]) => id),
                next,
            );
        }
    } else if (elementLevel) {
        prepared = strip(value);
    }
    return {
        value: prepared,
        route: () => {
            for (const [id, secret] of routes) {
                routeSecret({ kind: "entry", field, id }, secret);
            }
        },
        owners: routes.map(([id]) => id),
    };
}

/** An element's `id` (through a wrapper or a Svelte proxy too), or undefined. */
function idOf(entry: unknown): unknown {
    return isObject(entry) && !Array.isArray(entry) ? untrack(() => (entry as Record<string, unknown>).id) : undefined;
}

/**
 * Refuses (before anything changes) a credential whose owner is not exactly one element of the list
 * the write leaves (`resulting`): it would be routed to an id two elements share, or to none.
 */
function assertCredentialOwners(kind: RecordKind, owners: readonly string[], resulting: readonly unknown[]) {
    for (const owner of owners) {
        let count = 0;
        for (const entry of resulting) {
            if (Object.is(idOf(entry), owner)) {
                count += 1;
            }
        }
        if (count !== 1) {
            throw new CredentialRefusedError(`${kind}: the credential of ${owner} has ${count} owners in the list`);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The deep write-through record.

/** Thrown when a retained nested wrapper names an element that no longer exists in its record. */
export class DetachedWrapperError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DetachedWrapperError";
    }
}

/** Thrown when a write goes through a by-id wrapper whose id matches more than one element. */
export class DuplicateIdError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DuplicateIdError";
    }
}

type Step =
    | { type: "root" }
    /** A property key (an object field, or an array index for elements without by-id identity). */
    | { type: "key"; key: string }
    /** An element of an allowlisted by-id list (`BY_ID_FIELDS`), resolved by its id; `index` is where it last was. */
    | { type: "id"; field: "id"; id: string; index: number };

interface TrackedNode {
    kind: RecordKind;
    meta: RecordMeta;
    parent: TrackedNode | null;
    step: Step;
    isArray: boolean;
    /** The `$state` object this node last resolved to. */
    target: object | undefined;
    /** The record's raw epoch at that resolution. */
    epoch: number;
    /** Canonical child wrappers: by field for an object, by id for allowlisted elements. */
    keyChildren: Map<string, TrackedNode>;
    idChildren: Map<string, TrackedNode>;
    /** The other array element wrappers by the index they last stood at. */
    indexChildren: Map<string, TrackedNode>;
    /** The array mutators handed out for this node (each runs in a mutator scope). */
    mutators: Map<string, (...args: unknown[]) => unknown>;
    proxy: any;
}

const nodeOf = new WeakMap<object, TrackedNode>();
const rootNodes = new Map<string, TrackedNode>();

const isIndex = (key: string) => /^(0|[1-9]\d*)$/.test(key);

/**
 * The array mutators a wrapper runs in a mutator scope: their arguments are unwrapped first, then
 * the native method runs through the traps, and the elements it displaces during its own run are
 * written back as the objects it read (`sort` and `copyWithin` rewrite the array in place).
 */
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
let mutatorDepth = 0;

/** Records an object a write through a wrapper overwrote or deleted (cleared at the end of the task). */
function displace(meta: RecordMeta, old: unknown) {
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

function adopt(node: TrackedNode, target: object, epoch: number) {
    node.target = target;
    node.epoch = epoch;
    node.meta.owned.add(target);
}

/**
 * The `$state` object a node stands for now:
 * - the root resolves the record by kind on every access;
 * - an id step resolves the element by its id, wherever it is now; a missing id throws;
 * - a key step follows the same path after a raw replacement and after a local reassignment of an
 *   object field; for an array index whose element a local array operation moved, it follows the
 *   element by identity, and throws when the element was removed.
 */
function resolve(node: TrackedNode): any {
    if (node.parent === null) {
        const data = records[node.kind];
        if (!isObject(data)) {
            throw new DetachedWrapperError(`${node.kind} is not loaded`);
        }
        adopt(node, data, node.meta.epoch);
        return data;
    }
    const parent = resolve(node.parent);
    const epoch = node.meta.epoch;
    const step = node.step;
    if (step.type === "id") {
        if (node.target !== undefined && Object.is(parent[step.index], node.target)) {
            return node.target;
        }
        const index = Array.isArray(parent)
            ? parent.findIndex((entry: any) => isObject(entry) && Object.is((entry as any)[step.field], step.id))
            : -1;
        if (index === -1) {
            throw new DetachedWrapperError(`${node.kind}: no element with ${step.field} ${step.id}`);
        }
        step.index = index;
        adopt(node, parent[index], epoch);
        return node.target;
    }
    if (step.type !== "key") {
        throw new Error("unreachable");
    }
    const current = parent[step.key];
    if (Object.is(current, node.target)) {
        return current;
    }
    if (node.epoch !== epoch || !Array.isArray(parent) || !isIndex(step.key)) {
        // A raw replacement of the record (same logical record, same path), or a local
        // reassignment of an object field (the path holds the new container).
        if (!isObject(current)) {
            throw new DetachedWrapperError(`${node.kind}: nothing at ${step.key} any more`);
        }
        adopt(node, current, epoch);
        if (Array.isArray(parent)) {
            node.meta.children.set(current, node);
        }
        return current;
    }
    // A local array operation moved or removed the element: follow it by identity.
    const index = Array.prototype.indexOf.call(parent, node.target);
    if (index === -1) {
        throw new DetachedWrapperError(`${node.kind}: the element at [${step.key}] was removed`);
    }
    moveIndexChild(node, String(index));
    return node.target;
}

/**
 * The `$state` object an assignment of a wrapper stores: its current identity. Inside a mutator
 * scope, the object the mutator read during its own run. A wrapper whose element is gone throws,
 * unless the element was displaced by a write in the current task (an indexed swap).
 */
function assignedTarget(node: TrackedNode): object {
    if (node.parent !== null && mutatorDepth > 0 && node.target !== undefined) {
        return node.target;
    }
    try {
        return untrack(() => resolve(node));
    } catch (error) {
        if (!(error instanceof DetachedWrapperError) || node.parent === null) {
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
 * A value written into record `kind` through a wrapper:
 * - a wrapper of the same record stores its current `$state` object (`assignedTarget`);
 * - a wrapper of another record stores a detached copy;
 * - a Svelte proxy the record owns is stored as is; any other Svelte proxy a detached copy;
 * - a plain object or array is kept, with the wrappers in it replaced in place by these rules.
 */
function unwrap(value: unknown, kind: RecordKind, seen = new Set<object>()): unknown {
    if (!isObject(value)) {
        return value;
    }
    const node = nodeOf.get(value);
    if (node) {
        return node.kind === kind ? assignedTarget(node) : detachedCopy(value);
    }
    if (STATE in value) {
        const meta = metas.get(kind);
        const owned =
            (meta && meta.owned.has(value)) ||
            Object.is(
                untrack(() => records[kind]),
                value,
            );
        return owned ? value : detachedCopy(value);
    }
    if (seen.has(value)) {
        return value;
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor && "value" in descriptor && isObject(descriptor.value)) {
            const inner = unwrap(descriptor.value, kind, seen);
            if (!Object.is(inner, descriptor.value)) {
                // `defineProperty`, never an assignment: an own `__proto__` key stays a key.
                Object.defineProperty(value, key, { ...descriptor, value: inner });
            }
        }
    }
    return value;
}

/** A plain value with every wrapper and Svelte proxy in it replaced by a detached copy. */
function unwrapPlain(value: unknown): unknown {
    return isObject(value) && (nodeOf.has(value) || STATE in value) ? detachedCopy(value) : value;
}

function moveIndexChild(node: TrackedNode, index: string) {
    const step = node.step as { key: string };
    const parent = node.parent!;
    if (parent.indexChildren.get(step.key) === node) {
        parent.indexChildren.delete(step.key);
    }
    step.key = index;
    parent.indexChildren.set(index, node);
}

function createChild(parentNode: TrackedNode, step: Step, value: object): TrackedNode {
    const node = createNode(parentNode.kind, parentNode, step, value, parentNode.meta.epoch);
    parentNode.meta.owned.add(value);
    return node;
}

/**
 * The lists whose elements get by-id identity: only a list whose ids the normalizer makes unique
 * (a repeated id is re-keyed). Every other element, with or without an `id` (lorebook entries can
 * repeat ids after a re-import), uses object and path identity.
 * - `presets` (the record): `normalizePresets` (`shared/presets.ts`);
 * - `personas` (the record): `normalizePersonas` (`shared/personas.ts`);
 * - `translatorPresets.items`, `hypaV3Presets.items`: `selectableList`
 *   (`server/src/data/normalize/collections.ts`).
 */
const BY_ID_FIELDS: readonly { kind: RecordKind; field: string | null }[] = [
    { kind: "presets", field: null },
    { kind: COLLECTION_KIND.personas, field: null },
    { kind: COLLECTION_KIND.translatorPresets, field: "items" },
    { kind: COLLECTION_KIND.hypaV3Presets, field: "items" },
];

function byIdField(parentNode: TrackedNode): "id" | null {
    for (const entry of BY_ID_FIELDS) {
        if (entry.kind !== parentNode.kind) {
            continue;
        }
        if (entry.field === null && parentNode.parent === null) {
            return "id";
        }
        if (
            entry.field !== null &&
            parentNode.parent?.parent === null &&
            parentNode.step.type === "key" &&
            parentNode.step.key === entry.field
        ) {
            return "id";
        }
    }
    return null;
}

/**
 * Refuses, before any state changes, a write through a wrapper with a by-id step (itself or an
 * ancestor) whose id now matches more than one element of its list.
 */
function assertUniqueIds(node: TrackedNode) {
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
            throw new DuplicateIdError(`${current.kind}: ${matches} elements have ${step.field} ${step.id}`);
        }
    }
}

/** The nested wrapper for `value` at `prop` of `parentNode` (one canonical wrapper per logical item). */
function childWrapper(parentNode: TrackedNode, parentTarget: any, prop: string, value: object): any {
    const epoch = parentNode.meta.epoch;
    const refresh = (node: TrackedNode) => {
        if (!Object.is(node.target, value)) {
            node.meta.owned.add(value);
        }
        node.target = value;
        node.epoch = epoch;
        return node.proxy;
    };
    if (Array.isArray(parentTarget)) {
        const record = value as Record<string, unknown>;
        const field = byIdField(parentNode) !== null && typeof record.id === "string" ? "id" : null;
        if (field) {
            const id = record.id as string;
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
            // After a raw replacement, the wrapper that stood at this index stands for the element
            // now there, so a retained and a freshly fetched wrapper of the element are one object.
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

/** The top-level container of `node` in the `llmSecrets` record (null for the root; undefined elsewhere). */
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

/** Whether assigning `prop` on `target` would not create an own key (`assignsInherited`). */
function assignsInheritedName(target: object, prop: string): boolean {
    return prop === "__proto__" || (prop in Object.prototype && !Object.hasOwn(target, prop));
}

/** Puts a rebuilt container where `node`'s object was. */
function install(node: TrackedNode, next: object) {
    if (node.parent === null) {
        records[node.kind] = next;
        return;
    }
    const parent = resolve(node.parent);
    const step = node.step;
    const slot = step.type === "id" ? step.index : (step as { key: string }).key;
    displace(node.meta, parent[slot]);
    parent[slot] = next;
}

/** Whether `node` is the list of an entry-credential kind (`presets`, `customModels`). */
const isEntryList = (node: TrackedNode) => node.parent === null && Object.hasOwn(entryLeaf, node.kind);
/** Whether `node` is an element of that list. */
const isEntryElement = (node: TrackedNode) => node.parent !== null && isEntryList(node.parent);

function writeThrough(node: TrackedNode, prop: string, value: unknown): boolean {
    assertUniqueIds(node);
    const target = resolve(node);
    let incoming = value;
    let route: () => void = () => {};
    const container = llmContainer(node);
    if (container !== undefined) {
        const write = llmSecretWrite(container, prop, value);
        if (write === NOT_STORED) {
            return true;
        }
        incoming = write.value;
        route = write.route;
    } else if (isEntryElement(node) && prop === entryLeaf[node.kind]) {
        // A leaf write of an entry credential: routed with the element's id, never stored.
        const id = (target as Record<string, unknown>).id;
        if (typeof id !== "string" || id === "") {
            throw new CredentialRefusedError(`${node.kind}.${prop}: its owner has no id`);
        }
        // The id must name this element only (custom model ids are not made unique).
        assertCredentialOwners(node.kind, [id], Array.from(untrack(() => resolve(node.parent!)) as unknown[]));
        routeSecret(
            { kind: "entry", field: node.kind as SecretEntryMap, id },
            credentialValue(value, `${node.kind}.${prop}`),
        );
        return true;
    } else if (isEntryList(node) && (isIndex(prop) || prop === "length")) {
        const prepared = prepareEntryCredentials(node.kind, value, false, isIndex(prop));
        if (prepared.owners.length > 0) {
            const resulting = Array.from(target as unknown[]);
            resulting[Number(prop)] = prepared.value;
            assertCredentialOwners(node.kind, prepared.owners, resulting);
        }
        incoming = prepared.value;
        route = prepared.route;
    }
    // Unwrapped (and validated: a gone wrapper throws) before anything changes.
    const plain = unwrap(incoming, node.kind);
    if (!Array.isArray(target) && assignsInheritedName(target, prop)) {
        install(node, writeEntries(target, [[prop, plain]])!);
    } else {
        if (isObject(plain) || Array.isArray(target) || node.keyChildren.has(prop)) {
            displace(node.meta, target[prop]);
        }
        target[prop] = plain;
    }
    route();
    queueRecordWrite(node.kind);
    return true;
}

/**
 * A mutator call's arguments as the native method gets them: the values it inserts (`push`,
 * `unshift`, `splice`'s items, `fill`'s value) prepared and unwrapped, every other argument as it is.
 * On a credential list (`presets`, `customModels`) the inserted credentials are validated together
 * against the list the call leaves (exactly one owner each), `fill` and `copyWithin` refuse a
 * credential (they duplicate elements), and `route` routes them once the method succeeded.
 */
function planMutator(
    node: TrackedNode,
    target: unknown[],
    method: string,
    args: unknown[],
): { args: unknown[]; route: () => void } {
    if (
        method === "splice" &&
        args.slice(0, 2).some((arg) => (typeof arg === "object" && arg !== null) || typeof arg === "function")
    ) {
        // Its indexes are read once for the plan; an object (its `valueOf`) could answer differently later.
        throw new TypeError(`${node.kind}: splice takes number indexes`);
    }
    const insertedFrom =
        method === "push" || method === "unshift" ? 0 : method === "splice" ? 2 : method === "fill" ? 0 : -1;
    const insertedTo = method === "fill" ? 1 : args.length;
    const entryList = isEntryList(node);
    const routes: (() => void)[] = [];
    const owners: string[] = [];
    const next = args.map((arg, index) => {
        if (insertedFrom === -1 || index < insertedFrom || index >= insertedTo) {
            return arg;
        }
        let value = arg;
        if (entryList) {
            const prepared = prepareEntryCredentials(node.kind, arg, false, true);
            if (prepared.owners.length > 0 && method === "fill") {
                throw new CredentialRefusedError(`${node.kind}: fill cannot carry a credential`);
            }
            value = prepared.value;
            routes.push(prepared.route);
            owners.push(...prepared.owners);
        }
        return unwrap(value, node.kind);
    });
    if (owners.length > 0) {
        const inserted = next.slice(insertedFrom, insertedTo);
        let resulting: unknown[];
        if (method === "push") {
            resulting = [...target, ...inserted];
        } else if (method === "unshift") {
            resulting = [...inserted, ...target];
        } else {
            const copy = Array.from(target);
            const start = Number(args[0] ?? 0);
            const deleteCount = args.length < 2 ? copy.length : Number(args[1] ?? 0);
            copy.splice(start, deleteCount, ...inserted);
            resulting = copy;
        }
        assertCredentialOwners(node.kind, owners, resulting);
    }
    return {
        args: next,
        route: () => {
            for (const route of routes) {
                route();
            }
        },
    };
}

function createNode(
    kind: RecordKind,
    parent: TrackedNode | null,
    step: Step,
    target: object | undefined,
    epoch: number,
): TrackedNode {
    const isArray = Array.isArray(target);
    const node: TrackedNode = {
        kind,
        meta: metaOf(kind),
        parent,
        step,
        isArray,
        target,
        epoch,
        keyChildren: new Map(),
        idChildren: new Map(),
        indexChildren: new Map(),
        mutators: new Map(),
        proxy: null,
    };
    // The proxy target is a stand-in of the same shape (an array keeps `Array.isArray` and
    // `JSON.stringify` treating the wrapper as an array); every trap answers from the resolved
    // `$state` object.
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
                        // Every inserted value is prepared (credentials validated and stripped) and
                        // unwrapped before the method runs, so a retained wrapper resolves its current
                        // identity (or throws) and nothing changes on a refusal.
                        const plan = untrack(() => planMutator(node, resolve(node), prop, args));
                        mutatorDepth += 1;
                        let result: unknown;
                        try {
                            result = Reflect.apply(native, node.proxy, plan.args);
                        } finally {
                            mutatorDepth -= 1;
                        }
                        plan.route();
                        return result;
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
            // Writes resolve untracked: an `$effect` that writes through a wrapper must not subscribe
            // to the path it writes.
            return untrack(() => writeThrough(node, prop, value));
        },
        deleteProperty(_, prop) {
            return untrack(() => {
                assertUniqueIds(node);
                const resolved = resolve(node);
                const container = llmContainer(node);
                if (container !== undefined && typeof prop === "string") {
                    llmSecretDelete(container, prop);
                }
                if (isEntryElement(node) && prop === entryLeaf[node.kind]) {
                    throw new CredentialRefusedError(`${node.kind}.${prop}: delete a credential with clearSecret`);
                }
                displace(node.meta, resolved[prop]);
                const done = Reflect.deleteProperty(resolved, prop);
                queueRecordWrite(node.kind);
                return done;
            });
        },
        defineProperty(_, prop, descriptor) {
            return untrack(() => {
                // A record holds JSON data: only a plain data property, checked before anything changes.
                if (
                    "get" in descriptor ||
                    "set" in descriptor ||
                    descriptor.writable === false ||
                    descriptor.enumerable === false ||
                    descriptor.configurable === false
                ) {
                    throw new TypeError(`${node.kind}: a record field is a writable, enumerable data property`);
                }
                assertUniqueIds(node);
                const resolved = resolve(node);
                if (
                    typeof prop === "string" &&
                    "value" in descriptor &&
                    (llmContainer(node) !== undefined ||
                        isEntryList(node) ||
                        isEntryElement(node) ||
                        (!Array.isArray(resolved) && assignsInheritedName(resolved, prop)))
                ) {
                    // The credential rules and an own inherited-name key go the `set` way.
                    return writeThrough(node, prop, descriptor.value);
                }
                const prepared =
                    "value" in descriptor ? { ...descriptor, value: unwrap(descriptor.value, node.kind) } : descriptor;
                const done = Reflect.defineProperty(resolved, prop, prepared);
                queueRecordWrite(node.kind);
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
                // Svelte's `getOwnPropertyDescriptor` may return the raw target's value; it is read
                // through the proxy instead, so the wrapper stands for the `$state` object.
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

/**
 * The record's root wrapper (cached while the record keeps its shape), resolving the record by kind
 * on every access. `undefined` while the record is absent: nothing is wrapped then.
 */
export function trackedRecord<T = any>(kind: RecordKind): T | undefined {
    const data = records[kind];
    if (!isObject(data)) {
        return undefined;
    }
    let node = rootNodes.get(kind);
    if (!node || node.isArray !== Array.isArray(data)) {
        node = createNode(kind, null, { type: "root" }, untrack(() => records[kind]) as object, metaOf(kind).epoch);
        rootNodes.set(kind, node);
    }
    return node.proxy as T;
}

// ---------------------------------------------------------------------------------------------
// Bulk list mutations (the verdict's remedy for interactions past a frame budget: one write, queued
// once, on the record's `$state` data instead of one wrapper write per index).

/** The `$state` array a wrapper of a record list stands for, and its record (`null`: not a wrapper). */
function wrappedList(list: unknown): { node: TrackedNode; target: unknown[] } | null {
    const node = isObject(list) ? nodeOf.get(list) : undefined;
    if (!node) {
        return null;
    }
    const target = untrack(() => resolve(node));
    if (!Array.isArray(target)) {
        throw new TypeError(`${node.kind}: not a list`);
    }
    return { node, target };
}

/**
 * Moves the element at `from` of a record list (a wrapper, e.g. `DBState.db.botPresets`) to `to` (its
 * index after the move), in one write: the elements keep their identity (retained wrappers follow
 * them), and the record's write is queued once. Out-of-range indexes change nothing. A plain list is
 * moved in place.
 */
export function moveRecordListItem(list: unknown[], from: number, to: number) {
    const wrapped = wrappedList(list);
    const target = wrapped?.target ?? list;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= target.length) {
        return;
    }
    const index = Math.min(Math.max(to, 0), target.length - 1);
    if (index === from) {
        return;
    }
    untrack(() => {
        if (wrapped) {
            assertUniqueIds(wrapped.node);
        }
        const [item] = target.splice(from, 1);
        target.splice(index, 0, item);
    });
    if (wrapped) {
        queueRecordWrite(wrapped.node.kind);
    }
}

/**
 * Replaces the contents of a record list (a wrapper, e.g. a module's lorebook) with `items`, in one
 * write: the items are prepared as any write into the record is (wrappers of the record stand for
 * their current objects, credentials routed and stripped), then the list's `$state` array is
 * replaced in place and the record's write queued once. A plain list is replaced in place.
 */
export function replaceRecordList(list: unknown[], items: readonly unknown[]) {
    const wrapped = wrappedList(list);
    if (!wrapped) {
        list.splice(0, list.length, ...items);
        return;
    }
    const { node, target } = wrapped;
    untrack(() => {
        assertUniqueIds(node);
        const prepared = isEntryList(node)
            ? prepareEntryCredentials(node.kind, [...items], true)
            : { value: [...items], route: () => {} };
        const plain = unwrap(prepared.value, node.kind) as unknown[];
        // The elements the replacement drops count as displaced (a same-task re-insertion is allowed).
        const kept = new Set<unknown>(plain);
        for (const old of Array.from(target)) {
            if (!kept.has(old)) {
                displace(node.meta, old);
            }
        }
        target.splice(0, target.length, ...plain);
        prepared.route();
    });
    queueRecordWrite(node.kind);
}
