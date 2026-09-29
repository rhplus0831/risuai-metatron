# Slice: Generation Jobs

Status: planned (drafted 2026-09-30, refined after review, not started).

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
