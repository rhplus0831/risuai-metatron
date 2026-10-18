# Data-Loss Under Concurrency Plan

Status: 1a (2f79a2300), 7a (b0fe3d017), 1b (498d87228), 1c (a1be19605), 8 (394b8daa9), 3 (49359f49a), 4a (3d5b7dd24), 2a (1e3c4b036), 5a (00e3bf538), 2b (748746575), 5b (36cff0a4c), 4b (2c3f9c1c1) landed. Source: the cross-verified static audit
`docs/audit/data-loss-concurrency-2026-10-18.md` at `5e7595689` (raw reports and
challenges at `/home/codex/metatron-report-concurrency/`). One slice is one session,
one commit, one file cluster. Every cited location was re-verified against the working
tree at `5e7595689` on 2026-10-18; the report's line numbers are approximate, the
identifiers below are the anchors.

Decisions made by landed slices: 1a keeps `setMessage` as a by-id op that applies on a
stale revision and documents it as "needs the current revision for the fields it does not
own" (not enforced); `patchMessage` carries no generation (refused with 400) and always
closes an open generation fence; `meta` ops with `mergeUnset` are not coalesced on the
client. 1b added `patchMessage` to the unload op list and the post-create id rewrite in
`chatStore.svelte.ts`, taught `mergeChatMeta` entry removal and tested `coalesce`. 7a's
`chatFolderOf` is used by `SideChatList.svelte` only: the pinned rail and the modal chat
list do not group chats by chat folder; a drag does not clear a dangling `folderId`.
1b also moved the DevTool variable editor to `mergeChatMeta` and made `applyChatResult`
merge the `CHAT_META_MERGE_KEYS` map fields entry by entry (a plugin `setChat` that changes
one variable no longer replaces the map); `/setvar` on an unloaded chat is a no-op. 1c's
merge rule (`shared/memory.ts` `mergeHypaV3Write`/`mergeHypaV2Write`): a summary's identity
is its `chatMemos` (a V2 main chunk's its id plus them); the job's orphan removals and
appended summaries are placed onto the stored value, every other stored summary stays as
stored, and the write is skipped with a server warning when the stored tail moved, an
identity is duplicated, or a new summary covers a covered message. The tab-side fence
uses `sendingChatRef` and `generatingChatKeys()` (not `isChatGenerating`, which misses the
pre-lock memory step and previews); a refused change is undone in the copy, not replayed
after the job; the modal no longer writes the empty default of a chat without memory data.
3 keeps the prereroll candidates in a `Map` with the chat and message they were generated
in (`addRerolls(genId, values, ref, messageId)`, one-line change in `serverGeneration.ts`):
a copied chat does not use them, empty candidates are skipped, and the cursor never rests
past the last one. 4a's notice is a non-modal panel (`ReloadNotice.svelte`, `z-[60]`,
mounted before the terminal notice) over `alertReloadNotice`/`dismissReloadNotice` in
`alert.ts`; `reloadDeferredChats` decides "replaced" by `chatDiscardSequence()` moving; the
backup export names a discard in its success alert (`backupDiscardedChanges`), not the keys.
2a's `ChatConflict.messageIds` lists only the locked messages the refused group's ops
target (not every lock of the chat); the split (`dropLockedEdits`) also filters the chat's
newer unsent work, runs before the unrelated conflict reads, marks the chat stale instead of
re-reading it at once, and the reroll rollback (`restoreUnsentRemoval`) runs whenever
`sendChatMain` reports no send, not only on `GenerationBlockedError`; `hasChatWork` counts
empty pending entries. 5a tells plugins through an event, not an acknowledged promise:
`risuai.onStorageDiscarded(cb)` gets `{ type: "storageDiscarded", pluginStorage, localPluginStorage,
customStorage: boolean }` (custom key names need the `db` permission, so only a flag); a
concurrent creation of the record merges against an empty base; a list-shaped base is read
as entries, a list on either side conflicts whole.
2b carries the locks as a frame-level `streaming?: ChatStreaming[]` on the `change` frame
(not inside `ChangeSet.chats`), computed in a new `committed` hook of `applyChanges` (after the
commit, before the publish; a hook failure publishes without the lists and raises
`CommittedWriteError`), and `finalize` republishes every chat the job locked; the tab keeps the
feed locks in a separate `feedLocks` map (edit/UI predicates only: `isMessageLocked`,
`assertUnlocked`, `isChatGenerating`, `lockedChatKeys`), while the save loop's reads, patches
and deferrals use `isChatStreamedHere` (this tab's job locks) and `isCharacterGenerating`
counts only this tab's job locks; a whole read releases a feed lock only when newer than the
frame that announced it, and a feed `hello` drops them all. 5b rebases only added items
(`mergeItemAdds` over `ITEM_LIST_MERGE_KINDS`: modules, presets, personas, credentials,
modelPresets, modelProfiles; appended after the server's list), a changed, removed or
reordered saved item still conflicts; `addImportedModule` shows `successImport` after
`flushResources({ scope })`, `moduleImportDiscarded`/`moduleImportUnconfirmed` otherwise.
Known interaction found at this point: `resourceSyncHydration.test.ts` "handles an ordinary conflict and a generating refusal in one batch" failed on the base once 2a landed over 4a (`recoverFromConflict` showed the reload notice once for the dropped locked edits and once for the record reload). 4b fixed it: `recoverFromConflict` now shows the notice once in a `finally`, when the recovery discarded anything. 4b's decisions: no "notice owed" flag crosses cycles (a `try/finally` around the recovery shows the notice in the same run even when a read throws; the remaining `hydrate` entries are the next cycle's stage, which notices its own discards); the post-acknowledgement membership refresh is a separate `listRefresh` set applied through `applyRemoteCollection` with `keepPendingOrder` (this tab's order kept, new chats appended, the reorder held back by `holdOrders` until the refresh and then sent on the new revision), and a kept chat with a held revision missing from the server's list discards the reorder with the report and notice; a discarded reorder is reported as `chats/<chaId>`, the order-obligation key; a reorder whose retry conflicted is settled without a report (its answer may have been lost); a queued chat delete that another tab's character deletion fulfils is settled silently; the two tests the slice placed in `resourceSync.test.ts` live in `resourceSyncChats.test.ts` (that file's fake server has no chats).

The audit's question: where can a change the UI already treats as saved end up absent
from the server database, be overwritten by an older copy without notice, or be
deleted when it should not be, under concurrent tabs, concurrent chats, or a job writing
while a tab edits. The transactional core was found sound; the losses are in the write
semantics the store accepts (whole-value writes on a stale revision) and in the client's
recovery paths (retry after a generation, discards without the promised notice). The
plan covers the report's confirmed findings A1–A4, B1–B5, C1 and D1–D6, the OQ4 variant
of A1, and its four documentation corrections.

## How the work is sorted

1. **Root cause first.** The report's suggested fix order is kept: the field-level
   write semantics (A1, A2, A3) come first because they close the OQ4 variant and half of
   D1 as a side effect; the generation-refused retry (A4) and the one deterministic
   single-tab loss (C1) follow; the notice and recovery paths (B1–B5) come next; the
   failure-injection and reload-repairable items (D1–D6) last.
2. **Same mechanism, one slice.** A1 and A3 are one mechanism (a whole value sent from a
   stale copy) seen on a message and on a metadata map; they share the server op slice and
   the client caller slice. B1's four reports are one path (`hydrateCharacters` →
   `acceptRemoteCollection`/`acceptRemote` discarding without a report). D1 and B5 are
   both "a replayed or orphaned by-id op fails the whole group".
