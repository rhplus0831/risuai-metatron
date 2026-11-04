# Resource Sync: Boot, Save Adapter, Conflicts, Transport

## Scope

- Owns the boot load and boot cache, the save adapter, conflicts and merges, credential writes, and the resource
  transport.
- Not here: [the live-update client, feed locks, and the restore halt](live-updates.md),
  [the chat module](chat-store.md), [the journal and recovery](draft-recovery.md), [records and shapes](persistence.md),
  [the server](server-resources.md).
- A `Decision:` plan name resolves through [the archive](../archived-plan/README.md).

## Files

- `src/ts/storage/resourceSync.svelte.ts`: save and refresh adapter; `startResourceSync`, `runCycle`, `cycle`,
  `runRefresh`, `collectOperations`, `planBatches`, `recoverFromConflict`, `mergeConcurrentChange`, `inDoubt`, `saving`,
  `heldRecordRevision`, `flushResources`, `stopResourceSync`.
- `src/ts/storage/resourceClient.ts`: resource and backup transport; `readBoot`, `readKinds`, `readRefs`,
  `setResourceEpoch`, `applyBatchText`, `sendSecretRequest`, `prepareUnloadAuth`, `sendBatchOnUnload`.
- `src/ts/storage/bootCache.ts`: boot cache and answer validation; `loadBootSnapshot`, `prepareBootRequest`,
  `expandBootAnswer`, `BootCacheStore`, `indexedDbBootCacheStore`, `scheduleBootCacheCommit`, `clearBootCache`.
- `src/ts/storage/recordMerge.ts`: pure record merge policy; `mergeSectionFields`, `mergeCharacterFields`,
  `mergeItemCollection`, `mergeSelectedItems`, `SECTION_MERGE_GROUPS`, `CHARACTER_MERGE_GROUPS`,
  `COLLECTION_MERGE_POLICIES`.
- `src/ts/storage/readDeadline.ts`: caller-selected read bounds; `readWithDeadline`.
- `src/ts/bootstrap.ts`: boot ordering and handoff; `loadData`. The rest belongs to [app-shell](app-shell.md).
- `src/ts/storage/records.svelte.ts`: live record wrappers and cache stamps; `characterFieldStamp`,
  `moduleItemFieldStamp`, `adoptCharacterValue`, `adoptModuleValue`. Owned by [persistence](persistence.md).
- `src/ts/storage/chatStore.svelte.ts`: chat/order work and acknowledgement policy; `takeChatWork`, `ackChatWork`,
  `requeueChatWork`, `recoverChatConflicts`, `dropLockedEdits`, `applyRemoteCollection`, `unloadPendingChatWork`,
  `settleUnloadWork`, `assembleChats`, `orderChats`. Owned by [chat-store](chat-store.md).

## Flows

### Boot load

