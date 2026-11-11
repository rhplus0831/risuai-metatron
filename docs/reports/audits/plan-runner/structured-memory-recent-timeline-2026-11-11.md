# Structured Memory Recent Timeline Plan audit, 2026-11-11

- Plan: `docs/plan/structured-memory-recent-timeline.md`
- Commit audited: `e280c3904` (`dev`); the corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, in place of the usual Sol session because the plan crosses the server read
  path, the shared settings and report contracts, and the tab; report written by the session that drafted the plan
  (Claude Fable 5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 2     |
| P2         | 4     |
| P3         | 1     |
| unverified | 0     |

AUD-1 and AUD-3 to AUD-7 are `fixed in plan`. Astra read the corrected plan in the same session and confirmed AUD-1,
AUD-3, AUD-4, AUD-5, and AUD-6 against the code; it disputed one clause of the AUD-7 correction and gave the
replacement, and asked that AUD-1's and AUD-6's corrections say three things more. Those were applied in Astra's
sense and were not read again after that last edit. Astra found no new P1 or P2 in the corrected text. AUD-2 is not a
plan error that wording can fix: the owner accepted it as a limitation, which the plan records as D13, so no P1 is
open.

Astra changed no file in the repository (`git status` showed only the plan). It ran the plan's focused command (498
passed, 25 files), five more test files (279 passed), two scratch probes against the current `spendLanes`,
`buildMemoryCard`, `preflightMemoryCard`, and `normalizeStructuredMemorySettings`, and
`node util/memoryEval.mjs --lang en --turns 20 --max-context 250000`, which reaches a 50,000-token maximum today. The
probes and their output are in `/home/codex/review-reports/structured-memory-recent-timeline-audit-2026-11-11/scratch/`.
The full suite, the type and format gates, and anything in a browser were not run. The two turns took 23 minutes and
about 7.2 M tokens.

Found consistent: the cited defaults and constants (`shared/structuredMemory.ts:1675`, `retrieve.ts:76`, `:114`,
`:377`); every test file and guide section the slices name; `timeline` as an item reason and a finite flow target in
`parseContextReport` (`shared/contextReport.ts:475`, `:509`); verification by tag holder, whatever the reason
(`assemble.ts:3089`); the report stored on `generationInfo.context` (`assemble.ts:2562`, `runner.ts:1970`), so the
sentinel case in `MemoryManifest.svelte:125` must stay; no other reader of a report assuming flow items are titles
(`structuredMemory.svelte.ts:2076`, `shared/structuredMemory.ts:1184`, `chatStatus.svelte.ts:292`); the list of
`laneTargets` readers, with `recordVectorTexts`' argument (`retrieve.ts:658`) and the two warming sites needing only
whether a lane is on (`writer.ts:701`, `memoryTasks.ts:1431`); the fingerprint already covering new settings fields
(`jobScope.ts:444`); chat overrides, the package, and the upstream export holding no lane settings; D7's arithmetic
(1,310, 982, 491, 327, 163 at 3,276; 20,000, 15,000, 7,500, 5,000, 2,500 at 50,000), with a stored 0 overridden under
`auto` as the plan says; D5 and D12 (`retrieve.ts:907`, `:927`); separate rule texts for the analysis, patch, and
compaction calls (`prompts.ts:339`, `:363`, `:385`); no record or receipt shape changed, so checkpoints and chat
files need no migration.

Re-check list: the plan adds no fence-closing path, publishes no feed row, and changes no table (`chatStore.ts:2533`,
`:1917`, `resourceStore.ts:3830`). The fourth entry's wording is stale, as the 2026-11-10 and the other 2026-11-11
reports found (`generationJobs.ts:1020`, `:1035`).

## P1

### AUD-1 — Slice 1: the final trim could leave an excerpt without its event — fixed in plan

Plan, slice 1: "`buildMemoryCard`'s last loop drops the oldest title first, then the run's oldest line."

Code: an item with `requires` is admitted only after the item it names (`lanes.ts:95`), and the last loop relies on
dropping in reverse admission order so that evidence goes before its event (`card.ts:207`, `:270`). Rendered parts
cost more than their lines (`card.test.ts:173`). Astra's probe: with a maximum of 40, one full flow line and its
excerpt render to 50; dropping the flow line first leaves the excerpt alone at 35, an orphan.

New sentences: the loop is unchanged and drops the last admitted item; the admission order is the core round (the
run, then its titles, then the other lanes), the lending, then the run's extension with the titles it moved; a title
the extension turns into a full line counts as an extension line; an excerpt whose event enters only in the extension
is not admitted. At Astra's request the plan also says what this costs: "Core admissions outlast extension ones: an
extension summary can go while a core title stays."

### AUD-2 — Settings: a tab loaded before the change resets the new fields on its next edit — accepted by the owner

Plan, Rules: "A new settings field is optional"; D7: "a person's numbers are one select away."

Code: `setStructured` stores `normalizeStructuredMemorySettings(target.structured)` whole
(`MemorySettings.svelte:213`), and the normalizer keeps only the keys it knows (`shared/structuredMemory.ts:1664`).
Nothing makes a tab loaded before a server upgrade reload or refuses its writes: a mutation carries the database epoch
and a record revision, not a build (`resourceClient.ts:114`, `routes/resources.ts:97`). So a tab that still runs the
old bundle and edits a structured memory setting writes the preset without `laneSplit`, `laneTargets.flow`,
`flowKeyLineEvents`, and `keyLineGuidance`, and they read as `auto`, 1500, 3, and `false` from then on. The four old
lane counts and every other field that tab knows survive; no record is touched.

What Astra established for the decision:

