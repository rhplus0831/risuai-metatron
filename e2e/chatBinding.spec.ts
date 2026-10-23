import http from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { newPersonaId, normalizeModelPreset, normalizeModelProfile, normalizePreset } from "../shared/presets.ts";
import { clearSafeBootAttempts, openApp } from "../util/playwright/stack.mjs";

// Per-chat binding: a chat is sent only with its own model preset, prompt preset, and persona,
// never with the tab's selection, in the real app against the isolated stack of
// `playwright.config.ts`. What only the whole stack shows:
// - an unbound chat refuses to send: its send button reads "Set up this chat", Enter opens the
//   binding dialog and consumes nothing, no job is created, and the dialog's rows bind the chat
//   through the pickers in chat mode while the tab's selection stays; the bound chat then sends with
//   those records and keeps them across a reload;
// - a new chat inherits the previous chat's binding (`newChatBinding` "inherit", the default) and
//   sends at once; with "empty" it starts unbound;
// - an imported chat keeps the ids that exist here, drops the others, and needs the confirmation
//   before its first send;
// - two tabs of one browser context showing two bound chats send with their own presets: the mock
//   provider sees each chat's own model, response limit, and persona prompt.
// The provider is a local mock; no public service is contacted. The teardown removes the seeded
// characters (and their ids from the character order, which a character delete does not touch) and
// puts the settings lists and the ui record back as they were: the specs after this one share the store.

let provider: http.Server;
let providerUrl = "";
const providerBodies: { model: string; max_tokens: number; messages: { role: string; content: string }[] }[] = [];

