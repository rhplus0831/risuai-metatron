# Guides To Source Plan

Status: drafted 2026-11-04 after the chat-store pilot (`c0f4cabae`); landed: 0 (`2b6450a82`), 1-self-host-server (`5b9f23744`), 1-persistence (`b677864b1`), 1-chat-pipeline (`0effa9d4c`), 1-ui-theming (`c3267ac3a`), so Slice 1 is complete; 2-audit (`af0111a0f`); 4 (`630ffc06a`); 2-characters-modules (`e3837199c`); 2-cbs-rendering (`547e12e9c`); 2-memory (`6782ac3fa`); 2-llm-requests (`245c22b4a`); 2-build-test-platforms (`6f2976735`); 2-app-shell (`322b9cd57`); 2-scripts-triggers (`2c7dc7625`); 2-global-api (`6338dfb93`); 2-diagnostics (`55716d397`); 2-settings-i18n (`af2c60ff9`). Decisions D1–D11 are
recommendations for the owner; the **Open questions** Q1–Q4 were answered by the owner on 2026-11-04 (the
recommended option each time). Code anchors and measurements are
at `c0f4cabae` on `dev`; verify them again before editing (STRUCTURE.md protocol step 5).

Sources: the owner's 2026-11-04 question (STRUCTURE.md and `docs/structure` keep growing; split further, trim, or
something else?), the two assessments combined that day (stop splitting; 61% of the bytes are `Files` and `Flows`,
which describe what the code does; move per-module contracts into source comments; prune by evidence; generate the
mechanical parts), the convention and tooling that landed first (`20ed283b5`, `a072851a2`: Doc Maintenance in
[STRUCTURE.md](../../STRUCTURE.md), `missing-path` and `tree` in `pnpm check:docs`, `pnpm docs:read`), the pilot's
fact ledger (the message of `c0f4cabae`), and the measurements under **Current state**, taken in that session.

Owning guides when sliced: [build-test-platforms](../structure/build-test-platforms.md) (`util/docsBudget.mjs`,
`util/docsRead.mjs`, the scripts this plan adds), every guide a slice rewrites, and STRUCTURE.md itself (protocol,
Path Ownership, Doc Maintenance).

## Goal

The guides become a map of contracts, coupling, and hazards instead of a second copy of the code. A fact about one
module lives in a doc comment above what it governs and changes in the same diff as the code; a guide's `Files` entry
is the path, its role, and the identifiers to look up, and `Flows` keeps only the sequences that cross a module, a
process, or a tab. A fresh agent reaches a fact by reading STRUCTURE.md's protocol, one guide section through
`pnpm docs:read`, and one source comment. The tree total only goes down (`TREE_BYTES_RATCHET`), and the always-read
surface, STRUCTURE.md, loses its hand-maintained path tables.

Expected size after the rollout, from the pilot's rate (Files and Flows cut by 55% with no fact lost): the tree from
1,055,065 bytes to about 720,000, and STRUCTURE.md from 33,151 bytes to under 20,000. These are expectations, not
budgets; the ratchet is the rule.

## Current state

- The tree is 1,055,065 bytes in 37 guides plus STRUCTURE.md; 12 guides are over the 36,000-byte target and within
  4,000 bytes of the 40,000 ceiling. It grew from 303,166 bytes on 2026-10-01 to 890,518 on 2026-11-01 through the
  Guide Budgets split (17 guides to 23) and the structured-memory folder, so a split by size did not slow it.
- `Files` and `Flows` hold 61% of the guide bytes; `Known Hazards`, `Invariants`, `Coupling`, and `State` together
  about 25%. Of 667 commits since 2026-09-01 that touched a guide, 50 were docs-only: nearly every code change edits a
  guide, and `self-host-server.md` (232) and `persistence.md` (219) were edited most.
- Source coverage differs by area (exports with a doc comment directly above, at `c0f4cabae`): `src/ts/storage` 87%,
  `server/src/jobs` 93%, `server/src/data` 83%, `server/src/prompt` 83%, `shared/` 76%, `server/src/routes` 72%,
  `src/ts/process` 60%, `server/src/llm` 46%, `src/ts/plugins` 44%, `server/src/mcp` 41%, `src/ts/gui` 7%,
  `src/lib/` (Svelte) unmeasured. The pilot ran on the best-covered area.
