# Guide Budgets Plan

Status: drafted 2026-11-01; the user answered Q1–Q4 the same day, accepting each
recommendation (see **Answered questions**). Slices landed: 0 (326caa04d), 1 (e0624f671, 0465e2931), 2 (00f2bfdb8), 3 (5f170aa05), 4 (9c9ae1068), 5a (6248d9897, c9c8b4a3f), 5b (7d8457918, 8848a70a4), 5c (2d7dde2ce, a64b551fa, 82d75dddc, fba244e05), 5d (116e3b97f, 6c602bdf5, 431e77268), 6 (4a7448ed4).
Measurements and the persistence.md inventory were taken at `be5b60b9c`; re-measure with the
Slice 0 report before each slice.

Sources: the owner's request for an audit direction for `STRUCTURE.md` and its guides
(2026-11-01), a byte and heading survey of `docs/structure/` at `be5b60b9c`, and a full read of
`docs/structure/persistence.md` by a reader agent the same day (its findings are the checklist in
Slice 2).

Owning guides: every guide under `docs/structure/`, `STRUCTURE.md` (`Agent Read Protocol`,
`Choose By Task`, `Path Ownership`, `Doc Maintenance`), and
[build-test-platforms](../structure/build-test-platforms.md) for the new check. Each slice
updates the guides it trims or splits; Slice 8 only closes.

## Goal

An agent routed to a guide by `Choose By Task` can answer its task from one bounded read:

- Every guide fits a budget an agent can hold next to the code it is editing: at most 40,000
  bytes per guide (about 10k tokens) and at most 8,000 bytes under any leaf heading, so protocol
  step 3 ("read the relevant `Files`, `Flows`, or `Recipes`") names something that exists.
- Every section longer than one screen has `###` headings, so `rg -n '^##' <guide>` is a table of
  contents and `Read` with an offset and limit reaches one topic without the rest.
- A guide holds what an agent needs to change the subsystem safely: ownership, contracts, state,
  invariants, recipes, the test harnesses and the untested gaps, and the hazards that still catch
  someone. It does not hold a second copy of the source, of the test files, or of an audit report.
- The budgets are checked by `pnpm check:docs`, in `pnpm check`'s CI step, so the corpus does not
  quadruple again between audits.

Not goals: rewriting what the guides say about the code (their anchors are current: 3 of 690
backticked source paths were missing at `be5b60b9c`, all runtime-generated files); changing
`STRUCTURE.md`'s protocol beyond the retrieval step and the maintenance rules; a prose-style
rewrite of guides already under budget; and touching `docs/research/`, `docs/audit/`, or the
archive except to receive content moved out of a guide.

## Current state

Measured at `be5b60b9c` (bytes; tokens are roughly bytes / 4):

| Guide                | Bytes         | 30 days earlier | `###` headings | Inbound links |
| -------------------- | ------------- | --------------- | -------------- | ------------- |
| persistence          | 302,340       | 56,550          | 3              | 43            |
| self-host-server     | 148,836       | 68,580          | 4              | 30            |
| build-test-platforms | 105,297       | 15,085          | 2              | 10            |
| chat-pipeline        | 66,141        | 20,425          | 4              | 16            |
| plugins-mcp          | 54,801        | 21,625          | 3              | 8             |
| characters-modules   | 53,901        | 11,543          | 3              | 7             |
| ui-theming           | 52,155        | 9,246           | 3              | 12            |
| memory               | 51,667        | 8,737           | 4              | 14            |
| global-api           | 46,053        | 11,538          | 3              | 9             |
| cbs-rendering        | 42,871        | 11,015          | 3              | 8             |
| llm-requests         | 41,692        | 10,717          | 4              | 18            |
| settings-i18n        | 41,173        | 9,502           | 2              | 4             |
| app-shell            | 40,599        | 11,281          | 3              | 7             |
| media-aux            | 40,191        | 10,371          | 2              | 8             |
| diagnostics          | 26,074        | (new)           | 5              | 17            |
| backup-sync-hub      | 25,350        | 5,643           | 1              | 2             |
| scripts-triggers     | 17,203        | 16,420          | 3              | 3             |
| **total**            | **1,156,344** | about 300,000   |                |               |

