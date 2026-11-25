import { svelte } from "@sveltejs/vite-plugin-svelte";
import { configDefaults, defineConfig } from "vitest/config";
import { requireHuman } from "./util/requireHuman.mjs";
import { lucideImports } from "./vitest.lucideImports.ts";

// Every Vitest run loads this file once in the main process, so this gate covers `pnpm test` and a
// direct `vitest` alike: without CI, HUMAN, or AGENT_TEST it prints the notice and exits.
// The Vitest VS Code extension loads this config too, so that editor needs HUMAN in its environment.
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
        // happy-dom 21 turns iframe page loading off by default (its SSRF hardening). The network
        // guard in `vitest.setup.ts` already refuses every non-loopback load, and the plugin sandbox
        // appends its iframe before setting `srcdoc`, which off would log a NotSupportedError per
        // plugin boot and leave the frame without a window.
        environmentOptions: { happyDOM: { settings: { enableIframePageLoading: true } } },
        // Playwright specs (`pnpm test:e2e`) match Vitest's default `*.spec.ts` include. Claude Code
        // worktrees under `.claude/worktrees/` are full checkouts of other branches.
        exclude: [...configDefaults.exclude, "e2e/**", ".claude/**"],
        // A hang guard, not a performance budget (`STRUCTURE.md` V3): a deterministic
        // test may take this long under load. `pnpm test:agent --slow-tests` lists the slow ones.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        // `pnpm test` leaves out the `slow` tests (`--tags-filter=!slow`); `pnpm test:slow` runs only
        // them and `pnpm test:all` everything. See `docs/structure/test-harness.md`.
        tags: [
            {
                name: "slow",
                description:
                    "Real wall-clock limits, the real 100,000-effect limit, cold loads of every tokenizer, or fresh Node processes",
            },
        ],
    },
});
