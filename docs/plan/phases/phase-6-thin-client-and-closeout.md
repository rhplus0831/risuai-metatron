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

## Implementation Record (closeout, 2026-10-07)

The execution plan, the slice files, and the stops are in
[`slices/phase-6-thin-client-and-closeout/`](slices/phase-6-thin-client-and-closeout/).

### Slices

| Slice                          | Commit                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| 1 Spike (projection bindings)  | `9b9d634d`                                                 |
| 2 Live updates                 | `df19b310`                                                 |
| 3 Browser generation remnants  | `51dd50f8`                                                 |
| Restore notice fix             | `35678fd4`                                                 |
| 4 Settings ownership           | `3ea20656`                                                 |
| 5a Character records           | `139fc73b`                                                 |
| 5b Character normalization     | `d7c75749`                                                 |
| Stop B smoke, Stop B leftovers | `3f5fdf0a`, `30bee445`                                     |
| 6 Readers: settings pages      | `5b47b2b3`                                                 |
| 7 Readers: settings consumers  | `d6fd621b`                                                 |
| 8 Readers: characters          | `1ab264df`                                                 |
| 9a Chat records                | `9cf80cdb`                                                 |
| 9b Chats loaded on demand      | `089adfcb`                                                 |
| Stop C smoke                   | `6fa405d1`                                                 |
| 10 Aggregate removal           | `2f658598`                                                 |
| 11 Closeout (this record)      | this commit; the plan's archive follows in the next commit |

### Deviations at the closeout

- **The archive is a second commit.** It amends the workflow's one commit per slice: an edit of this file and its deletion in the same commit would leave the final record nowhere in history. `docs/plan/README.md` names the closeout commit.
- **Dead client code went with the oracles.** The request oracles were the last users of `strongBan`/`tokenizeNum`, `textifyReadableStream`, the client `process/templates/jsonSchema.ts`, `getFreeOpenRouterModels`, and the Claude observer (`registerClaudeObserver`). The server has its own copies.
- **The hazards reconciliation.** The slice planned to verify each of the 176 notes against the code in the orchestrator. Instead, read-only workers verified them and drafted the entries, and the orchestrator spot-checked the drafts. The closeout's review then checked every row against the code. It found seven entries stating behavior the code does not have, six residuals stated in no guide, and six rows whose disposition or wording disagreed with the code. A fix round corrected them before the commit.
- **Guide provenance.** The "Phase N slice M" tags in the guides were removed; the phase names that mark a real version boundary stay, defined in `STRUCTURE.md`, "Migration History".

### Counts at the closeout

The `planning-notes.md` commands, matching lines / files, tests excluded:

| Row                                                     | Now (`ee57e2e9`) | Stop C (`089adfcb`) | Closeout |
| ------------------------------------------------------- | ---------------- | ------------------- | -------- |
| `DBState.db` lines / files                              | 1,745 / 123      | 43 / 15             | 0        |
| `bind:` onto `DBState.db` in `src/lib`                  | 369 / 25         | 0                   | 0        |
| `getDatabase(` lines / files                            | 150 / 43         | 52 / 8              | 42 / 3   |
| `selectedCharID` lines / files                          | 544 / 47         | 12 / 7              | 0        |
| `.chatPage`                                             | 110 / 35         | 6 / 5               | 6 / 5    |
| `src/lib/Setting` + `src/ts/setting` `DBState.db` lines | 777 / 35         | 0                   | 0        |

The 42 `getDatabase(` lines at the closeout are the CBS host method (`shared/cbs/registry.ts`, `shared/cbs/evaluator.ts`, through the injected ten-field `CbsDatabase` read view) and the plugin API's declaration (`risuai.d.ts`); no client accessor of that name exists.

### Measurements

- **Settings and characters, at slice 10.** `measureChats.mjs`, `measureCharacters.mjs`, and `measureRecords.mjs` ran two times each, against `6fa405d1` (production builds, headless Chrome). The results are in `aggregate-removal.md`. There was no regression:
  - boot took 455–458 ms, against 473–519 ms at the baseline;
  - the chat switches were equal or faster;
  - a settings field typed with 100 keystrokes saved in 9 batches, against 35–52.
- **The display transform's Lua cost** (`util/playwright/measureTransformLua.mjs`, three logged runs, medians of each; method in `self-host-server.md`, "Flows").

  | Configuration          | Warm 200-target render | Per target   | One-target request |
  | ---------------------- | ---------------------- | ------------ | ------------------ |
  | With the Lua module    | 142–145 ms             | 0.71–0.73 ms | 2.8 ms             |
  | Without the Lua module | 68–70 ms               | 0.34–0.35 ms | 1.7–1.8 ms         |

  The cold first render took 288–306 ms. That is far below the 50 ms per target that would call for engine reuse per batch, so no follow-up is opened. An earlier run, printed to the console only, measured up to 162 ms, 0.81 ms per target, and 5.0 ms for one target; it is not counted.

### Two-client convergence

