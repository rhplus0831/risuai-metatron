# Structured Memory Read Path: Lanes, Card, Manifest, Receipts, Panel

## Scope

- Owns the `structuredMemory` read path and what the tab shows of it: the lanes that offer records, the memory card that
  spends the budget on them, the trim, the manifest and report a send leaves, the receipts on messages, the memory panel
  and receipt line in the tab, and the prompt fine-tuning page with its test run.
- Paths: `server/src/prompt/memory/structured/{lanes,retrieve,card,step}.ts`, `src/lib/Others/StructuredMemory/`,
  `src/lib/ChatScreens/MemoryReceiptLine.svelte`, `src/lib/Setting/Pages/StructuredMemoryPrompts.svelte`, and the
  receipt and panel parts of `src/ts/process/structuredMemory.svelte.ts`.
- See [structured memory](records.md) for the records the read path reads and how the algorithm is selected, and
  [the archive](../../archived-plan/README.md) for the design and remaining work.
- Not here:
  - The records, the projection, the writer, the lifecycle, the rebuild, and the page tools →
    [the area README](README.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](../memory.md).

## Files

- `server/src/prompt/memory/structured/lanes.ts`: the pure read rules: `readBudget`, `spendLanes`, `LaneItem`,
  `LaneCandidate`, `Lane`, `ExcludedItem`, `itemKey`, and the raw window re-exported from `shared/`.
- `server/src/prompt/memory/structured/retrieve.ts`: `retrieveLanes`, `RETRIEVAL_LIMITS`, `readsAsPast`,
  `eventVectorTexts`, `lexicalTerms`.
- `server/src/prompt/memory/structured/card.ts`: `buildMemoryCard`, `RequiredOverLimit`, and the line builders,
  `pageLine` among them. `itemTag` is in `shared/`, because the tab finds a block by it, and `card.ts` re-exports it.
- `server/src/prompt/memory/structured/step.ts`: a send's read: `readMemoryRecords`, `MemoryRecords`, `readEntries`,
  `blankEntry`, `selectMemory`, `writerState`, `sendManifest`. `structuredMemoryStep` in `assemble.ts` drives it; the
  job's part is in [the writer guide](writer.md#the-writer-task).
- `shared/contextReport.ts`: the manifest's fields on `ContextReport.memory`, `reportedMemoryExclusions`,
  `CONTEXT_MEMORY_EXCLUDED`. `trimHistoryToContext` in `hypav3.ts` is the trim both algorithms share.
- `previewChatReport` in `src/ts/process/index.svelte.ts`: a preview's messages and report. `GenerationPreviewResult` in
  `shared/jobs.ts` is that job's `done.result`.
- `src/lib/Others/StructuredMemory/`: `StructuredMemoryPanel.svelte`, `CoverageTab.svelte`, `PreviewTab.svelte`,
  `PagesTab.svelte`, `TimelineTab.svelte`, `ThreadsTab.svelte`, `LogTab.svelte`, `SettingsTab.svelte`,
  `MemoryLinkButton.svelte`, `MemoryManifest.svelte` (a report's writer, items, left-out rows, and lane spend, shared
  with `ContextMeter`), `memoryText.ts`, the stored codes as text, and `memoryRecordPress.ts`, the `memoryRecord` press
  the panel shares with the receipt line, and `pressMemoryTest`. `src/lib/Others/HypaV3Modal/taskStatusLine.ts`: the
  status line it shares with the modal.
- `src/ts/process/structuredMemory.svelte.ts`, the pure parts the panel reads with: `reconcileMemoryCoverage`,
  `memoryMessageHash`, `memoryMessageHasher`, `joinMemoryCoverage`, `groupMemoryCoverage`, `memoryMessageExcerpt`,
  `memoryRunView`, `memoryTimelineRows`, `memoryPageTree`, `memoryPageHistoryView`, `memoryEventView`,
  `memoryWriterNotice`, `MemoryPanelTabProps`. `memoryTextDiff` loads `diff` when the first history entry opens.
