import type { CheckpointSummary } from "../../../../shared/chatCheckpoints.ts";
import type { Chat } from "../../../../shared/database.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../../shared/resources.ts";
import { StoreBackedServer, type ServerStore } from "../../storage/tests/storeBackedServer";

type ServiceRequest = { body: unknown; epoch?: string };
type ServiceResult = { status: number; body: Record<string, unknown> };
type CheckpointService = Record<
    "list" | "save" | "rename" | "remove" | "load" | "readPolicy" | "writePolicy",
    (request: ServiceRequest) => ServiceResult
>;
type CheckpointStore = ServerStore & {
    checkpoints: {
        compose(characterId: string, chatId: string, id: string): Chat | null;
        list(characterId: string, chatId: string): CheckpointSummary[] | null;
    };
};
type ServiceModule = {
    createCheckpointService(options: {
        store: ServerStore;
        busy: (characterId: string, chatId: string) => boolean;
        memoryTasks: null;
    }): CheckpointService;
};

export function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

/** A deterministic boundary before a load commits, or before its answer reaches the tab. */
function latch() {
    const entered = deferred();
    const released = deferred();
    return {
        entered: entered.promise,
        release: () => released.resolve(),
        async wait() {
            entered.resolve();
            await released.promise;
        },
    };
}

const SERVER_DATA = "../../../../server/src/data/";
const PATH = "/api/chat-checkpoints";

/** The real checkpoint service on the resource adapter's store; unrelated routes pass through. */
export class CheckpointServer {
    static async create() {
        // As in StoreBackedServer: do not bring strict server sources into the client TS project.
        const module = (await import(/* @vite-ignore */ `${SERVER_DATA}checkpointService.ts`)) as ServiceModule;
        return new CheckpointServer(await StoreBackedServer.create({ lock: true }), module);
    }

    readonly service: CheckpointService;
    readonly store: CheckpointStore;
    readonly requests: { method: string; path: string; body: Record<string, unknown>; epoch: string | null }[] = [];
    readonly answers: { path: string; result: ServiceResult }[] = [];
    busy = false;
    dropLoadAnswer = false;
    beforeLoad: ReturnType<typeof latch> | null = null;
    afterLoad: ReturnType<typeof latch> | null = null;

    private constructor(
        readonly resources: StoreBackedServer,
        module: ServiceModule,
    ) {
        this.store = resources.store as CheckpointStore;
        const lock = resources.lock as typeof resources.lock & {
            chatHolders(characterId: string, chatId: string): ReadonlySet<string>;
        };
        this.service = module.createCheckpointService({
            store: this.store,
            busy: (characterId, chatId) => this.busy || !!lock?.chatHolders(characterId, chatId).size,
            memoryTasks: null,
        });
    }

    holdLoad(stage: "request" | "answer") {
        const held = latch();
        if (stage === "request") this.beforeLoad = held;
        else this.afterLoad = held;
        return held;
    }

    readonly fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
        const url = new URL(path, "http://test");
        if (url.pathname !== PATH && !url.pathname.startsWith(`${PATH}/`)) {
            return this.resources.fetch(path, init);
        }
        const method = init.method ?? "GET";
        const body = method === "GET" ? Object.fromEntries(url.searchParams) : JSON.parse(String(init.body));
        const epoch = new Headers(init.headers).get(RESOURCE_EPOCH_HEADER);
        this.requests.push({ method, path: url.pathname, body, epoch });
        const operation = url.pathname.slice(PATH.length + 1);
        if (operation === "load") {
            const held = this.beforeLoad;
            this.beforeLoad = null;
            await held?.wait();
        }

        let result: ServiceResult;
        if (operation === "policy" && (method === "GET" || method === "PUT")) {
            result =
                method === "GET"
                    ? this.service.readPolicy({ body })
                    : this.service.writePolicy({ body, epoch: epoch ?? undefined });
        } else if (url.pathname === PATH && method === "GET") {
            result = this.service.list({ body });
        } else if (method === "POST" && ["save", "rename", "delete", "load"].includes(operation)) {
            const action = operation === "delete" ? "remove" : (operation as "save" | "rename" | "load");
            result = this.service[action]({ body, epoch: epoch ?? undefined });
        } else {
            result = { status: 404, body: { error: "Unknown checkpoint route" } };
        }
        this.answers.push({ path: url.pathname, result });
        if (operation === "load") {
            const held = this.afterLoad;
            this.afterLoad = null;
            await held?.wait();
            if (this.dropLoadAnswer) {
                this.dropLoadAnswer = false;
                throw new TypeError("Load answer lost after commit");
            }
        }
        return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
    };

    close() {
        this.beforeLoad?.release();
        this.afterLoad?.release();
        this.resources.close();
    }
}
