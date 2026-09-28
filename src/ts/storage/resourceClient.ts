import {
    type BackupSnapshotInfo,
    RESOURCE_EPOCH_HEADER,
    type ResourceBatchResult,
    type ResourceConflict,
    type ResourceReadKindsResult,
    type ResourceReadRefsResult,
} from "../../../shared/resources.ts";
import { authFetch } from "./nodeStorage";

/**
 * Transport for the server resource routes (`/api/resources`, `/api/backups`). Every mutation sends
 * the database epoch the client loaded (`setResourceEpoch`); the server answers 412 when a restore
 * replaced the data since, which surfaces as `ResourceEpochMismatchError`.
 */

/** A write named a stale revision; `conflicts` has the current revision of each record. */
export class ResourceConflictError extends Error {
    readonly conflicts: ResourceConflict[];
    constructor(conflicts: ResourceConflict[]) {
        super("Revision conflict");
        this.name = "ResourceConflictError";
        this.conflicts = conflicts;
    }
}

/** The server database was restored or imported since this client loaded it. */
export class ResourceEpochMismatchError extends Error {
    readonly epoch: string;
    constructor(epoch: string) {
        super("The server data was replaced by a restore");
        this.name = "ResourceEpochMismatchError";
        this.epoch = epoch;
    }
}

/** Any other failed request; `status` 0 means the request did not reach the server. */
export class ResourceRequestError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = "ResourceRequestError";
        this.status = status;
    }
}

let currentEpoch = "";
let epochMismatchListener: ((epoch: string) => void) | null = null;

export function setResourceEpoch(epoch: string) {
    currentEpoch = epoch;
}

export function getResourceEpoch() {
    return currentEpoch;
}

/**
 * Registers the one handler for a replaced server database (the save adapter's halt-and-reload):
 * it runs before a `ResourceEpochMismatchError` is thrown, for a 412 on any mutation and for a
 * read that answered with another epoch than the loaded one.
 */
export function setEpochMismatchListener(listener: ((epoch: string) => void) | null) {
    epochMismatchListener = listener;
}

function epochMismatch(epoch: string): ResourceEpochMismatchError {
    try {
        epochMismatchListener?.(epoch);
    } catch (error) {
        console.error("[Resources]", error);
    }
    return new ResourceEpochMismatchError(epoch);
}

/** Reads after boot must come from the database the client loaded; another epoch means a restore happened. */
function checkedEpoch<T extends { epoch?: string }>(result: T): T {
    if (currentEpoch !== "" && typeof result.epoch === "string" && result.epoch !== currentEpoch) {
        throw epochMismatch(result.epoch);
    }
    return result;
}

async function send(path: string, init: RequestInit & { mutation?: boolean } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.mutation) {
        headers.set(RESOURCE_EPOCH_HEADER, currentEpoch);
    }
    let response: Response;
    try {
        response = await authFetch(path, { ...init, headers, cache: "no-store" });
    } catch (error) {
        throw new ResourceRequestError(0, error instanceof Error ? error.message : String(error));
    }
    if (response.ok) {
        return response;
    }
    let body: { error?: string; epoch?: string; conflicts?: ResourceConflict[]; revision?: string | null } = {};
    try {
        body = await response.json();
    } catch {}
    if (response.status === 412 && body.error === "EpochMismatch") {
        throw epochMismatch(body.epoch ?? "");
    }
    if (response.status === 409) {
        throw new ResourceConflictError(
            Array.isArray(body.conflicts) ? body.conflicts : [{ kind: "", id: "", revision: body.revision ?? null }],
        );
    }
    throw new ResourceRequestError(response.status, body.error ?? `Request failed (${response.status})`);
}

async function sendJson<T>(path: string, init: RequestInit & { mutation?: boolean } = {}): Promise<T> {
    return (await (await send(path, init)).json()) as T;
}

const jsonHeaders = { "content-type": "application/json" };

export async function readKinds(kinds: readonly string[]): Promise<ResourceReadKindsResult> {
    return checkedEpoch(
        await sendJson<ResourceReadKindsResult>(`/api/resources?kinds=${kinds.map(encodeURIComponent).join(",")}`),
    );
}

export async function readRefs(refs: readonly { kind: string; id: string }[]): Promise<ResourceReadRefsResult> {
    return checkedEpoch(
        await sendJson<ResourceReadRefsResult>("/api/resources/read", {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ refs }),
        }),
    );
}

function resourcePath(kind: string, id: string) {
    return `/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

/** One record, or null when it does not exist. */
export async function getResource<T>(kind: string, id: string): Promise<{ revision: string; data: T } | null> {
    try {
        return checkedEpoch(await sendJson<{ epoch?: string; revision: string; data: T }>(resourcePath(kind, id)));
    } catch (error) {
        if (error instanceof ResourceRequestError && error.status === 404) {
            return null;
        }
        throw error;
    }
}

/** Creates (`baseRevision` null) or updates one record. A stale revision throws `ResourceConflictError`. */
export async function putResource<T>(
    kind: string,
    id: string,
    data: T,
    baseRevision: string | null,
): Promise<{ revision: string; data: T }> {
    try {
        return await sendJson(resourcePath(kind, id), {
            method: "PUT",
            headers: jsonHeaders,
            body: JSON.stringify({ baseRevision, data }),
            mutation: true,
        });
    } catch (error) {
        throw singleConflict(error, kind, id);
    }
}

export async function deleteResource(kind: string, id: string, baseRevision: string): Promise<void> {
    try {
        await send(`${resourcePath(kind, id)}?baseRevision=${encodeURIComponent(baseRevision)}`, {
            method: "DELETE",
            mutation: true,
        });
    } catch (error) {
        throw singleConflict(error, kind, id);
    }
}

/** The single-record routes answer a conflict as `{ revision }`; name the record in it. */
function singleConflict(error: unknown, kind: string, id: string): unknown {
    if (error instanceof ResourceConflictError) {
        return new ResourceConflictError([{ kind, id, revision: error.conflicts[0]?.revision ?? null }]);
    }
    return error;
}

/** Sends a batch whose JSON body the caller already built (`{"ops":[...]}`). */
export function applyBatchText(body: string): Promise<ResourceBatchResult> {
    return sendJson("/api/resources/batch", { method: "POST", headers: jsonHeaders, body, mutation: true });
}

export async function listBackups(): Promise<BackupSnapshotInfo[]> {
    return (await sendJson<{ items: BackupSnapshotInfo[] }>("/api/backups")).items;
}

export async function restoreBackup(id: string): Promise<string> {
    return (
        await sendJson<{ epoch: string }>(`/api/backups/${encodeURIComponent(id)}/restore`, {
            method: "POST",
            mutation: true,
        })
    ).epoch;
}

/** Starts a backup archive download: every asset, or only `partial` asset keys. */
export function exportBackup(partial?: string[]): Promise<Response> {
    return send("/api/backups/export", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(partial ? { partial } : {}),
    });
}

/** Uploads a backup archive; the server restores it and answers with the new epoch. */
export function importBackup(file: Blob): Promise<{ epoch: string; assetsWritten: number; assetsSkipped: number }> {
    return sendJson("/api/backups/import", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
        mutation: true,
    });
}
