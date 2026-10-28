import { IDBDatabase, IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticEventInput } from "../../../../shared/diagnostics.ts";
import {
    checkJournalRow,
    chatTarget,
    orderTarget,
    createDraftJournal,
    type DraftJournal,
    type ConflictDraft,
    type DraftJournalDeps,
    draftKey,
    isExpired,
    JOURNAL_DB_NAME,
    JOURNAL_ENTRY_TTL_MS,
    JOURNAL_RECOVER_LOCK,
    JOURNAL_TAB_KEY,
    journalValueSize,
    type JournalWrite,
    MAX_JOURNAL_ENTRY_BYTES,
    MAX_JOURNAL_TOTAL_BYTES,
    mutationKey,
    ownerLockName,
    type RecordOp,
    recordTarget,
} from "../draftJournal";
import { createFakeLockManager, type FakeLockManager } from "./fakeLockManager";

// The draft journal's store (`draftJournal.ts`) over `fake-indexeddb`, an injected clock, and a fake
// Web Locks manager: keys and per-layer versions (a late write never resurrects a removed layer, a
// late delete never erases newer work, a move drafts the writes queued before it), the eligibility
// boundary at every write path (a malformed record address included), the budgets with eviction
// and sizes that cannot poison the totals, expiry (a purge that no delayed write renews), the
// ownership protocol (a reload, a duplicated id, live and dead owners, sequential recoverers, a
// collision made a draft), the schema repair, the deadlines on an open, a startup read, a recover
// wait, and a close, and the unknown rows that are kept through everything. No test waits on a real
// timer: deadlines run on faked `setTimeout` and the database is driven through it.

const PENDING = Symbol("pending");
const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const EPOCH = "epoch-1";
const CHARACTER = recordTarget("characters", "c1");
const SECRET = "sk-live-0123456789abcdef";
const UNKNOWN_FORMAT_ROW = { format: 2, type: "mutation", size: 10, createdAt: T0, tabId: "elsewhere" };

vi.stubGlobal("IDBKeyRange", IDBKeyRange);
afterAll(() => vi.unstubAllGlobals());

const latest = (text: string | null, op: RecordOp = "update") => ({ op, baseRevision: "r1", text });
const sent = (text: string | null, op: RecordOp = "update") => ({
    op,
    baseRevision: "r1",
    text,
    dispatched: true as const,
    inDoubt: false,
});
const characterWrite = (version: number, layers: JournalWrite["layers"], target = CHARACTER): JournalWrite =>
    ({ epoch: EPOCH, scope: "record", target, version, layers }) as JournalWrite;

/** A tab's `sessionStorage`: one per tab, shared by that tab's reloads. */
function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        key: (index: number) => [...map.keys()][index] ?? null,
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
        clear: () => map.clear(),
    };
}

type Harness = {
    factory: IDBFactory;
    locks: FakeLockManager;
    clock: { now: number };
    ids: { next: number };
};

function harness(): Harness {
    return { factory: new IDBFactory(), locks: createFakeLockManager(), clock: { now: T0 }, ids: { next: 0 } };
}

type Tab = { journal: DraftJournal; events: DiagnosticEventInput[]; storage: Storage };

/** A page's journal in `h`: `storage` is the tab (pass a tab's storage again for its reload). */
function page(h: Harness, over: Partial<DraftJournalDeps> & { storage?: () => Storage | null } = {}): Tab {
    const storage = memoryStorage();
    const events: DiagnosticEventInput[] = [];
    const journal = createDraftJournal({
        indexedDB: h.factory,
        locks: h.locks,
        storage: () => storage,
        now: () => h.clock.now,
        newId: () => `id-${++h.ids.next}`,
        report: (event) => events.push(event),
        ...over,
    });
    return { journal, events, storage };
}

async function started(h: Harness, over: Partial<DraftJournalDeps> & { storage?: () => Storage | null } = {}) {
    const tab = page(h, over);
    expect(await tab.journal.start()).toBe(true);
    return tab;
}

function openRaw(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = factory.open(JOURNAL_DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Every row of the store by key, read on a connection of its own. */
async function rows(factory: IDBFactory): Promise<Record<string, unknown>> {
    const db = await openRaw(factory);
    const out: Record<string, unknown> = {};
    await new Promise<void>((resolve, reject) => {
        const request = db.transaction("entries", "readonly").objectStore("entries").openCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve();
                return;
            }
            out[String(cursor.key)] = cursor.value;
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });
    db.close();
    return out;
}

/** Puts `value` at `key` as another writer would, bypassing the journal. */
async function rawPut(factory: IDBFactory, key: string, value: unknown): Promise<void> {
    const db = await openRaw(factory);
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("entries", "readwrite");
        tx.objectStore("entries").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
    });
    db.close();
}

/** Resolves `promise` by advancing the faked `setTimeout` (which also drives `fake-indexeddb`), or `PENDING` after `ms`. */
async function drive<T>(promise: Promise<T>, ms: number): Promise<T | typeof PENDING> {
    let settled: { value?: T; error?: unknown; failed: boolean } | null = null;
    promise.then(
        (value) => (settled = { value, failed: false }),
        (error: unknown) => (settled = { error, failed: true }),
    );
    for (let step = 0; step < ms && !settled; step++) {
        await vi.advanceTimersByTimeAsync(1);
    }
    if (!settled) {
        return PENDING;
    }
    const outcome: { value?: T; error?: unknown; failed: boolean } = settled;
    if (outcome.failed) {
        throw outcome.error;
    }
    return outcome.value as T;
}

/**
 * `real` behind a factory whose transactions never finish while `hang.on`: their requests never
 * answer and their completion is never reported (a stalled database, as a frozen writer on another
 * connection leaves it); opens and upgrades stay real.
 */
function hangable(real: IDBFactory): { factory: IDBFactory; hang: { on: boolean } } {
    const hang = { on: false };
    const REQUESTERS = new Set(["get", "getKey", "count", "openCursor", "openKeyCursor", "put", "delete"]);
    const bound = (target: object, value: unknown) => (typeof value === "function" ? value.bind(target) : value);
    const dead = () => ({ onsuccess: null, onerror: null, result: undefined, error: null }) as unknown as IDBRequest;
    const wrapSource = (source: object): object =>
        new Proxy(source, {
            get(target, prop) {
                const value: unknown = Reflect.get(target, prop, target);
                if (prop === "index" && typeof value === "function") {
                    return (...args: unknown[]) => wrapSource(value.apply(target, args));
                }
                if (typeof prop === "string" && REQUESTERS.has(prop) && typeof value === "function") {
                    return (...args: unknown[]) => (hang.on ? dead() : value.apply(target, args));
                }
                return bound(target, value);
            },
        });
    const wrapTx = (tx: IDBTransaction): IDBTransaction =>
        new Proxy(tx, {
            get(target, prop) {
                const value: unknown = Reflect.get(target, prop, target);
                if (prop === "objectStore" && typeof value === "function") {
                    return (...args: unknown[]) => wrapSource(value.apply(target, args));
                }
                return bound(target, value);
            },
            set(target, prop, value) {
                if (!(hang.on && prop === "oncomplete")) {
                    Reflect.set(target, prop, value);
                }
                return true;
            },
        });
    const wrapDb = (db: IDBDatabase): IDBDatabase =>
        new Proxy(db, {
            get(target, prop) {
                const value: unknown = Reflect.get(target, prop, target);
                if (prop === "transaction" && typeof value === "function") {
                    return (...args: unknown[]) => wrapTx(value.apply(target, args));
                }
                return bound(target, value);
            },
            set(target, prop, value) {
                Reflect.set(target, prop, value);
                return true;
            },
        });
    const factory = {
        open(name: string, version?: number) {
            const request = version === undefined ? real.open(name) : real.open(name, version);
            return new Proxy(request, {
                get(target, prop) {
                    const value: unknown = Reflect.get(target, prop, target);
                    return prop === "result" && value ? wrapDb(value as IDBDatabase) : bound(target, value);
                },
                set(target, prop, value) {
                    Reflect.set(target, prop, value);
                    return true;
                },
            });
        },
    } as unknown as IDBFactory;
    return { factory, hang };
}

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("keys, sizes, expiry, and the row check", () => {
    it("keys an entry by epoch, tab, scope, and target with NUL separators; sizes a value in UTF-8 bytes of its strings and keys; expires at exactly 48 hours", () => {
        expect(mutationKey("e", "t", "record", recordTarget("characters", "c"))).toBe("e\0t\0record\0characters\0c");
        expect(draftKey("d")).toBe("draft\0d");
        expect(journalValueSize("a")).toBe(1);
        expect(journalValueSize("é")).toBe(2);
        expect(journalValueSize("한")).toBe(3);
        expect(journalValueSize("😀")).toBe(4);
        expect(journalValueSize("\ud800")).toBe(3);
        // An object costs 8, each key its bytes, each number or boolean 8; an array 8 plus its items.
        expect(journalValueSize({ ab: "cd", n: 1, list: ["x"] })).toBe(8 + 2 + 2 + 1 + 8 + 4 + 8 + 1);
        expect(isExpired(T0, T0 + JOURNAL_ENTRY_TTL_MS - 1)).toBe(false);
        expect(isExpired(T0, T0 + JOURNAL_ENTRY_TTL_MS)).toBe(true);
    });

    it("reads a mutation, draft, and composer row of format 1 and refuses another format, a negative or non-finite size, a record layer without its op, an unknown layer name, and a record target without exactly one separator", () => {
        const mutation = {
            format: 1,
            type: "mutation",
            epoch: EPOCH,
            tabId: "t",
            target: CHARACTER,
            scope: "record",
            version: 1,
            createdAt: T0,
            updatedAt: T0,
            size: 10,
            layers: { latest: { version: 1, value: latest("x") } },
        };
        expect(checkJournalRow(mutation)).toBe(mutation);
        const draft = {
            format: 1,
            type: "draft",
            id: "d",
            epoch: EPOCH,
            target: "a\0b",
            scope: "chat",
            createdAt: T0,
            size: 0,
            layers: {},
        };
        expect(checkJournalRow(draft)).toBe(draft);
        const composer = {
            format: 1,
            type: "composer",
            chatKey: "k",
            createdAt: T0,
            updatedAt: T0,
            size: 0,
            value: { input: "typed", translate: "", files: ["inlay"] },
        };
        expect(checkJournalRow(composer)).toBe(composer);
        // A composer payload without its fields is unknown, like any other unreadable row.
        expect(checkJournalRow({ ...composer, value: {} })).toBeNull();
        expect(checkJournalRow({ ...mutation, format: 2 })).toBeNull();
        expect(checkJournalRow({ ...mutation, size: -1 })).toBeNull();
        expect(checkJournalRow({ ...mutation, size: Infinity })).toBeNull();
        expect(
            checkJournalRow({
                ...mutation,
                layers: { latest: { version: 1, value: { baseRevision: "r1", text: "x" } } },
            }),
        ).toBeNull();
        expect(checkJournalRow({ ...mutation, layers: { pending: { version: 1, value: latest("x") } } })).toBeNull();
        expect(checkJournalRow({ ...mutation, target: "secrets" })).toBeNull();
        expect(checkJournalRow({ ...mutation, target: "a\0b\0c" })).toBeNull();
        expect(checkJournalRow({ ...mutation, target: "\0b" })).toBeNull();
        expect(checkJournalRow({ ...mutation, target: "characters\0" })).toBeNull();
        expect(checkJournalRow({ ...draft, type: "draft", scope: "record", target: "characters\0" })).toBeNull();
        expect(checkJournalRow(null)).toBeNull();
        expect(checkJournalRow("row")).toBeNull();
    });
});