test.beforeAll(async () => {
    provider = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const chunk of req) parts.push(chunk as Buffer);
        providerBodies.push(JSON.parse(Buffer.concat(parts).toString() || "{}"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Mock reply." } }] }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
});

test.afterAll(async () => {
    try {
        await restore();
    } finally {
        await new Promise((resolve) => provider.close(resolve));
    }
});

interface Session {
    page: Page;
    errors: string[];
    /** How many generation jobs the page asked for (`POST /api/generations`). */
    jobs: () => number;
    api: (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; body: any }>;
    open: () => Promise<void>;
    /** The epoch the resource reads answer (the requests the page made may predate it). */
    setEpoch: (epoch: string | undefined) => void;
}

/** The last session, whose credentials the restore after the tests uses. */
let lastSession: Session | null = null;

async function session(context: BrowserContext, baseURL: string): Promise<Session> {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    let auth: string | null = null;
    let epoch: string | null = null;
    let jobs = 0;
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generations") jobs += 1;
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
    lastSession = { page, errors, jobs: () => jobs, api, open, setEpoch };
    return lastSession;
}

/** The records the seed adds, by name (found again on a later seed, so a test never adds them twice). */
const NAMES = {
    profileA: "E2E Profile A",
    profileB: "E2E Profile B",
    modelA: "E2E Model A",
    modelB: "E2E Model B",
    promptA: "E2E Prompt A",
    promptB: "E2E Prompt B",
    personaA: "E2E Persona A",
    personaB: "E2E Persona B",
};

type Binding = { modelPresetId: string; promptPresetId: string; bindedPersona: string };

/** The settings lists as they were before the first seed, restored at the end; the characters seeded. */
let originals: {
    presets: any;
    modelPresets: any;
    modelProfiles: any;
    personas: any;
    providers: any;
    ui: any;
} | null = null;
const seededCharacters: string[] = [];

const byName = <T extends { name?: string }>(list: T[], name: string) => list.find((record) => record.name === name);

/**
 * Seeds the A and B record sets (a profile on the mock provider, a model preset whose slots name it,
 * a prompt preset with its own response limit, and a persona with its own prompt), and a character
 * with three chats: "Unbound" (no binding), "Bound A", and "Bound B". Returns the ids.
 */
async function seed(s: Session) {
    await s.open();
    const ui = (await s.api("/api/resources/ui/main")).body;
    s.setEpoch(ui.epoch);
    const [providers, presets, modelPresets, modelProfiles, personas, order] = await Promise.all(
        ["providers", "presets", "modelPresets", "modelProfiles", "personas", "characterOrder"].map(
            async (kind) => (await s.api(`/api/resources/${kind}/main`)).body,
        ),
    );
    originals ??= {
        presets: presets.data,
        modelPresets: modelPresets.data,
        modelProfiles: modelProfiles.data,
        personas: personas.data,
        providers: providers.data,
        ui: ui.data,
    };
    const profiles = [...modelProfiles.data];
    const profile = (name: string, requestModel: string) => {
        let record = byName(profiles, name);
        if (!record) {
            record = normalizeModelProfile({
                id: randomUUID(),
                name,
                modelId: "reverse_proxy",
                forceReplaceUrl: providerUrl,
                customProxyRequestModel: requestModel,
                maxContext: 4000,
            });
            profiles.push(record);
        }
        return record.id as string;
    };
    const models = [...modelPresets.data];
    const model = (name: string, profileId: string) => {
        let record = byName(models, name);
        if (!record) {
            record = normalizeModelPreset({ name, mainSlot: { profileId }, subSlot: { profileId } });
            models.push(record);
        }
        return record.id as string;
    };
    const prompts = [...presets.data];
    const prompt = (name: string, maxResponse: number) => {
        let record = byName(prompts, name);
        if (!record) {
            record = normalizePreset({ ...presets.data[0], name, maxResponse }, { id: randomUUID() });
            prompts.push(record);
        }
        return record.id as string;
    };
    const personaList = [...personas.data];
    const persona = (name: string, personaPrompt: string) => {
        let record = byName(personaList, name);
        if (!record) {
            record = { id: newPersonaId(), name, icon: "", personaPrompt, note: "", largePortrait: false };
            personaList.push(record);
        }
        return record.id as string;
    };
    const a: Binding = {
        modelPresetId: model(NAMES.modelA, profile(NAMES.profileA, "mock-a")),
        promptPresetId: prompt(NAMES.promptA, 111),
        bindedPersona: persona(NAMES.personaA, "Persona prompt A."),
    };
    const b: Binding = {
        modelPresetId: model(NAMES.modelB, profile(NAMES.profileB, "mock-b")),
        promptPresetId: prompt(NAMES.promptB, 222),
        bindedPersona: persona(NAMES.personaB, "Persona prompt B."),
    };
    const chaId = randomUUID();
    seededCharacters.push(chaId);
    const character = {
        name: `Binding ${chaId.slice(0, 6)}`,
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
    const chats = { unbound: randomUUID(), boundA: randomUUID(), boundB: randomUUID() };
    const chat = (id: string, name: string, binding: Partial<Binding>) => ({
        characterId: chaId,
        chatId: id,
        baseRevision: null,
        ops: [
            {
                op: "create",
                chat: { id, name, ...binding, message: [{ role: "char", data: "Seeded reply.", chatId: `m-${id}` }] },
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
                    data: { ...ui.data, didFirstSetup: true, sendWithEnter: true, newChatBinding: "inherit" },
                },
                {
                    kind: "providers",
                    id: "main",
                    baseRevision: providers.revision,
                    data: { ...providers.data, useStreaming: false, customTokenizer: "tik" },
                },
                { kind: "presets", id: "main", baseRevision: presets.revision, data: prompts },
                { kind: "modelPresets", id: "main", baseRevision: modelPresets.revision, data: models },
                { kind: "modelProfiles", id: "main", baseRevision: modelProfiles.revision, data: profiles },
                { kind: "personas", id: "main", baseRevision: personas.revision, data: personaList },
                { kind: "characters", id: chaId, baseRevision: null, data: character },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...(Array.isArray(order.data) ? order.data : []), chaId],
                },
            ],
            chats: [
                chat(chats.unbound, "Unbound", {}),
                chat(chats.boundA, "Bound A", a),
                chat(chats.boundB, "Bound B", b),
            ],
        }),
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    await s.open();
    return { chaId, chats, a, b };
}

/**
 * Removes the seeded characters and their ids from the character order (the server's character delete
 * leaves the order alone, and the client's next order repair would carry them out as an unrelated
 * write), and puts the settings lists and the ui record back as they were before the first seed.
 */
