# Removal Reroll Plan audit, 2026-11-22

- Plan: `docs/plan/removal-reroll.md`
- Commit audited: `00ffa3dff`
- Mode: `full`
- Model: GPT-6.2-Sol (`xhigh`), read-only; report written by the plan-runner orchestrator (Claude Opus 5.5)

| Severity   | Count |
| ---------- | ----- |
| P1         | 6     |
| P2         | 6     |
| P3         | 4     |
| unverified | 0     |

All 16 findings are open. The six P1 findings are data-loss gaps in the stash's design (restore, settlement,
variables, the anchor, assets) or a durability claim that does not hold, so none is fixed in the plan by the audit:
the plan goes back for revision, and the P2 and P3 corrections belong in that revision. The P2 finding A8 and the lock
that A4 asks for change what a user or an older client sees, so the revision needs the owner's answer on them.

Sol ran no test and no type check; it read the source at the commit above. The turn took about 11 minutes and 3.5 M
tokens. `read_only_violation` was `false`.

Re-check list: the plan relies on two of the four. `patchMessage` closes an open fence
(`server/src/data/chatStore.ts:1876`), so it cannot stand in for the tail reroll's final write (A4). The tail's
removal reaches other tabs as an ordinary `chatFeedChange` sized in its three forms against the 64 KiB cap, with the
id manifest or the chat ref as the fallback (`server/src/data/chatStore.ts:1956`, `:2073`, `shared/resources.ts:565`),
and `sendText` counts any open socket's frame as a delivery (`server/src/jobs/generationJobs.ts:1064`, `:1580`), so the
initiating tab is not guaranteed to hold the removal (A10). `STORE_TABLES_SQL` runs only on a fresh database
(`server/src/data/resourceStore.ts:3897`, `:776`), so the stash table needs `CHAT_OPEN_SCHEMA_SQL` (A1).

## P1

- **A1. D3, "The stash table is in the chat SQLite file, so a snapshot or a version-2 archive taken mid-job carries
  it (Q1)"; slice 1, "a snapshot taken mid-job and restored puts it back."** Capture copies the whole file
  (`server/src/data/snapshots.ts:319`, `server/src/routes/backups.ts:329`, `:416`, `server/src/data/exportScrub/worker.ts:13`),
  but both restore paths stage named tables only and give chats fresh sequences
  (`server/src/data/restore/stageValidatedSnapshot.ts:54`, `server/src/data/resourceStore.ts:686`, `:3277`,
  `server/src/data/chatStore.ts:4002`), so a restored mid-job snapshot has no stash and no removed replies. A new table
  also reaches existing databases only through `CHAT_OPEN_SCHEMA_SQL` (`server/src/data/chatStore.ts:403`, `:1361`).
  Correction: stage and validate the optional stash table, remap its chat sequence on install, settle the imported
  stash before the new epoch is published, accept archives without the table, create it idempotently in
  `CHAT_OPEN_SCHEMA_SQL`, and test both restore round trips.
- **A2. D4, "A job that wrote at least one reply deletes its stash in its final write"; D5, "each stash row is put
  back by D4's rule."** There is no job-wide final write. `runSpeaker` finalizes each reply, even a partial one from a
  failed stream (`server/src/prompt/runner.ts:667`, `:751`); `runSend` holds reply ids in memory and a later speaker
  can throw (`:2088`, `:2630`); the registry can end a job on its abort deadline while the runner is still pending, and
  its finalization has no settlement hook (`server/src/jobs/generationJobs.ts:1778`, `:1832`, `:1912`). Correction:
  define a completed replacement, record it durably with the reply write, add one idempotent settlement before the
  terminal and the slot release (forced abort, shutdown, maintenance included), say what a restart does to a group
  job whose first speaker finished, and keep the stash and fence writes when settlement fails.
