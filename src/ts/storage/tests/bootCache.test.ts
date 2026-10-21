// @vitest-environment node
import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticEventInput } from "../../../../shared/diagnostics.ts";
import {
    BOOT_RESOURCE_FORMAT,
    RESOURCE_KIND,
    type ResourceBootRequest,
    type ResourceReadKindsResult,
} from "../../../../shared/resources.ts";
import {
    BOOT_CACHE_FORMAT,
    BootCacheMiss,
    type BootCacheContents,
    type BootCacheStore,
    type BootCacheWrite,
    type CachedRecord,
    bootCacheWrite,
    checkCacheMeta,
    checkCachedRecord,
    clearBootCache,
    expandBootAnswer,
    holdsCredential,
    indexedDbBootCacheStore,
    itemKey,
    loadBootSnapshot,
    MAX_BOOT_CLAIMS,
    prepareBootRequest,
    recordKey,
    scheduleBootCacheCommit,
    whenBootCacheSettled,
} from "../bootCache";

// The boot cache: the pure parts (entry checks, the request, the expansion against the advertised
// claims, the write diff) and the whole boot (`loadBootSnapshot`) over the real IndexedDB adapter
// on `fake-indexeddb`, with a fake server that answers the boot contract from a state (`cached`,
// `items` by hash, whole). Covered: the equivalence with the full read, the fallback paths (each
// one plain read, the unusable answer's immediate fenced clear), the generation fences (another
// tab's write, and the `null` expectation after a clear), GC, an `appVer` change, the open timeout,
// a late connection, a newer database, the operation reporting, and the idle scheduler. The server
// equivalence over the real route is `bootCacheServer.test.ts`.

const DB_NAME = "risu-boot-cache";
const APP = "v1";
const ALL_KINDS = Object.values(RESOURCE_KIND) as string[];
const hashOf = (item: unknown) => createHash("sha256").update(JSON.stringify(item)).digest("base64url").slice(0, 22);
const marks = () => performance.getEntriesByType("mark").map((entry) => entry.name);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Rec = { id: string; revision: string; data: unknown };
type State = { epoch: string; kinds: Record<string, Rec[]>; chatSummaries: unknown[]; chatOrders: unknown[] };

/** A server state answering the boot contract and the plain read, as the route does from one committed state. */
function fakeServer(initial: Partial<State> = {}) {
    const state: State = {
        epoch: "e1",
        kinds: {},
        chatSummaries: [{ chatId: "chat-1", characterId: "c1", name: "Chat 1" }],
        chatOrders: [{ characterId: "c1", revision: "e1:1:1", order: ["chat-1"] }],
        ...initial,
    };
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    let seq = 1;
    const server = {
        state,
        set(kind: string, id: string, data: unknown) {
            const list = (state.kinds[kind] ??= []);
            const revision = `${state.epoch}:${seq}:${++seq}`;
            const index = list.findIndex((record) => record.id === id);
            if (index >= 0) {
                list[index] = { id, revision, data };
            } else {
                list.push({ id, revision, data });
            }
        },
        remove(kind: string, id: string) {
            state.kinds[kind] = (state.kinds[kind] ?? []).filter((record) => record.id !== id);
        },
        /** The plain read: every requested kind (`[]` when none), the summaries and orders. */
        full(): ResourceReadKindsResult {
            const kinds: Record<string, Rec[]> = {};
            for (const kind of ALL_KINDS) {
                kinds[kind] = clone(state.kinds[kind] ?? []);
            }
            return {
                epoch: state.epoch,
                kinds,
                chatSummaries: clone(state.chatSummaries),
                chatOrders: clone(state.chatOrders),
            } as ResourceReadKindsResult;
        },
        /** The boot answer for `request`, as `server/src/routes/resourceBoot.ts` builds it. */
        answer(request: ResourceBootRequest): unknown {
            const claimed = new Map<string, string | null>();
            for (const entry of request.known?.records ?? []) {
                const key = recordKey(entry.kind, entry.id);
                const previous = claimed.get(key);
                claimed.set(key, previous === undefined || previous === entry.revision ? entry.revision : null);
            }
            const known = new Map<string, Set<string>>();
            for (const entry of request.known?.items ?? []) {
                const set = known.get(entry.kind) ?? new Set<string>();
                for (const hash of entry.hashes) {
                    set.add(hash);
                }
                known.set(entry.kind, set);
            }
            const kinds: Record<string, unknown[]> = {};
            for (const kind of request.kinds) {
                const cached = kind === "characters" || kind === "modules" || kind === "presets";
                const itemKind = kind === "modules" || kind === "presets";
                kinds[kind] = clone(state.kinds[kind] ?? []).map((record) => {
                    if (!cached) {
                        return record;
                    }
                    if (claimed.get(recordKey(kind, record.id)) === record.revision) {
                        return { id: record.id, revision: record.revision, cached: true };
                    }
                    if (itemKind && Array.isArray(record.data)) {
                        const hashes = known.get(kind);
                        return {
                            id: record.id,
                            revision: record.revision,
                            items: record.data.map((item) => {
                                const hash = hashOf(item);
                                return hashes?.has(hash) ? { hash } : { hash, data: item };
                            }),
                        };
                    }
                    return record;
                });
            }
            return {
                format: BOOT_RESOURCE_FORMAT,
                epoch: state.epoch,
                kinds,
                ...(request.chatSummaries
                    ? { chatSummaries: clone(state.chatSummaries), chatOrders: clone(state.chatOrders) }
                    : {}),
            };
        },
    };
    return server;
}

const character = (id: string, extra: Record<string, unknown> = {}) => ({ chaId: id, name: `name ${id}`, ...extra });
const module = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `module ${id}`, ...extra });

/** A populated server: two characters (one with a TTS key), a module list with a repeated item, presets. */
function seededServer() {
    const server = fakeServer();
    server.set("characters", "c1", character("c1"));
    server.set("characters", "c2", character("c2", { oaiTTSConfig: { apiKey: "secret" } }));
    server.set("modules", "main", [module("m1"), module("m2"), module("m1")]);
    server.set("presets", "main", [{ id: "p1", name: "preset" }]);
    server.set("ui", "main", { theme: "dark" });
    return server;
}

