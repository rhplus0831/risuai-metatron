# Data-loss static audit under concurrency (2026-10-18)

Audited commit: `5e7595689` on `metatron`. Static only: no dev server was run; a few server-side
claims were reproduced with throwaway probes against `createResourceStore` in a temp directory.
Nothing in the repository was changed by the audit.

Question asked: where can a user-made or model-made change that the UI already treats as saved
end up absent from the server database, be overwritten by an older copy without notice, or be
deleted when it should not be, under concurrent tabs, concurrent chats, or a job writing while
a tab edits.

## Method

Four tracks, each audited independently by one Claude Opus agent and one GPT Sol agent from
the same brief, then every finding challenged by the other model (Opus findings by Sol, Sol
findings by Opus). The raw reports and challenges (16 files, about 420 KB) are at
`/home/codex/metatron-report-concurrency/`, next to the earlier audit reports.

| Track | Scope                                                                                           | Auditors  | Challenged by |
| ----- | ----------------------------------------------------------------------------------------------- | --------- | ------------- |
| T1    | Server resource store, batch transaction, feed, snapshot/restore/import, shutdown, asset writes | Opus, Sol | Sol, Opus     |
| T2    | Client save adapter, records mirror, live updates, 409 recovery, unload                         | Opus, Sol | Sol, Opus     |
| T3    | Chat module, job channel, server generation jobs, locks, reroll                                 | Opus, Sol | Sol, Opus     |
| T4    | Credentials, plugin storage, assets, inlays, folders, toggles, backups, imports                 | Opus, Sol | Sol, Opus     |

Independent agreement: four mechanisms were found by both models without seeing each other's
work (A1, A3 variant, B1, C1 below). Every finding listed under "Confirmed" was confirmed by the
challenger with its own line citations; severity is the orchestrator's call after reading both
sides and is noted where the two models disagreed.

Severity scale from the brief: critical = silent loss of acknowledged content in ordinary use;
high = silent loss in a plausible but less common interleaving, or loss with a misleading or
missing notice; medium = loss only under failure injection, or an inconsistency a reload repairs;
low = cosmetic or theoretical.

## Summary

The transactional core is sound. Every base revision, the epoch, the maintenance gate and the
generation lock are compared inside the same `BEGIN IMMEDIATE` as the write, with no await in
between; the change feed publishes after `COMMIT`; `node:sqlite` on Node 24 runs WAL with
`synchronous=FULL`, so a 200 or a feed ref implies a durable commit. Restore, import, the
snapshot timer and shutdown order their steps correctly. The client's dirty-mark lifecycle,
field-text caches, exact-base feed patches, reconnect deletion fences and hydration checks hold.

The losses are in the write semantics the store accepts and in the client's recovery paths:

1. **Whole-value writes applied on a stale revision** (A1, A2, A3): `setMessage`, `meta set`
   of `hypaV3Data` / `scriptstate` / `localLore` replace the stored value even when another
   writer changed it meanwhile, with `stale: true` as the only signal and no notice.
2. **Retry-after-generation replays a rejected edit over the finished reply** (A4).
3. **Recovery paths that discard without the promised notice** (B1, B2, B3): the character-list
   hydration path, the 10-second global notice latch and the single-slot alert store make the
   documented "discard with a notice" silent in several reachable cases.
4. **One deterministic single-tab loss**: reroll swipe-back restores the pre-edit reply (C1).

Counts after cross-verification: critical 1, high 10, medium 7, low 8, refuted/unreachable 3.

## Confirmed findings

### A. Stale or whole-value writes that overwrite another writer silently

**A1. A stale whole-message `setMessage` reverts text another tab already saved** — high
(Opus challenger: medium; Sol auditors and challenger: high).
Found independently by Sol T1, Sol T3 and Opus T1; reproduced against the store by both.

- Mechanism: `setMessage` needs only the chat incarnation, not the current revision
  (`server/src/data/chatStore.ts` `needsCurrent` ~373, admission ~768); the branch at ~931-950
  takes only `translation` from the stored row and writes the client's whole message. A tab
  whose copy of message M is stale (pending work blocks `canRefreshChat`, socket reconnecting,
  or simply inside the 500 ms debounce window) sends M whole and reverts the other tab's
  `setText`. Result is `stale: true`, so both tabs quietly re-base to the reverted text.
