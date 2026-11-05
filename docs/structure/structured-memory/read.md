# Structured Memory Read Path: Lanes, Card, Manifest, Receipts, Panel

## Scope

- Owns the `structuredMemory` read path and what the tab shows of it: the lanes that offer records, the memory card that
  spends the budget on them, the trim, the manifest and report a send leaves, the receipts on messages, the memory panel
  and receipt line in the tab, and the prompt fine-tuning page with its test run.
- Paths: `server/src/prompt/memory/structured/{lanes,retrieve,card,step,testRun}.ts`,
  `src/lib/Others/StructuredMemory/`, `src/lib/ChatScreens/MemoryReceiptLine.svelte`,
  `src/lib/Setting/Pages/StructuredMemoryPrompts.svelte`, and the receipt and panel parts of
  `src/ts/process/structuredMemory.svelte.ts`.
- See [structured memory](records.md) for the records the read path reads and how the algorithm is selected, and
  [the archive](../../archived-plan/README.md) for the design and remaining work.
- Not here:
  - The records, the projection, the writer, the lifecycle, the rebuild, and the page tools →
    [the area README](README.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](../memory.md).

## Files

Read each module's header or component contract, then read the named export's comment with its code.

- `server/src/prompt/memory/structured/lanes.ts`: pure budget sharing; `readBudget`, `spendLanes`, `LaneItem`,
  `LaneCandidate`, `Lane`, `ExcludedItem`, `itemKey`, `rawWindow`.
- `server/src/prompt/memory/structured/retrieve.ts`: candidate retrieval; `retrieveLanes`, `RETRIEVAL_LIMITS`,
  `readsAsPast`, `eventVectorTexts`, `lexicalTerms`.
- `server/src/prompt/memory/structured/card.ts`: card rendering and reservation; `buildMemoryCard`, `RequiredOverLimit`,
  `pageLine`, `itemTag`.
- `server/src/prompt/memory/structured/step.ts`: a send's read selection; `readMemoryRecords`, `MemoryRecords`,
  `readEntries`, `selectMemory`, `writerState`, `sendManifest`.
- `shared/contextReport.ts`: report contract; `ContextReport.memory`, `reportedMemoryExclusions`,
  `CONTEXT_MEMORY_EXCLUDED`.
- `src/ts/process/index.svelte.ts`: preview entrypoint; `previewChatReport`. `shared/jobs.ts`: preview result contract;
  `GenerationPreviewResult`.
- `src/lib/Others/StructuredMemory/StructuredMemoryPanel.svelte`: panel coordinator; `TABS`, `refresh`, `readOnly`.
- `src/lib/Others/StructuredMemory/CoverageTab.svelte`: message coverage view; `reconciled`, `coverage`, `countedChats`.
- `src/lib/Others/StructuredMemory/PreviewTab.svelte`: preview view; `run`.
- `src/lib/Others/StructuredMemory/PagesTab.svelte`: page view and section editor; `readRecord`, `sendChange`,
  `keepRecord`, `openAskedEntry`.
- `src/lib/Others/StructuredMemory/TimelineTab.svelte`: event view and repairs; `reconciled`, `sendRepair`, `rerecord`.
- `src/lib/Others/StructuredMemory/ThreadsTab.svelte`: thread view and state editor; `read`, `setState`.
- `src/lib/Others/StructuredMemory/LogTab.svelte`: run viewer; `readRound`, `exportLog`.
- `src/lib/Others/StructuredMemory/SettingsTab.svelte`: chat override editor; `setLanguage`, `setHighlightMode`.
- `src/lib/Others/StructuredMemory/MemoryLinkButton.svelte`: record and message link; `Props`.
- `src/lib/Others/StructuredMemory/MemoryManifest.svelte`: shared report view; `Props`, `writerReasonText`.
- `src/lib/Others/StructuredMemory/memoryText.ts`: stored-code text; `codeText`, `memoryReasonText`,
  `memoryReadFailureText`.
