# Structured Memory Read Path: Lanes, Card, Manifest, Receipts, Panel

## Scope

- Owns the `structuredMemory` read path and what the tab shows of it: the lanes that offer records, the memory card that
  spends the budget on them, the trim, the manifest and report a send leaves, the receipts on messages, and the memory
  panel and receipt line in the tab.
- Paths: `server/src/prompt/memory/structured/{lanes,retrieve,card,step}.ts`, `src/lib/Others/StructuredMemory/`,
  `src/lib/ChatScreens/MemoryReceiptLine.svelte`, and the receipt and panel parts of
  `src/ts/process/structuredMemory.svelte.ts`.
- See [structured memory](structured-memory.md) for the records the read path reads and how the algorithm is selected,
  and [Active Plans](../plan/README.md) for the design and remaining work.
- Not here:
  - Record shapes and limits, the tables and store, read routes, the Markdown package, and the HypaV3 projection →
    [structured memory](structured-memory.md).
  - The writer's settings, windows, task kind, runs, analysis prompt, admission, and record now →
    [structured memory writer](structured-memory-writer.md).
  - The other algorithms, the selection chain, the memory task service, and embeddings → [memory](memory.md).

## Files

- `server/src/prompt/memory/structured/lanes.ts`: the pure read rules: `readBudget`, `spendLanes`, `LaneItem`,
  `LaneCandidate`, `Lane`, `ExcludedItem`, `itemKey`, and the raw window re-exported from `shared/`.
- `server/src/prompt/memory/structured/retrieve.ts`: `retrieveLanes`, `RETRIEVAL_LIMITS`, `readsAsPast`,
  `eventVectorTexts`, `lexicalTerms`.
- `server/src/prompt/memory/structured/card.ts`: `buildMemoryCard`, `RequiredOverLimit`, and the line builders,
  `pageLine` among them. `itemTag` is in `shared/`, because the tab finds a block by it, and `card.ts` re-exports it.
- `server/src/prompt/memory/structured/step.ts`: a send's read: `readMemoryRecords`, `MemoryRecords`, `readEntries`,
  `blankEntry`, `selectMemory`, `writerState`, `sendManifest`. `structuredMemoryStep` in `assemble.ts` drives it; the
  job's part is in [the writer guide](structured-memory-writer.md#the-writer-task).
- `shared/contextReport.ts`: the manifest's fields on `ContextReport.memory`, `reportedMemoryExclusions`,
  `CONTEXT_MEMORY_EXCLUDED`. `trimHistoryToContext` in `hypav3.ts` is the trim both algorithms share.
- `previewChatReport` in `src/ts/process/index.svelte.ts`: a preview's messages and report. `GenerationPreviewResult` in
  `shared/jobs.ts` is that job's `done.result`.
