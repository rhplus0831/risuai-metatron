# Structured Memory Reply-Only Recording Plan

Status: drafted 2026-11-13 at `d22254262` from the owner's request. D1 is the owner's request; the owner accepted D2,
D3, and D5 the same day, as recommended. D4 and D6 to D18 are this plan's own, found against the code. Audited against
`e2aded6dc` on 2026-11-13
([report](../reports/audits/plan-runner/structured-memory-reply-only-recording-2026-11-13.md)): eleven findings, all
fixed here. D18 comes from the audit and narrows D2; the owner accepted it the same day. Landed: 1 (`40b54af0a`), 2 (`746872808`).

Sources: the owner's request (2026-11-13: give Structured Memory HypaV3's "do not summarize user messages", because
under some prompts the reply does not answer the user's message but takes it and expands on it); `shouldSummarizeChat`
in `server/src/prompt/memory/hypav3.ts`; `confirmedWindows`, `turnsOf`, `windowOf`, `writerCadence`, and `WriterCadence`
in `server/src/prompt/memory/structured/window.ts`; `analysisSlots` and `previousSlot` in `prompts.ts`; `admitAnalysis`
in `analysis.ts`; `castSlice` in `pages.ts`; `buildPrompt` and `replayedInput` in `writer.ts`; `rebuildEntryPlan`,
`rebuildWindow`, `rebuildChanges`, and `memoryWorkCost` in `rebuild.ts`; `adoptedEvents` in `adopt.ts`; `rebuildWork`
and `swapRebuild` in `server/src/prompt/memory/memoryTasks.ts`; `coveredMessages`, `rawWindow`, `staleReasonOf`,
`reconcileMemoryEvents`, and `normalizeStructuredMemorySettings` in `shared/structuredMemory.ts`;
`structuredMemoryFingerprint` in `server/src/jobs/jobScope.ts`; `pressMemoryRebuild` in
`src/lib/Others/StructuredMemory/memoryRecordPress.ts`; `MemorySettings.svelte`, read at `d22254262`; the
[writer](../structure/structured-memory/writer.md), [rebuild](../structure/structured-memory/rebuild.md), and
[lifecycle](../structure/structured-memory/lifecycle.md) guides. The identifiers are the anchors. Re-verify each cited
location before editing (STRUCTURE.md protocol step 5).

## Goal

A memory preset can tell the Structured Memory writer to record from replies only.

- **The writer is handed no user message.** With the switch on, the code puts no user message into a recording's
  prompt, as a window message or as context, and nothing can be quoted from one. A preset's own instructions or custom
  frame that call a chat-history CBS function still expand as written (D18).
- **User messages still leave the prompt with their turn.** An event keeps citing every message of its turn, so
  coverage, the Coverage view, and reconciliation read what they read today.
- **A chat adopted from HypaV3 can clear its leftover user messages.** A backfill attaches them to the events that
  cover their replies, with no model call.

Not goals: showing user messages to the writer as context only (D2); reading HypaV3's own switch (D3); a source that
records that its text was not read (D14).

## Current State

- **HypaV3's switch.** `doNotSummarizeUserMessage` on the preset's settings. `shouldSummarizeChat` leaves a user message
  out of the summary's text and out of the summary's `chatMemos`. HypaV3 drops history by position, so the skipped
  message still leaves the prompt with its window. Structured Memory reads the field nowhere.
- **The writer's windows.** A turn is one assistant message and the unrecorded messages before it. `confirmedWindows`
  closes windows over turns and `windowOf` pairs each message with a fresh anchor, so an event's `sources` cite the
  user messages of its turns. Every window `confirmedWindows` or `rerecordWindows` makes holds a reply.
- **What the writer reads.** `analysisSlots` lists every window message in the `messages` slot as
  `[m:<id>] <speaker>:` and its `memorySourceText`. `previousSlot` adds up to `contextMessages` eligible messages before
  the window as "Context only". `castSlice` picks pages named in the window's texts. `admitAnalysis` accepts a quote
  that is a piece of any window message's text. The `tokens` cadence counts every unrecorded message of a turn.
