import { expect, test, type Page } from "@playwright/test";
import { isolateContext, openApp } from "../util/playwright/stack.mjs";

// Phase 6 slice 5a (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/character-ownership.md`,
// "Validation", the manual list): the characters are write-through records and `DBState.db.characters`
// is their list's wrapper, which refuses any structural write (a push, a splice, an index assignment
// of another object, a list assignment) with a `TypeError`. A UI writer the slice missed would throw
// only when its flow runs, so the flows run here in the browser, against the isolated stack of
// `playwright.config.ts`: create a character and a group, every character-settings page and accordion
// mounting through the records without an error (and, visited again, without a write), an edit through
// a bound input, the view-screen select's `updateInlayScreen` handler, the chat screen's creator-quote
// removal, trash, restore, a permanent delete, the playground character (created, then reopened), and
// a module converted to a character; then a reload shows all of it. Two tabs on a character edit are
// `util/playwright/checkLiveUpdates.mjs`'s. The stack's store is shared by every spec of a run, in file
// order: this file sorts after `idleReload.spec.ts`, which needs the store fresh.

/** Lets the save loop run: the debounce is 500 ms, and a boot pass may send more than one cycle. */
const settle = (page: Page) => page.waitForTimeout(2500);

/** The ops of every batch the page sends, as `kind/id`. */
function trackBatches(page: Page): string[][] {
    const batches: string[][] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/api/resources/batch")) {
            const body = JSON.parse(request.postData() ?? "{}") as { ops?: { kind: string; id: string }[] };
            batches.push((body.ops ?? []).map((op) => `${op.kind}/${op.id}`));
        }
    });
    return batches;
}

interface CharacterView {
    chaId: string;
    name: string;
    type: string;
    trashTime?: number;
    removedQuotes?: boolean;
    viewScreen?: string;
    chats: number;
}

const characters = (page: Page): Promise<CharacterView[]> =>
    page.evaluate(async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        return DBState.db.characters.map((entry: any) => ({
            chaId: entry.chaId,
            name: entry.name,
            type: entry.type,
            trashTime: entry.trashTime,
            removedQuotes: entry.removedQuotes,
            viewScreen: entry.viewScreen,
            chats: entry.chats.length,
        }));
    });

/** One character's view by id (earlier specs of the run may have left characters in the store). */
const characterById = async (page: Page, chaId: string) =>
    (await characters(page)).find((entry) => entry.chaId === chaId);

const selectedId = (page: Page) =>
    page.evaluate(async () => {
        const { selection } = await import("/src/ts/storage/selection.svelte.ts");
        return selection.characterId;
    });

/** Answers the app's confirmation dialogs with yes while `run` waits on them. */
async function confirmAll(page: Page, run: Promise<unknown>) {
    // `AlertComp.svelte`'s confirmation buttons are the literal YES and NO.
    const name = /^YES$/;
    let done = false;
    void run.finally(() => (done = true));
    while (!done) {
        const button = page.getByRole("button", { name });
        if ((await button.count()) > 0) {
            await button
                .first()
                .click({ timeout: 2000 })
                .catch(() => {});
        }
        await page.waitForTimeout(200);
    }
    await run;
}

