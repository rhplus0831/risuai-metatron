# Structured Memory: Events, Pages, Threads, Receipts

## Scope

- Owns the `structuredMemory` algorithm's records: their shapes and limits, the tables and store, read routes, the tab's
  client and Markdown package, the HypaV3 compatibility projection, the read path, and the receipts in the tab.
- Paths: `shared/structuredMemory.ts`, `server/src/data/memoryStore.ts`, `server/src/routes/structuredMemory.ts`,
  `server/src/prompt/memory/structured/` (the writer's files: [the writer guide](structured-memory-writer.md)),
  `src/ts/process/structuredMemory.svelte.ts`, `src/lib/ChatScreens/MemoryReceiptLine.svelte`.
- The algorithm is not reachable yet: the settings cannot select it, so `db.memoryAlgorithmType` holds its value only in
  tests, and no screen calls the tab's reads, so its receipt line shows only there. Production has its
  [writer](structured-memory-writer.md), and `assemblePrompt` runs the read path, which has no required or pages lane
  yet. Its design and remaining work are in [Active Plans](../plan/README.md).
- Not here:
  - The writer's settings, windows, task kind, runs, analysis prompt, admission, and record now →
    [structured memory writer](structured-memory-writer.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](memory.md).
  - `Chat.hypaV3Data` and its write rules → [memory](memory.md), `shared/memory.ts`.
  - The resource store's connection, epoch, and transactions → [server resources](server-resources.md).

## Files

- `shared/structuredMemory.ts`: types and pure rules only, safe in the tab and on the server.
  - `STRUCTURED_MEMORY_ALGORITHM`: the persisted discriminator.
  - `STRUCTURED_MEMORY_LIMITS`: the record limits, and `CHARACTER_SECTION_SLOTS`: the fixed character sections.
  - Records: `MemoryEvent`, `MemoryPage`, `MemorySection`, `MemoryThread`, `MemoryRun`, `MemoryReceipt`.
  - Writer output: `MemoryEventDraft`, `MemoryAnalysisResult`, `MemoryPageCandidate`.
  - Evidence anchors: `MemorySource`, `MemoryAnchoredSource`, `MemoryUnanchoredSource`.
  - Per-send: `MemoryManifest`, `MemoryManifestItem`.
  - `projectHypaV3Data`: the `SerializableHypaV3Data` view of a chat's events.
  - `memoryGrade`: a record's grade from its axes. `memoryThreadEnded`: `done` and `cancelled`.
- `server/src/data/memoryStore.ts`: `createMemoryTables`, the synchronous reads and the write over the tables;
  `MemoryChanges`, `MemoryContents`; `messageSourceHash`, what a `MemoryAnchoredSource` keeps as its `hash`.
- `server/src/data/chatStore.ts`: `MEMORY_TABLES_SQL`, part of `CHAT_OPEN_SCHEMA_SQL`.
- `server/src/data/resourceStore.ts`: `store.memory`, `readContents`, `readRecord`, and `write`.
- `server/src/routes/structuredMemory.ts`: `registerStructuredMemoryRoutes`. Its path and answers are shared:
  `STRUCTURED_MEMORY_PATH`, `MEMORY_RECORD_KINDS`, `StructuredMemoryContentsAnswer`, `StructuredMemoryRecordAnswer`,
  `StructuredMemoryPackageRound`.
- `src/ts/process/structuredMemory.svelte.ts`: the reads `readStructuredMemoryContents`, `readStructuredMemoryRecord`,
  `buildStructuredMemoryPackage`, which answer a `StructuredMemoryResult`; the pure `renderMemoryPage`,
  `renderMemoryTimeline`, and `memoryPagePath`.
- `src/lib/ChatScreens/MemoryReceiptLine.svelte`: the line, from `Chat.svelte`'s `genInfo`. `memoryReceiptView` and
  `newestAssistantMessageId` in `structuredMemory.svelte.ts` are its pure part.
- `server/src/prompt/memory/structured/lanes.ts`: the pure read rules: `ReadEntry`, `rawWindow`, `coveredMessages`,
  `readBudget`, `spendLanes`, `LaneItem`, `LaneCandidate`, `Lane`, `ExcludedItem`, `itemKey`.
- `server/src/prompt/memory/structured/retrieve.ts`: `retrieveLanes`, `RETRIEVAL_LIMITS`, `readsAsPast`,
  `eventVectorTexts`, `lexicalTerms`.
- `server/src/prompt/memory/structured/card.ts`: `buildMemoryCard`, `itemTag`, and the line builders.
- `server/src/prompt/memory/structured/step.ts`: a send's read: `readMemoryRecords`, `MemoryRecords`, `readEntries`,
  `selectMemory`, `writerState`, `sendManifest`. `structuredMemoryStep` in `assemble.ts` drives it; the job's part is in
  [the writer guide](structured-memory-writer.md#the-writer-task).
- `shared/contextReport.ts`: the manifest's fields on `ContextReport.memory`, `reportedMemoryExclusions`,
  `CONTEXT_MEMORY_EXCLUDED`. `trimHistoryToContext` in `hypav3.ts` is the trim both algorithms share.

## Flows

### The read routes

All are `GET` under `STRUCTURED_MEMORY_PATH/:characterId/:chatId`, authenticated, rate-limited, and epoch-checked (412
`EpochMismatch`), with the check and every store read in one synchronous step. Ids are checked first (400).

- The chat's path answers the table of contents; `/records/:kind/:id` answers one record of a `MEMORY_RECORD_KINDS` kind
  as stored. A missing chat or record is 404 with `reason` `chatGone` or `recordGone`.
- `/package?cursor=N&revision=R` answers one round of the chat's pages followed by its events, in contents order, whole
  records as stored. It charges each record's `bytes` from the contents, so it reads no body it will not send. The
  budget is `RouteLimits.memoryPackageRoundBytes`, default `MAX_READ_RESPONSE_BYTES`, and soft as
  [the read budget](server-resources.md#read-budget) is: a round's first record is served whatever its size. `next` is
  the position to continue from, null at the end.
- `revision` is compared whole as an opaque token, and a different one is 409 naming the current one. A round is one
  snapshot, and that comparison is what ties rounds into one.

### The Markdown package

`buildStructuredMemoryPackage` reads every round, renders in the tab, and answers `{ name, bytes }` for `downloadFile`.
A 409 restarts the read with nothing kept, 3 attempts in all, then refused `changed`. A 412 calls `epochMismatch` and
ends the read at once.

- The zip holds `timeline.md` and `pages/<type>/<title part> [<id part>].md`, one per page.
- Metadata is the authority and Markdown is display. A metadata line is `key: <JSON>`, which is valid YAML on one line;
  `\u` escapes cover what YAML does not print.
- A page's frontmatter has every field but `history`, and `sections` without bodies but with `bodyLines`. Each body
  follows verbatim under a `##` line. `heading` in the frontmatter is the exact value; the `##` line collapses
  whitespace.
- `timeline.md` opens with `packageVersion` and `revision`. Each event is a `##` line, a `yaml` fence with every field
  but `summary`, plus `summaryLines`; then the summary verbatim, then one quote line per key line.
- `bodyLines` and `summaryLines` count `split("\n")` pieces. They are what splits a body holding `## x`, a fence, or
  `---`, so a reader counts lines and never searches for a delimiter.
- Events sort by their smallest anchored source `index`, which is the position when recorded, not the current one. An
  event with no anchored source goes last, and ties keep contents order.

### A memory write

`store.memory.write(characterId, chatId, { epoch, baseRevision }, changes)` commits one declarative change set in its
own transaction. Nothing async can run inside it.

1. Another epoch, or none, is a `ResourceEpochError`. A missing chat is a `ResourceConflictError` with `current: null`,
   and a `baseRevision` that is not the current token one naming the current token.
2. A change set that names nothing stops here: it answers the current token and writes nothing, not even a
   `memory_state` row. A stale empty write is still refused.
3. Every record is checked before anything is written, so a `ResourceValidationError` changes nothing: an id repeated
   within a kind, or both written and removed; an invalid id; a `title` that is not a string; a closed value outside its
   `const` list; a stored text over `MAX_READ_RESPONSE_BYTES`.
4. Removals, then upserts, then the revision moves up by exactly one, however much changed. Removing an absent id is no
   refusal and still moves it.

The write publishes nothing: the chat's revision and the change feed stay as they were, and it counts toward snapshots
like a checkpoint write.

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

### Receipts

`generationInfo.memory` on a message says what happened to its turn. The stored kinds, by who writes them:

- `recorded` and `failed`: `commitWindow` ([the writer's commit](structured-memory-writer.md#the-writer-task)), from the
  receipt of the run in `changes`, right after the memory write and in the same synchronous step, one `patchMessage` per
  assistant message of the window, each keeping its other generation info. So every turn of an `everyK` or `tokens`
  window carries the same receipt. Two transactions, not one: a receipt that conflicts anyway is logged, the commit
  stands, and `MemoryRun.receipt` keeps it.
- `notAutomatic` (`pluginModel`, `requestTrigger`, `localSummarization`) and `skipped` (`writerPaused`): the send's job,
  on its own reply's generation info (`structuredMemoryStep`), so no extra chat write. It cannot be left to the task,
  which is handed off only when a window is due. A run that records the turn replaces it, because the patch sets the
  whole `memory` field.
- `pending` is never stored. On the newest assistant message with no receipt the line reads as the writer working while
  the chat's task is live (about the chat, not that row), else as having no receipt yet. Older rows without one show
  nothing: no receipt proves nothing, see `Invariants`.

The row list mounts `Chat` once per text, so `messageGenerationInfo` keeps what the row was mounted with: the line reads
the held chat, and a feed patch moves it.

### The read path

Nothing here writes: `retrieveLanes` offers candidates, and `buildMemoryCard` spends the budget on them. The required
and pages lanes are not built. The modules' comments hold the lane rules.

`selectMemory` runs once for every job with `memoryJob.structuredMemory`, a preview and a service-free send included,
which read as a send does. With no `memoryJob` the history stays raw and no report says otherwise.

1. Records: one synchronous read. `coveredMessages` (active, not suppressed) says what may leave, and `recordedMessages`
   (any status) what the writer leaves alone, so history cited only by a stale or retracted event stays raw.
2. Window: `rawWindow`, then the message a continue extends leaves `dropped` before retrieval, so an older one stays in
   the prompt and out of the evidence.
3. Card: one `memo: "supaMemory"` entry at the front of the history, with no entry when no item is included. Under
   `volatileBeforeLastUser` the volatile part is its own entry, which never joins the history: a chat range could cut it
   there, and a `memory` prompt card would pull it away. Assembly splices it into `formated` once the cards are
   formatted, right before the entry holding the latest user message, found by provenance. A range that left that
   message out puts it after the last memory entry, else at the end.
4. Trim: `trimHistoryToContext`, as HypaV3's select-only path, with the window as its protected tail and an older
   continue target pinned. Both go into `protectedEntries`. A tail that does not fit ends the send with
   `TOO_MUCH_TOKEN`. Dropped history is `coverage: "gap"`, and the gap question is
   [the writer's](structured-memory-writer.md#the-writer-task).

The report (`ContextReport.memory`, kind `structuredMemory`):

- `items` are the included records. `verified` is set in `buildContextReport` by finding `itemTag(item)` in the final
  prompt, whichever entry holds it, so after scripts, `editRequest`, and the recheck. One not found makes `coverage`
  `unknown`, because the two parts can be lost apart.
- `excluded` keeps `CONTEXT_MEMORY_EXCLUDED` rows, worst reason first, and `excludedTotal` the count: `retrieveLanes`
  lists every not-relevant event. `lanes` holds each lane's target and spend.
- `confirmedThrough` is the newest reply the writer's ceiling confirms. `writer.state` says, in order, `notAutomatic` or
  `paused` (`writerNotice`), `failed` (the newest run that recorded or failed did not record), `pending` (that reply is
  not recorded), else `recorded`.
- `stages` is the ledger, each a stage and a reason code: `window`, `lanes`, `gap` (only with a gap), `card`, and on an
  input job with a service `writer`. `writer` says `due`, not queued: the hand-off comes after the reply and may be
  skipped.

Lane rules:

- `ReadEntry.role` is the stored message's, because assembly rewrites a prompt role in a group chat and under
  `sendName`, undefined on the greeting. `text` is the processed content, so evidence quotes what the prompt would have
  shown.
- An event with no source among the entries has no place, which says nothing about staleness: a disabled message is just
  not in this send.
- `rawWindow` leaves every uncovered entry raw for the caller's gap trim, and an event wholly inside the window with
  text is not retrieved. Older sources do not count as in the prompt: that trim may remove them.
- A `requires` names an `itemKey`, so a flow title never satisfies an excerpt's event, and a flow tag differs from the
  event's, so it never verifies the event's text. Flow has no token target: its `target` reaches `spend` as
  `Number.MAX_SAFE_INTEGER`.
- `maximum` bounds the two card parts counted as one system chat each, so it holds wherever the volatile part goes. A
  wrapper the prompt adds is not part of it.
- An embedding failure answers `similarity: "failed"` and the send goes on, where HypaV3 fails it. Cancellation still
  escapes through `host.fence()`.
- `excluded` is per lane, so an event in flow can be excluded from `events`: `retrieveLanes` lists what is no candidate,
  `buildMemoryCard` what lost on budget. Neither bounds its list, so a report does.

## State

- A chat's records are events, pages, and threads, with the chat's own messages as the evidence. Each writer run leaves
  a `MemoryRun`, and each recorded turn a `MemoryReceipt`.
- `MemoryEventDraft` is what the writer returns; `MemoryEvent` adds what code owns (id, sources, status, grade, repeat
  count). `MemoryRun.analysis` keeps the bounded draft before evidence checks and deduplication, so the log shows what
  the model said even when `eventId` names something else. `MemoryRun.receipt` holds what the run listed; a message's
  `generationInfo.memory` is its copy, or what the send said ([Receipts](#receipts)).
- A grade is the sum of a record's axes, 0 to 9; a record without axes has none.

### Memory tables

The tables sit in `data/resources.sqlite`, keyed by the chat's incarnation `chats.seq` with `ON DELETE CASCADE`, so a
deleted and recreated chat inherits nothing. Routes still address a chat by `(characterId, chatId)`. Created when
missing, with no version change, and outside the required snapshot layout: all five are an optional group, like the
[checkpoint tables](server-resources.md#checkpoint-tables). A snapshot from before them restores with none, a partial
group is refused, and a full one is checked and restored.

- `memory_state` (`chatSeq` primary key, `revision`): one revision over all of a chat's records. A chat has no row until
  its first write, and an existing chat with no row is at revision 0.
- `memory_pages` (`type`, `title`), `memory_events` (`title`, `status`, `createdRevision`), `memory_threads` (`title`,
  `state`), `memory_runs` (`result`): each with `seq` autoincrement, `chatSeq`, `id`, and `data`, the whole record as
  stored JSON, unique `(chatSeq, id)`. Sections stay embedded in the page's row.
- `seq` is storage order, not message order; an update keeps it, because upserts never use `INSERT OR REPLACE`.
- A restore (`walkMemorySnapshot`, `createMemoryStagingSink`, `copyStagedMemory`) keeps `data` and every revision as
  stored, gives records fresh `seq`s in the source's order, and moves `chatSeq` through the staged chat seq map. The
  listed columns come from the record, never from the source's columns, which a live write can leave unequal (a title
  with a lone surrogate binds as U+FFFD and stays an escape in `data`).

## Coupling

- The projection's return type and metric names come from `shared/memory.ts`. `HypaV3Modal.svelte` and
  `remapHypaV3Metrics` read each metric array independently, so an index may sit in two arrays.
- The persisted value `memoryAlgorithmType` is a plain string in `shared/database.ts`; `structuredMemory` selects ahead
  of the [selection chain](memory.md#selection-in-assembleprompt) that reads the flags, which [memory](memory.md) owns.
- The tables follow the [epoch rules](server-resources.md#epoch-and-response-rules) and the snapshot walk of
  [server resources](server-resources.md#snapshots-and-restore). `readSnapshotFile` passes no memory sink: the upstream
  export neither reads the tables nor stops on a problem in them.
- The memory revision says nothing about the chat's messages. A whole-chat `replace` or a checkpoint load keeps
  `chats.seq`, so the rows and the revision survive it, and only the memory task's fence stops a writer working from the
  old messages ([memory](memory.md)).
- The route answers are shared types because tab code never imports `server/`; each route answers with `satisfies`, so a
  store type that drifts fails `pnpm check`.
- `app.ts` admits the routes as resource handlers: tracked, refused during shutdown, and `no-store`. `ROUTE_TEMPLATES`
  in `shared/diagnostics.ts` lists each route.

## Invariants

- Server code writes the tables only through `store.memory`, synchronously, after the task's or route's fence check. The
  one exception is a restore's staged writer and install copy.
- A snapshot a live write could have left is never refused, and a crafted one is a `ResourceValidationError` (a 400),
  never a constraint failure. A record's chat has a `memory_state` row, but a state row needs no records, and an event's
  `createdRevision` is within that row's revision, without being unique or the latest.
- A memory revision is a token, `<epoch>:<chatSeq>:<revision>`, never a bare number: a chat recreated under the same ids
  restarts at 0, and only the token's `seq` tells the two apart. `readContents` and `readRecord` both answer one.
- A stale write is refused whole and retried from a fresh read, never merged by field.
- `createdRevision` is the store's: the committing revision on insert, the stored value on update, whatever the input
  held. A caller holds an opaque token, so a write takes `MemoryEventWrite`.
- No record's stored text passes `MAX_READ_RESPONSE_BYTES`. `STRUCTURED_MEMORY_LIMITS` bounds no body, so this refusal
  is what keeps a page's embedded sections within the read budget, and it is hard where the read budget is soft.
- Table-of-contents statements never select `data`; `octet_length(data)` takes the size from the row's header. Column
  values come from the serialized record, so `toJSON` cannot make a column disagree with `data`.
- The store checks what its columns and rows need, not a record's whole shape: the callers own that.
- A package path never holds a raw id: a resource id may hold `/`, so the id part is `encodeURIComponent` with `*` also
  encoded. It alone makes a path unique; the title part is display.
- `structuredMemory` and every value in the module's `const` lists are persisted: never rename one (repository invariant
  D5). A new value is added to its list.
- Event status is `active`, `retracted`, or `stale`. Unfinished recording lives on the run and the receipt: a failed
  first recording commits no event, and a failed re-record leaves the committed event in place until its replacement
  succeeds.
- A `MemoryAnchoredSource` hash is the SHA-256 of the stored message's role and `data`, never `generationInfo`, so a
  receipt write keeps the hash.
- A `MemoryUnanchoredSource` means the anchor was never known: an adopted summary whose message was already gone. It
  forces its event `stale`. A source whose message disappears later keeps its original hash and index. A run's window
  holds only anchored sources.
- Sections carry both `provenance` (event ids) and `sources`, and a history entry's `before` carries all three of body,
  provenance, and sources, so a revert never restores a body with the replacement's evidence. `before` is `null` when
  nothing was replaced, and `heading` is `null` for a change to the whole page.
- The state after a history entry is the next entry's `before` or the live section; no `after` is stored.
- On a character page, a section's `heading` holds a `CHARACTER_SECTION_SLOTS` key, not display text. Other page types
  use free headings.
- `MemoryManifest.items` holds included items only; excluded candidates never reach the projection.
- A report never bounds `items`, which the memory budget does, and always bounds `excluded`.
- History leaves the prompt only where `coveredMessages` says so; "recorded" never decides it.
- Code owns grades: a draft carries scored axes, and only the stored `MemoryEvent` and `MemoryKnowledge` carry `grade`.
- A receipt is a display copy: `memory_runs` is the record. A message with no receipt is no proof that nothing was
  recorded, since a checkpoint load restores older rows while the tables survive and a whole-row `setMessage` replaces
  the field. Nothing reads a receipt to decide what to record.
- `memoryReceiptView` reads a receipt as stored data of any shape: a state it does not know hides the line.

## Recipes

- A new persisted record field: add it to the shape in `shared/structuredMemory.ts`, optional unless every stored record
  will have it, and extend this guide's contract.
- A new closed value: append to its `const` list; a validator reads the list, so it follows.
- A new column: `CREATE TABLE IF NOT EXISTS` never extends a table, so it needs its own migration in `openChatSchema`,
  and `MEMORY_TABLE_COLUMNS` matches exactly, so the walk must also take a snapshot of the old layout. Read a new listed
  field through `json_extract` over `data` first when that is enough.

## Tests

- `shared/structuredMemory.test.ts` drives `projectHypaV3Data` with plain records; it needs no fakes.
- `server/src/tests/memoryStore.test.ts` drives `createResourceStore` on a real file, with a read-only second connection
  to see the rows, a SQLite trigger to fail a write midway, and `installSnapshot` for restores.
- `server/src/tests/restoreStage.test.ts` drives a crafted source through the real staging and install, and
  `backups.test.ts` drives the snapshot and archive routes. Both take their records from `tests/memoryFixtures.ts`.
- `server/src/tests/structuredMemoryRoutes.test.ts` drives the routes on a real app, and seeds them through a second
  store on the same file, because the app does not export its own. A frozen `Date` holds the rate limit window.
- `src/ts/process/structuredMemory.test.ts` runs in Node with `authFetch` scripted. Its splitters read a file only by
  metadata and line counts, as a reader must. It cannot use `testSupport.ts`: a `src/` test puts its imports under the
  root `tsconfig.json`, where the server routes do not type-check.
- `structured/lanes.test.ts` and `card.test.ts` drive the read rules with plain values and a fake tokenizer.
  `structured/retrieve.test.ts` runs real embeddings over a vector cache with a scripted provider.
- The read step: `assemble.test.ts` drives `assemblePrompt` with a faked `memoryJob.structuredMemory` for the window,
  trim, placement, gap question, and report; `memoryJobs.test.ts` drives the gap run on a real stack;
  `contextReport.test.ts` the parser. Focused:
  `pnpm --silent test:agent assemble memoryJobs shared/contextReport.test.ts`.
- Receipts: `memoryTasks.test.ts` for the patches; `memoryJobs.test.ts` for the reply's notice on a real stack;
  `structuredMemory.test.ts` for `memoryReceiptView`; `MemoryReceiptLine.svelte.test.ts` and
  `Chat.interactions.svelte.test.ts` for the line and its gate.
- Focused command:
  `pnpm --silent test:agent shared/structuredMemory.test.ts server/src/tests/memoryStore.test.ts server/src/tests/structuredMemoryRoutes.test.ts src/ts/process/structuredMemory.test.ts server/src/prompt/memory/structured/lanes.test.ts server/src/prompt/memory/structured/card.test.ts server/src/prompt/memory/structured/retrieve.test.ts src/lib/ChatScreens/MemoryReceiptLine.svelte.test.ts src/lib/ChatScreens/Chat.interactions.svelte.test.ts restoreStage backups memoryTasks memoryJobs`.
  No `slow` or `e2e` membership of its own; `backups.test.ts` holds other slow cases.
- Not tested: the types and limits themselves, which `pnpm check` covers only for the code that uses them.

## Known Hazards

### Issues

- A paraphrase of an old message that shares no query term is not found: semantic scoring only reranks lexical matches,
  to keep embedding at `lexicalCandidates` texts a send. D6 names both as channels.

### Limitations

- The package holds pages and events only: no threads, runs, or page history. Decision: Structured Memory slice 1d,
  plan.
- `verified` reads the prompt assembly returned. Plugin replacers and `request` triggers run after it, on every attempt,
  so a line they remove still reads as verified, and a provider that gathers system entries (Ooba mode) undoes the
  placement. A tag the model echoed into a kept message verifies a lost line too. Decision: D8, plan.
- Covered history leaves even when the budget cannot hold the card's frame: the card is empty and `coverage` stays
  `covered`, because an event covers it; `stages` says `card: empty`.
- A tab older than the `structuredMemory` kind reads such a report as none and shows an older one.
- `genInfo` is not rendered in the `mobilechat` and `cardboard` themes, so they show no line.
- A round is bounded but the tab holds the whole package, and `zipSync` runs on the main thread. The table of contents
  has no budget of its own: it grows with the record count and the titles. Decision: Server Byte Budgets D2, archive.

### Gotchas

- The limits are starting values. Only `keyLinesPerEvent`, `pageCandidates`, `consecutiveFailures`, `axisMax`,
  `gradeMax`, `importantEventGrade`, and `dedupeSimilarity` are design numbers.
- `eventVectorTexts` must stay `warmEvent`'s text rule; a retrieval that embeds other text pays for every event again.
- Every number in `RETRIEVAL_LIMITS` is a starting value, and a cosine threshold does not mean the same on every model.
  An unknown stage is empty, so a named thread waits for a scene page.
- A report stored on every reply grows with `items` and `excluded`, up to a few kilobytes a message. D5's
  `memory_manifests` table is the way out if that matters.
- A send's retrieval embeds every eligible event's texts. Warm, `addText` still compares every text with every vector
  synchronously, so the cost grows with the square of the chat's event texts. Cold (a model change, a cleared cache), it
  is one provider call per 50 texts, in sequence, inside the send.
- A window message with no `generationInfo` (an imported chat) gains `{ memory }` alone, so with `requestInfoInsideChat`
  its row shows an "Unknown" model button after its next mount.
- A copied or branched chat carries its receipts along with its messages.
