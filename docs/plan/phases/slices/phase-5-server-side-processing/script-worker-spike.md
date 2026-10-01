# Slice: Script Worker Spike

Status: implemented 2026-10-01 (see the implementation record).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 6 (the bounded, terminable worker
for regex and Lua with input, output, batch, and engine memory limits; the runtime design ported
from the previous attempt, without its bindings); PLAN.md Decision 5.

Depends on: nothing in Phases 3 or 4. Startable now.

## Scope

Allowed files: `server/src/scripts/workerPool.ts` (new: the `worker_threads` pool and its
boundary), `server/src/scripts/worker.ts` (new: the worker entry that hosts one wasmoon module and
the regex executor), `server/src/lua/runtime.ts` (new: the engine lifecycle inside a worker),
`server/src/lua/egress.ts` (new), the `json.lua` resolution (`public/lua/json.lua`; `dist/lua/json.lua`
in the image), and the spike record appended to this file. Host function bindings only as far as
the limits need them (`sleep`, `request`, a `stopChat` flag, a `log` sink, and a fake slow host
call). `src/ts/process/scriptings.ts` and `scripts.ts` are untouched. Tests belong to the review
step, except the spike's own scratch checks recorded here.

Identifiers (verified 2026-09-30): the port source is
`/home/codex/risuai-fastify/server/fastify/src/prompt/luaRuntime.ts` (2,860 lines; present). Its
design notes (80-126) say "No `worker_threads` fallback is needed" (93-94), which contradicts
Decision 5; the design is ported inside the worker, not instead of it. Ported by design: the limits
block (128-141), `LuaExecBudget` (158-166), the factory singleton with `json.lua` read from disk
(179-207), the egress validator (`isBlockedAddress`, `validateEgressUrl`, `pinnedHttpsFetch`,
`serverLuaRequest`, 209-530), the abort checkpoint wrapper (1600-1612), the prepared one-use
engines (2170-2340), `runStringWithTimeout` (2349-2382), the run skeleton (2416-2650). Not ported:
the process-wide run serialization (`activeLuaRuns`, the boot gate; each worker has its own wasm
module, so the shared-function-table hazard the previous attempt documents at 2185-2205 does not
cross workers), the bindings body, model profile resolution, diagnostics, Ajv. wasmoon 1.16.0
(`node_modules/wasmoon/dist/engine.d.ts:6-12`) takes `openStandardLibs`, `injectObjects`,
`enableProxy`, `traceAllocations`, `functionTimeout`; `LuaGlobal.setMemoryMax`/`getMemoryUsed`
(`global.d.ts:15-17`) work only with `traceAllocations: true`; `thread.run(0, { timeout })`
converts the timeout to an absolute `Date.now()` deadline checked in the resume loop and by the
`lua_sethook` count hook every 1,000 instructions (`index.js:144-180`, `317-337`); the deadline
therefore counts time spent awaiting a host promise, and a single C-level operation (`string.rep`,
a pathological pattern) is not interrupted until control returns to Lua. Today's regex executor
`executeScript` (`src/ts/process/scripts.ts:184-304`) is synchronous `String.prototype.replace`
with a user-supplied `RegExp` and no timeout. Today's client Lua: one engine per mode
(`scriptings.ts:1322-1346`), no timeout, `json.lua` through `fetch` (1284-1298), `request` limited
to HTTPS, 120 characters, a `> 5` check that lets six calls pass per minute, three banned prefixes
(426-486). Reference tests: `/home/codex/risuai-fastify/server/fastify/__tests__/luaRuntime.test.ts`
(execution limit 1274-1306, abort 1308-1394, budget 1428-1482, pooled engines 1484-1716, egress
375-543).

Stopping condition: wasmoon inside a worker cannot be terminated cleanly by `Worker.terminate()`
mid-run (a hung terminate or a corrupted pool), or `resourceLimits` do not stop an allocation
runaway; the spike records it and stops for the owner's decision.

