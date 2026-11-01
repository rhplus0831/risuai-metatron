# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Structured Memory](structured-memory.md): initial design for a memory system of events,
  entity pages, and a scene page with per-send manifests and per-turn receipts, to answer
  HypaV3's verifiability and multi-character weaknesses; Q1–Q9 answered, sliced into 28
  slices; 1a–1d, 2a–2d, 3a, 3b landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
