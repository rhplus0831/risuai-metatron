# Durable Drafts Plan

Status: planned 2026-10-28; landed 1 (2a8ce1e83), 9 (62277946b), 2 (f5023bf8b), 3 (ca3e30b7b), 4
(8a1ea95e9), 5 (cfb27e86c), 6 (0814b3634), 8 (f5ef5033e), 7 (5d46c6e61), 10 (40b026930). The user
decided D2's base rule (retry in the same epoch), D3's retention (about two days) and D10's scope
(composer drafts stay in this browser) on 2026-10-28, and answered Q1–Q4 the same day (see
**Answered questions**; Q4's budgets were raised after Slice 3 measured them). A Sol review of the
first draft is folded in (see **Review record**).

Sources: findings F02, F03 and F04 of the
[server/client stabilization audit](../research/deep-audit/server-client-stabilization.md)
(at `c1a1d5d6c`), which the archived Deep Audit Fixes plan deferred here
(`git show ca5b656fa:docs/plan/deep-audit-fixes.md`, **Deferred**), and the 2026-10-28 discussion of
composer drafts. Code anchors were checked at `50d8d579a`; verify them again before editing
(STRUCTURE.md protocol step 5).

Owning guides: [persistence](../structure/persistence.md) (the save adapter, the chat module,
refusals, conflicts, boot), [chat-pipeline](../structure/chat-pipeline.md) (composer and send
drafts), [diagnostics](../structure/diagnostics.md) (new events),
[ui-theming](../structure/ui-theming.md) (the recovery dialog),
[app-shell](../structure/app-shell.md) (the boot order in `bootstrap.ts`).

## Goal

A change this tab made and the server has not acknowledged survives the loss of the page: a
killed Android PWA, a crashed tab, a reload during a server outage, a restore that halts the tab.
A conflict with another tab or device keeps this tab's version for the user instead of dropping
it with the reload notice. Outgoing saves no longer wait for reads of other records.

Not goals: syncing unsaved drafts between devices (D10); recovering the server's own data (its
SQLite journal and backups cover that); a server-side operation id for resource writes.

## Current state

All of this lives in module-level maps; a page reload drops it.

- **Resource records** (`src/ts/storage/resourceSync.svelte.ts`). `dirty` holds key → generation
  only; `collectOperations` builds each `PendingOp` (key, base revision, whole `text` or `null`
  for a delete, an optional patch) from the live mirror. Character creates and deletes are not
  dirty keys: they come from diffing the live character list against `persisted`. `inDoubt`
  (`:258-273`) holds the exact text and base of a write whose answer was lost, while a newer local
  text waits behind it (`heldBack`). `quarantinedRecords` holds refused text; `recordQuarantine`
  releases itself when the mirror stops matching that text. Writes carry no operation id; each is
  compare-and-set on `baseRevision` (`server/src/data/resourceStore.ts`), so an update resent on
  the same base lands at most once. A **create** is not protected the same way: one that landed,
  lost its answer, and was then deleted elsewhere is accepted again (its base is `null` and the
  record is absent).
- **Credentials.** `llmSecretState.queue` (`src/ts/storage/llmSecrets.svelte.ts`) holds plaintext
  until acknowledged. Plaintext also sits in ordinary records: the `secrets` section (auxiliary
  keys, `googleSearchCredentials`), `authRefreshes` (MCP refresh tokens and client secrets),
  `pluginStorage` and `plugins[].realArg` (arbitrary plugin values), `providers.additionalParams`
  and `customModels[].params` (`header::Authorization` lines, `server/src/llm/shared.ts`), and a
  character's `oaiTTSConfig.apiKey` (the only case the boot cache excludes,
  `src/ts/storage/bootCache.ts:104`).
