# Chat Trash Plan audit, 2026-11-22

- Plan: `docs/plan/chat-trash.md`
- Commit audited: `2417475d6`
- Mode: `full`
- Model: GPT-6.2-Astra (`xhigh`), read-only, run before plan-runner at the owner's request; report written by the
  drafting session (Claude Opus 5.5)

| Severity   | Count |
| ---------- | ----- |
| P1         | 6     |
| P2         | 1     |
| P3         | 3     |
| unverified | 0     |

Seven findings are open: the six P1 findings and A8. The P1 findings are data-loss gaps or mechanisms that do not
hold against the code: the mark's normalization, the permanent-delete intent, the save queue and recovery, the lock,
Structured Memory invalidation, and writes that still reach a trashed member. None is fixed by the audit; the plan
goes back for revision. A7, A9, and A10 are `fixed in plan`; the fix for A8 was disputed and is dropped, and the
finding belongs in the revision.

Astra ran no test and no type check; it read the source at the commit above. The audit took two turns, about 12
minutes and 6.2 M tokens. `read_only_violation` was `false` after both turns.

Re-check list: all four checked, clean. `patchMessage` closes an open fence (`server/src/data/chatStore.ts:2682`). A
chat feed change is sized in its three forms against the 64 KiB cap, with the id manifest and then the bare ref as the
fallback (`shared/resources.ts:565`, `server/src/data/chatStore.ts:1980`, `:2073`), so a trash mark travels as an
ordinary metadata change but may need a readback. `STORE_TABLES_SQL` runs at `user_version === 0` and for a fresh
staging database (`server/src/data/resourceStore.ts:3902`, `:776`). `sendText` counts any socket that accepts the
frame (`server/src/jobs/generationJobs.ts:1064`).

## P1

- **A1. D1, "`trashedAt` joins `CHAT_META_FORBIDDEN_KEYS`, so a `meta` op cannot write it"; D7, "Native snapshots and
  version-2 backups keep trashed chats with their mark."** The same key set rejects incoming patch keys and omits keys
  when stored metadata is normalized (`server/src/data/chats.ts:21`, `:40`, `:150`). An ordinary edit re-normalizes the
  whole stored object (`server/src/data/chatStore.ts:2566`), and snapshot validation does the same before staging
  (`server/src/data/chatStore.ts:3799`), so a rename could clear the mark and a backup could lose it before
  `restoreValidated` resets its time. In the other direction, a client or plugin of this commit can already store a
  numeric `trashedAt` as custom metadata, which the purge would take for a server-issued mark. Correction: separate
  the client-writable rule from the persisted-field rule; drop the mark on every create (chat file, plugin); on replace
  take it from the stored row inside the transaction and compute the summary from the final metadata
  (`server/src/data/chatStore.ts:860`, `:2430`); classify it `keep` for checkpoint load and `drop` for a settings-only
  copy (`server/src/data/checkpointStore.ts:515`); give pre-feature values and older archives a provenance rule so they
  cannot authorize a purge; through staging and install, keep the validated mark and write one install-time stamp to
  both metadata and summary (`server/src/data/chatStore.ts:3969`, `:4018`, `server/src/data/resourceStore.ts:3274`).
- **A2. Goal, "Only the trash view's 'delete forever' and 'empty trash', and the server's purge, remove a chat for
  good"; D4, "A tab of an earlier build ... gets that refusal instead of a hard delete."** An earlier tab can hold the
  current revision of a chat another tab trashed and still list it (`src/ts/storage/chatStore.svelte.ts:1573`,
  `:7297`); its ordinary Delete sends the same bare `{ op: "delete" }` (`:3615`), both D4 conditions pass, and the chat
  with its checkpoints is gone (`server/src/data/checkpointStore.ts:61`). Same-id character recreation also queues
  bare deletes for known chats missing from the replacement (`src/ts/storage/chatStore.svelte.ts:5418`, `:5438`), and
  an active-only copy omits exactly the trashed ones. D4's recovery of an untrashed chat after a `409` is right: the old
  client reads the chat back and reinstates it (`src/ts/storage/resourceClient.ts:157`,
  `src/ts/storage/resourceSync.svelte.ts:4303`, `src/ts/storage/chatStore.svelte.ts:6603`), though its drafts were
  already cleared by the optimistic delete. Correction: carry explicit permanent-delete intent on the wire (for
  example `delete` with the expected server-issued `trashedAt`, checked with the revision), refuse a bare delete even
  for a trashed chat, carry the intent through retry, journal recovery, and purge, and keep hidden members in same-id
  recreation.
