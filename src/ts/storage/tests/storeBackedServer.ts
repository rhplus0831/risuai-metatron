import type { ChatOp, ChatOrderRecord, ChatRecord, ChatSummary } from "../../../../shared/chats.ts";
import { parseSecretPath, writeSecret } from "../../../../shared/llmSecrets.ts";
import { type ChangeSet, RESOURCE_EPOCH_HEADER, type ResourceRevisionListing } from "../../../../shared/resources.ts";

/**
 * An `authFetch` stand-in over the real server resource store (`createResourceStore`, SQLite in
 * memory), for tests of the chat module and the save loop that need the real chat contract:
 * revision tokens, the stale-by-id rule and `stale` results, the generation fence outcomes, the
 * 409 union, the 400 validation messages, and the request cap. The route layer is reduced to what
 * the client relies on: the epoch fence, the operation count, the error mapping, and (Phase 5
 * slice 7b) the write-only kinds' contract: a kind's `project` on every read, its `prepareWrite` on
 * every plain write, and `/api/llm-secrets/*` for the credential writes. The hooks mirror
 * `FakeResourceServer`'s: hold a batch, drop a response after it was applied, fail requests.
 *
 * The server modules are loaded at run time (`create`) through a computed specifier: the client
 * `tsconfig.json` is not strict and must not type-check the strict server sources, so a static
 * import from a client test would fail `pnpm check`. Their types are declared here as far as the
 * tests use them.
 */

/** The subset of the server store the tests call (`server/src/data/resourceStore.ts`). */
export type ServerStore = {
    epoch(): string;
    close(): void;
    get(kind: unknown, id: string): { revision: string; data: any } | null;
    put(kind: unknown, id: string, data: unknown, baseRevision: string | null): { revision: string; data: unknown };
    delete(kind: unknown, id: string, baseRevision: string): void;
    readKinds(
        kinds: readonly unknown[],
        options?: { chats?: boolean; chatSummaries?: boolean },
    ): {
        epoch: string;
        kinds: Record<string, { id: string; revision: string; data: any }[]>;
        chats?: ChatRecord[];
        chatSummaries?: ChatSummary[];
        chatOrders?: ChatOrderRecord[];
    };
    readRefs(
        refs: readonly { kind: unknown; id: string }[],
        options?: {
            chats?: readonly { characterId: string; id: string }[];
            chatCollections?: readonly string[];
            chatSummaryCollections?: readonly string[];
        },
    ): {
        epoch: string;
        items: { kind: string; id: string; revision: string | null; data: unknown }[];
        chats: (ChatRecord | { characterId: string; id: string; revision: null; data: null })[];
        chatCollections: { characterId: string; order: ChatOrderRecord | null; chats: ChatRecord[] }[];
        chatSummaryCollections?: { characterId: string; order: ChatOrderRecord | null; chats: ChatSummary[] }[];
    };
    applyChanges(
        batch: { ops?: readonly unknown[]; chats?: unknown; chatOrders?: unknown },
        options?: { epoch?: string; jobToken?: string },
    ): {
        results: { kind: string; id: string; revision: string | null }[];
        chats: any[];
        chatOrders: any[];
    };
    /** The revision listing (`GET /api/resources/revisions`, Phase 6 live updates). */
    listRevisions(): ResourceRevisionListing;
    transaction<T>(fn: () => T): T;
};

/** What the server's change feed publishes (`server/src/data/changeFeed.ts`). */
export type ServerFeedEvent = { type: "change"; epoch: string; changes: ChangeSet } | { type: "epoch"; epoch: string };

type ServerFeed = { subscribe(listener: (event: ServerFeedEvent) => void): () => void };
type FeedModule = { createChangeFeed(): ServerFeed };

/** The server generation lock (`server/src/jobs/generationLock.ts`), as far as the tests drive it. */
export type ServerGenerationLock = {
    addToken(token: string): void;
    acquire(
        ref: { characterId: string; chatId: string; messageId: string },
        owner: { jobId: string; generationId: string; token: string },
    ): unknown;
    release(ref: { characterId: string; chatId: string; messageId: string }, token: string, generationId: string): void;
    endJob(token: string): void;
};

