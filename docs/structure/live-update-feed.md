# Live-Update Feed: Socket, Hello, Frame Admission, Chat Entries, Publication Budget

## Scope

- Owns the server's change feed and the live-update socket: the `hello` a socket starts with, how frames are admitted
  per socket, what a chat write publishes (the writer's own change, and the feed's chat entries with their summary and
  by-id patch or delta), how a publishing scope coalesces entries, and the publication budget one frame spends.
- Paths: `server/src/data/changeFeed.ts`, `server/src/routes/events.ts`, the frames in `shared/events.ts`, and the feed
  parts of `server/src/data/resourceStore.ts` and `server/src/data/chatStore.ts` (`coalescedChat`, `budgetedEntries`,
  `applyGroup`'s entries, `chatFeedChange`, `ChatWriteChange`).
- Not here:
  - The socket's client and the save loop it feeds → [live updates](live-updates.md#feed-connection).
  - The store's commits, chat summaries, and the epoch → [server resources](server-resources.md).
  - Generation jobs, the job socket, and the job channel → [server generation](server-generation.md).
  - The memory task registry whose statuses the `memoryTask` frames carry → [memory](memory.md#background-memory-task).

## Files

- `server/src/data/changeFeed.ts`: the feed (`createChangeFeed`, `ChangeFeedEvent`): publish order and listener
  failures.
- `server/src/routes/events.ts`: the live-update socket (`createEventSockets`): its `hello`, the fan-out, and
  [frame admission](#frame-admission) (`send`, `MAX_BUFFERED_BYTES`). WS upgrade `/api/events/ws` (`EVENT_FEED_PATH`),
  dispatched by `attachWebSocket` in `server/src/app.ts` outside the HTTP app, so no HTTP limiter; JWT in the
  `risu-auth` query or header, never the password.
- `shared/events.ts`: the frames (`EventFeedFrame`: `hello`, `change`, `memoryTask`, `handoff`, `epoch`, `ping`),
  `ChatStreaming`, `ChatStreamingSnapshot`, `MemoryTaskEntry`.
- `shared/resources.ts`: what a `change` frame carries (`ChangeSet`, `ChatDeltaBody`, `ChatMetaFields`) and its caps
  (`MAX_FEED_PATCH_BYTES`, `MAX_FEED_PUBLICATION_PATCH_BYTES`).
- `server/src/data/chatStore.ts`, feed parts: a by-id group's entry, built in `applyGroup` (`ChatFeedPayloads`,
  `chatFeedChange`, `chatMetaFields`), and the writer's own change (`ChatWriteChange`).
- `server/src/data/resourceStore.ts`, feed parts: the publishing scope (`publishing`, `recordChat`, `mergeChanges`,
  `coalescedChat`, `budgetedEntries`), `applyChanges`' `changes` and `committed` options (`WrittenChanges`), and
  `publishStreaming`.

## Flows

### Live-update hello

The `hello` (`createEventSockets`) samples the epoch, the generation locks (`streaming`), the memory task statuses
(`memoryTasks`), the open handoff offers (`handoffs`), and the optional `digest`
(`revisionDigest(resources.listRevisions())`, wired in `server/src/app.ts`) in one synchronous step before the socket is
registered; a failed digest omits only that field, any other failed snapshot closes the socket. Nothing is replayed: a
client whose seeded advertised map has the loaded epoch and the matching digest reconciles from that map, otherwise it
reads `/api/resources/revisions` ([feed connection](live-updates.md#feed-connection)).

### Frame admission

Every frame but the `hello` is admitted per socket by its own UTF-8 size, measured once for every socket (`send`,
`MAX_BUFFERED_BYTES`, 4 MiB): a socket the frame would push past the bound is terminated before the frame is queued, the
other sockets still get it, and its client reconnects and [reconciles](#live-update-hello). The `hello` is checked on
the queued bytes alone. What a `change` frame's patches may add is bounded by the
[publication budget](#publication-budget).

### Own chat changes

- A server writer that passes `changes: true` with its `committed` hook to `applyChanges` gets
  `committed(applied, written)`: `written.chats` holds each by-id chat group's change as stored (`ChatWriteChange`),
  aligned with `applied.chats`, uncapped, `undefined` for a group without a by-id change. The contract is on
  `applyChanges`, `WrittenChanges`, and `ChatWriteChange`.
- The writer is a generation job (`server/src/jobs/generationJobs.ts`); `refreshChatAfterWrite` in
  `server/src/jobs/jobScope.ts` lays the change onto the job's chat ([server generation](server-generation.md)).
- The feed's capped patch or delta is taken from the same change; the [publication budget](#publication-budget) and the
  HTTP batch body leave `written` as it is.

### Feed chat entries

`ChangeSet.chats[]` (`shared/resources.ts`) is built per by-id group in `applyGroup` and kept in a feed-only map by
group result, never in `ChatGroupResult`, the HTTP body, or `ChatWriteChange`. An entry carries the group's summary
knowledge (`summary` or `summaryBase`, decided as `ChatFeedPayloads` says) and its by-id change when that fits: a
`patch` with the whole `meta`, or past `MAX_FEED_PATCH_BYTES` a `delta` with `metaFields` (`chatFeedChange`,
`chatMetaFields`), never both. The job socket's `chatPatch` keeps the whole `meta`.

### Coalescing and publish order

- A chat recorded again in one publishing scope, or merged from a nested scope, keeps one entry: the later ref without a
  patch or delta, and only the summary knowledge both entries prove (`recordChat`, `mergeChanges`, `coalescedChat`).
- Change feed events reach listeners, the socket fan-out among them, in publish order, including events a listener
  publishes while handling another; a listener that throws is logged and the feed goes on. Committed nested writes still
  publish their refs when an enclosing write fails during input evaluation (`publishing`).

### Publication budget

- One committed outermost publishing scope that recorded anything is one `change` frame (`feed.publish` once; a commit
  that records nothing, such as a cold checkpoint write, publishes none), and the optional payloads of that frame
  (record `patch`es, chat `patch`es and `delta`s, each within `MAX_FEED_PATCH_BYTES`, 64 KiB, and chat `summary` and
  `summaryBase` fields) total at most `MAX_FEED_PUBLICATION_PATCH_BYTES` (256 KiB of UTF-8 JSON).
- The store applies it once, when the outermost publishing scope publishes (`budgetedEntries` holds the walk order and
  the drop rule): a nested scope neither spends nor resets it, and a feed listener's own write is a later publication
  with a budget of its own. A dropped payload leaves its entry in place without it; a dropped `summary` leaves the
  entry's summary unknown.
- Refs, chat-order entries, and `streaming` lock lists are never dropped, reordered, or split, so a chat's locks stay in
  the frame of its chat ref and a lock release with no refs (`publishStreaming`) is still published.

## State

- The change feed and the live-update sockets are process-local and buffer no events; clients reconcile on reconnect
  ([Live-update hello](#live-update-hello)).

## Coupling

- [Server resources](server-resources.md): the store publishes each commit to the feed
  ([Publication budget](#publication-budget)), and [chat summaries](server-resources.md#chat-summaries) are what an
  entry carries.
- [Server generation](server-generation.md): the job socket's `chatPatch` keeps the whole `meta` where an entry switches
  to a delta, a lock release with no refs (`publishStreaming`) is a frame of its own, and the memory task registry
  supplies the `memoryTask` frames.
- The client, [live updates](live-updates.md#feed-connection), reconciles on reconnect and applies the entry forms.

## Invariants

- The feed publishes only what the resource store committed ([Invariants](server-resources.md#invariants)).
- A frame is never split: refs, chat-order entries, and lock lists travel whole, and a frame a socket cannot take closes
  that socket ([Frame admission](#frame-admission)).

## Recipes

- A new frame kind: add it to `shared/events.ts`, send it through `routes/events.ts` `send` so
  [frame admission](#frame-admission) measures it, and teach the client (`src/ts/network/eventFeed.ts`,
  [live updates](live-updates.md#feed-connection)) to apply it. A new optional payload of a `change` entry goes through
  `budgetedEntries`, so the [publication budget](#publication-budget) counts it.

## Tests

The in-process harness and the slow table are in the [shell's Tests](self-host-server.md#tests).

- `chatMetadataCoalescingEvents.test.ts` identifies the job fixture's SQLite connection by its epoch and counts
  transactions on it, so background writes in other stores cannot alter the coalescing assertion.
- Feed: `pnpm --silent test:agent server/src/tests/{changeFeed,events,chatMetadataCoalescingEvents}.test.ts`.
- Not tested: none recorded here; the client's reconnect and replay are [live-updates](live-updates.md)'s.

## Known Hazards

### Limitations

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
- Summary comparison uses stored projection text without parsing metadata, unless that projection is missing or stale
  (`freshSummaryText` rebuilds it from parsed metadata). A metadata change past `MAX_FEED_PATCH_BYTES` parses metadata
  before and after for the field diff. Decision: Server Byte Budgets D4 and Per-Event Server Work D7, archive.
