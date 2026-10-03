// Browser check for Phase 5 slice 9: a send from the chat input runs as a server job against a mock provider (an OpenAI-compatible SSE stream): the
// browser posts the job with the input and its user message id, the user message and the streamed
// reply show and are stored, a continue extends the reply, a settings edit made right before a
// preview reaches the assembled prompt (the pre-send flush), an abort keeps the text so far, and a
// reload in the middle of a slow stream shows the checkpointed text and then the whole reply; the
// messages render through the server transform.
//
// Usage:
//   node util/playwright/checkServerSend.mjs
//       dev: starts an isolated stack (`stack.mjs`).
//   node util/playwright/checkServerSend.mjs --base http://localhost:6197 --password docker-pw \
//       --provider-host host.docker.internal
//       production: a server already running the built app (e.g. the Docker image; a fresh volume's
//       password is set by the check). The mock provider listens on every interface and the preset
//       names it by `--provider-host`. The preview step needs the dev modules (a DevTool function)
//       and is skipped; the continue and the abort go through the chat screen in both modes.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, startStack, unexpectedEgress } from "./stack.mjs";

const args = process.argv.slice(2);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};

// The provider: each request streams `mode.chunks`, `mode.delayMs` apart.
let mode = { chunks: ["Mock ", "reply."], delayMs: 50 };
const upstream = [];
const provider = http.createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    upstream.push(body);
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
const providerHost = option("--provider-host");
await new Promise((r) => provider.listen(0, providerHost ? "0.0.0.0" : "127.0.0.1", () => r()));
const providerUrl = `http://${providerHost ?? "127.0.0.1"}:${provider.address().port}/v1/chat/completions`;

const stack = option("--base")
    ? null
    : await startStack({
          serverPort: 6201,
          vitePort: 5301,
          log: process.env.DEBUG
              ? (text) => /\[(Lua|Generation|LLM)\]/.test(text) && process.stderr.write(text)
              : undefined,
      });
