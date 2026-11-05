# Structured Memory Writer: Windows, Tasks, Runs, Admission, Pages

## Scope

- Owns the `structuredMemory` writer: its settings and their overrides, the windows it records, its task kind in the
  memory task service, a writer run, the analysis and patch prompts, admission of the model's answer, the pages it
  maintains, and record now with the `memoryRecord` job.
- Paths: `server/src/prompt/memory/structured/{window,writer,prompts,analysis,pages,patches,compact,recordJob}.ts`, the
  writer's task kind in `server/src/prompt/memory/memoryTasks.ts`, and `structuredMemoryStep` in
  `server/src/prompt/assemble.ts`.
- See [structured memory](records.md) for how the algorithm is selected, and
  [the archive](../../archived-plan/README.md) for the design and remaining work.
- Not here:
  - The records, the projection, the read path, the lifecycle, the rebuild, and the page tools →
    [the area README](README.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](../memory.md).
  - The resource store's connection, epoch, and transactions → [server resources](../server-resources.md).

## Files

- `shared/structuredMemory.ts`: writer settings and pure rules; `StructuredMemorySettings`,
  `normalizeStructuredMemorySettings`, `STRUCTURED_MEMORY_CADENCES`, `STRUCTURED_MEMORY_HIGHLIGHT_MODES`,
  `STRUCTURED_MEMORY_HIGHLIGHT_KINDS`, `structuredMemoryLanguageOverride`, `structuredMemoryHighlightOverride`,
  `structuredMemoryWriterLanguage`, `MEMORY_SECTION_BUDGETS`, `memorySectionOverBudget`, `writerPaused`.
- `shared/memory.ts`: preset settings shape; `HypaV3Settings.structured`.
- `shared/hypaV3Presets.ts`: preset defaults; `createHypaV3Preset`.
- `server/src/jobs/jobScope.ts`: task settings digest; `memorySettingsFingerprint`.
- `server/src/prompt/memory/structured/window.ts`: confirmed writer windows; `confirmedWindows`, `WriterWindow`,
  `WriterCeiling`, `writerCeiling`, `writerCadence`, `recordedMessages`, `readRecordedMessages`, `readRerecordEvents`,
  `confirmedThrough`, `windowStillConfirmed`, `windowOf`.
- `server/src/prompt/memory/structured/prompts.ts`: prompt frames and safe slot filling; `analysisSlots`,
  `assembleAnalysisPrompt`, `patchSlots`, `assemblePatchPrompt`, `compactSlots`, `assembleCompactPrompt`,
  `parseCustomFrame`, `defaultPrompts`, `sceneTakenBackLines`.
- `server/src/prompt/memory/structured/analysis.ts`: answer parsing and evidence admission; `parseAnalysis`,
  `admitAnalysis`.
- `server/src/prompt/memory/structured/pages.ts`: writer page planning and changes; `castSlice`, `planPages`,
  `aliasSeeds`, `windowSpeaker`, `newScenePage`, `changeSection`, `rewriteScene`, `sectionVectorText`,
  `changedSectionTexts`.
- `server/src/prompt/memory/structured/patches.ts`: patch admission and page commit gathering; `showTargets`,
  `parsePatches`, `applyPatches`, `commitPages`.
- `server/src/prompt/memory/structured/compact.ts`: section compaction admission; `compactionTargets`, `readCompaction`,
  `applyCompactions`.
- `server/src/prompt/memory/structured/writer.ts`: run lifecycle and guarded writes; `createStructuredWriter`,
  `commitWindow`, `writerRequestDb`, `writerHostDeps`, `adoptionHold`, `chatAdoptionHold`, re-exported `writerPaused`.
- `server/src/prompt/memory/structured/recordJob.ts`: manual recording jobs and send-approved gaps; `runMemoryRecord`,
  `admitRecord`, `recordGapInJob`, `RECORD_REFUSALS`.
- `server/src/prompt/memory/memoryTasks.ts`: writer task kind in the shared service; `createMemoryTasks`,
  `StructuredMemoryWriter`, test-injected `structuredWriter`, `StructuredMemoryWriterResult`, `StructuredMemoryCommit`,
  `MemoryTaskLimits.maxWriterWindows`.
