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
  replaces it), queues `trash`."** The per-chat queue sends its array as one group
  (`src/ts/storage/chatStore.svelte.ts:1791`, `:5912`), so edit then trash makes an invalid mixed group; a pending
  create sends a whole snapshot (`:5882`), so create then trash loses the trash; trash then Delete forever before the
  ack replaces the trash (`:3609`); a refusal retry can turn intent into a `replace` (`:5284`). The draft journal stores
  the op (`src/ts/storage/draftJournal.ts:125`), but boot recovery whitelists op kinds and assumes a message id
  (`src/ts/storage/journalRecovery.ts:244`, `:435`, `:498`, `:947`), so an unsaved restore could be stranded and the
  chat purged. An ack advances the revision without installing metadata and the later echo is suppressed
  (`src/ts/storage/chatStore.svelte.ts:6200`, `:7342`, `:7245`), so the tab can keep its own clock's value;
  `setChatMeta` cannot make the optimistic write (`:4480`, `:4555`). Correction: ordered, separately journaled groups
  for edit, create, trash, restore, and permanent delete; explicit recovery, Apply, and page-unload rules (`:3473`); a
  dedicated mirror transition; the ack returns the authoritative mark (no-ops and remembered results included) or a
  revision-fenced refresh follows; keep the server's replay, epoch, incarnation, and restore-floor checks
  (`server/src/data/chatStore.ts:2196`, `:2262`, `:2298`).
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
- **A6. D10, "A reader missed shows a trashed chat; none loses one"; D13, "trashed chats are never touched."** A plugin
  list read before another tab trashed a chat still matches by raw membership and `applyChatResult` can replace or cut
  its transcript (`src/ts/storage/chatStore.svelte.ts:4889`, `:4765`); `setChatToIndex` captures its id before its
  awaits (`src/ts/plugins/apiV3/v3.svelte.ts:3257`). An open checkpoint dialog can load a checkpoint over a trashed chat
  or delete one (`src/lib/Others/ChatCheckpointsDialog.svelte:151`, `:175`, `:196`,
  `server/src/data/checkpointService.ts:254`, `:291`). Folder deletion walks raw `chatList`
  (`src/lib/SideBars/SideChatList.svelte:489`); an active-only drag order fails the permutation check, and appending the
  hidden ids moves them to the end (`:264`, `src/ts/storage/chatStore.svelte.ts:4925`, `:3624`). Selection falls back to
  the first raw id, `selectChat` returns silently, and loaded patches and summary installs do not call `syncSelection`
  (`src/ts/storage/chatStore.svelte.ts:1391`, `:3677`, `:3169`, `:7297`, `src/ts/router/router.svelte.ts:281`,
  `src/ts/globalApi.svelte.ts:1534`); two tabs can trash the last two active chats, leaving none. Correction: check
  active status by captured id at application for plugin writes and ignore trashed ids; guard destructive writes against
  the stored mark; merge an active reorder into raw order keeping hidden slots; folder cleanup edits active chats only;
  define the zero-active state (no selected chat, screen closed, the last trashed member still deletable).

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
  section, and the upstream settings classification (`shared/database.ts:127`,
  `src/ts/setting/storageSettingsData.ts:61`, `server/src/data/upstream/exportDatabase.ts:443`); slices 2, 3, and 4 all
  edit the locale files, and the sidebar still calls `deleteChat` between 3 and 4
  (`src/lib/SideBars/SideChatList.svelte:42`, `:629`, `:762`); slice 3 omits the plugin database builder
  (`src/ts/storage/snapshots.svelte.ts:55`), the paged-read membership version
  (`src/ts/plugins/apiV3/v3.svelte.ts:2960`, `src/ts/storage/chatStore.svelte.ts:1521`), the plugin declaration and
  guide (`src/ts/plugins/apiV3/risuai.d.ts:1394`, `plugins.md:963`), and the shared mock and fixtures
  (`src/ts/storage/tests/chatStoreMock.ts:108`). **Open**: the drafted fix (serial order, the files above) was disputed
  because it left the old `shared/chats.ts` bullet and omitted `journalRecovery.ts`, the summary overlay, and the
  checkpoint-dialog guard, which belong to the A3 and A6 revisions. Astra's suggested wording: "Declare `Chat.trashedAt`
  in `shared/database.ts` and the summary and wire changes in `shared/chats.ts`. Include
  `src/ts/storage/journalRecovery.ts` in the same slice as the new op union." and, for slice 3, "Carry the mark through
  `metaOf`, summary installation and the busy-load overlay in `chatStore.svelte.ts`, and include the active-target guard
  in `src/lib/Others/ChatCheckpointsDialog.svelte`."
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

