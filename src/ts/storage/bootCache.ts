import {
    BOOT_CACHED_KINDS,
    BOOT_ITEM_HASH_PATTERN,
    BOOT_ITEM_KINDS,
    BOOT_RESOURCE_FORMAT,
    MAX_BOOT_BODY_BYTES,
    RESOURCE_KIND,
    type ResourceBootRequest,
    type ResourceReadKindsResult,
    type ResourceRecord,
} from "../../../shared/resources.ts";
import type { BOOT_CACHE_REASONS, DiagnosticEventInput } from "../../../shared/diagnostics.ts";
import { newId } from "../../../shared/ids.ts";

/**
 * The boot cache (`docs/plan/boot-resource-cache.md` slice 3): the boot read goes through
 * `POST /api/resources/boot` with what an IndexedDB cache holds, and the answer is expanded into
 * the plain `ResourceReadKindsResult` a full read gives, so nothing after the read changes. The
 * cache holds exactly what the server sent (record texts at their revisions, item texts by their
 * server hashes), never the tab's live state, and is written once after the boot.
 *
 * Any failure falls back to the plain read once: a cache that cannot be read, a boot request that
 * failed, or an answer the cache cannot use (the last also clears the cache). A character holding
 * a TTS API key (`oaiTTSConfig.apiKey`) is never cached. Writes and clears are fenced by a
 * generation in the cache's meta, so a tab never overwrites a newer tab's cache.
 */

/** The cache's own layout; bump it for any incompatible change. */
export const BOOT_CACHE_FORMAT = 1;
/** Most claims (records plus hashes) a boot request carries, as the server allows. */
export const MAX_BOOT_CLAIMS = 5000;
const MAX_RECORD_ID_LENGTH = 512;
const MAX_REVISION_LENGTH = 256;
// Match isValidResourceId in server/src/data/resourceStore.ts before advertising cached ids.
const controlCharacterRegex = /[\u0000-\u001f\u007f]/;
const loneSurrogateRegex = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isValidResourceId(id: unknown): id is string {
    return (
        typeof id === "string" &&
        id.length >= 1 &&
        id.length <= MAX_RECORD_ID_LENGTH &&
        id !== "." &&
        id !== ".." &&
        !controlCharacterRegex.test(id) &&
        !loneSurrogateRegex.test(id)
    );
}

export type CachedRecord =
    | { kind: string; id: string; revision: string; text: string; hashes?: never }
    | { kind: string; id: string; revision: string; hashes: string[]; text?: never };

export type BootCacheMeta = { format: number; appVer: string; generation: string };

/** What a cache read gave: its meta (null when none) and the usable records with the item texts they name. */
export type BootCacheContents = {
    meta: BootCacheMeta | null;
    /** Valid, of a cached kind, from a cache of this format and app version. */
    records: CachedRecord[];
    /** `kind\0hash` → the item's JSON text, for the hashes the records name. */
    items: Map<string, string>;
};

/** One fenced write: applied only while the cache's generation is still `expectGeneration`. */
export type BootCacheWrite = {
    expectGeneration: string | null;
    meta: BootCacheMeta;
    /** Clear every store first (the contents were of another format or app version). */
    clear: boolean;
    /** The whole new manifest: every record the cache should hold afterwards. */
    records: CachedRecord[];
    /** Records whose entry must be (re)written; the others are already stored as they are. */
    changed: CachedRecord[];
    /** New item texts by `kind\0hash`. */
    items: Map<string, string>;
};

export interface BootCacheStore {
    /** The cache in one read (throws when it cannot be read). */
    load(): Promise<BootCacheContents>;
    /** Applies the write in one transaction; "skipped" when another tab wrote since (the fence). */
    write(write: BootCacheWrite): Promise<"written" | "skipped">;
    /** Clears the cache unless another tab wrote since `expectGeneration` (undefined: unconditionally). */
    clear(expectGeneration?: string | null): Promise<"cleared" | "skipped">;
}

