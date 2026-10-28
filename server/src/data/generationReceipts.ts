import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GenerationKind, GenerationStatus } from "../../../shared/jobs.ts";
import { type DiagnosticsRecorder, errorFields, recordSafely } from "../diagnostics/log.ts";

/** An ended job's payload stays on disk this long, with at most this many payloads. */
export const KEPT_OUTCOME_MS = 24 * 60 * 60_000;
export const MAX_KEPT_OUTCOMES = 500;
/** Identity and progress outlive the payload; running rows are exempt from both limits. */
export const GENERATION_RECEIPT_MS = 72 * 60 * 60_000;
export const MAX_GENERATION_RECEIPTS = 10_000;
const PRUNE_BATCH = 500;
const PRUNE_ROUNDS = 4;
const SCHEMA_VERSION = 1;

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

export type GenerationReceipt = Omit<GenerationReceiptAdmission, "clientId" | "requestId" | "fingerprint"> & {
    clientId: string | null;
    requestId: string | null;
    fingerprint: string | null;
    endedAt: number | null;
    progress: unknown;
    status: GenerationStatus | null;
};

export type GenerationReceipts = {
    admit(input: GenerationReceiptAdmission): void;
    end(jobId: string, endedAt: number, status: GenerationStatus): void;
    progress(jobId: string, value: unknown): void;
    read(jobId: string): GenerationReceipt | null;
    sync(epoch: string): void;
    prune(now: number): void;
    degraded(): boolean;
    close(): void;
};

type ReceiptRow = Omit<GenerationReceipt, "progress" | "status"> & {
    progress: string | null;
    status: string | null;
};

/**
 * Job receipts in their own SQLite file, outside snapshots and archives. Memory answers first;
 * any store failure permanently disables this connection without affecting the jobs. WAL with
 * `synchronous = NORMAL` does not promise the last commits will survive a power loss.
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
                    "'state', 'ended', 'terminal', json_object('type', 'error', 'epoch', epoch, 'status', 503, " +
                    "'reason', 'shutdown', 'message', 'The server stopped while this job ran'), 'kept', json('true')) " +
                    "WHERE ended_at IS NULL",
            ).run(now());
        });
        statements = prepare(open);
    } catch (error) {
        fail(error);
    }

    return {
        admit(input) {
            guard(undefined, () => {
                if (input.epoch !== epoch) {
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
                const row = statements!.read.get(jobId, epoch) as ReceiptRow | undefined;
                if (!row) {
                    return null;
                }
                const age = row.endedAt === null ? null : now() - row.endedAt;
                if (age !== null && age >= GENERATION_RECEIPT_MS) {
                    return null;
                }
                return {
                    ...row,
                    progress: row.progress === null ? null : JSON.parse(row.progress),
                    status:
                        age !== null && age < KEPT_OUTCOME_MS && row.status !== null ? JSON.parse(row.status) : null,
                };
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
