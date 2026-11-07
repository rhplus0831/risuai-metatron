import type { AssetLifecycleReport } from "../../../../../shared/assetLifecycle.ts";

export type StorageUsageKind = keyof AssetLifecycleReport["usage"] | "outside" | "free";
export type StorageUsageSegment = { kind: StorageUsageKind; bytes: number; fraction: number };

/** Measured folders can span mounts, so the bar must also accommodate usage beyond disk.total. */
export function getStorageSegments(report: AssetLifecycleReport) {
    const kinds = ["assetsOnDisk", "resourcesDb", "snapshots", "thumbnails", "staging", "unmanaged"] as const;
    const segments: StorageUsageSegment[] = kinds.map((kind) => ({ kind, bytes: report.usage[kind], fraction: 0 }));
    const measured = segments.reduce((sum, segment) => sum + segment.bytes, 0);
    let denominator = measured;

    if (report.disk !== null) {
        const { total, free } = report.disk;
        const outside = Math.max(0, total - free - measured);
        if (outside > 0) segments.push({ kind: "outside", bytes: outside, fraction: 0 });
        segments.push({ kind: "free", bytes: free, fraction: 0 });
        denominator = Math.max(total, measured + free);
    }

    return {
        diskUnknown: report.disk === null,
        denominator,
        segments: segments.map((segment) => ({
            ...segment,
            fraction: denominator > 0 ? segment.bytes / denominator : 0,
        })),
    };
}

export function getStorageCards(report: AssetLifecycleReport) {
    return {
        reclaimable: report.unreferenced.pastGrace.bytes,
        snapshots: { count: report.snapshots.length, bytes: report.usage.snapshots },
        dedupeSaved: report.referenced.savings,
    };
}

/** Owner shares are logical sizes; compare each to the largest owner rather than disk usage. */
export function getTopOwners(report: AssetLifecycleReport, limit = 10) {
    const owners = [...report.owners].sort((a, b) => b.bytes - a.bytes);
    const largest = owners[0]?.bytes ?? 0;
    return {
        totalCount: owners.length,
        owners: owners.slice(0, Math.max(0, limit)).map((owner) => ({
            ...owner,
            fraction: largest > 0 ? owner.bytes / largest : 0,
        })),
    };
}
