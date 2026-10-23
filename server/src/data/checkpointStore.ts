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
import { normalizeChatMeta, normalizeMessage } from "./chats.ts";
import {
    isValidResourceId,
    nextRevision,
    ResourceConflictError,
    ResourceValidationError,
    serialize,
} from "./resourceStore.ts";

/**
 * Checkpoints belong to a chat incarnation; deleting it cascades to checkpoints, refs, and policy.
 * Content pages are shared across chats and collected separately, after their last ref disappears.
 * Snapshots carry all four tables together; restore replaces them on the restored chat incarnations.
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

/** Validated snapshot rows, with stored JSON and page text unchanged; refs are rebuilt from manifests. */
export type CheckpointSnapshotRows = {
    readonly checkpoints: readonly (CheckpointRow & { chatSeq: number; chatRevision: string })[];
    readonly pages: readonly { hash: string; text: string }[];
    readonly policies: readonly (CheckpointPolicyState & { chatSeq: number })[];
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
    const insertRestoredCheckpoint = db.prepare(
        "INSERT INTO chatCheckpoints " +
            "(chatSeq, id, kind, name, createdAt, revision, chatRevision, userTurns, messageCount, preview, pages, fields) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

        /** Replaces pages and restores checkpoints and policies after the chat cascade, in the same transaction. */
        replaceAll(rows: CheckpointSnapshotRows | undefined, chatSeqs: ReadonlyMap<number, number>) {
            db.exec("DELETE FROM checkpointPages");
            if (!rows) {
                return;
            }
            for (const page of rows.pages) {
                insertPage.run(page.hash, page.text);
            }
            for (const row of rows.checkpoints) {
                const result = insertRestoredCheckpoint.run(
                    chatSeqs.get(row.chatSeq)!,
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
                const pages = JSON.parse(row.pages) as string[];
                const fields = JSON.parse(row.fields) as Record<string, string>;
                for (const hash of new Set([...pages, ...Object.values(fields)])) {
                    insertRef.run(Number(result.lastInsertRowid), hash);
                }
            }
            for (const row of rows.policies) {
                upsertPolicy.run(chatSeqs.get(row.chatSeq)!, row.autoEvery, row.autoKeep, row.lastAutoTurns);
            }
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

/**
 * Reads the optional checkpoint table group, checking every row and each distinct use of a content page.
 * Returns stored texts verbatim, checkpoints in seq order, and only referenced pages. An absent
 * group or empty result is undefined; a partial group or inconsistent row is a ResourceValidationError.
 */
export function readCheckpointSnapshotRows(
    source: DatabaseSync,
    chats: readonly { seq: number; id: string }[],
): CheckpointSnapshotRows | undefined {
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
        return undefined;
    }
    if (present !== tables.length) {
        throw new ResourceValidationError("Incomplete checkpoint tables in resource database");
    }

    function readRows(table: string, order: string): Record<string, unknown>[] {
        try {
            return source.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[];
        } catch {
            throw new ResourceValidationError(`${table}: cannot read checkpoint rows`);
        }
    }

    const pageTexts = new Map<string, string>();
    for (const [index, row] of readRows("checkpointPages", "hash").entries()) {
        const where = `checkpointPages row ${index + 1}`;
        if (typeof row.hash !== "string" || typeof row.text !== "string") {
            throw new ResourceValidationError(`${where}: hash and text must be strings`);
        }
        if (pageTexts.has(row.hash)) {
            throw new ResourceValidationError(`${where}: duplicate hash`);
        }
        if (createHash("sha256").update(row.text, "utf8").digest("hex") !== row.hash) {
            throw new ResourceValidationError(`${where}: hash does not match text`);
        }
        pageTexts.set(row.hash, row.text);
    }

    const chatIds = new Map(chats.map((chat) => [chat.seq, chat.id]));
    const checkpointKeys = new Set<string>();
    const expectedRefs = new Map<number, Set<string>>();
    const messagePageIds = new Map<string, string[]>();
    const validatedFieldPages = new Set<string>();
    const checkpoints = readRows("chatCheckpoints", "seq").map((row, index) => {
        const where = `chatCheckpoints row ${index + 1}`;
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
                return (behavior === "capture" || behavior === "split") && typeof hash === "string";
            })
        ) {
            throw new ResourceValidationError(`${where}: fields must map captured field names to hashes`);
        }
        const hashes = new Set([...pages, ...Object.values(fields)] as string[]);
        for (const hash of hashes) {
            if (!pageTexts.has(hash)) {
                throw new ResourceValidationError(`${where}: no such checkpointPages hash ${hash}`);
            }
        }
        expectedRefs.set(row.seq, hashes);
        try {
            const messageIds = new Set<string>();
            for (const hash of pages) {
                let ids = messagePageIds.get(hash);
                if (!ids) {
                    const messages = snapshotJson(pageTexts.get(hash)!, `message page ${hash}`);
                    if (!Array.isArray(messages)) {
                        throw new ResourceValidationError(`message page ${hash} must be an array`);
                    }
                    ids = messages.map((input) => {
                        // Check the original element before normalization; the page adds no depth to a message.
                        const message = normalizeMessage(serialize(input).stored);
                        return message.chatId as string;
                    });
                    messagePageIds.set(hash, ids);
                }
                for (const id of ids) {
                    if (messageIds.has(id)) {
                        throw new ResourceValidationError("duplicate message id across checkpoint pages");
                    }
                    messageIds.add(id);
                }
            }
            for (const [key, hash] of Object.entries(fields)) {
                const fieldPage = `${key}\u0000${hash}`;
                if (validatedFieldPages.has(fieldPage)) {
                    continue;
                }
                const value = snapshotJson(pageTexts.get(hash as string)!, `field page ${key}`);
                if (
                    CHECKPOINT_CHAT_FIELDS[key as keyof typeof CHECKPOINT_CHAT_FIELDS] === "split" &&
                    (!isPlainObject(value) || Object.keys(value).some(isToggleKey))
                ) {
                    throw new ResourceValidationError(`${key} must be an object without toggle entries`);
                }
                // Captured metadata checks are per field; the wrapper preserves the stored nesting depth.
                normalizeChatMeta(serialize({ [key]: value }).stored, chatIds.get(row.chatSeq)!);
                validatedFieldPages.add(fieldPage);
            }
        } catch (error) {
            throw new ResourceValidationError(
                `${where}: ${error instanceof ResourceValidationError ? error.message : "invalid checkpoint content"}`,
            );
        }
        return {
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
        } satisfies CheckpointSnapshotRows["checkpoints"][number];
    });

    const actualRefs = new Map<number, Set<string>>();
    const referencedPages = new Set<string>();
    for (const [index, row] of readRows("checkpointPageRefs", "checkpointSeq, hash").entries()) {
        const where = `checkpointPageRefs row ${index + 1}`;
        if (typeof row.checkpointSeq !== "number" || !expectedRefs.has(row.checkpointSeq)) {
            throw new ResourceValidationError(`${where}: no such checkpoint`);
        }
        if (typeof row.hash !== "string" || !pageTexts.has(row.hash)) {
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
    for (const [index, row] of checkpoints.entries()) {
        if ((actualRefs.get(row.seq)?.size ?? 0) !== expectedRefs.get(row.seq)!.size) {
            throw new ResourceValidationError(`chatCheckpoints row ${index + 1}: missing checkpointPageRefs`);
        }
    }

    const policyChats = new Set<number>();
    const policies = readRows("chatCheckpointPolicy", "chatSeq").map((row, index) => {
        const where = `chatCheckpointPolicy row ${index + 1}`;
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
        return {
            chatSeq: row.chatSeq,
            autoEvery: row.autoEvery,
            autoKeep: row.autoKeep,
            lastAutoTurns: row.lastAutoTurns,
        };
    });
    if (checkpoints.length === 0 && policies.length === 0) {
        return undefined;
    }
    const pages = [...referencedPages].map((hash) => ({ hash, text: pageTexts.get(hash)! }));
    return { checkpoints, pages, policies };
}
