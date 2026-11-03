# Server generation and live channels

## Scope

- Owns the server side of generation and live updates: job admission, request identity, receipts, command sequences, the
  job channel, the integration of the prompt, Lua, LLM, and translation runtimes, transforms, the memory task and token
  routes, and the live-update feed.
- Contracts shared with the tab stay with [chat-pipeline](chat-pipeline.md); each domain's semantics stay with its
  owner, listed in [Known Hazards](#known-hazards), and translation with [media and auxiliary work](media-aux.md).
- Neighbors: [self-host server](self-host-server.md) owns the process, middleware, limiters, and auth;
  [server resources](server-resources.md) owns the store and its routes, and the feed publishes that store's commits.

## Files

### Runtime modules

- `jobs/` owns admission, locks, and the client channel; `prompt/` contains the generation pipeline and helpers; `lua/`
  and `scripts/` provide the worker-backed script runtime.
- `llm/` adapts providers and credentials; `translation/runner.ts` stores server-side translations
  ([media and auxiliary work](media-aux.md)); `data/generationReceipts.ts` keeps the [job receipts](#job-receipts);
  `data/vectorCache.ts` stores embeddings ([memory](memory.md)).
- Dispatch and assembly entrypoints: `jobs/commandRunner.ts` (`createGenerationRunner`, `runCommand`),
  `prompt/runner.ts` (`runPromptJob`, `runPromptSend`), and `prompt/assemble.ts` (`assemblePrompt`, `AssemblyHost`).
- `data/changeFeed.ts` and `routes/events.ts` carry the live-update feed.

### Generation routes

`routes/generations.ts`: JWT, authenticated limiter. "+ epoch" is the
[resource epoch rule](server-resources.md#epoch-and-response-rules).

- `POST /api/generations`: creates a generation job (`GenerationCreateBody`, optional `requestId`, `x-resource-epoch`
  checked by `create`, not by the route): `{ jobId }`, or a replay `{ jobId, replayed: true, owned, status }`; 409
  `requestIdReused` or `requestCancelled`; 409 `chatBusy { jobId }`, `stale`, `chatBindingIncomplete { problems }`,
  `chatBindingMismatch`, or `chatLoreOverrideOrphaned { entries: [{ id, name }] }`, 404, 412, 503.
- `GET /api/generations/current?characterId=&chatId=&clientId=`: read-only chat-slot lookup:
  `{ jobId, kind, owned, stage?, sequence? }`; optional `clientId` determines `owned`, never attaches or grants channel
  access; 404 `idle`, 400 invalid ids. Registered before `/:id`.
- `POST /api/generations/stop`, + epoch: `{ characterId, chatId, jobId, clientId }`: aborts only that chat's named
  current job, including its sequence; `{ aborted }` (false if already aborting); 409 `jobChanged`, 404 `idle`, 400
  invalid ids, 412 stale epoch. `clientId` is attribution only.
- `GET /api/generations/:id?clientId=`: the owner's `GenerationStatus` (404 for another client's job); after the 60 s
  grace a collected job's [kept outcome](#process-memory) still answers `state: "ended"`, `kept: true`, with a trimmed
  terminal, and it can no longer be attached.
- `POST /api/generations/cancel`, + epoch: `{ requestId, clientId }`: unknown id → `{ state: "cancelled" }` tombstone;
  admitted id → `{ state: "aborted" | "ended", jobId, owned, status }`. Aborts that request regardless of owner; never
  stops another job in its chat.
- `DELETE /api/generations/:id?clientId=`: aborts the owner's job: `{ aborted }`.
- `POST /api/generations/:id/memory-stop?clientId=`, + epoch: stops the owner's job's initial memory summarization run
  (`{ runId }`) after its summary in progress, the job going on: `{ stopped: true }`; 400, 404, 409 `jobEnded`,
  `noMemoryRun`, or `otherMemoryRun`, 412.
- `POST /api/generations/:id/drained?clientId=`: the owner reports a callback of its job the server cancelled as no
  longer running in the tab (`ChannelDrainedBody` `{ callbackId }`), freeing the client's channel lane: `{ drained }`
  (false when it held none; also for an ended job still kept); 400, 404.
- WS upgrade `/api/generations/:id/ws?clientId=&attach=&liveness=&hydration=`: JWT in the `risu-auth` query or header
  (never the password), no HTTP limiter. The owner's `GenerationEvent` stream; with `liveness=1` the tab answers each
  `ping` with a `pong`; with `hydration=patch` a callback barrier sends the job chat only when it changed
  ([Job chat and barriers](#job-chat-and-barriers)).

### Transform, translation, and memory routes

JWT + epoch, authenticated limiter.

- `POST /api/transform` (8 MiB cap after authentication): the script transform (`TransformRequest`,
  `shared/transform.ts`): `{ results, same? }`, with `{ snapshotId, pending }` added when targets await the tab's plugin
  handlers; optional target `knownKey` (64 lowercase hex characters, else 400) and exact cache-hit `same`
  [confirmations](#transform-confirmations). 400, 404, 409 `chatBindingMismatch`, 412, 413, 503 `Retry-After: 5`.
- `POST /api/transform/continue` (8 MiB cap): the second call after the tab's plugin handlers
  (`TransformContinueRequest`): `{ results }`, always full answers; `same` belongs only to the first call. 400, 409
  `SnapshotExpired`, 412, 503.
- `POST /api/translate/message` (16 KiB cap after authentication): translates one stored message on the server:
  `{ outcome, translation }` (`applied`, `ignored`, `fresh`); 400, 404, 409 `generating`/`chatBindingMismatch`, 412,
  413, 429, 502, 503 `Retry-After: 5`, 504.
- `POST /api/memory/tasks`: a manual memory task start (`{ characterId, chatId }`, 4 KiB cap after authentication):
  `{ outcome: "running" | "queued", status }` or `{ outcome: "pendingManual" }`; 400, 404, 412, 413, 429 `queueFull`,
  503 `notEnabled` (the runner's service disabled or replaced, tests), 503 `Retry-After: 5` (shutdown, maintenance);
  `no-store`.
- `DELETE /api/memory/tasks/:characterId/:chatId`: cancels the chat's memory task: `{ cancelled }`; 400, 404, 412, 503
  `notEnabled`; `no-store`.

### LLM and token routes

JWT, authenticated limiter.

- `POST /api/llm/request`, + epoch: one provider request on the server (`LlmRequestBody`, `shared/llm/request.ts`); an
  SSE stream of `LlmRequestEvent`s; 400, 409 (`channelCall` not running; with `args.chatRef`,
  `chatBindingIncomplete { problems }` or `chatBindingMismatch`), 412, 429 (32 per client), 503.
- `POST /api/llm/request/:id/answer`: answers one of the request's callbacks
  (`{ clientId, callbackId, outcome, value | error }`): `{ accepted }` or `{ ignored }`; 404 for another client's or an
  ended request.
- `POST /api/tokens/count`: `{ scope: TabTokenScope, texts }` (2 MiB cap after authentication, 512 texts): `{ counts }`,
  null only for a refused text; 400, 413, 429, 500, 503 `Retry-After: 5` (maintenance, shutdown); `no-store`. It aborts
  its current batch and Google request when the client disconnects.
- `POST /api/tokens/encode`: `{ tokenizer, text }` (2 MiB cap after authentication): `{ ids }`, the tab's playground
  family; 400 (bad body or refused text), 413, 429, 500, 503 `Retry-After: 5` (maintenance, shutdown); `no-store`.

### Live-update socket

- WS upgrade `/api/events/ws`: JWT in the `risu-auth` query or header (never the password), no HTTP limiter. The
  live-update stream of `hello`, `change`, `memoryTask`, `epoch`, and `ping` frames (`shared/events.ts`), bounded by
  [Frame admission](#frame-admission) and the [publication budget](#publication-budget).

## Flows

### Live-update hello

The live-update `hello` samples the epoch, generation locks (`streaming`), memory task statuses (`memoryTasks`) and
optional `digest` in one synchronous step before registering the socket. The digest is
`revisionDigest(resources.listRevisions())` (`shared/resources.ts`); a digest failure is logged without data and omits
only that field, while failure of another snapshot closes the socket with 1011. A client whose seeded advertised map has
the loaded epoch and matching digest reconciles from that map; otherwise it reads `/api/resources/revisions`. Nothing is
replayed.

### Frame admission

Every other frame is admitted by its own size (`routes/events.ts` `send`): a fan-out frame (`change`, `memoryTask`,
`epoch`) is measured once, as the UTF-8 length of its text, and that length is used for every socket; the `ping` is
measured the same way. The server does not enable permessage-deflate, so that length is the frame's payload. A socket
whose `bufferedAmount` plus the frame's length would pass `MAX_BUFFERED_BYTES` (4 MiB) is terminated before the frame is
queued, the other sockets still get the frame, and the client reconnects and [reconciles](#live-update-hello); a frame
that reaches the bound exactly is sent. ws's `bufferedAmount` also counts the queued frame headers (2 to 10 bytes a
frame), which the admission leaves out, so an admitted frame can leave it one header above 4 MiB. The `hello` is checked
on `bufferedAmount` alone: its snapshots are not bounded, and a `hello` that could never be admitted would have its
client reconnect forever. What a `change` frame's patches may add is bounded by the
[publication budget](#publication-budget).

### Own chat changes

- A server writer that passes `changes: true` with its `committed` hook to `applyChanges` gets
  `committed(applied, written)`. `written.chats` is aligned with `applied.chats`: each by-id group's change as stored.
- `ChatWriteChange` in `chatStore.ts` holds the stored revision right before the group, even for a stale group, and the
  revision after it; the message count; the ids it removed that were there before it, in removal order; every row it
  touched as its stored `data` string with the id of the row before it, in position order; the stored `meta` string when
  it changed the metadata.
- It is `undefined` for a group without a by-id change: a create, replace, or delete, a remove and reappend of one id, a
  remembered group, or a group that applied nothing.
- The change is uncapped and built only for a writer that asks: the feed keeps its capped patch or delta (taken from
  that change, and subject to the [publication budget](#publication-budget), which leaves `written` as it is), a write
  without the option still stops reading at the feed's byte cap, and the HTTP batch body is unchanged.

### Feed chat entries

`ChangeSet.chats[]` (`shared/resources.ts`) is built in `chatStore.ts` `applyGroup` and kept in a feed-only map by group
result, never in `ChatGroupResult`, the HTTP body, or `ChatWriteChange`. Every by-id group that applied something
carries what it knows about the chat's summary, and its by-id change when that fits.

- Summary: `summary` (the chat's summary at the group's revision) when the group changed it, else `summaryBase` (the
  group's stored base revision: the summary, its `revision` aside, is the same as there).
- Both parts are compared, never the revision: the stored projection text before and after the group (nothing is parsed
  for it) and, for a group with a message op, `lastMessageAt` right before its first one (taken even when absent) and
  after the group, read inside the transaction (never from the memo), so a note edit with a removal of the last row, or
  an op that leaves no dated last row, counts.
- A changed summary of a group without a message op reads the time once to be complete. A remove and reappend carries it
  too. A whole-chat write, a remembered group, a no-op group, and a deletion carry neither: unknown, which keeps the
  client's summary-list read.
- By-id change (`chatFeedChange`): one pass over the stored parts. A `patch` with the metadata whole when it fits
  `MAX_FEED_PATCH_BYTES`; at the first byte over, a group that changed the metadata switches to a `delta`, with the rows
  already read and the same row iterator. Neither when that does not fit either.
- A `delta`'s `metaFields` (`ChatMetaFields`) is the field diff of the stored metadata before and after the group (never
  the ops: a stale group merges onto the stored base and normalization rewrites the result): top-level fields `set` or
  `remove`d, and for a `CHAT_META_MERGE_KEYS` field that is a map on both sides its entries by `merge`/`mergeUnset` (a
  field that becomes or stops being a map, or appears or disappears, goes through `set`/`remove`).
- An entry carries at most one of the two; the job socket's `chatPatch` keeps the whole `meta`. A write without
  `changes: true` still reads rows only while a form fits (an over-cap metadata is parsed for its field form, never the
  rows past the cap).

### Coalescing and publish order

- Coalescing (`resourceStore.ts` `coalescedChat`, for a chat recorded again in a publishing scope and for nested scopes
  in `mergeChanges`): the later ref without a patch or delta; the later `summary`, else the earlier `summary` moved to
  the later revision when the later entry's `summaryBase` is the earlier revision, else (both unchanged in a row) the
  earlier `summaryBase`; otherwise neither. Entries are never changed in place, since a failed outer write merges its
  committed nested scopes again.
- Change feed events reach listeners in publish order, including events a listener publishes while handling another
  event. Listener failures are logged and the feed continues draining. Committed nested writes still publish their refs
  when an enclosing write fails during input evaluation.

### Publication budget

- One committed outermost write is one `change` frame (`feed.publish` once), and the optional payloads of that frame
  (record `patch`es, chat `patch`es and `delta`s, each within `MAX_FEED_PATCH_BYTES`, 64 KiB, when built, and chat
  `summary` and `summaryBase` fields) total at most `MAX_FEED_PUBLICATION_PATCH_BYTES` (256 KiB of UTF-8 JSON,
  `shared/resources.ts`).
- The store applies it only when the outermost publishing scope publishes (`resourceStore.ts` `budgetedEntries`): after
  nested scopes merged, after coalescing dropped the patches and deltas of keys recorded twice, and after a failed outer
  write kept only its committed nested writes. A nested scope neither spends nor resets it, and a feed listener's own
  write is a later publication with a budget of its own.
- The walk takes the final entries in wire order (resources, then chats; chat orders carry no payload), and within a
  chat entry its `patch` or `delta` before its `summary` or `summaryBase` (each measured as its own JSON, a
  `summaryBase` with its quotes).
- A payload stays when the running sum including it fits, otherwise its entry is published as a copy without it in the
  same place (a dropped `summary` leaves neither summary field, so the entry's summary is unknown) and the walk goes on,
  so a later smaller payload can still fit. Every candidate payload is measured, so the cost follows the payloads the
  write built, not the frame.
- Refs, chat-order entries, and `streaming` lock lists are never dropped, reordered, or split, so a chat's locks stay in
  the frame of its chat ref and a lock release with no refs (`publishStreaming`) is still published.

### Transform confirmations

`routes/transform.ts`, `prompt/transform.ts` `partitionKnownResults`: a target's `knownKey` only changes the answer for
an ordinary successful cache hit with exactly that key. The first call returns `same` as a separate `{ id, key }[]`
field, present only when non-empty, with no text or emotions; each target is answered once in `results`, `same` or
`pending`. A different key, an evicted entry, a fresh run, `noCache`, a failure and every continuation answer in full
(or await handlers on the first call). Admission and refusals are unchanged.

### Local model refusals

`prompt/transformers.ts` `localModelRefusal` keeps its status: a full queue answers 429, an expired queue wait
answers 503. Prompt jobs and manual trigger commands both use that mapping; server translations preserve the refusal
status carried by a failed WebLLM request.

### Generation admission

- After the route's limiter, authentication and body validation, `create` checks the epoch, synchronizes the identity
  maps and receipts with that epoch, and looks up `requestId` before checking shutdown/maintenance/the gate, hooks, chat
  existence, the chat slot, revision, binding, and orphaned overrides. Lookup through slot and request-index
  installation is synchronous; the runner starts on a later microtask, so identical simultaneous requests admit once.
- `requestId` matches `GENERATION_ID_PATTERN`. `jobs/generationJobs.ts` `requestFingerprint` covers exactly `kind`,
  `characterId`, `chatId`, `command`, `input`, `userMessageId`, and `continueMessageId` with SHA-256 over recursively
  sorted JSON keys (array order preserved, absent fields null). Revision, binding ids, hooks and client id are excluded.
  A body without an id still admits normally, without deduplication, with the epoch checked before the gate.
- Lookup reads current-epoch live jobs (including ended jobs in grace), then kept identities, cancellation tombstones,
  then disk. A matching fingerprint returns 200 with the original job and its status, even if ordinary admission would
  now refuse. `status: null` means its payload was pruned. Another fingerprint returns 409 `requestIdReused`; a
  tombstone returns `requestCancelled`.
- Ownership is client-id equality; a non-owner's status is a copy without `terminal.result`. GET/DELETE by job id,
  sockets and callback routes remain owner-scoped. The chat-slot `GET /current` and `POST /stop` are available to any
  authenticated tab or device.
- Cancel is idempotent: a running request is aborted, an ended request is left intact, and an unknown request receives a
  tombstone in memory before its best-effort disk write. Cancelling again preserves the timestamp. An abort
  acknowledgement is not a terminal; the runner still has its existing abort grace to save and end. Cancel also works
  during maintenance/shutdown.
- A retry's auth, limiter or body-reader failure happens before lookup. After an unanswered create, only a decoded
  registry success/replay or a refusal that fences the delayed original resolves that exchange: `requestCancelled`,
  `requestIdReused`, `stale`, `chatBindingMismatch` and 404.
- A refusal installs no identity, so after one the original can still be admitted: the 503s, `chatBusy`,
  `chatBindingIncomplete` and `chatLoreOverrideOrphaned` keep the request uncertain, as do 412, 429, auth/body-limit
  errors and generic errors. This does not bypass the shared limiter or promise connectivity after the listener closes.

### Prompt job execution

- `createGenerationRunner` sends `command` jobs to `runCommand` (`memoryRecord` to `runMemoryRecord`, `memoryTest` to
  `runMemoryTest`, `memoryRebuild` to `runMemoryRebuild`); other kinds go to `runPromptJob`, which delegates one send to
  `runPromptSend` and emits `done` after it returns. Command sequences call `runPromptSend` per part
  ([Command sequences](#command-sequences)).
- When input processing applies, it runs on the admitted preset before `presetChain`; `assemblePrompt` runs per speaker
  after a continue message is locked. Its `AssemblyHost` supplies job-scoped reads and writes, callbacks, token
  counting, and memory services. Assembly's prompt and lore behavior is owned by [chat pipeline](chat-pipeline.md);
  memory algorithms are owned by [memory](memory.md).
- After final chat writes, `runPromptSend` hands off translations and due memory input before returning. Both handoffs
  are detached and cannot fail the send; `runPromptJob` emits `done` after it returns.

### Command sequences

- `prompt/commands.ts` parses `/multisend`; `jobs/runSetup.ts` queues its clear flag and texts in server-local run state
  for command jobs, with at most `MAX_SEQUENCE_PARTS` (64) parts of at most `MAX_SEQUENCE_PART_CHARS` (100,000)
  characters. An over-limit command raises an `alertError` notice and queues nothing. Inside a send it does nothing.
- `jobs/commandRunner.ts` runs queued parts after a Lua button, form, or manual trigger finishes, keeping one id, chat
  slot, channel, owner and hooks. Before each part, the registry synchronously checks abort, the previous deadline,
  shutdown, maintenance/gate, epoch, chat existence, complete binding equal to the admitted context, and orphaned lore
  overrides. A preset-chain pick never changes that comparison. Neither the occupied slot nor the original chat revision
  is rechecked.
- With no await after that check, one token-owned chat write removes all messages when clear is set (omitted for an
  empty chat) and appends the user part with a fresh message id and no timestamp. The owner receives the chat after the
  write. A refusal writes nothing for that part.
- `prompt/runner.ts` `runPromptSend` runs each part as a normal send with empty input, so no input trigger or
  `editinput` runs. Its send view retains registry methods and signal, removes the command's trigger/speaker/message
  ids, and uses fresh run state and script budget while carrying the emotion history forward. Pending metadata is
  flushed before changing views.
- Each part has its own generation ids, reply locks, stages and request-history rows; translation and memory hand-offs
  occur before it returns. Deleted reply locks are released without ending the job.
- `JOB_MAX_DURATION_MS` (30 minutes) applies anew to each admitted part; an already-expired deadline aborts instead of
  resetting. Total diagnostic duration still starts at job admission. After a part returns, the job updates memory and
  best-effort receipt progress, then sends the live-only `sequence` event (`index` is zero-based, with `total`, `sent`,
  and optional reply id and alternatives). A removed reply counts as sent; a send returned stopped does not.
- The one terminal carries `sequence: { total, sent, stopped? }`: boundary refusals and a returned stopped send end done
  with the refusal code or `notSent`; thrown errors and registry aborts keep error terminals with the current progress.
  The first abort still wins. A command with no queued parts has no sequence.
- Auto-checkpoint runs once after a done sequence with an attempted part, after the slot is released; it cannot run
  between parts. Parts needing no browser callback continue without the page; a needed callback uses the channel's
  existing absence rules.

### Chat-slot lookup and stop

- `current` reads `chatSlots`, including command jobs with no generation lock. It never attaches, changes ownership, or
  enables callback answers. `stop` checks the epoch, compares the current slot with the confirmed job id, and aborts
  synchronously; after a 409 `jobChanged` the replacement must be looked up and confirmed again.
- The first abort decides: only an explicit stop by a different `clientId` adds `abortedBy: "other"` to the error
  terminal and `stoppedBy: "otherClient"` to the diagnostic end event. These remain reason `aborted`, not failures;
  request-id cancel and owner DELETE stay unattributed. The abort ends the whole command sequence through the existing
  abort path, retaining its progress and attribution in kept outcomes.

### Generation channels

`jobs/generationJobs.ts` holds the owner clock (`ownerAbsentDeadline`); `jobs/channel.ts` applies it (`absenceDeadline`,
`effectiveDeadline`).

- The tab attaches `/api/generations/:id/ws` with `liveness=1` and answers every `{ type: "ping", ts }` with
  `{ type: "pong", ts }`, echoing `ts` before checking the event epoch. The registry uses its own clock: a negotiated
  socket with no incoming frame for `OWNER_SILENT_MS` (45 s from attach, then its last frame) is removed from the owner
  set before being closed.
- Socket events and owner-presence reads check silence too, so a late timer or frame cannot revive it. MCP sees the same
  effective owner presence. Sockets without the query retain the [older-tab rule](#limitations).
- `ownerAbsentSince` starts at admission, clears at attach, and starts again when the last effective socket leaves.
  Silence starts absence at the silence deadline, even if detected later; a superseded socket's close does not change
  it.
- Each dispatched question or callback uses the minimum of its own deadline, the job's absence deadline
  (`ownerAbsentSince + OWNER_ABSENT_MS`, 120 s), and its parent's effective deadline. Owner transitions re-arm channel
  wakeups. The registry and its default hub share the injected `now` clock; `ownerAbsentMs` / `ownerSilentMs` are test
  overrides, forwarded by `app.ts` as `generationOwnerAbsentMs` / `generationOwnerSilentMs`.
- Answers, chunks, dispatch, attach, parent lookup and `watchCallback` check the effective deadline. Attach expires
  overdue requests while still absent, then clears absence, sends its snapshot and replays requests still open.
  Reconnecting within the wait removes the absence cap without extending a request's own allowance.
- Absence expiry settles `disconnected` through the existing path, including that client's ownerless queued roots opened
  no later than the expired root's dispatch. A queued root also wakes at its own job's absence deadline (its own timeout
  still starts at dispatch), and an attach after that deadline settles it `disconnected` instead of delivering it; a
  never-dispatched root gets no `cancel` and no drain hold.
- Delivered callbacks keep their drain holds; socket departure never releases them or changes `/drained`. There is no
  job-wide absence abort: callback-free sequence parts and detached memory tasks keep running.
- On `disconnected`, request hooks (`editinput`, `editprocess`, `replacerbeforeRequest`, `bodyIntercepter`) end the job.
  A completed reply's hooks skip and the job goes on: `editoutput` and `replacerafterRequest` keep the text (later
  scripts still run); `chatOutput` and image callbacks run nothing. The first three are kept in order as `done.skipped`
  (`JobRunState.skippedHooks`); the tab runs the listeners late once it holds that revision (`replaySkippedListeners`).
- On attach, buffered notices, outstanding request replays, and first deliveries of requests promoted by an expiry are
  sent in their original request/notice order. A promoted request joins that ordered batch and is sent once.

### Job chat and barriers

- The owner's job chat `chatPatch` is the diff (`diffChat`) of two stored states of the job chat: `sentChat`, the last
  copy a socket took (seeded at admission; a successful `send` advances it, with no acknowledgement from the tab), and
  `workingChat`, the chat as the job's own writes left it.
- `writeAsJob`'s `committed` hook advances `workingChat` by each own write's `ChatWriteChange` (`applyChanges` with
  `changes: true`) when the change starts at its revision, placing the rows as the scope's adoption does
  (`messageOrderAfterChange`); a write without a by-id change, a change that starts at another revision (another
  writer's write landed first), or one that does not fit sets it to null.
- A patch-mode job chat event reads only the chat's revision while `workingChat` is at it and parses only the carried
  rows; otherwise it reads the chat whole, and that read becomes `workingChat` while the job runs. A checkpoint with no
  open socket advances only `workingChat`, so the next attach's patch carries every checkpoint since `sentChat`. A
  `resync` sends the chat whole; the end clears both baselines.
- The callback barrier (`hydrateAll`, run when a `callback` event is built, replays included) first flushes the job's
  pending own write. When the owner socket attached with `hydration=patch` and a socket took a copy (`sentChat` is set;
  `hydrateJobChat`), it then reads the job chat's revision once: still `sentChat`'s, it sends no chat event and the
  receipt names that revision; otherwise it sends the patch-mode job chat event (a `chatPatch` from `sentChat`, or
  whole) and its receipt.
- A socket without the flag (an older tab) gets the chat whole on every callback. Every other record the job sent goes
  fresh as before. The skip relies on the job's `streaming` list not changing while the revision stays: watermarks move
  only with an applied checkpoint, and the one lock release without a chat write (`releaseRemovedReplies`) is followed
  by the job's end or the next sequence part's writes, which precede that part's callbacks.
- A callback's client barrier flushes local work and retries the job's remembered hydration copies. When the job chat's
  receipt is still not held (no remembered whole copy, an older one, or one refused by the acknowledged floor), it makes
  one whole resource read of the job chat, even while streaming, fenced on the callback, epoch, chat owner and
  incarnation, and job metadata, and installs it with the job's newest held `streaming` list.
- Normal hydration admission still protects local work and the floor; the callback runs only when the client holds every
  receipt or a newer revision ([chat store](chat-store.md#callback-hydration)).

## State

### Job receipts

`data/generation-jobs.sqlite` (plus its `-wal` and `-shm` files) holds the generation job receipts
(`data/generationReceipts.ts` `createGenerationReceipts`). Like the request history it is in no snapshot or archive.

- Table `receipts`, one row per job: `job_id` (primary key), `request_id` and `fingerprint` (null for older clients;
  unique `(epoch, request_id)`), `client_id`, `epoch`, `kind`, `character_id`, `chat_id`, `admitted_at`, `ended_at`
  (null while the job runs; indexed), `progress` (the sequence's `{ total, sent }` JSON, otherwise null), and `status`,
  the kept `GenerationStatus` JSON: no `result`, alternatives over 64 KiB of JSON dropped, error message cut to 4 KiB,
  `sequence` intact.
- `PRAGMA user_version` is 1; a file of another version is left untouched and the store runs degraded. WAL with
  `synchronous=NORMAL`.
- A cancelled request uses the same table: `job_id = "cancel:" + requestId`, private `kind = "cancelled"`, empty
  character/chat ids, `admitted_at = ended_at` at cancellation, and null fingerprint/status/progress. It is never served
  by a job-status read and is pruned with compact rows.
- Writes: the registry upserts a row synchronously at admission and at the job's end (every terminal path: done, error,
  abort, timeout, shutdown, maintenance), and writes sequence progress before the first part (`sent: 0`) and at each
  completed part boundary before its event.
- Reads: a status answers from memory first (the live job, then its kept outcome); the disk answers only an id memory
  does not hold, only to the row's `client_id`, and only in the current epoch. Request lookup is shared across clients
  and returns the identity even when its status payload is gone. Lookup, admission and cancel synchronously delete an
  expired matching request row before reusing its unique key, never replacing a live identity.
- At open, rows of another epoch are deleted and every running row is ended as a kept
  `{ type: "error", reason: "shutdown", status: 503, message: "The server stopped while this job ran" }`, keeping its
  `progress` and including it as terminal `sequence` when it is a valid object of non-negative integer `total` and
  `sent`, with `sent <= total`; this runs once per open. Remaining parts are not resumed.
- An epoch change (the maintenance end, or the registry noticing it at a status read, an admission, or the GC tick)
  deletes the old epoch's rows in one transaction.
- Retention, pruned on the 30 s GC tick in bounded transactions: a row's `status` is cleared 24 h after its end
  (`KEPT_OUTCOME_MS`, also checked at every read, so an expired payload never reads back before the prune) or when it is
  not among the 500 newest payloads (`MAX_KEPT_OUTCOMES`); the compact row stays 72 h after its end
  (`GENERATION_RECEIPT_MS`), at most 10,000 rows (`MAX_GENERATION_RECEIPTS`, oldest end first). A running row is never
  pruned.
- Degraded mode: a failure to open, write, read, sync or prune closes the connection for the rest of the process. The
  disk is no longer read or written, jobs are admitted and end as before, the in-memory kept outcomes go on, and the
  failure is one content-free `runtime` event (origin `generation.receipts`).

### Process memory

- Generation registry, chat slots, sockets, lock, and request-id index are process-local and lost on restart. An ended
  job is readable for 60 s (`JOB_DONE_GRACE_MS`), then its trimmed outcome stays in memory for 24 h/up to 500 entries
  (`KEPT_OUTCOME_MS`, `MAX_KEPT_OUTCOMES`); status falls back to the [receipt](#job-receipts) after restart. Epoch
  changes clear memory.
- Request identity moves from live job through grace to the kept entry, then disk. Cancellation tombstones are kept in
  memory 72 h/up to 10,000 entries; epoch changes clear both.
- The transform service (`prompt/transform.ts`): its result LRU, pending two-call snapshots and pins, plus
  `prompt/displayScope.ts`'s `createDisplayScopeLoader` (raw configuration and transcript caches, shared read-only, with
  a fresh projection per request). Maintenance aborts renders and empties these caches; shutdown aborts renders and
  clears the loader ([CBS rendering](cbs-rendering.md), [chat pipeline](chat-pipeline.md)).
- The change feed and live-update sockets are process-local and buffer no events; clients reconcile on reconnect.
- The memory task registry (`createMemoryTasks`): per chat the running task, the queued input, the latest retained
  input, a waiting manual start, and the last terminal status (10 minutes), plus the held summary writer leases. A
  restart loses them: no task resumes.

## Coupling

- [Server resources](server-resources.md): a job's writes go through the store;
  [chat summaries](server-resources.md#chat-summaries), [chat activity](server-resources.md#chat-activity), whole-chat
  reads with `streaming`, and [maintenance](server-resources.md#maintenance) are defined there.
- [Self-host server](self-host-server.md): [Routes](self-host-server.md#routes),
  [Rate limits](self-host-server.md#rate-limits), and [Proxying](self-host-server.md#proxying) for the local-network URL
  and abort policy of a streaming job.
- [Scripts and triggers](scripts-triggers.md): Lua worker gates and trigger effects; [plugins and MCP](plugins-mcp.md):
  the server MCP registry and plugin providers.

## Invariants

- A job writes only while its admitted epoch and live job token remain valid. Message ownership is checked in the same
  synchronous store transaction as the write.
- Credentials for server provider requests are resolved server-side; the record stays
  [write-only](server-resources.md#invariants).
- The feed publishes only what the resource store committed ([Invariants](server-resources.md#invariants)).

## Recipes

- Change the job contract across `shared/jobs.ts`, `server/src/jobs/generationJobs.ts`,
  `server/src/routes/generations.ts`, and `src/ts/network/generationJobs.ts`; hydration belongs to
  [chat store](chat-store.md).

## Tests

The in-process harness and the slow table are in the [shell's Tests](self-host-server.md#tests).

- `chatMetadataCoalescingEvents.test.ts` identifies the job fixture's SQLite connection by its epoch and counts
  transactions on it, so background writes in other stores cannot alter the coalescing assertion.
- `util/playwright/checkJobProtocol.mjs` is the real-server browser check for the job protocol
  ([test-harness](test-harness.md)).
- Jobs:
  `pnpm --silent test:agent server/src/tests/{generationJobs,generationReceipts,generationDeltaChunks,generations,commandSequences,generationBarrier,jobChannel,promptRunner}.test.ts`.
- Feed: `pnpm --silent test:agent server/src/tests/{changeFeed,events,chatMetadataCoalescingEvents}.test.ts`.
- Transform and translation: `pnpm --silent test:agent server/src/tests/{transform,transformService,translate}.test.ts`.
- LLM and tokens: `pnpm --silent test:agent server/src/tests/{llmRoutes,llmRequests,tokenRoutes,tokens}.test.ts`.
- Job modules and CBS: `pnpm --silent test:agent server/src/tests/{jobModules,dynamicAssets,cbs}.test.ts`.
- Other scripts, memory, MCP, and CBS tests are anchored in their owner guides.

## Known Hazards

Runtime limits of other subsystems live with their owners: [chat-pipeline](chat-pipeline.md),
[LLM requests](llm-requests.md), [memory](memory.md) (the vector cache included),
[scripts and triggers](scripts-triggers.md), [plugins and MCP](plugins-mcp.md), and [CBS/rendering](cbs-rendering.md).

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
- Restart ends a running job as `shutdown`; reply text since its last checkpoint (3 s target, `CHECKPOINT_INTERVAL_MS`)
  is lost, and its message fence stays open until an ordinary write. Decision: Job Protocol D1, D8, and Q3, archive.
- If receipt storage degrades, outcomes stay in memory and are lost on restart; without a persisted receipt, request
  deduplication also ends at the memory caps. WAL `synchronous=NORMAL` may lose recent writes on power loss, and the tab
  shows `serverJob.endedAway` when no outcome receipt remains. Decision: Job Protocol D1, archive.
- Lua stuck in native code cannot reach its abort hook; worker termination waits for abort grace, and queued work waits
  for a replacement. Decision: Server-Owned Data script worker spike, archive; `server/src/lua/runtime.ts`.
- The publication budget covers optional payloads only. Refs and lock lists are unbounded: ids may be 512 characters,
  character deletion can publish every chat ref, and in-process writes have no op cap. Decision: Per-Event Server Work
  D5, archive.
- If refs alone exceed the socket budget, the socket closes; frames are not split. Clients reconnect and
  [reconcile](#live-update-hello), taking chat locks from the same frame's chat ref and a ref-less lock release as
  `null`. Decision: Per-Event Server Work D5, archive.
- Measuring every candidate payload serializes it once, including rejected payloads, before the final frame
  serialization. Decision: Per-Event Server Work D5, archive.
- Feed payload construction runs on the serving thread: a rename reads/parses the last row via `messages_position` for
  `lastMessageAt`; a message-op group does this before and after, inside its transaction. Decision: Per-Event Server
  Work D6, archive; ST04 in the [server migration audit](../research/deep-audit-with-fable/server-migration-audit.md).
- Summary comparison uses stored projection text without parsing metadata. A metadata change past `MAX_FEED_PATCH_BYTES`
  parses metadata before and after for the field diff. Decision: Server Byte Budgets D4 and Per-Event Server Work D7,
  archive.

### Gotchas

- The job receipt writes are synchronous `node:sqlite` calls on the serving thread, at each admission and each job's
  end. A slow volume delays every request while a receipt write runs; a throttled local disk is unmeasured
  ([measurements](../audit/server-measurements-2026-11-01.md)).
- `server/src/lua/runtime.ts` uses wasmoon 1.16's private engine extension table and C API, which must be rechecked on a
  wasmoon upgrade ([scripts and triggers](scripts-triggers.md)).
