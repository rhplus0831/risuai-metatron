# Doc Maintenance

The rules for editing the guides in this folder and `STRUCTURE.md`, the index every session reads first.

- Focused guides use `Scope`, `Files`, `Flows`, `State`, `Coupling`, `Invariants`, `Recipes`, `Tests`, `Known Hazards`,
  in that order. `###` headings are free within that order: a `##` section over 8,000 bytes is divided by them, each a
  topic an agent would look up, and a topic label is a heading, not a paragraph ending in a colon.
- `Scope` routes the task; `Files` gives paths and lookup identifiers; `Flows` explains ordering; `State` names the
  authoritative records and caches. Describe a contract once and link to it from other sections or guides. Preserve
  heading anchors when moving a topic, or update all referring links.
- A fact about one module lives in that module's source, as a doc comment above what it governs: a module header for
  module-wide rules (`shared/sections.ts` is the shape), a comment on an export for that export's rule. The comment
  states the invariant, the ordering rule, or the failure behavior that reading the body would not show, never a
  paraphrase of the body, and no label T5 forbids.
- The guide's `Files` entry for such a module is the path, its role in one clause, and the identifiers to look up; it
  does not restate the comment. A fact that spans modules, processes, or tabs, or that an agent needs before choosing a
  file, stays in the guide.
- `Flows` keeps the sequences that cross a module, a process, or a tab (a write from the tab through the save loop to
  the server and back through the feed). A sequence inside one module is its entrypoint's name and the source comment.
- A trim, a pointer rewrite, or a move between guides carries a fact ledger in its commit message: each fact the guide
  loses, with its destination (a source path and identifier, a guide heading, or `derivable:` and the entrypoint to
  read). Check the ledger on the result; for parallel trims, on the combined tree before the last one lands, since two
  trims can each leave a fact to the other.
- Draft the ledger from `pnpm docs:contracts <owned files>`, which shows what the modules already document, and check it
  with `pnpm docs:ledger <guide>`, plus `--strict` when the guide names a glob, which can hide a miss.
- Budgets: at most 40,000 bytes per guide, 8,000 under any leaf heading, 600 characters per list item or table row
  (continuation lines and code spans included), and parentheses at most two deep outside code spans. They are the same
  for every guide, this README, and `STRUCTURE.md`: `pnpm check:docs` fails on any of them, and
  [build-test-platforms](build-test-platforms.md) `Files` lists its rules.
- The tree total (every guide, this README, and `STRUCTURE.md`) stays under the ratchet in `util/docsBudget.mjs`. A
  change that lowers the total lowers the ratchet to within 1,000 bytes of it; no change raises it.
- A code span naming a repository path (braces expanded, globs matched) must exist, so a moved file updates its guides
  in the same change; a path git ignores is a runtime file and is not checked.
- A moved, added, or deleted source file updates `docs/structure/ownership.json` in the same change when no rule covers
  it, or when a rule would match nothing: the check fails otherwise. `pnpm docs:owner <path>` shows the rule's guide.
- Targets: 36,000 bytes per guide and 7,000 under a leaf heading. The check reports a file or a heading over its target
  as `near`, with the bytes left under the budget, and does not fail. A trim or a split lands the guide at or under its
  target, not just under the budget, and a change that would carry a guide past its target splits the guide or moves the
  topic to its owner instead of shaving sentences elsewhere to fit.
- An area of three or more guides that share records and vocabulary is a folder, `docs/structure/<area>/`, whose
  `README.md` holds the area's scope, a task-to-guide table, and the files and identifiers the guides share, and no
  `Flows`. **Choose By Task** in `STRUCTURE.md` and `ownership.json` name the folder, whose README routes on to one
  guide. A README has no fixed outline; the budgets and targets apply to it. Any other area is one guide, or guides
  sharing a name prefix.
- A guide's `Tests` section names the harnesses, fakes, and fixtures (what they stand in for, what they control), the
  focused commands for the area, the `slow` and `e2e` memberships, and the gaps (`Not tested`), one bullet per harness.
  It does not list a test file's cases: the file is the inventory, and V4 finds it after a rename.
- A measurement (anything with a date, a browser or Node version, a median, or a byte or millisecond count tied to a
  run) lives in `docs/audit/<topic>-<date>.md`. The guide keeps one sentence with the conclusion that changes how to
  edit the code, and a link. Owner-requested audits go to `docs/manual-audit/`.
- Remove inventories and step-by-step paraphrases the source already makes clear. Keep the entrypoint and the
  non-obvious constraint, ownership boundary, or failure behavior an agent needs before editing.
- Keep only cross-cutting rules in `STRUCTURE.md`. Put subsystem contracts and focused test anchors in their owner; link
  across domains instead of copying inventories.
- `Known Hazards` records what can still catch someone working in the subsystem, under up to three subordinate headings,
  in this order (omit an empty one). One bullet holds one kind: split a bullet that mixes them. Fixed issues are
  deleted.
  - `Issues`: remaining defects and advertised but unwired features, to fix. This is the default when no decision to
    keep the behavior is recorded; mark an unreproduced claim `Unconfirmed:`. Delete an entry in the commit that fixes
    it.
  - `Limitations`: behavior the owner chose to keep, or a direct consequence of a recorded design choice. Each entry
    names where that decision is recorded, in one clause at the end of the bullet
    (`Decision: Durable Drafts D7, archive`), not an indented paragraph; when the decision is reversed, the entry moves
    to `Issues`.
  - `Gotchas`: facts that are not defects but cause mistakes: ordering and test-environment rules, unused files that
    look live, measured costs.
- [Found issues](../research/found-issues.md) is the inbox for out-of-scope findings that a session could not verify or
  place. Once an entry is re-checked in code and has an owning guide, move it to that guide's `Issues` (or
  `Limitations`, once the owner accepts it) and delete it from the inbox.
- Use paths plus identifiers, without stale line numbers, test counts, or pass guarantees.
- `db.<field>` is a flat persisted `Database` name: client views and server request projections can expose it without
  holding a whole-database object.
- Completed plans and phase chronology belong in [the archive](../archived-plan/README.md). Link current guidance to
  current guides; mark historical paths as history.
