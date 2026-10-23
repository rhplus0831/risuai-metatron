import http from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { chatBindingFixture, modelFixtureOps } from "../util/playwright/modelProfiles.mjs";
import { openApp, openCharacterChat } from "../util/playwright/stack.mjs";

// Sends in different chats of one tab, against the isolated stack of `playwright.config.ts`:
// - a send in chat A, a switch to chat B, a send in B: both run at once, the chat screen shows Stop
//   only for the selected chat's own send, and each reply lands in its own chat;
// - Stop in B ends B's job only: A's reply goes on streaming and completes afterwards;
// - suggestions per chat: each chat's end requests its own (B's at once, A's when it is selected),
//   none is requested for a chat while its send runs, and each chat stores only its own;
// - auto mode in a group chat runs rounds in the chat it started in, ends after the current round
//   when another chat is selected (the other chat is not sent to), and Stop ends it.
// The provider is a local mock that tells the chats apart by their seeded messages; no plugin
// callback is involved. The characters are deleted and the changed records restored at the end.

/** The chat a provider request is for: each chat's seeded history carries its marker. */
const MARKERS = { a: "alpha seed", b: "bravo seed", g1: "gamma one seed", g2: "gamma two seed" } as const;
type ChatName = keyof typeof MARKERS;

let provider: http.Server;
let providerUrl = "";
/** Every provider request: its chat, whether it streamed (a send) or not (a suggestion), and its end. */
const requests: { chat: ChatName | null; stream: boolean; closed: boolean }[] = [];
/** Releases A's held reply (its first chunk is sent at once, the rest waits for this). */
let releaseA: () => void = () => {};
let heldA = new Promise<void>((resolve) => (releaseA = resolve));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.beforeAll(async () => {
    provider = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const chunk of req) parts.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
        const text = JSON.stringify(body.messages ?? body);
        const chat = (Object.keys(MARKERS) as ChatName[]).find((name) => text.includes(MARKERS[name])) ?? null;
        const entry = { chat, stream: body.stream === true, closed: false };
        requests.push(entry);
        res.on("close", () => (entry.closed = true));
        if (!entry.stream) {
            // A suggestion: one line per suggestion, `-` first.
            const content = chat === "a" ? "- Alpha next" : chat === "b" ? "- Bravo next" : "- Other next";
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const write = (content: string) =>
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        if (chat === "a") {
            write("Alpha part ");
            await heldA;
            if (res.destroyed) return;
            write("done.");
        } else if (chat === "b") {
            // Streams until it is stopped (or a minute passes).
            write("Bravo part ");
            for (let i = 0; i < 120 && !res.destroyed; i++) await sleep(500);
            if (res.destroyed) return;
            write("late.");
        } else {
            write("Round ");
            await sleep(300);
            if (res.destroyed) return;
            write("reply.");
        }
        res.write("data: [DONE]\n\n");
        res.end();
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
});

test.afterAll(async () => {
    releaseA();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
});

const sends = (chat: ChatName) => requests.filter((entry) => entry.chat === chat && entry.stream);
const suggestions = (chat: ChatName) => requests.filter((entry) => entry.chat === chat && !entry.stream);

interface Session {
    page: Page;
    errors: string[];
    api: (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; body: any }>;
    open: () => Promise<void>;
    setEpoch: (epoch: string | undefined) => void;
}

async function session(context: BrowserContext, baseURL: string): Promise<Session> {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    let auth: string | null = null;
    let epoch: string | null = null;
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
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
    return { page, errors, api, open, setEpoch };
}