describe("start and ownership", () => {
    it("is off without IndexedDB, without Web Locks, or with a sessionStorage that throws, reporting `unavailable` once and requesting no lock", async () => {
        for (const over of [
            { indexedDB: null },
            { locks: null },
            { storage: () => null },
            {
                storage: (): Storage => {
                    throw new Error("blocked");
                },
            },
            {
                storage: () =>
                    ({
                        getItem: () => {
                            throw new Error("blocked");
                        },
                    }) as unknown as Storage,
            },
        ] as Partial<DraftJournalDeps>[]) {
            const h = harness();
            const tab = page(h, over);
            expect(await tab.journal.start()).toBe(false);
            expect(tab.journal.enabled).toBe(false);
            expect(tab.journal.tabId).toBeNull();
            expect(tab.events).toEqual([{ kind: "sync", phase: "journalFailed", reason: "unavailable" }]);
            expect(h.locks.requests).toEqual([]);
            expect(await tab.journal.write([characterWrite(1, { latest: latest("x") })])).toEqual(["off"]);
            expect(await tab.journal.readOwn()).toEqual([]);
        }
    });

    it("mints a tab id into sessionStorage and holds its owner lock for the page's life; a reload reuses the id, owns the rows, and numbers new versions above them", async () => {
        const h = harness();
        const tab = await started(h);
        expect(tab.journal.tabId).toBe("id-1");
        expect(tab.storage.getItem(JOURNAL_TAB_KEY)).toBe("id-1");
        expect(h.locks.held()).toEqual([ownerLockName("id-1")]);
        const v1 = tab.journal.nextVersion();
        const v2 = tab.journal.nextVersion();
        await tab.journal.write([
            characterWrite(v1, { latest: latest("one") }),
            characterWrite(v2, { latest: latest("two") }, recordTarget("characters", "c2")),
        ]);
        expect(h.locks.held()).toEqual([ownerLockName("id-1")]);
        await tab.journal.close();
        expect(h.locks.held()).toEqual([]);

        const reloaded = page(h, { storage: () => tab.storage });
        expect(await reloaded.journal.start()).toBe(true);
        expect(reloaded.journal.tabId).toBe("id-1");
        expect(h.locks.held()).toEqual([ownerLockName("id-1")]);
        const own = await reloaded.journal.readOwn();
        expect(own.map((row) => [row.target, row.version])).toEqual([
            [CHARACTER, v1],
            [recordTarget("characters", "c2"), v2],
        ]);
        expect(reloaded.journal.nextVersion()).toBe(v2 + 1);
        expect(reloaded.events).toEqual([]);
    });

    it("a duplicated tab (another page holding the stored id's lock) mints a new id and keeps both owners live; after three refused ids the journal is off", async () => {
        const h = harness();
        const first = await started(h);
        const copy = page(h, { storage: () => first.storage });
        expect(await copy.journal.start()).toBe(true);
        expect(copy.journal.tabId).toBe("id-2");
        expect(first.storage.getItem(JOURNAL_TAB_KEY)).toBe("id-2");
        expect(h.locks.held().sort()).toEqual([ownerLockName("id-1"), ownerLockName("id-2")]);
        await first.journal.write([characterWrite(first.journal.nextVersion(), { latest: latest("first") })]);
        await copy.journal.write([characterWrite(copy.journal.nextVersion(), { latest: latest("copy") })]);
        expect((await first.journal.readOwn()).map((row) => row.tabId)).toEqual(["id-1"]);
        expect((await copy.journal.readOwn()).map((row) => row.tabId)).toEqual(["id-2"]);

        // The stored id is the copy's, and every id the next page could mint is taken by someone else.
        const squatters = ["id-3", "id-4"].map((id) => h.locks.request(ownerLockName(id), () => new Promise(() => {})));
        void squatters;
        await null;
        const third = page(h, { storage: () => first.storage });
        expect(await third.journal.start()).toBe(false);
        expect(third.events).toEqual([{ kind: "sync", phase: "journalFailed", reason: "unavailable" }]);
        expect(
            h.locks.requests
                .filter((r) => r.name.startsWith("risu-journal-owner:"))
                .map((r) => r.name)
                .slice(-3),
        ).toEqual([ownerLockName("id-2"), ownerLockName("id-3"), ownerLockName("id-4")]);
        expect(h.locks.held().sort()).toEqual([
            ownerLockName("id-1"),
            ownerLockName("id-2"),
            ownerLockName("id-3"),
            ownerLockName("id-4"),
        ]);
    });

    it("reports the rows it cannot read once at start (another format anywhere, a malformed format-1 row of this tab), and leaves them untouched", async () => {
        const h = harness();
        const first = await started(h);
        await first.journal.close();
        await rawPut(h.factory, "foreign-format", UNKNOWN_FORMAT_ROW);
        await rawPut(h.factory, "future", { format: 3, size: 1, createdAt: T0 });
        await rawPut(h.factory, "malformed-own", {
            format: 1,
            type: "mutation",
            tabId: "id-1",
            size: "big",
            createdAt: T0,
        });
        await rawPut(h.factory, "malformed-other", {
            format: 1,
            type: "mutation",
            tabId: "other",
            size: 1,
            createdAt: T0,
        });
        const reloaded = page(h, { storage: () => first.storage });
        expect(await reloaded.journal.start()).toBe(true);
        expect(reloaded.events).toEqual([{ kind: "sync", phase: "journalSkipped", reason: "format", entries: 3 }]);
        expect(await reloaded.journal.readOwn()).toEqual([]);
        expect(await reloaded.journal.purgeExpired()).toBe(0);
        expect(Object.keys(await rows(h.factory)).sort()).toEqual([
            "foreign-format",
            "future",
            "malformed-other",
            "malformed-own",
        ]);
    });

    it("upgrades a database missing a store or an index to the next version, creating only what is missing and keeping the rows", async () => {
        const h = harness();
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = h.factory.open(JOURNAL_DB_NAME, 1);
            request.onupgradeneeded = () => request.result.createObjectStore("entries");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const kept = {
            format: 1,
            type: "mutation",
            epoch: EPOCH,
            tabId: "id-1",
            target: CHARACTER,
            scope: "record",
            version: 7,
            createdAt: T0,
            updatedAt: T0,
            size: 10,
            layers: { latest: { version: 7, value: latest("kept") } },
        };
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("entries", "readwrite");
            tx.objectStore("entries").put(kept, mutationKey(EPOCH, "id-1", "record", CHARACTER));
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
        });
        db.close();
        const tab = await started(h);
        expect(tab.journal.tabId).toBe("id-1");
        expect(
            (await tab.journal.readOwn()).map((row) => [
                row.version,
                row.scope === "record" && row.layers.latest?.value.text,
            ]),
        ).toEqual([[7, "kept"]]);
        expect(tab.journal.nextVersion()).toBe(8);
        const upgraded = await openRaw(h.factory);
        expect(upgraded.version).toBe(2);
        expect([...upgraded.objectStoreNames].sort()).toEqual(["entries", "meta"]);
        expect([...upgraded.transaction("entries").objectStore("entries").indexNames].sort()).toEqual([
            "format",
            "size",
            "tabId",
        ]);
        upgraded.close();
        expect(tab.events).toEqual([]);
    });

    it("an open that never answers makes start false as `timeout` at the bound, releasing the owner lock; a blocked one as `blocked`; a connection arriving later is closed", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        for (const blocked of [false, true]) {
            const h = harness();
            const close = vi.fn();
            let request: { onsuccess?: () => void; onblocked?: () => void; result?: unknown } | null = null;
            const tab = page(h, {
                indexedDB: {
                    open: () => {
                        request = {};
                        return request;
                    },
                } as unknown as IDBFactory,
                openTimeoutMs: 50,
            });
            const starting = tab.journal.start();
            if (blocked) {
                await vi.advanceTimersByTimeAsync(0);
                request!.onblocked!();
            }
            expect(await drive(starting, 49)).toBe(PENDING);
            expect(h.locks.held()).toEqual([ownerLockName("id-1")]);
            expect(await drive(starting, 1)).toBe(false);
            expect(tab.events).toEqual([
                { kind: "sync", phase: "journalFailed", reason: blocked ? "blocked" : "timeout" },
            ]);
            expect(h.locks.held()).toEqual([]);
            request!.result = {
                close,
                onversionchange: null,
                onclose: null,
                objectStoreNames: { contains: () => false },
            };
            request!.onsuccess!();
            await vi.advanceTimersByTimeAsync(0);
            expect(close).toHaveBeenCalledTimes(1);
        }
    });

    it("a startup read that never finishes (a stalled database) makes start false as `timeout` at the bound and releases the owner lock, instead of hanging boot", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = harness();
        const { factory, hang } = hangable(h.factory);
        const first = page(h, { indexedDB: factory, openTimeoutMs: 50 });
        expect(await drive(first.journal.start(), 50)).toBe(true);
        expect(await drive(first.journal.close(), 50)).toBeUndefined();
        hang.on = true;
        const tab = page(h, { indexedDB: factory, openTimeoutMs: 50, storage: () => first.storage });
        const starting = tab.journal.start();
        // The open itself takes a few milliseconds of the faked clock; the read's bound starts after it.
        expect(await drive(starting, 40)).toBe(PENDING);
        expect(h.locks.held()).toEqual([ownerLockName("id-1")]);
        expect(await drive(starting, 60)).toBe(false);
        expect(tab.events).toEqual([{ kind: "sync", phase: "journalFailed", reason: "timeout" }]);
        expect(tab.journal.enabled).toBe(false);
        expect(h.locks.held()).toEqual([]);
        hang.on = false;
        expect(await drive(tab.journal.close(), 50)).toBeUndefined();
    });

    it("close waits for the calls in flight (their rows land), then releases the owner lock; later calls answer as off and a start after close is false", async () => {
        const h = harness();
        const tab = await started(h);
        const writing = tab.journal.write([characterWrite(tab.journal.nextVersion(), { latest: latest("landed") })]);
        // Two microtasks: the write has its connection and its transaction is created.
        await null;
        await null;
        const closing = tab.journal.close();
        expect(tab.journal.enabled).toBe(false);
        expect(await writing).toEqual(["written"]);
        await closing;
        expect(h.locks.held()).toEqual([]);
        expect(Object.keys(await rows(h.factory))).toEqual([mutationKey(EPOCH, "id-1", "record", CHARACTER)]);
        expect(await tab.journal.write([characterWrite(5, { latest: latest("late") })])).toEqual(["off"]);
        expect(await tab.journal.readOwn()).toEqual([]);
        expect(await tab.journal.adoptOrphans()).toBe(0);
        expect(
            await tab.journal.moveToDrafts([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: 1 }]),
        ).toEqual([null]);
        expect(await tab.journal.start()).toBe(true); // the single-flight start's earlier answer
        expect(tab.journal.enabled).toBe(false);
        expect(await page(h, { storage: () => tab.storage }).journal.start()).toBe(true);
        expect(tab.events).toEqual([]);
    });

    it("close gives up on a stalled write at the bound, reporting `timeout` (the write fails as `timeout` too), and still releases the owner lock", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = harness();
        const { factory, hang } = hangable(h.factory);
        const tab = page(h, { indexedDB: factory, openTimeoutMs: 50 });
        expect(await drive(tab.journal.start(), 50)).toBe(true);
        hang.on = true;
        const writing = tab.journal.write([characterWrite(tab.journal.nextVersion(), { latest: latest("stuck") })]);
        await null;
        await null;
        const closing = tab.journal.close();
        expect(await drive(closing, 49)).toBe(PENDING);
        expect(h.locks.held()).toEqual([ownerLockName("id-1")]);
        expect(await drive(closing, 1)).toBeUndefined();
        expect(h.locks.held()).toEqual([]);
        expect(await drive(writing, 10)).toEqual(["failed"]);
        expect(tab.events.map((event) => event.reason)).toEqual(["timeout", "timeout"]);
        hang.on = false;
        expect(Object.keys(await rows(h.factory))).toEqual([]);
    });
});

