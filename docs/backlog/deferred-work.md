# Deferred Work

Work that finished plans named and left: features put off, a plan's Later list, defects and gaps a slice saw and did not fix, code paths without a test, and stale wording. Each entry came from a plan's close-out notes in the [plan archive](../archived-plan/README.md), which held them until 2026-11-11. Device and browser checks are in [manual checks](manual-checks.md); what the slices decided or accepted is in [decisions to verify](decisions-to-verify.md).

- A heading is the plan; its text is `git show <commit>:<path>` from the archive's table. Plans are in the order they were archived.
- Nothing here was re-read against the current code when it moved, and later plans fixed some of it. Confirm an entry in the code before acting on it.
- Several entries say their details went to found issues. That inbox was emptied on 2026-11-09 and 2026-11-10 (each entry fixed, recorded in its guide, or closed), so such an entry may be done.
- Delete an entry when it is done or the owner drops it. A confirmed defect moves to [known issues](known-issues.md).

## Model Profiles

- Named keys for the remaining `/proxy2` auxiliary operations and `getFreeOpenRouterModels`.
- A distinct `submodel` slot (O3).
- Global provider toggles moving to profiles (O7: `openrouterMiddleOut`, `openrouterFallback`, caching, `autofillRequestUrl`, `reverseProxyOobaMode`, `vertexRegion`).

## Translation

- The optional phase 4: greeting translation and bilingual partial edit.

## Per-Chat Toggles and Toggle Presets

- Drop the read-only legacy `globalChatVariables` collection with a one-time seed of each chat's map after a release has passed.
- Decide an explicit default in the toggle grammar (a cross-user `.risup` format change).
- Similarity sorting and partial apply; `.risutoggle` export and import; plugin, MCP, and chat-command exposure of presets; writing toggle values from CBS, Lua, or triggers.
- `togglePresets` saves as a whole record, so two tabs saving at once can drop one tab's new preset while its chat link lands as "deleted". Static Audit Fixes SA1 has since merged preset additions across tabs.
- Every collection, including `togglePresets`, enters the job scope and render-cache key, so saving a preset invalidates cached renders. An exclusion list in `server/src/jobs/jobScope.ts` would avoid that.

## Large Asset Import and Export

- Untested paths: zip64 and offsets past 4 GiB on real CharX files (the client zip reader in `src/ts/process/zipFile.ts` refuses wrapped offsets without zip64), the `App.svelte` drop handler, and the `charxJpeg` export.
- Eager icon lists left: the `selectChar` alert in `AlertComp.svelte` and `CharConfig.svelte`'s group member list.
- Deferred out of the plan: the Safari/WebKit streamSaver fallback that keeps whole exports, "Export All Chats" building a whole history, the one-time legacy browser-local inlay migration, and unbounded persona and preset decoders.

## Sidebar Chat Status

- `SideChatList.svelte` rows have no badge; the home cards got theirs in slice 3.

## Settings UI Reorganization

- The fetched WaveSpeed model list resets when Image Generation is left.
- The subtitle tool's Whisper mode uses the OpenAI key with no status or link there.

## Open Bug Fixes

- C5: a `#share_module` whose save a conflict discarded still has its pending share cleared (a retry would add the module twice).
- C1: the fixed `exportLoreBook("sglobal")` has no caller in the current UI (`LoreBookSetting` is never mounted with `globalMode`).
- C8: `SettingSelect.svelte` still writes its fallback when its context is rebuilt (a Known Hazard in `settings-i18n.md`); the de/es/vi streaming help text still claims the 0.125 s throttle.
- C2, P1, and I1 added strings to `en.ts` (and `ko.ts` where translated); the other locales show them in English.
- Owner decision left open: lore regex keys containing a comma are split on every comma (`shared/lore/activation.ts`); tests pin it.

## Boot Resource Cache

- A browser's first boot still downloads the whole compressed read (6 s at 10 Mbps on the measured data); the client's work after the read is unchanged. Chat summaries and orders are cached per character since the Boot Bytes plan; whole chats still load on demand.
- No sign-out calls `clearBootCache` yet.

## Heap Memory Reduction

