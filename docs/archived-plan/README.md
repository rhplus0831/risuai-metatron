# Archived Plans and Migration History

Completed plans are removed from `docs/plan/`; their last versions remain in the
commit trees below. Current guides describe shipped behavior. Historical decision
labels (O1–O9, R/H items, numbered binding decisions, translation slices) refer to
these archived designs, not to live files in the working tree.

Documentation audit: 2026-10-17. Archiving an implemented design does not certify
its pending manual checks. [Active work](../plan/README.md) remains separate.

## Retrieve a Historical Plan

Use the commit and original path together, for example:

```sh
git show 317a97ce:docs/plan/model-profiles.md
git show df25006f:docs/plan/translation.md
git show e148f7276:docs/plan/web-push.md
git show ab11ea9d0:docs/plan/request-history-diagnostics.md
git show 154711858:docs/plan/chat-toggles-and-presets.md
git show 1bb0c8eee:docs/plan/large-asset-import.md
git show f5895b925:docs/plan/sidebar-chat-status.md
git show 46eeee597:docs/plan/settings-ui-reorg.md
git show cfe072e4e:docs/plan/open-bug-fixes.md
git show 723700902:docs/plan/boot-resource-cache.md
git show 639ba5b2e:docs/plan/heap-memory.md
git show d30735b05:docs/plan/search.md
git show f4c26f27d:docs/plan/risunest-small-wins.md
git show 74f770e19:docs/plan/upstream-bin-compat.md
git show e1aa33150:docs/plan/audit-findings-perf.md
git show 2508dfd0c:docs/plan/timing-tests.md
git ls-tree -r --name-only 9d09288b -- docs/plan/PLAN.md docs/plan/phases/
```

For another entry, substitute its commit/path. A historical reference such as
`docs/plan/chat-binding.md` is retrievable with `git show 809b35cc:docs/plan/chat-binding.md`;
it is not a current architecture guide.

## Completed Plans

