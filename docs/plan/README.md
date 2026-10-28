# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Durable Drafts](durable-drafts.md): unsaved changes survive a lost page (an IndexedDB journal
  recovered in the same epoch), conflicts keep the local version, and saves stop waiting for
  unrelated reads (audit F02–F04).
- [Display Evaluation](display-evaluation.md): cached display transform results follow the stored
  transcript and the viewport, a row that showed an unsaved mix renders again after the save, a
  render burst loads once, snapshots are charged for what they hold, and a remounted row reuses its
  confirmed result (audit TJ02, TJ03, TJ05, ST05).

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