## Second audit, of the revision

- Plan: `docs/plan/chat-trash.md`
- Commit audited: `4c52e82e0`
- Mode: `full`
- Model: GPT-6.2-Astra (`xhigh`), read-only, a fresh session; report written by the drafting session (Claude Opus 5.5)

| Severity   | Count |
| ---------- | ----- |
| P1         | 4     |
| P2         | 2     |
| P3         | 2     |
| unverified | 0     |

The revision moved the mark to a column, trash, restore, and permanent deletion to their own route, and trashed chats
to read-only on the server. Of the first audit, A2, A5, A7, A9, and A10 are resolved; A1, A3, A4, A6, and A8 are
partly resolved, and what remains of them is in B1 to B7. All eight new findings are open: none was sent for a fix
in this audit, and the P3 corrections belong in the next revision with the P1 ones. The turn took about 13 minutes
and 8.2 M tokens; Astra ran no test, and `read_only_violation` was `false`.

Re-check list: all four checked, clean (`server/src/data/chatStore.ts:2682`; `shared/resources.ts:572`,
`server/src/data/chatStore.ts:1980`, `:2073`, `server/src/data/resourceStore.ts:1275`;
`server/src/data/resourceStore.ts:776`, `:3902`; `server/src/jobs/generationJobs.ts:1064`). The publication-wide budget
can omit a change's summary, which B1 depends on.

### First-audit findings

| ID  | Resolution      | What remains                                                                           |
| --- | --------------- | -------------------------------------------------------------------------------------- |
| A1  | partly resolved | The column fixes provenance; the restore header check rejects the new layout (B4).     |
| A2  | resolved        | A new-route request's identity is B3; local work cleared by an old producer is B5.     |
| A3  | partly resolved | Installing the authoritative mark after an echo or readback (B1, B3).                  |
| A4  | partly resolved | `chatHeld` and admission are right; translation can start or finish around trash (B2). |
| A5  | resolved        | The rebuild can still be abandoned by another route (B2).                              |
| A6  | partly resolved | Loaded-chat selection, memory writes, plugin reconciliation order (B1, B2, B6).        |
| A7  | resolved        |                                                                                        |
| A8  | partly resolved | Test, fixture, browser, and character-install callers (B6, B7).                        |
| A9  | resolved        |                                                                                        |
| A10 | resolved        |                                                                                        |

### P1

- **B1. D2, the tab "holds it in its list entry (`ChatEntryMeta`), not in the loaded `Chat`"; D11, "the returned
  summary is installed in the list entry through the path a remote summary takes."** A loaded member has no held
  `ChatEntryMeta`: the store keeps a `Chat` or a summary and derives a loaded entry from the `Chat`
  (`src/ts/storage/chatStore.svelte.ts:573`, `:1605`, `:8003`). `applyRemoteSummary` rejects loaded members and equal
  revisions, `noteRemoteChat` returns after a loaded patch before its summary (`:7275`, `:7342`), and a whole read
  carries only `ChatRecord.data` (`shared/chats.ts:205`, `src/ts/storage/chatStore.svelte.ts:7474`), so an echo or a
  read can advance the revision and the route's later `200` is ignored. A column-only transition also misses the
  server's summary-changed test (`server/src/data/chatStore.ts:3057`). The detached reads behind "export all chats" and
  dataset export strip envelopes to `record.data` (`src/ts/storage/chatEdits.ts:157`,
  `src/ts/storage/chatStore.svelte.ts:5025`). Correction: revisioned trash state for every member, carried outside
  `Chat.data` on whole reads; install it independently of transcript freshness, accept an equal-revision mark when
  missing, reject older answers; compare the column at publication and read back when the summary is omitted; filter
  detached export records before stripping envelopes.
