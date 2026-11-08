# Plan-Runner Audits

Before the plan-runner skill schedules a plan's slices, a read-only Sol session reads the
plan against the code and the orchestrator writes its findings here as
`<plan-basename>-<YYYY-MM-DD>.md`: the plan path, the commit audited, the mode (`full`, or
`shared-files` for the slices' file lists alone), the model, a P1/P2/P3 count table, and the
findings by severity. P1 is a decision that cannot work as written against the code or loses
data; P2 a contradiction inside the plan or a wrong claim that changes a decision; P3 a stale
anchor, wording, or an unacknowledged file overlap; `unverified` is a claim the auditor could
not settle. The plan-runner halts on a P1 until the user revises the plan or chooses to run
anyway, and quotes the rest in the affected slice briefs.

A report is a snapshot of the plan at that commit. It stays here when the plan is revised,
runs, or retires; a plan revised after its report gets a new one on its next run. The
2026-11-04 design audit of five plans, which this folder's procedure grew out of, is in
[manual-audit](../manual-audit/archive/plan-design-audit-2026-11-04.md).

`pnpm check:docs` does not measure this folder; `pnpm format:check` does.
