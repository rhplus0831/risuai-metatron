// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createResourceTestClient } from "./testSupport.ts";
import { matureSweep, seedSweepAsset, sweepClock } from "./assetSweepFixtures.ts";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createAssetLifecycle, type AssetLifecycleOptions } from "../data/assetLifecycle.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager } from "../data/snapshots.ts";
import { freeBytes } from "../http/diskSpace.ts";
import { parseAssetClockOffset } from "../listenConfig.ts";
import { createExportHolds } from "../routes/backupsUpstreamExport.ts";
import { resolveStorageKey } from "../routes/storage.ts";
import { memoryRecords, writeMemory } from "./memoryFixtures.ts";

function defer() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

const DAY = 86_400_000;
const NOW = Date.UTC(2030, 0, 20);
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.useRealTimers();
});

function fixture(options: AssetLifecycleOptions = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-asset-mark-"));
    const file = path.join(dir, "data", "resources.sqlite");
    const store = createResourceStore({ file, kinds });
    const snapshots = createSnapshotManager({ store, dir: path.join(dir, "backups") });
    const db = new DatabaseSync(file);
    const holds = createExportHolds();
    let now = NOW;
    const create = () =>
        createAssetLifecycle({
            savePath: dir,
            store,
            snapshots,
            exportHolds: holds,
            inlaysKind: kinds.get("inlays"),
            wallClock: () => now,
            monoClock: () => now,
            statfs: async () => ({ bavail: 3, bsize: 1024, blocks: 8 }),
            ...options,
        });
    let lifecycle = create();
    cleanups.push(async () => {
        await lifecycle.close();
        db.close();
        await snapshots.stop();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const put = (kind: string, id: string, data: unknown) => {
        const definition = kinds.get(kind)!;
        return store.put(definition, id, data, store.get(definition, id)?.revision ?? null);
    };
    const asset = (key: string, bytes = 1, mtime = NOW - 30 * DAY) => {
        const target = resolveStorageKey(dir, key)!;
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.alloc(bytes, 65));
        utimesSync(target, mtime / 1000, mtime / 1000);
        return target;
    };
    const ledger = () => {
        const reader = new DatabaseSync(path.join(dir, "data", "asset-lifecycle.sqlite"), { readOnly: true });
        try {
            return {
                assets: reader.prepare("SELECT key, since, bytes FROM unreferenced ORDER BY key").all(),
                inlays: reader.prepare("SELECT id, since FROM orphanInlays ORDER BY id").all(),
            };
        } finally {
            reader.close();
        }
    };
    return {
        dir,
        store,
        snapshots,
        db,
        holds,
        put,
        asset,
        ledger,
        get lifecycle() {
            return lifecycle;
        },
        setNow(value: number) {
            now = value;
        },
        async reopen() {
            await lifecycle.close();
            lifecycle = create();
        },
        chat(meta: Record<string, unknown> = {}, messages: unknown[] = []) {
            put("characters", "alice", { chaId: "alice", name: "Alice" });
            store.applyChanges({
                chats: [
                    {
                        characterId: "alice",
                        chatId: "chat",
                        baseRevision: null,
                        ops: [{ op: "create", chat: { name: "Chat", message: [], ...meta } }],
                    },
                ],
            });
            const seq = db.prepare("SELECT seq FROM chats WHERE id = 'chat'").get()!.seq;
            messages.forEach((message, i) =>
                db
                    .prepare("INSERT INTO messages (chatSeq, id, position, data) VALUES (?, ?, ?, ?)")
                    .run(seq, `m${i}`, i, JSON.stringify(message)),
            );
            return seq;
        },
    };
}

it("marks decoded live text, every memory table, and named checkpoint pages without inventing disk keys", async () => {
    const f = fixture();
    const roots = new Map<string, string>();
    const key = (root: string, name = root) => {
        const value = `assets/${name}`;
        roots.set(root, value);
        f.asset(value);
        return value;
    };
    const quote = key("escaped quote", 'quote".png');
    const slash = key("escaped backslash", "back\\slash.png");
    const newline = key("escaped newline", "new\nline.png");
    const seq = f.chat(
        {
            localLore: [{ key: "local", content: key("local lore") }],
            scriptstate: { image: key("scriptstate") },
        },
        [
            {
                role: "char",
                data: `{{inlayed::${key("message inlay text")}}}`,
                candidates: [{ data: "selected" }, { data: key("unselected reroll") }],
                selectedCandidate: 0,
                urls: [
                    `/api/asset/${Buffer.from(key("api lowercase")).toString("hex")}`,
                    `/api/asset/${Buffer.from(key("api uppercase")).toString("hex").toUpperCase()}`,
                    `/sw/img/${Buffer.from(key("sw lowercase")).toString("hex")}`,
                    `/sw/img/${Buffer.from(key("sw uppercase")).toString("hex").toUpperCase()}`,
                ],
            },
        ],
    );
    f.put("characters", "alice", {
        chaId: "alice",
        image: quote,
        additionalAssets: [
            ["slash", slash, "png"],
            ["newline", newline, "png"],
        ],
    });
    const rawKey = key("escaped raw JSON needle", "unicode.png");
    f.put("pluginStorage", "main", { placeholder: true });
    // The stored needle itself is escaped, so the SQL prefilter must still select this row.
    f.db
        .prepare("UPDATE resources SET data = ? WHERE kind = 'pluginStorage'")
        .run('{"value":"' + rawKey.replace("assets/", "\\u0061ssets\\/") + '"}');
    const prefixLong = key("long disk prefix", "a.png");
    key("short disk prefix", "a.p");
    f.db
        .prepare("UPDATE resources SET data = ? WHERE kind = 'ui'")
        .run(JSON.stringify({ text: `${prefixLong}"}} assets/not-on-disk`, [key("object key")]: "value" }));

    for (const suffix of ["pages", "events", "threads", "runs"]) {
        for (const prefix of ["memory_", "memory_staged_"]) {
            const table = prefix + suffix;
            const data = JSON.stringify({ text: key(`${table}.data`) });
            const columns = ["chatSeq", "id", "data"];
            const values: (string | number | bigint | null | Uint8Array)[] = [seq, "record", data];
            if (suffix !== "runs") {
                columns.push("title");
                values.push(key(`${table}.title`));
            }
            if (suffix === "pages") {
                columns.push("type");
                values.push("location");
            }
            if (suffix === "events") {
                columns.push("status", "createdRevision");
                values.push("active", 1);
            }
            if (suffix === "threads") {
                columns.push("state");
                values.push("open");
            }
            if (suffix === "runs") {
                columns.push("result");
                values.push("recorded");
            }
            f.db
                .prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
                .run(...values);
        }
    }
    // Capture separate chat metadata and a memory row, then remove both live sources.
    f.store.applyChanges({
        chats: [
            {
                characterId: "alice",
                chatId: "checkpoint",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            name: "Saved",
                            message: [],
                            localLore: [{ key: "saved", content: key("checkpoint page") }],
                        },
                    },
                ],
            },
        ],
    });
    const checkpointKey = key("checkpoint memory chunk", 'checkpoint"\\\n.png');
    writeMemory(f.store, "alice", "checkpoint", memoryRecords(["saved"], checkpointKey));
    f.store.checkpoints.save("alice", "checkpoint", "Saved", "manual");
    f.db.exec(
        "DELETE FROM memory_pages WHERE id = 'saved'; DELETE FROM memory_events WHERE id = 'saved'; DELETE FROM memory_threads WHERE id = 'saved'; DELETE FROM memory_runs WHERE id = 'saved'; UPDATE chats SET meta = '{}' WHERE id = 'checkpoint'",
    );
    f.asset("assets/unreferenced");
    const untouched = new Map(
        [...roots.values(), "assets/unreferenced"].map((k) => [k, readFileSync(resolveStorageKey(f.dir, k)!)]),
    );
    const report = await f.lifecycle.scan();
    expect(report.complete, report.reasons.join("\n")).toBe(true);
    const unreferenced = f.ledger().assets.map((row) => row.key);
    for (const [root, value] of roots) expect(unreferenced, root).not.toContain(value);
    expect(unreferenced).toEqual(["assets/unreferenced"]);
    expect(report.referenced.count).toBe(roots.size);
    expect(report.referenced.dedupedBytes).toBe(roots.size);
    for (const [key, bytes] of untouched) expect(readFileSync(resolveStorageKey(f.dir, key)!), key).toEqual(bytes);
});

