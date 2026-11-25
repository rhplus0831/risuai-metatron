# Wide review — 2026-11-14

What was reviewed: the product code of `dev` at `05df12543` (waves 1 to 3) and at `880090b0f` (wave 4), by 38 read-only
reviewer sessions, each on one cut, with a second session of another model re-reading every report that filed a P1 or
P2 finding. The owner asked for it as a use of spare weekly quota: many reviewers at once, each narrow. What the review
found was fixed the same day, except what needs the owner's decision.

The briefs, the cut list, the 38 reports, the verdicts, the probe tests, and the implementers' notes are kept outside
the repository, under the review material folder of 2026-11-13.

## Method

1. The code was cut six ways, so that each reviewer had one question and a list it had to cover completely:
   - **Seam** (6 cuts): what several plans built against each other, read plan by plan at the integrated tip.
   - **Fix** (7 cuts): every commit titled `fix` since the audits of 2026-11-05 (189 commits), each read as a fix: is
     the trigger closed at the tip, did it break a neighbor, does a sibling have the same defect.
   - **Runtime** (5 cuts): a running server and a browser in the offline harness, to settle recorded claims that
     nobody had run (the guides' `Unconfirmed:` bullets, backlog entries that said "may", the manual checks an agent
     can run).
   - **Route boundary** (6 cuts): every handler of a group of server routes: who can call it, what it accepts, what
     it answers, what one call costs.
   - **Invariant** (8 cuts): one repository-wide invariant of `STRUCTURE.md` swept over every site it applies to (ids
     across awaits, revisions and epochs, persisted fields, format parity, who makes requests from the tab, HTML and
     CSS sinks, the low-level grant).
   - **Test strength** (6 cuts): the rules a guide lists for one area, each broken in the product code in turn to
     see whether a test fails.
2. Each reviewer was one GPT-6.1-Sol session in its own detached worktree. A report had to carry a coverage table
   with a row per item of its cut, and a P1 or P2 finding had to come with a probe test that drives a product entry
   point, its command, and its output.
3. Each report with a P1 or P2 went to one GPT-6-Astra session that had not seen the reviewer's reasoning. It reran
   the probe, checked that the probe was honest (no guard mocked away, no state the product cannot write), traced the
   trigger independently, searched the backlog and the guides' Limitations, and re-rated the priority. Verdicts:
   `confirmed`, `confirmed, narrower`, `refuted`, `already recorded`, each with the cheapest fix.
4. The orchestrating session read every summary and verdict, decided per finding between a fix and an owner decision,
   and wrote the fix briefs from the verdicts' cheapest fixes.
5. Fixes followed the batch recipe: one implementer per group of files in its own worktree (no tests, no docs, one
   commit per finding, reproduce first), a separate test writer per worktree, each new test run by the orchestrating
   session against its fix reverted, then the whole suite and the type check on the merged branch, then the guides.
6. For the test-strength cuts the reviewers' breaks served as the check: a test writer wrote the missing test, and the
   test had to fail under the reviewer's break.

## Result

| Kind           | Cuts | New P1/P2 | Kept | What else it settled                                                      |
| -------------- | ---: | --------: | ---: | ------------------------------------------------------------------------- |
| Seam           |    6 |         2 |    2 | Three of six cuts clean; one test gap (P3).                               |
| Fix            |    7 |        10 |    9 | One finding was already recorded; one cut of 37 fixes clean.              |
| Runtime        |    5 |         2 |    2 | 8 of 13 recorded claims reproduced, 4 not, 1 not runnable; 12 checks run. |
| Route boundary |    6 |         9 |    9 | One reachable without a token.                                            |
| Invariant      |    8 |        25 |   25 | 17 P1 and 8 P2; the revision and epoch sweep clean.                       |
| Test strength  |    6 |        12 |   12 | Rules whose break left every test green, plus 5 P3.                       |

The second reader refuted no finding. It marked one as already recorded and narrowed nine (a narrower actor, a
narrower consequence, or a trigger that needed correcting). Its cheapest-fix statements became the decisions of the
fix briefs.

What the findings were, by where they sat:

- **Server routes**: an unauthenticated route that built a buffer from a caller-chosen length; a hub answer header
  that clears the app's browser storage; imports that wrote without a free-space check; a search, a sweep, and a
  memory text pattern that could hold the serving thread for seconds; structured memory edits accepted during a
  restore.
- **Ids across awaits** (ten findings in two cuts): a handler that waits on a dialog, a picker, or the network and
  then reads the current selection or a row index again, in the plugin API, the file send, the group editor, the
  trigger and regex editors, the HypaV3 reset, the memory panel, and the module and plugin lists.
- **Script permissions**: three effects of a trigger that reached a provider request, the shared persona text, or a
  remote token counter without the low-level grant.
- **Formats**: card exports that lost the lore version, an export its own importer drops, a legacy module export
  without its icon, two legacy import aliases, a preset field stored where nothing reads it.
