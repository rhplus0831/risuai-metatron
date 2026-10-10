import { expect, test, type Page } from "@playwright/test";
import { openApp } from "../util/playwright/stack.mjs";

// The closed chat: a selected character shows its closed-chat screen (its name and a button that
// opens its last selected chat) instead of its chat, and a chat opens only from that button or from
// the sidebar's chat list. While a chat is open the sidebar's chat tab shows Go Back, the author
// note, and the toggles in place of the list. The URL follows: `/chat/:chaId` closed,
// `/chat/:chaId/:chatId` open, and the browser's back closes the chat again.

/** Lets the save loop run: the debounce is 500 ms, and a boot pass may send more than one cycle. */
const settle = (page: Page) => page.waitForTimeout(3000);

const SHOTS = process.env.RISU_SHOTS;
const shot = async (page: Page, name: string) => {
    if (SHOTS) {
        await page.screenshot({ path: `${SHOTS}/${name}.png` });
    }
};

test("selecting a character shows the closed chat, the button or the list opens a chat, and Go Back and the browser's back close it", async ({
    page,
    baseURL,
}) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openApp(page, baseURL!);
    await settle(page);

    // A character with two chats; the second one ("Second") is its last selected chat.
    const { chaId, first, second } = await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        const { createNewCharacter } = await import("/src/ts/characters.ts");
        const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
        settings.ui.didFirstSetup = true;
        const chaId = createNewCharacter();
        chatStore.ensureChat(chaId);
        const created = chatStore.createChat(
            chaId,
            { message: [], note: "", name: "Second", localLore: [] },
            { index: 1, select: true },
        );
        return { chaId, first: chatStore.chatList(chaId)[0].name, second: created.id! };
    });
    await settle(page);

    // What the sidebar, the grid, and the home cards call.
    await page.evaluate(async (id) => {
        const { changeChar } = await import("/src/ts/characters.ts");
        await changeChar(id);
    }, chaId);
    const openButton = page.getByRole("button", { name: /Open most recent chat/ });
    await expect(openButton).toBeVisible();
    await expect(openButton).toContainText("Second");
    await expect(page.locator(".default-chat-screen")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/chat/${chaId}$`));
    await shot(page, "1-closed");

    await openButton.click();
    await expect(page.locator(".default-chat-screen")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/chat/${chaId}/${second}$`));
    const goBack = page.getByRole("button", { name: "Go Back" });
    await expect(goBack).toBeVisible();
    await expect(page.getByText("Author's Note").first()).toBeVisible();
    await shot(page, "2-open");

    // The browser's back closes the chat; forward opens it again.
    await page.goBack();
    await expect(openButton).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/chat/${chaId}$`));
    await page.goForward();
    await expect(page.locator(".default-chat-screen")).toBeVisible();

    // Go Back shows the list again; a row of the list opens that chat.
    await goBack.click();
    await expect(openButton).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/chat/${chaId}$`));
    await shot(page, "3-list");
    await page.getByRole("button", { name: first }).first().click();
    await expect(page.locator(".default-chat-screen")).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(`/chat/${chaId}/${second}$`));

    // A reload keeps the open chat; selecting the character again from home shows the closed chat.
    await page.reload();
    await expect(page.locator(".default-chat-screen")).toBeVisible({ timeout: 60_000 });
    await expect(page).not.toHaveURL(new RegExp(`/chat/${chaId}$`));
    await page.evaluate(async (id) => {
        const { selectCharacter } = await import("/src/ts/storage/selection.svelte.ts");
        const { changeChar } = await import("/src/ts/characters.ts");
        selectCharacter(null);
        await changeChar(id);
    }, chaId);
    await expect(openButton).toBeVisible();

    expect(errors).toEqual([]);
});

test("a character hotkey from the focused author note leaves the destination chat's note alone, after a reload too", async ({
    page,
    baseURL,
}) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openApp(page, baseURL!);
    await settle(page);

    // Two characters next to each other by name (the hotkeys go by name), each with its own note.
    const ids = await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        const { createNewCharacter, changeChar } = await import("/src/ts/characters.ts");
        const { updateCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
        const chatStore = await import("/src/ts/storage/chatStore.svelte.ts");
        settings.ui.didFirstSetup = true;
        const a = createNewCharacter();
        updateCharacter(a, { name: "ZZ Note A" });
        const b = createNewCharacter();
        updateCharacter(b, { name: "ZZ Note B" });
        const ac = chatStore.chatList(a)[0].id;
        const bc = chatStore.chatList(b)[0].id;
        chatStore.setChatMeta({ chaId: a, chatId: ac }, { note: "A original" });
        chatStore.setChatMeta({ chaId: b, chatId: bc }, { note: "B original" });
        await changeChar(a);
        return { a, ac, b, bc };
    });
    await settle(page);
    await page.getByRole("button", { name: /Open most recent chat/ }).click();
    const note = page.locator("textarea:not(.input-text)").first();
    await expect(note).toHaveValue("A original");
    await note.fill("A edited");
    // The field keeps the focus: the hotkey removes it while B is already selected.
    await page.keyboard.press("Control+]");
    await expect(page).toHaveURL(new RegExp(`/chat/${ids.b}$`));
    const notes = () =>
        page.evaluate(async ({ a, ac, b, bc }) => {
            const { findChat } = await import("/src/ts/storage/chatStore.svelte.ts");
            return [findChat({ chaId: a, chatId: ac })?.note, findChat({ chaId: b, chatId: bc })?.note];
        }, ids);
    expect(await notes()).toEqual(["A edited", "B original"]);
    await settle(page);

    // B's chat is the selected chat after the reload (the closed chat loads it).
    await page.reload();
    await expect(page.getByRole("button", { name: /Open most recent chat/ })).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(() =>
            page.evaluate(async () => (await import("/src/ts/storage/chatStore.svelte.ts")).selectedChat()?.note),
        )
        .toBe("B original");
    expect(errors).toEqual([]);
});
