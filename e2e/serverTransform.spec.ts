import http from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { chatBindingFixture, modelFixtureOps, promptFixture } from "../util/playwright/modelProfiles.mjs";
import { openApp } from "../util/playwright/stack.mjs";

// Phase 5 slice 13b (`docs/plan/phases/slices/phase-5-server-side-processing/script-transform.md`):
// the server script transform (the only script path since the Phase 5 cutover), in the mounted chat
// screen of the real app, against the isolated stack of `playwright.config.ts`. What only the whole
// stack shows:
// - a send renders its reply raw while it streams and transforms it once when the lock ends, in each
//   streaming display mode, without rendering any other row again (a lock change on one message
//   re-rendered every row before the reviewed fix: their HTML was rebuilt and an open `<details>`
//   closed); while it streams it is the streaming message with the configured mode, which "strong"
//   shows without markdown and the others parse (Phase 6 slice 3);
// - a locked message that is not the last row renders raw while locked and transformed after;
// - "Re-render" asks again for that message only, bypassing the cache;
// - a render answered after a chat switch does not land in the new chat, whose rows render with
//   their own chat's variables (the same message ids in both chats).
// The provider is a local mock; no public service is contacted.

let provider: http.Server;
let providerUrl = "";
let stream = { chunks: ["Hello ", "slow ", "stream ", "reply."], delayMs: 400 };

test.beforeAll(async () => {
    provider = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const chunk of req) parts.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
        if (!body.stream) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: stream.chunks.join("") } }] }));
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of stream.chunks) {
            if (res.destroyed) return;
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
            await new Promise((resolve) => setTimeout(resolve, stream.delayMs));
        }
        res.write("data: [DONE]\n\n");
        res.end();
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
});

test.afterAll(async () => {
    await new Promise((resolve) => provider.close(resolve));
});

const LUA = `listenEdit("editDisplay", function(id, value, meta) setChatVar(id, "lv", "lua") return value .. " [lua" .. meta.index .. "]" end)`;

type Target = { id: string; kind: string; messageId?: string; source: string; noCache?: boolean };
type TransformPost = { path: string; body: { context?: { chatId: string }; targets?: Target[]; texts?: unknown[] } };

interface Session {
    page: Page;
    errors: string[];
    posts: TransformPost[];
    api: (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; body: any }>;
    open: () => Promise<void>;
    /** The epoch the resource reads answer (the requests the page made may predate it). */
    setEpoch: (epoch: string | undefined) => void;
}

async function session(context: BrowserContext, baseURL: string): Promise<Session> {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    const posts: TransformPost[] = [];
    let auth: string | null = null;
    let epoch: string | null = null;
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
        const url = new URL(request.url());
        if (request.method() === "POST" && url.pathname.startsWith("/api/transform")) {
            posts.push({ path: url.pathname, body: JSON.parse(request.postData() ?? "{}") });
        }
    });
    page.on("response", (response) => {
        const value = response.headers()["x-resource-epoch"];
        if (value) epoch = value;
    });
    const open = async () => {
        auth = null;
        await openApp(page, baseURL);
        for (let i = 0; i < 40 && !auth; i++) {
            await page.waitForTimeout(250);
        }
        expect(auth, "the app sent an authenticated request").toBeTruthy();
    };
    const api = async (path: string, init: { method?: string; body?: string } = {}) => {
        const response = await fetch(baseURL + path, {
            ...init,
            headers: { "risu-auth": auth!, "x-resource-epoch": epoch!, "content-type": "application/json" },
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    const setEpoch = (value: string | undefined) => {
        if (value) epoch = value;
    };
    return { page, errors, posts, api, open, setEpoch };
}

const messages = [
    { role: "user", data: "Hello user VAR", chatId: "m-user" },
    { role: "char", data: "Plain RND reply", chatId: "m-rnd" },
    { role: "user", data: "Hello u2", chatId: "m-u2" },
    { role: "char", data: "Hello c2 QQ", chatId: "m-c2" },
    { role: "user", data: "Hello u3", chatId: "m-u3" },
    { role: "char", data: "Hello c3 <details><summary>sum</summary>inside</details>", chatId: "m-c3" },
];

/** Seeds a character with the transform scripts and `chats` (each `{ id, scriptstate, message }`), then opens it. */
async function seed(
    s: Session,
    chats: { id: string; scriptstate?: Record<string, string>; message: typeof messages }[],
): Promise<string> {
    await s.open();
    const ui = (await s.api("/api/resources/ui/main")).body;
    s.setEpoch(ui.epoch);
    const order = (await s.api("/api/resources/characterOrder/main")).body;
    const presets = (await s.api("/api/resources/presets/main")).body;
    const providers = (await s.api("/api/resources/providers/main")).body;
    const modelPresets = (await s.api("/api/resources/modelPresets/main")).body;
    const modelProfiles = (await s.api("/api/resources/modelProfiles/main")).body;
    const personas = (await s.api("/api/resources/personas/main")).body;
    const chaId = randomUUID();
    const character = {
        name: `Transform ${chaId.slice(0, 6)}`,
        firstMessage: "Hello greeting",
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
            { comment: "chat var", in: "QQ", out: "W={{getvar::w}}", type: "editdisplay", flag: "g" },
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
        triggerscript: [{ comment: "lua", type: "start", conditions: [], effect: [{ type: "triggerlua", code: LUA }] }],
    };
    // The model fields go to a profile that the first model preset's slots name (`modelFixtureOps`).
    const preset = {
        ...presets.data[0],
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        forceReplaceUrl: providerUrl,
        customProxyRequestModel: "mock",
        maxContext: 4000,
        maxResponse: 100,
    };
    // Every chat is bound to that model preset, the prompt preset, and the first persona: a send
    // runs only with a complete binding (`docs/plan/chat-binding.md`).
    const binding = chatBindingFixture(modelPresets, presets, personas);
    const seeded = await s.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: true } },
                {
                    kind: "presets",
                    id: "main",
                    baseRevision: presets.revision,
                    data: [promptFixture(preset), ...presets.data.slice(1)],
                },
                ...modelFixtureOps(preset, modelPresets, modelProfiles),
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
            chats: chats.map((chat) => ({
                characterId: chaId,
                chatId: chat.id,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: chat.id,
                            name: chat.id,
                            ...binding,
                            message: chat.message,
                            scriptstate: chat.scriptstate ?? {},
                        },
                    },
                ],
            })),
        }),
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    await s.open();
    await s.page.locator(`[data-char-id="${chaId}"]`).first().click();
    await selectChat(s.page, chaId, chats[0].id);
    await expect(row(s.page, "m-c3")).toContainText("HELLO c3", { timeout: 20_000 });
    await s.page.waitForTimeout(2000);
    return chaId;
}

