# Structured Memory Writer: Windows, Tasks, Runs, Admission

## Scope

- Owns the `structuredMemory` writer: its settings and their overrides, the windows it records, its task kind in the
  memory task service, a writer run, the analysis prompt, admission of the model's answer, and record now with the
  `memoryRecord` job.
- Paths: `server/src/prompt/memory/structured/{window,writer,prompts,analysis,recordJob}.ts`, the writer's task kind in
  `server/src/prompt/memory/memoryTasks.ts`, and `structuredMemoryStep` in `server/src/prompt/assemble.ts`.
- The algorithm is not reachable yet: the settings cannot select it. See [structured memory](structured-memory.md) for
  that state, and [Active Plans](../plan/README.md) for the design and remaining work.
- Not here:
  - Record shapes and limits, the tables and store, read routes, the Markdown package, the HypaV3 projection, the read
    path, and the receipts in the tab → [structured memory](structured-memory.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](memory.md).
  - The resource store's connection, epoch, and transactions → [server resources](server-resources.md).

## Files

- `shared/structuredMemory.ts`, the writer's part:
  - Writer settings: `StructuredMemorySettings`, `normalizeStructuredMemorySettings`, `STRUCTURED_MEMORY_CADENCES`,
    `STRUCTURED_MEMORY_HIGHLIGHT_MODES`, `STRUCTURED_MEMORY_HIGHLIGHT_KINDS`.
  - Per-record overrides: `structuredMemoryLanguageOverride`, `structuredMemoryHighlightOverride`.
- `HypaV3Settings.structured` (`shared/memory.ts`), filled by `createHypaV3Preset` (`shared/hypaV3Presets.ts`).
- `memorySettingsFingerprint` (`server/src/jobs/jobScope.ts`) digests the settings a writer task reads.
- `server/src/prompt/memory/structured/window.ts`: the writer's windows: `confirmedWindows`, `WriterWindow`,
  `writerCeiling`, `writerCadence`, `readRecordedMessages`, `windowStillConfirmed`.
- `server/src/prompt/memory/structured/prompts.ts`: `analysisSlots`, `assembleAnalysisPrompt`.
- `server/src/prompt/memory/structured/analysis.ts`: the pure `parseAnalysis` and `admitAnalysis`.
- `server/src/prompt/memory/structured/writer.ts`: `createStructuredWriter`, the run lifecycle; `commitWindow`, a
  writer's one write on either path; `writerRequestDb` and `writerHostDeps`, what its requests ignore of the preset;
  `writerPaused`.
- `server/src/prompt/memory/structured/recordJob.ts`: `runMemoryRecord`, the `memoryRecord` command.
- `server/src/prompt/memory/memoryTasks.ts`: the task kind inside the shared service: `StructuredMemoryWriter`
  (`structuredWriter` replaces `createStructuredWriter`, in tests), `StructuredMemoryWriterResult`,
  `StructuredMemoryCommit`, `MemoryTaskLimits.maxWriterWindows`.
- `server/src/prompt/assemble.ts`: `structuredMemoryStep`, `AssemblyMemoryJob.structuredMemory` (the runner fills it).
- `shared/jobs.ts`: `StructuredMemoryTaskInput`, `MemoryTaskBase`, `AnyMemoryTaskInput`, `MemoryTaskStatus.kind`.

## Flows

### The writer's windows

`confirmedWindows` works out what the writer records next from the stored messages and the stored events alone, so a
restart that loses the task queue loses nothing: the next send finds the same windows, and no startup scan exists.

1. Ceiling (`writerCeiling`): a reply is evidence once the user sends the next message, so the job names the message the
   windows stop before. It is the last eligible user message or, on a continue, the continued message when that comes
   first (a job may continue an older one). With no eligible user message there is no ceiling and no task input. A
   manual task takes `writerCeiling` of the chat as stored instead, else the input's: a person's start is the
   confirmation the captured ceiling stands in for, and that one is only as new as the last hand-off.
