# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's Known Hazards `Issues` (or `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), and 2026-10-27 (single entries). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (2)
- [Save journal and recovery](#save-journal-and-recovery) (2)
- [Server jobs and prompt assembly](#server-jobs-and-prompt-assembly) (4)
- [Display transform](#display-transform) (3)
- [Chat screen and input](#chat-screen-and-input) (3)
- [Build, drivers, and e2e](#build-drivers-and-e2e) (2)
- [Test timing](#test-timing) (1)
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

### Reads outside the save adapter have no deadline

Only reads the save adapter issues go through `deadlineRead` (20 s, `src/ts/storage/resourceSync.svelte.ts`); the `resourceClient.ts` read functions take an optional `signal` but have no default deadline. On-demand chat loads now have their own per-request deadline (`CHAT_READ_DEADLINE_MS`, `chatStore.svelte.ts`; [Durable Drafts audit U1](../audit/durable-drafts-2026-10-29.md#u1--an-on-demand-chat-read-can-remain-pending-indefinitely)). The socket reconcile's `listRevisions` now has its own deadline too (`RECONCILE_DEADLINE_MS`, `eventFeed.ts`; [Boot Bytes audit U1](../audit/boot-bytes-2026-10-29.md#u1--a-live-socket-does-not-rescue-a-stalled-reconciliation-read)). Remaining callers to investigate: character-order repair (`src/ts/storage/characterOrder.ts` ~:221), job callback recovery (`src/ts/network/jobChannel.ts` ~:599), detached export reads (`src/ts/storage/chatEdits.ts` ~:109), and the boot read. Found while landing Slice 2.

**Why it matters:** a stuck read hangs its caller (an export or boot that never finishes) with no error. It no longer blocks saving.
**Suggested handling:** when touching one of these callers, pass a signal with a bound suited to its payload (a chat load can be large on a slow link, so 20 s may be too short).

### Split-commit test misses the collector guard

`src/ts/storage/tests/resourceSyncJournal.test.ts` "commits the split before sending its first 5000 operations, then sends the remainder under a new id" holds the journal commit and checks for no dispatch after `advanceTimersByTimeAsync(0)`. With the ordinary collector's `if (resend.unconfirmed) continue;` (`src/ts/storage/chatStore.svelte.ts`) replaced by `if (false) continue;` the file still passes: `flushResources`'s dependency wait masks the collector on the path the test drives. HEAD keeps the guard. Found by the [cross-plan review](../audit/cross-plan-2026-10-29.md#jr3--the-split-commit-test-passes-with-the-collector-guard-removed) (JR3; its `probes/JR3-break_test.py` case 3 reproduces the pass).

**Why it matters:** a regression that lets a normal save cycle dispatch an uncommitted split prefix would not be caught.
**Suggested handling:** hold the commit across another collection cycle and assert no prefix dispatch before releasing it; fix beside JR1/JR2.

## Server jobs and prompt assembly

### Trigger bookmarkNames whole write

`server/src/jobs/chatResult.ts` `applyTriggerChat` merges only `CHAT_META_MERGE_KEYS` (`shared/chats.ts:14`: toolCalls, GLGlobalVariables, scriptstate) entry by entry. Any other dictionary chat field, notably `bookmarkNames` (`shared/database.ts`, `{ [chatId]: string }`), still takes a whole `set`/`unset` from the trigger's copy, so a bookmark name another tab saved during the run would be erased if a trigger copy ever changed that field. Latent: no trigger, Lua, or command effect writes `bookmarkNames` today. Noticed 2026-10-26 (Deep Audit Fixes slice 1).

**Why it matters:** the same lost-update shape as the fixed `scriptstate` case, waiting for a new writer.
**Suggested handling:** if a script API starts writing bookmarks, add the field to `CHAT_META_MERGE_KEYS` (the server validation in `server/src/data/chatStore.ts` rejects other merge keys) and to the client's `applyChatResult` merge path.

### Repeated begin re-acquires a lock

`server/src/jobs/generationJobs.ts` `writeAsJob` (~:914) calls `lock.acquire` for every `begin` op before the store applies the write, and `server/src/jobs/generationLock.ts` `acquire` (:68) does not refuse a generation id the same job already released. `server/src/data/chatStore.ts` treats a `begin` for a message that already exists as a no-op success, so the acquisition is not rolled back. A live job that finished generation G and then sent `begin(G)` again would hold G's lock again, possibly without advancing the chat revision. Latent: the prompt runner mints a fresh UUID per generation (`server/src/prompt/runner.ts`). Found 2026-10-26 by the Deep Audit Fixes slice 8 challenger.

**Why it matters:** the client's feed-lock rules (whole-read lock lists, the revision rule for older copies) assume a released generation does not re-lock a message.
**Suggested handling:** if a reply ever shows locked after its job finished its write, check for a replayed `begin`; a fix would retire released generation ids per job in `generationLock` or refuse a `begin` whose message exists.

### Tool schemas are outside the assembly token budget

`server/src/prompt/assemble.ts`'s final recheck counts messages; `AssemblyHost` has no tool-schema input, and the OpenAI adapter (`server/src/llm/openAI/requests.ts`) adds `body.tools` from descriptors supplied later in `server/src/llm/requests.ts`. A prompt assembled to the budget can therefore exceed the provider's context by the schemas' tokens. Traced by the [cross-plan review](../audit/cross-plan-2026-10-29.md#hypotheses-not-reproduced) (memory seam) and not reproduced with a real tokenizer; unverified.

**Why it matters:** with many or large tool definitions a send near the budget could be refused by the provider although the meter shows room.
**Suggested handling:** measure with a real tool set and tokenizer; if the gap is real, charge an estimate of the schemas in the recheck (the token-counting follow-up group of the Deep Audit Fixes plan).

### Hand-edited legacy HypaV3 ratios resolve negative

`shared/hypaV3Presets.ts` `resolveHypaV3Budget` accepts legacy ratio fields as stored: `memoryTokensRatio: -0.2` or `extraSummarizationRatio: 2` (a hand-edited or imported preset) resolve at `C = 1000` to a memory budget of −200 and a target of −1000, and a token-mode call with `C = NaN` leaves nonfinite thresholds. No settings-UI path produces these values; token-mode fields are floored at 0. Probed by the cross-plan review (memory seam); latent.

**Why it matters:** a malformed preset would plan memory with negative room instead of refusing or clamping.
**Suggested handling:** clamp ratios to `[0, 1]` and guard a nonfinite `C` in the resolver when it is next touched; keep the stored values (parity and import contract).

## Display transform

### Budget-refused handler rows stay raw

`server/src/prompt/transform.ts` refuses a two-call (tab plugin handler) target whose snapshot charge passes `MAX_SNAPSHOT_BYTES` (8 MiB, :51; the check near :806-824), and the target answers `{ ok: false }`, so the row shows its raw text. `src/ts/parser/transformClient.ts` sends chunks of `MAX_TRANSFORM_TARGETS` (64, `shared/transform.ts:106`; the chunking near :425) and never retries a budget-refused target in a later, smaller chunk, so the row stays raw until it remounts. When Display Evaluation Slice 3 measured it (2026-10-28), a 2,000-message chat of about 6 MiB charged about 6.7 MiB per scope, so only 30–38 of a 64-target chunk fit. Since Slice 4 the shared display entries are excluded from the per-snapshot charge (`exclude: entries`) and pinned against the 64 MiB `MAX_RETAINED_BYTES` instead, so that number is likely smaller now; not re-measured.

**Why it matters:** users with display plugins and long chats may see raw rows.
**Suggested handling:** re-measure on a realistic large chat with handlers; if rows still fail, retry budget-refused targets in smaller chunks or give the refusal its own code. The [cross-plan review](../audit/cross-plan-2026-10-29.md#dt1--a-permanent-display-failure-retries-and-toasts-every-round) measured that each automatic retry of such a refusal re-reads the transcript (about 120–175 ms for 65 MiB) and that the tab retries permanent refusals without bound (DT1).

### Display scope copies the job scope's character reads

`server/src/prompt/displayScope.ts` `chatCharacters` (:152) and `readCharacters` (:170) copy `server/src/jobs/jobScope.ts` `chatCharacters` (:133) and `readCharacters` (:150). Display Evaluation Slice 4 added the copies (2026-10-28) because `jobScope.ts` was outside its files.

**Why it matters:** the transform's key and its `chatCharacters` memo assume the display load reads the same characters (members, speakers, target sources) as `loadJobScope`; two copies can drift.
**Suggested handling:** when `jobScope.ts` is next touched, export the two helpers from it and delete the copies.

### Transform probe heap delta reads as noise

`docs/research/deep-audit-with-fable/probes/transform-jobs-probe.mjs` `four-tiny-snapshots` reports `heapDeltaMiB` (:322) from just before the four calls to just after. Since the display loader shares one transcript entry, the delta reads about −1 to +1 MiB in a full run (earlier garbage is collected inside the window) although the snapshots retain the ~16 MiB transcript. The probe also still throws at `r.pending[0]` (:321) when no snapshot is kept. Display Evaluation Slice 9 (2026-10-28) measured instead the heap freed by `service.close()` and a gc: 15.94 MiB after the plan against 62.9–63.2 MiB at `2f38c2e7b`.

**Why it matters:** a later measurement that copies the probe's number would report no retained heap.
**Suggested handling:** guard the read with `?.` and measure the heap freed on close (or run the snapshot section alone with a close step); say which method in the table.

## Chat screen and input

### Latest-message start scroll untested in DefaultChatScreen

In 49b046098 (2026-10-24, chat opens at the newest message's start) two pieces of `src/lib/ChatScreens/DefaultChatScreen.svelte` have no unit test, because no test mounts that screen: the reroll swipe alignment gated on `followsSwap` / `Chats.followsLatest` (read before the swap, then `scrollToLatestMessage` after a tick), and the `$effect` that consumes `ShowLatestMessageStore` (set by `openRoute` for notification clicks), and (since 2026-10-27) the scroll handler's load-more skip while `Chats.holding` is true. Only `openRoute` setting the store is tested (`src/ts/router/router.test.ts`).

**Why it matters:** a regression in either path would pass the gate.
**Suggested handling:** add coverage when `DefaultChatScreen` gets a mounted test harness (the Deep Audit Fixes bookmark-jump and translation-invalidation tests are waiting on the same harness), or when touching these paths.

### Popup editor close at teardown reads pre-batch store values

`TextAreaInput.svelte`, `TextAreaResizable.svelte`, and `Chat.svelte` close the popup editor session they own in `onDestroy` through `closePopupEditorSession(id)`, which checks `popUpEditorStore.sessionId`. Svelte 5 runs effect teardowns against the values from before a still-unflushed batch, so a field that opens the popup and is destroyed before that batch flushes (the same synchronous turn) reads the previous `sessionId`, the check fails, and the popup stays open with no owner (seen in a happy-dom test without `flushSync()` after the click; `TextAreaInput.svelte.test.ts` flushes for that reason). A real open always flushes long before the field goes away.

**Why it matters:** an orphaned popup whose close writes back to nothing; only reachable when open and destroy share one batch.
**Suggested handling:** if it ever shows up, have the opener remember whether its open was the current session at open time and close unconditionally through a store function that compares ids captured outside the teardown, or close in a microtask after destroy.

### Popup editor mode switch resets selection and undo

`src/lib/Others/PopupEditor.svelte` destroys and recreates the textarea or the Monaco model when the Monaco toggle changes after an edit: the text is kept, the selection resets to the end (`[6,10] → [16,16]` in the review probe), the old model is disposed, and `canUndo` goes from true to false, so an undo after switching back does nothing. Observed by the [cross-plan review](../audit/cross-plan-2026-10-29.md#noted-not-recommended-to-fix) with a real Monaco instance (`probes/N1-PopupEditor.review.probe.ts`).

**Why it matters:** a user who toggles modes mid-edit loses undo history; the toggle's contract (`819a6295d`) promises only the text.
**Suggested handling:** decide: record it as a ui-theming Limitation (keep the text-only contract), or keep one model across the switch (a larger editor-lifetime change).

## Build, drivers, and e2e

### measureBoot has no resume after a change made while hidden

Since the reconnect digest (Boot Bytes D4), `measureBoot.mjs`'s `resume` scenario requires that an unchanged resume reads no `/api/resources/revisions` listing. No scenario covers a change another client commits while the measured page is hidden, the case that still pays one full compressed listing (about 88.7 KB wire on the `audit` fixture). Found 2026-10-29 by Boot Bytes Slice 7.

**Why it matters:** a regression that reads the listing twice, or skips it wrongly after an away change, goes unmeasured, and the remaining reconnect cost (the plan's change-log Later item) stays invisible.
**Suggested handling:** add an away-change resume variant: hide, write through the API from a second client, show, and require exactly one listing with the change applied.

### readersCharacters e2e timed out behind the Safe boot notice

`e2e/readersCharacters.spec.ts` timed out once (300 s) at `:111` (`folderAvatar("Folder One").click({ button: "right" })`) because the Safe boot notice ("The last 4 starts did not finish loading ...") intercepted pointer events. It was the first e2e run right after `pnpm build` and a `checkBootCache.mjs` dev-stack run in the same worktree; three `--force` reruns passed in about 55 s. The spec does not call `clearSafeBootAttempts` (`util/playwright/stack.mjs`), which other specs such as `chatBinding.spec.ts` use. Found 2026-10-29 by Boot Bytes Slice 8; not reproduced.

**Why it matters:** any stretch of unfinished loads turns into a five-minute timeout instead of a clear failure, and the unfinished loads themselves are unexplained.
**Suggested handling:** clear the safe-boot attempts in the spec's context (or in a shared e2e fixture), and if it recurs, find why the earlier loads did not finish.

## Test timing

### Gate tests still racing real time

Untagged gate tests that depend on real wall-clock or scheduler time (invariant V3), noted by the [cross-plan review](../audit/cross-plan-2026-10-29.md#test-quality) on 2026-10-29; none failed in its runs. `src/ts/storage/tests/draftJournal.test.ts`: the start and adoption cases (the live-owner case near "leaves a live owner's rows alone" and the owner-reload case) call the real journal with its production 3 s open/seed and 5 s recovery-lock deadlines, and the file's blanket fake-timer comment does not hold for them. `server/src/tests/hypaV3Parts.test.ts`: selection and deferral cases built with `hostOf` run under the real 5,000 ms cumulative separator budget. `server/src/tests/transformService.test.ts`: `heldCount` polls with a real `setTimeout(2)` (up to 500 polls) and a 5 ms real sleep observes shutdown. `server/src/tests/transform.test.ts`: the real-worker route cases outside the cache describe's fake clock race worker, CBS, and transform deadlines (`SLOW = 60_000` is a timeout, not a `slow` tag). `src/ts/storage/tests/bootCacheServer.test.ts` (around the cases near lines 185 and 485 at that time): the real 3 s cache deadline with asynchronous IndexedDB work. Real sleeps: `server/src/tests/backups.test.ts` (`sleep(2)`/`sleep(20)` in five cases), `server/src/tests/push.test.ts` (delivery and queue synchronization), `server/src/tests/resourceStore.test.ts` (delayed continuations), `server/src/tests/diagnostics.test.ts` (successive state timestamps, a job fixture). `src/lib/ChatScreens/Chat.draft.test.ts`: the auto-popup cases wait for the first row with real `vi.waitFor` before faking timers. `src/ts/network/generationJobs.test.ts` and `src/ts/process/serverCommands.test.ts`: zero-delay real-timer flush helpers as synchronization.

**Why it matters:** each is a load-sensitive failure waiting for a slow CI runner; the timing plans' policy (`docs/structure/build-test-platforms.md` `Tests`) asks for controlled clocks or the `slow` tag.
**Suggested handling:** when one of these files is next touched, control its clock (inject the deadline or fake the timers) or tag the case `slow`; `pnpm --silent test:agent --slow-tests` lists the ones over 1 s.

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

About 25 test files under `src/` mock `src/ts/storage/chatStore.svelte.ts` inline with partial objects (2026-10-28; `rg -l 'vi\.mock\(\s*"[^"]*chatStore\.svelte' src`), for example `src/ts/parser/tests/transformClient.test.ts` near its `heldChatRevision` stub. STRUCTURE.md V7 asks for one shared typed factory. Found by Display Evaluation Slice 2: adding `chatInstallVersion` and `chatHasUnackedWork` failed 34 transformClient tests with "No chatInstallVersion export defined on mock". Boot Bytes Slice 5 hit it again on 2026-10-29: the new `characterLastChattedAt` export failed four `src/lib/Mobile/MobileCharacters.test.ts` tests at run time.

**Why it matters:** each new chatStore export a mocked module imports breaks unrelated suites, which then look like regressions and cost a stale-test round.
**Suggested handling:** a typed `chatStoreMock()` factory under the test helpers, adopted file by file.

### resourceClient mock has no shared factory

`src/ts/storage/resourceClient` is mocked inline in about 16 test files (2026-10-29; `rg -l 'vi.mock\(.*resourceClient' src`), for example `src/ts/process/serverCommands.test.ts` near :172, `chatStatus.test.ts`, `network/eventFeed.test.ts`, `network/jobChannel.test.ts`, `plugins/apiV3/hostApiChats.test.ts`. There is no `resourceClientMock.ts`; STRUCTURE.md V7 asks for one shared typed factory. Found 2026-10-28 by Job Protocol Slice 2: product code began importing `ResourceEpochMismatchError`, and the inline mock in `serverCommands.test.ts` failed 17 tests at run time; a local class was added to that one mock as a stopgap.

**Why it matters:** a new resourceClient export breaks unrelated suites at run time, which `pnpm check` cannot catch.
**Suggested handling:** add `src/ts/storage/tests/resourceClientMock.ts` with defaults that `satisfies` the module's export type, and move the inline mocks onto it file by file.
