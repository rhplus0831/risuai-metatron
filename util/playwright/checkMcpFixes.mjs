import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
// Browser check for the fixes to the MCP clients and graph memory, on the server-job path (the only
// one since browser generation was removed; the tab client's fixes are pinned by
// `src/ts/process/mcp/tests/mcplib.test.ts`), against a mock provider (an OpenAI-compatible SSE
// stream that calls the offered tools), a mock MCP server, and a mock embedding server:
// - a remote MCP server whose every answer is an event stream with CRLF line ends and `data:`
//   without the space, whose `initialize` answer carries the session id only as a header of that
//   stream, and whose OAuth refresh answers rotate the refresh token: the tool is called with the
//   session id, the first login uses the stored refresh token and stores the rotated one, and a
//   second login (after the server drops the access token) uses that rotated token;
// - graph memory on a chat that never held the graph: `writeMemory` succeeds and `readMemory` finds
//   the entry through the embedding server.
// No public service is contacted: the OAuth refresh goes to the mock's token endpoint.
//
// Usage: node util/playwright/checkMcpFixes.mjs
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, openApp, openCharacterChat, startStack, unexpectedEgress } from "./stack.mjs";

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};

const cors = (res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-expose-headers", "Mcp-Session-Id");
};
const readBody = async (req) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    return Buffer.concat(parts).toString();
};

// The mock MCP server (streamable HTTP at /mcp) and its OAuth token endpoint (/token).
const SESSION = "session-" + randomUUID().slice(0, 8);
const mcp = { valid: null, refresh: "r1", issued: 0, refreshGrants: [], calls: [], sessionHeaders: [] };
const crlfEvent = (message) => `event:message\r\ndata:${JSON.stringify(message)}\r\n\r\n`;
const mcpServer = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }
    const text = await readBody(req);
    if (req.url === "/token") {
        const form = new URLSearchParams(text);
        mcp.refreshGrants.push(form.get("refresh_token"));
        if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== mcp.refresh) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
        }
        mcp.issued += 1;
        mcp.valid = `a${mcp.issued}`;
        mcp.refresh = `r${mcp.issued + 1}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: mcp.valid, refresh_token: mcp.refresh, token_type: "Bearer" }));
        return;
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
        // A full login would go on to registration and the owner's code: not expected here.
        res.writeHead(404);
        res.end();
        return;
    }
    if (req.url !== "/mcp") {
        res.writeHead(404);
        res.end();
        return;
    }
    if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
    }
    if (!mcp.valid || req.headers.authorization !== `Bearer ${mcp.valid}`) {
        res.writeHead(401);
        res.end();
        return;
    }
    const message = JSON.parse(text || "{}");
    mcp.calls.push(message.method);
    if (message.method !== "initialize") {
        mcp.sessionHeaders.push([message.method, req.headers["mcp-session-id"] ?? null]);
        if (req.headers["mcp-session-id"] !== SESSION) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: message.id ?? null,
                    error: { code: -32000, message: "no session" },
                }),
            );
            return;
        }
    }
    if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
    }
    let result;
    if (message.method === "initialize") {
        result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "mock", version: "1" },
        };
    } else if (message.method === "tools/list") {
        result = {
            tools: [
                {
                    name: "echo",
                    description: "Echoes its text.",
                    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                },
            ],
        };
    } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: `echo:${message.params?.arguments?.text}` }] };
    } else {
        result = {};
    }
    res.writeHead(200, {
        "content-type": "text/event-stream",
        ...(message.method === "initialize" ? { "Mcp-Session-Id": SESSION } : {}),
    });
    // The event split across two writes inside its CRLF line end.
    const event = crlfEvent({ jsonrpc: "2.0", id: message.id, result });
    const cut = event.indexOf("\r\n") + 1;
    res.write(event.slice(0, cut));
    await new Promise((r) => setTimeout(r, 20));
    res.end(event.slice(cut));
});
await new Promise((r) => mcpServer.listen(0, "127.0.0.1", r));
const mcpBase = `http://127.0.0.1:${mcpServer.address().port}`;

