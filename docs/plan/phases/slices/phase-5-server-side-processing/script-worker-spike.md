# Slice: Script Worker Spike

Status: planned (drafted 2026-09-30, refined after review, not started).

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
