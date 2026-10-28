import type { ResourceBootResult } from "../../../../shared/resources.ts";
import type { ServerStore, StoreBackedServer } from "./storeBackedServer";

// As in storeBackedServer, keep the strict server project out of the client's type program.
const SERVER_ROUTES = "../../../../server/src/routes/";
type Kind = { project?: (data: unknown) => unknown };
type BootRoute = {
    parseBootRequest(body: unknown, kinds: ReadonlyMap<string, unknown>): unknown;
    readBoot(store: ServerStore, request: unknown, project: (kind: Kind, data: unknown) => unknown): ResourceBootResult;
};

/** Add the real boot projection to the in-memory resource server's HTTP boundary. */
export async function recoveryBootServer(server: StoreBackedServer) {
    const route = (await import(/* @vite-ignore */ `${SERVER_ROUTES}resourceBoot.ts`)) as BootRoute;
    const bootAnswers: ResourceBootResult[] = [];
    const io = {
        fallback: false,
        bootAnswers,
        fetch: async (path: string, init?: RequestInit): Promise<Response> => {
            if (path !== "/api/resources/boot") return server.fetch(path, init);
            const body: unknown = JSON.parse(init!.body as string);
            server.requests.push({ method: "POST", path, body });
            if (io.fallback) return Response.json({ error: "boot unavailable" }, { status: 503 });
            const request = route.parseBootRequest(body, server.kinds);
            if (typeof request === "string") throw new Error(request);
            const answer = route.readBoot(server.store, request, (kind, data) => kind.project?.(data) ?? data);
            bootAnswers.push(answer);
            return Response.json(answer);
        },
    };
    return io;
}
