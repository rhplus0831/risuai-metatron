# Live Updates: Feed Connection, Record and Chat Updates, Feed Locks, Restore Halt

## Scope

- Owns the tab's side of the live-update feed: the connection and its reconnect, what a `hello` reconciles, how a
  `change` frame's record refs and patches, chat entries, and lock lists reach the mirror, when a noticed record or chat
  is read instead, the feed locks, and the halt a restore or import causes.
- Paths: `src/ts/network/eventFeed.ts`, `src/ts/network/socketLiveness.ts`, and the live-update part of
  `src/ts/storage/resourceSync.svelte.ts` (`noteRemoteChanges`, `reconcileRemote`, `haltForRestore`). Chat entries and
  locks go to `src/ts/storage/chatStore.svelte.ts` (`noteRemoteChat`, `noteRemoteStreaming`), owned by
  [chat-store](chat-store.md).
- Not here:
  - The save cycle, conflicts, and the reads the loop runs → [resource-sync](resource-sync.md); a live update that
    cannot apply waits for [a cycle or refresh pass](resource-sync.md#save-cycle).
  - The server's feed, its frames, and the publication budget → [live-update-feed](live-update-feed.md).
  - What a chat patch does to the chat module → [chat-store](chat-store.md#summaries-and-refresh); the restore journal →
    [draft-recovery](draft-recovery.md#journal-writes).
  - The job sockets that share `socketLiveness.ts` → [network-jobs](network-jobs.md).

## Files

- `src/ts/network/eventFeed.ts`: client feed socket; `startEventFeed`, `stopEventFeed`, `receive`, `reconcile`,
  `scheduleReconnect`, `resumeReconnect`, `generation`, `advertised`, `RECONCILE_DEADLINE_MS`.
- `src/ts/network/socketLiveness.ts`: shared socket liveness and resume policy; `watchSocket`, `watchResume`,
  `CONNECT_TIMEOUT_MS`, `STALE_AFTER_MS`, `RESUME_AFTER_HIDDEN_MS`, `RESUME_FOLD_MS`.
- `src/ts/storage/resourceSync.svelte.ts`, live-update part: record refresh and restore adapter; `noteRemoteChanges`,
  `reconcileRemote`, `setRemoteResourceOwner`, `remoteRecords`, `remoteCollections`, `applyRemotePatch`,
  `patchedRecord`, `canApplyRemote`, `applyToMirror`, `applyRemoteUpdates`, `REMOTE_DELAY_MS`, `MAX_REMOTE_READS`,
  `beforeRestoreReload`, `haltForRestore`, `watchForRestore`.
- `src/ts/storage/chatStore.svelte.ts`: chat updates and feed locks, owned by [chat-store](chat-store.md);
  `noteRemoteChat`, `applyRemoteChatPatch`, `stagedMetaFields`, `noteRemoteStreaming`, `replaceFeedLocks`, `feedLocks`,
  `issueChatReadStamp`, `dropFeedLocksOf`, `canRefreshChat`, `isChatStreamedHere`, `isCharacterStreamedHere`,
  `finishIdleChatRefresh`, `removeRemoteChat`, `dropChatRevision`, `forgetCharacter`.

## Flows

### Feed connection

- After boot and `startResourceSync`, `src/ts/bootstrap.ts` calls `eventFeed.ts` `startEventFeed` for `/api/events/ws`
  (`shared/events.ts`). Changes reach `noteRemoteChanges`: record patches apply or await reads; chat patches, deltas and
  summaries follow [Chat live updates](#chat-live-updates).
- A same-epoch `hello` installs `replaceFeedLocks` before `reconcileRemote`. A matching digest uses the advertised map.
  Otherwise, with that map in the loaded epoch and both cursors plus digest, freeze its maps and held cursor before
  awaiting `listChanges({ since: heldCursor, until: hello.cursor, epoch })`.
- Replay only into the copy; reconcile from it if its digest matches. Expired coverage, a remaining mismatch or absent
  cursors (including older servers) uses `listRevisions`. Both reads share the deadline and post-hello overlay.
- The unoverlaid replay/listing reaches reconciliation and `src/ts/process/memoryTasks.svelte.ts` fences; only the
  advertised map takes the overlay. Same-epoch frames advance the held cursor; success also takes `hello.cursor`.
  Reconciliation routes listed and missing refs through the adapter and owners. Epoch mismatches [halt](#restore-halt).
- `watchSocket` abandons dead sockets; `watchResume` replaces the connection when the page returns
  (`src/ts/network/socketLiveness.ts`).

### Live updates

- `noteRemoteChanges` sends `inlays` and `pluginPermissions` to their owners registered through
  `setRemoteResourceOwner`. Mirrored entries take a fitting `applyRemotePatch` or wait for `applyRemoteUpdates`: the
  refresh queue reads through `readRefs` beside writes, then installs through `applyToMirror`.
- A new character arrives with its chat list through `applyRemoteCollection` in `src/ts/storage/chatStore.svelte.ts`;
  chat/order refs that beat insertion keep a list read pending. A remote character deletion calls
  `forgetCharacter({ discard: true })`: unsent chat work is discarded and reported, a fulfilled queued delete settles,
  and the refresh queue shows the reload notice when work was lost.
- `applyToMirror` follows updates of `presets`, `personas` and `modelPresets` with `reconcileSelection()` in
  `src/ts/storage/settingsViews.svelte.ts`, so this tab's selection resolves against the new list.

### Chat live updates

- The adapter passes a chat ref to `noteRemoteChat` with at most one by-id change (`patch`, or `delta` with
  `metaFields`) and [summary knowledge](chat-store.md#summaries-and-refresh). A loaded chat takes a fitting
  `applyRemoteChatPatch`; otherwise the ordinary notice and idle refresh applies. A newer order ref or a new chat asks
  the adapter for the list. Chat revisions advance by applied op count; a feed patch never settles a job hydration.
- Feed deltas enter through `applyRemoteChatPatch`, never `mergeChatMeta`, which queues a write.
- A list that meets this client's order work: `canApplyRemoteCollection` and `applyRemoteCollection` in
  [chat store](chat-store.md#summaries-and-refresh); only the acknowledgement rebase (`keepPendingOrder`) takes a list
  over a queued reorder.

### Feed locks

- A `change` frame's lock lists reach `noteRemoteStreaming` after its refs, so a fitting `begin` patch puts the row in
  before its lock; otherwise the lock is installed by id and the row arrives locked. Each listed chat's list replaces
  its `feedLocks`. Deletion/forget paths (`removeRemoteChat`, `dropChatRevision`, `forgetCharacter`) clear locks without
  retiring the generation; its next job write can lock again.
- Whole reads carry `ChatReadRecord.streaming`, sampled with the read, never on summaries. The adapter stamps issue with
  `issueChatReadStamp`; an adopted read replaces the chat's locks regardless of revision only when issued after its
  newest feed list, the newest `hello` and its last honored read. `dropFeedLocksOf` defines suppression and the revision
  fallback for a copy without a snapshot or stamp.
- Lock readers (`isMessageLocked`, `assertUnlocked`, `lockedChatKeys`), trimming, sidebar status and memory/lore-draft
  fences count feed locks. Refresh, conflict deferral, `acceptRemoteCollection` and deferred reloads use
  `isChatStreamedHere`, list recovery `isCharacterStreamedHere` (this tab's job locks only), so an observer keeps taking
  checkpoint patches.
- An edit sent before the lock frame is handled by the server's generating refusal and the client's
  [conflict fallback](resource-sync.md#generating-refusals): edits of the named locked messages are dropped with the
  reload notice and read back; remaining work retries. The first-frame window remains an [issue](#issues).

### Restore halt

- A tab detects restore/import through a different-epoch `hello` or `epoch` frame, an EpochMismatch 412, or a resource
  read of another epoch, each through `epochMismatch` and the `setEpochMismatchListener` hook in
  `src/ts/storage/resourceClient.ts`.
- `haltForRestore` synchronously captures the [restore journal](draft-recovery.md#journal-writes) before anything
  settles, then halts saving and opens `resourceRestored` through `alertTerminal`. Reload follows acknowledgement and
  the snapshot's existing wait, bounded to 1 s from its start before the notice; journal failure or timeout still
  permits reload. Acknowledgement has no timeout.
- A restore-refused transform shows no extra toast (`src/ts/parser/transformClient.ts`). `setMutationAdmission` in
  `src/ts/storage/resourceClient.ts` checks after signing, immediately before dispatch. A halt seen before a batch
  requeues that batch and the rest; after a request answers or rejects, a halt returns without requeueing. Queue reads
  abort and late answers apply nothing.
- A job ended by `maintenance` calls `watchForRestore` from `src/ts/process/serverCommands.ts`, so its owner learns of
  replacement even with its socket down; only a watch finding no replacement shows the job's error.

## State

- The advertised map: the last revision the feed advertised per record, independent of the held records. `remoteRecords`
  holds the entries waiting for a read, and each cycle and refresh pass retries the patches that could not apply.
- Per chat, `feedLocks`: the message ids a frame or a whole read last listed as locked, replaced list for list.
- The connection's `generation`: one connection is current; late results do nothing except an older listing's
  epoch-mismatch error, which still resets the advertised map and memory tasks.
- The translator and HypaV3 `selectedId` are shared across tabs; preset and persona selections stay per tab.

## Coupling

- [Live-update feed](live-update-feed.md): the server's frames, their admission, and the publication budget; an entry's
  `patch` or `delta` and `summary` are built there.
- [Resource sync](resource-sync.md): the refresh queue reads what a patch cannot take, `canApplyRemote` keeps a record
  with a local change for its 409, and a conflict's `rebuildConflictRecord` reuses a waiting feed patch.
- [Chat store](chat-store.md): `canRefreshChat`, the lock readers, and the chat list reads; the sidebar status and the
  memory and lore-draft fences read the feed locks.
- [Draft recovery](draft-recovery.md#journal-writes): the restore journal `haltForRestore` waits for. The terminal
  notice it shows is [global-api](global-api.md)'s.

## Invariants

- A live update never overwrites local work: a record or chat with a local change keeps it until its 409 or its idle
  read decides, and one written locally but unsaved is not adopted. The one discard is a remote character deletion,
  which discards its chats' unsent work with the reload notice.
- A feed lock is a lock only: it holds no text, retires nothing, and never holds the save loop.
- A `hello` or `epoch` frame of another epoch halts; different-epoch `change` and `memoryTask` frames are ignored. After
  the halt every write is refused until the page reloads.
- One connection is current: a late answer of an older connection applies nothing, except its replay or listing's
  epoch-mismatch error.

## Recipes

- A new frame kind or entry form: the server side is [the feed guide's recipe](live-update-feed.md#recipes). Here,
  `eventFeed.ts` parses it, and `noteRemoteChanges` or `noteRemoteChat` applies it under the same rules
  (`canApplyRemote`, `canRefreshChat`), so a form that cannot apply still falls back to a read.

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/network/eventFeed.test.ts src/ts/storage/tests/resourceSync{Live,FeedPatches,Patches,Notices,Refresh,Chats}.test.ts`.
  `slow`: none of its own. `e2e`: `e2e/terminalNotice.spec.ts` (the restore halt's notice).
- The adapter tests and their fakes are [resource-sync](resource-sync.md#tests)'s: `FakeResourceServer`, and
  `StoreBackedServer`, whose `streamingForChat` supplies whole-read lock lists, none by default to model an older
  server.
- `src/ts/network/tests/eventSocket.ts` (`FakeSocket`): the shared fake browser socket.
- Not tested: none recorded beyond the adapter tests' gaps ([resource-sync](resource-sync.md#tests)).

## Known Hazards

### Issues

- A tab can still edit a generating reply before the job's first write's frame arrives (`hello` cannot list a message
  before `begin`), or, with an older server, after an adopted newer read released the locks, until the next write
  (`CHECKPOINT_INTERVAL_MS` while streaming; longer while a job waits). The edit is
  [dropped](resource-sync.md#generating-refusals), the mirror shows it until the whole read, and with no retry block a
  later edit can land over the finished reply.
- The same window decides when an observer refuses a permanent character delete or different-id replace
  (`isCharacterGenerating`). A fix would announce the job's chat reservation in the feed and read lock lists, locking
  the chat's tail.
- A noticed idle chat read whole (`readIdleChats`) before the pass's trim may be evicted once its notice settles,
  wasting the read.

### Limitations

- Two tabs editing one record converge only through the 409 path: live updates skip a record with an unsent change.
  Decision: Durable Drafts D11, D8, archive.
- A loaded chat noticed without a by-id change is read whole when idle: a reply over `MAX_FEED_PATCH_BYTES` (64 KiB)
  into a chat another tab has open costs up to one read per checkpoint. Decision: no by-id read for an over-cap change:
  `delta` removed the measured large-metadata case, and no measurement shows how often an observer meets the rest (ST04,
  [server migration audit](../research/deep-audit-with-fable/server-migration-audit.md)).
