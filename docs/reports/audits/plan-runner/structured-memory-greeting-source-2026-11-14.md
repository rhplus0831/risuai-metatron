# Structured Memory Greeting Source Plan audit, 2026-11-14

- Plan: `docs/plan/structured-memory-greeting-source.md`
- Commit audited: `97ad18125` (`claude/greeting-structured-memory-69dc76`, from `dev` at `2ab7071fb`); the corrected
  plan is committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, in place of the usual Sol session because every slice crosses `shared/`
  and the server writer, and two cross the tab; report written by the session that drafted the plan (Claude Opus 5.5),
  before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 6     |
| P2         | 4     |
| P3         | 8     |
| unverified | 0     |

All eighteen are `fixed in plan`. AUD-1 to AUD-11 came from the first turn; the drafting session read AUD-1 to AUD-6
against the code before editing. In the second turn Astra confirmed eight corrections, disputed three (AUD-2, AUD-5,
AUD-8), and found AUD-12 to AUD-18 in the corrections. AUD-16 also corrects Astra's own first reading of AUD-2: an
empty `confirmedBefore` on the task does not fail a rebuild commit, an empty window ceiling would. In the third turn
Astra confirmed all ten remaining corrections and found nothing new. No P1 is open.

Astra changed no file in the repository. It ran eight test files through the wrapper in the first turn (150 passed:
shared memory, windows, rebuild, inheritance, restore, edits, retrieval, and the tab's memory helpers) and two scratch
scripts against the current code; they are kept in `/home/codex/review-reports/greeting-source-audit-2026-11-14/scratch/`.
None of them implements the plan. The full suite, the type and format gates, a browser, and a real provider were not
run. The three turns took about 24 minutes and 7.4 M tokens.

Found consistent: the greeting entry and its HypaV3 source (`assemble.ts:1742`, `:3312`); `readEntries` and
`rawWindow` (`step.ts:195`, `shared/structuredMemory.ts:1470`, `:1503`); `storedMemorySources` and `isSource`
(`shared/structuredMemory.ts:1607`, `restore.ts:90`); unknown record fields kept (`restore.ts:78`, `:237`,
`memoryStore.ts:513`) and every event field but `summary` in the timeline package (`structuredMemory.svelte.ts:1603`),
so the package version can stay at 2; the reverse source tables (`chatStore.ts:294`, `:315`); the mid-chat greeting
picker (`DefaultChatScreen.svelte:1906`); the owner record in the job scope (`jobScope.ts:176`, `:309`); synchronous
character reads for the commit check (`resourceStore.ts:2485`); the same SHA-256 on the server and in the tab
(`memoryStore.ts:1419`, `structuredMemory.svelte.ts:1792`); D11 on the repair route (`shared/structuredMemory.ts:992`,
`edits.ts:53`, `:99`, `routes/structuredMemory.ts:1104`); the `null` memo read back as the greeting entry's
(`hypav3.ts:2492`, `src/ts/process/memory/hypav3.ts:1473`); and `read.md` at 38,892 bytes of 40,000.

Re-check list: `patchMessage` still closes an open fence (`chatStore.ts:2552`, `:1805`). Feed rows are measured whole
with their framing (`chatStore.ts:1987`, `:1926`), and smaller field-level `rowDelta` candidates now exist too
(`:1962`, `:2001`). `STORE_TABLES_SQL` runs only for schema version zero (`resourceStore.ts:3855`) and a new validated
store (`:792`). `sendText` is true when an audience socket accepted the send, not an acknowledgment
(`generationJobs.ts:1024`, `:1039`).

## P1

### AUD-1 — D6: the writer has no plain-text CBS parse — fixed in plan

Plan, D6: "The writer reads the greeting with CBS expanded by the job's `parse`". Code: `MemoryHost` exposes only
`parseChatML` (`host.ts:58`); the plain `parse` is private to `memoryTaskHost.ts:158` and the job host
(`runner.ts:878`). `parseChatML` returns null for text without a ChatML opener (`triggers.ts:143`). New text: slice 1
adds a synchronous `parse` to `MemoryHost` in both builders; D6 names it.

### AUD-2 — Slice 3: a greeting-only rebuild entry cannot be stored or reach the writer — fixed in plan

Plan, slice 3: "The run keeps the greeting's source with its plan"; "the plan gains a window of the greeting alone".
Code: the rebuild plan is stored and read as `string[][]` (`memoryStore.ts:1103`, `:1199`); `rebuildWindow` returns
null without a readable message (`rebuild.ts:348`), and `rebuildWork` passes a null window with no call
(`memoryTasks.ts:1387`). New text: a plan entry form that carries the greeting's source, plain id arrays read
unchanged, `rebuildWindow` returning the greeting-only window with slice 1's first-message ceiling, and a resume
reading the stored source.

### AUD-3 — Slice 1: a greeting-only commit fails after its memory write — fixed in plan

Code: `commitWindow` writes memory (`writer.ts:443`), then calls `writeReceipt` with the window's assistant messages
even when there are none (`:455`); the chat store refuses an empty `ops` list (`chatStore.ts:1115`). Astra's script:
`{"memoryWasWritten":true,"error":"chats[0]: ops must be a non-empty array"}`. New text: no chat receipt when the
window holds no assistant message; the run keeps its receipt.

### AUD-4 — Slice 3: copies and branches drop greeting-only events — fixed in plan

Plan: "A copied or branched event keeps its `greeting` and `greetingKept` as they are". Code: an event crosses only
with message sources that all map (`inherit.ts:114`); a greeting-only event returned `events: []` even on a full
copy. New text: greeting-only events cross copies and branches; mixed events keep the message mapping rules.

### AUD-12 — Slice 1: a greeting-only re-record without a user message completes without recording — fixed in plan

Found in the corrections. Plan: "A person's re-record of such an event goes through the record job without a
`messageId`". Code: without a `messageId` the job takes `writerCeiling` (`recordJob.ts:389`), which is null without an
eligible user message (`window.ts:102`), and reports `completed` with the mark still set. New text: when a
greeting-only re-record is pending, the job uses the first eligible message as an exclusive ceiling; a chat with no
eligible message offers no greeting-only recording, backfill and preview included.

### AUD-13 — Slice 3: the rebuild replacement rule would delete retracted events — fixed in plan

Found in the corrections. Plan: "replaces the live events that cite only the greeting". Code: an ordinary rebuild
keeps every retracted event (`rebuild.ts:423`, the guard at `:484`); only `fresh` removes all (`:475`). New text:
non-retracted live events only; retracted ones stay stored.

## P2

### AUD-5 — Slice 2: a rebuild leaves the old greeting-only event active beside its replacement — fixed in plan

Plan: the changed label says "a re-record of the event or a rebuild reads the current one". Code: replacement and mark
transfer read message ids only and need `ids.length > 0` (`rebuild.ts:481`, `:486`). New text: a staged greeting
citation replaces live greeting-only events and carries their marks (narrowed by AUD-13).

### AUD-6 — Slice 2: the evidence lane would show the changed greeting as evidence — fixed in plan

Plan, D5: the model sees "the old greeting's facts in memory and not the new greeting"; slice 2 lets the evidence lane
excerpt a dropped greeting. Code: `ReadEntry.text` is the current processed greeting (`step.ts:195`); event-source
excerpts (`retrieve.ts:558`) and the dropped-entry pool (`:573`) both read it. Astra's script returned the swiped
greeting's text as evidence for an event recorded from the first. New text: both passes skip a greeting whose recorded
citation does not match the current one; `greetingKept` does not count.

### AUD-14 — Slice 3: "no anchored message" also covers missing message sources — fixed in plan

Found in the corrections. Code: adoption makes a missing memo an unanchored source (`adopt.ts:77`) and requires none
for an active event (`:113`); reconciliation stales such an event (`shared/structuredMemory.ts:1665`). New text: the
greeting counts for the nonempty-source condition, and every message source must still be anchored.

### AUD-15 — D2's automatic exception against Order and Not In This Plan — fixed in plan

Found in the corrections. An edit-driven re-record of the first event (`reconcile.ts:60`, `memoryTasks.ts:1186`)
includes the greeting under slice 1, while Order said existing chats send it until slice 3 and Not In This Plan
excluded automatic greeting recording. New text in all three: no greeting-only window from the automatic writer; a
re-record that is already due may include it.

## P3

- AUD-7 — D4: `memorySourceText` keeps the text inside a style block (`shared/structuredMemory.ts:1515`), so a style
  change does change the hash. D4 and its test now say tag or attribute changes only. Fixed in plan.
- AUD-8 — Slice 1: `restore.ts` restores no runs (`restore.ts:43`, `:231`). Run `greeting` is read through
  `storedMemoryGreeting` by its consumers (narrowed by AUD-17). Fixed in plan.
- AUD-9 — Slice 2: the Timeline orders by `memoryTimelineRows` (`structuredMemory.svelte.ts:2030`), not
  `firstSourceIndex`. Both, and the route's source position, now give the greeting -1. Fixed in plan.
- AUD-10 — Order and slice 1: the changed contracts reach `rebuild.ts:99`, `assemble.ts:721`, `edits.ts:367`,
  `TimelineTab.svelte:355`, `memoryTestResultView` (`structuredMemory.svelte.ts:2411`), and the rebuild store adapter
  (`rebuild.ts:519`). Slice 1 lists them; Order names the wider overlap. Fixed in plan.
- AUD-11 — Slice 3: a greeting-only window is one analysis call; page-patch and compaction calls can follow
  (`shared/structuredMemory.ts:865`, `writer.ts:849`, `:923`). Fixed in plan.
- AUD-16 — Slice 3: a rebuild commit checks the window's ceiling (`memoryTasks.ts:1248`), so the queue keeps its empty
  `confirmedBefore` fallback. Fixed in plan.
- AUD-17 — Slice 1: the run store has no normalizer (`memoryStore.ts:623`, `:1288`). Consumers normalize. Fixed in
  plan.
- AUD-18 — D2: an edit-driven re-record that includes the greeting adds no analysis window but can add patch or
  compaction calls (`writer.ts:884`, `:938`). Fixed in plan.

## Noted, not recommended

- A chat file imported into another character keeps its events' `greeting`, so the target's greeting can leave the
  prompt unrecorded. This is D5's choice; the "changed" label shows it.
- Adoption anchors the `null` memo to today's greeting and cannot prove which greeting HypaV3 summarized.
- Groups and a later reset marker need no coverage reaction: the prompt has no greeting entry then.
- Switching a chat to HypaV3 does not by itself store the projection; the `null` memo matters where projected
  summaries are read.
- A covered event is not guaranteed a place in every memory card; D5's "the model sees" means available memory.