- **Dev, the full matrix:** `checkLiveUpdates.mjs`, 49/49. It uses two contexts and three pages, with a third writer through the routes. It covers a settings edit, a character edit, a preset edit and the per-tab preset selection, chat rename, append, create, and delete, no reload notice and no write back, a server send's checkpoint and final reply in the observers, a character deletion, a restart, and an archive restore.
- **Docker, the closeout matrix:** `checkStopDSmoke.mjs`, image `risu-metatron:p6-s11-dev`, a fresh volume, 50/50. Its steps:
  1. First run: A set the password, and B logged in with its own key pair.
  2. A → B and B → A character edits typed in the UI.
  3. A third writer's chat append.
  4. A send against a mock provider, with a sentinel key set through the `llmSecrets` route. The provider received it, and it appeared nowhere in either browser's traffic: the headers, bodies, and WebSocket frames both ways.
  5. A restart (`docker restart`), with the state before it durable, a write made before the clients reconnected reaching both without a reload, and the next edit saved.
  6. An archive import: both clients told and reloaded on S1.
  7. The import's safety snapshot restored by id: both on S2, and saving resumed.

  The observed delays, polled every 200 ms:

  | Event                                                  | Delay       |
  | ------------------------------------------------------ | ----------- |
  | An edit stored                                         | 0.41 s      |
  | Another client showing an edit, or a route write       | 0.2 s       |
  | The send's reply shown in the observer                 | 0.4 s       |
  | A write after the restart shown at the reconnect       | 0.2 s       |
  | The restore notice, after the import or restore answer | under 10 ms |

### Docker

- **Image:** `risu-metatron:p6-s11-dev`, the closeout's code. Each script ran on a fresh volume, with `--dns 127.0.0.254` and `--add-host host.docker.internal:host-gateway`.
- **Results:**

  | Script               | Result |
  | -------------------- | ------ |
  | `checkStopDSmoke`    | 50/50  |
  | `checkStopCSmoke`    | 16/16  |
  | `checkStopBSmoke`    | 12/12  |
  | `checkServerSend`    | 15/15  |
  | `checkServerButton`  | 8/8    |
  | `checkServerTrigger` | 9/9    |
  | `checkStopDMatrix`   | 35/35  |

### Closeout criteria (`PLAN.md`)

1. **No production code reads `getDatabase()` for a live object, and no client code encodes a save file: holds.**
   - `rg -n 'DBState' src --glob '!src/ts/plugins/apiV3/risuai.d.ts'` is empty.
   - There is no client `getDatabase`/`setDatabase`/`setDatabaseLite` and no `saveDb`.
   - The plugin `getDatabase` builds a fresh snapshot (`buildDatabaseSubset`).
   - The CBS host's `getDatabase()` is its injected ten-field read view.
   - `rg -n 'RisuSaveEncoder|RisuSaveDecoder' src` is empty.
2. **Every collection has a server resource with revision checks, normalization, and route tests: holds, after the closeout's review added the missing route tests.**
   - Each of the 25 kinds has a normalizer (`server/src/data/kinds.ts`, `normalize/*`), and `kinds.test.ts` checks the registry.
   - The routes are generic over kinds. At the start of the slice, ten collections had no route test naming them: `loreBook`, `globalscript`, `hotkeys`, `customSidebarItems`, `characterOrder`, `authRefreshes`, `globalChatVariables`, `translatorPresets`, `customModels`, `statics`. The criterion was unproven at that point.
   - The review wrote `server/src/tests/resourceKinds.test.ts`: one row per kind of `DEFAULT_RESOURCE_KINDS` (a coverage assertion fails for a kind added without one), plus `llmSecrets` and the chats and chat orders. Each row covers the fresh store, a write normalized and read back on every read route, the revision, a stale write refused with 409, the batch route, a refused value answered with 400, and deletion. No kind's route behaved differently from the generic contract.
3. **A send round trip runs as a server job with streamed events and persisted messages, and provider keys are absent from the client's network traffic: holds.**
   - `checkServerSend` and `checkStopDMatrix` against the image cover the job creation, the stream, the terminal event, and the stored and reloaded messages.
   - `checkStopDSmoke` covers the production traffic capture.
   - `checkCutoverCredentials.mjs` reran in dev: 26/26, with no credential in the browser's traffic except the key-entry PUTs. The first runs at the closeout failed one check, 25/26, because one app response body was not captured. A resources read of the earlier document answered during the reload that starts the capture, so its body was gone. The capture now starts on an unloaded page, `about:blank`.
4. **Two clients of the same server converge after a write in either: holds** (above).
5. **`docs/structure/` describes the final architecture, and this plan is archived.**
   - The guides were corrected for the removed code.
   - The plan-only behavior notes were reconciled into the guides' Known Hazards, Invariants, Flows, and Tests: 176 source rows, each transferred, already covered, superseded, or dropped as a process note. The review checked every row against the code, and the entries it found wrong or missing were corrected ("Deviations at the closeout").
   - The plan leaves the tree in the next commit.
