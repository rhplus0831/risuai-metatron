import { defineConfig } from "@playwright/test";

// End-to-end specs in `e2e/` run against an isolated stack that `util/playwright/globalSetup.mjs`
// starts per run: the self-host server in a fresh temporary working directory (empty `save/`) and
// the Vite dev server in front of it. The system Chrome is used, so no browser download is needed
// (override with RISU_CHROME). Each test gets a fresh browser context; a two-client check opens a
// second context. Kept out of `pnpm test`; run with `pnpm test:e2e`.
export default defineConfig({
    testDir: "e2e",
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
    workers: 1,
    timeout: 120_000,
    globalSetup: "./util/playwright/globalSetup.mjs",
    reporter: "list",
    use: {
        baseURL: "http://localhost:5201",
        headless: true,
        launchOptions: {
            executablePath: process.env.RISU_CHROME ?? "/usr/bin/google-chrome",
        },
        trace: "retain-on-failure",
    },
});
