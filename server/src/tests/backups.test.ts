// @vitest-environment node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BackupArchiveManifest } from "../../../shared/resources.ts";
import { MAX_ARCHIVE_RECORDS } from "../data/archive.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import {
    buildArchive,
    createResourceTestClient,
    hex,
    parseArchive,
    type ResourceTestClient,
    sleep,
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
const character = (id: string, extra: Record<string, unknown> = {}) => ({ chaId: id, chats: [], ...extra });
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
        await s.create("root", "main", { username: "before" });
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
            reader
                .readSnapshot(path.join(backupsDir(s), `${backups[0].id}.sqlite`))
                .rows.map((r) => `${r.kind}/${r.id}`),
        ).toEqual(["characters/a", "root/main", "characters/b"]);

        const characters = (await (await s.list("characters")).json()) as { items: (Stored & { id: string })[] };
        expect(characters.items.map((c) => [c.id, c.data])).toEqual([["a", character("a")]]);
        expect(characters.items[0].revision.startsWith(`${epoch}:`)).toBe(true);
        expect(await (await s.get("root", "main")).json()).toMatchObject({ data: { username: "before" } });

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
            PRAGMA user_version = 1;
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            CREATE TABLE resources (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
                revision INTEGER NOT NULL, schemaVersion INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE (kind, id)) STRICT;
            INSERT INTO meta (key, value) VALUES ('epoch', 'e');
            INSERT INTO resources (kind, id, revision, schemaVersion, data) VALUES ('characters', 'x', 1, 1, '{"chaId":"y","chats":[]}');`);
        db.close();
        const before = await listBackups(s);
        expect(before.map((b) => b.id)).toEqual([badRow, garbage]);

        const notResource = await restore(s, garbage);
        expect(notResource.status).toBe(400);
        expect(await notResource.json()).toEqual({ error: "Not a resource database" });
        const rejectedRow = await restore(s, badRow);
        expect(rejectedRow.status).toBe(400);
        expect(await rejectedRow.json()).toEqual({ error: "row 1: character.chaId must equal the resource id" });

        expect(await listBackups(s)).toEqual(before);
        expect(await s.readEpoch()).toBe(epoch);
        expect(await (await s.get("characters", "a")).json()).toEqual({ epoch, revision, data: character("a") });
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
        const first = restore(s, snapshot.id);
        const second = restore(s, snapshot.id);
        await sleep(10);
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
            data: character("a"),
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
        expect(reader.readSnapshot(extracted).rows.map((r) => r.id)).toEqual(["a"]);
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
        for (const partial of ["x", ["database/database.bin"], ["assets/"], [1], ["Assets/x.png"], [null]]) {
            const res = await s.json("/api/backups/export", { partial });
            expect(res.status, JSON.stringify(partial)).toBe(400);
            expect(await res.json(), JSON.stringify(partial)).toEqual({
                error: "partial must be a list of asset keys",
            });
        }
        expect(readdirSync(tmpDir(s))).toEqual([]);
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
        await source.create("root", "main", { username: "u" });
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
        const state = (await (await target.readKinds("characters,root")).json()) as {
            kinds: Record<string, { id: string; data: unknown }[]>;
        };
        expect(state.kinds.characters.map((c) => [c.id, c.data])).toEqual([["a", character("a")]]);
        expect(state.kinds.root.map((r) => r.data)).toEqual([{ username: "u" }]);
        // The safety snapshot holds the target's previous state; staging is gone; old-epoch writes are refused.
        const backups = await listBackups(target);
        expect(backups).toHaveLength(1);
        expect(
            reader.readSnapshot(path.join(backupsDir(target), `${backups[0].id}.sqlite`)).rows.map((r) => r.id),
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
        expect(await (await s.get("characters", "a")).json()).toEqual({ epoch, revision, data: character("a") });
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
        // Resources are still served until the store closes with the last tracked operation.
        expect(await s.readEpoch()).toBe(epoch);
        expect(await listBackups(s)).toEqual(before);
        expect(before.map((b) => b.id)).toContain(snapshot.id);
        holding.resolve();
        await disposing;
    });
});
