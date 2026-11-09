# Doc Maintenance

`STRUCTURE.md` routes tasks and states repository-wide invariants. Each guide in this folder owns the information an
agent needs to choose files, change a contract, and verify the result.

## Place the fact

- Keep repository-wide rules in [STRUCTURE.md](../../STRUCTURE.md#repository-wide-invariants).
- Document a single module's invariant, order, or failure behavior in a header or on the governing export. See
  `shared/sections.ts` for an example. Put interactions across modules, processes, or tabs in the owning guide and link
  to that contract elsewhere.
- Put measurements from a run in `docs/audit/`, or `docs/manual-audit/` for owner-requested audits. Keep the editing
  consequence and report link in the guide. Keep completed plans and phase history in the
  [archive](../archived-plan/README.md).

Use paths and current identifiers as lookup anchors. A `db.<field>` name refers to the flat persisted `Database` field,
which settings views and server projections can expose. Describe present behavior and its reason (STRUCTURE T5). Source,
test files, and the current test run own implementation details, test-case inventories, and results.

## Guide outline

Use these `##` headings in order. Give a topic its own searchable `###` heading when a section needs subdivision.

- `Scope` names the tasks the guide owns and routes neighboring tasks.
- `Files` gives the source path, its role, and lookup identifiers. Leave the module contract at its source.
- `Flows` explains ordering across boundaries, such as a tab write, its acknowledgement, and the feed echo. For a
  sequence inside one module, point to the entrypoint's comment.
- `State` identifies authoritative records, derived state, and caches.
- `Coupling` identifies other owners a change can reach and when to follow the link.
- `Invariants` gives constraints that edits in this area must preserve.
- `Recipes` gives the edit path for recurring changes. Link back to contracts.
- `Tests` gives focused commands, slow and e2e membership, and coverage gaps (`Not tested`). Give each harness, fake, or
  fixture one bullet explaining what it controls.
- `Known Hazards` holds [current issues, limitations and gotchas](#known-hazards-and-the-issue-inbox).

An area with three or more guides sharing records and vocabulary gets a folder. Its `README.md` holds the area scope,
task-to-guide table, and shared files and identifiers. Route to the folder from **Choose By Task** and
`docs/structure/ownership.json`. Keep flows in the focused guides. Smaller areas use a single guide or a shared name
prefix. Indexes and READMEs have a free outline.

## Update and verify a guide

1. Check the current source and tests behind each changed claim. Use `pnpm docs:contracts <source files>` to see which
   facts already have a source comment.
2. For a trim, pointer rewrite, or move, record each removed fact and its destination in the commit message. Name a
   source path and identifier, a guide heading, or `derivable:` plus the entrypoint. Keep the old heading anchor or
   update its inbound links.
3. Run `pnpm docs:ledger <guide>` after the edit. Add `--strict` for guides naming globs. The tool compares the base's
   `Files` and `Flows` identifiers with the guide and the files it names. Review the meaning and destinations on the
   combined tree, especially when several guides lose related text.
4. For a new, moved, or deleted source path, check `pnpm docs:owner <path>`. Update `ownership.json` if the path has no
   rule, routes to the wrong guide, or leaves a rule without matches. Exact and shared rules precede directory
   fallbacks.
5. Format changed files with Prettier and run `pnpm check:docs`. It checks relative Markdown links and anchors,
   repository paths in code spans, the guide outline, budgets, and the ownership manifest. It expands braces and globs
   for path checks and allows git-ignored runtime paths. Verify identifiers and bare file names in source. Run
   `pnpm check:tests` after changing the slow-test table.
6. A guide whose `pnpm docs:ledger --stale` count rises, or that has gathered many commits since it was last read
   against the code, is due a read-and-verify pass: one session, section by section against the source, fixing what
   drifted and recording the rest in the issue inbox. There is no whole-tree pass.

## Size limits

The index, every guide, and every README share the same limits. A trim or split should reach the target. If adding a
topic would cross a target, move it to its owner or split the guide.

| Unit                                                               |       Target |          Limit |
| ------------------------------------------------------------------ | -----------: | -------------: |
| File                                                               | 36,000 bytes |   40,000 bytes |
| Own text under one heading                                         |  7,000 bytes |    8,000 bytes |
| List item or table row, including continuation text and code spans |              | 600 characters |
| Nested parentheses outside code spans                              |              |       2 levels |

`pnpm check:docs` reports `near` over a target and fails over a limit. Its verdict line also prints the bytes of the
guides and the index together, a trend figure with no limit: a reader takes one section at a time, so the leaf and item
limits bound a read, not the tree. A change adds its facts to the owning guide and does not trim a guide it would not
otherwise touch. Trims are passes of their own, aimed first at large guides that `pnpm docs:reads` shows are rarely
read. See the [documentation checker](build-test-platforms.md#documentation-check) for exact rule coverage and its
report mode.

## Known hazards and the issue inbox

Under `Known Hazards`, use these `###` headings in order. Omit empty headings and give each distinct finding its own
bullet.

- `Issues` holds unreproduced claims, each prefixed `Unconfirmed:`. Confirmed defects and advertised but unwired
  behavior live in [known issues](../research/known-issues.md), one queue over every guide (moved there on 2026-11-10):
  a confirmed claim moves there, and an entry is deleted when the defect is fixed.
- `Limitations` holds behavior the owner chose or a consequence of a recorded choice. End the bullet with a short
  decision reference. If the decision is reversed, move the outstanding defect to known issues.
- `Gotchas` holds facts that can mislead an editor, such as ordering requirements, test environment differences, or a
  plausible-looking file with no callers.

Use [found issues](../research/found-issues.md) for out-of-scope findings that still need verification or an owner. When
a finding is checked and placed, describe it under its owning guide's section of known issues (or in the guide itself as
a Limitation or Gotcha) and retire the inbox entry. For a confirmed limitation, include the owner's decision.
