# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run) and the eleventh (the Reroll Candidates run) on 2026-11-05; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's Known Hazards `Issues` (or `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (7)
- [Server jobs and prompt assembly](#server-jobs-and-prompt-assembly) (5)
- [Server routes and resource store](#server-routes-and-resource-store) (1)
- [Request history and diagnostics](#request-history-and-diagnostics) (2)
- [Display transform](#display-transform) (2)
- [Chat screen and input](#chat-screen-and-input) (3)
- [Client and plugins](#client-and-plugins) (8)
- [Build, drivers, and e2e](#build-drivers-and-e2e) (12)
- [Guides](#guides) (7)
- [Test timing](#test-timing) (1)
- [Structured Memory](#structured-memory) (18)

## Chat store, sync, and change feeds

### Parked resends leak

`src/ts/storage/chatStore.svelte.ts` `dropCharacterWork(id, false)` from `takeChatWork`'s absent-character sweep (~3505, the quarantined-create path) parks in-doubt resends (`parkResends`); no deletion acknowledgement or `forgetCharacter` ever comes for a character the server never had, so the entry stays until `seedChats` (boot) or a re-add of the same id, which would replay a harmless resend first. Accepted trade-off of open-bug-fixes slice A3 (landed on metatron 2026-10-19 via plan-runner), noted by its Fable reviewer. Still present 2026-10-21 (`parkedResends`, chatStore.svelte.ts ~180).

**Why it matters:** tiny memory leak per session; a far-later same-id re-add sends one extra replay.

**Suggested handling:** if it matters, drop parked resends once the adapter knows the abandoned character has no server incarnation and no unresolved create can still establish one, and also clean entries parked in an earlier cycle. `persisted` alone is not that proof: a removed character whose create answer was lost is resent while `persisted` lacks it (resourceSync.svelte.ts ~1387), and a same-id re-add still needs the preserved group ids (checked 2026-10-24). Parked payloads can hold whole chat snapshots, so the leak is not always tiny.

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

### No guide states the restore floor's check order

`docs/structure/chat-store.md` `### Restore floor` links to `server-resources.md#chat-writes-and-checkpoints` for the check, and `server-resources.md:424` sends floor details back to `chat-store.md#restore-floor`. Neither states the order of the checks, and `reason: "generating"` handling has no rule in any guide. Found by Guide Budgets slice 2.

**Why it matters:** a reader changing the floor finds a circular pointer instead of the rule.
**Suggested handling:** read the checks in `server/src/data/chatStore.ts`, state the order once in `chat-store.md` `### Restore floor`, paying for the bytes in the same edit, and keep the link one way.

### Phase 6 review leftovers

Raised in the Phase 6 slice 6–11 reviews (2026-10-05..07) and judged out of scope or pre-existing; kept in memory until 2026-11-03. The `stores.svelte.ts` ↔ `parser/transformClient.ts` import cycle is in `app-shell.md` Known Hazards and is not repeated here.

- Vitest-only module-effect race: when `database.svelte` or `stores.svelte` loads first in a test, their module-level effects read state that is not initialized yet; native ESM in the app is not affected. A test that reaches the settings views cannot use `@vitest-environment node` (the records need Svelte's client `$state`); flat fixtures use `src/ts/storage/tests/installFlatDatabase.ts`.
- Preset reorder criterion missed: reordering 50 presets took 17.9 ms against a 16.0 ms baseline (+12 %, target within 10 %); a plain-row projection was not tried (`docs/audit/preset-reorder-2026-10-05.md`).
- Slice 9a: the facade's `chats` view (`setCharacterChatView`, `records.svelte.ts`) builds a fresh array per read, so loops go through `findChat`; the resources route's non-array body message does not name `chatSummaryCollections` (tests pin it); async plugin setters can see a gone preset selection repaired to the first preset between call and apply.
- Slice 9b: the own-save echo of an unloaded chat's list field costs one summary-list read; a noticed loaded idle chat is read whole before the trim may evict it; `installRead` and `adoptChatRead` (`chatStore.svelte.ts`) disagree on incomparable revisions (only test tokens like `"r1"`); store-backed test harness boots still read `{ chats: true }`.
- Hazard-entry notes: `llm-requests.md` leaves three OpenAI-format credential sends untested (key map, preset proxy key, custom model key); for a V3 provider model `Plugin Error from <provider>` names `currentPluginProvider` (`src/ts/process/request/request.ts` ~771), which can differ from the failing provider; the M16 "stale module" can be a different module when a replacement reorders the list.

Identifiers re-checked 2026-11-03 (`setCharacterChatView`, `installRead`, `adoptChatRead`, `Plugin Error from`); the timings were not re-measured.

**Why it matters:** each is small; together they are the known soft spots of the store facade and its tests.
**Suggested handling:** check the code when working nearby; an item confirmed with an owning guide moves to that guide's Known Hazards.

### A retaken handoff job drops its live stream

Found 2026-11-05 in Job Handoff Slice 2. A tab whose takeover was lost (its ticket attach never reached `owner: "self"`) ends that follow through `releaseGenerationJob` (`src/ts/network/generationJobs.ts`), which calls `endServerJob` (`src/ts/storage/chatStore.svelte.ts`). `endServerJob` adds the job's generation ids to `retiredGenerations`, and `applyServerGeneration` / `applyServerGenerationChunk` then drop every later `accepted`/`chunk` for those ids for the rest of the page's life. If that tab later takes the reopened offer for the same job, it shows no live stream for the reply in progress. Chat patches, the final copy, and callbacks still arrive. Slice 2 accepted this as a limitation.

**Why it matters:** today it only affects what the worker displays. It becomes a real problem once anything relies on the worker's stream view.
**Suggested handling:** add a chat-store "detach without retiring" release that drops the job's entries but leaves its generation ids unretired, and use it for a lost takeover.

### pluginStorage writes still reach other tabs whole

The Plugin Storage and Data API run (2026-11-05, slice 2) made the upload of a `pluginStorage` write a nested entry patch and a plugin toggle a name-keyed `plugins` patch, but the server's change feed is still top-level and id-keyed. `feedPatch` in `server/src/data/resourceStore.ts` and `diffRecordText` in `server/src/data/recordPatchText.ts` (`diffItems` keys by `id`) publish a one-key `_pluginStorage` or `_ownedPluginStorage` write as `set` of the whole dictionary (a ref once over the feed cap, so every other tab reads the whole record), and a toggle on id-less plugins as a bare ref. The client feed applier `patchedRecord` in `src/ts/storage/resourceSync.svelte.ts` knows neither `nested` nor `itemKey`.

**Why it matters:** the 1–2 MB per write the run removed from the upload is still paid once per other open tab on download.
**Suggested handling:** extend the feed `RecordPatch` with the same nested and item-key forms the write patch has (`checkRecordWritePatch` in `shared/recordPatch.ts`) and teach `patchedRecord`; both sides must change together.

### flushResources resolves after a restore halt

`flushResources` in `src/ts/storage/resourceSync.svelte.ts` checks `halted` only inside its `while (pending() ...)` loop, so with nothing pending it resolves normally after `haltForRestore`. `readRefs` (`src/ts/storage/resourceClient.ts`) is not gated by mutation admission, and the detached reads (`readChatRefsDetached` in `src/ts/storage/chatEdits.ts`) use their own deadline controller outside the save adapter's halt-aborted `readControllers`, so a late answer from the old epoch can still land. Found in the Plugin Storage and Data API run (2026-11-05, slice 5); the detached chat cache guards itself with `assertSaveAdmission` and the terminal notice.

**Why it matters:** a caller that treats a resolved flush as "the server copy matches this tab" (plugin `getDatabase`, exports through `readChatsDetached`) keeps going while the restore notice is open; small today, since the page reloads after the notice.
**Suggested handling:** if a later change relies on `flushResources` refusing after a halt, add `assertSaveAdmission()` before its first return.

## Server jobs and prompt assembly

### Tool schemas are outside the assembly token budget

`server/src/prompt/assemble.ts`'s final recheck counts messages; `AssemblyHost` has no tool-schema input, and the OpenAI adapter (`server/src/llm/openAI/requests.ts`) adds `body.tools` from descriptors supplied later in `server/src/llm/requests.ts`. A prompt assembled to the budget can therefore exceed the provider's context by the schemas' tokens. Traced by the [cross-plan review](../manual-audit/cross-plan-2026-10-29.md#hypotheses-not-reproduced) (memory seam) and not reproduced with a real tokenizer; unverified.

**Why it matters:** with many or large tool definitions a send near the budget could be refused by the provider although the meter shows room.
**Suggested handling:** measure with a real tool set and tokenizer; if the gap is real, charge an estimate of the schemas in the recheck (the token-counting follow-up group of the Deep Audit Fixes plan).

### No-memory trim question gaps

The no-memory trim question (aad461e63, 2026-10-11; `server/src/prompt/runner.ts` ~1086 compares `memoryTrimAck` with `supaMemoryOnCount`) shipped with gaps accepted at its review: the late removable-message cleanup in `assemblePrompt` (`v.removable`, `server/src/prompt/assemble.ts` ~2131), which runs after formatting, can still drop history without asking (offering "turn memory on" there would re-run memory and formatting mid-assembly); when the question goes unanswered (timeout or a lost owner) the job error the user sees is English, since the server has no localized channel for terminal errors; `supaMemory` turned on by a plugin (`setCharacter`) or a raw record write does not bump `supaMemoryOnCount`, so a chat's "don't ask again" survives it (Lua has no `supaMemory` setter); the dialog was never checked by hand. Identifiers re-checked 2026-11-03; kept in memory until then.

**Why it matters:** a user can still see a silent trim or an English error from a feature meant to ask first.
**Suggested handling:** raise when a silent trim or an English job error is reported; the cleanup gap needs a design, the other two are small.

### `{{// ...}}` stays literal in rendered and prompt text

`shared/cbs/registry.ts` registers `//` (~2483) as `doc_only`, so `shared/cbs/evaluator.ts`'s matcher finds no callback and `{{// note}}` is left in the text of any parse; the evaluator's `commentMode` (~793) is never set true. Only `shared/lore/activation.ts` strips `{{//...}}`, from lore key matching. Upstream behaves the same. Found in the Guides To Source run (2026-11-05), whose old guide claimed the scanner handles comments; intent unrecorded. Owner: cbs-rendering.

**Why it matters:** card authors may expect a comment to vanish from what the model or the reader sees.

**Suggested handling:** ask the owner whether comments should be stripped; a change keeps client/server parity (`server/src/tests/fixtures/cbs-parity.json`).

### The regex cache key runs CBS for a disabled flag

`shared/scripts/regex.ts` `regexScriptCacheKey` (~285) expands `script.in` through `parse` whenever `script.flag` contains `<cbs>`, without checking `ableFlag`, while `parseScripts` reads `<...>` actions only with `ableFlag`. A probe in the Guides To Source run (2026-11-05) with `ableFlag: false` saw `{{setvar::x::1}}` evaluated during key building. The key is built on the server (`server/src/prompt/scripts.ts`). Owner: scripts-triggers.

**Why it matters:** a disabled custom flag still evaluates CBS (side effects and budget) on every cache lookup, and the key differs from what runs.

**Suggested handling:** test `ableFlag` before parsing in the key, with a test of the side effect.

### v2BreakLoop may stop at an inner loop's end

`server/src/prompt/triggers.ts` `case "v2BreakLoop"` (~854) scans forward to the first `v2EndIndent` with `endOfLoop`, at any indent, while the backward loop jump matches `indent - 1`. A break in an outer loop placed before a nested loop would then stop at the inner loop's closing entry and jump back into the inner loop instead of leaving the outer one. Read in code by a lookup trial of the Guides To Source run (2026-11-05); unconfirmed, no test reproduces it. Owner: scripts-triggers (the runtime file is server-generation's).

**Why it matters:** a trigger author's `break` could loop or skip effects in nested loops.

**Suggested handling:** write a nested-loop trigger test first; if it fails, match the break's indent the way the loop jump does.

## Server routes and resource store

### The change log's bound is a row count, not 4 MB

The `changes` table in `resources.sqlite` (Incremental Chat Transport D5, `server/src/data/resourceStore.ts`, pruned by `pruneChanges` ~1020) keeps the newest 20,000 rows. The plan's Q1 and D5 text ("a row is under 200 bytes: 4 MB at most", "40 snapshots hold up to about 160 MB of logs", cross-plan X8) understates the worst case: ids may be 512 UTF-16 units (the id validator in `resourceStore.ts`, chat ids in `server/src/data/chatStore.ts`), a 20,000-row probe with such ids made an 82 MB database (2026-11-05, Slice 3), and DELETE-based pruning never shrinks the file. Whole-file snapshots (`backupTo`) and version-2 downloadable backups (`server/src/routes/backups.ts`, which strips `llmSecrets` and vacuums) carry it. Found by Slice 3's challenge.

**Why it matters:** with typical UUID ids the log is a few MB, but the Asset Lifecycle snapshot budget counts 40 copies of it at a byte size the code does not bound.

**Suggested handling:** size snapshot storage as rows × id length; add a VACUUM or a byte bound if a real store comes near it.

## Request history and diagnostics

### Request history accepted trade-offs

From slices 2–10 of the Request History and Diagnostics plan (2026-10-13..15, archived); all accepted trade-offs or minors, not defects. Kept in memory until 2026-11-03. The decided Limitations (unsynced appends, synchronous shares, redaction reach) are in `diagnostics.md` Known Hazards and are not repeated.

- Capture: a stream capture flushed by an abort, a cancel or a read error is not trimmed for a trailing credential prefix (`Redactor.trimPartial` runs only when the 4 MiB bound cut it, `server/src/llm/requests.ts` ~627) and can end in U+FFFD; an adapter's `addLog` (the Anthropic batch) counts logged text, not wire bytes; exchanges are stored in completion order, not start order.
- Store: an invalid `firstByte`/`completedAt` falls back to `now()`; `setShared` returns the matched count, not the changed count; a failed ROLLBACK closing the store is untested; a missing JWT is a 400, not a 401 (server-wide).
- Viewer (`src/lib/Others/RequestLogs/`): re-expanding a row loads a fresh detail while the list row keeps its old summary until the list reloads; `LogField`'s copy feedback depends on `copyText`'s boolean and its fallback failure was not browser-checked. The viewer, the failure alert's two buttons, the popup's job filter and the Diagnostics panel were never opened in a browser, and no report was pulled over sftp.
- Structured failures: a memory request's failure is `assembly` with no `requestId`; OpenAI Responses turns a streamed error event into answer text, so it gets no code; `APP_PATH` in `server/src/diagnostics/log.ts` (:59) would accept a `node_modules/*/shared/*.ts` frame.
- Journal: `script` events are deferred (swallowed Lua/trigger failures produce no event); symlink checks guard stray entries, not a writer racing in the folder; a failure that `startServer`'s own catch takes is not recorded; there is no global-middleware early-return or >5 s slow-answer `http` test; one failed state write can count two failures.
- Browser collector: no build-membership check on browser frames (an app script rewriting `error.stack` could name an app-shaped file); V8 `at async <url>` frames are dropped (`FRAME` in `shared/diagnostics.ts` ~300); WebKit `[native code]` lines give no frames; folding collapses alternating `hidden`/`visible` within 16 events / 10 min and keeps the first `at`; the SW hooks in `bootstrap.ts` `registerSw` are untested.
- Report and sharing: the server's report check is of shape, not provenance; a report naming a model that later left `BASE_LLM_MODELS` is refused (documented v1 exception); a prune failure after a save is counted but not shown; no boot-time reconciliation of `sharedAt` marks against `shared/` files (files are authoritative, withdrawal idempotent); if `deleteAll` fails after the copies were removed, the marks stay; the older-copy 500 is mapped in the viewer by comparing the server's English message (`requestHistoryShareOlderCopiesRemain`), not a status field; `eventsFor` does not detect pruned day files; the second redaction cannot catch a retired key or an expired Vertex token and leaves out the auxiliary `secrets` section. Never run: the Docker plus chrooted-sftp permission check (only `shared/` readable, not `save/data/`).

Identifiers re-checked 2026-11-03 (`trimPartial`, `APP_PATH`, `FRAME`, `copyText`, `sharedAt`, the English-message mapping); the behaviors were not re-run.

**Why it matters:** a security review of the history folder or the diagnostics report should know which gaps were chosen.
**Suggested handling:** read before such a review; delete items as they settle, and move confirmed ones to `diagnostics.md` or `llm-requests.md` Known Hazards.

### Socket protocol numbers are not in Diagnostics

Both sockets send `proto=1` (Incremental Chat Transport D4, Slice 2). The server records it per socket (`protocols` in `server/src/routes/events.ts` ~72, `socketFlags` in `server/src/jobs/generationJobs.ts` ~811) and logs one `console.info` line per socket (`[Live-update socket] proto=…`, `[Generation socket] proto=…`). D4 says a later plan sets a floor and measures "which clients are below it from the diagnostics", but the Diagnostics schema (`shared/diagnostics.ts`) and `logEvent`'s fields (`server/src/diagnostics/log.ts`) carry no protocol number and neither socket has a recorder. Found by Slice 2 (2026-11-05).

**Why it matters:** a floor decision would have to scrape server console logs; an exported diagnostics report shows nothing.

**Suggested handling:** before any `proto` floor work, add a diagnostics event field and a recorder on both sockets.

## Display transform

### Budget-refused handler rows not re-measured

`server/src/prompt/transform.ts` refuses a two-call (tab plugin handler) target whose snapshot charge passes `MAX_SNAPSHOT_BYTES` (8 MiB, :54). Since the [cross-plan review's DT1 fix](../manual-audit/cross-plan-2026-10-29.md#dt1--a-permanent-display-failure-retries-and-toasts-every-round) (94856bdc2) a scope over the limit alone fails `permanent` (shown raw until its source or context changes), while a refusal the request's other targets caused is a plain failure that `src/ts/parser/displayTransformRecovery.svelte.ts` retries after 5 s with only the failed rows, so the earlier claim that such rows stay raw until a remount no longer holds. What is left is the measurement: when Display Evaluation Slice 3 measured it (2026-10-28), a 2,000-message chat of about 6 MiB charged about 6.7 MiB per scope, so only 30–38 of a 64-target chunk fit; Slice 4 then excluded the shared display entries from the per-snapshot charge (`exclude: entries`), so that number is likely smaller now. Not re-measured since.

**Why it matters:** users with display plugins and long chats may still see a round of raw rows before the retry, and a scope whose own charge is over the limit stays raw.
**Suggested handling:** re-measure on a realistic large chat with handlers (`util/playwright/measureTransformLua.mjs` has the shape); if a scope alone still passes the limit on realistic chats, raise the limit or charge the transcript once per scope.

### More than one transform chunk is in flight at a chat switch

The Render Work Budget comparison run ([audit](../audit/render-work-budget-2026-11-05.md#acceptance-after-slices-14), 2026-11-05) met "no transform target sent after a switch" but not "in-flight ones at most one chunk": switching away 100 ms after all rows mounted left 1 / 2 / 4 `/api/transform` requests (1 / 45 / 171 targets) in flight at 30 / 150 / 600 rows. Every one had been sent before the switch and all but one ended `net::ERR_ABORTED` when the last subscriber left (`src/ts/parser/transformClient.ts`); at 600 rows unmounting the rows held the main thread for about 370 ms, so one 42-target request answered first and ran to completion. How many targets cross depends on where the switch falls in the send burst (the first after run: 0 / 49 / 78).

**Why it matters:** the server still evaluates several chunks nobody will show after a switch on long chats; the cancellation arrives only after the unmount work.
**Suggested handling:** owner decision whether the plan's one-chunk bound matters; if it does, cap the chunks in flight per chat, or abort a chat's transform subscriptions when the screen leaves the chat, before the rows unmount.

## Chat screen and input

### Latest-message start scroll untested in DefaultChatScreen

In 49b046098 (2026-10-24, chat opens at the newest message's start) two pieces of `src/lib/ChatScreens/DefaultChatScreen.svelte` have no unit test, because no test mounts that screen: the reroll swipe alignment gated on `followsSwap` / `Chats.followsLatest` (read before the swap, then `scrollToLatestMessage` after a tick), and the `$effect` that consumes `ShowLatestMessageStore` (set by `openRoute` for notification clicks), and (since 2026-10-27) the scroll handler's load-more skip while `Chats.holding` is true. Only `openRoute` setting the store is tested (`src/ts/router/router.test.ts`).

**Why it matters:** a regression in either path would pass the gate.
**Suggested handling:** add coverage when `DefaultChatScreen` gets a mounted test harness (the Deep Audit Fixes bookmark-jump and translation-invalidation tests are waiting on the same harness), or when touching these paths.

### An adopted server copy drops an open inline editor's unsaved text

`src/lib/ChatScreens/Chats.svelte` mounts each row under a key that includes the message text, and `Chat.svelte` keeps an inline edit's `draft` in the component until Save (`setMessageText`). A server copy of the chat that changes an edited message's text (`applyRemoteChat`, from the live-update feed's change, the idle refresh of a stale chat, or since 2026-10-31 the completion-push read `refreshChatAfterPush`) therefore remounts that row and the typed text is gone: the chat store's local-work guards cover pending and in-flight mutations, not component drafts. Needs the inline editor (automatic popup editing off) and another device continuing or editing that same message meanwhile. Found by the Astra cross-layer review of the lost-job follow change (`/home/codex/review-reports/lost-job-follow-2026-10-31/astra-report.md`).

**Why it matters:** a few lines of a correction typed on one device vanish without a notice when another device writes the same message.
**Suggested handling:** register open editor drafts as refresh holds (the read waits until the editor closes, as pending work does), or keep drafts by chat and message id across the remount and show the changed base explicitly.

### The screenshot peak grows with the row count

After the paged export (`src/lib/ChatScreens/screenshotExport.ts`), the Render Work Budget comparison run ([audit](../audit/render-work-budget-2026-11-05.md#acceptance-after-slices-14), 2026-11-05) writes 2 / 7 / 25 valid PNG pages for 30 / 150 / 600 rows, but the renderer's `VmHWM` still rises by 607 / 1,478 / 3,987 MiB while one page's RGBA (816 × 16,308) is 50.8 MiB, so the acceptance "peak under one page plus the largest row" is not met. Most of the peak is not the page canvas; what holds it (the per-row captures, `src/ts/screenshotCaptureCache.ts`, or the DOM-to-canvas renderer's clones) was not investigated.

**Why it matters:** a 600-row export still costs about 4 GiB of renderer memory, enough to crash a tab on phones.
**Suggested handling:** take a heap snapshot and `VmHWM` per page during a 150-row export to find what scales with rows, then release it per page.

## Client and plugins

### Plugin tests cite a skip no guide records

`src/ts/plugins/apiV3/pluginContext.test.ts:1285` and `src/ts/plugins/apiV3/permissions.test.ts:314` say the skipped-instance bug of `loadV3Plugins` is recorded in `plugins-mcp.md`. The guide did not record it even before Guide Budgets slice 5b, and `src/ts/plugins/apiV3/v3.svelte.ts:2412` now unloads a snapshot of the instances.

**Why it matters:** the comments send a reader to a hazard that does not exist and may justify a repeat-until-gone test workaround that is no longer needed.
**Suggested handling:** confirm the snapshot makes the skip impossible, then drop the citation and the workaround.

### RPack mocks rest on a byte map fetch that is gone

About 11 test files mock `src/ts/rpack/rpack_js.js` with a comment that the real RPack fetches its byte map as a Vite asset (`src/ts/translator/presetsCodec.test.ts:33`, `src/ts/characterCardsImport.test.ts:59`, `src/ts/storage/tests/presetIds.test.ts:46`). `rpack_js.js` now re-exports `shared/rpack.ts`, whose map is inlined and which is synchronous. Found by Guide Budgets slice 5b.

**Why it matters:** the mocks look like unneeded boundary mocks (V7), and the tests could run the real codec.
**Suggested handling:** drop the mocks where the real codec works, or fix the comments.

### plugins.md omits two parsed headers

`plugins.md` documents neither `//@allowed-ipc` nor `//@risu-arg`, though `importPlugin` in `src/ts/plugins/plugins.svelte.ts` parses both and the runtime's IPC warnings tell authors to use `//@allowed-ipc`. Found by Guide Budgets slice 5b.

**Why it matters:** an author told to use a header cannot find it in the author guide.
**Suggested handling:** add both headers to `plugins.md` with their parsing rules.

### Stop B leftovers

Left after the Stop B fix commit (30bee445, 2026-10-05) and kept in memory until 2026-11-03; re-checked by identifier that day.

- Capture-phase key listeners still see keys behind the restore notice (`src/lib/Others/TerminalNotice.svelte` calls only `stopPropagation`, :34); a plugin's `document` listener with `capture` is the example.
- `getFileSrc` object URLs: `holdFileSrc` releases only the asset lists' `LazyFileSrc` previews; every plain `getFileSrc` read (parser HTML, chat rows, icons) pins its URL for the page, and every file gets `image/png` (`src/ts/globalApi.svelte.ts` :348); video and audio rely on the `<source type>` the parser writes. The same pinning is the open D2b item of the asset-scale work (parser `fileSrcCache`, inlays `mediaObjectUrls`).
- Load flakes seen only under parallel full suites (load average 28–32 on 2026-10-18/19), each passing alone: `server/src/tests/cbsLimitsHost.test.ts` "does not yield between quick effects…" (:557), `server/src/tests/lore.test.ts`'s worker-timeout case, `src/ts/storage/tests/resourceSyncFieldCache.test.ts`, and the cold `boot()` of the first cases of `chatStore.test.ts` and `resourceSyncChats.test.ts` hitting the 5,000 ms default (a warm-up import in `beforeAll` would remove it). `util/playwright/checkStopDMatrix.mjs`, listed then, no longer exists. Not re-run since; the whole-suite lock of 2026-10-30 reduces the parallel case.
- `addCharacter` stamps `creation_date` on a re-add (accepted at slice 5b). The first-visit default writes of some settings pages are already in `settings-i18n.md` Known Hazards.

**Why it matters:** the capture gap lets a plugin act behind a blocking notice; the pinned URLs grow with assets rendered; the flakes return whenever suites run in parallel.
**Suggested handling:** mention when working nearby and check the code first; treat the flakes as known unless one fails alone.

### loadFileSrc can return /sw/img on an uncontrolled page

`src/ts/globalApi.svelte.ts` `loadFileSrc` (~360) returns `/sw/img/<hex>` on a `knownSwPaths` hit or a `risuCache` hit while `usingSw` is true, without asking the worker. On a page no worker controls (the controller was lost or never claimed it) nothing serves that URL: the server has no `/sw/img` route (`server/src/tests/diagnostics.test.ts` lists `/sw/` as worker-only), and only a miss reaches `/sw/register`, whose failure gives the `blob:` fallback. The comment and the assets guide say an uncontrolled page gets a `blob:` URL. Found by a lookup trial of the Guides To Source run (2026-11-05); unconfirmed, and rare because worker activation clears the `/sw/img` entries. Owner: assets.

**Why it matters:** an image rendered from such a URL is broken until a reload.

**Suggested handling:** reproduce with a lost controller and a cached entry, then check `navigator.serviceWorker.controller` before returning a `/sw/img` URL.

### getFileSrc never rejects, so asset reads are never retried

`getFileSrc` in `src/ts/globalApi.svelte.ts` (~141) returns `getFileSource(loc).src`, whose loader's outer `catch` (~396) logs and resolves `""`. The render's transient classification (`src/ts/parser/renderErrors.ts`, the asset and inlay passes in `src/ts/parser/parser.svelte.ts`) marks `getFileSrc`/`getFileSrcCached` rejections transient, but a real read failure never rejects: the asset renders with an empty `src` and is not retried. `getFileSrcCached` does not cache `""` (falsy check), so the next render reads again. Found in the Render Work Budget run (2026-11-05).

**Why it matters:** the plan's retry for a failed asset read (its D2) rarely fires; a transient storage failure leaves a broken image until the row re-renders for another reason.
**Suggested handling:** an opt-in failure channel in `globalApi.svelte.ts` for the render path, rather than making the shared loader reject for every caller.

### Reset permissions leaves a running plugin's capabilities

`resetPluginPermissions` in `src/ts/plugins/apiV3/v3.svelte.ts` revokes the plugin's grants and drops its cached answers, but a running plugin keeps what it obtained before the reset: a `SafeDocument` from `getRootDocument` (`mainDom`) and its registered replacers stay live until the plugin unloads. Found in the Plugin Storage and Data API run (2026-11-05, slice 1).

**Why it matters:** a user may read "Reset permissions" as withdrawing access now; the next permission ask comes only on a new call.
**Suggested handling:** reload that plugin after a reset, or tear down each capability on revoke.

### A multi-tab plugin removal can bring its deleted data back

`src/lib/Setting/Pages/PluginSettings.svelte`'s remove button awaits `loadPlugins()` and then calls `deleteOwnedPluginStorage(name)` when "also delete its stored data" is checked, so this tab's `onUnload` cannot write the data back. Another open tab still runs the plugin until its deferred reload (`queueDeferredCheck` in `src/ts/plugins/plugins.svelte.ts`); its `onUnload` or a late `setItem` writes `_ownedPluginStorage["<name>\u0000…"]` again, and the record merge keeps it key by key. Found in the Plugin Storage and Data API run (2026-11-05, slice 6). Related: the plugin reload deferral leftovers.

**Why it matters:** the user asked for the data to be deleted, and some keys come back after a removal with the plugin open in another tab.
**Suggested handling:** raise with the owner; a fix needs a tombstone or a removed-plugin refusal in `setOwnedPluginStorageItem`.

## Build, drivers, and e2e

### checkJobProtocol's first run after a source change fails its SIGKILL case

`util/playwright/checkJobProtocol.mjs`: the first run after a source change failed `sigkill-before-checkpoint` with "waiting for navigation to finish" (the page rebooted about 6 s after the SIGKILL restart); the next two runs passed every case. Likely Vite's dependency-optimization reload of the dev stack. Found 2026-10-29 by the Job Protocol audit's verification; not reproduced.

**Why it matters:** a first run on a fresh tree can report a protocol failure that is the dev server's reload.
**Suggested handling:** if it recurs, have the driver wait for Vite's optimization to settle before the case (`openApp` already answers the prompt again after a reload), or run the dev stack once before the cases.

### A chat-open suggestion request bumps the chat revision

`src/lib/ChatScreens/Suggestion.svelte` `requestSuggestions`: with `useAutoSuggestions` on, opening a chat without suggestions requests them and stores the answer through `setChatMeta`. That write moves the chat's revision, which is part of the transform key (`server/src/prompt/transform.ts` `baseKey`), so the rows just rendered miss the cache on the next return to the chat: full answers instead of `same`, and a `{{random}}` row changes its text. Seen in an `e2e/serverTransform.spec.ts` trace on 2026-10-30, when `perChatSends` left the setting on; not checked by hand. An empty answer over a chat with no suggestions no longer writes, so what is left is a real answer.

**Why it matters:** with auto suggestions on, the first return to a chat after new suggestions downloads and re-runs what the tab already holds.
**Suggested handling:** decide whether a non-render chat field such as `suggestMessages` should move the transform key at all; the chat revision is also the key's fence against mixed-revision results, so this needs its own design.

### terminalNotice.spec.ts's composer case fails on an unseeded chat

`e2e/terminalNotice.spec.ts:279` ("Enter in the composer once the notice opened goes to its OK") fails since `81e5eda9e` locked the composers while a chat needs its setup: `input.fill` at `:312` times out on a readonly textarea with placeholder "Setup required", because the spec's `seed` sets no `promptPresetId`, `modelPresetId` or `bindedPersona` (`e2e/chatBinding.spec.ts` was updated for the lock, this spec was not). Reproduced 2026-10-31 at `e338911fc` on a clean worktree, and red in every Server Byte Budgets slice run.

**Why it matters:** a red spec unrelated to the change under test reads like a regression of that change, and the terminal notice's Enter handling is no longer guarded.
**Suggested handling:** seed the chat with its three bindings the way `chatBinding.spec.ts` does and check the spec passes.

### Delegate profile test policy names the old guide

`.claude/delegate-implementation.local.md:11` (untracked, main checkout) points the `<test policy>` slot at `docs/structure/build-test-platforms.md`. Guide Budgets slice 4 moved `### Test rules` to `docs/structure/test-harness.md`.

**Why it matters:** the slot is pasted into test-writer prompts, so a writer is sent to a guide that no longer holds the rules.
**Suggested handling:** change the slot to `docs/structure/test-harness.md`.

### check:docs does not measure blockquoted items

`util/docsBudget.mjs` `parseGuide`: `LIST_MARKER` (:54) does not see a list item behind `> `, so `> - <601 characters>` becomes a paragraph, and the length rule skips paragraphs. Found by the Guide Budgets slice 7 challenger.

**Why it matters:** low: no guide uses a blockquoted list today, but one could hold an over-long item with a passing check. The leaf and file budgets still bound it.
**Suggested handling:** strip a leading `> ` before the marker test if blockquotes appear in the guides.

### check:docs collapses spaces inside a row's code spans

`util/docsBudget.mjs:168` runs `line.replace(/\s+/g, " ")` over a whole table row to drop column padding, which also collapses spaces inside code spans, though Doc Maintenance counts code spans toward the item budget. A row with 601 spaces in a code span measures 9 characters and survives Prettier. Found by the Guide Budgets slice 7 challenger.

**Why it matters:** low: it needs an unrealistic code span.
**Suggested handling:** collapse padding outside code spans only (`replaceCodeSpans` is in the same file) if a row ever hits it.

### checkMcpFixes and the guide disagree on the repeated call

`util/playwright/checkMcpFixes.mjs:476` says the hazard recorded in `plugins-mcp.md` is "that call fails". The Gotcha on 404 and 401 records that the session resets and the request repeats once, and says nothing of a failure. Found by Guide Budgets slice 5b.

**Why it matters:** the comment and the guide disagree on what the browser check expects.
**Suggested handling:** run the check's scenario to see which holds, then fix the comment or add the failure to the Gotcha.

### docs:contracts takes a typedef for the module header

`util/docsContracts.mjs`'s header rule (~14: the first `/** */` block after the imports) makes `pnpm docs:contracts util/agentDataSandbox.mjs` report "module header: line 9", the `/** @typedef ... AgentDataSandboxMode */` block, while the real contract is the leading `//` block above the imports, which the tool never counts; the util scripts therefore show "module header: none". Found in the Guides To Source run (2026-11-05). Owner: build-test-platforms.

**Why it matters:** the header counts feed every slice's documented share: a typedef inflates it and `//` headers deflate it.

**Suggested handling:** skip a lone `@typedef` block, and count a leading `//` block in `.mjs` scripts as the header.

### docs:ledger counts broad Scope globs as named files

`util/docsLedger.mjs` `namedTargets` (~118) and `resolveNamed` (~185) take every path span of the working guide, globs matched, as a file a dropped identifier may live in. A broad Scope glob (`self-host-server.md`'s `server/{src/**,tsconfig.json,ssl/*}` matched 428 files) lets `pnpm docs:ledger` pass for almost any identifier some server file mentions. In the Guides To Source run (2026-11-04) a strict pass without the glob found one real miss. Owner: build-test-platforms.

**Why it matters:** the ledger is the mechanical guarantee that a guide trim lost no fact, and several guides have similar globs.

**Suggested handling:** add a `--strict` flag that ignores glob spans, or run such a pass by hand on trims of glob-scoped guides.

### docs:read and guide-reads script gaps

Found in the Guides To Source run (2026-11-04/05); owner build-test-platforms.

- `util/docsRead.mjs` `sectionText` (~57) strips backticks from the headings but not from the query, so a heading passed as the listing prints it (``'Not in `sendChat`'``) "matches no heading"; agents copy the backticks, at the cost of a call and a reprinted heading list.
- `resolveGuide` (~12) tries the name as given first, so `pnpm docs:read README.md` prints the repository-root README instead of `docs/structure/README.md` (Doc Maintenance); bare `README` works. `util/guideReads.mjs` mirrors this now.
- `util/guideReads.mjs` `scanTranscripts` (~497) validates a guide name only for `docs:read` events, so a Bash command naming a fixture path such as `docs/structure/a.md` becomes a guide row (`a` and `g`, 3 of 12,273 in `docs/audit/guide-reads-2026-11-05-wave3.md`). Validating against git history would drop 63 real counts of 18 retired guides, so the fix needs another signal, such as the tool result showing the file was missing.
- A `docs:read` of a guide's title heading covers only the title in `countEvent` (`under`, ~253), since child labels omit the title, so every `##` would show as untouched; no audit so far had such a query.

**Why it matters:** the first two cost lookups and can skip the guide-edit rules; the last two would skew a later audit's rows and untouched lists.

**Suggested handling:** strip backticks from the query and prefer `docs/structure/README.md` for `README.md` (with node tests, updating `guideOfArgument`); for an audit rerun, note the bogus rows and count title queries first, or cover every heading when the resolved section is level 1.

### measureChats.mjs trips safe boot and fakes its scrolled-up input

`util/playwright/measureChats.mjs` as committed cannot finish: its boot loop waits `page.waitForTimeout(2000)` between three fresh boots (~317), below `SAFE_BOOT_SETTLE_MS` (10 s, `src/ts/safeBoot.ts`), so automatic safe boot opens its alert and the `Go Back` click in `chatRow` times out. Its `streamReply({ scrolledUp: true })` only sets `scrollTop`, while `Chats` releases its anchor on wheel, touch, pointer or key input, so "Long: scrolled-up streaming keeps the loaded window" fails (600 → 150 rows) as harness input, not a product change. Already described in `docs/research/rendering-performance-investigation.md`; seen again by Incremental Chat Transport Slice 0 (2026-11-05), which measured with a scratch copy.

**Why it matters:** every measureChats-based slice needs a temporary settled copy until the driver is fixed.

**Suggested handling:** wait 11 s after the seed check and between boots (or clear the safe-boot attempts as `util/playwright/stack.mjs` offers), and drive the scrolled-up case with real wheel input.

### checkServerSend once hit an alert after its mid-stream reload

On 2026-11-05 (Incremental Chat Transport Slice 5, code at `f906c864e`) the first `node util/playwright/checkServerSend.mjs` passed 11 checks, then `openCharacterChat` after the "reload in the middle of a slow stream" step (~340) timed out because a `[data-alert-dialog]` overlay covered the sidebar. The run overlapped a `docker build`; four reruns passed 19/19, two of them logging no alert after the reload, and the base `9bf28c429` passed 19/19. The alert text was not captured. Candidates: the automatic safe-boot notice (the driver does not clear safe-boot attempts) or an error alert from the owner's resync after the reload.

**Why it matters:** if it recurs it may be a real owner-reload problem, not harness noise.

**Suggested handling:** if it shows again, print the dialog text before `openCharacterChat` to tell the two apart; consider clearing safe-boot attempts in the driver.

## Guides

### Archive README cites a gone emotion table hazard

`docs/archived-plan/README.md:824` says the emotion table's `bind:value` throw is a Known Hazard in its guide. `characters-modules.md` has no such entry and the table no longer uses `bind:value`.

**Why it matters:** the archive sends a reader to a hazard that is gone.
**Suggested handling:** a one-clause correction, only when the archive is touched anyway.

### Choose By Task rows missing routing words

Lookup trials of the Guides To Source run (2026-11-04/05) hesitated or guessed at these `STRUCTURE.md` Choose By Task rows; each chose right or recovered through a guide's links, and the slices could not edit `STRUCTURE.md`.

- cbs-rendering ("CBS, markdown/sanitization, ...") does not say display transforms; only server-generation's row says "transforms", though the tab-side client and retries live in cbs-rendering (`src/ts/parser/transformClient.ts`, `displayTransformRecovery.svelte.ts`). Add "display transform client and retries".
- Only network-jobs names "Web Push"; a push-diagnostics question (`public/sw.js` `showPushNow`, `workerRecords.ts`, `BROWSER_PUSH_PHASES`) belongs to diagnostics. Add "push diagnostics" to the diagnostics row.
- memory ("SupaMemory, HypaV2/V3, Hanurai, embeddings") does not name HypaV3 job modes (blocking or select-only, the gap question), which also match server-generation's "Generation jobs". Add "HypaV3 job modes".
- app-shell ("Boot, screen selection, ...") lacks "safe boot", and plugin-sandbox is a plausible wrong turn for a plugin failing at startup. Add "safe boot".
- assets' "Asset sources and thumbnails" competes with self-host-server for thumbnail HTTP answers (`/api/asset/*?w=`, `x-risu-thumbnail`, `thumbnailRedirect` in `server/src/routes/storage.ts`). Add "thumbnail HTTP responses" to the self-host row, or narrow the assets row to the client.
- test-harness's "network guard, Playwright stack" and `docs/structure/test-harness.md`'s `Tests > Network guard` (~287) cover only the Vitest guard; the Playwright egress tripwire is `egressGuard` in `util/playwright/stack.mjs`, routed from Files > Browser stack. Point Playwright egress there from the heading's first line.

**Why it matters:** the row is the first routing step, and a misroute costs a guide read.

**Suggested handling:** add the words at the next `STRUCTURE.md` edit (and the test-harness pointer at its next edit).

### Protocol step 1 reads the Invariants on every lookup

`STRUCTURE.md:13` (Agent Read Protocol step 1) says to read Repository-Wide Invariants unconditionally. In a writer lookup trial of the Guides To Source run (2026-11-05) a fresh agent answering two read-only questions spent about 9.5 KB (about 11% of its reading) on it and used none of it. D9 of that plan already limits a guide's `Invariants` to add and change tasks.

**Why it matters:** every session reads `STRUCTURE.md` first, so the cost repeats on every lookup.

**Suggested handling:** apply the same split to step 1 when the protocol is next edited.

### chat-pipeline links a reroll hazard to the wrong section

`docs/structure/chat-pipeline.md:399` (Known Hazards > Issues: a reroll's restore cannot see another tab's job that holds no lock yet) says "see [server generation's own chat changes](live-update-feed.md#own-chat-changes)", but that section describes `applyChanges` `changes: true` and `ChatWriteChange`, nothing about a lockless job meeting a restore; the label suggests it once pointed into `server-generation.md`. Line 285's link (labelled "generation") reaches `refreshChatAfterWrite`'s contract only through the section's `server/src/jobs/jobScope.ts` pointer. Found in the Guides To Source run (2026-11-05). Owner: chat-pipeline.

**Why it matters:** a reader following the hazard's link finds no explanation.

**Suggested handling:** point the link at the server-generation section on job creation and lock acquisition (or drop the "see"), and relabel line 285's link.

### docs:owner sends the asset lifecycle client to persistence

`pnpm docs:owner src/ts/storage/assetLifecycleClient.ts` (and its test `src/ts/storage/tests/assetLifecycleClient.test.ts`) answers `persistence` through the `src/ts/storage/` fallback, while the client is documented in `docs/structure/assets.md` (Asset client, Tests). The Asset Lifecycle run's Storage panel slice (2026-11-05) added the files and could not edit `docs/structure/ownership.json`.

**Why it matters:** an agent routed by `docs:owner` reads the persistence guide and finds nothing about the report, scan, and sweep client.

**Suggested handling:** add `assetLifecycleClient` to the assets rules in `docs/structure/ownership.json` beside `src/ts/storage/{assetClient,assetQueue}.ts` and their tests rule, then run `pnpm check:docs`.

### The global-api guide misses the checkbox confirm

`docs/structure/global-api.md` says `AlertComp.svelte` "answers with `alertStore.answer(msg)`", and its `src/ts/alert.ts` helper list omits `alertConfirmWithCheckbox`. Since the Plugin Storage and Data API run (2026-11-05, slice 6) the `ask`/`pluginconfirm` buttons and the Enter path in `src/ts/hotkey.ts` answer through `alertStore.answerConfirm(confirmed, shown)` (`src/ts/alertQueue.ts`), which answers `{ confirmed, checked }` when the dialog has a `confirmCheckbox`; `setConfirmChecked` updates the box without queuing a dialog.

**Why it matters:** a reader adding a confirm variant follows the guide and misses the checkbox path.
**Suggested handling:** fix on the next global-api guide edit, paid for with a trim (the guide tree is at its byte ratchet).

### Structured Memory decision pointers name the plan

`rg -n "Decision: Structured Memory [^,]*, plan" docs/structure` gives 42 hits, for example `docs/structure/structured-memory/records.md:282` ("slice 6c, plan") and the Limitations of `structured-memory/writer.md`. The Structured Memory plan was retired into the archive on 2026-11-03, so ", plan" sends a reader to a file no longer under `docs/plan/`; the HypaV3 pointers in `memory.md` already say "archive". Found in Reroll Candidates Slice 3 (2026-11-05), re-checked on the merged target.

**Why it matters:** a pointer to a moved plan is a dead end for an agent following the Agent Read Protocol.
**Suggested handling:** rewrite them to ", archive" in a guide-maintenance pass (byte-neutral or smaller).

## Test timing

### Gate tests still racing real time

Untagged gate tests that depend on real wall-clock or scheduler time (invariant V3), noted by the [cross-plan review](../manual-audit/cross-plan-2026-10-29.md#test-quality) on 2026-10-29; none failed in its runs. `src/ts/storage/tests/draftJournal.test.ts`: the start and adoption cases (the live-owner case near "leaves a live owner's rows alone" and the owner-reload case) call the real journal with its production 3 s open/seed and 5 s recovery-lock deadlines, and the file's blanket fake-timer comment does not hold for them. `server/src/tests/hypaV3Parts.test.ts`: selection and deferral cases built with `hostOf` run under the real 5,000 ms cumulative separator budget. `server/src/tests/transformService.test.ts`: `heldCount` polls with a real `setTimeout(2)` (up to 500 polls) and a 5 ms real sleep observes shutdown. `server/src/tests/transform.test.ts`: the real-worker route cases outside the cache describe's fake clock race worker, CBS, and transform deadlines (`SLOW = 60_000` is a timeout, not a `slow` tag). `src/ts/storage/tests/bootCacheServer.test.ts` (around the cases near lines 185 and 485 at that time): the real 3 s cache deadline with asynchronous IndexedDB work. Real sleeps: `server/src/tests/push.test.ts` (delivery and queue synchronization). `src/lib/ChatScreens/Chat.draft.test.ts`: the auto-popup cases wait for the first row with real `vi.waitFor` before faking timers. `src/ts/network/generationJobs.test.ts` and `src/ts/process/serverCommands.test.ts`: zero-delay real-timer `flush` helpers (28 and 106 calls) as synchronization. Re-checked 2026-11-03: behind mocks that resolve at once these flushes are close to deterministic; the load-sensitive part left is the `generationJobs` `startFollow` cases outside fake timers, which race the real connect timeout. `server/src/tests/testSupport.ts` `waitFor` without `timeoutMs` has no deadline of its own and is not one of these.

**Why it matters:** each is a load-sensitive failure waiting for a slow CI runner; the timing plans' policy (`docs/structure/test-harness.md` `Tests`) asks for controlled clocks or the `slow` tag.
**Suggested handling:** when one of these files is next touched, control its clock (inject the deadline or fake the timers) or tag the case `slow`; `pnpm --silent test:agent --slow-tests` lists the ones over 1 s.

## Structured Memory

Moved from the Structured Memory plan run on 2026-11-03. Each entry was re-checked against the run's last tree that day; the guides' Known Hazards hold the limits the owner accepted, so they are not repeated here. The last two entries came from the Guides To Source run on 2026-11-05.

### Memory task wording still says summaries

The memory task service has a `structuredMemory` kind since slice 2b, yet comments still describe every task as HypaV3: `shared/events.ts` (~21), `src/ts/network/eventFeed.ts` (~38), `server/src/jobs/runSetup.ts` (~64), `server/src/app.ts` (~451, ~1007), `src/lib/SideBars/chatStatus.ts` (~15). `summarizingChats` in `src/ts/process/memoryTasks.svelte.ts` counts a writer task as summarizing, and `src/lib/ChatScreens/ContextMeter.svelte`'s task block shows "Background summary", "the new summaries are stored", and "summarizing 0/1" for the writer (seen in a browser 2026-11-02). The HypaV3 modal's status helper keeps HypaV3 wording, but Structured Memory chats open their own panel.

**Why it matters:** an agent reads a task as HypaV3, and a user who cannot verify memory is told the wrong activity.
**Suggested handling:** read `MemoryTaskStatus.kind` in the meter's task block and chip, and widen the comments.

### Record now in a job is seen by one tab

`server/src/prompt/memory/structured/recordJob.ts`: the blocking in-job path opens job-scoped progress only and sets no memory task status or `memoryTaskFenced` fence, so another tab's panel stays editable while it runs (the queued path does publish). `MemoryReceiptLine.svelte` `press` also shows "Recording requested" after any `done`, including one sent after the in-job run already finished, and a window that ends `skipped` puts its raw reason code into the English job error (`runWindows`). Slice 2d.

**Why it matters:** D3 wants every tab read-only while the writer runs; the toast and the code read oddly.
**Suggested handling:** publish a status for the in-job run, let `done` say which path ran, and map the reason through the language file.

### Receipt on a message with no generation info

`writer.ts` `commitWindow` writes `generationInfo: { memory }` on a window message that had none, so with `requestInfoInsideChat` `Chat.svelte` shows a model button labelled "Unknown". `genInfo`, which holds `MemoryReceiptLine`, is not rendered in the `mobilechat` and `cardboard` themes, so no receipt line shows there. Slice 2d.

**Why it matters:** a stray button in one setting, and no receipt at all in two themes.
**Suggested handling:** skip the model button when only `memory` is present; decide where the line goes in those themes.

### Panel writer line and stale views

In `src/ts/process/structuredMemory.svelte.ts` and `StructuredMemoryPanel.svelte`:

- `memoryWriterNotice` reads `pluginModel` and `requestTrigger` only from the newest reply's receipt, because `jobMemoryBlockingReason` needs a job scope no route has, so before the first send the panel does not say "not recording automatically".
- A checkpoint load refreshes the chat resource but not the panel's contents, so an open panel shows the records from before the load until refreshed. A stale edit is refused 409, so nothing is lost.
- A copied or branched chat keeps `generationInfo.memory` while its runs stay behind (`structured/inherit.ts`), so a copied paused receipt can offer Resume on an empty Log.
- `pressReset` reads the chat again only on `reset: true`. When the route committed but the answer was lost, the repeat answers `reset: false`, and the tab keeps the old value until the feed's notice comes.

**Why it matters:** the panel says something untrue until a refresh or a send.
**Suggested handling:** a scope-loading status read for the first item, a refresh on the chat's change frame, stripping copied receipts (or ignoring run-less ones), and reading on any reset answer.

### Cast slice matches substrings

`castSlice` (`server/src/prompt/memory/structured/pages.ts`) lists a page when its title or alias is a case-insensitive substring of a window message, so an alias "Al" matches "also". The read path uses `searchMatch`.

**Why it matters:** an extra prompt row, never a wrong record; the writer and the read path disagree on "named".
**Suggested handling:** use `searchMatch` in `castSlice`.

### Lore search depth skips a short chat's first messages

`searchMatch` (`shared/lore/activation.ts`) slices `messages.slice(messages.length - searchDepth, messages.length)`. A negative start counts from the end, so three messages and depth 5 start at index 1 and skip message 0 (`[0,1,2].slice(-2, 3)` is `[1, 2]`). The pages lane avoids it by passing exactly the rows it wants. Found 2026-11-02.

**Why it matters:** a key only in the first messages of a short chat does not activate.
**Suggested handling:** clamp the start to 0 and update `server/src/tests/fixtures/baseline/`, after checking upstream parity.

### Snapshot layout check is copied

`memoryStateLayout` in `server/src/data/memoryStore.ts` copies the layout block at the head of `walkCheckpointSnapshot` (`server/src/data/checkpointStore.ts`): name match, ordinary table, exact columns, all or none. Slice 1c could not edit `checkpointStore.ts`.

**Why it matters:** two copies of a check on crafted snapshot files can drift apart.
**Suggested handling:** one helper beside `snapshotRows` in `resourceStore.ts`.

### Hand-written resourceSync mocks

`src/lib/ChatScreens/Chat.test.ts` keeps a hand-written `vi.mock` of `src/ts/storage/resourceSync.svelte`, and other files mock it too, though `src/ts/tests/bootMocks.ts` has a typed factory. Slice 5c met three tests failing at run time on a missing `beginMutationScope`.

**Why it matters:** STRUCTURE.md V7: a new export should break the type check, not a run.
**Suggested handling:** move those mocks onto the shared factory.

### Projection refresh leftovers

Left by slice 5g. A journal recovery that replays a real `hypaV3Data` while Structured Memory is selected is dropped (`src/ts/storage/journalRecovery.ts` `applyChatOps` through `setChatMeta`) with the plugin-worded `structuredMemory.projectionWriteRefused` notice. The body-cap comment above `limitBody` in `server/src/app.ts` omits the revisions route's 256 KiB. The `chatOutput` payload (`src/ts/network/jobChannel.ts`) copies held chats with no projection refresh. `src/ts/plugins/apiV3/hostApiMemory.test.ts` reads `MEMORY_REFRESH_DEADLINE_MS` and `MEMORY_PROJECTIONS_PER_READ` out of `v3.svelte.ts` by regular expression.

**Why it matters:** a wrong actor in a rare notice, a stale comment, a stale payload, and a brittle test.
**Suggested handling:** a recovery wording, the comment in the next `app.ts` change, and moving the constants to `shared/structuredMemory.ts`.

### Rebuild lock refusal has no code

`server/src/jobs/generationJobs.ts` refuses a job during a rebuild with a plain-text 409, and the tab's `registryRefusal` knows only coded refusals, so a create retried after a lost answer shows the generic lost message. Slice 6b, by reading.

**Why it matters:** rare, and the panel shows the run anyway.
**Suggested handling:** give the refusal a code and words in `src/lang/en.ts`.

### Adopted summaries

Left by slice 6a. An adopted summary's `pinned` selects nothing in any lane (`adopt.ts` maps `isImportant` to it; `retrieve.ts` and `step.ts` never read it). A summary over the card budget is excluded while its messages still leave the prompt. A stored-stale adopted event kept by a person reads active while retrieval answers `not-relevant`, and a copy drops any event with an unanchored source.

**Why it matters:** an important HypaV3 summary stops being sent every time.
**Suggested handling:** decide what `pinned` means for an adopted event before changing the lanes.

### Highlight and revert leftovers

Left by slice 7b. `retract` stays in `MEMORY_HISTORY_CHANGE_KINDS`, `STRUCTURED_MEMORY_HIGHLIGHT_KINDS`, and the default `highlightKinds`, though only a restored entry can carry it and the settings offer no box. `mayCompact`'s `userCorrected` check is reached only by a disputed join, which `disputed` already refuses. A new page's receipt row has no highlight and no revert. Changing a chat's highlight mode moves `memorySettingsFingerprint`, so a queued writer input ends `skipped` (`staleInput`).

**Why it matters:** dead values and checks, and one lost queued run per mode change.
**Suggested handling:** drop `retract` with `normalizeStructuredMemorySettings` dropping a stored one; leave highlight out of the fingerprint if a replay may ignore it.

### Prompt test run leftovers

Left by slice 7c. `server/src/prompt/memory/structured/testRun.ts` is missing from `STRUCTURE.md`'s Path Ownership for structured-memory-writer, though the writer guide lists it. `TEST_REFUSALS.gap` is unreachable, since `jobMemoryBlockingReason` answers only `pluginModel` and `requestTrigger`. The result screen says "Outcome: Recorded" for a test that saved nothing.

**Why it matters:** misrouted questions, dead code, and a word that reads as a save.
**Suggested handling:** add the path, drop or narrow the record, and word the outcome for a test.

### Page tool leftovers

Left by slice 7d. `splitPage` and `splitTimeline` in `src/ts/process/structuredMemory.test.ts` are not whole package readers (key-line quote lines and collapsed headings break them); `parseMemoryPackage` is. `parseMemoryPackage` accepts `trashedAt` on a non-scene page, which the package never writes. `contents.trash` has no budget or expiry and the table of contents grows with it. `pages.test.ts` has no test of the page tools; they run only through `structuredMemoryRoutes.test.ts`.

**Why it matters:** test helpers that pass by luck, and a trash that only grows.
**Suggested handling:** test through `parseMemoryPackage`, drop `trashedAt` on import, and decide on a trash bound.

### Health badge leftovers

Left by slice 7e. `memoryHealthStates` (`src/ts/process/chatStatus.svelte.ts`) walks every character's chats on each recompute in three consumers (`Sidebar`, `MainMenu`, `DefaultChatScreen`). It does not exclude group chats, so a pinned group chat can show `customPrompt` though the writer refuses group chats (unconfirmed in a browser). The contents route calls `readHealth` with no byte budget.

**Why it matters:** repeated walks, and a badge on a chat the writer never serves.
**Suggested handling:** one shared derived, a group exclusion, and a budget on the contents read; measure first.

### Evaluation findings

Measured by slice 8 on scripted fixtures (`docs/audit/structured-memory-2026-11-03.md`); nothing was changed, and Q2 stays open until a real A/B.

- `MEMORY_CALL_OVERHEAD_TOKENS` (1,500) is low: overhead was about 2,100 per call in English and 2,800–3,700 in Korean, and actual analysis input was 1.13–2.32 times the preview. Proposal: 3,000, bytes÷3 kept, after a real-model check.
- `selectMemory` takes 520–584 ms on a 1,000-turn send, mostly tokenizing (296–356 ms) and cache reads; `addText`'s quadratic scan costs 60 ms at 4,000 texts.
- An unchanged checkpoint save holds about 500 ms on a 2,000-run chat. A hash cache is not worth it; dropping `input` from recorded runs is (whole-row readers not traced).
- `getChatFromIndex` over 67 or more loaded chats spends the shared per-IP authenticated bucket, and a neighbour route was refused until the reset (loopback surrogate only).
- `readHealth`'s page-byte budget bounds neither events nor runs: 635 ms for 64 chats of 5,000 each.
- At a 16k context the `threads` lane starves once events carry three quotes, and a two-event comparison loses one event in a long chat, also at 32k.

**Why it matters:** cost previews people pay by, and stalls on long chats.
**Suggested handling:** take each as a proposal when Structured Memory is next touched, and re-run `node util/memoryEval.mjs` after a read-path change.

### Writer and lifecycle page slips

Found by lookup trials and challengers of the Guides To Source run (2026-11-05), each predating that day's rewrites; owners are the named pages.

- `docs/structure/structured-memory/writer.md:72` links adopted sources counting as recorded to `lifecycle.md#the-adoption-choice` (the hold rules), but the fact (`recordedMessages` reads sources in any status) is under `#adopting-hypav3-summaries`.
- `writer.md:186` (The gap run) says "an edit during the run can leave one send with a slightly stale prompt". A memory edit is refused 409 `fenced` for the whole gap run (`chatHeld` in `server/src/app.ts`), so it means a message edit; a trial read it as contradicting the fence.
- `writer.md:9` lists `testRun` in its Scope `Paths`, while the test run's contract is read's (`read.md` "The test run") and `read.md:8`'s `Paths` omits `server/src/prompt/memory/structured/testRun.ts`; the folder README already routes `testRun` to read.
- `lifecycle.md`'s Files entries for `server/src/data/checkpointStore.ts` (~37) and `src/ts/storage/chatStore.svelte.ts` (~53) carry no `Owner:` marker, though `pnpm docs:owner` gives them to server-resources and chat-store and the same page marks `memoryStore.ts` and `writer.ts`. A reader starting from `docs:owner` gets no hint of the lifecycle page either.

**Why it matters:** each sends a reader to the wrong section or guide, or lets them take the page as the owner.

**Suggested handling:** retarget the anchor, say "a message edit", move `testRun` from writer's Scope `Paths` to read's, and add the `Owner:` markers (or a shared-part rule) at the next edit of each page.

### Two memory comments blur their scope

`server/src/prompt/memory/structured/pages.ts:52` (module header, page tools) says "A merge moves every reference to the source onto the target in the same change set", but the route adapter (`server/src/routes/structuredMemory.ts` ~1032) passes only `contents.pages` as `records.pages()`, so a page already in the trash keeps its link to the merged source; the `mergedPages` comment and pages.md were corrected, the header left. `server/src/data/resourceStore.ts:2162` (`store.memory.rebuild.rebuilding`: "the chat holds a run under this algorithm") does not say `structuredMemorySelected()` reads the one global `memoryAlgorithmType`, so a switch releases every chat's run lock at once; a trial read it as per chat. Found in the Guides To Source run (2026-11-05). Owners: structured-memory (the writer page held the header that day), and server-resources.

**Why it matters:** a reader of the comment alone gets the scope wrong.

**Suggested handling:** say "live pages" in the header and "the global algorithm setting" in the `rebuilding` comment at the next edit of each file.
