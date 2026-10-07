# Slice: Closeout And Docs

Status: implemented 2026-10-07 (the record is in the phase file, "Implementation Record (closeout, 2026-10-07)").

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Docs" (the four guides
rewritten, D1 to D4 replaced, the tables updated, the plan archived), the exit criteria (the
closeout criteria of `PLAN.md`, two clients converge, the guides describe the final
architecture), and the Validation (the two-client convergence check recorded, `pnpm build`);
`PLAN.md` Closeout Criteria, invariant 7 (each phase updates the guides), invariant 8 (the gates
pass at the phase boundary). Also the three items Phase 5 left to this phase: the
`proxyStreamJobs` server kind, the `hypaVector` and `tfCache` browser caches, and the
per-request Lua cost of the display transform.

Depends on: every other slice of this phase.

## Scope

Allowed files: `server/src/routes/proxyStreamJobs.ts` (deleted), `server/src/tests/proxyStreamJobs.test.ts`
(deleted, review step), `server/src/app.ts` (the proxy-jobs registration, GC, dispose, and its
dispatcher prefix removed; the dispatcher stays for the job and event sockets), `vite.config.ts`
(`proxy-stream-jobs` leaves the dev proxy regex), `package.json` unchanged (`ipaddr.js` is also
imported by `server/src/http/rateLimit.ts`), `docs/structure/persistence.md`,
`docs/structure/app-shell.md`, `docs/structure/global-api.md`, `docs/structure/self-host-server.md`
(rewritten), the guides that still name a removed identifier (`settings-i18n.md`,
`plugins-mcp.md`, `characters-modules.md`, `chat-pipeline.md`, `backup-sync-hub.md`,
`build-test-platforms.md`, `memory.md`, `llm-requests.md`, `ui-theming.md`, `media-aux.md`),
`STRUCTURE.md` (D1 to D4, U4, `Choose By Task`, `Path Ownership`, the glossary, "Last scoped
updated"), the phase file (Implementation Record, the measurements, the two-client check),
`docs/plan/README.md` (new: "Active planning and implementation: None"), the removal of
`docs/plan/PLAN.md` and `docs/plan/phases/` from the tree, `plugins.md` (the `getDatabase` and
`getChar` cost notes), `README.md` (the repository README's run notes if they name a removed
route). Tests belong to the review step.

Identifiers (verified 2026-09-30): `proxyStreamJobs` references: `server/src/app.ts:17, 61, 91, 164, 192, 194`,
`server/src/routes/proxyStreamJobs.ts` (553 lines; `isLocalNetworkHost` 71, `sanitizeTargetUrl`
97, used only there and in its test), `server/src/tests/proxyStreamJobs.test.ts`,
`vite.config.ts:45`, `src/ts/globalApi.svelte.ts` (`fetchViaProxyJobWs` 861-1041, deleted by
Phase 5 cutover with `src/ts/network/proxyJobWs.ts` and its test), and the guides
`self-host-server.md` (16 mentions), `global-api.md` (9), `build-test-platforms.md` (2),
`backup-sync-hub.md` (2). Browser caches: `hypaVector` (`hypamemory.ts:41`, `hypamemoryv2.ts:36`),
`tfCache` (`transformers.ts:14-39`), `LLMTranslateCache` (`translator.ts:25`),
`firefox-translations-models` (`bergamotTranslator.ts:82-152`), `strongBan_*` (`tokenizer.ts:542-587`),
`nightlyWarned` (`bootstrap.ts:87-90`); their remaining users after Phase 5 per its cutover
slice: `PlaygroundEmbedding.svelte`, `CharConfig.svelte` `registerOnnxModel`, `tts.ts` `runVITS`.
Guide mention counts of the identifiers this phase removes (`DBState.db`, `getDatabase`,
`saveDb`, `resourceSync`, `setDatabase`, `NodeStorage`, `AutoStorage`, `forageStorage`,
`markCharactersDirty`): `persistence.md` 1/3/3/5/9/6/5/1/4, `app-shell.md` 3/0/3/0/5/0/1/1/0,
`global-api.md` 0/0/2/3/0/1/1/2/1, `self-host-server.md` 0/0/0/0/0/7/2/0/0, `plugins-mcp.md`
1/1/0/0/5/0/0/0/1, `settings-i18n.md` 3/0/0/0/3/0/0/0/0, `characters-modules.md` 2/0/0/0/1,
`chat-pipeline.md` 1, `backup-sync-hub.md` 0/0/0/1/1, `build-test-platforms.md` 0/0/0/1/1,
`memory.md` `setDatabase` 1, `llm-requests.md` 1, `ui-theming.md` 1; `STRUCTURE.md` D1 to D4
(55-85), U4 (`selectedCharID === -1`), `Choose By Task` rows 138-140 and 152, `Path Ownership`
rows 165, 172, 174, 176. The archive convention (Opus P15): `docs/plan/` has `PLAN.md` and
`phases/` only; the `risuai-fastify` precedent removes a finished plan from the tree and keeps
`docs/plan/README.md` at "None" (its commits "docs: archive completed UI UX improvement plan",
"docs: archive unified workspace plan").

Stopping condition: a closeout criterion that does not hold (a live `getDatabase()` reader, a
client save codec, a collection without a normalizer or route tests, a send that does not run
as a server job, a provider key in client traffic, two clients not converging); the slice stops
and reports which criterion fails and why, instead of documenting around it.

## Assumptions

- Phase 5 cutover deleted `fetchViaProxyJobWs`, `proxyJobWs.ts`, and its test, and left the
  server kind one phase; no client calls `/proxy-stream-jobs` (`rg 'proxy-stream-jobs' src`
  empty). The owner kept it for this phase at Phase 5's Stop E.
- Phase 5 recorded the transform's per-request Lua cost as a Phase 6 concern without a number.
- Phase 5 kept `hypaVector` and `tfCache` for the three browser Transformers users and moved
  the memory vectors to `save/data/vectors.sqlite`.
- The recorded behavior changes of Phases 1 to 6 that are still live are carried into
  `persistence.md`'s `Known Hazards` (and the owning guide's) before the plan leaves the tree.

