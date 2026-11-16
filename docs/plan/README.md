# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) indexes completed plans with
their last commit and path, and the [backlog](../README.md) holds what they left open.

- [Headless Host](headless-host.md): a package script that keeps a headless Chrome connected as a remote host.
  Drafted and [audited](../reports/audits/plan-runner/headless-host-2026-11-16.md) on 2026-11-16; slices 1 and 2 have landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive, following the archive's procedure for the plan's open items. Use `None`
here when no plans remain active.

Before a plan-runner run schedules a plan, its decisions are read against the code and
the findings are recorded in [plan-runner audits](../reports/audits/plan-runner/README.md).
