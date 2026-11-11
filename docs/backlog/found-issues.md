# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, the seventeenth (the Found Issues Decisions run) on 2026-11-09, the nineteenth (the Upstream Intake 2 run) on 2026-11-10, the twentieth (the Memory Panel Readability run) on 2026-11-11, and the twenty-first (the Structured Memory Recent Timeline run) the same day; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. An entry is a `###` heading under its area section, a paragraph saying what and where (`file:line`), then a **Why it matters:** line and a **Suggested handling:** line; the Contents list at the top counts each area's entries. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's section of [known issues](known-issues.md) (or to the guide's Known Hazards `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

The inbox was emptied on 2026-11-09 by the Found Issues Clearance plan (retired; `git show e8758c2a8:docs/plan/found-issues-clearance.md`): every entry was fixed by one of its slices, recorded as a Limitation or Issue in its guide, or closed with a reason in slice H1's commit. The eighteenth batch, that run's own findings, moved in the same day.

The eighteenth batch was cleared the same day by a Sol implementer with session verification (seven entries fixed with regression tests; the rendered-translation quote entry was closed as not reproduced: a scratch replay of the rendered path with identity Google and LLM translators kept quoted font names, `url("…")` and `content:"…"` intact in every one of twelve cases).

The nineteenth batch and the eight entries of the 2026-11-10 full guide audit (twelve in all) were cleared on 2026-11-10 by Sol implementers and test writers in three worktrees with session verification: eight fixed with regression tests (three in the plugin sandbox, style scoping, the popup editor's row, the chat export's candidate receipts, memory task job ids in shares and reports, the e2e program in `pnpm check:changed`), the dead boot fixture capture driver deleted, the wasmoon upgrade note moved to its module, the checkpoint benchmark given its place in the audit report, and the full-screen alert e2e failure closed as the dev stack's reload on file edits (8 of 8 quiet runs passed; a run under Markdown touches failed the same way).

## Contents

