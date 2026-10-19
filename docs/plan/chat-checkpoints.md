# Chat Checkpoints Plan

Status: planned 2026-10-20 at `c7628a0bb`. No slice landed. Source: the RisuBard
save slots (`docs/research/risubard-survey.md` §2.3.1, recommended as the best fit in
`docs/research/pocketrisu-risubard-picks.md` §3 item 1; RisuBard code at
`/home/codex/RisuBard`, read-only reference). Line numbers are approximate; the
identifiers are the anchors. Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm test:agent --exclude ".claude/**"` (`--tags-filter=slow` for the storage suites it
touches) and the owning guide's focused checks, and updates the owning guide where it
changes a documented contract, except `docs/structure/persistence.md`, whose changes wait
for slice 6 (see Order).

## Problem

metatron can roll back only the whole server: `server/src/data/snapshots.ts` copies
`save/data/resources.sqlite` every 10 minutes while data changes and keeps the newest 20
(`backup-sync-hub.md`, "Load Internal Backup"). A restore replaces every character,
chat, and setting and reloads every tab. There is no way to keep a named point in one
story and return to it later: rewinding a chat by hand means deleting messages, which
leaves the chat variables (`scriptstate`), the chat lorebook (`localLore`), and the
memory (`hypaV3Data` and its siblings) at their newer values. Those are written by
server jobs (Lua/triggers, the memory step in `assemblePrompt`), so after a rewind the
next prompt is built from state that no longer matches the messages.

## Approach

A checkpoint is a named, per-chat record on the server that bundles the chat's messages
with the chat fields that carry story state. Saving and loading are server operations:
the tab never assembles or uploads a checkpoint.

What a checkpoint holds, by chat field (`Chat`, `shared/database.ts`):

| Captured on save, restored on load                                  | Kept as the chat has it on load                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `message` (every row, as stored)                                    | `id`, `name`, `pinned`, `folderId`, `lastDate`                            |
| `note`, `localLore`, `scriptstate`                                  | `bindedPersona`, `promptPresetId`, `modelPresetId`, `bindingReview`       |
| `supaMemoryData`, `hypaV2Data`, `hypaV3Data`, `lastMemory`          | `togglePresetId`                                                          |
| `fmIndex`, `bookmarks`, `bookmarkNames`, `toolCalls`                | the six translation settings (`translatorPresetId`, `autoTranslate`, ...) |
| `suggestMessages`, `sdData`                                         | `memoryTrimAck` (a "don't ask again" answer), `modules`                   |
| `GLGlobalVariables` entries whose key does not start with `toggle_` | `GLGlobalVariables` entries whose key starts with `toggle_`               |

`GLGlobalVariables` is split by key: the first-party writers (`chatToggles.svelte.ts`
`setChatToggle`, `togglePresets.svelte.ts` apply) write only `toggle_<key>` entries, but a
plugin's chat result (`src/ts/plugins/apiV3/v3.svelte.ts` ~1680, applied through
`applyChatResult` and `mergeChatMeta`, `chatStore.svelte.ts` ~2806) can merge any key,
and `resolveGlobalChatVar` (`shared/prompt/toggles.ts` ~132) reads any key as a chat
override (`server/src/tests/fixtures/cbs-parity.json` has a `bonus` entry). So toggles
stay and every other entry is story state. The split lives in one exhaustive table,
`CHECKPOINT_CHAT_FIELDS` in a new `shared/chatCheckpoints.ts`, typed
`Record<keyof ChatMeta, "capture" | "keep" | "split">` with `ChatMeta` from
`shared/chats.ts` (it already omits `message` and the two streaming flags; optional keys
still count), so a new `Chat` field fails `pnpm check` until it is classified. Server
memory has no other per-chat record: `save/data/vectors.sqlite` is a cache keyed by text
and model (`memory.md`), rebuilt on demand, and is not captured.

Storage: new tables in `resources.sqlite`, created when missing like `chatGroups`
(`self-host-server.md`), so the global snapshots, backup archives, and their restore carry
checkpoints with the chats they belong to. The connection runs with `foreign_keys=ON`.

- `chatCheckpoints`: `seq` autoincrement, `chatSeq` referencing `chats (seq)` with
  `ON DELETE CASCADE` (a chat or character delete, or a restore's `DELETE FROM chats`,
  removes its checkpoints in the same transaction), `id` (server UUID), `kind`
  (`manual`, `auto`, `safety`), `name`, `createdAt`, `revision`, `chatRevision` (the
  source chat's token at capture, informational), `userTurns`, `messageCount`,
  `preview` JSON, `pages` JSON (the ordered message page hashes), `fields` JSON (captured
  field name → page hash; an absent field is absent), unique `(chatSeq, id)`.
- `checkpointPages`: `hash` (SHA-256 hex of `text`'s UTF-8 bytes) primary key, `text`.
  Content-addressed and shared by every checkpoint of every chat.
- `checkpointPageRefs`: `checkpointSeq` referencing `chatCheckpoints (seq)` with
  `ON DELETE CASCADE`, `hash`, primary key `(checkpointSeq, hash)`, index on `hash`. The
  refs of a checkpoint are exactly the distinct hashes of its `pages` and `fields`. A page
  no ref names is garbage: a sweep (delete every `checkpointPages` row whose hash no
  `checkpointPageRefs` row names) runs in the transaction of every checkpoint delete and
  prune, at store open, and after `replaceAll`. Pages of a deleted chat wait for the next
  sweep.
- `chatCheckpointPolicy`: `chatSeq` primary key referencing `chats (seq)` with
  `ON DELETE CASCADE`, `autoEvery` 1–100, `autoKeep` 1–20, `lastAutoTurns` (nullable). No
  row means auto-checkpoints are off.
- `chatRestoreFloors` (slice 3): `chatSeq` primary key referencing `chats (seq)` with
  `ON DELETE CASCADE`, `revision`. The restore barrier, below.

Deduplication is by content hash inside SQLite, not in the asset store. The asset store
(`save/assets`, `assets/<sha>.<ext>`) is content-addressed, but it has no reference
counting or garbage collection (inlay files are kept on purpose because snapshots may
name them; only an explicit `/api/remove` deletes a file), sits outside the snapshots,
and is written outside the resource store's transactions, so a checkpoint whose pages
lived there could not be pruned safely nor restored with its chat.

- Message pages: the chat's message rows in position order, cut after a message whose
  `SHA-256(id)` first byte is `0 mod 16` (about 16 messages a page) or when a page reaches
  64 messages or 1 MiB of row text. The page text is `"[" + rowTexts.join(",") + "]"` of
  the stored `messages.data` texts, never a re-serialization. Breaks anchored on message
  ids keep pages stable: an insert, delete, or edit changes the pages from its own page up
  to the next anchor that survives; only inside a run of capped pages (64 messages with no
  anchor, or a 1 MiB cut) does the change shift later pages until an anchor is reached.
- Field pages: one page per captured field (`JSON.stringify` of the stored value; for
  `GLGlobalVariables`, of its non-toggle entries), so an unchanged `localLore` or
  `scriptstate` is stored once across checkpoints.

Load: the server builds the replacement chat (every `capture` field from the checkpoint,
absent ones absent; every `keep` field from the chat as stored now; `GLGlobalVariables`
as the current `toggle_` entries plus the checkpoint's other entries) and applies it as a
`replace` chat group through `store.applyChanges` on the chat revision the tab sent. The
whole load is one transaction: a safety checkpoint of the current state (kind `safety`)
is written before the replace, and the restore floor (below), the auto baseline, and the
pruning of older safety checkpoints after it, through a new `applyChanges` option that
runs checkpoint-table writes inside its transaction. A failure anywhere rolls all of it
back, so a failed load loses no recovery point and a committed one always has its floor.
`replace` keeps the fences of messages that survive it, closed (`chatStore.ts` ~1099),
so no earlier generation can reopen them; messages new to the chat have no fence.

Restore barrier: the server accepts a stale chat group for by-id ops (`chatStore.ts`
~1040: only a different `seq`, or `needsCurrent` on another revision, conflicts), and
`replace` keeps the chat's incarnation, so another tab's queued `setText`, `meta`, or
`append` based on the pre-load revision would land on the restored chat and undo part of
it. A load therefore records the revision it produced as the chat's floor
(`chatRestoreFloors`), and `chatStore.ts` `apply` treats a group whose base revision is
below the floor as a conflict, as for a different `seq`. The tab that sent it takes the
ordinary chat conflict recovery: it reads the chat back and discards its queued edits
with the reload notice. One case takes an extra round first: a by-id group with an
`append` whose anchor the load removed is re-anchored and resent by the client's
gone-anchor repair (`chatStore.svelte.ts` ~4035, eligible because the incarnation is
unchanged); it keeps its old base, so the floor refuses it again and the second conflict
discards it. Retries of an already applied group (`chatGroups` ids) answer from their
recorded result first, as today. Floors are not carried by a restore (a restore changes
the epoch, so every old token is refused anyway).

The change feed announces the chat as for any other writer; the issuing tab re-reads the
chat with `loadChat` and checks that it now holds the returned revision. Both save and
load refuse while a job holds the chat (its chat slot or a message lock): 409
`reason: "generating"`.

Auto-checkpoint: a job's `finalize` in `server/src/jobs/generationJobs.ts`, for a `send`,
`continue`, `reroll`, or `group` job that ends `done`, after its locks are released and
its terminal sent. By then the job's memory write (`AssemblyHost.writeMemory`, inside
the run) and its final reply write have both committed, which is the "after generation
and memory writes" rule; the hook lives outside `server/src/prompt/runner.ts`. A server
translation the job started runs detached and may write later; it is not waited for.

UI: a Checkpoints dialog per chat (list with preview, save as, load, rename, delete, the
auto policy), opened from the chat options menu.

Rejected for now:

- RisuBard's file-native slots (`characters/<id>/save-store/<hh>/<sha256>` files and a
  msgpack `chat.bin`): metatron's records are SQLite rows with revisions; files would
  sit outside the transactions, snapshots, and epoch fencing.
- A tab-side checkpoint (read the chat, upload it): the tab holds only loaded chats and
  its mirror can lag the server; capture must read what is stored.
- A checkpoint resource kind (`server/src/data/kinds.ts`): kinds are boot-read and
  live-synced to every tab; checkpoints are cold data read only by the dialog.
- Loading by delete-and-create of the chat (a new incarnation would refuse every stale
  group without a floor): the new `seq` would cascade-delete the chat's checkpoints and
  break every tab's held chat.
- "Load as new chat" (RisuBard has it): see Decisions D7.

## Order

1 → 2 → 3 → (4, 5) → 6.

- Slice 2 changes the restore path of the tables slice 1 creates (`checkpointStore.ts`,
  `resourceStore.ts` `readSnapshot`/`replaceAll`, `chatStore.ts` `replaceAll`).
- Slice 3 needs slice 1's store API; it adds the service, the routes, the load, the
  `applyChanges` transaction option, the restore floor in `chatStore.ts` `apply`, the
  registration in `server/src/app.ts`, and `chatBusy` in `generationJobs.ts`. It follows
  slice 2 because both touch `chatStore.ts`, `resourceStore.ts`, and
  `checkpointStore.ts`.
- Slice 4 touches `generationJobs.ts`, `app.ts`, `checkpointStore.ts`,
  `checkpointService.ts`, and `routes/chatCheckpoints.ts` after slice 3. Slice 5 (client
  module and dialog, under `src/`) needs slice 3's routes and service. 4 and 5 share no
  file and run in parallel; slice 5's policy row reaches slice 4's policy routes only
  through the client module, so slice 5 may land first with the policy row hidden until
  slice 4 is in.
- Slice 6 is the `persistence.md` guide update, last.

The unmerged `heap-memory-reduction` branch (`git diff --stat` of
`metatron...heap-memory-reduction` on 2026-10-20) changes `shared/database.ts`,
`src/ts/storage/records.svelte.ts`, `resourceSync.svelte.ts`, several
`src/ts/storage/tests/*` files including `storeBackedServer.ts`,
`src/ts/stores.svelte.ts`, `characters.ts`, `assetList.ts`, `parser/parser.svelte.ts`,
`CharConfig.svelte`, `process/modules.ts`, `util.ts`, `server/src/prompt/assemble.ts`,
`runner.ts`, `importModule.ts`, and `docs/structure/persistence.md`, among others. Slices
1–5 touch none of them: they read `Chat` from `shared/database.ts`, call
`flushResources`, `heldChatRevision`, `loadChat`, `getResourceEpoch`, and `epochMismatch`
from `src/ts/storage/` without editing them, use `storeBackedServer.ts` without editing
it, keep the dialog store out of `stores.svelte.ts`, and leave `persistence.md` to
slice 6. A slice that finds it must edit one of the branch's files stops there, takes
`Depends: heap-memory-reduction merge`, and moves to the end of the order.

## Slice 1. Checkpoint tables and store (_hard_, `self-host-server.md`)

- `shared/chatCheckpoints.ts` (new): `CHECKPOINT_CHAT_FIELDS` (above), the
  `GLGlobalVariables` split helper (`isToggleKey`: starts with `toggle_`), the wire types
  (`CheckpointSummary`: `id`, `kind`, `name`, `createdAt`, `revision`, `userTurns`,
  `messageCount`, `preview`; `CheckpointPreview`: the last two messages as
  `{ role, text }` with `text` the first 280 UTF-16 units of `data`, plus `summaries`
  (HypaV3 summary count), `loreEntries`, `variables` counts; `CheckpointPolicy`), and
  the limits (`MAX_CHECKPOINT_NAME` 200, `MAX_MANUAL_CHECKPOINTS` 100 per chat,
  `SAFETY_KEEP` 3, `autoEvery` 1–100, `autoKeep` 1–20). Shared rules (T2): relative
  `.ts` imports, `import type`, no DOM types.
- `server/src/data/checkpointStore.ts` (new) `createCheckpointTables(db, tokens)`: the DDL
  of the first four tables above (`CREATE TABLE IF NOT EXISTS`, as
  `CHAT_GROUP_TABLE_SQL`), prepared statements, and, inside the caller's transaction:
  - `save(...)` (characterId, chatId, name, kind): reads the chat row, its meta, and its
    message rows (`SELECT data FROM messages WHERE chatSeq = ? ORDER BY position`), cuts
    pages, inserts missing pages (`INSERT OR IGNORE`), the checkpoint, and its refs;
    counts `userTurns` (`role === "user"` rows); returns the `CheckpointSummary`. Names
    are truncated to `MAX_CHECKPOINT_NAME`. A missing chat is a `null` result (the
    route's 404); the 101st manual checkpoint is a `ResourceValidationError`. Save never
    prunes.
  - `prune(characterId, chatId, kind, keep)`: deletes the oldest checkpoints of that kind
    beyond `keep` and sweeps.
  - `list(characterId, chatId)`: summaries newest first, no page read.
  - `rename(...)` and `delete(...)` (by id and `baseRevision`): conditional on the
    checkpoint's revision token (`ResourceConflictError` otherwise, as a record write);
    delete sweeps pages.
  - `compose(characterId, chatId, id)`: the replacement `Chat` for a load (captured
    fields from pages, kept fields from the stored meta, the `GLGlobalVariables` split,
    `message` from the message pages), or `null` when either is gone. Pure read.
  - `readPolicy`/`writePolicy` (the table only; routes in slice 4), `sweep()`.
- Revision tokens use the store's `token`/`parseToken` (`chatStore.ts`
  `TokenFunctions`), so a token from another epoch never matches.
- `server/src/data/resourceStore.ts`: create the tables beside `createChatTables` (~493),
  sweep once at open, and expose `checkpoints` methods that run in `transactionInScope`
  (writes) or plain reads, each `assertOpen`/`assertWritable` as the neighbouring
  methods do. Checkpoint writes record nothing in the change accumulator (no feed event).
  `transactionInScope` adds only `state.writes` to `writeCount` (~857); count each
  committed checkpoint write there, so the snapshot timer takes it.
- Not here: routes, load application, restore.
- Test (`server/src/tests/chatCheckpoints.test.ts`, Node, real store on a temp dir): a
  save captures exactly the `capture` fields and the non-toggle `GLGlobalVariables`
  entries, and every message row byte-identical; two saves of an unchanged chat add no
  page; appending a message adds only the tail page(s); editing one middle message
  changes only the pages up to the next surviving anchor (ids chosen so the anchors are
  known), and a 64-message capped run shows the documented shift; a field page shared by
  two checkpoints survives deleting one and goes with the second; deleting the chat (a
  batch `delete` op) and deleting its character remove its checkpoints, refs, and policy
  (and the next sweep its pages); rename/delete on a stale revision conflict; the manual
  limit; `prune` keeps the newest N; a 300-unit name is truncated; `compose` takes kept
  fields and `toggle_` entries from the current meta (change the binding and a toggle
  after the save) and captured ones from the checkpoint (an absent captured field is
  absent in the result); the classification table names every metadata key of a fixture
  `Chat` with every field set, after excluding `message`, `isStreaming`, and
  `activeStreamingDisplayOptimizationMode`.

## Slice 2. Snapshots, restore, and archives carry checkpoints (_hard_, `self-host-server.md`)

Depends: 1.

- `readSnapshot` (`resourceStore.ts` ~1234) treats `chatCheckpoints`, `checkpointPages`,
  `checkpointPageRefs`, and `chatCheckpointPolicy` as one optional group: all absent (a
  snapshot from before slice 1) is valid and restores none; some present, or any with
  columns other than this store's, is refused. They are checked as ordinary tables by
  their own column list, not through `CHAT_TABLE_COLUMNS` (which would refuse older
  snapshots). Every row is checked: a checkpoint's and a policy's `chatSeq` names a chat
  the snapshot holds; a checkpoint `id` that `isValidResourceId` accepts; unique
  `(chatSeq, id)`; unique positive safe-integer checkpoint `seq` and `revision` (the
  token parser refuses others, `resourceStore.ts` ~483); a known `kind`; a name within
  the limit; finite non-negative integer counts and `createdAt`; `lastAutoTurns` null or
  a non-negative integer; `preview` of the `CheckpointPreview` shape; `pages` a list and
  `fields` a map of captured field names to hashes the snapshot's `checkpointPages`
  holds; its refs exactly the distinct hashes of `pages` and `fields`; each page's hash
  the SHA-256 of its text; each message page a JSON array of messages the server's
  `normalizeMessage` accepts, ids unique across the checkpoint's pages; each field page
  valid JSON the chat meta normalizer accepts for that field (`normalizeChatMeta` on a
  meta built from them); a policy within its ranges. Unreferenced pages are dropped, not
  refused. `ValidatedSnapshot` (~198) gains the rows.
- `replaceAll` (~1333): `chatTables.replaceAll` already maps old chat `seq` to new
  (`chatStore.ts` ~1643, the local `seqs` map); return it, delete and re-insert
  `checkpointPages`, then insert checkpoints and policies with mapped `chatSeq` and the
  refs with mapped checkpoint `seq`, in the restore's transaction. `DELETE FROM chats`
  cascades the old checkpoints, policies, and floors first.
- The backup import (`routes/backups.ts`) goes through `readSnapshot`/`replaceAll`, so it
  is covered; the export copies the database file, so the archive carries checkpoints
  (and never `llmSecrets`, unchanged). Confirm that the partial export
  (`selectPartialBackupAssets`) ignores the new tables.
- Restoring a snapshot replaces the checkpoints with the snapshot's: one saved after that
  snapshot is gone, and the safety snapshot taken before the restore still holds it.
  State this in `backup-sync-hub.md` beside "Load Internal Backup".
- Test (`server/src/tests/snapshots.test.ts`, `backups.test.ts`): a snapshot with
  checkpoints and a policy restores them on their chats, loadable (`compose`) with
  byte-identical rows; a snapshot without the tables restores with none; refused: a
  partial table group, a damaged page hash, a checkpoint on a missing chat, a ref to a
  missing page, a manifest hash with no ref, a message page that is not a message list,
  duplicate message ids across pages, an invalid checkpoint id, a non-positive revision,
  a policy out of range; an archive export then import round-trips them.

## Slice 3. Routes, load, restore floor, and the busy check (_hard_, `self-host-server.md`)

Depends: 1, 2.

- `server/src/data/checkpointService.ts` (new) `createCheckpointService(...)` over the
  store and a `busy` check: the route logic as plain functions (`list`, `save`, `rename`,
  `remove`, `load`), so slice 5's client test can call it without Hono.
  `busy(characterId, chatId)` is the job's chat slot (`jobs.chatBusy`) or a non-empty
  `guard.chatHolders(...)` (`generationLock.ts`).
- `server/src/routes/chatCheckpoints.ts` (new) `registerChatCheckpointRoutes(...)` (the
  service, store, auth, limiter, maintenance gate), registered in `createServerContext`
  (`server/src/app.ts`) with the shared limiter (2000/min) and `checkAuth`:
  - `GET /api/chat-checkpoints?characterId=&chatId=`, answering `{ epoch, checkpoints }`.
  - `POST /api/chat-checkpoints/save` with `characterId`, `chatId`, `name`, answering
    `{ epoch, checkpoint }`.
  - `POST /api/chat-checkpoints/rename` and `POST /api/chat-checkpoints/delete` with
    `characterId`, `chatId`, `id`, `baseRevision` (and `name` for a rename).
  - `POST /api/chat-checkpoints/load` with `characterId`, `chatId`, `id`,
    `chatBaseRevision`, answering `{ epoch, chatRevision, safety }`.
- Ids travel in the body or query, never the path (ids may hold `/`). Mutations require
  `x-resource-epoch` (412 `EpochMismatch` as `routes/resources.ts`) and
  `maintenance.assertOpen()` right before the write; 404 for a missing chat or
  checkpoint, 400 for an invalid body or a limit, 409 for a revision conflict, 409
  `reason: "generating"` when busy. Bodies are small JSON; `no-store`.
- Busy: `createGenerationJobs` gains `chatBusy(characterId, chatId)` (its `chatSlots`
  map, ~383). A job holds its chat slot from admission, before its first message lock,
  so the memory step is covered; `command` and `preview` jobs take a slot too.
- Restore floor: `chatRestoreFloors` (DDL in `checkpointStore.ts`); in `chatStore.ts`
  `apply` (~1040), a group whose parsed base revision is below the chat's floor conflicts
  as a different `seq` does (after the `chatGroups` duplicate lookup, so a retry of an
  applied group still gets its recorded answer). The conflict carries no `reason`.
- `resourceStore.ts` `applyChanges` gains an option (for example `inTransaction` with
  `before()` and `after(applied)` callbacks) run inside its transaction: `before` ahead of
  the chat groups, `after` once they applied and before COMMIT. The callbacks may write
  only the checkpoint tables; a throw rolls the whole transaction back. The existing
  `committed` callback runs after the commit and may not write, so it cannot serve.
  Confirm where `applyChangesInScope` opens and commits (~732, ~808) and that
  `writeCount` counts these writes.
- Load (`service.load`), one call with no await: epoch and maintenance check, busy
  check, `compose`, the chat revision equals `chatBaseRevision` (409 otherwise), then
  `store.applyChanges` with the one-op `replace` group on `chatBaseRevision` (a fresh
  `groupId`) and the transaction option: `before` saves the `safety` checkpoint (named
  "Before loading" plus the checkpoint's name, truncated); `after` sets the chat's floor
  to the group's new revision, sets the policy's `lastAutoTurns` to the loaded state's
  `userTurns` when a policy row exists (slice 4 reads it), and prunes safety checkpoints
  beyond `SAFETY_KEEP`. A conflict or any throw leaves nothing written. The replace
  publishes the chat's change feed ref after the commit. A lost answer is not retried by
  the tab (Decisions D5).
- Update the route table and Flows of `self-host-server.md` (the floor rule beside the
  chat group rules).
- Test (`server/src/tests/chatCheckpointRoutes.test.ts`, over `createServerContext` as
  `resourcesChats.test.ts` does): save → change messages, `scriptstate`, `localLore`,
  `hypaV3Data`, a non-toggle `GLGlobalVariables` entry, the persona binding, and a toggle
  through the batch route → load: captured fields back, binding and toggle as changed, a
  safety checkpoint listed, the chat revision advanced and one feed `change` with the chat
  ref; a message present before and after the load keeps a closed fence, a reintroduced
  one has none; after the load, a by-id `setText` and a `meta` group on the pre-load
  revision conflict, and one on the new revision applies; a retried pre-load group with
  its recorded `groupId` gets its recorded answer; a pre-load group with an `append`
  after a message the load removed is refused again after a client-style re-anchor (two
  conflicts, no write); load on a stale `chatBaseRevision` is 409, writes no safety
  checkpoint, and prunes nothing; a load whose `after` callback throws (a test hook)
  leaves the chat, its floor, and the three older safety checkpoints as they were; save
  and load while a job holds the chat slot (a runner held on a latch) are 409
  `generating`; a wrong epoch is 412; maintenance is 503; another character's chat id is 404.

## Slice 4. Auto-checkpoint after a finished job (_small_, `self-host-server.md`)

Depends: 3.

- Routes `GET` and `PUT /api/chat-checkpoints/policy` (`characterId`, `chatId`,
  `autoEvery`, `autoKeep`, or `off: true` to delete the row) through
  `checkpointService.ts` and `routes/chatCheckpoints.ts`; the table and its restore exist
  from slices 1–2.
- `createGenerationJobs` takes an optional `onChatJobDone` callback (characterId, chatId,
  kind), called at the end of `finalize` (~687) when the terminal is `done` and the kind
  is `send`, `continue`, `reroll`, or `group`, inside a try/catch that only logs
  (`logEvent("checkpoint.auto", ...)`). `app.ts` wires it to `service.autoSave`.
- `autoSave`: nothing unless a policy row exists, the chat exists, and `busy` is false
  (another job may have taken the slot since). With the chat's `userTurns` now: when
  `lastAutoTurns` is null, or `userTurns - lastAutoTurns >= autoEvery`, save an `auto`
  checkpoint, set `lastAutoTurns = userTurns`, and prune autos beyond `autoKeep`; when
  `userTurns < lastAutoTurns` (messages deleted), set `lastAutoTurns = userTurns` and
  save nothing. A reroll or continue adds no user turn. A load resets `lastAutoTurns`
  (slice 3), so an older loaded state resumes the count from its own turns.
- Test (`server/src/tests/chatCheckpointAuto.test.ts`, with the jobs harness of
  `generationJobs.test.ts`): a `done` send with `autoEvery` 2 saves at turn 1, not turn
  2, again at turn 3; an aborted or failed job, a `preview`, and a chat without a policy
  save nothing; the ring keeps `autoKeep`; deleting messages below `lastAutoTurns` resets
  it; after loading a turn-2 checkpoint over a turn-20 chat, autos resume at turn 4; the
  checkpoint holds the reply's final text and the memory value the job wrote (a fake
  runner that writes `hypaV3Data` then the reply); a throwing `autoSave` leaves the
  terminal event unchanged.

## Slice 5. Client checkpoint module and dialog (_hard_, `ui-theming.md`)

Depends: 3.

- `src/ts/checkpoints/chatCheckpoints.svelte.ts` (new): `listCheckpoints(ref)`,
  `saveCheckpoint(ref, name)`, `renameCheckpoint`, `deleteCheckpoint`,
  `loadCheckpoint(ref, id)`, `readCheckpointPolicy`/`writeCheckpointPolicy`, and the
  dialog store `chatCheckpointsDialog` (a writable of `ChatRef | null`, not in
  `stores.svelte.ts`). Requests go through `authFetch` (`serverAuth.ts`) with
  `RESOURCE_EPOCH_HEADER` and `getResourceEpoch()` on mutations; a 412 `EpochMismatch`
  goes to `epochMismatch(epoch)` (`resourceClient.ts`, exported) so the restore halt runs
  as for any resource write.
- Save: refuse with `chatGenerating` while `isChatGenerating(ref)`; await
  `flushResources()`; if its `discarded` names this chat (`chats/<chaId>/<chatId>`) or
  the character's order, stop and report that the chat changed elsewhere (the reload
  notice is already shown); else send.
- Load: refuse while `isChatGenerating(ref)`; await `flushResources()` with the same
  discard check; take `heldChatRevision(ref)` (refuse if null: never saved); send it as
  `chatBaseRevision`. On success await `loadChat(ref)` and compare `heldChatRevision(ref)`
  with the returned `chatRevision`: equal or newer is success; older means this tab still
  has work based on the old state, which the server's floor refuses and the conflict
  recovery replaces with the loaded chat and the reload notice, so report that the load
  landed and this tab's later edits were discarded. On 409 (revision): `loadChat(ref)` and
  report that the chat changed (the caller may retry). On 409 `generating`:
  `chatGenerating`. On a network error or 5xx: `loadChat(ref)` and report the outcome as
  unknown (D5).
- `src/lib/Others/ChatCheckpointsDialog.svelte` (new), mounted in `src/App.svelte` beside
  `ChatBindingDialog`, closed by Escape in `src/ts/hotkey.ts` (the binding-layer list).
  Entry: a third `chatOptions` button in `src/lib/Others/AlertComp.svelte` and its
  `case 2` in `SideChatList.svelte` `chatOptions`. Content: the chat's checkpoints newest
  first, grouped manual / auto / safety, each row with name, time, turn and message
  counts; selecting one shows its preview (the two last messages, summary/lore/variable
  counts) as plain text, never `{@html}` (S1); buttons Save as (name prompt, default the
  chat name and the date), Load (confirm text naming what changes and what stays, and
  that a safety checkpoint is saved first), Rename, Delete (confirm); the auto policy row
  (off, or every N turns keeping K), shown once slice 4's routes exist. Errors through
  `src/ts/alert.ts`; strings in `src/lang/en.ts` (U2, D9); theme tokens only (U1). While
  a load request is in flight the dialog stays modal and its buttons are disabled.
- The HypaV3 modal and the local lore draft follow an external replace of the chat (no
  write-back); keep it so.
- Tests:
  - `src/ts/checkpoints/chatCheckpoints.test.ts`: a test adapter in
    `src/ts/checkpoints/tests/checkpointServer.ts` wraps `StoreBackedServer` (its `store`
    and `fetch`, used read-only; the file is not edited): it answers the
    `/api/chat-checkpoints` routes by calling slice 3's `createCheckpointService` over
    the helper's real store (loaded at run time through a computed specifier, as the
    helper loads the server modules) and forwards everything else to the helper's
    `fetch`. Cases: a tab with an unsaved message edit saves a checkpoint that holds the
    edit; a flush that discards this chat's work stops the save; a load replaces the
    tab's mirror (messages, `localLore`, `scriptstate`, `hypaV3Data`) and keeps its
    binding and toggles, and `heldChatRevision` equals the answer's; a second tab's
    queued `setText` on the pre-load revision is refused by the floor and discarded with
    the reload notice, and its mirror then shows the loaded chat; with the adapter
    holding the load's answer after the server committed it (a latch), a local edit made
    meanwhile is refused by the floor and discarded the same way, and the module reports
    it; with the adapter holding the load before the server sees it, an edit that
    commits first makes the load answer 409 and the edit stays; a 412 halts saving.
  - `src/lib/Others/ChatCheckpointsDialog.test.ts` (happy-dom, the module mocked): list
    order and grouping, the preview renders text not markup, Load asks and calls
    `loadCheckpoint` once, Rename/Delete send the row's revision, a refused load shows the
    alert and keeps the dialog open.
  - One manual browser pass (save, change, load, undo with the safety checkpoint)
    recorded in the report.
- If the slice needs to edit any `src/ts/storage/` file, stop and take the heap
  dependency (see Order).

## Slice 6. Persistence guide update (_small_, `persistence.md`)

Depends: 5, heap-memory-reduction merge.

- `docs/structure/persistence.md`: the chat checkpoint rules on the client side: the
  restore floor in the chat save rules (a group on a revision below a load's floor
  conflicts and takes the ordinary recovery, with the extra re-anchor round), the
  `GLGlobalVariables` split, the checkpoint module's flush, load, and adopt sequence, and
  the `src/ts/checkpoints/` files and tests. Docs only; no code. Re-read the merged guide
  first and place the text in its current sections.
- Test: none (docs); `pnpm format:check`.

## Decisions

The runner takes each default unless the user overrides it.

- D1. Where checkpoints live. Options: (a) tables in `resources.sqlite`, carried by
  snapshots and archives; (b) a separate `save/data/checkpoints.sqlite` (no snapshot
  growth, but outside snapshots, archives, and the chat's transactions, and orphaned by a
  restore); (c) files in the asset store (no garbage collection, outside snapshots and
  transactions). Default (a).
- D2. Page dedup granularity. Options: (a) message pages cut at id-hash anchors with
  64-message and 1 MiB caps, plus one page per captured field; (b) fixed 64-message pages
  (an insert shifts every later page); (c) one page per message (most rows, best dedup).
  Default (a).
- D3. Auto-checkpoint default. Options: (a) per-chat policy, off until turned on in the
  dialog; (b) per-chat policy on by default (every 5 turns, keep 5, as RisuBard); (c) a
  global settings field (needs `shared/database.ts`, so it carries
  `Depends: heap-memory-reduction merge` and goes last). Default (a).
- D4. Field classification. Options: the table in Approach, or move any of `modules`,
  `memoryTrimAck` (kept) or `note`, `suggestMessages`, `sdData` (captured) across.
  Default: the table, with `GLGlobalVariables` split by the `toggle_` prefix.
- D5. A load whose answer was lost. Options: (a) no retry: the tab re-reads the chat and
  reports the outcome as unknown; (b) resend with the same `groupId` and `retry: true`,
  so the server answers `duplicate` (needs the safety checkpoint keyed by that id).
  Default (a).
- D6. Restore and checkpoints. Options: (a) a restore replaces them with the snapshot's
  (the safety snapshot keeps the current ones); (b) keep the live checkpoints across a
  restore, re-attached by `(characterId, chatId)`. Default (a).
- D7. Load as a new chat. Options: (a) not in this plan; (b) a `create` group instead of
  `replace` in slice 3 plus a dialog button in slice 5. Default (a).
- D8. Live update of the checkpoint list across tabs. Options: (a) none: the dialog
  reads on open and after each action, and a stale row's rename/delete answers 409 and
  re-reads; (b) a change-feed notice. Default (a).
- D9. Locales. Options: (a) `en.ts` only (others fall back); (b) `en.ts` and `ko.ts`.
  Default (a).
- D10. Limits. Defaults: 100 manual checkpoints per chat, 3 safety, auto every 1–100 and
  keep 1–20, name 200 UTF-16 units (generated names truncated); no byte quota. Options:
  change any number, or add a per-chat byte quota.
- D11. Writes based on the pre-load chat. Options: (a) a per-chat restore floor refuses
  every group below it (slice 3); (b) no floor, documented: another tab's stale by-id
  edits land on the restored chat. Default (a).

## Open Questions

- Snapshot growth: every global snapshot is a full copy of `resources.sqlite`, 20 kept.
  Dedup bounds checkpoint bytes inside one file, not across 20 copies. Measure on a
  large chat after slice 2; if it hurts, revisit D1 (b).
- Auto-checkpoint cost: `autoSave` reads and hashes every message row synchronously at a
  job's end (about 10 MB for a long chat). Measure in slice 4; if it is too slow, keep
  the previous page hashes per chat and hash only from the first changed row.
- Detached writers after a load: a server translation (`server/src/translation/runner.ts`)
  writing on a pre-load base is refused by the floor and loses that translation; one on
  the new base applies only where the message text still matches its `sourceHash`.
  Acceptable, or should the load end running translations of the chat?
- Character-scoped state is not rolled back: a Lua or trigger write to the character
  record, `globalChatVariables`, or a module is outside the chat. RisuBard's slots have
  the same scope.
- Inlays: a message's `{{inlay::id}}` points at an `inlays` record; a checkpoint does
  not hold it. A deleted inlay record makes a restored message show a missing image.
- Should a reroll or swipe restore `scriptstate` per reply (RisuBard §2.3.2)? A separate
  correctness feature, not part of this plan.

Verifier findings left open when this plan was committed (the opus-lite verification
stopped after its second round; the slice that owns each one resolves it first):

- Slice 1/3, blocking: slice 1 runs the public checkpoint writes in
  `transactionInScope`, which always opens its own transaction (`resourceStore.ts`
  ~829), while slice 3's `applyChanges` callbacks run inside `applyChanges`' transaction
  (~732); calling the public writes there fails as a nested transaction. Slice 3 must
  give the callbacks a transaction-bound checkpoint writer (the low-level table methods,
  no BEGIN/COMMIT), keep the standalone methods transactional, require synchronous
  callbacks, and add the callbacks' writes to `writeCount` at the commit.
- Slice 2, minor: read "unique checkpoint `seq`; `seq` and `revision` positive safe
  integers". Revisions are per-record counters and repeat across checkpoints.
- Slice 5, minor: when `heldChatRevision` stays older than the answer after `loadChat`
  (pending local work blocks adoption, `chatStore.svelte.ts` ~4431), the floor refuses
  that work only when it is next sent. Report that the server load committed and this
  tab's refresh is pending, or wait for the recovery and check adoption, before saying
  the edits were discarded.
