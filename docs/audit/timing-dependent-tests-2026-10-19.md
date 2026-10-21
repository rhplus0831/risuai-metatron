# Timing-dependent tests in the gated Vitest suite (2026-10-19)

Static inventory of the tests in the default run (`vitest run --tags-filter=!slow`) that depend on
real wall-clock time, CPU time or the scheduler. It gives a disposition for each spot under the rule
being adopted: a gated test must not depend on real time. Such a test is rewritten with a controlled
clock or deferreds/latches, or it moves to the slow tier. A test is deleted only when no plausible
wrong implementation would fail it.

Background: on 2026-10-18 fifteen load-sensitive spots were fixed under five causes (commits
3e1bb3985, 2cc6c51f1 and others). A new report says some tests still fail when the CPU is overloaded.
The reference overload is the handover recipe: one CPU, eight `node -e "while(true){}"` burners,
`--maxWorkers=3`. Under it the process runs at about 1/9 of a CPU and can be descheduled for 1-3 s
at any instant.

## Method and limits

- Scope: every `*.test.ts` from `rg --files | rg '\.test\.ts$'` (honors `.ignore`; `.claude/worktrees`
  never read). That is 378 files. Three whole-file slow-tagged files are out of scope
  (`importPngCaps`, `tokenPlainNode`, `diagnosticsCrash`), as is every test tagged `slow`
  (listed in the appendix).
- Candidates: 225 files matched at least one of `performance.now`, `Date.now`, `setTimeout`,
  `setInterval`, `setImmediate`, `toBeLessThan`/`toBeGreaterThan`, `timeout`, `waitFor`,
  `expect.poll`, `useFakeTimers`, `spawn`/`fork`/`execFile`/`child_process`, `new Worker`, worker
  pools, `delay(`/`sleep(`. Ten reviewers each read one share in full, following one rubric (kinds,
  dispositions, Vitest 4.1.11 fake-timer facts). They read the surrounding test, its helpers
  (`server/src/tests/testSupport.ts` and others) and the production code it reaches, to decide
  whether the clock was really controlled. Vitest 4.1.11 facts used: a bare `vi.useFakeTimers()`
  fakes `Date` and `performance` too; a `toFake` list without `"Date"` leaves `Date.now` real;
  `vi.waitFor`/`expect.poll` keep a real 1 s cap even under fake timers; fake timers never reach
  worker threads or child processes.
- The cold-module-graph class came up in some shares but not others. To make it uniform, the
  orchestrator also timed the first test of each remaining file that runs `vi.resetModules()` plus a
  dynamic import of the storage graph inside the test. Each file was run once, alone, on an idle
  machine (`pnpm --silent test:agent --force <file> --reporter=json`). Those 27 rows are marked
  "Added by the orchestrator". Durations quoted in rows are idle, single-file numbers. In a full
  run, Vite's transform cache is shared across files, so the first-test cost is lower there; the
  overload multiplies whatever remains.
- Nothing was run under artificial load. "Risk" in each row is the reviewer's estimate of failure
  under the overload above: high, med-high, med, low-med, low, none.
- Not read: the 148 files with no candidate pattern and no in-test module boot. A test can still
  depend on time through production code it reaches without naming a timing API. Two such paths are
  called out below: the client CBS wall limit and the resourceSync `Date.now` backoff. The audit
  found no others.
- A `keep-det` row records a candidate that was checked and found controlled, so the count is
  honest. Aggregated rows (one row covering several lines) count once.

Disposition codes: `keep-det` (already controlled: a false positive), `keep-poll` (a bounded
poll on in-process work only; the 1-2 s cap is the only real-time element), `keep-accepted` (real
time with a deliberately large margin, stated in the row), `rewrite:<how>`, `move-slow`, `delete`.

## 1. Summary

Rows: **395** spots in **189** files.

### By dependency kind (primary kind of each row)

| Kind      | Meaning                                                                                        |    Rows | of which keep | rewrite | move-slow | delete |
| --------- | ---------------------------------------------------------------------------------------------- | ------: | ------------: | ------: | --------: | -----: |
| DUR       | duration assertion on elapsed real ms                                                          |      17 |             2 |      14 |         1 |      0 |
| PERF      | absolute performance threshold (incl. heavy work whose only budget is the default 5 s timeout) |      24 |             2 |      20 |         2 |      0 |
| SLEEP     | sleep/tick used as synchronization                                                             |      75 |            44 |      28 |         1 |      2 |
| POLL      | bounded poll with a real-time cap (vi.waitFor, expect.poll, testSupport.waitFor)               |      87 |            47 |      38 |         2 |      0 |
| CLOCK     | real performance.now()/Date.now()/ELU feeding a budget, deadline, TTL or throttle              |     109 |            78 |      30 |         1 |      0 |
| TMO       | Vitest timeout bump (heavy work raced against the wall clock)                                  |      39 |            26 |      12 |         1 |      0 |
| BOOT      | worker / child process / server / cold module graph boot inside a timed region                 |      44 |             1 |      36 |         7 |      0 |
| HEAP      | heap/GC-dependent assertion                                                                    |       0 |             0 |       0 |         0 |      0 |
| **Total** |                                                                                                | **395** |       **200** | **178** |    **15** |  **2** |

### By disposition

| Disposition              |    Rows | high or med-high risk |
| ------------------------ | ------: | --------------------: |
| keep-det                 |     108 |                     0 |
| keep-poll                |      42 |                     0 |
| keep-accepted            |      50 |                     0 |
| rewrite:fake-timers      |      15 |                     4 |
| rewrite:injected-clock   |       7 |                     1 |
| rewrite:deferred         |      35 |                    14 |
| rewrite:call-through-spy |       2 |                     1 |
| rewrite:raise-timeout    |      20 |                     7 |
| rewrite:other            |      99 |                    47 |
| move-slow                |      15 |                     7 |
| delete                   |       2 |                     0 |
| **Total**                | **395** |                **81** |

### By risk under overload (as stated in each row)

| Risk      |    Rows |
| --------- | ------: |
| high      |      65 |
| med-high  |      16 |
| med       |      62 |
| low-med   |      20 |
| low       |     171 |
| none      |      61 |
| n/a       |       0 |
| **Total** | **395** |

File accounting: 378 test files = 225 candidates read by reviewers + 2 non-candidate files given orchestrator cold-boot rows (`bootSnapshot`, `stores.importOrder`) + 148 not read + 3 whole-file slow. Of the 227 read, 189 have rows and 38 have none.

### Cross-cutting causes (the fix pass should work by cause, not by row)

Each cause below has one fix that covers many rows. The row lists in section 2 carry the detail.

1. **Cold module graph inside the test's timeout (about 50 client files, the largest class).**
   The file calls `vi.resetModules()` and then `await import(...)` of `resourceSync.svelte`,
   `bootstrap`, `chatStore.svelte` and so on. This happens inside the first test (default 5 s) or
   in `beforeEach` (default 10 s hook timeout). Measured first tests take 1.5-3.75 s when idle,
   and the later re-evaluations 50-500 ms. This is the cause the 2026-10-18 fix met in
   `resourceSyncFieldCache` (60 s needed under the overload), still present in every sibling.
   - Fix: `beforeAll(() => import(<the graph>), 60_000)`, which `characterCardsPngImport`,
     `charactersImportChat`, `personaImport`, `exportBatches`, `modulesImport`,
     `lorebookRegexBaseline` and `chatProjection` already do. That moves the cold transform out of
     every timed test. The later per-test `resetModules` re-evaluations stay, at about 0.05-0.5 s
     idle.
   - One shared warm-up helper next to `bootMutations` (`src/ts/storage/tests/mutationStoresHarness.ts`)
     would cover most of them.
2. **`testSupport.waitFor` (server).** Its deadline is `Date.now() + 2000` and it polls on a real
   10 ms `setTimeout`. After a long deschedule, its timer fires in the timers phase, re-checks the
   condition before the poll phase has delivered the pending socket/fs callback, sees the deadline
   passed, and throws.
   - Reach: 31 actionable rows in 19 files (events, generations, generationMetadataEvents,
     generationDeltaChunks, chatMetadataCoalescingEvents, jobChannel, llmRoutes, promptRunner,
     promptTail, assets, diagnostics, importRealm, importModule, importCharx, backups, proxy,
     snapshots, shutdown, and others).
   - Fix: drop the wall deadline, or wait on the event itself, and let the test timeout catch
     hangs. A cheaper half-fix: before throwing, yield once with `setImmediate` and re-check.
   - Two related helpers: `follow()` in `generations.test.ts:185` and the owner socket in
     `generationDeltaChunks.test.ts:185` close themselves after 4 s of real time, which can drop
     late `done` frames.
3. **Worker budgets measured on real time.**
   - The pool charges Lua CPU as the worker's `eventLoopUtilization().active`, which is wall time
     while busy, including time descheduled. The watchdog (`cpuMs + 1000 ms`) and `ABORT_GRACE_MS`
     (500 ms) are fixed constants. Regex tasks have a 1000 ms main-thread wall deadline
     (`DEFAULT_REGEX_DEADLINE_MS`). HypaV3 chunking has a real 5000 ms budget.
   - Affected: `scriptWorker` (the `cpuMs: 100` tests have 25-100 ms of slack), `regexScriptsTask:144`,
     `manualTriggers` "six regex sites", `luaBindings`, `promptRunner` editinput, and
     `hypaV3Limits:262`.
   - Fix: make the watchdog grace and abort grace pool options. Give `createTestServer` /
     `createScriptWorkerPool` large test budgets where the budget is not the subject. In tests whose
     subject is the budget, assert relative invariants (`ms - cpuMs >= wait`, `usedMs == sum`)
     instead of absolute slack.
4. **Fresh Node processes in the gated tier.** The slow tag's own description names fresh Node
   processes, yet these are untagged: `shutdown.test.ts` (whole file),
   `sharedImports.test.ts:26`, `hypaV3Limits.test.ts:107`, `cbsLimits.test.ts:663`,
   `scriptWorker.test.ts:1238`, `llmCharsetRetries.test.ts:195`, `luaRuntime.test.ts:392`, and
   `transformers.test.ts:513` (a real `fork` with a 150 ms idle kill). Disposition: `move-slow`.
   `cbsLimits:663` could instead be deleted, since 308-317 cover the same case in process.
