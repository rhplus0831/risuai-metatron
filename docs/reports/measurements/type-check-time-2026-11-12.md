# Type check time and the result cache — 2026-11-12

What was measured: how long `pnpm check` takes with its three programs in sequence, side by side, and replayed from the
result cache, and how often a result cache would have replayed over the last seven days of agent sessions, by what its
key holds and by where it lives.

How, timings: the 24-thread (12-core) machine with one other agent session active (load average 1 to 3), 6,691 files in
the client program, the server `tsc` build info warm. The old script line and the new one ran in turn. The old line is
`svelte-check --tsconfig ./tsconfig.json && tsc -p server/tsconfig.json --incremental ... && tsc -p e2e/tsconfig.json --noEmit`.

How, hit rate: a replay of the session logs from 2026-11-05 to 2026-11-12, 482 Claude transcripts (subagents included,
the session that measured left out) and 276 Codex session logs. It takes every shell command that runs `pnpm check` or
`pnpm check:changed`, every file edit, and every commit or merge, in time order per checkout. A check's tree is the tree
of the commit made from that state, or checked out into it, when no change lies between the two (from the checkout's
reflog, the command's output, or the commit objects written while the command ran). Otherwise it is a token for the
checkout's edit state, which can only match a later check in the same checkout. A check is a hit when an earlier check
had the same key.

## Timings

| Run                                              | Wall time          |
| ------------------------------------------------ | ------------------ |
| In sequence, first run in a new worktree         | 57.8 s             |
| In sequence (`pnpm check` before)                | 42.6, 42.7, 42.8 s |
| In sequence (the old line, in turn with the new) | 42.3, 42.7, 44.5 s |
| Side by side (`pnpm check`, nothing stored)      | 33.3, 34.0, 36.8 s |
| Side by side with `--force`, and with `CI=1`     | 33.6, 33.5 s       |
| All three results replayed                       | 0.34, 0.34, 0.34 s |
| An `e2e/` edit: client and server replayed       | 6.9 s              |
| A `.svelte` edit: server replayed                | 35.8 s             |
| A `server/` edit: e2e replayed                   | 33.4 s             |

- Side by side, each program alone: server `tsc` 3.3 to 3.6 s, e2e `tsc` 7.2 to 7.7 s, `svelte-check` 33.0 to 33.9 s,
  63 s of user CPU in all. The run ends when `svelte-check` does, so the two `tsc` programs cost no wall time.
- In sequence, a failing `svelte-check` hid the other two programs. Side by side, a type error in a `.svelte` file, a
  `server/` file, and an `e2e/` file came back in one run, with exit code 1 and all three named on the last line.
- With the cache, each of those three errors was reported on the run after a full replay of the clean tree, a stored
  failure replayed as a failure, and the clean tree replayed again after the errors were reverted.
- A second worktree at the same commit replayed all three results the first one stored (0.3 s), then reported a type
  error added to its own `e2e/` file while the client and server results still replayed (7.2 s).
- The agents' own runs were slower than these: the foreground `pnpm check` calls of the week had a 59 s median, because
  several sessions share the machine.

## Hit rate of a result cache

556 type checks in seven days: 517 by Claude sessions (489 `pnpm check`, 28 `pnpm check:changed`) and 39 by Codex
agents; 375 in worktrees and 181 in the main checkout.

The logs show which commands ran, not which bytes changed, so the rate has three readings:

- Lower bound: a formatter run and any shell command that might write a file count as a change.
- Estimate: a command changes the tree only through the paths it writes (redirect targets, the arguments of
  `rm`/`mv`/`cp`/`touch`/`tee` and in-place `sed`, the files a patch names, the paths an inline script mentions, the
  files a formatter reports as rewritten). A path outside the checkout changes nothing.
- Upper bound: only commands that certainly rewrite tracked files count.

Checks that replay all three programs:

| Key and scope                                          | Lower bound | Estimate   | Upper bound |
| ------------------------------------------------------ | ----------- | ---------- | ----------- |
| Whole tree, one cache per checkout                     | 34 (6.1%)   | 50 (9.0%)  | 111 (20.0%) |
| Whole tree, one cache for all checkouts                | 35 (6.3%)   | 51 (9.2%)  | 116 (20.9%) |
| Tree without docs and Markdown, one cache per checkout | 39 (7.0%)   | 67 (12.1%) | 128 (23.0%) |
| Tree without docs and Markdown, one cache for all      | 43 (7.7%)   | 88 (15.8%) | 152 (27.3%) |

With one key per program over the files that reach it (the estimate):

| Scope                       | All three | Client     | Server      | e2e         | Wall time saved   |
| --------------------------- | --------- | ---------- | ----------- | ----------- | ----------------- |
| One cache per checkout      | 67        | 74 (13.3%) | 122 (21.9%) | 94 (16.9%)  | 40 of 310 minutes |
| One cache for all checkouts | 88        | 98 (17.6%) | 182 (32.7%) | 131 (23.6%) | 53 of 310 minutes |

- The key matters more than the place. With the whole tree as the key, a shared cache adds one hit to 50: a guide edit
  between the check and the commit, or after the merge, makes a new tree.
- With docs left out, sharing adds 21 hits to 67. In the main checkout it doubles them, 21 to 42 of 181 checks, 28 of
  them from a result another checkout stored: a branch checked in its worktree and landed on `dev` unchanged.
- Per-program keys add the checks where only `util/` or `e2e/` changed: the client program replays in 98 checks, not
  88, and those runs take the e2e program's 7 s.
- 53 minutes a week is at the idle machine's 33.5 s per run; at the week's 59 s median it is more. Running the
  programs side by side saves about 85 minutes a week (556 runs, 9.2 s each).

Limits of the estimate:

- The tree is pinned for 263 of the 556 checks. The others can only match inside their own checkout, so results from
  another checkout are undercounted.
- `pnpm check:changed` is counted as running all three programs.
- A path an inline script only reads counts as written, and a command that writes through a variable holding a
  checkout path counts as changing nothing.

## What was built

`pnpm check` and `pnpm check:changed` start the three programs together, and each program replays its stored result
when nothing it reads has changed since a run in any worktree (`util/typeCheckCache.mjs`): one key per program, docs and
Markdown left out, stored in the git common directory. `--force`, or `CI` in the environment, runs every program; the CI
script passes `--force`.

## Left open

- `svelte-check` alone is the whole wall time of a run that replays nothing. `svelte-check --incremental` reported two
  errors the normal run does not (see `util/changedChecks.mjs`), and `--tsgo` waits for TypeScript 7
  ([deferred work](../../backlog/deferred-work.md#dependency-upgrades)).
- The hit rate after the change is not measured: the cache keeps no log of replays.
- The replay script is not in the repository. Its inputs are the session logs, which exist only on the machine that
  ran the agents.
