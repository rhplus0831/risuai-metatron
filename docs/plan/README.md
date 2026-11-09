# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Upstream Intake 2](upstream-intake-2.md): upstream `f50b5942..4d87a70ff` (53 commits) triaged into 13 port
  slices and a close-out; drafted 2026-11-10, audited; landed: 1, 7, 8.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.

Before a plan-runner run schedules a plan, its decisions are read against the code and
the findings are recorded in [plan-runner audits](../plan-runner-audit/README.md).
