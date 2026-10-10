import http from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { chatBindingFixture, modelFixtureOps } from "../util/playwright/modelProfiles.mjs";
import { openApp } from "../util/playwright/stack.mjs";

// Phase 6 slice 9b (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/chat-projection-and-lazy-loading.md`,
// Validation): lazy loading in the browser, against the isolated stack of `playwright.config.ts`.
// What only the whole stack shows:
// - the boot reads summaries (no chat), and no chat is loaded at home; selecting a character loads
//   its selected chat only, a cold switch loads the chat on demand and the chat screen shows it;
// - after switching through more chats than the LRU keeps, at most eight idle chats stay loaded
//   beside the selected one, the list is whole, and nothing was written;
// - a rename of a chat that is not loaded (what the chat list does) saves without reading the chat,
//   and a second client converges on it without loading the chat either;
// - a send runs while another chat of the same character is not loaded, and leaves it unloaded.
// The provider is a local mock; no public service is contacted. The character is deleted at the end.

let provider: http.Server;
let providerUrl = "";

test.beforeAll(async () => {
    provider = http.createServer(async (req, res) => {
        for await (const _ of req);
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of ["Hello ", "lazy ", "reply."]) {
            if (res.destroyed) return;
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
            await new Promise((resolve) => setTimeout(resolve, 100));
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

/** Lets the save loop run: the debounce is 500 ms, and a boot pass may send more than one cycle. */
const settle = (page: Page) => page.waitForTimeout(2500);

interface Session {
    page: Page;
    errors: string[];
    /** The `/api/resources/read` bodies the page posted (the chats and summary lists each asked for). */
    reads: { chats: string[]; summaries: string[] }[];
    /** The `/api/resources` boot reads' query strings. */
    boots: string[];
    batches: number;
    api: (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; body: any }>;
    open: () => Promise<void>;
    setEpoch: (epoch: string | undefined) => void;
}

async function session(context: BrowserContext, baseURL: string): Promise<Session> {
    const page = await context.newPage();
    const s: Session = {
        page,
        errors: [],
        reads: [],
        boots: [],
        batches: 0,
        api: null as never,
        open: null as never,
        setEpoch: null as never,
    };
    page.on("pageerror", (error) => s.errors.push(String(error).slice(0, 300)));
    let auth: string | null = null;
    let epoch: string | null = null;
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
        const url = new URL(request.url());
        if (request.method() === "GET" && url.pathname === "/api/resources") {
            s.boots.push(url.search);
        }
        if (request.method() === "POST" && url.pathname === "/api/resources/read") {
            const body = JSON.parse(request.postData() ?? "{}") as {
                chats?: { characterId: string; id: string }[];
                chatSummaryCollections?: string[];
            };
            s.reads.push({
                chats: (body.chats ?? []).map((entry) => `${entry.characterId}/${entry.id}`),
                summaries: body.chatSummaryCollections ?? [],
            });
        }
        if (request.method() === "POST" && url.pathname === "/api/resources/batch") {
            s.batches += 1;
        }
    });
    page.on("response", (response) => {
        const value = response.headers()["x-resource-epoch"];
        if (value) epoch = value;
    });
    s.open = async () => {
        auth = null;
        await openApp(page, baseURL);
        for (let i = 0; i < 40 && !auth; i++) {
            await page.waitForTimeout(250);
        }
        expect(auth, "the app sent an authenticated request").toBeTruthy();
    };
    s.api = async (path, init = {}) => {
        const response = await fetch(baseURL + path, {
            ...init,
            headers: { "risu-auth": auth!, "x-resource-epoch": epoch!, "content-type": "application/json" },
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    s.setEpoch = (value) => {
        if (value) epoch = value;
    };
    return s;
}

const CHATS = ["big", ...Array.from({ length: 11 }, (_, i) => `s${i + 1}`)];
const message = (id: string, i: number) => ({
    role: i % 2 === 0 ? "user" : "char",
    data: `${id} message ${i}`,
    chatId: `${id}-m${i}`,
});

/** What the seed changes besides the character, to be restored at the end (the specs after this one share the store). */
let seededRecords: { modelPresets: any; modelProfiles: any; providers: any } | null = null;

/** Seeds the character with its twelve chats (`big`: 60 messages, the others 2) and the mock provider. */
async function seed(s: Session): Promise<string> {
    await s.open();
    const ui = (await s.api("/api/resources/ui/main")).body;
    s.setEpoch(ui.epoch);
    const order = (await s.api("/api/resources/characterOrder/main")).body;
    const modelPresets = (await s.api("/api/resources/modelPresets/main")).body;
    const modelProfiles = (await s.api("/api/resources/modelProfiles/main")).body;
    const presets = (await s.api("/api/resources/presets/main")).body;
    const personas = (await s.api("/api/resources/personas/main")).body;
    const providers = (await s.api("/api/resources/providers/main")).body;
    seededRecords = { modelPresets: modelPresets.data, modelProfiles: modelProfiles.data, providers: providers.data };
    const chaId = randomUUID();
    const character = {
        name: `Lazy ${chaId.slice(0, 6)}`,
        firstMessage: "Hello greeting",
        desc: "",
        notes: "",
        chatFolders: [{ id: "folder-1", name: "Folder", folded: false, color: "" }],
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
    // A profile on the mock provider, named by the first model preset's main and sub slots.
    const model = { aiModel: "reverse_proxy", forceReplaceUrl: providerUrl, customProxyRequestModel: "mock" };
    // Every chat is bound to that model preset, the first prompt preset, and the first persona: the
    // send below runs only with a complete binding (`docs/plan/chat-binding.md`).
    const binding = chatBindingFixture(modelPresets, presets, personas);
    const seeded = await s.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: { ...ui.data, didFirstSetup: true, useLegacyGUI: true },
                },
                ...modelFixtureOps(model, modelPresets, modelProfiles),
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
            chats: CHATS.map((id) => ({
                characterId: chaId,
                chatId: id,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id,
                            name: id.toUpperCase(),
                            ...binding,
                            message: Array.from({ length: id === "big" ? 60 : 2 }, (_, i) => message(id, i)),
                            ...(id === "s2" ? { folderId: "folder-1" } : {}),
                        },
                    },
                ],
            })),
        }),
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    return chaId;
}