describe("writes, removals, and versions", () => {
    it("combines writes and captured-version removals in one transaction, preserving newer layers and creation time", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = harness();
        const { journal } = await started(h);
        const v1 = journal.nextVersion();
        const v2 = journal.nextVersion();
        const v3 = journal.nextVersion();
        const other = recordTarget("characters", "other");
        await journal.write([
            characterWrite(v1, { sent: sent("A"), latest: latest("B") }),
            characterWrite(v1, { latest: latest("old") }, other),
        ]);
        await journal.write([characterWrite(v2, { latest: latest("newer B") })]);
        h.clock.now += HOUR;
        const transactions = vi.spyOn(IDBDatabase.prototype, "transaction");
        expect(
            await journal.write(
                [
                    characterWrite(v3, { refused: { op: "update", text: "refused", reason: "too big" } }),
                    characterWrite(v3, { sent: sent("replacement") }, other),
                ],
                [
                    { epoch: EPOCH, scope: "record", target: CHARACTER, version: v1 },
                    { epoch: EPOCH, scope: "record", target: other, version: v1 },
                ],
            ),
        ).toEqual(["written", "written"]);
        expect(transactions.mock.calls.filter(([, mode]) => mode === "readwrite")).toHaveLength(1);
        const own = await journal.readOwn();
        expect(own.find((row) => row.target === CHARACTER)).toMatchObject({
            createdAt: T0,
            version: v3,
            layers: {
                latest: { version: v2, value: latest("newer B") },
                refused: { version: v3, value: { op: "update", text: "refused", reason: "too big" } },
            },
        });
        expect(Object.keys(own.find((row) => row.target === CHARACTER)!.layers).sort()).toEqual(["latest", "refused"]);
        expect(own.find((row) => row.target === other)).toMatchObject({
            createdAt: T0,
            layers: { sent: { version: v3, value: sent("replacement") } },
        });
        expect(Object.keys(own.find((row) => row.target === other)!.layers)).toEqual(["sent"]);
        // The combined removal also fences a delayed write, just as remove() does.
        expect(await journal.write([characterWrite(v1, { sent: sent("late A") })])).toEqual(["stale"]);
        await journal.write([], [{ epoch: EPOCH, scope: "record", target: other, version: v3 }]);
        expect((await journal.readOwn()).map((row) => row.target)).toEqual([CHARACTER]);
        await journal.close();
    });

    it("commits a conflict draft and layer removal atomically, retrying the same draft id without losing newer work", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = harness();
        const { journal } = await started(h);
        const v1 = journal.nextVersion();
        const v2 = journal.nextVersion();
        const dropped = sent(JSON.stringify({ desc: "dropped local text" }));
        const newer = latest(JSON.stringify({ desc: "surviving newer text" }));
        await journal.write([characterWrite(v1, { sent: dropped })]);
        const before = await journal.readOwn();
        const removal = { epoch: EPOCH, scope: "record" as const, target: CHARACTER, version: v1, layers: ["sent"] };
        const capture: ConflictDraft = {
            id: "conflict-id",
            epoch: EPOCH,
            scope: "record",
            target: CHARACTER,
            layers: { sent: dropped },
        };
        // Abort at the actual draft write: its paired removal and the new mutation must roll back.
        const put = IDBObjectStore.prototype.put;
        const abort = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (...args) {
            const request = put.apply(this, args);
            if (args[1] === draftKey(capture.id)) this.transaction.abort();
            return request;
        });
        expect(await journal.write([characterWrite(v2, { latest: newer })], [removal], [capture])).toEqual({
            committed: false,
            writes: ["failed"],
            drafts: ["failed"],
        });
        abort.mockRestore();
        expect(await journal.listDrafts()).toEqual([]);
        expect(await journal.readOwn()).toEqual(before);

        const transactions = vi.spyOn(IDBDatabase.prototype, "transaction");
        expect(await journal.write([characterWrite(v2, { latest: newer })], [removal], [capture])).toEqual({
            committed: true,
            writes: ["written"],
            drafts: ["written"],
        });
        expect(transactions.mock.calls.filter(([, mode]) => mode === "readwrite")).toHaveLength(1);
        const drafts = await journal.listDrafts();
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({
            id: "conflict-id",
            epoch: EPOCH,
            scope: "record",
            target: CHARACTER,
        });
        expect(
            Object.fromEntries(Object.entries(drafts[0].layers).map(([name, layer]) => [name, layer.value])),
        ).toEqual({ sent: dropped });
        expect((await rows(h.factory))[draftKey("conflict-id")]).toEqual(drafts[0]);
        expect((await journal.readOwn())[0].layers).toEqual({ latest: { version: v2, value: newer } });
        // Repeating an uncertain commit is idempotent; late cleanup cannot erase the draft or newer layer.
        expect(await journal.write([], [removal], [capture])).toEqual({
            committed: true,
            writes: [],
            drafts: ["written"],
        });
        await journal.remove([{ ...removal, layers: undefined }]);
        expect(await journal.listDrafts()).toEqual(drafts);
        expect((await journal.readOwn())[0].layers).toEqual({ latest: { version: v2, value: newer } });
        await journal.close();
    });

    it("round-trips a record entry: each layer with its own op and version, the row's version the newest, `createdAt` kept across writes, the key read back", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        expect(await tab.journal.write([characterWrite(v1, { latest: latest("one", "create") })])).toEqual(["written"]);
        h.clock.now += HOUR;
        const v2 = tab.journal.nextVersion();
        expect(
            await tab.journal.write([characterWrite(v2, { sent: sent("one", "create"), latest: latest("two") })]),
        ).toEqual(["written"]);
        const own = await tab.journal.readOwn();
        expect(own).toEqual([
            {
                key: mutationKey(EPOCH, "id-1", "record", CHARACTER),
                format: 1,
                type: "mutation",
                epoch: EPOCH,
                tabId: "id-1",
                scope: "record",
                target: CHARACTER,
                version: v2,
                createdAt: T0,
                updatedAt: T0 + HOUR,
                size: expect.any(Number),
                layers: {
                    sent: { version: v2, value: sent("one", "create") },
                    latest: { version: v2, value: latest("two") },
                },
            },
        ]);
        expect(own[0].size).toBe(
            journalValueSize({ ...own[0], key: undefined, size: 0 }) - journalValueSize({ key: undefined }) + 8,
        );
        const chatTargetKey = "cha\0chat";
        const v3 = tab.journal.nextVersion();
        expect(
            await tab.journal.write([
                {
                    epoch: EPOCH,
                    scope: "chat",
                    target: chatTargetKey,
                    version: v3,
                    layers: { pending: { ops: [], baseRevision: null, groupId: "g1" } },
                },
            ]),
        ).toEqual(["written"]);
        expect((await tab.journal.readOwn()).map((row) => row.scope)).toEqual(["chat", "record"]);
    });

    it("keeps each record layer's own op whatever the order of partial writes: a newer `latest` delete survives an older `sent` update landing after it and its later removal", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        const v2 = tab.journal.nextVersion();
        expect(await tab.journal.write([characterWrite(v2, { latest: latest(null, "delete") })])).toEqual(["written"]);
        expect(await tab.journal.write([characterWrite(v1, { sent: sent("one", "update") })])).toEqual(["written"]);
        let [row] = await tab.journal.readOwn();
        expect(row).not.toHaveProperty("op");
        expect(row.scope === "record" && row.layers.latest?.value.op).toBe("delete");
        expect(row.scope === "record" && row.layers.sent?.value.op).toBe("update");
        expect(row.version).toBe(v2);
        await tab.journal.remove([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: v1, layers: ["sent"] }]);
        [row] = await tab.journal.readOwn();
        expect(row.scope === "record" && Object.keys(row.layers)).toEqual(["latest"]);
        expect(row.scope === "record" && row.layers.latest?.value).toEqual(latest(null, "delete"));
    });

    it("drops a write at or below the stored layer's version as `stale`, removes a layer with `null` only when the stored one is older, and deletes the row when no layer is left", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        const v2 = tab.journal.nextVersion();
        const v3 = tab.journal.nextVersion();
        await tab.journal.write([characterWrite(v2, { latest: latest("two") })]);
        expect(await tab.journal.write([characterWrite(v2, { latest: latest("two again") })])).toEqual(["stale"]);
        expect(await tab.journal.write([characterWrite(v1, { latest: latest("one") })])).toEqual(["stale"]);
        expect(await tab.journal.write([characterWrite(v1, { latest: null })])).toEqual(["stale"]);
        expect((await tab.journal.readOwn())[0].scope === "record" && (await tab.journal.readOwn())[0].layers).toEqual({
            latest: { version: v2, value: latest("two") },
        });
        expect(await tab.journal.write([characterWrite(v3, { latest: null })])).toEqual(["written"]);
        expect(await tab.journal.readOwn()).toEqual([]);
        expect(await rows(h.factory)).toEqual({});
    });

    it("a late write never resurrects a removed layer: a removal fences the whole key or the named layers through its version at the call, and a newer version still lands", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        const v2 = tab.journal.nextVersion();
        const v3 = tab.journal.nextVersion();
        // The acknowledgement arrives before the journal write of the same version is called.
        const removing = tab.journal.remove([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: v1 }]);
        expect(await tab.journal.write([characterWrite(v1, { sent: sent("one"), latest: latest("one") })])).toEqual([
            "stale",
        ]);
        await removing;
        expect(await rows(h.factory)).toEqual({});
        expect(await tab.journal.write([characterWrite(v2, { latest: latest("two") })])).toEqual(["written"]);
        // A per-layer fence: `sent` through v3 is gone, `latest` at v3 lands.
        void tab.journal.remove([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: v3, layers: ["sent"] }]);
        expect(await tab.journal.write([characterWrite(v3, { sent: sent("three") })])).toEqual(["stale"]);
        expect(await tab.journal.write([characterWrite(v3, { latest: latest("three") })])).toEqual(["written"]);
        const [row] = await tab.journal.readOwn();
        expect(row.scope === "record" && row.layers).toEqual({ latest: { version: v3, value: latest("three") } });
    });

    it("a late delete never erases newer work: a removal deletes a layer only through its captured version, leaving the layers written after it", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        const v2 = tab.journal.nextVersion();
        const v3 = tab.journal.nextVersion();
        await tab.journal.write([characterWrite(v1, { sent: sent("one"), latest: latest("one") })]);
        await tab.journal.write([characterWrite(v2, { latest: latest("two") })]);
        await tab.journal.remove([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: v1 }]);
        let [row] = await tab.journal.readOwn();
        expect(row.scope === "record" && row.layers).toEqual({ latest: { version: v2, value: latest("two") } });
        expect(row.version).toBe(v2);
        // A removal of a version never stored still covers the older layer ("through").
        await tab.journal.remove([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: v3 }]);
        expect(await tab.journal.readOwn()).toEqual([]);
        // A removal for a key that holds nothing, or names a missing layer, does nothing.
        const v4 = tab.journal.nextVersion();
        await tab.journal.write([characterWrite(v4, { latest: latest("four") })]);
        await tab.journal.remove([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: v4, layers: ["sent"] }]);
        [row] = await tab.journal.readOwn();
        expect(row.scope === "record" && Object.keys(row.layers)).toEqual(["latest"]);
        expect(tab.events).toEqual([]);
    });

    it("refuses an excluded kind as `ineligible` (its older layers through that version removed, no event) and an ineligible text layer alone, keeping the entry's other layers", async () => {
        const h = harness();
        const tab = await started(h);
        const secrets = recordTarget("secrets", "secrets");
        const v1 = tab.journal.nextVersion();
        expect(
            await tab.journal.write([
                characterWrite(v1, { latest: latest(`{"googleSearchCredentials":"${SECRET}"}`) }, secrets),
            ]),
        ).toEqual(["ineligible"]);
        expect(
            await tab.journal.write([
                characterWrite(tab.journal.nextVersion(), { latest: latest(null, "delete") }, secrets),
            ]),
        ).toEqual(["ineligible"]);
        expect(await rows(h.factory)).toEqual({});
        // A character: the plain text lands; a later text with a TTS key does not, and the stored
        // older text goes with it (the journal never holds an older text than the one the tab sends).
        const plain = JSON.stringify({ name: "Alice" });
        const withKey = JSON.stringify({ name: "Alice", oaiTTSConfig: { apiKey: SECRET } });
        const v2 = tab.journal.nextVersion();
        const v3 = tab.journal.nextVersion();
        expect(await tab.journal.write([characterWrite(v2, { sent: sent(plain), latest: latest(plain) })])).toEqual([
            "written",
        ]);
        expect(await tab.journal.write([characterWrite(v3, { latest: latest(withKey) })])).toEqual(["ineligible"]);
        let [row] = await tab.journal.readOwn();
        expect(row.scope === "record" && Object.keys(row.layers)).toEqual(["sent"]);
        expect(JSON.stringify(await rows(h.factory))).not.toContain(SECRET);
        // The refused version fences its layer: the same version cannot land later.
        expect(await tab.journal.write([characterWrite(v3, { latest: latest(plain) })])).toEqual(["stale"]);
        const v4 = tab.journal.nextVersion();
        expect(await tab.journal.write([characterWrite(v4, { latest: latest(plain) })])).toEqual(["written"]);
        [row] = await tab.journal.readOwn();
        expect(row.scope === "record" && Object.keys(row.layers).sort()).toEqual(["latest", "sent"]);
        expect(tab.events).toEqual([]);
    });

    it("refuses a record target that is not `<kind>\\0<id>` (no separator, an empty kind or id, two separators) as `ineligible` and stores nothing of it", async () => {
        const h = harness();
        const tab = await started(h);
        const credential = `{"googleSearchCredentials":"${SECRET}"}`;
        for (const target of ["secrets", "\0secrets", "secrets\0", "secrets\0a\0b"]) {
            expect(
                await tab.journal.write([
                    characterWrite(tab.journal.nextVersion(), { latest: latest(credential) }, target),
                ]),
                target,
            ).toEqual(["ineligible"]);
            expect(
                await tab.journal.putDraft({
                    epoch: EPOCH,
                    scope: "record",
                    target,
                    layers: { latest: latest(credential) },
                }),
                target,
            ).toBeNull();
        }
        expect(await rows(h.factory)).toEqual({});
        expect(await tab.journal.listDrafts()).toEqual([]);
        expect(tab.events).toEqual([]);
    });

    it("skips a write at a key holding a row it cannot read and leaves a removal there alone, never overwriting or deleting the row", async () => {
        const h = harness();
        const tab = await started(h);
        const key = mutationKey(EPOCH, "id-1", "record", CHARACTER);
        const opaque = { ...UNKNOWN_FORMAT_ROW, tabId: "id-1", note: "the only copy" };
        await rawPut(h.factory, key, opaque);
        expect(await tab.journal.write([characterWrite(tab.journal.nextVersion(), { latest: latest("new") })])).toEqual(
            ["skipped"],
        );
        await tab.journal.remove([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: 99 }]);
        expect(
            await tab.journal.moveToDrafts([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: 99 }]),
        ).toEqual([null]);
        expect(await rows(h.factory)).toEqual({ [key]: opaque });
        expect(tab.events).toEqual([]);
    });

    it("drafts the writes queued before a move: a write and a move of the same version, neither awaited, leave the draft holding the text and no entry; a write after the move is stale", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        const writing = tab.journal.write([characterWrite(v1, { latest: latest("kept") })]);
        const moving = tab.journal.moveToDrafts([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: v1 }]);
        expect(await writing).toEqual(["written"]);
        expect(await moving).toEqual(["id-2"]);
        expect(await tab.journal.readOwn()).toEqual([]);
        const drafts = await tab.journal.listDrafts();
        expect(
            drafts.map((draft) => [
                draft.id,
                draft.target,
                draft.scope === "record" && draft.layers.latest?.value.text,
            ]),
        ).toEqual([["id-2", CHARACTER, "kept"]]);
        expect(drafts[0].createdAt).toBe(T0);
        expect(await tab.journal.write([characterWrite(v1, { latest: latest("kept") })])).toEqual(["stale"]);
        expect(await tab.journal.readOwn()).toEqual([]);
        // An existing older entry with the move queued behind a newer write drafts the newer text.
        const other = recordTarget("characters", "c2");
        const v2 = tab.journal.nextVersion();
        const v3 = tab.journal.nextVersion();
        await tab.journal.write([characterWrite(v2, { latest: latest("older") }, other)]);
        void tab.journal.write([characterWrite(v3, { latest: latest("newer") }, other)]);
        expect(await tab.journal.moveToDrafts([{ epoch: EPOCH, scope: "record", target: other, version: v3 }])).toEqual(
            ["id-3"],
        );
        expect(
            (await tab.journal.listDrafts()).map((d) => d.scope === "record" && d.layers.latest?.value.text),
        ).toEqual(["kept", "newer"]);
    });

    it("a move leaves an entry with a layer newer than its version (answering null), and deletes instead of drafting an entry whose stored text is no longer eligible", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        const v2 = tab.journal.nextVersion();
        await tab.journal.write([characterWrite(v1, { sent: sent("one") })]);
        await tab.journal.write([characterWrite(v2, { latest: latest("two") })]);
        expect(
            await tab.journal.moveToDrafts([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: v1 }]),
        ).toEqual([null]);
        expect((await tab.journal.readOwn()).length).toBe(1);
        expect(await tab.journal.listDrafts()).toEqual([]);
        // A row another writer stored with a credential (never through this boundary) is dropped.
        const key = mutationKey(EPOCH, "id-1", "record", CHARACTER);
        const stored = (await rows(h.factory))[key] as { layers: Record<string, { version: number; value: unknown }> };
        await rawPut(h.factory, key, {
            ...stored,
            layers: { latest: { version: v2, value: latest(JSON.stringify({ oaiTTSConfig: { apiKey: SECRET } })) } },
        });
        expect(
            await tab.journal.moveToDrafts([{ epoch: EPOCH, scope: "record", target: CHARACTER, version: v2 }]),
        ).toEqual([null]);
        expect(await rows(h.factory)).toEqual({});
        expect(await tab.journal.removeDraft("id-404")).toBeUndefined();
        expect(tab.events).toEqual([]);
    });
});