5. **Short real production timers raced by in-process work.**
   - `translate.test.ts` (six tests ride the Echo model's real 300 ms sleep: high).
   - `importRealm.test.ts:846` (a commit must beat a real 200 ms staging TTL), plus 838 and 1014.
   - `proxy.test.ts:121` (100 ms proxy timeout).
   - `bootCache.test.ts:891` (a 20 ms timeout plus an elapsed < 1000 ms check) and the 3000 ms
     `BOOT_CACHE_TIMEOUT_MS` in about 19 tests.
   - `chatMetadataCoalescingEvents.test.ts:447` and `manualTriggerMetadata.test.ts:147`: the
     trigger effect loop yields on a real 50 ms `performance.now` window that the job runner never
     injects (`triggers.ts:264`, `runSetup.ts`), so a stall splits one coalesced write into two.
   - `storedTranslation.test.ts:460` (production 100 ms `SYNC_POLL_MS` against `vi.waitFor`'s 1 s).
   - Fix: inject the timer or clock (a staging `expire()` hook, `host.now` through the runner) or
     hold the provider on a latch.
6. **Pure duration assertions.** `mcp.test.ts:404,587`, `luaRuntime.test.ts:189,292`,
   `bootCache.test.ts:894`, `scriptWorker.test.ts` 282-366/951 (`ms < 3000/4000/7000`),
   `shutdown.test.ts:214`, `promptRunner.test.ts:720`, `triggerRuntime.test.ts:1408`,
   `cbsLimitsJobs.test.ts:377`. Most catch nothing that the terminal check or the Vitest timeout
   misses. Drop them, or use fake timers where the deadline is plain `setTimeout`.
7. **Fake timers without `"Date"` against resourceSync's real `Date.now`.** `backoffUntil`,
   `timerDeadline` and the job-retry block read the real clock. Most harnesses are safe only
   because they flush explicitly.
   - Real cases: `resourceSyncMerge.test.ts:596,684` and `resourceSyncRecreation.test.ts:326`.
   - Fix: add `"Date"` to the harness `toFake` lists, as `resourceSyncNotices`, `resourceSyncLive`
     and `resourceSyncFeedPatches` already do.
8. **Wall-clock complexity guards.** `mcp.test.ts:1026` (8 MiB in < 5 s), `mcpSse.test.ts:127`
   (80k events in < 3 s), `projectionBindings.test.ts:2015` (tracked/direct ratio < 10), and the
   100k-item cases left after the 2026-10-18 deletions (`moduleCache:297`, `assetList:145`), whose
   only budget is now the default 5 s timeout. Count the work (bytes scanned, copies) instead,
   shrink the fixtures, or move the case to slow.
9. **Not overload failures (lower priority).** About 23 rows (by keyword) are `sleep(n)` windows before a
   negative check ("nothing more happened"). Overload makes them pass vacuously; it never makes
   them fail. They are marked `keep-accepted` or `rewrite:deferred` where a latch would make the
   check meaningful. Two are `delete` (`backups.test.ts:1270`, `memoryJobs.test.ts:796`): the
   sleep follows a synchronous state change or an awaited abort, so no wrong implementation fails
   because of it.

Not found: no heap/GC-dependent assertion (`HEAP` = 0). Static context for the client CBS wrapper:
it keeps a real `performance.now` 2 s per-template wall limit (`CLIENT_CBS_LIMITS`), and the server
job host keeps 5 s. Any gated test that runs real `risuChatParser` could hit `CbsLimitError` on a
2-5 s deschedule inside one parse. This is unlikely for the tiny templates used, and only
`limits.test.ts` stops the clock.

## 2. Per-spot list, grouped by file

Each spot: **lines** in the current file, test (short), kind (primary/secondary), whether the clock
is controlled, **disposition**, risk under overload, reason. Files modified by heap-memory-reduction
and files fixed on 2026-10-18 are tagged in their headings.

#### `server/src/tests/app.test.ts`

- **268-292** "allows 2000 storage requests then returns draft-6 headers": PERF, controlled: partial. **rewrite:other(inject a small storage limit through createServerContext and exhaust that; keep one header check of the 2000;w=60 policy)** (risk: high). Date.now is frozen, but 2000 in-process requests with fs reads take 1.2 s idle against the default 5 s timeout; at 1/9 CPU share it times out. Risk: high
- **197-198** "limits /api/login to 10 attempts per window": CLOCK, controlled: no. **rewrite:fake-timers** (risk: med). Retry-After /^(29|30)$/ reads the real Date.now in rateLimit.ts; a stall of more than 2 s between the first attempt and the blocked one gives 28. The sibling 2000-request test already spies Date.now. Risk: med

#### `server/src/tests/assemble.test.ts`

- **296,338,357,369** "assembles the ${name} fixture's prompt" / "picks the presetChain preset" / "renders the jinja fixture's previewPrompt": TMO, controlled: no. **keep-accepted** (risk: low). Real server + default runner (lazy script-worker boot, regex scripts under the ELU-based 5000+1000 ms runScripts budget) raced against a 45 s socket cap and SLOW=60 s timeout; margin ~10x the normal run; risk low

#### `server/src/tests/assets.test.ts`

- **191-198** "stages incoming bytes and lets maintenance begin while the next record body is paused": POLL, controlled: partial. **rewrite:deferred** (risk: med). server testSupport waitFor (2 s real Date.now cap, 10 ms real poll) on real async fs staging writes through the batch route; after a >2 s deschedule the poll timer runs in the timers phase before the fs completion callbacks and the helper throws without a final re-check; risk med
- **204** "stages incoming bytes ... maintenance begin" (entered): POLL, controlled: yes. **keep-poll** (risk: low). waitFor(() => entered) on withMaintenance's in-process exclusive/listener promise chain only (no I/O); risk low

#### `server/src/tests/auxOps.test.ts`

- **114** "broken" upstream (res.destroy after 20 ms): SLEEP, controlled: yes. **keep-det** (risk: none). the destroy follows the written chunk whatever the delay; no proxy timeout without risu-timeout-ms; real loopback server, light work; risk none

#### `server/src/tests/backups.test.ts`

- **143** "lists the completed snapshots newest first": CLOCK, controlled: partial. **keep-accepted** (risk: low). sleep(2) keeps two snapshotNow() ids (stamped from real new Date(), sorted by id) in distinct ms; load only widens the gap, never shrinks it (risk: low)
- **289,291** "refuses a restore queued behind another one with 412": POLL, controlled: no. **rewrite:call-through-spy** (risk: med). testSupport.waitFor has a 2 s Date.now deadline, polling until each restore (JWT signed via WebCrypto threadpool, then routed) reaches snapshots.track; a >=2 s deschedule makes the 10 ms timer fire before the I/O completes and it throws; resolve a deferred from the track spy instead (risk: med)
- **381,383** "lets an asset removal admitted before a restore finish before the restore runs": SLEEP, controlled: no. **rewrite:call-through-spy** (risk: high). sleep(30) then a POSITIVE assert gate.active === true: needs the restore request (JWT sign + route + withMaintenance) to reach the gate within 30 ms real; await a deferred resolved by a track/withMaintenance spy, or poll gate.active with no deadline (risk: high)
- **340,567,610,615,655,1281** "answers 503 ... reads stay open" / "removes the staging copy once" / "cleans up an export the client abandoned" / "finalizes only after the staging folder exists" / "refuses restore, import, and export with 503": SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(20) then a negative check (still null, one rm, stopped false, tmp empty); load only makes a buggy impl more likely to slip through, a correct one never fails; 340 could instead wait for the track spy before asserting the restore is still queued (risk: low)
- **1270** "refuses restore, import, and export with 503 once dispose has begun": SLEEP, controlled: partial. **delete** (risk: low). sleep(10) after context.dispose() is unneeded: dispose() calls beginShutdown() synchronously before the 503 requests; no wrong implementation is caught by the extra 10 ms (risk: low)
- **555,566,586,589,608,950,978** "fails the download when a listed asset disappears" / "removes the staging copy once" / "releases the staging copy and the lifetime" / "cleans up an export the client abandoned" / "refuses an upload that a restore overtook" / "runs one import at a time": POLL, controlled: no. **rewrite:other(drop testSupport.waitFor's 2 s Date.now deadline and rely on the Vitest timeout, or wait on fs.rm/mkdir spies)** (risk: med). waitFor polls readdirSync of .tmp / a stopped flag. The work is real fs I/O plus stream teardown and snapshots.stop(), capped by a 2 s wall deadline that is checked after the 10 ms timer fires (timers run before I/O after a deschedule) (risk: med)

#### `server/src/tests/cbsLimits.test.ts` (2026-10-18 fixed file)

- **95,110-120,186-297,565-590** injected clock / fakeClock / now:()=>0: CLOCK, controlled: yes. **keep-det** (risk: none). Every clock-sensitive assertion uses an injected now. Line 232 spies only to prove the unbounded path never reads it (risk: none)
- **518-535** "answers every host-parity case under the server's limits": CLOCK, controlled: partial. **keep-accepted** (risk: low). toFake:["Date"] leaves performance.now real for serverCbsLimits (5 s per parse, 60 s total). The parses are tiny and usedMs>0 is load-monotone (risk: low)
- **663-667** "a non-advancing range answers [] under the server's limits": BOOT, controlled: no. **move-slow** (risk: med-high). Gated, but spawnSync runs a fresh Node process importing the evaluator inside the default 5 s Vitest timeout. 308-317 already cover [0,1,0] in-process, so this is a delete candidate (risk: med-high)

#### `server/src/tests/cbsLimitsHost.test.ts` (2026-10-18 fixed file)

- **110,356,554-566** tickingClock / stopped performance.now / now:()=>0 plus setTimeout(0): CLOCK, controlled: yes. **keep-det** (risk: none). Controlled clocks. The setTimeout(0) at 565 runs after the earlier-queued 0 ms stop timer, which is timer order, not time (risk: none)
- **404-426,539-552** "share one job allowance..." / "yields a turn once an effect held the thread over 50 ms": CLOCK, controlled: partial. **keep-det** (risk: low). The real clock is load-monotone. An 80 ms busy-wait per parse always exceeds the 50 ms yield threshold, and the 5 ms stop timer is due before the yield. The 5 s per-parse limit has a 5 s margin (risk: low)

#### `server/src/tests/cbsLimitsJobs.test.ts`

- **374-377** "ends with the limit error after the input stage...": DUR, controlled: no. **rewrite:other(drop the Date.now 20 s bound; the 45 s ws cap and the LIMIT alternation already catch a limit that never ends)** (risk: low-med). Real server plus worker pool plus a send under overload. The bound catches no wrong implementation the terminal check misses (risk: low-med)
- **26,253** job() ws 45 s cap / SLOW 60 s per test: TMO, controlled: partial. **keep-accepted** (risk: low-med). Real listening server and real workers, 1-4 jobs per test against 60 s. The LIMIT regex accepts the 5 s wall-limit terminal. The Lua (3 s) and regex-scripts (5 s) ELU budgets only fail on gaps of several seconds (risk: low-med)

#### `server/src/tests/chatMetadataCoalescing.test.ts`

- **413-423,496,517,554** "splits ... at the effect clock yield" / runOnCopy tests: CLOCK, controlled: yes. **keep-det** (risk: low). Both yield tests inject now() (() => clock, () => 0). The runOnCopy tests use the default performance.now 50 ms effect yield, created at setup(), but a yield there only adds a setImmediate turn: the explicit flush calls and final-state assertions do not depend on it. Risk: low

#### `server/src/tests/chatMetadataCoalescingEvents.test.ts`

- **447-457 (waits 425,438)** "persists %s batches ... manual": CLOCK, controlled: no. **rewrite:injected-clock** (risk: high). The trigger effect loop yields once performance.now() - lastEffectYieldAt > 50 ms (EFFECT_YIELD_AFTER_MS, triggers.ts:541; runSetup.ts:386 passes no host.now). lastEffectYieldAt is set when the runtime is built and never reset by the alert-input wait, so if more than 50 ms pass between job setup and the answer, the first setter after v2GetAlertInput yields, the queued metadata microtask flushes {$ready} by itself, and transactions/patches come out as 2, not the exact 1 expected. Fix: inject the clock (host.now) through the default runner. risk: high
- **140,146,195,200,254,425,438** "flushes one batch before %s" / "flushes channel requests" / "persists %s batches": POLL, controlled: no. **rewrite:deferred** (risk: med). testSupport waitFor (a Date.now deadline, default 2000 ms, 10 ms steps) polls events from a real WebSocket. The button variant also waits on the first Lua worker boot plus the run (line 425). After a stall the poll's timer runs before the socket read and throws once the deadline has passed. Fix: resolve a promise from ws.on("message") for the awaited event type. risk: med (high for 425 button)
- **425-460** "persists button batches": CLOCK, controlled: no. **keep-accepted** (risk: low). The Lua run's charged time is the worker's eventLoopUtilization active time, which is wall time, against DEFAULT_LUA_CPU_MS 3000 (workerPool.ts:463-475). Only a stall of more than 3 s inside the run kills it. Margin is about 20x the normal run. risk: low

#### `server/src/tests/diagnostics.test.ts`

- **603-649,654-659** "is written at most 5 s after the first error event" / "never throws from a timer": CLOCK, controlled: yes. **keep-det** (risk: low). vi.useFakeTimers({ now }) with no toFake fakes Date too and the journal clock is injected (now: () => clock); risk low
- **889,893,934** "records `accepted` at admission and `done` or `error`": POLL, controlled: partial. **rewrite:deferred** (risk: med). ended() = server waitFor (2 s real cap) racing the fake runner's real sleep(20); a >2 s deschedule inside those 20 ms lets the poll timer fire first, see the job not ended and throw; durationMs>=15 (generationJobs Date.now) is only a lower bound overload increases; risk med
- **902,906,919,962,976,1133,1632** "records `accepted`..." / "runs a job to its end when the diagnostics folder is broken" / "records a job through the real wiring" / "refuses the save with a 503 once shutdown began": POLL, controlled: yes. **keep-poll** (risk: low). server waitFor on in-process work only (rejecting/aborted runners, sync sqlite, in-process body pull); risk low
- **1153-1158** "records `shutdown` and writes the final state at dispose": SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(5) only so the real-clock writtenAt differs from the first state write; overload only lengthens it (rewrite:injected-clock possible); risk low
- **1072-1083,1101-1105** "records an `http` event for an answer of 400 or more" / "records maintenance start and end": CLOCK, controlled: no. **keep-accepted** (risk: low). app.ts middleware also records any request whose performance.now duration exceeds HTTP_SLOW_MS=5000; a 200 (or the restore POST) taking >5 s would add an event to these exact toEqual lists; 5 s margin vs ms of work; risk low

#### `server/src/tests/embeddings.test.ts`

- **555-556** "an abort during a rate-limited batch ends the waiting tasks": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). setTimeout(10) as settle before expecting exactly 1 call; work before the fake fetch is in-process (sync node:sqlite cache, microtasks) so it cannot be outrun, but should await a fetch-entered latch; rate window is real Date.now 60 s (huge margin); risk low

#### `server/src/tests/events.test.ts`

- **111,115,141,154,168,226** "live-update socket on the server" (hello / delivers every change / closes with 1001): POLL, controlled: no. **rewrite:deferred** (risk: med-high). testSupport waitFor (2 s real cap, Date.now deadline, 10 ms real setTimeout) waits for frames over a real loopback WebSocket; after a >2 s deschedule the timer phase runs before the poll phase reads the socket, so the deadline check throws first; await a promise resolved by the message handler instead (risk: med-high)
- **263,285,297,303,315,318,321,325** "createEventSockets" (refuses 503 / send throws / pings every 15 s): POLL, controlled: partial. **rewrite:deferred** (risk: med-high). same 2 s real-cap waitFor on real socket I/O (upgrade reaching authorize, frames, server-side close shrinking sockets.size); the 15 s ping is faked (setInterval only) but the frame it sends still crosses a real socket (risk: med-high)
- **122,311-317** "refuses ... an expired ... JWT" / ping fake interval: CLOCK, controlled: yes. **keep-det** (risk: low). exp = now-10 s can only get more expired under a deschedule; the heartbeat interval is faked and only ts: any(Number) is asserted (risk: low)

#### `server/src/tests/generationDeltaChunks.test.ts`

- **207,356,364** "until(owner, ...)" / "puts committed patches on both live sockets": POLL, controlled: no. **rewrite:deferred** (risk: med-high). testSupport waitFor has a 2000 ms real Date.now cap while it waits for frames on a real loopback WebSocket. A 1-3 s stall makes it throw before the queued frames are delivered. Resolve on onmessage instead and let the Vitest timeout catch hangs. Risk: med-high
- **185,193,288** "follow(): maxMs 4000 socket cap; 20 ms close after done": CLOCK, controlled: no. **rewrite:deferred** (risk: med). The owner socket closes itself after 4000 ms of real time. Under a stall it can close before "done" or the later accepted frames arrive, so the frame waits fail. Risk: med

#### `server/src/tests/generationJobs.test.ts`

- **532-595** "lets the first abort decide the outcome and fixes one deadline per job": CLOCK, controlled: yes. **keep-det** (risk: none). abort grace is a setTimeout (faked); Date.now only feeds startedAt/endedAt for startGc, which no test here starts; checked, controlled
- **187,759,793** ended() / waitFor(text) (admission loop, maintenance, shutdown): POLL, controlled: partial. **keep-poll** (risk: low). testSupport waitFor 2 s cap over in-process jobs on synchronous node:sqlite; no I/O; risk low
- **528,800** Promise.race([snapshots.stop()/jobs.drain(), sleep(500/1000)]): SLEEP, controlled: yes. **keep-det** (risk: low). the awaited promises resolve by microtasks once the jobs ended (stop() with nothing active, drain over resolved finished), which always beats a timer; guard only; risk low

#### `server/src/tests/generationMetadataEvents.test.ts`

- **138,144,164,171,199,215** "metadata delivery to the job owner" (all cases): POLL, controlled: no. **rewrite:deferred** (risk: med-high). testSupport waitFor (2 s real cap) on events arriving over a real generation WebSocket and on ownerAttached() flipping after a real socket close; overrun by a >2 s deschedule before the poll phase reads the socket (risk: med-high)

#### `server/src/tests/generations.test.ts`

- **185 (follow maxMs 4000); closed awaited at 318,410,419,428,447,458,613,645,733,794,804,854,872,919** "admits one job per chat" / "DELETE aborts" / "runs a command job" / "sends the job chat as a patch" / "answers `resync`" / "dispatches upgrades": POLL, controlled: no. **rewrite:other(drop the 4 s auto-close; close on the terminal or explicitly and let the Vitest timeout be the only cap)** (risk: med-high). follow() closes the owner socket 4 s (real) after attach; tests that keep one socket across many JWT-signed HTTP round-trips and steps lose their late events (done/error) if the body overruns 4 s under 9x slowdown plus a 1-3 s stall; risk med-high
- **207 (until) via testSupport.ts:308-316; calls at 297,407,415,420,424,437,441,455,592,665,688,710,725,742,753,774,784,827,830,844,863,865,897,902,911** "until(owner, n)" / "waitFor(() => feedFrames...)" across the file: POLL, controlled: no. **rewrite:other(event-driven waiter resolving on the socket's message, no Date.now deadline)** (risk: med). testSupport waitFor: Date.now deadline of 2000 ms polled every 10 ms over real loopback WebSocket I/O; after a stall the expired 10 ms timer runs before the poll phase reads the pending frames and Date.now is past the deadline, so it throws; risk med
- **73-76 (afterEach nulls `wake` before server.close), 394 (second job admitted, never ended)** "admits one job per chat ... answers the status DTO": CLOCK, controlled: no. **rewrite:other(end the job admitted at 394, or wake the runner before clearing `wake`)** (risk: med). The leaked job's runner never sees its abort, so dispose waits JOB_ABORT_GRACE_MS=5000 real (generationJobs.ts:47); measured 5.1 s per run against the 10 s default hookTimeout; 5 s margin shrinks under overload and wastes 5 s every run; risk med-low
- **87-122 (listen) in every test** every test in "generation jobs over HTTP and WebSocket": BOOT, controlled: no. **rewrite:raise-timeout** (risk: low-med). Server boot + login + 3 reads + seed batch + dozens of ECDSA-signed requests under the default 5 s timeout; bodies take 60-600 ms normally, so ~9x slowdown plus a stall comes close to 5 s; risk low-med
- **456** "publishes each applied write's coverage ..." snapshot(): SLEEP, controlled: partial. **rewrite:deferred(wait for the expected event count, or for the attach batch, instead of 30 ms)** (risk: low). Collects the rest of the attach batch for 30 ms, then closes. The server sends the batch in one synchronous loop (generationJobs.ts:1239-1241), so it lands in one loopback read before until() returns; risk low
- **438,480,503,516,530,537,549,740,842,845** "keeps one delivery stream" / "publishes each applied write's coverage" / "sends the job chat as a patch" / "answers `resync`": SLEEP, controlled: yes. **keep-det** (risk: low). The runner is parked on `wake` (started at create via Promise.resolve().then), and each step's job.write/emit is synchronous, so the step finishes in microtasks before the sleep starts; the sleeps are redundant (845 is a negative check that can only false-pass); risk low

#### `server/src/tests/hypaV3Limits.test.ts` (2026-10-18 fixed file)

- **107,114-119** "the %s loop ends with an error instead of spinning": BOOT, controlled: no. **move-slow** (risk: med-high). spawnSync of a fresh Node process importing hypav3.ts (30 s spawn cap) inside a sync test with the default 5 s timeout, which Vitest enforces after return (risk: med-high)
- **262-280** "ends a catastrophic pattern on a real worker while the event loop stays free": CLOCK, controlled: no. **rewrite:other(await pool.warm() before run; drop the <5000 and <1000 bounds; keep timerFiredAfterMs not null; raise the timeout)** (risk: high). hypav3.ts:57,77 checks the real 5000 ms chunking budget before the regex error, so a cold boot of more than 5 s gives "chunking budget exhausted". The test's <5000 and <1000 bounds and the default 5 s timeout are wall time too (risk: high)
- **199-256** separator split / chunking-budget tests: CLOCK, controlled: partial. **keep-det** (risk: low). 228-256 stub performance.now. 199-224 read the real clock against the 5 s budget with an in-process fake regex, a margin of 5 s (risk: low)

#### `server/src/tests/importCharx.test.ts`

- **124-125,271-288** "throttles progress to 200 ms" / firstAssetClock users: CLOCK, controlled: yes. **keep-det** (risk: none). route's 200 ms progress throttle reads performance.now, which both tests mock (times[] by asset count; firstAssetClock 0/200); the other tests only assert at(-2)/at(-1) and total, which stay valid if extra progress lines appear under load
- **375,433,503,517** "refuses ... while staging" / "ends with one error and stops writing after %s" / "holds admission through streaming and shutdown waits for %s": POLL, controlled: no. **rewrite:other(drop testSupport.waitFor's 2 s Date.now deadline; rely on the Vitest timeout)** (risk: med). testSupport.waitFor with a 2 s wall cap polls for real fs results: staged file size 20, first asset written after inflate+hash+write, and dispose() completing; a >=2 s deschedule inside the window throws (risk: med)

#### `server/src/tests/importModule.test.ts`

- **318,331,363,411,414,473,477,483,485** spool/socket waits ("keeps admission through spool", "ends a started stream", "cleans staging", "cleans an upload abandoned on a real socket"): POLL, controlled: no. **rewrite:raise-timeout** (risk: med). testSupport waitFor (2 s Date.now cap) on statSync of the spooled file, asset files, staged dir and a real http socket abort; all libuv fs/socket I/O, so a >2 s stall fails it; risk med
- **347,421,492** waitFor(() => disposed) before await disposing: POLL, controlled: no. **rewrite:other(await disposing directly)** (risk: low-med). redundant poll on the dispose promise with a 2 s real cap over fs cleanup; the following `await disposing` already proves it; risk low-med
- **296-300** "checks JWT, the shared authenticated limiter, maintenance and missing body before reading": TMO/PERF, controlled: no. **rewrite:other(inject a small limiter limit through the server options)** (risk: med). spends ~2000 real in-process requests (limit 2000, 60 s window) under the default 5 s test timeout; 392 ms idle, ~3.5 s at 9x plus any stall -> timeout; risk med
- **136-137** firstRecordClock (performance.now mocked): CLOCK, controlled: yes. **keep-det** (risk: none). progress throttle clock is spied to 0/200 by asset count; checked, controlled; risk none

#### `server/src/tests/importRealm.test.ts`

- **846-851** "removes a staged import that waits past its expiry" (s2 half: stagedTtlMs 200): CLOCK/SLEEP, controlled: no. **rewrite:other(inject the staging timer or an expire() hook into createRealmStaging; give the commit-first half a huge TTL)** (risk: high). prepare's answer -> commitRequest must take the import before a REAL 200 ms setTimeout TTL fires; ~20-50 ms normally, a 1-3 s deschedule or 9x slowdown lets the TTL win and the commit answers 404; the 250 ms sleep itself is ordered after the TTL timer (ok); risk high
- **838-841** "removes a staged import that waits past its expiry" (stagedTtlMs 50): POLL/CLOCK, controlled: no. **rewrite:other(staging timer/expire hook, then await the removal)** (risk: med). waitFor (2 s Date.now cap) waits for a real 50 ms TTL timer plus async fs removal of the staged file; a >2 s stall while the rm callback is pending makes waitFor throw; risk med
- **1014-1019** "a client that leaves before reading the prepare's line leaves nothing staged past the expiry": POLL/CLOCK, controlled: no. **rewrite:other(staging timer/expire hook)** (risk: med). real 100 ms TTL timer + fs cleanup awaited by waitFor with a 2 s real cap (testSupport waitFor uses Date.now deadline); risk med
- **112,290,456,499,649,706** realm.received / waitFor(request.closed) (charx download, caps, 502 text, stall, PNG commit shutdown): POLL, controlled: no. **rewrite:raise-timeout** (risk: med). polls a real loopback HTTP server's socket close/request arrival with testSupport waitFor's 2 s Date.now cap; socket events are libuv I/O, so after a long stall the poll timer runs before the close callback and throws; risk med
- **620,641,679,741,772,878,894** waitFor(staged/assetFiles) (slot holders, PNG commit, cancelled copy, error line, shared slot): POLL, controlled: no. **rewrite:raise-timeout** (risk: med). waits on real fs spool/asset writes through a real streamed request, 2 s real cap; risk med
- **701** "holds admission through the PNG commit stream and shutdown waits for %s": POLL, controlled: no. **rewrite:other(await disposing directly; the waitFor(disposed) duplicates it)** (risk: low-med). waitFor(() => disposed) is the same promise as the next line's `await disposing` but with a 2 s real cap over fs cleanup; risk low-med
- **1052,1065** "planPngFile caps" (MAX_PNG_TEXT_CHUNK_BYTES ~67 MB chunk; 1,000,000 chunks): TMO/PERF, controlled: partial. **keep-accepted** (risk: low). measured 2.3 s / 1.2 s on an idle box against a 60 s timeout (26x / 49x margin) for big real-fs data; 9x overload ~20 s still fits; risk low

#### `server/src/tests/jobChannel.test.ts`

- **798-803 (next), 913, 935** "the registry over a real socket" (all tests via Client.next): POLL, controlled: no. **rewrite:deferred** (risk: med). Client.next() polls with testSupport waitFor (2 s Date.now deadline) on events from a real WebSocket. Line 935 waits 2 s for a real 200 ms channel timer. A stall of 1-3 s while a read is pending lands the deadline check before the socket callback. Fix: event-driven next() (resolve on onmessage) with no wall cap, or a much larger cap. risk: med
- **899,930 (timeoutMs 300/200)** "re-sends a pending question ... times out with a cancel" / "reports a disconnect": CLOCK, controlled: no. **keep-accepted** (risk: low). These are real channel timers in production (createChannelHub now = Date.now, real setTimeout), and the timeout is the subject. Only the outcome kind is asserted, and nothing answers the question, so a stall cannot reorder it. The exposure is the 2 s poll above. risk: low
- **910-911** "re-sends a pending question ... ignores the superseded socket's answer": SLEEP, controlled: no. **rewrite:deferred** (risk: low). sleep(100), then a negative assertion (outcome.first undefined) after the stale socket's answer. Under load the server may not have read the answer yet, so the check passes without testing anything instead of failing. Fix: wait for a server-side signal that the stale answer was handled (a spy on handleMessage, or a round-trip marker). risk: low (false pass)
- **833** "delivers a callback requested before the owner attaches": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). sleep(50) stands in for "the job has requested its callback". The in-process runner always gets there first, and if it did not, the event order would be the same anyway, so the test would pass without covering the before-attach path. Fix: a latch resolved in the step after channel.callback() is called. risk: low
- **123-161,277-307,323,351,475-494,627** harness() hub tests: CLOCK, controlled: yes. **keep-det** (risk: none). Injected now() plus faked setTimeout/clearTimeout. tick() moves both together. state() uses one setImmediate as an in-process microtask probe. risk: none

#### `server/src/tests/jobMetadataScope.test.ts`

- **285** "Lua setters land before the next task ...": SLEEP, controlled: yes. **keep-det** (risk: none). setTimeout(0) asserts the queueMicrotask write (jobScope.ts:482) lands before the next task; sync sqlite store, no I/O; risk none

#### `server/src/tests/llmCharsetRetries.test.ts`

- **195,210,225 (spawnSync timeout 60_000; it 90_000)** "a group send with the Echo model and a banned script" (both its): BOOT, controlled: no. **move-slow** (risk: med). spawnSync starts a fresh Node process that loads the whole server from TS, a resource test client, sqlite and a 2000 x 10 ms terminal poll, with a 60 s kill and a 90 s test timeout. The child is the subject (the pre-fix hang could not be stopped in process), and the slow tag's own description covers "fresh Node processes". Under 1 CPU + 8 burners the child gets about 1/9 of the CPU. risk: med

#### `server/src/tests/llmLegacyFormats.test.ts`

- **253-280,382-416,446-447,490,513-576** "Horde: ..." / "Horde's first byte": CLOCK, controlled: yes. **keep-det** (risk: none). The fake setTimeout covers the 2 s Horde poll sleep (request.ts:1559). The firstByte/completedAt ordering compares the injected tick clock, not real time. Echo uses echoDelay 0. risk: none

#### `server/src/tests/llmRequests.test.ts`

- **660-675,2387-2392** "mcpTool callback in time" / request observer clocks: CLOCK, controlled: yes. **keep-det** (risk: none). callback deadline reads the injected options.now and fake setTimeout; observer uses a ticking injected clock; checked, controlled
- **519,757-779** "ends a stream whose upstream fails after it began" (sleep 30 in mock) / "client goes away mid-stream" (20 ms frame delay): SLEEP, controlled: partial. **keep-det** (risk: low). the timers only space upstream frames; the production read->chunk->callback->abort chain is microtask-only (no throttle timer in requests.ts), so it always runs before the next frame timer; risk low
- **747,856,887** sleep(5)/sleep(10) before "nothing registered/no late success": SLEEP, controlled: partial. **keep-accepted** (risk: low). negative checks: load can only make them miss a bug, never fail spuriously; risk low (could become a setImmediate/dispose flush)
- **798,823,880,885,1208,1381,1609,1619,1621,1829,2123,2583,2585** waitFor(liveIds/finished/settled/firstByte): POLL, controlled: partial. **keep-poll** (risk: low). mocked fetch and in-process streams (sse delays of 5000 ms are woken by the abort signal); 2 s real cap only; risk low

#### `server/src/tests/llmRoutes.test.ts`

- **496-497** "ends the request when the client disconnects mid-stream over a real socket": POLL, controlled: no. **rewrite:deferred** (risk: med). testSupport waitFor (2 s) for the abort to travel a real socket: the client abort, the server close, the registry end, the upstream fetch abort, then the upstream server seeing the close. That is real network I/O under a wall cap. Fix: an event-driven wait (a registry finish hook, upstream req 'close' promise). risk: med
- **520** "refuses requests while the data is being replaced (maintenance)": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). sleep(20) waits for withMaintenance to run its listeners and pause llmRequests. Today the chain is in-process (exclusive tail plus sync pauses), so a late timer is harmless. But it is a guess at chain depth: an I/O-bound listener or a busy exclusive tail would turn `during` into 200. Fix: register an onMaintenance listener that resolves a deferred. risk: low

#### `server/src/tests/llmSecrets.test.ts`

- **431** "refuses a stale revision with 409 ... writes during maintenance with 503": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). sleep(20) waits for withMaintenance to set maintenance=true. The listener chain (diagnostics, translation pause, jobs, llm pause) is in-process microtasks, so the macrotask fires after it. It is correct today, but it is a guess: expose or await a gate-closed signal. Risk: low

#### `server/src/tests/llmServices.test.ts`

- **189,196,201,213,219,222,240,244** vertex token cache waitFor(calls): POLL, controlled: partial. **keep-poll** (risk: low). fetch is mocked, but each refresh first signs with crypto.subtle (libuv threadpool) under the 2 s waitFor cap; tiny work; risk low
- **248** sleep(5) before expect(unhandled).toEqual([]): SLEEP, controlled: partial. **keep-accepted** (risk: low). negative unhandled-rejection check; load only weakens it; risk low
- **280-336** Claude cache warmer: CLOCK, controlled: yes. **keep-det** (risk: none). full vi.useFakeTimers() plus injected now moved with the timers; checked, controlled

#### `server/src/tests/llmStreamParsing.test.ts`

- **545-558** "errors on upstream body failure before the abort deadline": SLEEP, controlled: partial. **rewrite:other(replace the 100 ms real timer race with a setImmediate pending check, or let the Vitest timeout catch a hang)** (risk: low). reader.read() rejection races a real 100 ms setTimeout that aborts; the error path is in-process web-stream microtasks so the timer only wins if the pipeline ever yields a macrotask; a hung implementation would still fail on the default timeout (risk: low)
- **188,458,584** afterEach / signatures / cancels upstream body: SLEEP, controlled: yes. **keep-det** (risk: low). setImmediate turns after in-process stream/promise work (fetch stubbed, no I/O) only to surface unhandled rejections or a cancel; cannot be outrun (risk: low)

#### `server/src/tests/lore.test.ts` (2026-10-18 fixed file)

- **686-707** "matches through the worker..." / "a worker timeout during activation is no match...": BOOT, controlled: partial. **rewrite:other(beforeAll(() => pool.warm(), long hook timeout))** (risk: med). The first test cold-boots the size-1 pool in the default 5 s. The 200 ms deadline outcome is deterministic (REDOS) and the replacement boots within the 15 s timeout (risk: med)

#### `server/src/tests/luaBindings.test.ts`

- **431-597,600-644,647-748,761-865,870-920** every runButton test (host-function contract 404 ms is the heaviest): CLOCK, controlled: no. **rewrite:other(createTestServer option to raise the per-run Lua budget or inject the pool's clock)** (risk: med). production workerPool.watch() charges the worker's eventLoopUtilization().active (wall time while running, including time descheduled) against DEFAULT_LUA_CPU_MS = 3000 per run; a 3 s deschedule mid-handler kills the worker ("Lua execution limit exceeded") and the terminal turns into an error (risk: med-low)
- **196,597,644,748,775,801,865,894,920,337** beforeAll + all worker tests (SLOW = 60_000); follow() 30 s silent resolve: TMO, controlled: partial. **keep-accepted** (risk: low). real listening server + worker pool + ws per test; measured 18-404 ms per test, about 100x margin to 60 s; follow()'s 30 s timer resolves without a terminal, but that is far off too (risk: low)
- **881-887** "delivers a notice-only job's notice before its terminal when the owner attaches after the job ended": POLL, controlled: partial. **keep-accepted** (risk: low). hand-rolled status poll 300x sleep(100) (about 30 s cap) until state ended; the cap is huge next to a ~20 ms job (risk: low)
- **329,907** "keeps a notice made before a late first attach beside the question": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). attachAfterMs 1500 real sleep is meant to make the first attach late; under load the attach can come before the notice/question exist and the test still passes, so it silently stops covering the late-attach path (false pass, 1.5 s per run); poll the job status for the outstanding question before attaching (risk: low)

#### `server/src/tests/luaBindingsFences.test.ts`

- **199,213** "writes no lore activation flag..." / "asks the tab for no image...": POLL, controlled: yes. **keep-poll** (risk: low). testSupport waitFor (2 s cap) on a gate reached through in-process promise chains (sync sqlite store, stat mocked); work done before any timer fires (risk: low)

#### `server/src/tests/luaRuntime.test.ts`

- **184-189** "races a stalled lookup against the abort": DUR, controlled: no. **rewrite:other(drop the elapsed<1000 assertion; the rejection proves the race and a hang hits the Vitest timeout)** (risk: med). A 20 ms real abort timer plus performance.now()-start < 1000 fails on any stall over 1 s. Risk: med
- **283-292** "rejects through the caller's abort during ... a stalled lookup": DUR, controlled: no. **rewrite:other(drop the elapsed<1000 assertion)** (risk: med). Same pattern: real 20 ms abort and a wall-clock bound of 1000 ms. Risk: med
- **392-449** "keeps the wasm function table flat ... inside a worker (plain Node)": BOOT, controlled: partial. **move-slow** (risk: low-med). A fresh plain-Node child (wasmoon load plus 30 runs) under a 60_000 timeout, 0.6 s idle. Inside the child, cpuMs budgets (3000 per run, 200 resumed, cpuMs>=150) count real ELU-active time. The slow tag already names "fresh Node processes"; only the margin keeps it passing. Risk: low-med
- **199-240** "serverLuaRequest window tests": CLOCK, controlled: partial. **keep-accepted** (risk: low). The window-rolling test injects now(). The other two read real Date.now against the 60 s REQUEST_WINDOW_MS, and the 20 ms mocked lookups race only the 10 s AbortSignal.timeout. The margin is over 100x. Risk: low

#### `server/src/tests/manualTriggerMetadata.test.ts`

- **147-152,162** "keeps %s transcript reads and writes bounded for 1 and 50 setters": CLOCK, controlled: no. **rewrite:injected-clock** (risk: med). Same uninjected 50 ms performance.now effect yield. Each gap of more than 50 ms among the 50 setters splits the coalesced write. The budget allows 1..2 transactions, so two descheduled gaps in one run fail it. The file comment admits the load dependence. risk: med
- **134-141** "keeps %s transcript reads ..." (status poll): POLL, controlled: partial. **keep-poll** (risk: low). A 500 x (in-process app.request + sleep(10)) loop until the terminal. The job is in-process (v2 effects, sqlite sync), so a slower loop only gives it more time. The real cap is the default 5 s test timeout over 4 jobs that take about 50 ms. risk: low

#### `server/src/tests/manualTriggers.test.ts`

- **233; 100,378,424,459,549,576,603,640,661,729 (SLOW)** all "a manual trigger job" tests, beforeAll: TMO, controlled: no. **keep-accepted** (risk: low). A 45 s per-socket cap and SLOW=60 s on a real server with Lua/regex worker threads; margin large vs a normal run; risk low
- **463-549 (assertions 535-546)** "runs the six regex sites in the worker; an invalid pattern ... ends the job": CLOCK, controlled: no. **rewrite:other(test-server option giving the script pool a large regex deadline)** (risk: med-high). Each trigger regex op is a worker round-trip under DEFAULT_REGEX_DEADLINE_MS=1000 real wall time (workerPool.ts:49,523, armed on the main thread); a worker thread stalled for 1-3 s gets killed with "Regex timed out" and the job errors instead of done; risk med-high
- **606-640, 643-661** "runs triggerlua on the working copy" / "ends the job on a Lua load failure ...": CLOCK, controlled: no. **rewrite:other(test-server option raising the per-run Lua cpuMs)** (risk: low-med). Lua runs under DEFAULT_LUA_CPU_MS=3000 + 1000 ms grace measured as worker eventLoopUtilization active time (workerPool.ts:458-477; runtime.ts:20), which counts a stall while busy; a 9x slowdown plus a stall mid-run can cross it ("execution limit exceeded"); risk low-med
- **558,569,573** "ends at once with `aborted` when the job is cancelled during v2Wait": DUR, controlled: no. **keep-accepted** (risk: low). Asserts elapsed < 15 s for a 30 s v2Wait cancelled via a 300 ms delayed DELETE; the bound is the subject (it catches an abort that waits out the sleep); margin 15 s; risk low

#### `server/src/tests/mcp.test.ts`

- **401-404** "ends a request at its deadline and rejects when the caller aborts": DUR, controlled: no. **rewrite:fake-timers** (risk: high). asserts Date.now() elapsed < 2000 ms around a real 40 ms requestTimeoutMs setTimeout; a 1-3 s deschedule anywhere in the call fails it; risk high
- **585-587** "gives the session stream one deadline to connect and name its endpoint": DUR, controlled: no. **rewrite:fake-timers** (risk: high). same pattern: elapsed < 2000 ms around the real 40 ms connect deadline (client.ts setTimeout); risk high
- **593-594** "gives the session stream one deadline to connect ..." (none once connected): SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(100) negative check that the 40 ms connect deadline was cleared; the deadline timer is armed earlier so it always fires first; overload only strengthens; risk low
- **1021-1026** "reads a limit-sized event delivered in small chunks without rescanning it (bounded time)": PERF, controlled: no. **rewrite:other(count scanned bytes or buffer copies via a spy instead of wall time)** (risk: med). 8 MiB in 128x64 KiB chunks must parse in < 5000 ms wall, which is also the default test timeout; at 1/9 CPU plus descheduling the margin shrinks, and the quadratic regression it guards may finish under 5 s on a fast host anyway; risk med
- **1081-1088** "shares one client per identifier, keeps a leased client past the idle time": SLEEP, controlled: partial. **rewrite:fake-timers** (risk: low). real idleMs 40 vs sleep(90): the idle timer is armed before the sleep, so Node fires them in order and overload cannot flip it; only cost is 180 ms real wait; risk low
- **843,2216** "withdraws the owner's question and settles its callers" / "writes no rotated token and publishes no access token": SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(20) negative checks that a late answer publishes nothing; overload only lengthens the wait; risk low
- **1515-1536,1598-1605** "tab kinds: no tab within the grace offers nothing": CLOCK, controlled: yes. **keep-det** (risk: low). full vi.useFakeTimers() (Date faked) around TAB_ATTACH_GRACE_MS advances; risk low
- **409,541,560,836,863,896,908,1051,1434,2204** (various McpClient/registry/job tools tests): POLL, controlled: yes. **keep-poll** (risk: low). server waitFor on in-process fake fetch / SSE ReadableStream chains only; risk low

#### `server/src/tests/mcpInternal.test.ts`

- **468-479** "answers a tool error without asking when the owner's tab is not connected": CLOCK, controlled: yes. **keep-det** (risk: none). vi.useFakeTimers() with no toFake (Date and performance faked too) around the 10 s owner wait; advanceTimersByTimeAsync(11_000); real timers restored in finally

#### `server/src/tests/mcpSse.test.ts`

- **122-127** "frames many small events in a chunk larger than the bound": PERF/DUR, controlled: no. **rewrite:other(count framer scan work, e.g. bytes inspected, instead of wall ms) or move-slow** (risk: med). 80,000 events must frame in < 3000 real ms; 121 ms idle (25x margin) but 9x slowdown + a 1-3 s deschedule can cross 3 s; risk med

#### `server/src/tests/memoryJobs.test.ts`

- **1032** "'memory' turns the owner's toggle on": POLL, controlled: no. **rewrite:deferred** (risk: high). expect.poll has a 1 s real cap waiting for the feed socket's hello frame over a real ws; after a >=1 s deschedule the poll timeout fires in the timers phase before the socket I/O callback; resolve a promise from ws.onmessage instead (risk: high)
- **1061** "'memory' turns the owner's toggle on": POLL, controlled: no. **rewrite:deferred** (risk: med-high). expect.poll 1 s cap on the characters change frame arriving on the second (feed) socket after the job's done came on the job socket; the order across the two sockets is not fixed and the gap is real I/O; wait on a frame-matching promise (risk: med-high)
- **796** "an abort during a summary makes no later request": SLEEP, controlled: partial. **delete** (risk: low). sleep(200) inside the mock holdSummary after an awaited DELETE: the abort has already happened when DELETE answers, so the delay adds nothing a wrong implementation would fail on (risk: low)
- **801,1319** "an abort during a summary ..." / "an invalid answer, and an abort while the question waits": SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(300) then negative checks (no later main request, write or cache row); load can only hide a late stray request, never fail a correct impl (risk: low)
- **511,598-1390,426** beforeAll + every test (SLOW = 60_000); job() 55 s silent resolve: TMO, controlled: partial. **keep-accepted** (risk: low). real server + mock provider/embedder over HTTP + ws; measured 25-503 ms per test, about 100x margin (risk: low)

#### `server/src/tests/postProcess.test.ts`

- **117** "shows [Generating...] for both image command forms": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(5) only delays a fake image provider; a parallel implementation sets `overlapped` before any timer fires, so the order/overlap check does not depend on timing (risk: low)

#### `server/src/tests/promptRunner.test.ts` (2026-10-18 fixed file)

- **715-720** "checkpoints a stalled stream on the timer, and an abort keeps the text": DUR, controlled: no. **rewrite:deferred** (risk: low). expect(Date.now()-started).toBeLessThan(15_000) against a provider that sleeps a real 20_000 ms before chunk 2; hold chunk 2 on a never-released holdBeforeChunk deferred instead and drop the bound (terminal arrival while held proves the abort does not wait); 41 ms idle, risk low
- **718-724,1343-1358** "abort keeps the text so far" / "an aborted send hands nothing over": CLOCK, controlled: no. **rewrite:injected-clock** (risk: low-med). stored "char:First." after DELETE relies on the runner persisting before production JOB_ABORT_GRACE_MS=5000 real setTimeout (generationJobs.ts:800) finalizes the job and kills its write token; work is ~40 ms idle, risk low-med (5 s vs 9x slowdown + 1-3 s deschedule)
- **1080** "a stream that breaks after its chunks ends the job as the request's failure": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). provider delayMs:150 then res.destroy(): chunk-1 delivery to readReply before the break is ordered by a real 150 ms timer (a stream error discards still-queued chunks, so streamedTexts==["First."] and stored "char:First." depend on it); event-loop order (poll before next timers) usually saves it; destroy on a latch released when the ws sees the chunk event; risk low
- **588,680** "runs the input stage ... streams the raw reply" / "continue extends the last reply": SLEEP, controlled: yes. **keep-det** (risk: low). provider delayMs:40 only spaces chunks; assertions (>=2 chunks, distinct growing sequence ending with the whole text) tolerate coalescing; no assertion orders them against another real timer; risk low
- **1167,1173,1256,1273,1303,1315** "automatic translation ..." chatUntil: POLL, controlled: no. **rewrite:other(await a translationRunner settled/idle promise instead of polling)** (risk: low). hand-rolled poll, real 10 s Date.now deadline, 25 ms real sleeps, over real HTTP to the fake provider + server storage writes; risk low (10 s cap)
- **1233** "hands the reply and the user message over before done": POLL, controlled: no. **rewrite:other(latch in onRequest counting held translation requests)** (risk: low). testSupport waitFor with real 10 s cap on two translation requests reaching the fake provider over real HTTP; risk low
- **1267,1332** "hands the reply..." / "a group send hands every member's reply": POLL, controlled: no. **rewrite:other(await a translationRunner idle promise)** (risk: med). testSupport waitFor DEFAULT 2000 ms real cap (testSupport.ts:308) on runningCount()===0; condition is re-checked only after the real sleep timer, so a 2-3 s deschedule before pending I/O callbacks run throws; risk med
- **1384** "the lastInteraction stamp" feedSocket: POLL, controlled: no. **rewrite:other(resolve a promise from onmessage on the hello frame)** (risk: med). waitFor default 2000 ms real cap for the /api/events/ws hello frame (real WebSocket I/O); risk med
- **1404** "send, continue, and group stamp the owner once": POLL, controlled: no. **rewrite:other(resolve from onmessage when the revision's change frame arrives)** (risk: med). waitFor default 2000 ms real cap for the change-feed frame over a real WebSocket; risk med
- **1326,1351** "a chat that does not auto-translate hands nothing" / "an aborted send hands nothing over": SLEEP, controlled: no. **rewrite:other(await the job's translation-handover decision point, then assert)** (risk: low). sleep(200) before negative checks (no extra provider body, runningCount 0); cannot false-fail, but under load a late wrong handover slips past (false pass); risk low
- **345** job() helper: POLL, controlled: partial. **keep-accepted** (risk: low). job() waits a real 45 s for done/error then resolves silently (terminal undefined fails the next assertion); every test idles <0.6 s; margin ~75x; risk low
- **29,495,578,633,659,708,727,803,859,880,916,932,960,981,1013,1073,1099,1144,1282,1334,1360,1455,1475** all "a send"/translation/stamp tests + beforeAll: TMO, controlled: partial. **keep-accepted** (risk: low). SLOW=60_000 per test and on beforeAll (real server, worker pool, Lua, WebSocket); idle per-test 14-560 ms, beforeAll ~2 s; margin >=20x even at 9x slowdown; risk low
- **935-960** "the request trigger's effect limit ends the job before any provider call": PERF, controlled: partial. **keep-accepted** (risk: low). runs the REAL 100,000-effect limit (vitest.config tag text lists this as a slow-tier criterion) in the gated tier; 413 ms idle under a 60 s timeout, so margin is large; consider move-slow for consistency; risk low
- **581-634,662-708** "editinput in the worker" / "continue ... Lua editRequest": CLOCK, controlled: no. **rewrite:other(createTestServer option for a script pool with generous cpuMs)** (risk: low). production worker budgets are eventLoopUtilization-active wall time: regex-scripts task 5000+1000 ms, Lua run DEFAULT_LUA_CPU_MS 3000+1000 ms (workerPool.ts:474,537,851; runtime.ts:20); a deschedule while the worker is busy is charged; runs are ms-scale; risk low
- **588-633,662-708,1080-1099** streaming tests (production checkpoint timer): CLOCK, controlled: no. **keep-accepted** (risk: low). readReply's checkpoint uses real Date.now + setInterval(250) with CHECKPOINT_INTERVAL_MS=3000 (runner.ts:1730-1754); under load a gated stream can span 3 s and write an extra checkpoint, but no gated assertion counts checkpoints or chat revisions; risk low
- **1396-1401,1427,1441** "stamp the owner once with the server clock": CLOCK, controlled: yes. **keep-det** (risk: none). lastInteraction bracketed by Date.now() before/after the job and compared to now+1 day: monotonic window, load only widens it; risk none

#### `server/src/tests/promptTail.test.ts`

- **642** "runs editoutput once on the completed text ..." (chunks >= 2): CLOCK, controlled: no. **rewrite:other(assert on the provider's SSE writes or flush per chunk with a latch)** (risk: low). The SSE adapter enqueues one snapshot per network read (openAI/requests.ts:1113), and the in-file provider spaces its 3 chunks with real sleep(20). If the process is descheduled between a write and its poll-phase read, the next timer writes again first and the chunks merge into one read. That needs this to happen twice to fall below 2 chunk events. risk: low
- **627** "runs editoutput once ..." (Web Push): POLL, controlled: no. **rewrite:deferred** (risk: low-med). testSupport waitFor (2 s) for the Web Push delivery, which runs asynchronously after the notification (subscription store I/O, then the fake transport). Fix: resolve a promise from the fake pushTransport.sendNotification. risk: low-med
- **648** "runs editoutput once ..." (stageTiming.stage3 >= CHUNK_DELAY_MS): DUR, controlled: no. **keep-accepted** (risk: none). A lower bound on real elapsed ms across a stream that really sleeps 2 x 20 ms. Load only makes it larger, so it cannot fail from overload. risk: none
- **36,360,522,658-1189 (SLOW = 60_000)** every streaming/rounds/inlay/emotion test and beforeAll: TMO, controlled: no. **keep-accepted** (risk: low). 60 s per test and beforeAll over a real server with Lua workers, provider, embedder and sockets. The longest test is 0.5 s alone (about 100x margin, about 10x under 9x load). job() has a silent 45 s fallback. The Lua ELU 3 s budget is the only tighter bound. risk: low

#### `server/src/tests/proxy.test.ts`

- **121-133** "streams SSE through, and a timeout before upstream headers is a 504": CLOCK, controlled: no. **rewrite:other(start the /hang request, await upstream.received(2), then fire the proxy timeout via fake setTimeout or an injected timer; await the close event)** (risk: med). real 100 ms proxy timeout (proxy.ts createTimeoutController) races the local connect + body upload; a deschedule >100 ms lets it abort before the upstream pushes its record (record pushed only after the body is read), then waitFor(requests[1].closed) times out at 2 s real (risk: med)
- **147** "answers HEAD with headers only and closes the upstream body": POLL, controlled: no. **rewrite:deferred** (risk: med). 2 s real-cap waitFor on the upstream response close over a real socket (risk: med)

#### `server/src/tests/push.test.ts`

- **360;363;595;789;793** "registering one past the cap" / "a removal racing a delivery" / "delivers completions one at a time": SLEEP, controlled: yes. **keep-det** (risk: low). setSystemTime mocks Date for updatedAt; the 5/10 ms sleeps only let promise chains run (pushService uses sync fs and promise queues, no I/O or timers), and a later timer cannot outrun microtasks (risk: low)

#### `server/src/tests/regexScriptsTask.test.ts`

- **144** "reports a script's own failure ... keeps the worker": CLOCK, controlled: no. **rewrite:other(pass { deadlineMs: 60_000 } to pool.regex)** (risk: high). pool.regex defaults to DEFAULT_REGEX_DEADLINE_MS 1000 ms, a real main-thread setTimeout armed before posting to a real worker; a >1 s deschedule fires it before the worker's reply is read -> "Regex timed out" (risk: high)
- **104-122,124-134** "fails the task for a CBS argument over the cap" / "refuses a result over the cap as JSON": CLOCK, controlled: no. **rewrite:other(pass a large cpuMs, e.g. 60_000, in the runScripts input)** (risk: med). runScripts limit = 5000 ms + 1000 grace measured as the worker's eventLoopUtilization().active (wall time while busy, inflated by descheduling), polled by a real 50 ms watchdog; 9-18 MiB regex/JSON work is 130-280 ms idle, ~10x under 1/9 CPU share plus a deschedule (risk: med)
- **81,102,122,134,145** all five (30_000 / 60_000 bumps): TMO, controlled: partial. **keep-accepted** (risk: low). real worker boot (bootMs 30 s) inside the first test plus 9 MiB work; idle max 283 ms vs 30-60 s (>100x margin); the limits above are the real risk (risk: low)

#### `server/src/tests/requestCapture.test.ts`

- **514,545,1243,1286,1290,1318** "captures flush ..." / "a tab's request aborted ..." / "an aborted job's request ...": SLEEP, controlled: yes. **keep-det** (risk: low). sleep(1/5/10) after in-process mock-fetch promise chains with an injected tick clock and sync history store; a timer cannot fire before those microtasks; the 10 ms ones are negative windows (risk: low)
- **1238,1241,1285,1289,1317,1335** abort cases: POLL, controlled: yes. **keep-poll** (risk: low). testSupport waitFor on in-process registry state (mocked upstream) (risk: low)
- **1360-1365** runBatch (Anthropic batch): CLOCK, controlled: partial. **keep-accepted** (risk: low). fake setTimeout without Date; anthropic.ts reads real Date.now against BATCH_TIMEOUT 24 h 10 min, unreachable (margin ~hours) (risk: low)
- **1122,1139,1151** 4 MiB stream capture cases: TMO, controlled: partial. **keep-accepted** (risk: low). 20 s bump for 4 MiB redaction; idle 72-114 ms (~175x margin) (risk: low)
- **908-909,1393-1394,1419-1436,1471** firstByteAt/completedAt ordering: CLOCK, controlled: yes. **keep-det** (risk: none). harness injects now() = tick++ from 1000; the ordering is a counter (risk: none)

#### `server/src/tests/requestHistoryRoutes.test.ts`

- **443-461** "refuses the history routes with 503 during shutdown, and sets no-store on a 413 and on the limiter's 429": PERF, controlled: no. **rewrite:other(test-server option with a small limiter cap, e.g. 20/min)** (risk: med). 2,001 sequential app.request calls to reach the 2000/min limiter inside the default 5 s timeout; measured 451 ms, so ~9x slowdown plus a stall reaches about 5 s. The 60 s Date.now window never matters; risk med
- **365-379** "removes every row (204) ... answers 500 when the delete failed while the store stays open": CLOCK, controlled: yes. **keep-det** (risk: none). Lock held by a second DatabaseSync; the request-history store sets no busy_timeout (requestHistory.ts:529-533), so SQLITE_BUSY comes at once, with no real-time wait; risk none

#### `server/src/tests/requestShare.test.ts`

- **997** "refuses the share with a 503 once shutdown began": POLL, controlled: yes. **keep-poll** (risk: none). testSupport waitFor on `pulled`. The request goes in-process through app.request, so the body pull is a promise chain with no I/O. Every other clock in the file is injected (clock / NOON). risk: none

#### `server/src/tests/resourceStore.test.ts`

- **753;770;780** "rolls back a body that returns a promise or a thenable" / "rejects a timer write the body scheduled": SLEEP, controlled: yes. **keep-det** (risk: low). sleep(10) after microtask-only late writes; the body's setTimeout(0) was created before the 10 ms sleep timer and expires first, so Node runs it first whatever the load (risk: low)

#### `server/src/tests/scriptWorker.test.ts` (2026-10-18 fixed file)

- **586-594** "lets queued runs sharing a budget spend it once": CLOCK, controlled: no. **rewrite:other(slot held by an unbudgeted deferred blocker so all 4 budgeted runs queue; run 1 = `while true do end`, ends only through the hook; charge invariants)** (risk: high). The 75 ms os.clock spin (wall) races the hook's ELU budget of 100 ms. A descheduling gap over ~25 ms before `local t = os.clock()` makes run 1 cut, so the "done" count is 0; a gap over ~125 ms after the spin breaks usedMs<=200; a stall over 1.1 s lets the watchdog kill it (risk: high)
- **618-629** "reserves each concurrent run's allowance so two workers cannot overspend" (2cc6c51f1): CLOCK, controlled: partial. **rewrite:other(also accept the watchdog's "Lua execution limit exceeded (worker terminated)" as a cut, or make the watchdog grace a pool option set large in tests)** (risk: low-med). Refused=2 is synchronous, cpuMs>=50 and usedMs==sum hold on the hook path. Residual: a whole-process stall of at least 1050 ms mid-loop lets the main-thread watchdog (cpuMs 50 + 1000 grace on worker ELU) fire before the hook, so cut has 1 entry (risk: low-med)
- **282-292** "stops a top-level runaway and a handler runaway at the per-run budget without a termination": DUR, controlled: no. **rewrite:other(drop topMs/handlerMs<3000; make the watchdog grace injectable so terminated==before is not raced)** (risk: med). The wall bounds catch nothing a hang would not. terminated==before races the 1300 ms ELU watchdog against the hook after a stall (risk: med)
- **297-304** "terminates a C-level runaway started after an unawaited host call": DUR, controlled: no. **rewrite:other(drop ms<4000; the "worker terminated" error alone proves the watchdog)** (risk: med). The watchdog fires about 1.1 s into worker ELU (wall while busy); a main-thread gap of 3 s or more breaks the 4 s bound (risk: med)
- **321-331** "charges the CPU spent between host calls, not the waits" (second half): CLOCK, controlled: no. **rewrite:other(cpuMs 3000 and assert ms - waited.cpuMs >= 900; gaps in active segments add to both sides)** (risk: med-high). cpuMs:100 with real ELU: a deschedule of more than 100 ms in the preamble or the resumption makes the checkpoint or hook cut the run (res!="done") or cpuMs>=100. The first half (30x40 ms spin vs 300) is load-monotone (risk: med-high)
- **334-349** "charges a coroutine resumed after a long wait only its own compute": CLOCK, controlled: no. **rewrite:other(budget 500 with wait 1000 so a wall-deadline hook still fails; add ms - cpuMs >= wait)** (risk: med-high). cpuMs:100 against a 20 ms wall spin plus preamble: an active-segment gap over ~80 ms cuts the run (risk: med-high)
- **355-366** "stops a runaway right after a resumption at the budget": DUR, controlled: no. **rewrite:other(drop ms<4000; assert the hook error instead)** (risk: low). timedOut is robust (hook or watchdog). The 4 s wall bound only adds a gap race (risk: low)
- **369-389** "serves concurrent host calls in their own completion order": DUR, controlled: no. **rewrite:deferred(two deferred host answers resolved b-then-a, Lua records completion order)** (risk: high). ms<1000 over real 300/50 ms timers plus cpuMs:100 ELU. "ba" is fixed by the concat order, so only the wall bound tests concurrency, and it fails on a gap of about 700 ms (risk: high)
- **392-402** "does not charge a synchronous wait, even one longer than the budget": CLOCK, controlled: no. **rewrite:other(cpuMs 1000 keeps the 1500 ms wait over budget; or assert ms - cpuMs >= 1400)** (risk: med-high). cpuMs:100 against a 20 ms spin plus preamble: a gap of about 80 ms cuts the run or breaks cpuMs<100 (risk: med-high)
- **417-431** "stops a running loop on abort without terminating the worker": DUR, controlled: no. **rewrite:other(drop ms<1500; abort from a host-entry latch; make ABORT_GRACE_MS (500) injectable)** (risk: med). If the worker does not post luaDone within the 500 ms abort grace, the kill raises the terminated count. ms<1500 is also raced (risk: med)
- **485-498** "aborts an unawaited host call's signal when its run completes and drops the late answer": SLEEP, controlled: no. **rewrite:deferred(capture ctx, assert ctx.signal.aborted after `await run`, then resolve a deferred late answer)** (risk: med). A 250 ms real timer reads signal.aborted. A worker gap of more than 250 ms before luaDone gives false. The trailing sleep(50) is a guessed settle (risk: med)
- **512-533** "kills only the owner when a spawned regex times out": BOOT, controlled: partial. **rewrite:raise-timeout(warm the two-pool outside the test or raise to 20 s)** (risk: med). Two cold workers plus a 1 s sub-regex deadline plus a 1.5 s bystander wait inside the default 5 s timeout. The deadline outcome is deterministic (REDOS never ends) (risk: med)
- **541,553** "ignores a host answer that arrives after its worker was killed": SLEEP, controlled: no. **rewrite:deferred(resolve the late answer from a deferred after the kill and await the host promise chain)** (risk: high). sleep(1600) plus a 1.1 s watchdog plus an unwarmed pool's cold replacement boot for the "next" run, all inside the default 5 s timeout (risk: high)
- **635,643** "releases the reservation of an aborted run": CLOCK, controlled: no. **rewrite:other(assert usedMs===aborted.cpuMs and below the 1000 reservation; abort on a host-entry latch)** (risk: med). usedMs<100 charges real ELU of the preamble; a gap over 100 ms fails it (risk: med)
- **651-659** "charges a run whose result is dropped as invalid": CLOCK, controlled: partial. **rewrite:other(budget 10000 so the allowance is 3000)** (risk: low). The >=50 checks are load-monotone (wall spin). Only a gap over ~925 ms lets the 1000 ms allowance cut the run (risk: low)
- **665-673** "charges the job budget across runs and refuses the run past it": CLOCK, controlled: no. **rewrite:injected-clock(stub ELU in an in-process runtime test for the remainder size; keep invariants: second refused iff first.cpuMs>=400, usedMs==sum)** (risk: med). second.cpuMs<250: a run admitted with the remainder overshoots by any gap between hook checks or reaches the 1 s watchdog (risk: med)
- **688** "fails only the call for a host answer that cannot cross": SLEEP, controlled: no. **rewrite:other(await nextTurn() as elsewhere)** (risk: low). sleep(20) to surface an unhandled rejection; outrunning it only weakens the test (vacuous pass) (risk: low)
- **801-819** "terminates a ReDoS regex at its deadline while HTTP stays responsive, and recovers": PERF, controlled: no. **move-slow** (risk: high). Each fetch latency under 500 ms and the whole run under 3 s; main-thread responsiveness on the real clock is the subject (risk: high)
- **834-837** "fails the task past the queue cap at once": POLL, controlled: no. **rewrite:deferred(entered deferred as in 557-582) + rewrite:raise-timeout** (risk: med). Hand-rolled 400x25 ms poll (10 s) inside the default 5 s timeout with a cold pool, then 1000 queued regex round trips (risk: med)
- **854-885** "gives request to low-level runs only, through the guard and the pool's own window": CLOCK, controlled: partial. **keep-accepted** (risk: low). The limiter's 60 s window uses real Date.now (egress.ts:14). A margin of 60 s against a 5 s test, but there is a cold pool boot (risk: low)
- **951-963** "charges a C-level runaway that follows a shortened give-up (syncHostTimeoutMs)": DUR, controlled: no. **rewrite:other(drop ms<7000: wallMs 30 s gives a distinct error and outlasts the 20 s timeout; warm the pool first)** (risk: med). ms<7000 includes a cold boot plus a 1 s give-up plus the 1.1 s watchdog. ms>=1000 is safe (risk: med)
- **1149-1166** "grows to maxSize under load, admits in FIFO order at saturation, and retires idle workers": POLL, controlled: no. **rewrite:deferred(per-index entry deferreds) + fake setTimeout for idleMs after boot** (risk: med). vi.waitFor with a 5 s real cap on worker-thread entry of two cold workers. Idle retirement runs on a real 200 ms timer (risk: med)
- **1173,1179,1188** "leaves no worker behind when disposed after warm()" / "fails the running and queued tasks on dispose": SLEEP, controlled: no. **rewrite:other(drop the sleeps: start() is synchronous and the assertions hold without them)** (risk: low). Guessed settles; outrunning them gives a vacuous pass, not a failure. Cold boot in 5 s (risk: low)
- **1198-1207** "replaces a terminated worker when the pool is warm": BOOT, controlled: no. **rewrite:raise-timeout** (risk: med). Warm boot plus a run plus the 1 s REDOS deadline plus the replacement worker's cold boot, all in the default 5 s (risk: med)
- **1238-1246** "lets a plain Node process that never disposes the pool exit on its own": BOOT, controlled: no. **move-slow** (risk: med-high). A fresh Node process (the slow tag's own category) with ms<15000 and a 30 s timeout (risk: med-high)
- **98-275,557-582,904-927,970-1125** cold-pool first use and readiness tests (shared pool, fake-timer readiness, microtask flushes, setTimeout spy): BOOT, controlled: partial. **keep-det** (risk: low-med). Fake setTimeout/setInterval plus the performance.now stub (996-997) control the pool's deadlines and watchdog. The Promise.resolve/nextTurn flushes are in-process. The 600 ms lower bound is safe. The setTimeout spy counts every main-thread call. Residual: the cold worker boot sits inside the default 5 s timeout (risk: low-med)

#### `server/src/tests/sharedImports.test.ts`

- **26** "imports every shared/**/*.ts with plain node": BOOT, controlled: no. **move-slow** (risk: med). execFileSync starts a fresh node that type-strips 84 shared files (0.25 s CPU when idle, 179 ms test) inside the default 5 s timeout; Vitest fails a sync test that runs past it. At 1/9 CPU plus a deschedule it gets close to 5 s; the config's slow tag already names "fresh Node processes" (risk: med)

#### `server/src/tests/shutdown.test.ts` (2026-10-18 fixed file)

- **62-73** startMain (all 3 tests): BOOT, controlled: no. **move-slow** (risk: high). spawns a fresh Node process running main.ts and polls stdout for "server is running" with a real 10 s cap (25 ms steps); idle boot ~0.4 s, so ~4-7 s at 9x slowdown plus deschedules; fresh Node processes are a slow-tier criterion in vitest.config; risk high
- **122** "lets an import admitted before SIGTERM finish": POLL, controlled: no. **move-slow** (risk: high). waitFor DEFAULT 2000 ms real cap for the CHILD process to create save/.tmp/import-* after 16 body bytes (child at 1/9 CPU, fs I/O); risk high
- **124-126** "lets an import admitted before SIGTERM finish": SLEEP, controlled: no. **rewrite:other(waitFor the "SIGTERM received" line as test 2 does at 185)** (risk: low). sleep(150) is meant to let the child process SIGTERM before the upload completes; if it has not, the import simply finishes first and the test still passes (silently stops testing the drain); risk low (false pass, not a flake)
- **185** "lets a resource write admitted before SIGTERM land with 200": POLL, controlled: no. **move-slow** (risk: med). waitFor real 5000 ms cap for the child to log "SIGTERM received"; the 100-continue barrier itself is deterministic; risk med
- **209-214** "exits promptly on SIGINT with an idle keep-alive connection open": DUR, controlled: no. **move-slow** (risk: med). expect(Date.now()-started).toBeLessThan(5000) from SIGINT to child exit (close, dispose workers/sqlite); real promptness is the subject; the wrong implementation it catches waits for SHUTDOWN_GRACE_MS=8000, so the bound cannot be widened much; risk med
- **91-143,145-198** tests 1 and 2 (production drain deadline): CLOCK, controlled: no. **move-slow** (risk: low-med). the admitted import/PUT must finish inside main.ts SHUTDOWN_GRACE_MS=8000 real setTimeout (main.ts:103) or closeAllConnections destroys it and status 200 fails; work ~0.1 s idle; risk low-med
- **143,198,216** all 3 tests: TMO, controlled: no. **move-slow** (risk: med). 20_000 ms per-test timeouts around child boot + request + exit (idle 0.55-0.8 s); ~2-4x margin at 9x slowdown with deschedules; risk med

#### `server/src/tests/shutdownAdmission.test.ts`

- **40** "lets a write admitted before shutdown finish against the open store": SLEEP, controlled: yes. **rewrite:other(drop the sleep; admission is synchronous on app.request dispatch)** (risk: none). setTimeout(30) "handler is admitted": admission (app.ts:401-432, snapshots.track registers synchronously, snapshots.ts:207) happens before app.request returns, so the sleep's length never matters; risk none

#### `server/src/tests/snapshots.test.ts`

- **107-129,152-159** "snapshot only after a committed write..." / "counts a chat-only write...": POLL, controlled: no. **rewrite:fake-timers** (risk: med-high). real setInterval(30 ms) tick + async sqlite backup/rename on fs, waited by the 2 s real-cap waitFor; a >2 s deschedule before the I/O completes throws; the sleep(100) negative checks only get weaker under load (risk: med-high)
- **64,89** "publishes a complete single-file copy..." / "keeps only the newest keep": CLOCK, controlled: partial. **rewrite:injected-clock** (risk: low). ids are stamped with new Date() at ms resolution and listed by name; sleep(2) keeps stamps apart; load only widens the gap, a same-ms pair would sort by random hex (risk: low)
- **204,208,276,284,307** stop / maintenance gate negative windows: SLEEP, controlled: yes. **keep-det** (risk: low). deferreds hold the operations; sleep(10/20) only gives a window for a wrong early resolve, and load cannot make the negative assertion fail (risk: low)

#### `server/src/tests/thoughts.test.ts`

- **41-55,63-67** "leaves a megabyte of unmatched opening tags unchanged": PERF, controlled: partial. **keep-accepted** (risk: low). It relies on the default 5 s timeout to catch the quadratic regex (minutes at 1 MB, as the header comment documents). The linear scan takes ms, so the margin is about 1000x. Risk: low

#### `server/src/tests/tokenParity.test.ts`

- **39,109,121,158 (60_000)** "%s gives the browser's ids ..." / routing it.each / lore delta: TMO, controlled: no. **keep-accepted** (risk: low). Cold in-process tokenizer loads (no workers or timers). The slowest is 1.1 s alone (cohere, GLM), about 10 s at 9x, against 60 s. "count is the id count" (default 5 s) relies on the earlier tests having loaded every family already. risk: low

#### `server/src/tests/transform.test.ts`

- **28,215 (+16 per-test SLOW)** (beforeAll and every test: SLOW = 60_000): TMO, controlled: partial. **keep-accepted** (risk: low-med). 60 s timeouts because the real script worker pool (Lua, regex) boots and runs every render in worker threads; real budgets on the path (TRANSFORM_SNAPSHOT_TTL_MS 30 s by Date.now, Lua cpuMs 3000, regex 5000) keep >10x margins; move-slow if it ever flakes; risk low-med

#### `server/src/tests/transformService.test.ts`

- **114-117,189** heldCount poll (500 x setTimeout 2) / setTimeout 5 before closed===false: POLL/SLEEP, controlled: partial. **keep-poll** (risk: low). iteration-capped poll over fake in-process script workers and sync sqlite; the 5 ms sleep is a negative check; risk low
- **274-346** deadline and snapshot tests: CLOCK, controlled: yes. **keep-det** (risk: none). toFake includes Date where the 30 s TTL is asserted; the "clock" test spies Date.now; the other tests carry the real 30 s render deadline (huge margin); checked, controlled

#### `server/src/tests/transformers.test.ts`

- **155-449** "killing the process" / "dispose" (fake-worker cases): SLEEP, controlled: yes. **keep-det** (risk: low). tick()/tick(5) are real setTimeouts, but the fake workers answer synchronously or by queueMicrotask, and the real idle/task timers are 60 s; the two time-limit cases use full vi.useFakeTimers (risk: low)
- **513;520** "forks transformersWorker.ts, answers over IPC, is killed when idle": SLEEP, controlled: no. **move-slow** (risk: high). A real fork with idleMs 150, then a fixed tick(600) and expect signal()==="SIGKILL". signalCode is set only once the child's exit is processed (poll phase). If the process is descheduled past ~450 ms, the idle and 600 ms timers fire in the same timers phase before the exit is seen and the check fails. Also: wait on the adapter's exit promise instead of tick(600) (risk: high)

#### `server/src/tests/translate.test.ts`

- **255-264** "ignores a translation whose source text changed during the run": SLEEP, controlled: no. **rewrite:deferred** (risk: high). echoDelay 0.3 is a real 300 ms sleep in requestEcho (llm/request.ts:1023). The chatBatch edit must land inside it, or the run is applied rather than ignored. Hold the provider with a latch instead (as the fake-request-layer section does). Risk: high
- **266-292** "joins a run in flight (one run, the same result ...)": SLEEP, controlled: no. **rewrite:deferred** (risk: high). The joiner, the binding-mismatch request and runningCount()==1 must all happen within the real 300 ms Echo sleep. After a stall the joiner starts its own run. Risk: high
- **304-312** "refuses a message a generation owns ... lock taken meanwhile": SLEEP, controlled: no. **rewrite:deferred** (risk: high). lockingJob + createJob + held must finish inside the 300 ms Echo sleep for the write to conflict with 409 generating. Under a stall the translation lands first. Risk: high
- **382-398** "maintenance ends a run at once (503, Retry-After) ...": SLEEP, controlled: no. **rewrite:deferred** (risk: high). withMaintenance must begin before the 300 ms real Echo sleep ends, or the run answers 200. Line 397 then polls 2000 ms of real time for that sleep to settle. Risk: high
- **419-433** "shutdown ends a run (503) ...": SLEEP, controlled: no. **rewrite:deferred** (risk: high). beginShutdown must fall inside the 300 ms Echo sleep, and workingCount()==1 at line 431 asserts the sleep is still running. Dispose's DRAIN_WAIT_MS of 5000 ms is real too. Risk: high
- **510-525** "a run outlives its HTTP request ...": SLEEP, controlled: no. **rewrite:deferred** (risk: high). Real listen + fetch. The abort and runningCount()==1 at line 523 must land inside the 300 ms Echo sleep, and line 525 polls 2000 ms of real time for it. Risk: high
- **200-205** "jobEnded() poll": POLL, controlled: partial. **keep-poll** (risk: low). A hand-rolled 2000 ms real-Date.now cap on in-process app.request status reads after release(). The loop checks the condition before the deadline, so a stall rarely trips it. Risk: low
- **601-611,837-846,857-862,870-885,1270-1284,1722-1730,1742-1749** "createTranslationRunner over a fake request layer": CLOCK, controlled: yes. **keep-det** (risk: low). Deferred answers. until() counts setImmediate turns, not time. Date is faked wherever the deadline is read (toFake includes "Date"). The real 10-min deadline timer in the Date-only tests never fires. Risk: low

#### `server/src/tests/triggerRuntime.test.ts`

- **1404-1408** "runs v2Command ... and v2Wait as an abortable sleep": DUR, controlled: partial. **rewrite:other(drop the elapsed < 5000 check; the 30 s v2Wait already overruns the default 5 s test timeout if the sleep ignores abort)** (risk: low). Date.now elapsed on a real 30 s sleep aborted by a real 20 ms timer; fails only on a >5 s stall, which the default test timeout also hits; catches nothing extra (risk: low)
- **1524** "ends an endless loop with the limit": TMO, controlled: partial. **keep-accepted** (risk: low). 30 s bump for a CPU-bound effect-limit loop; idle 159 ms (~190x margin) (risk: low)

#### `shared/tests/translatorHistorySlots.test.ts`

- **172** "counts each block once, one after another": SLEEP, controlled: yes. **keep-det** (risk: none). 1 ms delay inside the countTokens mock to expose overlap; no competing timer or assertion on time; risk none

#### `shared/tests/translatorPipeline.test.ts`

- **398** "runs the chunks one after another": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(1) inside a fake translator only creates an await gap; any overlap trips inFlight synchronously, so the result does not depend on timing (risk: low)

#### `src/lib/ChatScreens/Chat.draft.test.ts`

- **203;220;250;269;287;295;304** "whenRendered ..." / "original message draft": POLL, controlled: yes. **keep-poll** (risk: low). The fake setTimeout leaves Date real, but Chat.svelte's render path reads no clock; vi.waitFor waits on a mocked async ParseMarkdown (in-process promise chain), with only the 1 s cap as real time (risk: low)

#### `src/lib/ChatScreens/Chat.test.ts`

- **273,329,335,350,356,394,414,417,421,424,466,552,555,574,597,599,606,607,610,617,619,621,644,646,743,766,783** branching / Disable toggles / stored path / rendered path tests: POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor (1 s cap) over Svelte render + mocked async parser/transport; production real timers on the path (Chat.svelte sleep(1) at 1509, ChatBody 10 ms timers at 219/283) are armed before the 50 ms poll and expire first; risk low
- **536,568,760,775** "with the flag on but no target language ..." / "the toggle requests a translation ..." / "on `rendered`, toggling the chat's flag ...": SLEEP, controlled: partial. **rewrite:other(replace the 50/150 ms sleeps with a deterministic flush of the known in-process chain)** (risk: low). 50-150 ms sleeps before "nothing happened" checks; under load they can only false-pass (miss a regression), not fail; risk low
- **636-637,655-656** "Retranslate confirms with the message captured before the dialog ...": SLEEP, controlled: yes. **keep-det** (risk: none). tick + setTimeout(0) after a mocked confirm resolves: the click handler's continuation is microtasks only, with no I/O; negative check; risk none

#### `src/lib/ChatScreens/ChatBody.assets.svelte.test.ts`

- **50** settle() in both "ChatBody image asset fallback" tests: SLEEP, controlled: yes. **keep-det** (risk: none). flushSync + setTimeout(0): every awaited dependency is a mocked async function (ParseMarkdown, getFileSrc), sleep is mocked, and the translation timers are not on this path; risk none

#### `src/lib/ChatScreens/ChatBody.svelte.test.ts`

- **58,64-94** "whenRendered waits for the auto-translate flip" / "keeps the newest render's body": CLOCK, controlled: yes. **keep-det** (risk: low). toFake only setTimeout but ChatBody.svelte reads no Date/performance and util sleep is mocked; settle's setTimeout(0) follows an in-process deferred parse + Svelte render; risk low

#### `src/lib/ChatScreens/Chats.rows.svelte.test.ts`

- **350** "keeps the cap or visible rows plus a page (%i existing visible rows)": CLOCK, controlled: no. **rewrite:fake-timers** (risk: med). trim retires 25-51 rows through disposeRetired, which has a real performance.now() 4 ms budget per real rAF frame (no fake timers in this describe); vi.waitFor's 1 s real cap must cover all frames; a deschedule breaks the budget and stretches the frames; fake rAF + stub performance.now (or advance frames) (risk: med-low)
- **474-1016** opening row reveal / staged mounting describes: CLOCK, controlled: yes. **keep-det** (risk: none). toFake setTimeout/rAF only, but the 1200 ms reveal and 3000 ms mount deadlines are setTimeout-based (Chats.svelte:213,565); the only real-clock reader (disposeRetired) is not reached by these describes

#### `src/lib/ChatScreens/PartialEditController.test.ts` (2026-10-18 fixed file)

- **105,123,152,168,265,273,280,307,308,320,358,381,393,407** all tests (opened/start/dragStart/choose helpers, save waits): POLL, controlled: partial. **keep-poll** (risk: low). vi.waitFor real 1 s cap on in-process work only: Svelte render, promise chains, happy-dom rAF (real setImmediate, BrowserWindow.js:2123); each check advances fake setTimeout 50 ms; risk low
- **104,109-110,195,241,330-342** focus/scroll/debounce timers: SLEEP, controlled: yes. **keep-det** (risk: none). only setTimeout/clearTimeout faked; the controller reads no Date/performance (its timers: svelte:334,338,633 and rAF 563); the no-settle test's scroll-not-yet assertion holds because the modal opens within <=2 waitFor checks (<=100 fake ms < 210); risk none

#### `src/lib/Others/RequestLogs/ServerRequestHistory.test.ts`

- **102-103,110** all (settle): CLOCK, controlled: yes. **keep-det** (risk: none). vi.useFakeTimers() with no toFake (Date/performance faked); settle = advanceTimersByTimeAsync(0)

#### `src/lib/Setting/Pages/Advanced/DiagnosticsPanel.test.ts`

- **41,48,139** settle() / "Copy copies the report shown and says so briefly ...": CLOCK, controlled: yes. **keep-det** (risk: none). vi.useFakeTimers() with no toFake fakes Date too (stamped download name, the 1500 ms notice); all I/O mocked; risk none

#### `src/lib/Setting/Pages/MemorySettings.hypaV3Export.test.ts`

- **75,106,129,135** "settle()": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) after click handlers whose async work is only mocked promises (downloadFile, selectSingleFile), with no I/O. The macrotask runs after the microtasks drain. Risk: low

#### `src/lib/Setting/Pages/Module/ModuleSettings.share.test.ts`

- **90,97,110,111,119,120,133,134** (module share button tests): POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor and one setTimeout(0) over mocked exporters/alert store, in-process only; risk low

#### `src/lib/Setting/botpreset.test.ts`

- **137,144,327,345,357** delete flows (settle): SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) after a mocked confirm (resolved promise) and in-process store writes; known-depth microtasks, no I/O (risk: low)

#### `src/lib/Setting/botpresetArchive.test.ts`

- **50,281,289** settle() = setTimeout(0) after a mocked confirm: SLEEP, controlled: yes. **keep-det** (risk: low). one macrotask flush after an in-process promise chain (mocked alertConfirm, no I/O); risk low

#### `src/lib/SideBars/CharConfig.emotions.test.ts`

- **245,260** "deletes while another row's input is pending ... without a throw": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) lets Svelte's bind_value tick read and any unhandledRejection surface; in-process only, no I/O (risk: low)

#### `src/lib/SideBars/ChatNoteEditor.test.ts`

- **107,96,136-229** "token counting debounce/idle": CLOCK, controlled: yes. **keep-det** (risk: low). vi.useFakeTimers() with no toFake fakes every timer method and Date. requestIdleCallback is stubbed and fired by hand. Risk: low

#### `src/lib/SideBars/LoreBook/LoreBookList.test.ts`

- **100-103** settle() used by "LoreBookList rows keyed by entry": SLEEP, controlled: yes. **keep-det** (risk: low). tick + setTimeout(0): the awaited work is the mocked alertConfirm, the LoreBookData delete promise chain and Svelte flushes (no I/O); unhandledRejection is emitted before timers. The component's own rAF/10 ms waits are not asserted on (risk: low)

#### `src/lib/SideBars/SideChatList.test.ts`

- **218,301,307,336,340,373,378,394,399,425,431,548** (folder/color/reorder tests): POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor and setTimeout(0) over mocked alerts and Svelte render, in-process only; risk low

#### `src/lib/UI/NanoGPTDashboard.test.ts`

- **37** settle() in "NanoGPTDashboard" tests: SLEEP, controlled: yes. **keep-det** (risk: none). setTimeout(0) after resolving a deferred mocked nanogpt call; in-process chain only; risk none

#### `src/ts/alertTerminal.test.ts`

- **33-38** "settled()": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) only after in-process promise resolution, and the asserted paths do not reach alert.ts's sleep loops. Risk: low

#### `src/ts/assetList.test.ts` (2026-10-18 fixed file; **heap-memory-reduction modifies this file**)

- **145-173** "reuses 100k cached names across successive queries for both record owners": PERF, controlled: no. **rewrite:other(shrink to ~1-5k assets; the toBe identity guard is size-independent)** (risk: low-med). the <3s bound was deleted; remaining budget is the default 5 s timeout over 2x100k tracked records + 80 full 100k-name scans (307 ms idle, ~3 s at 9x plus a 1-3 s deschedule); risk low-med

#### `src/ts/bootstrap.serviceWorker.test.ts`

- **58,66,96** beforeAll import + loadData tests: TMO, controlled: partial. **keep-accepted** (risk: low). beforeAll 60 s for the cold import; each test does vi.resetModules + re-import under the default 5 s (measured 43-270 ms); sleep mocked, setTimeout faked, Date only read for 3-day trash age (risk: low)

#### `src/ts/characterCards.share.test.ts`

- **131-135** "beforeAll warm import": TMO, controlled: partial. **keep-accepted** (risk: low). The cold module graph imports under a 60_000 hook timeout (about 2.5 s idle, 24x margin), which keeps per-test boots at about 0.1-0.4 s under the 5 s default. Risk: low
- **140,189,218** "announces a shared module ... once the save is acknowledged": SLEEP, controlled: partial. **keep-det** (risk: low). advanceTimersByTimeAsync(2000) drives the faked save debounce, and the pending answer is a latch (held). Date is real, but no backoff expiry is asserted. The progress depends on timer and yield counts, not wall time. Risk: low

#### `src/ts/characterCardsCharxImport.test.ts`

- **109** beforeAll cold imports: TMO, controlled: partial. **keep-accepted** (risk: low). 60 s budget for first import of stores/database/characterCards (transform ~3 s idle); per-test boot ~60 ms; risk low
- **95,114,180,338,342,415** fake timers without Date, util.sleep mocked: CLOCK, controlled: yes. **keep-det** (risk: none). upload waits and 180 s advance are setTimeout-based; resourceSync Date.now backoff/jobBlocked paths are not reached (flushResources explicit); checked, controlled

#### `src/ts/characterCardsImport.test.ts`

- **130** beforeAll module-graph warm-up (60_000): TMO, controlled: no. **keep-accepted** (risk: low). Same warm-up pattern: transform is about 3 s alone. Per-test boot takes at most 0.4 s (the first JSON V2 test, about 3.6 s at 9x, close to the default 5 s if a stall adds to it). risk: low
- **200-204** "a card is prepared as a creation ..." (creation_date >= started): CLOCK, controlled: yes. **keep-det** (risk: none). Real Date.now is read once before and once inside the import, and only monotonic order is asserted. risk: none

#### `src/ts/characterCardsPngImport.test.ts`

- **156;265** "imports a stream once, pulls only as asset batch writes allow" / "readGenerator drops consumed bytes": PERF, controlled: no. **rewrite:raise-timeout** (risk: med-high). CPU-heavy work in the default 5 s timeout: 764 ms when idle (12x256 KiB chunks, base64, toEqual) and 558 ms (32-asset stream). At 1/9 CPU that is about 6.9 s and 5 s. Shrinking the fixtures would also do (risk: med-high)
- **136;174-177;320** "imports a stream once" (fake-timer advances): CLOCK, controlled: yes. **keep-det** (risk: low). toFake leaves Date real, but no Date/performance read on the import path matters (the only one is the card's modification_date); advances of 0 only drain in-process streams (risk: low)

#### `src/ts/characterCardsRealmImport.test.ts`

- **202** beforeAll module-graph warm-up (60_000): TMO, controlled: no. **keep-accepted** (risk: low). Same as above: compile about 3 s alone. Per-test boot takes at most 0.39 s. risk: low
- **492-499** "shows the download and commit alerts only without forceRedirect ...": SLEEP, controlled: yes. **keep-det** (risk: none). advanceTimersByTimeAsync(0) flushes in-process ReadableStream/fake-server promise chains. The client progress path reads no clock. risk: none

#### `src/ts/characterCardsRoundTrip.test.ts`

- **154,163-404** every test (boot = resetModules + bootMutations): TMO, controlled: partial. **rewrite:raise-timeout** (risk: med). cold imports are warmed in beforeAll (60 s), but each test re-evaluates the store graph and builds a 40-entry zip under the default 5 s; idle 872 ms for the first case, ~9x under 1/9 CPU share (risk: med)
- **91,159,221-229** "holds about ten decoded unsaved assets...": SLEEP, controlled: yes. **keep-det** (risk: low). fake setTimeout/interval, advanceTimersByTimeAsync(0) over in-process unzip on an ArrayBuffer; util.sleep mocked; the counts do not depend on time (risk: low)

#### `src/ts/characters.test.ts`

- **59-92,109,120** "saves the trash time..." (first test): TMO, controlled: no. **rewrite:other(warm the module graph in beforeAll with a raised hook timeout, and raise the per-test timeout for the resetModules re-evaluation)** (risk: high). boot() does vi.resetModules and cold dynamic imports of resourceSync/bootstrap/characters inside the test under the default 5 s; measured 2220 ms idle (transform 2.5 s), certain to overrun under 1/9 CPU (risk: high)
- **96** fake timers: CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/interval faked; Date real but trashTime only checked as any Number; no TTL/backoff path reached (risk: none)

#### `src/ts/charactersCapture.test.ts`

- **100** beforeAll cold imports: TMO, controlled: partial. **keep-accepted** (risk: low). 60 s budget for cold module imports; tests themselves use frozen fake timers and explicit flushResources; risk low

#### `src/ts/diagnostics/collector.test.ts`

- **282-376,508-525,589,674,682** ring folding / write timer / http events: CLOCK, controlled: yes. **keep-det** (risk: none). The ring tests fake setTimeout and Date (setSystemTime). The real-timer http tests fold within a real 10 min FOLD_MS window and assert durationMs >= 0. setTimeout(20) at 674 waits for Node's unhandledRejection, which fires after the microtasks and before any timer. risk: none

#### `src/ts/diagnostics/report.test.ts`

- **164-169,280-314** "bounds the whole save: past the wait before a dispatch it is `network`...": CLOCK, controlled: yes. **keep-det** (risk: low). full vi.useFakeTimers() (Date incl.); report.ts deadlines are setTimeout-based, no AbortSignal.timeout; risk low

#### `src/ts/exportBatches.test.ts`

- **789-803** "refuses as the over-cap batch arrives and cancels the pending read": PERF, controlled: no. **rewrite:other(inject a smaller export cap, or raise the timeout)** (risk: med). It allocates two 32 MiB halves plus 198 more assets (64 MiB cap) under the default 5 s timeout. It takes 1.14 s alone, about 10 s at 9x with memory pressure. The 64 MiB "exactly" test at 765 is lighter but the same kind. risk: med
- **77,275-287,646,665,692,802** export batch / retry tests: CLOCK, controlled: yes. **keep-det** (risk: none). flush = advanceTimersByTimeAsync(0) on in-process fake-server promises. The 180_000 advances only check that nothing more happens. A real-Date resourceSync backoff, if one arose, could only make a retry earlier, never later. risk: none
- **208** beforeAll module-graph warm-up (60_000): TMO, controlled: no. **keep-accepted** (risk: low). A cold transform plus import of about 3-4 s alone, about 30 s at 9x, against 60 s. risk: low

#### `src/ts/globalApiRetention.test.ts`

- **171-282,306-472** "held file sources / risuCache": CLOCK, controlled: yes. **keep-det** (risk: low). The release grace is a setTimeout only (FILE_SOURCE_RELEASE_GRACE_MS), and setTimeout is faked. Lookups are deferreds. Date is not read on these paths. Risk: low

#### `src/ts/network/auxFetch.test.ts`

- **54 (settle at 93-419)** (auxFetch barrier/interceptor tests): SLEEP, controlled: yes. **keep-det** (risk: low). settle = setTimeout(0) after in-process deferreds and mocked authFetch/resourceSync; no I/O; unhandledRejection is emitted before the next macrotask; risk low

#### `src/ts/network/eventFeed.test.ts`

- **81,104-326** reconnect backoff / token refresh: CLOCK, controlled: yes. **keep-det** (risk: none). fake setTimeout + Date; eventFeed.ts uses only setTimeout; Date.now in the JWT mock and the 6-minute loop read the faked clock (risk: none)

#### `src/ts/network/generationJobs.test.ts`

- **107-109,634,712,718,726,760,776** settled()/flush(); "tries again with a doubling wait, capped at 15 s ...": CLOCK, controlled: yes. **keep-det** (risk: none). The retry backoff is setTimeout-only (generationJobs.ts:462-464, no Date read), so faking setTimeout/clearTimeout controls it; flush/settled run over FakeSocket and mocked auth in-process; the attach stamp is forced monotonic (+0.001); risk none
- **870** "hands channel events to the lazily loaded dispatcher ...": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on the lazy import("./jobChannel"), a vi.mock factory module (in-process; at most a module-runner resolve); risk low

#### `src/ts/network/generationJobsDelta.test.ts`

- **71,140,143,158,191,216,235** "delta replies in the real tab mirror": CLOCK, controlled: yes. **keep-det** (risk: none). Timers faked without Date; the stream frame runs through happy-dom requestAnimationFrame = real setImmediate (BrowserWindow.js:2122), which runs in the check phase before advanceTimersByTimeAsync's original-setTimeout yield; resourceSync schedule() reads Date.now only within one synchronous step and no backoff path is hit; risk none
- **87 (boot), 134 (first test)** reconstructs a continued UTF-16 reply and a trim from buffered text wh: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2165 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/network/jobChannel.test.ts`

- **111,227,234,868,1105** pump()/fake timers; provider describe fakes Date: CLOCK, controlled: yes. **keep-det** (risk: none). the only real-clock read (PROVIDER_CHUNK_INTERVAL_MS via Date.now, jobChannel.ts:763-772) is reached only in "the provider callback" describe, which adds "Date" to toFake; checked, controlled
- **232 (boot), 279 (first test)** shows a question, answers it with the alert's raw value, and holds a t: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: low-med). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 842 ms idle (one isolated run, Vitest JSON reporter) against the 10 s default hookTimeout (import in beforeEach); at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: low-med

#### `src/ts/network/jobChannelBarrier.test.ts`

- **98,110,208,235,240** all callback tests: POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on in-process barrier work (flushResources straight to StoreBackedServer, no debounce timer); the callback's real Date.now()+60 s deadline is never read client-side

#### `src/ts/network/pushNotifications.test.ts`

- **145-148** all (settle): SLEEP, controlled: yes. **keep-det** (risk: low). 12x setTimeout(0) over mocked authFetch/registration promise chains (no I/O); REGISTRATION_TIMEOUT_MS 10 s races a pre-resolved ready, so the microtask wins deterministically (risk: low; the flush count is a guess)

#### `src/ts/observer.markers.test.ts`

- **31-37,48,58** BGM mutation filtering: CLOCK, controlled: yes. **keep-det** (risk: none). vi.useFakeTimers() with no toFake fakes Date too (observer.svelte.ts:165); happy-dom's real MutationObserver delivery is drained by takeRecords in settle() (risk: none)

#### `src/ts/observer.test.ts`

- **31-54,72** full fake timers; happy-dom MutationObserver records delivered by flushMutations: CLOCK, controlled: yes. **keep-det** (risk: low). vi.useFakeTimers() fakes Date too (observer.svelte.ts:165); records are taken synchronously before any yield, so happy-dom's own real timer finds nothing; risk low

#### `src/ts/parser/tests/cbs/limits.test.ts` (2026-10-18 fixed file)

- **71-80** "the budget starts over for the next top-level parse" / "a non-advancing range answers []": CLOCK, controlled: no. **rewrite:injected-clock(call stopClock() as the sibling tests do)** (risk: low). CLIENT_CBS_LIMITS reads the real performance.now (2 s per parse). toThrow(CbsLimitError) accepts either reason, but a 2 s stall inside a later tiny parse would throw (risk: low)
- **52-68,83-93** stopClock tests: CLOCK, controlled: yes. **keep-det** (risk: none). performance.now is stubbed to 0, so only the work limit can end the parse (risk: none)

#### `src/ts/parser/tests/transformClient.test.ts`

- **180;185;412-414;662-664;688-703;719-721** "settles every caller within the chunk's 28 s" / "runs no handler ... after the handler deadline" / batch timer: CLOCK, controlled: yes. **keep-det** (risk: low). Bare vi.useFakeTimers() in beforeEach also fakes Date and performance, so the 16 ms batch timer and the 23/24/28 s deadlines move only with the advances; rAF is stubbed (risk: low)

#### `src/ts/personaImport.test.ts`

- **166-168;241-243** "a collection replaced while the icon was being saved" / "exports the persona selected at its start": POLL, controlled: yes. **keep-det** (risk: low). Both loops stop after a set number of turns (100 setImmediate / 100 fake 10 ms advances) with no wall-clock cap; the awaited work is in-process (mocked picker/readImage), so load cannot outrun them (risk: low)

#### `src/ts/plugins/apiV3/hostApi.test.ts`

- **706-729** "delivers no key to a capture or bubbling listener while the notice is shown": SLEEP, controlled: partial. **rewrite:fake-timers** (risk: low). real 150 ms sleep vs production's real random 0-99 ms setTimeout (v3.svelte.ts:417); scheduled earlier with a shorter delay so it fires first even after a stall, and the SandboxHost is mocked (direct callback); deterministic but wall-clock; risk low

#### `src/ts/plugins/apiV3/mcpContext.test.ts`

- **55,210** "runs job mcpList callbacks against B's character...": CLOCK, controlled: yes. **keep-det** (risk: low). Date.now feeds a mocked grant time and a callback deadline (+10 s) that no client code reads (no `deadline` consumer in src/ts/network, process/mcp, plugins); risk low

#### `src/ts/plugins/apiV3/nativeFetch.test.ts`

- **41** permissionStore mock getLastGrantTime: () => Date.now(): CLOCK, controlled: no. **keep-accepted** (risk: low). A real Date.now grant time against the 3-day periodic reconfirm window in v3.svelte.ts:693; the margin is 3 days (risk: low)

#### `src/ts/plugins/apiV3/nativeFetchAbort.test.ts`

- **145-146** "aborts the host fetch after headers while the guest is reading the body": POLL, controlled: partial. **rewrite:deferred** (risk: low-med). vi.waitFor (real 1 s cap) waits for a cancel crossing a node:worker_threads MessagePort, which is delivered in the event-loop poll phase after timers; a >1 s deschedule between postMessage and delivery times out; resolve a latch from the stream cancel instead; risk low-med

#### `src/ts/plugins/apiV3/permissionStore.test.ts`

- **188** "keeps a newer copy this tab came to hold while the refresh's read was out": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor over the in-process FakeResourceServer; risk low

#### `src/ts/plugins/apiV3/permissions.test.ts`

- **102,133,266,346-362** "answers from a stored grant ..." / "hashes the script captured at load" / "answers server provider callbacks ..." / "asks again three days after the last grant": CLOCK, controlled: yes. **keep-det** (risk: none). Real Date.now grant times sit against a 3-day TTL (huge margin); the callback `deadline` is not read by the tab's channel; the periodic test fakes Date; risk none
- **230,270** "returns the aborted failure ..." / "answers server provider callbacks ...": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on a mocked confirm/send over the in-process channel (SandboxHost mocked, flushResources spied); risk low

#### `src/ts/plugins/apiV3/pluginContext.test.ts`

- **110;668;674;866;869** "a read and a write keep the hook's preset across the database consent" / provider prompt: POLL, controlled: yes. **keep-poll** (risk: low). waitFor on mocked alertConfirm prompts; hasher is mocked, so there is no crypto/thread I/O; the 3-day grant window is as in nativeFetch (risk: low)

#### `src/ts/plugins/apiV3/pluginContextSaved.test.ts`

- **73,115** all "plugin context saved" tests: CLOCK, controlled: yes. **keep-det** (risk: none). Timers faked without Date; getLastGrantTime returns now (always fresh); flushes are explicit; resourceSync's Date.now reads (schedule, backoff) are not hit across a fake-time advance; risk none
- **83 (boot), 131 (first test)** setCharacter from a listener of a non-selected character's chat is sav: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2744 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/plugins/apiV3/v3SavedWrites.test.ts`

- **102,107,247** settled(); "... a second flush sends nothing" (advance 2000): CLOCK, controlled: yes. **keep-det** (risk: none). Timers faked without Date; the 500 ms debounce is setTimeout-based with the delay computed within one step; no failure or backoff; the 2000 ms advance is a negative check; risk none
- **80 (boot), 123 (first test)** v3 pluginStorage set, remove, and clear reach the pluginStorage record: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2375 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/plugins/apiV3/v3SetPersonas.test.ts`

- **251** "reaches the live list: the push runs after the image is saved ...": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor until the mocked saveAsset is reached; PngChunk, reencodeImage and the file picker are mocked, in-process; risk low

#### `src/ts/plugins/pluginLifecycle.test.ts`

- **50,268** "serializes overlapping reloads": SLEEP, controlled: yes. **keep-det** (risk: none). setTimeout(0) before a negative check over a mocked sandbox factory; getLastGrantTime Date.now only feeds a 3-day reconfirm window

#### `src/ts/process/chatStatus.test.ts`

- **101,324** "attach() / follow registration": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on a stubbed follow registered through in-process promise chains (sleep is mocked to resolve at once). Risk: low
- **116 (boot), 163 (first test)** generating reacts to the union of followed chats and real server locks: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: med). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1267 ms idle (one isolated run, Vitest JSON reporter) against the 10 s default hookTimeout (import in beforeEach); at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: med

#### `src/ts/process/files/tests/inlays.test.ts`

- **105,295** "missing-id TTL": CLOCK, controlled: yes. **keep-det** (risk: low). toFake ["Date"], applied after the imports. The MISSING_ID_TTL_MS check reads the faked Date.now, and setSystemTime moves it. Imports run in beforeEach under the 10 s hook timeout (about 1 s cold). Risk: low

#### `src/ts/process/imageDelivery.test.ts`

- **251** "preserves newer CharEmotion writes while every backend awaits its image": POLL, controlled: yes. **keep-poll** (risk: none). vi.waitFor (1 s) on `reached`. Every transport is mocked in-process, and comfy /history and wavespeed /result answer done on the first call, so the real 1 s/3 s poll sleeps in stableDiff.ts:577/867 are never reached. risk: none
- **112-124,162** "replaces the displayed image with Imagen ..." / "answers the imggen job callback ...": CLOCK, controlled: yes. **keep-det** (risk: none). The real Date.now range check is monotonic only. The callback deadline of Date.now()+10_000 covers in-process work (10 s margin). risk: none

#### `src/ts/process/lorebookImport.test.ts`

- **100-104** "beforeAll warm import": TMO, controlled: partial. **keep-accepted** (risk: low). A cold import under a 60_000 hook timeout (about 24x margin), so the in-test boots stay small. Risk: low

#### `src/ts/process/lorebookRegexBaseline.test.ts`

- **94** beforeAll fixtures + module-graph warm-up (60_000): TMO, controlled: no. **keep-accepted** (risk: low). A cold compile of about 2.5 s alone against 60 s. The only test takes 0.39 s. risk: low

#### `src/ts/process/mcp/risuaccess/tests/characters.test.ts`

- **102-131,158** every test, first one most: TMO, controlled: no. **rewrite:other(warm the module graph in beforeAll with a raised hook timeout, and raise the per-test timeout)** (risk: high). boot() = resetModules + bootMutations cold dynamic imports inside the test under the default 5 s; measured 2764 ms idle for the first case, 170-290 ms for later ones (risk: high for the first, med for the rest)
- **143** fake timers: CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/interval faked; no Date-based TTL/backoff path asserted (risk: none)

#### `src/ts/process/mcp/risuaccess/tests/moduleWriters.test.ts`

- **106 (boot), 168 (first test)** set-module-info writes the typed fields through updateModule and enabl: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2399 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/process/mcp/tests/mcpLeases.test.ts`

- **72-76** settleMicrotasks() (50 x Promise.resolve): SLEEP, controlled: yes. **keep-det** (risk: low). A microtask-count flush over fake MCP clients with gate promises; no timers or I/O, so the result does not depend on CPU load (a wrong count fails every time) (risk: low)

#### `src/ts/process/mcp/tests/mcpWriters.test.ts`

- **158** (all: toFake timers without Date): CLOCK, controlled: yes. **keep-det** (risk: low). toFake omits Date, but these tests only flush explicitly (flushResources) and never advance timers or hit a backoff/job-retry path; risk low
- **133 (boot), 175 (first test)** adds a module with an id and the MCP url from the server's info, saved: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2783 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/process/mcp/tests/mcplib.test.ts`

- **118-123** until() helper: POLL, controlled: yes. **keep-det** (risk: none). Count-bounded loop (200 x setTimeout 5 ms), with no wall-clock deadline, over a mocked fetch and in-memory streams; slower ticks do not change the outcome; risk none

#### `src/ts/process/mcp/tests/mcplibStreams.test.ts`

- **122-125** all (until): POLL, controlled: yes. **keep-det** (risk: none). until() is bounded by 200 microtask turns, not time; mcplib has no timers or clock reads

#### `src/ts/process/modulesImport.test.ts` (**heap-memory-reduction modifies this file**)

- **225-240,477,562,579,675-705,808-821,943,968** asset retry ladder / "a failed flush ... saved later" / entry tests: CLOCK, controlled: partial. **keep-det** (risk: low). toFake has no "Date". resourceSync.schedule computes deadline and backoffUntil with the real Date.now (resourceSync.svelte.ts:462-474,1416), so after a failure the fake 35 s advance does not reach the backoff in real terms. The explicit flushResources() afterwards forces the save, so the outcome does not depend on the clock, and load only lets the real backoff expire sooner. Adding "Date" to toFake would make it exact, as resourceSyncNotices does. risk: low
- **157** beforeAll module-graph warm-up (60_000): TMO, controlled: no. **keep-accepted** (risk: low). A cold graph compile of about 3-4 s alone, about 30 s at 9x, against 60 s. Per-test boots (resetModules) take at most 0.38 s against the default 5 s. risk: low

#### `src/ts/process/modulesImportPrepare.test.ts`

- **133-137** "beforeAll warm import": TMO, controlled: partial. **keep-accepted** (risk: low). A cold import under a 60_000 hook timeout (about 24x margin). Risk: low

#### `src/ts/process/request/tests/transport.test.ts`

- **212-214,944** "settledOrPending" (inlay signature held): SLEEP, controlled: yes. **keep-det** (risk: low). a setTimeout(0) race decides "pending" only while a deferred holds the signature save; in-process stubs; the 500 ms answer-retry sleep in transport.ts is never reached (answers stubbed ok) (risk: low)

#### `src/ts/process/serverCommands.test.ts`

- **153,305-326** flush() (62 uses); "Nothing replaced: the job's error, with the time the terminal arrived": CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout(0) flushes over fully mocked follows and sync; the restore-watch timestamp test fakes Date (setSystemTime); risk none
- **163 (boot), 199 (first test)** shares one lifecycle per job: two callers get one socket and the same : BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: low-med). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 848 ms idle (one isolated run, Vitest JSON reporter) against the 10 s default hookTimeout (import in beforeEach); at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: low-med

#### `src/ts/process/ttsHooks.test.ts`

- **57-66** "isolates a hook that exceeds the timeout" (and 1000 ms races elsewhere): SLEEP, controlled: partial. **rewrite:fake-timers** (risk: none). runHookPipeline races the hook against a real sleep(timeoutMs); fast hooks win by microtask, the never-resolving one loses after a real 50 ms; correct under load, only slow; risk none

#### `src/ts/process/ttsPlayback.test.ts`

- **210,230,255,268** Stop vs pending provider/decode/VITS: POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor (1 s cap) on mocked in-process calls; deferreds gate the rest; util.sleep mocked (risk: low)

#### `src/ts/router/router.test.ts`

- **1620** "traverses by key and swallows the rejections": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) after a synchronous traverse; Node emits unhandledRejection after the microtask drain and before the timer (risk: low)

