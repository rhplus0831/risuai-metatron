import {
    carriesSecretPath,
    maskLlmSecrets,
    parseSecretPath,
    readSecret,
    withStoredSecrets,
    writeSecret,
    type SecretPath,
} from "../../../../shared/llmSecrets.ts";
import { RESOURCE_EPOCH_HEADER, type ResourceConflict } from "../../../../shared/resources.ts";

/**
 * An in-memory stand-in for the server's `/api/resources` routes, with the same contract the client
 * relies on: revisions, the epoch fence (412), batch atomicity with every conflict listed (409),
 * single-record conflicts as `{ revision }`, and a body limit (413). The write-only `llmSecrets`
 * record (Phase 5 slice 7b) follows the server's contract too: it is stored as plaintext (what a
 * test puts in it, or what `/api/llm-secrets/*` writes) and answered masked on every read; a plain
 * write may carry no credential path (400) and keeps the stored credentials. Tests plug it in as
 * `authFetch` and use the hooks to hold a batch, drop a response after it was applied, or fail
 * requests.
 */
export class FakeResourceServer {
    epoch = "epoch-1";
    records = new Map<string, { revision: string; data: unknown }>();
    requests: { method: string; path: string; body: unknown }[] = [];
    maxBodyBytes = Infinity;
    /** Resolves a held batch; set while `holdNextBatch` is pending. */
    releaseBatch: (() => void) | null = null;
    holdNextBatch = false;
    /** Apply the next batch, then fail the response (a lost acknowledgement). */
    dropNextBatchResponse = false;
    /** Answer the next matching requests with this status (or throw a network error for 0). */
    failNext: { status: number; body?: unknown; times: number; match?: (path: string) => boolean } | null = null;
    /** Epoch to report on reads (defaults to `epoch`); lets a test simulate a read from another database. */
    readEpoch: string | null = null;
    /** Runs before the next batch is applied (something another tab does meanwhile); one-shot. */
    beforeNextBatch: (() => Promise<void> | void) | null = null;
    private revisionCounter = 0;

    key(kind: string, id: string) {
        return `${kind}/${id}`;
    }

    get(kind: string, id: string) {
        return this.records.get(this.key(kind, id)) ?? null;
    }

    data<T = any>(kind: string, id: string): T | null {
        return (this.get(kind, id)?.data as T) ?? null;
    }

    /** A write from "another tab": a new revision, no epoch check. */
    set(kind: string, id: string, data: unknown): string {
        const revision = `r${++this.revisionCounter}`;
        this.records.set(this.key(kind, id), { revision, data: JSON.parse(JSON.stringify(data)) });
        return revision;
    }

    delete(kind: string, id: string) {
        this.records.delete(this.key(kind, id));
    }

    /** Replaces the database: a restore. */
    restore(epoch: string) {
        this.epoch = epoch;
    }

    batchCount() {
        return this.requests.filter((request) => request.path === "/api/resources/batch").length;
    }

    batchBodies() {
        return this.requests
            .filter((request) => request.path === "/api/resources/batch")
            .map((request) => request.body as { ops: any[] });
    }

    /** The requests to `/api/llm-secrets/*` (the credential writes), in order. */
    secretRequests() {
        return this.requests.filter((request) => request.path.startsWith("/api/llm-secrets/"));
    }

    /** What a client reads of a record: the masked `llmSecrets` record, any other as stored. */
    private project(kind: string, data: unknown): unknown {
        return kind === "llmSecrets" && data && typeof data === "object"
            ? maskLlmSecrets(data as Record<string, unknown>)
            : data;
    }

    /** A plain write's data: an `llmSecrets` write may carry no credential and keeps the stored ones. */
    private prepareWrite(kind: string, id: string, data: unknown): unknown {
        if (kind !== "llmSecrets") {
            return data;
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new FakeValidationError("llmSecrets must be an object");
        }
        if (carriesSecretPath(data as Record<string, unknown>)) {
            throw new FakeValidationError(
                "llmSecrets credentials are written through /api/llm-secrets, not in the record",
            );
        }
        return withStoredSecrets(
            data as Record<string, unknown>,
            (this.data(kind, id) ?? {}) as Record<string, unknown>,
        );
    }

