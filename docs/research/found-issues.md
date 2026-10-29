# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's Known Hazards `Issues` (or `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), and 2026-10-27 (single entries). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (2)
- [Save journal and recovery](#save-journal-and-recovery) (8)
- [Server jobs and prompt assembly](#server-jobs-and-prompt-assembly) (4)
- [Display transform](#display-transform) (3)
- [Assets and imports](#assets-and-imports) (1)
- [Chat screen and input](#chat-screen-and-input) (2)
- [Test mocks](#test-mocks) (4)

## Chat store, sync, and change feeds

### Parked resends leak

`src/ts/storage/chatStore.svelte.ts` `dropCharacterWork(id, false)` from `takeChatWork`'s absent-character sweep (~3505, the quarantined-create path) parks in-doubt resends (`parkResends`); no deletion acknowledgement or `forgetCharacter` ever comes for a character the server never had, so the entry stays until `seedChats` (boot) or a re-add of the same id, which would replay a harmless resend first. Accepted trade-off of open-bug-fixes slice A3 (landed on metatron 2026-10-19 via plan-runner), noted by its Fable reviewer. Still present 2026-10-21 (`parkedResends`, chatStore.svelte.ts ~180).

**Why it matters:** tiny memory leak per session; a far-later same-id re-add sends one extra replay.

**Suggested handling:** if it matters, drop parked resends once the adapter knows the abandoned character has no server incarnation and no unresolved create can still establish one, and also clean entries parked in an earlier cycle. `persisted` alone is not that proof: a removed character whose create answer was lost is resent while `persisted` lacks it (resourceSync.svelte.ts ~1387), and a same-id re-add still needs the preserved group ids (checked 2026-10-24). Parked payloads can hold whole chat snapshots, so the leak is not always tiny.

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

## Save journal and recovery

Found during the Durable Drafts plan run (2026-10-28 to 2026-10-29; archived, `git show bbc747f24:docs/plan/durable-drafts.md`); each was outside the slice that noticed it.

### Journal close drops a same-tick call

`src/ts/storage/draftJournal.ts` `close()` (~:1773) sets `closed` before draining, so a `write`/`remove` admitted in the same tick that has not yet reached `withDatabase`'s `closed` check fails as `unavailable` instead of being drained; only calls that reached their transaction are drained. The close tests flush two microtasks first. Flagged as minor by the Fable re-verification of Slice 1.

**Why it matters:** the reload seam (`stopResourceSync`) and the restore snapshot call `close()` right after queuing work; a write queued in the same tick could be dropped.
**Suggested handling:** let `close()` admit tracked calls that were already issued before flipping `closed`.

### Uncloneable journal values fail silently

`draftJournal.ts` `write()`: an item whose layers fail `structuredClone` (a Svelte `$state` proxy, a function) answers `"failed"` with only a `console.warn`: no `sync` `journalFailed` event and no fence for its layers. Callers pass plain snapshots today. Noted in Slice 1.

**Why it matters:** a proxy slipping into a new caller would stop journaling that target with no diagnostics trail.
**Suggested handling:** add a `journalFailed` reason for an uncloneable value, or clone through `$state.snapshot` at the boundary.

### removeDraft resolves on a failed delete

`draftJournal.ts` `removeDraft` (~:1602) catches every error, reports `journalFailed`, and resolves `undefined`; it also resolves as a no-op when the journal is off or closed. The recovery dialog (`recoveryDrafts.remove`, used by Discard and by `applyRecoveryDraft` after a confirmed save) drops the row from the view anyway, so a failed delete brings the draft back at the next boot. After an Apply, the same intent can then be applied twice. Noted while building the dialog (Slice 5).

**Why it matters:** a duplicated apply of a recovered edit, with no error shown.
**Suggested handling:** make `removeDraft` answer whether the row was deleted, and have `recoveryDrafts.remove` keep the row and show an error on failure.

### Character eligibility parses the whole record

`src/ts/storage/journalEligibility.ts` `isJournalEligible` (characters case, ~:94): the fast path only checks `mayHold(text, "apiKey")`, so a character carrying `oaiTTSConfig: { apiKey: "" }` (an export blanks it, `server/src/data/upstream/exportDatabase.ts` ~:697) or the word "apiKey" in lore or prompt text falls through to `JSON.parse` of the whole record. The Slice 3 challenger measured about 120 ms at a 4x CPU throttle for a 5 MiB character, paid synchronously on every journal write of that record (throttled to once per 5 s above 256 KiB).

**Why it matters:** main-thread jank while typing in large TTS-configured characters.
**Suggested handling:** scan each `"apiKey":` occurrence for a non-empty string value before parsing, keeping the one-boundary rule.

### Chat drift check has no disposer

`src/ts/storage/chatStore.svelte.ts` `startChatDriftCheck` (~:6624, dev builds only) starts a `setInterval` and returns nothing to stop it, so `stopResourceSync` (the simulated-reload teardown, Slice 4) cannot clear it; `src/ts/bootstrap.journalRecovery.test.ts` relies on `vi.clearAllTimers()` instead.

**Why it matters:** the reload seam is meant to tear down every module listener and timer; a second boot in one realm runs two drift checks.
**Suggested handling:** return a disposer and call it from `stopResourceSync`.

### A new character's first chat is not journaled at hide

`addCharacter` followed by a page hide journals the character's record create but not its first chat's pending create row; per the Slice 7 test writer, imported first chats are collected only by the save cycle. `bootstrap.journalRecovery.test.ts` ("recovers an undispatched character and its original first chat without a synthetic second chat") hand-writes the chat row. In production, after a crash before the first save cycle, recovery creates the character and `initializeChats` adds a fresh "Chat 1" under a new id, so anything keyed by the original chat id (a composer draft, the selection) no longer matches. Not verified beyond the test writer's note.

**Why it matters:** a composer draft typed into a brand-new character's first chat is orphaned after a crash.
**Suggested handling:** check how `addCharacter` and `normalizeNewCharacter` queue the first chat in `chatStore.svelte.ts` and whether the chat journal's queued layer sees it at hide.

### Ops answered missing drop their content

`ackChatWork` (`chatStore.svelte.ts`) settles by-id ops the server answers as `missing` (the target message is gone, for example deleted by another tab); the next idle refresh replaces the chat, and their local content is gone with no recovery draft, unlike the conflict paths Slice 10 covers. Pinned as current behavior by `src/ts/storage/tests/resourceSyncChats.test.ts` (~:1210).

**Why it matters:** an edit typed into a message another tab deleted vanishes silently; the plan's "keep the local version at every conflict" goal does not cover it.
**Suggested handling:** at acknowledgement, while the group still exists, capture the ops answered `missing` (with their befores) as a draft.

### Reads outside the save adapter have no deadline

Only reads the save adapter issues go through `deadlineRead` (20 s, `src/ts/storage/resourceSync.svelte.ts`); the `resourceClient.ts` read functions take an optional `signal` but have no default deadline. Still unbounded: chat loads (`chatStore.svelte.ts` `loadChat` and unloaded loading), the socket reconcile's `listRevisions` (`src/ts/network/eventFeed.ts` ~:119), character-order repair (`src/ts/storage/characterOrder.ts` ~:221), job callback recovery (`src/ts/network/jobChannel.ts` ~:599), detached export reads (`src/ts/storage/chatEdits.ts` ~:109), and the boot read. Found while landing Slice 2.

**Why it matters:** a stuck read hangs its caller (a chat that never finishes loading, a reconcile that never ends) with no error. It no longer blocks saving.
**Suggested handling:** when touching one of these callers, pass a signal with a bound suited to its payload (a chat load can be large on a slow link, so 20 s may be too short).

## Server jobs and prompt assembly

### Trigger bookmarkNames whole write

`server/src/jobs/chatResult.ts` `applyTriggerChat` merges only `CHAT_META_MERGE_KEYS` (`shared/chats.ts:14`: toolCalls, GLGlobalVariables, scriptstate) entry by entry. Any other dictionary chat field, notably `bookmarkNames` (`shared/database.ts`, `{ [chatId]: string }`), still takes a whole `set`/`unset` from the trigger's copy, so a bookmark name another tab saved during the run would be erased if a trigger copy ever changed that field. Latent: no trigger, Lua, or command effect writes `bookmarkNames` today. Noticed 2026-10-26 (Deep Audit Fixes slice 1).

**Why it matters:** the same lost-update shape as the fixed `scriptstate` case, waiting for a new writer.
**Suggested handling:** if a script API starts writing bookmarks, add the field to `CHAT_META_MERGE_KEYS` (the server validation in `server/src/data/chatStore.ts` rejects other merge keys) and to the client's `applyChatResult` merge path.

### Repeated begin re-acquires a lock

`server/src/jobs/generationJobs.ts` `writeAsJob` (~:914) calls `lock.acquire` for every `begin` op before the store applies the write, and `server/src/jobs/generationLock.ts` `acquire` (:68) does not refuse a generation id the same job already released. `server/src/data/chatStore.ts` treats a `begin` for a message that already exists as a no-op success, so the acquisition is not rolled back. A live job that finished generation G and then sent `begin(G)` again would hold G's lock again, possibly without advancing the chat revision. Latent: the prompt runner mints a fresh UUID per generation (`server/src/prompt/runner.ts`). Found 2026-10-26 by the Deep Audit Fixes slice 8 challenger.

**Why it matters:** the client's feed-lock rules (whole-read lock lists, the revision rule for older copies) assume a released generation does not re-lock a message.
**Suggested handling:** if a reply ever shows locked after its job finished its write, check for a replayed `begin`; a fix would retire released generation ids per job in `generationLock` or refuse a `begin` whose message exists.

### Owner absence bound is not universal

The Job Protocol plan's D6 said a negotiated tab's chat is free within `OWNER_SILENT_MS + OWNER_ABSENT_MS + JOB_ABORT_GRACE_MS` (45 + 120 + 5 s). Found 2026-10-29 while landing owner liveness (Job Protocol Slice 4, `31dd5c2f0`); the guides do not state the bound as a guarantee. Two paths miss it:

- `server/src/jobs/channel.ts` `expireIfDue` (~:424) settles `disconnected` for queued roots whose job opened no later than the expired root's dispatch. A newer ownerless job of the same client stays queued past 170 s (a Codex probe), and a delivered callback's drain hold (`CANCELLED_CALLBACK_DRAIN_MS`) adds up to 60 s more.
- A provider callback that ends `disconnected` fails through `endWith` and the runner's finalize, not the registry's `abort()`, so `JOB_ABORT_GRACE_MS` does not bound that end (`server/src/jobs/generationJobs.ts` `abort`).

**Why it matters:** a user waiting on an absent owner's chat can wait longer than the documented absence wait suggests.
**Suggested handling:** scope any stated bound to a dispatched callback of the job itself; if the newer-job case matters, give queued roots of an absent client the job-level absence deadline too.

### resumeSavedGenerations has no product caller

`src/ts/network/generationJobs.ts` exports `resumeSavedGenerations` (~:1176), but only tests call it (`generationJobs.test.ts` ~:723 and ~:1311, plus `tests/generationJobsMock.ts`). Boot resumes through `resumeServerJobs` (`src/ts/process/serverCommands.ts`, called from `src/ts/bootstrap.ts`). Unlike that path it does not handle a kept outcome (`GenerationStatus.kept`), and the module comment near :127 still names it as the reload path. Found 2026-10-28 during the Job Protocol receipt store (Slice 1).

**Why it matters:** its tests protect a path the app no longer uses, and the stale comment can lead later job-resume work to edit the wrong function.
**Suggested handling:** confirm the caller before touching tab job resume; remove the export and its tests, or point the comment at `resumeServerJobs`.

## Display transform

### Budget-refused handler rows stay raw

`server/src/prompt/transform.ts` refuses a two-call (tab plugin handler) target whose snapshot charge passes `MAX_SNAPSHOT_BYTES` (8 MiB, :51; the check near :806-824), and the target answers `{ ok: false }`, so the row shows its raw text. `src/ts/parser/transformClient.ts` sends chunks of `MAX_TRANSFORM_TARGETS` (64, `shared/transform.ts:106`; the chunking near :425) and never retries a budget-refused target in a later, smaller chunk, so the row stays raw until it remounts. When Display Evaluation Slice 3 measured it (2026-10-28), a 2,000-message chat of about 6 MiB charged about 6.7 MiB per scope, so only 30–38 of a 64-target chunk fit. Since Slice 4 the shared display entries are excluded from the per-snapshot charge (`exclude: entries`) and pinned against the 64 MiB `MAX_RETAINED_BYTES` instead, so that number is likely smaller now; not re-measured.

**Why it matters:** users with display plugins and long chats may see raw rows.
**Suggested handling:** re-measure on a realistic large chat with handlers; if rows still fail, retry budget-refused targets in smaller chunks or give the refusal its own code.

### Display scope copies the job scope's character reads

`server/src/prompt/displayScope.ts` `chatCharacters` (:152) and `readCharacters` (:170) copy `server/src/jobs/jobScope.ts` `chatCharacters` (:133) and `readCharacters` (:150). Display Evaluation Slice 4 added the copies (2026-10-28) because `jobScope.ts` was outside its files.

**Why it matters:** the transform's key and its `chatCharacters` memo assume the display load reads the same characters (members, speakers, target sources) as `loadJobScope`; two copies can drift.
**Suggested handling:** when `jobScope.ts` is next touched, export the two helpers from it and delete the copies.

### Transform probe heap delta reads as noise

`docs/research/deep-audit-with-fable/probes/transform-jobs-probe.mjs` `four-tiny-snapshots` reports `heapDeltaMiB` (:322) from just before the four calls to just after. Since the display loader shares one transcript entry, the delta reads about −1 to +1 MiB in a full run (earlier garbage is collected inside the window) although the snapshots retain the ~16 MiB transcript. The probe also still throws at `r.pending[0]` (:321) when no snapshot is kept. Display Evaluation Slice 9 (2026-10-28) measured instead the heap freed by `service.close()` and a gc: 15.94 MiB after the plan against 62.9–63.2 MiB at `2f38c2e7b`.

**Why it matters:** a later measurement that copies the probe's number would report no retained heap.
**Suggested handling:** guard the read with `?.` and measure the heap freed on close (or run the snapshot section alone with a close step); say which method in the table.

## Assets and imports

### Server import and restore skip existing assets on existence alone

Server-side writers of content-addressed assets skip a target that merely exists, without checking its bytes: `writeContentAsset` (`server/src/http/contentAsset.ts:33`, `storageFileExists`) and `publishStagedContentAsset` (`:60`), the `.risum` import (`server/src/routes/importModule.ts:121`, counted as `assetsSkipped`), and backup restore (`server/src/routes/backups.ts:413`, any successful `lstat`). An empty, truncated, or corrupt file under a content name therefore stays forever through every reimport and restore. The client's uploads no longer have this gap: they ask `POST /api/assets/missing`, which counts a file that fails verification as missing (Boot Bytes plan D7 and Q5, which left these server paths out of scope). Recorded 2026-10-29.

**Why it matters:** a damaged asset cannot be repaired by importing the same card, module, or backup again, which is what a user would try.
**Suggested handling:** in the retention or byte-budget plan, verify an existing target (reuse `assetVerification.verifyFiles` and its budget) and overwrite it when it does not hash to its name.

## Chat screen and input

### Latest-message start scroll untested in DefaultChatScreen

In 49b046098 (2026-10-24, chat opens at the newest message's start) two pieces of `src/lib/ChatScreens/DefaultChatScreen.svelte` have no unit test, because no test mounts that screen: the reroll swipe alignment gated on `followsSwap` / `Chats.followsLatest` (read before the swap, then `scrollToLatestMessage` after a tick), and the `$effect` that consumes `ShowLatestMessageStore` (set by `openRoute` for notification clicks), and (since 2026-10-27) the scroll handler's load-more skip while `Chats.holding` is true. Only `openRoute` setting the store is tested (`src/ts/router/router.test.ts`).

**Why it matters:** a regression in either path would pass the gate.
**Suggested handling:** add coverage when `DefaultChatScreen` gets a mounted test harness (the Deep Audit Fixes bookmark-jump and translation-invalidation tests are waiting on the same harness), or when touching these paths.

### Popup editor close at teardown reads pre-batch store values

`TextAreaInput.svelte`, `TextAreaResizable.svelte`, and `Chat.svelte` close the popup editor session they own in `onDestroy` through `closePopupEditorSession(id)`, which checks `popUpEditorStore.sessionId`. Svelte 5 runs effect teardowns against the values from before a still-unflushed batch, so a field that opens the popup and is destroyed before that batch flushes (the same synchronous turn) reads the previous `sessionId`, the check fails, and the popup stays open with no owner (seen in a happy-dom test without `flushSync()` after the click; `TextAreaInput.svelte.test.ts` flushes for that reason). A real open always flushes long before the field goes away.

**Why it matters:** an orphaned popup whose close writes back to nothing; only reachable when open and destroy share one batch.
**Suggested handling:** if it ever shows up, have the opener remember whether its open was the current session at open time and close unconditionally through a store function that compares ids captured outside the teardown, or close in a microtask after destroy.

## Test mocks

### globalApi mock has no shared factory

`src/ts/globalApi.svelte` is mocked inline with partial objects in 75 test files (2026-10-26; `rg -l 'vi.mock\("src/ts/globalApi.svelte"' src`), for example `src/lib/ChatScreens/Chats.svelte.test.ts`, `Chats.context.svelte.test.ts`, `Chats.rows.svelte.test.ts` returning only `chatFoldedStateMessageIndex`. STRUCTURE.md V7 asks for one shared typed factory.

**Why it matters:** a new export that a mocked consumer imports breaks those tests at run time instead of at `pnpm check`; Deep Audit Fixes slice 7 designed around it by keeping `chatFoldedStateMessageIndex.index` as the only fold read.
**Suggested handling:** when a change adds a globalApi import to a widely tested component, add a `createGlobalApiMock(overrides)` factory like `src/ts/diagnostics/tests/collectorMock.ts`; globalApi is large, so it may cover only the exports tests actually mock.

### generationJobs one-liner mocks still inline

`src/ts/network/tests/generationJobsMock.ts` (`createGenerationJobsMock`, `createFollowStub`) is used by `serverCommands.test.ts` and `chatStatus.test.ts`, but four files still mock `network/generationJobs` inline with `generationClientId` only: `src/ts/stores.importOrder.test.ts`, `src/ts/stores.simpleCharacter.test.ts`, `src/ts/parser/tests/transformClient.test.ts`, `src/ts/process/request/tests/transport.test.ts`. `chatStore.svelte` is also partially mocked inline in `serverCommands.test.ts` (`markChatStale`, `isChatStale`, `currentChatRef` added by hand).

**Why it matters:** the typed stale mocks are what broke 37 tests when `GenerationFollow.opened` was added.
**Suggested handling:** migrate the one-liners when touching those files.

### chatStore mock has no shared factory

About 25 test files under `src/` mock `src/ts/storage/chatStore.svelte.ts` inline with partial objects (2026-10-28; `rg -l 'vi\.mock\(\s*"[^"]*chatStore\.svelte' src`), for example `src/ts/parser/tests/transformClient.test.ts` near its `heldChatRevision` stub. STRUCTURE.md V7 asks for one shared typed factory. Found by Display Evaluation Slice 2: adding `chatInstallVersion` and `chatHasUnackedWork` failed 34 transformClient tests with "No chatInstallVersion export defined on mock".

**Why it matters:** each new chatStore export a mocked module imports breaks unrelated suites, which then look like regressions and cost a stale-test round.
**Suggested handling:** a typed `chatStoreMock()` factory under the test helpers, adopted file by file.

### resourceClient mock has no shared factory

`src/ts/storage/resourceClient` is mocked inline in about 16 test files (2026-10-29; `rg -l 'vi.mock\(.*resourceClient' src`), for example `src/ts/process/serverCommands.test.ts` near :172, `chatStatus.test.ts`, `network/eventFeed.test.ts`, `network/jobChannel.test.ts`, `plugins/apiV3/hostApiChats.test.ts`. There is no `resourceClientMock.ts`; STRUCTURE.md V7 asks for one shared typed factory. Found 2026-10-28 by Job Protocol Slice 2: product code began importing `ResourceEpochMismatchError`, and the inline mock in `serverCommands.test.ts` failed 17 tests at run time; a local class was added to that one mock as a stopgap.

**Why it matters:** a new resourceClient export breaks unrelated suites at run time, which `pnpm check` cannot catch.
**Suggested handling:** add `src/ts/storage/tests/resourceClientMock.ts` with defaults that `satisfies` the module's export type, and move the inline mocks onto it file by file.
