# Timing-dependent tests in the gated Vitest suite (2026-10-19, refreshed 2026-10-21)

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

**Refresh 2026-10-21 (at `11d6e86f1`).** The inventory was written at `44e18f2ae`; 114 commits
followed. Five reviewers re-read every inventoried file in full against the same rubric, moved each
row to its current lines and its exact current test title, and audited the files the first pass
never saw: the 41 test files added since, the five unread or no-spot files whose added lines
matched a candidate pattern, and `server/src/tests/resourcePatchParts.test.ts` (a known CI
timeout). Findings:

- **No timing fix landed in between.** Every one of the 395 original rows still applies; none was
  removed. Most test-file diffs since `44e18f2ae` are comment cleanup and the
  `allowListenerOrigin(...)` line the unit-test network guard added to server tests.
- **23 rows were revised** (the code or the judgment changed; marked
  `(2026-10-21: <what changed>)`) and **68 rows are new** (marked `(new 2026-10-21)`): 17 in
  inventoried files, 51 in newly audited ones. Total **463 rows in 216 files**.
- Three new cross-cutting causes (10-12 below): real MessagePort delivery under a bounded poll, the
  client CBS 2 s wall limit reached through style decoding, and SQLite durability on a
  disk-backed `/tmp`.
- `projectionBindings.test.ts` looked as if it had gained timing code; its `performance.now`
  blocks and ratio checks predate the rename from `projectionSpike` and are unchanged.
- The heap-memory-reduction merge (`b122ae132`) landed the edits section 4 predicted and left the
  timing work in place; nothing waits for it any more.

The refresh is static like the first pass. Reviewers timed eleven single files while sharing the
machine with each other; those numbers are noisy and stated as such in the rows. Reasons carried
over unchanged keep their 2026-10-19 idle measurements. Line numbers in the bold locators are
current at `11d6e86f1`; line numbers quoted inside carried-over reasons may be the old ones. Find a
spot by its quoted test title.

## Method and limits

- Scope (2026-10-19): every `*.test.ts` from `rg --files | rg '\.test\.ts$'` (honors `.ignore`;
  `.claude/worktrees` never read). That was 378 files; it is 419 at the refresh. Whole-file
  slow-tagged files are out of scope (`importPngCaps`, `tokenPlainNode`, `diagnosticsCrash`, and
  since the refresh `upstreamImportWorker`), as is every test tagged `slow` (listed in the
  appendix).
- Candidates: files matching at least one of `performance.now`, `Date.now`, `setTimeout`,
  `setInterval`, `setImmediate`, `toBeLessThan`/`toBeGreaterThan`, `timeout`, `waitFor`,
  `expect.poll`, `useFakeTimers`, `spawn`/`fork`/`execFile`/`child_process`, `new Worker`, worker
  pools, `delay(`/`sleep(`. Reviewers read the surrounding test, its helpers
  (`server/src/tests/testSupport.ts` and others) and the production code it reaches, to decide
  whether the clock was really controlled. Vitest is still 4.1.11. Facts used: a bare
  `vi.useFakeTimers()` fakes `Date` and `performance` too; a `toFake` list without `"Date"` leaves
  `Date.now` real; `vi.waitFor`/`expect.poll` keep a real 1 s cap even under fake timers; fake
  timers never reach worker threads, child processes or real `MessagePort` delivery.
- The cold-module-graph class: the first pass also timed the first test of each file that runs
  `vi.resetModules()` plus a dynamic import of the storage graph inside the test (`pnpm --silent
test:agent --force <file> --reporter=json`, idle machine, one run each; 27 rows marked "Added by
  the orchestrator"). In a full run Vite's transform cache is shared across files, so the
  first-test cost is lower there; the overload multiplies whatever remains.
- Nothing was run under artificial load. "Risk" in each row is the reviewer's estimate of failure
  under the overload above: high, med-high, med, low-med, low, none.
- Not read: the 144 files with no candidate pattern and no in-test module boot (148 at the first
  pass; the refresh audited four of them because their added lines matched). A test can still
  depend on time through production code it reaches without naming a timing API; causes 11 and 7
  record the two such paths found (the client CBS wall limit, the resourceSync `Date.now`
  backoff).
- A `keep-det` row records a candidate that was checked and found controlled, so the count is
  honest. Aggregated rows (one row covering several lines) count once.

Disposition codes: `keep-det` (already controlled: a false positive), `keep-poll` (a bounded
poll on in-process work only; the 1-2 s cap is the only real-time element), `keep-accepted` (real
time with a deliberately large margin, stated in the row), `rewrite:<how>`, `move-slow`, `delete`.

## 1. Summary

Rows: **476** spots in **216** files (2026-10-19: 395 in 189; 463 at the 2026-10-21 refresh, 13
added by the fix slices).

**Actionable rows resolved (2026-10-22).** Every actionable row (disposition not `keep-*`) is
resolved. 232 of the 233 carry `fixed in slice <n> (<commit>)`, which includes the rows moved to
slow. The one left, `scriptWorker.test.ts` "makePool", is kept under slice 5a's stated exception:
real cold worker boots under an explicit 60 s timeout, because the boot is what it tests. The
`keep-*` rows stay as judged (D3). The "resolved" columns below count the actionable rows only, so
the three race rows that the close-out added are not in them.

The close-out (plan slice 10) then ran the whole gated suite under load in two ways. One was three
runs under the overload. The other was four unpinned suites at once. Both kinds of run failed,
mostly on Vitest's default 5 s timeout in CPU-bound tests that read no clock. Most of those tests
were never in this inventory, because they have no timing code for its patterns to find. The user
decided that the gate's timeout is a hang guard, not a budget (plan decision D5, the 60 s gated
default). So those failures are not rows here. The three assertion failures the runs also found are
scheduler races, and they are rows, marked `(new 2026-10-22, found by slice 10)`.

### By dependency kind (primary kind of each row)

| Kind      | Meaning                                                                                        |    Rows | of which keep | rewrite | move-slow | delete | resolved |
| --------- | ---------------------------------------------------------------------------------------------- | ------: | ------------: | ------: | --------: | -----: | -------: |
| DUR       | duration assertion on elapsed real ms                                                          |      17 |             2 |      13 |         2 |      0 |       15 |
| PERF      | absolute performance threshold (incl. heavy work whose only budget is the default 5 s timeout) |      40 |             2 |      31 |         7 |      0 |       38 |
| SLEEP     | sleep/tick used as synchronization                                                             |      87 |            55 |      29 |         1 |      2 |       32 |
| POLL      | bounded poll with a real-time cap (vi.waitFor, expect.poll, testSupport.waitFor)               |     100 |            54 |      44 |         2 |      0 |       46 |
| CLOCK     | real performance.now()/Date.now()/ELU feeding a budget, deadline, TTL or throttle              |     143 |           104 |      36 |         3 |      0 |       39 |
| TMO       | Vitest timeout bump (heavy work raced against the wall clock)                                  |      41 |            26 |      13 |         2 |      0 |       15 |
| BOOT      | worker / child process / server / cold module graph boot inside a timed region                 |      48 |             0 |      41 |         7 |      0 |       47 |
| HEAP      | heap/GC-dependent assertion                                                                    |       0 |             0 |       0 |         0 |      0 |        0 |
| **Total** |                                                                                                | **476** |       **243** | **207** |    **24** |  **2** |  **232** |

### By disposition

| Disposition              |    Rows | high or med-high risk | resolved | 2026-10-19 rows |
| ------------------------ | ------: | --------------------: | -------: | --------------: |
| keep-det                 |     139 |                     0 |        – |             108 |
| keep-poll                |      49 |                     0 |        – |              42 |
| keep-accepted            |      55 |                     0 |        – |              50 |
| rewrite:fake-timers      |      16 |                     3 |       16 |              15 |
| rewrite:injected-clock   |       8 |                     1 |        8 |               7 |
| rewrite:deferred         |      40 |                    14 |       40 |              35 |
| rewrite:call-through-spy |       2 |                     1 |        2 |               2 |
| rewrite:raise-timeout    |      20 |                     7 |       19 |              20 |
| rewrite:other            |     121 |                    57 |      121 |              99 |
| move-slow                |      24 |                    12 |       24 |              15 |
| delete                   |       2 |                     0 |        2 |               2 |
| **Total**                | **476** |                **95** |  **232** |         **395** |

### By risk under overload (as stated in each row)

| Risk      |    Rows | actionable | resolved | 2026-10-19 rows |
| --------- | ------: | ---------: | -------: | --------------: |
| high      |      75 |         75 |       75 |              65 |
| med-high  |      20 |         20 |       20 |              16 |
| med       |      81 |         81 |       80 |              62 |
| low-med   |      22 |         20 |       20 |              20 |
| low       |     184 |         35 |       35 |             171 |
| none      |      94 |          2 |        2 |              61 |
| **Total** | **476** |    **233** |  **232** |         **395** |

Refresh status: 372 rows carried over (lines and titles updated), 23 revised, 68 new, 0 removed.

File accounting at the refresh: 419 test files = 216 with rows + 55 candidates read with no spots
(appendix) + 4 whole-file slow + 144 not read.

### Cross-cutting causes (the fix pass should work by cause, not by row)

Each cause below has one fix that covers many rows. The row lists in section 2 carry the detail;
the reach given here is as of the refresh.

1. **Cold module graph inside the test's timeout (the largest class).**
   The file calls `vi.resetModules()` and then `await import(...)` of `resourceSync.svelte`,
   `bootstrap`, `chatStore.svelte` and so on. This happens inside the first test (default 5 s) or
   in `beforeEach` (default 10 s hook timeout). Measured first tests took 1.5-3.75 s when idle,
   and the later re-evaluations 50-500 ms.
   - Reach: 36 files under `src/ts/storage/tests/` (only `chatProjection` warms), 16 more client
     files (`characters`, `generationJobsDelta`, `jobChannel`, `jobChannelBarrier` — 2.3 s noisy
     first test, `pluginContextSaved`, `v3SavedWrites`, `chatStatus`, `inlays`, the two
     `risuaccess` writers, `mcpWriters`, `serverCommands`, `stores.importOrder`, `chatToggles`,
     `chatTranslation`, `storedTranslation`), and two new ones: `pluginSafeBoot` "resolves true at
     once without plugins" (2.15 s noisy, high) and `bootstrap.safeBoot`, which warms the client
     graph but still runs `StoreBackedServer.create`'s server-store imports inside the test.
     Fourteen client files already warm in `beforeAll` (the card, persona, lorebook, module and
     export import tests, `bootstrap.serviceWorker`, `charactersCapture`).
   - Fix: `beforeAll(() => import(<the graph>), 60_000)`, which the fourteen files already do.
     That moves the cold transform out of every timed test; the per-test `resetModules`
     re-evaluations stay. One shared warm-up helper next to `bootMutations`
     (`src/ts/storage/tests/mutationStoresHarness.ts`) would cover most of them; it does not exist
     yet. In `stores.importOrder` the warm-up must precede `resetModules` so both import-order
     assertions stay meaningful.
     Slice 4a (7d52aa936) warmed all 36 listed storage files in a 60 s beforeAll; per-test re-evaluation, the other client boots and the noted CPU-bound fixtures remain.
     Slice 4b (236531778) warmed the 18 listed client files the same way (`warmModules` next to `warmMutationGraph`); because in Vitest 4 a `vi.mock` factory with `importOriginal` runs once per file and survives `resetModules`, so a partial mock keeps the real exports of the first registry, it also replaced the two such overrides (`./util` in `characters.test.ts`, `resourceSync.svelte` in `pluginSafeBoot.test.ts`) with per-test `vi.spyOn`, and other files with partial mocks of project modules were not audited.

2. **`testSupport.waitFor` (server) and the bounded client polls.** Its deadline is
   `Date.now() + 2000` and it polls on a real 10 ms `setTimeout` (`testSupport.ts:344-352`,
   unchanged). After a long deschedule, its timer fires in the timers phase, re-checks the
   condition before the poll phase has delivered the pending socket/fs callback, sees the deadline
   passed, and throws.
   - Reach: in `app`-`manualTriggers`, 26 POLL rows (21 actionable) covering 92 test-title
     families in 17 files (events, generations, generationMetadataEvents, generationDeltaChunks,
     generationJobs, chatMetadataCoalescingEvents, jobChannel, llmRoutes, llmRequests,
     llmServices, assets, diagnostics, importRealm, importModule, importCharx, backups,
     luaBindingsFences); in `mcp`-`triggerRuntime`, 41 direct call sites in nine files (promptRunner,
     promptTail, proxy, shutdown, snapshots and translate are actionable; mcp, requestCapture and
     requestShare poll in-process work) plus `startUpstream.received()` in proxy. The new server
     files do not use it.
   - Fix: drop the wall deadline, or wait on the event itself, and let the test timeout catch
     hangs. A cheaper half-fix: before throwing, yield once with `setImmediate` and re-check.
     `translate`'s `jobEnded` (2 s) and `promptRunner`'s `chatUntil` (10 s) are separate
     Date.now polls the helper fix does not reach; `memoryJobs` uses `expect.poll` over the feed
     socket and needs frame-matching promises too.
   - Related helpers: `follow()` in `generations.test.ts` and `generationDeltaChunks.test.ts`
     (172-205 in both) closes its socket after 4 s of real time, which can drop late `done`
     frames (eight and three callers).
   - Client analogue: `resourceSync`/`resourceSyncChats` cases that `vi.waitFor` a 500 ms
     debounced save while fake timers advance only 50 ms per real poll; advance the debounce
     explicitly instead.
     Slice 3 (88953f6d0) removed the default testSupport.waitFor deadline (only slow shutdown passes timeoutMs), the follow caps and the separate server-helper caps; client polls, staging TTLs and trigger-yield races remain.
     Slice 9a (fd6805ccf) found no server debounce poll, and the two `shared/` rows were already deterministic. Slice 9b (0a6fb1aa5) replaced the client analogue's debounce polls in `resourceSync` and `resourceSyncChats` with a fake-time advance of `SAVE_DEBOUNCE_MS` (`mutationStoresHarness.ts`). Leftover: `SAVE_DEBOUNCE_MS` copies the unexported production `DEBOUNCE_MS`, so changing it fails six tests until the copy is updated.

3. **Worker budgets measured on real time.**
   - The pool charges Lua CPU as the worker's `eventLoopUtilization().active`, which is wall time
     while busy, including time descheduled. The watchdog grace (1000 ms), `ABORT_GRACE_MS`
     (500 ms) and `DEFAULT_REGEX_DEADLINE_MS` (1000 ms) are still constants
     (`workerPool.ts:49,59-61`); pool options expose `bootMs`, `wallMs`, `syncHostTimeoutMs` and
     `sleepCaps` but neither grace. HypaV3 chunking has a real 5000 ms budget.
   - Affected: `scriptWorker` (the `cpuMs: 100` tests have 25-100 ms of slack; a successful
     regex-cap row is new), `regexScriptsTask` (its large fixture changed shape), `manualTriggers`
     "six regex sites", `luaBindings`, `promptRunner` editinput, `hypaV3Limits` (cold pool racing
     the chunking budget), `lore` (the 200 ms deadline also governs the sane match that must
     succeed; new row), and `memoryJobs` (HypaV3 splitting reaches the real 1000 ms regex
     deadline and 5000 ms chunking budget; new row).
   - Fix: make the watchdog grace and abort grace pool options. Give `createTestServer` /
     `createScriptWorkerPool` large test budgets where the budget is not the subject. In tests whose
     subject is the budget, assert relative invariants (`ms - cpuMs >= wait`, `usedMs == sum`)
     instead of absolute slack. Warm pools before the timed region.
     Slice 5a (3fa95439b) made the watchdog and abort graces pool options (`watchdogGraceMs`, `abortGraceMs`, passed as `scriptWorkerOptions`) and fixed `scriptWorker`, except that the readiness block, "replaces a terminated worker when the pool is warm" and the growth worker keep real cold worker boots under an explicit 60 s timeout, a stated exception the user accepted because boot is their subject (revisit if a controlled worker clock or Worker adapter lands); the other worker consumers remain for slice 5b.
     Slice 5b (6f4b9191d) fixed the other worker consumers through new pool options (`luaCpuMs` 3 s, `regexDeadlineMs` 1000 ms, which also replaces the hard-coded sub-regex deadline, `regexScriptsCpuMs` 5000 ms, `luaBudgetMs` 30 s with `createBudget()`, and `prepareCpuMs` 3 s, which has no effect today) and `MemoryHost.separatorLimits` (5000/1000 ms, via `generationHypaV3SeparatorLimits`), passed through `scriptWorkerOptions` (type `ScriptWorkerTimingOptions`, now also carrying `bootMs` and `syncHostTimeoutMs`) with generous test values in `server/src/tests/unhurriedLimits.ts` and a new `scriptWorkerOptions.test.ts` that checks each default reaches its task; the server CBS limits (5 s per template, 60 s per job, `jobs/cbsHost.ts`) still ran on real time on these paths, and transform renders kept the real 30 s Lua budget because the `transformService.test.ts` pool double had no `createBudget` (both closed in slice 9a).
     Slice 9a (fd6805ccf) closed both 5b leftovers: `serverCbsLimits(usage, time?)` and a `cbsTimeLimits` option on `createServerContext`/`createTestServer` reach the Lua bindings for jobs, commands and renders and the translation runner (`UNHURRIED_CBS` in `luaBindings`, `promptRunner`, `manualTriggers` and `memoryJobs`), and transform renders take their shared Lua budget from the pool's `createBudget()`; new tests are `cbsTimeLimitsOptions.test.ts`, `transformBudget.test.ts` and `luaRuntimeCharge.test.ts` (a deterministic summed-charge test on a mocked busy clock, in process). `prepareCpuMs` stays (inert today). The 5a weak-coverage leftover keeps its outcome: `scriptWorker` "charges the CPU spent between host calls, summed across them" and "stops a runaway right after a resumption at the budget" can still pass under load without exercising their distinction but stay gated on purpose, since they catch the wrong implementation on every normal run; summation now also has `luaRuntimeCharge.test.ts`, the resumption case would need a worker-side clock, and the exact-100 ms queued cut is unchanged because the aborted-run and dropped-result tests pin measured-vs-reservation charging. The readiness block stays under the 5a exception; its two `cpuMs: 100` tasks never actually run.

4. **Fresh Node processes in the gated tier.** The slow tag's own description names fresh Node
   processes, yet these are still untagged: `shutdown.test.ts` (whole file),
   `sharedImports.test.ts` "imports every shared/\*\*/\*.ts with plain node" (now 88 modules),
   `hypaV3Limits.test.ts` "the %s loop ends with an error instead of spinning",
   `cbsLimits.test.ts` "a non-advancing range answers [] under the server's limits" (675-679; the
   first pass's 663-667 pointed into a slow-tagged neighbour), `scriptWorker.test.ts` "lets a
   plain Node process that never disposes the pool exit on its own", `llmCharsetRetries.test.ts`
   (both retry-budget cases), `luaRuntime.test.ts` "keeps the wasm function table flat across
   runs...", and `transformers.test.ts` (a real `fork` with a 150 ms idle kill and a 600 ms sleep
   before reading `signalCode`). Disposition: `move-slow`. `cbsLimits` could instead be deleted,
   since the registry range test (300-331) covers `[0,1,0]` in process. `projectionBindings`'
   benchmark also runs `execSync("uname -a")`; it goes with that benchmark's `move-slow`.
