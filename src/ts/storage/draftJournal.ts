import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat } from "../../../shared/database.ts";
import type { DiagnosticEventInput, SYNC_REASONS } from "../../../shared/diagnostics.ts";
import { newId } from "../../../shared/ids.ts";
import { recordClientEvent } from "../diagnostics/collector";
import { isJournalEligible } from "./journalEligibility";

/**
 * The draft journal: an IndexedDB copy of what this tab changed and the server has not acknowledged,
 * so the change survives the loss of the page (a killed PWA, a crash, a reload during an outage), and
 * the local version kept at a conflict (a recovery draft). This module is the store alone: keys,
 * layers, versions, budgets, expiry, and the tab ownership protocol. The composer uses the page's
 * shared journal; its browser-wide rows keep text, translation, attachments, and a send's retry id.
 * Composer writes keep `createdAt` while the row is live; a write after expiry starts a new entry.
 * Send success deletes only a row still carrying that send's id.
 *
 * - Database `risu-draft-journal`, stores `entries` (string keys, below) and `meta` (reserved), one
 *   connection per page kept open. A database missing a store or an index is upgraded to the next
 *   version with only the missing parts created; existing rows are kept. A row this version cannot read
 *   (another `format`, or a shape that fails `checkJournalRow`) is kept, never overwritten, moved, or
 *   evicted (it may be the only copy), and reported (`sync` `journalSkipped` `format`).
 * - Keys: a mutation entry `<epoch>\0<tabId>\0<scope>\0<target>` (scope `record`, `chat`, `order`); a
 *   recovery draft `draft\0<id>`; a composer draft `composer\0<chatKey>` (browser-wide). A record target
 *   is `<kind>\0<id>`, both non-empty; malformed record targets are not written or transferred.
 * - Layers: an entry holds what the adapter holds at once (`RecordLayerValues`, `ChatLayerValues`,
 *   `OrderLayerValues`), each layer stamped with the per-tab `version` it was last written at
 *   (`nextVersion`). Each record layer carries its own `op` (`create`, `update`, `delete`), so sent and
 *   newer local intent can differ. A write of a layer lands only when it is newer than the stored layer
 *   and than every removal through a later version (in-memory fences: a late write never resurrects an
 *   acknowledged layer); a removal deletes a layer only through the version it captured, so a late
 *   delete never erases newer work. Versions only order the work of one page: a new page starts above
 *   its stored rows, and a page that is gone sends nothing late.
 *   `write(items, removals)` applies captured-version removals and writes in one transaction, with
 *   the same fences and budgets as separate calls; a replaced entry keeps its creation time.
 *   Startup and adopted chat/order keys are reserved until recovery installs them and calls
 *   `release`. A committed whole move to drafts or expiry also frees the reservation; a partial
 *   move atomically drafts only its named layers and leaves the remaining row reserved.
 * - Eligibility: every record text goes through `isJournalEligible`. An ineligible layer is not
 *   written and its older value is removed (the journal never holds an older text than the one the tab
 *   would send); a kind that is never journaled loses its whole entry.
 * - Budgets (16 MiB per entry, 64 MiB total; UTF-8 bytes, `journalValueSize`): an entry over
 *   `MAX_JOURNAL_ENTRY_BYTES`, or a write that would take the store over `MAX_JOURNAL_TOTAL_BYTES` after
 *   eviction, is not written (`journalSkipped` `tooLarge` or `budget`; the layers it named are
 *   removed). Eviction for space removes recovery drafts and expired composer drafts, oldest first;
 *   never a mutation entry (its owner is alive or its rows wait for adoption) and never an unreadable
 *   row. `putDraft` reclaims only expired drafts and composer drafts. A row without a finite,
 *   nonnegative `size` is not counted.
 * - Expiry: `JOURNAL_ENTRY_TTL_MS` after `createdAt`, which every change, adoption, and conversion to a
 *   draft keeps. Reads for recovery leave expired rows out; `purgeExpired` deletes them and fences
 *   owned mutation keys through the version counter captured at the call.
 * - Ownership (Web Locks): a tab's id lives in `sessionStorage` (`risu-journal-tab`) and the tab holds
 *   `risu-journal-owner:<tabId>` for the page's life (`start`). A refused lock (a duplicated tab copied
 *   the id) mints a new id. Rows of a tab whose owner lock can be taken under `risu-journal-recover`
 *   are a closed tab's: `adoptOrphans` re-keys them to this tab in one transaction while holding that
 *   lock. No IndexedDB, no Web Locks, or no usable `sessionStorage`: the journal is off and every call
 *   answers as if empty. Startup's seed read and orphan transactions use the open deadline; expiry
 *   aborts the transaction and reports `journalFailed` `timeout`. A failed start releases ownership.
 *   Closing drains calls within the same bound, aborts remaining transactions, closes the connection,
 *   and releases ownership.
 *
 * Inside a transaction only IndexedDB requests are awaited, so it never commits early. Every method
 * resolves (never rejects); failures are reported as `sync` events (`journalFailed`), and events about
 * what a transaction did are reported once it committed.
 */

export const JOURNAL_DB_NAME = "risu-draft-journal";
/** The rows' layout; a row of another format is kept untouched. */
export const JOURNAL_FORMAT = 1;
export const JOURNAL_ENTRY_TTL_MS = 48 * 60 * 60 * 1000;
export const MAX_JOURNAL_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_JOURNAL_TOTAL_BYTES = 64 * 1024 * 1024;
/** The deadline for an open, a startup or recovery transaction, and draining calls at close. */
export const JOURNAL_OPEN_TIMEOUT_MS = 3000;
/** How long `adoptOrphans` waits for the recover lock another tab holds. */
export const JOURNAL_RECOVER_TIMEOUT_MS = 5000;
export const JOURNAL_TAB_KEY = "risu-journal-tab";
export const JOURNAL_OWNER_LOCK_PREFIX = "risu-journal-owner:";
export const JOURNAL_RECOVER_LOCK = "risu-journal-recover";
/** Owner ids tried before the journal gives up (each refusal mints a new one). */
const MAX_CLAIM_ATTEMPTS = 3;

const ENTRIES = "entries";
const META = "meta";
const INDEXES = { tabId: "tabId", size: "size", format: "format" } as const;
const DRAFT_PREFIX = "draft\u0000";
const COMPOSER_PREFIX = "composer\u0000";

// --- Payloads ---

export type JournalScope = "record" | "chat" | "order";
export type RecordOp = "create" | "update" | "delete";

/** A record's layers: the write in flight, the newest local text, and the text the server refused. */
export type RecordLayerValues = {
    sent: { op: RecordOp; baseRevision: string | null; text: string | null; dispatched: true; inDoubt: boolean };
    latest: { op: RecordOp; baseRevision: string | null; text: string | null };
    refused: { op: RecordOp; text: string | null; reason: string };
};

/**
 * A local by-id edit's target before the mirror changed. Appends use `absent` for all appended ids;
 * setText holds data, setMessage and a single-id remove the whole message, setTranslation its
 * translation (or `absent`). patchMessage/meta hold only touched fields that existed, including
 * whole prior maps for merge/mergeUnset; omitted touched fields were absent. Coalescing preserves
 * the first before for each touched field. An unloaded summary can omit a raw value (pinned:false),
 * so its before may conservatively fail a later recovery comparison.
 */
export type JournalBefore = { absent: true } | { value: unknown };

/**
 * A pending op with its local before; never sent as this envelope. Whole-chat ops and multi-id
 * removes carry none. Generation ops have no local producer and no invented before value.
 */
export type JournalChatOp = { op: ChatOp; before?: JournalBefore };