const row = (page: Page, messageId: string) => page.locator(`.risu-chat[data-chat-id="${messageId}"]`);

const selectChat = (page: Page, chaId: string, chatId: string) =>
    page.evaluate(
        async ({ chaId, chatId }) => {
            // Selecting a character shows its closed chat; the chat opens like a pick from the list.
            const { changeChatTo } = await import("/src/ts/globalApi.svelte.ts");
            changeChatTo(chatId);
        },
        { chaId, chatId },
    );

/** The message ids the transform requests since `from` targeted (a target without one as `kind:source`). */
const targeted = (s: Session, from = 0) =>
    s.posts
        .slice(from)
        .filter((post) => post.path === "/api/transform")
        .flatMap((post) => post.body.targets ?? [])
        .map((target) => target.messageId ?? `${target.kind}:${target.source.slice(0, 16)}`);

const count = (list: string[]) => list.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

/** Counts DOM mutations under a row from now on (`window.__mutations[messageId]`). */
const watchRow = (page: Page, messageId: string) =>
    page.evaluate((id) => {
        const w = window as any;
        w.__mutations ??= {};
        w.__mutations[id] = 0;
        const element = document.querySelector(`.risu-chat[data-chat-id="${id}"]`);
        if (!element) throw new Error(`no row ${id}`);
        new MutationObserver((records) => (w.__mutations[id] += records.length)).observe(element, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
        });
    }, messageId);
const mutations = (page: Page, messageId: string) => page.evaluate((id) => (window as any).__mutations[id], messageId);

const lastMessages = (page: Page, chaId: string, chatId: string) =>
    page.evaluate(
        async ({ chaId, chatId }) => {
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            return chatStore.findChat({ chaId, chatId })!.message.map((m: any) => ({ id: m.chatId, data: m.data }));
        },
        { chaId, chatId },
    );

