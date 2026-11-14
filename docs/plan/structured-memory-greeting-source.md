# Structured Memory Greeting Source Plan

Status: drafted 2026-11-14 at `2ab7071fb` from the owner's request. D1 is the owner's request; the owner accepted D2,
D6, and D9 the same day, as recommended, and chose D5 (a changed greeting is shown, not acted on). The rest are this
plan's own, found against the code. D11 is the owner's request of the same day. Audited against `97ad18125` on
2026-11-14 ([report](../reports/audits/plan-runner/structured-memory-greeting-source-2026-11-14.md)): eighteen
findings, all fixed here. Landed: 1 (`ff4089306`), 2 (`5fe5d2253`), 3 (`db551febc`).

Sources: the owner's report (2026-11-14: the request log shows the first message in every request); `assemblePrompt`'s
greeting entry and `hypaV3Sources` in `server/src/prompt/assemble.ts`; `HypaV3EntrySource`, `hypaV3SourceHash`, and
`createHypaV3SourceValidator` in `server/src/prompt/memory/hypav3.ts`; `greetingText` in `shared/greetings.ts`;
`eligibleHistory` in `shared/eligibleHistory.ts`; `MemorySource`, `MemoryEvent`, `MemoryRun`, `storedMemorySources`,
`coveredMessages`, `rawWindow`, `ReadEntry`, `memorySourceHashFields`, `memoryAnchorState`, `memoryRerecordTarget`,
`projectHypaV3Data`, and `MEMORY_PACKAGE_VERSION` in `shared/structuredMemory.ts`; `WriterWindow`, `confirmedWindows`,
`recordedMessages`, `readRecordedMessages`, `rerecordWindows`, `historicalWindow`, and `windowStillConfirmed` in
`server/src/prompt/memory/structured/window.ts`; `commitWindow`, `sameWindow`, `buildPrompt`, and `replayedInput` in
`writer.ts`; `analysisSlots` and `previousSlot` in `prompts.ts`; `admitAnalysis` and `repeatsEvent` in `analysis.ts`;
`castSlice` in `pages.ts`; `testWindow` in `testRun.ts`; `readEntries`, `sendWindow`, and `selectMemory` in `step.ts`;
`prepareRetrieval` and `knownFacts` in `retrieve.ts`; `rebuildPlan`, `rebuildEntryPlan`, `rebuildWindow`,
`rebuildChanges`, `backfillFolds`, and `memoryWorkCost` in `rebuild.ts`; `adoptedEvents` in `adopt.ts`; `isSource` in
`restore.ts`; the inheritance builder in `inherit.ts`; `rebuildWork` and `swapRebuild` in
`server/src/prompt/memory/memoryTasks.ts`; `loadJobScope` in `server/src/jobs/jobScope.ts`; `firstSourceIndex` in
`server/src/routes/structuredMemory.ts` and `src/ts/process/structuredMemory.svelte.ts`; `reconcileMemoryCoverage` in
the same tab file; `TimelineTab.svelte`, `PagesTab.svelte`, and `CoverageTab.svelte` under
`src/lib/Others/StructuredMemory/`; the [writer](../structure/structured-memory/writer.md),
[read](../structure/structured-memory/read.md), [records](../structure/structured-memory/records.md),
[lifecycle](../structure/structured-memory/lifecycle.md), [rebuild](../structure/structured-memory/rebuild.md), and
[projection](../structure/structured-memory/projection.md) guides. The identifiers are the anchors. Re-verify each
cited location before editing (STRUCTURE.md protocol step 5).

## Goal

Under Structured Memory the chat's greeting stops being sent forever.

- **The writer records the greeting.** In a new chat, the first window the writer records also reads the greeting,
  and its event cites it.
- **A recorded greeting leaves the prompt.** When an active event cites the greeting and the greeting is outside the
  raw window, the send leaves it out, as it leaves out a covered message.
- **A changed greeting is shown, not acted on.** When the card's greeting or the chat's choice of greeting changes
  after it was recorded, the panel says so and the person decides whether to re-record.
