// Browser check for Phase 5 slice 7a (`request-layer-and-llm-secrets`, transport): with the browser
// assembly path, a send, a translation-style aux call (no chat), a suggestion-style submodel call,
// an edit followed at once by a send, and a streaming send all reach the provider through the
// server (`POST /api/llm/request`), and the browser makes no request to the provider's origin and
// sends no stored credential anywhere but the settings writes.
//
// A mock OpenAI-compatible provider listens on 127.0.0.1 (another origin than the app); the preset
// uses `reverse_proxy` with a sentinel proxy key.
//
// Usage: node util/playwright/checkLlmTransport.mjs
import http from "node:http";
import { chromium } from "playwright-core";
import { chromePath, openApp, startStack } from "./stack.mjs";

const SENTINEL = "sk-proxy-BROWSERCHECK-9999";
const results = [];
const check = (name, ok, detail) => {
    results.push([name, ok]);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1200)}`}`);
};

const providerRequests = [];
const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    let parsed = {};
    try {
        parsed = JSON.parse(body);
    } catch {}
    providerRequests.push({ url: req.url, headers: req.headers, body: parsed });
    const last = parsed.messages?.at(-1)?.content ?? "";
    if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const part of ["Streamed ", "reply ", "from ", "mock"]) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
            await new Promise((r) => setTimeout(r, 30));
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
        JSON.stringify({
            choices: [
                {
                    message: {
                        role: "assistant",
                        content: `Mock reply to: ${typeof last === "string" ? last.slice(0, 40) : "?"}`,
                    },
                },
            ],
        }),
    );
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const providerURL = `http://127.0.0.1:${provider.address().port}`;

