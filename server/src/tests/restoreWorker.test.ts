// @vitest-environment node
/** @module-tag slow */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceValidationError } from "../data/resourceStore.ts";
import { runRestoreWorker, workerRestoreRunner } from "../data/restore/validateRunner.ts";
import { createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

const SLOW = { tags: ["slow"], timeout: 90_000 };
const servers: ResourceTestClient[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function server(options: Parameters<typeof createResourceTestClient>[0] = {}) {
    const s = await createResourceTestClient(options);
    servers.push(s);
    return s;
}
const tmp = (s: ResourceTestClient) => path.join(s.savePath, ".tmp");
const restore = (s: ResourceTestClient, id: string) => s.request(`/api/backups/${id}/restore`, { method: "POST" });
async function source(s: ResourceTestClient) {
    await s.create("characters", "saved", { chaId: "saved", name: "Saved" });
    const snapshot = await s.context.snapshots.snapshotNow();
    await s.create("characters", "live", { chaId: "live", name: "Live" });
    return { id: snapshot.id, file: path.join(s.savePath, "backups", `${snapshot.id}.sqlite`) };
}
function persisted(s: ResourceTestClient) {
    const db = new DatabaseSync(path.join(s.savePath, "data", "resources.sqlite"), { readOnly: true });
    try {
        return {
            epoch: db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get()!.value,
            rows: db.prepare("SELECT * FROM resources ORDER BY seq").all(),
        };
    } finally {
        db.close();
    }
}

it("restores 5000 messages in a real worker and reports the SQL install interval", SLOW, async () => {
    const s = await server({ restore: { runner: workerRestoreRunner(256) } });
    const snapshot = await source(s);
    const db = new DatabaseSync(snapshot.file);
    db.exec("BEGIN");
    db.prepare("INSERT INTO chats VALUES (41, 'saved', 'long', 29, 1, ?)").run(
        JSON.stringify({ name: "Long", note: "", localLore: [], fmIndex: -1, id: "long" }),
    );
    db.exec(`UPDATE chatOrders SET ids = '["long"]', revision = 31 WHERE characterId = 'saved'`);
    const insert = db.prepare("INSERT INTO messages VALUES (41, ?, ?, ?, NULL, NULL, NULL, NULL)");
    for (let n = 0; n < 5000; n++) {
        insert.run(`m${n}`, n * 3, JSON.stringify({ chatId: `m${n}`, role: "user", data: "x".repeat(2048) }));
    }
    db.exec("COMMIT");
    db.close();
    const exec = DatabaseSync.prototype.exec;
    const starts = new WeakMap<DatabaseSync, number>();
    let installing: DatabaseSync | undefined;
    let interval: number | undefined;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
        if (sql === "BEGIN IMMEDIATE") starts.set(this, performance.now());
        if (sql.includes("INSERT INTO main.resources")) installing = this;
        exec.call(this, sql);
        if (this === installing && sql === "COMMIT") interval = performance.now() - starts.get(this)!;
    });
    const result = await restore(s, snapshot.id);
    expect(result.status).toBe(200);
    const epoch = ((await result.json()) as { epoch: string }).epoch;
    expect(epoch).not.toBe(s.epoch);
    const live = new DatabaseSync(path.join(s.savePath, "data", "resources.sqlite"), { readOnly: true });
    try {
        expect(
            live
                .prepare(
                    "SELECT COUNT(*) AS n, MIN(position) AS first, MAX(position) AS last, MIN(length(json_extract(data, '$.data'))) AS chars FROM messages",
                )
                .get(),
        ).toEqual({ n: 5000, first: 0, last: 4999, chars: 2048 });
        expect(live.prepare("SELECT revision FROM chats WHERE id = 'long'").get()).toEqual({ revision: 29 });
        expect(live.prepare("SELECT id FROM resources WHERE kind = 'characters' ORDER BY seq").all()).toEqual([
            { id: "saved" },
        ]);
    } finally {
        live.close();
    }
    expect(readdirSync(tmp(s))).toEqual([]);
    // An empirical report, with no duration threshold in the gate or in this test.
    process.stderr.write(
        `[restore install] 5000 messages x 2048 characters: BEGIN IMMEDIATE through COMMIT = ${interval?.toFixed(3)} ms\n`,
    );
});