- **B2. D5, "A trashed chat is read-only on the server"; D7, "a paused Structured Memory rebuild stays resumable."** A
  stale memory panel can delete chapters, edit records, or clear pages through `store.memory` in its own transaction
  (`server/src/routes/structuredMemory.ts:1340`, `:1395`, `:2096`, `server/src/data/resourceStore.ts:2218`), and the
  rebuild-abandon route checks only `chatHeld` (`server/src/routes/structuredMemory.ts:2133`, `server/src/app.ts:1002`),
  so the rebuild D7 keeps can be abandoned while trashed. `POST /api/translate/message` starts outside `jobs.create`
  and calls the model before its `setTranslation` (`server/src/routes/translate.ts:81`,
  `server/src/translation/runner.ts:325`, `:380`, `:455`); after a restore the by-id op can apply on an older revision
  (`server/src/data/chatStore.ts:2302`). Correction: the stored-mark check in the synchronous write step of every
  Structured Memory mutation, chapters and abandon included, with D7's own cancellation able to finish; the mark check
  at translation start and join, and the source generation trash advances as a fence at commit.
- **B3. D3, "`{ characterId, chatId }`, the epoch header, and for `delete` the `trashedAt` the tab holds"; D11, after
  `200` `deleteChatForever` "runs `removeChat` and `notifyRemoval`."** A chat id can be reused within an epoch; the
  store tells incarnations apart by `seq` in the revision token (`shared/resources.ts:167`,
  `server/src/data/chatStore.ts:2298`, `src/ts/storage/chatStore.svelte.ts:3545`). A delayed trash or restore names no
  incarnation, two trash periods can share a millisecond, and a delayed `200` after the deletion feed and a same-id
  recreation would remove the new member and its drafts; `removeChat` alone also leaves the held revision, unlike the
  remote deletion settlement (`src/ts/storage/chatStore.svelte.ts:1290`, `:7193`). Correction: send the revision token
  captured at the action; permanent deletion requires the exact trashed revision and a matching non-null mark; the purge
  carries epoch, revision, and stamp into its transaction; the answer names the deleted identity, and the tab settles
  the deletion once for that incarnation through the remote deletion path.
- **B5. D4, "a journaled delete from before the upgrade ... re-reads and keeps the chat"; D5, "loses nothing
  stored."** The server row survives, but the old producer already removed the member, called `notifyRemoval`, and
  replaced pending ops with the delete (`src/ts/storage/chatStore.svelte.ts:3591`, `:3609`); an upgraded tab replaying
  an old journal delete calls the same notification in `installRecoveredChat` before sending (`:4972`), which drops
  editor drafts and composer journal rows (`src/ts/process/composerDrafts.svelte.ts:122`,
  `src/ts/storage/messageEditorDrafts.svelte.ts:283`). Correction: classify pre-upgrade deletes in boot recovery before
  anything is removed (`src/ts/storage/journalRecovery.ts:523`) and keep the drafts; state the narrower guarantee for a
  running old tab; one refusal reason for a fresh bare delete even on a trashed chat (D4's `useTrash` and D5's
  `chatTrashed` overlap), remembered successes answered before fresh admission (`server/src/data/chatStore.ts:2262`),
  and the new terminal reasons kept out of missing-anchor repair (`src/ts/storage/resourceSync.svelte.ts:4280`).

### P2

- **B4. D10, "Staging and `copyStagedChats` copy it (an archive without the column stages null)."** Before any row
  reaches the staging writer, `assertSnapshotHeader` requires the exact `CHAT_TABLE_COLUMNS.chats` layout
  (`server/src/data/chatStore.ts:114`, `server/src/data/resourceStore.ts:620`, `:3781`, `:823`), and the upstream export
  goes through it too (`server/src/data/upstream/exportStage.ts:36`), so slice 1's column breaks restore and upstream
  export until slice 2. Correction: in slice 1, accept both exact source layouts and select the column or
  `NULL AS trashedAt` in `walkChatSnapshot` (the optional memory column is the precedent,
  `server/src/data/memoryStore.ts:1473`), require the current layout for staged output, and stamp the install time in
  `replaceAll` before commit; define the repair of an imported character whose chats are all trashed, which the order
  validator and boot's `ensureChat` do not catch (`server/src/data/chatStore.ts:3933`,
  `src/ts/storage/chatStore.svelte.ts:3571`).
