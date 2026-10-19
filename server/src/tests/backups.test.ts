// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
import type { ChatOrderRecord, ChatRecord } from "../../../shared/chats.ts";
import type {
    BackupArchiveManifest,
    ResourceBatchConflictBody,
    ResourceBatchResult,
} from "../../../shared/resources.ts";
import { MAX_ARCHIVE_RECORDS } from "../data/archive.ts";
import { CHAT_TABLES_SQL } from "../data/chatStore.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import {
    buildArchive,
    createResourceTestClient,
    createTestServer,
    hex,
    parseArchive,
    type ResourceTestClient,
    sleep,
    TEST_INDEX_HTML,
    type TestServerOptions,
    waitFor,
} from "./testSupport.ts";

const servers: ResourceTestClient[] = [];

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

type Snapshot = { id: string; createdAt: string; size: number };
type Stored = { epoch: string; revision: string; data: unknown };

async function defaultServer(options: Omit<TestServerOptions, "password"> = {}) {
    const s = await createResourceTestClient(options);
    servers.push(s);
    return s;
}
const character = (id: string, extra: Record<string, unknown> = {}) => ({ chaId: id, ...extra });
/** A character as the server stores it: the shared defaults filled in (the `characters` normalizer). */
const stored = (id: string, extra: Record<string, unknown> = {}) => normalizeCharacter(character(id, extra));
const backupsDir = (s: ResourceTestClient) => path.join(s.savePath, "backups");
const tmpDir = (s: ResourceTestClient) => path.join(s.savePath, ".tmp");
/** File names under `save/assets`, or none when the folder was never created. */
const assetFiles = (s: ResourceTestClient) => {
    try {
        return readdirSync(path.join(s.savePath, "assets"));
    } catch {
        return [];
    }
};
const listBackups = async (s: ResourceTestClient) =>
    ((await (await s.request("/api/backups")).json()) as { items: Snapshot[] }).items;
const restore = (s: ResourceTestClient, id: string, epoch?: string | null) =>
    s.request(`/api/backups/${id}/restore`, { method: "POST" }, epoch);
const writeAsset = (s: ResourceTestClient, key: string, body: string) =>
    s.request("/api/write", { method: "POST", headers: { "file-path": hex(key) }, body });
const removeAsset = (s: ResourceTestClient, key: string) =>
    s.request("/api/remove", { headers: { "file-path": hex(key) } });
const readAsset = async (s: ResourceTestClient, key: string) =>
    (await s.request("/api/read", { headers: { "file-path": hex(key) } })).text();
const exportArchive = async (s: ResourceTestClient, body: unknown = {}) => {
    const res = await s.json("/api/backups/export", body);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    return new Uint8Array(await res.arrayBuffer());
};
const importArchive = (s: ResourceTestClient, bytes: Uint8Array | ReadableStream<Uint8Array>, epoch?: string | null) =>
    s.request(
        "/api/backups/import",
        {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: bytes,
            duplex: "half",
        } as RequestInit,
        epoch,
    );
/** The live database as a snapshot file's bytes. */
async function databaseBytes(s: ResourceTestClient): Promise<Buffer> {
    const snapshot = await s.context.snapshots.snapshotNow();
    return readFileSync(path.join(backupsDir(s), `${snapshot.id}.sqlite`));
}
const manifestOf = (assets: string[], extra: Partial<BackupArchiveManifest> = {}) =>
    JSON.stringify({
        version: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        partial: false,
        assets,
        missing: [],
        ...extra,
    });
/** A well-formed archive: manifest, database, then the assets. */
function archiveOf(
    database: Uint8Array,
    assets: Record<string, string> = {},
    manifest = manifestOf(Object.keys(assets)),
) {
    return buildArchive([
        ["manifest.json", manifest],
        ["resources.sqlite", database],
        ...Object.entries(assets).map(([key, data]): [string, string] => [key, data]),
    ]);
}
const reader = createResourceStore({ file: ":memory:", kinds: createKindRegistry(DEFAULT_RESOURCE_KINDS) });
afterAll(() => reader.close());
/**
 * The kinds the store materializes (slice 3): their `main` rows exist in every store from the start,
 * so the row checks below look only at the rows the tests wrote.
 */
const materialized = new Set(DEFAULT_RESOURCE_KINDS.filter((k) => k.materialize).map((k) => k.name));
const writtenRows = <T extends { kind: string }>(rows: readonly T[]) => rows.filter((r) => !materialized.has(r.kind));

function defer() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

describe("GET /api/backups", () => {
    it("lists the completed snapshots newest first and requires auth", async () => {
        const s = await defaultServer();
        expect(await listBackups(s)).toEqual([]);
        const first = await s.context.snapshots.snapshotNow();
        await sleep(2);
        const second = await s.context.snapshots.snapshotNow();
        writeFileSync(path.join(backupsDir(s), ".resources-20300101T000000000Z-01234567.sqlite.tmp"), "x");
        writeFileSync(path.join(backupsDir(s), "resources.sqlite"), "x");
        const res = await s.request("/api/backups");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ items: [second, first] });
        expect((await s.app.request("/api/backups")).status).toBe(400);
    });
});

