# Tokenizer Worker Plan audit, 2026-11-22

- Plan: `docs/plan/tokenizer-worker.md`
- Commit audited: `2f129b7b2`, with the plan read from the working tree before its first commit. The corrected plan is
  committed with this report
- Mode: `full`
- Model: GPT-6.2-Astra (`xhigh`), read-only, at the owner's request in place of the procedure's Sol because slices 2
  and 3 change `server/` contracts; report written by the session that drafted the plan (Claude Fable 5.2), before
  any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 1     |
| P2         | 14    |
| P3         | 11    |
| unverified | 0     |

All 26 findings are closed and `fixed in plan`. The first turn filed A1 to A18 against the draft. The second turn read
the corrections, confirmed fourteen, disputed A1, A5, A9, and A13, and filed B1 to B7 against the corrections
themselves. The third turn confirmed B1 to B5 and B7 (and with them the four disputed ones) and filed C1. B6 is
settled by this file existing; C1 was fixed after the last turn with the wording Astra suggested and was not read
again.

Astra ran no test and no type check. It ran `pnpm --silent check:docs` and several in-memory Node probes: a worker
that is `unref`ed while a call is outstanding (the process exits with code 13 before the answer), the ref-while-busy
rule through a replacement, two live workers loading the same families, and `cl100k_base` on a text that keeps the
package path. The three turns took about 19 minutes and 10.2 M tokens. `read_only_violation` was `false` after every
turn.

Two corrections change what the owner accepted on 2026-11-22 and are named in the plan's `Status:` line for the
owner's review: D11's `unref` rule (A1, B1) and the claim of D4 and D8 that a count under the length limit takes
under a second (A3).

Re-check list: none of the four mechanisms is touched by a planned edit. The plan reads job signals and counts; it
changes no `patchMessage` call or fence (`server/src/data/chatStore.ts:2596`), no feed form or manifest choice
(`server/src/data/chatStore.ts:2032`), no store creation (`server/src/data/resourceStore.ts:3903`, `:782`), and no
socket delivery accounting (`server/src/jobs/generationJobs.ts:1064`, `:1079`).

The plan's Measured figures came from scripts outside the repository and were not audited by reading; A3 is the one
place where a probe contradicted what a figure was used for.

## P1

- **A1. D11, "The workers take the default resource limits and are `unref`ed."** A pending promise does not keep Node
  alive, so an always-`unref`ed worker lets a plain `node` process exit (code 13) before its answer arrives; the
  slow plain-Node test the plan promised could not pass. The script pool `ref`s a worker when it dispatches and
  `unref`s it when idle (`server/src/scripts/workerPool.ts:489`, `:526`), and its plain-Node test needs both an answer
  and a clean exit (`server/src/tests/scriptWorker.test.ts:1573`). Fixed in plan: D11 holds the process while a lane
  has work, and slice 2's plain-Node test asserts the answer and a natural exit. See B1.

## P2

- **A2. Slice 4, "holds a 2 MiB text."** The route's cap counts the whole JSON body, scope and envelope included
  (`server/src/routes/tokens.ts:26`, `server/src/routes/limitedBody.ts:95`, `server/src/tests/tokenRoutes.test.ts:175`),
  so a text of exactly 2 MiB is answered 413 and both runs would measure a refusal. Fixed in plan: the body is sized
  within `MAX_TOKEN_BODY_BYTES`, with a valid scope and caching off, and the sizes are recorded.
- **A3. D4 and D8, "the worker finishes it (under a second by D4)."** The length limit bounds no time. One code point
  of the Unicode-table differences makes tiktoken pass the whole text to the package encoder
  (`server/src/prompt/tokenizers/tiktoken.ts:150`, pinned by `server/src/tests/tokenParity.test.ts:131`); a probe took
  6.47 s for `cl100k_base` on 65,535 letters followed by U+0295, half the limit. Fixed in plan: Measured names the
  case, D4 says the limit is not a bound on time, and D8 says the calls behind an abandoned ordinary encode wait.