- **B6. D14, "An active chat the plugin's list omits is trashed with `trashChat`; same-id character recreation ...
  trashes the active chats it would have deleted."** The plugin reconcile and its callers are synchronous and compute
  order and `chatPage` right after the omissions (`src/ts/storage/chatStore.svelte.ts:4915`,
  `src/ts/plugins/apiV3/v3.svelte.ts:2113`, `:2364`, `src/ts/storage/records.svelte.ts:668`). Same-id recreation has
  already forgotten the old list and runs before the parent records are inserted, with a local rollback on failure
  (`src/ts/storage/chatStore.svelte.ts:5528`, `:5394`, `src/ts/storage/characterStore.svelte.ts:253`). The server
  validates only the order revision and permutation (`server/src/data/chatStore.ts:3463`). Correction: keep the parent
  install synchronous, keep or reread authoritative order, marks, and incarnations, then await the trash requests and
  report refusals before the final active order and selection; recheck owner and target after awaits; fence order
  writes against changes in active membership.

### P3

- **B7. D11, "Today's `deleteChat` has no caller left"; the slice lists.** Callers and fixtures outside the lists: the
  typed browser harness and Playwright scripts (`e2e/multiClient.ts:542`, `util/playwright/checkDurableDrafts.mjs:389`,
  `util/playwright/checkLiveUpdates.mjs:377`, `e2e/multiClientGeneration.spec.ts:434`), server tests relying on a real
  delete (`server/src/tests/memoryStore.test.ts:330`, `server/src/tests/chatSourceGeneration.test.ts:105`), the boot
  snapshot fixture for the new default (`server/src/tests/normalizeSections.test.ts:86`), `characterStore.svelte.ts`,
  `journalRecovery.ts`, the detached export reader, and typed unit callers
  (`src/lib/Others/LoreBudgetStopDialog.test.ts:206`). Slices 1 and 3 share `server/src/app.ts`, slices 4 and 5
  `SideChatList.svelte`, and the upstream export is in slices 2 and 3, not 1.
- **B8. Current State, the checkpoint client "re-reads the chat after the answer"; D11, "`flushResources` for the
  chat"; D1, "Only D3's route and D9's purge write the column."** `prepare` and `request` are private, the flush is
  global with target-specific checks, and only checkpoint load refreshes the chat
  (`src/ts/checkpoints/chatCheckpoints.svelte.ts:93`, `:225`, `:309`); the install also writes the column
  (`server/src/data/resourceStore.ts:3289`). Correction: name checkpoint load as the precedent and the helpers'
  extraction; distinguish a request never sent from a lost answer; state the column's writers as trash and restore,
  the native install, and row deletion.

## Third audit, of the second revision

- Plan: `docs/plan/chat-trash.md`
- Commit audited: `8cab9a528`
- Mode: `full`
- Model: GPT-6.2-Astra (`xhigh`), read-only, a fresh session; report written by the drafting session (Claude Opus 5.5)

| Severity   | Count |
| ---------- | ----- |
| P1         | 4     |
| P2         | 2     |
| P3         | 4     |
| unverified | 0     |

The revision answered the owner's triage of B1 to B8 and the changed Q4. B4 and B8 are resolved; B1, B3, B6, and B7 are
partly resolved; B2 is resolved for Structured Memory, with the translation Limitation as stated; B5's consequence is
worse than its Limitation states (C2). All ten new findings are open; none was sent for a fix. The turn took about 18
minutes and 10.8 M tokens; Astra ran no test (it type-checked a required `ChatRecord.trashedAt` in memory, emitting no
file), and `read_only_violation` was `false`.

Re-check list: the fence, fresh-schema, and socket-delivery entries are clean (`server/src/data/chatStore.ts:2682`,
`server/src/data/resourceStore.ts:3902`, `:786`, `server/src/jobs/generationJobs.ts:1064`); the feed-sizing entry
changes a plan claim, because the publication-wide budget can drop a whole summary (C5,
`server/src/data/resourceStore.ts:1288`).

### Second-audit findings