it("keeps since stamps, removes newly referenced keys, and requires both file age and unreferenced grace", async () => {
    const f = fixture();
    const old = f.asset("assets/old", 3);
    const young = f.asset("assets/young", 5, NOW - DAY);
    const unmanaged = path.join(f.dir, "assets", "%61.png");
    writeFileSync(unmanaged, "unmanaged");
    const first = await f.lifecycle.scan();
    expect(first.referenced).toMatchObject({ count: 1, dedupedBytes: 5 });
    expect(first.unreferenced).toMatchObject({ count: 1, bytes: 3, candidates: [] });
    expect(first.usage).toMatchObject({ assetsOnDisk: 8, unmanaged: 9 });
    expect(f.ledger().assets).toEqual([{ key: "assets/old", since: NOW, bytes: 3 }]);
    f.setNow(NOW + 7 * DAY - 1);
    expect((await f.lifecycle.scan()).unreferenced.candidates).toEqual([]);
    f.setNow(NOW + 7 * DAY);
    expect((await f.lifecycle.scan()).unreferenced.candidates).toEqual([{ key: "assets/old", since: NOW, bytes: 3 }]);
    f.put("pluginStorage", "main", { image: "assets/old" });
    await f.lifecycle.scan();
    expect(f.ledger().assets).toEqual([{ key: "assets/young", since: NOW + 7 * DAY - 1, bytes: 5 }]);
    f.put("pluginStorage", "main", {});
    f.setNow(NOW + 15 * DAY);
    const again = await f.lifecycle.scan();
    expect(again.unreferenced.candidates).toEqual([{ key: "assets/young", since: NOW + 7 * DAY - 1, bytes: 5 }]);
    expect(f.ledger().assets).toContainEqual({ key: "assets/old", since: NOW + 15 * DAY, bytes: 3 });
    expect(readFileSync(old)).toHaveLength(3);
    expect(readFileSync(young)).toHaveLength(5);
    expect(readFileSync(unmanaged, "utf8")).toBe("unmanaged");
});

