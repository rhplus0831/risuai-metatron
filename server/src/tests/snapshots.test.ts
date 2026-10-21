// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../data/kinds.ts";
import { createResourceStore, ResourceBatchConflictError, type ResourceStore } from "../data/resourceStore.ts";
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
    it("publishes a complete single-file copy under a stamped name and lists only such files, newest first", async () => {
        const { store, manager, backups } = setup();
        store.put(docs, "a", { v: 1 }, null);
        const first = await manager.snapshotNow();
        expect(first.id).toMatch(/^resources-\d{8}T\d{9}Z-[0-9a-f]{8}$/);
        expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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

        await sleep(2);
        const second = await manager.snapshotNow();
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
            ids.push((await manager.snapshotNow()).id);
            await sleep(2);
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
