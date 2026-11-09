# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Found Issues Clearance](found-issues-clearance.md): every entry of the
  [found-issues inbox](../research/found-issues.md) at `1e55709f9` (86 entries) re-checked against the tree and
  given a disposition so the inbox ends empty; 38 file-cluster slices fix the confirmed defects (the LLM adapters'
  stream, signature and prompt edge cases, the trim question, slash commands during a reroll, upstream import
  reports, shared normalization, translator provider capture, screenshot memory, file-source retries, plugin
  database reads, display apply after local writes, the docs and e2e tooling, the gate tests' clocks), measurement
  slices settle the unmeasured claims, and H1 records the accepted behaviors in their guides and closes the rest;
  the owner accepted every open question's recommendation on 2026-11-09. Landed so far: A3, A1, C1, D2, F2, B6, E3, B5, C2, A2, D1, B2, G4, E1, F1, F7, A4, B4, F3, B3, F5, F8, C3, F9, A5.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.

Before a plan-runner run schedules a plan, its decisions are read against the code and
the findings are recorded in [plan-runner audits](../plan-runner-audit/README.md).