test("the character flows run through the records without an error, save, and survive a reload", async ({
    page,
    baseURL,
}) => {
    test.setTimeout(300_000);
    const blocked = await isolateContext(page.context());
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openApp(page, baseURL!);
    await settle(page);
    await page.evaluate(async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        DBState.db.didFirstSetup = true;
        DBState.db.useLegacyGUI = true;
    });
    await settle(page);

    // Create a character and a group the way the sidebar's add dialog does, and open the character.
    const created = await page.evaluate(async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        const { createNewCharacter, createNewGroup, changeChar } = await import("/src/ts/characters.ts");
        const character = createNewCharacter();
        DBState.db.characters[character].name = "Alpha";
        DBState.db.characters[character].creatorNotes = "A creator quote";
        const group = createNewGroup();
        DBState.db.characters[group].name = "The group";
        await changeChar(character);
        return {
            alpha: DBState.db.characters[character].chaId,
            group: DBState.db.characters[group].chaId,
        };
    });
    await settle(page);
    expect(await selectedId(page)).toBe(created.alpha);
    let list = await characters(page);
    expect(
        [created.alpha, created.group].map((chaId) => {
            const entry = list.find((candidate) => candidate.chaId === chaId)!;
            return [entry.name, entry.type, entry.chats];
        }),
    ).toEqual([
        ["Alpha", "character", 1],
        ["The group", "group", 1],
    ]);

    // The chat screen's creator quote: its remove button writes the selected character.
    const quote = page.locator("div.bg-darkbg", { hasText: "A creator quote" }).locator("button.float-right");
    await expect(quote).toBeVisible();
    await quote.click();
    await settle(page);
    expect((await characterById(page, created.alpha))!.removedQuotes).toBe(true);
    await expect(quote).toHaveCount(0);

    // Every character-settings page (and its accordions) mounts through the records; a second visit
    // writes nothing.
    const batches = trackBatches(page);
    const visitAll = async (label: string) => {
        for (const menu of [0, 1, 3, 5, 4, 2, 6]) {
            await page.evaluate(async (index) => {
                const stores = await import("/src/ts/stores.svelte.ts");
                stores.botMakerMode.set(true);
                stores.sideBarStore.set(true);
                stores.CharConfigSubMenu.set(index);
            }, menu);
            await page.waitForTimeout(300);
            for (let round = 0; round < 2; round++) {
                const closed = page.locator("button.px-6.py-2.text-lg:not(.bg-selected):not(.rounded-md)");
                const count = await closed.count();
                for (let i = 0; i < count; i++) {
                    await closed
                        .nth(i)
                        .click({ timeout: 2000 })
                        .catch(() => {});
                }
            }
            await page.waitForTimeout(300);
            expect(errors, `${label}: menu ${menu}`).toEqual([]);
        }
        await settle(page);
    };
    await visitAll("character, first visit");
    batches.length = 0;
    await visitAll("character, second visit");
    expect(batches).toEqual([]);

    // An edit through the name input (`bind:value` on the record) is the character's own save.
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.CharConfigSubMenu.set(0);
    });
    const inputs = page.locator("input:visible");
    await expect(inputs.first()).toBeVisible();
    const at = await inputs.evaluateAll((nodes) =>
        nodes.findIndex((node) => (node as HTMLInputElement).value === "Alpha"),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    const nameInput = inputs.nth(at);
    await nameInput.fill("Alpha renamed");
    await settle(page);
    expect((await characterById(page, created.alpha))!.name).toBe("Alpha renamed");
    expect(batches.flat()).toContain(`characters/${created.alpha}`);
    expect(batches.flat().filter((op) => op.startsWith("characters/"))).toEqual(
        batches.flat().filter((op) => op === `characters/${created.alpha}`),
    );

    // The view-screen select runs `updateInlayScreen` on the record (the slice removed its list
    // self-assignment).
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.CharConfigSubMenu.set(1);
    });
    const viewScreenLabel = await page.evaluate(async () => (await import("/src/lang/index.ts")).language.viewScreen);
    await page.getByRole("button", { name: viewScreenLabel, exact: true }).first().click();
    const viewSelect = page.locator('select:has(option[value="imggen"])').first();
    await expect(viewSelect).toBeVisible();
    await viewSelect.selectOption("emotion");
    await settle(page);
    expect((await characterById(page, created.alpha))!.viewScreen).toBe("emotion");
    expect(errors).toEqual([]);

    // The group's settings pages mount too.
    await page.evaluate(async (group) => {
        const { changeChar } = await import("/src/ts/characters.ts");
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        await changeChar(DBState.db.characters.findIndex((entry: any) => entry.chaId === group));
    }, created.group);
    await settle(page);
    expect(await selectedId(page)).toBe(created.group);
    await visitAll("group");

    // Trash and restore (the character's own field), then a permanent delete of the group.
    await confirmAll(
        page,
        page.evaluate(async (chaId) => {
            const { removeChar } = await import("/src/ts/characters.ts");
            await removeChar(chaId, "Alpha renamed");
        }, created.alpha),
    );
    await settle(page);
    expect((await characterById(page, created.alpha))!.trashTime).toEqual(expect.any(Number));
    expect(await selectedId(page)).toBeNull();
    await page.evaluate(async (chaId) => {
        const { restoreChar } = await import("/src/ts/characters.ts");
        restoreChar(chaId);
    }, created.alpha);
    await settle(page);
    expect((await characterById(page, created.alpha))!.trashTime).toBeUndefined();
    await page.evaluate(async (chaId) => {
        const { removeChar } = await import("/src/ts/characters.ts");
        await removeChar(chaId, "The group", "permanentForce");
    }, created.group);
    await settle(page);
    list = await characters(page);
    expect(list.some((entry) => entry.chaId === created.group)).toBe(false);
    expect(list.some((entry) => entry.chaId === created.alpha)).toBe(true);

    // The playground's chat: its character is created the first time and reopened the second.
    for (const round of [1, 2]) {
        await page.evaluate(async () => {
            const stores = await import("/src/ts/stores.svelte.ts");
            stores.botMakerMode.set(false);
            stores.selectedCharID.set(-1);
            stores.PlaygroundStore.set(1);
        });
        const chatLabel = await page.evaluate(async () => (await import("/src/lang/index.ts")).language.Chat);
        await page
            .locator("button", { has: page.locator("h1", { hasText: chatLabel }) })
            .first()
            .click();
        await settle(page);
        expect(await selectedId(page), `playground round ${round}`).toBe("§playground");
        expect(errors, `playground round ${round}`).toEqual([]);
    }
    list = await characters(page);
    expect(list.filter((entry) => entry.chaId === "§playground")).toHaveLength(1);
    expect(list.find((entry) => entry.chaId === "§playground")!.name).toBe("assistant");
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.PlaygroundStore.set(0);
        stores.selectedCharID.set(-1);
    });

    // A module converted to a character (the module settings page's conversion mode).
    await page.evaluate(async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        DBState.db.modules.push({ name: "Module X", description: "From a module", id: "module-x" } as any);
    });
    await settle(page);
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.settingsOpen.set(true);
        stores.SettingsMenuIndex.set(14);
    });
    const content = page.locator(".rs-setting-cont-4");
    await expect(content).toBeVisible();
    const userButtons = content.locator("button:has(svg.lucide-user)");
    await userButtons.first().click();
    const row = content.locator("div.flex.items-center", { hasText: "Module X" });
    await row.locator("button:has(svg.lucide-user)").first().click();
    await settle(page);
    list = await characters(page);
    expect(list.filter((entry) => entry.name === "Module X")).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.settingsOpen.set(false);
    });
    await settle(page);

    // A reload shows everything the flows saved.
    const before = await characters(page);
    await page.reload();
    await openApp(page, baseURL!);
    await settle(page);
    const after = await characters(page);
    expect(
        after.map(({ chaId, name, type, trashTime, removedQuotes, viewScreen }) => ({
            chaId,
            name,
            type,
            trashTime,
            removedQuotes,
            viewScreen,
        })),
    ).toEqual(
        before.map(({ chaId, name, type, trashTime, removedQuotes, viewScreen }) => ({
            chaId,
            name,
            type,
            trashTime,
            removedQuotes,
            viewScreen,
        })),
    );
    expect(after.find((entry) => entry.chaId === created.alpha)).toMatchObject({
        name: "Alpha renamed",
        removedQuotes: true,
        viewScreen: "emotion",
    });
    expect(after.some((entry) => entry.chaId === created.group)).toBe(false);
    expect(await selectedId(page)).toBeNull();
    expect(errors).toEqual([]);
    expect(blocked.filter((href) => !/fonts\.g|cdn\.jsdelivr/.test(href))).toEqual([]);
});