- Callers of the whole-message path (`replaceMessage`): the Disable toggle and Disable-above
  buttons in `src/lib/ChatScreens/Chat.svelte` (~1584, ~1605), the playground role swap
  (~1905), `applyChatResult`'s per-message merge (`src/ts/storage/chatStore.svelte.ts`
  ~2275-2291, which starts from the current mirror message), and through it the v3 plugin
  chat setters. Text edits, partial edits, `/comment` and stored-translation edits use
  `setText`/`setTranslation` and are safe in the reverse direction.
- Ordinary-use variant (Sol T1 challenge OQ4, confirmed high): when a job's final whole-chat
  hydration is refused because the chat has local work (an edit of an earlier message, a note),
  the reply is unlocked but the mirror still holds the raw streamed text. Pressing Disable on
  that reply before the idle refresh sends the streamed text over the processed final text.
- Tests: `server/src/tests/chatStore.test.ts:389` pins stale admission with whole replacement;
  nothing covers two writers on one message.
- Fix direction: add a field-patch message op (`{ id, set, unset }` merged on the stored row like
  `setText`) and use it for the toolbar toggles and `applyChatResult`; or require the current
  revision for a whole `setMessage`.

**A2. Memory data (`hypaV3Data`) is written whole by the job from its pre-await copy, and by
the HypaV3 modal from its mirror copy; each overwrites the other** — high (Opus auditors:
medium; both Sol challengers: high). Found by Opus T1 and Opus T3.

- Mechanism: `server/src/prompt/assemble.ts` ~1078-1101 reads `room.hypaV3Data`, awaits the
  summary provider (seconds to minutes), then `host.writeMemory(() => ({ hypaV3Data: data }))`.
  `writeChat` does refresh the chat first (slice 3a is intact), but the zero-argument builder
  ignores the refreshed chat and writes the stale value at the fresh revision. `meta set` is
  `Object.assign(current, op.set)` (`server/src/data/chatStore.ts` ~852-857); only `toolCalls`
  and `GLGlobalVariables` merge. The modal (`src/lib/Others/HypaV3Modal.svelte` ~74-90) writes
  the whole field through `setChatMeta` with no generation check, so the reverse also holds.
  `localLoreDraft` sends the whole `localLore` array the same way (reverse direction only; the
  Lua upsert builds from the refreshed chat).
- Tests: none interleave a manual summary edit with the summarization await.
- Fix direction: build the memory write from the refreshed stored value with a baseline-aware
  merge (summaries by id, explicit deletions), or refuse/recompute when the field changed since
  the algorithm's input; refuse modal writes while a job runs on that chat.

**A3. Client chat-variable writes send the whole `scriptstate` map and revert variables a job
or another tab set** — high (Opus: medium; Sol challenger: high). Found by Opus T3; the
server-side half of the same mechanism was found by Opus T1 (F3).

- Mechanism: `src/ts/parser/chatVar.svelte.ts` ~70-77 queues
  `meta set { scriptstate: { ...snapshot(chat.scriptstate), [key]: value } }`. The server's own
  setters were made key-level in slice 3a precisely so other tabs' variables survive
  (`server/src/jobs/jobScope.ts` ~421), but tab writers (`/setvar`, `/addvar`, plugin
  `risuChatParser` with `runVar`, client lore decorators) still replace the map, on a stale
  revision, with no conflict. `scriptstate` is not in `CHAT_META_MERGE_KEYS` (`shared/chats.ts`).
- Fix direction: send chat-variable writes as a key-level `merge` plus per-key unset.

**A4. An edit of the generating reply from a tab that does not hold the lock is refused with
"wait", requeued, and then applied over the finished reply** — high (both models). Found by
Opus T3; confirmed by Sol with the observer-tab trace.

