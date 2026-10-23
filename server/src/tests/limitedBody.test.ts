// @vitest-environment node
import { Context } from "hono";
import { expect, it } from "vitest";
import { limitedBody } from "../routes/limitedBody.ts";
import type { AppEnv } from "../types.ts";

it("propagates a downstream handler error instead of answering 400", async () => {
    const context = new Context<AppEnv>(new Request("http://localhost/", { method: "POST", body: "{}" }));
    const error = new Error("The handler failed");
    await expect(
        limitedBody(1024)(context, async () => {
            throw error;
        }),
    ).rejects.toBe(error);
});