- **A3. D1, "Each op is its group's only op"; D12, `trashChat` "sets `trashedAt` optimistically (the server's value
  replaces it), queues `trash`."** The per-chat queue sends its array as one group (`src/ts/storage/chatStore.svelte.ts:1791`,
  `:5912`), so edit then trash makes an invalid mixed group; a pending create sends a whole snapshot (`:5882`), so
  create then trash loses the trash; trash then Delete forever before the ack replaces the trash (`:3609`); a refusal
  retry can turn intent into a `replace` (`:5284`). The draft journal stores the op (`src/ts/storage/draftJournal.ts:125`),
  but boot recovery whitelists op kinds and assumes a message id (`src/ts/storage/journalRecovery.ts:244`, `:435`,
  `:498`, `:947`), so an unsaved restore could be stranded and the chat purged. An ack advances the revision without
  installing metadata and the later echo is suppressed (`src/ts/storage/chatStore.svelte.ts:6200`, `:7342`, `:7245`),
  so the tab can keep its own clock's value; `setChatMeta` cannot make the optimistic write (`:4480`, `:4555`).
  Correction: ordered, separately journaled groups for edit, create, trash, restore, and permanent delete; explicit
  recovery, Apply, and page-unload rules (`:3473`); a dedicated mirror transition; the ack returns the authoritative
  mark (no-ops and remembered results included) or a revision-fenced refresh follows; keep the server's replay, epoch,
  incarnation, and restore-floor checks (`server/src/data/chatStore.ts:2196`, `:2262`, `:2298`).
- **A4. D3, "`trash` takes the same whole-chat lock admission as `delete`"; D5, "A trashed chat gets no new work."**
  Delete's check asks whether a foreign job owns a message (`server/src/data/chatStore.ts:1921`), but a job occupies
  its chat slot before it owns one (`server/src/jobs/generationJobs.ts:2523`, `:1959`, `:3138`), and a preview may own
  none, so trash can pass while a job runs; the tab's `isChatGenerating` has the same gap
  (`src/ts/storage/chatStore.svelte.ts:1985`). A refused whole-chat op is kept and retried after the job (`:6511`,
  `:6734`), and detached automatic translation can commit after the generation (`server/src/prompt/runner.ts:769`,
  `server/src/translation/runner.ts:382`). Correction: check the occupied slot and message ownership in trash and purge
  admission (as `chatHeld` does, `server/src/app.ts:989`); check the mark at generation admission after request-id
  replay (`server/src/jobs/generationJobs.ts:2374`); give a refused trash a rollback and a notice; fence detached
  translation.
- **A5. D5, "`trash` calls the same invalidation as `delete`"; D6, "Structured Memory rows ... stay as they are."** The
  invalidation sets the durable `sourceReplaced` bit on every invalidated chat's rebuild
  (`server/src/data/resourceStore.ts:1165`, `server/src/data/memoryStore.ts:917`), so a paused rebuild becomes
  `resumable: false` and after a restore can only be abandoned (`server/src/data/memoryStore.ts:1358`,
  `server/src/prompt/memory/structured/rebuild.ts:847`). A manual memory task can also be admitted after the trash's
  invalidation (`server/src/routes/memoryTasks.ts:85`, `server/src/prompt/memory/memoryTasks.ts:1939`, `:1974`).
  Correction: a trash cancellation distinct from source replacement that advances the task generation and keeps the
  rebuild resumable (`server/src/data/resourceStore.ts:1184`, `server/src/app.ts:626`,
  `server/src/prompt/memory/memoryTasks.ts:2006`); refuse new manual tasks while trashed; test paused rebuild, trash,
  restore, resume.
