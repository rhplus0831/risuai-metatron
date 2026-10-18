import { svelte } from "@sveltejs/vite-plugin-svelte";
import { configDefaults, defineConfig } from "vitest/config";
import { requireHuman } from "./util/requireHuman.mjs";
import { lucideImports } from "./vitest.lucideImports.ts";

// Every Vitest run loads this file once in the main process, so this gate covers `pnpm test` and a
// direct `vitest` alike: without CI, HUMAN, or AGENT_TEST it prints the notice and exits.
requireHuman("vitest");

export default defineConfig({
    // `lucideImports` keeps each test from importing every icon (see the file).
    // `configFile: false`: there is no svelte.config.js, and the lookup logs a line on every run.
    plugins: [lucideImports(), svelte({ configFile: false })],
    resolve: {
        alias: {
            src: "/src",
        },
        conditions: ["browser"],
    },
    test: {
        environment: "happy-dom",
        setupFiles: ["vitest.setup.ts"],
        // Playwright specs (`pnpm test:e2e`) match Vitest's default `*.spec.ts` include. Claude Code
        // worktrees under `.claude/worktrees/` are full checkouts of other branches.
        exclude: [...configDefaults.exclude, "e2e/**", ".claude/**"],
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
