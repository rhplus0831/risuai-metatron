import { expect, test, type Page } from "@playwright/test";
import { openApp } from "../util/playwright/stack.mjs";

// Phase 3, slice 4: the convergence rule in the browser (`docs/plan/phases/slices/
// phase-3-settings-sections/client-section-mirrors.md`, Validation). The stack of
// `playwright.config.ts` starts with an empty store, so the first boot is the first run: the server
// materializes every section, collection, and `presets`, and the client's `setDatabase` defaults
// create only the residual `root` and the two Phase 1 lists it fills. From then on an idle reload
// must write nothing: every projection equals the server's normalized text.

/** The ops of every batch the page sends, as `kind` with `+` for a create. */
function trackBatches(page: Page): string[][] {
    const batches: string[][] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/api/resources/batch")) {
            const body = JSON.parse(request.postData() ?? "{}") as { ops?: { kind: string; baseRevision: unknown }[] };
            batches.push((body.ops ?? []).map((op) => `${op.kind}${op.baseRevision === null ? "+" : ""}`));
        }
    });
    return batches;
}

/** Lets the save loop run: the debounce is 500 ms, and the boot pass may send more than one cycle. */
const settle = (page: Page) => page.waitForTimeout(3000);

test("a fresh store: the first boot creates only root, modules, and plugins; an idle reload writes nothing", async ({
    page,
    baseURL,
}) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const batches = trackBatches(page);

    await openApp(page, baseURL!);
    await settle(page);
    expect(batches.flat().sort()).toEqual(["modules+", "plugins+", "root+"]);
    expect(errors).toEqual([]);

    batches.length = 0;
    await page.reload();
    await openApp(page, baseURL!);
    await settle(page);
    expect(batches).toEqual([]);
    expect(errors).toEqual([]);

    // The mirror holds the server's records: both selections resolve by id.
    const selections = await page.evaluate(async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        const db = DBState.db;
        return {
            translator: db.translatorPresets.some((preset: { id: string }) => preset.id === db.translatorPresetId),
            hypa: db.hypaV3Presets.some((preset: { id: string }) => preset.id === db.hypaV3PresetId),
        };
    });
    expect(selections).toEqual({ translator: true, hypa: true });
});
