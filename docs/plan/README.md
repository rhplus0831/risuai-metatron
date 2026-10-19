# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

Active planning and implementation:

- [Audit Findings and Performance Leftovers](audit-findings-perf.md): landed slices
  are listed in its Status; deferred work and Phase 5 verification remain separate.
- [Open Bug Fixes](open-bug-fixes.md): reachable bugs from the project memory,
  rechecked at `5c3665fdb`; A1, G1 landed.
- [Boot Resource Cache](boot-resource-cache.md): compressed resource reads and a
  per-record, per-module browser cache for the boot read; slice 1 landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
