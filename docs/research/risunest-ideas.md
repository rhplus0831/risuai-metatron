# RisuNest → metatron: portable ideas

Survey date 2026-10-20. Read-only comparison of RisuNest (`/home/codex/RisuNest`, HEAD `a527b3956`, App 1.0.6 / Sync 1.0.5, upstream base RisuAI 2026.8.250) and metatron (`/home/codex/risuai-metatron`, branch `metatron`, HEAD `44e18f2ae`, also tagged upstream `v2026.8.250`).

Path prefixes: **RN** = RisuNest, **MT** = metatron. "Verified" means I or a research pass read the cited lines; "not verified" marks an inference. Effort: S ≈ a slice or two, M ≈ a small plan (3–6 slices), L ≈ a multi-phase plan.

---

## 1. Portable feature and concept candidates (ranked by value to effort)

### 1. Alert queue (dialogs wait their turn, statuses replace each other) — S/M
- **RN:** `src/ts/alertQueue.ts:37` `createAlertQueue`.
  - Loading, progress and toast messages share one status slot, and the newest replaces the old.
  - Every other alert is a FIFO dialog that resolves only its own caller (`open()`).
  - Identical repeated notices fold into one (`sameNotice`).
  - A 150 ms gap before the next dialog (`NEXT_DIALOG_GAP_MS`) stops a double click or a held key from answering a dialog the user never saw.
  - Tests: `src/ts/alertQueue.test.ts`, `alert.queue.test.ts`.
- **MT:**
  - `alertStore` is a plain `writable` (`src/ts/stores.svelte.ts:76`), and helpers wait by polling it every 10 ms.
  - `docs/structure/global-api.md` Known Hazards says local UI can replace a job question's alert, and cancelled questions can stack pollers.
  - Only the job channel queues its own notices (`src/ts/network/jobChannel.ts`), and the terminal and reload notices sit outside the store.
- **Why:** this fixes a documented hazard class: an alert overwrites a pending confirm, and a stray Enter answers the next dialog. Answering through promises instead of polling also removes the 10 ms poll loops.
- **Adaptation:**
  - Keep the `alert.ts` helper signatures and swap the store underneath for a queue.
  - `AlertComp.svelte` reads the head, and `alertClear` and `alertTerminal` keep their contracts.
  - Check the job-channel queue (`jobChannel.ts`) does not double-queue.

### 2. Safe boot / startup exclusions — S
- **RN:**
  - `src/ts/storage/startupExclusions.ts:5-13` defines the categories: plugins, modules, global regex, theme/CSS, sync, auto-update and account.
  - A boot attempt counter and stage trail (`src/ts/storage/bootAttempt.ts:25-66`) opens a recovery shell after repeated failures (`recoveryMode.svelte.ts:70-95`).
  - After a boot succeeds, it asks whether to keep the excluded categories off (`recoveryExclusionPrompt.ts:30-46`). A settings card lists kept-off items with "Turn on" (`src/lib/Setting/Pages/RisuNestStartupExclusions.svelte`).
  - `plugins.svelte.ts:526-540` `keepPluginsOffForThisStart` keeps a reload or sync from turning plugins back on.
  - `bootFailureClassification.ts:44-55` sorts a boot error into a category, and `BootFailurePanel.svelte` shows it.
- **MT:**
  - Boot errors only `alertError` (`src/ts/bootstrap.ts:156`), and plugin load failures are swallowed (`bootstrap.ts:119-122`).
  - `SafeModeStore` (`stores.svelte.ts:74`) only turns custom CSS off through a hotkey, and it is not kept across reloads.
- **Why:** a v3 plugin with main-document access, a broken module or a broken global regex or theme can brick every boot. Today the only way out is editing data on the server.
- **Adaptation:**
  - Use a `?safe=plugins,modules,css` URL flag plus a `localStorage` boot counter, checked in `bootstrap.ts` before `loadPlugins` and inside `loadPlugins` (`src/ts/plugins/plugins.svelte.ts:377`).
  - Server-side work (regex, Lua) is per job, so "skip modules or global regex" would have to travel in the job request. A client-only first slice that covers plugins and CSS is the cheap part.

### 3. Plugin quick wins: body expiry, live reload, v2.1 report — S
- **RN:**
  - Unread `nativeFetch` response bodies expire after `UNREAD_PLUGIN_STREAM_TIMEOUT_MS = 60_000` (`src/ts/plugins/apiV3/factory.ts:611`, timer ~`:898-950`, documented at `plugins.md:913`).
  - When a received change touches the plugin list, plugins reload once idle (`plugins.svelte.ts:464-492`, `pluginCompatibility.ts:75-110`).
  - A stored v2.1 plugin gets a one-time load report and a settings badge (`plugins.svelte.ts:495-523`, `PluginSettings.svelte:66-72,150-158`).
  - `risuFetch` and `nativeFetch` get an abort signal on unload (`factory.ts:609` `requestSignalKeys`).
