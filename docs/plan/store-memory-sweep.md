# Chat Store and Structured Memory Sweep Plan

Status: drafted 2026-11-06; the owner accepted every open question's recommendation the same day; landed: A1 (54ee880aa), A3 (ff3164f85), A4 (844dab99f), A5 (043c75e2f), B1 (73b930395). Source: the 25 entries
of the [found-issues](../research/found-issues.md) sections "Chat store, sync, and change feeds" (10) and
"Structured Memory" (15) as of `8cc6d3093`, each sub-item re-checked against that tree the same day by ten
read-only workers; the file and line evidence behind every slice and every "gone" verdict was spot-checked
by the session. Every entry has a disposition in the **Index**: a slice here, an **Open question** for the
owner, **Deferred** work for a later plan, **Recorded** (the owning guide's Known Hazards already states it,
so it leaves the inbox), **Gone** (fixed by later work), or **Stays**. Line numbers below are from that
check; identifiers are the anchors. Re-verify each cited location before editing (STRUCTURE.md protocol
step 5).

Selection rules, in the order they were applied (the same as the Found Issues Sweep's):

1. A confirmed defect a user, a plugin author or a later caller can meet, whose fix is local to one file
   cluster and has a test: a slice.
2. A stale comment, a brittle test or a test helper that passes by luck: a slice, grouped with the nearest
   code slice or into a hygiene slice.
3. A fix whose direction the owner has not chosen: an **Open question** with a recommendation; the slice that
   carries it names the question that gates it.
4. Work that needs a design or a real-model measurement: **Deferred**, grouped the way a later plan should
   pick it up.
5. An item the owning guide's Known Hazards already records: **Recorded**; it leaves the inbox in C1 without a
   code change. Accepted trade-offs and latent paths with no producer that no guide records: **Stays**.

One slice is one session, one commit, one file cluster. Each slice names its owning guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Every slice updates the owning guide's
`Flows`, `Invariants`, or `Known Hazards` where it changes a documented contract and removes the matching
hazard entry when it fixes one. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_; routine slices name no Codex challenger. Each slice ends with its regression test
(under _Test_), `pnpm check`, `pnpm --silent test:agent` for the files it touches and then once whole, the
guide's focused checks, and `pnpm format:check`. A slice does not edit `found-issues.md`: the entries or
sub-items it closes (under _Removes_) are deleted, with the section counts in that file's Contents list, in
the landing commit that marks the slice landed here, so parallel slices never conflict on the inbox. An
entry split across slices is narrowed by each landing and deleted by the last one. An entry a slice finds
already fixed is removed the same way with a note in the commit message.

## Open questions

The owner accepted every recommendation on 2026-11-06. Each gated slice carries the accepted answer only;
no slice waits on a question.

| Q   | Question                                                                                                                                                                                                                                                                                                                                                        | Accepted answer                                                                                                                                                                                                                                                                             | Gates |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Q1  | After `haltForRestore`, should server-backed detached reads (plugin `getDatabase`/`getChats` through `withDetachedDatabaseChats`, exports through `readChatsDetached`) refuse, as `flushResources` would with an admission check? Today a flush with nothing pending resolves and an old-epoch answer can land through `readWithDeadline`'s private controller. | Refuse: `assertSaveAdmission()` after `flushResources`' first `tick()`, and before and after each detached read; the `catch` fallback to loaded state must rethrow the restore refusal. Do not gate `readRefs` itself (boot and live updates use it).                                       | A1    |
| Q2  | Does an exhausted `"lost"` follow (server out of reach) prove the generation ended? `followJobToEnd` retires its ids through `releaseGenerationJob`, so a same-page retake of the reopened offer shows no stream.                                                                                                                                               | No: route `"lost"` through `detachGenerationJob` and keep its reporting and recovery read; `"gone"` (unknown job or epoch mismatch) keeps retiring.                                                                                                                                         | A2    |
| Q3  | When a foreign Stop mark outlives a lockless job, how often should the tab ask `/current`?                                                                                                                                                                                                                                                                      | Once when the marked chat becomes visible and once when the page comes back online, clearing by the expected job id; never a poll; a failed read keeps the mark.                                                                                                                            | A3    |
| Q4  | Checkpoint cleanup on append: (a) may a comment keep a checkpoint, and (b) should an insertion before the reroll carrier (`anchor: { start: true }`) keep the carrier's checkpoint and candidates' `scriptstateAfter`?                                                                                                                                          | (a) No: only the newest non-comment reply keeps one (`shared/database.ts` ~1347 says so), enforced in `applyGroup` whatever the coalescing. (b) Yes: the carrier stays selectable, so its variables must follow; the cleanup clears only rows before the carrier, not before the insertion. | A4    |
| Q5  | How should a feed row text diff prove its base? Today only `keep <= held.data.length` is checked.                                                                                                                                                                                                                                                               | A 53-bit hash of the base text (the `translationSourceHash` shape, moved to a shared helper) plus its length in `ChatRowDiff.text`; a mismatch is a `mismatch` that falls into the fenced read. A cryptographic digest is not needed: a wrong base is a bug, not an attacker.               | A5    |
| Q6  | Should the client apply a validated `pluginStorage` entry patch in place, instead of reparsing and re-projecting the whole record?                                                                                                                                                                                                                              | Yes, only for a validated `nested`/`itemKey` entry patch on `pluginStorage`, keeping held text cut by entry; malformed, reordered and top-level patches keep the whole-record path.                                                                                                         | A6    |
| Q7  | A plugin's `setDatabase`/`setDatabaseLite` resolves its target preset after the consent wait, so a selection repaired meanwhile redirects the write. Capture the targets at call start?                                                                                                                                                                         | Yes: capture the preset and model-preset ids at call start, write to them, and refuse if the record is gone. This reverses `v3SetDatabase.test.ts` ~158–180, which expects a selection change during consent to win.                                                                        | A7    |
| Q8  | Record now in a job: publish the run as a memory task with its fence (as the queued path does), or add a separate job fence? And what does the terminal say?                                                                                                                                                                                                    | Reuse the `memoryTask` status and `memoryTaskFenced` fence; the command result carries `memoryRecord: "completed" \| "queued"` so the toast says which happened; a `skipped` reason becomes an error code with an `en.ts` string, not English with a raw code.                              | B1    |
| Q9  | Where does the memory receipt line go in the `mobilechat` and `cardboard` themes, which render no `genInfo`?                                                                                                                                                                                                                                                    | A receipt-only snippet in each theme's message footer; those themes keep omitting the model and translation controls.                                                                                                                                                                       | B3    |
| Q10 | `castSlice` matches a title or alias as a raw substring; retrieval uses `searchMatch` with `fullWordMatching: false`. Align them now, or wait for a word-boundary rule?                                                                                                                                                                                         | Align now: `castSlice` calls the same matcher with retrieval's options, so writer and reader agree on "named". The word-boundary rule (alias `Al` in "also") stays Deferred for both paths.                                                                                                 | B4    |
| Q11 | Should a chat's highlight mode be part of the Structured Memory writer fingerprint? Today a mode change ends a queued writer input as `staleInput`.                                                                                                                                                                                                             | No: `highlightRule` only marks committed history and does not change the model prompt, so drop `chatHighlight` from `structuredMemoryFingerprint`.                                                                                                                                          | B5    |
| Q12 | After a rebuild, an imported thread's `who` can name a page id the rebuild removed. Keep referenced page ids through the seed, or remap at the swap?                                                                                                                                                                                                            | Keep them: a page any retained thread's `who` names is seeded with its id; no title-based remapping, since ids are the stored reference.                                                                                                                                                    | B6    |
| Q13 | Should the memory health badge skip group chats?                                                                                                                                                                                                                                                                                                                | No: the writer serves group chats (`writer.ts` handles group speakers, `recordJob.ts` admits them), so their health is real; the inbox item closes as a misreading.                                                                                                                         | B7    |
| Q14 | Health reads: what does the byte budget charge, and what does a single over-budget chat answer? The contents route calls `readHealth` with no budget, and a round always answers its first chat.                                                                                                                                                                | Charge stored event and run bytes as well as page bytes; give the contents route the round budget; a chat over the per-chat cap answers `unavailable` (a new health state the badge shows as unknown) instead of being read whole.                                                          | B8    |
| Q15 | When the final token recheck in `assemble.ts` drops history after scripts and `editRequest`, should Structured Memory select evidence again or only report the loss?                                                                                                                                                                                            | Report it: count the late removals into `gapTokens` and the coverage report. A second selection pass would rerun user hooks.                                                                                                                                                                | B9    |
| Q16 | Journal recovery replays a real `hypaV3Data` into a chat while Structured Memory owns the field; `keepsHeldHypaV3Data` refuses it with the plugin-worded notice and the durable row can then be removed. What should recovery do?                                                                                                                               | Never drop durable intent silently: recovery skips that field, keeps the row's other ops, and files the refused value as a recovery draft with a recovery-worded notice.                                                                                                                    | B11   |

## Index

Every entry of the two sections, by its heading in `found-issues.md`, with its disposition. Sub-items are
listed where they part ways.

| Section                            | Entry (sub-item)                                                                   | Disposition                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Chat store, sync, and change feeds | Parked resends leak                                                                | Stays (accepted, A3 of Open Bug Fixes; see Deferred)          |
|                                    | Store subscriber throw queue                                                       | Stays (latent; Svelte's shared queue, see Deferred)           |
|                                    | Phase 6 review leftovers (Vitest module-effect race)                               | Recorded (`app-shell.md`, `characters-modules.md`): C1        |
|                                    | Phase 6 review leftovers (preset reorder criterion)                                | Recorded (`settings-i18n.md`): C1                             |
|                                    | Phase 6 review leftovers (facade `chats` fresh array)                              | Recorded (`chat-store.md`): C1                                |
|                                    | Phase 6 review leftovers (resources route message omits `chatSummaryCollections`)  | A8                                                            |
|                                    | Phase 6 review leftovers (async plugin setters after selection repair)             | A7 (Q7)                                                       |
|                                    | Phase 6 review leftovers (own-save echo summary read; idle read before trim)       | Stays (perf, narrowed in C1; see Deferred)                    |
|                                    | Phase 6 review leftovers (`installRead`/`adoptChatRead` revisions)                 | Recorded (`chat-store.md`): C1                                |
|                                    | Phase 6 review leftovers (store-backed harness boots `{ chats: true }`)            | Recorded (`resource-sync.md` Tests): C1                       |
|                                    | Phase 6 review leftovers (three untested credential sends; M16 stale module)       | Gone: C1                                                      |
|                                    | Phase 6 review leftovers (`Plugin Error from` names the wrong provider)            | A8                                                            |
|                                    | A retaken handoff job drops its live stream                                        | A2 (Q2)                                                       |
|                                    | pluginStorage writes still reach other tabs whole                                  | A6 (Q6)                                                       |
|                                    | flushResources resolves after a restore halt                                       | A1 (Q1)                                                       |
|                                    | Append checkpoint cleanup depends on coalescing and group order                    | A4 (Q4)                                                       |
|                                    | Feed row text diffs check the held length, not the prefix                          | A5 (Q5)                                                       |
|                                    | A foreign Stop mark lingers for lockless jobs                                      | A3 (Q3)                                                       |
|                                    | An insertion before the reroll carrier drops its variable snapshots                | A4 (Q4)                                                       |
| Structured Memory                  | Record now in a job is seen by one tab                                             | B1 (Q8)                                                       |
|                                    | Receipt on a message with no generation info                                       | B3 (Q9)                                                       |
|                                    | Panel writer line and stale views (writer line before the first send)              | B1                                                            |
|                                    | Panel writer line and stale views (checkpoint load, copied receipts, reset answer) | B2                                                            |
|                                    | Cast slice matches substrings                                                      | B4 (Q10); word boundary Deferred                              |
|                                    | Projection refresh leftovers (journal recovery drops `hypaV3Data`)                 | B11 (Q16)                                                     |
|                                    | Projection refresh leftovers (body-cap comment; regex-read constants)              | B12                                                           |
|                                    | Projection refresh leftovers (`chatOutput` payload)                                | Recorded (`structured-memory/projection.md`): C1              |
|                                    | Adopted summaries                                                                  | Recorded (`structured-memory/lifecycle.md`): C1; see Deferred |
|                                    | Highlight and revert leftovers (new page receipt highlight)                        | B3                                                            |
|                                    | Highlight and revert leftovers (new page has no revert)                            | Recorded (`structured-memory/records.md`): C1                 |
|                                    | Highlight and revert leftovers (highlight mode in the fingerprint)                 | B5 (Q11)                                                      |
|                                    | Page tool leftovers (test helpers, `trashedAt` import, page tool tests)            | B4                                                            |
|                                    | Page tool leftovers (trash bound)                                                  | Recorded (`structured-memory/pages.md`): C1                   |
|                                    | Health badge leftovers (repeated walks)                                            | B7                                                            |
|                                    | Health badge leftovers (group chats)                                               | B7 (Q13: closes without a code change)                        |
|                                    | Health badge leftovers (contents read budget)                                      | B8 (Q14)                                                      |
|                                    | Evaluation findings (`readHealth` bounds)                                          | B8 (Q14)                                                      |
|                                    | Evaluation findings (`selectMemory` token counts)                                  | B10                                                           |
|                                    | Evaluation findings (`addText` quadratic scan)                                     | Gone: C1                                                      |
|                                    | Evaluation findings (overhead constant; checkpoint save hold; lanes; index reads)  | Deferred                                                      |
|                                    | The final token recheck drops history evidence never sees                          | B9 (Q15)                                                      |
|                                    | Thread provenance after a re-record or a repeat                                    | B5                                                            |
|                                    | Pre-version-2 run windows never confirm in a test run                              | B5                                                            |
|                                    | Rebuild drops retained imported threads' participants                              | B6 (Q12)                                                      |
|                                    | A delayed health answer overwrites a newer badge                                   | B7                                                            |

## Order

Every slice is independent of the others' code unless listed here; the shared files are guides and tests.

- **Shared source files.** A1 and A6 both edit `src/ts/storage/resourceSync.svelte.ts` (`flushResources`
  vs the patch fast path): A6 after A1. A4 and A5 both edit `server/src/data/chatStore.ts` (`applyGroup`'s
  append cleanup vs the row-diff encoder ~742) and `src/ts/storage/chatStore.svelte.ts`: A5 after A4. A3 and
  B7 both edit `src/ts/process/chatStatus.svelte.ts` and `chatStatus.test.ts`: B7 after A3. B1 and B2 both
  edit `StructuredMemoryPanel.svelte`: B2 after B1. B3 and B4 both edit
  `server/src/prompt/memory/structured/pages.ts` (`receiptPages` vs `castSlice`): B4 after B3. B4 and B8
  share `server/src/routes/structuredMemory.ts` only at file level (import vs contents): rebase.
- **Guides.** Most B slices edit `structured-memory/read.md`, `writer.md` or `lifecycle.md`, in different
  sections: rebase, and keep each guide under its byte ceiling (`pnpm check:docs`) by trimming in the same
  edit. C1 edits the Known Hazards of several guides and runs last.
- **Tests.** `server/src/tests/memoryJobs.test.ts` takes B1's and B5's integration cases: B5 after B1, or
  rebase.
- **Questions.** All answered 2026-11-06 with the recommendation (A1–A7: Q1–Q7, B1: Q8, B3: Q9, B4: Q10, B5:
  Q11, B6: Q12, B7: Q13, B8: Q14, B9: Q15, B11: Q16); no slice waits on one.
- **Sessions.** A1, A2, A3, A7, A8, B2, B3, B4, B5, B6, B7, B8, B9, B10, B12 are _small_; A4, A5, A6, B1,
  B11 are _hard_ (A4 for the checkpoint policy across client and server, A5 for the wire format, A6 for the
  sync fast path, B1 for the task protocol, B11 for recovery semantics); C1 is _small_ but wide. Three
  sessions at a time is the runner's default.

## Slices

### A. Chat store and sync

- **A1. A restore halt refuses flushes and detached reads** (_small_, `resource-sync.md` with
  `plugin-sandbox.md` and `chat-store.md`; Q1). `src/ts/storage/resourceSync.svelte.ts` `flushResources`
  (~5610): `assertSaveAdmission()` after the first `tick()`, so a halted tab refuses even with nothing
  pending. `src/ts/storage/chatEdits.ts` `readChatRefsDetached` (~85) and `readChatsDetached` (~131): check
  admission before the read and again after its answer, so an old-epoch answer is refused.
  `src/ts/plugins/apiV3/v3.svelte.ts` (~1363–1437, ~2403): the fallback to loaded state after a failed flush
  rethrows the restore refusal instead of answering from the held copy.
  _Done_: after `haltForRestore`, `flushResources()` rejects; a detached read in flight at the halt rejects
  when its answer arrives; plugin `getDatabase` and a chat export reject while the restore notice is open.
  _Test_: `src/ts/storage/tests/resourceSync.test.ts` (~875: the empty flush after a halt),
  `src/ts/plugins/apiV3/getDatabaseDetached.test.ts` (in-flight read across a halt),
  `src/ts/storage/tests/chatProjection.test.ts` (export path).
  _Removes_: flushResources resolves after a restore halt.

- **A2. A lost follow detaches instead of retiring** (_small_, `chat-pipeline.md` with `network-jobs.md`;
  Q2). `src/ts/process/serverCommands.ts` `followJobToEnd` (~433–443): for the string result `"lost"`, call
  `detachGenerationJob(jobId)` instead of `releaseGenerationJob`, keeping the `jobLink` event, the
  `followedJobs` removal and the recovery read (~458–475); `"gone"` keeps `releaseGenerationJob`. Update
  the function's contract comment.
  _Done_: a worker whose follow ended `"lost"` and that later takes the reopened offer for the same job in
  the same page shows the live stream; a `"gone"` follow still drops late chunks.
  _Test_: `src/ts/process/serverCommands.test.ts` (~427–445, lost vs gone),
  `src/ts/network/generationJobs.test.ts` (~1031–1170, the retake stream harness).
  _Removes_: A retaken handoff job drops its live stream.

- **A3. Foreign Stop marks reconcile for lockless jobs** (_small_, `chat-pipeline.md`; Q3).
  `src/ts/process/chatStatus.svelte.ts` `watchChatVisibility` (~287, lock effect ~311–319): when a chat with
  a `foreignJobs` mark and no feed lock becomes visible, or the page comes back online, read
  `readChatGeneration` once and clear the mark only if the answer is idle or names another job id; a failed
  read keeps the mark. Remove the Gotcha this fixes from `chat-pipeline.md` (~439–440).
  _Done_: a mark noted for a command job clears on the next visibility of its chat after the job ends; no
  request repeats while the chat stays visible.
  _Test_: `src/ts/process/chatStatus.test.ts` (~302–321), with the Stop button case in
  `src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts` (~259–360).
  _Removes_: A foreign Stop mark lingers for lockless jobs.

- **A4. Append checkpoint cleanup follows position, not grouping** (_hard_, `server-resources.md` with
  `chat-store.md` and `chat-pipeline.md`; Q4). `server/src/data/chatStore.ts` `applyGroup`'s `case "append"`
  (~2369–2431, the `selectCheckpointRows` loop ~2404): strip checkpoints from fresh comments, keep only the
  newest non-comment reply's, and clear only rows before the reroll carrier (`isRerollCarrier` in
  `shared/rerollCandidates.ts` ~288), so an insertion at `anchor: { start: true }` keeps the carrier's
  checkpoint and its candidates' `scriptstateAfter`. `src/ts/storage/chatStore.svelte.ts` `takeChatWork`:
  a later `setMessage` of a reply cleaned earlier in the same group drops the inherited snapshot fields
  before sending; `applyGroup` also refuses to restore them from a non-generation write, so a journal
  replay (`journalRecovery.ts` ~855) gets the same answer. State the rule in `server-resources.md` and the
  carrier's in `chat-pipeline.md`.
  _Done_: the same sends give the same retained checkpoints whether coalesced or not; after an insertion at
  the chat start, selecting another candidate on the last reply restores its variables; an append followed
  by an older reply's `setMessage` in one group leaves no stale snapshot.
  _Test_: `server/src/tests/chatStore.test.ts` (~3203, ~3797–3811), `src/ts/storage/tests/chatStore.test.ts`
  (~432–507, ~960–972); browser: `e2e/rerollCandidates.spec.ts` (~437–472) with an insertion step added.
  _Removes_: Append checkpoint cleanup depends on coalescing and group order; An insertion before the reroll
  carrier drops its variable snapshots.

- **A5. Feed row text diffs carry their base** (_hard_, `chat-store.md` with `live-update-feed.md`; Q5).
  Move `translationSourceHash`'s 53-bit hash (`shared/translation/hash.ts`) to a shared text-hash helper;
  `translationSourceHash` stays as a wrapper so translation cache keys do not change. `shared/resources.ts` `ChatRowDiff.text` (~464–481) gains the base's hash and
  length; `server/src/data/chatStore.ts` (~742–772) fills them from the prior text; `stagedRowDiffs` in
  `src/ts/storage/chatStore.svelte.ts` (~2900, text branch ~2946) compares them with `held.data` and returns
  a mismatch otherwise. A row diff without the field (an older server during an update) keeps today's
  check; record that in `live-update-feed.md`.
  _Done_: the probe in the entry (stored "A…", shown "B…", server appends "!") makes a fenced read and shows
  "A…!"; an ordinary streamed append still applies as a diff.
  _Test_: `src/ts/storage/tests/resourceSyncFeedPatches.test.ts` (~565–610, the wrong base),
  `server/src/tests/chatFeedPatches.test.ts` (~200–215, the encoded base),
  `src/ts/storage/tests/chatStore.test.ts` (~2500–2535, lifecycle kept).
  _Removes_: Feed row text diffs check the held length, not the prefix.

- **A6. pluginStorage entry patches apply by entry on the client** (_hard_, `resource-sync.md` with
  `live-updates.md` and `plugin-sandbox.md`; Q6). `src/ts/storage/resourceSync.svelte.ts`: for a validated
  `nested`/`itemKey: "name"` entry patch on `pluginStorage`, `canApplyRemote` (~5179) compares the touched
  entry's held span instead of `projectRecord`'s whole stringify; `patchedRecord` (~5102) splices the
  held text by entry instead of `JSON.parse`-ing it; `applyCollectionPatch` → `applyToMirror` (~4705) sets
  one entry through a raw nested helper in `src/ts/storage/records.svelte.ts` (no save queued); and
  `applyRemotePatch` (~5016) updates `persisted` by entry. Every other patch keeps the whole-record path.
  Measure before and after with a 2 MiB record (the Plugin Storage plan's probe) and record both numbers in
  the commit.
  _Done_: an observing tab applies a one-key counter write to a 2 MiB `pluginStorage` without a whole parse
  or stringify; a malformed, reordered or top-level patch still falls back.
  _Test_: `src/ts/storage/tests/resourceSyncFeedPatches.test.ts` (~271–333, with a spy on the whole
  projection), `src/ts/storage/tests/pluginStorageStore.test.ts` (~302–376).
  _Removes_: pluginStorage writes still reach other tabs whole.

- **A7. Plugin database setters keep their call-start targets** (_small_, `plugin-sandbox.md`; Q7).
  `src/ts/plugins/apiV3/v3.svelte.ts` `setPluginDatabase` (~2070) and `setPluginDatabaseLite` (~2055):
  capture the selected preset and model-preset ids before the consent wait and pass them through
  `applyPluginDatabaseWithChats` (~1994) to `updateSettings` (`src/ts/storage/collectionStore.svelte.ts`
  ~157); a captured record that is gone refuses the call. Hook calls keep their captured ids.
  _Done_: deleting the selected preset during a plugin's consent wait refuses the write instead of writing
  into the repaired selection.
  _Test_: `src/ts/plugins/apiV3/hostApiRouting.test.ts` (~599–613), and the consent case in
  `src/ts/plugins/apiV3/v3SetDatabase.test.ts` (~158–180) rewritten to the new rule.
  _Removes_: the async plugin setter item of Phase 6 review leftovers.

- **A8. Two error messages name the right things** (_small_, `llm-requests.md` with `server-resources.md`).
  `src/ts/process/request/request.ts` (~702–711, ~795) and `server/src/llm/request.ts` (~611–619, ~687):
  compute the V3 provider name from `pluginmodel:::<provider>` once, before the `try`, and use it in
  `Plugin Error from <provider>`. `server/src/routes/resources.ts` (~215–225): the non-array message also
  names `chatSummaryCollections`.
  _Done_: a failing V3 provider model's error names that provider on both sides; the route's message lists
  all four fields.
  _Test_: `src/ts/process/request/tests/requestPresetScope.test.ts`, `server/src/tests/llmRequests.test.ts`
  (~2206–2217: the exact provider instead of `.*`), `server/src/tests/resourcesChats.test.ts` (~204).
  _Removes_: the `Plugin Error from` and route-message items of Phase 6 review leftovers.

### B. Structured Memory

- **B1. Record now in a job is a memory task every tab sees** (_hard_, `structured-memory/writer.md` with
  `structured-memory/read.md` and `network-jobs.md`; Q8). `server/src/prompt/memory/structured/recordJob.ts`
  `recordInJob` (~199, ~292) opens a `memoryTask` status with `memoryTaskFenced` for the run, as the queued
  path does, and ends it with the revision the tabs hydrate to; a `skipped` window ends with a coded error
  (`shared/jobs.ts`, `src/lang/en.ts`) instead of `The recording stopped: <reason>`. `runMemoryRecord`
  (~358–370) returns `memoryRecord: "completed" | "queued"`, and `memoryRecordPress.ts` (~62–72) toasts
  "Recording finished" or "Recording queued". The writer line: the contents route returns the current
  `jobMemoryBlockingReason` for the chat's scope, and `memoryWriterNotice`
  (`src/ts/process/structuredMemory.svelte.ts` ~496) prefers it to the newest receipt, so the panel says
  "not recording automatically" before the first send; if the route cannot build that scope without
  reading the whole chat, the slice lands the rest and leaves this item in the inbox with what it found. Remove the hazard this fixes from `writer.md`
  (~347–350) and `read.md` (~309–311).
  _Done_: with a plugin memory model, Record now in tab A makes tab B's panel read-only until it ends; the
  toast says which path ran; a stale window shows a translated message; a new chat with a request trigger
  shows the blocked writer line.
  _Test_: `server/src/tests/memoryJobs.test.ts` (status, fence, coded skip, result kind),
  `src/lib/ChatScreens/MemoryReceiptLine.svelte.test.ts`, `src/ts/network/eventFeed.test.ts`,
  `src/lib/Others/StructuredMemory/StructuredMemoryPanel.test.ts`, `server/src/tests/structuredMemoryRoutes.test.ts`
  (the contents field).
  _Removes_: Record now in a job is seen by one tab; the writer-line item of Panel writer line and stale
  views.

- **B2. The panel follows checkpoint loads, copies and resets** (_small_, `structured-memory/read.md` with
  `lifecycle.md` and `projection.md`). `StructuredMemoryPanel.svelte`: bump its `refresh` when
  `chatInstallVersion(ref)` changes, so a checkpoint load rereads the contents; `pressReset` (~353) calls
  `readResetChat(ref)` after any successful answer, not only `reset: true`.
  `src/ts/process/chatMemoryInherit.svelte.ts` `createInheritingChat` (~75): strip `generationInfo.memory`
  from copied messages, since their runs stay behind (`structured/inherit.ts` ~200). Remove the copied
  receipt hazard from `lifecycle.md` (~347) and `read.md` (~371).
  _Done_: loading a checkpoint with the panel open shows the loaded records; a copied chat shows no Resume
  on an empty Log; a repeated reset rereads the chat.
  _Test_: `src/lib/Others/StructuredMemory/StructuredMemoryPanel.test.ts`,
  `src/ts/process/chatMemoryInherit.test.ts`, `src/ts/checkpoints/chatCheckpoints.test.ts`.
  _Removes_: Panel writer line and stale views (the remaining three items).

- **B3. Receipts render where they belong** (_small_, `structured-memory/read.md` with `ui-theming.md`;
  Q9). `src/lib/ChatScreens/Chat.svelte` (~1257): the model button needs `messageGenerationInfo?.model`;
  extract the receipt line from the `genInfo` snippet (~1280) and render it in the `mobilechat` and
  `cardboard` footers (~2271–2329). The new page's highlight: `receiptPages`
  (`server/src/prompt/memory/structured/pages.ts` ~610) keeps the page-level highlighted `create` entry and
  `receiptChanges` (`src/ts/process/structuredMemory.svelte.ts` ~341–357) shows it.
  _Done_: a receipt on a message with no model shows no "Unknown" button; both themes show the receipt
  line; a receipt that created a page highlights it.
  _Test_: `src/lib/ChatScreens/Chat.test.ts`, `src/lib/ChatScreens/MemoryReceiptLine.svelte.test.ts`
  (~213), `server/src/tests/memoryTasks.test.ts` (~2852).
  _Removes_: Receipt on a message with no generation info; the new-page highlight item of Highlight and
  revert leftovers.

- **B4. Page matching, package import and page tool tests** (_small_, `structured-memory/pages.md` with
  `writer.md`; Q10). `castSlice` (`pages.ts` ~217) uses the plain-key matcher from
  `shared/lore/activation.ts` with retrieval's options (`retrieve.ts` ~791), extracted if needed.
  `importPackage.ts` `admitted` (~272–289) strips `trashedAt` from every imported page.
  `src/ts/process/structuredMemory.test.ts`: replace `splitPage`/`splitTimeline` (~182–218) with
  `parseMemoryPackage`, adding collapsed-heading and key-line cases; add page tool cases to `pages.test.ts`.
  _Done_: the writer and the read path name the same pages for a window; a hand-edited package cannot import
  a trashed live page; the page tools have unit tests.
  _Test_: `server/src/prompt/memory/structured/pages.test.ts`,
  `server/src/prompt/memory/structured/importPackage.test.ts`, `src/ts/process/structuredMemory.test.ts`.
  _Removes_: Cast slice matches substrings (narrowed to the Deferred word-boundary rule, which moves to
  `read.md` Known Hazards); Page tool leftovers (the trash bound is Recorded).

- **B5. Writer replay and thread provenance** (_small_, `structured-memory/writer.md` with
  `lifecycle.md` and `read.md`; Q11). `window.ts` `windowStillConfirmed` (~403):
  `messageSourceHash(message, source.hash)`. `reconcile.ts` `retireRerecorded` (~262): re-point thread
  `openedBy`/`closedBy` from the retired event to its replacement, and correct `lifecycle.md`'s flow
  (~88–91). `analysis.ts` `admitAnalysis`'s repeat branch (~593–635): append the admitted `openThreads`
  moves and `transitions` to the repeated event. `server/src/jobs/jobScope.ts`
  `structuredMemoryFingerprint` (~431): drop `chatHighlight`.
  _Done_: a prompt test run on a chat whose newest run predates source-hash version 2 previews that run's
  window; retracting a replacement event reconciles the threads it inherited; retracting a repeated event
  undoes its thread moves; a highlight mode change leaves a queued writer input valid.
  _Test_: `server/src/prompt/memory/structured/window.test.ts`, `reconcile.test.ts`, `analysis.test.ts`,
  `server/src/tests/memoryTaskHost.test.ts` (~464–578), `server/src/tests/memoryJobs.test.ts` (~3835–3991).
  _Removes_: Pre-version-2 run windows never confirm in a test run; Thread provenance after a re-record or a
  repeat; the fingerprint item of Highlight and revert leftovers.

- **B6. Rebuild keeps the pages retained threads name** (_small_, `structured-memory/rebuild.md` with
  `read.md`; Q12). `rebuild.ts` (`seededPage`, `rebuildChanges` ~174–191, ~308–325): a page that a retained
  thread's `who` names is seeded with its id and not removed at the swap.
  _Done_: an imported thread with a non-empty `who` still reaches the prompt after a rebuild.
  _Test_: `server/src/prompt/memory/structured/rebuild.test.ts` (~151–224, with `who` set),
  `retrieve.test.ts` (~1022–1049).
  _Removes_: Rebuild drops retained imported threads' participants.

- **B7. One health map, newest answer wins** (_small_, `chat-pipeline.md` with `structured-memory/read.md`;
  Q13). `src/ts/process/chatStatus.svelte.ts`: `memoryHealthStates` (~252) becomes one module-level
  derived that `Sidebar`, `MainMenu` and `DefaultChatScreen` share instead of three walks; `readHealth`
  (~220) tags each request with a per-chat generation and drops an answer older than the newest applied.
  Q13's answer (groups keep their badge) closes the group item with no code change.
  _Done_: three consumers trigger one walk per change; a delayed boot read that returns after a post-repair
  read leaves the repaired badge.
  _Test_: `src/ts/process/chatStatus.test.ts` (~594–639, an out-of-order pair; a walk counter).
  _Removes_: A delayed health answer overwrites a newer badge; the walk and group items of Health badge
  leftovers.

- **B8. Health reads stay inside their budget** (_small_, `structured-memory/records.md` with `read.md`;
  Q14). `server/src/data/memoryStore.ts` `readHealth` (~914–943) charges each chat's stored event and run
  bytes with its page bytes and answers `unavailable` for a chat over the per-chat cap;
  `server/src/routes/structuredMemory.ts`: the contents route (~428–454) passes the round budget as POST
  `/health` (~670–688) does. Add `unavailable` to the health states and the badge's unknown look. Measure
  64 chats of 5,000 events before and after (`node util/memoryEval.mjs`) and record both.
  _Done_: a contents read of a huge chat answers within the budget; the 64-chat health round stays within
  its byte budget.
  _Test_: `server/src/tests/memoryStore.test.ts`, `server/src/tests/structuredMemoryRoutes.test.ts`,
  `src/ts/process/chatStatus.test.ts` (the new state).
  _Removes_: Health badge leftovers (the contents read); the `readHealth` bullet of Evaluation findings.

- **B9. The final recheck reports what it drops** (_small_, `server-generation.md` with
  `structured-memory/read.md` and `memory.md`; Q15). `server/src/prompt/assemble.ts`: collect the
  non-blank history entries the token recheck (~2501–2539) removes and add their tokens to Structured
  Memory's `gapTokens` and the coverage report (`buildContextReport` ~2969–2998).
  _Done_: a send whose script grows the prompt past selection's budget shows the dropped messages as a gap.
  _Test_: `server/src/tests/assemble.test.ts`, `shared/contextReport.test.ts`.
  _Removes_: The final token recheck drops history evidence never sees.

- **B10. Selection counts each text once** (_small_, `structured-memory/read.md`).
  `server/src/prompt/memory/structured/step.ts` (~291–315) and `card.ts` (~223–227): memoize token counts
  by text within one selection and card build. Re-run `node util/memoryEval.mjs` on the 1,000-turn fixture
  and record the `selectMemory` time before and after.
  _Done_: a counting tokenizer sees each distinct text once per selection; the measured time drops.
  _Test_: `server/src/prompt/memory/structured/retrieve.test.ts` (a counting tokenizer).
  _Removes_: the `selectMemory` bullet of Evaluation findings.

- **B11. Journal recovery keeps a refused memory field** (_hard_, `draft-recovery.md` with
  `structured-memory/projection.md`; Q16). `src/ts/storage/journalRecovery.ts` `applyChatOps` (~823–850)
  passes a recovery source to `setChatMeta`; `keepsHeldHypaV3Data` (`chatStore.svelte.ts` ~4143) refuses a
  real `hypaV3Data` from recovery with a recovery-worded notice, the row's other ops still apply, and the
  refused value is filed through `recoveryDrafts` instead of being dropped with the row. If a recovery
  draft cannot hold a chat-meta value, keep the journal row for that op instead and ask before going on.
  _Done_: recovering a journal row that carries `hypaV3Data` while Structured Memory is selected applies its
  other ops, files the value as a recovery draft, and says so in recovery words.
  _Test_: `src/ts/bootstrap.journalRecovery.test.ts`, `src/ts/storage/tests/chatStore.test.ts` (~2890).
  _Removes_: the journal recovery item of Projection refresh leftovers.

- **B12. A comment and two constants** (_small_, `structured-memory/projection.md` with
  `self-host-server.md`). `server/src/app.ts` (~774–781): the body-cap comment names the revisions route's
  256 KiB (`MAX_REVISIONS_BODY_BYTES`, `routes/structuredMemory.ts` ~89). Move `MEMORY_REFRESH_DEADLINE_MS`
  and `MEMORY_PROJECTIONS_PER_READ` (`v3.svelte.ts` ~988–991) to `shared/structuredMemory.ts` and import them
  in `src/ts/plugins/apiV3/hostApiMemory.test.ts` instead of reading them by regular expression (~67).
  _Done_: no test reads a constant from source text; the comment lists every cap.
  _Test_: `src/ts/plugins/apiV3/hostApiMemory.test.ts`.
  _Removes_: Projection refresh leftovers (the last items; the `chatOutput` item is Recorded).

### C. Inbox and guides

- **C1. Recorded and gone items leave the inbox** (_small_, wide; the guides named below). For each item
  marked Recorded in the Index, confirm the named guide's Known Hazards states it and add the sentence where
  it is missing (the word-boundary rule from B4 goes to `structured-memory/read.md`); keep each guide under
  its ceiling. Narrow the Phase 6 entry to its two perf items (own-save echo summary read; idle read before
  trim) and Evaluation findings to the Deferred bullets.
  _Done_: every Recorded item is in its guide; `pnpm check:docs` passes.
  _Test_: `pnpm check:docs`.
  _Removes_: Adopted summaries; the Recorded and Gone items of Phase 6 review leftovers; the `chatOutput`
  item of Projection refresh leftovers; the no-revert item of Highlight and revert leftovers (the entry goes
  once B3 and B5 land); the trash-bound item of Page tool leftovers; the `addText` item of Evaluation
  findings.

## Deferred

Each group is a later plan or a design question, with the entries it should take.

- **Read path budget.** What `pinned` reserves for an adopted event; keeping raw history when its covering
  event did not fit the card; a minimum thread allowance so the `threads` lane does not starve at 16k; the
  call overhead constant (1,500 vs the measured 2,100–3,700), calibrated against a real model with Q2 of the
  retired Structured Memory plan. Entries: Adopted summaries (Recorded), Evaluation findings (overhead,
  lanes).
- **Named-page matching.** A word-boundary rule for titles and aliases on both the writer and the read path
  (alias `Al` in "also"); `searchMatch`'s `fullWordMatching` misses multi-word titles and punctuation.
  Entry: Cast slice matches substrings (after B4).
- **Checkpoint save hold.** Trace the readers of `MemoryRun.input` and drop it from recorded runs, then
  re-measure the 500 ms hold on a 2,000-run chat. Entry: Evaluation findings (recorded in
  `structured-memory/lifecycle.md` ~338–342).
- **Plugin index reads.** Coalesce adjacent `getChatFromIndex` projection refreshes into one revisions
  batch (the per-IP bucket is now 2,000 a minute, so it is cost, not a near refusal). Entry: Evaluation
  findings.
- **Create-state proof.** Parked resends can be dropped only once the adapter can prove a removed
  character has no server incarnation and no unresolved create; `persisted` alone is not that proof.
  Entry: Parked resends leak (Stays).
- **Svelte's subscriber queue.** A throwing store subscriber leaves `subscriber_queue` mid-run for the
  realm; the fix is upstream (a `finally` in `writable.set`) or a patched dependency. Entry: Store
  subscriber throw queue (Stays).
- **Refresh and trim costs.** Whether an own-save echo should install the acknowledged summary instead of
  one summary-list read, and whether an idle refresh counts as recent use for the trim. Entry: Phase 6
  review leftovers (narrowed, Stays).

## Verification

- Per slice: the `_Test_` files, `pnpm check`, `pnpm --silent test:agent` (whole, once, after the last
  edit), `pnpm format:check`, the owning guide's focused checks, and `pnpm check:docs` for any guide edit.
- Browser checks, recorded in the slice's commit message: A2 (`checkJobHandoff.mjs`, a lost follow then a
  retake), A4 (`e2e/rerollCandidates.spec.ts` with the insertion), B1 (two tabs, Record now with a plugin
  memory model), B3 (`mobilechat` and `cardboard` receipts).
- Measurements, recorded in the commit message: A6 (2 MiB `pluginStorage` observer), B8 (64-chat health
  round), B10 (`selectMemory` on 1,000 turns).
- At the end of the run: the whole suite with the slow tag, `pnpm check:docs`, and `found-issues.md`'s
  Contents counts matching its entries.
