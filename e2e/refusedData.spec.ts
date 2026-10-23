import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openApp } from "../util/playwright/stack.mjs";

// Refused local edits remain visible in DefaultChatScreen, Sidebar and MainMenu and can be
// downloaded through RefusedDataBanner's real export dialog without a successful server save.
test("a refused chat stays badged and its banner exports the locally edited message as JSON", async ({
    page,
    baseURL,
}) => {
    await openApp(page, baseURL!);
    const fixture = await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        const { recordData } = await import("/src/ts/storage/records.svelte.ts");
        const { createNewCharacter, changeChar } = await import("/src/ts/characters.ts");
        const { updateCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
        const { chatList, appendMessage, setChatMeta } = await import("/src/ts/storage/chatStore.svelte.ts");
        const { flushResources } = await import("/src/ts/storage/resourceSync.svelte.ts");
        const originals = JSON.parse(JSON.stringify({ ui: recordData("ui"), order: recordData("characterOrder") }));
        settings.ui.didFirstSetup = true;
        settings.ui.language = "en";
        settings.ui.theme = "standard";
        const chaId = createNewCharacter();
        updateCharacter(chaId, { name: "Refused export character", firstMessage: "" });
        const chatId = chatList(chaId)[0].id;
        const ref = { chaId, chatId };
        setChatMeta(ref, { name: "Refused export chat", pinned: true });
        appendMessage(ref, { role: "user", data: "Original saved message", chatId: "refused-export-message" });
        const folderId = crypto.randomUUID();
        settings.characterOrder = [
            ...settings.characterOrder.filter((entry) => entry !== chaId),
            { type: "folder", id: folderId, name: "Refused export folder", color: "blue", data: [chaId] },
        ];
        await flushResources();
        await changeChar(chaId);
        return { chaId, chatId, originals };
    });

    const batchUrl = "**/api/resources/batch";
    let refusedRequests = 0;
    await page.route(batchUrl, async (route) => {
        const request = route.request();
        if (request.method() !== "POST") return route.continue();
        const body = request.postDataJSON() as { chats?: { characterId: string; chatId: string }[] };
        const index =
            body.chats?.findIndex((chat) => chat.characterId === fixture.chaId && chat.chatId === fixture.chatId) ?? -1;
        if (index < 0) return route.continue();
        refusedRequests += 1;
        await route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({ error: `chats[${index}]: refused for test` }),
        });
    });

    try {
        await page.getByRole("button", { name: /Open most recent chat/ }).click();
        const message = page.locator('.risu-chat[data-chat-id="refused-export-message"]');
        await expect(message).toContainText("Original saved message");
        await message.locator(".button-icon-edit").click();
        const localText = "Locally edited text preserved despite the server refusal.";
        await message.locator("textarea").fill(localText);
        await message.locator(".button-icon-edit").click();

        const refusalAlert = page.locator("[data-alert-dialog]");
        await expect(refusalAlert).toContainText("refused for test");
        await refusalAlert.getByRole("button", { name: "OK", exact: true }).click();
        expect(refusedRequests).toBeGreaterThan(0);
        const banner = page.locator('[data-risu-refused-banner="chat"]');
        await expect(banner).toBeVisible();
        await expect(banner.locator("[data-risu-refused-reason]")).toContainText("refused for test");
        await expect(page.locator('[data-risu-refused-banner="app"]')).toHaveCount(0);

        const downloadPromise = page.waitForEvent("download");
        await banner.locator('[data-risu-refused-action="export"]').click();
        await page.getByRole("button", { name: "Export as JSON", exact: true }).click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/\.json$/);
        const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
        expect(exported.data.message).toEqual(expect.arrayContaining([expect.objectContaining({ data: localText })]));
        await page.getByRole("button", { name: "OK", exact: true }).click();
        await expect(banner).toBeVisible();

        const badge = '[role="status"][data-risu-chat-status="refused"]';
        await expect(page.locator(`[data-risu-pinned-chat="${fixture.chatId}"]`).locator(badge)).toBeVisible();
        // The status is also part of the folder row's own accessible name.
        const collapsedFolder = page.getByRole("button", { name: /^Refused export folder ·/ });
        await expect(collapsedFolder.locator(badge)).toBeVisible();
        await collapsedFolder.locator('span[role="button"]').click();
        const characterRow = page
            .locator(`div[role="button"][tabindex="0"]:has([data-char-id="${fixture.chaId}"])`)
            .first();
        await expect(characterRow.locator(badge)).toBeVisible();

        await page.evaluate(async () => {
            const { selectCharacter } = await import("/src/ts/storage/selection.svelte.ts");
            selectCharacter(null);
        });
        await expect(page.locator(`[data-risu-home-pinned-chat="${fixture.chatId}"]`).locator(badge)).toBeVisible();
        const appBanner = page.locator('[data-risu-refused-banner="app"]');
        await expect(appBanner).toBeVisible();
        await appBanner.locator("[data-risu-refused-toggle]").click();
        await expect(appBanner.locator('[data-risu-refused-kind="chat"]')).toContainText("refused for test");
    } finally {
        await page.unroute(batchUrl);
        await page.evaluate(async ({ chaId, originals }) => {
            const { selectCharacter } = await import("/src/ts/storage/selection.svelte.ts");
            const { removeCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
            const { replaceRecord } = await import("/src/ts/storage/records.svelte.ts");
            const { flushResources } = await import("/src/ts/storage/resourceSync.svelte.ts");
            selectCharacter(null);
            removeCharacter(chaId);
            replaceRecord("ui", originals.ui);
            replaceRecord("characterOrder", originals.order);
            await flushResources();
        }, fixture);
    }
});