    /** `/api/llm-secrets/*`: one credential write on the record's revision, answered masked. */
    private writeSecretRoute(
        baseRevision: unknown,
        change: (record: Record<string, any>) => Record<string, any>,
    ): Response {
        const current = this.get("llmSecrets", "main");
        if (typeof baseRevision !== "string") {
            return Response.json({ error: "baseRevision required" }, { status: 400 });
        }
        if (!current || current.revision !== baseRevision) {
            return Response.json({ error: "Revision conflict", revision: current?.revision ?? null }, { status: 409 });
        }
        const next = change(current.data as Record<string, any>);
        const revision = this.set("llmSecrets", "main", next);
        return Response.json({ epoch: this.epoch, revision, data: this.project("llmSecrets", next) });
    }

    readonly fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
        const method = init.method ?? "GET";
        const rawBody = typeof init.body === "string" ? init.body : null;
        const body = rawBody ? JSON.parse(rawBody) : null;
        const url = new URL(path, "http://test");
        this.requests.push({ method, path: url.pathname, body });
        if (this.failNext && (!this.failNext.match || this.failNext.match(url.pathname))) {
            const failure = this.failNext;
            failure.times -= 1;
            if (failure.times <= 0) {
                this.failNext = null;
            }
            if (failure.status === 0) {
                throw new TypeError("Failed to fetch");
            }
            return Response.json(failure.body ?? { error: `failed ${failure.status}` }, { status: failure.status });
        }
        if (rawBody && new TextEncoder().encode(rawBody).byteLength > this.maxBodyBytes) {
            return Response.json({ error: "Payload too large" }, { status: 413 });
        }
        const headers = new Headers(init.headers);
        const epochOf = () => this.readEpoch ?? this.epoch;
        const assertEpoch = () => {
            if (headers.get(RESOURCE_EPOCH_HEADER) !== this.epoch) {
                return Response.json({ error: "EpochMismatch", epoch: this.epoch }, { status: 412 });
            }
            return null;
        };

