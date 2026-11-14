# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) indexes completed plans with
their last commit and path, and the [backlog](../README.md) holds what they left open.

- [Generation Progress Window](generation-progress-window.md): a top-right window lists every generation job running
  on the server with its stage, elapsed time, and, while the model streams, the tokens generated and the speed, on
  every client; Half Streaming gives the count with Response Streaming off. Drafted and audited 2026-11-14; no slice
  landed.
- [OOC Session](ooc-session.md): a side thread for out-of-character questions about a chat, with its own toggle
  values, a refresh, and attachable earlier exchanges. Drafted and
  [audited](../reports/audits/plan-runner/ooc-session-2026-11-14.md) on 2026-11-14; no slice has started.

When a plan is completed or retired, remove its file and active link and record it
in the archive, following the archive's procedure for the plan's open items. Use `None`
here when no plans remain active.

Before a plan-runner run schedules a plan, its decisions are read against the code and
the findings are recorded in [plan-runner audits](../reports/audits/plan-runner/README.md).
