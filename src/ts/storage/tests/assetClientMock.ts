import { vi } from "vitest";

type AssetClient = typeof import("../assetClient");

/** Complete I/O double; saves upload by default, preserving callers' existing write assertions. */
export function createAssetClientMock(overrides: Partial<AssetClient> = {}): AssetClient {
    const defaults = {
        writeAsset: vi.fn<AssetClient["writeAsset"]>(),
        readAsset: vi.fn<AssetClient["readAsset"]>(),
        writeAssets: vi.fn<AssetClient["writeAssets"]>(),
        readAssets: vi.fn<AssetClient["readAssets"]>(),
        missingAssets: vi.fn<AssetClient["missingAssets"]>(async (names) => new Set(names)),
        assetContentHash: vi.fn<AssetClient["assetContentHash"]>(
            (key) => /^assets\/(?:inlay_)?([0-9a-f]{64})\.[A-Za-z0-9]+$/.exec(key)?.[1] ?? null,
        ),
        throwIfAborted: vi.fn<AssetClient["throwIfAborted"]>((signal) => signal?.throwIfAborted()),
        MAX_ASSET_ATTEMPTS: 8,
        BASE_RETRY_DELAY_MS: 1000,
        MAX_BACKOFF_MS: 30000,
        MAX_RETRY_AFTER_MS: 60000,
        ASSET_BATCH_CLIENT_BYTES: 64 * 1024 * 1024,
        ASSET_BATCH_CLIENT_RECORDS: 500,
        MISSING_CHECK_DEADLINE_MS: 20_000,
    } satisfies AssetClient;
    return { ...defaults, ...overrides };
}