for (const mode of ["off", "balanced", "strong"] as const) {
    test(`a send with streaming display optimization "${mode}" renders the reply raw while it streams, transforms it once at the end, and renders no other row again`, async ({
        context,
        baseURL,
    }) => {
        const s = await session(context, baseURL!);
        const chatId = randomUUID();
        const chaId = await seed(s, [{ id: chatId, message: messages }]);
        const { page } = s;
        await page.evaluate(async (mode) => {
            const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
            settings.ui.streamingDisplayOptimizationMode = mode;
        }, mode);
        await page.waitForTimeout(1500);
        await watchRow(page, "m-c2");
        await page.evaluate(() => {
            const details = document.querySelector(`.risu-chat[data-chat-id="m-c3"] details`) as HTMLDetailsElement;
            details.open = true;
        });
        const from = s.posts.length;

        // Markdown in the reply tells the display modes apart while it streams (Phase 6 slice 3).
        stream = { chunks: ["Hello ", "**slow** ", "stream ", "reply."], delayMs: 400 };
        const input = page.locator("textarea.input-text").first();
        await input.fill(`Stream please ${mode}`);
        await input.press("Enter");
        const streaming = page.locator(".risu-chat").filter({ hasText: "slow" }).last();
        await expect(streaming).toBeVisible({ timeout: 20_000 });
        // While it streams: raw (no regex, no Lua), and no request for it.
        expect(await streaming.innerText()).not.toContain("HELLO");
        expect(await streaming.innerText()).not.toContain("[lua");
        // The reply is the streaming message with the configured mode; "strong" shows its text without
        // markdown, the others parse it.
        const live = await page.evaluate(async () => {
            const { streamingState } = await import("/src/ts/storage/chatStore.svelte.ts");
            return { ...streamingState };
        });
        expect(live.mode).toBe(mode);
        expect(live.messageId).toBe(await streaming.getAttribute("data-chat-id"));
        if (mode === "strong") {
            expect(await streaming.innerText()).toContain("**slow**");
            expect(await streaming.locator("strong").count()).toBe(0);
        } else {
            expect(await streaming.innerText()).not.toContain("**");
            await expect(streaming.locator("strong").filter({ hasText: "slow" })).toHaveCount(1);
        }

        const reply = page.locator(".risu-chat").filter({ hasText: "reply." }).last();
        await expect(reply).toContainText("HELLO slow stream reply.", { timeout: 20_000 });
        await expect(reply).toContainText("[lua");
        await page.waitForTimeout(2500);

        const all = await lastMessages(page, chaId, chatId);
        const [userMessage, replyMessage] = all.slice(-2);
        expect(replyMessage.data).toBe("Hello **slow** stream reply.");
        // The end cleared the streaming state, and the final reply renders parsed in every mode.
        expect(
            await page.evaluate(async () => {
                const { streamingState } = await import("/src/ts/storage/chatStore.svelte.ts");
                return streamingState.messageId;
            }),
        ).toBeNull();
        await expect(reply.locator("strong").filter({ hasText: "slow" })).toHaveCount(1);
        expect(await reply.innerText()).not.toContain("**");
        const targets = count(targeted(s, from));
        // The new reply once (when its lock ended), the new user message at most once (its mount),
        // and nothing else: no seeded row, no greeting.
        expect(targets[replyMessage.id], JSON.stringify(targets)).toBe(1);
        expect(targets[userMessage.id] ?? 0, JSON.stringify(targets)).toBeLessThanOrEqual(1);
        expect(Object.keys(targets).filter((k) => k !== replyMessage.id && k !== userMessage.id)).toEqual([]);
        expect(await mutations(page, "m-c2")).toBe(0);
        expect(
            await page.evaluate(
                () => (document.querySelector(`.risu-chat[data-chat-id="m-c3"] details`) as HTMLDetailsElement).open,
            ),
        ).toBe(true);
        expect(s.errors).toEqual([]);
    });
}

