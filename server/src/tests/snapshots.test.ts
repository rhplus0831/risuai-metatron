// @vitest-environment node
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../../shared/database.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../data/kinds.ts";
import {
    createResourceStore,
    ResourceBatchConflictError,
    ResourceValidationError,
    type ResourceStore,
} from "../data/resourceStore.ts";
import { createSnapshotManager, MaintenanceError, type SnapshotManager } from "../data/snapshots.ts";
import { sleep } from "./testSupport.ts";

const docs: ResourceKind = { name: "docs", schemaVersion: 1, normalize: (input) => input };
const kinds = createKindRegistry([docs]);

const dirs: string[] = [];
const stores: ResourceStore[] = [];
const managers: SnapshotManager[] = [];
afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.stop()));
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function setup(options: { intervalMs?: number; keep?: number } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-snapshots-"));
    dirs.push(dir);
    const store = createResourceStore({ file: path.join(dir, "data", "resources.sqlite"), kinds });
    stores.push(store);
    const backups = path.join(dir, "backups");
    const manager = createSnapshotManager({ store, dir: backups, ...options });
    managers.push(manager);
    return { dir, store, manager, backups };
}

function defer() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

describe("snapshot files", () => {
    // Only `Date` is fake: a snapshot is stamped with the time it is taken; its I/O stays real.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("flushes and closes the snapshot temporary before rename and syncs its directory before resolving", async () => {
        const { store, manager, backups } = setup();
        store.put(docs, "durable", { value: "complete" }, null);
        const events: string[] = [];
        let temporary: string | undefined;
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            const kind = String(args[0]) === backups ? "directory" : "file";
            if (kind === "file") temporary = String(args[0]);
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, "sync").mockImplementation(async () => {
                await sync();
                events.push(`${kind} sync`);
            });
            const close = handle.close.bind(handle);
            vi.spyOn(handle, "close").mockImplementation(async () => {
                await close();
                events.push(`${kind} close`);
            });
            return handle;
        });
        const rename = fs.rename;
        vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            expect(String(from)).toBe(temporary);
            expect(from).not.toBe(to);
            expect(path.dirname(String(to))).toBe(backups);
            await rename(from, to);
            events.push("rename");
        });
        const snapshot = await manager.snapshotNow();
        events.push("resolved");
        expect(events).toEqual(["file sync", "file close", "rename", "directory sync", "directory close", "resolved"]);
        const copy = store.readSnapshot(path.join(backups, `${snapshot.id}.sqlite`));
        expect(copy.rows.map(({ id, text }) => ({ id, data: JSON.parse(text) }))).toEqual([
            { id: "durable", data: { value: "complete" } },
        ]);
    });

    it("publishes a complete single-file copy under a stamped name and lists only such files, newest first", async () => {
        const { store, manager, backups } = setup();
        store.put(docs, "a", { v: 1 }, null);
        vi.setSystemTime(new Date("2026-10-21T12:34:56.007Z"));
        const first = await manager.snapshotNow();
        expect(first.id).toMatch(/^resources-20261021T123456007Z-[0-9a-f]{8}$/);
        expect(first.createdAt).toBe("2026-10-21T12:34:56.007Z");
        expect(first.size).toBeGreaterThan(0);
        // One file, no journal or WAL side files, readable as a resource database on its own.
        expect(readdirSync(backups)).toEqual([`${first.id}.sqlite`]);
        const copy = new DatabaseSync(path.join(backups, `${first.id}.sqlite`), { readOnly: true });
        try {
            expect(copy.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
            expect(copy.prepare("SELECT id, data FROM resources").all()).toEqual([{ id: "a", data: '{"v":1}' }]);
        } finally {
            copy.close();
        }
        expect(store.readSnapshot(path.join(backups, `${first.id}.sqlite`)).rows.map((r) => r.id)).toEqual(["a"]);

        vi.setSystemTime(new Date("2026-10-21T12:34:56.008Z"));
        const second = await manager.snapshotNow();
        expect(second.id).toMatch(/^resources-20261021T123456008Z-[0-9a-f]{8}$/);
        // Unfinished, foreign, and non-file entries are not snapshots.
        writeFileSync(path.join(backups, `.${second.id}.sqlite.tmp`), "half");
        writeFileSync(path.join(backups, "notes.txt"), "x");
        writeFileSync(path.join(backups, "resources-20200101T000000000Z-abcdefgh.sqlite"), "bad hex");
        expect(manager.list().map((s) => s.id)).toEqual([second.id, first.id]);
        expect(manager.list().map((s) => s.createdAt)).toEqual([second.createdAt, first.createdAt]);
        expect(manager.resolve(first.id)).toBe(path.join(backups, `${first.id}.sqlite`));
        for (const id of [
            "",
            "nope",
            `${first.id}.sqlite`,
            "../data/resources",
            `resources-20200101T000000000Z-abcdefgh`,
        ]) {
            expect(manager.resolve(id), id).toBeNull();
        }
    });

    it("keeps only the newest `keep` snapshots", async () => {
        const { manager } = setup({ keep: 2 });
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) {
            vi.setSystemTime(Date.UTC(2026, 9, 21, 12, 0, 0, i));
            ids.push((await manager.snapshotNow()).id);
        }
        expect(manager.list().map((s) => s.id)).toEqual([ids[3], ids[2]]);
    });

    it("removes the temporary file when the copy fails", async () => {
        const { store, manager, backups } = setup();
        store.close();
        await expect(manager.snapshotNow()).rejects.toThrow("Resource store is closed");
        expect(readdirSync(backups)).toEqual([]);
    });
});