- `server/src/prompt/assemble.ts`: send read and writer hand-off; `structuredMemoryStep`, `writerNotice`, runner-filled
  `AssemblyMemoryJob.structuredMemory`.
- `shared/jobs.ts`: task input and status contracts; `StructuredMemoryTaskInput`, `MemoryTaskBase`,
  `AnyMemoryTaskInput`, `MemoryTaskStatus.kind`.

## Flows

### The writer's windows

`confirmedWindows` derives work from stored messages and events, so losing the task queue on restart loses no work;
there is no startup scan. Its comment owns eligibility, turns, cadence, token thresholds and manual partial windows.
`WriterWindow` and `windowOf` own the paired messages and source anchors. Reroll candidates enter no window: windows
read `data`, the selected candidate.

The job captures `writerCeiling` before its reply. An automatic task uses that captured ceiling; a manual task uses
`through` inclusively, else the stored chat's ceiling, else the captured one. A missing, disabled or
`allBefore`-excluded ceiling ends a task `skipped staleInput`; commit revalidation refuses `windowChanged`.

A person's press re-records marked events ahead of ordinary work. An automatic task and assembly's `due` take only
`automaticRerecords`, so a restored mark or one on unchanged text waits for a press. The windows count an adopted
event's `sources` as recorded too, keeping [adoption](lifecycle.md#adopting-hypav3-summaries) from automatically
recording them again. `rerecordWindows` and `confirmedWindows` own repair eligibility and ordering details.

### The writer task