| Design                                   | Last tree / original paths                                                | Current owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-owned data, Phases 0–6            | `9d09288b`: `docs/plan/PLAN.md`, `docs/plan/phases/`                      | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md)                                                                                                                                                                                                                                                                                                                                                                                                       |
| Split Preset and Chat Binding            | `809b35cc`: `docs/plan/split-preset.md`, `docs/plan/chat-binding.md`      | [persistence](../structure/persistence.md), [settings](../structure/settings-i18n.md)                                                                                                                                                                                                                                                                                                                                                                                                        |
| Shared API Keys and Model Profiles       | `317a97ce`: `docs/plan/shared-api-keys.md`, `docs/plan/model-profiles.md` | [LLM requests](../structure/llm-requests.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Translation and URL Routes               | `df25006f`: `docs/plan/translation.md`, `docs/plan/url-routes.md`         | [media/translation](../structure/media-aux.md), [app shell/routes](../structure/app-shell.md)                                                                                                                                                                                                                                                                                                                                                                                                |
| Web Push                                 | `e148f7276`: `docs/plan/web-push.md`                                      | [browser notifications](../structure/global-api.md), [worker](../structure/build-test-platforms.md), [server](../structure/self-host-server.md)                                                                                                                                                                                                                                                                                                                                              |
| Request History and Diagnostics          | `ab11ea9d0`: `docs/plan/request-history-diagnostics.md`                   | [diagnostics](../structure/diagnostics.md), [LLM capture](../structure/llm-requests.md)                                                                                                                                                                                                                                                                                                                                                                                                      |
| Per-Chat Toggles and Toggle Presets      | `154711858`: `docs/plan/chat-toggles-and-presets.md`                      | [persistence](../structure/persistence.md), [UI/theming](../structure/ui-theming.md), [CBS/rendering](../structure/cbs-rendering.md)                                                                                                                                                                                                                                                                                                                                                         |
| Large Asset Import and Export            | `1bb0c8eee`: `docs/plan/large-asset-import.md`                            | [characters/modules](../structure/characters-modules.md), [server](../structure/self-host-server.md), [persistence](../structure/persistence.md), [asset client](../structure/global-api.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                       |
| Sidebar Chat Status                      | `f5895b925`: `docs/plan/sidebar-chat-status.md`                           | [UI/theming](../structure/ui-theming.md), [chat pipeline](../structure/chat-pipeline.md), [persistence](../structure/persistence.md), [app shell](../structure/app-shell.md)                                                                                                                                                                                                                                                                                                                 |
| Data-Loss Under Concurrency              | `01ceb829b`: `docs/plan/data-loss-concurrency.md`                         | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [chat pipeline](../structure/chat-pipeline.md), [memory](../structure/memory.md), [plugins/MCP](../structure/plugins-mcp.md), [UI/theming](../structure/ui-theming.md), [app shell](../structure/app-shell.md)                                                                                                                                                                                       |
| Settings UI Reorganization               | `46eeee597`: `docs/plan/settings-ui-reorg.md`                             | [settings](../structure/settings-i18n.md), [app shell/routes](../structure/app-shell.md), [media/translation](../structure/media-aux.md), [LLM requests](../structure/llm-requests.md)                                                                                                                                                                                                                                                                                                       |
| Open Bug Fixes                           | `cfe072e4e`: `docs/plan/open-bug-fixes.md`                                | [persistence](../structure/persistence.md), [characters/modules](../structure/characters-modules.md), [chat pipeline](../structure/chat-pipeline.md), [memory](../structure/memory.md), [plugins/MCP](../structure/plugins-mcp.md), [UI/theming](../structure/ui-theming.md), [settings](../structure/settings-i18n.md), [server](../structure/self-host-server.md), [browser notifications](../structure/global-api.md), [media](../structure/media-aux.md)                                 |
| Boot Resource Cache                      | `723700902`: `docs/plan/boot-resource-cache.md`                           | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [build/test](../structure/build-test-platforms.md)                                                                                                                                                                                                                                                                                                                                                   |
| Heap Memory Reduction                    | `639ba5b2e`: `docs/plan/heap-memory.md`                                   | [persistence](../structure/persistence.md), [characters/modules](../structure/characters-modules.md), [CBS/rendering](../structure/cbs-rendering.md), [build/test](../structure/build-test-platforms.md)                                                                                                                                                                                                                                                                                     |
| Search                                   | `d30735b05`: `docs/plan/search.md`                                        | [UI/theming](../structure/ui-theming.md), [characters/modules](../structure/characters-modules.md), [settings](../structure/settings-i18n.md), [server](../structure/self-host-server.md), [matcher](../structure/global-api.md), [app shell](../structure/app-shell.md)                                                                                                                                                                                                                     |
| RisuNest Small Wins                      | `f4c26f27d`: `docs/plan/risunest-small-wins.md`                           | [build/test](../structure/build-test-platforms.md), [plugins/MCP](../structure/plugins-mcp.md), [alerts](../structure/global-api.md), [app shell](../structure/app-shell.md), [server/Docker](../structure/self-host-server.md), `STRUCTURE.md` V4–V9                                                                                                                                                                                                                                        |
| Upstream `.bin` Compatibility            | `74f770e19`: `docs/plan/upstream-bin-compat.md`                           | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [backups](../structure/backup-sync-hub.md), [build/test](../structure/build-test-platforms.md)                                                                                                                                                                                                                                                                                                       |
| Audit Findings and Performance Leftovers | `e1aa33150`: `docs/plan/audit-findings-perf.md`                           | [server](../structure/self-host-server.md), [memory](../structure/memory.md), [LLM requests](../structure/llm-requests.md), [CBS/rendering](../structure/cbs-rendering.md), [chat pipeline](../structure/chat-pipeline.md), [persistence](../structure/persistence.md), [UI/theming](../structure/ui-theming.md), [plugins/MCP](../structure/plugins-mcp.md), [media](../structure/media-aux.md), [app shell](../structure/app-shell.md), [build/test](../structure/build-test-platforms.md) |
| Timing-Dependent Tests                   | `2508dfd0c`: `docs/plan/timing-tests.md`                                  | [build/test](../structure/build-test-platforms.md) `Tests`, `STRUCTURE.md` V3, [server](../structure/self-host-server.md) (test-only timing options)                                                                                                                                                                                                                                                                                                                                         |

The archived Web Push file still says “planned”; the implementation shipped in
`e148f7276`. Its historical status text must not be used as the current feature state.
Request History and Diagnostics records both implementation phases as done.
Large Asset Import and Export landed every slice (1a–4b) on 2026-10-17 and 2026-10-18;
its commits are listed in the archived Status line.
Sidebar Chat Status landed all three slices on 2026-10-18 (`1b409eceb`, `94b981be3`, `f5895b925`).
Settings UI Reorganization landed all nine slices on 2026-10-19, on the `settings-ui-plan` branch.
The archived Status and Decisions paragraphs list its commits and the choices each slice made.
Still open: `e2e/settingsPages.spec.ts` was updated in each slice but never run; the fetched
WaveSpeed model list still resets when Image Generation is left; the subtitle tool's Whisper mode
uses the OpenAI key with no status or link there.
Data-Loss Under Concurrency (the fix plan for `docs/audit/data-loss-concurrency-2026-10-18.md`)
landed all 18 slices on 2026-10-18 and 2026-10-19; the archived Status line lists each slice's
commit and its "Decisions made by landed slices" paragraph records the choices the slices made
(1a's `setMessage` rule, 1c's summary merge rule, 5a's `onStorageDiscarded` event, 6b's 100-id
bound and `chatGroups` table, 7b's add-only order repair, 6d's fail-closed barrier). Every slice
was verified by tests only; the browser checks the slices listed (the reload notice panel,
two-tab delete/edit races, a network drop and reconnect, concurrent order edits) were not run.
Open Bug Fixes (the reachable bugs the project memory had recorded, rechecked at `5c3665fdb`)
landed all 20 slices on 2026-10-19 through the plan runner, one cherry-picked commit each; the
archived Status line lists every slice's commit (A1 `8956cac09` through I1 `2d2dc8a7d`). Every
slice was verified by tests and a Sol or Fable review; only C7 (lore, emotion, and asset row
bindings) was driven in a real browser. The final checks on `metatron` passed (`pnpm check`,
`test:agent` 5385 passed); the slow-tagged `server/src/tests/importPngCaps.test.ts:52` failed
before the run and still does, and is not the plan's.
Boot Resource Cache landed four slices on 2026-10-19 on the `boot-resource-cache` branch:
compressed resource reads (`1d382e8d0`), the `POST /api/resources/boot` read that skips what the
client holds (`9b831002a`), the IndexedDB boot cache (`ad7370e9e`), and the browser measurement
and check (`723700902`, `util/playwright/measureBoot.mjs`, `checkBootCache.mjs`). On a synthetic
server of the reported shape at 10 Mbps the main screen came after 18.3 s with the uncompressed
plain read, 6.5 s on a first (cold) boot, and 0.51 s on a warm boot; the archived Slice 4 section
holds the full table and the decisions (no server hash cache; compression settings and `presets`
as an item kind kept).
Heap Memory Reduction (two Chrome heap snapshots of a production build with large modules
and characters, 2026-10-19) landed every slice on the `heap-memory-reduction` branch, merged
into `metatron` as `b122ae132`: the heap scripts and large-data driver (M0 `133e0b965`), one
string per equal record text (A1 `c087b8568`), frozen module and character asset lists (B1
`32f346324`, B2 `4e9aa27d9`), the font investigation (C1 `937f1e456`, no app-side holder), one
stylesheet per chat style (C2 `7a986ac69`), wrapper nodes released after deletes (D1
`f37cae9cc`), and the one-shot decode URLs revoked (D2a `d00bde006`; D2b measured and accepted
in `639ba5b2e`). The driver's JS self size at boot went from 191.3 MB to 61.6 MB and asset
tuple proxies from 132,600 to 0; the archived file holds every slice's table. At the merge,
B2's frozen-list `CharConfig` rows replaced open-bug-fixes slice C7's tuple-keyed rows (C7's
regression tests kept and passing).
Search (Haejeok survey items F1, F2, A3, A4 and the PocketRisu settings-search pick) landed all
nine slices on 2026-10-20 through the plan runner from a worktree, one cherry-picked commit each,
and `metatron` was fast-forwarded to `d30735b05`: `color-scheme` on the theme root (1
`a6082b735`), the shared `es-hangul` matcher `src/ts/util/koreanSearch.ts` (2a `ceeb22d92`), the
batched `LIKE` message search route `POST /api/chats/search` (4a `016028c47`), the catalog and
sidebar chat list filters (2b `89bd9a57a`), the lorebook list filter (2c `fd2f81040`), the
settings search index and locations (3a `faaeba64f`, which also fixed the matcher's throw on
Latin queries `es-hangul` cannot assemble, such as `jinja`), the module and persona filters (2d
`b9dcbbe20`), the settings search field and deep link (3b `c32a17f12`), and the message search
panel with the jump to a message (4b `f99028fd0`). The archived Decisions section records the
defaults every slice took (no FTS index; the `LIKE` scan measured at 516–674 ms over 145 MiB of
seeded messages, under the 1 s threshold of Decision 7). The final checks on the target branch
passed (`pnpm check`, `format:check`, `test:agent` 5738 passed). Slices 1, 3b and 4b were driven
in headless Chrome; 2b, 2c, 2d and 3a were verified by tests and reviews only.
RisuNest Small Wins (RisuNest survey items 1–5 and 17) landed all nine slices on 2026-10-20
through the plan runner from a worktree, one cherry-picked commit each, then merged `metatron`
(the Search plan) into the branch as `abde78c57` and fast-forwarded `metatron` to it: the
unit-test network guard `vitest.testNetwork.ts` (T1 `86411442f`), the plugin fixes (unread
`nativeFetch` body expiry at 60 s, `terminate` aborting host calls, the non-3.0 plugin report; P1
`a293fc574`), the `.dockerignore` (K1 `90882b0cd`), `STRUCTURE.md` V4–V9 with `pnpm check:tests`
and the shared `createAlertMock` (E1 `9e72646ac`), the deferred plugin reload after a remote
`plugins` change (P2 `ed9d207c5`), the GitLab CI pipeline and `util/ci/check.sh` (K2
`f6ac36f7a`), the alert queue `alertQueue.ts` (A1 `96a296e34`), the remaining alert mocks
through the factory (E2 `58ebd1452`), and safe boot `safeBoot.ts` (S1 `dd9b50ce5`). Decisions:
D1 GitLab CI with a Runner for `metatron` and `main` only (the plan's Forgejo/Gitea options did
not apply; the forge is GitLab); D2, D4 (never interrupt), D5 (once per page load), D6 (two
boots, 10 s), D7 (exact origins) at their defaults; D3 moot (the heap branch had merged). The
final checks on the merged branch passed (`pnpm check`, `check:tests`, `format:check`, `build`;
`test:agent --all` 5929 passed with only the known stale `importPngCaps` failure). A1 and S1 were
driven in headless Chrome; K1 was checked with a real `docker build`; K2 with a clean-clone run on
the host and in a `node:24` container.
Upstream `.bin` Compatibility (import an upstream RisuAI `.bin` as a full replace with a report,
and export a `.bin` upstream restores) landed all eight slices on the `upstream-bin-compat` branch
on 2026-10-20 and 2026-10-21, and the branch was merged into `metatron` on 2026-10-21. Commits: S1 codec
`620fc6fc1` and the msgpackr 2.0.6 pin `48d5571af` (merged `ca2592b59`), S2 archive classification
`3d5c8b747` (`d651f3b2a`), S3 settings/presets converter `cb4c9ca48` (`3eedde66f`), S4
characters/chats/cold storage `0952e2113` (`767db8df3`), S6 exporter `adc90f97d` (`ac5c6fd05`), the
S4/S6 round trips and one asset walker `d9532709e` (`0e6317f92`), S5 import worker, routes and
dialog `070543198` (`0a6484846`), S7 export routes and button `5bf1f82b8` (`6513a4906`), S8 check
script `77696af7f` and checks `74f770e19`. Decisions: the user's U1 (upstream formats get a
one-way migration; formats from metatron's implementation phases do not), U2 (import and export),
U3 (full replace with a safety snapshot), U4 (Risu Account backups refused); the defaults D1–D13
were taken (worker decode with caps, groups imported, cold pointers kept and reported, selection
applied, chats bound to the selection, one model preset per upstream preset, keys asked at export,
inlays counted not exported, `\x07`/`\x08`/`\x09` accepted, the tab's model preset for every
exported preset, en and ko strings, metatron-only chat fields stripped, the changed-since-review
409 re-ask). S8 ran upstream's own decoder and boot defaults (`util/upstream/checkBinCompat.mjs`,
pinned at `669b12ce`) on synthetic exports and on the user's real backup and its exports (counts
only), and drove the import, a send, both exports and a re-import with a second tab in a browser.
Still open:

- A restore of an export in upstream RisuAI's own app (the user's step: the slice may not install
  or start upstream); upstream's `LoadLocalBackup` reader and asset writes, `makeColdData`,
  `cleanChunks`, plugin loading and UI are not run by the check script.
- A completed send on imported data (S8 checked dispatch only, no key used); the real backup's
  selected model is a plugin model whose plugin is not in the backup, so its chats cannot send
  until the user picks another model or installs the plugin.
- The export prepare's synchronous work was measured on a small store only (self-host-server
  Known Hazards).
- S7: the client sending `selectedChat` has no test (checked by hand in S8); a shutdown during a
  prepare has no test.
- S5: a worker that exits cleanly without a result and a generation job ended by the commit's
  maintenance have no test; the Docker image was not rebuilt.
- S6 accepted minors: without keys `authRefreshes` is written as `[]` even when the store had
  none; a chosen slot whose credential no longer exists does not keep its field, so a later slot's
  key can take it.
- S3 accepted minors: a repaired model-preset reference is reported by its generated id;
  `loreBook: null` is reported where upstream fills the default silently; `autoTranslate` and
  `htmlTranslation` are reported as removed although metatron keeps them per chat; rethrowing
  unexpected errors has no test.
- S2's 11 tests were written after Sol's review and not reviewed by Sol.
- S1: Docker image not rebuilt since the msgpackr pin (native `msgpackr-extract` in the image
  unverified); Firefox, Safari and Vite's bundling of msgpackr 2.0.6 beyond `pnpm build` unchecked.