export class BootCacheMiss extends Error {
    readonly reason: "format" | "incomplete";
    constructor(reason: "format" | "incomplete", message: string) {
        super(message);
        this.name = "BootCacheMiss";
        this.reason = reason;
    }
}

export const recordKey = (kind: string, id: string) => `${kind}\u0000${id}`;
export const itemKey = (kind: string, hash: string) => `${kind}\u0000${hash}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A character holding a plaintext credential: never cached (`oaiTTSConfig.apiKey`). */
export function holdsCredential(kind: string, data: unknown): boolean {
    if (kind !== RESOURCE_KIND.characters || !isPlainObject(data)) {
        return false;
    }
    const tts = data.oaiTTSConfig;
    return isPlainObject(tts) && typeof tts.apiKey === "string" && tts.apiKey !== "";
}

/** A stored record entry checked at runtime, or null (dropped from the contents). */
export function checkCachedRecord(value: unknown): CachedRecord | null {
    if (!isPlainObject(value)) {
        return null;
    }
    const { kind, id, revision, text, hashes } = value;
    if (
        typeof kind !== "string" ||
        !BOOT_CACHED_KINDS.includes(kind) ||
        !isValidResourceId(id) ||
        typeof revision !== "string" ||
        revision.length === 0 ||
        revision.length > MAX_REVISION_LENGTH
    ) {
        return null;
    }
    if (typeof text === "string" && hashes === undefined) {
        return { kind, id, revision, text };
    }
    if (
        text === undefined &&
        BOOT_ITEM_KINDS.includes(kind) &&
        Array.isArray(hashes) &&
        hashes.every((hash) => typeof hash === "string" && BOOT_ITEM_HASH_PATTERN.test(hash))
    ) {
        return { kind, id, revision, hashes: [...hashes] };
    }
    return null;
}

/** A stored meta entry checked at runtime, or null. */
export function checkCacheMeta(value: unknown): BootCacheMeta | null {
    if (!isPlainObject(value)) {
        return null;
    }
    const { format, appVer, generation } = value;
    return typeof format === "number" && typeof appVer === "string" && typeof generation === "string"
        ? { format, appVer, generation }
        : null;
}

/** Whether the contents' meta is this format and app version (otherwise the records are not usable). */
export function isCurrentMeta(meta: BootCacheMeta | null, appVer: string): boolean {
    return meta !== null && meta.format === BOOT_CACHE_FORMAT && meta.appVer === appVer;
}

/** The request of one boot and the claims it advertised: the answer is expanded against exactly these. */
export type BootRequestContext = {
    request: ResourceBootRequest;
    contents: BootCacheContents;
    /** `kind\0id` → the advertised record. */
    claims: Map<string, CachedRecord>;
    /** Kind → the advertised item hashes. */
    hashes: Map<string, Set<string>>;
};

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * The boot request for `contents`: every kind with chat summaries (as the plain read), claiming each
 * complete record (an item record only when every item text is there) and every item hash whose text
 * is there. Over `MAX_BOOT_CLAIMS` claims or `MAX_BOOT_BODY_BYTES` it claims nothing.
 */
export function prepareBootRequest(contents: BootCacheContents): BootRequestContext {
    const claims = new Map<string, CachedRecord>();
    const hashes = new Map<string, Set<string>>();
    for (const record of contents.records) {
        if (record.hashes !== undefined) {
            const set = hashes.get(record.kind) ?? new Set<string>();
            let complete = true;
            for (const hash of record.hashes) {
                if (contents.items.has(itemKey(record.kind, hash))) {
                    set.add(hash);
                } else {
                    complete = false;
                }
            }
            hashes.set(record.kind, set);
            if (!complete) {
                continue;
            }
        }
        claims.set(recordKey(record.kind, record.id), record);
    }
    const base: ResourceBootRequest = { kinds: Object.values(RESOURCE_KIND), chatSummaries: true };
    const claimCount = claims.size + [...hashes.values()].reduce((sum, set) => sum + set.size, 0);
    if (claimCount === 0) {
        return { request: base, contents, claims: new Map(), hashes: new Map() };
    }
    const request: ResourceBootRequest = {
        ...base,
        known: {
            records: [...claims.values()].map(({ kind, id, revision }) => ({ kind, id, revision })),
            items: [...hashes].filter(([, set]) => set.size > 0).map(([kind, set]) => ({ kind, hashes: [...set] })),
        },
    };
    if (claimCount > MAX_BOOT_CLAIMS || utf8Length(JSON.stringify(request)) > MAX_BOOT_BODY_BYTES) {
        return { request: base, contents, claims: new Map(), hashes: new Map() };
    }
    return { request, contents, claims, hashes };
}

/** What a boot answer gave: the plain read result, and the cache write that records it. */
export type ExpandedBoot = {
    snapshot: ResourceReadKindsResult;
    /** The new manifest and item texts (texts captured now, before anything installs the data). */
    manifest: CachedRecord[];
    items: Map<string, string>;
};

const miss = (message: string) => new BootCacheMiss("incomplete", message);

/**
 * The boot answer expanded against the request's advertised claims into what the plain read gives
 * (same epoch, kinds, record order, revisions, data, chat summaries and orders). A `cached` record
 * or an item without `data` is accepted only for an exact advertised claim. Throws `BootCacheMiss`
 * for an answer of another format or shape, or an omission the request did not allow; a cached
 * text that does not parse throws its `SyntaxError`.
 */
export function expandBootAnswer(answer: unknown, context: BootRequestContext): ExpandedBoot {
    if (!isPlainObject(answer) || answer.format !== BOOT_RESOURCE_FORMAT) {
        throw new BootCacheMiss("format", "The boot answer has another format");
    }
    const { epoch, kinds, chatSummaries, chatOrders } = answer;
    if (typeof epoch !== "string" || !isPlainObject(kinds)) {
        throw new BootCacheMiss("format", "The boot answer has no epoch or kinds");
    }
    for (const kind of context.request.kinds) {
        if (!Object.hasOwn(kinds, kind) || !Array.isArray(kinds[kind])) {
            throw new BootCacheMiss("format", `The boot answer has no list for ${kind}`);
        }
    }
    if (!Array.isArray(chatSummaries) || !Array.isArray(chatOrders)) {
        throw new BootCacheMiss("format", "The boot answer has no chat summaries or orders");
    }
    const resultKinds: Record<string, ResourceRecord[]> = {};
    const manifest: CachedRecord[] = [];
    const items = new Map<string, string>();
    for (const [kind, records] of Object.entries(kinds)) {
        if (!Array.isArray(records)) {
            throw new BootCacheMiss("format", `The boot answer's ${kind} is not a list`);
        }
        const cachedKind = BOOT_CACHED_KINDS.includes(kind);
        const itemKind = BOOT_ITEM_KINDS.includes(kind);
        resultKinds[kind] = records.map((record): ResourceRecord => {
            if (!isPlainObject(record) || typeof record.id !== "string" || typeof record.revision !== "string") {
                throw new BootCacheMiss("format", `A ${kind} record of the boot answer has no id or revision`);
            }
            const { id, revision } = record;
            const key = recordKey(kind, id);
            if (["cached", "data", "items"].filter((variant) => Object.hasOwn(record, variant)).length > 1) {
                throw new BootCacheMiss("format", `${kind} ${id} has more than one record variant`);
            }
            if (Object.hasOwn(record, "cached")) {
                const claim = context.claims.get(key);
                if (record.cached !== true || !cachedKind || !claim || claim.revision !== revision) {
                    throw miss(`The boot answer left out ${kind} ${id}, which this boot did not claim`);
                }
                if (claim.text !== undefined) {
                    const data: unknown = JSON.parse(claim.text);
                    if (kind === RESOURCE_KIND.characters && (!isPlainObject(data) || data.chaId !== id)) {
                        throw miss(`The cached character ${id} has an invalid shape or id`);
                    }
                    if (!holdsCredential(kind, data)) {
                        manifest.push(claim);
                    }
                    return { id, revision, data };
                }
                const texts = claim.hashes.map((hash) => context.contents.items.get(itemKey(kind, hash)));
                if (texts.some((text) => text === undefined)) {
                    throw miss(`An item of ${kind} ${id} is missing from the cache`);
                }
                manifest.push(claim);
                return { id, revision, data: texts.map((text) => JSON.parse(text as string)) };
            }
            if (Object.hasOwn(record, "items")) {
                if (!itemKind || !Array.isArray(record.items)) {
                    throw new BootCacheMiss("format", `${kind} ${id} has items, which its kind does not take`);
                }
                const advertised = context.hashes.get(kind);
                const hashes: string[] = [];
                const data = record.items.map((entry: unknown) => {
                    if (
                        !isPlainObject(entry) ||
                        typeof entry.hash !== "string" ||
                        !BOOT_ITEM_HASH_PATTERN.test(entry.hash)
                    ) {
                        throw new BootCacheMiss("format", `An item of ${kind} ${id} has no hash`);
                    }
                    hashes.push(entry.hash);
                    if (Object.hasOwn(entry, "data")) {
                        items.set(itemKey(kind, entry.hash), JSON.stringify(entry.data));
                        return entry.data;
                    }
                    const text = context.contents.items.get(itemKey(kind, entry.hash));
                    if (!advertised?.has(entry.hash) || text === undefined) {
                        throw miss(`The boot answer left out an item of ${kind} ${id} this boot did not claim`);
                    }
                    return JSON.parse(text);
                });
                manifest.push({ kind, id, revision, hashes });
                return { id, revision, data };
            }
            if (!Object.hasOwn(record, "data")) {
                throw new BootCacheMiss("format", `${kind} ${id} has no data`);
            }
            if (cachedKind && !holdsCredential(kind, record.data)) {
                manifest.push({ kind, id, revision, text: JSON.stringify(record.data) });
            }
            return { id, revision, data: record.data };
        });
    }
    const snapshot: ResourceReadKindsResult = { epoch, kinds: resultKinds, chatSummaries, chatOrders };
    // Item texts of items that ended up only in a record that is not cached are dropped by the
    // write's GC; keep only the ones a manifest record names.
    const named = new Set<string>();
    for (const record of manifest) {
        for (const hash of record.hashes ?? []) {
            named.add(itemKey(record.kind, hash));
        }
    }
    for (const key of items.keys()) {
        if (!named.has(key)) {
            items.delete(key);
        }
    }
    return { snapshot, manifest, items };
}