- The pilot (`c0f4cabae`): `chat-store.md` 39,934 to 22,013 bytes, `Files` 9,886 to 4,820, `Flows` 22,561 to 9,282,
  about 60 comment lines added to source (most of them one module header for `chatCheckpoints.svelte.ts`). Nearly
  every fact the guide lost was already in a doc comment of `chatStore.svelte.ts`; the module header and the
  per-export comments were the guide's source. A mechanical check (every backticked identifier of the old `Files`
  and `Flows` must appear in the new guide or the named source files) caught the one pair the ledger had missed.
- A fresh agent following the protocol answered two chat-store questions correctly under the new shape, one through
  the guide's pointer to a module header, one through doc comments on the exports. It read about 18 KB of
  STRUCTURE.md before choosing a guide, found `Invariants` useless for both lookups, and had to grep across guides for
  the queued-reorder case because `live-updates.md` does not route it; a sentence in `draft-recovery.md` ("a queued
  reorder a live rebase drops") reads as if live updates drop queued reorders.
- STRUCTURE.md sections: Agent Read Protocol 1,159 bytes, Repository-Wide Invariants 9,479, Choose By Task 5,820,
  Path Ownership 8,832, Glossary 1,061, Doc Maintenance 6,307. Path Ownership is a hand-kept glob-to-guide list the
  check does not validate; Doc Maintenance is needed only when editing a guide.
- Local session transcripts (297 files, 1.8 GB under `~/.claude/projects/-home-codex-risuai-metatron/`) record the
  `Read` tool's `file_path` and `offset`: 142 guide reads, 48 of them by offset (94 whole-file), and 59 reads of
  STRUCTURE.md. Reads through Bash (`sed -n`, `cat`, `rg`) and reads by Codex or Luna workers are not in that count,
  so the transcripts understate use and cannot rank sections on their own.
- `pnpm check:docs` fails on `ceiling`, `leaf`, `item`, `paren-depth`, `sections`, `hazards`, `unresolved-link`,
  `self-link`, `label`, `missing-path`, and `tree`; `pnpm docs:read <guide> [heading]` exists; `pnpm check:changed`
  knows the changed paths but not their owning guide.

## Decisions

- **D1. Rollout order: by churn, in waves, one guide per session.** Wave 1 is the four guides edited most that also
  carry the most `Files` and `Flows` bytes: `self-host-server`, `persistence`, `chat-pipeline`, `ui-theming`. Wave 2:
  `build-test-platforms`, `characters-modules`, `app-shell`, `settings-i18n`, `llm-requests`, `memory`,
  `cbs-rendering`, `backup-sync-hub`, `global-api`, `media-aux`, `scripts-triggers`, `diagnostics`. Wave 3, the
  low-churn, high-share, heavily cross-linked guides: `resource-sync`, `draft-recovery`, `server-resources`,
  `server-generation`, `structured-memory/*`, `translation`, `network-jobs`, `live-updates`, `live-update-feed`,
  `assets`, `plugin-sandbox`, `mcp`, `test-harness`. Within a wave, guides run serially unless Q4 allows pairs with no
  link between them (the inbound-anchor table below); every parallel pair checks both ledgers on the combined tree
  before the second lands, the lesson of the 2026-11-01 trims.
- **D2. The per-guide procedure is the pilot's, with two scripts.** `util/docsContracts.mjs <file>...` prints each
  exported declaration with the doc comment above it, and the exports without one (the pilot's extraction pass).
  `util/docsLedger.mjs <guide> [--base <ref>]` prints every backticked identifier in the base revision's `Files` and
  `Flows` that appears neither in the working guide nor in the files the guide names, and exits non-zero on any.
  A slice then: (1) runs `docsContracts` over the guide's owned modules; (2) drafts the ledger before editing, one
  destination per fact (a comment that already holds it, a comment to add, a guide heading, or `derivable:` with the
  entrypoint); (3) writes the source comments; (4) rewrites `Files` and `Flows`, keeping every anchor another guide
  links to (`rg -o '<guide>\.md#[a-z0-9-]+' docs STRUCTURE.md`); (5) runs `docsLedger`, the focused tests of the
  touched modules, `pnpm check:changed`, `pnpm check:docs`, and lowers `TREE_BYTES_RATCHET` to within 1,000 bytes of
  the new total; (6) commits with the ledger in the message, by old section.
- **D3. What leaves the guide and what stays.** Leaves: a fact that one module's reader can verify in that module (an
  export's contract, an ordering rule inside the module, a failure behavior of one call). Stays: a fact that spans
  modules, processes, or tabs; a fact needed before choosing a file; an ownership boundary; a hazard; the names and
  commands of `Tests`. A sentence that paraphrases a function body is deleted, not moved. The `Known Hazards`, `Tests`,
  `State`, `Coupling`, and `Invariants` sections are not rewritten by this plan; a slice may move a sentence into them
  when the ledger says so (the pilot moved `pinned` to `State` and the version consumers to `Coupling`).
- **D4. Source comment form.** A module header is one `/** */` block after the imports and before the first
  declaration, as `shared/sections.ts` and `chatStore.svelte.ts` have; an export's rule is a JSDoc block on the export.
  A Svelte component's contract is a JSDoc block at the top of its `<script>`. Comments state the invariant, the
  ordering, or the failure behavior the body does not show, name other modules by path when the rule crosses one,
  never name a guide heading (anchors move), and carry no label T5 forbids. A header stays under about 40 lines;
  beyond that the module is too big for one header and the rules go on the exports.
- **D5. `Flows` keeps a sequence only when it crosses a module, a process, or a tab.** The test: can the sequence be
  read top to bottom from one entrypoint in one file? Then the guide names the entrypoint and nothing else. The pilot's
  `Flows` kept the save loop, feed, job, server, and checkpoint-server crossings and dropped the module-internal ones.
- **D6. Low-coverage areas write source first.** Where `docsContracts` shows under half the exports documented
  (`src/ts/gui`, `src/lib/`, `server/src/llm`, `src/ts/plugins`, `server/src/mcp`, `server/src/lua`,
  `server/src/scripts`), the slice writes the module headers from the guide's text before touching the guide, and
  the ledger's destinations are those new comments. Expect those slices to add more source lines than the pilot's 60
  and to cut the guide by less than the pilot's 45%.
- **D7. Evidence of use is a one-off measurement, not a gate.** `util/guideReads.mjs` (not committed as a check; a
  script under `util/`) counts, over the local transcripts, `Read` calls and Bash commands that name a guide, per guide
  and per heading when an offset is given, and writes aggregated counts only (no session text) to
  `docs/audit/guide-reads-<date>.md`. It runs once before wave 2 and once after wave 3. A section no transcript
  touched goes first in its guide's ledger, and the whole-file share (94 of 142 today) is the protocol's compliance
  number before and after `docs:read`. Because Bash reads and worker sessions are undercounted, the counts order work
  inside a guide; they never justify deleting a fact.
- **D8. STRUCTURE.md loses its hand-kept tables.** Path Ownership becomes `docs/structure/ownership.json`: an ordered
  list of `{ "match": "<glob>", "guide": "<name>" }` rules, first match wins, the fallback directories last, one
  `"shared": true` flag for a path two guides share through a file (the `globalApi.svelte.ts` split). `pnpm check:docs`
  validates it: every glob matches a tracked path, every tracked path under `src/`, `server/`, `shared/`, `util/`,
  `e2e/`, `public/` matches a rule, every guide named exists. `pnpm docs:owner <path>...` prints the owning guide, and
  `pnpm check:changed` prints the owning guides of the changed paths as its first line, so protocol step 2 becomes a
  command for a supplied path. STRUCTURE.md's Path Ownership shrinks to how to query and the two sentences that are not
  globs (tests follow their code; the search-excluded payloads). Doc Maintenance moves to `docs/structure/README.md`
  (an index file the check holds to the budgets but not to the guide outline), linked from protocol step 7 and from
  the `tree` rule's message; STRUCTURE.md keeps the protocol, the invariants, Choose By Task, and the glossary.
- **D9. Protocol step 3 reads `Invariants` only for a change.** For a lookup it is `Scope`, then the heading; for an
  add or change task, `Invariants` and `Recipes` too. The trial agent read `Invariants` twice for nothing.
- **D10. Two routing fixes found by the trial go in Slice 0.** `live-updates.md` gets one line under its chat
  live-update heading routing a list update that meets queued order work to `applyRemoteCollection` and
  `canApplyRemoteCollection` in [chat store](../structure/chat-store.md#summaries-and-refresh); the
  `draft-recovery.md` sentence is reworded to name the acknowledgement rebase (`keepPendingOrder`), the only case
  that drops a queued reorder.
- **D11. Budgets stay; the ratchet drives.** The 40,000-byte ceiling, the 8,000-byte leaf, and the 600-character item
  are unchanged through the rollout. Lowering the ceiling is a **Later** item, decided on the tree after wave 3.

Inbound anchors per guide at `c0f4cabae` (links from other guides and STRUCTURE.md), the measure of how many other
guides a rewrite can break and the reason wave 3 goes last: `server-resources` 31, `resource-sync` 28,
`structured-memory/records` 26, `chat-store` 24, `structured-memory/lifecycle` 23, `structured-memory/read` 17,
`structured-memory/writer` 16, `self-host-server` 15, `server-generation` 14, `structured-memory/projection` 14,
`live-updates` 12, `persistence` 11, `structured-memory/rebuild` 11, `draft-recovery` 10, `live-update-feed` 9,
`memory` 6, `backup-sync-hub` 5, `plugin-sandbox` 5; every other guide 3 or fewer.

## Open questions

- **Q1. Move Doc Maintenance out of STRUCTURE.md (D8)?** Answered 2026-11-04: yes. Recommended: yes, to
  `docs/structure/README.md`; it is 6,307 bytes every session reads and only guide edits need. Alternative: keep it
  and accept STRUCTURE.md near 25 KB.
- **Q2. Where the ownership manifest lives (D8).** Answered 2026-11-04: the guides folder. Recommended:
  `docs/structure/ownership.json`, beside what it describes and inside the folder the docs check reads. Alternative:
  `util/guideOwnership.json`, beside the scripts.
- **Q3. Reading the local transcripts (D7).** Answered 2026-11-04: yes. Recommended: yes, aggregated counts only, per
  guide and heading, in a dated audit. Alternative: skip the measurement and order work by churn alone (D1 already
  does).
- **Q4. Parallel guides inside a wave (D1).** Answered 2026-11-04: pairs, as recommended; widened 2026-11-05 by the
  owner to at most six sessions at once, on guides no link joins pairwise. Recommended: serial in
  wave 1; in waves 2 and 3 at most two sessions at once, on guides with no link in either direction, each ledger
  checked on the combined tree before the second commit. Alternative: strictly serial throughout (slower; no
  combined-tree step).

## Slices

Slices 1, 2, 3, and 5 run as one sub-slice per guide (owner, 2026-11-04), so each guide is one session and one
commit as D1 asks: `1-self-host-server`, `1-persistence`, `1-chat-pipeline`, `1-ui-theming` serially in that order;
in Slice 2, `2-audit` (the second `guide-reads` audit) first, then `2-<guide>` for each wave-2 guide; `3-<guide>`
for each wave-3 guide, a `structured-memory/<page>` guide as `3-sm-<page>` with `3-sm-README` last; `5-<guide>` for
each remaining guide, then `5-audit-ceiling` (the final audit and the ceiling decision) last. In waves 2 and 3 up to
six sub-slices run at once when no link joins any two of their guides (Q4, widened 2026-11-05). Every guide sub-slice
lowers `TREE_BYTES_RATCHET`, so parallel sub-slices land one after another, each rebased onto the one before. A slice counts as
landed when all of its sub-slices have.

### Slice 0: scripts, protocol, routing fixes (D2's scripts, D7's script and first audit, D9, D10; needs nothing)

- `util/docsContracts.mjs`, `util/docsLedger.mjs`, `util/guideReads.mjs` with node tests under `util/`; `package.json`
  scripts `docs:contracts`, `docs:ledger`, `docs:reads`; their entries in [build-test-platforms](../structure/build-test-platforms.md)
  `Files`, `Documentation check`, and `Tests`.
- STRUCTURE.md protocol step 3 per D9; Doc Maintenance names the two scripts in the per-guide procedure.
- The `live-updates.md` routing line and the `draft-recovery.md` rewording (D10).
- The first `docs/audit/guide-reads-<date>.md` (D7), if Q3 is yes.
- Done when: `pnpm check:docs`, `pnpm check:tests`, and the three scripts' tests pass; `pnpm docs:ledger chat-store
--base c0f4cabae~1` reports nothing missing (the pilot as the fixture).

### Slice 1: wave 1 guides (D1–D6; needs 0)

- `self-host-server`, `persistence`, `chat-pipeline`, `ui-theming`, serially, each by D2's procedure and its own commit.
  `ui-theming` is the first Svelte-heavy guide and the first low-coverage area (D6): its session records how long the
  source-first pass took and how much the guide shrank, as the estimate for wave 2.
- Done when: each commit's ledger is complete, `docs:ledger` is clean for each, the ratchet came down four times, and
  one fresh-agent lookup trial per guide (two questions from its domain, recorded in the commit message) succeeded.

### Slice 2: wave 2 guides (D1–D6; needs 1)

- The twelve wave-2 guides, in parallel under Q4 where no link joins them, else serially. Before the first, the second
  `guide-reads` audit if Q3 is yes, ordering sections inside each ledger.
- Done when: as Slice 1, for every guide.

### Slice 3: wave 3 guides (D1–D6; needs 2)

- The cross-linked guides last, since each rewrite risks the most inbound anchors; every session begins with the
  inbound-anchor list for its guide and ends with `pnpm check:docs` clean on the combined tree. The structured-memory
  folder is one session per guide with the folder README's shared `Files` checked last.
- Done when: as Slice 1; the tree total is reported against the Goal's expectation in the last commit message.

### Slice 4: STRUCTURE.md tables (D8, Q1, Q2; needs 1, runs beside 2 and 3)

- `docs/structure/ownership.json` built from today's Path Ownership, the validation rules in `util/docsBudget.mjs`,
  `util/docsOwner.mjs` with `pnpm docs:owner`, the owning-guide line in `util/changedChecks.mjs`, STRUCTURE.md's Path
  Ownership reduced to the query and the two non-glob sentences, Doc Maintenance moved per Q1, protocol steps 2 and 7
  updated.
- Touches STRUCTURE.md, `util/`, and `docs/structure/README.md` only, so it can run while a wave rewrites guides;
  it merges `dev` and reruns `pnpm check:docs` before landing (a merge pushed two guides over budget on 2026-11-03).
- Done when: every tracked source path resolves to one guide, `pnpm docs:owner src/ts/storage/chatStore.svelte.ts`
  prints `chat-store`, `pnpm check:changed` prints the owners, STRUCTURE.md is under 20,000 bytes, and the ratchet
  came down by the moved bytes.

### Slice 5: the remaining guides and the budget review (D11; needs 3 and 4)

- The guides not in a wave (`chat-store` is done; the small ones: `assets`, `live-update-feed`, `mcp`,
  `structured-memory/README.md`, `structured-memory/pages`) by D2's procedure where their `Files` and `Flows` still
  restate source; a final `guide-reads` audit; the ceiling decision recorded under **Later** or applied.
- Done when: `pnpm check:docs` prints no `near` for a guide whose `Files` and `Flows` were rewritten, and the plan
  moves to the archive with the before and after tree totals.

## Recommended order

0, then 1; 4 starts when 1 lands and runs beside 2 and 3; 5 last. One guide per session inside a wave (Q4 for
parallel guides). A session that merges `dev` mid-way reruns `pnpm check:docs` after the merge.

## Verification

- Every slice: `pnpm check:docs` clean with the ratchet lowered in the same commit, `pnpm docs:ledger <guide>` empty,
  `pnpm --silent test:agent` on the touched modules' tests, `pnpm check:changed`, `pnpm format:check`, and
  `pnpm check:tests` when a test file was added. New scripts get node tests that are shown to fail with the rule
  disabled (V6).
- Every rewritten guide: one fresh-agent lookup trial of two domain questions through the protocol, its path and any
  misrouting recorded in the commit message; a misrouting becomes a routing line in the owning guide in that commit.
- Across a wave: the inbound-anchor count per guide is unchanged or every change is a link updated in the same commit.
- Slice 4: `ownership.json` validation fails when a rule's glob matches nothing, when a tracked source path matches
  no rule, and when a guide name has no file (three tests).

## Out of scope

- Rewriting `Known Hazards`, `Tests`, `State`, `Coupling`, or `Invariants` for their own sake; moving a topic from one
  guide to another beyond what a ledger requires; renaming or merging guides; `plugins.md` and the archived plans.
- Validating identifiers in code spans (only paths are checked); generating `Files` lists from the tree.
- Changing the 40,000, 8,000, and 600 budgets during the rollout (D11).

## Later

- Lower the guide ceiling and target once wave 3 has landed, from the tree as it is then.
- An identifier check: a backticked identifier in a `Files` entry exists in the path the entry names.
- A `Files` generator for the identifier lists, from the exports of the owned modules, if the hand-kept lists drift.
