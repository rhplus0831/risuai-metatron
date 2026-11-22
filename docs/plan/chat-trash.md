# Chat Trash Plan

Status: drafted 2026-11-22 at `efba3bf17` from the owner's answers of 2026-11-22 (Q1 to Q11). Audited before its run
at `2417475d6` ([report](../reports/audits/plan-runner/chat-trash-2026-11-22.md)), revised at `34cb89820` (the mark in
a column, its own route, read-only trashed chats, Q12), and re-audited at `4c52e82e0` (the report's second section,
B1 to B8). Revised again the same day at `06690eead` to the owner's triage of B1 to B8 and the changed Q4: B1, B2's
memory part, B3, B4, B7, and B8 are fixed in the decisions and slices; B5's draft loss, B6's stale reorder, and the
translation commit after a restore are Limitations; plugins no longer trash the chats they omit. Re-audited at
`8cab9a528` (the report's third section, C1 to C10), revised at `854da1a15` to those findings with C1 accepted as "an
omitted chat is kept" (D15b), and confirmed over the changed sentences only (the report's last section): seven
corrections confirmed; C5's replay sentence and C8's fixture corrected after it; the plugin part of C1 and the new N1
kept as Limitations. No P1 is open. By the owner's decision of 2026-11-22 there is no fourth full audit: what the
audits describe as races is settled in the slices, by the tests they list. Landed: 1 (`4b8e45126`).

Sources: `server/src/data/chatStore.ts` (`CHAT_TABLES_SQL`, `CHAT_TABLE_COLUMNS`, the open-time column checks,
`summaryFields`, `chatSummary`, `SUMMARY_PROJECTION_VERSION`, the feed's chat change, the op validation and replay
order, `walkChatSnapshot`, the staging writer and `copyStagedChats`, the search queries, `deleteCharacter`),
`server/src/data/resourceStore.ts` (`applyChanges`, the invalidation hook, `assertSnapshotHeader`, `replaceAll`, the
search scope resolution), `server/src/data/upstream/exportStage.ts`, `server/src/data/memoryStore.ts`,
`server/src/app.ts` (`chatHeld`, the Structured Memory `fenced` predicate, `startBackgroundTasks`, `beginShutdown`),
`server/src/routes/structuredMemory.ts`, `server/src/routes/memoryTasks.ts`, `server/src/routes/translate.ts`,
`server/src/jobs/generationJobs.ts` (`create`), `server/src/routes/chatCheckpoints.ts`,
`server/src/data/checkpointService.ts`, `server/src/routes/messageSearch.ts`, `server/src/routes/backups.ts`,
`server/src/data/upstream/exportDatabase.ts`, `shared/chats.ts` (`ChatSummary`, `ChatRecord`, `CHAT_SUMMARY_FORMAT`),
`shared/resources.ts` (`parseRevisionToken`, `ResourceConflict`), `shared/sections.ts`,
`server/src/data/normalize/ui.ts`, `src/ts/checkpoints/chatCheckpoints.svelte.ts` (`prepare`, `request`,
`loadCheckpoint`), `src/ts/storage/chatStore.svelte.ts` (`deleteChat`, `removeChat`, `removeRemoteChat`,
`notifyRemoval`, `metaOf`, `noteRemoteChat`, `applyRemoteSummary`, `chatList`, `chatEntry`, `selectedChatId`,
`selectChat`, `syncSelection`, `reorderChats`, `reconcileCharacterChats`, `installCharacterChats`, `createChat`),
`src/ts/storage/chatEdits.ts` (`readChatsDetached`), `src/ts/storage/resourceSync.svelte.ts`,
`src/lib/SideBars/SideChatList.svelte`, `src/lib/Others/ChatList.svelte`, `src/lib/Others/ChatCheckpointsDialog.svelte`,
`src/lib/SideBars/pinnedChats.ts`, `src/ts/plugins/apiV3/v3.svelte.ts`, `src/ts/storage/snapshots.svelte.ts`,
`src/ts/characters.ts`, and `src/ts/setting/storageSettingsData.ts`, read at `06690eead`; the
[chat store](../structure/chat-store.md), [resource sync](../structure/resource-sync.md),
[server resources](../structure/server-resources.md), [UI and theming](../structure/ui-theming.md#sidebar) and
[settings](../structure/settings-i18n.md) guides; the audits' findings, whose `file:line` references this revision
follows. Identifiers are the anchors; re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

Deleting a chat moves it to its character's trash, where it stays, untouched and whole, until the user restores it,
deletes it forever, or the retention the user chose passes.

- **Every chat deletion the user makes goes to the trash**: the sidebar and the chat list dialog. Only the trash
  view's "delete forever" and "empty trash", the server's purge, and deleting the character remove a chat for good.
  Plugins cannot delete or trash a chat (Q4).
- **A trashed chat is out of normal use and cannot be changed**: it is not listed, selected, opened, sent to,
  searched, pinned, edited, or worked on in the background, and restoring it gives back everything it had (messages,
  settings, folder, pin, memory records and a paused rebuild, checkpoints).
- **The server decides expiry by its own clock**, from a retention the user sets (Q1: 30 days by default).
- **The trash UI is in the desktop sidebar chat list** (Q2, Q6), per character, with Windows-style confirmations (Q3).

Not goals: a global trash across characters (Q2); a separate mobile layout (Q6); changing the character trash or its
three-day boot purge (filed in the durable data loss audit); a trash for messages, folders, modules, or presets.

## Current State

- `deleteChat` (`chatStore.svelte.ts`) refuses a character's last chat and a chat being generated in, removes the chat
  from the held list (`removeChat`), calls `notifyRemoval` (which clears the chat's composer and editor drafts), and
  queues `{ op: "delete" }` on the per-chat save queue. The sidebar's two chat delete handlers (`SideChatList.svelte`)
  and the chat list dialog (`ChatList.svelte`) ask `alertConfirm(removeConfirm + name)` first. The plugin reconcile
  (`reconcileCharacterChats`) deletes the chats a plugin's list omits, and same-id character recreation
  (`installCharacterChats`) queues a delete for each known chat missing from the replacement. Plugin v3 has no other
  chat delete.
- The server applies `delete` as the group's only op at the current revision, refuses it while a foreign job owns a
  message of the chat, deletes the `chats` row, and removes the id from `chatOrders`. Messages, summaries, Structured
  Memory rows (a rebuild's row included), checkpoints, and checkpoint policy cascade by foreign key, and the
  invalidation hook cancels the chat's memory tasks. A whole-chat `replace` is what marks a surviving rebuild
  `sourceReplaced` (no longer resumable). Other tabs learn of a deletion through the generic `change` frame.
- A generation job occupies its chat slot at admission and owns messages only from its `begin`; `chatHeld`
  (`server/src/app.ts`) checks both. The Structured Memory routes write through `store.memory` in their own
  transactions behind a `fenced` predicate (tasks, jobs, rebuilds); rebuild abandonment checks only `chatHeld`.
  `POST /api/translate/message` runs outside `jobs.create` and commits a `setTranslation` op after its model call.
- Chat metadata is one JSON `meta` column, normalized as a whole on every write. A revision token is
  `<epoch>:<seq>:<revision>`, where `seq` names the chat's incarnation; a whole read is a `ChatRecord` whose `data` is
  the `Chat`. The tab holds each member as a loaded `Chat` or a summary and derives a loaded member's list entry from
  the `Chat` (`metaOf`); `noteRemoteChat` returns after a loaded patch without reading its summary, and
  `applyRemoteSummary` ignores loaded members and equal revisions.
- Columns are added to an existing database at open after a `PRAGMA table_xinfo` check (the
  `memory_state.adoptionDeclined` precedent); `CHAT_TABLES_SQL` runs only on a fresh database. Restore and the upstream
  export first check a source file's chat columns against `CHAT_TABLE_COLUMNS.chats` exactly
  (`assertSnapshotHeader`); an optional memory column already has a layout-dependent select.
- `loadCheckpoint` (`chatCheckpoints.svelte.ts`) is a whole-chat server action off the save queue: its private
  `prepare` refuses a generating or refused chat, awaits a global `flushResources`, checks the report for the target
  chat or order, and checks again; its private `request` carries the epoch header; after the answer it re-reads the
  chat, and it tells a request never sent from one whose answer was lost.
- `chatList`, `chatEntry`, `chatCount`, and `memberIds` read raw membership, which also backs selection and routes,
  plugin indexes and pages, journal recovery, snapshots, binding counts, and order writes. `selectedChatId` falls back
  to the first raw member. The server checks an order write's revision and that it is a permutation.
- The server does not require a character to keep a chat; the one-chat rule is the tab's. Lua has no whole-chat delete
  (`removeChat` and `cutChat` in `server/src/lua/bindings.ts` remove messages).
- The character trash stamps and expires `trashTime` by the browser clock, which the durable data loss audit found can
  purge a fresh trash. Its catalog view (`GridCatalog.svelte`) restores and deletes forever (asking twice).
- The server reads settings records (`app.ts` reads `providers`) and starts timers in `startBackgroundTasks`; the asset
  lifecycle tick there reads `chats.meta` and `messages.data` for asset roots, but no timer deletes chat rows.

## Decisions

Written to the owner's answers, Q1 to Q12, and to the owner's triage of the second audit.

### The mark

- **D1. The mark is a column.** `chats` gains `trashedAt INTEGER` (null: not trashed; milliseconds, server clock),
  in `CHAT_TABLES_SQL` and `CHAT_TABLE_COLUMNS.chats` and, for existing databases, added at open after a
  `PRAGMA table_xinfo` check. It is not in `meta`: ordinary chat writes (`meta`, `replace`, `create`, checkpoint load,
  settings copies) preserve it, a `trashedAt` key a plugin stored in `meta` is ordinary custom metadata that nothing
  reads as the mark, and the `Chat` type and the `ChatMeta` maps do not change. Trash and restore (D4) set and clear
  it, the native install (D10) restamps it, and permanent deletion and the purge remove the row.
- **D2. Every read that tells a tab about a chat carries the mark.** `ChatSummary` gains `trashedAt?: number`, built
  from the column wherever a summary is built (`chatSummary`, the per-character listing, boot, the staging writer);
  `ChatRecord` gains `trashedAt: number | null` beside `data`; and every feed chat entry that is not a deletion
  carries `trashedAt: number | null` as a field of the entry itself, beside `revision` (`ChangeSet.chats`). It is not
  one of the optional payloads: the publication budget never drops it, and the entry coalesced for a chat recorded
  twice (`coalescedChat`), the revision listing a reconnect reconciles from, and the tab's feed adapter keep it. A
  trash or restore offers its summary as any metadata change does, within the budget; the mark does not depend on
  the summary, a body, or a manifest. `SUMMARY_PROJECTION_VERSION` and `CHAT_SUMMARY_FORMAT` advance.
- **D3. The tab holds the mark per member, apart from the transcript.** Each held member, loaded or not, has a trash
  state `{ trashedAt, revision }` that survives load, eviction, and the busy-load overlay. Any delivery (summary, whole
  read, feed change, D4's answers) installs it when its revision is equal to or newer than the held state's, so an
  answer that loses the race to an echo or a read still lands and an older one never does. A notice that names a
  newer revision without the field (a reconnect's cursor replay names only the id and the revision) leaves the state unknown, and the tab reads the chat's
  entry back. Detached reads by ref and by character (`readChatRefsDetached`, `readChatsDetached`) keep `trashedAt`
  with each record. The mark is never read from `Chat` or `meta`.

### The route

- **D4. Trash, restore, and permanent deletion are a route, not chat ops.** `POST /api/chat-trash/{trash,restore,
delete}` with `{ characterId, chatId, revision }`, where `revision` is the token the tab held when the user acted, and
  the epoch header. The route applies a server-internal change through `applyChanges` (revision, order, summary,
  commit, publication, invalidation) with the epoch it was given, so these never enter the save queue, the draft
  journal, or boot recovery, and `ChatOp` does not change. A token naming another incarnation is `409` `stale`. Each
  answers `200` with the chat's identity (its new revision token, or the deleted one), `trashedAt`, and its summary;
  `trash` of a trashed chat and `restore` of an active one are `200` no-ops with the current state.
  - `trash`: refused with `409` `generating` while `chatHeld` is true (slot or message), and `409` `lastActiveChat`
    when no other chat of the character has a null `trashedAt` (Q12), both inside the transaction. Stamps the server's
    clock and runs D8's cancellation.
  - `restore`: never refused for a lock; clears the column.
  - `delete`: requires the exact current revision and a non-null `trashedAt` (`409` `notTrashed` or `stale`
    otherwise) and refuses `generating` while `chatHeld`; deletes as today's `delete` does.
- **D5. The save queue's `delete` is refused.** The batch route answers every `{ op: "delete" }` group, whatever the
  chat's state, with a chat conflict (`409`, reason `useTrash`, with the chat's revision), so a tab of an earlier
  build or any remaining producer re-reads and keeps the chat. For a chat that still exists, a group it remembers is
  answered from its receipt before this refusal and before D6's, and an expired retry keeps its existing answer. A
  delete that committed before the upgrade left no receipt (the row and its receipts went together): its retry is
  answered as a chat that is gone, and the tab settles it as today, by the read that finds the chat absent; when a
  chat was created under the same id meanwhile, the retry names another incarnation, is refused, and that chat stays.
  Character deletion (`deleteCharacter`), restore, and import are not chat ops and are unchanged (Q5).
- **D6. A trashed chat is read-only on the server.** Every chat group addressed to a trashed chat is refused as a chat
  conflict (`409`, reason `chatTrashed`, with its revision), the translation commit included, and so are the
  checkpoint mutations (save, load, rename, delete, policy), each checking the mark in its synchronous write step;
  checkpoint listing still works. The tab answers `useTrash` and `chatTrashed` on the normal conflict path (re-read,
  recovery draft, notice), never through missing-anchor repair.

### Work a trashed chat stops

- **D7. No new jobs.** Generation admission (`jobs.create`, after request-id replay) refuses a trashed chat with `409`
  and `error: "chatTrashed"`; the manual memory task route refuses it at admission; the translation runner refuses
  it at its common entry (`translate` in `server/src/translation/runner.ts`), before it joins a run or starts one,
  so the call it makes again after a run in flight settles is checked too; `autoSave` skips it before its policy
  write.
- **D8. Trash cancels without replacing the source, and memory writes stop.** The trash change cancels the chat's
  queued and running memory tasks (it advances the task generation and reaches the existing listener) without calling
  `noteSourceReplaced`, so a paused Structured Memory rebuild stays resumable after a restore. The Structured Memory
  `fenced` predicate (`server/src/app.ts`) is true for a trashed chat, so its mutation routes (records, pages, events,
  threads, chapters, clear) refuse it, and rebuild abandonment checks the mark as well; D8's own cancellation is not
  fenced.
- **D9. Search.** The message search (`server/src/routes/messageSearch.ts`) leaves trashed chats out of every scope it
  takes (one chat, one character, all characters), on the first page and when a cursor resumes.

### Retention and storage

- **D10. Backups and exports** (Q10, Q11). Snapshots and version-2 archives copy the column with the file.
  `assertSnapshotHeader` accepts the two exact source layouts (with and without `trashedAt`); `walkChatSnapshot` selects
  the column or `NULL AS trashedAt` by the matched layout and validates it; staged output must have the current layout;
  `copyStagedChats` copies it. Inside `replaceAll`, before commit, every non-null `trashedAt` is set to one install time
  and those chats' summaries are rebuilt, and a character that has chats, all of them trashed, has its most recently
  trashed chat restored, so an old snapshot never hands the purge an expired chat or leaves a character with only
  trashed chats (one with no chat at all is boot's, D14). The upstream export filters trashed chats out of the ordered ids before it derives `chatPage`; "export all
  chats" and dataset export filter the detached records by their `trashedAt` before stripping the envelopes.
- **D11. The purge.** `chatTrashDays` in the `ui` section (`shared/database.ts` `Database`, `SECTION_FIELDS.ui`,
  `normalize/ui.ts`), default `30`, an integer from 1 to 3650 (Q7), shown as a leaf in a rendered section of the
  Storage settings page with a note that lowering it can delete trashed chats at the next purge, and left out of the
  upstream export as a Metatron-only setting. A purge timer started once by `startBackgroundTasks` runs a minute after
  start and then hourly, is skipped during maintenance, stops at `beginShutdown`, and is drained before the store
  closes. Each run reads `chatTrashDays` from the `ui` record and, per candidate, carries the scan's epoch, revision
  token, and `trashedAt` into one top-level change whose transaction re-checks all three, the cutoff, and `chatHeld`,
  then deletes as D4's `delete` does. A refused candidate waits for the next run.

### Tab

- **D12. The tab's client.** The checkpoint client's private `prepare` and `request` move to a shared module both use.
  A trash client exposes `trashChat`, `restoreChat`, and `deleteChatForever`; each takes the chat's ref and the
  revision token its caller captured when the user pressed the control, before any confirmation is shown, runs
  `prepare`, and sends that token; none looks the token up after an await. A chat that has no token yet (its create is
  not acknowledged) is not sent: the caller says it is still saving. None is optimistic. A `200` installs the answer's
  trash state and summary (D3). A `409` re-reads the entry and shows a notice (`lastActiveChat` keeps
  `errors.onlyOneChat`, `generating` keeps `chatGenerating`, `stale` and `notTrashed` say the chat changed). A request
  never sent shows a notice; one sent whose answer is lost or malformed re-reads the entry and reports that the outcome
  is unknown. `trashChat` leaves membership, drafts, and composers alone. A permanent deletion is settled in the tab
  once, for the incarnation that was deleted, whichever of `deleteChatForever`'s `200` and the deletion's feed entry
  arrives first, and never for a chat created under the same id afterwards. It goes through `removeRemoteChat` (the
  remote deletion path: held revision, locks, order, selection, `notifyRemoval`); in that function's branch for a
  character's only held member, which marks the id absent and keeps the member and its revision, the tab also
  requests the character's chat collection, whose list replaces the member. Today's `deleteChat` has no caller left
  and is removed.
- **D13. Active view.** `chatList`, `chatEntry`, `memberIds`, and the structural readers (recovery, snapshots, binding
  counts) keep reading every member. `activeChatList`, `trashedChatList`, and `activeChatCount` give the visible split
  from D3's state, and the listed readers move to them: the sidebar list, `ChatList.svelte`, `pinnedChats.ts` (so the
  rail and home cards agree), `chatStatus.svelte.ts`'s pin status keys, `mainMenuProjection.ts` and
  `MobileCharacters.svelte` (recent activity and counts), the branches dialog (`src/ts/gui/branches.ts`), and the
  copy-name helper in `globalApi.svelte.ts`. Folder deletion clears `folderId` on active chats only (a restored chat
  whose folder is gone lists at the root, by `chatFolderOf`). A drag reorder of active rows is merged into the raw order
  with every trashed chat kept in its slot. With D6 on the server, a reader missed shows a trashed chat or gets a
  conflict; none changes one.
- **D14. Selection.** `selectedChatId` falls back to the first active chat, and `selectChat` treats a trashed chat as
  missing; the router, `changeChatTo`, and pinned actions check the target is active before they open it. Whenever D3
  installs a changed mark, the tab notes whether that chat was open, runs `syncSelection`, and an open chat screen whose
  chat was trashed elsewhere closes with a notice. D4's `lastActiveChat` and D10's install repair keep an active chat
  in every character that has chats; a character with no chat at all stays valid on the server, and boot's
  `ensureChat` creates its first one, as today.
- **D15. Plugins** (Q4, Q9). Plugin v3 reads (`getChats` and its total, `getChatFromIndex`, the current chat and hook
  indexes, `getDatabase` full and summary through `snapshots.svelte.ts`, character copies, the job channel's copies)
  list and index active chats, with an active-membership version, advanced by every mark change, for paged reads
  across awaits; a copy built from a detached read leaves out a chat whose record carries the mark, checked when the
  copy is returned or cached. Index writes and `reconcileCharacterChats` re-check the captured chat id at application
  and ignore a trashed one. A chat the plugin's list omits is left as it is: the reconcile neither deletes nor
  trashes it, and its order write merges the plugin's order with every omitted or trashed chat kept in its slot. An
  incoming chat whose id is not a member is created, as today (Limitations). `risuai.d.ts` and `plugins.md`
  say an omitted chat is kept and that plugins cannot delete chats.
- **D15b. Same-id character recreation never deletes a chat** (Q4, Q5; the owner's answer to C1).
  `installCharacterChats` queues no chat deletes. The known chats the replacement omits end one of two ways, and the
  tab follows the server in both. When the character's own deletion is acknowledged, its cascade has removed them, as
  today. When the server still holds the character (the removal and the re-add reached the save loop as one update of
  the same id, or the character's deletion failed), they are kept: they stay stored under the character with their
  marks, the tab takes them back as members from the character's chat collection, and the order it writes is the
  replacement's chats followed by them, so the order stays a permutation of what the server holds. An omitted chat
  whose create this tab never sent is not stored anywhere and is dropped, as today (Limitations).
- **D16. The checkpoint dialog** closes, with a notice, when its chat is trashed, and its load and delete re-check the
  chat is active at dispatch (D6 refuses them anyway).

### Sidebar UI

- **D17. The trash view in `SideChatList`.** The bottom toolbar gains a trash button with the trashed count (no badge
  at zero). Pressing it swaps the scrolling list for the trash view and hides New Chat; the search field stays and
  filters trash rows by name. The view has a back button and the title "Trash (n)", the line "Chats in the trash are
  deleted forever after N days" from `chatTrashDays`, and one row per trashed chat, newest first: the name, the folder
  it was in (when that folder still exists), the time it was trashed, the days left, and Restore and Delete forever
  buttons. Rows do not open the chat. An "Empty trash" button ends the view and is disabled when it is empty; it
  freezes the listed chats, their tokens, and their count when it is pressed, names that count in its confirmation,
  calls `deleteChatForever` for each frozen target, and reports any it could not delete (a chat restored or trashed
  again meanwhile is `stale` and stays). Every handler captures its target and token before its confirmation (D12).
  Confirmations, Windows style (Q3, Q8), each one `alertConfirm`; Restore asks nothing:
  - Delete in the list: "Move "{name}" to the trash?" (replaces `removeConfirm` for chats; the folder delete keeps its
    own text).
  - Delete forever: "Delete "{name}" forever? This cannot be undone."
  - Empty trash: "Delete the {n} chats in the trash forever? This cannot be undone."

  Strings go to `src/lang/en.ts` with Korean overrides in `src/lang/ko.ts`.

### Questions the owner answered

- **Q1. Retention.** 30 days by default, set by the user (owner, 2026-11-22).
- **Q2. Scope.** Per character in this work (owner, 2026-11-22). Alternative: a global trash page.
- **Q3. Confirmation.** Kept (owner, 2026-11-22): chats are closer to memories than characters are, so the delete
  keeps a confirmation, Windows style, against a proposal to drop it for an undo toast.
- **Q4. Plugin and Lua deletions.** First answered "to the trash" (owner, 2026-11-22); changed the same day after the
  second audit (B6): a chat a plugin's list omits is kept, so plugins cannot delete chats. Lua has no whole-chat delete.
- **Q5. A trashed character's chats.** Follow the character, unchanged (owner, 2026-11-22).
- **Q6. Surfaces.** The desktop sidebar only (owner, 2026-11-22). There is no separate mobile chat list; the shared
  components change as D13 says.
- **Q7. The retention range.** Answered as proposed (owner, 2026-11-22): whole days from 1 to 3650, no "never".
- **Q8. Confirmations for a permanent delete.** Answered as proposed (owner, 2026-11-22): one, as Windows asks.
- **Q9. Plugins.** Answered as proposed (owner, 2026-11-22): plugins see active chats only (D15).
- **Q10. Exports.** Answered as proposed (owner, 2026-11-22): native snapshots and backups keep trashed chats; "export
  all chats", dataset export, and the upstream export leave them out (D10).
- **Q11. Restored snapshots.** Answered as proposed (owner, 2026-11-22): a restore or import resets `trashedAt` to the
  restore time (D10).
- **Q12. No active chat left.** Blocked cheaply (owner, 2026-11-22): the server refuses a trash that would leave no
  active chat (D4, `lastActiveChat`).
- **Triage of the second audit** (owner, 2026-11-22): fix B1, B2's memory part, B3, B4, B7, and B8, and B5's two small
  ordering rules; keep B5's draft loss, B6's stale reorder, and the translation commit after a restore as Limitations.
- **The third audit** (owner, 2026-11-22): C1 is accepted as "an omitted chat is kept" (D15b); C2 to C10 are
  corrected in the sentences they quote, and the races they describe are listed as tests in the slices. After the
  confirmation turn: the plugin part of C1 and N1 are Limitations, a cursor replay without the mark is left to D3's
  readback (C5), and the lazy-loading fixture keeps its case another way (C8).

## Limitations

- A tab of an earlier build left open after the upgrade does not know the mark: it keeps listing a chat another tab
  trashed, and its edits and deletes of that chat are refused and re-read (D5, D6) until it reloads. A refused
  delete keeps the chat as the server last committed it: that build's delete had already replaced the chat's queued
  work, so message and metadata edits it had not saved yet are discarded with the chat's drafts, and a journaled
  delete replayed by boot recovery after the upgrade clears the drafts the same way; the chat itself comes back.
  Decision: owner, 2026-11-22 (B5: a chat the user meant to delete; restated after C2 to name the unsaved edits).
- A drag or plugin reorder built before another tab trashed a chat can still be a valid permutation, so the trashed
  chat's slot, and the place it is restored to, can move. Decision: owner, 2026-11-22 (B6; fencing order writes on
  active membership is a server change for a cosmetic effect).
- A translation started before the chat was trashed and finishing after it was restored commits to the restored chat,
  which is the same chat; one that finishes while it is trashed is refused (D6) and its model call is wasted.
  Decision: owner, 2026-11-22 (B2).
- A plugin that writes back a chat list it read earlier creates again, as an active chat, a chat that was deleted
  forever or purged in between, as it does today for a deleted chat: the host does not keep which ids each plugin
  read. A chat still in the trash is not affected (D15). Decision: owner, 2026-11-22 (the plugin part of C1; keeping
  the ids each plugin read is tens of lines for a rare write).
- Same-id character recreation keeps the omitted chats the server holds (D15b); an omitted chat whose create this tab
  had not sent yet is discarded with its unsaved content, as today. Decision: owner, 2026-11-22 (N1; it needs the
  recreation inside the save delay of a new chat).

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guides the slice names, with `pnpm docs:read`.
- Server tests drive the store through its existing test fixtures against a real SQLite store; tab tests use the chat
  store's existing setup (`src/ts/storage/tests/chatStore.test.ts`, the shared mock
  `src/ts/storage/tests/chatStoreMock.ts`) and mount `SideChatList` as `src/lib/SideBars/SideChatList.test.ts` does.
- Each slice runs its own focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`; the last
  code slice runs the whole suite and the browser specs the change reaches.
- No change to the character trash, to message removal, or to Lua.

## Slices

Order: 1, 2, 3, 4, 5, 6, one after another. Slices 1, 2, and 3 share `server/src/app.ts`; slices 1 and 2 share
`server/src/data/chatStore.ts`, `server/src/data/resourceStore.ts`, and `server/src/data/checkpointService.ts`; slices 1
and 3 share `server/src/data/upstream/exportDatabase.ts`; slices 1 and 4 share `src/ts/network/jobChannel.ts` and
client test fixtures that build a `ChatRecord`; slices 3, 4, and 5 edit `src/lang/en.ts` and `src/lang/ko.ts`;
slices 4 and 5 share `src/lib/SideBars/SideChatList.svelte` and its test.

### 1. The mark, the route, read-only chats, and restore on the server (_hard_)

- `server/src/data/chatStore.ts`: the column in `CHAT_TABLES_SQL`, `CHAT_TABLE_COLUMNS`, and the open-time check; the
  summary field and `SUMMARY_PROJECTION_VERSION`; `trashedAt` on whole reads and on every feed chat entry, outside
  the budgeted payloads and kept by `coalescedChat` in `server/src/data/resourceStore.ts` and by the revision listing
  (D1, D2); the server-internal trash, restore, and permanent-delete
  changes with the incarnation check; the replay order and the `useTrash` and `chatTrashed` refusals (D4 to D6);
  `walkChatSnapshot`, the staging writer, and `copyStagedChats` (D10).
- `server/src/data/resourceStore.ts`: the internal changes through `applyChanges` (D4); `assertSnapshotHeader`'s two
  layouts and the install stamp, summary rebuild, and active-chat repair in `replaceAll` (D10);
  `server/src/data/upstream/exportStage.ts`: the source check; `server/src/data/upstream/exportDatabase.ts`: trashed
  chats filtered before `chatPage` (D10); `server/src/routes/backups.ts` where the install is reached.
- A new route module `server/src/routes/chatTrash.ts`, registered in `server/src/app.ts` with its shutdown tracking
  and maintenance admission, with the `chatHeld` and `lastActiveChat` admissions (D4);
  `server/src/data/checkpointService.ts`: the checkpoint mutations refused for a trashed chat (D6).
- `shared/chats.ts`: `ChatSummary.trashedAt`, `ChatRecord.trashedAt`, `CHAT_SUMMARY_FORMAT`, the new reasons on
  `ChatConflict`, the route's request and answer types; `shared/resources.ts`: `trashedAt` on the `ChangeSet.chats`
  entry. The required `ChatRecord.trashedAt` is adapted where the type check asks for it:
  `src/ts/network/jobChannel.ts`, `src/ts/storage/tests/installFlatDatabase.ts`, and the client test fixtures that
  build a `ChatRecord`.
- Existing fixtures that need a real chat deletion move to the route or keep a deliberate legacy-delete case that now
  asserts `useTrash`: `server/src/tests/chatStore.test.ts`, `server/src/tests/memoryStore.test.ts`,
  `server/src/tests/chatSourceGeneration.test.ts`, `chatSummaries.test.ts`, `chatResult.test.ts`,
  `chatMetadataCoalescing.test.ts`, `commandExecutor.test.ts`, `commandSequences.test.ts`,
  `jobMetadataScope.test.ts`, `memoryTasks.test.ts`, and `messageSearch.test.ts` beside them, the batch, feed, and
  checkpoint tests, `src/ts/storage/tests/chatLazyLoading.test.ts` (its missing-only-chat case cannot use the route, which refuses a
  last active chat, and keeps the case by deleting and recreating the character on the server with an empty chat
  order after the tab has booted), and the
  browser scripts that send a raw delete (`util/playwright/checkLiveUpdates.mjs`,
  `e2e/multiClientGeneration.spec.ts`); `server/src/tests/restoreWorker.test.ts` inserts chat rows by position and
  gains the column.
- Tests (`server/src/tests/chatStore.test.ts`, a new route test, the snapshot, restore-stage, backup, and upstream
  export tests): an existing database gains the column at open; a `meta` write of `trashedAt` and a whole `replace`
  leave the column alone; trash stamps the server clock and restore clears it, both idempotent; trash is refused while
  a job holds the slot before `begin` and while it owns a message, and for the last active chat; a token of another
  incarnation is `stale`; `delete` needs the exact revision and a mark, and deletes with the cascade; a queued `delete`
  group is a `useTrash` conflict carrying the revision; an edit the chat remembers, retried after a trash, gets its
  remembered answer, and an expired retry keeps its answer; a retried delete whose chat is gone is answered as gone,
  and with a chat recreated under the id it is refused and that chat stays; a group to a trashed chat (a message
  edit, `setTranslation`) and a checkpoint load or delete are refused; the summary, a whole read, and a loaded chat's
  feed entry carry the mark, also when the publication budget drops the summary and when the chat is recorded twice
  in one publication; a snapshot with and without the column restores, with the
  install time on trashed chats and a character whose chats were all trashed getting one back; the upstream export
  omits a trashed chat and keeps `chatPage` on the right chat.

### 2. What a trashed chat stops (_small_)

Depends on 1.

- `server/src/jobs/generationJobs.ts`: the `chatTrashed` admission refusal after request-id replay (D7).
- `server/src/routes/memoryTasks.ts`: the admission refusal; `server/src/translation/runner.ts`: the refusal at
  `translate`'s entry, and `server/src/routes/translate.ts` where its answer is mapped (D7).
- `server/src/app.ts` (the `fenced` predicate), `server/src/routes/structuredMemory.ts` (rebuild abandonment),
  `server/src/prompt/memory/memoryTasks.ts`, `server/src/data/resourceStore.ts` (the invalidation hook),
  `server/src/data/memoryStore.ts`: the memory write refusals and the cancellation without `noteSourceReplaced` (D8).
- `server/src/data/checkpointService.ts`: `autoSave` skips a trashed chat (D7).
- `server/src/routes/messageSearch.ts`, the scope resolution in `server/src/data/resourceStore.ts`, and the chat search
  queries in `server/src/data/chatStore.ts`: trashed chats left out of the chat, character, and global scopes and of
  cursor resumption (D9).
- Tests (the generation-job, memory-task, structured-memory route, translate, checkpoint, and message-search tests): a
  job, a manual memory task, and a translation for a trashed chat are refused, and so is the translation a caller
  with a newer text starts when the run it waited for settles after the trash; a running memory task is cancelled; a
  paused rebuild, trashed and restored, still resumes, and cannot be abandoned while trashed; a chapter delete and a
  clear from a stale panel are refused; no automatic checkpoint is captured; a trashed chat is absent from search hits
  in each scope, a direct chat-scope request included, and a continuation returns nothing more from a chat trashed
  between pages.

### 3. The retention setting and the purge (_small_)

Depends on 2.

- `shared/database.ts`, `shared/sections.ts`, `server/src/data/normalize/ui.ts`: `Database.chatTrashDays`, its `ui`
  section entry, and its normalization (D11).
- A purge module under `server/src/data/`, started, stopped, and drained in `server/src/app.ts` (D11).
- `src/ts/setting/storageSettingsData.ts` (the leaf and its place in a rendered Storage section), `src/lang/en.ts`,
  `src/lang/ko.ts`: the settings item (D11); `server/src/data/upstream/exportDatabase.ts`: `chatTrashDays` classified as
  Metatron-only.
- Tests (`server/src/tests/normalizeSections.test.ts` with `src/ts/storage/tests/fixtures/boot/boot-snapshot.json`, a
  purge test): normalization (missing, wrong kind, out of range, fractional); a purge with a controlled clock deletes
  only chats past the setting, re-reads the setting each run, skips a chat restored, re-trashed, or held between the
  scan and the delete, publishes the deletion, does not run during maintenance, and stops at shutdown.

### 4. The tab's client, store, readers, and plugins (_hard_)

Depends on 3.

- `src/ts/checkpoints/chatCheckpoints.svelte.ts` and a new shared module: `prepare` and `request` extracted; a trash
  client module beside it (D12).
- `src/ts/storage/chatStore.svelte.ts`: the per-member trash state and its installs from summaries, whole reads, feed
  changes, and answers (D3); `activeChatList`, `trashedChatList`, `activeChatCount`; the selection rules; the order
  merge; the removal of `deleteChat`; `reconcileCharacterChats` and `installCharacterChats` (D12 to D15b);
  `src/ts/storage/characterStore.svelte.ts` where same-id recreation installs the chats (D15b).
- `src/ts/storage/resourceSync.svelte.ts`: `useTrash` and `chatTrashed` on the normal conflict path, outside
  missing-anchor repair (D6), and the feed adapter and reconnect listing pass each entry's `trashedAt` on (D2, D3);
  `src/ts/storage/chatEdits.ts`: `readChatsDetached` and `readChatRefsDetached` keep `trashedAt` with each record
  (D3, D10).
- The readers D13 lists, `src/ts/router/router.svelte.ts`, `src/ts/globalApi.svelte.ts`, `src/lib/ChatScreens/`
  (closing a chat trashed elsewhere), `src/ts/characters.ts` and `src/ts/storage/exportAsDataset.ts` (D10, D13, D14).
- `src/ts/plugins/apiV3/v3.svelte.ts`, `src/ts/network/jobChannel.ts`, `src/ts/storage/snapshots.svelte.ts`,
  `src/ts/plugins/apiV3/risuai.d.ts` (D15); `src/lib/Others/ChatCheckpointsDialog.svelte` (D16).
- `src/lib/Others/ChatList.svelte` and the two chat delete handlers and folder deletion of
  `src/lib/SideBars/SideChatList.svelte`: `trashChat` with the move-to-trash confirmation, and the active-only folder
  cleanup and order merge (D13, D17); the move-to-trash, notice, and remote-close strings in `src/lang/en.ts` and
  `src/lang/ko.ts`.
- Callers of the removed `deleteChat` and the fixtures that assume a permanent removal: `e2e/multiClient.ts`,
  `util/playwright/checkDurableDrafts.mjs`, `src/lib/Others/LoreBudgetStopDialog.test.ts`,
  `src/ts/storage/tests/resourceSyncJournal.test.ts`, `src/ts/storage/tests/chatStoreMock.ts`, and `rg "deleteChat"`
  for any other.
- Tests (`src/ts/storage/tests/chatStore.test.ts`, a new trash client test, `src/lib/SideBars/pinnedChats.test.ts`,
  `src/ts/plugins/apiV3/hostApiChats.test.ts`, `src/lib/SideBars/SideChatList.test.ts`, and the readers' existing
  tests): trash flushes first and installs the answer whether the answer or the feed echo comes first, for a loaded and
  an unloaded chat, after a bare ref's readback, and across eviction and reload; a legacy `meta.trashedAt` is not a
  mark; a `409` re-reads and shows the notice, and a lost answer re-reads; the member and its drafts stay; a trashed
  selection moves to the first active chat, also from a remote change; the router and `selectChat` refuse a trashed
  chat; pinned and recent projections skip it; a drag reorder and a plugin order keep trashed and omitted chats in
  their slots; folder deletion leaves a trashed chat's `folderId`; restore brings it back with its folder and pin;
  `deleteChatForever` sends the token it was given and settles the deletion once for that incarnation, with the
  answer first and with the feed entry first, and leaves a chat recreated under the id; when the deleted chat was the
  only held member the collection is requested; a chat with no token yet is not sent; a mark arrives from a feed
  entry with no summary and from a reconnect listing, and a cursor replay that names only a newer revision reads the
  entry back; a plugin's omitted chat stays, a stale write to a trashed id is
  ignored, its indexes and pages skip trashed chats (a cold page read while a trash is in flight included); same-id recreation queues no chat delete, keeps the
  omitted chats as members after the replacement's when the character survived as an update, and writes an order the
  server accepts; the checkpoint dialog closes when its chat is trashed; the move to trash asks once.

### 5. The sidebar trash view (_small_)

Depends on 4.

- `src/lib/SideBars/SideChatList.svelte`: the toolbar button, the trash view, and the delete-forever and empty-trash
  confirmations (D17).
- `src/lang/en.ts`, `src/lang/ko.ts`: the trash view's strings.
- Tests (`src/lib/SideBars/SideChatList.test.ts`): the count shows and hides; the view swaps in and out; restore calls
  the store at once; delete forever and empty trash each call it only after one Yes; empty trash reports a chat it
  could not delete; a chat restored and trashed again while a delete-forever or empty-trash confirmation is open is
  not deleted, and Empty trash deletes only the chats it listed when pressed; the filter narrows trash rows; a trash
  row does not open the chat.

### 6. Guides and close-out (_small_)

Depends on 5.

- The [chat store](../structure/chat-store.md), [resource sync](../structure/resource-sync.md),
  [UI and theming](../structure/ui-theming.md#sidebar), [settings](../structure/settings-i18n.md),
  [plugin sandbox](../structure/plugin-sandbox.md), and [server resources](../structure/server-resources.md) guides
  describe the column, the route, read-only trashed chats, the purge, the active view, and the trash view, with the
  Limitations above as guide Limitations; `plugins.md` says an omitted chat is kept and plugins cannot delete chats;
  the plan is retired by `docs/plan/README.md` and `docs/archived-plan/README.md`, and unrun manual checks go to
  `docs/backlog/manual-checks.md`.

## Manual Checks

- Desktop browser: trash the open chat, see it leave the list and the pinned rail, find it in the trash view with its
  folder and days left, restore it, and see its messages, folder, pin, and memory panel as before.
- Two tabs on the same character: trash the chat open in the other tab; that tab leaves the chat with the notice.
  Restore it from the first tab; it reappears in the second. Trash the last two active chats one in each tab; the
  second is refused.
- Set the retention to 1 day, move the purge's clock past it, and see the chat leave the trash within the hour; a chat
  restored in the meantime stays.
- Restore a snapshot taken before this change and one taken with a trashed chat; both restore, and the trashed chat is
  still in the trash with its days reset.
