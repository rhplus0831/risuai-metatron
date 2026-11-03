// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeCharacter } from "../../../shared/characters.ts";
import {
    createResourceTestClient,
    createTestServer,
    createSigner,
    json,
    type ResourceTestClient,
} from "./testSupport.ts";

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

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("shutdown admission for auth and push writes", () => {
    it.each([
        { route: "/api/login", method: "POST", status: 200 },
        { route: "/api/set_password", method: "POST", status: 200 },
        { route: "/api/push/subscription", method: "PUT", status: 204 },
        { route: "/api/push/subscription", method: "DELETE", status: 204 },
    ])(
        "holds dispose for an admitted $method $route and refuses new writes with 503",
        async ({ route, method, status }) => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
            const setup = route === "/api/set_password";
            const s = createTestServer({ password: setup ? undefined : "pw" });
            const signer = await createSigner();
            if (!setup) await s.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
            const sub = {
                endpoint: "https://fcm.googleapis.com/fcm/send/draining",
                expirationTime: null,
                keys: { p256dh: s.context.push.publicKey()!, auth: Buffer.alloc(16, 1).toString("base64url") },
            };
            if (method === "DELETE") expect(await s.context.push.register(sub)).toBe("ok");
            await s.context.diagnostics.settled();
            // A key not registered yet: a login with a known key writes nothing to hold dispose.
            const newcomer = await createSigner();
            const payload =
                route === "/api/login"
                    ? { password: "pw", publicKey: newcomer.publicJwk }
                    : setup
                      ? { password: "new password" }
                      : method === "PUT"
                        ? { subscription: sub }
                        : { endpoint: sub.endpoint };
            const text = JSON.stringify(payload);
            const entered = deferred<void>();
            const release = deferred<void>();
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>(
                {
                    start(controller) {
                        controller.enqueue(encoder.encode(text.slice(0, 1)));
                    },
                    async pull(controller) {
                        entered.resolve();
                        await release.promise;
                        controller.enqueue(encoder.encode(text.slice(1)));
                        controller.close();
                    },
                },
                { highWaterMark: 0 },
            );
            const headers = { "content-type": "application/json", "risu-auth": await signer.jwt() };
            const pending = s.app.request(route, { method, headers, body, duplex: "half" } as RequestInit);
            await entered.promise;
            let disposed = false;
            const disposing = s.context.dispose().then(() => {
                disposed = true;
            });
            try {
                const refused = await s.app.request(route, { method, headers, body: text });
                expect(refused.status).toBe(503);
                expect(await refused.json()).toEqual({ error: "The server is shutting down" });
                expect(refused.headers.get("retry-after")).toBe("5");
                expect(refused.headers.get("connection")).toBe("close");
                // Drain unrelated diagnostic I/O: the admitted request must be what holds disposal.
                await s.context.diagnostics.settled();
                await s.context.diagnostics.writeState();
                await vi.advanceTimersByTimeAsync(0);
                expect(disposed).toBe(false);
                release.resolve();
                const response = await pending;
                expect(response.status).toBe(status);
                expect(response.headers.get("connection")).toBe("close");
                await disposing;
                expect(disposed).toBe(true);
                if (setup)
                    expect(readFileSync(path.join(s.savePath, "server", "password"), "utf8")).toBe("new password");
                else if (route === "/api/login")
                    expect(
                        JSON.parse(
                            readFileSync(path.join(s.savePath, "server", "known_public_key_hashes.json"), "utf8"),
                        ),
                    ).toHaveLength(2);
                else
                    expect(
                        JSON.parse(readFileSync(path.join(s.savePath, "server", "push_subscriptions.json"), "utf8"))
                            .subscriptions,
                    ).toHaveLength(method === "PUT" ? 1 : 0);
            } finally {
                release.resolve();
                await pending;
                await disposing;
                await s.close();
                vi.useRealTimers();
            }
        },
    );
});
