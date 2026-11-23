# Server generation: jobs, channels, transforms, LLM and token routes

## Scope

For job admission, receipts, owner and viewer sockets, handoff, command sequences, reply streaming or completion Web
Push holds, start here. The registry also hosts the prompt, Lua, LLM, translation and memory runtimes.

- [Chat pipeline](chat-pipeline.md) owns the tab's send lifecycle and prompt semantics. [LLM requests](llm-requests.md)
  owns adapter behavior and request interception. [Memory](memory.md) and [translation](translation.md) own their jobs.
- [Network jobs](network-jobs.md) owns the tab's job socket and remote host. The separate
  [live-update feed](live-update-feed.md) broadcasts progress to every connected tab.
- For display transform batching and retries see [the transform client](cbs-rendering.md#script-transform-client).
  [Self-host server](self-host-server.md) owns auth and limiters, and [server resources](server-resources.md) owns the
  store.

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
- `server/src/prompt/runner.ts` `runPromptJob`, `runPromptSend`, `createJobMemoryHost`;
  `server/src/prompt/outputMeter.ts` `createOutputMeter` (a streamed reply's token count);
  `server/src/prompt/assemble.ts` `assemblePrompt`, `AssemblyHost`;
  `server/src/prompt/{commands,scripts,triggers,postProcess,thoughts}.ts` (`createCommandExecutor`,
  `createScriptProcessor`, `runLuaEdit`, `createTriggerRuntime`, `runEmotionMode`, `stripThoughtsBlock`).
- `server/src/prompt/transform.ts` `createTransformService`, `partitionKnownResults`;
  `server/src/prompt/transformCache.ts`, `server/src/prompt/displayScope.ts` `createDisplayScopeLoader`,
  `server/src/prompt/displayKinds.ts` (`DISPLAY_KIND_CLASSIFICATION`; `moduleFolders` and `personaFolders` are `drop`:
  no display transform reads a folder); wire shapes in `shared/transform.ts`.
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
- `GET /api/generations/current` reads the chat slot. `POST /api/generations/stop` requires the epoch and the confirmed
  job id ([Chat-slot lookup and stop](#chat-slot-lookup-and-stop)). `POST /api/generations/cancel` + epoch: by
  `requestId`, whatever the owner. `POST /api/generations/completion-release` + epoch: `{ requestId }` → `{ released }`,
  a held completion push ([Completion holds](#completion-holds)).
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
  for a `TabTokenScope`, ids for the tab's playground tokenizer. Both pass the request's signal on, so a client that
  disconnects gives up its outstanding local count or encode ([tokenizers](tokenizers.md#flows) says which worker
  stops).

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
  `chatBindingMismatch` and 404. `stale` and `chatBindingMismatch` fence only copies of that frozen request: they do not
  resolve an uncertainty the caller brought to the create, since a remote host may create under the id later.
- A refusal installs no identity, so after one the original can still be admitted: the 503s, `chatBusy`,
  `memoryRebuilding`, `chatBindingIncomplete` and `chatLoreOverrideOrphaned` keep the request uncertain, as do 412, 429,
  auth/body-limit errors and generic errors. This does not bypass the shared limiter or promise connectivity after the
  listener closes.

### Prompt job execution

- `createGenerationRunner`'s comment in `server/src/jobs/commandRunner.ts` owns dispatch, including the `memoryRecord`,
  `memoryTest`, [`memoryChapters`](structured-memory/writer.md#the-chapter-call), and `memoryRebuild` exceptions.
  Button, form, and manual commands use `runCommand`; other kinds use `runPromptJob`. `runPromptJob` delegates one send
  to `runPromptSend` and emits `done` after it returns; command sequences use `runPromptSend` per part
  ([Command sequences](#command-sequences)). `runPromptJob`'s comment is the send's order.
- `assemblePrompt` runs per speaker; its `AssemblyHost` supplies the job's services. Assembly's prompt and lore behavior
  is owned by [chat pipeline](chat-pipeline.md); memory algorithms are owned by [memory](memory.md).
- The send reserves space at the final token recheck for MCP tool schemas and the messages that the reply's request
  layer will insert (the Request Rules page's prompt insertion). `AssemblyHost.toolSchemaTokens` lists tools once for
  this reply. A plain `preview` skips that listing but still counts the interception messages in
  `AssemblyHost.insertedMessages`. The context report keeps `toolSchemas` and `interceptions` separate from assembled
  input. The mode filter, message order and insertion point belong to
  [LLM requests](llm-requests.md#request-interception).
- With `context.stopOverLoreBudget`, the first assembly of a send, continue, group or reroll can end the admitted job
  with `loreOverBudget` before history, memory and the reply request. Earlier writes, including the input, stand. The
  tab owns the [lore stop and retry](chat-pipeline.md#lore). The flag and `inputOriginal` are outside
  `requestFingerprint`. The input stage preserves the reviewed draft's original text on its appended message
  ([translation](translation.md#send-hand-off)).
- For an OOC question the tab starts a `preview` with `context.oocExchangeId`, part of its identity. After
  `presetChain`, `runSend` detaches the chat at the stored exchange's anchor, then adds `oocTail` with fresh message ids
  and applies `oocToggleValues`. `reduceChatOps` in `server/src/jobs/chatOpsReducer.ts` applies preview edits to this
  copy. The registry hydrates only the stored chat.
- OOC previews skip the start trigger and omit tools from memory requests. Character and persona writes refuse, while
  media uses ordinary storage. `risuAccessHost` in `server/src/mcp/internal.ts` also refuses resource writes on a
  detached scope.
- A successful OOC result includes `ooc: true` before the tab can request the answer. A missing exchange, missing anchor
  or legacy memory cursor ahead of the cut yields `oocExchangeGone`, `oocAnchorGone` or `oocMemoryAhead`. Groups are
  refused. See [OOC question](chat-pipeline.md#ooc-question).
- After final chat writes, `runPromptSend` hands translations and due memory input to their detached services. For how a
  reply reaches those writes, see [streamed and buffered replies](#streamed-and-buffered-replies).

### Streamed and buffered replies

- `readReply` hands each raw first value to `createOutputMeter` before punctuation trimming or a continue's prefix. The
  meter counts locally without waiting in the stream loop. Suffix counts accumulate, a rewrite replaces the total and a
  failed count stops only the meter. The registry publishes the estimate on the feed
  ([generation channels](#generation-channels)).
- With Response Streaming off and Half Streaming on, only the actual reply requests `forceStreaming`. The
  `previewPrompt` and OobaLegacy paths omit the flag. If a stream arrives in Half Streaming mode, it has a meter and
  final text on stop or failure. It publishes no partial text or raw checkpoints and keeps chunk sequence zero. A
  buffered answer uses the buffered path.
- A quiet new reply has no row while it streams, so no client shows an empty reply. Its row and `begin` lock are
  appended with the read's text when the read ends, without `accepted`, as on the buffered path. A kept answer always
  gets its row, even an empty one; a stop, failure, or final rejection with no text appends none. A continue or an
  in-place reroll keeps its locked row and `accepted`.
- Both paths store the raw answer under its generation before output processing. A failed output hook leaves that
  answer, except a failed in-place reroll restores the previous candidate. With `escape`, the request layer consumes a
  provider that streams anyway and processes its last snapshot as buffered. See `server/src/llm/outer.ts`
  `requestChatDataOuter` and `runSpeaker` for output processing and candidate storage.
- A stream returned by the request layer skips the buffered after-request replacers and the outer loop's retries, but
  not the response checks: `runSpeaker` runs them after the read ([LLM requests](llm-requests.md#response-checks)). A
  rejected full stream keeps its text (a reroll in place restores its previous candidate) and fails the job, unretried.
- A rejected Half Streaming read that is retried writes nothing. The reply is requested again (no second `accepted`, a
  new meter, the estimate cleared) until its rejections pass `requestRetrys`. The successful tail runs once, on the
  accepted answer.

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

`current` reads the chat slot (`chatSlots`) without attaching, 200 `null` when idle (`readChatGeneration` also reads an
older server's 404 as idle); `stop` aborts only the confirmed job id. The first stop's client (a participant's `DELETE`
too) is attributed; `stop`'s comment holds the rules and `jobChanged` retry.

### Generation channels

`generationJobs.ts` holds the owner clock (`ownerAbsentDeadline`, `removeOwner`, `expireSilentOwners`, `attach`);
`channel.ts` applies it (`absenceDeadline`, `effectiveDeadline`), and its module header holds the deadline checks.

- The tab attaches `/api/generations/:id/ws` with `liveness=1` and echoes each `{ type: "ping", ts }`'s `ts` in a
  `pong`, before checking the event epoch. A negotiated socket with no frame for `OWNER_SILENT_MS` (45 s from attach,
  then its last frame) leaves the owner set before closing. MCP sees the same owner presence. Sockets without it keep
  the [older-tab rule](#limitations).
- Each dispatched question or callback uses the minimum of its own deadline, the job's absence deadline
  (`ownerAbsentSince + OWNER_ABSENT_MS`, 120 s), and its parent's effective deadline. Attach expires overdue requests,
  clears absence, sends its snapshot and replays open requests in request/notice order.
- A job re-sending a failed provider request reports `{ type: "retry" }` (`JobEventInput`); the registry counts the
  reports since the stage last changed and sends the `retry` event with the count, then `retry: null` after a changed
  stage's event. The snapshot replays a count only, as it does the stage.
- `publishProgress` sends a live-update `generation` frame at admission, each stage/retry/sequence change and job end.
  It includes previews, identifies the creator across handoff, and fences on the current epoch. The feed's hello
  snapshots running jobs for observers and reconnects ([live-update hello](live-update-feed.md#live-update-hello)).
- Only the feed carries the latest reply's `output` estimate. `accepted`, a transition to `preparing`, and the
  registry-only `outputReset` (a Half Streaming reply rejected by the response checks) clear it; a `retry` keeps it.
  `publishOutputProgress` coalesces count-only changes per job at `GENERATION_PROGRESS_INTERVAL_MS`. Other progress
  publishes immediately with the latest count. A late count cannot reopen an ended job. For the tab's progress store see
  [live updates](live-updates.md#files).

- `sendSocket` allows one oversized frame on an empty queue for whole-chat recovery; with queued bytes, it terminates an
  owner or viewer whose queue plus the next frame exceeds 4 MiB, leaving as on a drop.
- `provider` callbacks offer `chunks: "append"`: `handleMessage` joins appends for `onChunk`, asks `chunkResync` on gaps
  and holds success for the final `seq`.
- Owner absence bounds only questions and callbacks; no job-wide absence abort. Callback-free sequence parts and
  detached memory tasks keep running.
- A streaming provider request with no callback outstanding, local-network streaming included
  ([Proxying](self-host-server.md#proxying)), goes on after the socket closes until it completes, its transport fails,
  the run fails (a failed checkpoint write cancels its reader; a fatal host failure aborts the run), or the job aborts
  (owner `DELETE`, `stop`, request-id cancel, `JOB_MAX_DURATION_MS`, shutdown, maintenance); the signal reaches its
  fetch through `runInJob` (`server/src/llm/requests.ts`).
- On `disconnected`, request hooks (`editinput`, `editprocess`, `replacerbeforeRequest`, `bodyIntercepter`) end the job.
  A completed reply's hooks skip and the job goes on: `editoutput` and `replacerafterRequest` keep the text (later
  scripts still run). A skipped image produces no image. The terminal records skipped text hooks for reporting; only
  undelivered `chatOutput` listeners can run late, after the recipient holds the required revision
  (`replaySkippedListeners`). A delivered listener that disconnected is marked missed; only the creator sees its
  warning.
- The hooks above are the tab's plugin callbacks; the character's and modules' Lua edit hooks run on the server and
  never wait for the tab (`runLuaEdit`, `createScriptProcessor`).

### Job chat and barriers

- `chatPatch` diffs (`diffChat`) the stored `sentChat` last taken by any socket and `workingChat` after job writes
  (`writeAsJob`'s `committed` hook). Projections differ only in `messages`; either advances one baseline and retires
  generated ids once (`jobChatEvent`, `deliverJobChat`).
- `rows=streamed` owners get a generated row as `streamed: { generationId, seq }` when `chatPatchEvent` proves its raw
  watermark matches `streaming`, its text matches that checkpoint, and other fields match `sentChat`. Viewers and
  unflagged owners get whole rows from the same diff.
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
- Offers go on the live-update feed (`HandoffOffer`); any unclaimed open offer turns `absent` one offer delay after
  owner absence (a targeted request counts from the later of its opening and the absence). A ticketed attach takes one;
  the switch waits until nothing delivered to the old owner is outstanding, and the old owner's sockets become viewers.
  An owner's own ticket reattaches it; role events name the owner (`clientName`).
- `skipped` reaches only the late-replay recipient; `done.missed` lists delivered `chatOutput` callbacks that settled
  `disconnected`.
- `switchOwner` latches `everHandedOff` when the owner changes; it is never cleared (a creator that took the job back
  keeps it) and moves into the kept outcome, outside the status, whose `handedOff` says who owns the job now.

### Completion holds

`server/src/push/completionHolds.ts` `createCompletionHolds` (its module comment owns the rules), built in `app.ts`
after the push service.

- `context.completionHoldMs` (`parseCreateBody`: a finite number above zero, floored, clamped to
  `MAX_COMPLETION_HOLD_MS` in `shared/jobs.ts`; any kind; not in `requestFingerprint`, so a retry replays the first
  value; a command sequence's part keeps it) makes `notifyCompletion` hand the push to `hold` instead of sending it,
  unless the job's signal is aborted. The tab's `notification` notice is sent at the tail as without it.
- A later hold of the same job (a group's next speaker, a sequence's next part) replaces the notification. No timer runs
  while the job does: the registry's `onJobEnded` option (from `finalize`, once per job, forced ends included) starts
  the deadline, `completionHoldMs` from then, never restarted.
- The release route sends a held push at once. `requestJob` (over `lookupRequest`) answers a live job or kept outcome
  with its `everHandedOff`, null for an unknown request, a tombstone, or a receipt alone; the route answers
  `released: false` for null, for a job that ever changed owner (its push waits for the deadline), and when nothing is
  held. Any authenticated tab may release, before the end too.
- Past `MAX_COMPLETION_HOLDS` (64) the oldest is sent at once; `beginShutdown` drops every hold (`close`) before
  `push.close()`.

## State

- `JobScope` in `server/src/jobs/jobScope.ts` owns the frozen configuration and live overlay contract shared by the
  prompt runner, CBS, and Lua bindings.

### Job receipts

`data/generation-jobs.sqlite` (plus `-wal`, `-shm`) holds the receipts (its header holds the schema check and degraded
mode); like the request history, in no snapshot or archive.

- `createGenerationReceipts` owns the schema, bounded retention and best-effort failure policy. The registry writes a
  receipt synchronously on admission and terminal, plus sequence progress before the first part and at each completed
  boundary. The stored outcome omits `result`, caps error text and keeps sequence progress. A request cancelled before
  admission gets an identity tombstone that cannot be read as a job status.
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
  after restart. Epoch changes clear the kept outcomes and the request index; an ended job of the old epoch stays
  through its grace, and `generationSnapshot` lists only the current epoch's running jobs, each with its newest output
  count.
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
- In `server/src/routes/tokens.ts`, `registerTokenRoutes` answers an aborted count or encode with HTTP 400 and
  `The request was aborted`; shutdown takes precedence and raises `MaintenanceError` instead.

## Recipes

- For a reply progress change, follow `runSpeaker` → `createOutputMeter` → `RunningJob.emit` → `publishProgress` and
  `generationSnapshot`. Update `shared/events.ts` and the [tab progress reader](live-updates.md#files) if the feed
  payload changes. Exercise a reconnecting observer and a quiet stream as well as the owner.
- Change the job contract across `shared/jobs.ts`, `server/src/jobs/generationJobs.ts`,
  `server/src/routes/generations.ts`, and `src/ts/network/generationJobs.ts`; hydration belongs to
  [chat store](chat-store.md).

## Tests

The [server harness](self-host-server.md#tests) supplies the authenticated HTTP and WebSocket endpoints. Registry tests
use a controlled runner and clock, and `outputMeter.test.ts` injects a counter and fake timers. For the opt-in receipt
measurement and streaming timing checks see the [slow-test table](test-harness.md#slow-test-table).

- Browser checks: `util/playwright/checkJobProtocol.mjs`, `checkJobHandoff.mjs`, and `checkServerRestartRaces.mjs`
  ([test-harness](test-harness.md)); `e2e`: `e2e/multiClientGeneration.spec.ts`, two-client lock.
- Jobs:
  `pnpm --silent test:agent server/src/tests/{generationJobs,generationReceipts,generationDeltaChunks,generations,generationBarrier,jobChannel,promptRunner,outputMeter,completionHolds}.test.ts`.
- Transform and translation: `pnpm --silent test:agent server/src/tests/{transform,transformService,translate}.test.ts`.
- LLM and tokens: `pnpm --silent test:agent server/src/tests/{llmRoutes,llmRequests,tokenRoutes,tokens}.test.ts`.
- Job modules and CBS: `pnpm --silent test:agent server/src/tests/{jobModules,dynamicAssets,cbs}.test.ts`.
- Other scripts, memory, MCP, and CBS tests: their owner guides.

## Known Hazards

Other subsystems' runtime limits live with their owners: [chat-pipeline](chat-pipeline.md),
[LLM requests](llm-requests.md), [memory](memory.md) (the vector cache included),
[scripts and triggers](scripts-triggers.md), [plugins](plugin-sandbox.md), and [CBS/rendering](cbs-rendering.md).

### Issues

- Unconfirmed: a provider callback that ends `disconnected` fails its job through `endWith` and the runner's finalize
  (`jobs/runSetup.ts`), not the registry's `abort()`, so `JOB_ABORT_GRACE_MS` does not bound that end (the
  maximum-duration watchdog still does). The chat can stay busy longer than owner absence plus abort grace. Three runs
  on 2026-11-14 with a local provider callback (never delivered, closed before a chunk, closed after a partial reply)
  each freed the chat within the 120 s absence plus the grace and kept the partial reply.

### Limitations

- For plugin-handler requests, `server/src/prompt/transform.ts` `createTransformService` checks the shared scope against
  the 8 MiB snapshot limit before preparing each cache miss; an oversized scope fails every uncached target, while
  cached hits still answer. Decision: Display Evaluation S3, [archive](../archived-plan/README.md).
- An older socket without `liveness=1` never expires for silence; a frozen tab can hold a callback and chat slot until
  its 30-minute deadline. Decision: Job Protocol D6, archive.
- Without `hydration=patch`, each callback sends the whole job chat. Older tabs can reapply it only after local work
  settles, so traffic scales with callbacks × chat size
  ([measured](../reports/measurements/server/server-measurements-2026-11-01.md)). Decision: Per-Event Server Work D4,
  archive.
- An owner behind a `streamed` row's `seq` (after missed chunks) reads the job chat whole once (`resync`); `proto` is
  only logged. Decision: Incremental Chat Transport D3, D4, archive.
- Restart ends a running job as `shutdown`; reply text since its last checkpoint (3 s target, `CHECKPOINT_INTERVAL_MS`)
  is lost, and its message fence stays open until an ordinary write. Decision: Job Protocol D1, D8, and Q3, archive.
- A quiet (Half Streaming) stream writes no checkpoint: a graceful shutdown finalizes the text so far inside its grace,
  but a process lost without it (a crash, a kill) leaves the reply as last stored: no row for a new reply, the prefix
  for a continue. A checkpoint would show the hidden text on every client. Decision: Generation Progress Window D23.
- If receipt storage degrades, outcomes stay in memory and are lost on restart; without a persisted receipt, request
  deduplication also ends at the memory caps. WAL `synchronous=NORMAL` may lose recent writes on power loss, and the tab
  shows `serverJob.endedAway` when no outcome receipt remains. Decision: Job Protocol D1, archive.
- A callback delivered to an owner whose device then sleeps is not handed over; `handoff: "prefer"` only opens an offer.
  `server/src/jobs/generationJobs.ts` `create` starts the job without waiting for a worker to claim that offer, so the
  first callback can run on the creator. Decision: Job Handoff Q4 and D3, [archive](../archived-plan/README.md).
- A callback cancelled before a switch may still run its hook, writes included, on the old tab beside the worker's next
  one; `holdDraining` keeps only the old lane busy. Decision: Found Issues Sweep Q5.
- An `absent` offer leaves a worker 50 s before the job's first undelivered callback expires, but a queued root that
  another job's expired root settles `disconnected` (the cascade in `createChannelHub`) can end sooner. Decision: Job
  Handoff D3.
- Lua stuck in native code cannot reach its abort hook; worker termination waits for abort grace, and queued work waits
  for a replacement. Decision: Server-Owned Data script worker spike, archive; `server/src/lua/runtime.ts`.
- Job traffic and parse work grow with the collection, not the change: every job parses its whole scope (the modules
  record, every section and preset); `emitRecords` sends records and other chats whole; a job socket's `chatPatch`
  carries the chat metadata whole (`ChatPatchBody.meta`); a `ChannelChunk` keeps its recovery snapshot, and cumulative
  text for a tab without the `chunks: "append"` offer, beside the sequenced appends. Neither socket is compressed (HTTP
  JSON reads are). Decision: Audit Findings and Performance Leftovers, archive; Found Issues Clearance (owner,
  2026-11-09).
- Server CBS evaluation runs on the main thread under cooperative limits, with no hard deadline or heap bound. Other
  prompt work (Jinja rendering, non-worker lore matching) also runs there; local tokenizers run in a worker
  ([tokenizers](tokenizers.md#flows)), so a read and a short count are answered while a long count runs
  ([measurements](../reports/measurements/server/tokenizer-worker-2026-11-22.md)). Decision: owner, 2026-11-10
  (known-issues review): worker isolation is a separate design.
- A command's parts each load the job scope again (`server/src/jobs/commandRunner.ts` calls `runPromptSend`, which calls
  `loadJobScope`), so a request interception rule saved while a `/multisend` command runs reaches its later parts; a
  group send keeps one list. Decision: owner, 2026-11-21 (found-issues review): it needs a rule edit during a multi-part
  command.

### Gotchas

- The job receipt writes are synchronous `node:sqlite` calls on the serving thread, at each admission and each job's
  end. A slow volume delays every request while a receipt write runs; a throttled local disk is unmeasured
  ([measurements](../reports/measurements/server/server-measurements-2026-11-01.md)).