- **A3. D4, "puts the stash back after the anchor, with the stashed variables."** Putting the whole pre-restore map
  back erases variable edits made during the job. The tab reverses per key and keeps a key changed since
  (`src/ts/process/rerollHistory.ts:281`, `shared/rerollCandidates.ts:284`); the in-place reroll tracks the keys the
  job and foreign writers touched (`server/src/data/chatStore.ts:1507`, `:2535`, `:2920`). Correction: record per-key
  provenance durably and roll back only the job's own changes, on settlement, at open, and after a restore.
- **A4. D8, "the lock on the replying message ... the tail reroll follows it"; D5, "A stash whose chat or anchor is
  gone is deleted and logged."** The tail has no replacement row to lock, and the write guard admits appends, metadata
  writes, deleting the anchor, and a whole-chat `replace` that keeps the chat sequence
  (`server/src/jobs/generationJobs.ts:2523`, `:1949`, `server/src/data/chatStore.ts:1314`, `:1917`, `:2421`, `:2574`,
  `:2650`). Deleting a stash whose anchor went away deletes the only copy. A plain append also does not restore the fence
  columns or checkpoint fields, and `patchMessage` closes a fence (`server/src/data/chatStore.ts:1876`). Correction: a
  store-enforced reservation from the stash commit to settlement against same-chat replacement and edits that destroy
  the anchor or collide with stashed ids (null anchor included); chat deletion as its own outcome; a conflicted stash
  kept for recovery; ordered rows put back with stable ids, candidates, and closed fences, through the store's
  revision, summary, and publication.
- **A5. D3, the stash in the chat SQLite file.** Stashed replies can hold assets and inlays, but the asset lifecycle
  scans named live and snapshot tables (`messages.data` among them) and rechecks fixed columns before deleting
  (`server/src/data/assetLifecycle.ts:462`, `:584`, `:1312`, `server/src/data/resourceStore.ts:2056`), so an asset only
  a stash references is swept. Correction: add stashed message data to the live and retained-snapshot roots and to the
  sweep's recheck, with a regression for an asset only a retained snapshot's stash holds.
- **A6. Current State, "the old reply itself is a stored candidate, so a restart cannot lose it."** `trimCandidates`
  can drop the old reply from the begin group when the candidates pass their 192 KiB aggregate limit, leaving it only
  in process memory (`server/src/prompt/runner.ts:1508`, `:1531`, `:1397`, `shared/rerollCandidates.ts:7`, `:229`;
  a 193 KiB reply is seeded at `server/src/tests/promptRunner.test.ts:4187`). Correction: qualify the claim to replies
  the candidate limit keeps, scope this plan's guarantee to the removal path, and record the oversized in-place case as
  a separate issue.

## P2

- **A7. D2, "the stored chat's messages after the anchor must be exactly `messageIds`"; slice 1, "the job runs as a
  send without input."** A chat that ends with a user message gives an empty tail (`shared/rerollCandidates.ts:317`,
  `src/lib/ChatScreens/DefaultChatScreen.svelte:1033`), which the store's `remove` refuses
  (`server/src/data/chatStore.ts:954`); the runner drops input only with `rerollMessageId`, and `speakerChaId` narrows
  a group to one speaker (`server/src/prompt/runner.ts:502`, `:628`). Correction: an empty tail stays the plain
  inputless send with no stash; a non-empty one takes ordered unique ids, refuses input and a speaker override, and
  commits the removal before speaker selection and prompt work.
- **A8. D7, "the tab uses the server path only under a current `hello` that says so."** The HTTP create runs after
  asynchronous preparation and is fenced by the resource epoch, which a restart onto the same file keeps
  (`src/ts/network/eventFeed.ts:233`, `:414`, `src/ts/process/serverCommands.ts:1318`,
  `src/ts/network/generationJobs.ts:633`, `server/src/data/resourceStore.ts:3934`); an older server reached in that
  window drops `rerollTail` and appends (`server/src/routes/generations.ts:254`, `server/src/prompt/runner.ts:658`).
  Correction: recheck `hello` at dispatch and give the tail reroll a wire form an older server refuses (for example a
  dedicated create route); state that an already loaded older tab keeps its old behavior. A new route is an API
  change: the owner's call.
