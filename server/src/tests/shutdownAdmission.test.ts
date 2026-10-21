// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
import { createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

// Shutdown against resource requests, in process (`shutdown.test.ts` covers the `main.ts` drain):
// a request admitted before shutdown began keeps the store open until it has answered, and a new
// one is refused with a retryable 503 that also closes its connection.

const servers: ResourceTestClient[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("shutdown admission for resource requests", () => {
    it("lets a write admitted before shutdown finish against the open store, and refuses new requests with 503", async () => {
        const s = await createResourceTestClient();
        servers.push(s);
        const encoder = new TextEncoder();
        let release!: () => void;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"baseRevision":null,"data":'));
                release = () => {
                    controller.enqueue(encoder.encode('{"chaId":"draining"}}'));
                    controller.close();
                };
            },
        });
        const headers = { ...(await s.headers()), "content-type": "application/json" };
        const pending = s.app.request(
            new Request("http://localhost/api/resources/characters/draining", {
                method: "PUT",
                headers,
                body,
                duplex: "half",
            } as RequestInit),
        );
        // Admission happens inside app.request(), before the handler's first await: shutdown begins
        // right after it, while the handler waits for the rest of its body.
        s.context.beginShutdown();
        let disposed = false;
        const disposing = s.context.dispose().then(() => {
            disposed = true;
        });

        const refused = await s.request("/api/resources/characters");
        expect(refused.status).toBe(503);
        expect(refused.headers.get("retry-after")).toBe("5");
        expect(refused.headers.get("connection")).toBe("close");
        expect(await refused.json()).toEqual({ error: "The server is shutting down" });
        expect(disposed).toBe(false);

        release();
        const saved = await pending;
        expect(saved.status).toBe(200);
        expect(saved.headers.get("connection")).toBe("close");
        expect(((await saved.json()) as { data: unknown }).data).toEqual(normalizeCharacter({ chaId: "draining" }));
        await disposing;
        expect(disposed).toBe(true);
    });
});
