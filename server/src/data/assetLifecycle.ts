import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { ASSET_GRACE_DEFAULT_DAYS, ASSET_LEASE_MS, ASSET_LIST_CAP } from "../../../shared/assetLifecycle.ts";
import type {
    AssetLifecycleReport,
    AssetOwnerKind,
    AssetRunIdentity,
    AssetSweepRequest,
    AssetSweepResult,
} from "../../../shared/assetLifecycle.ts";
import { CHECKPOINT_MEMORY_FIELD } from "../../../shared/chatCheckpoints.ts";
import type { BackupSnapshotInfo } from "../../../shared/resources.ts";
import { MEMORY_RECORD_KINDS } from "../../../shared/structuredMemory.ts";
import { UPSTREAM_EXPORT_STAGED_TTL_MS } from "../../../shared/upstreamExportReport.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { assetLeased, withAssetLocks } from "../http/assetLeases.ts";
import { assetVerification } from "../http/assetVerification.ts";
import { resolveStorageKey } from "../routes/storage.ts";
import type { ResourceKind } from "./kinds.ts";
import { freeBytes, type DiskStatfs } from "../http/diskSpace.ts";
import { listAssetFiles } from "../routes/backups.ts";
import { createExportHolds, type ExportHolds } from "../routes/backupsUpstreamExport.ts";
import { mkdirDurableSync } from "./durableWrite.ts";
import type { ResourceStore } from "./resourceStore.ts";
import type { SnapshotManager } from "./snapshots.ts";
import { collectUpstreamAssetReferences } from "./upstream/assetReferences.ts";

/**
 * Retention graph and user-started fail-closed sweep: live resource text, chat metadata/messages, all memory records, pages
 * named by checkpoints (including memory manifests/chunks), every retained snapshot, export holds,
 * recent-use leases, and young files. Inlay records retain their assets even when no root's text names their ids.
 *
 * The recognizer walks decoded JSON strings and keys, or scalar text. It keeps bounded UTF-8 tails
 * after assets/, and after valid UTF-8 prefixes of either-case hex /api/asset/ and /sw/img/ URLs.
 * A disk name is retained by any tail starting with that name. Inlay ids retain their decoded spelling.
 * SQL content filters admit assets/, /api/asset/, /sw/img/, {{inlay, and (for JSON) any \\u or \\/
 * escape. This is a superset: an escaped spelling of a needle must contain one of those escapes.
 * Only selected JSON is parsed; structural fields/manifests and memory chunk envelopes are unfiltered.
 *
 * Missing live tables, invalid snapshot schema groups, unreadable roots or selected JSON, missing or
 * malformed memory pages, unsettled exports, an epoch change, and aborts make a run incomplete.
 * The separate WAL ledger holds unreferenced(key,since,bytes), orphanInlays(id,since), snapshotIndexed,
 * snapshotRefs, snapshotInlays, and bounded runs. Only complete runs update since stamps: insert once,
 * update bytes, and remove stamps for referenced or vanished records/files. Snapshot indexes persist
 * independently of completeness; failed indexes are retried, and rotated snapshots lose their index.
 * The in-memory { runId, epoch, writeCount } records the process-local identity at run start.
 *
 * Each small keyset chunk reads committed state on a per-run read-only connection, without a
 * transaction across an await or an exclusive lock across the mark. A reference moved from an unread
 * row to an already-read row can be missed for this run and acquire a since stamp; a later complete
 * run seeing it removes that stamp. The starting writeCount remains the baseline for a deletion recheck.
 */

const DAY_MS = 86_400_000;
const NEEDLES = ["assets/", "/api/asset/", "/sw/img/", "{{inlay"];
const JSON_NEEDLES = [...NEEDLES, "\\u", "\\/"];
const MEMORY_TABLES = [
    "memory_pages",
    "memory_events",
    "memory_threads",
    "memory_runs",
    "memory_staged_pages",
    "memory_staged_events",
    "memory_staged_threads",
    "memory_staged_runs",
];
const CHECKPOINT_TABLES = ["chatCheckpoints", "checkpointPages", "checkpointPageRefs"];

export type AssetReferenceSink = { tail(value: string): void; inlay(id: string): void };

/** Cut before an invalid or incomplete UTF-8 code point, retaining the valid prefix. */
function utf8Prefix(bytes: Uint8Array): string {
    let end = 0;
    while (end < bytes.length) {
        const first = bytes[end];
        const width =
            first < 0x80
                ? 1
                : first >= 0xc2 && first <= 0xdf
                  ? 2
                  : first >= 0xe0 && first <= 0xef
                    ? 3
                    : first >= 0xf0 && first <= 0xf4
                      ? 4
                      : 0;
        if (!width || end + width > bytes.length) {
            break;
        }
        const second = bytes[end + 1];
        if (
            width > 1 &&
            (second < 0x80 ||
                second > 0xbf ||
                (first === 0xe0 && second < 0xa0) ||
                (first === 0xed && second > 0x9f) ||
                (first === 0xf0 && second < 0x90) ||
                (first === 0xf4 && second > 0x8f))
        ) {
            break;
        }
        let valid = true;
        for (let i = 2; i < width; i++) {
            if (bytes[end + i] < 0x80 || bytes[end + i] > 0xbf) {
                valid = false;
            }
        }
        if (!valid) {
            break;
        }
        end += width;
    }
    return Buffer.from(bytes.subarray(0, end)).toString("utf8");
}

/** Pure retention recognizer over decoded text; tails use the storage codec's UTF-8 identity. */
export function recognize(value: string, sink: AssetReferenceSink): void {
    let from = 0;
    for (;;) {
        const index = value.indexOf("assets/", from);
        if (index < 0) {
            break;
        }
        from = index + 7;
        sink.tail(utf8Prefix(Buffer.from(value.slice(from, from + 255), "utf8").subarray(0, 255)));
    }
    for (const prefix of ["/api/asset/", "/sw/img/"]) {
        let from = 0;
        for (;;) {
            const index = value.indexOf(prefix, from);
            if (index < 0) {
                break;
            }
            from = index + prefix.length;
            // Bound before matching/allocating, even when untrusted text contains a huge hex run.
            const hex = /^[0-9a-fA-F]*/.exec(value.slice(from, from + 2 * (255 + 7)))![0];
            const decoded = utf8Prefix(Buffer.from(hex.slice(0, hex.length - (hex.length % 2)), "hex"));
            if (decoded.startsWith("assets/")) {
                sink.tail(decoded.slice(7));
            }
        }
    }
    for (const match of value.matchAll(/{{(?:inlay|inlayed|inlayeddata)::(.+?)}}/g)) {
        sink.inlay(match[1]);
    }
}

/** Pure JSON walk, including object keys; iterative so deeply nested data does not exhaust the stack. */
export function walkJson(value: unknown, sink: AssetReferenceSink): void {
    const pending = [value];
    while (pending.length) {
        const item = pending.pop();
        if (typeof item === "string") {
            recognize(item, sink);
        } else if (Array.isArray(item)) {
            for (const child of item) {
                pending.push(child);
            }
        } else if (item !== null && typeof item === "object") {
            for (const [key, child] of Object.entries(item)) {
                recognize(key, sink);
                pending.push(child);
            }
        }
    }
}

