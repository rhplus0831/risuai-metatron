import { expect, settle, test, type Page } from "./fixtures";
import { isolateContext, openApp } from "../util/playwright/stack.mjs";

// The components read the selected character as `$derived(selectedCharacter())` and the list as
// `characterList()`, the list rows carry `chaId`s, and the async handlers capture their target by
// id. In the browser, against the isolated stack:
// - the sidebar's folder menu renames the folder it was opened for while the order moves during
//   its dialog, and a color picked for a folder deleted meanwhile changes nothing;
// - a lorebook entry typed into the character editor (a nested binding through the derived record)
//   saves that character only;
// - the sidebar avatar, the grid catalog, and the mobile list select the row's character by id;
// and a reload shows what was saved. The stack's store is shared by the specs of a run: this file
// uses the characters it creates and deletes them at the end.

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

const selectedId = (page: Page) =>
    page.evaluate(async () => (await import("/src/ts/storage/selection.svelte.ts")).selection.characterId);

type OrderEntry = string | { id: string; name: string; color: string; data: string[] };

const characterOrder = (page: Page): Promise<OrderEntry[]> =>
    page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        return JSON.parse(JSON.stringify(settings.characterOrder));
    });

const setCharacterOrder = (page: Page, order: OrderEntry[]) =>
    page.evaluate(async (next) => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.characterOrder = next as any;
    }, order);

const folderOf = (order: OrderEntry[], id: string) =>
    order.find((entry): entry is Exclude<OrderEntry, string> => typeof entry !== "string" && entry.id === id);

/** The saved character record (`/api/resources` read of one character), or null. */
const savedCharacter = (page: Page, chaId: string) =>
    page.evaluate(async (id) => {
        const { readKinds } = await import("/src/ts/storage/resourceClient.ts");
        const { RESOURCE_KIND } = await import("/shared/resources.ts");
        const snapshot = await readKinds([RESOURCE_KIND.characters]);
        const record = (snapshot.kinds[RESOURCE_KIND.characters] ?? []).find((entry: any) => entry.id === id);
        return record ? JSON.parse(JSON.stringify(record.data)) : null;
    }, chaId);