3. **Same files, sequential; different files, parallel.** Two file clusters are shared
   by several slices and define two ordered sequences (see "Order" below): the chat
   write path (`shared/chats.ts`, `server/src/data/chatStore.ts`,
   `src/ts/storage/chatStore.svelte.ts`) and the save adapter
   (`src/ts/storage/resourceSync.svelte.ts`). Everything else runs in parallel sessions
   in their own worktrees.

Each slice names its guide from `STRUCTURE.md` Choose By Task; the guide's `Invariants`
apply (D1, D4 above all: by-id ops and per-field metadata may apply on an older chat
revision while their targets exist, and that stays true). The fix direction is the
report's unless stated otherwise. Every slice updates the owning guide's `Flows`,
`Invariants` or `Known Hazards` where it changes a documented contract.

Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow` or
`delegate-implementation` for one marked _hard_. Each slice ends with its regression
test (listed under "Test"), `pnpm check`, `pnpm --silent test:agent` (with
`--tags-filter=slow` for the storage suites it touches) and the guide's focused checks.

## Order

- **Sequence A, the chat write path** (one at a time, in this order): 1a → 1b → 2a →
  2b → 4b → 6a → 6b → 6d. Each touches `server/src/data/chatStore.ts` and/or
  `shared/chats.ts` (1a, 2a, 6a, 6b) or `src/ts/storage/chatStore.svelte.ts` (all of
  them).
- **Sequence B, the save adapter**: 4a → 5a → 5b → 6c → 7b. Each touches
  `src/ts/storage/resourceSync.svelte.ts`. 4b and 6d also touch it: run 4b after 4a, and
  6d after both sequences are done.
- **Independent** (any time, in parallel with either sequence): 1c, 3, 7a, 8.

## Phase 1: Field-level message and metadata writes

A1, A2, A3 and the OQ4 variant. A whole value sent from a copy that is behind reverts
another writer's change with `stale: true` as the only signal.

- **1a. Field-patch message op and key-level metadata merge on the server** (_hard_,
  `self-host-server.md` with `persistence.md`). A1, A3 (server half).
  `shared/chats.ts` `ChatOp` has `setMessage` (whole row, `translation` excepted) and
  `meta` with `set`/`unset`/`merge`, where `merge` is allowed only for
  `CHAT_META_MERGE_KEYS` (`toolCalls`, `GLGlobalVariables`). In
  `server/src/data/chatStore.ts`, `prepareChatGroups` (`needsCurrent`) admits
  `setMessage` on a stale revision, the `setMessage`/`setText` branch takes only
  `translation` from the stored row, and the `meta` branch does
  `Object.assign(current, op.set)`. Add a by-id field patch op
  (`{ op: "patchMessage", id, set, unset, generation? }`) that merges onto the stored
  row like `setText` does for `data`, with the same generation fence and translation rule
  as `setMessage`, and its client-side coalescing rules next to `setText` in
  `coalesce`; add `scriptstate` to `CHAT_META_MERGE_KEYS` and give `merge` a per-key
  unset (`mergeUnset?: Record<string, string[]>`, applied before the entries), so a
  variable can be removed without replacing the map. Keep `setMessage` for whole
  replacements, but document it as "needs the current revision for the fields it does
  not own" or require the current revision for it (decide at the slice; the report
  offers both; the former keeps D4's by-id rule intact). The job's own
  `scriptstate` write in `server/src/jobs/jobScope.ts` `chatMetadataFor` (flush:
  `set.scriptstate = { ...current.scriptstate, ...pending.scriptstate }`) can become a
  `merge` too, dropping its pre-write refresh dependency for that key.
  _Done_: a `setText` from tab 1 followed by a `patchMessage { set: { disabled: true } }`
  from tab 2 on tab 2's older revision keeps tab 1's text; a `meta merge { scriptstate }`
  from two writers keeps both keys; `mergeUnset` removes one key and keeps the rest.
  _Test_: `server/src/tests/chatStore.test.ts` next to "applies by-id ops on a stale
  revision" (which pins whole replacement today; keep it for `setMessage`, add the two
  writers on one message), `server/src/tests/chats.test.ts` for the op's validation.
- **1b. Client callers on the field-patch and merge ops** (_hard_, `persistence.md`
  with `chat-pipeline.md` and `cbs-rendering.md`). A1 (callers), A3 (callers), OQ4.
  Runs after 1a. `src/ts/storage/chatStore.svelte.ts`: a `patchMessage(ref, id, set, unset)`
  mutation beside `replaceMessage` (same `assertUnlocked`, same `translation`
  handling), and `applyChatResult`'s per-message merge (it already computes a per-field
  diff against the baseline and then calls `replaceMessage` with the merged row) emits
  that patch instead of the whole row. Move the whole-message callers to it: the Disable
  and Disable-above toolbar buttons in `src/lib/ChatScreens/Chat.svelte` (both build
  `{ ...$state.snapshot(currentMessage), disabled }` and call `replaceMessage`) and the
  playground role swap in the same file; the v3 plugin chat setters go through
  `applyChatResult` and follow. `src/ts/parser/chatVar.svelte.ts` `setChatVarOf` sends
  `setChatMeta(ref, { scriptstate: { ...snapshot, [key]: value } })`: send a `merge` of
  the one key (and `mergeUnset` for a removal) through `mergeChatMeta` (the existing
  `toolCalls` merge helper) instead; same for every other tab-side `scriptstate` writer
  (`/setvar`, `/addvar`, the client lore decorators, plugin `runVar`; a bounded
  `rg -n "scriptstate" src/ts` lists them). `replaceMessage` stays for callers that mean a whole
  row (imports, `replaceChat`). With only `disabled` on the wire, the OQ4 variant (the
  mirror still holds the raw streamed text after a refused final hydration, and Disable
  sends it over the processed reply) closes without touching the hydration path.
  _Done_: the toolbar toggles, the playground swap and a plugin `setChat` that changes
  one field of one message queue a `patchMessage` with only that field; `/setvar` queues
  a `meta merge`; a tab whose copy is stale cannot revert another tab's `setText` by
  toggling Disable.
  _Test_: `src/ts/storage/tests/chatStore.test.ts` (the new mutation, its coalescing with
  `setText`/`setMessage` of the same id, the lock check), `src/ts/parser/tests/chatVar.svelte.test.ts`
  (the queued op shape), a `storeBackedServer.ts` scenario in
  `src/ts/storage/tests/resourceSyncChats.test.ts`: two tabs, one `setText`, the other
  Disable on an older base, both end with the text and the flag.
- **1c. Memory data written from the refreshed stored value** (_hard_, `memory.md`
  with `self-host-server.md`). A2. Independent of 1a/1b (no new op).
  `server/src/prompt/assemble.ts` reads `room.hypaV3Data`, awaits `hypaMemoryV3`, then
  `host.writeMemory(() => ({ hypaV3Data: data }))` three times (the V2 path once);
  `writeMemory` in `server/src/prompt/runner.ts` refreshes the chat and passes the
  stored chat to the builder, which the zero-argument builders ignore (the
  `supaMemoryData` write a few lines down already uses `(stored) => ...`). Build the V3
  write from the stored value: carry the algorithm's input (`room.hypaV3Data` as read)
  as the baseline, merge summaries by id and the explicit deletions onto the stored
  data, and recompute or skip the write when the stored value's summary set differs from
  the baseline in a way the merge cannot express (decide the rule in
  `shared/memory.ts`, where the types live, so the modal can reuse it). The V2 path
  gets the same treatment where its shape allows. On the client,
  `src/lib/Others/HypaV3Modal.svelte` saves every change through
  `setChatMeta(ref, { hypaV3Data })` from its synced copy with no generation check: refuse (alert
  `chatGenerating`) while `isChatGenerating(ref)` is true, as reroll does, and mark the
  copy for a re-sync when the job ends. `src/ts/storage/localLoreDraft.svelte.ts` sends
  the whole `localLore` array the same way; apply the same fence there (the job's Lua
  upsert already builds from the refreshed chat, so only this direction is open).
  _Done_: a manual summary edit saved during the summarization await survives the job's
  write, and the job's new summaries survive the edit; the modal and the lore draft
  refuse to write while the chat generates.
  _Test_: `server/src/tests/assemble.test.ts` or a new `server/src/tests/hypaV3MemoryWrite.test.ts`
  (a fake summary provider that resolves after an interleaved `meta set` of
  `hypaV3Data`); a modal test over the real chat module for the fence.

## Phase 2: Generation-refused ops on the locked message

A4. An observer tab (not the lock owner) edits the generating reply, is refused with
`reason: "generating"`, keeps the op for `JOB_RETRY_MS`, and the retry lands over the
finished reply.

- **2a. Discard a refused op whose target is the locked message** (_hard_,
  `persistence.md` with `chat-pipeline.md`). A4 (client half). Runs after 1b.
  `src/ts/storage/chatStore.svelte.ts` `recoverChatConflicts` requeues every group in
  `generating` and sets `jobBlocked`; the server's `refusedByLock` conflict carries no
  message ids. Add the locked ids to the 409 entry (`shared/chats.ts` `ChatConflict`
  gains `messageIds?: string[]`; `server/src/data/chatStore.ts` fills it from the lock
  table), and in recovery split the refused group: ops whose target is a locked message
  (`setText`, `setMessage`, `patchMessage`, a single `remove`, `setTranslation`,
  `begin`) are discarded with the reload notice (the message is read back with the
  chat), chat-level ops and ops on other messages keep the retry-after-job path.
  `src/lib/ChatScreens/DefaultChatScreen.svelte` `reroll` queues the removal through
  `editChatSync` and then `sendChatMain`, whose flush throws `GenerationBlockedError`
  with no rollback: on that error, put the removed bundle back (the `rerollHistory`
  slot already holds it) and show `chatGenerating`. The owner tab whose follow ended as
  `lost` (locks released while the server job continues) gets the same treatment
  through the same split.
  _Done_: the observer's edit of the generating reply is discarded with the notice and
  the final reply stands; its edit of another message still lands after the job; a
  reroll refused for a generation leaves the chat as it was.
  _Test_: `src/ts/storage/tests/resourceSyncHydration.test.ts` "keeps a refused message
  edit, retries it once after JOB_RETRY_MS" currently asserts the retry lands after
  `endJob` with no final write in between (it pins the hazard): extend it with a final
  write before the retry and assert the final text wins for the locked id while the
  other message's edit lands; a `DefaultChatScreen` reroll test for the rollback.
- **2b. Generation ownership on the change feed** (_hard_, `self-host-server.md` with
  `persistence.md`). A4 (server half). Runs after 2a. Only the owner's job socket
  announces the lock (`serverGenerations` in the chat module is fed by the job channel's
  `streaming` entries, `shared/jobs.ts`); the change feed (`shared/events.ts`
  `EventFeedFrame`, `server/src/data/changeFeed.ts`) carries refs and patches but not
  streaming owners, so an observer tab shows the checkpoint text as editable. Publish
  the lock in the feed: the `change` frame of a job's chat write carries the chat's
  `streaming` list (the same `StreamingMessage` shape the hydration uses), and a lock
  release (the final write, or `endJob` at `finalize`) publishes the empty list.
  `src/ts/network/eventFeed.ts` → `noteRemoteChat` installs a placeholder lock for a
  listed message exactly as a chat hydration listing it as `streaming` does today
  (sequence below every protocol sequence, buffer the mirror's text), and releases it on
  the empty list or the chat's next whole read. With the lock in place the observer's
  edit, delete and regenerate controls are off (`isMessageLocked`), so 2a's discard path
  becomes the fallback for the race between the lock frame and the edit.
  _Done_: an observer tab shows the generating reply locked within one feed frame of the
  job's first checkpoint and unlocked after its final write, without a job socket.
  _Test_: `server/src/tests/changeFeed.test.ts` (the frame carries `streaming` on a job
  write and the empty list on release), `src/ts/storage/tests/resourceSyncFeedPatches.test.ts`
  (the placeholder lock from a feed frame, released by the final frame; an edit between
  the two frames goes through 2a).

## Phase 3: Reroll history content refresh

- **3. Snapshot the outgoing tail before the history keeps or swaps it** (_small_,
  `chat-pipeline.md`). C1. Independent. `src/ts/process/rerollHistory.ts`: `begin`
  keeps the slot when the anchor matches and `sameIds` holds for the removed bundle
  without refreshing the bundle's content, and `move` swaps in the stored
  clone of `slot.bundles[cursor]` after checking only ids. Edit R1 → R1′ (saved), reroll
  (R2), swipe back: R1 returns and R1′ is gone, persisted by `editChatSync`. Before
  `begin` keeps the slot and before `move` replaces the tail, store a clone of the
  current tail (the messages after the anchor, as the chat holds them now) into
  `slot.bundles[slot.cursor]`. `src/ts/process/prereroll.ts` candidates (`Prereroll`,
  `PreUnreroll`, keyed by `generationId`) have the same shape: apply the same refresh
  when a candidate is swapped away, or record the edit into the candidate.
  _Done_: edit R1, reroll, back → R1′; edit R2, back, forward → R2′; a group bundle of
  several messages with one edited member round-trips.
  _Test_: `src/ts/process/rerollHistory.test.ts` (the two sequences above beside the
  existing "back and forward swap the stored bundles and persist"), a `prereroll` case.

## Phase 4: Notice reliability and discard reporting

B1 and B2: the documented "discard with a notice" is silent in several reachable cases.

- **4a. A dedicated reload notice, latched until dismissed** (_small_, `global-api.md`
  with `persistence.md` and `backup-sync-hub.md`). B2. Starts sequence B.
  `src/ts/storage/resourceSync.svelte.ts` `showReloadedNotice` uses a tab-global
  `noticeShown` latch reset by a 10 s timer, not tied to acknowledgement, and
  `reloadDeferredChats` calls it even when nothing was discarded (every deferred reload
  discards by contract, but a chat whose read found nothing to replace shows the notice
  too and consumes the window). `src/ts/alert.ts` `alertNormal`/`alertWait`/`alertError`
  share one `alertStore` with no queue, so any later alert replaces the notice; the
  terminal notice already has its own store (`terminalNoticeStore`, single-flight,
  resolves on acknowledgement). Give the reload notice the same shape: its own store and
  rendering beside the terminal notice, shown until dismissed, with the latch held until
  then (a second discard episode while it is on screen keeps it; one after dismissal
  shows it again). Call the deferred-reload notice only when a chat was replaced.
  `src/ts/drive/backuplocal.ts` `downloadArchive` awaits `flushResources()` and ignores
  its `discarded` list, and its progress `alertWait` plus "Success" replace any notice:
  when `discarded` is non-empty, say so in the success alert (or keep the reload notice
  visible under its own store, which the first change gives for free).
  _Done_: two discard episodes 3 s apart each reach the user; a backup export's
  progress alerts do not hide a discard from its pre-backup flush.
  _Test_: `src/ts/storage/tests/resourceSyncNotices.test.ts` (episode after dismissal,
  episode while shown, deferred reload with nothing replaced shows nothing),
  `src/ts/drive/backuplocal.test.ts` (the `discarded` list in the result).
- **4b. Discard reports from the hydration path** (_hard_, `persistence.md`). B1.
  Runs after 4a and 2b (sequence A and B). `src/ts/storage/resourceSync.svelte.ts`
  `cycle` runs the four stages (`reloadDeferredChats`, `hydrateCharacters`,
  `applyRemoteUpdates`, `refreshIdleChats`) and ignores `hydrateCharacters`' boolean; `recoverFromConflict`
  awaits `hydrateCharacters()` after `acceptRemote` and, if that read throws, never
  reaches `showReloadedNotice` (the `reloaded` flag is local to the call).
  `src/ts/storage/chatStore.svelte.ts` `acceptRemoteCollection` settles the pending
  order (`settleOrder`) and drops absent members' work (`discardChatWork(key, 0)`)
  without a report; `forgetCharacter` (called from `collectOperations` when a feed
  deletion removed the character, `resourceSync.svelte.ts` under `characterPrefix`)
  settles the chats' work so `flushResources` resolves `{ discarded: [] }`; the
  gone-chat branch of `recoverChatConflicts` (`server.revision === null`) does not set
  `reloaded`. Make `acceptRemoteCollection`, `acceptRemote` and `forgetCharacter` return
  what they discarded (keys with a sequence, through `markDiscarded`, so the
  `MutationScope` report and the notice see them), honour the stage result in `cycle`
  and keep the "notice owed" flag across cycles in `recoverFromConflict` (set before the
  await, cleared by the notice). Route the post-acknowledgement membership refresh (the
  create acknowledgement that lists another tab's new chat) through the guarded
  `applyRemoteCollection` path, which keeps a newer pending order (today the reorder
  queued after the acknowledgement is settled unsent and the list snaps back; the
  existing "learns about chats another tab created when its own create is acknowledged"
  test runs the sequence without asserting the order).
  _Done_: the four reachable cases in the report each show the notice and report the
  discarded keys: the settled reorder (now kept and sent), the unsent append in a chat
  of a character another tab deleted, the chat another device deleted while this tab
  generates in a sibling chat, and the recovery whose `hydrateCharacters` read failed.
  _Test_: `src/ts/storage/tests/resourceSyncChats.test.ts` (extend the create-ack test
  with the order assertion), `resourceSync.test.ts` membership and conflict groups (the
  deleted character's append reported, the failed hydration read noticed next cycle),
  `resourceSyncHydration.test.ts` (sibling chat deleted during a generation).

## Phase 5: Key-level and item-level rebase on conflict

B3 and B4: the send path is key- or item-level but the 409 path replaces the whole
record.

- **5a. `pluginStorage` key-level merge and a plugin-facing discard event** (_hard_,
  `persistence.md` with `plugins-mcp.md`). B3. Runs after 4a. All v3 keys share
  `_pluginStorage` (and `_safeLocalPluginStorage`, plus the top-level `setDatabase`
  keys) in the one `pluginStorage` record (`src/ts/storage/pluginStorageStore.svelte.ts`);
  `src/ts/storage/resourceSync.svelte.ts` `mergeConcurrentChange` accepts only
  characters and `statics`, so two tabs writing disjoint keys lose one tab's delta with
  the generic notice. Extend the merge to `pluginStorage`: a change is benign when every
  key the server changed against the base (inside each namespace, one level down) is one
  this client did not touch; merge per key, keep the record dirty, no notice; a same-key
  edit still conflicts (the `v3SavedWrites.test.ts` "a record another tab changed is
  reloaded on the conflict and not echoed back" case stays for that). `_setPluginStorage`
  resolves at queue time and no plugin hears of a discard: add a persistence outcome
  for plugins (resolve the v3 `setItem` promise at acknowledgement, or raise a
  `storageDiscarded` event with the keys; decide with `plugins-mcp.md`'s event model),
  wired from the `MutationScope` discard report.
  _Done_: two tabs writing disjoint plugin keys end with both keys on the server and no
  notice; a same-key race discards with the notice and the plugin is told.
  _Test_: `src/ts/plugins/apiV3/v3SavedWrites.test.ts` (disjoint keys merge; same key
  discards and the event fires), `src/ts/storage/tests/resourceSyncMerge.test.ts` (the
  new kind in `mergeConcurrentChange`, a namespace added by the other tab).
- **5b. Collection adds rebased on conflict; import success after acknowledgement**
  (_hard_, `persistence.md` with `characters-modules.md`). B4. Runs after 5a. For an
  `itemIds` collection (modules, presets, personas, credentials: `shared/recordPatch.ts`
  `itemIds`, used by the send path's item patches) the 409 path `acceptRemote` replaces
  the whole list, so a module import that already showed `successImport` is discarded by
  any concurrent edit of a different module
  (`src/ts/storage/tests/resourceSyncPatches.test.ts` "leaves a patch alone while this
  tab has an unsent module change" pins disjoint-item loss). In `mergeConcurrentChange`
  (or a sibling for item lists), re-apply items whose id is in neither the base nor the
  server list over the server list, keep the record dirty, and let a changed item that
  both sides touched conflict as today. `src/ts/process/modules.ts` shows
  `alertNormal(language.successImport)` right after `addModule`: show it after the
  record is acknowledged (`flushResources({ scope })` with the `discarded` check, as
  the backup export does for its flush) and an error when the add was discarded.
  _Done_: a module imported while another tab renames a different module ends with both
  changes; the import alert waits for the acknowledgement and reports a discard.
  _Test_: `resourceSyncPatches.test.ts` (flip the pinned case for an added item; a
  changed item still conflicts), `resourceSyncMerge.test.ts` (presets, personas),
  `src/ts/storage/tests/moduleImportClient.test.ts` (the alert timing).

## Phase 6: Replay, in-doubt and acknowledgement bookkeeping

B5 and D1–D4: medium items that need failure injection, plus one high (B5) whose lost
content is a new message.

- **6a. Per-op missing-target outcomes** (_hard_, `self-host-server.md` with
  `persistence.md`). B5. Runs after 4b. In `server/src/data/chatStore.ts`, `setText`,
  `setMessage` (and 1a's `patchMessage`), `begin` and `setTranslation` on a message
  another tab removed call `conflictHere` (the whole group fails, the conflict carries
  no cause) while a single `remove` of a missing id is a no-op; on the client
  `recoverChatConflicts` → `acceptRemoteChat` → `discardChatWork` drops the whole
  pending queue of that chat, including work queued during the read-back (a new
  append), under a notice that blames another writer. Report a missing target as a
  per-op outcome instead (`ChatGroupResult.targets?: ("applied" | "missing")[]`, one
  per by-id op, as `translations` reports `ignored`), so the independent ops of the group
  commit; keep the current behaviour only for a multi-id `remove` and for an `append`
  whose anchor is gone, where the client re-anchors the append explicitly (an
  `{ end: true }` anchor after a read-back that shows the anchor missing) instead of dropping it. The
  client drops a `missing` op from its mirror bookkeeping (the message is gone; the
  idle read removes it) without discarding the rest.
  _Done_: `[setText m1, append m2]` where m1 was removed meanwhile commits m2 and reports
  m1 missing; the client keeps m2 and shows no notice; an append after a removed anchor
  lands at the end.
  _Test_: `server/src/tests/chatStore.test.ts` (outcomes per op, the multi-id and
  anchor cases unchanged), `src/ts/storage/tests/resourceSyncChats.test.ts` (the client
  side of both).
- **6b. Group idempotency ids** (_hard_, `self-host-server.md` with `persistence.md`).
  D1. Runs after 6a. A failed batch requeues the same ops on the same base
  (`resourceSync.svelte.ts` `cycle` catch → `requeueChatWork(batch.work)`;
  `chatStore.svelte.ts` `requeueRecovered` prepends the group to the newer pending ops)
  with no operation id, so a replayed `setText`/`meta set` re-executes over another
  tab's later acknowledged edit (accepted, `stale: true`, no notice), and a replayed
  `append` of a message that landed compares the whole stored row, conflicts, and the
  recovery discards the newer work queued during the flight. Give each chat group a
  client-generated id (`ChatGroup.groupId`), record the ids a chat has applied with the
  chat row (a bounded list in the chat table, oldest dropped, with a schema version bump
  in `server/src/data/chatStore.ts`), and answer a replayed id with its earlier result
  (`revision` as of that group, `duplicate` for its checkpoints) without applying it.
  The client resends a lost group alone (the existing create resend rule: "resent
  exactly as sent, followed by later work") and sends newer work as its own group, so
  a replay answered as duplicate never carries the new work down with it. 1a and 1b
  already halve the exposure: a `patchMessage` or `meta merge` replay re-applies only
  its own fields.
  _Done_: a lost-response replay of `[append m, setText m]` is answered as a duplicate
  and the work queued during the flight lands in its own group; a replayed `setText` over
  another tab's later edit does not revert it.
  _Test_: `server/src/tests/chatStore.test.ts` (duplicate answer, bounded id list,
  older schema row without the list), `resourceSyncChats.test.ts` (lost response then
  newer work, through `storeBackedServer.ts` with a dropped answer).
- **6c. In-doubt text after a lost response** (_small_, `persistence.md`). D2. Runs
  after 5b. After a lost answer on a resource record nothing remembers the sent text:
  `recoverFromConflict` recognizes a lost write only through `sent.get(key)` of the
  batch in hand (`sameJson(op.text, text)`); a revert to the saved value sends nothing
  and the feed echo re-applies the lost write silently, and continued typing in the
  same field 409s and is discarded under the "another tab" notice. Keep the last sent
  text per key as in-doubt (`persisted`-shaped, cleared on acknowledgement, a feed echo
  equal to it, or a later successful write) and let the 409 path and `applyRemotePatch`
  compare against it as they compare against `op.text` today, so a server record equal
  to the in-doubt text is a lost answer (no discard) and the key's newer text is
  rebased onto it.
  _Done_: a lost answer followed by more typing in the same field saves the newer text
  with no notice; a revert after a lost answer sends the revert.
  _Test_: `src/ts/storage/tests/resourceSync.test.ts` "lost acknowledgement" group
  (continued typing, revert, feed echo).
- **6d. Forget on acknowledgement and an acknowledged-revision floor** (_hard_,
  `persistence.md` with `chat-pipeline.md`). D3, D4. Runs last, after both sequences.
  D3: `resourceSync.svelte.ts` `collectOperations` calls `forgetCharacter(id)` when the
  delete is collected, not acknowledged; a later same-id add (plugin/MCP `setDatabase`,
  the `§playground` character recreated under its fixed id) finds no held revisions and
  queues nothing, and `chatStore.svelte.ts` `isCharacterKnown` then skips the chats
  while the flush reports success. Forget the chat state when the delete's
  acknowledgement arrives (`ackChatWork` / the resource ack path), and when a delete is
  requeued or refused while the id is present again, hydrate the id (`hydrate.add`). D4:
  `refreshStaleChat` (`resourceSync.svelte.ts`, the pre-send read `runServerJob` uses)
  reads outside the single-flight cycle, a stale acknowledgement keeps the held base,
  so an older read answer passes the post-await checks and replaces the mirror after a
  stale-acknowledged edit, clearing the stale mark; the barrier's remembered `hydrateAll`
  copy does the same under an active lock. Track the highest acknowledged revision per
  chat separately from the held base (`ackChatWork` records the result's revision) and
  refuse any copy below it in `finishIdleChatRefresh`, `hydrateChat` and the barrier.
  _Done_: delete then re-add of one id saves the replacement's chats; an older read
  arriving after a stale acknowledgement is dropped and the stale mark stays.
  _Test_: `src/ts/storage/tests/resourceSyncRecreation.test.ts` (same-id re-add after a
  failed and after a blocked delete), `resourceSyncHydration.test.ts` (the older read
  and the remembered copy under a lock).

## Phase 7: Folder and order repair after replacement

- **7a. A chat whose folder does not exist renders as unfiled** (_small_,
  `ui-theming.md` with `persistence.md`). D6. Independent.
  `src/lib/SideBars/SideChatList.svelte` renders a chat only under a folder whose id
  equals its `folderId` (`chats.filter((chat) => chat.folderId == chara.chatFolders[i].id)`)
  or at the root when `chat.folderId == null`, so a dangling id hides the chat across
  reloads, and the drag handlers build the permutation from the visible rows, so
  `reorderChats` throws "needs a permutation" for that character. The id dangles after a
  two-tab move/delete race (different records, no 409) or, single-tab, after a
  branch-with-folder or chat import whose character part 409s and whose chat
  `folderId` is requeued. There is no server folder-delete transaction to extend
  (folders are a character field, the delete is a client batch of the character write
  plus per-chat `setChatMeta(ref, {}, ["folderId"])`), so the reader default is the fix:
  one helper (`chatFolderOf(chat, folders)` → the folder or null) used by the list, the
  pinned rail and the modal chat list, and the permutation built from every chat. The
  same slice may take E7 (the folder delete uses the `#each` index after its confirm
  await) since it is the same handler: resolve the folder by id after the await.
  _Done_: a chat with a dangling `folderId` shows at the root and can be dragged; a
  folder deleted while another tab moves a chat into it leaves that chat visible.
  _Test_: `src/lib/SideBars/SideChatList.test.ts` (dangling id at the root, reorder with
  one dangling member, delete after a concurrent `unshift`).
