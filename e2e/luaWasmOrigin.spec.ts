import { expect, test, type Request } from "@playwright/test";
import { openApp } from "../util/playwright/stack.mjs";

// Phase 5 Stop B follow-up: the client Lua runtime (`src/ts/process/scriptings.ts` `makeLuaFactory`)
// hands `LuaFactory` the app's own `glue.wasm` (a Vite `?url` asset of the installed wasmoon
// package). Without a URL, wasmoon in a browser fetches `https://unpkg.com/wasmoon@<version>/dist/glue.wasm`.
// The Lua unit tests substitute the asset URL for Node, so only a browser run shows the delivery:
// in a cold context (HTTP cache off, every host but the stack's aborted, so a CDN fallback fails
// instead of passing quietly) a Lua script runs, the one `glue*.wasm` request is same-origin, 200,
// `application/wasm` with wasm magic bytes, and no request goes to unpkg.com.

test("client Lua loads glue.wasm from the app's origin, not from unpkg", async ({ page, baseURL }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    const hosts: string[] = [];
    // Requests for wasm binaries. The Vite dev server also serves the `?url` import itself as a JS
    // module at `glue.wasm?import&url` (in a build the URL is an inlined string); that one has a
    // query string and is not the binary.
    const wasmRequests: Request[] = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        hosts.push(url.hostname);
        if (url.pathname.endsWith(".wasm") && url.search === "") {
            wasmRequests.push(request);
        }
    });
    await page.context().route(
        (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
        (route) => route.abort(),
    );

    await openApp(page, baseURL!);
    const result = await page.evaluate(async () => {
        const { runScripted } = await import("/src/ts/process/scriptings.ts");
        const run = await runScripted("function onStart() return 'lua-' .. (1 + 1) end", {
            char: { type: "simple", chaId: "e2e-lua-wasm", customscript: [] } as any,
            chat: { message: [] } as any,
            mode: "start",
        });
        return { res: run.res, stopSending: run.stopSending };
    });
    expect(result).toEqual({ res: "lua-2", stopSending: false });

    const origin = new URL(baseURL!).origin;
    expect(wasmRequests.map((request) => new URL(request.url()).origin)).toEqual(wasmRequests.map(() => origin));
    const glue = wasmRequests.filter((request) => /glue[^/]*\.wasm$/.test(new URL(request.url()).pathname));
    expect(glue.map((request) => request.url())).toHaveLength(1);
    const response = await glue[0].response();
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-type"]).toMatch(/^application\/wasm/);
    const body = await response!.body();
    expect(body.subarray(0, 4).toString("hex")).toBe("0061736d");
    expect(body.length).toBeGreaterThan(100_000);

    expect(hosts.filter((host) => host.endsWith("unpkg.com"))).toEqual([]);
    expect(errors).toEqual([]);
});
