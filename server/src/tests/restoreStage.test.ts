// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createKindRegistry, type ResourceKind } from "../data/kinds.ts";
import {
    createResourceStore,
    NORMALIZATION_VERSION,
    ResourceValidationError,
    type ResourceStore,
} from "../data/resourceStore.ts";
import { stageValidatedSnapshot, verifyStagedFile } from "../data/restore/stageValidatedSnapshot.ts";
import { memoryKinds, memoryRecords, memoryTables, writeMemory } from "./memoryFixtures.ts";
import { INJECTED_COPY_FAILURE, installSnapshot, withFailingInstallCopy } from "./stagedRestore.ts";

const characters: ResourceKind = { name: "characters", schemaVersion: 1, normalize: (v) => v };
const single: ResourceKind = {
    name: "single",
    schemaVersion: 1,
    singleton: true,
    materialize: true,
    normalize: (v) => v ?? { fresh: true },
};
const kinds = createKindRegistry([characters, single]);
const dirs: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const message = { chatId: "same", role: "user", data: "original" };
const page = ` \n${JSON.stringify([message], null, 2)}\n `;
const meta = (id: string) => ({ name: id, note: "private note", localLore: [], fmIndex: 2, pinned: true, id });

function fixture() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-restore-stage-"));
    dirs.push(dir);
    const source = path.join(dir, "source.sqlite");
    createResourceStore({ file: source, kinds }).close();
    const db = new DatabaseSync(source);
    db.exec("DELETE FROM resources");
    // Deliberately neither id order nor revision 1, and sparse positions in each chat.
    for (const [seq, id, revision] of [
        [8, "z", 17],
        [19, "a", 23],
    ] as const) {
        db.prepare("INSERT INTO resources VALUES (?, 'characters', ?, ?, 1, ?)").run(
            seq,
            id,
            revision,
            JSON.stringify({ chaId: id }),
        );
        db.prepare("INSERT INTO chats VALUES (?, ?, ?, ?, 1, ?)").run(
            seq,
            id,
            id,
            revision + 3,
            JSON.stringify(meta(id)),
        );
        db.prepare("INSERT INTO messages VALUES (?, 'same', 40, ?, 'generation', 7, 1, ?)").run(
            seq,
            JSON.stringify(message),
            '[ "old-generation" ]',
        );
        db.prepare("INSERT INTO chatOrders VALUES (?, ?, ?, ?)").run(seq, id, revision + 5, JSON.stringify([id]));
        db.prepare("INSERT INTO chatGroups (chatSeq, groupId, revision, result) VALUES (?, 'receipt', 4, '{}')").run(
            seq,
        );
        db.prepare("INSERT INTO chatRestoreFloors VALUES (?, 9)").run(seq);
        db.prepare("INSERT INTO chatSummaries VALUES (?, ?, ?)").run(
            seq,
            revision + 3,
            '{"name":"FORGED","fmIndex":99}',
        );
    }
    const second = { chatId: "second", role: "char", data: "reply" };
    db.prepare("INSERT INTO messages VALUES (8, 'second', 90, ?, NULL, NULL, NULL, NULL)").run(JSON.stringify(second));
    db.prepare("INSERT INTO checkpointPages VALUES (?, ?)").run(hash(page), page);
    db.prepare("INSERT INTO checkpointPages VALUES (?, ?)").run(hash('"orphan"'), '"orphan"');
    db.prepare(
        "INSERT INTO chatCheckpoints VALUES (31, 8, 'saved', 'manual', 'Saved', 123, 11, 'original-token', 1, 1, ?, ?, '{}')",
    ).run('{"messages":[],"summaries":0,"loreEntries":0,"variables":0}', JSON.stringify([hash(page)]));
    db.prepare("INSERT INTO checkpointPageRefs VALUES (31, ?)").run(hash(page));
    db.exec("INSERT INTO chatCheckpointPolicy VALUES (8, 3, 4, 8)");
    db.close();
    return { dir, source, output: path.join(dir, "staged.sqlite"), second };
}

function rows(file: string, sql: string) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return db.prepare(sql).all();
    } finally {
        db.close();
    }
}