/** A chat's layers: the earlier group to resend, the queued batch (with its pre-minted id), and refused intent. */
export type ChatLayerValues = {
    resend: { ops: ChatOp[]; baseRevision: string | null; groupId: string; seq: number; inDoubt: boolean };
    pending: {
        ops: JournalChatOp[];
        baseRevision: string | null;
        groupId: string;
        createSnapshot?: Chat;
        delete?: boolean;
    };
    refused: { ops: ChatOp[]; create: boolean; delete: boolean; reason: string };
};

/** A character's chat order: the vector in flight, the newest local one, and the refused one. */
export type OrderLayerValues = {
    sent: { baseRevision: string | null; ids: string[] };
    latest: { baseRevision: string | null; ids: string[] };
    refused: { ids: string[]; reason: string };
};

export type LayerValuesOf = { record: RecordLayerValues; chat: ChatLayerValues; order: OrderLayerValues };

export const JOURNAL_LAYER_NAMES = {
    record: ["sent", "latest", "refused"],
    chat: ["resend", "pending", "refused"],
    order: ["sent", "latest", "refused"],
} as const satisfies { [S in JournalScope]: readonly (keyof LayerValuesOf[S])[] };

export type StoredLayer<T> = { version: number; value: T };
export type StoredLayers<S extends JournalScope> = {
    [L in keyof LayerValuesOf[S]]?: StoredLayer<LayerValuesOf[S][L]>;
};

/** The layers a write names: a value replaces the layer, `null` removes it; an omitted layer is kept. */
export type LayerWrites<S extends JournalScope> = { [L in keyof LayerValuesOf[S]]?: LayerValuesOf[S][L] | null };

type ScopedLayers =
    | { scope: "record"; layers: StoredLayers<"record"> }
    | { scope: "chat"; layers: StoredLayers<"chat"> }
    | { scope: "order"; layers: StoredLayers<"order"> };

type RowBase = { format: typeof JOURNAL_FORMAT; createdAt: number; size: number };

/** A mutation entry: this tab's unacknowledged work on one target, under the epoch it was made in. */
export type MutationEntry = RowBase & {
    type: "mutation";
    epoch: string;
    tabId: string;
    target: string;
    /** The newest version any of its layers was written at. */
    version: number;
    updatedAt: number;
} & ScopedLayers;

/** A recovery draft: work that is not replayed on its own, kept for the user (the entry's layers as they were). */
export type DraftEntry = RowBase & { type: "draft"; id: string; epoch: string; target: string } & ScopedLayers;

/** What a chat's composer held (the send hand-off adds `sending` and the message id). */
export type ComposerValue = {
    input: string;
    translate: string;
    files: string[];
    state?: "sending";
    userMessageId?: string;
};

/** A composer draft of one chat, shared by the browser's tabs. */
export type ComposerEntry = RowBase & { type: "composer"; chatKey: string; updatedAt: number; value: ComposerValue };

export type JournalRow = MutationEntry | DraftEntry | ComposerEntry;

// --- Keys ---

const NUL = "\u0000";

export function mutationKey(epoch: string, tabId: string, scope: JournalScope, target: string): string {
    return [epoch, tabId, scope, target].join(NUL);
}
export const draftKey = (id: string) => `${DRAFT_PREFIX}${id}`;
export const composerKey = (chatKey: string) => `${COMPOSER_PREFIX}${chatKey}`;
/** Resource ids hold no control character, so these targets cannot collide. */
export const recordTarget = (kind: string, id: string) => `${kind}${NUL}${id}`;
export const chatTarget = (chaId: string, chatId: string) => `${chaId}${NUL}${chatId}`;
export const orderTarget = (chaId: string) => chaId;
export const ownerLockName = (tabId: string) => `${JOURNAL_OWNER_LOCK_PREFIX}${tabId}`;

export const isExpired = (createdAt: number, now: number) => now - createdAt >= JOURNAL_ENTRY_TTL_MS;

/** The UTF-8 length of `text`, without encoding it. */
function utf8Length(text: string): number {
    let length = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            length += 1;
        } else if (code < 0x800) {
            length += 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                length += 4;
                i++;
            } else {
                length += 3;
            }
        } else {
            length += 3;
        }
    }
    return length;
}

/** What a value costs in the journal's budgets: the UTF-8 bytes of its strings and keys, 8 per other value. */
export function journalValueSize(value: unknown): number {
    if (typeof value === "string") {
        return utf8Length(value);
    }
    if (Array.isArray(value)) {
        return value.reduce((sum: number, item) => sum + journalValueSize(item), 8);
    }
    if (typeof value === "object" && value !== null) {
        let size = 8;
        for (const [key, item] of Object.entries(value)) {
            size += utf8Length(key) + journalValueSize(item);
        }
        return size;
    }
    return 8;
}

// --- Row checks ---

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isString = (value: unknown): value is string => typeof value === "string";
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isSize = (value: unknown): value is number => isTime(value) && value >= 0;
const RECORD_OPS: readonly unknown[] = ["create", "update", "delete"];
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

/** A layer's value as far as the store relies on it: an object, a record layer's op and string or null text. */
function checkLayerValue(scope: JournalScope, value: unknown): boolean {
    return isPlainObject(value) && (scope !== "record" || (RECORD_OPS.includes(value.op) && isTextOrNull(value.text)));
}

function checkLayers(scope: unknown, layers: unknown): boolean {
    if ((scope !== "record" && scope !== "chat" && scope !== "order") || !isPlainObject(layers)) {
        return false;
    }
    const names: readonly string[] = JOURNAL_LAYER_NAMES[scope];
    return Object.entries(layers).every(
        ([name, layer]) =>
            names.includes(name) &&
            isPlainObject(layer) &&
            isVersion(layer.version) &&
            checkLayerValue(scope, layer.value),
    );
}

/** A stored row this version can read, or null (an unknown row: kept as it is). */
export function checkJournalRow(value: unknown): JournalRow | null {
    if (!isPlainObject(value) || value.format !== JOURNAL_FORMAT || !isTime(value.createdAt) || !isSize(value.size)) {
        return null;
    }
    switch (value.type) {
        case "mutation":
            return isString(value.epoch) &&
                isString(value.tabId) &&
                isString(value.target) &&
                isVersion(value.version) &&
                isTime(value.updatedAt) &&
                checkLayers(value.scope, value.layers) &&
                (value.scope !== "record" || recordKind(value.target) !== null)
                ? (value as JournalRow)
                : null;
        case "draft":
            return isString(value.id) &&
                isString(value.epoch) &&
                isString(value.target) &&
                checkLayers(value.scope, value.layers) &&
                (value.scope !== "record" || recordKind(value.target) !== null)
                ? (value as JournalRow)
                : null;
        case "composer":
            return isString(value.chatKey) && isTime(value.updatedAt) && checkComposerValue(value.value)
                ? (value as JournalRow)
                : null;
        default:
            return null;
    }
}

function checkComposerValue(value: unknown): value is ComposerValue {
    return (
        isPlainObject(value) &&
        isString(value.input) &&
        isString(value.translate) &&
        Array.isArray(value.files) &&
        Array.from(value.files).every(isString) &&
        (value.state === undefined || value.state === "sending") &&
        (value.userMessageId === undefined || isString(value.userMessageId)) &&
        (value.state !== "sending" || isString(value.userMessageId))
    );
}

/** Whether every record text of `layers` may be journaled (chat and order layers always may). */
function layersEligible(entry: ScopedLayers & { target: string }): boolean {
    if (entry.scope !== "record") {
        return true;
    }
    const kind = recordKind(entry.target);
    return (
        kind !== null &&
        Object.values(entry.layers).every(
            (layer) => !layer || isJournalEligible({ scope: "record", kind, text: layer.value.text }),
        )
    );
}