/** The write that records `expanded` over `contents` (only changed records rewritten). */
export function bootCacheWrite(
    contents: BootCacheContents,
    expanded: Pick<ExpandedBoot, "manifest" | "items">,
    appVer: string,
): BootCacheWrite {
    const current = isCurrentMeta(contents.meta, appVer);
    const loaded = new Map(contents.records.map((record) => [recordKey(record.kind, record.id), record]));
    const changed = expanded.manifest.filter((record) => {
        const before = current ? loaded.get(recordKey(record.kind, record.id)) : undefined;
        return !before || !sameRecord(before, record);
    });
    return {
        expectGeneration: contents.meta?.generation ?? null,
        meta: { format: BOOT_CACHE_FORMAT, appVer, generation: newId() },
        clear: !current,
        records: expanded.manifest,
        changed,
        items: expanded.items,
    };
}

function sameRecord(a: CachedRecord, b: CachedRecord): boolean {
    if (a.revision !== b.revision) {
        return false;
    }
    if (a.text !== undefined || b.text !== undefined) {
        return a.text === b.text;
    }
    return a.hashes.length === b.hashes.length && a.hashes.every((hash, index) => hash === b.hashes[index]);
}

// --- IndexedDB store ---

const DB_NAME = "risu-boot-cache";
const DB_VERSION = 1;
const RECORDS = "records";
const ITEMS = "items";
const META = "meta";
const META_KEY = "meta";
/** How long opening the database or a cache read may take before the boot goes on without it. */
export const BOOT_CACHE_TIMEOUT_MS = 3000;