- **7b. `checkCharOrder` after an order replacement** (_small_, `persistence.md` with
  `app-shell.md`). D5. Runs after 6c. `src/ts/storage/characterOrder.ts`
  `checkCharOrder` appends characters missing from `characterOrder` and is called from
  boot, every character add/remove/import and the sidebar, but nothing calls it after a
  conflict reload of the `characterOrder` record or a remote replacement of it
  (`acceptRemote`, `applyRemotePatch`), so a character created while another tab writes
  the order drops out of the sidebar until the next call. Register a remote-change
  listener at boot (`onRemoteRecordApplied`, as the inlay cache invalidation does) that
  runs `checkCharOrder` for `characterOrder`; it writes only when the repaired order
  differs, so no loop. E5 (a not-yet-inserted character stripped from its folder by a
  capped read that applies the order before the character) is the same listener's
  concern: skip the repair while the character read is still pending for that cycle.
  _Done_: a character created in tab A while tab B reorders is in B's sidebar after B's
  reload or patch, in its folder.
  _Test_: `src/ts/storage/tests/resourceSyncLive.test.ts` (patch and whole-record
  replacement of the order with a new character), `resourceSync.test.ts` conflict group.

## Phase 8: Documentation corrections

- **8. The four corrections the audit found** (_small_, `persistence.md`,
  `self-host-server.md`, `chat-pipeline.md`). Independent; if 7a has landed, describe
  its behaviour instead of the first item's current one.
  - `docs/structure/persistence.md` "Folder moves touch the character (`chatFolders`),
    the chat (`folderId`), and the chat order; a conflict on one of them can leave them
    inconsistent until a reload": nothing on boot clears a dangling id, so the
    inconsistency persists across reloads (D6); after 7a, say the list renders such a
    chat as unfiled.
  - `docs/structure/persistence.md` Save step 9 ("a character deferred or generating" is
    not read) and the `applyHydration` doc comment in `resourceSync.svelte.ts` ("(a
    character) not deferred behind a generation") claim a tab-side character deferral
    that slice 3c of `audit-findings-perf.md` removed; `resourceSyncLive.test.ts`
    "applies a generating character's update at once" pins the new contract.
  - `docs/structure/self-host-server.md` Known Hazards: "asset writes are not retried"
    is false; `src/ts/storage/assetClient.ts` retries a network failure and 429/503 up
    to eight times with backoff.
  - `docs/structure/chat-pipeline.md` Known Hazards: the whole-chat result note
    ("last-writer semantics per message and field") should say the plugin chat setters
    diff against the chat at call time (`captureChatBaseline` right before the hook),
    not at read time.
    _Done_: the four passages read as the code behaves; `pnpm format:check` passes.
    _Test_: none (docs only).

