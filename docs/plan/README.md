# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Durable Drafts](durable-drafts.md): unsaved changes survive a lost page (an IndexedDB journal
  recovered in the same epoch), conflicts keep the local version, and saves stop waiting for
  unrelated reads (audit F02–F04). Slices 1–5 and 9 landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
