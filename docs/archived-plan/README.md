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
git show f98be8d41:docs/plan/hypav3-background-memory.md
git show b9525d08d:docs/plan/per-chat-send.md
git show 2e359afde:docs/plan/static-audit-fixes.md
git show 2e359afde:docs/plan/chat-checkpoints.md
git show 2e359afde:docs/plan/small-fixes.md
git show 2e359afde:docs/plan/direct-asset-urls.md
git show 2e359afde:docs/plan/server-thumbnails.md
git show 2e359afde:docs/plan/server-tokenizer.md
git show 2e359afde:docs/plan/generation-stage-spinner.md
git show 2e359afde:docs/plan/upstream-integration.md
git show 2e359afde:docs/plan/combined-run.md
git show 12fd77196:docs/plan/combine-audit-fixes.md
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
| HypaV3 Background Memory                 | `f98be8d41`: `docs/plan/hypav3-background-memory.md`                      | [memory](../structure/memory.md), [persistence](../structure/persistence.md), [chat pipeline](../structure/chat-pipeline.md), [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md), [settings](../structure/settings-i18n.md)                                                                                                                                                                                                                                |
| Per-Chat Send                            | `b9525d08d`: `docs/plan/per-chat-send.md`                                 | [chat pipeline](../structure/chat-pipeline.md), [plugins/MCP](../structure/plugins-mcp.md), [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md), [persistence](../structure/persistence.md), [global API](../structure/global-api.md)                                                                                                                                                                                                                       |
| Static Audit Fixes                       | `2e359afde`: `docs/plan/static-audit-fixes.md`                            | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [plugins/MCP](../structure/plugins-mcp.md), [media/translation](../structure/media-aux.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                 |
| Chat Checkpoints                         | `2e359afde`: `docs/plan/chat-checkpoints.md`                              | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                                                                                                             |
| Small Fixes                              | `2e359afde`: `docs/plan/small-fixes.md`                                   | [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md), [settings](../structure/settings-i18n.md), [LLM requests](../structure/llm-requests.md), [memory](../structure/memory.md), and the other guides its slices name                                                                                                                                                                                                                                        |
| Direct Asset URLs                        | `2e359afde`: `docs/plan/direct-asset-urls.md`                             | [build/test platforms](../structure/build-test-platforms.md), [CBS/rendering](../structure/cbs-rendering.md), [global API](../structure/global-api.md), [server](../structure/self-host-server.md)                                                                                                                                                                                                                                                                                           |
| Server Thumbnails                        | `2e359afde`: `docs/plan/server-thumbnails.md`                             | [build/test platforms](../structure/build-test-platforms.md), [global API](../structure/global-api.md), [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                                                 |
| Server Tokenizer                         | `2e359afde`: `docs/plan/server-tokenizer.md`                              | [build/test platforms](../structure/build-test-platforms.md), [LLM requests](../structure/llm-requests.md), [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                                             |
| Generation Stage Spinner                 | `2e359afde`: `docs/plan/generation-stage-spinner.md`                      | [chat pipeline](../structure/chat-pipeline.md), [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                                                                                                         |
| Upstream Integration                     | `2e359afde`: `docs/plan/upstream-integration.md`                          | [persistence](../structure/persistence.md), [plugins/MCP](../structure/plugins-mcp.md), [LLM requests](../structure/llm-requests.md), [chat pipeline](../structure/chat-pipeline.md), [backup sync hub](../structure/backup-sync-hub.md), [UI/theming](../structure/ui-theming.md), and the other guides its slices name                                                                                                                                                                     |
| Combined Run index                       | `2e359afde`: `docs/plan/combined-run.md`                                  | the eight plans above (one `plan-runner` run); [build/test platforms](../structure/build-test-platforms.md) for the run's checks                                                                                                                                                                                                                                                                                                                                                             |
| Combine Audit Fixes                      | `12fd77196`: `docs/plan/combine-audit-fixes.md`                           | [scripts/triggers](../structure/scripts-triggers.md), [UI/theming](../structure/ui-theming.md), [LLM requests](../structure/llm-requests.md), [global API](../structure/global-api.md), [server](../structure/self-host-server.md)                                                                                                                                                                                                                                                           |

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
- 3d: resolved for direct mode by Direct Asset URLs (2026-10-23): with a capable worker
  controlling the page, inlay audio/video use direct asset URLs with their real MIME type and
  no object URL. The fallback (no worker or capability off) still makes typed object URLs
  that stay for the page.
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
- Phase 5: the worker's MIME and Range handling was resolved for direct mode by Direct Asset
  URLs (2026-10-23): `/api/asset/*` sends the extension's MIME, single ranges (206/416), and
  validators, and the worker passes `Range` through; Chromium video seeking was checked through
  signed 206 responses. The capability-off fallback's `/sw/img/` entries still use `image/png`
  without Range. Still not checked by a dedicated session: the Web Push browser matrix and
  the load-only flakes (`cbsLimitsHost.test.ts` "does not yield between quick effects",
  `checkServerJobMatrix.mjs` setup).

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

HypaV3 Background Memory (written and verified in three Astra rounds on 2026-10-22, `96f145515`)
landed all 13 slices on metatron between 2026-10-22 and 2026-10-23:

- The parts, planner, and hooks (1a, 1b), the preset's `gapConfirmTokens` and the settings
  warnings (2), the preflight contracts and stop control (3a), and the prompt assembly with
  per-summary saves, select-only sends, the gap question, and hand-offs (3b).
- The tab's question and progress (4), the chat source generation (5a), the detached memory host
  (5b), the task service (5c), its server wiring, `memoryTask` frame, and routes (5d), and the
  tab's status, badges, and modal fence (6).
- Activation (7, `7314d2cc0`): production sends select stored summaries and the server's task
  writes new ones after `done`; blocking stays for a Plugin-format `memory` slot and applicable
  request triggers. The guides (8, `efb0c8a67`) describe the result.
- The final checks on `f98be8d41` passed except the known `importPngCaps` slow failure and one
  load flake in `characterCardsRoundTrip.test.ts` (CharX asset admission) that passed alone and
  in a full rerun.

Its D14 (the checkpoint load's memory fence) moved into `docs/plan/chat-checkpoints.md` as D12 and
slice 3's load and tests. Still open:

- No browser check: the progress overlay and "Stop here and continue", the sidebar `memory`
  badge, the modal fence (including after a reconnect), "Summarize now" and "Cancel".
- `server/src/prompt/tokens.ts` `countWithGoogle` has no signal or timeout: a stalled count holds
  a job or a memory task until the deadline.
- Stale wording since activation: the `MEMORY_TASKS_PATH` comment in `shared/events.ts`, the
  `memoryTasks.notEnabled` locale text ("yet"), and a `chat-pipeline.md` Known Hazard that says
  production passes no service.
- Accepted from the slices: the planner tokenizes every window before the first request (1a);
  an abort during the rate limiter's wait is untested (1b); a task's abort callback may emit a
  duplicate `queued` event for the same task id (5c).

Per-Chat Send (written 2026-10-23 at `fc4d52c5e` after a Luna survey of every `doingChat` reader)
landed all 7 slices on metatron on 2026-10-23. The tab-wide `doingChat` send flag is gone: different
chats of one tab send at the same time, and a chat refuses a second local send of its own as the
server refuses a second job.

- The local send registry `src/ts/process/localSends.ts` with the fences, suggestions, translator,
  and plugin reload deferral reading it (1, `2d9d63b41`), channel deadlines that start at dispatch
  (2, `bf6146918`), and the streaming display per chat (3, `aa99e20ca`).
- The other send callers check their own chat (`isChatBusy`) and previews return their result
  (`previewChat`) (4, `bd0cddb4c`); the flip: `sendChat` refuses per chat, Stop per chat
  (`sendAborts.svelte.ts`), auto mode bound to its chat (5, `371c01767`).
- A completion notification tag per chat, the accepted limits in `chat-pipeline.md`, and
  `e2e/perChatSends.spec.ts` (6, `23ca77680`).
- Slice 7 (`c9e6cde40`) was added mid-run (D8) for two hazards slice 5's review found: a cancelled
  callback now keeps the tab's channel lane until the tab reports it drained
  (`POST /api/generations/:id/drained`) or `CANCELLED_CALLBACK_DRAIN_MS` passes, and an aux request
  names a callback as its parent only from that hook's `PluginCallContext.channelCall`.
- The final checks on `b9525d08d` passed: `pnpm check`, `pnpm format:check`, 6413 unit tests, and
  the 11 e2e specs the run reached (25 tests).

Decisions: the per-tab callback lane stays (D1); same-character field last-writer-wins,
`CharEmotion` sharing, global `stopTTS`, and the single `alertWait`/`progress` slot are accepted and
documented (D6). The shared composer (text, attachments, input translation) was left out of scope.
Still open:

- No browser check: Web Push per-chat tags and their dismissal, auto mode ending on Go Back, a
  resumed job's Stop overlapping another chat's send, a slow v3 plugin hook stopped in one chat
  while another chat runs; `util/playwright/checkServerSend.mjs`, `checkServerJobMatrix.mjs`,
  `checkMcpFixes.mjs`, and `checkStreamingModes.mjs` were not run.
- Accepted from the slices: plugin `sendChat` is refused while any channel callback runs in the tab
  (4); a cancelled hook that never settles keeps refusing the tab's later roots until a reload (7);
  body interceptors, provider streams, and `internal:aiaccess` requests are no longer callback
  children (7); with no owner attached, queued requests expire one after another (2, D2 (a)).

Combined Run (planned 2026-10-23 at `7bcdb8030` as one `plan-runner` index over the eight plans
below, 77 slices with ids prefixed per plan and one added re-planning slice ST0) landed every slice
on `metatron` between 2026-10-23 and 2026-10-24, one cherry-picked commit per slice followed by a
`docs(plan)` Status commit, up to eight slice sessions at once (`delegate-implementation`, Codex
implementers and challengers), with the owner starting each session from a card. The final checks
on `b60d8fff5` passed: `pnpm check`, `pnpm format:check`, `pnpm check:tests`, 6801 unit tests, every
e2e spec (17 specs, 35 tests), `pnpm build`, `docker build`, and a container smoke on a fresh volume
(password setup, login, ES256 JWT, `/api/tokens/count` for the o200k fallback, `llama3`, and
`cl100k_base`, `/api/asset/<hex>?w=256` as `image/webp`, a small PNG's 307, `?w=999` 400, no JWT
401). The eight source plans keep their design and slice text; their Status lines name each slice's
`metatron` hash. The index's Status line is the per-slice record in landing order.

Static Audit Fixes (the 2026-10-23 static audit's data-loss, network, and resource findings,
`docs/audit/static-audit-2026-10-23.md`) landed all 14 slices: SA1 Toggle preset additions merge across tabs (`84ff35294`); SA2 An adopted character create learns its chat order (`ada2e3139`); SA3 Refused data stays protected and can be released (`4f545bc02`); SA4 Refused data is shown with export, retry, and discard (`072e0f68d`); SA5 The live feed backs off until reconciliation succeeds (`8a3a6d00b`); SA6 The restore watcher aborts its timed-out read (`8c6a67465`); SA7 Image generation takes a signal; ComfyUI polls its prompt only (`5bcc152a7`); SA8 Stop aborts TTS requests and retries (`fda8d2b35`); SA9 The upstream export prepares in a worker (`f3c4b942a`); SA10 The local model queue admits by count and bytes (`c317b2bd4`); SA11 Job callbacks abort image work (`99ad3aada`); SA12 Durable writes for assets, snapshots, push, and diagnostics (`9c460b847`); SA13 Auth files are durable, damage-safe, and rate limited (`aaa118e9e`); SA14 Queued callbacks fail together when nobody is attached (`3811ebfd9`). Still open:
no two-tab browser check of the toggle preset merge (SA1); the refused-data banner's placement on
mobile, Firefox, and Safari (SA4, checked in Chromium at 1280×800 and 390×844); Stop and cancel
against real providers (ComfyUI, Wavespeed, a live provider request; SA7, SA8); the export worker's
effect on a large store was not re-measured (SA9); durable writes on Windows, macOS, and network
mounts and under real power loss (SA12); first-run setup and the damaged-password state in a browser
(SA13). Accepted: a Retry or edit on a stale revision is a normal 409 recovery that drops the draft
with a reload notice (SA3); manual trigger commands still answer 500 and WebLLM translation 502 for
a local-model refusal (SA10, project memory); SA14 settles ownerless queued roots `disconnected`
together only for jobs opened at or before the expired root's dispatch (the orchestrator accepted
the narrowing on code grounds; `self-host-server.md` Known Hazards). SA2 closed the open-bug-fixes
A3 leftover, removed from this file.

Chat Checkpoints (RisuBard save slots, `docs/research/risubard-survey.md` §2.3.1) landed all 6
slices: CC1 Checkpoint tables and store (`b8b75f2e6`); CC2 Snapshots, restore, and archives carry checkpoints (`8f16dd41e`); CC3 Routes, load, restore floor, and the busy check (`30dfc52cf`); CC4 Auto-checkpoint after a finished job (`a5398dd28`); CC5 Client checkpoint module and dialog (`f3635120b`); CC6 Persistence guide update (`56a21a914`). Measured (CC4, a 2000-message chat of about 10 MB): an auto checkpoint
takes about 110–170 ms synchronously when it saves and about 30 ms when nothing needs saving.
Still open: one browser check of the Checkpoints dialog's auto-policy row against the real policy
routes (CC5 was checked with an adapter stand-in before CC4 landed); Firefox, Safari, and mobile
layouts (CC5). Client checkpoint rules are in `persistence.md` (CC6); the restore floor's
`fmIndex` edge and the unreported order-conflict discard stay as project memories.

Small Fixes (independent small defects left by finished plans and the fork research) landed all
12 slices: SF1 Keep TLS keys and plugin request logs private (`8541758af`); SF2 A failed request stream answers 400 on every route (`b34906a7d`); SF3 Google token counts have a timeout (`5b015c118`); SF4 Static files get cache headers and 304 (`d73df7c0a`); SF5 A reverse proxy's WebLLM format runs the configured model (`8a756cfd3`); SF6 Sidebar, list, and theme fixes (`c64dfe7c6`); SF7 Lorebook editor fixes (`b06d449af`); SF8 Alert keys over the composer and a rejected Escape (`3bf30c779`); SF9 HypaV3 bulk resummary Cancel and selection (`08c12e1db`); SF10 Streamed auto-translation translates once (`fd26e2dd9`); SF11 Locale text and stale docs (`921913f98`); SF12 Stale slow test and test platform notes (`583505ebf`). Still open, all browser checks: static-file cache behavior (SF4); a real
Transformers.js inference for the WebLLM model fix (SF5, harness stub only); the light-theme prose
color and dragging a chat into a new folder (SF6); a chat switch during a lorebook delete and a drag
after switching characters with details open (SF7); alert key handling, the mobile virtual keyboard,
Firefox and Safari (SF8); the HypaV3 bulk resummarize button (SF9, mount tests only); streaming with
auto-translation in Off, Balanced, and Strong modes (SF10); the 57 added Korean strings on screen
(SF11).

Direct Asset URLs (the 2026-10-20 research pick, PocketRisu/RisuBard decision 2) landed all 8 slices:
DA0 Probe the browser mechanics (`81015f89d`); DA1 The authenticated asset route (`22f1da897`); DA2 Verified content names become immutable (`2a7d338f8`); DA3 The service worker authenticates asset requests (`92c6d4b91`); DA4 getFileSrc returns direct URLs (`560a3d86c`); DA5 Inlay media and parser types (`52192c078`); DA6 Retire asset entries in risuCache (`c05c2bf88`); DA7 Docs, browser checks, measurement (`dd19f530b`). Measured (DA7, `util/playwright/measureFileSources.mjs`): direct mode keeps 0 object
URLs, 0 Blobs, and 0 `/api/read` reads at every step; without the worker the gallery keeps 51 object
URLs (40.5 MB), unchanged from D2b. Decisions: the worker passes requests outside its destination
allow list to the server unsigned (owner 2026-10-23); an immutable `/api/asset` copy in the HTTP
cache can answer an unsigned same-origin fetch such as a plugin's `nativeFetch` (accepted hazard,
`self-host-server.md`). Still open: Firefox (whether the Playwright control loss after an unanswered
navigation happens in real Firefox), Safari, iOS, and real devices (DA0, DA7); after a worker
update, a row whose fallback `/sw/img` URL is fetched by `fetchFileSrc` is refused, so copy-to-HTML
and screenshots omit that image until the row re-renders (DA7, Known Hazard in `global-api.md`).

Server Thumbnails (Haejeok survey candidate B1, re-planned by ST0 over the direct asset route) landed
all 6 slices: ST0 Re-plan Server Thumbnails over the asset route (`27b067220`); ST1 Thumbnail route and cache (`4a91a3af8`); ST2 Client thumbnail source (`a1c9d6b6d`); ST3 Lists and settings previews (`fdf16fd31`); ST4 Chat avatars (`e3f91c5c0`); ST5 Measurement, browser check, docs close (`e905d68dd`). Decisions: thumbnails are `GET /api/asset/<hex>?w=256|512` (short
side, `fit: "outside"`, WebP quality 80, `sharp` 0.34.5 loaded lazily); a small, animated,
non-raster, or over-cap source and a busy, unavailable, or failed encoder answer a 307 to the
query-free original (D10 (a), confirmed by the owner 2026-10-23); no user setting (D6); one request
per image (D7); the variant inherits the immutable-cache hazard and nothing more. Measured (ST5,
121 catalog images, production build): decoded pixel bytes 612.8 MiB → 42.8 MiB, server transfer
47.1 MiB of originals → 1.0 MiB of variants, 0 redirects; the no-worker fallback stays at 612.8 MiB.
Still open: a redirected image load through the worker on a phone and in Safari; the bookmark-list
avatars in a browser (ST4's rule, documented only); blur at device scale 3 or more with
`iconsize` 200 (ST5). Accepted: a forged strong variant tag on a small PNG gets a 304 instead of
the 307 (ST1); SVG and every non-raster source are never decoded on the server (ST1).

Server Tokenizer landed all 4 slices: TK1 Token count route (`7a7ca32e7`); TK2 Client tokenizer over the route (`940c7f8c3`); TK3 Editor counts on a delay (`a719cec11`); TK4 Payload move, removal, docs (`4227427ca`). Still open: typing in `CharConfig` shows a count
after the pause (TK4 skipped it because TK3 landed later); the capture scripts can no longer
re-capture token ids in the browser, so the frozen `browser-ids.json` is the reference (TK2, TK4;
project memory on the capture guard).

Generation Stage Spinner (`docs/research/chat-generation-stage-colors-analysis.md`) landed all 4 slices:
GS1 Stage contract and its retention in the job registry (`e1b49f057`); GS2 The runner reports its stages (`df489ec91`); GS3 The tab keeps each job's stage (`54e553623`); GS4 The spinner shows the selected chat's stage (`34c7fe355`). Still open: a visual check with a real provider (GS4; `.loadmove` has a 0.5 s color
transition, so a stage as short as a mock's blends); an attach replays only the current stage, so a
quick memory step can hide the first `preparing` (project memory).

Upstream Integration (ports of upstream RisuAI up to `f50b5942`, inventory of all 79 upstream commits)
landed all 23 slices: UP1 Current upstream block saves import (`ffc4d03aa`); UP2 Upstream plugin storage index imports (`3c80346dc`); UP3 The save harness gains the current upstream target (`43bb3c63d`); UP4 The guest bridge accepts only its parent's messages (`128e6949c`); UP5 The lite setter cannot change the plugin list (`052b6cad9`); UP6 SafeElement listeners attach to their element (`717a371f5`); UP7 Lore keep and don't-activate flags are per entry (`e555f2f0c`); UP8 HypaV3 contextual vectors keep their identity (`15ea7614f`); UP9 Gemini tool responses carry no role (`4b9d23ada`); UP10 CBS prefillsupported reads the model's flag (`5909b8dfc`); UP11 Claude 5 Opus and adaptive-only thinking (`9bd9501b6`); UP12 Gemini catalog entries and a unique id check (`e4ea7c5a3`); UP13 Wasmoon stops proxying JS objects (`385cc8da0`); UP14 Lua axLLM picks its model slot (`39f94aaff`); UP15 Lua image generation takes a NovelAI orientation (`3a9404635`); UP16 Lua form submission (`2285021da`); UP17 Select text does not clip in Safari (`9d85d9b8f`); UP18 Card export survives a missing portrait (`1bb7c82a3`); UP19 Creating a module adds it once (`0d0927d7c`); UP20 Realm creator blocking (`eb44b166c`); UP21 A chat parse error shows its stack (`695a13dc0`); UP22 Keep-alive audio counts as audible (`15503de1f`); UP23 Upstream ledger (`513808713`). The lasting ledger is `docs/research/upstream-ledger.md` (79
rows: integrated 32, equivalent 20, excluded 22, deferred 5 with revisit triggers; the intake
procedure for the next scan). Decisions: D2 reversed the Stop B lore flag choice (UP7); the
`--bin` harness gained the `current` target and the migration pass (UP3). Still open: importing a
`.bin` made by the real upstream app in a browser (UP1); the `current` harness target's migration
step fails on a backup with a `_coldpluginIndex` pointer because memory cold storage starts empty
(UP3, documented); real v3 plugins in a browser, including `getRootDocument()` scroll and key
listeners (UP4–UP6); real Gemini and Vertex requests for the tool round trip and the 3.6/3.5 Flash
entries, and the flags when an alias moves (UP9, UP12); a real NovelAI request and whether the
plan's `square` meant a specific side (UP15); submitting a `risu-form` card in a real browser
(UP16); macOS Safari and iOS for the select-text fix (UP17); exporting a portrait-less character
as PNG to see `reencodeImage` turn WebP into PNG (UP18); module create, cancel, and edit in a
browser, where opening the Trigger tab counts as content and asset bytes uploaded before a cancel
stay stored (UP19); whether the live Realm always sends `creator` (UP20); the alert details view
(UP21); Chrome's tab audio indicator and Android's media notification for the keep-alive audio
(UP22, whose upstream help text was not ported, project memory).

Combine Audit Fixes (drafted 2026-10-24 at `26d806d9e` from the Combined Run audit of
`d66b050dd..531759887`, the six defects an ordinary action reaches) landed all 6 slices on
`metatron` on 2026-10-24 in one `plan-runner` wave (`delegate-implementation`, Codex implementers):
1 Form controls stay usable with click-to-edit (`f1d753045`); 2 Delayed token counts follow the
tokenizer and CBS context (`081a58ba2`); 3 Screenshots keep thumbnail and original apart
(`27cf4d231`); 4 Thumbnail cleanup touches one key's entries (`58c459959`); 5 A disconnected token
count stops the server's work (`df4d8017e`); 6 The upstream export skips checkpoint history
(`8fa1b5ec3`). The final checks on `12fd77196` passed: `pnpm check`, `pnpm format:check`, 6815 unit
tests, and 56 slow tests. Measured (4, the audit's scan reproduction): filling 400 portraits visits
400 cache entries instead of 80,200. Decisions: only `risu-form` forms skip click-to-edit as a whole,
a plain form's text still edits (D1); an aborted count answers 400 (5); `THUMBNAIL_VERSION` 2 makes
every thumbnail regenerate once after the upgrade (4). Accepted from the slices: the lore entry's CBS
expansion now runs on every edit, and the plugin tokenizer map and a prompt template's CBS values are
not tracked (2). Still open: every Manual Check of the archived plan (a Lua form with click-to-edit,
a model switch with a lore entry open, a screenshot with a full-size `{{source::char}}` image, a
few hundred portraits after the upgrade, abandoned Google counts, an upstream backup from a library
with checkpoints restored in upstream RisuAI). Left for their own plans (the plan's Not In This
Plan): lost-create recovery past a checkpoint restore (audit F01, with the checkpoint policy test
harness and a summary-boot mode for `chatCheckpoints.test.ts`), a refused deletion becoming a
whole-chat replace after Retry (F02), completed `once` plugin listeners retaining detached DOM (F09);
the audit's evidence stays in `/home/codex/metatron-stage/combine-audit/evidence/`.

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
    of its bytes for the page's life (40.5 MB in the fixture); that baseline is unchanged.
    Direct Asset URLs (2026-10-23) removes this retention with a worker reporting the
    direct-asset capability and controlling the page: shown files keep no Blob and make no
    object URL. `measureFileSources.mjs` on 2026-10-23 (production build, 21 avatars,
    24 inlay images, 4 chat assets, 2 audio inlays) measured 0 live object URLs, 0 Blobs,
    and 0 `/api/read` at every step in `sw` (direct) mode, against 51 Blobs (40.5 MB)
    and 51 object URLs (49 `image/png`, 2 `audio/mpeg`) in `no-sw` mode. Still accepted:
    pages without a worker and sources created before a switch to direct mode
    (`fileSrcCache`, `mediaObjectUrls`) keep theirs for the page.
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
