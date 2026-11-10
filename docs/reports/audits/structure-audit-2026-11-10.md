# Structure guide audit — 2026-11-10

What was audited: every claim of `STRUCTURE.md`, Doc Maintenance (`docs/structure/README.md`), and the 37 guides under
`docs/structure/`, read against the source at `e44b4786b` (`dev`). This is the first full audit recorded in
`docs/structure/verified.json` and on the `Last full audit` line of `STRUCTURE.md`.

The audit asked one question of each claim: does the code still do this? It did not shorten, split, or reword guides.

## Method

1. Baseline: `pnpm check:docs --report`, `pnpm docs:ledger --stale`, `pnpm docs:due`, and `pnpm docs:reads` at the base
   revision.
2. One read-only GPT-6.1-Sol session per guide, 31 sessions for the 37 guides (guides split from one parent on
   2026-11-04 shared a session) and one more for the index and Doc Maintenance. Each went through its guide heading by
   heading and wrote a report: a coverage row for every heading, and findings in five classes (`WRONG`, `GONE`,
   `MISSING`, `MISPLACED`, `CODE-DEFECT`) with a priority, the quoted guide line, `path:line` source evidence, and the
   exact replacement text. Two guides (persistence, mcp) ran first as a pilot.
3. An independent check of every finding by GPT-6 Luna workers, three findings to a worker: is the finding right, and is
   every factual part of the proposed text true in the source?
4. The orchestrating session read the `P1` findings, the code defects, and the index findings against the source
   itself, and decided the disputed ones.
5. The same Sol session that audited a guide applied its findings to that guide only, with the checker's objections in
   hand, then ran Prettier, `pnpm check:docs`, and `pnpm docs:ledger <guide>`, and listed every fact it removed with
   its destination. The orchestrating session read each guide's diff.
6. The index was edited by the orchestrating session. A Luna routing test measured the task table before and after.

## Result

| Class         | Guides | Index | Meaning                                                              |
| ------------- | -----: | ----: | -------------------------------------------------------------------- |
| `WRONG`       |     83 |     3 | The guide stated something the source contradicts                    |
| `GONE`        |      0 |     0 | A named path, identifier, or command no longer exists                |
| `MISSING`     |     40 |     4 | A cross-module fact an editor needs, absent from the guide           |
| `MISPLACED`   |      7 |     0 | True, but it belongs in another guide, a source comment, or a report |
| `CODE-DEFECT` |      5 |     0 | The guide states the intent and the code looks wrong                 |
| Total         |    135 |     7 |                                                                      |

By priority, guides and index together: 37 `P1` (an editor following the guide would break something or go to the wrong
place), 100 `P2`, 5 `P3`. The auditors filed renamed identifiers as `WRONG`, which is why `GONE` is empty.

The checker read 131 of the 135 guide findings (four answers did not parse). It judged 130 findings right and one wrong,
and found part of the proposed text untrue or too broad in 16; those 16 were rewritten against the source before they
landed.

Applied to the guides: 89 as proposed, 38 with changes, 8 not applied (below). The index took 6 of its 7.

Typical drift, by frequency:

- A `Not tested` gap that a later test closed, or a focused test command that no longer names the tests of the area (30
  or so findings).
- A rule stated for the tab that the server implements separately (persistence's mutation routing, memory's embedding
  recipes, the ChatML splitter, the legacy tokenizer fallback).
