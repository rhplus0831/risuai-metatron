# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

Active planning and implementation:

- [Chat Checkpoints](chat-checkpoints.md): named per-chat save slots on the server
  (messages, variables, chat lore, memory) with load, safety and auto checkpoints;
  planned; slice 6's wait on the `heap-memory-reduction` merge is over.
- [HypaV3 Background Memory](hypav3-background-memory.md): a send selects stored HypaV3
  summaries and a detached server task writes new ones; blocking stays for Plugin memory
  models and request triggers, a large gap asks first; all slices landed (2, 1a, 5a, 1b, 3a, 4, 3b, 5b, 5c, 5d, 6, 7, 8); final checks pending.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
