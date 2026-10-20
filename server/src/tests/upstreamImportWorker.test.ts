// @vitest-environment node
/** @module-tag slow */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UPSTREAM_IMPORT_COMMIT_PATH, UPSTREAM_IMPORT_PREPARE_PATH } from "../../../shared/upstreamBackup.ts";
import { runUpstreamImportWorker, type UpstreamImportRunner } from "../data/upstream/importRunner.ts";
import { encodeUpstreamDatabase } from "../data/upstream/risuSave.ts";
import { UPSTREAM_FIXTURE_DATABASE } from "./fixtures/upstream/database.ts";
import { buildArchive, createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

/**
 * The upstream import's real worker (`importWorker.ts`, `importRunner.ts`): a cold `worker_threads`
 * boot of the converter and `node:sqlite` per prepare, the heap limit (`resourceLimits`), and the
 * test latch. Slow by V3 (a cold worker boot and a real memory limit); the routes themselves are
 * `upstreamImportRoute.test.ts` with an in-process runner.
 */

const SLOW = { tags: ["slow"], timeout: 90_000 };
const servers: ResourceTestClient[] = [];
const responses: Response[] = [];
let database: Uint8Array;
const tmpDir = (s: ResourceTestClient) => path.join(s.savePath, ".tmp");
const staged = (s: ResourceTestClient) => readdirSync(tmpDir(s));
const assetDir = (s: ResourceTestClient) => path.join(s.savePath, "assets");
const assetFiles = (s: ResourceTestClient) => (existsSync(assetDir(s)) ? readdirSync(assetDir(s)).sort() : []);
const archive = (db: Uint8Array = database) =>
    buildArchive([
        ["3f2a9c.png", "PNG profile"],
        ["joy.png", "PNG joy"],
        ["database.risudat", db],
    ]);

beforeAll(() => {
    database = encodeUpstreamDatabase(UPSTREAM_FIXTURE_DATABASE);
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    await Promise.all(responses.splice(0).map((res) => res.body?.cancel().catch(() => {})));
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(options: Parameters<typeof createResourceTestClient>[0] = {}) {
    const s = await createResourceTestClient(options);
    servers.push(s);
    return s;
}
async function prepareRequest(s: ResourceTestClient, bytes: Uint8Array) {
    const res = await s.request(UPSTREAM_IMPORT_PREPARE_PATH, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
    });
    responses.push(res);
    expect(res.status).toBe(200);
    return res;
}
async function lines(res: Response): Promise<any[]> {
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    return text
        .slice(0, -1)
        .split("\n")
        .map((line) => JSON.parse(line));
}
/** A runner on the real worker under a small heap, with the test latch when one is given. */
function workerRunner(heapMb: number, latch?: Int32Array, onHeld?: () => void): UpstreamImportRunner {
    return (input, options) =>
        runUpstreamImportWorker(input, {
            ...options,
            resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
            latch,
            onHeld,
        });
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}

describe("the upstream import worker", () => {
    it("converts in a worker through the default runner and the commit installs its staged store", SLOW, async () => {
        const s = await server();
        const answer = await lines(await prepareRequest(s, archive()));
        const result = answer.at(-1);
        expect(result.token).toBeDefined();
        expect(result.report.counts).toMatchObject({ characters: 1, groups: 1, chats: 2, messages: 3 });
        expect(answer.slice(0, -1).map((line) => line.phase)).toContain("assets");
        const res = await s.json(UPSTREAM_IMPORT_COMMIT_PATH, { token: result.token });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ assetsWritten: 2, assetsSkipped: 0, selection: result.selection });
        expect(assetFiles(s)).toEqual(["3f2a9c.png", "joy.png"]);
        expect(staged(s)).toEqual([]);
    });

    it(
        "ends a prepare whose decode outgrows the worker's heap with an error line naming the limit, leaving no staging and the server serving",
        SLOW,
        async () => {
            const s = await server({ upstreamImport: { runner: workerRunner(16) } });
            const errors = vi.spyOn(console, "error").mockImplementation(() => {});
            const big = {
                characters: Array.from({ length: 2000 }, (_, i) => ({
                    type: "character",
                    chaId: `id${i}`,
                    name: `c${i}`,
                    firstMessage: "x".repeat(4000),
                    chats: [{ message: Array.from({ length: 20 }, () => ({ role: "user", data: "y".repeat(1000) })) }],
                })),
            };
            const answer = await lines(await prepareRequest(s, archive(encodeUpstreamDatabase(big))));
            const last = answer.at(-1);
            expect(last).toEqual({ error: expect.stringContaining("RISU_UPSTREAM_IMPORT_HEAP_MB") });
            expect(staged(s)).toEqual([]);
            expect(s.context.upstreamStaging.size).toBe(0);
            expect(assetFiles(s)).toEqual([]);
            expect(errors).not.toHaveBeenCalled();
            expect((await s.get("ui", "main")).status).toBe(200);
            // The same backup converts under a larger heap: the limit, not the backup, ended the first run.
            const roomy = await server({ upstreamImport: { runner: workerRunner(1024) } });
            const retried = await lines(await prepareRequest(roomy, archive(encodeUpstreamDatabase(big))));
            expect(retried.at(-1).report.counts.characters).toBe(2000);
        },
    );

    it(
        "leaves the event loop free while the worker runs: a resource read answers while it is held, and the release lets it finish",
        SLOW,
        async () => {
            const latch = new Int32Array(new SharedArrayBuffer(4));
            const held = deferred();
            const s = await server({ upstreamImport: { runner: workerRunner(256, latch, held.resolve) } });
            await s.create("characters", "z", { chaId: "z", name: "z", type: "character" });
            const res = await prepareRequest(s, archive());
            await held.promise;
            expect(staged(s)).toHaveLength(1);
            expect((await s.get("characters", "z")).status).toBe(200);
            Atomics.store(latch, 0, 1);
            Atomics.notify(latch, 0);
            const answer = await lines(res);
            expect(answer.at(-1).token).toBeDefined();
            expect((await s.json(UPSTREAM_IMPORT_COMMIT_PATH, { token: answer.at(-1).token })).status).toBe(200);
        },
    );

    it("shutdown terminates a held worker at once, ends the answer, and removes the staging", SLOW, async () => {
        const latch = new Int32Array(new SharedArrayBuffer(4));
        const held = deferred();
        const s = await server({ upstreamImport: { runner: workerRunner(256, latch, held.resolve) } });
        const res = await prepareRequest(s, archive());
        await held.promise;
        expect(staged(s)).toHaveLength(1);
        const disposing = s.context.dispose();
        const answer = await lines(res);
        expect(answer.at(-1)).toEqual({ error: "The server is shutting down" });
        await disposing;
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamStaging.size).toBe(0);
        // The latch was never released: the worker was terminated, not finished.
        expect(Atomics.load(latch, 0)).toBe(0);
    });
});
