# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Chat Store and Structured Memory Sweep](store-memory-sweep.md): the 25 entries of the
  [found-issues inbox](../research/found-issues.md)'s "Chat store, sync, and change feeds" and "Structured
  Memory" sections (2026-11-06) re-checked against the tree and given a disposition; 21 file-cluster slices
  fix the confirmed defects (restore-halt reads, lost-follow retirement, append checkpoint policy, row-diff
  base proof, pluginStorage client patches, the in-job memory task, panel freshness, receipts, writer
  provenance, rebuild threads, health reads, the late recheck gap), recorded and gone items leave the inbox
  in C1, and design-sized items are grouped for later plans. The sixteen open questions are answered (every recommendation accepted 2026-11-06).
  Landed: A1, A2, A3, A4, A5, A6, A7, B1, B3, B4, B7, B11.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
