// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeSecretPath } from "../../../shared/llmSecrets.ts";
import {
    MAX_UPSTREAM_EXPORTS_STAGED,
    UPSTREAM_EXPORT_CANCEL_PATH,
    UPSTREAM_EXPORT_DOWNLOAD_PATH,
    UPSTREAM_EXPORT_EXPIRED,
    UPSTREAM_EXPORT_PREPARE_PATH,
    UPSTREAM_EXPORT_TOO_MANY_STAGED,
} from "../../../shared/upstreamExportReport.ts";
import { UPSTREAM_IMPORT_PREPARE_PATH } from "../../../shared/upstreamBackup.ts";
import { upstreamAssetRecordName } from "../data/upstream/archive.ts";
import type { UpstreamImportRunner } from "../data/upstream/importRunner.ts";
import { stageUpstreamImport } from "../data/upstream/importStage.ts";
import { decodeUpstreamDatabase } from "../data/upstream/risuSave.ts";
import { createUpstreamExportStaging } from "../routes/backupsUpstreamExport.ts";
import {
    createResourceTestClient,
    createTestServer,
    hex,
    parseArchive,
    type ResourceTestClient,
} from "./testSupport.ts";

vi.mock(import("../data/upstream/exportRunner.ts"), async (importOriginal) => {
    const { createExportRunnerMock } = await import("./exportRunnerMock.ts");
    const { stageUpstreamExport } = await import("../data/upstream/exportStage.ts");
    return createExportRunnerMock(await importOriginal(), {
        runUpstreamExportWorker: async (input, { signal }) => {
            signal.throwIfAborted();
            return stageUpstreamExport(input);
        },
    });
});

/**
 * The upstream RisuAI-compatible `.bin` export routes (`routes/backupsUpstreamExport.ts`): prepare,
 * download, and cancel over `createTestServer`. What the projection holds is
 * `upstreamExport.test.ts`; here: the route lifecycle, the record layout, the asset name rule, and
 * that this server's own upstream import reads an export back. The worker boundary runs the stage
 * in process; cold workers, heap limits, and prepare cancellation are in `upstreamExportWorker.test.ts`.
 */

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = "sk-export-route-secret-0123456789";
const PROFILE = "PNG alice profile";

const servers: ResourceTestClient[] = [];
beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(servers.splice(0).map((s) => s.close()));
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
const writeAsset = (s: ResourceTestClient, key: string, body: string) =>
    s.request("/api/write", { method: "POST", headers: { "file-path": hex(key) }, body });
const chatGroup = (characterId: string, chatId: string, name: string) => ({
    characterId,
    chatId,
    baseRevision: null,
    ops: [{ op: "create", chat: { name, message: [{ role: "user", data: `hi ${name}`, chatId: `m-${chatId}` }] } }],
});

/** Alice with a profile image on disk, two chats, and a referenced image that is missing. */
async function seed(s: ResourceTestClient) {
    await s.create("characters", "alice", {
        chaId: "alice",
        name: "Alice",
        type: "character",
        image: "assets/alice.png",
        emotionImages: [["sad", "assets/gone.png"]],
    });
    const res = await s.json("/api/resources/batch", {
        chats: [chatGroup("alice", "first", "First"), chatGroup("alice", "second", "Second")],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await writeAsset(s, "assets/alice.png", PROFILE)).status).toBe(200);
}

const prepareBody = (extra: Record<string, unknown> = {}) => ({
    promptPresetId: "",
    modelPresetId: "",
    personaId: "",
    includeSecrets: false,
    ...extra,
});
const prepareRequest = (s: ResourceTestClient, body: unknown = prepareBody()) =>
    s.json(UPSTREAM_EXPORT_PREPARE_PATH, body);
async function prepare(s: ResourceTestClient, body: unknown = prepareBody()): Promise<{ token: string; report: any }> {
    const res = await prepareRequest(s, body);
    expect(res.status, await res.clone().text()).toBe(200);
    const answer = (await res.json()) as { token: string; report: any };
    expect(answer.token).toMatch(TOKEN);
    return answer;
}
const downloadRequest = (s: ResourceTestClient, token: string, init: RequestInit = {}) =>
    s.request(`${UPSTREAM_EXPORT_DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`, init);
