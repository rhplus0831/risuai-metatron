import http from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { isolateContext, openApp } from "../util/playwright/stack.mjs";

// Phase 6 slice 7 (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/readers-settings-consumers.md`,
// "Validation"): the settings consumers outside the settings pages read and write through the settings
// views. In the real app against the isolated stack of `playwright.config.ts`:
// - the first-run wizard: every write lands in its section, the selected preset, or the selected
//   persona on the server (the API key goes to the server's write-only credentials, and the tab never
//   reads it back), and a reload starts the app instead of the wizard;
// - the chat screen's settings-driven behaviors: send with Enter (on and off), the auto-translate
//   input row toggled from the menu (saved), the icon size, the module effect (a module that hides the
//   icons, enabled globally or named by the preset's module integration), the theme;
// - the playground pages and the Iris modal mount without a page error; the Iris modal's model check
//   follows the selected preset's sub model, and its saved dialogue lands in the `ui` record.
// The provider is a local mock; no public service is contacted. The spec name sorts after every other
// spec: it changes the selected preset, the persona, and the ui settings of the shared stack.

let provider: http.Server;
let providerUrl = "";
const providerBodies: any[] = [];

test.beforeAll(async () => {
    provider = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const chunk of req) parts.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
        providerBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Mock reply." } }] }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
});

test.afterAll(async () => {
    await new Promise((resolve) => provider.close(resolve));
});

interface Session {
    page: Page;
    errors: string[];
    blocked: string[];
    api: (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; body: any }>;
    open: () => Promise<void>;
    /** The epoch the resource reads answer (the requests the page made may predate it). */
    setEpoch: (epoch: string | undefined) => void;
}

async function session(context: BrowserContext, baseURL: string): Promise<Session> {
    const blocked = await isolateContext(context);
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
    return { page, errors, blocked, api, open, setEpoch };
}

/** The refused requests that were not expected (fonts, CDN stylesheets, the home screen's hub listing). */
const unexpected = (blocked: string[]) =>
    blocked.filter(
        (href) =>
            !["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com", "sv.risuai.xyz"].includes(
                new URL(href).hostname,
            ),
    );

/** Saves what the page queued and waits for the save loop to finish. */
const flush = (page: Page) =>
    page.evaluate(async () => {
        const sync = await import("/src/ts/storage/resourceSync.svelte.ts");
        await sync.flushResources();
    });

/** What the tab's settings views read now (a plain copy). */
const views = (page: Page) =>
    page.evaluate(async () => {
        const { settings, activePreset, activePersona } = await import("/src/ts/storage/settingsViews.svelte.ts");
        const { selection } = await import("/src/ts/storage/selection.svelte.ts");
        return JSON.parse(
            JSON.stringify({
                ui: settings.ui,
                memory: settings.memoryTranslateMedia,
                preset: { id: activePreset.id, ...activePreset },
                persona: { id: activePersona.id, name: activePersona.name },
                selection: { presetId: selection.presetId, personaId: selection.personaId },
            }),
        );
    });

