import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
// Browser check for the streaming display optimization on server streams: for each
// `streamingDisplayOptimizationMode` ("off", "balanced", "strong"), a server send makes its reply
// the streaming message (`streamingState`, with the configured mode) from its first chunk until the
// job ends. While it streams, "strong" renders the reply raw (no markdown) and the others render it
// parsed; every mode keeps the reply's row mounted across chunks (rows are keyed by message id). At
// the end the state is cleared and the final reply renders parsed.
//
// Usage: node util/playwright/checkStreamingModes.mjs   (dev only: it reads the tab's state through
// the dev server's modules).
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, openApp, openCharacterChat, startStack, unexpectedEgress } from "./stack.mjs";

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};

// The provider streams markdown slowly, so the reply is observed mid-stream.
const chunks = ["**bold** ", ...Array.from({ length: 10 }, (_, i) => `part${i} `), "end."];
const provider = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 400));
    }
    res.write("data: [DONE]\n\n");
    res.end();
});
await new Promise((r) => provider.listen(0, "127.0.0.1", () => r()));
const providerBase = `http://127.0.0.1:${provider.address().port}`;

const stack = await startStack({
    serverPort: 6251,
    vitePort: 5351,
    log: process.env.DEBUG ? (text) => process.stderr.write(text) : undefined,
});
const base = stack.baseURL;
const browser = await chromium.launch({ executablePath: chromePath, headless: true });

const waitFor = async (fn, ms = 15000) => {
    const until = Date.now() + ms;
    let last;
    while (Date.now() < until) {
        last = await fn().catch((error) => ({ error: String(error) }));
        if (last === true) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return last;
};

try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const blocked = await isolateContext(context);
    const pageErrors = [];
    let auth = null;
    let epoch = null;
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    page.on("request", (r) => {
        const h = r.headers();
        if (h["risu-auth"]) auth = h["risu-auth"];
        if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
    });
    const api = async (p, init = {}) => {
        const r = await fetch(base + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;
    const batch = (body) => api("/api/resources/batch", { method: "POST", body: JSON.stringify(body) });

    await openApp(page, base);
    await page.waitForTimeout(1500);

    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
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
        maxContext: 900,
        maxResponse: 100,
    };
    const providers = await single("providers");
    const order = await single("characterOrder");
    const chaId = randomUUID();
    const seeded = await batch({
        ops: [
            ...modelFixtureOps({ ...preset, customTokenizer: "tik" }, modelPresets, modelProfiles),
            { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: true } },
            {
                kind: "presets",
                id: "main",
                baseRevision: presets.revision,
                data: [promptFixture(preset)],
            },
            {
                kind: "providers",
                id: "main",
                baseRevision: providers.revision,
                data: { ...providers.data, useStreaming: true },
            },
            {
                kind: "characters",
                id: chaId,
                baseRevision: null,
                data: {
                    name: "Stream Sam",
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
                },
            },
            { kind: "characterOrder", id: "main", baseRevision: order.revision, data: [...order.data, chaId] },
        ],
        chats: [
            {
                characterId: chaId,
                chatId: "s",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "s",
                            name: "Stream chat",
                            note: "",
                            localLore: [],
                            ...chatBindingFixture(modelPresets, presets, personas),
                            message: [{ role: "char", data: "Seeded line.", chatId: "m1", saying: "", time: 1 }],
                        },
                    },
                ],
            },
        ],
    });
    check("seed: stored", seeded.status === 200, seeded);

    await page.locator(`[data-char-id="${chaId}"]`).first().waitFor({ timeout: 15000 });
    await openCharacterChat(page, chaId);
    await page.getByText("Seeded line.").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);

    const streaming = () =>
        page.evaluate(async () => {
            const { streamingState } = await import("/src/ts/storage/chatStore.svelte.ts");
            return { ...streamingState };
        });
    const lastMessage = () =>
        page.evaluate(async (id) => {
            const { findChat } = await import("/src/ts/storage/chatStore.svelte.ts");
            const message = findChat({ chaId: id, chatId: "s" })?.message.at(-1);
            return message ? { id: message.chatId, data: message.data } : null;
        }, chaId);
    // The reply's row: whether it holds parsed markdown, its raw text, and a marker on its container.
    const row = (messageId, mark) =>
        page.evaluate(
            ({ messageId, mark }) => {
                const element = document.querySelector(`.risu-chat[data-chat-id="${messageId}"]`);
                const container = element?.closest(".chat-message-container");
                if (!element || !container) return null;
                if (mark) container.__streamMark = mark;
                const marked = [...document.querySelectorAll(".chat-message-container")].some(
                    (entry) => entry.__streamMark !== undefined,
                );
                return {
                    parsed: element.querySelector("strong") !== null,
                    raw: element.innerText.includes("**bold**"),
                    text: element.innerText,
                    sameContainer: container.__streamMark !== undefined,
                    marked,
                };
            },
            { messageId, mark },
        );

    for (const mode of ["off", "balanced", "strong"]) {
        await page.evaluate(async (mode) => {
            const { writeSettingsRoot } = await import("/src/ts/storage/settingsViews.svelte.ts");
            writeSettingsRoot("streamingDisplayOptimizationMode", mode);
        }, mode);
        await page.waitForTimeout(1000);
        const input = page.locator("textarea.input-text").first();
        await input.fill(`Stream please (${mode})`);
        await input.press("Enter");

        // The first chunk makes the reply the streaming message, with the configured mode.
        let state = null;
        const set = await waitFor(async () => {
            state = await streaming();
            return state.messageId !== null;
        });
        const reply = await lastMessage();
        check(
            `${mode}: the reply is the streaming message with the configured mode`,
            set === true &&
                state.chaId === chaId &&
                state.chatId === "s" &&
                state.messageId === reply?.id &&
                state.mode === mode,
            { state, reply },
        );
        const replyId = state.messageId;

        // Mid-stream: mark the row's container, then look again a few chunks later.
        const first = await waitFor(async () => {
            const r = await row(replyId, mode);
            return r !== null && r.text.includes("part0");
        });
        check(`${mode}: the reply's row is shown while it streams`, first === true, first);
        await page.waitForTimeout(1300);
        const later = await row(replyId);
        const message = await lastMessage();
        check(`${mode}: still streaming at the second look`, !message?.data.includes("end."), message);
        if (mode === "strong") {
            check(`strong: renders the streaming reply raw`, later?.raw === true && later?.parsed === false, later);
        } else {
            check(`${mode}: renders the streaming reply parsed`, later?.parsed === true && later?.raw === false, later);
        }
        check(`${mode}: keeps the streaming reply's row mounted across chunks`, later?.sameContainer === true, later);

        // The end clears the state, and the final reply renders parsed.
        const cleared = await waitFor(async () => (await streaming()).messageId === null, 30000);
        check(`${mode}: the job's end clears the streaming state`, cleared === true, cleared);
        const final = await waitFor(async () => {
            const r = await row(replyId);
            return r !== null && r.text.includes("end.") && r.parsed && !r.raw;
        });
        check(`${mode}: the final reply renders parsed`, final === true, final);
        await page.evaluate(() => {
            for (const entry of document.querySelectorAll(".chat-message-container")) delete entry.__streamMark;
        });
    }

    const denied = await stack.deniedEgress();
    const unexpected = unexpectedEgress(blocked, denied);
    check("no unexpected outbound request", unexpected.length === 0, unexpected);
    check("no page error", pageErrors.length === 0, pageErrors);
} catch (error) {
    console.error(error);
    results.push(false);
} finally {
    await browser.close();
    await stack.stop();
    provider.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
