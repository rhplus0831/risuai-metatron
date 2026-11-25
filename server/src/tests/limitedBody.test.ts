// @vitest-environment node
import { serve } from "@hono/node-server";
import { once } from "node:events";
import type { Server } from "node:http";
import { Context, Hono } from "hono";
import { expect, it } from "vitest";
import { limitedBody, RequestBodyError } from "../routes/limitedBody.ts";
import type { AppEnv } from "../types.ts";
import { allowListenerOrigin } from "./testSupport.ts";

it("propagates a downstream handler error instead of answering 400", async () => {
    const context = new Context<AppEnv>(new Request("http://localhost/", { method: "POST", body: "{}" }));
    const error = new Error("The handler failed");
    await expect(
        limitedBody(1024)(context, async () => {
            expect(await context.req.text()).toBe("{}");
            throw error;
        }),
    ).rejects.toBe(error);
});

it("answers a declared overflow without pulling the body or running the handler", async () => {
    const app = new Hono<AppEnv>();
    let pulls = 0;
    let handled = false;
    app.post("/", limitedBody(4), (c) => {
        handled = true;
        return c.text("accepted");
    });
    const response = await app.request("/", {
        method: "POST",
        headers: { "content-length": "5" },
        body: new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    pulls++;
                    controller.enqueue(new Uint8Array(1));
                },
            },
            { highWaterMark: 0 },
        ),
        duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
    expect(pulls).toBe(0);
    expect(handled).toBe(false);
});

it("does not prefetch a body the handler leaves unread", async () => {
    const app = new Hono<AppEnv>();
    let pulls = 0;
    app.post("/", limitedBody(4), (c) => c.text("not admitted", 403));
    const response = await app.request("/", {
        method: "POST",
        body: new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    pulls++;
                    controller.enqueue(new Uint8Array(1));
                },
            },
            { highWaterMark: 0 },
        ),
        duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("not admitted");
    expect(pulls).toBe(0);
});

it.each([
    { failure: "overflow followed by source failure", chunks: 2, status: 413, error: "Request body too large" },
    { failure: "source failure under the cap", chunks: 1, status: 400, error: "Upload interrupted" },
])(
    "replaces the handler answer on $failure and keeps only cache and rate headers",
    async ({ chunks, status, error }) => {
        const app = new Hono<AppEnv>();
        let pulls = 0;
        let sourceFailed = false;
        app.post("/", limitedBody(4, "Upload interrupted"), async (c) => {
            try {
                await c.req.text();
            } catch (error) {
                if (error instanceof RequestBodyError) await error.drain();
            }
            c.header("Cache-Control", "no-store");
            c.header("RateLimit-Limit", "10");
            c.header("RateLimit-Remaining", "9");
            c.header("RateLimit-Reset", "60");
            c.header("RateLimit-Policy", "10;w=60");
            c.header("Retry-After", "5");
            c.header("Content-Encoding", "gzip");
            c.header("Content-Length", "999");
            c.header("X-Route", "discard me");
            return c.text("the route failed", 502);
        });
        const response = await app.request("/", {
            method: "POST",
            body: new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (pulls++ < chunks) controller.enqueue(new Uint8Array(4));
                        else {
                            sourceFailed = true;
                            controller.error(new Error("source failed"));
                        }
                    },
                },
                { highWaterMark: 0 },
            ),
            duplex: "half",
        } as RequestInit);
        expect(sourceFailed).toBe(true);
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error });
        expect(Object.fromEntries(response.headers)).toEqual({
            "content-type": "application/json",
            "cache-control": "no-store",
            "ratelimit-limit": "10",
            "ratelimit-remaining": "9",
            "ratelimit-reset": "60",
            "ratelimit-policy": "10;w=60",
        });
    },
);

it("passes the adapter's own disconnect signal to the handler under serve", async () => {
    const app = new Hono<AppEnv>();
    let adapterSignal: AbortSignal | undefined;
    app.post("/", limitedBody(4), async (c) =>
        c.json({
            sameSignal: c.req.raw.signal === adapterSignal,
            body: await c.req.text(),
        }),
    );
    const node = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            adapterSignal = request.signal;
            return app.fetch(request);
        },
    }) as Server;
    try {
        await once(node, "listening");
        const origin = allowListenerOrigin(node);
        const response = await fetch(origin, { method: "POST", body: "body" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ sameSignal: true, body: "body" });
    } finally {
        node.closeAllConnections();
        await new Promise<void>((resolve) => node.close(() => resolve()));
    }
});