Audit Findings and Performance Leftovers (the 45 findings of the two 2026-10-15 audit reports,
audited at `757f07da1`, merged with the performance leftovers then in the project memory) landed
every fix slice on metatron between 2026-10-15 and 2026-10-17: 1a–1d (shared-server hangs: PERF-01,
MEM-01/02, LLM-03, UI-01/04), 2a–2f (data loss: GEN-01, JOB-01/02, UI-02/03, DATA-01, PERSIST-01,
IO-01–04, EXT-01), 3a–3h (performance) and 4a–4f (compatibility: GEN-02–04, API-04/06, LLM-01/02,
EXT-02/04, SP-I1, NET-02, MEDIA-01–05, WEB-01–03). The archived Status line, per-slice Landed notes
and index table name each slice's tests, stale tests and deferrals. Phase 0 was absorbed: 4f
repaired the two first-load e2e fixtures and `measureChats.mjs` takes `CHUNK_MS`. Phase 5 (the
browser checklist) was not run as one session; the user retired the plan on 2026-10-21 after
verifying it through everyday use. Still open, per slice:

- 3a: jobs still parse the whole `modules` records and every preset and section (reading only
  what the job resolves needs a process-wide parsed cache keyed by revision); `loadRequestDb`
  re-reads every settings record per job and per `presetChain` pick; the Lua character setters
  (`patchCharacter`) parse the record about five times per call.
