# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Job Handoff](job-handoff.md): another tab of the same user (a PC marked as a worker) takes over
  the owner role of a running generation job and answers its callbacks when the creating tab goes
  silent, asked at creation, or is picked by name; viewer sockets keep the creator watching; D1–D8
  recommended, Q1–Q3 answered, no slice scheduled.
- [Asset Lifecycle](asset-lifecycle.md): the server marks every stored asset from one retention graph (live
  records and chat text, checkpoint pages, every retained snapshot, prepared exports, recent uploads), reports
  disk use as logical size, deduplicated size, and per-owner shares, and deletes unreferenced assets only
  after a grace period, fail-closed, rechecked under a per-key lock, started by the user; snapshots gain
  pins, labels, manual takes, and deletion; D1–D12 recommended, Q1–Q3 open, no slice scheduled.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