test("the first-run wizard writes every answer into its section, the selected preset, or the selected persona, and a reload starts the app", async ({
    context,
    baseURL,
}) => {
    test.setTimeout(240_000);
    const s = await session(context, baseURL!);
    await s.open();
    // Run alone, the stack is fresh and this is the first run. After other specs (which finish the
    // setup), the setup is undone first, so the wizard shows again.
    const freshRun = !(await views(s.page)).ui.didFirstSetup;
    test.info().annotations.push({ type: "first run", description: freshRun ? "fresh server" : "setup undone" });
    if (!freshRun) {
        const ui = (await s.api("/api/resources/ui/main")).body;
        s.setEpoch(ui.epoch);
        const undone = await s.api("/api/resources/batch", {
            method: "POST",
            body: JSON.stringify({
                ops: [
                    { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: false } },
                ],
            }),
        });
        expect(undone.status, JSON.stringify(undone.body)).toBe(200);
        await s.open();
    }
    const welcome = s.page.getByText("First, what may I call you?", { exact: false });
    await expect(welcome).toBeVisible({ timeout: 30_000 });
    const before = await views(s.page);
    expect(before.ui.didFirstSetup).toBeFalsy();
    // The browser's language is English: the wizard skipped the language step and wrote it.
    expect(before.ui.language).toBe("en");

    const composer = s.page.locator("textarea.input-text").last();
    await composer.fill("Wizard Tester");
    await composer.press("Enter");
    await s.page.getByText("Guide me to setup").click();
    await s.page.getByRole("button", { name: /^OpenAI/ }).click();
    await composer.fill("sk-wizard-test-key");
    await composer.press("Enter");
    await s.page.getByText("English Processing").click();
    await s.page.getByText("Cheap", { exact: true }).click();
    await expect(s.page.getByText("All Done! Please wait a moment.")).toBeVisible();
    // The wizard applies its writes a second after the last answer, then the app starts.
    await expect(welcome).toBeHidden({ timeout: 20_000 });
    await flush(s.page);

    // The tab: every answer read back through the views, the key not among them (the records the tab
    // holds, serialized: the flat settings snapshot, every section view, the preset and persona
    // lists, the selected ones, and the characters).
    const after = await views(s.page);
    expect(after.ui).toMatchObject({ didFirstSetup: true, language: "en", textTheme: "highcontrast" });
    expect(after.memory).toMatchObject({
        translator: "en",
        autoTranslate: true,
        translatorType: "google",
        useAutoTranslateInput: true,
    });
    expect(after.preset).toMatchObject({
        id: before.preset.id,
        maxContext: 8000,
        maxResponse: 500,
        aiModel: "gpt4o-chatgpt",
        subModel: "gpt4o-chatgpt",
    });
    expect(after.persona).toEqual({ id: before.persona.id, name: "Wizard Tester" });
    expect(after.selection).toEqual(before.selection);
    const tabText = await s.page.evaluate(async () => {
        const { settings, activePreset, activePersona } = await import("/src/ts/storage/settingsViews.svelte.ts");
        const { rootSnapshot } = await import("/src/ts/storage/snapshots.svelte.ts");
        const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
        return [
            rootSnapshot(),
            settings.llmSecrets,
            settings.secrets,
            settings.providers,
            settings.ui,
            settings.memoryTranslateMedia,
            settings.presets,
            settings.personas,
            activePreset,
            activePersona,
            characterList(),
        ]
            .map((value) => JSON.stringify(value))
            .join("\n");
    });
    // The serialization is the real records (the wizard's `didFirstSetup` is in it), not a constant.
    expect(tabText).toContain('"didFirstSetup":true');
    expect(tabText).not.toContain("sk-wizard-test-key");

    // The server: each write in its own record.
    const ui = (await s.api("/api/resources/ui/main")).body.data;
    expect(ui).toMatchObject({ didFirstSetup: true, language: "en", textTheme: "highcontrast" });
    const memory = (await s.api("/api/resources/memoryTranslateMedia/main")).body.data;
    expect(memory).toMatchObject({
        translator: "en",
        autoTranslate: true,
        translatorType: "google",
        useAutoTranslateInput: true,
    });
    const presets = (await s.api("/api/resources/presets/main")).body.data as any[];
    const selected = presets.find((preset) => preset.id === before.preset.id);
    expect(selected).toMatchObject({
        maxContext: 8000,
        maxResponse: 500,
        aiModel: "gpt4o-chatgpt",
        subModel: "gpt4o-chatgpt",
    });
    // The other presets are untouched by the template and the answers.
    for (const preset of presets.filter((entry) => entry.id !== before.preset.id)) {
        expect(preset.aiModel === "gpt4o-chatgpt" && preset.maxContext === 8000).toBe(false);
    }
    const personas = (await s.api("/api/resources/personas/main")).body.data as any[];
    expect(personas.find((persona) => persona.id === before.persona.id)?.name).toBe("Wizard Tester");
    // The key: on the server's write-only credentials (masked in every read), in no settings record.
    const secrets = (await s.api("/api/resources/llmSecrets/main")).body;
    expect(JSON.stringify(secrets)).not.toContain("sk-wizard-test-key");
    expect(JSON.stringify(secrets.data)).toContain("openAIKey");
    for (const kind of ["ui", "providers", "secrets", "memoryTranslateMedia", "presets"]) {
        const record = (await s.api(`/api/resources/${kind}/main`)).body;
        expect(JSON.stringify(record), kind).not.toContain("sk-wizard-test-key");
    }

    // A reload starts the app, not the wizard, with the persona's name.
    await s.open();
    await s.page.waitForTimeout(1500);
    await expect(welcome).toHaveCount(0);
    expect((await views(s.page)).persona.name).toBe("Wizard Tester");
    expect(s.errors).toEqual([]);
    expect(unexpected(s.blocked)).toEqual([]);
});

