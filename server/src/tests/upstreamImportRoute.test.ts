// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResourceReadKindsResult } from "../../../shared/resources.ts";
import {
    MAX_UPSTREAM_STAGED,
    UPSTREAM_CHANGED_SINCE_REVIEW,
    UPSTREAM_IMPORT_CANCEL_PATH,
    UPSTREAM_IMPORT_COMMIT_PATH,
    UPSTREAM_IMPORT_EXPIRED,
    UPSTREAM_IMPORT_PHASES,
    UPSTREAM_IMPORT_PREPARE_PATH,
    UPSTREAM_TOO_MANY_STAGED,
} from "../../../shared/upstreamBackup.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { UPSTREAM_ENCRYPTED_MESSAGE } from "../data/upstream/archive.ts";
import { UpstreamImportError, type UpstreamImportRunner } from "../data/upstream/importRunner.ts";
import { stageUpstreamImport } from "../data/upstream/importStage.ts";
import { encodeUpstreamDatabase } from "../data/upstream/risuSave.ts";
import { spool } from "../http/spool.ts";
import { createUpstreamImportStaging } from "../routes/backupsUpstream.ts";
import { encodeBlockSave, encodeRawBlock } from "./fixtures/upstream/blockSave.ts";
import { UPSTREAM_FIXTURE_DATABASE } from "./fixtures/upstream/database.ts";
import { buildArchive, createResourceTestClient, hex, type ResourceTestClient } from "./testSupport.ts";

/**
 * The upstream RisuAI `.bin` import routes (`routes/backupsUpstream.ts`): prepare, commit, and cancel
 * over `createTestServer`. The prepare's conversion runs in process (`stageUpstreamImport` as the
 * injected runner: no worker boot in the default suite); the real worker, its heap limit, and the
 * latch are `upstreamImportWorker.test.ts` (slow). The archive is the codec fixture's synthetic
 * database plus two asset records.
 */

const FIXTURE_CHARACTER = "0f8e3c4a-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const FIXTURE_GROUP = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PROFILE = Buffer.from("PNG profile bytes");
const JOY = Buffer.from("PNG joy bytes");
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The prepare's in-process runner: the worker's body on the serving thread. */
const inProcess: UpstreamImportRunner = (input, { onProgress }) => stageUpstreamImport(input, onProgress);

const servers: ResourceTestClient[] = [];
const responses: Response[] = [];
let database: Uint8Array;

beforeAll(() => {
    database = encodeUpstreamDatabase(UPSTREAM_FIXTURE_DATABASE);
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    await Promise.all(responses.splice(0).map((res) => res.body?.cancel().catch(() => {})));
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await Promise.all(servers.splice(0).map((s) => s.close()));
    vi.useRealTimers();
});

/** A well-formed upstream backup: the two assets, then the database, as upstream writes it. */
function upstreamArchive(extra: [string, Uint8Array | string][] = []): Uint8Array {
    return buildArchive([["3f2a9c.png", PROFILE], ["joy.png", JOY], ...extra, ["database.risudat", database]]);
}

async function server(options: Parameters<typeof createResourceTestClient>[0] = {}) {
    const s = await createResourceTestClient({ upstreamImport: { runner: inProcess }, ...options });
    servers.push(s);
    return s;
}
const tmpDir = (s: ResourceTestClient) => path.join(s.savePath, ".tmp");
const staged = (s: ResourceTestClient) => readdirSync(tmpDir(s));
const assetDir = (s: ResourceTestClient) => path.join(s.savePath, "assets");
const assetFiles = (s: ResourceTestClient) => (existsSync(assetDir(s)) ? readdirSync(assetDir(s)).sort() : []);
const backupsDir = (s: ResourceTestClient) => path.join(s.savePath, "backups");
const listBackups = async (s: ResourceTestClient) =>
    ((await (await s.request("/api/backups")).json()) as { items: { id: string }[] }).items;
const writeAsset = (s: ResourceTestClient, key: string, body: string) =>
    s.request("/api/write", { method: "POST", headers: { "file-path": hex(key) }, body });
const readAsset = async (s: ResourceTestClient, key: string) =>
    (await s.request("/api/read", { headers: { "file-path": hex(key) } })).text();
const character = (id: string) => ({ chaId: id, name: id, type: "character" });
const lifecycle = (s: ResourceTestClient, phase: string) =>
    s.context.diagnostics.recent().filter((event) => event.kind === "lifecycle" && event.phase === phase);
const validator = createResourceStore({ file: ":memory:", kinds: createKindRegistry(DEFAULT_RESOURCE_KINDS) });
afterAll(() => validator.close());