async function restore() {
    if (!lastSession || !originals) {
        return;
    }
    const { api: lastApi, setEpoch } = lastSession;
    setEpoch((await lastApi("/api/resources/ui/main")).body.epoch);
    const ops: unknown[] = [];
    for (const chaId of seededCharacters) {
        const record = (await lastApi(`/api/resources/characters/${chaId}`)).body;
        if (record?.revision) {
            ops.push({ kind: "characters", id: chaId, baseRevision: record.revision, delete: true });
        }
    }
    for (const kind of ["presets", "modelPresets", "modelProfiles", "personas", "providers", "ui"] as const) {
        const now = (await lastApi(`/api/resources/${kind}/main`)).body;
        ops.push({ kind, id: "main", baseRevision: now.revision, data: originals[kind] });
    }
    const order = (await lastApi("/api/resources/characterOrder/main")).body;
    ops.push({
        kind: "characterOrder",
        id: "main",
        baseRevision: order.revision,
        data: (Array.isArray(order.data) ? order.data : []).filter(
            (entry: unknown) => typeof entry !== "string" || !seededCharacters.includes(entry),
        ),
    });
    const removed = await lastApi("/api/resources/batch", { method: "POST", body: JSON.stringify({ ops }) });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
}

type Ref = { chaId: string; chatId: string };

/** A chat's binding as the chat list holds it (read without loading the chat). */
const entryOf = (page: Page, ref: Ref) =>
    page.evaluate(async (ref) => {
        const { chatEntry, findChat, selectedChatId } = await import("/src/ts/storage/chatStore.svelte.ts");
        const entry = chatEntry(ref);
        return {
            loaded: findChat(ref) !== undefined,
            selected: selectedChatId(ref.chaId),
            modelPresetId: entry?.modelPresetId ?? null,
            promptPresetId: entry?.promptPresetId ?? null,
            bindedPersona: entry?.bindedPersona ?? null,
            bindingReview: entry?.bindingReview ?? null,
        };
    }, ref);

/** Saves what the page queued and waits for the save loop to finish. */
const flush = (page: Page) =>
    page.evaluate(async () => {
        const sync = await import("/src/ts/storage/resourceSync.svelte.ts");
        await sync.flushResources();
    });

/** The tab's own selection (what a pick at home changes; a chat's pick must leave it alone). */
const tabSelection = (page: Page) =>
    page.evaluate(async () => {
        const { tabSelectionIds } = await import("/src/ts/storage/settingsViews.svelte.ts");
        return tabSelectionIds();
    });

/** The user messages of a loaded chat. */
const userMessages = (page: Page, ref: Ref) =>
    page.evaluate(async (ref) => {
        const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
        return (chatStore.findChat(ref)?.message ?? [])
            .filter((m: any) => m.role === "user")
            .map((m: any) => m.data as string);
    }, ref);

/** Selects the character from the home screen: its closed-chat screen with the sidebar's chat list. */
async function openCharacter(page: Page, chaId: string) {
    await page.locator(`[data-char-id="${chaId}"]`).first().click();
    await expect(page.getByRole("button", { name: /Open most recent chat/ })).toBeVisible({ timeout: 20_000 });
}

/** The sidebar's chat list row for the chat named `name`. */
const chatRow = (page: Page, name: string) => page.locator("button[data-risu-chat-idx]").filter({ hasText: name });

/** Opens the chat named `name` from the sidebar's list and waits for its screen. */
async function openChatRow(page: Page, name: string) {
    await chatRow(page, name).click();
    await expect(page.locator(".default-chat-screen")).toBeVisible({ timeout: 20_000 });
}

const sendButton = (page: Page) => page.locator(".button-icon-send");
const composer = (page: Page) => page.locator("textarea.text-input-area");
const dialog = (page: Page) => page.getByRole("dialog");
const row = (scope: Locator, field: "modelPresetId" | "promptPresetId" | "personaId") =>
    scope.locator(`[data-chat-binding-field="${field}"]`);