- **Existing chats can catch up.** A rebuild, a backfill, a re-record of the first event, and an adoption of HypaV3
  summaries can each give the greeting a citation.

Not goals: changing how the greeting is shown in the chat; the greeting of a group chat (a group has none); HypaV3,
SupaMemory, or Hanurai; noticing a card edit when it is saved (D5).

## Current State

- **The greeting in the prompt.** `assemblePrompt` pushes the greeting (`greetingText(character, chat.fmIndex)`, then
  CBS `parse` and the `editprocess` scripts) as the first history entry, for a solo chat with no reset marker. It
  records `greetingSource` (`fmIndex` and the stored text) for HypaV3.
- **Why it never leaves.** `readEntries` gives the greeting entry no `messageId` and no role. `rawWindow` drops only an
  entry outside the window whose `messageId` an active, unsuppressed event cites (`coveredMessages`). So the greeting
  stays until the context trim removes it, and Structured Memory keeps the prompt small enough that the trim rarely
  runs.
- **Sources are messages.** `MemorySource` is `{ messageId, hash, index }` or its unanchored form.
  `storedMemorySources` drops anything without a string `messageId`. `restore.ts`'s `isSource` refuses any other
  shape. Event records are JSON in `memory_events.data`; the reverse tables `memory_event_sources` and
  `memory_staged_event_sources` index only string `messageId`s. Records keep fields their type does not name, and the
  timeline package writes every event field but `summary` as metadata.
- **The writer's windows.** `confirmedWindows` builds windows only from stored messages; `WriterWindow` pairs
  `sources` with `messages`. `recordedMessages` is a set of message ids. `windowStillConfirmed` re-checks every source
  against the stored chat at commit. `analysisSlots` lists each message as `[m:<id>] <speaker>:`. `admitAnalysis`
  accepts a quote only from the window's read texts.
- **Reconciliation.** `staleReasonOf` (through `reconcileMemoryEvents`) reads only message sources; a message edit
  marks events through `reconcileMessageChanges`. No memory hook runs when a character's `firstMessage` or
  `alternateGreetings` changes, or when a chat's `fmIndex` changes: those are an ordinary character write and a chat
  `meta` write. The greeting picker on the chat's first message changes `fmIndex` at any time, mid-chat included.
- **HypaV3's precedent.** `HypaV3EntrySource` has a `greeting` kind with `fmIndex` and `textHash`;
  `createHypaV3SourceValidator` compares both with the chat as stored before a summary commits. A stored HypaV3 summary
  keeps only `chatMemos`, where the greeting is a `null` memo. `adoptedEvents` drops that `null` on purpose.
- **Job scope.** `loadJobScope` loads the owner character with every stored field, so the writer task, the record
  job, and rebuild runs can compute `greetingText` for a solo chat. `commitWindow`'s store contract reads no character
  today.
- **The panel.** Timeline and Pages render one button per source id and label an id with no message `messageGone`.
  Coverage rows are stored messages only, and its estimate already says that a send also carries the greeting.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-workflow` (each slice is _hard_: each crosses
`shared/` and the server, and slices 2 and 3 the tab).

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused files through the wrapper while
  iterating, `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, `pnpm check:docs`
  for a guide edit, and `pnpm check:tests` for an added test file. Run `pnpm check` again after the last test edit. V4
  (`rg` each changed export and wire field) and V6 (each new test shown failing once with its guarded line broken).
- **Persisted values.** Slice 1 fixes the names: `MemoryEvent.greeting` and `MemoryRun.greeting`, each an optional
  `MemoryGreetingSource` `{ fmIndex: number; hash: string }` (D3), and `MemoryEvent.greetingKept`, the same shape
  (D11). `MemorySource` does not change.
- **One reader.** The stored field is read only through one exported normalizer in `shared/structuredMemory.ts`
  (suggested: `storedMemoryGreeting(stored)`, null for anything that is not the shape), and whether it matches the
  chat's greeting only through one predicate (suggested: `greetingCited(source, current)`), shared by the server and
  the tab. The predicate decides what a window records and what the panel shows; it never decides coverage (D5).
