// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_TABLES_SQL } from "../data/chatStore.ts";
import { createKindRegistry, type ResourceKind } from "../data/kinds.ts";
import {
    createResourceStore,
    ResourceBatchConflictError,
    ResourceConflictError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";
import { sleep } from "./testSupport.ts";

const root: ResourceKind = { name: "root", schemaVersion: 1, normalize: (input) => input };
const presets: ResourceKind = { name: "presets", schemaVersion: 2, normalize: (input) => input };
const single: ResourceKind = { name: "single", schemaVersion: 1, singleton: true, normalize: (input) => input };
const kinds = createKindRegistry([root, presets, single]);

const stores: ResourceStore[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
function memoryStore() {
    const store = createResourceStore({ file: ":memory:", kinds });
    stores.push(store);
    return store;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const conflictWith = (fn: () => unknown, current: string | null, label: string) => {
    let error: unknown;
    try {
        fn();
    } catch (e) {
        error = e;
    }
    expect(error, label).toBeInstanceOf(ResourceConflictError);
    expect((error as ResourceConflictError).current, label).toBe(current);
};

describe("revision tokens", () => {
    it("carries the epoch, incarnation, and write count, and refuses tokens from another epoch or incarnation", () => {
        const store = memoryStore();
        const first = store.put(root, "a", 1, null).revision;
        expect(first).toMatch(/^[0-9a-f-]{36}:1:1$/);
        const second = store.put(root, "a", 2, first).revision;
        expect(second).toBe(first.replace(/:1$/, ":2"));
        expect(store.get(root, "a")).toEqual({ revision: second, data: 2 });

        conflictWith(() => store.put(root, "a", 3, first), second, "stale put");
        const otherEpoch = second.replace(uuid, "00000000-0000-4000-8000-000000000000");
        expect(otherEpoch).not.toBe(second);
        conflictWith(() => store.put(root, "a", 3, otherEpoch), second, "other epoch");
        conflictWith(() => store.delete(root, "a", otherEpoch), second, "other epoch delete");
        for (const token of [
            "",
            "x",
            `${second}:1`,
            second.replace(/:1:2$/, ":01:2"),
            second.replace(/:1:2$/, ":9007199254740993:2"),
        ]) {
            conflictWith(() => store.put(root, "a", 3, token), second, `malformed ${token}`);
        }
        expect(store.get(root, "a")).toEqual({ revision: second, data: 2 });

        // A deleted record is a conflict with `current: null`; a recreated one has a new incarnation.
        store.delete(root, "a", second);
        expect(store.get(root, "a")).toBeNull();
        conflictWith(() => store.delete(root, "a", second), null, "delete missing");
        conflictWith(() => store.put(root, "a", 3, second), null, "put missing");
        const recreated = store.put(root, "a", 3, null).revision;
        expect(recreated).toMatch(/:2:1$/);
        conflictWith(() => store.put(root, "a", 4, second), recreated, "old token after recreate");
        conflictWith(() => store.delete(root, "a", second), recreated, "old token delete after recreate");
        conflictWith(() => store.put(root, "a", 4, null), recreated, "duplicate create");
        expect(store.get(root, "a")).toEqual({ revision: recreated, data: 3 });
    });

    it("keeps data, epoch, and tokens across a reopen, and closes idempotently", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-resource-store-"));
        dirs.push(dir);
        const file = path.join(dir, "nested", "resources.sqlite");
        const first = createResourceStore({ file, kinds });
        const token = first.put(presets, "p", { name: "one" }, null).revision;
        first.put(root, "r", 1, null);
        first.close();
        first.close();
        expect(() => first.get(root, "r")).toThrow("Resource store is closed");
        expect(() => first.transaction(() => {})).toThrow("Resource store is closed");

        const second = createResourceStore({ file, kinds });
        stores.push(second);
        expect(second.get(presets, "p")).toEqual({ revision: token, data: { name: "one" } });
        expect(second.list(root)).toEqual([{ id: "r", revision: expect.stringMatching(uuid), data: 1 }]);
        const next = second.put(presets, "p", { name: "two" }, token).revision;
        expect(next.slice(0, 36)).toBe(token.slice(0, 36));
        expect(second.get(presets, "p")).toEqual({ revision: next, data: { name: "two" } });
    });
});

describe("kinds", () => {
    it("refuses kind objects the registry does not hold, even with a registered name", () => {
        const store = memoryStore();
        store.put(root, "a", 1, null);
        const impostor: ResourceKind = { name: "root", schemaVersion: 1, normalize: () => "replaced" };
        const foreign: ResourceKind = { name: "characters", schemaVersion: 1, normalize: (input) => input };
        for (const kind of [impostor, foreign]) {
            const message = `Unregistered resource kind: ${kind.name}`;
            expect(() => store.get(kind, "a")).toThrow(message);
            expect(() => store.list(kind)).toThrow(message);
            expect(() => store.put(kind, "a", 2, null)).toThrow(message);
            expect(() => store.delete(kind, "a", "x")).toThrow(message);
        }
        expect(store.get(root, "a")).toEqual({ revision: expect.any(String), data: 1 });
        expect(store.list(root)).toHaveLength(1);
        expect(store.list(presets)).toEqual([]);
    });

    it("lists in creation order and rejects invalid ids", () => {
        const store = memoryStore();
        for (const id of ["c", "a", "b"]) {
            store.put(root, id, id, null);
        }
        store.put(root, "a", "a2", store.get(root, "a")!.revision);
        expect(store.list(root).map((item) => [item.id, item.data])).toEqual([
            ["c", "c"],
            ["a", "a2"],
            ["b", "b"],
        ]);
        // 1 to 512 UTF-16 units of well-formed Unicode, no control character, not `.` or `..`.
        for (const id of [
            ".",
            "..",
            "",
            "a\u0000",
            "a\tb",
            "\u001fa",
            "a\u007f",
            "\ud800",
            "a\udc00b",
            "a".repeat(513),
        ]) {
            expect(() => store.put(root, id, 1, null), JSON.stringify(id)).toThrow(
                new ResourceValidationError("Invalid resource id"),
            );
            expect(() => store.get(root, id), JSON.stringify(id)).toThrow("Invalid resource id");
        }
        for (const id of [".a", "...", "a/b", "a b", "§playground", "가", "\ud83d\ude00", "a".repeat(512)]) {
            expect(store.put(root, id, id, null).data, JSON.stringify(id)).toBe(id);
            expect(store.get(root, id)!.data, JSON.stringify(id)).toBe(id);
        }
    });

    it("accepts only the id main for a singleton kind and never deletes it", () => {
        const store = memoryStore();
        const message = "single has only the record main";
        expect(() => store.put(single, "other", 1, null)).toThrow(new ResourceValidationError(message));
        expect(() => store.get(single, "other")).toThrow(message);
        expect(() => store.readRefs([{ kind: single, id: "other" }])).toThrow(message);
        expect(() => store.applyBatch([{ kind: single, id: "other", baseRevision: null, data: 1 }])).toThrow(
            new ResourceValidationError(`ops[0]: ${message}`),
        );
        const token = store.put(single, "main", 1, null).revision;
        expect(() => store.delete(single, "main", token)).toThrow(
            new ResourceValidationError("single cannot be deleted"),
        );
        expect(() => store.applyBatch([{ kind: single, id: "main", baseRevision: token, delete: true }])).toThrow(
            new ResourceValidationError("ops[0]: single cannot be deleted"),
        );
        expect(store.get(single, "main")).toEqual({ revision: token, data: 1 });
    });
});

describe("readKinds, readRefs, and applyBatch", () => {
    it("reads several kinds and named refs with the epoch, in one call", () => {
        const store = memoryStore();
        const a = store.put(root, "a", 1, null).revision;
        const p = store.put(presets, "p", 2, null).revision;
        expect(store.readKinds([presets, root])).toEqual({
            epoch: store.epoch(),
            kinds: { presets: [{ id: "p", revision: p, data: 2 }], root: [{ id: "a", revision: a, data: 1 }] },
        });
        expect(store.readKinds([])).toEqual({ epoch: store.epoch(), kinds: {} });
        expect(
            store.readRefs([
                { kind: root, id: "a" },
                { kind: root, id: "missing" },
            ]),
        ).toEqual({
            epoch: store.epoch(),
            items: [
                { kind: "root", id: "a", revision: a, data: 1 },
                { kind: "root", id: "missing", revision: null, data: null },
            ],
            chats: [],
            chatCollections: [],
        });
        const foreign: ResourceKind = { name: "root", schemaVersion: 1, normalize: (input) => input };
        expect(() => store.readKinds([foreign])).toThrow("Unregistered resource kind: root");
        expect(() => store.readRefs([{ kind: foreign, id: "a" }])).toThrow("Unregistered resource kind: root");
    });

    it("validates every operation before writing, applies all or none, and counts the writes", () => {
        const store = memoryStore();
        const a = store.put(root, "a", 1, null).revision;
        const before = store.writeCount();
        expect(() =>
            store.applyBatch([
                { kind: root, id: "b", baseRevision: null, data: 1 },
                { kind: root, id: "c", baseRevision: null, data: { n: NaN } },
            ]),
        ).toThrow(new ResourceValidationError("ops[1]: Resource data contains a non-finite number"));
        expect(() =>
            store.applyBatch([
                { kind: root, id: "b", baseRevision: null, data: 1 },
                { kind: root, id: "b", baseRevision: null, data: 1 },
            ]),
        ).toThrow(new ResourceValidationError("ops[1]: duplicate kind and id"));
        expect(() => store.applyBatch([{ kind: root, id: "a", baseRevision: null, delete: true }])).toThrow(
            new ResourceValidationError("ops[0]: a deletion needs a base revision"),
        );
        expect(store.get(root, "b")).toBeNull();

        let error: unknown;
        try {
            store.applyBatch([
                { kind: root, id: "b", baseRevision: null, data: 1 },
                { kind: root, id: "a", baseRevision: null, data: 2 },
                { kind: root, id: "gone", baseRevision: a, delete: true },
            ]);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ResourceBatchConflictError);
        expect((error as ResourceBatchConflictError).conflicts).toEqual([
            { kind: "root", id: "a", revision: a },
            { kind: "root", id: "gone", revision: null },
        ]);
        expect(store.get(root, "b")).toBeNull();
        expect(store.writeCount()).toBe(before);

        const results = store.applyBatch([
            { kind: root, id: "b", baseRevision: null, data: 1 },
            { kind: root, id: "a", baseRevision: a, data: 2 },
            { kind: presets, id: "p", baseRevision: null, data: 3 },
        ]);
        expect(results).toEqual([
            { kind: "root", id: "b", revision: expect.stringMatching(/:2:1$/) },
            { kind: "root", id: "a", revision: a.replace(/:1$/, ":2") },
            { kind: "presets", id: "p", revision: expect.stringMatching(/:3:1$/) },
        ]);
        expect(store.writeCount()).toBe(before + 3);
        expect(store.applyBatch([{ kind: root, id: "b", baseRevision: results[0].revision!, delete: true }])).toEqual([
            { kind: "root", id: "b", revision: null },
        ]);
        expect(store.get(root, "b")).toBeNull();
        expect(() => store.transaction(() => store.applyBatch([]))).toThrow(
            "Nested resource transactions are not supported",
        );
    });
});

describe("snapshots", () => {
    function tempDir() {
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-resource-store-"));
        dirs.push(dir);
        return dir;
    }
    function fileStore(dir: string, name = "live.sqlite") {
        const store = createResourceStore({ file: path.join(dir, name), kinds });
        stores.push(store);
        return store;
    }

    it("refuses a put that would overflow the revision counter before it writes, even when a transaction body swallows the error", () => {
        const dir = tempDir();
        const store = fileStore(dir);
        store.put(root, "main", { a: 1 }, null);
        store.close();
        // A restored snapshot can carry a counter at the limit.
        const db = new DatabaseSync(path.join(dir, "live.sqlite"));
        db.exec(`UPDATE resources SET revision = ${Number.MAX_SAFE_INTEGER}`);
        db.close();
        const reopened = fileStore(dir);
        const token = reopened.get(root, "main")!.revision;
        expect(() => reopened.put(root, "main", { a: 2 }, token)).toThrow("Revision counter exhausted");
        // Inside a transaction whose body catches the error, nothing may have been written either:
        // a committed counter past the limit makes every later read of the kind throw.
        reopened.transaction(() => {
            try {
                reopened.put(root, "main", { a: 3 }, token);
            } catch {}
        });
        expect(reopened.get(root, "main")).toEqual({ revision: token, data: { a: 1 } });
        expect(reopened.readKinds([root]).kinds.root.map((record) => record.revision)).toEqual([token]);
    });

    it("deletes the records of a retired kind when it opens", () => {
        const dir = tempDir();
        const store = fileStore(dir);
        store.put(root, "main", { a: 1 }, null);
        store.close();
        // A database written while `customSidebarItems` was still a kind.
        const db = new DatabaseSync(path.join(dir, "live.sqlite"));
        db.exec(
            "INSERT INTO resources (kind, id, revision, schemaVersion, data) VALUES ('customSidebarItems', 'main', 1, 1, '[]')",
        );
        db.close();
        const reopened = fileStore(dir);
        // The deletion counts as a write, so the snapshot scheduler sees the change.
        expect(reopened.writeCount()).toBe(1);
        expect(reopened.listRevisions().resources.map((row) => row.kind)).toEqual(["root"]);
        reopened.close();
        const check = new DatabaseSync(path.join(dir, "live.sqlite"));
        expect(check.prepare("SELECT kind FROM resources").all()).toEqual([{ kind: "root" }]);
        check.close();
    });

    /** Runs SQL against a new file and returns its path. */
    function craft(dir: string, name: string, sql: string) {
        const file = path.join(dir, name);
        const db = new DatabaseSync(file);
        try {
            db.exec(sql);
        } finally {
            db.close();
        }
        return file;
    }
    /** The version-3 layout: `resources`, `meta`, and the chat tables (the same tables as version 2). */
    const layout = `
        PRAGMA user_version = 3;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE resources (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
            revision INTEGER NOT NULL, schemaVersion INTEGER NOT NULL, data TEXT NOT NULL
        ) STRICT;
        ${CHAT_TABLES_SQL}
        INSERT INTO meta (key, value) VALUES ('epoch', 'e');`;
    const notResource = new ResourceValidationError("Not a resource database");
    const noChats = { chats: [], messages: [], chatOrders: [] };

    it("copies the live database to one self-contained file that reads back as a snapshot", async () => {
        const dir = tempDir();
        const store = fileStore(dir);
        store.put(root, "b", { v: "b" }, null);
        store.put(root, "a", { v: "a" }, null);
        store.put(root, "a", { v: "a2" }, store.get(root, "a")!.revision);
        const copy = path.join(dir, "copy.sqlite");
        await store.backupTo(copy);
        expect(readdirSync(dir).sort()).toEqual(["copy.sqlite", "live.sqlite", "live.sqlite-shm", "live.sqlite-wal"]);
        expect(store.readSnapshot(copy)).toEqual({
            rows: [
                { kind: "root", id: "b", revision: 1, schemaVersion: 1, text: '{"v":"b"}' },
                { kind: "root", id: "a", revision: 2, schemaVersion: 1, text: '{"v":"a2"}' },
            ],
            ...noChats,
        });
        // A fresh store's copy is a valid, empty snapshot.
        const empty = fileStore(dir, "empty.sqlite");
        await empty.backupTo(path.join(dir, "empty-copy.sqlite"));
        expect(empty.readSnapshot(path.join(dir, "empty-copy.sqlite"))).toEqual({ rows: [], ...noChats });
        store.close();
        await expect(store.backupTo(path.join(dir, "late.sqlite"))).rejects.toThrow("Resource store is closed");
    });

    it("refuses files that are not this store's layout: garbage, other versions, views, missing epoch, other columns", () => {
        const dir = tempDir();
        const store = fileStore(dir);
        writeFileSync(path.join(dir, "garbage.sqlite"), "not a database at all, but long enough to have a header");
        writeFileSync(path.join(dir, "empty.sqlite"), "");
        const cases: [string, string, ResourceValidationError][] = [
            ["missing", path.join(dir, "missing.sqlite"), notResource],
            ["garbage", path.join(dir, "garbage.sqlite"), notResource],
            [
                "empty file",
                path.join(dir, "empty.sqlite"),
                new ResourceValidationError("Unsupported resource database version 0"),
            ],
            [
                "version 1 (chats inside characters)",
                craft(dir, "v1.sqlite", layout.replace("user_version = 3", "user_version = 1")),
                new ResourceValidationError("Unsupported resource database version 1"),
            ],
            [
                "other version (2: settings in a root record)",
                craft(dir, "v2.sqlite", layout.replace("user_version = 3", "user_version = 2")),
                new ResourceValidationError("Unsupported resource database version 2"),
            ],
            [
                "view",
                craft(
                    dir,
                    "view.sqlite",
                    layout.replace(
                        /CREATE TABLE resources \([^;]*;/,
                        `CREATE TABLE t (a);
                         CREATE VIEW resources AS SELECT 1 AS seq, 'root' AS kind, 'x' AS id, 1 AS revision, 1 AS schemaVersion, '1' AS data FROM t;`,
                    ),
                ),
                notResource,
            ],
            ["no chat tables", craft(dir, "nochats.sqlite", layout.replace(CHAT_TABLES_SQL, "")), notResource],
            [
                "chat table column missing",
                craft(dir, "nofence.sqlite", layout.replace("generationHistory TEXT,", "")),
                notResource,
            ],
            [
                "no meta",
                craft(
                    dir,
                    "nometa.sqlite",
                    layout.replace(/CREATE TABLE meta[^;]*;/, "").replace(/INSERT INTO meta[^;]*;/, ""),
                ),
                notResource,
            ],
            ["no epoch", craft(dir, "noepoch.sqlite", layout.replace(/INSERT INTO meta[^;]*;/, "")), notResource],
            [
                "extra column",
                craft(dir, "extra.sqlite", layout.replace("data TEXT NOT NULL", "data TEXT NOT NULL, extra TEXT")),
                notResource,
            ],
            [
                "other column order",
                craft(
                    dir,
                    "order.sqlite",
                    layout.replace("kind TEXT NOT NULL, id TEXT NOT NULL", "id TEXT NOT NULL, kind TEXT NOT NULL"),
                ),
                notResource,
            ],
        ];
        for (const [label, file, error] of cases) {
            expect(() => store.readSnapshot(file), label).toThrow(error);
        }
        expect(store.readSnapshot(craft(dir, "ok.sqlite", layout))).toEqual({ rows: [], ...noChats });
    });

    it("checks every row: kind, schema version, id and singleton rules, uniqueness, seq and revision, JSON, and the normalizer", () => {
        const dir = tempDir();
        const store = fileStore(dir);
        const withRows = (name: string, rows: string) =>
            craft(
                dir,
                name,
                `${layout.replace(",\n            UNIQUE (kind, id)", "")} INSERT INTO resources (seq, kind, id, revision, schemaVersion, data) VALUES ${rows};`,
            );
        const cases: [string, string, string][] = [
            ["unknown kind", "(1, 'nope', 'a', 1, 1, '1')", "row 1: unknown kind"],
            ["schema version", "(1, 'presets', 'a', 1, 1, '1')", "row 1: unsupported schema version"],
            ["invalid id", "(1, 'root', '..', 1, 1, '1')", "row 1: invalid id"],
            ["singleton id", "(1, 'single', 'other', 1, 1, '1')", "row 1: invalid id"],
            ["duplicate", "(1, 'root', 'a', 1, 1, '1'), (2, 'root', 'a', 1, 1, '2')", "row 2: duplicate kind and id"],
            ["zero seq", "(0, 'root', 'a', 1, 1, '1')", "row 1: invalid seq or revision"],
            ["zero revision", "(1, 'root', 'a', 0, 1, '1')", "row 1: invalid seq or revision"],
            ["not JSON", "(1, 'root', 'a', 1, 1, '{')", "row 1: data is not JSON"],
            [
                "deep JSON",
                `(1, 'root', 'a', 1, 1, '${"[".repeat(257)}1${"]".repeat(257)}')`,
                "row 1: Resource data is nested deeper than 256 levels",
            ],
            ["later row", "(1, 'root', 'a', 1, 1, '1'), (5, 'root', 'b', 3, 1, 'x')", "row 2: data is not JSON"],
        ];
        for (const [label, rows, message] of cases) {
            expect(() => store.readSnapshot(withRows(`${label.replace(/ /g, "-")}.sqlite`, rows)), label).toThrow(
                new ResourceValidationError(message),
            );
        }
        // Rows come back in seq order, normalized and re-serialized; a retired kind's rows are skipped
        // unchecked.
        expect(
            store.readSnapshot(
                withRows(
                    "ok.sqlite",
                    "(7, 'root', 'b', 2, 1, '{\"b\": 1}'), (3, 'presets', 'p', 1, 2, '[]'), (5, 'customSidebarItems', 'main', 1, 9, '{')",
                ),
            ).rows,
        ).toEqual([
            { kind: "presets", id: "p", revision: 1, schemaVersion: 2, text: "[]" },
            { kind: "root", id: "b", revision: 2, schemaVersion: 1, text: '{"b":1}' },
        ]);
    });

    it("replaceAll swaps every row in one transaction with a new epoch, or changes nothing when it fails", async () => {
        const dir = tempDir();
        const store = fileStore(dir);
        store.put(root, "old", 1, null);
        const source = fileStore(dir, "source.sqlite");
        source.put(root, "b", { v: "b" }, null);
        source.put(root, "a", { v: "a" }, null);
        source.put(presets, "p", [], null);
        await source.backupTo(path.join(dir, "source-copy.sqlite"));
        const validated = store.readSnapshot(path.join(dir, "source-copy.sqlite"));

        const oldEpoch = store.epoch();
        const oldToken = store.get(root, "old")!.revision;
        const before = store.writeCount();
        const epoch = store.replaceAll(validated);
        expect(epoch).not.toBe(oldEpoch);
        expect(store.epoch()).toBe(epoch);
        expect(store.writeCount()).toBe(before + 1);
        expect(store.list(root).map((r) => [r.id, r.data])).toEqual([
            ["b", { v: "b" }],
            ["a", { v: "a" }],
        ]);
        expect(store.list(presets).map((r) => r.id)).toEqual(["p"]);
        for (const item of [...store.list(root), ...store.list(presets)]) {
            expect(item.revision.startsWith(`${epoch}:`), item.id).toBe(true);
        }
        // Every token from before is stale, including a create based on the old state.
        conflictWith(() => store.put(root, "old", 2, oldToken), null, "old token");
        conflictWith(() => store.put(root, "a", 2, validated.rows[1].text), store.get(root, "a")!.revision, "text");

        // The epoch survives a reopen.
        store.close();
        const reopened = fileStore(dir);
        expect(reopened.epoch()).toBe(epoch);
        expect(reopened.list(root).map((r) => r.id)).toEqual(["b", "a"]);

        // A failing insert (the live UNIQUE constraint) rolls the whole replacement back.
        const failing = {
            rows: [
                { kind: "root", id: "dup", revision: 1, schemaVersion: 1, text: "1" },
                { kind: "root", id: "dup", revision: 1, schemaVersion: 1, text: "2" },
            ],
            ...noChats,
        };
        const count = reopened.writeCount();
        expect(() => reopened.replaceAll(failing)).toThrow("UNIQUE constraint failed");
        expect(reopened.epoch()).toBe(epoch);
        expect(reopened.writeCount()).toBe(count);
        expect(reopened.list(root).map((r) => r.id)).toEqual(["b", "a"]);
        expect(() => reopened.transaction(() => reopened.replaceAll({ rows: [], ...noChats }))).toThrow(
            "Nested resource transactions are not supported",
        );
        expect(reopened.list(root)).toHaveLength(2);
    });
});

describe("serialization", () => {
    it("stores the JSON.stringify form and returns it from put and get", () => {
        const store = memoryStore();
        const value = {
            when: new Date(0),
            gone: undefined,
            boxed: new Number(3),
            custom: { toJSON: () => "j" },
            list: [undefined, () => 1, new Number(4)],
        };
        const stored = store.put(root, "v", value, null).data;
        expect(stored).toEqual({ when: "1970-01-01T00:00:00.000Z", boxed: 3, custom: "j", list: [null, null, 4] });
        expect(store.get(root, "v")!.data).toEqual(stored);
        expect(store.list(root)[0].data).toEqual(stored);
    });

    it("refuses values whose JSON form would lose a non-finite number", () => {
        const store = memoryStore();
        const nonFinite: [string, unknown][] = [
            ["Infinity", Infinity],
            ["nested NaN", { a: [NaN] }],
            ["toJSON Infinity", { toJSON: () => Infinity }],
            ["boxed Infinity", new Number(Infinity)],
            ["boxed NaN", { n: new Number(NaN) }],
            ["symbol-coerced Infinity", Object.assign(new Number(1), { [Symbol.toPrimitive]: () => Infinity })],
        ];
        const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
        if (rawJSON) {
            nonFinite.push(["rawJSON overflow", { n: rawJSON("1e400") }]);
        }
        for (const [label, value] of nonFinite) {
            expect(() => store.put(root, "v", value, null), label).toThrow(
                new ResourceValidationError("Resource data contains a non-finite number"),
            );
        }
        expect(store.get(root, "v")).toBeNull();
    });

    it("refuses values JSON.stringify cannot serialize, including a Number box whose conversion hook returns a bigint", () => {
        const store = memoryStore();
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        const unserializable: [string, unknown][] = [
            ["bigint", 1n],
            ["nested bigint", { n: 1n }],
            ["cycle", cycle],
            [
                "throwing getter",
                {
                    get x(): number {
                        throw new Error("boom");
                    },
                },
            ],
            ["valueOf bigint box", Object.assign(new Number(0), { valueOf: () => 9007199254740993n })],
            ["toPrimitive bigint box", Object.assign(new Number(0), { [Symbol.toPrimitive]: () => 9007199254740993n })],
        ];
        for (const [label, value] of unserializable) {
            expect(() => JSON.stringify(value), label).toThrow();
            expect(() => store.put(root, "v", value, null), label).toThrow(
                new ResourceValidationError("Resource data is not serializable as JSON"),
            );
        }
        for (const [label, value] of [
            ["undefined", undefined],
            ["function", () => 1],
            ["symbol", Symbol("s")],
        ] as [string, unknown][]) {
            expect(() => store.put(root, "v", value, null), label).toThrow(
                new ResourceValidationError("Resource data is not JSON"),
            );
        }
        expect(store.get(root, "v")).toBeNull();
    });

    it("allows 256 levels of nesting and refuses 257, judged on the JSON form", () => {
        const store = memoryStore();
        const nested = (depth: number): unknown => (depth === 0 ? 1 : [nested(depth - 1)]);
        expect(store.put(root, "ok", nested(256), null).data).toEqual(nested(256));
        expect(() => store.put(root, "deep", nested(257), null)).toThrow(
            new ResourceValidationError("Resource data is nested deeper than 256 levels"),
        );
        // `toJSON` output counts, not the value handed in.
        expect(() => store.put(root, "deep", { toJSON: () => nested(257) }, null)).toThrow(ResourceValidationError);
        expect(store.get(root, "deep")).toBeNull();
    });

    it("runs the kind's normalizer and stores its result", () => {
        const trimmed: ResourceKind<string> = {
            name: "names",
            schemaVersion: 1,
            normalize(input) {
                if (typeof input !== "string") {
                    throw new ResourceValidationError("Name must be a string");
                }
                return input.trim();
            },
        };
        const store = createResourceStore({ file: ":memory:", kinds: createKindRegistry([trimmed]) });
        stores.push(store);
        expect(() => store.put(trimmed, "n", 1, null)).toThrow(new ResourceValidationError("Name must be a string"));
        expect(store.get(trimmed, "n")).toBeNull();
        const { revision, data } = store.put(trimmed, "n", "  Alice ", null);
        expect(data).toBe("Alice");
        expect(store.get(trimmed, "n")).toEqual({ revision, data: "Alice" });
    });
});

describe("transaction", () => {
    it("commits every write when the body returns and rolls all of them back when it throws", () => {
        const store = memoryStore();
        expect(
            store.transaction(() => {
                store.put(root, "a", 1, null);
                store.put(presets, "p", 2, null);
                return "done";
            }),
        ).toBe("done");
        expect(store.get(root, "a")!.data).toBe(1);
        expect(store.get(presets, "p")!.data).toBe(2);

        expect(() =>
            store.transaction(() => {
                store.put(root, "a", 10, store.get(root, "a")!.revision);
                store.put(root, "b", 3, null);
                throw new Error("body failed");
            }),
        ).toThrow("body failed");
        expect(store.get(root, "a")!.data).toBe(1);
        expect(store.get(root, "b")).toBeNull();
    });

    it("rejects a nested transaction and stays usable afterwards", () => {
        const store = memoryStore();
        expect(() =>
            store.transaction(() => {
                store.put(root, "a", 1, null);
                store.transaction(() => {});
            }),
        ).toThrow("Nested resource transactions are not supported");
        expect(store.get(root, "a")).toBeNull();
        store.transaction(() => store.put(root, "a", 1, null));
        expect(store.get(root, "a")!.data).toBe(1);
    });

    it("refuses to commit after a conflict the body caught", () => {
        const store = memoryStore();
        const existing = store.put(root, "exists", 1, null).revision;
        let caught: unknown;
        conflictWith(
            () =>
                store.transaction(() => {
                    store.put(root, "new", 1, null);
                    try {
                        store.put(root, "exists", 2, null);
                    } catch (error) {
                        caught = error;
                    }
                    store.put(root, "later", 1, null);
                    return "ignored";
                }),
            existing,
            "transaction",
        );
        expect(caught).toBeInstanceOf(ResourceConflictError);
        expect(store.get(root, "new")).toBeNull();
        expect(store.get(root, "later")).toBeNull();
        expect(store.get(root, "exists")).toEqual({ revision: existing, data: 1 });
    });

    it("rolls back a body that returns a promise or a thenable and rejects the continuation's write", async () => {
        const store = memoryStore();
        const late: string[] = [];
        const lateWrite = (id: string) => {
            try {
                store.put(root, id, 2, null);
                late.push(`${id}: wrote`);
            } catch (error) {
                late.push(`${id}: ${(error as Error).message}`);
            }
        };
        const asyncBody = async () => {
            store.put(root, "a", 1, null);
            await Promise.resolve();
            lateWrite("a-late");
        };
        expect(() => store.transaction(asyncBody as unknown as () => void)).toThrow(
            "Resource transactions must be synchronous",
        );

        const thenableBody = () => {
            store.put(root, "b", 1, null);
            return {
                then(_onFulfilled: unknown, onRejected: (reason: unknown) => void) {
                    queueMicrotask(() => {
                        lateWrite("b-late");
                        onRejected(new Error("thenable"));
                    });
                },
            };
        };
        expect(() => store.transaction(thenableBody)).toThrow("Resource transactions must be synchronous");

        await sleep(10);
        expect(late).toEqual([
            "a-late: Resource transaction already ended",
            "b-late: Resource transaction already ended",
        ]);
        for (const id of ["a", "a-late", "b", "b-late"]) {
            expect(store.get(root, id), id).toBeNull();
        }
        // The store is usable after the rollback.
        expect(store.put(root, "a", 1, null).data).toBe(1);
    });

    it("rejects a timer write the body scheduled, even after the commit", async () => {
        const store = memoryStore();
        const late: string[] = [];
        store.transaction(() => {
            store.put(root, "a", 1, null);
            setTimeout(() => {
                try {
                    store.put(root, "timer", 2, null);
                    late.push("wrote");
                } catch (error) {
                    late.push((error as Error).message);
                }
            }, 0);
        });
        expect(store.get(root, "a")!.data).toBe(1);
        await sleep(10);
        expect(late).toEqual(["Resource transaction already ended"]);
        expect(store.get(root, "timer")).toBeNull();
        expect(store.put(root, "timer", 2, null).data).toBe(2);
    });

    it("rolls back when the returned value's `then` getter throws or `then` writes synchronously", () => {
        const store = memoryStore();
        expect(() =>
            store.transaction(() => {
                store.put(root, "a", 1, null);
                return {
                    get then(): unknown {
                        store.put(root, "getter", 2, null);
                        throw new Error("getter");
                    },
                };
            }),
        ).toThrow("getter");
        expect(() =>
            store.transaction(() => {
                store.put(root, "b", 1, null);
                return {
                    then() {
                        store.put(root, "sync", 2, null);
                    },
                };
            }),
        ).toThrow("Resource transactions must be synchronous");
        for (const id of ["a", "getter", "b", "sync"]) {
            expect(store.get(root, id), id).toBeNull();
        }
    });

    it("rejects promise-returning bodies at compile time and accepts never and any", () => {
        const store = memoryStore();
        const compileOnly = () => {
            // @ts-expect-error an async body does not type-check
            store.transaction(async () => 1);
            // @ts-expect-error a body that may return a promise does not type-check
            store.transaction((): number | Promise<number> => 1);
        };
        expect(compileOnly).toBeTypeOf("function");
        expect(() =>
            store.transaction((): never => {
                throw new Error("never");
            }),
        ).toThrow("never");
        const parsed: unknown = store.transaction(() => JSON.parse('{"ok":true}'));
        expect(parsed).toEqual({ ok: true });
        expect(store.transaction(() => {})).toBeUndefined();
    });
});

// A batch op may carry a field `patch` of an object record (store-internal; the send
// job's `lastInteraction` stamp). It is checked before the transaction, applied at its base revision
// inside it, normalized and stored like a write, and counted as one. What the feed carries for it is
// in `changeFeed.test.ts`.
describe("field patches", () => {
    /** A normalizer with side effects outside the patch: `temp` is dropped, `count` is derived. */
    const counted: ResourceKind = {
        name: "counted",
        schemaVersion: 1,
        normalize: (input) => {
            const out = { ...(input as Record<string, unknown>) };
            delete out.temp;
            out.count = Object.keys(out).filter((key) => key !== "count").length;
            return out;
        },
    };
    /** A normalizer that refuses a result (the character normalizer refusing a changed `chaId`). */
    const strict: ResourceKind = {
        name: "strict",
        schemaVersion: 1,
        normalize: (input) => {
            if ((input as Record<string, unknown>).bad !== undefined) {
                throw new ResourceValidationError("bad is not allowed");
            }
            return input;
        },
    };
    function patchStore() {
        const store = createResourceStore({ file: ":memory:", kinds: createKindRegistry([root, counted, strict]) });
        stores.push(store);
        return store;
    }

    it("assigns and deletes top-level fields at the base revision, normalizes the result, and advances the revision by one", () => {
        const store = patchStore();
        const base = store.put(root, "a", { keep: 1, change: 2, drop: 3 }, null).revision;
        expect(store.revisionOf(root, "a")).toBe(base);
        expect(store.revisionOf(root, "missing")).toBeNull();
        const before = store.writeCount();
        const [result] = store.applyBatch([
            {
                kind: root,
                id: "a",
                baseRevision: base,
                patch: { set: { change: 20, added: { nested: true } }, remove: ["drop"] },
            },
        ]);
        expect(result).toEqual({ kind: "root", id: "a", revision: base.replace(/:1$/, ":2") });
        expect(store.get(root, "a")).toEqual({
            revision: result.revision,
            data: { keep: 1, change: 20, added: { nested: true } },
        });
        expect(store.revisionOf(root, "a")).toBe(result.revision);
        expect(store.writeCount()).toBe(before + 1);

        // A set-only and a remove-only patch; a set of `undefined` stores nothing for the field.
        const setOnly = store.applyBatch([
            { kind: root, id: "a", baseRevision: result.revision, patch: { set: { keep: undefined, more: "x" } } },
        ])[0].revision!;
        expect(store.get(root, "a")!.data).toEqual({ change: 20, added: { nested: true }, more: "x" });
        const removeOnly = store.applyBatch([
            { kind: root, id: "a", baseRevision: setOnly, patch: { remove: ["added", "never-there"] } },
        ])[0].revision!;
        expect(store.get(root, "a")).toEqual({ revision: removeOnly, data: { change: 20, more: "x" } });

        // The normalizer runs on the patched record: its side effects are stored with the patch.
        const c = store.put(counted, "c", { x: 1, temp: "gone" }, null);
        expect(c.data).toEqual({ x: 1, count: 1 });
        const patched = store.applyBatch([
            { kind: counted, id: "c", baseRevision: c.revision, patch: { set: { temp: "again", y: 2 } } },
        ])[0].revision!;
        expect(store.get(counted, "c")).toEqual({ revision: patched, data: { x: 1, count: 2, y: 2 } });
    });

    it("refuses an invalid patch op before writing anything, naming the op", () => {
        const store = patchStore();
        const base = store.put(root, "a", { n: 1 }, null).revision;
        const before = store.writeCount();
        const refused: [unknown, string][] = [
            [
                { kind: root, id: "a", baseRevision: base, patch: { set: { n: 2 } }, data: { n: 2 } },
                "a patch has no data and no deletion",
            ],
            [
                { kind: root, id: "a", baseRevision: base, patch: { set: { n: 2 } }, delete: false },
                "a patch has no data and no deletion",
            ],
            [{ kind: root, id: "a", baseRevision: null, patch: { set: { n: 2 } } }, "a patch needs a base revision"],
            [
                { kind: root, id: "a", baseRevision: base, patch: null },
                "a patch is { set?, remove? } or { items?, changes?, order? }",
            ],
            [
                { kind: root, id: "a", baseRevision: base, patch: undefined },
                "a patch is { set?, remove? } or { items?, changes?, order? }",
            ],
            [
                { kind: root, id: "a", baseRevision: base, patch: [] },
                "a patch is { set?, remove? } or { items?, changes?, order? }",
            ],
            [
                { kind: root, id: "a", baseRevision: base, patch: { set: [1] } },
                "a patch is { set?: object, remove?: string[] }",
            ],
            [
                { kind: root, id: "a", baseRevision: base, patch: { remove: "n" } },
                "a patch is { set?: object, remove?: string[] }",
            ],
            [
                { kind: root, id: "a", baseRevision: base, patch: { remove: [1] } },
                "a patch is { set?: object, remove?: string[] }",
            ],
            [{ kind: root, id: "a", baseRevision: base, patch: {} }, "a patch names no field"],
            [{ kind: root, id: "a", baseRevision: base, patch: { set: {}, remove: [] } }, "a patch names no field"],
            [
                { kind: root, id: "a", baseRevision: base, patch: { set: { n: 2 }, remove: ["n"] } },
                "a patch names a field twice or names __proto__",
            ],
            [
                { kind: root, id: "a", baseRevision: base, patch: { remove: ["n", "n"] } },
                "a patch names a field twice or names __proto__",
            ],
            [
                { kind: root, id: "a", baseRevision: base, patch: { set: JSON.parse('{"__proto__": 1}') } },
                "a patch names a field twice or names __proto__",
            ],
            [
                { kind: root, id: "a", baseRevision: base, patch: { remove: ["__proto__"] } },
                "a patch names a field twice or names __proto__",
            ],
        ];
        for (const [op, message] of refused) {
            expect(() => store.applyBatch([{ kind: root, id: "b", baseRevision: null, data: 1 }, op as never])).toThrow(
                new ResourceValidationError(`ops[1]: ${message}`),
            );
        }
        // A patch op may not share the batch with another op on the same record.
        expect(() =>
            store.applyBatch([
                { kind: root, id: "a", baseRevision: base, data: { n: 3 } },
                { kind: root, id: "a", baseRevision: base, patch: { set: { n: 2 } } },
            ]),
        ).toThrow(new ResourceValidationError("ops[1]: duplicate kind and id"));
        expect(store.get(root, "a")).toEqual({ revision: base, data: { n: 1 } });
        expect(store.get(root, "b")).toBeNull();
        expect(store.writeCount()).toBe(before);
    });

    it("conflicts on a stale or missing base, all or none with the other ops, and lists the current revision", () => {
        const store = patchStore();
        const first = store.put(root, "a", { n: 1 }, null).revision;
        const second = store.put(root, "a", { n: 2 }, first).revision;
        const before = store.writeCount();
        for (const [op, current] of [
            [{ kind: root, id: "a", baseRevision: first, patch: { set: { n: 3 } } }, second],
            [{ kind: root, id: "gone", baseRevision: first, patch: { set: { n: 3 } } }, null],
            [{ kind: root, id: "a", baseRevision: "not-a-token", patch: { set: { n: 3 } } }, second],
        ] as const) {
            let error: unknown;
            try {
                store.applyBatch([{ kind: root, id: "b", baseRevision: null, data: 1 }, op]);
            } catch (e) {
                error = e;
            }
            expect(error).toBeInstanceOf(ResourceBatchConflictError);
            expect((error as ResourceBatchConflictError).conflicts).toEqual([
                { kind: "root", id: op.id, revision: current },
            ]);
        }
        expect(store.get(root, "a")).toEqual({ revision: second, data: { n: 2 } });
        expect(store.get(root, "b")).toBeNull();
        expect(store.writeCount()).toBe(before);
    });

    it("rolls back a patch of a record that is not an object, or whose result the kind refuses, with the other ops", () => {
        const store = patchStore();
        const number = store.put(root, "n", 1, null).revision;
        const list = store.put(root, "l", [1, 2], null).revision;
        const ok = store.put(strict, "s", { good: 1 }, null).revision;
        const before = store.writeCount();
        for (const [op, message] of [
            [
                { kind: root, id: "n", baseRevision: number, patch: { set: { x: 1 } } },
                "ops[1]: a field patch needs an object record",
            ],
            [
                { kind: root, id: "l", baseRevision: list, patch: { set: { x: 1 } } },
                "ops[1]: a field patch needs an object record",
            ],
            [{ kind: strict, id: "s", baseRevision: ok, patch: { set: { bad: true } } }, "ops[1]: bad is not allowed"],
            [
                { kind: strict, id: "s", baseRevision: ok, patch: { set: { x: NaN } } },
                "ops[1]: Resource data contains a non-finite number",
            ],
        ] as const) {
            expect(() => store.applyBatch([{ kind: root, id: "b", baseRevision: null, data: 1 }, op])).toThrow(
                new ResourceValidationError(message),
            );
        }
        expect(store.get(root, "n")).toEqual({ revision: number, data: 1 });
        expect(store.get(root, "l")).toEqual({ revision: list, data: [1, 2] });
        expect(store.get(strict, "s")).toEqual({ revision: ok, data: { good: 1 } });
        expect(store.get(root, "b")).toBeNull();
        expect(store.writeCount()).toBe(before);
        // The store is usable after the rollback.
        expect(
            store.applyBatch([{ kind: strict, id: "s", baseRevision: ok, patch: { set: { good: 2 } } }])[0].revision,
        ).toBe(ok.replace(/:1$/, ":2"));
    });

    it("revisionOf checks the kind and the id like a read", () => {
        const store = patchStore();
        const foreign: ResourceKind = { name: "root", schemaVersion: 1, normalize: (input) => input };
        expect(() => store.revisionOf(foreign, "a")).toThrow("Unregistered resource kind: root");
        expect(() => store.revisionOf(root, "")).toThrow(ResourceValidationError);
        store.close();
        expect(() => store.revisionOf(root, "a")).toThrow();
    });
});

// A batch op may carry an item `patch` of an array record whose items are objects
// with unique non-empty string ids (`modules`): `items` put whole by id, `changes` as field patches
// of base items, and `order` the exact id sequence. Checked before the transaction
// (`checkItemPatch`), applied at the base revision inside it (`applyItemPatch`), normalized and
// stored like a write. A kind with `project` or `prepareWrite` takes no patch of either form.
describe("item patches", () => {
    const list: ResourceKind = { name: "list", schemaVersion: 1, normalize: (input) => input };
    /** A normalizer that refuses an item named `bad` (the modules normalizer refusing a shape). */
    const strictList: ResourceKind = {
        name: "strictList",
        schemaVersion: 1,
        normalize: (input) => {
            if ((input as { name?: unknown }[]).some((item) => item.name === "bad")) {
                throw new ResourceValidationError("bad is not allowed");
            }
            return input;
        },
    };
    const masked: ResourceKind = {
        name: "masked",
        schemaVersion: 1,
        normalize: (input) => input,
        project: (data) => data,
    };
    const prepared: ResourceKind = {
        name: "prepared",
        schemaVersion: 1,
        normalize: (input) => input,
        prepareWrite: (incoming) => incoming,
    };
    const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, ...extra });
    function itemStore() {
        const store = createResourceStore({
            file: ":memory:",
            kinds: createKindRegistry([root, list, strictList, masked, prepared]),
        });
        stores.push(store);
        return store;
    }
    const patch = (store: ResourceStore, kind: ResourceKind, id: string, body: unknown) =>
        store.applyBatch([{ kind, id, baseRevision: store.revisionOf(kind, id), patch: body }])[0].revision!;

    it("replaces items by id, patches their fields, adds, reorders, and removes with an explicit order, and clears with an empty one", () => {
        const store = itemStore();
        const base = store.put(list, "l", [item("a", { n: 1 }), item("b"), item("c")], null).revision;
        const before = store.writeCount();
        // A whole item by id and a field patch of another, no order: the id sequence is the base's.
        const first = patch(store, list, "l", {
            items: [{ id: "c", replaced: true }],
            changes: [{ id: "a", set: { n: 2, added: [1] }, remove: ["name", "never-there"] }],
        });
        expect(first).toBe(base.replace(/:1$/, ":2"));
        expect(store.get(list, "l")!.data).toEqual([
            { id: "a", n: 2, added: [1] },
            item("b"),
            { id: "c", replaced: true },
        ]);
        expect(store.writeCount()).toBe(before + 1);
        // A new item needs an order; the order moves, keeps, and drops items.
        patch(store, list, "l", { items: [item("d")], order: ["d", "c", "a"] });
        expect(store.get(list, "l")!.data).toEqual([
            item("d"),
            { id: "c", replaced: true },
            { id: "a", n: 2, added: [1] },
        ]);
        // An order alone reorders; a change and an order together.
        patch(store, list, "l", { order: ["a", "d", "c"] });
        expect((store.get(list, "l")!.data as { id: string }[]).map((entry) => entry.id)).toEqual(["a", "d", "c"]);
        patch(store, list, "l", { changes: [{ id: "d", set: { name: "D" } }], order: ["d"] });
        expect(store.get(list, "l")!.data).toEqual([{ id: "d", name: "D" }]);
        // Ids named like `Object.prototype` members are values, not keys: they work as any other.
        patch(store, list, "l", {
            items: [item("__proto__"), item("constructor")],
            order: ["constructor", "__proto__", "d"],
        });
        expect((store.get(list, "l")!.data as { id: string }[]).map((entry) => entry.id)).toEqual([
            "constructor",
            "__proto__",
            "d",
        ]);
        patch(store, list, "l", { changes: [{ id: "__proto__", set: { n: 1 } }] });
        expect((store.get(list, "l")!.data as unknown[])[1]).toEqual({ id: "__proto__", name: "__proto__", n: 1 });
        // An empty order clears the record (a valid patch: `order` is present).
        const cleared = patch(store, list, "l", { order: [] });
        expect(store.get(list, "l")).toEqual({ revision: cleared, data: [] });
        // A list kind's normalizer runs on the result: a refused result rolls the batch back.
        const ok = store.put(strictList, "s", [item("a")], null).revision;
        const count = store.writeCount();
        expect(() =>
            store.applyBatch([
                { kind: root, id: "r", baseRevision: null, data: 1 },
                {
                    kind: strictList,
                    id: "s",
                    baseRevision: ok,
                    patch: { changes: [{ id: "a", set: { name: "bad" } }] },
                },
            ]),
        ).toThrow(new ResourceValidationError("ops[1]: bad is not allowed"));
        expect(store.get(strictList, "s")).toEqual({ revision: ok, data: [item("a")] });
        expect(store.get(root, "r")).toBeNull();
        expect(store.writeCount()).toBe(count);
    });

    it("refuses a malformed item patch before writing anything, naming the op", () => {
        const store = itemStore();
        const base = store.put(list, "l", [item("a"), item("b")], null).revision;
        const before = store.writeCount();
        const op = (body: unknown) => ({ kind: list, id: "l", baseRevision: base, patch: body });
        const refused: [unknown, string][] = [
            [op({ items: [item("a")], set: { x: 1 } }), "a patch is either a field patch or an item patch"],
            [op({ order: [], remove: ["x"] }), "a patch is either a field patch or an item patch"],
            [op({ items: {} }), "an item patch is { items?: object[], changes?: object[], order?: string[] }"],
            [op({ changes: "a" }), "an item patch is { items?: object[], changes?: object[], order?: string[] }"],
            [op({ items: [], changes: [] }), "an item patch changes nothing"],
            [op({ items: [1] }), "items[0] is not an object with an id"],
            [op({ items: [{ name: "no id" }] }), "items[0] is not an object with an id"],
            [op({ items: [{ id: "" }] }), "items[0] has no id"],
            [op({ items: [{ id: 1 }] }), "items[0] has no id"],
            [op({ changes: [1] }), "changes[0] is { id, set?, remove? }"],
            [op({ changes: [{ set: { n: 1 } }] }), "changes[0] has no id"],
            [op({ changes: [{ id: "a" }] }), "changes[0] names no field"],
            [op({ changes: [{ id: "a", set: 1 }] }), "changes[0] is { set?: object, remove?: string[] }"],
            [
                op({ changes: [{ id: "a", set: { n: 1 }, remove: ["n"] }] }),
                "changes[0] names a field twice or names __proto__",
            ],
            [
                op({ changes: [{ id: "a", set: JSON.parse('{"__proto__":1}') }] }),
                "changes[0] names a field twice or names __proto__",
            ],
            [op({ changes: [{ id: "a", set: { id: "z" } }] }), "changes[0] names id"],
            [op({ changes: [{ id: "a", remove: ["id"] }] }), "changes[0] names id"],
            [
                op({ items: [item("a")], changes: [{ id: "a", set: { n: 1 } }] }),
                'an item patch names the item "a" twice',
            ],
            [op({ items: [item("a"), item("a")] }), 'an item patch names the item "a" twice'],
            [op({ order: "a" }), "an item patch's order is a list of ids"],
            [op({ order: [1] }), "an item patch's order is a list of ids"],
            [op({ order: ["a", "a"] }), "an item patch's order names an id twice"],
        ];
        for (const [entry, message] of refused) {
            expect(() =>
                store.applyBatch([{ kind: root, id: "r", baseRevision: null, data: 1 }, entry as never]),
            ).toThrow(new ResourceValidationError(`ops[1]: ${message}`));
        }
        // A kind whose data does not reach clients as stored takes no patch of either form.
        for (const kind of [masked, prepared]) {
            const revision = store.put(kind, "k", { n: 1 }, null).revision;
            for (const body of [{ set: { n: 2 } }, { order: [] }]) {
                expect(() =>
                    store.applyBatch([
                        { kind: root, id: "r", baseRevision: null, data: 1 },
                        { kind, id: "k", baseRevision: revision, patch: body },
                    ]),
                ).toThrow(new ResourceValidationError(`ops[1]: ${kind.name} takes no patch`));
            }
        }
        expect(store.get(list, "l")).toEqual({ revision: base, data: [item("a"), item("b")] });
        expect(store.get(root, "r")).toBeNull();
        expect(store.writeCount()).toBe(before + 2);
    });

    it("rolls back an item patch that does not fit the stored record, with the other ops", () => {
        const store = itemStore();
        const base = store.put(list, "l", [item("a"), item("b")], null).revision;
        const object = store.put(list, "o", { id: "a" }, null).revision;
        const dupes = store.put(list, "d", [item("a"), item("a")], null).revision;
        const noIds = store.put(list, "n", [item("a"), { name: "no id" }], null).revision;
        const before = store.writeCount();
        const op = (body: unknown, id = "l", revision = base) => ({
            kind: list,
            id,
            baseRevision: revision,
            patch: body,
        });
        for (const [entry, message] of [
            [op({ order: [] }, "o", object), "the record's items have no unique ids"],
            [op({ changes: [{ id: "a", set: { n: 1 } }] }, "d", dupes), "the record's items have no unique ids"],
            [op({ order: ["a"] }, "n", noIds), "the record's items have no unique ids"],
            [op({ changes: [{ id: "zz", set: { n: 1 } }] }), 'the item "zz" is not in the record'],
            [op({ items: [item("zz")] }), 'the item "zz" is not in the record'],
            [op({ items: [item("zz")], order: ["a", "b"] }), 'the patched item "zz" is not in the order'],
            [op({ changes: [{ id: "a", set: { n: 1 } }], order: ["b"] }), 'the patched item "a" is not in the order'],
            [op({ order: ["a", "zz"] }), 'the order names the unknown item "zz"'],
        ] as const) {
            expect(() => store.applyBatch([{ kind: root, id: "r", baseRevision: null, data: 1 }, entry])).toThrow(
                new ResourceValidationError(`ops[1]: ${message}`),
            );
        }
        // A field patch of a list, and an item patch of an object, are refused the same way.
        expect(() => store.applyBatch([op({ set: { n: 1 } })])).toThrow(
            new ResourceValidationError("ops[0]: a field patch needs an object record"),
        );
        expect(() => store.applyBatch([op({ set: { n: 1 } }, "o", object)])).not.toThrow();
        expect(store.get(list, "l")).toEqual({ revision: base, data: [item("a"), item("b")] });
        expect(store.get(root, "r")).toBeNull();
        expect(store.writeCount()).toBe(before + 1);
        // A stale base is the usual batch conflict, applying nothing.
        let error: unknown;
        try {
            store.applyBatch([
                { kind: root, id: "r", baseRevision: null, data: 1 },
                op({ order: [] }, "l", base.replace(/:1$/, ":9")),
            ]);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ResourceBatchConflictError);
        expect((error as ResourceBatchConflictError).conflicts).toEqual([{ kind: "list", id: "l", revision: base }]);
        expect(store.get(root, "r")).toBeNull();
    });
});