- **A9. D2, "the job ends with a refusal (`rerollTailStale`, 409) and nothing is written"; D6, "the history drops the
  bundle it began."** The registry can end a created job with a 409 (`server/src/jobs/generationJobs.ts:1888`, `:2343`),
  but admission has written a receipt, `RerollAttemptWrite` needs an owned `begin` on a message
  (`server/src/data/chatStore.ts:2310`), the tab's send result drops generic terminal codes
  (`src/ts/process/serverGeneration.ts:206`), `rerollHistory.restore` never clears its slot and `begin` replaces the
  previous one (`src/ts/process/rerollHistory.ts:61`, `:145`), and `sendChatMain` skips history recording with a
  `rerollTarget` (`src/lib/ChatScreens/DefaultChatScreen.svelte:1235`). Correction: check the tail inside the chat
  write transaction, return a coded 409 that changes neither chat nor stash, carry the code through
  `callerErrorCodes` (`src/ts/process/serverCommands.ts:595`, `:998`) and refresh; stage the bundle per attempt, keep
  the old slot on a pre-write refusal, and commit the history only after a settled replacement, from the rows actually
  removed.
- **A10. D6, "the job's begin group reaches the tab as an ordinary chat change."** The feed change is a notification
  that can fall back to the id manifest or the chat ref, be deferred by a busy tab, and count as delivered on any open
  socket (see Re-check list; `src/ts/storage/chatStore.svelte.ts:3184`, `:7323`). Correction: the runner sends its own
  chat hydration after the begin group and at settlement, and the initiating tab holds or reads the settled revision
  before it records the bundle or repeats after a lore stop.
- **A11. D9, "A tail reroll still runs on this tab when remote sending is on."** The removal path passes no reroll
  target today, so no request id is minted before the remote router; routing the tail through `rerollTarget` mints one
  and makes the send eligible for remote send unless `localOnly` is set
  (`src/lib/ChatScreens/DefaultChatScreen.svelte:1057`, `:1216`, `src/ts/process/index.svelte.ts:139`,
  `src/ts/network/remoteSend.ts:40`). Correction: put D9 in slice 2, set `localOnly` on every tail reroll and lore
  repeat with a test, and fingerprint `rerollTail` only when present (`server/src/jobs/generationJobs.ts:394`).
- **A12. D3, "the tail's newest `scriptstateCheckpoint`"; D8, "a candidate notice when a checkpoint is skipped."** The
  tab reads the newest non-comment row and restores only when it has `checkpoint.after`
  (`src/lib/ChatScreens/DefaultChatScreen.svelte:1044`, `:981`, `:1064`); the runner raises
  `scriptstateCheckpointSkipped` only with `rerollMessageId` (`server/src/prompt/runner.ts:695`, `:1134`). Correction:
  state that rule exactly, name the condition that opts the tail reroll into the notice, and repeat a lore-stopped tail
  reroll with a fresh request id after checking the same tail.

## P3

- **A13. Slices 1 and 2, the file lists.** Slice 1 also needs `shared/jobs.ts` (`GenerationContext`, the error-code
  allowlist; `:35`, `:257`), `shared/events.ts` (`hello`, `:101`), `server/src/data/resourceStore.ts` (transactions and
  restore; `:357`, `:3264`), and `server/src/data/assetLifecycle.ts` (A5). Slice 2 also needs
  `src/ts/process/serverCommands.ts` (`:1070`), `src/ts/process/index.svelte.ts` (`:23`), `src/lang/en.ts` (`:1939`),
  `src/ts/network/generationJobs.ts` (A8), the full path `src/lib/ChatScreens/DefaultChatScreen.svelte`, and the
  existing tests it changes (`src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts:1232`, `:1616`,
  `e2e/rerollCandidates.spec.ts:493`).
- **A14. Slice 3, no dependency line and short file list.** State `1 → 2 → 3`, and add
  `docs/structure/server-resources.md`, `docs/structure/live-update-feed.md`, `docs/structure/network-jobs.md`,
  `docs/plan/README.md`, and `docs/archived-plan/README.md`.
