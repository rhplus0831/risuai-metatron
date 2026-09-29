import type { ChatOp, ChatOrderRecord, ChatRecord } from "../../../../shared/chats.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../../shared/resources.ts";

/**
 * An `authFetch` stand-in over the real server resource store (`createResourceStore`, SQLite in
 * memory), for tests of the chat module and the save loop that need the real chat contract:
 * revision tokens, the stale-by-id rule and `stale` results, the generation fence outcomes, the
 * 409 union, the 400 validation messages, and the request cap. The route layer is reduced to what
 * the client relies on: the epoch fence, the operation count, and the error mapping. The hooks
 * mirror `FakeResourceServer`'s: hold a batch, drop a response after it was applied, fail requests.
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
        options?: { chats?: boolean },
    ): {
        epoch: string;
        kinds: Record<string, { id: string; revision: string; data: any }[]>;
        chats?: ChatRecord[];
        chatOrders?: ChatOrderRecord[];
    };
    readRefs(
        refs: readonly { kind: unknown; id: string }[],
        options?: { chats?: readonly { characterId: string; id: string }[]; chatCollections?: readonly string[] },
    ): {
        epoch: string;
        items: { kind: string; id: string; revision: string | null; data: unknown }[];
        chats: (ChatRecord | { characterId: string; id: string; revision: null; data: null })[];
        chatCollections: { characterId: string; order: ChatOrderRecord | null; chats: ChatRecord[] }[];
    };
    applyChanges(batch: { ops?: readonly unknown[]; chats?: unknown; chatOrders?: unknown }): {
        results: { kind: string; id: string; revision: string | null }[];
        chats: any[];
        chatOrders: any[];
    };
};

type StoreModule = {
    createResourceStore(options: { file: string; kinds: unknown }): ServerStore;
    ResourceBatchConflictError: new (conflicts: unknown[]) => Error & { conflicts: unknown[] };
    ResourceValidationError: new (message: string) => Error;
};

type KindsModule = {
    createKindRegistry(kinds: readonly unknown[]): ReadonlyMap<string, unknown>;
    DEFAULT_RESOURCE_KINDS: readonly unknown[];
};

const SERVER_DATA = "../../../../server/src/data/";

export class StoreBackedServer {
    /** Most operations one batch may name (`MAX_BATCH_OPERATIONS` of the batch route). */
    static readonly MAX_BATCH_OPERATIONS = 5000;

    static async create(): Promise<StoreBackedServer> {
        const [storeModule, kindsModule] = (await Promise.all([
            import(/* @vite-ignore */ `${SERVER_DATA}resourceStore.ts`),
            import(/* @vite-ignore */ `${SERVER_DATA}kinds.ts`),
        ])) as [StoreModule, KindsModule];
        return new StoreBackedServer(storeModule, kindsModule);
    }

    readonly kinds: ReadonlyMap<string, unknown>;
    readonly store: ServerStore;
    /** The server's error classes, for `instanceof` checks in tests. */
    readonly errors: Pick<StoreModule, "ResourceBatchConflictError" | "ResourceValidationError">;
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

    private constructor(storeModule: StoreModule, kindsModule: KindsModule) {
        this.kinds = kindsModule.createKindRegistry(kindsModule.DEFAULT_RESOURCE_KINDS);
        this.store = storeModule.createResourceStore({ file: ":memory:", kinds: this.kinds });
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
            return Response.json(
                this.store.readKinds(
                    names.map((name) => this.kind(name)),
                    { chats: url.searchParams.get("chats") === "1" },
                ),
            );
        }
        if (url.pathname === "/api/resources/read" && method === "POST") {
            const refs = ((body.refs ?? []) as { kind: string; id: string }[]).map((ref) => ({
                kind: this.kind(ref.kind),
                id: ref.id,
            }));
            return Response.json(
                this.store.readRefs(refs, { chats: body.chats ?? [], chatCollections: body.chatCollections ?? [] }),
            );
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
                applied = this.store.applyChanges({
                    ops: ops.map((op) => ({ ...op, kind: this.kind(op.kind) })),
                    chats,
                    chatOrders,
                });
            } catch (error) {
                if (error instanceof this.errors.ResourceBatchConflictError) {
                    return Response.json({ error: error.message, conflicts: error.conflicts }, { status: 409 });
                }
                if (error instanceof this.errors.ResourceValidationError) {
                    return Response.json({ error: error.message }, { status: 400 });
                }
                throw error;
            }
            if (this.dropNextBatchResponse) {
                this.dropNextBatchResponse = false;
                throw new TypeError("Failed to fetch");
            }
            return Response.json({ epoch: this.store.epoch(), ...applied });
        }
        return Response.json({ error: `Unhandled ${method} ${url.pathname}` }, { status: 500 });
    };
}