test("character readers by id: folder menu, lorebook editor, and the list rows", async ({ page, baseURL }) => {
    test.setTimeout(300_000);
    const blocked = await isolateContext(page.context());
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openApp(page, baseURL!);
    await settle(page);
    await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.didFirstSetup = true;
    });
    await settle(page);

    const ids = await page.evaluate(async () => {
        const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
        const { createNewCharacter } = await import("/src/ts/characters.ts");
        const byId = (chaId: string) => characterList().find((entry) => entry.chaId === chaId)!;
        const made: Record<string, string> = {};
        for (const name of ["Alpha", "Beta", "Gamma"]) {
            made[name] = createNewCharacter();
            byId(made[name]).name = name;
        }
        return made as { Alpha: string; Beta: string; Gamma: string };
    });
    await settle(page);
    const ours = new Set(Object.values(ids));

    // --- The sidebar's folder menu. ---
    const others = (await characterOrder(page)).filter((entry) => typeof entry === "string" && !ours.has(entry));
    await setCharacterOrder(page, [
        { id: "f-one", name: "Folder One", color: "", data: [ids.Alpha] },
        { id: "f-two", name: "Folder Two", color: "", data: [ids.Beta] },
        ids.Gamma,
        ...others,
    ]);
    await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.showFolderName = true;
    });
    await settle(page);
    const folderAvatar = (name: string) => page.locator("span.avatar", { hasText: name }).first();
    await expect(folderAvatar("Folder One")).toBeVisible();

    // Rename "Folder One"; while the name dialog is open the two folders swap places.
    await folderAvatar("Folder One").click({ button: "right" });
    await page.getByRole("button", { name: "Rename Folder", exact: true }).click();
    const nameInput = page.locator("#alert-input");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue("Folder One");
    const swapped = await characterOrder(page);
    await setCharacterOrder(page, [swapped[1], swapped[0], ...swapped.slice(2)]);
    await page.waitForTimeout(300);
    await expect(
        page
            .locator("span.avatar")
            .filter({ hasText: /^Folder/ })
            .first(),
    ).toHaveText("Folder Two");
    await nameInput.fill("Renamed One");
    await page.getByRole("button", { name: "OK", exact: true }).click();
    await settle(page);
    let order = await characterOrder(page);
    expect(folderOf(order, "f-one")).toMatchObject({ name: "Renamed One", data: [ids.Alpha] });
    expect(folderOf(order, "f-two")).toMatchObject({ name: "Folder Two", data: [ids.Beta] });

    // A color picked for "Folder Two" after it was dissolved meanwhile changes no other folder.
    await folderAvatar("Folder Two").click({ button: "right" });
    await page.getByRole("button", { name: "Change Folder Color", exact: true }).click();
    await expect(page.getByRole("button", { name: "red", exact: true })).toBeVisible();
    order = await characterOrder(page);
    await setCharacterOrder(page, [
        ...order.filter((entry) => typeof entry === "string" || entry.id !== "f-two"),
        ids.Beta,
    ]);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "red", exact: true }).click();
    await settle(page);
    order = await characterOrder(page);
    expect(folderOf(order, "f-two")).toBeUndefined();
    expect(folderOf(order, "f-one")).toMatchObject({ name: "Renamed One", color: "" });
    expect(errors).toEqual([]);

    // --- The sidebar avatar selects its row's character; the indicator follows the id. ---
    await page.locator(`span.avatar[data-char-id="${ids.Gamma}"]`).click();
    await settle(page);
    expect(await selectedId(page)).toBe(ids.Gamma);

    // --- A lorebook entry typed into the editor saves that character only. ---
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        const { addLorebook } = await import("/src/ts/process/lorebook.svelte.ts");
        stores.botMakerMode.set(true);
        stores.sideBarStore.set(true);
        stores.CharConfigSubMenu.set(3);
        addLorebook(0);
    });
    await settle(page);
    const batches = trackBatches(page);
    await page.locator("button", { hasText: "New Lore 1" }).first().click();
    // The entry's prompt (`LoreBookData`'s `bind:value={value.content}`), not the chat input.
    const loreText = page
        .locator("[data-risu-idx]")
        .first()
        .locator('xpath=.//span[normalize-space()="Prompt"]/following::textarea[1]');
    await expect(loreText).toBeVisible();
    await loreText.fill("Gamma's lore, typed");
    // Leaves the field as a click elsewhere does (its `change` writes the value). Switching the
    // character while the field still has focus throws in the editor (a known editor issue).
    await loreText.blur();
    await settle(page);
    const characterOps = batches.flat().filter((op) => op.startsWith("characters/"));
    expect(characterOps.length).toBeGreaterThan(0);
    expect(new Set(characterOps)).toEqual(new Set([`characters/${ids.Gamma}`]));
    expect((await savedCharacter(page, ids.Gamma)).globalLore.map((entry: any) => entry.content)).toEqual([
        "Gamma's lore, typed",
    ]);
    expect(errors).toEqual([]);

    // --- The character catalog: its simple list (`MobileCharacters`) and its list view select by id. ---
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.botMakerMode.set(false);
    });
    const gridButton = page.locator("svg.lucide-layout-grid").first();
    const openCatalog = async () => {
        if (!(await gridButton.isVisible())) {
            // The sidebar's menu button shows the bar with the catalog's button.
            await page.locator("svg.lucide-list").first().click();
        }
        await gridButton.click();
        await expect(page.getByPlaceholder("Search")).toBeVisible();
    };
    await openCatalog();
    const alphaRow = page.locator("button", { has: page.locator("span", { hasText: /^Alpha$/ }) }).first();
    await expect(alphaRow).toBeVisible();
    await alphaRow.click();
    await settle(page);
    expect(await selectedId(page)).toBe(ids.Alpha);

    await openCatalog();
    await page.getByRole("button", { name: "List", exact: true }).click();
    const betaRow = page.locator("div.flex.p-2.border", { has: page.locator("h4", { hasText: /^Beta$/ }) }).first();
    await expect(betaRow).toBeVisible();
    await betaRow.locator("button:has(svg.lucide-square-mouse-pointer)").click();
    await settle(page);
    expect(await selectedId(page)).toBe(ids.Beta);
    await page.locator('button[title="Back"]').click();
    expect(errors).toEqual([]);

    // --- A reload shows the folder and the lore. ---
    await page.reload();
    await openApp(page, baseURL!);
    await settle(page);
    order = await characterOrder(page);
    expect(folderOf(order, "f-one")).toMatchObject({ name: "Renamed One", color: "", data: [ids.Alpha] });
    expect(folderOf(order, "f-two")).toBeUndefined();
    const reloaded = await page.evaluate(async (made) => {
        const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
        const byId = (chaId: string) => characterList().find((entry) => entry.chaId === chaId) as any;
        return byId(made.Gamma).globalLore.map((entry: any) => entry.content);
    }, ids);
    expect(reloaded).toEqual(["Gamma's lore, typed"]);

    // Leave the shared store as the next specs expect it: our characters and folder removed.
    await page.evaluate(async (made) => {
        const { removeChar } = await import("/src/ts/characters.ts");
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        for (const chaId of [made.Alpha, made.Beta, made.Gamma]) {
            await removeChar(chaId, "", "permanentForce");
        }
        settings.ui.showFolderName = false;
    }, ids);
    await settle(page);
    expect(errors).toEqual([]);
    expect(blocked.filter((href) => !/fonts\.g|cdn\.jsdelivr/.test(href))).toEqual([]);
});
