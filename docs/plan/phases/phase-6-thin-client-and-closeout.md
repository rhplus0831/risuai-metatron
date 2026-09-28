# Phase 6: Thin Client And Closeout

Status: not started.

Depends on: Phases 0 to 5.

## Objective

Shrink `DBState.db` to per-screen projections, deliver live updates from the server, remove the
aggregate object and every implicit save path, and finish the documentation so the plan can be
archived.

## Required Work

- **Projections.** Replace the whole-database mirror with read models: the character list summary,
  the selected character, the selected chat's loaded pages, and the settings sections. Components
  bind to these instead of `DBState.db`; the 26 files with two-way bindings and the top consumers
  (`CharConfig.svelte`, `OtherBotSettings.svelte`, `BotSettings.svelte`, `DefaultChatScreen.svelte`,
  `Chat.svelte`) go first.
- **Accessors.** Remove the live variant of `getDatabase()`; keep snapshot and selector helpers.
  Remove `setDatabase`, `setDatabaseLite`, `setCurrentChat`, and `setCharacterByIndex` once no
  caller remains.
- **Save loop.** Delete `saveDb` and the remaining `$effect` watchers; every write is a mutation.
- **Live updates.** Resource-change events with revisions over the WebSocket so two clients of the
  same server converge; the client applies events to its projections and refetches on a gap.
- **Server storage.** `NodeStorage` keeps only asset access, or is folded into the resource client.
- **Docs.** Rewrite `docs/structure/persistence.md`, `docs/structure/app-shell.md`,
  `docs/structure/global-api.md`, and `docs/structure/self-host-server.md`; replace invariants D1 to
  D4 in `STRUCTURE.md`; update the `Choose By Task` and `Path Ownership` tables; archive this plan.

## Safety Contract

No projection recreates an aggregate database under another name. Screens keep their current
behavior; the migration is measured by the reference counts in the opening baseline reaching zero.

## Exit Criteria

- The closeout criteria in `PLAN.md` are met.
- `rg 'DBState\.db'` outside the projection modules returns nothing.
- Two clients converge after a write in either.
- The guides and invariants describe the final architecture.

## Validation

Projection and event-application tests, a two-client convergence check recorded in the phase file,
and `pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`.