it("counts owner shares and inlay ids while preserving each orphan's since", async () => {
    const f = fixture();
    f.chat({}, [{ role: "char", data: "{{inlay::one}} {{inlayed::two}} {{inlayeddata::three}}" }]);
    f.asset("assets/shared", 10);
    for (const id of ["alice", "bob"]) f.put("characters", id, { chaId: id, image: "assets/shared" });
    for (const [kind, field] of [
        ["modules", "icon"],
        ["personas", "icon"],
        ["presets", "image"],
        ["characterOrder", "img"],
    ]) {
        f.put(kind, "main", [{ id: kind, name: kind, [field]: "assets/shared" }]);
    }
    f.put("ui", "main", { customBackground: "assets/shared" });
    for (const [id, bytes] of [
        ["one", 2],
        ["two", 3],
        ["three", 4],
        ["orphan", 5],
    ] as const) {
        f.asset(`assets/${id}`, bytes);
        f.put("inlays", id, { asset: `assets/${id}`, type: "image", name: "Image", ext: "png" });
    }
    const first = await f.lifecycle.scan();
    expect(first.complete, first.reasons.join("\n")).toBe(true);
    expect(first.referenced).toEqual({ count: 5, logicalBytes: 84, dedupedBytes: 24, savings: 60 });
    expect(first.owners.map(({ kind, id, bytes, count }) => ({ kind, id, bytes, count }))).toEqual(
        expect.arrayContaining([
            { kind: "character", id: "alice", bytes: 19, count: 4 },
            { kind: "character", id: "bob", bytes: 10, count: 1 },
            { kind: "module", id: "modules", bytes: 10, count: 1 },
            { kind: "persona", id: "personas", bytes: 10, count: 1 },
            { kind: "preset", id: "presets", bytes: 10, count: 1 },
            { kind: "folder", id: "characterOrder", bytes: 10, count: 1 },
            { kind: "settings", id: "main", bytes: 10, count: 1 },
            { kind: "inlays", id: "inlays", bytes: 5, count: 1 },
        ]),
    );
    expect(first.owners).toHaveLength(8);
    expect(first.orphanInlays).toEqual({
        count: 1,
        bytes: 5,
        total: 1,
        records: [{ id: "orphan", asset: "assets/orphan", bytes: 5, since: NOW }],
    });
    f.setNow(NOW + DAY);
    expect((await f.lifecycle.scan()).orphanInlays).toEqual(first.orphanInlays);
    f.put("pluginStorage", "main", { text: "{{inlay::orphan}}" });
    expect((await f.lifecycle.scan()).orphanInlays.records).toEqual([]);
    expect(f.ledger().inlays).toEqual([]);
});

