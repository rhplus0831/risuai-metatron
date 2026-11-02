import { randomUUID } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Chat, Message } from "../../../shared/database.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    MEMORY_RECORD_KINDS,
    MEMORY_RUNS_ROUND_ROWS,
    STRUCTURED_MEMORY_PATH,
    storedMemorySources,
    type MemoryEvent,
    type MemoryPage,
    type StructuredMemoryAdoptAnswer,
    type StructuredMemoryContentsAnswer,
    type StructuredMemoryCoverageEvent,
    type StructuredMemoryCoverageRound,
    type StructuredMemoryCoverageRun,
    type StructuredMemoryEdit,
    type StructuredMemoryEditAnswer,
    type StructuredMemoryInheritAnswer,
    type StructuredMemoryLogRun,
    type StructuredMemoryPackageRound,
    type StructuredMemoryRecordAnswer,
    type StructuredMemoryRecordKind,
    type StructuredMemoryRecordOf,
    type StructuredMemoryRestoreAnswer,
    type StructuredMemoryRunsRound,
    type StructuredMemoryThreadsRound,
} from "../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { messageSourceHash } from "../data/memoryStore.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";
import { readJsonBody } from "../http/body.ts";
import { compressedJson } from "../http/compressedJson.ts";
import { adoptedEvents } from "../prompt/memory/structured/adopt.ts";
import {
    applyEventRepair,
    applyPageEdit,
    applyThreadEdit,
    MemoryEditRefusal,
    parseMemoryEdit,
} from "../prompt/memory/structured/edits.ts";
import { inheritedRecords } from "../prompt/memory/structured/inherit.ts";
import { withUnsupportedSections } from "../prompt/memory/structured/reconcile.ts";
import { parseRestoredRecords } from "../prompt/memory/structured/restore.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { limitedBody } from "./limitedBody.ts";
import { storeErrorResponse } from "./resources.ts";

export { STRUCTURED_MEMORY_PATH };

/** An edit holds one section at `sectionBodyChars`, which JSON's escapes can lengthen, and its ids. */
const MAX_EDIT_BODY_BYTES = 64 * 1024;

const REFUSAL_TEXT = {
    chatGone: "Chat not found",
    recordGone: "Record not found",
    fenced: "Something is writing this chat's memory",
} as const;

function isRecordKind(kind: string): kind is StructuredMemoryRecordKind {
    return (MEMORY_RECORD_KINDS as readonly string[]).includes(kind);
}

/** A round's starting position: 0 when absent, null for anything but a non-negative safe integer. */
function parseCursor(value: string | undefined): number | null {
    if (value === undefined) {
        return 0;
    }
    const cursor = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(cursor) ? cursor : null;
}

/**
 * The rows of one round over `listed` from position `cursor`, each charged its stored `bytes` before
 * anything reads its record: the first is served whatever its size, and the round stops before the row
 * that would pass `budget` or `rowCap`. `next` is the position to continue from, null at the list's end.
 */
function roundOf<Row extends { bytes: number }>(
    listed: readonly Row[],
    cursor: number,
    budget: number,
    rowCap = Infinity,
): { rows: Row[]; next: number | null } {
    let charged = 0;
    let index = cursor;
    for (; index < listed.length; index += 1) {
        const { bytes } = listed[index];
        if (index > cursor && (index - cursor >= rowCap || charged + bytes > budget)) {
            break;
        }
        charged += bytes;
    }
    return { rows: listed.slice(cursor, index), next: index < listed.length ? index : null };
}

/** The message ids of a stored source list, which the store does not check the shape of. */
function sourceIds(sources: unknown): string[] {
    return storedMemorySources(sources).map(({ messageId }) => messageId);
}

/** The smallest anchored position of a stored source list, which the store does not check the shape of. */
function firstSourceIndex(sources: unknown): number | null {
    let first: number | null = null;
    for (const source of Array.isArray(sources) ? sources : []) {
        const index: unknown = isPlainObject(source) ? source.index : null;
        if (Number.isSafeInteger(index) && (first === null || (index as number) < first)) {
            first = index as number;
        }
    }
    return first;
}