## Assumptions

- `wasmoon` 1.16.0 boots under plain Node (checked: `createEngine({ functionTimeout: 1000 })`,
  `doString('return 1+1')` returns 2) and inside a `worker_threads` worker (checked by the spike).
- The phase file's "the per-chunk budget is the runtime's own instruction hook over `lua_sethook`"
  is corrected: wasmoon's built-in count hook is exposed through `functionTimeout` and
  `thread.run({ timeout })`; the previous runtime adds no hook of its own.

## Proposed decisions

- Worker pool (proposed): `createScriptWorkerPool({ size, resourceLimits })` with two warm
  workers, each running `worker.ts`, which holds one `LuaFactory` (its own wasm module) and the
  regex executor. A task is `{ kind: "lua" | "regex", payload, limits }`; the pool posts it over
  `MessagePort`, applies the deadline with `Worker.terminate()`, and replaces a terminated worker.
  `resourceLimits` (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `stackSizeMb`) bound
  the worker's JS heap, and the wasmoon engine is created with `traceAllocations: true` and
  `setMemoryMax` (proposed 64 MiB) for the Lua heap. Size caps at the boundary: input text,
  output text, batch (targets per transform call), and script count per run; a task over a cap is
  refused before it is posted. Alternative (b), Lua in-process with `setMemoryMax` and only regex
  in a worker: rejected (does not bound Lua C-level runaways). Alternative (c), record a deviation
  from Decision 5: rejected (the decision is reachable).
- Host calls from a worker (proposed): host functions that need the server (LLM calls, channel
  questions, chat reads and writes) are proxied over the port as request/response messages; the
  worker suspends the Lua thread on the returned promise, as the previous runtime does. Every host
  call is the abort checkpoint.
- CPU-only Lua budget (proposed): the per-run limit (3,000 ms) charges only time between host
  calls. An async host function saves the remaining budget before awaiting and restores it with
  `thread.setTimeout(Date.now() + remaining)` on resume; host waits have their own caps (the
  question timeout, the `request` timeout of 10 s, `sleep` 2,000 ms per call and 6,000 ms per
  run). The aggregate budget per job (30,000 ms) is charged the same way. A run whose host call is
  refused or times out fails that stage explicitly (see `job-channel`).
- Limits (proposed, from the previous runtime unless noted): `request` 10 s and 2,000,000 bytes,
  URL 120 characters, HTTPS only, DNS-pinned public addresses (no private, loopback, link-local,
  ULA, mapped, 6to4, NAT64 targets), the three banned prefixes; rate 30 requests per minute per
  server (the previous attempt loosened the documented 5; recorded as a change; the owner may
  keep 5). Regex: one deadline per script run (proposed 1,000 ms) enforced by terminating the
  worker, since a `RegExp` cannot be interrupted.
- Engines are one-use and pre-warmed per worker (two per worker); Lua globals do not survive
  between runs. The recorded behavior change belongs to `lua-bindings-and-buttons`, where the
  server runtime replaces the client's; this slice proves it.
- The runtime interface is `runLua({ code, mode, data, budget, signal, host })` returning
  `{ res, stopSending, error?, timedOut?, aborted?, memory? }` and `runRegex({ data, scripts, mode, limits })`
  returning `{ data, effects }`; `host` is the binding surface `lua-bindings-and-buttons` fills.

## Validation

`pnpm check`, `pnpm format:check`; scratch checks run under plain Node and recorded here: a
top-level `while true do end` and a handler loop are terminated within about the limit; a
pathological Lua pattern (`("a"):rep(30000):find(("a-"):rep(20) .. "b")`) and a huge `string.rep`
are stopped by the deadline or `setMemoryMax`; a ReDoS regex (`(a+)+$` over 40 `a`s and a `b`) is
terminated and the pool recovers; a run awaiting a 5 s host promise completes under the 3 s CPU
limit; a second run proceeds in another worker while one is suspended on a question; 30 transform
targets each with a Lua hook finish within a measured budget; a warm engine sees no global defined
by the previous run; an already-aborted signal returns without a run; unrelated HTTP requests
answer while a worker is terminating; egress rejects `http://`, a 121-character URL, `localhost`,
a name resolving to a private address, a mixed resolution, and the 31st request in a minute. The
review step ports the reference cases into `server/src/tests/scriptWorker.test.ts` and
`luaRuntime.test.ts`.