type Store = {
    list: { id: string; name: string; folderId?: string }[];
    loaded: string[];
    selected: string | null;
    screen: boolean;
};

/** The chat module's view of the character in the page: the list, the loaded chats, the selection, the chat screen. */
const store = (page: Page, chaId: string): Promise<Store> =>
    page.evaluate(async (id) => {
        const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
        const list = chatStore.chatList(id);
        return {
            list: list.map((entry: any) => ({ id: entry.id, name: entry.name, folderId: entry.folderId })),
            loaded: list
                .filter((entry: any) => chatStore.findChat({ chaId: id, chatId: entry.id }))
                .map((e: any) => e.id),
            selected: chatStore.selectedChatId(id),
            screen: document.querySelector(".default-chat-screen") !== null,
        };
    }, chaId);

const selectChat = (page: Page, chaId: string, chatId: string) =>
    page.evaluate(
        async ({ chaId, chatId }) => {
            const { changeChatTo } = await import("/src/ts/globalApi.svelte.ts");
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            changeChatTo(chatId);
            return {
                selectedAtOnce: chatStore.selectedChatId(chaId),
                loadedAtOnce: chatStore.findChat({ chaId, chatId }) !== undefined,
            };
        },
        { chaId, chatId },
    );

const rename = (page: Page, chaId: string, chatId: string, name: string) =>
    page.evaluate(
        async ({ chaId, chatId, name }) => {
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            chatStore.setChatMeta({ chaId, chatId }, { name });
        },
        { chaId, chatId, name },
    );

