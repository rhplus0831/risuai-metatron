# Phase 6: Thin Client And Closeout

Status: planned on 2026-10-03 (Phase 5 closed). The execution plan, the slice amendments, and the
owner's answers are in
[`slices/phase-6-thin-client-and-closeout/implementation-plan.md`](slices/phase-6-thin-client-and-closeout/implementation-plan.md).

Depends on: Phases 0 to 5.

## Objective

Shrink `DBState.db` to per-screen projections, deliver live updates from the server, remove the
aggregate object and every implicit save path, and finish the documentation so the plan can be
archived.

## Required Work

- **Projections.** Replace the whole-database mirror with read models: the character list summary,
  the selected character, the selected chat's loaded pages, and the settings sections. Components
  bind to these instead of `DBState.db`; the 25 files with two-way bindings (369 sites at
  `ee57e2e9`, re-measured at each slice with matching lines) and the top consumers
  (`CharConfig.svelte`, `OtherBotSettings.svelte`, `BotSettings.svelte`, `DefaultChatScreen.svelte`,
  `Chat.svelte`) go first. The client readers Phase 5 kept are migrated too: the request layer for
  the Plugin and WebLLM providers and the tab's own LLM requests, `serverGeneration.ts`,
  `serverCommands.ts`, `jobChannel.ts`, `transformClient.ts`, `pluginContext.ts`, the parser's CBS
  hosts, the translator, the tokenizer, and the browser memory helpers of the HypaV3 modal and the
  playground.
- **Accessors.** Remove the live variant of `getDatabase()`; keep snapshot and selector helpers.
  Remove `setDatabase`, `setDatabaseLite`, `setCurrentCharacter`, `setCharacterByIndex`, and
  `getCharacterByIndex` once no caller remains (there is no `setCurrentChat`; chat writes go through
  the chat module).
- **Selection shims.** Remove the preset and persona forwarding layer from Phase 3 and the mirror's
  derived `chatPage`, `botPresetsId`, and `selectedPersona`; readers use the selected-id projections.
- **Lazy loading.** With projections in place, the client loads chat summaries per character and
  the full message list only for the selected chat; the `chatLoadInitialPages` and
  `chatLoadAdditionalPages` paging stays a UI concern. Every reader of a non-selected chat
  (dataset export, chat export, plugin chat getters, MCP read tools) fetches it from the server
  first, and a summary is never presented as a complete `Chat`.
- **Save loop.** Delete `saveDb` and the save loop's `$effect` watchers; every write is a mutation.
  The other effects that read the database (`stores.svelte.ts`'s `supaMemory` write, which becomes
  a mutation, and `moduleUpdate`, the chat-fold effects, `App.svelte`) read the records.
- **Browser generation remnants.** The chat module's browser generation producers and maps, and
  the checkpoint and unload calls into them, go early in the phase; the server generation state
  stays. The streaming display optimization setting is rewired to server streams (it has had no
  effect since the Phase 5 cutover).
- **Live updates.** Resource-change events with revisions over the WebSocket so two clients of the
  same server converge; the client applies events to its projections and refetches on a gap.
- **Server storage.** An asset client replaces `forageStorage` over the same asset routes, the auth
  helpers (`authFetch`, `getNodeServerProxyAuth`) move to their own module, and `AutoStorage` and
  `NodeStorage`'s unused generic methods go.
- **Phase 5 leftovers.** The `proxyStreamJobs` route (no client caller since the cutover), the
  test-only provider oracles (after their uncovered cases move to server tests), the browser caches
  recorded as device caches, and the transform's per-request Lua cost measured.
- **Docs.** Rewrite `docs/structure/persistence.md`, `docs/structure/app-shell.md`,
  `docs/structure/global-api.md`, and `docs/structure/self-host-server.md`; replace invariants D1 to
  D4 in `STRUCTURE.md`; update the `Choose By Task` and `Path Ownership` tables, and every guide that
  names a removed identifier; remove the plan from the tree (git history keeps it) with
  `docs/plan/README.md` saying no plan is active, after the lasting behavior notes move into the
  guides' Known Hazards.

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
