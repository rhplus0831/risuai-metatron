# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26.

These are notes, not verified reports. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch) and 2026-10-26 (second batch). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (5)
- [Server jobs and prompt assembly](#server-jobs-and-prompt-assembly) (3)
- [Chat screen and input](#chat-screen-and-input) (4)
- [Test mocks](#test-mocks) (2)

## Chat store, sync, and change feeds

### Feed lock windows

Slice 2b's feed locks (`feedLocks`, `noteRemoteStreaming`, `replaceFeedLocks`, `dropFeedLocksOf` in `src/ts/storage/chatStore.svelte.ts`) are advisory. A tab shows a generating reply unlocked (2a's `dropLockedEdits` then catches an edit) before the job's first write frame: the job owns no message before its `begin`, so neither the `hello` snapshot nor a whole chat read's lock list can list it. Since 2026-10-26 whole chat reads carry the server's lock list and decide the chat's feed locks (Deep Audit Fixes slice 8), so the window after a newer whole read is gone, except against an older server whose reads omit the list (the revision rule still applies there). `isCharacterGenerating` also counts feed locks, so the same window decides when an observer tab refuses a permanent character delete or a different-id replace locally (the server's 409 `generating` stays the fallback).

**Why it matters:** the remaining path for A4 (edit over the generating reply) before the reply exists on the server.
**Suggested handling:** if it matters, announce the job's chat reservation (admission, before `begin`) in the feed and the read lock lists, so a tab can lock the chat's tail instead of a message id.

### Parked resends leak

`src/ts/storage/chatStore.svelte.ts` `dropCharacterWork(id, false)` from `takeChatWork`'s absent-character sweep (~3505, the quarantined-create path) parks in-doubt resends (`parkResends`); no deletion acknowledgement or `forgetCharacter` ever comes for a character the server never had, so the entry stays until `seedChats` (boot) or a re-add of the same id, which would replay a harmless resend first. Accepted trade-off of open-bug-fixes slice A3 (landed on metatron 2026-10-19 via plan-runner), noted by its Fable reviewer. Still present 2026-10-21 (`parkedResends`, chatStore.svelte.ts ~180).

**Why it matters:** tiny memory leak per session; a far-later same-id re-add sends one extra replay.

**Suggested handling:** if it matters, drop parked resends once the adapter knows the abandoned character has no server incarnation and no unresolved create can still establish one, and also clean entries parked in an earlier cycle. `persisted` alone is not that proof: a removed character whose create answer was lost is resent while `persisted` lacks it (resourceSync.svelte.ts ~1387), and a same-id re-add still needs the preserved group ids (checked 2026-10-24). Parked payloads can hold whole chat snapshots, so the leak is not always tiny.

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

### Earlier-refused chat read from the server copy

Since the F01 flush fix (Deep Audit Fixes, 2026-10-26) `flushResources()` returns `refused: string[]` (`chats/<chaId>/<chatId>`, order `chats/<chaId>`) beside `discarded`. A chat quarantined by an earlier flush keeps its draft only in the tab and shows up in neither list of a later flush, so three callers that check only `discarded` work on the server's older copy while the tab shows the refused draft:

- `src/ts/process/memoryTasks.svelte.ts:434` `startMemoryTask`: the server summarizes its older stored transcript.
- `src/ts/storage/chatEdits.ts:93` `readChatsDetached` (Export All Chats in `src/ts/characters.ts`, `src/ts/storage/exportAsDataset.ts`): the export silently holds the server's copy, against the function's doc comment.
- `src/ts/translator/storedTranslation.svelte.ts:175` (manual path, not `follow`): the request sends ids only, so the server translates its own older text while the local hash check passes on the draft.

**Why it matters:** the same "successful flush = durable" assumption F01 fixed for send, export, and callbacks; the user gets a summary, export, or translation of text they do not see, without a warning.
**Suggested handling:** treat a `refused` key naming the target chat (or its order) like `discarded`: refuse the memory task with reason "refused" (mirroring `runPinnedServerJob` in `serverCommands.ts`), throw or warn in `readChatsDetached`, and alert `translationSourceChanged` (or a refused-draft text) in the manual translation; leave the automatic `follow` path as is.

### Client applyChatResult unsets a dropped map

`src/ts/storage/chatStore.svelte.ts` `applyChatResult` (~2937) merges a changed `CHAT_META_MERGE_KEYS` field entry by entry only when the result still has the field as a plain object. When a hook's result drops the field (deleted or `undefined`), it falls through to a whole-field `unset`, so the server removes every entry, including ones another tab saved meanwhile. The server's `applyTriggerChat` (`server/src/jobs/chatResult.ts`) turns a dropped map into `mergeUnset` of the baseline's entries instead. Callers: plugin v3 chat writes (`src/ts/plugins/apiV3/v3.svelte.ts`), `chatEdits.ts`, `chatStore.svelte.ts` itself. Noticed 2026-10-26 by the Deep Audit Fixes slice 1 challenger.

**Why it matters:** rare (a plugin replacing the chat without `scriptstate`), but a silent cross-tab variable loss and a client/server rule mismatch.
**Suggested handling:** mirror the server rule in the client merge branch (`after === undefined && isPlainRecord(before)` → removals of the baseline's entries), with a `chatLazyLoading`/`characterNormalization`-style test.

## Server jobs and prompt assembly

### Trigger bookmarkNames whole write

`server/src/jobs/chatResult.ts` `applyTriggerChat` merges only `CHAT_META_MERGE_KEYS` (`shared/chats.ts:14`: toolCalls, GLGlobalVariables, scriptstate) entry by entry. Any other dictionary chat field, notably `bookmarkNames` (`shared/database.ts`, `{ [chatId]: string }`), still takes a whole `set`/`unset` from the trigger's copy, so a bookmark name another tab saved during the run would be erased if a trigger copy ever changed that field. Latent: no trigger, Lua, or command effect writes `bookmarkNames` today. Noticed 2026-10-26 (Deep Audit Fixes slice 1).

**Why it matters:** the same lost-update shape as the fixed `scriptstate` case, waiting for a new writer.
**Suggested handling:** if a script API starts writing bookmarks, add the field to `CHAT_META_MERGE_KEYS` (the server validation in `server/src/data/chatStore.ts` rejects other merge keys) and to the client's `applyChatResult` merge path.

### Repeated begin re-acquires a lock

`server/src/jobs/generationJobs.ts` `writeAsJob` (~:914) calls `lock.acquire` for every `begin` op before the store applies the write, and `server/src/jobs/generationLock.ts` `acquire` (:68) does not refuse a generation id the same job already released. `server/src/data/chatStore.ts` treats a `begin` for a message that already exists as a no-op success, so the acquisition is not rolled back. A live job that finished generation G and then sent `begin(G)` again would hold G's lock again, possibly without advancing the chat revision. Latent: the prompt runner mints a fresh UUID per generation (`server/src/prompt/runner.ts`). Found 2026-10-26 by the Deep Audit Fixes slice 8 challenger.

**Why it matters:** the client's feed-lock rules (whole-read lock lists, the revision rule for older copies) assume a released generation does not re-lock a message.
**Suggested handling:** if a reply ever shows locked after its job finished its write, check for a replayed `begin`; a fix would retire released generation ids per job in `generationLock` or refuse a `begin` whose message exists.

### Overlapping chat ranges share one history object

`server/src/prompt/assemble.ts` `pushPrompts` (:1853, `formated[formated.length - 1].content += "\n\n" + chat.content`) appends a merged system entry's text into the previous entry object in place. With two overlapping `chat` template cards the same history object sits in `formated` twice, so a merge into one occurrence also changes the other occurrence's text (it is sent twice with the merged text). Only for gpt/claude/openrouter/reverse_proxy models and consecutive system entries with the same memo and name. Pre-existing, inherited from the client path; the token-recheck half was fixed 2026-10-26 (Deep Audit Fixes slice 1).

**Why it matters:** a prompt shape the user did not write; the context report's per-entry counts read the mutated object.
**Suggested handling:** clone an occurrence before merging into it (prompt identity changes: check `server/src/tests/assemble.test.ts` ~957, which asserts the shared identity, and the browser golden).

## Chat screen and input

### Global hotkeys ignore IME composition

`src/ts/hotkey.ts:47` (document keydown) skips only plain keys inside text entries; a modifier hotkey matched by `hotkeyMatches` runs with no `isComposing`/`keyCode 229` check, so the default `send` hotkey (Ctrl+Alt+Enter, `shared/hotkeys.ts`) clicks `.button-icon-send` even while an IME composes. The composers' shared IME guard (`src/ts/ime.ts`, Deep Audit Fixes slice 2) cannot stop it because the event still bubbles to the document. Found by the slice 2 challenger.

**Why it matters:** low reach (an IME commit Enter rarely carries Ctrl+Alt), but it is the one send path left without the guard.
**Suggested handling:** reuse the shared IME guard at the top of the document keydown handler; test with a synthetic composing Ctrl+Alt+Enter.

### Suggestion reroll confirm acts on the live selection

`src/lib/ChatScreens/Suggestion.svelte:341` (the RefreshCcw button): `alertConfirm(language.askReRollAutoSuggestions).then(...)` clears `suggestMessages`, cancels, and calls `requestSuggestions()` for the chat selected when the dialog resolves, not the one it was opened for. A chat switch while the confirm is open rerolls the other chat (a wasted request; its suggestions replaced). Found by the Deep Audit Fixes slice 3 challenger.

**Why it matters:** the same ownership class as F11/CE08 (an async continuation acting on the live selection).
**Suggested handling:** capture `currentChatRef()` before the confirm and skip unless it is still selected after; test in `Suggestion.svelte.test.ts` with a deferred confirm.

### Latest-message start scroll untested in DefaultChatScreen

In 49b046098 (2026-10-24, chat opens at the newest message's start) two pieces of `src/lib/ChatScreens/DefaultChatScreen.svelte` have no unit test, because no test mounts that screen: the reroll swipe alignment gated on `followsSwap` / `Chats.followsLatest` (read before the swap, then `scrollToLatestMessage` after a tick), and the `$effect` that consumes `ShowLatestMessageStore` (set by `openRoute` for notification clicks), and (since 2026-10-27) the scroll handler's load-more skip while `Chats.holding` is true. Only `openRoute` setting the store is tested (`src/ts/router/router.test.ts`).

**Why it matters:** a regression in either path would pass the gate.
**Suggested handling:** add coverage when `DefaultChatScreen` gets a mounted test harness (the Deep Audit Fixes bookmark-jump and translation-invalidation tests are waiting on the same harness), or when touching these paths.

### Reader position not kept across growth inside shown rows

Since 2026-10-27, `src/lib/ChatScreens/Chats.svelte` holds rows that come in above the view until they have rendered and the reader stops scrolling. That fixed the reproduced jumps: wheeling while a chat opens, and wheeling into load-more. Content that grows inside rows already shown above the view still moves the reader by the grown height while a scroll animation runs (Chrome, reversed scroller; measured on a minimal page). Examples are images swapped in late by `checkImg` (`.root-loaded-image` reserves no height), lazy images, a row re-rendering (CBS, translation, a reload pointer), and a far row whose `contain-intrinsic-block-size` estimate differs from its rendered height when it comes near. Repro drivers from the investigation: headed Chrome on WSLg with real X wheel ticks through XTest. CDP `Input.dispatchMouseEvent` wheels do not animate, so they never reproduce it.

**Why it matters:** each case is smaller than the jumps that were fixed (one row's growth, not a page), but it has the same feel: the reader lands somewhere they did not scroll to.
**Suggested handling (optional, deferred by the owner):** once the anchor is released, keep a reader anchor. Record the visible row nearest the view's top and its offset on scroll. After a transcript resize, restore that offset at `scrollend`, not mid-animation, where a correction would fight the running animation. Measure the visible row's displacement beyond the intended scroll; do not double-compensate with any native anchoring.

## Test mocks

### globalApi mock has no shared factory

`src/ts/globalApi.svelte` is mocked inline with partial objects in 75 test files (2026-10-26; `rg -l 'vi.mock\("src/ts/globalApi.svelte"' src`), for example `src/lib/ChatScreens/Chats.svelte.test.ts`, `Chats.context.svelte.test.ts`, `Chats.rows.svelte.test.ts` returning only `chatFoldedStateMessageIndex`. STRUCTURE.md V7 asks for one shared typed factory.

**Why it matters:** a new export that a mocked consumer imports breaks those tests at run time instead of at `pnpm check`; Deep Audit Fixes slice 7 designed around it by keeping `chatFoldedStateMessageIndex.index` as the only fold read.
**Suggested handling:** when a change adds a globalApi import to a widely tested component, add a `createGlobalApiMock(overrides)` factory like `src/ts/diagnostics/tests/collectorMock.ts`; globalApi is large, so it may cover only the exports tests actually mock.

### generationJobs one-liner mocks still inline

`src/ts/network/tests/generationJobsMock.ts` (`createGenerationJobsMock`, `createFollowStub`) is used by `serverCommands.test.ts` and `chatStatus.test.ts`, but four files still mock `network/generationJobs` inline with `generationClientId` only: `src/ts/stores.importOrder.test.ts`, `src/ts/stores.simpleCharacter.test.ts`, `src/ts/parser/tests/transformClient.test.ts`, `src/ts/process/request/tests/transport.test.ts`. `chatStore.svelte` is also partially mocked inline in `serverCommands.test.ts` (`markChatStale`, `isChatStale`, `currentChatRef` added by hand).

**Why it matters:** the typed stale mocks are what broke 37 tests when `GenerationFollow.opened` was added.
**Suggested handling:** migrate the one-liners when touching those files.
