# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

Active planning and implementation:

- [Audit Findings and Performance Leftovers](audit-findings-perf.md): landed slices
  are listed in its Status; deferred work and Phase 5 verification remain separate.
- [RisuNest Small Wins](risunest-small-wins.md): alert queue, safe boot, plugin quick
  wins, test network guard, CI and image hygiene, engineering rules; planned; Phase 2's
  wait on the `heap-memory-reduction` merge is over.
- [Search](search.md): `color-scheme`, a Korean-aware list matcher, settings search with
  deep links, and server-side message search across chats; every slice landed; final
  checks and the merge into `metatron` pending.
- [Chat Checkpoints](chat-checkpoints.md): named per-chat save slots on the server
  (messages, variables, chat lore, memory) with load, safety and auto checkpoints;
  planned; slice 6's wait on the `heap-memory-reduction` merge is over.
- [Upstream `.bin` Compatibility](upstream-bin-compat.md): import an upstream RisuAI
  `.bin` (staged, with a report, full replace) and export a `.bin` upstream restores;
  planned.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
