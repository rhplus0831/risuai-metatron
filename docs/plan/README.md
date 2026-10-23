# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

Active planning and implementation:

- [Chat Checkpoints](chat-checkpoints.md): named per-chat save slots on the server
  (messages, variables, chat lore, memory) with load, safety and auto checkpoints;
  planned; slice 6's wait on the `heap-memory-reduction` merge is over.
- [Per-Chat Send](per-chat-send.md): a per-chat local send registry replaces the
  tab-wide `doingChat` flag so different chats of one tab generate at the same time;
  channel deadlines start at dispatch; planned.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
