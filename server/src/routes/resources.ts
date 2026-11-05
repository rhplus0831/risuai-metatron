import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ChatStreamingSnapshot } from "../../../shared/events.ts";
import {
    MAX_BOOT_BODY_BYTES,
    MAX_READ_RESPONSE_BYTES,
    RESOURCE_BOOT_PATH,
    RESOURCE_EPOCH_HEADER,
} from "../../../shared/resources.ts";
import type { ResourceReadEntries, ResourceReadRefsResult } from "../../../shared/resources.ts";
import type { ResourceKind, ResourceKindRegistry } from "../data/kinds.ts";
import {
    isValidResourceId,
    ResourceBatchConflictError,
    type ResourceBatchOperation,
    ResourceConflictError,
    ResourceEpochError,
    type ResourceStore,
    ResourceStoreClosedError,
    ResourceValidationError,
} from "../data/resourceStore.ts";
import { MaintenanceError, type MaintenanceGate } from "../data/snapshots.ts";
import { readJsonBody } from "../http/body.ts";
import { compressedJson } from "../http/compressedJson.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { limitedBody } from "./limitedBody.ts";
import { parseBootRequest, readBoot } from "./resourceBoot.ts";

/** Most operations one batch or one read may name. */
export const MAX_BATCH_OPERATIONS = 5000;
export const RESOURCE_READ_PATH = "/api/resources/read";
/**
 * A read's body cap, also bounding named row and metadata lists. A request of 5,000 entries of two
 * ids of 512 units at up to 3 UTF-8 bytes each is about 15.4 million bytes before framing, and an
 * older tab may send it.
 */
export const MAX_READ_BODY_BYTES = 32 * 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `/api/resources` over the resource store. Reads return the database `epoch`; every mutation must
 * send it in `x-resource-epoch` (412 otherwise, so nothing based on data from before a restore can
 * land), is refused with 503 while the maintenance gate is closed (`data/snapshots.ts`), and names
 * the revision it was based on (`baseRevision`: null to create); a stale one is a 409 carrying the
 * current revision (null when the record is gone). A batch op may be a record patch instead of whole
 * data (`patch`, with a string `baseRevision`; see `ResourceBatchOperation`). The batch also carries
 * chat groups and reorders, and the reads chats, named rows, and chat collections (`shared/chats.ts`). With a
 * streaming source, whole chats carry authoritative lock lists sampled in the same synchronous step
 * as the read; summaries, row reads and missing chats do not. Whole-chat reads answer a structured
 * chat's `hypaV3Data` with its projection, which only these routes ask for (`memoryProjection`),
 * so a tab's plugins read it from the chat they hold. Row reads use stored metadata.
 * `POST /api/resources/read` lists each named entry once. With `continue: true`, it uses a soft
 * stored-byte budget (`readResponseBytes`, default `MAX_READ_RESPONSE_BYTES`): the first group is
 * always served whole; groups left out are named in `unanswered` (`ResourceReadRefsAnswer`).
 * An edit of a message a generation job owns is a 409 whose entry
 * (or, on the single routes, whose body) carries `reason: "generating"`. Responses passing this
 * module's noStore middleware receive no-store; the earlier global body limiter in `server/src/app.ts`
 * can refuse a request before that middleware runs.
 */
