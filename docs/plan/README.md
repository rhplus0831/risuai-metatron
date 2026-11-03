# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Job Handoff](job-handoff.md): another tab of the same user (a PC marked as a worker) takes over
  the owner role of a running generation job and answers its callbacks when the creating tab goes
  silent, asked at creation, or is picked by name; viewer sockets keep the creator watching; D1–D8
  recommended, Q1–Q3 answered, no slice scheduled.
- [Asset Lifecycle](asset-lifecycle.md): the server marks every stored asset from one retention graph (live
  records and chat text, checkpoint pages, every retained snapshot, prepared exports, recent uploads), reports
  disk use as logical size, deduplicated size, and per-owner shares, and deletes unreferenced assets only
  after a grace period, fail-closed, rechecked under a per-key lock, started by the user; snapshots gain
  pins, labels, manual takes, and deletion; D1–D12 recommended, Q1–Q3 answered, no slice scheduled.
- [Reroll Candidates](reroll-candidates.md): the alternatives of the newest reply persist on the
  message as `candidates` with the selected index, a reroll regenerates that message in place and
  puts the chat variables back to the state before the discarded reply, switching candidates
  switches to that candidate's variable state, only the newest reply keeps the snapshots, and a
  discarded candidate is never memory input; D1–D12 recommended, Q1–Q4 answered, no slice scheduled.
- [Render Work Budget](render-work-budget.md): a superseded or unmounted chat row's render run is aborted
  through one signal (parser, transform, translation and retry stop instead of being hidden), deterministic
  parser errors never retry while transient I/O failures retry twice with a delay, transform batches and
  rendered translations count subscribers and cancel only when the last one leaves, identical post-CBS CSS is
  scoped once in a bounded cache, and the screenshot export sizes its output once, releases each source, pages
  large exports and downloads a Blob; D1–D9 recommended, Q1–Q4 open, no slice scheduled.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
