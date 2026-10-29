import { test as base } from "@playwright/test";
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

export { expect } from "@playwright/test";
export type { BrowserContext, Locator, Page, Request, Route } from "@playwright/test";