- **Secrets**: four credentials in the settings report, and sign-in tokens in the tab's request log.
- **HTML sinks**: names and translated text in exports and the rich copy, a name in the custom GUI template.
- **Fixes re-read**: siblings the original fix did not reach (number inputs, a mutation observer, the tab's copies of
  two server fixes) and one regression (a pattern added by a fix that was quadratic on unclosed comment openers).

## What was done with it

- 55 fix commits and 18 test commits on `dev` (`05df12543..HEAD` of 2026-11-14), each fix with a regression test that
  fails without it, except one export size guard whose test would need a 38 MiB asset. The message search fix is
  pinned by its result set, not by its time.
- Five more fixes came from the implementers' notes about code outside their group: the tab's MCP client (two), the
  tab's lore preview, a module's regex import, and the trigger editor's palette.
- One decision of a fix brief was wrong and was reverted before landing: refusing malformed memory rows in the restore
  validator made one such row fail the memory export of every chat. An existing test the implementer had to edit
  showed it. The readers now skip such a row and the validator is unchanged.
- The whole suite passed on the merged branch after each batch (10,576 tests, then 10,659, then 10,676 after the
  test-strength tests), with the type check clean each time.
- Guides: 14 guides after the first batch and 13 after the second state the rules the fixes leave behind. Three
  `Unconfirmed:` claims were reproduced and fixed; four carry the run that did not reproduce them.
- [Manual checks](../../../backlog/manual-checks.md): twelve items were run; ten passed and left the list.

## What stays open

In [found issues](../../../backlog/found-issues.md):

- The tokenizer's quadratic time on a long run of letters, on the serving thread. The owner's note of 2026-11-14 is
  that token counting may move to a worker thread.
- An `@import` in card or message CSS is installed without scoping. Dropping imports costs cards that load web fonts
  this way, so it is the owner's decision.
- A plugin's chat panel can carry a `style` element. Forbidding it costs plugins that style their panel, so it is the
  owner's decision.
- Thirteen remote calls of the tab (text to speech, image generation, translation) bypass the request wrappers.
  Converting them touches providers that cannot be exercised without real keys.
- The job handoff driver's fixture lacks a consent grant (P3).

Not recorded as entries: a message search hit in one 16 MiB message still takes about two seconds to build its
snippet; the model-file claim in the `memory` guide needs network access and was not run.

## Cost

| Step                                   | Sessions | Tokens (millions) |
| -------------------------------------- | -------: | ----------------: |
| Wave 1 reviewers (seam, fix, runtime)  |       11 |                89 |
| Wave 2 reviewers (route, fix, runtime) |       12 |               123 |
| Wave 3 reviewers (invariant, runtime)  |        9 |               139 |
| Wave 4 reviewers (test strength)       |        6 |                91 |
| Second readers                         |       25 |                55 |
| Implementers                           |       13 |               128 |
| Test writers                           |       20 |                96 |
| Guide updates                          |        2 |                13 |

About 500 million tokens of review and 240 million of fixing, within one day. A reviewer took 10 to 44 minutes, a
second reader 4 to 12.

## Which kinds earned their cost

- **Invariant sweeps** found the most per cut and the highest priorities, because they read every site of one rule,
  including code no plan had touched for weeks. Keep them, and run them first next time. The sweep of revisions and
  epochs was clean; the others each found something.
- **Route boundary reviews** found only bounds (time, memory, disk), nine of them, one without a token. Worth
  repeating when routes are added, not on a schedule.
- **Fix reviews** found siblings and one regression. The cut over the 46 audit-fix commits found two; the cuts by
  directory found seven. Keep the per-commit table; it is what made the reviewers read every fix.
- **Seam reviews** found two defects in six cuts. The three cuts over plans that had both a pre-run audit and a
  plan-runner review came back clean. Drop the kind for such plans, and keep it for seams between plans.
- **Runtime cuts** found little that was new. Their use was to close items that had been waiting for a run: thirteen
  claims and twelve manual checks. They are the most expensive per cut (up to 28 million tokens).
- **Test strength** found twelve unguarded rules in six areas at a budget of forty rules per area, and each was
  closed with one small test. Keep it, with the same budget.
- **The second reader** set aside one of the 48 findings it read. As a filter it was not needed at this finding bar (a
  probe was already required). Its narrowing and its cheapest-fix line were used directly, so it stays, at about a
  sixth of a reviewer's cost.

## Notes for the next run

- The provider's content filter stopped three reviewers (the tokenizer timing, the import routes, the HTML sinks).
  Each finished after one restart turn worded as a robustness or correctness review of the maintainer's own code, with
  small inert examples. Word such cuts that way from the start.
- A runtime cut that settles recorded claims comes back from the second reader as "already recorded" unless the
  brief tells the reader the claim is recorded and asks only whether the run holds.
- Read each implementer's "outside scope" list for the same defect class, and read every edit of an existing test:
  the first gave five fixes, the second caught the one wrong decision.
- When two test commits of one worktree touch the same test file, keep the later one as its own `test` commit
  instead of squashing it into its fix.