async function prepareRequest(
    s: ResourceTestClient,
    body: Uint8Array | ReadableStream<Uint8Array> | null,
    init: RequestInit = {},
    epoch?: string | null,
) {
    const res = await s.request(
        UPSTREAM_IMPORT_PREPARE_PATH,
        {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body,
            duplex: "half",
            ...init,
        } as RequestInit,
        epoch,
    );
    responses.push(res);
    return res;
}
const commitRequest = (s: ResourceTestClient, body: unknown, epoch?: string | null) =>
    s.json(UPSTREAM_IMPORT_COMMIT_PATH, body, {}, epoch);
const cancelRequest = (s: ResourceTestClient, token: unknown) => s.json(UPSTREAM_IMPORT_CANCEL_PATH, { token });

async function lines(res: Response): Promise<any[]> {
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    return text
        .slice(0, -1)
        .split("\n")
        .map((line) => JSON.parse(line));
}
async function refused(res: Response, status: number, error: string) {
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    if (status === 503) expect(res.headers.get("retry-after")).toBe("5");
}
/** A prepare that stages: progress lines in phase order, then the token, report, and selection. */
async function prepare(s: ResourceTestClient, bytes: Uint8Array = upstreamArchive()): Promise<any> {
    const answer = await lines(await prepareRequest(s, bytes));
    const progress = answer.slice(0, -1);
    expect(progress.length).toBeGreaterThan(0);
    const phases = progress.map((line) => line.phase);
    const order = phases.map((phase) => UPSTREAM_IMPORT_PHASES.indexOf(phase));
    expect(order).not.toContain(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const line of progress) {
        expect(line).toEqual({ phase: line.phase, done: expect.any(Number), total: expect.any(Number) });
        expect(line.done).toBeLessThanOrEqual(line.total);
    }
    const result = answer.at(-1);
    expect(result.token).toMatch(TOKEN);
    expect(result.selection).toEqual({
        promptPresetId: expect.any(String),
        modelPresetId: expect.any(String),
        personaId: expect.any(String),
    });
    expect(result.report.counts).toMatchObject({ characters: 1, groups: 1, chats: 2, messages: 3 });
    return result;
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}
/** A body the route must refuse before reading. */
function unreadBody() {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
        {
            pull(c) {
                reads++;
                c.enqueue(Buffer.from("x"));
                c.close();
            },
        },
        { highWaterMark: 0 },
    );
    return { body, reads: () => reads };
}
/**
 * A runner that reports one progress line and then waits for its signal: the shape of a worker still
 * converting when the request ends or the server shuts down.
 */
function waitingRunner() {
    const seen = { signal: null as AbortSignal | null };
    const runner: UpstreamImportRunner = (_input, { signal, onProgress }) => {
        seen.signal = signal;
        onProgress("decode", 0, 1);
        return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    };
    return { runner, seen };
}
async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<any> {
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    return JSON.parse(Buffer.from(value!).toString("utf-8").trim());
}

