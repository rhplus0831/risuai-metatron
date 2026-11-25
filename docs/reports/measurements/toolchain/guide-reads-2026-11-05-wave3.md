# Guide Reads 2026-11-05, after wave 3

The final `guide-reads` audit of the Guides To Source plan (D7, sub-slice `5-audit-ceiling`), taken after wave 3
landed (`492b2a491`). The second audit (before wave 2) already holds the name `guide-reads-2026-11-05.md`, so this
report carries the suffix `-wave3`. The title is dated by hand: the script dates its report in UTC, which was still
2026-11-04 at the run, and the span below is in UTC too.

Scanned 1288 transcript files in 374 directories of local Claude Code sessions (the main project folder and every
worktree session folder; sub-agent transcripts included); the counted guide reads span 2026-09-26 to 2026-11-04. Each
tool call counts once by its id, so a forked session's copied history is not counted twice. Method and contract: the
header comment of `util/guideReads.mjs`. Undercount: reads by Codex and Luna workers are not in these transcripts, and
`rg` or `grep` output from a guide, like any Bash read but a `sed -n` range, counts per guide but not per heading. The
scan includes the session that took it, up to the run.

## Per guide

| Guide                          | Whole-file Reads | Ranged Reads |  Bash | of which `sed -n` | docs:read |
| ------------------------------ | ---------------: | -----------: | ----: | ----------------: | --------: |
| STRUCTURE                      |               88 |           99 |  2666 |               886 |        80 |
| a                              |                0 |            0 |     2 |                 0 |         0 |
| agents-and-presets             |                0 |            0 |     3 |                 1 |         0 |
| app-shell                      |                4 |           14 |   255 |                68 |         9 |
| assets                         |                0 |            1 |    13 |                 4 |        10 |
| assets-and-saves               |                0 |            0 |     2 |                 2 |         0 |
| backend                        |                0 |            0 |     7 |                 3 |         0 |
| backup-sync-hub                |                8 |           10 |   200 |                44 |         7 |
| build-test-platforms           |                6 |           15 |   922 |               204 |        22 |
| cbs-rendering                  |                3 |           13 |   216 |                54 |        15 |
| characters-modules             |                6 |           15 |   352 |                79 |         7 |
| chat-pipeline                  |                5 |           31 |   630 |               147 |        15 |
| chat-store                     |                5 |            2 |    94 |                21 |        13 |
| data-and-events                |                0 |            0 |     7 |                 3 |         0 |
| development-and-observability  |                0 |            0 |     2 |                 1 |         0 |
| diagnostics                    |                3 |            4 |   141 |                36 |         8 |
| domain-glossary                |                0 |            0 |     2 |                 0 |         0 |
| draft-recovery                 |                1 |           11 |    36 |                 9 |        10 |
| durable-mutations-and-recovery |                0 |            0 |     7 |                 2 |         0 |
| g                              |                0 |            0 |     1 |                 0 |         0 |
| generated-and-legacy           |                0 |            0 |     1 |                 0 |         0 |
| generation-rejection-register  |                0 |            0 |     4 |                 1 |         0 |
| global-api                     |                2 |           19 |   418 |               101 |         9 |
| intermediate-display           |                0 |            0 |     8 |                 3 |         0 |
| live-update-feed               |                0 |            0 |    15 |                 1 |         6 |
| live-updates                   |                1 |            1 |    16 |                 2 |        13 |
| llm-requests                   |                2 |           17 |   269 |                68 |        13 |
| mcp                            |                0 |            0 |    15 |                 3 |        12 |
| media-aux                      |                3 |           16 |   193 |                46 |         8 |
| memory                         |                5 |           29 |   329 |                61 |         6 |
| network-jobs                   |                0 |            0 |    16 |                 4 |        11 |
| persistence                    |                8 |           40 |  1364 |               325 |        13 |
| plugin-sandbox                 |                0 |            0 |    21 |                 4 |         9 |
| plugins                        |                0 |            0 |     1 |                 0 |         0 |
| plugins-and-mcp                |                0 |            0 |     4 |                 2 |         0 |
| plugins-mcp                    |                7 |           10 |   343 |                79 |         0 |
| prompt-assembly-and-scripting  |                0 |            0 |     4 |                 0 |         0 |
| providers-and-models           |                0 |            0 |     2 |                 1 |         0 |
| README                         |                0 |            0 |    55 |                 2 |         0 |
| resource-sync                  |                3 |           11 |    56 |                15 |        14 |
| scripts-triggers               |                4 |            0 |   174 |                40 |         7 |
| self-host-server               |                3 |           59 |  1689 |               442 |        25 |
| server                         |                0 |            0 |     1 |                 0 |         0 |
| server-generation              |                2 |            0 |   133 |                29 |         6 |
| server-resources               |                2 |           11 |   109 |                17 |         8 |
| server-resources-and-bridges   |                0 |            0 |     3 |                 3 |         0 |
| server-sync                    |                0 |            0 |     1 |                 0 |         0 |
| settings-i18n                  |                2 |           17 |   272 |                54 |         4 |
| structured-memory              |               38 |           21 |   264 |                41 |        15 |
| structured-memory-lifecycle    |                6 |            6 |    44 |                10 |         0 |
| structured-memory-pages        |                0 |            2 |     3 |                 0 |         0 |
| structured-memory-read         |                7 |            6 |    82 |                20 |         0 |
| structured-memory-rebuild      |                0 |            2 |    24 |                 8 |         0 |
| structured-memory-writer       |               10 |           11 |    89 |                22 |         0 |
| structured-memory/lifecycle    |                1 |            0 |    12 |                 1 |        13 |
| structured-memory/pages        |                0 |            1 |     9 |                 0 |         2 |
| structured-memory/projection   |                0 |            0 |    20 |                 1 |         5 |
| structured-memory/read         |                1 |            0 |    10 |                 1 |        10 |
| structured-memory/rebuild      |                0 |            0 |    13 |                 1 |         4 |
| structured-memory/records      |                0 |            7 |    17 |                 3 |        10 |
| structured-memory/writer       |                0 |            1 |    17 |                 3 |        11 |
| test-harness                   |                2 |            8 |   124 |                24 |         5 |
| translation                    |                0 |            0 |    10 |                 1 |         6 |
| translation-and-input-hooks    |                0 |            0 |     4 |                 2 |         0 |
| ui-theming                     |                3 |           17 |   457 |                85 |        13 |
| **all**                        |              241 |          527 | 12273 |              3090 |       454 |

Bash counts every command naming the guide's path, writes and `git` commands included; `sed -n` is the
part that prints a line range.

Whole-file share of guide Reads: 31.4% (241 of 768); the Agent Read Protocol asks for section reads instead.

20 `docs:read` calls named no guide (a placeholder, a variable, or a typo).

## Compared with the earlier audits

| Audit                      | Transcript files | Whole-file Reads | Ranged Reads | Whole-file share of Reads | docs:read |
| -------------------------- | ---------------: | ---------------: | -----------: | ------------------------: | --------: |
| 2026-11-04 (first)         |             1195 |              223 |          508 |            30.5% (of 731) |        24 |
| 2026-11-05 (before wave 2) |             1212 |              227 |          511 |            30.8% (of 738) |        95 |
| 2026-11-05 (after wave 3)  |             1288 |              241 |          527 |            31.4% (of 768) |       454 |

The three scans are cumulative over the transcripts still on disk, so the cumulative share barely moves: almost all
guide `Read` calls predate `pnpm docs:read`. The protocol's compliance number is clearer by period, split at the commit
that added the reader (`a072851a2`) and at the second audit (`af0111a0f`). A section read is a ranged `Read` or a
`docs:read` of a heading; an outline `docs:read` (headings and sizes only) is navigation and counts in neither part of
the share.

| Period                                       | Whole-file Reads | Ranged Reads | docs:read heading | docs:read outline | Whole-file share of Reads | Whole-file share of section-capable reads |
| -------------------------------------------- | ---------------: | -----------: | ----------------: | ----------------: | ------------------------: | ----------------------------------------: |
| before `docs:read` (to 2026-11-04 08:43 UTC) |              223 |          506 |                 1 |                 3 |                     30.6% |                                     30.6% |
| `docs:read` to the second audit              |                4 |            5 |                57 |                41 |                     44.4% |                                      6.1% |
| after the second audit (waves 2–3)           |               14 |           16 |               215 |               138 |                     46.7% |                                      5.7% |

So the whole-file share of guide reads fell from 30.6% before `docs:read` to 5.7% after it (14 of 245 section-capable
reads in waves 2 and 3), while the few `Read` calls left are more often whole-file (14 of 30). Per D7, Codex and
Luna worker reads and Bash reads other than `sed -n` ranges are undercounted, so the counts order work inside a guide
and never justify deleting a fact.