- `src/lib/Others/StructuredMemory/memoryRecordPress.ts`: shared command presses; `pressMemoryRecord`,
  `pressMemoryTest`.
- `src/lib/Others/HypaV3Modal/taskStatusLine.ts`: shared task line; `memoryTaskStatusLine`.
- `src/ts/process/structuredMemory.svelte.ts`: receipt and panel views; `memoryReceiptView`, `MemoryReceiptView`,
  `newestAssistantMessageId`, `reconcileMemoryCoverage`, `memoryMessageHash`, `memoryMessageHasher`,
  `joinMemoryCoverage`, `MemoryCoverageState`, `MemoryCoverageJoin`, `groupMemoryCoverage`, `memoryMessageExcerpt`.
- `src/ts/process/structuredMemory.svelte.ts`: record views and navigation; `memoryRunView`, `memoryTimelineRows`,
  `memoryPageTree`, `memoryPageHistoryView`, `memoryEventView`, `memoryWriterNotice`, `MemoryPanelTabProps`,
  `memoryTextDiff`, `requestMemoryPanelTarget`.
- `src/ts/process/structuredMemory.svelte.ts`: report and settings views; `memoryStatusWord`, `memoryItemsUsed`,
  `usedMemoryCoverageGroups`, `memoryItemKey`, `memoryItemTitles`, `memoryBlockEntries`, `memoryTestResultView`,
  `readStructuredMemoryDefaultPrompts`.
- `src/lib/ChatScreens/MemoryReceiptLine.svelte`: per-message receipt view; `stored`, `view`, `openChange`, `revert`.
- `src/lib/Setting/Pages/StructuredMemoryPrompts.svelte`: preset prompt editor; `tick`, `loadDefaults`, `test`.

## Flows

### The read path

