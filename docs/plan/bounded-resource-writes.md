# Bounded Resource Writes Plan

Status: drafted 2026-11-24 at `9cdbb289c`. The decisions rest on a contract pre-audit by Astra the same day: a table of
every batch unit against seven delivery timelines, with probes, kept outside the repository with the review reports on
this machine (`/home/codex/review-reports/autosave-deadline-preaudit-2026-11-24/`: `report.md`, `scratch/` probes and
their `README.md`, and the Luna inventory of similar waits under `inventory/`). The owner answered Q1 to Q3 on
2026-11-24 with the proposals (D5 and D7, D10, slice 7). Audited the same day by Astra in three turns and closed by a
final judgment of Claude Fable at the owner's request
([report](../reports/audits/plan-runner/bounded-resource-writes-2026-11-24.md)): the writer fence the first two
revisions added was withdrawn as resting on an untested delivery model, and late delivery of an abandoned request is a
Limitation. Landed: 3 (`86d4bab95`), 1 (`b229e675a`), 6 (`e16f27b11`, test fix `0e10b001d`), 4 (`fedc38ff7`), 5 (`773920c2c`).

Sources: `src/ts/storage/resourceSync.svelte.ts` (`runCycle`, `cycle`, `planBatches`, `noteInDoubt`,
`requeueChatWork` call, `sendSecretOps`, `awaitSecretWrites`, `flushResources`, `saving`), `src/ts/storage/resourceClient.ts`
(`send`, `sendJson`, `applyBatchText`, `sendSecretRequest`, `sendBatchOnUnload`, `ResourceRequestError`),
`src/ts/storage/serverAuth.ts` (`authFetch`, `checkAuth`, `runAuthCheck`, `createAuth`), `src/ts/storage/chatStore.svelte.ts`
(`requeueChatWork`, `markOrderDiscarded`), `src/ts/storage/resourceFlushWait.ts`, `src/ts/storage/browserLocalImport.ts`,
`src/ts/process/chatMemoryInherit.svelte.ts` (`createSettled`), `src/ts/process/rerollHistory.ts`
(`syncRerolledChat`), `src/ts/process/structuredMemory.svelte.ts` (`readAnswer`, `/inherit`, `/restore`),
`src/lib/Others/SavePopupIcon.svelte`, `src/App.svelte`, `server/src/routes/resources.ts`
(`POST /api/resources/batch`), `server/src/routes/llmSecrets.ts`, `server/src/http/body.ts`,
`server/src/data/chatStore.ts` (`chatGroups` receipts and their trimming), read at `9cdbb289c`; the
[resource sync](../structure/resource-sync.md) guide (Save cycle, Lost answers, Batch composition, Unload, Transport,
Known Hazards), the [chat store](../structure/chat-store.md) guide (by-id ops, group replay), the first `network-jobs`
entry of [known issues](../backlog/known-issues.md#network-jobs), and section 2 of the transfer and connection audit of
2026-11-23 (`/home/codex/metatron-stage/audit/`). Identifiers are the anchors; re-verify each cited location before
editing (STRUCTURE.md protocol step 5).

## Goal

No single save attempt holds the tab's save loop without a bound.

- A save attempt has a deadline that a progressing upload on a slow phone connection still meets. After it, the tab
  treats the answer as lost (the existing path) and the loop goes on.
- An abandoned attempt that arrives before its resend, or never, is handled by today's receipts and base revisions; one
  that arrives after its resend and after newer acknowledged work is a Limitation.
- The user sees when a save has not been confirmed, instead of a save loop that is silently stuck.
- The other waits on the save path that have the same shape get bounds; the ones outside it are recorded.

Not goals: resumable or chunked uploads; operation ids for restores (audit item 3); asset acknowledgement recovery
(audit item 4); journaling of record edits while the page is active (audit item 1); late delivery of an abandoned
request after its resend and newer work were acknowledged (Limitations); a proxy that delivers one request twice;
writes from two tabs or two devices to the same field, which keep today's last-arriving contract; the waits listed in
"Outside this plan".

## Current State

- **The save loop.** `runCycle` runs one cycle at a time; every later `runCycle` joins the running `inFlight` promise.
  A cycle sends its batches one after another through `applyBatchText`, then the queued credential writes through
  `sendSecretRequest`, none with a signal or deadline. One unanswered request holds every later save of the tab,
  `flushResources`, `awaitSecretWrites` (and through it `auxFetch`), and keeps the before-unload warning on. Callers a
  user waits on end their own wait after 30 s (`waitForResourceFlush`) and leave the shared write running; reroll
  reply restoration, new-chat memory inheritance and restore, the two browser-local boot migrations, and background
  generation resync wait without a bound. The transfer audit reproduced a 130-second hold of an unrelated chat edit
  behind one held settings answer.
- **Lost answers today.** A transport failure after dispatch, a 5xx, or an unreadable successful response takes the
  lost-answer path; other non-success answers follow their status (409 conflict recovery, 400/413 quarantine). On that
  path a record's sent text and base are kept in doubt (`noteInDoubt`) and resent; a chat group is replayed alone with
  its id and `retry` (`requeueChatWork({ lost: true })`), and the server answers a remembered group (`chatGroups`
  receipt) without applying it again. The pre-audit confirmed this is enough when the original either never arrives or
  arrives before the resend: record updates, patches, `llmSecrets` siblings, appends, replaces, and multi-removes come
  out once in every order it tried. `flushResources` throws at the first cycle that ends with an error.
- **Pre-audit findings** (each reproduced by a failing probe in `deadlineFindings.probe.test.ts` or the contract probes,
  and rerun by the orchestrator):
  - F2 (P2). An unanswered reorder followed by another reorder before the resend: the newer vector is sent on the old
    order revision, conflicts with the first order the server already holds, and is reported discarded. Reachable
    today on any lost answer.
  - F4 (P2). A credential PUT has the same unbounded shape and holds the whole loop just as a batch does.
  - F5 (P2). A fixed 45 s + 128 KiB/s allowance aborts a progressing 8 MiB upload at 64 KiB/s three times in a row and
    strands an unrelated small edit queued behind it.
  - F1, F3, F6 (P1 as filed). A create, a chat group, or a permanent character delete whose original is applied after
    its resend and after newer acknowledged work recreates deleted content, overwrites newer content, or deletes a
    re-added transcript. The probes produce this by applying the original by hand after the client gave up. On the
    real server a request whose body is incomplete when its client leaves is refused by the body read, and a complete
    one is applied within milliseconds of arrival (the only awaits before the synchronous apply are the auth check's
    WebCrypto calls and the body read); a stalled server handles the original and its resends together on resume, in
    the order receipts and bases already cover. These timelines therefore need something that holds a complete
    request after its client left and delivers it later (Limitations).
  - The pre-audit also found that an abort before dispatch must not create doubt (`ResourceRequestError.notSent`).
- **What a lost answer leaves to resend.** While the page lives, a unit of an abandoned batch that is still wanted is
  resent by a later attempt: record texts through `inDoubt` (unless a feed echo or a conflict read settles them), a
  record delete only while the record is still persisted, locally absent, and eligible (a same-id re-add stops it),
  chat groups exactly through `requeueChatWork` (unless the parent's removal or a conflict read retires them), orders
  with their sequence but a vector rebuilt from current membership, credential sets because they stay queued (FIFO,
  after every resource batch of the cycle).
- **Pagehide.** `sendBatchOnUnload` sends eligible by-id groups as keepalive requests whose answers settle through
  `settleUnloadWork`. When the page is restored from the back-forward cache and such an answer never arrives, the chat
  stays in flight (recorded in the resource sync guide's Known Hazards).
- **Indicator.** `saving.state` (re-exported by `globalApi.svelte.ts`) drives `SavePopupIcon.svelte`, which
  `App.svelte` always mounts and which renders only with `settings.ui.showSavingIcon` (off by default) and with
  `pointer-events-none`; `saving.state` turns on before authentication and signing, not at dispatch. Nothing tells a
  stuck save from a slow one.
- **Auth.** `authFetch` joins one shared check per page (`checkAuth`): it reads or creates the signing key locally
  (IndexedDB and WebCrypto), signs, and calls `/api/test_auth`; password setup and login prompt the user, hash through
  `/api/crypto`, and call `/api/set_password` or `/api/login`. None of these steps has a deadline, and `checking`
  clears only when the check settles.

## Decisions

### Late delivery

- **D1. No writer fence.** A request with an incomplete body is refused by the body read; a complete one applies
  within milliseconds of arrival, so the late-original timelines F1, F3, and F6 need a holder that keeps a request
  after its client left. They are a Limitation. A server-side check of the client connection at admission was
  considered and rejected: the Node adapter aborts the request signal only when the response closes, a graceful client
  close leaves it unaborted with the body readable, and where it did fire the body read had already failed. D2 to D4
  are withdrawn; later decisions keep their numbers.

### Deadlines

- **D5. A batch attempt has a deadline that grows with its size** (Q1). Allowance = 45 s + encoded body bytes at
  32 KiB/s, doubled after each consecutive deadline abort of a batch carrying the same unit (at most 8×), reset by an
  answer for that unit. The timer starts when the request is called and covers authentication and signing, the
  upload, the response headers, and both body reads (the success body in `sendJson` and the error body in `send`):
  `applyBatchText` takes a signal that `send` passes to `authFetch` and that stays live through either read, and a
  deadline abort during either read is classified with the recorded dispatch state. An abort after `beforeDispatch`
  becomes `ResourceRequestError` status 0 with `notSent: false` and takes the lost-answer path with backoff; an abort
  before dispatch is `notSent: true`, and the cycle's `lost` predicate (`resourceSync.svelte.ts`, after the quarantine
  branches) creates no new doubt for it while keeping doubt an earlier dispatched attempt created and the conservative
  journal-mark cleanup.
- **D6. New batches are packed smaller.** Batches of new work stop at 4 MiB when they hold more than one unit; a larger
  unit goes alone as today, up to `MAX_BATCH_BYTES`. A lost answer keeps today's resend rules (`noteInDoubt`,
  `requeueChatWork`); no unit is regrouped or moved out of the order `planBatches` gives.
- **D7. A credential write has the same deadline.** `sendSecretRequest` takes a signal with the D5 allowance computed
  from its encoded body; a late original on the old base is refused by the route's base-revision check. An abort
  leaves the queued op in place and ends the cycle as a lost answer; a later cycle sends it again, and a 409 on the old
  base takes today's reread and retry on the fresh base. A resend of a set that had already committed advances the
  revision a second time with the same value; a newer key of the same tab stays queued behind the older one. A key
  another device set in between follows today's last-writer contract of the 409 retry.
- **D8. Keepalive requests stay as they are.** A timer that requeues an unanswered keepalive on a restored page would
  leave its original free to arrive later and reopen F3 for those groups. The restored-page wait stays a recorded Known
  Hazard.

### Order and user feedback

- **D9. A newer reorder is not discarded for an older lost one.** `requeueChatWork` keeps a lost order's sent vector in
  memory beside its sequence; the journal's order layers stay as they are today. When a conflict read follows, the
  server's order equal to the kept vector settles the lost order without a notice, and a newer pending order of the
  same character is never reported discarded because of the lost one: it is sent again on the revision the read
  learned, with a vector built from current membership. Without a newer order, a lost order whose vector differs from
  the server's takes today's discard path.
- **D10. An unconfirmed save is shown** (Q2). The state is on while a save attempt has gone 15 s past its dispatch
  (the dispatch notification of slice 4, after authentication and signing) without an answer, or while work an
  abandoned attempt carried is still in doubt; it turns off when that doubt is settled by any means (an
  acknowledgement, a feed echo, a conflict reconciliation, a quarantine the refused-data banner reports). An empty
  cycle or an unrelated successful write does not clear it. The save icon shows it with a reachable tooltip from
  `src/lang/en.ts` (the save is being retried; keep the tab open), whatever `showSavingIcon` says. The before-unload
  warning keeps its current rules.

### Other waits on the save path

- **D11. The auth check and the follow-on requests get deadlines, and a flush outlasts one lost answer.**
  - In `serverAuth.ts`, a 20 s bound (its own constant) covers the noninteractive steps of the shared check (signing
    key acquisition and signing) and the fetch and body read of `/api/test_auth`, `/api/crypto`, `/api/set_password`,
    and `/api/login`; user prompts stay outside the timers. A check that times out rejects and clears `checking`, so
    the next request starts a new one; an expired check that completes later installs nothing over its replacement
    (`checking`, `authChecked`, or a signing key it was still creating).
  - The `/inherit` and `/restore` requests take a 30 s signal through `readAnswer`, whose contract turns a failure
    into a result.
  - `flushResources` does not throw at the first lost answer: it waits out the backoff and continues within its
    10-attempt budget, so `createSettled` and `syncRerolledChat` stay as they are.
  - The browser-local migrations' verification reads take a 30 s bound and keep the browser-local source on failure.
    Background resync already retries a rejected flush.

### Limitations

- An abandoned request that reaches the server after its resend and newer acknowledged work is applied as today: F1,
  F3, and F6 remain possible when a transport or intermediary holds a complete request after its client left.
- Each attempt's wait is bounded, but the loop keeps its order: a unit whose every attempt goes unanswered (an upload
  slower than 8× its allowance, or a server that never answers it) keeps the work planned after it waiting, including
  another credential path; work planned before it proceeds. The unconfirmed indicator stays on.
