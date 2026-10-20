# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

Active planning and implementation:

- [Audit Findings and Performance Leftovers](audit-findings-perf.md): landed slices
  are listed in its Status; deferred work and Phase 5 verification remain separate.
- [RisuNest Small Wins](risunest-small-wins.md): alert queue, safe boot, plugin quick
  wins, test network guard, CI and image hygiene, engineering rules; planned, Phase 2
  waits for the `heap-memory-reduction` merge.
- [Search](search.md): `color-scheme`, a Korean-aware list matcher, settings search with
  deep links, and server-side message search across chats; planned.
- [Chat Checkpoints](chat-checkpoints.md): named per-chat save slots on the server
  (messages, variables, chat lore, memory) with load, safety and auto checkpoints;
  planned, slice 6 waits for the `heap-memory-reduction` merge.

- [Upstream `.bin` Compatibility](upstream-bin-compat.md): import an upstream RisuAI
  `.bin` (staged, with a report, full replace) and export a `.bin` upstream restores;
  planned, runs alongside `heap-memory-reduction` (no shared files).

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
