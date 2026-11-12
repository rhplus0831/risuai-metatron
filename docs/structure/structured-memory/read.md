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
  [the archive](../../archived-plan/README.md) for the design.
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
- `src/lib/ChatScreens/DefaultChatScreen.svelte` and `src/lib/SideBars/CharConfig.svelte`: panel openers.
- `src/lib/Others/StructuredMemory/CoverageTab.svelte`: message coverage view; `reconciled`, `coverage`, `countedChats`.
- `src/lib/Others/StructuredMemory/PreviewTab.svelte`: preview view; `run`.
- `src/lib/Others/StructuredMemory/PagesTab.svelte`: page read and manage views, title filter, text search, events
  naming a page, and section editor, also the filtered view of flagged sections; `readRecord`, `sendChange`,
  `keepRecord`, `openAskedEntry`, `only`, `sectionReverts`, `keepAll`.
- `src/lib/Others/StructuredMemory/UnsupportedTab.svelte`: the Evidence missing tab, `PagesTab` under
  `only="unsupported"`.
- `src/lib/Others/StructuredMemory/TimelineTab.svelte`: event titles and story views and repairs; `reconciled`,
  `readStory`, `sendRepair`, `rerecord`.
- `src/lib/Others/StructuredMemory/ThreadsTab.svelte`: thread view and state editor; `read`, `setState`.
- `src/lib/Others/StructuredMemory/LogTab.svelte`: run viewer; `readRound`, `exportLog`.
- `src/lib/Others/StructuredMemory/MemoryEventFacts.svelte`: an event's state changes, knowledge, relationship shifts,
  and thread changes, shared by Log and Timeline; `Props`.
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

