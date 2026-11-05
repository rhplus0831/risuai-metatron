# Incremental Chat Transport Plan

Status: drafted 2026-11-03, revised 2026-11-04 after the [design
audit](../audit/plan-design-audit-2026-11-04.md) (its Incremental Chat Transport items TR1–TR5 and the
cross-plan items X1–X4 and X8); landed: 3 (`ca5a5cb8e`), 0 (`f033d69ce`), 1 (`917273384`), 4 (`2272abf6e`), 2 (`f906c864e`). Decisions D1–D10 are recommendations for the owner; the
revision applies the owner's decisions on the audit's corrections, and each changed decision lists its earlier
choice under "Rejected". The **Open questions** Q1–Q4 were answered by the owner on 2026-11-03 (the recommended
option each time); the revision supersedes the answers to Q2 and Q4, as said there. Code anchors re-checked at
`215cbce1d`; verify them again before editing (STRUCTURE.md protocol step 5).

Sources: the owner's 2026-11-03 question about the research items left as "incremental boot and live chat
transport" (an epoch change cursor, message-row deltas, a message-id index); the [server migration
audit](../research/deep-audit-with-fable/server-migration-audit.md) ST03 (the reconnect listing, compression
fixed, the cursor and digest left open), ST04 (feed fallbacks that read a collection or a whole chat; the
summary and `delta` cases fixed, the over-cap case left), SD01 (the streaming checkpoint; the server work fixed,
"the feed patch still carries the whole changed message to every connected feed socket") and SD03 (the
publication budget); the Boot Bytes plan's Q2 and **Later** ("a persisted change log and a `changes?since=`
cursor") and the Per-Event Server Work plan's **Later** ("a by-id read for an over-cap change of a loaded chat",
"a streaming-row text delta on the job socket", "retiring `patch` for `delta` … once an older client can be
refused"), both in [the archive](../archived-plan/README.md) (Remaining Follow-Ups); the [rendering performance
investigation](../research/rendering-performance-investigation.md) F1 (stream ingress after a history-sized
lookup); the [live updates guide](../structure/live-updates.md) (Feed connection, Live updates, Chat live
updates, Limitations), the [resource sync guide](../structure/resource-sync.md) (Transport), the [live-update feed guide](../structure/live-update-feed.md)
(Live-update hello, Frame admission, Own chat changes, Feed chat entries, Publication budget), the
[server generation guide](../structure/server-generation.md) (Job chat and barriers), the
[chat store guide](../structure/chat-store.md) (Job chunks, Summaries and refresh) and the [server resources
guide](../structure/server-resources.md) (Resource routes, Store tables) at `215cbce1d`; the design audit's
[per-plan report](../audit/plan-design-audit-2026-11-04/incremental-chat-transport.md) and [cross-plan
report](../audit/plan-design-audit-2026-11-04/cross-plan.md).

Owning guides when sliced: [live updates](../structure/live-updates.md) (the cursor replay on reconnect, the
new feed entry forms a tab applies, the by-id row read), [live-update feed](../structure/live-update-feed.md)
(`hello.cursor`, the feed entry builder), [server generation](../structure/server-generation.md) (the job
socket's streamed rows and query flags), [server
resources](../structure/server-resources.md) (the change log table, the `since` listing, the row read), [chat
store](../structure/chat-store.md) (the message index, what a streamed row means to the owner),
[persistence](../structure/persistence.md) (the shared types in `shared/resources.ts` and `shared/events.ts`),
[test harness](../structure/test-harness.md) (the drivers and probes the slices change and rerun).

Relation to the other active plans: the [Render Work Budget plan](render-work-budget.md) drops its F1 memo after
the design audit (X3); this plan's Slice 0 owns the message position index (D1). The [Job Handoff
plan](job-handoff.md) adds viewer sockets, `role`, `register` and `clients` to the same sockets (its D2, D3,
D6): this plan adds no frame those need; under it every socket of a job shares the one `sentChat` baseline, and
D3 says what a viewer gets (X2). The [Reroll Candidates plan](reroll-candidates.md) D12 relies on reroll writes
reaching the feed and the job `chatPatch` as any by-id write does; its carrier rows (candidates up to its
per-message cap) change fields other than `data` and can pass 64 KiB, which D2's field diff and D6's row read
are built for (X1). Its Slice 2 depends on this plan's Slice 4 for traffic, not code: the two may be built on
separate branches, its Slice 2 reaches `dev` in the same merge or after it, and that merge runs the
integration checks its **Verification** lists (its D4). The [Asset Lifecycle plan](asset-lifecycle.md) keeps up to 40 snapshots, each of which
physically contains this plan's change log (D5, X8). The files the slices share with those plans are listed
under **Slices**.

## Goal

A tab that is already up to date pays for what changed, not for what it holds:

- **Stream ingress is independent of history length.** Every by-id lookup in the chat store, the stored
  translation lookup and the active streaming row lookup use one validated per-chat index instead of a scan of
  the message array (D1).