describe("budgets and expiry", () => {
    const big = (bytes: number) => "x".repeat(bytes);

    it("does not write a layer that takes the entry over its budget (`journalSkipped tooLarge`), removes its older value, fences the version, and keeps the entry's other layers", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        const v2 = tab.journal.nextVersion();
        expect(await tab.journal.write([characterWrite(v1, { sent: sent("small"), latest: latest("small") })])).toEqual(
            ["written"],
        );
        expect(await tab.journal.write([characterWrite(v2, { latest: latest(big(MAX_JOURNAL_ENTRY_BYTES)) })])).toEqual(
            ["skipped"],
        );
        expect(tab.events).toEqual([{ kind: "sync", phase: "journalSkipped", reason: "tooLarge", entries: 1 }]);
        let [row] = await tab.journal.readOwn();
        expect(row.scope === "record" && Object.keys(row.layers)).toEqual(["sent"]);
        expect(await tab.journal.write([characterWrite(v2, { latest: latest("small again") })])).toEqual(["stale"]);
        const v3 = tab.journal.nextVersion();
        expect(
            await tab.journal.write([characterWrite(v3, { latest: latest(big(MAX_JOURNAL_ENTRY_BYTES - 2048)) })]),
        ).toEqual(["written"]);
        [row] = await tab.journal.readOwn();
        expect(row.size).toBeLessThanOrEqual(MAX_JOURNAL_ENTRY_BYTES);
        expect(
            await tab.journal.putDraft({
                epoch: EPOCH,
                scope: "record",
                target: CHARACTER,
                layers: { latest: latest(big(MAX_JOURNAL_ENTRY_BYTES)) },
            }),
        ).toBeNull();
        expect(tab.events).toHaveLength(2);
    });

    it("evicts recovery drafts (any age) and expired composer drafts, oldest first, for a mutation write over the total budget; never a mutation entry, an unexpired composer draft, or an unreadable row; still over: `journalSkipped budget`", async () => {
        const h = harness();
        const tab = await started(h);
        // Eight such rows fill the total budget.
        const draftBytes = MAX_JOURNAL_TOTAL_BYTES / 8 - 1024;
        const ids: string[] = [];
        for (let i = 0; i < 7; i++) {
            h.clock.now = T0 + i * HOUR;
            const id = await tab.journal.putDraft({
                epoch: EPOCH,
                scope: "record",
                target: recordTarget("characters", `d${i}`),
                layers: { latest: latest(big(draftBytes)) },
            });
            expect(id).not.toBeNull();
            ids.push(id!);
        }
        const composer = (key: string, createdAt: number) => ({
            format: 1,
            type: "composer",
            chatKey: key,
            createdAt,
            updatedAt: createdAt,
            size: draftBytes,
            value: { input: big(draftBytes), translate: "", files: [] },
        });
        await rawPut(h.factory, "composer\0old", composer("old", T0 - 49 * HOUR));
        await rawPut(h.factory, "composer\0live", composer("live", T0));
        await rawPut(h.factory, "opaque", { ...UNKNOWN_FORMAT_ROW, size: draftBytes });
        h.clock.now = T0 + 8 * HOUR;
        // 7 drafts + 2 composers + 1 opaque, each just under an eighth of the total: over it by a quarter. A small
        // mutation evicts the expired composer first (oldest), then drafts d0..., until it fits.
        const v1 = tab.journal.nextVersion();
        expect(await tab.journal.write([characterWrite(v1, { latest: latest("small") })])).toEqual(["written"]);
        let keys = Object.keys(await rows(h.factory));
        expect(keys).not.toContain("composer\0old");
        expect(keys).toContain("composer\0live");
        expect(keys).toContain("opaque");
        expect(keys).not.toContain(draftKey(ids[0]));
        expect(keys).toContain(draftKey(ids[6]));
        const remaining = (await tab.journal.listDrafts()).map((d) => d.id);
        expect(remaining).toEqual(ids.slice(ids.length - remaining.length));
        // A write that cannot fit even after evicting everything evictable is skipped, its older
        // layer removed; nothing else is evicted for it.
        const v2 = tab.journal.nextVersion();
        const before = Object.keys(await rows(h.factory)).sort();
        expect(
            await tab.journal.write([
                characterWrite(
                    v2,
                    { latest: latest(big(MAX_JOURNAL_ENTRY_BYTES - 300)) },
                    recordTarget("characters", "huge"),
                ),
            ]),
        ).toEqual(["written"]);
        const stillOver = Object.keys(await rows(h.factory)).sort();
        expect(stillOver.length).toBeLessThan(before.length + 1);
        // Fill with mutation rows (never evicted) until a further one no longer fits.
        let outcome = "written";
        let n = 0;
        while (outcome === "written" && n < 12) {
            outcome = (
                await tab.journal.write([
                    characterWrite(
                        tab.journal.nextVersion(),
                        { latest: latest(big(MAX_JOURNAL_ENTRY_BYTES - 300)) },
                        recordTarget("characters", `m${n++}`),
                    ),
                ])
            )[0];
        }
        expect(outcome).toBe("skipped");
        expect(tab.events.at(-1)).toEqual({ kind: "sync", phase: "journalSkipped", reason: "budget", entries: 1 });
        keys = Object.keys(await rows(h.factory));
        expect(keys).toContain("composer\0live");
        expect(keys).toContain("opaque");
        expect(keys.filter((k) => k.startsWith("draft\0"))).toEqual([]);
        expect(await tab.journal.listDrafts()).toEqual([]);
    });

    it("stores a draft when it fits, reclaims expired drafts and expired composer drafts for it, but never evicts a live draft (`journalSkipped budget`)", async () => {
        const h = harness();
        const tab = await started(h);
        // Eight such drafts fill the total budget.
        const draftBytes = MAX_JOURNAL_TOTAL_BYTES / 8 - 512;
        for (let i = 0; i < 8; i++) {
            h.clock.now = T0 + i;
            expect(
                await tab.journal.putDraft({
                    epoch: EPOCH,
                    scope: "record",
                    target: recordTarget("characters", `d${i}`),
                    layers: { latest: latest(big(draftBytes)) },
                }),
            ).toBe(`id-${i + 2}`);
        }
        expect((await tab.journal.listDrafts()).length).toBe(8);
        // Full of live drafts (a few KiB short of the budget): a 16 KiB one is refused, none evicted.
        const ninth = {
            epoch: EPOCH,
            scope: "record" as const,
            target: recordTarget("characters", "ninth"),
            layers: { latest: latest(big(16 * 1024)) },
        };
        expect(await tab.journal.putDraft(ninth)).toBeNull();
        expect(tab.events).toEqual([{ kind: "sync", phase: "journalSkipped", reason: "budget", entries: 1 }]);
        expect((await tab.journal.listDrafts()).length).toBe(8);
        // All expired: a new draft reclaims the oldest expired ones it needs (not every one).
        h.clock.now = T0 + 7 + JOURNAL_ENTRY_TTL_MS;
        expect(await tab.journal.listDrafts()).toEqual([]);
        expect(await tab.journal.putDraft(ninth)).toBe("id-11");
        const keys = Object.keys(await rows(h.factory));
        expect(keys).toContain(draftKey("id-11"));
        expect(keys).not.toContain(draftKey("id-2"));
        expect(keys).toContain(draftKey("id-9"));
        expect(tab.events).toHaveLength(1);
    });

    it("counts only finite, non-negative sizes toward the total: an unreadable row with `size` Infinity or negative neither blocks a write nor is touched", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        await tab.journal.write([characterWrite(v1, { latest: latest("A") })]);
        await rawPut(h.factory, "infinite", { format: 7, size: Infinity, createdAt: T0 });
        await rawPut(h.factory, "negative", { format: 7, size: -(MAX_JOURNAL_TOTAL_BYTES * 2), createdAt: T0 });
        const v2 = tab.journal.nextVersion();
        expect(await tab.journal.write([characterWrite(v2, { latest: latest("B") })])).toEqual(["written"]);
        const [row] = await tab.journal.readOwn();
        expect(row.scope === "record" && row.layers.latest?.value.text).toBe("B");
        const all = await rows(h.factory);
        expect(all.infinite).toEqual({ format: 7, size: Infinity, createdAt: T0 });
        expect(all.negative).toMatchObject({ format: 7 });
        expect(tab.events).toEqual([]);
        // A negative total would let a write over the budget through: it does not.
        const v3 = tab.journal.nextVersion();
        const results: string[] = [];
        for (let i = 0; i < 9; i++) {
            results.push(
                (
                    await tab.journal.write([
                        characterWrite(
                            v3 + i,
                            { latest: latest(big(MAX_JOURNAL_ENTRY_BYTES - 300)) },
                            recordTarget("characters", `m${i}`),
                        ),
                    ])
                )[0],
            );
            tab.journal.nextVersion();
        }
        expect(results).toContain("skipped");
    });

    it("leaves expired entries out of readOwn and listDrafts; purgeExpired deletes this tab's expired entries, expired drafts, and expired composer drafts, not another tab's rows or unreadable rows", async () => {
        const h = harness();
        const tab = await started(h);
        await tab.journal.write([characterWrite(tab.journal.nextVersion(), { latest: latest("old") })]);
        expect(
            await tab.journal.putDraft({
                epoch: EPOCH,
                scope: "record",
                target: recordTarget("characters", "d"),
                layers: { latest: latest("old draft") },
            }),
        ).toBe("id-2");
        await rawPut(h.factory, "composer\0k", {
            format: 1,
            type: "composer",
            chatKey: "k",
            createdAt: T0,
            updatedAt: T0,
            size: 1,
            value: { input: "", translate: "", files: [] },
        });
        await rawPut(h.factory, "other", {
            format: 1,
            type: "mutation",
            epoch: EPOCH,
            tabId: "other",
            target: CHARACTER,
            scope: "record",
            version: 1,
            createdAt: T0,
            updatedAt: T0,
            size: 1,
            layers: {},
        });
        await rawPut(h.factory, "opaque", UNKNOWN_FORMAT_ROW);
        h.clock.now = T0 + JOURNAL_ENTRY_TTL_MS - 1;
        expect((await tab.journal.readOwn()).length).toBe(1);
        expect((await tab.journal.listDrafts()).length).toBe(1);
        expect(await tab.journal.purgeExpired()).toBe(0);
        h.clock.now = T0 + JOURNAL_ENTRY_TTL_MS;
        await tab.journal.write([
            characterWrite(tab.journal.nextVersion(), { latest: latest("fresh") }, recordTarget("characters", "fresh")),
        ]);
        expect((await tab.journal.readOwn()).map((row) => row.target)).toEqual([recordTarget("characters", "fresh")]);
        expect(await tab.journal.listDrafts()).toEqual([]);
        expect(await tab.journal.purgeExpired()).toBe(3);
        expect(Object.keys(await rows(h.factory)).sort()).toEqual(
            [mutationKey(EPOCH, "id-1", "record", recordTarget("characters", "fresh")), "opaque", "other"].sort(),
        );
        expect(tab.events).toEqual([]);
    });

    it("a purge fences the expired entries it deletes through the versions issued before it: a delayed write of such a version is stale and does not renew the entry; a new version makes a new entry", async () => {
        const h = harness();
        const tab = await started(h);
        const v1 = tab.journal.nextVersion();
        const item = characterWrite(v1, { latest: latest("expired intent") });
        await tab.journal.write([item]);
        h.clock.now = T0 + JOURNAL_ENTRY_TTL_MS;
        const v2 = tab.journal.nextVersion();
        const purging = tab.journal.purgeExpired();
        const delayed = tab.journal.write([item]);
        expect(await purging).toBe(1);
        expect(await delayed).toEqual(["stale"]);
        expect(await tab.journal.write([characterWrite(v2, { latest: latest("still delayed") })])).toEqual(["stale"]);
        expect(await tab.journal.readOwn()).toEqual([]);
        expect(await rows(h.factory)).toEqual({});
        const v3 = tab.journal.nextVersion();
        expect(await tab.journal.write([characterWrite(v3, { latest: latest("new intent") })])).toEqual(["written"]);
        expect((await tab.journal.readOwn()).map((row) => row.createdAt)).toEqual([T0 + JOURNAL_ENTRY_TTL_MS]);
    });
});

