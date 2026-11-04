# Live Updates: Feed Connection, Record and Chat Updates, Feed Locks, Restore Halt

## Scope

- Owns the tab's side of the live-update feed: the connection and its reconnect, what a `hello` reconciles, how a
  `change` frame's record refs and patches, chat entries, and lock lists reach the mirror, when a noticed record or chat
  is read instead, the feed locks, and the halt a restore or import causes.
- Paths: `src/ts/network/eventFeed.ts`, `src/ts/network/socketLiveness.ts`, and the live-update part of
  `src/ts/storage/resourceSync.svelte.ts` (`noteRemoteChanges`, `noteRemoteChat`, `noteRemoteStreaming`,
  `reconcileRemote`, `haltForRestore`).
- Not here:
  - The save cycle, conflicts, and the reads the loop runs → [resource-sync](resource-sync.md); a live update that
    cannot apply waits for [a cycle or refresh pass](resource-sync.md#save-cycle).
  - The server's feed, its frames, and the publication budget → [live-update-feed](live-update-feed.md).
  - What a chat patch does to the chat module → [chat-store](chat-store.md#summaries-and-refresh); the restore journal →
    [draft-recovery](draft-recovery.md#journal-writes).
  - The job sockets that share `socketLiveness.ts` → [network-jobs](network-jobs.md).

## Files

- `src/ts/network/eventFeed.ts`: the client of `/api/events/ws` (`shared/events.ts`); `src/ts/network/socketLiveness.ts`
  holds its timers and resume triggers.
- `src/ts/storage/resourceSync.svelte.ts`: `startEventFeed`, `noteRemoteChanges`, `applyRemotePatch`, `noteRemoteChat`,
  `applyRemoteChatPatch`, `noteRemoteStreaming`, `replaceFeedLocks`, `reconcileRemote`, `haltForRestore`, and
  `watchForRestore`; the remote-record owners are registered through `setRemoteResourceOwner`
  ([resource-sync](resource-sync.md#files)).

## Flows

### Feed connection

- `startEventFeed()` signs a fresh JWT per attempt and reconnects with jittered backoff, 1 s doubling to 30 s, reset
  only after a reconcile succeeds.
- A `hello` of the loaded epoch runs `replaceFeedLocks`, then `reconcileRemote` from the advertised map when
  `hello.digest` matches `revisionDigest`; otherwise it fetches `listRevisions` first. A `hello` or `epoch` frame of
  another epoch [halts](#restore-halt).
- The map holds the last advertised revisions, independently of held records. A listing seeds it, overlaid with changes
  since `hello`; the fetched listing itself goes unchanged to reconciliation and memory fences.
- A failed reconcile closes the connection and schedules the reconnect itself, since `close` may never come. A listing
  past `RECONCILE_DEADLINE_MS` (30 s) fails it: pings keep a socket alive while its read is stuck.
- One connection is current (`generation`): anything late from an older one does nothing, except its listing's
  epoch-mismatch error, which still resets the memory tasks and the map.
- A connection not open within 10 s (authentication included), or frameless for 45 s while visible, is abandoned without
  waiting for `close`. When the page comes back (30 s hidden, `resume`, `online`) it is replaced at once, a pending
  retry included (`resumeReconnect`).

### Live updates

- `noteRemoteChanges` drops a ref not newer than the held revision; `inlays` and `pluginPermissions` go to their owners.
- A record patch applies at once when `applyRemotePatch` can: held at exactly its base (same epoch and incarnation, one
  write before), no local change (`canApplyRemote`). A character's fields go in raw, never a fixed, client-only, or
  inherited one; other kinds except `llmSecrets` take `patchedRecord` and `applyToMirror` as a read would.
- A patch that cannot apply waits with its entry, retried by each cycle and refresh pass before reading; what it cannot
  take is read whole.
- A newer mirrored record, an unheld character included, waits in `remoteRecords`, as does a singleton with no local
  record (`pluginStorage` absent at boot). One written locally but unsaved is not adopted: its create's 409 decides.
- The refresh queue (50 ms later) reads them in one `readRefs` beside any write. An entry at or below the held revision
  drops unread; one with a local change (`canApplyRemote`) waits. Generating alone holds no character back.
- After the read it re-checks, then applies through `applyToMirror`, the saved text the mirror's projection: no discard,
  settled key, or notice. `reconcileSelection()` follows `presets`, `personas`, `modelPresets`. A new character comes
  with its chat list; a chat or order ref that beat its insertion reads the list again.
- A deleted character is removed (selected → home) only when the held revision is unchanged since issue, else read
  again. Its chats' unsent work is discarded with the notice and reported (`forgetCharacter` with `discard`); a queued
  delete it fulfils settles.
- A read settles only the notice it was issued for or a later one its answer covers.
- `llmSecrets` adopts as a credential reply does; a local edit meeting a changed server sibling waits (`blockedLocal`)
  for the 409.
- `MAX_REMOTE_READS` (1,000) caps records, chat lists (new characters' first), and idle chats per read.
- `reconcileRemote` compares every listed row the same way, treats a held row no longer listed as a deletion, and lets
  each owner reconcile its kind.
- The translator and HypaV3 `selectedId` are shared across tabs; preset and persona selections stay per tab.

### Chat live updates

- A chat ref reaches `noteRemoteChat` with its by-id change (`patch`, or `delta` with `metaFields`; at most one) and
  [summary knowledge](chat-store.md#summaries-and-refresh).
- `applyRemoteChatPatch` applies it with no read or notice only when the chat is loaded, idle (`canRefreshChat`), not
  stale, and held at exactly `baseRevision` (chat revisions advance by op count). It queues nothing and never settles a
  job hydration.
- `stagedMetaFields` checks a delta against the held copy before anything changes; a field named twice, `message`, a
  top-level `__proto__`, or a merge into a non-map is a miss. A delta never goes through `mergeChatMeta`, which queues a
  write.
- A miss marks nothing stale and takes the ordinary notice and idle refresh. A newer order ref or a new chat queues the
  chat list.
- A list that meets this client's order work: `canApplyRemoteCollection` and `applyRemoteCollection` in
  [chat store](chat-store.md#summaries-and-refresh); only the acknowledgement rebase (`keepPendingOrder`) takes a list
  over a queued reorder.
- A chat an idle read or list finds gone is removed only when its held revision is unchanged since issue, never by
  creating a replacement. A list keeps out a chat deleted here but unsaved, and drops a notice only when the adopted
  copy covers it.

### Feed locks

- A `change` frame's locks reach `noteRemoteStreaming` after its refs, so a fitting `begin` patch puts the row in before
  its lock; otherwise the lock is installed by id and the row arrives locked.
- Each listed chat's list replaces its `feedLocks`; a listed message is locked whether or not the mirror holds it, one
  unlisted or of another generation is released.
- A feed lock is a lock only: the lock readers (`isMessageLocked`, `assertUnlocked`, `lockedChatKeys`, so the sidebar
  status and the memory and lore-draft fences) and trimming count it. It holds no text, retires nothing, and never holds
  the save loop: `canRefreshChat`, the conflict deferral, `acceptRemoteCollection`, and deferred reloads use
  `isChatStreamedHere`, list recovery `isCharacterStreamedHere` (this tab's job locks only), so an observer keeps taking
  checkpoint patches.
- A lock is released by a list without it, an adopted whole read lacking it, the chat found gone (`removeRemoteChat`,
  `dropChatRevision`), and `forgetCharacter`. None retires, so the job's next write locks again.
- Whole reads carry `ChatReadRecord.streaming` (sampled with the read, never on summaries) and are stamped at issue
  (`issueChatReadStamp`). An adopted read replaces the chat's locks, whatever the revisions, when issued after the
  chat's newest feed list, the newest `hello`, and its last honored read; otherwise its list is ignored, so a delayed
  answer never reinstalls a released lock.
- A copy without a list or a stamp (an older server) releases only locks announced at an older revision than its own, or
  at none.
- `hello` carries the whole lock snapshot; `replaceFeedLocks` installs it before the reconcile starts, so the
  reconcile's reads decide.

### Restore halt

- A tab learns of a restore or import from the `epoch` frame, a reconnect's `hello`, or its next request (412, a changed
  epoch). `haltForRestore` stops saving, shows `resourceRestored` through `alertTerminal`, and reloads once the user
  acknowledges and the [restore snapshot](draft-recovery.md#journal-writes) committed, at most 1 s from the halt: a
  hanging or failed journal still reloads.
- `beforeRestoreReload` and the notice run synchronously inside the halt. A transform the restore refused shows no toast
  (`transformClient.ts`). Any resource request's 412, or a read of another epoch, halts the same way.
- `setMutationAdmission` checks right before a mutation goes out, after signing. A cycle stops before each batch and
  after each answer once halted (captured chat work is requeued); queue reads abort and nothing they return applies.
- A job a restore or import ended (`maintenance`) starts `watchForRestore`: one small read a second, each aborted past 5
  s, for two minutes, so a send's owner is told with its socket down; the job's error shows only when nothing was
  replaced.

## State

- The advertised map: the last revision the feed advertised per record, independent of the held records. `remoteRecords`
  holds the entries waiting for a read, and each cycle and refresh pass retries the patches that could not apply.
- Per chat, `feedLocks`: the message ids a frame or a whole read last listed as locked, replaced list for list.
- The connection's `generation`: one connection is current, and anything late from an older one does nothing.

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

- A live update never discards local work: a record or chat with a local change waits for its 409 or its idle read, and
  one written locally but unsaved is not adopted.
- A feed lock is a lock only: it holds no text, retires nothing, and never holds the save loop.
- A frame of another epoch halts, and after the halt every write is refused until the page reloads.
- One connection is current: a late answer of an older connection applies nothing, except its listing's epoch-mismatch
  error.

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
