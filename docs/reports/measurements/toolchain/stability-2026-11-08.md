# Stability of the suite and of recent fixes — 2026-11-08

What was asked: whether the steady flow of entries into the found-issues inbox means the code is unstable. Two things
were measured on `dev` at `eb7e06850`: how often a browser spec fails without a code change, and how many fix commits
repair a change that had just landed. Written into the repository on 2026-11-11 from the session's notes.

## Browser spec flake rate

- `pnpm --silent test:agent --e2e --all --force` three times in a row on one tree: 54 of 54 specs passed each time,
  10.2 to 10.4 minutes per run. No failure in 162 spec runs.
- The agent-test caches held 32 distinct e2e runs since 2026-10-23. Count them by removing duplicates of
  `node_modules/.cache/agent-test/*.json` by `finishedAt`: a worktree's cache starts as a copy of the main checkout's.
- Six of those runs failed, all on work in progress: the `perChatSends` init-script regression of 2026-10-30 and two
  deliberate red `-g` runs. None was a second run of the same tree with a different result.
- `flaky.jsonl`, where the wrapper logs a Vitest file that failed in the suite and passed alone (since `d79ca2c40`,
  2026-10-23), existed in no cache: no load flake was recorded.

## Fix commits that repair a recent change

Of the 145 `fix(` commits since 2026-10-25, 9 repaired a change that was at most four days old. None of the 145 names a
hash as its cause (the five hashes cited are the finder or a related commit), so each cause was dated with `git log -S`
on the feature's identifier.

| Cause                                                 | Fixes                                 |
| ----------------------------------------------------- | ------------------------------------- |
| Display transform recovery, `223e1fea3` (10-26)       | `f7d403a47`, `94856bdc2`, `341108f1c` |
| Display Evaluation plan, first slice                  | `a123c4596`                           |
| `keepsHeldHypaV3Data`, `492285cb6` (11-02)            | `d0e198cc3`                           |
| Reroll append-checkpoint cleanup, `30bec41a4` (11-05) | `844dab99f`, `9310bf523`              |
| Row text diffs, `917273384` (11-05)                   | `043c75e2f`                           |
| e2e init script, `634bc14c7`                          | `28b1f24f7` (test only)               |

- The gap from cause to fix was one to four days. An audit, a sweep, or a browser spec found every one; none came from
  a user report.
- Of the other 136, about 58 closed gaps inside features that themselves landed in the window (Structured Memory, job
  handoff, reroll candidates, asset lifecycle, durable drafts, the context meter), and about 79 fixed code that was
  already there or inherited: inbox entries, upstream code, dependencies, docs, hardening.

## Reading

The inbox grows with how much code a plan reads, not with how much breaks: the Module Headers run added 29 entries and
changed no behavior. To answer the question again, repeat both measurements instead of counting inbox entries.