describe("POST /api/backups/import-upstream/prepare and /commit", () => {
    it("imports a block backup with characters, chats, message ids and assets intact, reporting each SaveKV namespace as excluded", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const s = await server();
        const kv = { "plugin:notes": { text: "not imported" }, preferences: { enabled: true } };
        const bytes = buildArchive([
            ["3f2a9c.png", PROFILE],
            ["joy.png", JOY],
            ["database.risudat", encodeBlockSave(UPSTREAM_FIXTURE_DATABASE, { compression: true, kv })],
        ]);
        const prepared = await prepare(s, bytes);
        const excluded = prepared.report.excluded.find((entry: { code: string }) => entry.code === "unknown-setting");
        expect(excluded.examples).toEqual(
            expect.arrayContaining(Object.keys(kv).map((namespace) => `kv:${namespace}`)),
        );

        const res = await commitRequest(s, { token: prepared.token });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ assetsWritten: 2, assetsSkipped: 0 });
        await s.readEpoch();
        const state = (await (
            await s.request("/api/resources?kinds=characters,pluginStorage&chats=1")
        ).json()) as ResourceReadKindsResult;
        expect(state.kinds.characters.map((record) => record.id)).toEqual([FIXTURE_CHARACTER, FIXTURE_GROUP]);
        for (const source of UPSTREAM_FIXTURE_DATABASE.characters) {
            expect(state.kinds.characters.find((record) => record.id === source.chaId)?.data).toMatchObject({
                chaId: source.chaId,
                name: source.name,
                type: source.type,
            });
            expect(state.chats!.filter((chat) => chat.characterId === source.chaId).map((chat) => chat.id)).toEqual(
                source.chats.map((chat) => chat.id),
            );
            for (const sourceChat of source.chats) {
                const chat = state.chats!.find(
                    (chat) => chat.characterId === source.chaId && chat.id === sourceChat.id,
                )!;
                expect(chat.data.name).toBe(sourceChat.name);
                expect(chat.data.message).toMatchObject(JSON.parse(JSON.stringify(sourceChat.message)));
            }
        }
        expect(state.kinds.characters[0].data).toMatchObject({
            image: "assets/3f2a9c.png",
            emotionImages: [["joy", "assets/joy.png"]],
        });
        expect(state.kinds.pluginStorage[0].data).toEqual(UPSTREAM_FIXTURE_DATABASE.pluginCustomStorage);
        expect(assetFiles(s)).toEqual(["3f2a9c.png", "joy.png"]);
        expect(readFileSync(path.join(assetDir(s), "3f2a9c.png"))).toEqual(PROFILE);
        expect(readFileSync(path.join(assetDir(s), "joy.png"))).toEqual(JOY);
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamStaging.size).toBe(0);
    });

    it("restores indexed plugin values after preparing and committing a block backup", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const s = await server();
        const indexId = "11111111-1111-4111-8111-111111111111";
        const largeId = "22222222-2222-4222-8222-222222222222";
        const index = {
            type: "risu-plugin-storage-index",
            version: 1,
            entries: [
                { k: "preferences", s: '{"enabled":true}' },
                { k: "empty", s: '""' },
                { k: "large", l: largeId },
            ],
            trash: [{ id: "33333333-3333-4333-8333-333333333333", at: 1 }],
        };
        const bytes = buildArchive([
            ["3f2a9c.png", PROFILE],
            ["joy.png", JOY],
            [`coldstorage_${indexId}.json`, JSON.stringify(index)],
            // Both name forms share a key; plugin storage must select the plugin payload.
            [`${largeId}.json`, '{"message":[]}'],
            [`coldstorage_${largeId}.json`, "null"],
            [
                "database.risudat",
                encodeBlockSave({
                    ...UPSTREAM_FIXTURE_DATABASE,
                    pluginCustomStorage: { _coldpluginIndex: indexId },
                }),
            ],
        ]);
        const prepared = await prepare(s, bytes);
        const committed = await commitRequest(s, { token: prepared.token });
        expect(committed.status).toBe(200);
        await s.readEpoch();
        const res = await s.request("/api/resources?kinds=pluginStorage");
        expect(res.status).toBe(200);
        const state = (await res.json()) as ResourceReadKindsResult;
        expect(state.kinds.pluginStorage).toHaveLength(1);
        expect(state.kinds.pluginStorage[0].data).toEqual({
            _pluginStorage: { preferences: { enabled: true }, empty: "", large: null },
        });
        expect(prepared.report.converted).toContainEqual({
            code: "cold-plugin-storage-restored",
            count: 3,
            examples: ["preferences", "empty", "large"],
        });
        expect(prepared.report.excluded).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "cold-missing" })]),
        );
    });

    it("ends a REMOTE block prepare with an error and leaves the live epoch, resources and assets untouched with no staging", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const s = await server();
        await s.create("characters", "existing", character("existing"));
        expect((await writeAsset(s, "assets/joy.png", "existing asset")).status).toBe(200);
        const resourceUrl = `/api/resources?kinds=${DEFAULT_RESOURCE_KINDS.map((kind) => kind.name).join(",")}&chats=1`;
        const initial = await s.request(resourceUrl);
        expect(initial.status).toBe(200);
        const before = await initial.json();
        const epoch = s.epoch;
        const remote = encodeRawBlock({
            type: 6,
            name: "external-character",
            compression: true,
            data: Buffer.from('"remotes/external-character.local.bin"'),
        });
        const bytes = buildArchive([
            ["3f2a9c.png", PROFILE],
            ["joy.png", JOY],
            ["database.risudat", Buffer.concat([encodeBlockSave(UPSTREAM_FIXTURE_DATABASE), remote])],
        ]);
        const answer = await lines(await prepareRequest(s, bytes));
        expect(answer.at(-1)).toEqual({ error: expect.any(String) });
        expect(answer.at(-1).error).toMatch(/live save/i);
        expect(answer.at(-1).error).toMatch(/outside/i);
        expect(answer.at(-1).error).toContain("external-character");
        expect(await s.readEpoch()).toBe(epoch);
        const after = await s.request(resourceUrl);
        expect(after.status).toBe(200);
        expect(await after.json()).toEqual(before);
        expect(assetFiles(s)).toEqual(["joy.png"]);
        expect(await readAsset(s, "assets/joy.png")).toBe("existing asset");
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamStaging.size).toBe(0);
    });

    it("stages the conversion without touching the store, then the commit replaces every resource, links the missing assets, keeps existing files, and takes a safety snapshot", async () => {
        const s = await server();
        await s.create("characters", "z", character("z"));
        await writeAsset(s, "assets/joy.png", "TARGET");
        const oldEpoch = s.epoch;
        const maintenance = vi.fn(async () => undefined);
        s.context.snapshots.onMaintenance(maintenance);

        const prepared = await prepare(s);
        expect(prepared.report.missingAssets).toEqual([]);
        // Nothing of the live data changed; the staged store and every asset wait in the staging folder.
        expect(await s.readEpoch()).toBe(oldEpoch);
        expect(assetFiles(s)).toEqual(["joy.png"]);
        expect(await listBackups(s)).toEqual([]);
        expect(maintenance).not.toHaveBeenCalled();
        expect(s.context.upstreamStaging.size).toBe(1);
        const folders = staged(s);
        expect(folders).toHaveLength(1);
        const folder = path.join(tmpDir(s), folders[0]);
        expect(readdirSync(folder).sort()).toEqual(["archive.bin", "assets", "resources.sqlite"]);
        expect(readdirSync(path.join(folder, "assets")).sort()).toEqual(["0", "1"]);
        expect(lifecycle(s, "import")).toEqual([]);

        const res = await commitRequest(s, { token: prepared.token });
        expect(res.status).toBe(200);
        const committed = (await res.json()) as any;
        expect(committed).toEqual({
            epoch: expect.any(String),
            assetsWritten: 1,
            assetsSkipped: 1,
            selection: prepared.selection,
        });
        expect(committed.epoch).not.toBe(oldEpoch);
        expect(await s.readEpoch()).toBe(committed.epoch);
        expect(maintenance).toHaveBeenCalledTimes(1);
        expect(lifecycle(s, "import")).toHaveLength(1);

        // The imported library replaced `z`; the selection names imported records.
        const state = (await (
            await s.request("/api/resources?kinds=characters,presets,modelPresets,personas&chats=1")
        ).json()) as any;
        expect(state.kinds.characters.map((c: any) => c.id)).toEqual([FIXTURE_CHARACTER, FIXTURE_GROUP]);
        expect(state.kinds.characters[0].data.name).toBe(UPSTREAM_FIXTURE_DATABASE.characters[0].name);
        const ids = (kind: string) => (state.kinds[kind][0].data as { id: string }[]).map((item) => item.id);
        expect(ids("presets")).toContain(prepared.selection.promptPresetId);
        expect(ids("modelPresets")).toContain(prepared.selection.modelPresetId);
        expect(ids("personas")).toContain(prepared.selection.personaId);
        expect(JSON.stringify(state)).toContain(UPSTREAM_FIXTURE_DATABASE.characters[0].chats[0].id);
        // The existing file was kept, the missing one linked from the staged copy.
        expect(await readAsset(s, "assets/joy.png")).toBe("TARGET");
        expect(readFileSync(path.join(assetDir(s), "3f2a9c.png"))).toEqual(PROFILE);
        expect(assetFiles(s)).toEqual(["3f2a9c.png", "joy.png"]);
        // The safety snapshot holds the state from before the commit; the staging is gone.
        const backups = await listBackups(s);
        expect(backups).toHaveLength(1);
        expect(
            validator
                .readSnapshot(path.join(backupsDir(s), `${backups[0].id}.sqlite`))
                .rows.filter((row) => row.kind === "characters")
                .map((row) => row.id),
        ).toEqual(["z"]);
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamStaging.size).toBe(0);
        expect((await s.put("characters", "q", { baseRevision: null, data: character("q") }, oldEpoch)).status).toBe(
            412,
        );
        expect((await s.put("characters", "q", { baseRevision: null, data: character("q") })).status).toBe(200);
        // The token was consumed.
        await refused(await commitRequest(s, { token: prepared.token }), 404, UPSTREAM_IMPORT_EXPIRED);
    });

    it("reports records with an unusable name as left out and extracts the rest", async () => {
        const s = await server();
        const prepared = await prepare(s, upstreamArchive([["n".repeat(300) + ".png", "long"]]));
        expect(prepared.report.excluded).toContainEqual({
            code: "asset-name-invalid",
            count: 1,
            examples: ["n".repeat(300) + ".png"],
        });
        expect((await commitRequest(s, { token: prepared.token })).status).toBe(200);
        expect(assetFiles(s)).toEqual(["3f2a9c.png", "joy.png"]);
    });

    it("cancel removes the prepared import and leaves the store and disk unchanged; a gone token is 404 at commit and 204 at cancel", async () => {
        const s = await server();
        await s.create("characters", "z", character("z"));
        const epoch = s.epoch;
        const prepared = await prepare(s);
        expect(staged(s)).toHaveLength(1);
        expect((await cancelRequest(s, prepared.token)).status).toBe(204);
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamStaging.size).toBe(0);
        expect(await s.readEpoch()).toBe(epoch);
        expect(assetFiles(s)).toEqual([]);
        expect(await listBackups(s)).toEqual([]);
        await refused(await commitRequest(s, { token: prepared.token }), 404, UPSTREAM_IMPORT_EXPIRED);
        expect((await cancelRequest(s, prepared.token)).status).toBe(204);
        await refused(await cancelRequest(s, "not-a-token"), 400, "Invalid import token");
        await refused(await commitRequest(s, { token: 42 }), 400, "Invalid import token");
        expect((await s.app.request(UPSTREAM_IMPORT_CANCEL_PATH, { method: "POST" })).status).toBe(400);
        expect((await s.app.request(UPSTREAM_IMPORT_COMMIT_PATH, { method: "POST" })).status).toBe(400);
        // The slot and the staging are free: the next prepare commits.
        const next = await prepare(s);
        expect((await commitRequest(s, { token: next.token })).status).toBe(200);
    });

    it("refuses a second prepare while one waits, before reading its body", async () => {
        const s = await server();
        const prepared = await prepare(s);
        expect(s.context.upstreamStaging.full).toBe(true);
        const input = unreadBody();
        await refused(await prepareRequest(s, input.body), 409, UPSTREAM_TOO_MANY_STAGED);
        expect(input.reads()).toBe(0);
        expect(staged(s)).toHaveLength(MAX_UPSTREAM_STAGED);
        expect((await cancelRequest(s, prepared.token)).status).toBe(204);
        expect(s.context.upstreamStaging.full).toBe(false);
    });

    it("refuses a Risu Account backup, a version-2 archive, a damaged archive, no body, and a stale epoch before anything streams, writing nothing", async () => {
        const s = await server();
        const epoch = s.epoch;
        const cases: [string, Uint8Array, string][] = [
            [
                "encrypted",
                buildArchive([
                    ["encryption.risudat", "x"],
                    ["database.risudat", database],
                ]),
                UPSTREAM_ENCRYPTED_MESSAGE,
            ],
            [
                "version 2",
                buildArchive([
                    ["manifest.json", "{}"],
                    ["resources.sqlite", "x"],
                ]),
                "This is a backup archive of this server, not a RisuAI backup; use the regular import",
            ],
            ["no database", buildArchive([["a.png", "x"]]), "The backup holds no database (database.risudat)"],
            ["truncated", upstreamArchive().subarray(0, 6), "The archive has an invalid record header"],
        ];
        for (const [label, bytes, message] of cases) {
            const res = await prepareRequest(s, bytes);
            expect(res.status, label).toBe(400);
            expect(await res.json(), label).toEqual({ error: message });
            expect(staged(s), label).toEqual([]);
        }
        const input = unreadBody();
        const stale = await prepareRequest(s, input.body, {}, "00000000-0000-4000-8000-000000000000");
        expect(stale.status).toBe(412);
        expect(await stale.json()).toEqual({ error: "EpochMismatch", epoch });
        expect(input.reads()).toBe(0);
        await refused(await prepareRequest(s, null), 400, "Backup body required");
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamStaging.size).toBe(0);
        expect(await s.readEpoch()).toBe(epoch);
        expect(assetFiles(s)).toEqual([]);
        // Admission recovered: the next prepare stages.
        await prepare(s);
    });

    it("ends the answer with an error line when the conversion fails, leaving no staging and the store untouched", async () => {
        const damaged = buildArchive([
            ["a.png", "x"],
            ["database.risudat", "not a RisuAI save at all"],
        ]);
        const failures: [string, UpstreamImportRunner | null, Uint8Array, string | RegExp][] = [
            ["a damaged database", null, damaged, /RisuAI/],
            [
                "an unexpected runner failure",
                () => Promise.reject(new Error("boom")),
                upstreamArchive(),
                "The backup could not be imported: boom",
            ],
            [
                "a refusal the runner reported",
                () => Promise.reject(new UpstreamImportError("too big for this server")),
                upstreamArchive(),
                "too big for this server",
            ],
        ];
        for (const [label, runner, bytes, message] of failures) {
            const s = await server(runner ? { upstreamImport: { runner } } : {});
            const epoch = s.epoch;
            const errors = vi.spyOn(console, "error").mockImplementation(() => {});
            errors.mockClear();
            const answer = await lines(await prepareRequest(s, bytes));
            const last = answer.at(-1);
            expect(last, label).toEqual({ error: expect.any(String) });
            expect(last.error, label).toMatch(message);
            expect(
                answer.slice(0, -1).every((line) => line.phase !== undefined),
                label,
            ).toBe(true);
            expect(staged(s), label).toEqual([]);
            expect(s.context.upstreamStaging.size, label).toBe(0);
            expect(await s.readEpoch(), label).toBe(epoch);
            expect(assetFiles(s), label).toEqual([]);
            expect(errors.mock.calls.length > 0, label).toBe(label === "an unexpected runner failure");
            // The slot is free again: the next prepare is admitted (refused only for its epoch).
            const input = unreadBody();
            expect((await prepareRequest(s, input.body, {}, "00000000-0000-4000-8000-000000000000")).status).toBe(412);
        }
    });
});

