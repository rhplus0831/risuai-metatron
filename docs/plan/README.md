# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Server Plugin Runtime](server-plugin-runtime.md): an opt-in server-side runtime (QuickJS-wasm
  in the script worker pool) that runs the hook half of API 3.0 plugins inside a generation job,
  so hooks complete while the owner tab is asleep or gone; builds on the landed skip-and-replay
  path; D1–D10 recommended, Q1–Q3 open, no slice scheduled.
- [Job Handoff](job-handoff.md): another tab of the same user (a PC marked as a worker) takes over
  the owner role of a running generation job and answers its callbacks when the creating tab goes
  silent, asked at creation, or is picked by name; viewer sockets keep the creator watching; D1–D8
  recommended, Q1–Q3 answered, no slice scheduled.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
