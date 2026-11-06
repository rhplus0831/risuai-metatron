# Structured Memory Writer: Windows, Tasks, Runs, Admission, Pages

## Scope

- Owns the `structuredMemory` writer: its settings and their overrides, the windows it records, its task kind in the
  memory task service, a writer run, the analysis and patch prompts, admission of the model's answer, the pages it
  maintains, and record now with the `memoryRecord` job.
- Paths: `server/src/prompt/memory/structured/{window,writer,prompts,analysis,pages,patches,compact,recordJob}.ts`, the
  writer's task kind in `server/src/prompt/memory/memoryTasks.ts`, and `structuredMemoryStep` in
  `server/src/prompt/assemble.ts`.
- Algorithm selection: [structured memory](records.md); design and remaining work:
  [the archive](../../archived-plan/README.md).
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
  `WriterCeiling`, `writerCeiling`, `writerCadence`, `recordedMessages`, `readRecordedMessages`, `historicalWindow`,
  `readRerecordEvents`, `confirmedThrough`, `windowStillConfirmed`, `windowOf`.
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

`confirmedWindows` derives pending work from stored messages and events, so a restart loses no work. The `window.ts`
header owns confirmation, turns, cadence, screening and manual partial-window rules; `WriterWindow` and `windowOf` pair
message data with fresh source anchors.