`STRUCTURE.md` is 22,512 bytes: the protocol, the invariants, the two routing tables, a glossary,
and the maintenance rules. It is within budget and is not the problem.

- **Sections are flat.** The 52 `###` headings across 17 guides sit almost all under
  `Known Hazards` (the three `Issues`/`Limitations`/`Gotchas` subheadings the rules require). The
  large sections have none: persistence.md `Flows` is 116,731 bytes under one heading, its `Files`
  72,273 and `Tests` 53,753; self-host-server.md `Files` is 73,918 and `Flows` 28,979;
  build-test-platforms.md `Files` is 49,456 and `Tests` 44,770. Topic boundaries inside them are
  plain paragraphs ending in a colon ("Save:", "Chats:", "Boot:", "Config files:"), which no
  heading search finds.
- **Bullets are paragraphs.** Prettier keeps Markdown prose unwrapped (`proseWrap` is the default
  `preserve`), so one list item is one line. persistence.md is 451 lines averaging 670 characters;
  its five longest lines are 12,604, 10,679, 6,304, 5,779 and 5,328 characters (lines 131, 126,
  114, 150, 121: live updates, the merge tables, the save cycle, server generation jobs, in-doubt
  resends). 111 of its list items exceed 600 characters; six nest parentheses three or more deep.
  `Read` with an offset cannot land inside such a line, and an `rg` hit returns the whole paragraph.
- **Three content types carry most of the growth.**
  - `Tests` sections are per-file case inventories: persistence.md has 67 bullets naming about
    111 test files, most a one-line list of the file's `it()` titles (lines 273, 282, 291 run
    2,300–3,400 characters each). The harness and fixture descriptions worth keeping are a handful
    (lines 270, 271, 272, 283, 298, 300, 306) plus the four `Not tested` gap notes (327–330).
  - `Known Hazards` hold measurement reports and history: the boot-bytes benchmark with its
    12-row table (persistence.md 433–451, dated 2026-10-29, Chrome 156, medians of 3; its source
    report already exists as `docs/audit/boot-bytes-2026-10-29.md`), a projection benchmark dated
    2026-10-04 (429), keystroke batch counts per commit (344), server millisecond timings (449,
    450), a SQLite query-plan sample (431), and "before X, now Y" narration (373, 377, 393, 447,
    448). 29 of the 31 `Limitations` carry an indented `Decision:` paragraph, and about 25
    `Limitations`/`Gotchas` restate a `Flows` step rather than add to it (339, 356, 357, 359, 361,
    365, 367, 369, 371, 375, 381, 395–409, 420, 422, 424–426).
  - `Files` sections inventory leaf modules whose names already say what the bullet says
    (build-test-platforms.md lists every `util/` script and config key; self-host-server.md every
    route).
- **The rules police content, not size.** `Doc Maintenance` forbids line numbers, test counts,
  pass guarantees and plan labels, and `T5` keeps slice labels out of code. Those rules held: the
  guides are not stale. Nothing bounds a guide's size, requires headings, or says what a `Tests`
  section is for, so every plan appends to `Files`, `Flows`, `Tests` and `Known Hazards` and
  nothing deletes. `util/testInventory.mjs` (`pnpm check:tests`) already reads one guide table
  (the slow-test table, `SLOW_TABLE_DOC`) and fails on a mismatch: the precedent for a docs check
  in the gate.
- **persistence.md is five guides.** The reader's inventory (line ranges at `be5b60b9c`):
  settings records and mutation stores (`Files` 20–31, 50–61; `Flows` 86–91, 168–171; `State`
  192–197; `Invariants` 230–231, 237–239, 243–247, 249; all four `Recipes`); the save adapter and
  live sync (`Files` 67–69; `Flows` 96–109 boot load, 111–134 save steps 1–10 and `flushResources`,
  152 unload; `Invariants` 240–241; `State` 212); the chat module and chat protocol (`Files`
  32–49, 62–66; `Flows` 136–151 chats, 154–161 checkpoints; `State` 198–210; `Invariants` 233–236);
  the draft journal and recovery (`Files` 76–78; `Flows` 102–106, 116, 118, the capture half of 126;
  `State` 214–215; `Limitations` 355–372, 395–410; `Issues` 336, 347–351; `Gotchas` 418–419); and
  imports, assets and device-local data (`Files` 70–75, 79; `Flows` 92–94 upstream converters,
  163–166, 173–188). Entangled across those seams: save step 9 (cited from `Files` 40, 46, 47, 49,
  `Flows` 143–150, `Gotchas` 420–426), the restore floor and `reason: "generating"` (`Flows` 128,
  140, 160, `Issues` 339), the chat journal (`Files` 48–49, `Flows` 118), and character-order repair
  (`Files` 61, `Flows` 131, `Limitations` 383–386, `Issues` 342–343).