#### `src/ts/storage/tests/assetQueue.test.ts`

- **19,31,87,209** (saveAssets / AssetSaveQueue): CLOCK, controlled: yes. **keep-det** (risk: low). full vi.useFakeTimers() with deferreds; globalApi mocked so assetClient's Date.now retry-after is never reached; risk low

#### `src/ts/storage/tests/assetReadQueue.test.ts`

- **120,147** "%s cancels and settles the prefetch..." / "observes a rejected prefetch...": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) after in-process async-iterator promise chains with a deferred read (no I/O) (risk: low)

#### `src/ts/storage/tests/bootCache.test.ts`

- **891-894** "an open that never answers falls back as `timeout` within the bound ...": DUR, controlled: no. **rewrite:fake-timers(fake setTimeout only, keeping setImmediate real; assert pending before 20 ms and `timeout` after advancing 20 ms; drop the elapsed check)** (risk: high). Real 20 ms open timeout plus expect(Date.now() - started).toBeLessThan(1000); a 1 s stall anywhere in loadBootSnapshot fails it; risk high
- **751,791,820,869,915,928,948,968,1006,1034,1062,1084,1102,1120,1150,1152,1165,1173,1208** every test using indexedDbBootCacheStore(APP) (default timeout): CLOCK, controlled: no. **rewrite:other(pass a large timeoutMs, e.g. 60_000, where the timeout is not the subject)** (risk: med). Real BOOT_CACHE_TIMEOUT_MS=3000 on the open and read (bootCache.ts:383,418,466,524) races fake-indexeddb's setImmediate work; after a stall of 3 s or more the expired timer runs before the pending IDB callbacks, giving fallback `timeout` instead of the expected path; risk med (needs a stall of 3 s or more)
- **50,986,1251,1263** tick(); "a fenced clear ..." (50-tick loop); scheduleBootCacheCommit tests: SLEEP, controlled: yes. **keep-det** (risk: none). Count-bounded setTimeout(0) loop over fake-indexeddb (setImmediate-scheduled, in-process); requestIdleCallback is stubbed; event-loop order, not speed, decides; risk none