- Found by M0, not sliced: opening a character's settings loads a tokenizer BPE model (~49 MB) on the main thread and keeps it; the settings tokenize the description and first message on the main thread (17–22 s for a 1.7 MB description); `loadTokenize` passes an undefined note on a closed-chat character switch (an error alert).
- D3 candidate: a Svelte `Batch` kept alive by an `{#await}` block holds the previous `parserAssetInputs`, so a server-deleted module's assets stay reachable (+17.2 MB in the driver's `boot-module-delete` step, measured but unchecked).
- B1/B2: a same-record unproxied list or tuple assigned to a module's `assets` is frozen in place (later edits through its source wrapper throw; no production writer does this); a same-id `replaceCharacterRecordAt` with the character's own frozen list re-stamps that field; in DEV `module.assets = module.assets` nests Svelte's inspectable proxies.
- C2: rows `Chats` trims keep their sheets for a few frames; a CSS-only change does not re-observe a `.far` row; a sheet is made again after a real gap; plugins that serialize a row get the inert placeholders; layers declared inside an imported file are not detected.
- D1: a throwing mutator's shrink, a local field replacement's cached node, other by-id lists, nested containers' Svelte targets, `defineProperty` length sets and deleted ids' per-character metas are not pruned (all bounded by installed data or small).
- Drivers: the loader/dominator unit test is not written; readiness and cleanup in `measureHeap.mjs` and `measureFileSources.mjs` check `exitCode` only (a signal-killed server child is missed); no server-side egress accounting.

## Search

- 2a: the matcher's case fold is `toLowerCase` plus a final-sigma fold, not full Unicode case folding (ſ/S, ϐ/Β).
- 2b: a row renamed under the filter hides once its name no longer matches.
- 2c: an entry added while filtering is hidden at once (its fields are empty); no "no results" line (needs an `en.ts` key); a detail open inside a folder closes when the next query drops that folder; `onEnd` of a drag that started before the filter is untested.
- 3a: the navigation page and Model tab labels are repeated in `searchIndex.ts` (`PAGES`, `MODEL_TABS`) because `Settings.svelte`'s `navGroups` cannot be imported.
- 4b: `Chats.svelte`'s 700 ms latest-message auto-scroll ignores `suspendTrim` and can undo a finished jump (the bookmark jump too); Escape with Settings open above the panel closes the panel; the previous error line stays visible during the next debounce.
- Not in the plan: `prose-invert={$ColorSchemeTypeStore}` in `AlertComp.svelte` and `MultiLangDisplay.svelte` is always truthy; the persona list itself has no name filter.

## RisuNest Small Wins

- T1: an iframe's `contentWindow.parent.WebSocket` (the backing window) stays unguarded; `build-test-platforms.md` `Files` does not list the three root `vitest.testNetwork*` files; raw `node:http`/`net`/`tls` sockets, worker threads and child processes are not guarded.
- P1: a `nativeFetch` without a `signal` is not aborted by `terminate` (its late body is cancelled); a hash failure that recovers reports the plugin once more.
- E1: `util/` stays outside `pnpm check`, so `testInventory.mjs` and its test are not type-checked.
- P2: the `onStart`-throw follow in `serverCommands.ts` is untested; with D4, plugin work that never ends defers the reload until a local reload (`plugin-sandbox.md` Known Hazard).
- A1, found outside the slice: a job's status alert left after the job ends, alert keys ignored while a text input has focus, `alertClear` clearing another job's status, the branches/HypaV2 dialogs reading the selection late, a gated Escape still closing the settings, `makeGroupImage` leaving its wait.
- S1: `STRUCTURE.md` S1 and `ui-theming.md` still describe safe mode as custom CSS only; `bootstrap.safeBoot.test.ts` duplicates the service-worker test's mock preamble; a plugin whose script throws at start fails every boot it runs in (`app-shell.md` Known Hazard); modules, global regex and Lua (server-side per job) cannot be turned off.
- Known stale test untouched by the plan: `server/src/tests/importPngCaps.test.ts` fails on a clean tree (`{ total }` expected, `card` also returned). Small Fixes SF12 is titled "Stale slow test and test platform notes".

## Upstream `.bin` Compatibility

- S7: the client sending `selectedChat` has no test (checked by hand in S8); a shutdown during a prepare has no test.
- S5: a worker that exits cleanly without a result and a generation job ended by the commit's maintenance have no test.
- S3: rethrowing unexpected errors has no test.
- S2's 11 tests were written after Sol's review and not reviewed by Sol.

## Audit Findings and Performance Leftovers

