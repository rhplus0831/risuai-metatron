# Chat Trash Plan

Status: drafted 2026-11-22 at `efba3bf17` from the owner's answers of 2026-11-22 on a chat trash in the desktop
sidebar (Q1 to Q6). The owner answered Q7 to Q11 as proposed the same day; D1 to D14 are written to those answers.
Not audited.

Sources: `shared/chats.ts` (`ChatOp`, `CHAT_META_FORBIDDEN_KEYS`, `ChatSummary`), `server/src/data/chatStore.ts`
(`summaryFields`, `chatSummary`, the op validation and apply branches, `deleteCharacter`), `server/src/data/chats.ts`
(metadata normalization), `server/src/data/resourceStore.ts`, `server/src/data/checkpointService.ts` (`autoSave`),
`server/src/prompt/memory/memoryTasks.ts` (`invalidate`), `server/src/jobs/generationJobs.ts`,
`server/src/routes/messageSearch.ts`, `server/src/routes/backups.ts` (`restoreValidated`),
`server/src/data/upstream/exportDatabase.ts`, `server/src/app.ts` (`startBackgroundTasks`), `shared/sections.ts`
(`SECTION_FIELDS.ui`), `server/src/data/normalize/ui.ts`, `src/ts/storage/chatStore.svelte.ts` (`deleteChat`,
`removeChat`, `notifyRemoval`, `chatList`, `chatEntry`, `chatCount`, `selectChat`, `syncSelection`,
`reconcileCharacterChats`), `src/lib/SideBars/SideChatList.svelte`, `src/lib/Others/ChatList.svelte`,
`src/lib/SideBars/pinnedChats.ts`, `src/lib/UI/mainMenuProjection.ts`, `src/ts/plugins/apiV3/v3.svelte.ts`,
`src/ts/characters.ts` (`exportAllChats`, the character trash), `src/lib/Others/GridCatalog.svelte`, and
`src/ts/setting/storageSettingsData.ts`, read at `efba3bf17`; the [chat store](../structure/chat-store.md),
[resource sync](../structure/resource-sync.md), [UI and theming](../structure/ui-theming.md#sidebar) and
[settings](../structure/settings-i18n.md) guides; the
[durable data loss audit](../reports/audits/codebase/durable-data-loss-2026-11-18.md), which records that a chat
deletion also deletes the chat's checkpoints and that the character trash expires by the browser clock. Identifiers
are the anchors; re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

Deleting a chat moves it to its character's trash, where it stays, untouched and whole, until the user restores it,
deletes it forever, or the retention the user chose passes.

- **Every chat deletion goes to the trash** (Q4): the sidebar, the chat list dialog, and plugins. Only the trash view's
  "delete forever" and "empty trash", and the server's purge, remove a chat for good.
- **A trashed chat is out of normal use**: it is not listed, selected, opened, sent to, searched, pinned, or worked on
  in the background, and restoring it gives back everything it had (messages, settings, folder, pin, memory records,
  checkpoints).
- **The server decides expiry by its own clock**, from a retention the user sets (Q1: 30 days by default).
- **The trash UI is in the desktop sidebar chat list** (Q2, Q6), per character, with Windows-style confirmations (Q3).

Not goals: a global trash across characters (Q2); a separate mobile layout (Q6); changing the character trash or its
three-day boot purge (filed in the durable data loss audit); a trash for messages, folders, modules, or presets.

## Current State

- `deleteChat` (`chatStore.svelte.ts`) refuses a character's last chat and a chat being generated in, removes the chat
  from the held list (`removeChat`), calls `notifyRemoval` (which clears the chat's composer and editor drafts), and
  queues `{ op: "delete" }`. The sidebar's two chat delete buttons (`SideChatList.svelte`, one for chats in a folder,
  one for root chats) and the chat list dialog (`ChatList.svelte`) ask `alertConfirm(removeConfirm + name)` first.
- The server applies `delete` as the group's only op at the current revision, refuses it while a foreign generation
  holds the chat, deletes the `chats` row, and removes the id from `chatOrders`. Messages, summaries, Structured Memory
  rows, checkpoints, and checkpoint policy cascade by foreign key. The resource store's invalidation callback cancels
  the chat's memory tasks. Other tabs learn of it through the generic `change` frame (a chat ref with a `null`
  revision) and drop it from their mirror; `syncSelection` then selects the first remaining chat.
