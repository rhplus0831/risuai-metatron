# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups. Reroll Candidates
below was revised on 2026-11-04 after the
[plan design audit](../manual-audit/plan-design-audit-2026-11-04.md), as were Job Handoff, Asset Lifecycle and
Incremental Chat Transport (all since landed and archived); Job Handoff, Asset Lifecycle and Reroll
Candidates were then challenged again and revised a second time the same day.

- [Reroll Candidates](reroll-candidates.md): the alternatives of the newest reply persist on the
  message as `candidates` with stable ids, a list revision and the selected index under a per-message size
  budget; a reroll regenerates
  that message in place as a server job (the candidate push and the per-key variable restore precede the
  `begin`, and an end without a reply writes the previous candidate back in the generation's final write
  with the attempt's own variable writes rolled back from a per-key ledger the store keeps while the
  carrier is locked, leaving another writer's values); a candidate switch is a server op that names the candidate by id
  and the list by revision, evaluated from the stored row, and moves the variables and the checkpoint's
  `after` with it while the turn's `before` is kept; the extra samples of one request
  become candidates; only the newest reply keeps the snapshots and a discarded candidate is never memory
  input; the tab takes the in-place path only when the server's `hello` advertises it; Slice 2 merges with or
  after Incremental Chat Transport Slice 4 (a traffic dependency, not a code one: separate branches are fine,
  the merge runs the listed integration checks); D1–D14 recommended, Q1–Q4 answered, all four slices landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