| ID  | Disposition                                 | What remains                                                     |
| --- | ------------------------------------------- | ---------------------------------------------------------------- |
| B1  | partly resolved                             | Two delivery paths (C5).                                         |
| B2  | resolved (memory); translation as stated    | A new model call can start while trashed (C6).                   |
| B3  | partly resolved                             | The token after a confirmation (C3); a last-member branch (C7).  |
| B4  | resolved                                    |                                                                  |
| B5  | worse than stated; ordering partly resolved | Unsaved edits lost (C2); no receipt for a committed delete (C4). |
| B6  | partly resolved; stale reorder as stated    | The parent-cascade premise (C1).                                 |
| B7  | partly resolved                             | Compile-time callers, fixtures, overlaps (C8).                   |
| B8  | resolved                                    |                                                                  |

### P1

- **C1. D15, "the known chats belong to the parent whose deletion is queued before the replacement's creates, and its
  cascade removes them."** Likelihood: a remove and re-add under the same id before the save loop collects the
  deletion, or a failed parent delete followed by a re-import. The save loop emits a delete only for an absent id
  (`src/ts/storage/resourceSync.svelte.ts:2856`, `:2889`); `addPreparedCharacters` installs chats before inserting the
  parent and `replaceCharacterAt` installs for the incoming id (`src/ts/storage/characterStore.svelte.ts:253`, `:345`);
  the recreation tests show a parent update with explicit chat deletes
  (`src/ts/storage/tests/resourceSyncRecreation.test.ts:234`, `:378`). Without those deletes, old rows stay under the
  surviving parent while the mirror dropped them (`src/ts/storage/chatStore.svelte.ts:5415`), and the replacement-only
  order fails the permutation check (`server/src/data/chatStore.ts:3481`). An acknowledged or committed in-flight
  deletion works (`src/ts/storage/chatStore.svelte.ts:5736`). The plugin reconcile's nonmember branch can also recreate
  a chat that disappeared during an await (`:4889`, `:4910`). Correction: wait for an explicit parent deletion's
  acknowledgement before creating the replacement's chats; when the parent survives as an update, reconcile against its
  authoritative chats, keeping omitted rows, marks, and slots; tell a new plugin chat from a captured id that vanished.
- **C2. Limitations, "a chat the user meant to delete, so only its drafts are lost."** Likelihood: an earlier-build tab
  edits or renames a chat and deletes it before the save is collected. `deleteChat` replaces the pending entry with the
  delete and drops its ordinary ops (`src/ts/storage/chatStore.svelte.ts:3591`, `:3844`, `:3996`); on `useTrash` the
  conflict path sees the server's last saved chat (`:6603`). Correction: the Limitation says a refusal keeps the last
  committed chat and an earlier-build delete can also discard its unsaved message and metadata edits; boot replay's
  draft cleanup stays a separate consequence (`:4951`).
- **C3. D12, "each captures the held revision token when the user acts, runs `prepare`, and sends it"; slice 5, "each
  call it only after one Yes."** Likelihood: another tab restores and re-trashes the chat while the confirmation is
  open or while Empty trash works through earlier rows; a quick New Chat then Trash reaches the missing-token case. The
  handlers capture the ref before `await alertConfirm` (`src/lib/SideBars/SideChatList.svelte:616`,
  `src/lib/Others/ChatList.svelte:91`), so a token looked up afterwards authorizes the current trash period, and a new
  chat has no token until its create is acknowledged (`src/ts/storage/chatStore.svelte.ts:3556`, `:3388`). Correction:
  capture the targets and tokens before the confirmation, freeze Empty trash's list and count then, and pass them
  through; an unsaved chat reports that it is still saving.
- **C4. D5, "a retry of a delete that committed before the upgrade gets its success."** Likelihood: a legacy delete
  commits, its answer is lost, and the tab retries after the upgrade. A delete removes the chat, its `chatGroups`
  receipts cascade, and `applyGroup` does not remember a delete (`server/src/data/chatStore.ts:143`, `:2262`, `:2404`,
  `:3000`), so there is no receipt to answer. The client already settles a delete conflict whose read finds the chat
  absent (`src/ts/storage/chatStore.svelte.ts:6554`). Correction: keep remembered and expired precedence for groups on a
  surviving incarnation; test a remembered edit after trash, an expired retry, and a committed legacy delete settled by
  its missing-row read, with a same-id replacement surviving it.

### P2

