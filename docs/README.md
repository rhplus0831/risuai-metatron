# Docs

What each folder holds, and where a new document goes. Start a code task from [STRUCTURE.md](../STRUCTURE.md), not from here.

| Folder                                    | Holds                                                              | Changes                                          |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| [structure/](structure/README.md)         | The architecture guides: how the shipped code behaves and why      | With the code; gated by `pnpm check:docs`        |
| [plan/](plan/README.md)                   | Plans being worked on                                              | Until the plan is done, then the file is removed |
| [archived-plan/](archived-plan/README.md) | The index of finished plans: last commit and path, owning guides   | One row per finished plan                        |
| [backlog/](#backlog)                      | Lists of things still to do, check, or decide                      | Entries are deleted as they are settled          |
| [reports/](#reports)                      | Dated records of something that was measured, audited, or surveyed | Written once, then left as they are              |

The split is by lifetime. A backlog file is expected to shrink; a report is a snapshot and is not kept current, so a path or line number in one may no longer exist. Guides link to reports as evidence and never rely on a report being up to date.

## Backlog

| File                                             | Holds                                                                                     | An entry leaves when                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| [found-issues.md](backlog/found-issues.md)       | The inbox: bugs, stale docs, and test gaps a session noticed outside its task, unverified | It is checked and fixed, placed, or closed |
| [known-issues.md](backlog/known-issues.md)       | Confirmed defects, one section per owning guide                                           | The defect is fixed, or the owner keeps it |
| [manual-checks.md](backlog/manual-checks.md)     | Checks that need a person, a device, a real provider, or a script nobody ran              | The check passes                           |
| [deferred-work.md](backlog/deferred-work.md)     | Work finished plans put off                                                               | It is done, planned, or dropped            |
| [open-decisions.md](backlog/open-decisions.md)   | Product questions the surveys left to the owner                                           | The owner decides                          |
| [upstream-ledger.md](backlog/upstream-ledger.md) | Every upstream RisuAI commit with its disposition, and how to run the next intake         | Never: it grows with each intake           |

[Doc Maintenance](structure/README.md#known-hazards-and-the-issue-inbox) defines how a finding moves from the inbox to known issues or a guide.

## Reports

Pick the folder by what the report examined. The first level is the kind of thing studied; the second is its scope.

| Folder                                                      | Examined                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [reports/audits/](reports/audits/README.md)                 | This repository, read for defects. The subfolder is what was read:                                         |
| [audits/codebase/](reports/audits/codebase/)                | The code across plans and subsystems: one class of defect, the whole tree, or the cause of one symptom     |
| [audits/finished-plans/](reports/audits/finished-plans/)    | The code one finished plan left, or several plans' combined result, read against the plan                  |
| [audits/plan-runner/](reports/audits/plan-runner/README.md) | A plan's text, read against the code before the plan is implemented                                        |
| [audits/guides/](reports/audits/guides/)                    | `STRUCTURE.md` and the guides, read against the source                                                     |
| [reports/measurements/](reports/measurements/README.md)     | A run of this code: timings, bytes, counts, and what a run showed. The subfolder is which side was run:    |
| [measurements/client/](reports/measurements/client/)        | The client: the built app driven in a browser, or a client module under a benchmark                        |
| [measurements/server/](reports/measurements/server/)        | The server: the process, a store, or a server-side module run by a script, with a scripted or a real model |
| [measurements/toolchain/](reports/measurements/toolchain/)  | The repository's own tools and the sessions using them: test suite, type check, build, checks, guide reads |
| [reports/surveys/](reports/surveys/README.md)               | Another project, read for ideas, and its fixes checked against this code                                   |

- A report that fits two scopes goes where its main result is, and the folder's README says so in its row. A check of this code against another project's fixes stays in `surveys/`, beside the survey that listed the fixes.
- Name a report `<subject>-<YYYY-MM-DD>.md`, dated by the day it was audited or measured. Probe scripts and raw output go in a folder beside the report, named after it.
- Add a row for a new report to its folder's README: [audits](reports/audits/README.md), [measurements](reports/measurements/README.md), [surveys](reports/surveys/README.md). The plan-runner audits are the exception: the [plan archive](archived-plan/README.md) links each one from its plan's row.
- [reports/audits/plan-runner/](reports/audits/plan-runner/README.md) holds the audit each plan gets before the plan-runner schedules it, with the procedure and its re-check list.
- A report states the commit it read. Do not edit one to follow the code; write a new report, and move anything still to be done into the backlog.
- `pnpm check:docs` measures only `structure/` and `STRUCTURE.md`. `pnpm format:check` covers everything here.