describe("adopting orphans", () => {
    async function deadOwner(h: Harness, texts: string[] = ["a", "b"]): Promise<Tab> {
        const dead = await started(h);
        for (const [i, text] of texts.entries()) {
            await dead.journal.write([
                characterWrite(
                    dead.journal.nextVersion(),
                    { latest: latest(text) },
                    recordTarget("characters", `c${i}`),
                ),
            ]);
        }
        await dead.journal.close();
        return dead;
    }

    it("takes a closed tab's rows once, re-keyed to this tab with fresh versions and their `createdAt`, reporting `journalRecovered orphan`; a second pass and a reload of the dead id find nothing", async () => {
        const h = harness();
        const dead = await deadOwner(h);
        h.clock.now = T0 + HOUR;
        const tab = await started(h);
        expect(tab.journal.tabId).toBe("id-2");
        expect(await tab.journal.adoptOrphans()).toBe(2);
        expect(tab.events).toEqual([{ kind: "sync", phase: "journalRecovered", reason: "orphan", entries: 2 }]);
        expect(h.locks.held()).toEqual([ownerLockName("id-2")]);
        const own = await tab.journal.readOwn();
        expect(
            own.map((row) => [
                row.tabId,
                row.target,
                row.createdAt,
                row.scope === "record" && row.layers.latest?.value.text,
            ]),
        ).toEqual([
            ["id-2", recordTarget("characters", "c0"), T0, "a"],
            ["id-2", recordTarget("characters", "c1"), T0, "b"],
        ]);
        expect(
            own.every((row) => row.version > 0 && row.scope === "record" && row.layers.latest?.version === row.version),
        ).toBe(true);
        expect(tab.journal.nextVersion()).toBeGreaterThan(Math.max(...own.map((row) => row.version)));
        expect(await tab.journal.adoptOrphans()).toBe(0);
        expect(tab.events).toHaveLength(1);
        const reloaded = page(h, { storage: () => dead.storage });
        expect(await reloaded.journal.start()).toBe(true);
        expect(reloaded.journal.tabId).toBe("id-1");
        expect(await reloaded.journal.readOwn()).toEqual([]);
        expect(await reloaded.journal.adoptOrphans()).toBe(0);
    });

    it("leaves a live owner's rows alone (its lock refused), including a hidden tab that never wrote again", async () => {
        const h = harness();
        const live = await started(h);
        await live.journal.write([characterWrite(live.journal.nextVersion(), { latest: latest("live") })]);
        const tab = await started(h);
        expect(await tab.journal.adoptOrphans()).toBe(0);
        expect(tab.events).toEqual([]);
        expect((await live.journal.readOwn()).length).toBe(1);
        expect(await tab.journal.readOwn()).toEqual([]);
        expect(h.locks.held().sort()).toEqual([ownerLockName("id-1"), ownerLockName("id-2")]);
    });

    it("the original owner reloading while another tab recovers: the rows end up in exactly one tab, and the reloading page refused its id mints a new one", async () => {
        const h = harness();
        const dead = await deadOwner(h);
        const recoverer = await started(h);
        const transferring = h.locks.whenHeld(ownerLockName("id-1"));
        const adopting = recoverer.journal.adoptOrphans();
        // The transfer holds the dead id's owner lock; the reload arrives then and is refused.
        await transferring;
        expect(h.locks.held()).toContain(ownerLockName("id-1"));
        const reloaded = page(h, { storage: () => dead.storage });
        const restarting = reloaded.journal.start();
        expect(await adopting).toBe(2);
        expect(await restarting).toBe(true);
        expect(reloaded.journal.tabId).toBe("id-3");
        expect(await reloaded.journal.readOwn()).toEqual([]);
        expect((await recoverer.journal.readOwn()).length).toBe(2);
        expect(h.locks.held().sort()).toEqual([ownerLockName("id-2"), ownerLockName("id-3")]);

        // The other order: the reload claims its lock first, and the recoverer leaves the rows.
        const h2 = harness();
        const dead2 = await deadOwner(h2);
        const reloaded2 = page(h2, { storage: () => dead2.storage });
        const restarting2 = reloaded2.journal.start();
        const recoverer2 = await started(h2);
        expect(await restarting2).toBe(true);
        expect(await recoverer2.journal.adoptOrphans()).toBe(0);
        expect((await reloaded2.journal.readOwn()).length).toBe(2);
        expect(await recoverer2.journal.readOwn()).toEqual([]);
    });

    it("sequential recoverers: two tabs adopting at once serialize on the recover lock and the rows are taken by exactly one, reported once", async () => {
        const h = harness();
        await deadOwner(h, ["a", "b", "c"]);
        const first = await started(h);
        const second = await started(h);
        const [a, b] = await Promise.all([first.journal.adoptOrphans(), second.journal.adoptOrphans()]);
        expect([a, b].sort()).toEqual([0, 3]);
        expect([...first.events, ...second.events]).toEqual([
            { kind: "sync", phase: "journalRecovered", reason: "orphan", entries: 3 },
        ]);
        const [ownA, ownB] = [await first.journal.readOwn(), await second.journal.readOwn()];
        expect(ownA.length + ownB.length).toBe(3);
        expect(h.locks.requests.filter((r) => r.name === JOURNAL_RECOVER_LOCK)).toHaveLength(2);
        expect(h.locks.held().sort()).toEqual([ownerLockName("id-2"), ownerLockName("id-3")]);
    });

    it("an orphan colliding with an entry this tab already holds becomes a recovery draft keeping its `createdAt`, never overwriting this tab's entry, and counts as taken", async () => {
        const h = harness();
        await deadOwner(h, ["dead's text"]);
        h.clock.now = T0 + HOUR;
        const tab = await started(h);
        await tab.journal.write([
            characterWrite(tab.journal.nextVersion(), { latest: latest("mine") }, recordTarget("characters", "c0")),
        ]);
        await rawPut(
            h.factory,
            mutationKey(EPOCH, "id-2", "record", recordTarget("characters", "c9")),
            UNKNOWN_FORMAT_ROW,
        );
        await rawPut(h.factory, mutationKey(EPOCH, "id-1", "record", recordTarget("characters", "c9")), {
            format: 1,
            type: "mutation",
            epoch: EPOCH,
            tabId: "id-1",
            target: recordTarget("characters", "c9"),
            scope: "record",
            version: 1,
            createdAt: T0,
            updatedAt: T0,
            size: 1,
            layers: { latest: { version: 1, value: latest("behind an unreadable row") } },
        });
        expect(await tab.journal.adoptOrphans()).toBe(2);
        expect(
            (await tab.journal.readOwn()).map((row) => [
                row.target,
                row.scope === "record" && row.layers.latest?.value.text,
            ]),
        ).toEqual([[recordTarget("characters", "c0"), "mine"]]);
        const drafts = await tab.journal.listDrafts();
        expect(
            drafts
                .map((d) => [d.target, d.createdAt, d.epoch, d.scope === "record" && d.layers.latest?.value.text])
                .sort(),
        ).toEqual([
            [recordTarget("characters", "c0"), T0, EPOCH, "dead's text"],
            [recordTarget("characters", "c9"), T0, EPOCH, "behind an unreadable row"],
        ]);
        expect(Object.keys(await rows(h.factory)).filter((k) => k.includes("\0id-1\0"))).toEqual([]);
        expect(tab.events).toEqual([{ kind: "sync", phase: "journalRecovered", reason: "orphan", entries: 2 }]);
    });

    it("deletes a dead tab's expired rows and rows holding a credential instead of adopting them, and leaves its unreadable rows where they are", async () => {
        const h = harness();
        const dead = await deadOwner(h, ["expired"]);
        void dead;
        await rawPut(h.factory, mutationKey(EPOCH, "id-1", "record", recordTarget("characters", "k")), {
            format: 1,
            type: "mutation",
            epoch: EPOCH,
            tabId: "id-1",
            target: recordTarget("characters", "k"),
            scope: "record",
            version: 2,
            createdAt: T0 + HOUR,
            updatedAt: T0 + HOUR,
            size: 1,
            layers: { latest: { version: 2, value: latest(JSON.stringify({ oaiTTSConfig: { apiKey: SECRET } })) } },
        });
        await rawPut(h.factory, "unreadable-of-id-1", { ...UNKNOWN_FORMAT_ROW, tabId: "id-1" });
        h.clock.now = T0 + JOURNAL_ENTRY_TTL_MS;
        const tab = await started(h);
        expect(tab.events).toEqual([{ kind: "sync", phase: "journalSkipped", reason: "format", entries: 1 }]);
        expect(await tab.journal.adoptOrphans()).toBe(0);
        expect(tab.events).toHaveLength(1);
        expect(await tab.journal.readOwn()).toEqual([]);
        expect(Object.keys(await rows(h.factory))).toEqual(["unreadable-of-id-1"]);
        expect(JSON.stringify(await rows(h.factory))).not.toContain(SECRET);
    });

    it("a recover lock another holder keeps makes adoption skip at the bound as `journalFailed timeout`, taking nothing, and the request is withdrawn", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = harness();
        const dead = page(h);
        expect(await drive(dead.journal.start(), 50)).toBe(true);
        expect(
            await drive(dead.journal.write([characterWrite(dead.journal.nextVersion(), { latest: latest("a") })]), 50),
        ).toEqual(["written"]);
        expect(await drive(dead.journal.close(), 50)).toBeUndefined();
        let releaseHolder!: () => void;
        void h.locks.request(JOURNAL_RECOVER_LOCK, () => new Promise<void>((resolve) => (releaseHolder = resolve)));
        await vi.advanceTimersByTimeAsync(0);
        const tab = page(h, { recoverTimeoutMs: 100 });
        expect(await drive(tab.journal.start(), 50)).toBe(true);
        const adopting = tab.journal.adoptOrphans();
        expect(await drive(adopting, 99)).toBe(PENDING);
        expect(h.locks.waiting()).toEqual([JOURNAL_RECOVER_LOCK]);
        expect(await drive(adopting, 1)).toBe(0);
        expect(h.locks.waiting()).toEqual([]);
        expect(tab.events).toEqual([{ kind: "sync", phase: "journalFailed", reason: "timeout" }]);
        releaseHolder();
        expect(await drive(tab.journal.adoptOrphans(), 50)).toBe(1);
    });
});