/** A picker list by its heading ("Model Presets", "Prompt Presets", "Persona"). */
const picker = (page: Page, heading: string) =>
    page.locator("div.z-40").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });

/** Picks the record named `name` in the picker `heading` and waits for the list to close. */
async function pick(page: Page, heading: string, name: string) {
    const list = picker(page, heading);
    await expect(list).toBeVisible();
    // A prompt preset row also holds an archive control labelled "Archive prompt preset: <name>",
    // whose name ends the same way, so the row is the match that is not that control.
    await list
        .getByRole("button", { name: new RegExp(`${name}$`) })
        .and(list.locator(":not([data-preset-archive-action])"))
        .click();
    await expect(list).toHaveCount(0);
}

/** Sends `text` with Enter and waits for the mock's reply to show. */
async function send(page: Page, text: string) {
    const input = composer(page);
    await input.fill(text);
    await input.press("Enter");
    await expect(page.locator(".risu-chat").filter({ hasText: "Mock reply." }).last()).toBeVisible({
        timeout: 30_000,
    });
}

/** The provider request that carried the user message `text`. */
const requestWith = (text: string) =>
    providerBodies.find((body) => body.messages?.some((m) => m.role === "user" && m.content.includes(text)));

const contains = (body: { messages: { content: string }[] } | undefined, text: string) =>
    body?.messages.some((m) => m.content.includes(text)) ?? false;

test("an unbound chat refuses to send and opens the binding dialog; its rows bind the chat without moving the tab's selection, and the bound chat sends and keeps its binding across a reload", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const { chaId, chats, a } = await seed(s);
    const { page } = s;
    const tabBefore = await tabSelection(page);
    expect(tabBefore.modelPresetId).not.toBe(a.modelPresetId);
    expect(tabBefore.presetId).not.toBe(a.promptPresetId);
    expect(tabBefore.personaId).not.toBe(a.bindedPersona);

    // The list marks the chat that cannot be sent, and only that one.
    await openCharacter(page, chaId);
    await expect(chatRow(page, "Unbound").locator("[data-chat-binding-incomplete]")).toHaveCount(1);
    await expect(chatRow(page, "Bound A").locator("[data-chat-binding-incomplete]")).toHaveCount(0);

    // The send button reads "Set up this chat"; Enter opens the dialog and consumes nothing.
    await openChatRow(page, "Unbound");
    const ref = { chaId, chatId: chats.unbound };
    await expect(sendButton(page)).toHaveText("Set up this chat");
    const bodiesBefore = providerBodies.length;
    await composer(page).fill("Hello there");
    await composer(page).press("Enter");
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText("Unbound");
    for (const field of ["modelPresetId", "promptPresetId", "personaId"] as const) {
        await expect(row(dialog(page), field)).toContainText("not set");
    }
    await expect(composer(page)).toHaveValue("Hello there");
    expect(s.jobs()).toBe(0);
    expect(providerBodies.length).toBe(bodiesBefore);

    // Each row opens its picker for this chat; a pick binds that field and closes the list.
    await row(dialog(page), "modelPresetId").click();
    await expect(picker(page, "Model Presets")).toContainText("For this chat: Unbound");
    await pick(page, "Model Presets", NAMES.modelA);
    await expect(row(dialog(page), "modelPresetId")).toContainText(NAMES.modelA);
    await expect(sendButton(page)).toHaveText("Set up this chat");
    await row(dialog(page), "promptPresetId").click();
    await expect(picker(page, "Prompt Presets")).toContainText("For this chat: Unbound");
    await pick(page, "Prompt Presets", NAMES.promptA);
    await expect(row(dialog(page), "promptPresetId")).toContainText(NAMES.promptA);
    await row(dialog(page), "personaId").click();
    await expect(picker(page, "Persona")).toContainText("For this chat: Unbound");
    await pick(page, "Persona", NAMES.personaA);
    await expect(row(dialog(page), "personaId")).toContainText(NAMES.personaA);
    expect(await entryOf(page, ref)).toMatchObject({ ...a, bindingReview: null });
    // The tab's selection is untouched (the picks were this chat's).
    expect(await tabSelection(page)).toEqual(tabBefore);

    // The dialog's close button; the send button is the send button again, and the sidebar's panel shows the binding.
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(sendButton(page)).not.toHaveText("Set up this chat");
    const sidePanel = page.locator("[data-chat-binding-panel]");
    await expect(row(sidePanel, "modelPresetId")).toContainText(NAMES.modelA);
    await expect(row(sidePanel, "personaId")).toContainText(NAMES.personaA);

    // The text was kept; the send goes out with the chat's own records.
    await expect(composer(page)).toHaveValue("Hello there");
    await composer(page).press("Enter");
    await expect(page.locator(".risu-chat").filter({ hasText: "Mock reply." }).last()).toBeVisible({
        timeout: 30_000,
    });
    expect(s.jobs()).toBe(1);
    const body = requestWith("Hello there");
    expect(body?.model).toBe("mock-a");
    expect(body?.max_tokens).toBe(111);
    expect(contains(body, "Persona prompt A.")).toBe(true);
    expect(await userMessages(page, ref)).toEqual(["Hello there"]);

    // After a reload the binding is in the chat's list entry, read without loading the chat.
    await flush(page);
    await s.open();
    expect(await entryOf(page, ref)).toMatchObject({ ...a, bindingReview: null, loaded: false });
    expect(s.errors).toEqual([]);
});