- Mechanism: only the owner's job socket announces the lock (`serverGenerations`); the change
  feed carries rows and metadata but not streaming owners, so an observer tab shows the
  checkpoint text as editable. Its `setText`/`setMessage`/single `remove` gets a 409
  `reason: "generating"`, which `recoverChatConflicts` requeues and blocks for `JOB_RETRY_MS`
  (`src/ts/storage/chatStore.svelte.ts` ~3204-3208) with the "This chat is generating a reply.
  Wait until it finishes." notice. Pending work keeps the observer from taking job patches. After
  the final write releases the lock, the retry is a stale by-id op the server accepts
  (`server/src/data/chatStore.ts` ~768-772, ~914-973): the final reply is replaced by an edit of
  a partial checkpoint, or deleted. Reroll from the observer: `editChatSync` queues the removal,
  the send's flush throws `GenerationBlockedError` with no rollback, and the removal lands after
  the job with no replacement generation. The owner tab is exposed too when its follow ends as
  `lost` (locks released while the server job continues).
- Tests: `src/ts/storage/tests/resourceSyncHydration.test.ts:895` asserts the retry lands after
  `endJob`, with no final write in between, so it pins the hazard rather than guarding it.
- Fix direction: discard (and reload with the notice) a refused op whose target is the locked
  message itself, keeping retry-after-job only for chat-level ops and other messages; and
  publish generation ownership on the feed so observers lock the reply too.

### B. Recovery paths that discard without the promised notice

**B1. The character-list hydration path (`hydrateCharacters` → `acceptRemoteCollection` /
`acceptRemote`) settles or discards local work without a notice** — high. Four separate
reports describe the same path; the challengers confirmed all of them.

- The stage loop ignores the stage's `reloaded` result
  (`src/ts/storage/resourceSync.svelte.ts` ~1330-1331), and `acceptRemoteCollection`
  (`src/ts/storage/chatStore.svelte.ts` ~3780-3869) settles the current pending order and
  drops absent members' work without reporting a discard. Reachable consequences:
  - A reorder queued after a chat-create acknowledgement that listed another tab's new chat is
    settled unsent; the list snaps back (Sol T2 F1; Opus challenger: low, order only. The
    existing test `resourceSyncChats.test.ts:438` runs this sequence and does not assert the
    order).
  - Another tab permanently deletes character C while this tab has an unsent append in one of
    C's chats: the feed deletion applies (`canApplyRemote` checks only the record projection),
    `forgetCharacter` → `settleKey` settles the append, and `flushResources` resolves
    `{ discarded: [] }` (Opus T2 F3; Sol challenger: high).
  - Another device deletes chat X2 of character C while this tab generates in X1: the gone-chat
    branch does not set `reloaded`, hydration waits on X1's lock, X2 stays editable but
    unsendable, and the post-job stage discards everything silently (Opus T3 F5; Sol: high).
  - A 409 recovery that already ran `acceptRemote` then awaits `hydrateCharacters()`; if that
    read throws, `showReloadedNotice` is never reached and later cycles cannot recover the flag
    (Sol T2 F2; Opus challenger: medium).
- Fix direction: make `acceptRemoteCollection` and `acceptRemote` report their discards, honour
  the stage result, and route post-ack membership refreshes through the guarded
  `applyRemoteCollection` path that keeps a newer pending order.

**B2. The reload notice can be suppressed or replaced** — high (Opus: medium; Sol: high).
Found by Sol T3, Opus T2 and Sol T4.

- `showReloadedNotice` uses a tab-global 10 s `noticeShown` latch
  (`src/ts/storage/resourceSync.svelte.ts` ~1761-1770) not tied to acknowledgement, so a second
  discard episode within 10 s of a dismissed notice is silent; `reloadDeferredChats` calls it
  even when nothing was discarded (~2153) and consumes the window. `alertNormal`, `alertWait` and
  `alertError` share one store with no queue (`src/ts/alert.ts` ~63, ~165, ~242), so any later
  alert replaces the notice; `downloadArchive` (`src/ts/drive/backuplocal.ts` ~106-160) ignores
  `flushResources`' `discarded` list and its progress alerts then "Success" replace the notice
  of a discard that happened in the pre-backup flush.
- Fix direction: keep the latch until the alert is dismissed (or per episode on screen), give the
  reload notice its own store like the terminal notice, call the deferred-reload notice only
  when something was applied, and have backup export inspect `discarded`.

**B3. A `pluginStorage` conflict discards unrelated plugin keys and the plugin is never told**
— high (Opus: medium; Sol: high). Found by Opus T4.