2. Confirmed messages: `eligibleHistory` of the stored list, before the ceiling, with a `chatId`. This keeps out the
   newest reply and one being generated or continued; swipe candidates are not stored messages at all. The ceiling must
   itself be eligible: one that is gone, disabled, or cut off by an `allBefore` counts as no longer in the chat, so the
   task ends `skipped` (`staleInput`) and `commit` refuses (`windowChanged`).
3. Turns: one per assistant message, closed there, because an event names one speaker. `[u1, aA, aB, u2, ...]` gives
   `[u1, aA]` and `[aB]`, and user messages with no assistant message after them before the ceiling belong to no turn.
4. Recorded messages (`readRecordedMessages`): a turn drops out when its assistant message is recorded; any other lists
   its unrecorded messages. A failed run writes no event, so its window stays open and is retried.
5. Closing, in order over the turns left; a trailing partial window stays open:
   - `everyTurn`: one turn each.
   - `everyK`: `cadenceTurns` turns each.
   - `tokens`: turns accumulate until their messages reach the threshold, then the window closes. The threshold is
     `cadenceTokens` under budget mode `tokens`, else `cadenceRatio` of the input's `maxContext`, at least 1. Only this
     cadence counts, over each stored message's role and `data`, in the step and in the task alike.
   - `manual`: closes none.
6. A manual start also closes the trailing partial window; under the `manual` cadence it makes one window of each turn.

A window is `{ sources, messages }`: `sources[i]` anchors `messages[i]`, with `index` the place in the stored list, not
the eligible one, and `hash` from `messageSourceHash`.

### The writer task

1. Selection: `db.memoryAlgorithmType === "structuredMemory"` runs `structuredMemoryStep` ahead of the flag chain. The
   step leaves the history raw, so what does not fit falls to the final token recheck, adds no protected entries and no
   memory run, and returns the hand-off with `due` from `confirmedWindows` at `limit: 1`.
2. Hand-off: for an input job with a service and a chat snapshot read with its source generation, due or not, since
   `handOffMemory` hands off a not-due input when a manual start waits. It asks no blocking reason, unlike HypaV3.
3. Start: the service's shared checks ([memory](memory.md#background-memory-task), `createMemoryTasks`), with
   `notStructuredMemory` when `memoryAlgorithmType` no longer selects it. A Plugin `memory` slot, a `request` trigger,
   or a local summarizer ends the task `skipped` with `pluginModel`, `requestTrigger`, or `localSummarization`. What a
   person reads of that is the reply's own [receipt](structured-memory.md#receipts), which does not wait for a task.
4. Work: the fresh scope's chat and the stored events give the windows, up to `maxWriterWindows`. The hand-off gives an
   automatic task only its ceiling. `total` counts the windows the task runs and `done` those the writer returned
   recorded. Nothing open is `done` with 0 of 0.
5. Each window goes to the writer in order. The first that ends `skipped` or `failed` ends the task with that reason or
   redacted error, because a later window recorded ahead of it would put events out of message order; a throw goes
   through `endFromError`.
6. A task stopped by the cap with windows left ends `done` with reason `windowsLeft`. The next hand-off continues it,
   which under the `manual` cadence takes another manual start. Otherwise a warming failure ends it `done` with reason
   `warmingFailed` and the redacted error.

`commit(baseRevision, changes)` is the writer's only write, synchronous, checked in this order: the task is live (it
throws once ended), the gate is open, the service is open with the input's epoch and source generation (else refused
`staleInput`), then `commitWindow`: the window still reads from the chat as stored under the ceiling it was computed
with (`windowStillConfirmed`, else `windowChanged`), no generation job owns one of its messages (`messagesLocked`, else
`windowChanged`), and the memory revision is current (else `revisionConflict`). A refusal writes nothing.

### A writer run

`createStructuredWriter` makes one analysis call per window. `memory_runs` is its whole state.

