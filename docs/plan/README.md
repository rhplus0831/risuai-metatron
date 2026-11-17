# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) indexes completed plans with
their last commit and path, and the [backlog](../README.md) holds what they left open.

- [Module and Persona Folders](module-persona-folders.md): folders for the module list and the persona list, as their
  own records over the item lists.

When a plan is completed or retired, remove its file and active link and record it
in the archive, following the archive's procedure for the plan's open items. Use `None`
here when no plans remain active.

Before a plan-runner run schedules a plan, its decisions are read against the code and
the findings are recorded in [plan-runner audits](../reports/audits/plan-runner/README.md).
