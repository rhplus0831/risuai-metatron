import {
    type BackupSnapshotInfo,
    type BatchConflict,
    RESOURCE_EPOCH_HEADER,
    type ResourceBatchResult,
    type ResourceReadKindsResult,
    type ResourceReadRefsResult,
    type ResourceRevisionListing,
} from "../../../shared/resources.ts";
import { authFetch, getNodeServerProxyAuth } from "./serverAuth";

/**
 * Transport for the server resource routes (`/api/resources`, `/api/backups`). Every mutation sends
 * the database epoch the client loaded (`setResourceEpoch`); the server answers 412 when a restore
 * replaced the data since, which surfaces as `ResourceEpochMismatchError`.
 */

/** A write named a stale revision; `conflicts` has the current revision of each record, chat, or chat order. */
export class ResourceConflictError extends Error {
    readonly conflicts: BatchConflict[];
    constructor(conflicts: BatchConflict[]) {
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
let mutationAdmission: (() => boolean) | null = null;

/**
 * Registers the check every mutation runs right before it goes out, after authentication and
 * signing (the save adapter's: saving has not halted for a restore). A refused mutation is not sent
 * and fails as a request that did not reach the server.
 */
export function setMutationAdmission(check: (() => boolean) | null) {
    mutationAdmission = check;
}

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

/**
 * The error for a request that named another epoch, after the halt-and-reload listener ran (other
 * transports to the server, such as the generation jobs, report a 412 through it too).
 */
export function epochMismatch(epoch: string): ResourceEpochMismatchError {
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
        response = await authFetch(
            path,
            { ...init, headers, cache: "no-store" },
            init.mutation
                ? {
                      beforeDispatch: () => {
                          if (mutationAdmission && !mutationAdmission()) {
                              throw new Error("Saving stopped: the server data was restored");
                          }
                      },
                  }
                : {},
        );
    } catch (error) {
        throw new ResourceRequestError(0, error instanceof Error ? error.message : String(error));
    }
    if (response.ok) {
        return response;
    }
    let body: {
        error?: string;
        epoch?: string;
        conflicts?: BatchConflict[];
        revision?: string | null;
        reason?: "generating";
    } = {};
    try {
        body = await response.json();
    } catch {}
    if (response.status === 412 && body.error === "EpochMismatch") {
        throw epochMismatch(body.epoch ?? "");
    }
    if (response.status === 409) {
        throw new ResourceConflictError(
            Array.isArray(body.conflicts)
                ? body.conflicts
                : [
                      {
                          kind: "",
                          id: "",
                          revision: body.revision ?? null,
                          ...(body.reason === "generating" ? { reason: body.reason } : {}),
                      },
                  ],
        );
    }
    throw new ResourceRequestError(response.status, body.error ?? `Request failed (${response.status})`);
}

async function sendJson<T>(path: string, init: RequestInit & { mutation?: boolean } = {}): Promise<T> {
    return (await (await send(path, init)).json()) as T;
}

const jsonHeaders = { "content-type": "application/json" };

/**
 * Every record of `kinds`; with `chats`, also every chat and chat order (the boot read); with
 * `chatSummaries` (not together with `chats`), every chat's summary and chat order instead.
 */
export async function readKinds(
    kinds: readonly string[],
    options: { chats?: boolean; chatSummaries?: boolean } = {},
): Promise<ResourceReadKindsResult> {
    const query =
        `kinds=${kinds.map(encodeURIComponent).join(",")}` +
        `${options.chats ? "&chats=1" : ""}${options.chatSummaries ? "&chatSummaries=1" : ""}`;
    return checkedEpoch(await sendJson<ResourceReadKindsResult>(`/api/resources?${query}`));
}

/**
 * Named records, chats (`chats`), characters' whole chat lists with their order (`chatCollections`),
 * and characters' chat summaries with their order (`chatSummaryCollections`).
 */
export async function readRefs(
    refs: readonly { kind: string; id: string }[],
    options: {
        chats?: readonly { characterId: string; id: string }[];
        chatCollections?: readonly string[];
        chatSummaryCollections?: readonly string[];
    } = {},
): Promise<ResourceReadRefsResult> {
    return checkedEpoch(
        await sendJson<ResourceReadRefsResult>("/api/resources/read", {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ refs, ...options }),
        }),
    );
}

