# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) indexes completed plans with
their last commit and path, and the [backlog](../README.md) holds what they left open.

- [Memory Panel Readability](memory-panel-readability.md): the memory panel as a place to read, find, and correct
  what a chat remembers. Eight serial slices; slices 1 to 4 landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive, following the archive's procedure for the plan's open items. Use `None`
here when no plans remain active.

Before a plan-runner run schedules a plan, its decisions are read against the code and
the findings are recorded in [plan-runner audits](../reports/audits/plan-runner/README.md).
