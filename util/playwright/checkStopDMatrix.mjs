// Browser check for Phase 5 Stop D (and the cutover's matrix): the parts of the server matrix the
// slice checks do not cover, against a mock provider (an OpenAI-compatible SSE stream; a non-streamed request is a memory summary) and a mock
// image service (OpenAI-compatible images): a send and a reroll, a group send (one reply per active
// member, in order), a send that summarizes with SupaMemory, a Lua button that generates an image
// (the inlay stored), two tabs of one chat (a send after the other tab's open is not a conflict and
// keeps the local edit; the second tab shows the running reply's checkpoint and the final reply
// without a reload, and its own send is refused with `chatGenerating`), and a backup restore during
// a slow send (the job ends, the data is the backup's, the tab reloads). The send, continue, abort, and reload-mid-stream cases are
// `checkServerSend.mjs`'s; buttons, alerts, and manual triggers `checkServerButton.mjs`'s and
// `checkServerTrigger.mjs`'s; rendering `checkServerTransform.mjs`'s.
//
// Usage:
//   node util/playwright/checkStopDMatrix.mjs
//       dev: starts an isolated stack (`stack.mjs`).
//   node util/playwright/checkStopDMatrix.mjs --base http://localhost:6231 --password docker-pw \
//       --provider-host host.docker.internal
//       production: a server already running the built app (the Docker image on a fresh volume;
//       the check sets its password). The mocks listen on every interface and are named by
//       `--provider-host`. Every step runs through the UI and the public API (no dev modules), in
//       both modes.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, startStack, unexpectedEgress } from "./stack.mjs";

const args = process.argv.slice(2);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const providerHost = option("--provider-host");

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
await new Promise((r) => provider.listen(0, providerHost ? "0.0.0.0" : "127.0.0.1", () => r()));
const providerBase = `http://${providerHost ?? "127.0.0.1"}:${provider.address().port}`;

const stack = option("--base")
    ? null
    : await startStack({
          serverPort: 6221,
          vitePort: 5321,
          log: process.env.DEBUG ? (text) => process.stderr.write(text) : undefined,
      });