- **MT:**
  - There is no expiry timer (verified: no `UNREAD` or timeout in `src/ts/plugins/apiV3/factory.ts`). An unread body also holds a server `/proxy` upstream connection.
  - A live update to `plugins` or `pluginStorage` only calls `applyRaw` (`src/ts/storage/resourceSync.svelte.ts:2833-2843`), so a plugin disabled or updated on another device keeps running in this tab.
  - Non-3.0 plugins are filtered out silently (`plugins.svelte.ts:380-382`).
- **Why:** these are small, self-contained correctness fixes. The live reload matters more on metatron than on RisuNest, because every tab of every device shares one plugin list.
- **Adaptation:** client-only. Hang a deferred `loadPlugins` off the `plugins` live-apply branch and reuse RN's idle wait. The unread-body timer goes in `SandboxHost`.

### 4. Unit-test network guard — S
- **RN:**
  - `vitest.setup.ts:8-36` wraps `fetch` and `WebSocket` and hooks happy-dom's fetch interceptor, which also covers XHR and iframe loads.
  - `afterEach(() => testNetwork.finish())` fails a test even when its code caught the blocked request.
  - `tests/support/testNetwork.ts` allows `data:`, `blob:` and an exact loopback origin through `allowTestLoopbackOrigin`, and always blocks Realm.
  - `tests/testNetwork.node-test.mjs` proves the guard itself.
- **MT:** `vitest.setup.ts` (83 lines) has no network guard (verified). Egress tripwires exist only in the Playwright stack (`util/playwright/stack.mjs`, `offline.sh`).
- **Why:** this fits V3's determinism rule. A test that silently reaches the network, such as Realm, a provider or a tokenizer CDN, is a load-sensitive flake waiting to happen.
- **Adaptation:**
  - Port the setup for the happy-dom projects.
  - Server tests (`@vitest-environment node`) that start real Hono servers on loopback would call `allowTestLoopbackOrigin(origin)` from `server/src/tests/testSupport.ts`.
  - Expect a first run to surface existing offenders.

### 5. CI pipeline and production-image hygiene — S/M
- **RN:**
  - `.github/workflows/pr-check.yml` runs `check`, `build`, `check:production-bundle`, `test`, Playwright, the test-reference action and `test:node`, plus a separate job for the inventory and the frontends.
  - Actions are pinned by SHA and checkouts use `persist-credentials: false`.
  - `tests/productionBundle.mjs:62-176` builds with `write:false` and rejects any chunk, `.map` source or `sourcesContent` that comes from `tests/`, `benchmarks/`, `*.test`/`*.spec`/`*.bench`/`*.testSupport`, or test libraries. It deliberately sets the removed harness flags to prove they do nothing.
- **MT:**
  - There is no CI directory at all: no `.github/`, `.gitea/` or `.forgejo/` (verified).
  - `.dockerignore` contains only `node_modules` (verified). The Dockerfile copies all of `server/` and `shared/`, so `server/src/tests/` (about 3.8 MB according to the research pass, not verified) and `shared/tests/` ship in the image as dead weight.
- **Why:** V1's gates run only on agent machines today. A forge workflow catches a commit that skipped them. Excluding test trees shrinks the image and removes fixtures that might hold captured data.
- **Adaptation:**
  - One workflow on the forge the user hosts (which forge software it runs was not verified): `pnpm install --frozen-lockfile`, `check`, `format:check`, `test` with `CI=1` (`util/requireHuman.mjs` already opens on `CI`), and `build`. Put `test:e2e` in a separate job.
  - Add `**/tests/**` and `**/*.test.ts` to `.dockerignore` or the runtime `COPY`.
  - Optionally a small bundle check over `dist/`.

### 6. Staged backup import with a preview (prepare → confirm → commit or cancel) — M
- **RN:**
  - Imports are jobs with an explicit `AwaitingActivation` phase. The data is fully staged, the user confirms, and only then does the swap happen (`src-tauri/src/native_file_jobs/mod.rs:3665-3682`, `src/ts/storage/contentImportOperation.ts:9-28`).
  - Reports tell the user what was preserved, converted or excluded (`compatibleBackupReport.ts:28-42`, `exportExcludedReport.ts:8-26`, `preservationReportMessage.ts:8-15`).
- **MT:**
  - `POST /api/backups/import` (`server/src/routes/backups.ts:411-470`) validates the whole archive, takes a safety snapshot, then replaces every resource in one call.
  - The two-step pattern already exists for Realm: `server/src/routes/importRealm.ts` (prepare/commit/cancel, token, 4 slots, 10-minute TTL) over `server/src/http/fileImport.ts` (`prepare` at `:119`).
