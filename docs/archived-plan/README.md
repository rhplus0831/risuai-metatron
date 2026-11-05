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
git show a179640ad:docs/plan/chat-lore-overrides.md
git show 47c534f69:docs/plan/context-usage-meter.md
git show ca5b656fa:docs/plan/deep-audit-fixes.md
git show 1fc70e547:docs/plan/chat-lore-override-states.md
git show ae289ecf5:docs/plan/mobile-resume-reliability.md
git show 802a4840a:docs/plan/hypav3-token-budget.md
git show 1db8c10a8:docs/plan/display-evaluation.md
git show bbc747f24:docs/plan/durable-drafts.md
git show 73c12d29c:docs/plan/job-protocol.md
git show 2a8f7b93a:docs/plan/boot-bytes.md
git show aff71b423:docs/plan/per-event-server-work.md
git show 0009c22f3:docs/plan/server-byte-budgets.md
git show 78dbb078f:docs/plan/server-plugin-runtime.md
git show 786dfc3d3:docs/plan/guides-to-source.md
git show c34f69365:docs/plan/job-handoff.md
git show 72830e9f6:docs/plan/asset-lifecycle.md
git show c249c3a21:docs/plan/incremental-chat-transport.md
git show b37776a72:docs/plan/found-issues-sweep.md
git show a72c5f736:docs/plan/render-work-budget.md
git show f521f3d63:docs/plan/plugin-storage.md
git show 7a4e8d113:docs/plan/reroll-candidates.md
git show 607a33d74:docs/plan/implementation-audit-fixes.md
git ls-tree -r --name-only 9d09288b -- docs/plan/PLAN.md docs/plan/phases/
```

For another entry, substitute its commit/path. A historical reference such as
`docs/plan/chat-binding.md` is retrievable with `git show 809b35cc:docs/plan/chat-binding.md`;
it is not a current architecture guide.

## Completed Plans

| Design                                   | Last tree / original paths                                                | Current owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-owned data, Phases 0–6            | `9d09288b`: `docs/plan/PLAN.md`, `docs/plan/phases/`                      | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md)                                                                                                                                                                                                                                                                                                                                                                                                      |
| Split Preset and Chat Binding            | `809b35cc`: `docs/plan/split-preset.md`, `docs/plan/chat-binding.md`      | [persistence](../structure/persistence.md), [settings](../structure/settings-i18n.md)                                                                                                                                                                                                                                                                                                                                                                                                       |
| Shared API Keys and Model Profiles       | `317a97ce`: `docs/plan/shared-api-keys.md`, `docs/plan/model-profiles.md` | [LLM requests](../structure/llm-requests.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Translation and URL Routes               | `df25006f`: `docs/plan/translation.md`, `docs/plan/url-routes.md`         | [translation](../structure/translation.md), [app shell/routes](../structure/app-shell.md)                                                                                                                                                                                                                                                                                                                                                                                                   |
| Web Push                                 | `e148f7276`: `docs/plan/web-push.md`                                      | [Web Push](../structure/network-jobs.md), [worker](../structure/build-test-platforms.md), [server](../structure/self-host-server.md)                                                                                                                                                                                                                                                                                                                                                        |
| Request History and Diagnostics          | `ab11ea9d0`: `docs/plan/request-history-diagnostics.md`                   | [diagnostics](../structure/diagnostics.md), [LLM capture](../structure/llm-requests.md)                                                                                                                                                                                                                                                                                                                                                                                                     |
| Per-Chat Toggles and Toggle Presets      | `154711858`: `docs/plan/chat-toggles-and-presets.md`                      | [persistence](../structure/persistence.md), [UI/theming](../structure/ui-theming.md), [CBS/rendering](../structure/cbs-rendering.md)                                                                                                                                                                                                                                                                                                                                                        |
| Large Asset Import and Export            | `1bb0c8eee`: `docs/plan/large-asset-import.md`                            | [characters/modules](../structure/characters-modules.md), [server](../structure/self-host-server.md), [persistence](../structure/persistence.md), [assets](../structure/assets.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                |
| Sidebar Chat Status                      | `f5895b925`: `docs/plan/sidebar-chat-status.md`                           | [UI/theming](../structure/ui-theming.md), [chat pipeline](../structure/chat-pipeline.md), [persistence](../structure/persistence.md), [app shell](../structure/app-shell.md)                                                                                                                                                                                                                                                                                                                |
| Data-Loss Under Concurrency              | `01ceb829b`: `docs/plan/data-loss-concurrency.md`                         | [persistence](../structure/persistence.md), [server](../structure/server-resources.md), [chat pipeline](../structure/chat-pipeline.md), [memory](../structure/memory.md), [plugins](../structure/plugin-sandbox.md), [UI/theming](../structure/ui-theming.md), [app shell](../structure/app-shell.md)                                                                                                                                                                                       |
| Settings UI Reorganization               | `46eeee597`: `docs/plan/settings-ui-reorg.md`                             | [settings](../structure/settings-i18n.md), [app shell/routes](../structure/app-shell.md), [translation](../structure/translation.md), [LLM requests](../structure/llm-requests.md)                                                                                                                                                                                                                                                                                                          |
| Open Bug Fixes                           | `cfe072e4e`: `docs/plan/open-bug-fixes.md`                                | [persistence](../structure/persistence.md), [characters/modules](../structure/characters-modules.md), [chat pipeline](../structure/chat-pipeline.md), [memory](../structure/memory.md), [plugins](../structure/plugin-sandbox.md), [UI/theming](../structure/ui-theming.md), [settings](../structure/settings-i18n.md), [server](../structure/self-host-server.md), [Web Push](../structure/network-jobs.md), [media](../structure/media-aux.md)                                            |
| Boot Resource Cache                      | `723700902`: `docs/plan/boot-resource-cache.md`                           | [persistence](../structure/persistence.md), [server](../structure/server-resources.md), [test harness](../structure/test-harness.md)                                                                                                                                                                                                                                                                                                                                                        |
| Heap Memory Reduction                    | `639ba5b2e`: `docs/plan/heap-memory.md`                                   | [persistence](../structure/persistence.md), [characters/modules](../structure/characters-modules.md), [CBS/rendering](../structure/cbs-rendering.md), [build/test](../structure/build-test-platforms.md), [test harness](../structure/test-harness.md)                                                                                                                                                                                                                                      |
| Search                                   | `d30735b05`: `docs/plan/search.md`                                        | [UI/theming](../structure/ui-theming.md), [characters/modules](../structure/characters-modules.md), [settings](../structure/settings-i18n.md), [server](../structure/server-resources.md), [matcher](../structure/global-api.md), [app shell](../structure/app-shell.md)                                                                                                                                                                                                                    |
| RisuNest Small Wins                      | `f4c26f27d`: `docs/plan/risunest-small-wins.md`                           | [test harness](../structure/test-harness.md), [plugins](../structure/plugin-sandbox.md), [alerts](../structure/global-api.md), [app shell](../structure/app-shell.md), [server/Docker](../structure/self-host-server.md), `STRUCTURE.md` V4–V9                                                                                                                                                                                                                                              |
| Upstream `.bin` Compatibility            | `74f770e19`: `docs/plan/upstream-bin-compat.md`                           | [persistence](../structure/persistence.md), [server](../structure/server-resources.md), [backups](../structure/backup-sync-hub.md), [build/test](../structure/build-test-platforms.md)                                                                                                                                                                                                                                                                                                      |
| Audit Findings and Performance Leftovers | `e1aa33150`: `docs/plan/audit-findings-perf.md`                           | [server](../structure/self-host-server.md), [memory](../structure/memory.md), [LLM requests](../structure/llm-requests.md), [CBS/rendering](../structure/cbs-rendering.md), [chat pipeline](../structure/chat-pipeline.md), [persistence](../structure/persistence.md), [UI/theming](../structure/ui-theming.md), [plugins](../structure/plugin-sandbox.md), [media](../structure/media-aux.md), [app shell](../structure/app-shell.md), [build/test](../structure/build-test-platforms.md) |
| Timing-Dependent Tests                   | `2508dfd0c`: `docs/plan/timing-tests.md`                                  | [test harness](../structure/test-harness.md) `Tests`, `STRUCTURE.md` V3, [server](../structure/self-host-server.md) (test-only timing options)                                                                                                                                                                                                                                                                                                                                              |
| HypaV3 Background Memory                 | `f98be8d41`: `docs/plan/hypav3-background-memory.md`                      | [memory](../structure/memory.md), [persistence](../structure/persistence.md), [chat pipeline](../structure/chat-pipeline.md), [server](../structure/server-generation.md), [UI/theming](../structure/ui-theming.md), [settings](../structure/settings-i18n.md)                                                                                                                                                                                                                              |
| Per-Chat Send                            | `b9525d08d`: `docs/plan/per-chat-send.md`                                 | [chat pipeline](../structure/chat-pipeline.md), [plugins](../structure/plugin-sandbox.md), [server](../structure/server-generation.md), [UI/theming](../structure/ui-theming.md), [persistence](../structure/persistence.md), [network and jobs](../structure/network-jobs.md)                                                                                                                                                                                                              |
| Static Audit Fixes                       | `2e359afde`: `docs/plan/static-audit-fixes.md`                            | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [plugins](../structure/plugin-sandbox.md), [translation](../structure/translation.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                     |
| Chat Checkpoints                         | `2e359afde`: `docs/plan/chat-checkpoints.md`                              | [persistence](../structure/persistence.md), [server](../structure/server-resources.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                                                                                                            |
| Small Fixes                              | `2e359afde`: `docs/plan/small-fixes.md`                                   | [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md), [settings](../structure/settings-i18n.md), [LLM requests](../structure/llm-requests.md), [memory](../structure/memory.md), and the other guides its slices name                                                                                                                                                                                                                                       |
| Direct Asset URLs                        | `2e359afde`: `docs/plan/direct-asset-urls.md`                             | [build/test platforms](../structure/build-test-platforms.md), [CBS/rendering](../structure/cbs-rendering.md), [assets](../structure/assets.md), [server](../structure/self-host-server.md)                                                                                                                                                                                                                                                                                                  |
| Server Thumbnails                        | `2e359afde`: `docs/plan/server-thumbnails.md`                             | [test harness](../structure/test-harness.md), [assets](../structure/assets.md), [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                                                                        |
| Server Tokenizer                         | `2e359afde`: `docs/plan/server-tokenizer.md`                              | [test harness](../structure/test-harness.md), [LLM requests](../structure/llm-requests.md), [server](../structure/server-generation.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                                                           |
| Generation Stage Spinner                 | `2e359afde`: `docs/plan/generation-stage-spinner.md`                      | [chat pipeline](../structure/chat-pipeline.md), [server](../structure/server-generation.md), [UI/theming](../structure/ui-theming.md)                                                                                                                                                                                                                                                                                                                                                       |
| Upstream Integration                     | `2e359afde`: `docs/plan/upstream-integration.md`                          | [persistence](../structure/persistence.md), [plugins](../structure/plugin-sandbox.md), [LLM requests](../structure/llm-requests.md), [chat pipeline](../structure/chat-pipeline.md), [backup sync hub](../structure/backup-sync-hub.md), [UI/theming](../structure/ui-theming.md), and the other guides its slices name                                                                                                                                                                     |
| Combined Run index                       | `2e359afde`: `docs/plan/combined-run.md`                                  | the eight plans above (one `plan-runner` run); [test harness](../structure/test-harness.md) for the run's checks                                                                                                                                                                                                                                                                                                                                                                            |
| Combine Audit Fixes                      | `12fd77196`: `docs/plan/combine-audit-fixes.md`                           | [scripts/triggers](../structure/scripts-triggers.md), [UI/theming](../structure/ui-theming.md), [LLM requests](../structure/llm-requests.md), [global API](../structure/global-api.md), [server](../structure/self-host-server.md)                                                                                                                                                                                                                                                          |
| Chat Lore Overrides                      | `a179640ad`: `docs/plan/chat-lore-overrides.md`                           | [chat pipeline](../structure/chat-pipeline.md), [characters/modules](../structure/characters-modules.md), [persistence](../structure/persistence.md), [CBS/rendering](../structure/cbs-rendering.md), [scripts/triggers](../structure/scripts-triggers.md), [plugins](../structure/plugin-sandbox.md), [backup sync hub](../structure/backup-sync-hub.md), [UI/theming](../structure/ui-theming.md)                                                                                         |
| Context Usage Meter                      | `47c534f69`: `docs/plan/context-usage-meter.md`                           | [chat pipeline](../structure/chat-pipeline.md), [LLM requests](../structure/llm-requests.md), [UI/theming](../structure/ui-theming.md), [settings/i18n](../structure/settings-i18n.md), [persistence](../structure/persistence.md)                                                                                                                                                                                                                                                          |
| Deep Audit Fixes                         | `ca5b656fa`: `docs/plan/deep-audit-fixes.md`                              | [chat pipeline](../structure/chat-pipeline.md), [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [UI/theming](../structure/ui-theming.md), [settings/i18n](../structure/settings-i18n.md), [characters/modules](../structure/characters-modules.md), [diagnostics](../structure/diagnostics.md), [global API](../structure/global-api.md)                                                                                                            |
| Chat Lore Override States                | `1fc70e547`: `docs/plan/chat-lore-override-states.md`                     | [chat pipeline](../structure/chat-pipeline.md), [characters/modules](../structure/characters-modules.md), [persistence](../structure/persistence.md), [CBS/rendering](../structure/cbs-rendering.md), [UI/theming](../structure/ui-theming.md), [settings/i18n](../structure/settings-i18n.md)                                                                                                                                                                                              |
| Mobile Resume Reliability                | `ae289ecf5`: `docs/plan/mobile-resume-reliability.md`                     | [network and jobs](../structure/network-jobs.md), [persistence](../structure/persistence.md), [chat pipeline](../structure/chat-pipeline.md), [build/test/platforms](../structure/build-test-platforms.md), [server](../structure/self-host-server.md), [diagnostics](../structure/diagnostics.md)                                                                                                                                                                                          |
| HypaV3 Token Budget                      | `802a4840a`: `docs/plan/hypav3-token-budget.md`                           | [memory](../structure/memory.md), [settings/i18n](../structure/settings-i18n.md), [UI/theming](../structure/ui-theming.md), [persistence](../structure/persistence.md), [backup sync hub](../structure/backup-sync-hub.md)                                                                                                                                                                                                                                                                  |
| Display Evaluation                       | `1db8c10a8`: `docs/plan/display-evaluation.md`                            | [CBS/rendering](../structure/cbs-rendering.md), [scripts/triggers](../structure/scripts-triggers.md), [server](../structure/server-generation.md), [chat pipeline](../structure/chat-pipeline.md), [persistence](../structure/persistence.md), [app shell](../structure/app-shell.md)                                                                                                                                                                                                       |
| Durable Drafts                           | `bbc747f24`: `docs/plan/durable-drafts.md`                                | [persistence](../structure/persistence.md), [chat pipeline](../structure/chat-pipeline.md), [diagnostics](../structure/diagnostics.md), [UI/theming](../structure/ui-theming.md), [app shell](../structure/app-shell.md)                                                                                                                                                                                                                                                                    |
| Job Protocol                             | `73c12d29c`: `docs/plan/job-protocol.md`                                  | [server](../structure/server-generation.md), [chat pipeline](../structure/chat-pipeline.md), [plugins](../structure/plugin-sandbox.md), [diagnostics](../structure/diagnostics.md), [persistence](../structure/persistence.md), [test harness](../structure/test-harness.md)                                                                                                                                                                                                                |
| Boot Bytes                               | `2a8f7b93a`: `docs/plan/boot-bytes.md`                                    | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [app shell](../structure/app-shell.md), [plugins](../structure/plugin-sandbox.md), [build/test/platforms](../structure/build-test-platforms.md)                                                                                                                                                                                                                                                     |
| Per-Event Server Work                    | `aff71b423`: `docs/plan/per-event-server-work.md`                         | [persistence](../structure/persistence.md), [live-update feed](../structure/live-update-feed.md), [chat pipeline](../structure/chat-pipeline.md)                                                                                                                                                                                                                                                                                                                                            |
| Server Byte Budgets                      | `0009c22f3`: `docs/plan/server-byte-budgets.md`                           | [server](../structure/self-host-server.md), [persistence](../structure/persistence.md), [diagnostics](../structure/diagnostics.md), [backup sync hub](../structure/backup-sync-hub.md), [build/test platforms](../structure/build-test-platforms.md)                                                                                                                                                                                                                                        |
| Guide Budgets                            | `9a1bf0afe`: `docs/plan/guide-budgets.md`                                 | [STRUCTURE](../../STRUCTURE.md), [build/test platforms](../structure/build-test-platforms.md)                                                                                                                                                                                                                                                                                                                                                                                               |
| Structured Memory                        | `0cd49a3d3`: `docs/plan/structured-memory.md`                             | [structured memory](../structure/structured-memory/records.md), [writer](../structure/structured-memory/writer.md), [read path](../structure/structured-memory/read.md), [lifecycle](../structure/structured-memory/lifecycle.md), [rebuild](../structure/structured-memory/rebuild.md), [pages](../structure/structured-memory/pages.md)                                                                                                                                                   |
| Server Plugin Runtime (retired unbuilt)  | `78dbb078f`: `docs/plan/server-plugin-runtime.md`                         | None: no slice landed; [plugins](../structure/plugin-sandbox.md) keeps the tab runtime and the skip-and-replay path                                                                                                                                                                                                                                                                                                                                                                         |
| Guides To Source                         | `786dfc3d3`: `docs/plan/guides-to-source.md`                              | [STRUCTURE](../../STRUCTURE.md) (Doc Maintenance, `ownership.json`), [build/test platforms](../structure/build-test-platforms.md) (`util/docsBudget.mjs`, `util/docsLedger.mjs`, `util/guideReads.mjs`)                                                                                                                                                                                                                                                                                     |
| Job Handoff                              | `c34f69365`: `docs/plan/job-handoff.md`                                   | [server](../structure/server-generation.md) (Job handoff, Limitations), [live-update feed](../structure/live-update-feed.md), [network and jobs](../structure/network-jobs.md), [chat pipeline](../structure/chat-pipeline.md), [plugins](../structure/plugin-sandbox.md) (Job owner presence), [test harness](../structure/test-harness.md) (`checkJobHandoff.mjs`)                                                                                                                        |
| Asset Lifecycle                          | `72830e9f6`: `docs/plan/asset-lifecycle.md`                               | [self-host server](../structure/self-host-server.md) (Asset mark, Storage routes, Limitations), [server resources](../structure/server-resources.md) (Snapshots and restore, pins), [assets](../structure/assets.md) (Asset client, Asset queues), [settings and i18n](../structure/settings-i18n.md) (Storage section), [test harness](../structure/test-harness.md) (`checkAssetLifecycle.mjs`)                                                                                           |
| Incremental Chat Transport               | `c249c3a21`: `docs/plan/incremental-chat-transport.md`                    | [live updates](../structure/live-updates.md) (Feed connection, Chat live updates), [live-update feed](../structure/live-update-feed.md) (hello `cursor`, feed chat entries), [server resources](../structure/server-resources.md) (change log, `chatRows`), [server generation](../structure/server-generation.md) (streamed rows, `proto`), [chat store](../structure/chat-store.md) (By-id ops)                                                                                           |
| Render Work Budget                       | `a72c5f736`: `docs/plan/render-work-budget.md`                            | [CBS and rendering](../structure/cbs-rendering.md), [UI and theming](../structure/ui-theming.md), [translation](../structure/translation.md), [test harness](../structure/test-harness.md) (`measureRenderWork.mjs`)                                                                                                                                                                                                                                                                        |
| Plugin Storage and Data API              | `f521f3d63`: `docs/plan/plugin-storage.md`                                | [plugins](../structure/plugin-sandbox.md) (State, Gotchas, Tests), [resource sync](../structure/resource-sync.md) (Record patches), [server resources](../structure/server-resources.md) (kinds, resource routes), [chat store](../structure/chat-store.md) (detached reads, `chatSummaryList`), [backup sync hub](../structure/backup-sync-hub.md) (Upstream database export), [test harness](../structure/test-harness.md) (`measurePluginData.mjs`), `plugins.md`                        |
| Reroll Candidates                        | `7a4e8d113`: `docs/plan/reroll-candidates.md`                             | [chat pipeline](../structure/chat-pipeline.md) (Reroll), [chat store](../structure/chat-store.md) (`selectCandidate`), [server generation](../structure/server-generation.md) (in-place reroll job), [memory](../structure/memory.md) (commit boundary), [backup sync hub](../structure/backup-sync-hub.md) (candidates on export and import)                                                                                                                                               |
| Found Issues Sweep                       | `b37776a72`: `docs/plan/found-issues-sweep.md`                            | The owning guides' Known Hazards; the deferred groups and accepted notes stay in [found-issues](../research/found-issues.md)                                                                                                                                                                                                                                                                                                                                                                |
| Implementation Audit Fixes               | `607a33d74`: `docs/plan/implementation-audit-fixes.md`                    | [server resources](../structure/server-resources.md), [server](../structure/self-host-server.md), [server generation](../structure/server-generation.md), [chat store](../structure/chat-store.md), [plugins](../structure/plugin-sandbox.md), [translation](../structure/translation.md), [CBS and rendering](../structure/cbs-rendering.md), [assets](../structure/assets.md) (Q1), the [structured memory](../structure/structured-memory/README.md) pages                               |

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
Data-Loss Under Concurrency (the fix plan for `docs/manual-audit/data-loss-concurrency-2026-10-18.md`)
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
- The export prepare's synchronous work was measured on a small store only (server-resources
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
the narrowing on code grounds; `server-generation.md` Generation channels). SA2 closed the open-bug-fixes
A3 leftover, removed from this file.

Chat Checkpoints (RisuBard save slots, `docs/research/risubard-survey.md` §2.3.1) landed all 6
slices: CC1 Checkpoint tables and store (`b8b75f2e6`); CC2 Snapshots, restore, and archives carry checkpoints (`8f16dd41e`); CC3 Routes, load, restore floor, and the busy check (`30dfc52cf`); CC4 Auto-checkpoint after a finished job (`a5398dd28`); CC5 Client checkpoint module and dialog (`f3635120b`); CC6 Persistence guide update (`56a21a914`). Measured (CC4, a 2000-message chat of about 10 MB): an auto checkpoint
takes about 110–170 ms synchronously when it saves and about 30 ms when nothing needs saving.
Still open: one browser check of the Checkpoints dialog's auto-policy row against the real policy
routes (CC5 was checked with an adapter stand-in before CC4 landed); Firefox, Safari, and mobile
layouts (CC5). Client checkpoint rules are in [chat store](../structure/chat-store.md#chat-checkpoints) (CC6); the restore floor's
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
and screenshots omit that image until the row re-renders (DA7, Known Hazard in `assets.md`).

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

Chat Lore Overrides (a chat overrides its owner's lorebook entries for itself only, planned with
the user on 2026-10-24) landed all 4 slices on `metatron` on 2026-10-24 through the plan runner
(`delegate-implementation`, Codex implementers), one cherry-picked commit each: 1 the
`Chat.loreOverrides` field, `shared/lore/overrides.ts` merge, activation, and persistence
(`8363beb57`); 2 CBS `{{lorebook}}`, Lua `getLoreBooksMain`, and plugin
`getCurrentLorebookEntries` read the merged lore (`47e83fa24`); 3 the 409
`chatLoreOverrideOrphaned` admission refusal with its client alert and pre-send checks
(`0a9c9c721`); 4 the collapsed override editor in the chat lorebook tab (`740a05d1d`). The final
checks on `a179640ad` passed: `pnpm check`, `check:tests`, 6965 unit tests, 56 slow tests, the
four related e2e specs (`chatLoreOverrides`, `chatBinding`, `perChatSends`, `readersCharacters`),
and prettier. Decisions made by the slices: `loreOverrides` has no default and readers use
`?? []` (1); `mergeOwnerLore` returns references, not clones, because the client passes `$state`
proxies (1); "off wins" is also enforced in activation through `offOverrideIds` (1); Reroll
refuses before removing the reply, beside Send and Continue (3); a folder checkbox pins or
releases its entries, not the folder (4); "Move to chat lorebook" drops the `folder` key (4).
Slice 4 ran the plan's manual check in headless Chrome against a mock provider (the request body
instead of the DevTool preview). Still open: the manual check by hand in a real browser. The plan
limited the refusal to generation jobs; on 2026-10-25 the owner decided that auxiliary LLM requests
(suggestions, memory summaries, translation, MCP AIAccess, plugin and WebLLM requests) do not
refuse a chat with orphaned overrides ([chat pipeline](../structure/chat-pipeline.md) `Invariants`).

Context Usage Meter (a composer chip showing how the last request spent the model's context,
shaped for RisuAI's per-send rebuild and trim, planned with the user on 2026-10-25) landed all 4
slices on `metatron` on 2026-10-25 through the plan runner (`opus-workflow` for 1, 3, 4 and
`opus-lite` for 2), one cherry-picked commit each: 1 the server `ContextReport` in
`MessageGenerationInfo.context` (`shared/contextReport.ts`, counted at assembly's own sites, with
the no-memory trim ledger, memory coverage, the lore budget from `activateLore`, and the job token
scope) (`2eb869497`); 2 the `contextMeter`, `contextMeterTurnUnit`, and `contextMeterFixedWarn` UI
settings in the `interaction.contextMeter` section (`630ba6396`); 3 `ContextMeter.svelte`, the
chip and its breakdown popover (`2febc0f44`); 4 the typing-time displacement estimate with
`jobTokenScope()` and `countTokensInScope()` (`69858ee8b`). The final checks on `47c534f69`
passed: `pnpm check`, `check:tests`, 7053 unit tests, 56 slow tests, and 14 e2e tests in eight
specs (`perChatSends`, `chatBinding`, `welcomeAndChatSettings`, `openChat`, `lazyChats`,
`refusedData`, `settingsPages`, `chatLoreOverrides`). Decisions made by the slices: slice 2, not
1, typed the three `Database` fields, because the partition check needs them in
`shared/sections.ts` (1); section rows have no `name`, `"beyondQueue"` means the known 8-entry
queue ran out, and memory coverage is `"covered"` only on HypaV3 evidence (1); the memory-mode
chip leaves the memory kind to its label and the popover (3); the estimate is also hidden with any
memory configured, a preset chain, an incomplete binding, or a disabled last message, and the
next report's kept count is kept + 2 − n messages, not a plain drop (4). Slice 4 ran most of the
manual check in a browser against a mock provider. Still open: the manual check for group chats,
memory mode, a continue, the unknown estimate, the settings link, the warning level, and Firefox
and Safari; the deferred Recalculate (it needs a preview job that writes nothing, keeping
`previewChat("preview")`'s array contract); restoring the `showMemoryLimit` line (see found
issues); and the memory-mode "may run memory" hint, which was not built.

Deep Audit Fixes (the bounded, confirmed findings of the two 2026-10-26 audits,
[server/client stabilization](../research/deep-audit/server-client-stabilization.md) and
[server migration](../research/deep-audit-with-fable/server-migration-audit.md), plus the
found-issues list and the agents' memory leftovers) landed all 9 slices on `dev` on 2026-10-26
through the plan runner (`delegate-implementation` for every slice, Codex implementers and
challengers), one cherry-picked commit each: 1 trigger results merge `scriptstate` and the other
map fields by key, no "Invalid return" without a request trigger, the empty-history `lastChat`
guard, and the overlapping-range token recount (`44426ad50`); 2 input translation runs owned by a
token (`inputTranslation.svelte.ts`) and the IME guard for composer and partial-editor shortcuts
(`src/ts/ime.ts`) (`2171bcb5c`); 3 the LoRA editor publishes only on edits and shows a conflict
notice, suggestion translation and four presentation effects drop stale results, and the bookmark
jump runs through `runMessageJump` (`d16a90ac9`); 4 lorebook local activation matches only child
links and the persona note popup is plaintext (`95d3f8f47`); 5 the compressed revision listing,
bounded vector eviction, explicit `synchronous = FULL`, and push registrations not rewritten
within 24 h (`ae2f9569a`); 6 `flushResources` reports `refused`, checked by send admission, the
three backup exports, and callback readiness (`cef9e9330`); 7 a chat counts as viewed only while
shown, the fold index is derived for its own chat (`src/ts/chatFold.svelte.ts`), failed display
transforms retry, and the `showMemoryLimit` line is restored (`223e1fea3`); 8 whole chat reads
carry the chat's lock snapshot, fenced by a client read stamp (`e73996a67`); 9 the typed
`createCollectorMock` and the server guide's auth and kept-outcome text (`4a3d064d3`). The final
checks on `ca5b656fa` passed: `pnpm check`, `check:tests`, 7274 unit and slow tests, and 30 e2e
tests in fourteen specs. Decisions made by the slices: a refused chat order no longer holds every
flush (6); a trigger that drops a whole map removes only its baseline keys (1); a translation
result arriving while the destination composes is dropped, not deferred (2); a LoRA draft counts
as saved only after a later save cycle sees the `secrets` revision move (3); the vector cache skips
an insert that cannot fit within the 256-row budget (5); a browser whose subscription the server
dropped (the 50-entry cap) while its endpoint and keys stay the same re-registers within 24 h, not
at once, since the client cannot see the server's list (5, accepted by the orchestrator); failed
transforms also retry on a 5–60 s backoff while visible (7). Still open: the device and browser
checks (Android Korean and desktop Japanese IME, the two-tab LoRA alternation, a real-browser push
run, the failed-transform row after a phone wakes, and the memory limit line on screen); the
mounted `DefaultChatScreen` tests for the bookmark jump and translation invalidation; and the
plan's **Deferred** table, which groups the remaining audit findings into the follow-up plans it
names (durable drafts, job protocol, display evaluation, per-event server work, dictionary ids,
boot bytes, server byte budgets, retention, token counting, rendering).

Chat Lore Override States (polish of the Chat Lore Overrides editor: a short state control in
place of the long "Override in this chat" checkbox, and a folder that can be turned off for one
chat) landed both slices on `dev` on 2026-10-25: 1 an off folder override removes every entry
inside it in `mergeOwnerLore` (membership by the owner's current non-empty folder keys, never the
frozen copy's; nested folders until nothing changes, so cycles end), `offOverrideIds` takes the
owner lore and includes those members so child links to them stay inactive, and
`normalizeChatMeta` keeps only the first override per entry id (`e497efaa8`); 2 the editor's
Original / Override / Off segment per entry and On / Off per folder (one `off: true` folder
override that never touches member overrides), the folder's override indicator and confirmed bulk
release, a release that confirms only for an edited copy and rechecks owner and send fence after
any dialog, and `SegmentedControl`'s group label, `aria-describedby`, `aria-pressed`, and margin
flag (`37902a9d5`). Decision recorded at retirement (the owner, 2026-10-26): orphan delete and
move act on the selected override object only, while every other removal drops every override
with the id; a legacy duplicate orphan stays as its own row until it is handled or the next
metadata write collapses it. Out of scope by the plan: module lore, a marker in the character tab
for overridden entries, an off control for chat-local lore, refreshing an off copy from its
original when it is turned back on, and duplicate owner ids. Still open: the manual checks (in
the narrowest sidebar a long entry name stays readable beside the control in English and Korean;
turn a folder off, add an entry to it in the character tab, send, and confirm the new entry is
absent from the prompt; turn the folder back on and confirm an edited member's override applies
again while an off member stays off).

Mobile Resume Reliability (the user's Android PWA reports: a completion push that sometimes never
shows, an alert on return after which the chat may stay stale until another chat is opened, and
no way to see why on the phone) landed all 4 slices on `dev` on 2026-10-26, one commit each: 1 the
service worker counts a window in front only when one window is both focused and visible, and
completions go out with `urgency: "high"` and a per-chat Web Push `topic` from the tag hash
(`7b01303e3`); 2 the server keeps a trimmed outcome record of each collected job (24 h, at most
500, cleared on an epoch change) that `status()` answers as `ended` for its own client only, and
the client reads the status after every close without a terminal, backs attaches off 1/2/4/8 s
with 10 s deadlines, tells a gone job (the chat read again, then the neutral
`serverJob.endedAway` toast) from an unreachable server (`serverJob.lost`), and marks the chat
stale and reads it after every lost or gone follow, with one retry at the next visible/`online`
(`d7b3a7a34`); 3 `src/ts/network/socketLiveness.ts` gives the feed and job sockets a 10 s connect
timeout, a 45 s no-frame watchdog while visible, and one folded resume reconnect (visible after
30 s hidden, Page Lifecycle `resume`, `online`), with one connection generation in `eventFeed.ts`
and resumed attaches not counted against the attach budget (`7d558b5e5`); 4 content-free `push`
(server, worker, and page phases) and `notice` events, `page` `freeze`/`resume` phases, and the
worker's newest 100 push records in IndexedDB `risu-sw-diagnostics`, merged into the report
(`303e4efbb`). Decisions: the user's message-count comparison was not used, because a reroll, a
continue, a reply already streaming, or a command job is a success without a new message; a kept
outcome shows no notice (`done`) or the usual error alert (`error`), and only a job the server no
longer knows gets the toast. Set aside by the plan (each needs its own design if the diagnostics
ever show it): browser-dependent callbacks (Lua questions, plugin, provider, and tab MCP
callbacks) expiring while the page is away; keeping the browser's diagnostics across an Android
process kill; a feed whose `listRevisions` hangs while pings keep arriving, and settling a job
follow's terminal before its `close`; the completion push sent before the post-reply
emotion/image work and final write; push on job errors (a product decision); and the earlier Web
Push leftovers. Still open: the four Android PWA scenarios (lock the screen right after sending;
switch to another app for 5+ min; airplane mode during the reply; force-stop and reopen), each
followed by Settings → Advanced → Developer & diagnostics → Save to server; the plan's
**Verification** section maps each event to the cause it shows (H1–H7).

HypaV3 Token Budget (a token budget mode for HypaV3 presets: the memory budget, the background
summary headroom, and the extra summarization as plain token amounts instead of shares of the max
context, planned with the user on 2026-10-27) landed both slices on `dev` on 2026-10-27 through
the plan runner (`delegate-implementation` with an Opus implementer), one cherry-picked commit
each: 1 `budgetMode` and the three token fields on `HypaV3Settings` (missing or invalid
normalizes to `"ratio"`, the server's seeded default and new presets are `"tokens"`),
`resolveHypaV3Budget` in `shared/hypaV3Presets.ts` with the reduction rule (headroom, then extra,
then memory, each margin pair and the memory at most half of `C − maxResponse`), every server
site reading `HypaV3Prepared.budget`, `ContextReport.memory.budgetReduced`, and the upstream
export writing token-mode presets as ratios of the exported root `maxContext` (`6d24cc697`); 2 the
settings page's Ratio / Tokens control, token inputs, estimate in tokens, live reduction
warnings, and the convert-to-tokens button, and the context meter's "memory reduced" chip mark,
summary clause, and popover lines (`92f830490`). `dev` moved during the run (`0fa8eea07`, the
meter's history block reorder, and `0aad24ce5`); it was merged in as `0bb2a7675` with both sides
kept. The final checks on `0bb2a7675` passed: `pnpm check`, 7287 unit tests, and 56 slow tests.
Decisions made by the slices: the plan's "ordinary plan" site was `deferredStepCount` (the
deferred replay), which reads the resolver too (1); the equivalence test uses binary-exact ratios,
because integer products alone still differ in floating point (1); the export clamps to the
sliders' ranges and keeps the stored ratios without a positive finite `maxContext` (1); token
inputs store a floored integer ≥ 0, and `getMaxMemoryRatio` became `estimateMaxMemory`, which now
recomputes when the max context changes (2). Out of scope by the plan: a trigger independent of
`C`, token mode for HypaV2 or SupaMemory, token mode in the tab's oracle copy, and mixing modes per
field. Still open: the manual checks in a browser after a real send (convert a ratio preset and
confirm the summarize timing is unchanged; lower the max context and confirm the chip shows
"memory reduced" with the applied values); the settings page itself was checked with Playwright.

Display Evaluation (the server display transform's cache and dispatch, audit findings TJ02, TJ03,
TJ05 and ST05, planned on 2026-10-28 and reviewed by Sol; the user answered Q1–Q3 as recommended)
landed all nine slices on `dev` on 2026-10-28 through the plan runner (`delegate-implementation`,
Codex implementer and challenger), one cherry-picked commit each: 1 the conservative key (the
stored chat revision, the viewport, and every loaded character) (`fd7f50766`); 6 the regex mode
filter and the CBS parse skip for unchanged plain text (`15ed61b6c`); 3 snapshot accounting
(`6b0d485f5`); 4 `createDisplayScopeLoader`, one shared load per render burst with pinned entries
under a 64 MiB budget (`3b0e047ff`); 5 the character display identity without `lastInteraction`
and eleven kinds dropped from the key (`cf326ef1e`); 2 a row that rendered an unsaved mix renders
again once its chat settles (`4a1d870f3`); 7 `knownKey` on a target and `same` on an exact hit
(`f5eda0ff6`); 8 the tab result cache `transformResults.ts`, which shows a remounted row's confirmed
text at once (`aa4f2a68a`); 9 the guides and the cache comment (`31b75a1e3`). `dev` moved during the
run (HypaV3 modal fixes, the popup editor toggle, Durable Drafts slices 1 and 9, the Known Hazards
split, the Job Protocol plan); it was merged in as `05e4be8c1`, keeping both loops in
`applyRemoteCollection`. The final checks on that tree passed: `pnpm check`, `check:tests`, 7,529
unit tests, 56 slow tests, and the 10 `serverTransform`/`transformGolden` e2e tests. Measured after
all slices: a 500-target cold render parses 1,116 times instead of 4,849, a stamp-only save keeps
all 500 hits, and 10 non-matching regex scripts take 274–314 ms instead of 1,033–1,193 ms; the
first remount after a send refetches 28 of 30 rows once (about 35 ms of server time and 90 KB), so
the plan's **Later** read-class key was judged not needed. Decisions made by the slices: a scope
over the snapshot budget fails every uncached target (3); four kinds beyond the plan's candidates
were dropped, since no display path reads them (5); a refilled key may hold other random, clock or
plugin text while `same` confirms the tab's older text (7); a GUI reset advances the tab cache's
generation without clearing it, and a synchronous source hash with an exact source check replaces
`sha256(source)` (8). Findings outside the plan went to `docs/research/found-issues.md` (Display
transform). Still open: the device checks on the Android PWA over mobile data (A → B → A shows rows
at once; no disturbing flicker after a send; repeated switches answer only `same`).

Durable Drafts (audit findings F02, F03 and F04: unsaved changes survive a lost page through an
IndexedDB journal recovered in the same epoch, conflicts keep the local version, and saves stop
waiting for unrelated reads; planned on 2026-10-28 and reviewed by Sol; the user decided D2, D3 and
D10 and answered Q1–Q4 as recommended, raising Q4's budgets to 16 MiB per entry and 64 MiB in total
after Slice 3 measured them) landed all twelve slices on `dev` on 2026-10-29 through the plan runner
(`delegate-implementation`, Codex implementer and challenger), one commit each: 1 the draft journal
store, its tab ownership, and the eligibility boundary (`2a8ce1e83`); 9 composer drafts in the
journal (`62277946b`); 2 saves no longer wait on reads of other records (`f5023bf8b`); 3 the save
adapter journals unacknowledged record writes (`ca3e30b7b`); 4 boot recovery of records
(`8a1ea95e9`); 5 the recovery dialog and the Settings → Advanced "Recovered changes" row
(`cfb27e86c`); 6 chat work journaled with one group id per batch (`0814b3634`); 8 the restore
snapshot (`f5ef5033e`); 7 boot recovery of chat and order work (`5d46c6e61`); 10 a recovery draft
of the dropped local work at every conflict (`40b026930`); 11 field- and item-level merge at a 409
(`recordMerge.ts`, `abbe42f87`); 12 the guides and the kill-and-relaunch driver
`util/playwright/checkDurableDrafts.mjs` (`257a2a60c`). The user approved two plan changes during
the run: D7 sends whole keepalive batches only and lets the front part of a split batch wait for its
journal commit (`610f8d143`), and Slice 7 took the hand-over APIs and ran after Slice 8
(`4845688fb`). `dev` moved during the run (the Display Evaluation run and its audit fixes, the Known
Hazards split, the Job Protocol and Boot Bytes plans); it was merged in as `13355b1f5`, keeping both
the chat journal maps and dev's unacknowledged-work flag in `chatStore.svelte.ts`, and as
`9ba1af8a2`. The final checks on that tree passed: `pnpm check`, 7,715 unit tests (slow included),
and all 38 e2e tests; the driver passed 31/31 (three cut points around `/api/resources/batch`, a
browser kill without lifecycle events, and a relaunch on the same profile). Decisions made by the
slices: Chrome discards IndexedDB writes begun in `pagehide` on unload, documented as a Limitation
with no `localStorage` fallback; recovery drafts conservatively when a record's or chat's state is
unclear (4, 7); an applied draft is removed only after its save commits (5); an expired chat group
becomes refused work and a draft at the next boot (7); `llmSecrets` merges its readable sibling body
as one unit, both sides reordering a collection conflicts, and a merged empty required collection
conflicts (11). Q3 did not hold as planned: headless Chrome 156 restored the page from the
back/forward cache while it held its journal owner lock (`pageshow.persisted`, `notRestoredReasons:
null`; a draft recovery Gotcha), and pending writes across such a cached return were not driven.
Findings outside the plan went to `docs/research/found-issues.md` (Save journal and recovery). Still
open: the device checks (an Android PWA killed from the task switcher, the iOS Home Screen app,
Safari including the bfcache return, Firefox), the recovery dialog at phone width, and the
"Recovered changes" row shown while drafts exist (unit-tested only).

Job Protocol (audit findings F15, F16 and TJ06: a create whose answer was lost is replayed instead
of run twice, a command's `/multisend` runs on the server as one sequence job, an absent owner frees
its chat in minutes, another tab or device can stop a chat's job, and a restart reads as an ended
job; planned on 2026-10-28 and reviewed by Sol, the user answering Q1–Q4 as recommended) landed all
seven slices on `dev` on 2026-10-29 through the plan runner (`delegate-implementation`, Codex
implementer and challenger; the slice sessions ran one at a time in the orchestrator's worktree): 1
the job receipt store `save/data/generation-jobs.sqlite` (`server/src/data/generationReceipts.ts`,
`d0b6c096c`); 2 create request ids with a fingerprint, replay, `requestIdReused`/`requestCancelled`,
the cancel route, and the tab's retry with backoff (`b532a95e2`); 2b request ids in recovered
composer drafts (`fdf7a1235`); 3 the `/multisend` sequence job, removing `followUps` and
`runFollowUps` (`d4586f152`); 4 negotiated owner liveness (`liveness=1`, `pong`) and the job-level
absence deadline (`31dd5c2f0`); 5 the chat-slot lookup and stop routes with `abortedBy: "other"`
attribution and a confirming Stop beside Send (`2864a806e`); 6 the guides' close and the browser
driver `util/playwright/checkJobProtocol.mjs` with a real plugin provider (`0fb58b456`). Where the
code settled differently from the text: the running request-id index moved from Slice 1 to Slice 2;
after an unanswered create, a 412, 429, auth or 5xx answer stays `unknown` because it comes before
the request-id lookup; recovered composer rows store `requestEpoch`, because a reloaded page posts
with the current epoch and D4's 412 does not refuse it; error and abort terminals also carry
`sequence { total, sent }`, and a done sequence takes one automatic checkpoint because the slot is
held between parts; the channel hub gained `expireOverdue` and `ownerChanged`, and MCP owner checks
read the same presence; the lookup takes an optional `clientId` for `owned`. D6's "chat free within
45 + 120 + 5 s" bound does not hold for every path (found-issues, Server jobs). `dev` moved during
the run (the Durable Drafts slices 2–12 and the Boot Bytes plan) and was merged in as `a15eaa2c4`;
on that tree `pnpm check` and 7,734 unit tests passed, and the driver passed all five cases (a cut
create answer, a reload mid-sequence, a stop from a second context, the owner closed during a
provider reply, a SIGKILL before a checkpoint). Still open: the Android PWA device checks (a kill
and reopen mid-reply with a server provider and with a plugin provider, a stop from the phone while
the desktop generates, airplane mode right after Send), and the window where a page killed between
the create and its journal write recovers the text without the request id (documented, not driven).

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
    the measured data); the client's work after the read is unchanged. (Chat summaries
    and orders are cached per character since the Boot Bytes plan; whole chats still
    load on demand.)
  - No sign-out calls `clearBootCache` yet.
  - Closed by the Boot Bytes plan: the version-1 `risu-boot-cache` database without
    stores is repaired by an upgrade, and the app's static files are served from Brotli
    and gzip siblings (their `ETag`, 304 and `immutable` caching had landed before).
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
    ends defers the reload until a local reload (`plugin-sandbox.md` Known Hazard).
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
- Boot Bytes:
  - Only headless Chrome was checked: compressed scripts, the reconnect digest, and the
    per-character chat collections have no Firefox, Safari, mobile, or private-window run.
  - "Last chatted" ordering on the home screen and the mobile character list is derived
    from the chats now and has not been checked in a browser; `checkServerJobMatrix.mjs`
    was not re-run after the server stopped stamping characters on a send.
  - Not planned: characters as a sidebar projection (Q3), a summary projection that does
    not parse whole chat `meta`, and a boot cache that follows the tab's acknowledged state.
  - Closed by the Incremental Chat Transport plan (D5, `ca5a5cb8e`): Q2's persisted change
    log and `?since=` cursor. A reconnect after a change made while hidden reads a 536-byte
    replay instead of the 88,727-byte listing (measureBoot resume-away, 425 → 358 ms); the
    listing stays the fallback when the log no longer covers the tab's cursor.
  - Found by the run (in `docs/research/found-issues.md`): measureBoot gaps; a
    `readersCharacters` e2e timeout behind the Safe boot notice. The server import and
    restore skipping existing assets on existence alone was fixed after the audit (U2).
- Per-Event Server Work:
  - Only headless Chrome was checked: the patch-only barrier and the feed's `summary` and
    `delta` entries have no Firefox, Safari, or mobile run.
  - Not planned: retiring `patch` for `delta` and dropping whole barriers for sockets
    without `hydration=patch` once an older client can be refused (both sockets now send
    `proto=1` as that boundary, with no floor: Incremental Chat Transport D4), and the
    chat's summary on the job socket for the owner's own list.
  - Closed by the Incremental Chat Transport plan: the by-id read for an over-cap change of
    a loaded chat (D6, `2272abf6e`: the mixed fixture's 4 over-cap entries read 394,652
    bytes of rows instead of 967,029 of whole chats), and a reply past 64 KiB no longer
    falls to it (D2 row diffs, `917273384`: about 1,700 bytes per checkpoint, 0 observer
    whole reads instead of 4); in place of a text delta on the job socket, the owner's
    `chatPatch` names its streamed row (D3, `f906c864e`: 33,265 → 498 bytes per checkpoint).
  - Found by the run (in `docs/research/found-issues.md`): a first metadata write that may
    still diff (cause unconfirmed), duplicate `loreOverrides` kept after an acknowledged
    write, the test-only `isBarrierFailure`, and the `perChatSends` `localStorage` failure
    with its `serverTransform` knock-on.
- Server Byte Budgets:
  - Measured on one machine (ext4, Node 24.21) at `228b23f6d` against the `ac823f673`
    baseline; three cases ended worse and the audits record them as such: the summary read
    (14.1 → 14.9 ms, a fixture with little chat metadata), the 5,000-message install
    interval (107.7 → 164.8 ms; the interval now holds the SQL copy and index maintenance,
    and the serving thread's synchronous work fell from 177.7 to 164.8 ms), and the first
    checkpoint `save` (91.5 → 100.7 ms, cause not isolated).
  - Not planned (the plan's Later list): a bytes-in-flight gate for reads, page-hash reuse
    across checkpoint saves, per-round deadlines for continued reads, a paged
    `GET /api/resources` for the boot-cache miss, restore and import progress as NDJSON with
    a prepare/commit split for the version-2 import, and a streaming validator that keeps no
    id sets.
  - Limitations recorded in the server guide: a row far over the restore worker's heap limit
    aborts the whole process (reproduced at a 16 MiB limit with a 32 MiB row; not reached
    under the default 2048 MiB by what the 100 MiB request cap admits), the version-2 import
    finishes through a shutdown instead of stopping, and `eventsFor`, reports and shares still
    write synchronously.
  - Found by the run (in `docs/research/found-issues.md`): routes that still re-measure a
    counted body, the `chatCheckpoints` copy of the body limiter, the test-only
    `checkpoints.sweep`, the login that appends a known key hash again, the "every start"
    normalizer comments, `discardRefusedChat` without a deadline, and the unseeded
    `terminalNotice` e2e case.
- Guide Budgets:
  - All slices landed on 2026-11-01. Guides went from 17 files and 1,156,344 bytes to 23 files
    and 864,053 bytes, and the largest leaf from 116,767 to 6,950 bytes; the numbers are in the
    archived Verification section. `pnpm check:docs` fails on 40,000 bytes per guide, 8,000 per
    leaf, and 600 characters per item.
  - `persistence.md` became `persistence`, `resource-sync`, `chat-store`, and `draft-recovery`;
    `self-host-server.md` became `self-host-server`, `server-resources`, and `server-generation`;
    `build-test-platforms.md` gave its test rules to `test-harness.md`.
  - The slices ran no test suite and no `pnpm check`, at the owner's request; only
    `util/docsBudget.test.ts` ran. `util/testInventory.test.ts` had its fixture keys changed
    and was not run.
  - Not planned (the plan's Later list): a per-plan docs budget compared through `--report`, and
    a second reader pass over the smallest guides for the prose rules.
  - Found by the run: 33 entries in `docs/research/found-issues.md`, under Client and plugins,
    Build, drivers, and e2e, and Guides, among others.
- Structured Memory:
  - All 31 slices landed on 2026-11-02 and 2026-11-03 (plan-runner); `dev` moved to `0cd49a3d3`.
    Owner decisions made during the run are dated in the archived plan's slice text: a stopped
    rebuild keeps generation locked, a patch may replace a corrected section, custom prompts must
    quote their required slots, import goes only into an empty chat, and screening reaches the
    writer only.
  - Q2 (replace HypaV3 by default) stays open until a real-model A/B from the recipe in
    `docs/audit/structured-memory-2026-11-03.md`; `MEMORY_CALL_OVERHEAD_TOKENS` 3,000 waits on
    the same check.
  - Untested: 69 device, browser, and real-model checks listed per slice in the run's final
    report, among them Firefox and Safari, Android PWA, a real V3 plugin, and real provider costs.
  - Rollback cost: an older build refuses a snapshot with the `memory_state` column, reads a
    trashed page as live, and refuses a chat file holding `merge` or `split` history entries.
  - Found by the run: 17 entries under Structured Memory in `docs/research/found-issues.md`.
- Server Plugin Runtime:
  - Retired by the owner on 2026-11-03 before any slice landed. It proposed an opt-in
    QuickJS-wasm runtime in the script worker pool (`//@runtime server`) running the hook half
    of API 3.0 plugins inside a generation job; D1–D10 stayed recommendations and Q1–Q3
    (engine package, server `chatOutput` deadline, operator default) were never answered.
  - Nothing in the code depends on it: plugins run only in the tab, an absent owner's reply
    hooks follow skip-and-replay (`e294d957a`), and the
    [Job Handoff plan](../plan/job-handoff.md) covers the absent-tab case by handing the owner
    role to another tab.
  - Its design notes (why `node:vm` and `isolated-vm` were rejected, the host API subset, the
    `getRuntimeInfo().runtime` discriminator) are in the archived file if the idea returns.
