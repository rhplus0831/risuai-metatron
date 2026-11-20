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
  [global API](global-api.md#terminal-and-reload-notices).
- `src/lib/Others/RecoveryDrafts.svelte`: review dialog; `recoveryDraftDetails`, `applyRecoveryDraft`. Owned by
  [UI and theming](ui-theming.md).
- `src/ts/process/composerDrafts.svelte.ts`: composer timing and journal-row lifecycle; `createComposer`,
  `onChatRemoved`. Owned by [chat pipeline](chat-pipeline.md#composer-and-drafts).

## Flows

### Journal store

- `createDraftJournal` and `DraftJournal` own the store contract: keys, layers, version fences, reservations, budgets,
  expiry, owner locks, and transaction failure behavior. Read the module header and the `checkJournalRow` comment in
  `src/ts/storage/draftJournal.ts`; `pageDraftJournal` owns the page's shared instance.

### Eligibility

- `journalEligibility.ts` `isJournalEligible` owns the admission boundary used by journal writes and recovery;
  `bootCache.ts` `holdsCredential` shares the character-credential rule. Read the module header before widening it.
- Free text in prompts, lore, module scripts or URLs, and messages is journaled like other content, as the server
  already stores it. Decision: Durable Drafts D1, Q2, archive.

### Composer API

- `composerDrafts.svelte.ts` uses the shared page journal's composer API; its source comments own row lifecycle and
  timing. The editable draft and a send hand-off remain separate browser-wide rows. Read `checkComposerValue` and the
  composer method comments for compatibility and atomic swaps; composer timing and guarded restore are in
  [chat pipeline](chat-pipeline.md#composer-and-drafts).
- A nonempty draft box or a `sent: "draft"` marker selects composer format 2. The marker is tied to `userMessageId`.
  Other composer rows and mutation/draft rows use format 1. An older reader preserves unfamiliar rows. A draft-send
  hand-off can restore both boxes, the translation and attachments.
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
- On [restore halt](live-updates.md#restore-halt), `captureRestoreJournal` synchronously captures the record, chat and
  order views plus pending conflict drafts before any write settles. `writeRestoreJournal` persists the snapshot under
  its old epochs outside the normal queue. Late answers and lifecycle handlers cannot replace it. The next boot drafts
  surviving old-epoch rows. The halt bounds the journal wait before reload.

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
- The adapter's `flushJournal` hands the per-item outcome to `chatJournal.confirmSplit` or requeues the write. A stale
  outcome retries. Skipped, ineligible, or repeatedly failed writes permit dispatch as described in
  [Limitations](#limitations). A [flush](resource-sync.md#flushresources) can time out while waiting for confirmation
  without releasing the prefix.

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

- `loadData` awaits `recoverJournal` after first-boot defaults and before maintenance and `initializeChats`. Recovery
  classifies rows against the server baseline. It installs recovered character fields through `writeCharacterFieldsAt`
  and other records through normal writers before installing chats/orders, then reconciles selection and language. This
  preserves recovered first chats and avoids running import transforms again. See
  [boot load](resource-sync.md#boot-load).
- A recovered character deletion keeps the adapter's delete-first path: if an earlier update wins the race, the delete
  conflicts, `adoptInDoubt` recognizes the update during the read, and the next cycle deletes on its revision.
- Replayed and satisfied rows hand their epoch and copied stored layers/versions to `adoptRecoveredRecord` or
  `adoptRecoveredChat`. Failed installations report `journalSkipped` `format` and retain the durable row for another
  boot. The adapter's first flush after sync starts atomically replaces/removes captured layers; a settled key with no
  chat projection clears them. A service-worker reload before sync can recover the same row again.

### Chat recovery

- `recoverJournal` classifies with `decideChatRecovery` and `decideOrderRecovery`, then installs admitted work through
  `installRecoveredChat` and `installRecoveredOrder`. Rows with missing parents, malformed data, or refusals become
  drafts.
- `decideChatOpsRecovery` checks final values for landed by-id work. Matching before-values permit replay only on the
  revision the classifier received. For pending by-id work, `recoverJournal` currently pairs the boot summary revision
  with the later whole-chat body. A change between those reads can go undetected.
- Resends preserve original ops/base/id for `retry: true`; dependent pending work is atomically drafted first. For rows
  handed back to saving, installation and adapter adoption precede reservation release in `draftJournal.ts`; failed
  installations retain their reservations. Committed whole-row moves to drafts and expiry cleanup also free
  reservations; partial moves keep remaining layers reserved. A whole chat/order move that yields no draft aborts
  recovery, and expiry purges reservations even when `readOwn` omits those rows.
- Before replay, `replayedHypaV3Data` identifies real summary values a Structured Memory projection could supersede.
  `keepRecoveryMemory` files each distinct value as a memory-only draft. If filing fails, the row becomes a draft whole.
  The scratch walk accounts for mode changes inside the group and in recovered settings, preserving the original ops,
  base revision and retry id. See the [projection rules](structured-memory/projection.md#the-hypav3-projection).

### Recovery drafts

- `recoveryDrafts` mirrors durable `listDrafts`; its module header and `remove` comment define filtering, expiry and
  failed-delete behavior. `recoveryDraftDetails` names drafts and determines Apply availability; JSON export per draft
  or all (`exportDrafts`) keeps them durable.
- `ReloadNotice.svelte` shows a separately dismissible draft message even without a conflict notice. Review calls
  `recoveryDrafts.open` to open `RecoveryDrafts.svelte`, as does Settings → Advanced "Recovered changes"
  (`adv.recoveredChanges`, shown only while drafts exist). The dialog is owned by [UI and theming](ui-theming.md).

### Apply

- The dialog calls `applyRecoveryDraft`, which applies explicit intent through normal writers in a mutation scope. Its
  comment defines admission, expiry, layer priority and retry destination; `applyChatOps` returns the skipped report
  strings and, for content that did not land (a missing or refused message edit or translation, an append whose rows
  were not inserted, a refused non-memory `meta` set), the narrowed ops. A gone chat with a snapshot uses `createChat`
  under the draft's id.
- A real `hypaV3Data` that Structured Memory refuses (`setChatMeta`'s recovery source) is filed as a draft of its own
  before the flush, or a memory-only draft is kept; the dialog says which.
- A non-delete character edit past the boot's three-day trash threshold becomes a draft instead of replaying. Explicit
  Apply skips it and keeps the draft, reporting the character in its skipped result.
- `flushResources({ scope })` must save the affected keys without `discarded` or `refused` before the source draft is
  removed. Skipped content is first filed as an ops-only draft (the source's `createdAt` and epoch, the applied chat's
  ref, no snapshot), and the result's `kept` makes the dialog say so (`recoveryDrafts.skippedKept`); by-design skips
  (control and whole-chat ops, removes of absent ids, appends already present) are report-only. A conflict retains the
  source; a second Apply uses the revision the conflict reload installed.
- If filing the skipped content or deleting the source fails after a confirmed save, the source stays and
  `appliedNotRemoved` says the changes were saved and the draft should be discarded. `recoveryDrafts.markApplied`
  disables Apply for the rest of the page; reload offers it again, though a second Apply repeats a record draft's write
  over later edits.

## State

- `draftJournal` keeps a page-local version counter, removal fences, and reservations. The adapter's `journalRecords`,
  `journalChatViews`, and pending-key sets are described under [Journal writes](#journal-writes); the chat module's
  `journalChats`, `journalOrders`, `createSnapshots`, and `beforeValues` under [Chat journal](#chat-journal).
- `conflictDrafts` holds detached captures with stable ids until [their commit](#conflict-capture).
- `recoveryDrafts` is the reactive view, tagging rows from another epoch as `otherEpoch`. Notice dismissal is page-local
  and independent of conflict dismissal. Discard and confirmed Apply remove rows from both.

## Coupling

- `startResourceSync` connects the chat module (`chatJournal.setListener`, `setConflictListener`).
- The adapter alone writes mutation rows; `journalRecovery.ts` moves and releases them.
- `composerDrafts.svelte.ts` owns durable composer text. Open message and stored-translation editors live only in tab
  memory and survive a component remount. See the [chat store](chat-store.md#files).
- A remote send ([network jobs](network-jobs.md#remote-send)) ends with the local send's shapes, so a hand-off row's
  restore and its retained request id follow the same rules; the relay command id is that request id.
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

- Changing a composer payload requires checking the old and new row formats in `checkComposerValue`, draft and hand-off
  writes in `createDraftJournal`, and restoration in `createComposer`.
- For a new record kind, decide its [journal eligibility](#eligibility) and check its [boot recovery](#boot-recovery)
  alongside the [persistence recipe](persistence.md#recipes).

## Tests

- Focused:
  `pnpm --silent test:agent draftJournal journalEligibility journalRecovery resourceSyncJournal RecoveryDrafts`. No
  `slow`; `e2e`: `e2e/multiClient.spec.ts`, an edit of a chat another tab deleted becomes a draft.
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
- Not tested: pending writes across a back/forward cache return (`runBfcache` only reports what Chrome did).

## Known Hazards

### Limitations

- A missing-chat Apply creates its chat under the draft's id for a retry to find; a destination that another tab deleted
  after the create landed is created again by an Apply retried after a reload (the server keeps no tombstone). Decision:
  DD3,
  [durable drafts audit](../reports/audits/finished-plans/durable-drafts-2026-10-29.md#dd3--retrying-a-missing-chat-apply-creates-another-copy).
- After two failed split-journal writes (or with the journal off or the row skipped), the prefix can dispatch without a
  durable split record. Oversized pending batches become drafts instead of replaying a prefix; see
  [Split confirmation](#split-confirmation). Decision: Durable Drafts D7, archive.
- Quarantined chat intent stays local: eligible, in-budget refusals are journaled and become recovery drafts on the next
  boot, while server backups omit it. A file backup and a compatible export name the refused items (`backupRefusedNote`,
  `src/ts/drive/backuplocal.ts`); a snapshot taken from Storage settings flushes first and names them the same way. See
  [Chat journal](#chat-journal) and [Boot recovery](#boot-recovery). Decision: Durable Drafts D5, D8, archive.
- A stale Retry or edit of a loaded whole-chat replacement takes
  [normal conflict recovery](resource-sync.md#chat-and-order-conflicts); eligible abandoned work is captured as a draft
  ([Conflict capture](#conflict-capture)). Decision: as above.
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
  ([observation](../reports/measurements/client/durable-drafts-observations-2026-10-29.md)), so the hide flush protects
  only a page that stays alive hidden, such as a backgrounded PWA killed later. Crash and kill protection is per-cycle
  writes and the 500 ms journal timer; there is no `localStorage` fallback. Decision: the archive's Durable Drafts
  entry.
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
- The conservative `sent`/`resend` marks of a cycle can outlive an early exit, leaving a dispatched mark for a later
  batch that never went: harmless for an update, but recovery treats such a create as a draft rather than creating it.
  Decision: owner, 2026-11-10 (known-issues review): the conservative draft is preferred.
- A metadata before captured from an unloaded summary may differ from raw storage (for example, omitted `pinned:false`),
  so recovery may conservatively draft it. Decision: owner, 2026-11-10 (known-issues review): the conservative draft is
  preferred.
- A composer draft typed during a send with that send's text carries its message id (`retryIdFor`). The page's own
  settlement keeps it as a plain draft, but a reload before that settlement cannot tell it from the send's text put back
  after a failure: `composerDrafts.svelte.ts` `restore` finds the message landed and deletes the draft, so the retyped
  text is lost. Keeping it would bring sent text back after every uncertain landed end
  ([JR1](../reports/audits/finished-plans/cross-plan-2026-10-29.md#jr1--a-landed-send-deletes-an-identical-drafts-journal-row)).
  Decision: owner, 2026-11-10.

### Gotchas

- A back/forward cache return with the owner lock held is possible
  ([observed](../reports/measurements/client/durable-drafts-observations-2026-10-29.md) in one headless configuration,
  no guarantee for headed Chrome or an installed PWA): do not assume the lock keeps the page out of the cache.
- Recovery compares adapter-produced compact JSON with `sameJson`, which ignores object key order only for equal-length
  texts; arbitrary pretty-printed equivalents are not recognized.
