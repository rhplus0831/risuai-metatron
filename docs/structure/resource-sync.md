# Resource Sync: Save Adapter, Transport, Live Updates

## Scope

- Owns the boot load and boot cache, the save adapter, the resource transport, and the live-update client.
- Not here: [the chat module](chat-store.md), [the journal and recovery](draft-recovery.md),
  [records and shapes](persistence.md), [the server](server-resources.md).
- A `Decision:` plan name resolves through [the archive](../archived-plan/README.md).

## Files

- `src/ts/storage/resourceSync.svelte.ts`: the save adapter. Beyond Flows: `saving`, `heldRecordRevision` (the job
  channel's barrier), `stopResourceSync` (terminal: fences writes, clears timers and listeners, aborts reads; it saves,
  alerts, and reloads nothing, and the page journal closes separately).
- `setRemoteResourceOwner(kind, { apply, reconcile? })`: the owner of a kind outside the mirror; boot registers
  `noteRemoteInlay`/`reconcileInlays` and `refreshPluginPermissions` (three retries 5 s apart).
- `src/ts/storage/resourceClient.ts`: transport for `/api/resources` and `/api/backups`; `prepareUnloadAuth` +
  `sendBatchOnUnload` send a `keepalive` batch with a pre-signed token.
- `src/ts/storage/{bootCache.ts,recordMerge.ts,readDeadline.ts}`: cache validation, record merge policy, and read
  deadlines.
- `src/ts/network/eventFeed.ts`: the client of `/api/events/ws` (`shared/events.ts`); `src/ts/network/socketLiveness.ts`
  holds its timers and resume triggers.
- `src/ts/bootstrap.ts` `loadData`: boot ordering and the handoff from record installation through sync and feed
  startup.

## Flows

### Boot load

