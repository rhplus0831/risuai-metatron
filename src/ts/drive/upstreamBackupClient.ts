import { alertError, alertStore, alertUpstreamImportReport, alertWait } from "../alert";
import { language } from "src/lang";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    UPSTREAM_CHANGED_SINCE_REVIEW,
    UPSTREAM_IMPORT_CANCEL_PATH,
    UPSTREAM_IMPORT_COMMIT_PATH,
    UPSTREAM_IMPORT_PHASES,
    UPSTREAM_IMPORT_PREPARE_PATH,
    type UpstreamImportCommitted,
    type UpstreamImportPhase,
    type UpstreamImportPrepared,
    type UpstreamImportProgress,
    type UpstreamImportReport,
    type UpstreamImportSelection,
} from "../../../shared/upstreamBackup.ts";
import {
    UPSTREAM_EXPORT_CANCEL_PATH,
    UPSTREAM_EXPORT_DOWNLOAD_PATH,
    UPSTREAM_EXPORT_PREPARE_PATH,
    type UpstreamExportPrepared,
    type UpstreamExportRequest,
} from "../../../shared/upstreamExportReport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { epochMismatch, getResourceEpoch, ResourceEpochMismatchError } from "../storage/resourceClient";
import { beforeRestoreReload } from "../storage/resourceSync.svelte";
import { currentChatRef } from "../storage/chatStore.svelte";
import { tabSelectionIds } from "../storage/settingsViews.svelte";
import { persistSelection } from "../storage/selection.svelte";
import { authFetch } from "../storage/serverAuth";
import {
    importOverServer,
    ServerImportAnswerError,
    ServerImportFailedError,
    ServerImportRequestError,
} from "../storage/serverImportClient";

/**
 * The upstream RisuAI `.bin` import (`docs/plan/upstream-bin-compat.md` S5; routes in
 * `server/src/routes/backupsUpstream.ts`): the server converts the backup without replacing anything,
 * the tab shows the report, and only a confirmed commit replaces every resource (a full replace with a
 * safety snapshot, U3). `LoadLocalBackup` (`backuplocal.ts`) sends here every archive whose first
 * record is not `manifest.json` (`readFirstRecordName`).
 */

function isCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isReport(value: unknown): value is UpstreamImportReport {
    return (
        isPlainObject(value) &&
        isPlainObject(value.counts) &&
        Array.isArray(value.converted) &&
        Array.isArray(value.excluded) &&
        Array.isArray(value.missingAssets)
    );
}

function isSelection(value: unknown): value is UpstreamImportSelection {
    return (
        isPlainObject(value) &&
        typeof value.promptPresetId === "string" &&
        typeof value.modelPresetId === "string" &&
        typeof value.personaId === "string"
    );
}

/**
 * Uploads `file` to the prepare route with this tab's epoch. Resolves with the prepared import's token
 * and report and selection; `onProgress` gets each progress line. Throws `ServerImportRequestError` for a refusal
 * (a 400 carries the server's reason, a Risu Account backup's among them), `ServerImportFailedError`
 * when the conversion failed, `ServerImportAnswerError` for a malformed answer, and a network failure
 * as it is.
 */