- **A15. Current State, "`"unsafe"` when the chat changed or stayed behind."** A changed owner, a moved anchor, a row
  already back, an unsettled send, or an empty bundle return `"none"`; `"unsafe"` is a needed restore blocked by a
  mirror behind or held or by competing generation (`src/ts/process/rerollHistory.ts:193`, `:230`, `:269`).
- **A16. Manual Checks, "the server stopped (`docker stop`)."** `SIGTERM` drains and gives the runner its abort grace
  (`server/src/main.ts:104`, `server/src/jobs/generationJobs.ts:1912`), so it exercises the graceful path. Add an abrupt
  kill after the stash commits and before the first reply completes, and let a surviving job settle before the
  close-tab check reads the chat.

## Second audit, of the revision

- Plan: the revision of `docs/plan/removal-reroll.md` committed with this section, written on `bcf9d8e8e` from A1 to
  A16, a design review (GPT-6.2-Astra, `xhigh`, read-only, two turns: the stash shape, then settling the capture copy
  in `backupTo` instead of staging the stash through restore), and the owner's answers Q5 to Q7
- Mode: `full`, by a fresh GPT-6.2-Astra (`xhigh`, read-only) that had not seen the design review; about 13 minutes and
  8.0 M tokens; `read_only_violation` was `false`

| Severity   | Count |
| ---------- | ----- |
| P1         | 8     |
| P2         | 7     |
| P3         | 4     |
| unverified | 0     |

Of the first audit, A1, A5, A6, A11, A14, A15, and A16 are resolved; A2, A3, A4, A7, A8, A9, A10, A12, and A13 are
partly resolved, and what is left of each is one of the findings below. All 19 are open; the plan goes back for a
second revision. B5, B8, B12, and B15 need the owner's answer.

### P1

- **B1. D3, "`rerollTurnStart` over them starts at the first."** For `[user, A, B]` a descriptor anchored at `A`
  naming `[B]` passes; the turn is `[A, B]` (`shared/rerollCandidates.ts:318`). The admitted baseline is the public
  read's JSON, without the fence columns (`server/src/jobs/generationJobs.ts:688`, `:2437`,
  `server/src/data/chatStore.ts:85`, `:1428`), and the runner has no token-fenced write before `loadJobScope`
  (`server/src/prompt/runner.ts:453`, `:483`). Correction: compute the boundary over the whole stored transcript in the
  transaction and compare anchor and ids, name the fields of the same-id comparison, keep a private admission image,
  expose a token-fenced begin usable before scope load, and stash the raw rows.
- **B2. D6, "right after its already-ended check ... runner writes after that point are fenced."** `job.ended` is set
  later, publication calls listeners synchronously, an abort reason overrides the terminal, and a throwing settlement
  skips slot cleanup and `resolveFinished`, which the abort timer and maintenance rely on
  (`server/src/jobs/generationJobs.ts:1747`, `:1758`, `:1778`, `:1860`, `:1920`, `:1941`, `:3013`,
  `server/src/data/changeFeed.ts:51`). Correction: claim finalization and close runner writes first, catch the
  settlement failure, let the persistence error win over the abort, always clean up and resolve `finished`, and treat a
  failure after commit (`CommittedWriteError`) as a delivery failure.
- **B3. D6, "block writes and new jobs on that chat until a later settlement succeeds."** Nothing enforces that once
  the slot is gone: admission checks the in-memory slot and the rebuild lock (`server/src/jobs/generationJobs.ts:2405`,
  `:1845`), D8's reservation admits metadata and other edits, a retry at start cannot fix a missing anchor or a taken
  id, and the change log is created after the chat schema opens (`server/src/data/resourceStore.ts:1061`, `:1165`,
  `:3344`). Correction: define how an ownerless stash blocks admission and writes, how it is retried, and what a failed
  retry at start leaves; install the guard before serving; slice 1 exposes it for slice 3's admission.