- **Defects the full read found** (fixed in Slice 2): self-links `[preset records](persistence.md)`,
  `[chat bindings](persistence.md)` with no anchor (21, 30, 201); line 158 points at `Known Hazards`
  for exceptions that are not there; `findChat`/`currentChatRef` described twice (33, 40),
  `adoptCharacter` twice (47, 49), `forgetCharacter` in 49 and 51–52; lines 40 and 126 read as
  contradicting each other on whether character recovery is deferred; line 188 (deleting the
  selected preset) sits under the "cold storage removed" block; line 54 counts "sixteen settings
  collections" that nothing enumerates; `D7`, `SA3`, `Q4` and "the Safety Contract oracle" are
  used without saying where they are defined.
- **Code names guide sections.** Test and source comments cite `persistence.md Save step 5`,
  `save step 2`, `Save step 10` (`e2e/terminalNotice.spec.ts`, `src/ts/storage/tests/*.test.ts`,
  `shared/database.ts`, `server/src/data/resourceStore.ts`, `util/playwright/checkServerJobMatrix.mjs`);
  `docs/audit/*.md` and `docs/archived-plan/README.md` link `persistence.md` and its
  `#known-hazards` anchor; `util/testInventory.mjs` hard-codes `SLOW_TABLE_DOC` and the
  `Test (file in ...)` header. A split must retarget these (invariant V4).

## Decisions

- **D1. Retrieval, not reading.** Every `##` section over 8,000 bytes is divided by `###`
  headings, each a topic an agent would look up ("Save cycle", "Conflict merge", "Boot load"), and
  no leaf heading holds more than 8,000 bytes. The plain-paragraph labels become headings. Protocol
  step 3 becomes: list the guide's headings (`rg -n '^##' <guide>`), read `Scope` and `Invariants`,
  then only the subsection the task names. The nine-section order stays; `###` headings are free
  within it.
- **D2. Budgets, with a ratchet.** 40,000 bytes per guide, 8,000 per leaf heading, 600
  characters per list item (the item and its continuation lines, code spans included), parentheses
  at most two deep outside code spans. Until a guide is under budget its ceiling is its size in
  `util/docsBudget.json`, which a slice may only lower; the check fails when a guide grows past its
  ceiling, so trimmed guides stay trimmed while the run is in progress. The one exception is a guide
  that receives moved content while still over budget (`global-api` and `characters-modules` in
  Slice 2): its ceiling rises by exactly the bytes moved in, the commit says so, and Slice 5 takes it
  under 40,000. A file already at or under 40,000 has no ceiling entry and the uniform budget applies,
  so it can grow to take moved content or new table rows. Slice 7 deletes the per-guide ceilings once
  every guide meets the uniform budget.
- **D3. What leaves a guide.** Three content types move out or go, by rule, not by judgment:
  - A `Tests` section names the harnesses, fakes and fixtures (what they stand in for, what they
    control), the focused commands for the area, the `slow` and `e2e` memberships, and the gaps
    (`Not tested`). It does not list a test file's cases: the file is the inventory, and `V4`
    already makes a rename find it. One bullet per harness; test files are named only where the
    harness or the gap needs them.
  - A measurement (anything with a date, a browser or Node version, a median, a byte or
    millisecond count tied to a run) lives in `docs/audit/<topic>-<date>.md`. The guide keeps one
    sentence with the conclusion that changes how to edit the code and a link. Where the report
    already exists (boot bytes), the guide's copy is deleted.
  - A `Limitations` entry names where its decision is recorded in one clause at the end of the
    bullet (`Decision: Durable Drafts D7, archive`), not an indented paragraph that restates the
    decision. History ("before X, now Y", "no longer", "was removed") is deleted unless the old
    shape still exists on disk or in a cross-user format, in which case it is stated as a current
    fact ("files under `coldstorage/` are left in place and never read").
