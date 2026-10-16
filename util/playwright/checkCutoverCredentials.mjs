import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
// Browser check for the Phase 5 cutover's credential criterion ("no LLM provider credential appears
// in client network traffic, except the request that enters or replaces a key"): every credential
// leaf of `llmSecrets` (`shared/llmSecrets.ts`) gets its own sentinel, set through the server's
// `PUT /api/llm-secrets/*` from this script; then the tab runs the consumers that stay after the
// cutover, and everything the browser context sent or received is searched for every sentinel:
// request URLs, full headers (and their decoded forms), and bodies; response headers and bodies (a
// streamed answer through the page's own copy, as the browser protocol keeps no stream body); every
// WebSocket's URL and frames. The one exemption is the body of the tab's own key replacement
// (`PUT /api/llm-secrets/openAIKey`), never its URL, headers, or response.
//
// The server reaches the providers' fixed HTTPS origins through a `fetch` preload (`--import`, this
// harness only): those origins go to a local responder, after the server injected the stored
// credential, so each row shows the upstream request carrying its sentinel. Any other `fetch` egress
// of the server is refused (the home screen's hub listing is the expected one); the browser context
// may reach only local hosts (the CDN stylesheets are expected blocks). Node `http`/`https` requests
// of the server are not wrapped (none of these rows makes one).
//
// Rows (each must finish, give its expected result, and show its key upstream): a send (a server
// job), a send whose provider answers 401 with the key it got (the redacted error reaches the tab),
// a send with an image attachment, the LLM translator, the suggestion component's submodel call,
// a key replaced in the tab and then used, `registerModelDynamic` (Google, Anthropic, OpenAI model
// lists), `generateAIImage` with DALL-E and with Imagen, `sayTTS` with OpenAI, Whisper (its only
// consumer is a component: the transport call it makes), `HypaProcesser` embeddings
// (`supaMemoryKey`), and the Google token count (`encode`). The coverage table lists each row and
// what is not exercised.
//
// What this proves: in these runs, no sentinel reached the browser. It is not a proof for every
// code path; the sentinels of providers not exercised here only show they are never sent to the tab.
//
// Usage: node util/playwright/checkCutoverCredentials.mjs
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromePath, openApp, openCharacterChat, startStack } from "./stack.mjs";

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};

// One sentinel per credential leaf (distinct, long, and not a substring of another).
/** Every sentinel ever issued (a replaced key stays here: the scan looks for all of them). */
const ISSUED = [];
const sentinel = (name) => {
    const value = `SENTINEL-${name}-${randomUUID().replaceAll("-", "")}`;
    ISSUED.push({ name, value });
    return value;
};
const SECRETS = {
    openAIKey: sentinel("openAIKey"),
    claudeAPIKey: sentinel("claudeAPIKey"),
    openrouterKey: sentinel("openrouterKey"),
    nanogptKey: sentinel("nanogptKey"),
    mistralKey: sentinel("mistralKey"),
    cohereAPIKey: sentinel("cohereAPIKey"),
    ollamaApiKey: sentinel("ollamaApiKey"),
    novellistAPI: sentinel("novellistAPI"),
    mancerHeader: sentinel("mancerHeader"),
    supaMemoryKey: sentinel("supaMemoryKey"),
    vertexPrivateKey: sentinel("vertexPrivateKey"),
    vertexAccessToken: sentinel("vertexAccessToken"),
    "google/accessToken": sentinel("googleAccessToken"),
    "hordeConfig/apiKey": sentinel("hordeApiKey"),
    "novelai/token": sentinel("novelaiToken"),
    "OaiCompAPIKeys/~OpenAI": sentinel("oaiCompOpenAI"),
    "credentials/~custom-check/key": sentinel("customNamedKey"),
    "credentials/~proxy-check/key": sentinel("proxyNamedKey"),
};