- **Why:** a backup import replaces the whole library (new epoch, every tab reloads). The user should see "N characters, M chats, K assets, X missing, made on <date>, schema v3" before committing, and should be able to back out without depending on the safety snapshot.
- **Adaptation:** reuse the Realm staging slot and token. Prepare spools the file and indexes the archive (it already does in `planImport`) and returns a manifest summary. Commit runs today's import. The UI is a confirm dialog in `src/ts/drive/backuplocal.ts` `LoadLocalBackup`.

### 7. Asset garbage collection and a storage dashboard — M
- **RN:**
  - The storage dashboard (`src/lib/Setting/Pages/RisuNestStorageDashboard.svelte`, `src/ts/storage/risuNestStorageDashboard.ts:66-135`) shows sizes for media, inlays, plugins, snapshots and conflict backups, plus record counts.
  - Unused-file cleanup previews first, then deletes. It explains why each file is kept: in use, held by a snapshot, a repair, a sync, a migration or a running job (`src-tauri/src/asset_repository/migration_gc.rs`, `job_pins.rs`). Snapshots record which assets they reference (`snapshot.rs:475`).
- **MT:**
  - `docs/structure/self-host-server.md:500` (Known Hazard, verified): "inlay blobs are never deleted … so `save/assets/` only grows".
  - `src/ts/process/files/inlays.ts:25-27` says the same (verified).
  - Searching the server code for a sweep or garbage-collection routine finds nothing (verified).
  - "Load Internal Backup" lists snapshots without sizes.
- **Why:** a self-hosted disk grows forever, especially with Lua `getCharacterImageMain`, inlay-heavy chats and repeated imports. The user has no way to see where the space goes.
- **Adaptation:**
  - The server marks assets referenced from `resources.sqlite` and from every retained `save/backups/*.sqlite`, with a grace age, then sweeps under `withMaintenance`.
  - Add `GET /api/storage/usage` for sizes per category and per snapshot.
  - Add preview and execute routes, and an Advanced settings page.
  - Reference extraction must cover every place an `assets/…` key can appear: characters, personas, presets, modules, inlays, the `ui` section and folders.

### 8. Snapshot management: manual, labeled, pinned, downloadable — S/M
- **RN:**
  - Snapshots are taken automatically once a day, manually, and before a repair, each tagged with a reason (`nativePersistentMaintenance.ts:16-17,327-364`).
  - Retention keeps at most 8 snapshots within max(4 × database size, 512 MiB), dropping the oldest periodic ones first (`snapshot_archive.rs:350-366`).
  - External history lets the user pin points (pinned ones never expire) and export a remote snapshot to a file (`external_storage/connection.rs:67-160`, `snapshot_export.rs`).
- **MT:**
  - Snapshots are taken every 10 minutes while data changes, and the newest 20 are kept (`server/src/data/snapshots.ts:8-9`, verified).
  - The only actions are list and restore (`src/ts/globalApi.svelte.ts` `loadInternalBackup`). There is no manual, labeled or pinned snapshot, no size display, no delete and no download.
- **Why:** with a 10-minute cadence and 20 kept, the oldest snapshot is about 3 hours of active use old. A heavy session can rotate away the pre-mistake state. "Snapshot before I try this module" plus a pin is cheap insurance.
- **Adaptation:**
  - `snapshotNow(label, { pinned })` exempts a snapshot from count rotation.
  - Optionally a daily tier: keep N recent plus one per day for D days.
  - Add `GET /api/backups/:id/download`, which streams the snapshot as a version-2 archive through the export path.
  - Combine with item 7, because pinned snapshots extend asset reachability.

### 9. Persisted reroll candidates and interrupted-reroll recovery — M
- **RN:**
  - Reroll candidates live on the last reply as `responseVariants {groupId, selectedId, candidates[]}` (`src/ts/responseVariants.ts:5-46`, verified), ported from PocketRisu (commit `d543bea91`, according to the research pass).
  - `Chat.rerollRecovery` records the original tail before a reroll, and `recoverInterruptedReroll` restores it after a crash (`src/ts/durableReroll.ts:76`, verified).
  - UI: `src/lib/ChatScreens/ResponseCandidateControls.svelte`.
- **MT:**
  - Swipe history is in memory, per screen, with an LRU of 16 chats (`src/ts/process/rerollHistory.ts`, verified) plus `prereroll.ts`.
  - It is lost on reload or remount and is not shared across tabs or devices (`docs/structure/chat-pipeline.md`).