// The mock provider: a request offering a tool it was told to call answers with that call; a
// request that carries the tool's answer ends with a text quoting it.
let plan = [];
const upstream = [];
const provider = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    if (req.url.endsWith("/embeddings")) {
        // A vector per input: its length and its vowel count (the same text, the same vector).
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        upstream.push({ embeddings: inputs });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
            JSON.stringify({
                data: inputs.map((t) => ({
                    embedding: [String(t).length, (String(t).match(/[aeiou]/gi) ?? []).length, 1],
                })),
            }),
        );
        return;
    }
    upstream.push(body);
    // Only this send's tool answers: the history keeps earlier sends' remembered tool calls.
    const all = body.messages ?? [];
    const lastUser = all.findLastIndex((m) => m.role === "user");
    const messages = all.slice(lastUser + 1);
    const toolAnswers = messages.filter((m) => m.role === "tool").length;
    const step = plan[toolAnswers];
    const tool = step && (body.tools ?? []).find((t) => t.function?.name?.includes(step.tool));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (tool) {
        const call = {
            index: 0,
            id: `call-${toolAnswers}`,
            type: "function",
            function: { name: tool.function.name, arguments: JSON.stringify(step.args) },
        };
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    } else {
        const last = messages.filter((m) => m.role === "tool").at(-1);
        const quoted = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Done: ${quoted}` } }] })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const providerBase = `http://127.0.0.1:${provider.address().port}`;

const stack = await startStack({ serverPort: 6241, vitePort: 5341 });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });

const blank = (chaId, name, extra = {}) => ({
    chaId,
    type: "character",
    name,
    image: "",
    firstMessage: "Greetings.",
    desc: "",
    notes: "",
    chatFolders: [],
    emotionImages: [],
    bias: [],
    viewScreen: "none",
    globalLore: [],
    sdData: [],
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
    triggerscript: [],
    ...extra,
});

