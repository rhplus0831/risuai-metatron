import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
    CHECKPOINT_CHAT_FIELDS,
    CHECKPOINT_MEMORY_FIELD,
    CHECKPOINT_PREVIEW_TEXT_LENGTH,
    isToggleKey,
    MAX_AUTO_EVERY,
    MAX_AUTO_KEEP,
    MAX_CHECKPOINT_NAME,
    MAX_MANUAL_CHECKPOINTS,
    MIN_AUTO_EVERY,
    MIN_AUTO_KEEP,
    truncateCheckpointText,
} from "../../../shared/chatCheckpoints.ts";
import type {
    CheckpointKind,
    CheckpointMemoryManifest,
    CheckpointPolicy,
    CheckpointPolicyState,
    CheckpointPreview,
    CheckpointSummary,
} from "../../../shared/chatCheckpoints.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import { MEMORY_RECORD_KINDS } from "../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { normalizeChatMeta, normalizeMessage } from "./chats.ts";
import { COUNT_USER_TURNS_SQL, STAGED_CHAT_SEQS } from "./chatStore.ts";
import {
    checkMemoryRow,
    type MemoryRecordKind,
    memoryRowClaims,
    type MemoryRowClaims,
    type MemoryRowTexts,
} from "./memoryStore.ts";
import {
    isValidResourceId,
    nextRevision,
    ResourceConflictError,
    ResourceValidationError,
    serialize,
    snapshotRows,
} from "./resourceStore.ts";

/**
 * Checkpoints belong to a chat incarnation; deleting it cascades to checkpoints, refs, and policy.
 * Content pages are shared across chats: `prune` and `delete` remove the pages they freed, and the
 * table-wide sweep at open collects the rest, such as the pages a chat's cascade left unreferenced.
 * Snapshots carry all four tables together; an install replaces them on the restored chat incarnations.
 *
 * A checkpoint's structured memory lives in pages too: `fields` names a manifest page under
 * `CHECKPOINT_MEMORY_FIELD`, the manifest lists each record kind's chunk pages, and a chunk is a JSON
 * array of strings, each a row's `data` text verbatim. So a restored record keeps its bytes, and the
 * manifest's chunks are named by the checkpoint's refs like any other page it holds.
 */
