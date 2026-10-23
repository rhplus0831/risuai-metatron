// @vitest-environment node
/** @module-tag slow */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSecretPath } from "../../../shared/llmSecrets.ts";
import {
    UPSTREAM_EXPORT_DOWNLOAD_PATH,
    UPSTREAM_EXPORT_PREPARE_PATH,
    type UpstreamExportPrepared,
    type UpstreamExportRequest,
} from "../../../shared/upstreamExportReport.ts";
import { runUpstreamExportWorker } from "../data/upstream/exportRunner.ts";
import { decodeUpstreamDatabase } from "../data/upstream/risuSave.ts";
import { createResourceTestClient, hex, parseArchive, type ResourceTestClient } from "./testSupport.ts";

/** The route still starts the real worker; only its optional test latch is supplied here. */
const controls = vi.hoisted(() => ({ hold: undefined as { latch: Int32Array; onHeld: () => void } | undefined }));
vi.mock(import("../data/upstream/exportRunner.ts"), async (importOriginal) => {
    const original = await importOriginal();
    const { createExportRunnerMock } = await import("./exportRunnerMock.ts");
    return createExportRunnerMock(original, {
        runUpstreamExportWorker: vi.fn((input, options) =>
            original.runUpstreamExportWorker(input, { ...options, ...controls.hold }),
        ),
    });
});

/** Cold worker boots and a real heap limit belong outside the gated route suite. */
const SLOW = { tags: ["slow"], timeout: 90_000 };
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = "sk-export-worker-secret-0123456789";
const servers: ResourceTestClient[] = [];

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});
beforeEach(() => {
    vi.stubEnv("RISU_UPSTREAM_EXPORT_HEAP_MB", undefined);
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    // Failure cleanup only: cancellation tests assert the unreleased latch before reaching here.
    if (controls.hold) release(controls.hold.latch);
    controls.hold = undefined;
    for (const s of servers.splice(0).reverse()) await s.close();
    vi.mocked(runUpstreamExportWorker).mockClear();
    vi.unstubAllEnvs();
});

async function server(options: Parameters<typeof createResourceTestClient>[0] = {}) {
    const s = await createResourceTestClient(options);
    servers.push(s);
    return s;
}
const staged = (s: ResourceTestClient) => {
    const dir = path.join(s.savePath, ".tmp");
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("export-upstream-")) : [];
};
const prepareBody = (extra: Partial<UpstreamExportRequest> = {}): UpstreamExportRequest => ({
    promptPresetId: "",
    modelPresetId: "",
    personaId: "",
    includeSecrets: false,
    ...extra,
});
const prepareRequest = (s: ResourceTestClient, body = prepareBody(), signal?: AbortSignal) =>
    s.json(UPSTREAM_EXPORT_PREPARE_PATH, body, { signal });
async function prepared(res: Response): Promise<UpstreamExportPrepared> {
    expect(res.status, await res.clone().text()).toBe(200);
    const result = (await res.json()) as UpstreamExportPrepared;
    expect(result.token).toMatch(TOKEN);
    return result;
}
function release(latch: Int32Array) {
    Atomics.store(latch, 0, 1);
    Atomics.notify(latch, 0);
}
function holdWorker() {
    let onHeld!: () => void;
    const held = new Promise<void>((resolve) => (onHeld = resolve));
    const latch = new Int32Array(new SharedArrayBuffer(4));
    controls.hold = { latch, onHeld };
    return {
        latch,
        async wait(pending: Promise<Response>) {
            // A main-thread replacement that bypasses the worker must fail, not silently pass.
            expect(await Promise.race([held.then(() => "held"), pending.then(() => "finished")])).toBe("held");
        },
    };
}