describe("checkpoint snapshots", () => {
    const defaults = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const characters = defaults.get("characters")!;
    const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    const sqlText = (text: string) => "'" + text.replaceAll("'", "''") + "'";

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());

    function fixture() {
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-checkpoint-snapshots-"));
        dirs.push(dir);
        const file = path.join(dir, "resources.sqlite");
        const store = createResourceStore({ file, kinds: defaults });
        stores.push(store);
        store.put(characters, "c", { chaId: "c" }, null);
        store.put(characters, "d", { chaId: "d" }, null);
        // Leave a gap so restoring the chats must remap their checkpoint and policy owners.
        store.applyChanges({
            chats: [{ characterId: "c", chatId: "discarded", baseRevision: null, ops: [{ op: "create", chat: {} }] }],
        });
        store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "discarded",
                    baseRevision: store.chatRevision("c", "discarded"),
                    ops: [{ op: "delete" }],
                },
            ],
        });
        const saved = ["c", "d"].map((characterId, index) => {
            const chat: Chat = {
                id: "k",
                name: `Chat ${characterId}`,
                note: `Saved note ${characterId}`,
                localLore: [],
                fmIndex: -1,
                scriptstate: { chapter: index + 1, ready: true },
                GLGlobalVariables: { score: "7", toggle_voice: "on" },
                message: Array.from({ length: 70 }, (_, i) => ({
                    data: `${characterId}: ${i}, "quoted"\n한글 😀`,
                    role: i % 2 === 0 ? "user" : "char",
                    chatId: `message-${i}`,
                    time: i,
                    disabled: false,
                })),
            };
            store.applyChanges({
                chats: [{ characterId, chatId: "k", baseRevision: null, ops: [{ op: "create", chat }] }],
            });
            const checkpoint = store.checkpoints.save(characterId, "k", `Saved ${characterId}`, "manual")!;
            const policy =
                index === 0
                    ? { autoEvery: 1, autoKeep: 1, lastAutoTurns: null }
                    : { autoEvery: 100, autoKeep: 20, lastAutoTurns: 7 };
            store.checkpoints.writePolicy(characterId, "k", policy);
            // The checkpoint must compose its saved content, even when the snapshot's live chat differs.
            store.applyChanges({
                chats: [
                    {
                        characterId,
                        chatId: "k",
                        baseRevision: store.chatRevision(characterId, "k"),
                        ops: [
                            { op: "meta", set: { note: "Current note" } },
                            { op: "setText", id: "message-0", text: "Current message" },
                        ],
                    },
                ],
            });
            return { characterId, chat, checkpoint, policy };
        });
        return { dir, file, store, saved };
    }

    function tamper(file: string, sql: string) {
        const copy = file + ".copy.sqlite";
        copyFileSync(file, copy);
        const db = new DatabaseSync(copy, { enableForeignKeyConstraints: false });
        try {
            db.exec(sql);
        } finally {
            db.close();
        }
        return copy;
    }

    /** Replaces only the message pages, keeping hashes and refs consistent so content validation is exercised. */
    function messagePages(texts: string[]) {
        return `
            DELETE FROM checkpointPageRefs
            WHERE checkpointSeq = (SELECT seq FROM chatCheckpoints WHERE name = 'Saved c')
              AND hash IN (SELECT value FROM chatCheckpoints, json_each(pages) WHERE name = 'Saved c');
            ${texts.map((text) => `INSERT INTO checkpointPages (hash, text) VALUES ('${hash(text)}', ${sqlText(text)});`).join("\n")}
            UPDATE chatCheckpoints SET pages = '${JSON.stringify(texts.map(hash))}' WHERE name = 'Saved c';
            ${texts.map((text) => `INSERT INTO checkpointPageRefs SELECT seq, '${hash(text)}' FROM chatCheckpoints WHERE name = 'Saved c';`).join("\n")}
        `;
    }

    function pages(file: string) {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
            return db.prepare("SELECT hash, text FROM checkpointPages ORDER BY hash").all();
        } finally {
            db.close();
        }
    }

    it("replaces live checkpoints, pages, and policies on the restored chats without changing saved message bytes", async () => {
        const { dir, file, store, saved } = fixture();
        const snapshot = path.join(dir, "snapshot.sqlite");
        await store.backupTo(snapshot);
        // A valid page with whitespace catches a restore that parses and reserializes stored row text.
        const pageText = JSON.stringify(saved[0].chat.message, null, 2);
        const input = tamper(snapshot, messagePages([pageText]));
        const validated = store.readSnapshot(input);
        expect(validated.checkpoints?.pages).toContainEqual({ hash: hash(pageText), text: pageText });

        const later = store.checkpoints.save("c", "k", "After snapshot", "auto")!;
        store.checkpoints.writePolicy("c", "k", { autoEvery: 17, autoKeep: 9, lastAutoTurns: 99 });
        store.checkpoints.writePolicy("d", "k", null);
        store.replaceAll(validated);

        for (const { characterId, checkpoint, chat, policy } of saved) {
            expect(store.checkpoints.list(characterId, "k")?.map((item) => item.id)).toEqual([checkpoint.id]);
            const composed = store.checkpoints.compose(characterId, "k", checkpoint.id);
            expect(composed).toEqual(chat);
            expect(store.checkpoints.readPolicy(characterId, "k")).toEqual(policy);
        }
        expect(store.checkpoints.compose("c", "k", later.id)).toBeNull();
        const restoredPages = pages(file);
        expect(restoredPages).toContainEqual({ hash: hash(pageText), text: pageText });
        expect(restoredPages).not.toContainEqual({
            hash: hash(JSON.stringify("Current note")),
            text: JSON.stringify("Current note"),
        });
    });

    it("restores a snapshot without checkpoint tables with no checkpoints, pages, or policies", async () => {
        const { dir, file, store, saved } = fixture();
        const snapshot = path.join(dir, "snapshot.sqlite");
        await store.backupTo(snapshot);
        const legacy = tamper(
            snapshot,
            `
            DROP TABLE checkpointPageRefs;
            DROP TABLE chatCheckpoints;
            DROP TABLE checkpointPages;
            DROP TABLE chatCheckpointPolicy;
        `,
        );
        store.replaceAll(store.readSnapshot(legacy));
        for (const { characterId, checkpoint } of saved) {
            expect(store.chatRevision(characterId, "k")).not.toBeNull();
            expect(store.checkpoints.list(characterId, "k")).toEqual([]);
            expect(store.checkpoints.compose(characterId, "k", checkpoint.id)).toBeNull();
            expect(store.checkpoints.readPolicy(characterId, "k")).toBeNull();
        }
        expect(pages(file)).toEqual([]);
    });

    it.each([
        ["partial checkpoint table group", "DROP TABLE chatCheckpointPolicy"],
        ["page hash that does not match its text", "UPDATE checkpointPages SET text = text || ' '"],
        ["checkpoint whose chat is absent", "UPDATE chatCheckpoints SET chatSeq = 999999 WHERE name = 'Saved c'"],
        [
            "ref to an absent page",
            `INSERT INTO checkpointPageRefs SELECT seq, '${"0".repeat(64)}' FROM chatCheckpoints WHERE name = 'Saved c'`,
        ],
        [
            "message manifest hash without a ref",
            "DELETE FROM checkpointPageRefs WHERE checkpointSeq = (SELECT seq FROM chatCheckpoints WHERE name = 'Saved c') AND hash = (SELECT json_extract(pages, '$[0]') FROM chatCheckpoints WHERE name = 'Saved c')",
        ],
        [
            "field manifest hash without a ref",
            "DELETE FROM checkpointPageRefs WHERE checkpointSeq = (SELECT seq FROM chatCheckpoints WHERE name = 'Saved c') AND hash = (SELECT json_extract(fields, '$.note') FROM chatCheckpoints WHERE name = 'Saved c')",
        ],
        ["message page that is not a list", messagePages(["{}"])],
        ["message page containing an invalid message", messagePages(['[{"chatId":"bad","role":"invalid","data":42}]'])],
        [
            "duplicate message ids across pages",
            messagePages([
                '[{"chatId":"duplicate","role":"user","data":"First page"}]',
                '[{"chatId":"duplicate","role":"char","data":"Second page"}]',
            ]),
        ],
        ["invalid checkpoint id", "UPDATE chatCheckpoints SET id = '' WHERE name = 'Saved c'"],
        ["zero checkpoint revision", "UPDATE chatCheckpoints SET revision = 0 WHERE name = 'Saved c'"],
        ["autoEvery below 1", "UPDATE chatCheckpointPolicy SET autoEvery = 0"],
        ["autoEvery above 100", "UPDATE chatCheckpointPolicy SET autoEvery = 101"],
        ["autoKeep below 1", "UPDATE chatCheckpointPolicy SET autoKeep = 0"],
        ["autoKeep above 20", "UPDATE chatCheckpointPolicy SET autoKeep = 21"],
    ])("refuses a snapshot with %s without writing anything", async (_name, sql) => {
        const { dir, store, saved } = fixture();
        const snapshot = path.join(dir, "snapshot.sqlite");
        await store.backupTo(snapshot);
        const invalid = tamper(snapshot, sql);
        const fileBefore = readFileSync(invalid);
        const state = () => ({
            writes: store.writeCount(),
            resources: store.readKinds([characters], { chats: true }),
            checkpoints: saved.map(({ characterId, checkpoint }) => ({
                list: store.checkpoints.list(characterId, "k"),
                chat: store.checkpoints.compose(characterId, "k", checkpoint.id),
                policy: store.checkpoints.readPolicy(characterId, "k"),
            })),
        });
        const before = state();
        expect(() => store.readSnapshot(invalid)).toThrow(ResourceValidationError);
        expect(state()).toEqual(before);
        expect(readFileSync(invalid)).toEqual(fileBefore);
    });
});