function contentFilter(column: string, json = true): string {
    return (json ? JSON_NEEDLES : NEEDLES).map((needle) => `instr(${column}, '${needle}') > 0`).join(" OR ");
}
function selectedJson(text: string): boolean {
    return JSON_NEEDLES.some((needle) => text.includes(needle));
}
function matches(tails: readonly string[], name: string): boolean {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (tails[mid] < name) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return tails[lo]?.startsWith(name) ?? false;
}
function normalizedKey(key: string): string {
    return Buffer.from(key, "utf8").toString("utf8");
}

type Owner = { kind: AssetOwnerKind; id: string; name: string; keys: Set<string> };
type Roots = {
    tails: Set<string>;
    ids: Set<string>;
    owners: Map<string, Owner>;
    inlays: Map<string, string | null>;
    inlayCharacters: Map<string, Set<string>>;
};
function roots(): Roots {
    return { tails: new Set(), ids: new Set(), owners: new Map(), inlays: new Map(), inlayCharacters: new Map() };
}
function ownerFor(root: Roots, kind: AssetOwnerKind, id: string, name = ""): Owner {
    const identity = JSON.stringify([kind, id]);
    let owner = root.owners.get(identity);
    if (!owner) {
        owner = { kind, id, name, keys: new Set() };
        root.owners.set(identity, owner);
    }
    if (name) {
        owner.name = name;
    }
    return owner;
}
function attribute(root: Roots, kind: string, id: string, value: unknown) {
    const add = (ownerKind: AssetOwnerKind, item: unknown, index: number, field: string, recordId?: string) => {
        if (!isPlainObject(item)) {
            return;
        }
        const owner = ownerFor(
            root,
            ownerKind,
            recordId ?? (typeof item.id === "string" ? item.id : `${ownerKind}:${index}`),
            typeof item.name === "string" ? item.name : "",
        );
        const db = field === "customBackground" ? { customBackground: item.customBackground } : { [field]: [item] };
        for (const ref of collectUpstreamAssetReferences(db)) {
            owner.keys.add(normalizedKey(ref.key));
        }
    };
    if (kind === "characters") {
        add("character", value, 0, "characters", id);
    } else if (kind === "ui") {
        add("settings", value, 0, "customBackground", id);
    } else {
        const mapping: Record<string, [AssetOwnerKind, string]> = {
            modules: ["module", "modules"],
            personas: ["persona", "personas"],
            presets: ["preset", "botPresets"],
            characterOrder: ["folder", "characterOrder"],
        };
        const entry = mapping[kind];
        if (entry && Array.isArray(value)) {
            value.forEach((item, index) => add(entry[0], item, index, entry[1]));
        }
    }
}

export type AssetScanMetrics = {
    tables: Record<string, { read: number; selected: number }>;
    liveScanMs: number;
    snapshotIndexMs: number;
    longestChunkMs: number;
    totalMs: number;
};
export class AssetSweepConflict extends Error {}
export type AssetSweepMetrics = {
    longestSynchronousTurnMs: number;
    remarks: { kind: "full" | "narrowed"; ms: number }[];
    batches: number;
    totalMs: number;
};
export type AssetLifecycleOptions = {
    /** Full retained rechecks are the default; a lower row cutoff permits comparison with JS narrowing. */
    fullRemarkMaxRows?: number;
    /** May lower the production maximum of 50, never raise it. */
    sweepBatchSize?: number;
    wallClock?: () => number;
    monoClock?: () => number;
    clockOffsetMs?: number;
    graceDays?: number;
    graceMs?: number;
    firstScanDelayMs?: number;
    intervalMs?: number;
    statfs?: DiskStatfs;
    chunkSize?: number;
    /** Awaited after each synchronous chunk; the signal also interrupts a held hook on shutdown. */
    betweenChunks?: (signal: AbortSignal) => void | Promise<void>;
    exportWaitMs?: number;
};
export type AssetLifecycle = ReturnType<typeof createAssetLifecycle>;