describe("the upstream export worker", () => {
    it(
        "prepares and downloads the seeded database with a 2048 MiB default heap, exposing keys only in an opted-in database",
        SLOW,
        async () => {
            const s = await server();
            await s.create("characters", "alice", {
                chaId: "alice",
                name: "Alice",
                type: "character",
                image: "assets/alice.png",
            });
            const chats = ["First", "Second"].map((name, i) => ({
                characterId: "alice",
                chatId: `chat-${i}`,
                baseRevision: null,
                ops: [
                    { op: "create", chat: { name, message: [{ role: "user", data: `hi ${name}`, chatId: `m-${i}` }] } },
                ],
            }));
            expect((await s.json("/api/resources/batch", { chats })).status).toBe(200);
            expect(
                (
                    await s.request("/api/write", {
                        method: "POST",
                        headers: { "file-path": hex("assets/alice.png") },
                        body: "PNG Alice",
                    })
                ).status,
            ).toBe(200);
            const masked = (await (await s.get("llmSecrets", "main")).json()) as { revision: string };
            expect(
                (
                    await s.json(
                        `/api/llm-secrets/${encodeSecretPath({ kind: "flat", field: "openAIKey" })}`,
                        { value: SECRET, baseRevision: masked.revision },
                        { method: "PUT" },
                    )
                ).status,
            ).toBe(200);

            for (const includeSecrets of [false, true]) {
                const result = await prepared(
                    await prepareRequest(
                        s,
                        prepareBody({
                            includeSecrets,
                            selectedChat: { characterId: "alice", chatId: "chat-1" },
                        }),
                    ),
                );
                expect(result.report.counts).toMatchObject({ characters: 1, chats: 2, messages: 2, assets: 1 });
                expect(JSON.stringify(result)).not.toContain(SECRET);
                if (!includeSecrets) {
                    expect(result.report.excluded).toContainEqual(expect.objectContaining({ code: "api-keys" }));
                }
                const [folder] = staged(s);
                expect(readdirSync(path.join(s.savePath, ".tmp", folder))).toEqual(["database.risudat"]);
                const res = await s.request(`${UPSTREAM_EXPORT_DOWNLOAD_PATH}?token=${result.token}`);
                expect(res.status).toBe(200);
                expect(res.headers.get("content-type")).toBe("application/octet-stream");
                const records = parseArchive(new Uint8Array(await res.arrayBuffer()));
                expect(records.map(({ name }) => name)).toEqual(["alice.png", "database.risudat"]);
                expect(records[0].data.toString()).toBe("PNG Alice");
                const db = decodeUpstreamDatabase(records[1].data, { maxDecodedBytes: 64 * 1024 * 1024 }) as Record<
                    string,
                    any
                >;
                expect(db.formatversion).toBe(5);
                expect(db.characters).toHaveLength(1);
                expect(db.characters[0]).toMatchObject({
                    chaId: "alice",
                    name: "Alice",
                    image: "assets/alice.png",
                    chatPage: 1,
                    chats: [
                        { name: "First", message: [{ role: "user", data: "hi First", chatId: "m-0" }] },
                        { name: "Second", message: [{ role: "user", data: "hi Second", chatId: "m-1" }] },
                    ],
                });
                expect(db.openAIKey).toBe(includeSecrets ? SECRET : "");
                if (!includeSecrets) expect(JSON.stringify(db)).not.toContain(SECRET);
                expect(staged(s)).toEqual([]);
                expect(s.context.upstreamExportStaging.size).toBe(0);
            }
            // Inspect both directions of the worker boundary, including results not exposed by HTTP.
            const runner = vi.mocked(runUpstreamExportWorker);
            expect(runner).toHaveBeenCalledTimes(2);
            expect(JSON.stringify(runner.mock.calls)).not.toContain(SECRET);
            for (const [, options] of runner.mock.calls) {
                expect(options.resourceLimits.maxOldGenerationSizeMb).toBe(2048);
            }
            for (const result of runner.mock.results) {
                expect(JSON.stringify(await result.value)).not.toContain(SECRET);
            }
        },
    );

    it("serves a resource read while the worker is held and finishes prepare after release", SLOW, async () => {
        const s = await server();
        const hold = holdWorker();
        const pending = prepareRequest(s);
        await hold.wait(pending);
        expect(staged(s)).toHaveLength(1);
        expect((await s.get("ui", "main")).status).toBe(200);
        expect(Atomics.load(hold.latch, 0)).toBe(0);
        release(hold.latch);
        await prepared(await pending);
        expect(s.context.upstreamExportStaging.size).toBe(1);
    });

    it("shutdown terminates an unreleased worker, answers 503, and removes its staging", SLOW, async () => {
        const s = await server();
        const hold = holdWorker();
        const pending = prepareRequest(s);
        await hold.wait(pending);
        expect(staged(s)).toHaveLength(1);
        const disposing = s.context.dispose();
        const res = await pending;
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "The server is shutting down" });
        await disposing;
        expect(staged(s)).toEqual([]);
        expect(s.context.upstreamExportStaging.size).toBe(0);
        expect(Atomics.load(hold.latch, 0)).toBe(0);
        controls.hold = undefined;
    });

    it(
        "a client disconnect terminates an unreleased worker and removes staging before snapshots stop",
        SLOW,
        async () => {
            const s = await server();
            const hold = holdWorker();
            const controller = new AbortController();
            const pending = prepareRequest(s, prepareBody(), controller.signal);
            await hold.wait(pending);
            expect(staged(s)).toHaveLength(1);
            controller.abort();
            await s.context.snapshots.stop();
            expect(staged(s)).toEqual([]);
            expect(s.context.upstreamExportStaging.size).toBe(0);
            expect(Atomics.load(hold.latch, 0)).toBe(0);
            const res = await pending;
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: "Request aborted" });
            controls.hold = undefined;
        },
    );

    it(
        "refuses a store exceeding RISU_UPSTREAM_EXPORT_HEAP_MB with 413 and exports the same store under a larger heap",
        SLOW,
        async () => {
            vi.stubEnv("RISU_UPSTREAM_EXPORT_HEAP_MB", "16");
            const s = await server();
            const count = 2000;
            const ops = Array.from({ length: count }, (_, i) => ({
                kind: "characters",
                id: `id-${i}`,
                baseRevision: null,
                data: { type: "character", chaId: `id-${i}`, name: `Character ${i}`, firstMessage: "x".repeat(4000) },
            }));
            const chats = ops.map(({ id }) => ({
                characterId: id,
                chatId: "chat",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            name: "Chat",
                            message: Array.from({ length: 20 }, (_, i) => ({
                                role: "user",
                                data: "y".repeat(1000),
                                chatId: `message-${i}`,
                            })),
                        },
                    },
                ],
            }));
            expect((await s.json("/api/resources/batch", { ops, chats })).status).toBe(200);
            // The environment is captured at creation, not read anew for each prepare.
            vi.stubEnv("RISU_UPSTREAM_EXPORT_HEAP_MB", "1024");
            const refused = await prepareRequest(s);
            expect(refused.status).toBe(413);
            expect(await refused.json()).toEqual({ error: expect.stringContaining("RISU_UPSTREAM_EXPORT_HEAP_MB") });
            expect(staged(s)).toEqual([]);
            expect(s.context.upstreamExportStaging.size).toBe(0);
            expect((await s.get("ui", "main")).status).toBe(200);

            // Reopen exactly the same store with the larger cap; no replacement fixture or writes.
            await s.context.dispose();
            const roomy = await server({ rootDir: s.rootDir });
            const result = await prepared(await prepareRequest(roomy));
            expect(result.report.counts).toMatchObject({ characters: count, chats: count, messages: count * 20 });
        },
    );
});