- All v3 keys share `_pluginStorage` (and `_safeLocalPluginStorage`); `mergeConcurrentChange`
  accepts only characters and `statics` (`resourceSync.svelte.ts` ~1871-1874), so two tabs
  writing disjoint keys lose one tab's delta with the generic notice. `_setPluginStorage`
  resolves at queue time; no plugin-facing discard event exists. Existing test
  `src/ts/plugins/apiV3/v3SavedWrites.test.ts:175` pins the discard for a same-key edit.
- Fix direction: key-level merge of disjoint deltas on conflict, like `statics`; a persistence
  completion or discard event for plugins.

**B4. A module import that already showed "success" is discarded by any concurrent edit to a
different module** — high (Opus: medium; Sol: high). Found by Opus T4. Generalizes to any add
to an `itemIds` collection (presets, personas, credentials): the send path is item-level but the
409 path replaces the whole list (`resourceSyncPatches.test.ts:840` pins disjoint-item loss).

- Fix direction: on conflict, re-apply locally added items (ids in neither base nor remote) over
  the server list; delay the import success alert until the record is acknowledged.

**B5. A missing-target by-id op fails the whole chat group and the client discards every
queued op of that chat, including a newly appended message** — high (Opus: low; Sol
challenger: high; the lost content is a new message and the notice blames another writer).
Found by Opus T1.

- `setText`/`setMessage` on a message another tab removed conflicts (`server/src/data/chatStore.ts`
  ~914-920) while a single `remove` of a missing id is a no-op; the conflict entry carries no
  cause; `acceptRemoteChat` → `discardChatWork` drops the whole pending queue including work
  queued during the read-back (`chatStore.svelte.ts` ~3298-3314).
- Fix direction: report a missing target as a per-op `ignored` outcome (as `setTranslation`
  already does) so independent ops commit; keep a missing append anchor for explicit re-anchoring
  rather than dropping it.

### C. Single-tab loss

**C1. Reroll swipe-back restores the reply as it was when recorded, discarding a later edit of
it** — critical by the brief's definition (Opus: low; Sol challenger: critical; deterministic,
ordinary single-tab use, no concurrency needed). Found by Opus T3.

- `src/ts/process/rerollHistory.ts`: `begin` keeps the slot when the removed bundle's ids match
  (~48-54) without refreshing its content, and `move` swaps in the stored clone (~61-90). Edit
  R1 → R1′ (saved), reroll (R2), swipe back: R1 returns and R1′ is gone, persisted by
  `editChatSync`. Also: edit R2, swipe back, swipe forward. `Prereroll` candidates have the same
  shape.
- Fix direction: snapshot the current outgoing tail into the cursor's bundle before `begin`
  keeps a slot and before `move` swaps it away.

### D. Medium: failure injection or reload-repairable

**D1. Lost-response replay of ordinary chat ops** — medium (both models). Found independently by
Sol T1, Sol T3 and Opus T1. A failed batch requeues the same ops on the same base
(`resourceSync.svelte.ts` ~1375, `chatStore.svelte.ts` ~3120-3143) with no operation id: (a) a
replayed `setText`/`meta set` re-executes over another tab's later acknowledged edit (accepted,
`stale: true`, no notice); (b) `[append m, setText m]` is not coalesced, the replayed append
compares the whole stored row and conflicts, and recovery discards the newer work queued during
the flight with a notice that blames another writer; a multi-id `remove` or `replace` replay
conflicts the same way. Fix direction: stable group/op ids recorded with the chat row so a replay
answers its earlier result; send newer work separately.

**D2. Lost-response on resource records** — medium (both). Found by Opus T2. After a lost answer
nothing remembers the in-doubt text: a revert to the saved value sends nothing and the feed echo
re-applies the lost write silently; continued typing in the same field 409s and is discarded
under the "another tab" notice. Fix direction: keep the sent text as in-doubt per key and
recognise it in recovery.

