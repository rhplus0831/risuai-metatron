# Draft Recovery: Journal, Composer Rows, Recovery Drafts

## Scope

- Owns journal durability and eligibility, composer-row storage, boot recovery, and recovery drafts.
- Not here: save cycle and conflicts → [resource sync](resource-sync.md); chat module → [chat store](chat-store.md);
  composer timing, hand-off, and guarded restore → [chat pipeline](chat-pipeline.md#files); the dialog →
  [UI and theming](ui-theming.md); `sync` events → [diagnostics](diagnostics.md).
- A `Decision:` plan name resolves through [the archive](../archived-plan/README.md).

## Files

- `src/ts/storage/draftJournal.ts`: the store alone. `createDraftJournal` takes injected dependencies;
  `pageDraftJournal` holds one instance for the page, and unmount never closes it.
- `src/ts/storage/journalEligibility.ts` and `src/ts/storage/journalRecovery.ts`: eligibility plus `recoverJournal`, its
  classifiers, `recoveryDraftDetails`, and `applyRecoveryDraft`.
- `src/ts/storage/chatStore.svelte.ts`: `chatJournal`, `captureChatConflict`, `installRecoveredChat`,
  `installRecoveredOrder`.
- `src/ts/storage/resourceSync.svelte.ts`: `flushJournal`, `queueConflictDraft`, `captureRecordConflict`,
  `captureRestoreJournal`; for recovery `heldRecordSnapshot`, `adoptRecoveredRecord`, `adoptRecoveredChat`.
- `src/ts/storage/recoveryDrafts.svelte.ts`: the reactive draft view; `src/lib/Others/ReloadNotice.svelte` and
  `src/lib/Others/RecoveryDrafts.svelte`: the notice and dialog.

## Flows

### Journal store

- IndexedDB `risu-draft-journal` (`entries`, `meta`), one connection per page. An upgrade to the next version adds a
  missing store or index, rows kept. A row of an unknown format, or one `checkJournalRow` refuses, may be the only copy:
  it is kept untouched, never evicted, and reported (`journalSkipped` `format`).
- Keys: `<epoch>\0<tabId>\0<scope>\0<target>` for a mutation entry (`record`, `chat`, `order` layers), `draft\0<id>`,
  `composer\0<chatKey>` and its send hand-off `composer\0<chatKey>\0send`. A record target must be `<kind>\0<id>` with
  both parts non-empty.
- Each layer is stamped with a per-tab version, and each record layer carries its own `op`. A write lands only above the
  stored layer and every removal fence; a removal deletes only through its captured version. So a late write never
  resurrects an acknowledged layer and a late delete never erases newer work. A new page starts above its stored rows.
- `write(items, removals)` applies layer writes and captured-version removals in one transaction, keeping the fences,
  budgets, and a replaced row's creation time; `remove` has the same removal semantics.
- `write(items, removals, drafts)` also puts conflict drafts in that transaction and answers
  `{ committed, writes, drafts }`. A `ConflictDraft` is a `DraftInput` with an id minted at capture, so a retry or the
  restore snapshot overwrites the same `draft\0<id>` row.
- A draft takes its source mutation row's `createdAt` (read before the removals; a reserved row is read, never changed)
  or keeps an earlier copy's, and its transaction's other drafts and writes do not evict it. It is `ineligible` when a
  layer fails `isJournalEligible` and `skipped` (`journalSkipped` `tooLarge` or `budget`) when it does not fit; the
  surrounding removals still commit.
- Chat and order keys held at startup, and destination keys adopted from closed tabs, are reserved for recovery: writes
  and removals skip the whole key, checked again after the row read inside their transaction. Record keys are
  unaffected.
- `release(items)` reads the installed rows' stored layers and versions in one transaction, then frees their
  reservations after commit (a failure keeps them reserved); expired rows are fenced and deleted. `moveToDrafts` frees
  whole-row reservations after commit and can atomically split named layers into a draft, leaving the rest of the row
  reserved. `purgeExpired` also frees expired reservations.
- Budgets: 16 MiB per entry, 64 MiB in all (UTF-8 bytes; only finite, nonnegative stored sizes count). Eviction takes
  recovery drafts and expired composer drafts only, oldest first, never a mutation entry or an unreadable row;
  `putDraft` reclaims only expired rows of those types. A write that does not fit is not written, and the older values
  of its layers go (`journalSkipped` `tooLarge` or `budget`).
- Expiry: 48 h after `createdAt`, which every change, adoption, and conversion to a draft keeps. `readOwn` and
  `listDrafts` leave expired rows out; `purgeExpired` deletes them, fencing owned mutation keys through its call-time
  version counter.
- The page holds `risu-journal-owner:<tabId>` for its life. The id lives in `sessionStorage` `risu-journal-tab`; a
  duplicated tab that finds it held mints a new one.
- `adoptOrphans` re-keys a closed tab's rows under `risu-journal-recover`, one transaction per tab, waiting at most 5 s
  for that lock. A key this tab already holds turns the orphan into a draft; expired or ineligible orphans are deleted.
  A tab whose owner lock is refused is alive, hidden or frozen included, and keeps its rows.
- Startup seed reads and orphan transactions use the 3 s open timeout and abort on expiry (`journalFailed` `timeout`); a
  failed start releases ownership. Without IndexedDB, Web Locks, or `sessionStorage` the journal is off and every call
  answers as if empty.
- `close` admits no new call but drains those admitted before it within the same bound (one issued in the same tick
  included; a composer call is admitted at once once the journal has started), then aborts remaining transactions,
  closes the connection, and releases ownership.
- A write whose layers `structuredClone` refuses (a `$state` proxy, a function) answers `failed`, reports
  `journalFailed` `uncloneable`, and removes the older stored values of those layers, as a budget skip does; the rest of
  its call still writes.

### Eligibility

- `journalEligibility.ts` `isJournalEligible`, with `JOURNAL_EXCLUDED_KINDS`, is the one boundary for what enters the
  journal: a mutation's layers, a recovery draft, an orphan adopted from a closed tab. Never the excluded `llmSecrets`,
  `secrets`, `authRefreshes`, `pluginStorage`, `plugins`, a character with `oaiTTSConfig.apiKey`, or a
  `providers`/`customModels` record naming a `header::` parameter.
- Secret-looking text in prompts, lore, module scripts or URLs, and messages is still journaled like any other user
  content, as the server already stores it. Decision: Durable Drafts D1, Q2, archive.
- A record that fails is not journaled at all, never stripped of a field, so a recovered text is always one the tab
  would have sent. An ineligible layer's older stored value is removed, and an excluded kind loses its whole entry.
- A character is parsed only when its text has a `"apiKey"` member with a non-empty string value or a real `\u` escape,
  not an escaped backslash before `u`, so a large character is not parsed at every journal write. A checked text that is
  not JSON is refused once it has to be parsed.

### Composer API

- `readComposer`, `readComposerSend`, and the calls below start the journal on demand. A chat has two browser-wide rows:
  the editable draft and the hand-off of the send that consumed it (`state: "sending"` with its message id), so typing
  during that send never replaces what was sent. A write keeps `createdAt` while the row is live; a write after expiry
  starts a new entry.
- `checkComposerValue` validates rows: optional `requestId` and `requestEpoch` strings must appear together with a
  message id. Older rows without them stay readable in the same journal format, and so does a hand-off an older page
  kept in the draft row.
- `putComposerSend` writes the hand-off and deletes the consumed draft in one transaction;
  `putComposer(chatKey, value, takeOver)` writes the draft and deletes the hand-off still carrying `takeOver` in one
  transaction. Either swap budgets the row it deletes as gone and keeps both rows out of its eviction, and a skipped
  write deletes nothing.
- `updateComposerRequest` checks the message id and any stored request id of both rows inside one write transaction,
  clearing a known attempt's request identity or adding retained identity to a matching row that lacks it. Expired,
  absent, unreadable, and newer-attempt rows stay; composer fields and `createdAt` are preserved; the ordinary write
  budgets and failure reporting apply.
- `settleComposerSend` (a landed send) deletes the hand-off carrying its id, also one in the draft row, and drops that
  id and its request identity from a draft still carrying them, keeping the draft's text.
- `removeComposer` deletes only the draft, checking a given message id inside the transaction.
  `removeComposersOf(chaId, chatId?)` deletes both rows of a chat, or of every chat of a character, by key range.
- `onChatRemoved` (`chatStore.svelte.ts`) is a listener set with isolated listener errors: local deletion, remote
  single-chat deletion (a retained last chat included), collection removals and conflict reconciliation, and
  `forgetCharacterChats`/`forgetCharacter` notify it (`chatId: null` for a character). The composer module subscribes at
  app load and removes the browser's rows with no screen mounted; merely unloading a chat does not notify it.

### Journal writes

- The adapter keeps eligible record intent under the loaded epoch and `recordTarget(kind, id)`: `sent` (op, base, whole
  text, dispatched, in-doubt), `latest` (op, base, newer text, a revert behind an in-doubt write and a blocked character
  delete included), and `refused` (op, text, reason). Membership creates and deletes are records too.
- Membership changes queue only creates, deletes, in-doubt characters, and characters with held journal intent;
  unchanged characters keep their cached projections, and collection projects the character object already in its loop.
- Record intent is projected apart from sendable ops, taking no chat work (`refreshJournalRecord`). Projections are
  reused at the same dirty generation and character identity; dispatch, in-doubt, refusal, and base changes update
  layers independently.
- Acknowledgements, adopted lost writes, and merges move the newer intent to the base the adapter will send. A refusal
  replaces `sent`, an edit or Retry releases it, and acceptance of a remote copy removes discarded intent.
- Only layers changed since this page's last write are written again; removals capture each layer's written version. The
  adapter never reads or recovers old journal rows.
- One serialized queue (`flushJournal`) waits for startup before allocating versions or issuing any write or removal. A
  failed start turns it off for the page, and a restore halt prevents even queued calls waiting on startup.
- Pending deltas are flushed together before the cycle's first dispatch, conservative `sent` marks for every batch of
  that cycle included. Dispatch waits for IndexedDB only for creates, whose dispatched mark is bounded by a cleared 200
  ms timer (`waitForCreateJournal`), and for a chat [split](#split-confirmation).
- Later outcomes and changes outside a cycle get a 500 ms journal timer, absorbed by the next cycle's pre-dispatch flush
  when it runs first, so continuous edits normally use one transaction per cycle; an idle acknowledgement gets a cleanup
  transaction. Both hide events flush independently of a running save, deferred large values included.
- A layer over 256 KiB (whole text in UTF-8 bytes, never patch bytes) is written at most every 5 s per key, except
  creates and hide flushes. A deferred replacement keeps the previously written value until the throttle expires or a
  hide flush replaces it, and the newest in-memory delta replaces or cancels it. A desired layer that becomes absent
  (acknowledged, discarded, or settled without work) is still removed at the flush without throttling.
- Before the journal clones values, the adapter excludes credential-bearing kinds and entries whose summed text lengths
  already exceed 16 MiB. An oversized update skips its changed layers, removes their older stored values through their
  captured versions, keeps unchanged layers, and reports `journalSkipped` `tooLarge` at most once per key and content
  generation. Full text eligibility and exact UTF-8 budgets stay the journal's boundary.
- The restore snapshot (`haltForRestore`) is one write outside that queue, within the bound of the
  [restore halt](live-updates.md#restore-halt). `captureRestoreJournal` takes, synchronously and before anything
  settles, every record view with a desired or written layer or a transaction in flight, and every chat/order view (an
  empty projection included).
- It goes under each view's old epoch, with every layer of the scope written or nulled at one fresh version issued after
  startup, so a pre-halt write or removal that lands later cannot override it. It ignores the large-record throttle; an
  entry over 16 MiB keeps its unchanged layers and drops its changed ones; reserved chat/order keys are skipped.
- Nothing journals mutation rows after it: late answers, cycle cleanup, timers, and hide events leave the snapshot as
  written. The next boot drafts its rows as another epoch's and replays none.

### Chat journal

- `chatJournal` owns the projections, detached and cached per layer. Per chat, `resend` holds the in-flight or kept
  group as sent (ops, base, id, sequence, doubt), `pending` real unsent ops with their before values, batch id, held
  base, and an optional create snapshot or delete flag, and `refused` the quarantined intent. An empty pending shell is
  no intent.
- Per character, orders hold `sent` (in-flight or recovering vector and base), `latest` (pending local member ids and
  base, except the same quarantined vector), and `refused` (vector and reason). A lost order answer returns to the
  current pending vector, without an exact order resend.
- Projection never takes work, clears a refusal, or changes the mirror. `setListener` delivers dirty keys, work queued
  before subscription included.
- Each pending batch gets its own `groupId` at creation, shared by normal dispatch and whole-batch keepalive, so every
  journaled version of a batch names the id the server will remember.
- By-id ops keep a local `before` sidecar captured before the mirror write; the wire carries only the ops.
  `JournalBefore`/`JournalChatOp` define it: `data` for a text edit, the whole row for `setMessage` or a single
  `remove`, the translation or absence for a translation edit, absence for every appended id, and only the existing
  touched fields for `patchMessage`/`meta`, whole prior `merge`/`mergeUnset` maps included.
- Whole-chat ops and multi-id removes have no `before`; generation ops have no local producer and no invented one.
  Coalescing keeps the first value or absence per touched field ([fold rules](chat-store.md#chat-writes)); clones,
  reanchoring, and message-id acknowledgements keep the sidecar.
- Creates reuse their projected mirror snapshot until its content changes; an unchanged resend is not cloned for a newer
  pending edit.
- Chat and order deltas share the [journal queue](#journal-writes) and its transaction, with separate bookkeeping.
  Changed layers have no large-value throttle, unchanged layers reuse cached projections, removals use each layer's
  captured version, and failed writes are retried.
- Taken groups and orders are projected after oversized groups are quarantined, before dispatch; later order rebases
  invalidate `sent` again. Acknowledgements, retries, refusals, discards, conflict repair, collection acceptance, and
  changed bases invalidate their layers even without another local edit.
- Character removal journals its record delete and invents no per-chat deletes. Its parked resends and unanswered
  in-flight chat groups stay until an authoritative outcome; a re-add restores them, and an acknowledged parent deletion
  replaces old intent with the re-added chats' creates.
- `stopResourceSync` and a restore halt detach the journal listener and clear queued keys and timers.

### Split confirmation

- A [split batch's](resource-sync.md#batch-composition) prefix is a resend marked `unconfirmed` under the batch's id. It
  stays out of `takeChatWork` until the journal confirms it: that id must not reach the server as a prefix while its
  recoverable row still names the whole batch.
- A flush writes such a chat's whole projection, even unchanged, for a per-item outcome rather than a resolved flush.
  `written`, `skipped`, and `ineligible` confirm it (`confirmSplit`); `stale` queues the key again.
- A failed write retries, counted per split (`splitFailures`), and the second failure confirms anyway. A journal that is
  off confirms at once.
- A [`flushResources`](resource-sync.md#flushresources) obligation on a split waits at most 20 s for the journal; the
  timeout rejects the flush without releasing the split.

### Conflict capture

- Before each path that drops this tab's intent for the server's copy, the dropped work is queued as a recovery draft
  (`queueConflictDraft`, private to the adapter, skipped when the journal is off or the adapter halted). The next flush
  writes it in the same transaction as the removal of the layers it replaces; an ineligible or over-budget draft is
  skipped while that cleanup still commits.
- A failed transaction keeps the drafts queued and the record bookkeeping unadvanced, and the restore snapshot writes
  queued and uncommitted drafts under their ids. Each committed draft refreshes `recoveryDrafts`, so the reload notice
  offers the dialog.
- Records (`captureRecordConflict`: the 409 acceptance after a failed merge, a character found gone by its hydration
  read): the abandoned `sent` or in-doubt write, the newest local text or deletion as `latest`, and an exact `refused`
  text, captured before the recovery clears `inDoubt`. A recognized landed write, an adopted in-doubt write, a merge,
  and a clean record draft nothing.
- Chats (`captureChatConflict`, through `chatJournal.setConflictListener`): conflict replacement and a gone or locally
  deleted chat in `recoverChatConflicts` (the conflicted group as `resend`, newer work as `pending` with its befores,
  refused work), a deferred reload, and a collection recovery removing a chat.
- A remote character removal or a lost same-id create (`forgetCharacter` with `discard` or `capture`) captures pending,
  in-flight, refused, and parked work and its order intent; the deletion it fulfils is left out. A gone chat whose
  mirror holds the local work carries its final projection as `pending.createSnapshot`; recovered resends never do.
- A `generating` refusal drafts only the removed ops of the locked messages.
- Orders: the vector actually discarded (a differing recovering `sent` vector, the queued `latest` or `refused` vector,
  a queued reorder a live rebase drops), never a surviving newer reorder. Parked resends a server list supersedes are
  drafted as `resend`.
- An explicit Discard (`discardRefused`) drafts none of the intent the user chose to discard; collateral losses in the
  same call are drafted.

### Boot recovery

- This is `journalRecovery.ts` `recoverJournal` and, for records, `decideRecordRecovery`; chat and order rows are in
  [Chat recovery](#chat-recovery). It runs in the [boot load](resource-sync.md#boot-load), before the service-worker
  step, maintenance, or chat initialization. Under one 5 s deadline it starts the page journal, adopts orphan rows,
  purges expired rows, reads its own rows, classifies them against the server snapshot, moves ambiguous rows to drafts,
  and lists drafts, adoption collisions included.
- Decisions precede local installation. Other epochs become drafts with no Apply. Current-epoch chat and order rows are
  classified once the record decisions establish which parents survive.
- Refused or unsupported records, an absent update target, a dispatched create whose target is absent, and a moved base
  with no matching value become drafts. An ineligible row is removed with no draft of its content.
- An undispatched create or an unchanged-base update or delete is installed locally. An unresolved sent update is also
  restored to `inDoubt`, so the normal collector resends that exact text before a newer positive value or revert.
- A recovered local character deletion keeps the delete-first path: if the earlier update wins the race, the delete
  conflicts, `adoptInDoubt` recognizes that update during the read, and the next cycle deletes on its revision.
- A non-null sent value equal to the server settles that layer and allows coherent newer intent on the current revision.
  An absent target satisfies a delete unless a sent delete has a newer re-add, which is drafted.
- An already-satisfied final value needs no outgoing write unless an earlier request can still land on that revision: a
  matching re-add behind an unresolved sent delete is drafted, since a no-op cannot protect it and the adapter never
  seeds a null in-doubt value.
- Characters, other records, and `characterOrder` install first, then recovered chats and orders, then selection and
  language. Installation uses `replaceRecord`, `writeCharacterFieldsAt` (validated own fields, without import
  transforms), and `removeCharacters`.
- A recovered character with its first chat needs no synthetic chat from `initializeChats`; recovered whole-record
  intent wins over the first-boot overlay.
- Replayed and satisfied rows hand their epoch and copied stored layers, versions included, to the adapter
  (`adoptRecoveredRecord`, `adoptRecoveredChat`). A row whose installation fails is reported (`journalSkipped` `format`)
  and kept for another boot.
- Rows stay durable until the adapter's first journal flush, once sync starts, replaces or removes old layers through
  their captured versions in one transaction; a settled key without a chat projection yields empty layers. A
  service-worker reload before sync starts can therefore recover the same row again.
- After each await the recovery lifetime is checked. A timeout or unexpected failure invalidates it, closes the journal
  for the page (at most another 3 s to drain), reports `journalFailed`, and continues boot; a late result cannot install
  intent. Each malformed row is isolated.
- Successful boot decisions emit `journalRecovered` with `entries`, separately from adoption's `orphan` event.

### Chat recovery

- `journalRecovery.ts` `decideChatRecovery`, `decideChatOpsRecovery`, and `decideOrderRecovery` classify these rows
  inside `recoverJournal`; `chatStore.svelte.ts` `installRecoveredChat` and `installRecoveredOrder` install them. Absent
  parents, refusals, malformed rows, and uncertain work become drafts in the existing dialog shape.
- `decideChatRecovery` retries an existing chat's sent group with its exact ops, base, original `groupId`, and
  `retry: true`, atomically splitting its dependent pending layer into a draft first. A dispatched create whose chat is
  absent is drafted.
- An undispatched create installs its snapshot under its original chat id. Pending batches above 5,000 ops become
  drafts, because a prefix may have landed under their id.
- Whole-chat and generation ops require their unchanged boot revision. By-id batches load and pin the whole chat:
  `decideChatOpsRecovery` checks exact before values in operation order, or the final touched values to recognize landed
  work; unsupported combinations become drafts.
- Replayed pending batches may already have gone out, so they are isolated in-doubt resends under their own id and base.
- Deletes also read the chat for generation locks, are drafted if generating or the last chat, and otherwise remove it
  from the mirror.
- `decideOrderRecovery` checks the final vector against membership after recovered creates and deletes: an unresolved
  sent vector can replay only itself, a landed sent vector settles or permits latest intent on its current revision, and
  latest-only intent settles if already held or replays on its unchanged base.
- Chat/order reservations are released only after synchronous installation and adoption; failed installations keep their
  rows reserved. A chat or order row whose whole move yields no draft aborts recovery. Expired reservations are purged,
  including rows omitted by `readOwn`.

### Recovery drafts

- `recoveryDrafts` is the reactive view of `listDrafts`: `entries` leaves expired rows out, `replace` leaves out record
  drafts failing `isJournalEligible`, and `discard` asks for a confirmation. Export, per draft or all (`exportDrafts`),
  downloads JSON without removing drafts.
- A 60 s timer runs while it holds drafts, so an expired draft leaves the view, the notice, and the Settings row without
  a reload.
- `ReloadNotice.svelte` shows a separately dismissible draft notice even without a conflict notice. Its Review button
  opens the dialog ([UI and theming](ui-theming.md)), as does the Settings → Advanced "Recovered changes" row
  (`adv.recoveredChanges`, shown only while drafts exist).
- `recoveryDraftDetails` names a draft and says whether it can be applied. Another epoch's draft, a gone character, a
  gone chat without a snapshot, and an invalid or ineligible row have no Apply; a generation in the target blocks it.
- `removeDraft` answers true once the draft is deleted or already absent, false on a failed delete or a journal that is
  off or closed. `recoveryDrafts.remove` then throws (`removeFailed`) and keeps the row, so Discard alerts instead of
  hiding a draft that would come back at the next boot.

### Apply

- `journalRecovery.ts` `applyRecoveryDraft` applies one draft through the normal writers and keeps it until the save is
  confirmed. After `assertSaveAdmission`, refusing an expired draft, it writes inside `beginMutationScope` the newest
  layer: `latest`, then `sent`, then `refused`.
- A record goes through `replaceRecord`. A character goes through `replaceCharacterFields`, `addCharacter` when absent,
  or `removeCharacters` for a delete, and is refused while it generates.
- An order is `reorderChats` of the draft vector filtered to the current chats, with new ones appended.
- Chat ops (resend, refused, then pending) become new by-id writes on the loaded, pinned chat (`applyChatOps`),
  appending only messages not yet present and removing only present ids. Admission, epoch, owner, and generation are
  checked again after the load. Skipped ops are listed: missing targets, whole-chat ops, a translation whose source
  changed.
- A gone chat with a snapshot goes through `chatStore.svelte.ts` `createChat` under the draft's own id. The snapshot is
  `pending.createSnapshot`, which already holds every queued edit, or else the last `create`/`replace` chat followed by
  the ops after it, applied as for an existing chat.
- That id names the Apply's destination across retries and reloads: when a chat with it exists (an earlier Apply whose
  answer was lost), Apply writes nothing and only flushes and removes the draft.
- It then awaits `flushResources({ scope })` and removes the draft only when neither `discarded` nor `refused` names its
  keys; otherwise the draft stays and a second Apply writes on the revision the conflict reload brought.
- A failed removal after a confirmed Apply says the changes were saved and the draft should be discarded, not applied
  again (`appliedNotRemoved`). `recoveryDrafts.markApplied` turns that draft's Apply off with the same reason for the
  rest of the page; a reload brings Apply back.

## State

- `draftJournal` keeps a page-local version counter, removal fences, and reservations. The adapter's `journalRecords`,
  `journalChatViews`, and pending-key sets are described under [Journal writes](#journal-writes); the chat module's
  `journalChats`, `journalOrders`, `createSnapshots`, and `beforeValues` under [Chat journal](#chat-journal).
- `conflictDrafts` holds detached captures with stable ids until [their commit](#conflict-capture).
- `recoveryDrafts` is the reactive view, tagging rows from another epoch as `otherEpoch`; the journal remains the
  durable source. Notice dismissal is page-local and independent of conflict dismissal. Discard and confirmed Apply
  remove rows from both.

## Coupling

- `bootstrap.ts` `loadData` awaits `recoverJournal` after `applyFirstBootDefaults`.
- `startResourceSync` connects the chat module (`chatJournal.setListener`, `setConflictListener`).
- The adapter alone writes mutation rows; `journalRecovery.ts` moves and releases them.
- `composerDrafts.svelte.ts` is the composer API's only caller.
- `bootCache.ts` `holdsCredential` also decides eligibility: a change there moves the journal's boundary.

## Invariants

- Journal failures never fail a save: methods resolve, and transaction outcomes are reported only after commit. An
  IndexedDB transaction awaits only IndexedDB requests, so it cannot commit early.
- [`isJournalEligible`](#eligibility) gates every incoming layer; a refusal excludes the layer wholesale rather than
  stripping fields. Layer roles determine intent, while versions only fence writes and removals within a page.
  [Boot recovery](#boot-recovery) replays only safe work from the same epoch; other eligible work becomes a draft, never
  a direct replay.
- Recovery never seeds the server baseline with local intent: `persisted` and the boot cache's captured texts stay
  unchanged.

## Recipes

- Adding a setting or resource → [persistence](persistence.md#recipes).

## Tests

- Focused:
  `pnpm --silent test:agent draftJournal journalEligibility journalRecovery resourceSyncJournal RecoveryDrafts`. No
  `slow` or `e2e` membership.
- `src/ts/storage/tests/fakeLockManager.ts` models callback turns, `ifAvailable`, and waiting-request signals;
  `src/ts/storage/tests/draftJournal.test.ts` uses it with `fake-indexeddb`, an injected clock, and fake timers.
- `src/ts/storage/tests/resourceSyncJournal.test.ts` uses `src/ts/storage/tests/mutationStoresHarness.ts`,
  `fake-indexeddb`, the lock fake, fake timers, captured lifecycle listeners, and a transaction-completion barrier for
  adapter journal writes.
- `src/ts/storage/tests/recoveryBootServer.ts` adds the real boot route to [`StoreBackedServer`](resource-sync.md#tests)
  and can switch the fallback read; `src/ts/bootstrap.journalRecovery.test.ts` loads twice on one IndexedDB factory and
  simulates reload by stopping sync, closing the journal, removing listeners, and resetting the module graph.
- Manual crash coverage: `util/playwright/checkDurableDrafts.mjs` uses a persistent Chrome profile to exercise a kill
  before dispatch, after server commit with the answer held, and during an uncommitted journal transaction.
- Not tested: pending writes across a back/forward cache return (`runBfcache` only reports the browser's evidence).

## Known Hazards

### Issues

- Apply removes a draft once its save succeeds even when it skipped ops: the skipped content is named only in Apply's
  result, not kept. A draft of edits answered `missing` therefore keeps their text only until Apply; Export keeps it.
- A recovered field edit to a character whose `trashTime` is already past the boot prune threshold can become a deletion
  during maintenance.
- The conservative `sent`/`resend` marks of a cycle can outlive an early exit, leaving a dispatched mark for a later
  batch that never went: harmless for an update, but recovery treats such a create as a draft rather than creating it.
- A stale `pending` row can name ops that landed under a merged or reanchored id. If its before value matches again (or
  an appended id has since been deleted), a later recovery can re-apply those ops. Coalescing and deliberate withdrawal
  also mean a remembered id does not prove that every older form of its intent was applied.
- A metadata before captured from an unloaded summary may differ from raw storage (for example, omitted `pinned:false`),
  so recovery may conservatively draft it.
- A composer draft typed during a send with that send's text carries its message id (`retryIdFor`). The page's own
  settlement keeps it as a plain draft, but a reload before that settlement cannot tell it from the send's text placed
  back after a failure: `composerDrafts.svelte.ts` `restore` finds the message landed and deletes the draft, so the
  retyped text is lost. Keeping it would bring already-sent text back after every uncertain end that landed
  ([JR1](../audit/cross-plan-2026-10-29.md#jr1--a-landed-send-deletes-an-identical-drafts-journal-row), remaining case).
- `updateComposerRequest` reports one `journalSkipped` event with `entries: 1` even when both of the chat's rows are
  unreadable and skipped; both rows stay untouched.

### Limitations

- A missing-chat Apply creates its chat under the draft's id so a retry finds it; a destination that another tab deleted
  after the create landed is created again by an Apply retried after a reload (the server keeps no tombstone of the
  deleted chat). Decision: DD3,
  [durable drafts audit](../audit/durable-drafts-2026-10-29.md#dd3--retrying-a-missing-chat-apply-creates-another-copy).
- After two failed split-journal writes (or with the journal off or the row skipped), the prefix can dispatch without a
  durable split record. Oversized pending batches become drafts instead of replaying a prefix; see
  [Split confirmation](#split-confirmation). Decision: Durable Drafts D7, archive.
- Quarantined chat intent stays local: eligible, in-budget refusals are journaled and become recovery drafts on the next
  boot, while server backups omit it and report that omission. See [Chat journal](#chat-journal) and
  [Boot recovery](#boot-recovery). Decision: Durable Drafts D5, D8, archive.
- A stale Retry or edit of a loaded whole-chat replacement takes
  [normal conflict recovery](resource-sync.md#chat-and-order-conflicts); eligible abandoned work is captured as a draft
  ([Conflict capture](#conflict-capture)). Decision: Durable Drafts D5, D8, archive.
- An `expired` answer to a recovered group enters durable refusal quarantine with its rejected and newer ops. Retry
  explicitly reapplies that intent from its ops under a fresh id, since recovered work never entered the mirror; Discard
  accepts the server; the next boot moves the refused layer to recovery drafts. Decision: the archive's Durable Drafts
  entry; no automatic fresh id is D2 (f).
- Each recovered acknowledgement, remembered duplicates included, marks its chat for a whole idle reread: until that
  read, the mirror can still lack recovered edits, and newer local work can delay it. Decision: Durable Drafts D2 (a),
  archive.
- Before-value checks protect the state recovery observed; a remote edit between that read and dispatch can still be
  overwritten by a by-id op, because the server has no field preconditions. Decision: Durable Drafts D2 (e), Review
  record point 11, archive.
- Chrome discards a journal write begun in `pagehide` when the page unloads
  ([observation](../audit/durable-drafts-observations-2026-10-29.md)), so the hide flush protects only a page that stays
  alive hidden, such as a backgrounded PWA killed later. Crash and kill protection comes from per-cycle writes and the
  500 ms journal timer; there is no `localStorage` fallback. Decision: the archive's Durable Drafts entry.
- A kill between an edit and its cycle's journal commit loses that edit unless its batch already reached the server. The
  500 ms save debounce and journal timer are nominal scheduling, not a maximum loss window: queueing, throttling, and
  failed transactions can extend it. Decision: Durable Drafts D7, archive.
- If a create's dispatched mark misses its 200 ms bound, and the create lands, its answer is lost, and another writer
  deletes it, recovery can recreate it once after a crash. Decision: Durable Drafts D7, Out of scope, archive.
- An entry over 16 MiB drops changed layers while retaining unchanged ones (for example, an in-flight `sent` beside an
  oversized `latest`); the large-record throttle adds a nominal 5 s to the uncommitted-edit loss window. See
  [Journal writes](#journal-writes). Decision: Durable Drafts D3, D7, Q4, archive.
- Conflict-lost content survives only when the journal runs and the draft is eligible and within budget; otherwise the
  cleanup commits without the draft. See [Eligibility](#eligibility) and [Conflict capture](#conflict-capture).
  Decision: Durable Drafts D1, D6, archive.
- A draft Apply that conflicts keeps its own draft and adds one of the abandoned applied text. A parked resend a server
  list supersedes is drafted even when it landed (the list cannot tell). Ops answered `missing` are kept as a draft of
  their text by `ackChatWork` ([By-id ops](chat-store.md#by-id-ops)). Decision: Durable Drafts D8, archive.

### Gotchas

- A back/forward cache return with the owner lock held is possible
  ([observed](../audit/durable-drafts-observations-2026-10-29.md) in one headless configuration, no guarantee for headed
  Chrome or an installed PWA): do not assume the lock keeps the page out of the cache.
- Recovery compares adapter-produced compact JSON with `sameJson`, which ignores object key order only for equal-length
  texts; arbitrary pretty-printed equivalents are not recognized.
