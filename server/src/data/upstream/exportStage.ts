import fs from "node:fs/promises";
import type { UpstreamAssetReference } from "../../../../shared/upstreamBackup.ts";
import type { UpstreamExportReport, UpstreamExportRequest } from "../../../../shared/upstreamExportReport.ts";
import { ArchiveRejectedError, MAX_ARCHIVE_RECORD_BYTES } from "../archive.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../kinds.ts";
import { readSnapshotFile } from "../resourceStore.ts";
import { buildUpstreamDatabase } from "./exportDatabase.ts";
import { encodeUpstreamDatabase } from "./risuSave.ts";

/**
 * The upstream export's database preparation, free of worker APIs so it also runs in process.
 * Reads only the store copy, projects it with the default resource kinds, encodes it, checks the
 * archive's record-size limit, and writes `databaseFile`. A store with custom resource kinds is not
 * supported by the export. Secret values stay here; only the report and asset references return.
 */

export type UpstreamExportStageInput = {
    copyFile: string;
    databaseFile: string;
    request: UpstreamExportRequest;
    /** The exporter's clock (the trash times). */
    now: number;
};

export type UpstreamExportStageResult = {
    report: UpstreamExportReport;
    /** Every referenced asset, in reference order; the route checks the asset inventory. */
    assetKeys: UpstreamAssetReference[];
    /** The encoded database's size in bytes. */
    size: number;
};

/** Stages the database; the caller owns removal of the copy and the staging folder. */
export async function stageUpstreamExport(input: UpstreamExportStageInput): Promise<UpstreamExportStageResult> {
    const snapshot = readSnapshotFile(input.copyFile, createKindRegistry(DEFAULT_RESOURCE_KINDS));
    const { db, assetKeys, report } = buildUpstreamDatabase(snapshot.rows, snapshot, {
        ...input.request,
        now: input.now,
    });
    const bytes = encodeUpstreamDatabase(db);
    if (bytes.length > MAX_ARCHIVE_RECORD_BYTES) {
        throw new ArchiveRejectedError("The database is too large for a RisuAI backup");
    }
    await fs.writeFile(input.databaseFile, bytes);
    return { report, assetKeys, size: bytes.length };
}