/** Seeds a character with one chat, a preset on the mock provider, and the given ui and memory fields, then opens the chat. */
async function seedChat(s: Session, ui: Record<string, unknown>, memory: Record<string, unknown>) {
    await s.open();
    const uiRecord = (await s.api("/api/resources/ui/main")).body;
    s.setEpoch(uiRecord.epoch);
    const memoryRecord = (await s.api("/api/resources/memoryTranslateMedia/main")).body;
    const providers = (await s.api("/api/resources/providers/main")).body;
    const presets = (await s.api("/api/resources/presets/main")).body;
    const order = (await s.api("/api/resources/characterOrder/main")).body;
    const selectedPresetId = (await views(s.page)).preset.id;
    const chaId = randomUUID();
    const chatId = randomUUID();
    const character = {
        name: `Settings ${chaId.slice(0, 6)}`,
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
    const seeded = await s.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: uiRecord.revision,
                    data: { ...uiRecord.data, didFirstSetup: true, ...ui },
                },
                {
                    kind: "memoryTranslateMedia",
                    id: "main",
                    baseRevision: memoryRecord.revision,
                    data: { ...memoryRecord.data, autoTranslate: false, ...memory },
                },
                {
                    kind: "providers",
                    id: "main",
                    baseRevision: providers.revision,
                    data: { ...providers.data, useStreaming: false },
                },
                {
                    kind: "presets",
                    id: "main",
                    baseRevision: presets.revision,
                    data: (presets.data as any[]).map((preset) =>
                        preset.id === selectedPresetId
                            ? {
                                  ...preset,
                                  aiModel: "reverse_proxy",
                                  subModel: "reverse_proxy",
                                  forceReplaceUrl: providerUrl,
                                  customProxyRequestModel: "mock",
                                  maxContext: 4000,
                                  maxResponse: 100,
                              }
                            : preset,
                    ),
                },
                { kind: "characters", id: chaId, baseRevision: null, data: character },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...(Array.isArray(order.data) ? order.data : []), chaId],
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
                                name: "Settings chat",
                                message: [{ role: "char", data: "Seeded reply.", chatId: "m-seed" }],
                            },
                        },
                    ],
                },
            ],
        }),
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    await s.open();
    await s.page.locator(`[data-char-id="${chaId}"]`).first().click();
    await s.page.evaluate(
        async ({ chaId, chatId }) => {
            const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
            chatStore.selectChat(chaId, chatId);
        },
        { chaId, chatId },
    );
    await expect(s.page.locator('.risu-chat[data-chat-id="m-seed"]')).toBeVisible({ timeout: 20_000 });
    return { chaId, chatId };
}

const userMessages = (page: Page, ref: { chaId: string; chatId: string }) =>
    page.evaluate(async (ref) => {
        const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
        return chatStore
            .findChat(ref)!
            .message.filter((m: any) => m.role === "user")
            .map((m: any) => m.data);
    }, ref);