`bootstrap.ts` `loadData`, after the [boot cache](#boot-cache) read:

1. `seedResources`, `seedChats`, `seedInlays`, `seedPluginPermissions` record the server's state before anything changes
   it.
2. `loadSelection`, then `installBootRecords`. A missing section, collection, or `presets` record is an error: the
   server creates and normalizes every record, the client none.
3. `assembleChats` replaces whatever the chat module held (`orderChats` logs a chat or order entry missing from the
   other). `initializeRecords` replaces a missing or repeated `chaId` before any wrapper exists.
4. [Boot recovery](draft-recovery.md#boot-recovery) (`recoverJournal`).
5. The service worker may request a reload. `maintainCharacters` runs `checkCharOrderAtBoot` against the complete
   recovered inventory before saving and the feed start. `initializeChats` gives a chatless character a chat; recovered
   creation reruns no import transform.
6. `startResourceSync()` marks every record once so boot's local writes are saved; unchanged ones are not sent.
7. `importBrowserLocalData`, the remote-record owners, `startEventFeed`, `loadPluginsForBoot`, the UI flags.

### Boot cache

- `loadBootSnapshot` reads IndexedDB `risu-boot-cache` (`BOOT_CACHE_TIMEOUT_MS`), then `readBoot` claims cached records,
  item hashes, and chat collections (at most 5,000 claims and 2 MiB). `expandBootAnswer` yields the plain
  `ResourceReadKindsResult`, so nothing after it changes.
- `BOOT_CACHE_ELIGIBILITY` (`shared/resources.ts`) decides per kind; a kind with a server `project` is never cached,
  whatever the table says, nor a character with a non-empty managed `oaiTTSConfig.apiKey`. Secrets embedded in other
  cached content can remain.
- A chat collection (`@chatCollection`, `chatCollectionClaim`) is cached only from an answer whose `chatSummaryFormat`
  equals the client's: bump `CHAT_SUMMARY_FORMAT` when the summary projection changes.
- An unreadable cache, a failed boot request, or an unusable answer falls back to one plain `readKinds` (its failure
  propagates) with a `bootCache` event; an unusable answer starts a best-effort fenced clear at once.
- The cache holds only what the server sent, never live state. `scheduleBootCacheCommit` (idle or within 5 s) writes one
  transaction fenced by the meta's `generation`, so a tab never overwrites a newer tab's; a failed write clears it, a
  clear keeps a fresh generation to reject delayed writes, and another format or `appVer` clears it on the next write.
- It outlives the tab in the browser profile (`clearBootCache` is the entry point for a future sign-out). A new epoch
  needs no clearing, but two independently written servers must not share an epoch behind one origin.

### Dirty marking

- Every local write of a settings record (`records.svelte.ts`) marks it at once; `llmSecrets`' text is its readable
  siblings, its credentials are [queued](#credential-writes).
- A write of a character's own fields at any depth, selected or not, marks it (`setCharacterWriteListener`); `chats`,
  `chatPage`, `reloadKeys` are outside the record. A membership change (only through `characterStore`) and chat work
  wake the loop.

### Save cycle

- After a 500 ms debounce one cycle runs, never two at once; a later mark never postpones a scheduled cycle. A cycle
  only writes: it never awaits a read of another record, but applies waiting feed patches that need none
  (`applyRemotePatches`).
- Reads run in the background `runRefresh` (own pass, timer, backoff 2 s doubling to 30 s): `reloadDeferredChats`,
  `hydrateCharacters`, `applyRemoteUpdates`, `refreshIdleSummaries`, `readIdleChats`. Stages start independently, a read
  failure never touches the write loop's backoff, and a stage ending with write work pending wakes the loop.
- A batch holding work that waited over 2 s records a `sync` `saveWait` event with its blocker.

### Read deadlines

- Every adapter read goes through `deadlineRead`: aborted after 20 s (`READ_DEADLINE_MS`) or on a halt; `authFetch`
  never dispatches an aborted request. The exception is `watchForRestore`'s own 5 s bound.
- Other reads use `readWithDeadline`: 30 s for an order-repair chunk (`characterOrder.ts`) and the callback barrier's
  chat read (`jobChannel.ts`), 60 s for an export chunk (`chatEdits.ts`), 120 s for each boot read. Chat loads have
  [their own](chat-store.md#limitations).
- A timer around `readRefs` bounds the whole call, continuation rounds included; a call that misses it installs nothing.
  A read whose owner lifetime was replaced is not cancelled; it ends at its deadline.

### Serialization

- A settings record serializes from its live record, a section in `SECTION_FIELDS` order, so an own `__proto__` key
  survives and the text equals the server's normalized text. Characters (`characterProjection`) and `modules`
  (`moduleProjection`) go field by field through text caches; others are uncached.
- A text equal to the server's is skipped; `shareSavedText` then holds a large record's text once.
- A character field reuses its text (`characterTexts`: 8 characters, 64 Mi UTF-16 units) while its value identity and
  `characterFieldStamp` match. A wrapper write under the field or a raw change moves its stamp; fresh data (installed,
  replaced from the server, created) moves all.
- The wrappers copy every plain JSON value written into a character (`adoptCharacterValue`), so nothing shares it; a
  mutator commits cache taint only after preparation succeeds; a local `reloadKeys` input holding record state is
  detached. The raw paths (`initializeRecords`, `applyRawCharacter`, `patchRawCharacter`) take detached JSON, and no
  other module writes through `characterData()`.
- State shared between two fields, or anything not plain JSON (accessor, `toJSON`, function, class instance, null
  prototype, cycle), nulls the character's stamps: it serializes whole every cycle until fresh. A `toJSON` hook also
  gives no cached parts.
- Modules reuse a field's text while value identity and `moduleItemFieldStamp` match (`moduleTexts`, keyed by the
  element's `$state` identity, not its id), and written JSON is copied (`adoptModuleValue`). State shared across fields
  or elements, non-JSON data, or symbol keys nulls all stamps until `applyRaw` installs fresh JSON.
- `canonicalCharacter` runs `normalizeCharacter` on field texts (`canonicalShape`: `CHARACTER_SHAPE_FIELDS` parsed, the
  rest as present or `null`), not a whole parse.

### Batch composition

- One `POST /api/resources/batch` carries records, then chat groups (`takeChatWork`; a group is never split inside a
  request), then reorders, in one server transaction; it splits above 5,000 operations or the client's 100 MiB body cap
  minus a 64 KiB envelope margin, or to isolate an unindexed refusal. A chat created with its character travels with or
  after it.
- The `chaId` list is diffed against the saved characters. A character removed and re-added under one id before a cycle
  is a field update, its chats the [chat module's reconciliation](chat-store.md#character-lifecycle), never a
  delete-then-create: the server refuses two ops of one id, and a delete beside changes to its chats.
- Over 5,000 unsent ops, a chat becomes a held resend prefix under its batch id and a suffix under a fresh id; neither
  is sent that cycle. `takeChatWork` withholds the prefix until
  [split confirmation](draft-recovery.md#split-confirmation); the suffix follows its acknowledgement.
- A same-id chat recreation sends the old delete alone on its held revision, then the create on a null base once the
  delete is acknowledged or confirmed absent. The delete keeps the old id, the create gets a fresh one, and the delete
  alone does not settle the recreation's flush sequence. Deleting the recreation before collection still sends the old
  delete.
- On success the sent text is the saved text; a key marked during the request stays dirty.
- An acknowledged order listing unknown chats keeps the older revision and queues `listRefresh` (`applyRemoteCollection`
  with `keepPendingOrder`, during a generation too). A queued reorder is held (`holdOrders`), then sent on the new
  revision with the new chats after its own, unless a kept chat with a held revision is missing from the list: then it
  is discarded and reported, with the notice.
- A `stale: true` result keeps its base and marks an idle re-base: after the read-back, an idle chat takes the server
  copy with no discard or notice; a busy one keeps the mark.

### Record patches

- `updateOperation` sends a held record with parts as a patch, diffed by text against `baseParts`: object records
  `{ set, remove }` of top-level fields, arrays accepted by `itemIds` `{ items, changes, order? }`.
- `llmSecrets` never gets parts: the server refuses its patch ops, even for readable siblings.
- A create, a record without parts, or a patch no smaller in UTF-8 bytes goes whole. A changed top-level `__proto__`
  sends the object record, or that item, whole; a `toJSON` hook that prevents parts also keeps the whole write.
- Texts differing only in key order become the saved text at the same revision, with nothing sent.

### Lost answers

- A network error, 5xx, or 429 retries with backoff up to 30 s.
- A chat group whose answer was lost (a network error or 5xx, or a failed pagehide request) becomes the chat's
  `Pending.resend`: resent alone, exactly as sent, with `retry`, before anything else of that chat. Newer work, even an
  empty entry with a newer sequence, waits for its answer and goes under a new id, so a replayed group's answer never
  carries newer work down.
- A definitely unapplied group merged back in front of newer work takes the requeued group's id.
- A resend rolled back unanswered (another group's 409, a request never sent) stays a resend. A group a 409 names did
  not land and loses its doubt, except `reason: "expired"`: it takes the ordinary discard with the notice and never gets
  a new identity.
- A lost chat create replays the same way, recognized by a conflict read's exact match unless refused as expired.
  Matching membership in a collection read acknowledges nothing.
- A reorder waits while a batch resends an in-doubt create or delete, until the acknowledgement's order revision or a
  `listRefresh` read (also after a delete confirmed absent); a failed refresh keeps it held.
- A record's lost text stays `inDoubt`: on its base only one write can land. Every cycle resends exactly that text on
  that base, an absent character's lost create included, and newer local text, a revert included, waits with the key
  dirty. The answer, or its 409's read, settles it, and the newer text goes on the server's revision with no discard or
  notice.
- A feed patch or conflict read equal to the in-doubt text becomes the saved base the same way, the mirror keeping this
  client's text. Meanwhile no whole live update or job record enters the mirror, so the echo never overwrites a revert.
- It is cleared by any acknowledgement of the key, a 400/413 refusal, a conflict replacing the record, and the boot
  seed.

### Refusals and quarantine

- A 400 naming `chats[i]...` quarantines that chat and resends the rest; a 400 naming `ops[i]`, or the client-side 413
  pre-check (before dependent chat work is taken), quarantines that resource key at its refused text. Each key alerts
  once per session, unchanged refused content is skipped, and other work keeps saving.
- An unindexed 400/413 from a request of several units sets `isolateBatches`: every later cycle sends one request per
  resource, chat group, and reorder, characters before chats. A request that is already one unit is quarantined
  directly; such a resource alerts once per content change.
- A refused order keeps its intent until its sendable ids change or a Retry. While `isOrderQuarantined` holds it is
  outside the flush's obligations, in `refused`, and still protects page close.
- A refused chat keeps its ops, create/delete intent, and reason. An explicit edit, Retry, or recreation releases it,
  never adoption, requeueing, remote updates, or a no-op edit: a loaded chat then queues a whole replacement at the
  front of pending work on its held revision, a refused create a create, an unloaded chat its metadata ops, a refused
  delete its delete. Deleting a refused create settles it.
- A quarantined character create stays out of `creating`, so its chats wait and membership is unacknowledged. Quarantine
  keeps no idle cycle scheduled.
- `refusedItems()` reads refusals reactively without pruning; treat `key` as opaque. `retryRefused` and `discardRefused`
  refuse once halted. Discard reads and accepts the server copy, re-checking identity and the edit and owner fences
  after its read, so an intervening edit, retry, or recreation wins.

### Conflicts

- A 409 first tries `rebuildConflictRecord` (a waiting feed patch exactly one write past the held revision, or an
  exact-revision `deferredHydrations` entry), else `readRefs`; both run the same steps.
- A server copy equal as JSON to what was sent (a lost response) reloads nothing. Otherwise the record
  [merges](#record-merge).
- An unresolved merge writes the server record into the mirror in place (a removed selected character → home) and
  discards local edits, first [drafted](draft-recovery.md#conflict-capture). `alertReloadNotice` shows once per recovery
  after the last read, also when a read throws after a discard.
- The 409's read stays in the write cycle under the 20 s deadline, since the refused batch depends on it; characters it
  puts in `hydrate` are read by the refresh queue, never inside the refused cycle.
- Every reloaded record reaches `onRemoteRecordApplied` (boot: inlay cache invalidation and, for `characterOrder`, the
  [order repair](persistence.md#character-order-repair)).
- An adopted character create queues `listRefresh` with `keepPendingOrder`, so its chat work saves in one flush. A
  create losing to another writer's under the same id drops its local chats (`forgetCharacter` with `capture`, reported
  on the character only) and reads the server's list (`hydrate`).
- A locally absent character's refresh is parked, scheduling no reads, until a same-id re-add or a confirmed deletion.
- A conflict's acceptance is immediate even for a character a generation runs on: the job refreshes records at its
  barriers, and the server's locks guard the message. Only a `hydrate` list read waits while this tab streams into it
  (`isCharacterStreamedHere`).

### Record merge

- `mergeConcurrentChange` merges the saved base, the server record, and the current projection by `recordMerge.ts`
  (`SECTION_MERGE_GROUPS`, `CHARACTER_MERGE_GROUPS`, `COLLECTION_MERGE_POLICIES`). A unit (a field, coupled tuple, or
  whole item) keeps the side that changed; equal changes converge, different ones conflict. Objects and arrays in a
  field stay atomic.
- Everything is checked before the mirror changes. A success applies detached data raw, rebases with `adoptMergedBase`,
  and keeps the key dirty (equal to the server: no echo), with no draft or notice; any taken field reaches
  `onRemoteRecordApplied`. A failure takes the [whole-record acceptance](#conflicts).
- `llmSecrets` keeps its sibling body as one unit (`adoptSecretSiblings`, shared by the 409, credential-reply, and
  live-update paths); two changed bodies conflict. Masked status always comes from the server record.
- Sections and characters need a saved base; deletions do not merge. Unequal `chaId` or `type` conflict. A taken field
  the mirror only inherits (`assignsInherited`) conflicts: the Svelte proxy cannot store it.
- `statics` counts (`benignChanges`) are best effort: the server's plus local increments.
- `pluginStorage` (`mergePluginStorage`) merges by key, one level down in `_pluginStorage` and
  `_safeLocalPluginStorage`, other top-level keys whole; a reserved name held as no dictionary conflicts. The result is
  a fresh object of own keys. On a discard, `onPluginStorageDiscarded` hears the replaced keys after the record settles.
- Item collections (`mergeItemCollection`): all three lists must pass `itemIds`, which the `customModels` and `modules`
  normalizers do not guarantee. Edit against delete conflicts; same-id additions need equal values; concurrent
  creations, `pluginStorage`'s too, merge against an empty base. Reorders compare surviving base ids: both sides
  reordering, even identically, conflicts; one side's order wins; additions append.
- A merged empty required list conflicts: no client default is manufactured. A merged credential deletion waits for its
  acknowledged owner deletion before secret cleanup.
- A selectable collection keeps this tab's `selectedId` only when this tab alone changed it and its item survives; a
  chosen id absent from the merged items conflicts.

### Chat and order conflicts

- `recoverChatConflicts` reads a conflicting chat back: other groups requeue, recognized create/delete replays settle,
  the rest discard queued edits with the notice, a chat gone on the server included.
- A conflicted reorder keeps its sent vector until the list read (`hydrate`), which settles it quietly when the server
  order equals the vector, else reports `chats/<chaId>` (`markOrderDiscarded`) with the notice; a failed or deferred
  read settles nothing. A newer queued reorder keeps its sequence.
- The read reports work of a chat the list lacks (`chats/<chaId>/<chatId>`; idle ones go silently). A character found
  gone is removed only when neither its held revision nor `chatOwnerToken` moved during the read; otherwise it stays in
  `hydrate`.
- List reads run beside writes: an answer applies only when `listReadGenerations`, `characterWriteSerials` (moved at
  dispatch and settlement of any write carrying the character), `writingCharacters`, and `chatOwnerToken` are unchanged
  since issue; otherwise the id stays queued. Reorders of such a character are held, its chat groups are not.
- A refused create that reads back null is quarantined and kept in the mirror, unless its character is gone.
- A chat a job streams into defers its reload until the locks release (`isChatDeferred`); the reload then discards its
  queued edits.

### Generating refusals

- A 409 entry with `reason: "generating"` blocks the chat's surviving work for `JOB_RETRY_MS` (5 s); a refused character
  delete stays unsaved as long. One cycle is scheduled at that time, `chatGenerating` shows once per episode, and
  blocked work is unsaved but not runnable.
- `dropLockedEdits`, before unrelated conflict reads, drops the by-id edits of the entry's `messageIds` in the refused
  group and newer work, since a retry after the job would land over the finished reply. They are reported as discards
  with `resourceReloaded`; the chat goes stale, read whole once its remaining work landed and this tab's locks released.
- Chat-level ops, a multi-id `remove`, and ops on other messages keep the retry path. The sent sequence settles when
  none is kept.
- The split follows the server's ids, not this tab's locks, so an observer and a tab whose follow ended `lost` are
  alike. It is the fallback for an edit sent before the [lock frame](#feed-locks).

### Record hydration

- `applyHydration` applies a job's record with no discard, settled key, or notice: only a loaded-epoch token newer by
  `compareRevision`, with no local change (not in flight, in doubt, or blocked; projection equal to the saved text). A
  dirty mark alone is no change.
- A record with a local change keeps its newest event for after the next cycle. An unheld record, a deletion, and
  `HIDDEN_HYDRATION_KINDS` are skipped; chats go to [`hydrateChat`](chat-store.md#job-hydration).

### Credential writes

- After the batch, the `llmSecrets` ops queued at collection go one at a time through `/api/llm-secrets/*` on the held
  revision; a later one waits for the next cycle, after its resource.
- A cleanup goes only once its owner left the mirror and the saved copy; it is dropped while the mirror holds the owner,
  and waits, unscheduled, while only the saved copy does.
- A reply's siblings take [`adoptSecretSiblings`](#record-merge); a conflict takes the server's copy with a recorded
  discard and the notice.
- A 409 rereads and retries, at most twice per op per cycle; a 400 or 404 drops the op, reports `llmSecrets/<path>`, and
  alerts; other failures keep the queue.
- `awaitSecretWrites()` throws on a refused op, on only cleanups behind an unsaved deletion, or when halted; `auxFetch`
  calls it first. Unload sends no credential ops.

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

### flushResources

- It settles what was queued before the call (record generations, membership, chat and order sequences, credential ops),
  nothing else, and does not wait for background reads.
- Its ten attempts count write cycles and dependency reads that leave the dependency pending. An obligation waiting only
  on a read starts or joins that one read, never the whole pass, and rejects with its error; other background failures
  neither count nor reject.
- An unanswered pagehide request and a stalled split journal dependency each wait at most 20 s; the timeout rejects
  without releasing the split.
- It resolves `{ discarded, refused }`. `discarded`: events since the call or `beginMutationScope()` (a conservative
  time window). `refused`: `refusedItems()` at resolution. Both use `chats/<chaId>/<chatId>`, `chats/<chaId>` for an
  order, `<kind>/<id>`. An empty discard list does not mean every change is durable.
- A refused chat or order does not block it and remains in `refused` while quarantined; its discard event appears only
  in the flush or scope of that refusal. A refused resource rejects at once (`quarantineReason()`), as does
  generation-blocked work (`GenerationBlockedError`; `generatingNoticeCount()` tells whether `chatGenerating` showed).
- Send admission, `startMemoryTask`, `requestStoredTranslation`, and `readChatsDetached` (also on a refused character
  record) check the target chat and its order against the result, so none acts on the server's older copy of a draft
  held only here. Backup export reports refused changes.

### Unload

- While work is unsaved the loop keeps a signed unload token ready. `visibilitychange` to hidden runs a normal cycle at
  once, bypassing debounce and backoff, then a follow-up if one was running.
- `beforeunload` warns for `hasUnsavedWork`, refused content included, but never once halted, so the notice's reload
  goes through. Refusals keep no loop running.
- `pagehide` sends each chat's pending by-id ops under the batch's existing id, one request per chat, in a shared 60 KiB
  budget counting outstanding keepalives, only when the whole batch is eligible and fits (`unloadPendingChatWork`). A
  failed send keeps the batch.
- A sent group counts as in flight and settles through `settleUnloadWork`; a failed one requeues ahead of newer edits.
  An answer for a group no longer in flight (a confirmed-gone character, a list discard) holds no revision and queues
  nothing.
- Records, creates, deletes, replacements, and reorders use normal cycles only. Keepalive is best effort.

### Transport

- Every mutation sends the loaded epoch (`setResourceEpoch`); every read's epoch is checked once one is loaded.
- `readRefs` re-sends what an answer leaves `unanswered` and returns one answer in request order or throws, never a
  partial merge: no progress is a `ResourceRequestError`, another epoch discards every round, an aborted signal stops
  the loop. Only a character's record and its two collection entries are one round's read
  ([server](server-resources.md)).

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

- Focused: `pnpm --silent test:agent src/ts/storage/tests/resourceSync*.test.ts src/ts/network/eventFeed.test.ts`.
  `slow`: a long-chat case in `src/ts/storage/tests/resourceSyncHydration.test.ts`. `e2e`: `e2e/terminalNotice.spec.ts`.
- Adapter tests use the real Svelte module, a fresh module graph, and fake timers per test.
- `src/ts/storage/tests/fakeResourceServer.ts`: an in-memory `authFetch` resource-route fake with batch, lost-answer,
  failure, and ordering hooks; `src/ts/storage/tests/serverKinds.ts` and `materialize(fake)` keep its record set aligned
  with the server.
- `src/ts/storage/tests/storeBackedServer.ts`: an `authFetch` stand-in over the real store (SQLite in memory);
  `streamingForChat` selects whole-read lock lists, with no locks by default to model an older server.
- `src/ts/network/tests/eventSocket.ts` (`FakeSocket`): the shared fake browser socket.
- Not tested through summaries: most adapter tests and `src/ts/storage/tests/mutationStoresHarness.ts` boot whole chats.
  Only `src/ts/storage/tests/resourceSyncLazyChats.test.ts` and
  `src/ts/storage/tests/resourceSyncAbsentSingleton.test.ts` boot the adapter from summaries throughout.

## Known Hazards

### Issues

- A single oversized chat group is quarantined before dispatch and cannot be chunked; see
  [Batch composition](#batch-composition) for the cap. An edit or Retry still over it quarantines again silently.
- A tab can still edit a generating reply before the job's first write's frame arrives (`hello` cannot list a message
  before `begin`), or, with an older server, after an adopted newer read released the locks, until the next write
  (`CHECKPOINT_INTERVAL_MS` while streaming; longer while a job waits). The edit is [dropped](#generating-refusals), the
  mirror shows it until the whole read, and with no retry block a later edit can land over the finished reply.
- The same window decides when an observer refuses a permanent character delete or different-id replace
  (`isCharacterGenerating`). A fix would announce the job's chat reservation in the feed and read lock lists, locking
  the chat's tail.
- A page restored from the back-forward cache may still wait for an unload answer; `flushResources` gives up after 20 s.
- A save's echo arriving before its acknowledgement schedules a cycle 50 ms later (`noteRemoteChanges`), so continuous
  typing can save more often than the debounce. [Measurements](../audit/projection-bindings-2026-10-04.md) no longer
  show the extra saves, but the 50 ms echo cycle remains; coalescing would bound it.
- A noticed idle chat read whole (`readIdleChats`) before the pass's trim may be evicted once its notice settles,
  wasting the read.

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
- Two tabs editing one record converge only through the 409 path: live updates skip a record with an unsent change.
  Decision: Durable Drafts D11, D8, archive.
- A preset's record and credential are separate requests: a refused credential leaves the entry keyless, and a deleted
  owner's entry stays until cleanup succeeds. Decision: a preset is saved before its key (`resourceSync.svelte.ts`
  credential writes).
- Keepalive has no prefix send: an ineligible batch waits for normal saving and the journal. Decision: Durable Drafts
  D7, archive.
- A loaded chat noticed without a by-id change is read whole when idle: a reply over `MAX_FEED_PATCH_BYTES` (64 KiB)
  into a chat another tab has open costs up to one read per checkpoint. Decision: no by-id read for an over-cap change:
  `delta` removed the measured large-metadata case, and no measurement shows how often an observer meets the rest (ST04,
  [server migration audit](../research/deep-audit-with-fable/server-migration-audit.md)).

### Gotchas

- A quarantined chat a list shows deleted stays in the mirror, left out of reorders. A reorder queued before that list
  blocks the live update (`canApplyRemoteCollection`), conflicts on the order revision (never the permutation refusal),
  and settles with the notice and an order discard.