async function download(s: ResourceTestClient, token: string): Promise<Uint8Array> {
    const res = await downloadRequest(s, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    return new Uint8Array(await res.arrayBuffer());
}
const decode = (record: { data: Buffer }) =>
    decodeUpstreamDatabase(record.data, { maxDecodedBytes: 64 * 1024 * 1024 }) as Record<string, any>;

describe("POST /api/backups/export-upstream/prepare and GET /download", () => {
    it("refuses server creation when RISU_UPSTREAM_EXPORT_HEAP_MB is invalid", async () => {
        const s = await server();
        await s.context.dispose();
        vi.stubEnv("RISU_UPSTREAM_EXPORT_HEAP_MB", "abc");
        let started: ReturnType<typeof createTestServer> | undefined;
        try {
            expect(() => {
                started = createTestServer({ rootDir: s.rootDir });
            }).toThrow(/RISU_UPSTREAM_EXPORT_HEAP_MB/);
        } finally {
            await started?.context.dispose();
            vi.unstubAllEnvs();
        }
    });

    it("stages the encoded database under a token, then streams the existing assets by basename and database.risudat last, and removes the staging", async () => {
        const s = await server();
        await seed(s);
        const { token, report } = await prepare(
            s,
            prepareBody({ selectedChat: { characterId: "alice", chatId: "second" } }),
        );
        expect(report.counts).toMatchObject({ characters: 1, chats: 2, messages: 2, assets: 1 });
        expect(report.missing).toEqual([{ key: "assets/gone.png", owner: "Alice", role: "emotion" }]);
        // Only the encoded database waits: the store copy (it holds every credential) is gone.
        const [folder] = staged(s);
        expect(readdirSync(path.join(s.savePath, ".tmp", folder))).toEqual(["database.risudat"]);

        const records = parseArchive(await download(s, token));
        expect(records.map((record) => record.name)).toEqual(["alice.png", "database.risudat"]);
        expect(records[0].data.toString("utf-8")).toBe(PROFILE);
        const db = decode(records[1]);
        expect(db.formatversion).toBe(5);
        const [alice] = db.characters;
        expect(alice.chaId).toBe("alice");
        expect(alice.image).toBe("assets/alice.png");
        expect(alice.chats.map((chat: any) => chat.name)).toEqual(["First", "Second"]);
        expect(alice.chatPage).toBe(1);
        expect(staged(s)).toEqual([]);

        // The token is used up by the download.
        const again = await downloadRequest(s, token);
        expect(again.status).toBe(404);
        expect(await again.json()).toEqual({ error: UPSTREAM_EXPORT_EXPIRED });
    });

    it("leaves the API keys out unless includeSecrets is true", async () => {
        const s = await server();
        const masked = (await (await s.get("llmSecrets", "main")).json()) as { revision: string };
        const put = await s.json(
            `/api/llm-secrets/${encodeSecretPath({ kind: "flat", field: "openAIKey" })}`,
            { value: SECRET, baseRevision: masked.revision },
            { method: "PUT" },
        );
        expect(put.status, await put.clone().text()).toBe(200);

        const without = await prepare(s);
        expect(without.report.excluded).toContainEqual(expect.objectContaining({ code: "api-keys" }));
        const withoutDb = decode(parseArchive(await download(s, without.token)).at(-1)!);
        expect(withoutDb.openAIKey).toBe("");
        expect(JSON.stringify(withoutDb)).not.toContain(SECRET);

        const withKeys = await prepare(s, prepareBody({ includeSecrets: true }));
        const withDb = decode(parseArchive(await download(s, withKeys.token)).at(-1)!);
        expect(withDb.openAIKey).toBe(SECRET);
    });

    it("reports an asset whose name no backup record can hold as left out, and writes no record for it", async () => {
        const s = await server();
        for (const key of ["assets/database.risudat", "assets/﻿portrait.png", "assets/kept.png"]) {
            expect((await writeAsset(s, key, "bytes")).status).toBe(200);
        }
        await s.create("characters", "bob", {
            chaId: "bob",
            name: "Bob",
            type: "character",
            image: "assets/kept.png",
            additionalAssets: [
                ["db", "assets/database.risudat", "risudat"],
                ["bom", "assets/﻿portrait.png", "png"],
            ],
        });
        const { token, report } = await prepare(s);
        expect(report.excluded).toContainEqual({
            code: "asset-names",
            count: 2,
            examples: ["assets/database.risudat", "assets/﻿portrait.png"],
        });
        expect(report.counts.assets).toBe(1);
        const records = parseArchive(await download(s, token));
        expect(records.map((record) => record.name)).toEqual(["kept.png", "database.risudat"]);
    });

    it("is read back by this server's own upstream import", async () => {
        const s = await server({
            upstreamImport: {
                runner: ((input, { onProgress }) => stageUpstreamImport(input, onProgress)) as UpstreamImportRunner,
            },
        });
        await seed(s);
        const { token } = await prepare(s);
        const bytes = await download(s, token);
        const res = await s.request(UPSTREAM_IMPORT_PREPARE_PATH, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: bytes,
        });
        expect(res.status).toBe(200);
        const lines = (await res.text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const result = lines.at(-1);
        expect(result.token).toMatch(TOKEN);
        expect(result.report.counts).toMatchObject({ characters: 1, chats: 2, messages: 2 });
        expect(result.report.missingAssets.map((asset: { key: string }) => asset.key)).toEqual(["assets/gone.png"]);
    });

    it("refuses an invalid body, a malformed token, and a prepare past the waiting limit", async () => {
        const s = await server();
        for (const body of [
            {},
            prepareBody({ includeSecrets: "no" }),
            prepareBody({ selectedChat: { characterId: 1 } }),
        ]) {
            expect((await prepareRequest(s, body)).status).toBe(400);
        }
        expect((await downloadRequest(s, "not-a-token")).status).toBe(400);
        const tokens: string[] = [];
        for (let i = 0; i < MAX_UPSTREAM_EXPORTS_STAGED; i += 1) {
            tokens.push((await prepare(s)).token);
        }
        const refused = await prepareRequest(s);
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({ error: UPSTREAM_EXPORT_TOO_MANY_STAGED });
        expect(staged(s)).toHaveLength(MAX_UPSTREAM_EXPORTS_STAGED);

        // Cancel frees a place and removes the folder; a gone token is 204 at cancel and 404 at download.
        const cancel = await s.json(UPSTREAM_EXPORT_CANCEL_PATH, { token: tokens[0] });
        expect(cancel.status).toBe(204);
        expect(staged(s)).toHaveLength(MAX_UPSTREAM_EXPORTS_STAGED - 1);
        expect((await s.json(UPSTREAM_EXPORT_CANCEL_PATH, { token: tokens[0] })).status).toBe(204);
        expect((await downloadRequest(s, tokens[0])).status).toBe(404);
        await prepare(s);
    });

    it("answers 404 for an expired export and removes its folder", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const s = await server({ upstreamExport: { stagedTtlMs: 1000 } });
        const { token } = await prepare(s);
        expect(staged(s)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1000);
        await s.context.upstreamExportStaging.close();
        expect(staged(s)).toEqual([]);
        const res = await downloadRequest(s, token);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: UPSTREAM_EXPORT_EXPIRED });
    });

    it("frees the token, the staging, and the lifetime when the client leaves mid-download", async () => {
        const s = await server();
        await s.create("characters", "big", { chaId: "big", name: "Big", type: "character", image: "assets/big.png" });
        expect((await writeAsset(s, "assets/big.png", "B".repeat(3 * 1024 * 1024))).status).toBe(200);
        const { token } = await prepare(s);
        const controller = new AbortController();
        const res = await downloadRequest(s, token, { signal: controller.signal });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        // The adapter stops pulling: the generator waits at a `yield` and nothing cancels the stream.
        controller.abort();
        // `stop` resolves only once the download's lifetime is released, after its folder is removed.
        await s.context.snapshots.stop();
        expect(staged(s)).toEqual([]);
        expect((await downloadRequest(s, token)).status).toBe(404);
    });
});