// Recovery owns prior-page chat/order rows, including after orphan adoption; record rows stay writable.
describe("chat and order rows reserved for recovery", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    it.each(["reload", "orphan adoption"] as const)(
        "preserves previous chat and order layers through new-page writes and removals after %s",
        async (arrival) => {
            const h = harness();
            const old = await started(h);
            const chatKey = chatTarget("c1", "chat");
            const orderKey = orderTarget("c1");
            await old.journal.write([
                {
                    epoch: EPOCH,
                    scope: "chat",
                    target: chatKey,
                    version: old.journal.nextVersion(),
                    layers: {
                        resend: {
                            groupId: "old-sent",
                            baseRevision: "r1",
                            seq: 1,
                            inDoubt: true,
                            ops: [{ op: "setText", id: "m", text: "sent" }],
                        },
                        pending: {
                            groupId: "old-pending",
                            baseRevision: "r1",
                            ops: [{ op: { op: "setText", id: "m", text: "pending" }, before: { value: "sent" } }],
                        },
                    },
                },
                {
                    epoch: EPOCH,
                    scope: "order",
                    target: orderKey,
                    version: old.journal.nextVersion(),
                    layers: {
                        sent: { baseRevision: "o1", ids: ["chat", "other"] },
                        latest: { baseRevision: "o1", ids: ["other", "chat"] },
                    },
                },
                characterWrite(old.journal.nextVersion(), { latest: latest("old record") }),
            ]);
            const original = await old.journal.readOwn();
            await old.journal.close();
            const next = await started(h, arrival === "reload" ? { storage: () => old.storage } : {});
            if (arrival === "orphan adoption") expect(await next.journal.adoptOrphans()).toBe(3);
            else expect(next.journal.tabId).toBe(old.journal.tabId);
            const reserved = (await next.journal.readOwn()).filter((row) => row.scope !== "record");
            expect(
                reserved.map((row) => [
                    row.scope,
                    row.target,
                    Object.fromEntries(Object.entries(row.layers).map(([key, layer]) => [key, layer.value])),
                ]),
            ).toEqual(
                original
                    .filter((row) => row.scope !== "record")
                    .map((row) => [
                        row.scope,
                        row.target,
                        Object.fromEntries(Object.entries(row.layers).map(([key, layer]) => [key, layer.value])),
                    ]),
            );
            expect(
                await next.journal.write([
                    {
                        epoch: EPOCH,
                        scope: "chat",
                        target: chatKey,
                        version: next.journal.nextVersion(),
                        layers: {
                            resend: null,
                            pending: {
                                groupId: "new-page",
                                baseRevision: "r2",
                                ops: [
                                    { op: { op: "setText", id: "m", text: "new page" }, before: { value: "server" } },
                                ],
                            },
                            refused: { ops: [], create: false, delete: true, reason: "new page" },
                        },
                    },
                    {
                        epoch: EPOCH,
                        scope: "order",
                        target: orderKey,
                        version: next.journal.nextVersion(),
                        layers: {
                            sent: null,
                            latest: { baseRevision: "o2", ids: ["chat", "other"] },
                            refused: { ids: [], reason: "new page" },
                        },
                    },
                    characterWrite(next.journal.nextVersion(), { latest: latest("new record") }),
                ]),
            ).toEqual(["skipped", "skipped", "written"]);
            expect((await next.journal.readOwn()).filter((row) => row.scope !== "record")).toEqual(reserved);
            const record = (await next.journal.readOwn()).find((row) => row.scope === "record");
            expect(record?.scope === "record" && record.layers.latest?.value).toEqual(latest("new record"));
            await next.journal.remove([
                { epoch: EPOCH, scope: "chat", target: chatKey, version: next.journal.nextVersion() },
                { epoch: EPOCH, scope: "order", target: orderKey, version: next.journal.nextVersion() },
                { epoch: EPOCH, scope: "record", target: CHARACTER, version: next.journal.nextVersion() },
            ]);
            expect(await next.journal.readOwn()).toEqual(reserved);
            await next.journal.close();
        },
    );
});

