import { test as base, type Page } from "@playwright/test";
import { clearSafeBootAttempts } from "../util/playwright/stack.mjs";

/**
 * The specs' `test`: the default browser context starts every page load with safe boot's counter of
 * unsettled boots cleared (`clearSafeBootAttempts`), so a spec that opens or reloads the app several
 * times within a boot's settling window, or that runs right after another check's loads in the same
 * stack, is not met by the Safe boot notice intercepting its clicks. The fixture wraps only Playwright's
 * injected `context`: a context a spec makes itself (`browser.newContext()`) must call
 * `clearSafeBootAttempts` before its first page load.
 */
export const test = base.extend({
    context: async ({ context }, use) => {
        await clearSafeBootAttempts(context);
        await use(context);
    },
});

/**
 * Waits until the page's resource sync is idle (`resourceSyncIdle`: nothing dirty, queued, scheduled,
 * or in flight), seen on two polls 100 ms apart so an action that marks a record after an awaited
 * step is not taken for idle in between. This is how a spec lets the save loop run (its debounce is
 * 500 ms, and a boot pass may send more than one cycle) instead of sleeping past it. A poll during
 * a navigation counts as not idle.
 */
export async function settle(page: Page, timeout = 30_000): Promise<void> {
    const deadline = Date.now() + timeout;
    let idlePolls = 0;
    while (Date.now() < deadline) {
        const idle = await page
            .evaluate(async () => {
                const sync = await import("/src/ts/storage/resourceSync.svelte.ts");
                return sync.resourceSyncIdle();
            })
            .catch(() => false);
        idlePolls = idle ? idlePolls + 1 : 0;
        if (idlePolls >= 2) {
            return;
        }
        await page.waitForTimeout(100);
    }
    throw new Error(`The resource sync did not go idle within ${timeout} ms`);
}

export { expect } from "@playwright/test";
export type { BrowserContext, Locator, Page, Request, Route } from "@playwright/test";