describe("periodic snapshots", () => {
    // Only the interval is fake: each test fires it, and the backup's own I/O stays real.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    });
    afterEach(async () => {
        await Promise.all(managers.splice(0).map((m) => m.stop()));
        vi.useRealTimers();
    });
    /** Fires the 30 ms interval once and waits for the snapshot it queued, if any, to settle. */
    async function tick(manager: SnapshotManager) {
        vi.advanceTimersByTime(30);
        await manager.exclusive(async () => {});
    }

    it("snapshot only after a committed write since the last one", async () => {
        const { store, manager } = setup({ intervalMs: 30 });
        manager.start();
        manager.start();
        expect(vi.getTimerCount()).toBe(1);
        await tick(manager);
        expect(manager.list()).toHaveLength(0);

        store.put(docs, "a", 1, null);
        await tick(manager);
        expect(manager.list()).toHaveLength(1);
        await tick(manager);
        expect(manager.list()).toHaveLength(1);

        // A rolled-back transaction is not a write.
        expect(() =>
            store.transaction(() => {
                store.put(docs, "b", 1, null);
                throw new Error("rollback");
            }),
        ).toThrow("rollback");
        await tick(manager);
        expect(manager.list()).toHaveLength(1);

        store.transaction(() => store.put(docs, "b", 1, null));
        await tick(manager);
        expect(manager.list()).toHaveLength(2);
        await manager.stop();
        expect(vi.getTimerCount()).toBe(0);
        store.put(docs, "c", 1, null);
        await tick(manager);
        expect(manager.list()).toHaveLength(2);
    });

    it("counts a chat-only write as a write, but not an ignored checkpoint or a rolled-back batch", async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-snapshots-"));
        dirs.push(dir);
        const defaults = createKindRegistry(DEFAULT_RESOURCE_KINDS);
        const store = createResourceStore({ file: path.join(dir, "data", "resources.sqlite"), kinds: defaults });
        stores.push(store);
        const manager = createSnapshotManager({ store, dir: path.join(dir, "backups"), intervalMs: 30 });
        managers.push(manager);
        const group = (baseRevision: string | null, ops: unknown[]) => ({
            characterId: "c",
            chatId: "k",
            baseRevision,
            ops,
        });
        store.put(defaults.get("characters")!, "c", { chaId: "c" }, null);
        const created = store.applyChanges({
            chats: [group(null, [{ op: "create", chat: { message: [{ role: "user", data: "", chatId: "a" }] } }])],
        });
        manager.start();
        await tick(manager);
        expect(manager.list()).toHaveLength(1);
        await tick(manager);
        expect(manager.list()).toHaveLength(1);

        const revision = created.chats[0].revision!;
        store.applyChanges({ chats: [group(revision, [{ op: "setText", id: "a", text: "edited" }])] });
        await tick(manager);
        expect(manager.list()).toHaveLength(2);
        await tick(manager);
        expect(manager.list()).toHaveLength(2);

        // A checkpoint for a message without its generation is ignored; a conflicting batch (an
        // append after a gone anchor) rolls back.
        store.applyChanges({
            chats: [group(revision, [{ op: "setText", id: "a", text: "x", generation: { id: "g", seq: 1 } }])],
        });
        expect(() =>
            store.applyChanges({
                chats: [
                    group(revision, [
                        { op: "meta", set: { note: "n" } },
                        {
                            op: "append",
                            messages: [{ role: "user", data: "x", chatId: "b" }],
                            anchor: { after: "missing" },
                        },
                    ]),
                ],
            }),
        ).toThrow(ResourceBatchConflictError);
        await tick(manager);
        expect(manager.list()).toHaveLength(2);
        await manager.stop();
    });
});

