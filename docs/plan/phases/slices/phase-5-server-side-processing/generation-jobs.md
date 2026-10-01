# Slice: Generation Jobs

Status: implemented (2026-10-01).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 2 (the job route, events, abort,
one job per chat, the server-side generation lock, disconnect and reconnect); PLAN.md Decision 4
(the Phase 5 lock and one-job-per-chat rules) and Decision 1 (restore drains jobs; no transaction
held across a provider call; every write names the epoch).

Depends on: Phase 2 (`server/src/data/chatStore.ts` generation fence, `shared/chats.ts`). No Phase
3 or 4 dependency. The runner is injected; `prompt-assembly` supplies the real one.

## Scope

Allowed files: `server/src/jobs/generationJobs.ts` (new: the job registry, current-state
snapshot, GC), `server/src/jobs/generationLock.ts` (new), `server/src/routes/generations.ts`
(new), `server/src/app.ts` (one upgrade dispatcher by path prefix; route registration; the
runner's tracking), `server/src/main.ts`, `server/src/data/chatStore.ts` and
`server/src/data/resourceStore.ts` (the lock check on every destructive path),
`server/src/routes/resources.ts` (the 409 body), `shared/chats.ts` (`reason` on `ChatConflict`),
`shared/jobs.ts` (new: the event and request types), `src/ts/network/generationJobs.ts` (new:
the client transport), `src/ts/storage/chatStore.svelte.ts` (`applyServerGeneration`),
`src/ts/storage/resourceSync.svelte.ts` (`applyHydration` for resource events; the 409 `reason`
handling), `src/lang/en.ts`. `server/src/routes/proxyStreamJobs.ts` is not changed. Tests belong
to the review step.

Identifiers (verified 2026-09-30): `createProxyStreamJobs({ auth })` returns only
`{ registerRoutes, attachWebSocket, startGc, dispose }`; its job map, buffer, GC, and upgrade
matcher (`startsWith('/proxy-stream-jobs/') && endsWith('/ws')`) are private and hard-wired; its
`cleanupJob` aborts and deletes at once; it authenticates with `auth.isAuthorizedProxyToken`,
which accepts the stored password itself or a JWT (`server/src/routes/auth.ts:108-110`), while
the data routes use `checkAuth` (JWT only, 88-98). `createServerContext` (`app.ts:34-40`) returns
`{ app, snapshots, beginShutdown, attachWebSocket, startBackgroundTasks, dispose }`; `main.ts`
calls `attachWebSocket(server)` then `startBackgroundTasks()`; the self-host guide forbids a second
upgrade listener. Maintenance and shutdown: `snapshots.track` admits an operation into `active`
(`snapshots.ts:205-214`); `withMaintenance` waits for the storage gate's `entered` counter to
drain (149-186, 227-236); `stop` awaits `active` then `tail` (252-265); `app.dispose` awaits
`snapshots.stop()` then `resources.close()` (`app.ts:197-205`); the admission middleware answers
503 during shutdown (110-133). Fence: `beginGeneration` (`chatStore.ts:519-532`),
`admitGeneration` (486-504), `closeFence` (506-510); an ordinary `setMessage`/`setText` closes an
open fence and applies (679-705); `remove` ignores fences (707-722); `begin` with a new generation
id takes over an open fence at the current revision (724-740); `deleteCharacter` (774-778) is
reached from `resourceStore.delete` (462), `applyChanges` (561), and cascades to messages;
`replace` deletes and reinserts (607-629); `replaceAll` (931-960) is the restore path.
`ChatConflict` is `{ kind: "chat"; characterId; id; revision }` with no `reason`
(`shared/chats.ts:80`); `ResourceConflict` (`shared/resources.ts:82`) has none either. The
client's `chatGenerating` alerts are UI pre-checks (`Chat.svelte:177-196`,
`DefaultChatScreen.svelte:265-268`, `346-349`), not reactions to a server answer. In-process
writes go through `store.applyChanges({ ops?, chats, chatOrders? })` (`resourceStore.ts:475-590`).
The client learns of remote changes only on a 409 or an idle re-base (no push channel).

