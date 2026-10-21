import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
// Browser check: the display transform of a chat runs through `POST /api/transform` for a chat with
// `editdisplay` regex scripts, a Lua `editDisplay` listener that sets a chat variable, and a
// display trigger (the expected text is checked; there is no browser path to compare with): the
// variable is not stored (rendering is read-only); a streamed reply renders raw while it streams
// and transformed after; "Re-render" bypasses the cache (a server-evaluated `{{random}}` changes);
// a tab plugin `editdisplay` handler runs between the two calls; the HypaV3 modal's `editprocess`
// runs on the server.
//
// Usage: node util/playwright/checkServerTransform.mjs
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, openCharacterChat, startStack, unexpectedEgress } from "./stack.mjs";

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};

// The provider streams `mode.chunks`, `mode.delayMs` apart.
let mode = { chunks: ["Hello ", "stream."], delayMs: 50 };
const provider = http.createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: mode.chunks.join("") } }] }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of mode.chunks) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, mode.delayMs));
    }
    res.write("data: [DONE]\n\n");
    res.end();
});
await new Promise((r) => provider.listen(0, "127.0.0.1", () => r()));
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1/chat/completions`;

const LUA = `listenEdit("editDisplay", function(id, value, meta) setChatVar(id, "lv", "7") return value .. " [lua" .. meta.index .. "]" end)`;

const stack = await startStack({
    serverPort: 6211,
    vitePort: 5311,
    log: process.env.DEBUG ? (text) => process.stderr.write(text) : undefined,
});
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
    const run = async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        // Only the app and the local mocks: anything else is refused and counted (`stack.mjs`).
        const blocked = await isolateContext(context);
        const page = await context.newPage();
        const pageErrors = [];
        page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
        const requests = [];
        page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? "" }));
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
            await page.goto(stack.baseURL);
            for (let i = 0; i < 240; i++) {
                const input = page.locator("input:visible").first();
                const ok = page.getByRole("button", { name: "OK", exact: true });
                if ((await ok.count()) > 0 && (await input.count()) > 0) {
                    await input.fill("playwright");
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
        const api = async (p, init = {}) => {
            const r = await fetch(stack.baseURL + p, {
                ...init,
                headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
            });
            return { status: r.status, body: await r.json().catch(() => null) };
        };
        const transformPosts = () =>
            requests
                .filter((r) => r.method === "POST" && new URL(r.url).pathname.startsWith("/api/transform"))
                .map((r) => ({ path: new URL(r.url).pathname, body: JSON.parse(r.body) }));
        const label = "server";
        await open();
        const ui = (await api("/api/resources/ui/main")).body;
        epoch = ui.epoch ?? epoch;
        const order = (await api("/api/resources/characterOrder/main")).body;
        const presets = (await api("/api/resources/presets/main")).body;
        const modelPresets = (await api("/api/resources/modelPresets/main")).body;
        const modelProfiles = (await api("/api/resources/modelProfiles/main")).body;
        const providers = (await api("/api/resources/providers/main")).body;
        const personas = (await api("/api/resources/personas/main")).body;
        const chaId = randomUUID();
        const chatId = randomUUID();
        const preset = {
            ...presets.data[0],
            aiModel: "reverse_proxy",
            subModel: "reverse_proxy",
            forceReplaceUrl: providerUrl,
            customProxyRequestModel: "mock",
            maxContext: 4000,
            maxResponse: 100,
        };
        const character = {
            name: `Transform Char ${label}`,
            firstMessage: "Hello greeting EMO",
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
            customscript: [
                { comment: "upper", in: "Hello", out: "HELLO", type: "editdisplay", flag: "g" },
                {
                    comment: "random",
                    in: "RND",
                    out: "R{{random::a::b::c::d::e::f::g::h}}",
                    type: "editdisplay",
                    flag: "g",
                },
                { comment: "var", in: "VAR", out: "V={{getvar::lv}}", type: "editdisplay", flag: "g" },
                { comment: "proc", in: "PROC", out: "PROCESSED", type: "editprocess", flag: "g" },
            ],
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
                { comment: "lua", type: "start", conditions: [], effect: [{ type: "triggerlua", code: LUA }] },
                {
                    comment: "display",
                    type: "display",
                    conditions: [],
                    effect: [
                        { type: "v2GetDisplayState", indent: 0, outputVar: "d" },
                        { type: "v2SetDisplayState", indent: 0, valueType: "var", value: "d" },
                    ],
                },
            ],
        };
        const seeded = await api("/api/resources/batch", {
            method: "POST",
            body: JSON.stringify({
                ops: [
                    ...modelFixtureOps({ ...preset, customTokenizer: "tik" }, modelPresets, modelProfiles),
                    { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: true } },
                    {
                        kind: "presets",
                        id: "main",
                        baseRevision: presets.revision,
                        data: [promptFixture(preset), ...presets.data.slice(1)],
                    },
                    {
                        kind: "providers",
                        id: "main",
                        baseRevision: providers.revision,
                        data: { ...providers.data, useStreaming: true },
                    },
                    { kind: "characters", id: chaId, baseRevision: null, data: character },
                    {
                        kind: "characterOrder",
                        id: "main",
                        baseRevision: order.revision,
                        data: [...(Array.isArray(order.data) ? order.data : []), chaId],
                    },
                ],
                chats: [
                    {
                        characterId: chaId,
                        chatId,
                        baseRevision: null,
                        ops: [
                            {
                                op: "create",
                                chat: {
                                    id: chatId,
                                    name: "Chat",
                                    // Bound: the streamed reply below is a send, which refuses an
                                    // unbound chat.
                                    ...chatBindingFixture(modelPresets, presets, personas),
                                    message: [
                                        { role: "user", data: "Hello user VAR", chatId: "m-user" },
                                        { role: "char", data: "Plain RND reply", chatId: "m-rnd" },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            }),
        });
        check(`${label}: seeded`, seeded.status === 200, seeded);
        await open();
        await openCharacterChat(page, chaId);
        await page
            .getByText("Hello user")
            .first()
            .waitFor({ timeout: 15000 })
            .catch(() => {});
        await page.waitForTimeout(2500);
        const bodyText = () => page.evaluate(() => document.body.innerText);
        const text = await bodyText();
        const lines = (needle) => text.split("\n").filter((line) => line.includes(needle));
        check(`${label}: the greeting is transformed`, text.includes("HELLO greeting EMO [lua-1]"), lines("greeting"));
        check(
            `${label}: a message is transformed`,
            text.includes("HELLO user V=") && text.includes("[lua0]"),
            lines("user"),
        );
        const storedChat = async () =>
            (
                await api("/api/resources/read", {
                    method: "POST",
                    body: JSON.stringify({ chats: [{ characterId: chaId, id: chatId }] }),
                })
            ).body?.chats?.[0]?.data;
        await page.waitForTimeout(1500);
        const state = (await storedChat())?.scriptstate ?? {};
        check("server: transform requests were made", transformPosts().length > 0, transformPosts().length);
        check("server: the Lua variable was not stored", state.$lv === undefined, state);

        // "Re-render" bypasses the cache: the server-evaluated {{random}} changes in a few tries.
        const before = lines("Plain");
        const values = new Set(before);
        const menuItem = async () => {
            // The item is in the row's popup menu.
            const row = page.locator(".risu-chat").filter({ hasText: "Plain" }).last();
            await row.hover();
            await row.locator(".button-icon-menu").first().click();
            const button = page.locator(".button-icon-rerender").last();
            await button.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
            if ((await button.count()) === 0) {
                return false;
            }
            await button.click({ force: true });
            return true;
        };
        let clicked = false;
        for (let i = 0; i < 4; i++) {
            requests.length = 0;
            clicked = (await menuItem()) || clicked;
            await page.waitForTimeout(1500);
            const now = (await bodyText()).split("\n").filter((line) => line.includes("Plain"));
            now.forEach((line) => values.add(line));
        }
        check("server: the Re-render item exists", clicked);
        check("server: Re-render changes a server-evaluated {{random}}", values.size > 1, [...values]);

        // A tab plugin editdisplay handler runs between the two calls.
        requests.length = 0;
        await page.evaluate(async () => {
            const { pluginHooks } = await import("/src/ts/plugins/pluginHooks.ts");
            pluginHooks.editdisplay.add((text) => text + " +plugin");
            const { ReloadGUIPointer } = await import("/src/ts/stores.svelte.ts");
            ReloadGUIPointer.update((v) => v + 1);
        });
        await page.waitForTimeout(2500);
        const posts = transformPosts();
        check(
            "server: a plugin handler makes two calls",
            posts.some((p) => p.path === "/api/transform" && p.body.handlers) &&
                posts.some((p) => p.path === "/api/transform/continue"),
            posts.map((p) => p.path),
        );
        check("server: the handler's text is rendered", (await bodyText()).includes("+plugin"), lines("+plugin"));
        await page.evaluate(async () => {
            const { pluginHooks } = await import("/src/ts/plugins/pluginHooks.ts");
            pluginHooks.editdisplay.clear();
        });

        // HypaV3's editprocess runs on the server.
        requests.length = 0;
        const processed = await page.evaluate(async () => {
            const { processRegexScript } = await import("/src/lib/Others/HypaV3Modal/utils.ts");
            return (await processRegexScript({ role: "char", data: "PROC here", chatId: "x" }, 1)).data;
        });
        check(
            "server: HypaV3 editprocess on the server",
            processed === "PROCESSED here" && transformPosts().some((p) => p.body.mode === "editprocess"),
            [processed, transformPosts().map((p) => p.body.mode)],
        );

        // A streamed reply: raw while it streams (flag on), the transform after.
        requests.length = 0;
        mode = { chunks: ["Hello ", "slow ", "stream ", "reply."], delayMs: 600 };
        const input = page.locator("textarea.input-text").first();
        await input.fill("Stream please");
        await input.press("Enter");
        await page
            .getByText("slow")
            .first()
            .waitFor({ timeout: 20000 })
            .catch(() => {});
        const mid = (await bodyText()).split("\n").filter((line) => line.includes("slow"));
        check(
            "server: a streaming reply shows raw text",
            mid.some((line) => line.includes("Hello slow") && !line.includes("HELLO")),
            mid,
        );
        await page
            .getByText("reply.")
            .first()
            .waitFor({ timeout: 20000 })
            .catch(() => {});
        await page.waitForTimeout(3000);
        const done = (await bodyText()).split("\n").filter((line) => line.includes("reply."));
        check(
            `${label}: the completed reply is transformed`,
            done.some((line) => line.includes("HELLO slow stream reply.")),
            done,
        );

        check(`${label}: no page errors`, pageErrors.length === 0, pageErrors);

        const egress = unexpectedEgress(blocked, stack ? await stack.deniedEgress() : []);

        check(`${label}: no unexpected intercepted outbound attempt`, egress.length === 0, egress);
        await context.close();
    };
    await run();
} finally {
    await browser.close();
    await stack.stop();
    provider.close();
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    if (results.some((ok) => !ok)) {
        process.exitCode = 1;
    }
}