- **Why:**
  - It is user-visible: ← / → over candidates survives a reload and shows on the phone.
  - The server already owns reroll jobs (run as `send`), so the job can append the candidate in the same write.
  - Interrupted-reroll recovery partly overlaps metatron's server-side job recovery, so the persisted candidates are the main win.
- **Adaptation:**
  - A new message field means a shared type, `shared/sections.ts` ownership, the server message normalizer, and the per-message patch path (D2).
  - Decide whether to keep RN/PocketRisu's field name and shape so `.bin` and PocketRisu interchange stay possible (see item 10).
  - Size budget: each candidate copies messages, so it needs a cap.

### 10. Upstream RisuAI interchange: import `.bin` and export a compatible `.bin` — L (also a policy decision)
- **RN:**
  - Restores upstream RisuAI `.bin` backups, RisuAI account backups and PocketRisu backups:
    - `src/ts/storage/databaseRestore.ts:44-143`
    - `src/ts/drive/pocketRisuBackup.ts`
    - `src/ts/storage/upstreamImport.ts:28-52`: drops group chats and `§temp`, and renames `groupTemplate` → `messageNameTemplate` (verified).
  - Exports a RisuAI- or PocketRisu-compatible database with a Preserved / Converted / Excluded report (`compatibleBackupReport.ts`).
  - Onboarding offers "Import from a backup file" on first launch (`src/lib/Others/Onboarding/onboardingFlow.ts`).
- **MT:** `planImport` (`server/src/routes/backups.ts:428-440`, verified) refuses `encryption.risudat` (account backups) and any `database.risudat` (every upstream `.bin`). `docs/structure/persistence.md:130` records that the block save format was removed "without a migration". A user coming from upstream RisuAI can only bring cards and modules one by one.
- **Why:** this is the largest onboarding barrier for new users of the fork. Export also gives users a way back to upstream, which lowers the cost of trying metatron.
- **Adaptation:**
  - On the server, decode RisuSave (the upstream `decodeRisuSave` format) into a staged Phase 3 store through the existing normalizers (`server/src/data/normalize/`). Run it through item 6's preview, with a report of dropped fields.
  - Encrypted account backups probably stay out of scope.
  - This conflicts with the "no migration owed" stance, so the user needs to decide.

### 11. Plugin storage: isolation per plugin, local device spaces, and a data manager — M/L
- **RN:**
  - `pluginStorage`, `safeLocalStorage` and `getLocalPluginStorage()` are scoped to the plugin's `//@name` (`src/ts/plugins/pluginStorageStore.ts:25-47` `forOwner`, `plugins.md:646-651`).
  - Values that have no owner are claimed or assigned (`pluginClaimSession.ts`, `storage/pluginValueAssignDialog.ts`).
  - Large local device spaces in IndexedDB (`pluginDeviceStorage.ts`, `pluginDeviceKeyspace.ts`).
  - A plugin data manager can search, filter by owner, delete, and delete with the plugin (`src/lib/Setting/RisuNest/PluginDataManager.svelte`, `pluginDataInventory.ts`, `pluginRemoval.ts:8-17`).
- **MT:**
  - Every plugin shares one `pluginStorage` record (verified: `docs/structure/plugins-mcp.md:110-112`).
  - The record is a singleton saved whole on every write (`server/src/data/kinds.ts:148-154`, according to the research pass).
  - `safeLocalStorage` is raw `localStorage` `safe_plugin_*`, so `clear()` wipes every plugin's keys (`pluginSafeClass.ts:40-80`, according to the research pass).
  - There is no UI to inspect plugin data, and removing a plugin leaves its data behind.
- **Why:**
  - Correctness: one plugin's `clear()` hits the others.
  - Performance: one big plugin value re-sends every plugin's data on each save.
  - Users get a way to find and remove leftovers.
- **Adaptation:**
  - A first slice of the data manager over the shared record is S.
  - Per-owner server records (one resource id per plugin) remove the whole-record resend.
  - Isolation breaks plugins that read each other's keys (RN documents this), so it needs RN's claim/assign migration.

### 12. Data health scan (optional repair later) — M
- **RN:**
  - A quick or deep scan sorts findings by severity and code: missing or invalid reference, alias mismatch, orphan record, unreferenced object.
  - It previews repairs, takes a snapshot first, and keeps an undo journal. Reports can be exported with owner names masked.
  - Files: `src/ts/storage/dataHealth.ts:5-232`, `src/lib/Setting/Pages/RisuNestDataHealth.svelte`, Rust `src-tauri/src/data_health/`.