describe("POST /api/backups/:id/restore", () => {
    it("replaces every resource with the snapshot under a new epoch, after a safety snapshot", async () => {
        const s = await defaultServer();
        const a = await s.create("characters", "a", character("a"));
        // `pluginStorage`: a singleton the store does not materialize, so the test's own write is a create.
        await s.create("pluginStorage", "main", { note: "before" });
        const snapshot = await s.context.snapshots.snapshotNow();
        await s.put("characters", "a", { baseRevision: a, data: character("a", { name: "changed" }) });
        await s.create("characters", "b", character("b"));
        const oldEpoch = s.epoch;

        const res = await restore(s, snapshot.id);
        expect(res.status).toBe(200);
        const { epoch } = (await res.json()) as { epoch: string };
        expect(epoch).not.toBe(oldEpoch);
        expect(await s.readEpoch()).toBe(epoch);
        const backups = await listBackups(s);
        expect(backups).toHaveLength(2);
        expect(backups[1]).toEqual(snapshot);
        // The safety snapshot holds the state from just before the restore.
        expect(
            writtenRows(reader.readSnapshot(path.join(backupsDir(s), `${backups[0].id}.sqlite`)).rows).map(
                (r) => `${r.kind}/${r.id}`,
            ),
        ).toEqual(["characters/a", "pluginStorage/main", "characters/b"]);

        const characters = (await (await s.list("characters")).json()) as { items: (Stored & { id: string })[] };
        expect(characters.items.map((c) => [c.id, c.data])).toEqual([["a", stored("a")]]);
        expect(characters.items[0].revision.startsWith(`${epoch}:`)).toBe(true);
        expect(await (await s.get("pluginStorage", "main")).json()).toMatchObject({ data: { note: "before" } });

        // Every mutation based on the old epoch is refused, including a create; the old tokens are stale.
        const oldEpochResponses = [
            await s.put("characters", "a", { baseRevision: a, data: character("a") }, oldEpoch),
            await s.put("characters", "new", { baseRevision: null, data: character("new") }, oldEpoch),
            await s.remove("characters", "a", `?baseRevision=${a}`, oldEpoch),
            await s.batch([{ kind: "characters", id: "new", baseRevision: null, data: character("new") }], oldEpoch),
            await restore(s, snapshot.id, oldEpoch),
        ];
        for (const res of oldEpochResponses) {
            expect(res.status).toBe(412);
            expect(await res.json()).toEqual({ error: "EpochMismatch", epoch });
        }
        const stale = await s.put("characters", "a", { baseRevision: a, data: character("a") });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({ error: "Revision conflict", revision: characters.items[0].revision });
        expect((await s.put("characters", "new", { baseRevision: null, data: character("new") })).status).toBe(200);
        expect(readdirSync(tmpDir(s))).toEqual([]);
    });

    it("answers 404 for ids that are not listed snapshots and 412 for a wrong epoch, without touching anything", async () => {
        const s = await defaultServer();
        await s.create("characters", "a", character("a"));
        const snapshot = await s.context.snapshots.snapshotNow();
        writeFileSync(path.join(backupsDir(s), ".resources-20300101T000000000Z-01234567.sqlite.tmp"), "x");
        for (const id of [
            "nope",
            "resources-20300101T000000000Z-01234567",
            `${snapshot.id}.sqlite`,
            encodeURIComponent("../data/resources"),
            encodeURIComponent(`../backups/${snapshot.id}`),
        ]) {
            const res = await restore(s, id);
            expect(res.status, id).toBe(404);
            expect(await res.json(), id).toEqual({ error: "Snapshot not found" });
        }
        for (const epoch of [null, "", "00000000-0000-4000-8000-000000000000"]) {
            const res = await restore(s, snapshot.id, epoch);
            expect(res.status, String(epoch)).toBe(412);
            expect(await res.json(), String(epoch)).toEqual({ error: "EpochMismatch", epoch: s.epoch });
        }
        expect((await s.app.request(`/api/backups/${snapshot.id}/restore`, { method: "POST" })).status).toBe(400);
        expect(await listBackups(s)).toEqual([snapshot]);
        expect(await s.readEpoch()).toBe(s.epoch);
    });

    it("refuses an invalid snapshot file with 400 and leaves the data, epoch, and snapshots untouched", async () => {
        const s = await defaultServer();
        const revision = await s.create("characters", "a", character("a"));
        const epoch = s.epoch;
        const garbage = "resources-20300101T000000000Z-00000001";
        writeFileSync(path.join(backupsDir(s), `${garbage}.sqlite`), "garbage that is not a database file at all");
        const badRow = "resources-20300101T000000000Z-00000002";
        const db = new DatabaseSync(path.join(backupsDir(s), `${badRow}.sqlite`));
        db.exec(`
            PRAGMA user_version = 3;
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            CREATE TABLE resources (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
                revision INTEGER NOT NULL, schemaVersion INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE (kind, id)) STRICT;
            ${CHAT_TABLES_SQL}
            INSERT INTO meta (key, value) VALUES ('epoch', 'e');
            INSERT INTO resources (kind, id, revision, schemaVersion, data) VALUES ('characters', 'x', 1, 1, '{"chaId":"y"}');`);
        db.close();
        // A Phase 1 database (schema version 1: characters with their chats inside) is a listed
        // snapshot too, and is refused by its version.
        const v1 = "resources-20300101T000000000Z-00000003";
        const old = new DatabaseSync(path.join(backupsDir(s), `${v1}.sqlite`));
        old.exec("PRAGMA user_version = 1; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
        old.close();
        const before = await listBackups(s);
        expect(before.map((b) => b.id)).toEqual([v1, badRow, garbage]);

        const notResource = await restore(s, garbage);
        expect(notResource.status).toBe(400);
        expect(await notResource.json()).toEqual({ error: "Not a resource database" });
        const rejectedRow = await restore(s, badRow);
        expect(rejectedRow.status).toBe(400);
        expect(await rejectedRow.json()).toEqual({ error: "row 1: character.chaId must equal the resource id" });
        const rejectedVersion = await restore(s, v1);
        expect(rejectedVersion.status).toBe(400);
        expect(await rejectedVersion.json()).toEqual({ error: "Unsupported resource database version 1" });

        expect(await listBackups(s)).toEqual(before);
        expect(await s.readEpoch()).toBe(epoch);
        expect(await (await s.get("characters", "a")).json()).toEqual({ epoch, revision, data: stored("a") });
        expect((await s.put("characters", "b", { baseRevision: null, data: character("b") })).status).toBe(200);
    });

    it("refuses a restore queued behind another one with 412 before taking its safety snapshot", async () => {
        const s = await defaultServer();
        await s.create("characters", "a", character("a"));
        const snapshot = await s.context.snapshots.snapshotNow();
        const holding = defer();
        const entered = defer();
        const lock = s.context.snapshots.exclusive(async () => {
            entered.resolve();
            await holding.promise;
        });
        await entered.promise;
        // The two restores must queue behind the held lock in order. Each request signs and verifies
        // its JWT first, so under load the second could reach the lock first and win; the route's
        // `track` call starts `withMaintenance`, which enqueues synchronously, so the second restore
        // is sent only once the first is queued.
        const tracked = vi.spyOn(s.context.snapshots, "track");
        const first = restore(s, snapshot.id);
        await waitFor(() => tracked.mock.calls.length === 1);
        const second = restore(s, snapshot.id);
        await waitFor(() => tracked.mock.calls.length === 2);
        holding.resolve();
        await lock;
        expect((await first).status).toBe(200);
        const stale = await second;
        expect(stale.status).toBe(412);
        expect(await stale.json()).toEqual({ error: "EpochMismatch", epoch: await s.readEpoch() });
        // One safety snapshot: the first restore's.
        expect(await listBackups(s)).toHaveLength(2);
    });
});

describe("maintenance", () => {
    it("answers 503 with Retry-After for resource and storage mutations while a restore or import holds the files, reads stay open", async () => {
        const s = await defaultServer();
        const revision = await s.create("characters", "a", character("a"));
        await writeAsset(s, "assets/x.png", "png");
        const inside = defer();
        const release = defer();
        const maintenance = s.context.snapshots.withMaintenance(async () => {
            inside.resolve();
            await release.promise;
        });
        await inside.promise;

        const closed = [
            await s.put("characters", "a", { baseRevision: revision, data: character("a", { n: 1 }) }),
            await s.put("characters", "b", { baseRevision: null, data: character("b") }),
            await s.remove("characters", "a", `?baseRevision=${revision}`),
            await s.batch([{ kind: "characters", id: "b", baseRevision: null, data: character("b") }]),
            await writeAsset(s, "assets/y.png", "png"),
            await removeAsset(s, "assets/x.png"),
        ];
        for (const res of closed) {
            expect(res.status, res.url).toBe(503);
            expect(res.headers.get("retry-after"), res.url).toBe("5");
            expect(await res.json(), res.url).toEqual({ error: "Maintenance in progress" });
        }
        expect((await s.get("characters", "a")).status).toBe(200);
        expect((await s.readKinds("characters")).status).toBe(200);
        expect(await readAsset(s, "assets/x.png")).toBe("png");
        expect((await s.request("/api/list")).status).toBe(200);
        expect((await s.request("/api/backups")).status).toBe(200);
        // A restore or an export arriving meanwhile queues behind the lock instead.
        let queuedRestore: Response | null = null;
        const queuedExport = s.json("/api/backups/export", {});
        const queuedRestoring = restore(s, "resources-20300101T000000000Z-01234567").then(
            (res) => (queuedRestore = res),
        );
        await sleep(20);
        expect(queuedRestore).toBeNull();

        release.resolve();
        await maintenance;
        await queuedRestoring;
        expect(queuedRestore!.status).toBe(404);
        const exported = await queuedExport;
        expect(exported.status).toBe(200);
        await exported.arrayBuffer();
        expect((await s.put("characters", "b", { baseRevision: null, data: character("b") })).status).toBe(200);
        expect((await writeAsset(s, "assets/y.png", "png")).status).toBe(200);
        expect((await removeAsset(s, "assets/x.png")).status).toBe(200);
        expect(await (await s.get("characters", "a")).json()).toEqual({
            epoch: s.epoch,
            revision,
            data: stored("a"),
        });
    });

    it("lets an asset removal admitted before a restore finish before the restore runs", async () => {
        const s = await defaultServer();
        await writeAsset(s, "assets/keep", "blob");
        await s.create("inlays", "keep", { name: "keep", ext: "png", type: "image", asset: "assets/keep" });
        const snapshot = await s.context.snapshots.snapshotNow();

        const original = fs.rm;
        const entered = defer();
        const release = defer();
        vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
            if (String(target).endsWith(`${path.sep}assets${path.sep}keep`)) {
                entered.resolve();
                await release.promise;
            }
            return original.call(fs, target, options);
        });
        const removing = removeAsset(s, "assets/keep");
        await entered.promise;

        let restored: Response | null = null;
        const restoring = restore(s, snapshot.id).then((res) => (restored = res));
        await sleep(30);
        // Maintenance is closed to new mutations, but the restore waits for the removal in flight.
        expect(restored).toBeNull();
        expect(s.context.snapshots.gate.active).toBe(true);
        expect((await writeAsset(s, "assets/other", "x")).status).toBe(503);
        expect((await s.put("characters", "c", { baseRevision: null, data: character("c") })).status).toBe(503);

        release.resolve();
        expect((await removing).status).toBe(200);
        await restoring;
        expect(restored!.status).toBe(200);
        expect(s.context.snapshots.gate.active).toBe(false);
        // The removal completed before the restore, not across it.
        expect(await readAsset(s, "assets/keep")).toBe("");
        expect((await writeAsset(s, "assets/other", "x")).status).toBe(200);
    });
});