/** The three stores of the fake database, raw. */
async function dump() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            for (const name of ["records", "items", "meta"]) {
                if (!request.result.objectStoreNames.contains(name)) {
                    request.result.createObjectStore(name);
                }
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(["records", "items", "meta"], "readonly");
    const all = async (name: string) => {
        const store = tx.objectStore(name);
        const [keys, values] = await Promise.all([
            new Promise<IDBValidKey[]>((resolve) => {
                const request = store.getAllKeys();
                request.onsuccess = () => resolve(request.result);
            }),
            new Promise<unknown[]>((resolve) => {
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result);
            }),
        ]);
        return new Map(keys.map((key, index) => [key as string, values[index]]));
    };
    const [records, items, meta] = await Promise.all([all("records"), all("items"), all("meta")]);
    await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
    db.close();
    return {
        records,
        items,
        meta: (meta.get("meta") ?? null) as { format: number; appVer: string; generation: string } | null,
    };
}

/** Writes raw entries into the fake database (a corrupt or foreign cache). */
async function seedRaw(entries: { records?: [string, unknown][]; items?: [string, unknown][]; meta?: unknown }) {
    const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            for (const name of ["records", "items", "meta"]) {
                if (!request.result.objectStoreNames.contains(name)) {
                    request.result.createObjectStore(name);
                }
            }
        };
        request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction(["records", "items", "meta"], "readwrite");
    for (const [key, value] of entries.records ?? []) {
        tx.objectStore("records").put(value, key);
    }
    for (const [key, value] of entries.items ?? []) {
        tx.objectStore("items").put(value, key);
    }
    if (entries.meta !== undefined) {
        tx.objectStore("meta").put(entries.meta, "meta");
    }
    await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
    db.close();
}

type Deps = Parameters<typeof loadBootSnapshot>[0] & {
    events: DiagnosticEventInput[];
    requests: ResourceBootRequest[];
    fullReads: number;
};

/** The deps of one boot over `store` against `server`; `readBoot`/`readKinds` can be replaced per boot. */
function depsFor(server: ReturnType<typeof fakeServer>, store: BootCacheStore, appVer = APP): Deps {
    const deps: Deps = {
        store,
        appVer,
        events: [],
        requests: [],
        fullReads: 0,
        readBoot: async (request) => {
            deps.requests.push(request);
            return server.answer(request);
        },
        readKinds: async () => {
            deps.fullReads += 1;
            return server.full();
        },
        report: (event) => deps.events.push(event),
    };
    return deps;
}

const fallbacks = (deps: Deps) => deps.events.filter((event) => event.phase === "fallback");

beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    performance.clearMarks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("cache entries checked at runtime", () => {
    const REVISION = "e1:1:1";
    const HASH = "A".repeat(22);

    it("accepts a text record of a cached kind and a hash record of an item kind, nothing else", () => {
        expect(checkCachedRecord({ kind: "characters", id: "c1", revision: REVISION, text: "{}" })).toEqual({
            kind: "characters",
            id: "c1",
            revision: REVISION,
            text: "{}",
        });
        const hashes = { kind: "modules", id: "main", revision: REVISION, hashes: [HASH, HASH] };
        const checked = checkCachedRecord(hashes);
        expect(checked).toEqual(hashes);
        expect(checked?.hashes).not.toBe(hashes.hashes);
        expect(checkCachedRecord({ kind: "modules", id: "main", revision: REVISION, hashes: [] })).toEqual({
            kind: "modules",
            id: "main",
            revision: REVISION,
            hashes: [],
        });
        // Both shapes, neither, a hash record of a non-item kind, a bad hash, a foreign kind.
        expect(
            checkCachedRecord({ kind: "modules", id: "main", revision: REVISION, text: "[]", hashes: [] }),
        ).toBeNull();
        expect(checkCachedRecord({ kind: "modules", id: "main", revision: REVISION })).toBeNull();
        expect(checkCachedRecord({ kind: "characters", id: "c1", revision: REVISION, hashes: [HASH] })).toBeNull();
        expect(checkCachedRecord({ kind: "modules", id: "main", revision: REVISION, hashes: ["short"] })).toBeNull();
        expect(checkCachedRecord({ kind: "modules", id: "main", revision: REVISION, hashes: [1] })).toBeNull();
        expect(checkCachedRecord({ kind: "ui", id: "main", revision: REVISION, text: "{}" })).toBeNull();
        expect(checkCachedRecord({ kind: "llmSecrets", id: "main", revision: REVISION, text: "{}" })).toBeNull();
        expect(checkCachedRecord(null)).toBeNull();
        expect(checkCachedRecord([])).toBeNull();
        expect(checkCachedRecord("characters")).toBeNull();
    });

    it("drops ids the server refuses (empty, over 512, `.`, `..`, a control character, a lone surrogate) and bad revisions", () => {
        const record = (id: unknown, revision: unknown = REVISION) =>
            checkCachedRecord({ kind: "characters", id, revision, text: "{}" });
        for (const id of ["", "a".repeat(513), ".", "..", "a\u0001b", "a\u007f", "\uD800", "a\uDC00b", 5, null]) {
            expect(record(id), JSON.stringify(id)).toBeNull();
        }
        for (const id of ["a", "a".repeat(512), "...", "a b", "名前", "a😀b", "a/b"]) {
            expect(record(id), JSON.stringify(id)).not.toBeNull();
        }
        expect(record("c1", "")).toBeNull();
        expect(record("c1", "r".repeat(257))).toBeNull();
        expect(record("c1", 1)).toBeNull();
    });

    it("checks the meta's three fields, and a current meta is this format and app version", () => {
        expect(checkCacheMeta({ format: 1, appVer: APP, generation: "g" })).toEqual({
            format: 1,
            appVer: APP,
            generation: "g",
        });
        expect(checkCacheMeta({ format: 1, appVer: APP })).toBeNull();
        expect(checkCacheMeta({ format: "1", appVer: APP, generation: "g" })).toBeNull();
        expect(checkCacheMeta(null)).toBeNull();
    });

    it("a character with a non-empty TTS key holds a credential; nothing else does", () => {
        expect(holdsCredential("characters", character("c", { oaiTTSConfig: { apiKey: "k" } }))).toBe(true);
        expect(holdsCredential("characters", character("c", { oaiTTSConfig: { apiKey: "" } }))).toBe(false);
        expect(holdsCredential("characters", character("c", { oaiTTSConfig: { apiKey: 5 } }))).toBe(false);
        expect(holdsCredential("characters", character("c"))).toBe(false);
        expect(holdsCredential("characters", null)).toBe(false);
        expect(holdsCredential("characters", [{ oaiTTSConfig: { apiKey: "k" } }])).toBe(false);
        expect(holdsCredential("modules", { oaiTTSConfig: { apiKey: "k" } })).toBe(false);
    });
});