it("stages and installs source revisions, order, fences and exact checkpoint bytes while rebuilding projections and local state", async () => {
    const { dir, source, output, second } = fixture();
    const sourceBytes = readFileSync(source);
    const report = await stageValidatedSnapshot(source, output, kinds);
    const stat = await fs.lstat(output);
    expect(report).toEqual({
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        sha256: hash(readFileSync(output)),
    });
    expect(readFileSync(source)).toEqual(sourceBytes);
    expect(rows(output, "SELECT * FROM resources WHERE kind = 'single'")).toEqual([]);
    const file = path.join(dir, "live.sqlite");
    const store = createResourceStore({ file, kinds, normalizationIdentity: { commit: "test-build", dirty: false } });
    try {
        store.put(characters, "old", { chaId: "old" }, null);
        store.applyChanges({
            chats: [
                {
                    characterId: "old",
                    chatId: "old",
                    baseRevision: null,
                    groupId: "old-group",
                    ops: [{ op: "create", chat: { message: [] } }],
                },
            ],
        });
        const live = new DatabaseSync(file);
        live.exec("INSERT INTO chatRestoreFloors SELECT seq, revision FROM chats");
        expect(live.prepare("SELECT * FROM chatGroups").all()).toHaveLength(1);
        live.close();
        await verifyStagedFile(output, report);
        const epoch = store.replaceAll(output, report);
        for (const checked of [output, file]) {
            expect(
                rows(checked, "SELECT id, revision, data FROM resources WHERE kind = 'characters' ORDER BY seq"),
            ).toEqual([
                { id: "z", revision: 17, data: '{"chaId":"z"}' },
                { id: "a", revision: 23, data: '{"chaId":"a"}' },
            ]);
            expect(rows(checked, "SELECT id, revision, schemaVersion, meta FROM chats ORDER BY seq")).toEqual([
                { id: "z", revision: 20, schemaVersion: 1, meta: JSON.stringify(meta("z")) },
                { id: "a", revision: 26, schemaVersion: 1, meta: JSON.stringify(meta("a")) },
            ]);
            expect(
                rows(
                    checked,
                    "SELECT c.id AS chat, m.id, position, data, generationId, generationSeq, generationFinal, generationHistory FROM messages m JOIN chats c ON c.seq = m.chatSeq ORDER BY c.seq, position",
                ),
            ).toEqual([
                ...["z", "a"].flatMap((chat) => [
                    {
                        chat,
                        id: "same",
                        position: 0,
                        data: JSON.stringify(message),
                        generationId: "generation",
                        generationSeq: 7,
                        generationFinal: 1,
                        generationHistory: '[ "old-generation" ]',
                    },
                    ...(chat === "z"
                        ? [
                              {
                                  chat,
                                  id: "second",
                                  position: 1,
                                  data: JSON.stringify(second),
                                  generationId: null,
                                  generationSeq: null,
                                  generationFinal: null,
                                  generationHistory: null,
                              },
                          ]
                        : []),
                ]),
            ]);
            expect(rows(checked, "SELECT characterId, revision, ids FROM chatOrders ORDER BY seq")).toEqual([
                { characterId: "z", revision: 22, ids: '["z"]' },
                { characterId: "a", revision: 28, ids: '["a"]' },
            ]);
            expect(rows(checked, "SELECT * FROM checkpointPages")).toEqual([{ hash: hash(page), text: page }]);
            expect(
                rows(
                    checked,
                    "SELECT c.id AS chat, p.id, p.revision, p.chatRevision, p.pages, p.fields, p.createdAt, p.kind, p.name, p.userTurns, p.messageCount, p.preview FROM chatCheckpoints p JOIN chats c ON c.seq = p.chatSeq",
                ),
            ).toEqual([
                {
                    chat: "z",
                    id: "saved",
                    revision: 11,
                    chatRevision: "original-token",
                    pages: JSON.stringify([hash(page)]),
                    fields: "{}",
                    createdAt: 123,
                    kind: "manual",
                    name: "Saved",
                    userTurns: 1,
                    messageCount: 1,
                    preview: '{"messages":[],"summaries":0,"loreEntries":0,"variables":0}',
                },
            ]);
            expect(
                rows(
                    checked,
                    "SELECT c.id, r.hash FROM checkpointPageRefs r JOIN chatCheckpoints c ON c.seq = r.checkpointSeq",
                ),
            ).toEqual([{ id: "saved", hash: hash(page) }]);
            expect(
                rows(
                    checked,
                    "SELECT c.id, p.autoEvery, p.autoKeep, p.lastAutoTurns FROM chatCheckpointPolicy p JOIN chats c ON c.seq = p.chatSeq",
                ),
            ).toEqual([{ id: "z", autoEvery: 3, autoKeep: 4, lastAutoTurns: 8 }]);
            expect(
                rows(
                    checked,
                    "SELECT c.id, s.revision, s.text FROM chatSummaries s JOIN chats c ON c.seq = s.chatSeq ORDER BY c.seq",
                ),
            ).toEqual([
                { id: "z", revision: 20, text: '{"name":"z","fmIndex":2,"pinned":true}' },
                { id: "a", revision: 26, text: '{"name":"a","fmIndex":2,"pinned":true}' },
            ]);
            for (const table of ["chatGroups", "chatRestoreFloors"])
                expect(rows(checked, `SELECT * FROM ${table}`)).toEqual([]);
        }
        expect(store.get(single, "main")?.data).toEqual({ fresh: true });
        expect(rows(file, "SELECT value FROM meta WHERE key = 'epoch'")).toEqual([{ value: epoch }]);
        expect(rows(file, "SELECT value FROM meta WHERE key = 'normalizationStamp'")).toEqual([
            {
                value: JSON.stringify([
                    "test-build",
                    NORMALIZATION_VERSION,
                    [
                        ["characters", 1],
                        ["single", 1],
                    ],
                ]),
            },
        ]);
    } finally {
        store.close();
    }
});

