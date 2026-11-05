/**
 * Authenticated, no-store JSON calls to GET /api/assets/{report,status}, POST /api/assets/scan, and
 * POST /api/assets/sweep. Requests never retry; HTTP failures preserve the server message in ResourceRequestError,
 * and fetch/auth failures use status 0. Sweeps always send explicit key and inlay selections.
 */
import {
    ASSET_REPORT_PATH,
    ASSET_STATUS_PATH,
    ASSET_SCAN_PATH,
    ASSET_SWEEP_PATH,
    type AssetLifecycleReport,
    type AssetLifecycleStatus,
    type AssetSweepResult,
} from "../../../shared/assetLifecycle.ts";
import { ResourceRequestError } from "./resourceClient";
import { authFetch } from "./serverAuth";

async function request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
        response = await authFetch(path, {
            ...init,
            cache: "no-store",
            headers: { "content-type": "application/json" },
        });
    } catch (error) {
        throw new ResourceRequestError(0, error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ResourceRequestError(response.status, body?.error ?? `Request failed (${response.status})`);
    }
    return response.json();
}

/** Reads the latest retention report without starting a scan. */
export function readStorageReport(): Promise<AssetLifecycleReport> {
    return request(ASSET_REPORT_PATH, { method: "GET" });
}

/** Reads run state and report version without transferring candidate lists. */
export function readStorageStatus(): Promise<AssetLifecycleStatus> {
    return request(ASSET_STATUS_PATH, { method: "GET" });
}

/** Starts a scan and returns its initial report. */
export function startStorageScan(): Promise<AssetLifecycleReport> {
    return request(ASSET_SCAN_PATH, { method: "POST" });
}

/** Deletes only the selected past-grace assets and orphan inlay records. */
export function sweepAssets(selection: { keys: string[]; inlays: string[] }): Promise<AssetSweepResult> {
    return request(ASSET_SWEEP_PATH, {
        method: "POST",
        body: JSON.stringify({ dryRun: false, keys: selection.keys, inlays: selection.inlays }),
    });
}