describe("the boot request", () => {
    const contents = (records: BootCacheContents["records"], items: [string, string][] = []): BootCacheContents => ({
        meta: { format: BOOT_CACHE_FORMAT, appVer: APP, generation: "g0" },
        records,
        items: new Map(items),
    });

    it("asks every kind with chat summaries and claims nothing from an empty cache", () => {
        const context = prepareBootRequest(contents([]));
        expect(context.request).toEqual({ kinds: ALL_KINDS, chatSummaries: true });
        expect(context.request).not.toHaveProperty("known");
        expect(context.claims.size).toBe(0);
        expect(context.hashes.size).toBe(0);
    });

    it("claims complete records and every present hash; a record missing an item text is not claimed but its present hashes are", () => {
        const h1 = hashOf(module("m1"));
        const h2 = hashOf(module("m2"));
        const context = prepareBootRequest(
            contents(
                [
                    { kind: "characters", id: "c1", revision: "r1", text: "{}" },
                    { kind: "modules", id: "main", revision: "r2", hashes: [h1, h2, h1] },
                    { kind: "presets", id: "main", revision: "r3", hashes: [] },
                ],
                [[itemKey("modules", h1), JSON.stringify(module("m1"))]],
            ),
        );
        expect(context.request.known).toEqual({
            records: [
                { kind: "characters", id: "c1", revision: "r1" },
                { kind: "presets", id: "main", revision: "r3" },
            ],
            items: [{ kind: "modules", hashes: [h1] }],
        });
        expect([...context.claims.keys()]).toEqual([recordKey("characters", "c1"), recordKey("presets", "main")]);
        expect(context.hashes.get("modules")).toEqual(new Set([h1]));
        expect(context.hashes.get("presets")).toEqual(new Set());
    });

    it("claims nothing past 5,000 claims or a 2 MiB body, keeping the plain request", () => {
        const many = Array.from({ length: MAX_BOOT_CLAIMS + 1 }, (_, index) => ({
            kind: "characters",
            id: `c${index}`,
            revision: "r",
            text: "{}",
        }));
        const over = prepareBootRequest(contents(many));
        expect(over.request).toEqual({ kinds: ALL_KINDS, chatSummaries: true });
        expect(over.claims.size).toBe(0);
        const exact = prepareBootRequest(contents(many.slice(0, MAX_BOOT_CLAIMS)));
        expect(exact.claims.size).toBe(MAX_BOOT_CLAIMS);
        const big = Array.from({ length: 4500 }, (_, index) => ({
            kind: "characters",
            id: `${index}`.padStart(512, "x"),
            revision: "r",
            text: "{}",
        }));
        const bytes = prepareBootRequest(contents(big));
        expect(bytes.request).not.toHaveProperty("known");
        expect(bytes.claims.size).toBe(0);
    });
});

