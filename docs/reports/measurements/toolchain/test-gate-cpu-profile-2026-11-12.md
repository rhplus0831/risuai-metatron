# Where the gate's time goes — 2026-11-12

What was measured: which kinds of work the gated suite's CPU time goes to, and what four changes saved. It continues
[Vitest settings tried for a shorter gate](test-time-knobs-2026-10-30.md).

How: `pnpm --silent test:agent --force` on the 24-thread (12-core) machine, 602 files and 10,296 tests, with the default
reporter for the phase split and once with `--execArgv=--cpu-prof` in every test process (601 profiles, self time summed
by the file and function of the leaf frame). Wall times are single runs or the two runs shown; the profiler adds about
10 s to a run.

## The starting point (commit `219855897`)

- 84.7 s wall, 23 m 26 s user and 4 m 23 s system CPU: about 19 threads busy for the whole run, so the suite is
  compute-bound and only less work shortens it.
- Vitest's phase split: tests 55%, transform 18%, import 15%, environment 10%, setup 2%.
- Vitest's main process uses 30 to 50% of one core during the run. It is not the bottleneck.

Self time of the test processes (1,463 busy CPU-seconds sampled):

| Kind of work                                             | Share |
| -------------------------------------------------------- | ----- |
| Loading and compiling modules (the runner, `node:vm`)    | 31%   |
| Product code (`server/` 9.5%, `src/` 5.5%, `shared/` 2%) | 17%   |
| Node internals (fs, crypto, streams, child processes)    | 13%   |
| Native code (SQLite and similar)                         | 9%    |
| Garbage collection                                       | 6.5%  |
| Svelte runtime                                           | 6%    |
| Vitest runner                                            | 5.6%  |
| Tokenizer wasm                                           | 3.5%  |
| `expect` deep equality                                   | 2.5%  |
| happy-dom                                                | 2.4%  |

Module loading splits in two. Every file pays about 0.57 s of it (about 20% of all CPU), which is what per-file
isolation costs. The 95 files that call `vi.resetModules()` pay 2.1 s each, about 150 CPU-seconds more in total.

## What a module reset costs

Measured in a probe with the storage tests' mocks: one `vi.resetModules()` plus the nine imports of the storage tests'
`boot()` takes 36 to 46 ms on an idle machine and re-evaluates 310 modules.

| Modules re-evaluated   | Count | Self time |
| ---------------------- | ----- | --------- |
| `src/ts`               | 117   | 21.2 ms   |
| Svelte (the package)   | 110   | 9.6 ms    |
| `shared/`              | 39    | 4.5 ms    |
| Other packages, `src/` | 44    | 1.2 ms    |

## What was changed, and the gate after each

| Change                                                                             | Gate (wall)    | User CPU  |
| ---------------------------------------------------------------------------------- | -------------- | --------- |
| Starting point                                                                     | 82.8 to 84.7 s | 23 m 26 s |
| Byte-wise matchers and letter-run fixtures in four server test files (`a5d714101`) | 79.9, 80.8 s   | 22 m 12 s |
| `vi.resetModules()` keeps packages evaluated (trial)                               | 76.7, 77.8 s   | 20 m 59 s |
| `vi.resetModules()` keeps packages and `shared/` evaluated (trial)                 | 75.6, 75.8 s   | 20 m 32 s |
| The same as `vitest.resetModules.ts`, with the full reset after `vi.doMock`        | 75.7, 75.6 s   | 20 m 33 s |

- Byte-wise matchers: `expect(buffer).toEqual(buffer)` walks a Buffer byte by byte. One parameterized case of
  `server/src/tests/snapshots.test.ts` spent 20.4 of the suite's 26.2 CPU-seconds of deep equality comparing a database
  file.
- Letter runs: tiktoken's `o200k_base` takes 53.9 s for 193 KiB of one repeated letter and 0.11 s for the same bytes as
  two-byte words; 100 KiB of one letter takes 3.7 s; a run of digits is fast. One case of
  `server/src/tests/promptRunner.test.ts` spent 9.7 of its 11.9 s there.
- Both trials passed all 10,296 tests, and the final code those and its own 13.

## Tried and not kept

| Trial                                                               | Result                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| Node's on-disk compile cache (`NODE_COMPILE_CACHE`)                 | 84.7 s to 82.0 s: it does not cover the runner's modules |
| Moving the next-heaviest tests to test-only limits or the slow tier | Not done: each does under about 1.5 s of real work       |

## Left open

- Per-file isolation is the largest remaining share (about 20% of CPU). Vitest's own estimate is at least 11.5 s with
  `isolate: false`; the earlier trial had 49 files fail, and a second project that isolates only those was not tried.
- A reset still re-evaluates 117 `src/ts` modules. Fewer would need a state reset in the client stores instead of a
  re-import.
