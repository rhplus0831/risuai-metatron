# Server generation: jobs, channels, transforms, LLM and token routes

## Scope

- Owns the server side of generation: job admission, request identity, receipts, command sequences, the job channel, the
  integration of the prompt, Lua, LLM, and translation runtimes, transforms, and the memory task and token routes.
- The live-update feed and its socket → [live-update-feed](live-update-feed.md).
- The tab's transform client (batching, provisional display, display-transform failure retries) →
  [cbs-rendering](cbs-rendering.md#script-transform-client).
- Contracts shared with the tab stay with [chat-pipeline](chat-pipeline.md); each domain's semantics stay with its
  owner, listed in [Known Hazards](#known-hazards), and translation with [translation](translation.md).
- Neighbors: [self-host server](self-host-server.md) owns the process, middleware, limiters, and auth;
  [server resources](server-resources.md) owns the store and its routes.

## Files

### Runtime modules

- `server/src/jobs/generationJobs.ts` `createGenerationJobs`: the registry. Admission (`create`, `requestFingerprint`,
  `lookupRequest`, `cancel`), the chat slot (`current`, `stop`), the sockets and handoff (`handleUpgrade`, `attach`,
  `takeover`), job writes (`writeAsJob`), the job chat (`diffChat`, `hydrateAll`), failures (`markFailure`, `failureOf`,
  `errorTerminal`), and the clocks (`JOB_MAX_DURATION_MS`, `JOB_ABORT_GRACE_MS`, `OWNER_SILENT_MS`, `OWNER_ABSENT_MS`,
  `JOB_DONE_GRACE_MS`).
- `server/src/jobs/channel.ts` `createChannelHub`, `parseGenerationHooks`: every job's questions and callbacks, one lane
  per client. `server/src/jobs/commandRunner.ts` `createGenerationRunner`, `runCommand`, `finishCommand`: dispatch by
  kind and command jobs. `server/src/jobs/runSetup.ts` `createRunSetup`, `JobRunState`, `asScript`: one run's script
  services and budgets.
- `server/src/jobs/{jobScope,chatBinding,loreOverrides,generationLock,cbsHost,chatResult}.ts`: scoped reads
  (`loadJobScope`), the binding check (`checkChatBinding`), orphaned overrides (`readOrphanedOverrideEntries`), reply
  locks (`createGenerationLock`), the CBS host (`createJobCbsHost`), trigger chat results (`applyTriggerChat`).
- `server/src/prompt/runner.ts` `runPromptJob`, `runPromptSend`, `createJobMemoryHost`; `server/src/prompt/assemble.ts`
  `assemblePrompt`, `AssemblyHost`; `server/src/prompt/{commands,scripts,triggers,postProcess,thoughts}.ts`
  (`createCommandExecutor`, `createScriptProcessor`, `runLuaEdit`, `createTriggerRuntime`, `runEmotionMode`,
  `stripThoughtsBlock`).
- `server/src/prompt/transform.ts` `createTransformService`, `partitionKnownResults`;
  `server/src/prompt/transformCache.ts`, `server/src/prompt/displayScope.ts` `createDisplayScopeLoader`,
  `server/src/prompt/displayKinds.ts`; wire shapes in `shared/transform.ts`.
- `server/src/data/generationReceipts.ts` `createGenerationReceipts`: the [job receipts](#job-receipts).
- Runtimes other guides own: `server/src/lua/` and `server/src/scripts/`, the worker-backed script runtime
  ([scripts and triggers](scripts-triggers.md)); `server/src/llm/` ([LLM requests](llm-requests.md));
  `server/src/translation/runner.ts` ([translation](translation.md)); `server/src/data/vectorCache.ts`
  ([memory](memory.md)). The job wire contract is `shared/jobs.ts`.

### Generation routes

`server/src/routes/generations.ts` `registerGenerationRoutes`: JWT, authenticated limiter, `no-store`; each route's
body, answer and statuses are the comment above its registration. "+ epoch" is the
[resource epoch rule](server-resources.md#epoch-and-response-rules).

- `POST /api/generations` (`GenerationCreateBody`, optional `requestId`; `x-resource-epoch` checked by `create`, not by
  the route): `{ jobId }` or a replay ([Generation admission](#generation-admission)).
- `GET /api/generations/current` and `POST /api/generations/stop` + epoch: the chat slot
  ([Chat-slot lookup and stop](#chat-slot-lookup-and-stop)). `POST /api/generations/cancel` + epoch: by `requestId`,
  whatever the owner.
- `GET` and `DELETE /api/generations/:id`, `POST /api/generations/:id/memory-stop` + epoch, and
  `POST /api/generations/:id/drained` (`ChannelDrainedBody`): scoped by `clientId` ([Job handoff](#job-handoff)).
- `POST /api/generations/:id/handoff` and `/takeover` + epoch: [Job handoff](#job-handoff).
- WS upgrade `/api/generations/:id/ws?clientId=&attach=&liveness=&hydration=&role=&ticket=&rows=&proto=`
  (`handleUpgrade`): JWT in the `risu-auth` query or header, no HTTP limiter; the job's `GenerationEvent` stream
  ([Generation channels](#generation-channels), [Job chat and barriers](#job-chat-and-barriers)).

### Transform, translation, and memory routes

JWT + epoch, authenticated limiter; each route's contract is its registration's comment.

- `POST /api/transform` and `POST /api/transform/continue` (`server/src/routes/transform.ts` `registerTransformRoutes`;
  `TransformRequest`, `TransformContinueRequest`, `TransformResponse`): the script transform's two calls, with
  [confirmations](#transform-confirmations) on the first.
- `POST /api/translate/message` (`server/src/routes/translate.ts` `registerTranslateRoutes`): one stored message
  translated on the server ([translation](translation.md)).
- `POST /api/memory/tasks` and `DELETE /api/memory/tasks/:characterId/:chatId` (`server/src/routes/memoryTasks.ts`
  `registerMemoryTaskRoutes`): a manual memory task start and cancel ([memory](memory.md)).

### LLM and token routes

JWT, authenticated limiter.

- `POST /api/llm/request` + epoch and `POST /api/llm/request/:id/answer` (`server/src/routes/llm.ts`
  `registerLlmRoutes`, owned by [LLM requests](llm-requests.md); `LlmRequestBody`, `LlmRequestEvent` in
  `shared/llm/request.ts`): one provider request on the server as an SSE stream, and the answer to one of its callbacks
  (`{ clientId, callbackId, outcome, value | error }`). 429 past `MAX_REQUESTS_PER_CLIENT` (32,
  `server/src/llm/requests.ts`); the answer route is 404 for an unknown, another client's, or an ended request.
- `POST /api/tokens/count` and `POST /api/tokens/encode` (`server/src/routes/tokens.ts` `registerTokenRoutes`): counts
  for a `TabTokenScope`, ids for the tab's playground tokenizer.

## Flows

### Transform confirmations

A tab's `knownKey` (from [the transform client](cbs-rendering.md#script-transform-client)) turns an exact successful
cache hit into a `same` confirmation on the first call only; `partitionKnownResults` holds the rule and what still
answers in full.

### Local model refusals

`server/src/prompt/transformers.ts` `localModelRefusal` keeps its status: a full queue answers 429, an expired queue
wait 503. Prompt jobs and manual trigger commands use it; server translations keep a failed WebLLM request's status. A
refusal the memory step recovered from or outlived replaces no later error.

### Generation admission

- The route's limiter, authentication and body validation run first; then `create` checks the epoch, synchronizes the
  identity maps and receipts with it, and looks up `requestId` (`GENERATION_ID_PATTERN`) before the admission gates. The
  gate order, the synchronous install and the replay rules are `create`'s comment; identity is `requestFingerprint`, the
  lookup order `lookupRequest`, and cancellation `cancel`.
- Another client's replay is a copy without `terminal.result`. The chat-slot `GET /current` and `POST /stop` are open to
  any authenticated tab or device.
- A retry's auth, limiter or body-reader failure happens before lookup. After an unanswered create, only a decoded
  success/replay or a refusal fencing the delayed original resolves it: `requestCancelled`, `requestIdReused`, `stale`,
  `chatBindingMismatch` and 404.
- A refusal installs no identity, so after one the original can still be admitted: the 503s, `chatBusy`,
  `memoryRebuilding`, `chatBindingIncomplete` and `chatLoreOverrideOrphaned` keep the request uncertain, as do 412, 429,
  auth/body-limit errors and generic errors. This does not bypass the shared limiter or promise connectivity after the
  listener closes.

### Prompt job execution

- `createGenerationRunner` sends `command` jobs to `runCommand`; other kinds go to `runPromptJob`, which delegates one
  send to `runPromptSend` and emits `done` after it returns. Command sequences call `runPromptSend` per part
  ([Command sequences](#command-sequences)). `runPromptJob`'s comment is the send's order.
- `assemblePrompt` runs per speaker; its `AssemblyHost` supplies the job's services. Assembly's prompt and lore behavior
  is owned by [chat pipeline](chat-pipeline.md); memory algorithms are owned by [memory](memory.md).
- After final chat writes, `runPromptSend` hands off translations and due memory input, detached, before returning.

### Reroll in place

- `context.rerollMessageId` (`reroll` only; in `requestFingerprint`; `hello` sends `rerollInPlace`): the first round
  regenerates that reply in place. `runSpeaker` writes the begin group (old reply into `candidates`, variable restore,
  `begin` last) and assembles without it (`scopeHistoryChat`).
- One final write keeps the new reply or, on any end without one, restores the previous candidate while the store undoes
  the attempt's variable writes (`rerollAttempt`). Later rounds run as after a send; `finalize`'s comment is the
  contract.

### Command sequences

- One `command` job runs a Lua button, form, or manual trigger, then its queued `/multisend` parts under one id, chat
  slot, channel, owner and hooks: `createCommandExecutor` parses, `createRunSetup` queues (`MAX_SEQUENCE_PARTS`,
  `MAX_SEQUENCE_PART_CHARS`), `finishCommand` runs each part after the registry's synchronous preflight
  (`RunningJob.sequence.beginPart`) and sends it through `runPromptSend`. Boundary checks, the clear-and-append write,
  the send view, progress and the terminal are those comments.
- Each part gets `JOB_MAX_DURATION_MS` (30 minutes) anew. After a part returns, the tab receives the live-only
  `sequence` event, the [receipt](#job-receipts) keeps `progress`, and the one terminal carries
  `sequence: { total, sent, stopped? }`. A part needing a browser callback waits under the channel's absence rules;
  auto-checkpoint runs once after a done sequence, after the slot is released.

### Chat-slot lookup and stop

`current` reads the chat slot (`chatSlots`) without attaching; `stop` aborts only the confirmed job id. The first stop's
client (a participant's `DELETE` too) is attributed; `stop`'s comment holds the rules and `jobChanged` retry.

### Generation channels

`generationJobs.ts` holds the owner clock (`ownerAbsentDeadline`, `removeOwner`, `expireSilentOwners`, `attach`);
`channel.ts` applies it (`absenceDeadline`, `effectiveDeadline`), and its module header holds the deadline checks.

- The tab attaches `/api/generations/:id/ws` with `liveness=1` and answers each `{ type: "ping", ts }` with a `pong`
  echoing `ts`, before checking the event epoch. A negotiated socket with no frame for `OWNER_SILENT_MS` (45 s from
  attach, then its last frame) leaves the owner set before closing. MCP sees the same owner presence. Sockets without it
  keep the [older-tab rule](#limitations).
- `ownerAbsentSince` starts at admission and when the last effective socket leaves or at the silence deadline; attach
  clears it.
- Each dispatched question or callback uses the minimum of its own deadline, the job's absence deadline
  (`ownerAbsentSince + OWNER_ABSENT_MS`, 120 s), and its parent's effective deadline. Attach expires overdue requests
  while still absent, then clears absence, sends its snapshot and replays the requests still open, in their original
  request/notice order.
- Owner absence bounds only questions and callbacks; no job-wide absence abort. Callback-free sequence parts and
  detached memory tasks keep running.
- A streaming provider request with no callback outstanding, local-network streaming included
  ([Proxying](self-host-server.md#proxying)), goes on after the socket closes until it completes, its transport fails,
  the run fails (a failed checkpoint write cancels its reader; a fatal host failure aborts the run), or the job aborts
  (owner `DELETE`, `stop`, request-id cancel, `JOB_MAX_DURATION_MS`, shutdown, maintenance); the signal reaches its
  fetch through `runInJob` (`server/src/llm/requests.ts`).
- On `disconnected`, request hooks (`editinput`, `editprocess`, `replacerbeforeRequest`, `bodyIntercepter`) end the job.
  A completed reply's hooks skip and the job goes on: `editoutput` and `replacerafterRequest` keep the text (later
  scripts still run); `chatOutput` and image callbacks run nothing. The first three are kept in order as `done.skipped`
  (`JobRunState.skippedHooks`); the tab runs the listeners late once it holds that revision (`replaySkippedListeners`).
- The hooks above are the tab's plugin callbacks; the character's and modules' Lua edit hooks run on the server and
  never wait for the tab (`runLuaEdit`, `createScriptProcessor`).

### Job chat and barriers

- The job chat `chatPatch`, the same for every job socket, diffs (`diffChat`) two stored states: `sentChat`, the last
  copy a socket took, and `workingChat`, the chat after the job's own writes (`writeAsJob`'s `committed` hook); rules:
  the `Job` members' comments, `jobChatEvent`, `deliverJobChat`.
- `rows=streamed`: with no viewer attached and every owner socket flagged, `chatPatchEvent` sends a generated row as
  `streamed: { generationId, seq }` if its watermark is the stream checkpoint's (the one `raw` cover) matching
  `streaming`, with that text and `sentChat`'s other fields.
- The callback barrier (`hydrateAll`, `hydrateJobChat`) flushes the job's pending own write first. When every socket
  attached with `hydration=patch`, a job chat still at `sentChat`'s revision sends no chat event and the receipt names
  that revision; otherwise the patch-mode event and its receipt go; without the flag, [whole](#limitations).
- A callback's client barrier flushes local work and retries the job's remembered hydration copies. When the job chat's
  receipt is still not held (no remembered whole copy, an older one, or one refused by the acknowledged floor), it reads
  the job chat whole once, even while streaming, fenced on the callback, epoch, chat owner and incarnation, and job
  metadata, and installs it with the job's newest held `streaming` list.
- Normal hydration admission still protects local work and the floor; the callback runs only when the client holds every
  receipt or a newer revision ([chat store](chat-store.md#callback-hydration)).

### Job handoff

Rules: the comments of `participantJob`, `attach`, `switchOwner`, `takeover`, `armOffer`, `noticeAudience`,
`projectTerminal` (`generationJobs.ts`) and `transferOwner` (`channel.ts`).

- A job keeps its creator (`clientId`: receipts, `owned`, device notices) and gains a current owner (`ownerClientId`:
  callbacks, lanes). Only owner sockets answer and count for `ownerAttached` (MCP included).
- Offers go on the live-update feed (`HandoffOffer`); an unclaimed targeted one turns `absent` after owner absence. A
  ticketed attach takes one; the switch waits until nothing delivered to the old owner is outstanding, and the old
  owner's sockets become viewers. An owner's own ticket reattaches it; role events name the owner (`clientName`).
- `skipped` reaches only the late-replay recipient; `done.missed` lists delivered `chatOutput` callbacks that settled
  `disconnected`.

## State

### Job receipts

`data/generation-jobs.sqlite` (plus `-wal`, `-shm`) holds the receipts (its header holds the schema check and degraded
mode); like the request history, in no snapshot or archive.

- Table `receipts`, one row per job: `job_id` (primary key), `request_id` and `fingerprint` (null for older clients;
  unique `(epoch, request_id)`), `client_id`, `epoch`, `kind`, `character_id`, `chat_id`, `admitted_at`, `ended_at`
  (null while the job runs; indexed), `progress` (the sequence's `{ total, sent }` JSON, otherwise null), and `status`,
  the kept `GenerationStatus` JSON: no `result`, error message cut to 4 KiB, `sequence` intact.
- A cancelled request uses the same table: `job_id = "cancel:" + requestId`, private `kind = "cancelled"`, empty
  character/chat ids, `admitted_at = ended_at` at cancellation, and null fingerprint/status/progress. It is never served
  by a job-status read and is pruned with compact rows.
- Writes: the registry upserts a row synchronously at admission and at the job's end (every terminal path: done, error,
  abort, timeout, shutdown, maintenance), and writes sequence progress before the first part (`sent: 0`) and at each
  completed part boundary before its event.
- Reads: a status answers from memory first (the live job, then its kept outcome); the disk answers only an id memory
  does not hold, only to the row's `client_id`, and only in the current epoch. Request lookup is shared across clients
  and returns the identity even when its status payload is gone (`readByRequest`).
- At open, rows of another epoch are deleted and running rows end as a kept 503 `shutdown` error
  (`createGenerationReceipts`).
- An epoch change (the maintenance end, or the registry noticing it at a status read, an admission, or the GC tick)
  deletes the old epoch's rows in one transaction.
- Retention: the comments of `KEPT_OUTCOME_MS`, `MAX_KEPT_OUTCOMES`, `GENERATION_RECEIPT_MS` and
  `MAX_GENERATION_RECEIPTS`, pruned on the 30 s GC tick in bounded transactions; reads check the payload age too.

### Process memory

- Generation registry, chat slots, sockets, handoff offers and tickets, lock, and request-id index are process-local and
  lost on restart. An ended job is readable for 60 s (`JOB_DONE_GRACE_MS`), then its trimmed outcome stays in memory for
  24 h/up to 500 entries (`KEPT_OUTCOME_MS`, `MAX_KEPT_OUTCOMES`); status falls back to the [receipt](#job-receipts)
  after restart. Epoch changes clear memory.
- Request identity moves from live job through grace to the kept entry, then disk. Cancellation tombstones are kept in
  memory 72 h/up to 10,000 entries; epoch changes clear both.
- The transform service: its result LRU, pending two-call snapshots and pins, plus `createDisplayScopeLoader` (raw
  configuration and transcript caches, shared read-only, with a fresh projection per request). Maintenance aborts
  renders and empties these caches; shutdown aborts renders and clears the loader ([CBS rendering](cbs-rendering.md),
  [chat pipeline](chat-pipeline.md)).
- The memory task registry (`createMemoryTasks`): per chat the running task, the queued input, the latest retained
  input, a waiting manual start, and the last terminal status (10 minutes), plus the held summary writer leases. A
  restart loses them: no task resumes.

## Coupling

- [Server resources](server-resources.md): a job's writes go through the store;
  [chat summaries](server-resources.md#chat-summaries), [chat activity](server-resources.md#chat-activity), whole-chat
  reads with `streaming`, and [maintenance](server-resources.md#maintenance) are defined there.
- [Self-host server](self-host-server.md): [Routes](self-host-server.md#routes),
  [Rate limits](self-host-server.md#rate-limits), and [Proxying](self-host-server.md#proxying) for the local-network
  route of a streaming request; its abort rule is in [Generation channels](#generation-channels).
- [Scripts and triggers](scripts-triggers.md): Lua worker gates and trigger effects; [MCP](mcp.md): the MCP registry;
  [plugins](plugin-sandbox.md): plugin providers.

## Invariants

- A job writes only while its admitted epoch and live job token remain valid. Message ownership is checked in the same
  synchronous store transaction as the write.
- Credentials for server provider requests are resolved server-side; the record stays
  [write-only](server-resources.md#invariants).

## Recipes

- Change the job contract across `shared/jobs.ts`, `server/src/jobs/generationJobs.ts`,
  `server/src/routes/generations.ts`, and `src/ts/network/generationJobs.ts`; hydration belongs to
  [chat store](chat-store.md).

## Tests

The in-process harness and the slow table are in the [shell's Tests](self-host-server.md#tests).

- Browser checks: `util/playwright/checkJobProtocol.mjs` and `checkJobHandoff.mjs` ([test-harness](test-harness.md)).
- Jobs:
  `pnpm --silent test:agent server/src/tests/{generationJobs,generationReceipts,generationDeltaChunks,generations,commandSequences,generationBarrier,jobChannel,promptRunner}.test.ts`.
- Transform and translation: `pnpm --silent test:agent server/src/tests/{transform,transformService,translate}.test.ts`.
- LLM and tokens: `pnpm --silent test:agent server/src/tests/{llmRoutes,llmRequests,tokenRoutes,tokens}.test.ts`.
- Job modules and CBS: `pnpm --silent test:agent server/src/tests/{jobModules,dynamicAssets,cbs}.test.ts`.
- Other scripts, memory, MCP, and CBS tests are anchored in their owner guides.

## Known Hazards

Runtime limits of other subsystems live with their owners: [chat-pipeline](chat-pipeline.md),
[LLM requests](llm-requests.md), [memory](memory.md) (the vector cache included),
[scripts and triggers](scripts-triggers.md), [plugins](plugin-sandbox.md), and [CBS/rendering](cbs-rendering.md).

### Issues

- Server CBS evaluation runs on the main thread under cooperative limits, with no hard deadline or heap bound. Some
  surrounding prompt work, including Jinja rendering, tokenizer calls after model load, and non-worker lore matching,
  also runs there.
- Unconfirmed: a provider callback that ends `disconnected` fails its job through `endWith` and the runner's finalize
  (`jobs/runSetup.ts`), not the registry's `abort()`, so `JOB_ABORT_GRACE_MS` does not bound that end (the
  maximum-duration watchdog still does). The chat can stay busy longer than owner absence plus abort grace; inspected in
  source, not reproduced.

### Limitations

- An older socket without `liveness=1` never expires for silence; a frozen tab can hold a callback and chat slot until
  its 30-minute deadline. Decision: Job Protocol D6, archive.
- Without `hydration=patch`, each callback sends the whole job chat. Older tabs can reapply it only after local work
  settles, so traffic scales with callbacks × chat size ([measured](../audit/server-measurements-2026-11-01.md)).
  Decision: Per-Event Server Work D4, archive.
- An owner behind a `streamed` row's `seq` (after missed chunks) reads the job chat whole once (`resync`); `proto` is
  only logged to the console, never enforced. Decision: Incremental Chat Transport D3, D4, archive.
- Restart ends a running job as `shutdown`; reply text since its last checkpoint (3 s target, `CHECKPOINT_INTERVAL_MS`)
  is lost, and its message fence stays open until an ordinary write. Decision: Job Protocol D1, D8, and Q3, archive.
- If receipt storage degrades, outcomes stay in memory and are lost on restart; without a persisted receipt, request
  deduplication also ends at the memory caps. WAL `synchronous=NORMAL` may lose recent writes on power loss, and the tab
  shows `serverJob.endedAway` when no outcome receipt remains. Decision: Job Protocol D1, archive.
- A callback delivered to an owner whose device then sleeps is not handed over; `handoff: "prefer"` only opens an offer.
  Decision: Job Handoff Q4, archive.
- A callback cancelled before a switch may still run its hook, writes included, on the old tab beside the worker's next
  one; `holdDraining` keeps only the old lane busy. Decision: Found Issues Sweep Q5.
- An `absent` offer leaves a worker 50 s before the job's first undelivered callback expires, but a queued root that
  another job's expired root settles `disconnected` (the cascade in `createChannelHub`) can end sooner. Decision: Job
  Handoff D3.
- Lua stuck in native code cannot reach its abort hook; worker termination waits for abort grace, and queued work waits
  for a replacement. Decision: Server-Owned Data script worker spike, archive; `server/src/lua/runtime.ts`.

### Gotchas

- The job receipt writes are synchronous `node:sqlite` calls on the serving thread, at each admission and each job's
  end. A slow volume delays every request while a receipt write runs; a throttled local disk is unmeasured
  ([measurements](../audit/server-measurements-2026-11-01.md)).
- `server/src/lua/runtime.ts` uses wasmoon 1.16's private engine extension table and C API, which must be rechecked on a
  wasmoon upgrade ([scripts and triggers](scripts-triggers.md)).
