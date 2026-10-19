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
git show 723700902:docs/plan/boot-resource-cache.md
git ls-tree -r --name-only 9d09288b -- docs/plan/PLAN.md docs/plan/phases/
```

For another entry, substitute its commit/path. A historical reference such as
`docs/plan/chat-binding.md` is retrievable with `git show 809b35cc:docs/plan/chat-binding.md`;
it is not a current architecture guide.

## Completed Plans

| Design                              | Last tree / original paths                                                | Current owner                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server-owned data, Phases 0–6       | `9d09288b`: `docs/plan/PLAN.md`, `docs/plan/phases/`                      | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md)                                                                                                                                                                                                                 |
| Split Preset and Chat Binding       | `809b35cc`: `docs/plan/split-preset.md`, `docs/plan/chat-binding.md`      | [persistence](../structure/persistence.md), [settings](../structure/settings-i18n.md)                                                                                                                                                                                                                  |
| Shared API Keys and Model Profiles  | `317a97ce`: `docs/plan/shared-api-keys.md`, `docs/plan/model-profiles.md` | [LLM requests](../structure/llm-requests.md)                                                                                                                                                                                                                                                           |
| Translation and URL Routes          | `df25006f`: `docs/plan/translation.md`, `docs/plan/url-routes.md`         | [media/translation](../structure/media-aux.md), [app shell/routes](../structure/app-shell.md)                                                                                                                                                                                                          |
| Web Push                            | `e148f7276`: `docs/plan/web-push.md`                                      | [browser notifications](../structure/global-api.md), [worker](../structure/build-test-platforms.md), [server](../structure/self-host-server.md)                                                                                                                                                        |
| Request History and Diagnostics     | `ab11ea9d0`: `docs/plan/request-history-diagnostics.md`                   | [diagnostics](../structure/diagnostics.md), [LLM capture](../structure/llm-requests.md)                                                                                                                                                                                                                |
| Per-Chat Toggles and Toggle Presets | `154711858`: `docs/plan/chat-toggles-and-presets.md`                      | [persistence](../structure/persistence.md), [UI/theming](../structure/ui-theming.md), [CBS/rendering](../structure/cbs-rendering.md)                                                                                                                                                                   |
| Large Asset Import and Export       | `1bb0c8eee`: `docs/plan/large-asset-import.md`                            | [characters/modules](../structure/characters-modules.md), [server](../structure/self-host-server.md), [persistence](../structure/persistence.md), [asset client](../structure/global-api.md), [UI/theming](../structure/ui-theming.md)                                                                 |
| Sidebar Chat Status                 | `f5895b925`: `docs/plan/sidebar-chat-status.md`                           | [UI/theming](../structure/ui-theming.md), [chat pipeline](../structure/chat-pipeline.md), [persistence](../structure/persistence.md), [app shell](../structure/app-shell.md)                                                                                                                           |
| Data-Loss Under Concurrency         | `01ceb829b`: `docs/plan/data-loss-concurrency.md`                         | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [chat pipeline](../structure/chat-pipeline.md), [memory](../structure/memory.md), [plugins/MCP](../structure/plugins-mcp.md), [UI/theming](../structure/ui-theming.md), [app shell](../structure/app-shell.md) |
| Settings UI Reorganization          | `46eeee597`: `docs/plan/settings-ui-reorg.md`                             | [settings](../structure/settings-i18n.md), [app shell/routes](../structure/app-shell.md), [media/translation](../structure/media-aux.md), [LLM requests](../structure/llm-requests.md)                                                                                                                 |
| Boot Resource Cache                 | `723700902`: `docs/plan/boot-resource-cache.md`                           | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md), [build/test](../structure/build-test-platforms.md)                                                                                                                                                             |

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
Boot Resource Cache landed four slices on 2026-10-19 on the `boot-resource-cache` branch:
compressed resource reads (`1d382e8d0`), the `POST /api/resources/boot` read that skips what the
client holds (`9b831002a`), the IndexedDB boot cache (`ad7370e9e`), and the browser measurement
and check (`723700902`, `util/playwright/measureBoot.mjs`, `checkBootCache.mjs`). On a synthetic
server of the reported shape at 10 Mbps the main screen came after 18.3 s with the uncompressed
plain read, 6.5 s on a first (cold) boot, and 0.51 s on a warm boot; the archived Slice 4 section
holds the full table and the decisions (no server hash cache; compression settings and `presets`
as an item kind kept).

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
- Consolidated browser/production verification debt remains tracked in the active
  [audit/performance plan](../plan/audit-findings-perf.md), especially Phase 5.

## Archive Procedure

Remove a completed/retired plan and its active-list link, then add its last existing
commit/path, current guide ownership, and unresolved follow-ups here. Verify with
`git show <commit>:<path>` before deleting it. Keep operational contracts in current
guides rather than asking readers to load a historical plan.