- **Chat work** (`src/ts/storage/chatStore.svelte.ts`). `pending` holds unsent ops per chat with no
  base revision (a create is only a flag; its snapshot is projected at send time) and an optional
  `resend` (the exact earlier group: ops, base, `groupId`, `inDoubt`). `takeChatWork` takes the
  base from `chatRevisions`, which boot seeds from the newest summaries, and mints a fresh
  `groupId` per sent group. Orders keep an in-flight or recovering vector beside a newer queued one.
  `quarantined`/`quarantinedOrders` hold refused intent; `parkedResends` keeps resends across a
  character deletion until it is acknowledged. The server remembers the newest
  `MAX_CHAT_GROUP_IDS` (100) group ids per chat incarnation (`server/src/data/chatStore.ts:114`)
  and answers a remembered id with its earlier result, before any revision check; an aged-out retry
  gets `reason: "expired"`. A deleted chat remembers nothing. By-id ops (`setText`, `setMessage`,
  `patchMessage`, `meta`, single `remove`, `append`) apply on an older revision of the same
  incarnation, so a late replay overwrites a newer remote value of the same field; a missing target
  is acknowledged as `missing`, not a conflict.
- **Page close.** `unloadPendingChatWork` (`chatStore.svelte.ts:2093`) sends an eligible prefix of
  by-id ops over keepalive (60 KiB) under a fresh `groupId`, sent before it is tracked;
  everything else waits for a normal cycle. `beforeunload` warns while `hasUnsavedWork()`; a
  killed PWA never sees it.
- **Restore.** `haltForRestore` (`resourceSync.svelte.ts:1957`) halts scheduling, calls one
  synchronous hook already used for the import selection, shows the terminal notice and reloads.
- **Boot order** (`src/ts/bootstrap.ts:63-125`): `loadBootSnapshot` → `seedResources` /
  `seedChats` / `seedInlays` → `installBootRecords` → `applyFirstBootDefaults` → service worker →
  `maintainCharacters` → `initializeChats` (a character without a chat gets one) →
  `startResourceSync`.
- **Composer** (`src/ts/process/composerDrafts.svelte.ts`): `{ input, translate, files }` per chat
  key in a `Map` of the `DefaultChatScreen` instance (`files` are inlay ids); `at(key)` writes go to
  non-shown chats' stashes. A send records its user message id only in `sendDraft.ts`'s in-memory
  map, clears the composer, then awaits the job (`DefaultChatScreen.svelte:475-503`). The
  `chatKey` effect calls `switchTo` and then `takeUnplaced` (`:200-212`). A remount loses every
  draft.
- **Conflicts.** `mergeConcurrentChange` (`resourceSync.svelte.ts:2350`) merges `pluginStorage`,
  id-addressed item lists (additions only), `characters` with narrow exceptions, and `statics`;
  the five settings sections are whole-record; lorebook pages, plugins, hotkeys, `authRefreshes`
  and character-order folders are deliberately excluded from item merging (`:2476`). Local intent
  is dropped on several paths: `acceptRemote` (`:2040`), chat conflict replacement,
  `discardChatWork` for a gone chat (`chatStore.svelte.ts:4509`), collection recovery
  (`:5264`, `:5285`, `:5372`), locked-edit removal on a `generating` refusal (`:4428`), and
  `forgetCharacter` for a remote removal (`resourceSync.svelte.ts:3081`).
  `resourceSyncLive.test.ts:323` pins a local `ui.iconsize` edit dropped by a remote
  `ui.zoomsize` edit.
- **Save cycle** (`cycle`, `resourceSync.svelte.ts:1566`): awaits `reloadDeferredChats`,
  `hydrateCharacters`, `applyRemoteUpdates` and `refreshIdleChats` before `collectOperations`,
  behind one shared in-flight promise, and `refreshIdleChats` again after the batch. Reads
  (`readRefs`, `readKinds`, `listRevisions` in `resourceClient.ts`; `authFetch`) have no deadline.
  A record with local work deliberately skips its own remote refresh (`canApplyRemote`,
  `canRefreshChat`) and takes the 409 path.
