import { svelte } from "@sveltejs/vite-plugin-svelte";
import { configDefaults, defineConfig } from "vitest/config";
import { lucideImports } from "./vitest.lucideImports";

export default defineConfig({
    // `lucideImports` keeps each test from importing every icon (see the file).
    plugins: [lucideImports(), svelte()],
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
        // `pnpm test` leaves out the `slow` tests (`--tags-filter=!slow`); `pnpm test:slow` runs only
        // them and `pnpm test:all` everything. See `docs/structure/build-test-platforms.md`.
        tags: [
            {
                name: "slow",
                description:
                    "Real wall-clock limits, the real 100,000-effect limit, cold loads of every tokenizer, or fresh Node processes",
            },
        ],
    },
});
