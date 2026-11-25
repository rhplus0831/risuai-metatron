import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { mkdirDurable, syncDir, syncFile } from "../data/durableWrite.ts";
import type { SnapshotManager } from "../data/snapshots.ts";
import { claimAssetKey } from "../routes/storage.ts";
import { assetVerification, holdsVerifiedAsset } from "./assetVerification.ts";

/**
 * The content-addressed asset writes of the server's file imports (CharX, the Realm download's PNG
 * reader): an asset is stored under `assets/<SHA-256 hex of its bytes>.png`, the key the client's
 * `saveAsset` gives the same bytes (its default extension; never sniffed), and skipped when that file
 * already holds those bytes (`holdsVerifiedAsset`); an empty, truncated, or wrong file there is
 * replaced in one rename. Each reuse or write holds the maintenance gate and claims the key under its lock, renewing its lease.
 */

/** The key `bytes` are stored under. */
export function contentAssetKey(hashHex: string): string {
    return `assets/${hashHex}.png`;
}

/**
 * Stores `bytes` under their content key unless that file holds them already; null when the import
 * stopped (`signal`) before the write.
 */
export async function writeContentAsset(
    savePath: string,
    snapshots: SnapshotManager,
    bytes: Uint8Array,
    signal: AbortSignal,
): Promise<string | null> {
    const hashHex = createHash("sha256").update(bytes).digest("hex");
    const key = contentAssetKey(hashHex);
    if (signal.aborted) return null;
    const leave = snapshots.gate.enter();
    try {
        await claimAssetKey(savePath, key, {
            verify: (fullPath) => holdsVerifiedAsset(fullPath, hashHex),
            bytes,
            hashHex,
            signal,
        });
    } finally {
        leave();
    }
    return key;
}

/**
 * Moves a file the import staged under `save/.tmp` (same filesystem) into place as the asset whose
 * bytes hash to `hashHex`, replacing a file there that does not hold them, unless that asset holds
 * them already (the staged file is then left for the import's staging cleanup); null when the import
 * stopped (`signal`) before the move.
 */
export async function publishStagedContentAsset(
    savePath: string,
    snapshots: SnapshotManager,
    stagedPath: string,
    hashHex: string,
    signal: AbortSignal,
): Promise<string | null> {
    const key = contentAssetKey(hashHex);
    if (signal.aborted) return null;
    const leave = snapshots.gate.enter();
    try {
        await claimAssetKey(savePath, key, {
            signal,
            verify: (fullPath) => holdsVerifiedAsset(fullPath, hashHex),
            publish: async (fullPath) => {
                const stat = await fs.stat(stagedPath, { bigint: true });
                await syncFile(stagedPath);
                await mkdirDurable(path.dirname(fullPath));
                await fs.rename(stagedPath, fullPath);
                assetVerification.recordVerification(fullPath, stat, true);
                await syncDir(path.dirname(fullPath));
            },
        });
    } finally {
        leave();
    }
    return key;
}
