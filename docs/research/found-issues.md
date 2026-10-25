# Issues Found During Work

Bugs, latent defects, stale docs and comments, and test flakes that agent sessions noticed while working on something else, between 2026-10-14 and 2026-10-24. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. They lived in the agents' project memory until 2026-10-24 and were moved here unchanged apart from link wording.

These are notes, not verified reports. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24. Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (3)
- [Chat screen](#chat-screen) (2)

## Chat store, sync, and change feeds

### Feed lock windows

Slice 2b's feed locks (`feedLocks`, `noteRemoteStreaming`, `replaceFeedLocks`, `dropFeedLocksOf` in `src/ts/storage/chatStore.svelte.ts`) are advisory. A tab shows a generating reply unlocked (2a's `dropLockedEdits` then catches an edit) before the job's first write frame (the job owns no message before its `begin`, so the `hello` snapshot cannot list it either), and after an adopted whole read at a newer revision than the lock's frame or snapshot (another writer changed the chat), until the job's next write re-announces the lock: every 3 s while streaming (`CHECKPOINT_INTERVAL_MS`), but a job waiting on its provider or a callback can write nothing for its whole remaining life. Since 2026-10-24 every `hello` carries the server's lock snapshot with each chat's sampled revision, so a reconnect no longer drops live locks; the server still sends no lock snapshot with a chat read. Since 2026-10-24 `isCharacterGenerating` also counts feed locks, so the same windows decide when an observer tab refuses a permanent character delete or a different-id replace locally (the server's 409 `generating` stays the fallback).

**Why it matters:** these are the remaining paths for A4 (edit over the generating reply) and D7-style surprises.
**Suggested handling:** a lock snapshot with chat reads (owner decision 2026-10-24: only if needed), or let authoritative lock lists alone end feed locks instead of a newer whole read (changes the release policy; audit the collection-removal paths, which drop revisions without clearing feed locks).

### Parked resends leak

`src/ts/storage/chatStore.svelte.ts` `dropCharacterWork(id, false)` from `takeChatWork`'s absent-character sweep (~3505, the quarantined-create path) parks in-doubt resends (`parkResends`); no deletion acknowledgement or `forgetCharacter` ever comes for a character the server never had, so the entry stays until `seedChats` (boot) or a re-add of the same id, which would replay a harmless resend first. Accepted trade-off of open-bug-fixes slice A3 (landed on metatron 2026-10-19 via plan-runner), noted by its Fable reviewer. Still present 2026-10-21 (`parkedResends`, chatStore.svelte.ts ~180).

**Why it matters:** tiny memory leak per session; a far-later same-id re-add sends one extra replay.

**Suggested handling:** if it matters, drop parked resends once the adapter knows the abandoned character has no server incarnation and no unresolved create can still establish one, and also clean entries parked in an earlier cycle. `persisted` alone is not that proof: a removed character whose create answer was lost is resent while `persisted` lacks it (resourceSync.svelte.ts ~1387), and a same-id re-add still needs the preserved group ids (checked 2026-10-24). Parked payloads can hold whole chat snapshots, so the leak is not always tiny.

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

## Chat screen

### Memory limit line not drawn

The Display settings still offer `showMemoryLimit` and `memoryLimitThickness` (`src/ts/setting/displaySettingsData.svelte.ts:294-305`), and assembly still writes `Chat.lastMemory` (`server/src/prompt/assemble.ts:1629`, `server/src/prompt/runner.ts:1286-1294`), but no chat renderer reads either: the `isLastMemory` prop was removed in `29f53d3f6` (2025-06-07, "New chat loading"). Found 2026-10-25 while planning the context usage meter.

**Why it matters:** the setting does nothing, and users expect a line where the model's history starts.
**Suggested handling:** restore the line in `Chats.svelte`, or remove the two settings. `lastMemory` is set before the final recheck (`assemble.ts:1940`), so it can be off by the entries the recheck removes; the context usage meter's report ([archived plan](../archived-plan/README.md)) could supply the exact kept ids.

### Stale fold index at a chat switch

Switching away from a folded chat (`foldChatToMessage`) opens the next chat's rows with the old `chatFoldedStateMessageIndex.index`: `Chats.svelte`'s structural effect runs before the `$effect.root` pair in `src/ts/globalApi.svelte.ts` (~1508-1536) clears `chatFoldedState.data` and resets the index to -1 in the same flush. The opening diff therefore stages a window that ends at the old fold index, and the rerun right after it shows the full window, which arms every staged row. A diff that keeps the shown rows (a reload, a context change) no longer arms them, but this rerun changes the window. Reproduced in a browser on 2026-10-25 (fold to index 20, then switch chats of one character: four of four switches); found while finding the module reload trigger of the same symptom.

**Why it matters:** the opening's first stage is mounted for the wrong window, and every row of the chat is then mounted before the first reveal.
**Suggested handling:** read the fold index in `Chats.svelte` only while `chatFoldedState.data` targets the shown chat (the three `src/lib/ChatScreens/Chats*.svelte.test.ts` files mock `src/ts/globalApi.svelte` inline and would need `chatFoldedState` too), or reset the fold where the chat selection changes rather than in an effect.