describe("POST /api/backups/export", () => {
    it("streams the manifest, a fresh snapshot, and every asset of the assets namespace under its logical key", async () => {
        const s = await defaultServer();
        await s.create("characters", "a", character("a"));
        await writeAsset(s, "assets/b.png", "PNG-B");
        await writeAsset(s, "assets/a.webp", "WEBP-A");
        await writeAsset(s, "assets/한글 name/x", "KO");
        mkdirSync(path.join(s.savePath, "assets", "subfolder"));
        writeFileSync(path.join(s.savePath, "assets", "Not-Canonical.png"), "skipped");
        await writeAsset(s, "database/database.bin", "not an asset");

        const records = parseArchive(await exportArchive(s));
        expect(records.map((r) => r.name)).toEqual([
            "manifest.json",
            "resources.sqlite",
            "assets/a.webp",
            "assets/b.png",
            "assets/한글 name/x",
        ]);
        const manifest = JSON.parse(records[0].data.toString("utf-8")) as BackupArchiveManifest;
        expect(manifest).toEqual({
            version: 2,
            createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            partial: false,
            assets: ["assets/a.webp", "assets/b.png", "assets/한글 name/x"],
            missing: [],
        });
        expect(records.slice(2).map((r) => r.data.toString("utf-8"))).toEqual(["WEBP-A", "PNG-B", "KO"]);
        const extracted = path.join(s.rootDir, "extracted.sqlite");
        writeFileSync(extracted, records[1].data);
        expect(writtenRows(reader.readSnapshot(extracted).rows).map((r) => r.id)).toEqual(["a"]);
        expect(readdirSync(tmpDir(s))).toEqual([]);
        // An export is not a retained snapshot.
        expect(await listBackups(s)).toEqual([]);
    });

    it("exports only the listed keys for a partial backup and reports the missing ones", async () => {
        const s = await defaultServer();
        await writeAsset(s, "assets/a.png", "A");
        await writeAsset(s, "assets/b.png", "B");
        const records = parseArchive(
            await exportArchive(s, { partial: ["assets/b.png", "assets/missing.png", "assets/b.png"] }),
        );
        expect(records.map((r) => r.name)).toEqual(["manifest.json", "resources.sqlite", "assets/b.png"]);
        expect(JSON.parse(records[0].data.toString("utf-8"))).toMatchObject({
            partial: true,
            assets: ["assets/b.png"],
            missing: ["assets/missing.png"],
        });
        for (const partial of [
            "x",
            "true",
            false,
            ["database/database.bin"],
            ["assets/"],
            [1],
            ["Assets/x.png"],
            [null],
            [true],
        ]) {
            const res = await s.json("/api/backups/export", { partial });
            expect(res.status, JSON.stringify(partial)).toBe(400);
            expect(await res.json(), JSON.stringify(partial)).toEqual({
                error: "partial must be a list of asset keys",
            });
        }
        expect(readdirSync(tmpDir(s))).toEqual([]);
    });

    it("`partial: true` selects the profile images from the archived snapshot and reports the ones it lacks", async () => {
        const s = await defaultServer();
        await s.create(
            "characters",
            "alice",
            character("alice", {
                name: "Alice",
                image: "assets/alice.png",
                emotionImages: [["happy", "assets/happy.png"]],
            }),
        );
        await s.create("characters", "bob", character("bob", { name: "Bob", image: "assets/nofile.png" }));
        await s.create("characters", "carol", character("carol", { name: "Carol", image: "assets/" }));
        // A singleton the store materializes exists already; the others are created.
        const putSingleton = async (kind: string, data: unknown) => {
            const current = await s.get(kind, "main");
            const baseRevision =
                current.status === 200 ? ((await current.json()) as { revision: string }).revision : null;
            expect((await s.put(kind, "main", { baseRevision, data })).status, kind).toBe(200);
        };
        await putSingleton("personas", [{ id: "me", name: "Me", icon: "assets/me.png", personaPrompt: "", note: "" }]);
        await putSingleton("characterOrder", [
            "alice",
            { id: "f", type: "folder", name: "F", img: "assets/folder.png", data: ["bob"] },
        ]);
        const ui = (await (await s.get("ui", "main")).json()) as { data: Record<string, unknown> };
        await putSingleton("ui", { ...ui.data, customBackground: "assets/bg.png" });
        await putSingleton("presets", [{ name: "P", image: "assets/preset.png" }]);
        for (const key of ["alice", "happy", "me", "folder", "bg", "preset", "unreferenced"]) {
            await writeAsset(s, `assets/${key}.png`, key.toUpperCase());
        }

        const records = parseArchive(await exportArchive(s, { partial: true }));
        const manifest = JSON.parse(records[0].data.toString("utf-8")) as BackupArchiveManifest;
        const selected = [
            "assets/alice.png",
            "assets/bg.png",
            "assets/folder.png",
            "assets/me.png",
            "assets/preset.png",
        ];
        expect(manifest.partial).toBe(true);
        expect([...manifest.assets].sort()).toEqual(selected);
        // A referenced key with no file, and one that names no storage location, are reported, not fatal.
        expect([...manifest.missing].sort()).toEqual(["assets/", "assets/nofile.png"]);
        expect(records.slice(2).map((r) => r.name)).toEqual(manifest.assets);
        expect(records.slice(2).map((r) => r.data.toString("utf-8"))).toEqual(
            manifest.assets.map((key) => key.slice("assets/".length, -".png".length).toUpperCase()),
        );
        expect(readdirSync(tmpDir(s))).toEqual([]);
    });

    it("`partial: true` follows the snapshot it archives, not the state before a concurrent image change", async () => {
        const s = await defaultServer();
        const revision = await s.create(
            "characters",
            "alice",
            character("alice", { name: "Alice", image: "assets/old.png" }),
        );
        await writeAsset(s, "assets/old.png", "OLD");
        await writeAsset(s, "assets/new.png", "NEW");
        // The image changes before the export snapshots the store (another tab, a job, a plugin).
        const res = await s.put("characters", "alice", {
            baseRevision: revision,
            data: stored("alice", { name: "Alice", image: "assets/new.png" }),
        });
        expect(res.status).toBe(200);
        const records = parseArchive(await exportArchive(s, { partial: true }));
        expect(JSON.parse(records[0].data.toString("utf-8"))).toMatchObject({
            partial: true,
            assets: ["assets/new.png"],
            missing: [],
        });
        const extracted = path.join(s.rootDir, "partial.sqlite");
        writeFileSync(extracted, records[1].data);
        const alice = reader.readSnapshot(extracted).rows.find((r) => r.kind === "characters" && r.id === "alice")!;
        expect(JSON.parse(alice.text).image).toBe("assets/new.png");
    });

    it("fails the download when a listed asset disappears after the manifest was fixed, and cleans up", async () => {
        const s = await defaultServer();
        await writeAsset(s, "assets/gone.png", "G");
        const res = await s.json("/api/backups/export", {});
        expect(res.status).toBe(200);
        expect(readdirSync(tmpDir(s))).toHaveLength(1);
        await fs.rm(path.join(s.savePath, "assets", "gone.png"));
        await expect(res.arrayBuffer()).rejects.toThrow();
        await waitFor(() => readdirSync(tmpDir(s)).length === 0);
    });

    it("removes the staging copy once when the download is cancelled mid-stream", async () => {
        const s = await defaultServer();
        await writeAsset(s, "assets/a.png", "A".repeat(100_000));
        const rm = vi.spyOn(fs, "rm");
        const res = await s.json("/api/backups/export", {});
        const reader = res.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel();
        await waitFor(() => readdirSync(tmpDir(s)).length === 0);
        await sleep(20);
        expect(rm.mock.calls.filter(([target]) => path.basename(String(target)).startsWith("export-"))).toHaveLength(1);
    });

    it("releases the staging copy and the lifetime when the client aborts after the first chunk without cancelling", async () => {
        const s = await defaultServer();
        await writeAsset(s, "assets/a.png", "A".repeat(100_000));
        const controller = new AbortController();
        const res = await s.request(
            "/api/backups/export",
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: controller.signal },
            null,
        );
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        expect(readdirSync(tmpDir(s))).toHaveLength(1);
        // The adapter stops pulling: the generator waits at a `yield` and nothing cancels the stream.
        controller.abort();
        await waitFor(() => readdirSync(tmpDir(s)).length === 0);
        let stopped = false;
        const stopping = s.context.snapshots.stop().then(() => (stopped = true));
        await waitFor(() => stopped);
        await stopping;
    });

    it("cleans up an export the client abandoned during preparation, and keeps shutdown waiting until then", async () => {
        const s = await defaultServer();
        const holding = defer();
        const entered = defer();
        const lock = s.context.snapshots.exclusive(async () => {
            entered.resolve();
            await holding.promise;
        });
        await entered.promise;
        const controller = new AbortController();
        const pending = s.request(
            "/api/backups/export",
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: controller.signal },
            null,
        );
        await waitFor(() => readdirSync(tmpDir(s)).some((name) => name.startsWith("export-")));
        controller.abort();
        await sleep(20);
        // Preparation is still queued behind the lock: nothing is removed under it, and the lifetime is held.
        expect(readdirSync(tmpDir(s))).toHaveLength(1);
        let stopped = false;
        const stopping = s.context.snapshots.stop().then(() => (stopped = true));
        await sleep(20);
        expect(stopped).toBe(false);

        holding.resolve();
        await lock;
        const res = await pending;
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Request aborted" });
        expect(readdirSync(tmpDir(s))).toEqual([]);
        await stopping;
        expect(stopped).toBe(true);
    });

    it("finalizes only after the staging folder exists when the client leaves during its creation", async () => {
        const s = await defaultServer();
        const original = fs.mkdir;
        const entered = defer();
        const release = defer();
        vi.spyOn(fs, "mkdir").mockImplementation((async (target: string, options?: unknown) => {
            const result = await (original as (t: string, o?: unknown) => Promise<string | undefined>).call(
                fs,
                target,
                options,
            );
            if (String(target).includes(`${path.sep}export-`)) {
                entered.resolve();
                await release.promise;
            }
            return result;
        }) as typeof fs.mkdir);
        const controller = new AbortController();
        const pending = s.request(
            "/api/backups/export",
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: controller.signal },
            null,
        );
        await entered.promise;
        controller.abort();
        let stopped = false;
        const stopping = s.context.snapshots.stop().then(() => (stopped = true));
        await sleep(20);
        expect(stopped).toBe(false);
        release.resolve();
        const res = await pending;
        expect(res.status).toBe(400);
        expect(readdirSync(tmpDir(s))).toEqual([]);
        await stopping;
    });
});