- A credential resend can advance the `llmSecrets` revision twice with the same value (D7).
- Keepalive requests and the restored-page wait stay as today (D8).

### Questions the owner answered

- **Q1. Deadline numbers.** 45 s base, 32 KiB/s for the body, doubling up to 8× after consecutive aborts (owner,
  2026-11-24, as proposed). A slower assumed rate would protect very slow links further and make a stuck save take
  longer to notice.
- **Q2. The unconfirmed indicator.** Shown even when the saving icon is turned off, since it reports a save that may
  not have happened (owner, 2026-11-24, as proposed). Alternative: follow `showSavingIcon`.
- **Q3. The waits outside this plan.** Recorded in `docs/backlog/found-issues.md` by the close-out slice, grouped by
  area, for a later round (owner, 2026-11-24, as proposed). Alternative: a second plan now.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the [resource sync](../structure/resource-sync.md) guide's sections the slice touches and
  the [chat store](../structure/chat-store.md) guide for chat groups, with `pnpm docs:read`.
- The pre-audit probes in `/home/codex/review-reports/autosave-deadline-preaudit-2026-11-24/scratch/` (see its
  `README.md`) are the starting point for the regression tests of F2, F4, and F5, built on `storeBackedServer.ts`
  (`holdNextBatchResponse`, `releaseBatchResponse`) and `mutationStoresHarness.ts`. F5's probe hard-codes the rejected
  128 KiB/s formula; slice 4 lets the production deadline drive cancellation instead. The F1, F3, and F6 probes stay
  outside the repository as the record of the Limitation. A slice turns the probes of its findings into tests that
  fail before its change (V6) and pass after, in the test files the guide's Tests section names; probe files
  themselves are not committed.