type LockModule = { createGenerationLock(): ServerGenerationLock };

type StoreModule = {
    createResourceStore(options: {
        file: string;
        kinds: unknown;
        guard?: ServerGenerationLock;
        feed?: ServerFeed;
    }): ServerStore;
    ResourceConflictError: new (current: string | null) => Error & { current: string | null };
    ResourceBatchConflictError: new (conflicts: unknown[]) => Error & { conflicts: unknown[] };
    ResourceValidationError: new (message: string) => Error;
};

type KindsModule = {
    createKindRegistry(kinds: readonly unknown[]): ReadonlyMap<string, unknown>;
    DEFAULT_RESOURCE_KINDS: readonly unknown[];
};

/** A kind's write-only hooks (`server/src/data/kinds.ts` `ResourceKind`), as far as the routes use them. */
type ProjectingKind = {
    project?(data: unknown): unknown;
    prepareWrite?(incoming: unknown, stored: unknown | null): unknown;
};

const SERVER_DATA = "../../../../server/src/data/";
const SERVER_JOBS = "../../../../server/src/jobs/";

export class StoreBackedServer {
    /** Most operations one batch may name (`MAX_BATCH_OPERATIONS` of the batch route). */
    static readonly MAX_BATCH_OPERATIONS = 5000;

    /**
     * `lock`: build the store with the server generation lock as its guard (`this.lock`). `feed`:
     * build it with the server change feed; every published event is recorded in `feedEvents` and
     * handed to `onFeed` (the test's stand-in for the live-update socket).
     */
    static async create(options: { lock?: boolean; feed?: boolean } = {}): Promise<StoreBackedServer> {
        const [storeModule, kindsModule, lockModule, feedModule] = (await Promise.all([
            import(/* @vite-ignore */ `${SERVER_DATA}resourceStore.ts`),
            import(/* @vite-ignore */ `${SERVER_DATA}kinds.ts`),
            options.lock ? import(/* @vite-ignore */ `${SERVER_JOBS}generationLock.ts`) : null,
            options.feed ? import(/* @vite-ignore */ `${SERVER_DATA}changeFeed.ts`) : null,
        ])) as [StoreModule, KindsModule, LockModule | null, FeedModule | null];
        return new StoreBackedServer(
            storeModule,
            kindsModule,
            lockModule?.createGenerationLock() ?? null,
            feedModule?.createChangeFeed() ?? null,
        );
    }

    readonly kinds: ReadonlyMap<string, unknown>;
    readonly store: ServerStore;
    /** The generation lock guarding the store (`create({ lock: true })`), or null. */
    readonly lock: ServerGenerationLock | null;
    /** The server's error classes, for `instanceof` checks in tests. */
    readonly errors: Pick<
        StoreModule,
        "ResourceConflictError" | "ResourceBatchConflictError" | "ResourceValidationError"
    >;
    requests: { method: string; path: string; body: any }[] = [];
    /** Resolves a held batch; set while `holdNextBatch` is pending. */
    releaseBatch: (() => void) | null = null;
    holdNextBatch = false;
    /** Apply the next batch, then fail the response (a lost acknowledgement). */
    dropNextBatchResponse = false;
    /** Answer the next matching requests with this status (or throw a network error for 0). */
    failNext: { status: number; body?: unknown; times: number; match?: (path: string) => boolean } | null = null;
    /** Runs before the next batch is applied (something another tab does meanwhile); one-shot. */
    beforeNextBatch: (() => Promise<void> | void) | null = null;
    /** Every event the change feed published (`create({ feed: true })`), in order. */
    feedEvents: ServerFeedEvent[] = [];
    /** Receives each published event as it is published (synchronously, right after the commit). */
    onFeed: ((event: ServerFeedEvent) => void) | null = null;

    private constructor(
        storeModule: StoreModule,
        kindsModule: KindsModule,
        lock: ServerGenerationLock | null,
        feed: ServerFeed | null,
    ) {
        this.kinds = kindsModule.createKindRegistry(kindsModule.DEFAULT_RESOURCE_KINDS);
        this.lock = lock;
        feed?.subscribe((event) => {
            this.feedEvents.push(event);
            this.onFeed?.(event);
        });
        this.store = storeModule.createResourceStore({
            file: ":memory:",
            kinds: this.kinds,
            guard: lock ?? undefined,
            feed: feed ?? undefined,
        });
        this.errors = storeModule;
    }

