import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupArchiveManifest } from "../../../shared/resources.ts";

// Local backups over the server's export/import routes (`backuplocal.ts`): every change is flushed
// first, the archive stream goes to the file writer while the manifest is read from its head, the
// missing-asset report names what the database referenced, a failed or cancelled download cancels
// the response and aborts the writer, and a restore posts the file and reloads.

const { alerts, flush, writer, requests, exportResponse } = vi.hoisted(() => ({
    alerts: {
        alertError: vi.fn(),
        alertNormal: vi.fn(),
        alertWait: vi.fn(),
        alertMd: vi.fn(),
        alertConfirm: vi.fn(async () => true),
        alertStore: { set: vi.fn() },
    },
    flush: vi.fn(async () => ({ discarded: [] as string[] })),
    writer: {
        initResult: true as boolean | Error,
        chunks: [] as Uint8Array[],
        failWriteAt: -1,
        abort: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
    },
    requests: [] as { path: string; init: RequestInit }[],
    exportResponse: { current: null as (() => Response) | null },
}));

vi.mock("../alert", () => alerts);
vi.mock("../storage/resourceSync.svelte", () => ({ flushResources: flush }));
vi.mock("src/lang", () => ({
    language: { partialBackupFirstConfirm: "first?", partialBackupSecondConfirm: "second?" },
}));
vi.mock("../globalApi.svelte", () => ({
    LocalWriter: class {
        writer = { abort: writer.abort };
        async init() {
            if (writer.initResult instanceof Error) {
                throw writer.initResult;
            }
            return writer.initResult;
        }
        async write(data: Uint8Array) {
            if (writer.chunks.length === writer.failWriteAt) {
                throw new Error("disk full");
            }
            writer.chunks.push(new Uint8Array(data));
        }
        async close() {
            await writer.close();
        }
    },
}));
vi.mock("../storage/serverAuth", () => ({
    authFetch: async (path: string, init: RequestInit = {}) => {
        requests.push({ path, init });
        if (path === "/api/backups/export") {
            return exportResponse.current!();
        }
        if (path === "/api/backups/import") {
            const header = new Headers(init.headers);
            if (header.get("x-resource-epoch") !== "epoch-1") {
                return Response.json({ error: "EpochMismatch", epoch: "epoch-2" }, { status: 412 });
            }
            if ((await new Response(init.body as Blob).text()) === "bad archive") {
                return Response.json({ error: "The archive is from before this version" }, { status: 400 });
            }
            return Response.json({ epoch: "epoch-1", assetsWritten: 1, assetsSkipped: 0 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
    },
}));

import { setResourceEpoch } from "../storage/resourceClient";
import { installFlatDatabase } from "../storage/tests/installFlatDatabase";
import { LoadLocalBackup, SaveLocalBackup, SavePartialLocalBackup } from "./backuplocal";

const encoder = new TextEncoder();

/**
 * The records the backup inventory (`buildBackupInventory`, Phase 6 slice 10) reads: Alice (a main
 * image and an emotion image), a group (a main image), the personas (`userIcon` is the selected
 * persona's icon: the first one, `assets/icon.png`; `Me` is another persona), a preset with an
 * image, and a folder with an image.
 */
function installInventory() {
    installFlatDatabase({
        characters: [
            {
                chaId: "alice",
                name: "Alice",
                type: "character",
                image: "assets/alice.png",
                emotionImages: [["happy", "assets/happy.png"]],
            },
            { chaId: "group", name: "Group", type: "group", image: "assets/group.png" },
        ],
        personas: [
            { id: "self", name: "Self", icon: "assets/icon.png", personaPrompt: "", note: "" },
            { id: "me", name: "Me", icon: "assets/me.png", personaPrompt: "", note: "" },
        ],
        botPresets: [{ id: "p", name: "P", image: "assets/preset.png" }],
        characterOrder: [{ id: "f", type: "folder", name: "F", img: "assets/folder.png", data: [] }],
    });
}

/** One archive record: u32 LE name length, utf8 name, u32 LE data length, bytes. */
function record(name: string, data: Uint8Array): Uint8Array {
    const encodedName = encoder.encode(name);
    const out = new Uint8Array(4 + encodedName.byteLength + 4 + data.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, encodedName.byteLength, true);
    out.set(encodedName, 4);
    view.setUint32(4 + encodedName.byteLength, data.byteLength, true);
    out.set(data, 4 + encodedName.byteLength + 4);
    return out;
}

function archive(manifest: Partial<BackupArchiveManifest>, assets: string[] = manifest.assets ?? []): Uint8Array {
    const full: BackupArchiveManifest = {
        version: 2,
        createdAt: "now",
        partial: false,
        assets,
        missing: [],
        ...manifest,
    };
    const records = [
        record("manifest.json", encoder.encode(JSON.stringify(full))),
        record("resources.sqlite", new Uint8Array(64).fill(7)),
        ...assets.map((key) => record(key, encoder.encode(`bytes of ${key}`))),
    ];
    const out = new Uint8Array(records.reduce((sum, r) => sum + r.byteLength, 0));
    let offset = 0;
    for (const r of records) {
        out.set(r, offset);
        offset += r.byteLength;
    }
    return out;
}

/** A streaming export response delivered in `chunkSize` pieces, with a cancel hook. */
function streamed(bytes: Uint8Array, chunkSize: number, options: { failAfter?: number } = {}) {
    const cancelled = vi.fn();
    let offset = 0;
    let delivered = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (options.failAfter !== undefined && delivered >= options.failAfter) {
                controller.error(new Error("connection reset"));
                return;
            }
            if (offset >= bytes.length) {
                controller.close();
                return;
            }
            controller.enqueue(bytes.slice(offset, offset + chunkSize));
            offset += chunkSize;
            delivered += 1;
        },
        cancel: cancelled,
    });
    return { response: () => new Response(body, { status: 200 }), cancelled };
}