it("persists snapshot indexes, finds republished keys, and counts only exclusively held bytes", async () => {
    const f = fixture();
    const escaped = ['assets/quote".png', "assets/back\\slash.png", "assets/new\nline.png"];
    for (const key of escaped) f.asset(key, 2);
    f.asset("assets/shared", 3);
    f.put("characters", "saved", {
        chaId: "saved",
        image: escaped[0],
        additionalAssets: [...escaped.slice(1), "assets/shared", "assets/republished"].map((k) => [k, k, "png"]),
    });
    const first = await f.snapshots.snapshotNow();
    f.put("characters", "saved", { chaId: "saved", image: "assets/shared" });
    const link = vi.spyOn(fs, "link");
    const report = await f.lifecycle.scan();
    expect(report.complete, report.reasons.join("\n")).toBe(true);
    expect(report.unreferenced.count).toBe(0);
    expect(report.snapshots).toContainEqual(expect.objectContaining({ id: first.id, heldBytes: 6 }));
    expect(link.mock.calls.filter(([from]) => String(from).endsWith(`${first.id}.sqlite`))).toHaveLength(1);
    await f.reopen();
    f.asset("assets/republished", 4);
    f.asset("assets/new-snapshot", 5);
    f.put("characters", "saved", {
        chaId: "saved",
        image: "assets/new-snapshot",
        additionalAssets: [["shared", "assets/shared", "png"]],
    });
    const second = await f.snapshots.snapshotNow();
    f.put("characters", "saved", { chaId: "saved" });
    const next = await f.lifecycle.scan();
    expect(next.complete, next.reasons.join("\n")).toBe(true);
    expect(next.unreferenced.count).toBe(0);
    expect(next.referenced.dedupedBytes).toBe(18);
    expect(next.snapshots).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ id: first.id, heldBytes: 10 }),
            expect.objectContaining({ id: second.id, heldBytes: 5 }),
        ]),
    );
    for (const snapshot of [first, second])
        expect(
            link.mock.calls.filter(([from]) => String(from).endsWith(`${snapshot.id}.sqlite`)),
            snapshot.id,
        ).toHaveLength(1);
});

it.each(["unreadable snapshot", "missing live column", "invalid selected JSON"] as const)(
    "reports sizes without changing either ledger after %s",
    async (failure) => {
        const f = fixture();
        f.asset("assets/old", 3);
        f.put("inlays", "orphan", { asset: "assets/missing", type: "image", name: "Image", ext: "png" });
        await f.lifecycle.scan();
        const before = f.ledger();
        f.asset("assets/new", 5);
        f.put("pluginStorage", "main", { image: "assets/old", text: "{{inlay::orphan}}" });
        let reason: string;
        if (failure === "unreadable snapshot") {
            const snapshot = await f.snapshots.snapshotNow();
            writeFileSync(path.join(f.dir, "backups", `${snapshot.id}.sqlite`), "not sqlite");
            reason = snapshot.id;
        } else if (failure === "missing live column") {
            f.db.exec("ALTER TABLE memory_runs RENAME COLUMN data TO unavailable");
            reason = "memory_runs";
        } else {
            f.put("modules", "main", []);
            f.db.prepare("UPDATE resources SET data = ? WHERE kind = 'modules'").run('{"text":"assets/broken"');
            reason = "resources";
        }
        f.setNow(NOW + 8 * DAY);
        const report = await f.lifecycle.scan();
        expect(report.complete).toBe(false);
        expect(report.reasons.join("\n")).toContain(reason);
        expect(report.usage.assetsOnDisk).toBe(8);
        expect(report.usage.resourcesDb).toBeGreaterThan(0);
        if (failure === "unreadable snapshot") expect(report.usage.snapshots).toBe(10);
        expect(f.ledger()).toEqual(before);
    },
);