- **D4. persistence.md becomes four guides, and two clusters move to their owners.**
  - `persistence.md` keeps the name and the records: shared shapes, settings and preset records,
    the mutation stores (`records.svelte.ts`, `characterStore`, `collectionStore`,
    `pluginStorageStore`, `mutationValidation`), access, the `Database`/`Chat` field groups, the
    recipes, and the device-local caches. Keeping the name keeps most of the 43 inbound links and
    the code comments that cite the guide for field ownership valid.
  - `resource-sync.md`: the save adapter and transport (`resourceSync.svelte.ts`,
    `resourceClient.ts`, `eventFeed.ts`), boot load steps, save steps 1–10 as `###` headings
    ("Dirty marking", "Save cycle", "Batch composition", "Lost answers", "Conflicts", ...,
    "Live updates", "Restore halt"), `flushResources`, unload. Code comments that cite
    `persistence.md Save step N` move to `resource-sync.md` with the heading name.
  - `chat-store.md`: the chat module (`chatStore.svelte.ts` and the chat editing helpers), the
    chat write protocol, by-id operations, locks and streaming, server generation jobs and memory
    writes as seen by the store, chat checkpoints (`src/ts/checkpoints/`).
  - `draft-recovery.md`: the draft journal, journal eligibility, the composer API, journal
    recovery at boot, recovery and conflict drafts, with the `Limitations` that belong to them.
  - The upstream `.bin` converters (`server/src/data/upstream/`, `Flows` 92–94) go to
    [backup-sync-hub](../structure/backup-sync-hub.md), which owns upstream compatibility; the
    asset client and queue (`assetClient.ts`, `assetQueue.ts`, `shared/assetBatch.ts`) go to
    [global-api](../structure/global-api.md), which `Choose By Task` already lists for assets and
    thumbnails. The import transports (`serverImportClient`, `moduleImportClient`,
    `charxImportClient`) go to [characters-modules](../structure/characters-modules.md).
  - `Choose By Task` gains three rows and `Path Ownership` three entries; the entangled topics
    (save step 9, the restore floor, the chat journal, character-order repair) are written once in
    their owner and linked by heading anchor from the others.
- **D5. The other two giants split along their own labels.** self-host-server.md keeps routes,
  auth, boot, proxying, disk layout and Docker; its "Resources and chats" and "Snapshots and
  backups" flows (lines 276–368, 503–576) become `server-resources.md`, and "Generation admission",
  "Command sequences" and "Generation channels" (369–502) become `server-generation.md`.
  build-test-platforms.md keeps scripts, configs, environment, web/PWA and releases; the test
  harness (`Tests`, the `util/agent*.mjs` and `testInventory` bullets of `Files`, the slow-test
  table) becomes `test-harness.md`, and `SLOW_TABLE_DOC` follows it. The exact cut is settled in
  each slice by the budget; a guide that lands under 40,000 bytes after D3 without a split is not
  split.
- **D6. The check.** `util/docsBudget.mjs`, run as `pnpm check:docs`, plain Node, no test run.
  It fails, listing each finding, when: a guide or `STRUCTURE.md` exceeds its ceiling
  (`util/docsBudget.json` during the run, the uniform budget after Slice 7); a leaf heading
  exceeds 8,000 bytes; a list item exceeds 600 characters; parentheses nest three deep outside code
  spans; a guide's `##` sections are not the nine in order, or `Known Hazards` has a subheading
  other than `Issues`, `Limitations`, `Gotchas` in that order; a relative `.md` link or `#anchor`
  does not resolve (anchors computed the way GitHub does, so `persistence.md#known-hazards` keeps
  working); a link targets the file it is in without an anchor; or a line matches the `T5` label
  pattern (`\b(Slice|Phase|Stop) [0-9A-Z]`, `docs/plan/`) outside the archive link. A table row is
  one item for the length rule. `--report` prints the per-guide and per-section sizes without
  failing (the Slice 0 survey). It has a Vitest file like `util/testInventory.test.ts`.
