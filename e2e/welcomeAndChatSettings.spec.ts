import http from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { chatBindingFixture, modelFixtureOps } from "../util/playwright/modelProfiles.mjs";
import { isolateContext, openApp } from "../util/playwright/stack.mjs";

// Phase 6 slice 7 (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/readers-settings-consumers.md`,
// "Validation"): the settings consumers outside the settings pages read and write through the settings
// views. In the real app against the isolated stack of `playwright.config.ts`:
// - the chat screen's settings-driven behaviors: send with Enter (on and off), the auto-translate
//   input row toggled from the menu (saved), the icon size, the module effect (a module that hides the
//   icons, enabled globally or named by the preset's module integration), the theme;
// - the playground pages and the Iris modal mount without a page error; the Iris modal's model check
//   follows the selected model preset's sub slot, and its saved dialogue lands in the `ui` record.
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
        const { settings, activePreset, activeModelPreset, activeMainProfile, activeSubProfile, activePersona } =
            await import("/src/ts/storage/settingsViews.svelte.ts");
        const { selection } = await import("/src/ts/storage/selection.svelte.ts");
        const profile = (view: typeof activeMainProfile) => ({
            id: view.id,
            modelId: view.modelId,
            maxContext: view.maxContext,
        });
        return JSON.parse(
            JSON.stringify({
                ui: settings.ui,
                memory: settings.memoryTranslateMedia,
                preset: { id: activePreset.id, ...activePreset },
                modelPreset: { id: activeModelPreset.id },
                mainProfile: profile(activeMainProfile),
                subProfile: profile(activeSubProfile),
                persona: { id: activePersona.id, name: activePersona.name },
                selection: {
                    presetId: selection.presetId,
                    modelPresetId: selection.modelPresetId,
                    personaId: selection.personaId,
                },
            }),
        );
    });

/** Seeds a character with one chat, the selected model preset on the mock provider, and the given ui and memory fields, then opens the chat. */
async function seedChat(s: Session, ui: Record<string, unknown>, memory: Record<string, unknown>) {
    await s.open();
    const uiRecord = (await s.api("/api/resources/ui/main")).body;
    s.setEpoch(uiRecord.epoch);
    const memoryRecord = (await s.api("/api/resources/memoryTranslateMedia/main")).body;
    const providers = (await s.api("/api/resources/providers/main")).body;
    const presets = (await s.api("/api/resources/presets/main")).body;
    const order = (await s.api("/api/resources/characterOrder/main")).body;
    const modelPresets = (await s.api("/api/resources/modelPresets/main")).body;
    const modelProfiles = (await s.api("/api/resources/modelProfiles/main")).body;
    const personas = (await s.api("/api/resources/personas/main")).body;
    const selected = await views(s.page);
    // `modelFixtureOps` sets the first model preset's slots: the one a fresh tab selects. The chat is
    // bound to it, the first prompt preset (the selected one, edited below), and the first persona
    // (`docs/plan/chat-binding.md`: a send runs only with a complete binding).
    expect(selected.modelPreset.id).toBe(modelPresets.data[0].id);
    expect(selected.preset.id).toBe(presets.data[0].id);
    const binding = chatBindingFixture(modelPresets, presets, personas);
    const model = {
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        forceReplaceUrl: providerUrl,
        customProxyRequestModel: "mock",
        maxContext: 4000,
    };
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
                    data: { ...memoryRecord.data, ...memory },
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
                        preset.id === selected.preset.id ? { ...preset, maxResponse: 100 } : preset,
                    ),
                },
                ...modelFixtureOps(model, modelPresets, modelProfiles),
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
                                ...binding,
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
            // Selecting a character shows its closed chat; the chat opens like a pick from the list.
            const { changeChatTo } = await import("/src/ts/globalApi.svelte.ts");
            changeChatTo(chatId);
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

    // The Iris modal: the intro line, and the unsupported-model notice following the sub slot (Iris
    // asks in mode `otherAx`, which falls back to the sub slot), set to a profile of that model.
    const setSubModel = (model: string) =>
        s.page.evaluate(async (model) => {
            const { applyModelFixtureSettings } = await import("/util/playwright/modelProfiles.browser.mjs");
            applyModelFixtureSettings({ subModel: model });
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
