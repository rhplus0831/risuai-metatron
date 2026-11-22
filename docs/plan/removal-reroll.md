# Removal Reroll Plan

Status: drafted 2026-11-22 at `0337a9b5a` from the owner's answer to the [known issues](../backlog/known-issues.md)
entry "A removal reroll (`rerollByRemoval` ...) can lose the replies it removes when the tab closes before the server
admits the replacement job" (owner, 2026-11-22: "a separate plan", against a client-side durable copy or a
Limitation). Decisions D1 to D9 and questions Q1 to Q4 are proposals the owner has not answered yet. Not audited:
run the plan-runner audit ([procedure](../reports/audits/plan-runner/README.md)) before any slice.

Sources: `src/lib/ChatScreens/DefaultChatScreen.svelte` (`reroll`, `rerollByRemoval`), `src/ts/process/rerollHistory.ts`,
`src/ts/process/serverGeneration.ts`, `src/ts/network/eventFeed.ts` (`serverRerollsInPlace`), `shared/rerollCandidates.ts`,
`server/src/routes/generations.ts` (`parseCreateBody`), `server/src/routes/events.ts` (the `hello` frame),
`server/src/jobs/generationJobs.ts`, `server/src/prompt/runner.ts`, and `server/src/data/chatStore.ts`, read at
`0337a9b5a`; the [chat pipeline](../structure/chat-pipeline.md#reroll),
[server generation](../structure/server-generation.md#reroll-in-place) and [chat store](../structure/chat-store.md)
guides; the [durable data loss audit](../reports/audits/codebase/durable-data-loss-2026-11-18.md#6-closing-a-tab-during-a-group-reroll-can-discard-the-previous-replies),
which reproduced the loss in a browser. Identifiers are the anchors; re-verify each cited location before editing
(STRUCTURE.md protocol step 5).

## Goal

A reroll never loses the replies it replaces, whatever happens to the tab, the connection, or the server process
between the press and the replacement's last write.

- **The removal happens where the replacement is committed.** The server removes the old tail inside the replacement
  job, after admission, in the same transaction that keeps a durable copy of it. Before admission nothing is removed.
- **The copy outlives the job.** If the job ends without a reply (refused after admission, failed, stopped, the server
  restarted), the server puts the old tail back. A tab that closed, reloaded, or crashed is not needed for that.
- **Nothing changes for a single reply rerolled in place**, for candidate switching, or for Undo and Redo inside one
  page.

Not goals: keeping the removed bundles across a reload for Undo and Redo (Q2; they stay in the tab's memory as now);
running a removal reroll through a remote host (Q4); changing which tail is removed (`rerollTurnStart`) or the
variable rule of a removal reroll.

## Current State

- `reroll` (`DefaultChatScreen.svelte`) first switches the carrier's next candidate, then the bundle history
  (`rerollHistory.canForward`). Past both, a carrier rerolls in place (`context.rerollMessageId`) when
  `serverRerollsInPlace()` is true, which needs the current connection's `hello` (`rerollInPlace: true`, sent by
  every server of this build, `server/src/routes/events.ts`; false before the first `hello` and after `retire`).
  Every other tail goes to `rerollByRemoval`: a turn of several replies (two group members, a reply a trigger or Lua
  appended), or any tail while the feed has no current `hello`.
- `rerollByRemoval` computes the tail with `rerollTurnStart` (`shared/rerollCandidates.ts`), keeps a clone of it in
  this tab only (`rerollHistory.begin`), queues the variable restore of the tail's newest checkpoint
  (`restoredScriptstate`), removes the tail with `editChatSync`, and calls `sendChatMain` with no input. The send is
  an ordinary `send` or `group` job (`serverGeneration.ts` picks the kind); its preflight flushes the removal to the
  server before the job is created (`prepareServerJob`). A send that brought no reply puts the tail back
  (`rerollHistory.restore`, guarded: `"unsafe"` when the chat changed or stayed behind), in the same tab.
- So the tail is gone from SQLite from the preflight's flush on, and only this tab can put it back: a close, reload,
  or crash before the replacement commits, or a server restart during the job while the tab is gone, leaves the chat
  without it. The audit reproduced this in a browser (a bound group chat, the generation request held, the page
  closed: only the question was left).
- An in-place reroll is durable already: `runSpeaker` (`server/src/prompt/runner.ts`) writes a begin group that
  moves the old reply into the message's `candidates` and restores the variables, then one final write keeps the new
  reply or puts the previous candidate back. The variable undo of a failed attempt lives in process memory
  (`attempts` in `createChatTables`, `RerollAttemptWrite`), but the old reply itself is a stored candidate, so a
  restart cannot lose it.
- Jobs do not survive a restart. Their receipts do: at open, a receipt still marked running ends as a kept 503
  `shutdown` (`createGenerationReceipts`; [job receipts](../structure/server-generation.md#job-receipts)).
- `parseCreateBody` (`server/src/routes/generations.ts`) checks the context fields it knows and copies only those, so
  a server of an earlier build ignores a field it does not know. A tab that sent a new tail field to such a server
  would get an ordinary send that appends replies after the old tail.
- The bundle history (`createRerollHistory`) is per page: Undo and Redo move between removed bundles and the current
  one. A removal reroll always runs on this tab, even with remote sending on, because that history cannot be kept
  through a host ([remote send](../structure/network-jobs.md#remote-send)).

## Decisions

Proposed; the owner has not answered them yet.

- **D1. A tail reroll is a server job.** A new context field `rerollTail: { anchorMessageId, messageIds }` on a
  `reroll` job (never together with `rerollMessageId`) names the tail the tab saw: the message it ends after (or
  `null` for an empty head) and the ids of the removed messages in order. It is part of `requestFingerprint`.
- **D2. The server checks the tail before it removes anything.** At the job's first write the stored chat's messages
  after the anchor must be exactly `messageIds`, and `rerollTurnStart` over the stored messages must start at the
  first of them. Otherwise the job ends with a refusal (`rerollTailStale`, 409) and nothing is written; the tab shows
  the refusal and reads the chat again. A check at admission alone is not enough, since an edit can land between
  admission and the first write.
- **D3. The removal and its copy are one transaction.** The job's begin group removes the tail, applies the variable
  restore that `rerollByRemoval` applies today (the tail's newest `scriptstateCheckpoint`, by `restoredScriptstate`),
  and writes a stash row in the chat database: the job's generation id, the chat's sequence, the anchor, the removed
  messages as stored, and the variables before the restore. The stash table is in the chat SQLite file, so a snapshot
  or a version-2 archive taken mid-job carries it (Q1).
- **D4. The job's end decides.** A job that wrote at least one reply deletes its stash in its final write, as a send
  that brought a reply keeps it today. A job that ends without a reply (a refusal after admission, a provider error,
  Stop, a lore-budget stop) removes any partial reply of its own and puts the stash back after the anchor, with the
  stashed variables, in one transaction, then deletes the stash.
- **D5. A stash without a job is put back at open.** Every running job ends at a restart, so at store open (and after
  an epoch change that keeps the chat) each stash row is put back by D4's rule, before the server serves requests.
  A stash whose chat or anchor is gone is deleted and logged.
- **D6. The tab removes nothing before admission.** `rerollByRemoval` keeps its checks and its bundle-history copy
  (`rerollHistory.begin`, for Undo and Redo in this page) but sends the `reroll` job with `rerollTail` instead of
  removing and sending; the job's begin group reaches the tab as an ordinary chat change. A refusal before the
  job's first write leaves the chat as it was, so `rerollHistory.restore` has nothing to put back; the history drops
  the bundle it began.
- **D7. A capability gates it.** `hello` advertises `rerollTail: true`; the tab uses the server path only under a
  current `hello` that says so (an earlier server would append, by the parsing above). Without it the tab refuses
  the reroll with a notice to try again once connected (Q3), instead of falling back to the removal it does today.
- **D8. One write rule with the in-place reroll.** Where the in-place reroll already has a rule (the lock on the
  replying message, covers, the lore-budget stop's repeat, a candidate notice when a checkpoint is skipped), the
  tail reroll follows it; it gets a rule of its own only where the tail differs, and the slice names it.
- **D9. Remote send is unchanged.** A tail reroll still runs on this tab when remote sending is on (Q4).

### Questions for the owner

- **Q1. Where the stash lives.** Proposal: a table of its own in the chat SQLite file (one row per running tail
  reroll), not a chat metadata field, so tabs never receive it and it cannot be edited by a `meta` op. Alternative: a
  chat field, which tabs would then sync and show nowhere.
- **Q2. What a successful reroll keeps.** Proposal: the stash is deleted, and the removed bundle stays in the tab's
  memory for Undo as today. Alternative: keep the last removed bundle on the server so Undo survives a reload; a
  larger change (a bundle store, its retention, and Undo across devices).
- **Q3. A reroll while the feed has no current `hello`.** Proposal: refuse with a notice. Today such a reroll takes
  the lossy removal path even for a single reply. Alternative: keep the client removal path for that case only, as a
  Limitation.
- **Q4. Remote send.** Proposal: unchanged (the tail reroll runs on this tab). Alternative: let a host run it, which
  the server stash now makes possible; the bundle history would still be lost through a host.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guides the slice names, with `pnpm docs:read`.
- Server tests drive the job through `createServerContext` or the runner's existing test helpers, against a real
  SQLite store; tab tests drive `reroll` through the mounted chat screen the existing reroll tests mount.
- Each slice runs its own focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`; the last
  slice runs the whole suite and the browser specs the change reaches.
- No change to `rerollTurnStart`, to the in-place reroll's behavior, or to candidate switching.

## Slices

### 1. The server's tail reroll (_hard_)

- `server/src/routes/generations.ts`: parse `rerollTail` (D1), refuse it with `rerollMessageId` or on another kind.
- `server/src/jobs/generationJobs.ts`: the fingerprint; the refusal code `rerollTailStale`.
- `server/src/data/chatStore.ts`: the stash table, the begin group with its check (D2, D3), the final write and the
  restore (D4), and the open-time restore (D5).
- `server/src/prompt/runner.ts`: the job runs as a send without input after its begin group; one speaker or a group's
  speakers, as `rerollByRemoval`'s send does today.
- `server/src/routes/events.ts`: `rerollTail: true` in `hello` (D7).
- Tests: a group tail is removed and stashed in one transaction; a reply deletes the stash; a provider error, Stop,
  and a lore-budget stop put the tail and its variables back; a stale tail is refused with nothing written; a
  restart with a stash puts it back at open; a snapshot taken mid-job and restored puts it back.
- Done when the server tests pass and an earlier tab (no `rerollTail`) sees no change.

### 2. The tab sends the tail (_medium_)

Depends on 1.

- `DefaultChatScreen.svelte` (`rerollByRemoval`, `reroll`), `src/ts/process/serverGeneration.ts`,
  `src/ts/network/eventFeed.ts`: D6, D7, and the refusal notices (`rerollTailStale`, the missing capability).
- `src/ts/process/rerollHistory.ts`: a bundle begun for a job refused before its first write is dropped, not
  restored.
- Tests: the tab writes no removal before the job's begin group; a refusal leaves the chat and the history as they
  were; Undo and Redo after a successful tail reroll behave as today; no `hello` refuses with the notice (Q3).
- A browser spec in the audit's shape: a bound group chat, the generation request held before the server, the page
  closed; the question and both replies are still in SQLite.

### 3. Guides and close-out (_small_)

- The [chat pipeline](../structure/chat-pipeline.md#reroll), [server generation](../structure/server-generation.md#reroll-in-place)
  and [chat store](../structure/chat-store.md) guides describe the tail reroll and the stash; the known-issues entry is
  deleted; the plan is archived.

## Manual Checks

- A real browser: in a group chat with two replies, press Reroll and close the tab at once; reopen: the replies are
  there (or the new ones, if the job finished).
- The same with the server stopped (`docker stop`) while the replacement streams; after the restart the old replies
  are back.
