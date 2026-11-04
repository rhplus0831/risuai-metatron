import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GenerationKind, GenerationStatus } from "../../../shared/jobs.ts";
import { type DiagnosticsRecorder, errorFields, recordSafely } from "../diagnostics/log.ts";

/**
 * Best-effort job identities, cancellation tombstones and trimmed outcomes in a separate SQLite
 * file, outside snapshots and archives. `server/src/jobs/generationJobs.ts` remains authoritative
 * in memory. Any open, read, write, sync or prune failure closes the connection for the process
 * lifetime and emits one content-free runtime event (origin generation.receipts); jobs continue
 * with memory only. An unsupported schema is left untouched and also degrades the store.
 */

/** An ended job's payload stays on disk this long, with at most this many payloads. */
export const KEPT_OUTCOME_MS = 24 * 60 * 60_000;
/** Oldest ended payloads give way first; compact identities survive payload pruning. */
export const MAX_KEPT_OUTCOMES = 500;
/** Identity and progress outlive the payload; running rows are exempt from both limits. */
export const GENERATION_RECEIPT_MS = 72 * 60 * 60_000;
/** Oldest ended rows give way first; a running row is never pruned to meet this cap. */
export const MAX_GENERATION_RECEIPTS = 10_000;
const PRUNE_BATCH = 500;
const PRUNE_ROUNDS = 4;
const SCHEMA_VERSION = 1;

/** Admission identity; clients without requestId have receipts but cannot deduplicate by request. */
export type GenerationReceiptAdmission = {
    jobId: string;
    clientId: string;
    epoch: string;
    kind: GenerationKind;
    characterId: string;
    chatId: string;
    admittedAt: number;
    requestId?: string | null;
    fingerprint?: string | null;
};

/** A current-epoch job identity outlives its status payload: null status does not mean an unknown job. */
export type GenerationReceipt = Omit<GenerationReceiptAdmission, "clientId" | "requestId" | "fingerprint"> & {
    clientId: string | null;
    requestId: string | null;
    fingerprint: string | null;
    endedAt: number | null;
    progress: unknown;
    status: GenerationStatus | null;
};

/** Synchronous, best-effort persistence: failures fall back to no-op writes and null reads, never fail a job. */
export type GenerationReceipts = {
    admit(input: GenerationReceiptAdmission): void;
    end(jobId: string, endedAt: number, status: GenerationStatus): void;
    progress(jobId: string, value: unknown): void;
    read(jobId: string): GenerationReceipt | null;
    /** Finds a current-epoch request's receipt or tombstone, even when its outcome payload was pruned. */
    readByRequest(requestId: string): GenerationRequestReceipt | null;
    /** Records an unknown request's cancellation; preserves an existing receipt or the first tombstone time. */
    cancel(requestId: string, clientId: string, at: number): void;
    sync(epoch: string): void;
    prune(now: number): void;
    degraded(): boolean;
    close(): void;
};

/** Request lookup includes private cancellation rows; job-status reads never expose those rows. */
export type GenerationRequestReceipt = { cancelled: true } | (GenerationReceipt & { cancelled: false });

type ReceiptRow = Omit<GenerationReceipt, "kind" | "progress" | "status"> & {
    kind: GenerationKind | "cancelled";
    progress: string | null;
    status: string | null;
};

/**
 * Opens the store and ends leftover running rows as shutdown once, preserving valid sequence
 * progress without resuming parts. WAL with `synchronous = NORMAL` does not promise the last
 * commits survive a power loss. Epoch sync deletes old rows; matching expired request rows are
 * removed synchronously before lookup, admission or cancellation can reuse their unique key.
 */
