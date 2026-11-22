# Removal Reroll Plan

Status: drafted 2026-11-22 at `0337a9b5a` from the owner's answer to the [known issues](../backlog/known-issues.md)
entry "A removal reroll (`rerollByRemoval` ...) can lose the replies it removes when the tab closes before the server
admits the replacement job" (owner, 2026-11-22: "a separate plan", against a client-side durable copy or a
Limitation). Revised the same day at `bcf9d8e8e` after its plan-runner
[audit](../reports/audits/plan-runner/removal-reroll-2026-11-22.md) (six P1 findings) and a design review against the
code; the owner answered Q1 to Q7 with the proposals on 2026-11-22, and D1 to D12 are written to those answers.
The revision's own audit (the report's second section) left eight P1 findings open: revise again before any slice.

Sources: `src/lib/ChatScreens/DefaultChatScreen.svelte` (`reroll`, `rerollByRemoval`),
`src/ts/process/rerollHistory.ts`, `src/ts/process/serverGeneration.ts`, `src/ts/process/serverCommands.ts`,
`src/ts/network/eventFeed.ts`, `src/ts/network/generationJobs.ts`, `shared/rerollCandidates.ts`, `shared/jobs.ts`,
`server/src/routes/generations.ts` (`parseCreateBody`), `server/src/routes/events.ts` (the `hello` frame),
`server/src/jobs/generationJobs.ts` (`finalize`), `server/src/prompt/runner.ts` (`runSend`, `runSpeaker`),
`server/src/data/chatStore.ts`, `server/src/data/resourceStore.ts` (`backupTo`, `replaceAll`), and
`server/src/data/assetLifecycle.ts`, read at `bcf9d8e8e`; the [chat pipeline](../structure/chat-pipeline.md#reroll),
[server generation](../structure/server-generation.md#reroll-in-place) and [chat store](../structure/chat-store.md)
guides; the [durable data loss audit](../reports/audits/codebase/durable-data-loss-2026-11-18.md#6-closing-a-tab-during-a-group-reroll-can-discard-the-previous-replies),
which reproduced the loss in a browser. Identifiers are the anchors; re-verify each cited location before editing
(STRUCTURE.md protocol step 5).

## Goal

A removal reroll never loses the replies it replaces, whatever happens to the tab, the connection, or the server
process between the press and the replacement's last write.

- **The removal happens where the replacement is committed.** The server removes the old tail inside the replacement
  job, after admission, in the same transaction that keeps a durable copy of it. Before admission nothing is removed.
- **The copy outlives the job.** One settlement decides, when the job ends, whether the replacement stays or the old
  tail comes back. The same settlement runs at server start for a job a crash cut short, and on the copy of every
  snapshot or archive captured while the job ran. A tab that closed, reloaded, or crashed is not needed for any of it.
- **Nothing changes for a single reply rerolled in place**, for candidate switching, or for Undo and Redo inside one
  page.

Not goals: keeping the removed bundles across a reload for Undo and Redo (Q2; they stay in the tab's memory as now);
running a removal reroll through a remote host (Q4); changing which tail is removed (`rerollTurnStart`) or the
variable rule of a removal reroll; the in-place reroll's own durability gap for an oversized previous reply (filed in
[found issues](../backlog/found-issues.md#a-reply-rerolled-in-place-can-be-lost-on-restart-when-its-candidates-pass-the-size-limit)).

## Current State

- `reroll` (`DefaultChatScreen.svelte`) first switches the carrier's next candidate, then the bundle history
  (`rerollHistory.canForward`). Past both, a carrier rerolls in place (`context.rerollMessageId`) when
  `serverRerollsInPlace()` is true, which needs the current connection's `hello` (`rerollInPlace: true`, sent by
  every server of this build, `server/src/routes/events.ts`; false before the first `hello` and after `retire`).
  Every other tail goes to `rerollByRemoval`: a turn of several replies (two group members, a reply a trigger or Lua
  appended), or any tail while the feed has no current `hello`.
- `rerollByRemoval` computes the tail with `rerollTurnStart` (`shared/rerollCandidates.ts`), keeps a clone of it in
  this tab only (`rerollHistory.begin`), queues the variable restore of the newest non-comment removed row's
  checkpoint (`restoredScriptstate`, only when that row has `scriptstateCheckpoint.after`; no older checkpoint is
  searched), removes the tail with `editChatSync`, and calls `sendChatMain` with no input and no reroll target. A chat
  that ends with a user message has an empty tail and still sends. The send is an ordinary `send` or `group` job
  (`serverGeneration.ts` picks the kind); its preflight flushes the removal to the server before the job is created
  (`prepareServerJob`). A send that brought no reply puts the tail back with `rerollHistory.restore`: `"none"` when
  nothing needs restoring (an unsettled send, an empty bundle, a changed owner or anchor, rows already back), and
  `"unsafe"` when a needed restore is blocked by a mirror behind or held, or by competing generation.
- So the tail is gone from SQLite from the preflight's flush on, and only this tab can put it back: a close, reload,
  or crash before the replacement commits, or a server restart during the job while the tab is gone, leaves the chat
  without it. The audit reproduced this in a browser (a bound group chat, the generation request held, the page
  closed: only the question was left).
- An in-place reroll keeps its old reply as a stored candidate of the carrier while the candidates fit
  `MAX_CANDIDATES_BYTES_PER_MESSAGE` (`trimCandidates` can drop it otherwise; see Not goals). Its variable undo lives in
  process memory (`attempts` in `createChatTables`, `RerollAttemptWrite`, keyed to one owned `begin` message).
- The job registry's `finalize` (`server/src/jobs/generationJobs.ts`) is the one place every job passes when it ends,
  whatever ended it (`done`, `error`, a throw, Stop, the abort deadline, maintenance, shutdown), before its receipt and
  terminal are published and its slot is released. Receipts survive a restart; jobs do not.
- `parseCreateBody` (`server/src/routes/generations.ts`) refuses an unknown `kind` with 400 before admission, but under
  a known kind copies only the context fields it knows: a server of an earlier build ignores an unknown field and runs
  an ordinary send.
- Snapshot capture and the version-2 archive both copy the whole SQLite file through `resourceStore.backupTo`, which
  opens the copy writable before it is kept or scrubbed. Restore and import stage named tables only.
- The asset lifecycle roots assets in the named live and snapshot tables (`messages.data` among them) and rechecks
  fixed columns before it deletes (`readRoots`, `readAssetReferenceText`).
- The store's message guard locks single messages from their `begin` to their final write; `replace` and `delete` are
  refused (`409`, reason `generating`) while a foreign job holds a message of the chat, but `append` and `meta` are
  not, and a job between speakers holds no message.

## Decisions

Written to the owner's answers of 2026-11-22 (Q1 to Q7, all as proposed).

- **D1. A tail reroll has its own create kind.** `POST /api/generations` accepts `kind: "rerollTail"` with a required
  `rerollTail: { anchorMessageId, messageIds }` (the message the tail follows, or `null` at the head; the removed ids
  in order, unique, at least one), `input: ""`, and no input id, continuation, carrier, or `speakerChaId`; anything else
  is a 400. The route turns it into the internal kind `reroll` with `context.rerollTail`, so receipts, progress, and
  `/current` keep the kinds they have; a tail descriptor under any other kind is a 400. A server of an earlier build
  refuses the unknown kind with 400 before admission (Q7). `requestFingerprint` includes the descriptor, ids in order,
  only when present, so existing receipts keep their hashes.
- **D2. An empty tail is not a tail reroll.** When `rerollTurnStart` is the transcript's end (the chat ends with a user
  message), the tab sends the ordinary inputless `send` or `group` as today, with no stash and no history change. An
  empty chat stays a no-op.
- **D3. The tail is checked and removed at the job's start, in one transaction.** At the start of `runSend`, before
  scope capture, speaker selection, input, or prompt work, a private begin-tail write checks inside the chat write
  transaction that the stored messages after the anchor are exactly `messageIds`, that `rerollTurnStart` over them
  starts at the first, and that each row still equals the row the job admitted (an edit can keep its id). On a
  mismatch the job ends with a terminal `409` `rerollTailStale` and neither the chat nor the stash changes (admission's
  receipt is the only write). Otherwise the same transaction writes the stash row (D4), applies the variable restore of
  the newest non-comment removed row that has `scriptstateCheckpoint.after`, and removes the tail. Group speaker
  selection then reads the shortened chat.
- **D4. The stash is a private table.** `CHAT_OPEN_SCHEMA_SQL` creates it idempotently (so existing databases get it),
  one row per running tail reroll: the registry job id (unique), the chat's sequence, the anchor, the removed rows as
  stored (data, candidates and their revision, translations, checkpoints, fence columns, in order), the per-key
  variable undo (D7), and the replacement progress (D5). No read, feed change, or export to a tab carries it (Q1).
- **D5. Completion is recorded with the reply.** The runner registers each replacement row it introduces (the speakers'
  replies and rows a trigger or Lua appends in the turn) with the write that introduces it, and `runSpeaker` marks a
  reply complete in the same transaction as its applied final write on a successful reply path. An empty placeholder,
  a failed stream's final text, `noReply`, removed output, or error-only output is not complete. An auto-continue that
  reopens a completed reply keeps its last completed image in the stash until the continuation completes.
- **D6. One settlement ends every tail reroll.** `finalize` calls the store's `settleTail(job.id)` once, right after its
  already-ended check and before the receipt, the terminal, `lock.endJob`, and the slot release; runner writes after
  that point are fenced. Settlement is idempotent (no stash: nothing to do) and runs in one transaction through the
  store's revision, summary, and change publication:
  - At least one completed replacement still present: keep the completed replies and their turn's companion rows,
    remove the unfinished output, and delete the stash, so the whole original tail is gone (Q5). A group job whose
    second speaker failed reports that failure.
  - None: remove the attempt's provisional output, put the stashed rows back by their ids, in order, after the anchor
    (at position zero for `null`), with closed fences and their candidates and checkpoints as stored, undo the
    variables (D7), and delete the stash.
  - A failure rolls back, keeps the stash, ends the job with a persistence error, and blocks writes and new jobs on
    that chat until a later settlement succeeds (at the latest at the next start).
- **D7. Variables are undone per key.** The stash keeps a sparse undo map: on the job's first write to a key, its prior
  value (or "absent"); a foreign write to that key drops the entry; a later job write records the then-current value.
  Each update is written in the transaction that changes `scriptstate`, the begin-tail restore included, reusing the
  in-place reroll's `recordVariable` / `recordMap` call sites. Settlement restores only the entries still present, so
  a variable another tab or job changed meanwhile keeps its value.
- **D8. The stash reserves the chat's structure.** While a stash row exists, the chat write path (`applyGroup`, after
  its replay check and before mutation) refuses a foreign `append`, `remove`, `replace`, or `delete` on that chat, and
  the deletion of its character, with the existing unnamed `409` reason `generating`, which tabs already retry or
  show; metadata writes and edits to existing messages outside the job's output go through as today (Q6). Foreign
  writes to the job's provisional rows are refused; the job itself cannot remove the anchor or reuse a reserved id; only
  settlement puts reserved ids back. A settlement that finds its anchor gone, an id taken, or its chat missing without
  a deletion keeps the stash, blocks the chat as D6's failure does, and logs; it never deletes the only copy.
- **D9. Start and capture settle too.** Every running job ends at a restart, so at store open, before
  `createResourceStore` returns (and so before the server serves requests), each stash is settled by D6's rule from the
  completion it recorded, through the normal change log. `backupTo` settles the copy the same way before it closes it,
  without publication, so no snapshot, version-2 archive, or upstream export ever holds a stash row: a capture taken
  mid-job holds what a crash at that moment would have left. A capture whose settlement fails is not kept. Restore and
  import refuse a file whose stash table is not empty.
- **D10. Stashed rows are asset roots.** The live asset scan and the pre-delete recheck read the stash's saved rows and
  undo values. Snapshots never hold a stash (D9), so their roots are unchanged.
- **D11. The tab removes nothing.** `rerollByRemoval` keeps its checks and copies the tail it will send from the clean
  pinned chat after the preflight's flush, but no longer removes or calls `rerollHistory.begin` before the job: the copy
  waits beside the history. It sends `rerollTail` with `localOnly: true` (D12) and a fresh request id per press. The
  terminal (success and error) carries the tail's disposition (`kept` or `restored`) and the settled revision; the job's
  begin and settlement reach the tab as its own chat hydration (`emitRecords` after begin, `sendChat` before the
  terminal), and other tabs as an ordinary chat change. Before it records the copy in the history (`begin` and
  `record` together, on `kept`), or repeats after a lore-budget stop, the tab holds the settled revision or reads the
  chat (`readRecoveringChat`); when the tail cannot be proved, the previous history stays. A refusal or `restored`
  discards only the copy, so earlier Undo and Redo survive. `rerollTailStale` reaches the caller through
  `callerErrorCodes`, is shown once, and the chat is read again. A lore-budget stop repeats once, with a fresh request
  id and the stop disabled, only after the original tail is confirmed back and still the tail.
- **D12. The capability gates it, twice.** `hello` advertises `rerollTail: true`. The tab checks it on the press and
  again in each create attempt's `beforeDispatch`, right before the fetch; without it the reroll is refused with a
  notice to try again once connected (Q3), distinguished from an uncertain earlier dispatch. A tail reroll sets
  `localOnly`, so it runs on this tab with remote sending on (Q4). A tab of an earlier build keeps its old removal
  until it reloads.

### Questions the owner answered

- **Q1. Where the stash lives.** Answered as proposed (owner, 2026-11-22): a table of its own in the chat SQLite file
  (one row per running tail reroll), not a chat metadata field, so tabs never receive it and it cannot be edited by a
  `meta` op. Alternative: a chat field, which tabs would then sync and show nowhere.
- **Q2. What a successful reroll keeps.** Answered as proposed (owner, 2026-11-22): the stash is deleted, and the
  removed bundle stays in the tab's memory for Undo as today. Alternative: keep the last removed bundle on the server so
  Undo survives a reload; a larger change (a bundle store, its retention, and Undo across devices).
- **Q3. A reroll while the feed has no current `hello`.** Answered as proposed (owner, 2026-11-22): refuse with a
  notice. Today such a reroll takes the lossy removal path even for a single reply. Alternative: keep the client removal
  path for that case only, as a Limitation.
- **Q4. Remote send.** Answered as proposed (owner, 2026-11-22): unchanged (the tail reroll runs on this tab).
  Alternative: let a host run it, which the server stash now makes possible; the bundle history would still be lost
  through a host.
- **Q5. A group tail reroll that completes one speaker and fails the next.** Answered as proposed (owner, 2026-11-22):
  keep the completed reply, remove the unfinished one, delete the whole original tail, and report the failure, live
  and after a restart or capture alike; a first speaker that only streamed a prefix puts both originals back. This is
  today's rule (a send that brought a reply keeps the tail removed). Alternative: all or nothing, putting both
  originals back whenever any speaker fails.
- **Q6. Edits while a tail reroll runs.** Answered as proposed (owner, 2026-11-22): only structural writes to that chat
  (append, remove, replace, delete) and deleting its character wait, with the existing "generating" refusal; message
  and variable edits go through. Some edits from other tabs, older ones included, now wait until the reroll ends.
  Alternative: refuse every edit to the chat, which is one rule but blocks edits that work today.
- **Q7. The wire form.** Answered as proposed (owner, 2026-11-22): a create-only kind `rerollTail` on the existing
  route, which an earlier server refuses, plus the terminal's disposition and settled revision. Alternatives: a
  dedicated route (one more endpoint), or only the dispatch-time `hello` check, which leaves a server swapped onto the
  same file appending replies after the old tail.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guides the slice names, with `pnpm docs:read`.
- Server tests drive the store and the job through `createServerContext`, the store's existing test fixtures, or the
  runner's existing test helpers, against a real SQLite store; tab tests drive `reroll` through the mounted chat screen
  the existing reroll tests mount (`src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts`).
- Each slice runs its own focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`; the last
  code slice runs the whole suite and the browser specs the change reaches.
- No change to `rerollTurnStart`, to the in-place reroll's behavior, or to candidate switching.

## Slices

Order: 1, then 2 and 3 side by side (disjoint files), then 4 after 3, then 5.

### 1. The stash and its settlement in the store (_hard_)

- `server/src/data/chatStore.ts`: the stash table in `CHAT_OPEN_SCHEMA_SQL` (D4); the begin-tail write and its check
  (D3); registering replacement rows and marking completion (D5); `settleTail` as a transaction-level routine bound to
  a given connection, with publication left to the live caller (D6); the per-key variable undo (D7); the reservation
  in `applyGroup` and the ordered restore with closed fences (D8).
- `server/src/data/resourceStore.ts`: the trusted transaction plumbing for those writes, the character-deletion check
  (D8), and the settlement at open before `createResourceStore` returns (D9).
- Tests (`server/src/tests/chatStore.test.ts`, `server/src/tests/resourceStore.test.ts`): a group tail is removed and
  stashed in one transaction; a stale tail (an id, the order, or a same-id edit) writes nothing; a completed reply
  keeps the replacement and deletes the stash; no completion puts the rows back in order with fences, candidates, and
  checkpoints, at a `null` anchor too; a foreign variable write or unset survives the undo; foreign structural writes
  and a character deletion get `409 generating` while other edits pass; a settlement conflict keeps the stash and
  blocks the chat; settlement is idempotent; a reopen settles a stash both before and after a completed reply.

### 2. Capture, restore, and assets (_hard_)

Depends on 1.

- `server/src/data/resourceStore.ts`: `backupTo` settles the copy before closing it and fails the capture when that
  fails (D9); restore and import refuse a non-empty stash table; `readAssetReferenceText` reads the stash (D10).
- `server/src/data/assetLifecycle.ts`: the live roots read the stash (D10).
- Tests (`server/src/tests/snapshots.test.ts`, `server/src/tests/backups.test.ts`,
  `server/src/tests/restoreStage.test.ts`, `server/src/tests/assetLifecycle.test.ts`): a snapshot and a version-2
  archive taken mid-job, before and after the first completed reply, restore to D6's outcome; an archive without the
  table imports; a file with a stash row is refused; an asset only a stashed row references survives a sweep.

### 3. The job, the runner, and the server contract (_hard_)

Depends on 1.

- `shared/jobs.ts`: the create variant `rerollTail` (D1), `GenerationContext.rerollTail`, the code `rerollTailStale`
  in the caller allowlist, and the terminal's disposition and settled revision (D11).
- `shared/events.ts` and `server/src/routes/events.ts`: `rerollTail: true` in `hello` (D12).
- `server/src/routes/generations.ts`: parse and normalize `rerollTail`, refuse the descriptor elsewhere (D1).
- `server/src/jobs/generationJobs.ts`: the fingerprint (D1); `settleTail` in `finalize`, the write fence after it, and
  the settlement hydration before the terminal (D6, D11).
- `server/src/prompt/runner.ts`: the begin-tail write at the start of `runSend` and its hydration (D3, D11); completion
  marks with the final writes (D5); the skipped-checkpoint notice for a tail reroll whose checkpoint the runner rejects.
- Tests (`server/src/tests/promptRunner.test.ts`, `server/src/tests/generationJobs.test.ts`,
  `server/src/tests/generations.test.ts`, `server/src/tests/generationReceipts.test.ts`,
  `server/src/tests/events.test.ts`): a reply deletes the stash; a provider error, Stop, a lore-budget stop, shutdown,
  maintenance, and a runner held past the abort grace put the tail and its variables back; the group case of Q5; a
  stale tail is a terminal `409` with nothing written; a malformed body and a descriptor under another kind are 400; a
  request without `rerollTail` keeps its fingerprint; a tab of an earlier build sees no change.

### 4. The tab sends the tail (_hard_)

Depends on 3.

- `src/lib/ChatScreens/DefaultChatScreen.svelte` (`rerollByRemoval`, `reroll`), `src/ts/process/rerollHistory.ts`,
  `src/ts/process/serverGeneration.ts`, `src/ts/process/serverCommands.ts`, `src/ts/process/index.svelte.ts`: D2, D11,
  and the `localOnly` routing of D12.
- `src/ts/network/eventFeed.ts`, `src/ts/network/generationJobs.ts`: the `hello` check on the press and in
  `beforeDispatch` (D12).
- `src/lang/en.ts`: the notices (`rerollTailStale`, the missing capability).
- Tests (`src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts`, its old removal and no-request-id assertions
  included; `src/ts/process/rerollHistory.test.ts`, `src/ts/process/serverGeneration.test.ts`,
  `src/ts/process/serverCommands.test.ts`, `src/ts/process/index.test.ts`, `src/ts/network/eventFeed.test.ts`,
  `src/ts/network/generationJobs.test.ts`, `src/ts/network/remoteSend.test.ts`): the tab writes no removal before the
  job's begin; a refusal and `restored` leave the chat and the earlier history as they were; Undo and Redo after a
  `kept` reroll behave as today; an empty tail sends as today; no `hello`, on the press or at dispatch, refuses with
  the notice (Q3); remote sending on still runs the reroll here.
- Browser (`e2e/rerollCandidates.spec.ts`, its wire-kind assertion updated): a bound group chat, the create request held
  before the server, the page closed; the question and both replies are still in SQLite. An admitted job with the page
  closed settles before the chat is read.

### 5. Guides and close-out (_small_)

Depends on 2 and 4.

- The [chat pipeline](../structure/chat-pipeline.md#reroll), [server generation](../structure/server-generation.md#reroll-in-place),
  [chat store](../structure/chat-store.md), [server resources](../structure/server-resources.md),
  [live-update feed](../structure/live-update-feed.md), and [network jobs](../structure/network-jobs.md) guides describe
  the tail reroll, the stash, its settlement, and the reservation; the known-issues entry is deleted (its claim that an
  in-place reroll is not affected goes with it); the plan is retired by `docs/plan/README.md` and
  `docs/archived-plan/README.md`.

## Manual Checks

- A real browser: in a group chat with two replies, press Reroll and close the tab at once; reopen after the job had
  time to end: the old replies are there, or the new ones if the job finished.
- The same with the server stopped gracefully (`docker stop`) while the replacement streams; after the restart the old
  replies are back.
- The same with the server killed (`docker kill`) after the old replies left the screen and before the first new reply
  completed; after the restart the old replies are back. Killed again after the first speaker completed: that reply
  stays and the second is gone (Q5).
