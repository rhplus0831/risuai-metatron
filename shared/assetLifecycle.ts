/** Asset retention reports and user-started deletion; byte counts describe regular files observed during the latest run. */
export const ASSET_REPORT_PATH = "/api/assets/report";
export const ASSET_STATUS_PATH = "/api/assets/status";
export const ASSET_SCAN_PATH = "/api/assets/scan";
export const ASSET_SWEEP_PATH = "/api/assets/sweep";
/** Lease-free image previews of current cleanup candidates, addressed by hex UTF-8 storage key. */
export const ASSET_PREVIEW_PATH = "/api/assets/preview";
export const ASSET_LEASE_MS = 60 * 60 * 1000;
export const ASSET_GRACE_DEFAULT_DAYS = 7;
export const ASSET_GRACE_MIN_DAYS = 3;
export const ASSET_LIST_CAP = 2_000;

export type AssetOwnerKind = "character" | "module" | "persona" | "preset" | "folder" | "settings" | "inlays";
export type AssetOwner = { kind: AssetOwnerKind; id: string; name: string; bytes: number; count: number };
export type AssetRunIdentity = { runId: number; epoch: string; writeCount: number };
export type AssetLifecycleStatus = { running: boolean; version: number };
export type AssetLifecycleReport = {
    /** Process-local version of the report content carried by this response. */
    version: number;
    generatedAt: number | null;
    complete: boolean;
    reasons: string[];
    running: boolean;
    disk: { free: number; total: number } | null;
    usage: {
        assetsOnDisk: number;
        resourcesDb: number;
        snapshots: number;
        thumbnails: number;
        staging: number;
        unmanaged: number;
    };
    /** Logical bytes count distinct (owner, key) pairs, plus each referenced key without a typed owner once. */
    referenced: { logicalBytes: number; dedupedBytes: number; savings: number; count: number };
    unreferenced: {
        count: number;
        bytes: number;
        pastGrace: { count: number; bytes: number };
        candidates: { key: string; bytes: number; since: number }[];
        total: number;
    };
    orphanInlays: {
        count: number;
        bytes: number;
        records: { id: string; asset: string | null; bytes: number; since: number | null }[];
        total: number;
    };
    owners: AssetOwner[];
    snapshots: {
        id: string;
        createdAt: string;
        size: number;
        pinned: boolean;
        label: string | null;
        heldBytes: number;
    }[];
};

/** Absent keys selects all past-grace candidates; absent inlays selects no records. */
export type AssetSweepRequest = { dryRun: boolean; keys?: string[]; inlays?: string[] };
export type AssetSweepResult = {
    deleted: string[];
    freedBytes: number;
    removedInlays: string[];
    skipped: { key: string; reason: string }[];
    skippedInlays: { id: string; reason: string }[];
};