- **B4. D11, the terminal "carries the tail's disposition (`kept` or `restored`) and the settled revision."** A
  pre-begin refusal has no stash, a failed settlement leaves one, and a crash between the chat commit and the receipt's
  end leaves a generic `503 shutdown` with neither field (`server/src/app.ts:359`, `:434`,
  `server/src/data/generationReceipts.ts:8`, `:208`). Correction: name the three outcomes, commit a job id, outcome, and
  revision record with the settlement and reconcile it when receipts open; an unavailable outcome leaves history alone;
  slice 3 gains `server/src/data/generationReceipts.ts` and `server/src/app.ts`.
- **B5. D5 and D6, keeping the completed replies of a group.** A completed speaker's checkpoint is stripped when the
  next speaker's placeholder is appended (`server/src/prompt/runner.ts:672`, `:2025`, `server/src/data/chatStore.ts:2613`,
  `:2637`), so removing the failed placeholder leaves the kept reply without the `after` snapshot Undo needs
  (`src/ts/process/rerollHistory.ts:115`), and a job-wide first-write undo map cannot separate the kept speaker's
  variable writes from the failed one's. Trigger `replace` and Lua insertion add companion rows by other paths
  (`server/src/jobs/chatResult.ts:152`, `server/src/lua/bindings.ts:1544`). Correction: keep the completed checkpoint
  across later speakers, tag companion rows by round, and decide whether a failed round's variable writes survive a
  partial keep (a per-round boundary if they roll back). Needs the owner: Q5 does not say what happens to the failed
  round's variables.
- **B6. D7, "reusing the in-place reroll's `recordVariable` / `recordMap`."** `recordMap` visits only keys whose value
  differs, so a foreign whole-map save of the job's own value does not drop the entry and rollback overwrites it;
  unsetting the whole map can bring back a key the job removed; tracking ends with its one message lock, and the job id
  and the write token are different ids (`server/src/data/chatStore.ts:1492`, `:1507`, `:1525`, `:2531`, `:2554`,
  `server/src/jobs/generationJobs.ts:2439`). Correction: track by stash ownership across the job with a trusted token to
  job mapping, and specify whole-map set and unset, same-value merges, candidate selection, and a later owner write.
- **B7. D5, "error-only output," and D6, "reports that failure."** With `inlayErrorResponse`, a provider failure appends
  a `risuerror` row or error text to the last unlocked character row (a kept speaker or the anchor) and the job ends
  `done` with `stopped: true` (`server/src/prompt/runner.ts:1233`, `:1260`, `:2005`, `:388`,
  `server/src/tests/promptRunner.test.ts:1683`); settlement can delete the only report or keep or erase the appended
  text by accident. Correction: carry the provider failure through settlement and report it once, and say whether an
  existing row may take an error suffix.
- **B8. D9, "Every running job ends at a restart."** An earlier build opens the same schema version with the extra
  table, takes no reservation, captures the shortened chat unsettled, and its restore ignores the table
  (`server/src/data/resourceStore.ts:115`, `:3931`, `:3224`, `:686`), so a crash, a downgrade, and a capture and
  restore on the old build lose the only copy. Correction: an on-disk fence an already shipped binary enforces, or a
  guarantee bounded to stash-aware builds with settlement required before a downgrade. Needs the owner.

### P2

- **B9. D3, "the newest non-comment removed row that has `scriptstateCheckpoint.after`."** The screen takes the newest
  non-comment row first, then tests `after !== undefined` (`null` is a valid snapshot;
  `src/lib/ChatScreens/DefaultChatScreen.svelte:1044`, `shared/rerollCandidates.ts:24`); the revision searches
  backward. Correction: copy the screen's predicate and test a newer row without `after` and `after: null`.
- **B10. D2, "with no stash and no history change."** Today an empty tail calls `begin` with `[]` and the reply is
  recorded after it, so Back returns to the user message (`src/lib/ChatScreens/DefaultChatScreen.svelte:1036`, `:1235`,
  `src/ts/process/rerollHistory.ts:65`, `:105`). Correction: keep that history step, and apply the capability gate
  only to the non-empty path.