#### `src/ts/storage/tests/bootSnapshot.test.ts`

- **105 (boot), 143 (first test)** differs only in ids and the id selections: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2795 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/browserLocalImport.test.ts`

- **150-185,193** "boot() in beforeEach (first: inlays > moves a Blob entry ...)": BOOT, controlled: no. **rewrite:raise-timeout** (risk: med). vi.resetModules plus a cold import of resourceSync/bootstrap in beforeEach under the default 10 s hookTimeout. The first case takes 2.3 s idle (about 4x margin). Add a warm beforeAll(..., 60_000) as the sibling files do. Risk: med

#### `src/ts/storage/tests/characterNormalization.test.ts`

- **181-183,243-255,487,698-704** "recognizes a chat create whose answer was lost" / settle() / "prepares a chatless character once": CLOCK, controlled: partial. **keep-det** (risk: low). toFake omits Date and resourceSync schedule()/backoffUntil read real Date.now; at 698 the dropped answer sets backoffUntil = now+2000 and the retry timer's delay in one sync step, so the fake 1500 advance stays below it whatever real time does; creation_date >= started is monotonic; 487 vi.waitFor in-process; risk low
- **77 (boot), 231 (first test)** prepares a chatless character once: its first chat, the greeting index: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2227 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/characterOrderRepair.test.ts`