- Each slice runs its focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`. The last code
  slice runs the whole suite (V1).
- User-visible strings go in `src/lang/en.ts` (U2).

## Slices

Order: 1, 3, and 6 side by side; then 4 after 3 and 6; then 5 after 4; then 7. Files more than one slice edits:
`src/ts/storage/resourceSync.svelte.ts` (3, 4, 5, 6) and `src/ts/storage/resourceClient.ts` (3, 4). Slices 3 and 6
both edit `resourceSync.svelte.ts` (3 in `sendSecretOps`, 6 in `flushResources`); run them side by side only in
separate worktrees and land 6 before 4. Slice 1 alone edits `src/ts/storage/chatStore.svelte.ts`; slice 6 alone edits
`src/ts/storage/serverAuth.ts`; slice 5 alone edits `src/lang/en.ts`. Slice 2 was withdrawn with the writer fence; the
numbers of the others are kept.

### 1. A newer reorder survives a lost one (_small_)

- `src/ts/storage/chatStore.svelte.ts` (`requeueChatWork`, the order conflict recovery and `markOrderDiscarded`): D9.
- Tests: F2's probe as a regression test (reorder, answer lost after commit, reorder back before the resend: the newer
  order is stored and nothing is reported discarded); the same with the first order never applied; a lost reorder
  followed by a sibling create, with the first order committed and with it unapplied, ends with the newer order and a
  valid vector; a lost order with no newer order still settles quietly on an equal readback and is still reported
  discarded when it differs.

### 3. Credential write deadline (_small_)

- `src/ts/storage/resourceClient.ts` (`sendSecretRequest`), `src/ts/storage/resourceSync.svelte.ts` (`sendSecretOps`):
  D7.
- Tests: F4's probe as a regression test (a held credential PUT no longer holds an unrelated chat edit past the
  deadline; the stored key is the one the user set; a late original on the old base gets 409); `awaitSecretWrites`
  rejects the timed-out wait while the op stays queued.

### 4. Batch deadline and packing (_hard_)

Depends on 3 and 6.

- `src/ts/storage/resourceClient.ts` (`applyBatchText`, `send`, `sendJson`, a dispatch notification for both
  transports), `src/ts/storage/resourceSync.svelte.ts` (`cycle`, `planBatches`, the `lost` predicate, `runCycle`'s
  backoff): D5, D6.
- Note: a deadline abort keeps a lone create's in-doubt replay ahead of its held reorder, as today.
- Tests: the transfer audit's held-settings probe as a regression test (the later chat edit reaches the store after the
  deadline; the settings write and an append each appear once whether the original committed before or after the
  resend); a healthy 8 MiB upload at 64 KiB/s that is already dispatched completes on its first allowance; a slower
  one completes on a doubled allowance; new multi-unit batches stop at 4 MiB and a larger unit goes alone; an abort
  before dispatch creates no doubt; an abort during either body read is classified by dispatch state; the dispatch
  notification fires after signing, not before. The deadline arithmetic is tested directly, not through long
  fake-timer runs.

### 5. Unconfirmed save indicator (_small_)

Depends on 4.

- `src/ts/storage/resourceSync.svelte.ts` (an exported unconfirmed state beside `saving`, fed by slice 4's dispatch
  notification), `src/lib/Others/SavePopupIcon.svelte`, `src/lang/en.ts`: D10.
- Tests: the state turns on 15 s after dispatch without an answer and while abandoned work is in doubt; an
  authentication wait longer than 15 s before dispatch does not turn it on; it stays on through an empty cycle and an
  unrelated successful write; it turns off when the doubt settles by an acknowledgement and by a matching feed echo
  with no later write; the icon shows it, with its tooltip, when `showSavingIcon` is off.

### 6. Other waits on the save path (_small_)

- `src/ts/storage/serverAuth.ts`, `src/ts/process/structuredMemory.svelte.ts` (`/inherit`, `/restore`),
  `src/ts/storage/resourceSync.svelte.ts` (`flushResources`), `src/ts/storage/browserLocalImport.ts` (verification
  reads): D11.
- Notes for `flushResources`: wait until `backoffUntil` before the next `runCycle` (a direct call ignores it); count a
  failed cycle toward the 10 even when it wrote nothing, so the loop ends; still throw at once on a permanent error, a
  quarantine, a halt, and `GenerationBlockedError`.
- Tests: a held `/api/test_auth` and a held signing step each make the waiting requests settle by the deadline, and the
  next request checks again; an expired check that completes later leaves its replacement's state; a held `/inherit`
  answer settles the new-chat flow through its failure result; a flush whose first cycle loses its answer and whose
  second succeeds resolves; ten lost cycles reject; a held migration verification read settles by its deadline and
  leaves the browser-local source in place.

### 7. Guides, backlog, and close-out (_small_)

Depends on 1, 3, 4, 5, and 6.

- The [resource sync](../structure/resource-sync.md) guide (Save cycle, Lost answers, Batch composition, Unload,
  Transport, Known Hazards), the [chat store](../structure/chat-store.md) guide (group replay), and the
  [network and jobs](../structure/network-jobs.md) guide describe the deadlines, packing, the flush's continuation, and
  the indicator, and carry the Limitations into their Known Hazards.
- `docs/backlog/known-issues.md`: the `network-jobs` entry on the unanswered batch is removed or narrowed to what is
  left. `docs/backlog/found-issues.md`: the waits in "Outside this plan", grouped by area (Q3).
- Unrun manual checks go to `docs/backlog/manual-checks.md`. The plan runner retires the plan through
  `docs/plan/README.md` and `docs/archived-plan/README.md` after the run, with the owner's yes; this slice leaves both
  files alone.

## Outside this plan

The Luna inventory of 2026-11-24 found the same "one silent request holds a shared queue" shape off the save loop.
Most hold only their own feature; two can also hold saves for a while, and D5's deadlines bound each save's wait while
they recover:

- Client: checkpoint dialog requests and the global checkpoint-load busy flag; Structured Memory pane edits and the
  memory task start/cancel `exclusive` map; the plugin permission queue; module, CharX, and Realm import uploads and
  the upstream backup prepare; the asset save queue and the four-slot asset preview queue; rendered translation slots;
  the MCP tab handshake and OAuth fetches; the push notification queue.
- Server: the snapshot `exclusive` chain (a restore's maintenance gate refuses resource writes while it is held), the
  restore queue, and the shared import slot; `orderedWriter`'s per-key and global slots (login's key registration uses
  it, and a stalled registration holds the shared auth check); asset path leases and thumbnail generation slots;
  memory task and tokenizer worker lanes; translation runner capacity.

## Manual Checks

- Desktop Chromium with DevTools throttling at a custom 64 KiB/s upload: import a chat of about 8 MiB, then edit
  another chat. The import saves without a manual retry, and the other edit saves after it.
- A phone over the Cloudflare tunnel: edit a chat, switch to airplane mode within a second, wait a minute, switch it
  off. The icon shows the unconfirmed state, then clears; the message appears once.
- Pause the server process (`kill -STOP`) right after editing a chat's author note, wait two minutes, edit the note
  again, and resume it (`kill -CONT`). The note keeps the second edit after a reload.