describe("changed since review", () => {
    it("answers 409 with the count of writes since the prepare, ends no job, and commits once the count is accepted exactly", async () => {
        const s = await server();
        const maintenance = vi.fn(async () => undefined);
        s.context.snapshots.onMaintenance(maintenance);
        const prepared = await prepare(s);
        const epoch = s.epoch;
        await s.create("characters", "w", character("w"));

        const first = await commitRequest(s, { token: prepared.token });
        expect(first.status).toBe(409);
        expect(await first.json()).toEqual({ error: UPSTREAM_CHANGED_SINCE_REVIEW, writes: 1 });
        expect(maintenance).not.toHaveBeenCalled();
        expect(await s.readEpoch()).toBe(epoch);
        expect(s.context.upstreamStaging.size).toBe(1);
        expect(staged(s)).toHaveLength(1);
        // Another count than the server's is refused too, as is a count that is not one.
        const wrong = await commitRequest(s, { token: prepared.token, acceptWrites: 0 });
        expect(await wrong.json()).toEqual({ error: UPSTREAM_CHANGED_SINCE_REVIEW, writes: 1 });
        for (const acceptWrites of [-1, 1.5, "1", null]) {
            await refused(
                await commitRequest(s, { token: prepared.token, acceptWrites }),
                400,
                "acceptWrites must be a count",
            );
        }
        // More writes after the confirmation: asked again with the new count.
        await s.create("characters", "v", character("v"));
        const again = await commitRequest(s, { token: prepared.token, acceptWrites: 1 });
        expect(await again.json()).toEqual({ error: UPSTREAM_CHANGED_SINCE_REVIEW, writes: 2 });
        expect(maintenance).not.toHaveBeenCalled();

        const res = await commitRequest(s, { token: prepared.token, acceptWrites: 2 });
        expect(res.status).toBe(200);
        expect(maintenance).toHaveBeenCalledTimes(1);
        expect(await s.readEpoch()).not.toBe(epoch);
        // The replaced writes are in the safety snapshot.
        const backups = await listBackups(s);
        expect(
            validator
                .readSnapshot(path.join(backupsDir(s), `${backups[0].id}.sqlite`))
                .rows.filter((row) => row.kind === "characters")
                .map((row) => row.id),
        ).toEqual(["w", "v"]);
        expect(staged(s)).toEqual([]);
    });

    it("commits without a count when nothing was written, and accepts a count of zero then", async () => {
        const s = await server();
        const prepared = await prepare(s);
        expect((await commitRequest(s, { token: prepared.token, acceptWrites: 0 })).status).toBe(200);
    });
});

