import { svelte } from "@sveltejs/vite-plugin-svelte";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [svelte()],
    resolve: {
        alias: {
            src: "/src",
        },
        conditions: ["browser"],
    },
    test: {
        environment: "happy-dom",
        setupFiles: ["vitest.setup.ts"],
        // Playwright specs (`pnpm test:e2e`) match Vitest's default `*.spec.ts` include.
        exclude: [...configDefaults.exclude, "e2e/**"],
    },
});
