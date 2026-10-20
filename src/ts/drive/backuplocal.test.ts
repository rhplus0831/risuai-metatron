import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupArchiveManifest } from "../../../shared/resources.ts";

// Local backups over the server's export/import routes (`backuplocal.ts`): every change is flushed
// first, the archive stream goes to the file writer while the manifest is read from its head, the
// missing-asset report names what the database referenced, a failed or cancelled download cancels
// the response and aborts the writer, and a restore posts the file and reloads.

const { alerts, flush, writer, requests, exportResponse, upstream, upstreamExport, hooks, persisted } = vi.hoisted(
    () => ({
        alerts: {
            alertError: vi.fn(),
            alertNormal: vi.fn(),
            alertWait: vi.fn(),
            alertMd: vi.fn(),
            alertConfirm: vi.fn(async (_msg: string) => true),
            alertUpstreamImportReport: vi.fn(async () => true),
            alertStore: { set: vi.fn() },
        },
        flush: vi.fn(async () => ({ discarded: [] as string[] })),
        /** The upstream import routes' answers (`upstreamBackupClient.ts`), set per test. */
        upstream: {
            prepare: null as (() => Response | Promise<Response>) | null,
            commit: null as
                ((body: Record<string, unknown>, epoch: string | null) => Response | Promise<Response>) | null,
            cancel: vi.fn(() => new Response(null, { status: 204 })),
        },
        /** The upstream export routes' answers (`upstreamBackupClient.ts`), set per test. */
        upstreamExport: {
            prepare: null as ((body: Record<string, unknown>) => Response) | null,
            download: null as ((token: string | null) => Response) | null,
            cancel: vi.fn((_token: unknown) => new Response(null, { status: 204 })),
        },
        /** The restore-reload hook the upstream import registers (`beforeRestoreReload`). */
        hooks: { current: null as (() => void) | null, unregistered: 0 },
        persisted: vi.fn(),
        writer: {
            initResult: true as boolean | Error,
            /** The file names `init` was called with. */
            names: [] as string[],
            chunks: [] as Uint8Array[],
            failWriteAt: -1,
            abort: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
        },
        requests: [] as { path: string; init: RequestInit }[],
        exportResponse: { current: null as (() => Response) | null },
    }),
);