it("ignores a snapshot rotated away before its link is acquired", async () => {
    const f = fixture();
    f.asset("assets/free", 2);
    const snapshot = await f.snapshots.snapshotNow();
    const mkdir = fs.mkdir;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        if (String(args[0]) === path.join(f.dir, ".tmp")) {
            rmSync(path.join(f.dir, "backups", `${snapshot.id}.sqlite`), { force: true });
        }
        return mkdir(...args);
    });
    const report = await f.lifecycle.scan();
    expect(report.complete, report.reasons.join("\n")).toBe(true);
    expect(report.snapshots).toEqual([]);
    expect(f.ledger().assets).toEqual([{ key: "assets/free", since: NOW, bytes: 2 }]);
});

it("allows a store write between scan chunks and keeps the starting writeCount", async () => {
    const paused = defer();
    const resume = defer();
    let pause = true;
    const f = fixture({
        chunkSize: 1,
        betweenChunks: async () => {
            if (pause) {
                pause = false;
                paused.resolve();
                await resume.promise;
            }
        },
    });
    f.asset("assets/new-write", 2);
    const start = f.store.writeCount();
    const scan = f.lifecycle.scan();
    try {
        await paused.promise;
        f.put("pluginStorage", "main", { image: "assets/new-write" });
        expect(f.store.writeCount()).toBeGreaterThan(start);
        expect(f.store.get(kinds.get("pluginStorage")!, "main")!.data).toEqual({ image: "assets/new-write" });
        expect(f.lifecycle.runIdentity).toMatchObject({ writeCount: start, epoch: f.store.epoch() });
    } finally {
        resume.resolve();
    }
    expect((await scan).complete).toBe(true);
    expect(f.lifecycle.runIdentity!.writeCount).toBe(start);
});

it("leaves the ledger unchanged when an export key set misses the controlled wait bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waiting = defer();
    const setTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: (...values: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
    ) => {
        const timer = setTimeout(callback, delay, ...args);
        if (delay === 50) waiting.resolve();
        return timer;
    }) as unknown as typeof globalThis.setTimeout);
    const f = fixture({ exportWaitMs: 50 });
    f.asset("assets/free", 4);
    const hold = f.holds.hold();
    const scan = f.lifecycle.scan();
    try {
        await waiting.promise;
        await vi.advanceTimersByTimeAsync(50);
        const report = await scan;
        expect(report.complete).toBe(false);
        expect(report.reasons.join("\n")).toMatch(/export.*wait bound/i);
        expect(report.usage.assetsOnDisk).toBe(4);
        expect(f.ledger().assets).toEqual([]);
    } finally {
        hold.release();
    }
    expect((await f.lifecycle.scan()).complete).toBe(true);
    expect(f.ledger().assets).toEqual([{ key: "assets/free", since: NOW, bytes: 4 }]);
});

it("moves both lifecycle clocks and persisted grace with an allowed development offset", async () => {
    const f = fixture();
    f.asset("assets/free", 2);
    await f.lifecycle.scan();
    await f.lifecycle.close();
    const offset = parseAssetClockOffset(String(8 * DAY), "127.0.0.1");
    const lifecycle = createAssetLifecycle({
        savePath: f.dir,
        store: f.store,
        snapshots: f.snapshots,
        wallClock: () => NOW,
        monoClock: () => 123,
        clockOffsetMs: offset,
    });
    try {
        expect(lifecycle.wallNow()).toBe(NOW + 8 * DAY);
        expect(lifecycle.monoNow()).toBe(123 + 8 * DAY);
        const report = await lifecycle.scan();
        expect(report.generatedAt).toBe(NOW + 8 * DAY);
        expect(report.unreferenced.candidates).toEqual([{ key: "assets/free", since: NOW, bytes: 2 }]);
    } finally {
        await lifecycle.close();
    }
});

