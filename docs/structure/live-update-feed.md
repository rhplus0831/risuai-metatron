# Live-Update Feed: Socket, Hello, Frame Admission, Chat Entries, Publication Budget

## Scope

- Owns the server's change feed and the live-update socket: the `hello`, per-socket frame admission, what a chat write
  publishes (the writer's own change; the feed's chat entries with summary and by-id body), coalescing per publishing
  scope, and one frame's publication budget.
- Not here: the socket's client and the save loop it feeds ([live updates](live-updates.md#feed-connection)); the
  store's commits, chat summaries, and the epoch ([server resources](server-resources.md)); jobs, the job socket and
  channel ([server generation](server-generation.md)); the memory tasks of `memoryTask` frames
  ([memory](memory.md#background-memory-task)).

## Files

- `server/src/data/changeFeed.ts`: the feed (`createChangeFeed`, `ChangeFeedEvent`): publish order and listener
  failures.
- `server/src/routes/events.ts`: the live-update socket (`createEventSockets`): its `hello`, the fan-out, and
  [frame admission](#frame-admission). WS upgrade `/api/events/ws` (`EVENT_FEED_PATH`), dispatched by `attachWebSocket`
  in `server/src/app.ts` outside the HTTP app, so no HTTP limiter; JWT in the `risu-auth` query or header, never the
  password; `proto` logged, never enforced.
- `shared/events.ts`: the frames (`EventFeedFrame`: `hello`, `change`, `memoryTask`, `handoff`, `generation`, `clients`,
  `remoteCommand`, `remoteCommandState`, `epoch`, `ping`), the one client message (`EventFeedClientMessage`),
  `ChatStreaming`, `ChatStreamingSnapshot`, `MemoryTaskEntry`, `GenerationProgressEntry`.
- `shared/resources.ts`: what a `change` frame carries (`ChangeSet`, `ChatDeltaBody`, `ChatRowDeltaBody`) and its sizes
  (`MAX_FEED_PATCH_BYTES`, `SMALL_FEED_PATCH_BYTES`, `MAX_FEED_PUBLICATION_PATCH_BYTES`).
- `server/src/data/chatStore.ts`, feed parts: a by-id group's [entry](#feed-chat-entries) and the writer's own change
  (`ChatWriteChange`).
- `server/src/data/resourceStore.ts`, feed parts: the publishing scope ([coalescing](#coalescing-and-publish-order),
  [budget](#publication-budget)), `applyChanges`' `changes` and `committed` options (`WrittenChanges`), and
  `publishStreaming`.

## Flows

### Live-update hello

`server/src/app.ts` wires the snapshots read by `createEventSockets`. Before registering a socket, hello synchronously
samples the epoch, streaming locks, memory tasks, handoffs, running generation progress and registered clients. It also
samples `revisionDigest` and `resources.cursor()`. A failure of either optional sample omits that field. Other snapshot
failures close the socket. The [tab reconciles](live-updates.md#feed-connection) from its advertised revision map, a
bounded replay, or a whole listing.

- `hello.rerollInPlace` advertises [in-place rerolls](server-generation.md#reroll-in-place) to `serverRerollsInPlace`
  for the [screen's reroll decision](chat-pipeline.md#reroll).
- `change.cursor` accompanies committed refs, including nested commits. A lock-only frame has no cursor, and older
  servers may omit it.

### Frame admission

Every frame but the `hello` is admitted per socket by its own UTF-8 size (`send`, `MAX_BUFFERED_BYTES`, 4 MiB; the rules
are on both): a socket that cannot take it is terminated, and its client [reconciles](#live-update-hello). What a
`change` frame's patches may add is bounded by the [publication budget](#publication-budget).

### Presence

On `register`, the socket publishes the presence list. `createEventSockets` owns registration validation and caps.
`isHost`, `clientName` and `sendToClient` use the newest registration for an id, even outside the published list.

After updating presence, `onRegister` reissues pending
[remote-command notices](self-host-server.md#remote-command-routes) to a registered host. `remoteCommand` addresses the
target and `remoteCommandState` the sender. These frames carry no body or result. Delivery depends on a compatible host
HTTP read. A successful `sendToClient` lookup alone cannot confirm delivery. For tab registration and reconnect, see
[live updates](live-updates.md#feed-connection).

### Own chat changes

- A server writer that passes `changes: true` with its `committed` hook to `applyChanges` gets
  `committed(applied, written)`: `written.chats` holds each by-id chat group's change as stored (`ChatWriteChange`),
  aligned with `applied.chats`, uncapped, `undefined` for a group without a by-id change.
- The writer is a generation job; `refreshChatAfterWrite` (`jobs/jobScope.ts`) lays the change onto the job's chat
  ([server generation](server-generation.md)).
- The feed's capped body is taken from the same change; the [publication budget](#publication-budget) and the HTTP batch
  body leave `written` unchanged.

### Feed chat entries

For a by-id group, `applyGroup` keeps the summary and optional body in a feed-only map, separate from the HTTP
`ChatGroupResult` and the writer's `ChatWriteChange`. `chatFeedChange` in `server/src/data/chatStore.ts` selects at most
one fitting body. The wire contract in `shared/resources.ts` (`ChangeSet`, `ChatRowsManifest`) gives the preference
order for a whole-row patch, field/text diffs and a changed-row manifest.

The receiver applies diffs only against the expected base. `chatRowDiff` includes the original text's length and
`textHash` for a text change. A manifest asks the client to read named rows and changed metadata fields at the given
revision. Follow [client patch handling](live-updates.md#chat-live-updates) when changing the contract.

### Coalescing and publish order

- A chat recorded again in one publishing scope, or merged from a nested scope, keeps one entry: the later ref without a
  body, and only the summary knowledge both entries prove (`recordChat`, `mergeChanges`, `coalescedChat`).
- Listeners, the socket fan-out among them, get change feed events in publish order, also those a listener publishes
  while handling another; one that throws is logged and the feed goes on. Committed nested writes still publish their
  refs when an enclosing write fails during input evaluation (`publishing`).

### Publication budget

- One committed outermost publishing scope that recorded anything is one `change` frame (`feed.publish` once; a commit
  recording nothing, such as a cold checkpoint write, publishes none), and the optional payloads of that frame (record
  patches, chat bodies, each within `MAX_FEED_PATCH_BYTES`, 64 KiB, and chat `summary` and `summaryBase` fields) total
  at most `MAX_FEED_PUBLICATION_PATCH_BYTES` (256 KiB of UTF-8 JSON).
- The store applies it once, when the outermost publishing scope publishes (`budgetedEntries` holds the walk order and
  the drop rule): a nested scope neither spends nor resets it, and a feed listener's own write is a later publication
  with its own budget. A dropped payload leaves its entry in place without it; a dropped `summary` leaves the entry's
  summary unknown.
- Refs, chat-order entries, and `streaming` lock lists are never dropped, reordered, or split, so a chat's locks stay in
  the frame of its chat ref and a lock release with no refs (`publishStreaming`) is still published.

## State

- The change feed and the live-update sockets are process-local and buffer no events; clients reconcile on reconnect
  ([Live-update hello](#live-update-hello)).

## Coupling

- [Server resources](server-resources.md): the store publishes each commit to the feed, and
  [chat summaries](server-resources.md#chat-summaries) are what an entry carries.
- [Server generation](server-generation.md): the job socket's `chatPatch` keeps the whole `meta`, a lock release with no
  refs (`publishStreaming`) is a frame of its own, and the memory task registry supplies the `memoryTask` frames.
- The client, [live updates](live-updates.md#feed-connection), reconciles on reconnect and applies the entry forms.

## Invariants

- Resource, chat, and order refs in `change` frames describe only committed store writes
  ([Invariants](server-resources.md#invariants)); `publishStreaming` can publish locks without a write, and
  `memoryTask`, `handoff`, and `generation` frames describe process-local transitions (`shared/events.ts`). A
  `generation` frame and `hello.generations` carry ids, times, the kind, optional stage, retry count and approximate
  output-token counts. Follow `GenerationProgressEntry` in `shared/events.ts` to keep these frames content-free.
- A frame is never split ([Publication budget](#publication-budget)); a frame a socket cannot take closes that socket
  ([Frame admission](#frame-admission)).
- Addressed remote-command notices use `sendToClient`, never `feed.publish`; reconnect registration repeats open
  commands from the process-local registry, not from a feed buffer.

## Recipes

- A new frame kind: add it to `shared/events.ts`, send it through `routes/events.ts` `send` so
  [frame admission](#frame-admission) measures it, and teach the client (`src/ts/network/eventFeed.ts`,
  [live updates](live-updates.md#feed-connection)) to apply it. A new optional payload of a `change` entry goes through
  `budgetedEntries`, so the [publication budget](#publication-budget) counts it.

## Tests

[Shell tests](self-host-server.md#tests) describe the in-process fixture.

- `chatMetadataCoalescingEvents.test.ts` identifies the job fixture's SQLite connection by its epoch and counts
  transactions on it, so background writes in other stores cannot alter the coalescing assertion.
- Feed:
  `pnpm --silent test:agent server/src/tests/{changeFeed,chatFeedPatches,events,chatMetadataCoalescingEvents}.test.ts`.
- For client reconnect and replay tests, see [live updates](live-updates.md#tests).

## Known Hazards

### Limitations

- The publication budget covers optional payloads only. Refs and lock lists are unbounded (512-character ids, a
  character deletion's every chat ref, no in-process op cap); refs alone past the socket budget close the socket, and
  its client [reconciles](#live-update-hello), taking chat locks from the same frame's chat ref and a ref-less lock
  release as `null`. Decision: Per-Event Server Work D5, archive.
- Measuring every candidate payload serializes it once, including rejected payloads, before the final frame
  serialization. Decision: Per-Event Server Work D5, archive.
- Feed payload construction runs on the serving thread: a rename reads/parses the last row via `messages_position` for
  `lastMessageAt`; a message-op group does this before and after, inside its transaction. A group past 8 KiB reads every
  touched row until all body forms pass the cap. Decision: Per-Event Server Work D6, archive; ST04 in the
  [server migration audit](../reports/audits/codebase/server-migration-2026-10-26.md).
- Summary comparison uses stored projection text without parsing metadata, unless that projection is missing or stale
  (`freshSummaryText` rebuilds it from parsed metadata). A metadata change past `MAX_FEED_PATCH_BYTES` parses metadata
  before and after for the field diff. Decision: Server Byte Budgets D4 and Per-Event Server Work D7, archive.
- A socket's `proto` is kept per socket (`protocols` in `server/src/routes/events.ts`) and logged as one `console.info`
  line, not recorded in Diagnostics ([diagnostics](diagnostics.md#limitations)). Decision: Found Issues Clearance Q8
  (owner, 2026-11-09).