const blank = (chaId: string, name: string, extra: Record<string, unknown> = {}) => ({
    name,
    firstMessage: "",
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

/** What the seed changes besides the characters, to be restored at the end (the specs after this one share the store). */
let restore: { ui: any; modelPresets: any; modelProfiles: any; providers: any } | null = null;

/** Seeds a character with chats A and B, a group of two members with chats G1 and G2, and the mock provider. */
async function seed(s: Session) {
    await s.open();
    const ui = (await s.api("/api/resources/ui/main")).body;
    s.setEpoch(ui.epoch);
    const order = (await s.api("/api/resources/characterOrder/main")).body;
    const modelPresets = (await s.api("/api/resources/modelPresets/main")).body;
    const modelProfiles = (await s.api("/api/resources/modelProfiles/main")).body;
    const presets = (await s.api("/api/resources/presets/main")).body;
    const personas = (await s.api("/api/resources/personas/main")).body;
    const providers = (await s.api("/api/resources/providers/main")).body;
    restore = {
        ui: ui.data,
        modelPresets: modelPresets.data,
        modelProfiles: modelProfiles.data,
        providers: providers.data,
    };
    const chaId = randomUUID();
    const memberA = randomUUID();
    const memberB = randomUUID();
    const groupId = randomUUID();
    const characters = [
        blank(chaId, `Pair ${chaId.slice(0, 6)}`),
        blank(memberA, "Member Ann"),
        blank(memberB, "Member Bo"),
    ];
    const group = {
        chaId: groupId,
        type: "group",
        name: `Crew ${groupId.slice(0, 6)}`,
        firstMessage: "",
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
    // A profile on the mock provider, named by the first model preset's main and sub slots (the
    // suggestions use the sub slot).
    const model = { aiModel: "reverse_proxy", forceReplaceUrl: providerUrl, customProxyRequestModel: "mock" };
    // Every chat is bound: a send runs only with a complete binding.
    const binding = chatBindingFixture(modelPresets, presets, personas);
    const chat = (characterId: string, id: ChatName) => ({
        characterId,
        chatId: id,
        baseRevision: null,
        ops: [
            {
                op: "create",
                chat: {
                    id,
                    name: id.toUpperCase(),
                    fmIndex: -1,
                    ...binding,
                    message: [
                        { role: "user", data: `${MARKERS[id]} question`, chatId: `${id}-m0` },
                        {
                            role: "char",
                            data: `${MARKERS[id]} answer`,
                            chatId: `${id}-m1`,
                            ...(characterId === groupId ? { saying: memberA } : {}),
                        },
                    ],
                },
            },
        ],
    });
    const seeded = await s.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: { ...ui.data, didFirstSetup: true, useLegacyGUI: true, useAutoSuggestions: true },
                },
                ...modelFixtureOps(model, modelPresets, modelProfiles),
                {
                    kind: "providers",
                    id: "main",
                    baseRevision: providers.revision,
                    data: { ...providers.data, useStreaming: true, customTokenizer: "tik" },
                },
                ...characters.map((c) => ({ kind: "characters", id: c.chaId, baseRevision: null, data: c })),
                { kind: "characters", id: groupId, baseRevision: null, data: group },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...(Array.isArray(order.data) ? order.data : []), chaId, groupId],
                },
            ],
            chats: [chat(chaId, "a"), chat(chaId, "b"), chat(groupId, "g1"), chat(groupId, "g2")],
        }),
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    return { chaId, groupId, members: [memberA, memberB] };
}

const selectChat = (page: Page, chatId: string) =>
    page.evaluate(async (id) => {
        const { changeChatTo } = await import("/src/ts/globalApi.svelte.ts");
        changeChatTo(id);
    }, chatId);

/** The stored chat's messages (role and text). */
async function stored(s: Session, characterId: string, id: string): Promise<{ messages: string[]; suggest: unknown }> {
    const read = await s.api("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({ chats: [{ characterId, id }] }),
    });
    const data = read.body.chats[0].data;
    return {
        messages: data.message.map((entry: any) => `${entry.role}:${entry.data}`),
        suggest: data.suggestMessages,
    };
}