describe("stop", () => {
    it("waits for the running snapshot and every tracked operation, then refuses new ones without starting them", async () => {
        const { manager } = setup();
        const running = defer();
        const entered = defer();
        const job = manager.exclusive(async () => {
            entered.resolve();
            await running.promise;
        });
        await entered.promise;
        const tracked = defer();
        manager.track(() => tracked.promise);

        let stopped = false;
        const stopPromise = manager.stop();
        expect(manager.stop()).toBe(stopPromise);
        const stopping = stopPromise.then(() => (stopped = true));
        await sleep(20);
        expect(stopped).toBe(false);
        running.resolve();
        await job;
        await sleep(20);
        expect(stopped).toBe(false);
        tracked.resolve();
        await stopping;
        expect(stopped).toBe(true);

        let started = false;
        expect(() =>
            manager.track(async () => {
                started = true;
            }),
        ).toThrow(new MaintenanceError("The server is shutting down"));
        expect(started).toBe(false);
        expect(() => manager.snapshotNow()).toThrow(MaintenanceError);
        expect(manager.list()).toHaveLength(0);
    });

    it("lets an operation admitted before stop still use the lock", async () => {
        const { store, manager } = setup();
        const gate = defer();
        const operation = manager.track(async () => {
            await gate.promise;
            return manager.withMaintenance(async ({ snapshot }) => (await snapshot()).id);
        });
        const stopping = manager.stop();
        gate.resolve();
        const id = await operation;
        await stopping;
        expect(manager.list().map((s) => s.id)).toEqual([id]);
        expect(store.writeCount()).toBe(0);
    });
});