export class BootCacheUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BootCacheUnavailableError";
    }
}

export class BootCacheTimeoutError extends Error {
    constructor() {
        super("The boot cache did not answer in time");
        this.name = "BootCacheTimeoutError";
    }
}

/**
 * Opens the database, creating the stores on first use. A blocked open (another tab holds an older
 * version) or one slower than the timeout fails; a connection that arrives after that is closed. An
 * open connection closes itself when another tab upgrades the database.
 */
function openDatabase(timeoutMs: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            reject(new BootCacheUnavailableError("IndexedDB is not available"));
            return;
        }
        let settled = false;
        const fail = (error: unknown) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        };
        const timer = setTimeout(() => fail(new BootCacheTimeoutError()), timeoutMs);
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (error) {
            fail(error);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            for (const name of [RECORDS, ITEMS, META]) {
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name);
                }
            }
        };
        request.onblocked = () => fail(new BootCacheUnavailableError("The boot cache is blocked by another tab"));
        request.onerror = () => fail(request.error ?? new BootCacheUnavailableError("The boot cache did not open"));
        request.onsuccess = () => {
            const db = request.result;
            if (settled) {
                db.close();
                return;
            }
            settled = true;
            clearTimeout(timer);
            db.onversionchange = () => db.close();
            resolve(db);
        };
    });
}