it("reports available and total statfs bytes and returns null when statfs fails", async () => {
    const statfs = vi.fn(async () => ({ bavail: 3n, bsize: 4096n, blocks: 10n }));
    expect(await freeBytes("/volume", { statfs })).toEqual({ free: 12288, total: 40960 });
    expect(statfs).toHaveBeenCalledWith("/volume");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
        await freeBytes("/unavailable", {
            statfs: async () => {
                throw new Error("unavailable");
            },
        }),
    ).toBeNull();
});

async function mature(f: ReturnType<typeof fixture>) {
    expect((await f.lifecycle.scan()).complete).toBe(true);
    f.setNow(NOW + 7 * DAY);
    expect((await f.lifecycle.scan()).complete).toBe(true);
}

it.each(["narrowed", "full"] as const)(
    "keeps the 51st candidate named after the mark across %s batch rechecks",
    async (mode) => {
        const f = fixture({ fullRemarkMaxRows: mode === "narrowed" ? -1 : Infinity });
        const keys = Array.from({ length: 51 }, (_, i) => `assets/batch-${String(i).padStart(2, "0")}`);
        for (const key of keys) f.asset(key);
        f.chat();
        await mature(f);
        f.store.applyChanges({
            chats: [
                {
                    characterId: "alice",
                    chatId: "chat",
                    baseRevision: f.store.chatRevision("alice", "chat"),
                    ops: [{ op: "meta", set: { note: keys[50] } }],
                },
            ],
        });
        const result = await f.lifecycle.sweep({ dryRun: false });
        expect(result.deleted).toEqual(keys.slice(0, 50));
        expect(result.skipped).toEqual([{ key: keys[50], reason: "referenced" }]);
        expect(readFileSync(resolveStorageKey(f.dir, keys[50])!, "utf8")).toBe("A");
        expect(f.lifecycle.sweepMetrics).toMatchObject({
            batches: 2,
            remarks: mode === "full" ? [{ kind: "full" }] : [{ kind: "narrowed" }, { kind: "narrowed" }],
        });
    },
);

it.each([
    ["longer tail", "assets/tail", "assets/tail.png?revision=2"],
    ["API hex", "assets/api", `/api/asset/${Buffer.from("assets/api").toString("hex")}abcd`],
    ["service worker hex", "assets/sw", `/sw/img/${Buffer.from("assets/sw").toString("hex")}`],
    ["uppercase hex", "assets/upper", `/api/asset/${Buffer.from("assets/upper").toString("hex").toUpperCase()}`],
    ["quote", 'assets/a"b', 'assets/a"b'],
    ["backslash", "assets/a\\b", "assets/a\\b"],
    ["newline", "assets/a\nb", "assets/a\nb"],
])("keeps a post-mark reference spelled only as %s in a narrowed recheck", async (_name, key, text) => {
    const f = fixture({ fullRemarkMaxRows: -1 });
    const file = f.asset(key);
    await mature(f);
    f.put("pluginStorage", "main", { text });
    expect(await f.lifecycle.sweep({ dryRun: false })).toMatchObject({
        deleted: [],
        skipped: [{ key, reason: "referenced" }],
    });
    expect(readFileSync(file, "utf8")).toBe("A");
});

it("indexes a snapshot created after the mark inside the batch", async () => {
    const f = fixture();
    const key = "assets/snapshot-only";
    const file = f.asset(key);
    await mature(f);
    f.put("pluginStorage", "main", { key });
    await f.snapshots.snapshotNow();
    f.put("pluginStorage", "main", {});
    expect(await f.lifecycle.sweep({ dryRun: false })).toMatchObject({
        deleted: [],
        skipped: [{ key, reason: "named by snapshot" }],
    });
    expect(readFileSync(file, "utf8")).toBe("A");
});

