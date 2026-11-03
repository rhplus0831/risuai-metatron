# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Job Handoff](job-handoff.md): another tab of the same user (a PC marked as a worker) takes over
  the owner role of a running generation job and answers its callbacks when the creating tab goes
  silent, asked at creation, or is picked by name; viewer sockets keep the creator watching; D1–D8
  recommended, Q1–Q3 answered, no slice scheduled.
- [Reroll Candidates](reroll-candidates.md): the alternatives of the newest reply persist on the
  message as `candidates` with the selected index, a reroll regenerates that message in place and
  puts the chat variables back to the state before the discarded reply, switching candidates
  switches to that candidate's variable state, only the newest reply keeps the snapshots, and a
  discarded candidate is never memory input; D1–D12 recommended, Q1–Q4 open, no slice scheduled.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