- `src/lib/Others/StructuredMemory/`: `StructuredMemoryPanel.svelte`, `CoverageTab.svelte`, `PreviewTab.svelte`,
  `PagesTab.svelte`, `TimelineTab.svelte`, `ThreadsTab.svelte`, `LogTab.svelte`, `MemoryLinkButton.svelte`,
  `MemoryManifest.svelte` (a report's writer, items, left-out rows, and lane spend, shared with `ContextMeter`),
  `memoryText.ts`, the stored codes as text, and `memoryRecordPress.ts`, the `memoryRecord` press the panel shares with
  the receipt line. `src/lib/Others/HypaV3Modal/taskStatusLine.ts`: the status line it shares with the modal.
- `src/ts/process/structuredMemory.svelte.ts`, the pure parts the panel reads with: `reconcileMemoryCoverage`,
  `memoryMessageHash`, `memoryMessageHasher`, `joinMemoryCoverage`, `groupMemoryCoverage`, `memoryMessageExcerpt`,
  `memoryRunView`, `memoryTimelineRows`, `memoryPageTree`, `memoryPageHistoryView`, `memoryEventView`,
  `memoryWriterNotice`, `MemoryPanelTabProps`. `memoryTextDiff` loads `diff` when the first history entry opens.
- The same file, pure, for what a send reported: `memoryStatusWord`, `memoryItemsUsed`, `usedMemoryCoverageGroups`,
  `memoryItemKey`, `memoryItemTitles`, `memoryBlockEntries`.
- `src/lib/ChatScreens/MemoryReceiptLine.svelte`: the line, from `Chat.svelte`'s `genInfo`. `memoryReceiptView` and
  `newestAssistantMessageId` in `structuredMemory.svelte.ts` are its pure part.

## Flows

### The read path

Nothing here writes: `retrieveLanes` offers candidates, and `buildMemoryCard` spends the budget on them. The modules'
comments hold the lane rules.

`selectMemory` runs once for every job with `memoryJob.structuredMemory`, a preview and a service-free send included,
which read as a send does. With no `memoryJob` the history stays raw and no report says otherwise.

1. Records: one synchronous read of every event and page, then `reconcileEvents` over the stored messages, on a copy
   ([reconciliation](structured-memory.md#reconciliation-and-repairs)). `coveredMessages` (active, not suppressed) reads
   the copy to say what may leave, and `recordedMessages` (any status) reads the events as stored to say what the writer
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
   [the writer's](structured-memory-writer.md#the-writer-task). So is covered history with something to send that left
   behind an empty card, because the model saw neither. That one asks nothing and adds no `gap` stage: `gapTokens` alone
   drives both, and `stages` says `card: empty`.

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

### The memory panel

`StructuredMemoryPanel` replaces `HypaV3Modal` when `memoryAlgorithmType` selects the algorithm, under the same
`hypaV3ModalOpen` store, so `chatStatus.svelte.ts` still counts the transcript as hidden. `App.svelte` picks it, and the
menu row in `DefaultChatScreen` and the button in `CharConfig` open it ahead of any older memory flag. A tab is one
component in `TABS`, taking `MemoryPanelTabProps`, mounted while it shows. Pages, Timeline, and Threads write; the rest
read.

- "Used in the last send" comes from `memoryItemsUsed`: the newest valid report, found as the meter finds its own, and
  its `verified` items of one kind. A newer report of another kind means none, and no older report is reached. Coverage
  badges a row by `eventId` and a closed group by any of its rows, Log a run by the event it committed, Timeline an
  event, and Pages a page.
- Preview runs only on its button. A preview is a local send, so it flips `readOnly`, which moves `refresh`: a run on
  `refresh` would never stop. It answers the prompt with no next message, so it says the next send can differ.
- `memoryBlockEntries` finds the block by `itemTag`, because `editRequest` can rebuild entries without their `memo`. A
  stable part holding only the rule header has no tag and is not shown.

- Read-only is the modal's `memoryWriteFence`: a local send, a generating chat key, or `memoryTaskFenced`, rechecked
  each second while the fence only waits for a held revision. `refresh` moves on the button and when read-only falls,
  which catches a task's end and a record-now job that ran inside a generation job and ended no task. A held message
  that changes needs no request: the join is derived.
- Coverage joins the held messages with the coverage route's facts in the tab, because the tab holds the selected chat
  whole and a route has no job scope. The newest reply reads `pending` too: "confirmed" is the job's to say.
- Coverage and Timeline read those facts through `reconcileMemoryCoverage`, the send's rule over the held messages, so
  an edit shows at once, before it reaches the server, with no request. The tab hashes with `memoryMessageHash`, pure
  JavaScript because `crypto.subtle` needs a secure context, and each tab keeps `memoryMessageHasher`'s memo. An
  unloaded chat is not found, and reconciling against no messages would call every event `missing`, so the facts then
  stay as answered.
- `joinMemoryCoverage` takes a row's state from the first that holds: not in `eligibleHistory`, `excluded` (`disabled`);
  an event that covers it, `covered`; a stale event, `stale`; a suppressed one, `excluded` (`suppressed`); a retracted
  one, `excluded` (`retracted`); the newest unrecorded run naming it, by result; its own receipt when that is a notice
  no run stands behind (`notAutomatic`, `writerPaused`), `skipped`; else `pending`.
- The gap is the eligible messages older than `rawWindow`'s start that no covering event cites, and leaving is its
  `dropped`, emptied when the owner's `supaMemory` is off. Tokens are counted on those rows alone, and only when their
  texts change, so a reply streaming into the window starts no count.
- Coverage groups consecutive rows of one state and renders 200 rows at a time. One group opens at a time.
- The Log reads a round at a time, and a 409 on a later round restarts the list. A row expands to `MemoryRun.analysis`,
  each item next to its quote, with what the receipt's `unverified` names marked. That list names an item by kind and
  text, so of two equal quotes both are marked.
- A stored run is data of any shape (`memoryRunView`), and all model and message text renders as plain text. The export
  is `{ logVersion, revision, runs }` as JSON, read whole at one revision and restarted on a 409 as the package is.

### Pages, Timeline, and Threads

- Pages lists the contents through `memoryPageTree`, the scene first, and reads a page by id when selected. A section's
  heading is a key, shown through `pages.headings`, and a key it does not know shows as it is. There is no editor for a
  page's title, aliases, type, or links.
- History comes from `memoryPageHistoryView`, newest first. An entry's "after" is the next entry of the same heading, or
  the live section, because no `after` is stored ([the rule](structured-memory.md#invariants)). The diff renders as
  spans, one open at a time.
- Timeline reads the coverage route, not the contents: it already answers every event's `messageIds` at one revision,
  and `readContents` stays free of `data` because a send and every round call it. `memoryTimelineRows` sorts by an
  event's first message still present, else its stored `sourceIndex`, else last, and ages it from its newest message
  still present, as the flow lane does. `memory_events.seq` says nothing of message order. Opening a row reads its
  record through `memoryEventView`, and a stale row holds the repairs ([Panel edits](#panel-edits)).
- Threads lists the contents, with the state on each row, and opening one reads its `who`, `openedBy`, and `closedBy`.
- A link between tabs is `open(target)`, which the panel turns into `focus` for the tab it shows. A message link is
  `jump(messageId)`: `setChatOpen`, `requestMessageJump`, then the panel closes. The panel can sit over a closed chat.

### Panel edits

Each goes through [the edit route](structured-memory.md#the-edit-route), naming the revision of the copy it was made on,
one at a time per tab. A tab applies the edit to its copy, and a refusal restores the copy, shows the notice (none for
`epoch`, which halts on its own), and reads again. A success keeps the answer and its revision. `readOnly` only turns
the controls off first: the server's fence decides.

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
copy of its moment. The first that holds: memory off, no action, because the command refuses; `writerPaused` over the
current runs (from the contents) or a newest receipt that reads paused, resume; a newest `notAutomatic` receipt, its
reason and `memoryReceiptView`'s action; a `manual` cadence, reason `manual`. Past those only the action shows. The
press is `pressMemoryRecord`, as on the receipt line, off while pressing, read-only, or the task is live.

## State

- The read path stores nothing of its own: its records are [structured memory's](structured-memory.md#state). What a
  send leaves is on the reply's `generationInfo`: the report in `context` and the receipt in `memory`
  ([Receipts](#receipts)).
- The panel's rows are derived in the tab from the held chat and the routes' answers. Pages and Threads hold a copy of
  what they show, which an edit's answer or a read replaces.

## Coupling

- The trim is HypaV3's select-only path (`trimHistoryToContext`), and the selection chain that runs the step, the memory
  task fence, and embeddings belong to [memory](memory.md#selection-in-assembleprompt).
- The report is `ContextReport.memory`; its parser and the `memory.coverage` rule for other algorithms are in
  [chat-pipeline](chat-pipeline.md).
- The panel reads the routes of [structured memory](structured-memory.md#the-read-routes) and writes through
  [its edit route](structured-memory.md#the-edit-route); the receipts of recorded and failed windows are written by
  [the writer's commit](structured-memory-writer.md#the-writer-task).

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
- `genInfo` is not rendered in the `mobilechat` and `cardboard` themes, so they show no line.
- Coverage's gap and leaving rows read stored text, where a send reads processed text and the greeting: a reply a script
  blanks counts as a turn here, and uncovered history that no longer fits also trims at send time. The panel says so,
  and a preview is the exact form. Decision: Structured Memory D8, plan.
- A press that re-records an event also records the ordinary windows open under its message, as any press does, with no
  cost preview. Decision: Structured Memory D3, plan.
- Coverage counts tokens with the tab's scope, whose model settings fall back when a chat's binding is missing, and a
  refresh with unchanged texts does not recount after a tokenizer change.

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