- **Absent means today.** An event, run, chat, or package without the field reads and behaves exactly as at
  `2ab7071fb`. A group chat, and a chat whose history starts after a reset marker, never get or use one (D8).
- **A tab loaded before a slice.** It keeps the field as an unknown one on records it rewrites, and shows nothing for
  it. A reload ends that.
- **Strings.** New text goes in `src/lang/en.ts` with its Korean in `src/lang/ko.ts` in the same slice.
- **Guide.** Each slice names its guides; their `Invariants` apply, and the slice updates the sections and module
  headers that name a changed contract (`window.ts`, `step.ts`'s `readEntries`, `rebuild.ts`, `adopt.ts`). `read.md`
  is at 38,892 bytes of 40,000: slice 2 replaces text there rather than adding, and puts the greeting's record rules in
  `records.md`. Comments and test titles describe behavior, not this plan (STRUCTURE.md T5).
- **Manual checks.** Each slice lists the checks it cannot run. The slice report gives them to the owner as a
  checklist; what is still unrun when the plan closes moves to [manual checks](../backlog/manual-checks.md) under this
  plan's name.

## Order

Serial: 1 → 2 → 3. Slices 2 and 3 both build on slice 1's field, predicate, and changed contracts (the recorded-source
result, the re-record target, the memory host), and all three edit `shared/structuredMemory.ts`,
`src/ts/process/structuredMemory.svelte.ts`, `rebuild.ts`, and `records.md`. Slice 3 does not need slice 2's prompt
drop, but runs after it so each slice reviews against the one before.

If the run stops after slice 1, new events cite the greeting but every send still carries it, as today. If it stops
after slice 2, new chats lose the greeting from the prompt once it is recorded, and so does an existing chat whose
first event was re-recorded since slice 1; other existing chats keep sending it until slice 3 adds backfill, rebuild,
and adoption.

## Slice 1. The record and the writer (_hard_, `structured-memory/records.md`, `structured-memory/writer.md`)

**Change.**

