import type { Context, Hono, MiddlewareHandler } from "hono";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
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
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

/** Most operations one batch or one read may name. */
export const MAX_BATCH_OPERATIONS = 5000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `/api/resources` over the resource store. Reads return the database `epoch`; every mutation must
 * send it in `x-resource-epoch` (412 otherwise, so nothing based on data from before a restore can
 * land), is refused with 503 while a restore or import runs, and names the revision it was based on
 * (`baseRevision`: null to create); a stale one is a 409 carrying the current revision (null when the
 * record is gone). The batch also carries chat groups and reorders, and the reads chats and chat
 * collections (`shared/chats.ts`). An edit of a message a generation job owns is a 409 whose entry
 * (or, on the single routes, whose body) carries `reason: "generating"`. Responses are never cached.
 */
export function registerResourceRoutes(
    app: Hono<AppEnv>,
    arg: {
        store: ResourceStore;
        kinds: ResourceKindRegistry;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        maintenance: MaintenanceGate;
    },
) {
    const { store, kinds, auth, limiter, maintenance } = arg;

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
        return c.json(store.readKinds(selected, { chats: chats === "1" }));
    });

    app.post("/api/resources/read", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const parsed = await readJsonBody(c);
        if (!parsed.ok) {
            return parsed.response;
        }
        const { refs = [], chats = [], chatCollections = [] } = parsed.body as Record<string, unknown>;
        if (!Array.isArray(refs) || !Array.isArray(chats) || !Array.isArray(chatCollections)) {
            return c.json({ error: "Body must be { refs?, chats?, chatCollections? } of arrays" }, 400);
        }
        const total = refs.length + chats.length + chatCollections.length;
        if (total === 0 || total > MAX_BATCH_OPERATIONS) {
            return c.json({ error: `Body must name 1 to ${MAX_BATCH_OPERATIONS} entries` }, 400);
        }
        const resolved: { kind: ResourceKind; id: string }[] = [];
        for (const [index, ref] of refs.entries()) {
            const kind = isPlainObject(ref) && typeof ref.kind === "string" ? kinds.get(ref.kind) : undefined;
            if (!kind || !isValidResourceId(ref.id)) {
                return c.json({ error: `refs[${index}] must name a known kind and a valid id` }, 400);
            }
            resolved.push({ kind, id: ref.id });
        }
        const chatRefs: { characterId: string; id: string }[] = [];
        for (const [index, ref] of chats.entries()) {
            if (!isPlainObject(ref) || !isValidResourceId(ref.characterId) || !isValidResourceId(ref.id)) {
                return c.json({ error: `chats[${index}] must name a valid characterId and id` }, 400);
            }
            chatRefs.push({ characterId: ref.characterId, id: ref.id });
        }
        if (!chatCollections.every(isValidResourceId)) {
            return c.json({ error: "chatCollections must be character ids" }, 400);
        }
        try {
            return c.json(store.readRefs(resolved, { chats: chatRefs, chatCollections }));
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

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
            const applied = store.applyChanges({ ops: operations, chats, chatOrders });
            return c.json({ epoch: store.epoch(), ...applied });
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.get("/api/resources/:kind", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const kind = kinds.get(c.req.param("kind"));
        if (!kind) {
            return c.json({ error: "Unknown resource kind" }, 404);
        }
        return c.json({ epoch: store.epoch(), items: store.list(kind) });
    });

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
        return c.json({ epoch: store.epoch(), ...resource });
    });

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
            return c.json({ epoch: store.epoch(), ...store.put(kind, id, body.data, body.baseRevision) });
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

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
    if (isDelete === Object.hasOwn(op, "data")) {
        return "must have exactly one of data and delete";
    }
    if (isDelete) {
        if (op.delete !== true || typeof op.baseRevision !== "string") {
            return "a deletion is { delete: true } with a string baseRevision";
        }
        return { kind, id: op.id, baseRevision: op.baseRevision, delete: true };
    }
    return { kind, id: op.id, baseRevision: op.baseRevision as string | null, data: op.data };
}

function storeErrorResponse(c: Context<AppEnv>, error: unknown): Response {
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