it("refuses a checkpoint page reused as a field when it is only valid as messages", async () => {
    const { source, output } = fixture();
    const db = new DatabaseSync(source);
    db.prepare("UPDATE chatCheckpoints SET fields = ?").run(JSON.stringify({ note: hash(page) }));
    db.close();
    await expect(stageValidatedSnapshot(source, output, kinds)).rejects.toThrow(
        /chat.note must be a string|chat.name and chat.note must be strings/,
    );
});

it("finds duplicate message ids within one chat even in a source without a uniqueness constraint", async () => {
    const { source, output } = fixture();
    const db = new DatabaseSync(source);
    db.exec(`CREATE TABLE loose AS SELECT * FROM messages; DROP TABLE messages; ALTER TABLE loose RENAME TO messages;
        INSERT INTO messages SELECT chatSeq, id, 99, data, generationId, generationSeq, generationFinal, generationHistory FROM messages WHERE chatSeq = 8 AND id = 'same';`);
    db.close();
    await expect(stageValidatedSnapshot(source, output, kinds)).rejects.toThrow("message row 3: duplicate message id");
});

it("hashes the closed staged file with yielding reads of at most one MiB and propagates an abort reason", async () => {
    const { source, output } = fixture();
    const report = await stageValidatedSnapshot(source, output, kinds);
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const open = fs.open;
    const lengths: number[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) === output) {
            const read = handle.read.bind(handle);
            handle.read = (async (...readArgs: unknown[]) => {
                lengths.push(Number(readArgs[2]));
                entered.resolve();
                await release.promise;
                return Reflect.apply(read, handle, readArgs);
            }) as typeof handle.read;
        }
        return handle;
    });
    const reason = new Error("stop hashing");
    const verifying = verifyStagedFile(output, report, controller.signal);
    const rejected = expect(verifying).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    release.resolve();
    await rejected;
    expect(lengths).toEqual([1024 * 1024]);
});

it("refuses a staged header with an unsupported version even when its report matches", async () => {
    const { dir, source, output } = fixture();
    await stageValidatedSnapshot(source, output, kinds);
    const db = new DatabaseSync(output);
    db.exec("PRAGMA user_version = 999");
    db.close();
    const { size, mtimeMs, ino } = await fs.lstat(output);
    const report = { size, mtimeMs, ino, sha256: hash(readFileSync(output)) };
    await verifyStagedFile(output, report);
    const store = createResourceStore({ file: path.join(dir, "live.sqlite"), kinds });
    try {
        const epoch = store.epoch();
        const writes = store.writeCount();
        expect(() => store.replaceAll(output, report)).toThrow(ResourceValidationError);
        expect(store.epoch()).toBe(epoch);
        expect(store.writeCount()).toBe(writes);
    } finally {
        store.close();
    }
});

async function memoryFixture() {
    const base = fixture();
    const store = createResourceStore({ file: base.source, kinds });
    const initial = memoryRecords(["z", "a"]);
    const updated = memoryRecords(["z"], "Updated z");
    const source = path.join(base.dir, "memory-snapshot.sqlite");
    try {
        for (const id of ["z", "a"]) writeMemory(store, id, id, initial);
        writeMemory(store, "z", "z", updated);
        await store.backupTo(source);
    } finally {
        store.close();
    }
    return { ...base, source, initial, updated };
}

function seedLiveMemory(store: ResourceStore) {
    store.put(characters, "old", { chaId: "old" }, null);
    store.applyChanges({
        chats: [{ characterId: "old", chatId: "old", baseRevision: null, ops: [{ op: "create", chat: {} }] }],
    });
    writeMemory(store, "old", "old", memoryRecords(["live-only"]));
}