- **B11. D11, the clean pinned copy and `readRecoveringChat`.** Preflight can end on the saved-base revision after two
  failed refreshes, a pin admits edits, `readRecoveringChat` can load a newer chat, and `holdsRevision` accepts a
  greater chat sequence (`src/ts/process/serverCommands.ts:1206`, `:1258`, `:556`, `:595`,
  `src/ts/storage/chatStore.svelte.ts:3387`, `shared/resources.ts:189`); recording everything after the anchor can make
  Undo remove another tab's later append. Correction: bind the press to owner, incarnation, anchor, and tail, freeze copy,
  descriptor, and revision together after preflight, and record history only from an exact settled revision or
  settlement-issued ordered ids that match the current tail.
- **B12. Q6, "message and variable edits go through."** D8 also refuses edits to provisional rows; an unnamed
  `generating` conflict re-queues the whole group; an edit to a stashed original id gets `missing` and can become a
  recovery draft; and an owner-tab plugin callback flushes through the ordinary batch with no job token, so an append
  there is refused and can fail the reroll (`server/src/data/chatStore.ts:2652`,
  `src/ts/storage/chatStore.svelte.ts:6165`, `:6725`, `server/src/routes/resources.ts:398`,
  `src/ts/storage/resourceSync.svelte.ts:5906`, `src/ts/network/jobChannel.ts:1316`, `server/src/prompt/runner.ts:2218`).
  Correction: specify provisional ids, stashed ids, mixed groups, and callbacks. Needs the owner for callbacks.
- **B13. D12, "distinguished from an uncertain earlier dispatch."** `exchange` treats any throw from `beforeDispatch` as
  uncertain and retries (`src/ts/storage/serverAuth.ts:205`, `src/ts/network/generationJobs.ts:519`, `:531`, `:637`).
  Correction: a veto outcome of its own, checked before dispatch is marked, with no retry.
- **B14. D11, "a lore-budget stop repeats once."** Today it repeats only after the user picks `warnOffAndSend`, which
  saves `loreBudgetWarnOff: true` (`src/lib/ChatScreens/DefaultChatScreen.svelte:904`, `:1064`). Correction: keep the
  dialog and the saved preference, check the restored tail after the choice and at the repeat's preflight, and mint the
  fresh id only for the chosen repeat.
- **B15. Q5, "This is today's rule."** Today restoring tests whether the chat ends at the anchor again, so a streamed
  prefix, an error row, or a trigger's row stops it without any completed speaker; a start trigger can write a row and
  stop the send (`src/ts/process/rerollHistory.ts:232`, `server/src/prompt/runner.ts:1759`,
  `server/src/jobs/chatResult.ts:196`, `server/src/prompt/assemble.ts:1795`), and D5 and D6 would discard that row.
  Correction: describe both tests and say whether trigger-only output counts. Needs the owner.

### P3

- **B16. Slice 3, "`rerollTailStale` in the caller allowlist."** `shared/jobs.ts` holds `GENERATION_ERROR_CODES`;
  `callerErrorCodes` and the forwarding of terminal fields are the tab's (`src/ts/process/serverCommands.ts:1000`,
  `:1466`, `src/ts/process/serverGeneration.ts:206`, `src/ts/process/index.svelte.ts:157`). Correction: the wire code in
  slice 3, the caller handling in slice 4.
- **B17. D3, slice 3, and the manual checks.** "Admission's receipt is the only write" omits acceptance and the
  terminal's `receipts.end`; "a tab of an earlier build sees no change" ignores Q6; the graceful stop restores only
  before the first speaker completes. Correction: narrow the three sentences.
- **B18. Slices 3 and 5, files.** `server/src/tests/memoryTasks.test.ts` compares the whole `hello` (`:2280`, `:2464`);
  slice 5 also needs `docs/backlog/found-issues.md` and `docs/structure/live-updates.md`, and names its edits to
  `docs/backlog/known-issues.md` and the plan file.
- **B19. Order.** Slice 4 can finish its whole-suite run before slice 2 lands. Correction: the final suite and browser
  specs run on the combined tree after both 2 and 4.