const requestValue = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

/** Settles when the transaction completes (not when its requests succeed), rejecting on abort or error. */
const transactionDone = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("The boot cache transaction was aborted"));
        tx.onerror = () => reject(tx.error ?? new Error("The boot cache transaction failed"));
    });

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            onTimeout();
            reject(new BootCacheTimeoutError());
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/** The cache in IndexedDB (`risu-boot-cache`: `records`, `items`, `meta`). Each call opens and closes its own connection. */
export function indexedDbBootCacheStore(appVer: string, timeoutMs = BOOT_CACHE_TIMEOUT_MS): BootCacheStore {
    async function withDatabase<T>(body: (db: IDBDatabase) => Promise<T>): Promise<T> {
        const db = await openDatabase(timeoutMs);
        try {
            return await body(db);
        } finally {
            db.close();
        }
    }

    return {
        load: () =>
            withDatabase(async (db) => {
                const tx = db.transaction([RECORDS, ITEMS, META], "readonly");
                const done = transactionDone(tx);
                const read = (async () => {
                    const meta = checkCacheMeta(await requestValue(tx.objectStore(META).get(META_KEY)));
                    if (!isCurrentMeta(meta, appVer)) {
                        return { meta, records: [], items: new Map<string, string>() };
                    }
                    const raw = await requestValue(tx.objectStore(RECORDS).getAll());
                    const records = raw.map(checkCachedRecord).filter((record) => record !== null);
                    const itemStore = tx.objectStore(ITEMS);
                    const keys = new Set<string>();
                    for (const record of records) {
                        for (const hash of record.hashes ?? []) {
                            keys.add(itemKey(record.kind, hash));
                        }
                    }
                    const items = new Map<string, string>();
                    await Promise.all(
                        [...keys].map(async (key) => {
                            const text = await requestValue(itemStore.get(key));
                            if (typeof text === "string") {
                                items.set(key, text);
                            }
                        }),
                    );
                    return { meta, records, items };
                })();
                const contents = await withTimeout(Promise.all([read, done]), timeoutMs, () => {
                    try {
                        tx.abort();
                    } catch {}
                });
                return contents[0];
            }),

        write: (write) =>
            withDatabase(async (db) => {
                const tx = db.transaction([RECORDS, ITEMS, META], "readwrite");
                const done = transactionDone(tx);
                const fence = { skipped: false };
                const metaStore = tx.objectStore(META);
                const recordStore = tx.objectStore(RECORDS);
                const itemStore = tx.objectStore(ITEMS);
                const apply = (async () => {
                    const stored = checkCacheMeta(await requestValue(metaStore.get(META_KEY)));
                    if ((stored?.generation ?? null) !== write.expectGeneration) {
                        fence.skipped = true;
                        tx.abort();
                        return;
                    }
                    if (write.clear) {
                        recordStore.clear();
                        itemStore.clear();
                    }
                    const keep = new Set(write.records.map((record) => recordKey(record.kind, record.id)));
                    if (!write.clear) {
                        for (const key of await requestValue(recordStore.getAllKeys())) {
                            if (typeof key !== "string" || !keep.has(key)) {
                                recordStore.delete(key);
                            }
                        }
                    }
                    for (const record of write.clear ? write.records : write.changed) {
                        recordStore.put(record, recordKey(record.kind, record.id));
                    }
                    for (const [key, text] of write.items) {
                        itemStore.put(text, key);
                    }
                    const named = new Set<string>();
                    for (const record of write.records) {
                        for (const hash of record.hashes ?? []) {
                            named.add(itemKey(record.kind, hash));
                        }
                    }
                    if (!write.clear) {
                        for (const key of await requestValue(itemStore.getAllKeys())) {
                            if (typeof key !== "string" || !named.has(key)) {
                                itemStore.delete(key);
                            }
                        }
                    }
                    metaStore.put(write.meta, META_KEY);
                })();
                try {
                    await Promise.all([apply, done]);
                } catch (error) {
                    if (fence.skipped) {
                        return "skipped";
                    }
                    throw error;
                }
                return "written";
            }),

        clear: (expectGeneration) =>
            withDatabase(async (db) => {
                const tx = db.transaction([RECORDS, ITEMS, META], "readwrite");
                const done = transactionDone(tx);
                const fence = { skipped: false };
                const apply = (async () => {
                    if (expectGeneration !== undefined) {
                        const stored = checkCacheMeta(await requestValue(tx.objectStore(META).get(META_KEY)));
                        if ((stored?.generation ?? null) !== expectGeneration) {
                            fence.skipped = true;
                            tx.abort();
                            return;
                        }
                    }
                    tx.objectStore(RECORDS).clear();
                    tx.objectStore(ITEMS).clear();
                    tx.objectStore(META).put({ format: BOOT_CACHE_FORMAT, appVer, generation: newId() }, META_KEY);
                })();
                try {
                    await Promise.all([apply, done]);
                } catch (error) {
                    if (fence.skipped) {
                        return "skipped";
                    }
                    throw error;
                }
                return "cleared";
            }),
    };
}

