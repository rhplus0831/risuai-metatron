# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, the seventeenth (the Found Issues Decisions run) on 2026-11-09, the nineteenth (the Upstream Intake 2 run) on 2026-11-10, the twentieth (the Memory Panel Readability run) on 2026-11-11, the twenty-first (the Structured Memory Recent Timeline run) the same day, the twenty-second (the Per-Chat Memory run) on 2026-11-13, and the twenty-third (the Lore Budget Send Stop run) the same day; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. An entry is a `###` heading under its area section, a paragraph saying what and where (`file:line`), then a **Why it matters:** line and a **Suggested handling:** line; the Contents list at the top counts each area's entries. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's section of [known issues](known-issues.md) (or to the guide's Known Hazards `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

The inbox was emptied on 2026-11-09 by the Found Issues Clearance plan (retired; `git show e8758c2a8:docs/plan/found-issues-clearance.md`): every entry was fixed by one of its slices, recorded as a Limitation or Issue in its guide, or closed with a reason in slice H1's commit. The eighteenth batch, that run's own findings, moved in the same day.

The eighteenth batch was cleared the same day by a Sol implementer with session verification (seven entries fixed with regression tests; the rendered-translation quote entry was closed as not reproduced: a scratch replay of the rendered path with identity Google and LLM translators kept quoted font names, `url("…")` and `content:"…"` intact in every one of twelve cases).

The nineteenth batch and the eight entries of the 2026-11-10 full guide audit (twelve in all) were cleared on 2026-11-10 by Sol implementers and test writers in three worktrees with session verification: eight fixed with regression tests (three in the plugin sandbox, style scoping, the popup editor's row, the chat export's candidate receipts, memory task job ids in shares and reports, the e2e program in `pnpm check:changed`), the dead boot fixture capture driver deleted, the wasmoon upgrade note moved to its module, the checkpoint benchmark given its place in the audit report, and the full-screen alert e2e failure closed as the dev stack's reload on file edits (8 of 8 quiet runs passed; a run under Markdown touches failed the same way).

The twentieth and twenty-first batches, a build entry, and one finding still in memory (eight in all) were worked on 2026-11-12 by Sol implementers and test writers in three worktrees with session verification: five fixed (the pdf.js character map URL, the Korean export line, the history jump's scroll and the refresh scan with regression tests, the eval's capture beyond titles); the on-demand timeline count tried and reverted as not worth its cost (`b29a883a5`, `bb2ede7d6`; the read guide's Limitation has the numbers); the read round's byte charge reproduced and moved to [known issues](known-issues.md#structured-memory); and the timeline heading reworded the same day by the owner's decision (`the last ones may already be in the messages below`).

## Contents

- [Chat pipeline](#chat-pipeline): 1
- [Memory](#memory): 1
- [Selection](#selection): 1
- [Settings](#settings): 1

## Chat pipeline

### A preview may store lore activation flags

A `preview` or `previewPrompt` job runs the same `activateLore` as a send (`server/src/prompt/runner.ts:1626`), its
bindings are not frozen, and `runSend` flushes the job's chat metadata before it returns the preview (`runner.ts:616`).
Activation queues `__internal_ka_<id>` and `__internal_da_<id>` through `setChatVar`
(`server/src/lua/bindings.ts:555`), so a preview may write those flags to the chat, while `rebuildLocks`' comment in
`server/src/jobs/generationJobs.ts:352` says a preview writes nothing. Found 2026-11-13 by the Lore Budget Send Stop
plan's audit; not settled against the write path, and not run.

**Why it matters:** an entry with `dont_activate_after_match` that a preview activated would stay off in the send the
preview was meant to show.

**Suggested handling:** read whether the job's write accepts the `meta` operation for a preview kind; if it does, run
a preview's activation without the flag writes, with a test that a preview leaves `scriptstate` as it was.

## Memory

### A send's HypaV3 checkpoint counts a summary the projection guard dropped

`checkpoint` in `server/src/prompt/assemble.ts:816` returns `"committed"` as soon as `write.merge` produces a value
inside `host.writeMemory`; it never checks that the stored `hypaV3Data` kept it. When the projection owns the field,
the server's write guard (`refusesHypaV3Data` in `server/src/data/chatStore.ts`) drops the summary, but the send's
HypaV3 execution counts it as saved. The detached task's `checkpointOf` in `memoryTasks.ts` confirms the write since
the Per-Chat Memory plan's slice 2 (`15996bb5b`); the in-job path was outside that slice. Found 2026-11-12 during that
slice; unverified in a running server.

**Why it matters:** a send can treat a gap as summarized while nothing was stored; per-chat modes make the mode
changes that lead there casual.

**Suggested handling:** make the in-job checkpoint confirm the stored value as `checkpointOf` does, with a regression
test that moves a chat to Structured Memory while a send's HypaV3 summary is in flight.

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

## Settings

### The lorebook token limit inputs cap at 4096 under a default of 8000

Both inputs of the lorebook token limit carry `max` 4096: the global one (`adv.lbToken` in
`src/ts/setting/memorySettingsData.ts:21`) and the lorebook's own (`src/lib/SideBars/LoreBook/LoreBookSetting.svelte:148`).
The default is 8000 (`server/src/data/normalize/providers.ts:7`). `NumberInput` passes `max` to the element as an
attribute only, so a typed value above it is stored, but the stepper stops at 4096. Found 2026-11-13 by the Lore
Budget Send Stop plan's audit; not checked in a browser.

**Why it matters:** that plan's dialog sends a person to these inputs to raise the limit, where the box suggests 4096
is the most.

**Suggested handling:** drop the `max` or raise it to a value above the default, on both inputs.
