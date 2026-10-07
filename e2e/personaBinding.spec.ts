import { expect, test, type Page } from "@playwright/test";
import { openApp } from "../util/playwright/stack.mjs";

// Phase 3, slice 6 (`docs/plan/phases/slices/phase-3-settings-sections/forwarding-personas.md`,
// Validation): the persona forwarding in the browser, against the isolated stack of
// `playwright.config.ts`. What only the whole stack shows: an icon picked through the real file
// chooser while the user switches personas lands on the persona that was selected when the chooser
// opened and keeps its id, so a chat bound to that persona keeps its binding across a reload (the
// phase's exit criterion); and the persona selection is per client while the personas are shared.

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
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        const { selection } = await import("/src/ts/storage/selection.svelte.ts");
        return {
            selected: selection.personaId,
            index: DBState.db.selectedPersona,
            username: DBState.db.username,
            personaPrompt: DBState.db.personaPrompt,
            list: DBState.db.personas.map((persona: any) => ({
                id: persona.id,
                name: persona.name,
                icon: persona.icon,
                personaPrompt: persona.personaPrompt,
            })),
        };
    });

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
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        const { newPersonaId } = await import("/shared/presets.ts");
        DBState.db.didFirstSetup = true;
        DBState.db.useLegacyGUI = true;
        DBState.db.personas[0].name = "U1";
        const id = newPersonaId();
        DBState.db.personas.push({ id, name: "U2", icon: "", personaPrompt: "I am two.", note: "" });
        return [DBState.db.personas[0].id, id];
    });
    await settle(page);
    return [ids[0], ids[1]];
}

test("an icon picked while another persona is selected lands on the persona the chooser opened for, and a chat bound to it keeps the binding after a reload", async ({
    page,
    baseURL,
}) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openApp(page, baseURL!);
    await settle(page);
    const [u1, u2] = await seedPersonas(page);
    await select(page, u2);

    // A character whose current chat is bound to U2 (the sidebar's bind action, by the selected id).
    const bound = await page.evaluate(async () => {
        const { DBState, selectedCharID } = await import("/src/ts/stores.svelte.ts");
        const { createNewCharacter } = await import("/src/ts/characters.ts");
        const { setChatMeta } = await import("/src/ts/storage/chatStore.svelte.ts");
        // `createNewCharacter` returns the new character's id (Phase 6 slice 8); the shim selects by index.
        const chaId = createNewCharacter();
        selectedCharID.set(DBState.db.characters.findIndex((entry) => entry.chaId === chaId));
        await new Promise((resolve) => setTimeout(resolve, 500));
        const char = DBState.db.characters.find((entry) => entry.chaId === chaId)!;
        const chat = char.chats[char.chatPage] ?? char.chats[0];
        setChatMeta(
            { chaId: char.chaId, chatId: chat.id },
            { bindedPersona: DBState.db.personas[DBState.db.selectedPersona].id },
        );
        return { chaId: char.chaId, chatId: chat.id, bindedPersona: chat.bindedPersona };
    });
    expect(bound.bindedPersona).toBe(u2);
    await settle(page);

    // The real file chooser opens for U2; the user switches to U1 while it is open, then picks a PNG.
    const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.evaluate(async () => {
            const { selectUserImg } = await import("/src/ts/persona.ts");
            (window as any).__iconDone = selectUserImg();
        }),
    ]);
    await select(page, u1);
    await chooser.setFiles({ name: "icon.png", mimeType: "image/png", buffer: PNG });
    await page.evaluate(() => (window as any).__iconDone);
    await settle(page);

    const after = await personas(page);
    expect(after.selected).toBe(u1);
    expect(after.list.map((persona) => persona.id)).toEqual([u1, u2]);
    expect(after.list[1].icon).not.toBe("");
    expect(after.list[0].icon).toBe("");
    expect(after.username).toBe("U1");

    await reload(page, baseURL!);
    const view = await personas(page);
    expect(view.selected).toBe(u1);
    expect(view.list.map((persona) => persona.id)).toEqual([u1, u2]);
    // After the reload the chat is held as its summary (Phase 6 slice 9b: boot reads summaries, and the
    // tab is at home): the binding is read from its list entry, and the persona readers resolve it
    // without loading the chat.
    const binding = await page.evaluate(async ({ chaId, chatId }) => {
        const { chatEntry, findChat } = await import("/src/ts/storage/chatStore.svelte.ts");
        const { getUserIcon, getPersonaPrompt, getUserName } = await import("/src/ts/util.ts");
        const ref = { chaId, chatId };
        return {
            loaded: findChat(ref) !== undefined,
            bindedPersona: chatEntry(ref)?.bindedPersona,
            name: getUserName(ref),
            icon: getUserIcon(ref),
            prompt: getPersonaPrompt(ref),
        };
    }, bound);
    expect(binding.loaded).toBe(false);
    expect(binding.bindedPersona).toBe(u2);
    expect(binding.name).toBe("U2");
    expect(binding.icon).toBe(view.list[1].icon);
    expect(binding.prompt).toBe("I am two.");
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
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        DBState.db.personaPrompt = "Two, edited in A.";
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

    // A plugin's `setDatabase({ selectedPersona })` is an index into the list; it selects on this
    // client only, and it survives a reload here while B is untouched.
    await pageA.evaluate(async () => {
        const { getDatabase, setDatabase } = await import("/src/ts/storage/database.svelte.ts");
        const db = getDatabase();
        db.selectedPersona = 0;
        setDatabase(db);
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