describe("the commit's refusals keep the import waiting", () => {
    it("answers 412 for the tab's epoch and for a restore since the prepare, 409 while another import runs, and 503 under maintenance", async () => {
        const s = await server();
        await s.create("characters", "z", character("z"));
        const snapshot = await s.context.snapshots.snapshotNow();
        const prepared = await prepare(s);
        const epoch = s.epoch;

        const stale = await commitRequest(s, { token: prepared.token }, "00000000-0000-4000-8000-000000000000");
        expect(stale.status).toBe(412);
        expect(await stale.json()).toEqual({ error: "EpochMismatch", epoch });

        // Another archive import holds the slot while its body streams in (the first read means it was admitted).
        const spooling = deferred();
        const hanging = deferred();
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                async pull(c) {
                    pulls++;
                    if (pulls === 1) {
                        spooling.resolve();
                        c.enqueue(Buffer.from("partial"));
                        return;
                    }
                    await hanging.promise;
                    c.close();
                },
            },
            { highWaterMark: 0 },
        );
        const other = s.request("/api/backups/import", {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body,
            duplex: "half",
        } as RequestInit);
        await spooling.promise;
        await refused(await commitRequest(s, { token: prepared.token }), 409, "Another import is running");
        hanging.resolve();
        expect((await other).status).toBe(400);

        const inside = deferred();
        const release = deferred();
        const held = s.context.snapshots.withMaintenance(async () => {
            inside.resolve();
            await release.promise;
        });
        await inside.promise;
        await refused(await commitRequest(s, { token: prepared.token }), 503, "Maintenance in progress");
        release.resolve();
        await held;
        expect(s.context.upstreamStaging.size).toBe(1);
        expect(staged(s)).toHaveLength(1);

        // A restore since the prepare: the data the report was compared with is gone, even with the new epoch.
        expect((await s.request(`/api/backups/${snapshot.id}/restore`, { method: "POST" })).status).toBe(200);
        const restored = await s.readEpoch();
        const after = await commitRequest(s, { token: prepared.token });
        expect(after.status).toBe(412);
        expect(await after.json()).toEqual({ error: "EpochMismatch", epoch: restored });
        expect(s.context.upstreamStaging.size).toBe(1);
        expect((await cancelRequest(s, prepared.token)).status).toBe(204);
        expect(staged(s)).toEqual([]);
    });

    it("answers 400 and removes the import when its staged store does not validate", async () => {
        const s = await server();
        await s.create("characters", "z", character("z"));
        const prepared = await prepare(s);
        const epoch = s.epoch;
        const folder = path.join(tmpDir(s), staged(s)[0]);
        writeFileSync(path.join(folder, "resources.sqlite"), "damaged after the prepare");
        const res = await commitRequest(s, { token: prepared.token });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Not a resource database" });
        expect(await s.readEpoch()).toBe(epoch);
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamStaging.size).toBe(0);
        expect(assetFiles(s)).toEqual([]);
        expect((await s.put("characters", "q", { baseRevision: null, data: character("q") })).status).toBe(200);
    });
});