- **D7. Prose wrapping (Q1).** Recommended: a Prettier override for `STRUCTURE.md` and
  `docs/structure/**/*.md` with `proseWrap: "always"` at the existing `printWidth` 120, applied once
  in Slice 1 as its own commit. Wrapped bullets make `Read` offsets land inside a topic and make
  diffs show the changed sentence instead of the changed paragraph. The cost is one reflow commit
  and `rg` hits that show one wrapped line instead of the whole bullet; the length rule in D6
  measures the joined item, so wrapping does not change what it counts. If the user declines, D6
  measures the line and nothing else changes.
- **D8. Doc Maintenance states the budgets.** `STRUCTURE.md` `Doc Maintenance` gains: the budgets
  and `pnpm check:docs`; the `###` rule; the `Tests` section contract (D3); the measurement rule
  (D3); the one-clause `Decision:` form; and "a plan's docs slice deletes as much as it adds: when
  a change makes a `Files` or `Flows` bullet describe what the code now says plainly, the bullet
  goes". `AGENTS.md`/`CLAUDE.md` keep their two-line pointer; the protocol text is only in
  `STRUCTURE.md`.
- **D9. One owner per guide per slice.** A slice touches the guides it names and the links into
  them, nothing else; two slices never edit the same guide. Link retargeting into a guide another
  slice owns is a one-line edit done by the slice that moved the content, and it says so in its
  commit.

## Slices

Each slice: run `pnpm check:docs --report` before and after and put both numbers in the commit
message; `pnpm check:docs` and `pnpm format:check` pass; every `rg` for a moved heading name or
guide file name across `src`, `server`, `shared`, `e2e`, `util`, `docs`, `STRUCTURE.md`,
`AGENTS.md` and `CLAUDE.md` is retargeted (V4). The reader acceptance check (**Verification**) is
run for every guide a slice splits.

### Slice 0: the report (D6 `--report`; needs nothing) — _small_

- Write `util/docsBudget.mjs` with the measuring half only: per guide and per `##`/`###` section
  bytes, list-item lengths over the limit, parenthesis depth, heading counts, and unresolved links,
  printed as a table. Add the `check:docs` script running it with `--report` for now.
- Write `util/docsBudget.json` from the report: each guide's current size as its ceiling.
- Record the report's totals in this plan's **Verification** as the baseline.

### Slice 1: rules, protocol, and the ratchet (D1, D2, D7, D8; needs 0) — _small_

- `STRUCTURE.md`: protocol step 3 as in D1; `Doc Maintenance` as in D8; drop the
  "Documentation audit: 2026-10-24" line (git has the date); trim `V1` to its rule (the wrapper's
  flags, the lock and `FLAKY` already belong to build-test-platforms, which `V1` links).
- The Prettier override (D7, accepted as Q1): the reflow is its own commit before any trim, so
  the trims diff cleanly.
- Turn `util/docsBudget.mjs` into the check (D6) with the ratchet file; `pnpm check:docs` fails
  on a guide over its ceiling or any structural finding. Existing findings that are not size
  (unresolved links, self-links, label patterns) are fixed in this slice where they are one-line
  edits, and otherwise listed in the ceiling file's `allow` list with the guide and rule, for the
  owning slice to clear.
- Wire `check:docs` into `util/ci/check.sh` after `check:tests` and document it in
  build-test-platforms (`Files` script table, `CI`).

### Slice 2: persistence.md (D3, D4; needs 1) — _hard_

- Split as D4. Order of work: create `resource-sync.md`, `chat-store.md`, `draft-recovery.md` by
  moving the line ranges named in **Current state** into the nine-section layout with `###`
  headings; move the converters, asset client and import transports to their owners; then trim
  what remains in each of the four under D3.
- `Tests`: keep the harness bullets (`fakeResourceServer.ts`, `storeBackedServer.ts`,
  `FakeSocket`, `installFlatDatabase.ts`, the boot-snapshot oracle and its fixture rule, the
  fake-indexeddb and fake lock manager setup) in the guide whose code they fake, and the four
  `Not tested` notes; delete the case lists.