- **MT:** `PRAGMA integrity_check` and row validation run only when a snapshot or backup is read (`server/src/data/resourceStore.ts:1225-1246`, according to the research pass). There is no on-demand scan.
- **Why:** metatron's history has many "lost create", "orphan chat" and "dangling order" hazards (memory: same-id recreate, recognized parent create, reorder beside an in-doubt create). A read-only scan that lists chats whose character is gone, order entries without a chat, asset keys referenced but missing (the export already reports this), and inlays without bytes would turn silent drift into a visible report.
- **Adaptation:** a server route over `resources.sqlite` plus `save/assets`, with a report in the Diagnostics panel. Start read-only and add repairs one by one through the existing mutation modules.

### 13. Pinned upstream compatibility contracts for the cross-user formats — M
- **RN:**
  - `.github/actions/test-references/action.yml:6-23` pins `kwaroran/Risuai@c454df88…` and `PocketRisu@b315d898…`. `scripts/compatibleExportContract.mjs:18-77` checks the checkout's revision and the source-file hashes.
  - `scripts/compatibleExportReferenceHarness.mjs` extracts the real upstream decoder and encoder and runs them in a VM without network or timers.
  - `tests/referencePins.node-test.mjs` keeps the two pin locations in agreement.
  - Rule: "never install or start the reference app" (`AGENTS.md`).
- **MT:**
  - D5 requires byte compatibility for `.risum`, `.charx`, `.png`, `.risup` and `.risutl`, plus second readers on the server (`shared/moduleImport.ts`, `shared/charxImport.ts`, `server/src/routes/importPng.ts`).
  - Those are tested against metatron's own code and one-time golden captures (`server/src/tests/fixtures/baseline/README.md`), not against an upstream pin.
- **Why:** this turns D5 from "compatible with ourselves" into "compatible with upstream at commit X", and it catches upstream format drift when rebasing.
- **Adaptation:** a node-test that checks out a pinned upstream, extracts `exportModuleLegacy`, `readModule`, `CharXImporter` and `PngChunk`, and compares bytes on synthetic fixtures. Tag it `slow`, or give it its own script outside V1.

### 14. Chat screenshot with range selection and paged output — M
- **RN:**
  - A dialog picks a recent or full turn range (`src/ts/chatScreenshotRange.ts:132-136`).
  - It renders 8 messages at a time off screen at 960 px and cuts them into 8,000 px pages (`chatScreenshotCapture.ts:53-61`).
  - The output is one PNG or a streamed ZIP (`chatScreenshotArchive.ts`, written through `LocalWriter` on web). The source is held at a fixed revision (`chatScreenshotSourceLease.ts`), with progress and cancel.
- **MT:** `src/lib/ChatScreens/DefaultChatScreen.svelte:585-602` (verified) sets `loadPages = Infinity`, renders every row into canvases and saves one image.
- **Why:** on a long chat this undoes the staged row mounting and heap work (every row mounts at once) and can produce an image too large for the browser. A range and paging keep memory bounded.
- **Adaptation:** client-only. The capture surface can reuse metatron's row components. Hold the chat steady by chat and message id (D1) instead of RN's revision lease.

### 15. Message navigation: previous / next message, jump to top — S
- **RN:** a floating nav with top, previous message, next message and bottom (`src/lib/ChatScreens/DefaultChatScreen.svelte:1475-1513`; `Chats.svelte:2690` `jumpTo`, `:2895` `jumpToTop`, `:2915` `navigateMessage`, verified).
- **MT:** only a scroll-to-bottom button (`DefaultChatScreen.svelte:152,671-704`, according to the research pass). Searching `src/lib` for `navigateMessage`, `jumpToTop` and similar names finds nothing (verified).
- **Why:** reading long role-play replies on a phone is a common need.
- **Adaptation:**
  - Message stepping and jump-to-top must cooperate with the folded index window and the far-row marking in `Chats.svelte`.
  - Jumping to the top of a 2,000-message chat has to page rows in, so reuse the reveal or staging logic.

### 16. Inlay inventory and image size reservation — M
- **RN:**
  - Inlay inventory by type and extension with counts and bytes, and bulk conversion to WebP with progress and cancel (`src/ts/process/files/inlayInventory.ts:40-61`, `RisuNestInlayInventory.svelte`, `inlayOptimization*.ts`).
  - Image geometry: a background job saves width and height, and rendering writes `width`/`height` attributes so layout does not jump (`imageGeometryJob.ts`, `imageGeometryRender.ts:10-30`).
- **MT:**
  - `InlayAsset` already has optional `width` and `height` (`src/ts/process/files/inlays.ts:30-38`, verified).
  - The parser emits `<img>` without size attributes (verified around `src/ts/parser/parser.svelte.ts:660-672`).
  - There is no inventory or conversion. Inlays are re-encoded to PNG on save, according to the research pass.
- **Why:**
  - Size reservation pairs with metatron's chat-open reveal work: images loading late are a known source of scroll jump ("image growth" leftover in the chat-open-reveal memory).
  - WebP conversion addresses disk growth (item 7).
