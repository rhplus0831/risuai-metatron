# Structured Memory HypaV3 Projection: The View, the Seal, the Mirror, Plugin Reads, the Reset

## Scope

- Owns the HypaV3 compatibility projection of a chat's `structuredMemory` records: the `hypaV3Data` view a reader
  expects, the seal a tab's read carries, how the tab's mirror holds the value for plugins, the routes a plugin read
  refreshes it through, the upstream export's unsealed copy, and the reset that hands an adopted chat's field back to
  the records.
- Paths: the projection and seal rules of `shared/structuredMemory.ts`, `projectChatMemory` in
  `server/src/data/memoryStore.ts`, `sealedMemoryProjection` and the projection reads of
  `server/src/data/resourceStore.ts`, the `revisions`, `projection`, and `reset-summaries` routes of
  `server/src/routes/structuredMemory.ts`, `keepsHeldHypaV3Data` and `installChatProjection` in
  `src/ts/storage/chatStore.svelte.ts`, `refreshChatProjections` in `src/ts/plugins/apiV3/v3.svelte.ts`, and
  `projectUpstreamMemory` in `server/src/data/upstream/exportDatabase.ts`.
- Not here:
  - The records, their tables and store, and the other routes → [records](records.md).
  - What the field holds under HypaV3, and its write rules → [memory](../memory.md), `shared/memory.ts`.
  - Adopting a chat's HypaV3 summaries, and the adoption choice → [lifecycle](lifecycle.md#adopting-hypav3-summaries).
  - The other structured memory guides → [the area README](README.md).

## Files

- `shared/structuredMemory.ts`: `projectHypaV3Data`, the `SerializableHypaV3Data` view of a chat's events;
  `sealHypaV3Data`, `isSealedHypaV3Data`, `sealedHypaV3DataIntact`, `sealedHypaV3DataRevision`, the mark a read's
  projection carries; `hypaV3DataHoldsSummaries`, what owns the field; `MEMORY_REVISION_CHATS_MAX`,
  `StructuredMemoryRevisionsAnswer`, `StructuredMemoryProjectionAnswer`.
- `server/src/data/memoryStore.ts`: `projectChatMemory`, a chat's unsealed projection, shared by the read and the
  export; `readProjectionRevisions`.
- `server/src/data/resourceStore.ts`: `sealedMemoryProjection`, the projection's one rule, for `overlayMemoryProjection`
  (the `/api/resources` read), `readProjection`, and `readProjectionRevisions`.
