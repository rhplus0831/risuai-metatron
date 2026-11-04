# Draft Recovery: Journal, Composer Rows, Recovery Drafts

## Scope

- Owns journal durability and eligibility, composer-row storage, boot recovery, and recovery drafts.
- Not here: save cycle and conflicts → [resource sync](resource-sync.md); chat module → [chat store](chat-store.md);
  composer timing, hand-off, and guarded restore → [chat pipeline](chat-pipeline.md#composer-and-drafts); the dialog →
  [UI and theming](ui-theming.md); `sync` events → [diagnostics](diagnostics.md).
- A `Decision:` plan name resolves through [the archive](../archived-plan/README.md).

## Files

- `src/ts/storage/draftJournal.ts`: durable store and tab ownership; `createDraftJournal`, `pageDraftJournal`,
  `DraftJournal`, `JournalBefore`, `JournalChatOp`, `checkComposerValue`.
- `src/ts/storage/journalEligibility.ts`: content admission boundary; `isJournalEligible`, `JOURNAL_EXCLUDED_KINDS`.
- `src/ts/storage/journalRecovery.ts`: boot classification and explicit Apply; `recoverJournal`, `decideRecordRecovery`,
  `decideChatRecovery`, `decideChatOpsRecovery`, `decideOrderRecovery`, `recoveryDraftDetails`, `applyRecoveryDraft`.
- `src/ts/storage/chatStore.svelte.ts`: chat and order journal projections and installation; `chatJournal`,
  `captureChatConflict`, `beforeValues`, `installRecoveredChat`, `installRecoveredOrder`.
- `src/ts/storage/resourceSync.svelte.ts`: journal adapter; `journalRecords`, `journalChatViews`,
  `refreshJournalRecord`, `flushJournal`, `queueConflictDraft`, `captureRecordConflict`, `captureRestoreJournal`,
  `writeRestoreJournal`, `heldRecordSnapshot`, `adoptRecoveredRecord`, `adoptRecoveredChat`.
- `src/ts/storage/recoveryDrafts.svelte.ts`: reactive draft view; `recoveryDrafts`, `exportDrafts`.
- `src/lib/Others/ReloadNotice.svelte`: draft notice and Review entrypoint; `recoveryDrafts.open`. Owned by
  [UI and theming](ui-theming.md).
- `src/lib/Others/RecoveryDrafts.svelte`: review dialog; `recoveryDraftDetails`, `applyRecoveryDraft`. Owned by
  [UI and theming](ui-theming.md).
- `src/ts/process/composerDrafts.svelte.ts`: composer timing and journal-row lifecycle; `createComposer`,
  `onChatRemoved`. Owned by [chat pipeline](chat-pipeline.md#composer-and-drafts).

## Flows

### Journal store

- `createDraftJournal` and `DraftJournal` define storage, keys, version fences, reservations, budgets and failure
  behavior in `src/ts/storage/draftJournal.ts`; `pageDraftJournal` owns the page's shared instance.
- Under `adoptOrphans`, a refused owner lock means the other tab is alive, hidden or frozen included, and retains its
  rows. Only rows of an owner whose lock can be taken are re-keyed to this tab under the recover lock; collisions become
  drafts. Rows handed back to saving stay reserved through installation and adoption; committed whole-row moves to
  drafts and expiry cleanup also free reservations.

### Eligibility

- `isJournalEligible` gates mutation writes, drafts and orphan adoption in `draftJournal.ts`; `bootCache.ts`
  `holdsCredential` shares the character-credential boundary. Read the eligibility module's header before widening it.
- Free text in prompts, lore, module scripts or URLs, and messages is journaled like other content, as the server
  already stores it. Decision: Durable Drafts D1, Q2, archive.

### Composer API

- `composerDrafts.svelte.ts` uses `DraftJournal`'s composer API on the shared page journal: the editable draft and a
  send's hand-off occupy separate browser-wide rows, so typing during a send cannot replace what it sent. Read
  `checkComposerValue` and the composer method comments for compatibility and atomic swaps.
- `onChatRemoved` in `chatStore.svelte.ts` notifies isolated listeners for local and remote single-chat deletion (a
  retained last chat included), collection removals, conflict reconciliation, and
  `forgetCharacterChats`/`forgetCharacter` (`chatId: null` for a character). The composer subscribes at app load and
  removes the browser's rows without a mounted screen; unloading a chat does not notify it.

### Journal writes

- The adapter's `refreshJournalRecord` projects intent independently of sendable operations. `flushJournal` sends record
  and chat/order deltas through `draftJournal.ts` in one serialized transaction, after startup seeds versions. The
  adapter never reads or recovers old rows; recovery hands them over through `adoptRecoveredRecord` and
  `adoptRecoveredChat`.
- The save cycle flushes pending deltas before its first dispatch, including conservative `sent` marks for every batch
  in that cycle. Creates alone wait for IndexedDB, bounded to 200 ms by `waitForCreateJournal`; chat prefixes also
  require [split confirmation](#split-confirmation).
- Later outcomes and changes outside a cycle use a 500 ms journal timer, absorbed by the next cycle's pre-dispatch flush
  if due first. Continuous edits normally share that transaction; an idle acknowledgement gets cleanup. Both hide events
  flush even during a running save, including deferred large values. Throttle, cached projections and oversized-layer
  behavior live on `flushJournal`.
- Inside the [restore halt](live-updates.md#restore-halt), `haltForRestore` synchronously calls `captureRestoreJournal`
  before anything settles, taking desired/written/in-flight record views and every chat/order view, empty projections
  included. `writeRestoreJournal` writes this snapshot and uncommitted conflict drafts outside the normal queue, under
  the views' old epochs.
- After capture, late answers, cycle cleanup, timers and hide events cannot enqueue new mutation-row writes. Before
  showing the terminal notice, `haltForRestore` starts the snapshot write and a 1 s timeout for waiting on it. After
  acknowledgement, reload waits only for that existing race; timeout or write failure does not prevent reload. The next
  boot drafts remaining old-epoch rows rather than replaying them.

### Chat journal

- `chatJournal` supplies detached cached layers to the adapter; it never takes work or changes the mirror. By-id ops'
  local `before` sidecars belong to this projection (`JournalBefore`/`JournalChatOp` in `draftJournal.ts`); only ops
  travel on the wire. Sidecar retention and layer invalidation are documented on `beforeValues` and `chatJournal`.
- Chat/order deltas share the adapter's journal queue and transaction with separate bookkeeping: changed layers have no
  large-value throttle, unchanged layers reuse projections, removals use captured versions, and failed writes retry.
- Character removal journals the record delete and invents no per-chat deletes. Parked resends and unanswered in-flight
  groups stay until an authoritative outcome; re-add restores them, and an acknowledged parent deletion replaces old
  intent with creates for the re-added chats.
- `stopResourceSync` and restore halt detach the journal listeners and clear queued keys and timers.

### Split confirmation

- A [split batch's](resource-sync.md#batch-composition) prefix is a resend marked `unconfirmed` under the batch's id.
  `takeChatWork` withholds it until the journal confirms: the id must not reach the server as a prefix while its
  recoverable row still names the whole batch.
- `flushJournal` writes the whole chat projection, even unchanged, to obtain a per-item outcome. `written`, `skipped`
  and `ineligible` call `chatJournal.confirmSplit`; `stale` requeues it. Failures count per split (`splitFailures`); the
  second confirms anyway, and an off journal confirms immediately.
- A [`flushResources`](resource-sync.md#flushresources) obligation on a split waits at most 20 s for the journal;
  timeout rejects the flush without releasing the split.

### Conflict capture

- Before accepting the server copy after a failed merge, `captureRecordConflict` and `queueConflictDraft` capture
  discarded local edits for a recovery draft; the next journal flush persists it. Chat and order losses enter through
  `chatJournal.setConflictListener` and `captureChatConflict`. Those comments define which intent is abandoned; explicit
  `discardRefused` omits the chosen discard while capturing collateral losses.
- The adapter skips captures while off or halted; otherwise its next `flushJournal` writes drafts in the same
  transaction as removal of replaced layers. An ineligible or over-budget draft can be skipped while cleanup commits. A
  failed transaction keeps captures and record bookkeeping unadvanced; the restore snapshot reuses their stable ids.
- Committed captures refresh `recoveryDrafts`, allowing the reload notice to offer Review.

### Boot recovery

- `bootstrap.ts` `loadData` awaits `recoverJournal` as boot-load step 4: after `assembleChats`, `initializeRecords` and
  `applyFirstBootDefaults`, before the service-worker step, maintenance and `initializeChats`
  ([boot load](resource-sync.md#boot-load)). The recovery module header defines its deadline, classification order and
  replay/draft rules; record predicates live on `decideRecordRecovery`, chat/order predicates under
  [Chat recovery](#chat-recovery).
- Installation calls `writeCharacterFieldsAt` with validated own fields without import transforms, `replaceRecord` or
  `removeCharacters`: characters, other records and `characterOrder` precede chats/orders, then selection and language.
  Recovered whole-record intent wins over the first-boot overlay; an installed first chat needs no synthetic chat from
  `initializeChats`.
- A recovered character deletion keeps the adapter's delete-first path: if an earlier update wins the race, the delete
  conflicts, `adoptInDoubt` recognizes the update during the read, and the next cycle deletes on its revision.
- Replayed and satisfied rows hand their epoch and copied stored layers/versions to `adoptRecoveredRecord` or
  `adoptRecoveredChat`. Failed installations report `journalSkipped` `format` and retain the durable row for another
  boot. The adapter's first flush after sync starts atomically replaces/removes captured layers; a settled key with no
  chat projection clears them. A service-worker reload before sync can recover the same row again.

### Chat recovery

- `recoverJournal` uses `decideChatRecovery`, `decideChatOpsRecovery` and `decideOrderRecovery`, then calls
  `chatStore.svelte.ts` `installRecoveredChat` and `installRecoveredOrder`. Absent parents, refusals, malformed rows and
  uncertain work become drafts. Classifier comments hold the revision, before-value and membership rules.
- Resends preserve original ops/base/id for `retry: true`; dependent pending work is atomically drafted first. For rows
  handed back to saving, installation and adapter adoption precede reservation release in `draftJournal.ts`; failed
  installations retain their reservations. Committed whole-row moves to drafts and expiry cleanup also free
  reservations; partial moves keep remaining layers reserved. A whole chat/order move that yields no draft aborts
  recovery, and expiry purges reservations even when `readOwn` omits those rows.

### Recovery drafts

- `recoveryDrafts` mirrors durable `listDrafts`; its module header and `remove` comment define filtering, expiry and
  failed-delete behavior. `recoveryDraftDetails` names drafts and determines Apply availability; JSON export per draft
  or all (`exportDrafts`) keeps them durable.
- `ReloadNotice.svelte` shows a separately dismissible draft message even without a conflict notice. Review calls
  `recoveryDrafts.open` to open `RecoveryDrafts.svelte`, as does Settings → Advanced "Recovered changes"
  (`adv.recoveredChanges`, shown only while drafts exist). The dialog is owned by [UI and theming](ui-theming.md).

### Apply

- The dialog calls `applyRecoveryDraft`, which applies explicit intent through normal record/character/chat writers in a
  mutation scope. Its comment defines admission, expiry, layer priority and retry destination; `applyChatOps` defines
  skipped ops. A gone chat with a snapshot uses `chatStore.svelte.ts` `createChat` under the draft's id.
- `flushResources({ scope })` must save the affected keys without `discarded` or `refused` before
  `recoveryDrafts.remove` deletes the draft. A conflict retains it; a second Apply uses the revision the conflict reload
  installed.
- If deletion fails after a confirmed save, `appliedNotRemoved` says the changes were saved and the draft should be
  discarded. `recoveryDrafts.markApplied` disables Apply for the rest of the page; reload offers it again, though a
  second Apply repeats a record draft's write over later edits.

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