// The local responder for the providers' fixed origins (reached through the server's preload).
const upstream = [];
const denied = [];
let failChats = false;
const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
);
// 50 ms of 8 kHz mono silence, a valid WAV the tab's audio decoder accepts.
const silentWav = (() => {
    const samples = 400;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + samples * 2, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples * 2, 40);
    return wav;
})();
const responder = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (req.url === "/__denied") {
        denied.push(raw.toString("utf8"));
        res.end();
        return;
    }
    const match = /^\/__up\/([^/]+)(\/[^?]*)(\?.*)?$/.exec(req.url ?? "");
    if (!match) {
        res.writeHead(404);
        res.end();
        return;
    }
    const [, host, pathname, search = ""] = match;
    const text = raw.toString("utf8");
    upstream.push({ host, pathname, search, method: req.method, headers: req.headers, body: text });
    const json = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    };
    if (host === "api.openai.com" && pathname === "/v1/chat/completions") {
        if (failChats) {
            json(401, { error: { message: `Incorrect API key provided: ${req.headers.authorization}` } });
            return;
        }
        let body = {};
        try {
            body = JSON.parse(text);
        } catch {}
        if (body.stream) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Mock answer." } }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
        } else {
            json(200, { choices: [{ message: { role: "assistant", content: "Mock answer." } }] });
        }
        return;
    }
    if (host === "api.openai.com" && pathname === "/v1/images/generations") {
        json(200, { data: [{ b64_json: tinyPng.toString("base64") }] });
        return;
    }
    if (host === "api.openai.com" && pathname === "/v1/audio/speech") {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(silentWav);
        return;
    }
    if (host === "api.openai.com" && pathname === "/v1/audio/transcriptions") {
        json(200, { text: "transcribed" });
        return;
    }
    if (host === "api.openai.com" && pathname === "/v1/embeddings") {
        let input = [];
        try {
            input = JSON.parse(text).input;
        } catch {}
        json(200, { data: (Array.isArray(input) ? input : [input]).map(() => ({ embedding: [0.1, 0.2, 0.3] })) });
        return;
    }
    if (host === "api.openai.com" && pathname === "/v1/models") {
        json(200, { data: [{ id: "gpt-sentinel-1", object: "model" }] });
        return;
    }
    if (host === "api.anthropic.com" && pathname === "/v1/models") {
        json(200, { data: [{ id: "claude-sentinel-1", display_name: "Claude Sentinel" }] });
        return;
    }
    if (host === "generativelanguage.googleapis.com" && pathname === "/v1beta/models") {
        json(200, {
            models: [
                {
                    name: "models/gemini-sentinel-1",
                    displayName: "Gemini Sentinel",
                    supportedGenerationMethods: ["generateContent"],
                },
            ],
        });
        return;
    }
    if (host === "generativelanguage.googleapis.com" && pathname.endsWith(":countTokens")) {
        json(200, { totalTokens: 5 });
        return;
    }
    if (host === "generativelanguage.googleapis.com" && pathname.endsWith(":predict")) {
        json(200, { predictions: [{ bytesBase64Encoded: tinyPng.toString("base64"), mimeType: "image/png" }] });
        return;
    }
    json(404, { error: "not mocked" });
});
await new Promise((r) => responder.listen(0, "127.0.0.1", () => r()));
const responderBase = `http://127.0.0.1:${responder.address().port}`;

// The server's preload: the fixed provider origins go to the responder, any other non-local egress
// is refused (and reported to the responder).
const preloadDir = await mkdtemp(path.join(os.tmpdir(), "risu-egress-"));
const preload = path.join(preloadDir, "egress.mjs");
await writeFile(
    preload,
    `const responder = ${JSON.stringify(responderBase)};
const routed = new Set(["api.openai.com", "generativelanguage.googleapis.com", "api.anthropic.com", "openrouter.ai", "nano-gpt.com", "ollama.com"]);
const local = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (local.has(url.hostname)) return realFetch(input, init);
    if (routed.has(url.hostname)) {
        const target = responder + "/__up/" + url.hostname + url.pathname + url.search;
        return realFetch(input instanceof Request ? new Request(target, input) : target, init);
    }
    await realFetch(responder + "/__denied", { method: "POST", body: url.href }).catch(() => {});
    throw new TypeError("egress denied by the check: " + url.origin);
};
`,
);