describe("a prepare that ends early", () => {
    it("shutdown aborts the running conversion, ends the answer, removes the staging, and does not wait for it", async () => {
        const { runner, seen } = waitingRunner();
        const s = await server({ upstreamImport: { runner } });
        const res = await prepareRequest(s, upstreamArchive());
        const reader = res.body!.getReader();
        expect(await readLine(reader)).toEqual({ phase: "decode", done: 0, total: 1 });
        expect(staged(s)).toHaveLength(1);
        const input = unreadBody();
        await refused(await prepareRequest(s, input.body), 409, "Another import is running");
        expect(input.reads()).toBe(0);

        const disposing = s.context.dispose();
        expect(await readLine(reader)).toEqual({ error: "The server is shutting down" });
        expect((await reader.read()).done).toBe(true);
        await disposing;
        expect(seen.signal!.aborted).toBe(true);
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamStaging.size).toBe(0);
    });

    it("shutdown ends a conversion whose answer nobody reads", async () => {
        const { runner, seen } = waitingRunner();
        const s = await server({ upstreamImport: { runner } });
        const res = await prepareRequest(s, upstreamArchive());
        expect(staged(s)).toHaveLength(1);
        await s.context.dispose();
        expect(seen.signal!.aborted).toBe(true);
        expect(staged(s)).toEqual([]);
        const answer = await lines(res);
        expect(answer[0]).toEqual({ phase: "decode", done: 0, total: 1 });
    });

    it("a client that leaves mid-conversion aborts it and frees the slot and the staging", async () => {
        const { runner, seen } = waitingRunner();
        const s = await server({ upstreamImport: { runner } });
        const res = await prepareRequest(s, upstreamArchive());
        const reader = res.body!.getReader();
        await readLine(reader);
        // The stream's cancel settles once the import's finalizer ran.
        await reader.cancel();
        expect(seen.signal!.aborted).toBe(true);
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamStaging.size).toBe(0);
        // The slot is free: the next prepare is admitted (refused only for its epoch).
        const input = unreadBody();
        expect((await prepareRequest(s, input.body, {}, "00000000-0000-4000-8000-000000000000")).status).toBe(412);
    });

    it("shutdown cancels an upload still streaming in", async () => {
        const s = await server();
        const bytes = upstreamArchive();
        const reading = deferred();
        const hang = deferred();
        const cancelled = vi.fn();
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(c) {
                    pulls++;
                    if (pulls === 1) {
                        c.enqueue(bytes.subarray(0, 10));
                        return;
                    }
                    reading.resolve();
                    return hang.promise;
                },
                cancel: cancelled,
            },
            { highWaterMark: 0 },
        );
        const pending = prepareRequest(s, body);
        await reading.promise;
        expect(staged(s)).toHaveLength(1);
        const disposing = s.context.dispose();
        await refused(await pending, 503, "The server is shutting down");
        expect(cancelled).toHaveBeenCalledTimes(1);
        await disposing;
        expect(staged(s)).toEqual([]);
    });
});

