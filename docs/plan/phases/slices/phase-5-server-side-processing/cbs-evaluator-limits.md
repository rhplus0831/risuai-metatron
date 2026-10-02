# Slice: CBS Evaluator Limits

Status: implemented (2026-10-02). Added at Phase 5 Stop C by the owner's decision: server CBS gets a
step and output limit in its own small slice before Stop D.

Phase: [Phase 5](../../phase-5-server-side-processing.md), the Safety Contract.

Depends on: `cbs-and-regex-services`, `lua-bindings-and-buttons` (the job CBS host),
`prompt-assembly`.

## Problem

Every server CBS evaluation runs the shared evaluator on the main thread. Before this slice a
non-progressing `{{range::[0,1,0]}}` blocked the event loop for ever, and a Lua run waiting on it
(`Atomics.wait`) could not be interrupted by its budget. Measured before the change (Node 24, this
machine): plain text scans at about 80 ns per character; 20,000 `#each` blocks in 520 KB took 5.3 s
(the splice copies the text); 200,000 unmatched `{{` took 4.9 s (`unshift` moves the stack); 20,000
misses of `{{getvar}}` against 3,000 default variables took 12.9 s (the host parsed the defaults per
miss); 200,000 blank lines in a `#when` took 2.4 s inside one loop iteration; `filter::unique` on
200,000 elements took 18.9 s; a `{{calc}}` of 20,000 variables took 13.0 s.

## What landed

- `shared/cbs/limits.ts`: `CbsLimits` (`maxWork`, `maxMs`, an optional `total` allowance shared
  through a `CbsUsage`, `now`), `CbsLimitError`, the budget functions, and `replaceAllBound`.
- `shared/cbs/evaluator.ts`: `CbsHost.limits` (optional). With limits, a top-level
  `risuChatParser` call starts a budget its nested parses share:
  - one unit per scanned character and per character a function returns; a text longer than the
    work left is refused before the scan;
  - the stack moves of a `{{` push and of the unfinished-syntax drain (`depth >> 8`), each `#each`
    piece and each `call::` substitution before it is built (`replaceAllBound`), the `#each` splice
    (`length >> 7`), the text of a `#pure_display` block before its braces are escaped;
  - the clock at every `{{` and `}}`, after every function, after an `#each` splice, at least every
    4,096 units, and before a parse returns; a result longer than the work limit is refused.
  - The matcher's `catch` rethrows `CbsLimitError`.
  - For both runtimes: the blank lines at the ends of a `#when` block are dropped by index instead
    of `shift`/`pop` in a loop (the same result, linear).
- `shared/cbs/registry.ts`: `CBSRegisterArg.spend` (the evaluator supplies it; a no-op without
  limits). Charges: `range` 16 units plus the element's text per element; `dice`, `roll`, `rollp` a
  unit per roll; `cbr` the repeated length before `repeat`; `replace` its result bound (with the
  arguments as `replaceAll` coerces them; the bound is counted only by an evaluator with limits);
  `join` the separators; `filter` (`all`, `unique`) each `indexOf` by how far it went, over 64;
  `bkspc`/`erase` the output read over 128.
- The server host's `calcString`: one calculation reads a variable once and hands the calculator
  its number (a 36 KB expression naming a 1M-digit variable 12,000 times took 11.5 s before). The
  shared calculator is unchanged.
- `server/src/jobs/cbsHost.ts`: `serverCbsLimits(usage)`: 10,000,000 units and 5 s per top-level
  parse, 60 s of evaluation per job. The default variables are parsed once per source text (the
  `getvar` and calculator cases above become linear). The unused `createJobCbsEvaluator` is gone.
- `server/src/jobs/runSetup.ts`: `JobRunState.cbsUsage`, passed to every run setup of the job, so
  the input stage and each speaker share one allowance.
- `server/src/lua/bindings.ts`: the run's evaluator is wrapped before anything closes over it. A
  `CbsLimitError` becomes the job's latched `LuaJobFatalError`, with the chat owner's name; an
  evaluation after a fatal failure raises that failure.
- `server/src/prompt/triggers.ts`: the effect loop yields a turn once it has held the thread 50 ms,
  then fences.