- **51;195;208;237;262;276;296;318;331;343** awaitReads / order-repair cases: POLL, controlled: yes. **keep-poll** (risk: low). Real timers, readRefs mocked as a queue of deferreds; the repair runs from queueMicrotask with no timers, so the waits are in-process (risk: low)

#### `src/ts/storage/tests/characterOwnership.test.ts`

- **270,311-388** advance 3000 / trashTime vs real Date.now: CLOCK, controlled: partial. **keep-det** (risk: none). trash expiry compares real Date.now against days-scale offsets (4 days vs 3 days); the 3000 ms fake advance is a negative check; risk none
- **51 (boot), 79 (first test)** save one op each on the held revision: a wrapper write, a nested wrapp: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2187 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/characterStore.test.ts`

- **64** "sends a non-selected character's record in the next cycle ..." (first test): PERF, controlled: no. **rewrite:other(beforeAll warm import, 60 s hook timeout)** (risk: high). Same cold first boot inside the test: 2.36 s alone against the default 5 s. Later tests take 0.3-0.46 s. risk: high

#### `src/ts/storage/tests/charxImportClient.test.ts`

- **37** "uploads the original Blob once and streams %i progress lines": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on onProgress fed by a test-controlled in-memory ReadableStream (risk: low)

#### `src/ts/storage/tests/chatBinding.test.ts`

- **73 (boot), 194 (first test)** reads as undefined (never the tab's selection) and refuses a patch as : BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1988 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/chatBindingNewChat.test.ts`