## Residual risk

`Worker.terminate()` discards the worker's warm engines; a burst of runaway scripts costs a boot
per termination. `traceAllocations` adds an allocator hook to every Lua allocation; the spike
measures its cost on the 30-target transform case.

## Implementation record

Implemented 2026-10-01 on `9cee7fe9`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 2), then reworked after the Astra
challenge and the Fable review (below). Neither stopping condition triggered: `Worker.terminate()` stops a worker
mid-run cleanly, and `resourceLimits` contain a heap runaway.

- **`server/src/scripts/workerPool.ts`** `createScriptWorkerPool({ rootDir, size, maxSize, idleMs, resourceLimits, egress, wallMs })`:
  - `runLua(task, { host, signal, budget })` and `regex(op)` resolve with a result and never
    throw, as the client swallows script errors. An aborted signal, an exhausted budget, a full
    queue (1,000 tasks), or a task over the caps never reaches a worker.
  - A worker runs one top-level task. A regex that a run's host call spawns (`HostContext.regex`)
    goes to that worker, not to the queue. A host context works only while its run is live: after
    the run ends, its regexes are refused and its host calls' signals are aborted. A worker whose
    run ended with spawned regexes still running drains them before it takes a task.
  - The watchdog polls the worker thread's busy time (`worker.performance.eventLoopUtilization()`),
    less the main thread's synchronous answers (including one in progress, never past the worker's
    10 s timeout of the call) and the spawned regexes, and terminates the worker past the run's CPU budget plus 1 s. A Lua task has a 10
    minute wall cap; a regex task a 1,000 ms deadline, enforced by termination.
  - An abort sets a shared flag (`ABORTED_TASK`) that the Lua hook and a blocked synchronous call
    read at once, wakes a synchronous wait, and posts the abort message; a run that does not stop
    within 500 ms (it is in C code) costs its worker. The main thread refuses a host call of an
    aborted run before its handler and again before its reply, and an abort that races the run's
    end still makes the result aborted.
  - Budgets (`createLuaBudget`, `{ totalMs, usedMs, reservedMs }`): a run reserves its allowance
    (at most the per-run limit) when it starts, against what the budget's other runs reserved,
    and is charged its CPU time when it ends. Queued and concurrent runs sharing a budget cannot
    overspend it.
  - A terminated or crashed worker fails its top-level task and its spawned regexes, aborts its
    outstanding host calls, and is replaced when the pool is warm and the worker had booted (a
    worker that dies booting is not replaced ahead of demand, so a broken setup does not loop).
  - `size` (2) workers stay once started; while every worker is busy the pool grows to `maxSize`
    (6), and a worker above `size` exits after `idleMs` (30 s). Idle workers and their ports are
    unreferenced, so they never keep the process alive. `dispose` returns one promise that waits
    for every termination, and no worker it kills is replaced.
  - Host answers must be strings, numbers, booleans, or nil, a string at most 16 Mi characters;
    anything else (an object, an array, a function) is the call's error, not an unhandled
    rejection. Structured data crosses as a JSON string. Posting failures become the call's or the task's
    error. A throwing log sink is ignored.
  - `request` and `sleep` are served on the main thread; the request window
    (`createRequestLimiter`) belongs to the pool, so it is the server's.
  - Caps: Lua code 1,000,000 characters, the task's data and meta 16 MiB as JSON, a regex pattern
    100,000 characters, a regex input 16 MiB. Worker heap: 256 MiB old generation, 32 MiB young,
    4 MiB stack.
  - `json.lua` resolves from `public/lua/` then `dist/lua/` (`resolveJsonLuaPath`, the slice 1
    rule).
