# Structured Memory Writer: Windows, Tasks, Runs, Admission, Pages

## Scope

- Owns the `structuredMemory` writer: its settings and their overrides, the windows it records, its task kind in the
  memory task service, a writer run, the analysis and patch prompts, admission of the model's answer, the pages it
  maintains, and record now with the `memoryRecord` job.
- Paths:
  `server/src/prompt/memory/structured/{window,writer,prompts,analysis,pages,patches,compact,recordJob,testRun}.ts`, the
  writer's task kind in `server/src/prompt/memory/memoryTasks.ts`, and `structuredMemoryStep` in
  `server/src/prompt/assemble.ts`.
- See [structured memory](structured-memory.md) for how the algorithm is selected, and
  [the archive](../archived-plan/README.md) for the design and remaining work.
- Not here:
  - Record shapes and limits, the tables and store, read routes, the Markdown package, and the HypaV3 projection →
    [structured memory](structured-memory.md).
  - The read path, and the receipts and panel in the tab → [structured memory read path](structured-memory-read.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](memory.md).
  - The resource store's connection, epoch, and transactions → [server resources](server-resources.md).

## Files

- `shared/structuredMemory.ts`, the writer's part:
  - Writer settings: `StructuredMemorySettings`, `normalizeStructuredMemorySettings`, `STRUCTURED_MEMORY_CADENCES`,
    `STRUCTURED_MEMORY_HIGHLIGHT_MODES`, `STRUCTURED_MEMORY_HIGHLIGHT_KINDS`.
  - Per-record overrides: `structuredMemoryLanguageOverride`, `structuredMemoryHighlightOverride`.
  - Section budgets: `MEMORY_SECTION_BUDGETS`, `memorySectionOverBudget`.
- `HypaV3Settings.structured` (`shared/memory.ts`), filled by `createHypaV3Preset` (`shared/hypaV3Presets.ts`).
- `memorySettingsFingerprint` (`server/src/jobs/jobScope.ts`) digests the settings a writer task reads.
- `server/src/prompt/memory/structured/window.ts`: the writer's windows: `confirmedWindows`, `WriterWindow`,
  `writerCeiling`, `writerCadence`, `recordedMessages`, `readRecordedMessages`, `confirmedThrough`,
  `windowStillConfirmed`.
- `server/src/prompt/memory/structured/prompts.ts`: `analysisSlots`, `assembleAnalysisPrompt`, `patchSlots`,
  `assemblePatchPrompt`, `compactSlots`, `assembleCompactPrompt`, `parseCustomFrame`, `defaultPrompts`.
- `server/src/prompt/memory/structured/analysis.ts`: the pure `parseAnalysis` and `admitAnalysis`.
- `server/src/prompt/memory/structured/pages.ts`: the pure page rules: `castSlice`, `planPages`, `aliasSeeds`,
  `windowSpeaker`, `changeSection`, `rewriteScene`, `sectionVectorText`.
- `server/src/prompt/memory/structured/patches.ts`: the pure patch rules: `showTargets`, `parsePatches`, `applyPatches`,
  `commitPages`.
- `server/src/prompt/memory/structured/compact.ts`: the pure compaction rules: `compactionTargets`, `readCompaction`,
  `applyCompactions`.
- `server/src/prompt/memory/structured/writer.ts`: `createStructuredWriter`, the run lifecycle; `commitWindow`, a
  writer's one write on either path; `writerRequestDb` and `writerHostDeps`, what its requests ignore of the preset;
  `adoptionHold` and `chatAdoptionHold`; `writerPaused`, re-exported from `shared/`.