- 3c: no HTTP compression (a `compress` scoped to `/api/resources/read` is the candidate for a
  remote deployment); `hydrateAll` still ships the whole chat per callback barrier, and `resync`
  reads whole.
- 3d: inlay audio/video object URLs stay pinned; the recorded design is a URL-free placeholder
  from the parser (`<source data-inlay-src="<key>">`).
- 3e: the temporary 100k-asset probe was removed; permanent scale tests were left for later.
- 3f: Firefox/Safari and far-row containment unchecked.
- 3g: still whole: creates, patches no smaller than the record, server `enabledModules`/
  `authRefreshes` writes and job owners' `resource` events; imports and other whole-write callers
  publish plain refs. 3h: the first filter query after an edit
  copies the field once.
- 4c: the global NanoGPT subscription state across profiles; flat keys for the media, memory and
  count rows and the Google/Anthropic/OpenAI discovery lists; `getFreeOpenRouterModels`.
- 4d: the sandbox RPC still logs request bodies and headers (`factory.ts` `Original request:`); an
  abort after the response headers does not reach the host; `internal:graphmem`/`internal:risuai`
  act on the selected chat on the browser path; `providerOptions`/`customProviderStore` are not
  reset on reload; no real-iframe check.
- 4e: VOICEVOX stays on raw `fetch`; `runVITS` playback cannot be stopped; the Stop entry's
  visibility is untested.
- 4f: no server fallback for a share POST without a worker; shares and other deep links before
  first setup; an installed app keeps `/receive-files/` until its manifest refreshes;
  `window.innerWidth` read at mount only; no physical-device check.
- Phase 5 items not checked by a dedicated session: the Web Push browser matrix, the service
  worker's MIME and Range handling (everything served as `image/png`), and the load-only flakes
  (`cbsLimitsHost.test.ts` "does not yield between quick effects", `checkServerJobMatrix.mjs`
  setup).

Timing-Dependent Tests (from the 2026-10-19 timing inventory, refreshed 2026-10-21) landed every
slice on metatron between 2026-10-21 and 2026-10-22:

- Slice 0 added the `pnpm test:overload` runner.
- The cause slices 1-8 and the sweeps 9a/9b followed. The archived Status line and the per-slice
  Landed notes give each merge.
- Close-out 10 (`887d360c0`, `0c193b678`, `2508dfd0c`):
  - The first whole-gate runs under load failed mostly on Vitest's 5 s default in CPU-bound tests.
    That led to the user's decision D5: the gate's timeout is a 60 s hang guard, and
    `test:agent --slow-tests` lists slow tests on request.
  - It fixed four scheduler races.
  - It passed three overload runs and four parallel suites.

The inventory `docs/audit/timing-dependent-tests-2026-10-19.md` is complete. It is a historical
record: a new real-time dependency is a V3 violation, not a new row. Still open:

- Kept by decision:
  - `prepareCpuMs` is an inert test-only pool option.
  - Slice 5a's exception stands: the boot-subject `scriptWorker` tests keep real cold worker boots
    under an explicit 60 s.
  - The `scriptWorker` cases "summed across them" and "right after a resumption" stay gated,
    although under load they can pass without exercising their distinction. Summation also has a
    deterministic `luaRuntimeCharge` test.
- `resourceSyncChats` still has `vi.waitFor(..., { timeout: 5000 })` polls on real time.
- The slowest gated test, `importRealm` "refuses a card or asset chunk over
  MAX_PNG_TEXT_CHUNK_BYTES...", takes 2-4 s alone and about 27 s under the overload.
- Gated explicit 60 s timeouts now repeat the default and could go.
- A test body that outlives its timeout can still reach the next case's fake (seen in
  `exportBatches`).
- Test copies of production constants: `SAVE_DEBOUNCE_MS` in `mutationStoresHarness.ts` copies the
  unexported production `DEBOUNCE_MS`.
- Coverage gaps:
  - A CharX entry exactly at the cap is untested.
  - `mcpSse`'s scan bound has no slack.
  - Other partial `vi.mock(importOriginal)` mocks were not audited for Vitest 4 keeping the first
    registry across `resetModules`.
- Production: `chatStore.svelte.ts` `isMember` scans a character's chat list through a proxy, so
  per-character work grows quadratically with the chat count.

## Server-Owned Data Chronology

