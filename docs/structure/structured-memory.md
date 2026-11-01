# Structured Memory: Events, Pages, Threads, Receipts

## Scope

- Owns the `structuredMemory` algorithm: its record shapes, record limits, its tables and store, read routes, the tab's
  client and Markdown package, writer settings, and the HypaV3 compatibility projection.
- Paths: `shared/structuredMemory.ts`, `server/src/data/memoryStore.ts`, `server/src/routes/structuredMemory.ts`,
  `src/ts/process/structuredMemory.svelte.ts`.
- The algorithm is not reachable yet: the settings cannot select it, no server code writes the store, no screen calls
  the tab's client, and otherwise production code reads only the writer settings (filled by `createHypaV3Preset`,
  digested by `memorySettingsFingerprint`). Its design and remaining work are in [Active Plans](../plan/README.md).
- Not here:
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
  - Writer settings: `StructuredMemorySettings`, `normalizeStructuredMemorySettings`, `STRUCTURED_MEMORY_CADENCES`,
    `STRUCTURED_MEMORY_HIGHLIGHT_MODES`, `STRUCTURED_MEMORY_HIGHLIGHT_KINDS`.
  - Per-record overrides: `structuredMemoryLanguageOverride`, `structuredMemoryHighlightOverride`.
- `HypaV3Settings.structured` (`shared/memory.ts`), filled by `createHypaV3Preset` (`shared/hypaV3Presets.ts`).
- `memorySettingsFingerprint` (`server/src/jobs/jobScope.ts`) digests the settings a writer task reads.
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
- `isImportant` holds for a pinned event or one with any grade, 0 included.
- `metrics` comes from the last manifest and is absent without one. Indices are positions in the projected `summaries`,
  never in `events`, because every metrics reader indexes `summaries`.
- A metric records why that send selected a record, so only `verified` event items count: `flow` fills
  `lastRecentSummaries`, `events` fills `lastSimilarSummaries`, and an event in both lanes is in both arrays.
  `lastImportantSummaries` and `lastRandomSummaries` stay empty: no lane selects by importance or at random, and a pin
  set after the send must not rewrite that send's reasons. `lastDeferredSummaries` is absent.

## State

- A chat's records are events, pages, and threads, with the chat's own messages as the evidence. Each writer run leaves
  a `MemoryRun`, and each recorded turn a `MemoryReceipt`.
- The writer's settings are the selected memory preset's `settings.structured`, so they copy, export, and import with
  the preset. A chat's `structuredMemoryLanguage` wins over its owner's, and the owner's over the preset's `language`,
  where `""` follows `db.language`. A chat's `structuredMemoryHighlight` wins over the preset's `highlightMode`.
- `cadenceTokens` is the `tokens` cadence's threshold under a `tokens` budget mode, and `cadenceRatio` its share of the
  max context under a `ratio` one; each mode keeps the other's field.
- `MemoryEventDraft` is what the writer returns; `MemoryEvent` adds what code owns (id, sources, status, grade, repeat
  count). `MemoryRun.analysis` keeps the extraction as parsed, before admission and deduplication, so the log shows what
  the model said even when `eventId` names something else.

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
- The persisted value `memoryAlgorithmType` is a plain string in `shared/database.ts`; [memory](memory.md) owns the
  selection chain that reads the flags today.
- The overrides are `keep` in `CHECKPOINT_CHAT_FIELDS`: a settings choice stays with the current chat when a checkpoint
  loads. Upstream has none of this: `METATRON_CHAT_FIELDS` and `METATRON_CHARACTER_FIELDS` strip the overrides, and
  `upstreamHypaV3Presets` leaves `structured` out.
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
- Code owns grades: a draft carries scored axes, and only the stored `MemoryEvent` and `MemoryKnowledge` carry `grade`.
- Invalid writer settings take their defaults field by field; one bad field never resets the others.
- Overrides are read only through `structuredMemoryLanguageOverride` and `structuredMemoryHighlightOverride`, which
  treat a bad stored value as unset. No normalizer deletes one: the tab holds what it sent, so a server-only deletion
  would make a later conflict merge against a record the server does not have.
