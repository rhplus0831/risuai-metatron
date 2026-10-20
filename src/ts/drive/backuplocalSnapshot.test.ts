// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";

// The partial backup against the real export route (audit IO-04): the client sends no key list, so
// a profile image another writer commits while the client waits for its flush is selected from the
// snapshot the server archives, and a referenced image the server lacks is reported under the
// client's label. The flush is a stub that stands in for the save cycle (it lets the test commit
// the concurrent change at that point); the inventory, the writer, and the alerts are fakes.
//
// The server's test support is loaded through a computed path, as `storeBackedServer.ts` loads the
// store: a static import would pull the server's sources into the client's `svelte-check` program.

const SERVER_TESTS = "../../../server/src/tests/";

type TestClient = {
    epoch: string;
    request(url: string, init?: RequestInit): Promise<Response>;
    create(kind: string, id: string, data: unknown): Promise<string>;
    put(kind: string, id: string, body: unknown): Promise<Response>;
    close(): Promise<void>;
};
type Support = {
    createResourceTestClient(): Promise<TestClient>;
    hex(key: string): string;
    parseArchive(bytes: Uint8Array): { name: string; data: Buffer }[];
};
let support: Support;

const mocks = vi.hoisted(() => ({
    flush: vi.fn(async () => ({ discarded: [] as string[] })),
    authFetch: vi.fn(),
    inventory: { current: null as any },
    writer: { chunks: [] as Uint8Array[] },
    alerts: {
        alertError: vi.fn(),
        alertNormal: vi.fn(),
        alertStore: { set: vi.fn() },
        alertWait: vi.fn(),
        alertMd: vi.fn(),
        alertConfirm: vi.fn(async () => true),
    },
}));

vi.mock("../storage/resourceSync.svelte", () => ({ flushResources: () => mocks.flush() }));
vi.mock("../storage/snapshots.svelte", () => ({ buildBackupInventory: () => mocks.inventory.current }));
vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init: RequestInit) => mocks.authFetch(path, init),
    getNodeServerProxyAuth: async () => null,
}));
vi.mock("../globalApi.svelte", () => ({
    LocalWriter: class {
        writer = { abort: async () => undefined };
        async init() {
            return true;
        }
        async write(data: Uint8Array) {
            mocks.writer.chunks.push(new Uint8Array(data));
        }
        async close() {}
    },
}));
vi.mock("../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock(mocks.alerts));
vi.mock("src/lang", () => ({
    language: { partialBackupFirstConfirm: "first?", partialBackupSecondConfirm: "second?" },
}));

import { setResourceEpoch } from "../storage/resourceClient";
import { SavePartialLocalBackup } from "./backuplocal";

const alice = (image: string) => normalizeCharacter({ chaId: "alice", name: "Alice", type: "character", image });

function installInventory(image: string) {
    mocks.inventory.current = {
        characters: [{ chaId: "alice", name: "Alice", type: "character", image }],
        personas: [],
        characterOrder: [],
        botPresets: [],
    };
}

async function writeAsset(server: TestClient, key: string) {
    const response = await server.request("/api/write", {
        method: "POST",
        headers: { "file-path": support.hex(key) },
        body: `bytes:${key}`,
    });
    expect(response.status).toBe(200);
}

function archiveBytes() {
    return Buffer.concat(mocks.writer.chunks);
}

/** Alice's image in the archived resource database. */
function archivedImage(bytes: Uint8Array) {
    const database = support.parseArchive(bytes).find((record) => record.name === "resources.sqlite")!;
    const dir = mkdtempSync(path.join(os.tmpdir(), "partial-backup-"));
    const file = path.join(dir, "resources.sqlite");
    writeFileSync(file, database.data);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const row = db.prepare("SELECT data FROM resources WHERE kind = ? AND id = ?").get("characters", "alice") as {
            data: string;
        };
        return JSON.parse(row.data).image as string;
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

let server: TestClient | null = null;

async function setup(image: string) {
    server = await support.createResourceTestClient();
    setResourceEpoch(server.epoch);
    installInventory(image);
    const revision = await server.create("characters", "alice", alice(image));
    mocks.authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        return server!.request(url, { ...init, headers });
    });
    return revision;
}

beforeAll(async () => {
    support = (await import(/* @vite-ignore */ `${SERVER_TESTS}testSupport.ts`)) as Support;
});

afterEach(async () => {
    mocks.flush.mockReset().mockResolvedValue({ discarded: [] });
    mocks.authFetch.mockReset();
    mocks.writer.chunks.length = 0;
    mocks.inventory.current = null;
    vi.clearAllMocks();
    await server?.close();
    server = null;
});

describe("SavePartialLocalBackup over the real export route", () => {
    it("archives the image another writer committed while the backup waited for the flush", async () => {
        const revision = await setup("assets/old.png");
        await writeAsset(server!, "assets/old.png");
        await writeAsset(server!, "assets/new.png");
        mocks.flush.mockImplementationOnce(async () => {
            const response = await server!.put("characters", "alice", {
                baseRevision: revision,
                data: alice("assets/new.png"),
            });
            expect(response.status).toBe(200);
            return { discarded: [] };
        });

        await SavePartialLocalBackup();
        const sent = mocks.authFetch.mock.calls.find(([url]) => url === "/api/backups/export")!;
        expect(JSON.parse(sent[1].body as string)).toEqual({ partial: true });
        const bytes = archiveBytes();
        const records = support.parseArchive(bytes);
        expect(JSON.parse(records[0].data.toString("utf-8"))).toMatchObject({
            partial: true,
            assets: ["assets/new.png"],
            missing: [],
        });
        expect(records.map((record) => record.name)).toEqual(["manifest.json", "resources.sqlite", "assets/new.png"]);
        expect(archivedImage(bytes)).toBe("assets/new.png");
        expect(mocks.alerts.alertNormal).toHaveBeenCalledWith("Success");
        expect(mocks.alerts.alertMd).not.toHaveBeenCalled();
    });

    it("reports a referenced image the server lacks under the character's label", async () => {
        await setup("assets/lost.png");
        await SavePartialLocalBackup();
        const records = support.parseArchive(archiveBytes());
        expect(JSON.parse(records[0].data.toString("utf-8"))).toMatchObject({
            partial: true,
            assets: [],
            missing: ["assets/lost.png"],
        });
        expect(mocks.alerts.alertNormal).not.toHaveBeenCalled();
        const report = mocks.alerts.alertMd.mock.calls[0][0] as string;
        expect(report).toContain("**Profile Image** (from *Alice*)");
        expect(report).toContain("*File: assets/lost.png*");
    });
});
