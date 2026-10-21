import type { FileHandle } from "node:fs/promises";
import { resolveStorageKey } from "../../routes/storage.ts";
import { ArchiveFormatError, ArchiveRejectedError, type ArchiveRecord, indexArchive, readRecord } from "../archive.ts";

/**
 * Upstream RisuAI `.bin` backups: the same record container as `../archive.ts`, holding basenames
 * only: `.png` assets, cold-storage payloads, `database.risudat` (written last), and
 * `encryption.risudat` for a Risu Account backup. Readers do not rely on that order.
 */
export const UPSTREAM_DATABASE_RECORD = "database.risudat";
const UPSTREAM_ENCRYPTION_RECORD = "encryption.risudat";
/** Records only a version-2 archive of this server holds. */
const VERSION_2_RECORDS = new Set(["manifest.json", "resources.sqlite"]);
/**
 * A cold-storage payload: `coldstorage_<uuid>.json`, or the bare `<uuid>.json` that builds v2026.4.120
 * to v2026.6.215 wrote (their `coldstorage/` prefix was cut to the basename). Upstream's own pattern
 * (`getColdStorageBackupKey`), minus the `/` form, which a basename cannot hold.
 */
const COLD_RECORD_NAME =
    /^(?:coldstorage_)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.json$/;
/** Largest cold-storage payload `readColdRecord` parses by default. */
export const MAX_COLD_RECORD_BYTES = 64 * 1024 * 1024;

export const UPSTREAM_ENCRYPTED_MESSAGE =
    "This backup was encrypted with a Risu Account. RisuAI can only decrypt it on risuai.xyz; export an unencrypted backup there and import that file";

/**
 * The record name an `assets/...` key is written under in an upstream backup (the key without
 * `assets/`), or null when no record can hold it: an empty name or one with `/` or `\` (refused by
 * `planUpstreamArchive`), a name upstream's restore reads as its database, its account marker, or
 * cold storage, a version-2 record name (which makes `planUpstreamArchive` refuse the file), and a
 * name that would not come back unchanged: upstream's restore decodes record names with a default
 * `TextDecoder`, which drops a leading byte order mark, and a lone surrogate is written as U+FFFD.
 */
export function upstreamAssetRecordName(key: string): string | null {
    if (!key.startsWith("assets/")) {
        return null;
    }
    const name = key.slice("assets/".length);
    if (
        name === "" ||
        new TextDecoder().decode(Buffer.from(name, "utf-8")) !== name ||
        name.includes("/") ||
        name.includes("\\") ||
        name === UPSTREAM_DATABASE_RECORD ||
        name === UPSTREAM_ENCRYPTION_RECORD ||
        VERSION_2_RECORDS.has(name) ||
        COLD_RECORD_NAME.test(name)
    ) {
        return null;
    }
    return name;
}

export type UpstreamIgnoredRecord = {
    name: string;
    /** The name has no storage location (`resolveStorageKey`), for example too long. */
    reason: "invalidAssetKey";
};

/**
 * One cold-storage key and its records in archive order: both name forms of one key can occur. Read
 * it with `readColdEntry`.
 */
export type UpstreamColdEntry = { key: string; records: ArchiveRecord[] };

export type UpstreamArchivePlan = {
    database: ArchiveRecord;
    /** Every other record, stored as `assets/<name>`; `target` is its file under `save/assets`. */
    assets: { record: ArchiveRecord; key: string; target: string }[];
    /** Cold-storage payloads by their key (the UUID as written, which the database's pointers name). */
    cold: UpstreamColdEntry[];
    ignored: UpstreamIgnoredRecord[];
};

/**
 * Indexes an upstream backup and sorts its records without reading the database. Refused with
 * `ArchiveRejectedError`: a malformed container, a Risu Account backup, a version-2 archive, a
 * duplicate name, a name with `/` or `\`, and no `database.risudat`.
 */
