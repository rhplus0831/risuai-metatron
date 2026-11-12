# Structured Memory Reply-Only Recording Plan audit, 2026-11-13

- Plan: `docs/plan/structured-memory-reply-only-recording.md`, archived: `git show eb1855de0:docs/plan/structured-memory-reply-only-recording.md`
- Commit audited: `e2aded6dc` (`dev`); the corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, in place of the usual Sol session because both slices cross the shared
  settings contract, the server writer and rebuild, and the tab; report written by the session that drafted the plan
  (Claude Fable 5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 1     |
| P2         | 6     |
| P3         | 4     |
| unverified | 0     |

All eleven are `fixed in plan`. AUD-1 to AUD-9 came from the first turn; the drafting session read each against the
code before editing. Astra then read the corrected plan in the same session: it confirmed AUD-2 to AUD-9 and the four
small additions taken from its traces, asked for the user-only condition to be explicit in AUD-4, confirmed the
mechanism of the AUD-1 correction while asking for wider wording, and found AUD-10 and AUD-11 in the corrections.
The AUD-1 wording, the AUD-4 condition, AUD-10, and AUD-11 were applied afterwards and were not read again. No P1 is
open.

AUD-1 is not fixed the way Astra first suggested. Astra suggested giving CBS a chat without user messages in the
writer's prompts. The plan narrows the claim instead (D18): the switch filters what the code supplies, and CBS that a
preset's own instructions or custom frame invoke stays unrestricted. That narrows D2, which the owner accepted as
"hidden entirely"; the owner accepted D18 on 2026-11-13, after reading this finding.

Astra changed no file in the repository (`git status` showed only the plan, edited by the drafting session). It ran
twelve test files through the wrapper in the first turn (532 passed) and two in the second (99 passed), and three
scratch probes against the current code: the job's CBS host parsing a writer frame and instructions that call a
chat-history function, with reply-only slots; the real resource store on an in-memory database for a folded swap, a
null-window run, the stale and kept merge cases, and a duplicate event id; and `memorySettingsFingerprint` with the
proposed field absent, false, and true. The probes and their output are in
`/home/codex/review-reports/reply-only-recording-audit-2026-11-13/scratch/`, with Astra's two answers beside them.
None of the probes implements the plan. The full suite, the type and format gates, anything in a browser, and a real
provider were not run. The two turns took 23 minutes and about 9.9 M tokens.

Found consistent: HypaV3's switch and positional drop (`hypav3.ts:858`, `:1006`, `:503`) against coverage by citation
(`shared/structuredMemory.ts:1437`); the reader list of slice 1 for the prompt, the context lines, the cast, and quote
admission (`prompts.ts:275`, `:357`, `pages.ts:283`, `analysis.ts:556`), with alias seeds, the speaker, replay and
repeat detection, historical analysis, warming, receipts, and highlights reading no window text that needs a filter;
D8, the step and the task deciding cadence through the same `confirmedWindows` call (`assemble.ts:685`,
`memoryTasks.ts:1169`, `window.ts:354`); the null-window path of a rebuild run, from a `confirmedBefore` that is a
user message through `advance` to the swap (`rebuild.ts:525`, `memoryTasks.ts:1367`, `:1382`,
`memoryStore.ts:1175`); D11 and D12, the swap writing an existing event again through the ordinary write, which
keeps `createdRevision`, does not apply `eventSummaryChars`, and accepts an adopted event (`memoryStore.ts:503`,
`:1228`), and the drop-unless-active rule covering both a mixed-age `inserted` case and a kept event
(`shared/structuredMemory.ts:1615`, `:1675`); the optional `folds` field on the cost route and in the tab's parser
(`routes/structuredMemory.ts:1677`, `structuredMemory.svelte.ts:828`); D16, the gap question's condition
(`assemble.ts:646`, `:662`); the new field reaching every reader of the writer's settings through the shared
normalizer (`hypaV3Presets.ts:69`, `writer.ts:221`, `resourceStore.ts:2314`, `MemorySettings.svelte:273`); every test
file the slices name; and `read.md` at 38,953 bytes.

Re-check list: `patchMessage` still closes an open fence (`chatStore.ts:2558`); feed rows are still measured whole
(`chatStore.ts:1918`, `resourceStore.ts:3706`); `STORE_TABLES_SQL` still runs only on a fresh database
(`resourceStore.ts:3858`), the other use being a new staging database (`:792`). The fourth entry's wording is stale,
as earlier reports found: `sendText` is true when a socket of the audience took the frame, which is queueing and not
an acknowledgment (`generationJobs.ts:1020`, `:1025`, `:1035`).

## P1

### AUD-1 — D2: a preset's own CBS can still bring user messages into the writer's prompt — fixed in plan

Plan, D2: "A user message is hidden from the writer entirely". Slice 1: "A custom frame under `fineTuning` gets the
same slot values" and "No change to: … the patch and compaction calls".

Code: the writer's instructions and a custom frame are parsed with the job's CBS before the slots are filled
(`prompts.ts:417`, `writer.ts:293`), in the patch and compaction calls too (`writer.ts:863`, `:928`). The memory host
builds that CBS over the whole job scope (`memoryTaskHost.ts:151`, `:259`). `{{userhistory}}` reads user messages from
`chat.message` (`shared/cbs/registry.ts:355`); `history`, `lastmessage`, and `previouschatlog` read the transcript
too (`:1668`, `:774`, `:1251`), and `persona`, `personality`, `description`, `scenario`, `exampledialogue`,
`mainprompt`, `jb`, `globalnote`, `authornote`, and `charhistory` parse other text that can call one (`:240` to
`:431`). Astra's probe: with reply-only slots, a custom frame, the default frame's instructions, and the patch and
compaction instructions each held the user text. The default frames and the default, empty instructions call none of
these (`prompts.ts:202`, `:237`, `:253`, `shared/structuredMemory.ts:1753`), and a slot's own text is never evaluated
(`prompts.ts:401`), so nothing reaches the prompt this way unless the preset's text asks for it.

New text: the Goal says the writer "is handed" no user message; D2 points at D18; D18 says the switch filters what the
code supplies and names the two groups of functions; slice 1 says CBS in the instructions or a custom frame is not
filtered and separates the patch and compaction calls' slots from their instructions; `writer.md` gets a Limitations
entry; filtering the chat that CBS reads is under Not In This Plan; the owner accepted D18 the same day.

## P2

### AUD-2 — D9, D17: a test run can also find a window with nothing to read — fixed in plan

Plan, D9: "Only a rebuild run can hold one". D17: "the test run follow it with no code of their own".

Code: a backfill made with the switch off records user-only windows (`rebuild.ts:141`), and the swap copies staged
runs to the live ones (`memoryStore.ts:772`, `:1234`). `testWindow` takes the newest run's window after checking
confirmation and screening only (`testRun.ts:109`, `:116`, `:121`), and the writer then makes the analysis request
(`testRun.ts:249`, `writer.ts:807`).

New text: slice 1 has `testWindow` take the newest run's window only when the writer reads one of its messages, else
the cadence's window, as for a screened reply, with a case in `memoryJobs.test.ts` (`:4458` tests the screening
fallback). D9 names both paths; D17 says the test run needs that one check.