- **Coverage.** `coveredMessages` is the ids cited by an active, unsuppressed event; `rawWindow` drops only those. A
  message no event cites stays raw until context pressure trims it, and the trim counts as a gap.
  `structuredMemoryStep` asks the gap question only when `confirmedWindows` plans a window, and it plans none for a turn
  whose reply is recorded.
- **Adopted chats.** `adoptedEvents` cites each summary's `chatMemos`. Under HypaV3's switch those are replies only, so
  after adoption the chat's old user messages are cited by nothing
  ([lifecycle limitation](../structure/structured-memory/lifecycle.md#limitations)).
- **Backfill.** `rebuildEntryPlan` in `backfill` mode keeps, of each turn, the messages no event cites, and a turn with
  any left is planned. A turn whose reply is recorded and whose user message is not becomes a window of user messages
  only, which the writer records as an event. `rebuildWork` runs each window on the staged store; a window
  `rebuildWindow` returns null for moves the cursor with no call. `swapRebuild` calls `rebuildChanges`, which for a
  backfill writes the staged events and new pages, and returns null (`nothingRecorded`) when no event was staged.
- **Source order.** `staleReasonOf` reads an event's anchored sources in list order and calls the event `moved` when a
  source sits before the one listed ahead of it, and `inserted` when two sources are further apart than their stored
  indexes. A person's keep (`keptState`) holds only for the exact source list it was taken on.
- **Settings.** The writer's settings are the preset's `settings.structured`, normalized field by field.
  `structuredMemoryFingerprint` digests all of them but the highlight fields, and `replayedInput` refuses a stored
  input whose fingerprint differs. `keyLineGuidance` is the closest existing field: a boolean, default false, that
  applies to events recorded from then on.
- **The rebuild press.** `pressMemoryRebuild` reads `memoryWorkCost`'s answer (`calls`, `messages`,
  `estimatedTokens`) and shows the nothing-to-record toast when `calls` is 0, without sending the command.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-workflow` (both are marked _hard_: each crosses
`shared/`, the server, and the tab).

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused files through the wrapper while
  iterating, `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, `pnpm check:docs`
  for a guide edit, and `pnpm check:tests` for an added test file. Run `pnpm check` again after the last test edit. V4
  (`rg` each changed export and wire field) and V6 (each new test shown failing once with its guarded line broken).
- **Persisted values.** The field name `omitUserMessages` under `settings.structured` is final once slice 1 lands. No
  record shape changes: `MemorySource` and `MemoryEvent` stay as they are.
- **Off means today.** With the field absent or false every newly built prompt, window, plan, preview, and swap is
  what it is at `d22254262`. Slice 1 has a test that the analysis prompt is identical with the field off. One thing
  changes once: the normalizer now writes the field, and `structuredMemoryFingerprint` hashes the stored object, so a
  preset's digest differs from the one a run saved before the upgrade. Such a failed run's input is built again
  instead of replayed. Stored events are untouched.
- **One predicate.** Whether the writer reads a message is decided in one exported function of
  `shared/structuredMemory.ts` (slice 1). No reader compares `role` with the setting on its own.
- **A tab loaded before a slice.** It drops the field on its next edit of any structured memory setting (the existing
  limitation in `writer.md`); a reload ends that. After slice 2 such a tab ignores `folds` and shows the
  nothing-to-record toast for a backfill that only attaches messages.
- **Strings.** New text goes in `src/lang/en.ts` with its Korean in `src/lang/ko.ts` in the same slice. The text says
  "record", not "summarize": the writer records events and pages.
- **Guide.** Each slice names its guides; their `Invariants` apply, and the slice updates the sections and module
  headers that name a changed contract (`window.ts`, `rebuild.ts`, the rebuild paragraph of `memoryTasks.ts`, and the
  comments of `analysisSlots` and `admitAnalysis`). `structured-memory/read.md` is at 38,953 bytes of 40,000: add
  nothing there. Comments and test titles describe behavior, not this plan (STRUCTURE.md T5).
- **Manual checks.** Each slice lists the checks it cannot run. The slice report gives them to the owner as a
  checklist; what is still unrun when the plan closes moves to [manual checks](../backlog/manual-checks.md) under this
  plan's name.

## Order

Serial: 1 → 2. Both edit `shared/structuredMemory.ts`, `rebuild.ts`, `memoryTasks.ts`, `rebuild.test.ts`,
`memoryTasks.test.ts`, `rebuild.md`, `lifecycle.md`, and the language files.

If the run stops after slice 1, the switch works for every chat the writer recorded itself. An adopted chat's leftover
user messages then stay uncited while the switch is on. For a backfill that holds nothing else, the preview counts no
call, so the press shows the nothing-to-record toast and starts nothing; one that also has turns to record runs and
swaps as usual and leaves them. A run that starts all the same (an unreadable preview asks with an unknown
cost) moves past them with no call and stops `nothingRecorded`; a stopped run keeps the chat's rebuild lock until it is
abandoned from the panel, and a resume ends the same way. To record them as today: abandon such a run if there is one,
turn the switch off, and backfill. Slice 1 writes that into `lifecycle.md`; slice 2 replaces it.

## Slice 1. The switch and what the writer reads (_hard_, `structured-memory/writer.md`, `structured-memory/rebuild.md`, `structured-memory/lifecycle.md`)

**Change.**

- `StructuredMemorySettings` gains `omitUserMessages: boolean`, normalized like `keyLineGuidance` (a non-boolean reads
  false). `rg keyLineGuidance` lists the places a new writer field touches, the boot snapshot fixture among them.
- `shared/structuredMemory.ts` exports the predicate (suggested: `memoryWriterReads(message, settings)`): false for a
  message whose `role` is `user` while `omitUserMessages` is on, true otherwise.
- Sources do not change. `windowOf`, `confirmedWindows`, `rerecordWindows`, and `commitWindow` keep citing every message
  of the window (D4).
- The analysis prompt: the `messages` slot lists only the messages the writer reads, each still paired with its own
  source id. `previousSlot` finds the window's start among all eligible messages, as today, and takes its
  `contextMessages` from the ones before it that the writer reads. A custom frame under `fineTuning` gets the same slot
  values. CBS written in the instructions or in a custom frame is not filtered (D18).
- Everything else that reads a window's text takes the read messages: `castSlice` in `buildPrompt`, and the texts
  `admitAnalysis` verifies quotes against (D7). `rg "window\.messages"` and `rg "memorySourceText\("` under
  `server/src/prompt/memory/structured/` to find a reader this list misses; `windowSpeaker` reads replies only and
  stays.
- `WriterCadence` gains the field, `writerCadence` fills it, and the `tokens` cadence adds only the messages the writer
  reads (D8). `memoryWorkCost` builds its own cadence for record now from `readWriterSettings`: it passes the field too.
- Rebuild runs (all three modes):
  - `rebuildEntryPlan` with the switch on keeps a turn that has no reply left as a window of its own and groups by
    `turns` only the turns that have one (D10).
  - `rebuildWindow` returns null when none of its entries is read, so `rebuildWork` moves the cursor with no call (D9).
- The cost previews (`memoryWorkCost`) count `calls` as the windows with a message to read, and `messages` and bytes
  over the read messages only, in the rebuild modes and in `windowsCost`.
- The test run: `testWindow` in `testRun.ts` takes the newest run's window only when the writer reads one of its
  messages; otherwise it takes the window the cadence would close, as it already does for a screened reply (D9).
- `MemorySettings.svelte`: one checkbox beside the key-line guidance one, written through `setStructured`, with a help
  line. Suggested English: label "Leave user messages out of recording"; help "The writer is given replies only. A
  user message still counts as recorded and leaves the prompt with its turn, but what it says reaches memory only when
  a reply restates it. For prompts where the reply expands on what you wrote. CBS in your own writer instructions can
  still bring user messages in. Applies to events recorded from now on."
- No change to: the read path, reconciliation, the projection, receipts, the screening rules, and HypaV3. The patch and
  compaction calls are unchanged too: their slots hold event and page text, and their instructions expand CBS as today
  (D18).

**Test.**

- `server/src/tests/normalizeCollections.test.ts`, beside the other boolean fields: absent, false, true, and a
  non-boolean.
- `window.test.ts`: with the switch on a window's `sources` still list the user messages, and the `tokens` cadence
  closes on reply tokens alone.
- `prompts.test.ts`: the `messages` slot and the context lines hold no user message with the switch on; with it off the
  prompt is identical to today's.
- `analysis.test.ts`: a quote that is only in a user message is `quoteNotFound` with the switch on and verified with it
  off.
- A writer run through the structured harness (`server/src/tests/fixtures/memory/structured/harness.ts`): the request
  the harness captured holds no user text, and the recorded event cites the user message and the reply. A recorded
  run's stored `input` is pruned at settlement, so it cannot show this. Separately: a run that failed with the switch
  off is not replayed after the switch is turned on.
- `memoryJobs.test.ts`, beside the test run's cases: with the switch on, a newest run whose window holds only user
  messages is not the test's window.
- `rebuild.test.ts`: the plan with the switch on (a reply-less turn alone, the others grouped), `rebuildWindow` null for
  a reply-less window, and the previews' `calls`, `messages`, and tokens.
- `memoryTasks.test.ts`: a run whose plan holds a reply-less window moves past it with no model call.
- `MemorySettings.structuredMemory.test.ts`: the checkbox writes the field.

**Guide.** `writer.md`: State (the field, its default, that it applies from then on), The writer's windows, and
Limitations entries for D14 and D18. `rebuild.md`: the plan and the no-call window. `lifecycle.md`: the adopted-chat limitation
gains the interim sentence from Order.

**Manual checks.** A real send and recording on a chat whose prompt expands the user's message, with the switch on:
the event reads as the reply, and the request history shows no user text in the writer's call (with a preset whose
instructions and custom frames use no CBS, D18). The checkbox on the
settings page, in English and Korean. A rebuild preview with the switch on and off on the same chat.