/** Every record's, chat's, and chat order's revision on the server (no data): the live-update reconcile. */
export async function listRevisions(): Promise<ResourceRevisionListing> {
    return checkedEpoch(await sendJson<ResourceRevisionListing>("/api/resources/revisions"));
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

/** The single-record routes answer a conflict as `{ revision, reason? }`; name the record in it. */
function singleConflict(error: unknown, kind: string, id: string): unknown {
    if (error instanceof ResourceConflictError) {
        const first = error.conflicts[0];
        const reason = first && "reason" in first ? first.reason : undefined;
        return new ResourceConflictError([
            { kind, id, revision: first?.revision ?? null, ...(reason === "generating" ? { reason } : {}) },
        ]);
    }
    return error;
}

/**
 * One credential write of the write-only `llmSecrets` record (Phase 5 slice 7b): a set (`value`;
 * empty clears) or a preset copy, on the record's `baseRevision`. Answers the new revision and the
 * masked record; a stale revision throws `ResourceConflictError`.
 */
export async function sendSecretRequest(
    request: { kind: "put"; path: string; value: string } | { kind: "copy"; from: string; to: string },
    baseRevision: string,
): Promise<{ revision: string; data: unknown }> {
    const init =
        request.kind === "put"
            ? {
                  method: "PUT",
                  headers: jsonHeaders,
                  body: JSON.stringify({ value: request.value, baseRevision }),
                  mutation: true,
              }
            : {
                  method: "POST",
                  headers: jsonHeaders,
                  body: JSON.stringify({ from: request.from, to: request.to, baseRevision }),
                  mutation: true,
              };
    const path = request.kind === "put" ? `/api/llm-secrets/${request.path}` : "/api/llm-secrets/modelPresets/copy";
    try {
        return checkedEpoch(await sendJson<{ epoch?: string; revision: string; data: unknown }>(path, init));
    } catch (error) {
        throw singleConflict(error, "llmSecrets", "main");
    }
}

/** Sends a batch whose JSON body the caller already built (`{"ops":[...],"chats":[...],"chatOrders":[...]}`). */
export function applyBatchText(body: string): Promise<ResourceBatchResult> {
    return sendJson("/api/resources/batch", { method: "POST", headers: jsonHeaders, body, mutation: true });
}

/** The body budget of a `keepalive` request (browsers refuse larger bodies; 64 KiB less headroom). */
export const UNLOAD_BODY_LIMIT = 60 * 1024;
/** Signed tokens live five minutes; one older than this is not used for an unload request. */
const UNLOAD_AUTH_MAX_AGE_MS = 4 * 60 * 1000;
const UNLOAD_AUTH_REFRESH_MS = 60 * 1000;
let unloadAuth: { token: string; at: number } | null = null;
let unloadAuthPending = false;

/**
 * Keeps a signed `risu-auth` token ready for `sendBatchOnUnload`: signing is asynchronous and a
 * `pagehide` handler cannot wait for it. Refreshes at most once a minute.
 */
export function prepareUnloadAuth() {
    if (unloadAuthPending || (unloadAuth && Date.now() - unloadAuth.at < UNLOAD_AUTH_REFRESH_MS)) {
        return;
    }
    unloadAuthPending = true;
    const at = Date.now();
    // Never lets a failure reach the chat write that asked for it.
    Promise.resolve()
        .then(() => getNodeServerProxyAuth())
        .then((token) => {
            unloadAuth = { token, at };
        })
        .catch(() => {})
        .finally(() => {
            unloadAuthPending = false;
        });
}

/**
 * Sends a batch as the page goes away: one `keepalive` request, nothing awaited, every error
 * swallowed. Returns whether it was sent (not whether it landed). When the page survives to see the
 * answer (back-forward cache), `onResult` gets the batch result, or null when the request failed or
 * was refused; it is called at most once and its own errors are swallowed too.
 */
export function sendBatchOnUnload(body: string, onResult?: (result: ResourceBatchResult | null) => void): boolean {
    if (!unloadAuth || Date.now() - unloadAuth.at > UNLOAD_AUTH_MAX_AGE_MS || currentEpoch === "") {
        return false;
    }
    try {
        fetch("/api/resources/batch", {
            method: "POST",
            keepalive: true,
            cache: "no-store",
            headers: {
                "content-type": "application/json",
                "risu-auth": unloadAuth.token,
                [RESOURCE_EPOCH_HEADER]: currentEpoch,
            },
            body,
        })
            .then((response) => (response.ok ? (response.json() as Promise<ResourceBatchResult>) : null))
            .catch(() => null)
            .then((result) => {
                try {
                    onResult?.(result);
                } catch {}
            });
        return true;
    } catch {
        return false;
    }
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