Stopping condition: a destructive path the lock cannot see from the store (one that bypasses
`applyChanges`, `delete`, and `replaceAll`); it is recorded and reported, not patched around.

## Assumptions

- A job's writes go through `store.applyChanges` in-process with the generation id and a trusted
  job token; the fence (`begin`, checkpoints with increasing `seq`, `final`) is unchanged.
- Phase 2's client lock (`isMessageLocked`, `beginGeneration` in `chatStore.svelte.ts:436-464`)
  keeps disabling the controls; this slice adds the server refusal and its client handling.

## Proposed decisions

- Upgrade dispatch (proposed): `app.ts` installs one `upgrade` listener that routes by path prefix
  to `proxyStreamJobs.handleUpgrade` (its existing handler, unchanged) or to the generation
  socket; `attachWebSocket` keeps its name. No generic hub, no refactor of `proxyStreamJobs.ts`
  (its replay buffer and immediate cleanup are not generation policies). The generation socket
  authenticates with the JWT only (`verifyJwt` through `checkAuth`'s rule), from the `risu-auth`
  query or header.
- Routes (proposed): `POST /api/generations` body
  `{ kind: "send" | "continue" | "reroll" | "group" | "preview" | "command", context, hooks, clientId }`,
  `context` = Decision 5's execution context (`characterId`, `chatId`, `presetId`, `personaId`,
  `mode`, `input`, `continueMessageId?`, `speakerChaId?`) plus the chat revision the client last
  saw and the epoch (`x-resource-epoch`); answers `{ jobId }`, 409 `{ error: "chatBusy", jobId }`
  when the chat has a live job, 409 `{ error: "stale" }` when the chat revision is behind, 404 for
  a missing chat, 412 for a wrong epoch. `DELETE /api/generations/:id` aborts (the runner's
  signal; the text so far is persisted). Events over `/api/generations/:id/ws`:
  `accepted { jobId, messageId, generationId, revision, text }` (also on reconnect, with the
  current text), `chunk { messageId, text, seq }` (whole text), `preset { presetId }`,
  `resource { kind, id, revision, data }` (a record the job changed, see hydration), `progress`,
  `done { revision, messageId, alternatives? }`, `error { message, status }`; `job-channel` adds
  `notice`, `question`, `callback`. `aux` requests are not jobs (see
  `request-layer-and-llm-secrets`).
- Owner identity (proposed): `clientId` is generated once per tab and kept in `sessionStorage`,
  sent at creation and on the socket handshake; after a reload the tab reads it back, and a 409
  `chatBusy { jobId }` on its next send lets it attach to the running job (`accepted` with the
  current text). No observer sockets in this phase (nobody can consume them before Phase 6).
- One job per chat (proposed): `Map<"chaId/chatId", jobId>`; a second create gets 409;
  `group` runs all speakers inside one job. Whether a `command` job (buttons, manual triggers)
  takes the chat's slot is an owner question (recorded in the report); the proposed default is
  that it does, so a button click during a send is refused with the same 409.
- Server lock (proposed): `generationLock.ts` keeps `Map<"chaId/chatId/messageId", { jobId, generationId, token }>`
  from the job's `begin` until its final write is applied or the job ends. Only in-process writes
  carrying the job's `token` pass; a client-supplied generation id never grants ownership.
  `chatStore.ts` and `resourceStore.ts` consult it through an injected `isJobOwned(...)`: from a
  client batch, `setMessage`, `setText`, single or multi `remove` naming the message, `begin` on
  it, `replace` or `delete` of the chat, and `delete` of the character (the cascade) are refused
  with a 409 `ChatConflict` carrying `reason: "generating"` (added to `shared/chats.ts` and to
  the batch 409 body); `meta` and ops on other messages still apply. The client's save loop treats
  `reason: "generating"` as a refusal to retry after the job ends rather than a stale reload, and
  shows `chatGenerating` once. A server restart clears the map (the fence then closes on the next
  ordinary write, as today); recorded. This is the Safety Contract item "The generating message
  cannot be edited until its job finishes".