`structuredMemoryStep` in `server/src/prompt/assemble.ts` reads before the [writer hand-off](writer.md#the-writer-task).
With `memoryJob.structuredMemory`, previews and service-free sends read as sends do; without it, history stays raw with
no memory report.

1. The read step calls `readMemoryRecords`, then `selectMemory`, which calls `retrieveLanes` and `buildMemoryCard`.
   Selection runs `reconcileEvents` on a copy against stored messages
   ([reconciliation](lifecycle.md#reconciliation-and-repairs)). `coveredMessages` reads active, unsuppressed events from
   that copy to decide what may leave; `recordedMessages` reads any stored status for what the writer leaves alone.
   History cited only by stale or retracted events stays raw.
2. The card enters history as `memo: "supaMemory"`. Under `volatileBeforeLastUser`, its volatile part bypasses history
   to survive chat ranges and memory cards; assembly inserts it after formatting by provenance before the latest user,
   else after the last memory entry, else at the end.
3. `trimHistoryToContext` in `server/src/prompt/memory/hypav3.ts` protects the window and older continue target through
   `protectedEntries` and final recheck; an unfit tail fails `TOO_MUCH_TOKEN`. Trimmed history means `coverage: "gap"`.
   `selectMemory`'s comment holds the empty-card gap rule: only `gapTokens` drives the writer's question and gap stage.
   Required pages that do not fit cause the card to refuse, the step to return `alert`, and assembly to raise
   `SendError` naming pages and tokens. This ends previews and the gap run's second selection too, without an
   `inlayErrorResponse` reply.

After scripts, `editRequest`, and recheck, `buildContextReport` writes `ContextReport.memory`, kind `structuredMemory`.
It verifies included `items` by `itemTag` anywhere in the final prompt; a lost tag makes `coverage` unknown.
`shared/structuredMemory.ts` owns the shared tag. `reportedMemoryExclusions` keeps at most `CONTEXT_MEMORY_EXCLUDED`
exclusion rows, worst reason first; `excludedTotal` retains the full count. Neither producer bounds its list.
`sendManifest` and `writerState` hold the stage and state rules; `confirmedThrough` is the writer ceiling's newest
confirmed reply. The writer stage `due` promises no queue: hand-off follows the reply and can be skipped.

The meter reads tokens and `memoryStatusWord`; on opening, its popover reads contents for titles, retaining untitled
rows on failure, and shares `MemoryManifest` with Preview.

### Receipts

`generationInfo.memory` has two writers:

- `commitWindow` in `server/src/prompt/memory/structured/writer.ts`, for a task or a record now (`runMemoryRecord` in
  `server/src/prompt/memory/structured/recordJob.ts`), copies the run's `recorded` or `failed` receipt to every
  assistant in the window after the memory write, synchronously, preserving other generation info. These are two
  transactions: receipt conflict is logged, memory stays committed, and `MemoryRun.receipt` keeps it.
- The send's `structuredMemoryStep` in `server/src/prompt/assemble.ts`, whose `writerNotice` builds it, puts
  `notAutomatic` (`awaitingAdoption`, `pluginModel`, `requestTrigger`, `localSummarization`) or `skipped` with reason
  `writerPaused` on its own reply without another write. It cannot wait for a task, since no window may be due. A later
  recording replaces the whole `memory` field.

`pending` is never stored; `memoryReceiptView` owns missing-row display. `src/lib/ChatScreens/Chat.svelte` mounts by
text, so `MemoryReceiptLine` reads the held chat to follow receipt-only feed patches. `receiptChanges` links reach page
diffs through `requestMemoryPanelTarget` before panel mount; highlighted changes and writer section-history rows both
use `revertStructuredMemoryChange`, which reads the page's revision first. The component contract holds revert display
rules.

### The memory panel

`src/App.svelte` selects `StructuredMemoryPanel` under `hypaV3ModalOpen`, so `chatStatus.svelte.ts` still treats the
transcript as hidden. The menu in `src/lib/ChatScreens/DefaultChatScreen.svelte` and button in
`src/lib/SideBars/CharConfig.svelte` prefer it over older memory flags. The panel contract holds tab mounting and
refresh. Preview runs only on its button because its local send moves `refresh`.

Contents from `server/src/routes/structuredMemory.ts` supplies `adoption`, `rebuild`, `recordedLanguage`, and `health`;
the tab's HypaV3 mirror decides none. A [held chat](lifecycle.md#the-adoption-choice) offers adoption of HypaV3
summaries or decline above the writer line; an adopted chat can offer reset below. Every choice is rechecked by its
route. [Rebuild controls](rebuild.md#a-run) coordinate contents reads with read-only state: a run holds the fence beyond
its task's end, which must reread contents to release it. Read-only falling also catches record-now work inside a
generation job.

The coverage route answers each event's stored `status`, `sources`, `keptState`, and `rerecord`. Coverage and Timeline
apply the send's rule to held messages through `reconcileMemoryCoverage`: an active event whose sources changed reads
`stale` in the tab's copy unless `keptState` matches; the stored record stays unchanged. This needs no request before
server save; the route has no job scope. Their contracts hold the unloaded-chat exception. The join's comment owns row
priority and windows. The newest reply with nothing else deciding its row reads `pending`, never confirmed, because
confirmation is the job's to say.

`memoryItemsUsed` supplies last-send badges from the same newest-valid-report boundary as the meter. Its comment and the
tabs' `usedEvents`, `usedPages`, and `usedGroups` hold badge selection and placement.

### Pages, Timeline, and Threads

Timeline reads coverage's `messageIds` at one revision, keeping `readContents` free of record `data` on sends and
rounds; `memory_events.seq` is storage order. `memoryTimelineRows` owns message order and aging. Pages hosts
[page tools](pages.md); each tab's contract holds its view rules. `open(target)` becomes the chosen tab's `focus`;
`jump(messageId)` opens the chat with `setChatOpen`, calls `requestMessageJump`, then closes the panel.

### Panel edits

Pages and Threads send revision-bound edits through [the edit route](records.md#the-edit-route), one at a time per tab;
their contracts hold optimistic copies and refusal recovery. Timeline rereads after either repair outcome because held
messages decide stale status. Keep sends the held anchor state; Re-record marks then presses `memoryRecord` through
`memoryRerecordTarget`. The server fence decides after `readOnly` disables controls. Settings writes chat overrides
through `setChatMeta` in `src/ts/storage/chatStore.svelte.ts`.

### The writer line

`memoryWriterNotice` combines the contents' current pause state and `health.pendingRepairs`, current settings, and the
newest receipt; its comment owns priority and adoption-receipt handling. The panel and receipt line share
`pressMemoryRecord`.

### Prompt fine-tuning

The settings component edits the preset's `fineTuning`, `analysisPrompt`, and `patchPrompt`; its contract owns warning
and default seeding from `GET /api/memory/structured/default-prompts`.

`server/src/prompt/memory/structured/prompts.ts`'s `parseCustomFrame` owns the whole ChatML frame and CBS processing,
required slots, and compaction's unchanged frame. Analysis requires `messages` and `scene`; patch requires `cast` and
`previous`. Scene and cast carry `takenBack` in either mode, preserving replay checks. The writer's header owns
`customPromptInvalid`, its failed receipt without a call for that frame, and the custom patch's margin check
(`inputTooLarge`). Both invalid-frame failures count toward the pause.

`customPrompt` means fine-tuning was enabled, even if no frame ran, on runs, failed and recorded receipts, and send
notices. Failed custom receipts carry bounded, redacted `error` for the receipt line and Log. The panel and
[health badge](#the-health-badge) read current settings; receipt and Log rows read their stored mode.

### The test run

`runMemoryTest` in `server/src/prompt/memory/structured/testRun.ts` serves the `memoryTest` job. Its header holds replay
or open-window selection and detached dry-run execution. After `admitRecord`, admission refuses a tab-bound `memory`
slot or `request` trigger, or a queued or running memory task. No writer lease is taken, since that would cancel a task;
the job holds the chat slot, and `rebuildLocks` and `chatBusy` refuse it before execution.

The contract for `createMemoryTaskHost` in `server/src/prompt/memory/memoryTaskHost.ts` allows no tool, inlay, tab
callback, or chat-variable write. `createStructuredWriter`'s `dryRun` skips the last event to prevent self-deduping the
patch, while `commitPages` validation still runs. Its header holds prompt rebuilding, skipped compaction and warming,
and a commit that stores nothing. The answer crosses `done.result` as `StructuredMemoryTestResult` in
`shared/structuredMemory.ts`; `pressMemoryTest`'s comment holds missing-result handling. Its outcome words are
`testResult.outcomes`, not the log's.

### Reply screening

`memoryScreenReason` in `shared/structuredMemory.ts` owns case-insensitive stored-`data` matching, refusal first,
recomputed without storage. It reaches the writer; raw prompt text and retrieval stay unchanged, screened ids are not
added to `rawWindow`'s covered set, and existing event coverage survives.

`server/src/prompt/memory/structured/window.ts` finds the ceiling before screening, so pressing a screened reply
confirms earlier text; preceding user text folds into the next turn. `WriterCadence` carries the lists and
`confirmedThrough` skips screened replies. A manual re-record can cross screened sources; an automatic start leaves the
mark. Rebuild and backfill screen during planning, cost estimation, and `rebuildWindow` after possible edits;
`memoryWorkCost` has no job scope, so it reads `store.memory.readWriterSettings`. A test run drops a replay window that
holds a screened reply and takes the window the cadence would close.

### The health badge

`memoryHealthStates()` in `src/ts/process/chatStatus.svelte.ts` combines `POST /health` facts, the open chat's newest
report, current `fineTuning`, and tab-held over-cap marks for open and pinned chats while the algorithm and owner's
`supaMemory` are on. Its comment owns selection; `MEMORY_HEALTH_STATES` gives the worst state, and `health` is last in
`CHAT_STATUS_PRIORITY`, hiding no `unseen`.

| State                 | Input                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| `writerPaused`        | Health `paused` or the open report sets it; a receipt does not.             |
| `gap`                 | The open report's `gapTokens` exceeds `gapConfirmTokens`.                   |
| `staleEvents`         | It combines `storedStale`, `pendingRepairs`, and report `stale` exclusions. |
| `unsupportedSections` | It reads health's `unsupportedSections`.                                    |
| `requiredOverCap`     | It reads the tab's `memoryRequiredOverCap` failure mark.                    |
| `pageOverBudget`      | It reads health's `overBudgetSections`.                                     |
| `customPrompt`        | It reads current `fineTuning` without a request and is neutral.             |

`watchChatVisibility` owns deferred read triggers and failed-read retention. `POST /health` can answer a prefix and the
tab resumes ([routes](records.md#the-read-routes),
[measurement](../../audit/structured-memory-health-read-2026-11-03.md)); contents' `health` feeds the same writer-line
facts. A send's `writerState` gets `pending` with reason `repair` from in-hand `records.events`.

Job terminals reach `noteJobDone`. An `error` terminal with code `memoryRequiredOverCap` sets that chat's mark, a
preview's included; a `done` terminal with a `messageId` clears only that chat's. `DefaultChatScreen` shows health under
`ContextMeter` even with the meter off; pressing opens the panel. Character and folder badges use `groupHealthState` in
`src/lib/SideBars/chatStatus.ts`.

## State

- The read path stores nothing of its own: its records are [structured memory's](records.md#state). What a send leaves
  is on the reply's `generationInfo`: the report in `context` and the receipt in `memory` ([Receipts](#receipts)).
- The panel's rows are derived in the tab from the held chat and the routes' answers. Pages and Threads hold a copy of
  what they show, which an edit's answer or a read replaces.

## Coupling

- The trim is HypaV3's select-only path (`trimHistoryToContext`), and the selection chain that runs the step, the memory
  task fence, and embeddings belong to [memory](../memory.md#selection-in-assembleprompt).
- The report is `ContextReport.memory`; its parser and the `memory.coverage` rule for other algorithms are in
  [chat-pipeline](../chat-pipeline.md).
- The panel reads the routes of [structured memory](records.md#the-read-routes) and writes through
  [its edit route](records.md#the-edit-route); the receipts of recorded and failed windows are written by
  [the writer's commit](writer.md#the-writer-task).

## Invariants

- A report never bounds `items`, which the memory budget does, and always bounds `excluded`.
- History leaves the prompt only where `coveredMessages` says so; "recorded" never decides it.
- A receipt is a display copy: `memory_runs` is the record. A message with no receipt is no proof that nothing was
  recorded, since a checkpoint load restores older rows while the tables survive and a whole-row `setMessage` replaces
  the field. Nothing reads a receipt to decide what to record.
- `memoryReceiptView` reads a receipt as stored data of any shape: a state it does not know hides the line.

## Recipes

- A new Memory settings page control: expose a preset field only once something reads it, then add it to the list
  `MemorySettings.structuredMemory.test.ts` compares the page's editable controls with.
- A new writer slot: add it to `ANALYSIS_SLOT_NAMES` or `PATCH_SLOT_NAMES`, and to `promptGuide`, which names the
  optional ones.
- A new panel tab: add one component to `TABS` taking `MemoryPanelTabProps`.
- A new stored code the panel or the receipt line shows: give it text in `memoryText.ts`, and keep reading the stored
  value as data of any shape (`memoryRunView`, `memoryReceiptView`).

## Tests

- `structured/lanes.test.ts` and `card.test.ts` drive the read rules with plain values and a fake tokenizer.
  `structured/retrieve.test.ts` runs real embeddings over a vector cache with a scripted provider.
- The read step: `assemble.test.ts` drives `assemblePrompt` with a faked `memoryJob.structuredMemory` for the window,
  trim, placement, gap question, and report; `memoryJobs.test.ts` drives the gap run on a real stack;
  `contextReport.test.ts` the parser. Focused:
  `pnpm --silent test:agent assemble memoryJobs shared/contextReport.test.ts`.
- The page lanes: `structured/retrieve.test.ts` for channels, knowledge, and `never`, `card.test.ts` for the
  reservation, `assemble.test.ts` and `memoryJobs.test.ts` for the manifest and the refused send, `lore.test.ts` for
  `searchMatch`.
- Receipts: `memoryTasks.test.ts` for the patches; `memoryJobs.test.ts` for the reply's notice on a real stack;
  `structuredMemory.test.ts` for `memoryReceiptView`; `MemoryReceiptLine.svelte.test.ts` and
  `Chat.interactions.svelte.test.ts` for the line and its gate.
- The panel: `structuredMemoryRoutes.test.ts` poisons a run's stored `data` through a second connection, so a read that
  should not happen fails the request. `structuredMemory.test.ts` drives the join and the restarts.
  `StructuredMemoryPanel.test.ts` mounts the real panel and `App.svelte` on fake timers with `authFetch` scripted, edits
  and refusals included, and the two openers are in `DefaultChatScreen.drafts.test.ts` and
  `CharConfig.emotions.test.ts`.
- Selection and the meter: `MemorySettings.structuredMemory.test.ts` compares the page's editable controls with the list
  it may expose, so a new control fails it until something reads the field. `Toggles.test.ts` holds the toggle and
  `alwaysToggleOn`, `ContextMeter.svelte.test.ts` the line and the popover's one read.
- Fine-tuning: `prompts.test.ts` for the frame rules, `memoryTasks.test.ts` for both modes, invalid frames, replay, and
  the size check, `memoryJobs.test.ts` for the test run on a real stack, `structuredMemoryRoutes.test.ts` for the
  default prompts, and `StructuredMemoryPrompts.test.ts` for the controls.
- The health badge: `structuredMemoryRoutes.test.ts` for the route and its budget, `chatStatus.test.ts` for the states,
  the read triggers, and the mark, `memoryJobs.test.ts` for the failure code on a real stack.
- The preview: `memoryJobs.test.ts` and `promptRunner.test.ts` drive both kinds on a real stack, and
  `StructuredMemoryPanel.test.ts` scripts `runServerJob` for the tab.
- Focused command:
  `pnpm --silent test:agent structuredMemory StructuredMemory memory/structured MemoryReceiptLine ContextMeter Toggles Chat.interactions DefaultChatScreen.drafts CharConfig.emotions memoryTasks memoryJobs promptRunner`.
  No `slow` or `e2e` membership of its own.

## Known Hazards

### Issues

- A paraphrase of an old message that shares no query term is not found: in the evidence lane semantic scoring only
  reranks lexical matches, to keep embedding at `lexicalCandidates` texts a send. D6 names both as channels. The pages
  lane has similarity as a channel of its own.
- The writer line learns a tab-bound reason (`pluginModel`, `requestTrigger`) only from the newest reply's receipt: the
  rule needs a job's scope, which a route does not load. So it says nothing before the first send, or right after a
  record now replaced that receipt, until the next send. Record now still works there.

### Limitations

- `verified` reads the prompt assembly returned. Plugin replacers and `request` triggers run after it, on every attempt,
  so a line they remove still reads as verified, and a provider that gathers system entries (Ooba mode) undoes the
  placement. A tag the model echoed into a kept message verifies a lost line too. Decision: D8, plan.
- A preview marks no record and asks nothing, but it runs the start trigger, whose result can be committed, and counts
  in `statics.messages`, so it is not free of side effects. Decision: Structured Memory slice 3c, plan.
- A tab older than the `structuredMemory` kind reads such a report as none and shows an older one.
- The receipt line knows nothing of the hold. On a held chat a newest reply with no receipt still offers record now, and
  the press gets the 409. After the choice an `awaitingAdoption` receipt keeps its words with no button until a run
  replaces it, and Coverage reads it `skipped`. The panel's writer line is right throughout. Decision: Structured Memory
  slice 6c, plan.
- `genInfo` is not rendered in the `mobilechat` and `cardboard` themes, so they show no line.
- Coverage's gap and leaving rows read stored text, where a send reads processed text and the greeting: a reply a script
  blanks counts as a turn here, and uncovered history that no longer fits also trims at send time. The panel says so,
  and a preview is the exact form. Decision: Structured Memory D8, plan.
- A press that re-records an event also records the ordinary windows open under its message, as any press does, with no
  cost preview. Decision: Structured Memory D3, plan.
- Coverage counts tokens with the tab's scope, whose model settings fall back when a chat's binding is missing, and a
  refresh with unchanged texts does not recount after a tokenizer change.
- A test run refuses a Plugin `memory` slot or a `request` trigger, because a tab callback saves its mutations even when
  it throws. Decision: Structured Memory slice 7c, plan.
- A test run leaves the request history row, its diagnostics event, and the job's generation receipt: the call's logs,
  as for a preview. The press also saves pending settings first, which is the settings save. Decision: Structured Memory
  slice 7c, plan.
- A test run replays over the records as they stand, so the window's own changes are already on the pages, and its
  answer can differ from what the run recorded. It costs up to two calls and asks first about neither.
- A custom prompt may leave out `{{slot::rules}}`: `takenBack` still shows in the cast, without the rule that says to
  respect it. The test run lists the slot. `memoryWorkCost` does not know a custom prompt's size.
- A seeded prompt is a copy: a later change of a default frame does not reach it, though a change of a slot's text does.
- The badge is a last observation: memory writes publish nothing, so a writer run or another tab's repair shows at the
  next read. Decision: Structured Memory slice 7e, plan.
- A chat not loaded knows no gap and only stored `stale` plus marks, because both need its messages. Only pinned chats
  and the open chat have a state. Decision: Structured Memory slice 7e, plan.
- A reload loses the over-cap mark, and only the tab that followed the job holds it. Decision: Structured Memory slice
  7e, plan.
- Gap is the last send's trimmed tokens, which a later recording does not rewrite, and a screened reply counts once it
  trims. Decision: Structured Memory slice 7e, plan.
- `overBudgetSections` counts code points, not `memorySectionOverBudget`'s UTF-16 units, so a body with astral
  characters near its budget can read differently.
- A screened reply can stay in the writer's context-only `previous` slot, and a user message strands when the next reply
  is already recorded. Decision: Structured Memory slice 7e, plan.

### Gotchas

- `eventVectorTexts` is what the writer warms; a retrieval that embeds other text pays for every event again.
- Every number in `RETRIEVAL_LIMITS` is a starting value, and a cosine threshold does not mean the same on every model.
  The stage is the scene page's `participants`, so a named thread waits for them.
- A report stored on every reply grows with `items` and `excluded`, up to a few kilobytes a message. D5's
  `memory_manifests` table is the way out if that matters.
- A send's retrieval embeds every eligible event's texts and every shown section of each `auto` page. Warm, `addText`
  still compares every text with every vector synchronously, so the cost grows with the square of those texts. Cold (a
  model change, a cleared cache), it is one provider call per 50 texts, in sequence, inside the send.
- `readMemoryRecords` parses every page whole on every send, up to 60 history entries each that the prompt never reads.
  The store has no read without them.
- `searchMatch` counts its depth from the end of the list, so a depth over the length reads a short slice. The pages
  lane passes exactly the rows it means and their count. Name matching ignores `loreSettings.fullWordMatching`, so a
  short alias such as "Al" also finds "also": an extra candidate, never a wrong record.
- A window message with no `generationInfo` (an imported chat) gains `{ memory }` alone, so with `requestInfoInsideChat`
  its row shows an "Unknown" model button after its next mount.
- A copied or branched chat carries its receipts along with its messages.
- The tab hashes on the main thread: about 230 ms for 14 MiB of cited messages once per tab mount, in a VM. A streaming
  reply costs nothing, because the memo hashes only what changed and an unrecorded reply is cited by nothing.