test("boot holds summaries, chats load when selected, the trim keeps eight idle chats, a rename of an unloaded chat saves and converges on a second client without a load, and a send runs beside an unloaded chat", async ({
    context,
    browser,
    baseURL,
}) => {
    const a = await session(context, baseURL!);
    const chaId = await seed(a);
    const ref = (chatId: string) => `${chaId}/${chatId}`;

    // The boot: summaries, no chat; nothing loaded at home.
    a.reads.length = 0;
    a.boots.length = 0;
    await a.open();
    await settle(a.page);
    expect(a.boots.length).toBeGreaterThan(0);
    expect(a.boots.every((query) => query.includes("chatSummaries=1") && !query.includes("chats=1"))).toBe(true);
    let view = await store(a.page, chaId);
    expect(view.list.map((entry) => entry.id)).toEqual(CHATS);
    expect(view.list[2]).toEqual({ id: "s2", name: "S2", folderId: "folder-1" });
    expect(view.loaded).toEqual([]);
    expect(a.reads.filter((read) => read.chats.length > 0)).toEqual([]);
    const batchesAtBoot = a.batches;

    // Selecting the character loads its selected chat only, and its button on the closed chat opens it.
    await a.page.locator(`[data-char-id="${chaId}"]`).first().click();
    await a.page.getByRole("button", { name: /Open most recent chat/ }).click();
    await a.page.locator(".default-chat-screen").waitFor({ timeout: 20_000 });
    await a.page.waitForTimeout(500);
    view = await store(a.page, chaId);
    expect(view.selected).toBe("big");
    expect(view.loaded).toEqual(["big"]);
    expect(a.reads.filter((read) => read.chats.length > 0).map((read) => read.chats)).toEqual([[ref("big")]]);
    await expect(a.page.locator(".risu-chat[data-chat-id='big-m59']")).toBeVisible({ timeout: 20_000 });

    // A cold switch: the selection is immediate, the chat loads, the screen shows it.
    const cold = await selectChat(a.page, chaId, "s5");
    expect(cold).toEqual({ selectedAtOnce: "s5", loadedAtOnce: false });
    await expect(a.page.locator(".risu-chat[data-chat-id='s5-m1']")).toBeVisible({ timeout: 20_000 });
    view = await store(a.page, chaId);
    expect(view.loaded).toEqual(["big", "s5"]);
    expect(a.reads.filter((read) => read.chats.length > 0).map((read) => read.chats)).toEqual([
        [ref("big")],
        [ref("s5")],
    ]);

    // Through every other chat: each loads once; the trim keeps eight idle ones beside the selected.
    for (const id of CHATS.filter((id) => id !== "big" && id !== "s5")) {
        await selectChat(a.page, chaId, id);
        await expect(a.page.locator(`.risu-chat[data-chat-id='${id}-m1']`)).toBeVisible({ timeout: 20_000 });
    }
    await a.page.waitForTimeout(500);
    view = await store(a.page, chaId);
    expect(view.selected).toBe("s11");
    expect(view.loaded).toContain("s11");
    expect(view.loaded.length).toBe(9);
    expect(view.loaded).not.toContain("big");
    expect(view.list.map((entry) => entry.id)).toEqual(CHATS);
    const chatReads = a.reads.filter((read) => read.chats.length > 0).map((read) => read.chats);
    expect(chatReads).toHaveLength(CHATS.length);
    expect(new Set(chatReads.flat()).size).toBe(CHATS.length);
    expect(a.batches).toBe(batchesAtBoot);

    // A rename of a chat that is not loaded (the chat list's write): saved without reading the chat.
    expect(view.loaded).not.toContain("s1");
    a.reads.length = 0;
    await rename(a.page, chaId, "s1", "S1 renamed");
    await settle(a.page);
    const saved = await a.api("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({ chats: [{ characterId: chaId, id: "s1" }] }),
    });
    expect(saved.body.chats[0].data.name).toBe("S1 renamed");
    expect(saved.body.chats[0].data.message).toHaveLength(2);
    expect(a.reads.flatMap((read) => read.chats)).not.toContain(ref("s1"));
    view = await store(a.page, chaId);
    expect(view.loaded).not.toContain("s1");
    expect(view.list.find((entry) => entry.id === "s1")?.name).toBe("S1 renamed");

    // A second client: the boot shows the rename as a summary; a later rename converges live, without a load.
    const contextB = await browser.newContext();
    const b = await session(contextB, baseURL!);
    await b.open();
    await settle(b.page);
    let viewB = await store(b.page, chaId);
    expect(viewB.loaded).toEqual([]);
    expect(viewB.list.find((entry) => entry.id === "s1")?.name).toBe("S1 renamed");
    b.reads.length = 0;
    await rename(a.page, chaId, "s2", "S2 renamed");
    await expect
        .poll(async () => (await store(b.page, chaId)).list.find((entry) => entry.id === "s2")?.name, {
            timeout: 15_000,
        })
        .toBe("S2 renamed");
    viewB = await store(b.page, chaId);
    expect(viewB.loaded).toEqual([]);
    expect(viewB.list.find((entry) => entry.id === "s2")?.folderId).toBe("folder-1");
    expect(b.reads.flatMap((read) => read.chats)).toEqual([]);
    expect(b.reads.some((read) => read.summaries.includes(chaId))).toBe(true);
    expect(b.batches).toBe(0);

    // A send while `big` is not loaded: the reply streams into the selected chat; `big` stays unloaded.
    await selectChat(a.page, chaId, "s3");
    await expect(a.page.locator(".risu-chat[data-chat-id='s3-m1']")).toBeVisible({ timeout: 20_000 });
    const input = a.page.locator("textarea.input-text").first();
    await input.fill("Send please");
    await input.press("Enter");
    await expect(a.page.locator(".risu-chat").filter({ hasText: "lazy reply." }).last()).toBeVisible({
        timeout: 30_000,
    });
    await settle(a.page);
    view = await store(a.page, chaId);
    expect(view.selected).toBe("s3");
    expect(view.loaded).not.toContain("big");
    const sent = await a.api("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({ chats: [{ characterId: chaId, id: "s3" }] }),
    });
    const texts = sent.body.chats[0].data.message.map((entry: any) => entry.data);
    expect(texts.slice(-2)).toEqual(["Send please", "Hello lazy reply."]);
    // The other client sees the reply through the summary list (a notice for an unloaded chat), not a chat read.
    await expect.poll(async () => (await store(b.page, chaId)).loaded, { timeout: 15_000 }).toEqual([]);
    expect(b.reads.flatMap((read) => read.chats)).toEqual([]);

    // The MCP chat history host reads a character's selected chat loaded on demand; the dataset export
    // reads every chat detached (complete, nothing loaded for it); the HypaV3 modal survives a cold switch.
    const hostRead = await b.page.evaluate(async (id) => {
        const { tabRisuAccessHost } = await import("/src/ts/process/mcp/risuaccess/host.ts");
        const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
        const before = chatStore.findChat({ chaId: id, chatId: chatStore.selectedChatId(id)! }) !== undefined;
        const messages = await tabRisuAccessHost.currentMessages({ chaId: id } as any);
        return { before, count: messages.length, selected: chatStore.selectedChatId(id) };
    }, chaId);
    expect(hostRead.before).toBe(false);
    expect(hostRead.selected).toBe("big");
    expect(hostRead.count).toBe(60);
    const [download] = await Promise.all([
        a.page.waitForEvent("download"),
        a.page.evaluate(async () => {
            const { exportAsDataset } = await import("/src/ts/storage/exportAsDataset.ts");
            await exportAsDataset();
        }),
    ]);
    const dataset = JSON.parse(
        (await (await import("node:fs/promises")).readFile(await download.path(), "utf-8")) as string,
    ) as {
        name: string;
        chats: { data: string }[];
    }[];
    const mine = dataset.filter((entry) => entry.name.startsWith("Lazy "));
    expect(mine).toHaveLength(CHATS.length);
    expect(mine.map((entry) => entry.chats.length).sort((x, y) => y - x)[0]).toBe(60);
    view = await store(a.page, chaId);
    expect(view.loaded).not.toContain("big");
    await a.page.evaluate(async (id) => {
        const { hypaV3ModalOpen } = await import("/src/ts/stores.svelte.ts");
        const { changeChatTo } = await import("/src/ts/globalApi.svelte.ts");
        hypaV3ModalOpen.set(true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        changeChatTo("big");
    }, chaId);
    await expect(a.page.locator(".risu-chat[data-chat-id='big-m59']")).toBeVisible({ timeout: 20_000 });
    await a.page.waitForTimeout(500);
    await a.page.evaluate(async () => {
        const { hypaV3ModalOpen } = await import("/src/ts/stores.svelte.ts");
        hypaV3ModalOpen.set(false);
    });

    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    await contextB.close();

    // Cleanup: the character (its chats and order go with it), and the model and provider records
    // as they were before the seed (the specs after this one share the store).
    const record = (await a.api(`/api/resources/characters/${chaId}`)).body;
    const modelPresetsNow = (await a.api("/api/resources/modelPresets/main")).body;
    const modelProfilesNow = (await a.api("/api/resources/modelProfiles/main")).body;
    const providersNow = (await a.api("/api/resources/providers/main")).body;
    const removed = await a.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                { kind: "characters", id: chaId, baseRevision: record.revision, delete: true },
                {
                    kind: "modelPresets",
                    id: "main",
                    baseRevision: modelPresetsNow.revision,
                    data: seededRecords!.modelPresets,
                },
                {
                    kind: "modelProfiles",
                    id: "main",
                    baseRevision: modelProfilesNow.revision,
                    data: seededRecords!.modelProfiles,
                },
                { kind: "providers", id: "main", baseRevision: providersNow.revision, data: seededRecords!.providers },
            ],
        }),
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
});
