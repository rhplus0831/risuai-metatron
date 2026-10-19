import { tick, untrack } from "svelte";
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
import { v4 } from "uuid";
import { writeEntries } from "./mutationValidation";

/**
 * The settings records (Phase 6 slice 4, `settings-ownership`): the source of truth of the five
 * sections, the settings collections, and `presets`, `modules`, `plugins`, `pluginStorage`
 * (all singletons). Each record is a deep write-through record, the pattern the Phase 6 spike chose
 * and the owner confirmed at Stop A (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/
 * spike-projection-bindings.md`, "Verdict"): `trackedRecord(kind)` is a JS `Proxy` over the record's
 * `$state` data whose every trap resolves the current data; a read of a nested container returns its
 * own wrapper; a write, `delete`, or `defineProperty` at any depth goes into the `$state` data and
 * queues the record's write in the same task (`setRecordWriteListener`: the save loop's `markKey`).
 * Readers reach them through the settings views (`settingsViews.svelte.ts`).
 *
 * Paths into a record:
 * - `initializeRecords` (an installation: boot, a test fixture) replaces the whole set and
 *   `applyRaw` (a server copy: a conflict reload, a live update, a job hydration) replaces one
 *   record; neither queues a write.
 * - `replaceRecord` (a local whole-record replacement, `settings.presets = [...]`) and every write
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
 *   Plain JSON written under a character or `modules` is copied. Their field-text caches are
 *   disabled by non-JSON data or state shared across cached fields; modules may move whole elements
 *   between root list slots without disabling the cache, which follows element identity, not id.
 * - A module's `assets` list is immutable (heap plan B1): every install (`applyRaw`) and adoption
 *   freezes a list of plain JSON tuples, and a read returns the frozen list and tuples themselves,
 *   never a wrapper. An edit replaces the whole list (`module.assets = next`; unchanged frozen
 *   tuples are reused). A write into a frozen value through any path is refused with a TypeError
 *   before anything changes. A list of another shape stays mutable and wrapped.
 * - A character's `additionalAssets`, `emotionImages` (tuples) and `ccAssets` (flat records) follow
 *   the same rule (heap plan B2): frozen at `initializeRecords`, `applyRawCharacter` and
 *   `patchRawCharacter` (handed-over data) and, for a whole field written or stored, in a wholly owned
 *   copy (`freshAssetList`: live descriptors validated before copying, only verified entries shared).
 * - An own `__proto__` (or other inherited-name) key is rebuilt through `writeEntries`.
 * - Writes and replacements run untracked; comparisons use `Object.is` (in dev, Svelte compiles `===`
 *   in a `.svelte.ts` file to a check that reads through the wrapper's traps).
 * - Credentials never enter a record: on `llmSecrets` every credential path is routed to `setSecret`
 *   / `clearSecret` or refused (the record holds the mirror form, `mirrorFields`); a named credential's `key` likewise
 *   (`SECRET_ENTRY_MAPS`), on a leaf write and on any element or list written whole (a non-empty one
 *   is routed with the element's id, a blank or absent one changes nothing, a leaf assignment of `""`
 *   clears). Every value is validated before either the record or the credential queue changes.
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

/**
 * The character list (Phase 6 slice 5): held beside the settings records, but not a settings kind (the
 * save loop writes one `characters` resource per `chaId`, not one record).
 */
export const CHARACTERS = "characters";
/** A kind the wrapper machinery tracks: a settings record or the character list. */
type TrackedKind = RecordKind | typeof CHARACTERS;
/** Fields of a character that are not part of its record: the render key. */
const CHARACTER_LOCAL_FIELDS: ReadonlySet<string> = new Set(["reloadKeys"]);
/**
 * The facade view's fields of a character (Phase 6 slice 9a): never stored on the record (the chat
 * module holds the chats); a character element wrapper answers them from `setCharacterChatView`.
 */
const CHARACTER_CHAT_FIELDS: ReadonlySet<string> = new Set(["chats", "chatPage"]);

type CharacterChatView = { chats: (chaId: string) => unknown; chatPage: (chaId: string) => number };
let characterChatView: CharacterChatView | null = null;

/**
 * Registers the facade view of a character's chats (`chatStore.svelte.ts`): what a character element
 * wrapper answers for `chats` and `chatPage` until `aggregate-removal`. Not an own key of the wrapper,
 * so snapshots, spreads, and the save projection are chat-free; writing either is refused.
 */
export function setCharacterChatView(view: CharacterChatView | null) {
    characterChatView = view;
}

/** Drops the facade view's fields from a raw character (they are never stored on the record). */
function stripChatFields(character: Record<string, unknown>) {
    for (const field of CHARACTER_CHAT_FIELDS) {
        delete character[field];
    }
}