try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // Only the app and the local mocks: anything else is refused and counted (`stack.mjs`).
    const blocked = await isolateContext(context);
    const page = await context.newPage();
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
    const api = async (p, init = {}) => {
        const r = await fetch(stack.baseURL + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;
    const chatOf = async (chaId) =>
        (await api("/api/resources/read", { method: "POST", body: JSON.stringify({ chatCollections: [chaId] }) })).body
            ?.chatCollections?.[0]?.chats?.[0]?.data ?? null;
    const waitStored = async (chaId, predicate, ms = 30000) => {
        const until = Date.now() + ms;
        let chat = null;
        while (Date.now() < until) {
            chat = await chatOf(chaId);
            if (chat && predicate(chat)) return chat;
            await new Promise((r) => setTimeout(r, 300));
        }
        return chat;
    };
    const openChar = async (chaId) => {
        await openCharacterChat(page, chaId);
        await page.getByText("Greetings.").first().waitFor({ timeout: 15000 });
        await page.waitForTimeout(1500);
    };
    const send = async (text) => {
        // A send ends after its reply is stored (the job's tail); the next one waits for it.
        for (let until = Date.now() + 30000; Date.now() < until;) {
            const busy = await page.evaluate(async () => {
                const { doingChat } = await import("/src/ts/process/index.svelte.ts");
                let value = true;
                doingChat.subscribe((current) => (value = current))();
                return value;
            });
            if (!busy) break;
            await page.waitForTimeout(250);
        }
        const input = page.locator("textarea.input-text").first();
        await input.fill(text);
        await input.press("Enter");
    };
    const storedRefresh = async () =>
        ((await single("authRefreshes"))?.data ?? []).find((entry) => entry?.url === `${mcpBase}/mcp`) ?? null;

    await openApp(page, stack.baseURL);
    await page.waitForTimeout(1500);
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const order = await single("characterOrder");
    const presets = await single("presets");
    const modelPresets = await single("modelPresets");
    const modelProfiles = await single("modelProfiles");
    const personas = await single("personas");
    const preset = {
        ...presets.data[0],
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        forceReplaceUrl: `${providerBase}/v1/chat/completions`,
        customProxyRequestModel: "mock",
        maxContext: 4000,
        maxResponse: 100,
    };
    const providers = await single("providers");
    const media = await single("memoryTranslateMedia");
    const modules = await single("modules");
    const secrets = await single("secrets");
    const refreshes = await single("authRefreshes");
    const mcpModule = randomUUID();
    const graphModule = randomUUID();
    const mcpChar = randomUUID();
    const graphChar = randomUUID();
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
                {
                    kind: "memoryTranslateMedia",
                    id: "main",
                    baseRevision: media.revision,
                    data: {
                        ...media.data,
                        hypaV3: false,
                        hypav2: false,
                        hanuraiEnable: false,
                        hypaMemory: false,
                        hypaModel: "custom",
                    },
                },
                {
                    kind: "secrets",
                    id: "main",
                    baseRevision: secrets.revision,
                    data: {
                        ...secrets.data,
                        hypaCustomSettings: {
                            ...(secrets.data.hypaCustomSettings ?? {}),
                            url: `${providerBase}/v1`,
                            model: "mock-embed",
                        },
                    },
                },
                {
                    kind: "modules",
                    id: "main",
                    baseRevision: modules.revision,
                    data: [
                        ...(modules.data ?? []),
                        {
                            id: mcpModule,
                            name: "Mock MCP",
                            description: "",
                            lorebook: [],
                            mcp: { url: `${mcpBase}/mcp` },
                        },
                        {
                            id: graphModule,
                            name: "Graph",
                            description: "",
                            lorebook: [],
                            mcp: { url: "internal:graphmem" },
                        },
                    ],
                },
                {
                    kind: "authRefreshes",
                    id: "main",
                    baseRevision: refreshes.revision,
                    data: [
                        ...(refreshes.data ?? []),
                        {
                            url: `${mcpBase}/mcp`,
                            clientId: "client-1",
                            clientSecret: "secret-1",
                            refreshToken: "r1",
                            tokenUrl: `${mcpBase}/token`,
                        },
                    ],
                },
                {
                    kind: "characters",
                    id: mcpChar,
                    baseRevision: null,
                    data: blank(mcpChar, "Tool Toby", { modules: [mcpModule] }),
                },
                {
                    kind: "characters",
                    id: graphChar,
                    baseRevision: null,
                    data: blank(graphChar, "Graph Gia", { modules: [graphModule] }),
                },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...(Array.isArray(order.data) ? order.data : []), mcpChar, graphChar],
                },
            ],
            chats: [mcpChar, graphChar].map((characterId) => ({
                characterId,
                chatId: "t",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "t",
                            name: "T",
                            fmIndex: -1,
                            message: [],
                            ...chatBindingFixture(modelPresets, presets, personas),
                        },
                    },
                ],
            })),
        }),
    });
    check("seeded", seeded.status === 200, seeded);
    await openApp(page, stack.baseURL);
    await page.waitForTimeout(2000);

    // A remote MCP server: CRLF event streams, the session id on the stream, a rotating refresh token.
    await openChar(mcpChar);
    plan = [{ tool: "echo", args: { text: "hi" } }];
    await send("Call the echo tool");
    let chat = await waitStored(mcpChar, (c) => /Done:/.test(c.message.at(-1)?.data ?? ""));
    check("remote: the tool's answer reached the model", /echo:hi/.test(chat?.message.at(-1)?.data ?? ""), {
        last: chat?.message.at(-1),
        calls: mcp.calls,
        grants: mcp.refreshGrants,
    });
    check(
        "remote: tools/list and tools/call carried the session id of the event-stream initialize answer",
        mcp.sessionHeaders.some(([m]) => m === "tools/list") &&
            mcp.sessionHeaders.some(([m]) => m === "tools/call") &&
            mcp.sessionHeaders.every(([, id]) => id === SESSION),
        mcp.sessionHeaders,
    );
    check("remote: the first login used the stored refresh token", mcp.refreshGrants[0] === "r1", mcp.refreshGrants);
    await page.waitForTimeout(3000);
    let stored = await storedRefresh();
    check(
        "remote: the rotated refresh token is stored with the client data",
        stored?.refreshToken === "r2" &&
            stored?.clientId === "client-1" &&
            stored?.clientSecret === "secret-1" &&
            stored?.tokenUrl === `${mcpBase}/token`,
        stored,
    );
    // The server drops the access token. The call that meets the 401 resets the session and repeats
    // once without it (a recorded hazard, `plugins-mcp.md`: that call fails); the next call
    // handshakes again and logs in with the rotated token.
    mcp.valid = null;
    mcp.sessionHeaders.length = 0;
    plan = [{ tool: "echo", args: { text: "again" } }];
    await send("Call it again");
    chat = await waitStored(mcpChar, (c) => c.message.length >= 6 && c.message.at(-1)?.role === "char");
    console.log(
        "observed: the call that met the dropped token:",
        JSON.stringify(chat?.message.at(-1)?.data?.slice(-200)),
    );
    plan = [{ tool: "echo", args: { text: "third" } }];
    await send("Call it a third time");
    chat = await waitStored(mcpChar, (c) => /echo:third/.test(c.message.at(-1)?.data ?? ""));
    check("remote: the next call's answer reached the model", /echo:third/.test(chat?.message.at(-1)?.data ?? ""), {
        last: chat?.message.at(-1)?.data,
        grants: mcp.refreshGrants,
        calls: mcp.calls,
    });
    check(
        "remote: the second login used the rotated token",
        mcp.refreshGrants.length === 2 && mcp.refreshGrants[1] === "r2",
        mcp.refreshGrants,
    );
    check(
        "remote: the new session's calls carried its id",
        mcp.sessionHeaders.length > 0 && mcp.sessionHeaders.every(([, id]) => id === SESSION),
        mcp.sessionHeaders,
    );
    await page.waitForTimeout(3000);
    stored = await storedRefresh();
    check(
        "remote: the next rotated token is stored with the client data",
        stored?.refreshToken === "r3" && stored?.clientId === "client-1" && stored?.clientSecret === "secret-1",
        stored,
    );

    // Graph memory on a chat that never held the graph.
    await openChar(graphChar);
    plan = [
        { tool: "writeMemory", args: { name: "Alice", summary: "Alice likes tea.", connections: [] } },
        { tool: "readMemory", args: { query: ["Who is Alice"] } },
    ];
    const embeddingsBefore = upstream.length;
    await send("Remember Alice");
    chat = await waitStored(graphChar, (c) => /Done:/.test(c.message.at(-1)?.data ?? ""));
    const toolAnswers = upstream
        .filter((u) => !u.embeddings)
        .flatMap((u) => (u.messages ?? []).filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)));
    check(
        "graph: writeMemory succeeds on a chat without the graph",
        toolAnswers.some((t) => /written successfully/.test(t)) &&
            !toolAnswers.some((t) => /Cannot read properties of null/.test(t)),
        toolAnswers,
    );
    check("graph: readMemory finds the entry", /Alice likes tea/.test(chat?.message.at(-1)?.data ?? ""), {
        last: chat?.message.at(-1),
        toolAnswers,
    });
    const embedded = upstream.slice(embeddingsBefore).flatMap((u) => u.embeddings ?? []);
    check(
        "graph: the entry names and the query were embedded",
        embedded.includes("Alice") && embedded.includes("Who is Alice"),
        embedded,
    );
    const variable = chat?.scriptstate?.$graphmem_graph;
    check(
        "graph: the graph is stored in the chat variable",
        typeof variable === "string" && JSON.parse(variable).some((e) => e.name === "Alice"),
        variable,
    );
    // A later read (a new processor) finds the entry; the names' vectors come from the cache.
    plan = [{ tool: "readMemory", args: { query: ["Tea drinkers"] } }];
    const warmBefore = upstream.length;
    await send("Who likes tea?");
    chat = await waitStored(graphChar, (c) => {
        const asked = c.message.findLastIndex((m) => m.data === "Who likes tea?");
        return asked !== -1 && c.message.slice(asked + 1).some((m) => /Done:/.test(m.data ?? ""));
    });
    const warmEmbedded = upstream.slice(warmBefore).flatMap((u) => u.embeddings ?? []);
    check("graph: a later read finds the entry", /Alice likes tea/.test(chat?.message.at(-1)?.data ?? ""), {
        last: chat?.message.at(-1),
    });
    check(
        "graph: the later read embeds only its query",
        warmEmbedded.includes("Tea drinkers") && !warmEmbedded.includes("Alice"),
        warmEmbedded,
    );
    check("no page errors", pageErrors.length === 0, pageErrors);
    const egress = unexpectedEgress(blocked, stack ? await stack.deniedEgress() : []);
    check("no unexpected intercepted outbound attempt", egress.length === 0, egress);
    await context.close();
} finally {
    await browser.close();
    await stack.stop();
    provider.close();
    mcpServer.close();
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    if (results.some((ok) => !ok)) {
        process.exitCode = 1;
    }
}