- **A6. D10, "A reader missed shows a trashed chat; none loses one"; D13, "trashed chats are never touched."** A
  plugin list read before another tab trashed a chat still matches by raw membership and `applyChatResult` can replace
  or cut its transcript (`src/ts/storage/chatStore.svelte.ts:4889`, `:4765`); `setChatToIndex` captures its id before
  its awaits (`src/ts/plugins/apiV3/v3.svelte.ts:3257`). An open checkpoint dialog can load a checkpoint over a trashed
  chat or delete one (`src/lib/Others/ChatCheckpointsDialog.svelte:151`, `:175`, `:196`,
  `server/src/data/checkpointService.ts:254`, `:291`). Folder deletion walks raw `chatList`
  (`src/lib/SideBars/SideChatList.svelte:489`); an active-only drag order fails the permutation check, and appending the
  hidden ids moves them to the end (`:264`, `src/ts/storage/chatStore.svelte.ts:4925`, `:3624`). Selection falls back
  to the first raw id, `selectChat` returns silently, and loaded patches and summary installs do not call
  `syncSelection` (`src/ts/storage/chatStore.svelte.ts:1391`, `:3677`, `:3169`, `:7297`, `src/ts/router/router.svelte.ts:281`,
  `src/ts/globalApi.svelte.ts:1534`); two tabs can trash the last two active chats, leaving none. Correction: check
  active status by captured id at application for plugin writes and ignore trashed ids; guard destructive writes
  against the stored mark; merge an active reorder into raw order keeping hidden slots; folder cleanup edits active
  chats only; define the zero-active state (no selected chat, screen closed, the last trashed member still deletable).

## P2

- **A7. D5, "the message search ... leaves trashed chats out of both the character and all-character scopes."** The
  client also sends a single-chat scope (`src/ts/messageSearch.svelte.ts:43`), which the store resolves directly
  (`server/src/data/resourceStore.ts:3002`), and a cursor resumes at its chat (`server/src/data/chatStore.ts:1658`,
  `:3312`). **Fixed in plan** (Astra: confirmed). Old D5: "leaves trashed chats out of both the character and
  all-character scopes." New: "leaves trashed chats out of every scope it takes (one chat, one character, all
  characters), on the first page and when a cursor resumes." Slice 1's file bullet now names the scope resolution in
  `resourceStore.ts` and the search queries in `chatStore.ts`, and its tests a direct chat-scope request and a
  continuation across a trash.

## P3