describe("createUpstreamImportStaging", () => {
    let root: string;
    beforeAll(() => {
        root = mkdtempSync(path.join(os.tmpdir(), "risu-upstream-staging-"));
    });
    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    const entry = (name: string) => {
        const folder = path.join(root, name);
        return {
            staging: folder,
            databaseFile: path.join(folder, "resources.sqlite"),
            assets: [],
            selection: { promptPresetId: "p", modelPresetId: "m", personaId: "u" },
            epoch: "e",
            writeCount: 0,
        };
    };

    it("expires a waiting import after the TTL, removing its folder, and holds at most one", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const staging = createUpstreamImportStaging({ ttlMs: 1000 });
        const first = entry("first");
        await fs.mkdir(first.staging, { recursive: true });
        const token = staging.add(first)!;
        expect(token).toMatch(TOKEN);
        expect(staging.full).toBe(true);
        expect(staging.add(entry("second"))).toBeNull();
        expect(staging.get(token)).toMatchObject({ staging: first.staging, epoch: "e" });
        await vi.advanceTimersByTimeAsync(999);
        expect(staging.size).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(staging.size).toBe(0);
        expect(staging.get(token)).toBeNull();
        expect(staging.take(token)).toBeNull();
        // `close` waits for the removal the expiry started.
        await staging.close();
        expect(existsSync(first.staging)).toBe(false);
        expect(staging.full).toBe(true);
        expect(staging.signal.aborted).toBe(true);
    });

    it("take hands the import to its commit (no expiry, no removal), cancel removes it, and close removes the rest", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const staging = createUpstreamImportStaging({ ttlMs: 1000 });
        const taken = entry("taken");
        await fs.mkdir(taken.staging, { recursive: true });
        const token = staging.add(taken)!;
        expect(staging.take(token)).toMatchObject({ staging: taken.staging });
        await vi.advanceTimersByTimeAsync(5000);
        expect(existsSync(taken.staging)).toBe(true);
        rmSync(taken.staging, { recursive: true });

        const cancelled = entry("cancelled");
        await fs.mkdir(cancelled.staging, { recursive: true });
        await staging.cancel(staging.add(cancelled)!);
        expect(existsSync(cancelled.staging)).toBe(false);
        await staging.cancel("00000000-0000-4000-8000-000000000000");

        const left = entry("left");
        await fs.mkdir(left.staging, { recursive: true });
        staging.add(left);
        expect(staging.size).toBe(1);
        const closing = staging.close();
        expect(staging.add(entry("late"))).toBeNull();
        expect(staging.close()).toBe(closing);
        await closing;
        expect(staging.size).toBe(0);
        expect(existsSync(left.staging)).toBe(false);
    });
});

