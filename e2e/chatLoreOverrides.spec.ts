import http from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { loreBook } from "../shared/database.ts";
import { clearSafeBootAttempts, isolateContext, openApp, openCharacterChat } from "../util/playwright/stack.mjs";

// The real lorebook editor, save loop, reload, and composer against the isolated stack.
// The shared store keeps its existing bindings; each test owns and deletes one character.
// The second test sends to a local mock provider, so it also points the first model preset's main
// profile at it and puts the profile back at the end (the specs after this one share the store).
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

async function closeSidebar(page: Page) {
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.botMakerMode.set(false);
        stores.sideBarStore.set(false);
    });
}

const lore = (comment: string, extra: Partial<loreBook> = {}): loreBook => ({
    id: randomUUID(),
    comment,
    key: comment.toLowerCase().replace(/\s+/g, "-"),
    secondkey: "",
    content: `${comment} content`,
    mode: "normal",
    alwaysActive: true,
    selective: false,
    useRegex: false,
    insertorder: 100,
    bookVersion: 2,
    ...extra,
});

/** The Character/Chat/Settings row of the lorebook editor, away from the app's other Chat controls. */
function editorTabs(page: Page, labels: { character: string; settings: string }) {
    return page
        .locator("div.flex.w-full.rounded-md.border.border-selected")
        .filter({ has: page.getByRole("button", { name: labels.character, exact: true }) })
        .filter({ has: page.getByRole("button", { name: labels.settings, exact: true }) });
}

/** Opens the editor's Chat tab with the overrides section expanded; returns the section. */
async function openOverrides(page: Page, labels: { character: string; chat: string; settings: string; title: string }) {
    await openLoreEditor(page);
    await editorTabs(page, labels).getByRole("button", { name: labels.chat, exact: true }).click();
    const accordion = page.getByRole("button", { name: labels.title, exact: true });
    if ((await accordion.getAttribute("aria-expanded")) === "false") await accordion.click();
    await expect(accordion).toHaveAttribute("aria-expanded", "true");
    return accordion.locator("..");
}