    close() {
        this.store.close();
    }

    kind(name: string) {
        return this.kinds.get(name)!;
    }

    /** A record as "another tab" writes it: created or replaced, no epoch check. */
    set(kind: string, id: string, data: unknown) {
        const current = this.store.get(this.kind(kind), id);
        this.store.put(this.kind(kind), id, data, current?.revision ?? null);
    }

    record(kind: string, id: string) {
        return this.store.get(this.kind(kind), id);
    }

    /** A chat as stored (null when it does not exist). */
    chat(characterId: string, id: string): ChatRecord | null {
        const record = this.store.readRefs([], { chats: [{ characterId, id }] }).chats[0];
        return record.revision === null ? null : (record as ChatRecord);
    }

    /** The message texts of a chat, in order. */
    texts(characterId: string, id: string): string[] {
        return (this.chat(characterId, id)?.data.message ?? []).map((message) => message.data as string);
    }

    /** A character's chat order (null when the character has none). */
    order(characterId: string) {
        return this.store.readRefs([], { chatCollections: [characterId] }).chatCollections[0].order;
    }

    /** Applies chat groups as another tab would. */
    chatBatch(chats: { characterId: string; chatId: string; baseRevision: string | null; ops: ChatOp[] }[]) {
        return this.store.applyChanges({ chats });
    }

    batchBodies() {
        return this.requests
            .filter((request) => request.path === "/api/resources/batch")
            .map((request) => request.body);
    }

    batchCount() {
        return this.batchBodies().length;
    }

    /** The requests to `/api/llm-secrets/*` (the credential writes), in order. */
    secretRequests() {
        return this.requests.filter((request) => request.path.startsWith("/api/llm-secrets/"));
    }

    /** What a client reads of a record: the kind's projection (the masked `llmSecrets` record). */
    private project(kind: unknown, data: unknown): unknown {
        const hooks = kind as ProjectingKind;
        return hooks.project && data !== null && data !== undefined ? hooks.project(data) : data;
    }

    /** A plain write's data for a kind with `prepareWrite`, from the stored record. */
    private prepareWrite(kind: unknown, id: string, data: unknown): unknown {
        const hooks = kind as ProjectingKind;
        return hooks.prepareWrite ? hooks.prepareWrite(data, this.store.get(kind, id)?.data ?? null) : data;
    }