const base = option("--base") ?? stack.baseURL;
const password = option("--password") ?? "playwright";
console.log(`mode: ${stack ? "dev" : "production"} at ${base}`);
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
    // Only the app and the local mocks: anything else is refused and counted (`stack.mjs`).
    const blocked = await isolateContext(context);
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
        const r = await fetch(base + p, {
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

    // Opens the app in `p` (the password prompt of a fresh volume answered) until it has signed in.
    const openApp = async (p) => {
        await p.goto(base);
        await waitReady(p);
    };
    // Waits for the app in `p` to sign in (answering the password prompt of a fresh volume), without
    // navigating: after the app's own reload too.
    const waitReady = async (p) => {
        for (let i = 0; i < 240; i++) {
            const input = p.locator("input:visible").first();
            const ok = p.getByRole("button", { name: "OK", exact: true });
            if ((await ok.count()) > 0 && (await input.count()) > 0) {
                await input.fill(password);
                await ok.first().click();
            }
            if (auth && (await ok.count()) === 0) {
                await p.waitForTimeout(2500);
                return;
            }
            await p.waitForTimeout(500);
        }
        throw new Error("the app did not load");
    };
    // Whether `p`'s send is running (`doingChat`): the chat input shows the cancel button meanwhile.
    const busy = async (p = page) => (await p.locator('button[aria-labelledby="cancel"]').count()) > 0;

    await openApp(page);
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
    await openApp(page);
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
    const characterOf = async (chaId) => (await api(`/api/resources/characters/${chaId}`)).body?.data ?? null;
    await openChar(page, tabsId);
    const pageB = await context.newPage();
    watch(pageB, "B");
    await openApp(pageB);
    await pageB.waitForTimeout(1500);
    // Tab B's open stamps the character's `lastInteraction` (a write on tab A's base). Tab A then
    // edits the character and sends: the stamp-only remote change is rebased, not a conflict.
    await openChar(pageB, tabsId);
    const stampB = (await characterOf(tabsId))?.lastInteraction ?? 0;
    await page.bringToFront();
    // A local edit of the character in tab A (its description in the character panel), not saved yet.
    await page.getByRole("button", { name: "Character", exact: true }).first().click();
    await page
        .locator("xpath=//span[starts-with(normalize-space(.), 'Description')]/following::textarea[1]")
        .first()
        .fill("Edited in tab A");
    await page.getByRole("button", { name: "Chat", exact: true }).first().click();
    requests.length = 0;
    mode = { chunks: ["Rebased reply."], delayMs: 50 };
    await send(page, "Send after the other tab's open");
    chat = await waitStored(tabsId, (c) => c.message.at(-1)?.data === "Rebased reply.", 20000);
    check(
        "two tabs: a send after the other tab's open is not a conflict",
        chat?.message.at(-1)?.data === "Rebased reply.",
        {
            alert: /Another tab or device changed this data|A conflict discarded/.test(await bodyText()),
            jobs: jobPosts().length,
            stored: chat?.message.map((m) => `${m.role}:${m.data}`),
        },
    );
    check(
        "two tabs: no conflict notice",
        !/Another tab or device changed this data|A conflict discarded/.test(await bodyText()),
        (await bodyText()).slice(-400),
    );
    await page.waitForTimeout(3000);
    const stored = await characterOf(tabsId);
    check(
        "two tabs: tab A's edit and the later stamp are both stored",
        stored?.desc === "Edited in tab A" && (stored?.lastInteraction ?? 0) >= stampB,
        { desc: stored?.desc, lastInteraction: stored?.lastInteraction, stampB },
    );
    // A job whose stream stalls past the server's 3 s checkpoint: tab B, with the chat open,
    // shows the checkpoint and then the final reply without a reload.
    const baseCount = chat?.message.length ?? 0;
    requests.length = 0;
    mode = { chunks: ["Tab one. ", "Tab two. ", "Tab three. ", "Tab four."], delayMs: 4500 };
    await send(page, "From tab A");
    await page.getByText("Tab one.").first().waitFor({ timeout: 20000 });
    await pageB.bringToFront();
    const live = await pageB
        .getByText("Tab one.")
        .first()
        .waitFor({ timeout: 9000 })
        .then(() => true)
        .catch(() => false);
    // Still running: tab A's send has not ended and the stored reply is not the final text.
    const runningAtLive =
        (await busy(page)) && (await chatOf(tabsId))?.message.at(-1)?.data !== "Tab one. Tab two. Tab three. Tab four.";
    check("two tabs: the second tab shows a checkpoint of the running reply, no reload", live && runningAtLive, {
        live,
        runningAtLive,
        tail: (await bodyText(pageB)).slice(-300),
    });
    // Every alert node that appears is counted, so a second alert after the first is seen too.
    await pageB.evaluate(() => {
        window.__generatingAlerts = 0;
        new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.textContent?.includes("This chat is generating a reply")) window.__generatingAlerts += 1;
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    });
    await send(pageB, "From tab B");
    const generating = pageB.getByText("This chat is generating a reply");
    await generating
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => {});
    await pageB.waitForTimeout(3000);
    const tailB = await bodyText(pageB);
    const alerts = await pageB.evaluate(() => window.__generatingAlerts);
    check(
        "two tabs: the second tab's send shows chatGenerating once, not a save error",
        alerts === 1 && !/Local changes could not be saved/.test(tailB),
        { alerts, tail: tailB.slice(-400) },
    );
    check(
        "two tabs: the second tab keeps its input",
        (await pageB.locator("textarea.input-text").first().inputValue()) === "From tab B",
        await pageB.locator("textarea.input-text").first().inputValue(),
    );
    const okB = pageB.getByRole("button", { name: "OK", exact: true });
    if ((await okB.count()) > 0) await okB.first().click();
    await pageB.locator("textarea.input-text").first().fill("");
    chat = await waitStored(tabsId, (c) => c.message.at(-1)?.data === "Tab one. Tab two. Tab three. Tab four.", 40000);
    check(
        "two tabs: only tab A's send is stored",
        JSON.stringify(chat?.message.slice(baseCount).map((m) => m.data)) ===
            JSON.stringify(["From tab A", "Tab one. Tab two. Tab three. Tab four."]),
        chat?.message.map((m) => m.data),
    );
    const final = await pageB
        .getByText("Tab four.")
        .first()
        .waitFor({ timeout: 20000 })
        .then(() => true)
        .catch(() => false);
    check("two tabs: the second tab shows the final reply without a reload", final, {
        tail: (await bodyText(pageB)).slice(-400),
    });
    await pageB.close();
    await page.bringToFront();
    // Tab A's send ends after its reply is stored (the job's tail); a character switch waits for it.
    for (let until = Date.now() + 30000; Date.now() < until;) {
        if (!(await busy(page))) break;
        await page.waitForTimeout(250);
    }

    // A restore during a slow send, through both routes, in dev and in production alike: an archive
    // (exported before the send) imported during it, and a retained snapshot restored by id during
    // it (the safety snapshot an idle import of the same archive takes first). Each time the job
    // ends, the data is exactly the chat as it was before the send, and the tab is told on its own
    // (no request is made from the page meanwhile), acknowledges, reloads, and shows that chat.
    await openChar(page, restoreId);
    await page.waitForTimeout(1500);
    // The baseline: a distinctive message and its reply, stored before the archive is exported.
    mode = { chunks: ["Baseline reply."], delayMs: 50 };
    await send(page, "Baseline message");
    await waitStored(restoreId, (c) => c.message.at(-1)?.data === "Baseline reply.", 20000);
    for (let until = Date.now() + 30000; Date.now() < until && (await busy(page));) await page.waitForTimeout(250);
    const exported = await fetch(base + "/api/backups/export", {
        method: "POST",
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        body: "{}",
    });
    const archive = Buffer.from(await exported.arrayBuffer());
    check("restore: an archive is exported", exported.status === 200 && archive.length > 0, exported.status);
    const importArchive = async () => {
        const r = await fetch(base + "/api/backups/import", {
            method: "POST",
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/octet-stream" },
            body: archive,
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    // The restore chat as stored: its id and messages, or a thrown error for a failed read.
    const storedChat = async () => {
        const r = await api("/api/resources/read", {
            method: "POST",
            body: JSON.stringify({ chatCollections: [restoreId] }),
        });
        const entry = r.status === 200 ? r.body?.chatCollections?.[0]?.chats?.[0] : undefined;
        if (!entry?.data || !Array.isArray(entry.data.message)) {
            throw new Error(`the restore chat could not be read (${r.status})`);
        }
        return { id: entry.data.id ?? entry.id, messages: entry.data.message.map((m) => [m.role, m.data]) };
    };
    const restoreDuringSend = async (route, restoreNow) => {
        const before = await storedChat();
        check(
            `restore (${route}): the baseline holds its distinctive message`,
            JSON.stringify(before.messages).includes("Baseline message"),
            before,
        );
        // Told: the restore notice shows (acknowledged here), or the tab reloads on its own; the
        // observer is on before the restore, and the whole wait is 30 s.
        let reloaded = false;
        const onNavigated = (frame) => {
            if (frame === page.mainFrame()) reloaded = true;
        };
        page.on("framenavigated", onNavigated);
        mode = { chunks: ["Slow A. ", "Slow B. ", "Slow C. ", "Slow D. ", "Slow E."], delayMs: 900 };
        await send(page, `Before the restore (${route})`);
        await page.getByText("Slow A.").first().waitFor({ timeout: 20000 });
        const restored = await restoreNow();
        check(
            `restore (${route}): succeeds during the send`,
            restored.status === 200 && !!restored.body?.epoch,
            restored,
        );
        epoch = restored.body?.epoch ?? epoch;
        const notice = page.getByText("restored from a backup");
        let told = false;
        let acknowledged = false;
        for (const until = Date.now() + 30000; Date.now() < until && !reloaded;) {
            if (!acknowledged && (await notice.count()) > 0) {
                told = true;
                acknowledged = true;
                await page.getByRole("button", { name: "OK", exact: true }).first().click();
            }
            await page.waitForTimeout(200);
        }
        page.off("framenavigated", onNavigated);
        check(`restore (${route}): the tab is told and reloads without a request of its own`, reloaded, {
            told,
            reloaded,
            tail: (await bodyText()).slice(-300),
        });
        // The app's own reload: wait for it to sign in again, then select the chat (no navigation).
        await waitReady(page);
        await page.waitForTimeout(3000);
        const after = await storedChat();
        check(
            `restore (${route}): the same chat holds exactly its messages before the send`,
            after.id === before.id && JSON.stringify(after.messages) === JSON.stringify(before.messages),
            { before, after },
        );
        await openChar(page, restoreId, "Baseline message");
        const shown = await bodyText();
        check(
            `restore (${route}): the reloaded tab shows that chat`,
            shown.includes("Baseline message") && !shown.includes(`Before the restore (${route})`),
            shown.slice(-400),
        );
    };
    await restoreDuringSend("import", importArchive);
    // The snapshot route: an idle import takes a safety snapshot of the data as it is now (the
    // archive's), which is then restored by id during a send. The idle import's own reload is the
    // runner's (an idle tab learns of it on its next request: `persistence.md`).
    const prepared = await importArchive();
    epoch = prepared.body?.epoch ?? epoch;
    await openApp(page);
    await openChar(page, restoreId);
    const listed = await api("/api/backups");
    const snapshotId = listed.body?.items?.[0]?.id;
    check("restore: the safety snapshot is listed", prepared.status === 200 && !!snapshotId, listed.body);
    await restoreDuringSend("snapshot", () =>
        api(`/api/backups/${encodeURIComponent(snapshotId ?? "none")}/restore`, { method: "POST" }),
    );
    check("no page errors", pageErrors.length === 0, pageErrors);
    const egress = unexpectedEgress(blocked, stack ? await stack.deniedEgress() : []);
    check("no unexpected intercepted outbound attempt", egress.length === 0, egress);
    await context.close();
} finally {
    await browser.close();
    await stack?.stop();
    provider.close();
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    if (results.some((ok) => !ok)) {
        process.exitCode = 1;
    }
}