- **Adaptation:** the server reads dimensions when an inlay is written, through a header parse with no decode. A backfill job runs on the server, and the parser adds the attributes. Inventory and conversion are a server job with a settings page.

### 17. Engineering rules worth adopting from `AGENTS.md` and `tests/` — S
- **RN:**
  - `AGENTS.md:23`: before committing, `git grep` each changed product file and export across `tests/`, `scripts/`, `benchmarks/` and `.github/`.
  - `:24`: a check that cannot start is reported as unverified, not passed.
  - `:34-43`: temporarily break the guarded line to confirm the test fails; mock only process boundaries; share one mock factory typed with `satisfies typeof import(...)`; read product files through `node:fs`, not `?raw`.
  - `:53` and `tests/productionBundle.mjs`: product code never imports test or benchmark code.
  - `tests/suiteOwnership.mjs:367-435` with `tests/testInventory.mjs:24-84`: every test file has exactly one runner, checked against `vitest list --json` and `playwright test --list` (`pnpm check:test-inventory`).
- **MT:**
  - V3 already covers determinism, and "keep a test only when a plausible wrong implementation would fail it".
  - It has no consumer-grep rule, no unverified-check rule, no shared typed mock factory rule, and no inventory check. The slow-test table in `docs/structure/build-test-platforms.md` is kept by hand.
  - `util/playwright/*.mjs` measurement scripts are not type-checked (according to the research pass).
- **Why:** the memory file shows recurring stale-mock incidents ("Storage test alert mock gap", alert mocks without `alertTerminal`) that a `satisfies typeof import` factory would turn into `pnpm check` errors. An inventory check would also keep the slow-tag table honest.
- **Adaptation:** add rules to STRUCTURE.md V-section. Add a small inventory script that compares discovered `*.test.ts` and `e2e/*.spec.ts` files against the runners, and cross-checks `slow` tags against the doc table.

### 18. Device and session management, with QR pairing — M
- **RN (Sync daemon):**
  - `device add` issues a credential per device and stores only its verifier. `device add --qr` prints a registration QR (`server/sync/src/main.rs:13,91-229`).
  - `device revoke ID` (`server/sync/src/store/mod.rs:418-450`, `management/mod.rs:439`).
  - A restore revokes every device and starts a new epoch (`server/sync/README.md`).
- **MT:**
  - One password digest plus an append-only `known_public_key_hashes.json` of registered browser keys (`server/src/routes/auth.ts:26-41`, verified).
  - `/api/set_password` works only while no password is set (route table in `self-host-server.md`).
  - There is no list, revoke or password change. A lost phone stays authorized forever unless the user edits the file by hand.
- **Why:** this is basic hygiene for a server reachable from the internet, which a PWA with Web Push effectively requires.
- **Adaptation:**
  - Store a label, created-at and last-seen per key hash.
  - Add list, revoke and change-password (revoke all) routes, with a settings page.
  - QR pairing: a logged-in tab shows a short-lived one-time token as a QR of `https://<server>/pair?t=…`. The phone's camera app opens it and the phone registers its key without typing the password. No native barcode scanner is needed.

### 19. Lower priority (recorded so they are not lost)
- **Optional off-site backup push (M).**
  - RN has encrypted external providers: WebDAV, S3, Google Drive, OneDrive, GitHub releases (`src-tauri/src/external_storage/providers/`), with retention and pinned points.
  - MT keeps everything in `save/`. A scheduled server job pushing the version-2 archive to S3 or WebDAV would cover disk loss. Lower priority because Docker users often back up volumes already.
- **Plugin read scalability (M).**
  - RN has cursor-paged `queryCharacters`, `queryConversations` and `queryConversationMessages` (`risuai.d.ts:1637-1655`, `migrationGuide.md:184-259`), batched `getDatabase` snapshots (`pluginSnapshotStream.ts:5-40`), and setters that write only changed fields based on read baselines (`pluginReadBaselines.ts`).
  - MT `getDatabase` with `characters` loads every chat (`plugins-mcp.md` Known Hazards). The same section lists the "stale copy overwrites edits" hazard that read baselines fix.
- **Plugin permission reset (S/M).**
  - RN has a "Reset plugin permissions" action (`PluginSettings.svelte:24-27,274-277`).
  - MT's `pluginPermissions` grants are append-only with no revoke UI (`plugins-mcp.md:115`).
- **Plugin iframe browser spec and declaration check (S).**
  - RN: `tests/browser/pluginIframe.browser.spec.ts` (CSP, opaque origin, wrong-source replies, late replies after unload), `apiV3/v3.declarations.test.ts`, `check:plugin-dts`.
  - MT: "the guest bridge is untested" and its declarations disagree with the runtime (`plugins-mcp.md`, according to the research pass).