/** A record target has exactly one separator, with a non-empty kind and id. */
function recordKind(target: string): string | null {
    const separator = target.indexOf(NUL);
    return separator > 0 && separator < target.length - 1 && target.indexOf(NUL, separator + 1) === -1
        ? target.slice(0, separator)
        : null;
}

function sizeOf(row: Omit<JournalRow, "size">): number {
    return journalValueSize({ ...row, size: 0 });
}

// --- The API ---

export type JournalLocks = Pick<LockManager, "request">;

export type DraftJournalDeps = {
    /** The IndexedDB factory; null or missing: the journal is off. */
    indexedDB?: IDBFactory | null;
    /** Web Locks; null or missing: the journal is off. */
    locks?: JournalLocks | null;
    /** This tab's `sessionStorage`; a throwing getter, null, or a throwing access: the journal is off. */
    storage?: () => Storage | null;
    now?: () => number;
    newId?: () => string;
    report?: (event: DiagnosticEventInput) => void;
    openTimeoutMs?: number;
    recoverTimeoutMs?: number;
};

export type JournalWrite =
    | { epoch: string; scope: "record"; target: string; version: number; layers: LayerWrites<"record"> }
    | { epoch: string; scope: "chat"; target: string; version: number; layers: LayerWrites<"chat"> }
    | { epoch: string; scope: "order"; target: string; version: number; layers: LayerWrites<"order"> };

/**
 * What became of one write: `written` (some named layer changed), `stale` (newer work or a later removal
 * covers every named layer), `ineligible` (a record text the journal may not hold: its layer was
 * removed), `skipped` (over a budget, or the key holds an unknown or reserved row), `failed` (the transaction or the
 * database failed), `off` (no journal).
 */
export type WriteOutcome = "written" | "stale" | "ineligible" | "skipped" | "failed" | "off";

/** Removes `layers` (all when omitted) of one entry through `version`: a layer written later stays. */
export type JournalRemoval = { epoch: string; scope: JournalScope; target: string; version: number; layers?: string[] };

/** A mutation entry with its key, as recovery reads it. */
export type KeyedEntry<T extends JournalRow> = T & { key: string };

export type DraftInput = { epoch: string; target: string; createdAt?: number } & (
    | { scope: "record"; layers: LayerWrites<"record"> }
    | { scope: "chat"; layers: LayerWrites<"chat"> }
    | { scope: "order"; layers: LayerWrites<"order"> }
);

/** Moves the named layers (all when omitted) to a draft unless one was written after `version`. */
export type DraftMove = JournalRemoval;

export type JournalRelease = { epoch: string; scope: "chat" | "order"; target: string };

export type ComposerRemoval = { userMessageId?: string; keepSendingIds?: readonly string[] };

export interface DraftJournal {
    /** Claims this tab's id and owner lock and opens the database; false: the journal stays off. Single-flight. */
    start(): Promise<boolean>;
    readonly enabled: boolean;
    /** This tab's journal id, once `start` succeeded. */
    readonly tabId: string | null;
    /** The next per-tab version; a caller captures it with what it writes. */
    nextVersion(): number;
    /** Applies captured-version removals and writes in one transaction; values are copied at the call. */
    write(items: JournalWrite[], removals?: JournalRemoval[]): Promise<WriteOutcome[]>;
    /** Applies the removals in one transaction. */
    remove(items: JournalRemoval[]): Promise<void>;
    /** This tab's mutation entries that have not expired. */
    readOwn(): Promise<KeyedEntry<MutationEntry>[]>;
    /** Re-keys the rows of closed tabs to this tab; answers how many rows it took (adopted or made drafts). */
    adoptOrphans(): Promise<number>;
    /** Converts entries to drafts, each in the same transaction as its removal; answers each draft's id or null. */
    moveToDrafts(items: DraftMove[]): Promise<(string | null)[]>;
    /** Reads layers and frees keys after commit; expired rows are fenced/deleted. Empty answer on failure or off. */
    release(items: JournalRelease[]): Promise<(StoredLayers<"chat"> | StoredLayers<"order"> | null)[]>;
    /** Stores a draft (reclaiming only expired drafts and composer rows); its id, or null when not stored. */
    putDraft(input: DraftInput): Promise<string | null>;
    listDrafts(): Promise<DraftEntry[]>;
    removeDraft(id: string): Promise<void>;
    /** Composer calls start the journal on first use. Reads omit expired and unreadable rows. */
    readComposer(chatKey: string): Promise<ComposerValue | null>;
    putComposer(chatKey: string, value: ComposerValue): Promise<WriteOutcome>;
    /** Conditions are checked against the stored row inside the deletion's transaction. */
    removeComposer(chatKey: string, condition?: ComposerRemoval): Promise<void>;
    removeComposersOf(chaId: string): Promise<void>;
    /** Deletes this tab's expired entries and every expired draft and composer draft; answers how many. */
    purgeExpired(): Promise<number>;
    /**
     * Ends the journal for this page: drains calls within the open deadline, aborts remaining
     * transactions, closes the connection, and releases the owner lock. Later calls answer as if off.
     */
    close(): Promise<void>;
}

type SyncReason = (typeof SYNC_REASONS)[number];

class JournalFailure extends Error {
    readonly reason: SyncReason;
    constructor(reason: SyncReason, message: string) {
        super(message);
        this.name = "JournalFailure";
        this.reason = reason;
    }
}

const failureReason = (error: unknown, fallback: SyncReason): SyncReason => {
    if (error instanceof JournalFailure) {
        return error.reason;
    }
    return error instanceof DOMException && error.name === "QuotaExceededError" ? "quota" : fallback;
};

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Runs `step` for each cursor position (no other await may happen in between), resolving at the end. */
function eachCursor<C extends IDBCursor>(request: IDBRequest<C | null>, step: (cursor: C) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve();
                return;
            }
            try {
                step(cursor);
                cursor.continue();
            } catch (error) {
                reject(error);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

/** Runs `body` in one transaction over `entries`; resolves with its result once the transaction committed. */
async function inTransaction<T>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => Promise<T>,
    transactions: Map<IDBTransaction, () => void>,
    timeoutMs?: number,
): Promise<T> {
    const tx = db.transaction([ENTRIES], mode);
    let expire!: () => void;
    const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new JournalFailure("write", "The journal transaction was aborted"));
        tx.onerror = () => reject(tx.error ?? new JournalFailure("write", "The journal transaction failed"));
        expire = () => {
            reject(new JournalFailure("timeout", "The journal transaction did not finish in time"));
            try {
                tx.abort();
            } catch {}
        };
    });
    transactions.set(tx, expire);
    const timer = timeoutMs === undefined ? undefined : setTimeout(expire, timeoutMs);
    try {
        const work = body(tx.objectStore(ENTRIES)).catch((error: unknown) => {
            try {
                tx.abort();
            } catch {}
            throw error;
        });
        const [result] = await Promise.all([work, done]);
        return result;
    } finally {
        clearTimeout(timer);
        transactions.delete(tx);
    }
}

function schemaComplete(db: IDBDatabase): boolean {
    if (!db.objectStoreNames.contains(ENTRIES) || !db.objectStoreNames.contains(META)) {
        return false;
    }
    const tx = db.transaction([ENTRIES], "readonly");
    const indexNames = tx.objectStore(ENTRIES).indexNames;
    const complete = Object.values(INDEXES).every((name) => indexNames.contains(name));
    // No data was requested; do not leave this transaction queued behind another connection.
    tx.abort();
    return complete;
}