const stack = await startStack({
    serverPort: 6251,
    vitePort: 5351,
    serverEnv: { NODE_OPTIONS: `--import=${preload}` },
    log: process.env.DEBUG ? (text) => process.stderr.write(text) : undefined,
});
const browser = await chromium.launch({ executablePath: chromePath, headless: true });

// Everything the browser sent or received, as text, captured for the whole context (every page and
// socket). Asynchronous captures (full headers, response bodies) are tracked and drained before the
// verdict; a failed body capture of an app response is reported, not ignored.
const traffic = [];
const blocked = [];
const pending = [];
const captureFailures = [];
/** The app's own answers whose bodies must be captured: its API and the auxiliary `/proxy2` calls. */
const isAppResponse = (url, appOrigin) => {
    const parsed = new URL(url);
    return parsed.origin === appOrigin && /^\/(api\/|proxy2$)/.test(parsed.pathname);
};
/** App responses (`isAppResponse`) the context saw, per URL (the page copies must match each one). */
const appResponses = new Map();
let watching = false;
const record = (where, text) => {
    if (watching && text) traffic.push({ where, text });
};
const recordWithDecoded = (where, text) => {
    record(where, text);
    try {
        record(`${where} (decoded)`, decodeURIComponent(text));
    } catch {}
};
const watchContext = (context, appOrigin) => {
    context.on("request", (request) => {
        if (!watching) return;
        const url = request.url();
        recordWithDecoded(`request url ${url}`, url);
        const body = request.postDataBuffer();
        if (body) record(`request body ${request.method()} ${url}`, body.toString("latin1"));
        pending.push(
            request.allHeaders().then(
                (headers) => {
                    for (const [name, value] of Object.entries(headers))
                        recordWithDecoded(`request header ${name} ${url}`, value);
                },
                (error) => captureFailures.push(`request headers ${url}: ${error}`),
            ),
        );
    });
    context.on("response", (response) => {
        if (!watching) return;
        const url = response.url();
        if (isAppResponse(url, appOrigin)) {
            appResponses.set(url, (appResponses.get(url) ?? 0) + 1);
        }
        pending.push(
            response.allHeaders().then(
                (headers) => {
                    for (const [name, value] of Object.entries(headers))
                        recordWithDecoded(`response header ${name} ${url}`, value);
                },
                (error) => captureFailures.push(`response headers ${url}: ${error}`),
            ),
            response.body().then(
                (body) => record(`response body ${url}`, body.toString("latin1")),
                (error) => {
                    if (isAppResponse(url, appOrigin)) {
                        captureFailures.push(`response body ${url}: ${String(error).slice(0, 120)}`);
                    }
                },
            ),
        );
    });
    const watchPage = (page) =>
        page.on("websocket", (ws) => {
            recordWithDecoded(`ws url ${ws.url()}`, ws.url());
            ws.on("framesent", (frame) => record(`ws sent ${ws.url()}`, String(frame.payload)));
            ws.on("framereceived", (frame) => record(`ws received ${ws.url()}`, String(frame.payload)));
        });
    context.on("page", watchPage);
    for (const page of context.pages()) watchPage(page);
};
const drain = async () => {
    while (pending.length > 0) {
        await Promise.allSettled(pending.splice(0));
    }
};