test("a new chat inherits the previous chat's binding and sends at once; with newChatBinding empty it starts unbound", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const { chaId, chats, a } = await seed(s);
    const { page } = s;
    // The seed's precondition (the normalizer's default, which the unit tests cover).
    expect((await s.api("/api/resources/ui/main")).body.data.newChatBinding).toBe("inherit");

    // The bound chat is the selected one; "New Chat" from the list creates and opens a chat with its binding.
    await openCharacter(page, chaId);
    await openChatRow(page, "Bound A");
    await page.getByRole("button", { name: "Go Back" }).click();
    await page.getByRole("button", { name: "New Chat", exact: true }).click();
    await expect(page.locator(".default-chat-screen")).toBeVisible({ timeout: 20_000 });
    const inherited = (await entryOf(page, { chaId, chatId: chats.boundA })).selected!;
    expect(inherited).not.toBe(chats.boundA);
    expect(await entryOf(page, { chaId, chatId: inherited })).toMatchObject({ ...a, bindingReview: null });
    await expect(sendButton(page)).not.toHaveText("Set up this chat");
    await send(page, "Inherited send");
    const body = requestWith("Inherited send");
    expect(body?.model).toBe("mock-a");
    expect(body?.max_tokens).toBe(111);
    expect(contains(body, "Persona prompt A.")).toBe(true);
    expect(await userMessages(page, { chaId, chatId: inherited })).toEqual(["Inherited send"]);
    expect(await userMessages(page, { chaId, chatId: chats.boundA })).toEqual([]);

    // With "empty" (the accessibility page's setting) the next new chat starts unbound.
    await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.newChatBinding = "empty";
    });
    await page.getByRole("button", { name: "Go Back" }).click();
    await page.getByRole("button", { name: "New Chat", exact: true }).click();
    await expect(page.locator(".default-chat-screen")).toBeVisible({ timeout: 20_000 });
    const empty = (await entryOf(page, { chaId, chatId: chats.boundA })).selected!;
    expect(empty).not.toBe(inherited);
    expect(await entryOf(page, { chaId, chatId: empty })).toMatchObject({
        modelPresetId: null,
        promptPresetId: null,
        bindedPersona: null,
        bindingReview: null,
    });
    await expect(sendButton(page)).toHaveText("Set up this chat");
    await page.getByRole("button", { name: "Go Back" }).click();
    // The seed's three chats, then "New Chat 4" (inherited) and "New Chat 5" (empty): the list marks the latter.
    await expect(chatRow(page, "New Chat 5").locator("[data-chat-binding-incomplete]")).toHaveCount(1);
    await expect(chatRow(page, "New Chat 4").locator("[data-chat-binding-incomplete]")).toHaveCount(0);
    await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.newChatBinding = "inherit";
    });
    await page.waitForTimeout(1500);
    expect(s.errors).toEqual([]);
});