## Slice 2. Backfill attaches the leftover user messages (_hard_, `structured-memory/rebuild.md`, `structured-memory/lifecycle.md`)

**Change.**

- `rebuild.ts` gains a pure function (suggested: `backfillFolds`) that, from the chat's messages as stored, the live
  events, the staged events, and the screening lists, returns the live events to write with more sources:
  - It takes the same confirmed messages `rebuildEntryPlan` takes and their turns (`turnsOf`).
  - A candidate is a user message no live or staged event cites, in a turn whose reply a live event cites.
  - The target is the newest live event citing that reply which `reconcileMemoryEvents` leaves `active` against the
    stored messages; a suppressed one counts. With no target the messages stay as they are (D11).
  - The candidates' fresh anchors (`windowOf`) are merged into the target's sources by current chat position, never
    appended, and no existing source is re-anchored. A target that would not reconcile `active` with the merged list
    is left out whole (D12). Each target is returned once, with every candidate of its turns: the store refuses a
    change set that names an event id twice.
- `rebuildChanges` in `backfill` mode takes those events and writes them with the staged ones. It returns null only
  when there is neither a staged event nor a fold. The update goes through the store's ordinary write, which leaves
  `createdRevision` as the row has it.
- `swapRebuild` computes the folds inside its synchronous step, after the fence and the adoption hold, from the chat as
  stored then, and only for a backfill whose preset has the switch on at that moment. A run that staged nothing and
  folds something ends `done rebuilt`.