- [Build and dependencies](#build-and-dependencies): 1
- [Structured memory](#structured-memory): 6

## Build and dependencies

### The pdf.js character maps are pinned to an older version than the package

`src/ts/process/dynamicutils/pdf.ts:23` and `:60` set `cMapUrl` to `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/cmaps/`, while `package.json` asks for `pdfjs-dist` `^4.10.38` and the lockfile resolves 4.10.38. Seen on 2026-11-11 while moving the dependency upgrade notes into the guides; not run.

**Why it matters:** the pin did not move with the package, so a PDF that needs a character map reads one from another release. The maps rarely change, so this may have no visible effect.

**Suggested handling:** point both URLs at the installed version (or read the version from the package), and import a PDF with CJK text to confirm.

## Structured memory

### The upstream export report's Korean line still says 이벤트

`src/lang/ko.ts:1920`, `upstreamExport.converted["memory-projected"]`, reads "구조화 기억 이벤트를 하이파 V3 요약 형식으로
변환한 채팅". It names Structured Memory events (`shared/upstreamExportReport.ts:27`) but sat outside the Memory Panel
Readability plan's slice 1 scope, so it kept 이벤트 while every other structured-memory string now says 사건. Seen on
2026-11-11 by that slice.

**Why it matters:** the plan's goal is one Korean term per record kind; this is the one structured-memory-only string
left with the old term.

**Suggested handling:** change it to "구조화 기억 사건을 하이파 V3 요약 형식으로 변환한 채팅"; a one-string change.

### A history jump can open its diff without scrolling to it

`src/lib/Others/StructuredMemory/PagesTab.svelte:404`, `openAskedEntry`, clears `askedEntry` once its page is the copy,
opens the diff, awaits `tick()`, then scrolls the row found under `historyList`. `readContents` and `readRecord` run
independently, and the detail renders only once `contents` is held. If the record and the diff answer before the
contents read, `historyList` is not bound yet, the scroll silently skips, and nothing retries when contents arrive.
Found on 2026-11-11 by the challenger of the Memory Panel Readability plan's slice 2; pre-existing and not run in a
mounted panel.

**Why it matters:** a receipt's "open this history entry" jump is meant to show the entry; on a long page with a slow
contents read the person sees the top of the history instead.

**Suggested handling:** keep the scroll request until the detail is renderable; reproduce first with a deferred
contents read in `StructuredMemoryPanel.test.ts`.

### A memory read round can answer more than the bytes it charged

`roundOf` (`server/src/routes/structuredMemory.ts:209`) charges each row its stored `bytes` (`octet_length(data)`), and
`/package`, `/coverage`, `/story`, and `/find` answer through `compressedJson`, which re-serializes the parsed record. A
database snapshot or checkpoint load keeps a row's raw JSON text (`server/src/data/memoryStore.ts` `checkMemoryRow`), so a
crafted row with numbers such as `1e20` charged 794 stored bytes while its four-field `/story` projection serialized to
2,285 bytes. `checkMemoryRow` also admits an event without `storyTime` or `participants` that the chat-file restore
(`restore.ts`) would refuse; the tab's `parseStoryRound` normalizes these, and other readers may not. Found on
2026-11-11 by the challenger of the Memory Panel Readability plan's slice 4.

**Why it matters:** the guides describe the round budget as the read bound; a crafted snapshot (a restored backup) can
push an answer past it. Low severity: the soft first-record rule already lets one oversized record through.

**Suggested handling:** charge the serialized size, or canonicalize rows when a snapshot loads.

### A memory eval capture counts a flow title as found

`scoreProbe` in `server/src/tests/fixtures/memory/structured/evaluate.ts:125` marks a needed event `found` when any
manifest item carries its id, whatever the lane or `reason`, and `capture` (`:199`) adds those up. Since the flow lane
has two forms, `recent` (a title) and `timeline` (the summary and key lines), a probe "finds" an event the model saw by
title alone. The Recent Timeline plan's slice 4 put `lane` and `reason` on each needed row and split the tool's flow
rows by reason, but left what counts as capture unchanged. Seen on 2026-11-11 by that plan's slice 1.

**Why it matters:** a recall comparison between a title-only card and a timeline card scores both the same, so it
cannot show whether a summary reached the model.

**Suggested handling:** count a `recent` flow item as weaker capture (or report capture with and without titles), and
re-run `node util/memoryEval.mjs` to see what the before and after rows of the timeline report become.

### The memory card counts every timeline line before it spends

`buildMemoryCard` in `server/src/prompt/memory/structured/card.ts:247` counts every line of a lane's `flow.full`, up to
`RETRIEVAL_LIMITS.flowCandidates` (200), before `spendLanes` runs, whatever the budget. At 1,000 turns `selectMemory`
went from 513–569 ms to 557–657 ms (about 400 more `tokenizeChat` calls). The owner kept 200 (Recent Timeline D14),
since a 50,000-token maximum reaches it, and `read.md` Limitations records the time. Measured on 2026-11-11 by that
plan's slice 4 ([report](../reports/measurements/structured-memory-timeline-2026-11-11.md#selection-time)).

**Why it matters:** a send with a small budget pays to count lines it will never admit.

**Suggested handling:** count flow lines on demand in `spendLanes` and `buildMemoryCard`, newest first, stopping where
the run and its extension end, without changing which lines are admitted; compare the cards byte for byte.

### The timeline heading can call a window event's title the last before the messages

`card.ts:86` heads the flow block `Recent events (oldest first; the last is just before the messages below):`, the
wording the Recent Timeline plan prescribed. Lines are ordered by place, and an event whose sources are all inside the
raw window keeps its title line (D12), so the block's last line can be an event among the messages below rather than
just before them. Raised on 2026-11-11 by the challenger of that plan's slice 1; not changed, since the wording is
the plan's.

**Why it matters:** the heading tells the model something the card's order does not always hold; whether a model reads
it that way is unmeasured.

**Suggested handling:** the owner decides the wording (for example, "the last ones may already be in the messages
below"); a one-line change in `card.ts` and its tests.
