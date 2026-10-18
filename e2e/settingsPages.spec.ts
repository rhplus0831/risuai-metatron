import { expect, test, type Page } from "@playwright/test";
import { isolateContext, openApp } from "../util/playwright/stack.mjs";

// Phase 6 slice 4 (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/settings-ownership.md`,
// "Validation", the manual check "every settings page still loads and saves through the facade"): the
// settings records are the source of truth and the settings views (`settingsViews.svelte.ts`) read and
// write them, so every settings page reads and binds through record wrappers. Each page (and, in the legacy GUI, every
// accordion it holds) mounts without a page error and without writing anything; an edit made through
// the page's own controls (a section field bound with `bind:checked`, a nested section field bound
// with `bind:value`) is saved and survives a reload. The supporter page (77) is left out: it fetches from public services,
// which this context refuses.

/** Lets the save loop run: the debounce is 500 ms, and the boot pass may send more than one cycle. */
const settle = (page: Page) => page.waitForTimeout(2500);

/** The ops of every batch the page sends, as `kind`. */
function trackBatches(page: Page): string[][] {
    const batches: string[][] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/api/resources/batch")) {
            const body = JSON.parse(request.postData() ?? "{}") as { ops?: { kind: string }[] };
            batches.push((body.ops ?? []).map((op) => op.kind));
        }
    });
    return batches;
}

const PAGES: [number, string][] = [
    [1, "model"],
    [17, "api keys"],
    [16, "prompt"],
    [13, "prompt template"],
    [12, "persona"],
    [2, "other bots"],
    [3, "display"],
    [10, "language"],
    [21, "translation"],
    [11, "accessibility"],
    [14, "modules"],
    [4, "plugins"],
    [0, "files"],
    [15, "hotkeys"],
    [6, "advanced"],
];

const openSettings = (page: Page, index: number) =>
    page.evaluate(async (menu) => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.settingsOpen.set(true);
        stores.SettingsMenuIndex.set(menu);
    }, index);

/** A settings field by its root name, read through the views. */
const read = <T>(page: Page, field: string) =>
    page.evaluate(async (key) => {
        const { readSettingsRoot } = await import("/src/ts/storage/settingsViews.svelte.ts");
        return JSON.parse(JSON.stringify(readSettingsRoot(key) ?? null));
    }, field) as Promise<T>;

test("every settings page mounts through the records without an error or a write, and its controls save", async ({
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
        const { settings, activePreset } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.didFirstSetup = true;
        settings.ui.useLegacyGUI = true;
        // The prompt template page edits the selected prompt preset's template (the Prompt page turns it on).
        activePreset.promptTemplate = [
            { type: "plain", text: "Main prompt", role: "system", type2: "main" },
            { type: "chat", rangeStart: 0, rangeEnd: "end" },
        ] as any;
    });
    await settle(page);
    const batches = trackBatches(page);

    const content = page.locator(".rs-setting-cont-4");
    /** Opens every page and every accordion on it (nested ones appear as their parents open). */
    const visitAll = async () => {
        for (const [index, name] of PAGES) {
            await openSettings(page, index);
            await expect(content, name).toBeVisible();
            // An accordion header (the add buttons that share its style are `rounded-md`).
            for (let round = 0; round < 3; round++) {
                const closed = content.locator("button.px-6.py-2.text-lg:not(.bg-selected):not(.rounded-md)");
                const count = await closed.count();
                for (let i = 0; i < count; i++) {
                    await closed
                        .nth(i)
                        .click({ timeout: 2000 })
                        .catch(() => {});
                }
            }
            await page.waitForTimeout(300);
            expect((await content.innerText()).trim().length, name).toBeGreaterThan(0);
            expect(errors, name).toEqual([]);
        }
        await settle(page);
    };
    // The first visit may save defaults some pages fill in on mount (it did before this slice too); a
    // second visit reads everything again and writes nothing.
    await visitAll();
    batches.length = 0;
    await visitAll();
    expect(batches).toEqual([]);

    // A section field through `bind:checked` (Accessibility), and a nested section field through
    // `bind:value` (Other Bots, Image Generation: `NAIImgConfig.width`).
    const swipe = await read<boolean>(page, "swipe");
    await openSettings(page, 11);
    const label = await page.evaluate(async () => (await import("/src/lang/index.ts")).language.SwipeRegenerate);
    await content.getByText(label, { exact: true }).first().click();
    await settle(page);
    expect(await read<boolean>(page, "swipe")).toBe(!swipe);
    expect(batches.flat()).toEqual(["ui"]);

    batches.length = 0;
    await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.memoryTranslateMedia.sdProvider = "novelai";
    });
    await settle(page);
    batches.length = 0;
    const before = await read<{ width: number }>(page, "NAIImgConfig");
    await openSettings(page, 2);
    await content.getByText("Image Generation", { exact: true }).first().click();
    const width = content
        .locator('xpath=//span[normalize-space(.)="Width"]/following-sibling::*[1]/descendant-or-self::input')
        .first();
    await width.scrollIntoViewIfNeeded();
    await width.fill(String(before.width + 64));
    await settle(page);
    expect((await read<{ width: number }>(page, "NAIImgConfig")).width).toBe(before.width + 64);
    expect([...new Set(batches.flat())]).toEqual(["memoryTranslateMedia"]);

    await page.reload();
    await openApp(page, baseURL!);
    await settle(page);
    expect(await read<boolean>(page, "swipe")).toBe(!swipe);
    expect((await read<{ width: number }>(page, "NAIImgConfig")).width).toBe(before.width + 64);
    expect(errors).toEqual([]);
    expect(blocked.filter((href) => !/fonts\.g|cdn\.jsdelivr/.test(href))).toEqual([]);
});