The `a` (2 Bash) and `g` (1 Bash) rows are not guides: placeholder and fixture paths in a `git log` check, a
`sed -i` edit, and a temporary fixture write, which the script counts because it does not validate a Bash path as a
guide. They change the Bash total by 3 of 12273 and no `Read`, `docs:read`, or heading count. The rows such as
`backend` or `data-and-events` are guides that sessions read with `sed -n` and that no ref of this repository's
history holds, so a history check cannot tell them from `a` and `g` (see Script fixes).

## Guides read per session

Distinct guides (STRUCTURE.md and the guides index excluded) each session read through `Read`, a `sed -n` range, or
`docs:read`, among the sessions that read at least one; a session belongs to the period of its first guide read. A
session can hold several lookups, so this is an upper bound on guides per lookup. Sub-agent sessions after the second
audit include the fresh-agent lookup trials of the waves (two domain questions each); main sessions then include the
slice sessions rewriting a guide, which read the guides linked to theirs.

| Period                             | Kind      | Sessions | Median | Mean | Max | Exactly one guide | Used `docs:read` |
| ---------------------------------- | --------- | -------: | -----: | ---: | --: | ----------------: | ---------------: |
| before `docs:read`                 | main      |      406 |      2 | 2.28 |  20 |               194 |                1 |
| before `docs:read`                 | sub-agent |      242 |      1 | 2.10 |  12 |               128 |                0 |
| `docs:read` to the second audit    | main      |        6 |      3 | 2.17 |   4 |                 3 |                6 |
| `docs:read` to the second audit    | sub-agent |       13 |      2 | 2.08 |   5 |                 5 |               11 |
| after the second audit (waves 2–3) | main      |       33 |      2 | 2.09 |   6 |                15 |               29 |
| after the second audit (waves 2–3) | sub-agent |       36 |      1 | 1.31 |   4 |                28 |               35 |

Sub-agent sessions after the second audit read 1.31 guides on average (28 of 36 exactly one), against 2.10 before
`docs:read`, closer to the Goal's one-guide path.

## Script fixes

- `guideOfArgument` now maps `<area>/README` and `<area>/README.md` to the folder guide `<area>` and bare `README` to
  the guides index, as `resolveGuide` in `util/docsRead.mjs` resolves them; `README.md` alone still names no guide,
  because the reader prints the repository-root README for it. Before the fix, 4 `docs:read structured-memory/README.md`
  calls counted as naming no guide (24 instead of the 20 above); they now count under `structured-memory`.
- Not changed: a `docs:read` of a guide's `#` title marks only the title as covered. No call in this scan resolved to a
  title, so no untouched list below is affected.
- Not changed: a Bash path is not validated as a guide (the `a` and `g` rows). A check against the repository's
  history would drop 63 Bash counts (24 of them `sed -n` reads) of the pre-history guides to remove those 3.

## Ceiling proposal (D11)