- **A4. Current State, D1, D8, "uses its signal only for a Google count."** The counter already checks the signal on
  entry, before the cache and the family choice (`server/src/prompt/tokens.ts:247`), and the tool-schema count's
  signal joins the job's with the fatal-error one (`server/src/prompt/runner.ts:1738`,
  `server/src/jobs/runSetup.ts:227`). The change is to an outstanding family count, for the two callers that pass a
  signal. Fixed in plan: Current State, D1's exception, D8, and slice 3's counter tests (an aborted cache hit, an
  abort while outstanding, the Google fallback's shared signal).
- **A5. Q3, "ends only when that count does; nothing else waits for it."** With encoding off the main thread the
  job's abort grace can end the job while its count runs on (`server/src/jobs/generationJobs.ts:85`, `:1918`); the
  long calls behind it wait, a memory task's `untilAborted` keeps the call
  (`server/src/prompt/memory/memoryTasks.ts:888`), and a Google fallback keeps one of eight slots
  (`server/src/prompt/tokens.ts:169`). Fixed in plan: Q3 says so. See B2.
- **A6. D11, "Most of a family's memory is wasm memory ... the server goes on."** Where memory lives differs by
  family (`gemma` parses its vocabulary into JavaScript maps and arrays, `server/src/prompt/tokenizers/gemma.ts:10`),
  and only a failure Node reports to a surviving host can take the D7 path
  (`server/src/data/restore/validateRunner.ts:8`, `:119`). Fixed in plan: D11 keeps the default limits and claims no
  more than that.
- **A7. Current State and slice 2, "they do not take the one `createServerContext` makes."** `tokenRoutes.test.ts`
  builds an oracle set and also serves its requests through a context (`:45`, `:216`), so its parity cases pass with
  either implementation, and no proposed test failed if `app.ts` kept `createTokenizers`.
  `commandSequences.test.ts:390` and `promptRunner.test.ts:1718` build sets too. Fixed in plan: the inventory, and a
  wiring test in slice 2 that fails with the factory put back.
- **A8. Slice 3, "the counter passes the caller's signal on."** Passing a third argument that is `undefined` breaks
  two assertions of the exact two-argument call (`server/src/tests/llmRequests.test.ts:3003`,
  `server/src/tests/commandSequences.test.ts:470`), and the stub in `tokens.test.ts:217` records two fields only.
  Fixed in plan: with no signal the set is called with two arguments; both files are in slice 3's focused run.
- **A9. Slice 1, the ownership list.** The list left the payloads (`server/assets/token/**`), the tokenizer tests and
  their helper, and the two tab tests with the LLM requests guide (`docs/structure/ownership.json:197`, `:276`,
  `:356`), and the frozen fixtures and the new worker test would fall to `server/**` (`:565`). Fixed in plan: the full
  list. See B4.
- **A10. Slice 2, "add its row to the slow-test table."** `tokenPlainNode.test.ts` is slow as a whole file with a
  whole-file row (`:2`, `docs/structure/test-harness.md:353`); a named row for an untagged test fails `check:tests`
  (`util/testInventory.mjs:351`). The table also selects `shutdown.test.ts` for `app.ts` (`:368`). Fixed in plan: no
  new row; slice 2 runs the three slow files and slice 3 the two tokenizer ones.
- **A11. D6 and D12, the protocol.** A `load` had no success answer, so the lane could not release it
  (`server/src/prompt/tokenizers/index.ts:128`); `workerData` as a bare `rootDir` left no place for the latch, and the
  restore worker posts `held` apart from its answer (`server/src/data/restore/validateWorker.ts:12`). Fixed in plan:
  the three operations and their answers, `{ rootDir, latch? }`, the `held` notification, and the scripted cases
  (`load` then `encode`; `error` then `exit` of one worker).
- **B1. D11 as corrected, "`unref`ed while its queue is empty."** With the only call posted, the queue is empty while
  it runs; `unref` then exits the process before the answer. Fixed in plan: `unref` only with no running call, no
  queued call, and no start or replacement owed; the replacement starts from the exit handler.
- **B2. Current State as corrected, the grace timer.** `JOB_ABORT_GRACE_MS` is a default and a fallback: a runner
  can end at once, finalization clears the timer, and the fatal-error signal does not arm it
  (`server/src/jobs/generationJobs.ts:925`, `:1828`, `:1918`). Fixed in plan: the bullet and Q3 say "still live when
  the timer fires".
- **B3. Slice 4 as corrected, "answer 200 with a number."** The route answers `{ counts }`, and a refused text is
  `null` under a 200 (`server/src/routes/tokens.ts:115`). Fixed in plan: one non-negative integer in `counts`.
- **B4. Slice 1 as corrected, the rule for the new test.** An ownership rule must be the first match of some existing
  path (`util/docsOwner.mjs:160`), so "matches a file that exists now" was not enough. Fixed in plan: the four server
  tests get a rule of their own that also names `tokenWorker.test.ts`.

## P3

- **A12. Slice 1, the links.** The inbound references are to the whole guide (`docs/structure/chat-pipeline.md:10`,
  `docs/structure/plugin-sandbox.md:413`, `docs/backlog/found-issues.md:111`), the Request routing flow links to its
  own Invariants (`docs/structure/llm-requests.md:179`), the Gotcha about synchronous encoding (`:482`) was not
  named, and a move needs its destinations recorded and `pnpm docs:ledger` (`docs/structure/README.md:47`). Fixed in
  plan.
- **A13. The Shared files rule.** `index.ts` is edited by slices 2 and 3, `found-issues.md` by 1, 2, and 3, and
  `deferred-work.md` by 2 and 3 (its Generation Progress Window entry about the output count on the serving thread,
  `:207`, becomes false in slice 2). Fixed in plan; the second turn's two conditional overlaps went with B4.
- **A14. Slice 4, "`pnpm runserver`."** The script is `server` (`package.json:29`); the root is the working directory
  and the save folder is `RISU_SAVE_DIR` (`server/src/main.ts:25`, `server/src/listenConfig.ts:38`). Fixed in plan.
- **A15. D6, "a view of the wasm memory."** Both wasm bindings copy before they return
  (`node_modules/@mlc-ai/web-tokenizers/lib/index.js:117`, `node_modules/@dqbd/tiktoken/tiktoken_bg.cjs:309`). Fixed
  in plan: one owned `Uint32Array` as the wire form.
- **A16. D2, D5, D10, three overstatements.** A cache hit and a successful Google count reach no set
  (`server/src/prompt/tokens.ts:249`), a family is loaded twice only if both workers were asked for it, Google keeps
  its 30 s deadline (`:120`), and the counter's `count` asks for ids (`:275`). Fixed in plan.
- **A17. Current State, "nine call sites."** Nine uses, and eleven call expressions with the memory tasks' tracking
  adapters (`server/src/prompt/memory/memoryTasks.ts:899`); both races of the memory task host
  (`server/src/prompt/memory/memoryTaskHost.ts:176`, `:226`). Fixed in plan.
- **A18. Manual Checks, the last item.** A short count answers while an abandoned long count still runs, so the check
  could not tell a disconnect that worked from one that leaked; the playground sends no signal
  (`src/lib/Playground/PlaygroundTokenizer.svelte:22`, `src/ts/tokenizer.ts:243`). Fixed in plan: a real disconnect,
  then a second long count.
- **B5. Slice 3 as corrected, deleting the found-issues section.** The tiktoken Limitation that slice 1 moves links
  to `#server-generation` (`docs/structure/llm-requests.md:473`), as did two links of the plan. Fixed in plan: the
  plan's links lose the anchor and slice 3 retargets the Limitation.
- **B6. Status, the report link.** It pointed at this file before it existed, and `check:docs` does not read plan
  links (`util/docsBudget.mjs:595`). Settled by this file.
- **B7. Decisions, "Accepted by the owner."** The blanket sentence stood over decisions the audit had changed. Fixed
  in plan: it names D4, D8, and D11 as waiting for approval.
- **C1. D7, "an `exit` after its `error` changes nothing."** Under the corrected D11 that `exit` is where the
  replacement starts. Fixed in plan: the `error` fails the running call once, and the `exit` fails no other call and
  starts the replacement.

## Confirmed without a finding

- The asynchronous boundary: `Tokenizers` is structural, nothing on the server takes an encoder synchronously, and
  the context does not export its set (`server/src/prompt/tokenizers/index.ts:127`, `server/src/app.ts:1201`).
- Every loader works in a worker started from a `.ts` file, and two workers do not share state: the VM module
  promise, the factory queue, the registry, and the tiktoken cache belong to each worker's module instance
  (`server/src/prompt/tokenizers/webTokenizers.ts:16`, `tiktoken.ts:129`, `payloads.ts:18`).
- An `Error` rebuilt from its message keeps the count route's `null`, the encode route's 400, and the runner's
  refusal handling (`server/src/prompt/tokens.ts:67`, `server/src/routes/tokens.ts:106`,
  `server/src/prompt/runner.ts:2444`); no consumer depends on the id array's type, and the cache keeps a received
  array usable (`server/src/tests/tokens.test.ts:430`).
- A rejected local count is not sent again by any caller: a send fails at its stage, the count route answers 500,
  the output meter logs once, a memory task fails, and translation writes nothing.
- The counts the plan states: fifteen families, four callers of the set's `encode`, two calls with a signal, the
  shutdown position of `tokenizers.dispose()` (`server/src/app.ts:1273`), and the guide's 39,978 bytes against the
  40,000-byte limit.
- The wiring test needs no `createServerContext` option: a call-through spy on `Worker.prototype.postMessage` is
  what `server/src/tests/scriptWorkerOptions.test.ts:58` already does.
