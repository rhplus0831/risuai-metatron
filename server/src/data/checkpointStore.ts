import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
    CHECKPOINT_CHAT_FIELDS,
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
    CheckpointPolicy,
    CheckpointPolicyState,
    CheckpointPreview,
    CheckpointSummary,
} from "../../../shared/chatCheckpoints.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { nextRevision, ResourceConflictError, ResourceValidationError } from "./resourceStore.ts";

/**
 * Checkpoints belong to a chat incarnation; deleting it cascades to checkpoints, refs, and policy.
 * Content pages are shared across chats and collected separately, after their last ref disappears.
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
 * the owner can count only committed writes. The single-statement sweep also works in autocommit.
 */
export function createCheckpointTables(db: DatabaseSync, tokens: TokenFunctions) {
    db.exec(CHECKPOINT_TABLES_SQL);
    const selectChat = db.prepare("SELECT seq, revision, meta FROM chats WHERE characterId = ? AND id = ?");
    const selectMessages = db.prepare("SELECT id, data FROM messages WHERE chatSeq = ? ORDER BY position");
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
    const pruneCheckpoints = db.prepare(
        "DELETE FROM chatCheckpoints WHERE seq IN " +
            "(SELECT seq FROM chatCheckpoints WHERE chatSeq = ? AND kind = ? ORDER BY seq DESC LIMIT -1 OFFSET ?)",
    );
    const sweepPages = db.prepare(
        "DELETE FROM checkpointPages WHERE NOT EXISTS " +
            "(SELECT 1 FROM checkpointPageRefs r WHERE r.hash = checkpointPages.hash)",
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

    /** Returns the number of unreferenced content pages removed. */
    function sweep(): number {
        return Number(sweepPages.run().changes);
    }

    return {
        /** Captures stored message text and story fields without changing the chat. Missing chat: null. */
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
            const preview: CheckpointPreview = {
                messages: [],
                summaries:
                    isPlainObject(meta.hypaV3Data) && Array.isArray(meta.hypaV3Data.summaries)
                        ? meta.hypaV3Data.summaries.length
                        : 0,
                loreEntries: Array.isArray(meta.localLore) ? meta.localLore.length : 0,
                variables: isPlainObject(meta.scriptstate) ? Object.keys(meta.scriptstate).length : 0,
            };
            const pages: string[] = [];
            let rowTexts: string[] = [];
            let pageBytes = 0;
            let userTurns = 0;
            let messageCount = 0;
            for (const row of selectMessages.iterate(chat.seq) as Iterable<{ id: string; data: string }>) {
                rowTexts.push(row.data);
                pageBytes += Buffer.byteLength(row.data, "utf8");
                const message = JSON.parse(row.data) as Message;
                messageCount += 1;
                if (message.role === "user") {
                    userTurns += 1;
                }
                preview.messages.push({
                    role: message.role,
                    text:
                        typeof message.data === "string"
                            ? truncateCheckpointText(message.data, CHECKPOINT_PREVIEW_TEXT_LENGTH)
                            : "",
                });
                if (preview.messages.length > 2) {
                    preview.messages.shift();
                }
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
            for (const hash of new Set([...pages, ...Object.values(fields)])) {
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

        /** Keeps the newest `keep` checkpoints of this kind, then sweeps. A missing chat changes nothing. */
        prune(characterId: string, chatId: string, kind: CheckpointKind, keep: number) {
            assertKind(kind);
            if (!Number.isSafeInteger(keep) || keep < 0) {
                throw new ResourceValidationError("Checkpoint keep must be a non-negative safe integer");
            }
            const chat = selectChat.get(characterId, chatId) as ChatRow | undefined;
            if (!chat) {
                return { deleted: 0, pagesRemoved: 0 };
            }
            const deleted = Number(pruneCheckpoints.run(chat.seq, kind, keep).changes);
            return { deleted, pagesRemoved: sweep() };
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

        /** Deletes at exactly the supplied revision and sweeps; missing chat or checkpoint: null. */
        delete(characterId: string, chatId: string, id: string, baseRevision: string) {
            const row = findCheckpoint(characterId, chatId, id);
            if (!row) {
                return null;
            }
            assertRevision(row, baseRevision);
            deleteCheckpoint.run(row.seq);
            return { deleted: true, pagesRemoved: sweep() };
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