// --- The boot ---

export type BootCacheDeps = {
    store: BootCacheStore;
    appVer: string;
    readBoot: (request: ResourceBootRequest) => Promise<unknown>;
    readKinds: () => Promise<ResourceReadKindsResult>;
    report: (event: DiagnosticEventInput) => void;
};

type BootCacheReason = (typeof BOOT_CACHE_REASONS)[number];

export type BootSnapshot = {
    snapshot: ResourceReadKindsResult;
    /** Writes the cache once or awaits an already-started clear; never throws. Later calls share the promise. */
    commit: () => Promise<void>;
};

const mark = (name: string) => {
    try {
        performance.mark(name);
    } catch {}
};

function failureReason(error: unknown): "unavailable" | "timeout" | "readFailed" {
    if (error instanceof BootCacheUnavailableError) {
        return "unavailable";
    }
    return error instanceof BootCacheTimeoutError ? "timeout" : "readFailed";
}

function writeFailureReason(error: unknown): "quota" | "write" {
    return error instanceof DOMException && error.name === "QuotaExceededError" ? "quota" : "write";
}

function once(run: () => Promise<void>): () => Promise<void> {
    let promise: Promise<void> | null = null;
    return () => (promise ??= run());
}

/**
 * The boot read through the cache. Reads the cache, sends the boot request with its claims, and
 * expands the answer; a cache that cannot be read, a failed boot request, or an unusable answer
 * falls back to one plain read (`readKinds`), whose failure propagates. Content-free performance
 * marks: `risu-boot-cache:read-start`, `:read`, `:answer`, `:write-start`, `:written`.
 */
