# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Per-Event Server Work](per-event-server-work.md): a streaming checkpoint, a callback barrier,
  a feed entry for an unloaded chat or a metadata field, and a feed frame cost message-sized
  work (audit findings SD01, TJ04, ST04, SD03).

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