After the change, with the server limits: the stuck `range` ends in 38 ms, `range::[5000000]` in
62 ms, 100M dice in 0.3 s, 2M unmatched `{{` in 0.3 s, 20,000 `#each` blocks in 0.8 s,
`filter::unique` in 0.7 s, each with `CBS limit reached`; the `getvar` misses take 36 ms and the
calculator 31 ms and finish. On the ordinary rows (5M and 9M plain characters, 100,000 `{{char}}`,
2,000 `#each` blocks, a 600 KB `history::role`, an `#each` over 100,000 range elements, the blank
lines, `bkspc`, a `#func` fan-out) the bounded and unbounded results are identical by hash, and the
bounded run is within noise of the unbounded one (348 ms against 332 ms for 5M characters).

Live check (a fresh server, the flag on, a character whose description holds
`{{range::[0,1,0]}}`): the send ends after about 1.1 s with
`CBS limit reached: one template took more than 10000000 steps (<character>)`, no provider request is
made, reads from another connection during it answer in 3 to 57 ms, the user message stays stored (a
failed job does not roll back its earlier writes), and the next send to another character gets its
reply.

## Plan review (GPT-6-Astra, 17 points) and decisions

1. Wrap the local evaluator, not only the exported property: **adopted**.
2. End the job with a latch; fence before evaluation; name the card: **adopted with a change**: the
   message carries the chat owner's name, not the stage (the wrapper does not know it).
3. Quadratic paths the checkpoints miss (`filter`, the drain loop, empty `#each` iterations,
   `bkspc`/`erase`): **adopted**, by charging the existing algorithms.
4. The calculator and its direct entry: **adopted with a change**: the cause was the per-miss parse
   of the default variables, removed in the server host; the calculator is then linear in its
   input, so it gets no budget of its own (`v2Calculate` calls it outside an evaluation).
5. Charge before allocation: **adopted** for the amplifying operations, and the scope is stated as
   cooperative limits, not a heap bound.
6. Budget arithmetic and the clock: **adopted** (a charge that is not a positive number counts
   nothing, limits are validated, threshold crossing, the clock after every function and before a
   return, `finally`).
7. The numbers are policy: **adopted**; `range` charges its text and 16 units per element; the work
   limit went from the planned 20M to 10M after the memory measurement (a 9M-character text peaks
   near 460 MB of RSS). An explicit element cap and a Docker RSS run are **not added**: the work
   charge is the cap, and the image runs the same Node.
8. The history calibration fixture was wrong: **adopted**; the headroom argument is now large inline
   data in card text, and the benchmark uses a valid `history::role`.
9. A cumulative limit and yields: **adopted with a change**: a 60 s allowance per job and a timed
   yield in the native effect loop. Prompt assembly does not yield between evaluations (recorded as
   a hazard).
10. Per job, not per evaluator: **adopted** (`JobRunState.cbsUsage`).
11. Browser parity: **adopted**; the blank-line rewrite stays because its result is the same.
12. Other main-thread work: **adopted** as recorded hazards (`self-host-server.md`).
13. Both the Challenge and the Fable review: **adopted**.
14. to 17. Testing advice: judged necessary and passed to the Fable reviewer, except the Docker RSS
    run of point 16.

## Challenge (GPT-6-Astra)

Ten points. No result changed on the path without limits (6,626 differential cases against the
previous evaluator, and 21,178 calculator expressions); nested accounting, the reset after an
exception, the job allowance, the latch through a Lua `pcall` and a regex script's host call, and
the timed yield held in its probes. Fixed:

- the calculator read and converted a variable once per reference (finding 1; fixed in the server
  host's `calcString`: round 2 found that a memo inside the shared `calc.ts` changed the result for
  a host whose answers change between two references and lost a getter's `this`, so `calc.ts` is as
  it was);
- a `#pure_display` block returned more than the work limit (finding 2; charged, and a result
  longer than the limit is refused);
- `replaceAllBound` counted every `$` as the whole text, so a small `replace` with a literal `$5`
  was refused (finding 3; the bound follows the replacement tokens);
- `replace` without its third argument was not charged before it allocated (finding 4);
- `filter` charged the square of the length even for a list of duplicates (finding 6; each search is
  charged by how far it went).

Recorded, not changed (finding 5): `split` and `history` build their whole result before it is
charged.

## Residual risk

The limits are cooperative: not a hard deadline and not a heap bound (`self-host-server.md`, Known
Hazards). The browser path has no limit.