it("admits a chat write queued by the synchronous delete turn and protects its next-batch key", async () => {
    const clock = sweepClock();
    const s = await createResourceTestClient({ assetLifecycle: { ...clock.options, sweepBatchSize: 1 } });
    cleanups.push(() => s.close());
    const keys = ["assets/first", "assets/later"];
    for (const key of keys) seedSweepAsset(s, key);
    await s.create("characters", "alice", { chaId: "alice" });
    const initial = await s.json("/api/resources/batch", {
        chats: [
            {
                characterId: "alice",
                chatId: "chat",
                baseRevision: null,
                ops: [{ op: "create", chat: { message: [] } }],
            },
        ],
    });
    expect(initial.status).toBe(200);
    const revisions = (await (await s.request("/api/resources/revisions")).json()) as { chats: { revision: string }[] };
    await matureSweep(s, clock);
    const queued = defer();
    const written = defer();
    let response: Response | undefined;
    const unlink = syncFs.unlinkSync;
    const rm = fs.rm;
    vi.spyOn(syncFs, "unlinkSync").mockImplementation((file) => {
        if (String(file) === resolveStorageKey(s.savePath, keys[0])) {
            queueMicrotask(() => {
                queued.resolve();
                void s
                    .json("/api/resources/batch", {
                        chats: [
                            {
                                characterId: "alice",
                                chatId: "chat",
                                baseRevision: revisions.chats[0].revision,
                                ops: [{ op: "meta", set: { note: keys[1] } }],
                            },
                        ],
                    })
                    .then((r) => {
                        response = r;
                        written.resolve();
                    });
            });
        }
        unlink(file);
    });
    // Thumbnail cleanup is outside the synchronous turn and holds the next batch until the HTTP write lands.
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (String(args[0]).includes("thumbnails")) {
            await queued.promise;
            await written.promise;
        }
        return rm(...args);
    });
    syncBuiltinESMExports();
    const result = await s.context.assetLifecycle.sweep({ dryRun: false, keys });
    await written.promise;
    expect(response!.status).toBe(200);
    expect(result.deleted).toEqual([keys[0]]);
    expect(result.skipped).toEqual([{ key: keys[1], reason: "referenced" }]);
});

it("previews the same narrowed deletion and inlay decisions without changing files or records", async () => {
    const f = fixture();
    const free = f.asset("assets/free", 3);
    f.asset("assets/unselected", 4);
    for (const id of ["orphan", "revived"]) {
        f.asset(`assets/${id}`, 5);
        f.put("inlays", id, { asset: `assets/${id}`, type: "image", name: id, ext: "png" });
    }
    await mature(f);
    f.chat({ note: "{{inlay::revived}}" });
    const request = { keys: ["assets/free"], inlays: ["orphan", "revived"] };
    const before = f.ledger();
    const preview = await f.lifecycle.sweep({ ...request, dryRun: true });
    expect(preview).toEqual({
        deleted: ["assets/free"],
        freedBytes: 3,
        removedInlays: ["orphan"],
        skipped: [],
        skippedInlays: [{ id: "revived", reason: "referenced" }],
    });
    expect(f.ledger()).toEqual(before);
    expect(readFileSync(free)).toHaveLength(3);
    expect(f.store.get(kinds.get("inlays")!, "orphan")).not.toBeNull();
    expect(await f.lifecycle.sweep({ ...request, dryRun: false })).toEqual(preview);
    expect(f.store.get(kinds.get("inlays")!, "orphan")).toBeNull();
    expect(f.store.get(kinds.get("inlays")!, "revived")).not.toBeNull();
    expect(syncFs.existsSync(free)).toBe(false);
    expect(readFileSync(resolveStorageKey(f.dir, "assets/unselected")!)).toHaveLength(4);
    expect(readFileSync(resolveStorageKey(f.dir, "assets/orphan")!)).toHaveLength(5);
    const next = await f.lifecycle.scan();
    expect(next.unreferenced.candidates.map((x) => x.key)).toEqual(["assets/unselected"]);
    expect(f.ledger().assets).toContainEqual({ key: "assets/orphan", since: NOW + 7 * DAY, bytes: 5 });
});