### AUD-3 — D10, D17: a resumed run keeps its plan and cursor — fixed in plan

Plan, D10: "a turn with no reply left is planned as a window of its own". D17: "a resumed rebuild takes it as it
stands".

Code: a resume queues the stored plan unchanged (`rebuild.ts:543`, `memoryStore.ts:1199`) and goes on from the stored
cursor (`memoryTasks.ts:1318`), reading each window's messages again but not its grouping (`:1341`). A window planned
with the switch off as a user message of one turn with the whole next turn is recorded whole when resumed with it on
(`analysis.ts:663`); a window passed with the switch on is not revisited when resumed with it off
(`memoryStore.ts:1175`).

New text: D10 says the grouping is that of a run started with the switch on, gives both resume cases, and says that
abandoning and starting again gives the new plan. D17 says a resume takes the switch as it stands on the plan and
cursor it already has.

### AUD-4 — Order: a run that records nothing stays stopped and keeps the rebuild lock — fixed in plan

Plan, Order: "a backfill plans them, moves past them with no call, and ends `nothingRecorded`. Turning the switch off
for one backfill records them as today."

Code: with a readable zero-call preview the press shows the toast and sends nothing (`memoryRecordPress.ts:139`). A
run that starts all the same reaches a null change set and ends `skipped nothingRecorded` without a swap
(`memoryTasks.ts:1282`); the run row stays (`:620`) and locks generation (`resourceStore.ts:2426`,
`generationJobs.ts:2263`). A resume returns to the same end, and a new start is refused while the run exists
(`rebuild.ts:549`). Astra's probe reached `done: 2, total: 2` with no staged event and `rebuilding: true`.

New text: Order describes the toast for a backfill that holds nothing else, the stopped run and its lock, and the
recovery (abandon, switch off, backfill). D13 says a run whose folds are all dropped and that staged nothing stops
the same way.

### AUD-5 — D14: an edit of an unread source costs a whole writer window — fixed in plan