- `server/src/routes/structuredMemory.ts`: `POST .../revisions`, `GET .../:characterId/:chatId/projection`, and
  `POST .../reset-summaries`; the shared `StructuredMemoryResetAnswer` is listed with
  [the records' routes](records.md#files).
- `src/ts/storage/chatStore.svelte.ts`: `keepsHeldHypaV3Data`, every write's rule for the field; `keepsProjection`;
  `installChatProjection` and `chatProjectionState`, the one change of the field that is no write; `hypaV3Owned`.
- `src/ts/plugins/apiV3/v3.svelte.ts`: `refreshChatProjections`, `rotatingWindow`, `MEMORY_PROJECTIONS_PER_READ`,
  `MEMORY_RECHECK_WINDOW_MS`, `MEMORY_REFRESH_DEADLINE_MS`.
- `src/ts/process/structuredMemory.svelte.ts`: `readStructuredMemoryRevisions`, `readStructuredMemoryProjection`.
- `server/src/data/upstream/exportDatabase.ts`: `projectUpstreamMemory`.
- The notice, `structuredMemory.projectionWriteRefused`, in `src/lang/en.ts` and `src/lang/ko.ts`.

## Flows

### The HypaV3 projection

`projectHypaV3Data(events, manifest)` answers a reader that expects `hypaV3Data`, without storing anything.

- Only `active` events become summaries, in the given order; `retracted` and `stale` ones are left out. `text` is the
  event's `summary`, and `chatMemos` are its source message ids.
- `isImportant` holds for a pinned event or one graded `importantEventGrade` (6) or above.
- `metrics` comes from the last manifest and is absent without one. Indices are positions in the projected `summaries`,
  never in `events`, because every metrics reader indexes `summaries`.
- A metric records why that send selected a record, so only `verified` event items count: `flow` fills
  `lastRecentSummaries`, `events` fills `lastSimilarSummaries`, and an event in both lanes is in both arrays.
  `lastImportantSummaries` and `lastRandomSummaries` stay empty: no lane selects by importance or at random, and a pin
  set after the send must not rewrite that send's reasons. `lastDeferredSummaries` is absent.

`projectChatMemory(events, messages)` is that for a whole chat, reading and export alike: `reconcileMemoryEvents` first,
so a changed source never reads as active ([Reconciliation](lifecycle.md#reconciliation-and-repairs)), then events by
their earliest source's position, because every reader takes `summaries` as chronological and `seq` puts a re-record
last. An event with no placed source goes last. The manifest is the newest message's with an `items` list in
`generationInfo.context`, empty when that send included nothing.

### A tab's read

A tab's read overlays it:

- A structured chat: `memoryAlgorithmType` selects this algorithm, the chat has an event, and its stored `hypaV3Data`
  holds no summaries (`hypaV3DataHoldsSummaries`). A value with summaries means HypaV3 owns the field,
  [an adopted chat](lifecycle.md#adopting-hypav3-summaries) until a reset included, and an empty one, which opening the
  modal stores, owns nothing. The setting is one `json_extract` per read operation, never per chat, so under another
  algorithm a read touches no memory table, and a chat with no events answers as stored.
- Only `/api/resources` asks (`memoryProjection`, its GET and POST reads). `readChatSource` and a plain `readRefs` stay
  stored data: a job's scope, a memory task, the HypaV3 baseline, and `chatBaseline` must equal a stored read, and a
  checkpoint's capture reads the stored `meta`, so none of them meets a projection.
- A budgeted read charges the chats' `memory_events` bytes too. A projection that throws answers the chat as stored and
  warns once.
- The overlaid value is sealed: `structuredMemoryProjection`, `1:` and a non-cryptographic digest of the whole value
  with sorted keys. It tells a tab what the value is, and whether it is as a read gave it. It authorizes nothing.
- The value carries the memory revision it was read at (`structuredMemoryRevision`), inside the digest, so a whole read
  gives a tab its own baseline and the tab keeps no token of its own. Plugins see the field.

### The tab's mirror

The tab's mirror holds it for plugins to read, unchanged, and nothing stores it:

- `sendChat` leaves a sealed value out of every `create`, `replace`, journal snapshot, and refusal retry; `projectChat`
  keeps it, so a `captureChatBaseline` diff stays natural. `prepareOp` drops one too, for what a stale tab or a
  recovered resend carries.
- `keepsHeldHypaV3Data` decides every write of the field, in `applyChatResult`, `createChat`, `installCharacterChats`,
  `replaceChat`, `installRecoveredChat`, and `setChatMeta`, and only the field drops: the rest of the write applies.
- An incoming sealed value is never taken. It is silent when intact, so a copy, a branch, an import, or an older read
  raises nothing, and a changed one raises the notice. An absent value keeps a projection in place.
- An unsealed value is refused with the notice while this algorithm is selected and the chat holds a projection, or
  nothing with summaries. It passes on a new chat, which has no records; on a chat with a real value; and under another
  algorithm, where it replaces a held projection and HypaV3 owns the chat from then on.
- The notice is `console.warn` plus one `alertToast` per chat until a reload
  (`structuredMemory.projectionWriteRefused`). `warnRefused` of the plugin API fits no refusal here: it discards the
  whole write.
- A job's copy and a patch's `meta` are stored data, so they leave a held projection in place (`keepsProjection`) unless
  they bring summaries. A whole read (`applyRemoteChat`, `installRead`) is authoritative: without the field, a held
  projection is gone. `HypaV3Modal` takes a sealed value as no data.

### A plugin's read

A plugin's read brings the held value up to the records (`refreshChatProjections`, `src/ts/plugins/apiV3/v3.svelte.ts`):

- `getChar`, `getCharacter`, `getCharacterFromIndex`, `getChatFromIndex`, and `getDatabase` with `characters` wait for
  it before they copy. Plugin writes and `getDatabase` without `characters` ask nothing. A send with no plugin read
  costs nothing.
- `POST STRUCTURED_MEMORY_PATH/revisions`, `{ chats }`, at most `MEMORY_REVISION_CHATS_MAX` and 256 KiB, answers
  `StructuredMemoryRevisionsAnswer` by position, with no message read: a token for what a whole read would project, or
  null. All of a read's chats go in one request, so a read with nothing new costs that alone.
- A `display` handler reads on every rendered row and streamed render, so a chat's check stands for
  `MEMORY_RECHECK_WINDOW_MS` from its answer, a failed one too. A read inside it takes the held value with no request
  and no wait, and a read that finds a check in flight joins it. A chat left past a cap keeps its moved revision: a
  later read finds it again, since the check compares the held token with the server's.
- `GET STRUCTURED_MEMORY_PATH/:characterId/:chatId/projection` answers `StructuredMemoryProjectionAnswer` for a chat
  whose token moved, sealed by `sealedMemoryProjection` against the stored messages. A null value is an answer: no
  projection, also under another algorithm, where `revision` is null too. Events over a read round are 413 before any
  message is read.
- Both routes are authenticated, rate-limited, and epoch-checked. A read fetches `MEMORY_PROJECTIONS_PER_READ` (8)
  projections at most, one by one, the chat it is about first. What is left stays as it is, and `rotatingWindow` gives
  the rest their turn on later reads, the chats past the revision cap too.
- The tab asks nothing under another algorithm, where a held projection goes at once, nor for a chat with a real value
  or not on the server yet. A chat a token answers null for loses a sealed value. A real value is never removed.
- `MEMORY_REFRESH_DEADLINE_MS` bounds the whole refresh, because a hook's read holds a send. A failed answer, a refusal,
  or the deadline leaves the held value, and the read answers with it.
- `installChatProjection` takes an answer only for a chat as `chatProjectionState` found it before the first await: the
  same chat object and value, the same owner, and a held revision of the same epoch and `seq`. It is the one change of
  the field that is no write. It skips `keepsHeldHypaV3Data`, which refuses every sealed value, and `changed`, which
  would dirty a queued create's journal. The token must be newer than one held at the same `seq`.

### The upstream export

The upstream export (`projectUpstreamMemory`) applies the same rule, the setting from the snapshot's `ui` record, and
writes the value unsealed: a restore upstream and a re-import here both take plain HypaV3 data. `readSnapshotFile` keeps
the event rows, and a failed memory walk leaves `memoryEvents` null. A problem in the tables or in one event never stops
the export; those chats go as stored under `memory-unreadable`, and projected ones count as `memory-projected`.

### The reset

`POST .../reset-summaries`, with no body, answers `StructuredMemoryResetAnswer`. It takes a chat that has not declined,
holds an event of `ADOPTED_WRITER_RUN` or one holding `adoptedSummaries`, its lineage through
[a rebuild](rebuild.md#what-a-rebuild-keeps), and stores real summaries, the rule of the contents' `resettable`, and
writes a `meta` `unset` through `applyChanges`, so the feed publishes it; any other chat answers `reset: false`. The
server owns it because only it can check all that and the fence in one step. The tab writes nothing back: an echoed
`unset` moves the chat's revision and, since `meta` applies on a stale revision, deletes a newer value. It takes
`markChatStale` and `refreshStaleChat`, so a whole read overlays the projection, `hypaV3Owned` falls, and the next
plugin read past `MEMORY_RECHECK_WINDOW_MS` follows the records. Local work delays that read, and the mark survives it.

## State

- A tab holds a projection only in its mirror, sealed, with the memory revision it was read at inside the digest. The
  stored `hypaV3Data` never holds one: the server projects on each `/api/resources` read from
  [the records](records.md#state).
- `hypaV3Owned` is the tab's reading of the field: stored summaries mean HypaV3 owns it; an empty or a sealed value
  means the records do.

## Coupling

- The projection's return type and metric names come from `shared/memory.ts`. `HypaV3Modal.svelte` and
  `remapHypaV3Metrics` read each metric array independently, so an index may sit in two arrays.
- `readSnapshotFile` of [server resources](../server-resources.md#snapshots-and-restore) walks the memory tables for the
  upstream export's projection, and alone among the walk's readers it does not stop on a problem in them
  (`memoryFailed`).
- The field's writes go through [the chat store](../chat-store.md), where `keepsHeldHypaV3Data` lives; the plugin reads
  that wait on the refresh are [plugins](../plugin-sandbox.md)'s.
- The reset writes a `meta` `unset` through `applyChanges`, so the live-update feed publishes it like any chat write.

## Invariants

- The stored `hypaV3Data` never holds a projection: the seal exists only in a tab's read and its mirror.
- `MemoryManifest.items` holds included items only; excluded candidates never reach the projection.
- Only `/api/resources` reads project. `readChatSource`, a plain `readRefs`, a job's scope, a memory task, the HypaV3
  baseline, `chatBaseline`, and a checkpoint's capture read stored data.
- A write never takes a sealed value, and a sealed value authorizes nothing. `installChatProjection` is the one change
  of the held field outside a write, and only for a chat as it found it before its first await.
- Metric indices are positions in the projected `summaries`, never in `events`.

## Recipes

- A new write path of a chat's `hypaV3Data` goes through `keepsHeldHypaV3Data`, so a held projection survives it and a
  sealed value from outside is refused. A new server reader of a chat stays on stored data unless it answers a tab's
  whole read.
- A new field in the projected value is inside the digest already: `sealHypaV3Data` hashes the whole value with sorted
  keys. Check that `projectUpstreamMemory` writes it unsealed and that `HypaV3Modal` still reads the stored shape.

## Tests

- `shared/structuredMemory.test.ts` drives `projectHypaV3Data` and the seal with plain records; it needs no fakes.
- `server/src/tests/structuredMemoryRoutes.test.ts` drives the revision and projection reads and the reset route with
  the feed on a real app; `memoryStore.test.ts` the write path and the budget charge; `upstreamExport.test.ts` the
  export. Each takes `projectionHistory` from `tests/memoryFixtures.ts`.
- The tab: `src/ts/storage/tests/chatStore.test.ts`, `hostApi.test.ts`, `chatMemoryInherit.test.ts`, and
  `HypaV3Modal.fence.test.ts`; `hostApiMemory.test.ts` for a plugin read's refresh, on a scripted `authFetch`, and for a
  read after the reset; `StructuredMemoryPanel.test.ts` for the reset control.
- Focused command: `pnpm --silent test:agent structuredMemory hostApiMemory upstreamExport chatStore`. No `slow` or
  `e2e` membership of its own.
- Not tested: a projection read that throws on the server, which answers the chat as stored and warns once.

## Known Hazards

### Limitations

- A held projection follows the memory revision, not the messages. A message edit or a send's manifest that changes
  reconciliation, the order, or `metrics` without moving the revision shows at the next whole read or the next move of
  the revision. Decision: Structured Memory slice 5g, archive.
- A `chatOutput` listener's payload copies the mirror with no refresh, so its `hypaV3Data` is what the tab holds. A
  listener that needs the newest calls `getChatFromIndex`.
- A chat past `MEMORY_REVISION_CHATS_MAX` waits its turn across reads, and one over the projection's byte cap keeps its
  last whole read's value.
- A change shows at the first read past a chat's `MEMORY_RECHECK_WINDOW_MS`, not the very next read. The refresh shares
  `authenticatedRouteLimiter`, and its cost is bounded per chat per tab: one `getChar` loop is one request a window, and
  a plugin walking chats through `getChatFromIndex` costs one request per chat per window.

### Gotchas

- `HypaV3Modal` takes a sealed value as no data: under this algorithm the modal shows no summaries, though a plugin's
  read of the same chat projects them.