- **196** "inherits from the character's selected chat" (first test): PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout, as characterCardsPngImport does)** (risk: high). The first test pays the cold vi.resetModules + bootMutations import of the whole storage graph in the default 5 s: 2038 ms isolated when idle, so about 18 s at 1/9 CPU; later tests take about 50 ms (risk: high)

#### `src/ts/storage/tests/chatBindingPick.test.ts`

- **92 (boot), 170 (first test)** at home an undefined target is the tab's selection, per field; a gone : BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1881 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/chatBindingReaders.test.ts`

- **113** "read the ref's bound persona" (first test): PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold module-graph boot in the first test: 2688 ms isolated when idle, in the default 5 s (risk: high)

#### `src/ts/storage/tests/chatBindingViews.test.ts`

- **203** (all: toFake timers without Date): CLOCK, controlled: yes. **keep-det** (risk: low). toFake omits Date, but no test advances timers or reaches a Date-based sync path (views/binding reads only); risk low
- **146 (boot), 216 (first test)** the selected chat's bound records win per field; the tab's selection a: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1827 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/chatLazyLoading.test.ts`

- **227,255** runTrim(); all tests (timers faked without Date): CLOCK, controlled: yes. **keep-det** (risk: none). The trim is a setTimeout(0) (chatStore.svelte.ts:5309) run by runOnlyPendingTimers; no test hits the Date.now-based JOB_RETRY_MS block (chatStore 1797/3992) or the sync backoff; held reads use a gate/deferred; risk none
- **94 (boot), 271 (first test)** exposes a persisted pin in list entries before and after loading the c: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1882 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/chatProjection.test.ts`