it("restores an old snapshot with the entire memory table group absent", async () => {
    const { dir, source, output } = await memoryFixture();
    const db = new DatabaseSync(source);
    db.exec(memoryTables.map((table) => `DROP TABLE ${table}`).join(";"));
    db.close();
    const report = await stageValidatedSnapshot(source, output, kinds);
    const file = path.join(dir, "live.sqlite");
    const store = createResourceStore({ file, kinds });
    try {
        store.replaceAll(output, report);
        expect(rows(file, "SELECT id FROM chats ORDER BY seq")).toEqual([{ id: "z" }, { id: "a" }]);
        for (const table of memoryTables) expect(rows(file, `SELECT * FROM ${table}`)).toEqual([]);
    } finally {
        store.close();
    }
});

it.each(memoryTables)("refuses a partial memory group missing %s", async (table) => {
    const { source, output } = await memoryFixture();
    const db = new DatabaseSync(source);
    db.exec(`DROP TABLE ${table}`);
    db.close();
    const staging = stageValidatedSnapshot(source, output, kinds);
    await expect(staging).rejects.toThrow(ResourceValidationError);
    await expect(staging).rejects.toThrow(/memory/i);
});

it("replaceAll leaves no memory rows belonging to replaced chats", async () => {
    const { dir, source, output } = fixture();
    const report = await stageValidatedSnapshot(source, output, kinds);
    const file = path.join(dir, "live.sqlite");
    const store = createResourceStore({ file, kinds });
    try {
        seedLiveMemory(store);
        store.replaceAll(output, report);
        expect(store.memory.readContents("old", "old")).toBeNull();
        // Count the physical rows too: reads through the new chats cannot reveal orphans.
        for (const table of memoryTables) expect(rows(file, `SELECT * FROM ${table}`)).toEqual([]);
    } finally {
        store.close();
    }
});

it("maps memory rows to restored chats' fresh seqs with their storage order and revisions", async () => {
    const { dir, source, output, initial, updated } = await memoryFixture();
    const report = await stageValidatedSnapshot(source, output, kinds);
    const file = path.join(dir, "live.sqlite");
    const store = createResourceStore({ file, kinds });
    try {
        seedLiveMemory(store);
        const oldSeq = rows(file, "SELECT seq FROM chats")[0].seq as number;
        const epoch = store.replaceAll(output, report);
        const chats = rows(file, "SELECT seq, id FROM chats ORDER BY seq") as { seq: number; id: string }[];
        expect(chats.map(({ id }) => id)).toEqual(["z", "a"]);
        for (const { id, seq } of chats) {
            expect(seq).toBeGreaterThan(oldSeq);
            const revision = `${epoch}:${seq}:${id === "z" ? 2 : 1}`;
            const contents = store.memory.readContents(id, id)!;
            expect(contents.revision).toBe(revision);
            for (const kind of memoryKinds) {
                expect(contents[kind].map((record) => record.id)).toEqual(["z", "a"]);
                const expected = id === "z" ? [updated[kind][0], initial[kind][1]] : initial[kind];
                for (const record of expected) {
                    expect(store.memory.readRecord(id, id, kind, record.id)).toEqual({
                        revision,
                        data: kind === "events" ? { ...record, createdRevision: 1 } : record,
                    });
                }
            }
        }
        expect(rows(file, "SELECT chatSeq, revision FROM memory_state ORDER BY chatSeq")).toEqual([
            { chatSeq: chats[0].seq, revision: 2 },
            { chatSeq: chats[1].seq, revision: 1 },
        ]);
        for (const kind of memoryKinds) {
            expect(rows(file, `SELECT chatSeq, id FROM memory_${kind} ORDER BY chatSeq, seq`)).toEqual(
                chats.flatMap(({ seq }) => [
                    { chatSeq: seq, id: "z" },
                    { chatSeq: seq, id: "a" },
                ]),
            );
        }
    } finally {
        store.close();
    }
});

it.each([
    ["no such chat", "PRAGMA foreign_keys = OFF; UPDATE memory_events SET chatSeq = 999 WHERE chatSeq = 8", /chat/],
    ["missing memory state", "DELETE FROM memory_state WHERE chatSeq = 8", /memory_state/],
    ["non-JSON data", "UPDATE memory_events SET data = '{'", /JSON/],
    ["invalid status", "UPDATE memory_events SET data = json_set(data, '$.status', 'invalid')", /status/],
    [
        "duplicate id in a chat",
        "UPDATE memory_events SET data = json_set(data, '$.id', 'z') WHERE id = 'a'",
        /duplicate/,
    ],
    [
        "invalid createdRevision",
        "UPDATE memory_events SET data = json_set(data, '$.createdRevision', 0)",
        /createdRevision/,
    ],
    [
        "createdRevision above memory revision",
        "UPDATE memory_events SET data = json_set(data, '$.createdRevision', 3)",
        /createdRevision/,
    ],
] as const)("refuses crafted memory rows as validation errors: %s", async (_name, sql, reason) => {
    const { source, output } = await memoryFixture();
    const db = new DatabaseSync(source);
    db.exec(sql);
    db.close();
    const staging = stageValidatedSnapshot(source, output, kinds);
    await expect(staging).rejects.toThrow(ResourceValidationError);
    await expect(staging).rejects.toThrow(reason);
});

