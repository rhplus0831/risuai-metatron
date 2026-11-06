# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's Known Hazards `Issues` (or `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (3)
- [Server jobs and prompt assembly](#server-jobs-and-prompt-assembly) (7)
- [Server routes and resource store](#server-routes-and-resource-store) (5)
- [Request history and diagnostics](#request-history-and-diagnostics) (2)
- [Display transform](#display-transform) (8)
- [Chat screen and input](#chat-screen-and-input) (5)
- [Client and plugins](#client-and-plugins) (15)
- [Build, drivers, and e2e](#build-drivers-and-e2e) (7)
- [Guides](#guides) (1)
- [Test timing](#test-timing) (1)
- [Structured Memory](#structured-memory) (9)

## Chat store, sync, and change feeds

### Parked resends leak

`src/ts/storage/chatStore.svelte.ts` `dropCharacterWork(id, false)` from `takeChatWork`'s absent-character sweep (~3505, the quarantined-create path) parks in-doubt resends (`parkResends`); no deletion acknowledgement or `forgetCharacter` ever comes for a character the server never had, so the entry stays until `seedChats` (boot) or a re-add of the same id, which would replay a harmless resend first. Accepted trade-off of open-bug-fixes slice A3 (landed on metatron 2026-10-19 via plan-runner), noted by its Fable reviewer. Still present 2026-10-21 (`parkedResends`, chatStore.svelte.ts ~180).

**Why it matters:** tiny memory leak per session; a far-later same-id re-add sends one extra replay.

**Suggested handling:** if it matters, drop parked resends once the adapter knows the abandoned character has no server incarnation and no unresolved create can still establish one, and also clean entries parked in an earlier cycle. `persisted` alone is not that proof: a removed character whose create answer was lost is resent while `persisted` lacks it (resourceSync.svelte.ts ~1387), and a same-id re-add still needs the preserved group ids (checked 2026-10-24). Parked payloads can hold whole chat snapshots, so the leak is not always tiny.

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

### Phase 6 review leftovers

Raised in the Phase 6 slice 6–11 reviews (2026-10-05..07) and judged out of scope or pre-existing; kept in memory until 2026-11-03. The `stores.svelte.ts` ↔ `parser/transformClient.ts` import cycle is in `app-shell.md` Known Hazards and is not repeated here.

- Vitest-only module-effect race: when `database.svelte` or `stores.svelte` loads first in a test, their module-level effects read state that is not initialized yet; native ESM in the app is not affected. A test that reaches the settings views cannot use `@vitest-environment node` (the records need Svelte's client `$state`); flat fixtures use `src/ts/storage/tests/installFlatDatabase.ts`.
- Preset reorder criterion missed: reordering 50 presets took 17.9 ms against a 16.0 ms baseline (+12 %, target within 10 %); a plain-row projection was not tried (`docs/audit/preset-reorder-2026-10-05.md`).
- Slice 9a: the facade's `chats` view (`setCharacterChatView`, `records.svelte.ts`) builds a fresh array per read, so loops go through `findChat`.
- Slice 9b: the own-save echo of an unloaded chat's list field costs one summary-list read; a noticed loaded idle chat is read whole before the trim may evict it; `installRead` and `adoptChatRead` (`chatStore.svelte.ts`) disagree on incomparable revisions (only test tokens like `"r1"`); store-backed test harness boots still read `{ chats: true }`.
- Hazard-entry notes: `llm-requests.md` leaves three OpenAI-format credential sends untested (key map, preset proxy key, custom model key); the M16 "stale module" can be a different module when a replacement reorders the list.

Identifiers re-checked 2026-11-03 (`setCharacterChatView`, `installRead`, `adoptChatRead`); the timings were not re-measured.

**Why it matters:** each is small; together they are the known soft spots of the store facade and its tests.
**Suggested handling:** check the code when working nearby; an item confirmed with an owning guide moves to that guide's Known Hazards.

## Server jobs and prompt assembly

### Tool schemas are outside the assembly token budget

`server/src/prompt/assemble.ts`'s final recheck counts messages; `AssemblyHost` has no tool-schema input, and the OpenAI adapter (`server/src/llm/openAI/requests.ts`) adds `body.tools` from descriptors supplied later in `server/src/llm/requests.ts`. A prompt assembled to the budget can therefore exceed the provider's context by the schemas' tokens. Traced by the [cross-plan review](../manual-audit/archive/cross-plan-2026-10-29.md#hypotheses-not-reproduced) (memory seam) and not reproduced with a real tokenizer; unverified.

**Why it matters:** with many or large tool definitions a send near the budget could be refused by the provider although the meter shows room.
**Suggested handling:** measure with a real tool set and tokenizer; if the gap is real, charge an estimate of the schemas in the recheck (the token-counting follow-up group of the Deep Audit Fixes plan).

### No-memory trim question gaps

The no-memory trim question (aad461e63, 2026-10-11; `server/src/prompt/runner.ts` ~1086 compares `memoryTrimAck` with `supaMemoryOnCount`) shipped with gaps accepted at its review: the late removable-message cleanup in `assemblePrompt` (`v.removable`, `server/src/prompt/assemble.ts` ~2131), which runs after formatting, can still drop history without asking (offering "turn memory on" there would re-run memory and formatting mid-assembly); when the question goes unanswered (timeout or a lost owner) the job error the user sees is English, since the server has no localized channel for terminal errors; `supaMemory` turned on by a plugin (`setCharacter`) or a raw record write does not bump `supaMemoryOnCount`, so a chat's "don't ask again" survives it (Lua has no `supaMemory` setter); the dialog was never checked by hand. Identifiers re-checked 2026-11-03; kept in memory until then.

**Why it matters:** a user can still see a silent trim or an English error from a feature meant to ask first.
**Suggested handling:** raise when a silent trim or an English job error is reported; the cleanup gap needs a design, the other two are small.

### The trim question counts blank history

`server/src/prompt/assemble.ts` (~1890–1902): with a memory method configured but off, the dry-run trim loop asks the no-memory trim question (`host.memoryTrim.confirm()`) when `dropped > historyStart`. A greeting or message its editprocess scripts blanked (`blankEntry`, `ContextSource.empty`) counts as history there, so a trim that would drop only blank entries still asks. The Found Issues Sweep's F2 (2026-11-05) fixed the gap question (`trimHistoryToContext`) and the trim ledger, not this one.

**Why it matters:** the user is asked to turn memory on to protect history that nothing would lose.
**Suggested handling:** ask only when a non-blank history entry is among the dropped ones.

### An untargeted handoff offer blocks the creator's rescue

`armOffer` in `server/src/jobs/generationJobs.ts` (~1157) replaces only a targeted `requested` offer with `absent` once the owner is gone. An untargeted `requested` offer, or the `preferred` offer opened at admission (`handoff: "prefer"`), stays as it is. Foreign workers with acceptance on can still claim it, but the creator takes its own job only through `absent` or a self-targeted offer (`evaluateOffers` in `src/ts/network/handoff.ts`, ~274–287; `handoff.test.ts` pins that own requested and preferred offers are left alone). Found in the Implementation Audit Fixes run (2026-11-05, slice H1), which kept it out of scope because it broadens the ownership policy on both sides.

**Why it matters:** with no accepting worker online, an owner absence under a preferred or untargeted offer has no automatic creator rescue.
**Suggested handling:** owner decision; either fall back untargeted offers to `absent` on absence too, or let the creator take its own untargeted offer while the owner is absent.

### Slash commands address stored positions during a reroll

`server/src/prompt/commands.ts` (~218–262: `comment`, `cut`, `del`) resolves indexes and "the last message" against the unfiltered stored chat in `services.writeChat`. During reroll assembly (`scope.rerollHistoryMessageId` set) the Lua getters and indexed setters address the history view with the carrier hidden (`scopeHistoryMessages` in `server/src/lua/bindings.ts`), so a trigger's `v2Command` (`server/src/prompt/triggers.ts`) running `/cut 2` can target a different message than a script reading the view, and `/comment` hits the hidden carrier as "last" and is refused by the lock. Found in the Implementation Audit Fixes run (2026-11-05, slice C1).

**Why it matters:** the same read/write address mismatch C1 fixed for Lua, on a rarer path (slash commands from triggers during a reroll).
**Suggested handling:** resolve these commands through the same history-view helper the Lua bindings use.

### runTrigger copies the character before seeing no triggers

`runTrigger` in `server/src/prompt/triggers.ts` (~372) calls `triggerCopy(sourceChar)` (~384, a `structuredClone` of every character field except the shared asset lists and chats) and registers a patch observer before `run()` checks for an empty trigger list (~444). The display transform (`head` in `server/src/prompt/transform.ts`, ~668–680) runs a `display` trigger per rendered message, so a character with no character or module triggers still pays one character deep copy per row render. Found in the Implementation Audit Fixes run (2026-11-06, slice C7), which skipped the two chat copies but not this one.

**Why it matters:** per-row render cost on long chats; perf only, low priority.
**Suggested handling:** check `hasTriggers(sourceChar)` (already on the runtime) before `triggerCopy`, keeping the `yieldTurn` and the fence.

### HypaV3 summary chunks find their vectors by scan

`HypaProcesserEx.addSummaryChunks` in `server/src/prompt/memory/hypav3.ts` (~2676, the non-contextual path ~2687) calls `this.vectors.find((v) => v.content === chunk.text)` once per chunk after `addText`, so N chunks cost about N²/2 content comparisons: the shape of the admission scan the Implementation Audit Fixes run's M10 removed from `HypaProcesser.addText`. Found in that run (2026-11-06), outside the slice's files.

**Why it matters:** long HypaV3 chats re-add every summary chunk per send.
**Suggested handling:** build a map by content once after `addText`.

## Server routes and resource store

### The change log's bound is a row count, not 4 MB

The `changes` table in `resources.sqlite` (Incremental Chat Transport D5, `server/src/data/resourceStore.ts`, pruned by `pruneChanges` ~1020) keeps the newest 20,000 rows. The plan's Q1 and D5 text ("a row is under 200 bytes: 4 MB at most", "40 snapshots hold up to about 160 MB of logs", cross-plan X8) understates the worst case: ids may be 512 UTF-16 units (the id validator in `resourceStore.ts`, chat ids in `server/src/data/chatStore.ts`), a 20,000-row probe with such ids made an 82 MB database (2026-11-05, Slice 3), and DELETE-based pruning never shrinks the file. Whole-file snapshots (`backupTo`) and version-2 downloadable backups (`server/src/routes/backups.ts`, which strips `llmSecrets` and vacuums) carry it. Found by Slice 3's challenge.

**Why it matters:** with typical UUID ids the log is a few MB, but the Asset Lifecycle snapshot budget counts 40 copies of it at a byte size the code does not bound.

**Suggested handling:** size snapshot storage as rows × id length; add a VACUUM or a byte bound if a real store comes near it.

### Lua image shortcuts reuse an asset key without a claim

`isImageInlay` in `server/src/lua/bindings.ts` (~774, used by `usableImage` for `getCharacterImageMain` / `getPersonaImageMain`) checks the inlay's media with `storageFileExists` (an unlocked `lstat`), and the existing-image shortcut then hands out the marker. The Invariants of `docs/structure/self-host-server.md` say every server reuse of an asset key goes through `claimAssetKey`. Low risk today: an existing inlay record keeps its asset in the sweep's re-mark, and A1 (inlay-id claims) protects the record itself, so the file cannot be a deletion candidate while the record exists. Found in the Implementation Audit Fixes run (2026-11-05, slice A1).

**Why it matters:** a guide invariant with one known exception; a later sweep change could make it a real race.
**Suggested handling:** if `isImageInlay` is touched again, use `claimAssetKey(savePath, meta.asset, { verify })` and keep the post-await fence.

### The inlay recognizer is quadratic on unterminated openings

Excluded as an edge case by the Implementation Audit Fixes plan (2026-11-05): it needs a string with thousands of `{{inlay::` openings and no terminator, and ordinary text has one or a few. `recognize` in `server/src/data/assetLifecycle.ts` (~124) searches for a closing `}}` separately from each opening, so `"{{inlay::".repeat(n)` costs about n² (the audit measured 0.9 s at 144,000 bytes). The SQL prefilter admits such a value, and both the chunked scan and the deletion recheck run it in one synchronous turn. Source: [AL5](../manual-audit/archive/asset-lifecycle-code-audit-2026-11-05.md#al5--malformed-inlay-text-makes-the-server-scanner-quadratic).

**Why it matters:** one stored string of incomplete markers can block the server's event loop during a scan or a sweep.
**Suggested handling:** a linear recognizer is a small change if `recognize` is touched: match the three prefixes and their terminators in one pass, and stop when the remaining suffix has no terminator, without truncating real references.

### A custom-key asset can change during a version-2 export

Excluded by the Implementation Audit Fixes plan (2026-11-05) as an unverified lead; the audit asked for a coordinated export-and-replace reproduction first. A version-2 export (`server/src/routes/backups.ts`) records asset paths and opens them later while streaming; the export hold protects them from lifecycle deletion but not from a custom-key write in `server/src/routes/storage.ts` (the staged `rename`, ~265) replacing the file, so the archive could pair its database copy with later bytes. Verified content-hash keys cannot change this way. Source: [the additional lead](../manual-audit/archive/asset-lifecycle-code-audit-2026-11-05.md#additional-lead--mutable-custom-keys-can-change-during-export).

**Why it matters:** an export taken while a plugin or script rewrites a custom-key asset may not be a consistent snapshot.
**Suggested handling:** pause an export before it opens such an asset, replace the asset through the normal write path, and inspect the archive; then decide what consistency custom keys promise.

### Upstream swipe import edge cases

Excluded as edge cases by the Implementation Audit Fixes plan (2026-11-05). All three are in the swipe conversion of `server/src/data/upstream/importCharacters.ts` (~617–698):

- The missing-inlay report (`inlays-not-in-backup`, ~524) scans only `message.data`, so an alternate swipe referencing an image the backup lacks is kept but not reported. Needs an upstream backup whose non-selected swipes reference missing images; the selected text is reported. Source: [RC4](../manual-audit/archive/reroll-candidates-2026-11-05.md#rc4--the-import-report-misses-unavailable-inlays-in-retained-candidates).
- Every foreign swipe becomes a candidate before `trimCandidates` (~696) removes the oldest one at a time with `splice` (`shared/rerollCandidates.ts` ~241–253): quadratic over 1,000 swipes on one message, where the live ring holds 17. Source: [RC7](../manual-audit/archive/reroll-candidates-2026-11-05.md#rc7--importing-many-foreign-swipes-repeatedly-shifts-almost-the-entire-array).
- A malformed native `candidates: []` beside valid foreign `swipes` sets `hadCandidates` (~626), so swipe conversion is refused and the alternate texts are dropped; the audit's own "narrow import edge case". Source: [the import edge case](../manual-audit/archive/reroll-candidates-2026-11-05.md#additional-narrow-import-edge-case).

**Why it matters:** an undisclosed missing image behind a later swipe, a slow import of a message with thousands of swipes, and lost alternates from a malformed file.
**Suggested handling:** if the importer's report or conversion is touched: scan `candidates[].data` once per chat for the report, keep the selected entry plus a bounded newest window before building candidates, and test the normalized `candidates` field before refusing swipe conversion.

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

`server/src/prompt/transform.ts` refuses a two-call (tab plugin handler) target whose snapshot charge passes `MAX_SNAPSHOT_BYTES` (8 MiB, :54). Since the [cross-plan review's DT1 fix](../manual-audit/archive/cross-plan-2026-10-29.md#dt1--a-permanent-display-failure-retries-and-toasts-every-round) (94856bdc2) a scope over the limit alone fails `permanent` (shown raw until its source or context changes), while a refusal the request's other targets caused is a plain failure that `src/ts/parser/displayTransformRecovery.svelte.ts` retries after 5 s with only the failed rows, so the earlier claim that such rows stay raw until a remount no longer holds. What is left is the measurement: when Display Evaluation Slice 3 measured it (2026-10-28), a 2,000-message chat of about 6 MiB charged about 6.7 MiB per scope, so only 30–38 of a 64-target chunk fit; Slice 4 then excluded the shared display entries from the per-snapshot charge (`exclude: entries`), so that number is likely smaller now. Not re-measured since.

**Why it matters:** users with display plugins and long chats may still see a round of raw rows before the retry, and a scope whose own charge is over the limit stays raw.
**Suggested handling:** re-measure on a realistic large chat with handlers (`util/playwright/measureTransformLua.mjs` has the shape); if a scope alone still passes the limit on realistic chats, raise the limit or charge the transcript once per scope.

### More than one transform chunk is in flight at a chat switch

The Render Work Budget comparison run ([audit](../audit/render-work-budget-2026-11-05.md#acceptance-after-slices-14), 2026-11-05) met "no transform target sent after a switch" but not "in-flight ones at most one chunk": switching away 100 ms after all rows mounted left 1 / 2 / 4 `/api/transform` requests (1 / 45 / 171 targets) in flight at 30 / 150 / 600 rows. Every one had been sent before the switch and all but one ended `net::ERR_ABORTED` when the last subscriber left (`src/ts/parser/transformClient.ts`); at 600 rows unmounting the rows held the main thread for about 370 ms, so one 42-target request answered first and ran to completion. How many targets cross depends on where the switch falls in the send burst (the first after run: 0 / 49 / 78).

**Why it matters:** the server still evaluates several chunks nobody will show after a switch on long chats; the cancellation arrives only after the unmount work.
**Suggested handling:** owner decision whether the plan's one-chunk bound matters; if it does, cap the chunks in flight per chat, or abort a chat's transform subscriptions when the screen leaves the chat, before the rows unmount.

### A single combined paragraph is written back as HTML

`src/ts/translator/translator.ts` `translateHTML`, the combineTranslation branch (~617, `node.innerHTML = sentences[0]`): the single-sentence case assigns `getNodetextToSentence`'s decoded text as HTML, while the multi-sentence case uses `textContent`. So `<p>&lt;b&gt;x&lt;/b&gt;</p>` becomes a real `<b>` before translation. Seen while doing the Found Issues Sweep's E3 (2026-11-05), not run in the app; whether a later sanitizer catches injected markup (`<img onerror>`) was not checked. Owner: translation.

**Why it matters:** escaped text can become live markup on the rendered translation path.
**Suggested handling:** confirm the sanitizer order in `ChatBody`, then use `textContent` like the other branch.

### An aborted first transform call can leave its snapshot counted

`src/ts/parser/transformClient.ts` `postOnce` (~521) and `releaseChunkSnapshot` (~682), the per-tab two-call admission: when whole-chunk cancellation aborts the first `/api/transform` fetch before its response headers arrive, `snapshotGone` keeps its initial `true`, so the chunk releases its permit at once. If the server had already stored the snapshot and was sending the answer (its abort link is cut once `transform` returns, `server/src/prompt/transform.ts` ~900), that snapshot stays until its 30 s TTL and still counts toward `MAX_TRANSFORM_SNAPSHOTS_PER_CLIENT` (4), so the next admitted chunk can evict a live one (`SnapshotExpired`, a raw row, one retry round). Accepted as an edge by the Implementation Audit Fixes run's R4 (2026-11-06) to avoid holding a permit 30 s on every ordinary scroll-away abort; server memory-pressure eviction and the global snapshot cap across tabs are not covered either (noted in the module header).

**Why it matters:** heavy scrolling with plugin handlers can show raw rows and a retry round.
**Suggested handling:** if `SnapshotExpired` shows up under heavy scrolling, drop an unclaimed snapshot on the server when its request signal aborted after return, or release by a client-chosen snapshot id.

### The experimental Google translator does not check the status

`translateMain` in `src/ts/translator/translator.ts`, the `useExperimentalGoogleTranslator` branch (~500–523, a `globalFetch` of `translate.google.com/m`): it parses `d.data` and returns the `.result-container` text without checking `d.ok`, and any error falls through to the direct adapter silently. The direct Google adapter rejects HTTP and shape errors as transient since the Implementation Audit Fixes run's R1 (2026-11-06), but an error page that still carries a `.result-container` would be cached as a pair by `translate`. Found in that run (slice R1). Owner: translation.

**Why it matters:** the same cache-poisoning class as the direct adapter's fixed 429 case, reachable only with the experimental toggle on.
**Suggested handling:** check `d.ok` before parsing when touching that branch.

### The pair cache evicts a pair with the same translation

`writeMemoryCache` in `src/ts/translator/translator.ts` (~83) drops the existing pair when a different source produces the same translation (`memoryCacheByTrans`). Two paragraphs that translate to identical text evict each other, so a later render (e.g. `ChatBody`'s retry) requests one of them again. Found by the R2 challenger of the Implementation Audit Fixes run (2026-11-06) with a deferred-fetch probe; it predates R2. Owner: translation.

**Why it matters:** repeated short lines ("Yes.", "...") in rendered translation cost extra provider requests per render.
**Suggested handling:** reverse lookups need the by-translation map, so a fix must first decide which origin a reverse lookup returns.

### A provider switch during a translation caches a mixed result

`translateShared` in `src/ts/translator/translator.ts` (~226) keys a producer by `memoryTranslationContext().key`, but `runTranslator` (~329) and `translateMain` (~399) reread `settings.memoryTranslateMedia` (provider type, the DeepLX URL after its wait) for each `translateProtectingLines` chunk. Switching DeepL → DeepLX → DeepL during one multi-chunk producer passes the final key guard, so the mixed result enters the pair cache and every joiner gets it. Switching through `llm` mid-run also bypasses the `failure` object (passed to `translateMain` only on the exclude-thoughts path), so an LLM failure can still be cached. Found by the R1 challenger of the Implementation Audit Fixes run (2026-11-06); pre-existing, now shared with joiners. Owner: translation.

**Why it matters:** needs a settings change during one in-flight request, an edge class the run excluded.
**Suggested handling:** if `runTranslator` is reworked, capture the provider settings once per producer and use them for the key and every chunk.

### A withdrawn forced refresh can leave its replacement on the old cache

Excluded as an edge case by the Implementation Audit Fixes plan (2026-11-05): it needs a Re-render whose target is withdrawn while a sibling keeps the chunk alive, and a same-input replacement created before the result lands. In `src/ts/parser/transformClient.ts` the bypass (`noCacheNext`, ~178) is consumed when the operation is created and restored only on withdrawal before dispatch or a whole-chunk cancel (~325); a dispatched target withdrawn from a surviving chunk loses it, so the replacement sends `noCache: false`, cannot join the forced operation, and can read the server's old cache entry (`server/src/prompt/transform.ts` invalidates when processing reaches the forced target, not at admission). Source: [RW3](../manual-audit/archive/render-work-budget-2026-11-05.md#rw3--a-departed-forced-refresh-can-leave-its-replacement-using-the-old-server-cache).

**Why it matters:** a requested Re-render can show the previous cached result after paying for a fresh one.
**Suggested handling:** keep the forced intent until a live consumer receives its result, or let a same-generation replacement join the forced operation, without reviving the bypass for a superseded generation.

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

A single row is outside the page budget too: the planner (`src/lib/ChatScreens/screenshotExport.ts` ~79–87) puts a row over `MAX_EXPORT_PIXELS` (64 M pixels) on its own page without reducing its area, as the module header allows, so a row about 2,400 CSS pixels wide and 8,192 tall at DPR 2 allocates a 300 MiB source and a 300 MiB page. The Implementation Audit Fixes plan (2026-11-05) excluded that as an edge case, to be taken with this investigation. Source: [RW4](../manual-audit/archive/render-work-budget-2026-11-05.md#rw4--a-single-oversized-screenshot-row-bypasses-the-page-memory-budget).

**Why it matters:** a 600-row export still costs about 4 GiB of renderer memory, enough to crash a tab on phones.
**Suggested handling:** take a heap snapshot and `VmHWM` per page during a 150-row export to find what scales with rows, then release it per page; for the single row, enforce area before capture with the same scale in planning and capture, or tile it.

### /multisend keeps its quotes

`/multisend "one|||two"` sends `"one` and `two"`: `processPinnedCommands` in `src/ts/process/command.ts` (~75–90) splits the line on `|` outside double quotes but keeps the quote characters, and `commandParser` (~360) joins the arguments verbatim. The unquoted form is split by the pipe parser (`["/multisend one", "", "", "two"]`), so the quoted form is the only one that works. `src/ts/process/command.test.ts` (~445) pins `'"one'`. Server twin: `server/src/prompt/commands.ts`. Found by the Found Issues Sweep's B1 (2026-11-05). Owner: chat-pipeline.

**Why it matters:** every use of the documented example sends stray quotes in the first and last messages.
**Suggested handling:** strip one pair of surrounding quotes from a command argument on client and server, and update the pinned test.

### Repeated screenshot exports grow the live stylesheet

The Implementation Audit Fixes run's R6 (d94380fa5, 2026-11-06) prepares the font CSS once per export (`prepareScreenshotCapture` in `src/lib/ChatScreens/screenshotCapture.ts`, ~12–26, `getFontEmbedCSS` on the rows' common ancestor). html-to-image still re-expands a surviving `@import` into the live stylesheet once per call, so one export adds no duplicates but each later export adds one more copy of those rules; library behavior. Also unmeasured: the driver fixture (`util/playwright/measureRenderWork.mjs`) has no `@import` webfont, so R6's measurement does not show the per-row cost it removed for such fonts. Found by R6.

**Why it matters:** a session that exports many times keeps growing the document's rules for an `@import`ed font.
**Suggested handling:** if it matters, inline or drop the `@import` rules before calling `getFontEmbedCSS`, or remove the added copies after each export; add an `@import` webfont to the fixture before measuring.

## Client and plugins

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

### Scheme writers skip the text theme

`src/ts/gui/colorscheme.ts` `changeColorScheme` (~217) and `updateCustomColorScheme` (~226) call only `updateColorScheme()`, but `updateTextThemeAndCSS` (~310) picks the `standard`/`highcontrast` font colors by `settings.ui.colorScheme.type`; the plugin API's `setColorScheme` (`src/ts/plugins/apiV3/v3.svelte.ts` ~2297) has the same omission (`changeColorSchemeType` calls both). A probe saw a light scheme keep the dark text color (`--FontColorStandard` `#fafafa`). Found by the D2 challenger of the Found Issues Sweep (2026-11-05). Owner: ui-theming.

**Why it matters:** switching from a dark to a light preset leaves light text on a light background until the text theme is touched or the page reloads.
**Suggested handling:** call `updateTextThemeAndCSS()` after `updateColorScheme()` in those writers.

### Local ui writers skip the display apply

The Found Issues Sweep's D2 re-applies the display only for remote `ui` records (`watchRemoteRecords` in `src/ts/bootstrap.ts`). Applying a recovered `ui` draft (`src/ts/storage/journalRecovery.ts` ~901) replaces the record and updates the language but calls none of `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, `updateGuisize`, and fires no `onRemoteRecordApplied`; the generic plugin database setters (`src/ts/plugins/apiV3/v3.svelte.ts` ~1701) can write display fields of `settings.ui` without applying them. Found by the D2 challenger (2026-11-05). Owner: ui-theming.

**Why it matters:** the page shows a theme or size that differs from its settings until a reload.
**Suggested handling:** run the same apply step D2 runs for remote records.

### #import_preset opens the settings after a refusal

`src/ts/characterCards.ts` `characterURLImport`, the `#import_preset=` branch (~860): it ignores `importPreset`'s return and always opens the prompt settings, while the drop, launch-queue and `#share_preset` paths act only on a returned id. A refused `.risup` (`errors.unsupportedPreset`) shows the refusal and then the settings page opens anyway. Found by the Found Issues Sweep's A1 (2026-11-05). Owner: characters-modules.

**Why it matters:** low; the user lands on a settings page for a preset that was not imported.
**Suggested handling:** gate `SettingsMenuIndex`/`settingsOpen` on the returned id.

### A stray }} ends CBS highlighting

`src/ts/gui/highlight.ts` `simpleCBSHighlightParser` (~358–478): the `}}` branch does `depth--` without a floor. Text such as `}} {{char}}` (a JSON snippet in a prompt or lorebook editor) leaves `depth` at -1; the next `{{` raises it to 0, which `checkHighlight` skips, so `{{char}}` and every later call stay unhighlighted. Writes at index -1 are dropped silently. Found by the Found Issues Sweep's C1 (2026-11-05). Owner: cbs-rendering.

**Why it matters:** editor highlighting disappears for the rest of the text after one stray close pair.
**Suggested handling:** clamp the depth at 0 (ignore an unmatched `}}`).

### Inlay explorer hard-codes two strings

`src/lib/Playground/PlaygroundInlayExplorer.svelte` renders the card `Delete` button label (~250) and the load-more `Loading...` (~258) as literal English, while the rest of the component reads `language.playground.*`. Found by the Found Issues Sweep's J1 (2026-11-05).

**Why it matters:** STRUCTURE.md U2; non-English users see English there.
**Suggested handling:** move both to `language.playground` keys; `PlaygroundInlayExplorer.test.ts` finds the button by the text "Delete", so update that lookup.

### JSON and V3 card imports keep base64 text until the save ends

`saveAssets` (`src/ts/storage/assetQueue.ts` ~268) keeps every canonical item's `load` until its final presence pass. The Implementation Audit Fixes run's A4 (de86f0225, 2026-11-06) made PNG cards from a Blob replay byte ranges, but two import paths in `src/ts/characterCards.ts` still capture the encoded string in that closure: `saveEmbeddedAssets` (~1106, `Buffer.from(value, "base64")`, JSON cards with embedded assets) and V3 `data:` URI assets (~1271, `Buffer.from(b64, "base64")`). Found while landing A4. Owner: assets.

**Why it matters:** a large JSON card keeps all of its assets' base64 text (about 4/3 of the decoded bytes) alive until the whole save finishes.
**Suggested handling:** raise on a JSON or V3 card import memory complaint; the text is a JSON string in hand with no byte range to reread, so a fix drops references from the card object or decodes up front under the queue's byte cap. The PNG stream path keeps the same retention by owner decision (`assets.md` Known Hazards).

### Bulk plugin character adds stay quadratic

`addPreparedCharacter` in `src/ts/storage/characterStore.svelte.ts` (~232) runs `indexOf` (~73, a `findIndex` over the list), then `insertCharacterRecord` → `requireNewId` (`src/ts/storage/records.svelte.ts` ~3079, `list.some`), then `checkCharOrder()`, once per added character. The Implementation Audit Fixes run's P4 (2026-11-06) made `applyPluginCharacters` (`src/ts/plugins/apiV3/v3.svelte.ts` ~1704) index existing characters once, so a round trip with no new characters is linear, but a `setDatabase` that appends N characters still costs N × list inside these helpers. Also in `v3.svelte.ts`: `getChatFromIndex` (~2597) and `setChatToIndex` (~2708) resolve one id with `chatList(chaId)[chatIndex]?.id`, building every member's list entry for one lookup, where `chatMemberPage(chaId, i, i + 1)` would not. Found during P4.

**Why it matters:** bulk character imports through the plugin API, and per-index chat accessors on characters with many chats.
**Suggested handling:** take it when the character add path or those two accessors are next touched.

### A memory algorithm switch during a detached read omits its projection

Excluded as an edge case by the Implementation Audit Fixes plan (2026-11-05): it needs a memory-algorithm settings change between the server's response and the client's assembly of one plugin read; one incorrect read, nothing stored. The detached `getDatabase` read in `src/ts/plugins/apiV3/v3.svelte.ts` checks cache hits against the current algorithm (`detachedChatCache.ts`), but a fresh response keeps the algorithm captured before its await; final assembly can remove a sealed projection when leaving Structured Memory but cannot add one when entering it, and `refreshChatProjections` (~1063) serves loaded chats only. Source: [PS2](../manual-audit/archive/plugin-storage-data-api-2026-11-05.md#ps2--switching-to-structured-memory-during-a-detached-read-omits-its-projection).

**Why it matters:** a plugin reading across the switch gets no `hypaV3Data` for an unloaded chat while a loaded chat has it.
**Suggested handling:** fence fresh detached responses by the captured algorithm as cache hits are, and retry or refresh when it changed; test both switch directions.

### The sandbox bridge drops an own `__proto__` key

Excluded as an edge case by the Implementation Audit Fixes plan (2026-11-05): it needs a plugin to store an object with a key spelled `__proto__`. The bridge copy helpers in `src/ts/plugins/apiV3/factory.ts` (`replaceStreamsWithPorts` and the guest and reconstruction helpers, ~232, ~281, ~825, ~907) rebuild plain objects with `const out = {}` and `out[k] = …`, so an own `__proto__` key sets the copy's prototype and is lost in the structured clone. The storage layer keeps such keys, so direct API tests do not see it. Source: [U1](../manual-audit/archive/plugin-storage-data-api-2026-11-05.md#u1--the-sandbox-drops-an-own-__proto__-field-from-returned-json).

**Why it matters:** a `pluginStorage.getItem` value can come back without a field it was stored with; not prototype pollution.
**Suggested handling:** define own properties (`Object.defineProperty` or a null-prototype object) in every bridge copy helper, and test a round trip through the guest bridge.

### Fallback media object URLs outlive the blob cache

Deferred by the Implementation Audit Fixes plan (2026-11-05): the fix needs a lifetime design on a fallback path. Without a capable controlling service worker, `getInlayObjectUrl` in `src/ts/process/files/inlays.ts` keeps every audio and video object URL in `mediaObjectUrls` (~544) for the page's life, so a blob the 64 MiB `blobCache` evicted stays retained (the audit's probe: nine 8 MiB items, 72 MiB held). The existing comment explains why revoking on blob-cache eviction breaks cached renders. This is the `mediaObjectUrls` part of the pinned-URL item in "Stop B leftovers". Source: [U1](../manual-audit/archive/asset-lifecycle-code-audit-2026-11-05.md#u1--fallback-audiovideo-object-urls-bypass-the-blob-caches-memory-bound).

**Why it matters:** on a page no worker controls, media memory grows with every distinct item played, past the cache's budget.
**Suggested handling:** a design of its own: track URL ownership by rendered media and cached HTML, and release unowned URLs under a byte budget.

## Build, drivers, and e2e

### checkJobProtocol's first run after a source change fails its SIGKILL case

`util/playwright/checkJobProtocol.mjs`: the first run after a source change failed `sigkill-before-checkpoint` with "waiting for navigation to finish" (the page rebooted about 6 s after the SIGKILL restart); the next two runs passed every case. Likely Vite's dependency-optimization reload of the dev stack. Found 2026-10-29 by the Job Protocol audit's verification; not reproduced.

**Why it matters:** a first run on a fresh tree can report a protocol failure that is the dev server's reload.
**Suggested handling:** if it recurs, have the driver wait for Vite's optimization to settle before the case (`openApp` already answers the prompt again after a reload), or run the dev stack once before the cases.

### A chat-open suggestion request bumps the chat revision

`src/lib/ChatScreens/Suggestion.svelte` `requestSuggestions`: with `useAutoSuggestions` on, opening a chat without suggestions requests them and stores the answer through `setChatMeta`. That write moves the chat's revision, which is part of the transform key (`server/src/prompt/transform.ts` `baseKey`), so the rows just rendered miss the cache on the next return to the chat: full answers instead of `same`, and a `{{random}}` row changes its text. Seen in an `e2e/serverTransform.spec.ts` trace on 2026-10-30, when `perChatSends` left the setting on; not checked by hand. An empty answer over a chat with no suggestions no longer writes, so what is left is a real answer.

**Why it matters:** with auto suggestions on, the first return to a chat after new suggestions downloads and re-runs what the tab already holds.
**Suggested handling:** decide whether a non-render chat field such as `suggestMessages` should move the transform key at all; the chat revision is also the key's fence against mixed-revision results, so this needs its own design.

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

### checkServerSend once hit an alert after its mid-stream reload

On 2026-11-05 (Incremental Chat Transport Slice 5, code at `f906c864e`) the first `node util/playwright/checkServerSend.mjs` passed 11 checks, then `openCharacterChat` after the "reload in the middle of a slow stream" step (~340) timed out because a `[data-alert-dialog]` overlay covered the sidebar. The run overlapped a `docker build`; four reruns passed 19/19, two of them logging no alert after the reload, and the base `9bf28c429` passed 19/19. The alert text was not captured. Candidates: the automatic safe-boot notice (the driver does not clear safe-boot attempts) or an error alert from the owner's resync after the reload.

**Why it matters:** if it recurs it may be a real owner-reload problem, not harness noise.

**Suggested handling:** if it shows again, print the dialog text before `openCharacterChat` to tell the two apart; consider clearing safe-boot attempts in the driver.

### docs:contracts crashes on EPIPE under head

`pnpm --silent docs:contracts <file> | head -3` prints the first lines, then Node's `Error: write EPIPE` / "Unhandled 'error' event" stack from `util/docsContracts.mjs`'s command-line block, which writes to `process.stdout` with no `error` handler. Other `util/docs*.mjs` tools may share it. Seen 2026-11-05.

**Why it matters:** agents pipe these tools into `head`; the stack looks like a tool failure and costs a second call.
**Suggested handling:** ignore `EPIPE` on `process.stdout` in the command-line blocks.

## Guides

### The non-fencing refusal list misses memoryRebuilding

`docs/structure/chat-pipeline.md` (~194) lists the generation-create refusals that do not fence an unanswered create (`503`, `chatBusy`, `chatBindingIncomplete`, `chatLoreOverrideOrphaned`). The Found Issues Sweep's I1 (9440f4ccd, 2026-11-05) added `409 { error: "memoryRebuilding" }`, which `serverCommands.ts` `admissionRefused` also treats as non-fencing; the list was not updated.

**Why it matters:** low; the list does not claim to be complete, but a reader checking the non-fencing codes misses one.
**Suggested handling:** add the code, paid with a trim in the same paragraph.

## Test timing

### Gate tests still racing real time

Untagged gate tests that depend on real wall-clock or scheduler time (invariant V3), noted by the [cross-plan review](../manual-audit/archive/cross-plan-2026-10-29.md#test-quality) on 2026-10-29; none failed in its runs. `src/ts/storage/tests/draftJournal.test.ts`: the start and adoption cases (the live-owner case near "leaves a live owner's rows alone" and the owner-reload case) call the real journal with its production 3 s open/seed and 5 s recovery-lock deadlines, and the file's blanket fake-timer comment does not hold for them. `server/src/tests/hypaV3Parts.test.ts`: selection and deferral cases built with `hostOf` run under the real 5,000 ms cumulative separator budget. `server/src/tests/transformService.test.ts`: `heldCount` polls with a real `setTimeout(2)` (up to 500 polls) and a 5 ms real sleep observes shutdown. `server/src/tests/transform.test.ts`: the real-worker route cases outside the cache describe's fake clock race worker, CBS, and transform deadlines (`SLOW = 60_000` is a timeout, not a `slow` tag). `src/ts/storage/tests/bootCacheServer.test.ts` (around the cases near lines 185 and 485 at that time): the real 3 s cache deadline with asynchronous IndexedDB work. Real sleeps: `server/src/tests/push.test.ts` (delivery and queue synchronization). `src/lib/ChatScreens/Chat.draft.test.ts`: the auto-popup cases wait for the first row with real `vi.waitFor` before faking timers. `src/ts/network/generationJobs.test.ts` and `src/ts/process/serverCommands.test.ts`: zero-delay real-timer `flush` helpers (28 and 106 calls) as synchronization. Re-checked 2026-11-03: behind mocks that resolve at once these flushes are close to deterministic; the load-sensitive part left is the `generationJobs` `startFollow` cases outside fake timers, which race the real connect timeout. `server/src/tests/testSupport.ts` `waitFor` without `timeoutMs` has no deadline of its own and is not one of these.

**Why it matters:** each is a load-sensitive failure waiting for a slow CI runner; the timing plans' policy (`docs/structure/test-harness.md` `Tests`) asks for controlled clocks or the `slow` tag.
**Suggested handling:** when one of these files is next touched, control its clock (inject the deadline or fake the timers) or tag the case `slow`; `pnpm --silent test:agent --slow-tests` lists the ones over 1 s.

## Structured Memory

Moved from the Structured Memory plan run on 2026-11-03. Each entry was re-checked against the run's last tree that day; the guides' Known Hazards hold the limits the owner accepted, so they are not repeated here. The last five entries came from the Implementation Audit Fixes run (2026-11-05/06); the last two are its excluded audit findings.

### Panel writer line and stale views

In `src/ts/process/structuredMemory.svelte.ts` and `StructuredMemoryPanel.svelte`:

- A checkpoint load refreshes the chat resource but not the panel's contents, so an open panel shows the records from before the load until refreshed. A stale edit is refused 409, so nothing is lost.
- A copied or branched chat keeps `generationInfo.memory` while its runs stay behind (`structured/inherit.ts`), so a copied paused receipt can offer Resume on an empty Log.
- `pressReset` reads the chat again only on `reset: true`. When the route committed but the answer was lost, the repeat answers `reset: false`, and the tab keeps the old value until the feed's notice comes.

**Why it matters:** the panel says something untrue until a refresh or a send.
**Suggested handling:** a refresh on the chat's change frame, stripping copied receipts (or ignoring run-less ones), and reading on any reset answer.

### Cast slice matches substrings

Narrowed by the Chat Store and Structured Memory Sweep's B4: the writer's cast (`castSlice`) and the read path now share `pageNamedInTexts` (`server/src/prompt/memory/structured/pages.ts`, lore's plain-key matching), so they agree on "named". Neither has a word-boundary rule: an alias "Al" still matches "also", and `searchMatch`'s `fullWordMatching` misses multi-word titles and punctuation.

**Why it matters:** an extra prompt row, never a wrong record.
**Suggested handling:** a word-boundary rule for both paths together (the sweep plan's Deferred "Named-page matching").

### Projection refresh leftovers

Left by slice 5g. The `chatOutput` payload (`src/ts/network/jobChannel.ts`) copies held chats with no projection refresh.

**Why it matters:** a stale payload.
**Suggested handling:** recorded in `structured-memory/projection.md` by the sweep plan's C1.

### Adopted summaries

Left by slice 6a. An adopted summary's `pinned` selects nothing in any lane (`adopt.ts` maps `isImportant` to it; `retrieve.ts` and `step.ts` never read it). A summary over the card budget is excluded while its messages still leave the prompt. A stored-stale adopted event kept by a person reads active while retrieval answers `not-relevant`, and a copy drops any event with an unanchored source.

**Why it matters:** an important HypaV3 summary stops being sent every time.
**Suggested handling:** decide what `pinned` means for an adopted event before changing the lanes.

### Highlight and revert leftovers

Left by slice 7b; the dead `retract` kind left in the Found Issues Sweep (I3). A new page's receipt row has no revert.

**Why it matters:** a receipt row whose change cannot be undone from the receipt.
**Suggested handling:** recorded in the guides by the sweep plan's C1.

### Page tool leftovers

Left by slice 7d. `contents.trash` has no budget or expiry and the table of contents grows with it.

**Why it matters:** a trash that only grows.
**Suggested handling:** decide on a trash bound.

### Evaluation findings

Measured by slice 8 on scripted fixtures (`docs/audit/structured-memory-2026-11-03.md`); nothing was changed, and Q2 stays open until a real A/B.

- `MEMORY_CALL_OVERHEAD_TOKENS` (1,500) is low: overhead was about 2,100 per call in English and 2,800–3,700 in Korean, and actual analysis input was 1.13–2.32 times the preview. Proposal: 3,000, bytes÷3 kept, after a real-model check.
- `selectMemory` takes 520–584 ms on a 1,000-turn send, mostly tokenizing (296–356 ms) and cache reads; `addText`'s quadratic scan costs 60 ms at 4,000 texts.
- An unchanged checkpoint save holds about 500 ms on a 2,000-run chat. A hash cache is not worth it; dropping `input` from recorded runs is (whole-row readers not traced).
- `getChatFromIndex` over 67 or more loaded chats spends the shared per-IP authenticated bucket, and a neighbour route was refused until the reset (loopback surrogate only).
- At a 16k context the `threads` lane starves once events carry three quotes, and a two-event comparison loses one event in a long chat, also at 32k.

**Why it matters:** cost previews people pay by, and stalls on long chats.
**Suggested handling:** take each as a proposal when Structured Memory is next touched, and re-run `node util/memoryEval.mjs` after a read-path change.

### The final token recheck drops history evidence never sees

The "token rechecking" step of `server/src/prompt/assemble.ts` (~2501–2538, after scripts and `editRequest`) can remove further removable raw history entries when the formatted prompt is over `maxContextTokens - maxResponse`. Structured Memory's evidence lane widens its pool only to what `selectMemory` (`server/src/prompt/memory/structured/step.ts` ~308–363) itself trimmed, so an uncovered message the later recheck drops leaves with no excerpt, and its gap is not in `gapTokens`. Found by the M5 challenger of the Implementation Audit Fixes run (2026-11-06); not reproduced on a real send. Related: the late removable-message cleanup in "No-memory trim question gaps".

**Why it matters:** a silent loss of the kind M5 fixed, on a later path; it needs scripts or `editRequest` to grow the prompt past what selection measured.
**Suggested handling:** raise when the recheck or the read path is next touched; the recheck could hand its removals back to the evidence lane or count them as a gap.

### Rebuild drops retained imported threads' participants

Excluded as an edge case by the Implementation Audit Fixes plan (2026-11-05): it needs imported or manual thread data with a `who` list, and no screen creates threads. A rebuild (`server/src/prompt/memory/structured/rebuild.ts`) omits an unmarked page from its seed but keeps an imported thread verbatim, and the swap removes the old page without remapping the thread's `who`; retrieval (`retrieve.ts`) then rejects the thread as `not-relevant`, since it names the old page id. The existing preservation test uses `who: []`. Source: [C6](../manual-audit/archive/structured-memory-2026-11-05.md#c6--p3-retained-imported-threads-lose-their-participant-identities-during-rebuild).

**Why it matters:** an imported personal thread stops reaching the prompt after a rebuild, and the panel cannot repair its `who`.
**Suggested handling:** keep the identities retained threads need, or remap their references at the swap; test with a non-empty `who`.