const written = () => {
    const total = writer.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of writer.chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
};

beforeEach(() => {
    requests.length = 0;
    writer.chunks.length = 0;
    writer.initResult = true;
    writer.failWriteAt = -1;
    installInventory();
    setResourceEpoch("epoch-1");
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("SaveLocalBackup", () => {
    it("flushes, streams the archive to the file, reads the manifest across chunk boundaries, and reports success", async () => {
        const bytes = archive({
            assets: ["assets/alice.png", "assets/happy.png", "assets/group.png", "assets/icon.png"],
        });
        const stream = streamed(bytes, 7);
        exportResponse.current = stream.response;
        await SaveLocalBackup();
        expect(flush).toHaveBeenCalledTimes(1);
        expect(requests.map((r) => r.path)).toEqual(["/api/backups/export"]);
        expect(JSON.parse(requests[0].init.body as string)).toEqual({});
        expect(written()).toEqual(bytes);
        expect(writer.close).toHaveBeenCalledTimes(1);
        expect(writer.abort).not.toHaveBeenCalled();
        expect(stream.cancelled).not.toHaveBeenCalled();
        expect(alerts.alertNormal).toHaveBeenCalledWith("Success");
        expect(alerts.alertError).not.toHaveBeenCalled();
    });

    it("reports the referenced assets the archive did not contain, by character and role", async () => {
        exportResponse.current = streamed(archive({ assets: ["assets/alice.png", "assets/icon.png"] }), 1024).response;
        await SaveLocalBackup();
        expect(alerts.alertNormal).not.toHaveBeenCalled();
        const report = alerts.alertMd.mock.calls[0][0] as string;
        expect(report).toContain("Backup Successful");
        expect(report).toContain("**happy** (from *Alice*)");
        expect(report).toContain("assets/happy.png");
        expect(report).toContain("**Main Image** (from *Group*)");
        expect(report).not.toContain("alice.png");
    });

    it("does not export when the flush fails", async () => {
        flush.mockRejectedValueOnce(new Error("A character is still being generated"));
        await SaveLocalBackup();
        expect(requests).toEqual([]);
        expect(alerts.alertError).toHaveBeenCalledWith(expect.stringContaining("still being generated"));
    });

    it("cancels the export stream when the file writer cannot be opened", async () => {
        const stream = streamed(archive({ assets: [] }), 16);
        exportResponse.current = stream.response;
        writer.initResult = false;
        await SaveLocalBackup();
        expect(stream.cancelled).toHaveBeenCalledTimes(1);
        expect(alerts.alertError).toHaveBeenCalledWith("Failed");
        expect(writer.close).not.toHaveBeenCalled();
    });

    it("cancels the stream and aborts the writer when a write fails", async () => {
        const stream = streamed(archive({ assets: ["assets/alice.png"] }), 8);
        exportResponse.current = stream.response;
        writer.failWriteAt = 2;
        await SaveLocalBackup();
        expect(stream.cancelled).toHaveBeenCalledTimes(1);
        expect(writer.abort).toHaveBeenCalledTimes(1);
        expect(writer.close).not.toHaveBeenCalled();
        expect(alerts.alertError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    });

    it("aborts the writer when the download breaks", async () => {
        exportResponse.current = streamed(archive({ assets: ["assets/alice.png"] }), 8, { failAfter: 3 }).response;
        await SaveLocalBackup();
        expect(writer.abort).toHaveBeenCalledTimes(1);
        expect(writer.close).not.toHaveBeenCalled();
        expect(alerts.alertError).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
    });

    it("reports a refused export", async () => {
        exportResponse.current = () => Response.json({ error: "Too many assets for one archive" }, { status: 413 });
        await SaveLocalBackup();
        expect(alerts.alertError).toHaveBeenCalledWith(expect.stringContaining("Too many assets"));
        expect(writer.chunks).toEqual([]);
    });
});

describe("SavePartialLocalBackup", () => {
    it("asks twice, lets the server select the images from its snapshot, and labels what it could not find", async () => {
        const stream = streamed(
            archive({
                partial: true,
                assets: ["assets/alice.png"],
                missing: [
                    "assets/me.png",
                    "assets/group.png",
                    "assets/folder.png",
                    "assets/preset.png",
                    "assets/x.png",
                ],
            }),
            32,
        );
        exportResponse.current = stream.response;
        await SavePartialLocalBackup();
        expect(alerts.alertConfirm).toHaveBeenCalledTimes(2);
        // The server selects the profile images from the snapshot it archives (audit IO-04): the
        // request carries no key list, so an image replaced after the inventory is still archived.
        expect(JSON.parse(requests[0].init.body as string)).toEqual({ partial: true });
        const report = alerts.alertMd.mock.calls[0][0] as string;
        expect(report).toContain("**Me Icon** (from *Persona*)");
        expect(report).toContain("**Profile Image** (from *Group*)");
        expect(report).toContain("**F Folder Image** (from *Folder*)");
        expect(report).toContain("**P Preset Image** (from *Preset*)");
        // A key the client never saw (another writer's image) is still reported, by its file.
        expect(report).toContain("**Unknown Asset**  \n  *File: assets/x.png*");
    });

    it("stops at the first declined confirmation", async () => {
        alerts.alertConfirm.mockResolvedValueOnce(false);
        await SavePartialLocalBackup();
        expect(flush).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
    });
});

describe("LoadLocalBackup", () => {
    async function load(file: File) {
        const realCreate = document.createElement.bind(document);
        let input: HTMLInputElement | null = null;
        vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
            const el = realCreate(tag);
            if (tag === "input") {
                input = el as HTMLInputElement;
                el.click = () => {};
            }
            return el;
        });
        LoadLocalBackup();
        expect(input).not.toBeNull();
        expect(input!.accept).toBe(".bin");
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        await input!.onchange!(new Event("change"));
    }

    it("posts the file to the import route with the loaded epoch and reloads", async () => {
        await load(new File(["archive bytes"], "backup.bin"));
        expect(requests).toHaveLength(1);
        expect(requests[0].path).toBe("/api/backups/import");
        const headers = new Headers(requests[0].init.headers);
        expect(headers.get("content-type")).toBe("application/octet-stream");
        expect(headers.get("x-resource-epoch")).toBe("epoch-1");
        expect(await new Response(requests[0].init.body as Blob).text()).toBe("archive bytes");
        expect(alerts.alertStore.set).toHaveBeenCalledWith({ type: "wait", msg: "Success, Refreshing your app." });
        expect((location as any).reload).toHaveBeenCalled();
        expect(alerts.alertError).not.toHaveBeenCalled();
    });

    it("shows the server's refusal and does not reload", async () => {
        await load(new File(["bad archive"], "backup.bin"));
        expect(alerts.alertError).toHaveBeenCalledWith("The archive is from before this version");
        expect((location as any).reload).not.toHaveBeenCalled();
    });

    it("reloads without an error when the server data changed since this tab loaded (412)", async () => {
        setResourceEpoch("stale");
        await load(new File(["archive bytes"], "backup.bin"));
        expect(alerts.alertError).not.toHaveBeenCalled();
        expect((location as any).reload).toHaveBeenCalled();
    });
});