- `memorySettingsFingerprint` digests `structured`, the overrides, and `db.language` only while `memoryAlgorithmType` is
  `structuredMemory`, so a change to them never marks another algorithm's queued task stale.

## Recipes

- A new persisted record field: add it to the shape in `shared/structuredMemory.ts`, optional unless every stored record
  will have it, and extend this guide's contract.
- A new closed value: append to its `const` list; a validator reads the list, so it follows.
- A new writer setting: `StructuredMemorySettings`, `normalizeStructuredMemorySettings`, and the fresh-boot fixture
  `src/ts/storage/tests/fixtures/boot/boot-snapshot.json`. The whole object already joins the fingerprint.
- A new column: `CREATE TABLE IF NOT EXISTS` never extends a table, so it needs its own migration in `openChatSchema`,
  and `MEMORY_TABLE_COLUMNS` matches exactly, so the walk must also take a snapshot of the old layout. Read a new listed
  field through `json_extract` over `data` first when that is enough.

## Tests

- `shared/structuredMemory.test.ts` drives `projectHypaV3Data` with plain records; it needs no fakes.
- `server/src/tests/normalizeCollections.test.ts` drives the settings rules through `normalizeStructuredMemorySettings`,
  `createHypaV3Preset`, and `normalizeHypaV3Presets`.
- `server/src/tests/memoryTaskHost.test.ts` drives `memorySettingsFingerprint` on a real job scope, and
  `server/src/tests/upstreamExport.test.ts` drives what the upstream export leaves out.
- `server/src/tests/memoryStore.test.ts` drives `createResourceStore` on a real file, with a read-only second connection
  to see the rows, a SQLite trigger to fail a write midway, and `installSnapshot` for restores.
- `server/src/tests/restoreStage.test.ts` drives a crafted source through the real staging and install, and
  `backups.test.ts` drives the snapshot and archive routes. Both take their records from `tests/memoryFixtures.ts`.
- `server/src/tests/structuredMemoryRoutes.test.ts` drives the routes on a real app, and seeds them through a second
  store on the same file, because the app does not export its own. A frozen `Date` holds the rate limit window.
- `src/ts/process/structuredMemory.test.ts` runs in Node with `authFetch` scripted. Its splitters read a file only by
  metadata and line counts, as a reader must. It cannot use `testSupport.ts`: a `src/` test puts its imports under the
  root `tsconfig.json`, where the server routes do not type-check.
- Focused command:
  `pnpm --silent test:agent shared/structuredMemory.test.ts server/src/tests/memoryStore.test.ts server/src/tests/structuredMemoryRoutes.test.ts src/ts/process/structuredMemory.test.ts restoreStage backups normalizeCollections memoryTaskHost upstreamExport`.
  No `slow` or `e2e` membership of its own; `backups.test.ts` holds other slow cases.
- Not tested: the types and limits themselves, which `pnpm check` covers only for the code that uses them.

## Known Hazards

### Limitations

- Every graded event projects as `isImportant`, so once the writer grades events the flag stops separating them. D11
  says "events with grade or pins" and names no threshold. Decision: Structured Memory D11, plan.
- The package holds pages and events only: no threads, runs, or page history. Decision: Structured Memory slice 1d,
  plan.
- A round is bounded but the tab holds the whole package, and `zipSync` runs on the main thread. The table of contents
  has no budget of its own: it grows with the record count and the titles. Decision: Server Byte Budgets D2, archive.

### Gotchas

- `eventTitleChars`, `eventSummaryChars`, `keyLineChars`, and `pageHistoryEntries` are starting values. Only
  `keyLinesPerEvent`, `pageCandidates`, `consecutiveFailures`, `axisMax`, and `gradeMax` are design numbers.
- Every numeric default in `normalizeStructuredMemorySettings` is a starting value too; the required cap and the lane
  targets add up to the default `memoryBudgetTokens`. Only the cadence, highlight mode, and highlight kinds defaults are
  owner decisions.
- A character's language override does not travel in a card: the card exporters use explicit field lists.
