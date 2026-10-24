import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { loreBook } from "../shared/database.ts";
import { clearSafeBootAttempts, isolateContext, openApp, openCharacterChat } from "../util/playwright/stack.mjs";

// The real lorebook editor, save loop, reload, and composer against the isolated stack.
// The shared store keeps its existing bindings; this test owns and deletes one character.
type ChatRef = { chaId: string; chatId: string };

async function flush(page: Page) {
    const result = await page.evaluate(async () => {
        const { flushResources } = await import("/src/ts/storage/resourceSync.svelte.ts");
        return flushResources();
    });
    expect(result.discarded).toEqual([]);
}

const saved = (page: Page, ref: ChatRef) =>
    page.evaluate(async (ref) => {
        const { readRefs } = await import("/src/ts/storage/resourceClient.ts");
        const result = await readRefs([{ kind: "characters", id: ref.chaId }], {
            chats: [{ characterId: ref.chaId, id: ref.chatId }],
        });
        return { character: result.items[0].data, chat: result.chats![0].data };
    }, ref);

async function openLoreEditor(page: Page) {
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.botMakerMode.set(true);
        stores.sideBarStore.set(true);
        stores.CharConfigSubMenu.set(3);
    });
}

test("a pinned lore copy survives reload and deleting its original refuses send without consuming the composer", async ({
    page,
    baseURL,
}) => {
    test.setTimeout(180_000);
    const blocked = await isolateContext(page.context());
    await clearSafeBootAttempts(page.context());
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openApp(page, baseURL!);

    const originalUi = await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        return { didFirstSetup: settings.ui.didFirstSetup, useLegacyGUI: settings.ui.useLegacyGUI };
    });
    const chaId = await page.evaluate(async () => {
        const { createNewCharacter } = await import("/src/ts/characters.ts");
        return createNewCharacter();
    });
    const source: loreBook = {
        id: randomUUID(),
        comment: "Pinned dragon lore",
        key: "dragon",
        secondkey: "",
        content: "The dragon guards the original library.",
        mode: "normal",
        alwaysActive: true,
        selective: false,
        useRegex: false,
        insertorder: 100,
        bookVersion: 2,
    };
    const editedPrompt = "In this chat the dragon guards a floating garden.";

    try {
        const { ref, labels } = await page.evaluate(
            async ({ chaId, source }) => {
                const { language } = await import("/src/lang/index.ts");
                const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
                const { chatList, setChatMeta } = await import("/src/ts/storage/chatStore.svelte.ts");
                const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
                const { selectCharacter } = await import("/src/ts/storage/selection.svelte.ts");
                const { chatBinding } = await import("/src/ts/storage/chatBinding.svelte.ts");
                settings.ui.didFirstSetup = true;
                settings.ui.useLegacyGUI = true;
                const character = characterList().find((entry) => entry.chaId === chaId)!;
                character.name = `Lore overrides ${chaId.slice(0, 8)}`;
                character.globalLore = [source];
                const ref = { chaId, chatId: chatList(chaId)[0].id };
                // All three bindings are explicit, as in the send fixtures. No generation should run.
                setChatMeta(ref, {
                    modelPresetId: settings.modelPresets[0].id,
                    promptPresetId: settings.presets[0].id,
                    bindedPersona: settings.personas[0].id,
                });
                if (!chatBinding(ref)?.ok) throw new Error("The seeded chat must have a complete binding");
                selectCharacter(null);
                return {
                    ref,
                    labels: {
                        character: language.character,
                        chat: language.Chat,
                        settings: language.settings,
                        ...language.chatLoreOverrides,
                    },
                };
            },
            { chaId, source },
        );
        await flush(page);
        await openCharacterChat(page, chaId);
        await expect(page.locator(".default-chat-screen")).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/chat/${chaId}/${ref.chatId}`));
        await openLoreEditor(page);

        // Scope Chat to the Character/Chat/Settings row, away from the app's other Chat controls.
        const tabs = page
            .locator("div.flex.w-full.rounded-md.border.border-selected")
            .filter({ has: page.getByRole("button", { name: labels.character, exact: true }) })
            .filter({ has: page.getByRole("button", { name: labels.settings, exact: true }) });
        await tabs.getByRole("button", { name: labels.chat, exact: true }).click();
        const accordion = page.getByRole("button", { name: labels.title, exact: true });
        await expect(accordion).toHaveAttribute("aria-expanded", "false");
        await accordion.click();
        const section = accordion.locator("..");
        const pin = section.locator("label").filter({ hasText: labels.pin });
        await pin.click();
        await expect(pin.locator('input[type="checkbox"]')).toBeChecked();
        await section.getByRole("button", { name: source.comment, exact: true }).click();
        const prompt = section.locator("textarea");
        await expect(prompt).toHaveValue(source.content);
        await prompt.fill(editedPrompt);
        await prompt.blur();
        await flush(page);
        const expectedOverride = { entry: { ...source, content: editedPrompt }, off: false };
        const beforeReload = await saved(page, ref);
        expect(beforeReload.chat!.loreOverrides).toEqual([expectedOverride]);
        expect(beforeReload.character).toMatchObject({ globalLore: [source] });

        await page.reload();
        await expect(page.locator(".default-chat-screen")).toBeVisible();
        expect(
            await page.evaluate(async () => {
                const { currentChatRef } = await import("/src/ts/storage/chatStore.svelte.ts");
                return currentChatRef();
            }),
        ).toEqual(ref);
        expect((await saved(page, ref)).chat!.loreOverrides).toEqual([expectedOverride]);
        await openLoreEditor(page);
        await tabs.getByRole("button", { name: labels.chat, exact: true }).click();
        await accordion.click();
        await expect(pin.locator('input[type="checkbox"]')).toBeChecked();
        await section.getByRole("button", { name: source.comment, exact: true }).click();
        await expect(prompt).toHaveValue(editedPrompt);

        await tabs.getByRole("button", { name: labels.character, exact: true }).click();
        const originalRow = page
            .locator("[data-risu-idx]")
            .filter({ has: page.getByRole("button", { name: source.comment, exact: true }) });
        await originalRow.locator(":scope > div > button").last().click();
        await page.locator("[data-alert-dialog]").getByRole("button", { name: "YES", exact: true }).click();
        await expect(originalRow).toHaveCount(0);
        await flush(page);
        const orphaned = await saved(page, ref);
        expect(orphaned.character).toMatchObject({ globalLore: [] });
        expect(orphaned.chat!.loreOverrides).toEqual([expectedOverride]);
        await tabs.getByRole("button", { name: labels.chat, exact: true }).click();
        await expect(accordion).toHaveAttribute("aria-expanded", "true");
        await expect(section).toContainText(labels.originalDeleted);

        await page.evaluate(async () => {
            const stores = await import("/src/ts/stores.svelte.ts");
            stores.botMakerMode.set(false);
            stores.sideBarStore.set(false);
        });
        const composer = page.locator("textarea.input-text").first();
        const unsent = "Tell me what the dragon is guarding.";
        await composer.fill(unsent);
        await page.locator("button.button-icon-send").click();
        await expect(page.locator("[data-alert-dialog]")).toContainText(labels.refused);
        await expect(composer).toHaveValue(unsent);
        expect(
            await page.evaluate(async (ref) => {
                const { findChat } = await import("/src/ts/storage/chatStore.svelte.ts");
                return JSON.parse(JSON.stringify(findChat(ref)!.message));
            }, ref),
        ).toEqual(orphaned.chat!.message);
        await flush(page);
        expect((await saved(page, ref)).chat!.message).toEqual(orphaned.chat!.message);
        expect(errors).toEqual([]);
        expect(blocked.filter((url) => !/fonts\.g|cdn\.jsdelivr/.test(url))).toEqual([]);
    } finally {
        // Runs on assertion failure too: later specs share this stack's store.
        await page.evaluate(
            async ({ chaId, originalUi }) => {
                const { removeChar } = await import("/src/ts/characters.ts");
                const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
                await removeChar(chaId, "", "permanentForce");
                settings.ui.didFirstSetup = originalUi.didFirstSetup;
                settings.ui.useLegacyGUI = originalUi.useLegacyGUI;
            },
            { chaId, originalUi },
        );
        await flush(page);
    }
});