- 3a: jobs still parse the whole `modules` records and every preset and section (reading only what the job resolves needs a process-wide parsed cache keyed by revision); `loadRequestDb` re-reads every settings record per job and per `presetChain` pick; the Lua character setters (`patchCharacter`) parse the record about five times per call.
- 3c: no HTTP compression (a `compress` scoped to `/api/resources/read` is the candidate for a remote deployment); `hydrateAll` still ships the whole chat per callback barrier, and `resync` reads whole.
- 3e: the temporary 100k-asset probe was removed; permanent scale tests were left for later.
- 3g: still whole: creates, patches no smaller than the record, server `enabledModules`/`authRefreshes` writes and job owners' `resource` events; imports and other whole-write callers publish plain refs.
- 3h: the first filter query after an edit copies the field once.
- 4c: the global NanoGPT subscription state across profiles; flat keys for the media, memory and count rows and the Google/Anthropic/OpenAI discovery lists; `getFreeOpenRouterModels`.
- 4d: the sandbox RPC still logs request bodies and headers (`factory.ts` `Original request:`); an abort after the response headers does not reach the host; `internal:graphmem`/`internal:risuai` act on the selected chat on the browser path; `providerOptions`/`customProviderStore` are not reset on reload.
- 4e: VOICEVOX stays on raw `fetch`; `runVITS` playback cannot be stopped; the Stop entry's visibility is untested.
- 4f: no server fallback for a share POST without a worker; shares and other deep links before first setup; an installed app keeps `/receive-files/` until its manifest refreshes; `window.innerWidth` read at mount only.

## Timing-Dependent Tests

- `resourceSyncChats` still has `vi.waitFor(..., { timeout: 5000 })` polls on real time.
- The slowest gated test, `importRealm` "refuses a card or asset chunk over MAX_PNG_TEXT_CHUNK_BYTES...", takes 2-4 s alone and about 27 s under the overload.
- Gated explicit 60 s timeouts now repeat the default and could go.
- A test body that outlives its timeout can still reach the next case's fake (seen in `exportBatches`).
- Test copies of production constants: `SAVE_DEBOUNCE_MS` in `mutationStoresHarness.ts` copies the unexported production `DEBOUNCE_MS`.
- Coverage gaps: a CharX entry exactly at the cap is untested; `mcpSse`'s scan bound has no slack; other partial `vi.mock(importOriginal)` mocks were not audited for Vitest 4 keeping the first registry across `resetModules`.
- Production: `chatStore.svelte.ts` `isMember` scans a character's chat list through a proxy, so per-character work grows quadratically with the chat count.

## HypaV3 Background Memory

- `server/src/prompt/tokens.ts` `countWithGoogle` has no signal or timeout: a stalled count holds a job or a memory task until the deadline. Small Fixes SF3 is titled "Google token counts have a timeout".
- Stale wording since activation: the `MEMORY_TASKS_PATH` comment in `shared/events.ts`, the `memoryTasks.notEnabled` locale text ("yet"), and a `chat-pipeline.md` Known Hazard that says production passes no service.
- An abort during the rate limiter's wait is untested (1b).

## Per-Chat Send

- The shared composer (text, attachments, input translation) was left out of scope.

## Chat Checkpoints

- The restore floor's `fmIndex` edge and the unreported order-conflict discard were left as project memories.

## Generation Stage Spinner

- An attach replays only the current stage, so a quick memory step can hide the first `preparing`.

## Upstream Integration

- UP3: the `current` harness target's migration step fails on a backup with a `_coldpluginIndex` pointer, because memory cold storage starts empty (documented).
- UP22: the upstream help text for the keep-alive audio was not ported.
- The five deferred upstream commits keep their revisit triggers in [the ledger](upstream-ledger.md); so do the deferred rows of Upstream Intake 2.

## Combine Audit Fixes

