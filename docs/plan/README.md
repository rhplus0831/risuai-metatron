# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

Active planning and implementation:

- [Audit Findings and Performance Leftovers](audit-findings-perf.md): landed slices
  are listed in its Status; deferred work and Phase 5 verification remain separate.
- [Data-Loss Under Concurrency](data-loss-concurrency.md): fix plan for the confirmed
  findings of `docs/audit/data-loss-concurrency-2026-10-18.md` (field-level chat
  writes, generation-refused retries, reroll history, notice reliability, conflict
  rebase, replay bookkeeping, folder and order repair, four doc corrections); nothing
  landed yet.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