export function createAssetLifecycle(
    options: AssetLifecycleOptions & {
        savePath: string;
        store: ResourceStore;
        snapshots: SnapshotManager;
        exportHolds?: ExportHolds;
        thumbnails?: { removeKey(key: string): Promise<unknown> };
        inlaysKind?: ResourceKind;
    },
) {
    const { savePath, store, snapshots } = options;
    const holds = options.exportHolds ?? createExportHolds();
    const offset = options.clockOffsetMs ?? 0;
    const wallNow = () => (options.wallClock ?? Date.now)() + offset;
    const monoNow = () => (options.monoClock ?? (() => performance.now()))() + offset;
    const grace = options.graceMs ?? (options.graceDays ?? ASSET_GRACE_DEFAULT_DAYS) * DAY_MS;
    const chunkSize = options.chunkSize ?? 200;
    const sweepBatchSize = options.sweepBatchSize ?? 50;
    if (!Number.isSafeInteger(sweepBatchSize) || sweepBatchSize < 1 || sweepBatchSize > 50)
        throw new Error("Invalid asset sweep batch size");
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
        throw new Error("Invalid asset scan chunk size");
    }
    const dbPath = path.join(savePath, "data", "resources.sqlite");
    mkdirDurableSync(path.dirname(dbPath));
    const ledger = new DatabaseSync(path.join(savePath, "data", "asset-lifecycle.sqlite"));
    ledger.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS unreferenced (key TEXT PRIMARY KEY, since REAL NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS orphanInlays (id TEXT PRIMARY KEY, since REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshotIndexed (snapshotId TEXT PRIMARY KEY, indexedAt REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshotRefs (snapshotId TEXT NOT NULL, tail TEXT NOT NULL, PRIMARY KEY (snapshotId, tail));
        CREATE TABLE IF NOT EXISTS snapshotInlays (snapshotId TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (snapshotId, id));
        CREATE TABLE IF NOT EXISTS runs (startedAt REAL NOT NULL, complete INTEGER NOT NULL, reasons TEXT NOT NULL, counts TEXT NOT NULL);`);
    const selectSnapshotReferences = ledger.prepare("SELECT tail FROM snapshotRefs WHERE snapshotId = ?");
    const selectSnapshotInlays = ledger.prepare("SELECT id FROM snapshotInlays WHERE snapshotId = ?");
    const selectSnapshotIndex = ledger.prepare("SELECT 1 FROM snapshotIndexed WHERE snapshotId = ?");
    const selectSnapshotIndexes = ledger.prepare("SELECT snapshotId FROM snapshotIndexed");
    const insertSnapshotReference = ledger.prepare("INSERT INTO snapshotRefs (snapshotId, tail) VALUES (?, ?)");
    const insertSnapshotInlay = ledger.prepare("INSERT INTO snapshotInlays (snapshotId, id) VALUES (?, ?)");
    const insertSnapshotIndex = ledger.prepare("INSERT INTO snapshotIndexed (snapshotId, indexedAt) VALUES (?, ?)");
    const selectUnreferencedKeys = ledger.prepare("SELECT key FROM unreferenced");
    const selectUnreferencedSince = ledger.prepare("SELECT key, since FROM unreferenced");
    const insertUnreferenced = ledger.prepare(
        "INSERT INTO unreferenced (key, since, bytes) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes",
    );
    const deleteUnreferenced = ledger.prepare("DELETE FROM unreferenced WHERE key = ?");
    const selectOrphanIds = ledger.prepare("SELECT id FROM orphanInlays");
    const selectOrphanSince = ledger.prepare("SELECT id, since FROM orphanInlays");
    const insertOrphanInlay = ledger.prepare("INSERT OR IGNORE INTO orphanInlays (id, since) VALUES (?, ?)");
    const deleteOrphanInlay = ledger.prepare("DELETE FROM orphanInlays WHERE id = ?");
    const insertRun = ledger.prepare("INSERT INTO runs (startedAt, complete, reasons, counts) VALUES (?, ?, ?, ?)");
    const deleteSnapshotIndex = [
        ledger.prepare("DELETE FROM snapshotRefs WHERE snapshotId = ?"),
        ledger.prepare("DELETE FROM snapshotInlays WHERE snapshotId = ?"),
        ledger.prepare("DELETE FROM snapshotIndexed WHERE snapshotId = ?"),
    ];
    const pruneRuns = ledger.prepare(
        "DELETE FROM runs WHERE rowid NOT IN (SELECT rowid FROM runs ORDER BY rowid DESC LIMIT 100)",
    );
    let latest: AssetLifecycleReport = {
        generatedAt: null,
        complete: false,
        reasons: [],
        running: false,
        disk: null,
        usage: { assetsOnDisk: 0, resourcesDb: 0, snapshots: 0, thumbnails: 0, staging: 0, unmanaged: 0 },
        referenced: { logicalBytes: 0, dedupedBytes: 0, savings: 0, count: 0 },
        unreferenced: { count: 0, bytes: 0, pastGrace: { count: 0, bytes: 0 }, candidates: [], total: 0 },
        orphanInlays: { count: 0, bytes: 0, records: [], total: 0 },
        owners: [],
        snapshots: [],
    };
    let identity: AssetRunIdentity | null = null;
    let runId = 0;
    let active: Promise<AssetLifecycleReport> | null = null;
    let controller: AbortController | null = null;
    let closed = false;
    let closing: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let started = false;
    let metrics: AssetScanMetrics | null = null;
    let sweepMetrics: AssetSweepMetrics | null = null;
    let sweepActive: Promise<AssetSweepResult> | null = null;
    let completedMono = 0;
    let liveSelectedRows = 0;
    let candidates = new Map<string, { key: string; bytes: number; since: number }>();
    let orphanCandidates = new Map<string, { since: number; bytes: number }>();

    function transaction(body: () => void) {
        ledger.exec("BEGIN");
        try {
            body();
            ledger.exec("COMMIT");
        } catch (error) {
            ledger.exec("ROLLBACK");
            throw error;
        }
    }
    const unregisterRemoved = snapshots.onRemoved((id) => {
        if (closed) return;
        transaction(() => {
            for (const statement of deleteSnapshotIndex) statement.run(id);
        });
    });
    async function pause(signal: AbortSignal) {
        signal.throwIfAborted();
        await yieldImmediate(undefined, { signal });
        signal.throwIfAborted();
        if (options.betweenChunks) {
            await new Promise<void>((resolve, reject) => {
                const abort = () => reject(signal.reason);
                signal.addEventListener("abort", abort, { once: true });
                Promise.resolve()
                    .then(() => {
                        signal.throwIfAborted();
                        return options.betweenChunks!(signal);
                    })
                    .then(resolve, reject)
                    .finally(() => signal.removeEventListener("abort", abort));
            });
            signal.throwIfAborted();
        }
    }

    async function readRoots(
        file: string,
        snapshotId: string | null,
        signal: AbortSignal,
        reasons: string[],
        stats: AssetScanMetrics,
    ): Promise<Roots> {
        const root = roots();
        const label = snapshotId ? `snapshot ${snapshotId}` : "live";
        signal.throwIfAborted();
        const db = new DatabaseSync(file, { readOnly: true });
        try {
            const tables = new Set(
                db
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                    .all()
                    .map((row) => String(row.name)),
            );
            const required = snapshotId
                ? ["resources", "chats", "messages"]
                : ["resources", "chats", "messages", ...CHECKPOINT_TABLES, ...MEMORY_TABLES];
            for (const table of required) {
                if (!tables.has(table)) {
                    reasons.push(`${label}: missing table ${table}`);
                }
            }
            const checkpointCount = CHECKPOINT_TABLES.filter((table) => tables.has(table)).length;
            if (snapshotId && checkpointCount > 0 && checkpointCount < 3) {
                reasons.push(`${label}: partial checkpoint table group`);
            }
            const fail = (table: string, row: unknown, error: unknown) =>
                reasons.push(`${label}: ${table} row ${String(row)}: ${String(error)}`);
            const sink = (characterId?: string): AssetReferenceSink => ({
                tail: (tail) => root.tails.add(tail),
                inlay: (id) => {
                    root.ids.add(id);
                    if (characterId) {
                        const characters = root.inlayCharacters.get(id) ?? new Set<string>();
                        characters.add(characterId);
                        root.inlayCharacters.set(id, characters);
                    }
                },
            });
            const parse = (table: string, row: unknown, text: unknown): unknown => {
                if (typeof text !== "string") {
                    throw new Error(`${table} row ${String(row)}: expected JSON text`);
                }
                return JSON.parse(text);
            };
            // Bound the rowid window BEFORE applying the content predicate. LIMIT on selected rows
            // alone could synchronously inspect millions of unselected messages in one turn.
            async function rows(
                table: string,
                columns: string,
                filter: string,
                visit: (row: Record<string, unknown>) => void,
            ) {
                if (!tables.has(table)) {
                    return;
                }
                const counts = (stats.tables[`${label}.${table}`] ??= { read: 0, selected: 0 });
                try {
                    const window = db.prepare(
                        `SELECT rowid AS scanRowid FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
                    );
                    const query = db.prepare(
                        `SELECT rowid AS scanRowid, ${columns} FROM ${table} WHERE rowid > ? AND rowid <= ? AND (${filter}) ORDER BY rowid`,
                    );
                    let after = 0;
                    for (;;) {
                        signal.throwIfAborted();
                        const start = monoNow();
                        const ids = window.all(after, chunkSize);
                        if (!ids.length) {
                            break;
                        }
                        const end = Number(ids[ids.length - 1].scanRowid);
                        const selected = query.all(after, end);
                        counts.read += ids.length;
                        counts.selected += selected.length;
                        for (const row of selected) {
                            try {
                                visit(row);
                            } catch (error) {
                                fail(table, row.scanRowid, error);
                            }
                        }
                        after = end;
                        stats.longestChunkMs = Math.max(stats.longestChunkMs, monoNow() - start);
                        await pause(signal);
                    }
                } catch (error) {
                    signal.throwIfAborted();
                    fail(table, "read", error);
                }
            }
            const chatCharacters = new Map<number, string>();
            await rows("chats", "seq, characterId", "1", (row) =>
                chatCharacters.set(Number(row.seq), String(row.characterId)),
            );
            await rows("resources", "kind, id, data", `kind = 'inlays' OR ${contentFilter("data")}`, (row) => {
                const value = parse("resources", row.scanRowid, row.data);
                walkJson(value, sink());
                if (!snapshotId) {
                    attribute(root, String(row.kind), String(row.id), value);
                    if (row.kind === "inlays") {
                        root.inlays.set(
                            String(row.id),
                            isPlainObject(value) && typeof value.asset === "string" ? normalizedKey(value.asset) : null,
                        );
                    }
                }
            });
            await rows("chats", "seq, meta", contentFilter("meta"), (row) =>
                walkJson(parse("chats", row.scanRowid, row.meta), sink(chatCharacters.get(Number(row.seq)))),
            );
            await rows("messages", "chatSeq, data", contentFilter("data"), (row) =>
                walkJson(parse("messages", row.scanRowid, row.data), sink(chatCharacters.get(Number(row.chatSeq)))),
            );
            for (const table of MEMORY_TABLES) {
                const titled = !table.endsWith("runs");
                await rows(
                    table,
                    titled ? "title, data" : "data",
                    contentFilter("data") + (titled ? ` OR ${contentFilter("title", false)}` : ""),
                    (row) => {
                        if (titled) {
                            recognize(String(row.title), sink());
                        }
                        if (selectedJson(String(row.data))) {
                            walkJson(parse(table, row.scanRowid, row.data), sink());
                        }
                    },
                );
            }
            if (checkpointCount === 3) {
                const named = new Set<string>();
                const manifests = new Set<string>();
                const chunks = new Set<string>();
                await rows("checkpointPageRefs", "hash", "1", (row) => named.add(String(row.hash)));
                await rows("chatCheckpoints", "fields", "1", (row) => {
                    const fields = parse("chatCheckpoints.fields", row.scanRowid, row.fields);
                    if (!isPlainObject(fields)) {
                        throw new Error("Invalid checkpoint fields");
                    }
                    if (Object.hasOwn(fields, CHECKPOINT_MEMORY_FIELD)) {
                        const hash = fields[CHECKPOINT_MEMORY_FIELD];
                        if (typeof hash !== "string") {
                            throw new Error("Invalid memory manifest hash");
                        }
                        manifests.add(hash);
                    }
                });
                await rows(
                    "chatCheckpoints",
                    "name, preview",
                    `${contentFilter("name", false)} OR ${contentFilter("preview")}`,
                    (row) => {
                        recognize(String(row.name), sink());
                        if (selectedJson(String(row.preview))) {
                            walkJson(parse("chatCheckpoints.preview", row.scanRowid, row.preview), sink());
                        }
                    },
                );
                // Hash lookup is structural: manifests must be read even when no text needle occurs.
                const page = db.prepare("SELECT text FROM checkpointPages WHERE hash = ?");
                const inspectPages = async (hashes: Set<string>, manifest: boolean) => {
                    const list = [...hashes];
                    for (let offset = 0; offset < list.length; offset += chunkSize) {
                        signal.throwIfAborted();
                        const start = monoNow();
                        for (const hash of list.slice(offset, offset + chunkSize)) {
                            try {
                                const row = page.get(hash);
                                const count = (stats.tables[`${label}.checkpointPages`] ??= { read: 0, selected: 0 });
                                count.read++;
                                count.selected++;
                                if (!row) {
                                    throw new Error("Missing checkpoint memory page");
                                }
                                const value = parse("checkpointPages", hash, row.text);
                                if (manifest) {
                                    if (
                                        !isPlainObject(value) ||
                                        !MEMORY_RECORD_KINDS.every(
                                            (kind) =>
                                                Array.isArray(value[kind]) &&
                                                value[kind].every((item: unknown) => typeof item === "string"),
                                        )
                                    ) {
                                        throw new Error("Invalid memory manifest");
                                    }
                                    for (const kind of MEMORY_RECORD_KINDS) {
                                        for (const chunk of value[kind] as string[]) {
                                            chunks.add(chunk);
                                        }
                                    }
                                    walkJson(value, sink());
                                } else {
                                    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
                                        throw new Error("Invalid memory chunk");
                                    }
                                    for (const text of value as string[]) {
                                        if (selectedJson(text)) {
                                            walkJson(parse("checkpoint memory chunk", hash, text), sink());
                                        }
                                    }
                                }
                            } catch (error) {
                                fail("checkpointPages", hash, error);
                            }
                        }
                        stats.longestChunkMs = Math.max(stats.longestChunkMs, monoNow() - start);
                        await pause(signal);
                    }
                };
                await inspectPages(manifests, true);
                await inspectPages(chunks, false);
                // Ordinary pages are content-filtered only after memory pages have been classified.
                const ordinary = [...named].filter((hash) => !manifests.has(hash) && !chunks.has(hash));
                const ordinaryPage = db.prepare(
                    `SELECT text, (${contentFilter("text")}) AS selected FROM checkpointPages WHERE hash = ?`,
                );
                const counts = (stats.tables[`${label}.checkpointPages`] ??= { read: 0, selected: 0 });
                for (let offset = 0; offset < ordinary.length; offset += chunkSize) {
                    signal.throwIfAborted();
                    const start = monoNow();
                    for (const hash of ordinary.slice(offset, offset + chunkSize)) {
                        try {
                            const row = ordinaryPage.get(hash);
                            counts.read++;
                            if (!row) {
                                throw new Error("Missing named page");
                            }
                            if (row.selected) {
                                counts.selected++;
                                walkJson(parse("checkpointPages", hash, row.text), sink());
                            }
                        } catch (error) {
                            fail("checkpointPages", hash, error);
                        }
                    }
                    stats.longestChunkMs = Math.max(stats.longestChunkMs, monoNow() - start);
                    await pause(signal);
                }
            }
            signal.throwIfAborted();
            return root;
        } finally {
            db.close();
        }
    }

    async function sizeOf(file: string, recursive: boolean, signal: AbortSignal): Promise<number> {
        signal.throwIfAborted();
        const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
                return null;
            }
            throw error;
        });
        signal.throwIfAborted();
        if (!stat) {
            return 0;
        }
        if (stat.isFile()) {
            return stat.size;
        }
        if (!recursive || !stat.isDirectory()) {
            return 0;
        }
        const names = await fs.readdir(file);
        signal.throwIfAborted();
        let bytes = 0;
        for (const name of names) {
            bytes += await sizeOf(path.join(file, name), true, signal);
            signal.throwIfAborted();
        }
        return bytes;
    }

    function classify(
        root: Roots,
        listed: BackupSnapshotInfo[],
        files: Awaited<ReturnType<typeof listAssetFiles>>["files"],
        held: Set<string>,
        now: number,
        reasons: string[],
        usage: AssetLifecycleReport["usage"],
        disk: AssetLifecycleReport["disk"],
    ): AssetLifecycleReport {
        const liveTails = [...root.tails].sort();
        const allIds = new Set(root.ids);
        const indexed = new Map<string, string[]>();
        for (const snapshot of listed) {
            indexed.set(
                snapshot.id,
                selectSnapshotReferences
                    .all(snapshot.id)
                    .map((row) => String(row.tail))
                    .sort(),
            );
            for (const row of selectSnapshotInlays.all(snapshot.id)) {
                allIds.add(String(row.id));
            }
        }
        const snapshotReports = listed.map((snapshot) => ({
            ...snapshot,
            heldBytes: 0,
        }));
        const sizes = new Map(files.map((file) => [file.key, file.bytes]));
        const referenced = new Set<string>();
        const unreferenced: typeof files = [];
        for (const file of files) {
            const name = file.key.slice(7);
            const fullPath = resolveStorageKey(savePath, file.key);
            const live =
                matches(liveTails, name) ||
                held.has(file.key) ||
                (fullPath !== null && assetLeased(fullPath)) ||
                file.mtimeMs > now - grace;
            const naming = snapshotReports.filter((snapshot) => matches(indexed.get(snapshot.id)!, name));
            if (live || naming.length) {
                referenced.add(file.key);
            } else {
                unreferenced.push(file);
            }
            if (!live && naming.length === 1) {
                naming[0].heldBytes += file.bytes;
            }
        }
        const orphan = [...root.inlays].filter(([id]) => !allIds.has(id));
        if (!reasons.length) {
            const unreferencedKeys = new Set(unreferenced.map((file) => file.key));
            const orphanIds = new Set(orphan.map(([id]) => id));
            for (const row of selectUnreferencedKeys.all()) {
                if (!unreferencedKeys.has(String(row.key))) {
                    deleteUnreferenced.run(row.key);
                }
            }
            for (const file of unreferenced) {
                insertUnreferenced.run(file.key, now, file.bytes);
            }
            for (const row of selectOrphanIds.all()) {
                if (!orphanIds.has(String(row.id))) {
                    deleteOrphanInlay.run(row.id);
                }
            }
            for (const [id] of orphan) {
                insertOrphanInlay.run(id, now);
            }
        }
        const since = new Map(selectUnreferencedSince.all().map((row) => [String(row.key), Number(row.since)]));
        const orphanSince = new Map(selectOrphanSince.all().map((row) => [String(row.id), Number(row.since)]));
        const classifiedCandidates = unreferenced
            .filter((file) => since.has(file.key) && since.get(file.key)! + grace <= now && file.mtimeMs <= now - grace)
            .map((file) => ({ key: file.key, bytes: file.bytes, since: since.get(file.key)! }));
        for (const [id, asset] of root.inlays) {
            if (asset === null) {
                continue;
            }
            const characters = root.inlayCharacters.get(id);
            if (characters?.size) {
                for (const character of characters) {
                    ownerFor(root, "character", character).keys.add(asset);
                }
            } else {
                ownerFor(root, "inlays", "inlays").keys.add(asset);
            }
        }
        const owned = new Set<string>();
        let logicalBytes = 0;
        const owners: AssetLifecycleReport["owners"] = [];
        for (const owner of root.owners.values()) {
            let bytes = 0;
            let count = 0;
            for (const key of owner.keys) {
                if (!referenced.has(key)) {
                    continue;
                }
                owned.add(key);
                bytes += sizes.get(key) ?? 0;
                count++;
            }
            if (count) {
                owners.push({ kind: owner.kind, id: owner.id, name: owner.name, bytes, count });
            }
            logicalBytes += bytes;
        }
        let dedupedBytes = 0;
        for (const key of referenced) {
            const bytes = sizes.get(key) ?? 0;
            dedupedBytes += bytes;
            if (!owned.has(key)) {
                logicalBytes += bytes;
            }
        }
        const orphanRecords = orphan.map(([id, asset]) => ({
            id,
            asset,
            bytes: asset === null ? 0 : (sizes.get(asset) ?? 0),
            since: orphanSince.get(id) ?? null,
        }));
        if (!reasons.length) {
            candidates = new Map(classifiedCandidates.map((item) => [item.key, item]));
            orphanCandidates = new Map(
                orphanRecords
                    .filter((item) => item.since !== null && item.since + grace <= now)
                    .map((item) => [item.id, { since: item.since!, bytes: item.bytes }]),
            );
        }
        return {
            generatedAt: now,
            complete: reasons.length === 0,
            reasons: [...reasons],
            running: false,
            disk,
            usage,
            referenced: { logicalBytes, dedupedBytes, savings: logicalBytes - dedupedBytes, count: referenced.size },
            unreferenced: {
                count: unreferenced.length,
                bytes: unreferenced.reduce((sum, file) => sum + file.bytes, 0),
                pastGrace: {
                    count: classifiedCandidates.length,
                    bytes: classifiedCandidates.reduce((sum, file) => sum + file.bytes, 0),
                },
                candidates: classifiedCandidates.slice(0, ASSET_LIST_CAP),
                total: classifiedCandidates.length,
            },
            orphanInlays: {
                count: orphan.length,
                bytes: orphanRecords.reduce((sum, record) => sum + record.bytes, 0),
                records: orphanRecords.slice(0, ASSET_LIST_CAP),
                total: orphan.length,
            },
            owners,
            snapshots: snapshotReports,
        };
    }

    async function run(
        signal: AbortSignal,
        runIdentity: AssetRunIdentity,
        startedAt: number,
    ): Promise<AssetLifecycleReport> {
        const start = monoNow();
        const reasons: string[] = [];
        const stats: AssetScanMetrics = {
            tables: {},
            liveScanMs: 0,
            snapshotIndexMs: 0,
            longestChunkMs: 0,
            totalMs: 0,
        };
        metrics = stats;
        let root = roots();
        let inventory: Awaited<ReturnType<typeof listAssetFiles>> = { files: [], unmanaged: [] };
        let listed: BackupSnapshotInfo[] = [];
        let disk: AssetLifecycleReport["disk"] = null;
        const usage = { ...latest.usage };
        const attempted = new Set<string>();
        const indexed = (id: string) => !!selectSnapshotIndex.get(id);
        const list = () => {
            try {
                return snapshots.list();
            } catch (error) {
                reasons.push(`Snapshots could not be listed: ${String(error)}`);
                return [];
            }
        };
        async function indexSnapshots(items: BackupSnapshotInfo[]) {
            const start = monoNow();
            for (const snapshot of items) {
                signal.throwIfAborted();
                if (indexed(snapshot.id) || attempted.has(snapshot.id)) {
                    continue;
                }
                attempted.add(snapshot.id);
                const link = path.join(savePath, ".tmp", `asset-mark-${randomUUID()}.sqlite`);
                try {
                    await fs.mkdir(path.dirname(link), { recursive: true });
                    signal.throwIfAborted();
                    const staged = await snapshots.stageCopy(snapshot.id, link);
                    signal.throwIfAborted();
                    if (!staged) {
                        continue;
                    }
                    const errors: string[] = [];
                    const snapshotRoot = await readRoots(link, snapshot.id, signal, errors, stats);
                    signal.throwIfAborted();
                    reasons.push(...errors);
                    if (!errors.length) {
                        const start = monoNow();
                        // A staged link can outlive removal; never reinsert the removed root's index.
                        if (snapshots.resolve(snapshot.id) === null) continue;
                        transaction(() => {
                            for (const value of snapshotRoot.tails) {
                                insertSnapshotReference.run(snapshot.id, value);
                            }
                            for (const id of snapshotRoot.ids) {
                                insertSnapshotInlay.run(snapshot.id, id);
                            }
                            insertSnapshotIndex.run(snapshot.id, wallNow());
                        });
                        stats.longestChunkMs = Math.max(stats.longestChunkMs, monoNow() - start);
                    }
                } catch (error) {
                    signal.throwIfAborted();
                    reasons.push(`snapshot ${snapshot.id}: ${String(error)}`);
                } finally {
                    await fs
                        .rm(link, { force: true })
                        .catch((error: unknown) =>
                            reasons.push(`snapshot ${snapshot.id} link cleanup: ${String(error)}`),
                        );
                }
                signal.throwIfAborted();
            }
            stats.snapshotIndexMs += monoNow() - start;
        }
        function record(report: AssetLifecycleReport) {
            insertRun.run(
                startedAt,
                report.complete ? 1 : 0,
                JSON.stringify(report.reasons),
                JSON.stringify({
                    identity: runIdentity,
                    referenced: report.referenced,
                    unreferenced: { count: report.unreferenced.count, bytes: report.unreferenced.bytes },
                    orphanInlays: report.orphanInlays.count,
                    metrics: stats,
                }),
            );
            pruneRuns.run();
        }
        try {
            const liveStart = monoNow();
            try {
                root = await readRoots(dbPath, null, signal, reasons, stats);
            } catch (error) {
                signal.throwIfAborted();
                reasons.push(`Live store: ${String(error)}`);
            }
            signal.throwIfAborted();
            stats.liveScanMs = monoNow() - liveStart;
            listed = list();
            await indexSnapshots(listed);
            signal.throwIfAborted();
            try {
                inventory = await listAssetFiles(path.join(savePath, "assets"), signal);
            } catch (error) {
                signal.throwIfAborted();
                reasons.push(`Assets directory: ${String(error)}`);
            }
            signal.throwIfAborted();
            usage.assetsOnDisk = inventory.files.reduce((sum, file) => sum + file.bytes, 0);
            usage.unmanaged = inventory.unmanaged.reduce((sum, file) => sum + file.bytes, 0);
            for (const [kind, paths, recursive] of [
                ["resourcesDb", [dbPath, dbPath + "-wal", dbPath + "-shm"], false],
                ["thumbnails", [path.join(savePath, "cache", "thumbnails")], true],
                ["staging", [path.join(savePath, ".tmp")], true],
            ] as const) {
                try {
                    let size = 0;
                    for (const file of paths) {
                        size += await sizeOf(file, recursive, signal);
                        signal.throwIfAborted();
                    }
                    usage[kind] = size;
                } catch (error) {
                    signal.throwIfAborted();
                    reasons.push(`${kind} usage: ${String(error)}`);
                }
            }
            disk = await freeBytes(savePath, { statfs: options.statfs });
            signal.throwIfAborted();
            const deadline = monoNow() + (options.exportWaitMs ?? UPSTREAM_EXPORT_STAGED_TTL_MS);
            let rounds = 0;
            for (;;) {
                const settled = await holds.keySetsSettled(Math.max(0, deadline - monoNow()), signal);
                signal.throwIfAborted();
                // From this check through the ledger commit there is no await. New holds or
                // snapshots send us back through the bounded wait/index before classification.
                if (holds.hasPending() && settled && monoNow() < deadline) {
                    continue;
                }
                if (!settled || holds.hasPending()) {
                    reasons.push("Export key sets did not settle before the wait bound");
                }
                const held = new Set([...holds.heldAssetKeys()].map(normalizedKey));
                listed = list();
                const unseen = listed.filter((snapshot) => !indexed(snapshot.id) && !attempted.has(snapshot.id));
                if (unseen.length && rounds < 3) {
                    rounds++;
                    await indexSnapshots(unseen);
                    signal.throwIfAborted();
                    continue;
                }
                if (unseen.length) {
                    reasons.push("Snapshots continued appearing during the scan");
                }
                if (store.epoch() !== runIdentity.epoch) {
                    reasons.push("Store epoch changed during the scan");
                }
                usage.snapshots = listed.reduce((sum, snapshot) => sum + snapshot.size, 0);
                const finalStart = monoNow();
                transaction(() => {
                    const present = new Set(listed.map((snapshot) => snapshot.id));
                    for (const row of selectSnapshotIndexes.all()) {
                        if (!present.has(String(row.snapshotId))) {
                            for (const statement of deleteSnapshotIndex) {
                                statement.run(row.snapshotId);
                            }
                        }
                    }
                    latest = classify(root, listed, inventory.files, held, wallNow(), reasons, usage, disk);
                    stats.totalMs = monoNow() - start;
                    record(latest);
                });
                stats.longestChunkMs = Math.max(stats.longestChunkMs, monoNow() - finalStart);
                break;
            }
        } catch (error) {
            reasons.push(signal.aborted ? "Scan aborted" : `Scan failed: ${String(error)}`);
            latest = { ...latest, generatedAt: wallNow(), complete: false, reasons, running: false, usage, disk };
            stats.totalMs = monoNow() - start;
            transaction(() => record(latest));
        }
        stats.totalMs = monoNow() - start;
        if (latest.complete) {
            completedMono = monoNow();
            liveSelectedRows = Object.entries(stats.tables)
                .filter(([name]) => name.startsWith("live."))
                .reduce((sum, [, counts]) => sum + counts.selected, 0);
        }
        return latest;
    }

    /** Recheck the writer connection with the same decoded recognizer as the asynchronous mark. */
    function remark(keys: string[], ids: string[], full: boolean): { tails: string[]; ids: Set<string> } {
        const tails = new Set<string>();
        const named = new Set<string>();
        const sink: AssetReferenceSink = { tail: (tail) => tails.add(tail), inlay: (id) => named.add(id) };
        const prefix = (value: string) => value.split(/["\\\u0000-\u001f]/, 1)[0];
        const needles = [...new Set([...keys.map(prefix), ...ids.map((id) => "::" + prefix(id))])];
        const lowerNeedles = keys.flatMap((key) => {
            const hex = Buffer.from(key, "utf8").toString("hex");
            return ["/api/asset/" + hex, "/sw/img/" + hex];
        });
        store.readAssetReferenceText({ needles: NEEDLES, lowerNeedles: [] }, (text, json) => {
            // SQL selects the same small generic superset for full and narrowed rechecks. A
            // batch filter only saves parsing selected rows; JSON unicode/slash escapes must
            // pass it too, since their decoded spelling can hide every literal batch needle.
            if (
                !full &&
                !(json && (text.includes("\\u") || text.includes("\\/"))) &&
                !needles.some((needle) => text.includes(needle))
            ) {
                const lowerText = lowerNeedles.length ? text.toLowerCase() : "";
                if (!lowerNeedles.some((needle) => lowerText.includes(needle))) return;
            }
            if (!json) return recognize(text, sink);
            const value: unknown = JSON.parse(text);
            walkJson(value, sink);
            // Checkpoint memory chunks serialize each row once more. Other arrays can contain
            // prose beginning with braces/brackets; walk it again only when it is valid nested JSON.
            if (Array.isArray(value)) {
                for (const child of value) {
                    if (typeof child === "string") {
                        let nested: unknown;
                        try {
                            nested = JSON.parse(child);
                        } catch {
                            continue; // walkJson already recognized this string as plain text.
                        }
                        walkJson(nested, sink);
                    }
                }
            }
        });
        return { tails: [...tails].sort(), ids: named };
    }

    /**
     * User-started deletion, never maintenance: each batch holds exclusive, refreshes snapshot/export
     * roots, then takes sorted key locks. Re-mark, lease/mtime checks, and unlink/store.delete have no
     * await between them. Full results certify later batches; a narrowed result never advances baseline.
     */
    function sweep(request: AssetSweepRequest & { signal?: AbortSignal }): Promise<AssetSweepResult> {
        const refuse = (message: string): never => {
            throw new AssetSweepConflict(message);
        };
        if (closed) refuse("The asset lifecycle is closed");
        if (active || sweepActive) refuse("A scan or sweep is already running");
        if (!identity) refuse("No scan from this process");
        if (!latest.complete) refuse("Reference set incomplete");
        const runIdentity = identity!;
        if (store.epoch() !== runIdentity.epoch) refuse("Store replaced since scan");
        if (monoNow() - completedMono > ASSET_LEASE_MS) refuse("Scan is older than one hour");
        if (monoNow() < ASSET_LEASE_MS) refuse("Process has not been up for one hour");
        const internal = (controller = new AbortController()).signal;
        const signal = request.signal ? AbortSignal.any([internal, request.signal]) : internal;
        const result: AssetSweepResult = {
            deleted: [],
            freedBytes: 0,
            removedInlays: [],
            skipped: [],
            skippedInlays: [],
        };
        const stats: AssetSweepMetrics = { longestSynchronousTurnMs: 0, remarks: [], batches: 0, totalMs: 0 };
        sweepMetrics = stats;
        const start = monoNow();
        let baseline = runIdentity.writeCount;
        let fullRoots: ReturnType<typeof remark> | null = null;
        let stopReason: string | null = null;
        const deadline = monoNow() + (options.exportWaitMs ?? UPSTREAM_EXPORT_STAGED_TTL_MS);
        const keys = [...new Set(request.keys ?? candidates.keys())];
        const ids = [...new Set(request.inlays ?? [])];
        const skip = (keys: string[], ids: string[], reason: string) => {
            result.skipped.push(...keys.map((key) => ({ key, reason })));
            result.skippedInlays.push(...ids.map((id) => ({ id, reason })));
        };
        async function batch(keys: string[], ids: string[]) {
            signal.throwIfAborted();
            stats.batches++;
            await snapshots.exclusive(async () => {
                signal.throwIfAborted();
                if (store.epoch() !== runIdentity.epoch) stopReason = "store replaced";
                if (stopReason) return skip(keys, ids, stopReason);
                let snapshotTails: string[];
                const snapshotIds = new Set<string>();
                try {
                    const tails = new Set<string>();
                    for (const snapshot of snapshots.list()) {
                        if (!selectSnapshotIndex.get(snapshot.id)) {
                            const file = snapshots.resolve(snapshot.id);
                            if (!file) throw new Error(`snapshot ${snapshot.id} unreadable`);
                            const reasons: string[] = [];
                            const scanStats: AssetScanMetrics = {
                                tables: {},
                                liveScanMs: 0,
                                snapshotIndexMs: 0,
                                longestChunkMs: 0,
                                totalMs: 0,
                            };
                            const root = await readRoots(file, snapshot.id, signal, reasons, scanStats);
                            if (reasons.length)
                                throw new Error(`snapshot ${snapshot.id} unreadable: ${reasons.join("; ")}`);
                            transaction(() => {
                                for (const tail of root.tails) insertSnapshotReference.run(snapshot.id, tail);
                                for (const id of root.ids) insertSnapshotInlay.run(snapshot.id, id);
                                insertSnapshotIndex.run(snapshot.id, wallNow());
                            });
                        }
                        for (const row of selectSnapshotReferences.all(snapshot.id)) tails.add(String(row.tail));
                        for (const row of selectSnapshotInlays.all(snapshot.id)) snapshotIds.add(String(row.id));
                    }
                    snapshotTails = [...tails].sort();
                } catch (error) {
                    signal.throwIfAborted();
                    return skip(keys, ids, `snapshot recheck failed: ${String(error)}`);
                }
                if (!(await holds.keySetsSettled(Math.max(0, deadline - monoNow()), signal))) {
                    stopReason = "export key set pending";
                    return skip(keys, ids, stopReason);
                }
                const deleted: { key: string; fullPath: string; bytes: number }[] = [];
                const removed: string[] = [];
                await withAssetLocks(
                    keys.flatMap((key) => {
                        const file = resolveStorageKey(savePath, key);
                        return file ? [file] : [];
                    }),
                    () => {
                        const turnStart = monoNow();
                        try {
                            signal.throwIfAborted();
                            if (store.epoch() !== runIdentity.epoch) {
                                stopReason = "store replaced";
                                return skip(keys, ids, stopReason);
                            }
                            if (holds.hasPending()) return skip(keys, ids, "export key set pending");
                            let live = fullRoots;
                            if (store.writeCount() !== baseline) {
                                const full = liveSelectedRows <= (options.fullRemarkMaxRows ?? Infinity);
                                const remarkStart = monoNow();
                                try {
                                    live = remark(keys, ids, full);
                                    if (full) {
                                        fullRoots = live;
                                        baseline = store.writeCount();
                                    }
                                } catch (error) {
                                    return skip(keys, ids, `re-mark failed: ${String(error)}`);
                                } finally {
                                    stats.remarks.push({
                                        kind: full ? "full" : "narrowed",
                                        ms: monoNow() - remarkStart,
                                    });
                                }
                            }
                            const held = new Set([...holds.heldAssetKeys()].map(normalizedKey));
                            for (const key of keys) {
                                let reason: string | undefined;
                                const file = resolveStorageKey(savePath, key);
                                if (!candidates.has(key) || !file) reason = "not a candidate";
                                else if (matches(snapshotTails, key.slice(7))) reason = "named by snapshot";
                                else if (live && matches(live.tails, key.slice(7))) reason = "referenced";
                                else if (held.has(key)) reason = "held by export";
                                else if (assetLeased(file)) reason = "leased";
                                else {
                                    try {
                                        const stat = statSync(file);
                                        if (!stat.isFile()) reason = "not a regular file";
                                        else if (stat.mtimeMs > wallNow() - grace) reason = "young";
                                        else {
                                            if (!request.dryRun) unlinkSync(file);
                                            deleted.push({ key, fullPath: file, bytes: stat.size });
                                        }
                                    } catch (error) {
                                        reason =
                                            (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : String(error);
                                    }
                                }
                                if (reason) result.skipped.push({ key, reason });
                            }
                            const eligible: string[] = [];
                            for (const id of ids) {
                                let reason: string | undefined;
                                if (!orphanCandidates.has(id)) reason = "not an orphan past the grace";
                                else if (snapshotIds.has(id)) reason = "named by snapshot";
                                else if (live?.ids.has(id)) reason = "referenced";
                                else if (!options.inlaysKind) reason = "inlay kind unavailable";
                                if (reason) result.skippedInlays.push({ id, reason });
                                else eligible.push(id);
                            }
                            // Defer feed publication until every inlay decision is applied. Subscriber writes
                            // then advance writeCount normally; they must never be hidden by a new baseline.
                            if (eligible.length) {
                                const committed: string[] = [];
                                try {
                                    store.transaction(() => {
                                        for (const id of eligible) {
                                            const record = store.get(options.inlaysKind!, id);
                                            if (!record) result.skippedInlays.push({ id, reason: "gone" });
                                            else {
                                                if (!request.dryRun)
                                                    store.delete(options.inlaysKind!, id, record.revision);
                                                committed.push(id);
                                            }
                                        }
                                    });
                                    removed.push(...committed);
                                } catch (error) {
                                    skip([], eligible, String(error));
                                }
                            }
                        } finally {
                            stats.longestSynchronousTurnMs = Math.max(
                                stats.longestSynchronousTurnMs,
                                monoNow() - turnStart,
                            );
                        }
                    },
                    signal,
                );
                result.deleted.push(...deleted.map((item) => item.key));
                result.freedBytes += deleted.reduce((sum, item) => sum + item.bytes, 0);
                result.removedInlays.push(...removed);
                if (request.dryRun) return;
                // Only completed deletions reach cleanup. Cleanup failures cannot recast an unlink as a skip.
                for (const { key, fullPath } of deleted) {
                    assetVerification.forgetVerification(fullPath);
                    const candidate = candidates.get(key)!;
                    deleteUnreferenced.run(key);
                    candidates.delete(key);
                    latest.usage.assetsOnDisk = Math.max(0, latest.usage.assetsOnDisk - candidate.bytes);
                    latest.unreferenced.count--;
                    latest.unreferenced.bytes -= candidate.bytes;
                    latest.unreferenced.pastGrace.count--;
                    latest.unreferenced.pastGrace.bytes -= candidate.bytes;
                    latest.unreferenced.total--;
                    latest.unreferenced.candidates = [...candidates.values()].slice(0, ASSET_LIST_CAP);
                    try {
                        await options.thumbnails?.removeKey(key);
                    } catch (error) {
                        console.error("[Server] Asset thumbnail cleanup failed:", error);
                    }
                }
                for (const id of removed) {
                    deleteOrphanInlay.run(id);
                    const bytes = orphanCandidates.get(id)!.bytes;
                    orphanCandidates.delete(id);
                    latest.orphanInlays.count--;
                    latest.orphanInlays.total--;
                    latest.orphanInlays.bytes -= bytes;
                    latest.orphanInlays.records = latest.orphanInlays.records.filter((item) => item.id !== id);
                }
            });
        }
        sweepActive = Promise.resolve()
            .then(async () => {
                // Resolved promises alone do not yield to socket I/O. Even skip-only/dry batches
                // must let queued record writes run before the next recheck, outside every lock.
                for (let i = 0; i < keys.length; i += sweepBatchSize) {
                    if (stats.batches) await yieldImmediate(undefined, { signal });
                    await batch(keys.slice(i, i + sweepBatchSize), []);
                }
                for (let i = 0; i < ids.length; i += sweepBatchSize) {
                    if (stats.batches) await yieldImmediate(undefined, { signal });
                    await batch([], ids.slice(i, i + sweepBatchSize));
                }
                return result;
            })
            .finally(() => {
                stats.totalMs = monoNow() - start;
                sweepActive = null;
                controller = null;
            });
        return sweepActive;
    }

    function scan(): Promise<AssetLifecycleReport> {
        if (closed) {
            return Promise.reject(new Error("The asset lifecycle is closed"));
        }
        if (active || sweepActive) {
            return Promise.reject(new Error("A scan or sweep is already running"));
        }
        const signal = (controller = new AbortController()).signal;
        identity = { runId: ++runId, epoch: store.epoch(), writeCount: store.writeCount() };
        const runIdentity = identity;
        const startedAt = wallNow();
        active = Promise.resolve()
            .then(() => run(signal, runIdentity, startedAt))
            .finally(() => {
                active = null;
                controller = null;
            });
        return active;
    }
    async function tick() {
        if (closed || active || sweepActive || snapshots.gate.active) {
            return;
        }
        try {
            store.checkpoints.sweep();
        } catch (error) {
            console.error("[Server] Checkpoint page sweep failed:", error);
        }
        try {
            await scan();
        } catch (error) {
            console.error("[Server] Asset scan failed:", error);
        }
    }
    function schedule(delay: number) {
        timer = setTimeout(() => {
            timer = null;
            if (closed) {
                return;
            }
            schedule(options.intervalMs ?? DAY_MS);
            void tick();
        }, delay);
        timer.unref?.();
    }
    function beginShutdown() {
        closed = true;
        if (timer !== null) {
            clearTimeout(timer);
        }
        timer = null;
        controller?.abort();
    }
    return {
        wallNow,
        monoNow,
        get clockOffsetMs() {
            return offset;
        },
        get runIdentity(): AssetRunIdentity | null {
            return identity && { ...identity };
        },
        get metrics() {
            return metrics;
        },
        get sweepMetrics() {
            return sweepMetrics;
        },
        get running() {
            return active !== null || sweepActive !== null;
        },
        get closed() {
            return closed;
        },
        report(): AssetLifecycleReport {
            return { ...latest, running: active !== null || sweepActive !== null };
        },
        scan,
        sweep,
        start() {
            if (!started && !closed) {
                started = true;
                schedule(options.firstScanDelayMs ?? 60 * 60 * 1000);
            }
        },
        beginShutdown,
        close(): Promise<void> {
            beginShutdown();
            unregisterRemoved();
            closing ??= (async () => {
                try {
                    await Promise.allSettled([active, sweepActive]);
                } finally {
                    ledger.close();
                }
            })();
            return closing;
        },
    };
}