    /** The server's error mapping for one write (`storeErrorResponse`), without the epoch cases. */
    private errorResponse(error: unknown): Response {
        if (error instanceof this.errors.ResourceConflictError) {
            return Response.json({ error: error.message, revision: error.current }, { status: 409 });
        }
        if (error instanceof this.errors.ResourceBatchConflictError) {
            return Response.json({ error: error.message, conflicts: error.conflicts }, { status: 409 });
        }
        if (error instanceof this.errors.ResourceValidationError) {
            return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
    }

    /** `/api/llm-secrets/*`: one credential write on the record's revision, answered masked. */
    private writeSecretRoute(
        baseRevision: unknown,
        change: (record: Record<string, any>) => Record<string, any>,
    ): Response {
        if (typeof baseRevision !== "string") {
            return Response.json({ error: "baseRevision required" }, { status: 400 });
        }
        const kind = this.kind("llmSecrets");
        try {
            const current = this.store.get(kind, "main");
            if (!current) {
                throw new this.errors.ResourceConflictError(null);
            }
            const saved = this.store.put(kind, "main", change(current.data as Record<string, any>), baseRevision);
            return Response.json({
                epoch: this.store.epoch(),
                revision: saved.revision,
                data: this.project(kind, saved.data),
            });
        } catch (error) {
            return this.errorResponse(error);
        }
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
        const headers = new Headers(init.headers);

        if (url.pathname === "/api/resources" && method === "GET") {
            const names = (url.searchParams.get("kinds") ?? "").split(",").filter((name) => name !== "");
            // The boot read's two forms (the real route's query parameters): whole chats, or their summaries.
            const read = this.store.readKinds(
                names.map((name) => this.kind(name)),
                {
                    chats: url.searchParams.get("chats") === "1",
                    chatSummaries: url.searchParams.get("chatSummaries") === "1",
                },
            );
            for (const name of names) {
                read.kinds[name] = read.kinds[name].map((record) => ({
                    ...record,
                    data: this.project(this.kind(name), record.data),
                }));
            }
            return Response.json(read);
        }
        if (url.pathname === "/api/resources/revisions" && method === "GET") {
            return Response.json(this.store.listRevisions());
        }
        if (url.pathname === "/api/resources/read" && method === "POST") {
            const refs = ((body.refs ?? []) as { kind: string; id: string }[]).map((ref) => ({
                kind: this.kind(ref.kind),
                id: ref.id,
            }));
            const read = this.store.readRefs(refs, {
                chats: body.chats ?? [],
                chatCollections: body.chatCollections ?? [],
                chatSummaryCollections: body.chatSummaryCollections ?? [],
            });
            return Response.json({
                ...read,
                items: read.items.map((item) => ({ ...item, data: this.project(this.kind(item.kind), item.data) })),
            });
        }
        if (url.pathname === "/api/resources/batch" && method === "POST") {
            if (headers.get(RESOURCE_EPOCH_HEADER) !== this.store.epoch()) {
                return Response.json({ error: "EpochMismatch", epoch: this.store.epoch() }, { status: 412 });
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
            const { ops = [], chats, chatOrders } = body as { ops?: any[]; chats?: any[]; chatOrders?: any[] };
            const nested = Array.isArray(chats)
                ? chats.reduce<number>((sum, group) => sum + Math.max(group?.ops?.length ?? 0, 1), 0)
                : 0;
            const total = ops.length + nested + (Array.isArray(chatOrders) ? chatOrders.length : 0);
            if (total === 0 || total > StoreBackedServer.MAX_BATCH_OPERATIONS) {
                return Response.json(
                    {
                        error: `Body must be { ops?, chats?, chatOrders? } with 1 to ${StoreBackedServer.MAX_BATCH_OPERATIONS} operations`,
                    },
                    { status: 400 },
                );
            }
            let applied;
            try {
                const resolved = ops.map((op) => ({ ...op, kind: this.kind(op.kind) }));
                for (const op of resolved) {
                    // A patch op (audit item A1) goes to the store as sent; the store refuses one
                    // of a kind with `prepareWrite`, as the real route leaves it to.
                    if (!op.delete && !Object.hasOwn(op, "patch")) {
                        op.data = this.prepareWrite(op.kind, op.id, op.data);
                    }
                }
                applied = this.store.applyChanges({ ops: resolved, chats, chatOrders });
            } catch (error) {
                return this.errorResponse(error);
            }
            if (this.dropNextBatchResponse) {
                this.dropNextBatchResponse = false;
                throw new TypeError("Failed to fetch");
            }
            return Response.json({ epoch: this.store.epoch(), ...applied });
        }
        const single = url.pathname.match(/^\/api\/resources\/([^/]+)\/([^/]+)$/);
        if (single && method === "GET") {
            const kind = this.kind(decodeURIComponent(single[1]));
            const current = this.store.get(kind, decodeURIComponent(single[2]));
            if (!current) {
                return Response.json({ error: "Resource not found", epoch: this.store.epoch() }, { status: 404 });
            }
            return Response.json({
                epoch: this.store.epoch(),
                revision: current.revision,
                data: this.project(kind, current.data),
            });
        }
        if (url.pathname.startsWith("/api/llm-secrets/")) {
            if (headers.get(RESOURCE_EPOCH_HEADER) !== this.store.epoch()) {
                return Response.json({ error: "EpochMismatch", epoch: this.store.epoch() }, { status: 412 });
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
            if (method === "DELETE") {
                return this.writeSecretRoute(url.searchParams.get("baseRevision") ?? undefined, (record) =>
                    writeSecret(record, secretPath, ""),
                );
            }
        }
        return Response.json({ error: `Unhandled ${method} ${url.pathname}` }, { status: 500 });
    };
}
