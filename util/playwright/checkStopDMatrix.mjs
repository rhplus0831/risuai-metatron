// Browser check for Phase 5 Stop D: the parts of the flag-on matrix the slice checks do not cover,
// with both client flags on (`risu.serverGeneration`, `risu.serverTransform`), against a mock
// provider (an OpenAI-compatible SSE stream; a non-streamed request is a memory summary) and a mock
// image service (OpenAI-compatible images): a send and a reroll, a group send (one reply per active
// member, in order), a send that summarizes with SupaMemory, a Lua button that generates an image
// (the inlay stored), two tabs of one chat (the second refused while the first generates, then
// showing the reply), and a backup restore during a slow send (the job ends, the data is the
// backup's, the tab reloads). The send, continue, abort, and reload-mid-stream cases are
// `checkServerSend.mjs`'s; buttons, alerts, and manual triggers `checkServerButton.mjs`'s and
// `checkServerTrigger.mjs`'s; rendering `checkServerTransform.mjs`'s.
//
// Usage: node util/playwright/checkStopDMatrix.mjs
import http from "node:http";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { chromePath, openApp, startStack } from "./stack.mjs";

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// The provider: a streamed request streams `mode.chunks`, `mode.delayMs` apart; a non-streamed one
// (a memory summary) answers `Summary result.`. The image route answers the PNG.
let mode = { chunks: ["Mock ", "reply."], delayMs: 50 };
const upstream = [];
const images = [];
const provider = http.createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    if (req.url.startsWith("/v1/images/generations")) {
        // The tab calls the image service itself (the job's `generateImage` callback).
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-allow-headers", "*");
        res.setHeader("access-control-allow-methods", "POST, OPTIONS");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        images.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
        return;
    }
    upstream.push(body);
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Summary result." } }] }));
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
const providerBase = `http://127.0.0.1:${provider.address().port}`;

const stack = await startStack({
    serverPort: 6221,
    vitePort: 5321,
    log: process.env.DEBUG ? (text) => process.stderr.write(text) : undefined,
});
const browser = await chromium.launch({ executablePath: chromePath, headless: true });

const blank = (chaId, name, extra = {}) => ({
    name,
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
    ...extra,
});
const longText = (i) =>
    `Message number ${i}: ` +
    `the party walked through the ${["forest", "desert", "city", "cave"][i % 4]} and talked at length about item ${i}. `.repeat(
        3,
    );