export function registerResourceRoutes(
    app: Hono<AppEnv>,
    arg: {
        store: ResourceStore;
        kinds: ResourceKindRegistry;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maintenance: MaintenanceGate;
        /** The same synchronous generation-lock snapshot used by the live-update `hello`. */
        streaming?: () => ChatStreamingSnapshot[];
        /** A read's body cap (default `MAX_READ_BODY_BYTES`; tests lower it). */
        readBodyBytes?: number;
        /** A `continue: true` read's budget in charged bytes (default `MAX_READ_RESPONSE_BYTES`; tests lower it). */
        readResponseBytes?: number;
    },
) {
    const {
        store,
        kinds,
        auth,
        limiter,
        maintenance,
        streaming,
        readBodyBytes = MAX_READ_BODY_BYTES,
        readResponseBytes = MAX_READ_RESPONSE_BYTES,
    } = arg;

    const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
        await next();
        c.header("Cache-Control", "no-store");
    };
    app.use("/api/resources", noStore);
    app.use("/api/resources/*", noStore);

    /** Throws unless mutations are open and the request names the current epoch. Call right before the write. */
    function assertMutable(c: Context<AppEnv>) {
        maintenance.assertOpen();
        store.assertEpoch(c.req.header(RESOURCE_EPOCH_HEADER));
    }

    /** What a client reads of a record: the kind's projection (a write-only kind's masked view). */
    const project = (kind: ResourceKind | undefined, data: unknown) =>
        kind?.project && data !== null && data !== undefined ? kind.project(data) : data;

    /**
     * A plain write's data for a kind with `prepareWrite` (from the stored record, read in the
     * same synchronous block as the write: no await before the store call).
     */
    const prepare = (kind: ResourceKind, id: string, data: unknown) =>
        kind.prepareWrite ? kind.prepareWrite(data, store.get(kind, id)?.data ?? null) : data;

    /** Decorates whole chats without yielding after the store read, indexing one snapshot per response. */
    function addStreaming(read: Pick<ResourceReadRefsResult, "chats" | "chatCollections">) {
        if (!streaming || (!read.chats && !read.chatCollections)) return;
        const byChat = new Map(streaming().map((chat) => [`${chat.characterId}\u0000${chat.id}`, chat.streaming]));
        for (const chat of read.chats ?? []) {
            if (chat.revision !== null) {
                chat.streaming = byChat.get(`${chat.characterId}\u0000${chat.id}`) ?? [];
            }
        }
        for (const collection of read.chatCollections ?? []) {
            for (const chat of collection.chats) {
                chat.streaming = byChat.get(`${chat.characterId}\u0000${chat.id}`) ?? [];
            }
        }
    }

    /**
     * GET ?kinds=a,b[&chats=1|&chatSummaries=1] returns one committed state:
     * { epoch, kinds: { [kind]: [{ id, revision, data }] }, chats?, chatSummaries?, chatOrders? }.
     * Kinds are projected (credentials masked), compressed by `http/compressedJson.ts` according to
     * Accept-Encoding. 400 for missing/unknown kinds, a chat option other than 1, or both chat options.
     */
    app.get("/api/resources", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const names = [...new Set((c.req.query("kinds") ?? "").split(",").filter((name) => name !== ""))];
        if (names.length === 0) {
            return c.json({ error: "kinds query parameter required" }, 400);
        }
        const selected: ResourceKind[] = [];
        for (const name of names) {
            const kind = kinds.get(name);
            if (!kind) {
                return c.json({ error: `Unknown resource kind: ${name}` }, 400);
            }
            selected.push(kind);
        }
        const chats = c.req.query("chats");
        if (chats !== undefined && chats !== "1") {
            return c.json({ error: "chats query parameter must be 1" }, 400);
        }
        const chatSummaries = c.req.query("chatSummaries");
        if (chatSummaries !== undefined && chatSummaries !== "1") {
            return c.json({ error: "chatSummaries query parameter must be 1" }, 400);
        }
        if (chats !== undefined && chatSummaries !== undefined) {
            return c.json({ error: "chats and chatSummaries cannot be combined" }, 400);
        }
        const read = store.readKinds(selected, {
            chats: chats === "1",
            chatSummaries: chatSummaries === "1",
            memoryProjection: true,
        });
        addStreaming(read);
        for (const kind of selected) {
            if (kind.project) {
                read.kinds[kind.name] = read.kinds[kind.name].map((record) => ({
                    ...record,
                    data: project(kind, record.data),
                }));
            }
        }
        return compressedJson(c, read);
    });

    // The read and the boot read authenticate before their own body caps, so the app's 100 MiB limit is
    // not applied to them (`app.ts`).
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };

    /**
     * POST /api/resources/read: { refs?: [{ kind, id }], chats?: [{ characterId, id }],
     * chatRows?: [{ characterId, id, revision, messageIds, meta }],
     * chatCollections?: [characterId], chatSummaryCollections?: [characterId], continue?: boolean }.
     * Names 1–5000 entries before deduplication; each distinct entry is answered once. Authentication
     * precedes the 32 MiB cap (`MAX_READ_BODY_BYTES`; 413), independent of the app's global limit.
     * Returns compressed { epoch, items, chats?, chatRows?, chatCollections?, chatSummaryCollections?, unanswered? };
     * a missing record/chat has null data and revision. Row reads at another revision answer moved,
     * including a missing chat; identical row requests coalesce, conflicting requests for one chat
     * refuse. Summary collections omit messages, memory, bookmarks and toolCalls (`shared/chats.ts`). With continue:
     * true, whole groups are served within
     * the soft stored-byte budget in `data/resourceStore.ts` readRefsWithinBudget; otherwise all are read.
     * Malformed entries, unknown kinds, an empty request or more than 5000 entries are 400.
     */
    app.post(RESOURCE_READ_PATH, limiter, authenticated, limitedBody(readBodyBytes), async (c) => {
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        const {
            refs = [],
            chats = [],
            chatRows = [],
            chatCollections = [],
            chatSummaryCollections = [],
            continue: canContinue,
        } = parsed.body as Record<string, unknown>;
        if (!Array.isArray(refs) || !Array.isArray(chats) || !Array.isArray(chatCollections)) {
            return c.json({ error: "Body must be { refs?, chats?, chatCollections? } of arrays" }, 400);
        }
        if (!Array.isArray(chatRows)) {
            return c.json({ error: "chatRows must be an array" }, 400);
        }
        if (!Array.isArray(chatSummaryCollections)) {
            return c.json({ error: "chatSummaryCollections must be an array of character ids" }, 400);
        }
        if (canContinue !== undefined && typeof canContinue !== "boolean") {
            return c.json({ error: "continue must be a boolean" }, 400);
        }
        const total =
            refs.length + chats.length + chatRows.length + chatCollections.length + chatSummaryCollections.length;
        if (total === 0 || total > MAX_BATCH_OPERATIONS) {
            return c.json({ error: `Body must name 1 to ${MAX_BATCH_OPERATIONS} entries` }, 400);
        }
        // Keyed so a repeated entry is read once; a valid id holds no NUL, so the keys cannot collide.
        const resolved = new Map<string, { kind: ResourceKind; id: string }>();
        for (const [index, ref] of refs.entries()) {
            const kind = isPlainObject(ref) && typeof ref.kind === "string" ? kinds.get(ref.kind) : undefined;
            if (!kind || !isValidResourceId(ref.id)) {
                return c.json({ error: `refs[${index}] must name a known kind and a valid id` }, 400);
            }
            resolved.set(`${kind.name}\u0000${ref.id}`, { kind, id: ref.id });
        }
        const chatRefs = new Map<string, { characterId: string; id: string }>();
        for (const [index, ref] of chats.entries()) {
            if (!isPlainObject(ref) || !isValidResourceId(ref.characterId) || !isValidResourceId(ref.id)) {
                return c.json({ error: `chats[${index}] must name a valid characterId and id` }, 400);
            }
            chatRefs.set(`${ref.characterId}\u0000${ref.id}`, { characterId: ref.characterId, id: ref.id });
        }
        const rowRefs = new Map<string, ResourceReadEntries["chatRows"][number]>();
        for (const [index, ref] of chatRows.entries()) {
            if (
                !isPlainObject(ref) ||
                !isValidResourceId(ref.characterId) ||
                !isValidResourceId(ref.id) ||
                typeof ref.revision !== "string" ||
                !Array.isArray(ref.messageIds) ||
                !ref.messageIds.every(isValidResourceId) ||
                !Array.isArray(ref.meta) ||
                !ref.meta.every((name) => typeof name === "string") ||
                (ref.messageIds.length === 0 && ref.meta.length === 0)
            ) {
                return c.json(
                    {
                        error: `chatRows[${index}] must name a chat, revision and at least one message id or meta field`,
                    },
                    400,
                );
            }
            const entry = {
                characterId: ref.characterId,
                id: ref.id,
                revision: ref.revision,
                messageIds: ref.messageIds,
                meta: ref.meta,
            };
            const key = `${entry.characterId}\u0000${entry.id}`;
            const previous = rowRefs.get(key);
            if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
                return c.json({ error: `chatRows[${index}] conflicts with another request for this chat` }, 400);
            }
            rowRefs.set(key, entry);
        }
        if (!chatCollections.every(isValidResourceId)) {
            return c.json({ error: "chatCollections must be character ids" }, 400);
        }
        if (!chatSummaryCollections.every(isValidResourceId)) {
            return c.json({ error: "chatSummaryCollections must be character ids" }, 400);
        }
        const named = [...resolved.values()];
        const options = {
            chats: [...chatRefs.values()],
            chatRows: [...rowRefs.values()],
            chatCollections: [...new Set(chatCollections)],
            chatSummaryCollections: [...new Set(chatSummaryCollections)],
            memoryProjection: true,
        };
        try {
            const read =
                canContinue === true
                    ? store.readRefsWithinBudget(named, options, readResponseBytes)
                    : store.readRefs(named, options);
            addStreaming(read);
            return compressedJson(c, {
                ...read,
                items: read.items.map((item) => ({ ...item, data: project(kinds.get(item.kind), item.data) })),
            });
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    // The boot read that skips what the client holds (`resourceBoot.ts`).
    const limitBootBody = limitedBody(MAX_BOOT_BODY_BYTES);
    /**
     * POST /api/resources/boot: ResourceBootRequest { kinds, chatSummaries?: true,
     * known?: { records?, items?, chatCollections? } } (`shared/resources.ts`). A read, with no epoch
     * header; authenticated before its own 2 MiB cap (413). Malformed entries, unknown kinds and more
     * than 5000 combined claims are 400 (`routes/resourceBoot.ts` parseBootRequest).
     * Returns compressed ResourceBootResult { format: 1, epoch, kinds, chatSummaries?, chatOrders?,
     * chatSummaryFormat?, cachedChatCollections? }; kinds can contain cached revisions and item deltas
     * instead of whole records. `routes/resourceBoot.ts` readBoot keeps the result in one committed state.
     */
    app.post(RESOURCE_BOOT_PATH, limiter, authenticated, limitBootBody, async (c) => {
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        const request = parseBootRequest(parsed.body, kinds);
        if (typeof request === "string") {
            return c.json({ error: request }, 400);
        }
        try {
            return compressedJson(c, readBoot(store, request, project));
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    /**
     * POST { ops?, chats?, chatOrders? }, with the current x-resource-epoch. The 1–5000 operation cap
     * counts nested chat operations and reorders; resource operations require exactly one of data,
     * delete and patch. Returns { epoch, results, chats?, chatOrders? }. A conflict is 409
     * { error, conflicts } with the entire batch rolled back; malformed operations are 400.
     */
    app.post("/api/resources/batch", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        const { ops = [], chats, chatOrders } = parsed.body as Record<string, unknown>;
        if (!Array.isArray(ops)) {
            return c.json({ error: "ops must be an array" }, 400);
        }
        // Every nested chat op and every reorder counts toward the cap; malformed chat entries are
        // counted as one and rejected by the store.
        const total =
            ops.length +
            (Array.isArray(chats)
                ? chats.reduce<number>(
                      (sum, group) =>
                          sum + (isPlainObject(group) && Array.isArray(group.ops) ? Math.max(group.ops.length, 1) : 1),
                      0,
                  )
                : 0) +
            (Array.isArray(chatOrders) ? chatOrders.length : 0);
        if (total === 0 || total > MAX_BATCH_OPERATIONS) {
            return c.json(
                { error: `Body must be { ops?, chats?, chatOrders? } with 1 to ${MAX_BATCH_OPERATIONS} operations` },
                400,
            );
        }
        const operations: ResourceBatchOperation[] = [];
        for (const [index, op] of ops.entries()) {
            const operation = parseBatchOperation(op, kinds);
            if (typeof operation === "string") {
                return c.json({ error: `ops[${index}]: ${operation}` }, 400);
            }
            operations.push(operation);
        }
        try {
            assertMutable(c);
            // Every write-only record of the batch is prepared before anything is applied (a patch
            // of such a kind is refused by the store).
            for (const operation of operations) {
                if (operation.kind.prepareWrite && !operation.delete && !Object.hasOwn(operation, "patch")) {
                    operation.data = prepare(operation.kind, operation.id, operation.data);
                }
            }
            const applied = store.applyChanges({ ops: operations, chats, chatOrders });
            return c.json({ epoch: store.epoch(), ...applied });
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    /**
     * GET /api/resources/revisions: { epoch, resources: [{ kind, id, revision }],
     * chats: [{ characterId, id, revision }], chatOrders: [{ characterId, revision }] }.
     * The live-update reconciliation read carries no data and is compressed per Accept-Encoding.
     * With `since`, requires nonnegative safe integer `since`/`until` and a nonempty `epoch` (400
     * otherwise), returning the store's bounded, coalesced replay or its expired/epoch answer.
     */
    // Before `/api/resources/:kind`, which would take `revisions` as a kind name.
    app.get("/api/resources/revisions", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const sinceText = c.req.query("since");
        if (sinceText === undefined) return compressedJson(c, store.listRevisions());
        const untilText = c.req.query("until");
        const epoch = c.req.query("epoch");
        const parseCursor = (value: string | undefined) =>
            value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
        const since = parseCursor(sinceText);
        const until = parseCursor(untilText);
        if (since === null || until === null || !epoch) {
            return c.json({ error: "Expected since, until and epoch for revision replay" }, 400);
        }
        return compressedJson(c, store.listChanges(since, until, epoch));
    });

    /** GET returns compressed { epoch, items: [{ id, revision, data }] } in creation order,
     * with each kind's projection applied; an unknown kind is 404. */
    app.get("/api/resources/:kind", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const kind = kinds.get(c.req.param("kind"));
        if (!kind) {
            return c.json({ error: "Unknown resource kind" }, 404);
        }
        return compressedJson(c, {
            epoch: store.epoch(),
            items: store.list(kind).map((record) => ({ ...record, data: project(kind, record.data) })),
        });
    });

    /** 404 for an unknown kind or a missing record, 400 for an invalid id. */
    app.get("/api/resources/:kind/:id", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const kind = kinds.get(c.req.param("kind"));
        if (!kind) {
            return c.json({ error: "Unknown resource kind" }, 404);
        }
        const id = c.req.param("id");
        if (!isValidResourceId(id)) {
            return c.json({ error: "Invalid resource id" }, 400);
        }
        let resource: { revision: string; data: unknown } | null;
        try {
            resource = store.get(kind, id);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
        if (!resource) {
            return c.json({ error: "Resource not found", epoch: store.epoch() }, 404);
        }
        return compressedJson(c, {
            epoch: store.epoch(),
            revision: resource.revision,
            data: project(kind, resource.data),
        });
    });

    /**
     * PUT { baseRevision: string | null, data }, with x-resource-epoch: null creates, a token updates.
     * Returns { epoch, revision, data } as stored with the kind's projection applied (credentials
     * masked). A stale revision is 409 { error, revision }; malformed body/id is 400, unknown kind 404.
     */
    app.put("/api/resources/:kind/:id", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const kind = kinds.get(c.req.param("kind"));
        if (!kind) {
            return c.json({ error: "Unknown resource kind" }, 404);
        }
        const id = c.req.param("id");
        if (!isValidResourceId(id)) {
            return c.json({ error: "Invalid resource id" }, 400);
        }
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        // `readJsonBody` yields `{}` for a non-JSON content type and accepts arrays; `data` may be
        // any JSON value, including falsy ones.
        const body = parsed.body;
        if (
            Array.isArray(body) ||
            !Object.hasOwn(body, "data") ||
            !Object.hasOwn(body, "baseRevision") ||
            (body.baseRevision !== null && typeof body.baseRevision !== "string")
        ) {
            return c.json({ error: "Body must be { baseRevision: string | null, data }" }, 400);
        }
        try {
            assertMutable(c);
            const saved = store.put(kind, id, prepare(kind, id, body.data), body.baseRevision);
            return c.json({ epoch: store.epoch(), revision: saved.revision, data: project(kind, saved.data) });
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    /**
     * DELETE ?baseRevision=<token>, with x-resource-epoch, returns { success: true, epoch }.
     * Stale tokens or an already missing record are 409 { error, revision }; a singleton, invalid id
     * or absent baseRevision is 400, an unknown kind 404.
     */
    app.delete("/api/resources/:kind/:id", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const kind = kinds.get(c.req.param("kind"));
        if (!kind) {
            return c.json({ error: "Unknown resource kind" }, 404);
        }
        const id = c.req.param("id");
        if (!isValidResourceId(id)) {
            return c.json({ error: "Invalid resource id" }, 400);
        }
        // An empty value is a malformed token (409), like any other string that does not parse.
        const baseRevision = c.req.query("baseRevision");
        if (baseRevision === undefined) {
            return c.json({ error: "baseRevision query parameter required" }, 400);
        }
        try {
            assertMutable(c);
            store.delete(kind, id, baseRevision);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
        return c.json({ success: true, epoch: store.epoch() });
    });
}

/** Checks one batch operation's envelope; returns the reason as a string when it is malformed. */
function parseBatchOperation(op: unknown, kinds: ResourceKindRegistry): ResourceBatchOperation | string {
    if (!isPlainObject(op)) {
        return "must be an object";
    }
    const kind = typeof op.kind === "string" ? kinds.get(op.kind) : undefined;
    if (!kind) {
        return "unknown resource kind";
    }
    if (!isValidResourceId(op.id)) {
        return "invalid resource id";
    }
    if (!Object.hasOwn(op, "baseRevision") || (op.baseRevision !== null && typeof op.baseRevision !== "string")) {
        return "baseRevision must be a string or null";
    }
    const isDelete = Object.hasOwn(op, "delete");
    const isPatch = Object.hasOwn(op, "patch");
    if (Number(isDelete) + Number(isPatch) + Number(Object.hasOwn(op, "data")) !== 1) {
        return "must have exactly one of data, delete, and patch";
    }
    if (isPatch) {
        if (typeof op.baseRevision !== "string") {
            return "a patch needs a string baseRevision";
        }
        // Its shape is checked by the store, which names this op.
        return { kind, id: op.id, baseRevision: op.baseRevision, patch: op.patch };
    }
    if (isDelete) {
        if (op.delete !== true || typeof op.baseRevision !== "string") {
            return "a deletion is { delete: true } with a string baseRevision";
        }
        return { kind, id: op.id, baseRevision: op.baseRevision, delete: true };
    }
    return { kind, id: op.id, baseRevision: op.baseRevision as string | null, data: op.data };
}

export function storeErrorResponse(c: Context<AppEnv>, error: unknown): Response {
    if (error instanceof ResourceConflictError) {
        return c.json(
            error.reason
                ? { error: error.message, revision: error.current, reason: error.reason }
                : { error: error.message, revision: error.current },
            409,
        );
    }
    if (error instanceof ResourceBatchConflictError) {
        return c.json({ error: error.message, conflicts: error.conflicts }, 409);
    }
    if (error instanceof ResourceEpochError) {
        return c.json({ error: "EpochMismatch", epoch: error.epoch }, 412);
    }
    if (error instanceof ResourceValidationError) {
        return c.json({ error: error.message }, 400);
    }
    if (error instanceof MaintenanceError || error instanceof ResourceStoreClosedError) {
        c.header("Retry-After", "5");
        return c.json({ error: error.message }, 503);
    }
    throw error;
}