## Proposed decisions

- `proxyStreamJobs` (confirmed at Phase 5's Stop E): deleted with its test, registration, GC, dispose, dispatcher
  prefix (the `vite.config.ts` entry already went at the Phase 5 cutover); `self-host-server.md`'s routes table, Flows
  ("Proxying"), Invariants ("Streaming job protocol"), and Tests lose their entries. The
  local-network policy on `/proxy2` is unchanged.
- Browser caches (proposed): kept and listed in `persistence.md` as device caches of
  browser-side features, not user data (`mcp-tool-calls` was already removed at the Phase 5
  cutover: tool calls live only with their chat). No cleanup.
- Left by the Phase 5 cutover for this closeout (recorded in its slice file, confirmed at Stop E): the chat module's
  browser generation producers with no caller (`beginGeneration`, `checkpointGeneration`,
  `endGeneration`, `checkpointAllGenerations`, `setStreamingState`, `hasRunningGenerations`, the
  `generations`/`generationFinals` maps and the generation branches of the write and unload
  functions; their tests in `chatStore.test.ts` and `resourceSyncChats.test.ts` go with them, the
  server-lock and ordinary unload cases stay), and the browser provider adapters kept as test
  oracles (`src/ts/process/request/tests/oracle/`, with `serverParity.test.ts` and
  `requests.responses.test.ts`).
- Transform Lua cost (proposed): measured once in headless Chrome against a fixture chat of 200
  messages with a Lua `editDisplay` module: server time per batch and per target, recorded in
  the phase file; a number above 50 ms per target on the reference machine opens a follow-up
  (engine reuse per batch inside the worker), not work in this phase.
- Two-client convergence check (decided by the phase file; content proposed): the manual matrix
  of `live-updates` re-run on the final tree with two headless Chrome tabs and a third client
  writing through the routes, recorded in the phase file with the observed delays; selections
  stay per tab (Decision 3), the keep-on-switch fields and the translator and HypaV3
  `selectedId` values propagate.
- Docs (decided by the phase file; content proposed): `persistence.md` describes the records
  (`collectionStore.svelte.ts`, `characterStore.svelte.ts`, `chatStore.svelte.ts`,
  `records.svelte.ts`), the mutation transport (`resourceSync.svelte.ts` without watchers), the
  event feed, the snapshot builders, the browser caches, with `Files`, `Flows` (boot, write,
  live update, conflict, restore), `State`, `Invariants`, `Recipes` ("add a persisted setting":
  the section's normalizer, the section type, the record field; "add a resource kind"), `Tests`,
  and `Known Hazards` carrying every live recorded behavior change; `app-shell.md` describes boot
  over the records and the id-based selection; `global-api.md` loses the save loop and
  `fetchViaProxyJobWs`; `self-host-server.md` gains the feed, the events route, the revisions
  route, the summary reads, and loses the proxy jobs. `STRUCTURE.md`: D1 becomes "the client
  holds per-screen records of server resources; there is no aggregate database object"; D2 "a
  new persisted field needs a type entry, a client default at creation, and a server normalizer
  backstop with a node test"; D3 unchanged; D4 "every write is a mutation carrying the revision
  it was based on; hydration and live updates never become outgoing edits; a stale write reloads
  that record"; U4 names `selection.characterId` (`null` is home) and the shim if it survives;
  `Choose By Task` and `Path Ownership` name the new modules (`src/ts/storage/{records,snapshots,assetClient,serverAuth}`,
  `src/ts/network/eventFeed.ts`, `server/src/data/changeFeed.ts`, `server/src/routes/events.ts`);
  the glossary drops "the live database".
- Archive (decided by precedent, Opus P15): `docs/plan/PLAN.md` and `docs/plan/phases/` (with
  the slices) are removed from the tree in the closeout commit, `docs/plan/README.md` is added
  with "Active planning and implementation: None", and every guide stops linking to the plan;
  the git history keeps the plan, and the behavior changes live in the guides' `Known Hazards`.

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`;
`rg -n 'proxy-stream-jobs|proxyStreamJobs|DBState|saveDb|forageStorage|AutoStorage|NodeStorage|markCharactersDirty' src server docs STRUCTURE.md README.md --glob '!src/ts/plugins/apiV3/risuai.d.ts' --glob '!plugins.md'`
empty; the guides name only identifiers that exist (`rg` over every backticked identifier of
the four rewritten guides); the closeout criteria walked one by one and recorded in the phase
file with the command or check for each: no live `getDatabase()` (the grep of
`aggregate-removal`), no client save codec (`rg -n 'RisuSaveEncoder|RisuSaveDecoder' src`
empty), every collection with a normalizer and route tests (the kind registry against
`server/src/tests/`), a send as a server job with persisted messages (the Phase 5 matrix re-run
once), provider keys absent from client traffic (the headless Chrome network capture from Phase
5 re-run), two clients converging (the check above); Docker smoke with a fresh volume (first
run, two browsers, restart, snapshot restore, archive import).

## Residual risk

The phase file is the last document that carries the recorded behavior changes of Phases 1 to
6; removing it keeps them only in git history and in the guides' `Known Hazards`, so that
transfer is a checked step of this slice. The transform's engine reuse is a follow-up.