- `server/src/prompt/memory/structured/recordJob.ts`: `runMemoryRecord`, the `memoryRecord` command; `recordGapInJob`, a
  send's approved gap. `testRun.ts`: `runMemoryTest`, [the test run](structured-memory-read.md#the-test-run).
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
7. A person's start also re-records the events marked `rerecord` (`readRerecordEvents`), ahead of the rest and counted
   against the limit: each gives one window of exactly its sources a send still reads, in chat order, with fresh anchors
   and `rerecords` naming the event. It asks nothing of step 4, so what is recorded stays recorded and a second repair
   of the same messages still runs. An event runs only when all those messages lie under the ceiling and
   `memoryRerecordTarget` names a reply; any other keeps its mark. A gap run takes none.
8. An automatic task, and the step's `due`, take only `automaticRerecords`: marked events read `changed`, none under the
   `manual` cadence. So an edit runs at the next hand-off, and a mark on a text put back or a message gone waits for a
   person.

A window is `{ sources, messages }`, with `rerecords` on a repair: `sources[i]` anchors `messages[i]`, with `index` the
place in the stored list, not the eligible one, and `hash` from `messageSourceHash`.

### The writer task

1. Selection: `db.memoryAlgorithmType === "structuredMemory"` runs `structuredMemoryStep` ahead of the flag chain. The
   step reads ([the read path](structured-memory-read.md#the-read-path)), then returns the hand-off with `due` from
   `confirmedWindows` at `limit: 1`.
2. Hand-off: for an input job with a service and a chat snapshot read with its source generation, due or not, since
   `handOffMemory` hands off a not-due input when a manual start waits. It asks no blocking reason, unlike HypaV3.
   - Gap: an input job whose trim dropped more than `gapConfirmTokens` asks `memoryGap`, with the windows a manual start
     would run as `plannedCalls`. It asks nothing with no such window, since history cited by a stale or retracted event
     counts as recorded, or with a local summarizer. `generate` is [the gap run](#the-gap-run), then the step reads and
     selects again without asking.
   - A [held chat](structured-memory-lifecycle.md#the-adoption-choice) (`MemoryRecords.adoptionHeld`) is asked no gap
     and hands off nothing, so a waiting manual start stays for after the choice. Its reply's receipt is `notAutomatic`,
     `awaitingAdoption`, ahead of every other reason.
3. Start: the service's shared checks ([memory](memory.md#background-memory-task), `createMemoryTasks`), with
   `notStructuredMemory` when `memoryAlgorithmType` no longer selects it. A Plugin `memory` slot, a `request` trigger,
   or a local summarizer ends the task `skipped` with `pluginModel`, `requestTrigger`, or `localSummarization`. What a
   person reads of that is the reply's own [receipt](structured-memory-read.md#receipts), which does not wait for a
   task.
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
`windowChanged`), the chat is not held (else `windowChanged`, because a `meta` write can land after `openRun`'s look),
the chat holds no [rebuild's run](structured-memory-rebuild.md#during-a-run) (else `windowChanged`, because a job can
get past admission after an algorithm switch), and the memory revision is current (else `revisionConflict`). A refusal
writes nothing. Around it, `retireRerecorded` turns a repair's closing write into the swap: the new event takes the old
one's `pinned`, `suppressed`, and `userCorrected`, and the old one is written `retracted` in the same change set, with
[its sections flagged](structured-memory-lifecycle.md#retraction-and-edits). An old event gone, unmarked, or retracted
refuses the commit `windowChanged`, because a confirmed delete has no fence to wait for. `recordJob.ts` wraps its commit
the same way, so a failed run leaves the old event and its mark, and each retry works it out again.

### A writer run

`createStructuredWriter` makes one analysis call per window, one patch call when a candidate was accepted, and one
compaction call per section that patch left past its budget. `memory_runs` is its whole state. It reads and writes
through the `memory` it is given: the live records, or [a rebuild's staged set](structured-memory-rebuild.md#a-run),
where a `historical` write [leaves current state alone](structured-memory-rebuild.md#backfill).

1. Hold and pause: a held chat ends any run `skipped` (`awaitingAdoption`), a manual one too, with no call and no row.
   This one check covers a task, a job, and the gap run, whatever queued them. `consecutiveFailures` `failed` rows at
   the end of the runs end an automatic run `skipped` (`writerPaused`), the same way. `skipped` and `pending` rows
   neither count nor reset, a `recorded` row resets, and a manual start runs past the pause.
2. Leftovers: one task runs per chat, so a `pending` row found here is abandoned. The write that opens the run closes it
   `skipped` (`interrupted`): a cancel, a checkpoint load, or a restart proves nothing about the model.
3. Input: only the newest row that did not record is read. Its `input` is sent again as stored when its window has the
   same message ids and hashes and its `settingsFingerprint` and prompt mode are the task's. Otherwise the prompt is
   built anew, so changed instructions take effect and a regrouped window rebuilds.
4. Snapshot: a `pending` row holds the exact input, and the run's `language`, before any call. An input too large for a
   record fails the run (`inputTooLarge`) with no call.
5. Call: `host.request`, on `writerHostDeps`: temperature 0, and no `jsonSchemaEnabled` or `extractJson`, which shape
   the chat's replies. A provider failure, an unusable answer, or a `MemoryHostFailure` ends the run `failed` with a
   redacted error and a failed receipt, and the task with it. Any other throw is an ended task: the row stays `pending`
   for the next run, and `commit` refuses, which is how output after the deadline is discarded.
6. Patch call: [below](#the-patch-call), on the same host and rules as step 5. It runs after admission and has no
   `pending` write of its own, because a retry replays only the analysis. A failed one ends the run `failed`
   (`patchFailed`) with no event, since an event would close the window for good; the row keeps `analysis` and
   `patchInput`.
7. Compaction calls: [below](#compaction), after the patch call and before the commit. A failure here never fails the
   run.
8. Commit: event, threads, pages, and the `recorded` run in one write, on the revision the opening write returned. Every
   call counts in `inputTokens`, `outputTokens`, and `durationMs`. A `revisionConflict` admits the answer again from
   fresh records with no call, 3 attempts in all, then `skipped` (`revisionConflict`); a new page keeps its id across
   them, because the patches name it. `staleInput` and `windowChanged` end it `skipped` and leave the row to step 2.
9. Warming: `eventVectorTexts` unless `laneTargets.events` is 0, and each changed non-scene section's
   `sectionVectorText` unless `laneTargets.pages` is 0, through `HypaProcesser.addText`. A failure keeps the records. A
   retrieval that embeds other text misses this cache.

### Record now

A press past one window asks first, with [the cost preview](structured-memory-rebuild.md#the-cost-preview).

"Record now" and resume are the `memoryRecord` command (`messageId` or none), a job and not a call on the service: the
service keeps no input across a restart, where `start` would only wait for the next send, and only a job's scope can
tell a slot that needs the tab. The tab calls `runServerJob` directly, because `runServerCommand` refuses a group chat.

1. Admission: refused when the algorithm is not selected, memory is off, the summarizer is local, the chat is held (a
   409, so a stale tab's press gets an answer), or `messageId` is not an eligible char message. The job holds the chat's
   slot, so nothing generates then. No ceiling and no `messageId` ends `done`.
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

### The gap run

`recordGapInJob` is the one write that holds up a send, because a person said yes to a question promising it before the
reply. It shares `runWindows` with record now, inside the send's job.

- Once a job (`JobRunState.memoryGapRecorded`): `confirmMemoryGap` answers `generate` again for every later speaker and
  round, and only the first records.
- `manual: true` on the chat's lease, with the `initial` run's stop control between windows, up to `maxWriterWindows`.
  The ceiling is the input's, exclusive, and a manual start runs past a pause.
- `scope.request` takes `writerRequestDb` around the run alone, so the reply keeps its temperature and schema.
- A window that does not record ends the run quietly: its run and receipt are stored and the send goes on with the gap.
  An abort or a latched failure still ends the job. It never calls `markStopped`, which would clear the `blockingReason`
  a reply's receipt reads.
- Assembly's chat snapshot stays. A receipt changes no source hash, and an edit during the run costs one send a slightly
  stale prompt.

### The analysis prompt

`assembleAnalysisPrompt` parses the default ChatML frame and the preset's `instructions` with the slots in place, so CBS
runs on them alone, then fills the slots in one pass over the parsed messages. Chat text never reaches CBS, cannot start
a ChatML message, and a value holding a slot's name stays as it is. Message text stays raw so a quote can match, with
inlays shown as `[Image]`. Under `fineTuning` the frame is [the preset's](structured-memory-read.md#prompt-fine-tuning).
The language is the chat's override, the owner's, the preset's, then `db.language`.

`castSlice` fills the `cast` slot, at most `promptPages` rows, in this order: `always` pages, the scene's
`participants`, then pages whose title or alias is a case-insensitive substring of a window message. The scene page has
its own slot. A row holds the id, type, title, aliases, last state, and clamped section summaries, so a cast of forty
costs what a cast of four costs. The match is plain substring until the read path shares lore's matching.

### Admission

`parseAnalysis` takes the text from the first brace to the last, after any `<Thoughts>`; the event may sit under
`event`. A missing or mistyped required field fails the run naming it. Strings clamp to the limits without splitting a
surrogate pair, a malformed element is left out, and a list stops at its cap, each counted once per field in `warnings`
(`malformed`, `capped`). Axes round and clamp, and an object lacking a score is no axes. `pageCandidates` and `scene`
are read from the top level whether or not the event sits under `event`, and both may be missing; a candidate with no
finite confidence is malformed.

`admitAnalysis` works from records read for that attempt:

- Evidence: a key line's text and each `quote` must be a contiguous piece of a window message's raw `data`, so a quote
  from context or across `[Image]` fails. It goes to `unverified` (`quoteNotFound`).
- Pages: a reference is a page's id, or the title of a create the plan accepted, which is stored as the new page's id. A
  participant, `who`, knower, or `scene.participants` entry naming neither is removed with an `unknownPage` warning, an
  item with a quote goes to `unverified` (`unknownPage`), and a relationship shift naming neither is left out with a
  warning. `speakerId` comes from the plan and never reaches a repeated event.
- Threads: `add` opens one; `close`, then `transitions`, move only a thread that exists and has not ended (else
  `unknownThread`, `endedThread`), one write per thread, the last naming winning. `closedBy` is set on an end.
- Repeat: when the last stored event is active, has the same participants, a summary at `dedupeSimilarity` or above by
  character bigrams, and sources that still read from the chat, no event is made. That event takes `repeatCount + 1` and
  the window's sources, or the window would stay open forever; everything else on it stays, and thread changes name it.

### Pages

`planPages` works on the chat's whole pages at every attempt, because the store has no bulk read:

- A `targetId` that exists is a target at any confidence, and a missing one is refused `unknownPage`. The scene page and
  a create of that type are refused `sceneOwned`.
- A create is matched first, by name key (trimmed, lower-cased) over existing pages of its type, so a create never
  duplicates a page and adds no alias: aliases are user tools. Two creates of one name are one page.
- With no match, a create under `createConfidence` is refused `lowConfidence`. `receipt.refused` with that code is the
  "unresolved mentions" list; no store holds it. Otherwise it is a new page, `contextMode: "auto"`, with no sections
  until a patch gives it some. A patch call that gives none leaves the identity, so its references stand.
- Seeds (`aliasSeeds`): a lore entry of the owner, chat, or modules matches on its `comment` alone, and a page created
  under that name takes its comma-split keys as aliases, never the reverse: `Rivals` keyed `Alice,Bob` ties nothing to
  Alice. A group member's `name` and `nickname` tie both ways. Seeds never stand in for confidence.
- Group speaker: a window with one speaking member (`windowSpeaker`) sets `speakerId` to that member's character page,
  which code makes when missing. That name is exact, so no threshold applies and it makes no patch call.
- A repeat makes no page and no patch call; its candidates are refused `repeatedEvent`, and a scene rewrite still runs.

`commitPages` gathers every page change of a commit in one map by id, because the store refuses an id written twice in
one change set: created pages, the scene page when the chat has none, patches, links, then the scene rewrite.

- History: each section change adds one entry with the replaced content, its kind, and the event, to
  `pageHistoryEntries`; a new page has one `heading: null` `create` entry. `before` keeps the section's marks with its
  content, so a [revert](structured-memory.md#the-revert-route) gives it back as it stood.
- Highlighting: the stamp carries the rule, the chat's mode else the preset's, and a run with `input.rebuild` uses
  `none`. `all` highlights every writer entry; `important` a kind in `highlightKinds`, and a `change` only from
  `highlightChangeGrade`, the higher of the event's and the page's grade. An identical upsert never is. No page history
  entry has kind `retract`, so the settings offer no such box and a stored one stays.
- Evidence: a change adds the event to `provenance` and the window to `sources`, each to the newest `sectionEvidence`.
  `locked`, `pinned`, and `suppressed` stay; `unsupported` clears; `disputed` clears unless the change sets it.
- A change may replace a `userCorrected` section. One that changes the text, or deletes it, clears the mark and is
  highlighted in every mode, `none` included. An identical upsert and a disputed join, which keeps the words, keep it.
- Links: a relationship shift adds `to` to its `from` page's `links`, to `pageRefsPerItem`, with no section change.

### The scene page

`writer` keeps the chat's one scene page; no candidate reaches it. The first recorded window creates it
(`type: "scene"`, title `Scene`, `contextMode: "always"`) even with no `scene` in the answer, so a chat with records has
one. A `scene` answer rewrites the fixed sections `place`, `time`, and `state` and `participants` inside the analysis
call, because a patch call runs only when a candidate is accepted. A blank field, or one that says the same, changes
nothing, and an empty or fully unresolved list keeps the attendance. Sections are independent facts, so a lock skips one
section with `lockedSection` and the rest go on. A rewrite is a `change` entry, so the bounded history keeps old scenes;
attendance alone has none, and each event's participants record it. The analysis prompt's scene slot lists what a person
took back, past its clamp, a stored input without those lines is not replayed, and a field repeating text a revert took
back is skipped `revertedScene` until a different rewrite lands on that heading. `readMemoryRecords` gives
`participants` to the read path as `stage`.

The store holds the rule: the partial unique index `memory_pages_scene`, a `ResourceValidationError` from `write` before
any statement runs (a second scene page in a set, or one while the chat keeps another that is not in `remove.pages`),
and the same refusal from `walkMemorySnapshot`, so a crafted file never reaches the staged store's index. A live `write`
also refuses losing the page: removing it with no scene row in the set, or a row that retypes it. Replacing it in one
set is legal, and a restore checks neither, because a snapshot may predate the page.

### The patch call

`showTargets` lists the accepted pages. A section shows whole or not at all, in target order, while `promptPatchChars`
of bodies last; one past that is listed under `notShown`, and a target with sections, none of which fit, is refused
`overBudget`. The call holds the admitted event and no message, so an item whose quote failed never reaches a page, and
everything on a page traces to its `provenance` event. The default prompt is bounded by limits, so it has no size check,
and `RUN_RECORD_MARGIN_BYTES` covers it. A row marks a `userCorrected` section, which the rules say to change only when
the event contradicts it, and `takenBack` lists the page's newest reverts. That room comes first out of
`promptPatchChars`.

An answer needs a `patches` list. `op` is `upsert` or `delete`; an upsert's `body` is the section's whole new text.

`applyPatches` compares each patch with the fresh page and refuses, as a warning whose `kind` is the code and whose
`detail` is `<page title>: <heading>`:

| Code               | Patch                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| `unseenPage`       | names a page the call did not list, or one that is gone                              |
| `lockedSection`    | touches a locked section                                                             |
| `unseenSection`    | names a section not shown, one changed, deleted, or added since, or deletes none     |
| `duplicateHeading` | names a heading of its page twice                                                    |
| `notASlot`         | adds a section to a character page outside `CHARACTER_SECTION_SLOTS`                 |
| `tooManySections`  | adds a section past `sectionsPerPage`                                                |
| `emptyBody`        | upserts blank text                                                                   |
| `sectionTooLong`   | has a body past `sectionBodyChars`, or would join one past it: nothing is cut to fit |

A page applies whole or not at all, so a fact moved between sections cannot lose one half of the move: its other patches
read `pageRefused`. A group that would leave a page with no text is refused `emptiesPage`. Other pages still apply and
the event commits: a refusal is no failure of the run.

Conflict classes:

- An upsert over a section is a `change`; a non-blank `was` adds one `(was: ...)` line unless the body holds it.
- `conflict: "contradiction"` at `contradictionConfidence` or above supersedes the same way, with kind `contradiction`.
- Below it, a missing confidence being 0, both values stay as `<old>\n[disputed] <new>`, `disputed: true`, with kind
  `contradiction` and a `disputed` warning. Neither waits for approval.

### Compaction

`MEMORY_SECTION_BUDGETS` gives each page type a budget in `body.length`, under the hard `sectionBodyChars`. A dry run of
the commit, after a patch call that answered patches, names the sections (`compactionTargets`): those it really changed
(an identical upsert and a delete do not count), on a non-scene page, past the budget. A section it did not change gets
no call, so one that cannot shrink is not asked again every window. No id of the dry run reaches a record, and the
commit is worked out anew on each attempt. Events are never compacted: nothing here reads one.

Each section gets one call, with no cap but `patchesPerCall`. `prompts.ts` fills the section through a slot, so it never
reaches CBS; the call sees no message, and `fineTuning` does not replace this prompt. Its prompt and answer stay out of
the run, whose record margin does not cover them.

| Warning                | Meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `compacted`            | applied; `detail` adds the old and new length                                           |
| `compactionSkipped`    | `userCorrected` or `disputed`: no call, because the text waits on a person              |
| `compactionFailed`     | the call failed, or its answer has no usable `body`                                     |
| `compactionNotSmaller` | not strictly shorter, so discarded; a shorter one need not reach the budget             |
| `compactionStale`      | this commit attempt did not change the section, or left another body or a person's mark |

A locked section gets no call and no warning, since a patch already refused it. Nothing is cut to fit. A
`MemoryHostFailure` or any other throw ends the run as it does for the patch call.

`applyCompactions` runs inside `commitPages`, right after the patches, through `changeSection` with kind `compact`. So a
section gains two history entries in one commit, the second's `before` being the long body, and two receipt rows, each
with its hashes and `historyId`. The text diff is the Pages tab's history; the receipt line shows the warning.
`changedSectionTexts` warms the shorter body.

## State

- The records a writer run leaves, and the tables holding them: [structured memory](structured-memory.md#memory-tables).
- The writer's settings are the selected memory preset's `settings.structured`, so they copy, export, and import with
  the preset. A chat's `structuredMemoryLanguage` wins over its owner's, and the owner's over the preset's `language`,
  where `""` follows `db.language`. A chat's `structuredMemoryHighlight` wins over the preset's `highlightMode`.
- `MemorySettings.svelte` exposes only the fields something reads, and shares with HypaV3 only the preset picker, the
  budget mode, and the memory maximum. `screening`: [its rules](structured-memory-read.md#reply-screening). So a
  preset's `summarizationModel` and `alwaysToggleOn` still apply with no control here.
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
- `server/src/tests/memoryTaskHost.test.ts` drives `memorySettingsFingerprint` on a real job scope, and
  `server/src/tests/upstreamExport.test.ts` drives what the upstream export leaves out.
- `server/src/prompt/memory/structured/window.test.ts` drives the window rules as a table over plain messages with a
  fake tokenizer, repair windows included. `structured/reconcile.test.ts` drives the swap, and `memoryTasks.test.ts` a
  repair through the real writer.
- `server/src/tests/memoryTasks.test.ts` drives the task kind on `createMemoryTasks` over a real store: its windows with
  an injected `structuredWriter`, the writer itself with none, through the scripted provider and read back from
  `store.memory`. `memoryJobs.test.ts` drives the hand-off with `createFakeMemoryTasks`, `assemble.test.ts` the
  selection, and `src/ts/process/memoryTasks.test.ts` the status's `kind`.
- `structured/analysis.test.ts`, `pages.test.ts`, `patches.test.ts`, `compact.test.ts`, and `prompts.test.ts` drive the
  pure pieces with plain values; `prompts.test.ts` parses with the real CBS evaluator. The one-scene rule is in
  `memoryStore.test.ts` and `restoreStage.test.ts`.
- Compaction's calls and its one commit: `memoryTasks.test.ts`. `recordJob.ts` runs the same writer, with no test of its
  own for this.
- Record now: `memoryTasks.test.ts` for the lock refusal and `through`; `memoryJobs.test.ts` for the job's two paths on
  a real stack.
- Focused command:
  `pnpm --silent test:agent server/src/prompt/memory/structured/ normalizeCollections memoryTaskHost upstreamExport memoryStore restoreStage memoryTasks memoryJobs assemble`.
  No `slow` or `e2e` membership of its own.

## Known Hazards

### Limitations

- A retried window replays its snapshot only while its messages group the same way: a failed manual partial window that
  a cadence later regroups rebuilds its prompt. A replay resends the context as it was. Decision: Structured Memory D3,
  plan.
- An interrupted run never counts toward the pause, so a model that only ever overruns the task deadline does not pause
  recording. Decision: Structured Memory D3, plan.
- An edit during a reply is picked up by the send after it: `due` is read before the reply, and the marks wait.
  Decision: Structured Memory slice 5b, plan.
- A failed patch call costs the retry its analysis call again: the window replays from the start, because one page
  refresh must not close a window. Decision: Structured Memory D3, plan.
- A page locked or changed in a way a patch cannot apply is refused whole, so one bad patch delays that page's other
  changes to a later window. Decision: Structured Memory D3, plan.
- Section evidence keeps the newest `sectionEvidence`, so a section can read `unsupported` while an older dropped event
  still supports it. Decision: Structured Memory slice 4a, plan.
- A section whose `userCorrected` stands is never compacted, and can grow by disputed joins until `sectionTooLong`
  refuses its page's patches. The person trims it. A section a failed or discarded compaction left long waits for its
  next change. Decision: Structured Memory D13, plan.
- `takenBack` is advice: code compares a patch with it nowhere, so a model can write the text again. Only a scene field
  is held. Decision: Structured Memory slice 7b, plan.
- Budgets are per section in characters, so they do not keep the required lane under `requiredCap`. Compaction runs
  before the commit, so a deadline during one costs the run its analysis and patch calls, and a person pressing record
  now waits for it. `compactionFailed` holds no provider text. Decision: Structured Memory D13, plan.
- Recording in a job sets no `memoryTaskFenced` fence and no task status: only the pressing tab sees it, through its
  button and the `memoryProgress` overlay, as with a blocking HypaV3 summary. The job holds the chat's slot and the
  lease. A throw there leaves the run `pending` with no failed receipt, and the next run closes it `interrupted`.
  Decision: Structured Memory slice 2d, plan.

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
