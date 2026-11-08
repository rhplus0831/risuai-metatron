/**
 * Asset-retention endpoint paths, timing/list constants, and report/sweep wire shapes shared by
 * server/src/routes/assetLifecycle.ts and its client. Reports separate disk usage, deduplicated
 * references, candidate/orphan lists, owners, and retained snapshots. Run identities carry a
 * process-local scan ID plus store epoch/write count; list totals are separate from returned lists.
 * Lease duration is one hour; grace defaults to seven days with a three-day configured minimum.
 */

/** Asset retention reports and user-started deletion; byte counts describe regular files observed during the latest run. */
export const ASSET_REPORT_PATH = "/api/assets/report";
/** Lightweight running/version status endpoint. */
export const ASSET_STATUS_PATH = "/api/assets/status";
/** User-started retention scan endpoint. */
export const ASSET_SCAN_PATH = "/api/assets/scan";
/** Explicit dry-run or deleting sweep endpoint. */
export const ASSET_SWEEP_PATH = "/api/assets/sweep";
/** Lease-free image previews of current cleanup candidates, addressed by hex UTF-8 storage key. */
export const ASSET_PREVIEW_PATH = "/api/assets/preview";
/** Duration of recent-use asset leases and inlay claims, in milliseconds. */
export const ASSET_LEASE_MS = 60 * 60 * 1000;
/** Default retention maturity delay in days. */
export const ASSET_GRACE_DEFAULT_DAYS = 7;
/** Minimum configured retention maturity delay in days. */
export const ASSET_GRACE_MIN_DAYS = 3;
/** Maximum visible candidate/orphan entries in a report list. */
export const ASSET_LIST_CAP = 2_000;

/** Typed owner categories used to attribute logical asset usage. */
export type AssetOwnerKind = "character" | "module" | "persona" | "preset" | "folder" | "settings" | "inlays";
/** One owner's logical asset bytes and count. */
export type AssetOwner = { kind: AssetOwnerKind; id: string; name: string; bytes: number; count: number };
/** Process-local scan identity and its starting resource-store version. */
export type AssetRunIdentity = { runId: number; epoch: string; writeCount: number };
/** Lightweight activity and report-version status. */
export type AssetLifecycleStatus = { running: boolean; version: number };
/** Retention scan completeness, disk usage, references, deletion candidates, owners, and snapshots. */
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
/** Deleted files/inlays, freed bytes, and per-candidate skip reasons from a sweep or dry run. */
export type AssetSweepResult = {
    deleted: string[];
    freedBytes: number;
    removedInlays: string[];
    skipped: { key: string; reason: string }[];
    skippedInlays: { id: string; reason: string }[];
};