test("two chats of one tab send at once: per-chat Stop, replies, suggestions, and auto mode", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const { chaId, groupId, members } = await seed(s);
    await s.open();
    const page = s.page;
    const stop = page.locator('button[aria-labelledby="cancel"]');
    const sendButton = page.locator("button.button-icon-send");
    const composer = page.locator("textarea.input-text").first();

    // Chat A: a send whose reply is held after its first chunk.
    await openCharacterChat(page, chaId);
    await page.locator(".default-chat-screen").waitFor({ timeout: 20_000 });
    await selectChat(page, "a");
    await expect(page.locator(".risu-chat[data-chat-id='a-m1']")).toBeVisible({ timeout: 20_000 });
    await composer.fill("Go on, A");
    await composer.press("Enter");
    await expect.poll(() => sends("a").length, { timeout: 30_000 }).toBe(1);
    await expect(page.getByText("Alpha part").first()).toBeVisible({ timeout: 20_000 });
    await expect(stop).toBeVisible();
    await expect(page.getByText("Alpha next")).toHaveCount(0);
    const suggestionsOfA = suggestions("a").length;

    // Chat B: no Stop for A's send there; B's own send runs beside A's.
    await selectChat(page, "b");
    await expect(page.locator(".risu-chat[data-chat-id='b-m1']")).toBeVisible({ timeout: 20_000 });
    await expect(stop).toHaveCount(0);
    await expect(sendButton).toBeVisible();
    await composer.fill("Go on, B");
    await composer.press("Enter");
    await expect.poll(() => sends("b").length, { timeout: 30_000 }).toBe(1);
    await expect(page.getByText("Bravo part").first()).toBeVisible({ timeout: 20_000 });
    await expect(stop).toBeVisible();
    expect(sends("a")[0].closed).toBe(false);

    // Stop in B ends B's job only: its provider request is aborted, A's goes on.
    await stop.click();
    await expect.poll(() => sends("b")[0].closed, { timeout: 20_000 }).toBe(true);
    await expect(stop).toHaveCount(0, { timeout: 20_000 });
    await expect(sendButton).toBeVisible();
    // B's end requests B's suggestions (B is selected); A's send still runs, so none for A.
    await expect(page.getByText("Bravo next")).toBeVisible({ timeout: 20_000 });
    expect(sends("a")[0].closed).toBe(false);
    expect(suggestions("a").length).toBe(suggestionsOfA);
    await page.waitForTimeout(1000);
    expect(sends("a")[0].closed).toBe(false);

    // Back in A: its send still runs (Stop shown, the reply streaming, no suggestions), then completes.
    await selectChat(page, "a");
    await expect(page.locator(".risu-chat[data-chat-id='a-m1']")).toBeVisible({ timeout: 20_000 });
    await expect(stop).toBeVisible();
    await expect(page.getByText("Alpha part").first()).toBeVisible();
    await expect(page.getByText("Bravo next")).toHaveCount(0);
    expect(suggestions("a").length).toBe(suggestionsOfA);
    releaseA();
    await expect(page.locator(".risu-chat").filter({ hasText: "Alpha part done." }).last()).toBeVisible({
        timeout: 30_000,
    });
    await expect(stop).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText("Alpha next")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Bravo next")).toHaveCount(0);

    // Each reply and each chat's suggestions are stored in their own chat only.
    await expect
        .poll(async () => (await stored(s, chaId, "a")).messages.slice(2), { timeout: 15_000 })
        .toEqual(["user:Go on, A", "char:Alpha part done."]);
    // The suggestions are the tab's own chat write, stored by the save loop (debounced).
    await expect.poll(async () => (await stored(s, chaId, "a")).suggest, { timeout: 15_000 }).toEqual(["Alpha next"]);
    await expect.poll(async () => (await stored(s, chaId, "b")).suggest, { timeout: 15_000 }).toEqual(["Bravo next"]);
    const a = await stored(s, chaId, "a");
    const b = await stored(s, chaId, "b");
    expect(b.messages[2]).toBe("user:Go on, B");
    expect(b.messages.slice(3).every((text) => text.startsWith("char:Bravo part"))).toBe(true);
    expect(a.messages.some((text) => text.includes("Bravo"))).toBe(false);
    expect(b.messages.some((text) => text.includes("Alpha"))).toBe(false);

    // Auto mode in group chat G1: rounds of one reply per member, in G1 only.
    await openCharacterChat(page, groupId);
    await page.locator(".default-chat-screen").waitFor({ timeout: 20_000 });
    await selectChat(page, "g1");
    await expect(page.locator(".risu-chat[data-chat-id='g1-m1']")).toBeVisible({ timeout: 20_000 });
    // The composer's menu toggles; it stays open after its item is clicked.
    const menu = composer.locator("xpath=following-sibling::button[.//*[contains(@class, 'lucide-menu')]]");
    const autoMode = page.getByText("Auto Mode", { exact: true });
    const toggleAutoMode = async () => {
        if (!(await autoMode.isVisible())) await menu.click();
        await autoMode.click();
    };
    await toggleAutoMode();
    await expect.poll(() => sends("g1").length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await expect(page.locator(".autoload")).toBeVisible();

    // Switching to G2 ends the run after the current round; G2 is not sent to and shows no Stop.
    await selectChat(page, "g2");
    await expect(page.locator(".risu-chat[data-chat-id='g2-m1']")).toBeVisible({ timeout: 20_000 });
    await expect(stop).toHaveCount(0);
    await expect.poll(() => sends("g1").every((entry) => entry.closed), { timeout: 30_000 }).toBe(true);
    const roundsEnded = sends("g1").length;
    expect(roundsEnded % members.length).toBe(0);
    await page.waitForTimeout(3000);
    expect(sends("g1").length).toBe(roundsEnded);
    expect(sends("g2").length).toBe(0);

    // Back in G1 the run does not resume; a new run is ended by Stop.
    await selectChat(page, "g1");
    await expect(page.locator(".risu-chat[data-chat-id='g1-m1']")).toBeVisible({ timeout: 20_000 });
    await expect(stop).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(sends("g1").length).toBe(roundsEnded);
    await toggleAutoMode();
    await expect.poll(() => sends("g1").length, { timeout: 30_000 }).toBeGreaterThan(roundsEnded);
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => sends("g1").every((entry) => entry.closed), { timeout: 30_000 }).toBe(true);
    const stopped = sends("g1").length;
    await page.waitForTimeout(3000);
    expect(sends("g1").length).toBe(stopped);
    expect(sends("g2").length).toBe(0);

    expect(s.errors).toEqual([]);

    // Cleanup: the characters (their chats and order go with them), and the records the seed changed
    // as they were before it (the specs after this one share the store).
    const ops: unknown[] = [];
    for (const id of [chaId, groupId, ...members]) {
        const record = (await s.api(`/api/resources/characters/${id}`)).body;
        ops.push({ kind: "characters", id, baseRevision: record.revision, delete: true });
    }
    for (const kind of ["ui", "modelPresets", "modelProfiles", "providers"] as const) {
        const now = (await s.api(`/api/resources/${kind}/main`)).body;
        ops.push({ kind, id: "main", baseRevision: now.revision, data: restore![kind] });
    }
    const removed = await s.api("/api/resources/batch", { method: "POST", body: JSON.stringify({ ops }) });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
});
