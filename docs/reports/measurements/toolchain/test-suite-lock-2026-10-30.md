# Test suite lock and e2e settle timing — 2026-10-30

What was measured: how the gated test suite scales when several runs share a machine, and what share
of a full e2e run the specs' fixed sleeps took.

How: whole gated-suite runs started alone and at the same time on a 24-core machine, also with
`--maxWorkers=8` (commit `0ddd844fb`, which added the whole-suite lock); full e2e runs before and
after `settle` on one machine (commit `bbea97ab8`).

Gated suite, 24 cores:

| Runs at once | Time each |
| ------------ | --------- |
| 1            | 70 s      |
| 2            | 123 s     |
| 3            | 183 s     |

The times are the same with `--maxWorkers=8`, so the suite is compute-bound, and queued runs finish
one after another in the single run's time.

Full e2e run:

- The specs' fixed 2.5 to 3 s sleeps past the 500 ms save debounce were about 40% of a full e2e run.
- With `settle` the full suite went from 11.4 to 7.3 min on the same machine.