- Chat metadata is one JSON `meta` column. A `meta` op's `set` and `unset` accept any key except
  `CHAT_META_FORBIDDEN_KEYS`, and the normalizer copies unknown keys through. `ChatSummary` (what a tab holds for an
  unloaded chat) is a fixed projection built by `summaryFields`; a field outside it reaches a tab only once the chat
  loads.
- `chatList`, `chatEntry`, `chatCount`, and `memberIds` read raw membership. Besides the visible lists, raw membership
  backs selection and routes, plugin indexes and pages, the plugin chat reconcile (`reconcileCharacterChats` deletes a
  chat a plugin's list omits), journal recovery, snapshots, binding counts, and many `chatEntry` membership guards.
- The server does not require a character to keep a chat; the one-chat rule is the tab's.
- Lua has no whole-chat delete (`removeChat` and `cutChat` in `server/src/lua/bindings.ts` remove messages).
- The character trash stamps `trashTime` with the browser clock and purges at boot with the browser clock
  (`isCharacterTrashExpired`, `maintainCharacters`), which the durable data loss audit found can purge a fresh trash.
  Its catalog view (`GridCatalog.svelte`) lists, restores, and deletes forever (asking twice), with no times shown.
- The server already reads settings records (`app.ts` reads `providers`) and starts timers in
  `startBackgroundTasks`; nothing there touches chat records.

## Decisions

Written to the owner's answers, Q1 to Q11.

### Data and server

- **D1. The trash mark is a server-owned chat field.** A chat gains `trashedAt?: number` (milliseconds, server clock).
  Only two new ops change it: `{ op: "trash" }` sets it to the server's `Date.now()` and `{ op: "restore" }` removes
  it. `trashedAt` joins `CHAT_META_FORBIDDEN_KEYS`, so a `meta` op cannot write it; `replace` and a whole-chat write
  keep the stored value whatever the body carries; `create` drops it (a copy of a trashed chat, an import, or a plugin
  create is never born in the trash). Each op is its group's only op, may apply on an older revision (it touches no
  message), and is a no-op when the chat is already in the state it asks for.
- **D2. The summary carries it.** `ChatSummary`, `summaryFields`, and the tab's `ChatEntryMeta` include `trashedAt`, so
  an unloaded chat's list entry knows it. Trash and restore propagate through the existing `change` frame as a meta
  delta with a summary; no event kind is added.
- **D3. Trash is refused while the chat generates.** `trash` takes the same whole-chat lock admission as `delete`
  (`409`, reason `generating`). `restore` is never refused for a lock.
- **D4. Only a trashed chat can be deleted.** The server refuses `delete` on a chat without `trashedAt` (`409`, reason
  `notTrashed`). A tab of an earlier build still open after the upgrade gets that refusal instead of a hard delete; the
  tab's existing conflict path keeps the chat. Character deletion (`deleteCharacter`), restore, and import are not
  `delete` ops and are unchanged.
- **D5. A trashed chat gets no new work.** The server refuses to create a generation job for a trashed chat (`409`,
  reason `chatTrashed`); `trash` calls the same invalidation as `delete`, so the chat's queued and running memory
  tasks are cancelled; `autoSave` skips a trashed chat; the message search (`server/src/routes/messageSearch.ts`)
  leaves trashed chats out of both the character and all-character scopes.
