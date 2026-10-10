import { expect, test, type Page } from "@playwright/test";
import { openApp } from "../util/playwright/stack.mjs";

// Phase 3, slice 6 (`docs/plan/phases/slices/phase-3-settings-sections/forwarding-personas.md`,
// Validation) and the chat binding (`docs/plan/chat-binding.md`: the persona is one of the three
// fields a chat binds, picked through the binding panel's row or the chat list's "Chat Settings",
// while a pick at home is the tab's selection): the persona forwarding in the browser, against the
// isolated stack of `playwright.config.ts`. What only the whole stack shows: an icon picked through
// the real file chooser while the user leaves for home, where the tab's other persona shows, lands
// on the persona the chooser opened for and keeps its id, so the chat bound to that persona keeps
// its binding across a reload (the phase's exit criterion); and the persona selection is per client
// while the personas are shared.

/** Lets the save loop run: the debounce is 500 ms, and a boot pass may send more than one cycle. */
const settle = (page: Page) => page.waitForTimeout(3000);

// A 1x1 PNG.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

interface PersonaView {
    selected: string;
    index: number;
    username: string;
    personaPrompt: string;
    list: { id: string; name: string; icon: string; personaPrompt: string }[];
}

const personas = (page: Page): Promise<PersonaView> =>
    page.evaluate(async () => {
        const { settings, activePersona, selectedPersonaIndex } =
            await import("/src/ts/storage/settingsViews.svelte.ts");
        const { selection } = await import("/src/ts/storage/selection.svelte.ts");
        return {
            selected: selection.personaId,
            index: selectedPersonaIndex(),
            username: activePersona.name,
            personaPrompt: activePersona.personaPrompt,
            list: settings.personas.map((persona: any) => ({
                id: persona.id,
                name: persona.name,
                icon: persona.icon,
                personaPrompt: persona.personaPrompt,
            })),
        };
    });

/** A pick where the screen shows it: the open chat's binding, or the tab's selection at home. */
const select = (page: Page, id: string) =>
    page.evaluate(async (personaId) => {
        const { changeUserPersona } = await import("/src/ts/persona.ts");
        changeUserPersona(personaId);
    }, id);

async function reload(page: Page, baseURL: string) {
    await page.reload();
    await openApp(page, baseURL);
    await settle(page);
}

/** The first boot of the store: skips the onboarding, names the default persona U1, and adds U2. */
async function seedPersonas(page: Page): Promise<[string, string]> {
    const ids = await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        const { newPersonaId } = await import("/shared/presets.ts");
        settings.ui.didFirstSetup = true;
        settings.ui.useLegacyGUI = true;
        settings.personas[0].name = "U1";
        settings.personas[0].personaPrompt = "I am one.";
        const id = newPersonaId();
        settings.personas.push({ id, name: "U2", icon: "", personaPrompt: "I am two.", note: "" });
        return [settings.personas[0].id, id];
    });
    await settle(page);
    return [ids[0], ids[1]];
}

