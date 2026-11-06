# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Multi-Client Data Safety Checks](multi-client-e2e.md): real-browser checks that two clients writing the
  same character, chats and messages against the real server lose nothing acknowledged and drop nothing
  local silently (a stale tab, a lost answer, same and different messages, the chat set, a tab close, the
  generation lock, a server restart with work in flight). Three slices: the two-session harness and the
  conflict spec (A), the generation-lock spec (B), and a restart-races check script with its own stack (C).
  Three open questions carry recommendations (red cases file an inbox entry, the unload record edit, the
  same-message convergence).

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