test("an imported chat keeps the ids that exist here, drops the others, and needs the confirmation before its first send", async ({
    context,
    baseURL,
}) => {
    const s = await session(context, baseURL!);
    const { chaId, a } = await seed(s);
    const { page } = s;
    await openCharacter(page, chaId);

    // The chat export format (`risuChat` v1), bound to a model preset and persona that exist here and
    // a prompt preset that does not, through the real file chooser.
    const file = {
        type: "risuChat",
        ver: 1,
        data: {
            name: "Imported",
            note: "",
            localLore: [],
            message: [{ role: "char", data: "Imported reply." }],
            modelPresetId: a.modelPresetId,
            promptPresetId: "not-a-preset-here",
            bindedPersona: a.bindedPersona,
            bindingReview: false,
        },
    };
    const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.evaluate(async () => {
            const { importChat } = await import("/src/ts/characters.ts");
            (window as any).__importDone = importChat();
        }),
    ]);
    await chooser.setFiles({
        name: "chat.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(file)),
    });
    await page.evaluate(() => (window as any).__importDone);
    await expect(page.getByText("Successfuly imported")).toBeVisible();
    await page.getByRole("button", { name: "OK", exact: true }).click();

    const chatId = await page.evaluate(async (chaId) => {
        const { chatList } = await import("/src/ts/storage/chatStore.svelte.ts");
        return chatList(chaId).find((entry: any) => entry.name === "Imported")!.id;
    }, chaId);
    const ref = { chaId, chatId };
    expect(await entryOf(page, ref)).toMatchObject({
        modelPresetId: a.modelPresetId,
        promptPresetId: null,
        bindedPersona: a.bindedPersona,
        bindingReview: true,
    });
    await expect(chatRow(page, "Imported").locator("[data-chat-binding-incomplete]")).toHaveCount(1);

    // The send button opens the dialog: the kept ids by name, the dropped one unset, and the confirmation.
    await openChatRow(page, "Imported");
    await expect(page.locator(".risu-chat").filter({ hasText: "Imported reply." })).toBeVisible();
    await expect(sendButton(page)).toHaveText("Set up this chat");
    await sendButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(row(dialog(page), "modelPresetId")).toContainText(NAMES.modelA);
    await expect(row(dialog(page), "promptPresetId")).toContainText("not set");
    await expect(row(dialog(page), "personaId")).toContainText(NAMES.personaA);
    await expect(dialog(page)).toContainText("The imported chat's settings need a confirmation.");
    // The dropped prompt preset first, so that the confirmation is all that still blocks the send.
    await row(dialog(page), "promptPresetId").click();
    await pick(page, "Prompt Presets", NAMES.promptA);
    await expect(row(dialog(page), "promptPresetId")).toContainText(NAMES.promptA);
    expect(await entryOf(page, ref)).toMatchObject({ ...a, bindingReview: true });
    await expect(dialog(page)).toContainText("The imported chat's settings need a confirmation.");
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);
    // Every id set and the confirmation pending: the send button still sets the chat up, Enter reopens
    // the dialog, the text stays, and no job is created.
    await expect(sendButton(page)).toHaveText("Set up this chat");
    const bodiesBefore = providerBodies.length;
    await composer(page).fill("Imported send");
    await composer(page).press("Enter");
    await expect(dialog(page)).toBeVisible();
    await expect(composer(page)).toHaveValue("Imported send");
    expect(s.jobs()).toBe(0);
    expect(providerBodies.length).toBe(bodiesBefore);
    const confirm = dialog(page).getByRole("button", { name: "Confirm", exact: true });
    await confirm.click();
    await expect(confirm).toHaveCount(0);
    expect(await entryOf(page, ref)).toMatchObject({ ...a, bindingReview: null });
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(sendButton(page)).not.toHaveText("Set up this chat");
    // The kept text goes out once the confirmation is given.
    await composer(page).press("Enter");
    await expect(page.locator(".risu-chat").filter({ hasText: "Mock reply." }).last()).toBeVisible({
        timeout: 30_000,
    });
    expect(s.jobs()).toBe(1);
    const body = requestWith("Imported send");
    expect(body?.model).toBe("mock-a");
    expect(contains(body, "Persona prompt A.")).toBe(true);
    expect(await userMessages(page, ref)).toEqual(["Imported send"]);
    await page.waitForTimeout(1500);
    expect(s.errors).toEqual([]);
});