- **D6. What a trashed chat keeps.** Its row, messages, order position, folder, pin, Structured Memory rows,
  checkpoints, and assets stay as they are (the asset scan already reads `chats.meta` and `messages.data`), so a
  restore is exact. A chat restored after its folder was removed lists at the root (`chatFolderOf`'s rule).
- **D7. Exports and restores** (Q10, Q11). Native snapshots and version-2 backups keep trashed chats with their mark.
  A restore or import that installs a trashed chat sets its `trashedAt` to the restore time, so an old snapshot never
  hands the purge an already expired chat. The upstream export leaves trashed chats out (upstream has no chat trash and
  would list them). The tab's "export all chats" and dataset export leave them out.

### Retention and purge

- **D8. The setting.** `chatTrashDays` in the `ui` section (`SECTION_FIELDS.ui`, `normalize/ui.ts`), default `30`,
  normalized to an integer from 1 to 3650 (Q7). It is a leaf item on the Storage settings page
  (`storageSettingsData.ts`), with a note that lowering it can delete trashed chats at the next purge.
- **D9. The server purges.** A purge timer started by `startBackgroundTasks` and stopped by shutdown runs a minute after
  start and then hourly. Each run reads `chatTrashDays` from the `ui` record and, per chat whose `trashedAt` is older,
  re-checks in the delete transaction that the chat is still trashed with the same `trashedAt` and holds no generation
  lock, then deletes it through the same path as `delete` (cascade, order, invalidation, publication). A failed or
  refused chat is left for the next run. The tab never purges.

### Tab

- **D10. Raw membership stays; an active view is added.** `chatList`, `chatEntry`, `memberIds`, and the structural
  readers (recovery, snapshots, binding counts, order writes) keep reading every member. New `activeChatList`,
  `trashedChatList`, and `activeChatCount` give the visible split, and every listed reader moves to them: the sidebar
  list, `ChatList.svelte`, `pinnedChats.ts` (so the pinned rail and home cards agree), `chatStatus.svelte.ts`'s pin
  status keys, `mainMenuProjection.ts` and `MobileCharacters.svelte` (recent activity and counts), the branches dialog
  (`src/ts/gui/branches.ts`), and the copy-name helper in `globalApi.svelte.ts`. A reader missed shows a trashed chat;
  none loses one.
- **D11. Selection never rests on a trashed chat.** `selectChat` (and so the router and `changeChatTo`) refuses a
  trashed chat and falls back like a missing one; `syncSelection` treats a trashed selection as gone and selects the
  first active chat, also when the mark arrives from another tab, which then closes that chat's screen with a notice.
- **D12. The tab's operations.** `trashChat(ref)` replaces `deleteChat` for every user and plugin deletion: it refuses
  the last active chat and a generating chat, sets `trashedAt` optimistically (the server's value replaces it), queues
  `trash`, and does not call `removeChat` or `notifyRemoval`, so drafts survive a restore. `restoreChat(ref)` queues
  `restore`. `deleteChatForever(ref)` refuses a chat that is not trashed and then runs today's `deleteChat` body
  (`removeChat`, `notifyRemoval`, `delete`); it is the only caller left of that body.
- **D13. Plugins see active chats only** (Q9). Plugin v3 reads (`getChats`, `getChatFromIndex`, the current chat
  index, `getDatabase`, character copies) list and index active chats; index writes map an active index to its member.
  `reconcileCharacterChats` compares the plugin's list with active chats only: an omitted active chat is trashed
  (`trashChat`, keeping the last active one), and trashed chats are never touched.

### Sidebar UI

- **D14. The trash view in `SideChatList`.** The bottom toolbar gains a trash button with the trashed count (no badge
  at zero). Pressing it swaps the scrolling list for the trash view and hides New Chat; the search field stays and
  filters trash rows by name. The view has a back button and the title "Trash (n)", the line "Chats in the trash are
  deleted forever after N days" from `chatTrashDays`, and one row per trashed chat, newest first: the name, the folder
  it was in (when that folder still exists), the time it was trashed, the days left, and Restore and Delete forever
  buttons. Rows do not open the chat. An "Empty trash" button ends the view and is disabled when it is empty.
  Confirmations, Windows style (Q3, Q8), each one `alertConfirm`:
  - Delete in the list: "Move "{name}" to the trash?" (replaces `removeConfirm` for chats; the folder delete keeps its
    own text).
  - Delete forever: "Delete "{name}" forever? This cannot be undone."
  - Empty trash: "Delete the {n} chats in the trash forever? This cannot be undone."
  - The last active chat keeps `errors.onlyOneChat`; a generating chat keeps `chatGenerating`.

  Strings go to `src/lang/en.ts` with Korean overrides in `src/lang/ko.ts`.

### Questions the owner answered

- **Q1. Retention.** 30 days by default, set by the user (owner, 2026-11-22).
- **Q2. Scope.** Per character in this work (owner, 2026-11-22). Alternative: a global trash page.
- **Q3. Confirmation.** Kept (owner, 2026-11-22): chats are closer to memories than characters are, so the delete
  keeps a confirmation, Windows style, against a proposal to drop it for an undo toast.
- **Q4. Plugin and Lua deletions.** To the trash (owner, 2026-11-22). Lua has no whole-chat delete today.
- **Q5. A trashed character's chats.** Follow the character, unchanged (owner, 2026-11-22).
- **Q6. Surfaces.** The desktop sidebar only (owner, 2026-11-22). There is no separate mobile chat list; the shared
  components change as D10 says.
- **Q7. The retention range.** Answered as proposed (owner, 2026-11-22): whole days from 1 to 3650, no "never".
  Alternative: `0` for never purge.
- **Q8. Confirmations for a permanent delete.** Answered as proposed (owner, 2026-11-22): one, as Windows asks.
  Alternative: twice, as the character trash's delete forever does (`removeConfirm` then `removeConfirm2`).
- **Q9. Plugins.** Answered as proposed (owner, 2026-11-22): plugins see active chats only, and an omitted chat goes to
  the trash (D13). Alternative: plugins see trashed chats with their `trashedAt`, which every plugin would then have to
  filter.
- **Q10. Exports.** Answered as proposed (owner, 2026-11-22): native snapshots and backups keep trashed chats; "export
  all chats", dataset export, and the upstream export leave them out (D7).
- **Q11. Restored snapshots.** Answered as proposed (owner, 2026-11-22): a restore or import resets `trashedAt` to the
  restore time (D7). Alternative: keep the stored time, so chats that expired since the snapshot are purged within the
  hour.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guides the slice names, with `pnpm docs:read`.
- Server tests drive the store through the store's existing test fixtures against a real SQLite store; tab tests use
  the chat store's existing test setup (`src/ts/storage/tests/chatStore.test.ts`) and mount `SideChatList` as
  `src/lib/SideBars/SideChatList.test.ts` does.
- Each slice runs its own focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`; the last
  code slice runs the whole suite and the browser specs the change reaches.
- No change to the character trash, to message removal, or to Lua.

## Slices

Order: 1, then 2 and 3 side by side (disjoint files), then 4 after 3, then 5.

### 1. The trash mark on the server (_hard_)

- `shared/chats.ts`: `trashedAt` on the chat and `ChatSummary`, the `trash` and `restore` ops, `trashedAt` in
  `CHAT_META_FORBIDDEN_KEYS` (D1, D2).
- `server/src/data/chatStore.ts`, `server/src/data/chats.ts`: op validation and apply, the server clock stamp, the
  kept value across `replace` and the dropped value on `create`, the summary projection, the lock admission for
  `trash`, the `notTrashed` refusal of `delete`, the invalidation call (D1 to D5).
- `server/src/jobs/generationJobs.ts` (or the create route): the `chatTrashed` refusal (D5).
- `server/src/data/checkpointService.ts`: `autoSave` skips a trashed chat (D5).
- `server/src/routes/messageSearch.ts` and its query: trashed chats left out (D5).
- `server/src/routes/backups.ts` and `server/src/data/resourceStore.ts`: the restore-time reset (D7);
  `server/src/data/upstream/exportDatabase.ts`: trashed chats left out (D7).
- Tests (`server/src/tests/chatStore.test.ts`, `server/src/tests/messageSearch.test.ts`, the checkpoint, backup,
  generation-job, and upstream export tests): trash stamps server time and restore clears it; a `meta` set or unset of
  `trashedAt`, a `replace` without it, and a `create` with it leave the mark as the rule says; trash on an older
  revision applies; trash while a foreign job holds the chat is `409 generating`; `delete` on an untrashed chat is
  `409 notTrashed` and deletes on a trashed one; a job for a trashed chat is refused; memory tasks are cancelled; a
  trashed chat is absent from search hits and gets no automatic checkpoint; the summary carries the mark; a restore
  resets it; the upstream export omits the chat.

### 2. The retention setting and the purge (_small_)

Depends on 1.

- `shared/sections.ts`, `server/src/data/normalize/ui.ts`: `chatTrashDays` (D8).
- A purge module under `server/src/data/` and its start and stop in `server/src/app.ts` (D9).
- `src/ts/setting/storageSettingsData.ts`, `src/lang/en.ts`, `src/lang/ko.ts`: the settings item (D8).
- Tests: normalization (missing, wrong kind, out of range, fractional); a purge with a controlled clock deletes only
  chats past the setting, re-reads the setting each run, skips a chat restored or re-trashed between the read and the
  delete and a chat a job holds, and publishes the deletion; shutdown stops the timer.

### 3. The tab's store, readers, and plugins (_hard_)

Depends on 1.

- `src/ts/storage/chatStore.svelte.ts`: `trashedAt` in `ChatEntryMeta`, `activeChatList`, `trashedChatList`,
  `activeChatCount`, `trashChat`, `restoreChat`, `deleteChatForever`, the selection rules, and the plugin reconcile
  (D10 to D13).
- The readers D10 lists, `src/ts/router/router.svelte.ts`, `src/ts/globalApi.svelte.ts`, `src/lib/ChatScreens/`
  (closing a chat trashed elsewhere), `src/ts/characters.ts` and `src/ts/storage/exportAsDataset.ts` (D7, D10, D11).
- `src/ts/plugins/apiV3/v3.svelte.ts`, `src/ts/network/jobChannel.ts`: the active view and index mapping (D13).
- `src/lib/Others/ChatList.svelte`: its delete becomes `trashChat` with the move-to-trash confirmation.
- Tests (`src/ts/storage/tests/chatStore.test.ts`, `src/lib/SideBars/pinnedChats.test.ts`,
  `src/ts/plugins/apiV3/hostApiChats.test.ts`, and the readers' existing tests): trash keeps the member and its drafts;
  the last active chat cannot be trashed; a trashed selection moves to the first active chat, also from a remote
  change; the router and `selectChat` refuse a trashed chat; pinned and recent projections skip it; restore brings it
  back in place with its folder and pin; `deleteChatForever` refuses an untrashed chat; a plugin's omitted chat is
  trashed, its trashed chats are never deleted, and its indexes skip them.

### 4. The sidebar trash view (_small_)

Depends on 3; reads `chatTrashDays` from 2 (falls back to 30 until 2 lands).

- `src/lib/SideBars/SideChatList.svelte`: the toolbar button, the trash view, the confirmations, and the delete buttons
  moved to `trashChat` (D14).
- `src/lang/en.ts`, `src/lang/ko.ts`: the strings.
- Tests (`src/lib/SideBars/SideChatList.test.ts`): the count shows and hides; the view swaps in and out; a delete asks
  the move-to-trash text and trashes on Yes only; restore, delete forever, and empty trash call the store after their
  confirmations; the filter narrows trash rows; a trash row does not open the chat.

### 5. Guides and close-out (_small_)

Depends on 2 and 4.

- The [chat store](../structure/chat-store.md), [resource sync](../structure/resource-sync.md),
  [UI and theming](../structure/ui-theming.md#sidebar), [settings](../structure/settings-i18n.md),
  [plugin sandbox](../structure/plugin-sandbox.md), and [server resources](../structure/server-resources.md) guides
  describe the trash mark, its ops, the
  purge, the active view, and the trash view; the plan is retired by `docs/plan/README.md` and
  `docs/archived-plan/README.md`, and unrun manual checks go to `docs/backlog/manual-checks.md`.

## Manual Checks

- Desktop browser: trash a chat, see it leave the list and the pinned rail, find it in the trash view with its folder
  and days left, restore it, and see its messages, folder, pin, and memory panel as before.
- Two tabs on the same character: trash the chat open in the other tab; that tab leaves the chat with the notice.
  Restore it from the first tab; it reappears in the second.
- Set the retention to 1 day, move the server clock (or the purge's test clock) past it, and see the chat leave the
  trash within the hour; a chat restored in the meantime stays.