it("accepts live memory with shared ids, an empty state, a re-added event and a lone-surrogate title", async () => {
    const { dir, source } = fixture();
    const store = createResourceStore({ file: source, kinds });
    const records = memoryRecords(["same"], "Lone \ud800");
    const snapshot = path.join(dir, "legal-memory.sqlite");
    try {
        writeMemory(store, "z", "z", records);
        writeMemory(store, "z", "z", { remove: { events: ["same"] } });
        writeMemory(store, "z", "z", { events: records.events });
        writeMemory(store, "a", "a", { threads: records.threads });
        writeMemory(store, "a", "a", { remove: { threads: ["same"] } });
        await store.backupTo(snapshot);
        await installSnapshot(store, snapshot, kinds);
        for (const kind of memoryKinds) {
            expect(store.memory.readRecord("z", "z", kind, "same")?.data).toEqual(
                kind === "events" ? { ...records.events[0], createdRevision: 3 } : records[kind][0],
            );
            expect(store.memory.readContents("a", "a")![kind]).toEqual([]);
        }
        expect(
            rows(
                source,
                "SELECT c.id, m.revision FROM memory_state m JOIN chats c ON c.seq = m.chatSeq ORDER BY c.seq",
            ),
        ).toEqual([
            { id: "z", revision: 3 },
            { id: "a", revision: 2 },
        ]);
    } finally {
        store.close();
    }
});

it("restores memory data text byte for byte without reserializing JSON", async () => {
    const { dir, source, output } = await memoryFixture();
    const text =
        ' {\n "id":"z", "result":"recorded", "window":[], "model":"writer", "inputTokens":1e21, "outputTokens":20, "durationMs":30, "input":"\\u0061 한글 😀"\n}\n';
    const db = new DatabaseSync(source);
    db.prepare("UPDATE memory_runs SET data = ? WHERE chatSeq = 8 AND id = 'z'").run(text);
    db.close();
    const report = await stageValidatedSnapshot(source, output, kinds);
    const file = path.join(dir, "live.sqlite");
    const store = createResourceStore({ file, kinds });
    try {
        store.replaceAll(output, report);
        for (const checked of [output, file]) {
            expect(
                rows(
                    checked,
                    "SELECT m.data FROM memory_runs m JOIN chats c ON c.seq = m.chatSeq WHERE c.id = 'z' AND m.id = 'z'",
                ),
            ).toEqual([{ data: text }]);
        }
        expect(store.memory.readRecord("z", "z", "runs", "z")?.data).toEqual({
            id: "z",
            result: "recorded",
            window: [],
            model: "writer",
            inputTokens: 1e21,
            outputTokens: 20,
            durationMs: 30,
            input: "a 한글 😀",
        });
    } finally {
        store.close();
    }
});

it("rolls memory rows back with the chats and epoch when install fails after copying", async () => {
    const { dir, source, output } = await memoryFixture();
    const report = await stageValidatedSnapshot(source, output, kinds);
    const file = path.join(dir, "live.sqlite");
    const store = createResourceStore({ file, kinds });
    try {
        seedLiveMemory(store);
        const before = memoryTables.map((table) => rows(file, `SELECT * FROM ${table} ORDER BY rowid`));
        const chats = rows(file, "SELECT * FROM chats ORDER BY seq");
        const contents = store.memory.readContents("old", "old");
        const epoch = store.epoch();
        const writes = store.writeCount();
        expect(() => withFailingInstallCopy(() => store.replaceAll(output, report))).toThrow(INJECTED_COPY_FAILURE);
        expect(memoryTables.map((table) => rows(file, `SELECT * FROM ${table} ORDER BY rowid`))).toEqual(before);
        expect(rows(file, "SELECT * FROM chats ORDER BY seq")).toEqual(chats);
        expect(store.memory.readContents("old", "old")).toEqual(contents);
        expect(store.memory.readContents("z", "z")).toBeNull();
        expect(store.epoch()).toBe(epoch);
        expect(store.writeCount()).toBe(writes);
    } finally {
        store.close();
    }
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}
