# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) indexes completed plans with
their last commit and path, and the [backlog](../README.md) holds what they left open.

- [Lore Budget Send Stop](lore-budget-send-stop.md): a chat-screen send stops before the model request when the
  lorebook token limit leaves an activated entry out, and a dialog offers to turn the warning off for the chat or to
  change the limit. Drafted and audited 2026-11-13; one decision (D19) waits for the owner; no slice landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive, following the archive's procedure for the plan's open items. Use `None`
here when no plans remain active.

Before a plan-runner run schedules a plan, its decisions are read against the code and
the findings are recorded in [plan-runner audits](../reports/audits/plan-runner/README.md).