export function createGenerationReceipts(options: {
    file: string;
    epoch: string;
    now?: () => number;
    diagnostics?: DiagnosticsRecorder;
}): GenerationReceipts {
    const now = options.now ?? Date.now;
    let epoch = options.epoch;
    let db: DatabaseSync | null = null;
    let statements: ReturnType<typeof prepare> | null = null;
    let failed = false;
    let closed = false;

    function fail(error: unknown): void {
        if (failed) {
            return;
        }
        failed = true;
        const open = db;
        db = null;
        statements = null;
        try {
            open?.close();
        } catch {}
        recordSafely(options.diagnostics, { kind: "runtime", origin: "generation.receipts", ...errorFields(error) });
    }

    function guard<T>(fallback: T, work: () => T): T {
        if (closed || failed || !db || !statements) {
            return fallback;
        }
        try {
            return work();
        } catch (error) {
            fail(error);
            return fallback;
        }
    }

    function transaction<T>(work: () => T): T {
        const open = db!;
        open.exec("BEGIN IMMEDIATE");
        try {
            const result = work();
            open.exec("COMMIT");
            return result;
        } catch (error) {
            try {
                open.exec("ROLLBACK");
            } catch {}
            throw error;
        }
    }

    function prepare(open: DatabaseSync) {
        return {
            admit: open.prepare(
                "INSERT INTO receipts (job_id, request_id, fingerprint, client_id, epoch, kind, character_id, chat_id, admitted_at) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET " +
                    "request_id = excluded.request_id, fingerprint = excluded.fingerprint, client_id = excluded.client_id, " +
                    "epoch = excluded.epoch, kind = excluded.kind, character_id = excluded.character_id, " +
                    "chat_id = excluded.chat_id, admitted_at = excluded.admitted_at",
            ),
            end: open.prepare(
                "INSERT INTO receipts (job_id, epoch, kind, character_id, chat_id, admitted_at, ended_at, status) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET " +
                    "ended_at = excluded.ended_at, status = excluded.status",
            ),
            progress: open.prepare("UPDATE receipts SET progress = ? WHERE job_id = ? AND epoch = ?"),
            read: open.prepare(
                "SELECT job_id AS jobId, request_id AS requestId, fingerprint, client_id AS clientId, epoch, kind, " +
                    "character_id AS characterId, chat_id AS chatId, admitted_at AS admittedAt, ended_at AS endedAt, " +
                    "progress, status FROM receipts WHERE job_id = ? AND epoch = ?",
            ),
            requestKey: open.prepare("SELECT job_id AS jobId FROM receipts WHERE request_id = ? AND epoch = ?"),
            expireRequest: open.prepare("DELETE FROM receipts WHERE request_id = ? AND epoch = ? AND ended_at <= ?"),
            cancel: open.prepare(
                "INSERT INTO receipts (job_id, request_id, client_id, epoch, kind, character_id, chat_id, admitted_at, ended_at) " +
                    "VALUES (?, ?, ?, ?, 'cancelled', '', '', ?, ?)",
            ),
            sync: open.prepare("DELETE FROM receipts WHERE epoch <> ?"),
            expirePayloads: open.prepare(
                "UPDATE receipts SET status = NULL WHERE job_id IN " +
                    "(SELECT job_id FROM receipts WHERE ended_at <= ? AND status IS NOT NULL ORDER BY ended_at, job_id LIMIT ?)",
            ),
            capPayloads: open.prepare(
                "UPDATE receipts SET status = NULL WHERE job_id IN " +
                    "(SELECT job_id FROM receipts WHERE ended_at IS NOT NULL AND status IS NOT NULL ORDER BY ended_at, job_id " +
                    "LIMIT MIN(?, MAX(0, (SELECT COUNT(*) FROM receipts WHERE ended_at IS NOT NULL AND status IS NOT NULL) - ?)))",
            ),
            expireRows: open.prepare(
                "DELETE FROM receipts WHERE job_id IN " +
                    "(SELECT job_id FROM receipts WHERE ended_at <= ? ORDER BY ended_at, job_id LIMIT ?)",
            ),
            capRows: open.prepare(
                "DELETE FROM receipts WHERE job_id IN " +
                    "(SELECT job_id FROM receipts WHERE ended_at IS NOT NULL ORDER BY ended_at, job_id " +
                    "LIMIT MIN(?, MAX(0, (SELECT COUNT(*) FROM receipts) - ?)))",
            ),
        };
    }

    try {
        mkdirSync(path.dirname(options.file), { recursive: true });
        db = new DatabaseSync(options.file);
        const open = db;
        // Check before any pragma that writes: an unsupported file must stay untouched.
        const version = (open.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
        const hasTables = open.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' LIMIT 1").get();
        if (version !== SCHEMA_VERSION && (version !== 0 || hasTables)) {
            throw new Error("Unsupported generation receipt version");
        }
        open.exec("PRAGMA journal_mode = WAL");
        open.exec("PRAGMA synchronous = NORMAL");
        open.exec("PRAGMA busy_timeout = 5000");
        transaction(() => {
            if (version === 0) {
                open.exec(
                    "CREATE TABLE receipts (job_id TEXT PRIMARY KEY, request_id TEXT, fingerprint TEXT, client_id TEXT, " +
                        "epoch TEXT NOT NULL, kind TEXT NOT NULL, character_id TEXT NOT NULL, chat_id TEXT NOT NULL, " +
                        "admitted_at INTEGER NOT NULL, ended_at INTEGER, progress TEXT, status TEXT)",
                );
                open.exec("CREATE UNIQUE INDEX receipts_request ON receipts (epoch, request_id)");
                open.exec("CREATE INDEX receipts_ended ON receipts (ended_at)");
                open.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
            }
            open.prepare("DELETE FROM receipts WHERE epoch <> ?").run(epoch);
            open.prepare(
                "UPDATE receipts SET ended_at = ?, status = json_object(" +
                    "'jobId', job_id, 'kind', kind, 'characterId', character_id, 'chatId', chat_id, 'epoch', epoch, " +
                    "'state', 'ended', 'terminal', json_patch(json_object('type', 'error', 'epoch', epoch, 'status', 503, " +
                    "'reason', 'shutdown', 'message', 'The server stopped while this job ran'), " +
                    "CASE WHEN json_valid(progress) THEN CASE WHEN json_type(progress) = 'object' " +
                    "AND json_type(progress, '$.total') = 'integer' AND json_type(progress, '$.sent') = 'integer' " +
                    "AND json_extract(progress, '$.total') >= 0 AND json_extract(progress, '$.sent') >= 0 " +
                    "AND json_extract(progress, '$.sent') <= json_extract(progress, '$.total') " +
                    "THEN json_object('sequence', json_object('total', json_extract(progress, '$.total'), " +
                    "'sent', json_extract(progress, '$.sent'))) ELSE '{}' END ELSE '{}' END), 'kept', json('true')) " +
                    "WHERE ended_at IS NULL",
            ).run(now());
        });
        statements = prepare(open);
    } catch (error) {
        fail(error);
    }

    /** Deletes an expired matching row before returning its remaining key, freeing expired unique request ids. */
    function requestKey(requestId: string): string | undefined {
        statements!.expireRequest.run(requestId, epoch, now() - GENERATION_RECEIPT_MS);
        return (statements!.requestKey.get(requestId, epoch) as { jobId: string } | undefined)?.jobId;
    }

    function readRow(jobId: string): GenerationRequestReceipt | null {
        const row = statements!.read.get(jobId, epoch) as ReceiptRow | undefined;
        if (!row) {
            return null;
        }
        const age = row.endedAt === null ? null : now() - row.endedAt;
        if (age !== null && age >= GENERATION_RECEIPT_MS) {
            if (row.requestId) {
                statements!.expireRequest.run(row.requestId, epoch, now() - GENERATION_RECEIPT_MS);
            }
            return null;
        }
        if (row.kind === "cancelled") {
            return { cancelled: true };
        }
        return {
            ...row,
            kind: row.kind,
            cancelled: false,
            progress: row.progress === null ? null : JSON.parse(row.progress),
            status: age !== null && age < KEPT_OUTCOME_MS && row.status !== null ? JSON.parse(row.status) : null,
        };
    }

    return {
        admit(input) {
            guard(undefined, () => {
                if (input.epoch !== epoch) {
                    return;
                }
                const existing = input.requestId ? requestKey(input.requestId) : undefined;
                if (existing && existing !== input.jobId) {
                    return;
                }
                statements!.admit.run(
                    input.jobId,
                    input.requestId ?? null,
                    input.fingerprint ?? null,
                    input.clientId,
                    input.epoch,
                    input.kind,
                    input.characterId,
                    input.chatId,
                    input.admittedAt,
                );
            });
        },
        end(jobId, endedAt, status) {
            guard(undefined, () => {
                if (status.epoch !== epoch) {
                    return;
                }
                // A missing admission has no known owner or start time; retain the terminal's identity.
                statements!.end.run(
                    jobId,
                    status.epoch,
                    status.kind,
                    status.characterId,
                    status.chatId,
                    endedAt,
                    endedAt,
                    JSON.stringify(status),
                );
            });
        },
        progress(jobId, value) {
            guard(undefined, () => {
                statements!.progress.run(JSON.stringify(value) ?? null, jobId, epoch);
            });
        },
        read(jobId) {
            return guard(null, (): GenerationReceipt | null => {
                const row = readRow(jobId);
                if (!row || row.cancelled) return null;
                const { cancelled, ...receipt } = row;
                return receipt;
            });
        },
        readByRequest(requestId) {
            return guard(null, () => {
                const jobId = requestKey(requestId);
                return jobId ? readRow(jobId) : null;
            });
        },
        cancel(requestId, clientId, at) {
            guard(undefined, () => {
                if (requestKey(requestId)) return;
                statements!.cancel.run(`cancel:${requestId}`, requestId, clientId, epoch, at, at);
            });
        },
        sync(nextEpoch) {
            guard(undefined, () => {
                if (nextEpoch === epoch) {
                    return;
                }
                transaction(() => statements!.sync.run(nextEpoch));
                epoch = nextEpoch;
            });
        },
        prune(at) {
            guard(undefined, () => {
                for (let round = 0; round < PRUNE_ROUNDS; round++) {
                    const changed = transaction(() => {
                        const s = statements!;
                        return (
                            Number(s.expirePayloads.run(at - KEPT_OUTCOME_MS, PRUNE_BATCH).changes) +
                            Number(s.capPayloads.run(PRUNE_BATCH, MAX_KEPT_OUTCOMES).changes) +
                            Number(s.expireRows.run(at - GENERATION_RECEIPT_MS, PRUNE_BATCH).changes) +
                            Number(s.capRows.run(PRUNE_BATCH, MAX_GENERATION_RECEIPTS).changes)
                        );
                    });
                    if (changed === 0) {
                        break;
                    }
                }
            });
        },
        degraded: () => failed,
        close() {
            if (closed) {
                return;
            }
            closed = true;
            try {
                db?.close();
                db = null;
                statements = null;
            } catch (error) {
                fail(error);
            }
        },
    };
}