1. Pause: `consecutiveFailures` `failed` rows at the end of the runs end an automatic run `skipped` (`writerPaused`),
   with no call and no row. `skipped` and `pending` rows neither count nor reset, a `recorded` row resets, and a manual
   start runs past the pause.
2. Leftovers: one task runs per chat, so a `pending` row found here is abandoned. The write that opens the run closes it
   `skipped` (`interrupted`): a cancel, a checkpoint load, or a restart proves nothing about the model.
3. Input: only the newest row that did not record is read. Its `input` is sent again as stored when its window has the
   same message ids and hashes and its `settingsFingerprint` is the task's. Otherwise the prompt is built anew, so
   changed instructions take effect and a regrouped window rebuilds.
4. Snapshot: a `pending` row holds the exact input before any call. An input too large for a record fails the run
   (`inputTooLarge`) with no call.
5. Call: `host.request`, on `writerHostDeps`: temperature 0, and no `jsonSchemaEnabled` or `extractJson`, which shape
   the chat's replies. A provider failure, an unusable answer, or a `MemoryHostFailure` ends the run `failed` with a
   redacted error and a failed receipt, and the task with it. Any other throw is an ended task: the row stays `pending`
   for the next run, and `commit` refuses, which is how output after the deadline is discarded.
6. Commit: event, threads, and the `recorded` run in one write, on the revision the opening write returned. A
   `revisionConflict` admits the answer again from fresh records with no call, 3 attempts in all, then `skipped`
   (`revisionConflict`). `staleInput` and `windowChanged` end it `skipped` and leave the row to step 2.
7. Warming: the trimmed event summary and key lines through `HypaProcesser.addText`, unless `laneTargets.events` is 0. A
   failure keeps the event. A retrieval that embeds other text misses this cache.

### Record now

"Record now" and resume are the `memoryRecord` command (`messageId` or none), a job and not a call on the service: the
service keeps no input across a restart, where `start` would only wait for the next send, and only a job's scope can
tell a slot that needs the tab. The tab calls `runServerJob` directly, because `runServerCommand` refuses a group chat.

1. Admission: refused when the algorithm is not selected, memory is off, the summarizer is local, or `messageId` is not
   an eligible char message. The job holds the chat's slot, so nothing generates then. No ceiling and no `messageId`
   ends `done`.
2. With a service and nothing tab-bound: `MemoryTasks.record` queues a fresh input, marked manual, with `through`. The
   latest press wins, one with no message clears it, and a later hand-off keeps both. It answers a refusal where
   `handOff` drops silently. The job ends at once, and the task starts after its terminal.
3. A Plugin `memory` slot, a `request` trigger, or no service: the writer runs in the job, as blocking HypaV3 does, on
   the chat's writer lease, because only `services.request` reaches the plugin provider and the trigger.
   `scope.request.db` takes `writerRequestDb`, the windows run in order up to `maxWriterWindows`, and the first that
   does not record ends the job with an error. Past the cap it is an ordinary `done`.

`through` is an `inclusive` ceiling (`WriterCeiling`): the windows run through that message, newest reply included,
because the press is its confirmation. They stay oldest first, so a press records the oldest open windows, never that
message ahead of them.

### The analysis prompt

`assembleAnalysisPrompt` parses the default ChatML frame and the preset's `instructions` with the slots in place, so CBS
runs on them alone, then fills the slots in one pass over the parsed messages. Chat text never reaches CBS, cannot start
a ChatML message, and a value holding a slot's name stays as it is. Message text stays raw so a quote can match, with
inlays shown as `[Image]`. `fineTuning` is not read yet. The language is the chat's override, the owner's, the preset's,
then `db.language`.

### Admission

`parseAnalysis` takes the text from the first brace to the last, after any `<Thoughts>`; the event may sit under
`event`. A missing or mistyped required field fails the run naming it. Strings clamp to the limits without splitting a
surrogate pair, a malformed element is left out, and a list stops at its cap, each counted once per field in `warnings`
(`malformed`, `capped`). Axes round and clamp, and an object lacking a score is no axes. Page candidates are not read.

