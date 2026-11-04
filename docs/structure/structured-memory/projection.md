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

- `shared/structuredMemory.ts`: compatibility shapes and seals; `projectHypaV3Data`, `sealHypaV3Data`,
  `isSealedHypaV3Data`, `sealedHypaV3DataIntact`, `sealedHypaV3DataRevision`, `SealedHypaV3Data`,
  `hypaV3DataHoldsSummaries`, `MEMORY_REVISION_CHATS_MAX`, `StructuredMemoryRevisionsAnswer`,
  `StructuredMemoryProjectionAnswer`.
- `server/src/data/memoryStore.ts`: stored-record projection; `projectChatMemory`, `lastMemoryManifest`,
  `readProjectionRevisions`, `revisionToken`.
- `server/src/data/resourceStore.ts`: read overlays and projection reads; `sealedMemoryProjection`,
  `overlayMemoryProjection`, `overlaysMemoryProjection`, `store.memory.readProjection`,
  `store.memory.readProjectionRevisions`.
- `server/src/routes/structuredMemory.ts`: projection and reset routes; the header's `revisions`, `projection`,
  `reset-summaries`, and `resettable`. The shared `StructuredMemoryResetAnswer` is listed with
  [records' Files](records.md#files).
- `src/ts/storage/chatStore.svelte.ts`: the held field and its write guard; `keepsHeldHypaV3Data`, `keepsProjection`,
  `sendChat`, `noticeRefusedProjection`, `ChatProjectionState`, `chatProjectionState`, `installChatProjection`.
- `src/ts/plugins/apiV3/v3.svelte.ts`: plugin-read refresh; `refreshChatProjections`, `rotatingWindow`, `chatsOfRead`,
  `MEMORY_PROJECTIONS_PER_READ`, `MEMORY_RECHECK_WINDOW_MS`, `MEMORY_REFRESH_DEADLINE_MS`.
- `src/ts/process/structuredMemory.svelte.ts`: the tab's route client; `readStructuredMemoryRevisions`,
  `readStructuredMemoryProjection`, `resetStructuredMemorySummaries`.
- `server/src/data/upstream/exportDatabase.ts`: upstream compatibility projection; `projectUpstreamMemory`.
- `src/lang/en.ts` and `src/lang/ko.ts`: the refusal notice; `structuredMemory.projectionWriteRefused`.

## Flows

### The HypaV3 projection

Records become `hypaV3Data` through `projectChatMemory` and `projectHypaV3Data`. A tab's `/api/resources` whole read
seals and overlays it through `overlayMemoryProjection`, charging the chats' `memory_events` bytes in a budgeted read.
The mirror holds it for plugins. Writes built from the mirror leave it out; the server strips one a stale tab or
recovered resend carries, so no stored chat holds one. A tab can hold one after selecting another algorithm. A chat file
export recognizes the projection by its seal and drops it; an unsealed one would be exported as real summaries. Plugin
reads refresh through the revision and projection routes.

The upstream export writes it unsealed (`memory-projected`); a failed memory walk or event projection leaves chats as
stored (`memory-unreadable`) and never stops the export. `pinned` or a grade at least `importantEventGrade` becomes
`isImportant`; see `projectHypaV3Data` for metric rules and `projectChatMemory` for reconciliation and order.

### A tab's read

`server/src/routes/resources.ts` opts its GET and POST whole reads into `memoryProjection`; `overlaysMemoryProjection`
allows it only while the algorithm is selected. `sealedMemoryProjection` projects chats with events and no stored
summaries; real summaries retain HypaV3 ownership. A failed overlay returns the stored chat and warns once. The
non-cryptographic seal identifies an unchanged projection and authorizes nothing.

`readChatSource`, plain `readRefs`, a job's scope, a memory task, the HypaV3 baseline, `chatBaseline`, and checkpoint
capture's `meta` must read stored data, never a tab's overlay.

### The tab's mirror

`keepsHeldHypaV3Data` drops only the refused field, so the rest of the write applies; a plugin's chat write reaches it
through `setChatToIndex`, `applyChatResult`, and `settleHypaV3Data`. `sendChat` omits projections from mirror-built
writes and journal snapshots. `server/src/data/chatStore.ts`'s `withoutProjection` strips sealed values a stale tab or
recovered resend carries, in `prepareWholeChat` and `prepareOp`. A job's copy and a patch's `meta` leave a held
projection in place unless they bring summaries (`keepsProjection`). A whole read (`applyRemoteChat`, `installRead`)
takes the field as answered; without it, the held projection goes. `installChatProjection` is the field's one change
outside a write.

### A plugin's read

`getChar`, `getCharacter`, `getCharacterFromIndex`, `getChatFromIndex`, and `getDatabase` with `characters` await
`refreshChatProjections` before copying. Writes and `getDatabase` without `characters` do not ask; a send without a
plugin read pays no refresh cost.

1. `refreshChatProjections` calls the tab client's `readStructuredMemoryRevisions`, then the revisions route calls
   `store.memory.readProjectionRevisions`. One request checks due chats within `MEMORY_REVISION_CHATS_MAX`, without
   reading messages; unchanged tokens need no projection fetch.
2. For chats whose token changed, `readStructuredMemoryProjection` calls the projection route, which delegates to
   `store.memory.readProjection` and `sealedMemoryProjection` using stored messages. Both routes authenticate,
   rate-limit, and check the epoch.
3. The tab passes answers and the captured `chatProjectionState` to `installChatProjection`. Its comment defines the
   fence, token ordering, and null-answer handling.

`refreshChatProjections` defines eligibility, joined checks and the recheck window; `rotatingWindow` shares turns across
caps. `MEMORY_REFRESH_DEADLINE_MS` bounds the refresh (`readWithDeadline`, `src/ts/storage/readDeadline.ts`) because a
hook's read holds a send. Failure, refusal, or deadline lets the read return the held value.

### The upstream export

`readSnapshotFile` in `server/src/data/resourceStore.ts` walks the memory tables and keeps event rows for
`projectUpstreamMemory` in `server/src/data/upstream/exportDatabase.ts`; a failed walk sets `memoryEvents` to null. The
snapshot's `ui` record selects the algorithm; ownership follows the rule of a tab's read. The export writes the value
unsealed so an upstream restore and a re-import here take it as plain HypaV3 data.

### The reset

An adopted chat's stored summaries stay through adoption and [a rebuild](rebuild.md#what-a-rebuild-keeps); this separate
step hands the field to the projection. The reset route rechecks `resettable`'s eligibility and the fence in one step;
contents uses the same eligibility rule. `POST .../reset-summaries` writes a `meta` `unset` through `applyChanges`, so
the feed publishes it to other tabs.

The tab calls `resetStructuredMemorySummaries` and writes nothing back: echoing `unset` would move the revision and
could delete a newer value because `meta` applies on a stale revision. `markChatStale` and `refreshStaleChat` bring a
whole read with the projection: `hypaV3Owned` becomes false, and the next plugin read past `MEMORY_RECHECK_WINDOW_MS`
refreshes from records. Local work delays the whole read without losing the mark.

## State

- A tab holds a projection only in its mirror, sealed, with the memory revision it was read at inside the digest. The
  stored `hypaV3Data` never holds one: the server projects on each `/api/resources` read from
  [the records](records.md#state).
- `hypaV3Owned` is the tab's reading of the field: stored summaries mean HypaV3 owns it; an empty or a sealed value
  means the records do.

## Coupling

- The projection's return type and metric names come from `shared/memory.ts`. `HypaV3Modal.svelte` and
  `remapHypaV3Metrics` read each metric array independently, so an index may sit in two arrays.
- `readSnapshotFile` of [server resources](../server-resources.md#validation) walks the memory tables for the upstream
  export's projection, and alone among the walk's readers it does not stop on a problem in them (`memoryFailed`).
- The field's writes go through [the chat store](../chat-store.md), where `keepsHeldHypaV3Data` lives; the plugin reads
  that wait on the refresh are [plugins](../plugin-sandbox.md)'s.
- The reset writes a `meta` `unset` through `applyChanges`, so the live-update feed publishes it like any chat write.

## Invariants

- The stored `hypaV3Data` never holds a projection: the seal exists only in a tab's read and its mirror.
- `MemoryManifest.items` holds included items only; excluded candidates never reach the projection.
- Whole-chat reads overlay projections only through `/api/resources`. `readChatSource`, a plain `readRefs`, a job's
  scope, a memory task, the HypaV3 baseline, `chatBaseline`, and a checkpoint's capture read stored data.
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
