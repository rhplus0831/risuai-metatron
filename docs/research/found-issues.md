# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's Known Hazards `Issues` (or `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), and 2026-10-27 (single entries). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (2)
- [Server jobs and prompt assembly](#server-jobs-and-prompt-assembly) (2)
- [Chat screen and input](#chat-screen-and-input) (2)
- [Test mocks](#test-mocks) (2)

## Chat store, sync, and change feeds

### Parked resends leak

`src/ts/storage/chatStore.svelte.ts` `dropCharacterWork(id, false)` from `takeChatWork`'s absent-character sweep (~3505, the quarantined-create path) parks in-doubt resends (`parkResends`); no deletion acknowledgement or `forgetCharacter` ever comes for a character the server never had, so the entry stays until `seedChats` (boot) or a re-add of the same id, which would replay a harmless resend first. Accepted trade-off of open-bug-fixes slice A3 (landed on metatron 2026-10-19 via plan-runner), noted by its Fable reviewer. Still present 2026-10-21 (`parkedResends`, chatStore.svelte.ts ~180).

**Why it matters:** tiny memory leak per session; a far-later same-id re-add sends one extra replay.

**Suggested handling:** if it matters, drop parked resends once the adapter knows the abandoned character has no server incarnation and no unresolved create can still establish one, and also clean entries parked in an earlier cycle. `persisted` alone is not that proof: a removed character whose create answer was lost is resent while `persisted` lacks it (resourceSync.svelte.ts ~1387), and a same-id re-add still needs the preserved group ids (checked 2026-10-24). Parked payloads can hold whole chat snapshots, so the leak is not always tiny.

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

## Server jobs and prompt assembly

### Trigger bookmarkNames whole write

`server/src/jobs/chatResult.ts` `applyTriggerChat` merges only `CHAT_META_MERGE_KEYS` (`shared/chats.ts:14`: toolCalls, GLGlobalVariables, scriptstate) entry by entry. Any other dictionary chat field, notably `bookmarkNames` (`shared/database.ts`, `{ [chatId]: string }`), still takes a whole `set`/`unset` from the trigger's copy, so a bookmark name another tab saved during the run would be erased if a trigger copy ever changed that field. Latent: no trigger, Lua, or command effect writes `bookmarkNames` today. Noticed 2026-10-26 (Deep Audit Fixes slice 1).

**Why it matters:** the same lost-update shape as the fixed `scriptstate` case, waiting for a new writer.
**Suggested handling:** if a script API starts writing bookmarks, add the field to `CHAT_META_MERGE_KEYS` (the server validation in `server/src/data/chatStore.ts` rejects other merge keys) and to the client's `applyChatResult` merge path.

### Repeated begin re-acquires a lock

`server/src/jobs/generationJobs.ts` `writeAsJob` (~:914) calls `lock.acquire` for every `begin` op before the store applies the write, and `server/src/jobs/generationLock.ts` `acquire` (:68) does not refuse a generation id the same job already released. `server/src/data/chatStore.ts` treats a `begin` for a message that already exists as a no-op success, so the acquisition is not rolled back. A live job that finished generation G and then sent `begin(G)` again would hold G's lock again, possibly without advancing the chat revision. Latent: the prompt runner mints a fresh UUID per generation (`server/src/prompt/runner.ts`). Found 2026-10-26 by the Deep Audit Fixes slice 8 challenger.

**Why it matters:** the client's feed-lock rules (whole-read lock lists, the revision rule for older copies) assume a released generation does not re-lock a message.
**Suggested handling:** if a reply ever shows locked after its job finished its write, check for a replayed `begin`; a fix would retire released generation ids per job in `generationLock` or refuse a `begin` whose message exists.

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
