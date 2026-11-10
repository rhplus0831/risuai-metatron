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
| [open-decisions.md](backlog/open-decisions.md)   | Product questions the surveys left to the owner                                           | The owner decides                          |
| [upstream-ledger.md](backlog/upstream-ledger.md) | Every upstream RisuAI commit with its disposition, and how to run the next intake         | Never: it grows with each intake           |

[Doc Maintenance](structure/README.md#known-hazards-and-the-issue-inbox) defines how a finding moves from the inbox to known issues or a guide.

## Reports

Pick the folder by what was studied:

| Folder                                         | Studied                                                  | Examples                                               |
| ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| [reports/measurements/](reports/measurements/) | A run of this code: timings, bytes, token counts         | boot measurements, guide reads, render work budget     |
| [reports/audits/](reports/audits/)             | This repository's code, plans, or docs, read for defects | static audit, plan design audits, the full guide audit |
| [reports/surveys/](reports/surveys/README.md)  | Another project, read for ideas                          | the fork surveys, the community memory systems         |

- Name a report `<subject>-<YYYY-MM-DD>.md`. Probe scripts and raw output go in a folder beside the report, named after it.
- [reports/audits/plan-runner/](reports/audits/plan-runner/README.md) holds the audit each plan gets before the plan-runner schedules it, with the procedure and its re-check list.
- A report states the commit it read. Do not edit one to follow the code; write a new report, and move anything still to be done into the backlog.
- `pnpm check:docs` measures only `structure/` and `STRUCTURE.md`. `pnpm format:check` covers everything here.