Plan, D14: "The re-record gives the same event for one model call."

Code: an edit that changes a source's text marks the event (`reconcile.ts:376`, `:495`), and `automaticRerecords`
takes it except under the `manual` cadence (`:59`, `:64`). The window is the event's eligible, confirmed sources
(`window.ts:279`). The writer calls analysis, the patcher when there are targets, and possibly compaction
(`writer.ts:807`, `:878`, `:932`); the repair makes a new event and retires the old one, carrying a person's
corrected text (`analysis.ts:599`, `:603`, `reconcile.ts:331`).

New text: D14 describes that window and its calls, says the wording can differ, that an adopted summary is replaced
by a writer event over its eligible sources, and that the `manual` cadence waits for a person.

### AUD-6 — Rules: adding the field changes a preset's digest once — fixed in plan

Plan, Rules: "With the field absent or false every prompt, window, plan, preview, and swap is what it is at
`d22254262`."

Code: `structuredMemoryFingerprint` hashes the stored `structured` object (`jobScope.ts:469`), and normalization
writes a newly defaulted field into stored presets (`hypaV3Presets.ts:69`, `resourceStore.ts:1031`). Astra's probe:
the digest with the field absent differs from the digest with it false. A run that failed before the upgrade is then
not replayed (`writer.ts:340`) and its prompt is built again (`:528`).

New text: the rule covers newly built prompts, windows, plans, previews, and swaps, and names the one-time digest
change and the rebuilt input.

### AUD-10 — Slice 1, D7: the help line and D7 promised more than D18 leaves — fixed in plan

Plan, as first corrected: help "The writer reads replies only … what it says reaches memory only when a reply restates
it"; D7 "The model never saw the others".

Code: D18's own exception. Astra's probe expanded user text through `{{persona}}` holding `{{previouschatlog::0}}`
(`shared/cbs/registry.ts:308`, `:1256`), and a summary is admitted with no quote check (`analysis.ts:650`).

New text: the help line says the writer "is given" replies only and that CBS in the writer's own instructions can
still bring user messages in; D7 says a quote is verified against the window messages the writer was given, also when
CBS brought other history in; the slice's manual check names a preset without CBS; D18 lists the functions that parse
other text and says a fact that arrives this way can be recorded.

## P3

### AUD-7 — Order: three files both slices edit were not listed — fixed in plan

Plan, Order: "Both edit `rebuild.ts`, `rebuild.test.ts`, `rebuild.md`, `lifecycle.md`, and the language files."

Code: `shared/structuredMemory.ts` holds the settings and the cost answer (`:612`, `:797`); `memoryTasks.ts` holds the
`rebuildWindow` call and `swapRebuild` (`:1341`, `:1266`); both slices put tests in `memoryTasks.test.ts` (`:3531`).

New text: Order lists the three.

### AUD-8 — Slice 1, Test: a recorded run's stored input is pruned — fixed in plan

Plan, slice 1: "the stored `input` holds no user text".

Code: a settling commit prunes the run prompts (`writer.ts:435`, `memoryStore.ts:561`), and a test asserts that a
recorded run has no `input` (`memoryTasks.test.ts:5923`). The harness exposes the captured requests
(`harness.ts:479`).

New text: the test reads the captured request, and the replay case is separate.

### AUD-9 — D15: the projection carries summaries and ids, not raw messages — fixed in plan

Plan, D15: "Both show raw history by citation, not the writer's text".

Code: the evidence lane shows source excerpts (`retrieve.ts:563`); the projection writes `text: event.summary` and
`chatMemos` from the event's sources (`shared/structuredMemory.ts:1263`).

New text: D15 describes each.

### AUD-11 — Slice 1: the cost preview bullet sat under the test run bullet — fixed in plan

Plan, as first corrected: the cost preview bullet nested under "The test run".

Code: the cost preview is `memoryWorkCost` (`rebuild.ts:436`), not part of `testWindow`.

New text: the cost preview is a bullet of its own, ahead of the test run's.

## Noted, not recommended

Astra listed these as not worth planning for, and the plan leaves them: an event grown near
`MAX_READ_RESPONSE_BYTES` refusing a fold swap (`memoryStore.ts:529`); a random id collision between a staged and a
live event (`analysis.ts:603`, `memoryStore.ts:516`); later deletion, the exact-set carry of a correction
(`rebuild.ts:280`), and a partial copy (`inherit.ts:114`) now depending on the folded user sources as well; event and
page text recorded before the switch still holding what users said (D6); and a no-call backfill still needing the
memory model and the task service to be available (`rebuild.ts:502`).