- The mechanism is not this plan's. Any field added after a tab loaded is lost the same way, as `fineTuning` and
  `volatileBeforeLastUser` were when they were new. No guide records it.
- It needs an edit of a structured memory setting in the stale tab. An edit of another preset field is a patch that
  leaves `structured` alone (`resourceSync.svelte.ts:2673`).
- The cheapest server-side fix merges the omitted leaves from the stored preset of the same id before normalization,
  in the patch path and both whole-write paths of `resourceStore.ts` (`:1550`, `:1784`, `:2668`), with a helper in
  `shared/hypaV3Presets.ts`. Omission could then no longer mean reset for those leaves.

The choice was between recording it as a limitation of every new writer setting, and adding that merge to the
resource store as a slice of its own. The owner chose the limitation on 2026-11-11: the plan's Rules and D13 state
it, and slice 1 writes it into `writer.md` Limitations. Astra did not read D13's wording.

## P2

### AUD-3 — Slice 1: "no exclusion" needs the final card — fixed in plan

Plan, slice 1: "The events lane does not admit an event the run holds, and that event is no exclusion".

Code: `retrieveLanes` lists every placed event the events lane does not rank as `not-relevant` before any spending
(`retrieve.ts:991`); `step.ts:387` joins those with the card's exclusions unfiltered, `sendManifest` counts them
(`step.ts:430`), and a selection can keep a second card (`step.ts:363`). With the events lane closed, an event shown in
full under `flow` would also be listed as left out.

New sentence: "`step.ts` takes the events-lane exclusions of the events the card shows in full under `flow` out of
`excluded`, on the card it keeps, before `sendManifest` counts and bounds them. An event listed by title keeps today's
per-lane exclusion." `step.ts` joins the slice's files, with a case in `assemble.test.ts`.

### AUD-4 — Slice 3: the caller that passes the setting was missing — fixed in plan

Plan, slice 3: "On, the analysis call's `rules` slot gains one line", with `prompts.ts` the only server file.

Code: `analysisSlots` takes an `AnalysisInput` with no settings (`prompts.ts:77`, `:336`); its caller is
`writer.ts:306`, which reads the settings at `:292` and fills the default and the custom frame from the same slots
(`:318`).

New sentence: "`analysisSlots` takes it as an optional input, and `writer.ts` … passes `keyLineGuidance`; the test run
goes through the same call. The default-prompts route answers the rule text without the line." `writer.ts` joins the
slice's files.

### AUD-5 — Slice 2: the fixture's own retrieval call was left to slice 4 — fixed in plan

Plan, slice 2: "retrieval through its input", with the fixture folder named only in slice 4.

Code: `server/src/tests/fixtures/memory/structured/harness.ts:805` calls `retrieveLanes` itself for its diagnostics,
with the settings and no maximum; once retrieval takes resolved targets, that call fails to type or reads the wrong
budget.

New sentence: "The evaluation fixture's `harness.ts` calls `retrieveLanes` itself for its diagnostics and passes the
targets resolved from the same maximum as its selection." `harness.ts` joins slice 2's files.

### AUD-6 — Slices 1 and 4: a flow target of 0 did not give today's card — fixed in plan

Plan, slice 1: "With a target of 0 … the lane is exactly today's"; slice 4: "The same rows at `27dac4d50`'s behavior".

Code: today's card has no order line (`card.ts:145`), and today's loop drops the last admitted item, not a title
first (`card.ts:270`). Astra's probe: one flow title and one events item at a maximum of 40 keep the title today (25
tokens) and the events item under the first draft's rule (35).

New sentences: the heading changes only with a flow target above 0; the loop is unchanged (AUD-1); "With a target of 0
the lane's items, the tokens it spends, its trimming, its text, and the target it reports (`Number.MAX_SAFE_INTEGER`)
are exactly today's, and no full line is rendered or counted"; the flow lane's switch is its own, "in
`preflightMemoryCard` too", and "A title is never held to the lane's target, only to `maximum`"; slice 4's before rows
rest on what slice 1 pins. The last three clauses are Astra's conditions for the claim to hold against `lanes.ts:113`,
`:127`, `card.ts:194`, and `:253`.

## P3

### AUD-7 — File lists and Order were incomplete — fixed in plan

Plan: Order, "Slices 1 and 2 both edit …"; slice 4's Files; slice 3, "`writer.md`: the prompts section and State".

Code: the three settings slices also share `boot-snapshot.json`, the normalization and settings tests, and
`writer.md`; `RETRIEVAL_LIMITS` lives in `retrieve.ts:76`, which slice 4 edits if `flowCandidates` changes;
`shared/contextReport.ts:95` says the flow lane has no token target; the writer guide's section is "Pages and calls"
(`writer.md:143`).

New sentences: Order lists every shared file; slice 1 names `shared/contextReport.ts`; slice 3 names "Pages and
calls"; slice 4 reads "`shared/structuredMemory.ts` if the shares change, `retrieve.ts` if `flowCandidates` changes",
which is Astra's wording after it disputed the first correction.

## Noted, not recommended

- The events lane ranks its 48 candidates before the run is known, so run events can hold candidate places and an
  older event at rank 49 is already out (`retrieve.ts:996`). The plan now says so in D11 and slice 4 counts it; no
  replenishment is planned.
- Key lines are assigned before the events lane's skips, so fewer than `flowKeyLineEvents` flow lines can carry them
  when the events lane shows some of the newest events; their lines are then in that lane.
- Shares do not guarantee a full budget: candidate caps, whole lines, and the run's stop can leave room.
- Three wordings were corrected without a finding: the ledger's figures in Current State (3,211 is the English
  recount, 3,253 the Korean count by the selection's tokenizer), D9's "can change", and D11's note.