- Maintenance and shutdown (proposed, minimal): a runner runs under `snapshots.track` (so
  `stop` and therefore `dispose` await it) and enters the storage gate around each write (so
  `withMaintenance` drains it before a restore or import replaces the store); a write after
  maintenance began fails with `MaintenanceError` and the job ends with `error`; the job carries
  the epoch it was admitted under and every write names it (`assertEpoch`), so a job that
  outlives a restore cannot write. No separate lifecycle beyond that.
- Hydration (proposed): the client applies job events through `applyServerGeneration(ref, { messageId, text, revision, generationId })`
  in `chatStore.svelte.ts` (mirror and saved revision updated, no op queued, the lock reactive
  through `isMessageLocked`, released on `done`) and `resource` events through
  `applyHydration({ kind, id, revision, data })` in `resourceSync.svelte.ts`, which applies the
  record only when its token's `seq` differs (the record was recreated) or its revision is higher
  than the held one, and never records a discard, a `discardSequence` bump, or a settled key,
  without a notice (PLAN invariant 2: hydration never becomes an outgoing edit; Phase 6's feed
  pushes the same records and two reads can resolve out of order, so the comparison is the
  deduplication). A record the client has dirty when a `resource` event arrives keeps its local
  edit and reconciles on the next save (409 as today).
- No transaction spans a provider call: each checkpoint is its own `applyChanges` call.

## Validation

`pnpm check`, `pnpm test` (`proxyStreamJobs.test.ts` and `proxyJobWs.test.ts` untouched and
green), `pnpm format:check`; the review step adds `server/src/tests/generations.test.ts` modeled
on `proxyStreamJobs.test.ts` (its `listen()` and `collect()` helpers, 113-152) with a fake runner:
create, events, abort, one-job-per-chat 409, reconnect receives the current text, attach from
`chatBusy`, a job finishing while no client is attached, GC, restore during a job (the job ends
with `error`, the restore succeeds), `dispose()` awaiting a runner; and `chatStore.test.ts` cases
for the lock (refused ordinary write, refused `begin` takeover, refused character delete, allowed
`meta`, allowed after the final write, a client-supplied generation id refused). Client:
`resourceSyncHydration.test.ts` for `applyHydration` and the `reason` handling.

## Residual risk

The lock lives in memory; two server processes on one `save/` are already unsupported. Until
`prompt-assembly` wires the client, the routes are reachable but unused (the runner is a stub that
answers `error`).

## Implementation record

Implemented 2026-10-01 on `76a14160`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 5) and the Astra plan review's points
(14; 13 adopted, one rejected, below). No stopping condition triggered: every destructive store
path goes through `applyChanges`, `delete`, or `replaceAll`, and `replaceAll` runs only after
maintenance has ended every job.

- **`shared/jobs.ts`**: the kinds (`previewPrompt` added for slice 9), `GenerationContext`
  (with `triggerId` for command jobs), the create body, the 409 bodies, `GenerationStatus`, and the
  events, each with the job's `epoch`. `accepted` has optional `messageId`/`generationId` (a command
  job holds no lock and emits `accepted`/`done` without a message: owner answer 6) and
  `userMessageId`; `chunk` carries its `generationId`; `done` carries `result` for the previews;
  `resource` events are updates only. `HIDDEN_HYDRATION_KINDS` (`llmSecrets`, `authRefreshes`).
- **`shared/chats.ts`, `shared/resources.ts`**: `reason?: "generating"` on `ChatConflict` and
  `ResourceConflict` (present only on a lock refusal, so no existing 409 body changed and no test
  was adapted); `parseRevisionToken` and `compareRevision`.
- **`server/src/jobs/generationLock.ts`**: the in-memory owner map and the live tokens; the store
  reads it as its `MessageGuard`.
