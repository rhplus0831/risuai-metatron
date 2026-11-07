import { describe, expect, it } from "vitest";
import type { AssetLifecycleReport } from "../../../../../shared/assetLifecycle.ts";
import { getStorageCards, getStorageSegments, getTopOwners } from "./storageUsage";

function report(overrides: Partial<AssetLifecycleReport> = {}): AssetLifecycleReport {
    return {
        version: 1,
        generatedAt: 1_700_000_000_000,
        complete: true,
        reasons: [],
        running: false,
        disk: { total: 1000, free: 250 },
        // The six measured kinds total 350 bytes.
        usage: { assetsOnDisk: 120, resourcesDb: 80, snapshots: 60, thumbnails: 40, staging: 30, unmanaged: 20 },
        referenced: { logicalBytes: 180, dedupedBytes: 100, savings: 80, count: 4 },
        unreferenced: { count: 5, bytes: 90, pastGrace: { count: 3, bytes: 45 }, candidates: [], total: 0 },
        orphanInlays: { count: 0, bytes: 0, records: [], total: 0 },
        owners: [],
        snapshots: [],
        ...overrides,
    };
}

describe("getStorageSegments", () => {
    const measuredOver = (denominator: number) =>
        [
            { kind: "assetsOnDisk", bytes: 120 },
            { kind: "resourcesDb", bytes: 80 },
            { kind: "snapshots", bytes: 60 },
            { kind: "thumbnails", bytes: 40 },
            { kind: "staging", bytes: 30 },
            { kind: "unmanaged", bytes: 20 },
        ].map((segment) => ({ ...segment, fraction: segment.bytes / denominator }));

    it("by default places only the six measured kinds over their sum and reports free space beside the bar", () => {
        expect(getStorageSegments(report())).toEqual({
            diskUnknown: false,
            measured: 350,
            free: 250,
            denominator: 350,
            segments: measuredOver(350),
        });
    });

    it("places six measured kinds, positive outside usage, and free space over the known disk total", () => {
        expect(getStorageSegments(report(), { wholeDisk: true })).toEqual({
            diskUnknown: false,
            measured: 350,
            free: 250,
            denominator: 1000,
            segments: [
                ...measuredOver(1000),
                { kind: "outside", bytes: 400, fraction: 0.4 },
                { kind: "free", bytes: 250, fraction: 0.25 },
            ],
        });
    });

    it("uses only the six measured kinds and their sum when disk size is unknown, even for the whole disk", () => {
        const expected = {
            diskUnknown: true,
            measured: 350,
            free: null,
            denominator: 350,
            segments: measuredOver(350),
        };
        expect(getStorageSegments(report({ disk: null }))).toEqual(expected);
        expect(getStorageSegments(report({ disk: null }), { wholeDisk: true })).toEqual(expected);
    });

    it("omits a negative outside gap and fits measured usage plus free space into the whole-disk bar", () => {
        expect(getStorageSegments(report({ disk: { total: 400, free: 250 } }), { wholeDisk: true })).toEqual({
            diskUnknown: false,
            measured: 350,
            free: 250,
            denominator: 600,
            segments: [...measuredOver(600), { kind: "free", bytes: 250, fraction: 250 / 600 }],
        });
    });

    it("returns zero fractions rather than NaN for zero usage with or without a disk", () => {
        const empty = report({
            usage: { assetsOnDisk: 0, resourcesDb: 0, snapshots: 0, thumbnails: 0, staging: 0, unmanaged: 0 },
        });
        const measured = [
            { kind: "assetsOnDisk", bytes: 0, fraction: 0 },
            { kind: "resourcesDb", bytes: 0, fraction: 0 },
            { kind: "snapshots", bytes: 0, fraction: 0 },
            { kind: "thumbnails", bytes: 0, fraction: 0 },
            { kind: "staging", bytes: 0, fraction: 0 },
            { kind: "unmanaged", bytes: 0, fraction: 0 },
        ];
        const zeroDisk = { ...empty, disk: { total: 0, free: 0 } };
        expect(getStorageSegments(zeroDisk, { wholeDisk: true })).toEqual({
            diskUnknown: false,
            measured: 0,
            free: 0,
            denominator: 0,
            segments: [...measured, { kind: "free", bytes: 0, fraction: 0 }],
        });
        expect(getStorageSegments(zeroDisk)).toEqual({
            diskUnknown: false,
            measured: 0,
            free: 0,
            denominator: 0,
            segments: measured,
        });
        expect(getStorageSegments({ ...empty, disk: null })).toEqual({
            diskUnknown: true,
            measured: 0,
            free: null,
            denominator: 0,
            segments: measured,
        });
    });
});

describe("getStorageCards", () => {
    it("uses past-grace bytes, report snapshot count and disk bytes, and referenced savings", () => {
        expect(
            getStorageCards(
                report({
                    snapshots: [
                        {
                            id: "a",
                            createdAt: "2023-11-13T12:00:00Z",
                            size: 81,
                            heldBytes: 42,
                            pinned: false,
                            label: null,
                        },
                        {
                            id: "b",
                            createdAt: "2023-11-14T12:00:00Z",
                            size: 91,
                            heldBytes: 24,
                            pinned: false,
                            label: null,
                        },
                    ],
                }),
            ),
        ).toEqual({ reclaimable: 45, snapshots: { count: 2, bytes: 60 }, dedupeSaved: 80 });
    });
});

describe("getTopOwners", () => {
    it("returns the ten largest owners or the requested full list, scaled to the largest owner", () => {
        const input = report({
            owners: [3, 12, 1, 7, 11, 2, 9, 6, 10, 4, 8, 5].map((rank) => ({
                kind: rank % 2 ? "character" : "module",
                id: `owner-${rank}`,
                name: `Owner ${rank}`,
                count: rank + 1,
                bytes: rank * 10,
            })),
        });
        const expected = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((rank) => ({
            kind: rank % 2 ? "character" : "module",
            id: `owner-${rank}`,
            name: `Owner ${rank}`,
            count: rank + 1,
            bytes: rank * 10,
            fraction: rank / 12,
        }));
        expect(getTopOwners(input)).toEqual({ totalCount: 12, owners: expected.slice(0, 10) });
        expect(getTopOwners(input, 12)).toEqual({ totalCount: 12, owners: expected });
    });
});