- `Known Hazards`: delete 433–451 (the boot-bytes report exists in `docs/audit/`), 429 and 344
  (move the conclusion sentence, the numbers to a new `docs/audit/projection-bindings-2026-10-04.md`
  only if the plan that measured them did not already file one; check the archive), 449–450, 431
  (server; one line to self-host-server if it is still true); fold each `Decision:` paragraph into
  its one clause; delete the entries that restate a `Flows` step and keep only the hazard clause;
  rewrite the history entries as current facts or delete them.
- Fix the defects listed in **Current state**: the three self-links, line 158's dangling pointer,
  the three duplicated descriptions, the 40/126 deferral wording, line 188's placement, line 54's
  count, and the undefined labels (`D7`, `SA3`, `Q4`, the oracle) which become links to the archive
  retrieval command or are dropped.
- Retarget: `STRUCTURE.md` `Choose By Task` (split the persistence row into four) and
  `Path Ownership`; the 43 inbound guide links; the code and test comments that cite
  `persistence.md Save step N` (`rg -n 'persistence\.md' src server shared e2e util`); the
  `docs/audit` and archive links that use `#known-hazards` keep resolving because the guide keeps
  the heading.
- Target: each of the four under 40,000 bytes; together well under the 302,340 they replace.

### Slice 3: self-host-server.md (D3, D5; needs 1) — _hard_

- Headings over its label paragraphs (`Boot:`, `Auth:`, `Resources and chats:`, ...,
  `Disk, under save/:`), then the split in D5 if the trimmed guide is still over budget.
- Its 39 hazards: the same D3 pass (measurements to `docs/audit/`, one-clause decisions, no
  restated flows). Its `Files` route inventory keeps the registration order and each route's
  contract that the code does not state (caps, auth placement, body handling); it drops bullets
  that only name the route.
- Retarget the 30 inbound links and the server test comments that cite the guide.

### Slice 4: build-test-platforms.md (D3, D5; needs 1) — _medium_

- Headings over `Relevant package.json scripts:`, `Config files:`, `Environment variables:`,
  `Web:`; the `Tests` section to the D3 contract, which here means the harness is the subject and
  stays, while per-file case lists go.
- Split `test-harness.md` out if still over budget; move `SLOW_TABLE_DOC` in
  `util/testInventory.mjs` (and its test) with the table; update the `util/*.mjs` header comments
  that cite the guide, `vitest.config.ts`, `util/ci/check.sh`, `.github/workflows/ci.yml`.

### Slice 5: the mid-sized guides (D1, D3; needs 1) — _medium_, four independent parts

Each part is one commit per guide and may run beside the others (D9):

- 5a: chat-pipeline, memory.
- 5b: plugins-mcp, characters-modules (which also receives the import transports from Slice 2:
  run 5b after 2).
- 5c: ui-theming, global-api (receives the asset client from Slice 2: after 2), settings-i18n,
  llm-requests.
- 5d: cbs-rendering, app-shell, media-aux.

For each: `###` headings over every section above 8,000 bytes; the `Tests` contract; measurements
out; decisions to one clause; items over 600 characters split by fact. Target: under 40,000
bytes without a split; a guide that cannot get there is reported under **Later** with the
proposed cut, for the user to decide, not split unilaterally.

### Slice 6: the small guides and STRUCTURE.md's tables (D1; needs 2–5) — _small_

- diagnostics, backup-sync-hub (receives the converters from Slice 2), scripts-triggers: headings
  where a section is over 8,000 bytes, and every item over 600 characters split or trimmed (27
  items when Slice 5 finished), otherwise untouched. Slice 7 fails on them.
- `STRUCTURE.md`: the `Choose By Task` and `Path Ownership` tables re-read against the final
  guide set; `Repository-Wide Invariants` (9,023 bytes) split under `###` headings and its three
  items over 600 characters split or trimmed; the glossary unchanged.

### Slice 7: the uniform budget (D2, D6; needs 2–6) — _small_