test("the binding panel's persona row binds the open chat's persona while the tab keeps its own; an icon picked while the tab shows another persona lands on the persona the chooser opened for; the chat list's Chat Settings rebinds that row's chat", async ({
    page,
    baseURL,
}) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openApp(page, baseURL!);
    await settle(page);
    const [u1, u2] = await seedPersonas(page);
    // At home a pick is the tab's selection (decision 8).
    await select(page, u2);
    expect((await personas(page)).selected).toBe(u2);

    // A new character's first chat is unbound: its send button sets the chat up, the panel's persona row
    // reads "not set", and the screen shows the tab's persona (display only).
    const chaId = await page.evaluate(async () => {
        const { selectCharacter } = await import("/src/ts/storage/selection.svelte.ts");
        const { createNewCharacter } = await import("/src/ts/characters.ts");
        // `createNewCharacter` returns the new character's id (Phase 6 slice 8); the selection is by id.
        const chaId = createNewCharacter();
        selectCharacter(chaId);
        return chaId;
    });
    await page.getByRole("button", { name: /Open most recent chat/ }).click();
    await expect(page.locator(".default-chat-screen")).toBeVisible();
    const chatId = await page.evaluate(async (chaId) => {
        const { selectedChatId } = await import("/src/ts/storage/chatStore.svelte.ts");
        return selectedChatId(chaId)!;
    }, chaId);
    const ref = { chaId, chatId };
    const send = page.locator(".button-icon-send");
    await expect(send).toHaveText("Set up this chat");
    const panelRow = page.locator("[data-chat-binding-panel] [data-chat-binding-field='personaId']");
    await expect(panelRow).toContainText("not set");
    expect((await personas(page)).username).toBe("U2");

    // The row opens the persona list for this chat; the pick binds the chat, not the tab.
    await panelRow.click();
    const list = page.locator("div.z-40").filter({ has: page.getByRole("heading", { name: "Persona", exact: true }) });
    await expect(list).toContainText("For this chat:");
    await list.getByRole("button", { name: "U1", exact: true }).click();
    await expect(list).toHaveCount(0);
    await expect(panelRow).toContainText("U1");
    const bound = await page.evaluate(async (ref) => {
        const { chatEntry } = await import("/src/ts/storage/chatStore.svelte.ts");
        return chatEntry(ref)?.bindedPersona;
    }, ref);
    expect(bound).toBe(u1);
    const afterBind = await personas(page);
    expect(afterBind.selected).toBe(u2);
    // The views follow the open chat's binding: the persona editor and the user name show U1.
    expect(afterBind.username).toBe("U1");
    expect(afterBind.index).toBe(0);
    // The persona alone does not complete the binding (the model and prompt presets are unset).
    await expect(send).toHaveText("Set up this chat");
    await settle(page);

    // The real file chooser opens for the persona the editor shows (U1, the chat's); the user goes
    // home while it is open, where the views show the tab's U2; the PNG lands on U1.
    const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.evaluate(async () => {
            const { selectUserImg } = await import("/src/ts/persona.ts");
            (window as any).__iconDone = selectUserImg();
        }),
    ]);
    await page.evaluate(async () => {
        const { selectCharacter } = await import("/src/ts/storage/selection.svelte.ts");
        selectCharacter(null);
    });
    expect((await personas(page)).username).toBe("U2");
    await chooser.setFiles({ name: "icon.png", mimeType: "image/png", buffer: PNG });
    await page.evaluate(() => (window as any).__iconDone);
    await settle(page);

    const after = await personas(page);
    expect(after.selected).toBe(u2);
    expect(after.list.map((persona) => persona.id)).toEqual([u1, u2]);
    expect(after.list[0].icon).not.toBe("");
    expect(after.list[1].icon).toBe("");
    expect(after.username).toBe("U2");

    await reload(page, baseURL!);
    const view = await personas(page);
    expect(view.selected).toBe(u2);
    expect(view.list.map((persona) => persona.id)).toEqual([u1, u2]);
    // After the reload the chat is held as its summary (Phase 6 slice 9b: boot reads summaries, and the
    // tab is at home): the binding is read from its list entry, and the persona readers resolve it
    // without loading the chat.
    const binding = await page.evaluate(async (ref) => {
        const { chatEntry, findChat } = await import("/src/ts/storage/chatStore.svelte.ts");
        const { getUserIcon, getPersonaPrompt, getUserName } = await import("/src/ts/util.ts");
        return {
            loaded: findChat(ref) !== undefined,
            bindedPersona: chatEntry(ref)?.bindedPersona,
            name: getUserName(ref),
            icon: getUserIcon(ref),
            prompt: getPersonaPrompt(ref),
        };
    }, ref);
    expect(binding.loaded).toBe(false);
    expect(binding.bindedPersona).toBe(u1);
    expect(binding.name).toBe("U1");
    expect(binding.icon).toBe(view.list[0].icon);
    expect(binding.prompt).toBe("I am one.");

    // The chat list's "Chat Settings" (the former "Bind Persona") opens the dialog for that row's chat
    // (the row's menu click also opens the chat, as the row does); its persona row rebinds the chat and
    // the tab's selection stays.
    await page.evaluate(async (chaId) => {
        const { selectCharacter } = await import("/src/ts/storage/selection.svelte.ts");
        selectCharacter(chaId);
    }, chaId);
    const chatRow = page.locator("button[data-risu-chat-idx]").filter({ hasText: "Chat 1" });
    await expect(chatRow).toBeVisible();
    await chatRow.locator("[role='button']").first().click();
    await page.getByRole("button", { name: "Chat Settings" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Chat 1");
    const dialogRow = dialog.locator("[data-chat-binding-field='personaId']");
    await expect(dialogRow).toContainText("U1");
    await dialogRow.click();
    await list.getByRole("button", { name: "U2", exact: true }).click();
    await expect(list).toHaveCount(0);
    await expect(dialogRow).toContainText("U2");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    const rebound = await page.evaluate(async (ref) => {
        const { chatEntry } = await import("/src/ts/storage/chatStore.svelte.ts");
        const { getUserName } = await import("/src/ts/util.ts");
        return { bindedPersona: chatEntry(ref)?.bindedPersona, name: getUserName(ref) };
    }, ref);
    expect(rebound).toEqual({ bindedPersona: u2, name: "U2" });
    expect((await personas(page)).selected).toBe(u2);
    await settle(page);
    expect(errors).toEqual([]);
});

test("two clients keep their own persona selection across reloads while the personas are shared; a plugin-style index selects on one client only", async ({
    browser,
    baseURL,
}) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await openApp(pageA, baseURL!);
    await settle(pageA);
    const [u1, u2] = await seedPersonas(pageA);
    await select(pageA, u2);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await openApp(pageB, baseURL!);
    await settle(pageB);
    await select(pageB, u1);
    expect((await personas(pageB)).selected).toBe(u1);

    // A's edit of a forwarded persona field goes to U2; B sees it after a reload and is still on U1.
    await pageA.evaluate(async () => {
        const { activePersona } = await import("/src/ts/storage/settingsViews.svelte.ts");
        activePersona.personaPrompt = "Two, edited in A.";
    });
    await settle(pageA);
    await reload(pageB, baseURL!);
    const viewB = await personas(pageB);
    expect(viewB.selected).toBe(u1);
    expect(viewB.username).toBe("U1");
    expect(viewB.list.find((persona) => persona.id === u2)?.personaPrompt).toBe("Two, edited in A.");
    await reload(pageA, baseURL!);
    const viewA = await personas(pageA);
    expect(viewA.selected).toBe(u2);
    expect(viewA.personaPrompt).toBe("Two, edited in A.");

    // A plugin's `setDatabase({ selectedPersona })` is an index into the list, which the plugin host
    // resolves to the persona's id (`selectPersona`); it selects on this client only, and it survives
    // a reload here while B is untouched.
    await pageA.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        const { selectPersona } = await import("/src/ts/storage/selection.svelte.ts");
        selectPersona(settings.personas[0].id);
    });
    expect((await personas(pageA)).selected).toBe(u1);
    await settle(pageA);
    await reload(pageA, baseURL!);
    expect((await personas(pageA)).selected).toBe(u1);
    await select(pageB, u2);
    await reload(pageB, baseURL!);
    expect((await personas(pageB)).selected).toBe(u2);
    expect((await personas(pageA)).selected).toBe(u1);

    await contextA.close();
    await contextB.close();
});
