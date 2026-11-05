import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Chat } from "../shared/database.ts";
import { expect, settle, test, type BrowserContext, type Page } from "./fixtures";
import { chatBindingFixture, modelFixtureOps } from "../util/playwright/modelProfiles.mjs";
import { clearSafeBootAttempts, openApp, openCharacterChat } from "../util/playwright/stack.mjs";

// Reply candidates survive reloads, synchronize between clients, discard stopped attempts, and restore variables.
// Covers src/ts/process/rerollCandidates.ts, shared/rerollCandidates.ts,
// src/lib/ChatScreens/Chat.svelte, src/lib/ChatScreens/DefaultChatScreen.svelte,
// src/lib/ChatScreens/Chats.svelte, server/src/data/chatStore.ts (selectCandidate),
// src/ts/storage/chatStore.svelte.ts, src/ts/process/serverGeneration.ts,
// src/ts/process/serverCommands.ts, server/src/prompt/runner.ts, server/src/jobs/generationJobs.ts.
// The real server/Vite/browser stack uses only a loopback OpenAI-compatible provider.

function latch() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
}

function reply(marker: string, text: string, held = false) {
    return { marker, text, held, received: latch(), finish: latch(), closed: latch() };
}
type Reply = ReturnType<typeof reply>;
let provider: http.Server;
let providerUrl: string;
let queued: Reply[] = [];
let responses: Reply[] = [];
let providerErrors: string[] = [];