- **98-101** "beforeAll warm import": TMO, controlled: partial. **keep-accepted** (risk: low). A cold import under a 60_000 hook timeout (about 24x margin). Risk: low

#### `src/ts/storage/tests/chatStore.test.ts`

- **189** "updates the mirror synchronously from detached copies ..." (first test): PERF, controlled: no. **rewrite:other(warm the module graph in a beforeAll with a 60 s hook timeout, as characterCardsImport does)** (risk: high). No warm-up: the first test's boot (vi.resetModules plus dynamic import of the storage graph) takes 1.8 s alone against the default 5 s timeout. About 9x under 1 CPU + 8 burners, so it times out. In a full run the transforms may already be cached, which lowers but does not remove this. risk: high

#### `src/ts/storage/tests/collectionStore.test.ts`

- **38-45,67-579** every test (boot = resetModules + bootMutations): TMO, controlled: no. **rewrite:other(warm the module graph in beforeAll with a raised hook timeout, and raise the per-test timeout)** (risk: high). cold dynamic imports inside the first test under the default 5 s: measured 2209 ms idle; later re-evaluations 50-506 ms idle, ~9x under 1/9 CPU share (risk: high for the first, med for the rest)
- **50** fake timers: CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/interval faked; Date-based backoff/JOB_RETRY paths in resourceSync not exercised by assertions (risk: none)

#### `src/ts/storage/tests/moduleCache.test.ts` (2026-10-18 fixed file; **heap-memory-reduction modifies this file**)

- **120-137** "resolves a remote replacement immediately and wakes tracked readers": TMO, controlled: no. **rewrite:raise-timeout** (risk: high). first case pays the cold vi.resetModules + bootMutations graph import (2.54 s idle) under the DEFAULT 5 s timeout; the same cold boot needed 60 s in resourceSyncFieldCache under the overload; risk high
- **297-322** "enables 100k assets in one flush and reuses their plain copy": PERF, controlled: no. **rewrite:raise-timeout** (risk: med-high). the <300ms bound was deleted but the default 5 s timeout is now the implicit budget: 765 ms idle (warm boot + 100k assets twice), ~7 s at 9x; the identity check (toBe(first)) does not need the deadline; keep 100k only if it guards a spread/stack limit, else shrink; risk med-high
- **139-295,325-411** remaining module cache / reload tests: TMO, controlled: no. **rewrite:raise-timeout** (risk: low). each re-boots the graph after vi.resetModules under the default 5 s timeout (64-245 ms warm, ~0.6-2.2 s at 9x); ok in file order, cold (~2.5 s) if run alone; risk low
- **109** all (fake timers without Date): CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/setInterval faked without Date; modules/collectionStore paths read no clock and the tests call flushResources/flushSync directly; risk none

#### `src/ts/storage/tests/moduleImportClient.test.ts`

- **40,89-108** "streams %i progress lines..." / "preserves the failure type without retrying": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on an in-process web ReadableStream parse; the no-retry cases run under full fake timers (180 s advance); risk low

#### `src/ts/storage/tests/mutationScope.test.ts`

- **48,75,76,113,114** "reports a discard raised by a cycle that ran before the flush ..." / "covers the chat discard sequence too ...": POLL, controlled: yes. **keep-poll** (risk: low). A fake 600 ms advance fires the 500 ms debounce (delay computed within one step, so real Date does not matter); vi.waitFor advances fake timers and polls the in-process fake server; risk low
- **38 (boot), 69 (first test)** reports a discard raised by a cycle that ran before the flush was call: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2298 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/personaModuleLinks.test.ts`

- **74 (boot), 126 (first test)** adds the bound persona's links by id only, once each, in stored order,: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2635 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/personaViews.test.ts`

- **343,362,391** "selectUserImg" tests: POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor until the mocked saveAsset; picker, PngChunk and reencodeImage are mocked, in-process; risk low

#### `src/ts/storage/tests/pluginStorageStore.test.ts`

- **64;87** "sets, reads a detached copy" (first test) / "refuses a value that is not JSON data": PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). First test cold boot 2329 ms when idle; the second does 13 refused flushes in 432 ms of CPU (about 3.9 s at 1/9 CPU), both in the default 5 s (risk: high / med)

#### `src/ts/storage/tests/projectionBindings.test.ts`

- **2015,2016** "1,000 sequential nested writes into the 300-entry character": PERF, controlled: no. **move-slow** (risk: low-med). the median ratio of tracked vs direct write time (real performance.now over 9 rounds) must be < 10; cost is the subject, and direct is a sub-ms sample that load noise can distort; also runs execSync("uname -a") for the report (risk: low-med)
- **1446,1474,1721** proof 14 / round 2 point 4 / round 2 point 1: POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on in-process held batch (releaseBatch); nextTask setTimeout(0) only closes the same-task window

#### `src/ts/storage/tests/records.test.ts` (**heap-memory-reduction modifies this file**)

- **40,77,104** "refuses to re-insert a removed element's wrapper ..." / "changes nothing when a later inserted value cannot be unwrapped": SLEEP, controlled: yes. **keep-det** (risk: none). The displacement expires through queueMicrotask (records.svelte.ts:1196), so setTimeout(0) always outlasts it; risk none

#### `src/ts/storage/tests/resourceSync.test.ts`

- **130** "writes nothing after boot when the mirror equals the server" (first test): PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold resetModules boot of resourceSync and the stores in the first test: 2297 ms isolated when idle, in the default 5 s (risk: high)
- **233;279** "keeps an edit made while its batch is in flight dirty" / "saves a character added while a batch is in flight": POLL, controlled: partial. **rewrite:fake-timers** (risk: med). The next save cycle is the 500 ms DEBOUNCE fake timer. vi.waitFor advances fake time only 50 ms per real 50 ms poll, so it needs 10 polls (measured about 600 ms) inside a 3000 ms real cap; each deschedule costs polls. Use advanceTimersByTimeAsync(500), then assert (risk: med)
- **226;242;275;417;563;607;657;768** releaseBatch / repair append / reload waits: POLL, controlled: yes. **keep-poll** (risk: low). The work is in-process (fake server, held batch, queueMicrotask repair, mocked alertTerminal); it settles in one or two polls (about 45 ms), so a deschedule still leaves the interval to fire before the cap (risk: low)
- **749-768** "keeps waiting through old-epoch answers, a 503, and a network failure": CLOCK, controlled: partial. **keep-accepted** (risk: low). watchForRestore's 120 s deadline and its 5 s read budget read the real Date.now (Date is not faked here, unlike line 776); the margin is about 120 s against a run of under 1 s. Adding "Date" to toFake would make it exact (risk: low)
- **652-821** restore-watch / quarantine fake-timer advances: CLOCK, controlled: yes. **keep-det** (risk: low). 413/400 failures leave backoffUntil 0 (no real-clock backoff); line 776 also fakes Date for the watch deadline; flushResources ignores backoff (risk: low)

#### `src/ts/storage/tests/resourceSyncAbsentSingleton.test.ts`

- **91,110-160** all: CLOCK, controlled: yes. **keep-det** (risk: none). toFake without Date, but no failure/backoff or job-retry path is reached (backoffUntil stays 0)
- **54 (boot), 107 (first test)** adopts the first remote creation from the live update and updates it w: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2449 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/resourceSyncChats.test.ts`

- **145** "hydrates the chats without echoing anything back" (first test): PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold module-graph boot in the first test: 2438 ms isolated when idle, in the default 5 s (risk: high)
- **233;269** "renames a message id the server refuses" / "keeps a chat edit made during a request queued": POLL, controlled: partial. **rewrite:fake-timers** (risk: med). Waits for the 500 ms debounced next cycle by vi.waitFor's 50 ms fake advance per real poll (measured 601/619 ms) inside a 3000 ms real cap (risk: med)
- **379-382;1010** "defers the conflict of a chat a server job streams into" / "re-anchors the append of a chat a server job streams into": POLL, controlled: partial. **rewrite:fake-timers** (risk: low-med). The same debounce-by-waitFor coupling (measured 559/568 ms, 10 polls) under a 5000 ms cap (risk: low-med)
- **226;243;249;263;411;457;672;673;678;716;743;823;847;899;1029;1033;1161;1163;1433** held-batch, idle-read and keepalive waits: POLL, controlled: yes. **keep-poll** (risk: low). In-process fake server; these settle in one or two polls (about 50 ms: REMOTE_DELAY or in-cycle idle reads, fake keepalive fetch); line 249 is a controlled fake advance (risk: low)
- **289-336** "sends more than 5,000 unsent ops of one chat" / "bases a reorder sent in a later request": PERF, controlled: no. **rewrite:raise-timeout** (risk: low-med). 5,000-op loops take 311/196 ms of CPU when idle, about 2.8 s/1.8 s at 1/9 CPU, in the default 5 s (risk: low-med)

#### `src/ts/storage/tests/resourceSyncDiagnostics.test.ts`

- **91,152** "records `sync reload restore` ..."; "counts every conflict ... generating": POLL, controlled: yes. **keep-poll** (risk: low). Timers faked without Date; vi.waitFor advances fake timers and polls an in-process fake server; the "generating" 409 sets the Date.now-based JOB_RETRY_MS block, but nothing is asserted across time afterwards; risk low
- **60 (boot), 103 (first test)** records one `sync conflict` with the counts by category for a 409 anot: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2315 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/resourceSyncFeedPatches.test.ts`

- **187-188** "applies a loaded idle patch immediately ...": BOOT, controlled: no. **rewrite:raise-timeout** (risk: high). The first test's boot() pays the cold module-graph import inside the test: 2.24 s idle against the default 5 s timeout. It times out under overload. Fix with a warm beforeAll import (60_000 hook). Risk: high
- **152,205,253-258,296,436-468** "feed patches fake-timer advances": CLOCK, controlled: yes. **keep-det** (risk: low). toFake includes "Date", so the job-retry and backoff deadlines move with the advances. Risk: low

#### `src/ts/storage/tests/resourceSyncFieldCache.test.ts` (2026-10-18 fixed file)

- **71,139,204,338** "cache reuse" / "every write path" / "the challenge's reproductions" describes: TMO, controlled: no. **rewrite:other(import the client/store graph once in a beforeAll with a hookTimeout so cases do not race the cold transform)** (risk: med). INTEGRATION_TIMEOUT=60_000 raced against vi.resetModules + full graph import: first case 3.26 s idle (cold transform), later ones 50-260 ms; the file's own comment records >30 s under the overload, so margin is only ~2x; risk med
- **487-569,571-592** "fixed shapes ..." / "120 pseudo-random shapes ...": TMO, controlled: no. **rewrite:raise-timeout** (risk: low). these boot too but have no INTEGRATION_TIMEOUT: fixed shapes uses the default 5 s (71 ms warm, ~3 s cold if run alone with -t), 120 shapes uses 20 s (583 ms warm, ~5 s at 9x); safe only because earlier cases warm the graph; risk low (med when filtered)
- **128** all (fake timers without Date): CLOCK, controlled: yes. **keep-det** (risk: none). toFake excludes Date, and resourceSync reads Date.now for schedule/backoff/jobBlocked (resourceSync.svelte.ts:462-473,899,1416), but those only matter after failures or 409s, which no case produces; flushResources runs runCycle directly; risk none

#### `src/ts/storage/tests/resourceSyncHydration.test.ts`

- **310-311** "applies a newer record without echoing it back ...": BOOT, controlled: no. **rewrite:raise-timeout** (risk: high). The first test's in-test boot() pays the cold import: 2.26 s idle against the 5 s default. Add a warm beforeAll import. Risk: high
- **1975-2010** "applies an empty equal-revision patch and an append on a very large chat": PERF, controlled: no. **rewrite:other(shrink count; the object-identity checks already prove no read or rewrite) or raise-timeout** (risk: med). A 150_000-message chat built and hydrated in 1.6 s idle against the default 5 s timeout. Risk: med
- **294,493,608,778,899-1102** "fake-timer job retry / stream frames": POLL, controlled: yes. **keep-poll** (risk: low). Date is faked for JOB_RETRY_MS. The vi.waitFor calls wait for stream frames scheduled by happy-dom rAF (real setImmediate, in-process). The setTimeout spies count calls, not time. Risk: low

#### `src/ts/storage/tests/resourceSyncLazyChats.test.ts`

- **191,208-210,235,412-442** settle() advances 1500/5000: CLOCK, controlled: yes. **keep-det** (risk: none). toFake includes Date, so the resourceSync Date.now backoff/jobBlocked reads are faked with the timers; checked, controlled
- **77 (boot), 219 (first test)** writes nothing at boot; selecting a character reads its selected chat : BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2434 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/resourceSyncLive.test.ts`

- **218** all: CLOCK, controlled: yes. **keep-det** (risk: none). toFake includes "Date", so the backoff/job-retry Date.now reads follow the fake clock
- **87 (boot), 251 (first test)** applies an idle record's change without a write, a notice, or a discar: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2398 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/resourceSyncMerge.test.ts`

- **596-599,684-687** "does not acknowledge the merged edit when its write fails" / "accepts the documented limits": CLOCK, controlled: partial. **rewrite:fake-timers** (risk: low). toFake lacks "Date" but resourceSync's backoff (backoffUntil = Date.now()+2 s; timer re-checks Date.now() < backoffUntil) is real-clock: unloaded, the auto retry keeps being postponed past the 5000 ms advance, while under load (>2 s real) it runs during the advance; the asserted end state is the same, but add "Date" as Live/Notices do (risk: low)
- **553** "stays pending while the merged write is held": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on in-process held batch; no failure path, so backoff is not involved elsewhere in the file
- **72 (boot), 132 (first test)** keeps the local edit and the later stamp: no discard, no notice, no li: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2275 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/resourceSyncModuleCache.test.ts` (**heap-memory-reduction modifies this file**)

- **192 (first it), 229,271,321,340,380,412 (}, 20_000)** "does not serialize an unchanged asset list again ..." and the rest: TMO, controlled: no. **rewrite:other(beforeAll warm import; keep 20 s for the 3000-asset work)** (risk: high). The 20 s bump covers a cold first boot plus 3000-asset modules. The first test takes 2.85 s alone, about 26 s at 9x, so it exceeds 20 s. The others take 0.3-1.1 s. The fake timers leave Date real, but settle() only advances fake time and needs no backoff. risk: high (first test), low (others)

#### `src/ts/storage/tests/resourceSyncNotices.test.ts`

- **159** all: CLOCK, controlled: yes. **keep-det** (risk: none). toFake includes "Date" (comment: job-retry block compares Date.now()); setTimeout spy only reads delays
- **74 (boot), 179 (first test)** keeps a notice that arrives during an idle read: a later read reaches : BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2365 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/resourceSyncPatches.test.ts`

- **310,396,452,484,561,630,650,681,698,725,752,770,789,831,908,927,996,1037,1074** "what a save sends / lost acks / modules patches (20_000 each)": TMO, controlled: partial. **rewrite:raise-timeout** (risk: med). Per-test 20 s bumps. The first test takes 3.75 s (cold import plus a 5000-asset record) and the "reads the record whole ... over 64 KiB" test 2.7 s, about 5x margin, which a 1/9 CPU share can exceed. Add a warm beforeAll and shrink the big fixtures, or raise the timeouts. Risk: med
- **236,666-679,711-723,733-738** "lost acknowledgements (real Date with fake setTimeout)": CLOCK, controlled: partial. **keep-det** (risk: low). toFake omits Date, so resourceSync's backoffUntil uses the real clock (the comment at 737 knows this). Every failure is followed by an explicit successful flush before any advance, so no assertion depends on backoff expiry. Latent: an advance between a failure and a flush would retry only after a real stall of 2 s or more. Risk: low

#### `src/ts/storage/tests/resourceSyncRecreation.test.ts`

- **144** "a same-id recreation saves the replacement's chats" (first test): PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold module-graph boot in the first test: 2657 ms isolated when idle, in the default 5 s (risk: high)
- **326-337** "after a deletion refused for a generating message, a re-add ... saves the replacement's chats at once": CLOCK, controlled: partial. **rewrite:injected-clock** (risk: low). jobBlockedRecords holds the real Date.now()+JOB_RETRY_MS (5 s), and schedule() compares real-clock deadlines (timerDeadline) to decide whether to keep the pending fake retry timer. If ≥4.5 s real passes between the refusal and addCharacter, the 500 ms schedule is dropped in favour of the 5 s fake timer, and advance(1000) never runs the cycle (risk: low)
- **218;354;440** releaseBatch waits: POLL, controlled: yes. **keep-poll** (risk: low). A held batch on the in-process fake server (risk: low)

#### `src/ts/storage/tests/resourceSyncSecrets.test.ts`

- **135** "is sent after the cycle's batch on the record's revision ...": BOOT, controlled: no. **rewrite:raise-timeout** (risk: high). The first test's in-test boot() pays the cold import: 2.3 s idle against the 5 s default. Add a warm beforeAll import. Risk: high
- **123,219,347,517** "fake-timer advances after failures / releaseBatch wait": POLL, controlled: partial. **keep-poll** (risk: low). vi.waitFor waits on the in-process fake server. Date is real, but the post-failure advances at 347 (halted) and 517 (quarantined, no cycle scheduled) have no runnable retry, so real backoff expiry cannot change them. Risk: low

#### `src/ts/storage/tests/resourceSyncSections.test.ts`

