import { expect, test, type Page } from "@playwright/test";
import { openApp } from "../util/playwright/stack.mjs";

// Phase 3, slice 5 (`docs/plan/phases/slices/phase-3-settings-sections/forwarding-presets-and-selection.md`,
// Validation): the forwarding layer and the per-client selection in the browser, against the
// isolated stack of `playwright.config.ts`. Two things only the whole stack shows: an edit made in
// the real settings UI followed by a hotkey switch in the same interaction lands in the preset that
// was selected and survives a reload, and the selection is per client (a browser context) and per
// tab (`sessionStorage`), while the presets themselves are shared through the server.

/** Lets the save loop run: the debounce is 500 ms, and a boot pass may send more than one cycle. */
const settle = (page: Page) => page.waitForTimeout(3000);

interface PresetView {
    selected: string;
    list: { id: string; name: string; temperature: number; maxResponse: number }[];
}

const presets = (page: Page): Promise<PresetView> =>
    page.evaluate(async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        const { selection } = await import("/src/ts/storage/selection.svelte.ts");
        return {
            selected: selection.presetId,
            list: DBState.db.botPresets.map((preset: any) => ({
                id: preset.id,
                name: preset.name,
                temperature: preset.temperature,
                maxResponse: preset.maxResponse,
            })),
        };
    });

const select = (page: Page, id: string) =>
    page.evaluate(async (presetId) => {
        const { changeToPreset } = await import("/src/ts/storage/database.svelte.ts");
        changeToPreset(presetId, false);
    }, id);

async function reload(page: Page, baseURL: string) {
    await page.reload();
    await openApp(page, baseURL);
    await settle(page);
}

/** The first boot of the store: skips the onboarding, names the default preset P1, and adds P2. */
async function seedPresets(page: Page): Promise<[string, string]> {
    const ids = await page.evaluate(async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        const { normalizePreset } = await import("/shared/presets.ts");
        DBState.db.didFirstSetup = true;
        DBState.db.useLegacyGUI = true;
        DBState.db.botPresets[0].name = "P1";
        DBState.db.botPresets.push(normalizePreset({ name: "P2", temperature: 50, maxResponse: 555 }));
        return DBState.db.botPresets.map((preset: any) => preset.id);
    });
    await settle(page);
    return [ids[0], ids[1]];
}

test("an edit in Bot Settings followed by a hotkey switch while the input has focus lands in the preset that was selected", async ({
    page,
    baseURL,
}) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openApp(page, baseURL!);
    await settle(page);
    const [p1, p2] = await seedPresets(page);
    await select(page, p2);

    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.settingsOpen.set(true);
        stores.SettingsMenuIndex.set(1);
    });
    // The declarative `SettingNumber` of Max Response Size: the label span, then its input.
    const input = page
        .locator(
            'xpath=//span[starts-with(normalize-space(.), "Max Response Size")]/following-sibling::*[1]/descendant-or-self::input',
        )
        .first();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("555");

    await input.click();
    await input.fill("777");
    await page.keyboard.press("Control+1");
    // The switch re-rendered the same input with P1's value.
    await expect(input).toHaveValue("500");
    await settle(page);

    await page.evaluate(async () => (await import("/src/ts/stores.svelte.ts")).settingsOpen.set(false));
    await reload(page, baseURL!);
    const after = await presets(page);
    expect(after.selected).toBe(p1);
    expect(after.list.find((preset) => preset.id === p2)?.maxResponse).toBe(777);
    expect(after.list.find((preset) => preset.id === p1)?.maxResponse).toBe(500);
    expect(errors).toEqual([]);
});

test("two clients keep their own selection across reloads, and so do two tabs of one client", async ({
    browser,
    baseURL,
}) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await openApp(pageA, baseURL!);
    await settle(pageA);
    const [p1, p2] = await seedPresets(pageA);
    await select(pageA, p1);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await openApp(pageB, baseURL!);
    await settle(pageB);
    await select(pageB, p2);
    expect((await presets(pageB)).selected).toBe(p2);

    // A's edit of a forwarded field goes to A's preset; B sees it in P1 after a reload and is still on P2.
    await pageA.evaluate(async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        DBState.db.temperature = 61;
    });
    await settle(pageA);
    await reload(pageB, baseURL!);
    const viewB = await presets(pageB);
    expect(viewB.selected).toBe(p2);
    expect(viewB.list.find((preset) => preset.id === p1)?.temperature).toBe(61);
    expect(viewB.list.find((preset) => preset.id === p2)?.temperature).toBe(50);
    await reload(pageA, baseURL!);
    expect((await presets(pageA)).selected).toBe(p1);

    // Two tabs of one client: each keeps its own selection across a reload; a new tab starts from
    // the last choice made in any tab.
    const tabA2 = await contextA.newPage();
    await openApp(tabA2, baseURL!);
    await settle(tabA2);
    expect((await presets(tabA2)).selected).toBe(p1);
    await select(tabA2, p2);
    await reload(pageA, baseURL!);
    await reload(tabA2, baseURL!);
    expect((await presets(pageA)).selected).toBe(p1);
    expect((await presets(tabA2)).selected).toBe(p2);
    const tabA3 = await contextA.newPage();
    await openApp(tabA3, baseURL!);
    await settle(tabA3);
    expect((await presets(tabA3)).selected).toBe(p2);

    await contextA.close();
    await contextB.close();
});