try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (process.env.FLAGS !== "off") {
        await context.addInitScript(() => {
            localStorage.setItem("risu.serverGeneration", "1");
            localStorage.setItem("risu.serverTransform", "1");
        });
    }
    const page = await context.newPage();
    const pageErrors = [];
    const watch = (p, label) => {
        p.on("pageerror", (e) => pageErrors.push(`${label}: ${String(e).slice(0, 300)}`));
        p.on("request", (r) => {
            const h = r.headers();
            if (h["risu-auth"]) auth = h["risu-auth"];
            if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
            requests.push({ page: label, method: r.method(), url: r.url(), body: r.postData() ?? "" });
            if (r.url().includes("/api/resources/batch"))
                batchLog.push({ page: label, at: Date.now(), body: r.postData() ?? "" });
        });
        p.on("response", (r) => {
            const e = r.headers()["x-resource-epoch"];
            if (e) epoch = e;
        });
    };
    const requests = [];
    const batchLog = [];
    let auth = null;
    let epoch = null;
    watch(page, "A");
    const api = async (p, init = {}) => {
        const r = await fetch(stack.baseURL + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;
    const jobPosts = (label = "A") =>
        requests
            .filter((r) => r.page === label && r.method === "POST" && new URL(r.url).pathname === "/api/generations")
            .map((r) => JSON.parse(r.body));
    const chatOf = async (chaId) =>
        (await api("/api/resources/read", { method: "POST", body: JSON.stringify({ chatCollections: [chaId] }) })).body
            ?.chatCollections?.[0]?.chats?.[0]?.data ?? null;
    const bodyText = (p = page) => p.evaluate(() => document.body.innerText);
    const openChar = async (p, chaId, text = "Greetings.") => {
        const modal = p.locator(".z-50.bg-black\\/50");
        if ((await modal.count()) > 0) {
            console.log("MODAL:", (await modal.first().innerText()).slice(0, 400));
        }
        await p.locator(`[data-char-id="${chaId}"]`).first().click();
        await (text === null ? p.locator("textarea.input-text") : p.getByText(text))
            .first()
            .waitFor({ timeout: 15000 });
        await p.waitForTimeout(1500);
    };
    const send = async (p, text) => {
        const input = p.locator("textarea.input-text").first();
        await input.fill(text);
        await input.press("Enter");
    };
    const waitStored = async (chaId, predicate, ms = 20000) => {
        const until = Date.now() + ms;
        let chat = null;
        while (Date.now() < until) {
            chat = await chatOf(chaId);
            if (chat && predicate(chat)) return chat;
            await new Promise((r) => setTimeout(r, 300));
        }
        return chat;
    };

    await openApp(page, stack.baseURL);
    await page.waitForTimeout(1500);
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const order = await single("characterOrder");
    const presets = await single("presets");
    const providers = await single("providers");
    const media = await single("memoryTranslateMedia");
    const secrets = await single("secrets");
    const preset = {
        ...presets.data[0],
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        forceReplaceUrl: `${providerBase}/v1/chat/completions`,
        customProxyRequestModel: "mock",
        maxContext: 900,
        maxResponse: 100,
        mainPrompt: "Main prompt for {{char}}.",
    };
    const sendId = randomUUID();
    const memberA = randomUUID();
    const memberB = randomUUID();
    const groupId = randomUUID();
    const memId = randomUUID();
    const imgId = randomUUID();
    const tabsId = randomUUID();
    const restoreId = randomUUID();
    const IMG_LUA = `onButtonClick = async(function(id, data) local token = generateImage(id, "a cat"):await() addChat(id, "char", "Picture: " .. token) end)`;
    const characters = [
        blank(sendId, "Send Char"),
        blank(memberA, "Member Ann"),
        blank(memberB, "Member Bo"),
        blank(memId, "Memory Mira", { supaMemory: true }),
        blank(imgId, "Image Ivy", {
            lowLevelAccess: true,
            firstMessage: `Greetings. <button risu-btn="img">Draw</button>`,
            triggerscript: [
                { comment: "lua", type: "manual", conditions: [], effect: [{ type: "triggerlua", code: IMG_LUA }] },
            ],
        }),
        blank(tabsId, "Tabs Tia"),
        blank(restoreId, "Restore Rex"),
    ];
    const group = {
        chaId: groupId,
        type: "group",
        name: "Group Gus",
        firstMessage: "Greetings.",
        characters: [memberA, memberB],
        characterTalks: [1, 1],
        characterActive: [true, true],
        orderByOrder: true,
        image: "",
        desc: "",
        globalLore: [],
        emotionImages: [],
        customscript: [],
        viewScreen: "none",
        chatFolders: [],
        alternateGreetings: [],
        tags: [],
    };
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: true } },
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
                        supaModelType: "subModel",
                        supaMemoryPrompt: "Summarize this.",
                        sdProvider: "openai-compat",
                    },
                },
                {
                    kind: "secrets",
                    id: "main",
                    baseRevision: secrets.revision,
                    data: {
                        ...secrets.data,
                        openaiCompatImage: {
                            ...secrets.data.openaiCompatImage,
                            url: `${providerBase}/v1/images/generations`,
                        },
                    },
                },
                ...characters.map((c) => ({ kind: "characters", id: c.chaId, baseRevision: null, data: c })),
                { kind: "characters", id: groupId, baseRevision: null, data: group },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [
                        ...(Array.isArray(order.data) ? order.data : []),
                        ...characters.map((c) => c.chaId),
                        groupId,
                    ],
                },
            ],
            chats: [
                // Stored before either tab opens it (two tabs creating the first chat of a character conflict).
                {
                    characterId: tabsId,
                    chatId: "t",
                    baseRevision: null,
                    ops: [{ op: "create", chat: { id: "t", name: "T", fmIndex: -1, message: [] } }],
                },
                {
                    characterId: memId,
                    chatId: "k",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                id: "k",
                                name: "K",
                                fmIndex: -1,
                                message: Array.from({ length: 24 }, (_, i) => ({
                                    role: i % 2 === 0 ? "user" : "char",
                                    data: longText(i),
                                    chatId: `m${i}`,
                                    ...(i % 2 === 1 ? { saying: memId } : {}),
                                })),
                            },
                        },
                    ],
                },
            ],
        }),
    });
    check("seeded", seeded.status === 200, seeded);
    await openApp(page, stack.baseURL);
    await page.waitForTimeout(1500);

    // A send, then a reroll of its reply.
    await openChar(page, sendId);
    mode = { chunks: ["First ", "reply."], delayMs: 50 };
    await send(page, "Hello there");
    let chat = await waitStored(sendId, (c) => c.message.at(-1)?.data === "First reply.");
    check("send: the reply is stored", chat?.message.at(-1)?.data === "First reply.", chat?.message);
    await page.getByText("First reply.").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);
    requests.length = 0;
    mode = { chunks: ["Second ", "reply."], delayMs: 50 };
    await page.locator(".chat-message-container").first().locator("button.button-icon-reroll").first().click();
    chat = await waitStored(sendId, (c) => c.message.at(-1)?.data === "Second reply.");
    check(
        "reroll: the last reply is replaced",
        JSON.stringify(chat?.message.map((m) => `${m.role}:${m.data}`)) ===
            JSON.stringify(["user:Hello there", "char:Second reply."]),
        chat?.message.map((m) => `${m.role}:${m.data}`),
    );
    check("reroll: it ran as a server job", jobPosts().length === 1, jobPosts());
    await page
        .getByText("Second reply.")
        .first()
        .waitFor({ timeout: 15000 })
        .catch(() => {});
    check("reroll: the new reply is shown", (await page.getByText("Second reply.").count()) > 0);

    // A group send: one reply per active member, in order.
    // A group chat starts without a greeting.
    await openChar(page, groupId, null);
    requests.length = 0;
    mode = { chunks: ["Group ", "line."], delayMs: 30 };
    await send(page, "Hi group");
    chat = await waitStored(groupId, (c) => c.message.filter((m) => m.role === "char").length >= 2, 30000);
    const sayings = chat?.message.filter((m) => m.role === "char").map((m) => m.saying);
    check("group: one reply per member, in order", JSON.stringify(sayings) === JSON.stringify([memberA, memberB]), {
        sayings,
        messages: chat?.message,
    });
    check("group: a group job", jobPosts()[0]?.kind === "group", jobPosts());

    // A send that summarizes with SupaMemory.
    await openChar(page, memId, "Message number 23");
    requests.length = 0;
    const before = upstream.length;
    mode = { chunks: ["Memory ", "reply."], delayMs: 30 };
    await send(page, "Remember all that?");
    chat = await waitStored(memId, (c) => c.message.at(-1)?.data === "Memory reply.", 40000);
    check(
        "memory: the summary is stored",
        typeof chat?.supaMemoryData === "string" && chat.supaMemoryData.includes("Summary result."),
        { supaMemoryData: chat?.supaMemoryData, last: chat?.message.at(-1)?.data },
    );
    check(
        "memory: the summarizer request was not streamed and came first",
        upstream.slice(before).findIndex((b) => !b.stream) === 0 && upstream.slice(before).some((b) => b.stream),
        upstream.slice(before).map((b) => !!b.stream),
    );

    // A Lua button that generates an image.
    await openChar(page, imgId);
    requests.length = 0;
    await page.locator('[risu-btn="img"]').first().click();
    chat = await waitStored(imgId, (c) => /Picture: \{\{inlay::[^}]+\}\}/.test(c.message.at(-1)?.data ?? ""), 30000);
    const inlayToken = /\{\{inlay::([^}]+)\}\}/.exec(chat?.message.at(-1)?.data ?? "")?.[1];
    check(
        "image: the image service was called once",
        images.length === 1 && images[0].prompt?.includes("a cat"),
        images,
    );
    check("image: the inlay token is stored in the chat", !!inlayToken, chat?.message.at(-1));
    const inlay = inlayToken ? await api(`/api/resources/inlays/${encodeURIComponent(inlayToken)}`) : null;
    check("image: the inlay record is stored", inlay?.status === 200 && inlay.body?.data?.type === "image", inlay);
    check("image: a command job", jobPosts()[0]?.kind === "command", jobPosts());

    // Two tabs of one chat.
    await openChar(page, tabsId);
    const pageB = await context.newPage();
    watch(pageB, "B");
    await openApp(pageB, stack.baseURL);
    await pageB.waitForTimeout(1500);
    await openChar(pageB, tabsId);
    // Observed (not counted): tab B's open wrote the character's `lastInteraction`, so tab A's next
    // send conflicts on it (both paths show the "another tab" alert); what becomes of the send.
    await page.bringToFront();
    requests.length = 0;
    mode = { chunks: ["Conflict reply."], delayMs: 50 };
    await send(page, "Conflicted send");
    await page.waitForTimeout(5000);
    const conflictChat = await chatOf(tabsId);
    console.log(
        "observed: a send right after the other tab's open:",
        JSON.stringify({
            alert: /Another tab or device changed this data/.test(await bodyText()),
            jobs: jobPosts().length,
            stored: conflictChat?.message.map((m) => `${m.role}:${m.data}`),
            input: await page.locator("textarea.input-text").first().inputValue(),
        }),
    );
    const okA = page.getByRole("button", { name: "OK", exact: true });
    if ((await okA.count()) > 0) await okA.first().click();
    await page.waitForTimeout(8000);
    // Then from a fresh tab A (the latest data), while tab B is open on the chat.
    await openApp(page, stack.baseURL);
    await page.waitForTimeout(1500);
    await openChar(page, tabsId);
    const baseCount = (await chatOf(tabsId))?.message.length ?? 0;
    requests.length = 0;
    mode = { chunks: ["Tab one. ", "Tab two. ", "Tab three. ", "Tab four."], delayMs: 700 };
    await send(page, "From tab A");
    await page.getByText("Tab one.").first().waitFor({ timeout: 20000 });
    await send(pageB, "From tab B");
    const refusal = /This chat is generating a reply|A character is still being generated/;
    await pageB
        .getByText(refusal)
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => {});
    const refusedText = (await bodyText(pageB)).match(refusal)?.[0] ?? null;
    console.log("observed: tab B's refusal:", refusedText, "jobs posted by B:", jobPosts("B").length);
    check("two tabs: the second tab is refused while the first generates", refusedText !== null, {
        posts: jobPosts("B"),
        tail: (await bodyText(pageB)).slice(-400),
    });
    const okB = pageB.getByRole("button", { name: "OK", exact: true });
    if ((await okB.count()) > 0) await okB.first().click();
    chat = await waitStored(tabsId, (c) => c.message.at(-1)?.data === "Tab one. Tab two. Tab three. Tab four.", 20000);
    check(
        "two tabs: only tab A's send is stored",
        JSON.stringify(chat?.message.slice(baseCount).map((m) => m.data)) ===
            JSON.stringify(["From tab A", "Tab one. Tab two. Tab three. Tab four."]),
        chat?.message.map((m) => m.data),
    );
    await pageB.bringToFront();
    await pageB.waitForTimeout(5000);
    console.log("observed: tab B shows the reply without a reload:", (await pageB.getByText("Tab four.").count()) > 0);
    await openApp(pageB, stack.baseURL);
    await pageB.waitForTimeout(1500);
    await openChar(pageB, tabsId);
    check("two tabs: the second tab shows the reply after a reload", (await pageB.getByText("Tab four.").count()) > 0, {
        tail: (await bodyText(pageB)).slice(-400),
    });
    await pageB.close();

    // A restore during a slow send. The snapshot is a copy of the database now (no route takes one).
    await openChar(page, restoreId);
    await page.waitForTimeout(1500);
    const backups = path.join(stack.workDir, "save", "backups");
    mkdirSync(backups, { recursive: true });
    const name = `resources-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}.sqlite`;
    const live = new DatabaseSync(path.join(stack.workDir, "save", "data", "resources.sqlite"), { readOnly: true });
    live.exec(`VACUUM INTO '${path.join(backups, name)}'`);
    live.close();
    const listed = await api("/api/backups");
    const snapshotId = listed.body?.items?.find((item) => `${item.id}.sqlite` === name)?.id;
    check("restore: the snapshot is listed", !!snapshotId, listed);
    mode = { chunks: ["Slow A. ", "Slow B. ", "Slow C. ", "Slow D. ", "Slow E."], delayMs: 900 };
    await send(page, "Before the restore");
    await page.getByText("Slow A.").first().waitFor({ timeout: 20000 });
    const restored = await api(`/api/backups/${encodeURIComponent(snapshotId ?? "none")}/restore`, { method: "POST" });
    check("restore: the restore succeeds during the send", restored.status === 200 && !!restored.body?.epoch, restored);
    await page.waitForTimeout(6000);
    epoch = restored.body?.epoch ?? epoch;
    chat = await chatOf(restoreId);
    check(
        "restore: the data is the snapshot's (no message of the send)",
        chat === null || !(chat.message ?? []).some((m) => /Before the restore|Slow/.test(m.data)),
        chat?.message,
    );
    const tail = await bodyText();
    check(
        "restore: the tab was told and reloaded",
        /restored from a backup/.test(tail) || !tail.includes("Before the restore"),
        tail.slice(-500),
    );
    check("no page errors", pageErrors.length === 0, pageErrors);
    await context.close();
} finally {
    await browser.close();
    await stack.stop();
    provider.close();
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
}