- A recipe that names the old edit path (TTS fields, image backends, an internal MCP server's registration, a card
  field's default).
- A limitation whose condition changed (cancelled transform targets, the rebuild's prompt retention, the experimental
  Google translator).

### Findings by guide

| Guide                        | `WRONG` | `MISSING` | `MISPLACED` | `CODE-DEFECT` | `P1` |
| ---------------------------- | ------: | --------: | ----------: | ------------: | ---: |
| app-shell                    |       3 |         2 |           0 |             0 |    1 |
| assets                       |       0 |         1 |           0 |             0 |    0 |
| backup-sync-hub              |       3 |         2 |           0 |             0 |    2 |
| build-test-platforms         |       1 |         3 |           0 |             1 |    2 |
| cbs-rendering                |       4 |         1 |           1 |             1 |    2 |
| characters-modules           |       2 |         1 |           0 |             0 |    1 |
| chat-pipeline                |       2 |         0 |           0 |             0 |    0 |
| chat-store                   |       1 |         1 |           0 |             0 |    0 |
| diagnostics                  |       1 |         2 |           0 |             1 |    1 |
| draft-recovery               |       1 |         0 |           0 |             0 |    1 |
| global-api                   |       1 |         1 |           0 |             0 |    0 |
| live-update-feed             |       1 |         2 |           0 |             0 |    0 |
| live-updates                 |       0 |         3 |           0 |             0 |    1 |
| llm-requests                 |       5 |         0 |           0 |             0 |    0 |
| mcp                          |       1 |         4 |           0 |             0 |    4 |
| media-aux                    |       5 |         1 |           0 |             0 |    1 |
| memory                       |       4 |         1 |           0 |             0 |    1 |
| network-jobs                 |       2 |         1 |           0 |             0 |    1 |
| persistence                  |       6 |         1 |           0 |             0 |    2 |
| plugin-sandbox               |       3 |         0 |           2 |             0 |    1 |
| resource-sync                |       0 |         1 |           0 |             0 |    0 |
| scripts-triggers             |       3 |         1 |           0 |             0 |    0 |
| self-host-server             |       5 |         1 |           0 |             0 |    2 |
| server-generation            |       1 |         1 |           1 |             0 |    2 |
| server-resources             |       3 |         1 |           0 |             0 |    2 |
| settings-i18n                |       3 |         2 |           0 |             0 |    2 |
| structured-memory (README)   |       0 |         0 |           0 |             0 |    0 |
| structured-memory/lifecycle  |       4 |         0 |           1 |             1 |    0 |
| structured-memory/pages      |       1 |         0 |           0 |             0 |    0 |
| structured-memory/projection |       1 |         0 |           0 |             0 |    0 |
| structured-memory/read       |       2 |         0 |           0 |             0 |    0 |
| structured-memory/rebuild    |       2 |         0 |           0 |             0 |    1 |
| structured-memory/records    |       4 |         0 |           0 |             0 |    1 |
| structured-memory/writer     |       2 |         0 |           0 |             0 |    0 |
| test-harness                 |       3 |         0 |           0 |             0 |    0 |
| translation                  |       1 |         3 |           1 |             0 |    0 |
| ui-theming                   |       2 |         3 |           1 |             1 |    1 |

`pnpm docs:due` did not predict the count: persistence (228 commits since it was added) had seven findings, mcp (6
commits) five. A guide split out on 2026-11-04 carries its parent's older text, so its commit count understates its
age; a full audit should not skip guides by that figure.

## Index

Applied:

- D1 gains the pin rule for a lazily loaded chat, as a pointer to `chat-store`'s `Pins and eviction`.
  `src/ts/process/request/request.ts`, outside the chat-store area, has to follow it.
- V2 said "Server tests select Node"; the Vitest default is happy-dom and a file opts in with `@vitest-environment
node` (156 of 159 files under `server/src/tests/` do).
- Choose By Task: "save entry points" moved from the `global-api` row to `resource-sync`, which owns them;
  "normalization" moved from the `persistence` row to `server-resources`, which owns `server/src/data/normalize/`; the
  `build-test-platforms` row now names the documentation checks and tools it owns.
- Glossary: **resource epoch** and **revision**, which 17 guides use without a definition.

Not applied: a proposed rule S3 (plugin transforms carry `purpose: "transform"` and host data setters refuse writes).
The rendering guide already links the plugin guide's rule from the one runner that needs it, and the rule would take the
invariants section to its 8,000-byte target. It is the owner's call; the section is at 7,896 bytes after this audit.

All 28 existing invariants pass the admission rule of Doc Maintenance ("a change that never opens the owning guide can
break it"); none was moved out.

### Routing test

Forty-eight recent `feat` and `fix` commits were turned into tasks (the subject without its scope), and Luna workers
picked a guide for each from the Choose By Task table alone. A pick counts when the guide owns a file the commit
changed (`pnpm docs:owner`).

|                                | Before | After |
| ------------------------------ | -----: | ----: |
| First pick owns a changed file |     30 |    32 |
| First or second pick           |     37 |    39 |
| Neither                        |     11 |     9 |

Answers vary by a task or two between runs, so the change is within noise; the test is a baseline for the next audit,
not proof the edits helped. Most misses are subjects too terse to route ("preserve input for the none provider"). The
recurring real ones are Lua and trigger effects that run in `server/src/` (owned by `server-generation`, picked as
`chat-pipeline` or `scripts-triggers`) and character-order work split between `persistence` and `server-resources`.

## Not applied

- Five code defects, recorded in [found issues](../../backlog/found-issues.md): a `<style>`
  with an attribute or in capitals escapes CSS scoping; a popup editor draft can land on another row with equal text;
  chat files keep reroll candidates' memory receipts; a background memory request cannot be shared for support;
  `pnpm check:changed` skips the e2e program. Each was traced by two readers and none was run.
- `structured-memory/lifecycle`: the checkpoint benchmark stays in the guide because no audit report holds its figures
  (found issues).
- `server-generation`: the wasmoon private-API note stays because the module comment lacks its upgrade condition (found
  issues).
- `plugin-sandbox`: one `MISPLACED` finding was wrong; the checker and the auditor's second reading agree the guide's
  bullet is correct.

A sixth inbox entry came from a corrected claim: `util/playwright/captureBootFixtures.mjs` imports exports the app no
longer has.

All eight entries left the inbox the same day: the five defects were reproduced and fixed, the driver was deleted, and
the two notes moved to the audit report and the module comment (the found-issues header has the summary).

## Other checks

- Known issues: the auditors re-read the eleven entries of `docs/backlog/known-issues.md`. Ten are still defects by
  source trace; for the `normalizeCharacterOrder` folder-field entry the auditor could not tell.
- Stale identifiers (`pnpm docs:ledger --stale`): 9 before, 7 after. `sanitizeTargetUrl` and `$RUNNER_TEMP` were real
  and are corrected. The seven left are false positives of the tool: a deliberate absence (`manualChunks`), a
  dependency default (`envPrefix`), a shorthand (`FromHtml`), a name in `node_modules` (`subscriber_queue`), a heading
  name (`Fixtures`), a proposed table (`memory_manifests`), and a parameter label (`contextOrPage`).
- Size: the guides and the index together went from 794,979 to about 810,000 bytes (`pnpm check:docs`); the 36 edited
  guides grew 14,358 bytes net. No guide crossed a target. The one `near` line, test-harness's slow-test table, predates
  the audit.
- Removed facts: each apply note lists them with destinations. The larger moves: transform capacity figures and
  screenshot memory figures to their audit reports, the translator step editor's draft rules to the component's
  comment, `risu-set-module-info`'s validation order to `shared/mcp/risuaccess/modules.ts`, and a dated cold-boot
  timeout note that the suites' `warmMutationGraph` calls made obsolete. No removal relied on another guide that
  removed the same fact.

## Cost

Thirty-two Sol sessions at `xhigh`: 5 to 12 minutes for an audit turn (19 for the index), 2 to 3 minutes for an apply
turn, 4 to 12 M tokens a session over both turns, roughly 200 M in total. The Luna checks ran as 58 workers in fast
mode, under 10 minutes a batch. Wall time was about an hour and a quarter, with six to sixteen sessions at once.

## For the next audit

- The auditor brief, the apply brief, the report parser, and the checker's task builder are in the review-reports folder
  outside the repository (`structure-audit-2026-11-10`), with every report, checker answer, and apply note.
- Keep the two-turn shape: the session that read the source for a guide writes better replacement text than a second
  one would, and the checker's objections cost it one re-read.
- Tell the applier to keep the decision reference a `Limitations` bullet ends with. An early version of the apply brief
  said "no dates" and one guide lost two decision dates, restored by hand.
- Ask for `### F<n> \`CLASS\` P<n>: title` exactly; three reports used a dash and the first parser skipped them.
- Parallel appliers each edit one guide file in one checkout and run `pnpm check:docs` over a tree in flux. It worked
  because no finding moved a fact between two guides; a move between guides belongs to the orchestrating session after
  every applier has finished.