it("skips a republished file and a filesystem error while deleting the other candidate", async () => {
    const f = fixture();
    const keys = ["assets/young", "assets/denied", "assets/deleted"];
    const files = keys.map((key) => f.asset(key, 2));
    await mature(f);
    utimesSync(files[0], (NOW + 7 * DAY) / 1000, (NOW + 7 * DAY) / 1000);
    const unlink = syncFs.unlinkSync;
    vi.spyOn(syncFs, "unlinkSync").mockImplementation((file) => {
        if (String(file) === files[1]) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        unlink(file);
    });
    syncBuiltinESMExports();
    const result = await f.lifecycle.sweep({ dryRun: false, keys });
    expect(result.deleted).toEqual([keys[2]]);
    expect(result.freedBytes).toBe(2);
    expect(result.skipped).toEqual([
        { key: keys[0], reason: "young" },
        { key: keys[1], reason: expect.stringContaining("permission denied") },
    ]);
    expect(files.map((file) => syncFs.existsSync(file))).toEqual([true, true, false]);
    expect(f.ledger().assets.map((r) => r.key)).toEqual([keys[1], keys[0]]);
});

it.each(["uptime", "other process", "epoch", "incomplete", "stale"])(
    "refuses sweep with 409 for %s even when files are candidates",
    async (failure) => {
        const clock = sweepClock();
        if (failure === "uptime") clock.setMono(3_599_999);
        const s = await createResourceTestClient({ assetLifecycle: clock.options });
        cleanups.push(() => s.close());
        const file = seedSweepAsset(s, "assets/keep");
        await matureSweep(s, clock);
        if (failure === "stale") clock.setMono(7_200_001);
        if (failure === "incomplete") {
            const snapshot = await s.context.snapshots.snapshotNow();
            writeFileSync(path.join(s.savePath, "backups", snapshot.id + ".sqlite"), "broken");
            expect((await s.context.assetLifecycle.scan()).complete).toBe(false);
        }
        if (failure === "epoch") {
            const snapshot = await s.context.snapshots.snapshotNow();
            expect((await s.request(`/api/backups/${snapshot.id}/restore`, { method: "POST" })).status).toBe(200);
            await s.readEpoch();
        }
        if (failure === "other process") {
            await s.context.dispose();
            const fresh = await createResourceTestClient({ rootDir: s.rootDir, assetLifecycle: clock.options });
            cleanups.push(() => fresh.close());
            expect(fresh.context.assetLifecycle.runIdentity).toBeNull();
            expect((await fresh.json("/api/assets/sweep", { dryRun: false })).status).toBe(409);
            // Fresh store connections restart their counters: equality cannot authenticate a persisted mark.
            const comparison = fixture();
            await mature(comparison);
            const reopened = createResourceStore({
                file: path.join(comparison.dir, "data", "resources.sqlite"),
                kinds,
            });
            const markCount = comparison.lifecycle.runIdentity!.writeCount;
            const kind = kinds.get("pluginStorage")!;
            for (let i = 0; i < markCount; i++)
                reopened.put(kind, "main", { nonce: i }, reopened.get(kind, "main")?.revision ?? null);
            const other = createAssetLifecycle({
                savePath: comparison.dir,
                store: reopened,
                snapshots: comparison.snapshots,
                ...clock.options,
            });
            try {
                expect(reopened.writeCount()).toBe(comparison.lifecycle.runIdentity!.writeCount);
                expect(() => other.sweep({ dryRun: false })).toThrow("No scan from this process");
            } finally {
                await other.close();
                reopened.close();
            }
        } else {
            const response = await s.json("/api/assets/sweep", { dryRun: false });
            expect(response.status).toBe(409);
        }
        expect(readFileSync(file, "utf8")).toBe("old bytes");
        if (failure === "uptime") {
            clock.setMono(3_600_000);
            const allowed = await s.json("/api/assets/sweep", { dryRun: false });
            expect(allowed.status).toBe(200);
            expect(await allowed.json()).toMatchObject({ deleted: ["assets/keep"] });
        }
    },
);

it("fails closed when a post-mark live row cannot be decoded", async () => {
    const f = fixture();
    const file = f.asset("assets/keep-on-error");
    await mature(f);
    f.put("pluginStorage", "main", { text: "assets/keep-on-error" });
    f.db.prepare("UPDATE resources SET data = ? WHERE kind = 'pluginStorage'").run('{"text":"assets/broken"');
    const result = await f.lifecycle.sweep({ dryRun: false });
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([
        { key: "assets/keep-on-error", reason: expect.stringContaining("re-mark failed") },
    ]);
    expect(readFileSync(file, "utf8")).toBe("A");
});