/** The id of the record `edit` addresses. */
function editedRecordId(edit: StructuredMemoryEdit): string {
    switch (edit.kind) {
        case "thread":
            return edit.threadId;
        case "event":
            return edit.eventId;
        default:
            return edit.pageId;
    }
}

/** What a round's answer reads: the chat's contents, the position it starts at, and a record that is listed. */
type RoundRead = {
    contents: StructuredMemoryContentsAnswer;
    cursor: number;
    read: <K extends StructuredMemoryRecordKind>(kind: K, id: string) => StructuredMemoryRecordOf[K];
};

/**
 * The per-chat structured memory routes (`shared/structuredMemory.ts`):
 *
 * - `GET /api/memory/structured/:characterId/:chatId`: the table of contents, answered
 *   `StructuredMemoryContentsAnswer`; 404 `chatGone`.
 * - `GET /api/memory/structured/:characterId/:chatId/records/:kind/:id`: one record as stored, answered
 *   `StructuredMemoryRecordAnswer`; 400 for an unknown kind, 404 `chatGone` or `recordGone`.
 * - `GET /api/memory/structured/:characterId/:chatId/package?cursor=N&revision=R`: one round of the
 *   list of the chat's pages followed by its events, in contents order from position `cursor` (default
 *   0), answered `StructuredMemoryPackageRound`. Records are sent whole. Each is charged its stored
 *   bytes: a round's first record is served whatever its size, and the round stops before the record
 *   that would pass `packageRoundBytes`. `next` is null when the list is done, and a cursor past its
 *   end answers empty lists. 400 for a cursor that is not a non-negative safe integer, 404 `chatGone`,
 *   and 409 `{ error, revision }` when `revision` is given and is not the current token, compared
 *   whole.
 * - `GET /api/memory/structured/:characterId/:chatId/coverage?cursor=N&revision=R`: one round of the
 *   list of the chat's events followed by its runs that are not `recorded`, in contents order, answered
 *   `StructuredMemoryCoverageRound`: what each says of its messages, with no error or message text. An
 *   event comes with its sources, its `keptState`, and its `rerecord` mark, as stored: the tab reconciles
 *   them with the messages it holds, so this reads no chat. The list comes from the contents, so a
 *   recorded run's body is never read. Bytes, `cursor`, `revision`, and the refusals work as in the
 *   package round.
 * - `GET /api/memory/structured/:characterId/:chatId/runs?cursor=N&revision=R`: one round of the chat's
 *   runs, newest first, answered `StructuredMemoryRunsRound`, each without `input` and
 *   `settingsFingerprint`. A round also stops at `MEMORY_RUNS_ROUND_ROWS` runs. Bytes, `cursor`,
 *   `revision`, and the refusals work as in the package round.
 * - `GET /api/memory/structured/:characterId/:chatId/threads?cursor=N&revision=R`: one round of the chat's
 *   threads, in contents order, whole as stored, answered `StructuredMemoryThreadsRound`: what a chat file
 *   takes beside the package rounds. Bytes, `cursor`, `revision`, and the refusals work as in the package
 *   round.
 * - `POST /api/memory/structured/:characterId/:chatId/edits` `{ revision, edit }`: one person's edit
 *   (`StructuredMemoryEdit`, `structured/edits.ts`), answered `StructuredMemoryEditAnswer`. An edit that
 *   changes nothing still names a revision, so a stale one is refused like any other. An event's repair
 *   reads the chat as stored, a `retract` excepted, which reads none. 400 for a malformed edit or one
 *   the record refuses, 404 `chatGone` or `recordGone` (a heading the page lacks too), 409
 *   `{ error, reason: "fenced" }` while `fenced` holds, 409 `{ error, reason: "changed" }` when a `keep`
 *   names a state the chat has left, and 409 `{ error, revision }` when `revision` is not the current
 *   token. The body is read after authentication and capped at 64 KiB.
 * - `POST /api/memory/structured/:characterId/:chatId/inherit` `{ sourceChatId }`: gives a copied or
 *   branched chat the records of the character's chat it came from, as far as its messages support them
 *   (`structured/inherit.ts`), answered `StructuredMemoryInheritAnswer`. The server builds them from the
 *   source chat, whose runs stay behind, and the tab sends no record. A new chat that holds a row of any
 *   kind, which is what a repeat finds, and a source that holds no page, event, or thread answer
 *   `inherited: false` and write nothing. 400 for a `sourceChatId` that is no id or is the chat itself,
 *   404 `chatGone` for either chat, and 409 `{ error, reason: "fenced" }` while `fenced` holds for the new
 *   chat. The source chat is not fenced. The body is read after authentication and capped at 64 KiB.
 * - `POST /api/memory/structured/:characterId/:chatId/restore` `{ pages, events, threads }`: gives an
 *   imported chat the records its file held, answered `StructuredMemoryRestoreAnswer`. It is the one route
 *   that writes records the tab sent, so it takes only their whole shape (`structured/restore.ts`) and only
 *   a chat with no rows: a chat that holds a row of any kind, runs included, and a request with no record
 *   answer `restored: false` and write nothing. Sources are not compared with the chat's messages, and a
 *   run never gets through. 400 for a body of another shape or a record the store refuses, 404 `chatGone`,
 *   and 409 `{ error, reason: "fenced" }` while `fenced` holds. The body is read after authentication and
 *   capped at `restoreBodyBytes`, 413 past it.
 * - `POST /api/memory/structured/:characterId/:chatId/adopt`, with no body: turns the summaries of the
 *   chat's stored `hypaV3Data` into events, with no model call (`structured/adopt.ts`), answered
 *   `StructuredMemoryAdoptAnswer`. The server reads the chat as stored, and the tab sends nothing. It
 *   writes no run and leaves `hypaV3Data` as it is. A chat that holds a page, event, or thread, which is
 *   what a repeat finds, and one with nothing adoptable answer `adopted: 0` and write nothing. Runs do not
 *   count, unlike the two routes above: a failed writer run leaves a run row and no record, so counting one
 *   would refuse adoption for good, and a pending run's task is what the fence holds off. 404 `chatGone`,
 *   and 409 `{ error, reason: "fenced" }` while `fenced` holds.
 *
 * All are authenticated, rate-limited, and epoch-checked (412 `EpochMismatch`); 400 for an id that is
 * not a resource id, 503 (`Retry-After`) when the store is closed. The app makes every answer
 * `no-store` and refuses them during shutdown. The epoch check and the store reads run in one
 * synchronous step, so a round is one snapshot; separate rounds are tied together only by `revision`.
 * An edit's, an inherit's, a restore's, or an adoption's checks and its write share one such step too,
 * after any body is read, so nothing can take the chat between the fence and the write, and no writer of
 * the source chat comes between its reads.
 */