/** Creates whatever of the schema is missing; never deletes or recreates a store. */
function createMissing(db: IDBDatabase, tx: IDBTransaction): void {
    if (!db.objectStoreNames.contains(ENTRIES)) {
        db.createObjectStore(ENTRIES);
    }
    if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
    }
    const entries = tx.objectStore(ENTRIES);
    for (const [name, keyPath] of Object.entries(INDEXES)) {
        if (!entries.indexNames.contains(name)) {
            entries.createIndex(name, keyPath);
        }
    }
}

function openOnce(factory: IDBFactory, version: number | undefined, onBlocked: () => void): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let request: IDBOpenDBRequest;
        try {
            request = version === undefined ? factory.open(JOURNAL_DB_NAME) : factory.open(JOURNAL_DB_NAME, version);
        } catch (error) {
            reject(error);
            return;
        }
        request.onupgradeneeded = () => {
            if (request.transaction) {
                createMissing(request.result, request.transaction);
            }
        };
        request.onblocked = onBlocked;
        request.onerror = () => reject(request.error ?? new JournalFailure("unavailable", "The journal did not open"));
        request.onsuccess = () => resolve(request.result);
    });
}

/**
 * Opens the journal at its current version, and when a store or an index is missing, at the next one
 * with the missing parts created. Another tab's upgrade in between (`VersionError`) starts over.
 */
async function openJournalDatabase(factory: IDBFactory, onBlocked: () => void): Promise<IDBDatabase> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const db = await openOnce(factory, undefined, onBlocked);
        if (schemaComplete(db)) {
            return db;
        }
        const next = db.version + 1;
        db.close();
        let upgraded: IDBDatabase;
        try {
            upgraded = await openOnce(factory, next, onBlocked);
        } catch (error) {
            if (error instanceof DOMException && error.name === "VersionError") {
                continue;
            }
            throw error;
        }
        if (schemaComplete(upgraded)) {
            return upgraded;
        }
        upgraded.close();
    }
    throw new JournalFailure("unavailable", "The journal's stores could not be created");
}

function defaultStorage(): Storage | null {
    return globalThis.sessionStorage ?? null;
}