it("keeps a real worker's known refusal text and removes staging without touching live state", SLOW, async () => {
    const s = await server({ restore: { runner: workerRestoreRunner(256) } });
    const snapshot = await source(s);
    const db = new DatabaseSync(snapshot.file);
    db.exec("UPDATE resources SET schemaVersion = 999");
    db.close();
    const before = persisted(s);
    const backups = s.context.snapshots.list();
    const result = await restore(s, snapshot.id);
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "row 1: unsupported schema version" });
    expect(persisted(s)).toEqual(before);
    expect(s.context.snapshots.list()).toEqual(backups);
    expect(readdirSync(tmp(s))).toEqual([]);
});

it("answers worker OOM with 400 naming RISU_RESTORE_HEAP_MB and removes staging without installing", SLOW, async () => {
    const s = await server({ restore: { runner: workerRestoreRunner(16) } });
    const snapshot = await source(s);
    const db = new DatabaseSync(snapshot.file);
    db.prepare("UPDATE resources SET data = ? WHERE kind = 'characters'").run(
        JSON.stringify({ chaId: "saved", name: "x".repeat(2 * 1024 * 1024) }),
    );
    db.close();
    const before = persisted(s);
    const backups = s.context.snapshots.list();
    const result = await restore(s, snapshot.id);
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: expect.stringContaining("RISU_RESTORE_HEAP_MB") });
    expect(persisted(s)).toEqual(before);
    expect(s.context.snapshots.list()).toEqual(backups);
    expect(readdirSync(tmp(s))).toEqual([]);
    // The same source stages with a larger heap: it is valid input, not a row refusal.
    const output = path.join(tmp(s), "roomy.sqlite");
    const report = await workerRestoreRunner(256)(
        { source: snapshot.file, output },
        { signal: new AbortController().signal, onProgress: () => {} },
    );
    expect(report.size).toBeGreaterThan(0);
    await fs.rm(output);
});

it.each(["abort", "shutdown"] as const)(
    "terminates a held real worker on %s before cleanup, preserving rows and epoch",
    SLOW,
    async (end) => {
        const latch = new Int32Array(new SharedArrayBuffer(4));
        const held = deferred();
        const controller = new AbortController();
        const reason = new ResourceValidationError("restore cancelled by its owner");
        let folder = "";
        let rejection: unknown;
        const s = await server({
            restore: {
                runner: async (input, options) => {
                    folder = path.dirname(input.output);
                    try {
                        return await runRestoreWorker(input, {
                            ...options,
                            signal: end === "abort" ? controller.signal : options.signal,
                            resourceLimits: {
                                maxOldGenerationSizeMb: 256,
                                maxYoungGenerationSizeMb: 64,
                                stackSizeMb: 4,
                            },
                            latch,
                            onHeld: held.resolve,
                        });
                    } catch (error) {
                        rejection = error;
                        throw error;
                    }
                },
            },
        });
        const snapshot = await source(s);
        const before = persisted(s);
        const backups = s.context.snapshots.list();
        const restoring = restore(s, snapshot.id);
        await held.promise;
        expect(existsSync(folder)).toBe(true);
        expect(s.context.snapshots.gate.active).toBe(false);
        if (end === "abort") controller.abort(reason);
        else s.context.beginShutdown();
        const result = await restoring;
        expect(result.status).toBe(end === "abort" ? 400 : 503);
        expect(await result.json()).toEqual({
            error: end === "abort" ? reason.message : "The server is shutting down",
        });
        if (end === "abort") expect(rejection).toBe(reason);
        expect(persisted(s)).toEqual(before);
        expect(s.context.snapshots.list()).toEqual(backups);
        expect(existsSync(folder)).toBe(false);
        expect(readdirSync(tmp(s))).toEqual([]);
    },
);

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}
