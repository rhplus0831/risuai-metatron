# Plan post-verification — 2026-11-23

What was reviewed: the seven plans retired between 2026-11-19 and 2026-11-23 that were built, each read as a finished
whole against `dev` at `1609036ea`, where the whole suite (12 035 tests) and `pnpm check` passed before the run.
Removal Reroll was retired unbuilt and is left out. The owner asked for it after a list of retired plans showed these
had never been read after their runs.

| ID  | Plan                      | Last text                                                |
| --- | ------------------------- | -------------------------------------------------------- |
| TR  | Timeline Reading View     | `git show 821772f17^:docs/plan/timeline-reading.md`      |
| TC  | Timeline Chapter Synopses | `git show b217b9738^:docs/plan/timeline-chapters.md`     |
| SS  | Settings Item Spacing     | `git show 15adafbd9^:docs/plan/settings-item-spacing.md` |
| RC  | Response Checks           | `git show ccc83ec37^:docs/plan/response-checks.md`       |
| U3  | Upstream Intake 3         | `git show 9365b2552^:docs/plan/upstream-intake-3.md`     |
| TW  | Tokenizer Worker          | `git show 94a4a97fa^:docs/plan/tokenizer-worker.md`      |
| CT  | Chat Trash                | `git show 1609036ea^:docs/plan/chat-trash.md`            |

The briefs, the reports, the probes, the reruns, and the fix patches are kept outside the repository, under the
review material folder of 2026-11-23.

## Method

The [2026-11-18 run](plan-post-verification-2026-11-18.md)'s method, with its two notes applied:

1. One read-only GPT-6.2-Astra verifier (`xhigh`) per plan in its own detached worktree, with a common brief and a cut
   file. Seven GPT-6.2-Sol sessions drafted the cut files from the plan, its pre-run audit, its slice commits, and the
   later commits that touched its code (sorted into "changed the result on purpose" and "touched for another reason");
   the orchestrating session reviewed them.
2. New step: before rating a finding, the verifier read the same code at the plan's base (the parent of its first
   slice) and labeled a behavior that predates the plan `pre-existing, widened by <slice>` or left it out.
3. The orchestrating session reran every P1 and P2 probe once; one GPT-6.2-Sol refuter per report with a P1 or P2.
4. Two waves, as the owner set them: TR, TC, CT, then RC, SS, U3, TW (five agents at once had hung the machine on
   2026-11-21).

## Result

| ID  | Verifier | Tokens | Filed (P1 / P2 / P3) | Refuter |
| --- | -------- | ------ | -------------------- | ------- |
| TR  | 20 min   | 14.6 M | 0 / 0 / 3            | -       |
| TC  | 23 min   | 17.7 M | 0 / 0 / 4            | -       |
| CT  | 25 min   | 22.9 M | 0 / 2 / 1            | 6 min   |
| RC  | 21 min   | 13.9 M | 0 / 0 / 6            | -       |
| SS  | 17 min   | 10.3 M | 0 / 1 / 3            | 5 min   |
| U3  | 16 min   | 8.9 M  | 0 / 0 / 1            | -       |
| TW  | 19 min   | 12.4 M | 0 / 0 / 2            | -       |

About 101 M tokens for the verifiers, 16 M for the cut drafters, and 3.9 M for the refuters. Every plan carried out
its decisions, and all 35 break-tests failed on the assertion they guard. The three P2 probes behaved as reported.

- **CT-2 (P2; refuter confirmed; session P3).** A persona or preset picker opened for a chat stayed open after another
  tab moved that chat to the Trash, and a pick was accepted locally; the server refused the write and the save loop
  discarded it. The pickers checked raw membership, which the Trash keeps on purpose.
- **SS-1 (P2; refuter confirmed, as Chat Trash's; session P3).** Storage showed a fractional retention (7.5 days)
  while the server stores and purges by whole days (7), so a trashed chat could be purged up to a day before the date
  the field implied. Found by the spacing cut at its seam with Chat Trash.
- **CT-1 (P2; refuter: pre-existing, P3).** A plugin's unchanged `setDatabase`/`setDatabaseLite` round trip waiting on
  consent selected another chat when an earlier one was trashed meanwhile: navigation only, nothing written to the
  wrong chat. A reorder from another tab did the same before the plan.
- P3, code: TR-1 (Open in Manage kept a failed or stale record read), TC-1 (a superseded chapter read kept the chapter
  buttons disabled), TC-2 (Make again stayed enabled with chat memory off and was refused by the server).
- P3, tests: SS-2 (the spacing spec passed with Storage's only field missing), SS-4 (no rendered-target Translation
  visit).
- P3, wording: RC-1 to RC-6 (Half Streaming help, the Korean continuation note, the Memory note, two stream summaries,
  a meter label, the history status of a rejected answer), TR-2, TC-3 (guides), TR-3, TC-4 (exclusions left only in
  the archived plans), CT-3 (plugin reads are active chats only), SS-3 (which margins the renderer overrides), U3-1
  (the order of checks before the inlay name error), TW-1 (the first long-worker run of each family was cold), TW-2 (a
  test comment).

Against 2026-11-18 (19 P1/P2 filed, six older than their plan), this run filed three, each stating what the base did.
The base-reading step is the likely reason; the plans of this batch were also smaller or narrower.

## Fixes

The owner asked for every finding to be fixed in the session. One change on `dev`:

- `TimelineTab.svelte`: Open in Manage rereads the record and keeps an open editor; chapter actions are numbered, so
  the newest read releases a settled action's lock; both model-backed chapter actions need chat memory on; the editor
  is compared with the event view, not the raw record.
- `chatBindingPick.ts`, `listedPersona.svelte`, `botpreset.svelte`: a pick and an open picker need an active chat.
- `SettingNumber.svelte`: `clampOnCommit.wholeNumber` floors a committed value, set for the trash retention and the
  plugin wait limit.
- `v3.svelte.ts` `applyPluginCharacter`: an unchanged list's `chatPage` selects that list's chat by id.
- `e2e/settingsSpacing.spec.ts`, the guides, the locale strings, `plugins.md`, `risuai.d.ts`, the deferred-work
  ledger, the upstream ledger, and the tokenizer measurement report for the wording findings.

Each fix has a test that fails with the product change reverted (16 new tests). The verifiers re-verified in their
own threads: the first round found that the TR-1 fix closed an open editor (TR-4, then a residual for restored events
with no summary) and two wording gaps (CT-3's example comment, RC-7: with Inlay Error Response on, a buffered
rejection ends the job without an error); all were fixed and re-verified. The whole suite (12 051 tests), `pnpm check`,
`pnpm check:docs`, `pnpm check:tests`, `pnpm format:check`, and `settingsSpacing.spec.ts` passed on the result.

## Notes for the next run of this kind

- The base-reading step held: no filed P1 or P2 was older than its plan without saying so.
- Cut files drafted by Sol from a gathered facts file took about six minutes each and needed one correction.
- A cut's seam with a later plan found the run's clearest defect (SS-1 sits in Chat Trash, found from Settings Item
  Spacing): keep the later commits that touched a plan's files in every cut.
- Re-verify turns are worth running after wording-only fixes too: two of seven found a gap in the fix.
