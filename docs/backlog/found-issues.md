# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, the seventeenth (the Found Issues Decisions run) on 2026-11-09, the nineteenth (the Upstream Intake 2 run) on 2026-11-10, the twentieth (the Memory Panel Readability run) on 2026-11-11, the twenty-first (the Structured Memory Recent Timeline run) the same day, the twenty-second (the Per-Chat Memory run) on 2026-11-13, and the twenty-third (the Lore Budget Send Stop run) the same day; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. An entry is a `###` heading under its area section, a paragraph saying what and where (`file:line`), then a **Why it matters:** line and a **Suggested handling:** line; the Contents list at the top counts each area's entries. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's section of [known issues](known-issues.md) (or to the guide's Known Hazards `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

The inbox was emptied on 2026-11-09 by the Found Issues Clearance plan (retired; `git show e8758c2a8:docs/plan/found-issues-clearance.md`): every entry was fixed by one of its slices, recorded as a Limitation or Issue in its guide, or closed with a reason in slice H1's commit. The eighteenth batch, that run's own findings, moved in the same day.

The eighteenth batch was cleared the same day by a Sol implementer with session verification (seven entries fixed with regression tests; the rendered-translation quote entry was closed as not reproduced: a scratch replay of the rendered path with identity Google and LLM translators kept quoted font names, `url("…")` and `content:"…"` intact in every one of twelve cases).

The nineteenth batch and the eight entries of the 2026-11-10 full guide audit (twelve in all) were cleared on 2026-11-10 by Sol implementers and test writers in three worktrees with session verification: eight fixed with regression tests (three in the plugin sandbox, style scoping, the popup editor's row, the chat export's candidate receipts, memory task job ids in shares and reports, the e2e program in `pnpm check:changed`), the dead boot fixture capture driver deleted, the wasmoon upgrade note moved to its module, the checkpoint benchmark given its place in the audit report, and the full-screen alert e2e failure closed as the dev stack's reload on file edits (8 of 8 quiet runs passed; a run under Markdown touches failed the same way).

The twentieth and twenty-first batches, a build entry, and one finding still in memory (eight in all) were worked on 2026-11-12 by Sol implementers and test writers in three worktrees with session verification: five fixed (the pdf.js character map URL, the Korean export line, the history jump's scroll and the refresh scan with regression tests, the eval's capture beyond titles); the on-demand timeline count tried and reverted as not worth its cost (`b29a883a5`, `bb2ede7d6`; the read guide's Limitation has the numbers); the read round's byte charge reproduced and moved to [known issues](known-issues.md#structured-memory); and the timeline heading reworded the same day by the owner's decision (`the last ones may already be in the messages below`).

The twenty-second batch is the first wave of the wide review of 2026-11-14 at `05df12543` (eleven read-only reviewers
by area, then a second reader of another model for each report with a finding): five new entries, each reproduced by
both readers with a probe test kept with the review material outside the repository, and runtime results added to the
preview, HypaV3 checkpoint, and lore limit entries below and to the restored-row entry in
[known issues](known-issues.md#structured-memory). The tokenizer entry was in memory since 2026-11-12.

The twenty-third batch is the second wave of the same review (2026-11-14, twelve reviewers: six over the server's
routes, five re-reading the fixes made since 2026-11-05, one running the guides' unconfirmed claims; a second reader
for each of the eleven reports with a finding): seventeen new entries below, each reproduced by both readers except
the one marked P3, and three confirmed claims moved from the guides' Issues to [known issues](known-issues.md).

The twenty-second and twenty-third batches were worked on 2026-11-14 by implementers and test writers in seven
worktrees with session verification (each new test was run against its fix reverted, then the whole suite on the
merged branch): every entry of the two batches was fixed with a regression test except the three below. The message
search keeps one cost: a hit in a single message of 16 MiB still takes about two seconds to build its snippet. Two
siblings the implementers found were fixed with them (the tab's MCP client and the tab's lore preview), and the three
confirmed claims left [known issues](known-issues.md) fixed.

## Contents

- [Selection](#selection): 1
- [Server generation](#server-generation): 1
- [Test tooling](#test-tooling): 1

## Selection

### `onCharacterSelected` has no product listener left

`onCharacterSelected` (`src/ts/storage/selection.svelte.ts:155`) lost its only product registration when the Per-Chat
Memory plan's slice 1 (`ea39acfcb`) removed the `alwaysToggleOn` hook in `characterStore.svelte.ts`. Only tests
register listeners now (`src/ts/storage/tests/characterRecords.test.ts`, the selection probe in
`resourceSyncLive.test.ts`). No guide names it. Found 2026-11-12 during that slice.

**Why it matters:** a dead extension point keeps its ordering contract (listeners run after the selection changes) and
its tests with no caller to need them.

**Suggested handling:** drop the function and the tests that only exercise it, or keep it with a module comment
saying it is a deliberate hook.

## Server generation

### A long unbroken run of letters stalls every request while its tokens are counted

The `o200k_base` and `cl100k_base` encoders take quadratic time on one unbroken run of letters, and the server
encodes synchronously on the thread that serves every request (`server/src/prompt/tokenizers/index.ts:131`). The count
route passes the caller's text with a 2 MiB body cap and no limit per string (`server/src/routes/tokens.ts:110`).
Found 2026-11-12 while speeding up `promptRunner.test.ts`. Reproduced 2026-11-14 in a running server (wide review,
cut X3, and a second run): a 200 KB run counted with `o200k_base` held an unrelated boot read for 17.6 s (15.2 s on
the rerun) and `cl100k_base` for 16.6 s; the other 13 local families stayed under 0.5 s, and the same bytes with
spaces took 84 ms. A mock model reply of 200 KB stalled the server 17.7 s; a send over a chat that already stores
such a message took 78.7 s, a preview 32.3 s, and a memory test 39.1 s. The `server-generation` guide's Limitations
record tokenizer calls on the main thread as accepted on 2026-11-10 (worker isolation is a separate design); that
decision carries no numbers.

**Why it matters:** one signed-in client, an imported card, or a model reply can leave an instance answering nobody
for the length of the count.

**Suggested handling:** the owner's note of 2026-11-14: "Token counting isn't always fast, so I'm considering moving
it to a worker thread." A size refusal before encoding at the shared gateway (`tokenizers/index.ts:19`) is the cheap
bound; it was offered and not taken, since it also refuses legitimate large text. An exact count of a large text
needs the encode off the serving thread, which is the worker design.

## Test tooling

### The job handoff driver's fixture is never given the database write consent its listener needs

`util/playwright/checkJobHandoff.mjs:312` seeds only the `replacer` grant for its fixture plugin, whose `chatOutput`
listener calls `risuai.setChatToIndex` (`:80`); that call needs the periodic `dbWrite` consent
(`src/ts/plugins/apiV3/v3.svelte.ts`), which the driver neither grants nor answers. Found 2026-11-14 by the wide
review (cut X5, P3) while running the manual checks: on a fresh save the prefer case timed out with the consent dialog
open (0 of 10 cases), and passed once the run answered the dialog. The handoff itself worked.

**Why it matters:** the driver fails on a fresh save for a reason that has nothing to do with the handoff it checks.

**Suggested handling:** seed the `dbWrite` grant with the `replacer` grant in the fixture, or have the driver answer
the dialog.
