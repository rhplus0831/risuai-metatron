# Chat Trash Plan

Status: drafted 2026-11-22 at `efba3bf17` from the owner's answers of 2026-11-22 on a chat trash in the desktop
sidebar (Q1 to Q6); the owner answered Q7 to Q11 as proposed the same day. Audited before its run at `2417475d6`
([report](../reports/audits/plan-runner/chat-trash-2026-11-22.md)): six P1 findings (A1 to A6) and A8 left it needing
a revision. Revised the same day at `34cb89820` to the owner's go-ahead on the proposed fixes and Q12: the mark moved
to a column, trash, restore, and permanent deletion moved off the save queue onto their own route, trashed chats became
read-only on the server, and the slices were re-cut. Not yet re-audited.

Sources: `server/src/data/chatStore.ts` (`CHAT_TABLES_SQL`, the open-time column checks, `summaryFields`,
`chatSummary`, `SUMMARY_PROJECTION_VERSION`, the op validation and apply branches, the staging writer and
`copyStagedChats`, the search queries, `deleteCharacter`), `server/src/data/resourceStore.ts` (`applyChanges`, the
invalidation hook, `replaceAll`, the search scope resolution), `server/src/app.ts` (`chatHeld`,
`startBackgroundTasks`, `beginShutdown`), `server/src/jobs/generationJobs.ts` (`create`),
`server/src/prompt/memory/memoryTasks.ts`, `server/src/data/memoryStore.ts` (`noteSourceReplaced`),
`server/src/routes/memoryTasks.ts`, `server/src/routes/chatCheckpoints.ts`, `server/src/data/checkpointService.ts`
(`autoSave`), `server/src/translation/runner.ts`, `server/src/routes/messageSearch.ts`, `server/src/routes/backups.ts`
(`restoreValidated`), `server/src/data/upstream/exportDatabase.ts`, `shared/chats.ts` (`ChatOp`, `ChatSummary`,
`CHAT_SUMMARY_FORMAT`), `shared/sections.ts`, `server/src/data/normalize/ui.ts`,
`src/ts/checkpoints/chatCheckpoints.svelte.ts` (the `prepare` and `request` pattern this plan reuses),
`src/ts/storage/chatStore.svelte.ts` (`deleteChat`, `removeChat`, `notifyRemoval`, `metaOf`, `chatList`, `chatEntry`,
`selectedChatId`, `selectChat`, `syncSelection`, `reorderChats`, `reconcileCharacterChats`, `installCharacterChats`),
`src/ts/storage/resourceSync.svelte.ts` (`flushResources`), `src/lib/SideBars/SideChatList.svelte`,
`src/lib/Others/ChatList.svelte`, `src/lib/Others/ChatCheckpointsDialog.svelte`, `src/lib/SideBars/pinnedChats.ts`,
`src/ts/plugins/apiV3/v3.svelte.ts`, `src/ts/storage/snapshots.svelte.ts`, `src/ts/characters.ts`, and
`src/ts/setting/storageSettingsData.ts`, read at `34cb89820`; the [chat store](../structure/chat-store.md),
[resource sync](../structure/resource-sync.md), [server resources](../structure/server-resources.md),
[UI and theming](../structure/ui-theming.md#sidebar) and [settings](../structure/settings-i18n.md) guides; the first
audit's findings, whose `file:line` references this revision follows. Identifiers are the anchors; re-verify each
cited location before editing (STRUCTURE.md protocol step 5).

## Goal

Deleting a chat moves it to its character's trash, where it stays, untouched and whole, until the user restores it,
deletes it forever, or the retention the user chose passes.

- **Every chat deletion goes to the trash** (Q4): the sidebar, the chat list dialog, and plugins. Only the trash view's
  "delete forever" and "empty trash", the server's purge, and deleting the character remove a chat for good.
- **A trashed chat is out of normal use and cannot be changed**: it is not listed, selected, opened, sent to, searched,
  pinned, edited, or worked on in the background, and restoring it gives back everything it had (messages, settings,
  folder, pin, memory records and a paused rebuild, checkpoints).
- **The server decides expiry by its own clock**, from a retention the user sets (Q1: 30 days by default).
- **The trash UI is in the desktop sidebar chat list** (Q2, Q6), per character, with Windows-style confirmations (Q3).

Not goals: a global trash across characters (Q2); a separate mobile layout (Q6); changing the character trash or its
three-day boot purge (filed in the durable data loss audit); a trash for messages, folders, modules, or presets.

## Current State

- `deleteChat` (`chatStore.svelte.ts`) refuses a character's last chat and a chat being generated in, removes the chat
  from the held list (`removeChat`), calls `notifyRemoval` (which clears the chat's composer and editor drafts), and
  queues `{ op: "delete" }` on the per-chat save queue. The sidebar's two chat delete handlers (`SideChatList.svelte`)
  and the chat list dialog (`ChatList.svelte`) ask `alertConfirm(removeConfirm + name)` first. Same-id character
  recreation (`installCharacterChats`) and the plugin reconcile (`reconcileCharacterChats`) also produce `delete`.
- The server applies `delete` as the group's only op at the current revision, refuses it while a foreign job owns a
  message of the chat, deletes the `chats` row, and removes the id from `chatOrders`. Messages, summaries, Structured
  Memory rows, checkpoints, and checkpoint policy cascade by foreign key. The invalidation hook cancels the chat's
  memory tasks and marks its rebuild `sourceReplaced` (no longer resumable). Other tabs learn of it through the
  generic `change` frame.
- A generation job occupies its chat slot at admission and owns messages only from its `begin`; `chatHeld`
  (`server/src/app.ts`) checks both. Detached automatic translation commits later through `applyChanges` with a
  `setTranslation` op.
- Chat metadata is one JSON `meta` column, normalized as a whole on every write; `ChatSummary` is a projection stored
  in `chatSummaries` and rebuilt when `SUMMARY_PROJECTION_VERSION` changes. Columns are added to an existing database
  at open after a `PRAGMA table_xinfo` check (the `memory_state.adoptionDeclined` precedent); `CHAT_TABLES_SQL` runs
  only on a fresh database.
- The checkpoint client (`chatCheckpoints.svelte.ts`) already does a whole-chat server action off the save queue:
  `prepare` refuses a generating or refused chat and awaits `flushResources`, one `POST` carries the epoch header, and
  the client re-reads the chat after the answer.
- `chatList`, `chatEntry`, `chatCount`, and `memberIds` read raw membership, which also backs selection and routes,
  plugin indexes and pages, journal recovery, snapshots, binding counts, and order writes. `selectedChatId` falls back
  to the first raw member.
- The server does not require a character to keep a chat; the one-chat rule is the tab's. Lua has no whole-chat delete
  (`removeChat` and `cutChat` in `server/src/lua/bindings.ts` remove messages).
- The character trash stamps and expires `trashTime` by the browser clock, which the durable data loss audit found can
  purge a fresh trash. Its catalog view (`GridCatalog.svelte`) restores and deletes forever (asking twice).
- The server reads settings records (`app.ts` reads `providers`) and starts timers in `startBackgroundTasks`; the asset
  lifecycle tick there reads `chats.meta` and `messages.data` for asset roots, but no timer deletes chat rows.

## Decisions

Written to the owner's answers, Q1 to Q12.

### The mark

- **D1. The mark is a column.** `chats` gains `trashedAt INTEGER` (null: not trashed; milliseconds, server clock),
  in `CHAT_TABLES_SQL` and, for existing databases, added at open after a `PRAGMA table_xinfo` check. It is not in
  `meta`, so no `meta`, `replace`, `create`, checkpoint, or settings-copy write can set or clear it, a `trashedAt` key
  a plugin stored in `meta` before this change is ordinary custom metadata, and the `Chat` type and the `ChatMeta`
  maps do not change. Only D3's route and D9's purge write the column.
- **D2. The summary carries it.** `ChatSummary` gains `trashedAt?: number`, filled from the column wherever a summary
  is built (`chatSummary`, the per-character listing, boot, the feed's summary, the staging writer).
  `SUMMARY_PROJECTION_VERSION` and `CHAT_SUMMARY_FORMAT` advance, so stored summaries and warm boot collections are
  rebuilt. The tab learns the mark only from summaries (boot, listing, feed, readback) and from D3's answers, and holds
  it in its list entry (`ChatEntryMeta`), not in the loaded `Chat`.

### The route

- **D3. Trash, restore, and permanent deletion are a route, not chat ops.** `POST /api/chat-trash/{trash,restore,
delete}` with `{ characterId, chatId }`, the epoch header, and for `delete` the `trashedAt` the tab holds. The route
  applies a server-internal change through `applyChanges` (revision, order, summary, commit, publication,
  invalidation), so these never enter the tab's save queue, draft journal, or boot recovery, and `ChatOp` does not
  change. Each answers `200` with the chat's new summary (or `deleted: true`); `trash` of a trashed chat and `restore`
  of an active one are `200` no-ops with the current summary.
  - `trash`: refused with `409` and reason `generating` while `chatHeld` is true (slot or message), and `409`
    `lastActiveChat` when no other chat of the character is active (Q12). Stamps `trashedAt` with the server's clock
    and calls D7's cancellation.
  - `restore`: never refused for a lock; clears the column.
  - `delete`: refused with `409` `notTrashed` unless the stored `trashedAt` equals the one sent, and `409` `generating`
    while `chatHeld`; deletes as today's `delete` does (cascade, order, invalidation).
- **D4. The save queue's `delete` is refused.** The batch route refuses every `{ op: "delete" }` group with a chat
  conflict (`409`, reason `useTrash`, with the chat's revision), so a tab of an earlier build, a journaled delete from
  before the upgrade, or any remaining producer re-reads and keeps the chat instead of deleting it. Character deletion
  (`deleteCharacter`), restore, and import are not chat ops and are unchanged (Q5).
- **D5. A trashed chat is read-only on the server.** Every chat group addressed to a trashed chat is refused as a chat
  conflict (`409`, reason `chatTrashed`, with its revision), the translation commit and a plugin's write included, and
  so are the checkpoint mutations (save, load, rename, delete, policy); checkpoint listing still works. A tab, an
  earlier build, or an open dialog that tries re-reads the chat on the existing conflict path and loses nothing stored.

### Work a trashed chat stops

- **D6. No new jobs.** Generation admission (`jobs.create`, after request-id replay) refuses a trashed chat with `409`
  and `error: "chatTrashed"`; the manual memory task route refuses it the same way; `autoSave` skips it.
- **D7. Trash cancels without replacing the source.** The trash change cancels the chat's queued and running memory
  tasks (it advances the task generation and reaches the existing listener) without calling `noteSourceReplaced`, so a
  paused Structured Memory rebuild stays resumable after a restore.
- **D8. Search.** The message search (`server/src/routes/messageSearch.ts`) leaves trashed chats out of every scope it
  takes (one chat, one character, all characters), on the first page and when a cursor resumes.

### Retention and storage

- **D9. The purge.** `chatTrashDays` in the `ui` section (`shared/database.ts` `Database`, `SECTION_FIELDS.ui`,
  `normalize/ui.ts`), default `30`, an integer from 1 to 3650 (Q7), shown as a leaf in a rendered section of the
  Storage settings page with a note that lowering it can delete trashed chats at the next purge, and left out of the
  upstream export as a Metatron-only setting. A purge timer started once by `startBackgroundTasks` runs a minute after
  start and then hourly, is skipped during maintenance, stops at `beginShutdown`, and is drained before the store
  closes. Each run reads `chatTrashDays` from the `ui` record and, per candidate, makes one top-level change that
  re-checks inside its transaction that the chat is still trashed with the same `trashedAt`, past the cutoff, and not
  `chatHeld`, then deletes it as D3's `delete` does. A refused candidate waits for the next run.
- **D10. Backups and exports** (Q10, Q11). Snapshots and version-2 archives copy the column with the file. Staging and
  `copyStagedChats` copy it (an archive without the column stages null), and the install sets every non-null value to
  the install time and rebuilds those chats' summaries, so an old snapshot never hands the purge an expired chat. The
  upstream export filters trashed chats out of the ordered ids before it derives `chatPage`. The tab's "export all
  chats" filters before its per-chat memory reads, and dataset export before it emits rows.

### Tab

- **D11. The tab's client.** A trash module beside the checkpoint client reuses its `prepare` (refuse while generating
  or refused, then `flushResources` for the chat) and request helper, and exposes `trashChat(ref)`,
  `restoreChat(ref)`, and `deleteChatForever(ref)`. None is optimistic: after a `200` the returned summary is installed
  in the list entry through the path a remote summary takes; a `409` re-reads the entry and shows a notice
  (`lastActiveChat` keeps `errors.onlyOneChat`, `generating` keeps `chatGenerating`). `trashChat` leaves membership,
  drafts, and composers alone; `deleteChatForever` sends the held `trashedAt` and, after `200`, runs `removeChat` and
  `notifyRemoval`. Today's `deleteChat` has no caller left and is removed.
- **D12. Active view.** `chatList`, `chatEntry`, `memberIds`, and the structural readers (recovery, snapshots, binding
  counts) keep reading every member. `activeChatList`, `trashedChatList`, and `activeChatCount` give the visible
  split, and the listed readers move to them: the sidebar list, `ChatList.svelte`, `pinnedChats.ts` (so the rail and
  home cards agree), `chatStatus.svelte.ts`'s pin status keys, `mainMenuProjection.ts` and `MobileCharacters.svelte`
  (recent activity and counts), the branches dialog (`src/ts/gui/branches.ts`), and the copy-name helper in
  `globalApi.svelte.ts`. Folder deletion clears `folderId` on active chats only (a restored chat whose folder is gone
  lists at the root, by `chatFolderOf`). A drag reorder of active rows is merged into the raw order with every trashed
  chat kept in its slot, and the plugin reconcile's order write uses the same merge. With D5 on the server, a reader
  missed shows a trashed chat or gets a conflict; none changes one.
- **D13. Selection.** `selectedChatId` falls back to the first active chat, and `selectChat` (and so the router and
  `changeChatTo`) treats a trashed chat as missing. Every path that installs a list entry (`metaOf` and its callers:
  loaded patches, summary installs, readbacks, the busy-load overlay) runs `syncSelection` when `trashedAt` changes,
  and an open chat screen whose chat is trashed elsewhere closes with a notice. D3's `lastActiveChat` keeps at least
  one active chat, so the selection always has one.
- **D14. Plugins** (Q9). Plugin v3 reads (`getChats` and its total, `getChatFromIndex`, the current chat and hook
  indexes, `getDatabase` full and summary through `snapshots.svelte.ts`, character copies, the job channel's copies)
  list and index active chats, with an active-membership version for paged reads across awaits. Index writes and
  `reconcileCharacterChats` re-check the captured chat id at application: a trashed id is ignored. An active chat the
  plugin's list omits is trashed with `trashChat`; same-id character recreation (`installCharacterChats`) trashes the
  active chats it would have deleted and keeps trashed ones. `risuai.d.ts` and `plugins.md` say an omitted chat goes
  to the trash.
- **D15. The checkpoint dialog** closes, with a notice, when its chat is trashed, and its load and delete re-check the
  chat is active before they send (D5 refuses them anyway).

### Sidebar UI

- **D16. The trash view in `SideChatList`.** The bottom toolbar gains a trash button with the trashed count (no badge
  at zero). Pressing it swaps the scrolling list for the trash view and hides New Chat; the search field stays and
  filters trash rows by name. The view has a back button and the title "Trash (n)", the line "Chats in the trash are
  deleted forever after N days" from `chatTrashDays`, and one row per trashed chat, newest first: the name, the folder
  it was in (when that folder still exists), the time it was trashed, the days left, and Restore and Delete forever
  buttons. Rows do not open the chat. An "Empty trash" button ends the view and is disabled when it is empty; it calls
  `deleteChatForever` per chat and reports any it could not delete. Confirmations, Windows style (Q3, Q8), each one
  `alertConfirm`; Restore asks nothing:
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
- **Q4. Plugin and Lua deletions.** To the trash (owner, 2026-11-22). Lua has no whole-chat delete today.
- **Q5. A trashed character's chats.** Follow the character, unchanged (owner, 2026-11-22).
- **Q6. Surfaces.** The desktop sidebar only (owner, 2026-11-22). There is no separate mobile chat list; the shared
  components change as D12 says.
- **Q7. The retention range.** Answered as proposed (owner, 2026-11-22): whole days from 1 to 3650, no "never".
  Alternative: `0` for never purge.
- **Q8. Confirmations for a permanent delete.** Answered as proposed (owner, 2026-11-22): one, as Windows asks.
  Alternative: twice, as the character trash's delete forever does (`removeConfirm` then `removeConfirm2`).
- **Q9. Plugins.** Answered as proposed (owner, 2026-11-22): plugins see active chats only, and an omitted chat goes to
  the trash (D14). Alternative: plugins see trashed chats with their `trashedAt`, which every plugin would then have to
  filter.
- **Q10. Exports.** Answered as proposed (owner, 2026-11-22): native snapshots and backups keep trashed chats; "export
  all chats", dataset export, and the upstream export leave them out (D10).
- **Q11. Restored snapshots.** Answered as proposed (owner, 2026-11-22): a restore or import resets `trashedAt` to the
  restore time (D10). Alternative: keep the stored time, so chats that expired since the snapshot are purged within the
  hour.
- **Q12. No active chat left.** Two tabs trashing a character's last two active chats is an edge case to block
  cheaply (owner, 2026-11-22): the server refuses a trash that would leave no active chat (D3, `lastActiveChat`).
  Alternative: allow zero active chats and give the tab an empty state.

## Limitations

- A tab of an earlier build left open after the upgrade does not know the mark: it keeps listing a chat another tab
  trashed, and its edits and deletes of that chat are refused and re-read (D4, D5) until it reloads.
- A trash, restore, or permanent delete whose request fails or whose tab closes before the answer did not happen, or
  happened without the tab knowing; the tab re-reads the entry on its next summary.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guides the slice names, with `pnpm docs:read`.
- Server tests drive the store through its existing test fixtures against a real SQLite store; tab tests use the chat
  store's existing setup (`src/ts/storage/tests/chatStore.test.ts`, the shared mock
  `src/ts/storage/tests/chatStoreMock.ts`) and mount `SideChatList` as `src/lib/SideBars/SideChatList.test.ts` does.
- Each slice runs its own focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`; the last
  code slice runs the whole suite and the browser specs the change reaches.
- No change to the character trash, to message removal, or to Lua.

## Slices

Order: 1, 2, 3, 4, 5, 6, one after another. Slices 1, 2, and 3 share `server/src/data/chatStore.ts`,
`server/src/data/resourceStore.ts`, and `server/src/data/upstream/exportDatabase.ts`; slices 3, 4, and 5 all edit
`src/lang/en.ts` and `src/lang/ko.ts`.

### 1. The mark, the route, and read-only chats on the server (_hard_)

- `server/src/data/chatStore.ts`: the column in `CHAT_TABLES_SQL` and its open-time check, the summary field from the
  column and `SUMMARY_PROJECTION_VERSION`, the server-internal trash, restore, and permanent-delete changes, the
  `useTrash` refusal of `delete` groups and the `chatTrashed` refusal of groups to a trashed chat (D1 to D5).
- `server/src/data/resourceStore.ts`: the plumbing for the internal changes through `applyChanges` (D3).
- A new route module `server/src/routes/chatTrash.ts`, registered in `server/src/app.ts`, with the `chatHeld` and
  `lastActiveChat` admissions (D3); `server/src/routes/chatCheckpoints.ts` or `server/src/data/checkpointService.ts`:
  the checkpoint mutations refused for a trashed chat (D5).
- `shared/chats.ts`: `ChatSummary.trashedAt`, `CHAT_SUMMARY_FORMAT`, the route's request and answer types and reasons.
- Tests (`server/src/tests/chatStore.test.ts` and a new route test): an existing database gains the column at open; a
  `meta` write of `trashedAt` and a whole `replace` leave the column alone; trash stamps the server clock and restore
  clears it, both idempotent; trash is refused while a job holds the slot before `begin` and while it owns a message,
  and for the last active chat; restore is not refused by a job; `delete` with a wrong or missing `trashedAt` is
  refused and with the held one deletes with the cascade; a queued `delete` group is a `useTrash` conflict carrying the
  revision; a group to a trashed chat (a message edit, `setTranslation`) and a checkpoint load or delete are refused;
  the summary, listing, and feed change carry the mark.

### 2. What a trashed chat stops, and storage (_hard_)

Depends on 1.

- `server/src/jobs/generationJobs.ts`: the `chatTrashed` admission refusal after request-id replay (D6).
- `server/src/routes/memoryTasks.ts`, `server/src/prompt/memory/memoryTasks.ts`, `server/src/data/resourceStore.ts`
  (the invalidation hook), `server/src/data/memoryStore.ts`: the manual refusal and the cancellation without
  `noteSourceReplaced` (D6, D7).
- `server/src/data/checkpointService.ts`: `autoSave` skips a trashed chat (D6).
- `server/src/routes/messageSearch.ts`, the scope resolution in `server/src/data/resourceStore.ts`, and the chat search
  queries in `server/src/data/chatStore.ts`: trashed chats left out of the chat, character, and global scopes and of
  cursor resumption (D8).
- `server/src/data/chatStore.ts` (the staging writer, `copyStagedChats`), `server/src/data/resourceStore.ts`
  (`replaceAll`), `server/src/routes/backups.ts`: the column through staging and install, the install-time stamp, and
  the rebuilt summaries (D10); `server/src/data/upstream/exportDatabase.ts`: trashed chats filtered before `chatPage`.
- Tests (the generation-job, memory-task, checkpoint, message-search, backup, restore-stage, and upstream export tests):
  a job and a manual memory task for a trashed chat are refused; a running memory task is cancelled; a paused rebuild,
  trashed and restored, still resumes; no automatic checkpoint is captured; a trashed chat is absent from search hits
  in each scope, a direct chat-scope request included, and a continuation returns nothing more from a chat trashed
  between pages; a snapshot restore keeps the mark with the install time; an archive without the column restores the
  chat active; the upstream export omits the chat and keeps `chatPage` on the right chat.

### 3. The retention setting and the purge (_small_)

Depends on 2.

- `shared/database.ts`, `shared/sections.ts`, `server/src/data/normalize/ui.ts`: `Database.chatTrashDays`, its `ui`
  section entry, and its normalization (D9).
- A purge module under `server/src/data/`, started, stopped, and drained in `server/src/app.ts` (D9).
- `src/ts/setting/storageSettingsData.ts` (the leaf and its place in a rendered Storage section), `src/lang/en.ts`,
  `src/lang/ko.ts`: the settings item (D9); `server/src/data/upstream/exportDatabase.ts`: `chatTrashDays` classified as
  Metatron-only.
- Tests: normalization (missing, wrong kind, out of range, fractional); a purge with a controlled clock deletes only
  chats past the setting, re-reads the setting each run, skips a chat restored, re-trashed, or held between the read and
  the delete, publishes the deletion, does not run during maintenance, and stops at shutdown.

### 4. The tab's client, store, readers, and plugins (_hard_)

Depends on 3.

- A trash client module beside `src/ts/checkpoints/chatCheckpoints.svelte.ts`, sharing its `prepare` and request
  helpers (D11).
- `src/ts/storage/chatStore.svelte.ts`: `trashedAt` in `ChatEntryMeta` through `metaOf`, summary installs, and the
  busy-load overlay; `activeChatList`, `trashedChatList`, `activeChatCount`; the selection rules; the order merge; the
  removal of `deleteChat`; `reconcileCharacterChats` and `installCharacterChats` (D11 to D14).
- The readers D12 lists, `src/ts/router/router.svelte.ts`, `src/ts/globalApi.svelte.ts`, `src/lib/ChatScreens/`
  (closing a chat trashed elsewhere), `src/ts/characters.ts` and `src/ts/storage/exportAsDataset.ts` (D10, D12, D13).
- `src/ts/plugins/apiV3/v3.svelte.ts`, `src/ts/network/jobChannel.ts`, `src/ts/storage/snapshots.svelte.ts`,
  `src/ts/plugins/apiV3/risuai.d.ts` (D14); `src/lib/Others/ChatCheckpointsDialog.svelte` (D15).
- `src/lib/Others/ChatList.svelte` and the two chat delete handlers and folder deletion of
  `src/lib/SideBars/SideChatList.svelte`: `trashChat` with the move-to-trash confirmation, and the active-only folder
  cleanup and order merge (D12, D16); the move-to-trash, notice, and remote-close strings in `src/lang/en.ts` and
  `src/lang/ko.ts`.
- Tests (`src/ts/storage/tests/chatStore.test.ts`, a new trash client test, `src/lib/SideBars/pinnedChats.test.ts`,
  `src/ts/plugins/apiV3/hostApiChats.test.ts`, `src/lib/SideBars/SideChatList.test.ts`, and the readers' existing
  tests; the shared mock and fixtures that simulate a permanent removal are updated): trash flushes first, installs the
  answer, and keeps the member and its drafts; a `409` re-reads and shows the notice; a trashed selection moves to the
  first active chat, also from a remote summary and a loaded patch; the router and `selectChat` refuse a trashed chat;
  pinned and recent projections skip it; a drag reorder and a plugin order keep trashed chats in their slots; folder
  deletion leaves a trashed chat's `folderId`; restore brings it back with its folder and pin; `deleteChatForever`
  sends the held mark and then removes the member; a plugin's omitted chat is trashed, a stale write to a trashed id is
  ignored, and its indexes and pages skip trashed chats; the checkpoint dialog closes when its chat is trashed.

### 5. The sidebar trash view (_small_)

Depends on 4.

- `src/lib/SideBars/SideChatList.svelte`: the toolbar button, the trash view, and the delete-forever and empty-trash
  confirmations (D16).
- `src/lang/en.ts`, `src/lang/ko.ts`: the trash view's strings.
- Tests (`src/lib/SideBars/SideChatList.test.ts`): the count shows and hides; the view swaps in and out; restore calls
  the store at once; delete forever and empty trash each call it only after one Yes; empty trash reports a chat it
  could not delete; the filter narrows trash rows; a trash row does not open the chat.

### 6. Guides and close-out (_small_)

Depends on 5.

- The [chat store](../structure/chat-store.md), [resource sync](../structure/resource-sync.md),
  [UI and theming](../structure/ui-theming.md#sidebar), [settings](../structure/settings-i18n.md),
  [plugin sandbox](../structure/plugin-sandbox.md), and [server resources](../structure/server-resources.md) guides
  describe the column, the route, read-only trashed chats, the purge, the active view, and the trash view, with the
  Limitations above; `plugins.md` says an omitted chat goes to the trash; the plan is retired by
  `docs/plan/README.md` and `docs/archived-plan/README.md`, and unrun manual checks go to
  `docs/backlog/manual-checks.md`.

## Manual Checks

- Desktop browser: trash a chat, see it leave the list and the pinned rail, find it in the trash view with its folder
  and days left, restore it, and see its messages, folder, pin, and memory panel as before.
- Two tabs on the same character: trash the chat open in the other tab; that tab leaves the chat with the notice.
  Restore it from the first tab; it reappears in the second. Trash the last two active chats one in each tab; the
  second is refused.
- Set the retention to 1 day, move the purge's clock past it, and see the chat leave the trash within the hour; a chat
  restored in the meantime stays.
