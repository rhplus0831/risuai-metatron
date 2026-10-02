// Browser check for the Phase 5 Stop B follow-up: client Lua loads wasmoon's `glue.wasm` from the
// app's own origin, not from unpkg. A cold browser context (HTTP cache off, every non-local host
// aborted, unpkg answered by nothing) opens a character whose Lua `editDisplay` hook appends a
// marker to the greeting; the check records the wasm request (origin, status, type, magic bytes),
// that no request went to unpkg.com, that the hook's marker is shown, and (production) that a
// missing `.wasm` path is a 404 and not the app's HTML.
//
// Usage:
//   node util/playwright/checkLuaWasmOrigin.mjs
//       dev: starts an isolated stack (`stack.mjs`: a fresh server and the Vite dev server).
//   node util/playwright/checkLuaWasmOrigin.mjs --base http://localhost:6196 --password docker-pw
//       production: a server already running the built app (e.g. the Docker image) whose node
//       password is set, or unset on a fresh volume (the check sets it).
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, startStack } from "./stack.mjs";

const args = process.argv.slice(2);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1200)}`}`);
};
const MARKER = "[lua-wasm-origin]";

const stack = option("--base") ? null : await startStack({ serverPort: 6198, vitePort: 5298 });
const base = option("--base") ?? stack.baseURL;
const password = option("--password") ?? "playwright";
const origin = new URL(base).origin;
console.log(`mode: ${stack ? "dev" : "production"} at ${base}`);

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    // A cold load: no HTTP cache, so the wasm is fetched, not taken from disk cache.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    const requests = [];
    const wasm = [];
    context.on("request", (r) => requests.push(r.url()));
    context.on("requestfinished", (r) => {
        if (!new URL(r.url()).pathname.endsWith(".wasm")) return;
        wasm.push(
            (async () => {
                const res = await r.response();
                const body = res ? await res.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
                return {
                    url: r.url(),
                    status: res?.status(),
                    type: res?.headers()["content-type"],
                    magic: body.subarray(0, 4).toString("hex"),
                    bytes: body.length,
                };
            })(),
        );
    });
    // Nothing off the app's host is answered: a CDN fallback would fail, not succeed quietly.
    await context.route(
        (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
        (route) => route.abort(),
    );
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

    let auth = null;
    let epoch = null;
    page.on("request", (r) => {
        const h = r.headers();
        if (h["risu-auth"]) auth = h["risu-auth"];
        if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
    });
    page.on("response", (r) => {
        const e = r.headers()["x-resource-epoch"];
        if (e) epoch = e;
    });
    const open = async () => {
        auth = null;
        await page.goto(base);
        for (let i = 0; i < 240; i++) {
            const input = page.locator("input:visible").first();
            const ok = page.getByRole("button", { name: "OK", exact: true });
            if ((await ok.count()) > 0 && (await input.count()) > 0) {
                await input.fill(password);
                await ok.first().click();
            }
            if (auth && (await ok.count()) === 0) {
                await page.waitForTimeout(2500);
                return;
            }
            await page.waitForTimeout(500);
        }
        throw new Error("the app did not load");
    };
    await open();
    check("open: the app loaded", !!auth);

    const api = async (p, init = {}) => {
        const r = await fetch(base + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const get = async (kind) => {
        const b = (await api(`/api/resources/${kind}/main`)).body;
        epoch = b?.epoch ?? epoch;
        return b;
    };

    // Seed through the resources API: setup done, a character with a Lua editDisplay hook.
    const ui = await get("ui");
    const order = await get("characterOrder");
    const chaId = randomUUID();
    const character = {
        name: "Lua Wasm Char",
        firstMessage: "Hello from the character.",
        desc: "",
        notes: "",
        chatFolders: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        globalLore: [],
        chaId,
        type: "character",
        utilityBot: false,
        customscript: [],
        exampleMessage: "",
        creatorNotes: "",
        systemPrompt: "",
        postHistoryInstructions: "",
        alternateGreetings: [],
        tags: [],
        creator: "",
        characterVersion: "",
        personality: "",
        scenario: "",
        firstMsgIndex: -1,
        replaceGlobalNote: "",
        triggerscript: [
            {
                comment: "lua-edit",
                type: "manual",
                conditions: [],
                effect: [
                    {
                        type: "triggerlua",
                        code: `listenEdit('editDisplay', function(id, data, meta) return data .. ' ${MARKER}' end)`,
                    },
                ],
            },
        ],
    };
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: true } },
                { kind: "characters", id: chaId, baseRevision: null, data: character },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...(Array.isArray(order.data) ? order.data : []), chaId],
                },
            ],
        }),
    });
    check("seed: the character with the Lua hook was written", seeded.status === 200, seeded);

    // Open the character: rendering the greeting runs the hook, which loads the Lua runtime.
    await open();
    requests.length = 0;
    wasm.length = 0;
    await page.locator(`[data-char-id="${chaId}"]`).first().click();
    await page
        .getByText(MARKER)
        .first()
        .waitFor({ timeout: 30000 })
        .catch(() => {});
    check("lua: the editDisplay hook's marker is shown", (await page.getByText(MARKER).count()) > 0, {
        tail: (await page.evaluate(() => document.body.innerText)).slice(-400),
    });

    const wasmResponses = await Promise.all(wasm);
    const glue = wasmResponses.filter((w) => /glue/.test(new URL(w.url).pathname));
    console.log("wasm requests:", JSON.stringify(wasmResponses));
    check(
        "wasm: glue.wasm came from the app's origin as application/wasm with wasm bytes",
        glue.length > 0 &&
            glue.every(
                (w) =>
                    new URL(w.url).origin === origin &&
                    w.status === 200 &&
                    String(w.type).startsWith("application/wasm") &&
                    w.magic === "0061736d",
            ),
        glue,
    );
    const unpkg = requests.filter((u) => new URL(u).hostname.endsWith("unpkg.com"));
    check("network: no request to unpkg.com", unpkg.length === 0, unpkg);

    // Production only: the Vite dev server may answer a missing path with its HTML fallback.
    if (!stack) {
        const missing = await fetch(`${base}/assets/glue-missing.wasm`);
        const missingType = missing.headers.get("content-type") ?? "";
        check(
            "a missing .wasm path is a 404, not the app's HTML",
            missing.status === 404 && !missingType.includes("text/html"),
            { status: missing.status, type: missingType },
        );
    }
    check("no page errors", pageErrors.length === 0, pageErrors);
} finally {
    await browser.close();
    await stack?.stop();
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
}
