# Structured Memory: Events, Pages, Threads, Receipts

## Scope

- Owns the `structuredMemory` algorithm: its record shapes, record limits, writer settings, and the HypaV3 compatibility
  projection.
- Paths: `shared/structuredMemory.ts`.
- The algorithm is not reachable yet: the settings cannot select it, and production code reads only the writer settings
  (filled by `createHypaV3Preset`, digested by `memorySettingsFingerprint`). Its design and remaining work are in
  [Active Plans](../plan/README.md).
- Not here:
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](memory.md).
  - `Chat.hypaV3Data` and its write rules → [memory](memory.md), `shared/memory.ts`.

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

## Flows

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
  a `MemoryRun`, and each recorded turn a `MemoryReceipt`. No store holds them yet.
- The writer's settings are the selected memory preset's `settings.structured`, so they copy, export, and import with
  the preset. A chat's `structuredMemoryLanguage` wins over its owner's, and the owner's over the preset's `language`,
  where `""` follows `db.language`. A chat's `structuredMemoryHighlight` wins over the preset's `highlightMode`.
- `cadenceTokens` is the `tokens` cadence's threshold under a `tokens` budget mode, and `cadenceRatio` its share of the
  max context under a `ratio` one; each mode keeps the other's field.
- `MemoryEventDraft` is what the writer returns; `MemoryEvent` adds what code owns (id, sources, status, grade, repeat
  count). `MemoryRun.analysis` keeps the extraction as parsed, before admission and deduplication, so the log shows what
  the model said even when `eventId` names something else.

## Coupling

- The projection's return type and metric names come from `shared/memory.ts`. `HypaV3Modal.svelte` and
  `remapHypaV3Metrics` read each metric array independently, so an index may sit in two arrays.
- The persisted value `memoryAlgorithmType` is a plain string in `shared/database.ts`; [memory](memory.md) owns the
  selection chain that reads the flags today.
- The overrides are `keep` in `CHECKPOINT_CHAT_FIELDS`: a settings choice stays with the current chat when a checkpoint
  loads. Upstream has none of this: `METATRON_CHAT_FIELDS` and `METATRON_CHARACTER_FIELDS` strip the overrides, and
  `upstreamHypaV3Presets` leaves `structured` out.

## Invariants

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

## Tests

- `shared/structuredMemory.test.ts` drives `projectHypaV3Data` with plain records; it needs no fakes.
- `server/src/tests/normalizeCollections.test.ts` drives the settings rules through `normalizeStructuredMemorySettings`,
  `createHypaV3Preset`, and `normalizeHypaV3Presets`.
- `server/src/tests/memoryTaskHost.test.ts` drives `memorySettingsFingerprint` on a real job scope, and
  `server/src/tests/upstreamExport.test.ts` drives what the upstream export leaves out.
- Focused command:
  `pnpm --silent test:agent shared/structuredMemory.test.ts normalizeCollections memoryTaskHost upstreamExport`. No
  `slow` or `e2e` membership.
- Not tested: the types and limits themselves, which `pnpm check` covers only for the code that uses them.

## Known Hazards

### Limitations

- Every graded event projects as `isImportant`, so once the writer grades events the flag stops separating them. D11
  says "events with grade or pins" and names no threshold. Decision: Structured Memory D11, plan.

### Gotchas

- `eventTitleChars`, `eventSummaryChars`, `keyLineChars`, and `pageHistoryEntries` are starting values. Only
  `keyLinesPerEvent`, `pageCandidates`, `consecutiveFailures`, `axisMax`, and `gradeMax` are design numbers.
- Every numeric default in `normalizeStructuredMemorySettings` is a starting value too; the required cap and the lane
  targets add up to the default `memoryBudgetTokens`. Only the cadence, highlight mode, and highlight kinds defaults are
  owner decisions.
- A character's language override does not travel in a card: the card exporters use explicit field lists.