describe("POST /api/backups/import", () => {
    it("restores the resources and adds only the missing assets of an exported archive", async () => {
        const source = await defaultServer();
        await source.create("characters", "a", character("a"));
        await source.create("pluginStorage", "main", { note: "u" });
        await writeAsset(source, "assets/shared.png", "SOURCE");
        await writeAsset(source, "assets/new.png", "NEW");
        const archive = await exportArchive(source);

        const target = await defaultServer();
        await target.create("characters", "z", character("z"));
        await writeAsset(target, "assets/shared.png", "TARGET");
        const oldEpoch = target.epoch;
        const res = await importArchive(target, archive);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { epoch: string; assetsWritten: number; assetsSkipped: number };
        expect(body).toEqual({ epoch: expect.any(String), assetsWritten: 1, assetsSkipped: 1 });
        expect(body.epoch).not.toBe(oldEpoch);
        expect(await target.readEpoch()).toBe(body.epoch);
        expect(await readAsset(target, "assets/shared.png")).toBe("TARGET");
        expect(await readAsset(target, "assets/new.png")).toBe("NEW");
        const state = (await (await target.readKinds("characters,pluginStorage")).json()) as {
            kinds: Record<string, { id: string; data: unknown }[]>;
        };
        expect(state.kinds.characters.map((c) => [c.id, c.data])).toEqual([["a", stored("a")]]);
        expect(state.kinds.pluginStorage.map((r) => r.data)).toEqual([{ note: "u" }]);
        // The safety snapshot holds the target's previous state; staging is gone; old-epoch writes are refused.
        const backups = await listBackups(target);
        expect(backups).toHaveLength(1);
        expect(
            writtenRows(reader.readSnapshot(path.join(backupsDir(target), `${backups[0].id}.sqlite`)).rows).map(
                (r) => r.id,
            ),
        ).toEqual(["z"]);
        expect(readdirSync(tmpDir(target))).toEqual([]);
        expect(
            (await target.put("characters", "q", { baseRevision: null, data: character("q") }, oldEpoch)).status,
        ).toBe(412);
        expect((await target.put("characters", "q", { baseRevision: null, data: character("q") })).status).toBe(200);
    });

    it("refuses malformed or foreign archives with 400 and writes nothing", async () => {
        const s = await defaultServer();
        const revision = await s.create("characters", "a", character("a"));
        await writeAsset(s, "assets/existing", "E");
        const epoch = s.epoch;
        const db = await databaseBytes(s);
        const before = await listBackups(s);
        const good = archiveOf(db, { "assets/x": "X" });
        const longName = "assets/" + "n".repeat(4200);
        const cases: [string, Uint8Array, string][] = [
            [
                "account marker late",
                buildArchive([
                    ["manifest.json", manifestOf([])],
                    ["resources.sqlite", db],
                    ["encryption.risudat", "x"],
                ]),
                "This backup was encrypted with a Risu Account and cannot be restored",
            ],
            [
                "pre-v2 archive",
                buildArchive([
                    ["a.png", "x"],
                    ["database.risudat", "x"],
                ]),
                "This backup was made by an older version, which saved the database in a format this version no longer reads",
            ],
            ["truncated tail", good.subarray(0, good.length - 1), "The archive is truncated"],
            ["truncated header", good.subarray(0, 6), "The archive has an invalid record header"],
            ["empty", new Uint8Array(0), "The archive has no manifest"],
            [
                "duplicate record",
                buildArchive([
                    ["manifest.json", manifestOf([])],
                    ["resources.sqlite", db],
                    ["resources.sqlite", db],
                ]),
                "The archive holds resources.sqlite twice",
            ],
            [
                "manifest not first",
                buildArchive([
                    ["resources.sqlite", db],
                    ["manifest.json", manifestOf([])],
                ]),
                "The archive has no manifest",
            ],
            ["manifest not JSON", archiveOf(db, {}, "{"), "The archive manifest is not JSON"],
            [
                "manifest version 1",
                archiveOf(db, {}, JSON.stringify({ version: 1, assets: [] })),
                "Unsupported archive version",
            ],
            [
                "manifest without assets",
                archiveOf(db, {}, JSON.stringify({ version: 2 })),
                "The archive manifest has no asset list",
            ],
            [
                "manifest assets not strings",
                archiveOf(db, {}, JSON.stringify({ version: 2, assets: [1] })),
                "The archive manifest has no asset list",
            ],
            [
                "manifest lists an asset twice",
                buildArchive([
                    ["manifest.json", manifestOf(["assets/a", "assets/a"])],
                    ["resources.sqlite", db],
                    ["assets/a", "a"],
                    ["assets/b", "b"],
                ]),
                "The archive manifest lists an asset twice",
            ],
            [
                "manifest lists a missing asset",
                archiveOf(db, { "assets/x": "X" }, manifestOf(["assets/x", "assets/y"])),
                "The archive does not hold the assets its manifest lists",
            ],
            [
                "undeclared asset",
                archiveOf(db, { "assets/x": "X", "assets/y": "Y" }, manifestOf(["assets/x"])),
                "The archive does not hold the assets its manifest lists",
            ],
            [
                "unexpected record",
                buildArchive([
                    ["manifest.json", manifestOf([])],
                    ["resources.sqlite", db],
                    ["database/x", "x"],
                ]),
                "The archive holds an unexpected record: database/x",
            ],
            [
                "unresolvable asset key",
                buildArchive([
                    ["manifest.json", manifestOf(["assets/"])],
                    ["resources.sqlite", db],
                    ["assets/", "x"],
                ]),
                "The archive holds an unexpected record: assets/",
            ],
            [
                "no database",
                buildArchive([["manifest.json", manifestOf([])]]),
                "The archive holds no resource database",
            ],
            ["bad sqlite", archiveOf(new Uint8Array([1, 2, 3]), { "assets/x": "X" }), "Not a resource database"],
            ["empty sqlite", archiveOf(new Uint8Array(0)), "Unsupported resource database version 0"],
            [
                "name too long",
                buildArchive([
                    ["manifest.json", manifestOf([longName])],
                    ["resources.sqlite", db],
                    [longName, "x"],
                ]),
                "The archive has an invalid record header",
            ],
            [
                "name not UTF-8",
                Buffer.concat([
                    buildArchive([
                        ["manifest.json", manifestOf([])],
                        ["resources.sqlite", db],
                    ]),
                    Buffer.from([2, 0, 0, 0, 0xff, 0xfe, 0, 0, 0, 0]),
                ]),
                "The archive has a record name that is not UTF-8",
            ],
        ];
        for (const [label, bytes, error] of cases) {
            const res = await importArchive(s, bytes);
            expect(res.status, label).toBe(400);
            expect(await res.json(), label).toEqual({ error });
        }
        expect(assetFiles(s)).toEqual(["existing"]);
        expect(readdirSync(tmpDir(s))).toEqual([]);
        expect(await listBackups(s)).toEqual(before);
        expect(await s.readEpoch()).toBe(epoch);
        expect(await (await s.get("characters", "a")).json()).toEqual({ epoch, revision, data: stored("a") });
    });

    it("ignores cold-storage records of old archives", async () => {
        const s = await defaultServer();
        const db = await databaseBytes(s);
        const res = await importArchive(
            s,
            buildArchive([
                ["manifest.json", manifestOf([])],
                ["coldstorage_1.json", "{}"],
                ["resources.sqlite", db],
            ]),
        );
        expect(res.status).toBe(200);
    });

    it("refuses an archive with more records than the index allows", async () => {
        const s = await defaultServer();
        const db = await databaseBytes(s);
        const head = buildArchive([
            ["manifest.json", manifestOf([])],
            ["resources.sqlite", db],
        ]);
        const tiny = buildArchive([["a", ""]]);
        const flood = Buffer.alloc(tiny.length * (MAX_ARCHIVE_RECORDS - 1));
        for (let i = 0; i < MAX_ARCHIVE_RECORDS - 1; i++) {
            flood.set(tiny, i * tiny.length);
        }
        const res = await importArchive(s, Buffer.concat([head, flood]));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "The archive holds too many records" });
        expect(readdirSync(tmpDir(s))).toEqual([]);
    });

    it("caps the upload at maxImportBytes, by the declared length and by the bytes received", async () => {
        const s = await defaultServer({ maxImportBytes: 256 * 1024 });
        const big = new Uint8Array(300 * 1024);
        const declared = await s.request("/api/backups/import", {
            method: "POST",
            headers: { "content-type": "application/octet-stream", "content-length": String(big.length) },
            body: big,
        });
        expect(declared.status).toBe(413);
        expect(await declared.json()).toEqual({ error: "Archive too large" });
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(big);
                controller.close();
            },
        });
        const counted = await importArchive(s, stream);
        expect(counted.status).toBe(413);
        expect(await counted.json()).toEqual({ error: "Archive too large" });
        expect(readdirSync(tmpDir(s))).toEqual([]);
        // Under the cap, the ordinary 100 MiB body limit does not apply to this route.
        const small = await importArchive(s, archiveOf(await databaseBytes(s)));
        expect(small.status).toBe(200);
    });

    it("requires the auth header before reading the body, an epoch before spooling, and a body", async () => {
        const s = await defaultServer();
        let reads = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    reads += 1;
                    controller.enqueue(new Uint8Array([1]));
                },
            },
            { highWaterMark: 0 },
        );
        const denied = await s.app.request("/api/backups/import", {
            method: "POST",
            body,
            duplex: "half",
        } as RequestInit);
        expect(denied.status).toBe(400);
        expect(await denied.json()).toEqual({ error: "No auth header" });
        expect(reads).toBe(0);

        for (const epoch of [null, "", "00000000-0000-4000-8000-000000000000"]) {
            const stale = await importArchive(s, body, epoch);
            expect(stale.status, String(epoch)).toBe(412);
            expect(await stale.json(), String(epoch)).toEqual({ error: "EpochMismatch", epoch: s.epoch });
        }
        expect(reads).toBe(0);
        const noBody = await s.request("/api/backups/import", { method: "POST" });
        expect(noBody.status).toBe(400);
        expect(await noBody.json()).toEqual({ error: "Archive body required" });
        expect(readdirSync(tmpDir(s))).toEqual([]);
    });

    it("refuses an upload that a restore overtook with 412 before writing any asset", async () => {
        const s = await defaultServer();
        await s.create("characters", "a", character("a"));
        const snapshot = await s.context.snapshots.snapshotNow();
        const bytes = archiveOf(await databaseBytes(s), { "assets/stale.png": "S" });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
            },
        });
        const importing = importArchive(s, body);
        controller.enqueue(bytes.subarray(0, 20));
        await waitFor(() => readdirSync(tmpDir(s)).some((name) => name.startsWith("import-")));
        const before = await listBackups(s);
        const restored = await restore(s, snapshot.id);
        expect(restored.status).toBe(200);
        const { epoch } = (await restored.json()) as { epoch: string };
        controller.enqueue(bytes.subarray(20));
        controller.close();
        const res = await importing;
        expect(res.status).toBe(412);
        expect(await res.json()).toEqual({ error: "EpochMismatch", epoch });
        expect(assetFiles(s)).toEqual([]);
        // Only the restore's safety snapshot was added: the refused import took none.
        expect(await listBackups(s)).toHaveLength(before.length + 1);
        expect(readdirSync(tmpDir(s))).toEqual([]);
        expect(await s.readEpoch()).toBe(epoch);
    });

    it("runs one import at a time and recovers admission after a staging failure", async () => {
        const s = await defaultServer();
        const bytes = archiveOf(await databaseBytes(s));
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
            },
        });
        const first = importArchive(s, body);
        controller.enqueue(bytes.subarray(0, 20));
        await waitFor(() => readdirSync(tmpDir(s)).some((name) => name.startsWith("import-")));
        const second = await importArchive(s, bytes);
        expect(second.status).toBe(409);
        expect(await second.json()).toEqual({ error: "Another import is running" });
        controller.enqueue(bytes.subarray(20));
        controller.close();
        expect((await first).status).toBe(200);
        await s.readEpoch();

        const original = fs.mkdir;
        vi.spyOn(fs, "mkdir").mockImplementation((async (target: string, options?: unknown) => {
            if (String(target).includes(`${path.sep}import-`)) {
                throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
            }
            return (original as (t: string, o?: unknown) => Promise<string | undefined>).call(fs, target, options);
        }) as typeof fs.mkdir);
        expect((await importArchive(s, bytes)).status).toBe(500);
        vi.mocked(fs.mkdir).mockRestore();
        const after = await importArchive(s, archiveOf(await databaseBytes(s)));
        expect(after.status).toBe(200);
        expect(readdirSync(tmpDir(s))).toEqual([]);
    });
});