export function prepareUpstreamImport(
    file: Blob,
    onProgress?: (progress: UpstreamImportProgress) => void,
): Promise<UpstreamImportPrepared> {
    return importOverServer<UpstreamImportPrepared>(
        UPSTREAM_IMPORT_PREPARE_PATH,
        {
            body: file,
            contentType: "application/octet-stream",
            headers: { [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
        },
        (line) => {
            if ("token" in line) {
                if (typeof line.token === "string" && isReport(line.report) && isSelection(line.selection)) {
                    return { token: line.token, report: line.report, selection: line.selection };
                }
                throw new ServerImportAnswerError("The result line is not a prepared RisuAI backup import");
            }
            // A progress line: its phase is read here; the transport checks `done` and `total`.
            if (
                UPSTREAM_IMPORT_PHASES.includes(line.phase as UpstreamImportPhase) &&
                isCount(line.done) &&
                isCount(line.total)
            ) {
                onProgress?.({ phase: line.phase as UpstreamImportPhase, done: line.done, total: line.total });
            }
            return null;
        },
    );
}

/** A commit's outcome: committed, or refused because resources were written since the prepare (D13). */
export type UpstreamCommitOutcome = { committed: UpstreamImportCommitted } | { changedWrites: number };

/**
 * Commits a prepared import with this tab's epoch; `acceptWrites` confirms that many changes made
 * since the prepare. Throws `ResourceEpochMismatchError` for a 412 (after the restore listener ran),
 * `ServerImportRequestError` for any other refusal, `ServerImportAnswerError` for a malformed answer.
 * `beforeEpochMismatch` unregisters this import's selection hook before another restore is reported.
 */
export async function commitUpstreamImport(
    token: string,
    acceptWrites?: number,
    hooks: { beforeEpochMismatch?(): void } = {},
): Promise<UpstreamCommitOutcome> {
    const res = await authFetch(UPSTREAM_IMPORT_COMMIT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
        body: JSON.stringify(acceptWrites === undefined ? { token } : { token, acceptWrites }),
    });
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {}
    const answer = isPlainObject(body) ? body : {};
    if (res.status === 412 && answer.error === "EpochMismatch") {
        hooks.beforeEpochMismatch?.();
        throw epochMismatch(typeof answer.epoch === "string" ? answer.epoch : "");
    }
    if (res.status === 409 && answer.error === UPSTREAM_CHANGED_SINCE_REVIEW && isCount(answer.writes)) {
        return { changedWrites: answer.writes };
    }
    if (!res.ok) {
        throw new ServerImportRequestError(res.status, typeof answer.error === "string" ? answer.error : null);
    }
    const { selection } = answer;
    if (
        typeof answer.epoch !== "string" ||
        !isCount(answer.assetsWritten) ||
        !isCount(answer.assetsSkipped) ||
        !isSelection(selection)
    ) {
        throw new ServerImportAnswerError("The answer is not a committed RisuAI backup import");
    }
    return { committed: answer as UpstreamImportCommitted };
}

/** Removes a prepared import on the server; failures are ignored (it expires anyway). */
export async function cancelUpstreamImport(token: string): Promise<void> {
    try {
        await authFetch(UPSTREAM_IMPORT_CANCEL_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
        });
    } catch {
        // The server removes it when it expires.
    }
}

function progressText({ phase, done, total }: UpstreamImportProgress): string {
    const label = language.upstreamImport.phases[phase];
    return total > 1 ? `${label}... (${done}/${total})` : `${label}...`;
}