vi.mock("../alert", () => alerts);
vi.mock("../storage/resourceSync.svelte", () => ({
    flushResources: flush,
    beforeRestoreReload: (fn: () => void) => {
        hooks.current = fn;
        return () => {
            if (hooks.current === fn) {
                hooks.current = null;
            }
            hooks.unregistered += 1;
        };
    },
}));
vi.mock("../storage/selection.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../storage/selection.svelte")>()),
    persistSelection: persisted,
}));
vi.mock("src/lang", () => ({
    language: {
        partialBackupFirstConfirm: "first?",
        partialBackupSecondConfirm: "second?",
        backupDiscardedChanges: "changes replaced",
        upstreamExport: {
            includeKeys: "Include API keys?",
            preparing: "Preparing...",
            intro: "Ready.",
            counts: { characters: "Characters", chats: "Chats", assets: "Images" },
            convertedTitle: "Converted",
            excludedTitle: "Left out",
            converted: { "model-presets-flattened": "Model presets flattened" },
            excluded: { "api-keys": "API keys" },
            missingTitle: "Missing",
            downloadQuestion: "Download it now?",
            downloading: "Saving",
            success: "Saved.",
            requestFailed: (status: number) => `export failed (${status})`,
        },
        upstreamImport: {
            examples: "e.g.",
            settingOwner: "Settings",
            roles: { profile: "Profile image" },
            missingMore: (count: number) => `and ${count} more`,
            phases: {
                decode: "Reading the database",
                cold: "Reading cold storage",
                convert: "Converting",
                write: "Writing chats",
                validate: "Checking the result",
                assets: "Unpacking images",
            },
            uploading: "Uploading the backup...",
            restoring: "Restoring the backup...",
            success: "Restored. Refreshing your app.",
            changedSinceReview: (count: number) => `${count} changes since the preview; restore anyway?`,
            requestFailed: (status: number) => `failed (${status})`,
            interrupted: "connection lost; nothing replaced",
            commitInterrupted: "connection lost while restoring; it may have been restored",
            tooLarge: "too large",
        },
    },
}));
vi.mock("../globalApi.svelte", () => ({
    LocalWriter: class {
        writer = { abort: writer.abort };
        async init(name = "Binary") {
            writer.names.push(name);
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
            if ((await new Response(init.body as Blob).text()).includes("refuse-me")) {
                return Response.json({ error: "The archive is from before this version" }, { status: 400 });
            }
            return Response.json({ epoch: "epoch-1", assetsWritten: 1, assetsSkipped: 0 });
        }
        if (path === "/api/backups/import-upstream/prepare") {
            return upstream.prepare!();
        }
        if (path === "/api/backups/import-upstream/commit") {
            return upstream.commit!(JSON.parse(init.body as string), new Headers(init.headers).get("x-resource-epoch"));
        }
        if (path === "/api/backups/import-upstream/cancel") {
            return upstream.cancel();
        }
        if (path === "/api/backups/export-upstream/prepare") {
            return upstreamExport.prepare!(JSON.parse(init.body as string));
        }
        if (path.startsWith("/api/backups/export-upstream/download?")) {
            return upstreamExport.download!(new URL(path, "http://test").searchParams.get("token"));
        }
        if (path === "/api/backups/export-upstream/cancel") {
            return upstreamExport.cancel(JSON.parse(init.body as string).token);
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
    },
}));

import { setEpochMismatchListener, setResourceEpoch } from "../storage/resourceClient";
import { installFlatDatabase } from "../storage/tests/installFlatDatabase";
import {
    LoadLocalBackup,
    readFirstRecordName,
    SaveLocalBackup,
    SavePartialLocalBackup,
    SaveUpstreamLocalBackup,
    upstreamBackupFileName,
} from "./backuplocal";

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
function record(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
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
    writer.names.length = 0;
    writer.initResult = true;
    writer.failWriteAt = -1;
    upstream.prepare = null;
    upstream.commit = null;
    upstreamExport.prepare = null;
    upstreamExport.download = null;
    hooks.current = null;
    hooks.unregistered = 0;
    alerts.alertUpstreamImportReport.mockReset().mockResolvedValue(true);
    alerts.alertConfirm.mockReset().mockResolvedValue(true);
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

    it("says so in the success alert when the pre-backup flush discarded a change (its `discarded` list)", async () => {
        flush.mockResolvedValueOnce({ discarded: ["characters/alice", "chats/alice/k"] });
        exportResponse.current = streamed(
            archive({ assets: ["assets/alice.png", "assets/happy.png", "assets/group.png", "assets/icon.png"] }),
            1024,
        ).response;
        await SaveLocalBackup();
        expect(alerts.alertNormal).toHaveBeenCalledTimes(1);
        expect(alerts.alertNormal).toHaveBeenCalledWith("Success\n\nchanges replaced");
        expect(alerts.alertError).not.toHaveBeenCalled();
    });

    it("puts the discard ahead of the missing-asset report", async () => {
        flush.mockResolvedValueOnce({ discarded: ["presets/main"] });
        exportResponse.current = streamed(archive({ assets: ["assets/alice.png", "assets/icon.png"] }), 1024).response;
        await SaveLocalBackup();
        expect(alerts.alertNormal).not.toHaveBeenCalled();
        const report = alerts.alertMd.mock.calls[0][0] as string;
        expect(report.startsWith("changes replaced\n\nBackup Successful")).toBe(true);
        expect(report).toContain("**happy** (from *Alice*)");
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

describe("SaveUpstreamLocalBackup (a RisuAI-compatible backup)", () => {
    const TOKEN = "0b9c4f1e-2d3a-4b5c-8d6e-7f8091a2b3c4";
    const exportReport = {
        counts: { characters: 2, chats: 3, assets: 1 },
        converted: [{ code: "model-presets-flattened", count: 1, examples: ["Other"] }],
        excluded: [{ code: "api-keys", count: 2, examples: ["openAIKey", "proxyKey"] }],
        missing: [{ key: "assets/gone.png", owner: "Alice", role: "profile" }],
    };
    /** The download: one asset record, then `database.risudat`, in small chunks. */
    const download = () => {
        const parts = [
            record("alice.png", encoder.encode("PNG")),
            record("database.risudat", new Uint8Array(40).fill(9)),
        ];
        const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
        bytes.set(parts[0]);
        bytes.set(parts[1], parts[0].byteLength);
        return { bytes, ...streamed(bytes, 5) };
    };
    /** Answers: the keys question, then the report's download question. */
    const answer = (keys: boolean, downloadIt: boolean) =>
        alerts.alertConfirm.mockResolvedValueOnce(keys).mockResolvedValueOnce(downloadIt);

    it("asks about the keys, flushes, prepares with the tab's selection and the answer, shows the report, and streams the download to RisuAI-backup-<date>.bin", async () => {
        const order: string[] = [];
        flush.mockImplementationOnce(async () => {
            order.push("flush");
            return { discarded: [] };
        });
        const file = download();
        let prepareBody: Record<string, unknown> | null = null;
        upstreamExport.prepare = (body) => {
            order.push("prepare");
            prepareBody = body;
            return Response.json({ token: TOKEN, report: exportReport });
        };
        upstreamExport.download = (token) => {
            expect(token).toBe(TOKEN);
            return file.response();
        };
        answer(false, true);
        await SaveUpstreamLocalBackup();
        expect(order).toEqual(["flush", "prepare"]);
        expect(alerts.alertConfirm.mock.calls[0][0]).toBe("Include API keys?");
        // The tab's selection as `tabSelectionIds` resolves it (the first preset, the model preset the
        // flat install made for it, the first persona); no open chat at home, so no `selectedChat`.
        expect(prepareBody).toEqual({
            promptPresetId: "p",
            modelPresetId: "p",
            personaId: "self",
            includeSecrets: false,
        });
        const report = alerts.alertConfirm.mock.calls[1][0] as string;
        expect(report.split("\n")).toEqual([
            "Ready.",
            "",
            "Characters: 2",
            "Chats: 3",
            "Images: 1",
            "",
            "Converted",
            "- Model presets flattened: 1 (e.g. Other)",
            "",
            "Left out",
            "- API keys: 2 (e.g. openAIKey, proxyKey)",
            "",
            "Missing",
            "- Alice: Profile image (assets/gone.png)",
            "",
            "Download it now?",
        ]);
        expect(paths()).toEqual([
            "/api/backups/export-upstream/prepare",
            `/api/backups/export-upstream/download?token=${TOKEN}`,
        ]);
        expect(writer.names).toEqual([upstreamBackupFileName()]);
        expect(written()).toEqual(file.bytes);
        expect(writer.close).toHaveBeenCalledTimes(1);
        expect(alerts.alertNormal).toHaveBeenCalledWith("Saved.");
        expect(alerts.alertError).not.toHaveBeenCalled();
        expect(upstreamExport.cancel).not.toHaveBeenCalled();
    });

    it("sends a yes to the keys question as includeSecrets, and names the flush's discarded changes in the report", async () => {
        flush.mockResolvedValueOnce({ discarded: ["presets/main"] });
        let prepareBody: Record<string, unknown> | null = null;
        upstreamExport.prepare = (body) => {
            prepareBody = body;
            return Response.json({ token: TOKEN, report: { ...exportReport, missing: [] } });
        };
        upstreamExport.download = () => download().response();
        answer(true, true);
        await SaveUpstreamLocalBackup();
        expect(prepareBody).toMatchObject({ includeSecrets: true });
        expect(alerts.alertConfirm.mock.calls[1][0]).toContain("changes replaced\n\nDownload it now?");
        expect(alerts.alertNormal).toHaveBeenCalledWith("Saved.");
    });

    it("cancels the prepared export when the report is declined, without downloading", async () => {
        upstreamExport.prepare = () => Response.json({ token: TOKEN, report: exportReport });
        upstreamExport.download = () => {
            throw new Error("not downloaded");
        };
        answer(false, false);
        await SaveUpstreamLocalBackup();
        await vi.waitFor(() => expect(upstreamExport.cancel).toHaveBeenCalledWith(TOKEN));
        expect(paths()).toEqual(["/api/backups/export-upstream/prepare", "/api/backups/export-upstream/cancel"]);
        expect(writer.names).toEqual([]);
        expect(alerts.alertNormal).not.toHaveBeenCalled();
    });

    it("prepares nothing when the flush fails", async () => {
        flush.mockRejectedValueOnce(new Error("A character is still being generated"));
        alerts.alertConfirm.mockResolvedValueOnce(false);
        await SaveUpstreamLocalBackup();
        expect(requests).toEqual([]);
        expect(alerts.alertError).toHaveBeenCalledWith(expect.stringContaining("still being generated"));
    });

    it("shows the server's refusal of the prepare or the download, and writes nothing", async () => {
        upstreamExport.prepare = () =>
            Response.json({ error: "Other RisuAI-compatible backups are waiting for their download" }, { status: 409 });
        alerts.alertConfirm.mockResolvedValueOnce(false);
        await SaveUpstreamLocalBackup();
        expect(alerts.alertError).toHaveBeenLastCalledWith(
            "Other RisuAI-compatible backups are waiting for their download",
        );
        expect(alerts.alertConfirm).toHaveBeenCalledTimes(1);

        upstreamExport.prepare = () => Response.json({ token: TOKEN, report: exportReport });
        upstreamExport.download = () => Response.json({ error: "Export expired" }, { status: 404 });
        answer(false, true);
        await SaveUpstreamLocalBackup();
        expect(alerts.alertError).toHaveBeenLastCalledWith("Export expired");

        upstreamExport.prepare = () => new Response("oops", { status: 502 });
        alerts.alertConfirm.mockResolvedValueOnce(false);
        await SaveUpstreamLocalBackup();
        expect(alerts.alertError).toHaveBeenLastCalledWith("export failed (502)");
        expect(writer.names).toEqual([]);
        expect(alerts.alertNormal).not.toHaveBeenCalled();
    });

    it("aborts the writer when the download breaks", async () => {
        upstreamExport.prepare = () => Response.json({ token: TOKEN, report: exportReport });
        upstreamExport.download = () => streamed(download().bytes, 5, { failAfter: 2 }).response();
        answer(false, true);
        await SaveUpstreamLocalBackup();
        expect(writer.abort).toHaveBeenCalledTimes(1);
        expect(writer.close).not.toHaveBeenCalled();
        expect(alerts.alertError).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
        expect(alerts.alertNormal).not.toHaveBeenCalled();
    });

    it("names the file by the local date", () => {
        expect(upstreamBackupFileName(new Date(2026, 0, 5, 23, 59))).toBe("RisuAI-backup-2026-01-05");
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

    it("says so in the success alert when the pre-backup flush discarded a change", async () => {
        flush.mockResolvedValueOnce({ discarded: ["characters/alice"] });
        exportResponse.current = streamed(archive({ partial: true, assets: ["assets/alice.png"] }), 32).response;
        await SavePartialLocalBackup();
        expect(alerts.alertNormal).toHaveBeenCalledWith("Success\n\nchanges replaced");
        expect(alerts.alertMd).not.toHaveBeenCalled();
    });

    it("stops at the first declined confirmation", async () => {
        alerts.alertConfirm.mockResolvedValueOnce(false);
        await SavePartialLocalBackup();
        expect(flush).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
    });
});

/** A version-2 archive: the manifest first, then the database (bytes the mock never reads). */
const versionTwoFile = (manifest = "{}") =>
    new File(
        [record("manifest.json", encoder.encode(manifest)), record("resources.sqlite", new Uint8Array([1]))],
        "v2.bin",
    );
/** An upstream RisuAI backup: assets first, the database last. */
const upstreamFile = () =>
    new File([record("a.png", new Uint8Array([1, 2, 3])), record("database.risudat", new Uint8Array([4]))], "up.bin");
const ndjson = (lines: unknown[], status = 200) =>
    new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { status });
const report = { counts: { characters: 1 }, converted: [], excluded: [], missingAssets: [] };
const selection = { promptPresetId: "pp", modelPresetId: "mp", personaId: "pe" };
const prepared = { token: "11111111-1111-4111-8111-111111111111", report, selection };
const committed = (extra: Record<string, unknown> = {}) =>
    Response.json({ epoch: "epoch-9", assetsWritten: 1, assetsSkipped: 0, selection, ...extra });
const storedSelection = { presetId: "pp", modelPresetId: "mp", personaId: "pe" };
const paths = () => requests.map((r) => r.path);
const commitBodies = () =>
    requests
        .filter((r) => r.path === "/api/backups/import-upstream/commit")
        .map((r) => JSON.parse(r.init.body as string));

async function load(file: File) {
    const realCreate = document.createElement.bind(document);
    let input: HTMLInputElement | null = null;
    const created = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
        const el = realCreate(tag);
        if (tag === "input") {
            input = el as HTMLInputElement;
            el.click = () => {};
        }
        return el;
    });
    LoadLocalBackup();
    created.mockRestore();
    expect(input).not.toBeNull();
    expect(input!.accept).toBe(".bin");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await input!.onchange!(new Event("change"));
}

describe("readFirstRecordName", () => {
    it("reads the first record's name from the file head, null for anything that is not a record header", async () => {
        expect(await readFirstRecordName(versionTwoFile())).toBe("manifest.json");
        expect(await readFirstRecordName(upstreamFile())).toBe("a.png");
        expect(await readFirstRecordName(new File([record("x".repeat(4096), new Uint8Array(0))], "max.bin"))).toBe(
            "x".repeat(4096),
        );
        expect(await readFirstRecordName(new File([], "empty.bin"))).toBeNull();
        expect(await readFirstRecordName(new File([new Uint8Array([3, 0])], "short.bin"))).toBeNull();
        expect(await readFirstRecordName(new File([new Uint8Array([0, 0, 0, 0, 65])], "nameless.bin"))).toBeNull();
        expect(
            await readFirstRecordName(new File([record("y".repeat(4097), new Uint8Array(0))], "long.bin")),
        ).toBeNull();
        const header = new Uint8Array(4 + 2);
        new DataView(header.buffer).setUint32(0, 2, true);
        header.set([0xff, 0xfe], 4);
        expect(await readFirstRecordName(new File([header], "not-utf8.bin"))).toBeNull();
    });
});

describe("LoadLocalBackup", () => {
    it("posts a version-2 archive (manifest first) to the import route with the loaded epoch and reloads", async () => {
        const file = versionTwoFile();
        await load(file);
        expect(requests).toHaveLength(1);
        expect(requests[0].path).toBe("/api/backups/import");
        const headers = new Headers(requests[0].init.headers);
        expect(headers.get("content-type")).toBe("application/octet-stream");
        expect(headers.get("x-resource-epoch")).toBe("epoch-1");
        expect(new Uint8Array(await new Response(requests[0].init.body as Blob).arrayBuffer())).toEqual(
            new Uint8Array(await file.arrayBuffer()),
        );
        expect(alerts.alertStore.set).toHaveBeenCalledWith({ type: "wait", msg: "Success, Refreshing your app." });
        expect((location as any).reload).toHaveBeenCalled();
        expect(alerts.alertError).not.toHaveBeenCalled();
        expect(alerts.alertUpstreamImportReport).not.toHaveBeenCalled();
    });

    it("shows the server's refusal and does not reload", async () => {
        await load(versionTwoFile("refuse-me"));
        expect(alerts.alertError).toHaveBeenCalledWith("The archive is from before this version");
        expect((location as any).reload).not.toHaveBeenCalled();
    });

    it("reloads without an error when the server data changed since this tab loaded (412)", async () => {
        setResourceEpoch("stale");
        await load(versionTwoFile());
        expect(alerts.alertError).not.toHaveBeenCalled();
        expect((location as any).reload).toHaveBeenCalled();
    });
});

describe("LoadLocalBackup with a RisuAI backup (the upstream import)", () => {
    afterEach(() => {
        setEpochMismatchListener(null);
    });

    it("uploads it to the prepare route with the epoch, shows the phases and the report, commits on Restore, stores the selection, and reloads", async () => {
        const file = upstreamFile();
        upstream.prepare = () =>
            ndjson([{ phase: "decode", done: 0, total: 1 }, { phase: "cold", done: 1, total: 2 }, prepared]);
        upstream.commit = (body, epoch) => {
            expect(body).toEqual({ token: prepared.token });
            expect(epoch).toBe("epoch-1");
            expect(hooks.current).not.toBeNull();
            return committed();
        };
        await load(file);
        expect(paths()).toEqual(["/api/backups/import-upstream/prepare", "/api/backups/import-upstream/commit"]);
        const headers = new Headers(requests[0].init.headers);
        expect(headers.get("content-type")).toBe("application/octet-stream");
        expect(headers.get("x-resource-epoch")).toBe("epoch-1");
        expect(new Uint8Array(await new Response(requests[0].init.body as Blob).arrayBuffer())).toEqual(
            new Uint8Array(await file.arrayBuffer()),
        );
        expect(alerts.alertWait.mock.calls.map((call) => call[0])).toEqual([
            "Uploading the backup...",
            "Reading the database...",
            "Reading cold storage... (1/2)",
            "Restoring the backup...",
        ]);
        expect(alerts.alertUpstreamImportReport).toHaveBeenCalledTimes(1);
        expect(alerts.alertUpstreamImportReport).toHaveBeenCalledWith(report);
        expect(persisted).toHaveBeenCalledTimes(1);
        expect(persisted).toHaveBeenCalledWith(storedSelection);
        expect(hooks.current).toBeNull();
        expect(alerts.alertStore.set).toHaveBeenCalledWith({ type: "wait", msg: "Restored. Refreshing your app." });
        expect((location as any).reload).toHaveBeenCalledTimes(1);
        expect(alerts.alertError).not.toHaveBeenCalled();
    });

    it("cancels the prepared import on the server when the report is declined, without committing", async () => {
        upstream.prepare = () => ndjson([prepared]);
        upstream.commit = () => {
            throw new Error("no commit expected");
        };
        alerts.alertUpstreamImportReport.mockResolvedValueOnce(false);
        await load(upstreamFile());
        expect(paths()).toEqual(["/api/backups/import-upstream/prepare", "/api/backups/import-upstream/cancel"]);
        expect(JSON.parse(requests[1].init.body as string)).toEqual({ token: prepared.token });
        expect(persisted).not.toHaveBeenCalled();
        expect((location as any).reload).not.toHaveBeenCalled();
        expect(alerts.alertError).not.toHaveBeenCalled();
    });

    it("asks again in the report dialog with the count of changes since the preview and resends with that count (D13)", async () => {
        upstream.prepare = () => ndjson([prepared]);
        const answers = [
            Response.json({ error: "changedSinceReview", writes: 2 }, { status: 409 }),
            Response.json({ error: "changedSinceReview", writes: 3 }, { status: 409 }),
            committed(),
        ];
        upstream.commit = () => answers.shift()!;
        await load(upstreamFile());
        expect(commitBodies()).toEqual([
            { token: prepared.token },
            { token: prepared.token, acceptWrites: 2 },
            { token: prepared.token, acceptWrites: 3 },
        ]);
        expect(alerts.alertUpstreamImportReport.mock.calls).toEqual([
            [report],
            [report, { changedWrites: 2 }],
            [report, { changedWrites: 3 }],
        ]);
        expect(persisted).toHaveBeenCalledWith(storedSelection);
        expect((location as any).reload).toHaveBeenCalledTimes(1);
        expect(paths()).not.toContain("/api/backups/import-upstream/cancel");
    });

    it("cancels when the re-ask is declined, after unregistering the reload hook", async () => {
        upstream.prepare = () => ndjson([prepared]);
        upstream.commit = () => Response.json({ error: "changedSinceReview", writes: 1 }, { status: 409 });
        alerts.alertUpstreamImportReport.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await load(upstreamFile());
        expect(paths()).toEqual([
            "/api/backups/import-upstream/prepare",
            "/api/backups/import-upstream/commit",
            "/api/backups/import-upstream/cancel",
        ]);
        expect(hooks.current).toBeNull();
        expect(persisted).not.toHaveBeenCalled();
        expect((location as any).reload).not.toHaveBeenCalled();
    });

    it("shows a refusal of the backup, a failed conversion, or a malformed answer and leaves the page", async () => {
        const cases: [string, () => Response, string][] = [
            [
                "refused",
                () => Response.json({ error: "This backup was encrypted with a Risu Account" }, { status: 400 }),
                "This backup was encrypted with a Risu Account",
            ],
            ["too large", () => Response.json({ error: "File too large" }, { status: 413 }), "too large"],
            ["a refusal without a body", () => new Response("<html>", { status: 502 }), "failed (502)"],
            [
                "a failed conversion",
                () =>
                    ndjson([
                        { phase: "decode", done: 0, total: 1 },
                        { error: "The backup could not be imported: boom" },
                    ]),
                "The backup could not be imported: boom",
            ],
            [
                "a result line without a selection",
                () => ndjson([{ token: prepared.token, report }]),
                "The result line is not a prepared RisuAI backup import",
            ],
        ];
        for (const [label, answer, message] of cases) {
            requests.length = 0;
            alerts.alertError.mockClear();
            upstream.prepare = answer;
            await load(upstreamFile());
            expect(alerts.alertError, label).toHaveBeenCalledTimes(1);
            expect(alerts.alertError, label).toHaveBeenCalledWith(message);
            expect(paths(), label).toEqual(["/api/backups/import-upstream/prepare"]);
            expect(alerts.alertUpstreamImportReport, label).not.toHaveBeenCalled();
            expect((location as any).reload, label).not.toHaveBeenCalled();
        }
    });

    it("reloads without an error on a 412 at the prepare", async () => {
        upstream.prepare = () => Response.json({ error: "EpochMismatch", epoch: "epoch-2" }, { status: 412 });
        await load(upstreamFile());
        expect(alerts.alertError).not.toHaveBeenCalled();
        expect((location as any).reload).toHaveBeenCalledTimes(1);
        expect(paths()).toEqual(["/api/backups/import-upstream/prepare"]);
    });

    it("on a 412 at the commit unregisters the hook before the epoch listener runs, reloads, and cancels", async () => {
        upstream.prepare = () => ndjson([prepared]);
        upstream.commit = () => Response.json({ error: "EpochMismatch", epoch: "epoch-2" }, { status: 412 });
        const listener = vi.fn(() => {
            expect(hooks.current).toBeNull();
        });
        setEpochMismatchListener(listener);
        await load(upstreamFile());
        expect(listener).toHaveBeenCalledWith("epoch-2");
        expect(persisted).not.toHaveBeenCalled();
        expect(alerts.alertError).not.toHaveBeenCalled();
        expect((location as any).reload).toHaveBeenCalledTimes(1);
        expect(paths()).toEqual([
            "/api/backups/import-upstream/prepare",
            "/api/backups/import-upstream/commit",
            "/api/backups/import-upstream/cancel",
        ]);
    });

    it("stores the prepared selection from the reload hook when the restore is detected before the commit answers", async () => {
        upstream.prepare = () => ndjson([prepared]);
        const fromCommit = { promptPresetId: "pp", modelPresetId: "mp", personaId: "pe-commit" };
        upstream.commit = () => {
            // The socket reported the new epoch: the save adapter halts and runs the hook, synchronously.
            hooks.current!();
            return committed({ selection: fromCommit });
        };
        await load(upstreamFile());
        expect(persisted.mock.calls).toEqual([[storedSelection], [{ ...storedSelection, personaId: "pe-commit" }]]);
        expect((location as any).reload).toHaveBeenCalledTimes(1);
    });

    it("says the restore may have happened when the connection breaks during the commit, keeping the hook", async () => {
        upstream.prepare = () => ndjson([prepared]);
        upstream.commit = () => {
            throw new TypeError("Failed to fetch");
        };
        await load(upstreamFile());
        expect(alerts.alertError).toHaveBeenCalledWith("connection lost while restoring; it may have been restored");
        expect(hooks.current).not.toBeNull();
        expect((location as any).reload).not.toHaveBeenCalled();
    });

    it("shows a commit refused by the server and unregisters the hook", async () => {
        upstream.prepare = () => ndjson([prepared]);
        upstream.commit = () => Response.json({ error: "Another import is running" }, { status: 409 });
        await load(upstreamFile());
        expect(alerts.alertError).toHaveBeenCalledWith("Another import is running");
        expect(hooks.current).toBeNull();
        expect(hooks.unregistered).toBe(1);
        expect(persisted).not.toHaveBeenCalled();
        expect(paths().at(-1)).toBe("/api/backups/import-upstream/cancel");
    });

    it("says nothing was replaced when the connection breaks during the upload", async () => {
        upstream.prepare = () => {
            throw new TypeError("Failed to fetch");
        };
        await load(upstreamFile());
        expect(alerts.alertError).toHaveBeenCalledWith("connection lost; nothing replaced");
        expect(paths()).toEqual(["/api/backups/import-upstream/prepare"]);
    });
});