export function registerStructuredMemoryRoutes(
    app: Hono<AppEnv>,
    arg: {
        store: ResourceStore;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        packageRoundBytes: number;
        /** The cap of a restore's body, which holds at once what rounds read one at a time. */
        restoreBodyBytes: number;
        /** Whether something that can write this chat's memory holds the chat, which refuses an edit, an inherit, a restore, or an adoption. */
        fenced: (characterId: string, chatId: string) => boolean;
    },
) {
    const { store, auth, limiter, packageRoundBytes, restoreBodyBytes, fenced } = arg;
    const limitBody = limitedBody(MAX_EDIT_BODY_BYTES);
    const limitRestoreBody = limitedBody(restoreBodyBytes);
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId`, limiter, authenticated, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const contents = store.memory.readContents(characterId, chatId);
            if (!contents) {
                return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
            }
            return compressedJson(c, contents satisfies StructuredMemoryContentsAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/records/:kind/:id`, limiter, authenticated, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        const kind = c.req.param("kind");
        const id = c.req.param("id");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId) || !isValidResourceId(id)) {
            return c.json({ error: "characterId, chatId, and id must be ids" }, 400);
        }
        if (!isRecordKind(kind)) {
            return c.json({ error: `kind must be one of ${MEMORY_RECORD_KINDS.join(", ")}` }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const record = store.memory.readRecord(characterId, chatId, kind, id);
            if (!record) {
                const reason = store.chatRevision(characterId, chatId) === null ? "chatGone" : "recordGone";
                return c.json({ error: REFUSAL_TEXT[reason], reason }, 404);
            }
            return compressedJson(c, record satisfies StructuredMemoryRecordAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    /** A record the chat's contents list, read in the same synchronous step as them, so nothing can remove it. */
    const listedRecord = <K extends StructuredMemoryRecordKind>(
        characterId: string,
        chatId: string,
        kind: K,
        id: string,
    ): StructuredMemoryRecordOf[K] => {
        const record = store.memory.readRecord(characterId, chatId, kind, id);
        if (!record) {
            throw new Error(`Memory ${kind} ${JSON.stringify(id)} is listed but has no row`);
        }
        return record.data;
    };

    /**
     * Answers one round of a budgeted read: the checks every such route shares, then `answer`, in one
     * synchronous step.
     */
    const answerRound = async (c: Context<AppEnv>, answer: (round: RoundRead) => object) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const cursor = parseCursor(c.req.query("cursor"));
        if (cursor === null) {
            return c.json({ error: "cursor must be a non-negative integer" }, 400);
        }
        const revision = c.req.query("revision");
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const contents = store.memory.readContents(characterId, chatId);
            if (!contents) {
                return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
            }
            if (revision !== undefined && revision !== contents.revision) {
                return c.json({ error: "The chat's memory changed", revision: contents.revision }, 409);
            }
            const read: RoundRead["read"] = (kind, id) => listedRecord(characterId, chatId, kind, id);
            return compressedJson(c, answer({ contents, cursor, read }));
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    };

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/package`, limiter, authenticated, (c) =>
        answerRound(c, ({ contents, cursor, read }) => {
            const listed = [
                ...contents.pages.map(({ id, bytes }) => ({ kind: "pages", id, bytes }) as const),
                ...contents.events.map(({ id, bytes }) => ({ kind: "events", id, bytes }) as const),
            ];
            const { rows, next } = roundOf(listed, cursor, packageRoundBytes);
            const pages: MemoryPage[] = [];
            const events: MemoryEvent[] = [];
            for (const { kind, id } of rows) {
                if (kind === "pages") {
                    pages.push(read(kind, id));
                } else {
                    events.push(read(kind, id));
                }
            }
            return { revision: contents.revision, pages, events, next } satisfies StructuredMemoryPackageRound;
        }),
    );

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/coverage`, limiter, authenticated, (c) =>
        answerRound(c, ({ contents, cursor, read }) => {
            const listed = [
                ...contents.events.map(({ id, bytes }) => ({ kind: "events", id, bytes }) as const),
                ...contents.runs
                    .filter(({ result }) => result !== "recorded")
                    .map(({ id, bytes }) => ({ kind: "runs", id, bytes }) as const),
            ];
            const { rows, next } = roundOf(listed, cursor, packageRoundBytes);
            const events: StructuredMemoryCoverageEvent[] = [];
            const runs: StructuredMemoryCoverageRun[] = [];
            for (const { kind, id } of rows) {
                if (kind === "events") {
                    const { title, status, staleReason, suppressed, keptState, rerecord, sources } = read(kind, id);
                    events.push({
                        id,
                        title,
                        status,
                        staleReason,
                        suppressed,
                        keptState,
                        rerecord,
                        messageIds: sourceIds(sources),
                        sourceIndex: firstSourceIndex(sources),
                        sources: storedMemorySources(sources),
                    });
                } else {
                    const { result, reason, receipt, window } = read(kind, id);
                    runs.push({ id, result, reason: reason ?? receipt?.reason, messageIds: sourceIds(window) });
                }
            }
            return { revision: contents.revision, events, runs, next } satisfies StructuredMemoryCoverageRound;
        }),
    );

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/runs`, limiter, authenticated, (c) =>
        answerRound(c, ({ contents, cursor, read }) => {
            const newestFirst = [...contents.runs].reverse();
            const { rows, next } = roundOf(newestFirst, cursor, packageRoundBytes, MEMORY_RUNS_ROUND_ROWS);
            const runs = rows.map(({ id }): StructuredMemoryLogRun => {
                const { input, settingsFingerprint, ...logged } = read("runs", id);
                return logged;
            });
            return {
                revision: contents.revision,
                total: contents.runs.length,
                runs,
                next,
            } satisfies StructuredMemoryRunsRound;
        }),
    );

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/threads`, limiter, authenticated, (c) =>
        answerRound(c, ({ contents, cursor, read }) => {
            const { rows, next } = roundOf(contents.threads, cursor, packageRoundBytes);
            return {
                revision: contents.revision,
                threads: rows.map(({ id }) => read("threads", id)),
                next,
            } satisfies StructuredMemoryThreadsRound;
        }),
    );

    app.post(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/edits`, limiter, authenticated, limitBody, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body)) {
            return c.json({ error: "The body must be an object" }, 400);
        }
        const { revision } = read.body;
        if (typeof revision !== "string") {
            return c.json({ error: "revision must be a string" }, 400);
        }
        const edit = parseMemoryEdit(read.body.edit);
        if (!edit || !isValidResourceId(editedRecordId(edit))) {
            return c.json({ error: "edit is not a valid memory edit" }, 400);
        }
        const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
        if (epoch !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (fenced(characterId, chatId)) {
            return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
        }
        const gone = () => {
            const reason = store.chatRevision(characterId, chatId) === null ? "chatGone" : "recordGone";
            return c.json({ error: REFUSAL_TEXT[reason], reason }, 404);
        };
        const options = { epoch, baseRevision: revision };
        try {
            if (edit.kind === "thread") {
                const stored = store.memory.readRecord(characterId, chatId, "threads", edit.threadId);
                if (!stored) {
                    return gone();
                }
                const edited = applyThreadEdit(stored.data, edit);
                const written = store.memory.write(characterId, chatId, options, edited ? { threads: [edited] } : {});
                return compressedJson(c, {
                    revision: written,
                    kind: "threads",
                    data: edited ?? stored.data,
                } satisfies StructuredMemoryEditAnswer);
            }
            if (edit.kind === "event") {
                const stored = store.memory.readRecord(characterId, chatId, "events", edit.eventId);
                if (!stored) {
                    return gone();
                }
                let messages: readonly Message[] = [];
                if (edit.repair !== "retract") {
                    const chat = store.readChatSource(characterId, chatId).data as Chat | null;
                    if (!chat) {
                        return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
                    }
                    messages = chat.message;
                }
                const edited = applyEventRepair(stored.data, edit, messages, messageSourceHash);
                const written = store.memory.write(
                    characterId,
                    chatId,
                    options,
                    edited ? withUnsupportedSections(store, { chaId: characterId, chatId }, { events: [edited] }) : {},
                );
                return compressedJson(c, {
                    revision: written,
                    kind: "events",
                    data: edited ?? stored.data,
                } satisfies StructuredMemoryEditAnswer);
            }
            const stored = store.memory.readRecord(characterId, chatId, "pages", edit.pageId);
            if (!stored) {
                return gone();
            }
            const edited = applyPageEdit(stored.data, edit, { now: Date.now(), newId: randomUUID });
            const written = store.memory.write(characterId, chatId, options, edited ? { pages: [edited] } : {});
            return compressedJson(c, {
                revision: written,
                kind: "pages",
                data: edited ?? stored.data,
            } satisfies StructuredMemoryEditAnswer);
        } catch (error) {
            if (error instanceof MemoryEditRefusal) {
                if (error.reason === "changed") {
                    return c.json({ error: error.message, reason: "changed" }, 409);
                }
                return error.reason === "sectionGone" ? gone() : c.json({ error: error.message }, 400);
            }
            return storeErrorResponse(c, error);
        }
    });

    app.post(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/inherit`, limiter, authenticated, limitBody, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body)) {
            return c.json({ error: "The body must be an object" }, 400);
        }
        const { sourceChatId } = read.body;
        if (!isValidResourceId(sourceChatId) || sourceChatId === chatId) {
            return c.json({ error: "sourceChatId must be the id of another chat" }, 400);
        }
        const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
        if (epoch !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (fenced(characterId, chatId)) {
            return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
        }
        const gone = () => c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
        try {
            const contents = store.memory.readContents(characterId, chatId);
            if (!contents) {
                return gone();
            }
            const { revision } = contents;
            const nothingToBuild = { revision, inherited: false } satisfies StructuredMemoryInheritAnswer;
            if ([contents.pages, contents.events, contents.threads, contents.runs].some(({ length }) => length > 0)) {
                return compressedJson(c, nothingToBuild);
            }
            const source = store.memory.readContents(characterId, sourceChatId);
            if (!source) {
                return gone();
            }
            if ([source.pages, source.events, source.threads].every(({ length }) => length === 0)) {
                return compressedJson(c, nothingToBuild);
            }
            const sourceChat = store.readChatSource(characterId, sourceChatId).data as Chat | null;
            const chat = store.readChatSource(characterId, chatId).data as Chat | null;
            if (!sourceChat || !chat) {
                return gone();
            }
            const changes = inheritedRecords({
                pages: source.pages.map(({ id }) => listedRecord(characterId, sourceChatId, "pages", id)),
                events: source.events.map(({ id }) => listedRecord(characterId, sourceChatId, "events", id)),
                threads: source.threads.map(({ id }) => listedRecord(characterId, sourceChatId, "threads", id)),
                sourceMessages: sourceChat.message,
                messages: chat.message,
                hashOf: messageSourceHash,
            });
            return compressedJson(c, {
                revision: store.memory.write(characterId, chatId, { epoch, baseRevision: revision }, changes),
                inherited: true,
            } satisfies StructuredMemoryInheritAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.post(
        `${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/restore`,
        limiter,
        authenticated,
        limitRestoreBody,
        async (c) => {
            const characterId = c.req.param("characterId");
            const chatId = c.req.param("chatId");
            if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
                return c.json({ error: "characterId and chatId must be ids" }, 400);
            }
            const read = await readJsonBody(c);
            if (!read.ok) {
                return read.response;
            }
            const records = parseRestoredRecords(read.body);
            if (!records) {
                return c.json({ error: "The body must hold whole pages, events, and threads" }, 400);
            }
            const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
            if (epoch !== store.epoch()) {
                return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
            }
            if (fenced(characterId, chatId)) {
                return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
            }
            try {
                const contents = store.memory.readContents(characterId, chatId);
                if (!contents) {
                    return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
                }
                const { revision } = contents;
                const { pages, events, threads } = records;
                if (
                    [contents.pages, contents.events, contents.threads, contents.runs].some(
                        ({ length }) => length > 0,
                    ) ||
                    [pages, events, threads].every(({ length }) => length === 0)
                ) {
                    return compressedJson(c, { revision, restored: false } satisfies StructuredMemoryRestoreAnswer);
                }
                const options = { epoch, baseRevision: revision };
                return compressedJson(c, {
                    revision: store.memory.write(characterId, chatId, options, { pages, events, threads }),
                    restored: true,
                } satisfies StructuredMemoryRestoreAnswer);
            } catch (error) {
                return storeErrorResponse(c, error);
            }
        },
    );

    app.post(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/adopt`, limiter, authenticated, limitBody, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
        if (epoch !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (fenced(characterId, chatId)) {
            return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
        }
        const gone = () => c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
        try {
            const contents = store.memory.readContents(characterId, chatId);
            if (!contents) {
                return gone();
            }
            const { revision } = contents;
            const nothingAdopted = { revision, adopted: 0, stale: 0 } satisfies StructuredMemoryAdoptAnswer;
            if ([contents.pages, contents.events, contents.threads].some(({ length }) => length > 0)) {
                return compressedJson(c, nothingAdopted);
            }
            const chat = store.readChatSource(characterId, chatId).data as Chat | null;
            if (!chat) {
                return gone();
            }
            const events = adoptedEvents({
                data: chat.hypaV3Data,
                messages: chat.message,
                hashOf: messageSourceHash,
                newId: randomUUID,
            });
            if (events.length === 0) {
                return compressedJson(c, nothingAdopted);
            }
            return compressedJson(c, {
                revision: store.memory.write(characterId, chatId, { epoch, baseRevision: revision }, { events }),
                adopted: events.length,
                stale: events.filter(({ status }) => status === "stale").length,
            } satisfies StructuredMemoryAdoptAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });
}