1. The step reads records and calls `selectMemory`, which reconciles events against stored messages before
   `retrieveLanes` and `buildMemoryCard` run ([reconciliation](lifecycle.md#reconciliation-and-repairs)).
   `coveredMessages` decides what history may leave from active, unsuppressed events; `recordedMessages` separately
   prevents the writer repeating any stored event. `retrieve.ts`'s header owns lane eligibility and scoring.
2. The card enters history as `memo: "supaMemory"`. With `volatileBeforeLastUser`, its volatile part bypasses history so
   it survives chat ranges; assembly places it after formatting by provenance before the latest user, else after the
   last memory entry, else at the end.
3. `trimHistoryToContext` protects the window and older continue target and rechecks them after trimming. Uncovered
   history trimmed from the prompt triggers an evidence reselection and `coverage: "gap"`; only `gapTokens` drives the
   writer's question. An unfit tail fails the send.
4. Required pages that exceed the cap refuse before embedding; a budget with no room for optional lanes embeds nothing.
   Assembly raises `SendError` with the page and token details, including for previews and the gap run's second
   selection.

After scripts and `editRequest`, `takeItemTags` notes the entries holding each `itemTag` and strips the tags before the
final recheck, which drops entries that no longer fit without reselection. An item is verified while a holder survives,
else coverage is unknown; a preview's `memoryBlock` indexes the holders. `reportedMemoryExclusions` caps the report,
while `excludedTotal` counts all rows. `sendManifest` and `writerState` supply item and stage summaries; `due` is a
hand-off request, not a queued task.

The flow lane is a recent timeline. Under the flow target, a contiguous run of the newest events that left the window
shows each in full (story time, title, summary, and key lines on the newest `flowKeyLineEvents`), and `flowEvents`
titles follow it. A key-line line that does not fit enters without its key lines, so key lines alone never stop the run.
After the other lanes and the lending, key lines return where they fit, newest first, and then the run goes on with what
is left of the maximum. An event is in full once, in the run or in the events lane, and selection takes the run's events
out of the events lane's exclusions. A target of 0 keeps the title-only lane. `spendLanes`' doc owns the order.

Lane targets follow `laneSplit`. Under `auto`, the default and what an absent value reads as, `readBudget` gives each
lane `floor(maximum × percent / 100)` of the applied maximum from the preset's `laneShares` (whole percents 0 to 100,
defaulting to `STRUCTURED_MEMORY_LANE_SHARES`: flow 25%, pages 45%, events 15%, evidence 10%, threads 5%); under
`manual` it gives the stored `laneTargets`. Each mode keeps the other's values. The shares' sum is not bounded: over
100%, the core round fills lanes in order until the maximum runs out. Selection hands those targets to retrieval as its
input, and the evidence reselection reads them too. The shares decide only the core round: lending and the run's
extension spend what the lanes leave. `requiredCap` is no share. Warming has no maximum
(`structuredMemoryEmbeddingLanes`): it embeds for the events or pages lane when that lane's share (`auto`) or stored
count (`manual`) is above 0.

The meter reads tokens and `memoryStatusWord`; its popover and Preview share `MemoryManifest`.

### Receipts

`generationInfo.memory` has two writers:

- `commitWindow` in `server/src/prompt/memory/structured/writer.ts`, for a task or a record now (`runMemoryRecord` in
  `server/src/prompt/memory/structured/recordJob.ts`), copies the run's `recorded` or `failed` receipt to every
  assistant in the window after the memory write, preserving other generation info. A receipt conflict leaves memory
  committed; `MemoryRun.receipt` remains authoritative.
- The send's `structuredMemoryStep` in `server/src/prompt/assemble.ts`, whose `writerNotice` builds it, puts
  `notAutomatic` (`awaitingAdoption`, `pluginModel`, `requestTrigger`, `localSummarization`) or `skipped`
  (`writerPaused`) on its own reply. It cannot wait for a task, since no window may be due. A later recording replaces
  the `memory` field.

The receipt line shows only in a Structured Memory chat with memory on. `pending` is never stored; `memoryReceiptView`
owns missing-row display. The `MemoryReceiptLine` component reads the held chat to follow receipt-only feed patches, and
uses `requestMemoryPanelTarget` to open the linked page history before the panel mounts. `Chat.svelte` also renders the
line in the `mobilechat` and `cardboard` footers. Its component contract owns display and revert behavior.

### The memory panel

`src/App.svelte` mounts the panel under `hypaV3ModalOpen` when the selected chat's own algorithm (`chatMemoryAlgorithm`)
is Structured Memory, the HypaV3 modal otherwise; the `DefaultChatScreen` menu and `CharConfig` button follow it too.
The component contract owns tab mounting and refresh. `TABS` puts the content tabs first (Pages, Timeline, Threads,
Evidence missing), then Coverage, Preview, Log, and Settings, so a panel opens on Pages unless `takeMemoryPanelTarget`
names a tab. Preview runs only on its button since its local send moves `refresh`.

Contents from `server/src/routes/structuredMemory.ts` supplies `adoption`, `rebuild`, `recordedLanguage`, `health`, and
`unsupportedPages`; the tab's HypaV3 mirror decides none. A [held chat](lifecycle.md#the-adoption-choice) offers
adoption of HypaV3 summaries or decline above the writer line; an adopted chat can offer reset below. Every choice is
rechecked by its route. [Rebuild controls](rebuild.md#a-run) coordinate contents reads with read-only state: a run holds
the fence beyond its task's end, which must reread contents to release it. Read-only falling also catches record-now
work inside a generation job.

The coverage route returns stored event facts; Coverage and Timeline apply the send's reconciliation rule to held
messages through `reconcileMemoryCoverage`, without a request or stored write. The join comment owns row priority,
windows and the unloaded-chat exception. A newest reply otherwise reads `pending`: confirmation belongs to the job.

`memoryItemsUsed` supplies last-send badges from the same newest-valid-report boundary as the meter; its comment owns
badge selection.

### Pages, Timeline, and Threads

Timeline reads coverage's `messageIds` at one revision, keeping `readContents` free of record `data` on sends and
rounds; `memory_events.seq` is storage order. `memoryTimelineRows` owns message order and aging. Pages hosts
[page tools](pages.md); each tab's contract holds its view rules. `open(target)` becomes the chosen tab's `focus`;
`jump(messageId)` opens the chat with `setChatOpen`, calls `requestMessageJump`, then closes the panel.

A page opens in `read`: its title, type and aliases, its links, and each section with a body as plain text under a small
label, the marks as badges, `currentState` first and set apart. A section's `(was: ...)` lines are folded behind a count
and show dimmed when opened; another selection folds them again. Read's record links are `MemoryLinkButton`'s `quiet`
form and its text column is capped. `manage` is the checking view, with every control, provenance, and the history. The
choice lasts while Pages is mounted; Evidence missing, a page in the trash, and a jump to a history entry show `manage`.
The jump scrolls its row once, when both the diff and the history list have rendered; another entry, page, target, or
chat drops it. Links name live pages by title and select them; an id with no live page is a disabled button. A title
filter narrows the tree before `memoryPageTree` groups it, so an emptied type loses its header; the trash list is not
filtered.

The tree marks a page the last send used with a dot, and one legend line above it names the dot and counts those among
the listed pages. The title filter's Search text button or form submit reads `/find?q=...` through
`findStructuredMemory`, including in chats with events but no pages. The button shows only for typed text whose hits are
not already showing; the action is disabled for over-100-character trimmed input and while reading, and a blank submit
does nothing. The hits replace the tree, its no-match line, and show-more control while the trimmed input equals the
searched text; editing it to anything else drops the hits and restores the filtered tree. Page hits show title, heading
when present, and excerpt and select that page; event hits show title and excerpt and open Timeline. Text stays plain.
An empty read or failure has its own line; `more` says the list was cut at `MEMORY_FIND_HITS_MAX` (200). Active searches
rerun on `refresh`; older answers from another chat, input, read, or refresh cannot replace them. Evidence missing has
no search.

One page lookup (`/find?page=...`) per selection and `refresh` answers what the chat's events and threads say of the
page. `read` asks for it on selection and shows four blocks under the sections, each only when it has rows: what the
page knows or believes (each fact over one line holding its believed and secret marks and its event's link), the newest
relationship shift per other page and direction, the threads naming it with their states (running ones first), and the
events naming it. `manage` shows the events alone behind a closed disclosure and asks when it opens; an answer serves
both views until the selection or `refresh` moves, and a refresh's reread keeps the rows it replaces until it settles.
The page's own `knowledge` and `relationships` sections are the writer's digest, which its rules keep short, so these
blocks are where a fact recorded only on an event shows.

The event list is newest first, unknown positions last, each row with its story time and an Important mark from
`importantEventGrade`. It shows the newest `RECENT_EVENTS` (5) and every important event until Show all is pressed, so a
page every event names stays short. Event links open Timeline. Empty, failure, and truncated reads have their own lines.
Selection, chat, refresh, and read-number guards discard old answers; search-hit and event-link buttons are disabled
while a page edit is pending.

An opened Timeline event shows what it changed under its key lines: state changes, knowledge, relationship shifts, and
thread changes, through `MemoryEventFacts`, the component the Log renders a run's extraction with. Timeline passes the
`memoryEventView` it already made, unconverted, with page and thread titles from the contents read it does once per
`refresh`; an id with no title shows as the id, and the Log, which passes no titles, shows ids.

Timeline has two views, `titles` and `story`, a choice that lasts while the tab is mounted. `story` lists the same rows
in message order without retracted events, each with its story time and summary as plain text; pressing a row still
opens its details and repairs. Summaries come from `/story` (`readStructuredMemoryStory`), read when `story` is chosen
and again when `refresh` moves while it is; the previous summaries stay until the new read settles. A row with no
summary shows its title alone, and a failed read shows the failure line over rows that keep their titles.

### The Evidence missing tab

The panel lists this tab only while contents' health counts flagged sections or while it is selected, so resolving the
last one leaves the notice in place until another tab is chosen. It is `PagesTab` under a filter: the tree holds
contents' `unsupportedPages`, the page shows its flagged sections alone, and the next flagged page is selected when the
shown one has none left. Pages hands each contents read to the panel through `onContents`, which keeps the count current
without a second request.

A flagged section there takes one of two answers. Keep sends `sectionKeep` with the tab's `preserve` checkbox, which is
tab state and starts checked; Keep all sends a page's keeps in turn, each at the revision the last answer named. Revert
shows when `sectionReverts` finds the heading's newest standing entry to be a revertable writer's change of a retracted
event, and calls [the revert route](records.md#the-revert-route). The
[lifecycle guide](lifecycle.md#retraction-and-edits) owns when a section is flagged.

### Panel edits

Pages and Threads send revision-bound edits through [the edit route](records.md#the-edit-route), one at a time per tab;
their contracts hold optimistic copies and refusal recovery. Timeline rereads after either repair outcome because held
messages decide stale status. Keep sends the held anchor state; Re-record marks then presses `memoryRecord` through
`memoryRerecordTarget`. The server fence decides after `readOnly` disables controls. Settings writes chat overrides
through `setChatMeta` in `src/ts/storage/chatStore.svelte.ts`.

Outside the trash a section's `userCorrected` badge is a button: after `alertConfirm` it sends `sectionRelease`, the one
control that takes the mark off.

Pages has two forms of a person's own text, both off under `controlsOff`. "New note" sits over the tree, and in an empty
chat, but not under `only="unsupported"` or while the chat waits for adoption; it sends
[`create`](pages.md#a-persons-note) at the contents' revision and selects the answered page in `manage`. Every accepted
page edit advances that revision at once and rereads contents, so a note made right after an edit is not refused as
stale. In `manage`, a page that is not the scene, a character, or in the trash has "add section" (heading, body with its
count), which sends `sectionAdd` through the held copy like a section's edit.

Timeline's opened, non-retracted event has a title and summary editor with limit counts, Save, and Cancel. Blank or
over-limit text cannot be saved. The draft remembers its stored title and summary; a reread that changes either closes
it with the `changed` notice. Opening another event or closing the current one discards the draft. Read-only or an
outstanding send disables the controls, and every edit uses the coverage revision through `editStructuredMemory`. The
corrected badge is held from the record beside `memoryEventView`, and is a button that confirms `eventRelease`,
including on retracted events. Text stays plain.

After either an accepted or refused `eventText` or `eventRelease`, Timeline rereads coverage and the currently opened
event's record. It also rereads the story when chosen, or invalidates its cached read so the next switch fetches it.
Chat, selection, and read-number guards discard older answers. Refusals use the repair notices; an accepted text edit
closes its draft before the reread, while a refused draft survives only if its stored base still matches.

### The writer line

`memoryWriterNotice` combines contents, current settings, and the newest receipt; its comment owns priority. Contents'
`writerBlockingReason` (`jobMemoryBlockingReason` over the chat's binding, no message read) overrides a receipt's
reason; it is absent for an unresolved binding and current only as of the contents read. The panel and receipt line
share `pressMemoryRecord`.

### Prompt fine-tuning

The settings component edits the preset's `fineTuning`, `analysisPrompt`, and `patchPrompt`; its contract owns warning
and default seeding from `GET /api/memory/structured/default-prompts`.

`server/src/prompt/memory/structured/prompts.ts`'s `parseCustomFrame` owns the whole ChatML frame and CBS processing,
required slots, and compaction's unchanged frame. Analysis requires `messages` and `scene`; patch requires `cast` and
`previous`. Scene and cast carry `takenBack` in either mode, preserving replay checks. The writer's header owns
`customPromptInvalid`, its failed receipt without a call for that frame, and the custom patch's margin check
(`inputTooLarge`). Both invalid-frame failures count toward the pause.

`customPrompt` means fine-tuning was enabled, even if no frame ran, on runs, failed and recorded receipts, and send
notices. Failed custom receipts carry bounded, redacted `error` for the receipt line and Log. The panel reads current
settings; receipt and Log rows read their stored mode. It is not a health state, so no badge warns about it.

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

`memoryScreenReason` filters stored message text from writer windows without changing history or existing event
coverage. `WriterCadence` carries its lists, and the ceiling is found before screening, so pressing a screened reply
still confirms earlier text; a manual re-record can include screened sources while an automatic start leaves the mark.
Rebuild planning, cost preview and test runs use the same screened-window rules. `memoryWorkCost` lacks a job scope and
gets settings through `store.memory.readWriterSettings` ([rebuild](rebuild.md#the-cost-preview)). The `window.ts` header
owns the ordering details.

### The health badge

`memoryHealthStates()` combines `POST /health` facts, the open chat's newest report and tab-held over-cap marks for open
and pinned chats whose own algorithm is Structured Memory. `chatStatus.svelte.ts` owns state selection;
`watchChatVisibility` owns the read triggers, which ask only for those chats. `MEMORY_HEALTH_STATES` gives the
worst-state order, while `CHAT_STATUS_PRIORITY` keeps health below unseen replies. The health route's prefix and byte
budget are described in [records](records.md#the-read-routes) and its
[measurement](../../reports/measurements/structured-memory-health-read-2026-11-03.md). Contents' health feeds the writer
line; a send's `writerState` gets `pending` with reason `repair` from in-hand `records.events`.

In `noteJobDone`, an `error` terminal coded `memoryRequiredOverCap` sets that chat's mark, a preview's included; a
`done` with a `messageId` clears only that chat's. `DefaultChatScreen` shows health under `ContextMeter` even with the
meter off; pressing opens the panel. Character and folder badges use `groupHealthState` in
`src/lib/SideBars/chatStatus.ts`.

## State

- The read path stores nothing of its own: its records are [structured memory's](records.md#state).
- `laneSplit` never rewrites the stored `laneTargets` or `laneShares`: each mode ignores the other's, so switching back
  shows the values a person entered before. The targets a send used are on its report's `lanes`. What a send leaves is
  on the reply's `generationInfo`: the report in `context` and the receipt in `memory` ([Receipts](#receipts)).
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
- Only `coveredMessages` and the trim remove history; "recorded" never decides it.
- A receipt is a display copy: `memory_runs` is the record. A message with no receipt is no proof that nothing was
  recorded, since a checkpoint load restores older rows while the tables survive and a whole-row `setMessage` replaces
  the field. Nothing reads a receipt to decide what to record.
- `memoryReceiptView` reads a receipt as stored data of any shape: a state it does not know hides the line.

## Recipes

- A new Memory settings page control: expose a preset field only once something reads it, then add it to the list
  `MemorySettings.structuredMemory.test.ts` compares the page's editable controls with.
- A new writer slot: add it to `ANALYSIS_SLOT_NAMES` or `PATCH_SLOT_NAMES`, and to `promptGuide`, which names the
  optional ones.
- A new panel tab: add one component to `TABS` taking `MemoryPanelTabProps`. A tab shown on a condition is filtered in
  the panel's `tabs`, which keeps a selected tab listed.
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
- The flow timeline: `structured/lanes.test.ts` for the run, its titles, and the extension, `card.test.ts` for the full
  line, the heading, and the trim order, `structured/retrieve.test.ts` for the window rule, key lines, and evidence
  through a full line, `assemble.test.ts` for the report's items and exclusions.
- The lane split: `structured/lanes.test.ts` for `readBudget`'s targets, `structured/retrieve.test.ts` for targets read
  from the input, `memoryTasks.test.ts` for both warming sites, `normalizeCollections.test.ts` and
  `MemorySettings.structuredMemory.test.ts` for the setting, the page's lane amounts, and its timeline strip.
- Receipts: `memoryTasks.test.ts` for the patches; `memoryJobs.test.ts` for the reply's notice on a real stack;
  `structuredMemory.test.ts` for `memoryReceiptView`; `MemoryReceiptLine.svelte.test.ts` and
  `Chat.interactions.svelte.test.ts` for the line and its gate.
- The panel: `structuredMemoryRoutes.test.ts` poisons a run's stored `data` through a second connection, so a read that
  should not happen fails the request. `structuredMemory.test.ts` drives the join and the restarts.
  `StructuredMemoryPanel.test.ts` mounts the real panel and `App.svelte` on fake timers with `authFetch` scripted, edits
  and refusals included; the two openers are in `DefaultChatScreen.drafts.test.ts` and `CharConfig.emotions.test.ts`.
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

### Limitations

- `verified` reads assembly's returned prompt. Plugin replacers and `request` triggers run later on every attempt, so
  removed lines still read verified; a provider gathering system entries (Ooba mode) undoes placement. A tag left in a
  kept message (an old echo, a paste) verifies a lost line. Decision: D8, archive.
- A preview marks no record and asks nothing, but has side effects: it runs the start trigger, whose result can commit,
  and counts in `statics.messages`. Decision: Structured Memory slice 3c, archive.
- A tab older than the `structuredMemory` kind reads such a report as none and shows an older one.
- The receipt line knows nothing of the hold. On a held chat a newest reply with no receipt still offers record now, and
  the press gets the 409. After the choice an `awaitingAdoption` receipt keeps its words with no button until a run
  replaces it, and Coverage reads it `skipped`. The panel's writer line is right throughout. Decision: Structured Memory
  slice 6c, archive.
- Coverage's gap and leaving rows read stored text, where a send reads processed text and the greeting: a reply a script
  blanks counts as a turn here, and uncovered history that no longer fits also trims at send time. The panel says so,
  and a preview is the exact form. Decision: Structured Memory D8, archive.
- A press that re-records an event can also record ordinary windows open under its message if the re-record windows
  leave room under `maxWriterWindows`. The shared `pressMemoryRecord` cost preview and confirmation apply
  ([cost preview](rebuild.md#the-cost-preview)). Decision: Structured Memory D3, archive.
- Coverage counts tokens with the tab's scope, whose model settings fall back when a chat's binding is missing, and a
  refresh with unchanged texts does not recount after a tokenizer change.
- A test run refuses a Plugin `memory` slot or a `request` trigger, because a tab callback saves its mutations even when
  it throws. Decision: Structured Memory slice 7c, archive.
- A test run leaves the request history row, its diagnostics event, and the job's generation receipt: the call's logs,
  as for a preview. The press also saves pending settings first, which is the settings save. Decision: Structured Memory
  slice 7c, archive.
- A test run replays over the records as they stand, so the window's own changes are already on the pages, and its
  answer can differ from what the run recorded. It costs up to two calls and asks first about neither.
- A custom prompt may leave out `{{slot::rules}}`: `takenBack` still shows in the cast, without the rule that says to
  respect it. The test run lists the slot. `memoryWorkCost` does not know a custom prompt's size.
- A seeded prompt is a copy: a later change of a default frame does not reach it, though a change of a slot's text does.
- A chat too large for a health read (`unavailable`) lists no flagged page, so it shows no Evidence missing tab and its
  flagged sections have no keep or one-press revert; the page history's revert still works. Decision: owner, 2026-11-10.
- The badge is a last observation: memory writes publish nothing, so a writer run or another tab's repair shows at the
  next read. Decision: Structured Memory slice 7e, archive.
- A chat not loaded knows no gap and only stored `stale` plus marks, because both need its messages. Only pinned chats
  and the open chat have a state. Decision: Structured Memory slice 7e, archive.
- A reload loses the over-cap mark, and only the tab that followed the job holds it. Decision: Structured Memory slice
  7e, archive.
- Gap is the last send's dropped tokens, which a later recording does not rewrite, and a screened reply counts once it
  trims. Decision: Structured Memory slice 7e, archive.
- `overBudgetSections` counts code points, not `memorySectionOverBudget`'s UTF-16 units, so a body with astral
  characters near its budget can read differently.
- A screened reply can stay in the writer's context-only `previous` slot, and a user message strands when the next reply
  is already recorded. Decision: Structured Memory slice 7e, archive.
- `selectMemory` takes 520–584 ms on a 1,000-turn send, mostly tokenizing (296–356 ms) and cache reads. Counting each
  text once per selection did not help (9 of about 2,190 counts were repeats); the gain needs it to reuse the counts
  `assemble.ts` already took for `currentTokens`. Decision: Found Issues Decisions (owner, 2026-11-08),
  [audit](../../reports/measurements/structured-memory-2026-11-03.md).
- The recent timeline counts every offered full line, up to `flowCandidates` (200), before it spends, whatever the
  budget: about 400 more counts on a 1,000-turn send, and `selectMemory` 44–88 ms slower than the title-only card. A
  lower bound would cut the run where a 50,000 maximum reaches it. Decision: Recent Timeline D14 (owner, 2026-11-11),
  [measured](../../reports/measurements/structured-memory-timeline-2026-11-11.md#selection-time).
- Counting those lines on demand did not pay (tried and reverted, `b29a883a5`): it saved at most 164 of about 2,600
  counts, none at 50,000, and counts one line at a time, which a network tokenizer cannot batch.
- Small contexts starve the last lanes: at 16,384 tokens of context the `threads` lane gets nothing once event lines
  carry three quotes, and a query naming two events loses one of them in a long chat at 32,768 too. Decision: Found
  Issues Decisions (owner, 2026-11-08), [audit](../../reports/measurements/structured-memory-2026-11-03.md).
- Under `auto` at 16,384 (a maximum of 3,276) the pages lane's 45% loses one long page on stage on every send of a
  1,000-turn fixture chat, which the title-only card's 2,000 kept. Decision: Recent Timeline D14 (owner, 2026-11-11),
  [measured](../../reports/measurements/structured-memory-timeline-2026-11-11.md#the-pages-lane-and-the-shares).

### Gotchas

- The evidence lane's older-message search requires lexical overlap and embeds at most `lexicalCandidates` excerpts per
  pass for semantic reranking; sources of retrieved events bypass the lexical gate. The pages lane has similarity as a
  channel of its own. `evidenceItems` in `server/src/prompt/memory/structured/retrieve.ts` owns both evidence paths.
- `eventVectorTexts` is what the writer warms; a retrieval that embeds other text pays for every event again.
- Every number in `RETRIEVAL_LIMITS` is a starting value, and a cosine threshold does not mean the same on every model.
  The stage is the scene page's `participants`, so a named thread waits for them.
- A report stored on every reply grows with `items` and `excluded`, up to a few kilobytes a message. D5's
  `memory_manifests` table is the way out if that matters.
- A job embeds at most `recordTexts` uncached record texts; the rest score 0 until the task service's silent
  `warmVectors` caches them, so a cold cache (a model change, an import) loses semantic matches for a send.
- `readMemoryRecords` parses every page whole on every send, up to 60 history entries each that the prompt never reads.
  The store has no read without them.
- Writer cast and read path share `pageNamedInTexts`, with no word-boundary rule: alias "Al" finds "also", an extra row,
  never a wrong record. `fullWordMatching` is no fix: it splits on spaces, so multi-word titles and punctuation miss.
- The tab hashes on the main thread: about 230 ms for 14 MiB of cited messages once per tab mount, in a VM. A streaming
  reply costs nothing, because the memo hashes only what changed and an unrecorded reply is cited by nothing.
