// The human gate for the plain test commands. `pnpm test`, `pnpm test:slow`, `pnpm test:all`, and
// any direct `vitest` run (through `vitest.config.ts`) and `pnpm test:e2e` (through this file's
// command-line form) refuse to run unless one of these is set:
//   CI          set by CI services themselves,
//   HUMAN       set by a person (`export HUMAN=1` in the shell profile, or `HUMAN=1 pnpm test`),
//   AGENT_TEST  set by `util/agentTest.mjs` for the run it supervises.
// Agents are expected to use `pnpm --silent test:agent` instead. This is a convention, not a
// barrier. See `docs/structure/build-test-platforms.md`.
import { pathToFileURL } from "node:url";

export function humanAllowed(env = process.env) {
    return Boolean(env.CI || env.HUMAN || env.AGENT_TEST);
}

export function humanGateMessage(command) {
    return [
        `[tests] ${command} is for people and CI, not for agents: none of CI, HUMAN, or AGENT_TEST is set.`,
        "  Agents: run `pnpm --silent test:agent` (failures only, cached per working tree; `--all`, `--tags-filter=slow`,",
        "          `--force`, `--verbose`, and file filters are accepted; see docs/structure/build-test-platforms.md).",
        "  People: set HUMAN=1, for example `export HUMAN=1` in your shell profile or `HUMAN=1 pnpm test`.",
        "",
    ].join("\n");
}

// Prints the message and exits instead of throwing, so the caller shows no stack trace.
export function requireHuman(command) {
    if (humanAllowed()) return;
    process.stderr.write(humanGateMessage(command));
    process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    requireHuman(process.argv[2] ?? "this command");
}