- **C5. D2, "A trash or restore always publishes its summary"; D3, "Any delivery ... installs it."** Likelihood: a large
  summary (a chat name has no summary-size bound) exhausting the publication budget; a plugin's cold read beating the
  trash echo. The 256 KiB publication budget can drop the whole summary, coalescing rebuilds the entry from selected
  fields, and the tab's feed adapter and reconnect listing forward selected fields (`shared/resources.ts:572`,
  `server/src/data/chats.ts:48`, `server/src/data/resourceStore.ts:466`, `:1297`,
  `src/ts/storage/resourceSync.svelte.ts:4972`, `:5014`). Cold plugin pages read through `readChatRefsDetached`, which
  keeps `{ revision, data }` only (`src/ts/storage/chatEdits.ts:114`, `src/ts/plugins/apiV3/v3.svelte.ts:1591`, `:1766`,
  `:1875`, `:3148`). Correction: the mark is a scalar of the live chat ref, kept through coalescing and independent of
  body, manifest, and summary; the server offers the summary subject to budget; a revision-only notice without the mark
  is compared with the member's mark revision to decide a readback; detached by-ref reads carry the mark, and plugin
  copies re-check active membership before they are returned or cached.
- **C6. D7, "`POST /api/translate/message` refuse[s] it at admission."** Likelihood: a message edited during a slow
  translation, translated again, then the chat trashed before the first call ends. A joining request with a new source
  hash calls `translate(request)` again inside the runner, past the route (`server/src/routes/translate.ts:81`,
  `server/src/translation/runner.ts:455`, `:485`, `:551`). Correction: the mark check at the runner's common entry,
  before joining or starting work; `server/src/translation/runner.ts` in slice 2.

### P3

- **C7. D12, `removeRemoteChat` "(the remote deletion path: held revision, locks, order, selection,
  `notifyRemoval`)".** For the only locally held member it marks the id absent, notifies, and returns with the member
  and revision held (`src/ts/storage/chatStore.svelte.ts:7193`, `:1295`, `src/ts/storage/resourceSync.svelte.ts:4996`).
  Correction: describe that branch, request the authoritative collection when it is taken, and settle and notify once
  for the deleted incarnation in either arrival order.
- **C8. Slice 1, "`shared/chats.ts`: ... the feed field ...; `shared/resources.ts`: the new conflict reasons."** The two
  are reversed: the feed entry is `ChangeSet.chats` in `shared/resources.ts:614`, the reasons are `ChatConflict` in
  `shared/chats.ts:243`. A required `ChatRecord.trashedAt` reaches `src/ts/network/jobChannel.ts:789`,
  `src/ts/storage/tests/installFlatDatabase.ts:130`, and about fifteen client test fixtures; real-delete wire ops appear
  in `server/src/tests/chatSummaries.test.ts:750`, `chatResult.test.ts:437`, `chatMetadataCoalescing.test.ts:494`,
  `commandExecutor.test.ts:290`, `commandSequences.test.ts:761`, `jobMetadataScope.test.ts:153`,
  `memoryTasks.test.ts:1108`, `messageSearch.test.ts:419`, and `src/ts/storage/tests/chatLazyLoading.test.ts:542`; the
  restore worker test inserts six positional chat values (`server/src/tests/restoreWorker.test.ts:49`). Correction:
  required-field adaptations and real-delete setup in slice 1; record the 1/2 and 1/4 overlaps; assign C1, C5, and C6's
  files to their slices.
- **C9. D14, "D4's `lastActiveChat` and D10's install repair keep at least one active chat per character."** An empty
  chat order is valid, and boot's `ensureChat` creates the first chat (`server/src/data/chatStore.ts:3933`,
  `src/ts/storage/chatStore.svelte.ts:5119`). Correction: D10 restores one chat of a nonempty all-trashed collection;
  an empty one is boot's.
- **C10. Current State, "The invalidation hook cancels the chat's memory tasks and marks its rebuild
  `sourceReplaced`."** A physical delete cascades the rebuild row first, so nothing is marked; `sourceReplaced` is what
  a whole-chat replace does to a surviving rebuild (`server/src/data/chatStore.ts:257`,
  `server/src/data/resourceStore.ts:1165`, `server/src/data/memoryStore.ts:917`). Correction: restate both.
