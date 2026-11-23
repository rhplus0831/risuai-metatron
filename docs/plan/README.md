# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) indexes completed plans with
their last commit and path, and the [backlog](../README.md) holds what they left open.

- [Retire `/multisend` and Group Chats](retire-multisend-and-groups.md): `/multisend` removed, the trigger path and
  the server's command sequences included; group chats archived (kept, hidden from the tab and plugins, refused by the
  server) and their leftover code declared dormant. Audited 2026-11-23; slices 1 and 2 landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive, following the archive's procedure for the plan's open items. Use `None`
here when no plans remain active.

Before a plan-runner run schedules a plan, its decisions are read against the code and
the findings are recorded in [plan-runner audits](../reports/audits/plan-runner/README.md).
