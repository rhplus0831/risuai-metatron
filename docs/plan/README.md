# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Structured Memory](structured-memory.md): initial design for a memory system of events,
  entity pages, and a scene page with per-send manifests and per-turn receipts, to answer
  HypaV3's verifiability and multi-character weaknesses; Q1–Q9 answered, ready to slice,
  no slice scheduled.
- [Server Plugin Runtime](server-plugin-runtime.md): an opt-in server-side runtime (QuickJS-wasm
  in the script worker pool) that runs the hook half of API 3.0 plugins inside a generation job,
  so hooks complete while the owner tab is asleep or gone; builds on the landed skip-and-replay
  path; D1–D10 recommended, Q1–Q3 open, no slice scheduled.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
