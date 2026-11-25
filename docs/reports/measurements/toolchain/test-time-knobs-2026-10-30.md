# Vitest settings tried for a shorter gate — 2026-10-30

What was measured: whether a Vitest setting shortens the gated suite, during the work that added the whole-suite lock
(`0ddd844fb`; its own timings are in [test suite lock](test-suite-lock-2026-10-30.md)). Written into the repository on
2026-11-11 from the session's notes; the exact commit of each trial was not kept.

## Why the gate's time mattered

- Session transcripts showed 886 whole-suite runs across 263 sessions, more than the filtered runs: two to six per
  session, mostly from parallel worktree slices. `pnpm check` ran about 2,600 times.
- Each worktree has its own `node_modules/.cache/agent-test`, so the main checkout's cache replayed about 4% of runs.

## Settings ruled out

| Setting                  | Result                                                         |
| ------------------------ | -------------------------------------------------------------- |
| Worker count             | No change: the suite is compute-bound                          |
| `--pool=threads`         | 88 files fail                                                  |
| `--no-isolate`           | 49 files fail                                                  |
| The dependency optimizer | 6 s saved, one file breaks                                     |
| `vitest related`         | 16 s floor; hub modules reach half the suite from most changes |

## Left open

- One stack per Playwright worker is the remaining lever for the browser specs. It was proposed and not built.
- Browser specs share one store in file order, so a later spec's failure can be an earlier spec's leftover: the
  `perChatSends` spec left `useAutoSuggestions` on for the specs after it (fixed in `28b1f24f7`).
