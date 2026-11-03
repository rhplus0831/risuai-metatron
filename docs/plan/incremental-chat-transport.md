# Incremental Chat Transport Plan

Status: drafted 2026-11-03, no slice landed. Decisions D1–D10 are recommendations for the owner; the
**Open questions** Q1–Q4 were answered by the owner on 2026-11-03 (the recommended option each time). Code
anchors were checked at `39dc41e1f`; verify them again before editing (STRUCTURE.md protocol step 5).

Sources: the owner's 2026-11-03 question about the research items left as "incremental boot and live chat
transport" (an epoch change cursor, message-row deltas, a message-id index); the
[server migration audit](../research/deep-audit-with-fable/server-migration-audit.md) ST03 (the reconnect listing,
compression fixed, the cursor and digest left open), ST04 (feed fallbacks that read a collection or a whole chat;
the summary and `delta` cases fixed, the over-cap case left), SD01 (the streaming checkpoint; the server work
fixed, "the feed patch still carries the whole changed message to every connected feed socket") and SD03 (the
publication budget); the Boot Bytes plan's Q2 and **Later** ("a persisted change log and a `changes?since=`
cursor") and the Per-Event Server Work plan's **Later** ("a by-id read for an over-cap change of a loaded chat",
"a streaming-row text delta on the job socket", "retiring `patch` for `delta` … once an older client can be
refused"), both in [the archive](../archived-plan/README.md) (Remaining Follow-Ups); the
[rendering performance investigation](../research/rendering-performance-investigation.md) F1 (stream ingress
after a history-sized lookup); the [resource sync guide](../structure/resource-sync.md) (Feed connection, Live
updates, Chat live updates, Transport, Limitations), the [server generation guide](../structure/server-generation.md)
(Live-update hello, Frame admission, Own chat changes, Feed chat entries, Publication budget, Job chat and
barriers), the [chat store guide](../structure/chat-store.md) (Job chunks, Summaries and refresh) and the
[server resources guide](../structure/server-resources.md) (Resource routes, Store tables) at `39dc41e1f`.

