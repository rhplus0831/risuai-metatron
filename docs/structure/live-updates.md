# Live Updates: Feed Connection, Record and Chat Updates, Feed Locks, Restore Halt

## Scope

- Owns the tab's side of the live-update feed: the connection and its reconnect, what a `hello` reconciles, how a
  `change` frame's record refs and patches, chat entries, and lock lists reach the mirror, when a noticed record or chat
  is read instead, the feed locks, and the halt a restore or import causes.
- Not here: the save cycle, conflicts, and the loop's reads ([resource-sync](resource-sync.md); an update that cannot
  apply waits for [a cycle or refresh pass](resource-sync.md#save-cycle)); the server's feed, frames, and publication
  budget ([live-update-feed](live-update-feed.md)); what a chat patch does to the chat module
  ([chat-store](chat-store.md#summaries-and-refresh)); the restore journal
  ([draft-recovery](draft-recovery.md#journal-writes)); the job sockets sharing `socketLiveness.ts`
  ([network-jobs](network-jobs.md)).

## Files

Identifiers the flows below name are not repeated here.

- `src/ts/network/eventFeed.ts`: client feed socket; `stopEventFeed`, `receive`, `reconcile`, `scheduleReconnect`,
  `resumeReconnect`, `generation`, `advertised`, `RECONCILE_DEADLINE_MS`.
- `src/ts/network/socketLiveness.ts`: shared socket liveness and resume policy; `CONNECT_TIMEOUT_MS`, `STALE_AFTER_MS`,
  `RESUME_AFTER_HIDDEN_MS`, `RESUME_FOLD_MS`.
- `src/ts/storage/resourceSync.svelte.ts`, live-update part: record refresh and restore adapter; `remoteRecords`,
  `remoteCollections`, `patchedRecord`, `canApplyRemote`, `REMOTE_DELAY_MS`, `MAX_REMOTE_READS`, `beforeRestoreReload`.
- `src/ts/storage/chatStore.svelte.ts`: chat updates and feed locks, owned by [chat-store](chat-store.md);
  `stagedMetaFields`, `feedLocks`, `canRefreshChat`, `finishIdleChatRefresh`.
- `src/ts/process/generationProgress.svelte.ts`: the server's running generation jobs as the feed reports them;
  `replaceGenerations`, `noteGenerationFrame`, `resetGenerationProgress`, `runningGenerations`, `foreignGeneration`,
  `generationTokensPerSecond`, `OUTPUT_SAMPLE_WINDOW_MS`.

## Flows

### Feed connection

- After boot and `startResourceSync`, `src/ts/bootstrap.ts` calls `startEventFeed` for `/api/events/ws`
  (`shared/events.ts`). The `eventFeed.ts` module header owns hello reconciliation, digest/replay fallback, read
  overlays, presence, and reconnect timing.
- A same-epoch `hello` replaces feed locks before `reconcileRemote`; a different epoch [halts](#restore-halt). Refs
  reach the resource adapter, with chat bodies and summaries following [Chat live updates](#chat-live-updates). Handoff
  offers and presence go to `src/ts/network/handoff.ts`; socket resume/liveness is in `socketLiveness.ts`.
- Each same-epoch hello registers the tab and reconciles outstanding remote commands on both sides. `remoteCommand`
  wakes the host to fetch the command over HTTP. `remoteCommandState` wakes its sender to read the result. Presence
  advertises host mode alongside the tab's name and worker preference. A change to any of these registers again.
  `feedConnected` drives the host lock screen. See [remote send](network-jobs.md#remote-send).
- `replaceGenerations` takes the hello's running jobs. A same-epoch `generation` frame adds, updates or ends one.
  Retiring the connection or detecting an epoch mismatch clears progress, output samples, and the server clock offset.
  `memoryTask` frames and the hello's task snapshot feed the [memory task fences](memory.md#background-memory-task).
- `hello.rerollInPlace` feeds `serverRerollsInPlace`; its connection-scoped contract is on the export in `eventFeed.ts`,
  and its screen consumer is [Reroll](chat-pipeline.md#reroll).

### Live updates

- `noteRemoteChanges` sends `inlays` and `pluginPermissions` to owners set by `setRemoteResourceOwner`. Mirrored entries
  take a fitting `applyRemotePatch` (`entryPatch ?? patch`) or wait for `applyRemoteUpdates`: the refresh queue reads
  via `readRefs` beside writes, then installs via `applyToMirror`.
- A new character arrives with its chat list through `applyRemoteCollection` in `src/ts/storage/chatStore.svelte.ts`;
  chat/order refs that beat insertion keep a list read pending. A remote character deletion calls
  `forgetCharacter({ discard: true })`: unsent chat work is discarded and reported, a fulfilled queued delete settles,
  and the refresh queue shows the reload notice when work was lost.
- `applyToMirror` follows updates of `presets`, `personas` and `modelPresets` with `reconcileSelection()` in
  `src/ts/storage/settingsViews.svelte.ts`, so this tab's selection resolves against the new list.

### Chat live updates

- A change entry carries at most one chat body (`patch`, `delta`, `rowDelta`) or `rows` manifest; their wire contract is
  in `shared/resources.ts` `ChangeSet`. The adapter passes it and summary knowledge to `noteRemoteChat`. The chat-store
  flow owns admission and refresh: only a loaded, idle chat at the body's base takes `applyRemoteChatPatch`; other
  changes use a notice, summary, or list read ([chat-store](chat-store.md#summaries-and-refresh)).
- A `rows` manifest stays on a loaded idle chat's notice at its `baseRevision`; the idle read asks `chatRows` for named
  rows and fields. A moved answer or patch miss reads the chat whole. `stagedRowDiffs` checks all row diffs before
  applying and keeps the by-id position index; feed deltas never use `mergeChatMeta` or settle job hydration. Chat
  revisions advance by applied op count.
- A list that meets this client's order work uses `canApplyRemoteCollection` and `applyRemoteCollection`; only the
  acknowledgement rebase (`keepPendingOrder`) applies a list over a queued reorder.
- The background refresh pass trims excess idle loaded chats before choosing reads. A noticed chat evicted then keeps
  its notice and refreshes through summaries; selected, pinned, busy, generating and stale chats stay protected.

### Feed locks

- A `change` frame's lock lists reach `noteRemoteStreaming` after its refs (`eventFeed.ts` header). Each listed chat's
  list replaces its `feedLocks`, leaving out generations this tab's job events retired
  ([locks](chat-store.md#locks-and-streaming)); a `hello` and a read's snapshot are filtered the same way.
  Deletion/forget paths (`removeRemoteChat`, `dropChatRevision`, `forgetCharacter`) clear locks without retiring the
  generation; its next job write can lock again.
- `onRemoteStreaming` listeners receive a frame's named chats after their locks are replaced, empty lists included:
  `chatStatus.svelte.ts` looks there for another client's job that holds no lock yet ([State](chat-pipeline.md#state)).
- Whole reads carry `ChatReadRecord.streaming`, sampled with the read, never on summaries. The adapter stamps issue with
  `issueChatReadStamp`; an adopted read replaces the chat's locks regardless of revision only when issued after its
  newest feed list, the newest `hello` and its last honored read. `dropFeedLocksOf` defines suppression and the revision
  fallback for a copy without a snapshot or stamp.
- Lock readers (`isMessageLocked`, `assertUnlocked`, `lockedChatKeys`), trimming, sidebar status and memory/lore-draft
  fences count feed locks. Refresh, conflict deferral, `acceptRemoteCollection` and deferred reloads use
  `isChatStreamedHere`, list recovery `isCharacterStreamedHere` (this tab's job locks only), so an observer keeps taking
  checkpoint patches.
- An edit sent before the lock frame meets the server's generating refusal and the client's
  [conflict fallback](resource-sync.md#generating-refusals): edits of the named locked messages are dropped with the
  reload notice and read back; remaining work retries. The first-frame window is a kept [limitation](#limitations).

### Restore halt

- A tab detects restore/import through a different-epoch `hello` or `epoch` frame, an EpochMismatch 412, or a resource
  read of another epoch, each through `epochMismatch` and the `setEpochMismatchListener` hook in
  `src/ts/storage/resourceClient.ts`.
- `haltForRestore` synchronously captures the [restore journal](draft-recovery.md#journal-writes) before anything
  settles, then halts saving and opens `resourceRestored` through `alertTerminal`. Reload follows acknowledgement and
  the snapshot's existing wait, bounded to 1 s from its start before the notice; journal failure or timeout still
  permits reload. Acknowledgement has no timeout.
- A restore-refused transform shows no extra toast (`src/ts/parser/transformClient.ts`). `setMutationAdmission`
  (`resourceClient.ts`) checks after signing, immediately before dispatch. A halt seen before a batch requeues that
  batch and the rest; after a request answers or rejects, a halt returns without requeueing. Queue reads abort and late
  answers apply nothing.
- A job ended by `maintenance` calls `watchForRestore` from `src/ts/process/serverCommands.ts`, so its owner learns of
  replacement even with its socket down; only a watch finding no replacement shows the job's error.

## State

- `advertised` holds server-announced revisions independently of the tab's installed records. `remoteRecords` holds
  entries awaiting adoption or a read. A connection's `generation` fences late results, except an old read that
  discovers a replacement epoch.
- `feedLocks` holds the last announced message locks after filtering locally retired generations. The job follow owns
  streamed text. See [locks and streaming](chat-store.md#locks-and-streaming).
- `runningGenerations` describes current jobs even before they have a message lock. The
  [progress window](ui-theming.md#chat-screen) uses each job's server-timestamped output samples for speed and the
  connection's clock offset for elapsed time.
- Translator and HypaV3 preset collections share their `selectedId` across tabs. Prompt preset, model preset and persona
  selections are local to each tab. See [chat binding](persistence.md#chat-binding).

## Coupling

- [Live-update feed](live-update-feed.md): the server's frames, their admission, and the publication budget; an entry's
  body and `summary` are built there.
- [Resource sync](resource-sync.md): the refresh queue reads what a patch cannot take, `canApplyRemote` keeps a record
  with a local change for its 409, and a conflict's `rebuildConflictRecord` reuses a waiting feed patch.
- [Chat store](chat-store.md): `canRefreshChat`, the lock readers, and the chat list reads; the sidebar status and the
  memory and lore-draft fences read the feed locks.
- [Draft recovery](draft-recovery.md#journal-writes): the restore journal `haltForRestore` waits for. The terminal
  notice it shows is [global-api](global-api.md)'s.
- [Plugin sandbox](plugin-sandbox.md#gotchas): detached chat-cache reuse depends on `eventFeed.ts` `liveFeedCurrent`;
  preserve its module-header contract when changing reconciliation, liveness or resume
  (`src/ts/plugins/apiV3/detachedChatCache.ts` `bodyCurrent`).

## Invariants

- A live update never overwrites local work: a record or chat with a local change keeps it until its 409 or its idle
  read decides, and one written locally but unsaved is not adopted. The one discard is a remote character deletion,
  which discards its chats' unsent work with the reload notice.
- A feed lock is a lock only: it holds no text, retires nothing, and never holds the save loop.
- A `hello` or `epoch` frame of another epoch halts writes until reload. Other epoch-bearing frames apply only to the
  loaded epoch, including remote command notifications. Presence (`clients`) has no epoch and requires the currently
  registered socket.
- One connection is current: a late answer of an older connection applies nothing, except its replay or listing's
  epoch-mismatch error.

## Recipes

- A new frame kind or entry form: the server side is [the feed guide's recipe](live-update-feed.md#recipes). Here,
  `eventFeed.ts` parses it, and `noteRemoteChanges` or `noteRemoteChat` applies it under the same rules
  (`canApplyRemote`, `canRefreshChat`), so a form that cannot apply still falls back to a read.

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/network/{eventFeed,socketLiveness}.test.ts src/ts/process/generationProgress.test.ts src/ts/storage/tests/resourceSync{Live,FeedPatches,Patches,Notices,Refresh,Chats}.test.ts`.
  `slow`: none of its own. `e2e`: `e2e/terminalNotice.spec.ts`, restore halt; `e2e/multiClientGeneration.spec.ts`, feed
  locks.
- The adapter tests and fakes are [resource-sync](resource-sync.md#tests)'s: `FakeResourceServer`, and
  `StoreBackedServer`, whose `streamingForChat` supplies whole-read lock lists (none by default: an older server).
- `src/ts/network/tests/eventSocket.ts` (`FakeSocket`): the shared fake browser socket.
- For the adapter's summary-boot coverage gap, see [resource sync](resource-sync.md#tests).

## Known Hazards

### Limitations

- Two tabs editing one record converge only through the 409 path: live updates skip a record with an unsent change.
  Decision: Durable Drafts D11, D8, archive.
- A loaded chat noticed without a body or an applicable `rows` manifest is read whole when idle: a manifest past 64 KiB,
  a second over-cap write before the row read, or a `moved` answer. Decision: Incremental Chat Transport D6, archive.
- A tab can still edit a generating reply before the job's first write's frame arrives (`hello` cannot list a message
  before `begin`), or, with an older server, after an adopted newer read released the locks, until the next write
  (`CHECKPOINT_INTERVAL_MS` while streaming; longer while a job waits). The edit is
  [dropped](resource-sync.md#generating-refusals), the mirror shows it until the whole read, and with no retry block a
  later edit can land over the finished reply. Decision: owner, 2026-11-10 (known-issues review): a feed reservation is
  not worth the protocol work for this window.
- The same window decides when an observer refuses a permanent character delete or different-id replace
  (`isCharacterGenerating`). A fix would announce the job's chat reservation in the feed and read lock lists, locking
  the chat's tail. Decision: owner, 2026-11-10 (known-issues review), with the entry above.
