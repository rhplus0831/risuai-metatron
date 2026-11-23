# Bounded Resource Writes Plan

Status: drafted 2026-11-24 at `9cdbb289c`. The decisions rest on a contract pre-audit by Astra the same day: a table of
every batch unit against seven delivery timelines, with probes, kept outside the repository with the review reports on
this machine (`/home/codex/review-reports/autosave-deadline-preaudit-2026-11-24/`: `report.md`, `scratch/` probes and
their `README.md`, and the Luna inventory of similar waits under `inventory/`). The owner answered Q1 to Q3 on
2026-11-24 with the proposals (D5 and D7, D10, slice 7). Audited the same day by Astra in two turns
([report](../reports/audits/plan-runner/bounded-resource-writes-2026-11-24.md)); the corrections after the second turn
(the explicit supersede of D2, D6's retry rule, D9's narrowing, D10's clearing rule, D11's flush handling) were not
read again. Changes of scope for the owner to confirm: the fence covers one page's life only (D4), keepalive requests
stay as they are (D8), and the Limitations from the audit's A19, A22, and A23. Landed: none.

Sources: `src/ts/storage/resourceSync.svelte.ts` (`runCycle`, `cycle`, `planBatches`, `batchBody`, `noteInDoubt`,
`requeueChatWork` call, `sendSecretOps`, `awaitSecretWrites`, `flushResources`, `saving`), `src/ts/storage/resourceClient.ts`
(`send`, `sendJson`, `applyBatchText`, `sendSecretRequest`, `sendBatchOnUnload`, `ResourceRequestError`),
`src/ts/storage/serverAuth.ts` (`authFetch`, `checkAuth`, `runAuthCheck`, `createAuth`), `src/ts/storage/chatStore.svelte.ts`
(`requeueChatWork`, `markOrderDiscarded`), `src/ts/storage/tests/storeBackedServer.ts`,
`src/ts/storage/resourceFlushWait.ts`, `src/ts/storage/browserLocalImport.ts`,
`src/ts/process/chatMemoryInherit.svelte.ts` (`createSettled`), `src/ts/process/rerollHistory.ts`
(`syncRerolledChat`), `src/ts/process/structuredMemory.svelte.ts` (`readAnswer`, `/inherit`, `/restore`),
`src/lib/Others/SavePopupIcon.svelte`, `src/App.svelte`, `server/src/routes/resources.ts`
(`POST /api/resources/batch`, `assertMutable`), `server/src/routes/llmSecrets.ts`, `server/src/data/resourceStore.ts`
(`applyChanges`, every-open setup, `replaceAll`), `server/src/data/chatStore.ts` (`chatGroups` receipts and their
trimming), read at `9cdbb289c`; the [resource sync](../structure/resource-sync.md) guide (Save cycle, Lost answers,
Batch composition, Unload, Transport, Known Hazards), the [chat store](../structure/chat-store.md) guide (by-id ops,
group replay), the first `network-jobs` entry of [known issues](../backlog/known-issues.md#network-jobs), and section 2
of the transfer and connection audit of 2026-11-23 (`/home/codex/metatron-stage/audit/`). Identifiers are the anchors;
re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

No single save attempt holds the tab's save loop without a bound, and a request the page abandoned and then sent again
cannot undo newer work of the same page when the abandoned copy reaches the server late.

- A save attempt has a deadline that a progressing upload on a slow phone connection still meets. After it, the tab
  treats the answer as lost (the existing path) and the loop goes on.
- Once the page has sent an abandoned attempt's work again, the server refuses the abandoned attempt, so it cannot
  recreate deleted content, overwrite a newer edit, or delete re-added content.
- The user sees when a save has not been confirmed, instead of a save loop that is silently stuck.
- The other waits on the save path that have the same shape get bounds; the ones outside it are recorded.

Not goals: resumable or chunked uploads; operation ids for restores (audit item 3); asset acknowledgement recovery
(audit item 4); journaling of record edits while the page is active (audit item 1); late requests of an earlier page
life or of another tab or device (D4); a proxy that delivers one request twice; writes from two tabs or two devices to
the same field, which keep today's last-arriving contract; the waits listed in "Outside this plan".

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
  out once in every order it tried.
- **Where it is not enough** (pre-audit findings, each reproduced by a failing probe in `deadlineFindings.probe.test.ts`
  or the contract probes, and rerun by the orchestrator):
  - F1 (P1). A create whose original arrives after the resend created it and the user then permanently deleted it
    recreates the deleted chat (`deadlineFindings`, F1) or character with its chat (`deadlineContract`, N2): a null
    base only checks that the row is absent, and the receipt goes with the deleted row.
  - F2 (P2). An unanswered reorder followed by another reorder before the resend: the newer vector is sent on the old
    order revision, conflicts with the first order the server already holds, and is reported discarded. Also reachable
    today on any lost answer.
  - F3 (P1). A late original chat group overwrites newer content: after its resend was refused under a generation lock
    (the job's finished reply is overwritten by the stale manual edit), or after 100 later groups trimmed its receipt
    (the author note reverts to a one-character value).
  - F4 (P2). A credential PUT has the same unbounded shape and holds the whole loop just as a batch does.
  - F5 (P2). A fixed 45 s + 128 KiB/s allowance aborts a progressing 8 MiB upload at 64 KiB/s three times in a row and
    strands an unrelated small edit queued behind it.
  - F6 (P1). A permanent character delete whose original arrives after the user re-added the same id with identical
    parent fields and a new transcript deletes the acknowledged transcript: a delete is never held in doubt, and a
    chat-only change does not advance the parent revision.
  - The pre-audit also found that an abort before dispatch must not create doubt (`ResourceRequestError.notSent`), and
    that the batch route checks auth, reads the whole body, then applies everything in one synchronous SQLite
    transaction (`BEGIN IMMEDIATE`) with no await between the epoch check and the commit; the credential PUT route
    likewise reads its body before a synchronous epoch check, read, and write.
- **What a lost answer leaves to resend.** While the page lives, a unit of an abandoned batch that is still wanted is
  resent by a later attempt: record texts through `inDoubt` (unless a feed echo or a conflict read settles them), a
  record delete only while the record is still persisted, locally absent, and eligible (a same-id re-add stops it),
  chat groups exactly through `requeueChatWork` (unless the parent's removal or a conflict read retires them), orders
  with their sequence but a vector rebuilt from current membership, credential sets because they stay queued (FIFO,
  after every resource batch of the cycle). No later request of today's loop carries all of an abandoned batch's units
  together, and a page that closes takes with it the units only it held: record kinds the draft journal excludes
  (`journalEligibility.ts`), oversized journal content, and credential plaintext.
- **Pagehide.** `sendBatchOnUnload` sends eligible by-id groups as unfenced keepalive requests whose answers settle
  through `settleUnloadWork`. When the page is restored from the back-forward cache and such an answer never arrives,
  the chat stays in flight (recorded in the resource sync guide's Known Hazards).
- **Indicator.** `saving.state` (re-exported by `globalApi.svelte.ts`) drives `SavePopupIcon.svelte`, which
  `App.svelte` always mounts and which renders only with `settings.ui.showSavingIcon` (off by default) and with
  `pointer-events-none`; `saving.state` turns on before authentication and signing, not at dispatch. Nothing tells a
  stuck save from a slow one.
- **Auth.** `authFetch` joins one shared check per page (`checkAuth`): it reads or creates the signing key locally
  (IndexedDB and WebCrypto), signs, and calls `/api/test_auth`; password setup and login prompt the user, hash through
  `/api/crypto`, and call `/api/set_password` or `/api/login`. None of these steps has a deadline, and `checking`
  clears only when the check settles.

## Decisions

### Writer fence

- **D1. Every save-loop request names its page and attempt.** The batch POST and the credential PUT carry
  `X-Risu-Writer` (an id minted when the page starts, `newId()`) and `X-Risu-Attempt` (a counter that starts at 1 and
  increases by one for each dispatch of either request). The save loop dispatches these requests one at a time.
  Keepalive requests, the credential DELETE, direct routes (chat trash, plugin permission and inlay resource writes,
  imports, backups, MCP), and requests without the headers (older tabs, scripts, end-to-end seeders) are not fenced
  and supersede nothing.
- **D2. A later request supersedes an abandoned attempt by naming it.** A request that carries every still-wanted unit
  of an attempt this page abandoned (D6) adds `X-Risu-Supersedes: <attempt>[,<attempt>...]` (at most 16, each below its
  own attempt). The server keeps `supersededAttempts (writer TEXT NOT NULL, attempt INTEGER NOT NULL, touchedAt
INTEGER NOT NULL, PRIMARY KEY (writer, attempt))` in the resource database, created on every open (not in
  `STORE_TABLES_SQL`, which runs only on a fresh database), pruned of rows untouched for 30 days at open, and cleared
  inside `replaceAll`'s epoch-changing transaction. In the batch route and the credential PUT route, after the epoch
  check and before any write is prepared, in the same synchronous block as the store call, one production admission
  function:
  - with neither `X-Risu-Writer` nor `X-Risu-Attempt`, admits the request as today;
  - otherwise requires both, a writer of 1 to 64 characters of `[A-Za-z0-9-]`, a positive safe-integer attempt, and a
    well-formed `X-Risu-Supersedes`, and answers `400` before raising or writing anything when one is malformed;
  - answers `409 { error: "superseded" }` with nothing applied when this request's own `(writer, attempt)` is in the
    table;
  - otherwise inserts the named attempts in its own completed statement before the data transaction, so a later
    conflict or rollback of the data keeps them, and goes on.
    Naming is explicit, so a request never refuses work it does not carry: an unrelated later batch does not fence an
    abandoned credential PUT, and an attempt whose units were never sent again stays admissible, as today.
- **D3. A superseded answer is read as a lost answer.** Both client paths decode `superseded` before the generic 409
  conflict parsing and turn it into a `ResourceRequestError` of status 0 with `notSent: false`, so the work stays in
  doubt and goes through the lost-answer path. Only an attempt the page abandoned can be superseded, so this answer
  normally has no reader.
- **D4. No fence across page lifetimes.** A reload, another tab, or a tab that adopts a closed tab's journal rows never
  names an earlier page's attempts: it cannot know that it carries all of their units, and refusing them would drop
  units only that page held. A late original of an earlier page is applied as today (Limitations).

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
- **D6. An abandoned batch is retried whole, and new batches are packed smaller.** When a dispatched batch ends as a
  lost answer (a deadline abort, a transport failure, a 5xx, an unreadable success, or a `superseded` answer), the page
  remembers its attempt number with the units it carried. The units of that attempt that are still wanted (not since
  acknowledged, echoed, reconciled, quarantined, or retired by their owner's removal) are sent again together in one
  batch of their own, in the place `planBatches` gives the earliest of them, and that batch names the attempt (D2). A
  retry that ends as a lost answer is retried the same way and names both attempts. Batches of new work stop at 4 MiB
  when they hold more than one unit; a larger unit goes alone as today, up to `MAX_BATCH_BYTES`. No unit is moved out
  of its planned order: sibling chat creates carry insertion indices computed from their order, and the guide's other
  order rules (a character before its chats, a chat's resend before its newer work, reorders behind in-doubt creates
  and deletes, owner records before credential sets) stay as they are.
- **D7. A credential write has the same deadline and fence.** `sendSecretRequest` takes a signal with the D5 allowance
  computed from its encoded body, and D1's headers; its resend after a lost answer names the abandoned PUT's attempt
  (D2). An abort leaves the queued op in place and ends the cycle as a lost answer; a later cycle sends it again, and a
  409 on the old base takes today's reread and retry on the fresh base. A resend of a set that had already committed
  advances the revision a second time with the same value; a newer key of the same tab stays queued behind the older
  one. A key another device set in between follows today's last-writer contract of the 409 retry.
- **D8. Keepalive requests stay as they are.** A timer that requeues an unanswered keepalive on a restored page would
  leave its original free to arrive later, unfenced, and reopen F3 for those groups. The restored-page wait stays a
  recorded Known Hazard.

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

- **D11. The auth check and the follow-on requests get deadlines, and their callers outlast one failed cycle.**
  - In `serverAuth.ts`, a 20 s bound (its own constant) covers the noninteractive steps of the shared check (signing
    key acquisition and signing) and the fetch and body read of `/api/test_auth`, `/api/crypto`, `/api/set_password`,
    and `/api/login`; user prompts stay outside the timers. A check that times out rejects and clears `checking`, so
    the next request starts a new one; an expired check that completes later installs nothing over its replacement
    (`checking`, `authChecked`, or a signing key it was still creating).
  - The `/inherit` and `/restore` requests take a 30 s signal through `readAnswer`, whose contract turns a failure
    into a result. `createSettled` treats a flush rejection from a lost answer like its `GenerationBlockedError`
    case: it waits while the chat has unacknowledged work, bounded by D5's allowance for a retry, and then asks the
    server, whose `chatGone` answer decides.
  - `syncRerolledChat` runs its stale-chat refresh even when the flush rejects, so a deadline elsewhere does not make
    reply restoration unsafe by itself; the refresh keeps its read deadline.
  - The browser-local migrations' verification reads take a 30 s bound and keep the browser-local source on failure.
    Background resync already retries a rejected flush.

### Limitations

- A late original of an earlier page life of the same tab, of a closed tab, or of another device is applied when it
  arrives, as today (D4); F1, F3, and F6 remain possible on that path.
- Protection starts when the request that names an abandoned attempt passes admission. Until then the abandoned
  attempt may still apply, including after a local same-id re-add that has not reached the server; the existing
  missing-parent discard and recovery rules apply in that interval.
- Each attempt's wait is bounded, but the loop keeps its order: a unit whose every attempt goes unanswered (an upload
  slower than 8× its allowance, or a server that never answers it) keeps the work planned after it waiting, including
  another credential path; work planned before it proceeds. The unconfirmed indicator stays on.
- A proxy that delivers one request twice is not guarded: the duplicate is admitted, and an answer to the duplicate
  read by the page is handled as today.
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
  `README.md`) are the starting point for each slice's regression tests: `deadlineFindings.probe.test.ts` holds one
  failing reproduction per finding, and `deadlineContract.probe.test.ts` the contract matrix (its N2 asserts today's
  unsafe character outcome and is reversed when it becomes a test), built on `storeBackedServer.ts`
  (`holdNextBatchResponse`, `releaseBatchResponse`) and `mutationStoresHarness.ts`. F5's probe hard-codes the rejected
  128 KiB/s formula; slice 4 lets the production deadline drive cancellation instead. A slice turns the probes of its
  findings into tests that fail before its change (V6) and pass after, in the test files the guide's Tests section
  names; probe files themselves are not committed.
- Each slice runs its focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`. The last code
  slice runs the whole suite (V1).
- User-visible strings go in `src/lang/en.ts` (U2).

## Slices

Order: 1, 2, and 6 side by side; then 3 after 2; then 4 after 2 and 3; then 5 after 4; then 7. Files more than one
slice edits: `src/ts/storage/resourceSync.svelte.ts` (2, 3, 4, 5) and `src/ts/storage/resourceClient.ts` (2, 3, 4),
kept apart by that order. Slice 1 alone edits `src/ts/storage/chatStore.svelte.ts`; slice 6 alone edits
`src/ts/storage/serverAuth.ts` (slice 2 adds its headers in `resourceClient.ts`); slice 5 alone edits
`src/lang/en.ts`.

### 1. A newer reorder survives a lost one (_small_)

- `src/ts/storage/chatStore.svelte.ts` (`requeueChatWork`, the order conflict recovery and `markOrderDiscarded`): D9.
- Tests: F2's probe as a regression test (reorder, answer lost after commit, reorder back before the resend: the newer
  order is stored and nothing is reported discarded); the same with the first order never applied; a lost reorder
  followed by a sibling create, with the first order committed and with it unapplied, ends with the newer order and a
  valid vector; a lost order with no newer order still settles quietly on an equal readback and is still reported
  discarded when it differs.

### 2. Writer fence (_hard_)

- A module beside `server/src/data/resourceStore.ts` for the `supersededAttempts` table and the admission function,
  opened from the store's every-open setup and cleared in `replaceAll`; `server/src/routes/resources.ts` and
  `server/src/routes/llmSecrets.ts` call the admission function (D2). `shared/`: the header names and the
  `superseded` answer.
- `src/ts/storage/resourceClient.ts` (`applyBatchText`, `sendSecretRequest`, the headers, the `superseded` decoding),
  `src/ts/storage/resourceSync.svelte.ts` (the page writer id and counter, the abandoned attempt numbers of D6, the
  whole retry and its naming): D1, D2's client side, D3, D6's retry rule.
- `src/ts/storage/tests/storeBackedServer.ts`: its batch and credential handlers run their final epoch check and the
  production admission function together, after every delay hook, with the request's headers, so the
  delayed-delivery tests exercise the real admission.
- Tests: server route tests on both routes for a superseded attempt (refused, nothing applied), a named attempt kept
  after a data conflict rolls back, a request without headers unchanged, each malformed header answered 400 with no
  row and no write, pruning, the table on an existing database, and its clearing by a successful restore (kept by a
  rolled-back one); a held old-epoch request released after a restore gets 412 and creates no row. Client tests: F1
  (chat, and the character case from N2 with its assertion reversed), F3 (both reproductions), and F6 as regression
  tests, with the abandonment simulated as a lost answer after dispatch (the fetch rejects while the store-backed
  server applies the original later); the retry of an abandoned mixed batch carries all its still-wanted units and
  names it; an unrelated batch admitted after an abandoned credential PUT does not refuse that PUT; a `superseded`
  answer read by the page keeps the work in doubt. The existing lost-answer tests stay green.

### 3. Credential write deadline (_small_)

Depends on 2.

- `src/ts/storage/resourceClient.ts` (`sendSecretRequest`), `src/ts/storage/resourceSync.svelte.ts` (`sendSecretOps`):
  D7.
- Tests: F4's probe as a regression test (a held credential PUT no longer holds an unrelated chat edit past the
  deadline; the stored key is the one the user set; a late original after its named resend is refused);
  `awaitSecretWrites` rejects the timed-out wait while the op stays queued.

### 4. Batch deadline and packing (_hard_)

Depends on 2 and 3.

- `src/ts/storage/resourceClient.ts` (`applyBatchText`, `send`, `sendJson`, a dispatch notification for both
  transports), `src/ts/storage/resourceSync.svelte.ts` (`cycle`, `planBatches`, the `lost` predicate, `runCycle`'s
  backoff): D5, D6's packing.
- Tests: the transfer audit's held-settings probe as a regression test (the later chat edit reaches the store after the
  deadline; the settings write and an append each appear once whether the original committed before or after the
  resend); a healthy 8 MiB upload at 64 KiB/s that is already dispatched completes on its first allowance; a slower
  one completes on a doubled allowance; new work packs into batches of at most 4 MiB; an abort before dispatch creates
  no doubt; an abort during either body read is classified by dispatch state; the dispatch notification fires after
  signing, not before. The deadline arithmetic is tested directly, not through long fake-timer runs.

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
  `src/ts/process/chatMemoryInherit.svelte.ts` (`createSettled`), `src/ts/process/rerollHistory.ts`
  (`syncRerolledChat`), `src/ts/storage/browserLocalImport.ts` (verification reads): D11.
- Tests: a held `/api/test_auth` and a held signing step each make the waiting requests settle by the deadline, and the
  next request checks again; an expired check that completes later leaves its replacement's state; a held `/inherit`
  answer settles the new-chat flow through its failure result; a new chat whose create is acknowledged while an
  unrelated request of the same flush times out still gets its memory inheritance; a removal reroll whose flush is
  rejected still refreshes the chat and restores the replies; a held migration verification read settles by its
  deadline and leaves the browser-local source in place.

### 7. Guides, backlog, and close-out (_small_)

Depends on 1 to 6.

- The [resource sync](../structure/resource-sync.md) guide (Save cycle, Lost answers, Batch composition, Unload,
  Transport, Known Hazards), the [chat store](../structure/chat-store.md) guide (group replay and the writer fence),
  the [server resources](../structure/server-resources.md) guide (the `supersededAttempts` table, if it owns the store's
  tables), and the [network and jobs](../structure/network-jobs.md) guide describe the fence, the deadlines, packing,
  and the indicator, and carry the Limitations into their Known Hazards.
- `docs/backlog/known-issues.md`: the `network-jobs` entry on the unanswered batch is removed or narrowed to what is
  left. `docs/backlog/found-issues.md`: the waits in "Outside this plan", grouped by area (Q3).
- The plan is retired through `docs/plan/README.md` and `docs/archived-plan/README.md`; unrun manual checks go to
  `docs/backlog/manual-checks.md`.

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