## Not in this plan

- The low findings E1–E6 and E8 (unsent draft sent to a captured chat after a slash
  command await, spurious reload notice on a double delete, `llmSecrets` sibling edit
  discarded on a batch conflict, ownerless credential after a discarded create, auto mode
  following the selection, assets without fsync and imports skipping an existing
  content-addressed name): raise when working nearby. E7 and E5 are folded into 7a and
  7b above because they live in the same handlers.
- D7 (a deferred chat keeps accepting edits for the rest of the job and discards them at
  the end): documented behaviour with a notice; a UX note for the chat screen when 2b
  lands (the lock is then visible), not a fix.
- The three refuted or unreachable items (archive import collision on a same-key
  different-bytes pair, `customId` assets, a requeued `append` merged with a later
  `setText`).
- The report's "Checked and found safe" list: no slice weakens those guards; 1a's
  `setMessage` decision is the one place a slice may tighten one.

## Index: where each item went

| Finding                                           | Slice  |
| ------------------------------------------------- | ------ |
| A1 (server), A3 (server)                          | 1a     |
| A1 (callers), A3 (callers), OQ4 variant           | 1b     |
| A2                                                | 1c     |
| A4 (client: discard refused ops on the locked id) | 2a     |
| A4 (server: lock ownership on the feed)           | 2b     |
| C1                                                | 3      |
| B2                                                | 4a     |
| B1                                                | 4b     |
| B3                                                | 5a     |
| B4                                                | 5b     |
| B5                                                | 6a     |
| D1                                                | 6b     |
| D2                                                | 6c     |
| D3, D4                                            | 6d     |
| D6 (and E7)                                       | 7a     |
| D5 (and E5)                                       | 7b     |
| Documentation corrections (four)                  | 8      |
| D7, E1–E4, E6, E8, refuted items                  | not in |

## Continue Remaining Work

Landed slices are in the Status line. Next: 6a and 6c in parallel (both after 4b; 6a owns `server/src/data/chatStore.ts`, `shared/chats.ts` and `chatStore.svelte.ts`, 6c owns `resourceSync.svelte.ts`), then 7b after 6c, 6b after 6a, 6d last. Record each landed slice in the Status line with its commit, and the
decisions a slice made where the plan leaves a choice (1a's `setMessage` rule, 1c's
merge rule for summaries, 5a's plugin event shape, 6b's id list bound). When every
slice has landed, move this file to the archive as `docs/archived-plan/README.md`
describes and update `STRUCTURE.md`'s active-plans pointer.
