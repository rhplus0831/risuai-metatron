// Playwright global setup: one isolated stack (fresh server working directory, Vite dev server) per
// `pnpm test:e2e` run, on the ports `playwright.config.ts` points `baseURL` at. The returned
// function is Playwright's teardown.
import { startStack } from "./stack.mjs";

export const E2E_SERVER_PORT = 6101;
export const E2E_VITE_PORT = 5201;

export default async function globalSetup() {
    const stack = await startStack({ serverPort: E2E_SERVER_PORT, vitePort: E2E_VITE_PORT });
    process.env.RISU_E2E_SERVER_URL = stack.serverURL;
    return async () => {
        await stack.stop();
    };
}