`src/ts/bootstrap.ts` `loadData` hands the [boot cache](#boot-cache) snapshot to the resource owners:

1. `seedResources`, `seedChats`, `seedInlays`, `seedPluginPermissions` record server state before any local change.
2. `loadSelection`, then `installBootRecords` installs into the record and chat owners. A missing section, collection,
   or `presets` record is an error: the server creates and normalizes every record, the client none.
3. `assembleChats` replaces the chat module's inventory; `initializeRecords` establishes unique character ids before
   wrappers exist.
4. `applyFirstBootDefaults`, then [boot recovery](draft-recovery.md#boot-recovery) (`recoverJournal`).
5. The service worker may reload. `maintainCharacters` runs `checkCharOrderAtBoot` over the complete recovered inventory
   before saving/feed startup; `initializeChats` gives a chatless character a chat. Recovered creation reruns no import
   transform.
6. `startResourceSync` starts saving boot's local writes; unchanged records are not sent.
7. `importBrowserLocalData`, remote-record owners, `startEventFeed`, `loadPluginsForBoot`, UI flags. Owners registered
   through `setRemoteResourceOwner` are `noteRemoteInlay`/`reconcileInlays` and `refreshPluginPermissions` (three
   retries 5 s apart).

### Boot cache

- `loadBootSnapshot` in `src/ts/storage/bootCache.ts` combines IndexedDB and `resourceClient.ts`'s `readBoot` into the
  same plain `ResourceReadKindsResult` that installation consumes. Read its module header and `prepareBootRequest`,
  `expandBootAnswer`, `loadBootSnapshot`, `BootCacheStore` for claims, validation, fallback and write fences.
- `BOOT_CACHE_ELIGIBILITY` (`shared/resources.ts`) decides per kind; a server `project` vetoes caching regardless of the
  table. A character with a non-empty managed `oaiTTSConfig.apiKey` is excluded; secrets embedded in other cached
  content can remain.
- The `@chatCollection` claim (`chatCollectionClaim`) requires matching `chatSummaryFormat`: bump shared
  `CHAT_SUMMARY_FORMAT` when the server summary projection changes.
- Boot schedules `scheduleBootCacheCommit` after installation; captured server texts alone enter the cache. It outlives
  the tab in the browser profile (`clearBootCache` for a future sign-out). A new epoch needs no clear, but independently
  written servers must not share an epoch behind one origin.

### Dirty marking

- Local settings writes in `records.svelte.ts` mark the adapter immediately. Character own-field writes at any depth,
  selected or not, do too (`setCharacterWriteListener`); `chats`, `chatPage`, `reloadKeys` are outside the record.
  Membership changes go only through `characterStore`, and chat work wakes the adapter through its listener.
- `llmSecrets` projects readable siblings; credential values take the [separate queue](#credential-writes).

### Save cycle

- `runCycle`, `cycle` and `schedule` in `src/ts/storage/resourceSync.svelte.ts` define debounce, single-flight writes
  and backoff. A cycle collects records and `takeChatWork`, sends through `applyBatchText`, then acknowledges the
  resource baseline and `ackChatWork`. A mark made in flight stays dirty. Ready feed patches apply before collection.
- `runRefresh` owns reads beside writes: it reloads deferred chats and lists through `resourceClient.ts`, applies feed
  records, and refreshes idle summaries/chats through the chat module. Stages start independently; a completed stage
  wakes pending writes. Only conflict and credential dependency reads remain inside a write cycle.

### Read deadlines

- Adapter reads use `deadlineRead` (20 s, including `readRefs` continuations, or halt); `watchForRestore` has its own 5
  s bound. `authFetch` in `src/ts/storage/serverAuth.ts` never dispatches an aborted request.
- Other readers use `readWithDeadline`: 30 s for an order-repair chunk (`characterOrder.ts`) and the callback barrier's
  chat read (`jobChannel.ts`), 60 s for an export chunk (`chatEdits.ts`), 120 s per boot read. Chat loads have
  [their own](chat-store.md#limitations) bound. Only a complete read installs; owner replacement leaves its read running
  until its deadline, with adoption fenced separately.

### Serialization

- Adapter contracts: `projectCollection`, `characterProjection`, `moduleProjection`, `shareSavedText`,
  `canonicalCharacter` and `canonicalShape`. Wrapper stamp/copy contracts: `characterFieldStamp`,
  `moduleItemFieldStamp`, `adoptCharacterValue` and `adoptModuleValue` in `src/ts/storage/records.svelte.ts`.
- Across that boundary, a mutator commits cache taint only after preparation succeeds; a local `reloadKeys` input
  holding record state is detached. Raw `initializeRecords`, `applyRawCharacter`, `patchRawCharacter` accept detached
  JSON; other modules never write through `characterData()`. Shared field/element state, non-JSON data or symbol keys
  disable module stamps until fresh JSON is installed.

### Batch composition

- `planBatches` sends records, whole `takeChatWork` groups, then reorders through `POST /api/resources/batch`; each
  request is one server transaction. It splits at 5,000 operations or the client's 100 MiB cap less 64 KiB, or isolates
  an unindexed refusal. A new character travels with or before its chats.
- Membership diffs by `chaId`: remove/re-add before collection is an update, with
  [chat reconciliation](chat-store.md#character-lifecycle). The server refuses two resource ops for one id, or a parent
  delete beside its chat changes.
- Above 5,000 unsent chat ops, the chat module holds a resend prefix under the batch id and a suffix under a fresh id;
  neither sends that cycle. `takeChatWork` withholds the prefix until
  [split confirmation](draft-recovery.md#split-confirmation); the suffix follows its acknowledgement.
- Same-id chat recreation sends the old delete alone on its held revision/id, then a null-base create under a fresh id
  after acknowledgement or confirmed absence. Delete alone does not settle the recreation's flush sequence; deleting the
  recreation before collection still sends the old delete.
- An acknowledged order naming unknown chats keeps its old revision and queues `listRefresh`. The read enters
  `applyRemoteCollection` with `keepPendingOrder`, even during generation; `holdOrders` holds a queued reorder until it
  can use the new revision with new chats after its own. A missing kept chat with a held revision instead discards and
  reports the reorder with the notice.
- A chat result with `stale: true` keeps its base and queues idle rebase: the idle read takes the server copy without
  discard/notice, while a busy chat keeps the mark.

### Record patches

`updateOperation`, `baseParts` and `recordPatchText` in `src/ts/storage/resourceSync.svelte.ts` define patch selection
and whole-record fallbacks. `llmSecrets` never has parts: the server refuses its patches, including readable siblings.

### Lost answers

- Network/5xx uncertainty is handed from the adapter to `requeueChatWork({ lost: true })`: `Pending.resend` replays
  exactly the sent group, alone with `retry`, before newer work. Newer work, even an empty newer sequence, uses another
  id, so the replay's answer cannot settle it. Failed pagehide requests take the same path through `settleUnloadWork`.
- A definitely unapplied group merged in front of newer work keeps that group's id. A rolled-back unanswered resend
  remains a resend; a named 409 clears doubt. Expired live groups discard with the notice and no fresh identity; expired
  recovered groups quarantine for explicit Retry/Discard.
- A lost chat create replays and is recognized by an exact conflict-read match unless expired. Collection membership
  acknowledges nothing. Reorders wait behind in-doubt creates/deletes for the acknowledgement's order revision or
  `listRefresh`, also after a confirmed-absent delete; failed refresh keeps the hold.
- A record's lost text is held by `noteInDoubt` and resent by `resendInDoubt` (inside `collectOperations`); replay and
  echo handling live on `inDoubt` and `adoptInDoubt`: exact sent text/base precedes newer local text, including a
  revert, while whole live/job adoptions wait. A matching feed patch or conflict read advances the saved base without
  replacing the mirror.

### Refusals and quarantine

- The adapter routes an indexed `chats[i]` 400 to `quarantineChat` and requeues the rest; `ops[i]` or the client 413
  pre-check quarantines the record before dependent chat work is taken. `quarantineRecord`, `cycle` and `planBatches`
  define suppression of automatic retries, alerts and per-unit isolation after unindexed 400/413.
- A quarantined character create is excluded from `creating`: its chats wait and membership stays unacknowledged, while
  other work saves. Quarantine alone schedules no idle cycle.
- A refused order keeps its intent until sendable ids change or Retry. While `isOrderQuarantined` holds it, it is
  outside flush obligations, in `refused`, and still protects page close.
- Chat refusal retention and release: `quarantineChat`, `releaseChatRefusal`, `retryRefusedChat` and `deleteChat` in
  `src/ts/storage/chatStore.svelte.ts`.
- Read `refusedItems`, `retryRefused` and `discardRefused` for opaque keys, reactive reads, halt admission and read
  fences. Discard accepts the server copy only if newer local intent has not superseded it.

### Conflicts

- A 409 enters `recoverFromConflict`, which takes the server copy from `rebuildConflictRecord` (a fitting feed patch or
  exact-revision job hydration), otherwise `readRefs`; both go through lost-reply recognition, merge, then acceptance. A
  failed merge accepts the server record in place (removed selected character → home), first
  [drafting](draft-recovery.md#conflict-capture) local edits. The reload notice also survives a read error after a
  discard.
- Conflict read-back is a write dependency under `deadlineRead`; queued `hydrate` lists run in the independent refresh
  queue. Acceptance is immediate even during generation: the job refreshes records at barriers and server locks guard
  messages. Only `hydrate` list reads wait on this tab's `isCharacterStreamedHere`.
- `onRemoteRecordApplied` reaches boot's inlay cache invalidation and, for `characterOrder`,
  [order repair](persistence.md#character-order-repair).
- An adopted create queues `listRefresh` with `keepPendingOrder`, allowing chat work in one flush. A same-id create lost
  to another writer calls `forgetCharacter` with `capture`, reporting the loss on the character only, then reads the
  server list through `hydrate`.

### Record merge

- `mergeConcurrentChange` in `src/ts/storage/resourceSync.svelte.ts` uses `recordMerge.ts`'s three-way field/tuple/item
  policy. A success applies detached data raw, rebases through `adoptMergedBase`, and keeps the key dirty without a
  draft or notice; equal server values produce no echo. Taken fields reach `onRemoteRecordApplied`; a failure takes
  [whole-record acceptance](#conflicts).
- For module lists accepted by `itemIds`, a fresh-id addition merges with independent remote changes and rebases without
  a discard.
- `pluginStorage` merges by key, one level down in `_pluginStorage` and `_safeLocalPluginStorage`, other top-level keys
  whole (`mergePluginStorage`). Conflicting reserved values that cannot merge as dictionaries fail; unchanged or equal
  values still converge. `onPluginStorageDiscarded` hears replaced keys after acceptance settles the record.
- `statics` counts are best effort: server counts plus local increments (`benignChanges`). `llmSecrets` sibling-body
  rules live on `adoptSecretSiblings`, shared by save conflicts, credential replies and live updates; masked status
  comes from the server.
- `customModels` and `modules` normalizers do not guarantee `itemIds`: merge admission checks all inputs. A merged
  credential deletion still waits for acknowledged owner deletion before secret cleanup.

### Chat and order conflicts

- The adapter reads conflicts through `readRefs`, then `recoverChatConflicts` in `src/ts/storage/chatStore.svelte.ts`
  requeues unrelated groups, recognizes create/delete replays, and otherwise discards queued work with the notice, gone
  chats included. A non-expired append with a missing anchor can instead reanchor and retry.
- A conflicted reorder keeps its sent vector until the `hydrate` list read: equal server order settles quietly;
  otherwise `markOrderDiscarded` reports `chats/<chaId>` with the notice. A failed/deferred read settles nothing, and a
  newer queued reorder keeps its sequence.
- A list reports work of missing chats as `chats/<chaId>/<chatId>`; idle ones go silently. A gone parent is removed only
  if its held revision and `chatOwnerToken` stayed unchanged during the read, otherwise it remains in `hydrate`.
- `readCharacter` fences lists against dispatch, settlement and owner changes while writes proceed. Such characters'
  reorders are held, their chat groups are not. A locally absent `listRefresh` is parked without reads until re-add or
  confirmed deletion (`hydrateCharacters`).
- A refused create that reads back null stays quarantined in the mirror unless its parent is gone. A chat streamed into
  by this tab defers reload (`isChatDeferred`) until locks release; the deferred reload discards its queued edits.

### Generating refusals

- Before unrelated conflict reads, `recoverConflictedWork` hands a `reason: "generating"` refusal's `messageIds` to
  `recoverChatConflicts` / `dropLockedEdits`. Edits of those locked messages in the refused group and newer work are
  dropped and reported with `resourceReloaded`; the stale chat is read whole after surviving work lands and this tab's
  locks release.
- Surviving work, including chat-level ops, multi-id `remove` and other-message edits, waits `JOB_RETRY_MS` (5 s), as
  does a refused character delete. One retry cycle is scheduled and `chatGenerating` shows once per episode. With no
  surviving work there is no chat retry block; the sent sequence settles when none is kept.
- The split uses server ids independently of tab locks, treating observer and lost-follow tabs alike. It is the fallback
  for an edit sent before the [lock frame](live-updates.md#feed-locks).

### Record hydration

Server job records enter the adapter's `applyHydration`; read its comment for admission and deferred adoption. Chats
enter the chat module's [`hydrateChat`](chat-store.md#job-hydration); job patches use `applyPatchHydration` /
`hydrateChatPatch`.

### Credential writes

- After resource batches, `sendSecretOps` sends the captured `llmSecrets.svelte.ts` queue one at a time through
  `resourceClient.ts`'s `/api/llm-secrets/*` transport on the held revision. A later credential waits for the next cycle
  after its owner record. Cleanup waits until owner deletion is acknowledged; comment contracts on `sendSecretOps`,
  `entryOwnerState`, `adoptSecretRecord` and `adoptSecretSiblings` define retries, refusals and sibling adoption.
- `auxFetch` calls `awaitSecretWrites` before using a stored key; refused ops, cleanups behind unsaved owner deletion,
  saving failure or halt reject that barrier. Unload sends no credential ops.

### flushResources

- `flushResources` captures queued record generations, membership, chat/order sequences and credential ops. Its comment
  defines the ten-attempt budget and relevant dependency reads; it does not wait for unrelated background reads.
- Unanswered pagehide and stalled split-journal dependencies each wait at most 20 s. Timeout rejects without releasing
  the split prefix.
- The result is `{ discarded, refused }`: discards since the call or `beginMutationScope` (a conservative time window),
  and `refusedItems` at resolution. Keys are `<kind>/<id>`, `chats/<chaId>/<chatId>` or `chats/<chaId>` for an order. An
  empty discard list does not guarantee all changes are durable; refused chats/orders are nonblocking. Refused records
  reject via `quarantineReason`; generation-blocked work throws `GenerationBlockedError` (`generatingNoticeCount` tracks
  whether the notice showed).
- Send admission, `startMemoryTask` and `requestStoredTranslation` check the target chat and order in the refusal
  result. `readChatsDetached` also checks character keys. Refused records reject the flush itself. Backup export reports
  refused changes.

### Unload

- `startResourceSync` owns lifecycle handlers, warning rules and the shared keepalive budget; `prepareUnloadAuth` in
  `resourceClient.ts` keeps a signed token ready while unsaved work exists. Hidden visibility requests an immediate
  normal cycle, bypassing debounce/backoff, with a follow-up if needed after joining an existing cycle.
- `pagehide` asks `unloadPendingChatWork` for whole eligible by-id batches under existing ids, one request per chat in
  the shared 60 KiB budget including outstanding keepalives. Only a successful `sendBatchOnUnload` dispatch calls
  `trackUnloadWork`; answers enter `settleUnloadWork`, failures requeue ahead of newer edits. Answers for retired work
  change no revision or queue. Records, credentials, creates/deletes, replacements and reorders use normal cycles only;
  keepalive is best effort.

### Transport

- `src/ts/storage/resourceClient.ts` owns loaded-epoch checks, `readRefs` continuation and pre-signed unload transport.
  Mutations carry the loaded epoch; a read of another epoch reaches the adapter's restore halt through the registered
  listener. Normal requests pass through `authFetch` in `src/ts/storage/serverAuth.ts`.
- `readRefs` returns a complete result in request order or throws. Its rounds share an epoch, not a moment: only a
  character record and its collection entries are guaranteed the same round's read
  ([server contract](server-resources.md)).

## State

- The adapter keeps plain maps, not runes: `persisted`, dirty keys with a generation counter, discarded keys, refused
  content and reasons, `inDoubt`. Reactive: `saving` and a refusal counter, read without changing state.
- `journalRecords`, `journalPending`, `journalChatViews`, and `journalChatPending` share one serialized queue and 500 ms
  timer. `Pending.groupId`, set at a batch's first queued op, is independent of a resend's id; an unconfirmed split
  stays a resend until the adapter releases it.

## Coupling

- The chain is the records and the chat module → `resourceSync.svelte.ts` → `resourceClient.ts` → `authFetch`
  (`serverAuth.ts`) → `/api/resources`.
- `bootstrap.ts`: [boot load](#boot-load). `drive/backuplocal.ts`: `flushResources` and the backup routes;
  `globalApi.loadInternalBackup` restores through the routes only (no flush).
- `permissionStore.ts`, `inlays.ts`: own resources through `resourceClient.ts`. `refreshPluginPermissions` keeps a newer
  copy it holds. An inlay metadata read begun before an invalidation or this tab's write fills no cache; an on-demand
  read retries twice, then returns uncached.

## Invariants

- Server data never becomes an outgoing write: the saved text comes from the server's response or the hydrated mirror,
  so another key order is not echoed back. A server copy enters records raw (`applyRaw`, `applyRawCharacter`,
  `patchRawCharacter`), marking nothing.
- Every mutation carries the loaded epoch; after a restore every write is refused until the page reloads.
- `pluginStorage` serializes straight from the proxy: `$state.snapshot` drops an own `__proto__` key.

## Recipes

- Adding a setting or resource → [persistence](persistence.md#recipes).

## Tests

- Focused: `pnpm --silent test:agent src/ts/storage/tests/resourceSync*.test.ts`. `slow`: a long-chat case in
  `src/ts/storage/tests/resourceSyncHydration.test.ts`. `e2e`: none of its own; the live-update client's are
  [live-updates](live-updates.md#tests).
- Adapter tests use the real Svelte module, a fresh module graph, and fake timers per test.
- `src/ts/storage/tests/fakeResourceServer.ts`: an in-memory `authFetch` resource-route fake with batch, lost-answer,
  failure, and ordering hooks; `src/ts/storage/tests/serverKinds.ts` and `materialize(fake)` keep its record set aligned
  with the server.
- `src/ts/storage/tests/storeBackedServer.ts`: an `authFetch` stand-in over the real store (SQLite in memory);
  `streamingForChat` selects whole-read lock lists, with no locks by default to model an older server.
- Not tested through summaries: most adapter tests and `src/ts/storage/tests/mutationStoresHarness.ts` boot whole chats.
  Only `src/ts/storage/tests/resourceSyncLazyChats.test.ts` and
  `src/ts/storage/tests/resourceSyncAbsentSingleton.test.ts` boot the adapter from summaries throughout.

## Known Hazards

### Issues

- A single oversized chat group is quarantined before dispatch and cannot be chunked; see
  [Batch composition](#batch-composition) for the cap. An edit or Retry still over it quarantines again silently.
- A page restored from the back-forward cache may still wait for an unload answer; `flushResources` gives up after 20 s.
- A save's echo arriving before its acknowledgement schedules a cycle 50 ms later (`noteRemoteChanges`), so continuous
  typing can save more often than the debounce. [Measurements](../audit/projection-bindings-2026-10-04.md) no longer
  show the extra saves, but the 50 ms echo cycle remains; coalescing would bound it.

### Limitations

- A lost group is recognized only within its chat's newest 100 groups: a live resend past them answers
  `reason: "expired"` and takes conflict recovery, a recovered one durable refusal quarantine. A resend skips page
  unload (`unloadPendingChatWork`). Decision: Durable Drafts Out of scope, D2 (f), archive; the recovered case is the
  archive's Durable Drafts entry.
- A live resend of a lost chat create can recreate a chat another writer deleted; boot instead drafts it. Decision:
  Durable Drafts D2 (d), Out of scope, archive.
- A same-item or both-reordered `togglePresets` conflict takes the whole server list, so a local addition can vanish
  while its chat link lands. Decision: Durable Drafts D11, archive; F03 in
  `docs/research/deep-audit/server-client-stabilization.md`.
- A quarantined resource stays in the mirror until a changed projection or Retry saves or Discard applies. It survives a
  reload, as a recovery draft at boot, only when the journal runs and its content is eligible and within budget. Other
  edits do not retry it. Decision: Static Audit Fixes SA3, archive.
- A refused chat create is out of collection-removal reconciliation until an edit, Retry, recreation, or Discard; its
  parent's server-side deletion still clears it. Decision: Static Audit Fixes SA3, archive.
- [Isolated](#refusals-and-quarantine) requests are atomic only per request. Decision: `resourceSync.svelte.ts`
  `isolateBatches`.
- A preset's record and credential are separate requests: a refused credential leaves the entry keyless, and a deleted
  owner's entry stays until cleanup succeeds. Decision: a preset is saved before its key (`resourceSync.svelte.ts`
  credential writes).
- Keepalive has no prefix send: an ineligible batch waits for normal saving and the journal. Decision: Durable Drafts
  D7, archive.

### Gotchas

- A quarantined chat a list shows deleted stays in the mirror, left out of reorders. A reorder queued before that list
  blocks the live update (`canApplyRemoteCollection`), conflicts on the order revision (never the permutation refusal),
  and settles with the notice and an order discard.