These boundaries matter to old saves, archives, and fixtures. This chronology was
moved from `STRUCTURE.md`; the compact router links here instead.

| Step    | Change                                                                                                    | Last commit |
| ------- | --------------------------------------------------------------------------------------------------------- | ----------- |
| Phase 0 | Shared schema and server resource store                                                                   | `a82359f7`  |
| Phase 1 | Per-collection resources; block save and remote saving removed without migration                          | `46d63674`  |
| Phase 2 | Server chat records, explicit mutation API, generation fence                                              | `577c43ae`  |
| Phase 3 | Settings sections/collections (store version 3), no root record, preset/persona ids, separate credentials | `e9e608ad`  |
| Phase 4 | External contracts write through mutation modules                                                         | `ce43f2b9`  |
| Phase 5 | Server generation, prompts, scripts, providers; `12ed3bae` cutover removed browser generation             | `ee57e2e9`  |
| Phase 6 | Thin client, write-through records, live updates, lazy chats, no whole-database object                    | `9d09288b`  |

## Remaining Follow-Ups

These are retained design/verification debt, not unimplemented versions of the
features above. Confirm current code and the owner's Known Hazards before acting.

- Model profiles: named keys for remaining `/proxy2` auxiliary operations and
  `getFreeOpenRouterModels`; a distinct `submodel` slot (O3); global provider toggles
  moving to profiles (O7: `openrouterMiddleOut`, `openrouterFallback`, caching,
  `autofillRequestUrl`, `reverseProxyOobaMode`, `vertexRegion`).
- Translation: optional phase 4 (greeting translation and bilingual partial edit),
  plus manual bilingual-display verification.
- URL routes: manual checks on desktop Chrome, Android Chrome/PWA, and iOS Safari,
  including H1 and its fallback if those checks fail.
- Web Push: real browser permission/subscription/reload behavior, hidden/closed and
  visible-tab completion without duplicates, notification click routing, Firefox,
  Android PWA over HTTPS, available iOS Home Screen app, insecure-LAN fallback,
  and service-worker update behavior. These were not run by this documentation audit.
- Request history/diagnostics: full viewer/error-alert workflow across request
  sources, content-off rows while earlier content stays, restore leaving history
  unchanged, and production Docker+sftp isolation. Verify the restricted account
  can read `state.json`, `events/`, `reports/`, and `shared/` but cannot read
  `save/data/`; pull a job share, withdraw it, and save/pull a phone browser report.
  The application does not configure the sftp account or chroot.
- Per-chat toggles/presets: drop the read-only legacy `globalChatVariables`
  collection with a one-time seed of each chat's map after a release has passed;
  decide an explicit default in the toggle grammar (a cross-user `.risup` format
  change); similarity sorting and partial apply; `.risutoggle` export/import;
  plugin, MCP, and chat-command exposure of presets; writing toggle values from
  CBS, Lua, or triggers.
- Toggle preset persistence/cache: `togglePresets` saves as a whole record, so two
  tabs saving at once can drop one tab's new preset while its chat link lands as
  "deleted". Every collection, including this one, enters the job scope and
  render-cache key, so saving a preset invalidates cached renders. An exclusion
  list in `server/src/jobs/jobScope.ts` would avoid that unnecessary invalidation.
- Per-chat toggle verification: browser checks still to record for isolation
  across two chats of one character, New Chat under both inherit/empty policies,
  and prompt info showing the chat's values. Record the dedicated
  `e2e/0-idleReload.spec.ts` result too; the slice 4 smoke already checked idle
  reload, preset workflows, reload persistence, preview controls, and mobile
  width. Archiving does not certify these remaining checks.
- Large asset import/export, browser checks not run: a 4,000-asset PNG import's
  request count and heap (slice 3c), the paged emotion table and the lazy icons in
  the sidebar rail, folder drag, catalog, and persona list (4a, 4b), the asset
  client's 429/503 retry (1a), and Chrome's answer to a pre-body refusal
  (409/413/503) on `/api/import/module` and `/api/import/charx` (status or network
  error, and whether a reset keep-alive socket resends the POST).
- Large asset import/export, untested paths: zip64 and offsets past 4 GiB on real
  CharX files (the client zip reader in `src/ts/process/zipFile.ts` refuses wrapped
  offsets without zip64), the `App.svelte` drop handler, and the `charxJpeg` export.
- Large asset import/export, known limits kept: no upload progress on the file
  imports (`fetch`); the Vite dev proxy keeps Node's 300 s `requestTimeout`; a CharX
  entry the card references but the server excluded still throws `asset … not
found`; the in-tab `CharXImporter` (test-only) keeps fflate's signature hazard
  and per-item writes; `PngChunk.readGenerator` never cancels its reader when a pass
  stops early; export memory is bounded by two read batches, not by bytes; PNG
  import progress moves per 500-asset batch and picker saves show no progress;
  ONNX members inflate synchronously on the main thread; hub-mode card assets are
  fetched without retry. The backup export's abort hang and the emotion table's
  `bind:value` throw after a delete are Known Hazards in their guides.
