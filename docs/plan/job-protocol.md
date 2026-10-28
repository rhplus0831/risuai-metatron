# Job Protocol Plan

Status: drafted 2026-10-28. Landed: Slice 1 (`d0b6c096c`; the running request-id index moves to
Slice 2, which first fills request ids), Slice 2 (`b532a95e2`; after an unanswered attempt, a
412, 429, auth or 5xx answer stays `unknown`, since those come before the request-id lookup), Slice
2b (`fdf7a1235`; composer rows store `requestEpoch` and a restore drops another epoch's request id,
because a reloaded page posts with the current epoch, so D4's 412 does not refuse it), Slice 3
(`d4586f152`; error and abort terminals also carry `sequence { total, sent }` so a `shutdown`
outcome reports progress, and a done sequence takes one automatic checkpoint since the slot is held
between parts). The user
accepted every recommendation for Q1–Q4 the
same day (see **Answered questions**). A Sol review of the first
draft (24 points, 3 blockers) is folded in. Most notably, follow-ups run as one sequence job instead
of a chain of jobs (see **Review record**).

Sources: findings F15 and F16 and the "Restart preserves checkpoints, not the complete running
job" note of the [server/client stabilization audit](../research/deep-audit/server-client-stabilization.md)
(at `c1a1d5d6c`), and TJ06 of the [server migration audit](../research/deep-audit-with-fable/server-migration-audit.md)
(at `ff7cb9d20`), which the archived Deep Audit Fixes plan deferred here
(`git show ca5b656fa:docs/plan/deep-audit-fixes.md`, **Deferred**). It also answers the
HaejeokRisuai survey's open question 2 (cross-device stop, candidate A13). Code anchors were
checked at `24f6651f3`; verify them again before editing (STRUCTURE.md protocol step 5).

Owning guides: [self-host server](../structure/self-host-server.md) (job registry, routes, the
channel, state on disk), [chat-pipeline](../structure/chat-pipeline.md) (the job client, follow,
follow-ups, Stop), [plugins and MCP](../structure/plugins-mcp.md) (provider callbacks),
[diagnostics](../structure/diagnostics.md) (job events). Each slice updates the guide whose
contract it changes; Slice 6 only closes.

## Goal

- A create whose answer was lost is found again instead of run twice.
- A command job's `/multisend` parts run to the end on the server, whether or not the page is
  open, as long as no part needs a browser callback (plugin hooks, a plugin provider, WebLLM).
  A part that needs one and finds no page stops the sequence and reports how far it got.
- A tab that died during a callback frees its chat in minutes, not 30.
- Another of the user's tabs or devices can stop the chat's job.
- After a restart, a job that was running reads as ended by the restart.

Not goals: resuming a running generation across a server restart; watching another device's
stream live (PocketRisu §2.3, a later plan); moving page-owned loops (the typed `/multisend`, the
PO file run, plugin `sendChat`, DevTool autopilot) to the server.

## Current state

- **Create.** `createGenerationJob` (`src/ts/network/generationJobs.ts`) POSTs
  `/api/generations` with `kind`, `context`, `hooks`, optional `command`, and the tab's `clientId`.
  The `clientId` is per tab, in `sessionStorage`; a new one is minted only when that key is
  missing, for example when a relaunched browsing context lost its session storage. The server
  mints the job id (`randomUUID()` in `server/src/jobs/generationJobs.ts` `create`), and the tab
  first learns it from the response body. The create body has no request id (`shared/jobs.ts`
  `GenerationCreateBody`). `runPinnedServerJob` (`src/ts/process/serverCommands.ts`) turns a create
  with no answer into `outcome: "unknown"`, which `serverGeneration.ts` reports as
  `refusal: "ambiguous"`. The composer keeps the draft and its `userMessageId` (`sendDraft.ts`:
  same text, same id). It puts the draft back only when the input did not land, the same chat is
  still selected, and the composer is empty.
- **Admission** (`create`, synchronous from the first check to the slot install; the runner starts
  on a later microtask). The order of checks:
  1. The gate (503) and the epoch (412).
  2. The hooks (400) and the chat's existence (404).
  3. The chat slot: 409 `chatBusy` with the running job's id.
  4. `context.chatRevision` against the stored revision: 409 `stale`.
  5. The binding and the orphaned overrides.

  A retry while the first job runs gets `chatBusy`; the tab reads that job's status with its own
  `clientId` and follows it if the read succeeds. Once the job has ended and the tab has read the
  new revision, the same send is admitted again. The runner skips the input stage when the chat
  already holds a user message with `userMessageId` (`server/src/prompt/runner.ts`; another role
  under that id is a 409), so the input is not appended twice, but a second reply is generated.

- **Kept outcomes.** An ended job stays readable for at least 60 s (`JOB_DONE_GRACE_MS`, collected
  on the 30 s GC tick). From collection, a trimmed outcome (`keptTerminal`) stays in the in-memory
  `kept` map for 24 h (`KEPT_OUTCOME_MS`, at most `MAX_KEPT_OUTCOMES` = 500, cleared on an epoch
  change). A restart forgets running jobs and kept outcomes alike: the tab gets 404, treats the job
  as gone, and shows the neutral `serverJob.endedAway`. Nothing on disk is an authoritative job
  registry. The diagnostics journal records events; `save/data/request-history.sqlite` records
  request outcomes and marks `pending` rows `interrupted` at open; the chat store keeps message
  generation fences. None of them is the job's terminal.
- **Follow-ups.** Lua `/multisend` inside a command job queues `{ clear, parts }`
  (`server/src/jobs/runSetup.ts` `multisend`: at most 64 parts of at most 100,000 characters).
  Both terminal producers in `commandRunner.ts` return them as `followUps`. `followJobToEnd`
  (`serverCommands.ts`) starts `runFollowUps` without awaiting it and catches errors with
  `console.error`. For each part, `runMultisend` (`src/ts/process/command.ts`) checks the chat
  (exists, `isChatBusy`, orphaned overrides), removes every message on `clear`, appends the part
  as a user message, and calls `sendChat` with empty input. It stops at the first part that does
  not send. Each part is a full tab send:
  - it takes a local send entry;
  - it counts the `messages` statistic;
  - it flushes and checks the binding and local refusals (`runPinnedServerJob`);
  - it seeds the stage;
  - it installs the reply's alternatives through `addRerolls` (`serverGeneration.ts`).

  A reload drops whatever is left (the code says so). A kept outcome whose follow-ups were over
  64 KiB carries `followUpsDropped` instead. chat-pipeline Known Hazards also records that a stale
  feed lock can make `isChatBusy` drop the follow-ups silently.

- **Callbacks** (`server/src/jobs/channel.ts`).
  - Each `clientId` has one lane. Roots queue with `deadline: Infinity` and take a deadline only at
    dispatch (`CALLBACK_TIMEOUT_MS` 60 s, questions 120 s).
  - A plugin-provider call uses `PROVIDER_CALLBACK_TIMEOUT_MS` = 30 min
    (`server/src/llm/requests.ts`), as long as `JOB_MAX_DURATION_MS`.
  - A socket `close` only removes the socket (`generationJobs.ts`). An outstanding request settles
    at its deadline: `timedOut` with an owner socket attached, `disconnected` without one, in which
    case the client's ownerless queued roots settle with it.
  - A delivered callback settled without its answer keeps the lane until the tab reports it
    drained, or for at most `CANCELLED_CALLBACK_DRAIN_MS` (60 s).
  - The server sends a JSON `ping` every 15 s (`JOB_HEARTBEAT_MS`) and never checks for an answer;
    the tab only counts it as an incoming frame (`socketLiveness.ts`: stale after 45 s while
    visible, replaced on resume). A frozen tab whose TCP connection stays up therefore counts as
    attached on the server, and its provider call runs to `timedOut` at 30 min. Meanwhile the chat
    stays `chatBusy`, and the same client's other roots wait.
- **Stop.** `DELETE /api/generations/:id?clientId=` aborts only that `clientId`'s job (`ownJob`);
  any other client gets 404. An abort closes the channel (callbacks `aborted`, `cancel` sent to the
  tab) and gives the runner `JOB_ABORT_GRACE_MS` (5 s) to try to save the partial text. A context
  that lost its session storage has a new `clientId` and cannot read or stop its own earlier job;
  neither can any other device.
- **Restart.** Streaming checkpoints target every 3 s (`CHECKPOINT_INTERVAL_MS`), and Stop and
  errors try a final partial save. A crash loses the text since the last successful checkpoint. It
  also leaves that message's generation fence open until the next ordinary write to that message.
- **Upgrades.** Nothing reloads an open tab when the server's build changes, so a tab of an older
  build can talk to a newer server. A tab ignores event types it does not know: the
  `applyGenerationEvent` switch has no default.

## Decisions

- **D1. A job receipt store on disk.** A new `save/data/generation-jobs.sqlite` sits beside the
  request history and follows its rules. Application snapshots and archives copy only
  `resources.sqlite` and assets, so it is in neither (an operator's backup of the whole volume
  contains it, harmlessly).
  - **Rows.** One row per job: `job_id` (primary key), `request_id` (unique per epoch),
    `fingerprint` (D2), `client_id`, `epoch`, `kind`, `character_id`, `chat_id`, `admitted_at`,
    `ended_at`, `progress` (D5), and `status`, the kept `GenerationStatus` as JSON with the same
    `keptTerminal` trim. A `cancelled` row has a `request_id` and no job (D3). Indexes on
    `(epoch, request_id)` and `ended_at`.
  - **The memory view is authoritative.** While the process runs, the registry (`jobs`, plus a new
    request-id index over running jobs) and the recent outcomes in memory answer first. The disk is
    written synchronously, as idempotent upserts by `job_id`: at admission, at each sequence part
    boundary (D5), and at the terminal. It is read only for ids that memory does not hold.
  - **Retention.** Running rows are never pruned. A row's `status` payload is cleared 24 h after
    its end, or when more than 500 rows hold one (oldest first), matching today's kept outcomes.
    The compact row (identity, fingerprint, progress) stays 72 h, longer than Durable Drafts'
    two-day retention, with at most 10,000 rows. Pruning runs on the GC tick in bounded
    transactions.
  - **At open.** Rows of another epoch are deleted. Rows with no `ended_at` are ended as
    `{ type: "error", reason: "shutdown", message: "The server stopped while this job ran" }`,
    keeping their `progress`. An epoch change while running deletes the old epoch's rows in one
    transaction.
  - **Degraded mode.** An open, write, read, or purge failure marks the store degraded for the
    rest of the process. The disk is no longer read, the memory view goes on as today's kept map
    does, and the failure becomes a content-free diagnostics fault. A job is never refused because
    of its receipt. Degraded mode loses dedupe across a restart, and `synchronous = NORMAL` (WAL)
    does not promise durability through a power loss; the guide says both.
  - **Lifetime.** The store closes in `dispose` after the jobs have drained.
- **D2. A create carries a request id, checked before anything else can refuse.**
  - **The id.** `GenerationCreateBody.requestId` must match `GENERATION_ID_PATTERN`. The server
    computes a fingerprint: SHA-256 of a canonical JSON of `kind`, `characterId`, `chatId`,
    `command`, `input`, `userMessageId`, and `continueMessageId` (not `chatRevision`, which
    legitimately moves). The wire still accepts a body without an id: an older tab creates jobs as
    today, without dedupe.
  - **Lookup order.** After auth, the body's shape and the epoch, the request id is looked up,
    first in memory (running index, recent outcomes), then in the store. Admission stays
    synchronous from this lookup to installing the slot and the index, so two identical POSTs can
    never both admit. Answers:
    - Same fingerprint: 200 `{ jobId, replayed: true, owned, status }`. `status` is the
      `GenerationStatus`, without the preview `result` when the asking `clientId` does not own the
      job, or `null` when its outcome payload was pruned (it ran, its outcome is gone). Nothing is
      admitted, whatever the gate, slot, revision or binding say now.
    - Another fingerprint: 409 `{ error: "requestIdReused" }`.
    - A cancelled id: 409 `{ error: "requestCancelled" }`.
    - Not known: the ordinary checks and admission, recording the id with the job.

    Since the lookup runs first, any non-replay answer means this server never admitted that id.

  - **Shared principal.** The server has one password and no separate users. A request id
    (random) and D7's Stop therefore act across the user's clients. Attach, callback answers,
    `drained`, `memory-stop` and `DELETE` stay owner-scoped.
- **D3. The tab carries the id end to end, retries an unanswered create, and can cancel it.**
  - **Carrying the id.** `ServerSendArg` and `ServerJobRequest` carry an optional `requestId`
    down to `createGenerationJob`, which mints one when none is given.
  - **Retry.** A POST with no answer (status 0, or a body cut short) is sent again with the same
    body up to 3 more times, after 1, 2 and 4 s, each attempt within `STEP_DEADLINE_MS`.
    `creatingJobs` stays held throughout. A 412 after an unanswered attempt (the epoch changed)
    leaves the outcome `unknown`; any other answer is definite (D2).
  - **Replay outcomes.** A replay is classified before anything is remembered: only an owned job
    is saved, added to `liveJobs`, and followed. `runPinnedServerJob` returns a new
    `outcome: "replayed"`, which `serverGeneration.ts` maps as this send's own result, not as
    `followed` (another action):
    - Owned and running: followed like a created job; `onStart` fires once.
    - Owned and ended: its terminal is applied as a kept outcome is (`applyGenerationEvent`, then
      the chat read), and the send returns that terminal's result.
    - Not owned and running: refused as busy (`blockedChats`), keeping the `jobId` for D7.
    - Not owned and ended, or `status: null`: the chat is read again, and the send settles from it
      (landed when the chat holds the input).
  - **Cancel.** Stop before any POST went out ends it with nothing sent. Stop after one went out
    sends `POST /api/generations/cancel { requestId, clientId }` (JWT plus epoch, retried within
    the same budget). The server aborts the running job with that request id if there is one, or
    records a `cancelled` row so that a late original POST is refused (`requestCancelled`). It
    never falls back to a chat-wide stop.
- **D4. An attempt keeps its id only while its outcome is uncertain.** The send draft keeps
  `userMessageId` as today. It holds `requestId` only after an `unknown` outcome. A send whose job
  reached a known end without landing its input (an error before the input stage, `stopped`, an
  abort, a refusal) keeps the message id but drops the request id, so the next explicit Send is a
  new attempt and is not replayed into the old error. Every other caller mints a fresh id per user
  action (continue, reroll, which is also regenerate, commands, the typed `/multisend`, the PO run,
  plugin `sendChat`, autopilot); only D3's automatic retries reuse one.
  - **With Durable Drafts Slice 9.** Its `sending` row and a restored ordinary row carry both ids.
    A restore re-seeds the send draft through a new `sendDraft.ts` `seed(ref, draft)`. The ids are
    written with the row and not awaited before the POST (Durable Drafts' rule that dispatch does
    not wait on IndexedDB), so a page killed between the POST and that write recovers the text
    without the request id: a documented window. A draft from another epoch never replays, because
    the server refuses its POST with 412 and receipts are per epoch.
- **D5. A command job runs its `/multisend` parts itself, as one sequence job.** When a command
  job's script ends with queued parts, the job does not end. It keeps its id, slot, channel, owner,
  hooks and targets, and runs the parts in order. For each part:
  1. **Checks before any write.** The job is not aborted; the epoch is current; the gate is open;
     the chat exists; its binding still equals the job's targets; no override is orphaned. A
     failed check ends the sequence with `stopped` set to the refusal code, and nothing is written.
  2. **One write.** Under the job's token: when `clear` is set, remove every message, then append
     the part as a user message. This is one chat write, so nothing is cleared without the
     append.
  3. **The part's send.** It runs through a per-part send runner extracted from the send kind's
     path in `runner.ts`, with empty input (so no input trigger and no `editinput`, as today), its
     own generation id, lock, stage events and request-history rows. `JOB_MAX_DURATION_MS` applies
     per part: the job's deadline resets when each part starts.
  4. **The outcome.** The part counts as sent when its send ends `done` without `stopped`.
     Otherwise the sequence ends.
  - **Events.** After each part, the job sends a `sequence` event
    `{ index, total, sent, messageId?, alternatives? }`. The owner tab installs the alternatives
    with the helper extracted from `sendPinned` (`addRerolls`), counts the `messages` statistic, and
    keeps the job in `followedJobs` with its stages, as for any job. Notices follow the existing
    rule: buffered until the first attach, otherwise lost.
  - **Terminal.** `done` carries `messageId` (the last part's) and
    `sequence: { total, sent, stopped?: string }`. The kept status keeps it, and the receipt's
    `progress` is updated at each part boundary.
  - **Stop.** The job id never changes, so Stop and `DELETE` abort the running part and the
    sequence together.
  - **Server authority.** The page's local checks become the server checks above. The page's
    pending or refused local edits are not visible to the server; they meet the job's writes under
    the existing hydration and barrier rules, as for any job.
  - **Removed.** `followUps`, `followUpsDropped`, `runFollowUps`, `serverJob.followUpsNotRun`, and
    with them the stale-feed-lock Issue. An older tab follows the one job to its terminal, finds no
    `followUps`, and ignores `sequence` events: no part runs twice.
  - **Restart.** A restart ends the job as D1's `shutdown` outcome with its `progress` (Q3).
  - **Reporting.** When a sequence stops early, the owner tab shows `serverJob.sequenceStopped`
    ("/multisend stopped after {sent} of {total} parts: {reason}"), and a tab that comes back later
    reads the same thing from the kept status.

- **D6. Owner liveness is negotiated and bounds every request.**
  - **Negotiation.** A tab of this build attaches with `liveness=1` and answers each `ping` with
    `{ type: "pong", ts }`, echoing the ping's `ts`. For such a socket the server uses its own
    clock: a socket that sends nothing for `OWNER_SILENT_MS` (45 s, counted from attach and then
    from its last frame) is dropped from the job's owner set at once and closed. An older tab's
    socket (no `liveness`) keeps today's rule, so a frozen older tab keeps TJ06. That becomes a
    self-host-server Known Hazards Limitation.
  - **Absence is a job-level deadline.** The job holds `ownerAbsentSince`: set at admission until
    the first attach, and again whenever its last effective owner socket goes. A superseded
    socket's late `close` does not set it. A dispatched request's deadline becomes the earlier of
    its own deadline and `ownerAbsentSince + OWNER_ABSENT_MS` (Q1, default 120 s). The channel
    checks that deadline wherever it already checks deadlines (answer, attach, dispatch, parent
    lookup). An attach settles anything overdue first, then replays what is still open.
  - **Expiry.** It uses the existing `disconnected` settlement, so the client's ownerless queued
    roots settle with it. Drain holds are unchanged.
  - **Bounds.** For a negotiated tab, the chat is free within `OWNER_SILENT_MS` +
    `OWNER_ABSENT_MS` + `JOB_ABORT_GRACE_MS`. The lane can stay held for up to
    `CANCELLED_CALLBACK_DRAIN_MS` more after a delivered callback. A provider call that ends
    `disconnected` fails through the existing `endWith` path: the job ends, its partial save is
    attempted, and the slot is freed.
  - **What each case does:**

    | Owner                                  | Outcome                                                                                                |
    | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
    | Same page reconnects inside the wait   | The request replays; the page's callback cache answers it once                                         |
    | Page reloads                           | The new page refuses the unknown replay (`jobChannel.ts`); the provider fails, and the job ends failed |
    | Page killed, context relaunched        | A new `clientId`: absent, `disconnected`                                                               |
    | Hidden but running                     | Answers `ping`; unaffected                                                                             |
    | Frozen                                 | Silent after 45 s: dropped; absent: `disconnected`                                                     |
    | Long non-streaming provider, page live | Unaffected (no progress deadline)                                                                      |

- **D7. Any of the user's tabs can stop a chat's job, after naming which one.**
  - **Lookup.** `GET /api/generations/current?characterId=&chatId=` (JWT) answers
    `{ jobId, kind, owned, stage?, sequence? }`, or 404 when nothing runs. It is read-only: no
    attach, no callbacks.
  - **Stop.** `POST /api/generations/stop { characterId, chatId, jobId, clientId }` (JWT plus
    epoch) aborts `jobId` only while it is that chat's current job. Otherwise it answers 409
    `jobChanged`, or 404 when nothing runs. `clientId` is for attribution only, not authority.
    When it differs from the owner's, the error terminal carries `abortedBy: "other"` and the
    diagnostics `job` end event a content-free `stoppedBy: "otherClient"`.
  - **In the tab.** In a chat that is busy with a job this tab does not follow (a feed lock, a
    not-owned `chatBusy` or replay, or a lookup), Stop shows. It reads the lookup, asks for a
    confirm naming what runs (Q2), and stops that `jobId`. On `jobChanged` it reads the lookup and
    asks again.
  - **The owner.** `reportEnd` shows `serverJob.stoppedElsewhere` for `abortedBy: "other"`; today
    it suppresses every abort.
- **D8. A restart reads as an ended job.** Through D1, the owner's status read after a restart or
  shutdown gets a kept `error` with `reason: "shutdown"`, shown with `alertJobError` as any kept
  error. `serverJob.endedAway` stays for jobs the server never knew (another epoch, or pruned). The
  guides state the crash-loss limit (text since the last successful checkpoint, a 3 s target) and
  the open fence (closed by the next ordinary write to that message).

## Answered questions

The user answered these on 2026-10-28, each with the recommended option:

- **Q1. How long a job waits for an absent owner before a request fails** (D6): 120 s
  (`OWNER_ABSENT_MS`). A phone away longer during a plugin-provider reply comes back to a failed
  job with its partial text saved, and the chat is free meanwhile. Not taken: 60 s (frees the chat
  sooner, fails more app switches) and 5 min (fails fewer, blocks longer).
- **Q2. Stopping another device's job** (D7): confirm first, naming the job's kind and stage. Not
  taken: no confirm, like the tab's own Stop.
- **Q3. A sequence across a restart** (D5): not resumed; the kept outcome says how many parts were
  sent. Not taken: persisting the remaining parts (up to 64 × 100,000 characters) and resuming at
  startup, which starts generations nobody may be watching.
- **Q4. The typed `/multisend`** in the composer stays page-owned (under **Later**). Not taken:
  running it as a server command job so D5 covers it, which turns its local checks into admission
  refusals.

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Most
slices edit `server/src/jobs/generationJobs.ts` and `shared/jobs.ts`: run them one at a time, not in
parallel worktrees.

### Slice 1: receipt store and kept outcomes on disk (D1, D8; needs nothing)

Files: new `server/src/data/generationReceipts.ts` with tests; `server/src/jobs/generationJobs.ts`
(`kept`, `keepOutcome`, `expireOutcomes`, `status`, admission and terminal writes, the request-id
index); `server/src/app.ts` (open beside the request history, epoch sync, close in `dispose`);
the self-host-server guide (State, Known Hazards).

- Tests: reopen with a running row (the owner reads `shutdown` with its progress); an epoch change
  drops rows, and a failed purge leaves none servable; payload pruning at 500 and 24 h keeps the
  compact rows; a running row is never pruned; each of admission, terminal, read, and reopen
  failure degrades to memory without refusing a job; a status keeps the `keptTerminal` trim.
  Injected clock (V3).
- Measure (slow set): admission and terminal cost and event-loop delay with the file on a
  throttled volume; recorded in the guide's Gotchas.

### Slice 2: request identity (D2, D3, D4 without the journal; needs 1)

Files: `shared/jobs.ts`; `server/src/routes/generations.ts` (`parseCreateBody`, `cancel`);
`server/src/jobs/generationJobs.ts` (`create`, cancel); `src/ts/network/generationJobs.ts`
(`createGenerationJob`, `createJob`, ownership before remembering);
`src/ts/process/serverCommands.ts` (`ServerJobRequest`, `runPinnedServerJob`, the abort path);
`src/ts/process/serverGeneration.ts` (`ServerSendArg`, `replayed`); `src/ts/process/sendDraft.ts`
and the screen's settle call in `src/lib/ChatScreens/DefaultChatScreen.svelte`, as Durable Drafts
Slice 9 left them (see **Recommended order**); `src/ts/network/tests/generationJobsMock.ts`,
`src/ts/process/tests/serverCommandsMock.ts`; the chat-pipeline and self-host-server guides.

- Tests (server, real registry): the create's answer dropped, the job run to its end, the
  revision moved, and the same body again gives the replay and one generation. The same holds
  during maintenance, during shutdown, and after a binding change. Two identical POSTs with the
  first runner latched admit once. A changed input under the same id gives `requestIdReused`, and
  the same chat id under another character does not match. A cancel before the late POST gives
  `requestCancelled`; a cancel of a running job aborts it. A replay after a reopen answers
  `shutdown`.
- Tests (client): the first POST fails at the network, and the replay is followed once with
  `onStart` once; a not-owned replay is never saved or held in `liveJobs`; an owned-ended replay
  returns the terminal's result. Stop during backoff sends the cancel. The draft keeps the request
  id after `unknown`, and drops it after an error before the input stage, after `stopped` and after
  an abort, then sends a fresh one. Fake timers for the backoff.

### Slice 2b: request ids in recovered drafts (D4 journal part; needs 2 and Durable Drafts Slice 9)

Runs in the same session as Slice 2, as a second commit, once `dev` holds Durable Drafts Slice 9.

Files: `src/ts/process/sendDraft.ts` (`seed`), `src/ts/process/composerDrafts.svelte.ts`,
`src/ts/storage/draftJournal.ts` (entry type), `src/lib/ChatScreens/DefaultChatScreen.svelte`.

- Test: clear module state as a reload does, restore through the real journal and composer path,
  and assert the next POST's exact request id; an other-epoch row sends a fresh one.

### Slice 3: the sequence job (D5; needs 1)

Files: `server/src/prompt/runner.ts` (extract the per-part send runner), `server/src/jobs/runSetup.ts`,
`server/src/jobs/commandRunner.ts`, `server/src/jobs/generationJobs.ts` (per-part deadline, the
`sequence` event, progress writes), `shared/jobs.ts` (`sequence`, removal of `followUps` and
`followUpsDropped`), `src/ts/process/serverCommands.ts` (remove `runFollowUps`, handle `sequence`),
`src/ts/process/serverGeneration.ts` (the extracted alternatives helper), `src/lang/en.ts` and
`ko.ts`, the chat-pipeline guide (Flows; the Issue removed).

- Tests (server): two `/multisend` commands with different `clear` flags write the same messages
  that today's `runMultisend` writes. Each refusal (orphaned override, binding change, deleted
  chat, gate, epoch) stops the sequence with zero chat writes for that part. An append that fails
  after `clear` leaves the chat untouched. Stop during part 2 ends the job. A create in the chat
  between parts gets `chatBusy`. The owner's socket closing after part 1 still lets the parts
  without callbacks finish. A part whose script hook needs the absent owner stops the sequence
  with its reason. A part's own 30 min deadline does not count the earlier parts.
- Tests (client): `sequence` events install each part's alternatives and count the statistic; an
  older client's handling (no `followUps`) runs nothing.

### Slice 4: owner liveness (D6; needs nothing, after 3)

Files: `server/src/jobs/channel.ts` (absence deadline), `server/src/jobs/generationJobs.ts`
(negotiation, effective owner set, `ownerAbsentSince`), `shared/jobs.ts` (`pong`),
`src/ts/network/generationJobs.ts` (attach query, `pong`), `server/src/app.ts` (test-only
`ownerAbsentMs`/`ownerSilentMs`, passed like `generationAbortGraceMs`), the plugins-mcp and
self-host-server guides.

- Tests (channel hub with injected `now`):
  - A callback whose owner leaves settles `disconnected` at the absence deadline, also when the
    clock jumps past it without the timer firing, then an attach, an answer or a chunk arrives.
  - An attach inside the wait replays it.
  - A superseded socket's close does not start absence.
  - The ownerless queued roots of the same client settle with it, while a delivered callback keeps
    its drain hold.
  - A child callback takes the parent's deadline.
- Tests (registry, real sockets): a negotiated socket silent from attach is dropped at 45 s; one
  answering `pong` stays; a socket without `liveness` keeps today's rule. Through the real provider
  path (`endWith`), the partial save runs and the slot is freed.

### Slice 5: stop from another tab or device (D7; needs nothing, after 4)

Files: `server/src/routes/generations.ts` (`current`, `stop`), `server/src/jobs/generationJobs.ts`,
`shared/jobs.ts` (`abortedBy`), `shared/diagnostics.ts` and its report projection (`stoppedBy`),
`src/ts/network/generationJobs.ts`, `src/ts/process/serverCommands.ts` (`reportEnd`, keeping the
busy `jobId`), `src/ts/process/chatStatus.svelte.ts`, the Stop control in `DefaultChatScreen.svelte`,
`src/lang/en.ts` and `ko.ts`, the chat-pipeline guide.

- Tests:
  - Another client's stop aborts the job and its sequence; `jobChanged` when another job took the
    slot; 404 for an idle chat.
  - No JWT is refused, and a stale epoch gets 412.
  - The owner sees `stoppedElsewhere`; the owner's own call through the new route is not marked
    `other`.
  - The lookup finds a command job that holds no lock.
  - The lookup grants no attach and no callback answers.
  - In the tab: Stop shows for a chat busy with a job it does not follow, asks, and stops the
    looked-up id; a job that ended during the confirm stops nothing.

### Slice 6: docs close and browser drive (needs all)

Files: the owning guides (final pass), a new `util/playwright/checkJobProtocol.mjs`, registered in
`docs/structure/build-test-platforms.md`.

- Driver cases, with a real registered plugin provider (a test plugin), not a slow server mock:
  - A create whose response is cut after the server answered (`route.fetch`, then abort): one
    reply, and the draft is cleared.
  - A reload during a three-part sequence: it finishes, and the page shows each part.
  - A second browser context stops the first context's job.
  - The owner page is closed during a plugin-provider reply: the chat frees after the test-only
    absent wait.
  - A server killed (SIGKILL) after a visible chunk and before its checkpoint, then restarted: the
    tab shows the `shutdown` outcome, and the chat holds the last checkpointed text.
- Device checks (a real Android PWA killed and reopened mid-reply) go to the user as a checklist
  and are reported as not run (V5).

## Recommended order

1 → 2 + 2b → 3 → 4 → 5 → 6.

**Precondition: `dev` holds Durable Drafts Slices 1 and 9.** Slice 9 (composer drafts, `62277946b`)
needs only Slice 1 (`2a8ce1e83`). Both landed on that plan's target branch
(`claude/plan-runner-durable-drafts-docs-648899`) ahead of its Slices 2–4. Merging that branch's
commit `2b722776f` (the Slice 9 "landed" mark) into `dev` brings exactly those four commits, with
their hashes:

- Use a merge, not a cherry-pick. Its later Slice 3 (`ca3e30b7b`) edits `draftJournal.ts` again,
  so cherry-picked copies would conflict when that plan's final step merges `dev` into its target.
  A merge keeps one history: that step needs a merge anyway, because `dev` has moved since the
  target branched.
- A dry run (`git merge-tree`) on 2026-10-28 conflicts only in `docs/plan/README.md` (the Display
  Evaluation entry) and `docs/structure/chat-pipeline.md` (the Known Hazards split into Issues,
  Limitations and Gotchas against Slice 9's hazard edits); code merges cleanly.
- After the merge: V1 on `dev`.

With that in `dev`, Slices 2 and 2b run together, and Slice 5 waits on nothing from Durable Drafts.
Without it: 1 → 3 → 4 first, and 2 + 2b and 5 once Durable Drafts has landed in `dev`.

Overlap with the active plans, which is the order to serialize real edits:

- **Durable Drafts** after Slice 9 touches none of `sendDraft.ts`, `composerDrafts.svelte.ts` or
  `DefaultChatScreen.svelte` (its Slices 5–8 and 10–12 are storage, boot, the recovery dialog, and
  docs). Still shared: `src/lang/en.ts` and `ko.ts` (its Slice 5, our Slices 3 and 5),
  `draftJournal.ts` (its Slices 6 and 8, our Slice 2b's entry type), the chat-pipeline and
  persistence guides (its Slice 12), and `shared/diagnostics.ts` (our Slice 5). Its Slice 2 passes
  signals through `serverAuth.ts`. Until that reaches `dev`, D3's per-attempt deadline cannot cut
  the auth step before the fetch.
- **Display Evaluation** shares no code file, but its Slice 9 edits the chat-pipeline and
  self-host-server guides.

## Verification

- Per slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the affected `slow` and `e2e` sets), V6
  (each new regression test shown failing once with its guard broken), V4 (`rg` each changed
  export and wire field across `src`, `server`, `shared`, `util`, `e2e`, `docs`), V7 (extend
  `generationJobsMock.ts` and `serverCommandsMock.ts`, no new inline module mocks), V8/V9, and
  prettier on changed files.
- Timing goes through injected clocks, latches and test-only options. Each gate test advances the
  clock without running timers at least once, so a check that relies on its timer alone fails
  (V3). The process kill, the measurement, and the browser driver are in the `slow` or browser
  sets.
- Each test must catch one of these wrong implementations:

  | Wrong implementation                                 | Caught by                                       |
  | ---------------------------------------------------- | ----------------------------------------------- |
  | Request-id lookup after the gate, slot or revision   | Slice 2 replay during maintenance and shutdown  |
  | No running index (only ended receipts)               | Slice 2 duplicate POSTs with the runner latched |
  | Request id dropped between draft and POST            | Slice 2 client draft tests; Slice 2b reload     |
  | Request id kept after a known failure                | Slice 2 fresh id after an error and `stopped`   |
  | A not-owned replay saved or held as live             | Slice 2 client                                  |
  | Clear applied before a refusal check                 | Slice 3 zero writes per refusal                 |
  | Alternatives not installed for parts                 | Slice 3 client `sequence` events                |
  | Expired absence revived by a late attach             | Slice 4 clock jump without timers               |
  | A superseded socket's close marks the owner absent   | Slice 4                                         |
  | Absence expiry that skips the queued-root settlement | Slice 4 two chats on one client                 |
  | Foreign stop of a job that took the slot meanwhile   | Slice 5 `jobChanged`                            |

## Out of scope

- Resuming a running generation after a restart, and a stricter checkpoint bound.
- Live attach to another device's stream.
- The job socket's slow-consumer buffer policy (audit "additional findings").
- Page-owned loops: the PO file run, plugin `sendChat`, DevTool autopilot.
- The per-client lane serialization (a chat-pipeline Limitation by the owner's decision).

## Later

- The typed `/multisend` as a server command job (Q4).
- A provider progress deadline once streaming providers can be told apart from non-streaming ones.
- Closing open generation fences at startup (D8 documents them instead).

## Review record

The Sol review of the first draft (2026-10-28, `gpt-6.1-sol`, read-only) raised 24 points (3
blockers, 18 major, 3 minor). All are taken except the trims below.

- **Blockers.**
  - Older tabs could not follow a chain of jobs.
  - Stop had no stable target across a hand-off.
  - An unchanged draft would replay a known failure forever.

  The first two are answered by D5's single sequence job (Sol's point 24): one job id, no
  `chain.next`, no slot hand-off, nothing for an older tab to miss. The third is answered by D4's
  rule that only an uncertain attempt keeps its id.

- **Major points taken.**
  - D2: lookup before the gate; an atomic, synchronous admission; the fingerprint.
  - D3: cancel with a tombstone instead of abandoning a landed create; the `replayed` outcome and
    the full send path; ownership checked before remembering.
  - D4: the journal hand-off, with a documented crash window.
  - D1: running rows never pruned, a 72 h dedupe horizon, degraded mode.
  - D5: checks before the single write; parity for alternatives and statistics; progress
    persisted.
  - D6: negotiated liveness; an absolute absence deadline; the existing settlement and drain hold.
  - D7: name the job before stopping; attribution; `reportEnd`.
  - Ordering: the missed shared files; the failure matrix; a real plugin provider in the driver.
- **Minor points taken.** The current-state corrections; the cost and exclusion limits of the
  store.
- **Trimmed.**
  - Stalled-close-handshake tests (point 15): the rule is kept (an overdue absence settles before
    an attach is accepted), but fault injection on the socket close is costly for a rare case.
  - The full old-build matrix (point 1): reduced to the cases the sequence design still changes for
    an older tab: a create without `requestId`, a command with parts followed by an older client,
    and a socket without `liveness`.