5. **Short real production timers raced by in-process work.**
   - `translate.test.ts` (six tests ride the Echo model's real 300 ms sleep: high).
   - `importRealm.test.ts` "removes a staged import that waits past its expiry..." (a commit must
     beat a real 200 ms staging TTL) and "a client that leaves before reading the prepare's
     line..." (100 ms expiry plus cleanup).
   - `proxy.test.ts` "streams SSE through, and a timeout before upstream headers is a 504" (100 ms
     proxy timeout; the upstream records the request only after reading its body).
   - `bootCache.test.ts` "an open that never answers falls back as `timeout` within the bound..."
     (a 20 ms timeout plus an elapsed < 1000 ms check) and the 3000 ms `BOOT_CACHE_TIMEOUT_MS` in
     18 constructions across 16 tests that reach IndexedDB.
   - `chatMetadataCoalescingEvents.test.ts` "persists %s batches and reports the final stored
     revision..." (manual variant, `toBe(expectedWrites)` at 450) and `manualTriggerMetadata.test.ts`
     "keeps %s transcript reads and writes bounded...": the trigger effect loop yields on a real
     50 ms `performance.now` window that the job runner never injects (`triggers.ts:261-266`,
     `runSetup.ts:385-408`), and `lastEffectYieldAt` is not reset after the alert-input answer, so
     a stall splits one coalesced write into two (both fixed: 6a `328634ecd` injects the clock,
     `e3ba64355` restarts it after the answer). This is the mechanism of the known
     off-by-one transaction-count flake.
   - `storedTranslation.test.ts` (production 15 s Date.now sync deadline and 100 ms poll against
     `vi.waitFor`'s 1 s), now also reached from `Chat.test.ts` "the toggle requests a translation
     when none is fresh..." (new row).
   - `app.test.ts` "limits /api/login to 10 attempts per window..." (exact Retry-After from the
     real limiter clock); `promptRunner`'s real 5000 ms job abort grace and 150 ms delay before a
     stream break.
   - New, accepted: the plugin sandbox's real 60 s unread-body expiry (`sandboxActivity`, large
     margin); the safe-boot guest-ready deadline (see cause 7).
   - Fix: inject the timer or clock (a staging `expire()` hook, `host.now` through the runner) or
     hold the provider on a latch.
     Slice 6a (328634ecd) fixed the server rows here through test seams on `createServerContext`/`createTestServer` (`realmStagingTimer`, `generationEffectClock` from `GenerationRunnerDeps.effectClock` into `TriggerHost.now`, and `generationAbortGraceMs`), while proxy, the login limiter, translate and the stream break needed no production change; the user then chose to restart the effect clock where an alert answer, a `v2Wait` or a worker regex resumed after the event loop ran during that await (`e3ba64355`, tested in `chatMetadataCoalescing.test.ts`), and the client rows remain for slice 6b. Slice 6b (56c228579) then fixed them with test changes only: fake `setTimeout` for the stalled boot-cache open at both bounds and a 60 s bound elsewhere, and fake timers including `Date` for the `storedTranslation` sync poll and the `Chat` toggle.

6. **Pure duration assertions.** `mcp.test.ts` (401-404, 585-587), `luaRuntime.test.ts`
   (184-189, 283-292), `bootCache.test.ts:893`, `scriptWorker.test.ts` (six DUR rows:
   `ms < 3000/4000/1000/1500/7000`), `shutdown.test.ts` (215-220), `promptRunner.test.ts`
   (716-721), `triggerRuntime.test.ts` (1410-1416), `cbsLimitsJobs.test.ts` (375-378), and
   `hypaV3Limits.test.ts` (265-278, besides its CLOCK row). Most catch nothing that the terminal
   check or the Vitest timeout misses. Drop them, or use fake timers where the deadline is plain
   `setTimeout`. `manualTriggers` "ends at once with `aborted`..." keeps `< 15000` as
   `keep-accepted` (it separates a prompt abort from the 30 s wait).
   Slice 6b (56c228579) replaced the `bootCache.test.ts:893` duration check with fake setTimeout/clearTimeout that check one ms before and at the bound.
   Slice 7a (83b9f9591) put both `mcp.test.ts` deadlines under full fake timers (pending one ms before the 40 ms bound, settled at it) and deleted the `luaRuntime`, `triggerRuntime` and `cbsLimitsJobs` bounds, keeping their terminal checks; `mcp.test.ts` "shares one client per identifier..." kept its real sleep(90), which slice 9a (fd6805ccf) replaced with fake setTimeout/clearTimeout and an exact 39/40 ms idle boundary after the release.
7. **Fake timers without `"Date"` against a real `Date.now`.** resourceSync's `backoffUntil`,
   `timerDeadline` and the job-retry block read the real clock (`resourceSync.svelte.ts:451-483`,
   `runCycle`). Most harnesses are safe only because they flush explicitly; the reviewers checked
   every omission and found no further active one in storage or client files.
   - Real cases: `resourceSyncMerge.test.ts` (`toFake` at 119) and
     `resourceSyncRecreation.test.ts` (130), unchanged.
   - New: `bootstrap.safeBoot.test.ts` "loadData with safe boot" leaves `safeBoot.ts`'s
     `deps.now` real during the guest-ready deadline comparison; `backuplocal.test.ts` computes
     the upstream backup file name from a real `new Date()` twice, across awaits (freeze `Date`
     and assert a literal).
   - Fix: add `"Date"` to the harness `toFake` lists, as `resourceSyncNotices`, `resourceSyncLive`
     and `resourceSyncFeedPatches` already do.
     Slice 2 (7a1a083ba) fixed bootstrap.safeBoot and backuplocal, and slice 4a (7d52aa936) faked Date in resourceSyncMerge and resourceSyncRecreation; the merge failure cases still do not assert the backoff delay.

8. **Wall-clock complexity guards and large fixtures.** `mcp.test.ts` (8 MiB in < 5 s, 1011-1027),
   `mcpSse.test.ts` (80k events in < 3 s, 121-127), `projectionBindings.test.ts` (two
   tracked/direct ratios < 10, 2011-2012), and the cases whose only budget is a default or raised
   timeout: `moduleCache` 100k assets (294-319), `assetList` 100k names (196-224; noisy 776 ms
   after the heap merge, risk raised to med), `thoughts` 1 MB fixtures, `requestHistoryRoutes`,
   `app` and `importModule` 2000-request limiter runs, `exportBatches` 64 MiB caps,
   `characterCardsPngImport`, `resourceSyncHydration` (150,000 messages). New rows: `assets`
   "rejects record 2001 with 400..." (2000 fs-staged records), `backups` "refuses an archive with
   more records than the index allows" (the 200,000-record production cap), `resourceSyncLive`
   "reads at most 1,000 announced chats per request..." (1,001 chats under 20 s),
   `resourcePatchParts` "charges four units per cut text..." (6 and 17 MiB texts under 20 s), and
   `upstreamImportCharacters` "reports every repair of a chat with very many invalid messages..."
   (150,000 messages: `move-slow`). Count the work (bytes scanned, copies) instead, inject a small
   limit, shrink the fixtures where size is not the contract, or move the case to slow. Keep
   inputs that must cross a protocol boundary (more than 5,000 operations, 1,001 chats).
   Slice 7a (83b9f9591) fixed the server rows through test seams: `routeLimits` on `createServerContext`/`TestServerOptions` (`requestsPerMinute` 2000, `assetBatchRecords`, `archiveRecords`, `charxEntryBytes`; the login limiter and the asset read key-list cap are unchanged) and the `createResourceStore` options `patchBaseMaxUnits` and `inspectStoredText`, every default being the production value; the `assets`, `backups`, `importCharx` and `resourcePatchParts` production-size cases moved to slow per D2 beside small gated cases, the `mcp` and `mcpSse` guards count scanned and copied bytes (`countByteWork`), and `thoughts` stays `keep-accepted` per D3. Leftovers: a stored CharX entry exactly at the cap is still uncovered, the `mcpSse` scan bound has no slack, and `persistence.md` does not mention `AssetRecordParser`'s optional `maxRecords`.
   Slice 7b (45b6309bf) fixed the client rows with test changes only: smaller `moduleCache` (5,000) and `assetList` (2,000) fixtures, compression mocked for the `exportBatches` over-cap case (the cap counts raw bytes, so it stays 64 MiB), warmed and smaller `characterCardsPngImport` chunks, a 3,000-message gated `resourceSyncHydration` case beside a 150,000-message slow one, explicit 20 s budgets for the kept 5,001 operations and 1,001 chats, small boot modules in `resourceSyncPatches`, and a per-call mirror check (`refusedEach`, `unchangedEach`) for the CPU-bound refusals in the mutation stores and the risuaccess writers. Leftovers: "sends a modules edit as an item patch..." still needs its large module, production `isMember` in `chatStore.svelte.ts` scans a character's chat list through a proxy (quadratic per character), the `resourceSyncHydration` frame race stays for sweep 9b, and two `exportBatches` "export failure ownership" cases are new rows for sweep 9b (all but `isMember` closed in slice 9b).
   Slice 9b (0a6fb1aa5) closed the 7b leftovers with test changes only: the `resourceSyncPatches` large module uses 2,000-asset lists, still above `MAX_FEED_PATCH_BYTES`, the `resourceSyncHydration` frame race runs on a stubbed `requestAnimationFrame` with frames driven by hand, and the two `exportBatches` close cases send 3 assets (one request); `characterCardsRoundTrip` got a warm-up and level-0 deflate instead of a timeout raise. Leftover: the `exportBatches` read/write/zip cases still send 401 assets (160-190 ms idle; they passed the overload runs).
9. **Not overload failures (lower priority).** `sleep(n)` windows before a negative check
   ("nothing more happened"). Overload makes them pass vacuously; it never makes them fail. They
   are marked `keep-accepted` or `rewrite:deferred` where a latch would make the check meaningful.
   Two are `delete` (`backups.test.ts` "refuses restore, import, and export with 503 once dispose
   has begun..." and `memoryJobs.test.ts` "an abort during a summary makes no later request..."):
   the sleep follows a synchronous state change or an awaited abort, so no wrong implementation
   fails because of it. The deletion is of the sleep, not the test.
   Slice 9a (fd6805ccf) deleted both `delete` sleeps, kept both tests, and replaced the server `rewrite:deferred` sleeps with waits on the event itself (`embeddings`, `jobChannel`, `llmRoutes`, `llmSecrets`, `luaBindings`, `promptRunner` group send, `promptTail`, `shutdownAdmission`); the `jobChannel` stale-answer check was vacuous before and now fails without the superseded-socket guard. Slice 9b (0a6fb1aa5) left no client `rewrite:deferred` row (the client rows here are `keep-accepted`), and neither slice added a row that fails under overload. Minor 9a leftovers: failure-path cleanup gaps (`promptTail` paced waiters, `jobChannel`'s spy and paused client on a timeout, no afterAll close for the `generations` warm-up), and `generations`' `listen()` calls `attachWebSocket` twice (predates the slice).
10. **Real `MessagePort` delivery under a bounded poll (new).** `vi.waitFor` (real 1 s cap) waits
    for a message that a real Node `MessagePort` delivers on a later event-loop turn; faking the
    timeout does not deliver the port message. Reach: `nativeFetchAbort.test.ts` "aborts the host
    fetch after headers while the guest is reading the body" and "cancels a body the plugin never
    pulls from at 60 s..." (new), `guestBridge.test.ts` "pulls a nativeFetch body from the host
    only when the plugin reads it", `sandboxActivity.test.ts` "SandboxHost activity" (131, 155,
    182). Fix: install a message or activity-change latch before the action and await it.
    Slice 8 (645e093c2) fixed port-delivery waits with latches; the startup _getAliases, sandboxActivity RESPONSE and nativeFetchAbort terminate-case keep-poll rows remain unchanged because none waits on port delivery.

11. **Client CBS 2 s wall limit (new as a cause).** `CLIENT_CBS_LIMITS` in
    `parser.svelte.ts:1354-1358` still sets `maxMs: 2_000` with no injected `now`, and
    `shared/cbs/limits.ts` defaults to `performance.now`, so a deschedule inside one parse can raise
    `CbsLimitError` on a tiny legal template. Reach: `limits.test.ts` "the budget starts over for
    the next top-level parse" and the non-advancing-range test (74-83), plus "twenty-five sibling
    calls answer..." (103-108, new); `ChatBody.styles.svelte.test.ts` "ChatBody under a chat style
    registry" and `trimMarkdownSharingStyles.test.ts`, whose style decoding runs the real parser
    even for CSS without CBS tokens (new files). Fix: `stopClock()` as the work-limit siblings do,
    or a test seam for the client limits' `now`.
    Slice 2 (7a1a083ba) fixed all the listed client cases in limits.test.ts, ChatBody.styles.svelte.test.ts and trimMarkdownSharingStyles.test.ts by stopping the CBS clock; the production default remains real.

12. **SQLite durability on a disk-backed `/tmp` (new).** `resourcePatchParts.test.ts` "stores
    what the whole-record path stores, for field patches of a character" and "...for item patches
    of the module list" run 300-step property matrices against two file-backed SQLite stores
    inside the default 5 s; fsync cost on an overlay or disk `/tmp` (the CI container) is several
    times tmpfs. Fix: run the matrix on in-memory backing with a way to inspect the stored text,
    keep one small disk-backed case, or move the full matrix to slow.
    Slice 7a (83b9f9591) ran both matrices in memory through the `inspectStoredText` store option and kept one disk check through a second connection, which resolves the CI fsync timeout; the `build-test-platforms.md` CI note still cites the disk-fsync timings.

Not found: no heap/GC-dependent assertion (`HEAP` = 0). The new frozen-asset and node-pruning tests
check identity, freezing and counts, not heap size.

## 2. Per-spot list, grouped by file

Each spot: **lines** at `11d6e86f1`, the exact test title (or helper/describe name for helper
rows), kind (primary/secondary), whether the clock is controlled, **disposition**, risk under
overload, reason. Files modified by heap-memory-reduction and files fixed on 2026-10-18 are tagged
in their headings. Rows changed by the refresh end with `(2026-10-21: ...)`; rows it added end with
`(new 2026-10-21)`.

#### `server/src/tests/app.test.ts`

- **268-292** "allows the storage bucket's requests then returns draft-6 headers and Retry-After without blocking resource sync": PERF, controlled: partial. **rewrite:other(inject a small storage limit through createServerContext and exhaust that; keep one header check of the 2000;w=60 policy)** (risk: high). Date.now is frozen, but 2000 in-process requests with fs reads take 1.2 s idle against the default 5 s timeout; at 1/9 CPU share it times out. Under overload its timed-out loop keeps reading `assets/missing.bin`, so it also fails the next test, "reads well-formed keys with no storage location as missing without touching disk, and rejects writing or removing them" (seen in slice 6a; owner slice 7a). Risk: high (fixed in slice 7a (83b9f9591): renamed from "allows 2000 storage requests then returns draft-6 headers and Retry-After without blocking resource sync"; a 5-request bucket through `routeLimits.requestsPerMinute`, and the follow-on failure of "reads well-formed keys with no storage location as missing..." is gone with it)
- **197-198** "limits /api/login to 10 attempts per window with draft-6 RateLimit headers": CLOCK, controlled: no. **rewrite:fake-timers** (risk: med). Retry-After /^(29|30)$/ reads the real Date.now in rateLimit.ts; a stall of more than 2 s between the first attempt and the blocked one gives 28. The sibling 2000-request test already spies Date.now. Risk: med (fixed in slice 6a (328634ecd): Date.now drives the limiter; Retry-After is exactly 30, the window still closed at +29.999 s and open at +30 s)

#### `server/src/tests/assemble.test.ts`

- **296,338,357,369** "assembles the ${name} fixture's prompt as the browser did" / "picks the presetChain preset with the seeded random, tells the tab, and assembles with it" / "renders the jinja fixture's previewPrompt body (the Ooba request) as the browser did": TMO, controlled: no. **keep-accepted** (risk: low). Real server + default runner (lazy script-worker boot, regex scripts under the ELU-based 5000+1000 ms runScripts budget) raced against a 45 s socket cap and SLOW=60 s timeout; margin ~10x the normal run; risk low

#### `server/src/tests/assets.test.ts`

- **191-198** "stages incoming bytes and lets maintenance begin while the next record body is paused": POLL, controlled: partial. **rewrite:deferred** (risk: med). server testSupport waitFor (2 s real Date.now cap, 10 ms real poll) on real async fs staging writes through the batch route; after a >2 s deschedule the poll timer runs in the timers phase before the fs completion callbacks and the helper throws without a final re-check; risk med (fixed in slice 3 (88953f6d0): retains an uncapped poll; an event latch catches no additional wrong implementation)
- **204** "stages incoming bytes and lets maintenance begin while the next record body is paused": POLL, controlled: yes. **keep-poll** (risk: low). waitFor(() => entered) on withMaintenance's in-process exclusive/listener promise chain only (no I/O); risk low (cap removed in slice 3 (88953f6d0))
- **234-242** "rejects record 2001 with 400 after keeping the first 2000 writes": PERF, controlled: no. **move-slow** (risk: med-high). The default 5 s test awaits 2000 sequential real staging writes, including mkdir/open/close/rename for every empty record (storage.ts:455-477). Reusing one destination does not avoid that I/O. As with app.test.ts's 2000-request row, the workload is an implicit wall-clock budget under overload. A small injected cap would still catch an absent or off-by-one cap; no duration was measured for this row. (new 2026-10-21) (fixed in slice 7a (83b9f9591): moved to slow per D2; the gated coverage is the new cap-3 case "keeps a batch of exactly the cap, and rejects the record past it with 400 after keeping the earlier writes" through `routeLimits.assetBatchRecords`)

#### `server/src/tests/auxOps.test.ts`

- **113** "startUpstream": SLEEP, controlled: yes. **keep-det** (risk: none). the destroy follows the written chunk whatever the delay; no proxy timeout without risu-timeout-ms; real loopback server, light work; risk none

#### `server/src/tests/backups.test.ts`

- **143** "lists the completed snapshots newest first and requires auth": CLOCK, controlled: partial. **keep-accepted** (risk: low). sleep(2) keeps two snapshotNow() ids (stamped from real new Date(), sorted by id) in distinct ms; load only widens the gap, never shrinks it (risk: low)
- **289,291** "refuses a restore queued behind another one with 412 before taking its safety snapshot": POLL, controlled: no. **rewrite:call-through-spy** (risk: med). testSupport.waitFor has a 2 s Date.now deadline, polling until each restore (JWT signed via WebCrypto threadpool, then routed) reaches snapshots.track; a >=2 s deschedule makes the 10 ms timer fire before the I/O completes and it throws; resolve a deferred from the track spy instead (risk: med) (fixed in slice 3 (88953f6d0): retains an uncapped restore-spy poll; an event latch catches no additional wrong implementation)
- **381,383** "lets an asset removal admitted before a restore finish before the restore runs": SLEEP, controlled: no. **rewrite:call-through-spy** (risk: high). sleep(30) then a POSITIVE assert gate.active === true: needs the restore request (JWT sign + route + withMaintenance) to reach the gate within 30 ms real; await a deferred resolved by a track/withMaintenance spy, or poll gate.active with no deadline (risk: high) (fixed in slice 3 (88953f6d0): waits for the maintenance gate and records removal-before-restore order)
- **340,567,610,615,655,1281** "answers 503 with Retry-After for resource and storage mutations while a restore or import holds the files, reads stay open" / "removes the staging copy once when the download is cancelled mid-stream" / "cleans up an export the client abandoned during preparation, and keeps shutdown waiting until then" / "finalizes only after the staging folder exists when the client leaves during its creation" / "refuses restore, import, and export with 503 once dispose has begun, without starting their work": SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(20) then a negative check (still null, one rm, stopped false, tmp empty); load only makes a buggy impl more likely to slip through, a correct one never fails; 340 could instead wait for the track spy before asserting the restore is still queued (risk: low)
- **1270** "refuses restore, import, and export with 503 once dispose has begun, without starting their work": SLEEP, controlled: partial. **delete** (risk: low). sleep(10) after context.dispose() is unneeded: dispose() calls beginShutdown() synchronously before the 503 requests; no wrong implementation is caught by the extra 10 ms (risk: low) (fixed in slice 9a (fd6805ccf): the sleep(10) is deleted and the test kept)
- **555,566,586,589,608,950,978** "fails the download when a listed asset disappears after the manifest was fixed, and cleans up" / "removes the staging copy once when the download is cancelled mid-stream" / "releases the staging copy and the lifetime when the client aborts after the first chunk without cancelling" / "cleans up an export the client abandoned during preparation, and keeps shutdown waiting until then" / "refuses an upload that a restore overtook with 412 before writing any asset" / "runs one import at a time and recovers admission after a staging failure": POLL, controlled: no. **rewrite:other(drop testSupport.waitFor's 2 s Date.now deadline and rely on the Vitest timeout, or wait on fs.rm/mkdir spies)** (risk: med). waitFor polls readdirSync of .tmp / a stopped flag. The work is real fs I/O plus stream teardown and snapshots.stop(), capped by a 2 s wall deadline that is checked after the 10 ms timer fires (timers run before I/O after a deschedule) (risk: med) (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **861-877** "refuses an archive with more records than the index allows": PERF, controlled: no. **move-slow** (risk: med). The gated test builds and indexes a MAX_ARCHIVE_RECORDS=200000-record boundary fixture under the default 5 s timeout. indexArchive loops over every header with three awaited bytesAt reads and grows the result array, even though the read window amortizes actual disk reads (archive.ts:67-96). This leaves real CPU/scheduler throughput as the budget; keep the rejecting-boundary contract with a small test limit. No duration was measured. (new 2026-10-21) (fixed in slice 7a (83b9f9591): moved to slow per D2; the gated coverage is the new cap-8 case "refuses an archive past an injected record cap and imports one of exactly the cap" through `routeLimits.archiveRecords`)

#### `server/src/tests/cbsLimits.test.ts` (2026-10-18 fixed file)

- **94,109-119,185-296,563-588** "bounded" / "fakeClock" / "the clock" / "the shared allowance (total)": CLOCK, controlled: yes. **keep-det** (risk: none). Every clock-sensitive assertion uses an injected now. Line 232 spies only to prove the unbounded path never reads it (risk: none)
- **516-533** "answers every host-parity case under the server's limits as the fixture expects": CLOCK, controlled: partial. **keep-accepted** (risk: low). toFake:["Date"] leaves performance.now real for serverCbsLimits (5 s per parse, 60 s total). The parses are tiny and usedMs>0 is load-monotone (risk: low)
- **635,675-679** "a non-advancing range answers [] under the server's limits (it used to spend the whole work budget)": BOOT, controlled: no. **move-slow** (risk: med-high). Gated, but spawnSync runs a fresh Node process importing the evaluator inside the default 5 s Vitest timeout. 308-317 already cover [0,1,0] in-process, so this is a delete candidate (risk: med-high) (fixed in slice 1 (40ab0dce4): fresh Node process moved to slow, retained per D2)

#### `server/src/tests/cbsLimitsHost.test.ts` (2026-10-18 fixed file)

- **111,357,557-568** "tickingClock" / "latch a reached limit as the job's fatal failure named after the chat owner, seen through every closure, and evaluate nothing after it" / "does not yield between quick effects: a stop queued during them lands after the run": CLOCK, controlled: yes. **keep-det** (risk: none). Controlled clocks. The setTimeout(0) at 565 runs after the earlier-queued 0 ms stop timer, which is timer order, not time (risk: none)
- **125-151,153-242,381-427,544-555** "hostOf" / "bindingsSetup" / "yields a turn once an effect held the thread over 50 ms, so a stop queued meanwhile ends the run before the next effect": CLOCK, controlled: partial. **keep-accepted** (risk: low). The allowance-sharing parses, default-variable/calculator evaluations and the ordinary binding cases retain serverCbsLimits' real performance.now clock (5 s per parse, 60 s per job); their small inputs give a large margin, and usedMs>0 only becomes easier under load. runtimeHolding(80, 4, 5) deliberately busy-waits on the real clock: crossing the 50 ms yield window is load-monotone, but the 5 ms abort timer and the default 5 s test timeout remain real. The injected/stopped-clock cases are in the preceding row. (2026-10-21: corrected keep-det to keep-accepted and extended the aggregate to the other default-clock host/binding parses; no clock fix landed)

#### `server/src/tests/cbsLimitsJobs.test.ts`

- **375-378** "ends with the limit error after the input stage, keeps the user message, calls no provider, and the chat serves the next send": DUR, controlled: no. **rewrite:other(drop the Date.now 20 s bound; the 45 s ws cap and the LIMIT alternation already catch a limit that never ends)** (risk: low-med). Real server plus worker pool plus a send under overload. The bound catches no wrong implementation the terminal check misses (risk: low-med) (fixed in slice 7a (83b9f9591): the duration bound is gone)
- **25,253,357** "job": TMO, controlled: partial. **keep-accepted** (risk: low-med). Real listening server and real workers, 1-4 jobs per test against 60 s. The LIMIT regex accepts the 5 s wall-limit terminal. The Lua (3 s) and regex-scripts (5 s) ELU budgets only fail on gaps of several seconds (risk: low-med)

#### `server/src/tests/chatMetadataCoalescing.test.ts`

- **413-423,496,517,554** "flushes before the trigger baseline and on successful or throwing trigger exit" / "keeps the trigger result's whole-map replay after a concurrent key arrives" / "splits a native loop at its iteration yield" / "splits native setter batches at the effect clock yield": CLOCK, controlled: yes. **keep-det** (risk: low). Both yield tests inject now() (() => clock, () => 0). The runOnCopy tests use the default performance.now 50 ms effect yield, created at setup(), but a yield there only adds a setImmediate turn: the explicit flush calls and final-state assertions do not depend on it. Risk: low

#### `server/src/tests/chatMetadataCoalescingEvents.test.ts`

- **449-459 (waits 427,440)** "persists %s batches and reports the final stored revision to HTTP and the owner": CLOCK, controlled: no. **rewrite:injected-clock** (risk: high). The trigger effect loop yields once performance.now() - lastEffectYieldAt > 50 ms (EFFECT_YIELD_AFTER_MS, triggers.ts:541; runSetup.ts:386 passes no host.now). lastEffectYieldAt is set when the runtime is built and never reset by the alert-input wait, so if more than 50 ms pass between job setup and the answer, the first setter after v2GetAlertInput yields, the queued metadata microtask flushes {$ready} by itself, and transactions/patches come out as 2, not the exact 1 expected. Fix: inject the clock (host.now) through the default runner. risk: high (fixed in slice 6a (328634ecd): a frozen generationEffectClock gives exactly one write for the manual batch; this is the manual batch slice 4a still saw failing under overload)
- **141,147,196,201,255,427,440** "flushes channel requests even before the owner attaches" / "flushes one batch before %s leaves the job" / "persists %s batches and reports the final stored revision to HTTP and the owner": POLL, controlled: no. **rewrite:deferred** (risk: med). testSupport waitFor (a Date.now deadline, default 2000 ms, 10 ms steps) polls events from a real WebSocket. The button variant also waits on the first Lua worker boot plus the run (line 425). After a stall the poll's timer runs before the socket read and throws once the deadline has passed. Fix: resolve a promise from ws.on("message") for the awaited event type. risk: med (high for 425 button) (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait; the 50 ms trigger yield remains for slice 6a) (slice 9a found it already fully fixed: the poll by slice 3, the trigger yield by slice 6a)
- **427-462** "persists %s batches and reports the final stored revision to HTTP and the owner": CLOCK, controlled: no. **keep-accepted** (risk: low). The Lua run's charged time is the worker's eventLoopUtilization active time, which is wall time, against DEFAULT_LUA_CPU_MS 3000 (workerPool.ts:463-475). Only a stall of more than 3 s inside the run kills it. Margin is about 20x the normal run. risk: low

#### `server/src/tests/diagnostics.test.ts`

- **602-648,653-658** "is written at most 5 s after the first error event (not postponed by later ones), every 10 minutes once started, and no more after close" / "never throws from a timer when the write fails: the failure is counted": CLOCK, controlled: yes. **keep-det** (risk: low). vi.useFakeTimers({ now }) with no toFake fakes Date too and the journal clock is injected (now: () => clock); risk low
- **888,892,933** "records `accepted` at admission and `done` or `error` (with the failure fields and the duration) at the end, and counts the live jobs": POLL, controlled: partial. **rewrite:deferred** (risk: med). ended() = server waitFor (2 s real cap) racing the fake runner's real sleep(20); a >2 s deschedule inside those 20 ms lets the poll timer fire first, see the job not ended and throw; durationMs>=15 (generationJobs Date.now) is only a lower bound overload increases; risk med (fixed in slice 3 (88953f6d0): removed the poll cap; retains sleep(20) and the load-monotone durationMs >= 15 lower bound)
- **901,905,918,961,975,1132,1631** "records `accepted` at admission and `done` or `error` (with the failure fields and the duration) at the end, and counts the live jobs" / "runs a job to its end when the diagnostics folder is broken (a file in its place) or the recorder throws" / "records a job through the real wiring, and serves a request and a job when the diagnostics folder is a file" / "refuses the save with a 503 once shutdown began: at admission, and again after a body read that outlasted the admission, with nothing saved": POLL, controlled: yes. **keep-poll** (risk: low). server waitFor on in-process work only (rejecting/aborted runners, sync sqlite, in-process body pull); risk low (cap removed in slice 3 (88953f6d0))
- **1152-1157** "records `shutdown` and writes the final state at dispose after the admitted work ended, while the stores are open; a later dispose changes nothing": SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(5) only so the real-clock writtenAt differs from the first state write; overload only lengthens it (rewrite:injected-clock possible); risk low
- **1071-1082,1100-1104** "records an `http` event for an answer of 400 or more with the registered template of the last handler that ran (`/*` for a miss, the route for its own auth, the handler's for a 500; a template outside `ROUTE_TEMPLATES` is left out), never for a success, never the URL" / "records maintenance start and end (with `replaced`) and `restore` only after a restore replaced the data": CLOCK, controlled: no. **keep-accepted** (risk: low). app.ts middleware also records any request whose performance.now duration exceeds HTTP_SLOW_MS=5000; a 200 (or the restore POST) taking >5 s would add an event to these exact toEqual lists; 5 s margin vs ms of work; risk low

#### `server/src/tests/embeddings.test.ts`

- **629-630** "an abort during a rate-limited batch ends the waiting tasks and rejects with the reason": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). setTimeout(10) as settle before expecting exactly 1 call; work before the fake fetch is in-process (sync node:sqlite cache, microtasks) so it cannot be outrun, but should await a fetch-entered latch; rate window is real Date.now 60 s (huge margin); risk low (fixed in slice 9a (fd6805ccf): waits for the first fetch, then checks that the queued task count goes from 1 to 0 at the abort while that fetch is held, which now catches a missing abort cancellation the limiter's fail-fast used to hide)

#### `server/src/tests/events.test.ts`

- **112,116,142,155,169,227** "admits a JWT in the query or the header and sends `hello` with the epoch" / "delivers every committed change to every socket, refs and revisions only, and a deletion as null" / "closes every socket with 1001 on shutdown and refuses new ones": POLL, controlled: no. **rewrite:deferred** (risk: med-high). testSupport waitFor (2 s real cap, Date.now deadline, 10 ms real setTimeout) waits for frames over a real loopback WebSocket; after a >2 s deschedule the timer phase runs before the poll phase reads the socket, so the deadline check throws first; await a promise resolved by the message handler instead (risk: med-high) (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **265,287,299,305,317,320,323,327** "refuses (503) a socket whose authorization finished after `close()`" / "terminates a socket whose `send` throws and still delivers the frame to the sockets after it" / "pings every 15 s, publishes `epoch` frames, and forgets a closed socket and its timer": POLL, controlled: partial. **rewrite:deferred** (risk: med-high). same 2 s real-cap waitFor on real socket I/O (upgrade reaching authorize, frames, server-side close shrinking sockets.size); the 15 s ping is faked (setInterval only) but the frame it sends still crosses a real socket (risk: med-high) (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **123,313-319** "refuses the raw password, an expired or broken JWT, and no token (401), without a frame" / "pings every 15 s, publishes `epoch` frames, and forgets a closed socket and its timer": CLOCK, controlled: yes. **keep-det** (risk: low). exp = now-10 s can only get more expired under a deschedule; the heartbeat interval is faked and only ts: any(Number) is asserted (risk: low)

#### `server/src/tests/generationDeltaChunks.test.ts`

- **208,357,365** "until" / "puts committed patches on both live sockets and omits patches from HTTP batches": POLL, controlled: no. **rewrite:deferred** (risk: med-high). testSupport waitFor has a 2000 ms real Date.now cap while it waits for frames on a real loopback WebSocket. A 1-3 s stall makes it throw before the queued frames are delivered. Resolve on onmessage instead and let the Vitest timeout catch hangs. Risk: med-high (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **186,194,339-341** "follow": CLOCK, controlled: no. **rewrite:deferred** (risk: med). The owner socket closes itself after 4000 ms of real time. Under a stall it can close before "done" or the later accepted frames arrive, so the frame waits fail. Risk: med (fixed in slice 3 (88953f6d0): closes on terminal frames instead of a real 4 s timer)

#### `server/src/tests/generationJobs.test.ts`

- **533-596** "lets the first abort decide the outcome and fixes one deadline per job, after which a runner that ignores its signal is ended for it": CLOCK, controlled: yes. **keep-det** (risk: none). abort grace is a setTimeout (faked); Date.now only feeds startedAt/endedAt for startGc, which no test here starts; checked, controlled
- **188,760,794** "ended" / "aborts the jobs while writes stay open, so the abort checkpoint lands before the replacement and in the safety snapshot" / "beginShutdown aborts every job with shutdown and refuses new ones; drain resolves at their end; dispose follows": POLL, controlled: partial. **keep-poll** (risk: low). testSupport waitFor 2 s cap over in-process jobs on synchronous node:sqlite; no I/O; risk low (cap removed in slice 3 (88953f6d0))
- **529,801** "turns a runner's return, throw, and unserializable result into one safe error terminal, and the tracked lifetime still ends" / "beginShutdown aborts every job with shutdown and refuses new ones; drain resolves at their end; dispose follows": SLEEP, controlled: yes. **keep-det** (risk: low). the awaited promises resolve by microtasks once the jobs ended (stop() with nothing active, drain over resolved finished), which always beats a timer; guard only; risk low

#### `server/src/tests/generationMetadataEvents.test.ts`

- **139,145,165,172,200,216** "metadata delivery to the job owner": POLL, controlled: no. **rewrite:deferred** (risk: med-high). testSupport waitFor (2 s real cap) on events arriving over a real generation WebSocket and on ownerAttached() flipping after a real socket close; overrun by a >2 s deschedule before the poll phase reads the socket (risk: med-high) (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)

#### `server/src/tests/generations.test.ts`

- **186,194; closed awaited at 319,404-406,411,420,429,436,448,459,614,646,734,795,805,855,873,920,922** "follow": POLL, controlled: no. **rewrite:other(drop the 4 s auto-close; close on the terminal or explicitly and let the Vitest timeout be the only cap)** (risk: med-high). follow() closes the owner socket 4 s (real) after attach; tests that keep one socket across many JWT-signed HTTP round-trips and steps lose their late events (done/error) if the body overruns 4 s under 9x slowdown plus a 1-3 s stall; risk med-high (fixed in slice 3 (88953f6d0): closes on terminal frames instead of a real 4 s timer)
- **208 (until); calls at 298,408,416,421,425,438,442,456,593,666,689,711,726,743,754,775,785,828,831,845,864,866,898,903,912** "until" / "dispatches upgrades by path: an unknown path is destroyed, the live-update socket works beside the generation socket, and shutdown removes the listener": POLL, controlled: no. **rewrite:other(event-driven waiter resolving on the socket's message, no Date.now deadline)** (risk: med). testSupport waitFor: Date.now deadline of 2000 ms polled every 10 ms over real loopback WebSocket I/O; after a stall the expired 10 ms timer runs before the poll phase reads the pending frames and Date.now is past the deadline, so it throws; risk med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **73-76 (afterEach nulls `wake` before server.close), 395 (second job admitted, never ended)** "admits one job per chat, streams the chat hydration, accepted, chunks, and done to the owner with the epoch, and answers the status DTO": CLOCK, controlled: no. **rewrite:other(end the job admitted at 394, or wake the runner before clearing `wake`)** (risk: med). The leaked job's runner never sees its abort, so dispose waits JOB_ABORT_GRACE_MS=5000 real (generationJobs.ts:47); measured 5.1 s per run against the 10 s default hookTimeout; 5 s margin shrinks under overload and wastes 5 s every run; risk med-low (fixed in slice 9a (fd6805ccf): each runner wakes on its own abort, so teardown no longer waits the 5 s abort grace)
- **87-123 (listen) in every test** "generation jobs over HTTP and WebSocket": BOOT, controlled: no. **rewrite:raise-timeout** (risk: low-med). Server boot + login + 3 reads + seed batch + dozens of ECDSA-signed requests under the default 5 s timeout; bodies take 60-600 ms normally, so ~9x slowdown plus a stall comes close to 5 s; risk low-med (fixed in slice 9a (fd6805ccf): a beforeAll warm-up instead of a timeout raise; a cold `listen()` costs about 113 ms of CPU against 25-36 ms warm)
- **457** "publishes each applied write's coverage, retires the reply at its final, and re-sends the fresh records and the result on every attach": SLEEP, controlled: partial. **rewrite:deferred(wait for the expected event count, or for the attach batch, instead of 30 ms)** (risk: low). Collects the rest of the attach batch for 30 ms, then closes. The server sends the batch in one synchronous loop (generationJobs.ts:1239-1241), so it lands in one loopback read before until() returns; risk low (fixed in slice 3 (88953f6d0): uses a ping/pong fence instead of sleep(30))
- **439,481,504,517,531,538,550,741,843,846** "keeps one delivery stream per job, orders handshakes by their attach stamp, and refuses the password, another client, and an unknown job" / "publishes each applied write's coverage, retires the reply at its final, and re-sends the fresh records and the result on every attach" / "sends the job chat as a patch from the copy a socket last took (rows with their anchor, removed ids, the meta when it changed), whole on `resync`, on a reorder, and after the end; an event no socket took does not move the base" / "answers `resync` with the chat whole and then the current reply while its generation still owns the message (a command job's `accepted` too), and with the chat alone once the reply is final": SLEEP, controlled: yes. **keep-det** (risk: low). The runner is parked on `wake` (started at create via Promise.resolve().then), and each step's job.write/emit is synchronous, so the step finishes in microtasks before the sleep starts; the sleeps are redundant (845 is a negative check that can only false-pass); risk low

#### `server/src/tests/hypaV3Limits.test.ts` (2026-10-18 fixed file)

- **106,113-118** "the %s loop ends with an error instead of spinning": BOOT, controlled: no. **move-slow** (risk: med-high). spawnSync of a fresh Node process importing hypav3.ts (30 s spawn cap) inside a sync test with the default 5 s timeout, which Vitest enforces after return (risk: med-high) (fixed in slice 1 (40ab0dce4): fresh Node process moved to slow)
- **261-279** "ends a catastrophic pattern on a real worker while the event loop stays free": CLOCK, controlled: no. **move-slow** (risk: high). hypav3.ts:57,77 checks the real 5000 ms chunking budget before the regex error, so a cold boot of more than 5 s gives "chunking budget exhausted". The test's <5000 and <1000 bounds and the default 5 s timeout are wall time too (risk: high) (fixed in slice 5b (6f4b9191d): moved to slow per D2 with the pool warmed, the `< 5000` bound dropped and the `< 1000` timer bound kept; the gated coverage is three new tests of the host's separator limits, `MemoryHost.separatorLimits` in both implementations)
- **196-258** "summary chunk separator": CLOCK, controlled: partial. **keep-accepted** (risk: low). The two chunking-budget cases at 227-258 stub performance.now and are deterministic. The split, invalid-pattern fallback and mocked worker-timeout cases at 196-225 still run the real cumulative 5000 ms chunking budget, despite using only an in-process fake regex; the margin is 5 s for tiny microtask-only work. (2026-10-21: corrected the mixed aggregate's keep-det classification: three successful/error-shape paths still read a real clock; both explicit budget tests remain controlled)

#### `server/src/tests/importCharx.test.ts`

- **124-125,271-288** "firstAssetClock" / "throttles progress to 200 ms and always reports the final asset": CLOCK, controlled: yes. **keep-det** (risk: none). route's 200 ms progress throttle reads performance.now, which both tests mock (times[] by asset count; firstAssetClock 0/200); the other tests only assert at(-2)/at(-1) and total, which stay valid if extra progress lines appear under load
- **375,433,503,517** "shares admission with a running %s upload and releases it after spool cleanup" / "ends with one error and stops writing after %s" / "holds admission through streaming and shutdown waits for %s": POLL, controlled: no. **rewrite:other(drop testSupport.waitFor's 2 s Date.now deadline; rely on the Vitest timeout)** (risk: med). testSupport.waitFor with a 2 s wall cap polls for real fs results: staged file size 20, first asset written after inflate+hash+write, and dispose() completing; a >=2 s deschedule inside the window throws (risk: med) (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **220-261** "excludes declared and decoded oversized entries in file order with the exact readable asset total": PERF, controlled: no. **move-slow** (risk: high). Zips and inflates a 50 MiB entry inside the default 5 s timeout; timed out in all three overload runs. Inject a small test-only entry-size limit or move the production-size case to slow; owner slice 7a. (new 2026-10-21, found by slice 3) (fixed in slice 7a (83b9f9591): moved to slow per D2 with the 50 MiB literal kept as the policy anchor; the gated coverage is "excludes declared and decoded oversized entries at an injected entry limit, in file order with the exact readable asset total", a 1 KiB `routeLimits.charxEntryBytes`; leftover: a stored entry exactly at the cap was never covered and still is not)

#### `server/src/tests/importModule.test.ts`

- **318,331,363,411,414,474,478,484,486** "keeps admission through spool and response streaming, and shutdown waits for the admitted import" / "ends a started stream with one error on %s, preserving earlier files" / "cleans staging and releases admission and shutdown after %s" / "cleans an upload abandoned on a real socket during %s": POLL, controlled: no. **rewrite:raise-timeout** (risk: med). testSupport waitFor (2 s Date.now cap) on statSync of the spooled file, asset files, staged dir and a real http socket abort; all libuv fs/socket I/O, so a >2 s stall fails it; risk med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait; no timeout increase needed)
- **347,421,493** "keeps admission through spool and response streaming, and shutdown waits for the admitted import" / "cleans staging and releases admission and shutdown after %s" / "cleans an upload abandoned on a real socket during %s": POLL, controlled: no. **rewrite:other(await disposing directly)** (risk: low-med). redundant poll on the dispose promise with a 2 s real cap over fs cleanup; the following `await disposing` already proves it; risk low-med (fixed in slice 3 (88953f6d0): removed the redundant disposed poll's cap; duplicate wait is harmless)
- **296-300** "checks JWT, the shared authenticated limiter, maintenance and missing body before reading": TMO/PERF, controlled: no. **rewrite:other(inject a small limiter limit through the server options)** (risk: med). spends ~2000 real in-process requests (limit 2000, 60 s window) under the default 5 s test timeout; 392 ms idle, ~3.5 s at 9x plus any stall -> timeout; risk med (fixed in slice 7a (83b9f9591): a 20-request bucket through `routeLimits.requestsPerMinute`)
- **136-137,182-204** "firstRecordClock" / "throttles progress to 200 ms while always reporting the last record": CLOCK, controlled: yes. **keep-det** (risk: none). progress throttle clock is spied to 0/200 by asset count; checked, controlled; risk none

#### `server/src/tests/importRealm.test.ts`

- **855-860** "removes a staged import that waits past its expiry; its commit answers 404 and writes nothing": CLOCK/SLEEP, controlled: no. **rewrite:other(inject the staging timer or an expire() hook into createRealmStaging; give the commit-first half a huge TTL)** (risk: high). prepare's answer -> commitRequest must take the import before a REAL 200 ms setTimeout TTL fires; ~20-50 ms normally, a 1-3 s deschedule or 9x slowdown lets the TTL win and the commit answers 404; the 250 ms sleep itself is ordered after the TTL timer (ok); risk high (fixed in slice 6a (328634ecd): a held realmStagingTimer expiry checks the scheduled TTL and that a late fire after the commit's take removes nothing)
- **847-850** "removes a staged import that waits past its expiry; its commit answers 404 and writes nothing": POLL/CLOCK, controlled: no. **rewrite:other(staging timer/expire hook, then await the removal)** (risk: med). waitFor (2 s Date.now cap) waits for a real 50 ms TTL timer plus async fs removal of the staged file; a >2 s stall while the rm callback is pending makes waitFor throw; risk med (partly fixed in slice 3 (88953f6d0): removed the poll's wall deadline; still open: real staging TTL, slice 6a) (fixed in slice 6a (328634ecd): the test fires the held realmStagingTimer expiry, and nothing is removed before it fires)
- **1023-1028** "a client that leaves before reading the prepare's line leaves nothing staged past the expiry, the slot free": POLL/CLOCK, controlled: no. **rewrite:other(staging timer/expire hook)** (risk: med). real 100 ms TTL timer + fs cleanup awaited by waitFor with a 2 s real cap (testSupport waitFor uses Date.now deadline); risk med (partly fixed in slice 3 (88953f6d0): removed the poll's wall deadline; still open: real staging TTL, slice 6a) (fixed in slice 6a (328634ecd): the abandoned prepare waits for its realmStagingTimer expiry to be registered before cancelling)
- **119,289,297,462-463,506,520,649,658,715** "startRealm": POLL, controlled: no. **rewrite:raise-timeout** (risk: med). polls a real loopback HTTP server's socket close/request arrival with testSupport waitFor's 2 s Date.now cap; socket events are libuv I/O, so after a long stall the poll timer runs before the close callback and throws; risk med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **629,650,688,750,781,887,903** "refuses a download during maintenance and while another import holds the slot, without contacting Realm" / "holds the slot while the download runs, aborts the download when the client leaves, and frees the slot" / "holds admission through the PNG commit stream and shutdown waits for %s" / "a response cancelled during the image copy stops the copy at its next piece and publishes no image" / "ends with one error line and stops writing after %s" / "frees the shared slot while an import waits: other imports run, and its commit takes the slot like any import": POLL, controlled: no. **rewrite:raise-timeout** (risk: med). waits on real fs spool/asset writes through a real streamed request, 2 s real cap; risk med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **710** "holds admission through the PNG commit stream and shutdown waits for %s": POLL, controlled: no. **rewrite:other(await disposing directly; the waitFor(disposed) duplicates it)** (risk: low-med). waitFor(() => disposed) is the same promise as the next line's `await disposing` but with a 2 s real cap over fs cleanup; risk low-med (fixed in slice 3 (88953f6d0): removed the redundant disposed poll's cap; duplicate wait is harmless)
- **1061,1074** "refuses a card or asset chunk over MAX_PNG_TEXT_CHUNK_BYTES and reads no other text chunk" / "refuses more than MAX_PNG_CHUNKS chunks (the asset-chunk cap is in importPngCaps.test.ts, slow)": TMO/PERF, controlled: partial. **keep-accepted** (risk: low). measured 2.3 s / 1.2 s on an idle box against a 60 s timeout (26x / 49x margin) for big real-fs data; 9x overload ~20 s still fits; risk low

#### `server/src/tests/jobChannel.test.ts`

- **798-803 (next), 913, 935** "connect" / "re-sends a pending question on a reconnect as a replay, ignores the superseded socket's answer, and times out with a cancel" / "reports a disconnect for a question nobody could answer": POLL, controlled: no. **rewrite:deferred** (risk: med). Client.next() polls with testSupport waitFor (2 s Date.now deadline) on events from a real WebSocket. Line 935 waits 2 s for a real 200 ms channel timer. A stall of 1-3 s while a read is pending lands the deadline check before the socket callback. Fix: event-driven next() (resolve on onmessage) with no wall cap, or a much larger cap. risk: med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **899,930** "re-sends a pending question on a reconnect as a replay, ignores the superseded socket's answer, and times out with a cancel" / "reports a disconnect for a question nobody could answer": CLOCK, controlled: no. **keep-accepted** (risk: low). These are real channel timers in production (createChannelHub now = Date.now, real setTimeout), and the timeout is the subject. Only the outcome kind is asserted, and nothing answers the question, so a stall cannot reorder it. The exposure is the 2 s poll above. risk: low
- **910-911** "re-sends a pending question on a reconnect as a replay, ignores the superseded socket's answer, and times out with a cancel": SLEEP, controlled: no. **rewrite:deferred** (risk: low). sleep(100), then a negative assertion (outcome.first undefined) after the stale socket's answer. Under load the server may not have read the answer yet, so the check passes without testing anything instead of failing. Fix: wait for a server-side signal that the stale answer was handled (a spy on handleMessage, or a round-trip marker). risk: low (false pass) (fixed in slice 9a (fd6805ccf): the stale answer now reaches the server over the wire before the check; the old version was vacuous, passing with the superseded-socket guard in `generationJobs.ts` removed, and the new one fails without it)
- **833** "delivers a callback requested before the owner attaches as a first delivery, hydrated right before it, and takes its answer": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). sleep(50) stands in for "the job has requested its callback". The in-process runner always gets there first, and if it did not, the event order would be the same anyway, so the test would pass without covering the before-attach path. Fix: a latch resolved in the step after channel.callback() is called. risk: low (fixed in slice 9a (fd6805ccf): the owner attaches only after the callback is requested)
- **122-160,276-306,322,350,474-493,626** "harness": CLOCK, controlled: yes. **keep-det** (risk: none). Injected now() plus faked setTimeout/clearTimeout. tick() moves both together. state() uses one setImmediate as an in-process microtask probe. risk: none

#### `server/src/tests/jobMetadataScope.test.ts`

- **285** "Lua setters land before the next task, preserve concurrent keys, and adopt metadata without message reads": SLEEP, controlled: yes. **keep-det** (risk: none). setTimeout(0) asserts the queueMicrotask write (jobScope.ts:482) lands before the next task; sync sqlite store, no I/O; risk none

#### `server/src/tests/llmCharsetRetries.test.ts`

- **195,203-225** "ends with the request's failure once the retries are spent, yielding between attempts" / "observes a stop scheduled from a timer while the rejections continue": BOOT, controlled: no. **move-slow** (risk: med). spawnSync starts a fresh Node process that loads the whole server from TS, a resource test client, sqlite and a 2000 x 10 ms terminal poll, with a 60 s kill and a 90 s test timeout. The child is the subject (the pre-fix hang could not be stopped in process), and the slow tag's own description covers "fresh Node processes". Under 1 CPU + 8 burners the child gets about 1/9 of the CPU. risk: med (fixed in slice 1 (40ab0dce4): both fresh-process retry cases moved to slow)
- **68-99** "yields a turn of the event loop between attempts" / "an abort raised by a timer between attempts ends the loop before the next attempt": SLEEP, controlled: yes. **keep-det** (risk: none). Both in-process cases queue setImmediate during the first scripted attempt; outer.ts:7,73 queues its next turn afterwards. They assert immediate FIFO ordering and an abort fence, with no elapsed-time threshold, worker or I/O race. Removing the outer loop's yield would make the first case report -1 and the second consume the clean answer. (new 2026-10-21)

#### `server/src/tests/llmLegacyFormats.test.ts`

- **253-280,382-416,446-447,490,513-576** "Horde: the async request with the api key header, then the status polls until the generation is done" / "runHorde" / "Horde's first byte": CLOCK, controlled: yes. **keep-det** (risk: none). The fake setTimeout covers the 2 s Horde poll sleep (request.ts:1559). The firstByte/completedAt ordering compares the injected tick clock, not real time. Echo uses echoDelay 0. risk: none

#### `server/src/tests/llmProviderAdapters.test.ts`

- **531-536,1203-1243** "Bedrock: the Signature V4 headers with a frozen clock": CLOCK, controlled: yes. **keep-det** (risk: none). The outer beforeEach freezes Date at 2026-10-01T12:00:00Z; the exact SigV4 date and signature are independent of elapsed time. Transport I/O is a canned fetch implementation, and the observer is a recording callback. (new 2026-10-21)
- **1735-1756** "Bedrock signs with a bound composite key and takes its region": CLOCK, controlled: yes. **keep-det** (risk: none). The same frozen Date controls the credential scope's asserted 20261001 date; this checks the selected credential and region without racing a clock. (new 2026-10-21)
- **2208-2296** "the Gemini retries after a tool call (crosscheck row 3)": SLEEP, controlled: yes. **keep-det** (risk: none). Aggregates both buffered/streaming retry and Stop cases. The inner beforeEach fakes setTimeout/clearTimeout, which server/src/llm/util.ts sleep actually uses for Google's 1/2/4 s retry delays. The setImmediate settle loop has no wall-clock cap and waits for an armed fake timer or completion; Stop aborts and clears that timer. Neither the backoff nor this helper reads Date.now. These tests catch immediate retries, wrong intervals, and a retry surviving abort. (new 2026-10-21)

#### `server/src/tests/llmRequests.test.ts`

- **659-690,2387-2392** "ends the request when a callback is not answered by its absolute deadline, and treats an answer past it as late" / "ticking" / "observe": CLOCK, controlled: yes. **keep-det** (risk: none). callback deadline reads the injected options.now and fake setTimeout; observer uses a ticking injected clock; checked, controlled
- **518,756-778** "ends a stream whose upstream fails after it began with one `error` terminal" / "ends a request when its client goes away mid-stream: the upstream fetch is aborted, the entry removed, and nothing is delivered later": SLEEP, controlled: partial. **keep-det** (risk: low). the timers only space upstream frames; the production read->chunk->callback->abort chain is microtask-only (no throttle timer in requests.ts), so it always runs before the next frame timer; risk low
- **746,855,886** "refuses a request whose client was gone before admission, and registers nothing" / "does not register the Claude warmer for a request that maintenance ended while its adapter was still preparing" / "aborts a local Ollama request with the request (buffered), with no late success and no live entry": SLEEP, controlled: partial. **keep-accepted** (risk: low). negative checks: load can only make them miss a bug, never fail spuriously; risk low (could become a setImmediate/dispose flush)
- **797,822,879,884,1208,1381,1609,1619,1621,1829,2123,2583,2585** "startProvider" / "the lifecycle" / "a job's in-process request (runInJob)" / "a job's MCP tools (runInJob)" / "a job's request names its failure" / "the child interceptor of a job callback" / "the request observer": POLL, controlled: partial. **keep-poll** (risk: low). mocked fetch and in-process streams (sse delays of 5000 ms are woken by the abort signal); 2 s real cap only; risk low (cap removed in slice 3 (88953f6d0))

#### `server/src/tests/llmRoutes.test.ts`

- **499-500** "ends the request when the client disconnects mid-stream over a real socket, and refuses new ones after shutdown began": POLL, controlled: no. **rewrite:deferred** (risk: med). testSupport waitFor (2 s) for the abort to travel a real socket: the client abort, the server close, the registry end, the upstream fetch abort, then the upstream server seeing the close. That is real network I/O under a wall cap. Fix: an event-driven wait (a registry finish hook, upstream req 'close' promise). risk: med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **523** "refuses requests while the data is being replaced (maintenance) and serves them again after": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). sleep(20) waits for withMaintenance to run its listeners and pause llmRequests. Today the chain is in-process (exclusive tail plus sync pauses), so a late timer is harmless. But it is a guess at chain depth: an I/O-bound listener or a busy exclusive tail would turn `during` into 200. Fix: register an onMaintenance listener that resolves a deferred. risk: low (fixed in slice 9a (fd6805ccf): waits for the maintenance body to start instead of sleep(20))

#### `server/src/tests/llmSecrets.test.ts`

- **430** "refuses a stale revision with 409 and the current one, a missing or stale epoch with 412, writes during maintenance with 503, and requires the JWT": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). sleep(20) waits for withMaintenance to set maintenance=true. The listener chain (diagnostics, translation pause, jobs, llm pause) is in-process microtasks, so the macrotask fires after it. It is correct today, but it is a guess: expose or await a gate-closed signal. Risk: low (fixed in slice 9a (fd6805ccf): waits for the maintenance body to start instead of sleep(20))

#### `server/src/tests/llmServices.test.ts`

- **189,196,201,213,219,222,240,244** "shares one refresh among concurrent waiters, caches the token until its expiry, and refreshes after it" / "keeps a refresh alive while another waiter needs it, and aborts it when the last waiter leaves" / "rejects a pre-aborted request without a refresh, a failed refresh with its reason, and `clear` aborts every refresh": POLL, controlled: partial. **rewrite:deferred** (risk: med). The fetch is mocked and the cache-expiry test injects now(), but each refresh reaches that fetch only after real crypto.subtle.importKey/sign work (vertexToken.ts:63-79). testSupport.waitFor's 2 s Date.now cap can expire before the crypto completion reaches the test after a deschedule. Resolve a fetch-entered deferred in tokenServer and await it; the abort-flag check can await the already-observed rejection. (2026-10-21: the old keep-poll row itself noted threadpool signing; reclassified that external completion as actionable under V3) (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **248** "rejects a pre-aborted request without a refresh, a failed refresh with its reason, and `clear` aborts every refresh": SLEEP, controlled: partial. **keep-accepted** (risk: low). negative unhandled-rejection check; load only weakens it; risk low
- **254-350** "warmer" / "re-sends the registered body with `max_tokens` 10 after 4.5 minutes, at most five times, and nothing before a registration" / "retries a failed warming at most three times, and a disposed or reset warmer never retries or warms again": CLOCK, controlled: yes. **keep-det** (risk: none). full vi.useFakeTimers() plus injected now moved with the timers; checked, controlled

#### `server/src/tests/llmStreamParsing.test.ts`

- **545-558** "errors on an upstream body failure without waiting for an abort": SLEEP, controlled: partial. **rewrite:other(replace the 100 ms real timer race with a setImmediate pending check, or let the Vitest timeout catch a hang)** (risk: low). reader.read() rejection races a real 100 ms setTimeout that aborts; the error path is in-process web-stream microtasks so the timer only wins if the pipeline ever yields a macrotask; a hung implementation would still fail on the default timeout (risk: low) (fixed in slice 9a (fd6805ccf): renamed from "errors on upstream body failure before the abort deadline"; the 100 ms abort race is gone)
- **188,458,584** "afterEach" / "saves each signature part once with a %s save and preserves thoughts" / "cancels the upstream body when the returned stream is cancelled": SLEEP, controlled: yes. **keep-det** (risk: low). setImmediate turns after in-process stream/promise work (fetch stubbed, no I/O) only to surface unhandled rejections or a cancel; cannot be outrun (risk: low)

#### `server/src/tests/lore.test.ts` (2026-10-18 fixed file)

- **674-680,688-702** "matches through the worker, including flags and an escaped slash" / "a worker timeout during activation is no match for that entry; the others still activate and the pool recovers": BOOT, controlled: partial. **rewrite:other(beforeAll(() => pool.warm(), long hook timeout))** (risk: med). The first test cold-boots the size-1 pool in the default 5 s. The 200 ms deadline outcome is deterministic (REDOS) and the replacement boots within the 15 s timeout (risk: med) (fixed in slice 5b (6f4b9191d): the pool is warmed in beforeAll and the successful match gets a generous pool deadline; the worker-timeout case moved to slow per D2, covered in the gate by a fake-host rejection test)
- **677-680,688-701** "matches through the worker, including flags and an escaped slash" / "a worker timeout during activation is no match for that entry; the others still activate and the pool recovers": CLOCK, controlled: no. **rewrite:other(give successful regexes a generous test deadline; move the real-timeout case to slow or inject its timeout result)** (risk: med-high). Warming alone does not control the worker tasks. host() uses the real 1000 ms main-thread deadline, and host(200) applies 200 ms to both the catastrophic pattern and the later sane b$ match that must succeed; recovery is another real 1000 ms task. A stalled worker can turn those required matches into no match. workerPool.ts:498-505 excludes cold boot from task budgets, then arms the deadline at dispatch (522-525). (new 2026-10-21) (fixed in slice 5b (6f4b9191d): successful matches get a generous pool deadline; the worker-timeout case moved to slow per D2, where only the runaway pattern gets 200 ms and the test checks `timedOut: true`, and a fake-host rejection test covers it in the gate)

#### `server/src/tests/luaBindings.test.ts`

- **434-600,603-647,650-751,764-868,873-923** "runButton" / "delivers a notice-only job's notice before its terminal when the owner attaches after the job ended": CLOCK, controlled: no. **rewrite:other(createTestServer option to raise the per-run Lua budget or inject the pool's clock)** (risk: med). production workerPool.watch() charges the worker's eventLoopUtilization().active (wall time while running, including time descheduled) against DEFAULT_LUA_CPU_MS = 3000 per run; a 3 s deschedule mid-handler kills the worker ("Lua execution limit exceeded") and the terminal turns into an error (risk: med-low) (fixed in slice 5b (6f4b9191d): generous limits; the new "is one budget from the pool's createBudget, which every run of the button shares" guards the per-job budget)
- **199,600,647,751,778,804,868,897,923,340** "follow" / "runButton": TMO, controlled: partial. **keep-accepted** (risk: low). real listening server + worker pool + ws per test; measured 18-404 ms per test, about 100x margin to 60 s; follow()'s 30 s timer resolves without a terminal, but that is far off too (risk: low)
- **884-890** "delivers a notice-only job's notice before its terminal when the owner attaches after the job ended": POLL, controlled: partial. **keep-accepted** (risk: low). hand-rolled status poll 300x sleep(100) (about 30 s cap) until state ended; the cap is huge next to a ~20 ms job (risk: low) (slice 9a (fd6805ccf) made the poll an uncapped waitFor; disposition unchanged)
- **332,910** "keeps a notice made before a late first attach beside the question outstanding then, both before the terminal": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). attachAfterMs 1500 real sleep is meant to make the first attach late; under load the attach can come before the notice/question exist and the test still passes, so it silently stops covering the late-attach path (false pass, 1.5 s per run); poll the job status for the outstanding question before attaching (risk: low) (fixed in slice 9a (fd6805ccf): the first attach waits for a `simpleLLM` marker to reach the mock provider instead of a 1.5 s sleep)

#### `server/src/tests/luaBindingsFences.test.ts`

- **199,213** "writes no lore activation flag after its host call was aborted while tokenization was suspended, and latches the abort as fatal" / "asks the tab for no image when the host call was aborted during the media check, and reports the abort as fatal": POLL, controlled: yes. **keep-poll** (risk: low). testSupport waitFor (2 s cap) on a gate reached through in-process promise chains (sync sqlite store, stat mocked); work done before any timer fires (risk: low) (cap removed in slice 3 (88953f6d0))

#### `server/src/tests/luaRuntime.test.ts`

- **184-189** "races a stalled lookup against the abort and rejects with the abort": DUR, controlled: no. **rewrite:other(drop the elapsed<1000 assertion; the rejection proves the race and a hang hits the Vitest timeout)** (risk: med). A 20 ms real abort timer plus performance.now()-start < 1000 fails on any stall over 1 s. Risk: med (fixed in slice 7a (83b9f9591): the duration bound is gone; the terminal checks remain)
- **283-292** "rejects through the caller's abort during the fetch and during a stalled lookup": DUR, controlled: no. **rewrite:other(drop the elapsed<1000 assertion)** (risk: med). Same pattern: real 20 ms abort and a wall-clock bound of 1000 ms. Risk: med (fixed in slice 7a (83b9f9591): the duration bound is gone; the terminal checks remain)
- **392-449** "keeps the wasm function table flat across runs with awaits, raises the budget inside a resumed coroutine, and runs one task at a time": BOOT, controlled: partial. **move-slow** (risk: low-med). A fresh plain-Node child (wasmoon load plus 30 runs) under a 60_000 timeout, 0.6 s idle. Inside the child, cpuMs budgets (3000 per run, 200 resumed, cpuMs>=150) count real ELU-active time. The slow tag already names "fresh Node processes"; only the margin keeps it passing. Risk: low-med (fixed in slice 1 (40ab0dce4): fresh-process case moved to slow)
- **199-240** "serverLuaRequest": CLOCK, controlled: partial. **keep-accepted** (risk: low). The window-rolling test injects now(). The other two read real Date.now against the 60 s REQUEST_WINDOW_MS, and the 20 ms mocked lookups race only the 10 s AbortSignal.timeout. The margin is over 100x. Risk: low

#### `server/src/tests/manualTriggerMetadata.test.ts`

- **147-152,162** "keeps %s transcript reads and writes bounded for 1 and 50 setters, one revision per write": CLOCK, controlled: no. **rewrite:injected-clock** (risk: med). Same uninjected 50 ms performance.now effect yield. Each gap of more than 50 ms among the 50 setters splits the coalesced write. The budget allows 1..2 transactions, so two descheduled gaps in one run fail it. The file comment admits the load dependence. risk: med (fixed in slice 6a (328634ecd): a frozen generationEffectClock gives exactly one write for 1 and 50 setters; the new gated "splits %s writes at the effect loop's yields: one write per setter once the clock passes 50 ms before every effect" covers the yield)
- **134-141** "keeps %s transcript reads and writes bounded for 1 and 50 setters, one revision per write": POLL, controlled: partial. **keep-poll** (risk: low). A 500 x (in-process app.request + sleep(10)) loop until the terminal. The job is in-process (v2 effects, sqlite sync), so a slower loop only gives it more time. The real cap is the default 5 s test timeout over 4 jobs that take about 50 ms. risk: low

#### `server/src/tests/manualTriggers.test.ts`

- **24,101,234,379,425,460,550,577,604,641,662,730** "follow" / "a manual trigger job" / "`/multisend` in a command job": TMO, controlled: no. **keep-accepted** (risk: low). A 45 s per-socket cap and SLOW=60 s on a real server with Lua/regex worker threads; margin large vs a normal run; risk low
- **464-550 (assertions 536-547)** "runs the six regex sites in the worker; an invalid pattern the tab would throw on ends the job with a trigger error": CLOCK, controlled: no. **rewrite:other(test-server option giving the script pool a large regex deadline)** (risk: med-high). Each trigger regex op is a worker round-trip under DEFAULT_REGEX_DEADLINE_MS=1000 real wall time (workerPool.ts:49,523, armed on the main thread); a worker thread stalled for 1-3 s gets killed with "Regex timed out" and the job errors instead of done; risk med-high (fixed in slice 5b (6f4b9191d): generous limits, and a call-through spy asserts each site's pattern reaches the pool)
- **607-641, 644-662** "runs triggerlua on the working copy: Lua's chat edits, variables, and local lore land with the copy, and a native getter reads its setDescription" / "ends the job on a Lua load failure, but logs a handler's own error and runs the trigger's next effect": CLOCK, controlled: no. **rewrite:other(test-server option raising the per-run Lua cpuMs)** (risk: low-med). Lua runs under DEFAULT_LUA_CPU_MS=3000 + 1000 ms grace measured as worker eventLoopUtilization active time (workerPool.ts:458-477; runtime.ts:20), which counts a stall while busy; a 9x slowdown plus a stall mid-run can cross it ("execution limit exceeded"); risk low-med (fixed in slice 5b (6f4b9191d): generous Lua limits)
- **559,570,574** "ends at once with `aborted` when the job is cancelled during v2Wait, applying nothing": DUR, controlled: no. **keep-accepted** (risk: low). Asserts elapsed < 15 s for a 30 s v2Wait cancelled via a 300 ms delayed DELETE; the bound is the subject (it catches an abort that waits out the sleep); margin 15 s; risk low

#### `server/src/tests/mcp.test.ts`

- **401-404** "ends a request at its deadline and rejects when the caller aborts, leaving no pending entry": DUR, controlled: no. **rewrite:fake-timers** (risk: high). asserts Date.now() elapsed < 2000 ms around a real 40 ms requestTimeoutMs setTimeout; a 1-3 s deschedule anywhere in the call fails it; risk high (fixed in slice 7a (83b9f9591): full fake timers; the request is pending at 39 ms and settled at 40 ms, and the elapsed check is gone)
- **585-587** "gives the session stream one deadline to connect and name its endpoint, and none once connected": DUR, controlled: no. **rewrite:fake-timers** (risk: high). same pattern: elapsed < 2000 ms around the real 40 ms connect deadline (client.ts setTimeout); risk high (fixed in slice 7a (83b9f9591): full fake timers; the connect is pending at 39 ms and refused at 40 ms, and the elapsed check is gone)
- **593-594** "gives the session stream one deadline to connect and name its endpoint, and none once connected": SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(100) negative check that the 40 ms connect deadline was cleared; the deadline timer is armed earlier so it always fires first; overload only strengthens; risk low (fixed in slice 7a (83b9f9591): the sleep(100) is a fake-timer advance under the same fake clock)
- **1011-1027** "reads a limit-sized event delivered in small chunks without rescanning or recopying it": PERF, controlled: no. **rewrite:other(count scanned bytes or buffer copies via a spy instead of wall time)** (risk: med). 8 MiB in 128x64 KiB chunks must parse in < 5000 ms wall, which is also the default test timeout; at 1/9 CPU plus descheduling the margin shrinks, and the quadratic regression it guards may finish under 5 s on a fast host anyway; risk med (fixed in slice 7a (83b9f9591): renamed from "reads a limit-sized event delivered in small chunks without rescanning it (bounded time)"; it counts scanned and copied bytes with `countByteWork` in `server/src/tests/byteWork.ts` instead of timing)
- **1081-1088** "shares one client per identifier, keeps a leased client past the idle time, closes an idle one after its release, and replaces a closed one": SLEEP, controlled: partial. **rewrite:fake-timers** (risk: low). real idleMs 40 vs sleep(90): the idle timer is armed before the sleep, so Node fires them in order and overload cannot flip it; only cost is 180 ms real wait; risk low (left open by slice 7a (83b9f9591): the real sleep(90) stays for sweep 9a) (fixed in slice 9a (fd6805ccf): fake setTimeout/clearTimeout, with the exact 39/40 ms idle boundary checked after the release)
- **843,2216** "withdraws the owner's question and settles its callers when the client is closed during the login; a late answer publishes nothing" / "writes no rotated token and publishes no access token when the job ends or the client closes while the refresh answer is out": SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(20) negative checks that a late answer publishes nothing; overload only lengthens the wait; risk low
- **1515-1536,1598-1605** "tab kinds: no tab within the grace offers nothing, an attached tab answers mcpList and mcpTool, and a callback's outcomes are classified": CLOCK, controlled: yes. **keep-det** (risk: low). full vi.useFakeTimers() (Date faked) around TAB_ATTACH_GRACE_MS advances; risk low
- **409,541,560,836,863,896,908,1051,1434,2204** "waitFor": POLL, controlled: yes. **keep-poll** (risk: low). server waitFor on in-process fake fetch / SSE ReadableStream chains only; risk low (cap removed in slice 3 (88953f6d0))

#### `server/src/tests/mcpInternal.test.ts`

- **468-479** "answers a tool error without asking when the owner's tab is not connected, and ends the job when the callback is lost after it was sent": CLOCK, controlled: yes. **keep-det** (risk: none). vi.useFakeTimers() with no toFake (Date and performance faked too) around the 10 s owner wait; advanceTimersByTimeAsync(11_000); real timers restored in finally

#### `server/src/tests/mcpSse.test.ts`

- **121-127** "delivers an event before an oversized one in the same chunk, and frames many small events in a chunk larger than the bound": PERF/DUR, controlled: no. **rewrite:other(count framer scan work, e.g. bytes inspected, instead of wall ms) or move-slow** (risk: med). 80,000 events must frame in < 3000 real ms; 121 ms idle (25x margin) but 9x slowdown + a 1-3 s deschedule can cross 3 s; risk med (fixed in slice 7a (83b9f9591): 10,000 events with counted scanned bytes instead of wall ms; leftover: `scanned <= 2 * many.length` has no slack)

#### `server/src/tests/memoryJobs.test.ts`

- **1035** "'memory' turns the owner's toggle on (counting the transition), emits the record, runs memory in the same send, and is not asked again": POLL, controlled: no. **rewrite:deferred** (risk: high). expect.poll has a 1 s real cap waiting for the feed socket's hello frame over a real ws; after a >=1 s deschedule the poll timeout fires in the timers phase before the socket I/O callback; resolve a promise from ws.onmessage instead (risk: high) (fixed in slice 3 (88953f6d0): replaces expect.poll with an uncapped poll; an event latch catches no additional wrong implementation)
- **1064** "'memory' turns the owner's toggle on (counting the transition), emits the record, runs memory in the same send, and is not asked again": POLL, controlled: no. **rewrite:deferred** (risk: med-high). expect.poll 1 s cap on the characters change frame arriving on the second (feed) socket after the job's done came on the job socket; the order across the two sockets is not fixed and the gap is real I/O; wait on a frame-matching promise (risk: med-high) (fixed in slice 3 (88953f6d0): replaces expect.poll with an uncapped poll; an event latch catches no additional wrong implementation)
- **799** "an abort during a summary makes no later request, no memory write, and no cache row": SLEEP, controlled: partial. **delete** (risk: low). sleep(200) inside the mock holdSummary after an awaited DELETE: the abort has already happened when DELETE answers, so the delay adds nothing a wrong implementation would fail on (risk: low) (fixed in slice 9a (fd6805ccf): the sleep(200) is deleted and the test kept)
- **804,1322** "an abort during a summary makes no later request, no memory write, and no cache row" / "an invalid answer, and an abort while the question waits, end the job with nothing trimmed or recorded": SLEEP, controlled: partial. **keep-accepted** (risk: low). sleep(300) then negative checks (no later main request, write or cache row); load can only hide a late stray request, never fail a correct impl (risk: low)
- **426,514,541-1394** "job": TMO, controlled: partial. **keep-accepted** (risk: low). real server + mock provider/embedder over HTTP + ws; measured 25-503 ms per test, about 100x margin (risk: low)
- **541-834,940-973,1022-1093,1194-1253** "HypaV3" / "HypaV2, SupaMemory, Hanurai, and the priority" / "the no-memory trim question": CLOCK, controlled: no. **rewrite:other(inject the chunking clock and a generous regex deadline through the memory host)** (risk: high). The successful HypaV3 cases (including standard/experimental summary merging and turning memory on through the trim question) reach splitBySeparator in prompt/memory/hypav3.ts:51-83. It gives the real worker each regex at most 1000 ms and shares a real performance.now 5000 ms chunking budget (428-432 and 900-906); runner.ts:977 forwards those options to the real pool. A deschedule can replace the expected done/memory result with a separator timeout despite each test's 60 s Vitest timeout. The low-recent/high-similar first case explicitly exercises this path. (new 2026-10-21) (fixed in slice 5b (6f4b9191d): generous separator limits through `generationHypaV3SeparatorLimits`)

#### `server/src/tests/postProcess.test.ts`

- **117** "shows [Generating...] for both image command forms at once, asks one image per command form by form, and removes a command without an image": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(5) only delays a fake image provider; a parallel implementation sets `overlapped` before any timer fires, so the order/overlap check does not depend on timing (risk: low)

#### `server/src/tests/promptRunner.test.ts` (2026-10-18 fixed file)

- **716-721** "an abort while the provider stalls keeps the text so far and releases the lock": DUR, controlled: no. **rewrite:deferred** (risk: low). expect(Date.now()-started).toBeLessThan(15_000) against a provider that sleeps a real 20_000 ms before chunk 2; hold chunk 2 on a never-released holdBeforeChunk deferred instead and drop the bound (terminal arrival while held proves the abort does not wait); 41 ms idle, risk low (fixed in slice 6a (328634ecd): renamed from "checkpoints a stalled stream on the timer, and an abort keeps the text so far and releases the lock"; the provider holds chunk 2 instead of sleeping 20 s, and the duration bound is gone)
- **719-725,1344-1360** "an abort while the provider stalls keeps the text so far and releases the lock" / "an aborted send hands nothing over: no notice, and neither its partial reply nor its user message is translated": CLOCK, controlled: no. **rewrite:injected-clock** (risk: low-med). stored "char:First." after DELETE relies on the runner persisting before production JOB_ABORT_GRACE_MS=5000 real setTimeout (generationJobs.ts:800) finalizes the job and kills its write token; work is ~40 ms idle, risk low-med (5 s vs 9x slowdown + 1-3 s deschedule) (fixed in slice 6a (328634ecd): renamed from "checkpoints a stalled stream on the timer, and an abort keeps the text so far and releases the lock"; generationAbortGraceMs sets a ten-minute grace the test checks the DELETE schedules, and a frozen Date.now keeps a periodic checkpoint from hiding a missing abort write)
- **1081** "a stream that breaks after its chunks ends the job as the request's failure, naming the request, with the text so far stored and the lock released": SLEEP, controlled: partial. **rewrite:deferred** (risk: low). provider delayMs:150 then res.destroy(): chunk-1 delivery to readReply before the break is ordered by a real 150 ms timer (a stream error discards still-queued chunks, so streamedTexts==["First."] and stored "char:First." depend on it); event-loop order (poll before next timers) usually saves it; destroy on a latch released when the ws sees the chunk event; risk low (fixed in slice 6a (328634ecd): the break waits for the owner's first chunk event instead of a 150 ms delay)
- **589,681** "runs the input stage (the input trigger, editinput in the worker, the user message under its id) and streams the raw reply" / "continue extends the last reply, refuses a Lua editRequest write to the locked message, and closes the generation": SLEEP, controlled: yes. **keep-det** (risk: low). provider delayMs:40 only spaces chunks; assertions (>=2 chunks, distinct growing sequence ending with the whole text) tolerate coalescing; no assertion orders them against another real timer; risk low
- **1167-1178,1257,1274,1304,1316** "chatUntil": POLL, controlled: no. **rewrite:other(await a translationRunner settled/idle promise instead of polling)** (risk: low). hand-rolled poll, real 10 s Date.now deadline, 25 ms real sleeps, over real HTTP to the fake provider + server storage writes; risk low (10 s cap) (fixed in slice 3 (88953f6d0): routes chatUntil through uncapped waitFor)
- **1234** "hands the reply and the user message over before done and tells the tab, without waiting: a second send runs while the translations are held, then they land": POLL, controlled: no. **rewrite:other(latch in onRequest counting held translation requests)** (risk: low). testSupport waitFor with real 10 s cap on two translation requests reaching the fake provider over real HTTP; risk low (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **1268,1333** "hands the reply and the user message over before done and tells the tab, without waiting: a second send runs while the translations are held, then they land" / "a group send hands every member's reply, then the user message it found in the chat; bot-only skips the user message; a chat that does not auto-translate hands nothing": POLL, controlled: no. **rewrite:other(await a translationRunner idle promise)** (risk: med). testSupport waitFor DEFAULT 2000 ms real cap (testSupport.ts:344) on runningCount()===0; condition is re-checked only after the real sleep timer, so a 2-3 s deschedule before pending I/O callbacks run throws; risk med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **1385** "feedSocket": POLL, controlled: no. **rewrite:other(resolve a promise from onmessage on the hello frame)** (risk: med). waitFor default 2000 ms real cap for the /api/events/ws hello frame (real WebSocket I/O); risk med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **1405** "stamps": POLL, controlled: no. **rewrite:other(resolve from onmessage when the revision's change frame arrives)** (risk: med). waitFor default 2000 ms real cap for the change-feed frame over a real WebSocket; risk med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **1327,1352** "a group send hands every member's reply, then the user message it found in the chat; bot-only skips the user message; a chat that does not auto-translate hands nothing" / "an aborted send hands nothing over: no notice, and neither its partial reply nor its user message is translated": SLEEP, controlled: no. **rewrite:other(await the job's translation-handover decision point, then assert)** (risk: low). sleep(200) before negative checks (no extra provider body, runningCount 0); cannot false-fail, but under load a late wrong handover slips past (false pass); risk low (partly fixed in slice 6a (328634ecd): the aborted send asserts that handOff was never called, with no sleep(200); the group-send sleep(200) stays open for sweep 9a) (fixed in slice 9a (fd6805ccf): a spy on `handOff` replaces the group send's sleep(200), so with slice 6a's half the row is fully fixed)
- **345** "job": POLL, controlled: partial. **keep-accepted** (risk: low). job() waits a real 45 s for done/error then resolves silently (terminal undefined fails the next assertion); every test idles <0.6 s; margin ~75x; risk low
- **313-404** "job": SLEEP, controlled: no. **rewrite:deferred(set the provider's owner-socket gate before the create)** (risk: med). No timer: job() replaced the provider's owner-socket gate only after the create answered, but the runner may reach the provider before that answer arrives, so under a scheduler stall the first chunk could be sent before the owner socket opened and its frame was lost. (new 2026-10-21, found by slice 6a) (fixed in slice 6a (328634ecd): the gate is set before the create and released in finally)
- **29,496,509-729,771-1146,1212-1362,1423-1477** "a send" / "automatic translation of a send's messages" / "the lastInteraction stamp": TMO, controlled: partial. **keep-accepted** (risk: low). SLOW=60_000 per test and on beforeAll (real server, worker pool, Lua, WebSocket); idle per-test 14-560 ms, beforeAll ~2 s; margin >=20x even at 9x slowdown; risk low
- **936-962** "the request trigger's effect limit ends the job before any provider call": PERF, controlled: partial. **keep-accepted** (risk: low). runs the REAL 100,000-effect limit (vitest.config tag text lists this as a slow-tier criterion) in the gated tier; 413 ms idle under a 60 s timeout, so margin is large; consider move-slow for consistency; risk low
- **582-635,663-710** "runs the input stage (the input trigger, editinput in the worker, the user message under its id) and streams the raw reply" / "continue extends the last reply, refuses a Lua editRequest write to the locked message, and closes the generation": CLOCK, controlled: no. **rewrite:other(createTestServer option for a script pool with generous cpuMs)** (risk: low). production worker budgets are eventLoopUtilization-active wall time: regex-scripts task 5000+1000 ms, Lua run DEFAULT_LUA_CPU_MS 3000+1000 ms (workerPool.ts:474,537,851; runtime.ts:20); a deschedule while the worker is busy is charged; runs are ms-scale; risk low (fixed in slice 5b (6f4b9191d): generous limits, with a budget assertion in the continue case)
- **589-635,681-710,1081-1101** "runs the input stage (the input trigger, editinput in the worker, the user message under its id) and streams the raw reply" / "continue extends the last reply, refuses a Lua editRequest write to the locked message, and closes the generation" / "a stream that breaks after its chunks ends the job as the request's failure, naming the request, with the text so far stored and the lock released": CLOCK, controlled: no. **keep-accepted** (risk: low). readReply's checkpoint uses real Date.now + setInterval(250) with CHECKPOINT_INTERVAL_MS=3000 (runner.ts:1730-1754); under load a gated stream can span 3 s and write an extra checkpoint, but no gated assertion counts checkpoints or chat revisions; risk low
- **1397-1402,1428,1442** "stamps": CLOCK, controlled: yes. **keep-det** (risk: none). lastInteraction bracketed by Date.now() before/after the job and compared to now+1 day: monotonic window, load only widens it; risk none

#### `server/src/tests/promptTail.test.ts`

- **645** "runs editoutput once on the completed text (Lua, the plugin hook, the regex) while the chunks stream raw, then the trigger, the listeners, TTS, the notification, the timings, and the final write": CLOCK, controlled: no. **rewrite:other(assert on the provider's SSE writes or flush per chunk with a latch)** (risk: low). The SSE adapter enqueues one snapshot per network read (openAI/requests.ts:1113), and the in-file provider spaces its 3 chunks with real sleep(20). If the process is descheduled between a write and its poll-phase read, the next timer writes again first and the chunks merge into one read. That needs this to happen twice to fall below 2 chunk events. risk: low (fixed in slice 9a (fd6805ccf): the owner gate is set before the create, which also fixes a race in the old helper, and the provider writes each chunk only after the owner rebuilt the text so far)
- **630** "runs editoutput once on the completed text (Lua, the plugin hook, the regex) while the chunks stream raw, then the trigger, the listeners, TTS, the notification, the timings, and the final write": POLL, controlled: no. **rewrite:deferred** (risk: low-med). testSupport waitFor (2 s) for the Web Push delivery, which runs asynchronously after the notification (subscription store I/O, then the fake transport). Fix: resolve a promise from the fake pushTransport.sendNotification. risk: low-med (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)
- **651** "runs editoutput once on the completed text (Lua, the plugin hook, the regex) while the chunks stream raw, then the trigger, the listeners, TTS, the notification, the timings, and the final write": DUR, controlled: no. **keep-accepted** (risk: none). A lower bound on real elapsed ms across a stream that really sleeps 2 x 20 ms. Load only makes it larger, so it cannot fail from overload. risk: none
- **36,360,525,556-1193** "job": TMO, controlled: no. **keep-accepted** (risk: low). 60 s per test and beforeAll over a real server with Lua workers, provider, embedder and sockets. The longest test is 0.5 s alone (about 100x margin, about 10x under 9x load). job() has a silent 45 s fallback. The Lua ELU 3 s budget is the only tighter bound. risk: low

#### `server/src/tests/proxy.test.ts`

- **128-140** "streams SSE through, and a timeout before upstream headers is a 504": CLOCK, controlled: no. **rewrite:other(start the /hang request, await upstream.received(2), then fire the proxy timeout via fake setTimeout or an injected timer; await the close event)** (risk: med). real 100 ms proxy timeout (proxy.ts createTimeoutController) races the local connect + body upload; a deschedule >100 ms lets it abort before the upstream pushes its record (record pushed only after the body is read), then waitFor(requests[1].closed) times out at 2 s real (risk: med) (fixed in slice 6a (328634ecd): only the risu-timeout-ms timer is captured, and it is fired after the upstream has the request)
- **152-154** "answers HEAD with headers only and closes the upstream body": POLL, controlled: no. **rewrite:deferred** (risk: med). 2 s real-cap waitFor on the upstream response close over a real socket (risk: med) (fixed in slice 3 (88953f6d0): removed the poll's wall deadline; Vitest alone caps the wait)

#### `server/src/tests/push.test.ts`

- **360,363,595,789,793** "registering one past the cap drops the least recently registered" / "a removal racing a delivery that just dropped the endpoint (410) writes the file" / "delivers completions one at a time in order, drops those past the queue, never rejects, and stops after close": SLEEP, controlled: yes. **keep-det** (risk: low). setSystemTime mocks Date for updatedAt; the 5/10 ms sleeps only let promise chains run (pushService uses sync fs and promise queues, no I/O or timers), and a later timer cannot outrun microtasks (risk: low)

#### `server/src/tests/regexScriptsTask.test.ts`

- **157** "reports a script's own failure the engine's way (skipped) and keeps the worker for the next run": CLOCK, controlled: no. **rewrite:other(pass { deadlineMs: 60_000 } to pool.regex)** (risk: high). pool.regex defaults to DEFAULT_REGEX_DEADLINE_MS 1000 ms, a real main-thread setTimeout armed before posting to a real worker; a >1 s deschedule fires it before the worker's reply is read -> "Regex timed out" (risk: high) (fixed in slice 5b (6f4b9191d): a warmed pool with a generous regex deadline)
- **104-122,124-147** "fails the task for a CBS argument over the cap and dispatches no host call after it, not even a later effect" / "refuses a result over the cap as JSON, whether by its length or by its escaping, also without a parse round trip": CLOCK, controlled: no. **rewrite:other(pass a large cpuMs, e.g. 60_000, in the runScripts input)** (risk: med). runScripts still uses a 5000 ms allowance plus the fixed 1000 ms watchdog grace, charged against worker ELU active time. The CBS-cap case doubles 9 MiB before parse; the result-cap case now appends 9 MiB to 9 MiB through synchronous repeatBack, and appends 5 MiB of backslashes to 5 MiB of quotes (over 20 MiB once JSON-escaped). Copies, scanning and serialization still have to beat the real allowance; host-call wait exclusion does not control the worker's active clock. (2026-10-21: the result-cap fixture changed from @@move_top to @@repeat_back; the real 5000+1000 ms budget remains, and the old 130-280 ms measurements were not rerun) (fixed in slice 5b (6f4b9191d): a warmed pool with a generous runScripts allowance)
- **61-158** "the regex scripts task": TMO, controlled: partial. **keep-accepted** (risk: low). All five tests retain 30_000/60_000 ms timeouts; the size-1 pool is still cold on the first run and bootMs defaults to 30 s. These margins do not control the clock, and the 1000 ms regex deadline and 5000+1000 ms runScripts watchdog in the preceding rows remain the tighter limits. No current duration was measured. (2026-10-21: the result-cap workload changed, so the inventory's old maximum-duration measurement is not evidence for the current fixture)

#### `server/src/tests/requestCapture.test.ts`

- **514,545,1243,1286,1290,1318** "the request's end (a captures flush) records an unread body, a fetch still waiting for its headers, and a buffered answer still being read, each with what is known; a later settle records nothing" / "a tab's request aborted while its fetch waits for the headers records that attempt before the end, without a status and without a duplicate" / "a tab's request aborted while its buffered answer is being read records that exchange with its status before the end, once" / "an aborted job's request ends aborted with the reason, its stream's capture flushed with what was read": SLEEP, controlled: yes. **keep-det** (risk: low). sleep(1/5/10) after in-process mock-fetch promise chains with an injected tick clock and sync history store; a timer cannot fire before those microtasks; the 10 ms ones are negative windows (risk: low)
- **1238,1241,1285,1289,1317,1335** "waitFor": POLL, controlled: yes. **keep-poll** (risk: low). testSupport waitFor on in-process registry state (mocked upstream) (risk: low) (cap removed in slice 3 (88953f6d0))
- **1359-1371** "runBatch": CLOCK, controlled: partial. **keep-accepted** (risk: low). fake setTimeout without Date; anthropic.ts reads real Date.now against BATCH_TIMEOUT 24 h 10 min, unreachable (margin ~hours) (risk: low)
- **1122,1139,1151** "a streamed body over the bound is stored cut at 4 MiB with the cut recorded, and counted whole" / "a credential crossing the capture cut leaves no fragment, also when earlier redaction shrinks the text under the store's bound" / "a character split at the capture cut is left out rather than stored as a replacement character": TMO, controlled: partial. **keep-accepted** (risk: low). 20 s bump for 4 MiB redaction; idle 72-114 ms (~175x margin) (risk: low)
- **908-909,1393-1394,1419-1436,1471** "harness": CLOCK, controlled: yes. **keep-det** (risk: none). harness injects now() = tick++ from 1000; the ordering is a counter (risk: none)

#### `server/src/tests/requestHistoryRoutes.test.ts`

- **443-461** "refuses the history routes with 503 during shutdown, and sets no-store on a 413 and on the limiter's 429": PERF, controlled: no. **rewrite:other(test-server option with a small limiter cap, e.g. 20/min)** (risk: med). 2,001 sequential app.request calls to reach the 2000/min limiter inside the default 5 s timeout; measured 451 ms, so ~9x slowdown plus a stall reaches about 5 s. The 60 s Date.now window never matters; risk med (fixed in slice 7a (83b9f9591): a 20-request bucket through `routeLimits.requestsPerMinute`)
- **365-379** "removes every row (204), also from an empty history, and answers 500 when the delete failed while the store stays open": CLOCK, controlled: yes. **keep-det** (risk: none). Lock held by a second DatabaseSync; the request-history store sets no busy_timeout (requestHistory.ts:529-533), so SQLITE_BUSY comes at once, with no real-time wait; risk none

#### `server/src/tests/requestShare.test.ts`

- **996** "refuses the share with a 503 once shutdown began: at admission, and again after a body read that outlasted the admission; and with a 503 while the store is unavailable": POLL, controlled: yes. **keep-poll** (risk: none). testSupport waitFor on `pulled`. The request goes in-process through app.request, so the body pull is a promise chain with no I/O. Every other clock in the file is injected (clock / NOON). risk: none (cap removed in slice 3 (88953f6d0))

#### `server/src/tests/resourcePatchParts.test.ts`

- **43-70,98-104,135-153** "stores what the whole-record path stores, for field patches of a character": PERF, controlled: no. **rewrite:other(run the property matrix against an in-memory store with a stored-text inspection seam; retain a small disk-backed integration case, or move the full matrix to slow)** (risk: high). Three starting records × 300 steps × two file-backed SQLite stores repeatedly transact and read the stored text. This is fsync-bound rather than a duration assertion. The build-test-platforms CI notes report 3.8 s alone on disk-backed /tmp versus 0.4 s on tmpfs and a default-5-s failure in a full run. This audit's noisy single-file run took 399.7 ms here; it does not invalidate the documented disk-backed failure. Exact text/error/feed equivalence is a useful contract, so preserve it while removing the filesystem-throughput dependency. (new 2026-10-21) (fixed in slice 7a (83b9f9591): the matrix runs on in-memory stores, reading the stored text through the `inspectStoredText` store option; the new gated "commits to the file what the whole-record path commits, and nothing of a rolled-back batch" keeps one disk check through a second connection; this also resolves the CI fsync timeout, cause 12)
- **155-176** "stores what the whole-record path stores, for item patches of the module list": PERF, controlled: no. **rewrite:other(use the same in-memory property-test backing as the character matrix and keep a small disk-backed case)** (risk: med). The sibling runs 300 generated patches against the same two file-backed stores; accepted writes pay SQLite durability costs inside the default 5 s timeout. Some generated patches are refused, so 600 attempts are not 600 commits. Its noisy 52.8 ms here is not a measurement on disk-backed CI /tmp. (new 2026-10-21) (fixed in slice 7a (83b9f9591): in memory through `inspectStoredText`, as the character matrix)
- **466-493** "charges four units per cut text: evicts older large bases and never caches one over a quarter of the budget": TMO, controlled: no. **move-slow** (risk: med). The 20 s timeout surrounds three 6 MiB payloads and one 17 MiB payload, repeated writes/parses and disk-backed SQLite. The assertions count payload parses, not heap size or GC, but reaching the production cache limit makes CPU and storage throughput the remaining wall-clock budget. Noisy single-file duration here: 823.1 ms. (new 2026-10-21) (fixed in slice 7a (83b9f9591): moved to slow per D2; the gated coverage is "charges four units per cut text at an injected budget: evicts older large bases and never caches one over a quarter of the budget" through `patchBaseMaxUnits`)

#### `server/src/tests/resourceStore.test.ts`

- **753,770,780** "rolls back a body that returns a promise or a thenable and rejects the continuation's write" / "rejects a timer write the body scheduled, even after the commit": SLEEP, controlled: yes. **keep-det** (risk: low). sleep(10) after microtask-only late writes; the body's setTimeout(0) was created before the 10 ms sleep timer and expires first, so Node runs it first whatever the load (risk: low)

#### `server/src/tests/scriptWorker.test.ts` (2026-10-18 fixed file)

- **597-609** "lets queued runs sharing a budget spend it once": CLOCK, controlled: no. **rewrite:other(slot held by an unbudgeted deferred blocker so all 4 budgeted runs queue; run 1 = `while true do end`, ends only through the hook; charge invariants)** (risk: high). A size-1 cold pool reserves the entire createLuaBudget(100) synchronously on assignment (workerPool.ts:491-503); calls 2-4 are refused by runLua's pre-check at 803 and never queue. Run 1 must complete a 75 ms os.clock() wall-time spin plus its preamble before the 100 ms ELU hook cuts it, leaving about 25 ms nominal slack. A late final charge can also break usedMs<=200; the watchdog still cuts above 100+1000 ms active time. The queue subject needs a held unbudgeted slot, an unbounded first budgeted body, and reservation/charge invariants; accept either hook or watchdog termination for the cut. (2026-10-21: current code confirms the original race and the misleading queue subject; refreshed the control-flow explanation without an unmeasured failure probability) (fixed in slice 5a (3fa95439b): a held blocker makes all four runs queue, run 1 is an unbounded loop cut by the hook, and usedMs equals the summed charges; leftover for 5b or the sweep: it misses reservation-vs-measured charging when the cut lands at exactly 100 ms) (kept in slice 9a (fd6805ccf): no change, since the aborted-run and dropped-result tests pin measured-vs-reservation charging)
- **611-631** "reserves each concurrent run's allowance so two workers cannot overspend": CLOCK, controlled: partial. **rewrite:other(also accept the watchdog's "Lua execution limit exceeded (worker terminated)" as a cut, or make the watchdog grace a pool option set large in tests)** (risk: low-med). Refused=2 is synchronous, cpuMs>=50 and usedMs==sum hold on the hook path. Residual: a whole-process stall of at least 1050 ms mid-loop lets the main-thread watchdog (cpuMs 50 + 1000 grace on worker ELU) fire before the hook, so cut has 1 entry (risk: low-med) (fixed in slice 5a (3fa95439b): unbounded loops end only through the hook, and the shared pool's 60 s graces keep the watchdog out)
- **281-294** "stops a top-level runaway and a handler runaway at the per-run budget without a termination": DUR, controlled: no. **rewrite:other(drop topMs/handlerMs<3000; make the watchdog grace injectable so terminated==before is not raced)** (risk: med). The wall bounds catch nothing a hang would not. terminated==before races the 1300 ms ELU watchdog against the hook after a stall (risk: med) (fixed in slice 5a (3fa95439b): the shared pool's 60 s graces leave the cut to the hook; the duration bounds are gone)
- **296-306** "terminates a C-level runaway started after an unawaited host call": DUR, controlled: no. **rewrite:other(drop ms<4000; the "worker terminated" error alone proves the watchdog)** (risk: med). The watchdog fires about 1.1 s into worker ELU (wall while busy); a main-thread gap of 3 s or more breaks the 4 s bound (risk: med) (fixed in slice 5a (3fa95439b): the duration bound is gone; the termination error proves the watchdog)
- **322-332** "charges the CPU spent between host calls, summed across them" / "does not charge an asynchronous wait, even one longer than the budget": CLOCK, controlled: no. **rewrite:other(gated: the summed charge under a large allowance) + move-slow(the asynchronous wait)** (risk: med-high). cpuMs:100 with real ELU: a deschedule of more than 100 ms in the preamble or the resumption makes the checkpoint or hook cut the run (res!="done") or cpuMs>=100. The first half (30x40 ms spin vs 300) is load-monotone (risk: med-high) (fixed in slice 5a (3fa95439b): split from "charges the CPU spent between host calls, not the waits" into the gated "...summed across them" and the slow "does not charge an asynchronous wait...", because idle time during an asynchronous wait cannot be measured deterministically without a controlled worker clock; leftover for 5b or the sweep: under load the gated case can pass without exercising its distinction) (kept in slice 9a (fd6805ccf): still gated on purpose, since it catches the wrong implementation on every normal run; summation is now also pinned by the deterministic `luaRuntimeCharge.test.ts`)
- **335-353** "charges a coroutine resumed after a long wait only its own compute, in a handler and at the top level": CLOCK, controlled: no. **move-slow** (risk: med-high). cpuMs:100 against a 20 ms wall spin plus preamble: an active-segment gap over ~80 ms cuts the run (risk: med-high) (fixed in slice 5a (3fa95439b): moved to slow, because idle time during an asynchronous wait cannot be measured deterministically without a controlled worker clock)
- **355-368** "stops a runaway right after a resumption at the budget": DUR, controlled: no. **rewrite:other(drop ms<4000; assert the hook error instead)** (risk: low). timedOut is robust (hook or watchdog). The 4 s wall bound only adds a gap race (risk: low) (fixed in slice 5a (3fa95439b): the duration bound is gone; leftover for 5b or the sweep: under load the gated case can pass without exercising the resumption distinction) (kept in slice 9a (fd6805ccf): still gated on purpose, since it catches the wrong implementation on every normal run; a deterministic version would need a worker-side clock)
- **370-391** "serves concurrent host calls in their own completion order": DUR, controlled: no. **rewrite:deferred(two deferred host answers resolved b-then-a, Lua records completion order)** (risk: high). ms<1000 over real 300/50 ms timers plus cpuMs:100 ELU. "ba" is fixed by the concat order, so only the wall bound tests concurrency, and it fails on a gap of about 700 ms (risk: high) (fixed in slice 5a (3fa95439b): host-entry and completion deferreds prove the completion order; the duration bound is gone)
- **393-404** "does not charge a synchronous wait" / "does not charge a synchronous wait, even one longer than the budget": CLOCK, controlled: no. **rewrite:other(gated: large allowance plus ms - cpuMs >= 995) + move-slow(the original small-budget case)** (risk: med-high). The 1500 ms synchronous host wait is excluded, but the 20 ms spin and surrounding active segments still run against cpuMs:100 and the real ELU hook; an active-segment stall can cut the run or break cpuMs<100. Merely raising the allowance to 1000 leaves the same class under a 1-3 s deschedule. A large allowance with a relative excluded-wait assertion preserves the contract; a controlled ELU test can pin the small budget. (2026-10-21: the old proposed 1000 ms allowance does not satisfy the stated overload; runtime charging and the 100 ms test allowance are unchanged) (fixed in slice 5a (3fa95439b): split into the gated "does not charge a synchronous wait" plus the original kept in slow, the only check that the main thread's watchdog also excludes the wait)
- **421-432** "stops a running loop on abort without terminating the worker": DUR, controlled: no. **rewrite:other(drop ms<1500; abort from a host-entry latch; make ABORT_GRACE_MS (500) injectable)** (risk: med). If the worker does not post luaDone within the 500 ms abort grace, the kill raises the terminated count. ms<1500 is also raced (risk: med) (fixed in slice 5a (3fa95439b): aborts from a host-entry deferred; the shared pool's 60 s abort grace never ends the run, and the duration bound is gone)
- **486-500** "aborts an unawaited host call's signal when its run completes and drops the late answer": SLEEP, controlled: no. **rewrite:deferred(capture ctx, assert ctx.signal.aborted after `await run`, then resolve a deferred late answer)** (risk: med). A 250 ms real timer reads signal.aborted. A worker gap of more than 250 ms before luaDone gives false. The trailing sleep(50) is a guessed settle (risk: med) (fixed in slice 5a (3fa95439b): a deferred late answer replaces the 250 ms timer)
- **513-533** "kills only the owner when a spawned regex times out, and cancels that run's host calls": BOOT, controlled: partial. **rewrite:raise-timeout(warm the two-pool outside the test or raise to 20 s)** (risk: med). Two cold workers plus a 1 s sub-regex deadline plus a 1.5 s bystander wait inside the default 5 s timeout. The deadline outcome is deterministic (REDOS never ends) (risk: med) (fixed in slice 5a (3fa95439b): a two-worker pool warmed in a describe hook, and a held bystander instead of the 1.5 s wait)
- **535-557** "ignores a host answer that arrives after its worker was killed": SLEEP, controlled: no. **rewrite:deferred(resolve the late answer from a deferred after the kill and await the host promise chain)** (risk: high). sleep(1600) plus a 1.1 s watchdog plus an unwarmed pool's cold replacement boot for the "next" run, all inside the default 5 s timeout (risk: high) (fixed in slice 5a (3fa95439b): a deferred late answer resolved after the kill replaces sleep(1600), on a warmed pool)
- **633-647** "releases the reservation of an aborted run": CLOCK, controlled: no. **rewrite:other(assert usedMs===aborted.cpuMs and below the 1000 reservation; abort on a host-entry latch)** (risk: med). usedMs<100 charges real ELU of the preamble; a gap over 100 ms fails it (risk: med) (fixed in slice 5a (3fa95439b): a 60 s reservation aborted at a host-entry latch is charged only what it ran)
- **649-662** "charges a run whose result is dropped as invalid": CLOCK, controlled: partial. **rewrite:other(budget 10000 so the allowance is 3000)** (risk: low). The >=50 checks are load-monotone (wall spin). Only a gap over ~925 ms lets the 1000 ms allowance cut the run (risk: low) (fixed in slice 5a (3fa95439b): a 60 s budget leaves the spin uncut)
- **664-676** "charges the job budget across runs and refuses the run past it": CLOCK, controlled: no. **rewrite:injected-clock(stub ELU in an in-process runtime test for the remainder size; keep invariants: second refused iff first.cpuMs>=400, usedMs==sum)** (risk: med). second.cpuMs<250: a run admitted with the remainder overshoots by any gap between hook checks or reaches the 1 s watchdog (risk: med) (fixed in slice 5a (3fa95439b): the seeded remainder is read as a synchronous reservation and the run is an unbounded loop)
- **680-690** "fails only the call for a host answer that cannot cross, with no unhandled rejection": SLEEP, controlled: no. **rewrite:other(await nextTurn() as elsewhere)** (risk: low). sleep(20) to surface an unhandled rejection; outrunning it only weakens the test (vacuous pass) (risk: low) (fixed in slice 5a (3fa95439b): nextTurn() replaces sleep(20))
- **800-827** "terminates a ReDoS regex at its deadline while HTTP stays responsive, and recovers": PERF, controlled: no. **move-slow** (risk: high). Each fetch latency under 500 ms and the whole run under 3 s; main-thread responsiveness on the real clock is the subject (risk: high) (fixed in slice 1 (40ab0dce4): real responsiveness case moved to slow)
- **829-852** "fails the task past the queue cap at once": POLL, controlled: no. **rewrite:deferred(entered deferred as in 557-582) + rewrite:raise-timeout** (risk: med). Hand-rolled 400x25 ms poll (10 s) inside the default 5 s timeout with a cold pool, then 1000 queued regex round trips (risk: med) (fixed in slice 5a (3fa95439b): a held slot on a warmed pool; the full-queue drain is now the slow case "runs every task the full queue held once the slot frees")
- **856-888** "gives request to low-level runs only, through the guard and the pool's own window": CLOCK, controlled: partial. **keep-accepted** (risk: low). The limiter's 60 s window uses real Date.now (egress.ts:14). A margin of 60 s against a 5 s test, but there is a cold pool boot (risk: low)
- **954-965** "charges a C-level runaway that follows a shortened give-up (syncHostTimeoutMs)": DUR, controlled: no. **move-slow** (risk: med). ms<7000 includes a cold boot plus a 1 s give-up plus the 1.1 s watchdog. ms>=1000 is safe (risk: med) (fixed in slice 5a (3fa95439b): moved to slow with its 20 s timeout, since the real give-up is the subject; the gated coverage is the new controlled "leaves out an unanswered synchronous call only up to the worker's own give-up")
- **1133-1169** "grows to maxSize under load, admits in FIFO order at saturation, and retires idle workers": POLL, controlled: no. **rewrite:deferred(per-index entry deferreds) + fake setTimeout for idleMs after boot** (risk: med). vi.waitFor with a 5 s real cap on worker-thread entry of two cold workers. Idle retirement runs on a real 200 ms timer (risk: med) (fixed in slice 5a (3fa95439b): entry deferreds replace vi.waitFor; the growth worker keeps a real cold boot under an explicit 60 s timeout, a stated exception (cause 3))
- **1171-1199** "leaves no worker behind when disposed after warm()" / "fails the running and queued tasks on dispose and refuses new ones": SLEEP, controlled: no. **rewrite:other(drop the sleeps: start() is synchronous and the assertions hold without them)** (risk: low). Guessed settles; outrunning them gives a vacuous pass, not a failure. Cold boot in 5 s (risk: low) (fixed in slice 5a (3fa95439b): completion deferreds replace the sleeps)
- **1201-1210** "replaces a terminated worker when the pool is warm": BOOT, controlled: no. **rewrite:raise-timeout** (risk: med). Warm boot plus a run plus the 1 s REDOS deadline plus the replacement worker's cold boot, all in the default 5 s (risk: med) (kept in slice 5a (3fa95439b) as a stated exception: the replacement's real cold boot is the subject and runs under an explicit 60 s timeout; see cause 3)
- **1227-1248** "lets a plain Node process that never disposes the pool exit on its own": BOOT, controlled: no. **move-slow** (risk: med-high). A fresh Node process (the slow tag's own category) with ms<15000 and a 30 s timeout (risk: med-high) (fixed in slice 1 (40ab0dce4): fresh Node process moved to slow)
- **100-277,559-584,907-929,968-1129** "makePool" / "worker readiness" / "caps sleep per call and per run at the pool's sleepCaps": BOOT, controlled: partial. **rewrite:other(warm ordinary pools outside the test; give non-budget subjects large worker allowances; use a worker adapter or slow tier for real readiness boots)** (risk: med). Parent fake setTimeout/setInterval and the performance.now spy control only parent deadlines/watchdogs. Real worker boot remains inside the default 5 s timeout, and fake timers do not reach the worker's Lua ELU hook: readiness Lua tasks still request cpuMs:100 at 1003 and 1031. Ordinary shared-pool tests use real worker budgets and regex deadlines. The sleepCaps case does await warm before its timer spy, but does that warm inside the test; its 600 ms lower bound and [200,200,200] timer-argument assertion are safe. Promise.resolve/nextTurn flushes are in-process. (2026-10-21: corrected the old keep-det label: the acknowledged cold boots and real worker-side clock were never fully controlled) (partly fixed in slice 5a (3fa95439b): ordinary pools are warmed in describe hooks and makePool sets bootMs out of reach; the readiness block keeps real cold boots under an explicit 60 s timeout, a stated exception (cause 3)) (kept in slice 9a (fd6805ccf) under the 5a stated exception: no change, and the two readiness `cpuMs: 100` tasks never actually run)
- **461-484** "never dispatches the next host call after an abort during a synchronous one": SLEEP, controlled: yes. **keep-det** (risk: low). The host-entry callback arms abort at 20 ms and the answer at 100 ms, in that order on the same parent event loop. When both timers are overdue, abort still runs first and propagates synchronously before the host answer is sent; the test checks aborted/no write, not promptness or the worker's termination count. This timer ordering is controlled by construction; the file's separate real worker budgets still apply. (new 2026-10-21)
- **771-798** "answers regex operations with groups, and caps amplified captures and entry counts": CLOCK, controlled: no. **rewrite:other(pass a generous deadlineMs for successful/cap-check regexes)** (risk: high). Every pool.regex call here uses DEFAULT_REGEX_DEADLINE_MS=1000, including amplified captures and split of 400,000 input characters. The parent arms the real timer at dispatch before posting to the worker (workerPool.ts:522-524); a delayed reply can become Regex timed out instead of the expected value/size-cap error. Warmth excludes boot from the deadline, not scheduling or reply delivery. (new 2026-10-21) (fixed in slice 5a (3fa95439b): regexes that must succeed get a 60 s deadline)

#### `server/src/tests/sharedImports.test.ts`

- **14-30** "imports every shared/**/\*.ts with plain node": BOOT, controlled: no. **move-slow** (risk: med). execFileSync starts a fresh Node process that type-strips and imports every non-test shared/**/*.ts file (88 at current HEAD, previously recorded as 84) inside the default 5 s timeout. The dependency graph and child scheduling are real; the slow tier explicitly names fresh Node processes. No fresh duration was measured. (2026-10-21: the current shared module set grew to 88; the fresh-process case remains untagged) (fixed in slice 1 (40ab0dce4): fresh Node process moved to slow)

#### `server/src/tests/shutdown.test.ts` (2026-10-18 fixed file)

- **60-91** "startMain": BOOT, controlled: no. **move-slow** (risk: high). spawns a fresh Node process running main.ts and polls stdout for "server is running" with a real 10 s cap (25 ms steps); idle boot ~0.4 s, so ~4-7 s at 9x slowdown plus deschedules; fresh Node processes are a slow-tier criterion in vitest.config; risk high (fixed in slice 1 (40ab0dce4): whole file tagged slow)
- **127** "lets an import admitted before SIGTERM finish and deliver its response, then exits 0": POLL, controlled: no. **move-slow** (risk: high). waitFor DEFAULT 2000 ms real cap for the CHILD process to create save/.tmp/import-* after 16 body bytes (child at 1/9 CPU, fs I/O); risk high (fixed in slice 1 (40ab0dce4): whole file tagged slow)
- **131-133** "lets an import admitted before SIGTERM finish and deliver its response, then exits 0": SLEEP, controlled: no. **rewrite:other(waitFor the "SIGTERM received" line as test 2 does at 185)** (risk: low). sleep(150) is meant to let the child process SIGTERM before the upload completes; if it has not, the import simply finishes first and the test still passes (silently stops testing the drain); risk low (false pass, not a flake) (fixed in slice 1 (40ab0dce4): waits for the "SIGTERM received" line; whole file tagged slow)
- **191** "lets a resource write admitted before SIGTERM land with 200, then exits 0": POLL, controlled: no. **move-slow** (risk: med). waitFor real 5000 ms cap for the child to log "SIGTERM received"; the 100-continue barrier itself is deterministic; risk med (fixed in slice 1 (40ab0dce4): whole file tagged slow)
- **215-220** "exits promptly on SIGINT with an idle keep-alive connection open": DUR, controlled: no. **move-slow** (risk: med). expect(Date.now()-started).toBeLessThan(5000) from SIGINT to child exit (close, dispose workers/sqlite); real promptness is the subject; the wrong implementation it catches waits for SHUTDOWN_GRACE_MS=8000, so the bound cannot be widened much; risk med (fixed in slice 1 (40ab0dce4): whole file tagged slow)
- **96-204** "lets an import admitted before SIGTERM finish and deliver its response, then exits 0" / "lets a resource write admitted before SIGTERM land with 200, then exits 0": CLOCK, controlled: no. **move-slow** (risk: low-med). the admitted import/PUT must finish inside main.ts SHUTDOWN_GRACE_MS=8000 real setTimeout (main.ts:103) or closeAllConnections destroys it and status 200 fails; work ~0.1 s idle; risk low-med (fixed in slice 1 (40ab0dce4): whole file tagged slow)
- **149,204,222** "main.ts graceful shutdown": TMO, controlled: no. **move-slow** (risk: med). 20_000 ms per-test timeouts around child boot + request + exit (idle 0.55-0.8 s); ~2-4x margin at 9x slowdown with deschedules; risk med (fixed in slice 1 (40ab0dce4): whole file tagged slow)

#### `server/src/tests/shutdownAdmission.test.ts`

- **40** "lets a write admitted before shutdown finish against the open store, and refuses new requests with 503": SLEEP, controlled: yes. **rewrite:other(drop the sleep; admission is synchronous on app.request dispatch)** (risk: none). setTimeout(30) "handler is admitted": admission (app.ts:432-468, snapshots.track registers synchronously, snapshots.ts:207) happens before app.request returns, so the sleep's length never matters; risk none (fixed in slice 9a (fd6805ccf): the setTimeout(30) is removed)

#### `server/src/tests/snapshots.test.ts`

- **107-129,152-159** "snapshot only after a committed write since the last one" / "counts a chat-only write as a write, but not an ignored checkpoint or a rolled-back batch": POLL, controlled: no. **rewrite:other(control the interval tick and await snapshot completion; replace the 2 s I/O poll with a completion latch)** (risk: med-high). The manager still ticks on a real 30 ms setInterval, then awaits SQLite backup and asynchronous fs rename/stat before the file is observable. Four testSupport.waitFor calls have a real 2 s cap. Faking the interval alone does not drive the backup/fs callbacks, and advancing several ticks while one snapshot is pending can collapse them behind tickQueued. Drive each tick explicitly and await its completion. The real sleep(100) negative windows can hide wrong extra snapshots under load. (2026-10-21: refined the old fake-timers-only remedy against the current asynchronous backup path; the underlying timers and polls are unchanged) (fixed in slice 3 (88953f6d0): fakes the interval and awaits snapshot completion through the exclusive queue)
- **64,89** "publishes a complete single-file copy under a stamped name and lists only such files, newest first" / "keeps only the newest `keep` snapshots": CLOCK, controlled: partial. **rewrite:injected-clock** (risk: low). ids are stamped with new Date() at ms resolution and listed by name; sleep(2) keeps stamps apart; load only widens the gap, a same-ms pair would sort by random hex (risk: low) (fixed in slice 9a (fd6805ccf): both tests fake Date and set exact stamps)
- **204,208,276,284,307** "waits for the running snapshot and every tracked operation, then refuses new ones without starting them" / "waits for storage mutations admitted earlier before maintenance work starts, while refusing new ones" / "keeps the safety snapshot and the maintenance body under the same lock as other exclusive work": SLEEP, controlled: yes. **keep-det** (risk: low). deferreds hold the operations; sleep(10/20) only gives a window for a wrong early resolve, and load cannot make the negative assertion fail (risk: low)

#### `server/src/tests/thoughts.test.ts`

- **42-55,66-70** "leaves a megabyte of unmatched opening tags unchanged without backtracking" / "keeps one block among many unmatched openings, first opening to last closing" / "keeps unmatched openings in the content and parses them in linear time": PERF, controlled: partial. **keep-accepted** (risk: low). It relies on the default 5 s timeout to catch the quadratic regex (minutes at 1 MB, as the header comment documents). The linear scan takes ms, so the margin is about 1000x. Risk: low (kept in slice 7a (83b9f9591) as keep-accepted per D3, about 1000x margin; a deliberate difference from the plan's 7a list)

#### `server/src/tests/tokenParity.test.ts`

- **39,97,109,158** "%s gives the browser's ids for every fixture text" / "%s gives the browser's ids for every captured text" / "plugin-legacy-custom-func counts with cl100k_base instead of the plugin's function (the recorded difference)" / "the server's tokenizers count the two inserted messages as the delta records, per family": TMO, controlled: no. **keep-accepted** (risk: low). Cold in-process tokenizer loads (no workers or timers). The slowest is 1.1 s alone (cohere, GLM), about 10 s at 9x, against 60 s. "count is the id count" (default 5 s) relies on the earlier tests having loaded every family already. risk: low

#### `server/src/tests/transform.test.ts`

- **28,196-885** "the transform's stages" / "the transform cache's key" / "the two-call protocol" / "the transform's admission": TMO, controlled: partial. **keep-accepted** (risk: low-med). 60 s timeouts because the real script worker pool (Lua, regex) boots and runs every render in worker threads; real budgets on the path (TRANSFORM_SNAPSHOT_TTL_MS 30 s by Date.now, Lua cpuMs 3000, regex 5000) keep >10x margins; move-slow if it ever flakes; risk low-med

#### `server/src/tests/transformService.test.ts`

- **114-117,189** "heldCount" / "shutdown ends the running and the queued requests, waits for them, and refuses new work": POLL/SLEEP, controlled: partial. **keep-poll** (risk: low). iteration-capped poll over fake in-process script workers and sync sqlite; the 5 ms sleep is a negative check; risk low
- **273-354** "the transform service's deadline and snapshots": CLOCK, controlled: yes. **keep-det** (risk: none). toFake includes Date where the 30 s TTL is asserted; the "clock" test spies Date.now; the other tests carry the real 30 s render deadline (huge margin); checked, controlled

#### `server/src/tests/transformers.test.ts`

- **163-452** "the queue" / "killing the process" / "dispose": SLEEP, controlled: yes. **keep-det** (risk: low). tick()/tick(5) are real setTimeouts, but the fake workers answer synchronously or by queueMicrotask, and the real idle/task timers are 60 s; the two time-limit cases use full vi.useFakeTimers (risk: low)
- **497-520** "forks transformersWorker.ts, answers over IPC, is killed when idle, forks again for the next task, and is gone after dispose": SLEEP, controlled: no. **move-slow** (risk: high). A real fork with idleMs 150, then a fixed tick(600) and expect signal()==="SIGKILL". signalCode is set only once the child's exit is processed (poll phase). If the process is descheduled past ~450 ms, the idle and 600 ms timers fire in the same timers phase before the exit is seen and the check fails. Also: wait on the adapter's exit promise instead of tick(600) (risk: high) (fixed in slice 1 (40ab0dce4): moved to slow; awaits exit instead of sleeping 600 ms)

#### `server/src/tests/translate.test.ts`

- **262-272** "ignores a translation whose source text changed during the run and stores nothing": SLEEP, controlled: no. **rewrite:deferred** (risk: high). echoDelay 0.3 is a real 300 ms sleep in requestEcho (llm/request.ts:1023). The chatBatch edit must land inside it, or the run is applied rather than ignored. Hold the provider with a latch instead (as the fake-request-layer section does). Risk: high (fixed in slice 6a (328634ecd): a call-through spy holds the real Echo answer instead of its 300 ms sleep)
- **274-300** "joins a run in flight (one run, the same result, whatever the joiner's force) after the joiner's ids pass the display binding and exist": SLEEP, controlled: no. **rewrite:deferred** (risk: high). The joiner, the binding-mismatch request and runningCount()==1 must all happen within the real 300 ms Echo sleep. After a stall the joiner starts its own run. Risk: high (fixed in slice 6a (328634ecd): a call-through spy holds the real Echo answer instead of its 300 ms sleep; the join waits on the runner's admission and checks one provider call and one write)
- **315-325** "refuses a message a generation owns: before the run (409 generating) and at the write when the lock was taken meanwhile": SLEEP, controlled: no. **rewrite:deferred** (risk: high). lockingJob + createJob + held must finish inside the 300 ms Echo sleep for the write to conflict with 409 generating. Under a stall the translation lands first. Risk: high (fixed in slice 6a (328634ecd): a call-through spy holds the real Echo answer instead of its 300 ms sleep)
- **389-404** "maintenance ends a run at once (503, Retry-After), refuses new ones while it lasts, also while the jobs' listener waits, and the ended run never writes": SLEEP, controlled: no. **rewrite:deferred** (risk: high). withMaintenance must begin before the 300 ms real Echo sleep ends, or the run answers 200. Line 397 then polls 2000 ms of real time for that sleep to settle. Risk: high (fixed in slice 6a (328634ecd): a call-through spy holds the real Echo answer instead of its 300 ms sleep; the late answer is shown to write nothing)
- **429-445** "shutdown ends a run (503) and refuses new ones; dispose waits for the work still settling": SLEEP, controlled: no. **rewrite:deferred** (risk: high). beginShutdown must fall inside the 300 ms Echo sleep, and workingCount()==1 at line 431 asserts the sleep is still running. Dispose's DRAIN_WAIT_MS of 5000 ms is real too. Risk: high (fixed in slice 6a (328634ecd): a call-through spy holds the real Echo answer instead of its 300 ms sleep; the drain's 5 s cap is held too, and dispose is checked to wait)
- **519-538** "a run outlives its HTTP request: the tab's disconnect does not end it, and the translation lands": SLEEP, controlled: no. **rewrite:deferred** (risk: high). Real listen + fetch. The abort and runningCount()==1 at line 523 must land inside the 300 ms Echo sleep, and line 525 polls 2000 ms of real time for it. Risk: high (fixed in slice 6a (328634ecd): a call-through spy holds the real Echo answer instead of its 300 ms sleep; the test waits until the server sees the abort)
- **206-214** "jobEnded": POLL, controlled: partial. **keep-poll** (risk: low). A hand-rolled 2000 ms real-Date.now cap on in-process app.request status reads after release(). The loop checks the condition before the deadline, so a stall rarely trips it. Risk: low (fixed in slice 3 (88953f6d0): routes jobEnded through uncapped waitFor)
- **613-623,848-900,1281-1311,1733-1768** "createTranslationRunner over a fake request layer": CLOCK, controlled: yes. **keep-det** (risk: low). Deferred answers. until() counts setImmediate turns, not time. Date is faked wherever the deadline is read (toFake includes "Date"). The real 10-min deadline timer in the Date-only tests never fires. Risk: low

#### `server/src/tests/triggerRuntime.test.ts`

- **1410-1416** "runs v2Command with the CBS'd line through the job's executor and v2Wait as an abortable sleep": DUR, controlled: partial. **rewrite:other(drop the elapsed < 5000 check; the 30 s v2Wait already overruns the default 5 s test timeout if the sleep ignores abort)** (risk: low). Date.now elapsed on a real 30 s sleep aborted by a real 20 ms timer; fails only on a >5 s stall, which the default test timeout also hits; catches nothing extra (risk: low) (fixed in slice 7a (83b9f9591): the duration bound is gone)
- **1526-1531** "ends an endless loop with the limit": TMO, controlled: partial. **keep-accepted** (risk: low). 30 s bump for a CPU-bound effect-limit loop; idle 159 ms (~190x margin) (risk: low)

#### `server/src/tests/upstreamExport.test.ts`

- **36-38,353-363,680-718,1252-1272** "exportOf": CLOCK, controlled: yes. **keep-det** (risk: none). The helper always passes now: NOW (or the explicit NOW + 1 override) into buildUpstreamDatabase. The expired/recent trash boundary and the second-export idempotence assertions use this injected clock. Codec gzip timestamps are not compared in this file. (new 2026-10-21)

#### `server/src/tests/upstreamExportRoute.test.ts`

- **88-103,109-238,253-269** "prepare": CLOCK, controlled: no. **keep-accepted** (risk: low). Normal route lifecycle cases stage exports on the real UPSTREAM_EXPORT_STAGED_TTL_MS timer, 600,000 ms, before downloading/cancelling them or disposing the context. That is 120 times the default test timeout; no short TTL or elapsed-time assertion is involved. The import round trip at 187 explicitly injects stageUpstreamImport, so it does not cold-boot a worker. (new 2026-10-21)
- **240-251** "answers 404 for an expired export and removes its folder": CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/clearTimeout are fake before the server creates its 1000 ms staging timer; advanceTimersByTimeAsync fires expiry, and close awaits the resulting filesystem removal. The staging store's get/take paths do not consult Date.now, so omitting Date is safe here. (new 2026-10-21)
- **286-310** "expires a waiting export after the TTL, hands one to its download without expiry, and close removes the rest and refuses new ones": CLOCK, controlled: yes. **keep-det** (risk: none). The 999 + 1 ms boundary, detachment on take, and cleanup on close are driven by fake setTimeout/clearTimeout. Cleanup completion is awaited rather than inferred from a sleep. (new 2026-10-21)

#### `server/src/tests/upstreamImportCharacters.test.ts`

- **43-45,286-302** "ports prepareNewCharacter: ttsMode, creation_date, globalLore upgrade, a first chat, fmIndex and localLore": CLOCK, controlled: yes. **keep-det** (risk: none). convert injects now: 1; the missing creation_date assertion reads that fixed value rather than the converter's Date.now default. The converter itself runs in process. (new 2026-10-21)
- **736-743** "reports every repair of a chat with very many invalid messages instead of overflowing": PERF, controlled: no. **move-slow** (risk: low-med). A 150,000-entry message list is converted under the default 5 s budget. The cardinality is meaningful for a spread/argument-overflow regression, so retain that large-limit case in slow and keep a small malformed-message contract in the gate. There is no elapsed-time assertion; the only throughput bound is the default timeout. This case was not timed. (new 2026-10-21) (fixed in slice 1 (40ab0dce4): small gated case "reports one repair per invalid message and keeps the valid ones around them"; 150,000-message case moved to slow)

#### `server/src/tests/upstreamImportRoute.test.ts`

- **42-43,68-71,129-150,194-617** "prepare": CLOCK, controlled: no. **keep-accepted** (risk: low). Prepared imports in the route lifecycle cases wait on the real 600,000 ms UPSTREAM_STAGED_TTL_MS timer (120 times the default test timeout). The helper injects the in-process stageUpstreamImport runner; early-ending cases replace it with a deferred/abort-driven runner. No gated case in this file starts importWorker.ts. (new 2026-10-21)
- **643-664** "expires a waiting import after the TTL, removing its folder, and holds at most one": CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/clearTimeout are faked and advanced through 999 + 1 ms; close awaits the asynchronous removal expiry started. Staging expiry has no Date.now check, so the timer-only toFake list controls the relevant clock fully. (new 2026-10-21)
- **666-693** "take hands the import to its commit (no expiry, no removal), cancel removes it, and close removes the rest": CLOCK, controlled: yes. **keep-det** (risk: none). The fake clock advances 5000 ms past the injected 1000 ms TTL after take; cancel/close removal promises are awaited directly. This distinguishes a taken import from one still eligible for expiry. (new 2026-10-21)

#### `server/src/tests/upstreamRisuSave.test.ts`

- **69-74** "decodes the frozen upstream \\x08 fixture, and encodes it to the same bytes": CLOCK, controlled: yes. **keep-det** (risk: none). The encoder's gzip mtime is frozen with toFake: ["Date"] and now: FIXTURE_MTIME_MS before the byte-for-byte comparison. Other codec tests compare decoded values or format refusals, not the current timestamp. (new 2026-10-21)

#### `shared/tests/translatorHistorySlots.test.ts`

- **172** "renders the same entries in both slots, an empty block for an entry without a translation, and counts each block once, one after another": SLEEP, controlled: yes. **keep-det** (risk: none). 1 ms delay inside the countTokens mock to expose overlap; no competing timer or assertion on time; risk none

#### `shared/tests/translatorPipeline.test.ts`

- **398** "translateProtectingLines": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(1) inside a fake translator only creates an await gap; any overlap trips inFlight synchronously, so the result does not depend on timing (risk: low)

#### `src/lib/ChatScreens/Chat.draft.test.ts`

- **200;217;247;266;284;292;301** "render": POLL, controlled: yes. **keep-poll** (risk: low). The fake setTimeout leaves Date real, but Chat.svelte's render path reads no clock; vi.waitFor waits on a mocked async ParseMarkdown (in-process promise chain), with only the 1 s cap as real time (risk: low)

#### `src/lib/ChatScreens/Chat.test.ts`

- **270,326,332,347,353,391,411,414,418,421,463,549,552,594,596,603,604,607,614,616,618,641,643,740,763,780** "expectText": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor (1 s cap) over Svelte render and mocked async parser/transport promise chains; the short Chat/ChatBody render timers are scheduled before their polls. The post-hydration pending clear at 571 is excluded and has its own row. (2026-10-21: separated the real stored-translation sync-poll dependency from the in-process render polls)
- **533,565,757,772** "with the flag on but no target language, a mounted row shows the original and requests nothing": SLEEP, controlled: partial. **rewrite:other(replace the 50/150 ms sleeps with a deterministic flush of the known in-process chain)** (risk: low). 50-150 ms sleeps before "nothing happened" checks; under load they can only false-pass (miss a regression), not fail; risk low (partly fixed in slice 6b (56c228579): the 565 sleep is a fake-timer advance; the 50 ms sleeps at 533, 757 and 772 remain for sweep 9b) (fixed in slice 9b (0a6fb1aa5): the remaining 50 ms sleeps run on fake timers with one 1 s advance, so the row is fully fixed)
- **633-634,652-653** "Retranslate confirms with the message captured before the dialog, requests with force after a yes, and does nothing after a no or for a message gone meanwhile": SLEEP, controlled: yes. **keep-det** (risk: none). tick + setTimeout(0) after a mocked confirm resolves: the click handler's continuation is microtasks only, with no I/O; negative check; risk none
- **564-571** "the toggle requests a translation when none is fresh: pending until the refresh lands, spinner, disabled controls, and the stored translation shown after": POLL, controlled: no. **rewrite:fake-timers** (risk: med). The real storedTranslation.svelte module is not mocked. After the applied answer enters heldCatchesUp, the 150 ms sleep leaves it polling; hydration does not wake that loop. Clearing translating still needs its real 100 ms SYNC_POLL_MS timer (with a real Date.now + 15 s deadline), while vi.waitFor has a 1 s real cap. Fake Date and timers, then explicitly advance the sync poll; the other render polls are a separate keep-poll row. (new 2026-10-21) (fixed in slice 6b (56c228579): fake timers, and one explicit 100 ms poll advance clears `translating`)

#### `src/lib/ChatScreens/ChatBody.assets.svelte.test.ts`

- **53** "settle": SLEEP, controlled: yes. **keep-det** (risk: none). flushSync + setTimeout(0): every awaited dependency is a mocked async function (ParseMarkdown, getFileSrc), sleep is mocked, and the translation timers are not on this path; risk none

#### `src/lib/ChatScreens/ChatBody.styles.svelte.test.ts`

- **50-59,77-153** "until": POLL, controlled: yes. **keep-poll** (risk: low). The helper flushes Svelte and yields setTimeout(0) for at most 50 rounds, checking DOM rendering from local parser promises; it has a round count rather than a millisecond deadline and no socket/fs work. The translation mocks and false translation props do not enter the production 100 ms translation sleep. The initial 10 ms translated-state assignment is redundant for the tested false state. (new 2026-10-21)
- **77-153** "ChatBody under a chat style registry": CLOCK, controlled: no. **rewrite:other(stop performance.now for these style assertions or inject a non-advancing CBS clock)** (risk: med). The real parser reaches trimMarkdown/trimMarkdownSharingStyles → decodeStyleContent → risuChatParser, even for CSS without CBS tokens. CLIENT_CBS_LIMITS checks a real 2000 ms performance.now budget at the end of every parse. A deschedule inside that tiny parse can turn a valid stylesheet into the decoder's error fallback and break the asserted sheet/placeholder. The registry itself only batches reconciliation in microtasks. (new 2026-10-21) (fixed in slice 2 (7a1a083ba): stops the CBS performance clock for style assertions)

#### `src/lib/ChatScreens/ChatBody.svelte.test.ts`

- **58,64-94** "ChatBody pending body": CLOCK, controlled: yes. **keep-det** (risk: low). toFake only setTimeout but ChatBody.svelte reads no Date/performance and util sleep is mocked; settle's setTimeout(0) follows an in-process deferred parse + Svelte render; risk low

#### `src/lib/ChatScreens/Chats.rows.svelte.test.ts`

- **350** "keeps the cap or visible rows plus a page (%i existing visible rows)": CLOCK, controlled: no. **rewrite:fake-timers** (risk: med). trim retires 25-51 rows through disposeRetired, which has a real performance.now() 4 ms budget per real rAF frame (no fake timers in this describe); vi.waitFor's 1 s real cap must cover all frames; a deschedule breaks the budget and stretches the frames; fake rAF + stub performance.now (or advance frames) (risk: med-low) (fixed in slice 9b (0a6fb1aa5): fake animation frames and a performance.now that advances 1 ms per read; the test also checks the bounded-frame disposal)
- **474-1016** "opening row reveal": CLOCK, controlled: yes. **keep-det** (risk: none). toFake setTimeout/rAF only, but the 1200 ms reveal and 3000 ms mount deadlines are setTimeout-based (Chats.svelte:213,565); the only real-clock reader (disposeRetired) is not reached by these describes

#### `src/lib/ChatScreens/PartialEditController.test.ts` (2026-10-18 fixed file)

- **108,126,155,171,268,276,283,310-311,323,361,384,396,410,425,450** "render": POLL, controlled: partial. **keep-poll** (risk: low). vi.waitFor retains its real 1 s cap while advancing fake setTimeout in 50 ms steps. It waits only on Svelte render, deferred context/save promises, and happy-dom rAF (real setImmediate); the new hover/context cases add the same in-process pattern, with no socket or worker. The controller reads no Date/performance. (2026-10-21: added hover/modal coverage at 423-450; its polls remain in process)
- **107,112-113,198,244,333-345** "opened": SLEEP, controlled: yes. **keep-det** (risk: none). Only setTimeout/clearTimeout are faked; the controller reads no Date/performance. opened() drains async matching with a 0 ms advance before polling, then drives the 10 ms focus and 200 ms scroll delays. The no-settle scroll test observes the focus and pending 200 ms callback before cancelling; the callback then runs on fake time against the closed editor. Drag debounce is also setTimeout-based; hover rAF is covered by the poll row. (2026-10-21: rechecked current focus/scroll/debounce paths and the new no-settle hover caller; control remains sufficient)

#### `src/lib/Others/MessageSearch.test.ts`

- **139-147,205-249,277-290,425-464** "the query": CLOCK, controlled: yes. **keep-det** (risk: none). Aggregates the 300 ms debounce and reopen checks: bare useFakeTimers controls timers, Date and performance, and requests are explicit deferreds. The Svelte settle helper drains microtasks and flushes synchronously; there is no bounded real-time poll. (new 2026-10-21)

#### `src/lib/Others/RequestLogs/ServerRequestHistory.test.ts`

- **102-103,110** "settle": CLOCK, controlled: yes. **keep-det** (risk: none). vi.useFakeTimers() with no toFake (Date/performance faked); settle = advanceTimersByTimeAsync(0)

#### `src/lib/Setting/Pages/Advanced/DiagnosticsPanel.test.ts`

- **40,47,138** "settle": CLOCK, controlled: yes. **keep-det** (risk: none). vi.useFakeTimers() with no toFake fakes Date too (stamped download name, the 1500 ms notice); all I/O mocked; risk none

#### `src/lib/Setting/Pages/MemorySettings.hypaV3Export.test.ts`

- **73,104,127,133** "settle": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) after click handlers whose async work is only mocked promises (downloadFile, selectSingleFile), with no I/O. The macrotask runs after the microtasks drain. Risk: low

#### `src/lib/Setting/Pages/Module/ModuleSettings.share.test.ts`

- **55,93,100,113-114,122-123,136-137,153-154** "module share button": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor and setTimeout(0) wait on mocked exporters and in-process store/render promise chains. The store is now the real createAlertQueue with gapMs: 0; status clears and dialog ownership checks are synchronous, and the final answer does not assert a timed next-dialog transition. The additional stale-wait-behind-dialog test uses this same pattern. (2026-10-21: real alert queue replaced the writable mock and a dialog-preservation case was added; no real nonzero dialog gap is raced)

#### `src/lib/Setting/Settings.search.test.ts`

- **75-76,222-379** "a search jump": CLOCK, controlled: yes. **keep-det** (risk: none). Bare fake timers control settingJump's 2000 ms ring removal, including the Display/Prompt/Connections cases; tick/flushSync settle rendering before the ring assertions. Tokenization and unused pages are mocked; the module graph is statically collected rather than reset/imported inside the tests. (new 2026-10-21)

#### `src/lib/Setting/SettingsSections.test.ts`

- **167-177,179-197** "mounts the named section open and the other closed; both the opening and the ring survive finishJump": CLOCK, controlled: yes. **keep-det** (risk: none). The added search-jump block installs bare fake timers before scrollToSetting arms the highlight timeout and advances exactly SETTING_HIGHLIGHT_MS. finishJump and Svelte flushes do not race its real expiration. (new 2026-10-21)

#### `src/lib/Setting/botpreset.test.ts`

- **135,142,324,342,354** "settle": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) after a mocked confirm (resolved promise) and in-process store writes; known-depth microtasks, no I/O (risk: low)

#### `src/lib/Setting/botpresetArchive.test.ts`

- **47,278,286** "settle": SLEEP, controlled: yes. **keep-det** (risk: low). one macrotask flush after an in-process promise chain (mocked alertConfirm, no I/O); risk low

#### `src/lib/SideBars/CharConfig.emotions.test.ts`

- **260,275** "deletes while another row's input is pending, or the typed-into row itself, without a throw": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) lets Svelte's bind_value tick read and any unhandledRejection surface; in-process only, no I/O (risk: low)

#### `src/lib/SideBars/ChatNoteEditor.test.ts`

- **107,96,136-229** "ChatNoteEditor token counting": CLOCK, controlled: yes. **keep-det** (risk: low). vi.useFakeTimers() with no toFake fakes every timer method and Date. requestIdleCallback is stubbed and fired by hand. Risk: low

#### `src/lib/SideBars/LoreBook/LoreBookList.test.ts`

- **131-134** "settle": SLEEP, controlled: yes. **keep-det** (risk: low). tick + setTimeout(0): the awaited work is the mocked alertConfirm, the LoreBookData delete promise chain and Svelte flushes (no I/O); unhandledRejection is emitted before timers. The component's own rAF/10 ms waits are not asserted on (risk: low)

#### `src/lib/SideBars/SideChatList.test.ts`

- **231,314,320,349,353,386,391,407,412,438,444,561** "renderSide": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor and setTimeout(0) over mocked alerts and Svelte render, in-process only; risk low

#### `src/lib/UI/NanoGPTDashboard.test.ts`

- **37** "settle": SLEEP, controlled: yes. **keep-det** (risk: none). setTimeout(0) after resolving a deferred mocked nanogpt call; in-process chain only; risk none

#### `src/ts/alertQueue.test.ts`

- **56-61,63-332** "alert queue": CLOCK, controlled: yes. **keep-det** (risk: none). All 150 ms dialog gaps, the 100 + remainder boundary and gapMs: 0 transitions use fake timers; settled only drains already-queued promise continuations. Status, cancellation and idle assertions are observable queue contracts. (new 2026-10-21)
- **334-414** "dialog key gate": CLOCK, controlled: yes. **keep-det** (risk: none). Gap advancement uses the same bare fake timers. The held/repeated/new stroke decisions are delivered synchronously and test whether the next dialog can be answered. (new 2026-10-21)
- **416-576** "alert helpers over the queue": CLOCK, controlled: yes. **keep-det** (risk: none). The real alert helpers use a fresh queue with gapMs: 0, and answer advances its fake timer explicitly. waitAlert waits the queue's idle promise; it does not poll or sleep in production. (new 2026-10-21)

#### `src/ts/alertTerminal.test.ts`

- **32-40,59-64** "settled": SLEEP, controlled: yes. **keep-det** (risk: low). settled() uses setTimeout(0) after only in-process promise resolution. The real alert queue is freshly created with gapMs: 0; any close gap is a 0 ms timer, and terminal notice settlement still comes only from acknowledgeTerminalNotice. alert.ts no longer implements the ordinary dialogs with sleep loops. (2026-10-21: uses the real per-test alert queue rather than a writable mock; the old util.sleep mock was removed)

#### `src/ts/alertUpstreamImportReport.test.ts`

- **42-48,55-97** "answered": SLEEP, controlled: yes. **keep-det** (risk: none). A real zero-delay turn flushes local dialog continuations. The queue also has gapMs: 0: its already-enqueued gap callback precedes the helper's marker timer. There is no duration threshold, I/O or short real deadline; an incorrect immediate report answer would fail the checks. (new 2026-10-21)

#### `src/ts/assetList.test.ts` (2026-10-18 fixed file; **heap-memory-reduction merged 2026-10-20**)

- **196-224** "reuses the cached names of a large list across successive queries for both record owners": PERF, controlled: no. **rewrite:other(shrink to ~1-5k assets; the toBe identity guard is size-independent)** (risk: med). The merged heap work freezes and shares asset lists and caches character names by frozen-list identity (module names by list identity); it removes the old wrapped-tuple traversal, but this test still allocates two 100,000-tuple lists and does 40 queries for each owner, i.e. 80 full scans / 8 million name visits. Its only budget remains the default 5 s timeout. One noisy single-file run measured 776.5 ms for this case, about 7 s at 1/9 CPU before a deschedule. The identity and matching guards fail a plausible cache/rebuild regression at 1-5k items too. (2026-10-21: re-audited after heap-memory-reduction merged 2026-10-20; refreshed the cost and raised risk from low-med to med) (fixed in slice 7b (45b6309bf): renamed from "reuses 100k cached names across successive queries for both record owners"; 2,000 names)

#### `src/ts/bootstrap.safeBoot.test.ts`

- **71-81,107-114,150-163** "counts the attempt before the theme runs and clears it once the loaded page stayed up 10 s": BOOT, controlled: partial. **rewrite:other(also warm StoreBackedServer.create and close that warm-up instance in the 60 s beforeAll)** (risk: med). beforeAll already warms stores/bootstrap, fixing the large client cold graph, but app first calls StoreBackedServer.create inside the test. That helper dynamically imports resourceStore.ts/kinds.ts and opens node:sqlite; resetModules repeats evaluation. The first test took a noisy 240.0 ms here, later ones 40.5-68.9 ms, under a default 5 s test timeout. Move the remaining cold server graph into the warm-up hook as well. (new 2026-10-21) (fixed in slice 4b (236531778): the 60 s beforeAll also creates and closes one StoreBackedServer and loads chatStatus)
- **81,147-281** "loadData with safe boot": CLOCK, controlled: partial. **rewrite:fake-timers** (risk: low-med). The toFake list controls timeout/interval APIs but omits Date. createSafeBoot's default deps.now is Date.now: startSettleWindow captures a real now + 10,000 deadline and its guest-promise continuation rejects a ready guest observed after it. Advancing only the fake timer does not control that comparison. Add Date to toFake (or inject now); the unit-only safeBoot.test.ts already injects both clock and timer. Mocking util.sleep does not fix this deadline. (new 2026-10-21) (fixed in slice 2 (7a1a083ba): includes Date in fake timers)

#### `src/ts/bootstrap.serviceWorker.test.ts`

- **66,74,104** "beforeAll": TMO, controlled: partial. **keep-accepted** (risk: low). beforeAll 60 s for the cold import; each test does vi.resetModules + re-import under the default 5 s (measured 43-270 ms); sleep mocked, setTimeout faked, Date only read for 3-day trash age (risk: low)

#### `src/ts/characterCards.share.test.ts`

- **126-130** "beforeAll": TMO, controlled: partial. **keep-accepted** (risk: low). The cold module graph imports under a 60_000 hook timeout (about 2.5 s idle, 24x margin), which keeps per-test boots at about 0.1-0.4 s under the 5 s default. Risk: low
- **135,184,213** "characterURLImport pending shares": SLEEP, controlled: partial. **keep-det** (risk: low). advanceTimersByTimeAsync(2000) drives the faked save debounce, and the pending answer is a latch (held). Date is real, but no backoff expiry is asserted. The progress depends on timer and yield counts, not wall time. Risk: low

#### `src/ts/characterCardsCharxImport.test.ts`

- **102** "beforeAll": TMO, controlled: partial. **keep-accepted** (risk: low). 60 s budget for first import of stores/database/characterCards (transform ~3 s idle); per-test boot ~60 ms; risk low
- **88,107,173,331,335,408** "CharX files through the server and real records": CLOCK, controlled: yes. **keep-det** (risk: none). upload waits and 180 s advance are setTimeout-based; resourceSync Date.now backoff/jobBlocked paths are not reached (flushResources explicit); checked, controlled

#### `src/ts/characterCardsImport.test.ts`

- **122** "beforeAll": TMO, controlled: no. **keep-accepted** (risk: low). Same warm-up pattern: transform is about 3 s alone. Per-test boot takes at most 0.4 s (the first JSON V2 test, about 3.6 s at 9x, close to the default 5 s if a stall adds to it). risk: low
- **192-196** "a card is prepared as a creation: the defaults, the time, the lore conversion; the record is the server's normalized text": CLOCK, controlled: yes. **keep-det** (risk: none). Real Date.now is read once before and once inside the import, and only monotonic order is asserted. risk: none

#### `src/ts/characterCardsPngImport.test.ts`

- **149;258** "imports a stream once, pulls only as asset batch writes allow, and reports running asset counts": PERF, controlled: no. **rewrite:raise-timeout** (risk: med-high). CPU-heavy work in the default 5 s timeout: 764 ms when idle (12x256 KiB chunks, base64, toEqual) and 558 ms (32-asset stream). At 1/9 CPU that is about 6.9 s and 5 s. Shrinking the fixtures would also do (risk: med-high) (fixed in slice 7b (45b6309bf): both this case and "readGenerator drops consumed bytes so large asset chunks keep a bounded stream window" warm up first, compare base64 and send 4 x 192 KiB chunks)
- **129;167-170;313** "boot": CLOCK, controlled: yes. **keep-det** (risk: low). toFake leaves Date real, but no Date/performance read on the import path matters (the only one is the card's modification_date); advances of 0 only drain in-process streams (risk: low)

#### `src/ts/characterCardsRealmImport.test.ts`

- **196** "beforeAll": TMO, controlled: no. **keep-accepted** (risk: low). Same as above: compile about 3 s alone. Per-test boot takes at most 0.39 s. risk: low
- **486-493** "shows the download and commit alerts only without forceRedirect and the progress lines as they arrive": SLEEP, controlled: yes. **keep-det** (risk: none). advanceTimersByTimeAsync(0) flushes in-process ReadableStream/fake-server promise chains. The client progress path reads no clock. risk: none

#### `src/ts/characterCardsRoundTrip.test.ts`

- **147,156-397** "boot": TMO, controlled: partial. **rewrite:raise-timeout** (risk: med). cold imports are warmed in beforeAll (60 s), but each test re-evaluates the store graph and builds a 40-entry zip under the default 5 s; idle 872 ms for the first case, ~9x under 1/9 CPU share (risk: med) (fixed in slice 9b (0a6fb1aa5): a `warmMutationGraph` setup instead of a timeout raise, and the admission case writes its entries at deflate level 0, still above the 64 KiB feed slice)
- **84,152,214-222** "boot": SLEEP, controlled: yes. **keep-det** (risk: low). fake setTimeout/interval, advanceTimersByTimeAsync(0) over in-process unzip on an ArrayBuffer; util.sleep mocked; the counts do not depend on time (risk: low)

#### `src/ts/characters.test.ts`

- **68-100,116-127** "boot": TMO, controlled: no. **rewrite:other(warm the module graph in beforeAll with a raised hook timeout, and raise the per-test timeout for the resetModules re-evaluation)** (risk: high). boot() does vi.resetModules and cold dynamic imports of resourceSync/bootstrap/characters inside the test under the default 5 s; measured 2220 ms idle (transform 2.5 s), certain to overrun under 1/9 CPU (risk: high) (fixed in slice 4b (236531778): warmMutationGraph warms the graph in a 60 s beforeAll; the `./util` partial mock became a per-test vi.spyOn)
- **103** "boot": CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/interval faked; Date real but trashTime only checked as any Number; no TTL/backoff path reached (risk: none)

#### `src/ts/charactersCapture.test.ts`

- **95** "beforeAll": TMO, controlled: partial. **keep-accepted** (risk: low). 60 s budget for cold module imports; tests themselves use frozen fake timers and explicit flushResources; risk low

#### `src/ts/diagnostics/collector.test.ts`

- **281-375,507-524,588,673,681** "folds an event identical to one of the last 16 (but for its times and duration) within 10 minutes into it: `repeat`, `lastAt`, the first `at` kept": CLOCK, controlled: yes. **keep-det** (risk: none). The ring tests fake setTimeout and Date (setSystemTime). The real-timer http tests fold within a real 10 min FOLD_MS window and assert durationMs >= 0. setTimeout(20) at 674 waits for Node's unhandledRejection, which fires after the microtasks and before any timer. risk: none

#### `src/ts/diagnostics/report.test.ts`

- **163-168,279-313** "bounds the whole save: past the wait before a dispatch it is `network` and the request is never sent (the hook refuses it); after a dispatch it is `timeout` and the fetch is aborted; never retried": CLOCK, controlled: yes. **keep-det** (risk: low). full vi.useFakeTimers() (Date incl.); report.ts deadlines are setTimeout-based, no AbortSignal.timeout; risk low

#### `src/ts/drive/backuplocal.test.ts`

- **427-485** "asks about the keys, flushes, prepares with the tab's selection and the answer, shows the report, and streams the download to RisuAI-backup-<date>.bin": CLOCK, controlled: no. **rewrite:other(freeze Date at a fixed local date before saving and assert the expected filename literal)** (risk: low). SaveUpstreamLocalBackup computes upstreamBackupFileName during the save; line 479 recomputes it from another real new Date after awaits. A local-midnight crossing changes the expected name. Asserting a fixed expected name also avoids accepting the same naming bug in both calls; the independent explicit-date test below protects formatting. (new 2026-10-21) (fixed in slice 2 (7a1a083ba): freezes Date and asserts a literal local-date filename)
- **502-513** "cancels the prepared export when the report is declined, without downloading": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor has a real default 1 s cap, but the cancel request uses this file's synchronous canned authFetch/Response boundary, not sockets or filesystem I/O. It checks the fire-and-forget cancellation call in process. (new 2026-10-21)
- **558-560** "names the file by the local date": CLOCK, controlled: yes. **keep-det** (risk: none). A concrete new Date(2026, 0, 5, 23, 59) is passed to the filename helper; the asserted date is not sampled from the current clock. (new 2026-10-21)

#### `src/ts/exportBatches.test.ts`

- **239-320** "%s consumes a batch while the next 200-key POST is pending" (json): SLEEP/POLL, controlled: partial. **rewrite:other(none for the failure: a cascade of the 5 s timeout)** (risk: low-med). In 1 of 4 parallel whole-suite runs the json case saw a second batch already requested where it expects only the first. Confirmed in slice 10: not a race in the json case. In that run the charx case before it timed out at 5 s; its abandoned body kept running, and its exporter's third POST (`keys.slice(400)`, the stray `["assets/400.png"]`) reached the json case's fake through the module-level `authFetch` mock (`server.current`). The 60 s default (D5) removes that trigger; an abandoned case can still reach the next one's fake after a real hang (new 2026-10-22, found by slice 10) (fixed in slice 10 (this commit): no change for the failure; the case now also records the requests at the first use of a batch's asset (`requestsAtFirstUse`, 2), so moving the prefetch after the batch is consumed fails it, which it did not before)
- **783-797** "refuses as the over-cap batch arrives and cancels the pending read": PERF, controlled: no. **rewrite:other(inject a smaller export cap, or raise the timeout)** (risk: med). It allocates two 32 MiB halves plus 198 more assets (64 MiB cap) under the default 5 s timeout. It takes 1.14 s alone, about 10 s at 9x with memory pressure. The 64 MiB "exactly" test at 765 is lighter but the same kind. risk: med (fixed in slice 7b (45b6309bf): compression is mocked to a few bytes, with no injected limit because the cap counts raw bytes; all three cap cases stay at the real 64 MiB)
- **71,269-281,640,659,686,796** "flush": CLOCK, controlled: yes. **keep-det** (risk: none). flush = advanceTimersByTimeAsync(0) on in-process fake-server promises. The 180_000 advances only check that nothing more happens. A real-Date resourceSync backoff, if one arose, could only make a retry earlier, never later. risk: none
- **202** "beforeAll": TMO, controlled: no. **keep-accepted** (risk: low). A cold transform plus import of about 3-4 s alone, about 30 s at 9x, against 60 s. risk: low
- **572-674** "'module' aborts on 'close', cancels prefetch, and reports at its owning boundary": PERF/TMO, controlled: no. **rewrite:other(shrink the work, or split with a raised timeout)** (risk: med-high). Each case sends 401 assets as three full batches through the writer inside the default 5 s timeout; this one failed 2 of 3 overload runs after slice 7b. Owner sweep 9b. (new 2026-10-21, found by slice 7b) (fixed in slice 9b (0a6fb1aa5): the close cases send 3 assets, one request; the read/write/zip cases keep 401)
- **572-674** "'borrowed charx' aborts on 'close', cancels prefetch, and reports at its owning boundary": PERF/TMO, controlled: no. **rewrite:other(shrink the work, or split with a raised timeout)** (risk: med). Same 401-asset, three-batch send through the writer inside the default 5 s timeout; failed 1 of 3 overload runs after slice 7b. Owner sweep 9b. (new 2026-10-21, found by slice 7b) (fixed in slice 9b (0a6fb1aa5): the close cases send 3 assets, one request; the read/write/zip cases keep 401)

#### `src/ts/globalApiRetention.test.ts`

- **171-282,306-472** "held file sources": CLOCK, controlled: yes. **keep-det** (risk: low). The release grace is a setTimeout only (FILE_SOURCE_RELEASE_GRACE_MS), and setTimeout is faked. Lookups are deferreds. Date is not read on these paths. Risk: low

#### `src/ts/hotkey.test.ts`

- **526-636** "the preset hotkeys and Escape with the binding layers": CLOCK, controlled: yes. **keep-det** (risk: none). Aggregates the three alert-key tests. Each installs bare fake timers before opening the real alertStore queue and explicitly advances NEXT_DIALOG_GAP_MS; the promise resolves only for the dialog answered by the simulated stroke. The 150 ms production gap is controlled. (new 2026-10-21)

#### `src/ts/network/auxFetch.test.ts`

- **53 (settle at 92-418)** "settle": SLEEP, controlled: yes. **keep-det** (risk: low). settle = setTimeout(0) after in-process deferreds and mocked authFetch/resourceSync; no I/O; unhandledRejection is emitted before the next macrotask; risk low

#### `src/ts/network/eventFeed.test.ts`

- **81,104-326** "the live-update socket client": CLOCK, controlled: yes. **keep-det** (risk: none). fake setTimeout + Date; eventFeed.ts uses only setTimeout; Date.now in the JWT mock and the 6-minute loop read the faked clock (risk: none)

#### `src/ts/network/generationJobs.test.ts`

- **107-109,634,712,718,726,760,776** "flush": CLOCK, controlled: yes. **keep-det** (risk: none). The retry backoff is setTimeout-only (generationJobs.ts:462-464, no Date read), so faking setTimeout/clearTimeout controls it; flush/settled run over FakeSocket and mocked auth in-process; the attach stamp is forced monotonic (+0.001); risk none
- **870** "hands channel events to the lazily loaded dispatcher with the follow as transport, in socket order with the hydrations, and ends the channel on the terminal": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on the lazy import("./jobChannel"), a vi.mock factory module (in-process; at most a module-runner resolve); risk low

#### `src/ts/network/generationJobsDelta.test.ts`

- **56,125,128,143,176,201,220** "delta replies in the real tab mirror": CLOCK, controlled: yes. **keep-det** (risk: none). Timers faked without Date; the stream frame runs through happy-dom requestAnimationFrame = real setImmediate (BrowserWindow.js:2122), which runs in the check phase before advanceTimersByTimeAsync's original-setTimeout yield; resourceSync schedule() reads Date.now only within one synchronous step and no backoff path is hit; risk none
- **72 (boot), 119 (first test)** "boot": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2165 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4b (236531778): warmMutationGraph warms the graph in a 60 s beforeAll)

#### `src/ts/network/generationJobsPluginWork.test.ts`

- **85,144,184-189,273-293** "flush": SLEEP, controlled: yes. **keep-det** (risk: none). setTimeout(0) gives local promise chains a turn after explicit hook/auth/request resolutions or synchronous FakeSocket events. The channel module is mocked, as are auth, hydration and diagnostics; no real socket or module-heavy storage boot is awaited by these flushes. performance.now in attachStamp supplies a monotonic stamp only, with no asserted duration or deadline. (new 2026-10-21)

#### `src/ts/network/jobChannel.test.ts`

- **114,230,237,936,1173** "pump": CLOCK, controlled: yes. **keep-det** (risk: none). pump() advances fake timers, including the real alert queue now created per test with gapMs: 0. Question/notice ownership and cancellation use dialog handles; advancing the timer drives the inter-dialog gap. Provider chunk throttling reads Date.now only in the provider describe, which adds Date to toFake. Other Date.now reads are unconstrained emotion timestamps, not a deadline. (2026-10-21: dialog tests now use the real queue; its gap is explicitly driven by the existing fake timers)
- **235 (boot), 282 (first test)** "shows a question, answers it with the alert's raw value, and holds a toast, a modal notice, and the next question behind it": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: low-med). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 842 ms idle (one isolated run, Vitest JSON reporter) against the 10 s default hookTimeout (import in beforeEach); at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: low-med (fixed in slice 4b (236531778): warmModules loads the file's graph in a 60 s beforeAll)

#### `src/ts/network/jobChannelBarrier.test.ts`

- **83,95,193,220,225** "answered": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on in-process barrier work (flushResources straight to StoreBackedServer, no debounce timer); the callback's real Date.now()+60 s deadline is never read client-side
- **42-50,131-132** "runs the hook on the job's hydrated chat, in socket order despite the lazy dispatcher, without echoing the hydration back": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll with a 60_000 hook timeout)** (risk: high). boot() resets modules then calls bootMutations, which imports stores/resourceSync/chatStore/bootstrap and initializes the server store inside the test. There is no beforeAll warm-up. The first test took 2297.0 ms in one noisy isolated run; the default 5 s test timeout cannot cover about 9x CPU slowdown plus a 1-3 s deschedule. Preserve the real barrier/hydration assertions; warm the transform graph before resetting per-test state. (new 2026-10-21) (fixed in slice 4b (236531778): warmMutationGraph plus the lazily loaded jobChannel in a 60 s beforeAll)

#### `src/ts/network/pushNotifications.test.ts`

- **144-147** "settle": SLEEP, controlled: yes. **keep-det** (risk: low). 12x setTimeout(0) over mocked authFetch/registration promise chains (no I/O); REGISTRATION_TIMEOUT_MS 10 s races a pre-resolved ready, so the microtask wins deterministically (risk: low; the flush count is a guess)

#### `src/ts/observer.markers.test.ts`

- **31-37,48,58** "settle": CLOCK, controlled: yes. **keep-det** (risk: none). vi.useFakeTimers() with no toFake fakes Date too (observer.svelte.ts:165); happy-dom's real MutationObserver delivery is drained by takeRecords in settle() (risk: none)

#### `src/ts/observer.test.ts`

- **31-54,72** "flushMutations": CLOCK, controlled: yes. **keep-det** (risk: low). vi.useFakeTimers() fakes Date too (observer.svelte.ts:165); records are taken synchronously before any yield, so happy-dom's own real timer finds nothing; risk low

#### `src/ts/parser/tests/cbs/limits.test.ts` (2026-10-18 fixed file)

- **74-83** "the budget starts over for the next top-level parse": CLOCK, controlled: no. **rewrite:injected-clock(call stopClock() as the sibling tests do)** (risk: low). CLIENT_CBS_LIMITS reads the real performance.now (2 s per parse). toThrow(CbsLimitError) accepts either reason, but a 2 s stall inside a later tiny parse would throw (risk: low) (fixed in slice 2 (7a1a083ba): stops performance.now with stopClock())
- **50,61-72,85-95** "stopClock": CLOCK, controlled: yes. **keep-det** (risk: none). performance.now is stubbed to 0, so only the work limit can end the parse (risk: none)
- **103-108** "twenty-five sibling calls answer, genuine recursion stops with the error text": CLOCK, controlled: no. **rewrite:injected-clock(call stopClock() as the sibling budget tests do)** (risk: low). This existing call-depth case was omitted from the old rows. It invokes the real client parser without stopClock, so the 25 sibling calls and recursive-call error assertion inherit CLIENT_CBS_LIMITS maxMs: 2000 with a real performance.now. A deschedule inside evaluation may throw CbsLimitError instead of producing the expected text; stopping the clock preserves the recursion/stack contract. (new 2026-10-21) (fixed in slice 2 (7a1a083ba): stops performance.now with stopClock())

#### `src/ts/parser/tests/transformClient.test.ts`

- **184;189;416-418;666-668;692-707;723-725** "flush": CLOCK, controlled: yes. **keep-det** (risk: low). Bare vi.useFakeTimers() in beforeEach also fakes Date and performance, so the 16 ms batch timer and the 23/24/28 s deadlines move only with the advances; rAF is stubbed (risk: low)

#### `src/ts/parser/tests/trimMarkdownSharingStyles.test.ts`

- **37-71,92-102** "trimMarkdownSharingStyles": CLOCK, controlled: no. **rewrite:other(stop performance.now or inject a non-advancing CBS clock for style decoding)** (risk: med). Ordinary encoded styles are decoded through parser.svelte.ts decodeStyleContent, which calls real risuChatParser under CLIENT_CBS_LIMITS (2000 ms). A >2 s deschedule between its clock reads produces the decoder's fallback and changes the expected CSS/placeholder. Database/globalApi/stores mocks do not replace the parser's internal CBS evaluator. Raw STYLE and already-decoded style cases do not add another deadline. (new 2026-10-21) (fixed in slice 2 (7a1a083ba): stops the CBS performance clock for style decoding)

#### `src/ts/personaImport.test.ts`

- **158-160;233-235** "a collection replaced while the icon was being saved receives the persona (the add reads the live list)": POLL, controlled: yes. **keep-det** (risk: low). Both loops stop after a set number of turns (100 setImmediate / 100 fake 10 ms advances) with no wall-clock cap; the awaited work is in-process (mocked picker/readImage), so load cannot outrun them (risk: low)

#### `src/ts/plugins/apiV3/guestBridge.test.ts`

- **61-89,155-165** "startGuest": POLL, controlled: yes. **keep-poll** (risk: low). Bridge initialization responses are injected with queueMicrotask into the fake guest window; the SCRIPT_SETTLED positive checks also wait only on local promise work. vi.waitFor retains its real 1 s cap, but there is no real iframe or worker boot here. (new 2026-10-21)
- **101-150** "pulls a nativeFetch body from the host only when the plugin reads it": POLL, controlled: no. **rewrite:deferred** (risk: med). The marker, pull and second-pull assertions use vi.waitFor over Node MessageChannel deliveries. Those events need an event-loop delivery turn; a deschedule can exhaust the real 1 s poll cap before the queued port message arrives. Await matching message events through a listener/latch, preserving the useful FIFO marker check for no eager pull. Fake timers alone cannot deliver MessagePort events. (new 2026-10-21) (fixed in slice 8 (645e093c2): awaits delivery through latches and adds a third marker to catch a surplus pull)
- **93,168-172** "posts nothing while the plugin's top-level code is still pending": SLEEP, controlled: yes. **keep-det** (risk: none). The plugin's top-level await is an explicitly never-resolving promise. One zero-delay turn drains local startup continuations before the negative report check; it is not a guessed interval in which the plugin must finish. (new 2026-10-21)

#### `src/ts/plugins/apiV3/hostApi.test.ts`

- **702-725** "settle": SLEEP, controlled: partial. **rewrite:fake-timers** (risk: low). real 150 ms sleep vs production's real random 0-99 ms setTimeout (v3.svelte.ts:417); scheduled earlier with a shorter delay so it fires first even after a stall, and the SandboxHost is mocked (direct callback); deterministic but wall-clock; risk low (fixed in slice 9b (0a6fb1aa5): fake setTimeout with a 100 ms advance)

#### `src/ts/plugins/apiV3/mcpContext.test.ts`

- **53,208** "jobCallback": CLOCK, controlled: yes. **keep-det** (risk: low). Date.now feeds a mocked grant time and a callback deadline (+10 s) that no client code reads (no `deadline` consumer in src/ts/network, process/mcp, plugins); risk low

#### `src/ts/plugins/apiV3/nativeFetch.test.ts`

- **39** "getLastGrantTime": CLOCK, controlled: no. **keep-accepted** (risk: low). A real Date.now grant time against the 3-day periodic reconfirm window in v3.svelte.ts:693; the margin is 3 days (risk: low)

#### `src/ts/plugins/apiV3/nativeFetchAbort.test.ts`

- **145-146** "aborts the host fetch after headers while the guest is reading the body": POLL, controlled: partial. **rewrite:deferred** (risk: low-med). vi.waitFor (real 1 s cap) waits for a cancel crossing a node:worker_threads MessagePort, which is delivered in the event-loop poll phase after timers; a >1 s deschedule between postMessage and delivery times out; resolve a latch from the stream cancel instead; risk low-med (fixed in slice 8 (645e093c2): awaits port delivery through a latch)
- **195-227** "unread nativeFetch bodies expire": CLOCK, controlled: yes. **keep-det** (risk: none). Both new expiry cases fake setTimeout/clearTimeout and explicitly advance the 60,000 ms unread-body limit (59,999 + 1, or 10x after a pull). factory.ts clears/arms only those timers for unread expiry; it does not read Date/performance for this deadline. The fresh permission grant Date.now has a separate three-day margin. Port replies are awaited without a short elapsed assertion; the one bounded expiry-message poll is recorded separately. (new 2026-10-21)
- **204-208** "cancels a body the plugin never pulls from at 60 s and tells the plugin why": POLL, controlled: partial. **rewrite:deferred** (risk: low-med). The 60 s production timer is fake, but its expiry frame crosses a real node:worker_threads MessagePort before received is checked with vi.waitFor. Fake timers do not deliver that port message and vi.waitFor retains its real 1 s cap. Attach a one-shot message promise before advancing the deadline and await it directly; keep the fake-timer boundary assertions. (new 2026-10-21) (fixed in slice 8 (645e093c2): awaits expiry delivery through a latch)
- **246,266** "aborts a nativeFetch still waiting for headers, and bridges nothing when it resolves later": POLL, controlled: yes. **keep-poll** (risk: low). These waits observe a mocked fetch being entered and an in-process deferred fetch body being cancelled after unload. The late result creates zero MessageChannels (asserted), so these polls do not await a port delivery. The 1 s cap is the only real-time element of these waits. (new 2026-10-21)

#### `src/ts/plugins/apiV3/permissionStore.test.ts`

- **188** "keeps a newer copy this tab came to hold while the refresh's read was out": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor over the in-process FakeResourceServer; risk low

#### `src/ts/plugins/apiV3/permissions.test.ts`

- **100,131,264,344-360** "answers from a stored grant for that permission only; other permissions still ask": CLOCK, controlled: yes. **keep-det** (risk: none). Real Date.now grant times sit against a 3-day TTL (huge margin); the callback `deadline` is not read by the tab's channel; the periodic test fakes Date; risk none
- **228,268** "returns the aborted failure without calling the plugin when the request aborts while consent is pending": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on a mocked confirm/send over the in-process channel (SandboxHost mocked, flushResources spied); risk low

#### `src/ts/plugins/apiV3/pluginContext.test.ts`

- **852-905** "the replacers and the provider of a request get the request's context, the provider before its permission wait": POLL, controlled: partial. **rewrite:deferred** (risk: low-med). Under the overload (1 of 3 runs) the wait for the provider's permission prompt (then line 861) gave up with no prompt asked. Confirmed in slice 10: `vi.waitFor` has its own real 1 s default deadline, and under load `requestChatData` took longer than that to reach the prompt; the 60 s test timeout does not cover it (new 2026-10-22, found by slice 10) (fixed in slice 10 (this commit): `heldPrompts` holds each prompt on a deferred the test awaits (an early end of the request fails at once, an extra prompt is denied and counted, two asserted); it still fails when the provider's context is taken after the permission wait)
- **103-105;682;869** "makeApi": POLL, controlled: yes. **keep-poll** (risk: low). waitFor on mocked alertConfirm prompts; hasher is mocked, so there is no crypto/thread I/O; the 3-day grant window is as in nativeFetch (risk: low) (fixed in slice 10 (this commit): the four prompt polls, in "a read and a write keep the hook's preset across the database consent and the install prompt" and the provider test above, were bounded by `vi.waitFor`'s real 1 s; both tests now await the `heldPrompts` deferreds, and the read/write test still fails when `setDatabase` drops the hook's context)

#### `src/ts/plugins/apiV3/pluginContextSaved.test.ts`

- **73,115** "boot": CLOCK, controlled: yes. **keep-det** (risk: none). Timers faked without Date; getLastGrantTime returns now (always fresh); flushes are explicit; resourceSync's Date.now reads (schedule, backoff) are not hit across a fake-time advance; risk none
- **83 (boot), 131 (first test)** "boot": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2744 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4b (236531778): warmMutationGraph warms the graph in a 60 s beforeAll)

#### `src/ts/plugins/apiV3/pluginWorkIdle.test.ts`

- **147,152,214,218** "pluginWorkIdle": POLL, controlled: yes. **keep-poll** (risk: low). The default 1 s vi.waitFor cap covers in-process permission, provider and channel continuations, with consent/results on explicit deferreds, SandboxHost mocked, and flushResources stubbed for the channel case. The event's Date.now() + 10,000 deadline at 209 is not read by the client dispatcher; it is not a running client timeout. No worker is launched. (new 2026-10-21)

#### `src/ts/plugins/apiV3/sandboxActivity.test.ts`

- **47,94,125** "SandboxHost activity": POLL, controlled: yes. **keep-poll** (risk: low). Callback registration and guest-to-host RESPONSE polls wait on locally dispatched window events, explicit deferred resolutions and the stubbed guestWindow.postMessage. vi.waitFor's real default 1 s cap remains, but these particular response checks do not await delivery on a MessagePort. srcdoc and contentWindow are stubbed, so there is no real iframe boot. (new 2026-10-21)
- **131,155,182** "SandboxHost activity": POLL, controlled: no. **rewrite:deferred** (risk: med). The stream cancel/pull/rollback checks wait on real Node MessagePort event delivery under vi.waitFor's real 1 s cap. Await the port message or the activity-change notification that marks completion instead; synchronous guest-window injection does not control these ports' scheduler. node:worker_threads is used for MessageChannel/MessagePort only, not to start a worker. (new 2026-10-21) (fixed in slice 8 (645e093c2): awaits the three port deliveries through activity-change latches)
- **121-134** "is busy while a host stream bridged to the guest is open": CLOCK, controlled: no. **keep-accepted** (risk: low). The real factory arms UNREAD_PLUGIN_STREAM_TIMEOUT_MS = 60,000 while its host-to-guest body is unread. This test checks busy and cancels the body well inside the 5 s test/1 s poll bounds (12×/60× margins); it does not test the expiry. A fully controlled version would fake only timeout APIs and await port/activity events directly. (new 2026-10-21)

#### `src/ts/plugins/apiV3/sandboxStartup.test.ts`

- **24-26,50-55** "is pending until the guest reports, then ready": SLEEP, controlled: yes. **keep-det** (risk: none). The guest does not send SCRIPT_SETTLED until the test explicitly dispatches it. The real zero-delay marker only drains existing microtasks for the pending check; srcdoc and contentWindow are mocked. No real guest startup races the marker. (new 2026-10-21)
- **81-90** "is ready for a started guest whose host call is still open (not idle)": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor's real 1 s cap covers the local response continuation after headers.resolve; postMessage is a synchronous recording stub, and the host-call duration is held by a deferred. (new 2026-10-21)

#### `src/ts/plugins/apiV3/v3SavedWrites.test.ts`

- **100,105,245** "settled": CLOCK, controlled: yes. **keep-det** (risk: none). Timers faked without Date; the 500 ms debounce is setTimeout-based with the delay computed within one step; no failure or backoff; the 2000 ms advance is a negative check; risk none
- **78 (boot), 121 (first test)** "boot": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2375 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4b (236531778): warmMutationGraph warms the graph in a 60 s beforeAll)

#### `src/ts/plugins/apiV3/v3SetPersonas.test.ts`

- **249** "reaches the live list: the push runs after the image is saved, on the collection of that moment": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor until the mocked saveAsset is reached; PngChunk, reencodeImage and the file picker are mocked, in-process; risk low

#### `src/ts/plugins/pluginDeferredReload.test.ts`

- **71-72,82-244** "settle": SLEEP, controlled: yes. **keep-det** (risk: none). Real setTimeout(0) flushes queueMicrotask and the pluginReload promise chain over a mocked loader/idle predicate/listeners. Held work and loader completion are explicit flags/deferreds; no production idle timeout or real sandbox startup has to complete during the flush. (new 2026-10-21)

#### `src/ts/plugins/pluginLifecycle.test.ts`

- **48,266** "removes disabled and deleted providers, including registrations made during unload": SLEEP, controlled: yes. **keep-det** (risk: none). setTimeout(0) before a negative check over a mocked sandbox factory; getLastGrantTime Date.now only feeds a 3-day reconfirm window

#### `src/ts/plugins/pluginSafeBoot.test.ts`

- **66-74,91-96** "resolves true at once without plugins": BOOT, controlled: no. **rewrite:other(warm the settings, fixture and plugins module graph in a 60 s beforeAll before retaining per-test resetModules)** (risk: high). fresh resets modules and dynamically imports settingsViews, installFlatDatabase and plugins.svelte inside each test; the partial resourceSync mock imports the real storage graph too. The first test took a noisy 2150.9 ms in the permitted single-file run, later tests 20.5-85.3 ms. The first cold load is still inside the default 5 s budget and is a direct cause-1 sibling. (new 2026-10-21) (fixed in slice 4b (236531778): warmModules loads the settings views, fixture and plugins in a 60 s beforeAll; the resourceSync partial mock became a per-test vi.spyOn)
- **29-45,60-63,98-111,153-239** "pending": SLEEP, controlled: yes. **keep-det** (risk: none). Aggregates the fake loader's zero-delay turn and settle/pending markers. Startup completion is explicitly delivered with host.settle or withheld; pending is checked after awaiting the load that established the held guest. The replacement chain cannot finish correctly before the test's explicit signal. No real iframe or plugin-work idle deadline is running. (new 2026-10-21)
- **114-131** "judges the guests its own load started, not what a reload applied while the boot still waited": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor's default real 1 s cap observes the fake loader's local zero-delay turn. crypto.subtle.digest is held by a test-owned deferred callback, so the poll does not race WebCrypto completion; it asserts that the old guest's failure survives a later reload. (new 2026-10-21)

#### `src/ts/process/chatStatus.test.ts`

- **101,324** "attach": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on a stubbed follow registered through in-process promise chains (sleep is mocked to resolve at once). Risk: low
- **116 (boot), 163 (first test)** "generating reacts to the union of followed chats and real server locks": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: med). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1267 ms idle (one isolated run, Vitest JSON reporter) against the 10 s default hookTimeout (import in beforeEach); at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: med (fixed in slice 4b (236531778): warmModules loads the file's graph in a 60 s beforeAll)

#### `src/ts/process/files/tests/inlays.test.ts`

- **105,283-297** "serves a seeded id without a request and a miss from the negative cache until it expires": CLOCK, controlled: yes. **keep-det** (risk: low). toFake: ["Date"] is installed after imports. MISSING_ID_TTL_MS compares Date.now, and setSystemTime advances it by 31 s; no real sleep expires that TTL. The new image URL/decode cases stub image completion, decode, canvas, and storage and add no production timer. The hook cold-import cost is recorded separately. (2026-10-21: fully checked the added one-shot URL cases; separated the previously understated cold-import exposure)
- **97-106,114-115** "stores the bytes under their content hash and the metadata under the id": BOOT, controlled: no. **rewrite:other(warm the inlays/resource-client graph in beforeAll with a 60_000 hook timeout)** (risk: med). Every beforeEach does resetModules plus dynamic imports of resourceClient and inlays (including its settings/records graph); there is no beforeAll warm-up, and faking Date happens only afterwards. One noisy isolated run put the first case including its hook at 1113.9 ms, versus roughly 12-28 ms thereafter. At 1/9 CPU plus a deschedule the cold hook can exceed the default 10 s hook timeout. The TTL fake clock does not control module loading. (new 2026-10-21) (fixed in slice 4b (236531778): warmModules loads the file's graph in a 60 s beforeAll)

#### `src/ts/process/imageDelivery.test.ts`

- **255** "preserves newer CharEmotion writes while every backend awaits its image, including NovelAI ZIP processing": POLL, controlled: yes. **keep-poll** (risk: none). vi.waitFor (1 s) on `reached`. Every transport is mocked in-process, and comfy /history and wavespeed /result answer done on the first call, so the real 1 s/3 s poll sleeps in stableDiff.ts:577/867 are never reached. risk: none
- **116-128,166** "replaces the displayed image with Imagen through stableDiff and returns an empty string": CLOCK, controlled: yes. **keep-det** (risk: none). The real Date.now range check is monotonic only. The callback deadline of Date.now()+10_000 covers in-process work (10 s margin). risk: none

#### `src/ts/process/lorebookImport.test.ts`

- **101-105** "beforeAll": TMO, controlled: partial. **keep-accepted** (risk: low). A cold import under a 60_000 hook timeout (about 24x margin), so the in-test boots stay small. Risk: low

#### `src/ts/process/lorebookRegexBaseline.test.ts`

- **96** "beforeAll": TMO, controlled: no. **keep-accepted** (risk: low). A cold compile of about 2.5 s alone against 60 s. The only test takes 0.39 s. risk: low

#### `src/ts/process/mcp/risuaccess/tests/characters.test.ts`

- **101-130,157** "boot": TMO, controlled: no. **rewrite:other(warm the module graph in beforeAll with a raised hook timeout, and raise the per-test timeout)** (risk: high). boot() = resetModules + bootMutations cold dynamic imports inside the test under the default 5 s; measured 2764 ms idle for the first case, 170-290 ms for later ones (risk: high for the first, med for the rest) (fixed in slice 4b (236531778): warmMutationGraph warms the graph in a 60 s beforeAll; the raised per-test timeout was not needed, and the later cases that timed out in the baseline passed all 6 overload runs)
- **142** "boot": CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/interval faked; no Date-based TTL/backoff path asserted (risk: none)

#### `src/ts/process/mcp/risuaccess/tests/moduleWriters.test.ts`

- **105 (boot), 167 (first test)** "boot": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2399 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4b (236531778): warmMutationGraph warms the graph in a 60 s beforeAll; a CPU-bound later case is the new row below)
- **292-303** "to an MCP module or an unknown id, for every write tool, without a prompt": PERF, controlled: no. **rewrite:other(shrink the work, or split with a raised timeout)** (risk: med). CPU-bound inside the default 5 s timeout after graph warm-up: about 395 ms idle (the per-test reset and boot, then 2 x N write calls that each serialize the mirror and the server twice); failed 1 of 3 overload runs after slice 4b. Near the limit too: risuaccess `characters` "when a field is unknown or inherited..." and "when the user denies the consent prompt..." (about 290 ms idle), and this file's "when an info field has the wrong type..." (about 280 ms). Owner slice 7b or sweep 9b. (new 2026-10-21, found by slice 4b) (fixed in slice 7b (45b6309bf): the same per-call check through a local `unchangedEach`; the near-limit neighbours named here, this file's "when the user denies the consent prompt..." and "when an info field has the wrong type..." and risuaccess `characters` "when the user denies the consent prompt..." and "when a field is unknown or inherited...", were rewritten the same way)

#### `src/ts/process/mcp/tests/mcpLeases.test.ts`

- **71-75** "settleMicrotasks": SLEEP, controlled: yes. **keep-det** (risk: low). A microtask-count flush over fake MCP clients with gate promises; no timers or I/O, so the result does not depend on CPU load (a wrong count fails every time) (risk: low)

#### `src/ts/process/mcp/tests/mcpWriters.test.ts`

- **158** "boot": CLOCK, controlled: yes. **keep-det** (risk: low). toFake omits Date, but these tests only flush explicitly (flushResources) and never advance timers or hit a backoff/job-retry path; risk low
- **133 (boot), 175 (first test)** "boot": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2783 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4b (236531778): warmMutationGraph plus mcp, googlesearchclient and the lazily loaded risuaccess in a 60 s beforeAll)

#### `src/ts/process/mcp/tests/mcplib.test.ts`

- **118-123** "until": POLL, controlled: yes. **keep-det** (risk: none). Count-bounded loop (200 x setTimeout 5 ms), with no wall-clock deadline, over a mocked fetch and in-memory streams; slower ticks do not change the outcome; risk none

#### `src/ts/process/mcp/tests/mcplibStreams.test.ts`

- **122-125** "until": POLL, controlled: yes. **keep-det** (risk: none). until() is bounded by 200 microtask turns, not time; mcplib has no timers or clock reads

#### `src/ts/process/modulesImport.test.ts` (**heap-memory-reduction merged 2026-10-20**)

- **219-234,471,556,573,669-699,802-815,937,962** "boot": CLOCK, controlled: partial. **keep-det** (risk: low). toFake has no "Date". resourceSync.schedule computes deadline and backoffUntil with the real Date.now (resourceSync.svelte.ts:462-474,1416), so after a failure the fake 35 s advance does not reach the backoff in real terms. The explicit flushResources() afterwards forces the save, so the outcome does not depend on the clock, and load only lets the real backoff expire sooner. Adding "Date" to toFake would make it exact, as resourceSyncNotices does. risk: low
- **151** "beforeAll": TMO, controlled: no. **keep-accepted** (risk: low). A cold graph compile of about 3-4 s alone, about 30 s at 9x, against 60 s. Per-test boots (resetModules) take at most 0.38 s against the default 5 s. risk: low

#### `src/ts/process/modulesImportPrepare.test.ts`

- **125-129** "beforeAll": TMO, controlled: partial. **keep-accepted** (risk: low). A cold import under a 60_000 hook timeout (about 24x margin). Risk: low

#### `src/ts/process/request/tests/transport.test.ts`

- **215-217,946** "flushTick": SLEEP, controlled: yes. **keep-det** (risk: low). a setTimeout(0) race decides "pending" only while a deferred holds the signature save; in-process stubs; the 500 ms answer-retry sleep in transport.ts is never reached (answers stubbed ok) (risk: low)

#### `src/ts/process/serverCommands.test.ts`

- **158,310-331** "flush": CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout(0) flushes over fully mocked follows and sync; the restore-watch timestamp test fakes Date (setSystemTime); risk none
- **168 (boot), 204 (first test)** "shares one lifecycle per job: two callers get one socket and the same terminal, applied once, with no release or alert for `done`": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: low-med). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 848 ms idle (one isolated run, Vitest JSON reporter) against the 10 s default hookTimeout (import in beforeEach); at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: low-med (fixed in slice 4b (236531778): warmModules loads the file's graph in a 60 s beforeAll)

#### `src/ts/process/ttsHooks.test.ts`

- **57-66** "isolates a hook that exceeds the timeout": SLEEP, controlled: partial. **rewrite:fake-timers** (risk: none). runHookPipeline races the hook against a real sleep(timeoutMs); fast hooks win by microtask, the never-resolving one loses after a real 50 ms; correct under load, only slow; risk none (fixed in slice 9b (0a6fb1aa5): fake timers; the hook is pending at 49 ms and settled at 50 ms)

#### `src/ts/process/ttsPlayback.test.ts`

- **214,234,259,272** "sayTTS and stopTTS": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor (1 s cap) on mocked in-process calls; deferreds gate the rest; util.sleep mocked (risk: low)

#### `src/ts/router/router.test.ts`

- **1615** "traverses by key and swallows the rejections and a synchronous failure": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) after a synchronous traverse; Node emits unhandledRejection after the microtask drain and before the timer (risk: low)

#### `src/ts/safeBoot.test.ts`

- **39-79,111-239** "harness": CLOCK, controlled: yes. **keep-det** (risk: none). createSafeBoot receives an injected numeric now and a timer recorder; advance/fire control both the guest deadline and the settle callback. The exact-at-deadline and one-ms-late cases exercise the boundary without real time. The default singleton is used only for URL/error helpers, not boot timing. (new 2026-10-21)
- **69-78,135,178,190,204,213,224** "flush": SLEEP, controlled: yes. **keep-det** (risk: none). A real zero-delay turn flushes the guest-promise continuation before manually firing the recorded settle timer. Both outcomes are driven by injected time/explicitly resolved or withheld promises; there is no elapsed-time synchronization window or bounded I/O poll. (new 2026-10-21)

#### `src/ts/setting/settingJump.test.ts`

- **40-51,132-151** "scrolls the row's first child with a box into view and rings it until the timer runs": CLOCK, controlled: yes. **keep-det** (risk: none). Bare fake timers drive the 1999 + 1 ms highlight boundary after the awaited Svelte tick. The test checks the actual first boxed child and observable scroll/ring behavior. (new 2026-10-21)
- **181-198** "scrolls the section's wrapper into view and rings it; a box-less wrapper is left alone": CLOCK, controlled: yes. **keep-det** (risk: none). The same fake timer controls SETTING_HIGHLIGHT_MS for a section; hidden/stale cases are checked synchronously after the tick rather than with a real sleep. (new 2026-10-21)

#### `src/ts/storage/tests/assetQueue.test.ts`

- **19,31,87,209** "saveAssets" / "AssetSaveQueue": CLOCK, controlled: yes. **keep-det** (risk: low). full vi.useFakeTimers() with deferreds; globalApi mocked so assetClient's Date.now retry-after is never reached; risk low

#### `src/ts/storage/tests/assetReadQueue.test.ts`

- **120,147** "%s cancels and settles the prefetch before completing, without reading another batch" / "observes a rejected prefetch immediately and throws it at the next batch await": SLEEP, controlled: yes. **keep-det** (risk: low). setTimeout(0) after in-process async-iterator promise chains with a deferred read (no I/O) (risk: low)

#### `src/ts/storage/tests/bootCache.test.ts`

- **890-893** "an open that never answers falls back as `timeout` within the bound, and a connection that arrives later is closed": DUR, controlled: no. **rewrite:fake-timers(fake setTimeout only, keeping setImmediate real; assert pending before 20 ms and `timeout` after advancing 20 ms; drop the elapsed check)** (risk: high). Real 20 ms open timeout plus expect(Date.now() - started).toBeLessThan(1000); a 1 s stall anywhere in loadBootSnapshot fails it; risk high (fixed in slice 6b (56c228579): fake setTimeout/clearTimeout check one ms before and at both the default and an explicit 20 ms bound; the elapsed check is gone)
- **750,790,819,914,927,947,967,1005,1033,1061,1083,1101,1119,1149,1151,1164,1172,1207** "the boot over the IndexedDB cache": CLOCK, controlled: no. **rewrite:other(pass a large timeoutMs, e.g. 60_000, where the timeout is not the subject)** (risk: med). The default BOOT_CACHE_TIMEOUT_MS is still 3000 ms for openDatabase and withTimeout around cache reads (bootCache.ts:383,418,466,524). Eighteen constructor sites in sixteen IndexedDB-using tests race real timers against fake-indexeddb's setImmediate callbacks; a stall can produce timeout instead of the expected success or readFailed/incomplete/format path. Pass a large explicit timeout where expiry is not the subject. The no-IndexedDB case at 868 rejects before installing a timer and is excluded. (2026-10-21: timers are unchanged; corrected the old aggregate's reach, excluding the unavailable case and counting the repeated v1/v2 constructors) (fixed in slice 6b (56c228579): a `cacheStore()` helper passes a 60 s bound; the no-IndexedDB case keeps the default)
- **49,985,1250,1262** "tick" / "the idle commit": SLEEP, controlled: yes. **keep-det** (risk: none). Count-bounded setTimeout(0) loop over fake-indexeddb (setImmediate-scheduled, in-process); requestIdleCallback is stubbed; event-loop order, not speed, decides; risk none

#### `src/ts/storage/tests/bootSnapshot.test.ts`

- **98 (boot), 136 (first test)** "differs only in ids and the id selections": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2795 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/browserLocalImport.test.ts`

- **152-187,195** "beforeEach": BOOT, controlled: no. **rewrite:raise-timeout** (risk: med). vi.resetModules plus a cold import of resourceSync/bootstrap in beforeEach under the default 10 s hookTimeout. The first case takes 2.3 s idle (about 4x margin). Add a warm beforeAll(..., 60_000) as the sibling files do. Risk: med (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/characterNormalization.test.ts`

- **183-185,245-257,489,700-706** "boot" / "recognizes a chat create whose answer was lost (the server's defaults included) instead of a conflict": CLOCK, controlled: partial. **keep-det** (risk: low). toFake omits Date and resourceSync schedule()/backoffUntil read real Date.now; at 698 the dropped answer sets backoffUntil = now+2000 and the retry timer's delay in one sync step, so the fake 1500 advance stays below it whatever real time does; creation_date >= started is monotonic; 487 vi.waitFor in-process; risk low
- **79 (boot), 233 (first test)** "prepares a chatless character once: its first chat, the greeting index, the note transfer, the time, the lore, the TTS mode; the input is untouched": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2227 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/characterOrderRepair.test.ts`

- **51;195;208;237;262;276;296;318;331;343** "awaitReads" / "queueRemoteCharOrderRepair": POLL, controlled: yes. **keep-poll** (risk: low). Real timers, readRefs mocked as a queue of deferreds; the repair runs from queueMicrotask with no timers, so the waits are in-process (risk: low)

#### `src/ts/storage/tests/characterOwnership.test.ts`

- **271,312-389** "the boot's trash pruning (removeCharacters)": CLOCK, controlled: partial. **keep-det** (risk: none). trash expiry compares real Date.now against days-scale offsets (4 days vs 3 days); the 3000 ms fake advance is a negative check; risk none
- **52 (boot), 80 (first test)** "save one op each on the held revision: a wrapper write, a nested wrapper write, and updateCharacter": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2187 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/characterStore.test.ts`

- **65** "sends a non-selected character's record in the next cycle with only the patched field changed": PERF, controlled: no. **rewrite:other(beforeAll warm import, 60 s hook timeout)** (risk: high). Same cold first boot inside the test: 2.36 s alone against the default 5 s. Later tests take 0.3-0.46 s. risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **275-303** "refuses a root that is not a plain object, or a non-JSON field next to the key, and changes nothing": PERF, controlled: no. **rewrite:other(shrink the work, or split with a raised timeout)** (risk: high). CPU-bound validation inside the default 5 s timeout after graph warm-up still failed 3/3 overload runs; owner slice 7b or sweep 9b. (new 2026-10-21, found by slice 4a) (fixed in slice 7b (45b6309bf): `refusedEach` in `mutationStoresHarness.ts` compares the full mirror with its start after every call, then checks the flush, the server text and the batch count once)
- **80-113** "refuses the fixed fields, prototype names, and non-data values, and changes nothing": PERF, controlled: no. **rewrite:other(shrink the work, or split with a raised timeout)** (risk: med). CPU-bound validation inside the default 5 s timeout after graph warm-up still failed 1/3 overload runs; owner slice 7b or sweep 9b. (new 2026-10-21, found by slice 4a) (fixed in slice 7b (45b6309bf): `refusedEach` in `mutationStoresHarness.ts` compares the full mirror with its start after every call, then checks the flush, the server text and the batch count once)

#### `src/ts/storage/tests/charxImportClient.test.ts`

- **37** "uploads the original Blob once and streams %i progress lines before the UTF-8 result": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on onProgress fed by a test-controlled in-memory ReadableStream (risk: low)

#### `src/ts/storage/tests/chatBinding.test.ts`

- **68 (boot), 189 (first test)** "reads as undefined (never the tab's selection) and refuses a patch as setChatMeta does": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1988 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/chatBindingNewChat.test.ts`

- **192** "inherits from the character's selected chat, unloaded and without a read, else from its first chat; a chatless or unknown character gives nothing": PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout, as characterCardsPngImport does)** (risk: high). The first test pays the cold vi.resetModules + bootMutations import of the whole storage graph in the default 5 s: 2038 ms isolated when idle, so about 18 s at 1/9 CPU; later tests take about 50 ms (risk: high) (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/chatBindingPick.test.ts`

- **88 (boot), 166 (first test)** "at home an undefined target is the tab's selection, per field; a gone record changes nothing": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1881 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/chatBindingReaders.test.ts`

- **104** "read the ref's bound persona, else the tab's; a background chat never gets the selected chat's; a captured ref holds after a switch": PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold module-graph boot in the first test: 2688 ms isolated when idle, in the default 5 s (risk: high) (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/chatBindingViews.test.ts`

- **199** "beforeEach": CLOCK, controlled: yes. **keep-det** (risk: low). toFake omits Date, but no test advances timers or reaches a Date-based sync path (views/binding reads only); risk low
- **142 (boot), 212 (first test)** "the selected chat's bound records win per field; the tab's selection and the chat are not written": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1827 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/chatLazyLoading.test.ts`

- **222,250** "runTrim" / "beforeEach": CLOCK, controlled: yes. **keep-det** (risk: none). The trim is a setTimeout(0) (chatStore.svelte.ts:5309) run by runOnlyPendingTimers; no test hits the Date.now-based JOB_RETRY_MS block (chatStore 1797/3992) or the sync backoff; held reads use a gate/deferred; risk none
- **89 (boot), 266 (first test)** "exposes a persisted pin in list entries before and after loading the chat": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1882 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/chatProjection.test.ts`

- **89-92** "beforeAll": TMO, controlled: partial. **keep-accepted** (risk: low). A cold import under a 60_000 hook timeout (about 24x margin). Risk: low

#### `src/ts/storage/tests/chatStore.test.ts`

- **185** "updates the mirror synchronously from detached copies of the input and the anchor": PERF, controlled: no. **rewrite:other(warm the module graph in a beforeAll with a 60 s hook timeout, as characterCardsImport does)** (risk: high). No warm-up: the first test's boot (vi.resetModules plus dynamic import of the storage graph) takes 1.8 s alone against the default 5 s timeout. About 9x under 1 CPU + 8 burners, so it times out. In a full run the transforms may already be cached, which lowers but does not remove this. risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **173,1665-1756** "stream updates per frame": CLOCK, controlled: yes. **keep-det** (risk: none). requestAnimationFrame callbacks are captured and invoked by hand; setTimeout/clearTimeout are fake, and the hidden-tab fallback is tested with advanceTimersByTime(249) then (1). chatStore's 250 ms frame fallback reads no Date clock. A wrong implementation that writes every chunk immediately, overwrites a new generation with a stale frame, or never flushes in a hidden tab would fail. This controlled pattern existed at the inventory baseline but lacked its own row. (new 2026-10-21)

#### `src/ts/storage/tests/collectionStore.test.ts`

- **40-47,68-580** "boot": TMO, controlled: no. **rewrite:other(warm the module graph in beforeAll with a raised hook timeout, and raise the per-test timeout)** (risk: high). cold dynamic imports inside the first test under the default 5 s: measured 2209 ms idle; later re-evaluations 50-506 ms idle, ~9x under 1/9 CPU share (risk: high for the first, med for the rest) (partly fixed in slice 4a (7d52aa936): warm-up landed via warmMutationGraph and StoreBackedServer.preload in a 60 s beforeAll; still open: the CPU-bound credentials/persona/selection refusal still fails 3/3 overload runs) (fixed in slice 7b (45b6309bf): the refusal is fixed through `refusedEach`)
- **52** "beforeEach": CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/interval faked; Date-based backoff/JOB_RETRY paths in resourceSync not exercised by assertions (risk: none)
- **195-224** "refuses credentials, persona and selection keys, unknown keys, wrong kinds, and non-data values": PERF, controlled: no. **rewrite:other(shrink the work, or split with a raised timeout)** (risk: high). CPU-bound validation inside the default 5 s timeout after graph warm-up still failed 3/3 overload runs; owner slice 7b or sweep 9b. (new 2026-10-21, found by slice 4a) (fixed in slice 7b (45b6309bf): `refusedEach` in `mutationStoresHarness.ts` compares the full mirror with its start after every call, then checks the flush, the server text and the batch count once)

#### `src/ts/storage/tests/moduleCache.test.ts` (2026-10-18 fixed file; **heap-memory-reduction modifies this file**)

- **112-129** "resolves a remote replacement immediately and wakes tracked readers without reading displaced wrappers": TMO, controlled: no. **rewrite:raise-timeout** (risk: high). first case pays the cold vi.resetModules + bootMutations graph import (2.54 s idle) under the DEFAULT 5 s timeout; the same cold boot needed 60 s in resourceSyncFieldCache under the overload; risk high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **294-319** "enables a large module's assets in one flush and reuses their plain copy after toggling": PERF, controlled: no. **rewrite:raise-timeout** (risk: med-high). The explicit <300 ms check remains absent, but building, installing and toggling the 100,000-asset module still runs under the default 5 s timeout. Frozen asset leaves and identity reuse changed the reached implementation; the inventory's 765 ms measurement is historical, not a current cost estimate. The identity assertion catches rebuilding an unchanged aggregate without needing a time limit. Retain this size only for an identified large-input failure (such as a spread/stack limit); otherwise shrink it, or raise the integration budget. (2026-10-21: heap-memory-reduction changed asset representation/cache costs; the 100k fixture and implicit 5 s budget remain) (partly fixed in slice 4a (7d52aa936): warm-up landed; still open: the large fixture still fails 3/3 overload runs, slice 7b) (fixed in slice 7b (45b6309bf): renamed from "enables 100k assets in one flush and reuses their plain copy after toggling"; 5,000 assets)
- **131-292,322-408** "module membership cache" / "module asset cache" / "module reloads": TMO, controlled: no. **rewrite:raise-timeout** (risk: low). These cases still reset modules and boot the storage graph inside each default-5 s test, with no beforeAll warm import. The membership and asset-cache cases now replace whole frozen asset lists, check frozen tuple/plain-list identity, and retain unchanged tuples across edits; a cache that stays stale after an enabled asset replacement or needlessly rebuilds unrelated aggregates would fail. Those deterministic guards are useful, but their boot is still raced against the wall timeout. The old 64-245 ms warm timings were not repeated. (2026-10-21: asset edits and cache assertions now exercise whole-list frozen leaves after the heap-memory merge) (fixed in slice 4a (7d52aa936): warms membership, asset and reload graphs before the tests)
- **101** "beforeEach": CLOCK, controlled: yes. **keep-det** (risk: none). setTimeout/setInterval faked without Date; modules/collectionStore paths read no clock and the tests call flushResources/flushSync directly; risk none

#### `src/ts/storage/tests/moduleImportClient.test.ts`

- **40,89-108** "importModuleOverServer": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on an in-process web ReadableStream parse; the no-retry cases run under full fake timers (180 s advance); risk low

#### `src/ts/storage/tests/mutationScope.test.ts`

- **50,77,78,115,116** "reports a discard raised by a cycle that ran before the flush was called, which a plain flush does not" / "covers the chat discard sequence too: a chat conflict before the flush is reported with the scope": POLL, controlled: yes. **keep-poll** (risk: low). A fake 600 ms advance fires the 500 ms debounce (delay computed within one step, so real Date does not matter); vi.waitFor advances fake timers and polls the in-process fake server; risk low
- **40 (boot), 71 (first test)** "reports a discard raised by a cycle that ran before the flush was called, which a plain flush does not": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2298 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/personaModuleLinks.test.ts`

- **66 (boot), 118 (first test)** "adds the bound persona's links by id only, once each, in stored order, MCP modules excepted; the legacy lists still match namespaces": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2635 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/personaViews.test.ts`

- **338,357,386** "writes the icon into the persona that was selected when the dialog opened, keeping its id, even after a switch" / "drops the icon when that persona was deleted meanwhile, never redirecting it; a cancelled dialog changes nothing" / "pushes the imported persona into the live list even when the collection was replaced while its image was being saved": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor until the mocked saveAsset; picker, PngChunk and reencodeImage are mocked, in-process; risk low

#### `src/ts/storage/tests/pluginStorageStore.test.ts`

- **66;89** "sets, reads a detached copy, lists, removes, and clears, with every write saved" / "refuses a value that is not JSON data and changes nothing": PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). First test cold boot 2329 ms when idle; the second does 13 refused flushes in 432 ms of CPU (about 3.9 s at 1/9 CPU), both in the default 5 s (risk: high / med) (partly fixed in slice 4a (7d52aa936): warm-up landed in a 60 s beforeAll; still open: the non-JSON-value refusal still fails 3/3 overload runs) (fixed in slice 7b (45b6309bf): the refusal is fixed through `refusedEach`)
- **91-111** "refuses a value that is not JSON data and changes nothing": PERF, controlled: no. **rewrite:other(shrink the work, or split with a raised timeout)** (risk: high). CPU-bound validation inside the default 5 s timeout after graph warm-up still failed 3/3 overload runs; owner slice 7b or sweep 9b. (new 2026-10-21, found by slice 4a) (fixed in slice 7b (45b6309bf): `refusedEach` in `mutationStoresHarness.ts` compares the full mirror with its start after every call, then checks the flush, the server text and the batch count once)

#### `src/ts/storage/tests/projectionBindings.test.ts`

- **1974-1978,2011-2012** "1,000 sequential nested writes into the 300-entry character: one serialization per flush; tracked modes against direct $state writes": PERF, controlled: no. **move-slow** (risk: low-med). the median ratio of tracked vs direct write time (real performance.now over 9 rounds) must be < 10; cost is the subject, and direct is a sub-ms sample that load noise can distort; also runs execSync("uname -a") for the report (risk: low-med) (fixed in slice 1 (40ab0dce4): split gated contract from slow benchmark, including its execSync("uname") boot)
- **287,1442,1470,1717** "stays dirty after the ack; the next flush sends it on the acknowledged revision and the server takes both edits" / "a newer remote record is not applied while its record's batch is in flight, even with the text back at the saved text" / "a removed wrapper fails loudly once its task has ended; nothing changes": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on in-process held batch (releaseBatch); nextTask setTimeout(0) only closes the same-task window
- **2101-2140** "bulk: the lorebook drag rebuild and the preset reorder, tracked modes against direct $state": PERF, controlled: no. **move-slow** (risk: high). CPU-bound nine-round benchmark under the default 5 s timeout failed an overload run; split into one gated round per mode and a nine-round slow report. (new 2026-10-21, found by slice 1) (fixed in slice 1 (40ab0dce4))

#### `src/ts/storage/tests/recordNodePruning.svelte.test.ts`

- **260-268** "replaceRecordList shrinking a root list: the kept element's wrapper stays, the dropped one's throws after the task": SLEEP, controlled: yes. **keep-det** (risk: none). The zero-delay turn waits for the records module's same-task displaced-wrapper cleanup, which is queued in microtasks/Svelte ticks. It does not infer GC or heap retention from elapsed time. Other pruning tests await tick/flushSync directly; the small plain records graph is statically imported. (new 2026-10-21)

#### `src/ts/storage/tests/records.test.ts` (**heap-memory-reduction modifies this file**)

- **40,77,104** "array mutators": SLEEP, controlled: yes. **keep-det** (risk: none). The displacement expires through queueMicrotask (records.svelte.ts:1196), so setTimeout(0) always outlasts it; risk none

#### `src/ts/storage/tests/resourceSync.test.ts`

- **132** "writes nothing after boot when the mirror equals the server": PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold resetModules boot of resourceSync and the stores in the first test: 2297 ms isolated when idle, in the default 5 s (risk: high) (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **235;281** "keeps an edit made while its batch is in flight dirty and saves it in the next cycle" / "saves a character added while a batch is in flight without another edit": POLL, controlled: partial. **rewrite:fake-timers** (risk: med). The next save cycle is the 500 ms DEBOUNCE fake timer. vi.waitFor advances fake time only 50 ms per real 50 ms poll, so it needs 10 polls (measured about 600 ms) inside a 3000 ms real cap; each deschedule costs polls. Use advanceTimersByTimeAsync(500), then assert (risk: med) (fixed in slice 9b (0a6fb1aa5): advances fake time by the save debounce, `SAVE_DEBOUNCE_MS` in `mutationStoresHarness.ts`, then asserts)
- **228;244;277;418;563;643;693;804** "dirty generations" / "membership" / "a generating character (the generation deferral is gone)" / "restore (412) and errors" / "the restore watch of a job ended by maintenance": POLL, controlled: yes. **keep-poll** (risk: low). The work is in-process (fake server, held batch, queueMicrotask repair, mocked alertTerminal); it settles in one or two polls (about 45 ms), so a deschedule still leaves the interval to fire before the cap (risk: low)
- **785-804** "keeps waiting through old-epoch answers, a 503, and a network failure, then halts with the notice and the reload once the epoch changes": CLOCK, controlled: partial. **keep-accepted** (risk: low). watchForRestore's 120 s deadline and its 5 s read budget read the real Date.now (Date is not faked here, unlike line 776); the margin is about 120 s against a run of under 1 s. Adding "Date" to toFake would make it exact (risk: low)
- **688-857** "restore (412) and errors" / "the restore watch of a job ended by maintenance": CLOCK, controlled: yes. **keep-det** (risk: low). 413/400 failures leave backoffUntil 0 (no real-clock backoff); line 776 also fakes Date for the watch deadline; flushResources ignores backoff (risk: low)

#### `src/ts/storage/tests/resourceSyncAbsentSingleton.test.ts`

- **93,112-162** "beforeEach": CLOCK, controlled: yes. **keep-det** (risk: none). toFake without Date, but no failure/backoff or job-retry path is reached (backoffUntil stays 0)
- **56 (boot), 109 (first test)** "adopts the first remote creation from the live update and updates it with the next local write": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2449 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/resourceSyncChats.test.ts`

- **147** "hydrates the chats without echoing anything back, and keeps chats out of the character record": PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold module-graph boot in the first test: 2438 ms isolated when idle, in the default 5 s (risk: high) (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **235;271** "renames a message id the server refuses and redirects the edit queued meanwhile" / "keeps a chat edit made during a request queued and sends it in the next cycle": POLL, controlled: partial. **rewrite:fake-timers** (risk: med). Waits for the 500 ms debounced next cycle by vi.waitFor's 50 ms fake advance per real poll (measured 601/619 ms) inside a 3000 ms real cap (risk: med) (fixed in slice 9b (0a6fb1aa5): advances fake time by `SAVE_DEBOUNCE_MS`, then asserts)
- **381-384;1012** "defers the conflict of a chat a server job streams into, saves the rest on its own, and reloads the chat once the job ends" / "re-anchors the append of a chat a server job streams into instead of deferring it, keeping the streamed text": POLL, controlled: partial. **rewrite:fake-timers** (risk: low-med). The same debounce-by-waitFor coupling (measured 559/568 ms, 10 polls) under a 5000 ms cap (risk: low-med) (fixed in slice 9b (0a6fb1aa5): advances fake time by `SAVE_DEBOUNCE_MS`, then asserts)
- **228;245;251;265;413;459;674;675;680;718;745;825;849;901;1031;1035;1163;1165;1435** "boot and mixed batches" / "the flush barrier" / "one chat's trouble does not block the rest" / "pagehide" / "a chat's first save (chatSaveVersion)" / "missing targets and gone anchors" / "group idempotency ids" / "kept absent chats leave the order": POLL, controlled: yes. **keep-poll** (risk: low). In-process fake server; these settle in one or two polls (about 50 ms: REMOTE_DELAY or in-cycle idle reads, fake keepalive fetch); line 249 is a controlled fake advance (risk: low)
- **291-338** "request caps": PERF, controlled: no. **rewrite:raise-timeout** (risk: low-med). 5,000-op loops take 311/196 ms of CPU when idle, about 2.8 s/1.8 s at 1/9 CPU, in the default 5 s (risk: low-med) (fixed in slice 7b (45b6309bf): the 5,001 operations stay, with an explicit 20 s budget for about 0.25 s of CPU)

#### `src/ts/storage/tests/resourceSyncDiagnostics.test.ts`

- **92,153** "boot" / "the save adapter's diagnostics": POLL, controlled: yes. **keep-poll** (risk: low). Timers faked without Date; vi.waitFor advances fake timers and polls an in-process fake server; the "generating" 409 sets the Date.now-based JOB_RETRY_MS block, but nothing is asserted across time afterwards; risk low
- **61 (boot), 104 (first test)** "records one `sync conflict` with the counts by category for a 409 another tab caused, without the record's id": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2315 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/resourceSyncFeedPatches.test.ts`

- **189-190** "applies a loaded idle patch immediately without a notice, read, outgoing work, or discard": BOOT, controlled: no. **rewrite:raise-timeout** (risk: high). The first test's boot() pays the cold module-graph import inside the test: 2.24 s idle against the default 5 s timeout. It times out under overload. Fix with a warm beforeAll import (60_000 hook). Risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **154,207,255-260,298,439-471** "beforeEach" / "feed patches through the tab save adapter" / "the feed's generation locks": CLOCK, controlled: yes. **keep-det** (risk: low). toFake includes "Date", so the job-retry and backoff deadlines move with the advances. Risk: low

#### `src/ts/storage/tests/resourceSyncFieldCache.test.ts` (2026-10-18 fixed file)

- **73,141-302,303-435,437-508** "cache reuse" / "every write path saves the mirror's text" / "record aliases and hooks, end to end": TMO, controlled: no. **rewrite:other(import the client/store graph once in a beforeAll with a hookTimeout so cases do not race the cold transform)** (risk: med). INTEGRATION_TIMEOUT remains 60_000 for cache reuse, every write path, and record aliases and hooks. Each case calls boot(), including resetModules and dynamic imports; there is still no beforeAll warm-up. The file's comment still records more than 30 s for the first graph under overload, leaving about 2x margin. The new 2,000-tuple asset-list case inherits the same 60 s and checks serialization counts, frozen identity, patches and canonical defaults rather than elapsed time. Warm the client/store graph once in a long-timeout beforeAll. (2026-10-21: added the frozen asset-list case at 176-271 and renamed the third describe; no cold-boot fix landed) (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **586-668,670-691** "canonicalShape against normalizeCharacter on a whole parse": TMO, controlled: no. **rewrite:raise-timeout** (risk: low). these boot too but have no INTEGRATION_TIMEOUT: fixed shapes uses the default 5 s (71 ms warm, ~3 s cold if run alone with -t), 120 shapes uses 20 s (583 ms warm, ~5 s at 9x); safe only because earlier cases warm the graph; risk low (med when filtered) (fixed in slice 4a (7d52aa936): warms canonicalShape independently of earlier cases)
- **130** "beforeEach": CLOCK, controlled: yes. **keep-det** (risk: none). toFake excludes Date, and resourceSync reads Date.now for schedule/backoff/jobBlocked (resourceSync.svelte.ts:462-473,899,1416), but those only matter after failures or 409s, which no case produces; flushResources runs runCycle directly; risk none

#### `src/ts/storage/tests/resourceSyncHydration.test.ts`

- **599-672** "releases a reply finalized while the job continues, scopes releases to the job, retires a replaced generation, and orders job metadata across revisions": CLOCK, controlled: no. **rewrite:other(run the stream frames by hand as 9b did for "installs the job's generated row...")** (risk: med). In 2 of 7 whole-suite runs under load the chunk "STILL STREAMING" applied at line 634 was not visible at 635 ("NEW GENERATION" stayed). Confirmed in slice 10: a frame that shows held stream text asks for another (`scheduleStreamFrame`), and every non-first update is held while one is pending; the test waited for "NEW GENERATION" with `vi.waitFor` on real animation frames, so when the poll ended between the two frames the next chunk was held. A test race; one stream update per frame is the intended behaviour (new 2026-10-22, found by slice 10) (fixed in slice 10 (this commit): `handRunFrames` stubs `requestAnimationFrame` and drains the frames, the ones they ask for included, with a bound so a frame that always asks again fails instead of looping; the 9b neighbour uses it too. It still fails when a stale copy is taken as current; a late `accepted` of the retired generation now also proves the retirement, which the late chunk alone did not)
- **312-313** "applies a newer record without echoing it back, and later local edits save on the hydrated revision": BOOT, controlled: no. **rewrite:raise-timeout** (risk: high). The first test's in-test boot() pays the cold import: 2.26 s idle against the 5 s default. Add a warm beforeAll import. Risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **1974-2017** "applies an empty equal-revision patch and an append on a long chat without reading or rewriting the list: the earlier messages keep their objects": PERF, controlled: no. **rewrite:other(shrink count; the object-identity checks already prove no read or rewrite) or raise-timeout** (risk: med). A 150_000-message chat built and hydrated in 1.6 s idle against the default 5 s timeout. Risk: med (partly fixed in slice 4a (7d52aa936): warm-up landed; still open: the large fixture still fails 3/3 overload runs, slice 7b) (fixed in slice 7b (45b6309bf): renamed from "applies an empty equal-revision patch and an append on a very large chat without reading or rewriting the list: the earlier messages keep their objects" and split into this gated case with 3,000 messages and the new slow "applies the same patches to a chat longer than a call's argument list can hold (150,000 messages)"; leftover: the title says "without reading" but only identity is asserted, which predates the slice)
- **296,495,610,780,901-1102** "a job's reply in the mirror" / "a reply locked by its job's chat event, before its stream" / "a refusal for a generating message": POLL, controlled: yes. **keep-poll** (risk: low). Date is faked for JOB_RETRY_MS. The vi.waitFor calls wait for stream frames scheduled by happy-dom rAF (real setImmediate, in-process). The setTimeout spies count calls, not time. Risk: low
- **1530-1620** "installs the job's generated row under the streamed text at a new and at an equal revision, honours the claim as a watermark, and releases the reply at the terminal patch": POLL, controlled: partial. **rewrite:other(await a real setImmediate turn after vi.waitFor, or drive animation frames explicitly)** (risk: med). Failed 1/3 overload runs: happy-dom's real setImmediate frame flush schedules a second frame, but vi.waitFor can resolve before it runs, leaving chunk 3 held. Await one real setImmediate turn after the poll or drive frames as chatStore.test.ts does; owner sweep 9b. (new 2026-10-21, found by slice 4a) (fixed in slice 9b (0a6fb1aa5): requestAnimationFrame is stubbed and the test runs the frames by hand)

#### `src/ts/storage/tests/resourceSyncLazyChats.test.ts`

- **192,209-211,236,413-443** "settle" / "beforeEach": CLOCK, controlled: yes. **keep-det** (risk: none). toFake includes Date, so the resourceSync Date.now backoff/jobBlocked reads are faked with the timers; checked, controlled
- **78 (boot), 220 (first test)** "writes nothing at boot; selecting a character reads its selected chat only; the chat's by-id live update applies as a patch and a whole-chat one refreshes it whole": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2434 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/resourceSyncLive.test.ts`

- **220** "beforeEach": CLOCK, controlled: yes. **keep-det** (risk: none). toFake includes "Date", so the backoff/job-retry Date.now reads follow the fake clock
- **89 (boot), 253 (first test)** "applies an idle record's change without a write, a notice, or a discard entry": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2398 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **940-980** "reads at most 1,000 announced chats per request and reaches every one": TMO, controlled: partial. **rewrite:other(warm the graph separately; retain the 1,001-chat boundary and budget the integration work explicitly)** (risk: low-med). The in-process store inserts, loads and refreshes 1,001 chats inside a real 20_000 ms test budget; Date and scheduler timers are fake, but fixture creation, serialization and assertions consume real CPU. The minimal 1,001 boundary is necessary to exercise the 1,000-per-request cap, so shrinking it below the boundary would weaken the contract. There is no elapsed-time assertion. The inventory omitted this existing timeout bump; its overload margin is unmeasured, so low-med is a conservative static estimate rather than a measured failure. (new 2026-10-21) (partly fixed in slice 4a (7d52aa936): warm-up landed before the integration work; still open: the 1,001-chat workload from cause 8) (fixed in slice 7b (45b6309bf): 1,001 chats over 25 characters, with the 20 s budget kept)

#### `src/ts/storage/tests/resourceSyncMerge.test.ts`

- **596-599,684-687** "does not acknowledge the merged edit when its write fails: the flush rejects and the edit is saved later" / "accepts the documented limits: identical records keep one increment, a lost answer followed by another writer counts it twice": CLOCK, controlled: partial. **rewrite:fake-timers** (risk: low). toFake lacks "Date" but resourceSync's backoff (backoffUntil = Date.now()+2 s; timer re-checks Date.now() < backoffUntil) is real-clock: unloaded, the auto retry keeps being postponed past the 5000 ms advance, while under load (>2 s real) it runs during the advance; the asserted end state is the same, but add "Date" as Live/Notices do (risk: low) (fixed in slice 4a (7d52aa936): fakes Date for both failure cases; backoff-delay assertions remain a coverage gap)
- **553** "stays pending while the merged write is held, resolves with an empty report once it is acknowledged, and keeps an edit made during the write": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on in-process held batch; no failure path, so backoff is not involved elsewhere in the file
- **73 (boot), 133 (first test)** "keeps the local edit and the later stamp: no discard, no notice, no listener, one merged write, no echo": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2275 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/resourceSyncModuleCache.test.ts` (**heap-memory-reduction modifies this file**)

- **194-478 (20_000 per test; 231,273,323,342,382,414,478)** "cache reuse" / "soundness": TMO, controlled: no. **rewrite:other(beforeAll warm import; keep 20 s for the 3000-asset work)** (risk: high). All seven cases use 20_000 ms and call boot() inside the test: resetModules, the real in-memory server store, and dynamic imports of the client/storage graph. No beforeAll warm import exists. The original cold-first-test evidence (2.85 s idle, about 26 s at a nominal 9x slowdown) remains historical; no new timings were taken. The new soundness case performs asset rename/add/delete and remote patch adoption on the 3,000-asset fixture, inheriting 20 s. Its patch, frozen-list, tuple-identity and server-agreement assertions catch real regressions. Date remains real, but settle() uses explicit fake advances without a runnable backoff dependency. (2026-10-21: heap-memory-reduction added the seventh 20 s case at 416-478; cold boot is still inside the first case) (fixed in slice 4a (7d52aa936): warms the graph in a 60 s beforeAll; retains 20 s for asset work)

#### `src/ts/storage/tests/resourceSyncNotices.test.ts`

- **158** "beforeEach": CLOCK, controlled: yes. **keep-det** (risk: none). toFake includes "Date" (comment: job-retry block compares Date.now()); setTimeout spy only reads delays
- **73 (boot), 178 (first test)** "keeps a notice that arrives during an idle read: a later read reaches the final revision, then no more reads or writes": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2365 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/resourceSyncPatches.test.ts`

- **312,398,454,486,563,632,652,683,700,727,754,772,791,833,910,929,998,1039,1076** "what a save sends" / "lost acknowledgements" / "modules item patches another tab committed": TMO, controlled: partial. **rewrite:raise-timeout** (risk: med). Per-test 20 s bumps. The first test takes 3.75 s (cold import plus a 5000-asset record) and the "reads the record whole ... over 64 KiB" test 2.7 s, about 5x margin, which a 1/9 CPU share can exceed. Add a warm beforeAll and shrink the big fixtures, or raise the timeouts. Risk: med (partly fixed in slice 4a (7d52aa936): warm-up landed; first test fell from 3.4 s to 0.9 s; still open: the whole-record fallback with a patch over 64 KiB still fails 3/3 overload runs) (partly fixed in slice 7b (45b6309bf): the over-64 KiB whole-record fallback case is fixed; the rest of the row stays open, and "sends a modules edit as an item patch... a large module stays home" still takes about 2-3 s under its 20 s budget because it needs the large module) (fixed in slice 9b (0a6fb1aa5): asset lists of 2,000 instead of 5,000, still above `MAX_FEED_PATCH_BYTES`, the limit the size check compares against; the row is fully fixed)
- **238,668-681,713-725,735-740** "beforeEach" / "lost acknowledgements": CLOCK, controlled: partial. **keep-det** (risk: low). toFake omits Date, so resourceSync's backoffUntil uses the real clock (the comment at 737 knows this). Every failure is followed by an explicit successful flush before any advance, so no assertion depends on backoff expiry. Latent: an advance between a failure and a flush would retry only after a real stall of 2 s or more. Risk: low
- **1354-1404** "rebuilds a dirty tab's 409 from matching feed data, retaining merge, discard and lost-response behavior": PERF, controlled: no. **rewrite:other(shrink the work, or split with a raised timeout)** (risk: med-high). The feed variant of the matching %s data test is CPU-bound inside the default 5 s timeout after graph warm-up and failed 2/3 overload runs; owner slice 7b or sweep 9b. (new 2026-10-21, found by slice 4a) (fixed in slice 7b (45b6309bf): a small boot module)
- **1406-1448** "reads a conflicting record when the available copy is older feed": PERF, controlled: no. **rewrite:other(shrink the work, or split with a raised timeout)** (risk: med). The "older feed" case of this parameterized test is CPU-bound inside the default 5 s timeout after graph warm-up and failed 1/3 overload runs; owner slice 7b or sweep 9b. (new 2026-10-21, found by slice 4a) (fixed in slice 7b (45b6309bf): a small boot module)

#### `src/ts/storage/tests/resourceSyncRecreation.test.ts`

- **146** "a same-id recreation saves the replacement's chats with its fields in one batch, and a fresh boot reads them": PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold module-graph boot in the first test: 2657 ms isolated when idle, in the default 5 s (risk: high) (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **328-339** "after a deletion refused for a generating message, a re-add once the job ended (before the retry) saves the replacement's chats at once": CLOCK, controlled: partial. **rewrite:injected-clock** (risk: low). jobBlockedRecords holds the real Date.now()+JOB_RETRY_MS (5 s), and schedule() compares real-clock deadlines (timerDeadline) to decide whether to keep the pending fake retry timer. If ≥4.5 s real passes between the refusal and addCharacter, the 500 ms schedule is dropped in favour of the 5 s fake timer, and advance(1000) never runs the cycle (risk: low) (fixed in slice 4a (7d52aa936): fakes Date for the generating-message retry)
- **220;356;442** "a same-id re-add after a deletion the server did not acknowledge" / "a chat quarantined before its character's deletion": POLL, controlled: yes. **keep-poll** (risk: low). A held batch on the in-process fake server (risk: low)

#### `src/ts/storage/tests/resourceSyncSecrets.test.ts`

- **136** "is sent after the cycle's batch on the record's revision, never in the record, and its acknowledgement bumps the path's version": BOOT, controlled: no. **rewrite:raise-timeout** (risk: high). The first test's in-test boot() pays the cold import: 2.3 s idle against the 5 s default. Add a warm beforeAll import. Risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)
- **124,220,348,518** "boot" / "a queued credential write" / "the cleanup of a deleted owner's entry": POLL, controlled: partial. **keep-poll** (risk: low). vi.waitFor waits on the in-process fake server. Date is real, but the post-failure advances at 347 (halted) and 517 (quarantined, no cycle scheduled) have no runnable retry, so real backoff expiry cannot change them. Risk: low

#### `src/ts/storage/tests/resourceSyncSections.test.ts`

- **266** "writes only modules and plugins on a first boot from a fresh store, and nothing on the next": PERF, controlled: no. **rewrite:other(beforeAll warm import, 60 s hook timeout)** (risk: high). Same cold first boot inside the test: 2.33 s alone against the default 5 s. risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/resourceSyncUnload.test.ts`

- **117,205,215,290** "page lifecycle" / "holdUnloadAnswer" / "releaseUnloadAnswer": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on in-process held batch/response; 10x advanceTimersByTimeAsync(1) flush loops over in-process fake; unload auth age checks use real Date with 1/4 min windows (huge margin)
- **53 (boot), 104 (first test)** "saves at once when the page is hidden, and warns before unload only while work is unsaved": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2286 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/resourceSyncUnloadHalt.test.ts`

- **99-130** "asks for no unload warning once saving halted, before and after the notice's OK, while the unsaved work stays": BOOT, controlled: no. **rewrite:raise-timeout** (risk: high). The file's only test boots cold in-test: 2.39 s idle against the 5 s default. Its vi.waitFor at 125 is in-process (keep-poll). Add a warm beforeAll import. Risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/storage/tests/settingsRecords.test.ts`

- **48 (boot), 109 (first test)** "save exactly the record written, on the held revision, for a nested view write and a direct record write": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 2333 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4a (7d52aa936): warmMutationGraph and StoreBackedServer.preload warm the graph in a 60 s beforeAll)

#### `src/ts/stores.importOrder.test.ts`

- **53-58 (beforeEach resetModules), 62-66 (import in test)** "lets transformClient be the first module evaluated, and still runs on every later pointer change": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: med). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 979 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: med (fixed in slice 4b (236531778): warmModules runs before the per-case resetModules, so each case still evaluates both modules fresh in its own order)

#### `src/ts/toggles/chatToggles.test.ts`

- **88-95** "boot": TMO, controlled: partial. **rewrite:raise-timeout** (risk: med). the per-test resetModules + cold boot is in beforeEach with a 20 s hook timeout; the first boot measured ~3.2 s idle (transform 3 s), ~6x margin that 1/9 CPU share (~9x) erases (risk: med) (fixed in slice 4b (236531778): was rewrite:raise-timeout; the warmMutationGraph warm-up fixes it, and the existing 20 s beforeEach stays because the per-test reload and StoreBackedServer.create still run there)

#### `src/ts/translator/chatTranslation.test.ts`

- **93 (boot), 237 (first test)** "boot": BOOT, controlled: no. **rewrite:other(warm the module graph once in beforeAll(() => import(...), 60_000), as characterCardsPngImport/charactersImportChat do)** (risk: high). vi.resetModules() + dynamic import of the storage graph inside the timed region: first test measured 1777 ms idle (one isolated run, Vitest JSON reporter) against the default 5 s test timeout; at ~9x slowdown plus a 1-3 s deschedule it times out. Added by the orchestrator (not in the group audit). risk: high (fixed in slice 4b (236531778): StoreBackedServer.preload plus warmModules over its boot imports in a 60 s beforeAll)

#### `src/ts/translator/storedTranslation.test.ts`

- **184** "stops with translationNoContext when the chat has no complete display context, saving and sending nothing": PERF, controlled: no. **rewrite:other(warm-up beforeAll with a raised hook timeout)** (risk: high). Cold resetModules boot in the first test: 1514 ms isolated when idle (about 13 s at 1/9 CPU), in the default 5 s (risk: high) (fixed in slice 4b (236531778): warmModules loads the file's graph in a 60 s beforeAll)
- **461** "posts an unforced request per id at once, without the save barrier or the stability checks, and holds the row pending until the translation arrives; `ignored` and a missing context say nothing": POLL, controlled: no. **rewrite:fake-timers** (risk: med). After hydrate, pending clears only on the production sync loop's real 100 ms SYNC_POLL_MS setTimeout (Date.now 15 s deadline). The default 1 s waitFor cap therefore races a real production timer: after a deschedule over 1 s, the waitFor interval can fail first and its timeout then rejects (risk: med) (fixed in slice 6b (56c228579): fake timers including Date, with one explicit 100 ms poll advance)
- **275;458;474;553;581** "POSTs the ids the chat displays with and the epoch header, joins a second call, and stays pending after the answer until the held message holds that translation": SLEEP, controlled: no. **rewrite:fake-timers** (risk: low). Real 250/150/50/20/50 ms sleeps before "still pending" / "no extra request" checks. These are negative checks, so overload makes them pass when they should not rather than fail (lower coverage) (risk: low) (fixed in slice 6b (56c228579): all five sleeps are fake-timer advances)
- **253;432;465;484;487;550;561;566;575;290-343;640-650** "POSTs the ids the chat displays with and the epoch header, joins a second call, and stays pending after the answer until the held message holds that translation": POLL, controlled: yes. **keep-poll** (risk: low). fetchCalls and ignored/failed outcomes settle in-process (mocked flush/authFetch); the deadline cases use full vi.useFakeTimers (Date included); translatedAt>=before is a monotonic check (risk: low)

#### `src/ts/translator/translatorMedia.test.ts`

- **150,209,212,381** "deferred": POLL, controlled: yes. **keep-poll** (risk: low). vi.waitFor on mocked transports held by deferreds. setTimeout(0) at 204 is a macrotask after the microtask traversal, and the cap is re-checked through peak at the end. Risk: low
- **449-489** "DeepLX request spacing": CLOCK, controlled: yes. **keep-det** (risk: none). The two new spacing tests fake both setTimeout and Date, and the util.sleep mock now uses setTimeout. translator.ts allocates slots with Date.now and sleeps to them, so sentAt = [0,3000,6000,16000] and the no-wait case are fully clock-controlled. The other describes set noWaitForTranslate=true, so changing that sleep mock does not add a real 3 s wait to them. (new 2026-10-21)

#### `vitest.lucideImports.test.ts`

- **21-46** "rewrites every barrel import in src/ and keeps each file's line count": TMO, controlled: partial. **keep-accepted** (risk: low). synchronous walk of src/ and ~1900 icon-file reads under the default 5 s timeout; ms-scale work, >10x margin even at 1/9 CPU; risk low

## 3. Residual real-time dependency in the 2026-10-18 fixed files

"Actionable" means a row whose disposition is not `keep-*`. Refreshed 2026-10-21; none of these
files gained a timing fix or a `slow` tag since the first pass.

| File                                                  | Rows | Actionable | high/med-high | Residual                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---: | ---------: | ------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/tests/scriptWorker.test.ts`               |   28 |         26 |             9 | **Yes, the most of any file.** Real ELU budgets, fixed 1000/500 ms watchdog/abort graces, 1000 ms regex deadlines, short duration checks, sleeps, cold pools and an untagged fresh Node process all remain. The first pass's `keep-det` readiness row is corrected to partial control plus rewrite; the successful regex-cap case gains a CLOCK row. See "scriptWorker residuals" below.                                                                                                             |
| `server/src/tests/promptRunner.test.ts`               |   16 |         10 |             0 | **Yes, low-med.** Only the slow-tagged test proves the real 3 s checkpoint and its lower bound. The gated abort variant keeps a real 20 s provider sleep and a `< 15_000` bound (721). Left: default 2 s `waitFor` polls at 1268/1333/1385/1405, 10 s translation polls, the real 5 s `JOB_ABORT_GRACE_MS`, the real 150 ms delay before the stream break (1081), and real worker budgets. A gated stream can cross the 3 s checkpoint interval under load; its assertions do not count checkpoints. |
| `server/src/tests/shutdown.test.ts`                   |    7 |          7 |             2 | **Yes.** The 100-continue barrier is deterministic, but all three tests spawn `main.ts` in a fresh Node process: a 10 s output poll (78), a 2 s temp-file poll (127), a 5 s SIGTERM-line poll (191), `< 5000` ms exit (220), the real 8000 ms drain grace, 20 s timeouts. The first test's `sleep(150)` (132) can pass without exercising the drain. Move the file to slow (`/** @module-tag slow */`).                                                                                              |
| `src/lib/ChatScreens/PartialEditController.test.ts`   |    2 |          0 |             0 | No. Faked `setTimeout` drives every focus/scroll/debounce delay (the controller reads no clock); the added hover/context polls wait on in-process Svelte work only.                                                                                                                                                                                                                                                                                                                                  |
| `server/src/tests/cbsLimits.test.ts`                  |    3 |          1 |             1 | **Yes, one.** "a non-advancing range answers [] under the server's limits" (675-679) still spawns a fresh Node process in the gated tier under the default 5 s. Move it to slow, or delete it (the registry range test at 300-331 covers `[0,1,0]` in process). The parity case fakes only `Date` and keeps the real 5 s/60 s CBS clocks (accepted); the rest inject `now`.                                                                                                                          |
| `server/src/tests/cbsLimitsHost.test.ts`              |    2 |          0 |             0 | No actionable row, but the first pass's plain "No" was too strong: ordinary host/binding parses keep the real 5 s/60 s CBS limits, and the effect-yield test (544-555) uses a real 80 ms busy-wait and 5 ms stop timer. Accepted for margin and load-monotone thresholds.                                                                                                                                                                                                                            |
| `src/ts/parser/tests/cbs/limits.test.ts`              |    3 |          2 |             0 | **Yes, low.** "the budget starts over for the next top-level parse", the non-advancing-range test (74-83) and, newly recorded, "twenty-five sibling calls answer..." (103-108) call the real 2 s client CBS host without `stopClock()`. Cause 11.                                                                                                                                                                                                                                                    |
| `src/ts/storage/tests/resourceSyncFieldCache.test.ts` |    3 |          2 |             0 | **Yes, med.** `INTEGRATION_TIMEOUT = 60_000` still includes the cold reset/import, about 2x the more than 30 s the file's comment records under the overload; the added frozen-asset case (176-271) inherits it. The canonical-shape cases (586-668, 670-691) keep 5 s / 20 s and pass only after earlier cases warmed the graph. Warm the graph once in `beforeAll`.                                                                                                                                |
| `src/ts/storage/tests/moduleCache.test.ts`            |    4 |          3 |             2 | **Yes, high.** No raised timeout and no warm-up. The first case (112-129) pays the cold graph boot under the default 5 s; the 100k-asset case (294-319) has the default 5 s as its implicit budget. (Modified by heap-memory-reduction.)                                                                                                                                                                                                                                                             |
| `src/ts/assetList.test.ts`                            |    1 |          1 |             0 | **Yes, med.** "reuses 100k cached names across successive queries for both record owners" (196-224) builds two 100k lists and scans about 8 million names under the default 5 s (776 ms noisy at the refresh, 307 ms idle before the heap merge). Shrink to 1-5k; the identity guards do not depend on size. (Modified by heap-memory-reduction.)                                                                                                                                                    |
| `server/src/tests/hypaV3Limits.test.ts`               |    3 |          2 |             2 | **Yes, high.** "ends a catastrophic pattern on a real worker while the event loop stays free" (260-281) runs on a cold pool and `hypav3.ts` checks the real 5000 ms chunking budget around the regex, so a slow boot turns "Regex timed out" into "chunking budget exhausted"; it also keeps `< 5000` and `< 1000` bounds. Fix: warm the pool and drop the bounds. The fresh Node process (106, 114-119) is still untagged. The separator aggregate is revised to `keep-accepted`.                   |
| `server/src/tests/lore.test.ts`                       |    2 |          2 |             1 | **Yes, med.** "matches through the worker, including flags and an escaped slash" cold-boots the size-1 regex pool inside the first test's default 5 s (fix: warm in `beforeAll`). New row: the 200 ms deadline also governs the sane match that must succeed (693-702), so warming alone does not fix it; give successful regexes a large deadline and move the real-limit case to slow or behind a fake host.                                                                                       |

### scriptWorker residuals

The 2026-10-18 fix (boot excluded from a task's budget, regex deadline and Lua ELU baseline started
at dispatch) is intact. It did not change the following:

- **Real small-budget tests** (high/med-high). They charge real ELU, so a routine 1-CPU deschedule
  of 20-80 ms cuts the run or breaks `cpuMs < 100`: "charges the CPU spent between host calls, not
  the waits" (322-332), "charges a coroutine resumed after a long wait only its own compute..."
  (335-353), "does not charge a synchronous wait, even one longer than the budget" (393-404), "lets
  queued runs sharing a budget spend it once" (597-609, below), "releases the reservation of an
  aborted run" (633-647, `usedMs < 100`), "charges the job budget across runs and refuses the run
  past it" (664-676, `second.cpuMs < 250`). Larger real budgets with relative invariants
  (`ms - cpuMs >= wait`) help non-limit subjects; exact small allowances need a controlled ELU.
  Raising 100 to 1000 alone does not cover a 1-3 s deschedule.
- **Fixed graces race "without a termination" assertions.** The hook must win against the
  watchdog in "stops a top-level runaway and a handler runaway at the per-run budget without a
  termination" (281-294) and against the 500 ms abort grace in "stops a running loop on abort
  without terminating the worker" (421-432). "reserves each concurrent run's allowance so two
  workers cannot overspend" (611-631) counts only the exact hook message as a cut; a watchdog win
  drops an entry. Make the graces pool options, or accept the watchdog error where it is an allowed
  outcome.
- **Wall bounds that catch nothing extra:** the six DUR rows (281-294, 296-306, 355-368, 370-391,
  421-432, 954-965). "serves concurrent host calls in their own completion order" (370-391) is
  high risk: only its `< 1000` bound tests concurrency, and `b:await() .. a:await()` alone does not
  prove it. First prove both host calls entered while neither answer was released, then release b
  before a and observe completion.
- **Sleeps and polls** in "aborts an unawaited host call's signal when its run completes and drops
  the late answer" (491/499), "ignores a host answer that arrives after its worker was killed"
  (542/554), "fails only the call for a host answer that cannot cross..." (689), "fails the task
  past the queue cap at once" (837-840), "grows to maxSize under load, admits in FIFO order at
  saturation, and retires idle workers" (1151-1165) and the two dispose tests (1175-1190). Replace
  transient worker observations with host-entry/completion deferreds; fake idle retirement only
  after readiness is known.
- **Cold pools** inside default 5 s regions: the owner/sub-regex case (513-533), shared-pool first
  use, the sleepCaps test, the readiness tests, lifecycle cases and the replacement-worker case
  (1201-1210). The shortened synchronous give-up test (954-965) has 20 s but also a real `< 7000`.
- **Real responsiveness as the subject:** "terminates a ReDoS regex at its deadline while HTTP
  stays responsive, and recovers" (800-827, each fetch < 500 ms, total < 3000 ms) and the plain
  Node exit test (1227-1248): `move-slow`.
- **New:** the successful regex operation/capture-cap test (771-798) races the 1000 ms parent
  deadline; give it a generous test deadline.

### "lets queued runs sharing a budget spend it once" (scriptWorker.test.ts:597-609)

Disposition rewrite, risk high. The test expects one successful 75 ms wall-time spin under a 100 ms
real ELU allowance, which is the reverse of "a bounded spin must be cut".

1. The first call reserves all 100 ms synchronously on assignment, before a cold worker is ready
   (`workerPool.ts:491-503`).
2. Calls 2-4 fail the public pre-check (`usedMs + reservedMs >= totalMs`, 803) synchronously. They
   do not queue, so the three refusals prove admission reservation, not spending a shared budget
   from a queue.
3. After readiness, the first run must finish its spin plus active preamble within the allowance. A
   pre-spin scheduling gap can cause a hook failure instead of `done`; a gap before the final charge
   can break `usedMs <= 200`; a worker-active gap above 1100 ms lets the parent watchdog terminate
   it.

To keep the queue subject: occupy the size-1 slot with an unbudgeted run held on a host-entry
deferred, enqueue all four budgeted runs while it is occupied, then release the blocker. Give run 1
an unbounded `while true do end`; assert one timed-out admitted result (hook or watchdog error),
three exact aggregate-budget refusals, `reservedMs === 0` and `usedMs === sum(result.cpuMs)`. Warm
before the timed region or give the boot its own long hook timeout. Do not impose `usedMs <= 200`.
This catches a missing start-time remainder check, a leaked reservation, charging the reservation
instead of measured time, and double charging.

A genuinely queued scenario does not by itself catch a public pre-check that ignores `reservedMs`:
all four submissions see no reservation until dispatch. Keep a separate immediate-admission
assertion for that contract (for example `queued === 0` right after the four submissions with the
allowance fully reserved).

Fixed in slice 5a (3fa95439b). Slice 9a (fd6805ccf) left the exact-100 ms cut unchanged: the aborted-run and dropped-result tests pin measured-vs-reservation charging.

## 4. Overlap with branch heap-memory-reduction (resolved)

The first pass deferred the fixes in eight test files until `heap-memory-reduction` merged. It
merged on 2026-10-20 (`b122ae132`). Its predicted edits landed (`moduleCache` now replaces whole
frozen asset lists; `resourceSyncModuleCache` gained a 20 s case in the cold-boot class, "an asset
rename, addition and deletion replace the frozen list whole..."; `records` gained deterministic
frozen-list tests), and none of the timing work went away: `moduleCache` (cold first test, 100k
case), `resourceSyncModuleCache` (seven cold-booting 20 s cases) and `assetList` (100k case) still
need their fixes. `modulesImport` and `records` still have only `keep` rows; `ModuleMenu.assets`,
`assetFuzzy` and `moduleFieldStamps` still have no spots. Nothing waits for the merge any more.

## Appendix

### Slow-tagged tests left out of scope

- Whole files (`/** @module-tag slow */`): `server/src/tests/importPngCaps.test.ts`,
  `server/src/tests/tokenPlainNode.test.ts`, `server/src/tests/diagnosticsCrash.test.ts`, and since
  the refresh `server/src/tests/upstreamImportWorker.test.ts`.
- `scriptWorker.test.ts` "caps sleep at 2 s per call and 6 s per run" and "charges a C-level
  runaway that follows the worker's own 10 s give-up".
- `promptRunner.test.ts` "writes the checkpoint 3 s after a chunk while the provider stalls, before
  any other chunk". It keeps a real 3 s timer, a >= 3000 ms lower bound and a 15 s poll, which is
  fine for the slow tier.
- `cbsLimits.test.ts` "the stuck range, an endless roll, ..." and "an ordinary large text passes
  under the server's limits".
- `manualTriggers.test.ts` "ends the job with an error past the effect limit".
- `triggerRuntime.test.ts` "ends a privileged self-recursion ..." and "ends `/trigger` recursion
  through the real command executor ...".
- `tokenParity.test.ts` "counts the smoke strings for every family as the browser does".
- `luaRuntime.test.ts` "pins the address, verifies the URL's host, ... answers 408 on the deadline".

### Candidate files audited with no spots (55)

Each matched a candidate pattern only through counts, sizes, controlled fake timers or stored
timestamps, or (new files) was read in full and found controlled. Since the refresh,
`llmProviderAdapters.test.ts` and `resourcePatchParts.test.ts` have rows and left this list.

- `server/src/tests/cbs.test.ts`
- `server/src/tests/changeFeed.test.ts`
- `server/src/tests/dynamicAssets.test.ts`
- `server/src/tests/greetings.test.ts`
- `server/src/tests/memoryAlgorithms.test.ts`
- `server/src/tests/messageSearch.test.ts`
- `server/src/tests/normalizationPass.test.ts`
- `server/src/tests/normalizeSections.test.ts`
- `server/src/tests/requestHistory.test.ts`
- `server/src/tests/resourceCompression.test.ts`
- `server/src/tests/resourcesBoot.test.ts`
- `server/src/tests/upstreamArchive.test.ts`
- `server/src/tests/upstreamImportSettings.test.ts`
- `shared/tests/diagnostics.test.ts`
- `shared/tests/diagnosticsReport.test.ts`
- `shared/tests/notifications.test.ts`
- `shared/tests/recordPatch.test.ts`
- `shared/togglePresets.test.ts`
- `src/lib/ChatScreens/ChatScreen.test.ts`
- `src/lib/ChatScreens/Chats.context.svelte.test.ts`
- `src/lib/ChatScreens/messageJump.test.ts`
- `src/lib/Others/MonacoEditor.test.ts`
- `src/lib/Setting/Settings.hotkeys.test.ts`
- `src/lib/SideBars/PinnedChatsRail.status.test.ts`
- `src/ts/charactersImportChat.test.ts`
- `src/ts/messageSearch.test.ts`
- `src/ts/parser/tests/assetFuzzy.test.ts`
- `src/ts/parser/tests/cbs/hostParity.test.ts`
- `src/ts/parser/tests/chatStyles.test.ts`
- `src/ts/plugins/apiV3/hostApiChats.test.ts`
- `src/ts/plugins/apiV3/hostApiRouting.test.ts`
- `src/ts/process/files/tests/multisend.test.ts`
- `src/ts/process/lorebook.svelte.test.ts`
- `src/ts/process/memory/memoryOracle.test.ts`
- `src/ts/process/request/tests/requestPresetScope.test.ts`
- `src/ts/setting/botSettingsParamsData.test.ts`
- `src/ts/setting/searchIndex.test.ts`
- `src/ts/setting/settingsPageSections.test.ts`
- `src/ts/setting/translationSettingsData.test.ts`
- `src/ts/storage/tests/assetClient.test.ts`
- `src/ts/storage/tests/characterAssetLists.test.ts`
- `src/ts/storage/tests/chatLock.svelte.test.ts`
- `src/ts/storage/tests/presetSchema.test.ts`
- `src/ts/storage/tests/serverAuth.test.ts`
- `src/ts/storage/tests/settingWrappers.test.ts`
- `src/ts/storage/tests/settingsViews.test.ts`
- `src/ts/storage/tests/snapshots.test.ts`
- `src/ts/stores.simpleCharacter.test.ts`
- `src/ts/sw.share.test.ts`
- `src/ts/translator/bilingualInterleave.test.ts`
- `src/ts/translator/presets.test.ts`
- `src/ts/util/koreanSearch.test.ts`
- `util/testInventory.test.ts`
- `vitest.testNetwork.node.test.ts`
- `vitest.testNetwork.test.ts`

### Files not read (144)

These matched no candidate pattern and run no in-test `vi.resetModules()` boot of the storage
graph. Regenerate the list with `rg --files | rg '\.test\.ts$'`, minus the files with rows in
section 2, the files above, and the four whole-file slow files.