A person's press takes every repair mark before ordinary work. Automatic work takes only marks explained by an edit
(`automaticRerecords`), so a restored mark or one whose text was put back waits for a press. Adopted event sources count
as recorded, keeping [adoption](lifecycle.md#adopting-hypav3-summaries) from automatically recording them again.

### The writer task

`db.memoryAlgorithmType === "structuredMemory"` selects `structuredMemoryStep` ahead of the flag chain in
`server/src/prompt/assemble.ts`. The writer is the [memory task service](../memory.md#background-memory-task)'s second
kind. The step [reads](read.md#the-read-path) before it returns the hand-off; `confirmedWindows` at `limit: 1` supplies
`due`.

An input job with a service and source-generation-bound chat snapshot can hand off even when not due: `handOffMemory`
needs it for a waiting manual start. Unlike HypaV3, the step skips the blocking-reason precheck. It asks `memoryGap`
when trimmed tokens exceed `gapConfirmTokens`; [the gap run](#the-gap-run) records an accepted answer and the next
selection does not ask again. The assembly comment owns the question's window and refusal rules.

A [held chat](lifecycle.md#the-adoption-choice) gets neither a gap question nor hand-off, keeping the manual start until
after the choice. Send notices and `writerNotice` receipts are described in [read](read.md#receipts).

`createMemoryTasks` owns shared start checks, skip codes, caps, status and continuation. It plans up to
`maxWriterWindows` from a fresh scope and runs them in order; the first non-recorded result ends the task. The service
comment defines `total`, `done`, zero-work and cap behavior.

The synchronous `commit(baseRevision, changes)` crosses the service, repair logic and writer in this order:

1. `memoryTasks` checks the task is live (throws after its end), the gate is open, and the service, epoch and source
   generation still match; a stale input is refused `staleInput`.
2. For a closing write carrying the replacement event, `retireRerecorded` refuses `windowChanged` if the old event is
   gone, unmarked or retracted, else retracts it in the same change set, handing its marks and
   [thread provenance](lifecycle.md#retraction-and-edits) to the replacement.
3. `commitWindow` checks the stored chat and `windowStillConfirmed` under the window's own ceiling, `messagesLocked`,
   then the chat's [rebuild run](rebuild.md#during-a-run), then adoption hold. These refuse `windowChanged`: locks can
   precede a continue's changed hash, and metadata or an algorithm switch can introduce a hold after admission.
4. The store checks the memory revision (`revisionConflict`). A refused commit writes nothing. A committed run's receipt
   is then copied to its window's assistant messages; `commitWindow` owns the separate chat-write contract.

`recordJob` wraps its commit with the same repair swap. A failed re-record leaves the old event and its mark until a
replacement commits. Reconciliation holds no fence; a running writer meets `revisionConflict` or `windowChanged`.

### A writer run

`createStructuredWriter` reads and writes through the `memory` it receives: live records or a
[rebuild's staged set](rebuild.md#a-run). `writer.ts` owns replay eligibility, the run row, pause and failure behavior,
custom prompts, dry runs and warming. A historical write [leaves current state alone](rebuild.md#backfill).

Across modules, each window opens a `pending` run with its exact analysis input, then parses and admits the analysis
before deciding whether to call the patcher. Compaction follows only after patches; event, threads, pages and run close
in one memory write. A revision conflict rebuilds planning against fresh records without another model call, up to three
attempts. Only a recorded commit warms vectors, using the same event and section text that retrieval embeds. Returned
compaction failures are warnings; an analysis or patch failure leaves no event.

### Record now

A press past one window asks first, with [the cost preview](rebuild.md#the-cost-preview). Record now and resume use the
`memoryRecord` command with a target message or none. A target is an inclusive `WriterCeiling`; the window planner still
runs marked events first, then older ordinary work. The `recordJob.ts` header owns admission and the two execution
paths. The tab calls `runServerJob` because `runServerCommand` refuses group chats.

Without a tab-bound request, the job queues a fresh manual input and ends before the service starts; a later hand-off
retains that manual start and target. With a Plugin `memory` slot, a `request` trigger, or no service, the job holds the
writer lease and runs the windows itself because those requests need the job's tab context. `openJobStatus` publishes
the job writer through the service registry, fencing tabs through the terminal chat revision. The command's
`done.result.memoryRecord` selects the `completed` or `queued` toast; a skipped window is translated by `alertJobError`
from `memoryRecordSkipped`.

### The gap run

`recordGapInJob` shares the window runner with record now, but it is the one recording that holds up a send: a person
accepted the gap question before the reply. `confirmMemoryGap` can reuse generation for later rounds and speakers;
`JobRunState.memoryGapRecorded` allows only the first record. It runs under the send's exclusive ceiling and stop
control, takes no repair marks, and restores the reply's request settings afterwards. A non-recorded window ends the gap
quietly and the send continues; completed run and receipt writes stay stored. The send keeps its original chat snapshot,
so edits made during the run can leave its prompt stale.

### Pages and calls

The module comments own each call's rules: `assembleAnalysisPrompt` and `parseCustomFrame` for prompt construction and
[fine-tuning](read.md#prompt-fine-tuning); `parseAnalysis`/`admitAnalysis` for answer admission; `castSlice`/`planPages`
for cast and page identities. Across them, planning and admission precede target selection, and `commitPages` gathers
page, scene and link changes by id for one store write.

`changeSection` starts evidence afresh for a replaced body, retains it when a disputed join or identical text remains,
and keeps `disputed` while the body still holds the join. Highlights follow the chat-or-preset rule, with rebuilds using
`none`; `addLinks` puts shift destinations first and keeps the newest `pageRefsPerItem` links. `promptThreads` gives
threads about people on stage priority over older ones. Repeat planning refuses candidate pages but still creates a
missing scene page and applies the scene rewrite.

### The scene page

The scene is created by `commitPages` even when analysis returns none; its fields are rewritten without a patch call.
`newScenePage` and `rewriteScene` own the page rules, while the store's `memory_pages_scene` index and snapshot walk
enforce one scene page. The read path exposes scene attendance as `stage`.

### The patch call

`showTargets` passes the admitted event and writable pages to `assemblePatchPrompt`; no writable targets means no call.
`parsePatches` and `applyPatches` own operation, conflict and whole-page admission rules. `PATCH_RULES` in `prompts.ts`
distinguishes durable character `identity` facts from passing `currentState` and asks the model to update identity when
a lasting trait changes. A page refusal is a warning: other pages and the event still commit.

### Compaction

`MEMORY_SECTION_BUDGETS` and `MEMORY_CHARACTER_SLOT_BUDGETS` set the section limits. After patches, a dry `commitPages`
identifies changed sections past budget; each eligible non-scene section gets one default-frame call. `compact.ts` owns
target exclusions and answer warnings. The final commit recomputes pages with stable new-page and scene ids, then
applies shorter bodies through `changeSection` so the patch and compaction each get a history entry in one write.
Compaction changes no event, and a warning does not fail the run.

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
- `analysis.ts` and `patches.ts` share `answerJson`, `readList`, and `readConfidence`.

## Invariants

- Invalid writer settings take their defaults field by field; one bad field never resets the others.
- Overrides are read only through `structuredMemoryLanguageOverride` and `structuredMemoryHighlightOverride`, which
  treat a bad stored value as unset. No normalizer deletes one: the tab holds what it sent, so a server-only deletion
  would make a later conflict merge against a record the server does not have.
- `memorySettingsFingerprint` digests `structured` without its highlight fields, the language overrides (not the chat's
  highlight either: a highlight only marks a commit), and `db.language` only while `memoryAlgorithmType` is
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
- Compaction's calls and its one commit: `memoryTasks.test.ts`.
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
- A section whose text is retained by an identical upsert, disputed join, or compaction keeps only the newest
  `sectionEvidence`; an older dropped event can still support it while the section reads `unsupported`. Decision:
  Structured Memory slice 4a, archive.
- A section whose `userCorrected` stands is never compacted, and can grow by disputed joins until `sectionTooLong`
  refuses only that section's patch; the page's other edits can still apply. The person trims it. A section a failed or
  discarded compaction left long waits for its next change. Decision: Structured Memory D13, archive.
- `takenBack` is advice: code compares a patch with it nowhere, so a model can write the text again. Only a scene field
  is held. Decision: Structured Memory slice 7b, archive.
- Budgets are per section in characters, so they do not keep the required lane under `requiredCap`. Compaction runs
  before the commit, so a deadline during one costs the run its analysis and patch calls, and a person pressing record
  now waits for it. `compactionFailed` holds no provider text. Decision: Structured Memory D13, archive.
- An abort or unexpected non-`MemoryHostFailure` throw before the closing write can leave a job's run `pending` with no
  failed receipt; the next start closes it `interrupted`. A `MemoryHostFailure` attempts a failed-row write. Without a
  service the job publishes no task status. Decision: Structured Memory slice 2d, archive.
- A repair never carries an edit into later state; a rebuild from that point does. A later event with every cited
  message deleted no longer counts. Decision: Implementation Audit Fixes Q3.

### Gotchas

- An event recorded before its chat had pages holds its title, summary, key lines, and thread changes: its participants
  were removed and items naming a page left out.
- `memory_runs.input` is never pruned, so a run costs about its prompt in storage. `inputTokens` counts one attempt
  though `host.request` may retry, and `maxResponse` bounds the answer, so a low value fails runs on truncated JSON.
- `MEMORY_SECTION_BUDGETS` are starting values with no setting.
- Every numeric default in `normalizeStructuredMemorySettings` is a starting value too; the required cap and the lane
  targets add up to the default `memoryBudgetTokens`. Only the cadence, highlight mode, and highlight kinds defaults are
  owner decisions.
- A character's language override does not travel in a card: the card exporters use explicit field lists.
- `readMemoryRecords`, `readRecordedMessages` and `historicalWindow` read every stored event of the chat (per send, task
  or window), and `buildPrompt` every open thread: the store has no bulk read.