export async function planUpstreamArchive(
    handle: FileHandle,
    savePath: string,
    signal?: AbortSignal,
): Promise<UpstreamArchivePlan> {
    let records: ArchiveRecord[];
    try {
        records = await indexArchive(handle, signal);
    } catch (error) {
        if (error instanceof ArchiveFormatError) {
            throw new ArchiveRejectedError(error.message);
        }
        throw error;
    }
    // The account marker wins over every other problem: nothing else in such a file is usable.
    if (records.some((record) => record.name === UPSTREAM_ENCRYPTION_RECORD)) {
        throw new ArchiveRejectedError(UPSTREAM_ENCRYPTED_MESSAGE);
    }
    if (records.some((record) => VERSION_2_RECORDS.has(record.name))) {
        throw new ArchiveRejectedError(
            "This is a backup archive of this server, not a RisuAI backup; use the regular import",
        );
    }
    const names = new Set<string>();
    for (const record of records) {
        if (names.has(record.name)) {
            throw new ArchiveRejectedError(`The archive holds ${record.name} twice`);
        }
        names.add(record.name);
        if (record.name.includes("/") || record.name.includes("\\")) {
            throw new ArchiveRejectedError(`The archive holds an unexpected record: ${record.name}`);
        }
    }
    let database: ArchiveRecord | null = null;
    const assets: UpstreamArchivePlan["assets"] = [];
    const coldByKey = new Map<string, ArchiveRecord[]>();
    const ignored: UpstreamIgnoredRecord[] = [];
    for (const record of records) {
        if (record.name === UPSTREAM_DATABASE_RECORD) {
            database = record;
            continue;
        }
        const coldKey = COLD_RECORD_NAME.exec(record.name)?.[1];
        if (coldKey !== undefined) {
            const list = coldByKey.get(coldKey);
            if (list) {
                list.push(record);
            } else {
                coldByKey.set(coldKey, [record]);
            }
            continue;
        }
        const key = "assets/" + record.name;
        const target = resolveStorageKey(savePath, key);
        if (target === null) {
            ignored.push({ name: record.name, reason: "invalidAssetKey" });
            continue;
        }
        assets.push({ record, key, target });
    }
    if (!database) {
        throw new ArchiveRejectedError("The backup holds no database (database.risudat)");
    }
    const cold = [...coldByKey].map(([key, list]) => ({ key, records: list }));
    return { database, assets, cold, ignored };
}

export type ColdRecordResult =
    | { ok: true; value: unknown }
    /**
     * `tooLarge`: over the cap, never read. `invalidJson`: not JSON. `invalidPayload`: JSON that is
     * neither a message array nor an object with `character` or `message` (upstream skips those too).
     */
    | { ok: false; reason: "tooLarge" | "invalidJson" | "invalidPayload" };

/**
 * Reads and parses one cold-storage payload, as upstream's restore does (`TextDecoder`, so a BOM is
 * dropped and invalid UTF-8 replaced, then `JSON.parse`). A record over `cap` bytes, unparsable, or of
 * an unknown shape is reported in the result, not thrown; a read error of the file still throws.
 */
export async function readColdRecord(
    handle: FileHandle,
    record: ArchiveRecord,
    cap: number = MAX_COLD_RECORD_BYTES,
): Promise<ColdRecordResult> {
    if (record.length > cap) {
        return { ok: false, reason: "tooLarge" };
    }
    const text = new TextDecoder().decode(await readRecord(handle, record));
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return { ok: false, reason: "invalidJson" };
    }
    const known =
        Array.isArray(value) ||
        (typeof value === "object" && value !== null && ("character" in value || "message" in value));
    return known ? { ok: true, value } : { ok: false, reason: "invalidPayload" };
}

/**
 * The payload of one cold-storage key: the last of its records that `readColdRecord` accepts, as
 * upstream's restore writes each valid record in archive order and skips the others. When none is
 * accepted, the failure of the last record.
 */
export async function readColdEntry(
    handle: FileHandle,
    entry: UpstreamColdEntry,
    cap: number = MAX_COLD_RECORD_BYTES,
): Promise<ColdRecordResult> {
    let last: ColdRecordResult | null = null;
    for (let i = entry.records.length - 1; i >= 0; i--) {
        const result = await readColdRecord(handle, entry.records[i], cap);
        if (result.ok) {
            return result;
        }
        last ??= result;
    }
    return last ?? { ok: false, reason: "invalidJson" };
}