function refuseChatFieldWrite(prop: string): never {
    throw new TypeError(`characters: ${prop} is written through the chat module (chatStore)`);
}

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
export function takeRecordFields(raw: Record<string, unknown>): RecordFields {
    const fields: RecordFields = {};
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
    const characters = take(CHARACTERS);
    if (characters.found) {
        fields.characters = characters.value;
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

/**
 * Per owner (not reactive): the raw-application epoch and the wrapper bookkeeping. An owner is one
 * persisted record: a settings kind, the character list itself, or one character (its element and
 * everything under it, `characterOwner`), so a value is shared only within the record it belongs to.
 */
interface RecordMeta {
    /** The owner's key: a settings kind, `characters` (the list), or `characters\0<chaId>`. */
    key: string;
    epoch: number;
    /** For a character owner: the list's meta (its epoch also applies) and the character's id. */
    list: RecordMeta | null;
    chaId: string | null;
    /** For a character owner: the epoch of a raw change of one top-level field (`patchRawCharacter`). */
    fieldEpochs: Map<string, number>;
    /**
     * For a character owner or modules, the save loop's field-text stamps: `lifetime` is
     * taken when the owner's data is fresh (created, installed, replaced from the server), and
     * `fieldStamps` per character field / `itemFieldStamps` per module element field at every change
     * under it (a wrapper write, a raw character patch). `uncacheable`: data whose JSON could change
     * without either (state shared between fields, a value that is not plain JSON data); sticky until
     * the data is fresh again.
     */
    lifetime: number;
    fieldStamps: Map<string, number>;
    /** For `modules`: stamps by element identity, then its top-level field (ids may repeat). */
    itemFieldStamps: WeakMap<object, Map<string, number>>;
    uncacheable: boolean;
    children: WeakMap<object, TrackedNode>;
    /** The `$state` objects this record's wrappers have reached (a written proxy that is one is stored as is). */
    owned: WeakSet<object>;
    /** Objects a write through a wrapper overwrote or deleted in the current task, and the latest per id. */
    displaced: Set<object>;
    displacedById: Map<string, object>;
    clearScheduled: boolean;
}
const metas = new Map<string, RecordMeta>();
/** Every epoch comes from this counter, so the epochs of a character and of its list never collide. */
let epochCounter = 0;
/** Every field-text stamp comes from this counter (never reset), so no two lifetimes share a stamp. */
let stampCounter = 0;

/** Synchronous invalidation, independent of save dispatch and meta lifetimes (including resets). */
let moduleRevisionCounter = 0;
let modulesRevision = $state(0);
let assetsRevision = $state(0);

export function moduleMembershipRevision(): number {
    return modulesRevision;
}

export function moduleAssetsRevision(): number {
    return assetsRevision;
}

/** Called only inside the write paths' untrack scopes. */
function bumpModuleMembership() {
    modulesRevision = ++moduleRevisionCounter;
}

function bumpModuleAssets() {
    assetsRevision = ++moduleRevisionCounter;
}

const modulePlainFields = new WeakMap<object, Map<string, { stamp: number; value: unknown }>>();
const characterPlainFields = new WeakMap<object, Map<string, { stamp: number; value: unknown }>>();

/**
 * A detached, read-only-by-contract field copy, shared by all readers of this live element/stamp.
 * Resolve the wrapper to its $state proxy: stamps belong to that proxy, not its raw target.
 * Svelte never updates the raw target after a write, so it is usable only for an untouched field.
 * Never return the raw target or freeze it, except a verified frozen asset list (`frozenAssetOf`),
 * which is immutable and returned as itself. Uncacheable data must be copied on every read.
 */
export function moduleFieldPlain<T extends object, K extends keyof T & string>(wrapper: T, field: K): T[K] {
    return untrack(() => {
        const node = nodeOf.get(wrapper);
        if (!node || node.kind !== "modules" || modulePlace(node)?.type !== "item") {
            const value = wrapper[field];
            return (isObject(value) ? detachedCopy(value) : value) as T[K];
        }
        const element = resolve(node);
        const stamp = moduleItemFieldStamp(element, field);
        const fields = modulePlainFields.get(element);
        const cached = fields?.get(field);
        if (stamp !== null && cached?.stamp === stamp) {
            return cached.value as T[K];
        }
        const raw = stamp === node.meta.lifetime ? element[STATE]?.[field] : undefined;
        const untouched = stamp === node.meta.lifetime && !(isObject(raw) && STATE in raw);
        const value = untouched ? raw : element[field];
        // A verified frozen asset list is shared as itself. Otherwise detached JSON on the fast
        // path: no Svelte property sources are created for its tuples.
        const frozen = isObject(value) ? frozenAssetOf(value) : null;
        const copy =
            frozen !== null
                ? frozen
                : stamp !== null
                  ? value === undefined
                      ? undefined
                      : JSON.parse(JSON.stringify(value))
                  : isObject(value)
                    ? detachedCopy(value)
                    : value;
        if (stamp !== null) {
            const memo = fields ?? new Map();
            memo.set(field, { stamp, value: copy });
            modulePlainFields.set(element, memo);
        }
        return copy as T[K];
    });
}

function metaOf(kind: string, list: RecordMeta | null = null, chaId: string | null = null): RecordMeta {
    let meta = metas.get(kind);
    if (!meta) {
        meta = {
            key: kind,
            epoch: 0,
            list,
            chaId,
            fieldEpochs: new Map(),
            lifetime: (stampCounter += 1),
            fieldStamps: new Map(),
            itemFieldStamps: new WeakMap(),
            uncacheable: false,
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

/** The meta of one character (its element and its descendants). */
function characterOwner(chaId: string): RecordMeta {
    return metaOf(`${CHARACTERS}\u0000${chaId}`, metaOf(CHARACTERS), chaId);
}

/**
 * The epoch a node resolves against: its owner's, for a character the latest of the character's,
 * its list's, and that of the top-level field the node is under (`field`), all from one counter.
 */
function nodeEpoch(meta: RecordMeta, field: string | null): number {
    let epoch = meta.epoch;
    if (meta.list !== null) {
        epoch = Math.max(epoch, meta.list.epoch);
    }
    if (field !== null) {
        epoch = Math.max(epoch, meta.fieldEpochs.get(field) ?? 0);
    }
    return epoch;
}

function bumpEpoch(meta: RecordMeta) {
    epochCounter += 1;
    meta.epoch = epochCounter;
}

/** A change under a character's top-level `field` (`characterFieldStamp`). */
function stampField(meta: RecordMeta, field: string) {
    stampCounter += 1;
    meta.fieldStamps.set(field, stampCounter);
}

/** A character's or modules' data is fresh (detached JSON): all stamps change, nothing is shared. */
function renewStamps(meta: RecordMeta) {
    stampCounter += 1;
    meta.lifetime = stampCounter;
    meta.fieldStamps.clear();
    meta.itemFieldStamps = new WeakMap();
    meta.uncacheable = false;
}

/**
 * The stamp of a character's top-level field for the save loop's field-text cache
 * (`resourceSync.svelte.ts`, `characterProjection`): while the field holds the same value (identity),
 * an equal stamp means its JSON text is unchanged. It changes at every write through a wrapper under
 * the field and at every raw change of it (`patchRawCharacter`), and all of them when the character's
 * data is fresh (installed, replaced from the server, created). Null when the character's text cannot
 * be cached: state shared between its fields (a write through one path would change another field
 * unstamped), or data that is not plain JSON (an accessor, a `toJSON` hook, a function, a class
 * instance, a null-prototype object, a cycle) whose JSON may change without a write. Every value written
 * into a character is copied when it is plain JSON data (`adoptCharacterValue`), so an input the caller
 * keeps cannot change the record afterwards.
 */
export function characterFieldStamp(chaId: string, field: string): number | null {
    const meta = characterOwner(chaId);
    return meta.uncacheable ? null : (meta.fieldStamps.get(field) ?? meta.lifetime);
}

/**
 * A detached, read-only-by-contract character field copy, shared by live element and field stamp.
 * Like moduleFieldPlain, reads the raw target only while the field is untouched; changed fields
 * copy the live $state value, without walking the record wrappers. A verified frozen asset list is
 * returned as itself (immutable). Never mutate the returned copy.
 */
export function characterFieldPlain<T = unknown>(chaId: string, field: string): T | undefined {
    return untrack(() => {
        const index = characterIndex(chaId);
        if (index < 0) return undefined;
        const element = (records[CHARACTERS] as CharacterObject[])[index];
        const meta = characterOwner(chaId);
        const stamp = characterFieldStamp(chaId, field);
        const fields = characterPlainFields.get(element);
        const cached = fields?.get(field);
        if (stamp !== null && cached?.stamp === stamp) return cached.value as T;
        const raw = stamp === meta.lifetime ? Reflect.get(element, STATE)?.[field] : undefined;
        const untouched = stamp === meta.lifetime && !(isObject(raw) && STATE in raw);
        const value = untouched ? raw : element[field];
        // A verified frozen asset list is shared as itself (as in `moduleFieldPlain`).
        const frozen = isObject(value) ? frozenAssetOf(value) : null;
        const copy =
            frozen !== null
                ? frozen
                : stamp !== null
                  ? value === undefined
                      ? undefined
                      : JSON.parse(JSON.stringify(value))
                  : isObject(value)
                    ? detachedCopy(value)
                    : value;
        if (stamp !== null) {
            const memo = fields ?? new Map();
            memo.set(field, { stamp, value: copy });
            characterPlainFields.set(element, memo);
        }
        return copy as T | undefined;
    });
}

/**
 * A live modules element's top-level field stamp. Equal stamp and value identity mean equal JSON.
 * Writes anywhere under the field stamp it; root list moves keep the element's stamps. Null for
 * the whole record after an adoption that may allow unstamped edits (`adoptModuleValue`), until
 * `applyRaw`/`initializeRecords` installs detached JSON again. The argument is the `$state` element
 * from `recordData("modules")`, not its wrapper or id.
 */
export function moduleItemFieldStamp(element: object, field: string): number | null {
    const meta = metaOf("modules");
    return meta.uncacheable ? null : (meta.itemFieldStamps.get(element)?.get(field) ?? meta.lifetime);
}

/**
 * `characterFieldStamp` of the top-level field a character's wrapper is under: equal while the value
 * keeps its identity means its JSON is unchanged. Null for any other value (not a wrapper, a wrapper of
 * another record, the character element itself, one detached by `resetRecords`) or an uncacheable
 * character.
 */
export function wrapperFieldStamp(value: unknown): number | null {
    const node = isObject(value) ? nodeOf.get(value) : undefined;
    if (!node || node.kind !== CHARACTERS || node.generation !== generation) {
        return null;
    }
    const { meta, field } = node;
    if (meta.chaId === null || field === null || meta.uncacheable) {
        return null;
    }
    return meta.fieldStamps.get(field) ?? meta.lifetime;
}

let writeListener: ((kind: RecordKind) => void) | null = null;
/** The save loop's character hooks: a character's own fields changed, or the list's membership did. */
export interface CharacterWriteListener {
    character(chaId: string): void;
    membership(): void;
}
let characterListener: CharacterWriteListener | null = null;
let membershipHook: (() => void) | null = null;
let batchDepth = 0;
/** Queued in the current batch: a kind, a character (`CHARACTER_KEY` + id), or `MEMBERSHIP_KEY`. */
const batched = new Set<string>();
const CHARACTER_KEY = "\u0000character:";
const MEMBERSHIP_KEY = "\u0000membership";

/** Registers the save loop's hook: called with a record's kind whenever a local write changed it. */
export function setRecordWriteListener(listener: ((kind: RecordKind) => void) | null) {
    writeListener = listener;
}

/** Registers the save loop's character hooks (a local write of a character, a membership change). */
export function setCharacterWriteListener(listener: CharacterWriteListener | null) {
    characterListener = listener;
}

/**
 * Registers the selection's hook (`selection.svelte.ts`): called synchronously after every completed
 * change of the character list's membership, local or raw, and after an installation or reset.
 */
export function setCharacterMembershipHook(hook: (() => void) | null) {
    membershipHook = hook;
}

function dispatch(key: string) {
    if (key === MEMBERSHIP_KEY) {
        characterListener?.membership();
    } else if (key.startsWith(CHARACTER_KEY)) {
        characterListener?.character(key.slice(CHARACTER_KEY.length));
    } else {
        writeListener?.(key as RecordKind);
    }
}

function queueKey(key: string) {
    if (batchDepth > 0) {
        batched.add(key);
        return;
    }
    dispatch(key);
}

/** Queues the record's write (inside `batchRecordWrites`, once per kind when it ends). */
export function queueRecordWrite(kind: RecordKind) {
    queueKey(kind);
}

/** Queues a character's write (inside `batchRecordWrites`, once per character when it ends). */
function queueCharacterWrite(chaId: string) {
    queueKey(CHARACTER_KEY + chaId);
}

function queueMembership() {
    queueKey(MEMBERSHIP_KEY);
}

/**
 * Queues the write a change under `node` made: its settings kind, or the character it is in. Under a
 * character it stamps the top-level field changed (`characterFieldStamp`): the one `node` descends
 * from, or `prop` written on the character element itself. Under modules it stamps the resolved
 * element's top-level field; root list writes change membership/order, not existing field texts.
 */
function queueNodeWrite(node: TrackedNode, prop?: string | symbol) {
    if (node.kind !== CHARACTERS) {
        if (node.kind === "modules") {
            // The bulk list helpers dispatch here after their write scope has ended.
            untrack(() => {
                const place = modulePlace(node, prop);
                if (place?.type !== "field" || ["id", "namespace", "mcp"].includes(place.field)) {
                    bumpModuleMembership();
                }
                if (place?.type !== "field" || place.field === "assets" || node.meta.uncacheable) {
                    bumpModuleAssets();
                }
                if (place?.type === "field") {
                    let fields = node.meta.itemFieldStamps.get(place.element);
                    if (!fields) {
                        fields = new Map();
                        node.meta.itemFieldStamps.set(place.element, fields);
                    }
                    fields.set(place.field, (stampCounter += 1));
                }
            });
        }
        queueRecordWrite(node.kind);
    } else if (node.meta.chaId !== null) {
        const field = node.field ?? (typeof prop === "string" ? prop : null);
        if (field !== null) {
            stampField(node.meta, field);
        }
        queueCharacterWrite(node.meta.chaId);
    }
}

/**
 * Runs a bulk writer (`fn` is synchronous): its record writes are queued once per kind (and once per
 * character) when the outermost scope ends, also when `fn` throws (what it wrote is queued).
 */
export function batchRecordWrites<T>(fn: () => T): T {
    batchDepth += 1;
    try {
        return fn();
    } finally {
        batchDepth -= 1;
        if (batchDepth === 0 && batched.size > 0) {
            const keys = [...batched];
            batched.clear();
            for (const key of keys) {
                dispatch(key);
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
 * change). `data` is handed over: detached JSON nobody edits afterwards (a `modules` record's asset
 * lists are frozen in place, `freezeAssetList`).
 */
export function applyRaw(kind: RecordKind, data: unknown) {
    bumpEpoch(metaOf(kind));
    if (kind === "modules") {
        renewStamps(metaOf(kind));
        // The data is detached JSON this layer now owns: its asset lists are frozen in place.
        if (Array.isArray(data) && !(STATE in data) && !nodeOf.has(data)) {
            for (const element of data) {
                freezeModuleAssets(element);
            }
        }
    }
    untrack(() => {
        if (kind === "modules") {
            bumpModuleMembership();
            bumpModuleAssets();
        }
        if (data === undefined) {
            delete records[kind];
        } else {
            records[kind] = data;
        }
        const root = rootNodes.get(kind);
        if (root) {
            unpinBelow(root);
        }
        refreshRoot(kind);
    });
}

/** What an installation holds: the settings records, and the character list (`[]` when absent). */
export type RecordFields = Partial<Record<RecordKind, unknown>> & { characters?: unknown };

/**
 * An installation (boot, a test fixture): replaces the whole record set with `fields` (a kind it
 * lacks is removed; the character list is `[]` then) and never queues a write. The characters get
 * valid, unique ids before any wrapper exists: an entry that is not an object is dropped, and one
 * without a string `chaId`, or with one an earlier entry has, gets a new id (the server's ids are
 * the record ids, so a boot never needs this; a fixture or an old export may). `fields` is handed
 * over: detached JSON nobody edits afterwards (a module's and a character's asset lists are frozen in
 * place, `freezeAssetList`); a caller that keeps editing its input passes a copy.
 */
export function initializeRecords(fields: RecordFields) {
    const list = (Array.isArray(fields.characters) ? fields.characters : []).filter(
        (entry) => isObject(entry) && !Array.isArray(entry),
    ) as Record<string, unknown>[];
    // One object twice would be one character under two ids: refused before anything is installed.
    if (new Set(list).size !== list.length) {
        throw new TypeError("characters: the same character object appears twice in the list");
    }
    for (const kind of RECORD_KINDS) {
        applyRaw(kind, Object.hasOwn(fields, kind) ? fields[kind] : undefined);
    }
    const seen = new Set<string>();
    for (const character of list) {
        if (typeof character.chaId !== "string" || character.chaId === "" || seen.has(character.chaId)) {
            character.chaId = v4();
        }
        seen.add(character.chaId as string);
        stripChatFields(character);
        // An installation holds detached JSON data (a server read, a fixture).
        freezeCharacterAssets(character);
        renewStamps(characterOwner(character.chaId as string));
    }
    bumpEpoch(metaOf(CHARACTERS));
    untrack(() => {
        records[CHARACTERS] = list;
        // A reinstallation without a reset: the characters it lacks lose their nodes, and the nodes
        // of the others (they follow their paths) let go of the old data.
        const root = rootNodes.get(CHARACTERS);
        if (root) {
            forgetCharacterNodes([...root.idChildren.keys()].filter((chaId) => !seen.has(chaId)));
            unpinBelow(root);
        }
        refreshRoot(CHARACTERS);
    });
    runMembershipHook();
}

/**
 * Forgets every record, wrapper, and the write listener (a test's fresh start: the save loop is
 * started again, or its module loaded afresh). Wrappers a test still holds from before stay detached
 * (they belong to an earlier generation).
 */
export function resetRecords() {
    generation += 1;
    writeListener = null;
    characterListener = null;
    untrack(() => {
        bumpModuleMembership();
        bumpModuleAssets();
        for (const kind of Object.keys(records)) {
            delete records[kind];
        }
    });
    metas.clear();
    rootNodes.clear();
    batchDepth = 0;
    batched.clear();
    mutatorDepth = 0;
    runningMutators.clear();
    pendingTrims.clear();
    mutatorWriteback = null;
    runMembershipHook();
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
        const plain =
            kind === "modules"
                ? adoptModuleValue(prepared.value, metaOf(kind), { type: "list" })
                : unwrap(prepared.value, metaOf(kind));
        records[kind] = plain;
        refreshRoot(kind);
        if (kind === "modules") {
            bumpModuleMembership();
            bumpModuleAssets();
        }
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
        const plain =
            kind === "modules"
                ? adoptModuleValue(stored, metaOf(kind), isIndex(field) ? { type: "item" } : null)
                : unwrap(stored, metaOf(kind));
        const created: Record<string, unknown> = {};
        Object.defineProperty(created, field, { value: plain, enumerable: true, writable: true, configurable: true });
        records[kind] = created;
        if (kind === "modules") {
            bumpModuleMembership();
            bumpModuleAssets();
        }
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
    for (const field of removedSecretMaps) {
        if (Object.hasOwn(record, field)) {
            throw new CredentialRefusedError(`${field}: this credential map is no longer supported`);
        }
    }
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
//   - the entry map (`credentials`) are not in this record: a write of
//     them is refused;
//   - `delete` of any credential path is refused (use `clearSecret`).
// - `credentials[].key` (`SECRET_ENTRY_MAPS`): see
//   `prepareEntryCredentials`.

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
// Removed inline keys are refused, so an old caller cannot turn a former secret into record data.
const removedEntrySecrets: Readonly<Record<string, readonly string[]>> = {
    customModels: ["key"],
    modelPresets: ["proxyKey"],
    modelProfiles: ["key", "proxyKey"],
};
const removedSecretMaps = new Set(["customModels", "modelPresets"]);

function refuseRemovedEntrySecret(kind: TrackedKind, field: string) {
    if (removedEntrySecrets[kind]?.includes(field)) {
        throw new CredentialRefusedError(`${kind}.${field}: choose a named key on a model profile instead`);
    }
}

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
        if (removedSecretMaps.has(field)) {
            throw new CredentialRefusedError(`${field}: this credential map is no longer supported`);
        }
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
 * The entry credential rule for a value written into `credentials`
 * (`SECRET_ENTRY_MAPS`; removed inline secrets are refused, other kinds pass through): `value` is the whole list (`listLevel`) or one
 * whole element (`elementLevel`). An element's non-empty string credential is routed with its string `id` and left
 * out of what is stored; a blank or absent one is left out and changes nothing; a non-string one, or
 * a credential on an element without a string id, refuses the whole write. Nothing is routed until
 * `route` runs (after the value is stored). A whole element or list is stored as a copy without the
 * credential when it had one.
 */
function prepareEntryCredentials(
    kind: TrackedKind,
    value: unknown,
    listLevel: boolean,
    elementLevel = false,
): { value: unknown; route: () => void; owners: string[] } {
    const checkRemoved = (entry: unknown) => {
        if (isObject(entry) && !Array.isArray(entry)) {
            for (const field of Object.keys(entry)) {
                refuseRemovedEntrySecret(kind, field);
            }
        }
    };
    if (Object.hasOwn(removedEntrySecrets, kind)) {
        if (listLevel && (Array.isArray(value) || isRecordWrapper(value))) {
            Array.from(value as ArrayLike<unknown>).forEach(checkRemoved);
        } else if (elementLevel) {
            checkRemoved(value);
        }
    }
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
function assertCredentialOwners(kind: TrackedKind, owners: readonly string[], resulting: readonly unknown[]) {
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
    | { type: "id"; field: string; id: string; index: number };

interface TrackedNode {
    kind: TrackedKind;
    meta: RecordMeta;
    /** The `resetRecords` generation the node was made in; an older one never resolves. */
    generation: number;
    /** Under a character: the top-level field the node descends from (`null` for the element itself). */
    field: string | null;
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
/** Bumped by `resetRecords`: wrappers made before it are detached for good. */
let generation = 0;
const rootNodes = new Map<string, TrackedNode>();

const isIndex = (key: string) => /^(0|[1-9]\d*)$/.test(key);

/**
 * The array mutators a wrapper runs in a mutator scope: their arguments are unwrapped first, then
 * the native method runs through the traps, and the elements it displaces during its own run are
 * written back as the objects it read (`sort` and `copyWithin` rewrite the array in place).
 */
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
let mutatorDepth = 0;
/** The nodes whose own mutator is running (it cleans up their shrink when it returns), by depth. */
const runningMutators = new Map<TrackedNode, number>();
/** Only this call's prepared values may skip adoption when written back into its array. */
let mutatorWriteback: { node: TrackedNode; values: Set<unknown> } | null = null;

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
    if (!Object.is(node.target, target) && Array.isArray(target) && node.indexChildren.size > 0) {
        // Another list now stands here (a raw replacement, a reassigned field): its tail is empty.
        pruneIndexTail(node, target.length);
    }
    node.target = target;
    node.epoch = epoch;
    node.meta.owned.add(target);
    if (isCharacterElement(node)) {
        // The list owns its elements too (a list-level read or comparison sees them as its own).
        node.parent!.meta.owned.add(target);
    }
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
        if (node.generation !== generation) {
            throw new DetachedWrapperError(`${node.kind}: the records were reset`);
        }
        const data = records[node.kind];
        if (!isObject(data)) {
            throw new DetachedWrapperError(`${node.kind} is not loaded`);
        }
        adopt(node, data, nodeEpoch(node.meta, null));
        return data;
    }
    const parent = resolve(node.parent);
    const epoch = nodeEpoch(node.meta, node.field);
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
    // A node a raw change unpinned holds no target (`unpinBelow`): it follows its path below.
    if (node.target !== undefined && Object.is(current, node.target)) {
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

/** Whether a local-field input contains state that must not escape through its raw reads. */
function containsRecordState(value: unknown, seen = new Set<object>()): value is object {
    if (!isObject(value) || seen.has(value)) {
        return false;
    }
    if (nodeOf.has(value) || STATE in value) {
        return true;
    }
    seen.add(value);
    return Reflect.ownKeys(value).some((key) => containsRecordState(Reflect.get(value, key), seen));
}

/**
 * A value written into record `kind` through a wrapper:
 * - a wrapper of the same record stores its current `$state` object (`assignedTarget`);
 * - a wrapper of another record stores a detached copy;
 * - a Svelte proxy the record owns is stored as is; any other Svelte proxy a detached copy;
 * - a plain object or array is kept, with the wrappers in it replaced in place by these rules.
 * Character and module writes first use their adoption rules, which copy plain JSON inputs.
 */
function unwrap(value: unknown, meta: RecordMeta, seen = new Set<object>()): unknown {
    if (!isObject(value)) {
        return value;
    }
    const node = nodeOf.get(value);
    if (node) {
        return node.meta === meta ? assignedTarget(node) : detachedCopy(value);
    }
    if (STATE in value) {
        const owned =
            meta.owned.has(value) ||
            (meta.chaId === null &&
                Object.is(
                    untrack(() => records[meta.key]),
                    value,
                ));
        return owned ? value : detachedCopy(value);
    }
    if (seen.has(value)) {
        return value;
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor && "value" in descriptor && isObject(descriptor.value)) {
            const inner = unwrap(descriptor.value, meta, seen);
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

/**
 * A value written into a record (`unwrap`); under a character (`adoptCharacterValue`), `field` names
 * the character's top-level field it goes under (null: unknown).
 */
function unwrapInto(
    value: unknown,
    meta: RecordMeta,
    field: string | null,
    taint: Pick<RecordMeta, "uncacheable"> = meta,
): unknown {
    return meta.chaId === null ? unwrap(value, meta) : adoptCharacterValue(value, meta, field, taint);
}

// ---------------------------------------------------------------------------------------------
// Frozen asset lists (heap plan B1: module `assets`; B2: a character's asset fields).

/**
 * The asset lists and their entries this layer verified and froze: a list is replaced whole, never
 * edited in place, so Svelte proxies only the list, not each entry (its `get` trap creates no source
 * for a non-writable property). Verified values are leaves for the wrappers. Provenance is kept per
 * shape: tuples (module `assets`, `additionalAssets`, `emotionImages`) and flat records
 * (`ccAssets`); an empty list is verified for both. In DEV a Svelte array proxy's target is its
 * `inspectable_array` wrapper; one over a verified list joins its set when first checked
 * (`frozenAssetOf`).
 */
const frozenLists = new WeakSet<object>();
const frozenTuples = new WeakSet<object>();
const frozenRecordLists = new WeakSet<object>();
const frozenRecords = new WeakSet<object>();

/** An asset entry's shape: a tuple of JSON primitives, or a flat record of them (`ccAssets`). */
type AssetShape = "tuple" | "record";

const verifiedLists = (shape: AssetShape) => (shape === "tuple" ? frozenLists : frozenRecordLists);
const verifiedEntries = (shape: AssetShape) => (shape === "tuple" ? frozenTuples : frozenRecords);
const isVerifiedList = (value: object) => frozenLists.has(value) || frozenRecordLists.has(value);

/** A character's asset fields and their entry shapes (`shared/database.ts`). */
const CHARACTER_ASSET_FIELDS: ReadonlyMap<string, AssetShape> = new Map([
    ["additionalAssets", "tuple"],
    ["emotionImages", "tuple"],
    ["ccAssets", "record"],
]);

/** Whether `value`'s own keys are its indices and `length` only (no hole), each a data property. */
function denseDataElements(value: unknown[]): unknown[] | null {
    const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
    const keys = Reflect.ownKeys(value);
    if (!Number.isInteger(length) || length < 0 || keys.length !== length + 1) {
        return null;
    }
    const elements: unknown[] = [];
    for (let index = 0; index < length; index++) {
        // Read through the descriptor: a getter is never called, and makes the value not JSON data.
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            return null;
        }
        elements.push(descriptor.value);
    }
    return elements;
}

/** A flat record's values: string keys (no `__proto__` or `toJSON`), each an enumerable data property. */
function recordDataValues(value: object): unknown[] | null {
    const values: unknown[] = [];
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || key === "__proto__" || key === "toJSON") {
            return null;
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable) {
            return null;
        }
        values.push(descriptor.value);
    }
    return values;
}

const isPlainArray = (value: unknown): value is unknown[] =>
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && !nodeOf.has(value) && !(STATE in value);

const isPlainRecord = (value: unknown): value is object =>
    isObject(value) &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    !nodeOf.has(value) &&
    !(STATE in value);

const isJsonPrimitive = (value: unknown) =>
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** An asset entry of `shape`: a plain dense array, or a plain flat record, of JSON primitives. */
function isAssetEntry(value: unknown, shape: AssetShape): boolean {
    if (isObject(value) && verifiedEntries(shape).has(value)) {
        return true;
    }
    const values =
        shape === "tuple"
            ? isPlainArray(value)
                ? denseDataElements(value)
                : null
            : isPlainRecord(value)
              ? recordDataValues(value)
              : null;
    return values !== null && values.every(isJsonPrimitive);
}

/** Remembers a frozen list as verified for `shape`, or for both shapes when it is empty. */
function verifyList(list: object, shape: AssetShape, empty: boolean) {
    if (empty || shape === "tuple") {
        frozenLists.add(list);
    }
    if (empty || shape === "record") {
        frozenRecordLists.add(list);
    }
}

/**
 * Freezes a plain asset list in place (its entries, then the list) when all of it is plain JSON
 * entries of `shape`, checked before anything is frozen; any other shape stays mutable and keeps
 * working through the wrappers. The caller owns `list` and its entries (detached JSON or this
 * layer's own copy).
 */
function freezeAssetList(list: unknown, shape: AssetShape = "tuple"): boolean {
    if (isObject(list) && verifiedLists(shape).has(list)) {
        return true;
    }
    if (!isPlainArray(list)) {
        return false;
    }
    const entries = denseDataElements(list);
    if (entries === null || !entries.every((entry) => isAssetEntry(entry, shape))) {
        return false;
    }
    for (const entry of entries as object[]) {
        Object.freeze(entry);
        verifiedEntries(shape).add(entry);
    }
    Object.freeze(list);
    verifyList(list, shape, entries.length === 0);
    return true;
}

/** Freezes the `assets` of a plain module object this layer owns (`freezeAssetList`). */
function freezeModuleAssets(element: unknown) {
    if (!isObject(element) || Array.isArray(element) || nodeOf.has(element) || STATE in element) {
        return;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(element, "assets");
    if (descriptor && "value" in descriptor) {
        freezeAssetList(descriptor.value);
    }
}

/** Freezes the asset fields of a plain character object this layer owns (`freezeAssetList`). */
function freezeCharacterAssets(character: unknown) {
    if (!isObject(character) || Array.isArray(character) || nodeOf.has(character) || STATE in character) {
        return;
    }
    for (const [field, shape] of CHARACTER_ASSET_FIELDS) {
        const descriptor = Reflect.getOwnPropertyDescriptor(character, field);
        if (descriptor && "value" in descriptor) {
            freezeAssetList(descriptor.value, shape);
        }
    }
}

/**
 * The verified frozen asset list or entry `value` is (or its Svelte proxy stands for), or null.
 * O(1) in production; a DEV `inspectable_array` target is checked once (O(n)), then remembered.
 */
function frozenAssetOf(value: object): object | null {
    if (isVerifiedList(value) || frozenTuples.has(value) || frozenRecords.has(value)) {
        return value;
    }
    if (!(STATE in value)) {
        return null;
    }
    const target = (value as Record<symbol, object>)[STATE];
    if (isVerifiedList(target)) {
        return target;
    }
    if (!Array.isArray(target) || Object.isExtensible(target) || !Object.isFrozen(target)) {
        return null;
    }
    const elements = denseDataElements(target);
    if (elements === null) {
        return null;
    }
    const shape: AssetShape | null = elements.every((entry) => isObject(entry) && frozenTuples.has(entry))
        ? "tuple"
        : elements.every((entry) => isObject(entry) && frozenRecords.has(entry))
          ? "record"
          : null;
    if (shape === null) {
        return null;
    }
    verifyList(target, shape, elements.length === 0);
    return target;
}

/** A verified frozen asset list (or its Svelte proxy), never a record wrapper that can retarget. */
export function isFrozenAssetList(value: unknown): boolean {
    if (!isObject(value) || nodeOf.has(value)) {
        return false;
    }
    const frozen = untrack(() => frozenAssetOf(value));
    return frozen !== null && isVerifiedList(frozen);
}

/**
 * A wholly owned, frozen copy of `value` as an asset list of `shape`, or null when it is not one (a
 * hole, an accessor, a nested object, another shape). Validate the live descriptors before copying:
 * wrappers resolve as assignment sources, and `$state` descriptors include edits absent from its
 * raw target. Only verified entries of `shape` are shared; no live object of any record is frozen.
 */
function freshAssetList(value: object, shape: AssetShape): unknown[] | null {
    const node = nodeOf.get(value);
    const source = node ? assignedTarget(node) : value;
    if (!Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype) {
        return null;
    }
    const entries = denseDataElements(source);
    if (entries === null) {
        return null;
    }
    const prepared: { entry: object; keys: string[] | null; values: unknown[] | null }[] = [];
    for (const value of entries) {
        if (!isObject(value)) {
            return null;
        }
        const node = nodeOf.get(value);
        const entry = node ? assignedTarget(node) : value;
        if (verifiedEntries(shape).has(entry)) {
            prepared.push({ entry, keys: null, values: null });
            continue;
        }
        const values =
            shape === "tuple"
                ? Array.isArray(entry) && Object.getPrototypeOf(entry) === Array.prototype
                    ? denseDataElements(entry)
                    : null
                : !Array.isArray(entry) && Object.getPrototypeOf(entry) === Object.prototype
                  ? recordDataValues(entry)
                  : null;
        if (values === null || !values.every(isJsonPrimitive)) {
            return null;
        }
        prepared.push({ entry, keys: shape === "record" ? Object.keys(entry) : null, values });
    }
    const out = prepared.map(({ entry, keys, values }) =>
        values === null ? entry : keys === null ? values : Object.fromEntries(keys.map((key, i) => [key, values[i]])),
    );
    return freezeAssetList(out, shape) ? out : null;
}

/**
 * A whole character asset field written (a wrapper write of the field, a stored character's key): a
 * verified frozen list of the field's shape is stored as itself, a list of that shape as a fresh
 * frozen copy (`freshAssetList`; nothing to taint); anything else goes through `adoptCharacterValue`
 * and stays mutable.
 */
function adoptCharacterAssetField(
    value: unknown,
    meta: RecordMeta,
    field: string,
    shape: AssetShape,
    taint: Pick<RecordMeta, "uncacheable">,
): unknown {
    if (isObject(value)) {
        const frozen = frozenAssetOf(value);
        if (frozen !== null && verifiedLists(shape).has(frozen)) {
            return frozen;
        }
        const fresh = freshAssetList(value, shape);
        if (fresh !== null) {
            return fresh;
        }
    }
    return adoptCharacterValue(value, meta, field, taint);
}

/** Refuses a write into a frozen value (Svelte's traps would change their sources, then throw). */
function refuseFrozen(node: TrackedNode, resolved: object) {
    if (!Object.isExtensible(resolved)) {
        throw new TypeError(`${node.kind}: a frozen value is replaced whole, not edited in place`);
    }
}

/**
 * Freezes the asset lists in a module value `adoptModuleValue` copied for `place`: each element of a
 * root list, one element, or an element's whole `assets` field. Own `$state` kept as itself is not
 * touched.
 */
function freezeAdopted(copy: unknown, place: ModulePlace) {
    if (isObject(copy) && STATE in copy) {
        return;
    }
    if (place?.type === "list" && Array.isArray(copy)) {
        for (const element of copy) {
            freezeModuleAssets(element);
        }
    } else if (place?.type === "item") {
        freezeModuleAssets(copy);
    } else if (place?.type === "field" && place.whole && place.field === "assets") {
        freezeAssetList(copy);
    }
}

/**
 * `whole`: the place is the element's top-level field itself (a write of `module.assets`), not a
 * value under it.
 */
type ModulePlace =
    { type: "list" } | { type: "item" } | { type: "field"; element: object; field: string; whole: boolean } | null;

/**
 * Where an already resolved node (or a property written on it) stands in modules. Use its current
 * ancestor targets, never a stored element on a positional node: a raw replacement retargets it.
 * For assignment sources this runs after `assignedTarget`, preserving mutator/displacement rules.
 */
function modulePlace(node: TrackedNode, prop?: string | symbol): ModulePlace {
    if (node.parent === null) {
        return prop === undefined
            ? { type: "list" }
            : typeof prop === "string" && isIndex(prop)
              ? { type: "item" }
              : null;
    }
    let element = node;
    let field = prop;
    let whole = true;
    while (element.parent!.parent !== null) {
        if (element.step.type !== "key") {
            return null;
        }
        field = element.step.key;
        element = element.parent!;
        whole = false;
    }
    if (element.step.type !== "key" || !isIndex(element.step.key)) {
        return null;
    }
    return field === undefined
        ? { type: "item" }
        : typeof field === "string" && element.target !== undefined
          ? { type: "field", element: element.target, field, whole }
          : null;
}

/** The adoption path for a wrapper write, after its destination resolved. */
function unwrapNodeValue(
    value: unknown,
    node: TrackedNode,
    prop?: string | symbol,
    taint: Pick<RecordMeta, "uncacheable"> = node.meta,
): unknown {
    if (node.kind === "modules") {
        if (typeof prop === "symbol" || prop === "toJSON") {
            taint.uncacheable = true;
        }
        return adoptModuleValue(value, node.meta, modulePlace(node, prop), taint);
    }
    const shape = isCharacterElement(node) && typeof prop === "string" ? CHARACTER_ASSET_FIELDS.get(prop) : undefined;
    if (shape !== undefined) {
        return adoptCharacterAssetField(value, node.meta, prop as string, shape, taint);
    }
    return unwrapInto(value, node.meta, node.field ?? (typeof prop === "string" ? prop : null), taint);
}

/**
 * Module adoption: copy plain inputs; keep own state only with a sound cache provenance. A whole
 * element may move between root slots, and a value may stay under the same element field. All other
 * own-state reuse taints the record. Foreign state is detached. Non-JSON inputs keep `unwrap`'s
 * behavior but taint: their text might change without a wrapper write.
 */
function adoptModuleValue(
    value: unknown,
    meta: RecordMeta,
    place: ModulePlace,
    taint: Pick<RecordMeta, "uncacheable"> = meta,
): unknown {
    if (isObject(value) && place?.type === "field" && place.whole && place.field === "assets") {
        // A verified frozen list is immutable: stored as itself, nothing to copy or taint.
        const frozen = frozenAssetOf(value);
        if (frozen !== null && frozenLists.has(frozen)) {
            return frozen;
        }
    }
    const adopted = adoptModuleCopy(value, meta, place, taint);
    if (!Object.is(adopted, value)) {
        freezeAdopted(adopted, place);
    }
    return adopted;
}

/** `adoptModuleValue` before its asset lists are frozen. */
function adoptModuleCopy(
    value: unknown,
    meta: RecordMeta,
    place: ModulePlace,
    taint: Pick<RecordMeta, "uncacheable">,
): unknown {
    if (typeof value === "function") {
        taint.uncacheable = true;
        return value;
    }
    if (!isObject(value)) {
        return value;
    }
    const node = nodeOf.get(value);
    if (node ? node.meta === meta : STATE in value && meta.owned.has(value)) {
        const target = node ? assignedTarget(node) : value;
        const source = node ? modulePlace(node) : null;
        const same =
            source &&
            place &&
            source.type === place.type &&
            (source.type !== "field" ||
                (place.type === "field" && Object.is(source.element, place.element) && source.field === place.field));
        if (!same) {
            taint.uncacheable = true;
        }
        return target;
    }
    if (node || STATE in value) {
        const copy = detachedCopy(value);
        if (moduleInertCopy(copy as object, meta, place, new Set(), taint) === NOT_INERT) {
            taint.uncacheable = true;
        }
        return copy;
    }
    const copy = moduleInertCopy(value, meta, place, new Set(), taint);
    if (copy === NOT_INERT) {
        taint.uncacheable = true;
        return unwrap(value, meta);
    }
    return copy;
}

/** `inertCopy` for modules: only direct children of a root list may reuse whole elements. */
function moduleInertCopy(
    value: object,
    meta: RecordMeta,
    place: ModulePlace,
    path: Set<object>,
    taint: Pick<RecordMeta, "uncacheable">,
): unknown {
    const isArray = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype) || path.has(value)) {
        return NOT_INERT;
    }
    path.add(value);
    const out: any = isArray ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol" || key === "toJSON") {
            return NOT_INERT;
        }
        if (isArray && key === "length") {
            continue;
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value === "function") {
            return NOT_INERT;
        }
        let entry: unknown = descriptor.value;
        // A verified frozen tuple in an asset list, or a verified list as an element's `assets`, is
        // immutable: reused as itself (an edit built from the old list copies only what it changed).
        const reusable =
            isObject(entry) &&
            ((place?.type === "field" && place.field === "assets" && frozenTuples.has(entry)) ||
                (place?.type === "item" && key === "assets" && frozenLists.has(entry)));
        if (isObject(entry) && !reusable) {
            const destination: ModulePlace =
                place?.type === "field"
                    ? place.whole
                        ? { ...place, whole: false }
                        : place
                    : place?.type === "list" && isIndex(key)
                      ? { type: "item" }
                      : place?.type === "item" && key === "assets"
                        ? // Under the new element's `assets`: its tuples may be reused; own state still taints.
                          { type: "field", element: out, field: "assets", whole: false }
                        : null;
            entry =
                nodeOf.has(entry) || STATE in entry
                    ? adoptModuleValue(entry, meta, destination, taint)
                    : moduleInertCopy(entry, meta, destination, path, taint);
            if (entry === NOT_INERT) {
                return NOT_INERT;
            }
        }
        Object.defineProperty(out, key, { value: entry, enumerable: true, writable: true, configurable: true });
    }
    if (isArray) {
        out.length = (value as unknown[]).length;
    }
    path.delete(value);
    return out;
}

/** `inertCopy`'s answer for a value that is not plain JSON data. */
const NOT_INERT = Symbol("not inert");

/**
 * A value written into a character under its top-level `field`, as `unwrap` stores it, keeping the
 * field-text cache sound (`characterFieldStamp`): this character's own state (a wrapper, an owned
 * `$state` object) is stored as itself, and marks the character uncacheable when it may now be shared
 * between two fields (it came from another field, or from somewhere unknown outside a mutator's own
 * write-back, whose inserted values were checked when the call was planned); another record's state
 * is a detached copy; plain JSON data (`inertCopy`) is a fresh copy, so neither the caller's object nor
 * a second field can share it; anything else is stored as `unwrap` stores it, and marks the character
 * uncacheable.
 */
function adoptCharacterValue(
    value: unknown,
    meta: RecordMeta,
    field: string | null,
    taint: Pick<RecordMeta, "uncacheable">,
): unknown {
    if (typeof value === "function") {
        taint.uncacheable = true;
        return value;
    }
    if (!isObject(value)) {
        return value;
    }
    const node = nodeOf.get(value);
    if (node ? node.meta === meta : STATE in value && meta.owned.has(value)) {
        if (!node || field === null || node.field !== field) {
            taint.uncacheable = true;
        }
        return unwrap(value, meta);
    }
    if (node || STATE in value) {
        const copy = detachedCopy(value);
        if (inertCopy(copy as object, meta, field, new Set(), taint) === NOT_INERT) {
            taint.uncacheable = true;
        }
        return copy;
    }
    const copy = inertCopy(value, meta, field, new Set(), taint);
    if (copy === NOT_INERT) {
        taint.uncacheable = true;
        return unwrap(value, meta);
    }
    return copy;
}

/**
 * A fresh copy of plain JSON data written into a character (`adoptCharacterValue`): arrays and
 * `Object.prototype` objects of enumerable data properties (own `__proto__` kept as a key), with no
 * `toJSON` key, symbol key, function, or cycle; this character's state inside is kept as itself and
 * another record's copied (`adoptCharacterValue`). `NOT_INERT` for anything else.
 */
function inertCopy(
    value: object,
    meta: RecordMeta,
    field: string | null,
    path: Set<object>,
    taint: Pick<RecordMeta, "uncacheable">,
): unknown {
    const isArray = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype) || path.has(value)) {
        return NOT_INERT;
    }
    path.add(value);
    const out: any = isArray ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol" || key === "toJSON") {
            return NOT_INERT;
        }
        if (isArray && key === "length") {
            continue;
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable) {
            return NOT_INERT;
        }
        let entry: unknown = descriptor.value;
        if (typeof entry === "function") {
            return NOT_INERT;
        }
        if (isObject(entry)) {
            entry =
                nodeOf.has(entry) || STATE in entry
                    ? adoptCharacterValue(entry, meta, field, taint)
                    : inertCopy(entry, meta, field, path, taint);
            if (entry === NOT_INERT) {
                return NOT_INERT;
            }
        }
        Object.defineProperty(out, key, { value: entry, enumerable: true, writable: true, configurable: true });
    }
    if (isArray) {
        // Trailing holes are `null`s in the JSON text.
        out.length = (value as unknown[]).length;
    }
    path.delete(value);
    return out;
}

/**
 * Drops `node`'s index child entries at `length` or past it (heap plan D1): its list shrank or now is
 * another, shorter list, so no element stands there and the entry would only keep its old object.
 * A surviving element that moved down keeps its node through `meta.children` and is rebound at its
 * next read; entries below `length` are kept (after a raw replacement they stand for the element
 * now there).
 */
function pruneIndexTail(node: TrackedNode, length: number) {
    for (const key of node.indexChildren.keys()) {
        if (isIndex(key) && Number(key) >= length) {
            node.indexChildren.delete(key);
        }
    }
}

/**
 * Points the cached root node of `kind` at the record's current data at once (an installation, a
 * server copy, a whole replacement, a rebuilt list), so it keeps no old copy until its next read.
 * A record that is gone or changed shape leaves the node holding nothing of the old data at its own
 * level (the node itself is kept: a retained root wrapper resolves by kind, and `trackedRoot` decides
 * as before whether a returning record reuses it).
 */
function refreshRoot(kind: string) {
    const node = rootNodes.get(kind);
    if (!node) {
        return;
    }
    const data = untrack(() => records[kind]);
    if (!isObject(data) || node.isArray !== Array.isArray(data)) {
        node.target = undefined;
        pruneIndexTail(node, 0);
        return;
    }
    adopt(node, data, nodeEpoch(node.meta, null));
}

/** Root lists whose original array waits for `trimRootList` (after the pending Svelte flush). */
const pendingTrims = new Set<string>();

/**
 * After a removal from a root list (heap plan D1): Svelte never writes a proxy's original array, which
 * keeps every element it was installed with, so a removed one would stay reachable through it until
 * the record is replaced. Every index is read once (so each has its Svelte source and `get` never
 * falls back to the original), then the original array is overwritten with the live elements and cut
 * to the live length. The `$state` list stays the same object: nothing re-runs, and no reaction is
 * left holding the sources of an abandoned list. Done after the pending flush (`tick`): an effect's
 * teardown in it reads the list as it was, and Svelte's `has` still consults the original array.
 */
function trimRootList(kind: string) {
    if (pendingTrims.size === 0) {
        // Also when that flush threw: the pending set must empty, or no later trim is scheduled.
        void tick().then(trimPendingLists, trimPendingLists);
    }
    pendingTrims.add(kind);
}

function trimPendingLists() {
    const kinds = [...pendingTrims];
    pendingTrims.clear();
    for (const kind of kinds) {
        trimOriginal(kind);
    }
}

function trimOriginal(kind: string) {
    untrack(() => {
        const list = records[kind];
        if (!Array.isArray(list)) {
            return;
        }
        const original = (list as unknown as Record<symbol, unknown>)[STATE];
        if (!Array.isArray(original)) {
            return;
        }
        const length = list.length;
        for (let index = 0; index < length; index += 1) {
            original[index] = list[index];
        }
        original.length = length;
    });
}

/**
 * After a raw change of the data under `node` (a server copy or an installation: its epoch moved, so
 * every node below follows its path at its next read), drops the old objects the nodes below hold
 * (heap plan D1). The nodes stay, so a retained wrapper and a fresh one remain one object; until
 * then they would keep the replaced data alive. Never after a local change, where a moved element
 * is followed by identity.
 */
function unpinBelow(node: TrackedNode, self = false) {
    if (mutatorDepth > 0) {
        // A mutator writes back the objects it read through its nodes' targets (`assignedTarget`):
        // during one (a raw change from a comparator), the targets stay until their next read.
        return;
    }
    const release = (current: TrackedNode) => {
        // An object displaced in this task keeps its node's target: a same-task re-insertion of its
        // wrapper finds it through it (`assignedTarget`).
        if (current.target !== undefined && !current.meta.displaced.has(current.target)) {
            current.target = undefined;
        }
    };
    if (self) {
        release(node);
    }
    const pending: TrackedNode[] = [node];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const children of [current.keyChildren, current.idChildren, current.indexChildren]) {
            for (const child of children.values()) {
                release(child);
                pending.push(child);
            }
        }
    }
}

/** After `node`'s list shrank locally to `length`: a root list's original array is trimmed, any list pruned. */
function afterShrink(node: TrackedNode, length: number) {
    if (node.parent === null) {
        trimRootList(node.kind);
    }
    pruneIndexTail(node, length);
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
    // A character element starts its own owner; anything deeper belongs to its parent's, under the
    // top-level field it descends from.
    const meta = isCharacterList(parentNode) && step.type === "id" ? characterOwner(step.id) : parentNode.meta;
    const field = isCharacterList(parentNode)
        ? null
        : isCharacterElement(parentNode) && step.type === "key"
          ? step.key
          : parentNode.field;
    const node = createNode(parentNode.kind, parentNode, step, value, nodeEpoch(meta, field), meta, field);
    parentNode.meta.owned.add(value);
    return node;
}

/**
 * The lists whose elements get by-id identity: only a list whose ids the normalizer makes unique
 * (a repeated id is re-keyed). Every other element, with or without an `id` (lorebook entries can
 * repeat ids after a re-import), uses object and path identity.
 * - `presets` (the record): `normalizePresets` (`shared/presets.ts`);
 * - `personas` (the record): `normalizePersonas` (`shared/personas.ts`);
 * - `togglePresets` (the record): `normalizeTogglePresets` (`shared/togglePresets.ts`);
 * - `modelPresets` / `modelProfiles`: their shared normalizers (`shared/presets.ts`);
 * - `translatorPresets.items`, `hypaV3Presets.items`: `selectableList`
 *   (`server/src/data/normalize/collections.ts`).
 */
const BY_ID_FIELDS: readonly { kind: TrackedKind; field: string | null; id?: string }[] = [
    { kind: "presets", field: null },
    { kind: COLLECTION_KIND.personas, field: null },
    { kind: COLLECTION_KIND.togglePresets, field: null },
    { kind: COLLECTION_KIND.modelPresets, field: null },
    { kind: COLLECTION_KIND.modelProfiles, field: null },
    { kind: COLLECTION_KIND.translatorPresets, field: "items" },
    { kind: COLLECTION_KIND.hypaV3Presets, field: "items" },
    // The character list: `chaId`, unique by construction (`initializeRecords`, the list operations).
    { kind: CHARACTERS, field: null, id: "chaId" },
];

/** The id field of the list `parentNode` is, when its elements have by-id identity (`BY_ID_FIELDS`). */
function byIdField(parentNode: TrackedNode): string | null {
    for (const entry of BY_ID_FIELDS) {
        if (entry.kind !== parentNode.kind) {
            continue;
        }
        if (entry.field === null && parentNode.parent === null) {
            return entry.id ?? "id";
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
 * ancestor) whose id now matches more than one element of its list. The character list's ids are
 * unique by construction, so a character's writes skip the scan.
 */
function assertUniqueIds(node: TrackedNode) {
    for (let current: TrackedNode | null = node; current !== null; current = current.parent) {
        const step = current.step;
        if (step.type !== "id" || current.parent === null || isCharacterList(current.parent)) {
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
    const epoch = nodeEpoch(parentNode.meta, parentNode.field);
    const refresh = (node: TrackedNode) => {
        if (!Object.is(node.target, value)) {
            adopt(node, value, nodeEpoch(node.meta, node.field));
        } else {
            node.epoch = nodeEpoch(node.meta, node.field);
        }
        return node.proxy;
    };
    if (Array.isArray(parentTarget)) {
        const record = value as Record<string, unknown>;
        const idField = byIdField(parentNode);
        const field = idField !== null && typeof record[idField] === "string" ? idField : null;
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
    if (node.kind === "modules" && modulePlace(node)?.type === "item") {
        // A rebuilt element changes identity even if queueNodeWrite receives an unrelated field.
        bumpModuleMembership();
        bumpModuleAssets();
    }
    if (node.kind === "modules" && modulePlace(node)?.type === "item" && Object.values(node.target!).some(isObject)) {
        // Rebuilding an element for an own inherited-name key keeps its child objects. The old
        // element may still occupy another slot, or be reinserted from `displaced`: two element
        // identities would then share fields, whose writes can stamp only one of them.
        node.meta.uncacheable = true;
    }
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

/** Whether `node` is the character list itself. */
function isCharacterList(node: TrackedNode): boolean {
    return node.kind === CHARACTERS && node.parent === null;
}

/** Whether `node` is one character (an element of the character list). */
function isCharacterElement(node: TrackedNode): boolean {
    return node.parent !== null && isCharacterList(node.parent);
}

/** A local field of a character element (`CHARACTER_LOCAL_FIELDS`): raw, outside the record. */
function isCharacterLocal(node: TrackedNode, prop: string | symbol): boolean {
    return typeof prop === "string" && CHARACTER_LOCAL_FIELDS.has(prop) && isCharacterElement(node);
}

/** Refuses a change of the character list made through its wrapper (`characterStore` changes membership). */
function refuseListWrite(what: string): never {
    throw new TypeError(`characters: ${what} through the character list; use characterStore`);
}

/** Whether `value` (a wrapper, a `$state` object, a plain one) stands for the object `current`. */
function standsFor(value: unknown, current: unknown): boolean {
    if (Object.is(value, current)) {
        return true;
    }
    const node = isObject(value) ? nodeOf.get(value) : undefined;
    if (!node) {
        return false;
    }
    try {
        return Object.is(
            untrack(() => resolve(node)),
            current,
        );
    } catch {
        return false;
    }
}

/** Refuses a change of a character's `chaId` (a same-value assignment changes nothing). */
function refuseChaIdChange(target: Record<string, unknown>, value: unknown, what: string) {
    if (!Object.is(target.chaId, value)) {
        throw new TypeError(`characters: ${what} chaId; a character's id never changes`);
    }
}

/** Lists whose inserted entries must route named keys or refuse removed inline secrets. */
const isEntryList = (node: TrackedNode) =>
    node.parent === null && (Object.hasOwn(entryLeaf, node.kind) || Object.hasOwn(removedEntrySecrets, node.kind));
/** Whether `node` is an element of that list. */
const isEntryElement = (node: TrackedNode) => node.parent !== null && isEntryList(node.parent);

function writeThrough(node: TrackedNode, prop: string, value: unknown): boolean {
    assertUniqueIds(node);
    const target = resolve(node);
    refuseFrozen(node, target);
    const lengthBefore = Array.isArray(target) ? target.length : 0;
    if (isCharacterList(node)) {
        // Only the no-ops a Svelte 3 self-assignment makes; membership changes go through characterStore.
        if (
            (isIndex(prop) && standsFor(value, target[prop])) ||
            (prop === "length" && Object.is(value, target.length))
        ) {
            return true;
        }
        refuseListWrite(`writing ${prop}`);
    }
    if (isCharacterElement(node)) {
        if (CHARACTER_CHAT_FIELDS.has(prop)) {
            refuseChatFieldWrite(prop);
        }
        if (CHARACTER_LOCAL_FIELDS.has(prop)) {
            // Outside the record: the render key, stored raw, nothing queued. Detach any record state
            // inside it so a raw write through the key cannot change persisted data unstamped.
            target[prop] = containsRecordState(value) ? detachedCopy(value) : value;
            return true;
        }
        if (prop === "chaId") {
            refuseChaIdChange(target, value, "assigning");
            return true;
        }
    }
    if (isEntryElement(node)) {
        refuseRemovedEntrySecret(node.kind, prop);
    }
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
        // The id must name this element only.
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
    const plain =
        mutatorWriteback?.node === node && isIndex(prop) && mutatorWriteback.values.has(incoming)
            ? incoming
            : unwrapNodeValue(incoming, node, prop);
    if (!Array.isArray(target) && assignsInheritedName(target, prop)) {
        install(node, writeEntries(target, [[prop, plain]])!);
    } else {
        if (isObject(plain) || Array.isArray(target) || node.keyChildren.has(prop)) {
            displace(node.meta, target[prop]);
        }
        target[prop] = plain;
    }
    route();
    queueNodeWrite(node, prop);
    if (prop === "length" && !runningMutators.has(node) && Array.isArray(target) && target.length < lengthBefore) {
        // A direct truncation (this list's own mutator handles its `length` writes when it returns).
        afterShrink(node, target.length);
    }
    return true;
}

/**
 * A mutator call's arguments as the native method gets them: the values it inserts (`push`,
 * `unshift`, `splice`'s items, `fill`'s value) prepared and unwrapped, every other argument as it is.
 * On a credential list (`credentials`) the inserted credentials are validated together
 * against the list the call leaves (exactly one owner each), `fill` and `copyWithin` refuse a
 * credential (they duplicate elements), and `route` routes them once the method succeeded.
 */
function planMutator(
    node: TrackedNode,
    target: unknown[],
    method: string,
    args: unknown[],
): { args: unknown[]; values: Set<unknown>; route: () => void } {
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
    const taint = { uncacheable: false };
    const values = new Set<unknown>();
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
        const plain = unwrapNodeValue(
            value,
            node,
            node.kind === "modules" && node.parent === null ? "0" : undefined,
            taint,
        );
        values.add(plain);
        return plain;
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
    node.meta.uncacheable ||= taint.uncacheable;
    return {
        args: next,
        values,
        route: () => {
            for (const route of routes) {
                route();
            }
        },
    };
}

function createNode(
    kind: TrackedKind,
    parent: TrackedNode | null,
    step: Step,
    target: object | undefined,
    epoch: number,
    meta: RecordMeta = metaOf(kind),
    field: string | null = null,
): TrackedNode {
    const isArray = Array.isArray(target);
    const node: TrackedNode = {
        kind,
        meta,
        generation,
        field,
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
            if (CHARACTER_CHAT_FIELDS.has(prop) && isCharacterElement(node)) {
                const chaId = resolved.chaId as string;
                return prop === "chats" ? characterChatView?.chats(chaId) : characterChatView?.chatPage(chaId);
            }
            const value = resolved[prop];
            if (typeof value === "function" && Array.isArray(resolved) && MUTATORS.has(prop)) {
                if (isCharacterList(node)) {
                    return () => refuseListWrite(`calling ${prop}`);
                }
                let mutator = node.mutators.get(prop);
                if (!mutator) {
                    const native = value as (...args: unknown[]) => unknown;
                    mutator = (...args: unknown[]) => {
                        // Every inserted value is prepared (credentials validated and stripped) and
                        // unwrapped before the method runs, so a retained wrapper resolves its current
                        // identity (or throws) and nothing changes on a refusal. Its writes are queued
                        // once, when it ends (also when it throws).
                        const { plan, list, before } = untrack(() => {
                            const list = resolve(node);
                            refuseFrozen(node, list);
                            return { plan: planMutator(node, list, prop, args), list, before: list.length };
                        });
                        return batchRecordWrites(() => {
                            mutatorDepth += 1;
                            runningMutators.set(node, (runningMutators.get(node) ?? 0) + 1);
                            const previous = mutatorWriteback;
                            mutatorWriteback = { node, values: plan.values };
                            let result: unknown;
                            try {
                                result = Reflect.apply(native, node.proxy, plan.args);
                            } finally {
                                mutatorWriteback = previous;
                                mutatorDepth -= 1;
                                const running = runningMutators.get(node)! - 1;
                                if (running === 0) {
                                    runningMutators.delete(node);
                                } else {
                                    runningMutators.set(node, running);
                                }
                            }
                            plan.route();
                            // Only after a call that returned (a throwing one is cleaned up by the
                            // next shrink or replacement), and only while the list is still this one.
                            untrack(() => {
                                if (Object.is(node.target, list) && list.length < before) {
                                    afterShrink(node, list.length);
                                }
                            });
                            return result;
                        });
                    };
                    node.mutators.set(prop, mutator);
                }
                return mutator;
            }
            if (isCharacterLocal(node, prop)) {
                return value;
            }
            // An inherited `__proto__` read returns the prototype, which is never wrapped.
            if (isObject(value) && (prop !== "__proto__" || Object.hasOwn(resolved, prop))) {
                // A verified frozen asset list or tuple is a leaf: immutable, replaced whole.
                return frozenAssetOf(value) ?? childWrapper(node, resolved, prop, value);
            }
            return value;
        },
        set(_, prop, value) {
            if (typeof prop === "symbol") {
                return untrack(() => {
                    const resolved = resolve(node);
                    refuseFrozen(node, resolved);
                    if (node.kind === "modules") {
                        const done = Reflect.set(resolved, prop, unwrapNodeValue(value, node, prop));
                        queueNodeWrite(node, prop);
                        return done;
                    }
                    return Reflect.set(
                        resolved,
                        prop,
                        node.meta.chaId === null ? value : unwrapInto(value, node.meta, null),
                    );
                });
            }
            // Writes resolve untracked: an `$effect` that writes through a wrapper must not subscribe
            // to the path it writes.
            return untrack(() => writeThrough(node, prop, value));
        },
        deleteProperty(_, prop) {
            return untrack(() => {
                if (isCharacterList(node)) {
                    refuseListWrite(`deleting ${String(prop)}`);
                }
                assertUniqueIds(node);
                const resolved = resolve(node);
                refuseFrozen(node, resolved);
                if (typeof prop === "string" && CHARACTER_CHAT_FIELDS.has(prop) && isCharacterElement(node)) {
                    refuseChatFieldWrite(prop);
                }
                if (isCharacterLocal(node, prop)) {
                    return Reflect.deleteProperty(resolved, prop);
                }
                if (isCharacterElement(node) && prop === "chaId") {
                    throw new TypeError("characters: deleting chaId; a character's id never changes");
                }
                const container = llmContainer(node);
                if (container !== undefined && typeof prop === "string") {
                    llmSecretDelete(container, prop);
                }
                if (isEntryElement(node) && prop === entryLeaf[node.kind]) {
                    throw new CredentialRefusedError(`${node.kind}.${prop}: delete a credential with clearSecret`);
                }
                displace(node.meta, resolved[prop]);
                const done = Reflect.deleteProperty(resolved, prop);
                queueNodeWrite(node, prop);
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
                if (isCharacterList(node)) {
                    refuseListWrite(`defining ${String(prop)}`);
                }
                assertUniqueIds(node);
                const resolved = resolve(node);
                refuseFrozen(node, resolved);
                if (isCharacterElement(node) && typeof prop === "string") {
                    if (CHARACTER_CHAT_FIELDS.has(prop)) {
                        refuseChatFieldWrite(prop);
                    }
                    if (CHARACTER_LOCAL_FIELDS.has(prop) || prop === "chaId") {
                        // The `set` way: raw for a local field, the id refused unless unchanged.
                        return writeThrough(node, prop, descriptor.value);
                    }
                }
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
                    "value" in descriptor
                        ? {
                              ...descriptor,
                              value: unwrapNodeValue(descriptor.value, node, prop),
                          }
                        : descriptor;
                const done = Reflect.defineProperty(resolved, prop, prepared);
                queueNodeWrite(node, prop);
                return done;
            });
        },
        has(_, prop) {
            return Reflect.has(resolve(node), prop);
        },
        ownKeys() {
            return Reflect.ownKeys(resolve(node));
        },
        getOwnPropertyDescriptor(standIn, prop) {
            const resolved = resolve(node);
            const descriptor = Reflect.getOwnPropertyDescriptor(resolved, prop);
            if (
                descriptor &&
                "value" in descriptor &&
                typeof prop === "string" &&
                isObject(descriptor.value) &&
                !isCharacterLocal(node, prop)
            ) {
                // Svelte's `getOwnPropertyDescriptor` may return the raw target's value; it is read
                // through the proxy instead, so the wrapper stands for the `$state` object (a
                // verified frozen asset value is a leaf). A character's local fields stay raw.
                const value = resolved[prop];
                descriptor.value = frozenAssetOf(value) ?? childWrapper(node, resolved, prop, value);
            } else if (descriptor && "value" in descriptor && isCharacterLocal(node, prop)) {
                descriptor.value = resolved[prop];
            }
            if (descriptor?.configurable === false) {
                // A retained wrapper whose node now resolves to a frozen value: report what the
                // stand-in target allows (the Proxy invariants would throw on `Object.keys`, spread).
                const own = Reflect.getOwnPropertyDescriptor(standIn, prop);
                if (own === undefined || own.configurable !== false) {
                    descriptor.configurable = true;
                } else if ("writable" in own && own.writable) {
                    descriptor.writable = true;
                }
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
    return trackedRoot<T>(kind);
}

function trackedRoot<T>(kind: TrackedKind): T | undefined {
    const data = records[kind];
    if (!isObject(data)) {
        return undefined;
    }
    let node = rootNodes.get(kind);
    if (!node || node.isArray !== Array.isArray(data)) {
        const meta = metaOf(kind);
        node = createNode(kind, null, { type: "root" }, untrack(() => records[kind]) as object, nodeEpoch(meta, null));
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
    if (isCharacterList(node)) {
        refuseListWrite("moving or replacing characters");
    }
    const target = untrack(() => resolve(node));
    if (!Array.isArray(target)) {
        throw new TypeError(`${node.kind}: not a list`);
    }
    refuseFrozen(node, target);
    return { node, target };
}

/**
 * Moves the element at `from` of a record list (a wrapper, e.g. `settings.presets`) to `to` (its
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
        queueNodeWrite(wrapped.node);
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
        const plain = unwrapNodeValue(prepared.value, node) as unknown[];
        // The elements the replacement drops count as displaced (a same-task re-insertion is allowed).
        const kept = new Set<unknown>(plain);
        for (const old of Array.from(target)) {
            if (!kept.has(old)) {
                displace(node.meta, old);
            }
        }
        const before = target.length;
        target.splice(0, target.length, ...plain);
        prepared.route();
        if (target.length < before) {
            afterShrink(node, target.length);
        }
    });
    queueNodeWrite(node);
}

// ---------------------------------------------------------------------------------------------
// The character list (Phase 6 slice 5, `character-ownership`).
//
// `characterList()` is the list's wrapper (`trackedCharacters`): an element is one character,
// by id on `chaId`; a write under it (any depth, except its local field `reloadKeys`, which stays raw)
// queues that character's save. Its `chats` and `chatPage` are the chat module's compatibility view
// for the shared CBS evaluator (Phase 6 slice 9a; `setCharacterChatView`): never stored on the record, written only through the chat
// module. The list's membership changes only
// through the operations below, which `characterStore` calls: each validates first, changes the raw
// list once, queues the membership change and the characters it stored, and runs the selection's hook.
// The raw path (`applyRawCharacter`, `patchRawCharacter`) is the save loop's: it queues nothing.

type CharacterObject = Record<string, unknown>;

/** The raw `$state` character list, read untracked (the save loop's projection and diffs). */
export function characterData(): CharacterObject[] {
    return (untrack(() => records[CHARACTERS]) as CharacterObject[] | undefined) ?? [];
}

/** The index of the character with `chaId` in the list, tracked (a reactive read); -1 when absent. */
export function characterIndex(chaId: string | null): number {
    if (chaId === null) {
        return -1;
    }
    const list = records[CHARACTERS] as CharacterObject[] | undefined;
    if (!Array.isArray(list)) {
        return -1;
    }
    for (let index = 0; index < list.length; index += 1) {
        if (list[index]?.chaId === chaId) {
            return index;
        }
    }
    return -1;
}

/** The character list's wrapper (`characterList()`); `undefined` before an installation. */
export function trackedCharacters<T = unknown[]>(): T | undefined {
    return trackedRoot<T>(CHARACTERS);
}

function rawList(): CharacterObject[] {
    const list = untrack(() => records[CHARACTERS]) as CharacterObject[] | undefined;
    if (!Array.isArray(list)) {
        throw new DetachedWrapperError("characters are not loaded");
    }
    return list;
}

function requireNewId(list: readonly CharacterObject[], chaId: unknown, replacing = -1): string {
    if (typeof chaId !== "string" || chaId === "") {
        throw new TypeError("characters: a character needs a chaId");
    }
    if (list.some((entry, index) => index !== replacing && entry?.chaId === chaId)) {
        throw new TypeError(`characters: a character with chaId ${chaId} already exists`);
    }
    return chaId;
}

/**
 * A whole character as the list stores it, for the owner of `chaId`: its fields unwrapped by that
 * owner's rules (a value of another character is copied), its local fields kept when they are the
 * ones `current` (the same character's stored object) holds, copied when they contain another `$state`
 * object or a wrapper at any depth, kept when plain.
 */
function storedCharacter(value: unknown, chaId: string, current: CharacterObject | undefined): CharacterObject {
    if (!isObject(value) || Array.isArray(value)) {
        throw new TypeError("characters: a character is an object");
    }
    const meta = characterOwner(chaId);
    const node = nodeOf.get(value);
    if (node && node.meta === meta && isCharacterElement(node)) {
        return assignedTarget(node) as CharacterObject;
    }
    const source = (node ? detachedCopy(value) : value) as CharacterObject;
    const out: CharacterObject = {};
    for (const key of Object.keys(source)) {
        if (CHARACTER_CHAT_FIELDS.has(key)) {
            // The chats are the chat module's (the caller handed them to it).
            continue;
        }
        const entry = source[key];
        let stored: unknown;
        if (CHARACTER_LOCAL_FIELDS.has(key)) {
            stored =
                current !== undefined && Object.is(entry, current[key])
                    ? entry
                    : containsRecordState(entry)
                      ? detachedCopy(entry)
                      : entry;
        } else {
            const shape = CHARACTER_ASSET_FIELDS.get(key);
            stored =
                shape === undefined
                    ? unwrapInto(entry, meta, key)
                    : adoptCharacterAssetField(entry, meta, key, shape, meta);
        }
        Object.defineProperty(out, key, { value: stored, enumerable: true, writable: true, configurable: true });
    }
    return out;
}

/**
 * Drops the canonical nodes of characters that left the list (heap plan D1), so the list's node no
 * longer keeps a removed character's data. Their per-character metas stay: a retained wrapper keeps
 * its node's meta, and a same-id re-add must stamp that same one (`characterOwner`). A retained
 * wrapper of a removed character is an orphan: it throws while the id is absent and follows a
 * same-id re-add by id, as a different object from the re-added character's fresh wrapper.
 */
function forgetCharacterNodes(ids: Iterable<string>) {
    const root = rootNodes.get(CHARACTERS);
    if (!root) {
        return;
    }
    for (const chaId of ids) {
        root.idChildren.delete(chaId);
    }
}

/** Runs a membership change of the list and what follows it: the queue and the selection's hook. */
function changeMembership(change: () => readonly string[]) {
    const stored = untrack(change);
    batchRecordWrites(() => {
        queueMembership();
        for (const chaId of stored) {
            queueCharacterWrite(chaId);
        }
    });
    runMembershipHook();
}

/** The selection's hook, untracked (it reconciles `$state`; a caller may be inside a `$derived`). */
function runMembershipHook() {
    untrack(() => membershipHook?.());
}

/** Appends a character (a detached, checked object with a new `chaId`); returns its index. */
export function insertCharacterRecord(value: CharacterObject): number {
    let index = -1;
    changeMembership(() => {
        const list = rawList();
        const chaId = requireNewId(list, value.chaId);
        // A new record (an id created again included): its stamps start afresh, before its values are adopted.
        renewStamps(characterOwner(chaId));
        const stored = storedCharacter(value, chaId, undefined);
        index = list.length;
        list.push(stored);
        return [chaId];
    });
    return index;
}

/**
 * Stores a character at `index` (an existing index, or the list's length to append). The same
 * `chaId` as the character there replaces it (its retained wrappers follow it); another id puts a
 * different character there (the one there leaves the list), refused when another character has it.
 */
export function replaceCharacterRecordAt(index: number, value: CharacterObject) {
    changeMembership(() => {
        const list = rawList();
        if (!Number.isInteger(index) || index < 0 || index > list.length) {
            throw new TypeError("characters: no character at this index");
        }
        const current = list[index];
        const chaId = requireNewId(list, value.chaId, index);
        if (current?.chaId !== chaId) {
            renewStamps(characterOwner(chaId));
        }
        const stored = storedCharacter(value, chaId, current?.chaId === chaId ? current : undefined);
        const leaving = current !== undefined && current.chaId !== chaId ? (current.chaId as string) : null;
        if (!Object.is(stored, current)) {
            if (current !== undefined && current.chaId === chaId) {
                // A whole replacement of the character: what was under it follows the new object by path.
                const owner = characterOwner(chaId);
                displace(owner, current);
                bumpEpoch(owner);
                // A retained wrapper of a field now reads the new value: its stamp changes with it.
                for (const field of new Set([...Object.keys(current), ...Object.keys(stored)])) {
                    if (!Object.is(current[field], stored[field])) {
                        stampField(owner, field);
                    }
                }
            }
            list[index] = stored;
        }
        if (leaving !== null) {
            // The character that was here left the list.
            forgetCharacterNodes([leaving]);
            trimRootList(CHARACTERS);
        }
        return [chaId];
    });
}

/** Removes the characters with these ids (one change of the list); returns the ids it removed. */
export function removeCharacterRecords(ids: readonly string[]): string[] {
    const wanted = new Set(ids);
    const removed: string[] = [];
    changeMembership(() => {
        const list = rawList();
        for (let index = list.length - 1; index >= 0; index -= 1) {
            const chaId = list[index]?.chaId;
            if (typeof chaId === "string" && wanted.has(chaId)) {
                list.splice(index, 1);
                removed.unshift(chaId);
                // A character created again with this id is a new record: retained wrappers follow by path.
                bumpEpoch(characterOwner(chaId));
            }
        }
        if (removed.length > 0) {
            forgetCharacterNodes(removed);
            trimRootList(CHARACTERS);
        }
        return [];
    });
    return removed;
}

/**
 * The raw path of a server copy of one character (a conflict reload, a live update, a job
 * hydration): its own fields replaced (its render key kept), a new one appended (its chats come from
 * the chat module's collection read), or removed (`null`). Queues nothing; retained wrappers of that character follow it by path.
 * `data` is handed over: detached JSON nobody edits afterwards (its asset lists are frozen in place,
 * `freezeAssetList`).
 */
export function applyRawCharacter(chaId: string, data: CharacterObject | null) {
    untrack(() => {
        const list = rawList();
        const index = list.findIndex((entry) => entry?.chaId === chaId);
        bumpEpoch(characterOwner(chaId));
        // The server's copy: detached JSON data.
        renewStamps(characterOwner(chaId));
        freezeCharacterAssets(data);
        if (data === null) {
            if (index !== -1) {
                list.splice(index, 1);
                forgetCharacterNodes([chaId]);
                trimRootList(CHARACTERS);
            }
        } else if (index === -1) {
            const added: CharacterObject = { ...data, chaId };
            stripChatFields(added);
            list.push(added);
        } else {
            const local = list[index];
            const replaced: CharacterObject = { ...data, chaId, reloadKeys: local.reloadKeys };
            stripChatFields(replaced);
            list[index] = replaced;
            // Its wrappers follow by path; until their next read they would keep the old copy.
            const node = rootNodes.get(CHARACTERS)?.idChildren.get(chaId);
            if (node) {
                unpinBelow(node, true);
            }
        }
    });
    runMembershipHook();
}

/**
 * The raw path of a merged server change (`mergeConcurrentChange`): sets (or, with `REMOVE_FIELD`,
 * deletes) own fields of a character in place. Queues nothing; retained wrappers under the changed
 * fields follow them by path, all others keep their identity. Returns `false` when no character has
 * `chaId`. The values are handed over: detached JSON nobody edits afterwards (an asset field's list is
 * frozen in place, `freezeAssetList`).
 */
export function patchRawCharacter(chaId: string, changes: readonly (readonly [string, unknown])[]): boolean {
    return untrack(() => {
        const target = characterData().find((entry) => entry?.chaId === chaId);
        if (!target) {
            return false;
        }
        // Only the changed fields' subtrees follow their paths; every other wrapper of the character
        // keeps its identity (a retained lore entry moved locally stays that entry).
        const owner = characterOwner(chaId);
        const node = rootNodes.get(CHARACTERS)?.idChildren.get(chaId);
        for (const [field] of changes) {
            epochCounter += 1;
            owner.fieldEpochs.set(field, epochCounter);
            // Stamped even when the value is the one held: it may have changed in place.
            stampField(owner, field);
            // The field's wrappers follow by path; until their next read they would keep the old value.
            const fieldNode = node?.keyChildren.get(field);
            if (fieldNode) {
                unpinBelow(fieldNode, true);
            }
        }
        for (const [field, value] of changes) {
            if (value === REMOVE_FIELD) {
                delete target[field];
            } else {
                const shape = CHARACTER_ASSET_FIELDS.get(field);
                if (shape !== undefined) {
                    freezeAssetList(value, shape);
                }
                target[field] = value;
            }
        }
        return true;
    });
}

/** `patchRawCharacter`'s marker for a field to delete. */
export const REMOVE_FIELD = Symbol("remove field");