describe("createUpstreamExportStaging", () => {
    let root: string;
    beforeAll(() => {
        root = mkdtempSync(path.join(os.tmpdir(), "risu-upstream-export-staging-"));
    });
    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });
    const entry = async (name: string) => {
        const folder = path.join(root, name);
        await fs.mkdir(folder, { recursive: true });
        return { staging: folder, databaseFile: path.join(folder, "database.risudat"), assets: [] };
    };

    it("expires a waiting export after the TTL, hands one to its download without expiry, and close removes the rest and refuses new ones", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const staging = createUpstreamExportStaging({ ttlMs: 1000 });
        const expiring = await entry("expiring");
        const expired = staging.add(expiring)!;
        const taken = await entry("taken");
        const takenToken = staging.add(taken)!;
        expect(staging.take(takenToken)).toMatchObject({ staging: taken.staging });
        await vi.advanceTimersByTimeAsync(999);
        expect(staging.get(expired)).not.toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(staging.get(expired)).toBeNull();
        expect(existsSync(taken.staging)).toBe(true);

        const left = await entry("left");
        staging.add(left);
        const closing = staging.close();
        expect(staging.closed).toBe(true);
        expect(staging.full).toBe(true);
        expect(staging.add(await entry("late"))).toBeNull();
        await closing;
        expect(staging.size).toBe(0);
        expect(existsSync(expiring.staging)).toBe(false);
        expect(existsSync(left.staging)).toBe(false);
    });
});

describe("upstreamAssetRecordName", () => {
    it("is the key without `assets/`, or null for a name no backup record can hold or read back", () => {
        expect(upstreamAssetRecordName("assets/portrait.png")).toBe("portrait.png");
        expect(upstreamAssetRecordName("assets/한글 image.webp")).toBe("한글 image.webp");
        expect(upstreamAssetRecordName("assets/x﻿y.png")).toBe("x﻿y.png");
        for (const key of [
            "inlay/portrait.png",
            "assets/",
            "assets/sub/portrait.png",
            "assets/back\\slash.png",
            "assets/database.risudat",
            "assets/encryption.risudat",
            "assets/manifest.json",
            "assets/resources.sqlite",
            "assets/coldstorage_0f8e3c4a-5b6d-4e7f-8a9b-0c1d2e3f4a5b.json",
            "assets/0f8e3c4a-5b6d-4e7f-8a9b-0c1d2e3f4a5b.json",
            "assets/﻿portrait.png",
            "assets/\uD800.png",
        ]) {
            expect(upstreamAssetRecordName(key), key).toBeNull();
        }
    });
});