Owning guides when sliced: [resource sync](../structure/resource-sync.md) (the cursor replay on reconnect, the
new feed entry forms a tab applies, the by-id row read), [server generation](../structure/server-generation.md)
(`hello.cursor`, the feed entry builder, the job socket's streamed rows and query flags),
[server resources](../structure/server-resources.md) (the change log table, the `since` listing, the row read),
[chat store](../structure/chat-store.md) (the message index, what a streamed row means to the owner),
[persistence](../structure/persistence.md) (the shared types in `shared/resources.ts` and `shared/events.ts`),
[test harness](../structure/test-harness.md) (the drivers and probes the slices rerun).

Relation to the other active plans: the [Render Work Budget plan](render-work-budget.md) D8 puts a validated
last-position memo for F1 in its Slice 0 and leaves "the whole per-chat message index" in its **Later**; this
plan's Slice 0 is that full form (D1) and supersedes the memo, whichever lands first. The
[Job Handoff plan](job-handoff.md) adds viewer sockets, `role`, `register` and `clients` to the same sockets
(its D2, D3, D6): this plan adds no frame those need, and its Slices 2 and 3 are not run in parallel with Job
Handoff Slices 1 and 3 or Reroll Candidates Slice 1 (all edit `shared/jobs.ts`, `server/src/routes/events.ts`
or `src/ts/network/eventFeed.ts`). The [Reroll Candidates plan](reroll-candidates.md) D12 relies on reroll writes
reaching the feed and the job `chatPatch` as any by-id write does; the forms added here apply to them unchanged.

## Goal

A tab that is already up to date pays for what changed, not for what it holds:

- **Stream ingress is independent of history length.** Every by-id lookup in the chat store, the stored
  translation lookup and the active streaming row lookup use one validated per-chat index instead of a scan of
  the message array (D1).
- **A streaming reply costs chunk-sized frames on the feed.** The checkpoint of a reply reaches every other tab
  as the text added since the previous checkpoint, not as the whole reply row, so a long reply never crosses the
  64 KiB payload cap and never makes a loaded observer read the chat whole (D2).
- **The owner is not sent its own reply back.** The job socket's `chatPatch` names a generated row by the stream
  sequence its stored text equals, and the owner reconstructs it from the chunks it already holds (D3).
- **A reconnect after an away-time change replays the change, not the listing.** The server keeps a bounded,
  epoch-scoped change log; a tab whose `hello` digest does not match asks for the changes since its cursor and
  falls back to the whole listing only when the log no longer covers it (D5).
- **The rare over-cap change of a loaded chat reads its rows, not the chat** (D6, gated by measurement: Q2).

Not goals: per-socket subscriptions or per-tab filtering of the feed; a bound on the `hello` snapshots or on a
frame's refs and lock lists; retiring `patch` for `delta` or dropping whole barriers for sockets without
`hydration=patch` (D4 only records the number such a retirement would need); the chat's summary on the job
socket; the provider callback stream (`ChannelChunk`, cumulative and coalesced at 50 ms in
`src/ts/network/jobChannel.ts`, a different path); characters as a sidebar projection (Boot Bytes Q3); a boot
cache that follows the tab's acknowledged state.

## Current state

The baseline is `39dc41e1f` on `dev` (2026-11-03). This plan does not re-propose it.

- **Reconnect.** Every live-update connection gets one `hello` with the epoch, the generation locks, the memory
  task statuses and an optional `digest` (`server/src/routes/events.ts:134-161`; the digest is
  `revisionDigest(resources.listRevisions())`, `server/src/app.ts:303-315`, `shared/resources.ts:522-529`). The
  client reconciles from its advertised map when the epoch and digest match, else it reads
  `GET /api/resources/revisions` (`src/ts/network/eventFeed.ts:198-239`; the route at
  `server/src/routes/resources.ts:323-328` answers through `compressedJson`), overlaying the changes that arrived
  while the listing was pending, null rows as tombstones (`eventFeed.ts:75-77`, `:89-109`), and hands the listing
  to `reconcileRemote` (`src/ts/storage/resourceSync.svelte.ts:4620`). For 300 characters and 3,000 chats the
  listing is 81,504 bytes with zstd, 106,189 with gzip (ST03's after line); an unchanged resume costs nothing
  since the digest. Nothing is replayed: the server has no publication sequence. `publishing`
  (`server/src/data/resourceStore.ts:1241-1286`) publishes one `change` frame per outermost write after its
  transactions committed; `recordResource` and `recordChat` run after `commitTransaction()`
  (`:1794-1810`); `writeCount` (`:965-977`) only schedules snapshots. A revision token is
  `<epoch>:<seq>:<revision>` (`:784`), a row's incarnation and write counter, not an order across rows. The
  epoch is a UUID in `meta` (`:718`); `replaceAll` writes a new one in the replacement transaction and publishes
  an `epoch` frame (`:2847-2927`); the client keeps it in `currentEpoch` (`src/ts/storage/resourceClient.ts:55-75`)
  and halts on a mismatch.
- **Feed chat entries.** `chatFeedChange` (`server/src/data/chatStore.ts:1487`) builds a `patch` with the changed
  rows whole (`messages: { after, message }[]`, `shared/resources.ts:389-395`) when it fits `MAX_FEED_PATCH_BYTES`
  (64 KiB, `:422`), else a `delta` whose metadata comes by field (`metaFields`, `:416`) with the same rows, else
  neither; `summary` or `summaryBase` beside it; one publication's optional payloads share
  `MAX_FEED_PUBLICATION_PATCH_BYTES` (256 KiB, `budgetedEntries`, `resourceStore.ts:1161`). The rows come from
  the group's `ChatWriteChange.rows` (`chatStore.ts:403-419`: the rows as stored after the group), never the
  rows before it. A streaming reply is checkpointed every `CHECKPOINT_INTERVAL_MS` (3 s,
  `server/src/prompt/runner.ts:91`) with a `setText` carrying the whole text so far (`:1715-1727`), so every
  checkpoint publishes the whole reply row to every feed socket: 32,989 bytes of feed patch per checkpoint at a
  32 KiB reply (SD01's after line), growing with the reply, and nothing once the row passes 64 KiB. A loaded
  observer applies a patch or delta only when idle and held at exactly `baseRevision`
  (`applyRemoteChatPatch`, `src/ts/storage/chatStore.svelte.ts:2581-2597`, the tail rebuilt from the `after`
  anchors); an entry without either is a notice, and the idle refresh reads the chat whole through
  `POST /api/resources/read` (`ResourceReadRequest`, `shared/resources.ts:219`; the resource sync guide's
  Limitations: "a reply over `MAX_FEED_PATCH_BYTES` into a chat another tab has open costs up to one read per
  checkpoint"). Messages are rows of their own: `messages (chatSeq, id, position, data, generation…)`, primary
  key `(chatSeq, id)` (`chatStore.ts:67-78`), but no route reads rows by id; `readChat` (`:2616`) selects them
  all by position.
- **The job socket.** The chunk frame is already a delta: `GenerationChunkEvent` keeps `keep` units of the text
  at `base` and appends `text` (`shared/jobs.ts:227-237`; the server computes the common prefix at
  `server/src/jobs/generationJobs.ts:1400-1431` and sends it to every open owner socket, `:742-760`). The job
  chat is not: `emitRecords` (`:1454-1480`) sends the owner a `chatPatch` at every checkpoint while a socket is
  open, built by `diffChat` (`:579-617`) from the last copy a socket took, and that patch carries every row the
  job began a generation on whole, changed or not (`shared/jobs.ts:272-288`): 33,265 bytes per checkpoint at a
  32 KiB reply (SD01), beside the chunks that carried the same text. The callback barrier (`hydrateJobChat`,
  `:1039-1060`) sends nothing while the stored revision is the last copy's. A socket advertises its
  capabilities by query only: `clientId`, `attach`, `liveness=1`, `hydration=patch`
  (`src/ts/network/generationJobs.ts:910-918`, read at `generationJobs.ts:2088-2122`). Neither socket carries a
  protocol number, and nothing refuses or downgrades an older client; a socket without `hydration=patch` gets
  the chat whole (the server generation guide's Limitations).
- **Stream ingress.** `applyServerGeneration` (`chatStore.svelte.ts:1772`) finds the message with
  `message.find((entry) => entry.chatId === update.messageId)` (`:1779`) before deciding whether the update
  waits in `heldStreamText` (`:1692`) for the frame; `showStreamText` finds it again (`:1732`);
  `applyServerGenerationChunk` scans with `some` (`:1844`); job hydration scans twice per streaming entry
  (`:2283`, `:2311`); `indexOfMessage` (`:3156-3158`) scans for its fifteen callers; `applyRemoval` scans
  (`:3488-3491`); `heldMessage` scans for the stored translation of each row
  (`src/ts/translator/storedTranslation.svelte.ts:85`); `activeStreamingIndex` scans once per streaming entry
  change (`src/lib/ChatScreens/Chats.svelte:751-756`). The held chats are `HeldChats` (`:518`) under one
  `$state` (`:535`), each `Chat.message` a plain array in deep state; the per-message maps that exist
  (`serverGenerations` `:444`, `serverWatermarks`, `feedLocks`, `heldStreamText`) are keyed by
  `messageKeyOf` (`:112-113`), not by position, and none is an index of the array. F1 measured 200 synchronous
  updates to the tail at 6.7 ms (100 messages), 111.8 ms (2,000) and 833.1 ms (10,000) with no component
  mounted (the investigation's reproduction, `rendering-performance-investigation.md:347-388`). Rows are
  replaced, spliced, renamed or re-identified in known places: insertion, replacement and eviction
  (`:1061-1129`, `:7152-7157`), `hydrateChat` (`:2335-2377`), the patch tail (`:2524-2533`), `replaceChat`
  (`:3895-3913`), append, replace and splice (`:3196`, `:3222`, `:3490-3491`, `:3537`), id normalization
  (`:1355-1364`, applied to held chats at `:4779-4783`) and server renames (`:5426-5437`).
- **Tests and probes that exist.** Client: `src/ts/network/eventFeed.test.ts`,
  `src/ts/storage/tests/{resourceSyncLive,resourceSyncFeedPatches,resourceSyncLazyChats,chatStore}.test.ts`
  (`chatStore.test.ts:1979-2048` covers stream coalescing), `src/ts/network/{generationJobs,generationJobsDelta,jobChannelBarrier}.test.ts`,
  `src/ts/translator/storedTranslation.test.ts`. Server: `server/src/tests/{events,changeFeed,chatFeedPatches,chatPatch,chatStore,generationBarrier,generationDeltaChunks,resourceStore}.test.ts`.
  Probes under `docs/research/deep-audit-with-fable/probes/`: `checkpoint-probe.mjs` (checkpoint phases, feed
  and owner patch bytes, whole-transcript reads), `job-channel-probe.mjs` (callback barrier frames),
  `sync-traffic-measure.mjs`. Drivers: `util/playwright/measureBoot.mjs` (cold, warm, resume and resume-away
  boots with the listing's bytes), `checkLiveUpdates.mjs`, `checkTwoClientSmoke.mjs`, `checkServerSend.mjs`,
  `checkJobProtocol.mjs`, `measureChats.mjs` (a 2,000-message chat streamed 200 chunks). No e2e spec covers a
  reconnect; `e2e/lazyChats.spec.ts` streams beside an unloaded chat.

## Decisions

- **D1. One validated message position index per held chat.** `chatStore.svelte.ts` keeps
  `messagePositions: Map<string, Map<string, number>>` (chat key to message id to position), built lazily by one
  pass over `chat.message` the first time a by-id lookup touches the chat, and consulted by a new
  `positionOf(chat, id)` that `indexOfMessage`, `applyServerGeneration`, `showStreamText`,
  `applyServerGenerationChunk`, the two job hydration scans and `applyRemoval` call. A hit is trusted only when
  `chat.message[position]?.chatId === id`; a miss or a mismatch rebuilds the map once and looks up again
  (then `-1`). Ids are unique within a chat (`prepareMessages`, `:1355-1364`), so a stale position can never
  name another row with the same id: correctness does not depend on invalidation, only the rebuild count does.
  The structural paths listed under **Current state** drop the chat's map through one `dropMessagePositions(key)`
  (eviction and whole replacement drop it; append, splice, the patch tail, renames and normalization drop it
  too, a rebuild being cheaper than per-path maintenance); a streaming update touches no structure, so the C
  updates of a reply share one build: O(N + C) in place of O(N × C). Two exports,
  `heldMessageById(ref, id)` and `messagePositionOf(ref, id)`, replace the scans in
  `storedTranslation.svelte.ts` `heldMessage` and `Chats.svelte` `activeStreamingIndex` (the latter keeps its
  `$derived`, reading the message array so Svelte still tracks it). Rejected: a map from id to the row object
  (a `$state` proxy's identity is not the raw row's, and a replaced row with the same id would keep serving the
  old object); maintaining positions on every write path (the Render Work Budget plan's objection, which this
  validated form avoids); the Render Work Budget memo alone (one remembered position does not serve
  `indexOfMessage`, the translation lookup or hydration).
- **D2. A feed entry can carry row text deltas.** `ChangeSet.chats[]` gains a third optional payload,
  `rowDelta?: ChatRowDeltaBody`, where `ChatRowDeltaBody = ChatDeltaBody & { textRows: { id: string; keep:
number; text: string }[] }`: for a row whose stored JSON changed only in `data` and whose position and
  neighbours are unchanged, the common prefix of the stored text before and after the group (as the chunk's
  `keep`, `generationJobs.ts:1409-1421`) and the rest; every other changed row stays in `messages` whole. The
  server computes it in `chatFeedChange`'s pass, from the row's stored text before the group (read where
  `applyGroup` reads the row to apply its op; today `chatFeedChange` receives only the rows after it, so the
  builder's input grows by the before text of each touched row, never a chat read) and after it. Selection
  order: `patch` when it fits; else `rowDelta` (metadata by field, `textRows` for the eligible rows, the rest
  whole) when it fits; else `delta` as today (so a tab that applies a `delta` never regresses); else none. The
  client prefers `patch ?? rowDelta ?? delta` (`noteRemoteChanges`, `resourceSync.svelte.ts`) and
  `applyRemoteChatPatch` applies `textRows` under its existing conditions (loaded, idle, not stale, held at
  exactly `baseRevision`, which guarantees the text before) plus `message.data.length >= keep`; any other case
  is a miss and takes the ordinary notice and idle refresh as a misfit patch does today. The effect on a
  streaming reply: each checkpoint's payload is the text added since the previous one (bytes of 3 s of
  streaming) rather than the whole reply, so a long reply stays under the 64 KiB cap for its whole length, and
  the ST04 leftover ("a reply over 64 KiB into a chat another tab has open") no longer occurs for replies. Why a
  third field and not a `textRows` field on `delta`: an older client applies a `delta` it understands by its
  known fields and advances its revision; a `delta` whose only change were in a field it ignores would leave
  it silently behind. It never sees a `rowDelta`, so it takes the notice and reads, as today (D8). Rejected:
  raising the 64 KiB cap; sending the ops (a stale group merges onto the stored base and normalization rewrites
  the result, the reason `delta` diffs stored metadata rather than ops).
- **D3. The owner's `chatPatch` names streamed rows.** `GenerationChatPatchEvent.messages[]` entries may be
  `{ after, id, streamed: { generationId: string; seq: number } }` for a row the job began a generation on whose
  stored text is the stream text at `seq` (the checkpoint writes the same `text` the chunk at that `seq`
  carried, `runner.ts:1714-1727`) and whose other fields equal the base copy's; `diffChat` emits that form only
  for a socket that attached with `rows=streamed` (a WeakSet flag beside `hydration=patch`,
  `generationJobs.ts:670-676`). The owner (`hydrateChatPatch`, `applyChatPatch`) keeps the row it holds and lets
  the existing watermark rule decide the text: the entry's `streaming` list sets `serverWatermarks` for the
  generation (`:2275-2278`), a held stream buffer above the watermark is shown (`:2305-2317`), one at or below it
  means the stored text is what the client already displays or an older text it need not restore. A streamed
  row whose generation the client does not hold at all (the placeholder `seq: -1` case, or a retired generation)
  cannot be applied and takes `ChatResyncRequest` as any patch that does not apply, which sends the chat whole.
  Expected saving: the 33,265-byte owner patch per checkpoint becomes a few hundred bytes; the barrier and the
  callback receipts are unchanged (the receipt still names the revision the patch reached). Rejected: dropping
  the per-checkpoint `chatPatch` altogether (its `streaming` list and revision are what let the owner skip the
  barrier read).
- **D4. A protocol number both sockets read.** The live-update socket URL and the job socket URL gain
  `proto=1`; the server records the number per socket (and, for the job socket, in the job's socket flags) and
  refuses nothing. It is the "demonstrated compatibility boundary" the Per-Event Server Work plan asked for
  before retiring `patch` or whole barriers: a later plan can set a floor and measure which clients are below
  it from the diagnostics. Capability flags stay additive (`rows=streamed` in D3): a number without a floor
  changes no behaviour, and a flag tells the server exactly which form a socket takes. Q3 answered: the number
  is added now, in Slice 2.
- **D5. A bounded, epoch-scoped change log and a cursor.** `resources.sqlite` gains
  `changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, characterId TEXT, id TEXT NOT NULL,
revision TEXT)` in `STORE_TABLES_SQL` (`resourceStore.ts:106-124`): one row per ref a write commits (records
  as `kind`, chats as `chats` with `characterId`, orders as `chatOrders`), `revision` null for a deletion. The
  rows are inserted in the write's transaction right before `commitTransaction()` (from `results`,
  `chatOutcome.results` and `chatOutcome.orders`, which are complete before the commit, `:1794-1800`), so a
  cursor never names a change that did not commit, and a commit never lacks its rows. The table is truncated
  in `replaceAll`'s transaction (a new epoch starts at an empty log) and pruned on write to the newest 20,000
  rows (Q1). The cursor is the newest `cursor` value. `hello` gains `cursor`, sampled in the same synchronous step as
  the digest; every `change` frame gains `cursor` (the publication's newest row) so a connected tab's cursor
  stays current without a listing. `GET /api/resources/revisions?since=<cursor>` answers
  `{ epoch, cursor, changes }` with the rows after `since` coalesced per key to the newest revision or
  tombstone, in `ChangeSet` shape without payloads, or `{ epoch, cursor, expired: true }` when `since` is below
  the oldest retained row (or unknown); a `since` of another epoch is the epoch mismatch the listing already
  answers. The client (`reconcile`, `eventFeed.ts:198-239`): digest matches, as today; else, with an advertised
  map of the loaded epoch and a cursor, read `?since=`, apply the answer to the map as the overlay is applied
  (tombstones kept), then check `revisionDigest(advertisedListing()) === hello.digest`; a match reconciles from
  the map and the memory fences take that listing (it is the server's state at the cursor, every recreated row
  at its final revision); `expired`, a digest that still differs (a gap the log cannot explain) or no cursor
  read the whole listing as today. The replay carries refs only: `hello` already replaces the lock and memory
  task sets whole, and payloads were never replayed. Expected saving: the 81 KB zstd listing after an away-time
  change becomes the handful of refs that changed, on every resume after 30 s hidden, `resume` and `online`.
  Rejected: numbering publications in memory (lost on restart, when every tab reconnects at once and needs it
  most); logging payloads (the log would be a second copy of the data on the hottest write path, the reason
  Boot Bytes Q2 deferred it); a per-tab cursor on the server (the server keeps no per-tab state on the feed).
- **D6. An over-cap entry names its rows; a loaded chat reads them by id** (gated, Q2). When neither form fits,
  the entry carries `rows: { changed: string[]; removed: string[]; count: number; meta: boolean }` (ids only,
  the information `chatFeedChange` already holds). A loaded, idle chat held at exactly `baseRevision` with
  `meta: false` reads the changed rows through a new `chatRows` entry of `POST /api/resources/read`
  (`{ characterId, id, revision, messageIds }`, answered as `{ revision, rows: { id, after, message }[] }` at
  that revision, or `unanswered` when the chat moved on, which `readRefs` already re-sends or fails), and
  applies them with `removed` and `count` as a patch; every other case reads the chat whole as today. The
  server selects by the `(chatSeq, id)` key and `messages_position` for `after`. After D2, an over-cap entry
  needs a single write to change more than 64 KiB of rows at once (a large paste, an import's rewrite, a
  trigger's bulk edit): Slice 1's probe after-lines count them and Q2 decides whether this slice ships.
- **D7. Caps and budgets are unchanged.** `MAX_FEED_PATCH_BYTES`, `MAX_FEED_PUBLICATION_PATCH_BYTES`, the 4 MiB
  socket admission and `MAX_REMOTE_READS` stay; `rowDelta`, the `rows` manifest and `streamed` entries are
  optional payloads measured and dropped by `budgetedEntries` like the others; refs, orders and lock lists are
  never dropped. Coalescing (`coalescedChat`) treats `rowDelta` as it treats `patch` and `delta`: the later
  entry without it.
- **D8. Compatibility is additive on every path.** An older tab ignores `rowDelta`, `rows`, `cursor` and
  `proto`, never receives `streamed` rows (it sends no `rows=streamed`), and gets the listing it asks for
  without `since`; an older server (a newer tab against it) sends none of the new fields and the tab behaves as
  today. `shared/events.ts` and `shared/resources.ts` document each field as optional; the client's `receive`
  switch keeps ignoring unknown frame types (verified by the Job Handoff plan's tests).
- **D9. Measurements are part of done, from the pinned baseline.** Each slice reruns the probe or driver it
  changes and records an after line in the audit with the same fixture: `checkpoint-probe.mjs` for the feed
  patch bytes per checkpoint (Slice 1) and the owner `chatPatch` bytes (Slice 2), `measureBoot.mjs`'s
  resume-away case for the listing bytes and the reconnect time after an away-time change (Slice 3),
  `sync-traffic-measure.mjs` for the share of over-cap entries (Slice 1, feeding Q2), and the F1 reproduction
  rerun once as a production trace with `measureChats.mjs` at 2,000 and 10,000 messages (Slice 0).
- **D10. Tests count, never time** (V3). The index test counts rebuilds and lookups through a counter the store
  exposes for its tests (as `lockState.version` is read today), for updates to the tail of a 100- and a
  10,000-message history, several updates before one frame, a splice between updates and a chat replacement
  between updates; the feed tests assert payload bytes and forms on fixed fixtures; the cursor tests drive the
  log with a fake clock and a test-only retention; no test asserts elapsed time.

## Open questions

All four were answered on 2026-11-03 with the recommended option; they are kept here as the record of why.

- **Q1. Change log retention.** Answered: keep the newest 20,000 rows, pruned in the write that passes the
  bound (a row is under 200 bytes: 4 MB at most, and a replay of 20,000 refs is already the size of a listing,
  so a longer log saves nothing). Alternative: an age bound (7 days), which lets a quiet server keep a tiny log
  but makes the fallback depend on the clock.
- **Q2. Whether D6 ships.** Answered: gated. Slice 1's after lines count over-cap entries in
  `sync-traffic-measure.mjs`'s fixture and in a long-reply run of `checkpoint-probe.mjs`; Slice 4 is scheduled
  only if any remain in the reply case or they exceed 1% of entries in the mixed fixture, else D6 moves to
  **Later** with the numbers. Alternative: ship it unconditionally, since the row read is small and the whole
  read it replaces can be megabytes.
- **Q3. The protocol number now.** Answered: yes, `proto=1` on both sockets in Slice 2, read and logged, never
  enforced; the Per-Event retirements then have their boundary without another protocol change. Alternative:
  leave it to the plan that first needs a floor.
- **Q4. Which rows get text deltas.** Answered: every row whose stored JSON changed only in `data`, whatever
  op changed it (a `setText` checkpoint, a user's edit through `setMessage` or `patchMessage`), since the server
  compares stored rows and the prefix scan costs one pass over the row. Alternative: generation `setText` rows
  only, which keeps user edits whole and the builder smaller.

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Slice 0 needs
nothing; Slices 1 and 3 share `shared/resources.ts` and `resourceSync.svelte.ts` and are not run in parallel;
Slice 2 edits `shared/jobs.ts` (not in parallel with Job Handoff Slice 1 or Reroll Candidates Slice 1); Slice 3
edits `events.ts` and `eventFeed.ts` (not in parallel with Job Handoff Slices 1 and 3).

### Slice 0: the message position index (D1, D9, D10; needs nothing)

Files: `src/ts/storage/chatStore.svelte.ts` (`messagePositions`, `positionOf`, `dropMessagePositions` at the
structural sites listed under **Current state**, the two exports, the scans replaced),
`src/ts/translator/storedTranslation.svelte.ts` (`heldMessage` through `heldMessageById`),
`src/lib/ChatScreens/Chats.svelte` (`activeStreamingIndex` through `messagePositionOf`), the chat store guide
(By-id ops, Job chunks: the index and its validation), the Render Work Budget plan (its D8 and **Later**: the
memo is superseded; if its Slice 0 landed first, this slice removes the memo).

- Tests (`src/ts/storage/tests/chatStore.test.ts`, `src/ts/translator/storedTranslation.test.ts`): the counter
  cases of D10; a lookup after a splice, a rename, normalization of a new character and a server rename answers
  the right row with exactly one rebuild; a lookup of a removed id is `-1`; `heldMessage` and the active
  streaming index are unchanged in `Chat.settledRender.svelte.test.ts` and `chatStatus.test.ts`.
- Measurement: `measureChats.mjs` at 2,000 and 10,000 messages, 200 chunks, before and after; the F1 section
  gets an after line.

### Slice 1: row text deltas on the feed (D2, D7, D8, D9; needs nothing)

Files: `shared/resources.ts` (`ChatRowDeltaBody`, `ChangeSet.chats[].rowDelta`, the cap comment),
`server/src/data/chatStore.ts` (`chatFeedChange`'s before text and `textRows`, the selection order,
`ChatFeedPayloads`), `server/src/data/resourceStore.ts` (`budgetedEntries` and `coalescedChat` for the third
payload), `src/ts/storage/resourceSync.svelte.ts` (`noteRemoteChanges`: `patch ?? rowDelta ?? delta`),
`src/ts/storage/chatStore.svelte.ts` (`applyRemoteChatPatch`: `textRows`), the server generation guide (Feed
chat entries, Publication budget), the resource sync guide (Chat live updates, Limitations: the over-cap
sentence rewritten), the chat store guide (Summaries and refresh).

- Tests, server (`server/src/tests/chatFeedPatches.test.ts`, `chatStore.test.ts`, `resourceStore.test.ts`): a
  `setText` checkpoint of a 100 KiB reply publishes a `rowDelta` of the appended bytes and no `patch`; a row
  whose role changed goes whole; a rewrite with no shared prefix is as large as the row; the entry falls to
  `delta` when `rowDelta` does not fit and to none past that; the publication budget drops a `rowDelta` as it
  drops a `patch`; coalescing keeps the later entry without it.
- Tests, client (`src/ts/storage/tests/resourceSyncFeedPatches.test.ts`, `resourceSyncLazyChats.test.ts`,
  `chatStore.test.ts`): a loaded idle chat at the base applies `textRows` with no read; a chat held at another
  revision, a row shorter than `keep`, a missing row and a non-idle chat each take the notice and one idle read;
  an unloaded chat is unaffected (summary knowledge as today); an entry with `patch` and `rowDelta` both is not
  a body this client knows (as `meta` beside `metaFields` is today).
- Measurement: `checkpoint-probe.mjs` with the SD01 fixture and a long-reply run (a reply past 64 KiB): feed
  patch bytes per checkpoint and whole-transcript reads of a loaded observer, before and after;
  `sync-traffic-measure.mjs` for the over-cap share (Q2).

### Slice 2: streamed rows on the job socket, the protocol number (D3, D4, D8, D9, Q3; needs nothing)

Files: `shared/jobs.ts` (the `streamed` row form, the query flags documented), `server/src/jobs/generationJobs.ts`
(`rows=streamed` and `proto` in `handleUpgrade`, `diffChat` and `chatPatchEvent` emitting `streamed` rows for
such sockets), `server/src/routes/events.ts` (`proto` read and logged), `src/ts/network/generationJobs.ts` (the
socket URL), `src/ts/network/eventFeed.ts` (the socket URL), `src/ts/storage/chatStore.svelte.ts`
(`applyChatPatch`: a `streamed` row keeps the held row; the resync case), the server generation guide (Job chat
and barriers, Generation channels, Limitations), the chat store guide (Job chunks, Job hydration).

- Tests, server (`server/src/tests/chatPatch.test.ts`, `generationBarrier.test.ts`,
  `generationDeltaChunks.test.ts`): a checkpoint's `chatPatch` to a `rows=streamed` socket names the reply by
  `generationId` and `seq` and carries the user message whole; a socket without the flag gets the row whole; a
  generated row whose role or name changed goes whole; the barrier receipt names the same revision either way;
  `proto` is recorded and a socket without it is served as before.
- Tests, client (`src/ts/network/generationJobs.test.ts`, `jobChannelBarrier.test.ts`,
  `src/ts/storage/tests/chatLock.svelte.test.ts`): a streamed row with the buffer above the watermark keeps the
  shown text; at the watermark it is unchanged; a streamed row of a generation the tab does not hold asks
  `resync` once; the barrier passes without a read after the patch.
- Measurement: `checkpoint-probe.mjs` owner `chatPatch` bytes per checkpoint; `job-channel-probe.mjs` unchanged
  frame counts.

### Slice 3: the change log and the cursor (D5, D7, D8, D9, Q1; needs nothing)

Files: `server/src/data/resourceStore.ts` (the `changes` table, the insert before `commitTransaction()`,
pruning, truncation in `replaceAll`, `listChanges(since)`, `cursor()` sampled with the digest, the publication's
cursor on the `change` frame), `server/src/routes/resources.ts` (`since`), `server/src/routes/events.ts`
(`hello.cursor`, `change.cursor`), `server/src/app.ts` (wiring), `shared/resources.ts`
(`ResourceChangesSince`), `shared/events.ts` (the two fields), `src/ts/network/eventFeed.ts` (the held cursor,
the `?since=` read, the digest check, the fallbacks), `src/ts/storage/resourceClient.ts` (`listChanges`), the
server resources guide (Resource routes, Store tables), the resource sync guide (Feed connection), the server
generation guide (Live-update hello).

- Tests, server (`server/src/tests/resourceStore.test.ts`, `events.test.ts`, `changeFeed.test.ts`): every
  committed ref of a write is one log row and a rolled-back write leaves none; a deletion is a tombstone; a
  recreated chat replays at its newest revision only; `since` past the retention answers `expired`; another
  epoch is the mismatch; `replaceAll` empties the log; `hello` and `change` carry the cursor the log holds at
  that step; the retention prunes at the bound (test-only limit).
- Tests, client (`src/ts/network/eventFeed.test.ts`, `src/ts/storage/tests/resourceSyncLive.test.ts`): a `hello`
  with a matching digest reads nothing; a mismatching digest with a cursor reads `?since=` and reconciles from
  the map with no listing; `expired` and a digest that still differs after the replay read the listing once; a
  replayed deletion removes the held row and a replayed recreation does not release the memory fence of the
  older incarnation; a frame's cursor advances the held cursor; no cursor (first connection) reads the listing.
- Measurement: `measureBoot.mjs` resume-away (bytes and time of the reconnect after a change made while hidden),
  before and after; `checkLiveUpdates.mjs` and `checkTwoClientSmoke.mjs` runs.

### Slice 4: the over-cap row manifest and the by-id row read (D6, D7, D8; needs 1, scheduled by Q2)

Files: `shared/resources.ts` (`ChangeSet.chats[].rows`, `ResourceReadEntries.chatRows`, the answer),
`server/src/data/chatStore.ts` (the manifest in `chatFeedChange`, `readRows`), `server/src/routes/resources.ts`
(the read entry under the read budget), `src/ts/storage/resourceClient.ts` (`readRefs` with `chatRows`),
`src/ts/storage/resourceSync.svelte.ts` and `src/ts/storage/chatStore.svelte.ts` (the row read in place of the
whole read for a loaded chat at the base), the resource sync guide (Chat live updates, Transport), the server
resources guide (Resource routes, Read budget).

- Tests: an over-cap entry carries the manifest and no payload; a loaded chat at the base reads the named rows
  once and applies them; a chat that moved on gets `unanswered` and reads whole; `meta: true` reads whole; the
  read budget counts rows; an older client (no `chatRows`) reads whole as today.
- Measurement: the after lines of Slice 1 rerun with the same fixture.

### Slice 5: the browser checks and the final guide pass (needs 3, and 4 when scheduled)

- Runs: `checkLiveUpdates.mjs`, `checkTwoClientSmoke.mjs`, `checkServerSend.mjs` and `checkJobProtocol.mjs`,
  one dev stack at a time (the test harness guide's Playwright rules); the e2e specs `lazyChats.spec.ts`,
  `perChatSends.spec.ts` and `serverTransform.spec.ts`.
- Guides: the Limitations sentences the slices retired are removed or rewritten with the decision references; the
  audit's ST03, ST04 and SD01 sections and the archive's Boot Bytes and Per-Event Server Work follow-ups get
  their after lines; the Render Work Budget plan's F1 references are checked once more.
- The plan moves to the archive with the measured numbers.

## Recommended order

0 → 1 → 2 → 3 → (4) → 5. Slice 0 is client-only and the smallest; Slice 1 removes the largest recurring traffic
(every checkpoint to every tab) and produces Q2's numbers; Slice 2 is the owner's half of the same saving;
Slice 3 is the only new server store and benefits from the earlier slices' tests of the feed; Slice 4 is
decided by Q2. Slices 0, 2 and 3 touch disjoint files and may run in parallel sessions; 1 and 3 do not.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for every renamed export, `pnpm check:tests` if a
  slow row changes.
- Focused: `pnpm --silent test:agent src/ts/storage/tests/chatStore.test.ts src/ts/translator/storedTranslation.test.ts`
  (Slice 0);
  `pnpm --silent test:agent server/src/tests/chatFeedPatches.test.ts server/src/tests/chatStore.test.ts server/src/tests/resourceStore.test.ts src/ts/storage/tests/resourceSyncFeedPatches.test.ts src/ts/storage/tests/resourceSyncLazyChats.test.ts`
  (Slice 1);
  `pnpm --silent test:agent server/src/tests/chatPatch.test.ts server/src/tests/generationBarrier.test.ts server/src/tests/generationDeltaChunks.test.ts src/ts/network/generationJobs.test.ts src/ts/network/jobChannelBarrier.test.ts`
  (Slice 2);
  `pnpm --silent test:agent server/src/tests/resourceStore.test.ts server/src/tests/events.test.ts server/src/tests/changeFeed.test.ts src/ts/network/eventFeed.test.ts src/ts/storage/tests/resourceSyncLive.test.ts`
  (Slice 3).
- Probes and drivers as D9 names them, each with its after line in the audit or the investigation.
- Not covered by any gate: Firefox, Safari and mobile runs of the reconnect and the feed (as every earlier
  transport plan), and the owner's two-device check of a long reply watched from a second device.

## Out of scope

- Per-socket subscriptions and per-tab filtering of the feed (a tab still receives every publication's refs).
- A bound on the `hello` snapshots, or on a frame's refs and lock lists (Per-Event Server Work D5).
- Retiring `patch` for `delta` and dropping whole barriers for sockets without `hydration=patch`: D4 records
  the number; the floor and the refusal are a later plan's.
- The chat's summary on the job socket for the owner's own list.
- The provider callback stream (`ChannelChunk`) and its 50 ms coalescing.
- A persisted cursor across tabs or reloads: the cursor lives with the connection; a fresh tab boots with the
  data and takes its first cursor from its first `hello`.

## Later

- The cursor in the boot cache, so a reload after an away-time change replays instead of relisting, if
  `measureBoot.mjs`'s warm boot shows the listing as a remaining share.
- D6 (Slice 4) if Q2 keeps it out, with the numbers that kept it out.
- A `proto` floor with a refusal page, once the diagnostics show no client below it, carrying the Per-Event
  retirements (`patch`, whole barriers) with it.
- Row text deltas on the job socket for rows the owner did not stream (another job's reply in the same chat),
  if the owner patch bytes after Slice 2 still show them.
- Per-socket subscriptions, if a server with many idle tabs measures the refs as a cost.