/** The alert text for a failed prepare or commit. */
function failureText(error: unknown): string {
    if (error instanceof ServerImportRequestError) {
        if (error.status === 413) {
            return language.upstreamImport.tooLarge;
        }
        return error.serverError ?? language.upstreamImport.requestFailed(error.status);
    }
    if (error instanceof ServerImportFailedError || error instanceof ServerImportAnswerError) {
        return error.message;
    }
    if (error instanceof TypeError) {
        return language.upstreamImport.interrupted;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * Restores an upstream RisuAI `.bin`: prepare with progress, the report (Cancel removes the prepared
 * import), then the commit with a wait state, asking again with the count while the server answers
 * that changes were saved since the preview (D13: Restore resends with that count, Cancel cancels).
 * The selection (D4) is stored synchronously when the socket detects a restore (`beforeRestoreReload`),
 * or from the commit's answer before reloading. A refusal is shown and nothing changes; a
 * prepared import that was not committed is cancelled. A 412 reloads, as the version-2 import does.
 */
export async function restoreUpstreamBackup(file: Blob): Promise<void> {
    alertWait(language.upstreamImport.uploading);
    let prepared: UpstreamImportPrepared;
    try {
        prepared = await prepareUpstreamImport(file, (progress) => alertWait(progressText(progress)));
    } catch (error) {
        if (error instanceof ServerImportRequestError && error.status === 412) {
            // The server data changed since this tab loaded it; reload and try again.
            location.reload();
            return;
        }
        console.error(error);
        alertError(failureText(error));
        return;
    }
    let consumed = false;
    let commitDispatched = false;
    let unregister: (() => void) | undefined;
    try {
        if (!(await alertUpstreamImportReport(prepared.report))) {
            return;
        }
        let acceptWrites: number | undefined;
        while (true) {
            alertWait(language.upstreamImport.restoring);
            unregister = beforeRestoreReload(() => {
                persistSelection({
                    presetId: prepared.selection.promptPresetId,
                    modelPresetId: prepared.selection.modelPresetId,
                    personaId: prepared.selection.personaId,
                });
            });
            commitDispatched = true;
            const outcome = await commitUpstreamImport(prepared.token, acceptWrites, {
                beforeEpochMismatch: unregister,
            });
            if ("committed" in outcome) {
                consumed = true;
                const { selection } = outcome.committed;
                persistSelection({
                    presetId: selection.promptPresetId,
                    modelPresetId: selection.modelPresetId,
                    personaId: selection.personaId,
                });
                unregister();
                alertStore.set({ type: "wait", msg: language.upstreamImport.success });
                location.reload();
                return;
            }
            unregister();
            if (!(await alertUpstreamImportReport(prepared.report, { changedWrites: outcome.changedWrites }))) {
                return;
            }
            acceptWrites = outcome.changedWrites;
        }
    } catch (error) {
        if (error instanceof ServerImportRequestError || error instanceof ServerImportAnswerError) {
            unregister?.();
        }
        if (error instanceof ResourceEpochMismatchError) {
            location.reload();
            return;
        }
        console.error(error);
        alertError(
            commitDispatched && error instanceof TypeError
                ? language.upstreamImport.commitInterrupted
                : failureText(error),
        );
    } finally {
        if (!consumed) {
            void cancelUpstreamImport(prepared.token);
        }
    }
}

/** A refused export prepare or download: the status and the server's `error` text, if any. */
export class UpstreamExportRequestError extends Error {
    readonly status: number;
    readonly serverError: string | null;
    constructor(status: number, serverError: string | null) {
        super(serverError ?? `The RisuAI-compatible backup failed (${status})`);
        this.name = "UpstreamExportRequestError";
        this.status = status;
        this.serverError = serverError;
    }
}

async function exportRefusal(res: Response): Promise<UpstreamExportRequestError> {
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {}
    const error = isPlainObject(body) && typeof body.error === "string" ? body.error : null;
    return new UpstreamExportRequestError(res.status, error);
}

/**
 * The export's request for this tab: its selection (`tabSelectionIds`, the records it resolves to,
 * ignoring the open chat's binding), its open chat (`currentChatRef`, whose character's `chatPage`
 * points at it), and the keys answer (D7).
 */
export function tabExportRequest(includeSecrets: boolean): UpstreamExportRequest {
    const ids = tabSelectionIds();
    const chat = currentChatRef();
    return {
        promptPresetId: ids.presetId,
        modelPresetId: ids.modelPresetId,
        personaId: ids.personaId,
        includeSecrets,
        ...(chat ? { selectedChat: { characterId: chat.chaId, chatId: chat.chatId } } : {}),
    };
}

/**
 * Asks the server to prepare a RisuAI-compatible `.bin` (`docs/plan/upstream-bin-compat.md` S7; routes in
 * `server/src/routes/backupsUpstreamExport.ts`) of one consistent copy of the store, with `request`'s
 * selection and keys choice. Resolves with the prepared export's token and report; throws
 * `UpstreamExportRequestError` for a refusal and `ServerImportAnswerError` for a malformed answer.
 */
export async function prepareUpstreamExport(request: UpstreamExportRequest): Promise<UpstreamExportPrepared> {
    const res = await authFetch(UPSTREAM_EXPORT_PREPARE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        cache: "no-store",
    });
    if (!res.ok) {
        throw await exportRefusal(res);
    }
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {}
    if (
        !isPlainObject(body) ||
        typeof body.token !== "string" ||
        !isPlainObject(body.report) ||
        !isPlainObject(body.report.counts) ||
        !Array.isArray(body.report.converted) ||
        !Array.isArray(body.report.excluded) ||
        !Array.isArray(body.report.missing)
    ) {
        throw new ServerImportAnswerError("The answer is not a prepared RisuAI-compatible backup");
    }
    return body as UpstreamExportPrepared;
}

/**
 * Starts the download of a prepared export (the token is used up): the archive's records, assets
 * first and `database.risudat` last, as the response body. Throws `UpstreamExportRequestError` for a
 * refusal (404 when the export expired).
 */
export async function downloadUpstreamExport(token: string): Promise<Response> {
    const res = await authFetch(`${UPSTREAM_EXPORT_DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`, {
        cache: "no-store",
    });
    if (!res.ok || !res.body) {
        throw await exportRefusal(res);
    }
    return res;
}

/** Removes a prepared export on the server; failures are ignored (it expires anyway). */
export async function cancelUpstreamExport(token: string): Promise<void> {
    try {
        await authFetch(UPSTREAM_EXPORT_CANCEL_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
        });
    } catch {
        // The server removes it when it expires.
    }
}