/** A draft journal for this page (`deps` default to the page's IndexedDB, Web Locks, and `sessionStorage`). */
export function createDraftJournal(deps: DraftJournalDeps = {}): DraftJournal {
    const factory = deps.indexedDB === undefined ? (globalThis.indexedDB ?? null) : deps.indexedDB;
    const locks = deps.locks === undefined ? (globalThis.navigator?.locks ?? null) : deps.locks;
    const storage = deps.storage ?? defaultStorage;
    const now = deps.now ?? Date.now;
    const mintId = deps.newId ?? newId;
    const openTimeoutMs = deps.openTimeoutMs ?? JOURNAL_OPEN_TIMEOUT_MS;
    const recoverTimeoutMs = deps.recoverTimeoutMs ?? JOURNAL_RECOVER_TIMEOUT_MS;
    const reportTo = deps.report ?? recordClientEvent;

    let enabled = false;
    let closed = false;
    let tabId: string | null = null;
    let counter = 0;
    let db: IDBDatabase | null = null;
    let opening: Promise<IDBDatabase> | null = null;
    let blocked = false;
    let started: Promise<boolean> | null = null;
    let closing: Promise<void> | null = null;
    let releaseOwner: (() => void) | null = null;
    let ownerHeld: Promise<unknown> | null = null;
    const recoverAborts = new Set<AbortController>();
    const inFlight = new Set<Promise<unknown>>();
    const transactions = new Map<IDBTransaction, () => void>();
    /** Removal fences: `key` (every layer) or `key\0layer` → the version removed through. */
    const fences = new Map<string, number>();
    /** Chat/order rows held before this page's writes still belong to recovery. */
    const reserved = new Set<string>();

    const report = (event: DiagnosticEventInput) => {
        try {
            reportTo(event);
        } catch {}
    };
    const reportFailure = (error: unknown, fallback: SyncReason) => {
        console.warn("[Draft journal]", error);
        report({ kind: "sync", phase: "journalFailed", reason: failureReason(error, fallback) });
    };

    function raiseFence(name: string, version: number) {
        if ((fences.get(name) ?? -Infinity) < version) {
            fences.set(name, version);
        }
    }
    const fenceOf = (key: string, layer: string) =>
        Math.max(fences.get(key) ?? -Infinity, fences.get(`${key}${NUL}${layer}`) ?? -Infinity);

    /** The open connection, opening it once at a time; a caller waits at most `openTimeoutMs`. */
    function connection(): Promise<IDBDatabase> {
        if (closed || !factory) {
            return Promise.reject(new JournalFailure("unavailable", "The journal is closed"));
        }
        if (db) {
            return Promise.resolve(db);
        }
        if (!opening) {
            blocked = false;
            opening = openJournalDatabase(factory, () => {
                blocked = true;
            }).then(
                (opened) => {
                    opening = null;
                    if (closed) {
                        opened.close();
                        throw new JournalFailure("unavailable", "The journal is closed");
                    }
                    opened.onversionchange = () => {
                        opened.close();
                        if (db === opened) {
                            db = null;
                        }
                    };
                    opened.onclose = () => {
                        if (db === opened) {
                            db = null;
                        }
                    };
                    db = opened;
                    return opened;
                },
                (error: unknown) => {
                    opening = null;
                    throw error;
                },
            );
            // A caller that stopped waiting leaves the open to finish; nobody else may be listening.
            opening.catch(() => {});
        }
        const pending = opening;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new JournalFailure(blocked ? "blocked" : "timeout", "The journal did not open in time")),
                openTimeoutMs,
            );
            pending.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error: unknown) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    /** Runs `body` as a tracked call while the journal is on; `fallback` when it is off. */
    function tracked<T>(fallback: T, body: () => Promise<T>): Promise<T> {
        if (!enabled || closed) {
            return Promise.resolve(fallback);
        }
        const run = body();
        inFlight.add(run);
        void run.finally(() => inFlight.delete(run)).catch(() => {});
        return run;
    }

    /** `body` over the open connection, unless the journal closed while it opened. */
    async function withDatabase<T>(
        mode: IDBTransactionMode,
        body: (store: IDBObjectStore) => Promise<T>,
        timeoutMs?: number,
    ): Promise<T> {
        const opened = await connection();
        if (closed) {
            throw new JournalFailure("unavailable", "The journal is closed");
        }
        return inTransaction(opened, mode, body, transactions, timeoutMs);
    }

    function readTabId(store: Storage): string | null {
        const saved = store.getItem(JOURNAL_TAB_KEY);
        return saved && saved.length > 0 ? saved : null;
    }

    /** Takes `name` if no one holds it, keeping it until the returned release runs; null when refused. */
    function claimOwner(name: string): Promise<{ release: () => void; held: Promise<unknown> } | null> {
        return new Promise((resolve, reject) => {
            let release!: () => void;
            const until = new Promise<void>((done) => {
                release = done;
            });
            let granted = false;
            const held = locks!.request(name, { ifAvailable: true }, (lock) => {
                if (!lock) {
                    resolve(null);
                    return null;
                }
                granted = true;
                resolve({ release, held });
                return until;
            });
            held.catch((error: unknown) => {
                if (!granted) {
                    reject(error);
                }
            });
        });
    }

    async function seed(): Promise<void> {
        const own = tabId!;
        const { highest, unknown } = await withDatabase(
            "readonly",
            async (store) => {
                const total = await requestValue(store.count());
                const current = await requestValue(store.index(INDEXES.format).count(JOURNAL_FORMAT));
                let highest = 0;
                let malformed = 0;
                await eachCursor(store.index(INDEXES.tabId).openCursor(IDBKeyRange.only(own)), (cursor) => {
                    const row = checkJournalRow(cursor.value);
                    if (row?.type === "mutation") {
                        highest = Math.max(highest, row.version);
                        if (row.scope === "chat" || row.scope === "order") {
                            reserved.add(String(cursor.primaryKey));
                        }
                    } else if (isPlainObject(cursor.value) && cursor.value.format === JOURNAL_FORMAT) {
                        malformed++;
                    }
                });
                return { highest, unknown: total - current + malformed };
            },
            openTimeoutMs,
        );
        counter = Math.max(counter, highest);
        if (unknown > 0) {
            report({ kind: "sync", phase: "journalSkipped", reason: "format", entries: unknown });
        }
    }

    async function start(): Promise<boolean> {
        let store: Storage | null;
        try {
            store = storage();
            // Touch it: a storage that throws on access (a blocked one) counts as missing.
            if (store) {
                readTabId(store);
            }
        } catch {
            store = null;
        }
        if (!factory || !locks || !store || closed) {
            report({ kind: "sync", phase: "journalFailed", reason: "unavailable" });
            return false;
        }
        let claimed: { release: () => void; held: Promise<unknown> } | null = null;
        try {
            let id = readTabId(store);
            for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS && !claimed; attempt++) {
                if (!id || attempt > 0) {
                    id = mintId();
                    store.setItem(JOURNAL_TAB_KEY, id);
                }
                claimed = await claimOwner(ownerLockName(id));
                if (claimed) {
                    tabId = id;
                }
            }
        } catch (error) {
            reportFailure(error, "unavailable");
            return false;
        }
        if (!claimed) {
            report({ kind: "sync", phase: "journalFailed", reason: "unavailable" });
            return false;
        }
        releaseOwner = claimed.release;
        ownerHeld = claimed.held;
        if (closed) {
            releaseOwner();
            return false;
        }
        try {
            await seed();
        } catch (error) {
            reportFailure(error, "readFailed");
            releaseOwner?.();
            releaseOwner = null;
            db?.close();
            db = null;
            return false;
        }
        if (closed) {
            return false;
        }
        enabled = true;
        return true;
    }

    /** Stamps and merges one write into `existing`; the names it removed and whether anything changed. */
    function applyWrite(
        existing: MutationEntry | undefined,
        key: string,
        item: JournalWrite,
        eligible: Set<string>,
        createdAt?: number,
    ): { row: MutationEntry | null; changed: boolean; ineligible: boolean; touched: string[] } {
        const layers: Record<string, StoredLayer<unknown>> = { ...(existing?.layers ?? {}) };
        let changed = false;
        let ineligible = false;
        const touched: string[] = [];
        for (const [name, value] of Object.entries(item.layers as Record<string, unknown>)) {
            if (value === undefined) {
                continue;
            }
            const stored = layers[name];
            const removing = value === null || !eligible.has(name);
            if (value !== null && !eligible.has(name)) {
                ineligible = true;
            }
            if (removing) {
                if (stored && stored.version < item.version) {
                    delete layers[name];
                    changed = true;
                }
                continue;
            }
            if (item.version <= fenceOf(key, name) || (stored && stored.version >= item.version)) {
                continue;
            }
            layers[name] = { version: item.version, value };
            touched.push(name);
            changed = true;
        }
        if (!changed) {
            return { row: existing ?? null, changed, ineligible, touched };
        }
        const versions = Object.values(layers).map((layer) => layer.version);
        if (versions.length === 0) {
            return { row: null, changed, ineligible, touched };
        }
        const time = now();
        const base = {
            format: JOURNAL_FORMAT,
            type: "mutation" as const,
            epoch: item.epoch,
            tabId: tabId!,
            target: item.target,
            version: Math.max(...versions),
            createdAt: existing?.createdAt ?? createdAt ?? time,
            updatedAt: time,
            size: 0,
        };
        const row = { ...base, scope: item.scope, layers } as MutationEntry;
        row.size = sizeOf(row);
        return { row, changed, ineligible, touched };
    }

    /** The bytes the readable rows' `size` index sums to. */
    async function totalSize(store: IDBObjectStore): Promise<number> {
        let total = 0;
        await eachCursor(store.index(INDEXES.size).openKeyCursor(), (cursor) => {
            if (isSize(cursor.key)) {
                total += cursor.key;
            }
        });
        return total;
    }

    /**
     * Evicts recovery drafts and expired composer drafts, oldest first, until at least `needed` bytes are
     * freed; answers the bytes freed. Evicts nothing when they cannot free that much. `keep` is never
     * evicted; `expiredOnly` also protects live recovery drafts.
     */
    async function evict(
        store: IDBObjectStore,
        needed: number,
        keep: ReadonlySet<string>,
        expiredOnly = false,
    ): Promise<number> {
        const candidates: { key: string; createdAt: number; size: number }[] = [];
        const time = now();
        const collect = (prefix: string, expiredOnly: boolean) =>
            eachCursor(store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`)), (cursor) => {
                const row = checkJournalRow(cursor.value);
                const key = String(cursor.primaryKey);
                if (row && !keep.has(key) && (!expiredOnly || isExpired(row.createdAt, time))) {
                    candidates.push({ key, createdAt: row.createdAt, size: row.size });
                }
            });
        await collect(DRAFT_PREFIX, expiredOnly);
        await collect(COMPOSER_PREFIX, true);
        candidates.sort((a, b) => a.createdAt - b.createdAt);
        const chosen: string[] = [];
        let freed = 0;
        for (const candidate of candidates) {
            if (freed >= needed) {
                break;
            }
            chosen.push(candidate.key);
            freed += candidate.size;
        }
        if (freed < needed) {
            return 0;
        }
        for (const key of chosen) {
            store.delete(key);
        }
        return freed;
    }

    function write(items: JournalWrite[], removals: JournalRemoval[] = []): Promise<WriteOutcome[]> {
        if (!enabled || closed) {
            return Promise.resolve(items.map(() => "off" as const));
        }
        const preparedRemovals = prepareRemovals(removals);
        // Copy at the call (the caller's objects may change while the database opens) and decide
        // eligibility and fences now, in call order.
        const prepared = items.map((item) => {
            let copy: JournalWrite;
            try {
                copy = { ...item, layers: structuredClone(item.layers) } as JournalWrite;
            } catch (error) {
                console.warn("[Draft journal]", error);
                return null;
            }
            const key = mutationKey(copy.epoch, tabId!, copy.scope, copy.target);
            const eligible = new Set<string>();
            let excluded = false;
            if (copy.scope === "record") {
                const kind = recordKind(copy.target);
                excluded = kind === null || !isJournalEligible({ scope: "record", kind, text: null });
                for (const [name, value] of Object.entries(copy.layers)) {
                    if (
                        !excluded &&
                        kind !== null &&
                        value &&
                        isJournalEligible({ scope: "record", kind, text: (value as { text: string | null }).text })
                    ) {
                        eligible.add(name);
                    }
                }
            } else {
                for (const name of Object.keys(copy.layers)) {
                    eligible.add(name);
                }
            }
            if (excluded) {
                raiseFence(key, copy.version);
            }
            for (const [name, value] of Object.entries(copy.layers)) {
                if (value === null || (value !== undefined && !eligible.has(name))) {
                    raiseFence(`${key}${NUL}${name}`, copy.version);
                }
            }
            return { item: copy, key, eligible, excluded };
        });
        return tracked(
            items.map(() => "off" as const),
            async (): Promise<WriteOutcome[]> => {
                const events: DiagnosticEventInput[] = [];
                try {
                    const outcomes = await withDatabase("readwrite", async (store) => {
                        const removed = await removeRows(store, preparedRemovals);
                        let total = await totalSize(store);
                        const answers: WriteOutcome[] = [];
                        for (const entry of prepared) {
                            if (!entry) {
                                answers.push("failed");
                                continue;
                            }
                            const { item, key, eligible, excluded } = entry;
                            const raw: unknown = await requestValue(store.get(key));
                            // Adoption may have reserved it while this transaction waited to run.
                            if (reserved.has(key)) {
                                answers.push("skipped");
                                continue;
                            }
                            let existing: MutationEntry | undefined;
                            if (raw !== undefined) {
                                const checked = checkJournalRow(raw);
                                if (checked?.type !== "mutation") {
                                    // An unknown row holds the key: it is kept as it is.
                                    answers.push("skipped");
                                    continue;
                                }
                                existing = checked;
                            }
                            if (excluded) {
                                const kept = existing ? trimThrough(existing, item.version, null) : null;
                                if (existing) {
                                    total -= existing.size;
                                    if (kept) {
                                        store.put(kept, key);
                                        total += kept.size;
                                    } else {
                                        store.delete(key);
                                    }
                                }
                                answers.push("ineligible");
                                continue;
                            }
                            const result = applyWrite(existing, key, item, eligible, removed.get(key));
                            let { row } = result;
                            let skipped: SyncReason | null = null;
                            if (row && result.touched.length > 0 && row.size > MAX_JOURNAL_ENTRY_BYTES) {
                                skipped = "tooLarge";
                            } else if (row && result.touched.length > 0) {
                                const after = total - (existing?.size ?? 0) + row.size;
                                if (after > MAX_JOURNAL_TOTAL_BYTES) {
                                    total -= await evict(store, after - MAX_JOURNAL_TOTAL_BYTES, new Set([key]));
                                    if (total - (existing?.size ?? 0) + row.size > MAX_JOURNAL_TOTAL_BYTES) {
                                        skipped = "budget";
                                    }
                                }
                            }
                            if (skipped) {
                                // The newer values are not written; their older values go too.
                                for (const name of result.touched) {
                                    raiseFence(`${key}${NUL}${name}`, item.version);
                                }
                                row = row ? trimThrough(row, item.version, result.touched) : null;
                                events.push({ kind: "sync", phase: "journalSkipped", reason: skipped, entries: 1 });
                            }
                            if (!result.changed && !skipped) {
                                answers.push(result.ineligible ? "ineligible" : "stale");
                                continue;
                            }
                            total -= existing?.size ?? 0;
                            if (row) {
                                store.put(row, key);
                                total += row.size;
                            } else if (existing) {
                                store.delete(key);
                            }
                            answers.push(skipped ? "skipped" : result.ineligible ? "ineligible" : "written");
                        }
                        return answers;
                    });
                    events.forEach(report);
                    return outcomes;
                } catch (error) {
                    reportFailure(error, "write");
                    return prepared.map(() => "failed" as const);
                }
            },
        );
    }

    /**
     * `row` without the layers of `names` (all when null) written at or before `version`; null when no
     * layer is left.
     */
    function trimThrough<R extends MutationEntry>(row: R, version: number, names: readonly string[] | null): R | null {
        const layers: Record<string, StoredLayer<unknown>> = { ...row.layers };
        let changed = false;
        for (const [name, layer] of Object.entries(layers)) {
            if ((names === null || names.includes(name)) && layer.version <= version) {
                delete layers[name];
                changed = true;
            }
        }
        if (!changed) {
            return row;
        }
        const versions = Object.values(layers).map((layer) => layer.version);
        if (versions.length === 0) {
            return null;
        }
        const trimmed = { ...row, layers, version: Math.max(...versions), updatedAt: now() } as R;
        trimmed.size = sizeOf(trimmed);
        return trimmed;
    }

    function prepareRemovals(items: JournalRemoval[]) {
        return items.map((item) => {
            const key = mutationKey(item.epoch, tabId!, item.scope, item.target);
            if (item.layers) {
                for (const name of item.layers) {
                    raiseFence(`${key}${NUL}${name}`, item.version);
                }
            } else {
                raiseFence(key, item.version);
            }
            return { key, version: item.version, layers: item.layers ? [...item.layers] : null };
        });
    }

    /** Returns creation times of removed rows so a combined write preserves their retention window. */
    async function removeRows(store: IDBObjectStore, items: ReturnType<typeof prepareRemovals>) {
        const removed = new Map<string, number>();
        for (const { key, version, layers } of items) {
            const existing = checkJournalRow(await requestValue(store.get(key)));
            if (reserved.has(key) || existing?.type !== "mutation") {
                continue;
            }
            const kept = trimThrough(existing, version, layers);
            if (!kept) {
                removed.set(key, existing.createdAt);
                store.delete(key);
            } else if (kept !== existing) {
                store.put(kept, key);
            }
        }
        return removed;
    }

    function remove(items: JournalRemoval[]): Promise<void> {
        if (!enabled || closed) {
            return Promise.resolve();
        }
        const prepared = prepareRemovals(items);
        return tracked(undefined, async () => {
            try {
                await withDatabase("readwrite", (store) => removeRows(store, prepared));
            } catch (error) {
                reportFailure(error, "write");
            }
        });
    }

    function readOwn(): Promise<KeyedEntry<MutationEntry>[]> {
        return tracked([], async () => {
            const own = tabId!;
            try {
                return await withDatabase("readonly", async (store) => {
                    const time = now();
                    const rows: KeyedEntry<MutationEntry>[] = [];
                    await eachCursor(store.index(INDEXES.tabId).openCursor(IDBKeyRange.only(own)), (cursor) => {
                        const row = checkJournalRow(cursor.value);
                        if (row?.type === "mutation" && !isExpired(row.createdAt, time)) {
                            rows.push({ ...row, key: String(cursor.primaryKey) });
                        }
                    });
                    return rows;
                });
            } catch (error) {
                reportFailure(error, "readFailed");
                return [];
            }
        });
    }

    /** A draft row of `entry`'s layers, keeping its `createdAt`. */
    function draftOf(
        entry: ScopedLayers & { epoch: string; target: string; createdAt: number },
        id: string,
    ): DraftEntry {
        const base = {
            format: JOURNAL_FORMAT,
            type: "draft" as const,
            id,
            epoch: entry.epoch,
            target: entry.target,
            createdAt: entry.createdAt,
            size: 0,
        };
        const row = { ...base, scope: entry.scope, layers: entry.layers } as DraftEntry;
        row.size = sizeOf(row);
        return row;
    }

    /** Re-keys `other`'s rows to this tab in one transaction; answers how many it took. */
    async function transfer(other: string): Promise<number> {
        const own = tabId!;
        const time = now();
        return withDatabase(
            "readwrite",
            async (store) => {
                const rows: { key: string; row: MutationEntry }[] = [];
                await eachCursor(store.index(INDEXES.tabId).openCursor(IDBKeyRange.only(other)), (cursor) => {
                    const row = checkJournalRow(cursor.value);
                    if (row?.type === "mutation") {
                        rows.push({ key: String(cursor.primaryKey), row });
                    }
                });
                let taken = 0;
                for (const { key, row } of rows) {
                    if (isExpired(row.createdAt, time) || !layersEligible(row)) {
                        store.delete(key);
                        continue;
                    }
                    const version = ++counter;
                    const layers = Object.fromEntries(
                        Object.entries(row.layers).map(([name, layer]) => [name, { version, value: layer.value }]),
                    );
                    const target = mutationKey(row.epoch, own, row.scope, row.target);
                    const occupied = (await requestValue(store.getKey(target))) !== undefined;
                    if (occupied) {
                        const id = mintId();
                        store.put(draftOf(row, id), draftKey(id));
                    } else {
                        if (row.scope === "chat" || row.scope === "order") {
                            reserved.add(target);
                        }
                        const adopted = { ...row, tabId: own, version, layers, updatedAt: time } as MutationEntry;
                        adopted.size = sizeOf(adopted);
                        store.put(adopted, target);
                    }
                    store.delete(key);
                    taken++;
                }
                return taken;
            },
            openTimeoutMs,
        );
    }

    function adoptOrphans(): Promise<number> {
        return tracked(0, async () => {
            const own = tabId!;
            const abort = new AbortController();
            recoverAborts.add(abort);
            const timer = setTimeout(() => abort.abort(), recoverTimeoutMs);
            let taken = 0;
            const events: DiagnosticEventInput[] = [];
            try {
                await locks!.request(JOURNAL_RECOVER_LOCK, { mode: "exclusive", signal: abort.signal }, async () => {
                    clearTimeout(timer);
                    const others = await withDatabase(
                        "readonly",
                        async (store) => {
                            const ids: string[] = [];
                            await eachCursor(store.index(INDEXES.tabId).openKeyCursor(null, "nextunique"), (cursor) => {
                                if (typeof cursor.key === "string" && cursor.key !== own) {
                                    ids.push(cursor.key);
                                }
                            });
                            return ids;
                        },
                        openTimeoutMs,
                    );
                    for (const other of others) {
                        if (closed) {
                            break;
                        }
                        await locks!.request(ownerLockName(other), { ifAvailable: true }, async (lock) => {
                            // Refused: that tab is alive (hidden or frozen included); its rows stay.
                            if (!lock || closed) {
                                return;
                            }
                            const count = await transfer(other);
                            if (count > 0) {
                                taken += count;
                                events.push({
                                    kind: "sync",
                                    phase: "journalRecovered",
                                    reason: "orphan",
                                    entries: count,
                                });
                            }
                        });
                    }
                });
            } catch (error) {
                if (!closed) {
                    reportFailure(
                        abort.signal.aborted
                            ? new JournalFailure("timeout", "The recover lock was not granted in time")
                            : error,
                        "write",
                    );
                }
            } finally {
                clearTimeout(timer);
                recoverAborts.delete(abort);
            }
            events.forEach(report);
            return taken;
        });
    }

    function moveToDrafts(items: DraftMove[]): Promise<(string | null)[]> {
        if (!enabled || closed) {
            return Promise.resolve(items.map(() => null));
        }
        const prepared = items.map((item) => {
            const key = mutationKey(item.epoch, tabId!, item.scope, item.target);
            return { key, version: item.version, layers: item.layers ? [...item.layers] : null };
        });
        return tracked(
            items.map(() => null),
            async () => {
                try {
                    const freed: string[] = [];
                    const ids = await withDatabase("readwrite", async (store) => {
                        const answers: (string | null)[] = [];
                        for (const { key, version, layers } of prepared) {
                            const row = checkJournalRow(await requestValue(store.get(key)));
                            for (const name of layers ?? [null])
                                raiseFence(name === null ? key : `${key}${NUL}${name}`, version);
                            if (
                                row?.type !== "mutation" ||
                                Object.entries(row.layers).some(
                                    ([name, layer]) => (!layers || layers.includes(name)) && layer.version > version,
                                )
                            ) {
                                answers.push(null);
                                continue;
                            }
                            if (!layersEligible(row)) {
                                store.delete(key);
                                freed.push(key);
                                answers.push(null);
                                continue;
                            }
                            const selected = Object.fromEntries(
                                Object.entries(row.layers).filter(([name]) => !layers || layers.includes(name)),
                            );
                            if (layers && Object.keys(selected).length === 0) {
                                answers.push(null);
                                continue;
                            }
                            const id = mintId();
                            store.put(draftOf({ ...row, layers: selected } as MutationEntry, id), draftKey(id));
                            const remaining = Object.fromEntries(
                                Object.entries(row.layers).filter(([name]) => layers && !layers.includes(name)),
                            );
                            if (Object.keys(remaining).length > 0) {
                                const kept = { ...row, layers: remaining };
                                kept.size = journalValueSize(kept);
                                store.put(kept, key);
                            } else {
                                store.delete(key);
                                freed.push(key);
                            }
                            answers.push(id);
                        }
                        return answers;
                    });
                    for (const key of freed) reserved.delete(key);
                    return ids;
                } catch (error) {
                    reportFailure(error, "write");
                    return prepared.map(() => null);
                }
            },
        );
    }

    function release(items: JournalRelease[]): Promise<(StoredLayers<"chat"> | StoredLayers<"order"> | null)[]> {
        const version = counter;
        const keys = items.map((item) => mutationKey(item.epoch, tabId!, item.scope, item.target));
        return tracked([], async () => {
            try {
                const layers = await withDatabase("readwrite", async (store) => {
                    const answers: (StoredLayers<"chat"> | StoredLayers<"order"> | null)[] = [];
                    for (const key of keys) {
                        const row = checkJournalRow(await requestValue(store.get(key)));
                        if (row?.type === "mutation" && row.scope !== "record") {
                            if (isExpired(row.createdAt, now())) {
                                raiseFence(key, version);
                                store.delete(key);
                                answers.push(null);
                            } else answers.push(row.layers);
                        } else answers.push(null);
                    }
                    return answers;
                });
                for (const key of keys) reserved.delete(key);
                return layers;
            } catch (error) {
                reportFailure(error, "write");
                return [];
            }
        });
    }

    function putDraft(input: DraftInput): Promise<string | null> {
        if (!enabled || closed) {
            return Promise.resolve(null);
        }
        let layers: Record<string, StoredLayer<unknown>>;
        try {
            layers = Object.fromEntries(
                Object.entries(structuredClone(input.layers) as Record<string, unknown>)
                    .filter(([, value]) => value !== null && value !== undefined)
                    .map(([name, value]) => [name, { version: 0, value }]),
            );
        } catch (error) {
            console.warn("[Draft journal]", error);
            return Promise.resolve(null);
        }
        const id = mintId();
        const scoped = { scope: input.scope, layers } as ScopedLayers;
        const row = draftOf(
            { ...scoped, epoch: input.epoch, target: input.target, createdAt: input.createdAt ?? now() },
            id,
        );
        if (!layersEligible(row)) {
            return Promise.resolve(null);
        }
        if (row.size > MAX_JOURNAL_ENTRY_BYTES) {
            report({ kind: "sync", phase: "journalSkipped", reason: "tooLarge", entries: 1 });
            return Promise.resolve(null);
        }
        return tracked(null, async () => {
            let skipped = false;
            try {
                await withDatabase("readwrite", async (store) => {
                    let total = await totalSize(store);
                    if (total + row.size > MAX_JOURNAL_TOTAL_BYTES) {
                        total -= await evict(store, total + row.size - MAX_JOURNAL_TOTAL_BYTES, new Set(), true);
                    }
                    if (total + row.size > MAX_JOURNAL_TOTAL_BYTES) {
                        skipped = true;
                        return;
                    }
                    store.put(row, draftKey(id));
                });
            } catch (error) {
                reportFailure(error, "write");
                return null;
            }
            if (skipped) {
                report({ kind: "sync", phase: "journalSkipped", reason: "budget", entries: 1 });
                return null;
            }
            return id;
        });
    }

    function listDrafts(): Promise<DraftEntry[]> {
        return tracked([], async () => {
            try {
                return await withDatabase("readonly", async (store) => {
                    const time = now();
                    const drafts: DraftEntry[] = [];
                    await eachCursor(
                        store.openCursor(IDBKeyRange.bound(DRAFT_PREFIX, `${DRAFT_PREFIX}\uffff`)),
                        (cursor) => {
                            const row = checkJournalRow(cursor.value);
                            if (row?.type === "draft" && !isExpired(row.createdAt, time)) {
                                drafts.push(row);
                            }
                        },
                    );
                    return drafts;
                });
            } catch (error) {
                reportFailure(error, "readFailed");
                return [];
            }
        });
    }

    function removeDraft(id: string): Promise<void> {
        return tracked(undefined, async () => {
            try {
                await withDatabase("readwrite", async (store) => {
                    const key = draftKey(id);
                    if (checkJournalRow(await requestValue(store.get(key)))?.type === "draft") {
                        store.delete(key);
                    }
                });
            } catch (error) {
                reportFailure(error, "write");
            }
        });
    }

    async function readComposer(chatKey: string): Promise<ComposerValue | null> {
        await (started ??= start());
        return tracked(null, async () => {
            try {
                return await withDatabase("readonly", async (store) => {
                    const row = checkJournalRow(await requestValue(store.get(composerKey(chatKey))));
                    return row?.type === "composer" && !isExpired(row.createdAt, now()) ? row.value : null;
                });
            } catch (error) {
                reportFailure(error, "readFailed");
                return null;
            }
        });
    }

    async function putComposer(chatKey: string, value: ComposerValue): Promise<WriteOutcome> {
        let copy: ComposerValue;
        try {
            copy = structuredClone(value);
        } catch (error) {
            reportFailure(error, "write");
            return "failed";
        }
        await (started ??= start());
        return tracked<WriteOutcome>("off", async () => {
            try {
                let skipped: SyncReason | undefined;
                const outcome = await withDatabase("readwrite", async (store): Promise<WriteOutcome> => {
                    const key = composerKey(chatKey);
                    const raw: unknown = await requestValue(store.get(key));
                    const existing = checkJournalRow(raw);
                    if (!checkComposerValue(copy) || (raw !== undefined && existing?.type !== "composer")) {
                        skipped = "format";
                        return "skipped";
                    }
                    const time = now();
                    const row: ComposerEntry = {
                        format: JOURNAL_FORMAT,
                        type: "composer",
                        chatKey,
                        createdAt: existing && !isExpired(existing.createdAt, time) ? existing.createdAt : time,
                        updatedAt: time,
                        value: copy,
                        size: 0,
                    };
                    row.size = sizeOf(row);
                    if (row.size > MAX_JOURNAL_ENTRY_BYTES) {
                        skipped = "tooLarge";
                        return "skipped";
                    }
                    let total = (await totalSize(store)) - (existing?.size ?? 0) + row.size;
                    if (total > MAX_JOURNAL_TOTAL_BYTES) {
                        total -= await evict(store, total - MAX_JOURNAL_TOTAL_BYTES, new Set([key]));
                    }
                    if (total > MAX_JOURNAL_TOTAL_BYTES) {
                        skipped = "budget";
                        return "skipped";
                    }
                    store.put(row, key);
                    return "written";
                });
                if (skipped) {
                    report({ kind: "sync", phase: "journalSkipped", reason: skipped, entries: 1 });
                }
                return outcome;
            } catch (error) {
                reportFailure(error, "write");
                return "failed";
            }
        });
    }

    async function removeComposer(chatKey: string, condition: ComposerRemoval = {}): Promise<void> {
        const { userMessageId } = condition;
        const keepSendingIds = new Set(condition.keepSendingIds);
        await (started ??= start());
        return tracked(undefined, async () => {
            try {
                await withDatabase("readwrite", async (store) => {
                    const key = composerKey(chatKey);
                    const row = checkJournalRow(await requestValue(store.get(key)));
                    if (
                        row?.type === "composer" &&
                        (userMessageId === undefined || row.value.userMessageId === userMessageId) &&
                        !(row.value.state === "sending" && keepSendingIds.has(row.value.userMessageId!))
                    ) {
                        store.delete(key);
                    }
                });
            } catch (error) {
                reportFailure(error, "write");
            }
        });
    }

    async function removeComposersOf(chaId: string): Promise<void> {
        await (started ??= start());
        return tracked(undefined, async () => {
            try {
                await withDatabase("readwrite", async (store) => {
                    const prefix = composerKey(`${chaId}${NUL}`);
                    await eachCursor(store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`)), (cursor) => {
                        if (checkJournalRow(cursor.value)?.type === "composer") {
                            cursor.delete();
                        }
                    });
                });
            } catch (error) {
                reportFailure(error, "write");
            }
        });
    }

    function purgeExpired(): Promise<number> {
        const version = counter;
        return tracked(0, async () => {
            const own = tabId!;
            try {
                const expired = await withDatabase("readwrite", async (store) => {
                    const time = now();
                    const expired: string[] = [];
                    const collect = (request: IDBRequest<IDBCursorWithValue | null>, owned: boolean) =>
                        eachCursor(request, (cursor) => {
                            const row = checkJournalRow(cursor.value);
                            if (
                                row &&
                                isExpired(row.createdAt, time) &&
                                (!owned || (row.type === "mutation" && row.tabId === own))
                            ) {
                                const key = String(cursor.primaryKey);
                                if (row.type === "mutation" && row.tabId === own) {
                                    raiseFence(key, version);
                                }
                                expired.push(key);
                            }
                        });
                    await collect(store.index(INDEXES.tabId).openCursor(IDBKeyRange.only(own)), true);
                    await collect(store.openCursor(IDBKeyRange.bound(DRAFT_PREFIX, `${DRAFT_PREFIX}\uffff`)), false);
                    await collect(
                        store.openCursor(IDBKeyRange.bound(COMPOSER_PREFIX, `${COMPOSER_PREFIX}\uffff`)),
                        false,
                    );
                    for (const key of expired) {
                        store.delete(key);
                    }
                    return expired;
                });
                for (const key of expired) reserved.delete(key);
                return expired.length;
            } catch (error) {
                reportFailure(error, "write");
                return 0;
            }
        });
    }

    function close(): Promise<void> {
        if (closing) {
            return closing;
        }
        closed = true;
        enabled = false;
        for (const abort of recoverAborts) {
            abort.abort();
        }
        closing = (async () => {
            let timer: ReturnType<typeof setTimeout>;
            const deadline = new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    reportFailure(new JournalFailure("timeout", "The journal did not close in time"), "timeout");
                    resolve();
                }, openTimeoutMs);
            });
            try {
                await Promise.race([Promise.allSettled([started, ...inFlight]), deadline]);
                for (const abort of transactions.values()) {
                    abort();
                }
                db?.close();
                db = null;
                releaseOwner?.();
                releaseOwner = null;
                await Promise.race([ownerHeld?.catch(() => {}), deadline]);
            } finally {
                clearTimeout(timer!);
            }
        })();
        return closing;
    }

    return {
        start: () => (started ??= start()),
        get enabled() {
            return enabled;
        },
        get tabId() {
            return tabId;
        },
        nextVersion: () => ++counter,
        write,
        remove,
        readOwn,
        adoptOrphans,
        moveToDrafts,
        release,
        putDraft,
        listDrafts,
        removeDraft,
        readComposer,
        putComposer,
        removeComposer,
        removeComposersOf,
        purgeExpired,
        close,
    };
}

let pageJournal: DraftJournal | undefined;

/** One connection and owner lock for the page; screen destruction does not close it. */
export function pageDraftJournal(): DraftJournal {
    return (pageJournal ??= createDraftJournal());
}