- Delete the per-guide ceilings and the `allow` list from `util/docsBudget.json` (or the file,
  if nothing else is in it, with the check's read of it); `pnpm check:docs` now applies
  40,000 / 8,000 / 600 to every guide and `STRUCTURE.md`, and a leaf or item over budget fails
  instead of being reported.
- The check's Vitest file covers: a guide over budget, a leaf heading over budget, an item over
  length (wrapped and unwrapped), parenthesis depth with a code span containing parentheses, a bad
  section order, a bad `Known Hazards` subheading, an unresolved link, an unresolved anchor, a
  self-link, a `T5` label, and the `--report` output shape. Run that one file; the slice runs no
  other test.

### Slice 8: close (needs all)

- Record the after numbers in **Verification**; carry anything still in **Later** into the
  archive entry; retire this plan to the archive with its retrieval command.

## Recommended order

0, 1, then 2 (the largest and the one that defines the pattern), then 3 and 4 in either order,
then 5a–5d (5b and 5c after 2), 6, 7, 8. Slices 3, 4 and 5a/5d may run beside 2 since they touch
different guides; the links into persistence.md's successors are retargeted by Slice 2 itself.

## Verification

- `pnpm check:docs` and `pnpm format:check` pass after every slice; `pnpm check:tests` still
  passes after Slice 4 (the slow table moved with its constant).
- Baseline (`pnpm check:docs --report`, guides unchanged since `be5b60b9c`): 17 guides, 1,156,344
  bytes, 52 `###` headings, 14 guides over 40,000 bytes, largest leaf 116,767 bytes, 460 list
  items over 600 characters, 0 table rows over 600, 2 segments above parenthesis depth 2, 0
  unresolved links. The report counts nested and numbered items, measures leaves in bytes, and
  skips code spans and link destinations, so it differs from the survey in **Current state**.
  After: filled in by Slice 8.
- **Reader acceptance**, run for every split or trimmed guide over 30,000 bytes: for three tasks
  the guide's `Choose By Task` row names, a fresh agent given only `STRUCTURE.md` and the guide's
  heading list picks one heading, reads that subsection (under 8,000 bytes), and names the files
  and the invariants the task needs. The subsection it needed, and whether it had to read a
  second one, go in the slice's commit message. A task that needs three subsections means the
  headings are wrong, not the budget.
- **Nothing lost**: for each deleted `Tests` case list, the test file still exists (V4's `rg`);
  for each deleted measurement, the `docs/audit/` file holds the numbers; for each deleted
  `Decision:` paragraph, the archive entry it named still has the decision
  (`git show <commit>:docs/plan/<plan>.md`).
- Link integrity is the check's job; the slice that splits a guide also runs
  `rg -n '<old guide>\.md' src server shared e2e util docs STRUCTURE.md AGENTS.md CLAUDE.md` and
  leaves no hit pointing at content that moved.

## Out of scope

- The contents of `docs/research/`, `docs/audit/` and the archive, beyond receiving moved text.
- Correcting what a guide says about the code where the reader's check found no defect; a
  wrong statement found while trimming goes to `docs/research/found-issues.md` unless the fix is one
  line in the same guide.
- A generated table of contents or a doc site; the heading list via `rg` is the contract.
- The `plugins.md` and `src/etc/docs/` user-facing documents.

## Later

- A per-plan docs budget: a plan's slices may add at most what they delete from the guides they
  touch, checked by comparing `--report` before and after in the plan-runner.
- A second reader pass over the smallest guides for the prose rules (D3's style points) once the
  budgets hold; not worth a slice now.

## Answered questions

Answered by the user on 2026-11-01, each as recommended:

- **Q1. Wrap the guides' prose** (D7): yes. Prettier `proseWrap: "always"` for `STRUCTURE.md`
  and `docs/structure/**`, one reflow commit before the trims (Slice 1).
- **Q2. Decision records to one clause** (D3): yes. The 29 indented `Decision:` paragraphs in
  persistence.md and their counterparts elsewhere keep the pointer (plan, decision id, archive)
  and drop the restatement; no separate decisions ledger.
- **Q3. The numbers** (D2): accepted as written, 40,000 bytes per guide, 8,000 per leaf heading,
  600 characters per item (about 10k tokens per guide and 2k per subsection).
- **Q4. The split** (D4, D5): yes, four guides from persistence.md and the server and test-harness
  splits where trimming alone leaves a guide over budget.

## Review record

None yet.
