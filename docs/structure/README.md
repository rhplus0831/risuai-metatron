# Doc Maintenance

`STRUCTURE.md` routes tasks and states repository-wide invariants. Each guide in this folder owns the information an
agent needs to choose files, change a contract, and verify the result.

## Place the fact

- A rule belongs in [STRUCTURE.md](../../STRUCTURE.md#repository-wide-invariants) when an edit outside its owning guide
  can break it. Every add/change task reads that section. Keep area-specific invariants with their guide.
- Document a single module's invariant, order, or failure behavior in a header or on the governing export. See
  `shared/sections.ts` for an example. Put interactions across modules, processes, or tabs in the owning guide and link
  to that contract elsewhere.
- Put measurements in `docs/reports/measurements/`, audit reports in `docs/reports/audits/`, and open work in
  `docs/backlog/`. Keep the consequence for editors and the report link in the guide. The
  [plan archive](../archived-plan/README.md) indexes completed plans. See the [docs index](../README.md) for other
  destinations.

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
3. Run `pnpm docs:ledger <guide>` after the edit. It checks identifiers in the base revision's `Files` and `Flows`
   against the edited guide and the files it names. Add `--strict` for guides naming globs. Review moves on the combined
   tree so parallel trims keep a destination for each fact.
4. For a new, moved, or deleted source path, check `pnpm docs:owner <path>`. Update `ownership.json` if the path has no
   rule, routes to the wrong guide, or leaves a rule without matches. Exact and shared rules precede directory
   fallbacks.
5. Format changed files with Prettier and run `pnpm check:docs` for outlines, budgets, links, path spans, ownership and
   verification records. Check bare file names and identifiers in source. Run `pnpm check:tests` after a slow-test table
   edit. See the [checker](build-test-platforms.md#documentation-check) for brace expansion, git-ignored runtime paths
   and report mode.
6. A rising `pnpm docs:ledger --stale` count or a leading `pnpm docs:due` entry calls for a focused pass. Read the guide
   section by section against source in one session, fix drift and file outstanding findings. Only after this pass, run
   `pnpm docs:due --verified <guide>` to record the source revision in `docs/structure/verified.json`.
7. For an owner-requested full audit, read every guide, this README and the index against the same source revision. Have
   a second reader check the findings. Before committing, run `pnpm docs:due --verified <guide>...` with all the guide
   names listed by `pnpm docs:due`. The root index and this maintenance README are covered in the audit report. Write
   the report under `docs/reports/audits/guides/` and update [Last full audit](../../STRUCTURE.md#doc-maintenance) with
   the date, source revision and report link. Between full audits, verify the individual guides that are due.

## Size limits

The index, every guide, and every README share the file, heading, item, and parenthesis limits. A trim or split should
reach the target.

| Unit                                                               |       Target |          Limit |
| ------------------------------------------------------------------ | -----------: | -------------: |
| File                                                               | 36,000 bytes |   40,000 bytes |
| Own text under one heading                                         |  7,000 bytes |    8,000 bytes |
| `Repository-Wide Invariants` in the index, with its subsections    |  8,000 bytes |   10,000 bytes |
| List item or table row, including continuation text and code spans |              | 600 characters |
| Nested parentheses outside code spans                              |              |       2 levels |

`pnpm check:docs` reports `near` above a target and fails above a limit. Tree bytes track growth across the guides and
index. The size limits apply at the units in the table.

Add new facts to their owning guide. If that introduces a `near` warning, name it in the change report and file the trim
or split in [found issues](../backlog/found-issues.md) once per guide. Above a hard limit, land the split first in its
own commit. Schedule unrelated trims separately. Prioritize `near` warnings and large, seldom-read guides.
`pnpm docs:reads` samples local Claude Code transcripts and misses Codex reads. Re-run `pnpm check:docs` after merging
guide edits from another branch.

## Known hazards and the issue inbox

Under `Known Hazards`, use these `###` headings in order. Omit empty headings and give each distinct finding its own
bullet.

- `Issues` holds unreproduced claims, each prefixed `Unconfirmed:`. Move confirmed defects and advertised but unwired
  behavior to the owning guide's section in [known issues](../backlog/known-issues.md). Retire the entry when fixed.
- `Limitations` holds behavior the owner chose or a consequence of a recorded choice. End the bullet with a short
  decision reference. If the decision is reversed, move the outstanding defect to known issues.
- `Gotchas` holds facts that can mislead an editor, such as ordering requirements, test environment differences, or a
  plausible-looking file with no callers.

Use [found issues](../backlog/found-issues.md) for out-of-scope findings that need verification or an owner. Retire the
inbox entry once it is fixed or placed under known issues, Limitations or Gotchas.

Triage server security findings for internet-reachable deployments. Record the lowest-cost change that closes the worst
exposure and give any larger redesign its own entry (owner decision, 2026-11-10, known-issues review).
