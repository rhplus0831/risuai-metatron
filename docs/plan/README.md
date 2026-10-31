# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Server Byte Budgets](server-byte-budgets.md): admission before bytes, deduplicated and
  budgeted reads, a stored summary projection, worker validation with an SQL install, cheaper
  checkpoints, a normalization stamp, and an ordered writer for auxiliary files (F06, F07, F17,
  SD04–SD06). Status: drafted 2026-10-31, revised after an Astra review the same day; slices 0,
  1 and 3 landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