- `shared/structuredMemory.ts`:
  - `MemoryGreetingSource`, the optional `greeting` on `MemoryEvent` and `MemoryRun`, `storedMemoryGreeting`, and
    `greetingCited` (true when both `fmIndex` and `hash` equal the chat's current greeting; false for a group or no
    greeting).
  - The greeting hash (suggested: `memoryGreetingHash`): the version-3 digest over the fields
    `["greeting", memorySourceText(text)]` of the stored, unexpanded greeting text, through the same hashers the server
    and the tab use for message sources (D4).
  - `memoryRerecordTarget` answers for an event that cites only the greeting; every caller follows (`edits.ts`'s
    re-record repair, `TimelineTab.svelte`'s re-record choice).
  - `StructuredMemoryTestResult` carries the greeting apart from the message ids.
- `restore.ts`: an event `greeting` and `greetingKept` must be the shape or absent; anything else is refused like a
  bad source. Chat files and timeline packages restore no runs. The run store keeps a run as its raw JSON (it has no
  normalizer), so every run consumer, replay and the test-run reader among them, reads `greeting` through
  `storedMemoryGreeting`. `MEMORY_PACKAGE_VERSION` stays (D3).
- The memory host (`server/src/prompt/memory/host.ts`) gains a synchronous plain-text CBS parse (suggested:
  `parse(text)`) beside `parseChatML`, which returns null for text without a ChatML opener. Both builders implement it
  with their existing scope and failure checks: `createMemoryTaskHost` (`memoryTaskHost.ts`, which already holds a
  private `parse`) and the job host in `runner.ts`. The writer expands the greeting with it before the slots are
  filled (D6).
- `window.ts`:
  - `WriterWindow` gains an optional `greeting: { source: MemoryGreetingSource; text: string }`, where `text` is what
    the writer reads (D6).
  - `recordedMessages` and `readRecordedMessages` also answer whether a readable event in any status cites the greeting
    (suggested: a `{ messages, greeting }` result). A retracted citation counts, as for messages.
  - `confirmedWindows` takes the chat's greeting, or none for a group or a reset (D8). When the greeting is not
    recorded, it joins the window that holds the first eligible message. It is not a turn: the turn cadences count as
    today, and the `tokens` cadence adds its text.
  - `rerecordWindows` keeps the greeting on the window of an event that cited it, and adds it when that event's window
    holds the first eligible message and no other event records the greeting.
  - `windowStillConfirmed` refuses a greeting window when the chat's current greeting no longer matches its source
    (`windowChanged`).
  - `historicalWindow` treats the greeting as before every message, so a greeting window with no message source still
    takes the historical path when another event exists.
  - A greeting-only window (slice 3's backfill, or a re-record of a greeting-only event) has no message to confirm
    through. Its ceiling is the first eligible stored message, exclusive: the greeting is confirmed once any eligible
    message follows it, and a chat with none offers no greeting-only recording (the backfill plan and its preview
    included). A person's re-record of such an event goes through the record job without a `messageId`, since
    `recordJob.ts` refuses a press on anything but an eligible reply. Without a `messageId` the job takes its ceiling
    from `writerCeiling`, which is null without an eligible user message and ends the job `completed` with the mark
    still set; when a greeting-only re-record is pending, the job uses the first eligible message as an exclusive
    ceiling instead. Ordinary ceilings stay as they are.
- `writer.ts`: `commitWindow`'s store contract reads the owner character to get the current greeting (the resource
  store's synchronous `get`); `rebuild.ts`'s restricted staged-store adapter forwards that reader. `sameWindow` and
  `replayedInput` compare the greeting too. The committed event and the run carry the window's `greeting.source`.
  When the window holds no assistant message, `commitWindow` writes no chat receipt: today it calls `writeReceipt`
  with an empty `ops` list after the memory write, and the chat store refuses that, so the task would fail after its
  memory committed. The run keeps its receipt.
- Every caller of the changed recorded-source result: `assemble.ts`, the record job, the memory task service, the
  previews, and `rebuild.ts`'s helpers.
- `prompts.ts`: `analysisSlots` lists the greeting first, as `[greeting] <character name>:` and its text.
  `previousSlot` is unchanged: no message comes before the greeting.
- `analysis.ts`: `admitAnalysis` accepts a quote from the greeting text as from any window message; `repeatsEvent`
  reads a greeting citation.
- `pages.ts`: `castSlice` reads the greeting text with the window's texts. A page section's `sources` stay messages
  only (D7).
- `testRun.ts`: `testWindow` rebuilds a greeting window from its run, and the result lists the greeting apart from the
  message ids; the tab's `memoryTestResultView` reads it.
- The record job, record now, and the gap run pass the greeting through the same `confirmedWindows` call.
- `memoryWriterReads` is unchanged; the greeting is always read, `omitUserMessages` or not.

**Test.**

- `shared` tests: `storedMemoryGreeting` (absent, the shape, wrong types); `greetingCited` (same, `fmIndex` changed,
  text changed, a tag or attribute change that `memorySourceText` removes, a group); the hash equal on the server and in
  the tab for the same text.
- `restore.test.ts`: an event with a good `greeting` and `greetingKept` restores; a bad one is refused; one without is
  unchanged. A run's raw `greeting` round-trips through the run store, and `storedMemoryGreeting` reads a malformed one
  as none.
- The memory host tests: `parse` expands `{{char}}` and `{{user}}` in plain text, under both builders.
- `window.test.ts`: a new chat's first window carries the greeting; a chat whose greeting is recorded (any status)
  gets none; a reset or a group gets none; the `turns` cadence closes as before and the `tokens` cadence counts the
  greeting; a re-record of the first event keeps or adds the greeting; `windowStillConfirmed` refuses after an
  `fmIndex` change and after a greeting text change; a greeting-only window confirms through the first eligible
  message.
- `writer.test.ts`: a greeting-only window commits its memory and writes no chat receipt.
- The record job's test: a greeting-only re-record on a chat with replies but no eligible user message records and
  clears the mark.
- `prompts.test.ts`: the `[greeting]` line comes first; a window without one is identical to today's prompt.
- `analysis.test.ts`: a quote found only in the greeting is verified.
- A writer run through the structured harness (`server/src/tests/fixtures/memory/structured/harness.ts`): the
  captured request holds the greeting, and the event stores `greeting` with the chat's `fmIndex` and hash.

**Guide.** `records.md`: the `greeting` field, its hash, and that it is not a `MemorySource`. `writer.md`: The
writer's windows (where the greeting joins), State, and a Limitations entry for D6's read text.

**Manual checks.** A new chat with a greeting that uses `{{user}}` and `{{char}}`: after the first recording, the
writer's request (request log) shows the greeting first with the names expanded, and the event's record holds
`greeting`.

## Slice 2. The send leaves a recorded greeting out (_hard_, `structured-memory/read.md`, `structured-memory/records.md`, `structured-memory/projection.md`)

**Change.**

- `assemble.ts` passes the greeting's source (`fmIndex` and the stored-text hash, from `greetingSource`) to
  `structuredMemoryStep`; `readEntries` marks the greeting entry with it (suggested: `ReadEntry.greeting`).
- `shared/structuredMemory.ts`: coverage also answers whether the greeting is covered: an active, unsuppressed event
  has a `greeting` (suggested: `coveredMessages` returns `{ messages, greeting }`). Whether that citation still matches
  the chat's greeting does not matter here (D5). `rawWindow` drops the greeting entry when it is before `start` and
  covered. The greeting does not count as a `char` turn.
- `step.ts`: the dropped greeting comes off the count like a dropped message; the trim and its gap count it as today
  when it is still there. A continue never targets it.
- `retrieve.ts`: `prepareRetrieval` and `knownFacts` place a greeting citation at the greeting entry. The evidence lane
  can show a dropped greeting as an excerpt under its own id (suggested: `greeting`), never `entries[index].messageId!`,
  but only when the event's recorded `greeting` matches the current greeting (`greetingCited`; `greetingKept` does not
  count). Both evidence passes apply this: the event-source excerpts and the pool of dropped entries. `ReadEntry.text`
  is the current greeting, so a changed one would otherwise come back as evidence for an event recorded from another
  greeting, through the pool even when the events lane is closed (D5).
- `projectHypaV3Data`: an event with a `greeting` puts `null` first in its `chatMemos`, which HypaV3 reads as the
  greeting entry's memo, and orders that event as if at index -1. The route's source position, the tab's
  `firstSourceIndex` (the timeline package), and `memoryTimelineRows` (the Timeline, which prefers current message
  positions) give a greeting citation position -1, also when the event cites messages still present.
- The tab:
  - `reconcileMemoryCoverage` and the Coverage join take the chat's current greeting (the tab holds the character).
  - Coverage lists the greeting as its first row with its own role label, recorded and leaving like a message row
    (D9). Its token counting (`CoverageTab.svelte`) stops assuming every row indexes `messages`.
  - Timeline and Pages show an event's greeting citation as a "Greeting" source, never as `messageGone`; its button
    jumps to the top of the chat. Pages finds it through the section's provenance events, since section `sources` stay
    messages (D7).
  - A citation that `greetingCited` does not match the chat's greeting shows a "changed" label on that source and on
    the Coverage row, with a help line: the event was recorded from an earlier greeting, the prompt still leaves the
    greeting out, and a re-record of the event or a rebuild reads the current one (D5). Nothing else changes: the
    event keeps its status, and no re-record is marked or started. A citation the person kept for the current
    greeting (`greetingKept` matches it) shows no label.
  - The label offers three choices: re-record the event (the existing repair), rebuild (the existing press), or keep
    the record as it is (D11).
- Keep, through the existing event repair route: `applyEventRepair` in `edits.ts` takes a new repair (suggested:
  `{ repair: "keepGreeting", greeting }`, where `greeting` is the current greeting's source as the panel showed it).
  The route reads the owner character for the chat's greeting. It refuses `changed` when that greeting no longer
  equals the one sent, as `keep` refuses a chat that moved on, and `invalid` for an event with no `greeting`, a
  retracted one, or a group. Otherwise it stores `greetingKept` with the sent source and changes nothing else: the
  citation, the status, and a `rerecord` mark stay. Keeping again replaces the field.
- The coverage route sends the event's `greeting` and `greetingKept` beside `messageIds`.
- Strings: the greeting source label, the Coverage role, the "changed" label with its help line, and the keep choice,
  in English and Korean. `coverage.estimate`'s sentence about the greeting changes to say it is counted.

**Test.**

- `shared` tests: `rawWindow` drops a covered greeting outside the window; keeps it inside the window, uncovered, or
  covered only by a stale, retracted, or suppressed event; still drops it after an `fmIndex` change and after a text
  change, with the event still active.
- `step` tests through `selectMemory`: the dropped greeting's tokens come off the count; an uncovered greeting trimmed
  for context still counts as a gap.
- `retrieve.test.ts`: an event citing only the greeting has a place; the evidence lane's excerpt for a dropped
  greeting; no excerpt, from either pass, of a greeting that no longer matches the event's citation, kept or not.
- `projectHypaV3Data` test: `null` first in `chatMemos`, the event ordered first.
- `src/ts/process/structuredMemory.test.ts`: the Coverage join's greeting row; the panel tests: the "Greeting" source
  in Timeline and Pages, and the "changed" label after an `fmIndex` change and a text change, absent for a markup-only
  change, absent after a keep, and back after a second change.
- `edits.test.ts` (or the repair route's test): `keepGreeting` stores `greetingKept` and changes nothing else; refused
  `changed` when the greeting moved after it was shown, `invalid` without a `greeting`, on a retracted event, and on a
  group.
- An assembly test (`assemble` or the generation harness): a chat whose first event cites the greeting sends no
  greeting once the window has moved past it; the same chat after a greeting swipe still sends none.

**Guide.** `read.md`: The read path's drop rule (replace, do not add), the Limitations entry about Coverage reading
stored text. `records.md`: coverage of the greeting. `projection.md`: the `null` memo.

**Manual checks.** In a long chat started after slice 1: the request log stops showing the greeting once the window
has passed it; Coverage shows the greeting row as leaving; the Timeline shows "Greeting" on the first event and its
button opens the top of the chat. Swipe the greeting: the next request still has no greeting, the Timeline and Coverage
show "changed". Keep it: the label goes and the request is unchanged. Swipe once more: the label is back. A re-record
of the first event clears it and its new record reads the new greeting. In English and Korean.

## Slice 3. Existing chats (_hard_, `structured-memory/rebuild.md`, `structured-memory/lifecycle.md`)

**Change.**

- `rebuild.ts`:
  - `rebuild` and `fresh` mode: the first window of the plan carries the greeting when the chat has one (D8), through
    the same rule as `confirmedWindows`.
  - `backfill` mode: when no readable event records the greeting, the plan gains a window of the greeting alone, ahead
    of the others: one analysis call, on the historical path, which can also make page-patch or compaction calls like
    any historical window (D2). A backfill whose only work is that window still starts.
  - The persisted plan: `memoryStore.ts`'s `rebuild.begin` and its plan reader store `string[][]` today. A plan entry
    gains a form that carries the greeting's source (alone, or with the first window's ids); a stored plan of plain id
    arrays reads unchanged. `rebuildWindow` returns a window for a greeting-only entry instead of null (today a window
    with no readable message is null and `rebuildWork` passes it with no call), with slice 1's first-message ceiling.
    A rebuild commit checks the ceiling `rebuildWindow` returns, not the task's `confirmedBefore`, so the queue keeps
    its empty fallback (`plan.at(-1)?.at(-1) ?? ""`) for a greeting-only plan. A resume reads the stored source, and
    the commit refuses a greeting that changed since.
  - `rebuildChanges` in `rebuild` mode: a staged event citing the greeting replaces the non-retracted live events that
    cite only the greeting, with their trust marks carried under the existing standing-event rules. Today replacement
    and mark transfer read message ids only and need `ids.length > 0`, so the old greeting-only event would stay active
    beside the new one. Retracted events stay stored, as an ordinary rebuild keeps every retracted event today; `fresh`
    keeps its removal of every live event.
  - `memoryWorkCost` counts the greeting's bytes in the window that carries it, and one analysis call for a
    greeting-only window.
- `adopt.ts`: `adoptedEvents` takes the chat's current greeting, from the adoption route, which reads the owner and
  passes none for a group or a reset. The first summary whose `chatMemos` holds `null` becomes an event with `greeting`
  anchored to the greeting as it stands now, as adoption anchors a held message as it stands now. A valid greeting counts as
  a source for adoption's nonempty-source condition, but every message source must still be anchored: an event with the
  greeting alone is active, not stale as an event with no source is today, and one with an unanchored message source
  stays stale. The comment about
  dropping the `null` is replaced.
- `inherit.ts`: a copied or branched event keeps its `greeting` and `greetingKept` as they are: the copy shares the
  past it records (D5). Today an event crosses only when it has message sources and all of them map, so a
  greeting-only event is dropped even from a full copy; it now crosses on copies and branches alike, and a mixed event
  keeps the message mapping rules.
  The panel shows "changed" when the target chat's greeting differs.
- The chat file import restores `greeting` as stored, with the same label when it differs.
- A person's re-record of the first event (slice 1's `rerecordWindows` rule) is the cheapest path for one chat:
  `lifecycle.md` says so.

**Test.**

- `rebuild.test.ts`: a rebuild's and a fresh rebuild's first window carries the greeting; a backfill plans a
  greeting-only window first when the greeting is unrecorded and none when it is recorded; `rebuildWindow` returns the
  greeting-only window; a rebuild's staged greeting citation replaces a live greeting-only event and carries its
  marks, and leaves a retracted one stored; the previews' bytes and calls; a group and a reset plan none.
- The rebuild store's test: a plan with a greeting entry round-trips, and a stored plan of plain id arrays reads as
  before.
- `memoryTasks.test.ts`: a backfill whose only window is the greeting makes its analysis call, writes on the
  historical path, and swaps; a greeting changed during the run refuses that window; a resumed run reads the stored
  greeting.
- `adopt.test.ts`: the `null` memo becomes `greeting` on the first summary's event, which is active when it has no
  other source and stale when it also cites a message that is gone; a group drops it as today (the existing case changes).
- `inherit.test.ts`: a greeting-only event crosses a full copy and a branch; a mixed event keeps `greeting` and maps
  its messages as before, also when the target's `fmIndex` differs.

**Guide.** `rebuild.md`: The plan (greeting entries, the greeting-only window), Backfill, and the swap's replacement
rule. `lifecycle.md`: adoption and copies and branches.

**Manual checks.** On a chat recorded before slice 1: Fill gaps shows one call, records a greeting event, and the next
request has no greeting once the window has passed it. On a chat adopted from HypaV3 after this slice: the first event
shows "Greeting".

## Decisions

D1 is the owner's request of 2026-11-14. The owner accepted D2, D6, and D9 the same day, as recommended. The owner
chose D5 the same day, in place of the plan's first recommendation, and asked for D11. The rest are this plan's.

- D1. The greeting becomes something Structured Memory records and can leave out of the prompt, like a message. Today
  it is sent with every request for as long as the chat fits.
- D2. A chat whose first messages were recorded before this plan gets no greeting-only window from the automatic
  writer: it is recorded by a backfill, a rebuild, or a re-record of the first event. The automatic writer would
  otherwise spend at least one model call on every such chat at its next send, unasked. An automatic re-record of the
  first event that an edit of a message it cites already asked for includes the greeting through slice 1's rule,
  without another analysis window; the greeting's facts can still lead to page-patch or compaction calls. Adoption
  needs no call.
- D3. The greeting is a separate optional field, not a new kind of `MemorySource`. Every message-only consumer
  (reconciliation, the reverse source tables, message-change reactions, page sections, adoption's memo lookup) stays
  as it is, and a stored record that lacks the field reads as today. The timeline package already writes every event
  field, and an older server keeps an unknown field as it is, so the package version stays.
- D4. The greeting's hash is over its stored text, as `memorySourceText` reads it, with `fmIndex` stored beside it,
  as HypaV3 does. Both must match. A change `memorySourceText` removes (a tag or attribute whose kept text is the same)
  leaves the citation valid, as it does for a message under hash version 3. The text inside a style block is kept text,
  so a change to it does change the hash.
- D5. A recorded greeting is settled history. When the chat's greeting later stops matching the citation (the card
  was edited, or the picker swiped to another greeting), nothing changes on its own: the event stays active, the
  greeting stays out of the prompt, and no re-record is marked or started. The panel labels the citation "changed",
  and the person decides whether to re-record the event or rebuild. A card edit does not change what happened in this
  chat, it can reach every chat of the character at once, and a mid-chat swipe is rare. Two rejected choices: putting
  the new greeting back into the prompt (the plan's first recommendation) would act without the person; staling the
  event would bring every message it covers back for one card edit. No hook watches card writes: the label is computed
  where the panel reads coverage. Until a re-record the model sees the old greeting's facts in memory and not the new
  greeting. A person who is content with that keeps the record (D11). The evidence lane never shows a greeting that
  differs from the event's citation, since its text is not what the event was recorded from.
- D6. The writer reads the greeting with CBS expanded by the memory host's new plain-text `parse`, without the
  `editprocess` scripts, so
  `{{user}}` and `{{char}}` read as names. Messages reach the writer without scripts too. The hash stays over the
  stored text, so a CBS value that changes per send (a random pick, the time) does not unsettle the citation.
- D7. A page section never cites the greeting. Its sources stay messages; a page fact drawn from the greeting cites
  the window's messages. This keeps `MemorySource` closed (D3).
- D8. Only a solo chat whose history the greeting starts has one: a group has no greeting, and after a reset marker
  the prompt carries none. A chat that gains a reset marker later keeps its event's `greeting`, which then covers
  nothing.
- D9. Coverage shows the greeting as its own first row, since Coverage is where a person sees what leaves the prompt.
  The estimate text stops calling the greeting a difference from the send.
- D10. The greeting joins the first window and is not a turn of its own. As a turn, the `turns` cadence would close
  the first window one reply early, and a new chat's greeting could become an event with no message.
- D11. A person can accept a changed greeting without a model call: keep stores the greeting they saw in
  `greetingKept`, and the label is gone while the chat's greeting equals it. The citation itself is not rewritten, so
  the record still says which greeting the event was recorded from, and a later change shows the label again. This
  follows the stale-event `keep` (`keptState`), which also holds only for the state the person saw. Keep marks
  nothing, so a re-record or a rebuild is still there afterward.

## Not In This Plan

- A memory hook on character card writes or `fmIndex` changes, and any automatic reaction to a changed greeting
  (D5).
- A greeting citation in a page section (D7).
- Recording the greeting of an existing chat automatically as a window of its own; an edit-driven re-record of the
  first event that is already due may include it (D2).
- The greeting in HypaV3, SupaMemory, or Hanurai beyond the projection's `null` memo.
- Showing the greeting in Coverage with the processed text a send uses.

## Open Questions

None open. On 2026-11-14 the owner settled Q2 (D2), Q3 (D6), and Q4 (D9) as recommended, and Q1 (D5) with a "changed"
label and the person's choice instead of an automatic reaction.
