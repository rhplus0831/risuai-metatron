/**
 * Authenticated, no-store JSON calls to GET /api/assets/{report,status}, POST /api/assets/scan, and
 * POST /api/assets/sweep. Requests never retry; HTTP failures preserve the server message in ResourceRequestError,
 * and fetch/auth failures use status 0. Sweeps always send explicit key and inlay selections.
 * GET /api/assets/preview/<hex> loads lease-free image blobs with no-store, at most four at once.
 * Releasing a preview cancels queued/in-flight work or revokes its loaded blob URL.
 */
import {
    ASSET_REPORT_PATH,
    ASSET_STATUS_PATH,
    ASSET_SCAN_PATH,
    ASSET_SWEEP_PATH,
    ASSET_PREVIEW_PATH,
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

const previewQueue: (() => void)[] = [];
let activePreviews = 0;

function drainPreviews() {
    while (activePreviews < 4 && previewQueue.length) {
        previewQueue.shift()!();
    }
}

/**
 * Loads a candidate image without leasing it. The FIFO slot covers authentication, fetch and the
 * entire body read. Release is idempotent and rejects unfinished work with AbortError; callers
 * must observe `src`'s rejection even when releasing before the request starts.
 */
export function loadAssetPreview(key: string): { src: Promise<string>; release(): void } {
    const abort = new AbortController();
    let released = false;
    let holdsSlot = false;
    let url: string | undefined;
    let resolve!: (src: string) => void;
    let reject!: (reason: unknown) => void;
    const src = new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
    });

    function freeSlot() {
        if (!holdsSlot) return;
        holdsSlot = false;
        activePreviews--;
        drainPreviews();
    }

    function start() {
        holdsSlot = true;
        activePreviews++;
        void (async () => {
            try {
                const hex = Buffer.from(key, "utf-8").toString("hex");
                const response = await authFetch(`${ASSET_PREVIEW_PATH}/${hex}`, {
                    method: "GET",
                    cache: "no-store",
                    signal: abort.signal,
                });
                if (released) return;
                if (!response.ok) {
                    throw new ResourceRequestError(response.status, `Preview request failed (${response.status})`);
                }
                const blob = await response.blob();
                // An aborted body read may still finish; never create a URL after release.
                if (released) return;
                url = URL.createObjectURL(blob);
                resolve(url);
            } catch (error) {
                reject(error);
            } finally {
                freeSlot();
            }
        })();
    }

    previewQueue.push(start);
    drainPreviews();
    return {
        src,
        release() {
            if (released) return;
            released = true;
            const queued = previewQueue.indexOf(start);
            if (queued !== -1) previewQueue.splice(queued, 1);
            abort.abort();
            reject(abort.signal.reason);
            if (url !== undefined) {
                URL.revokeObjectURL(url);
                url = undefined;
            }
            freeSlot();
        },
    };
}