const stack = await startStack({ serverPort: 6197, vitePort: 5297 });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const browserRequests = [];
    context.on("request", (request) => {
        browserRequests.push({
            url: request.url(),
            method: request.method(),
            headers: request.headers(),
            body: request.postData() ?? "",
        });
    });
    await context.route(
        (url) => url.hostname !== "localhost",
        (route) => route.fulfill({ status: 500, body: "{}" }),
    );
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    const consoleLines = [];
    page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`));
    await openApp(page, stack.baseURL);

    const evaluate = (body, arg) =>
        page.evaluate(
            new Function(
                "arg",
                `return (async () => { try {
                    const stores = await import("/src/ts/stores.svelte.ts");
                    const characters = await import("/src/ts/characters.ts");
                    const characterStore = await import("/src/ts/storage/characterStore.svelte.ts");
                    const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
                    const proc = await import("/src/ts/process/index.svelte.ts");
                    const request = await import("/src/ts/process/request/request.ts");
                    const sync = await import("/src/ts/storage/resourceSync.svelte.ts");
                    const DBState = stores.DBState;
                    ${body}
                } catch (error) { return { thrown: String(error && error.stack || error).slice(0, 1500) }; } })();`,
            ),
            arg,
        );

    // Seed: a preset on the mock provider through the reverse proxy, a character with a chat.
    const seeded = await evaluate(
        `
        DBState.db.didFirstSetup = true;
        // The onboarding's preset (a fresh store's preset has no prompt template yet).
        const dbm = await import("/src/ts/storage/database.svelte.ts");
        const templates = await import("/shared/presetTemplates.ts");
        dbm.applyPresetTemplate(templates.prebuiltPresets.OAI2);
        DBState.db.aiModel = "reverse_proxy";
        DBState.db.subModel = "reverse_proxy";
        DBState.db.forceReplaceUrl = arg.providerURL + "/v1/chat/completions";
        DBState.db.customProxyRequestModel = "mock-model";
        DBState.db.proxyKey = arg.sentinel;
        DBState.db.useStreaming = false;
        const char = characters.createBlankChar();
        char.name = "Mock Character";
        char.firstMessage = "Hello.";
        // A chat made by the UI has its greeting index; the blank character's chat does not.
        char.chats[0].fmIndex = -1;
        const chaId = characterStore.addCharacter(char);
        const index = DBState.db.characters.findIndex((c) => c?.chaId === chaId);
        stores.selectedCharID.set(index);
        const live = DBState.db.characters[index];
        const chatId = live.chats[live.chatPage].id;
        await sync.flushResources();
        return { chaId, chatId };
        `,
        { providerURL, sentinel: SENTINEL },
    );
    check("seeded a character and a chat", !!seeded.chaId && !!seeded.chatId, seeded);
    browserRequests.length = 0;

    // 1. A send (non-streaming).
    const sent = await evaluate(
        `
        const ref = { chaId: arg.chaId, chatId: arg.chatId };
        chatStore.appendMessage?.(ref, { role: "user", data: "first message" });
        const before = chatStore.findChat(ref).message.length;
        const ok = await proc.sendChat(-1);
        const chat = chatStore.findChat(ref);
        return { ok, before, after: chat.message.length, last: chat.message.at(-1)?.data };
        `,
        seeded,
    );
    check(
        "send: the reply from the mock provider lands in the chat",
        sent.ok !== false && String(sent.last).includes("Mock reply"),
        sent,
    );
    check(
        "send: the provider got the stored proxy key",
        providerRequests.at(-1)?.headers.authorization === `Bearer ${SENTINEL}`,
        providerRequests.at(-1)?.headers,
    );

    // 2. A no-chat aux call (the translator's shape).
    const aux = await evaluate(
        `
        const r = await request.requestChatData({ formated: [{ role: "user", content: "translate me" }], bias: {}, useStreaming: false, noMultiGen: true }, "translate");
        return r;
        `,
    );
    check("aux: a translate-mode call answers", aux.type === "success" && aux.result.includes("translate me"), aux);

    // 3. A submodel call with the character (the suggestion's shape).
    const sub = await evaluate(
        `
        const char = DBState.db.characters.find((c) => c.chaId === arg.chaId);
        return await request.requestChatData({ formated: [{ role: "user", content: "suggest" }], bias: {}, currentChar: char }, "submodel");
        `,
        seeded,
    );
    check("submodel: a suggestion-style call answers", sub.type === "success" && sub.result.includes("suggest"), sub);

    // 4. An edit followed at once by a send: the edit reaches the provider.
    const edited = await evaluate(
        `
        DBState.db.customProxyRequestModel = "edited-model";
        const r = await request.requestChatData({ formated: [{ role: "user", content: "after edit" }], bias: {} }, "model");
        return r.type;
        `,
    );
    check(
        "edit then send: the provider got the model edited just before",
        edited === "success" && providerRequests.at(-1)?.body?.model === "edited-model",
        { edited, model: providerRequests.at(-1)?.body?.model },
    );

    // 5. A streaming send.
    const streamed = await evaluate(
        `
        DBState.db.useStreaming = true;
        // The chat screen clears \`doingChat\` after a send; a direct call has to.
        proc.doingChat.set(false);
        chatStore.appendMessage({ chaId: arg.chaId, chatId: arg.chatId }, { role: "user", data: "stream please" });
        const ok = await proc.sendChat(-1);
        const chat = chatStore.findChat({ chaId: arg.chaId, chatId: arg.chatId });
        DBState.db.useStreaming = false;
        const alertMod = await import("/src/ts/alert.ts");
        let alertValue = null;
        alertMod.alertStore?.subscribe?.((v) => (alertValue = v))?.();
        return { ok, last: chat.message.at(-1)?.data, alert: alertValue };
        `,
        seeded,
    );
    check(
        "streaming send: the streamed text lands in the chat",
        String(streamed.last).includes("Streamed reply from mock"),
        streamed,
    );
    if (!String(streamed.last).includes("Streamed reply from mock")) {
        console.log(
            consoleLines
                .filter((l) => /error|warn|fail|stream/i.test(l))
                .slice(-30)
                .join("\n"),
        );
    }

    // The network: nothing to the provider's origin, no credential outside the settings writes.
    const toProvider = browserRequests.filter(
        (r) => r.url.startsWith(providerURL) || new URL(r.url).port === String(provider.address().port),
    );
    check(
        "network: the browser made no request to the provider",
        toProvider.length === 0,
        toProvider.map((r) => r.url),
    );
    const llmRequests = browserRequests.filter((r) => r.url.includes("/api/llm/request"));
    check("network: the provider calls went through /api/llm/request", llmRequests.length >= 5, llmRequests.length);
    const leaked = browserRequests.filter(
        (r) =>
            !r.url.includes("/api/resources") &&
            (r.body.includes(SENTINEL) || JSON.stringify(r.headers).includes(SENTINEL)),
    );
    check(
        "network: no request but a settings write carried the stored key",
        leaked.length === 0,
        leaked.map((r) => r.url),
    );
    const nonLocal = browserRequests.filter((r) => new URL(r.url).hostname !== "localhost");
    check(
        "network: every browser request was same-origin",
        nonLocal.length === 0,
        nonLocal.map((r) => r.url),
    );
    check("no page errors", pageErrors.length === 0, pageErrors);
} finally {
    await browser.close();
    await stack.stop();
    provider.close();
}
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