try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const appOrigin = new URL(stack.baseURL).origin;
    watchContext(context, appOrigin);
    // The page's own copy of every app response body (a streamed answer included, which the
    // browser protocol does not keep): a clone read beside the app's reader.
    await context.addInitScript(() => {
        const original = window.fetch;
        window.__appBodies = [];
        window.__appBodyReads = [];
        window.fetch = async (...args) => {
            const response = await original(...args);
            try {
                if (/^\/(api\/|proxy2$)/.test(new URL(response.url).pathname)) {
                    window.__appBodyReads.push(
                        response
                            .clone()
                            .text()
                            .then(
                                (text) => window.__appBodies.push([response.url, text]),
                                (error) => window.__appBodies.push([response.url, null, String(error)]),
                            ),
                    );
                }
            } catch {}
            return response;
        };
        // The TTS row's observable: a decode that succeeded.
        const decode = AudioContext.prototype.decodeAudioData;
        AudioContext.prototype.decodeAudioData = async function (...args) {
            const decoded = await decode.apply(this, args);
            window.__decodedAudio = (window.__decodedAudio ?? 0) + 1;
            return decoded;
        };
    });
    await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === appOrigin || url.protocol === "data:" || url.protocol === "blob:") {
            return route.continue();
        }
        blocked.push(url.href);
        return route.abort();
    });
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
    await openApp(page, stack.baseURL);
    await page.waitForTimeout(1500);
    const api = async (p, init = {}) => {
        const r = await fetch(stack.serverURL + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    // Seed: an OpenAI preset (gpt-4o, for the main and the auxiliary model), a character with a chat.
    const ui = (await api("/api/resources/ui/main")).body;
    epoch = ui.epoch ?? epoch;
    const order = (await api("/api/resources/characterOrder/main")).body;
    const presets = (await api("/api/resources/presets/main")).body;
    const modelPresets = (await api("/api/resources/modelPresets/main")).body;
    const modelProfiles = (await api("/api/resources/modelProfiles/main")).body;
    const providers = (await api("/api/resources/providers/main")).body;
    const credentials = (await api("/api/resources/credentials/main")).body;
    const personas = (await api("/api/resources/personas/main")).body;
    const chaId = randomUUID();
    const chatId = randomUUID();
    const preset = {
        ...presets.data[0],
        aiModel: "gpt4o",
        subModel: "gpt4o",
        maxContext: 4000,
        maxResponse: 100,
        mainPrompt: "Main prompt for {{char}}.",
    };
    const character = {
        name: "Credential Char",
        firstMessage: "Greetings.",
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
        triggerscript: [],
    };
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "credentials",
                    id: "main",
                    baseRevision: credentials.revision,
                    data: [
                        ...credentials.data,
                        { id: "custom-check", name: "Custom key", type: "custom" },
                        { id: "proxy-check", name: "Proxy key", type: "custom" },
                    ],
                },
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
            // A bound chat: a send refuses an unbound chat, and a character's first chat starts
            // unbound (`docs/plan/chat-binding.md`).
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
                                name: "Chat 1",
                                fmIndex: -1,
                                message: [],
                                ...chatBindingFixture(modelPresets, presets, personas),
                            },
                        },
                    ],
                },
            ],
        }),
    });
    check("seeded", seeded.status === 200, seeded);

    // Every credential leaf, set from this script (not through the browser).
    let secretsRecord = (await api("/api/resources/llmSecrets/main")).body;
    let revision = secretsRecord.revision;
    let writes = 0;
    for (const [secretPath, value] of Object.entries(SECRETS)) {
        const put = await api(`/api/llm-secrets/${secretPath}`, {
            method: "PUT",
            body: JSON.stringify({ value, baseRevision: revision }),
        });
        if (put.status === 200) {
            writes += 1;
            revision = put.body.revision;
        } else {
            console.log("secret write failed", secretPath, put.status, put.body);
        }
    }
    check("every credential leaf was set", writes === Object.keys(SECRETS).length, writes);

    // From here on, every browser request and response is recorded (the reload reads the masked record).
    // The app is unloaded first, so no request of the earlier document is still in flight when the
    // capture starts (its answer would arrive after the navigation, with its body already discarded).
    await page.goto("about:blank");
    watching = true;
    await openApp(page, stack.baseURL);
    await page.waitForTimeout(1500);
    const masked = await page.evaluate(async () => {
        const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
        const { readSettingsRoot, writeSettingsRoot } = await import("/src/ts/storage/settingsViews.svelte.ts");
        return JSON.stringify({ openAIKey: readSettingsRoot("openAIKey"), google: readSettingsRoot("google") });
    });
    check(
        "the tab holds no credential (masked after boot)",
        !Object.values(SECRETS).some((value) => masked.includes(value)),
        masked,
    );

    const coverage = [];
    const sentinelOf = (secretName) => SECRETS[secretName];
    const usedSecret = (requests, value) =>
        requests.some((u) => JSON.stringify(u.headers).includes(value) || u.search.includes(value));
    // One row: `run` must finish, `expect` must accept its result, and an upstream request matching
    // `match` must carry the stored credential (the server injected it). Anything else fails the row.
    const scenario = async (name, secretName, run, match, expect = () => true) => {
        const start = upstream.length;
        let error = null;
        let result;
        let timer;
        try {
            result = await Promise.race([
                run(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("the row took over 90 s")), 90000);
                }),
            ]);
        } catch (e) {
            error = String(e).slice(0, 300);
        } finally {
            clearTimeout(timer);
        }
        await page.waitForTimeout(500);
        const seen = upstream.slice(start).filter(match);
        const value = sentinelOf(secretName);
        const keyed = seen.length > 0 && usedSecret(seen, value);
        let expected = false;
        try {
            expected = error === null && !!expect(result);
        } catch (e) {
            error = String(e).slice(0, 300);
        }
        coverage.push({ name, secret: secretName, upstream: seen.map((u) => `${u.method} ${u.host}${u.pathname}`) });
        check(`${name}: reached its provider with the stored ${secretName} and gave its result`, keyed && expected, {
            error,
            result: JSON.stringify(result)?.slice(0, 300),
            seen: seen.map((u) => `${u.method} ${u.host}${u.pathname}`),
        });
    };
    const isOpenAI = (p) => (u) => u.host === "api.openai.com" && u.pathname === p;
    const isGoogle = (suffix) => (u) => u.host === "generativelanguage.googleapis.com" && u.pathname.endsWith(suffix);

    await openCharacterChat(page, chaId);
    await page.getByText("Greetings.").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    const input = page.locator("textarea.input-text").first();
    const waitIdle = async () => {
        for (const until = Date.now() + 30000; Date.now() < until;) {
            if ((await page.locator('button[aria-labelledby="cancel"]').count()) === 0) return true;
            await page.waitForTimeout(250);
        }
        throw new Error("the send did not end");
    };
    const lastStored = async () =>
        (
            await api("/api/resources/read", { method: "POST", body: JSON.stringify({ chatCollections: [chaId] }) })
        ).body?.chatCollections?.[0]?.chats?.[0]?.data?.message?.at(-1)?.data;

    await scenario(
        "send (a server job)",
        "openAIKey",
        async () => {
            await input.fill("Hello there");
            await input.press("Enter");
            await page.getByText("Mock answer.").first().waitFor({ timeout: 20000 });
            await waitIdle();
            await page.waitForTimeout(1500);
            return lastStored();
        },
        isOpenAI("/v1/chat/completions"),
        (stored) => stored === "Mock answer.",
    );
    await scenario(
        "send whose provider echoes the key in a 401 (the error, redacted, reaches the tab)",
        "openAIKey",
        async () => {
            failChats = true;
            const start = upstream.length;
            let text = "";
            try {
                await input.fill("Fail please");
                await input.press("Enter");
                // The job ends with the provider's error (an alert or an error message in the chat).
                for (const until = Date.now() + 40000; Date.now() < until;) {
                    text = `${await page.evaluate(() => document.body.innerText)}\n${(await lastStored()) ?? ""}`;
                    if (/Incorrect API key provided/.test(text)) break;
                    await page.waitForTimeout(250);
                }
                await waitIdle();
            } finally {
                failChats = false;
            }
            if (upstream.slice(start).length === 0) throw new Error("no provider request");
            const ok = page.getByRole("button", { name: "OK", exact: true });
            if ((await ok.count()) > 0) await ok.first().click();
            return text;
        },
        isOpenAI("/v1/chat/completions"),
        (text) => /Incorrect API key provided/.test(text),
    );
    await scenario(
        "send with an image attachment",
        "openAIKey",
        () =>
            page.evaluate(async (png) => {
                const inlays = await import("/src/ts/process/files/inlays.ts");
                const chats = await import("/src/ts/storage/chatStore.svelte.ts");
                const proc = await import("/src/ts/process/index.svelte.ts");
                const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
                const id = await inlays.postInlayAsset({ name: "pixel.png", data: bytes });
                const ref = chats.currentChatRef();
                chats.appendMessage(ref, { role: "user", data: `Look {{inlayed::${id}}}` });
                try {
                    return await proc.sendChat(-1, { target: ref });
                } finally {
                    proc.doingChat.set(false);
                }
            }, tinyPng.toString("base64")),
        (u) => isOpenAI("/v1/chat/completions")(u) && u.body.includes("image_url"),
        (sent) => sent === true,
    );
    await scenario(
        "translation (the LLM translator, runTranslator)",
        "openAIKey",
        () =>
            page.evaluate(async () => {
                const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
                const { readSettingsRoot, writeSettingsRoot } = await import("/src/ts/storage/settingsViews.svelte.ts");
                const translator = await import("/src/ts/translator/translator.ts");
                writeSettingsRoot("translatorType", "llm");
                return translator.runTranslator("안녕하세요", false, "ko", "en");
            }),
        isOpenAI("/v1/chat/completions"),
        (text) => typeof text === "string" && text.includes("Mock answer."),
    );
    await scenario(
        "submodel request (the suggestion component's requestChatData call)",
        "openAIKey",
        () =>
            page.evaluate(async () => {
                const { requestChatData } = await import("/src/ts/process/request/request.ts");
                const answer = await requestChatData(
                    { formated: [{ role: "user", content: "Suggest a reply" }], bias: {}, useStreaming: false },
                    "submodel",
                );
                return answer.type === "success" ? answer.result : answer;
            }),
        isOpenAI("/v1/chat/completions"),
        (text) => text === "Mock answer.",
    );
    // A key entered in the tab (the one exempt request: its PUT body) replaces the stored one, and
    // the next request uses the new key.
    SECRETS.openAIKeyReplaced = sentinel("openAIKeyReplaced");
    await scenario(
        "a key replaced in the tab, then used",
        "openAIKeyReplaced",
        () =>
            page.evaluate(async (value) => {
                const secrets = await import("/src/ts/storage/llmSecrets.svelte.ts");
                const sync = await import("/src/ts/storage/resourceSync.svelte.ts");
                const { requestChatData } = await import("/src/ts/process/request/request.ts");
                secrets.setSecret({ kind: "flat", field: "openAIKey" }, value);
                await sync.awaitSecretWrites();
                const answer = await requestChatData(
                    { formated: [{ role: "user", content: "With the new key" }], bias: {}, useStreaming: false },
                    "submodel",
                );
                return answer.type === "success" ? answer.result : answer;
            }, SECRETS.openAIKeyReplaced),
        isOpenAI("/v1/chat/completions"),
        (text) => text === "Mock answer.",
    );
    SECRETS.openAIKey = SECRETS.openAIKeyReplaced;
    await scenario(
        "model lists (registerModelDynamic: Google, Anthropic, OpenAI)",
        "openAIKey",
        () =>
            page.evaluate(async () => {
                const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
                const { readSettingsRoot, writeSettingsRoot } = await import("/src/ts/storage/settingsViews.svelte.ts");
                const models = await import("/src/ts/model/modellist.ts");
                writeSettingsRoot("dynamicModelRegistry", true);
                await models.registerModelDynamic();
                // The catalogue holds the model each mock list named.
                return [
                    "dynamic_google_gemini-sentinel-1",
                    "dynamic_anthropic_claude-sentinel-1",
                    "gpt-sentinel-1",
                ].filter((id) => models.LLMModels.some((model) => model.id === id));
            }),
        (u) =>
            (u.host === "api.openai.com" && u.pathname === "/v1/models") ||
            (u.host === "generativelanguage.googleapis.com" && u.pathname === "/v1beta/models") ||
            u.host === "api.anthropic.com",
        (registered) => registered.length === 3,
    );
    for (const [secretName, match] of [
        [
            "google/accessToken",
            (u) => u.host === "generativelanguage.googleapis.com" && u.pathname === "/v1beta/models",
        ],
        ["claudeAPIKey", (u) => u.host === "api.anthropic.com"],
    ]) {
        const seen = upstream.filter(match);
        check(`model lists: ${secretName} was used upstream`, usedSecret(seen, SECRETS[secretName]), seen.length);
    }
    const image = (provider) => () =>
        page.evaluate(async (sdProvider) => {
            const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
            const { readSettingsRoot, writeSettingsRoot } = await import("/src/ts/storage/settingsViews.svelte.ts");
            const { generateAIImage } = await import("/src/ts/process/stableDiff.ts");
            writeSettingsRoot("sdProvider", sdProvider);
            const char = characterList().find((c) => c?.name === "Credential Char");
            return generateAIImage("a cat", char, "", "inlay");
        }, provider);
    await scenario(
        "DALL-E (generateAIImage)",
        "openAIKey",
        image("dalle"),
        isOpenAI("/v1/images/generations"),
        (r) => !!r,
    );
    await scenario("Imagen (generateAIImage)", "google/accessToken", image("Imagen"), isGoogle(":predict"), (r) => !!r);
    await scenario(
        "OpenAI TTS (sayTTS)",
        "openAIKey",
        () =>
            page.evaluate(async () => {
                const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
                const { readSettingsRoot, writeSettingsRoot } = await import("/src/ts/storage/settingsViews.svelte.ts");
                const { sayTTS } = await import("/src/ts/process/tts.ts");
                const char = JSON.parse(JSON.stringify(characterList().find((c) => c?.name === "Credential Char")));
                const decodedBefore = window.__decodedAudio ?? 0;
                await sayTTS({ ...char, ttsMode: "openai", oaiVoice: "alloy" }, "hello");
                return { decoded: (window.__decodedAudio ?? 0) - decodedBefore, text: document.body.innerText };
            }),
        isOpenAI("/v1/audio/speech"),
        (r) => r.decoded === 1 && !/TTS Error|HTTP Error/i.test(r.text),
    );
    await scenario(
        "Whisper (its only consumer is a component: the transport call PlaygroundSubtitle makes)",
        "openAIKey",
        () =>
            page.evaluate(async () => {
                const { auxFetch } = await import("/src/ts/network/auxFetch.ts");
                const form = new FormData();
                form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }), "a.mp3");
                form.append("model", "whisper-1");
                const response = await auxFetch("openai-whisper", "https://api.openai.com/v1/audio/transcriptions", {
                    body: form,
                });
                return { ok: response.ok, body: await response.json() };
            }),
        isOpenAI("/v1/audio/transcriptions"),
        (r) => r.ok && r.body?.text === "transcribed",
    );
    await scenario(
        "memory embeddings (HypaProcesser, the embedding playground's and the memory's path)",
        "supaMemoryKey",
        () =>
            page.evaluate(async () => {
                const { HypaProcesser } = await import("/src/ts/process/memory/hypamemory.ts");
                const processer = new HypaProcesser("openai3small");
                await processer.addText(["first text", "second text"]);
                return (await processer.similaritySearch("first")).length;
            }),
        isOpenAI("/v1/embeddings"),
        (count) => count === 2,
    );
    await scenario(
        "Google token count (encode with googleClaudeTokenizing)",
        "google/accessToken",
        () =>
            page.evaluate(async () => {
                const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
                const { readSettingsRoot, writeSettingsRoot } = await import("/src/ts/storage/settingsViews.svelte.ts");
                const tokenizer = await import("/src/ts/tokenizer.ts");
                const { activeModelPreset } = await import("/src/ts/storage/settingsViews.svelte.ts");
                const { setMainModelSlot } = await import("/src/ts/storage/collectionStore.svelte.ts");
                const { applyModelFixtureSettings } = await import("/util/playwright/modelProfiles.browser.mjs");
                const previous = activeModelPreset.mainSlot.profileId;
                applyModelFixtureSettings({ aiModel: "gemini-1.5-pro-latest" });
                writeSettingsRoot("googleClaudeTokenizing", true);
                try {
                    return (await tokenizer.encode("hello world, counted remotely")).length;
                } finally {
                    setMainModelSlot(activeModelPreset.id, previous);
                    writeSettingsRoot("googleClaudeTokenizing", false);
                }
            }),
        isGoogle(":countTokens"),
        (count) => count === 5,
    );

    await page.waitForTimeout(2000);
    await drain();
    const teed = await page.evaluate(async () => {
        const settled = await Promise.race([
            Promise.allSettled(window.__appBodyReads).then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
        ]);
        return { settled, bodies: window.__appBodies, reads: window.__appBodyReads.length };
    });
    check("every page copy of an app response finished", teed.settled && teed.bodies.length === teed.reads, {
        settled: teed.settled,
        bodies: teed.bodies.length,
        reads: teed.reads,
    });
    const teedCount = new Map();
    for (const [url, text, error] of teed.bodies) {
        if (text === null) {
            captureFailures.push(`page copy ${url}: ${error}`);
        } else {
            teedCount.set(url, (teedCount.get(url) ?? 0) + 1);
            record(`response body (page copy) ${url}`, text);
        }
    }
    // A body the browser protocol did not keep (a stream) is covered only when the page copied every
    // response of that URL (each response its own copy, counted, not one copy for all).
    for (let i = captureFailures.length - 1; i >= 0; i--) {
        const match = /^response body (\S+):/.exec(captureFailures[i]);
        if (match && (teedCount.get(match[1]) ?? 0) >= (appResponses.get(match[1]) ?? Infinity)) {
            captureFailures.splice(i, 1);
        }
    }
    // The criterion: no sentinel in anything the browser sent or received.
    const leaks = [];
    for (const entry of traffic) {
        // The one exempt request: the key entry's PUT body (not its URL, headers, or response).
        const keyEntry = /^request body PUT .*\/api\/llm-secrets\/openAIKey$/.test(entry.where);
        for (const { name, value } of ISSUED) {
            if (keyEntry && value === SECRETS.openAIKeyReplaced) continue;
            if (entry.text.includes(value)) leaks.push({ secret: name, where: entry.where });
        }
    }
    check(
        "the key entry's PUT carried the new key (the exemption is used, not empty)",
        traffic.some(
            (e) =>
                /^request body PUT .*\/api\/llm-secrets\/openAIKey$/.test(e.where) &&
                e.text.includes(SECRETS.openAIKeyReplaced),
        ),
    );
    check("every app response was captured", captureFailures.length === 0, captureFailures.slice(0, 10));
    check("no credential in the browser's traffic", leaks.length === 0, leaks.slice(0, 20));
    check("traffic was captured", traffic.length > 50, traffic.length);
    // Blocked as expected (not credential consumers): the home screen's hub listing through the
    // server's hub proxy, and the stylesheets the page loads from CDNs. Anything else fails.
    const expectedServer = (href) => new URL(href).hostname === "sv.risuai.xyz";
    const expectedBrowser = (href) =>
        ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"].includes(new URL(href).hostname);
    check(
        "the server made no other outside request",
        denied.filter((href) => !expectedServer(href)).length === 0,
        denied,
    );
    check(
        "the browser reached no other origin",
        blocked.filter((href) => !expectedBrowser(href)).length === 0,
        blocked,
    );
    check("no page errors", pageErrors.length === 0, pageErrors);
    console.log("\ncoverage:");
    for (const row of coverage) {
        console.log(`  ${row.name} | ${row.secret} | ${row.upstream.join(", ") || "(none)"}`);
    }
    console.log(
        "\nnot exercised here (their sentinels only show they never reach the tab): sends through Anthropic, Google, Mistral, Cohere, NovelAI, NovelList, Horde, OpenRouter, NanoGPT, Ollama, Vertex, Mancer, an OpenAI-compatible key map entry, a preset proxy key, a custom model key; the OpenRouter, NanoGPT, and Ollama discovery and account operations; previews; Whisper through its component.",
    );
    await context.close();
} finally {
    await browser.close();
    await stack.stop();
    responder.close();
    await rm(preloadDir, { recursive: true, force: true });
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    if (results.some((ok) => !ok)) {
        process.exitCode = 1;
    }
}