`admitAnalysis` works from records read for that attempt:

- Evidence: a key line's text and each `quote` must be a contiguous piece of a window message's raw `data`, so a quote
  from context or across `[Image]` fails. It goes to `unverified` (`quoteNotFound`).
- Pages: a participant, `who`, or knower naming no page is removed with an `unknownPage` warning, an item with a quote
  goes to `unverified` (`unknownPage`), and a relationship shift naming none is left out with a warning.
- Threads: `add` opens one; `close`, then `transitions`, move only a thread that exists and has not ended (else
  `unknownThread`, `endedThread`), one write per thread, the last naming winning. `closedBy` is set on an end.
- Repeat: when the last stored event is active, has the same participants, a summary at `dedupeSimilarity` or above by
  character bigrams, and sources that still read from the chat, no event is made. That event takes `repeatCount + 1` and
  the window's sources, or the window would stay open forever; everything else on it stays, and thread changes name it.

## State

- The records a writer run leaves, and the tables holding them: [structured memory](structured-memory.md#memory-tables).
- The writer's settings are the selected memory preset's `settings.structured`, so they copy, export, and import with
  the preset. A chat's `structuredMemoryLanguage` wins over its owner's, and the owner's over the preset's `language`,
  where `""` follows `db.language`. A chat's `structuredMemoryHighlight` wins over the preset's `highlightMode`.
- `cadenceTokens` is the `tokens` cadence's threshold under a `tokens` budget mode, and `cadenceRatio` its share of the
  max context under a `ratio` one; each mode keeps the other's field.

## Coupling

- The writer is a task kind of the [memory task service](memory.md#background-memory-task): queue, retention, leases,
  and ends are shared, and the service's doc comment holds both kinds' rules. A cadence change moves
  `memorySettingsFingerprint`, so a queued writer input ends `skipped` (`staleInput`).
- The tab's fence (`src/ts/process/memoryTasks.svelte.ts`) applies to both kinds; `parseEntry` keeps a status's `kind`.
- The overrides are `keep` in `CHECKPOINT_CHAT_FIELDS`: a settings choice stays with the current chat when a checkpoint
  loads. Upstream has none of this: `METATRON_CHAT_FIELDS` and `METATRON_CHARACTER_FIELDS` strip the overrides, and
  `upstreamHypaV3Presets` leaves `structured` out.
- `memoryRecord` is a [generation](server-generation.md) `command` job; `recordJob.ts` shares the runner's job helpers
  (`createJobMemoryHost`, `jobMemoryTaskBase`, and the like).

## Invariants

- Invalid writer settings take their defaults field by field; one bad field never resets the others.
- Overrides are read only through `structuredMemoryLanguageOverride` and `structuredMemoryHighlightOverride`, which
  treat a bad stored value as unset. No normalizer deletes one: the tab holds what it sent, so a server-only deletion
  would make a later conflict merge against a record the server does not have.
- `memorySettingsFingerprint` digests `structured`, the overrides, and `db.language` only while `memoryAlgorithmType` is
  `structuredMemory`, so a change to them never marks another algorithm's queued task stale.
- A message is recorded when any stored event cites it, in any status, retracted and stale included: that only stops the
  writer recording it again automatically, so nothing brings back what the user retracted. It is not coverage: dropping
  raw history asks whether an active event covers it, and never reads this set.
- `confirmedBefore` is captured in the job's step. An automatic task never derives its ceiling from the chat as it
  stands later: an output trigger's `v2Impersonate` can append a user message after the reply, and that must not confirm
  the reply. A manual task does derive it, because the person's start is the confirmation; the writer's `input` keeps
  the captured value either way, and `commit` checks under the ceiling the windows used.
- `commit` checks the window against the chat as stored, because `chatSourceGeneration` moves only on a whole-chat
  replace or a delete, not on an edit, a removal, a disabled flag, or a continue. A source's `index` may move and fails
  nothing.
- `terminalRevision` and `lastCommittedRevision` stay chat revisions on both task kinds, because the tab's fence
  compares chat revisions. A memory revision never goes into a status.
- A HypaV3 input and status carry no `kind` key, so its frames stay byte-identical. `MemoryTaskInput` is HypaV3's shape.

## Recipes

- A new writer setting: `StructuredMemorySettings`, `normalizeStructuredMemorySettings`, and the fresh-boot fixture
  `src/ts/storage/tests/fixtures/boot/boot-snapshot.json`. The whole object already joins the fingerprint.

## Tests

- `server/src/tests/normalizeCollections.test.ts` drives the settings rules through `normalizeStructuredMemorySettings`,
  `createHypaV3Preset`, and `normalizeHypaV3Presets`.
- `server/src/tests/memoryTaskHost.test.ts` drives `memorySettingsFingerprint` on a real job scope, and
  `server/src/tests/upstreamExport.test.ts` drives what the upstream export leaves out.
- `server/src/prompt/memory/structured/window.test.ts` drives the window rules as a table over plain messages with a
  fake tokenizer.
- `server/src/tests/memoryTasks.test.ts` drives the task kind on `createMemoryTasks` over a real store: its windows with
  an injected `structuredWriter`, the writer itself with none, through the scripted provider and read back from
  `store.memory`. `memoryJobs.test.ts` drives the hand-off with `createFakeMemoryTasks`, `assemble.test.ts` the
  selection, and `src/ts/process/memoryTasks.test.ts` the status's `kind`.
- `structured/analysis.test.ts` and `prompts.test.ts` drive the pure pieces with plain values; `prompts.test.ts` parses
  with the real CBS evaluator.
- Record now: `memoryTasks.test.ts` for the lock refusal and `through`; `memoryJobs.test.ts` for the job's two paths on
  a real stack.
- Focused command:
  `pnpm --silent test:agent server/src/prompt/memory/structured/window.test.ts server/src/prompt/memory/structured/analysis.test.ts server/src/prompt/memory/structured/prompts.test.ts normalizeCollections memoryTaskHost upstreamExport memoryTasks memoryJobs assemble`.
  No `slow` or `e2e` membership of its own.

## Known Hazards

### Limitations

- A retried window replays its snapshot only while its messages group the same way: a failed manual partial window that
  a cadence later regroups rebuilds its prompt. A replay resends the context as it was. Decision: Structured Memory D3,
  plan.
- An interrupted run never counts toward the pause, so a model that only ever overruns the task deadline does not pause
  recording. Decision: Structured Memory D3, plan.
- Record now has no cost preview, which D3 asks for: `maxWriterWindows` bounds a press, and the previewed path is
  backfill. Decision: Structured Memory slice 2d, plan.
- Recording in a job sets no `memoryTaskFenced` fence and no task status: only the pressing tab sees it, through its
  button and the `memoryProgress` overlay, as with a blocking HypaV3 summary. The job holds the chat's slot and the
  lease. A throw there leaves the run `pending` with no failed receipt, and the next run closes it `interrupted`.
  Decision: Structured Memory slice 2d, plan.

### Gotchas

- Until a chat has pages, every participant is removed and every item naming a page is left out of the event, so an
  event holds its title, summary, key lines, and thread changes.
- `memory_runs.input` is never pruned, so a run costs about its prompt in storage. `inputTokens` counts one attempt
  though `host.request` may retry, and `maxResponse` bounds the answer, so a low value fails runs on truncated JSON.
- Every numeric default in `normalizeStructuredMemorySettings` is a starting value too; the required cap and the lane
  targets add up to the default `memoryBudgetTokens`. Only the cadence, highlight mode, and highlight kinds defaults are
  owner decisions.
- A character's language override does not travel in a card: the card exporters use explicit field lists.
- `readRecordedMessages` reads every stored event of the chat once per send and once per task, because the store has no
  bulk read, so its cost grows with the chat's events.