- Large asset import/export, eager icon lists left: the `selectChar` alert in
  `AlertComp.svelte` and `CharConfig.svelte`'s group member list.
- Large asset import/export, deferred out of the plan: the Safari/WebKit streamSaver
  fallback that keeps whole exports, "Export All Chats" building a whole history, the
  one-time legacy browser-local inlay migration, and unbounded persona and preset
  decoders.
- Sidebar chat status:
  - Unseen/recovery marks are per tab and dropped by a reload (decision 4).
  - A chat generating in another tab and not loaded here shows nothing (decision 5).
  - `SideChatList.svelte` rows have no badge; the home cards got theirs in slice 3.
  - The badge's `title` tooltip does not show because it takes no pointer events;
    the status is in the row's name instead.
  - The generating badge also shows on the open chat's own pin and folder (while collapsed).
  - The recovery badge requires a manual check with the server killed mid-stream;
    this archive did not run that check.
  - The browser check's `--base` production mode was implemented but not exercised.
- Open bug fixes:
  - Not checked in a real browser: P1 (a browser unsubscribe failure, the banner's failure
    alert, a notification click from an uncontrolled window), M1 (Stop during VITS playback),
    C8 (a preset switch, a tab return, the credential link's focus, the Thanks page offline),
    S2 (a real `@hono/node-server` socket abort mid-download), C5 (the `.risum` drop).
  - A3: with the parent character's create answer also lost, a same-id re-add now fails loudly
    (the flush rejects) instead of silently, but the replacement's chats still do not reach
    the server; the cause is `recoverFromConflict`'s `sameJson` branch in `resourceSync.svelte.ts`.
  - C5: a `#share_module` whose save a conflict discarded still has its pending share cleared
    (a retry would add the module twice).
  - C1: the fixed `exportLoreBook("sglobal")` has no caller in the current UI
    (`LoreBookSetting` is never mounted with `globalMode`).
  - C8: `SettingSelect.svelte` still writes its fallback when its context is rebuilt (a Known
    Hazard in `settings-i18n.md`); the de/es/vi streaming help text still claims the 0.125 s
    throttle.
  - C2, P1, I1 added strings to `en.ts` (and `ko.ts` where translated); the other locales
    show them in English.
  - Owner decision left open: lore regex keys containing a comma are split on every comma
    (`shared/lore/activation.ts`); tests pin it.
- Boot resource cache:
  - The reporting user has not compared DevTools Timing on their server before and after.
  - Only headless Chrome was checked: no Firefox, Safari, mobile, or private-window run.
  - A browser's first boot still downloads the whole compressed read (6 s at 10 Mbps on
    the measured data); chats are not cached (chat summaries are always sent); the
    client's work after the read is unchanged.
  - No sign-out calls `clearBootCache` yet.
  - A `risu-boot-cache` database another opener created at version 1 without the stores
    makes every load fail and fall back without clearing it (only another script on the
    origin can create one).
  - Found while measuring, outside the plan: the app's static files are served with
    `Last-Modified` only (no `Cache-Control`, no 304 for `If-Modified-Since`, no
    compression), so once Chrome's heuristic freshness lapses a boot downloads the
    app's ~3.8 MB of scripts in full again.
- Heap memory reduction:
  - Found by M0, not sliced: opening a character's settings loads a tokenizer BPE model
    (~49 MB) on the main thread and keeps it; the settings tokenize the description and
    first message on the main thread (17–22 s for a 1.7 MB description); `loadTokenize`
    passes an undefined note on a closed-chat character switch (an error alert).
  - D3 candidate: a Svelte `Batch` kept alive by an `{#await}` block holds the previous
    `parserAssetInputs`, so a server-deleted module's assets stay reachable (+17.2 MB in
    the driver's `boot-module-delete` step, measured but unchecked).
  - D2b accepted: without a working service worker every distinct file shown keeps a Blob
    of its bytes for the page's life (40.5 MB in the fixture); inlay audio/video object
    URLs stay in both modes. The fix needs releasable avatar sources and a URL-free
    placeholder for parser output, `fileSrcCache` with it.
  - B1/B2: a same-record unproxied list or tuple assigned to a module's `assets` is frozen
    in place (later edits through its source wrapper throw; no production writer does
    this); a same-id `replaceCharacterRecordAt` with the character's own frozen list
    re-stamps that field; in DEV `module.assets = module.assets` nests Svelte's
    inspectable proxies.
  - C2: rows `Chats` trims keep their sheets for a few frames; a CSS-only change does not
    re-observe a `.far` row; a sheet is made again after a real gap; plugins that serialize
    a row get the inert placeholders; layers declared inside an imported file are not
    detected.
  - D1: a throwing mutator's shrink, a local field replacement's cached node, other by-id
    lists, nested containers' Svelte targets, `defineProperty` length sets and deleted ids'
    per-character metas are not pruned (all bounded by installed data or small).
  - Drivers: the loader/dominator unit test is not written; readiness and cleanup in
    `measureHeap.mjs` and `measureFileSources.mjs` check `exitCode` only (a signal-killed
    server child is missed); no server-side egress accounting; the user's own style and
    real font files were not measured.