- **`server/src/data/chatStore.ts`, `resourceStore.ts`**: the lock preflight runs inside the
  transaction before the revision checks (a chat group's rewrites and removals of an owned
  message, a whole-chat `replace`/`delete` of a chat holding one, a character delete in a batch or
  on the single route), so a stale change of a locked message also answers `generating`; the single
  delete records its conflict through `conflict()`. `applyChanges(batch, { epoch, jobToken })`
  asserts the epoch and the token's liveness (`JobTokenError`) in the same synchronous call.
  `chatRevision(characterId, id)` reads a chat's token without its messages.
- **`server/src/jobs/generationJobs.ts`**: the registry, `writeAsJob`, the lifecycle, and the
  socket, as `self-host-server.md` describes. The runner is injected (`createServerContext({
generationRunner })`); the default fails with 501.
- **`server/src/routes/generations.ts`**: the three routes with the JWT check and the limiter.
- **`server/src/routes/proxyStreamJobs.ts`**: `attachWebSocket` became `handleUpgrade` (false for
  a path it does not own, the socket untouched); `app.ts`'s `attachWebSocket` installs the one
  dispatcher. `proxyStreamJobs.test.ts` and `proxyJobWs.test.ts` are untouched and green.
- **`server/src/app.ts`**: the lock before the store, the jobs after the snapshots, the routes, the
  dispatcher; `beginShutdown` aborts every job at time zero; `dispose` waits for the jobs, then the
  workers, then `snapshots.stop()`, then closes. `main.ts` is unchanged.
- **Client**: `resourceClient.ts` carries `reason`; `chatStore.svelte.ts` gains the server-job
  locks (`applyServerGeneration`, `endServerJob`), `hydrateChat`, and the 5 s retry block for work
  refused with `generating`; `resourceSync.svelte.ts` gains the `generating` refusal path and
  `applyHydration`; `src/ts/network/generationJobs.ts` is the transport and
  `applyGenerationEvent`/`resumeSavedGenerations`. Nothing calls the transport yet.

