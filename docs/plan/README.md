# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Implementation Audit Fixes](implementation-audit-fixes.md): the 81 findings of the seven
  implementation audits of 2026-11-05 (asset lifecycle, incremental chat transport, job handoff,
  plugin storage, render work budget, reroll candidates, structured memory) given a disposition; 45
  file-cluster slices fix the ordinary-path defects and costs, twelve edge-case findings are excluded
  with their reason, one is deferred, and the owner decided all three questions on 2026-11-05.
  Landed: T1, C1, T5, C3.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