- `StructuredMemoryCostAnswer` gains optional `folds`: for a backfill with the switch on, the count of candidates by
  the events' stored status, with no hashing, so it is an upper bound (D13). `readStructuredMemoryCost` in
  `src/ts/process/structuredMemory.svelte.ts` carries it, reading an absent or bad value as 0.
- `pressMemoryRebuild`: the nothing-to-record toast only when `calls` and `folds` are both 0. With `calls` 0 and folds,
  the confirmation says that no model is called and how many user messages are attached to the events that cover their
  replies. With both, the cost text gains that count. New strings in English and Korean.
- A start is refused as today when the plan is empty; reply-less turns are plan windows since slice 1, so a backfill
  that only folds has a plan.

**Test.**

- `rebuild.test.ts` for `backfillFolds`: an adopted event citing three replies gains the three user messages in chat
  order and still reconciles `active`; a reply cited only by a retracted or stale event folds nothing; a user message a
  staged event cites is not folded; the user message before a screened reply goes to the next turn's event; a target
  whose merged list would read `moved` or `inserted`, or whose keep would no longer hold, is left out; a second pass
  over the result folds nothing.
- `rebuild.test.ts` for `rebuildChanges`: a backfill with folds and no staged event returns the folds; rebuild and
  fresh modes ignore them.
