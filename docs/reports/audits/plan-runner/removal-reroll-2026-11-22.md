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