describe("chats in snapshots and archives", () => {
    type ChatsRead = { epoch: string; chats: ChatRecord[]; chatOrders: ChatOrderRecord[] };
    const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
    const group = (chatId: string, baseRevision: string | null, ops: unknown[], characterId = "c") => ({
        characterId,
        chatId,
        baseRevision,
        ops,
    });
    const batch = async (s: ResourceTestClient, body: unknown) => {
        const res = await s.json("/api/resources/batch", body);
        expect(res.status, await res.clone().text()).toBe(200);
        return (await res.json()) as Required<ResourceBatchResult>;
    };
    const readAll = async (s: ResourceTestClient) =>
        (await (await s.request("/api/resources?kinds=characters&chats=1")).json()) as ChatsRead;
    /** Content without tokens: what a restore must preserve. */
    const content = (all: ChatsRead) => ({
        chats: all.chats.map((c) => [c.characterId, c.id, c.data]),
        orders: all.chatOrders.map((o) => [o.characterId, o.ids]),
    });
    /** Character `c` with chats `k` (messages a, b; b under the open generation `g`) and `k2`, ordered [k2, k]. */
    async function seedChats(s: ResourceTestClient) {
        const created = await batch(s, {
            ops: [{ kind: "characters", id: "c", baseRevision: null, data: character("c") }],
            chats: [
                group("k", null, [
                    { op: "create", chat: { name: "K", message: [m("a", "A"), m("b", "", "char")] } },
                    { op: "begin", id: "b", generationId: "g" },
                    { op: "setText", id: "b", text: "partial", generation: { id: "g", seq: 1 } },
                ]),
                group("k2", null, [{ op: "create", chat: { name: "Two", message: [m("x", "X")] }, index: 0 }]),
            ],
        });
        return {
            chat: created.chats[0].revision!,
            chat2: created.chats[1].revision!,
            order: created.chatOrders[0].revision,
        };
    }

    it("restores chats, messages, order, and fences from a snapshot under a new epoch, and refuses old-epoch and old-token writes", async () => {
        const s = await defaultServer();
        const tokens = await seedChats(s);
        const before = await readAll(s);
        const snapshot = await s.context.snapshots.snapshotNow();
        // Move on: remove and append in `k`, delete `k2`.
        const edited = await batch(s, {
            chats: [
                group("k", tokens.chat, [
                    { op: "remove", ids: ["a"] },
                    { op: "append", messages: [m("n", "N")], anchor: { end: true } },
                ]),
                group("k2", tokens.chat2, [{ op: "delete" }]),
            ],
        });
        expect((await readAll(s)).chats.map((c) => c.id)).toEqual(["k"]);
        const oldEpoch = s.epoch;

        const res = await restore(s, snapshot.id);
        expect(res.status).toBe(200);
        const { epoch } = (await res.json()) as { epoch: string };
        expect(await s.readEpoch()).toBe(epoch);
        const after = await readAll(s);
        expect(after.epoch).toBe(epoch);
        expect(content(after)).toEqual(content(before));
        for (const token of [...after.chats.map((c) => c.revision), ...after.chatOrders.map((o) => o.revision)]) {
            expect(token.startsWith(`${epoch}:`)).toBe(true);
        }
        // A write based on the old epoch is a 412; with the new epoch, an old token is a 409.
        const stale = await s.json(
            "/api/resources/batch",
            { chats: [group("k", tokens.chat, [{ op: "setText", id: "a", text: "x" }])] },
            {},
            oldEpoch,
        );
        expect(stale.status).toBe(412);
        expect(await stale.json()).toEqual({ error: "EpochMismatch", epoch });
        const k = after.chats.find((c) => c.id === "k")!.revision;
        const oldToken = await s.json("/api/resources/batch", {
            chats: [group("k", edited.chats[0].revision, [{ op: "remove", ids: ["a", "b"] }])],
            chatOrders: [{ characterId: "c", baseRevision: tokens.order, ids: ["k", "k2"] }],
        });
        expect(oldToken.status).toBe(409);
        expect(((await oldToken.json()) as ResourceBatchConflictBody).conflicts).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision: k },
            { kind: "chatOrder", characterId: "c", revision: after.chatOrders[0].revision },
        ]);
        // The open generation continues where the snapshot left it: seq 1 is a duplicate, seq 2 lands.
        const continued = await batch(s, {
            chats: [
                group("k", k, [
                    { op: "setText", id: "b", text: "late", generation: { id: "g", seq: 1 } },
                    { op: "setText", id: "b", text: "continued", generation: { id: "g", seq: 2, final: true } },
                ]),
            ],
        });
        expect(continued.chats[0].checkpoints).toEqual(["duplicate", "applied"]);
        expect((await readAll(s)).chats.find((c) => c.id === "k")!.data.message.map((x) => x.data)).toEqual([
            "A",
            "continued",
        ]);
        // The safety snapshot holds the pre-restore chats.
        const backups = await listBackups(s);
        const safety = reader.readSnapshot(path.join(backupsDir(s), `${backups[0].id}.sqlite`));
        expect(safety.chats.map((c) => c.id)).toEqual(["k"]);
        expect(safety.messages.map((x) => x.id)).toEqual(["b", "n"]);
    });

    it("carries chats, messages, order, and fences through export and import", async () => {
        const source = await defaultServer();
        await seedChats(source);
        const expected = await readAll(source);
        const archive = await exportArchive(source);
        const records = parseArchive(archive);
        const extracted = path.join(source.rootDir, "extracted.sqlite");
        writeFileSync(extracted, records[1].data);
        const snapshot = reader.readSnapshot(extracted);
        expect(snapshot.chats.map((c) => [c.id, c.revision])).toEqual([
            ["k", 3],
            ["k2", 1],
        ]);
        expect(
            snapshot.messages.map((x) => [x.id, x.position, x.generationId, x.generationSeq, x.generationFinal]),
        ).toEqual([
            ["a", 0, null, null, null],
            ["b", 1, "g", 1, 0],
            ["x", 0, null, null, null],
        ]);
        expect(snapshot.chatOrders).toEqual([{ characterId: "c", revision: 3, ids: '["k2","k"]' }]);

        const target = await defaultServer();
        await target.create("characters", "z", character("z"));
        await batch(target, { chats: [group("zc", null, [{ op: "create", chat: {} }], "z")] });
        const res = await importArchive(target, archive);
        expect(res.status).toBe(200);
        await target.readEpoch();
        const imported = await readAll(target);
        expect(content(imported)).toEqual(content(expected));
        const k = imported.chats.find((c) => c.id === "k")!.revision;
        const continued = await batch(target, {
            chats: [group("k", k, [{ op: "setText", id: "b", text: "x", generation: { id: "g", seq: 2 } }])],
        });
        expect(continued.chats[0].checkpoints).toEqual(["applied"]);
        // The target's previous chats are in its safety snapshot only.
        const backups = await listBackups(target);
        expect(
            reader.readSnapshot(path.join(backupsDir(target), `${backups[0].id}.sqlite`)).chats.map((c) => c.id),
        ).toEqual(["zc"]);
    });

    it("refuses a schema-version-1 database inside a manifest-version-2 archive, and at startup with a message naming the file", async () => {
        const s = await defaultServer();
        const revision = await s.create("characters", "a", character("a"));
        const epoch = s.epoch;
        const v1 = path.join(s.rootDir, "v1.sqlite");
        const db = new DatabaseSync(v1);
        db.exec("PRAGMA user_version = 1; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
        db.close();
        // The manifest is version 2 (the archive format); the database inside is schema version 1.
        const refused = await importArchive(s, archiveOf(readFileSync(v1), { "assets/x": "X" }));
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({ error: "Unsupported resource database version 1" });
        expect(assetFiles(s)).toEqual([]);
        expect(await s.readEpoch()).toBe(epoch);
        expect(await (await s.get("characters", "a")).json()).toEqual({ epoch, revision, data: stored("a") });

        const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-server-v1-"));
        try {
            mkdirSync(path.join(rootDir, "dist"));
            writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
            mkdirSync(path.join(rootDir, "save", "data"), { recursive: true });
            const file = path.join(rootDir, "save", "data", "resources.sqlite");
            const old = new DatabaseSync(file);
            old.exec("PRAGMA user_version = 1");
            old.close();
            expect(() => createTestServer({ rootDir })).toThrow(
                `${file} holds resource database version 1 (characters with their chats inside), which this server ` +
                    "no longer reads. It is disposable alpha data: move it away or delete it and restart to begin " +
                    "with an empty database.",
            );
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("refuses a schema-version-2 database (a root record, before Phase 3) as an archive, as a snapshot, and at startup; a fresh store is version 3", async () => {
        // Phase 3, slice 6: the `root` kind is gone, so a version-2 file (whose tables are those of
        // version 3) is refused everywhere a database enters, without touching the live data.
        const s = await defaultServer();
        const revision = await s.create("characters", "a", character("a"));
        const epoch = s.epoch;
        const live = new DatabaseSync(path.join(s.savePath, "data", "resources.sqlite"), { readOnly: true });
        expect(live.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
        live.close();

        const v2 = path.join(s.rootDir, "v2.sqlite");
        const db = new DatabaseSync(v2);
        db.exec(`
            PRAGMA user_version = 2;
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            CREATE TABLE resources (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
                revision INTEGER NOT NULL, schemaVersion INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE (kind, id)) STRICT;
            ${CHAT_TABLES_SQL}
            INSERT INTO meta (key, value) VALUES ('epoch', 'e');
            INSERT INTO resources (kind, id, revision, schemaVersion, data) VALUES ('root', 'main', 1, 1, '{"username":"u"}');`);
        db.close();
        const bytes = readFileSync(v2);

        const refused = await importArchive(s, archiveOf(bytes, { "assets/x": "X" }));
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({ error: "Unsupported resource database version 2" });
        expect(assetFiles(s)).toEqual([]);
        expect(await s.readEpoch()).toBe(epoch);
        expect(await (await s.get("characters", "a")).json()).toEqual({ epoch, revision, data: stored("a") });

        const snapshot = "resources-20300101T000000000Z-00000004";
        writeFileSync(path.join(backupsDir(s), `${snapshot}.sqlite`), bytes);
        const before = await listBackups(s);
        expect(before.map((b) => b.id)).toEqual([snapshot]);
        const rejected = await restore(s, snapshot);
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({ error: "Unsupported resource database version 2" });
        expect(await listBackups(s)).toEqual(before);
        expect(await s.readEpoch()).toBe(epoch);
        expect(await (await s.get("characters", "a")).json()).toEqual({ epoch, revision, data: stored("a") });
        // The `root` kind is gone: nothing could restore such a record into the live store.
        const noRoot = await s.readKinds("root");
        expect(noRoot.status).toBe(400);
        expect(await noRoot.json()).toEqual({ error: "Unknown resource kind: root" });
        expect((await s.put("characters", "b", { baseRevision: null, data: character("b") })).status).toBe(200);

        const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-server-v2-"));
        try {
            mkdirSync(path.join(rootDir, "dist"));
            writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
            mkdirSync(path.join(rootDir, "save", "data"), { recursive: true });
            const file = path.join(rootDir, "save", "data", "resources.sqlite");
            writeFileSync(file, bytes);
            expect(() => createTestServer({ rootDir })).toThrow(
                `${file} holds resource database version 2 (settings in one root record, before Phase 3), which ` +
                    "this server no longer reads. It is disposable alpha data: move it away or delete it and " +
                    "restart to begin with an empty database.",
            );
            // The file is left as it was: its version and its root record.
            const untouched = new DatabaseSync(file, { readOnly: true });
            expect(untouched.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
            expect(untouched.prepare("SELECT kind, id, data FROM resources").all()).toEqual([
                { kind: "root", id: "main", data: '{"username":"u"}' },
            ]);
            untouched.close();
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });
});

describe("shutdown admission", () => {
    it("refuses restore, import, and export with 503 once dispose has begun, without starting their work", async () => {
        const s = await defaultServer();
        await s.create("characters", "a", character("a"));
        const snapshot = await s.context.snapshots.snapshotNow();
        const bytes = archiveOf(await databaseBytes(s), { "assets/late.png": "L" });
        const epoch = s.epoch;
        const before = await listBackups(s);
        const holding = defer();
        s.context.snapshots.track(() => holding.promise);
        const disposing = s.context.dispose();
        await sleep(10);

        for (const res of [
            await restore(s, snapshot.id),
            await importArchive(s, bytes),
            await s.json("/api/backups/export", {}),
        ]) {
            expect(res.status, res.url).toBe(503);
            expect(res.headers.get("retry-after"), res.url).toBe("5");
            expect(await res.json(), res.url).toEqual({ error: "The server is shutting down" });
        }
        await sleep(20);
        expect(readdirSync(tmpDir(s))).toEqual([]);
        expect(assetFiles(s)).toEqual([]);
        // New resource requests, reads included, are refused too; the store stays open only for
        // the operations admitted before shutdown began.
        const refused = await s.request("/api/resources/ui", {}, epoch);
        expect(refused.status).toBe(503);
        expect(refused.headers.get("retry-after")).toBe("5");
        expect(refused.headers.get("connection")).toBe("close");
        expect((await s.request("/api/backups", {}, epoch)).status).toBe(503);
        expect(before.map((b) => b.id)).toContain(snapshot.id);
        holding.resolve();
        await disposing;
    });
});