test("a locked message that is not the last row renders raw while locked and transformed once when the lock ends", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const chatId = randomUUID();
    const chaId = await seed(s, [{ id: chatId, message: messages }]);
    const { page } = s;
    await expect(row(page, "m-u2")).toContainText("HELLO u2 [lua2]");
    await watchRow(page, "m-c2");
    const from = s.posts.length;

    // A server generation job locks m-u2 (index 2 of 6), its stream holding the stored text; its row
    // renders again while locked (a reload pointer).
    await page.evaluate(
        async ({ chaId, chatId }) => {
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            const { ReloadChatPointer } = await import("/src/ts/stores.svelte.ts");
            chatStore.applyServerGeneration(
                { chaId, chatId },
                { jobId: "e2e-job", messageId: "m-u2", generationId: "e2e-lock", text: "Hello u2", seq: 0 },
            );
            ReloadChatPointer.update((v: Record<number, number>) => ({ ...v, 2: (v[2] ?? 0) + 1 }));
        },
        { chaId, chatId },
    );
    await expect(row(page, "m-u2")).toContainText("Hello u2", { timeout: 10_000 });
    await page.waitForTimeout(1000);
    expect(await row(page, "m-u2").innerText()).not.toContain("HELLO");
    expect(targeted(s, from)).toEqual([]);

    await page.evaluate(
        async ({ chaId, chatId }) => {
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            chatStore.endServerJob("e2e-job");
        },
        { chaId, chatId },
    );
    await expect(row(page, "m-u2")).toContainText("HELLO u2 [lua2]", { timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(count(targeted(s, from))).toEqual({ "m-u2": 1 });
    expect(await mutations(page, "m-c2")).toBe(0);
    expect(s.errors).toEqual([]);
});

test("Re-render asks again for that message only, bypassing the cache", async ({ context, baseURL }) => {
    const s = await session(context, baseURL!);
    const chatId = randomUUID();
    await seed(s, [{ id: chatId, message: messages }]);
    const { page } = s;
    await watchRow(page, "m-c2");
    const values = new Set<string>([await row(page, "m-rnd").innerText()]);
    let from = s.posts.length;
    for (let i = 0; i < 4; i++) {
        from = s.posts.length;
        const target = row(page, "m-rnd");
        await target.hover();
        await target.locator(".button-icon-menu").first().click();
        await page.locator(".button-icon-rerender").last().click({ force: true });
        await page.waitForTimeout(1500);
        const posts = s.posts.slice(from).filter((post) => post.path === "/api/transform");
        const targets = posts.flatMap((post) => post.body.targets ?? []);
        // One request for that message only. The click renders the row twice, both in one batch: the
        // first target takes the bypass, and the second, after it in the same request, is answered
        // from the entry the first replaced.
        expect(posts).toHaveLength(1);
        expect(targets.every((t) => t.messageId === "m-rnd")).toBe(true);
        expect(targets.length).toBeLessThanOrEqual(2);
        expect(targets[0].noCache).toBe(true);
        expect(targets.slice(1).every((t) => !t.noCache)).toBe(true);
        values.add(await row(page, "m-rnd").innerText());
    }
    // A server-evaluated {{random}} of 8 values: four bypasses give another one.
    expect(values.size).toBeGreaterThan(1);
    expect(await mutations(page, "m-c2")).toBe(0);
    expect(s.errors).toEqual([]);
});

test("a render answered after a chat switch does not land in the new chat, which renders with its own variables", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const chatA = randomUUID();
    const chatB = randomUUID();
    // The same texts in both chats, other message ids; the chat variable differs.
    const messagesB = messages.map((m) => ({ ...m, chatId: `b-${m.chatId}` }));
    const chaId = await seed(s, [
        { id: chatA, scriptstate: { $w: "from-A" }, message: messages },
        { id: chatB, scriptstate: { $w: "from-B" }, message: messagesB },
    ]);
    const { page } = s;
    await expect(row(page, "m-c2")).toContainText("W=from-A");

    // Hold every transform answer, render a row of A again, and switch to B while it waits.
    const held: Route[] = [];
    let release = false;
    await page.route("**/api/transform", (route) => {
        if (release) return route.fallback();
        held.push(route);
    });
    const from = s.posts.length;
    await page.evaluate(async () => {
        const { ReloadChatPointer } = await import("/src/ts/stores.svelte.ts");
        ReloadChatPointer.update((v: Record<number, number>) => ({ ...v, 1: (v[1] ?? 0) + 1 }));
    });
    await expect.poll(() => held.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await selectChat(page, chaId, chatB);
    await expect.poll(() => held.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(500);
    release = true;
    for (const route of held) {
        await route.continue();
    }
    await expect(row(page, "b-m-c2")).toContainText("W=from-B", { timeout: 15_000 });
    await expect(row(page, "b-m-c3")).toContainText("HELLO c3", { timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(await page.locator("body").innerText()).not.toContain("from-A");

    const posts = s.posts.slice(from).filter((post) => post.path === "/api/transform");
    // The first request is A's re-rendered row; every later one is B's.
    expect(posts[0].body.context!.chatId).toBe(chatA);
    expect(posts[0].body.targets!.map((t) => t.messageId)).toEqual(["m-rnd"]);
    expect(posts.slice(1).every((post) => post.body.context!.chatId === chatB)).toBe(true);
    expect(
        new Set(posts.slice(1).flatMap((post) => post.body.targets!.map((t) => t.messageId).filter(Boolean))),
    ).toEqual(new Set(messagesB.map((m) => m.chatId)));
    // The screen shows B's messages only, and the stored variables are unchanged.
    const shown = await page
        .locator(".risu-chat")
        .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.chatId).filter(Boolean));
    expect(new Set(shown)).toEqual(new Set(messagesB.map((m) => m.chatId)));
    const stored = await s.api("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({
            chats: [
                { characterId: chaId, id: chatA },
                { characterId: chaId, id: chatB },
            ],
        }),
    });
    // The Lua listener's `setChatVar` changed only the render's copy.
    expect(stored.body.chats.map((c: any) => c.data.scriptstate)).toEqual([{ $w: "from-A" }, { $w: "from-B" }]);
    expect(s.errors).toEqual([]);
});