Files outside the slice's allowed list, each needed by an amendment: `server/src/routes/auth.ts`
(`isAuthorizedToken`: the socket's JWT-only check; `verifyJwt` is private),
`server/src/data/snapshots.ts` (`onMaintenance`: maintenance aborts and drains the jobs before it
closes writes), `src/ts/storage/resourceClient.ts` (`reason` on `ResourceConflictError`), and
`docs/structure/global-api.md` (the transport's owner guide). `src/lang/en.ts` is unchanged
(`chatGenerating` exists).

Deviations from the reviewed plan, from Astra's plan review:

- Maintenance runs the jobs' listener before the write gate closes, so an abort checkpoint lands
  in the old database and the safety snapshot (the plan let it fail). Client writes stay open for
  that window (at most the 5 s abort deadline).
- Every abort fixes one 5 s deadline after which the job is ended for it; a runner's `done` or
  `error` ends the job at once; an ended job's capabilities throw.
- A message's lock is released only by a final write whose checkpoint is `applied`; the F-b retry
  applies only to conflicts that name resource records alone.
- The registry sends the job chat's hydration before every `accepted` and with the terminal event,
  and on every attach re-sends the chat and every record the job sent (read fresh), the last
  `preset`, the current `accepted`, and the terminal event. Client locks are keyed by job.
- `applyServerGeneration(ref, { jobId, messageId, generationId, text, seq? })` never moves the
  chat's revision (only `hydrateChat` does, at a revision at least the held one); chunks are
  ordered by `seq` per generation; `hydrateChat` writes the mirror directly (no `ensureChat`, no
  discard, no settle) and puts the streamed text back.
- `applyHydration` also refuses a record whose mirror projection differs from the saved text, one
  in the batch in flight, and one blocked by a refusal.
- Saved jobs are kept per chat; `GenerationStatus` is a safe DTO; `RunningJob.onClientMessage` is
  the seam slice 6 uses.

Rejected (Astra point 10, deletion and membership hydration): `resource` events are updates of
records the client holds. A record the client lacks, or a deletion, is not hydrated; the client
sees a job's membership change on its next reload or conflict reload (recorded in
`persistence.md`'s hazards). The first slice whose job creates or deletes a character or chat owns
a deletion and membership contract.

Recorded behavior changes:

- a client edit of a message a server job owns, or a delete of its chat or character, is a 409
  `reason: "generating"`; the client keeps the work and retries it after 5 s, showing
  `chatGenerating` once per refusal episode;
- a server restart clears the lock (the Phase 2 fence closes on the next ordinary write);
- a reconnecting owner gets the current state, not a replay of chunks or `progress`;
- during a restore or import, ordinary writes stay open while the jobs end (up to 5 s).

Evidence: `pnpm check`, `pnpm format:check`, `pnpm test` (110 files, 1,361 passed, 3 skipped),
`pnpm build`, and `pnpm test:e2e` (5 passed) pass. A scratch smoke against a listening server with
a fake runner (31 checks after the challenge, all passing; the two added checks are the one-stream
rule and the `streaming` list): 409 `stale`, 412, 404, `chatBusy` with the job id, another
client's socket and the password refused on the generation socket, the lock refusals (an edit, a
stale chat delete, a forged generation id, the single and the batch character delete, all
`generating`), `meta` and another message's edit applying, the status DTO, a reconnect receiving
the chat hydration then `accepted` with the current text, DELETE ending with `error` 499 and the
text so far persisted, every event carrying the epoch, an attach after the end receiving `done`, a
runner ignoring its abort ended at 5 s, maintenance ending a job with its checkpoint persisted and
refusing admission meanwhile, and `dispose` ending a running job promptly.

## Astra challenge (2026-10-01) and decisions

Five rounds in the segment's session (reports under `/tmp/astra-p5s5/`); every blocking point was
adopted, reproduced by Astra's probes, and rechecked until the final round found none.

1. Round 1 (7 blocking): a `[final(g1), begin(g2)]` write released g2's lock (the lock now
   restores replaced owners on failure and releases only the owning generation); terminal
   hydration left raw streamed text and an ended job's reconnect replayed old text (the job chat
   event carries `streaming`, the current reply is retired at its final write, and an attach sends
   it only while its generation owns the message); hydration's own dirty marks dropped the next
   update (a projection equal to the saved text is no change; refused records are deferred and
   retried after each cycle); a terminal that failed to serialize stranded `snapshots.stop()`
   (serialization first, cleanup in `finally`, per-socket isolation); a runner's `done` after an
   abort reported success (the first abort decides the outcome; the deadline is set before the
   signal fires); a reorder behind a blocked delete polled every 500 ms (`orderMembershipReady`).
   Non-blocking adopted: saved-job keys as JSON pairs, the 412 through the resource client's halt,
   an undone delete clearing its block, `GenerationFollow.send`. Kept as recorded simplifications:
   the alert episode ends when no block remains; membership hydration (point 10 of the plan review).
2. Round 2 (4): one job's hydration released another's locks (hydration carries its job; an older
   copy changes nothing); an open lock is no text watermark (`streaming` entries carry the newest
   chunk `seq` the stored text holds); finalized-reply reconnect and live chunks of another
   generation (the registry drops them; the client retires replaced generations); a blocked
   delete's dirty key kept the loop runnable.
3. Round 3 (3): metadata from a busy copy was not ordered (`jobMetadataRevisions`; a busy copy
   sets no watermark); the watermark was inferred from chunks sent (the runner declares `covers`
   with the write); overlapping sockets (one delivery stream per job; the client keeps the newest
   follow).
4. Round 4 (2): a later write kept an earlier higher claim (each applied write publishes its own
   claim, 0 without `covers`); a superseded follow could connect late and evict the newest (a
   cancellable follow, and an `attach` stamp the server orders handshakes by).
5. Round 5 (2): a lower claim restored an old processed text instead of the newest chunk (the
   stream buffer keeps the received chunk); a follow cancelled before authentication never settled
   `closed` (created up front). Verdict: no remaining blocker within slice 5.