describe("spool with a signal", () => {
    let root: string;
    let files = 0;
    beforeAll(() => {
        root = mkdtempSync(path.join(os.tmpdir(), "risu-spool-"));
    });
    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });
    const target = () => path.join(root, `spool-${files++}`);

    it("throws the reason of a signal already aborted when the file is open, cancelling the body before any read", async () => {
        const reads = vi.fn();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ pull: reads, cancel }, { highWaterMark: 0 });
        const signal = AbortSignal.abort(new Error("shutting down"));
        const file = target();
        await expect(spool(body, file, 1000, signal)).rejects.toThrow("shutting down");
        expect(reads).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(existsSync(file)).toBe(true);
    });

    it("cancels the body and throws when the signal aborts while a read waits, keeping what was written", async () => {
        const waiting = deferred();
        const hang = deferred();
        const cancel = vi.fn();
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(c) {
                    pulls++;
                    if (pulls === 1) {
                        c.enqueue(Buffer.from("head"));
                        return;
                    }
                    waiting.resolve();
                    return hang.promise;
                },
                cancel,
            },
            { highWaterMark: 0 },
        );
        const controller = new AbortController();
        const file = target();
        const spooling = spool(body, file, 1000, controller.signal);
        await waiting.promise;
        controller.abort(new Error("gone"));
        await expect(spooling).rejects.toThrow("gone");
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(readFileSync(file, "utf-8")).toBe("head");
    });

    it("spools a whole body under its limit with a signal that never aborts", async () => {
        const file = target();
        const body = new Blob([Buffer.from("whole body")]).stream();
        await expect(spool(body, file, 1000, new AbortController().signal)).resolves.toBe(true);
        expect(readFileSync(file, "utf-8")).toBe("whole body");
    });
});