describe("maintenance gate", () => {
    it("closes resource and storage mutations while maintenance runs and reopens them after", async () => {
        const { manager } = setup();
        const { gate } = manager;
        expect(gate.active).toBe(false);
        gate.assertOpen();
        gate.enter()();

        const inside = defer();
        const release = defer();
        const maintenance = manager.withMaintenance(async () => {
            inside.resolve();
            await release.promise;
            return "done";
        });
        await inside.promise;
        expect(gate.active).toBe(true);
        expect(() => gate.assertOpen()).toThrow(new MaintenanceError("Maintenance in progress"));
        expect(() => gate.enter()).toThrow(MaintenanceError);
        release.resolve();
        expect(await maintenance).toBe("done");
        expect(gate.active).toBe(false);
        gate.assertOpen();
    });

    it("waits for storage mutations admitted earlier before maintenance work starts, while refusing new ones", async () => {
        const { manager } = setup();
        const { gate } = manager;
        const leaveFirst = gate.enter();
        const leaveSecond = gate.enter();

        let started = false;
        const maintenance = manager.withMaintenance(async () => {
            started = true;
        });
        await sleep(20);
        // Closed at once, but not started: two mutations are still in flight.
        expect(gate.active).toBe(true);
        expect(() => gate.enter()).toThrow(MaintenanceError);
        expect(started).toBe(false);

        leaveFirst();
        leaveFirst(); // leaving twice is harmless
        await sleep(20);
        expect(started).toBe(false);
        leaveSecond();
        await maintenance;
        expect(started).toBe(true);
        expect(gate.active).toBe(false);
        gate.enter()();
    });

    it("keeps the safety snapshot and the maintenance body under the same lock as other exclusive work", async () => {
        const { store, manager } = setup();
        const order: string[] = [];
        const holding = defer();
        const first = manager.exclusive(async () => {
            order.push("first");
            await holding.promise;
        });
        const second = manager.withMaintenance(async ({ snapshot }) => {
            order.push("maintenance");
            await snapshot();
            store.put(docs, "written-inside", 1, null);
        });
        const third = manager.snapshotNow().then(() => order.push("third"));
        await sleep(10);
        expect(order).toEqual(["first"]);
        holding.resolve();
        await Promise.all([first, second, third]);
        expect(order).toEqual(["first", "maintenance", "third"]);
        expect(manager.list()).toHaveLength(2);
    });
});
