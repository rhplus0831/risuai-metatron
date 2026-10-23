import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { mkdirDurable, syncDir, syncFile } from "../data/durableWrite.ts";
import type { SnapshotManager } from "../data/snapshots.ts";
import { resolveStorageKey, storageFileExists, writeStorageFile } from "../routes/storage.ts";
import { assetVerification } from "./assetVerification.ts";

/**
 * The content-addressed asset writes of the server's file imports (CharX, the Realm download's PNG
 * reader): an asset is stored under `assets/<SHA-256 hex of its bytes>.png`, the key the client's
 * `saveAsset` gives the same bytes (its default extension; never sniffed), and skipped when that file
 * exists. Each write holds the maintenance gate.
 */

/** The key `bytes` are stored under. */
export function contentAssetKey(hashHex: string): string {
    return `assets/${hashHex}.png`;
}

/**
 * Stores `bytes` under their content key unless that file exists; null when the import stopped
 * (`signal`) before the write.
 */
export async function writeContentAsset(
    savePath: string,
    snapshots: SnapshotManager,
    bytes: Uint8Array,
    signal: AbortSignal,
): Promise<string | null> {
    const hashHex = createHash("sha256").update(bytes).digest("hex");
    const key = contentAssetKey(hashHex);
    if (!(await storageFileExists(savePath, key))) {
        if (signal.aborted) {
            return null;
        }
        const leave = snapshots.gate.enter();
        try {
            await writeStorageFile(savePath, key, bytes, hashHex);
        } finally {
            leave();
        }
    }
    return key;
}

/**
 * Moves a file the import staged under `save/.tmp` (same filesystem) into place as the asset whose
 * bytes hash to `hashHex`, unless that asset exists (the staged file is then left for the import's
 * staging cleanup); null when the import stopped (`signal`) before the move.
 */
export async function publishStagedContentAsset(
    savePath: string,
    snapshots: SnapshotManager,
    stagedPath: string,
    hashHex: string,
    signal: AbortSignal,
): Promise<string | null> {
    const key = contentAssetKey(hashHex);
    if (await storageFileExists(savePath, key)) {
        return key;
    }
    if (signal.aborted) {
        return null;
    }
    const fullPath = resolveStorageKey(savePath, key);
    if (fullPath === null) {
        throw new Error(`No storage location for ${key}`);
    }
    const stat = await fs.stat(stagedPath, { bigint: true });
    await syncFile(stagedPath);
    const leave = snapshots.gate.enter();
    try {
        await mkdirDurable(path.dirname(fullPath));
        await fs.rename(stagedPath, fullPath);
        assetVerification.recordVerification(fullPath, stat, true);
        await syncDir(path.dirname(fullPath));
    } finally {
        leave();
    }
    return key;
}