        if (url.pathname === "/api/resources" && method === "GET") {
            const kinds = (url.searchParams.get("kinds") ?? "").split(",");
            const result: Record<string, { id: string; revision: string; data: unknown }[]> = {};
            for (const kind of kinds) {
                result[kind] = [];
                for (const [key, record] of this.records) {
                    if (key.startsWith(`${kind}/`)) {
                        result[kind].push({
                            id: key.slice(kind.length + 1),
                            revision: record.revision,
                            data: this.project(kind, record.data),
                        });
                    }
                }
            }
            return Response.json({ epoch: epochOf(), kinds: result });
        }
        if (url.pathname === "/api/resources/read" && method === "POST") {
            const items = (body.refs as { kind: string; id: string }[]).map((ref) => {
                const record = this.get(ref.kind, ref.id);
                return {
                    kind: ref.kind,
                    id: ref.id,
                    revision: record?.revision ?? null,
                    data: record ? this.project(ref.kind, record.data) : null,
                };
            });
            return Response.json({ epoch: epochOf(), items });
        }
        if (url.pathname === "/api/resources/batch" && method === "POST") {
            const mismatch = assertEpoch();
            if (mismatch) {
                return mismatch;
            }
            if (this.holdNextBatch) {
                this.holdNextBatch = false;
                await new Promise<void>((resolve) => {
                    this.releaseBatch = () => {
                        this.releaseBatch = null;
                        resolve();
                    };
                });
            }
            if (this.beforeNextBatch) {
                const hook = this.beforeNextBatch;
                this.beforeNextBatch = null;
                await hook();
            }
            const ops = body.ops as {
                kind: string;
                id: string;
                baseRevision: string | null;
                data?: unknown;
                delete?: true;
            }[];
            const conflicts: ResourceConflict[] = [];
            for (const op of ops) {
                const current = this.get(op.kind, op.id);
                if ((current?.revision ?? null) !== op.baseRevision) {
                    conflicts.push({ kind: op.kind, id: op.id, revision: current?.revision ?? null });
                }
            }
            if (conflicts.length > 0) {
                return Response.json({ error: "Revision conflict", conflicts }, { status: 409 });
            }
            // Prepared apart from the recorded body, which stays what the client sent.
            let prepared: unknown[];
            try {
                prepared = ops.map((op) => (op.delete ? undefined : this.prepareWrite(op.kind, op.id, op.data)));
            } catch (error) {
                if (error instanceof FakeValidationError) {
                    return Response.json({ error: error.message }, { status: 400 });
                }
                throw error;
            }
            const results = ops.map((op, index) => {
                if (op.delete) {
                    this.delete(op.kind, op.id);
                    return { kind: op.kind, id: op.id, revision: null };
                }
                return { kind: op.kind, id: op.id, revision: this.set(op.kind, op.id, prepared[index]) };
            });
            if (this.dropNextBatchResponse) {
                this.dropNextBatchResponse = false;
                throw new TypeError("Failed to fetch");
            }
            return Response.json({ epoch: this.epoch, results });
        }
        const single = url.pathname.match(/^\/api\/resources\/([^/]+)\/([^/]+)$/);
        if (single) {
            const kind = decodeURIComponent(single[1]);
            const id = decodeURIComponent(single[2]);
            const current = this.get(kind, id);
            if (method === "GET") {
                if (!current) {
                    return Response.json({ error: "Resource not found", epoch: epochOf() }, { status: 404 });
                }
                return Response.json({
                    epoch: epochOf(),
                    revision: current.revision,
                    data: this.project(kind, current.data),
                });
            }
            const mismatch = assertEpoch();
            if (mismatch) {
                return mismatch;
            }
            if (method === "PUT") {
                if ((current?.revision ?? null) !== body.baseRevision) {
                    return Response.json(
                        { error: "Revision conflict", revision: current?.revision ?? null },
                        { status: 409 },
                    );
                }
                let data: unknown;
                try {
                    data = this.prepareWrite(kind, id, body.data);
                } catch (error) {
                    if (error instanceof FakeValidationError) {
                        return Response.json({ error: error.message }, { status: 400 });
                    }
                    throw error;
                }
                const revision = this.set(kind, id, data);
                return Response.json({ epoch: this.epoch, revision, data: this.project(kind, data) });
            }
            if (method === "DELETE") {
                const baseRevision = url.searchParams.get("baseRevision");
                if (!current || current.revision !== baseRevision) {
                    return Response.json(
                        { error: "Revision conflict", revision: current?.revision ?? null },
                        { status: 409 },
                    );
                }
                this.delete(kind, id);
                return Response.json({ success: true, epoch: this.epoch });
            }
        }
        if (url.pathname === "/api/llm-secrets/modelPresets/copy" && method === "POST") {
            const mismatch = assertEpoch();
            if (mismatch) {
                return mismatch;
            }
            if (typeof body?.from !== "string" || typeof body?.to !== "string" || !body.from || !body.to) {
                return Response.json({ error: "Body must be { from, to, baseRevision }" }, { status: 400 });
            }
            const from: SecretPath = { kind: "entry", field: "modelPresets", id: body.from };
            const to: SecretPath = { kind: "entry", field: "modelPresets", id: body.to };
            return this.writeSecretRoute(body.baseRevision, (record) =>
                writeSecret(record, to, readSecret(record, from)),
            );
        }
        if (url.pathname.startsWith("/api/llm-secrets/") && (method === "PUT" || method === "DELETE")) {
            const mismatch = assertEpoch();
            if (mismatch) {
                return mismatch;
            }
            const secretPath = parseSecretPath(url.pathname.slice("/api/llm-secrets/".length));
            if (!secretPath) {
                return Response.json({ error: "Unknown credential path" }, { status: 400 });
            }
            if (method === "PUT") {
                if (typeof body?.value !== "string") {
                    return Response.json(
                        { error: "Body must be { value: string, baseRevision: string }" },
                        { status: 400 },
                    );
                }
                return this.writeSecretRoute(body.baseRevision, (record) =>
                    writeSecret(record, secretPath, body.value),
                );
            }
            return this.writeSecretRoute(url.searchParams.get("baseRevision") ?? undefined, (record) =>
                writeSecret(record, secretPath, ""),
            );
        }
        return Response.json({ error: `Unhandled ${method} ${url.pathname}` }, { status: 500 });
    };
}

/** A refused write of the fake's own write rule (the server's `ResourceValidationError`). */
class FakeValidationError extends Error {}