- Left for their own plans (the plan's Not In This Plan): lost-create recovery past a checkpoint restore (audit F01, with the checkpoint policy test harness and a summary-boot mode for `chatCheckpoints.test.ts`); a refused deletion becoming a whole-chat replace after Retry (F02); completed `once` plugin listeners retaining detached DOM (F09). The audit's evidence stays outside the repository in `/home/codex/metatron-stage/combine-audit/evidence/`.

## Context Usage Meter

- The deferred Recalculate: it needs a preview job that writes nothing, keeping `previewChat("preview")`'s array contract.
- The memory-mode "may run memory" hint was not built.

## Deep Audit Fixes

- The mounted `DefaultChatScreen` tests for the bookmark jump and translation invalidation.
- The plan's **Deferred** table groups the remaining audit findings into the follow-up plans it names: durable drafts, job protocol, display evaluation, per-event server work, dictionary ids, boot bytes, server byte budgets, retention, token counting, rendering. Most of those plans have run since.

## Chat Lore Override States

- Out of scope by the plan: module lore; a marker in the character tab for overridden entries; an off control for chat-local lore; refreshing an off copy from its original when it is turned back on; duplicate owner ids.

## Mobile Resume Reliability

- Set aside by the plan, each needing its own design if the diagnostics ever show it: browser-dependent callbacks (Lua questions, plugin, provider, and tab MCP callbacks) expiring while the page is away; keeping the browser's diagnostics across an Android process kill; a feed whose `listRevisions` hangs while pings keep arriving, and settling a job follow's terminal before its `close`; the completion push sent before the post-reply emotion/image work and final write; push on job errors (a product decision); the earlier Web Push leftovers.

## HypaV3 Token Budget

- Out of scope by the plan: a trigger independent of `C`; token mode for HypaV2 or SupaMemory; token mode in the tab's oracle copy; mixing modes per field.

## Durable Drafts

- Pending writes across a back/forward-cache return were not driven: headless Chrome 156 restored the page from the cache while it held its journal owner lock (`pageshow.persisted`, `notRestoredReasons: null`; a draft recovery Gotcha).

## Job Protocol

- D6's "chat free within 45 + 120 + 5 s" bound does not hold for every path (it went to found issues, Server jobs).
- The window where a page killed between the create and its journal write recovers the text without the request id is documented, not driven.

## Boot Bytes

- Not planned: characters as a sidebar projection (Q3); a summary projection that does not parse whole chat `meta`; a boot cache that follows the tab's acknowledged state.

## Per-Event Server Work

- Not planned: retiring `patch` for `delta` and dropping whole barriers for sockets without `hydration=patch` once an older client can be refused (both sockets now send `proto=1` as that boundary, with no floor: Incremental Chat Transport D4); the chat's summary on the job socket for the owner's own list.

## Server Byte Budgets

- Not planned (the plan's Later list): a bytes-in-flight gate for reads; page-hash reuse across checkpoint saves; per-round deadlines for continued reads; a paged `GET /api/resources` for the boot-cache miss; restore and import progress as NDJSON with a prepare/commit split for the version-2 import; a streaming validator that keeps no id sets.

## Guide Budgets

- The slices ran no test suite and no `pnpm check`, at the owner's request; only `util/docsBudget.test.ts` ran. `util/testInventory.test.ts` had its fixture keys changed and was not run.
- Not planned (the plan's Later list): a per-plan docs budget compared through `--report`; a second reader pass over the smallest guides for the prose rules.

## Guides To Source

- Not planned (the plan's Later list): a check that a `Files` entry's backticked identifiers exist in its path; a `Files` generator from the owned modules' exports.

## Render Work Budget

- Not planned (the plan's Later list): F3 and F6 (the mount profile did not settle between single runs); an early release of a cancelled chunk's server snapshot; reversing Q4 (let dispatched transform requests finish) or Q2 (selected-range export); the `measureChats.mjs` settling delay. F1 and the per-chat message index went to the Incremental Chat Transport plan.

## Plugin Storage and Data API

- Not planned (the plan's Later list): a streamed `getDatabase` transfer into the iframe; device-local large storage spaces; owners for `getLocalPluginStorage()` and the top-level custom keys; changing `getDatabase()`'s default once the developer access recorder has run on the owner's plugins (Q5).

## Reroll Candidates

- Not planned (the plan's Later list): a single-candidate delete control; a boot sweep writing back the previous candidate after a process death; bundle candidates for multi-reply tails; PocketRisu `swipes` in the `.bin` export; pruning older messages' candidates at the commit boundary.

## Found Issues Sweep

- Not planned, the plan's Deferred groups: feed patch forms, editor drafts as refresh holds, the handoff detach, plugin lifecycle, the render failure channel, screenshot memory, token counting, the trim question design, transform key and measurements, snapshot storage sizing, named-page matching (I1's `castSlice` item moved here), `proto` diagnostics, a mounted DefaultChatScreen harness, the `/sw/img` reproduction, the Structured Memory follow-up. Their entries were in found issues.

## Implementation Audit Fixes

- Not planned: the 12 findings excluded as edge cases and the deferred media URL lifetimes (AL U1) moved to found issues at retirement; the seven audit reports are in [reports/audits](../reports/audits/).

## Chat Store and Structured Memory Sweep

- Deferred groups, in the archived plan's Deferred section: read path budget, named-page matching, checkpoint save hold, plugin index reads, create-state proof, Svelte's subscriber queue, refresh and trim costs. Their entries were in found issues.

## Multi-Client Data Safety Checks

- Deferred (the archived plan's Deferred section): S8 restore and import with two tabs; two server processes on one data directory; the open inline-editor draft loss case; a notice for a replaced same-message edit; other browsers; the `pnpm test:e2e` runtime budget.

## Module Headers

- Slice 6 (server-generation) did not run (Q1); its path list is in the archived file.
- The plan's D7 sweep session is for the owner to start; it was not run.
- Not planned (the plan's Later list): a `missing-header` rule in `pnpm check:docs`; the identifier check and `Files` generator Guides To Source left; the same measure over the remaining guides.

## Found Issues Decisions

- A crafted restore whose keys are unicode-escaped can slip past D2's SQL prefilter and keep its bytes; retries are unaffected.
