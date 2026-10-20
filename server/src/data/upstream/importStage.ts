import fs from "node:fs/promises";
import path from "node:path";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import {
    addUpstreamReportEntry,
    createUpstreamImportReport,
    type UpstreamImportPhase,
    type UpstreamImportReport,
    type UpstreamImportSelection,
} from "../../../../shared/upstreamBackup.ts";
import { ArchiveRejectedError, copyRecordToFile, readRecord } from "../archive.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../kinds.ts";
import { createResourceStore, type ResourceStore } from "../resourceStore.ts";
import { type ColdRecordResult, readColdEntry, type UpstreamArchivePlan } from "./archive.ts";
import { convertUpstreamDatabase } from "./importDatabase.ts";
import { decodeUpstreamDatabase } from "./risuSave.ts";

/**
 * The upstream import's prepare work (`docs/plan/upstream-bin-compat.md` S5), the body of the import
 * worker (`importWorker.ts`) and free of any worker API, so it also runs in process. It reads the
 * classified archive (S2's plan, made by the route), decodes the database (S1), reads the cold-storage
 * payloads, converts (S3, S4), writes a fresh staged store in S4's order, copies it with `backupTo` into
 * one self-contained `resources.sqlite`, validates that file with `readSnapshot` (the result is dropped:
 * the commit validates again), and extracts every archive asset into the staging folder, so a commit
 * only links. It writes only into `staging`; it never opens the live store.
 */

/** Chats per `applyChanges` call while the staged store is written. */
const CHAT_BATCH = 200;

/** The staged store's file in the staging folder, what the commit validates and installs. */
export const STAGED_DATABASE_FILE = "resources.sqlite";
/** The folder of the extracted assets in the staging folder; asset `i` of the plan is `assets/<i>`. */
export const STAGED_ASSETS_DIR = "assets";

export type UpstreamStageInput = {
    /** The spooled `.bin`. */
    archiveFile: string;
    /** The import's own staging folder under `save/.tmp`. */
    staging: string;
    plan: UpstreamArchivePlan;
    /** Cap of the decoded MessagePack (D1, `RISU_MAX_UPSTREAM_DB_BYTES`). */
    maxDecodedBytes: number;
    /** Cap of one cold-storage payload (`MAX_COLD_RECORD_BYTES` by default). */
    maxColdRecordBytes?: number;
    /** The `creation_date` of a character without one. */
    now: number;
};

export type UpstreamStageResult = {
    report: UpstreamImportReport;
    selection: UpstreamImportSelection;
};

export type UpstreamStageProgress = (phase: UpstreamImportPhase, done: number, total: number) => void;

/**
 * The largest `database.risudat` record read for a decoded cap: gzip adds a header, a trailer, and
 * 5 bytes per stored block of 64 KiB, so a valid record can be a little larger than its decoded
 * MessagePack. The codec enforces the decoded cap itself; this bound only keeps a crafted record
 * from being read into one huge buffer.
 */
export function maxEncodedDatabaseBytes(maxDecodedBytes: number): number {
    return maxDecodedBytes + Math.ceil(maxDecodedBytes / 1024) + 64 * 1024;
}

/**
 * Runs the prepare work. Throws `UpstreamFormatError` (the database), `ArchiveRejectedError` (a
 * database record over the encoded bound), `ResourceValidationError` (the conversion or the staged
 * file refused), or a file error; the caller removes the staging folder.
 */
export async function stageUpstreamImport(
    input: UpstreamStageInput,
    onProgress: UpstreamStageProgress = () => {},
): Promise<UpstreamStageResult> {
    const { plan, staging } = input;
    const handle = await fs.open(input.archiveFile, "r");
    try {
        onProgress("decode", 0, 1);
        if (plan.database.length > maxEncodedDatabaseBytes(input.maxDecodedBytes)) {
            throw new ArchiveRejectedError(
                `The backup's database (database.risudat) is ${plan.database.length} bytes, over this server's limit`,
            );
        }
        let db: unknown = decodeUpstreamDatabase(await readRecord(handle, plan.database), {
            maxDecodedBytes: input.maxDecodedBytes,
        });
        onProgress("decode", 1, 1);

        const cold = new Map<string, ColdRecordResult>();
        onProgress("cold", 0, plan.cold.length);
        for (const [index, entry] of plan.cold.entries()) {
            cold.set(entry.key, await readColdEntry(handle, entry, input.maxColdRecordBytes));
            onProgress("cold", index + 1, plan.cold.length);
        }

        onProgress("convert", 0, 1);
        const report = createUpstreamImportReport();
        for (const ignored of plan.ignored) {
            addUpstreamReportEntry(report.excluded, "asset-name-invalid", ignored.name);
        }
        const converted = convertUpstreamDatabase(db, {
            report,
            cold,
            assetKeys: new Set(plan.assets.map((asset) => asset.key)),
            now: input.now,
        });
        // The decoded database and the payloads are not needed past the conversion.
        db = null;
        cold.clear();
        onProgress("convert", 1, 1);

        await writeStagedStore(staging, converted, onProgress);

        const assetsDir = path.join(staging, STAGED_ASSETS_DIR);
        await fs.mkdir(assetsDir, { recursive: true });
        onProgress("assets", 0, plan.assets.length);
        for (const [index, asset] of plan.assets.entries()) {
            await copyRecordToFile(handle, asset.record, path.join(assetsDir, String(index)));
            onProgress("assets", index + 1, plan.assets.length);
        }
        return { report: converted.report, selection: converted.selection };
    } finally {
        await handle.close().catch(() => {});
    }
}

/**
 * Writes the conversion into a fresh store at `staging/build.sqlite` in S4's order (the singletons at
 * their current revision or created, the characters, then the chats in batches in array order),
 * copies it to `staging/resources.sqlite` with `backupTo`, validates the copy, and removes the build.
 */
async function writeStagedStore(
    staging: string,
    converted: ReturnType<typeof convertUpstreamDatabase>,
    onProgress: UpstreamStageProgress,
): Promise<void> {
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const buildFile = path.join(staging, "build.sqlite");
    const stagedFile = path.join(staging, STAGED_DATABASE_FILE);
    let store: ResourceStore | null = null;
    try {
        store = createResourceStore({ file: buildFile, kinds });
        const { chats } = converted;
        onProgress("write", 0, chats.length);
        for (const resource of converted.resources) {
            const kind = kinds.get(resource.kind);
            if (!kind) {
                throw new Error(`The converter returned an unknown kind: ${resource.kind}`);
            }
            store.put(kind, resource.id, resource.data, store.get(kind, resource.id)?.revision ?? null);
        }
        const characters = kinds.get(RESOURCE_KIND.characters)!;
        for (const character of converted.characters) {
            store.put(characters, character.id, character.data, null);
        }
        for (let start = 0; start < chats.length; start += CHAT_BATCH) {
            const batch = chats.slice(start, start + CHAT_BATCH);
            store.applyChanges({ chats: batch });
            onProgress("write", start + batch.length, chats.length);
        }
        onProgress("validate", 0, 1);
        await store.backupTo(stagedFile);
        store.readSnapshot(stagedFile);
        onProgress("validate", 1, 1);
    } finally {
        store?.close();
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            await fs.rm(buildFile + suffix, { force: true }).catch(() => {});
        }
    }
}