The owner decides; nothing here changes a budget. Measured on the tree after wave 3 (`pnpm check:docs`: OK, tree
824152 of the 825000 ratchet, no `near` line, so Slice 5's done line holds for every rewritten guide). The tree is
about 104,000 bytes above the Goal's expectation of about 720,000; STRUCTURE.md is 19,083 bytes, under its 20,000.

- Guides: the largest are `memory` 34,227, `server-resources` 32,968, `chat-pipeline` 32,717, `cbs-rendering` 31,394,
  `persistence` 31,240, `test-harness` 31,222, and `structured-memory/lifecycle` 30,140. None is over the 36,000
  target; 3 are over 32,000, 7 over 30,000, 12 over 28,000, 15 over 24,000 (38 files with the two README indexes).
- Leaves (own bytes of one heading, 8,000 budget, 7,000 target): the largest are `docs/structure/README.md` (Doc
  Maintenance, one leaf) 6,964 and `test-harness` Slow-test table 6,950, then `backup-sync-hub` Files 5,837 and
  STRUCTURE.md Choose By Task 5,820; 2 leaves are over 6,000, 7 over 5,000.
- Items (600-character budget): the longest is exactly 600 (`ui-theming.md:106`), 25 are over 550, 63 over 500. The
  item budget binds today and is not a candidate.

Options:

- **A. Keep 40,000 ceiling / 36,000 target.** Forces nothing; every guide keeps at least 5,773 bytes of headroom, and
  only the ratchet resists regrowth inside a guide.
- **B. Lower to 36,000 ceiling / 32,000 target.** No guide fails; `memory`, `server-resources`, and `chat-pipeline`
  print `near` (`memory` keeps 1,773 bytes under the new ceiling). A later addition of about 2,000 bytes to `memory`
  forces a trim or a move to source in that change.
- **C. Lower to 32,000 ceiling / 28,000 target.** Fails today on `memory` (2,227 over), `server-resources` (968), and
  `chat-pipeline` (717), about 3,900 bytes to trim in three guides before the change lands, and puts 9 more guides at
  `near` (28,153 to 31,394 bytes).
- Leaf and item: keep 8,000 / 7,000 and 600. A 7,000 leaf budget would leave the Slow-test table, which
  `pnpm check:tests` rewrites as slow tests change, and the Doc Maintenance index 36 to 50 bytes under the budget.

Recommendation: **B**. It sets the ceiling to where the rewritten guides now sit with room for one wave of ordinary
edits, fails nothing, and puts the three largest guides on notice, so the next growth there goes into source comments
as the Goal intends; C spends a trim session now on guides that were just rewritten.

## Per heading

### STRUCTURE

19 outline `docs:read` calls; 1 reads of a revision without the guide (unmapped).

| Heading                                           | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------- | ----------------------: | --------: |
| Repository-Wide Invariants                        |                     805 |        16 |
| Agent Read Protocol                               |                     602 |        23 |
| STRUCTURE                                         |                     576 |         0 |
| Choose By Task                                    |                     379 |        17 |
| Path Ownership                                    |                     344 |         0 |
| Glossary                                          |                     126 |         0 |
| Doc Maintenance                                   |                     107 |         5 |
| Repository-Wide Invariants > Tooling              |                     111 |         0 |
| Repository-Wide Invariants > Verification         |                      99 |         0 |
| Repository-Wide Invariants > Data and persistence |                      80 |         0 |
| Repository-Wide Invariants > Release              |                      69 |         0 |
| Repository-Wide Invariants > Platform and network |                      65 |         0 |
| Repository-Wide Invariants > Security             |                      65 |         0 |
| Repository-Wide Invariants > UI                   |                      61 |         0 |
| Dead, Placeholder, or Unwired Code                |                      45 |         0 |
| Path Ownership > Chat, memory, and requests       |                      43 |         0 |
| Migration History                                 |                      31 |         0 |
| Path Ownership > Features, shell, and UI          |                      20 |         0 |
| Path Ownership > Server, build, and tests         |                      12 |         0 |

Every current `##`/`###` heading was touched.

### a

No heading-level reads.

The guide is gone from the current tree.

### agents-and-presets

1 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### app-shell

5 outline `docs:read` calls.

| Heading                   | Ranges (Read, `sed -n`) | docs:read |
| ------------------------- | ----------------------: | --------: |
| Flows                     |                      42 |         0 |
| Files                     |                      26 |         0 |
| State                     |                      24 |         0 |
| Recipes                   |                      13 |         0 |
| Scope                     |                      11 |         1 |
| Tests                     |                      12 |         0 |
| Invariants                |                      11 |         0 |
| App Shell                 |                       9 |         0 |
| Coupling                  |                       9 |         0 |
| Known Hazards             |                       7 |         0 |
| Flows > URL routes        |                       1 |         1 |
| Files > Entry and screens |                       2 |         0 |
| Flows > Safe boot         |                       0 |         1 |
| Files > Router            |                       0 |         1 |

Current `##`/`###` headings no read touched: Files > Bootstrap; Files > Stores and platform; Files > Hotkeys and observers; Files > Home screen; Flows > Boot; Flows > Screen selection; Flows > Escape order; Flows > Alert dialog keys; Recipes > Add a screen or modal; Recipes > Change startup; Recipes > Add platform behavior; Recipes > Add a hotkey; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### assets

6 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several; 1 reads of a revision without the guide (unmapped).

| Heading               | Ranges (Read, `sed -n`) | docs:read |
| --------------------- | ----------------------: | --------: |
| Flows                 |                       1 |         1 |
| Files                 |                       1 |         1 |
| Files > Asset client  |                       2 |         0 |
| Files > Asset sources |                       1 |         0 |
| Files > Asset queues  |                       1 |         0 |
| Scope                 |                       0 |         1 |
| Recipes               |                       1 |         0 |
| Tests                 |                       1 |         0 |

Current `##`/`###` headings no read touched: State; Coupling; Invariants; Known Hazards; Known Hazards > Issues.

### assets-and-saves

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### backend

3 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### backup-sync-hub

4 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several.

| Heading                          | Ranges (Read, `sed -n`) | docs:read |
| -------------------------------- | ----------------------: | --------: |
| Files                            |                      21 |         1 |
| Tests                            |                      17 |         0 |
| Recipes                          |                      15 |         0 |
| Scope                            |                      14 |         0 |
| Flows                            |                      14 |         0 |
| Invariants                       |                      13 |         1 |
| State                            |                      11 |         0 |
| Known Hazards                    |                      11 |         0 |
| Coupling                         |                      10 |         0 |
| Backups, Realm Hub               |                       7 |         0 |
| Flows > Upstream database export |                       3 |         0 |
| Flows > Upstream database import |                       2 |         0 |
| Flows > Upstream library import  |                       1 |         0 |
| Known Hazards > Issues           |                       1 |         0 |
| Flows > RisuRealm terms          |                       1 |         0 |

Current `##`/`###` headings no read touched: Flows > Realm access; Flows > Realm download.

### build-test-platforms

6 outline `docs:read` calls; 3 `docs:read` queries matching no heading or several.

| Heading                                                                           | Ranges (Read, `sed -n`) | docs:read |
| --------------------------------------------------------------------------------- | ----------------------: | --------: |
| Tests                                                                             |                      95 |         2 |
| Files                                                                             |                      79 |         0 |
| Tests > Test rules                                                                |                      57 |         0 |
| Scope                                                                             |                      40 |         1 |
| Recipes                                                                           |                      37 |         0 |
| Known Hazards                                                                     |                      34 |         0 |
| Invariants                                                                        |                      27 |         0 |
| Build, Test Harness, Service Worker, Release                                      |                      22 |         0 |
| Flows                                                                             |                      21 |         0 |
| Coupling                                                                          |                      18 |         0 |
| State                                                                             |                      15 |         0 |
| Files > Documentation check                                                       |                      11 |         3 |
| Files > Prettier config                                                           |                       6 |         0 |
| Files > Relevant `package.json` scripts                                           |                       4 |         2 |
| Files > Build compression                                                         |                       3 |         0 |
| Files > Config files                                                              |                       3 |         0 |
| Known Hazards > Gotchas                                                           |                       2 |         1 |
| Known Hazards > Issues                                                            |                       2 |         0 |
| Files > Changed-file checks                                                       |                       1 |         1 |
| Files > Dev runner                                                                |                       1 |         1 |
| Files > Direct assets                                                             |                       0 |         2 |
| Build, Test Harness, Mobile (Capacitor), Service Worker, Release                  |                       1 |         0 |
| Build, Test Harness, Desktop (Tauri), Mobile (Capacitor), Service Worker, Release |                       1 |         0 |
| Build, Service Worker, Release                                                    |                       1 |         0 |
| Flows > CI                                                                        |                       1 |         0 |
| Flows > Direct assets                                                             |                       1 |         0 |
| Flows > Production                                                                |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Analysis scripts; Files > Service worker and PWA; Flows > Development; Flows > Share target; Flows > Worker Web Push.

### cbs-rendering

3 outline `docs:read` calls.

| Heading                                     | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------- | ----------------------: | --------: |
| Files                                       |                      27 |         1 |
| Tests                                       |                      22 |         0 |
| Known Hazards                               |                      17 |         0 |
| Flows                                       |                      16 |         1 |
| Invariants                                  |                      16 |         0 |
| Scope                                       |                      13 |         2 |
| Coupling                                    |                      12 |         0 |
| Recipes                                     |                      11 |         0 |
| State                                       |                      10 |         0 |
| Known Hazards > Limitations                 |                       7 |         0 |
| Known Hazards > Issues                      |                       6 |         0 |
| CBS Template Language and Message Rendering |                       6 |         0 |
| Known Hazards > Gotchas                     |                       4 |         0 |
| State > Caches                              |                       2 |         1 |
| Files > CBS runtime                         |                       0 |         3 |
| Flows > Display transform                   |                       2 |         0 |
| Files > Script transform client             |                       1 |         1 |
| Flows > Display transform failures          |                       1 |         1 |
| Flows > Evaluation                          |                       0 |         2 |
| Flows > Display                             |                       1 |         0 |
| Flows > Shared styles                       |                       1 |         0 |
| State > Variable storage                    |                       1 |         0 |
| Files > Inlays                              |                       1 |         0 |

Current `##`/`###` headings no read touched: Recipes > Add a CBS function; Recipes > Change message display; Recipes > Change variable semantics.

### characters-modules

3 outline `docs:read` calls; 2 `docs:read` queries matching no heading or several.

| Heading                                | Ranges (Read, `sed -n`) | docs:read |
| -------------------------------------- | ----------------------: | --------: |
| Invariants                             |                      34 |         0 |
| Files                                  |                      32 |         0 |
| Tests                                  |                      32 |         0 |
| Flows                                  |                      28 |         0 |
| Recipes                                |                      21 |         0 |
| Known Hazards                          |                      20 |         0 |
| Scope                                  |                      13 |         1 |
| State                                  |                      13 |         0 |
| Coupling                               |                      13 |         0 |
| Characters, Cards, Modules, Personas   |                      10 |         0 |
| Files > Lorebook filter                |                       1 |         0 |
| Files > Chat lore overrides            |                       1 |         0 |
| Invariants > Lorebook rows and writers |                       0 |         1 |
| Files > Character editor               |                       1 |         0 |
| Files > Lorebook editor                |                       1 |         0 |
| Files > Import transports              |                       1 |         0 |
| Flows > Import results                 |                       1 |         0 |
| Flows > Card export                    |                       1 |         0 |
| Invariants > Characters and chats      |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Cards and CharX; Files > Characters; Files > Modules; Files > Module import; Files > Personas and conversion; Files > Module settings; Files > Asset pickers and lists; Flows > Card import; Flows > Realm download; Flows > Drops and deep links; Flows > Module activation; Invariants > Card formats; Invariants > Asset list rows; Invariants > Effective modules; Invariants > Personas; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### chat-pipeline

7 outline `docs:read` calls; 3 `docs:read` queries matching no heading or several.

| Heading                                         | Ranges (Read, `sed -n`) | docs:read |
| ----------------------------------------------- | ----------------------: | --------: |
| Files                                           |                      62 |         1 |
| Flows                                           |                      46 |         0 |
| Tests                                           |                      43 |         0 |
| Known Hazards                                   |                      40 |         0 |
| State                                           |                      35 |         0 |
| Flows > Job client and reply                    |                      34 |         0 |
| Invariants                                      |                      24 |         0 |
| Scope                                           |                      21 |         1 |
| Coupling                                        |                      21 |         0 |
| Recipes                                         |                      18 |         0 |
| Known Hazards > Issues                          |                      16 |         0 |
| Chat Pipeline: Send → Prompt → Request → Reply  |                      15 |         0 |
| Known Hazards > Limitations                     |                      12 |         0 |
| Known Hazards > Gotchas                         |                      10 |         0 |
| Flows > Stop for a job this tab does not follow |                       4 |         0 |
| Flows > Replays and uncertain creates           |                       4 |         0 |
| Flows > Send, in `DefaultChatScreen.svelte`     |                       2 |         2 |
| Files > Context report                          |                       4 |         0 |
| Files > Composer and drafts                     |                       3 |         1 |
| Flows > Request id retention                    |                       3 |         0 |
| Flows > Reply tail and sequences                |                       3 |         0 |
| Flows > Recovery reads                          |                       2 |         0 |
| Files > Reroll modules                          |                       2 |         0 |
| Files > Slash commands, groups, and search      |                       2 |         0 |
| Flows > Reroll                                  |                       2 |         0 |
| Flows > Job creation and Stop                   |                       2 |         0 |
| Flows > Not in `sendChat`                       |                       2 |         0 |
| Files > Send client and registries              |                       1 |         0 |
| Files > Prompt and templates                    |                       1 |         0 |
| Files > Lore                                    |                       1 |         0 |
| Files > Inlays                                  |                       1 |         0 |
| Flows > Reconnect and status reads              |                       1 |         0 |

Current `##`/`###` headings no read touched: Flows > Send; Invariants > Lore matching.

### chat-store

6 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several; 4 reads of a revision without the guide (unmapped).

| Heading                                              | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------- | ----------------------: | --------: |
| Flows > Summaries and refresh                        |                       5 |         3 |
| Flows > Whole-chat writers                           |                       7 |         0 |
| Flows > Job hydration                                |                       6 |         0 |
| Flows > Server memory writes                         |                       5 |         1 |
| Flows > By-id ops                                    |                       5 |         0 |
| Flows > Map merges                                   |                       4 |         0 |
| Flows > Server generation jobs                       |                       4 |         0 |
| Flows > Chat checkpoints                             |                       4 |         0 |
| Scope                                                |                       3 |         0 |
| Files                                                |                       3 |         0 |
| Files > Readers                                      |                       3 |         0 |
| Files > Last chatted                                 |                       3 |         0 |
| Files > On-demand reads                              |                       3 |         0 |
| Files > Save adapter side                            |                       3 |         0 |
| Flows > Chat writes                                  |                       3 |         0 |
| Flows > Stored translations                          |                       3 |         0 |
| Flows > Job chunks                                   |                       3 |         0 |
| Flows > Callback hydration                           |                       3 |         0 |
| Flows > Restore floor                                |                       2 |         1 |
| Chat Store: Chat Module, Write Protocol, Checkpoints |                       2 |         0 |
| Files > Pins and eviction                            |                       1 |         1 |
| Flows                                                |                       2 |         0 |
| Flows > Selection                                    |                       2 |         0 |
| Flows > Deferral                                     |                       2 |         0 |
| State                                                |                       2 |         0 |
| Known Hazards > Limitations                          |                       2 |         0 |
| Files > Boundaries                                   |                       1 |         0 |
| Files > Locks and streaming                          |                       1 |         0 |
| Files > Render versions                              |                       1 |         0 |
| Files > Character lifecycle                          |                       1 |         0 |
| Files > Chat lists                                   |                       1 |         0 |
| Coupling                                             |                       1 |         0 |
| Invariants                                           |                       1 |         0 |
| Recipes                                              |                       1 |         0 |
| Tests                                                |                       1 |         0 |
| Known Hazards                                        |                       1 |         0 |
| Known Hazards > Issues                               |                       1 |         0 |
| Known Hazards > Gotchas                              |                       1 |         0 |

Every current `##`/`###` heading was touched.

### data-and-events

3 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### development-and-observability

1 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### diagnostics

5 outline `docs:read` calls; 1 reads of a revision without the guide (unmapped).

| Heading                                      | Ranges (Read, `sed -n`) | docs:read |
| -------------------------------------------- | ----------------------: | --------: |
| Files > Browser                              |                      19 |         1 |
| Files > Journal, reports, and support copies |                      13 |         1 |
| Tests                                        |                      10 |         0 |
| Files > History and checked failures         |                       9 |         0 |
| Flows                                        |                       6 |         0 |
| State                                        |                       6 |         0 |
| Known Hazards                                |                       4 |         0 |
| Scope                                        |                       3 |         1 |
| Recipes                                      |                       4 |         0 |
| Request History and Diagnostics              |                       3 |         0 |
| Files                                        |                       3 |         0 |
| Known Hazards > Limitations                  |                       3 |         0 |
| Coupling                                     |                       3 |         0 |
| Invariants                                   |                       3 |         0 |
| Known Hazards > Issues                       |                       2 |         0 |

Every current `##`/`###` heading was touched.

### domain-glossary

No heading-level reads.

The guide is gone from the current tree.

### draft-recovery

5 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several; 13 reads of a revision without the guide (unmapped).

| Heading                                                 | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------- | ----------------------: | --------: |
| Flows > Conflict capture                                |                       3 |         0 |
| Flows > Chat journal                                    |                       2 |         1 |
| Scope                                                   |                       1 |         1 |
| Files                                                   |                       1 |         1 |
| Flows > Chat recovery                                   |                       1 |         1 |
| Draft Recovery: Journal, Composer Rows, Recovery Drafts |                       1 |         0 |
| Flows > Recovery drafts                                 |                       1 |         0 |
| Flows > Apply                                           |                       1 |         0 |

Current `##`/`###` headings no read touched: Flows > Journal store; Flows > Eligibility; Flows > Composer API; Flows > Journal writes; Flows > Split confirmation; Flows > Boot recovery; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### durable-mutations-and-recovery

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### g

No heading-level reads.

The guide is gone from the current tree.

### generated-and-legacy

No heading-level reads.

The guide is gone from the current tree.

### generation-rejection-register

1 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### global-api

3 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several.

| Heading                                | Ranges (Read, `sed -n`) | docs:read |
| -------------------------------------- | ----------------------: | --------: |
| Files                                  |                      71 |         0 |
| Tests                                  |                      23 |         0 |
| Flows                                  |                      22 |         0 |
| Known Hazards                          |                      16 |         0 |
| Scope                                  |                      15 |         1 |
| Coupling                               |                      11 |         0 |
| Invariants                             |                      10 |         1 |
| Recipes                                |                      10 |         0 |
| State                                  |                      10 |         0 |
| Files > Asset queues                   |                       6 |         0 |
| Files > Job channel                    |                       5 |         0 |
| Global API, Network, Utilities, Alerts |                       5 |         0 |
| Files > Asset sources                  |                       4 |         0 |
| Files > Asset client                   |                       3 |         0 |
| Files > Batch codec                    |                       3 |         0 |
| Files > `util.ts`                      |                       2 |         1 |
| Files > Alert queue                    |                       2 |         1 |
| Files > Alert helpers and `AlertComp`  |                       2 |         1 |
| Files > Terminal and reload notices    |                       3 |         0 |
| Files > Web Push                       |                       2 |         0 |
| Files > Generation job client          |                       2 |         0 |
| Files > Other `globalApi` exports      |                       2 |         0 |
| Files > Other modules                  |                       2 |         0 |
| Known Hazards > Issues                 |                       2 |         0 |
| Known Hazards > Limitations            |                       2 |         0 |
| Known Hazards > Gotchas                |                       2 |         0 |
| Files > Network clients                |                       1 |         0 |

Every current `##`/`###` heading was touched.

### intermediate-display

3 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### live-update-feed

3 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several; 1 reads of a revision without the guide (unmapped).

| Heading | Ranges (Read, `sed -n`) | docs:read |
| ------- | ----------------------: | --------: |
| Scope   |                       0 |         1 |
| Files   |                       0 |         1 |

Current `##`/`###` headings no read touched: Flows; Flows > Live-update hello; Flows > Frame admission; Flows > Own chat changes; Flows > Feed chat entries; Flows > Coalescing and publish order; Flows > Publication budget; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Limitations.

### live-updates

7 outline `docs:read` calls; 2 `docs:read` queries matching no heading or several; 1 reads of a revision without the guide (unmapped).

| Heading                   | Ranges (Read, `sed -n`) | docs:read |
| ------------------------- | ----------------------: | --------: |
| Flows > Chat live updates |                       0 |         2 |
| Scope                     |                       1 |         1 |
| Flows > Live updates      |                       0 |         1 |
| Flows > Feed locks        |                       1 |         0 |
| Files                     |                       1 |         0 |

Current `##`/`###` headings no read touched: Flows > Feed connection; Flows > Restore halt; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues; Known Hazards > Limitations.

### llm-requests

5 outline `docs:read` calls.

| Heading                                         | Ranges (Read, `sed -n`) | docs:read |
| ----------------------------------------------- | ----------------------: | --------: |
| Files                                           |                      55 |         0 |
| Tests                                           |                      22 |         0 |
| Recipes                                         |                      18 |         1 |
| Known Hazards                                   |                      18 |         0 |
| Invariants                                      |                      16 |         2 |
| Flows                                           |                      17 |         0 |
| Scope                                           |                      14 |         1 |
| Coupling                                        |                      13 |         0 |
| State                                           |                      11 |         0 |
| LLM Requests, Model Catalogue, Tokenizers       |                       9 |         0 |
| Invariants > Compatibility Model-Root Writes    |                       9 |         0 |
| Files > Tab request layer                       |                       0 |         1 |
| Known Hazards > Issues                          |                       1 |         0 |
| Known Hazards > Limitations                     |                       1 |         0 |
| Known Hazards > Gotchas                         |                       1 |         0 |
| Files > Credentials                             |                       0 |         1 |
| Files > Tokenizer selection and server counting |                       0 |         1 |
| Files > Tab token counting                      |                       0 |         1 |

Current `##`/`###` headings no read touched: Files > Catalogue and model resolution; Files > Model preset slots; Files > Server request layer; Files > Settings pages.

### mcp

5 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several; 1 reads of a revision without the guide (unmapped).

| Heading                      | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------- | ----------------------: | --------: |
| Scope                        |                       2 |         1 |
| Flows > Callbacks in the tab |                       2 |         0 |
| Flows > Tool dispatch        |                       1 |         1 |
| Coupling                     |                       1 |         0 |
| Invariants                   |                       1 |         0 |
| Files > Remote MCP client    |                       0 |         1 |
| Files > Local MCP clients    |                       0 |         1 |
| State                        |                       0 |         1 |
| Known Hazards > Issues       |                       0 |         1 |

Current `##`/`###` headings no read touched: Files > MCP registry; Files > RisuAccess; Files > Server job tools; Recipes; Tests; Known Hazards > Limitations; Known Hazards > Gotchas.

### media-aux

4 outline `docs:read` calls.

| Heading                                                                      | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------------------------------- | ----------------------: | --------: |
| Files                                                                        |                      34 |         0 |
| Tests                                                                        |                      16 |         0 |
| Flows                                                                        |                      14 |         1 |
| State                                                                        |                      12 |         0 |
| Scope                                                                        |                       9 |         1 |
| Known Hazards                                                                |                       7 |         0 |
| Coupling                                                                     |                       6 |         0 |
| Recipes                                                                      |                       5 |         0 |
| Media and Auxiliary Features: TTS, Image Generation, Translation, Playground |                       5 |         0 |
| Invariants                                                                   |                       4 |         0 |
| Known Hazards > Issues                                                       |                       3 |         0 |
| Files > Translator                                                           |                       2 |         0 |
| Files > LLM translation                                                      |                       2 |         0 |
| Known Hazards > Gotchas                                                      |                       2 |         0 |
| Files > TTS                                                                  |                       1 |         1 |
| Files > Image generation                                                     |                       1 |         1 |
| Files > Media                                                                |                       2 |         0 |
| Files > Playground                                                           |                       2 |         0 |
| Files > Server translation                                                   |                       1 |         0 |
| Files > Stored translation                                                   |                       1 |         0 |
| Files > Chat row on the stored path                                          |                       1 |         0 |
| Media and Auxiliary Features: TTS, Image Generation, Media, Playground       |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Settings; Recipes > Add a TTS provider; Recipes > Add an image backend; Recipes > Change aux routing; Recipes > Change media compression.

### memory

2 outline `docs:read` calls.

| Heading                                  | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------- | ----------------------: | --------: |
| Flows > Server                           |                      23 |         0 |
| State                                    |                      22 |         0 |
| Files                                    |                      20 |         0 |
| Invariants                               |                      20 |         0 |
| Tests                                    |                      20 |         0 |
| Known Hazards                            |                      16 |         0 |
| Flows                                    |                      14 |         0 |
| Coupling                                 |                      14 |         0 |
| Recipes                                  |                      14 |         0 |
| Scope                                    |                      12 |         1 |
| Long-Term Memory and Embeddings          |                       8 |         0 |
| Known Hazards > Issues                   |                       6 |         0 |
| Flows > Background memory task           |                       5 |         1 |
| Flows > Selection, in `assemblePrompt`   |                       5 |         0 |
| Flows > V3 standard flow                 |                       5 |         0 |
| Flows > HypaV3 job modes                 |                       4 |         1 |
| Known Hazards > Limitations              |                       4 |         0 |
| Invariants > The memory toggle count     |                       3 |         0 |
| Flows > V3 `summarize`                   |                       3 |         0 |
| Flows > HypaV3 parts                     |                       3 |         0 |
| Server (Phase 5 slice 10)                |                       2 |         0 |
| Server                                   |                       2 |         0 |
| Flows > The no-memory trim question      |                       2 |         0 |
| Files > Algorithms                       |                       2 |         0 |
| Known Hazards > Gotchas                  |                       2 |         0 |
| Invariants > Deferred stored summaries   |                       2 |         0 |
| Flows > Tab embedding routing            |                       2 |         0 |
| Flows > Protection at the final re-check |                       2 |         0 |
| Flows > Summary writers                  |                       2 |         0 |
| Flows > Progress and the stop control    |                       2 |         0 |
| Invariants > Memory writes               |                       1 |         0 |
| Invariants > Token accounting            |                       1 |         0 |
| Files > UI                               |                       0 |         1 |

Current `##`/`###` headings no read touched: Files > Embedding processors; Flows > Server persistence; Flows > Server embeddings and local models; Invariants > Data and memo values; Invariants > Server and tab copies; Invariants > Embedding credentials; Invariants > Embedding cache keys and limits.

### network-jobs

4 outline `docs:read` calls; 5 `docs:read` queries matching no heading or several; 1 reads of a revision without the guide (unmapped).

| Heading          | Ranges (Read, `sed -n`) | docs:read |
| ---------------- | ----------------------: | --------: |
| Scope            |                       2 |         1 |
| Files            |                       1 |         0 |
| Coupling         |                       1 |         0 |
| Files > Web Push |                       0 |         1 |

Current `##`/`###` headings no read touched: Files > Network clients; Files > Generation job client; Files > Job channel; Flows; Flows > Plugin fetch boundary; Flows > Auxiliary credentials; Flows > Job recovery; Flows > Job callbacks; Flows > Push delivery; State; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### persistence

7 outline `docs:read` calls.

| Heading                                                            | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------------------ | ----------------------: | --------: |
| Flows                                                              |                     158 |         0 |
| Files                                                              |                     106 |         0 |
| Tests                                                              |                      99 |         0 |
| Known Hazards                                                      |                      82 |         0 |
| Invariants                                                         |                      80 |         0 |
| State                                                              |                      68 |         0 |
| Recipes                                                            |                      62 |         0 |
| Coupling                                                           |                      54 |         0 |
| Scope                                                              |                      47 |         1 |
| Persistence: Database, Server Resources, Save Adapter              |                      35 |         0 |
| Known Hazards > Gotchas                                            |                      20 |         1 |
| Known Hazards > Limitations                                        |                      19 |         0 |
| Known Hazards > Issues                                             |                      16 |         0 |
| Files > Settings records                                           |                       4 |         1 |
| Flows > Backend                                                    |                       3 |         1 |
| Flows > Device caches                                              |                       3 |         1 |
| Files > Shared shapes                                              |                       4 |         0 |
| Files > Record wrappers                                            |                       4 |         0 |
| Persistence: Database, Save Format, Storage Backends               |                       3 |         0 |
| Files > Mutation modules                                           |                       3 |         0 |
| Flows > Resources                                                  |                       3 |         0 |
| Flows > Character order repair                                     |                       2 |         1 |
| Flows > Browser-local import                                       |                       2 |         0 |
| Flows > Access                                                     |                       2 |         0 |
| Flows > Selection and deletion                                     |                       2 |         0 |
| State > Chat fields                                                |                       2 |         0 |
| State > Chat binding                                               |                       2 |         0 |
| State > Chat toggles                                               |                       2 |         0 |
| State > Messages                                                   |                       2 |         0 |
| Persistence: Database, Save Format, Storage Backends, Cold Storage |                       1 |         0 |
| Persistence: Database, Records, Mutation Stores                    |                       1 |         0 |
| State > Database                                                   |                       1 |         0 |

Every current `##`/`###` heading was touched.

### plugin-sandbox

5 outline `docs:read` calls; 2 `docs:read` queries matching no heading or several.

| Heading                     | Ranges (Read, `sed -n`) | docs:read |
| --------------------------- | ----------------------: | --------: |
| Flows > Job owner presence  |                       2 |         0 |
| Recipes                     |                       2 |         0 |
| Tests                       |                       2 |         0 |
| Known Hazards > Limitations |                       1 |         1 |
| Flows > Database setters    |                       1 |         0 |
| Flows > Deferred reload     |                       1 |         0 |
| State                       |                       1 |         0 |
| Coupling                    |                       1 |         0 |
| Invariants                  |                       1 |         0 |
| Known Hazards               |                       1 |         0 |
| Known Hazards > Issues      |                       1 |         0 |
| Known Hazards > Gotchas     |                       1 |         0 |
| Files > Sandbox host        |                       1 |         0 |
| Files > Host API            |                       1 |         0 |
| Scope                       |                       0 |         1 |

Current `##`/`###` headings no read touched: Files > Plugin install and registries; Flows > Load and reset; Flows > Hook entry points.

### plugins

No heading-level reads.

The guide is gone from the current tree.

### plugins-and-mcp

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### plugins-mcp

| Heading                               | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------- | ----------------------: | --------: |
| Known Hazards                         |                      34 |         0 |
| Tests                                 |                      31 |         0 |
| Invariants                            |                      25 |         0 |
| Files                                 |                      21 |         0 |
| Flows                                 |                      21 |         0 |
| State                                 |                      16 |         0 |
| Recipes                               |                      16 |         0 |
| Coupling                              |                      13 |         0 |
| Scope                                 |                       9 |         0 |
| Plugins (v3 Sandbox) and MCP Tools    |                       8 |         0 |
| Known Hazards > Issues                |                       6 |         0 |
| Flows > Job owner presence            |                       4 |         0 |
| Known Hazards > Gotchas               |                       4 |         0 |
| Flows > Hook entry points             |                       3 |         0 |
| Flows > Hook targets                  |                       3 |         0 |
| Files > Sandbox host                  |                       2 |         0 |
| Files > Host API                      |                       2 |         0 |
| Files > MCP registry                  |                       2 |         0 |
| Flows > Load and reset                |                       2 |         0 |
| Files > Plugin install and registries |                       2 |         0 |
| Flows > Database setters              |                       2 |         0 |
| Flows > Deferred reload               |                       2 |         0 |
| Flows > Tool dispatch                 |                       2 |         0 |
| Known Hazards > Limitations           |                       2 |         0 |
| Files > Remote MCP client             |                       1 |         0 |
| Files > Local MCP clients             |                       1 |         0 |
| Files > RisuAccess                    |                       1 |         0 |

The guide is gone from the current tree.

### prompt-assembly-and-scripting

No heading-level reads.

The guide is gone from the current tree.

### providers-and-models

1 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### README

1 reads of a revision without the guide (unmapped).

| Heading         | Ranges (Read, `sed -n`) | docs:read |
| --------------- | ----------------------: | --------: |
| Doc Maintenance |                       1 |         0 |

Every current `##`/`###` heading was touched.

### resource-sync

2 outline `docs:read` calls; 13 reads of a revision without the guide (unmapped).

| Heading                                              | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------- | ----------------------: | --------: |
| Flows > Record patches                               |                       3 |         2 |
| Flows > Batch composition                            |                       4 |         0 |
| Known Hazards > Limitations                          |                       4 |         0 |
| Files                                                |                       3 |         1 |
| Flows > Live updates                                 |                       3 |         0 |
| Flows > Chat live updates                            |                       3 |         0 |
| Scope                                                |                       2 |         1 |
| Flows > Lost answers                                 |                       2 |         1 |
| Flows > Conflicts                                    |                       2 |         1 |
| Flows > Record merge                                 |                       1 |         2 |
| Flows > Feed connection                              |                       3 |         0 |
| State                                                |                       2 |         1 |
| Flows > Restore halt                                 |                       2 |         0 |
| Resource Sync: Save Adapter, Transport, Live Updates |                       2 |         0 |
| Flows > Serialization                                |                       2 |         0 |
| Flows > Refusals and quarantine                      |                       1 |         1 |
| Flows > Chat and order conflicts                     |                       1 |         1 |
| Flows > flushResources                               |                       1 |         1 |
| Flows > Transport                                    |                       2 |         0 |
| Known Hazards > Gotchas                              |                       2 |         0 |
| Flows                                                |                       1 |         0 |
| Flows > Boot load                                    |                       1 |         0 |
| Flows > Boot cache                                   |                       1 |         0 |
| Flows > Dirty marking                                |                       1 |         0 |
| Flows > Save cycle                                   |                       1 |         0 |
| Flows > Read deadlines                               |                       1 |         0 |
| Flows > Generating refusals                          |                       1 |         0 |
| Flows > Record hydration                             |                       1 |         0 |
| Flows > Credential writes                            |                       1 |         0 |
| Flows > Feed locks                                   |                       1 |         0 |
| Flows > Unload                                       |                       1 |         0 |
| Coupling                                             |                       1 |         0 |
| Invariants                                           |                       1 |         0 |
| Recipes                                              |                       1 |         0 |
| Tests                                                |                       1 |         0 |
| Known Hazards                                        |                       1 |         0 |
| Known Hazards > Issues                               |                       1 |         0 |

Every current `##`/`###` heading was touched.

### scripts-triggers

4 outline `docs:read` calls.

| Heading                                       | Ranges (Read, `sed -n`) | docs:read |
| --------------------------------------------- | ----------------------: | --------: |
| State                                         |                      15 |         0 |
| Tests                                         |                      14 |         0 |
| Flows                                         |                      12 |         1 |
| Files                                         |                      11 |         1 |
| Recipes                                       |                      10 |         0 |
| Known Hazards                                 |                       9 |         0 |
| Invariants                                    |                       8 |         0 |
| Scope                                         |                       7 |         1 |
| Coupling                                      |                       7 |         0 |
| Regex Scripts, Triggers, Lua Scripting        |                       3 |         0 |
| Regex Scripts, Triggers, Lua/Python Scripting |                       1 |         0 |

Current `##`/`###` headings no read touched: Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### self-host-server

12 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several.

| Heading                                                       | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------------- | ----------------------: | --------: |
| Files                                                         |                     156 |         0 |
| Tests                                                         |                     132 |         0 |
| Flows                                                         |                     110 |         0 |
| Invariants                                                    |                      87 |         0 |
| Known Hazards                                                 |                      86 |         0 |
| Files > Routes                                                |                      85 |         0 |
| State                                                         |                      54 |         0 |
| Recipes                                                       |                      53 |         1 |
| Scope                                                         |                      46 |         2 |
| Self-Host Server (Hono on Node), Docker                       |                      39 |         0 |
| Coupling                                                      |                      37 |         0 |
| Routes                                                        |                      24 |         0 |
| Known Hazards > Gotchas                                       |                      24 |         0 |
| Known Hazards > Limitations                                   |                      23 |         0 |
| Known Hazards > Issues                                        |                      19 |         0 |
| Flows > Changes from the former Express server                |                      12 |         0 |
| Files > Storage routes                                        |                       5 |         2 |
| State > Auth and push files                                   |                       4 |         0 |
| State > Disk layout                                           |                       4 |         0 |
| State > Thumbnail cache                                       |                       1 |         3 |
| Files > Rate limits                                           |                       4 |         0 |
| Self-Host Server (Hono on Node), Docker, Edge Proxies         |                       3 |         0 |
| Flows > Proxying                                              |                       3 |         0 |
| Files > Auth routes                                           |                       2 |         1 |
| Routes (`server.cjs`)                                         |                       2 |         0 |
| Files > Asset responses                                       |                       2 |         0 |
| Flows > Request bodies                                        |                       0 |         2 |
| Invariants > Migration checklist (Express → Fastify/Hono/...) |                       1 |         0 |
| State > User files                                            |                       1 |         0 |
| State > Process memory                                        |                       1 |         0 |
| Files > Missing asset check                                   |                       1 |         0 |
| Files > Thumbnail variant                                     |                       1 |         0 |
| Files > Entrypoints and configuration                         |                       1 |         0 |
| Files > Services and helpers                                  |                       1 |         0 |
| Files > Proxy routes                                          |                       1 |         0 |
| Files > Push routes                                           |                       1 |         0 |
| Files > Request history and diagnostics routes                |                       1 |         0 |
| Flows > Login flow                                            |                       0 |         1 |

Current `##`/`###` headings no read touched: Flows > Boot.

### server

No heading-level reads.

The guide is gone from the current tree.

### server-generation

4 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several; 1 reads of a revision without the guide (unmapped).

| Heading                                           | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------- | ----------------------: | --------: |
| Flows > Generation channels                       |                       6 |         0 |
| Flows > Job chat and barriers                     |                       6 |         0 |
| Flows > Prompt job execution                      |                       6 |         0 |
| Flows > Generation admission                      |                       5 |         0 |
| Flows > Command sequences                         |                       5 |         0 |
| Scope                                             |                       4 |         1 |
| Files > Generation routes                         |                       5 |         0 |
| Coupling                                          |                       5 |         0 |
| State                                             |                       4 |         0 |
| Flows > Transform confirmations                   |                       4 |         0 |
| Known Hazards                                     |                       4 |         0 |
| Known Hazards > Issues                            |                       4 |         0 |
| Flows > Coalescing and publish order              |                       4 |         0 |
| Files                                             |                       4 |         0 |
| Files > Runtime modules                           |                       4 |         0 |
| Invariants                                        |                       3 |         0 |
| Recipes                                           |                       3 |         0 |
| Tests                                             |                       3 |         0 |
| Flows > Local model refusals                      |                       3 |         0 |
| Known Hazards > Limitations                       |                       3 |         0 |
| Known Hazards > Gotchas                           |                       3 |         0 |
| Flows > Publication budget                        |                       3 |         0 |
| Flows > Live-update hello                         |                       3 |         0 |
| Flows > Frame admission                           |                       3 |         0 |
| Server generation and live channels               |                       3 |         0 |
| Flows                                             |                       3 |         0 |
| Flows > Own chat changes                          |                       3 |         0 |
| Flows > Feed chat entries                         |                       3 |         0 |
| Files > Transform, translation, and memory routes |                       2 |         0 |
| Files > Live-update socket                        |                       2 |         0 |
| State > Process memory                            |                       2 |         0 |
| Files > LLM and token routes                      |                       1 |         0 |
| State > Job receipts                              |                       1 |         0 |
| Flows > Chat-slot lookup and stop                 |                       1 |         0 |

Every current `##`/`###` heading was touched.

### server-resources

3 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several.

| Heading                              | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------ | ----------------------: | --------: |
| Flows > Snapshots and restore        |                       8 |         0 |
| Flows > Read budget                  |                       7 |         1 |
| State > Store tables                 |                       7 |         0 |
| State > Store open and normalization |                       7 |         0 |
| State > Process memory               |                       7 |         0 |
| Flows > Chat summaries               |                       7 |         0 |
| Flows > Archive export and import    |                       6 |         0 |
| State > Checkpoint tables            |                       6 |         0 |
| State > Store connection             |                       5 |         0 |
| Invariants                           |                       5 |         0 |
| State                                |                       5 |         0 |
| Flows > Chat writes and checkpoints  |                       5 |         0 |
| Flows > Validation                   |                       5 |         0 |
| Flows > Epoch and response rules     |                       5 |         0 |
| Flows > Maintenance                  |                       3 |         1 |
| Scope                                |                       3 |         1 |
| Coupling                             |                       4 |         0 |
| Flows > Upstream backups             |                       4 |         0 |
| State > Summary projection           |                       4 |         0 |
| Flows > Chat activity                |                       4 |         0 |
| Flows > File imports                 |                       3 |         0 |
| Known Hazards > Limitations          |                       3 |         0 |
| Recipes                              |                       3 |         0 |
| Files > Store and chats              |                       3 |         0 |
| Files > Backup and import internals  |                       3 |         0 |
| Flows                                |                       3 |         0 |
| Known Hazards                        |                       2 |         0 |
| Known Hazards > Issues               |                       2 |         0 |
| Files > Resource routes              |                       1 |         1 |
| Flows > Install                      |                       2 |         0 |
| Flows > Shutdown during a restore    |                       2 |         0 |
| Tests                                |                       2 |         0 |
| Server resources                     |                       2 |         0 |
| Files                                |                       2 |         0 |
| Files > File import routes           |                       2 |         0 |
| Known Hazards > Gotchas              |                       1 |         0 |
| Files > Message search route         |                       1 |         0 |
| Files > Chat checkpoint routes       |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Credential routes; Files > Backup routes; Files > Upstream backup routes.

### server-resources-and-bridges

3 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### server-sync

No heading-level reads.

The guide is gone from the current tree.

### settings-i18n

2 outline `docs:read` calls; 2 `docs:read` queries matching no heading or several.

| Heading                                                | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------ | ----------------------: | --------: |
| Files                                                  |                      30 |         0 |
| State                                                  |                      20 |         0 |
| Invariants                                             |                      20 |         0 |
| Tests                                                  |                      17 |         0 |
| Scope                                                  |                      16 |         0 |
| Flows                                                  |                      16 |         0 |
| Recipes                                                |                      15 |         0 |
| Settings UI, Bot Presets, Prompt Template Editor, i18n |                      11 |         0 |
| Coupling                                               |                      10 |         0 |
| Known Hazards                                          |                       9 |         0 |
| Known Hazards > Issues                                 |                       5 |         0 |
| Files > Settings search and jumps                      |                       4 |         0 |
| Known Hazards > Gotchas                                |                       3 |         0 |
| Files > Other handwritten pages                        |                       2 |         0 |
| Files > Registry and helpers                           |                       2 |         0 |
| Files > Declarative pages                              |                       1 |         0 |
| Files > Model and Prompt pages                         |                       1 |         0 |
| Files > Preset lists                                   |                       1 |         0 |
| Files > Memory page                                    |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Data arrays; Files > Renderers and credential links; Files > Settings navigation; Files > Pages; Files > Prompt editors; Files > Languages.

### structured-memory

6 outline `docs:read` calls.

| Heading                                                                | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------------------------- | ----------------------: | --------: |
| Files                                                                  |                      18 |         1 |
| Invariants                                                             |                      19 |         0 |
| State > Memory tables                                                  |                      15 |         0 |
| Recipes                                                                |                      15 |         0 |
| Tests                                                                  |                      15 |         0 |
| State                                                                  |                      14 |         0 |
| Flows > The HypaV3 projection                                          |                      14 |         0 |
| Scope                                                                  |                       9 |         4 |
| Known Hazards > Gotchas                                                |                      12 |         0 |
| Known Hazards > Limitations                                            |                      12 |         0 |
| Coupling                                                               |                      11 |         0 |
| Flows > A memory write                                                 |                      10 |         0 |
| Known Hazards                                                          |                      10 |         0 |
| Flows > The read routes                                                |                       9 |         0 |
| Flows                                                                  |                       8 |         0 |
| Guides                                                                 |                       3 |         4 |
| Flows > The edit route                                                 |                       6 |         0 |
| Flows > The Markdown package                                           |                       5 |         0 |
| Structured Memory: Events, Pages, Threads, Receipts                    |                       4 |         0 |
| Structured Memory: Records, Tables, Store, Routes, Package, Projection |                       3 |         0 |
| Flows > The restore route                                              |                       3 |         0 |
| Flows > Receipts                                                       |                       2 |         0 |
| Flows > The read path                                                  |                       2 |         0 |
| Known Hazards > Issues                                                 |                       2 |         0 |
| Flows > The memory panel                                               |                       1 |         0 |
| Flows > Reconciliation and repairs                                     |                       1 |         0 |
| Flows > A checkpoint                                                   |                       1 |         0 |
| Flows > Copies and branches                                            |                       1 |         0 |
| Flows > The writer's windows                                           |                       1 |         0 |
| Flows > The writer task                                                |                       1 |         0 |
| Flows > A writer run                                                   |                       1 |         0 |
| Flows > Record now                                                     |                       1 |         0 |
| Flows > The analysis prompt                                            |                       1 |         0 |
| Flows > Admission                                                      |                       1 |         0 |
| Flows > The reset                                                      |                       1 |         0 |

Every current `##`/`###` heading was touched.

### structured-memory-lifecycle

1 reads of a revision without the guide (unmapped).

| Heading                                                                      | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------------------------------- | ----------------------: | --------: |
| Invariants                                                                   |                       5 |         0 |
| Flows > Chat files                                                           |                       4 |         0 |
| Coupling                                                                     |                       4 |         0 |
| Known Hazards > Limitations                                                  |                       4 |         0 |
| Flows > Copies and branches                                                  |                       3 |         0 |
| State                                                                        |                       3 |         0 |
| Flows > Reconciliation and repairs                                           |                       2 |         0 |
| Flows > Retraction and edits                                                 |                       2 |         0 |
| Flows > A checkpoint                                                         |                       2 |         0 |
| Structured Memory Lifecycle: Reconciliation, Retraction, Checkpoints, Copies |                       2 |         0 |
| Scope                                                                        |                       2 |         0 |
| Files                                                                        |                       2 |         0 |
| Flows                                                                        |                       1 |         0 |
| Recipes                                                                      |                       1 |         0 |
| Tests                                                                        |                       1 |         0 |
| Known Hazards                                                                |                       1 |         0 |

The guide is gone from the current tree.

### structured-memory-pages

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### structured-memory-read

1 reads of a revision without the guide (unmapped).

| Heading                                                             | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------------------- | ----------------------: | --------: |
| Flows > The memory panel                                            |                      15 |         0 |
| Flows > The writer line                                             |                       8 |         0 |
| Flows > Receipts                                                    |                       7 |         0 |
| Flows > Pages, Timeline, and Threads                                |                       7 |         0 |
| Flows > The read path                                               |                       6 |         0 |
| Flows > Panel edits                                                 |                       6 |         0 |
| Tests                                                               |                       6 |         0 |
| Files                                                               |                       5 |         0 |
| State                                                               |                       5 |         0 |
| Recipes                                                             |                       5 |         0 |
| Known Hazards > Limitations                                         |                       4 |         0 |
| Known Hazards > Gotchas                                             |                       4 |         0 |
| Scope                                                               |                       4 |         0 |
| Coupling                                                            |                       4 |         0 |
| Structured Memory Read Path: Lanes, Card, Manifest, Receipts, Panel |                       3 |         0 |
| Flows                                                               |                       3 |         0 |
| Invariants                                                          |                       3 |         0 |
| Known Hazards                                                       |                       3 |         0 |
| Known Hazards > Issues                                              |                       3 |         0 |
| Flows > Prompt fine-tuning                                          |                       1 |         0 |
| Flows > The test run                                                |                       1 |         0 |

The guide is gone from the current tree.

### structured-memory-rebuild

1 reads of a revision without the guide (unmapped).

| Heading                                                                        | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------------------------------ | ----------------------: | --------: |
| Flows > During a run                                                           |                       3 |         0 |
| Flows > What a rebuild keeps                                                   |                       3 |         0 |
| Flows > The cost preview                                                       |                       3 |         0 |
| Known Hazards > Limitations                                                    |                       2 |         0 |
| Scope                                                                          |                       2 |         0 |
| Flows                                                                          |                       2 |         0 |
| Flows > A run                                                                  |                       2 |         0 |
| Flows > The plan                                                               |                       2 |         0 |
| Tests                                                                          |                       1 |         0 |
| Known Hazards                                                                  |                       1 |         0 |
| Known Hazards > Gotchas                                                        |                       1 |         0 |
| Structured Memory Rebuild: Runs, Staging, the Swap, Backfill, the Cost Preview |                       1 |         0 |
| Files                                                                          |                       1 |         0 |
| Flows > Backfill                                                               |                       1 |         0 |
| Flows > The swap                                                               |                       1 |         0 |
| Flows > The language change                                                    |                       1 |         0 |
| State                                                                          |                       1 |         0 |

The guide is gone from the current tree.

### structured-memory-writer

| Heading                                                          | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------------------- | ----------------------: | --------: |
| Files                                                            |                      11 |         0 |
| Flows > The writer's windows                                     |                      10 |         0 |
| Flows > The writer task                                          |                      10 |         0 |
| Flows > A writer run                                             |                      10 |         0 |
| Flows                                                            |                       9 |         0 |
| State                                                            |                       9 |         0 |
| Flows > Record now                                               |                       8 |         0 |
| Scope                                                            |                       8 |         0 |
| Flows > The scene page                                           |                       8 |         0 |
| Flows > The gap run                                              |                       7 |         0 |
| Flows > The patch call                                           |                       7 |         0 |
| Known Hazards > Limitations                                      |                       6 |         0 |
| Tests                                                            |                       6 |         0 |
| Invariants                                                       |                       6 |         0 |
| Coupling                                                         |                       6 |         0 |
| Flows > The analysis prompt                                      |                       5 |         0 |
| Structured Memory Writer: Windows, Tasks, Runs, Admission, Pages |                       5 |         0 |
| Flows > Compaction                                               |                       5 |         0 |
| Known Hazards                                                    |                       4 |         0 |
| Flows > Admission                                                |                       4 |         0 |
| Recipes                                                          |                       4 |         0 |
| Known Hazards > Gotchas                                          |                       3 |         0 |
| Flows > Pages                                                    |                       3 |         0 |

The guide is gone from the current tree.

### structured-memory/lifecycle

5 outline `docs:read` calls.

| Heading                     | Ranges (Read, `sed -n`) | docs:read |
| --------------------------- | ----------------------: | --------: |
| Scope                       |                       0 |         2 |
| Flows > A checkpoint        |                       0 |         2 |
| Flows > Copies and branches |                       0 |         1 |
| Flows > The adoption choice |                       0 |         1 |
| Files                       |                       0 |         1 |
| Known Hazards > Limitations |                       0 |         1 |
| Coupling                    |                       1 |         0 |

Current `##`/`###` headings no read touched: Flows > Reconciliation and repairs; Flows > Retraction and edits; Flows > Chat files; Flows > Adopting HypaV3 summaries; State; Invariants; Recipes; Tests.

### structured-memory/pages

1 outline `docs:read` calls.

| Heading           | Ranges (Read, `sed -n`) | docs:read |
| ----------------- | ----------------------: | --------: |
| Flows > The trash |                       1 |         0 |
| Flows > Merge     |                       1 |         0 |
| Scope             |                       0 |         1 |

Current `##`/`###` headings no read touched: Files; Flows > The page tools route; Flows > What a merge or split does to history; Flows > Lorebook export; Flows > The import route; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Limitations.

### structured-memory/projection

4 outline `docs:read` calls.

| Heading  | Ranges (Read, `sed -n`) | docs:read |
| -------- | ----------------------: | --------: |
| Coupling |                       1 |         0 |
| Files    |                       0 |         1 |

Current `##`/`###` headings no read touched: Scope; Flows; Flows > The HypaV3 projection; Flows > A tab's read; Flows > The tab's mirror; Flows > A plugin's read; Flows > The upstream export; Flows > The reset; State; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Limitations; Known Hazards > Gotchas.

### structured-memory/read

4 outline `docs:read` calls.

| Heading                  | Ranges (Read, `sed -n`) | docs:read |
| ------------------------ | ----------------------: | --------: |
| Scope                    |                       1 |         2 |
| Files                    |                       1 |         1 |
| Flows > The test run     |                       1 |         1 |
| Flows > Reply screening  |                       1 |         0 |
| Flows > Receipts         |                       0 |         1 |
| Flows > The health badge |                       0 |         1 |

Current `##`/`###` headings no read touched: Flows > The read path; Flows > The memory panel; Flows > Pages, Timeline, and Threads; Flows > Panel edits; Flows > The writer line; Flows > Prompt fine-tuning; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### structured-memory/rebuild

4 outline `docs:read` calls.

| Heading                      | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------- | ----------------------: | --------: |
| Flows > What a rebuild keeps |                       1 |         0 |

Current `##`/`###` headings no read touched: Scope; Files; Flows > A run; Flows > The plan; Flows > Backfill; Flows > The swap; Flows > During a run; Flows > The cost preview; Flows > The language change; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Limitations; Known Hazards > Gotchas.

### structured-memory/records

4 outline `docs:read` calls; 8 reads of a revision without the guide (unmapped).

| Heading                      | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------- | ----------------------: | --------: |
| Flows > The Markdown package |                       1 |         1 |
| Invariants                   |                       1 |         1 |
| Flows > The read routes      |                       1 |         1 |
| Scope                        |                       0 |         1 |
| Flows > The edit route       |                       0 |         1 |
| Files                        |                       0 |         1 |

Current `##`/`###` headings no read touched: Flows > The revert route; Flows > The restore route; Flows > A memory write; State; State > Memory tables; Coupling; Recipes; Tests; Known Hazards; Known Hazards > Limitations; Known Hazards > Gotchas.

### structured-memory/writer

3 outline `docs:read` calls.

| Heading                      | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------- | ----------------------: | --------: |
| Flows > A writer run         |                       2 |         3 |
| Files                        |                       2 |         1 |
| Scope                        |                       1 |         1 |
| Flows > Record now           |                       1 |         1 |
| Flows > The writer task      |                       0 |         1 |
| Flows                        |                       1 |         0 |
| Flows > The writer's windows |                       1 |         0 |
| Flows > The gap run          |                       0 |         1 |

Current `##`/`###` headings no read touched: Flows > Pages and calls; Flows > The scene page; Flows > The patch call; Flows > Compaction; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Limitations; Known Hazards > Gotchas.

### test-harness

3 outline `docs:read` calls; 2 `docs:read` queries matching no heading or several; 8 reads of a revision without the guide (unmapped).

| Heading                         | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------- | ----------------------: | --------: |
| Flows > Browser specs           |                       6 |         0 |
| Scope                           |                       6 |         0 |
| Tests > Slow-test table         |                       5 |         0 |
| Test Harness                    |                       5 |         0 |
| Files > Browser stack           |                       4 |         0 |
| Files                           |                       4 |         0 |
| Files > Reporter                |                       4 |         0 |
| Flows > Whole-suite lock        |                       3 |         0 |
| Files > Fixtures                |                       3 |         0 |
| Tests > Slow tests              |                       3 |         0 |
| Flows > Overload runner         |                       3 |         0 |
| Tests                           |                       3 |         0 |
| Files > Check scripts           |                       2 |         0 |
| Files > Measurement scripts     |                       2 |         0 |
| Tests > Timeouts                |                       2 |         0 |
| Flows                           |                       2 |         0 |
| Flows > Test wrapper            |                       2 |         0 |
| Known Hazards                   |                       2 |         0 |
| Files > Vitest config and setup |                       2 |         0 |
| Files > Test inventory          |                       2 |         0 |
| Tests > Test rules              |                       2 |         0 |
| Recipes                         |                       1 |         0 |
| Coupling                        |                       1 |         0 |
| Tests > Mock factories          |                       1 |         0 |
| Tests > Network guard           |                       1 |         0 |
| Flows > Failed-file rerun       |                       1 |         0 |
| Known Hazards > Gotchas         |                       1 |         0 |
| Files > Human gate              |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Test wrapper and reporter; Files > Check and measurement scripts; State; Invariants.

### translation

1 outline `docs:read` calls; 2 `docs:read` queries matching no heading or several; 1 reads of a revision without the guide (unmapped).

| Heading                               | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------- | ----------------------: | --------: |
| Scope                                 |                       0 |         1 |
| Files > Translator pipeline and slots |                       0 |         1 |
| Invariants                            |                       0 |         1 |

Current `##`/`###` headings no read touched: Files > Translator; Files > LLM translation; Files > Presets and `.risutl`; Files > Server translation; Files > Stored translation; Files > Chat row on the stored path; Files > Bilingual display; Files > Settings; Flows; Flows > Rendered translation; Flows > Stored request and refresh; Flows > Send hand-off; Flows > Stored display and edits; Flows > Bilingual rendering; Flows > Input translation; State; Coupling; Recipes; Tests; Known Hazards; Known Hazards > Issues.

### translation-and-input-hooks

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### ui-theming

5 outline `docs:read` calls; 4 `docs:read` queries matching no heading or several.

| Heading                                    | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------ | ----------------------: | --------: |
| Files                                      |                      68 |         0 |
| Tests                                      |                      24 |         0 |
| Known Hazards                              |                      20 |         0 |
| Scope                                      |                      18 |         0 |
| Invariants                                 |                      15 |         0 |
| Recipes                                    |                      14 |         0 |
| UI Components and Theming                  |                      12 |         0 |
| Coupling                                   |                      10 |         0 |
| Flows                                      |                      10 |         0 |
| State                                      |                       9 |         0 |
| Known Hazards > Limitations                |                       5 |         0 |
| Known Hazards > Issues                     |                       4 |         0 |
| Files > Message row                        |                       4 |         0 |
| Files > Sidebar                            |                       2 |         2 |
| Known Hazards > Gotchas                    |                       3 |         0 |
| Files > Message editors                    |                       2 |         0 |
| Files > Theme                              |                       0 |         1 |
| Files > GUI primitives                     |                       0 |         1 |
| Files > Transcript rows and the mount hold |                       1 |         0 |
| Files > Transcript scrolling               |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Chat screen; Files > Composer; Files > Context meter; Files > Dialogs, popovers, and portals; Files > Editor token counts; Files > Other UI.