**D3. Same-id re-add after a failed or blocked character delete leaves the replacement's chats
unsent while flush reports success** — medium (Opus: medium; Sol: partially confirmed, medium).
Found by Opus T2. `forgetCharacter` runs when the delete is collected, not acknowledged
(`resourceSync.svelte.ts` ~1173-1183); a later same-id add finds no held revisions and queues
nothing; `isCharacterKnown` then skips the chats. Reachable through plugin/MCP `setDatabase` and
the Playground character (`§playground`, recreated under a fixed id). Later edits of the
replacement chats do warn on unload and fail flush. Fix direction: forget chat state on the
delete's acknowledgement, or hydrate the id when a delete is requeued/refused and the id is
present again.

**D4. An older chat read or remembered job copy replaces the mirror after a stale-acknowledged
edit and clears the stale mark** — medium (Opus challenger: low, the feed echo usually repairs;
Sol: medium). Found by Sol T3 and Opus T3 (same mechanism). `refreshStaleChat` reads outside the
single-flight cycle, a stale ack keeps the held base, so the older answer passes the post-await
checks; the barrier's remembered `hydrateAll` copy does the same under an active lock. Server
data is intact; the mirror is wrong until a notice. Fix direction: track the highest acknowledged
revision separately from the baseline and refuse older copies.

**D5. A character created while another tab writes `characterOrder` drops out of the sidebar
until the next `checkCharOrder`** — medium (reload repairs). Found by Opus T4. Nothing calls
`checkCharOrder` after a conflict reload or a remote replacement of the order. Fix direction:
run it after those.