- **266** "writes only modules and plugins on a first boot from a fresh store ..." (first test): PERF, controlled: no. **rewrite:other(beforeAll warm import, 60 s hook timeout)** (risk: high). Same cold first boot inside the test: 2.33 s alone against the default 5 s. risk: high

#### `src/ts/storage/tests/resourceSyncUnload.test.ts`

- **115,203,213,288** "saves at once when the page is hidden" / late unload answer tests: POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on in-process held batch/response; 10x advanceTimersByTimeAsync(1) flush loops over in-process fake; unload auth age checks use real Date with 1/4 min windows (huge margin)
- **51 (boot), 102 (first test)** saves at once when the page is hidden, and warns before unload only wh: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2286 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/storage/tests/resourceSyncUnloadHalt.test.ts`

- **96-128** "asks for no unload warning once saving halted ...": BOOT, controlled: no. **rewrite:raise-timeout** (risk: high). The file's only test boots cold in-test: 2.39 s idle against the 5 s default. Its vi.waitFor at 125 is in-process (keep-poll). Add a warm beforeAll import. Risk: high

#### `src/ts/storage/tests/settingsRecords.test.ts`

- **47 (boot), 108 (first test)** save exactly the record written, on the held revision, for a nested vi: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2333 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/stores.importOrder.test.ts`

- **55-60 (beforeEach resetModules), 64-68 (import in test)** lets transformClient be the first module evaluated, and still runs on : BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: med). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 979 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: med

#### `src/ts/toggles/chatToggles.test.ts`

- **88-95** beforeEach boot (20_000): TMO, controlled: partial. **rewrite:raise-timeout** (risk: med). the per-test resetModules + cold boot is in beforeEach with a 20 s hook timeout; the first boot measured ~3.2 s idle (transform 3 s), ~6x margin that 1/9 CPU share (~9x) erases (risk: med)

#### `src/ts/translator/chatTranslation.test.ts`

- **97 (boot), 241 (first test)** read a chat's settings from its list entry (unloaded, no read), defaul: BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1777 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high

#### `src/ts/translator/storedTranslation.test.ts`

- **183** "stops with translationNoContext" (first test): PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold resetModules boot in the first test: 1514 ms isolated when idle (about 13 s at 1/9 CPU), in the default 5 s (risk: high)
- **460** "posts an unforced request per id at once ... holds the row pending until the translation arrives": POLL, controlled: no. **rewrite:fake-timers** (risk: med). After hydrate, pending clears only on the production sync loop's real 100 ms SYNC_POLL_MS setTimeout (Date.now 15 s deadline). The default 1 s waitFor cap therefore races a real production timer: after a deschedule over 1 s, the waitFor interval can fail first and its timeout then rejects (risk: med)
- **274;457;473;552;580** "POSTs the ids the chat displays ..." / follow cases: SLEEP, controlled: no. **rewrite:fake-timers** (risk: low). Real 250/150/50/20/50 ms sleeps before "still pending" / "no extra request" checks. These are negative checks, so overload makes them pass when they should not rather than fail (lower coverage) (risk: low)
- **252;431;464;483;486;549;560;565;574;289-342;639-649** request/answer waits, 15 s and 21 min deadline cases, translatedAt: POLL, controlled: yes. **keep-poll** (risk: low). fetchCalls and ignored/failed outcomes settle in-process (mocked flush/authFetch); the deadline cases use full vi.useFakeTimers (Date included); translatedAt>=before is a monotonic check (risk: low)

#### `src/ts/translator/translatorMedia.test.ts`

- **145,201,204,373** "keeps at most ten nodes in flight" / batching: POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on mocked transports held by deferreds. setTimeout(0) at 204 is a macrotask after the microtask traversal, and the cap is re-checked through peak at the end. Risk: low

#### `vitest.lucideImports.test.ts`

- **33-46** "rewrites every barrel import in src/ and keeps each file's line count" / "maps the icons": TMO, controlled: partial. **keep-accepted** (risk: low). synchronous walk of src/ and ~1900 icon-file reads under the default 5 s timeout; ms-scale work, >10x margin even at 1/9 CPU; risk low

## 3. Residual real-time dependency in the 2026-10-18 fixed files

"Actionable" means a row whose disposition is not `keep-*`.

| File                                                  | Rows | Actionable | high/med-high | Residual                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ---: | ---------: | ------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/tests/scriptWorker.test.ts`               |   26 |         24 |             8 | **Yes, the most of any file.** See "scriptWorker residuals" below.                                                                                                                                                                                                                                                                                                                                                            |
| `server/src/tests/promptRunner.test.ts`               |   16 |         10 |             0 | **Yes, low-med.** The 3 s checkpoint timer and its >= 3000 ms lower bound are only in the slow test; the gated variant (711-727) never reaches a checkpoint. Left: `testSupport.waitFor` 2 s caps at 1267, 1332, 1384, 1404 (med); the `< 15_000` bound at 720; the abort path relying on the real 5 s `JOB_ABORT_GRACE_MS`; the real 150 ms provider delay before the stream break (1080); translation polls with 10 s caps. |
| `server/src/tests/shutdown.test.ts`                   |    7 |          7 |             2 | **Yes.** The 100-continue barrier is deterministic, but every test boots a fresh `main.ts` child: 10 s boot poll, a default 2 s poll on the child's temp file (122), a 5 s SIGTERM-line poll, `< 5000` ms exit (214), 20 s timeouts. Move the file to slow (`/** @module-tag slow */`). The `sleep(150)` at 124 only weakens test 1 (false pass).                                                                             |
| `src/lib/ChatScreens/PartialEditController.test.ts`   |    2 |          0 |             0 | No. Faked `setTimeout` is sufficient (the controller reads no clock). The `vi.waitFor` calls poll in-process work only.                                                                                                                                                                                                                                                                                                       |
| `server/src/tests/cbsLimits.test.ts`                  |    3 |          1 |             1 | **Yes, one.** "a non-advancing range answers [] under the server's limits" (663-667) still runs `spawnSync` of a fresh Node process in the gated tier under the default 5 s. Move it to slow, or delete it (308-317 cover `[0,1,0]` in process). The rest use injected clocks.                                                                                                                                                |
| `server/src/tests/cbsLimitsHost.test.ts`              |    2 |          0 |             0 | No. Ticking `CbsLimits.now`, a stopped `performance.now`, and load-monotone busy-waits.                                                                                                                                                                                                                                                                                                                                       |
| `src/ts/parser/tests/cbs/limits.test.ts`              |    2 |          1 |             0 | Minor. Two tests at 71-80 ("the budget starts over for the next top-level parse", "a non-advancing range answers []") do not call `stopClock()` like their siblings, so the real 2 s client wall limit still applies (low).                                                                                                                                                                                                   |
| `src/ts/storage/tests/resourceSyncFieldCache.test.ts` |    3 |          2 |             0 | **Yes, med.** `INTEGRATION_TIMEOUT = 60_000` is only about 2x the more than 30 s the file's own comment records under the overload. The two canonical-shape cases (487-592) have 5 s / 20 s and pass only because earlier cases warmed the graph. Warm the graph once in `beforeAll`.                                                                                                                                         |
| `src/ts/storage/tests/moduleCache.test.ts`            |    4 |          3 |             2 | **Yes, high.** No raised timeout anywhere. The first case pays the cold graph boot (2.54 s idle) under the default 5 s. The 100k-asset case (765 ms idle) now has the default 5 s as its implicit budget since `< 300ms` was deleted. (Modified by heap-memory-reduction.)                                                                                                                                                    |
| `src/ts/assetList.test.ts`                            |    1 |          1 |             0 | Minor. The 100k-name case (307 ms idle) is budgeted only by the default 5 s. Shrink it to 1-5k; the `toBe` identity guard does not depend on size. (Modified by heap-memory-reduction.)                                                                                                                                                                                                                                       |
| `server/src/tests/hypaV3Limits.test.ts`               |    3 |          2 |             2 | **Yes, high.** 262-280 runs on a cold pool, and `hypav3.ts:57,77` checks the real 5000 ms chunking budget before the regex error. A slow boot therefore turns "Regex timed out" into "chunking budget exhausted"; the test also keeps `< 5000` and `< 1000` wall bounds. Fix: `await pool.warm()` and drop the bounds. 107 runs `spawnSync` of a fresh Node process: move it to slow.                                         |
| `server/src/tests/lore.test.ts`                       |    1 |          1 |             0 | **Yes, med.** 686-707 cold-boot the size-1 regex pool inside the first test's default 5 s. The 200 ms deadline outcome itself is deterministic (REDOS). Fix: `beforeAll(() => pool.warm(), <long hook timeout>)`.                                                                                                                                                                                                             |

### scriptWorker residuals

The 2026-10-18 fix moved the regex deadline and the Lua ELU baseline to dispatch. It did not
change the following:

- **`cpuMs: 100` tests with 25-100 ms of real slack** (high/med-high). They charge real ELU, so a
  routine 1-CPU deschedule of 20-80 ms cuts the run or breaks `cpuMs < 100`. Rewrite with large
  budgets plus relative invariants (`ms - cpuMs >= wait`), or with an ELU stub in an in-process
  runtime test.
  - 586 "lets queued runs sharing a budget spend it once" (below)
  - 321 "charges the CPU spent between host calls, not the waits"
  - 334 "charges a coroutine resumed after a long wait only its own compute"
  - 392 "does not charge a synchronous wait, even one longer than the budget"
  - 635 "releases the reservation of an aborted run" (`usedMs < 100`)
  - 665 "charges the job budget across runs" (`second.cpuMs < 250`)
- **Fixed watchdog and abort graces race "without a termination" assertions** (282, 417, and the
  2cc6c51f1 test at 618). The watchdog fires at `cpuMs + 1000 ms` ELU and `ABORT_GRACE_MS` is
  500 ms, both constants. Making them pool options removes the class.
- **Wall bounds that catch nothing extra:** `ms < 3000/4000/1500/7000/1000` at 282, 297, 355,
  369, 417 and 951. 369 ("serves concurrent host calls in their own completion order") is high
  risk: only the `< 1000` bound tests concurrency there, so rewrite it with two deferred host
  answers resolved b-then-a.
- **Sleeps as synchronization:** 485 (a 250 ms timer reads `signal.aborted`), 541/553
  (`sleep(1600)` plus a cold replacement boot in 5 s: high), 688, 1173-1188.
- **Cold pools in the default 5 s:** 512, 834 (a 400 x 25 ms hand poll, 10 s, inside a 5 s
  timeout), 1149 (`vi.waitFor` 5 s cap on worker entry, real 200 ms idle retirement), 1198.
- **Real responsiveness is the subject:** 801-819 (`fetch` latency < 500 ms, run < 3 s). Disposition:
  `move-slow`.
- **Fresh Node process:** 1238 (`ms < 15000`). Disposition: `move-slow`.

### "lets queued runs sharing a budget spend it once" (scriptWorker.test.ts:586-594)

Disposition: **rewrite** (the 2cc6c51f1 way, keeping the "queued" subject). Risk: high; it has not
failed yet only because its slack is small but not zero.

The task description called this "a bounded spin that must be cut at a 20 ms allowance". The
current code is the reverse:

- `createLuaBudget(100)` and a size-1 pool. At the first `runLua`, assignment reserves the whole
  `min(DEFAULT_LUA_CPU_MS, 100) = 100 ms` synchronously (`workerPool.ts:491-503`).
- Calls 2-4 then fail `runLua`'s pre-check (`usedMs + reservedMs >= totalMs`, `workerPool.ts:803`)
  synchronously. So `refused == 3` is deterministic, and the runs never actually queue.
- Run 1 must **finish** a 75 ms `os.clock()` spin (wall time in wasmoon) **before** the count hook
  sees 100 ms of worker ELU. The slack is 25 ms, and it also has to cover the preamble (proxy setup,
  compiling the chunk, the dispatch to `probe`).

It fails under overload in four ways:

1. A deschedule of more than ~25 ms in the preamble pushes ELU past 100 ms. The hook cuts run 1, so
   the "done" count is 0. This is the most likely failure: 20-50 ms CFS waits are routine with 9+
   runnable threads on one CPU.
2. A gap of more than ~125 ms after the spin, before `finally` reads `activeMs`, breaks
   `usedMs <= 200`.
3. A mid-spin gap moves both clocks together. The spin's comparison usually wins (about 8
   instructions against the hook's 1000), but in about 1% of cases the hook check lands first.
4. A stall of at least 1.1 s lets the watchdog (100 + 1000 ms ELU) kill the worker. On top of all
   four, the cold size-1 pool boots inside the default 5 s.

Rewrite:

- Hold the size-1 slot with an unbudgeted run parked on a deferred host call, so all four budgeted
  runs pass the pre-check and genuinely queue.
- Make run 1 `while true do end`, so it can end only through the hook.
- Assert:
  - one cut, with `cpuMs >= 100`;
  - three "aggregate Lua execution budget exhausted" (refused at `start()` with `available <= 0`);
  - `reservedMs == 0`;
  - `usedMs == sum(cpuMs)`.
- Accept the watchdog's "worker terminated" error as the cut too, or make the grace injectable.
- Drop `usedMs <= 200`.

Wrong implementations the rewrite still fails:

- `start()` not checking the remainder: queued runs would get `max(1, …)` = 1 ms allowances and fail
  with the hook message, not the refusal.
- A pre-check or reservation that ignores `reservedMs`.
- `finishLua` not releasing the reservation (`reservedMs != 0`).
- Charging the reservation instead of `cpuMs`, or charging twice (`usedMs != sum`).

A cheaper alternative: a body of `return 'done'`, under 1000 instructions so the hook never fires,
with `createLuaBudget(3000)`. It still catches a missing or late reservation, because the later runs
would then return "done" too.

On the 2cc6c51f1 test itself ("reserves each concurrent run's allowance", 618-629): sound on the hook
path. `refused == 2` is synchronous, `cpuMs >= 50` follows from the hook condition, and
`usedMs == sum` is exact. The residual risk is low-med: a whole-process stall of at least 1050 ms lets
the 50 ms watchdog poll kill a worker before its hook runs, so `cut` has one entry. Fix: accept the
watchdog error as a cut, or make `WATCHDOG_GRACE_MS` a pool option.

## 4. Overlap with branch heap-memory-reduction

`git diff --stat metatron...heap-memory-reduction -- '*.test.ts'` lists eight test files. Order the
fix pass for these after that branch merges. "Actionable" counts rows that are not `keep-*`.

| File                                                     | Rows | Actionable | Rows here (lines, disposition)                                                                                    |
| -------------------------------------------------------- | ---: | ---------: | ----------------------------------------------------------------------------------------------------------------- |
| `src/lib/Setting/Pages/Module/ModuleMenu.assets.test.ts` |    0 |          0 | no spots                                                                                                          |
| `src/ts/assetList.test.ts`                               |    1 |          1 | 145-173 rewrite:other                                                                                             |
| `src/ts/parser/tests/assetFuzzy.test.ts`                 |    0 |          0 | no spots                                                                                                          |
| `src/ts/process/modulesImport.test.ts`                   |    2 |          0 | 225-240,477,562,579,675-705,808-821,943,968 keep-det, 157 keep-accepted                                           |
| `src/ts/storage/tests/moduleCache.test.ts`               |    4 |          3 | 120-137 rewrite:raise-timeout, 297-322 rewrite:raise-timeout, 139-295,325-411 rewrite:raise-timeout, 109 keep-det |
| `src/ts/storage/tests/moduleFieldStamps.test.ts`         |    0 |          0 | no spots                                                                                                          |
| `src/ts/storage/tests/records.test.ts`                   |    1 |          0 | 40,77,104 keep-det                                                                                                |
| `src/ts/storage/tests/resourceSyncModuleCache.test.ts`   |    1 |          1 | 192 (first it), 229,271,321,340,380,412 (}, 20_000) rewrite:other                                                 |

- Only three of the eight need a timing fix: `moduleCache.test.ts` (cold first test and the
  100k-asset case, high), `resourceSyncModuleCache.test.ts` (cold first test under a 20 s timeout,
  2.85 s idle, high) and `assetList.test.ts` (100k case, low).
- The branch edits `moduleCache.test.ts` 238-290 (inside the 139-295 range of a row) and adds a
  20 s test to `resourceSyncModuleCache.test.ts`. A `beforeAll` warm-up at the top of either file
  would not conflict textually, but it should land after the merge so the new test is covered too.
- `ModuleMenu.assets.test.ts` and `moduleFieldStamps.test.ts` matched no candidate pattern and run
  no in-test module boot. `assetFuzzy.test.ts` was audited and had no spots. `records.test.ts` and
  `modulesImport.test.ts` have only `keep` rows.

## Appendix

### Slow-tagged tests left out of scope

- Whole files (`/** @module-tag slow */`): `server/src/tests/importPngCaps.test.ts`, `server/src/tests/tokenPlainNode.test.ts`, `server/src/tests/diagnosticsCrash.test.ts`.
- `scriptWorker.test.ts` "caps sleep at 2 s per call and 6 s per run" (888) and "charges a C-level runaway that follows the worker's own 10 s give-up" (932).
- `promptRunner.test.ts` "writes the checkpoint 3 s after a chunk while the provider stalls, before any other chunk" (730). It keeps a real 3 s timer, a >= 3000 ms lower bound and a 15 s poll, which is fine for the slow tier.
- `cbsLimits.test.ts` "the stuck range, an endless roll, ..." (647) and "an ordinary large text passes under the server's limits" (683).
- `manualTriggers.test.ts` "ends the job with an error past the effect limit" (664).
- `triggerRuntime.test.ts` "ends a privileged self-recursion ..." (1489) and "ends `/trigger` recursion through the real command executor ..." (1499).
- `tokenParity.test.ts` "counts the smoke strings for every family as the browser does" (165).
- `luaRuntime.test.ts` "pins the address, verifies the URL's host, ... answers 408 on the deadline" (325).

### Candidate files audited with no spots (38)

Each matched a candidate pattern only through counts, sizes, controlled fake timers or stored timestamps.

- `server/src/tests/cbs.test.ts`
- `server/src/tests/changeFeed.test.ts`
- `server/src/tests/dynamicAssets.test.ts`
- `server/src/tests/llmProviderAdapters.test.ts`
- `server/src/tests/memoryAlgorithms.test.ts`
- `server/src/tests/normalizationPass.test.ts`
- `server/src/tests/normalizeSections.test.ts`
- `server/src/tests/requestHistory.test.ts`
- `server/src/tests/resourceCompression.test.ts`
- `server/src/tests/resourcePatchParts.test.ts`
- `server/src/tests/resourcesBoot.test.ts`
- `shared/tests/diagnostics.test.ts`
- `shared/tests/diagnosticsReport.test.ts`
- `shared/tests/notifications.test.ts`
- `shared/tests/recordPatch.test.ts`
- `shared/togglePresets.test.ts`
- `src/lib/Setting/Settings.hotkeys.test.ts`
- `src/lib/SideBars/PinnedChatsRail.status.test.ts`
- `src/ts/charactersImportChat.test.ts`
- `src/ts/parser/tests/assetFuzzy.test.ts`
- `src/ts/parser/tests/cbs/hostParity.test.ts`
- `src/ts/plugins/apiV3/hostApiChats.test.ts`
- `src/ts/plugins/apiV3/hostApiRouting.test.ts`
- `src/ts/process/lorebook.svelte.test.ts`
- `src/ts/process/memory/memoryOracle.test.ts`
- `src/ts/process/request/tests/requestPresetScope.test.ts`
- `src/ts/setting/botSettingsParamsData.test.ts`
- `src/ts/setting/settingsPageSections.test.ts`
- `src/ts/setting/translationSettingsData.test.ts`
- `src/ts/storage/tests/assetClient.test.ts`
- `src/ts/storage/tests/chatLock.svelte.test.ts`
- `src/ts/storage/tests/presetSchema.test.ts`
- `src/ts/storage/tests/settingWrappers.test.ts`
- `src/ts/storage/tests/settingsViews.test.ts`
- `src/ts/storage/tests/snapshots.test.ts`
- `src/ts/sw.share.test.ts`
- `src/ts/translator/bilingualInterleave.test.ts`
- `src/ts/translator/presets.test.ts`

### Files not read (148)

These matched no candidate pattern and run no in-test `vi.resetModules()` boot of the storage graph. Regenerate the list with
`rg --files | rg '\.test\.ts$'`, minus the 225 candidates, the 2 non-candidate files with orchestrator rows and the 3 slow-tagged files.