test("the chat screen follows its settings: send with Enter, the auto-translate input, the icon size, and the theme", async ({
    context,
    baseURL,
}) => {
    test.setTimeout(240_000);
    const s = await session(context, baseURL!);
    const ref = await seedChat(
        s,
        { sendWithEnter: true, iconsize: 100, theme: "", waifuWidth: 100 },
        { translator: "ko", useAutoTranslateInput: false },
    );
    const composer = s.page.locator("textarea.text-input-area");

    // Send with Enter on: Enter sends.
    await composer.fill("Sent by Enter");
    await composer.press("Enter");
    await expect.poll(() => userMessages(s.page, ref), { timeout: 30_000 }).toEqual(["Sent by Enter"]);
    await expect(s.page.getByText("Mock reply.").first()).toBeVisible({ timeout: 30_000 });
    expect(providerBodies.length).toBeGreaterThan(0);

    // Off: Enter is a new line and sends nothing; Shift+Enter sends.
    await s.page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.sendWithEnter = false;
    });
    await composer.fill("Two");
    await composer.press("Enter");
    await composer.pressSequentially("lines");
    await s.page.waitForTimeout(1000);
    expect(await userMessages(s.page, ref)).toEqual(["Sent by Enter"]);
    await expect(composer).toHaveValue("Two\nlines");
    await composer.press("Shift+Enter");
    await expect.poll(() => userMessages(s.page, ref), { timeout: 30_000 }).toEqual(["Sent by Enter", "Two\nlines"]);

    // The auto-translate input: toggled from the menu (the translator is set), saved in its section.
    await expect(s.page.locator("#messageInputTranslate")).toHaveCount(0);
    // The composer's own menu button (after the send button), not the message rows' menus.
    await composer.locator("xpath=following-sibling::button[.//*[contains(@class, 'lucide-menu')]]").click();
    await s.page.getByText("Auto Translate Input").click();
    await expect(s.page.locator("#messageInputTranslate")).toBeVisible();
    await flush(s.page);
    expect((await s.api("/api/resources/memoryTranslateMedia/main")).body.data.useAutoTranslateInput).toBe(true);
    await s.page.getByText("Auto Translate Input").click();
    await expect(s.page.locator("#messageInputTranslate")).toHaveCount(0);
    await flush(s.page);
    expect((await s.api("/api/resources/memoryTranslateMedia/main")).body.data.useAutoTranslateInput).toBe(false);
    await s.page.keyboard.press("Escape");

    // The icon size: the avatar follows the ui record (`iconsize * 3.5 / 100` rem).
    const avatarWidth = () =>
        s.page.evaluate(() => {
            const avatar = document.querySelector<HTMLElement>(
                '.risu-chat[data-chat-id="m-seed"] .shadow-lg.bg-textcolor2',
            );
            return avatar?.style.width ?? null;
        });
    await expect.poll(avatarWidth).toBe("3.5rem");
    await s.page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.iconsize = 200;
    });
    await expect.poll(avatarWidth).toBe("7rem");

    // The module effect (`stores.svelte.ts`) follows the views it reads: a module that hides the
    // icons hides the avatar once it is enabled globally (`settings.enabledModules`) or named by the
    // selected preset's module integration (`activePreset.moduleIntergration`), and only then.
    const modules = (step: "add" | "enable" | "disable" | "integrate" | "unintegrate" | "remove") =>
        s.page.evaluate(async (step) => {
            const store = await import("/src/ts/storage/collectionStore.svelte.ts");
            const { activePreset } = await import("/src/ts/storage/settingsViews.svelte.ts");
            if (step === "add") store.addModule({ name: "Hide icons", id: "e2e-hide-icons", hideIcon: true });
            if (step === "enable") store.setModuleEnabled("e2e-hide-icons", true);
            if (step === "disable") store.setModuleEnabled("e2e-hide-icons", false);
            if (step === "integrate") activePreset.moduleIntergration = "e2e-hide-icons";
            if (step === "unintegrate") activePreset.moduleIntergration = "";
            if (step === "remove") store.removeModule("e2e-hide-icons");
        }, step);
    await modules("add");
    await s.page.waitForTimeout(500);
    expect(await avatarWidth()).toBe("7rem");
    await modules("enable");
    await expect.poll(avatarWidth).toBeNull();
    await modules("disable");
    await expect.poll(avatarWidth).toBe("7rem");
    await modules("integrate");
    await expect.poll(avatarWidth).toBeNull();
    await modules("unintegrate");
    await expect.poll(avatarWidth).toBe("7rem");
    await modules("remove");

    // The theme: "waifu" lays the chat out at the waifu width; back to the default layout after.
    const waifuColumn = s.page.locator("div.h-full.w-2xl").filter({ has: s.page.locator("textarea.text-input-area") });
    await expect(waifuColumn).toHaveCount(0);
    await s.page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.theme = "waifu";
    });
    await expect(waifuColumn).toHaveCount(1);
    await expect(s.page.locator('.risu-chat[data-chat-id="m-seed"]')).toBeVisible();
    await flush(s.page);
    const ui = (await s.api("/api/resources/ui/main")).body.data;
    expect(ui).toMatchObject({ sendWithEnter: false, iconsize: 200, theme: "waifu" });
    await s.page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.theme = "";
        settings.ui.iconsize = 100;
        settings.ui.sendWithEnter = true;
    });
    await expect(waifuColumn).toHaveCount(0);
    await flush(s.page);
    expect(s.errors).toEqual([]);
    expect(unexpected(s.blocked)).toEqual([]);
});

