import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import {
    isValidResourceId,
    ResourceConflictError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";

/**
 * `/api/resources/:kind[/:id]` over the resource store. A write names the revision it was based on
 * (`baseRevision`: null to create); a stale one is a 409 carrying the current revision (null when the
 * record is gone). No client calls these routes yet.
 */
export function registerResourceRoutes(
    app: Hono<AppEnv>,
    arg: { store: ResourceStore; kinds: ResourceKindRegistry; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { store, kinds, auth, limiter } = arg;

    app.get("/api/resources/:kind", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const kind = kinds.get(c.req.param("kind"));
        if (!kind) {
            return c.json({ error: "Unknown resource kind" }, 404);
        }
        return c.json({ items: store.list(kind) });
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
        const resource = store.get(kind, id);
        if (!resource) {
            return c.json({ error: "Resource not found" }, 404);
        }
        return c.json(resource);
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
            return c.json(store.put(kind, id, body.data, body.baseRevision));
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
            store.delete(kind, id, baseRevision);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
        return c.json({ success: true });
    });
}

function storeErrorResponse(c: Context<AppEnv>, error: unknown): Response {
    if (error instanceof ResourceConflictError) {
        return c.json({ error: error.message, revision: error.current }, 409);
    }
    if (error instanceof ResourceValidationError) {
        return c.json({ error: error.message }, 400);
    }
    throw error;
}