- **IndexedDB and locks.** `bootCache.ts` (`risu-boot-cache`) opens a connection per operation
  with a 3 s bound and fences clears with a writer generation; it does **not** repair a database
  created without its stores (a load then fails and falls back to the server read every boot). Its
  tests use `fake-indexeddb`. Web Locks are used only by `pushNotifications.ts` (`risu-push`).
  `generationClientId()` (`src/ts/network/generationJobs.ts:180`) is a per-tab id in
  `sessionStorage`.

## Decisions

- **D1. One eligibility boundary.** A single pure function decides what may enter IndexedDB, and
  every path that writes the journal goes through it: pending, sent, refused, conflict capture,
  the restore snapshot, and recovery drafts. Never journaled: the `llmSecrets` queue and record,
  the `secrets` section, `authRefreshes`, `pluginStorage`, `plugins`, a character holding
  `oaiTTSConfig.apiKey`, and a `providers` or `customModels` record whose `additionalParams` or
  `params` hold a `header::` line. A record that fails the check is not journaled at all (no
  field stripping, so a recovered text never differs from what the tab would have sent); it is
  lost with the page as now, and the page-close warning still covers it. Known limit, documented
  in the persistence guide: a secret typed into free text (a prompt, a lore entry, a module script
  or URL) is journaled like any text, as the server already stores it. Assets are not journaled:
  an asset is written to the server before the record that names it.