Slice 6 owns cancelling callback and worker work at the end of a job, and failing its barrier
when a required hydration could not apply (`applyHydration` returns false). Membership
hydration has no owning slice because none needs it: the processing code that moves to the server
(`triggers.ts`, `scriptings.ts`, `command.ts`, `index.svelte.ts`) never creates or deletes a
character or chat (checked 2026-10-01: no `createChat`, `deleteChat`, `addCharacter`, or
`removeCharacter` call). A slice that adds such a runner path brings the deletion and membership
contract first.

For slice 6: the channel uses `RunningJob.onClientMessage` and `emit`; the callback barrier's
"hydrate before each callback" is `emitRecords` plus the chat event. For slice 9: the runner reads
the chat revision itself for its `begin` (a `begin` on an existing message needs the current
revision), emits `accepted` after appending, passes `covers` with each checkpoint whose text it
captured with a chunk, checks `signal.aborted` before adding its abort listener (a DELETE can
arrive before the runner starts: the registry starts it on a microtask), and calls
`resumeSavedGenerations` after boot.

## Checks

`pnpm check`, `pnpm format:check`, `pnpm test` (115 files, 1,408 passed, 3 skipped), `pnpm build`,
and `pnpm test:e2e` (5 passed) pass on the final tree; the scratch smoke passes 31/31.

## Tests

Written by the Fable reviewer (verdict: no problem; 47 tests):

- `server/src/tests/generationLock.test.ts`: every refused chat op, `generating` before stale and
  missing-target conflicts, the allowed ops, the owner token (live, dead, wrong epoch), mixed-batch
  rollback, single and batch character deletes (a caught conflict inside `transaction` still rolls
  back), `chatRevision`, and the lock's handoff, restore, and release.
- `server/src/tests/generationJobs.test.ts`: admission order, the `[final(g1), begin(g2)]` handoff,
  ignored and duplicate finals, acquisition rollback, the one resource-only F-b retry, dead
  capabilities, terminal selection (including an unserializable result with `snapshots.stop`
  resolving), the abort deadline with fake timers, maintenance (the abort checkpoint in the safety
  snapshot, admission reopening), and shutdown, drain, and dispose.
- `server/src/tests/generations.test.ts` (a listening server): validation and JWT-only auth, the
  owner event sequence and status, one stream per job with attach stamps, refusals,
  `onClientMessage`, the coverage round trip, attach re-sends, DELETE, a command job, and the one
  upgrade dispatcher beside a proxy socket.
- `src/ts/network/generationJobs.test.ts`: the client id, the saved-job keys, the create, status,
  and abort errors (the 412 listener), the follow lifetime (cancellation before auth, supersession
  while connecting or open, delayed resolution and rejection, ignored queued events, disabled
  sends), the dispatcher, and `resumeSavedGenerations`.
- `src/ts/storage/tests/resourceSyncHydration.test.ts` (the real store, lock, and Svelte watchers):
  hydration with no echo through save, flush, and pagehide; consecutive hydrations; local edits
  and in-flight deferral; chat hydration; the stream contract (order, coverage, lower claims,
  terminal release, retired generations, busy revision 12 then 11); and the refusal accounting with
  fake timers.
- Helpers: `server/src/tests/testSupport.ts` (`generationRunner`) and
  `src/ts/storage/tests/storeBackedServer.ts` (the lock).

Fable judged every item of Astra's testing advice necessary and covered it, except: a reversed
server-auth order (not constructible with the real `verifyJwt`; the stamp rule is tested directly),
a throwing real `ws` socket (the same `finally` path is covered by the unserializable result), the
job GC (low value), and the browser check with a slow fake runner, which belongs to slice 9 (no
client path calls the transport yet). Observed and not a defect: a client
`setMessageText(..., { generationId })` with a job's generation id is a silent no-op client-side
(pre-existing `isOwner`); the server refuses it.