test.beforeAll(async () => {
    provider = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(part as Buffer);
        const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
        const next = queued.shift();
        if (!next || body.stream !== true || !JSON.stringify(body.messages).includes(next.marker)) {
            providerErrors.push(`Unexpected provider request: ${JSON.stringify(body)}`);
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Unexpected mock request" } }));
            return;
        }
        responses.push(next);
        res.on("close", next.closed.release);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: next.text } }] })}\n\n`);
        next.received.release();
        // A held reply has delivered its partial text but cannot complete before Stop or release.
        if (next.held) await Promise.race([next.finish.promise, next.closed.promise]);
        if (res.destroyed) return;
        res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
});

test.afterAll(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
});

interface Session {
    page: Page;
    errors: string[];
    jobs: { kind: string; context: { rerollMessageId?: string } }[];
    api: (path: string, init?: { method?: string; body?: string }) => Promise<any>;
    open: () => Promise<void>;
}

async function session(context: BrowserContext, baseURL: string): Promise<Session> {
    const page = await context.newPage();
    const errors: string[] = [];
    const jobs: Session["jobs"] = [];
    let auth = "";
    let epoch = "";
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generations") {
            jobs.push(request.postDataJSON());
        }
    });
    page.on("response", (response) => {
        if (response.headers()["x-resource-epoch"]) epoch = response.headers()["x-resource-epoch"];
    });
    return {
        page,
        errors,
        jobs,
        open: async () => {
            await openApp(page, baseURL);
            await expect.poll(() => auth, { message: "the app authenticated" }).not.toBe("");
        },
        api: async (path, init = {}) => {
            const response = await fetch(baseURL + path, {
                ...init,
                headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
            });
            const body = await response.json();
            expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(200);
            if (body.epoch) epoch = body.epoch;
            return body;
        },
    };
}

const blank = (chaId: string, name: string, extra: Record<string, unknown> = {}) => ({
    chaId,
    name,
    type: "character",
    firstMessage: "",
    desc: "",
    notes: "",
    chatFolders: [],
    emotionImages: [],
    bias: [],
    viewScreen: "none",
    globalLore: [],
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

let undoSeed: (() => Promise<void>) | undefined;
let sessions: Session[] = [];

test.beforeEach(() => {
    queued = [];
    responses = [];
    providerErrors = [];
    sessions = [];
});

test.afterEach(async () => {
    provider.closeAllConnections();
    // Stop the save loops before restoring shared settings, including on a failed assertion.
    for (const s of sessions) {
        if (!s.page.isClosed()) await s.page.goto("about:blank");
    }
    try {
        await expect(async () => undoSeed?.()).toPass({ timeout: 30_000 });
        expect(providerErrors).toEqual([]);
        for (const s of sessions) expect(s.errors).toEqual([]);
    } finally {
        undoSeed = undefined;
    }
});

async function seed(s: Session, options: { variables?: boolean; group?: boolean } = {}) {
    sessions.push(s);
    await s.open();
    await settle(s.page);
    await s.page.goto("about:blank");
    const saved: Record<string, any> = {};
    for (const kind of ["ui", "modelPresets", "modelProfiles", "providers", "presets", "personas", "characterOrder"]) {
        saved[kind] = await s.api(`/api/resources/${kind}/main`);
    }
    const chaId = randomUUID();
    const chatId = randomUUID();
    const members = [randomUUID(), randomUUID()];
    const marker = `Candidate fixture ${chatId}`;
    const characters = options.group
        ? [
              blank(members[0], "Speaker Ann"),
              blank(members[1], "Speaker Bo"),
              {
                  ...blank(chaId, "Candidate crew"),
                  type: "group",
                  characters: members,
                  characterTalks: [1, 1],
                  characterActive: [true, true],
                  orderByOrder: true,
                  image: "",
              },
          ]
        : [
              blank(chaId, "Candidate speaker", {
                  triggerscript: options.variables
                      ? [
                            {
                                comment: "Remember the reply text",
                                type: "output",
                                conditions: [],
                                effect: [{ type: "v2GetLastCharMessage", outputVar: "replyValue", indent: 0 }],
                            },
                        ]
                      : [],
              }),
          ];
    const changed = ["ui", "modelPresets", "modelProfiles", "providers"];
    await s.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: saved.ui.revision,
                    data: {
                        ...saved.ui.data,
                        didFirstSetup: true,
                        useLegacyGUI: true,
                        useAutoSuggestions: false,
                        swipe: true,
                    },
                },
                ...modelFixtureOps(
                    { aiModel: "reverse_proxy", forceReplaceUrl: providerUrl, customProxyRequestModel: "mock" },
                    saved.modelPresets,
                    saved.modelProfiles,
                ),
                {
                    kind: "providers",
                    id: "main",
                    baseRevision: saved.providers.revision,
                    data: { ...saved.providers.data, useStreaming: true, customTokenizer: "tik" },
                },
                ...characters.map((c) => ({ kind: "characters", id: c.chaId, baseRevision: null, data: c })),
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: saved.characterOrder.revision,
                    data: [...saved.characterOrder.data, chaId],
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
                                name: "Candidate conversation",
                                fmIndex: -1,
                                ...chatBindingFixture(saved.modelPresets, saved.presets, saved.personas),
                                message: [
                                    { role: "user", data: marker, chatId: `${chatId}-seed-user` },
                                    {
                                        role: "char",
                                        data: "Ready for the next turn.",
                                        chatId: `${chatId}-seed-reply`,
                                        ...(options.group ? { saying: members[0] } : {}),
                                    },
                                ],
                            },
                        },
                    ],
                },
            ],
        }),
    });
    undoSeed = async () => {
        const ops = [];
        for (const c of characters) {
            const current = await s.api(`/api/resources/characters/${c.chaId}`);
            ops.push({ kind: "characters", id: c.chaId, baseRevision: current.revision, delete: true });
        }
        for (const kind of changed) {
            const current = await s.api(`/api/resources/${kind}/main`);
            ops.push({ kind, id: "main", baseRevision: current.revision, data: saved[kind].data });
        }
        await s.api("/api/resources/batch", { method: "POST", body: JSON.stringify({ ops }) });
    };
    await s.open();
    await openCharacterChat(s.page, chaId);
    await expect(row(s.page, `${chatId}-seed-reply`)).toBeVisible();
    return { chaId, chatId, marker, members };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const row = (page: Page, id: string) => page.locator(`.risu-chat[data-chat-id="${id}"]`);
const stop = (page: Page) => page.locator('button[aria-labelledby="cancel"]');
const counter = (page: Page, id: string) => row(page, id).locator('[aria-label^="Reply candidate "]');

async function stored(s: Session, ref: Seed): Promise<Chat> {
    const result = await s.api("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({ chats: [{ characterId: ref.chaId, id: ref.chatId }] }),
    });
    return result.chats[0].data;
}

async function send(s: Session, ref: Seed, texts: string[]) {
    for (const text of texts) queued.push(reply(ref.marker, text));
    const composer = s.page.locator("textarea.input-text").first();
    await composer.fill("Continue this conversation.");
    await composer.press("Enter");
    await expect(s.page.locator(".risu-chat .chattext").filter({ hasText: texts.at(-1)! })).toBeVisible({
        timeout: 30_000,
    });
    await expect(stop(s.page)).toHaveCount(0);
    await settle(s.page);
    const chat = await stored(s, ref);
    return chat.message.at(-1)!;
}

async function reroll(s: Session, ref: Seed, id: string, text: string) {
    const next = reply(ref.marker, text);
    queued.push(next);
    await row(s.page, id).locator("button.button-icon-reroll").click();
    await next.received.promise;
    await expect(row(s.page, id).locator(".chattext")).toHaveText(text);
    await expect(stop(s.page)).toHaveCount(0);
    await settle(s.page);
}

async function shows(page: Page, id: string, text: string, position: string) {
    await expect(row(page, id).locator(".chattext")).toHaveText(text);
    await expect(counter(page, id)).toHaveText(position);
}

async function switchLeft(s: Session, id: string) {
    await row(s.page, id).locator("button.button-icon-unreroll").click();
    await settle(s.page);
}

test("two rerolls keep one reply and all three candidates survive reload", async ({ context, baseURL }) => {
    const s = await session(context, baseURL!);
    const ref = await seed(s);
    const first = await send(s, ref, ["First complete reply."]);
    const id = first.chatId!;
    const initial = await stored(s, ref);
    await reroll(s, ref, id, "Second complete reply.");
    await reroll(s, ref, id, "Third complete reply.");
    const saved = await stored(s, ref);
    expect(saved.message.map((m) => m.chatId)).toEqual(initial.message.map((m) => m.chatId));
    expect(saved.message.at(-1)).toMatchObject({
        chatId: id,
        selected: 2,
        candidates: [
            { data: "First complete reply." },
            { data: "Second complete reply." },
            { data: "Third complete reply." },
        ],
    });
    expect(saved.message.at(-1)!.candidatesRevision).toBeGreaterThan(first.candidatesRevision ?? 0);
    expect(s.jobs.map((job) => job.kind)).toEqual(["send", "reroll", "reroll"]);
    expect(s.jobs.slice(1).map((job) => job.context.rerollMessageId)).toEqual([id, id]);

    await s.page.reload();
    await shows(s.page, id, "Third complete reply.", "3/3");
    await switchLeft(s, id);
    await shows(s.page, id, "Second complete reply.", "2/3");
    await switchLeft(s, id);
    await shows(s.page, id, "First complete reply.", "1/3");
    expect((await stored(s, ref)).message.at(-1)).toMatchObject({ selected: 0, data: "First complete reply." });
});

test("two browser contexts receive candidates and sequential switches converge on the stored selection", async ({
    context,
    browser,
    baseURL,
}) => {
    const a = await session(context, baseURL!);
    const ref = await seed(a);
    const first = await send(a, ref, ["Shared first reply."]);
    const id = first.chatId!;
    const secondContext = await browser.newContext();
    await clearSafeBootAttempts(secondContext);
    try {
        const b = await session(secondContext, baseURL!);
        sessions.push(b);
        await b.open();
        await openCharacterChat(b.page, ref.chaId);
        await expect(row(b.page, id).locator(".chattext")).toHaveText("Shared first reply.");
        const url = b.page.url();
        await reroll(a, ref, id, "Shared second reply.");
        await reroll(a, ref, id, "Shared third reply.");
        // B was already displaying this chat before either reroll; no navigation or reload hydrates it.
        expect(b.page.url()).toBe(url);
        await shows(b.page, id, "Shared third reply.", "3/3");
        await switchLeft(a, id);
        await shows(b.page, id, "Shared second reply.", "2/3");
        await switchLeft(b, id);
        const saved = (await stored(a, ref)).message.find((m) => m.chatId === id)!;
        expect(saved).toMatchObject({ selected: 0, data: "Shared first reply." });
        const position = `${saved.selected! + 1}/${saved.candidates!.length}`;
        await shows(a.page, id, saved.data, position);
        await shows(b.page, id, saved.data, position);
        expect(responses).toHaveLength(3); // Switching never requests a new generation.
    } finally {
        await secondContext.close();
    }
});

test("Stop during a streamed reroll restores the selected reply and discards every partial copy", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const ref = await seed(s);
    const first = await send(s, ref, ["Original safe reply."]);
    const id = first.chatId!;
    await reroll(s, ref, id, "Selected safe reply.");
    const before = (await stored(s, ref)).message.find((m) => m.chatId === id)!;
    const partial = "UNFINISHED REROLL MUST DISAPPEAR";
    const held = reply(ref.marker, partial, true);
    queued.push(held);
    await row(s.page, id).locator("button.button-icon-reroll").click();
    await held.received.promise;
    await expect(row(s.page, id).locator(".chattext")).toContainText(partial);
    await expect(stop(s.page)).toBeVisible();
    await stop(s.page).click();
    await held.closed.promise;
    await expect(stop(s.page)).toHaveCount(0);
    await settle(s.page);
    await shows(s.page, id, "Selected safe reply.", "2/2");
    await expect(s.page.locator(".risu-chat").filter({ hasText: partial })).toHaveCount(0);
    const saved = await stored(s, ref);
    const carrier = saved.message.find((m) => m.chatId === id)!;
    expect(carrier.selected).toBe(before.selected);
    expect(carrier.candidates).toEqual(before.candidates);
    expect(JSON.stringify(saved.message)).not.toContain(partial);
    await s.page.reload();
    await shows(s.page, id, "Selected safe reply.", "2/2");
});

test("switching back restores the output trigger variable rendered by a CBS comment", async ({ context, baseURL }) => {
    const s = await session(context, baseURL!);
    const ref = await seed(s, { variables: true });
    const first = await send(s, ref, ["First variable value."]);
    const id = first.chatId!;
    expect((await stored(s, ref)).scriptstate).toMatchObject({ $replyValue: "First variable value." });
    await reroll(s, ref, id, "Second variable value.");
    const second = await stored(s, ref);
    expect(second.scriptstate).toMatchObject({ $replyValue: "Second variable value." });
    expect(second.message.at(-1)!.candidates!.map((c) => c.scriptstateAfter)).toEqual([
        { $replyValue: "First variable value." },
        { $replyValue: "Second variable value." },
    ]);
    await switchLeft(s, id);
    await shows(s.page, id, "First variable value.", "1/2");
    // Real note messages use role char + isComment, and run the display CBS pre-pass.
    // Append after the switch so the rendered note reads the restored state immediately.
    const commentId = randomUUID();
    await s.page.evaluate(
        async ({ chaId, chatId, commentId }) => {
            const { appendMessage } = await import("/src/ts/storage/chatStore.svelte.ts");
            appendMessage(
                { chaId, chatId },
                { role: "char", data: "{{getvar::replyValue}}", chatId: commentId, isComment: true },
            );
        },
        { ...ref, commentId },
    );
    await expect(row(s.page, commentId)).toHaveText("First variable value.");
    await settle(s.page);
    const saved = await stored(s, ref);
    expect(saved.scriptstate).toMatchObject({ $replyValue: "First variable value." });
    expect(saved.message.at(-1)).toMatchObject({ data: "{{getvar::replyValue}}", isComment: true });
    await s.page.reload();
    await expect(row(s.page, commentId)).toHaveText("First variable value.");
});

test("rerolling a two-speaker group turn removes both replies and generates a replacement bundle", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const ref = await seed(s, { group: true });
    await send(s, ref, ["Ann original turn.", "Bo original turn."]);
    const before = await stored(s, ref);
    const oldReplies = before.message.slice(-2);
    expect(oldReplies.map((m) => m.saying)).toEqual(ref.members);
    const held = reply(ref.marker, "Ann replacement turn.", true);
    queued.push(held, reply(ref.marker, "Bo replacement turn."));
    await row(s.page, oldReplies[1].chatId!).locator("button.button-icon-reroll").click();
    await held.received.promise;
    // The removal path drops the whole turn before the first replacement finishes streaming.
    for (const old of oldReplies) await expect(row(s.page, old.chatId!)).toHaveCount(0);
    await expect(s.page.locator(".chattext").filter({ hasText: "Ann replacement turn." })).toBeVisible();
    held.finish.release();
    await expect(s.page.locator(".chattext").filter({ hasText: "Bo replacement turn." })).toBeVisible();
    await expect(stop(s.page)).toHaveCount(0);
    await settle(s.page);
    const after = await stored(s, ref);
    expect(after.message.slice(0, -2)).toEqual(before.message.slice(0, -2));
    const replacements = after.message.slice(-2);
    expect(replacements.map((m) => m.data)).toEqual(["Ann replacement turn.", "Bo replacement turn."]);
    expect(replacements.map((m) => m.saying)).toEqual(ref.members);
    for (const message of replacements) {
        expect(oldReplies.map((m) => m.chatId)).not.toContain(message.chatId);
        expect(message.candidates).toBeUndefined();
        expect(message.selected).toBeUndefined();
        await expect(counter(s.page, message.chatId!)).toHaveCount(0);
    }
    expect(s.jobs.map((job) => job.kind)).toEqual(["group", "group"]);
    expect(responses).toHaveLength(4);
});