- **`server/src/scripts/worker.ts`**: the worker entry and the protocol types.
  - The task carries the execution identity (`characterId`, `chatId`, `presetId`, `personaId`);
    host calls receive it in `HostContext.identity`, with the access the call's first argument
    grants (`safe`, `lowLevel`, `editDisplay`, or none).
  - Asynchronous host calls are messages. Synchronous ones post on a dedicated port and block the
    worker with `Atomics.wait` until the main thread answers (10 s cap) or aborts the task, then
    read the reply with `receiveMessageOnPort`; a sequence number skips a late reply. A
    synchronous handler cannot use `HostContext.regex`, since its worker is blocked.
  - An unawaited host call does not outlive its run: its late answer is dropped.
  - A rejection from a wasmoon promise callback (an `async` step that hit the budget or an abort)
    is attributed to the active run and ends it; outside a run it fails the worker.
  - `runRegexOp`: `test`, `exec` (the first match), `split`, and `matches` (what `replace` visits:
    every match with `g`, else the first), each with groups and named groups. An invalid pattern
    answers `{ error }`. Results stop at 100,000 entries and at 16 Mi characters of matches,
    groups, and parts. The executor's time counts as the host's, not the run's. `runRegex` with
    the ordered effects is slice 3's.
- **`server/src/lua/runtime.ts`** `createLuaRuntime({ jsonLua })`:
  - Two prepared one-use engines per worker (hardening and prelude already run, built-ins
    declared, the run's state bound before its code). Engines boot only while no run is active.
  - Engines use `traceAllocations` and `setMemoryMax` (64 MiB).
  - **The budget.** One count hook per wasm module (every 1,000 instructions), installed on each
    engine's main state and on the function type extension's callback context, so every thread,
    call thread, and coroutine inherits it. It is never freed. It raises inside the state that
    runs when the run is aborted or its budget is spent. The budget is the worker thread's busy
    time (`performance.eventLoopUtilization()`) since the user code started, less synchronous host
    calls and spawned regexes; a host wait leaves the thread idle and is not charged. wasmoon's own
    `functionTimeout` and `thread.run({ timeout })` are not used.
  - **`LUA_HARDENING`** runs before the prelude and strips the libraries in place (the globals are
    the tables in `package.loaded`): `io` is gone (global and `package.loaded`); `debug` keeps only
    `traceback`; `os` loses `execute`, `exit`, `getenv`, `remove`, `rename`, `tmpname`, and
    `setlocale`; `require` keeps only the preload searcher after `json` is loaded, with
    `package.path`, `package.cpath`, `package.loadlib`, and `package.searchpath` cleared;
    `string.dump`, `dofile`, and `loadfile` are gone; `load` takes text chunks only; `print` writes
    to the log sink.
  - `LUA_PRELUDE` is the client's `luaCodeWrapper` without the user code, byte for byte; it loads
    as its own chunk, so error line numbers in user code start at 1 (as in the previous attempt).
  - Host calls: the abort checkpoint and the budget check; arguments must be strings, numbers,
    booleans, or nil (a Lua table arrives as a proxy), at most 16 Mi characters; at most 64 calls
    outstanding. What enters Lua is a primitive too: a host answer, checked again in the worker,
    and `onButtonClick`'s data (anything else fails the run).
  - **The value guard.** With wasmoon's proxy extension (the default), any JS object pushed to Lua
    is a live proxy, and through `__proto__` one run could change `Object.prototype` or
    `Array.prototype` for every later run on its worker. A type extension above wasmoon's own
    sees every push first: an `Error` (a host function's rejection or throw, the budget and abort
    errors, wasmoon's own errors) becomes its message string, without the stack and its server
    paths; any other object or array (`Promise.resolve(t)`, `Promise.all`, a rejection with a
    table) becomes a copied Lua table. Promises and functions keep wasmoon's handling.
  - Built-ins: `stopChat` (safe ids), `logMain` and `print` (the log sink: 64 Ki characters per
    message, 1 Mi per run), `sleep` (safe ids, 2 s per call, 6 s per run, served on the main
    thread), `request` (low-level ids, the egress guard). The caller's host functions are declared
    by name per run.
  - The mode dispatch is the client's: `onInput`, `onOutput`, `onStart`, `onButtonClick`,
    `callListenMain` for the edit modes, else the global named after the mode. A non-edit mode
    keeps only a primitive result (a Lua table proxy is dropped); every result must be JSON data
    within 16 MiB, checked in the worker before it crosses.
- **`server/src/lua/egress.ts`**: the previous runtime's guard, reworked:
  - the address classifier uses `ipaddr.js`: only unicast, minus benchmarking, site-local,
    local-use NAT64, IPv4-compatible, discard-only, documentation, IETF protocol assignment,
    ORCHIDv2, and SRv6 ranges; the IPv4-mapped, NAT64, and 6to4 forms are judged by their embedded
    IPv4 address; Teredo is blocked;
  - the banned targets match the historical prefixes and the parsed hostname (case and user
    info no longer pass);
  - one 10 s deadline covers name resolution, the connection, and the body (408 when it passes);
    name resolution races the abort;
  - the pinned lookup answers both callback shapes (Node 24 asks for `all: true`); redirects are
    not followed; the response settles once, on its end or any failure;
  - the order is the window check, validation, then the count (a second check after DNS).
- **`server/src/scripts/smoke.ts`**: the spike's checks and the challenge's counterexamples as an
  entry, `node server/src/scripts/smoke.ts [rootDir]`; exit 1 on a failure. Stop A runs it in the
  image.
- **`server/src/app.ts`**: `createServerContext` creates the pool (no worker starts until a task)
  and returns it as `scriptWorkers`; `dispose` disposes it before the snapshots stop and the store
  closes. Nothing runs scripts on the server yet (slice 8a).

Findings that shape the design:

- **One Lua run per worker.** wasmoon engines in one module share a function table; two suspended
  runs in one module are the previous attempt's "null function or function signature mismatch".
- **wasmoon's limits are unusable on the server.** Its count hook captures the first deadline,
  raises on the installing thread instead of the running coroutine (`Aborted()` when it fires in
  one), and its function is freed with the call thread that a coroutine still points at, or left
  behind when a thread's timeout is cleared (three table entries per run). The stable hook above
  replaces it: the table holds 15 entries after warming and still 15 after 30 runs of three awaits
  each.
- **A host call outstanding is not Lua suspended.** Lua can start an asynchronous call without
  awaiting it and keep running, so the watchdog charges the worker's busy time, not the time
  between host calls.

The smoke results (Node 24.21.0, x64, WSL2; 41 checks, all passing):

| Check                                                                                                                                  | Result                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Top-level `while true do end`                                                                                                          | budget error at 3,007 ms; the worker survives                           |
| Handler loop (`onInput`)                                                                                                               | budget error at 3,003 ms                                                |
| `("a"):rep(30000):find(("a-"):rep(20) .. "b")`                                                                                         | watchdog terminated the worker at 4,011 ms                              |
| `string.rep("x", 1e9)`                                                                                                                 | `not enough memory` in 89 ms                                            |
| ReDoS `(a+)+$` over 40 `a` and a `b`                                                                                                   | terminated at 1,001 ms; the next regex answers                          |
| `async` handler awaiting a 5 s host call                                                                                               | completed in 5,024 ms with 5 ms of CPU                                  |
| Top-level 5 s host wait                                                                                                                | completed in 5,004 ms                                                   |
| 20 × 0.4 s of CPU between host calls                                                                                                   | refused at 3,000 ms of CPU                                              |
| A second run while one is suspended                                                                                                    | finished first, on another worker                                       |
| 30 transform targets with an `editDisplay` hook                                                                                        | 100 ms (about 3 ms each; the pool grew to 6)                            |
| Globals after a run                                                                                                                    | not visible to the next run                                             |
| Already-aborted signal                                                                                                                 | no run                                                                  |
| Abort of a running loop at 200 ms                                                                                                      | aborted at 201 ms, without a termination                                |
| Abort during a host call                                                                                                               | host signal aborted, run aborted at 202 ms                              |
| Worker terminated during a host call                                                                                                   | the host call's signal aborted                                          |
| Two suspended runs calling lore (3 regexes each), `maxSize` 2                                                                          | both finished in 392 ms                                                 |
| 1,000 synchronous host calls                                                                                                           | 116 ms (0.12 ms each)                                                   |
| `sleep(id, 5000)` four times                                                                                                           | 2 s, 2 s, 2 s, then `false`; 6,004 ms                                   |
| `stopChat`, `return false`, `log`, the identity                                                                                        | as specified                                                            |
| Hardening (`require("io")`, `package.loaded.io`, the `debug` functions, the searchers, a binary chunk)                                 | all unreachable; `json`, `load("return 1")`, and `debug.traceback` work |
| `print("a", 1, nil)`                                                                                                                   | the log sink receives `a\t1\tnil`                                       |
| An unawaited host call, then the pathological pattern, 100 ms budget                                                                   | terminated at 1,104 ms                                                  |
| A coroutine (handler or top-level) computing 20 ms after a 350 ms wait, 100 ms budget                                                  | completed, 21 ms charged                                                |
| Synchronous 350 ms wait, then 20 ms of Lua, 100 ms budget                                                                              | completed, 20 ms charged                                                |
| Abort during a synchronous call, then a write call                                                                                     | aborted; the write handler never ran                                    |
| A host context kept after its run                                                                                                      | its regex refused; the next run unaffected                              |
| A host answer that is a function; a handler returning a function                                                                       | a call error; a dropped result; no unhandled rejection                  |
| Host answers that are an object and an array, writing `__proto__`; `onButtonClick` data that is an object                              | call errors, the prototypes untouched; the run fails                    |
| Host rejections and throws, wasmoon's own error, `Promise.resolve(t)`, `Promise.all`, a rejection with a table                         | strings for the errors, copied tables for the rest                      |
| `dispose` after `warm`                                                                                                                 | 2 spawned, 2 terminated, none left                                      |
| A synchronous call that never answers, then the pathological pattern, 100 ms budget                                                    | terminated at 11,128 ms (the 10 s call timeout, then 1,108 ms charged)  |
| `(?=(.{5000}))` with `g` over 10,000 characters                                                                                        | refused by size                                                         |
| Four 75 ms runs sharing a 100 ms budget, `maxSize` 1                                                                                   | one ran (76 ms charged), three refused                                  |
| Job budget of 4,000 ms                                                                                                                 | 3,000 ms, then the remaining 1,000 ms, then refused                     |
| `split` over 16 MB into 8,000,001 parts                                                                                                | refused at 100,000                                                      |
| 16 MiB worker heap and 100,000 matches over 16 MB                                                                                      | `JS heap out of memory`; the next task answers                          |
| HTTP during a worker termination                                                                                                       | slowest of 15 requests 15 ms                                            |
| Egress: `http://`, 121 characters, `localhost`, private, mixed, banned, the 31st                                                       | 400, 413, 403, 403, 403, 400, 429                                       |
| Address classes (multicast, site-local, local NAT64, documentation, IPv4-compatible, embedded private, Teredo, benchmarking, zone ids) | blocked; public IPv4, IPv6, NAT64, and mapped addresses allowed         |
| A stalled name lookup, aborted at 20 ms                                                                                                | rejected at 20 ms                                                       |
| `request` without and with low-level access                                                                                            | `nil`, then the fetched body                                            |

Also checked outside the smoke: the production fetch reached `https://example.com/` (200), returned
a redirect without following it (302), and refused an expired and a wrong-host certificate. A
process that used the pool and never disposed it exits on its own; two concurrent `dispose` calls
share one promise.

`traceAllocations` cost on the 30-target case, measured on wasmoon directly (boot, hardening,
prelude, a hook building 2,000 strings): 68 to 100 ms without, 89 to 98 ms with, so within the
run-to-run noise.

Recorded behavior changes (for `lua-bindings-and-buttons`, where the server runtime replaces the
client's):

- the hardening above (no `io`, no `debug` beyond `traceback`, no file or process functions of
  `os`, `require` only for `json`, text chunks only); `print` goes to the log sink;
- a non-edit mode's result is a primitive or nothing;
- host function arguments and answers are primitives (the prelude's wrappers already pass and
  decode JSON strings); `onButtonClick` data is a primitive (the client passes the button's
  string). The client's `similarity` answers a JS array; its server port answers a JSON string
  that a Lua-side wrapper decodes;
- an error caught in Lua is its message string, not a JS error proxy (no `e.stack`);
  `Promise.resolve(t):await()`, `Promise.all`, and a rejection with a table give a copied table;
- user-code error line numbers start at 1;
- engines are one-use, so globals do not survive between runs (already recorded);
- the budget is the worker's busy time, not wall time; a host wait is not charged;
- `request`: the hostname ban, the 408 on the deadline, the classifier above.

Residuals:

- Synchronous host calls block a worker until the main thread answers; a slow synchronous handler
  is charged to no budget but holds the worker. Slice 8a keeps them to reads of state the main
  thread holds.
- An abort of a run stuck in C code, and a C-level runaway, cost their worker, and a burst of them
  costs a boot each.
- A spawned regex still running counts toward the watchdog until it answers (at most its 1,000 ms
  deadline, inside the 1 s grace).
- The elastic pool caps at six workers; six runs suspended on slow host calls queue every other
  script until one returns or hits the wall cap. Slice 8a's host calls keep their own deadlines.
- Workers do not start with the server; until slice 8a nothing calls the pool, and the first task
  pays a worker boot (about 100 ms).
- The hook, the value guard, and the hardening use wasmoon 1.16 internals (`global.lua`,
  `typeExtensions`, the `js_table` extension, `callbackContext`); a version bump needs a re-check.

## Astra challenge (2026-10-01) and decisions

Every blocking point was reproduced or confirmed in the source; all are adopted.

1. B1, the hardening was bypassable (`require("io")`, `debug`, the file searchers, the original
   `load` through `debug.getupvalue`). Adopted: the in-place stripping above.
2. B2, an outstanding host call paused the watchdog while Lua ran. Adopted: the watchdog charges
   the worker's busy time.
3. B3, wasmoon's hooks leaked, raised on the wrong thread (`Aborted()`), and kept expired deadlines
   across synchronous waits. Adopted: the stable hook; wasmoon's limits are not used.
4. B4, an abort during a synchronous call let the next host effect run and the run report success.
   Adopted: the shared abort flag, the main-thread refusals, and the abort override.
5. B5, host calls and same-worker regexes outlived their task and could kill a newer one. Adopted:
   live contexts, aborted host calls, and draining.
6. B6, queued runs overspent a shared budget. Adopted: reservations at start.
7. B7, an uncloneable answer was an unhandled rejection, and a dropped result lost its CPU charge.
   Adopted: JSON-data answers, guarded posts, `plain` for every non-edit mode, the result check in
   the worker.
8. B8, entry caps did not bound bytes, and nothing bounded the queue or the logs. Adopted: the
   character budget of regex results, the result, argument, answer, and log caps, the queue cap,
   and `print` to the log sink.
9. B9, the pinned lookup broke under Node 24's `all: true`. Adopted: both callback shapes.
10. B10, no end-to-end deadline, and DNS and the body could hang. Adopted: one 10 s deadline, the
    DNS race, and settle-once response handling.
11. B11, the IPv6 classifier admitted non-public ranges. Adopted: `ipaddr.js` and the explicit
    ranges. The non-blocking hostname ban is adopted too.
12. N1, idle references, the disposal promise, and the restart policy. Adopted.
13. N2, the record's claims. Adopted: this record states what each check proves; memory at six
    busy workers is measured in the image at Stop A.

## Fable review (2026-10-01) and fixes

The review found three problems; all are fixed, and Fable's probes now pass.

1. `dispose()` after `warm()` replaced every worker it killed (2 spawned became 4, 2 left
   running), because `disposing` was assigned only after the kills ran. Fixed: a `disposed` flag
   is set before anything is killed, and every lifecycle check reads it.
2. A host answer or `onButtonClick` data that was a JS object reached Lua as a live proxy; a run
   wrote `__proto__`, a later run read the pollution, and an overridden `Array.prototype.push`
   broke the worker's next regex. Fixed: only primitives enter Lua, checked on the main thread
   and again in the worker.
3. After the worker's 10 s synchronous-call timeout, the main thread kept excluding the call's
   time until its handler returned, so a later C-level runaway ran uncharged to the wall cap.
   Fixed: the excluded time stops at the worker's timeout; only the latest request clears the
   in-progress mark, and a late answer adjusts nothing of a later task.

The re-review found fix 2 incomplete: errors still reached Lua as live proxies. The fix record
had claimed wasmoon's `js_error` wrapper applied, but wasmoon registers it only with
`enableProxy: false`. Fable's probe polluted `Object.prototype` from a caught host rejection, read
it in a later run through a synchronous throw, read server paths from `e.stack`, and hung its
worker to the wall cap by setting `Object.prototype.then`. The user chose to convert errors to
strings. A probe of every entry point found the same leak in wasmoon's own errors and in
`Promise.resolve(t)`, `Promise.all`, and rejections with a table, which no host function boundary
sees. So the conversion is the value guard above, at wasmoon's push, rather than in each host
function. Fable's probes now find no `__proto__`, no pollution in a later run, and a live worker.

## Checks

`pnpm check`, `pnpm format:check`, `pnpm test` (101 files, 1,105 passed, 3 skipped), `pnpm build`,
and `pnpm test:e2e` (5 passed) pass; the smoke passes 41 of 41.

## Tests

Written by the Fable reviewer after the second fix round (verdict: no problem):

- `server/src/tests/scriptWorker.test.ts` (47 tests, real `worker.ts` workers): the hardening;
  the value guard (object and array answers, object button data, errors as strings, promise
  round-trips as copied tables, cross-run pollution attempts); the budget (runaways with and
  without a termination, CPU across host calls, uncharged waits, coroutines after a wait, the
  watchdog after the worker's 10 s synchronous timeout, the memory cap); aborts and task lifetimes;
  aggregate budgets; transport and caps; egress and `sleep` through the pool; the pool lifecycle
  (growth, order, idle retirement, `dispose` after `warm`, replacement, a root without `json.lua`,
  a process that exits on its own).
- `server/src/tests/luaRuntime.test.ts` (13 tests): the address classifier, `validateEgressUrl`,
  `serverLuaRequest` (the window, the count after DNS, the byte cap, aborts), the pinned fetch
  over real TLS against a locally minted certificate (200, a redirect not followed, the body cap,
  a cut socket, an abort, a wrong host, and the 408 on the 10 s deadline), and the engine lifecycle
  in a plain-Node child (no function-table growth over 30 runs, the budget inside a resumed
  coroutine, one run at a time).

Fable judged the testing advice necessary and covered it, except public-internet cases (the local
TLS server covers the transport deterministically).