- **Release-notes check (S).** RN `scripts/release/source-check.mjs:112-180` checks the tag against the version, notes present with exactly the EN and KO sections, and matching versions. MT R1 bumps two places by hand. A `release:check` script asserting `version.json` == `appVer` is a two-line guard.
- **Windowed message reads (L).**
  - RN reads conversations in windows of at most 4,096 messages and keeps resident ranges under a byte budget (`persistentDataStore.ts:403-449`, `segmentedConversationResidency.ts:12-50`), benchmarked on a 50,000-message chat (`benchmarks/bounded-materialization/`).
  - MT loads a whole chat into the tab (`chatStore.svelte.ts`, up to 8 idle chats with LRU). The server already stores message rows, so a range read is easy there. The client chat module, CBS history and plugin getters all assume whole chats, so the client side is a large refactor. Only worth it if chats of 10,000 messages or more are a real use case.
- **HTML export: copy or download (S).**
  - RN `src/ts/htmlClipboardExport.ts:3` offers Copy only when the browser can write HTML to the clipboard, else Download, and falls back to Download on failure.
  - MT calls `navigator.clipboard.write` unconditionally (`src/ts/characters.ts:406-414`, verified). That fails on browsers without ClipboardItem support or outside a secure context (for example, the insecure-LAN case metatron documents for push).

---

## 2. Already covered, or not portable

**Metatron already has an equivalent, or a stronger one:**
- **Toggle bindings and toggle presets** (RN `toggleBindings.ts`, `chatBindings.svelte.ts`): MT's per-chat toggles and presets are more complete (`src/ts/toggles/`, `shared/togglePresets.ts`, `shared/chatBinding.ts`).
- **Desktop and system notifications** (RN `desktopNotifications.ts`): MT has Web Push (`server/src/push/`, `public/sw.js`).
- **Android generation keep-alive and mobile background tasks** (RN `androidGenerationKeepAlive.ts`, `mobileBackgroundTask.ts`): MT generation runs on the server.
- **Working-set navigation block while generating** (RN `src/lib/workingSetNavigation.ts:21-75`): MT deliberately allows switching mid-send, with sidebar status badges instead.
- **Plugin startup delay until sync finishes** (RN `pluginStartupGate.ts`): MT boot installs authoritative server state before `loadPlugins`. The remaining live-update concern is item 3.
- **Persistent data store with a global revision, leases and the Web Locks mutation gate** (RN `persistentDataStore.ts`, `storageMutationGate.ts`): MT has record-level revisions plus epoch, the server `MaintenanceGate`, and the generation fence.
- **Sync daemon, sync-wire, sync-connect, last-writer-wins working set, sync checkpoints, sync status UI and conflict backups:** MT's server is the single source of truth, with a change feed. Save and reload notices (`SavePopupIcon`, `ReloadNotice`) cover the user-facing part.
- **`parseRisuChat` for plugins** (RN `plugins/parseRisuChat.ts`): MT has the same contract, with hook context (`v3.svelte.ts:1593-1680`). RN's precise history access only matters with windowed history.
- **Plugin hot reload:** effectively the same in both (MT `apiV3/developMode.ts`).
- **Plugin iframe downloads** (RN `c03eb6ec8`): MT's sandbox already has `allow-downloads`, and it only runs in browsers.
- **Plugin `Date` → JSON normalization** (RN `14cb4a3a9`): MT rejects non-JSON values on purpose (`plugins.md`). Reversing that is a product decision, not a gap.
- **Anonymous HTML export, chat branching and source-map stack translation:** present in both.
- **Request history and network log** (RN `crates/network-log`, `RisuNestNetworkLog.svelte`):
  - MT's server request history covers LLM traffic with job linkage, redaction and support shares (`server/src/data/requestHistory.ts`).
  - Only non-LLM outbound traffic (`/proxy2`, hub) and per-chunk SSE timelines are missing. These are minor.