- `memoryTasks.test.ts`: a backfill of an adopted chat with the switch on makes no model call, ends `done rebuilt`, and
  leaves the user messages covered (`coveredMessages`); the same run with the switch off records them as today; a run
  with both a reply window and leftover user messages writes the staged event and the folds in one swap.
- The cost route's test: `folds` present for a backfill with the switch on, absent otherwise.
- `src/ts/process/structuredMemory.test.ts`: the answer's `folds`, absent and malformed.
  `src/lib/Others/StructuredMemory/StructuredMemoryPanel.test.ts`, beside the rebuild press cases: the toast, the
  fold-only confirmation, and the mixed one.

**Guide.** `rebuild.md`: Backfill and the swap. `lifecycle.md`: the adopted-chat limitation says what a backfill does
under each setting of the switch, and the interim sentence goes. `memory.md` only if its task-end list names
`nothingRecorded` in a way this changes.

**Manual checks.** On a chat adopted from HypaV3 summaries written under HypaV3's switch: Fill gaps with the new switch
on shows the no-call confirmation, the run ends at once, the old user messages are gone from the next send's prompt,
and the Coverage view shows them recorded.

## Decisions

D1 is the owner's request of 2026-11-13. The owner accepted D2, D3, and D5 the same day. The rest are this plan's;
D7, D9, D10, D13 to D15, and D17 are as the audit of 2026-11-13 left them. D18 comes from the audit, and the owner
accepted it, with the narrowing of D2 it brings, the same day.

- D1. Structured Memory gets a per-preset option to leave user messages out of what the writer records, for prompts
  where the reply expands on the user's message.