- **A8. Slices, "1, then 2 and 3 side by side (disjoint files), then 4 after 3"; slice 1, "`shared/chats.ts`:
  `trashedAt` on the chat".** `Chat` is declared in `shared/database.ts:1329`, and two exhaustive `ChatMeta` maps need
  the field (`shared/chatCheckpoints.ts:17`, `src/ts/storage/chatSettingsCopy.ts:18`); slice 1's client type check
  reaches recovery branches that assume `op.id` (`src/ts/storage/journalRecovery.ts:436`, `util/changedChecks.mjs:11`);
  the summary needs `SUMMARY_PROJECTION_VERSION` and `CHAT_SUMMARY_FORMAT` advanced (`server/src/data/chatStore.ts:692`,
  `shared/chats.ts:210`) and slice 3 needs `metaOf`, summary installation, and the busy-load overlay
  (`src/ts/storage/chatStore.svelte.ts:1206`, `:8003`); slice 2 needs `Database.chatTrashDays`, a rendered Storage
  section, and the upstream settings classification (`shared/database.ts:127`, `src/ts/setting/storageSettingsData.ts:61`,
  `server/src/data/upstream/exportDatabase.ts:443`); slices 2, 3, and 4 all edit the locale files, and the sidebar
  still calls `deleteChat` between 3 and 4 (`src/lib/SideBars/SideChatList.svelte:42`, `:629`, `:762`); slice 3 omits
  the plugin database builder (`src/ts/storage/snapshots.svelte.ts:55`), the paged-read membership version
  (`src/ts/plugins/apiV3/v3.svelte.ts:2960`, `src/ts/storage/chatStore.svelte.ts:1521`), the plugin declaration and
  guide (`src/ts/plugins/apiV3/risuai.d.ts:1394`, `plugins.md:963`), and the shared mock and fixtures
  (`src/ts/storage/tests/chatStoreMock.ts:108`). **Open**: the drafted fix (serial order, the files above) was
  disputed because it left the old `shared/chats.ts` bullet and omitted `journalRecovery.ts`, the summary overlay, and
  the checkpoint-dialog guard, which belong to the A3 and A6 revisions. Astra's suggested wording: "Declare
  `Chat.trashedAt` in `shared/database.ts` and the summary and wire changes in `shared/chats.ts`. Include
  `src/ts/storage/journalRecovery.ts` in the same slice as the new op union." and, for slice 3, "Carry the mark
  through `metaOf`, summary installation and the busy-load overlay in `chatStore.svelte.ts`, and include the
  active-target guard in `src/lib/Others/ChatCheckpointsDialog.svelte`."
- **A9. Slice 4 tests, "restore, delete forever, and empty trash call the store after their confirmations".** D14 has
  no restore confirmation (`src/ts/alert.ts:401`). **Fixed in plan** (confirmed). New: "restore calls the store at
  once; a move to trash, delete forever, and empty trash each call it only after one Yes".
- **A10. Current State, "starts timers in `startBackgroundTasks`; nothing there touches chat records."** The asset
  lifecycle tick started there scans `chats.meta` and `messages.data` (`server/src/app.ts:1247`,
  `server/src/data/assetLifecycle.ts:1472`, `:584`). **Fixed in plan** (confirmed). New: "the asset lifecycle tick
  there reads `chats.meta` and `messages.data` for asset roots, but no timer deletes chat rows."

## Coverage

| Item                                    | Result         |
| --------------------------------------- | -------------- |
| Cited paths, identifiers, numbers       | A8, A9, A10    |
| Decision mechanisms                     | A1 to A8       |
| Slice files and parallel claims         | A8, A9         |
| Re-check list                           | Checked, clean |
| D1 server-owned field and ops           | A1, A3, A8     |
| D2 summary projection and propagation   | A3, A8         |
| D3 lock                                 | A4             |
| D4 permanent-delete admission and `409` | A2             |
| D5 no new work, search                  | A4, A5, A7     |
| D6 what a trashed chat keeps            | A2, A5, A6     |
| D7 backups, restore, exports            | A1             |
| D8 setting                              | A8             |
| D9 purge transaction and timer          | A2, A4         |
| D10 raw and active readers              | A6, A8         |
| D11 selection and navigation            | A6             |
| D12 tab operations and drafts           | A2, A3, A4, A6 |
| D13 plugins                             | A2, A6, A8     |
| D14 sidebar and confirmations           | A8, A9         |

Notes from the coverage that are not findings but belong in the revision: for the upstream export, filter the ordered
ids before deriving `chatPage` (`server/src/data/upstream/exportDatabase.ts:1070`); filter `exportAllChats` before its
per-chat memory reads (`src/ts/characters.ts:710`); the purge runs one top-level `applyChanges` per candidate with the
scan's epoch and revision, re-checks mark, cutoff, and job ownership inside the synchronous transaction, is gated
against maintenance, starts once, stops at `beginShutdown`, and drains before the store closes
(`server/src/data/resourceStore.ts:1760`, `:1887`, `server/src/data/snapshots.ts:85`, `server/src/app.ts:1247`,
`:1273`).
