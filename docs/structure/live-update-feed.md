# Live-Update Feed: Socket, Hello, Frame Admission, Chat Entries, Publication Budget

## Scope

- Owns the server's change feed and the live-update socket: the `hello` a socket starts with, how frames are admitted
  per socket, what a chat write publishes (the writer's own change, and the feed's chat entries with their summary and
  by-id patch or delta), how a publishing scope coalesces entries, and the publication budget one frame spends.
- Paths: `server/src/data/changeFeed.ts`, `server/src/routes/events.ts`, the frames in `shared/events.ts`, and the feed
  parts of `server/src/data/{resourceStore,chatStore}.ts` (`coalescedChat`, `budgetedEntries`, `applyGroup`'s entries,
  `chatFeedChange`, `ChatWriteChange`).
- Not here:
  - The socket's client and the save loop it feeds → [resource-sync](resource-sync.md#feed-connection).
  - The store's commits, chat summaries, and the epoch → [server resources](server-resources.md).
  - Generation jobs, the job socket, and the job channel → [server generation](server-generation.md).
  - The memory task registry whose statuses the `memoryTask` frames carry → [memory](memory.md#background-memory-task).

## Files

- `data/changeFeed.ts`: the feed; `routes/events.ts`: the socket, its `hello`, and frame admission; `shared/events.ts`:
  the frames.
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
- The client, [resource-sync](resource-sync.md#feed-connection), reconciles on reconnect and applies the entry forms.

## Invariants

- The feed publishes only what the resource store committed ([Invariants](server-resources.md#invariants)).
- A frame is never split: refs, chat-order entries, and lock lists travel whole, and a frame a socket cannot take closes
  that socket ([Frame admission](#frame-admission)).

## Recipes

- A new frame kind: add it to `shared/events.ts`, send it through `routes/events.ts` `send` so
  [frame admission](#frame-admission) measures it, and teach the client (`src/ts/network/eventFeed.ts`,
  [resource-sync](resource-sync.md#feed-connection)) to apply it. A new optional payload of a `change` entry goes
  through `budgetedEntries`, so the [publication budget](#publication-budget) counts it.

## Tests

The in-process harness and the slow table are in the [shell's Tests](self-host-server.md#tests).

- `chatMetadataCoalescingEvents.test.ts` identifies the job fixture's SQLite connection by its epoch and counts
  transactions on it, so background writes in other stores cannot alter the coalescing assertion.
- Feed: `pnpm --silent test:agent server/src/tests/{changeFeed,events,chatMetadataCoalescingEvents}.test.ts`.
- Not tested: none recorded here; the client's reconnect and replay are [resource-sync](resource-sync.md)'s.

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
- Summary comparison uses stored projection text without parsing metadata. A metadata change past `MAX_FEED_PATCH_BYTES`
  parses metadata before and after for the field diff. Decision: Server Byte Budgets D4 and Per-Event Server Work D7,
  archive.