- D2. The code hands the writer no user message: not a window message and not a context line (D18 is the one way a
  preset's own text can still bring one in). Showing it as
  context would spend the tokens the option saves and let a directive ("make it more dramatic") shape the summary. The
  cost: in ordinary back-and-forth chat, what a reply does not restate is not recorded. That is why it is off by
  default and per preset.
- D3. The option is a new field, `settings.structured.omitUserMessages`, not HypaV3's `doNotSummarizeUserMessage`. A
  preset that has HypaV3's switch on must not change how existing Structured Memory chats record on the day this lands,
  and the settings page shares only the preset picker, the budget mode, and the memory maximum between the two.
- D4. An event still cites the user messages of its window. HypaV3 can leave them uncited because it drops history by
  position; Structured Memory drops a message only when an active event cites it, so an uncited user message would stay
  in every prompt and turn into a gap. Citing without reading also makes the switch reversible: turning it off leaves
  no message unrecorded.
- D5. A chat adopted from HypaV3 gets its leftover user messages covered by a backfill, not by adoption, so chats that
  are already adopted are reached too.
- D6. The switch applies to events recorded from then on. A stored event keeps what it holds until it is re-recorded or
  the chat is rebuilt, as with `keyLineGuidance`.
- D7. A quote is verified only against the window messages the writer was given, also when a preset's CBS brought
  other history into the prompt (D18). A user message is no evidence under the switch, so a match there must not pass
  as one.
- D8. The `tokens` cadence counts only the messages the writer reads, since its threshold stands for the size of a
  recording. The step and the task both go through `confirmedWindows` with the same cadence, so they agree. The turn
  cadences already count replies.
- D9. A window with nothing to read makes no model call. Two paths can hold one. A rebuild run moves past it through
  the existing null-window branch of `rebuildWork`. The test run can find one as its newest run's window, because a
  backfill made with the switch off records user-only windows and the swap copies staged runs to the live ones; it then
  takes the cadence's window instead. No new skip reason is stored.
- D10. With the switch on, a turn with no reply left is planned as a window of its own. Grouped with the next turn it
  would be cited by that turn's event, and its fate would follow a reply it does not belong to. This is the grouping
  of a run started with the switch on: a run keeps the plan and the cursor it began with. Resumed after the switch was
  turned on, a window planned as a user message of one turn with the whole next turn is recorded whole, and that
  event cites the user message. Resumed after the switch was turned off, a window already passed is not revisited.
  Abandoning the run and starting again gives the new plan.
- D11. Folds are computed at the swap, from the chat as stored then, in a backfill only. A rebuild or a fresh rebuild
  takes whole turns, so its staged events already cite the user messages. The target must be active after
  reconciliation; a stale or retracted event does not cover its reply, so nothing is attached to it and a later
  backfill can try again. A suppressed event takes the fold: its user messages then share the reply's state.
- D12. Folded sources are merged by chat position. `staleReasonOf` reads list order, so an appended user message that
  sits before a reply listed ahead of it would turn the event `moved`. Stored indexes of different ages can also read
  as `inserted`, and a keep holds for one exact list, so the fold is checked by reconciling the result and dropped when
  it would not stay active. A dropped fold loses nothing: the messages stay raw, as they are today.
- D13. A backfill that only folds is still a run: it begins, moves its cursor through the reply-less windows, and
  swaps. The preview says so with `folds`, counted without hashing, because the previews hash nothing by design; the
  swap decides exactly. A run whose folds are all dropped and that staged nothing stops `nothingRecorded`, as any run
  that recorded nothing does: it keeps the chat's rebuild lock until it is abandoned from the panel.
- D14. A source of an unread user message keeps an ordinary anchor, so an edit that changes that message's source text
  still marks its event for a re-record, and on a send before that the event reads stale. The re-record is a full
  writer window for a result that read none of the edited text: one analysis call, a patch call when there are targets,
  possibly compaction, and a new event that retires the old one, with a person's corrected text carried by the existing
  repair rule. Its wording can differ. On an adopted event the window is that summary's eligible, confirmed sources,
  so the adopted summary is replaced by a writer event, as an edit of a cited reply does today. Under the `manual`
  cadence the mark waits for a person. Avoiding all this needs a source that says its text was not read, which is a new
  hash version in the tab and the server; left out (see Not In This Plan).
- D15. The evidence lane and the HypaV3 projection are unchanged. The evidence lane can still show an excerpt of a
  user message, which is raw history by citation and not the writer's text. The projection carries each event's
  summary text and the ids of every cited message, user messages included. The request is about what the writer
  records.
- D16. The gap question is unchanged. It is asked only when a window is planned, and no window is planned for a turn
  whose reply is recorded.
- D17. The switch is read from the scope's chat preset wherever the writer's settings are, so record now, the gap run,
  and rebuilds follow it with no code of their own, and the test run with the one check of D9. A resumed rebuild takes
  it as it stands for what the writer reads and which windows make no call, on the plan and cursor it already has
  (D10).
- D18. The switch filters what the code supplies: the window and context messages and the quote evidence. CBS that a
  preset's instructions or custom frame invoke stays unrestricted. Those texts are parsed with the job's CBS over the
  whole chat (`parseChatML` of the memory host) in the analysis, patch, and compaction calls alike, before the slots
  are filled, so a slot's own text is never evaluated. The default frames and the default (empty) instructions call no
  such function, so a preset that writes none hands the writer no user message.
  - Functions that read the transcript: `userhistory`, `history` (`messages`), `lastmessage`, and `previouschatlog`,
    with their aliases.
  - Functions that parse other text, which can itself call one of those: `persona`, `personality`, `description`,
    `scenario`, `exampledialogue`, `mainprompt`, `jb`, `globalnote`, `authornote`, `charhistory`, and a user-defined
    `call::`, with their aliases.
  - A summary is not checked against quotes, so a fact that reached the prompt this way can be recorded.
  - Why it stays: a person who writes one of these into the writer's instructions asked for it, and giving CBS a
    filtered chat would move every index-based function for those prompts. The help line says so.

## Not In This Plan

- A source that records that its text was not read, so that an edit of an unread user message marks nothing (D14).
- Filtering the chat that CBS reads in the writer's instructions and custom frames (D18).
- Citing the leftover user messages at adoption time. The backfill reaches the same chats and the ones adopted before.
- Showing user messages to the writer as context only, or a per-chat override of the switch.
- Leaving user messages out of the evidence lane or the projection (D15).
- Any change to HypaV3's `doNotSummarizeUserMessage`.

## Open Questions

None open. The owner accepted the three recommended choices on 2026-11-13, and D18 the same day after the audit: CBS
in a preset's own writer instructions or custom frame stays unfiltered.