- **D2. Same epoch: retry automatically, but only where a replay cannot do harm.** (The base rule
  is the user's decision.) Entries carry the epoch they were made under. At boot:
  - (a) A sent chat group is resent with its original `groupId` and `retry: true`.
  - (b) A resource update whose base equals the server's current revision is put back as this
    tab's change and saved by the normal cycle.
  - (c) A resource update whose base moved: if the server text equals the sent text, it landed
    (drop the entry); otherwise it becomes a recovery draft.
  - (d) A create that was never dispatched is created. A create that was dispatched and whose
    target is now absent becomes a draft: it may have landed and been deleted elsewhere, and the
    server has no tombstone to tell.
  - (e) A recovered by-id chat op outside (a) carries the target's value before the edit. Recovery
    loads the chat and applies the op only when the target still holds that value; when it
    already holds the new value, it landed. Anything else (a changed value, a missing target) is
    a draft. Whole-chat ops (`create` of a dispatched chat, `replace`, `delete`, multi-id
    `remove`) apply only on an unchanged chat revision; otherwise they are drafts.
  - (f) An `expired` answer, or a parent character gone, makes the work a draft. A draft never
    gets a fresh `groupId` automatically.
  - (g) Entries of another epoch (a restore or import happened) are drafts with Export and
    Discard only.
- **D3. Retention and budgets.** (Two days is the user's decision.) An entry expires 48 hours after
  its `createdAt`, which survives every state change and ownership transfer. Budgets (the user's
  decision after Slice 3's measurement, Q4): at most 16 MiB of text per entry and 64 MiB in total.
  An entry over its limit is not written (a `sync` `journalSkipped` event). Eviction for space
  removes only expired entries and recovery drafts, oldest first, never a live owner's rows.
- **D4. Entry identity and versions.** Mutation entries are keyed by
  `<epoch>\0<tabId>\0<scope>\0<target>` (scope `record`, `chat`, `order`); recovery drafts by
  `draft\0<uuid>`; composer drafts by `composer\0<chatKey>` (browser-wide, D10). Each mutation
  entry has a per-tab monotonic `version`. An acknowledgement or discard removes an entry, or one
  layer of it, only inside an IndexedDB transaction that sees the version it captured, so a late
  delete never erases newer work and a late write never resurrects an acknowledged row.
- **D5. Layers.** One entry holds what the adapter holds at once:
  - record: `{ op: "create" | "update" | "delete", sent?: { baseRevision, text | null, dispatched:
true, inDoubt }, latest?: { baseRevision, text | null }, refused?: { text | null, reason } }`;
  - chat: `{ resend?: { ops, baseRevision, groupId, seq, inDoubt }, pending?: { ops (each with its
`before` value), baseRevision, groupId, createSnapshot?, delete? }, refused?: { ops, create,
delete, reason } }`;
  - order: `{ sent?: { baseRevision, ids }, latest?: { baseRevision, ids }, refused?: { ids, reason } }`.
    A local removal of a character or chat is a `delete` entry kept until the server's answer, with
    the parked resends it holds; only an authoritative outcome (acknowledged delete, remote deletion
    already captured as a draft) clears it.
- **D6. Ownership through Web Locks.** One protocol:
  - At start a tab takes its id from `sessionStorage` and requests `risu-journal-owner:<tabId>`
    with `ifAvailable`. Refused (a duplicated tab copied the id) → mint a new id and retry. The
    lock is held for the page's life, freeze included.
  - The tab's own entries from its previous page (same id, a reload) are its own: it recovers them.
  - Orphans: under the exclusive lock `risu-journal-recover`, for each other `tabId` in the
    journal, request that tab's owner lock with `ifAvailable`. Granted means that tab is gone:
    re-tag its entries to this tab in one transaction (keeping `createdAt`), then release the lock.
    Refused means it is alive (hidden or frozen included): leave its entries.
  - No Web Locks, or a missing or throwing `sessionStorage`: the journal is off and the app
    behaves as now. Web Locks need a secure context, which the app already requires.
  - Holding a lock for the page's life makes the page ineligible for Chrome's back/forward cache
    (Q3).
- **D7. Write timing and replay identity.**
  - A chat's pending batch gets its `groupId` when its first op is queued. Both the normal
    dispatch and the keepalive path send the batch under that id, and a new id is minted only once
    the batch is dispatched. So every journaled version of a batch names the id the server will
    remember: a slow or failed journal can lose ops, but a replay is never a fresh group.
  - The keepalive path sends a batch only whole: every op by id, at most 5,000 ops, within the
    keepalive budget. A part of a batch sent under its id would hide the unsent rest, so a batch
    with a replace, a multi-message remove or a chat delete is left to the next save and the
    journal (the user's decision after Slice 6, 2026-10-28).
  - Journal writes are coalesced into one transaction per save cycle (and one on page hide), over
    one connection kept open, and dispatch never waits for them. The exception is a create: its
    entry is marked dispatched before the request goes, with a 200 ms bound. Known limit: if that
    write does not land, a create that landed, lost its answer and was deleted elsewhere can come
    back once after a crash. A second exception (the user's decision after Slice 6, 2026-10-28):
    a batch split at the per-request op cap sends its front part, a parked resend under the
    batch's own id, only after the split is committed to the journal; with the journal off, the
    row skipped, or two failed writes, it is sent anyway.
  - A record is journaled again only when its dirty generation changed since its last journal
    write. Records over 256 KiB are journaled at most every 5 s, and on page hide.
- **D8. Recovery drafts and their actions.** Drafts (from D2, from D9, and from conflict capture in
  Slice 10) are listed in one dialog with the record or chat name and time. Export (a JSON file)
  and Discard always work. Apply over the current server copy depends on the kind:
  - record: writes the draft text on the current revision;
  - chat ops: queues them as new by-id ops on the current chat and lists skipped missing targets;
  - a chat gone from the server: with a snapshot, creates it as a new chat with a new id; ops only:
    Export only;
  - order: applies the vector and drops ids that no longer exist;
  - another epoch: no Apply.
    The reload notice links to the dialog while it holds drafts.
- **D9. A restore or import halts with a snapshot.** `haltForRestore` awaits (bounded, 1 s) one
  journal transaction that captures the tab's live intent under the old epoch, beside the existing
  selection hook, which stays as it is. A cycle that completes after the halt does not touch the
  journal. The reload happens even if the journal fails.
- **D10. Composer drafts stay in this browser.** (The user's decision.) Keyed by chat key; shown
  and stashed chats (`at(key)` writes) are both written, 500 ms debounced and on page hide.
  - Send hand-off: at send the entry becomes `{ state: "sending", input, translate, files,
userMessageId }` and is deleted when the send settles with the message landed. At a reload a
    `sending` entry is deleted if the chat holds `userMessageId`; otherwise its text goes back into
    the composer. A send never restarts on its own.
  - Restore order in the `chatKey` effect: `switchTo`, then `takeUnplaced`, then the journal read.
    The read is applied only if the same chat is still shown and the composer is still empty and
    unchanged since the read began.
  - Deleted on a send's success, on an emptied composer, on a local `deleteChat`, and on a remote
    chat or character removal. Inlay ids whose inlay is gone are dropped at restore. Two tabs on one
    chat: the later write wins; a live composer is never replaced.
- **D11. Merge where the schema says fields are independent.** Each settings section and
  collection gets an explicit table (Slice 11):
  - **Settings sections:** merge per field, except coupled groups, which merge as one unit
    (`additionalParams` + `applyAdditionalParamsToAll`, `autoContinueChat` +
    `autoContinueMinTokens`, and the rest found by the slice). `llmSecrets` keeps its sibling-only
    contract.
  - **Id-addressed collections:** merge per item. An edit of an item the other side did not touch
    is kept; edit against delete is a conflict; add against add needs equal values; if both sides
    reordered, it is a conflict; a one-sided reorder is applied with the other side's additions
    appended.
  - **`{ items, selectedId }` collections:** items merge as above; the remote `selectedId` wins
    unless only this tab changed it and the item still exists.
  - **Collections without ids** (lorebook pages, plugins, hotkeys, `authRefreshes`, order folders)
    stay whole-record.
  - **Characters:** follow a coupling table.
    A remaining conflict keeps the local version as a draft (Slice 10) and accepts the remote
    record, as now.
- **D12. A write never waits for a read of another record.**
  - **Reads:** they run in a background refresh queue with an abortable 20 s deadline and backoff.
  - **A record with its own parked remote notice:** it keeps today's path (it is sent, takes the
    409, and recovers, now keeping the draft).
  - **What a cycle settles:** only the generations it sent.
  - **What a flush waits for:** `flushResources` resolves when the writes it captured have
    settled. Background read failures do not count against its ten attempts.
  - **Diagnostics:** a write that waited over 2 s records a `sync` `saveWait` event with the
    reason.

## Answered questions

The user answered these on 2026-10-28, each with the recommended option:

- **Q1. Where the recovery dialog opens:** from the reload notice, and from a "Recovered changes"
  row in Settings → Advanced that shows only while drafts exist.
- **Q2. Modules:** journaled (a URL with a token is the free-text limit of D1). `plugins` and
  `pluginStorage` stay excluded (D1).
- **Q3. The back/forward cache:** the page gives it up in Chrome for its life-long owner lock;
  releasing the lock on freeze (with a fence for a resumed page) is not built. Slice 12 verifies
  the outcome.
- **Q4. Budgets:** started with 4 MiB / 32 MiB and D7's 256 KiB / 5 s. Slice 3 measured a
  lorebook character under a 4× CPU throttle: a 5 MiB character was over the 4 MiB entry budget
  and never journaled, and an entry holding both `sent` and `latest` lost layers above about
  2 MiB; with a raised budget a 5 MiB write took about 100 ms (p95 123 ms) and added about 0.9 s of
  main-thread time over 36 s of typing, with unchanged input latency. On 2026-10-28 the user raised
  the budgets to 16 MiB per entry and 64 MiB in total and kept 256 KiB / 5 s.

## Slices

Each slice lands alone with the gates in **Verification**. Dependencies are noted on each slice.

### Slice 1: journal store, ownership, eligibility (needs nothing)

Files: new `src/ts/storage/draftJournal.ts` and `src/ts/storage/journalEligibility.ts` with tests;
`shared/diagnostics.ts` and the report projection (`journalSkipped`, `journalFailed`,
`journalRecovered` sync phases).

- Database `risu-draft-journal`, stores `entries` and `meta`, one connection per page. A database
  missing a store is upgraded to the next version with the missing stores created and existing
  rows kept. Rows of an unknown format are kept and reported, never deleted: they may be the only
  copy.
- D4 keys and versions, D5 payload types, D3 expiry and budgets, D6 ownership protocol (owner lock,
  duplicate-tab id, orphan transfer under the recover lock), and conditional removal.
- The D1 eligibility function, pure, with sentinel-credential tests for every excluded kind and
  field.
- No adapter wiring. Tests: `fake-indexeddb` round trips; an injected clock; a fake lock manager
  covering two live owners, sequential recoverers, the original owner reloading while another tab
  recovers, a duplicated tab id, and a dead owner's rows transferred once; a missing store; a
  stuck open; a late delete after a newer version.

### Slice 2: saves stop waiting for other reads (F04; needs nothing, lands before 3)

Files: `src/ts/storage/resourceSync.svelte.ts` (`cycle`, `runCycle`, the read stages,
`flushResources`), `src/ts/storage/resourceClient.ts`, `src/ts/storage/serverAuth.ts` (signal
pass-through), `shared/diagnostics.ts` (`saveWait`).

- D12. The background refresh queue, per-key dependencies (a key whose own refresh is pending and
  that has no local work waits; a key with local work goes the 409 way), settlement of only sent
  generations, and the flush rule.
- Tests: a deferred read of chat A while chat B and a settings record are ready (both land
  first); a rejected read retries without blocking writes; a dirty noticed record and a dirty
  noticed chat complete through the 409 path, with a refusal and a failed read; a flush no
  longer waits on an idle refresh; the deadline aborts a stuck read (fake timers).
  `resourceSyncLive.test.ts:323` keeps its expectation.

### Slice 3: resource write side (needs 1, 2)

Files: `src/ts/storage/resourceSync.svelte.ts`, `src/ts/storage/draftJournal.ts`.

- Journal each collected op through the eligibility function, with D5 layers: `latest` at
  collection, `sent` at dispatch (a create marked dispatched before it goes, D7), and the `inDoubt`
  and `refused` changes. Membership creates and deletes are entries too. Removal is conditional on
  the captured version.
- D7 coalescing, generation dedupe, and the large-record throttle.
- Measure: journal transaction time and main-thread cost for a 5 MiB lorebook character edited
  repeatedly, under a 4× CPU throttle (Playwright with CDP), and record the numbers for Q4.
- Tests: A sent, B edited, A's answer lost and then received, each leaving the right layers; a
  revert behind an in-doubt write; a delete and a re-add; excluded kinds never written.

### Slice 4: boot recovery of records (needs 3)

Files: `src/ts/bootstrap.ts`, `src/ts/storage/resourceSync.svelte.ts`, a new
`src/ts/storage/journalRecovery.ts`, a drafts store (`src/ts/storage/recoveryDrafts.svelte.ts`).

- A recovery stage, awaited, after `installBootRecords` and `applyFirstBootDefaults` and before
  `maintainCharacters` and `initializeChats`. `seedResources` and the boot-cache commit keep the
  server's snapshot.
- D6 claiming, then D2 (b), (c), (d) and (g) for records. A recovered character create is staged
  with its chats (Slice 7 adds them to the same stage). A recovered character delete is applied
  before the order repair. Drafts go to the drafts store. Until Slice 5 the reload notice says
  that drafts exist, with Export.
- Tests through `bootstrap.ts` with a fake server and a fake journal: an unacknowledged settings
  edit and a character edit sent once; a lost answer that landed is recognized; a moved base
  becomes a draft; a dispatched create with an absent target becomes a draft; an undispatched
  create is created; another epoch only lists; a boot-cache hit and the fallback both work. The
  simulated reload tears down the module's listeners, timers and locks first (a test seam), not
  only `vi.resetModules()`.

### Slice 5: recovery dialog (needs 4)

Files: `src/lib/Others/RecoveryDrafts.svelte`, `src/lib/Others/ReloadNotice.svelte`, the Settings
row (Q1), `src/lang/en.ts` and `ko.ts`.

- D8 actions per kind, Export as JSON, Discard, and 48-hour expiry shown as a time left.
- Tests: each action per kind; Apply on a record that changed again meanwhile writes on the
  current revision; another epoch's draft has no Apply.

### Slice 6: chat identity and write side (needs 3)

Files: `src/ts/storage/chatStore.svelte.ts`, `src/ts/storage/resourceSync.svelte.ts` (the
unload path), `src/ts/storage/draftJournal.ts`.

- D7's `groupId` per pending batch, used by `takeChatWork` and `unloadPendingChatWork` alike;
  `before` values on by-id ops; D5 chat and order layers; refused intent; `delete` entries kept
  until the authoritative outcome, with parked resends.
- Tests: the keepalive group and a later normal dispatch of the same batch carry one id; a batch
  split in two keeps distinct ids for the two parts; a revert, an order behind an in-flight
  order, and a remove/re-add with reused chat ids leave the right layers.

### Slice 7: boot recovery of chat work (needs 4, 5, 6, 8)

Files: `src/ts/storage/journalRecovery.ts`, `src/ts/storage/chatStore.svelte.ts` (a recovery
queue that owns its base revision apart from `chatRevisions`), `src/ts/bootstrap.ts`,
`src/ts/storage/draftJournal.ts` and `src/ts/storage/resourceSync.svelte.ts` (the hand-over below;
the user's decision of 2026-10-28, after Slice 6 left the page's reserved rows with no release).

- Hand-over of the reserved rows: since Slice 6 the page reserves the chat and order rows it finds
  or adopts at start, and its own writes and removals skip them. The journal gets a release that
  frees reserved keys and returns their stored layers and versions, and the adapter gets an
  adoption for chat and order rows (like `adoptRecoveredRecord`) that fills its journal views, so
  a replayed or recovered chat is journaled again on this page and a settled row is removed.

- D2 (a), (d), (e) and (f) for chats and orders, in the Slice 4 stage, staged with recovered
  characters. `initializeChats` does not add a first chat to a character whose chats are being
  recovered. Chats are loaded only when (e) needs a target's current value. An absent chat or
  parent becomes a draft, never a dropped queue entry or an invented create.
- Tests: a remembered `groupId` answers its earlier result and the test asserts the id, ops, base
  and `retry` flag sent (an append alone would pass with a fresh id); a same-field remote edit, a
  stale `setMessage`, and a missing message each become drafts; replace, delete and multi-remove
  on a moved base become drafts; an expired group becomes a draft; a remote reorder between
  journaling and boot; an unloaded chat; a recovered character with its first chat (no second
  synthetic chat).

### Slice 8: the restore snapshot (needs 3, 6)

Files: `src/ts/storage/resourceSync.svelte.ts` (`haltForRestore`), `src/ts/storage/draftJournal.ts`.

- D9, with the late-cycle fence.
- Tests: a restore while a second tab has dirty and refused work and an in-flight save; the next
  boot lists the old entries as other-epoch drafts and replays none; a journal failure still
  reloads.

### Slice 9: composer drafts (needs 1)

Files: `src/ts/process/composerDrafts.svelte.ts`, `src/ts/process/sendDraft.ts`,
`src/lib/ChatScreens/DefaultChatScreen.svelte`, `src/ts/storage/chatStore.svelte.ts` (deletion
listeners), `src/ts/storage/draftJournal.ts`.

- D10, including the send hand-off and the restore order.
- Tests in `composerDrafts.test.ts` and `sendDraft.test.ts`: a new composer restores a shown and a
  stashed draft; a `sending` entry whose message landed is dropped and one whose message did not
  is restored without sending; a late read after a chat switch or typing is ignored; a remote
  deletion purges. The mounted `DefaultChatScreen` wiring (send, switch, hide, attachment) needs a
  mounted harness; this slice adds the smallest one that mounts the screen with stubbed stores,
  since this new wiring has no other coverage.

### Slice 10: keep the local version at every conflict (needs 5, 6)

Files: `src/ts/storage/resourceSync.svelte.ts`, `src/ts/storage/chatStore.svelte.ts`.

- Before each intent-dropping path in **Current state** (`acceptRemote`, chat conflict
  replacement, `discardChatWork`, collection recovery, locked-edit removal, remote
  `forgetCharacter`), the dropped work becomes a draft through the eligibility function. A refused
  record or order comes back with the content its quarantine compares against, so the release rule
  still works.
- `resourceSyncLive.test.ts:323` also expects a draft holding `iconsize`. One test per path, and
  a draft surviving the cleanup that follows.

### Slice 11: field-level and item-level merge (needs 10)

Files: `src/ts/storage/resourceSync.svelte.ts` (`mergeConcurrentChange` and helpers), the merge
tables beside it, `shared/sections.ts` (read only).

- D11 with the tables written out per section and collection.
- `resourceSyncLive.test.ts:323` changes: the `zoomsize`/`iconsize` case merges with no notice,
  and its draft assertion moves to a new same-field case. Tests: an opposing flag and its
  configuration edited on two tabs (a coupled group conflicts); delete against edit; reorder
  against insertion; a removed selected item.

### Slice 12: docs close and browser drive (needs all)

- Guides: persistence (Flows, State, Known Hazards including D1's free-text limit and D7's create
  limit), chat-pipeline (composer), diagnostics (events), ui-theming (dialog), app-shell (boot
  stage).
- A Playwright driver under `util/playwright/` on a persistent profile (`launchPersistentContext`
  with a fixed user data dir). It holds `/api/resources/batch` at three cut points: before the
  server commits, after the commit with the answer dropped, and with the journal transaction held.
  It then kills the browser process without lifecycle events and relaunches on the same profile.
  Cases: a settings field, a character field, a message edit, a reorder, a delete, a composer draft,
  a recovery of a recovery, and an other-epoch export after a restore. A graceful close (which runs
  the hide and keepalive paths) is a separate case. The driver also checks the back/forward cache
  outcome (Q3).
- Device checks (an Android PWA killed from the task switcher, iOS Home Screen, Safari) go to the
  user as a checklist.

## Recommended order

1 → 2 → 3 → 4 → 5 → 6 → 8 → 7 → 10 → 11, with 9 any time after 1, and 12 last. Slices 2, 3, 6 and
10 touch the same dispatch and acknowledgement code: run them one at a time, not in parallel
worktrees.

## Verification

- Per slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the affected `slow` and `e2e` sets), V6
  (each new regression test shown failing once), V4 (`rg` each changed export), V8/V9 for the new
  tests, prettier on changed files.
- Journal tests use `fake-indexeddb`, an injected clock, and a fake lock manager; no test waits on
  a real timer (V3). A simulated reload tears down listeners, timers and locks (Slice 4's seam).
- A new diagnostics phase updates `shared/diagnostics.ts`, the report projection, and their tests
  in the slice that first emits it.
- Replay tests assert what was sent (id, ops, base, `retry`), not only the final chat.
- The Slice 12 driver runs in CI-like conditions here; device checks are reported as not run until
  the user runs them (V5).

## Out of scope

- Draft sync between devices (D10).
- A server-side create tombstone or operation id (D2 (d) and D7 cover creates on the client; the
  remaining crash window is a documented limit).
- Journaling credentials in any form (D1).
- Changing the server's 100-group memory.

## Review record

The Sol review of the first draft (2026-10-28) raised 20 points; all were taken. The cheaper
choices:

- Resurrected creates (point 3): handled on the client with D2 (d) and D7 instead of a server
  tombstone, leaving one documented crash window.
- Overwriting newer fields with stale by-id ops (point 11): handled by the `before` values
  checked at recovery (D2 (e)) instead of server-side preconditions.
- Durable-before-send for chat groups (point 4): replaced by pre-minted batch ids (D7), so
  dispatch never waits on IndexedDB except for creates.
- Releasing locks on freeze (point 15): left as Q3, where the user accepted the loss of the
  back/forward cache.