- **A streaming reply costs chunk-sized frames on the feed.** Once a reply's row passes `SMALL_FEED_PATCH_BYTES`
  (8 KiB), each checkpoint reaches every other tab as the text added since the previous checkpoint, and the
  final write (which changes `generationInfo`) as a small field diff, not as the whole reply row; below that
  size the row still goes whole, as today, and is already small. So a long reply costs a loaded observer no
  whole read at all when each diff fits the 64 KiB cap (D2). A change to a large field (the Reroll Candidates
  plan's `candidates` array on a carrier) can still pass the cap and falls to D6.
- **The owner is not sent its own reply back.** The job socket's `chatPatch` names a generated row by the stream
  sequence its stored text equals byte for byte, and the owner reconstructs it from the chunks it already holds
  (D3).
- **A reconnect after an away-time change replays the change, not the listing.** The server keeps a bounded,
  epoch-scoped change log; a tab whose `hello` digest does not match asks for the changes between its cursor and
  the `hello` cursor and falls back to the whole listing only when the log no longer covers it (D5).
- **An over-cap change of a loaded chat reads its rows, not the chat** (D6). With reroll carriers on loaded
  chats this is a normal case, not a rare one.

Not goals: per-socket subscriptions or per-tab filtering of the feed; a bound on the `hello` snapshots or on a
frame's refs and lock lists; retiring `patch` for `delta` or dropping whole barriers for sockets without
`hydration=patch` (D4 only records the number such a retirement would need); the chat's summary on the job
socket; the provider callback stream (`ChannelChunk`, cumulative and coalesced at 50 ms in
`src/ts/network/jobChannel.ts`, a different path); characters as a sidebar projection (Boot Bytes Q3); a boot
cache that follows the tab's acknowledged state.

## Current state

The baseline is `215cbce1d` on `dev` (2026-11-04; no code changed since the draft's `39dc41e1f`). This plan does
not re-propose it.

- **Reconnect.** Every live-update connection gets one `hello` with the epoch, the generation locks, the memory
  task statuses and an optional `digest`, built in one synchronous step (`server/src/routes/events.ts:134-161`;
  the digest is `revisionDigest(resources.listRevisions())`, `server/src/app.ts:303-315`,
  `shared/resources.ts:522-529`). The client reconciles from its advertised map when the epoch and digest match,
  else it reads `GET /api/resources/revisions` (`src/ts/network/eventFeed.ts:198-258`; the route at
  `server/src/routes/resources.ts:323-328` answers through `compressedJson`), overlaying the changes that
  arrived while the listing was pending, null rows as tombstones (`eventFeed.ts:75-77`, `:89-109`, `:227-235`),
  and hands the listing to `reconcileRemote` (`src/ts/storage/resourceSync.svelte.ts:4620`). While that listing
  is pending, `receive` keeps applying every `change` frame to the advertised map itself as well as to the
  overlay (`eventFeed.ts:278-281`), so the map moves past the `hello` state during the read. For 300 characters
  and 3,000 chats the listing is 81,504 bytes with zstd, 106,189 with gzip (ST03's after line); an unchanged
  resume costs nothing since the digest. Nothing is replayed: the server has no publication sequence. The epoch
  is checked only by the client (`checkedEpoch`, `src/ts/storage/resourceClient.ts:102`).
- **Where a write's refs are recorded.** `publishing` (`server/src/data/resourceStore.ts:1241-1286`) publishes
  one `change` frame per outermost write after its transactions committed; an independently committed nested
  write's refs merge into the enclosing scope (`:1233-1238`, `:1263-1265`). The refs come from the `record*`
  functions (`recordResource` `:1192`, `recordChat` `:1205`, `recordOrder` `:1217`, `recordCharacterCascade`
  `:1222`) at different points: `applyChangesInScope` records its results after `commitTransaction()`
  (`:1797-1810`), but a character delete's chat and order cascade and a new character's order from inside its
  `results` map, before the commit (`:1750`, `:1768`); `put` and `delete` record inside their transaction
  (`:2417`, `:2434`, `:2461-2464`); a `transaction()` body's writes record inside it and commit in
  `transactionInScope` (`:1823-1860`). Every one of those transactions commits through `commitTransaction()`
  (`COMMIT` at `:1052-1056`, called by `atomically` `:1334`, `applyChangesInScope` `:1797` and
  `transactionInScope` `:1849`), which already keeps per-transaction state (`transactionInvalidations`, `:1012`)
  that `rollbackTransaction()` drops (`:1072`). `writeCount` (`:965-977`) only schedules snapshots. The open
  transaction's normalization, retired-kind deletes and singleton materialization advance revisions with no
  `record*` call (`:967-975`).
- **Schema and epoch.** `STORE_TABLES_SQL` (`:113-124`) runs only when `initialize` finds `user_version === 0`
  (`:3329-3345`), so a table added there never reaches an installed database; the tables added later
  (`chatGroups`, the `memory_*` tables) are created with `CREATE TABLE IF NOT EXISTS` by `openChatSchema` at
  every open (`server/src/data/chatStore.ts:114`, `:163`; called at `resourceStore.ts:976`) and stay outside the
  snapshot layout check (`snapshotTableColumns`, `:3189-3195`). A revision token is `<epoch>:<seq>:<revision>`
  (`:784`), a row's incarnation and write counter, not an order across rows. The epoch is a UUID in `meta`,
  created by `initialize` (`:3338`) and read at open (`:3361`); `replaceAll` writes a new one in the replacement
  transaction, copies only the named tables of the staged file and publishes an `epoch` frame (`:2864-2927`);
  `backupTo` copies the whole file (`:2831`). The client keeps the epoch in `currentEpoch`
  (`src/ts/storage/resourceClient.ts:55-75`) and halts on a mismatch.
- **Feed chat entries.** `chatFeedChange` (`server/src/data/chatStore.ts:1487`) builds a `patch` with the
  changed rows whole (`messages: { after, message }[]`, `shared/resources.ts:389-395`) when it fits
  `MAX_FEED_PATCH_BYTES` (64 KiB, `:422`), else a `delta` whose metadata comes by field (`metaFields`, `:416`)
  with the same rows, else neither; `summary` or `summaryBase` beside it; one publication's optional payloads
  share `MAX_FEED_PUBLICATION_PATCH_BYTES` (256 KiB, `budgetedEntries`, `resourceStore.ts:1161`). The rows are
  the ones stored after the group, never the rows before it: `ChatWriteChange.rows` (`chatStore.ts:403-419`)
  when the write asked for its change, else the lazy `touchedRows` read (`:1469-1473`, used at `:2121-2152`).
  `applyGroup` reads each row it changes once per op (`:1926`). A streaming reply is checkpointed every
  `CHECKPOINT_INTERVAL_MS` (3 s, `server/src/prompt/runner.ts:91`) with a `setText` carrying the whole text so
  far (`:1715-1727`), so every checkpoint publishes the whole reply row to every feed socket: 32,989 bytes of
  feed patch per checkpoint at a 32 KiB reply (SD01's after line), growing with the reply, and nothing once the
  row passes 64 KiB. The final write of a reply is a `setMessage` of the stored row with a new `generationInfo`
  (`writeReplyGenerationInfo`, `runner.ts:1657-1669`), which changes a field other than `data`. A loaded
  observer applies a patch or delta only when idle and held at exactly `baseRevision` (`applyRemoteChatPatch`,
  `src/ts/storage/chatStore.svelte.ts:2581-2597`, the tail rebuilt from the `after` anchors); the client takes
  `delta ?? patch` (`resourceSync.svelte.ts:4578-4579`); an entry without either is a notice, and the idle
  refresh reads the chat whole through `POST /api/resources/read` (`ResourceReadRequest`,
  `shared/resources.ts:219`; the resource sync guide's Limitations: "a reply over `MAX_FEED_PATCH_BYTES` into a
  chat another tab has open costs up to one read per checkpoint"). `readRefs` re-sends the entries a round left
  `unanswered` and throws "The server's read made no progress" when a round does not shrink them
  (`src/ts/storage/resourceClient.ts:294-303`). Messages are rows of their own:
  `messages (chatSeq, id, position, data, generation…)`, primary key `(chatSeq, id)` with `messages_position`
  (`chatStore.ts:67-78`), but no route reads rows by id; `readChat` (`:2616`) selects them all by position.
- **The job socket.** The chunk frame is already a delta: `GenerationChunkEvent` keeps `keep` units of the text
  at `base` and appends `text` (`shared/jobs.ts:227-237`; the server computes the common prefix at
  `server/src/jobs/generationJobs.ts:1400-1431` and sends it to every open owner socket, `:742-760`). The job
  chat is not: `emitRecords` (`:1454-1480`) sends the owner a `chatPatch` at every checkpoint while a socket is
  open, built by `diffChat` (`:579-617`, a pure function of two baselines, with no chunk seq) from the last copy
  a socket took, and that patch carries every row the job began a generation on whole, changed or not
  (`shared/jobs.ts:272-288`): 33,265 bytes per checkpoint at a 32 KiB reply (SD01), beside the chunks that
  carried the same text. That copy, `sentChat`, is one per job (`generationJobs.ts:414`), and `attach` keeps one
  owner socket (`:1949-1956`); on attach the job chat goes before the `accepted` with the current text
  (`:1976-1986`). The checkpoint stores the text the chunk at its `seq` carried (`runner.ts:1715-1727`, from
  `readReply`, `:2133-2164`), but the stored generation counter `generation.seq` counts checkpoints, not chunks
  (`:1716`), and the chunk a write covers is recorded per message as `job.watermarks`
  (`generationJobs.ts:395-396`, set at `:1310-1313`). Later writes of the same generation store processed text
  and claim the same chunk: `runner.ts:945-951` says so, `writeReplyText` writes with that claim (`:1563-1568`),
  and the `editoutput` result is one such write (`:1759-1761`). The callback barrier (`hydrateJobChat`,
  `:1039-1060`) sends nothing while the stored revision is the last copy's. A socket advertises its capabilities
  by query only: `clientId`, `attach`, `liveness=1`, `hydration=patch`
  (`src/ts/network/generationJobs.ts:910-918`, read at `generationJobs.ts:2088-2122`). Neither socket carries a
  protocol number, and nothing refuses or downgrades an older client; a socket without `hydration=patch` gets
  the chat whole (the server generation guide's Limitations). A `chatPatch` goes out through `deliverJobChat`
  and `send` (`:934-943`, `:742-760`) with no byte admission. On the owner, the job chat's `streaming` list sets
  `serverWatermarks` (`src/ts/storage/chatStore.svelte.ts:2275`), and a held stream buffer at or below the
  watermark is skipped, keeping the copy's text (`:2307-2309`), which is right because the copy carried the
  stored row; a stream update at or below the watermark is `older` and not shown (`:1795`, `:1816-1817`).
- **Stream ingress.** `applyServerGeneration` (`chatStore.svelte.ts:1772`) finds the message with
  `message.find((entry) => entry.chatId === update.messageId)` (`:1779`) before deciding whether the update
  waits in `heldStreamText` (`:1692`) for the frame; `showStreamText` finds it again (`:1732`);
  `applyServerGenerationChunk` scans with `some` (`:1844`); job hydration scans twice per streaming entry
  (`:2283`, `:2311`); `indexOfMessage` (`:3156-3158`) scans for its fifteen callers; `applyRemoval` scans
  (`:3488-3491`); `heldMessage` scans for the stored translation of each row
  (`src/ts/translator/storedTranslation.svelte.ts:85`); `activeStreamingIndex` scans once per streaming entry
  change (`src/lib/ChatScreens/Chats.svelte:751-756`). The held chats are `HeldChats` (`:518`) under one
  `$state` (`:535`), each `Chat.message` a plain array in deep state; the per-message maps that exist
  (`serverGenerations` `:444`, `serverWatermarks`, `feedLocks`, `heldStreamText`) are keyed by `messageKeyOf`
  (`:112-113`), not by position, and none is an index of the array. F1 measured 200 synchronous updates to the
  tail at 6.7 ms (100 messages), 111.8 ms (2,000) and 833.1 ms (10,000) with no component mounted (the
  investigation's reproduction, `rendering-performance-investigation.md:347-388`). Rows are replaced, spliced,
  renamed or re-identified in known places: insertion, replacement and eviction (`:1061-1129`, `:7152-7157`),
  `hydrateChat` (`:2107`) through `applyChatHydration` (`:2335-2377`), the patch tail (`:2524-2533`),
  `replaceChat` (`:3895-3913`), append, replace and splice (`:3196`, `:3222`, `:3490-3491`, `:3537`), id
  normalization (`:1355-1364`, applied to held chats at `:4779-4783`) and server renames (`:5426-5437`).
- **Frame types.** Unknown frame types are ignored on both sockets, with no test: `isFrame` checks only that
  `type` is a string (`eventFeed.ts:140-142`), `receive`'s switch has no default (`:260-303`), and neither has
  the job event switch (`src/ts/network/generationJobs.ts:1136-1245`).
- **Tests and probes that exist.** Client: `src/ts/network/eventFeed.test.ts`,
  `src/ts/storage/tests/{resourceSyncLive,resourceSyncFeedPatches,resourceSyncLazyChats,chatStore}.test.ts`
  (`chatStore.test.ts:1979-2048` covers stream coalescing), `src/ts/storage/tests/resourceClient.test.ts` (the
  "no progress" rounds), `src/ts/network/{generationJobs,generationJobsDelta,jobChannelBarrier}.test.ts`,
  `src/ts/translator/storedTranslation.test.ts`. Server:
  `server/src/tests/{events,changeFeed,chatFeedPatches,chatPatch,chatStore,generationBarrier,generationDeltaChunks,resourceStore,resourcesBatch}.test.ts`.
  Probes under `docs/research/deep-audit-with-fable/probes/`: `checkpoint-probe.mjs` (checkpoint phases, feed
  and owner patch bytes, whole-transcript reads as the store's `.all()` calls), `job-channel-probe.mjs`
  (callback barrier frames), `sync-traffic-measure.mjs` (boot, listing and op sizes; no feed). Drivers:
  `util/playwright/measureBoot.mjs` (cold, warm, resume and resume-away boots with the listing's bytes, its
  reads told apart by pathname), `checkLiveUpdates.mjs`, `checkTwoClientSmoke.mjs`, `checkServerSend.mjs`,
  `checkJobProtocol.mjs`, `measureChats.mjs` (a 2,000-message chat streamed 200 chunks, the count fixed at
  `:239`). No e2e spec covers a reconnect; `e2e/lazyChats.spec.ts` streams beside an unloaded chat.

## Decisions

- **D1. One validated message position index per held chat.** `chatStore.svelte.ts` keeps
  `messagePositions: Map<string, Map<string, number>>` (chat key to message id to position), built lazily by one
  pass over `chat.message` the first time a by-id lookup touches the chat, and consulted by a new
  `positionOf(chat, id)` that `indexOfMessage`, `applyServerGeneration`, `showStreamText`,
  `applyServerGenerationChunk`, the two job hydration scans and `applyRemoval` call. A hit is trusted only when
  `chat.message[position]?.chatId === id`; a miss or a mismatch rebuilds the map once and looks up again (then
  `-1`). Ids are unique within a chat (`prepareMessages`, `:1355-1364`), so a stale position can never name
  another row with the same id: correctness does not depend on invalidation, only the rebuild count does. The
  structural paths listed under **Current state** drop the chat's map through one `dropMessagePositions(key)`
  (eviction and whole replacement drop it; append, splice, the patch tail, renames and normalization drop it
  too, a rebuild being cheaper than per-path maintenance); a streaming update touches no structure, so the C
  updates of a reply share one build: O(N + C) in place of O(N × C). Two exports, `heldMessageById(ref, id)` and
  `messagePositionOf(ref, id)`, replace the scans in `storedTranslation.svelte.ts` `heldMessage` and
  `Chats.svelte` `activeStreamingIndex` (the latter keeps its `$derived`, reading the message array so Svelte
  still tracks it). This plan owns the fix of F1: the Render Work Budget plan no longer carries a memo for it
  (X3). Rejected: a map from id to the row object (a `$state` proxy's identity is not the raw row's, and a
  replaced row with the same id would keep serving the old object); maintaining positions on every write path
  (the Render Work Budget plan's objection, which this validated form avoids); the Render Work Budget memo
  alone, or first and removed later (one remembered position does not serve `indexOfMessage`, the translation
  lookup or hydration, and two forms of one lookup would race to land).
- **D2. A feed entry can carry a per-row field diff.** `ChangeSet.chats[]` gains a third optional payload,
  `rowDelta?: ChatRowDeltaBody`: a `ChatDeltaBody` (metadata by field, `removed`, `count`, changed rows whole in
  `messages`) plus `rowDiffs`, one `{ id, fields?, text? }` per diffed row. A row is diffed when it existed
  before the group and its position and neighbours are unchanged; its entry carries
  `fields: { set: Partial<row>, unset: string[] }` for the top-level message fields other than `data` that
  changed (`set` holds the new values whole, `unset` the names gone: the shape of a `patchMessage` op) and, when
  `data` changed, `text: { keep, text }`: the common prefix of the stored text before and after the group as the
  chunk's `keep` (`server/src/jobs/generationJobs.ts:1409-1421`), and the rest. Every other changed row stays
  whole in `messages`. The "before" text and fields are the row as first read in the group, where `applyGroup`
  reads it to apply its op (`server/src/data/chatStore.ts:1926`); a group with several ops on one row keeps that
  first read. Today `chatFeedChange` receives only the rows after the group, so the builder's input grows by the
  first read of each touched row, never a chat read; the cost is one JSON parse of each side of a diffed row
  (the `patch` already parses the after side, `:1551`). Selection order: `patch` whenever the whole-row patch is
  under `SMALL_FEED_PATCH_BYTES` (8 KiB, named in `shared/resources.ts` beside `MAX_FEED_PATCH_BYTES`), since
  rows that small gain nothing from a diff and every client applies a `patch` today; above it, `rowDelta` when
  it fits `MAX_FEED_PATCH_BYTES` and is smaller than the whole-row `patch`; else `patch` when it fits; else
  `delta`; else none (D6). The server sends at most one of the three bodies, and the client applies the one
  present (`noteRemoteChanges` reads `rowDelta ?? delta ?? patch`); `applyRemoteChatPatch` applies `rowDiffs`
  under its existing conditions (loaded, idle, not stale, held at exactly `baseRevision`, which guarantees the
  row before) plus `message.data.length >= keep` for a text diff; any other case is a miss and takes the
  ordinary notice and idle refresh as a misfit patch does today. The effect on a streaming reply: once its row
  passes 8 KiB, each checkpoint's payload is the text added since the previous one (bytes of 3 s of streaming)
  whatever the reply's length, and the final write, which changes only `generationInfo`
  (`server/src/prompt/runner.ts:1657-1669`), is a field diff of that one field instead of a whole row; so a long
  reply costs a loaded observer no whole read at all when each diff fits, and the ST04 leftover ("a reply over
  64 KiB into a chat another tab has open") no longer occurs for replies. What can still pass the cap: a change
  to a large field (the Reroll Candidates plan's `candidates` array on a carrier, set whole when a reroll
  begins, ends or switches), a processed rewrite with no shared prefix of a reply past 64 KiB, and one write
  that changes more than 64 KiB of rows; those fall to D6. Why a third field and not a field on `delta`: an
  older client applies a `delta` it understands by its known fields and advances its revision; a `delta` whose
  only change were in a field it ignores would leave it silently behind. It never applies a `rowDelta`, so it
  takes the notice and reads (D8 says what that costs it). Rejected: `patch` first, then `rowDelta` for rows
  changed only in `data`, then `delta` (the 2026-11-03 choice: every reply under 64 KiB, SD01's 32 KiB fixture
  among them, kept sending the whole row each checkpoint, the final `generationInfo` write and every reroll
  write went whole, and preferring `rowDelta` over `delta` already cost an older tab its `delta`, so neither the
  Goal nor "never regresses" held: TR4, X1); `patch`, then `delta`, then `rowDelta` (additive for an older tab,
  but the saving starts only past 64 KiB); `rowDelta` whenever it is smaller, at any size (an older tab would
  read whole for every small write, for no saving worth having); stripping `candidates` from feed rows (a feed
  row replaces the held row, so the field would be lost: RC6); raising the 64 KiB cap; sending the ops (a stale
  group merges onto the stored base and normalization rewrites the result, the reason `delta` diffs stored
  metadata rather than ops).
- **D3. The owner's `chatPatch` names streamed rows.** `GenerationChatPatchEvent.messages[]` entries may be
  `{ after, id, streamed: { generationId: string; seq: number } }` for a row the job began a generation on whose
  stored `data` is byte-equal to the raw stream text at `seq` and whose other fields equal the base copy's
  (`sentChat`). Only a raw checkpoint qualifies: a processed write (`editoutput` and the later writes of the
  reply) claims the same chunk with other text (**Current state**), so the chunk coverage the server keeps is
  not proof of equality. The write's cover gains a mark that the write stored the raw stream text at that `seq`
  (the checkpoint's cover has it, a processed write's does not), the watermark keeps the mark, and the server
  takes `seq` only from a watermark with that mark; a processed row goes whole even when its other fields are
  unchanged. `chatPatchEvent` turns the rows `diffChat` carries into `streamed` entries from the job's
  watermarks, only for rows present in `sentChat` and only for a socket that attached with `rows=streamed` (a
  WeakSet flag beside `hydration=patch`, `generationJobs.ts:670-676`). The owner (`hydrateChatPatch`,
  `applyChatPatch`) applies a `streamed` row only when it holds that generation (`serverGenerations`) and its
  buffer seq is at or above the watermark the entry's `streaming` list names: at equality it installs the buffer
  text into the row (today's skip at `chatStore.svelte.ts:2307-2309` would keep whatever text the held row had);
  above it the existing rule shows the buffer. Below it, and for a generation the tab does not hold at all (the
  placeholder `seq: -1` case, a retired generation), it asks `ChatResyncRequest` and does not advance the row,
  its revision or the watermark (`:2275`): advancing them would leave stale text at a revision that claims the
  stored text, and the `accepted` at the watermark that follows would be `older` and not shown (`:1795`,
  `:1816-1817`). The job's chat snapshot precedes `accepted` on attach (`generationJobs.ts:1976-1986`), so an
  owner that reconnects after missing a checkpoint's chunks resyncs once: one whole chat per such reconnect, not
  per checkpoint. The streamed form and `sentChat` concern the owner socket: `sentChat` is one per job and today
  the job has one owner socket. Under the Job Handoff plan every socket of a job shares that one baseline and
  gets the same patch; the server renders `streamed` entries only for the owner socket, and a viewer socket,
  with the flag or without, gets those rows whole, since it cannot be assumed to hold the stream they are
  rebuilt from (X2). Expected saving: the 33,265-byte owner patch per checkpoint becomes a few hundred bytes;
  the barrier and the callback receipts are unchanged (the receipt still names the revision the patch reached).
  Rejected: keeping the held row and letting the existing watermark rule decide the text (the 2026-11-03 choice:
  an owner whose buffer is behind the watermark keeps stale text while its revision and watermark claim the
  stored text, TR5); taking `seq` from `job.watermarks` alone (a processed write's claim would put raw text over
  the processed output); dropping the per-checkpoint `chatPatch` altogether (its `streaming` list and revision
  are what let the owner skip the barrier read).
- **D4. A protocol number both sockets read.** The live-update socket URL and the job socket URL gain `proto=1`;
  the server records the number per socket (and, for the job socket, in the job's socket flags) and refuses
  nothing. It is the "demonstrated compatibility boundary" the Per-Event Server Work plan asked for before
  retiring `patch` or whole barriers: a later plan can set a floor and measure which clients are below it from
  the diagnostics. Capability flags stay additive (`rows=streamed` in D3): a number without a floor changes no
  behaviour, and a flag tells the server exactly which form a socket takes. Q3 answered: the number is added
  now, in Slice 2.
- **D5. A bounded, epoch-scoped change log and a cursor.** `resources.sqlite` gains a `changes` table: `cursor`
  (`INTEGER PRIMARY KEY AUTOINCREMENT`), `kind`, `characterId`, `id` and `revision`, one row per ref a write
  commits (records as `kind`, chats as `chats` with `characterId`, orders as `chatOrders`), `revision` null for
  a deletion. The table is created with `CREATE TABLE IF NOT EXISTS` at every open, beside `openChatSchema`
  (`resourceStore.ts:976`) and before any statement that names it is prepared, outside `STORE_TABLES_SQL` and
  outside the snapshot layout (`snapshotTableColumns`), as `chatGroups` and the `memory_*` tables are; no schema
  version bump. The rows come from a per-transaction accumulator kept beside `transactionInvalidations` and fed
  by the `record*` functions themselves (`recordResource`, `recordChat`, the order and cascade records; their
  call sites are `:1750`, `:1768`, `:1797-1810`, `:2417`, `:2434` and `:2461-2464`), with
  `applyChangesInScope`'s calls moved from after its `commitTransaction()` to before it. `commitTransaction()`
  inserts the accumulated rows right before its `COMMIT` (`:1052-1056`) and `rollbackTransaction()` drops them,
  so every path (`applyChangesInScope`, `put`, `delete`, `transaction()`, a character delete's chat and order
  cascade, a new character's order) logs in its own transaction, a rollback drops its rows, a cursor never names
  a change that did not commit, and a commit never lacks its rows. Nested publications that `publishing` merges
  into an enclosing scope (`:1233-1238`, `:1263-1265`) committed in their own transactions and logged there,
  once; the merge joins only their refs for the frame, and a failed enclosing write neither repeats nor rolls
  back their rows. The table is truncated in `replaceAll`'s transaction (a new epoch starts at an empty log) and
  pruned on write to the newest 20,000 rows (Q1). A restore never brings a log back (`replaceAll` copies only
  the named tables), but a whole-file snapshot (`backupTo`) still physically contains it: up to about 4 MB at
  the 20,000-row bound, so the Asset Lifecycle plan's worst case of 40 snapshots holds up to about 160 MB of
  logs (X8), a size to count there and no restore concern. Writes the store makes at open (normalization,
  retired-kind deletes, singleton materialization, `:967-975`) bypass the log, so the first resume after a
  server upgrade that rewrote anything fails the digest check below and reads the listing, once and safely. The
  cursor is the newest `cursor` value. `hello` gains `cursor`, sampled in the same synchronous step as the
  digest; every `change` frame gains `cursor` (the newest log row of the refs it carries, nested commits
  included) so a connected tab's cursor stays current without a listing.
  `GET /api/resources/revisions?since=<cursor>&until=<cursor>&epoch=<epoch>` answers
  `{ epoch, cursor, changes }` with the rows `since < cursor <= until` coalesced per key to the newest revision
  or tombstone, in `ChangeSet` shape without payloads (`cursor` is `until`), or
  `{ epoch, cursor, expired: true }` when `since` is below the oldest retained row or either bound is unknown. A
  request whose `epoch` is not the store's is answered with the store's epoch and no changes, which the client's
  `checkedEpoch` turns into the epoch mismatch the listing already raises (`replaceAll`'s `DELETE` keeps
  `AUTOINCREMENT` counting, so without the epoch an old epoch's cursor could look valid). The client
  (`reconcile`): digest matches, as today; else, with an advertised map of the loaded epoch and a held cursor,
  it freezes a copy of the advertised map and the held cursor when `hello` arrives, before any later frame, and
  reads `?since=<held cursor>&until=<hello.cursor>`. It replays the answer into the copy only (tombstones kept),
  compares `revisionDigest` of the copy with `hello.digest`, and on a match reconciles from the copy (the memory
  fences take it as the `hello`-time listing, every recreated row at its final revision); only then does it
  overlay the frames that arrived after `hello`, which `receive` keeps applying to the live map and which
  already need their own overlay on top of a fetched snapshot (`seedAdvertised` with the listing overlay,
  `eventFeed.ts:227-235`): the copy takes them the same way. `expired`, a digest that still differs (a gap the
  log cannot explain) or no held cursor reads the whole listing as today. After any reconcile the held cursor is
  the newest of `hello.cursor` and the cursors of the frames applied since. The replay carries refs only:
  `hello` already replaces the lock and memory task sets whole, and payloads were never replayed. Expected
  saving: the 81 KB zstd listing after an away-time change becomes the handful of refs that changed, on every
  resume after 30 s hidden, `resume` and `online`, also while another device is streaming. Rejected: inserting
  the rows from `results`, `chatOutcome.results` and `chatOutcome.orders` before `applyChangesInScope`'s commit
  (the 2026-11-03 choice: it covers one of four write paths and misses the cascades and new orders, so every
  replay after a `put`, a `delete` or a `transaction()` fails the digest, TR1); the table in `STORE_TABLES_SQL`
  (the 2026-11-03 choice: it never exists on an installed database and every write there would fail, while fresh
  test stores pass, TR2); an unbounded replay checked against the live map (the 2026-11-03 choice: any write
  between `hello` and the answer, a 3 s checkpoint on another device enough, moves the map past `hello.digest`
  and forces the listing, TR3); an `until` bound applied to the live map (the map itself moves); feeding the log
  from the outer publication accumulator (it merges independently committed nested work, whose rows would be
  duplicated or rolled back with a failed enclosing write); logging the open-time writes (an upgrade's
  normalization can touch every record, more rows than the bound keeps); numbering publications in memory (lost
  on restart, when every tab reconnects at once and needs it most); logging payloads (the log would be a second
  copy of the data on the hottest write path, the reason Boot Bytes Q2 deferred it); a per-tab cursor on the
  server (the server keeps no per-tab state on the feed).
- **D6. An over-cap entry names its rows; a loaded chat reads them by id.** When no body fits, the entry carries
  `rows: { changed: string[]; removed: string[]; count: number; meta: string[] }` with the entry's `baseRevision`
  (ids and names only, the information `chatFeedChange` already holds): `meta` names the top-level metadata
  fields the group set, removed, merged or merge-unset, empty when none. A loaded, idle chat held at exactly
  `baseRevision` reads the changed rows through a new `chatRows` entry of `POST /api/resources/read`
  (`{ characterId, id, revision, messageIds, meta }`, answered as `{ revision, rows: { id, after, message }[],
metaFields? }` at that revision, where `metaFields` sets each named field whole to its stored value at that
  revision, or removes it when the stored metadata lacks it; a merge key such as `scriptstate` goes whole), and
  applies rows and metadata together with `removed` and `count` as a patch; every other case (not loaded,
  not idle, another revision) reads the chat whole as today. The metadata ride along because the Reroll
  Candidates plan's begin group and candidate switch change `candidates` and `scriptstate` in one write: a
  manifest naming metadata that fell to a whole read would make every reroll on a loaded observer a whole
  read, which is the traffic this slice removes. The fields go by name, not as the `delta` diff from the base,
  because the server keeps no metadata before the write: the diff exists only inside the write's transaction
  (`chatMetaFields`, `server/src/data/chatStore.ts`), so a read cannot rebuild it (2026-11-05, Slice 4's
  challenge). When the chat moved on past `revision`, the answer is a distinct `{ moved: true }` entry with the
  current revision, never `unanswered`, which `readRefs` re-sends and then fails as "no progress", failing every
  other entry of that read with it; a `moved` answer makes the client read the chat whole once. The server
  selects by the `(chatSeq, id)` key and `messages_position` for `after`. Not gated: after D2, an over-cap entry
  needs one write to change more than 64 KiB of rows or of one field, and the Reroll Candidates plan's carrier
  rows (candidates up to its per-message cap, the array set whole at each begin, end and switch) make that a
  normal case on a loaded chat, so Slice 4 is scheduled after Slice 1 unconditionally (Q2's answer superseded).
  Rejected: answering a moved chat as `unanswered` (the 2026-11-03 choice: `readRefs` throws before any
  whole-chat fallback); `meta: boolean` answered with `metaFields` as the diff from the base (the second
  2026-11-04 text: the server cannot compute that diff at read time); the stored metadata whole in every
  answer (simpler, but a reroll would carry `hypaV3Data` and every other large field each time); the feed's
  `metaFields` in the manifest when it fits (two paths, and a whole read when it does not); a row read only
  for `meta: false` manifests, whole read otherwise (the first 2026-11-04
  text: a reroll's begin group always changes the metadata too, so the reroll plan's dependency on this slice
  would have been empty); gating the slice on the over-cap share Slice 1 measured (the 2026-11-03 Q2 answer:
  reroll carriers make the case routine, and the probes had no input for the gate, D9).
- **D7. Caps and budgets are unchanged.** `MAX_FEED_PATCH_BYTES`, `MAX_FEED_PUBLICATION_PATCH_BYTES`, the 4 MiB
  socket admission and `MAX_REMOTE_READS` stay. `rowDelta` and the `rows` manifest are optional feed payloads
  measured and dropped by `budgetedEntries` like the others (`resourceStore.ts:1161-1186`, run only in the
  feed's `publishing`); refs, orders and lock lists are never dropped. `streamed` entries are on the job socket
  and never pass `budgetedEntries`: a job `chatPatch` goes through `deliverJobChat` and `send`, which have no
  byte admission today. What bounds them instead: a `streamed` entry is a few hundred bytes in place of a whole
  row, so it only shrinks the frame, and a row that does not qualify goes whole as today.
  `SMALL_FEED_PATCH_BYTES` (D2) is a selection threshold, not a cap: it never drops a payload. Coalescing
  (`coalescedChat`, `resourceStore.ts:437`) treats `rowDelta` and `rows` as it treats `patch` and `delta`: the
  later entry without any of them.
- **D8. Compatibility is additive on every path but one.** An older tab ignores `rows`, `cursor` and `proto`,
  never receives `streamed` rows (it sends no `rows=streamed`), and gets the listing it asks for without
  `since`; an older server (a newer tab against it) sends none of the new fields (no `hello.cursor`, so the tab
  never asks `?since=`) and the tab behaves as today. The one non-additive path is `rowDelta`: the server sends
  one body, and a tab older than this change (one between a deploy and its reload) takes only `delta ?? patch`,
  so an entry that now carries `rowDelta` in place of the `patch` or `delta` it would have applied takes the
  notice and a whole read for that entry until the tab reloads. Because `patch` stays the form for every
  whole-row patch under `SMALL_FEED_PATCH_BYTES` (D2), that happens only for entries whose whole-row patch is
  over 8 KiB (a long reply's checkpoints, a large edit, row data changed beside oversized metadata): one whole
  read per such entry until the tab reloads, and never for small writes. It is accepted because tab and server
  ship together and the window is one deploy to one reload. `shared/events.ts` and `shared/resources.ts`
  document each field as optional. Unknown frame types stay ignored on both sockets (`isFrame`,
  `eventFeed.ts:140-142`; `receive` with no default, `:260-303`; the job event switch,
  `src/ts/network/generationJobs.ts:1136-1245`); Slice 3 adds the test, since none covers it today (X4).
- **D9. Measurements are part of done, from the pinned baseline.** Each slice reruns the probe or driver it
  changes and records an after line in the audit with the same fixture. None of them measures what the slices
  need today, so each slice first changes its probe: `checkpoint-probe.mjs` (Slices 1 and 2) writes a different
  32 KiB text per checkpoint (`docs/research/deep-audit-with-fable/probes/checkpoint-probe.mjs:10-11`, so there
  is no shared prefix) and throws when an entry has no `patch` (`:353`); it gains an appending-text fixture
  (each checkpoint the previous text plus about 3 s of streaming, run past 64 KiB, then the final
  `generationInfo` write) for the feed and owner bytes per checkpoint, and it counts the whole-chat reads of a
  loaded observer, not the store's `.all()` calls (`:27-29`). `sync-traffic-measure.mjs` (Slices 1 and 4) has no
  feed and no mixed workload; it gains a feed observer and a mixed write fixture (checkpoints, edits, a large
  paste, an import's rewrite, a reroll carrier's `candidates` change) before it can count over-cap entries.
  `util/playwright/measureChats.mjs` (Slice 0) hard-codes 2,000 messages (`:239`); it takes the count as a
  parameter, and the F1 comparison is against its own before line at 2,000 and 10,000 messages, not against the
  investigation's store-level reproduction. `util/playwright/measureBoot.mjs` (Slice 3) counts reads by pathname
  (`:1368`); its resume-away case counts `?since=` apart from the listing and records the reconnect time.
- **D10. Tests count, never time** (V3). The index test counts rebuilds and lookups through a counter the store
  exposes for its tests (as `lockState.version` is read today), for updates to the tail of a 100- and a
  10,000-message history, several updates before one frame, a splice between updates and a chat replacement
  between updates; the feed tests assert payload bytes and forms on fixed fixtures; the cursor tests drive the
  log with a fake clock and a test-only retention, and hold the `?since=` answer on a deferred to place frames
  before it; no test asserts elapsed time.

## Open questions

All four were answered on 2026-11-03 with the recommended option; they are kept here as the record of why. The
2026-11-04 revision supersedes the answers to Q2 and Q4, as said under each.

- **Q1. Change log retention.** Answered: keep the newest 20,000 rows, pruned in the write that passes the bound
  (a row is under 200 bytes: 4 MB at most, and a replay of 20,000 refs is already the size of a listing, so a
  longer log saves nothing). Alternative: an age bound (7 days), which lets a quiet server keep a tiny log but
  makes the fallback depend on the clock. The 4 MB is also copied into every whole-file snapshot (D5, X8).
- **Q2. Whether D6 ships.** Answered: gated. Slice 1's after lines count over-cap entries in
  `sync-traffic-measure.mjs`'s fixture and in a long-reply run of `checkpoint-probe.mjs`; Slice 4 is scheduled
  only if any remain in the reply case or they exceed 1% of entries in the mixed fixture, else D6 moves to
  **Later** with the numbers. Alternative: ship it unconditionally, since the row read is small and the whole
  read it replaces can be megabytes. Superseded on 2026-11-04: the Reroll Candidates plan's carrier rows make an
  over-cap entry on a loaded chat a normal case, and neither probe could produce the gate's numbers (D9), so
  Slice 4 is scheduled unconditionally after Slice 1 (D6).
- **Q3. The protocol number now.** Answered: yes, `proto=1` on both sockets in Slice 2, read and logged, never
  enforced; the Per-Event retirements then have their boundary without another protocol change. Alternative:
  leave it to the plan that first needs a floor.
- **Q4. Which rows get text deltas.** Answered: every row whose stored JSON changed only in `data`, whatever op
  changed it (a `setText` checkpoint, a user's edit through `setMessage` or `patchMessage`), since the server
  compares stored rows and the prefix scan costs one pass over the row. Alternative: generation `setText` rows
  only, which keeps user edits whole and the builder smaller. Superseded on 2026-11-04 by D2's per-row field
  diff: every row whose position and neighbours are unchanged, whatever top-level fields changed, since the
  final `generationInfo` write and every reroll write change fields other than `data`.

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Shared files inside
this plan: Slices 0, 1, 2 and 4 edit `src/ts/storage/chatStore.svelte.ts`; Slices 2 and 3 share
`server/src/routes/events.ts`, `src/ts/network/eventFeed.ts` and the server generation guide; Slices 1, 3 and 4
share `shared/resources.ts`, and Slices 1 and 3 also `server/src/data/resourceStore.ts`; Slices 3 and 4 share
`server/src/routes/resources.ts` and `src/ts/storage/resourceClient.ts`; Slice 4 needs Slice 1 and shares most
of its files. Only Slices 0 and 3 touch disjoint files. Shared with other active plans, and not run in parallel
with them: Job Handoff Slice 1 (`server/src/jobs/generationJobs.ts`, `shared/jobs.ts`,
`server/src/routes/events.ts`, `shared/events.ts`, `server/src/app.ts`) and Slice 3
(`server/src/routes/events.ts`, `shared/events.ts`, `src/ts/network/eventFeed.ts`) against Slices 2 and 3; Job
Handoff Slice 2 (`src/ts/network/generationJobs.ts`, the same socket URL line as Slice 2, and
`src/ts/network/eventFeed.ts`) against Slices 2 and 3; Reroll Candidates Slice 1 (`shared/jobs.ts`,
`server/src/jobs/generationJobs.ts`, `server/src/prompt/runner.ts`) against Slice 2 and (`server/src/routes/events.ts`,
`shared/events.ts`: its `rerollInPlace` field on `hello`) against Slice 3, and its Slice 2
(`src/lib/ChatScreens/Chats.svelte`) against Slice 0; Asset Lifecycle Slice 3 (`shared/resources.ts`,
`src/ts/storage/resourceClient.ts`) against Slices 1, 3 and 4.

### Slice 0: the message position index (D1, D9, D10; needs nothing)

Files: `src/ts/storage/chatStore.svelte.ts` (`messagePositions`, `positionOf`, `dropMessagePositions` at the
structural sites listed under **Current state**, the two exports, the scans replaced),
`src/ts/translator/storedTranslation.svelte.ts` (`heldMessage` through `heldMessageById`),
`src/lib/ChatScreens/Chats.svelte` (`activeStreamingIndex` through `messagePositionOf`),
`util/playwright/measureChats.mjs` (the message count as a parameter, D9), the chat store guide (By-id ops, Job
chunks: the index and its validation). This slice owns the message position index; the Render Work Budget plan
has no F1 memo to remove.

- Tests (`src/ts/storage/tests/chatStore.test.ts`, `src/ts/translator/storedTranslation.test.ts`): the counter
  cases of D10; a lookup after a splice, a rename, normalization of a new character and a server rename answers
  the right row with exactly one rebuild; a lookup of a removed id is `-1`; `heldMessage` and the active
  streaming index are unchanged in `Chat.settledRender.svelte.test.ts` and `chatStatus.test.ts`.
- Measurement: `measureChats.mjs` at 2,000 and 10,000 messages, 200 chunks, before and after the slice (its own
  before line at each count, D9); the investigation's F1 section gets an after line.

### Slice 1: row field diffs on the feed (D2, D7, D8, D9; needs nothing)

Files: `shared/resources.ts` (`ChatRowDeltaBody`, `ChangeSet.chats[].rowDelta`, `SMALL_FEED_PATCH_BYTES` beside
`MAX_FEED_PATCH_BYTES`, the one-body rule, the cap comment), `server/src/data/chatStore.ts` (the first read of
each touched row in `applyGroup`, `chatFeedChange`'s `rowDiffs` and the selection order, `ChatFeedPayloads`),
`server/src/data/resourceStore.ts` (`budgetedEntries` and `coalescedChat` for the third payload),
`src/ts/storage/resourceSync.svelte.ts` (`noteRemoteChanges`: the body present),
`src/ts/storage/chatStore.svelte.ts` (`applyRemoteChatPatch`: `rowDiffs`), `checkpoint-probe.mjs` and
`sync-traffic-measure.mjs` (D9's fixtures and counts), the server generation guide (Feed chat entries,
Publication budget), the resource sync guide (Chat live updates, Limitations: the over-cap sentence rewritten),
the chat store guide (Summaries and refresh).

- Tests, server (`server/src/tests/chatFeedPatches.test.ts`, `chatStore.test.ts`, `resourceStore.test.ts`): a 4
  KiB checkpoint publishes `patch` (under `SMALL_FEED_PATCH_BYTES`); a `setText` checkpoint of a 100 KiB reply
  publishes a `rowDelta` with the appended text and no `patch`; a checkpoint of a 32 KiB reply publishes a
  `rowDelta` too, smaller than its `patch`; the final `generationInfo` write of a 100 KiB reply publishes a
  `rowDelta` whose entry carries `generationInfo` in `fields.set` and no text, not the whole row; a
  `patchMessage` that removes a field lists it in `unset`; a row whose role and text changed carries both in one
  entry; two ops on one row in one group diff against the row as first read; an inserted row goes whole; a
  rewrite with no shared prefix is as large as the row and the entry takes `patch` when that fits; a changed
  field over the cap gives no body; every entry carries at most one of `patch`, `delta` and `rowDelta`; the
  publication budget drops a `rowDelta` as it drops a `patch`; coalescing keeps the later entry without it.
- Tests, client (`src/ts/storage/tests/resourceSyncFeedPatches.test.ts`, `resourceSyncLazyChats.test.ts`,
  `chatStore.test.ts`): a loaded idle chat at the base applies `rowDiffs` (appended text, a set field, a removed
  field) with no read; a chat held at another revision, a row shorter than `keep`, a missing row and a non-idle
  chat each take the notice and one idle read; an unloaded chat is unaffected (summary knowledge as today); an
  entry carrying only `rowDelta`, only `delta` or only `patch` applies that body.
- Measurement: `checkpoint-probe.mjs` with the SD01 fixture and D9's appending-text fixture past 64 KiB: feed
  bytes per checkpoint and of the final write, and whole-chat reads of a loaded observer, before and after;
  `sync-traffic-measure.mjs` with D9's feed observer and mixed fixture: the over-cap entries, the before line of
  Slice 4.

### Slice 2: streamed rows on the job socket, the protocol number (D3, D4, D8, D9, Q3; needs nothing)

Files: `shared/jobs.ts` (the `streamed` row form, the query flags documented),
`server/src/jobs/generationJobs.ts` (`rows=streamed` and `proto` in `handleUpgrade`, the watermark's raw-text
mark, `chatPatchEvent` emitting `streamed` rows for the owner socket with the flag),
`server/src/prompt/runner.ts` (the checkpoint's cover marked as the raw stream text; the processed writes'
covers not), `server/src/routes/events.ts` (`proto` read and logged), `src/ts/network/generationJobs.ts` (the
socket URL), `src/ts/network/eventFeed.ts` (the socket URL), `src/ts/storage/chatStore.svelte.ts`
(`applyChatPatch` and `hydrateChatPatch`: the held generation and buffer seq checked before any row, revision or
watermark changes; the buffer text installed at the watermark; the resync below it), `checkpoint-probe.mjs` (the
owner bytes on the appending fixture), the server generation guide (Job chat and barriers, Generation channels,
Limitations), the chat store guide (Job chunks, Job hydration).

- Tests, server (`server/src/tests/chatPatch.test.ts`, `generationBarrier.test.ts`,
  `generationDeltaChunks.test.ts`): a checkpoint's `chatPatch` to a `rows=streamed` socket names the reply by
  `generationId` and `seq` and carries the user message whole; a socket without the flag gets the row whole;
  after the `editoutput` write (processed text claiming the same chunk) the row goes whole although its other
  fields are unchanged; a generated row whose role or name changed goes whole; the barrier receipt names the
  same revision either way; `proto` is recorded and a socket without it is served as before.
- Tests, client (`src/ts/network/generationJobs.test.ts`, `jobChannelBarrier.test.ts`,
  `src/ts/storage/tests/chatLock.svelte.test.ts`): a streamed row with the buffer above the watermark shows the
  buffer; at the watermark the row takes the buffer text, also when the held row's text was older; with the
  buffer below the watermark (an owner that reconnected after missing chunks) it asks `resync` once, leaves the
  row, its revision and the watermark as they were, and the `accepted` at the watermark that follows shows its
  text; a streamed row of a generation the tab does not hold asks `resync` once; the barrier passes without a
  read after the patch.
- Measurement: `checkpoint-probe.mjs` owner `chatPatch` bytes per checkpoint on the appending fixture;
  `job-channel-probe.mjs` unchanged frame counts.

### Slice 3: the change log and the cursor (D5, D7, D8, D9, Q1; needs nothing)

Files: `server/src/data/resourceStore.ts` (the `changes` table created at open, the per-transaction accumulator
fed by the `record*` functions, `applyChangesInScope`'s records before its commit, the insert in
`commitTransaction()` and the drop in `rollbackTransaction()`, pruning, truncation in `replaceAll`,
`listChanges(since, until)`, `cursor()` sampled with the digest, the publication's cursor on the `change`
frame), `server/src/routes/resources.ts` (`since`, `until`, `epoch`), `server/src/routes/events.ts`
(`hello.cursor`, `change.cursor`), `server/src/app.ts` (wiring), `shared/resources.ts` (`ResourceChangesSince`),
`shared/events.ts` (the two fields), `src/ts/network/eventFeed.ts` (the held cursor, the copy frozen at `hello`,
the bounded `?since=` read, the digest check on the copy, the overlay after it, the fallbacks),
`src/ts/storage/resourceClient.ts` (`listChanges`), `util/playwright/measureBoot.mjs` (D9's change), the server
resources guide (Resource routes, Store tables), the resource sync guide (Feed connection), the server
generation guide (Live-update hello).

- Tests, server (`server/src/tests/resourceStore.test.ts`, `events.test.ts`, `changeFeed.test.ts`): every
  committed ref is one log row on each path: `applyChanges`, a `put` (with a new character's order), a `delete`
  of a character with chats (its chat and order tombstones) and a `transaction()` body's writes; a rolled-back
  `transaction()` and a conflicting `applyChanges` leave none; a nested publication merged into an enclosing
  write logs its rows once, also when the enclosing write then fails; a store file at the current schema version
  created without the table opens, gains it and accepts writes; the open-time normalization writes no row; a
  deletion is a tombstone; a recreated chat replays at its newest revision only; `until` bounds the answer;
  `since` past the retention answers `expired`; a request of another epoch is answered with the store's epoch;
  `replaceAll` empties the log and a snapshot's log is not restored; `hello` and `change` carry the cursor the
  log holds at that step; the retention prunes at the bound (test-only limit).
- Tests, client (`src/ts/network/eventFeed.test.ts`, `src/ts/storage/tests/resourceSyncLive.test.ts`): a `hello`
  with a matching digest reads nothing; a mismatching digest with a cursor reads `?since=` bounded by
  `hello.cursor` and reconciles from the copy with no listing; a `change` frame that arrives while that read is
  pending still reconciles from the copy with no listing and is on the advertised map afterwards; `expired` and
  a digest that still differs after the replay read the listing once, and an epoch mismatch halts as the
  listing's does; a replayed deletion removes the held row and a replayed recreation does not release the memory
  fence of the older incarnation; a frame's cursor advances the held cursor; no cursor (first connection) reads
  the listing; a frame of an unknown type is ignored on the live-update socket and on the job socket
  (`src/ts/network/generationJobs.test.ts`).
- Measurement: `measureBoot.mjs` resume-away with D9's change (the `?since=` read apart from the listing, its
  bytes, and the reconnect time after a change made while hidden), before and after; `checkLiveUpdates.mjs` and
  `checkTwoClientSmoke.mjs` runs.

### Slice 4: the over-cap row manifest and the by-id row read (D6, D7, D8; needs 1)

Files: `shared/resources.ts` (`ChangeSet.chats[].rows`, `ResourceReadEntries.chatRows`, the answer with its
`moved` form), `server/src/data/chatStore.ts` (the manifest in `chatFeedChange`, `readRows` with the metadata fields),
`server/src/routes/resources.ts` (the read entry under the read budget), `src/ts/storage/resourceClient.ts`
(`readRefs` with `chatRows`; `moved` is an answer, not `unanswered`), `src/ts/storage/resourceSync.svelte.ts`
and `src/ts/storage/chatStore.svelte.ts` (the row read in place of the whole read for a loaded chat at the base;
a `moved` answer reads the chat whole once), the resource sync guide (Chat live updates, Transport), the server
resources guide (Resource routes, Read budget).

- Tests (`server/src/tests/chatFeedPatches.test.ts`, `resourcesBatch.test.ts`,
  `src/ts/storage/tests/resourceClient.test.ts`, `resourceSyncFeedPatches.test.ts`): an over-cap entry carries
  the manifest and no payload; a loaded chat at the base reads the named rows once and applies them; a row with
  a field over the cap (a reroll carrier's `candidates` as a fixture) is read by id; a chat that moved on is
  answered `moved` and the client reads it whole once, with `readRefs` not failing as "no progress", also when
  the read carries other entries; a manifest naming `scriptstate` (a reroll begin group fixture: `candidates`
  plus a `scriptstate` merge in one write) is answered with the rows and `scriptstate` whole in `metaFields` and
  applied without a whole read; a named field the stored metadata lacks is removed;
  the read budget counts rows; an older client (no `chatRows`) reads whole as today.
- Measurement: Slice 1's `sync-traffic-measure.mjs` line rerun with the same fixture: the over-cap entries
  become row reads.

### Slice 5: the browser checks and the final guide pass (needs 3 and 4)

- Runs: `checkLiveUpdates.mjs`, `checkTwoClientSmoke.mjs`, `checkServerSend.mjs` and `checkJobProtocol.mjs`, one
  dev stack at a time (the test harness guide's Playwright rules); the e2e specs `lazyChats.spec.ts`,
  `perChatSends.spec.ts` and `serverTransform.spec.ts`.
- Guides: the Limitations sentences the slices retired are removed or rewritten with the decision references;
  the audit's ST03, ST04 and SD01 sections and the archive's Boot Bytes and Per-Event Server Work follow-ups get
  their after lines; the investigation's F1 section has its after line from Slice 0.
- The plan moves to the archive with the measured numbers.

## Recommended order

0 → 1 → 2 → 3 → 4 → 5. Slice 0 is client-only and the smallest; Slice 1 removes the largest recurring traffic
(every checkpoint to every tab, and the final write's whole row); Slice 2 is the owner's half of the same
saving; Slice 3 is the only new server store and benefits from the earlier slices' tests of the feed; Slice 4
needs only Slice 1 and is scheduled unconditionally (D6), so it may also follow Slice 1 directly. Only Slices 0
and 3 touch disjoint files and may run in parallel sessions; every other pair shares a file (**Slices**).

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for every renamed export, `pnpm check:tests` if a
  slow row changes.
- Focused:
  `pnpm --silent test:agent src/ts/storage/tests/chatStore.test.ts src/ts/translator/storedTranslation.test.ts`
  (Slice 0);
  `pnpm --silent test:agent server/src/tests/chatFeedPatches.test.ts server/src/tests/chatStore.test.ts server/src/tests/resourceStore.test.ts src/ts/storage/tests/resourceSyncFeedPatches.test.ts src/ts/storage/tests/resourceSyncLazyChats.test.ts`
  (Slice 1);
  `pnpm --silent test:agent server/src/tests/chatPatch.test.ts server/src/tests/generationBarrier.test.ts server/src/tests/generationDeltaChunks.test.ts src/ts/network/generationJobs.test.ts src/ts/network/jobChannelBarrier.test.ts`
  (Slice 2);
  `pnpm --silent test:agent server/src/tests/resourceStore.test.ts server/src/tests/events.test.ts server/src/tests/changeFeed.test.ts src/ts/network/eventFeed.test.ts src/ts/network/generationJobs.test.ts src/ts/storage/tests/resourceSyncLive.test.ts`
  (Slice 3);
  `pnpm --silent test:agent server/src/tests/chatFeedPatches.test.ts server/src/tests/resourcesBatch.test.ts src/ts/storage/tests/resourceClient.test.ts src/ts/storage/tests/resourceSyncFeedPatches.test.ts`
  (Slice 4).
- Probes and drivers as D9 names them, changed as it says, each with its after line in the audit or the
  investigation.
- Not covered by any gate: Firefox, Safari and mobile runs of the reconnect and the feed (as every earlier
  transport plan), and the owner's two-device check of a long reply watched from a second device.

## Out of scope

- Per-socket subscriptions and per-tab filtering of the feed (a tab still receives every publication's refs).
- A bound on the `hello` snapshots, or on a frame's refs and lock lists (Per-Event Server Work D5).
- Retiring `patch` for `delta` and dropping whole barriers for sockets without `hydration=patch`: D4 records the
  number; the floor and the refusal are a later plan's.
- The chat's summary on the job socket for the owner's own list.
- The provider callback stream (`ChannelChunk`) and its 50 ms coalescing.
- A persisted cursor across tabs or reloads: the cursor lives with the module's advertised map, outlives a
  connection by design (the replay after a reconnect needs it) and is cleared with that map (`clearAdvertised`,
  `eventFeed.ts:135-138`); a fresh tab boots with the data and takes its first cursor from its first `hello`.

## Later

- The cursor in the boot cache, so a reload after an away-time change replays instead of relisting, if
  `measureBoot.mjs`'s warm boot shows the listing as a remaining share.
- A `proto` floor with a refusal page, once the diagnostics show no client below it, carrying the Per-Event
  retirements (`patch`, whole barriers) with it.
- Row text deltas on the job socket for rows the owner did not stream (another job's reply in the same chat), if
  the owner patch bytes after Slice 2 still show them.
- Finer addressing inside a large field (one candidate of a reroll carrier rather than the whole array), if
  Slice 4's after line shows carrier row reads as a remaining cost.
- Per-socket subscriptions, if a server with many idle tabs measures the refs as a cost.