/** The segment `label` of the state control named for `name`. */
const segment = (section: Locator, name: string, label: string) =>
    section.getByRole("group", { name, exact: true }).getByRole("button", { name: label, exact: true });

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
    const source = lore("Pinned dragon lore", { key: "dragon", content: "The dragon guards the original library." });
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
                const strings = language.chatLoreOverrides;
                // Functions do not cross `evaluate`: the control's name is computed here.
                return {
                    ref,
                    labels: {
                        character: language.character,
                        chat: language.Chat,
                        settings: language.settings,
                        title: strings.title,
                        overridden: strings.overridden,
                        originalDeleted: strings.originalDeleted,
                        refused: strings.refused,
                        sourceState: strings.stateFor(source.comment),
                    },
                };
            },
            { chaId, source },
        );
        await flush(page);
        await openCharacterChat(page, chaId);
        await expect(page.locator(".default-chat-screen")).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/chat/${chaId}/${ref.chatId}`));
        const tabs = editorTabs(page, labels);
        const section = await openOverrides(page, labels);
        const overridden = segment(section, labels.sourceState, labels.overridden);
        await expect(overridden).toHaveAttribute("aria-pressed", "false");
        await overridden.click();
        await expect(overridden).toHaveAttribute("aria-pressed", "true");
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
        await openOverrides(page, labels);
        await expect(overridden).toHaveAttribute("aria-pressed", "true");
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
        await expect(page.getByRole("button", { name: labels.title, exact: true })).toHaveAttribute(
            "aria-expanded",
            "true",
        );
        await expect(section).toContainText(labels.originalDeleted);

        await closeSidebar(page);
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

test("an off folder drops its members from the prompt, entries added later included, and on brings them back", async ({
    page,
    baseURL,
}) => {
    test.setTimeout(240_000);
    // A local mock provider that records every request it gets.
    const requests: string[] = [];
    const provider = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const chunk of req) parts.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
        requests.push(JSON.stringify(body));
        if (body.stream === true) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Mock reply." } }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Mock reply." } }] }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
    /** The provider request that carried the user message `text`. */
    const requestWith = async (text: string) => {
        await expect.poll(() => requests.filter((body) => body.includes(text)).length, { timeout: 30_000 }).toBe(1);
        return requests.find((body) => body.includes(text))!;
    };

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
    const folderKey = `folder:${randomUUID()}`;
    const folder = lore("Guild folder", { key: folderKey, content: "", mode: "folder", alwaysActive: false });
    const member = lore("Guild member", { folder: folderKey, content: "MEMBER-LORE the guild meets at the mill." });
    const captain = lore("Guild captain", { folder: folderKey, content: "CAPTAIN-LORE-ORIGINAL leads the guild." });
    const secret = lore("Guild secret", { folder: folderKey, content: "SECRET-LORE the vault is under the mill." });
    const outside = lore("Outside lore", { content: "OUTSIDE-LORE the river runs north." });
    const added = lore("Added later", { folder: folderKey, content: "ADDED-LORE joined after the folder went off." });
    const captainEdited = "CAPTAIN-LORE-EDITED leads the guild in this chat only.";
    let profileBefore: Record<string, unknown> | null = null;

    try {
        const { ref, labels, profile } = await page.evaluate(
            async ({ chaId, globalLore, providerUrl }) => {
                const { language } = await import("/src/lang/index.ts");
                const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
                const { chatList, setChatMeta } = await import("/src/ts/storage/chatStore.svelte.ts");
                const { settings, modelProfileRecordForSlot } = await import("/src/ts/storage/settingsViews.svelte.ts");
                const { selectCharacter } = await import("/src/ts/storage/selection.svelte.ts");
                const { chatBinding } = await import("/src/ts/storage/chatBinding.svelte.ts");
                settings.ui.didFirstSetup = true;
                settings.ui.useLegacyGUI = true;
                // The first model preset's main profile sends to the mock (the chats bind that preset).
                const profile = modelProfileRecordForSlot(settings.modelPresets[0].mainSlot)!;
                const before = JSON.parse(JSON.stringify(profile));
                Object.assign(profile, {
                    modelId: "reverse_proxy",
                    forceReplaceUrl: providerUrl,
                    customProxyRequestModel: "mock",
                });
                const character = characterList().find((entry) => entry.chaId === chaId)!;
                character.name = `Lore folder ${chaId.slice(0, 8)}`;
                character.globalLore = globalLore;
                const ref = { chaId, chatId: chatList(chaId)[0].id };
                setChatMeta(ref, {
                    modelPresetId: settings.modelPresets[0].id,
                    promptPresetId: settings.presets[0].id,
                    bindedPersona: settings.personas[0].id,
                });
                if (!chatBinding(ref)?.ok) throw new Error("The seeded chat must have a complete binding");
                selectCharacter(null);
                const strings = language.chatLoreOverrides;
                const [folder, , captain, secret] = globalLore;
                return {
                    ref,
                    profile: before,
                    labels: {
                        character: language.character,
                        chat: language.Chat,
                        settings: language.settings,
                        title: strings.title,
                        on: strings.on,
                        off: strings.off,
                        overridden: strings.overridden,
                        notApplied: strings.notApplied,
                        folderOffNotice: strings.folderOffNotice,
                        folderState: strings.stateFor(folder.comment),
                        captainState: strings.stateFor(captain.comment),
                        secretState: strings.stateFor(secret.comment),
                        changedThree: strings.changed(3),
                    },
                };
            },
            { chaId, globalLore: [folder, member, captain, secret, outside], providerUrl },
        );
        profileBefore = profile;
        await flush(page);
        await openCharacterChat(page, chaId);
        await expect(page.locator(".default-chat-screen")).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/chat/${chaId}/${ref.chatId}`));

        const send = async (text: string, replies: number) => {
            await closeSidebar(page);
            const composer = page.locator("textarea.input-text").first();
            await composer.fill(text);
            await page.locator("button.button-icon-send").click();
            await expect(page.locator(".risu-chat").filter({ hasText: "Mock reply." })).toHaveCount(replies, {
                timeout: 30_000,
            });
            return requestWith(text);
        };

        // One member edited in this chat, one turned off; the folder itself is on. Members show once
        // their folder is expanded (the sidebar remounts the rows collapsed each time it opens).
        let section = await openOverrides(page, labels);
        await section.getByRole("button", { name: folder.comment, exact: true }).click();
        await segment(section, labels.captainState, labels.overridden).click();
        await expect(segment(section, labels.captainState, labels.overridden)).toHaveAttribute("aria-pressed", "true");
        await section.getByRole("button", { name: captain.comment, exact: true }).click();
        const prompt = section.locator("textarea");
        await expect(prompt).toHaveValue(captain.content);
        await prompt.fill(captainEdited);
        await prompt.blur();
        await segment(section, labels.secretState, labels.off).click();
        await expect(segment(section, labels.secretState, labels.off)).toHaveAttribute("aria-pressed", "true");
        await flush(page);
        const first = await send("First send", 1);
        expect(first).toContain("MEMBER-LORE");
        expect(first).toContain("CAPTAIN-LORE-EDITED");
        expect(first).not.toContain("CAPTAIN-LORE-ORIGINAL");
        expect(first).not.toContain("SECRET-LORE");
        expect(first).toContain("OUTSIDE-LORE");

        // The folder off: its members leave the prompt, the entry added afterwards included.
        section = await openOverrides(page, labels);
        const folderControl = section.getByRole("group", { name: labels.folderState, exact: true });
        await expect(folderControl.getByRole("button", { name: labels.on, exact: true })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        await folderControl.getByRole("button", { name: labels.off, exact: true }).click();
        await expect(folderControl.getByRole("button", { name: labels.off, exact: true })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        await expect(section).toContainText(labels.notApplied);
        await flush(page);
        const afterOff = await saved(page, ref);
        expect(afterOff.chat!.loreOverrides).toEqual([
            { entry: { ...captain, content: captainEdited }, off: false },
            { entry: secret, off: true },
            { entry: folder, off: true },
        ]);
        await page.evaluate(
            async ({ chaId, added }) => {
                const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
                characterList()
                    .find((entry) => entry.chaId === chaId)!
                    .globalLore.push(added);
            },
            { chaId, added },
        );
        await flush(page);
        const second = await send("Second send", 2);
        expect(second).not.toContain("MEMBER-LORE");
        expect(second).not.toContain("CAPTAIN-LORE");
        expect(second).not.toContain("SECRET-LORE");
        expect(second).not.toContain("ADDED-LORE");
        expect(second).toContain("OUTSIDE-LORE");

        // On again: the members return as they were, the edited copy and the off member included.
        section = await openOverrides(page, labels);
        await section.getByRole("button", { name: folder.comment, exact: true }).click();
        await expect(section).toContainText(labels.folderOffNotice);
        await folderControl.getByRole("button", { name: labels.on, exact: true }).click();
        await expect(folderControl.getByRole("button", { name: labels.on, exact: true })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        await expect(section).not.toContainText(labels.folderOffNotice);
        await expect(section).not.toContainText(labels.notApplied);
        await expect(segment(section, labels.captainState, labels.overridden)).toHaveAttribute("aria-pressed", "true");
        await expect(segment(section, labels.secretState, labels.off)).toHaveAttribute("aria-pressed", "true");
        await flush(page);
        expect((await saved(page, ref)).chat!.loreOverrides).toEqual([
            { entry: { ...captain, content: captainEdited }, off: false },
            { entry: secret, off: true },
        ]);
        const third = await send("Third send", 3);
        expect(third).toContain("MEMBER-LORE");
        expect(third).toContain("CAPTAIN-LORE-EDITED");
        expect(third).not.toContain("CAPTAIN-LORE-ORIGINAL");
        expect(third).not.toContain("SECRET-LORE");
        expect(third).toContain("ADDED-LORE");
        expect(third).toContain("OUTSIDE-LORE");
        expect(requests).toHaveLength(3);
        expect(errors).toEqual([]);
        expect(blocked.filter((url) => !/fonts\.g|cdn\.jsdelivr/.test(url))).toEqual([]);
    } finally {
        // Runs on assertion failure too: later specs share this stack's store and the model profile.
        await page.evaluate(
            async ({ chaId, originalUi, profileBefore }) => {
                const { removeChar } = await import("/src/ts/characters.ts");
                const { settings, modelProfileRecordForSlot } = await import("/src/ts/storage/settingsViews.svelte.ts");
                await removeChar(chaId, "", "permanentForce");
                settings.ui.didFirstSetup = originalUi.didFirstSetup;
                settings.ui.useLegacyGUI = originalUi.useLegacyGUI;
                if (profileBefore) {
                    const profile = modelProfileRecordForSlot(settings.modelPresets[0].mainSlot)!;
                    for (const key of Object.keys(profile)) {
                        if (!(key in profileBefore)) delete (profile as Record<string, unknown>)[key];
                    }
                    Object.assign(profile, profileBefore);
                }
            },
            { chaId, originalUi, profileBefore },
        );
        await flush(page);
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
    }
});
