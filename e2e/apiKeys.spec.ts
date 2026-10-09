import { expect, test, type Page } from "@playwright/test";
import { isolateContext, openApp } from "../util/playwright/stack.mjs";

// `docs/plan/shared-api-keys.md`, slice 4, with the binding on the model profile
// (`docs/plan/model-profiles.md`): the API Keys page and the key select of a profile, through the
// real server. A key is added on the page and its value set through its write-only field; the Model
// profiles page binds it to the main slot's profile; the binding shows on the API Keys page and both
// survive a reload; deleting the key (after a confirm that names its use) leaves the binding
// dangling, shown as missing with the refusal on the Model profiles page. No key value ever reaches
// a settings batch.

const API_KEYS_MENU = 17;
const MODEL_PROFILES_MENU = 18;
const KEY_VALUE = "sk-e2e-named-SENTINEL-4242";
const SHOTS = process.env.RISU_E2E_SHOTS;

/** Lets the save loop run: the debounce is 500 ms, and the boot pass may send more than one cycle. */
const settle = (page: Page) => page.waitForTimeout(2500);

const openSettings = (page: Page, index: number) =>
    page.evaluate(async (menu) => {
        const stores = await import("/src/ts/stores.svelte.ts");
        stores.settingsOpen.set(true);
        stores.SettingsMenuIndex.set(menu);
    }, index);

/** The settings the test checks, read through the views. */
const state = (page: Page) =>
    page.evaluate(async () => {
        const { settings, activeMainProfile } = await import("/src/ts/storage/settingsViews.svelte.ts");
        const { secretStatus } = await import("/src/ts/storage/llmSecrets.svelte.ts");
        const credentials = JSON.parse(JSON.stringify(settings.credentials));
        return {
            credentials,
            /** Each profile's key binding, by profile id. */
            bindings: Object.fromEntries(
                settings.modelProfiles
                    .filter((profile) => profile.credentialId !== undefined)
                    .map((profile) => [profile.id, profile.credentialId]),
            ),
            mainProfileId: activeMainProfile.id as string,
            aiModel: activeMainProfile.modelId,
            keySet: credentials.map(
                (credential: { id: string }) =>
                    secretStatus({ kind: "entry", field: "credentials", id: credential.id }).set,
            ),
        };
    });

async function shot(page: Page, name: string) {
    if (!SHOTS) {
        return;
    }
    for (const [width, label] of [
        [1280, "desktop"],
        [390, "mobile"],
    ] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
}

test("a named key is added, bound to a model profile, survives a reload, and a deleted key leaves a missing binding", async ({
    page,
    baseURL,
}) => {
    test.setTimeout(240_000);
    await isolateContext(page.context());
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const sentBatches: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/api/resources/batch")) {
            sentBatches.push(request.postData() ?? "");
        }
    });
    await openApp(page, baseURL!);
    await settle(page);
    await page.evaluate(async () => {
        const { settings, activeMainProfile } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.didFirstSetup = true;
        activeMainProfile.modelId = "gpt-5.5";
    });
    await settle(page);
    const content = page.locator(".rs-setting-cont-4");

    // Add a key on the API Keys page, then paste its value into the new row.
    await openSettings(page, API_KEYS_MENU);
    await expect(content.getByText("No shared keys yet.", { exact: false })).toBeVisible();
    await content.locator("#new-credential-name").fill("Work key");
    await content.getByRole("button", { name: "Add key", exact: true }).click();
    const row = content.locator("[data-credential-id]");
    await expect(row).toHaveCount(1);
    await expect(row.getByText("OpenAI", { exact: true })).toBeVisible();
    await row.locator('input[type="password"]').fill(KEY_VALUE);
    await row.getByRole("button", { name: "Replace", exact: true }).click();
    await settle(page);
    let current = await state(page);
    expect(current.credentials).toEqual([{ id: expect.any(String), name: "Work key", type: "openai" }]);
    expect(current.keySet).toEqual([true]);
    const keyId = current.credentials[0].id as string;
    const profileId = current.mainProfileId;
    expect(current.aiModel).toBe("gpt-5.5");

    // Bind it to the main slot's profile (the only one, selected) on the Model profiles page.
    await openSettings(page, MODEL_PROFILES_MENU);
    const select = content
        .locator("select")
        .filter({ has: page.locator('option:text-is("Work key")') })
        .first();
    await expect(select).toBeVisible();
    await expect(select.locator("option").first()).toHaveText("Default (OpenAI key)");
    await select.selectOption(keyId);
    await settle(page);
    expect((await state(page)).bindings).toEqual({ [profileId]: keyId });
    await shot(page, "model-bound");

    // The binding shows on the API Keys page.
    await openSettings(page, API_KEYS_MENU);
    const bindingRow = content.locator("div.border", { hasText: "Use default key" });
    await expect(bindingRow).toHaveCount(1);
    await expect(bindingRow).toContainText("Work key");
    await shot(page, "api-keys");

    // Both survive a reload; the value stays set and never came back to the tab.
    await page.reload();
    await openApp(page, baseURL!);
    await settle(page);
    current = await state(page);
    expect(current.bindings).toEqual({ [profileId]: keyId });
    expect(current.keySet).toEqual([true]);

    // Deleting asks first and names the profile that uses the key.
    await openSettings(page, API_KEYS_MENU);
    await content.locator("[data-credential-id]").getByRole("button", { name: "Delete key", exact: true }).click();
    await expect(page.getByText("Used by:", { exact: false })).toBeVisible();
    await expect(page.getByText(/Model profile: /)).toBeVisible();
    await page.getByRole("button", { name: "YES", exact: true }).click();
    await settle(page);
    current = await state(page);
    expect(current.credentials).toEqual([]);
    // The binding stays, and is shown as missing on both pages.
    expect(current.bindings).toEqual({ [profileId]: keyId });
    await expect(content.locator("div.border", { hasText: "Use default key" })).toContainText("Missing key");
    await openSettings(page, MODEL_PROFILES_MENU);
    await expect(content.getByText("the selected key is missing", { exact: false }).first()).toBeVisible();
    await shot(page, "model-missing");

    // Choosing the default removes the binding.
    const dangling = content
        .locator("select")
        .filter({ has: page.locator('option:text-is("Missing key")') })
        .first();
    await dangling.selectOption("");
    await settle(page);
    expect((await state(page)).bindings).toEqual({});

    expect(sentBatches.join("\n")).not.toContain(KEY_VALUE);
    expect(errors).toEqual([]);
});