- The same file, pure, for what a send reported: `memoryStatusWord`, `memoryItemsUsed`, `usedMemoryCoverageGroups`,
  `memoryItemKey`, `memoryItemTitles`, `memoryBlockEntries`.
- `src/lib/ChatScreens/MemoryReceiptLine.svelte`: the line, from `Chat.svelte`'s `genInfo`. `memoryReceiptView` and
  `newestAssistantMessageId` in `structuredMemory.svelte.ts` are its pure part.
- `src/lib/Setting/Pages/StructuredMemoryPrompts.svelte`: the fine-tuning controls and the test run's result.
  `memoryTestResultView` and `readStructuredMemoryDefaultPrompts` are its parts in `structuredMemory.svelte.ts`, and
  `StructuredMemoryTestResult` in `shared/structuredMemory.ts` is that job's `done.result`.

## Flows

### The read path

Nothing here writes: `retrieveLanes` offers candidates, and `buildMemoryCard` spends the budget on them. The modules'
comments hold the lane rules.

`selectMemory` runs once for every job with `memoryJob.structuredMemory`, a preview and a service-free send included,
which read as a send does. With no `memoryJob` the history stays raw and no report says otherwise.

1. Records: one synchronous read of every event and page, then `reconcileEvents` over the stored messages, on a copy
   ([reconciliation](lifecycle.md#reconciliation-and-repairs)). `coveredMessages` (active, not suppressed) reads the
   copy to say what may leave, and `recordedMessages` (any status) reads the events as stored to say what the writer
   leaves alone, so history cited only by a stale or retracted event stays raw.
2. Window: `rawWindow`, then the message a continue extends leaves `dropped` before retrieval, so an older one stays in
   the prompt and out of the evidence.
3. Card: one `memo: "supaMemory"` entry at the front of the history, with no entry when no item is included. Under
   `volatileBeforeLastUser` the volatile part is its own entry, which never joins the history: a chat range could cut it
   there, and a `memory` prompt card would pull it away. Assembly splices it into `formated` once the cards are
   formatted, right before the entry holding the latest user message, found by provenance. A range that left that
   message out puts it after the last memory entry, else at the end.
4. Trim: `trimHistoryToContext`, as HypaV3's select-only path, with the window as its protected tail and an older
   continue target pinned. Both go into `protectedEntries`. A tail that does not fit ends the send with
   `TOO_MUCH_TOKEN`. Trimmed history is `coverage: "gap"`, and the gap question is
   [the writer's](writer.md#the-writer-task). So is covered history with something to send that left behind an empty
   card, because the model saw neither. That one asks nothing and adds no `gap` stage: `gapTokens` alone drives both,
   and `stages` says `card: empty`.

The report (`ContextReport.memory`, kind `structuredMemory`):

- `items` are the included records. `verified` is set in `buildContextReport` by finding `itemTag(item)` in the final
  prompt, whichever entry holds it, so after scripts, `editRequest`, and the recheck. One not found makes `coverage`
  `unknown`, because the two parts can be lost apart.
- `excluded` keeps `CONTEXT_MEMORY_EXCLUDED` rows, worst reason first, and `excludedTotal` the count: `retrieveLanes`
  lists every not-relevant event, and a stale one with its `staleReason`. `lanes` holds each lane's target and spend.
  `budgetReduced` holds only `memory`: the preset's headroom and extra are the summarizer's, and this budget spends
  neither.
- The meter's line shows `tokens` and `memoryStatusWord`, the worst of a `coverage` that is not `covered` and the
  writer's state. Its popover reads titles from the contents as it opens, and a failed read leaves rows untitled.
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
- The required lane is reserved before anything else is spent: a line sum over `requiredCap`, or a required-only card
  over `maximum`, ends the send with a `SendError` naming each page and its tokens, a preview and a gap run's second
  pass included. That is assembly's `alert`, not `error`, so `inlayErrorResponse` writes no reply in its place.
- A page has one item and one tag in either lane, so `required` and `pages` never hold the same page. What it knows and
  does not know is part of its line: an on-stage `always` page counts them against the cap, and a reader finds titles by
  page id.
- `pageId` on a knowledge item is who learned it, and no field names whom a fact is about, so "subject" is `pageId` and
  a secret is an item with `knowers`, an empty list included. The writer does not reconcile records, so `knownFacts`
  joins them by exact text before any cap: a page that learned a secret later is not denied it.
- `never` hides a page, not what it shares: a fact a visible page also holds still shows there, without the hidden
  title. A `never` scene gives no item and still drives the stage.

### Receipts

`generationInfo.memory` on a message says what happened to its turn. The stored kinds, by who writes them:

- `recorded` and `failed`: `commitWindow` ([the writer's commit](writer.md#the-writer-task)), from the receipt of the
  run in `changes`, right after the memory write and in the same synchronous step, one `patchMessage` per assistant
  message of the window, each keeping its other generation info. So every turn of an `everyK` or `tokens` window carries
  the same receipt. Two transactions, not one: a receipt that conflicts anyway is logged, the commit stands, and
  `MemoryRun.receipt` keeps it.
- `notAutomatic` (`awaitingAdoption`, `pluginModel`, `requestTrigger`, `localSummarization`) and `skipped`
  (`writerPaused`): the send's job, on its own reply's generation info (`structuredMemoryStep`), so no extra chat write.
  It cannot be left to the task, which is handed off only when a window is due. A run that records the turn replaces it,
  because the patch sets the whole `memory` field.
- `pending` is never stored. On the newest assistant message with no receipt the line reads as the writer working while
  the chat's task is live (about the chat, not that row), else as having no receipt yet. Older rows without one show
  nothing: no receipt proves nothing, see `Invariants`.

The row list mounts `Chat` once per text, so `messageGenerationInfo` keeps what the row was mounted with: the line reads
the held chat, and a feed patch moves it.

The line's details list what the recording changed (`receiptChanges`). Each row opens the panel at that page's history
diff through `requestMemoryPanelTarget`, which the panel takes as it mounts, because a link can only be pressed while
the panel is closed. A highlighted row also carries a revert, as does every writer's section entry in the Pages history;
both go through `revertStructuredMemoryChange`, which reads the page for its revision first. The receipt is a stored
copy that no revert changes, so the row shows reverted only for its own mount, and a later press answers that nothing is
left to undo. The Settings tab holds the chat's own highlight mode, a chat field written through `setChatMeta`.

### The memory panel

`StructuredMemoryPanel` replaces `HypaV3Modal` when `memoryAlgorithmType` selects the algorithm, under the same
`hypaV3ModalOpen` store, so `chatStatus.svelte.ts` still counts the transcript as hidden. `App.svelte` picks it, and the
menu row in `DefaultChatScreen` and the button in `CharConfig` open it ahead of any older memory flag. A tab is one
component in `TABS`, taking `MemoryPanelTabProps`, mounted while it shows. Pages, Timeline, Threads, and Settings write;
the rest read.

- "Used in the last send" comes from `memoryItemsUsed`: the newest valid report, found as the meter finds its own, and
  its `verified` items of one kind. A newer report of another kind means none, and no older report is reached. Coverage
  badges a row by `eventId` and a closed group by any of its rows, Log a run by the event it committed, Timeline an
  event, and Pages a page.
- The contents route adds `adoption` (`StructuredMemoryAdoption`), as the server sees the chat, so the tab's mirror
  decides nothing. A [held chat](lifecycle.md#the-adoption-choice), `adoptable` above 0, is offered adoption and decline
  above the writer line, where it meets them first. An adopted chat that still stores summaries, `resettable`, is
  offered the reset under it. Decline and reset each ask first. The routes check again, so a stale panel's press answers
  `adopted: 0`, `declined: false`, or `reset: false`.
- Under the reset sit [Fill gaps and Rebuild](rebuild.md#a-run), each priced first and hidden while held, with a line
  when the writer's language left `recordedLanguage`. A chat with a run shows its progress, Pause while its task is
  live, Resume while stopped and `resumable`, and Abandon always, and the panel stays read-only until it ends.
- Preview runs only on its button. A preview is a local send, so it flips `readOnly`, which moves `refresh`: a run on
  `refresh` would never stop. It answers the prompt with no next message, so it says the next send can differ.
- `memoryBlockEntries` finds the block by `itemTag`, because `editRequest` can rebuild entries without their `memo`. A
  stable part holding only the rule header has no tag and is not shown.

- Read-only is the modal's `memoryWriteFence`, a local send, a generating chat key, or `memoryTaskFenced`, or a run,
  rechecked each second while the fence only waits for a held revision. `refresh` moves on the button and when read-only
  falls, which catches a task's end and a record-now job that ran inside a generation job and ended no task. A held
  message that changes needs no request: the join is derived.
- Coverage joins the held messages with the coverage route's facts in the tab, because the tab holds the selected chat
  whole and a route has no job scope. The newest reply reads `pending` too: "confirmed" is the job's to say.
- Coverage and Timeline read those facts through `reconcileMemoryCoverage`, the send's rule over the held messages, so
  an edit shows at once, before it reaches the server, with no request. The tab hashes with `memoryMessageHash`, pure
  JavaScript because `crypto.subtle` needs a secure context, and each tab keeps `memoryMessageHasher`'s memo. An
  unloaded chat is not found, and reconciling against no messages would call every event `missing`, so the facts then
  stay as answered.
- `joinMemoryCoverage` takes a row's state from the first that holds: not in `eligibleHistory`, `excluded` (`disabled`);
  an event that covers it, `covered`; a stale event, `stale`; a suppressed one, `excluded` (`suppressed`); a retracted
  one, `excluded` (`retracted`); [screened](#reply-screening), `excluded` (`screenedRefusal`, `screenedFormat`); the
  newest unrecorded run naming it, by result; its own receipt when that is a notice no run stands behind
  (`notAutomatic`, `writerPaused`), `skipped`; else `pending`.
- The gap is the eligible messages older than `rawWindow`'s start that no covering event cites, less screened replies,
  and leaving is its `dropped`, emptied when the owner's `supaMemory` is off. Tokens are counted on those rows alone,
  and only when their texts change, so a reply streaming into the window starts no count.
- Coverage groups consecutive rows of one state and renders 200 rows at a time. One group opens at a time.
- The Log reads a round at a time; a 409 on a later round restarts the list. A row expands to `MemoryRun.analysis`, each
  item by its quote, marked when the receipt's `unverified` names it. That list names items by kind and text, so of two
  equal quotes both are marked. An unreadable `answer` shows too.
- A stored run is data of any shape (`memoryRunView`), and all model and message text renders as plain text. The export
  is `{ logVersion, revision, runs }` as JSON, read whole at one revision and restarted on a 409 as the package is.

### Pages, Timeline, and Threads

- Pages lists the contents through `memoryPageTree`, the scene first, and reads a page by id when selected. A section's
  heading is a key, shown through `pages.headings`, and a key it does not know shows as it is. There is no editor for a
  page's title, aliases, type, or links. The tab also holds [the page tools](pages.md): the trash under the tree, merge,
  split, the lorebook export, and import on an empty chat.
- History comes from `memoryPageHistoryView`, newest first. An entry's "after" is the next entry of the same heading, or
  the live section, because no `after` is stored ([the rule](records.md#invariants)). The diff renders as spans, one
  open at a time.
- Timeline reads the coverage route, not the contents: it already answers every event's `messageIds` at one revision,
  and `readContents` stays free of `data` because a send and every round call it. `memoryTimelineRows` sorts by an
  event's first message still present, else its stored `sourceIndex`, else last, and ages it from its newest message
  still present, as the flow lane does. `memory_events.seq` says nothing of message order. Opening a row reads its
  record through `memoryEventView`, and a stale row holds the repairs ([Panel edits](#panel-edits)).
- An open event whose `writerRun` is `ADOPTED_WRITER_RUN` says it came from HypaV3 data without a model call.
- Threads lists the contents, with the state on each row, and opening one reads its `who`, `openedBy`, and `closedBy`.
- A link between tabs is `open(target)`, which the panel turns into `focus` for the tab it shows. A message link is
  `jump(messageId)`: `setChatOpen`, `requestMessageJump`, then the panel closes. The panel can sit over a closed chat.

### Panel edits

Each goes through [the edit route](records.md#the-edit-route), naming the revision of the copy it was made on, one at a
time per tab. A tab applies the edit to its copy, and a refusal restores the copy, shows the notice (none for `epoch`,
which halts on its own), and reads again. A success keeps the answer and its revision. `readOnly` only turns the
controls off first: the server's fence decides.

A repair differs in one way: a stale row's status comes from the held messages, so the tab applies nothing to its copy
and reads the round again either way. Keep names the anchor state computed from the held messages, so a chat that moved
on is refused `changed`, and a local edit not yet on the server is too. Retract asks first, because no control takes it
back. Re-record sends the mark, then presses `memoryRecord` through `memoryRerecordTarget`. An event already marked goes
straight to the press, so a failed press can be pressed again.

An open section editor keeps the body it opened on. A read that brings another body for that section closes it with the
`changed` notice, so a draft written against old text cannot replace the writer's new text. Read-only keeps the draft
and turns Save off, and the read when it falls applies the same rule.

### The writer line

`memoryWriterNotice` decides the line under the status lines from the current state, because a receipt or a report is a
copy of its moment. The first that holds: memory off, no action, because the command refuses; a held chat as the
contents say, `awaitingAdoption`, no action; `writerPaused` over the current runs (from the contents) or a newest
receipt that reads paused, resume; events waiting for a re-record (`health.pendingRepairs`), the action the newest
message would have; a newest `notAutomatic` receipt, its reason and `memoryReceiptView`'s action; a `manual` cadence,
reason `manual`. Past those only the action shows. A newest `awaitingAdoption` receipt on a chat no longer held reads as
no receipt, or it would hide record now after the choice. The press is `pressMemoryRecord`, as on the receipt line, off
while pressing, read-only, or the task is live.

### Prompt fine-tuning

`StructuredMemoryPrompts.svelte` sits in the Memory settings page and edits the preset's `fineTuning`, `analysisPrompt`,
and `patchPrompt`. Ticking the box warns, then seeds blank prompts from `GET /api/memory/structured/default-prompts`; a
read that fails leaves the box off. Unticking keeps the texts. The same answer shows the defaults, and `promptGuide` in
`en.ts` is the stored guide.

Under `fineTuning` a call's text is its whole frame (`parseCustomFrame`): the same ChatML parser, CBS, and slot filling,
and the same validation of the answer. `instructions` reach no custom frame, only compaction, whose default frame stays.
A frame fails the run `customPromptInvalid`, with a failed receipt and no call, when it is blank, parses to no message,
or lacks a required slot. Slots are read after CBS and before filling, so a CBS branch cannot hide one:

| Call     | Required            | Why                                                                                |
| -------- | ------------------- | ---------------------------------------------------------------------------------- |
| Analysis | `messages`, `scene` | Quotes come from the window; the scene slot lists what a person took back          |
| Patch    | `cast`, `previous`  | The cast carries `takenBack`, and admission treats its pages and sections as shown |

So what a person took back reaches a custom prompt as it reaches the default one, and replay's check of the taken-back
lines holds in both modes. A bad analysis frame fails in the opening write, a bad patch frame after the analysis call,
and either counts toward the pause. A custom patch prompt is checked against the record margin before its call and fails
`inputTooLarge`, since a frame can be any length.

`customPrompt` means `fineTuning` was on, not that a frame ran: it is on the run, on the failed and recorded receipts,
and on `writerNotice`'s. A failed receipt under it also keeps the bounded, redacted `error`, so a missing field is named
on the line and not only in the Log. The panel's line reads the current settings; a receipt and a Log row read what they
stored. The [health badge](#the-health-badge) reads the current settings too.

### The test run

The `memoryTest` command job (`testRun.ts`) runs the writer once over a window and answers on `done.result`.

1. Admission is `admitRecord`'s, then a refusal for a tab-bound `memory` slot or `request` trigger, naming it, and for a
   queued or running task of the chat. It takes no writer lease, because acquiring one cancels a running task; the job
   holds the chat's slot, and `rebuildLocks` and `chatBusy` refuse it before it runs.
2. It runs on the detached `createMemoryTaskHost`, so no tool, inlay, chat variable, or tab callback is in reach.
3. Window: the newest run's, while each of its messages is still eligible with the same hash, whatever the ceiling; else
   the first open window; else `none`.
4. `createStructuredWriter` runs with `dryRun` and a `commit` that keeps the changes and writes nothing. `dryRun` builds
   the prompt anew, skips the last event, so the window's own event cannot dedupe the patch call away, and skips
   compaction and warming. `commitPages` still runs, so its refusals appear in the result.

`pressMemoryTest` treats a followed job and a terminal without the result, which a retained one is, as no result.

### Reply screening

The preset's `screening` lists keep a reply out of what the writer records. `memoryScreenReason` is the rule: a reply
whose stored `data` holds a listed text, without case, refusal first. It is decided at each read and stored nowhere, so
a list change or an edit needs no repair.

- Reach: the writer only. The raw text stays in the prompt and trims as it does today, so screened ids stay out of the
  `covered` set `rawWindow` takes, and retrieval knows nothing of screening.
- Windows: the ceiling is found first, so a press on a screened reply confirms what lies before it. Screened replies
  then drop, and the user message before one folds into the next turn. `confirmedThrough` skips them, or a screened
  newest reply would read `pending` for ever. `WriterCadence` carries the lists.
- A message an event cites stays `covered`: screening changes no stored record.
- A person's start re-records a marked event through its screened messages. An automatic start leaves it, marked.
- Rebuild and backfill screen at the plan, at the cost, and again in `rebuildWindow`, since a reply can be edited after
  the plan. `memoryWorkCost` has no job scope, so it reads `store.memory.readWriterSettings`.
- A test run drops a replayed window that holds a screened reply and takes the window the cadence would close.

### The health badge

`memoryHealthStates` (`chatStatus.svelte.ts`) gives the worst of `MEMORY_HEALTH_STATES` for the open chat and the pinned
chats, while the algorithm is selected and the character's `supaMemory` is on. `health` is last in
`CHAT_STATUS_PRIORITY`, so a lasting state hides no `unseen`.

| State                 | Comes from                                                         |
| --------------------- | ------------------------------------------------------------------ |
| `writerPaused`        | `paused`, or the open chat's newest report; never a receipt        |
| `gap`                 | The open chat's newest report: `gapTokens` over `gapConfirmTokens` |
| `staleEvents`         | `storedStale`, `pendingRepairs`, the report's `stale` exclusions   |
| `unsupportedSections` | `unsupportedSections`                                              |
| `requiredOverCap`     | The tab's mark of a send failed `memoryRequiredOverCap`            |
| `pageOverBudget`      | `overBudgetSections`                                               |
| `customPrompt`        | The preset's `fineTuning`, with no read; neutral                   |

- `watchChatVisibility` reads the facts from an effect, deferred and awaited by nothing, so boot and the first chat
  render do not wait: after boot, for a new key, for the open chat on opening and on the panel closing, and on a page
  return at most once a minute. Never on a send, a task end, or streaming. A failed read keeps what is held.
- `POST /health` ([the read routes](records.md#the-read-routes)) can answer a prefix, and the tab asks again from where
  it stopped. [Measured](../../audit/structured-memory-health-read-2026-11-03.md).
- The mark is keyed by chat: an `error` terminal with `code: "memoryRequiredOverCap"` sets that chat's, a `done` with a
  `messageId` clears only that chat's. A preview that fails over cap sets it too: that is a true observation.
- `DefaultChatScreen` shows the state inline on a line under the `ContextMeter` row, with the meter off too, and a press
  opens the panel. Character and folder badges take `groupHealthState`.
- The contents answer carries the facts as `health`, so the panel's writer line and the badge read one fact.
  `writerState` answers `pending`, reason `repair`, from `records.events`, already in hand at a send.

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