describe("partial recovery hand-over", () => {
    it("drafts only pending chat work, releases the stored resend and order versions, and permits later writes", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = harness();
        const old = await started(h);
        const chatAddress = { epoch: EPOCH, scope: "chat" as const, target: chatTarget("c1", "chat") };
        const orderAddress = { epoch: EPOCH, scope: "order" as const, target: orderTarget("c1") };
        const resend = {
            groupId: "sent-group",
            baseRevision: "r1",
            seq: 1,
            inDoubt: true,
            ops: [{ op: "setText" as const, id: "m", text: "sent" }],
        };
        const pending = {
            groupId: "pending-group",
            baseRevision: "r1",
            ops: [{ op: { op: "setText" as const, id: "m", text: "newer" }, before: { value: "sent" } }],
        };
        await old.journal.write([
            { ...chatAddress, version: old.journal.nextVersion(), layers: { resend, pending } },
            {
                ...orderAddress,
                version: old.journal.nextVersion(),
                layers: { latest: { baseRevision: "o1", ids: ["chat"] } },
            },
        ]);
        const original = await old.journal.readOwn();
        const chat = original.find((row) => row.scope === "chat")!;
        const order = original.find((row) => row.scope === "order")!;
        await old.journal.close();
        const next = await started(h, { storage: () => old.storage });
        try {
            const [id] = await next.journal.moveToDrafts([
                { ...chatAddress, version: chat.version, layers: ["pending"] },
            ]);
            expect(id).toEqual(expect.any(String));
            expect(await next.journal.listDrafts()).toMatchObject([
                {
                    id,
                    scope: "chat",
                    target: chat.target,
                    createdAt: chat.createdAt,
                    layers: { pending: chat.layers.pending },
                },
            ]);
            expect((await next.journal.listDrafts())[0].layers).toEqual({ pending: chat.layers.pending });
            expect((await next.journal.readOwn()).find((row) => row.scope === "chat")!.layers).toEqual({
                resend: chat.layers.resend,
            });
            // The surviving resend stays protected until the recovery queue adopts it.
            await next.journal.remove([{ ...chatAddress, version: next.journal.nextVersion() }]);
            expect((await next.journal.readOwn()).find((row) => row.scope === "chat")).toBeDefined();
            expect(await next.journal.release([chatAddress, orderAddress])).toEqual([
                { resend: chat.layers.resend },
                order.layers,
            ]);
            await next.journal.remove([{ ...orderAddress, version: order.version }]);
            const version = next.journal.nextVersion();
            expect(
                await next.journal.write([
                    {
                        ...chatAddress,
                        version,
                        layers: {
                            resend: null,
                            pending: { ...pending, baseRevision: "r2", groupId: "new-page-group" },
                        },
                    },
                ]),
            ).toEqual(["written"]);
            // An old acknowledgement cannot erase the new page's pending layer.
            await next.journal.remove([{ ...chatAddress, version: chat.version }]);
            expect(await next.journal.readOwn()).toMatchObject([
                {
                    scope: "chat",
                    createdAt: chat.createdAt,
                    layers: { pending: { version, value: { groupId: "new-page-group", baseRevision: "r2" } } },
                },
            ]);
            expect(await next.journal.readOwn()).toHaveLength(1);
            await next.journal.remove([{ ...chatAddress, version }]);
            expect(await next.journal.readOwn()).toEqual([]);
        } finally {
            await next.journal.close();
        }
    });
});
