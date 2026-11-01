import type { Context, Hono, MiddlewareHandler } from "hono";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    MEMORY_RECORD_KINDS,
    MEMORY_RUNS_ROUND_ROWS,
    STRUCTURED_MEMORY_PATH,
    type MemoryEvent,
    type MemoryPage,
    type StructuredMemoryContentsAnswer,
    type StructuredMemoryCoverageEvent,
    type StructuredMemoryCoverageRound,
    type StructuredMemoryCoverageRun,
    type StructuredMemoryLogRun,
    type StructuredMemoryPackageRound,
    type StructuredMemoryRecordAnswer,
    type StructuredMemoryRecordKind,
    type StructuredMemoryRecordOf,
    type StructuredMemoryRunsRound,
} from "../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";
import { compressedJson } from "../http/compressedJson.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { storeErrorResponse } from "./resources.ts";

export { STRUCTURED_MEMORY_PATH };

const REFUSAL_TEXT = {
    chatGone: "Chat not found",
    recordGone: "Record not found",
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
    return Array.isArray(sources)
        ? sources.flatMap((source) =>
              isPlainObject(source) && typeof source.messageId === "string" ? [source.messageId] : [],
          )
        : [];
}

/** What a round's answer reads: the chat's contents, the position it starts at, and a record that is listed. */
type RoundRead = {
    contents: StructuredMemoryContentsAnswer;
    cursor: number;
    read: <K extends StructuredMemoryRecordKind>(kind: K, id: string) => StructuredMemoryRecordOf[K];
};

/**
 * The per-chat structured memory reads (`shared/structuredMemory.ts`):
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
 *   `StructuredMemoryCoverageRound`: what each says of its messages, with no error or message text. The
 *   list comes from the contents, so a recorded run's body is never read. Bytes, `cursor`, `revision`,
 *   and the refusals work as in the package round.
 * - `GET /api/memory/structured/:characterId/:chatId/runs?cursor=N&revision=R`: one round of the chat's
 *   runs, newest first, answered `StructuredMemoryRunsRound`, each without `input` and
 *   `settingsFingerprint`. A round also stops at `MEMORY_RUNS_ROUND_ROWS` runs. Bytes, `cursor`,
 *   `revision`, and the refusals work as in the package round.
 *
 * All are authenticated, rate-limited, and epoch-checked (412 `EpochMismatch`); 400 for an id that is
 * not a resource id, 503 (`Retry-After`) when the store is closed. The app makes every answer
 * `no-store` and refuses them during shutdown. The epoch check and the store reads run in one
 * synchronous step, so a round is one snapshot; separate rounds are tied together only by `revision`.
 */
export function registerStructuredMemoryRoutes(
    app: Hono<AppEnv>,
    arg: {
        store: ResourceStore;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        packageRoundBytes: number;
    },
) {
    const { store, auth, limiter, packageRoundBytes } = arg;
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
            const read: RoundRead["read"] = (kind, id) => {
                const record = store.memory.readRecord(characterId, chatId, kind, id);
                if (!record) {
                    // The listing and this read share one synchronous step, so nothing can remove it.
                    throw new Error(`Memory ${kind} ${JSON.stringify(id)} is listed but has no row`);
                }
                return record.data;
            };
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
                    const { title, status, staleReason, suppressed, sources } = read(kind, id);
                    events.push({ id, title, status, staleReason, suppressed, messageIds: sourceIds(sources) });
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
}