- Guides To Source:
  - All 40 slices landed on 2026-11-04 and 2026-11-05 (plan-runner, on `dev`). The guides tree went from
    1,055,065 to 824,152 bytes (21.9% cut, about 104,000 bytes short of the plan's 720,000 expectation) and
    STRUCTURE.md from 33,151 to 19,083 bytes; per-module facts moved into source doc comments, every trim
    carried a fact ledger checked by `pnpm docs:ledger`, and `TREE_BYTES_RATCHET` stands at 825,000.
  - Path Ownership became `ownership.json`, validated by `pnpm check:docs` and queried by `check:changed`.
  - Use was measured in `docs/audit/guide-reads-2026-11-05-wave3.md`: whole-file guide reads fell from
    30.6% of section-capable reads before `docs:read` to 5.7% in waves 2 and 3.
  - Owner decision: the 40,000-byte ceiling, 36,000 target, 8,000 leaf, and 600-character item budgets stay
    (option A of that audit); revisit when a guide passes 36,000.
  - Not planned (the plan's Later list): a check that a `Files` entry's backticked identifiers exist in its
    path, and a `Files` generator from the owned modules' exports.
  - Found by the run: 51 findings, as 34 new entries and one updated entry, across most sections of
    `docs/research/found-issues.md`.
- Job Handoff:
  - All four slices landed on 2026-11-05 (plan-runner, on `dev`): `d60741baf` (server creator/owner,
    takeover tickets, offers), `5ea1222a4` (tab roles, worker policy, the creator's view), `c9344075d` (presence
    and the manual handoff), `0a9c56d20` (the two-tab browser driver and the final guide pass, after the `dev`
    merge `2f48542c5`).
  - Owner decisions recorded in the server-generation guide's Limitations: `handoff: "prefer"` does not guarantee
    that the first callback runs on the worker (no first-dispatch gate), and a queued root cascaded `disconnected`
    behind another job's expired root can end before the `absent` offer's 50 s budget.
  - Still open: the device checks (a phone with its screen off handing a job to a PC worker, a PC worker minimized
    for over 5 minutes, the phone's toast, stream, Stop and "Take back", the "Hand off to" menu across two browsers).
  - Found by the run: 4 entries in `docs/research/found-issues.md` (a retaken job's dropped live stream, a current
    owner taking its own offer, the role event's missing `clientName`, a cancelled hook overlapping the worker's
    next callback).
- Render Work Budget:
  - All slices landed on 2026-11-05 (plan-runner, on `dev`; Slice 5 split into 5a, the baseline before Slices 1–4,
    and 5b, the comparison after): obsolete row renders abort, failures are classified transient or final, shared
    transform and translation requests are cancelled only when their last subscriber leaves, translation has a
    global cap of 10 provider requests, identical CSS is scoped once in a bounded cache, and the screenshot export
    writes capped PNG pages through a Blob.
  - Measured in `docs/audit/render-work-budget-2026-11-05.md`: three acceptance items met (no parser or
    translation call after a switch, one preparation per sheet); two not met and moved to
    `docs/research/found-issues.md` by owner decision (more than one transform chunk in flight at a switch, the
    screenshot peak growing with rows). Traces stay out of git in the main checkout's git directory.
  - Not planned (the plan's Later list): F3 and F6 (the mount profile did not settle between single runs), an
    early release of a cancelled chunk's server snapshot, reversing Q4 (let dispatched transform requests finish)
    or Q2 (selected-range export), and the `measureChats.mjs` settling delay; F1 and the per-chat message index
    belong to the Incremental Chat Transport plan.
  - Owner device checklist, open: Firefox and Safari page size at Safari's canvas limit, iOS Safari's canvas area
    against `MAX_EXPORT_PIXELS`, a multi-page export in an image viewer, a failed export's error alert and scroll
    restore in a real browser, a phone switching chats mid-auto-translate, far-row containment.
  - Found by the run: five entries in `docs/research/found-issues.md` (the two unmet items, the black page fill,
    the run left alive by raw streaming, `getFileSrc` never rejecting).
- Asset Lifecycle:
  - All five slices landed on 2026-11-05 (plan-runner, on `dev`): `b7095d591` (the mark, the ledger, the report and
    scan routes, the daily scan), `dd35ebc52` (the sweep, `claimAssetKey`, the disk preflights, the restore retention
    hold), `0c3e7d2d0` (snapshot pins, labels, manual snapshots, deletion, `pin` → `stageCopy`), `967cc5be1` (the
    Storage section of Advanced settings), `7d6ff9970` (the browser driver), with `dev` merged in at `68fe47877`,
    `36a8e6e1e`, and `1f85bea4b`. Each slice's deviations from its text are listed under it in the archived file.
  - Owner-visible behavior: a card import ends with an error when a key its record names is gone and its bytes
    are not in hand; the sweep's synchronous turn re-marks the whole live store (about 1.7 s idle, 2.8–3.1 s under
    load on the audit seed, `docs/audit/asset-scan-2026-11-05.md`), during which every request waits.
  - Still open: the device checks (a Docker volume on a nearly full disk: the 507 answers of the restore, the
    backup import, the upstream commit, the upstream export prepare, and the manual snapshot, and the snapshot
    tick logging once and skipping); a clicked-through check of the Storage panel beyond the driver.
  - Found by the run: 2 entries in `docs/research/found-issues.md` (a declined lowLevelAccess on a JSON card
    falling through to the off-spec import, `docs:owner` sending the asset lifecycle client to persistence).
- Incremental Chat Transport:
  - All six slices landed on 2026-11-05 (plan-runner, on `dev`): `f033d69ce` (Slice 0, the validated message position
    index: 200 updates at 10,000 messages 1,290.9 → 0.5 ms), `ca5a5cb8e` and `78fa91b3c` (Slice 3, the change log and
    the `?since=` replay: resume-away 88,727 → 536 wire bytes), `917273384` (Slice 1, feed `rowDelta`: about 1,700
    bytes per long-reply checkpoint, 0 observer whole reads instead of 4), `2272abf6e` (Slice 4, the `rows` manifest
    and `chatRows` read: 967,029 → 394,652 bytes for the mixed fixture's over-cap entries), `f906c864e` (Slice 2,
    streamed rows and `proto=1`: the owner's patch 33,265 → 498 bytes per checkpoint), `054ad8130` (Slice 5, the
    browser runs and after lines), with `dev` merged in at `feb379e86`. D6 was amended during the run (`b234d14ff`):
    the manifest names the changed metadata fields, since the server cannot rebuild a metadata diff at read time.
  - Owner-visible behavior: a tab older than the deploy takes a notice and one whole read for every entry past 8 KiB
    until it reloads (D8); while a Job Handoff viewer is attached, the owner gets its streamed rows whole.
  - Still open: Firefox, Safari and mobile runs of the reconnect and the feed; the two-device check of a long reply
    watched from a second device; an owner reloading mid-stream on a real device (`streamed` rows and the resync).
  - Found by the run: 4 entries in `docs/research/found-issues.md` (the change log's row-count bound, `proto` absent
    from Diagnostics, `measureChats.mjs` and safe boot, a `checkServerSend` alert after its reload).
- Plugin Storage and Data API:
  - All 11 slices landed on 2026-11-05 (plan-runner, on `dev`): `c140f2db7` (Slice 0, the measurement driver),
    `d5c824f99` (Slice 1, the plugin data page and permission reset), `b3e3417a8` (Slice 2, nested and by-name write
    patches), `86ac8b272` (Slice 3, reserved dictionaries kept on a `pluginCustomStorage` write), `c81a3fab7` (Slice 4,
    the detached `getDatabase` read), `2b778c365` (Slice 5, the detached chat reuse cache), `d7e305392` (Slice 6,
    owned `pluginStorage`), `aab3052ef` (Slice 7, `setDatabase` skips unchanged characters), `142c3920e` (Slice 8,
    the summaries option and `getChats`), `e6e02d2ba` (Slice 9, the sandbox browser spec), `aa6687b96` (Slice 10, the
    guide pass), with `dev` merged in at `d3add7cc2`. Q1–Q5 were answered as recommended: owned `pluginStorage` with
    legacy read-through and claim-on-write, reserved dictionaries kept, a 64 MiB reuse cache, one confirm with "also
    delete its stored data" on removal, and `getDatabase()`'s default unchanged.
  - Measured with `util/playwright/measurePluginData.mjs` (300 characters, 3,000 chats): a `pluginStorage.setItem`
    save 2,051,203 → 244 bytes and a plugin toggle 1,026,620 → 229; `getDatabase(["characters"])` 300 sequential
    reads (about 30 s) → 7 cold and 1 on a repeat call; an unchanged `getDatabase` → `setDatabase` round trip 27.4 s
    and 300 reads → 6.8 s and 39 (the characters whose chats the cache evicted).
  - Still open: browser checks of the plugin data page (namespaces, owners, assign, deletes), Reset permissions and a
    reinstall asking again, the remove dialog's checkbox (default, Enter/Space, unchecked keeps data), the reuse
    cache after a hidden tab and after another tab's chat edit, a summaries call making no chat read, a `getChats`
    page's order, and the developer hint printing once.
  - Not planned (the plan's Later list): a streamed `getDatabase` transfer into the iframe, device-local large storage
    spaces, owners for `getLocalPluginStorage()` and the top-level custom keys, and changing `getDatabase()`'s default
    once the developer access recorder has run on the owner's plugins (Q5).
  - Found by the run: 5 entries in `docs/research/found-issues.md` (the feed still sending `pluginStorage` and plugin
    toggles whole, `flushResources` after a restore halt, Reset permissions leaving a running plugin's capabilities, a
    multi-tab removal bringing deleted data back, the global-api guide's checkbox confirm).
- Reroll Candidates:
  - All 4 slices landed on 2026-11-05 (plan-runner, on `dev`): `30bec41a4` (Slice 1, the `candidates` schema and the
    in-place reroll job), `4976a15f0` (Slice 3, the memory commit boundary and the RisuAI-compatible export and import
    mapping), `080ea1184` (Slice 2, the `selectCandidate` op and the tab's candidate controls, landed after
    Incremental Chat Transport with its merge tests), `807b980de` (Slice 4, `e2e/rerollCandidates.spec.ts` and the
    guide pass), with `dev` merged in at `037f93f6b` and `6a4ab93f9`. Q1–Q4 were answered as recommended.
  - Still open: the phone swipe on the owner's server (the `n/m` counter, the arrows, kept across a reload), and a
    server process death or an abort past the grace mid-reroll (D8: the previous reply stays selected, no partial
    text), which only a manual kill shows.
  - Not planned (the plan's Later list): a single-candidate delete control, a boot sweep writing back the previous
    candidate after a process death, bundle candidates for multi-reply tails, PocketRisu `swipes` in the `.bin`
    export, and pruning older messages' candidates at the commit boundary.
  - Found by the run: 2 entries in `docs/research/found-issues.md` (the dead dynamic reroll icon variant, the
    Structured Memory decision pointers that still say "plan").
- Found Issues Sweep:
  - All 26 slices landed on 2026-11-05 (plan-runner, on `dev`); the archived Status line lists each slice's
    commit, from A1 (`5d20f1e28`) to K2 (`144e0ddbe`). The eleven open questions were answered as recommended;
    G1 took option A (an owner taking its own open offer reattaches), and I1's `castSlice` item moved to the
    Deferred list (named-page matching).
  - Still open: the C4 lorebook-filter check in a browser (press + on a host and inside a filter-expanded folder,
    then open an entry there and change the query: the entries stay visible and open).
  - Not planned: the plan's Deferred groups (feed patch forms, editor drafts as refresh holds, the handoff
    detach, plugin lifecycle, the render failure channel, screenshot memory, token counting, the trim question
    design, transform key and measurements, snapshot storage sizing, named-page matching, `proto` diagnostics,
    a mounted DefaultChatScreen harness, the `/sw/img` reproduction, the Structured Memory follow-up); their
    entries stay in `docs/research/found-issues.md`.
  - Found by the run: 10 entries in `docs/research/found-issues.md` (the trim question counting blank history,
    a combined translation paragraph written as HTML, `/multisend` keeping its quotes, scheme and local ui
    writers skipping the display apply, `#import_preset` after a refusal, a stray `}}` ending CBS highlighting,
    two hard-coded inlay explorer strings, `docs:contracts` on EPIPE, chat-pipeline's non-fencing refusal list).
- Implementation Audit Fixes:
  - The 81 findings of the seven implementation audits of 2026-11-05 (asset lifecycle, incremental chat transport,
    job handoff, plugin storage, render work budget, reroll candidates, structured memory) each got a disposition:
    45 file-cluster slices fixed 68 of them (PS5 merged with E4, OTHER-02 with RC5), 12 were excluded as edge
    cases, and 1 was deferred. All 45 slices landed on `dev` on 2026-11-05/06; the archived Status line lists each
    slice's commit, from T1 (`4ddbedc0b`) to C7 (`07520cf65`). The owner decided Q1–Q3 as recommended on
    2026-11-05: range-backed PNG replay for a File or Blob, with streams keeping their retention (an assets
    Limitation); an owner and a viewer projection of a handoff baseline; an old window's repair protecting the
    later scene state.
  - Owner-visible behavior: with prompt text stored in the chat, the stored prompt copy no longer shows
    `editRequest` hook edits, since the hooks run once per request (C5, `7f50a554a`).
  - Still open: R6's screenshot font check (`d94380fa5`): in a real browser, export a chat whose theme uses an
    `@import` webfont and confirm the font is fetched once and the image uses it; the 150-row driver fixture has no
    `@import` webfont, so it was not measured.
  - Not planned: the 12 excluded findings and the deferred media URL lifetimes (AL U1) moved to
    `docs/research/found-issues.md` at retirement; the seven reports are in `docs/manual-audit/archive/`.
  - Found by the run: 18 entries in `docs/research/found-issues.md` (append cleanup order, the feed text diff
    prefix, lockless foreign Stop marks, untargeted handoff offers, slash commands during a reroll, trigger
    copies, HypaV3 chunk scans, Lua image asset claims, transform snapshot aborts, the translator's status,
    eviction and provider switch, screenshot `@import` growth, embedded card base64 retention, bulk plugin
    character adds, the recheck trim's evidence, thread provenance, legacy window hashes).
- Consolidated browser/production verification debt was tracked in the audit/performance
  plan's Phase 5, now archived; its still-open items are listed with that plan's entry
  above.

## Archive Procedure

Remove a completed/retired plan and its active-list link, then add its last existing
commit/path, current guide ownership, and unresolved follow-ups here. Verify with
`git show <commit>:<path>` before deleting it. Keep operational contracts in current
guides rather than asking readers to load a historical plan.