- Search:
  - Slice 1: the native `<select>` popup was not seen in a real desktop browser (headless
    Chrome does not draw it); check Settings › Display on the `light` scheme with a dark OS
    and on `dark` with a light OS.
  - 2a: the matcher's case fold is `toLowerCase` plus a final-sigma fold, not full Unicode
    case folding (ſ/S, ϐ/Β).
  - 2b: no browser check of drag being off while filtered, folders shown open, and drag
    returning after clearing; a row renamed under the filter hides once its name no longer
    matches.
  - 2c: an entry added while filtering is hidden at once (its fields are empty); no
    "no results" line (needs an `en.ts` key); a detail open inside a folder closes when the
    next query drops that folder; `onEnd` of a drag that started before the filter is untested.
  - 3a: the navigation page and Model tab labels are repeated in `searchIndex.ts`
    (`PAGES`, `MODEL_TABS`) because `Settings.svelte`'s `navGroups` cannot be imported.
  - 3b: 390 px mobile, Firefox, Safari and the Korean UI were not browser-checked.
  - 4a: an unauthenticated request answers 400 `No auth header` (the server's rule), not the
    plan's 401; `shared/diagnostics.ts` `ROUTE_TEMPLATES` gained the path.
  - 4b: `Chats.svelte`'s 700 ms latest-message auto-scroll ignores `suspendTrim` and can undo
    a finished jump (the bookmark jump too); Escape with Settings open above the panel closes
    the panel; the previous error line stays visible during the next debounce; a real large
    database was not measured (the real saves on the machine were 352 KB).
  - Not in the plan: `prose-invert={$ColorSchemeTypeStore}` in `AlertComp.svelte` and
    `MultiLangDisplay.svelte` is always truthy; the persona list itself has no name filter.
- RisuNest small wins:
  - T1: an iframe's `contentWindow.parent.WebSocket` (the backing window) stays unguarded;
    `build-test-platforms.md` `Files` does not list the three root `vitest.testNetwork*`
    files; raw `node:http`/`net`/`tls` sockets, worker threads and child processes are not
    guarded.
  - P1: no browser check of the "Unsupported API" badge or the real-iframe expiry; a
    `nativeFetch` without a `signal` is not aborted by `terminate` (its late body is
    cancelled); a hash failure that recovers reports the plugin once more.
  - E1: `util/` stays outside `pnpm check`, so `testInventory.mjs` and its test are not
    type-checked.
  - P2: no browser check (two tabs or devices, a reload deferred during a generation); the
    `onStart`-throw follow in `serverCommands.ts` is untested; with D4 plugin work that never
    ends defers the reload until a local reload (`plugins-mcp.md` Known Hazard).
  - K2: not yet run on the real GitLab Runner (`$CI_PROJECT_DIR` expansion and the cache upload
    unverified); the Runner's Docker executor needs a tmpfs `/tmp`
    (`server/src/tests/resourcePatchParts.test.ts` runs past 5 s on a disk-backed `/tmp`) and
    must accept untagged jobs; "Auto-cancel redundant pipelines" must be on for
    `interruptible`.
  - A1: `e2e/terminalNotice.spec.ts` not re-run; found outside the slice (project memory): a
    job's status alert left after the job ends, alert keys ignored while a text input has
    focus, `alertClear` clearing another job's status, the branches/HypaV2 dialogs reading
    the selection late, a gated Escape still closing the settings, `makeGroupImage` leaving
    its wait.
  - S1: GUI HTML gating under `SafeModeStore` not checked in the browser or by a unit test;
    `STRUCTURE.md` S1 and `ui-theming.md` still describe safe mode as custom CSS only;
    `bootstrap.safeBoot.test.ts` duplicates the service-worker test's mock preamble; a
    plugin whose script throws at start fails every boot it runs in (`app-shell.md` Known
    Hazard); modules, global regex and Lua (server-side per job) cannot be turned off.
  - Known stale test untouched by the plan: `server/src/tests/importPngCaps.test.ts` fails
    on a clean tree (`{ total }` expected, `card` also returned).
- Consolidated browser/production verification debt was tracked in the audit/performance
  plan's Phase 5, now archived; its still-open items are listed with that plan's entry
  above.

## Archive Procedure

Remove a completed/retired plan and its active-list link, then add its last existing
commit/path, current guide ownership, and unresolved follow-ups here. Verify with
`git show <commit>:<path>` before deleting it. Keep operational contracts in current
guides rather than asking readers to load a historical plan.