test("the playground pages and the Iris modal mount without an error; the Iris modal follows the sub model and saves its dialogue", async ({
    context,
    baseURL,
}) => {
    test.setTimeout(240_000);
    const s = await session(context, baseURL!);
    await s.open();
    await s.page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.didFirstSetup = true;
    });
    const setPlayground = (page: number) =>
        s.page.evaluate(async (page) => {
            const stores = await import("/src/ts/stores.svelte.ts");
            stores.PlaygroundStore.set(page);
        }, page);

    // The menu, then every page it opens (the chat page creates the playground character).
    await setPlayground(1);
    await expect(s.page.getByText("Playground", { exact: false }).first()).toBeVisible();
    for (const page of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 101]) {
        await setPlayground(page);
        await s.page.waitForTimeout(400);
        expect(s.errors, `playground page ${page}`).toEqual([]);
    }
    // The embedding page's custom model binds the secrets section's nested fields.
    await setPlayground(3);
    await s.page.locator("select").first().selectOption("custom");
    const url = s.page.locator("input").nth(1);
    await expect(url).toBeVisible();
    await setPlayground(1);
    await s.page.locator("button").filter({ hasText: /chat/i }).first().click();
    await s.page.waitForTimeout(1500);
    expect(s.errors, "playground chat").toEqual([]);
    await setPlayground(0);

    // The Iris modal: the intro line, and the unsupported-model notice following the sub model.
    const setSubModel = (model: string) =>
        s.page.evaluate(async (model) => {
            const { activePreset } = await import("/src/ts/storage/settingsViews.svelte.ts");
            activePreset.subModel = model;
        }, model);
    const openIris = (open: boolean) =>
        s.page.evaluate(async (open) => {
            const stores = await import("/src/ts/stores.svelte.ts");
            stores.irisStore.open = open;
        }, open);
    const notice = s.page.getByText("It seems your current model doesn't support me responding", { exact: false });
    await setSubModel("gpt4o-chatgpt");
    await openIris(true);
    await expect(s.page.getByText("Hello there. I've been waiting for you.")).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveCount(0);
    await setSubModel("horde:::auto");
    await expect(notice).toBeVisible();
    await setSubModel("gpt4o-chatgpt");
    await expect(notice).toHaveCount(0);
    await openIris(false);
    // Closed for good (its outro done), so the next open mounts it again.
    await expect(s.page.getByRole("button", { name: /^Iris:/ })).toHaveCount(0);

    // A saved dialogue (the ui record) is what the modal shows when it opens.
    await s.page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.irisDialogue = [{ speaker: "Iris", text: "A saved line from the ui record." }];
    });
    await flush(s.page);
    expect((await s.api("/api/resources/ui/main")).body.data.irisDialogue).toEqual([
        { speaker: "Iris", text: "A saved line from the ui record." },
    ]);
    await openIris(true);
    await expect(s.page.getByText("A saved line from the ui record.")).toBeVisible({ timeout: 15_000 });
    await openIris(false);
    expect(s.errors).toEqual([]);
    expect(unexpected(s.blocked)).toEqual([]);
});
