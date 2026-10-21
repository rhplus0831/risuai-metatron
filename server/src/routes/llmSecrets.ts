import type { Context, Hono, MiddlewareHandler } from "hono";
import { maskLlmSecrets, parseSecretPath, writeSecret, type SecretPath } from "../../../shared/llmSecrets.ts";
import { RESOURCE_EPOCH_HEADER, RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import { ResourceConflictError, type ResourceStore } from "../data/resourceStore.ts";
import type { MaintenanceGate } from "../data/snapshots.ts";
import { readJsonBody } from "../http/body.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { storeErrorResponse } from "./resources.ts";

const PREFIX = "/api/llm-secrets/";
/** A credential is text a user pastes; anything larger is refused. */
const MAX_SECRET_LENGTH = 64 * 1024;

/**
 * `/api/llm-secrets/*`: the only way a client writes an `llmSecrets` credential (the record is
 * write-only: `shared/llmSecrets.ts`).
 *
 * - `PUT /api/llm-secrets/<path>` `{ value, baseRevision }`: sets the credential (an empty value
 *   clears a leaf and removes a map entry);
 * - `DELETE /api/llm-secrets/<path>?baseRevision=`: clears it;
 *
 * JWT, `x-resource-epoch` (412), the maintenance gate (503), the record's revision (409 `{ error,
 * revision }`), 400 for a bad path or value; each answers `{ epoch, revision, data }` with the
 * masked record. The path segments are decoded once from the raw pathname. No value is logged or
 * echoed.
 */
export function registerLlmSecretRoutes(
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
    const kind = kinds.get(RESOURCE_KIND.llmSecrets);

    const pathOf = (url: string): SecretPath | null => {
        const pathname = new URL(url).pathname.replace(/\/+$/, "");
        return pathname.startsWith(PREFIX) ? parseSecretPath(pathname.slice(PREFIX.length)) : null;
    };

    /** Reads, changes, and writes the record in one synchronous block (atomic with its revision check). */
    const update = (
        c: Context<AppEnv>,
        baseRevision: string,
        change: (record: Record<string, any>) => Record<string, any>,
    ) => {
        if (!kind) {
            return c.json({ error: "Unknown resource kind" }, 404);
        }
        try {
            maintenance.assertOpen();
            store.assertEpoch(c.req.header(RESOURCE_EPOCH_HEADER));
            const current = store.get(kind, SINGLETON_RESOURCE_ID);
            if (!current) {
                throw new ResourceConflictError(null);
            }
            const saved = store.put(
                kind,
                SINGLETON_RESOURCE_ID,
                change(current.data as Record<string, any>),
                baseRevision,
            );
            c.header("Cache-Control", "no-store");
            return c.json({
                epoch: store.epoch(),
                revision: saved.revision,
                data: maskLlmSecrets(saved.data as Record<string, unknown>),
            });
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    };

    app.put(`${PREFIX}*`, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const path = pathOf(c.req.url);
        if (!path) {
            return c.json({ error: "Unknown credential path" }, 400);
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        const body = read.body;
        if (
            !isPlainObject(body) ||
            typeof body.value !== "string" ||
            body.value.length > MAX_SECRET_LENGTH ||
            typeof body.baseRevision !== "string"
        ) {
            return c.json({ error: "Body must be { value: string, baseRevision: string }" }, 400);
        }
        const value = body.value;
        return update(c, body.baseRevision, (record) => writeSecret(record, path, value));
    });

    app.delete(`${PREFIX}*`, limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const path = pathOf(c.req.url);
        if (!path) {
            return c.json({ error: "Unknown credential path" }, 400);
        }
        const baseRevision = c.req.query("baseRevision");
        if (baseRevision === undefined) {
            return c.json({ error: "baseRevision query parameter required" }, 400);
        }
        return update(c, baseRevision, (record) => writeSecret(record, path, ""));
    });
}