const CHECKPOINT_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS chatCheckpoints (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chatSeq INTEGER NOT NULL REFERENCES chats (seq) ON DELETE CASCADE,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        chatRevision TEXT NOT NULL,
        userTurns INTEGER NOT NULL,
        messageCount INTEGER NOT NULL,
        preview TEXT NOT NULL,
        pages TEXT NOT NULL,
        fields TEXT NOT NULL,
        UNIQUE (chatSeq, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS checkpointPages (
        hash TEXT PRIMARY KEY,
        text TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS checkpointPageRefs (
        checkpointSeq INTEGER NOT NULL REFERENCES chatCheckpoints (seq) ON DELETE CASCADE,
        hash TEXT NOT NULL,
        PRIMARY KEY (checkpointSeq, hash)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS checkpointPageRefs_hash ON checkpointPageRefs (hash);
    CREATE TABLE IF NOT EXISTS chatCheckpointPolicy (
        chatSeq INTEGER PRIMARY KEY REFERENCES chats (seq) ON DELETE CASCADE,
        autoEvery INTEGER NOT NULL,
        autoKeep INTEGER NOT NULL,
        lastAutoTurns INTEGER
    ) STRICT;
`;

/** Restore barriers are local to this epoch, outside the snapshot's four-table checkpoint group. */
const RESTORE_FLOORS_SQL = `
    CREATE TABLE IF NOT EXISTS chatRestoreFloors (
        chatSeq INTEGER PRIMARY KEY REFERENCES chats (seq) ON DELETE CASCADE,
        revision INTEGER NOT NULL
    ) STRICT;
`;

/** Every checkpoint table; `createCheckpointTables` and a staged store's writer create them alike. */
export const CHECKPOINT_SCHEMA_SQL = `${CHECKPOINT_TABLES_SQL}${RESTORE_FLOORS_SQL}`;

/** The table-wide page sweep: at open, and in a staged store once its checkpoints are written. */
const SWEEP_PAGES_SQL =
    "DELETE FROM checkpointPages WHERE NOT EXISTS (SELECT 1 FROM checkpointPageRefs r WHERE r.hash = checkpointPages.hash)";

const CHECKPOINT_TABLE_COLUMNS: Record<string, readonly string[]> = {
    chatCheckpoints: [
        "seq",
        "chatSeq",
        "id",
        "kind",
        "name",
        "createdAt",
        "revision",
        "chatRevision",
        "userTurns",
        "messageCount",
        "preview",
        "pages",
        "fields",
    ],
    checkpointPages: ["hash", "text"],
    checkpointPageRefs: ["checkpointSeq", "hash"],
    chatCheckpointPolicy: ["chatSeq", "autoEvery", "autoKeep", "lastAutoTurns"],
};

const MAX_PAGE_ROWS = 64;
const MAX_PAGE_BYTES = 1024 * 1024;

type TokenFunctions = {
    token(seq: number, revision: number): string;
    parse(value: string): { seq: number; revision: number } | null;
};

type ChatRow = { seq: number; revision: number; meta: string };
type SummaryRow = Omit<CheckpointSummary, "revision" | "preview"> & {
    seq: number;
    revision: number;
    preview: string;
};
type CheckpointRow = SummaryRow & { pages: string; fields: string };

/** What a checkpoint holds of the chat's structured memory (`readMemory`). */
export type CheckpointMemory = { captured: false } | { captured: true; texts: MemoryRowTexts };

/** Validated snapshot rows, with stored JSON and page text unchanged; refs are rebuilt from manifests. */
export type CheckpointSnapshotRows = {
    readonly checkpoints: readonly (CheckpointRow & { chatSeq: number; chatRevision: string })[];
    readonly pages: readonly { hash: string; text: string }[];
    readonly policies: readonly (CheckpointPolicyState & { chatSeq: number })[];
};

/**
 * Where `walkCheckpointSnapshot` hands what it checked, as it reads it. Every page comes first, each
 * with a text that matches its hash, whether a checkpoint names it or not; `pageText` answers from what
 * the sink took, so a page's text is never read from the source twice. `hashes` of a checkpoint are the
 * pages it names, its memory chunks included. `end` closes a walk that found the tables, with the pages
 * the checkpoints name.
 */
export type CheckpointSnapshotSink = {
    page(hash: string, text: string): void;
    pageText(hash: string): string;
    checkpoint(row: CheckpointSnapshotRows["checkpoints"][number], hashes: ReadonlySet<string>): void;
    policy(row: CheckpointSnapshotRows["policies"][number]): void;
    end(referenced: ReadonlySet<string>): void;
};

function checkpointName(name: string): string {
    if (typeof name !== "string") {
        throw new ResourceValidationError("Checkpoint name must be a string");
    }
    return truncateCheckpointText(name, MAX_CHECKPOINT_NAME);
}

function assertKind(kind: CheckpointKind) {
    if (kind !== "manual" && kind !== "auto" && kind !== "safety") {
        throw new ResourceValidationError("Checkpoint kind must be manual, auto, or safety");
    }
}

/**
 * Creates the checkpoint tables and their synchronous readers and writers. Writers join the caller's
 * already-open transaction; they never begin or commit one. Non-null save/rename/delete results,
 * prune's deleted/pagesRemoved counts, writePolicy's boolean, and sweep's count report changes so
 * the owner can count only committed writes. `prune` and `delete` remove only the content pages their
 * own checkpoints freed; `sweep` scans the whole page table and, as a single statement, also works in
 * autocommit. `memoryRows` reads a chat's memory rows for `save`, one at a time (`createMemoryTables`).
 */
export function createCheckpointTables(
    db: DatabaseSync,
    tokens: TokenFunctions,
    memoryRows: (chatSeq: number, kind: MemoryRecordKind) => Iterable<{ id: string; data: string }>,
) {
    db.exec(CHECKPOINT_SCHEMA_SQL);
    const selectChat = db.prepare("SELECT seq, revision, meta FROM chats WHERE characterId = ? AND id = ?");
    const selectMessages = db.prepare("SELECT id, data FROM messages WHERE chatSeq = ? ORDER BY position");
    const selectLastMessages = db.prepare("SELECT data FROM messages WHERE chatSeq = ? ORDER BY position DESC LIMIT 2");
    const countMessages = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE chatSeq = ?");
    const countUserTurns = db.prepare(COUNT_USER_TURNS_SQL);
    const summaryColumns = "seq, id, kind, name, createdAt, revision, userTurns, messageCount, preview";
    const selectSummaries = db.prepare(
        `SELECT ${summaryColumns} FROM chatCheckpoints WHERE chatSeq = ? ORDER BY seq DESC`,
    );
    const selectCheckpoint = db.prepare(
        `SELECT ${summaryColumns}, pages, fields FROM chatCheckpoints WHERE chatSeq = ? AND id = ?`,
    );
    const countManual = db.prepare(
        "SELECT COUNT(*) AS count FROM chatCheckpoints WHERE chatSeq = ? AND kind = 'manual'",
    );
    const insertPage = db.prepare("INSERT OR IGNORE INTO checkpointPages (hash, text) VALUES (?, ?)");
    const selectPage = db.prepare("SELECT text FROM checkpointPages WHERE hash = ?");
    const insertCheckpoint = db.prepare(
        "INSERT INTO chatCheckpoints " +
            "(chatSeq, id, kind, name, createdAt, revision, chatRevision, userTurns, messageCount, preview, pages, fields) " +
            "VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
    );
    const insertRef = db.prepare("INSERT INTO checkpointPageRefs (checkpointSeq, hash) VALUES (?, ?)");
    const renameCheckpoint = db.prepare("UPDATE chatCheckpoints SET name = ?, revision = ? WHERE seq = ?");
    const deleteCheckpoint = db.prepare("DELETE FROM chatCheckpoints WHERE seq = ?");
    const prunedSeqs =
        "SELECT seq FROM chatCheckpoints WHERE chatSeq = ? AND kind = ? ORDER BY seq DESC LIMIT -1 OFFSET ?";
    const pruneCheckpoints = db.prepare(`DELETE FROM chatCheckpoints WHERE seq IN (${prunedSeqs})`);
    const selectPrunedHashes = db.prepare(
        `SELECT DISTINCT hash FROM checkpointPageRefs WHERE checkpointSeq IN (${prunedSeqs})`,
    );
    const selectCheckpointHashes = db.prepare("SELECT hash FROM checkpointPageRefs WHERE checkpointSeq = ?");
    const sweepPages = db.prepare(SWEEP_PAGES_SQL);
    // One bound JSON array, so the number of hashes never meets the bound-parameter limit.
    const deleteFreedPages = db.prepare(
        "DELETE FROM checkpointPages WHERE hash IN (SELECT value FROM json_each(?)) AND " +
            "NOT EXISTS (SELECT 1 FROM checkpointPageRefs r WHERE r.hash = checkpointPages.hash)",
    );
    const selectPolicy = db.prepare(
        "SELECT autoEvery, autoKeep, lastAutoTurns FROM chatCheckpointPolicy WHERE chatSeq = ?",
    );
    const deletePolicy = db.prepare("DELETE FROM chatCheckpointPolicy WHERE chatSeq = ?");
    const upsertPolicy = db.prepare(
        "INSERT INTO chatCheckpointPolicy (chatSeq, autoEvery, autoKeep, lastAutoTurns) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (chatSeq) DO UPDATE SET autoEvery = excluded.autoEvery, " +
            "autoKeep = excluded.autoKeep, lastAutoTurns = excluded.lastAutoTurns",
    );
    const selectFloor = db.prepare("SELECT revision FROM chatRestoreFloors WHERE chatSeq = ?");
    const upsertFloor = db.prepare(
        "INSERT INTO chatRestoreFloors (chatSeq, revision) VALUES (?, ?) " +
            "ON CONFLICT (chatSeq) DO UPDATE SET revision = excluded.revision " +
            "WHERE excluded.revision > chatRestoreFloors.revision",
    );

    function summary(row: SummaryRow): CheckpointSummary {
        return {
            id: row.id,
            kind: row.kind,
            name: row.name,
            createdAt: row.createdAt,
            revision: tokens.token(row.seq, row.revision),
            userTurns: row.userTurns,
            messageCount: row.messageCount,
            preview: JSON.parse(row.preview) as CheckpointPreview,
        };
    }

    function putPage(text: string): string {
        const hash = createHash("sha256").update(text, "utf8").digest("hex");
        insertPage.run(hash, text);
        return hash;
    }

    /**
     * Cuts rows, taken one at a time, into content pages and returns the pages' hashes in order. A
     * page's text is a JSON array of its rows' `rowText`s, and those texts are all it holds in memory
     * and what its size counts.
     */
    function putRowPages(rows: Iterable<{ id: string; data: string }>, rowText: (data: string) => string): string[] {
        const pages: string[] = [];
        let rowTexts: string[] = [];
        let pageBytes = 0;
        for (const row of rows) {
            const text = rowText(row.data);
            rowTexts.push(text);
            pageBytes += Buffer.byteLength(text, "utf8");
            // Id anchors keep later pages stable when a nearby row changes. Cuts include the row.
            if (
                createHash("sha256").update(row.id, "utf8").digest()[0] % 16 === 0 ||
                rowTexts.length >= MAX_PAGE_ROWS ||
                pageBytes >= MAX_PAGE_BYTES
            ) {
                pages.push(putPage("[" + rowTexts.join(",") + "]"));
                rowTexts = [];
                pageBytes = 0;
            }
        }
        if (rowTexts.length) {
            pages.push(putPage("[" + rowTexts.join(",") + "]"));
        }
        return pages;
    }

    function readPage(hash: string): unknown {
        const row = selectPage.get(hash) as { text: string } | undefined;
        if (!row) {
            throw new Error(`Missing checkpoint page: ${hash}`);
        }
        return JSON.parse(row.text);
    }

    function findCheckpoint(characterId: string, chatId: string, id: string) {
        const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
        return chat ? (selectCheckpoint.get(chat.seq, id) as CheckpointRow | undefined) : undefined;
    }

    function assertRevision(row: SummaryRow, baseRevision: string) {
        const base = tokens.parse(baseRevision);
        if (!base || base.seq !== row.seq || base.revision !== row.revision) {
            throw new ResourceConflictError(tokens.token(row.seq, row.revision));
        }
    }

    /** Scans the whole page table for unreferenced content pages; returns the number removed. */
    function sweep(): number {
        return Number(sweepPages.run().changes);
    }

    /** Removes those of the collected pages that no ref names any more; returns the number removed. */
    function removeFreedPages(collected: readonly { hash: string }[]): number {
        if (collected.length === 0) {
            return 0;
        }
        return Number(deleteFreedPages.run(JSON.stringify(collected.map((row) => row.hash))).changes);
    }

    return {
        /** The restore barrier's numeric revision, or null for a chat without one. */
        readFloor(characterId: string, chatId: string): number | null {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            return chat ? ((selectFloor.get(chat.seq) as { revision: number } | undefined)?.revision ?? null) : null;
        },

        /** Copies the chat's current revision into its restore barrier, never lowering an existing one. */
        setFloor(characterId: string, chatId: string): boolean {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            return !!chat && Number(upsertFloor.run(chat.seq, chat.revision).changes) > 0;
        },

        /**
         * Captures stored message text, story fields, and structured memory records without changing
         * the chat. Missing chat: null. Counts come from SQL and pages from the stored row texts; only
         * the two preview rows are parsed. A memory chunk encodes its rows' texts as JSON strings, so
         * its size counts the escaping too.
         */
        save(characterId: string, chatId: string, name: string, kind: CheckpointKind): CheckpointSummary | null {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                return null;
            }
            const normalizedName = checkpointName(name);
            assertKind(kind);
            if (kind === "manual" && (countManual.get(chat.seq) as { count: number }).count >= MAX_MANUAL_CHECKPOINTS) {
                throw new ResourceValidationError(
                    `A chat can keep at most ${MAX_MANUAL_CHECKPOINTS} manual checkpoints`,
                );
            }
            const meta = JSON.parse(chat.meta) as Record<string, unknown>;
            const lastRows = selectLastMessages.all(chat.seq) as { data: string }[];
            const preview: CheckpointPreview = {
                messages: lastRows.reverse().map((row) => {
                    const message = JSON.parse(row.data) as Message;
                    return {
                        role: message.role,
                        text:
                            typeof message.data === "string"
                                ? truncateCheckpointText(message.data, CHECKPOINT_PREVIEW_TEXT_LENGTH)
                                : "",
                    };
                }),
                summaries:
                    isPlainObject(meta.hypaV3Data) && Array.isArray(meta.hypaV3Data.summaries)
                        ? meta.hypaV3Data.summaries.length
                        : 0,
                loreEntries: Array.isArray(meta.localLore) ? meta.localLore.length : 0,
                variables: isPlainObject(meta.scriptstate) ? Object.keys(meta.scriptstate).length : 0,
            };
            const { count: messageCount } = countMessages.get(chat.seq) as { count: number };
            const { count: userTurns } = countUserTurns.get(chat.seq) as { count: number };
            const pages = putRowPages(
                selectMessages.iterate(chat.seq) as Iterable<{ id: string; data: string }>,
                (data) => data,
            );
            const memory = Object.fromEntries(
                MEMORY_RECORD_KINDS.map((kind) => [
                    kind,
                    putRowPages(memoryRows(chat.seq, kind), (data) => JSON.stringify(data)),
                ]),
            ) as CheckpointMemoryManifest;
            const fields = Object.fromEntries(
                Object.entries(CHECKPOINT_CHAT_FIELDS).flatMap(([key, behavior]) => {
                    const value = meta[key];
                    if (behavior === "capture" && value !== undefined) {
                        return [[key, putPage(JSON.stringify(value))]];
                    }
                    if (behavior === "split" && isPlainObject(value)) {
                        const entries = Object.entries(value).filter(([key]) => !isToggleKey(key));
                        return [[key, putPage(JSON.stringify(Object.fromEntries(entries)))]];
                    }
                    return [];
                }),
            );
            fields[CHECKPOINT_MEMORY_FIELD] = putPage(JSON.stringify(memory));
            const id = randomUUID();
            const createdAt = Date.now();
            const result = insertCheckpoint.run(
                chat.seq,
                id,
                kind,
                normalizedName,
                createdAt,
                tokens.token(chat.seq, chat.revision),
                userTurns,
                messageCount,
                JSON.stringify(preview),
                JSON.stringify(pages),
                JSON.stringify(fields),
            );
            const seq = Number(result.lastInsertRowid);
            for (const hash of new Set([...pages, ...Object.values(fields), ...Object.values(memory).flat()])) {
                insertRef.run(seq, hash);
            }
            return {
                id,
                kind,
                name: normalizedName,
                createdAt,
                revision: tokens.token(seq, 1),
                userTurns,
                messageCount,
                preview,
            };
        },

        /**
         * Keeps the newest `keep` checkpoints of this kind and removes the content pages only the
         * deleted ones referenced. A missing chat changes nothing.
         */
        prune(characterId: string, chatId: string, kind: CheckpointKind, keep: number) {
            assertKind(kind);
            if (!Number.isSafeInteger(keep) || keep < 0) {
                throw new ResourceValidationError("Checkpoint keep must be a non-negative safe integer");
            }
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                return { deleted: 0, pagesRemoved: 0 };
            }
            const collected = selectPrunedHashes.all(chat.seq, kind, keep) as { hash: string }[];
            const deleted = Number(pruneCheckpoints.run(chat.seq, kind, keep).changes);
            return { deleted, pagesRemoved: removeFreedPages(collected) };
        },

        /** Newest first by insertion sequence, without reading content pages. Missing chat: null. */
        list(characterId: string, chatId: string): CheckpointSummary[] | null {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            return chat ? (selectSummaries.all(chat.seq) as SummaryRow[]).map(summary) : null;
        },

        /** Renames at exactly the supplied revision, advancing its token even for the same name. */
        rename(
            characterId: string,
            chatId: string,
            id: string,
            baseRevision: string,
            name: string,
        ): CheckpointSummary | null {
            const row = findCheckpoint(characterId, chatId, id);
            if (!row) {
                return null;
            }
            assertRevision(row, baseRevision);
            const normalizedName = checkpointName(name);
            const revision = nextRevision(row.revision, 1);
            renameCheckpoint.run(normalizedName, revision, row.seq);
            return summary({ ...row, name: normalizedName, revision });
        },

        /**
         * Deletes at exactly the supplied revision and removes the content pages only that checkpoint
         * referenced; missing chat or checkpoint: null.
         */
        delete(characterId: string, chatId: string, id: string, baseRevision: string) {
            const row = findCheckpoint(characterId, chatId, id);
            if (!row) {
                return null;
            }
            assertRevision(row, baseRevision);
            const collected = selectCheckpointHashes.all(row.seq) as { hash: string }[];
            deleteCheckpoint.run(row.seq);
            return { deleted: true, pagesRemoved: removeFreedPages(collected) };
        },

        /** Builds a detached chat from saved story state and current kept fields; writes nothing. */
        compose(characterId: string, chatId: string, id: string): Chat | null {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                return null;
            }
            const checkpoint = selectCheckpoint.get(chat.seq, id) as CheckpointRow | undefined;
            if (!checkpoint) {
                return null;
            }
            const meta = JSON.parse(chat.meta) as Record<string, unknown>;
            const fields = JSON.parse(checkpoint.fields) as Record<string, string>;
            const entries: [string, unknown][] = [];
            for (const [key, behavior] of Object.entries(CHECKPOINT_CHAT_FIELDS)) {
                if (behavior === "keep" && Object.hasOwn(meta, key)) {
                    entries.push([key, meta[key]]);
                } else if (behavior === "capture" && Object.hasOwn(fields, key)) {
                    entries.push([key, readPage(fields[key])]);
                } else if (behavior === "split") {
                    const current = meta[key];
                    const toggles = isPlainObject(current)
                        ? Object.entries(current).filter(([key]) => isToggleKey(key))
                        : [];
                    const captured = Object.hasOwn(fields, key);
                    if (captured || toggles.length) {
                        entries.push([
                            key,
                            {
                                ...Object.fromEntries(toggles),
                                ...(captured ? (readPage(fields[key]) as Record<string, unknown>) : {}),
                            },
                        ]);
                    }
                }
            }
            const pages = JSON.parse(checkpoint.pages) as string[];
            return {
                ...Object.fromEntries(entries),
                message: pages.flatMap((hash) => readPage(hash) as Message[]),
            } as Chat;
        },

        /**
         * The structured memory a checkpoint holds, its row texts by kind in order; writes nothing.
         * Missing chat or checkpoint: null. `captured` is false for a checkpoint from before they held
         * memory, which says nothing of the chat's records.
         */
        readMemory(characterId: string, chatId: string, id: string): CheckpointMemory | null {
            const checkpoint = findCheckpoint(characterId, chatId, id);
            if (!checkpoint) {
                return null;
            }
            const fields = JSON.parse(checkpoint.fields) as Record<string, string>;
            if (!Object.hasOwn(fields, CHECKPOINT_MEMORY_FIELD)) {
                return { captured: false };
            }
            const manifest = readPage(fields[CHECKPOINT_MEMORY_FIELD]) as CheckpointMemoryManifest;
            const texts = Object.fromEntries(
                MEMORY_RECORD_KINDS.map((kind) => [kind, manifest[kind].flatMap((hash) => readPage(hash) as string[])]),
            ) as Record<MemoryRecordKind, string[]>;
            return { captured: true, texts };
        },

        /** No policy row, or no chat, means null (automatic checkpoints are off). */
        readPolicy(characterId: string, chatId: string): CheckpointPolicyState | null {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            return chat ? ((selectPolicy.get(chat.seq) as CheckpointPolicyState | undefined) ?? null) : null;
        },

        /**
         * Sets or removes a policy. An omitted baseline keeps the existing value, or starts at null.
         * Returns whether it changed a row; a missing chat or an identical policy returns false.
         */
        writePolicy(
            characterId: string,
            chatId: string,
            policy: (CheckpointPolicy & { lastAutoTurns?: number | null }) | null,
        ): boolean {
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                return false;
            }
            if (policy === null) {
                return Number(deletePolicy.run(chat.seq).changes) > 0;
            }
            if (
                !isPlainObject(policy) ||
                !Number.isInteger(policy.autoEvery) ||
                policy.autoEvery < MIN_AUTO_EVERY ||
                policy.autoEvery > MAX_AUTO_EVERY ||
                !Number.isInteger(policy.autoKeep) ||
                policy.autoKeep < MIN_AUTO_KEEP ||
                policy.autoKeep > MAX_AUTO_KEEP
            ) {
                throw new ResourceValidationError(
                    `Checkpoint policy requires autoEvery ${MIN_AUTO_EVERY}–${MAX_AUTO_EVERY} and autoKeep ${MIN_AUTO_KEEP}–${MAX_AUTO_KEEP}`,
                );
            }
            if (
                policy.lastAutoTurns !== undefined &&
                policy.lastAutoTurns !== null &&
                (!Number.isSafeInteger(policy.lastAutoTurns) || policy.lastAutoTurns < 0)
            ) {
                throw new ResourceValidationError(
                    "Checkpoint lastAutoTurns must be null or a non-negative safe integer",
                );
            }
            const previous = selectPolicy.get(chat.seq) as CheckpointPolicyState | undefined;
            const lastAutoTurns =
                policy.lastAutoTurns === undefined ? (previous?.lastAutoTurns ?? null) : policy.lastAutoTurns;
            if (
                previous?.autoEvery === policy.autoEvery &&
                previous.autoKeep === policy.autoKeep &&
                previous.lastAutoTurns === lastAutoTurns
            ) {
                return false;
            }
            upsertPolicy.run(chat.seq, policy.autoEvery, policy.autoKeep, lastAutoTurns);
            return true;
        },

        sweep,
    };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function snapshotJson(text: string, where: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new ResourceValidationError(`${where}: not JSON`);
    }
}

/** Runs one content check of a checkpoint; anything it throws is a refusal of that row. */
function checkedContent<T>(where: string, check: () => T): T {
    try {
        return check();
    } catch (error) {
        throw new ResourceValidationError(
            `${where}: ${error instanceof ResourceValidationError ? error.message : "invalid checkpoint content"}`,
        );
    }
}

/** The message ids of a message page, every message checked. */
function messagePageIds(text: string, hash: string): string[] {
    const messages = snapshotJson(text, `message page ${hash}`);
    if (!Array.isArray(messages)) {
        throw new ResourceValidationError(`message page ${hash} must be an array`);
    }
    return messages.map((input) => {
        // Check the original element before normalization; the page adds no depth to a message.
        const message = normalizeMessage(serialize(input).stored);
        return message.chatId as string;
    });
}

/** Checks a field page's text as the value of the captured chat field `key`. */
function checkFieldPage(key: string, text: string, chatId: string) {
    const value = snapshotJson(text, `field page ${key}`);
    if (
        CHECKPOINT_CHAT_FIELDS[key as keyof typeof CHECKPOINT_CHAT_FIELDS] === "split" &&
        (!isPlainObject(value) || Object.keys(value).some(isToggleKey))
    ) {
        throw new ResourceValidationError(`${key} must be an object without toggle entries`);
    }
    // Captured metadata checks are per field; the wrapper preserves the stored nesting depth.
    normalizeChatMeta(serialize({ [key]: value }).stored, chatId);
}

/** Checks a memory manifest page's text: exactly the record kinds, each listing existing pages. */
function checkMemoryManifest(text: string, hash: string, pageHashes: ReadonlySet<string>): CheckpointMemoryManifest {
    const manifest = snapshotJson(text, `memory manifest ${hash}`);
    if (
        !isPlainObject(manifest) ||
        Object.keys(manifest).length !== MEMORY_RECORD_KINDS.length ||
        !MEMORY_RECORD_KINDS.every((kind) => {
            const chunks = manifest[kind];
            return Array.isArray(chunks) && chunks.every((chunk) => typeof chunk === "string");
        })
    ) {
        throw new ResourceValidationError(`memory manifest ${hash} must list chunk hashes by record kind`);
    }
    const checked = manifest as CheckpointMemoryManifest;
    for (const chunk of Object.values(checked).flat()) {
        if (!pageHashes.has(chunk)) {
            throw new ResourceValidationError(`memory manifest ${hash}: no such checkpointPages hash ${chunk}`);
        }
    }
    return checked;
}

/** What the rules across one checkpoint's chunks need of a checked chunk. */
type MemoryChunkRows = { ids: string[]; scenes: number };

/**
 * Checks a memory chunk's text as rows of `kind`. A chunk's `createdRevision`s have no bound here: it
 * holds no revision to compare with, a live save never leaves one past the chat's, and `replace` refuses
 * a crafted one when it is loaded.
 */
function checkMemoryChunk(kind: MemoryRecordKind, text: string, hash: string): MemoryChunkRows {
    const rows = snapshotJson(text, `memory chunk ${hash}`);
    if (!Array.isArray(rows) || !rows.every((row) => typeof row === "string")) {
        throw new ResourceValidationError(`memory chunk ${hash} must be an array of strings`);
    }
    const chunk: MemoryChunkRows = { ids: [], scenes: 0 };
    const claims: MemoryRowClaims = {
        id(id) {
            chunk.ids.push(id);
        },
        scene() {
            chunk.scenes += 1;
        },
    };
    rows.forEach((row: string, index) => {
        checkMemoryRow(`memory chunk ${hash} row ${index + 1}`, kind, row, claims, Number.MAX_SAFE_INTEGER);
    });
    return chunk;
}

/**
 * Reads the optional checkpoint table group, one row at a time, checking every row and each distinct
 * use of a content page: the same text can be valid as messages and not as a field, as one field and
 * not as another, or as one record kind's chunk and not as another's, so a page's message ids, its field
 * checks, and its chunk rows are remembered apart. An unreferenced page gets only its hash check. Every
 * checked row goes to `sink` with its stored text verbatim, pages by hash, then checkpoints by seq and
 * policies by chat. An absent group calls nothing on `sink`; a partial group or an inconsistent row is a
 * `ResourceValidationError`. `chatIds` holds each chat's id by its seq (`walkChatSnapshot`). Refs are not
 * handed on: they follow from the manifests, and a snapshot's own are only checked against them.
 *
 * A memory chunk's rows pass the check a snapshot's memory rows do (`checkMemoryRow`). Its size is not
 * held to the page limits, which a single record may legally pass, and its records are not compared
 * with the checkpoint's messages: a record's sources can legitimately disagree with them.
 */
export function walkCheckpointSnapshot(
    source: DatabaseSync,
    chatIds: ReadonlyMap<number, string>,
    sink: CheckpointSnapshotSink,
    signal?: AbortSignal,
): void {
    const tables = Object.entries(CHECKPOINT_TABLE_COLUMNS);
    let present = 0;
    for (const [table, columns] of tables) {
        try {
            const objects = source
                .prepare("SELECT name, type, sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE")
                .all(table) as { name: string; type: string; sql: string | null }[];
            if (objects.length === 0) {
                continue;
            }
            if (
                objects.length !== 1 ||
                objects[0].name !== table ||
                objects[0].type !== "table" ||
                !/^CREATE TABLE\b/i.test(objects[0].sql ?? "")
            ) {
                throw new ResourceValidationError(`${table}: not an ordinary checkpoint table`);
            }
            const info = source.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[];
            if (
                info.length !== columns.length ||
                !info.every((column, index) => column.name === columns[index] && column.hidden === 0)
            ) {
                throw new ResourceValidationError(`${table}: invalid checkpoint table columns`);
            }
            present += 1;
        } catch (error) {
            if (error instanceof ResourceValidationError) {
                throw error;
            }
            throw new ResourceValidationError(`${table}: cannot read checkpoint table layout`);
        }
    }
    if (present === 0) {
        return;
    }
    if (present !== tables.length) {
        throw new ResourceValidationError("Incomplete checkpoint tables in resource database");
    }

    const rowsOf = (table: string, order: string) =>
        snapshotRows(
            source,
            `SELECT * FROM ${table} ORDER BY ${order}`,
            `${table}: cannot read checkpoint rows`,
            signal,
        );

    const pageHashes = new Set<string>();
    for (const [row, number] of rowsOf("checkpointPages", "hash")) {
        const where = `checkpointPages row ${number}`;
        if (typeof row.hash !== "string" || typeof row.text !== "string") {
            throw new ResourceValidationError(`${where}: hash and text must be strings`);
        }
        if (pageHashes.has(row.hash)) {
            throw new ResourceValidationError(`${where}: duplicate hash`);
        }
        if (createHash("sha256").update(row.text, "utf8").digest("hex") !== row.hash) {
            throw new ResourceValidationError(`${where}: hash does not match text`);
        }
        pageHashes.add(row.hash);
        sink.page(row.hash, row.text);
    }

    const checkpointKeys = new Set<string>();
    const expectedRefs = new Map<number, Set<string>>();
    const pageMessageIds = new Map<string, string[]>();
    const validatedFieldPages = new Set<string>();
    const memoryChunks = new Map<string, MemoryChunkRows>();
    for (const [row, number] of rowsOf("chatCheckpoints", "seq")) {
        const where = `chatCheckpoints row ${number}`;
        if (!isPositiveSafeInteger(row.seq) || expectedRefs.has(row.seq) || !isPositiveSafeInteger(row.revision)) {
            throw new ResourceValidationError(`${where}: invalid seq or revision`);
        }
        if (typeof row.chatSeq !== "number" || !chatIds.has(row.chatSeq)) {
            throw new ResourceValidationError(`${where}: no such chat`);
        }
        if (!isValidResourceId(row.id)) {
            throw new ResourceValidationError(`${where}: invalid id`);
        }
        const key = `${row.chatSeq}\u0000${row.id}`;
        if (checkpointKeys.has(key)) {
            throw new ResourceValidationError(`${where}: duplicate checkpoint id in chat`);
        }
        checkpointKeys.add(key);
        if (row.kind !== "manual" && row.kind !== "auto" && row.kind !== "safety") {
            throw new ResourceValidationError(`${where}: invalid kind`);
        }
        if (typeof row.name !== "string" || row.name.length > MAX_CHECKPOINT_NAME) {
            throw new ResourceValidationError(`${where}: invalid name`);
        }
        if (
            !isNonNegativeSafeInteger(row.createdAt) ||
            !isNonNegativeSafeInteger(row.userTurns) ||
            !isNonNegativeSafeInteger(row.messageCount)
        ) {
            throw new ResourceValidationError(`${where}: invalid createdAt or counts`);
        }
        if (typeof row.chatRevision !== "string") {
            throw new ResourceValidationError(`${where}: chatRevision must be a string`);
        }
        if (typeof row.preview !== "string" || typeof row.pages !== "string" || typeof row.fields !== "string") {
            throw new ResourceValidationError(`${where}: preview, pages, and fields must be JSON text`);
        }
        const preview = snapshotJson(row.preview, `${where} preview`);
        if (
            !isPlainObject(preview) ||
            !Array.isArray(preview.messages) ||
            preview.messages.length > 2 ||
            !preview.messages.every(
                (message) =>
                    isPlainObject(message) &&
                    (message.role === "user" || message.role === "char") &&
                    typeof message.text === "string",
            ) ||
            !isNonNegativeSafeInteger(preview.summaries) ||
            !isNonNegativeSafeInteger(preview.loreEntries) ||
            !isNonNegativeSafeInteger(preview.variables)
        ) {
            throw new ResourceValidationError(`${where}: invalid preview`);
        }
        const pages = snapshotJson(row.pages, `${where} pages`);
        const fields = snapshotJson(row.fields, `${where} fields`);
        if (!Array.isArray(pages) || !pages.every((hash) => typeof hash === "string")) {
            throw new ResourceValidationError(`${where}: pages must be an array of hashes`);
        }
        if (
            !isPlainObject(fields) ||
            !Object.entries(fields).every(([key, hash]) => {
                const behavior = Object.hasOwn(CHECKPOINT_CHAT_FIELDS, key)
                    ? CHECKPOINT_CHAT_FIELDS[key as keyof typeof CHECKPOINT_CHAT_FIELDS]
                    : undefined;
                return (
                    (key === CHECKPOINT_MEMORY_FIELD || behavior === "capture" || behavior === "split") &&
                    typeof hash === "string"
                );
            })
        ) {
            throw new ResourceValidationError(`${where}: fields must map captured field names to hashes`);
        }
        const hashes = new Set([...pages, ...Object.values(fields)] as string[]);
        for (const hash of hashes) {
            if (!pageHashes.has(hash)) {
                throw new ResourceValidationError(`${where}: no such checkpointPages hash ${hash}`);
            }
        }
        let memoryManifest: CheckpointMemoryManifest | undefined;
        if (Object.hasOwn(fields, CHECKPOINT_MEMORY_FIELD)) {
            const hash = fields[CHECKPOINT_MEMORY_FIELD] as string;
            const text = sink.pageText(hash);
            memoryManifest = checkedContent(where, () => checkMemoryManifest(text, hash, pageHashes));
            for (const chunk of Object.values(memoryManifest).flat()) {
                hashes.add(chunk);
            }
        }
        expectedRefs.set(row.seq, hashes);
        const messageIds = new Set<string>();
        for (const hash of pages as string[]) {
            let ids = pageMessageIds.get(hash);
            if (!ids) {
                const text = sink.pageText(hash);
                ids = checkedContent(where, () => messagePageIds(text, hash));
                pageMessageIds.set(hash, ids);
            }
            for (const id of ids) {
                if (messageIds.has(id)) {
                    throw new ResourceValidationError(`${where}: duplicate message id across checkpoint pages`);
                }
                messageIds.add(id);
            }
        }
        for (const [key, hash] of Object.entries(fields) as [string, string][]) {
            const fieldPage = `${key}\u0000${hash}`;
            if (key === CHECKPOINT_MEMORY_FIELD || validatedFieldPages.has(fieldPage)) {
                continue;
            }
            const text = sink.pageText(hash);
            checkedContent(where, () => checkFieldPage(key, text, chatIds.get(row.chatSeq as number)!));
            validatedFieldPages.add(fieldPage);
        }
        if (memoryManifest) {
            for (const kind of MEMORY_RECORD_KINDS) {
                const claims = memoryRowClaims();
                for (const hash of memoryManifest[kind]) {
                    const chunkPage = `${kind}\u0000${hash}`;
                    let chunk = memoryChunks.get(chunkPage);
                    if (!chunk) {
                        const text = sink.pageText(hash);
                        chunk = checkedContent(where, () => checkMemoryChunk(kind, text, hash));
                        memoryChunks.set(chunkPage, chunk);
                    }
                    const { ids, scenes } = chunk;
                    checkedContent(`${where}: memory ${kind}`, () => {
                        ids.forEach((id) => claims.id(id));
                        for (let scene = 0; scene < scenes; scene += 1) {
                            claims.scene();
                        }
                    });
                }
            }
        }
        sink.checkpoint(
            {
                seq: row.seq,
                chatSeq: row.chatSeq,
                id: row.id,
                kind: row.kind,
                name: row.name,
                createdAt: row.createdAt,
                revision: row.revision,
                chatRevision: row.chatRevision,
                userTurns: row.userTurns,
                messageCount: row.messageCount,
                preview: row.preview,
                pages: row.pages,
                fields: row.fields,
            },
            hashes,
        );
    }

    const actualRefs = new Map<number, Set<string>>();
    const referencedPages = new Set<string>();
    for (const [row, number] of rowsOf("checkpointPageRefs", "checkpointSeq, hash")) {
        const where = `checkpointPageRefs row ${number}`;
        if (typeof row.checkpointSeq !== "number" || !expectedRefs.has(row.checkpointSeq)) {
            throw new ResourceValidationError(`${where}: no such checkpoint`);
        }
        if (typeof row.hash !== "string" || !pageHashes.has(row.hash)) {
            throw new ResourceValidationError(`${where}: no such checkpoint page`);
        }
        const refs = actualRefs.get(row.checkpointSeq) ?? new Set<string>();
        if (refs.has(row.hash)) {
            throw new ResourceValidationError(`${where}: duplicate checkpoint and hash`);
        }
        if (!expectedRefs.get(row.checkpointSeq)!.has(row.hash)) {
            throw new ResourceValidationError(`${where}: hash is not in the checkpoint's pages or fields`);
        }
        refs.add(row.hash);
        actualRefs.set(row.checkpointSeq, refs);
        referencedPages.add(row.hash);
    }
    let checkpointRow = 0;
    for (const [seq, expected] of expectedRefs) {
        checkpointRow += 1;
        if ((actualRefs.get(seq)?.size ?? 0) !== expected.size) {
            throw new ResourceValidationError(`chatCheckpoints row ${checkpointRow}: missing checkpointPageRefs`);
        }
    }

    const policyChats = new Set<number>();
    for (const [row, number] of rowsOf("chatCheckpointPolicy", "chatSeq")) {
        const where = `chatCheckpointPolicy row ${number}`;
        if (typeof row.chatSeq !== "number" || !chatIds.has(row.chatSeq) || policyChats.has(row.chatSeq)) {
            throw new ResourceValidationError(`${where}: no such chat or a duplicate policy`);
        }
        policyChats.add(row.chatSeq);
        if (
            !isNonNegativeSafeInteger(row.autoEvery) ||
            row.autoEvery < MIN_AUTO_EVERY ||
            row.autoEvery > MAX_AUTO_EVERY ||
            !isNonNegativeSafeInteger(row.autoKeep) ||
            row.autoKeep < MIN_AUTO_KEEP ||
            row.autoKeep > MAX_AUTO_KEEP ||
            (row.lastAutoTurns !== null && !isNonNegativeSafeInteger(row.lastAutoTurns))
        ) {
            throw new ResourceValidationError(`${where}: invalid autoEvery, autoKeep, or lastAutoTurns`);
        }
        sink.policy({
            chatSeq: row.chatSeq,
            autoEvery: row.autoEvery,
            autoKeep: row.autoKeep,
            lastAutoTurns: row.lastAutoTurns,
        });
    }
    sink.end(referencedPages);
}

/**
 * The checkpoint sink of `readSnapshotFile`: `rows()` after the walk holds the rows in memory, with only
 * the referenced pages, or undefined for an absent group or one without a checkpoint or a policy.
 */
export function collectCheckpointRows(): { sink: CheckpointSnapshotSink; rows(): CheckpointSnapshotRows | undefined } {
    const pageTexts = new Map<string, string>();
    const checkpoints: CheckpointSnapshotRows["checkpoints"][number][] = [];
    const policies: CheckpointSnapshotRows["policies"][number][] = [];
    let pages: CheckpointSnapshotRows["pages"] = [];
    return {
        sink: {
            page: (hash, text) => void pageTexts.set(hash, text),
            pageText: (hash) => pageTexts.get(hash)!,
            checkpoint: (row) => void checkpoints.push(row),
            policy: (row) => void policies.push(row),
            end: (referenced) => {
                pages = [...referenced].map((hash) => ({ hash, text: pageTexts.get(hash)! }));
            },
        },
        rows: () => (checkpoints.length === 0 && policies.length === 0 ? undefined : { checkpoints, pages, policies }),
    };
}

/**
 * The checkpoint half of a staged store's writer (`writeValidatedStore`): every page goes into the
 * staged table as it is read, so no text stays in memory and `pageText` is an indexed read of the
 * staged table, whatever indexes the source has; the pages no checkpoint named are deleted at the end.
 * A checkpoint keeps the source's numeric `seq` and its refs are written from its manifests, with
 * `chatRevision` verbatim.
 */
export function createCheckpointStagingSink(db: DatabaseSync): CheckpointSnapshotSink {
    const insertPage = db.prepare("INSERT INTO checkpointPages (hash, text) VALUES (?, ?)");
    const selectPage = db.prepare("SELECT text FROM checkpointPages WHERE hash = ?");
    const insertCheckpoint = db.prepare(
        "INSERT INTO chatCheckpoints " +
            "(seq, chatSeq, id, kind, name, createdAt, revision, chatRevision, userTurns, messageCount, preview, " +
            "pages, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertRef = db.prepare("INSERT INTO checkpointPageRefs (checkpointSeq, hash) VALUES (?, ?)");
    const insertPolicy = db.prepare(
        "INSERT INTO chatCheckpointPolicy (chatSeq, autoEvery, autoKeep, lastAutoTurns) VALUES (?, ?, ?, ?)",
    );
    return {
        page(hash, text) {
            insertPage.run(hash, text);
        },
        pageText(hash) {
            return (selectPage.get(hash) as { text: string }).text;
        },
        checkpoint(row, hashes) {
            insertCheckpoint.run(
                row.seq,
                row.chatSeq,
                row.id,
                row.kind,
                row.name,
                row.createdAt,
                row.revision,
                row.chatRevision,
                row.userTurns,
                row.messageCount,
                row.preview,
                row.pages,
                row.fields,
            );
            for (const hash of hashes) {
                insertRef.run(row.seq, hash);
            }
        },
        policy(row) {
            insertPolicy.run(row.chatSeq, row.autoEvery, row.autoKeep, row.lastAutoTurns);
        },
        end() {
            db.exec(SWEEP_PAGES_SQL);
        },
    };
}

/**
 * Copies the staged checkpoint tables into the emptied live ones inside the caller's transaction, after
 * `copyStagedChats`, with the staged store attached as `staged`: the pages byte for byte, the
 * checkpoints by staged seq with fresh live seqs, onto the live chats through `STAGED_CHAT_SEQS`, then
 * their refs and the policies. `chatRestoreFloors` stays empty: floors are local to an epoch.
 */
export function copyStagedCheckpoints(db: DatabaseSync): void {
    db.exec(`
        INSERT INTO main.checkpointPages (hash, text) SELECT hash, text FROM staged.checkpointPages;
        INSERT INTO main.chatCheckpoints (chatSeq, id, kind, name, createdAt, revision, chatRevision, userTurns,
                messageCount, preview, pages, fields)
            SELECT seqs.liveSeq, c.id, c.kind, c.name, c.createdAt, c.revision, c.chatRevision, c.userTurns,
                    c.messageCount, c.preview, c.pages, c.fields
                FROM staged.chatCheckpoints c JOIN ${STAGED_CHAT_SEQS} seqs ON seqs.stagedSeq = c.chatSeq
                ORDER BY c.seq;
        CREATE TABLE temp.stagedCheckpointSeqs (stagedSeq INTEGER PRIMARY KEY, liveSeq INTEGER NOT NULL) STRICT;
        INSERT INTO temp.stagedCheckpointSeqs (stagedSeq, liveSeq)
            SELECT s.seq, l.seq FROM staged.chatCheckpoints s
                JOIN ${STAGED_CHAT_SEQS} seqs ON seqs.stagedSeq = s.chatSeq
                JOIN main.chatCheckpoints l ON l.chatSeq = seqs.liveSeq AND l.id = s.id;
        INSERT INTO main.checkpointPageRefs (checkpointSeq, hash)
            SELECT seqs.liveSeq, r.hash
                FROM staged.checkpointPageRefs r JOIN temp.stagedCheckpointSeqs seqs ON seqs.stagedSeq = r.checkpointSeq;
        DROP TABLE temp.stagedCheckpointSeqs;
        INSERT INTO main.chatCheckpointPolicy (chatSeq, autoEvery, autoKeep, lastAutoTurns)
            SELECT seqs.liveSeq, p.autoEvery, p.autoKeep, p.lastAutoTurns
                FROM staged.chatCheckpointPolicy p JOIN ${STAGED_CHAT_SEQS} seqs ON seqs.stagedSeq = p.chatSeq;
    `);
}