describe("the answer expanded against the advertised claims", () => {
    const h = (item: unknown) => hashOf(item);
    const base = (overrides: Partial<Record<string, unknown>> = {}) => ({
        format: BOOT_RESOURCE_FORMAT,
        epoch: "e1",
        kinds: Object.fromEntries(ALL_KINDS.map((kind) => [kind, []])),
        chatSummaries: [],
        chatOrders: [],
        ...overrides,
    });
    const withKinds = (kinds: Record<string, unknown[]>) => base({ kinds: { ...base().kinds, ...kinds } });
    const context = (records: BootCacheContents["records"] = [], items: [string, string][] = []) =>
        prepareBootRequest({
            meta: { format: BOOT_CACHE_FORMAT, appVer: APP, generation: "g0" },
            records,
            items: new Map(items),
        });
    const reasonOf = (run: () => unknown) => {
        try {
            run();
        } catch (error) {
            expect(error).toBeInstanceOf(BootCacheMiss);
            return (error as BootCacheMiss).reason;
        }
        throw new Error("expected a BootCacheMiss");
    };

    it("refuses another format, a missing epoch, a missing kind list, missing chat arrays, and overlapping variants as `format`", () => {
        const empty = context();
        expect(reasonOf(() => expandBootAnswer(base({ format: 2 }), empty))).toBe("format");
        expect(reasonOf(() => expandBootAnswer(null, empty))).toBe("format");
        expect(reasonOf(() => expandBootAnswer(base({ epoch: 1 }), empty))).toBe("format");
        expect(reasonOf(() => expandBootAnswer(base({ kinds: {} }), empty))).toBe("format");
        const { characters: _dropped, ...rest } = base().kinds;
        expect(reasonOf(() => expandBootAnswer(base({ kinds: rest }), empty))).toBe("format");
        expect(reasonOf(() => expandBootAnswer(base({ kinds: { ...base().kinds, characters: {} } }), empty))).toBe(
            "format",
        );
        expect(reasonOf(() => expandBootAnswer(base({ chatSummaries: undefined }), empty))).toBe("format");
        expect(reasonOf(() => expandBootAnswer(base({ chatOrders: null }), empty))).toBe("format");
        expect(
            reasonOf(() =>
                expandBootAnswer(
                    withKinds({ characters: [{ id: "c1", revision: "r", cached: true, data: {} }] }),
                    empty,
                ),
            ),
        ).toBe("format");
        expect(
            reasonOf(() =>
                expandBootAnswer(withKinds({ modules: [{ id: "main", revision: "r", items: [], data: [] }] }), empty),
            ),
        ).toBe("format");
        expect(reasonOf(() => expandBootAnswer(withKinds({ characters: [{ id: "c1", revision: "r" }] }), empty))).toBe(
            "format",
        );
        expect(reasonOf(() => expandBootAnswer(withKinds({ characters: [{ id: "c1" }] }), empty))).toBe("format");
        expect(
            reasonOf(() =>
                expandBootAnswer(withKinds({ characters: [{ id: "c1", revision: "r", items: [] }] }), empty),
            ),
        ).toBe("format");
        expect(
            reasonOf(() =>
                expandBootAnswer(withKinds({ modules: [{ id: "main", revision: "r", items: [{}] }] }), empty),
            ),
        ).toBe("format");
        expect(
            reasonOf(() => expandBootAnswer(withKinds({ modules: [{ id: "main", revision: "r", items: {} }] }), empty)),
        ).toBe("format");
    });

    it("accepts `cached` only for an exact claim of a cached kind, and a bare item only for an advertised hash: `incomplete` otherwise", () => {
        const claim = context([
            { kind: "characters", id: "c1", revision: "r1", text: JSON.stringify(character("c1")) },
        ]);
        expect(
            reasonOf(() =>
                expandBootAnswer(withKinds({ characters: [{ id: "c1", revision: "r2", cached: true }] }), claim),
            ),
        ).toBe("incomplete");
        expect(
            reasonOf(() =>
                expandBootAnswer(withKinds({ characters: [{ id: "c2", revision: "r1", cached: true }] }), claim),
            ),
        ).toBe("incomplete");
        expect(
            reasonOf(() =>
                expandBootAnswer(withKinds({ characters: [{ id: "c1", revision: "r1", cached: false }] }), claim),
            ),
        ).toBe("incomplete");
        expect(
            reasonOf(() => expandBootAnswer(withKinds({ ui: [{ id: "main", revision: "r1", cached: true }] }), claim)),
        ).toBe("incomplete");
        const m1 = module("m1");
        const partial = context(
            [{ kind: "modules", id: "main", revision: "r1", hashes: [h(m1), h(module("m2"))] }],
            [[itemKey("modules", h(m1)), JSON.stringify(m1)]],
        );
        expect(partial.claims.size).toBe(0);
        expect(
            reasonOf(() =>
                expandBootAnswer(
                    withKinds({
                        modules: [{ id: "main", revision: "r1", items: [{ hash: h(m1) }, { hash: h(module("m2")) }] }],
                    }),
                    partial,
                ),
            ),
        ).toBe("incomplete");
        // The record itself was not claimed (an item was missing), so `cached` is not accepted for it.
        expect(
            reasonOf(() =>
                expandBootAnswer(withKinds({ modules: [{ id: "main", revision: "r1", cached: true }] }), partial),
            ),
        ).toBe("incomplete");
        // A hash of another kind than advertised.
        expect(
            reasonOf(() =>
                expandBootAnswer(
                    withKinds({ presets: [{ id: "main", revision: "r1", items: [{ hash: h(m1) }] }] }),
                    partial,
                ),
            ),
        ).toBe("incomplete");
    });

    it("rebuilds a cached character from its text only when it is an object whose `chaId` is the record id; a credential holder is installed but not cached", () => {
        const at = (text: string) => context([{ kind: "characters", id: "c1", revision: "r1", text }]);
        const answer = withKinds({ characters: [{ id: "c1", revision: "r1", cached: true }] });
        for (const text of [
            "null",
            "[]",
            '"c1"',
            "1",
            "{}",
            JSON.stringify(character("c2")),
            JSON.stringify({ chaId: 1 }),
        ]) {
            expect(
                reasonOf(() => expandBootAnswer(answer, at(text))),
                text,
            ).toBe("incomplete");
        }
        expect(() => expandBootAnswer(answer, at("{bad"))).toThrow(SyntaxError);
        const good = expandBootAnswer(answer, at(JSON.stringify(character("c1"))));
        expect(good.snapshot.kinds.characters).toEqual([{ id: "c1", revision: "r1", data: character("c1") }]);
        expect(good.manifest).toEqual([
            { kind: "characters", id: "c1", revision: "r1", text: JSON.stringify(character("c1")) },
        ]);
        const secret = character("c1", { oaiTTSConfig: { apiKey: "k" } });
        const held = expandBootAnswer(answer, at(JSON.stringify(secret)));
        expect(held.snapshot.kinds.characters[0].data).toEqual(secret);
        expect(held.manifest).toEqual([]);
        // The whole-record branch excludes it too, and caches an ordinary one as its text.
        const whole = expandBootAnswer(
            withKinds({
                characters: [
                    { id: "c1", revision: "r1", data: secret },
                    { id: "c2", revision: "r2", data: character("c2") },
                ],
            }),
            context(),
        );
        expect(whole.snapshot.kinds.characters.map((record) => record.data)).toEqual([secret, character("c2")]);
        expect(whole.manifest).toEqual([
            { kind: "characters", id: "c2", revision: "r2", text: JSON.stringify(character("c2")) },
        ]);
    });

    it("rebuilds an `items` record by position: data as given (falsy values too), cached texts for bare hashes, repeats as independent objects, `[]` as `[]`", () => {
        const m1 = module("m1");
        const m2 = { ...module("m2"), nested: { deep: true } };
        const ctx = context(
            [{ kind: "modules", id: "main", revision: "r0", hashes: [h(m1)] }],
            [[itemKey("modules", h(m1)), JSON.stringify(m1)]],
        );
        const expanded = expandBootAnswer(
            withKinds({
                modules: [
                    {
                        id: "main",
                        revision: "r1",
                        items: [
                            { hash: h(m1) },
                            { hash: h(m2), data: structuredClone(m2) },
                            { hash: h(m1) },
                            { hash: h(m2), data: structuredClone(m2) },
                            { hash: h(null), data: null },
                            { hash: h(false), data: false },
                            { hash: h(0), data: 0 },
                            { hash: h(""), data: "" },
                        ],
                    },
                ],
                presets: [{ id: "main", revision: "r2", items: [] }],
            }),
            ctx,
        );
        const [modules] = expanded.snapshot.kinds.modules;
        expect(modules).toEqual({ id: "main", revision: "r1", data: [m1, m2, m1, m2, null, false, 0, ""] });
        const list = modules.data as unknown[];
        expect(list[0]).not.toBe(list[2]);
        expect(list[1]).not.toBe(list[3]);
        expect(expanded.snapshot.kinds.presets).toEqual([{ id: "main", revision: "r2", data: [] }]);
        // The manifest follows the answer's kind order; the cache does not care.
        expect(expanded.manifest).toHaveLength(2);
        expect(expanded.manifest).toEqual(
            expect.arrayContaining([
                {
                    kind: "modules",
                    id: "main",
                    revision: "r1",
                    hashes: [h(m1), h(m2), h(m1), h(m2), h(null), h(false), h(0), h("")],
                },
                { kind: "presets", id: "main", revision: "r2", hashes: [] },
            ]),
        );
        expect([...expanded.items]).toEqual([
            [itemKey("modules", h(m2)), JSON.stringify(m2)],
            [itemKey("modules", h(null)), "null"],
            [itemKey("modules", h(false)), "false"],
            [itemKey("modules", h(0)), "0"],
            [itemKey("modules", h("")), '""'],
        ]);
        // The cached record rebuilt from the hash list reads each text again: independent objects.
        const next = prepareBootRequest({
            meta: { format: BOOT_CACHE_FORMAT, appVer: APP, generation: "g1" },
            records: expanded.manifest,
            items: new Map([...ctx.contents.items, ...expanded.items]),
        });
        const again = expandBootAnswer(
            withKinds({
                modules: [{ id: "main", revision: "r1", cached: true }],
                presets: [{ id: "main", revision: "r2", cached: true }],
            }),
            next,
        );
        expect(again.snapshot.kinds.modules).toEqual([modules]);
        const rebuilt = again.snapshot.kinds.modules[0].data as unknown[];
        expect(rebuilt[0]).not.toBe(rebuilt[2]);
        expect(again.snapshot.kinds.presets[0].data).toEqual([]);
    });

    it("installs a whole non-array item-kind record as is and caches it as a text record; the text keeps an own `__proto__` key and the key order", () => {
        const data = JSON.parse('{"zeta":1,"__proto__":{"polluted":true},"10":"ten","2":"two","alpha":2}');
        const expanded = expandBootAnswer(withKinds({ modules: [{ id: "main", revision: "r1", data }] }), context());
        expect(expanded.snapshot.kinds.modules[0].data).toBe(data);
        expect(expanded.manifest).toEqual([
            { kind: "modules", id: "main", revision: "r1", text: JSON.stringify(data) },
        ]);
        expect(expanded.manifest[0].text).toBe(
            '{"2":"two","10":"ten","zeta":1,"__proto__":{"polluted":true},"alpha":2}',
        );
        const next = prepareBootRequest({
            meta: { format: BOOT_CACHE_FORMAT, appVer: APP, generation: "g1" },
            records: expanded.manifest,
            items: new Map(),
        });
        expect(next.request.known?.records).toEqual([{ kind: "modules", id: "main", revision: "r1" }]);
        const again = expandBootAnswer(withKinds({ modules: [{ id: "main", revision: "r1", cached: true }] }), next);
        const rebuilt = again.snapshot.kinds.modules[0].data as Record<string, unknown>;
        expect(Object.hasOwn(rebuilt, "__proto__")).toBe(true);
        expect(JSON.stringify(rebuilt)).toBe(expanded.manifest[0].text);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("keeps the epoch, the kind order, the record order, and both chat arrays of the answer", () => {
        const answer = withKinds({
            characters: [
                { id: "b", revision: "r1", data: character("b") },
                { id: "a", revision: "r2", data: character("a") },
            ],
        });
        answer.chatSummaries = [{ chatId: "x" }];
        answer.chatOrders = [{ characterId: "a" }];
        const expanded = expandBootAnswer(answer, context());
        expect(Object.keys(expanded.snapshot.kinds)).toEqual(ALL_KINDS);
        expect(expanded.snapshot.kinds.characters.map((record) => record.id)).toEqual(["b", "a"]);
        expect(expanded.snapshot).toEqual({
            epoch: "e1",
            kinds: answer.kinds,
            chatSummaries: [{ chatId: "x" }],
            chatOrders: [{ characterId: "a" }],
        });
    });
});

describe("the write diff", () => {
    const meta = { format: BOOT_CACHE_FORMAT, appVer: APP, generation: "g0" };
    const c1: CachedRecord = { kind: "characters", id: "c1", revision: "r1", text: "{}" };
    const mods: CachedRecord = { kind: "modules", id: "main", revision: "r2", hashes: ["A".repeat(22)] };

    it("rewrites only the records that changed and expects the loaded generation", () => {
        const write = bootCacheWrite(
            { meta, records: [c1, mods], items: new Map() },
            {
                manifest: [
                    c1,
                    { ...mods, hashes: ["B".repeat(22)] },
                    { kind: "presets", id: "main", revision: "r3", hashes: [] },
                ],
                items: new Map([["x", "y"]]),
            },
            APP,
        );
        expect(write.expectGeneration).toBe("g0");
        expect(write.clear).toBe(false);
        expect(write.changed.map((record) => record.kind)).toEqual(["modules", "presets"]);
        expect(write.records).toHaveLength(3);
        expect(write.items).toEqual(new Map([["x", "y"]]));
        expect(write.meta).toMatchObject({ format: BOOT_CACHE_FORMAT, appVer: APP });
        expect(write.meta.generation).not.toBe("g0");
        // A same-revision record with another text is a change too.
        expect(
            bootCacheWrite(
                { meta, records: [c1], items: new Map() },
                { manifest: [{ ...c1, text: '{"a":1}' }], items: new Map() },
                APP,
            ).changed,
        ).toHaveLength(1);
    });

    it("clears and rewrites everything for another app version or format, or no meta, and expects `null` for no meta", () => {
        const other = bootCacheWrite(
            { meta: { ...meta, appVer: "v0" }, records: [c1], items: new Map() },
            { manifest: [c1], items: new Map() },
            APP,
        );
        expect(other).toMatchObject({ expectGeneration: "g0", clear: true, changed: [c1] });
        const none = bootCacheWrite(
            { meta: null, records: [], items: new Map() },
            { manifest: [c1], items: new Map() },
            APP,
        );
        expect(none).toMatchObject({ expectGeneration: null, clear: true, changed: [c1] });
        const format = bootCacheWrite(
            { meta: { ...meta, format: 0 }, records: [c1], items: new Map() },
            { manifest: [c1], items: new Map() },
            APP,
        );
        expect(format.clear).toBe(true);
    });
});

describe("the boot over the IndexedDB cache", () => {
    it("first boot: claims nothing, equals the full read, and the commit writes the answer (texts, hashes, items, meta) without the credential holder", async () => {
        const server = seededServer();
        const deps = depsFor(server, indexedDbBootCacheStore(APP));
        const boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        expect(deps.requests).toHaveLength(1);
        expect(deps.requests[0]).not.toHaveProperty("known");
        expect(deps.fullReads).toBe(0);
        expect(deps.events).toEqual([]);
        expect(marks()).toEqual(["risu-boot-cache:read-start", "risu-boot-cache:read", "risu-boot-cache:answer"]);
        expect((await dump()).meta).toBeNull();
        await boot.commit();
        await boot.commit();
        expect(marks().slice(3)).toEqual(["risu-boot-cache:write-start", "risu-boot-cache:written"]);
        const { records, items, meta } = await dump();
        expect(meta).toMatchObject({ format: BOOT_CACHE_FORMAT, appVer: APP });
        expect(typeof meta?.generation).toBe("string");
        expect([...records.keys()].sort()).toEqual(
            [recordKey("characters", "c1"), recordKey("modules", "main"), recordKey("presets", "main")].sort(),
        );
        expect(records.get(recordKey("characters", "c1"))).toEqual({
            kind: "characters",
            id: "c1",
            revision: server.state.kinds.characters[0].revision,
            text: JSON.stringify(character("c1")),
        });
        const m1 = hashOf(module("m1"));
        const m2 = hashOf(module("m2"));
        expect(records.get(recordKey("modules", "main"))).toMatchObject({ hashes: [m1, m2, m1] });
        expect([...items.keys()].sort()).toEqual(
            [
                itemKey("modules", m1),
                itemKey("modules", m2),
                itemKey("presets", hashOf({ id: "p1", name: "preset" })),
            ].sort(),
        );
        expect(items.get(itemKey("modules", m1))).toBe(JSON.stringify(module("m1")));
        expect(deps.events).toEqual([]);
    });

    it("second boot: claims every record and hash, the answer is all `cached`, and the snapshot still equals the full read", async () => {
        const server = seededServer();
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        const deps = depsFor(server, store);
        const boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        const request = deps.requests[0];
        expect(request.known?.records?.map((entry) => `${entry.kind}/${entry.id}`).sort()).toEqual(
            ["characters/c1", "modules/main", "presets/main"].sort(),
        );
        expect(request.known?.items?.find((entry) => entry.kind === "modules")?.hashes.sort()).toEqual(
            [hashOf(module("m1")), hashOf(module("m2"))].sort(),
        );
        expect(deps.fullReads).toBe(0);
        expect(deps.events).toEqual([]);
        // Cached data is detached from the cache's texts and the server's: edits never reach either.
        (boot.snapshot.kinds.characters[0].data as Record<string, unknown>).name = "edited";
        (boot.snapshot.kinds.modules[0].data as Record<string, unknown>[])[0].name = "edited";
        const before = await dump();
        await boot.commit();
        const after = await dump();
        expect(after.records.get(recordKey("characters", "c1"))).toEqual(
            before.records.get(recordKey("characters", "c1")),
        );
        expect(after.items).toEqual(before.items);
        expect(after.meta?.generation).not.toBe(before.meta?.generation);
    });

    it("a changed module, a changed character, a deleted character, a reordered list: the answer is partial, equals the full read, and GC drops what is no longer named", async () => {
        const server = seededServer();
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        server.set("modules", "main", [module("m1"), module("m3"), module("m1")]);
        server.set("characters", "c1", character("c1", { name: "renamed" }));
        server.set("characters", "c3", character("c3"));
        let deps = depsFor(server, store);
        let boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        const answer = server.answer(deps.requests[0]) as { kinds: Record<string, Record<string, unknown>[]> };
        expect(answer.kinds.modules[0].items).toEqual([
            { hash: hashOf(module("m1")) },
            { hash: hashOf(module("m3")), data: module("m3") },
            { hash: hashOf(module("m1")) },
        ]);
        expect(answer.kinds.characters.map((record) => "cached" in record)).toEqual([false, false, false]);
        expect(answer.kinds.presets[0].cached).toBe(true);
        await boot.commit();
        let state = await dump();
        expect([...state.items.keys()].filter((key) => key.startsWith("modules")).sort()).toEqual(
            [itemKey("modules", hashOf(module("m1"))), itemKey("modules", hashOf(module("m3")))].sort(),
        );
        expect(state.records.get(recordKey("characters", "c1"))).toMatchObject({
            text: JSON.stringify(character("c1", { name: "renamed" })),
        });
        expect(state.records.has(recordKey("characters", "c3"))).toBe(true);

        server.remove("characters", "c3");
        server.set("modules", "main", [module("m3"), module("m1"), module("m1")]);
        deps = depsFor(server, store);
        boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        const reordered = server.answer(deps.requests[0]) as { kinds: Record<string, Record<string, unknown>[]> };
        expect(reordered.kinds.modules[0].items).toEqual([
            { hash: hashOf(module("m3")) },
            { hash: hashOf(module("m1")) },
            { hash: hashOf(module("m1")) },
        ]);
        await boot.commit();
        state = await dump();
        expect(state.records.has(recordKey("characters", "c3"))).toBe(false);
        expect(state.records.get(recordKey("modules", "main"))).toMatchObject({
            hashes: [hashOf(module("m3")), hashOf(module("m1")), hashOf(module("m1"))],
        });
        expect(deps.events).toEqual([]);
    });

    it("no IndexedDB: one plain read, a `fallback unavailable` event, and a commit that does nothing", async () => {
        vi.stubGlobal("indexedDB", undefined);
        const server = seededServer();
        const deps = depsFor(server, indexedDbBootCacheStore(APP));
        const boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        expect(deps.fullReads).toBe(1);
        expect(deps.requests).toEqual([]);
        expect(deps.events).toEqual([
            { kind: "bootCache", phase: "fallback", reason: "unavailable", records: 0, items: 0 },
        ]);
        await expect(boot.commit()).resolves.toBeUndefined();
        expect(marks()).toEqual(["risu-boot-cache:read-start"]);
    });

    it("an open that never answers falls back as `timeout` within the bound, and a connection that arrives later is closed", async () => {
        const close = vi.fn();
        let request: { onsuccess?: () => void; result?: unknown } | null = null;
        vi.stubGlobal("indexedDB", {
            open: () => {
                request = {};
                return request;
            },
        });
        const server = seededServer();
        const deps = depsFor(server, indexedDbBootCacheStore(APP, 20));
        const started = Date.now();
        const boot = await loadBootSnapshot(deps);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(boot.snapshot).toEqual(server.full());
        expect(deps.events).toEqual([
            { kind: "bootCache", phase: "fallback", reason: "timeout", records: 0, items: 0 },
        ]);
        request!.result = { close, onversionchange: null };
        request!.onsuccess!();
        expect(close).toHaveBeenCalledTimes(1);
        await boot.commit();
    });

    it("a database another version holds (a newer app opened it) cannot be opened: `readFailed`, and the cache is left alone", async () => {
        await new Promise<void>((resolve) => {
            const request = indexedDB.open(DB_NAME, 2);
            request.onupgradeneeded = () => request.result.createObjectStore("records");
            request.onsuccess = () => {
                request.result.close();
                resolve();
            };
        });
        const server = seededServer();
        const deps = depsFor(server, indexedDbBootCacheStore(APP));
        const boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        expect(deps.fullReads).toBe(1);
        expect(fallbacks(deps)).toEqual([
            { kind: "bootCache", phase: "fallback", reason: "readFailed", records: 0, items: 0 },
        ]);
        await boot.commit();
        expect(deps.events).toHaveLength(1);
    });

    it("every call closes its connection: a foreign upgrade after a boot is not blocked", async () => {
        const server = seededServer();
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        await loadBootSnapshot(depsFor(server, store));
        const blocked = vi.fn();
        const version = await new Promise<number>((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 2);
            request.onblocked = blocked;
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const found = request.result.version;
                request.result.close();
                resolve(found);
            };
        });
        expect(version).toBe(2);
        expect(blocked).not.toHaveBeenCalled();
    });

    it("a failed boot request: one plain read, `fallback request`, the cache untouched, no clear", async () => {
        const server = seededServer();
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        const before = await dump();
        const deps = depsFor(server, store);
        deps.readBoot = async () => {
            throw new Error("500");
        };
        const boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        expect(deps.fullReads).toBe(1);
        expect(deps.events).toEqual([
            { kind: "bootCache", phase: "fallback", reason: "request", records: 3, items: 3 },
        ]);
        await boot.commit();
        expect(await dump()).toEqual(before);
        expect(deps.events).toHaveLength(1);
    });

    it("an answer of another format: the fenced clear starts before the plain read answers, and is reported as `cleared` with a fresh generation kept", async () => {
        const server = seededServer();
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        const before = await dump();
        const deps = depsFor(server, store);
        deps.readBoot = async () => ({
            ...(server.answer(deps.requests[0] ?? { kinds: ALL_KINDS, chatSummaries: true }) as object),
            format: 2,
        });
        let release!: () => void;
        const plainRead = new Promise<void>((resolve) => (release = resolve));
        deps.readKinds = async () => {
            deps.fullReads += 1;
            await plainRead;
            return server.full();
        };
        const booting = loadBootSnapshot(deps);
        // The clear lands while the plain read is still pending.
        for (let attempt = 0; attempt < 50 && (await dump()).records.size > 0; attempt += 1) {
            await tick();
        }
        const cleared = await dump();
        expect(cleared.records.size).toBe(0);
        expect(cleared.items.size).toBe(0);
        expect(cleared.meta).toMatchObject({ format: BOOT_CACHE_FORMAT, appVer: APP });
        expect(cleared.meta?.generation).not.toBe(before.meta?.generation);
        expect(deps.events).toEqual([
            { kind: "bootCache", phase: "fallback", reason: "format", records: 3, items: 3 },
            { kind: "bootCache", phase: "cleared", reason: "format" },
        ]);
        release();
        const boot = await booting;
        expect(boot.snapshot).toEqual(server.full());
        await boot.commit();
        expect((await dump()).meta?.generation).toBe(cleared.meta?.generation);
    });

    it("a corrupt item text or character text in the cache: `fallback incomplete`, a plain read, and the cache cleared", async () => {
        const server = seededServer();
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        await seedRaw({ items: [[itemKey("modules", hashOf(module("m1"))), "{bad"]] });
        let deps = depsFor(server, store);
        let boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        await boot.commit();
        expect(deps.events).toEqual([
            { kind: "bootCache", phase: "fallback", reason: "incomplete", records: 3, items: 3 },
            { kind: "bootCache", phase: "cleared", reason: "incomplete" },
        ]);
        expect((await dump()).records.size).toBe(0);

        await (await loadBootSnapshot(depsFor(server, store))).commit();
        const stored = (await dump()).records.get(recordKey("characters", "c1")) as Record<string, unknown>;
        await seedRaw({ records: [[recordKey("characters", "c1"), { ...stored, text: "null" }]] });
        deps = depsFor(server, store);
        boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        expect(fallbacks(deps)).toEqual([
            { kind: "bootCache", phase: "fallback", reason: "incomplete", records: 3, items: 3 },
        ]);
        await boot.commit();
        expect((await dump()).records.size).toBe(0);
    });

    it("a cache entry that fails the runtime check is dropped from the claims (a foreign kind, a bad id, a broken shape), not sent, not a fallback", async () => {
        const server = seededServer();
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        const stored = (await dump()).records.get(recordKey("characters", "c1")) as Record<string, unknown>;
        await seedRaw({
            records: [
                [recordKey("characters", "."), { ...stored, id: "." }],
                [recordKey("characters", "bad\u0001"), { ...stored, id: "bad\u0001" }],
                [recordKey("llmSecrets", "main"), { kind: "llmSecrets", id: "main", revision: "r", text: "{}" }],
                [
                    recordKey("characters", "c9"),
                    { kind: "characters", id: "c9", revision: "r", text: "{}", hashes: [] },
                ],
                ["garbage", 42],
            ],
        });
        const deps = depsFor(server, store);
        const boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        expect(deps.events).toEqual([]);
        expect(deps.requests[0].known?.records?.map((entry) => entry.id).sort()).toEqual(["c1", "main", "main"]);
        await boot.commit();
        expect([...(await dump()).records.keys()].sort()).toEqual(
            [recordKey("characters", "c1"), recordKey("modules", "main"), recordKey("presets", "main")].sort(),
        );
    });

    it("a cached character holding a credential (a foreign write) is installed, advertised once, and dropped by the commit", async () => {
        const server = seededServer();
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        // The cache holds c2 with its key, as if written by a version without the exclusion.
        const c2 = server.state.kinds.characters[1];
        await seedRaw({
            records: [
                [
                    recordKey("characters", "c2"),
                    { kind: "characters", id: "c2", revision: c2.revision, text: JSON.stringify(c2.data) },
                ],
            ],
        });
        const deps = depsFor(server, store);
        const boot = await loadBootSnapshot(deps);
        expect(deps.requests[0].known?.records?.some((entry) => entry.id === "c2")).toBe(true);
        expect(boot.snapshot).toEqual(server.full());
        await boot.commit();
        expect((await dump()).records.has(recordKey("characters", "c2"))).toBe(false);
        expect(deps.events).toEqual([]);
    });

    it("another tab's write since the load: the commit is skipped (no `written` mark), that tab's cache stays", async () => {
        const store = indexedDbBootCacheStore(APP);
        const serverA = seededServer();
        await (await loadBootSnapshot(depsFor(serverA, store))).commit();
        const tabA = await loadBootSnapshot(depsFor(serverA, store));
        const serverB = seededServer();
        serverB.set("characters", "c3", character("c3"));
        const tabB = await loadBootSnapshot(depsFor(serverB, store));
        await tabB.commit();
        const afterB = await dump();
        expect(afterB.records.has(recordKey("characters", "c3"))).toBe(true);
        performance.clearMarks();
        await tabA.commit();
        expect(marks()).toEqual(["risu-boot-cache:write-start"]);
        expect(await dump()).toEqual(afterB);
    });

    it("a clear invalidates a write prepared over an empty cache: the `null` expectation no longer matches", async () => {
        const server = seededServer();
        const store = indexedDbBootCacheStore(APP);
        const first = await loadBootSnapshot(depsFor(server, store));
        expect((await dump()).meta).toBeNull();
        await clearBootCache(store);
        const cleared = await dump();
        expect(cleared.meta).toMatchObject({ format: BOOT_CACHE_FORMAT, appVer: APP });
        expect(cleared.records.size).toBe(0);
        await first.commit();
        expect(await dump()).toEqual(cleared);
        // A later boot loads the cleared meta's generation and writes over it.
        const next = await loadBootSnapshot(depsFor(server, store));
        await next.commit();
        const written = await dump();
        expect(written.records.size).toBe(3);
        expect(written.meta?.generation).not.toBe(cleared.meta?.generation);
    });

    it("an unusable answer after another tab wrote: the fenced clear is skipped and not reported, that tab's cache stays", async () => {
        const store = indexedDbBootCacheStore(APP);
        const server = seededServer();
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        const depsA = depsFor(server, store);
        let loadedA!: () => void;
        let answerA!: () => void;
        const loaded = new Promise<void>((resolve) => (loadedA = resolve));
        const answer = new Promise<void>((resolve) => (answerA = resolve));
        // A has read the cache (its generation captured); its answer is held until B wrote.
        depsA.readBoot = async () => {
            loadedA();
            await answer;
            return { format: 2 };
        };
        const bootingA = loadBootSnapshot(depsA);
        await loaded;
        await (await loadBootSnapshot(depsFor(server, store))).commit();
        const afterB = await dump();
        answerA();
        const bootA = await bootingA;
        expect(bootA.snapshot).toEqual(server.full());
        await bootA.commit();
        expect(depsA.events).toEqual([
            { kind: "bootCache", phase: "fallback", reason: "format", records: 3, items: 3 },
        ]);
        expect(await dump()).toEqual(afterB);
    });

    it("another app version: the cache is not claimed, and the commit clears and rewrites it under the new version", async () => {
        const server = seededServer();
        await (await loadBootSnapshot(depsFor(server, indexedDbBootCacheStore("v1")))).commit();
        const old = await dump();
        const deps = depsFor(server, indexedDbBootCacheStore("v2"), "v2");
        const boot = await loadBootSnapshot(deps);
        expect(deps.requests[0]).not.toHaveProperty("known");
        expect(boot.snapshot).toEqual(server.full());
        expect(deps.events).toEqual([]);
        await boot.commit();
        const fresh = await dump();
        expect(fresh.meta).toMatchObject({ format: BOOT_CACHE_FORMAT, appVer: "v2" });
        expect(fresh.meta?.generation).not.toBe(old.meta?.generation);
        expect(fresh.records.size).toBe(3);
        expect(fresh.items).toEqual(old.items);
        // A format the cache does not know is treated the same way.
        await seedRaw({ meta: { ...fresh.meta, format: BOOT_CACHE_FORMAT + 1 } });
        const next = depsFor(server, indexedDbBootCacheStore("v2"), "v2");
        await (await loadBootSnapshot(next)).commit();
        expect(next.requests[0]).not.toHaveProperty("known");
        expect((await dump()).meta?.format).toBe(BOOT_CACHE_FORMAT);
    });

    it("a failed write: `writeFailed` with the quota reason, the cache cleared (fenced), the boot unaffected", async () => {
        const server = seededServer();
        const real = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(server, real))).commit();
        const failing: BootCacheStore = {
            load: () => real.load(),
            write: async () => {
                throw new DOMException("full", "QuotaExceededError");
            },
            clear: (expect) => real.clear(expect),
        };
        performance.clearMarks();
        const deps = depsFor(server, failing);
        const boot = await loadBootSnapshot(deps);
        expect(boot.snapshot).toEqual(server.full());
        await expect(boot.commit()).resolves.toBeUndefined();
        expect(deps.events).toEqual([{ kind: "bootCache", phase: "writeFailed", reason: "quota" }]);
        const state = await dump();
        expect(state.records.size).toBe(0);
        expect(state.meta).toMatchObject({ format: BOOT_CACHE_FORMAT, appVer: APP });
        expect(marks()).not.toContain("risu-boot-cache:written");
        // Any other error is `write`; a store whose clear fails too is survived.
        const broken: BootCacheStore = {
            load: () => real.load(),
            write: async () => {
                throw new Error("disk");
            },
            clear: async () => {
                throw new Error("disk");
            },
        };
        const again = depsFor(server, broken);
        await expect((await loadBootSnapshot(again)).commit()).resolves.toBeUndefined();
        expect(again.events).toEqual([{ kind: "bootCache", phase: "writeFailed", reason: "write" }]);
    });

    it("the store's own contract: a fenced write and clear answer `skipped`, an unconditional clear always clears", async () => {
        const store = indexedDbBootCacheStore(APP);
        const empty = await store.load();
        expect(empty).toEqual({ meta: null, records: [], items: new Map() });
        const write = (expectGeneration: string | null, generation: string): BootCacheWrite => ({
            expectGeneration,
            meta: { format: BOOT_CACHE_FORMAT, appVer: APP, generation },
            clear: false,
            records: [{ kind: "characters", id: "c1", revision: "r", text: "{}" }],
            changed: [{ kind: "characters", id: "c1", revision: "r", text: "{}" }],
            items: new Map(),
        });
        expect(await store.write(write(null, "g1"))).toBe("written");
        expect(await store.write(write(null, "g2"))).toBe("skipped");
        expect(await store.write(write("g1", "g2"))).toBe("written");
        expect(await store.clear("g1")).toBe("skipped");
        expect((await store.load()).records).toHaveLength(1);
        expect(await store.clear("g2")).toBe("cleared");
        const afterClear = await store.load();
        expect(afterClear.records).toEqual([]);
        expect(afterClear.meta?.generation).not.toBe("g2");
        expect(await store.write(write("g2", "g3"))).toBe("skipped");
        expect(await store.clear()).toBe("cleared");
        expect(await store.clear(null)).toBe("skipped");
    });
});

describe("the idle commit", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("runs the commit on a timer without `requestIdleCallback`, settles the measurement promise, and swallows a rejection", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const order: string[] = [];
        const settled = scheduleBootCacheCommit(async () => {
            order.push("commit");
            throw new Error("nope");
        });
        expect(settled).toBe(whenBootCacheSettled());
        order.push("scheduled");
        await settled;
        expect(order).toEqual(["scheduled", "commit"]);
        expect(warn).toHaveBeenCalledWith("[Boot cache]", expect.any(Error));
        await tick();
        // A commit that throws synchronously is survived too.
        await scheduleBootCacheCommit(() => {
            throw new Error("sync");
        });
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("uses `requestIdleCallback` with the deadline where it exists", async () => {
        const calls: unknown[] = [];
        vi.stubGlobal("requestIdleCallback", (callback: () => void, options: unknown) => {
            calls.push(options);
            setTimeout(callback, 0);
            return 1;
        });
        const commit = vi.fn(async () => {});
        await scheduleBootCacheCommit(commit, 123);
        expect(calls).toEqual([{ timeout: 123 }]);
        expect(commit).toHaveBeenCalledTimes(1);
    });
});