- **Console log viewer** (RN `consoleLog.ts`, which also captures plugin frames): it conflicts with MT's content-free diagnostics design (`docs/structure/diagnostics.md`). An opt-in, plugin-developer-only capture is possible but not recommended by default.
- **Chat editor drafts across row teardown** (RN `chatEditorDrafts.ts`): MT never trims a row while its editor is open (`Chats.svelte`).
- **Chat removal re-checking the target position** (RN `chatRemoval.ts`): MT addresses messages by id everywhere (D1).
- **Parser context seed and CBS history-access tracking** (RN `chatParserContextSeed.svelte.ts`, `cbsHistoryAccess.ts`): tied to RN's paged rendering. MT deliberately skips re-rendering old rows.
- **PO multisend save destination** (RN `d4978ce38`): MT's web path already saves once at the end (`src/ts/process/files/multisend.ts:106`). RN's fix is native-only.
- **Loadout** (an upstream feature, `215974e84`): MT removed it on purpose (`3728f3b09 refactor(risu): remove the Loadout feature`).
- **Lite mode and LiteUI** (RN `src/ts/lite.ts`, `LiteCardIcon.svelte`): upstream code, and `LiteMain` is dead code in RN too.
- **Mobile shell** (`src/lib/Mobile/*`): upstream. MT uses the desktop layout on small screens by design (`docs/structure/ui-theming.md`).
- **Runtime performance profile, Standard / Low-spec** (RN `runtimePerformanceProfile.ts:19-50`): most of the budgets it tunes (Hypa batch, script caches, prompt history limit) live on MT's server, and MT's client already has chat paging settings. Low value.

**Tied to Tauri or native, with no sensible web or server analogue:**
- Tauri shell, Android and iOS projects, and the patched crates: wry, tauri-plugin-http, updater, window-state, single-instance, ios-native.
- Native download compatibility and webview link routing (`webviewDownload.ts`, `9a7aa531a`, `021069a3e`).
- Barcode scanner plugin. QR pairing is re-expressed as a camera-app URL in item 18.
- Desktop launch profiles (`--profile=<name>`). On MT this means running another server instance with another `RISU_SAVE_DIR`.
- Endpoint registry and rediscovery (`server/endpoint-registry/`, a Cloudflare Worker with D1). A PWA is bound to its origin, so it cannot follow a moved server.
- Cloudflared quick tunnel management, Windows NSIS installers, the macOS app and the AltStore source (`alt-source.json`).
- Signed release catalog and updater (`crates/release-update`, `scripts/release/sign.mjs`, `publication.mjs`). MT ships as git or Docker. Only the release-notes check (item 19) carries over.
- `small-object-store` (SQLite small blobs per owner) and the `external-storage-format` crate: no use unless off-site encrypted backup is built (item 19).
- Android SAF and iOS file-picker routes, native file jobs, native CAS byte transport, and the AppImage, Android and iOS platform pages.
- Benchmarks for Android, iOS, macOS, Linux and native storage. The *practice* of keeping harnesses outside `pnpm test` (`benchmarks/harnessConfig.ts`, `vitest.benchmark.config.ts`) is already roughly matched by MT's `util/playwright/measure*.mjs`, which only lacks type checking (item 17).

---

## 3. Open questions

1. **Upstream `.bin` import (item 10):** is the "no migration owed" stance still wanted now that metatron has users, or is a one-way converter acceptable? Encrypted Risu Account backups would need the account key and are probably out of scope either way.
2. **Reroll candidate shape (item 9):** I did not check whether PocketRisu's `responseVariants` matches RN's exactly, which matters if the field should be interchangeable. Does upstream RisuAI ignore or strip it on import (not verified)?
3. **Stale tab after a server upgrade (not verified):** the event-feed `hello` carries only `epoch` (`shared/events.ts:25`, verified), `appVer` is not compared, and the service worker uses `skipWaiting`. An old tab may keep running old client code against a new server until reload. RN's update UI suggests a "new version available, reload" notice keyed on a build id in `hello`. Is that a real problem in practice?
4. **Where CI would run:** the remote is a self-hosted forge. Is it Forgejo or Gitea with Actions runners available? This decides whether item 5 is a workflow file or a server-side hook.
5. **Asset garbage collection reach (item 7):** asset keys can appear in free text (CBS, Lua `getCharacterImageMain`, regex outputs, module assets, background HTML). A conservative mark phase must scan text fields, not only typed asset fields, and how many such places exist is not enumerated here. The grace period and "pinned snapshot" semantics need a decision.
6. **Plugin storage isolation (item 11):** do any plugins the user relies on read another plugin's keys on purpose? RN documents that isolation breaks them.
7. **Size of `server/src/tests` in the image** (item 5, about 3.8 MB according to the research pass) and whether any fixture holds real user data: not measured.
8. **Auto-suggestion staleness guard** (RN `src/ts/autoSuggestionMetadata.ts:9-48` drops a suggestion when the character, chat or navigation changed): I did not check whether MT's `src/lib/ChatScreens/Suggestion.svelte` has an equivalent after the mid-send switch changes.
9. **Data health scan (item 12):** which orphan or dangling cases can actually occur on the server after the data-loss audit fixes, versus only in theory? Running a read-only scan on the user's real `save/` would answer this.
10. **Native-only claims in RN:** several RN pointers above sit in `src-tauri/` Rust that I did not build or run: the snapshot archive page dedup, `migration_gc`, the data health repair journal. The descriptions come from reading source and docs only.