export async function loadBootSnapshot(deps: BootCacheDeps): Promise<BootSnapshot> {
    const fallback = async (
        reason: BootCacheReason,
        claims: { records: number; items: number },
        clearGeneration?: string | null,
    ): Promise<BootSnapshot> => {
        deps.report({ kind: "bootCache", phase: "fallback", reason, ...claims });
        // Start invalidation before the plain read: bootstrap may fail or reload before commit.
        const clearing = (async () => {
            if (clearGeneration !== undefined) {
                try {
                    if ((await deps.store.clear(clearGeneration)) === "cleared") {
                        deps.report({ kind: "bootCache", phase: "cleared", reason });
                    }
                } catch (error) {
                    console.warn("[Boot cache]", error);
                }
            }
        })();
        const snapshot = await deps.readKinds();
        return { snapshot, commit: () => clearing };
    };

    let contents: BootCacheContents;
    mark("risu-boot-cache:read-start");
    try {
        contents = await deps.store.load();
    } catch (error) {
        console.warn("[Boot cache]", error);
        return fallback(failureReason(error), { records: 0, items: 0 });
    }
    mark("risu-boot-cache:read");
    const context = prepareBootRequest(contents);
    const claims = {
        records: context.claims.size,
        items: [...context.hashes.values()].reduce((sum, set) => sum + set.size, 0),
    };
    let answer: unknown;
    try {
        answer = await deps.readBoot(context.request);
    } catch (error) {
        console.warn("[Boot cache]", error);
        return fallback("request", claims);
    }
    mark("risu-boot-cache:answer");
    let expanded: ExpandedBoot;
    try {
        expanded = expandBootAnswer(answer, context);
    } catch (error) {
        console.warn("[Boot cache]", error);
        const reason = error instanceof BootCacheMiss ? error.reason : "incomplete";
        return fallback(reason, claims, contents.meta?.generation ?? null);
    }
    let write: BootCacheWrite | null = bootCacheWrite(contents, expanded, deps.appVer);
    return {
        snapshot: expanded.snapshot,
        commit: once(async () => {
            const pending = write;
            // The texts are held only until the write settles.
            write = null;
            if (!pending) {
                return;
            }
            try {
                mark("risu-boot-cache:write-start");
                if ((await deps.store.write(pending)) === "written") {
                    mark("risu-boot-cache:written");
                }
            } catch (error) {
                console.warn("[Boot cache]", error);
                const reason = writeFailureReason(error);
                deps.report({ kind: "bootCache", phase: "writeFailed", reason });
                try {
                    await deps.store.clear(pending.expectGeneration);
                } catch {}
            }
        }),
    };
}

/** Clears the cache unconditionally (for a future sign-out); never throws. */
export async function clearBootCache(store: BootCacheStore): Promise<void> {
    try {
        await store.clear();
    } catch (error) {
        console.warn("[Boot cache]", error);
    }
}

let settled: Promise<void> = Promise.resolve();

/** Settles once the boot's cache write (scheduled by `scheduleBootCacheCommit`) is done; for measurements. */
export function whenBootCacheSettled(): Promise<void> {
    return settled;
}

/**
 * Runs `commit` off the boot's critical path: when the tab is idle, at most `timeoutMs` later
 * (`requestIdleCallback` where it exists, a timer otherwise).
 */
export function scheduleBootCacheCommit(commit: () => Promise<void>, timeoutMs = 5000): Promise<void> {
    settled = new Promise<void>((resolve) => {
        const run = () =>
            void Promise.resolve()
                .then(commit)
                .catch((error) => console.warn("[Boot cache]", error))
                .finally(resolve);
        if (typeof requestIdleCallback === "function") {
            requestIdleCallback(run, { timeout: timeoutMs });
        } else {
            setTimeout(run, 0);
        }
    });
    return settled;
}