test("two tabs showing two bound chats send with their own presets: the provider sees each chat's model, response limit, and persona", async ({
    browser,
    baseURL,
}) => {
    // Two tabs of one browser context: they share `localStorage` (the tab selection's starting value)
    // and the server, while each keeps its own `sessionStorage` (its selection, its generation client).
    const context = await browser.newContext();
    // The seed opens the app twice in tab A, so tab B would boot safe behind its notice.
    await clearSafeBootAttempts(context);
    const sa = await session(context, baseURL!);
    const { chaId, chats, a, b } = await seed(sa);
    const sb = await session(context, baseURL!);
    await sb.open();
    const tabA = await tabSelection(sa.page);
    const tabB = await tabSelection(sb.page);

    await openCharacter(sa.page, chaId);
    await openChatRow(sa.page, "Bound A");
    await openCharacter(sb.page, chaId);
    await openChatRow(sb.page, "Bound B");
    const refA = { chaId, chatId: chats.boundA };
    const refB = { chaId, chatId: chats.boundB };
    expect((await entryOf(sa.page, refA)).selected).toBe(chats.boundA);
    expect((await entryOf(sb.page, refB)).selected).toBe(chats.boundB);

    // Each tab's sidebar shows its own chat's binding.
    const panelA = sa.page.locator("[data-chat-binding-panel]");
    const panelB = sb.page.locator("[data-chat-binding-panel]");
    await expect(row(panelA, "modelPresetId")).toContainText(NAMES.modelA);
    await expect(row(panelA, "promptPresetId")).toContainText(NAMES.promptA);
    await expect(row(panelA, "personaId")).toContainText(NAMES.personaA);
    await expect(row(panelB, "modelPresetId")).toContainText(NAMES.modelB);
    await expect(row(panelB, "promptPresetId")).toContainText(NAMES.promptB);
    await expect(row(panelB, "personaId")).toContainText(NAMES.personaB);
    await expect(sendButton(sa.page)).not.toHaveText("Set up this chat");
    await expect(sendButton(sb.page)).not.toHaveText("Set up this chat");

    // Both send at once; each request carries its own chat's records.
    await Promise.all([send(sa.page, "From tab A"), send(sb.page, "From tab B")]);
    const bodyA = requestWith("From tab A");
    const bodyB = requestWith("From tab B");
    expect(bodyA?.model).toBe("mock-a");
    expect(bodyA?.max_tokens).toBe(111);
    expect(contains(bodyA, "Persona prompt A.")).toBe(true);
    expect(contains(bodyA, "Persona prompt B.")).toBe(false);
    expect(bodyB?.model).toBe("mock-b");
    expect(bodyB?.max_tokens).toBe(222);
    expect(contains(bodyB, "Persona prompt B.")).toBe(true);
    expect(contains(bodyB, "Persona prompt A.")).toBe(false);
    expect(await userMessages(sa.page, refA)).toEqual(["From tab A"]);
    expect(await userMessages(sb.page, refB)).toEqual(["From tab B"]);
    // The bindings are the chats', so neither tab's selection moved.
    expect(await tabSelection(sa.page)).toEqual(tabA);
    expect(await tabSelection(sb.page)).toEqual(tabB);
    expect(tabA.modelPresetId).not.toBe(b.modelPresetId);
    expect(tabB.modelPresetId).not.toBe(a.modelPresetId);

    await sa.page.waitForTimeout(1500);
    await sb.page.waitForTimeout(1500);
    expect(sa.errors).toEqual([]);
    expect(sb.errors).toEqual([]);
    await context.close();
});