const base = option("--base") ?? stack.baseURL;
const password = option("--password") ?? "playwright";
console.log(`mode: ${stack ? "dev" : "production"} at ${base}`);
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
        const api = async (p, init = {}) => {
            const r = await fetch(base + p, {
                ...init,
                headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
            });
            return { status: r.status, body: await r.json().catch(() => null) };
        };
        const label = "server";
        await open();
        const ui = (await api("/api/resources/ui/main")).body;
        epoch = ui.epoch ?? epoch;
        const order = (await api("/api/resources/characterOrder/main")).body;
        const presets = (await api("/api/resources/presets/main")).body;
        const providers = (await api("/api/resources/providers/main")).body;
        const chaId = randomUUID();
        const preset = {
            ...presets.data[0],
            aiModel: "reverse_proxy",
            subModel: "reverse_proxy",
            forceReplaceUrl: providerUrl,
            customProxyRequestModel: "mock",
            maxContext: 4000,
            maxResponse: 100,
            mainPrompt: "Main prompt for {{char}}.",
        };
        const character = {
            name: `Send Char ${label}`,
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
                        kind: "ui",
                        id: "main",
                        baseRevision: ui.revision,
                        // "Say nothing" off: a continue from an empty input appends "*says nothing*" first otherwise.
                        data: { ...ui.data, didFirstSetup: true, useSayNothing: false },
                    },
                    {
                        kind: "presets",
                        id: "main",
                        baseRevision: presets.revision,
                        data: [preset, ...presets.data.slice(1)],
                    },
                    {
                        kind: "providers",
                        id: "main",
                        baseRevision: providers.revision,
                        data: { ...providers.data, useStreaming: true, customTokenizer: "tik" },
                    },
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
        check(`${label}: seeded`, seeded.status === 200, seeded);
        await open();
        await page.locator(`[data-char-id="${chaId}"]`).first().click();
        await page.getByText("Greetings.").first().waitFor({ timeout: 15000 });
        await page.waitForTimeout(1500);
        const storedMessages = async () =>
            (await api("/api/resources/read", { method: "POST", body: JSON.stringify({ chatCollections: [chaId] }) }))
                .body?.chatCollections?.[0]?.chats?.[0]?.data?.message ?? [];
        const jobPosts = () =>
            requests
                .filter((r) => r.method === "POST" && new URL(r.url).pathname === "/api/generations")
                .map((r) => JSON.parse(r.body));
        // The tab's send has ended: the cancel button (shown while `doingChat`) is gone.
        const waitIdle = async (ms = 30000) => {
            for (const until = Date.now() + ms; Date.now() < until;) {
                if ((await page.locator('button[aria-labelledby="cancel"]').count()) === 0) return true;
                await page.waitForTimeout(250);
            }
            return false;
        };

        // A send from the chat input.
        requests.length = 0;
        mode = { chunks: ["Mock ", "reply."], delayMs: 50 };
        const input = page.locator("textarea.input-text").first();
        await input.fill("Hello there");
        await input.press("Enter");
        await page
            .getByText("Mock reply.")
            .first()
            .waitFor({ timeout: 20000 })
            .catch(() => {});
        check(`${label}: the reply is shown`, (await page.getByText("Mock reply.").count()) > 0, {
            tail: (await page.evaluate(() => document.body.innerText)).slice(-500),
        });
        check(`${label}: the user message is shown`, (await page.getByText("Hello there").count()) > 0);
        await page.waitForTimeout(2000);
        let stored = await storedMessages();
        check(
            `${label}: stored on the server`,
            JSON.stringify(stored.map((m) => `${m.role}:${m.data}`)) ===
                JSON.stringify(["user:Hello there", "char:Mock reply."]),
            stored.map((m) => `${m.role}:${m.data}`),
        );
        check(
            `${label}: the prompt reached the provider`,
            JSON.stringify(upstream.at(-1)?.messages ?? []).includes("Hello there"),
            upstream.at(-1)?.messages,
        );
        const posts = jobPosts();
        check(
            "server: a send job with the input and its user message id",
            posts.length === 1 &&
                posts[0].kind === "send" &&
                posts[0].context.input === "Hello there" &&
                stored[0]?.chatId === posts[0].context.userMessageId,
            posts,
        );

        check(
            "server: the messages were rendered through the server transform",
            requests.some((r) => r.method === "POST" && new URL(r.url).pathname === "/api/transform"),
        );
        // A continue from the chat menu ("Continue Response", `sendMain(true)`).
        requests.length = 0;
        mode = { chunks: [" And", " more."], delayMs: 50 };
        await page.locator(".button-icon-send + button").first().click();
        await page.getByText("Continue Response", { exact: true }).first().click();
        await waitIdle();
        await page.waitForTimeout(1500);
        stored = await storedMessages();
        check(
            "server: continue extends the reply",
            stored.at(-1)?.data === "Mock reply. And more." && stored.length === 2,
            stored.map((m) => m.data),
        );
        check("server: continue ran as a job", jobPosts()[0]?.kind === "continue", jobPosts());

        if (stack) {
            // A settings edit right before a preview reaches the prompt (the flush comes first). The
            // preview is a DevTool function: it needs the dev modules.
            const previewHead = await page.evaluate(async () => {
                const stores = await import("/src/ts/stores.svelte.ts");
                const proc = await import("/src/ts/process/index.svelte.ts");
                stores.DBState.db.mainPrompt = "Edited main for {{char}}.";
                const ok = await proc.sendChat(-1, { preview: true });
                proc.doingChat.set(false);
                return ok ? proc.previewFormated[0]?.content : null;
            });
            check(
                "server: an edit right before the preview is in its prompt",
                typeof previewHead === "string" && previewHead.startsWith("Edited main for Send Char"),
                previewHead,
            );
        }

        // An abort (the cancel button while the reply streams) keeps the text so far.
        mode = { chunks: ["Slow one. ", "Slow two. ", "Slow three. ", "Slow four."], delayMs: 700 };
        await input.fill("Stop me");
        await input.press("Enter");
        await page.getByText("Slow one.").first().waitFor({ timeout: 20000 });
        await page.locator('button[aria-labelledby="cancel"]').first().click();
        await waitIdle();
        await page.waitForTimeout(1500);
        stored = await storedMessages();
        const last = stored.at(-1)?.data ?? "";
        check(
            "server: an abort keeps the text so far",
            last.startsWith("Slow one.") && !last.includes("Slow four."),
            last,
        );
        // A reload in the middle of a slow stream: the checkpointed text, then the whole reply.
        mode = { chunks: ["Part A. ", "Part B. ", "Part C. ", "Part D. ", "Part E. ", "Part F."], delayMs: 900 };
        await input.fill("Tell me slowly");
        await input.press("Enter");
        await page.getByText("Part A.").first().waitFor({ timeout: 20000 });
        await page.waitForTimeout(3500);
        await open();
        await page.locator(`[data-char-id="${chaId}"]`).first().click();
        await page.getByText("Tell me slowly").first().waitFor({ timeout: 15000 });
        const midText = (await page.evaluate(() => document.body.innerText)).includes("Part A.");
        check("server: after a reload mid-stream the text so far shows", midText);
        await page
            .getByText("Part F.")
            .first()
            .waitFor({ timeout: 20000 })
            .catch(() => {});
        check("server: the reply completes after the reload", (await page.getByText("Part F.").count()) > 0);
        await page.waitForTimeout(1500);
        stored = await storedMessages();
        check(
            "server: the whole reply is stored",
            stored.at(-1)?.data === "Part A. Part B. Part C. Part D. Part E. Part F.",
            stored.at(-1)?.data,
        );
        check(`${label}: no page errors`, pageErrors.length === 0, pageErrors);
        const egress = unexpectedEgress(blocked, stack ? await stack.deniedEgress() : []);
        check(`${label}: no unexpected intercepted outbound attempt`, egress.length === 0, egress);
        await context.close();

        async function storedChatId() {
            return (
                await api("/api/resources/read", { method: "POST", body: JSON.stringify({ chatCollections: [chaId] }) })
            ).body?.chatCollections?.[0]?.chats?.[0]?.id;
        }
    };
    await run();
} finally {
    await browser.close();
    await stack?.stop();
    provider.close();
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    if (results.some((ok) => !ok)) {
        process.exitCode = 1;
    }
}
