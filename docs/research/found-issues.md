# Issues Found During Work

Bugs, latent defects, stale docs and comments, and test flakes that agent sessions noticed while working on something else, between 2026-10-14 and 2026-10-24. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. They lived in the agents' project memory until 2026-10-24 and were moved here unchanged apart from link wording.

These are notes, not verified reports. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24. Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (3)

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