`db.memoryAlgorithmType === "structuredMemory"` selects `structuredMemoryStep` ahead of the flag chain in
`server/src/prompt/assemble.ts`. The writer is the [memory task service](../memory.md#background-memory-task)'s second
kind. The step [reads](read.md#the-read-path) before it returns the hand-off; `confirmedWindows` at `limit: 1` supplies
`due`.

An input job with a service and source-generation-bound chat snapshot returns a hand-off even when not due:
`handOffMemory` needs it for waiting manual starts. Unlike HypaV3 it skips the blocking-reason precheck. The step asks
`memoryGap` when trimmed tokens exceed `gapConfirmTokens`, using manual-start windows as `plannedCalls`; no windows or a
local summarizer means no question. History cited by stale or retracted events counts as recorded, so a gap can offer no
window. `generate` runs [the gap](#the-gap-run), then rereads and selects without asking again.

A [held chat](lifecycle.md#the-adoption-choice), `MemoryRecords.adoptionHeld`, gets neither gap question nor hand-off,
keeping a waiting manual start until after the choice. `writerNotice` gives its reply a `notAutomatic` receipt with
`awaitingAdoption` ahead of other reasons. The send also owns the plugin, trigger, local-model and pause
[notices](read.md#receipts), independently of whether a task will run.

`createMemoryTasks` applies its shared start checks, including `notStructuredMemory` if the algorithm changed. A Plugin
`memory` slot, a `request` trigger or a local summarizer ends `skipped` with `pluginModel`, `requestTrigger` or
`localSummarization`. The fresh scope's chat and stored events give windows up to `maxWriterWindows`; each goes to
`createStructuredWriter` in order. The first skipped or failed window ends the task, keeping events in message order; a
throw uses `endFromError`. `total` counts allowed windows, `done` recorded windows, and no work ends `done` 0 of 0. The
service comment owns cap continuation (`windowsLeft`, another manual start under `manual`) and `warmingFailed`.

The synchronous `commit(baseRevision, changes)` crosses the service, repair logic and writer in this order:

1. `memoryTasks` checks the task is live (throws after its end), the gate is open, and the service, epoch and source
   generation still match; a stale input is refused `staleInput`.
2. For a closing write carrying the replacement event, `retireRerecorded` refuses `windowChanged` if the old event is
   gone, unmarked or retracted. It transfers `pinned`, `suppressed` and `userCorrected` to the replacement and retracts
   the old event, with [its sections flagged](lifecycle.md#retraction-and-edits), in the same change set.
3. `commitWindow` checks the stored chat and `windowStillConfirmed` under the window's own ceiling, `messagesLocked`,
   then the chat's [rebuild run](rebuild.md#during-a-run), then adoption hold. These refuse `windowChanged`: locks can
   precede a continue's changed hash, and metadata or an algorithm switch can introduce a hold after admission.
4. The store checks the memory revision (`revisionConflict`). A refused commit writes nothing. A committed run's receipt
   is then copied to its window's assistant messages; `commitWindow` owns the separate chat-write contract.

`recordJob` wraps its commit with the same repair swap. A failed re-record leaves the old event and its mark until a
replacement commits. Reconciliation holds no fence; a running writer meets `revisionConflict` or `windowChanged`.

### A writer run

`createStructuredWriter` reads and writes through the `memory` it is given: live records or
[a rebuild's staged set](rebuild.md#a-run), including staged runs for replay. `openRun` owns interrupted-row cleanup and
the pre-call snapshot; the writer's comments own pause, request failures, custom prompts and dry runs. A `historical`
write [leaves current state alone](rebuild.md#backfill).

A held chat ends any run, including manual, `skipped awaitingAdoption` with no call or row. Automatic runs honor
`writerPaused`; manual starts bypass it. The newest nonrecorded row supplies replay input only when message ids and
hashes, `settingsFingerprint` and prompt mode match; that input includes the current scene's taken-back lines. A
mismatch rebuilds the prompt.

Calls cross pure modules before one closing write:

1. `prompts` assembles input for `host.request` under `writerHostDeps`/`writerRequestDb` (temperature 0,
   `jsonSchemaEnabled` off, `extractJson` empty). `parseAnalysis` parses the answer; `planPages` establishes identities
   before `admitAnalysis` resolves references and admits evidence. A repeat is replanned and admitted again.
2. Shown targets go through [the patch call](#the-patch-call), then [compaction](#compaction). An analysis or patch
   failure before the closing commit leaves no event, keeping the window open. The writer's comment owns retained
   `analysis`, `patchInput`, redacted errors, failed receipts and token accounting.
3. Event, threads, pages and the recorded run commit together, first on the opening revision. `revisionConflict` repeats
   planning and admission from fresh records without another call, three attempts total. Three conflicts end
   `skipped revisionConflict`; that, `staleInput` and `windowChanged` leave the opening row pending for the next start.
   Before the closing commit, a deadline or abort also leaves a pending row; the caller's ended-write check discards
   late output.
4. After the recorded commit, warming sends `eventVectorTexts` and changed non-scene `sectionVectorText` through
   `HypaProcesser.addText`, unless the respective `laneTargets.events` or `laneTargets.pages` is 0. A returned
   `warmingError` or a throw preserves the recorded row. Thrown aborts and `MemoryHostFailure` propagate to the
   service's `endFromError`. A retrieval must embed the same text to hit that cache.

During model calls before the closing commit, a `MemoryHostFailure` attempts a failed-row write before propagating;
other throws leave the pending row. A compaction call's returned failure or unusable answer is a warning and the run
continues; throws still propagate.

### Record now

A press past one window asks first, with [the cost preview](rebuild.md#the-cost-preview). Record now and resume use the
`memoryRecord` command, with `messageId` or none. It is a job: the service retains no input across restart, and only a
job's fresh scope knows which requests need the tab. The tab calls `runServerJob` directly because `runServerCommand`
refuses group chats.

`runMemoryRecord` admits through `admitRecord` while the job holds the chat slot; its module header owns algorithm,
memory-off, local-model, adoption and eligible-message refusals. No ceiling and no target ends `done` without work.

- With a service and no tab-bound request, `MemoryTasks.record` queues a fresh manual input with `through`; the latest
  press replaces that target and a press without one clears it. A later hand-off retains the manual start and target.
  Unlike `handOff`, this returns a refusal to the job. The job ends before the task starts.
- With a Plugin `memory` slot, a `request` trigger (`jobMemoryBlockingReason` in `server/src/prompt/runner.ts`) or no
  service, the writer runs inside the job on the chat's writer lease, because `services.request` reaches those tab-bound
  requests. `scope.request.db` takes `writerRequestDb`; windows run in order up to `maxWriterWindows`, the first
  nonrecorded window ends the job with an error, and windows beyond the cap leave an ordinary `done`.

A target is an inclusive `WriterCeiling`: pressing confirms that reply, newest included. Re-record windows (events
marked `rerecord`) run first, then ordinary windows oldest first; naming a target never records it ahead of older open
ordinary windows.

### The gap run

`recordGapInJob` shares `runWindows` with record now inside a send's job. This is the one recording that holds up a
send: a person accepted a question promising it before the reply. `confirmMemoryGap` in `server/src/prompt/runner.ts`
reuses `generate` for later rounds and speakers, while `JobRunState.memoryGapRecorded` permits only the first recording.

It runs manual on the chat's lease, bypassing pause, up to `maxWriterWindows`, with the input's exclusive ceiling and
the `initial` run's stop control between windows. It takes no repair marks. `scope.request` takes `writerRequestDb` only
around this run, restoring the reply's temperature and schema afterwards.

A nonrecorded window ends the gap quietly and the send continues. Any run or receipt already written stays stored; a
skipped window need not create either. Aborts and latched failures still end the job. It never calls `markStopped`,
which would clear the `blockingReason` a reply's receipt reads. Assembly keeps its chat snapshot: a receipt changes no
source hash, and a message edit during the run can leave one send with a slightly stale prompt.

### Pages and calls

The module comments own the per-call rules: `assembleAnalysisPrompt` and `parseCustomFrame` for safe ChatML/CBS slot
filling and [fine-tuning](read.md#prompt-fine-tuning); `parseAnalysis`/`admitAnalysis` for bounded parsing, quotes,
references, threads and repeat admission; `castSlice`/`planPages` for cast selection, identities, alias seeds and the
group speaker. `planPages` and `admitAnalysis` run against fresh records for each attempt; prompt assembly and answer
parsing do not rerun on closing-commit retries.

`commitPages` gathers created pages, patches, compactions, relationship links and scene changes into one map by page id,
because the store refuses duplicate writes of an id in one change set. `changeSection` stamps bounded evidence, history,
marks and highlights; the chat-or-preset rule comes from the writer's `highlightRule`, with rebuilds using `none`. An
empty patch result still leaves a created identity so admitted references remain valid. Repeat planning creates no
candidate pages or patch targets and refuses candidates `repeatedEvent`; `commitPages` still creates a missing scene
page and applies the scene rewrite.

### The scene page

`commitPages` creates the first scene even when analysis returned none: `newScenePage` gives it type `scene`, title
`Scene` and `contextMode: "always"`. Candidates cannot target it. Analysis can rewrite `place`, `time`, `state` and
attendance without a patch call; `rewriteScene` owns blank/identical fields, per-section locks, reverted text and
history (`create` on first text, otherwise `change`). `readMemoryRecords` exposes `participants` as `stage` to the read
path. The prompt's taken-back lines survive the scene clamp and gate replay, so a revert is seen on the next call.

`server/src/data/memoryStore.ts` holds the store rule: partial unique index `memory_pages_scene`, plus pre-write
`ResourceValidationError` for two scene pages in a set or a new one while another remains outside `remove.pages`.
`walkMemorySnapshot` also refuses duplicate scenes before the staged store. A live write refuses losing or retyping the
scene it has; replacing it in one set is legal. Restore may load a snapshot with no scene, predating that page, but
still rejects a second scene.

### The patch call

`showTargets` supplies the accepted pages to `assemblePatchPrompt`, alongside the admitted event and no messages. An
item whose quote failed admission cannot reach a page; its text must trace to the `provenance` event. Default inputs are
bounded under `RUN_RECORD_MARGIN_BYTES`; custom frames get a separate pre-call size check.

`parsePatches` and `applyPatches` own operations, conflict classes, the refusal codes and whole-page admission. Their
comments define each refusal code. Page refusal is a warning: other pages and the event still commit. The writer keeps
the patch input with its closing run, without a separate pending write; a failed call leaves the window open for a retry
from analysis.

### Compaction

`MEMORY_SECTION_BUDGETS` in `shared/structuredMemory.ts` gives each page type its `body.length` budget below the hard
`sectionBodyChars` limit. After patches, the writer uses a dry `commitPages` result to ask `compactionTargets` for
changed, over-budget non-scene sections. Its comments own target exclusions; `readCompaction` and `applyCompactions` own
shorter-body validation and the warning codes. The closing write recomputes changes rather than committing the dry
result; planned new-page ids and `sceneId` stay stable across attempts. Events never enter compaction.

Each target gets one call through `assembleCompactPrompt`, whose slot filling keeps section text out of CBS; there are
no messages, and fine-tuning keeps this default frame. The run stores neither its prompt nor its answer. Returned
failures warn without failing the run; `MemoryHostFailure` and other throws propagate as for the patch call.

`applyCompactions` runs inside `commitPages` after patches, through `changeSection` with kind `compact`. A patch and its
compaction thus leave two history entries and two receipt rows in one commit, with the long body as the second `before`,
and hashes and `historyId` on each row. The Pages tab shows the history diff; the receipt shows the warning.
`changedSectionTexts` warms the final shorter body.

## State

- The records a writer run leaves, and the tables holding them: [structured memory](records.md#memory-tables).
- The writer's settings are the selected memory preset's `settings.structured`, so they copy, export, and import with
  the preset. A chat's `structuredMemoryLanguage` wins over its owner's, and the owner's over the preset's `language`,
  where `""` follows `db.language`. A chat's `structuredMemoryHighlight` wins over the preset's `highlightMode`.
- `MemorySettings.svelte` exposes only the fields something reads, and shares with HypaV3 only the preset picker, the
  budget mode, and the memory maximum. `screening`: [its rules](read.md#reply-screening). So a preset's
  `summarizationModel` and `alwaysToggleOn` still apply with no control here.
- `cadenceTokens` is the `tokens` cadence's threshold under a `tokens` budget mode, and `cadenceRatio` its share of the
  max context under a `ratio` one; each mode keeps the other's field.

## Coupling

- The writer is a task kind of the [memory task service](../memory.md#background-memory-task): queue, retention, leases,
  and ends are shared, and the service's doc comment holds both kinds' rules. A cadence change moves
  `memorySettingsFingerprint`, so a queued writer input ends `skipped` (`staleInput`).
- The tab's fence (`src/ts/process/memoryTasks.svelte.ts`) applies to both kinds; `parseEntry` keeps a status's `kind`.
- The overrides are `keep` in `CHECKPOINT_CHAT_FIELDS`: a settings choice stays with the current chat when a checkpoint
  loads. Upstream has none of this: `METATRON_CHAT_FIELDS` and `METATRON_CHARACTER_FIELDS` strip the overrides, and
  `upstreamHypaV3Presets` leaves `structured` out.
- `memoryRecord` is a [generation](../server-generation.md) `command` job; `recordJob.ts` shares the runner's job
  helpers (`createJobMemoryHost`, `jobMemoryTaskBase`).
- `analysis.ts` and `patches.ts` share `answerJson`, `readList`, and `readConfidence`; `sectionVectorText` is the text a
  retrieval of sections must embed.

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
- `memoryTaskHost.test.ts` drives `memorySettingsFingerprint` on a real job scope, and `upstreamExport.test.ts` what the
  upstream export leaves out.
- `structured/window.test.ts` drives the window rules as a table over plain messages with a fake tokenizer, repair
  windows included. `structured/reconcile.test.ts` drives the swap, and `memoryTasks.test.ts` a repair through the real
  writer.
- `server/src/tests/memoryTasks.test.ts` drives the task kind on `createMemoryTasks` over a real store: its windows with
  an injected `structuredWriter`, the writer itself with none, through the scripted provider and read back from
  `store.memory`. `memoryJobs.test.ts` drives the hand-off with `createFakeMemoryTasks`, `assemble.test.ts` the
  selection, `src/ts/process/memoryTasks.test.ts` the status's `kind`, and `ContextMeter.svelte.test.ts` its wording.
- `structured/analysis.test.ts`, `pages.test.ts`, `patches.test.ts`, `compact.test.ts`, and `prompts.test.ts` drive the
  pure pieces with plain values; `prompts.test.ts` parses with the real CBS evaluator. The one-scene rule is in
  `memoryStore.test.ts` and `restoreStage.test.ts`.
- Compaction's calls and its one commit: `memoryTasks.test.ts`. `recordJob.ts` runs the same writer, with no test of its
  own.
- Record now: `memoryTasks.test.ts` for the lock refusal and `through`; `memoryJobs.test.ts` for the job's two paths on
  a real stack.
- Focused command:
  `pnpm --silent test:agent server/src/prompt/memory/structured/ normalizeCollections memoryTaskHost upstreamExport memoryStore restoreStage memoryTasks memoryJobs assemble`.
  No `slow` or `e2e` membership of its own.

## Known Hazards

### Limitations

- A retried window replays its snapshot only with unchanged message grouping: cadence regrouping a failed manual partial
  window rebuilds its prompt. Replay resends the original context. Decision: Structured Memory D3, archive.
- An interrupted run never counts toward the pause, so a model that only ever overruns the task deadline does not pause
  recording. Decision: Structured Memory D3, archive.
- An edit during a reply is picked up by the send after it: `due` is read before the reply, and the marks wait.
  Decision: Structured Memory slice 5b, archive.
- A failed patch call costs the retry its analysis call again: the window replays from the start, because one page
  refresh must not close a window. Decision: Structured Memory D3, archive.
- A page locked or changed in a way a patch cannot apply is refused whole, so one bad patch delays that page's other
  changes to a later window. Decision: Structured Memory D3, archive.
- Section evidence keeps the newest `sectionEvidence`, so a section can read `unsupported` while an older dropped event
  still supports it. Decision: Structured Memory slice 4a, archive.
- A section whose `userCorrected` stands is never compacted, and can grow by disputed joins until `sectionTooLong`
  refuses its page's patches. The person trims it. A section a failed or discarded compaction left long waits for its
  next change. Decision: Structured Memory D13, archive.
- `takenBack` is advice: code compares a patch with it nowhere, so a model can write the text again. Only a scene field
  is held. Decision: Structured Memory slice 7b, archive.
- Budgets are per section in characters, so they do not keep the required lane under `requiredCap`. Compaction runs
  before the commit, so a deadline during one costs the run its analysis and patch calls, and a person pressing record
  now waits for it. `compactionFailed` holds no provider text. Decision: Structured Memory D13, archive.
- Recording in a job sets no `memoryTaskFenced` fence and no task status: only the pressing tab sees it, through its
  button and the `memoryProgress` overlay, as with a blocking HypaV3 summary. The job holds the chat's slot and the
  lease. A throw there leaves the run `pending` with no failed receipt, and the next run closes it `interrupted`.
  Decision: Structured Memory slice 2d, archive.

### Gotchas

- An event recorded before its chat had pages holds its title, summary, key lines, and thread changes: its participants
  were removed and items naming a page left out.
- `memory_runs.input` is never pruned, so a run costs about its prompt in storage. `inputTokens` counts one attempt
  though `host.request` may retry, and `maxResponse` bounds the answer, so a low value fails runs on truncated JSON.
- `MEMORY_SECTION_BUDGETS` are starting values with no setting; `memorySectionOverBudget` is the one test of them.
- Every numeric default in `normalizeStructuredMemorySettings` is a starting value too; the required cap and the lane
  targets add up to the default `memoryBudgetTokens`. Only the cadence, highlight mode, and highlight kinds defaults are
  owner decisions.
- A character's language override does not travel in a card: the card exporters use explicit field lists.
- `readMemoryRecords` and `readRecordedMessages` read every stored event of the chat, once per send and once per task,
  because the store has no bulk read, so their cost grows with the chat's events.