**D6. Dangling `folderId` hides a chat from the sidebar across reloads and breaks drag-reorder
for that character** — medium (Opus challenger: medium; Sol: high; content is not lost and the
chat is reachable from pinned rows and the opt-in menu chat list). Found independently by Sol T4
and Opus T4. Two-tab move/delete race (different records, no 409), or single-tab: branch-with-
folder or chat import where the character part 409s and the chat `folderId` is requeued
(`chatStore.svelte.ts` ~3211-3213). `SideChatList.svelte` renders only matching-folder or
`folderId == null` chats; nothing on boot clears a dangling id, so `persistence.md:277` ("until a
reload") understates it. `reorderChats` throws "needs a permutation" for the hidden row. Fix
direction: render a chat whose folder does not exist as unfiled, and clear member `folderId`s on
the server in the folder-delete transaction.

**D7. A deferred chat (owner tab) keeps accepting edits for the rest of the job and discards
them all at the end** — low, documented behaviour with a notice (Sol challenger refuted it as a
new finding). Listed for the plan's UX note only.

### E. Low

- **E1.** A slash command (`/trigger`, `/speak`, `/multisend`, modal commands) returns after an
  await and `sendMain` then clears the live composer; a chain ending in an unknown command sends
  the current composer (possibly another chat's draft) to the captured chat
  (`DefaultChatScreen.svelte` ~248-293). Unsent draft only; the shared composer is a recorded
  leftover. (Sol T3; Opus: low.)
- **E2.** Deleting a record the server already deleted (lost answer, or two tabs pruning the same
  trash) shows a spurious reload notice and reports a discard. (Opus T2.)
- **E3.** A `llmSecrets` sibling edit is discarded on a 409 caused only by another tab's
  credential put; the batch-conflict path does not apply the sibling-by-text rule. (Opus T4.)
- **E4.** A credential key queued for an owner whose create a conflict discarded is still written
  and stays as an ownerless secret. (Opus T4; Sol: retention defect, not loss.)
- **E5.** `checkCharOrder` strips a not-yet-inserted character out of its folder when a tab
  applies the remote order before the character (capped reads). (Opus T4; theoretical.)
- **E6.** Auto mode follows the selection into another chat of the same character. (Opus T3;
  Sol: partially confirmed, no "says nothing" append.)
- **E7.** Folder delete uses the `#each` index after its confirm await; a concurrent folder
  `unshift` from another tab makes it delete the wrong folder (visible). (Opus challenge of S-H.)
- **E8.** Assets: no fsync before rename, and the module/CharX/backup imports skip an existing
  content-addressed name without checking size or hash, so a file damaged by a crash is never
  repaired. (Opus T1; Sol: undetermined for the crash outcome, confirmed for the skip.) Mostly a
  sharper statement of the documented hazard.

### Refuted or practically unreachable

- Archive import keeping destination bytes for a same-key different-bytes collision (Sol T4 F3):
  every in-app write path is content-addressed, no caller passes `customId`, pre-v2 archives are
  refused; only an external `/api/write` caller or hand-placed files can create the pair. The
  pinning test `backups.test.ts:644` asserts the current behaviour on purpose.
- `customId` assets being last-writer-wins (Opus T1 OQ3): no production caller.
- A requeued `append` being merged with a later `setText` (Opus T2 OQ1): the payloads stay
  separate.

## Checked and found safe (both models, guards cited in the raw reports)

- Server: all base-revision, epoch, maintenance and lock checks inside `BEGIN IMMEDIATE` with no
  await; feed refs published after `COMMIT` and never for a rolled-back write; `synchronous=FULL`
  on the shipped `node:sqlite`; `transaction()`'s AsyncLocalStorage fence; snapshot timer write
  count captured before `backupTo`; `withMaintenance` ordering and the double epoch check;
  shutdown tracking resource handlers before auth/body and closing the store last; chat delete
  vs append, reorders as permutations, append anchors, stale `begin`, translation hash guard;
  asset stage-and-rename atomic replacement; `/api/remove` has no client caller.
- Client adapter: dirty generation compare and `sendingKeys`; character/module field-text stamps;
  lost-answer recognition cannot mistake a different value; `benignChanges` scope; exact-base
  remote patches and out-of-order feeds; reconnect deletions confirmed by a read under a
  revision fence; `applyHydration` synchronous compare-and-apply; split ordering
  character-before-chat and requeue on failure; keepalive single dispatch and idempotent replay;
  boot writes on the boot-read revision; credential ordering, bounded 409 retries, cleanup vs
  restored owner, unload warning for queued credential ops.
- Chat/jobs: `hydrateChat` and `hydrateChatPatch` eligibility checked synchronously;
  `patchedTail` validation; stale re-base recheck covers every queued kind including unloaded
  `setChatMeta` and translations; `replace` needs the current revision; `applyChatResult` and
  `applyTriggerChat` diffs; job writes re-read and write synchronously; locks released at
  `finalize` under the 5 s abort deadline; metadata coalescing flushed before message groups;
  v4 message ids and append collision refusal; GEN-01/JOB-01 fixes present; `sendChat` captures
  its target before any await.
- Peripheral: asset written before any record references it, bulk saves fail whole; inlay ids
  are fresh v4 and same-id writers are content-equivalent; toggle values live in the chat, a
  dangling `togglePresetId` never reverts them; chat order repaired by `orderRecords`; per-chat
  bindings fail closed; browser-local import verifies the server copy before deleting; IO-04 fix
  present; restore halts every tab through the epoch; server imports leave only content-
  addressed orphans on a closed tab.

## Documentation corrections found on the way

- `docs/structure/persistence.md:277`: a folder inconsistency does not end "until a reload" (D6).
- `docs/structure/persistence.md` Save step 9 and the `applyHydration` doc comment claim a
  "deferred or generating" character guard that the code no longer has (slice 3c removed the
  tab-side deferral; `resourceSyncLive.test.ts:911` pins the new contract).
- `docs/structure/self-host-server.md:460` says asset writes are not retried; `assetClient.ts`
  retries network failures and 429/503 up to eight times.
- `docs/structure/chat-pipeline.md:177`: plugin chat setters diff against the chat at call time,
  not at read time.

## Suggested fix order

1. Field-level message and metadata ops (A1, A2, A3; also closes the OQ4 variant and halves D1).
2. Generation-refused ops targeting the locked message: discard-and-reload, plus lock ownership
   on the feed (A4).
3. Reroll history content refresh (C1): small, single file.
4. Notice reliability: dedicated store, latch until dismissed, stage results honoured, discards
   reported by `acceptRemoteCollection` (B1, B2); backup export inspects `discarded`.
5. Key-level merge for `pluginStorage` and item-level rebase for collection adds (B3, B4).
6. Per-op missing-target outcomes (B5), group idempotency ids (D1), in-doubt text on lost
   responses (D2), `forgetCharacter` on acknowledgement (D3), acknowledged-revision floor (D4).
7. Reader defaults for dangling `folderId` and `checkCharOrder` after order replacement (D5, D6).
