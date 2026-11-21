# Tokenizer Worker Plan

Status: drafted 2026-11-22 at `2f129b7b2` from the owner's request for the worker thread design that the
[found-issues](../backlog/found-issues.md) entry "A long text stalls every request while a tokenizer other than
tiktoken counts it" was left to (owner, 2026-11-21: "the worker thread design gets its own plan"). The owner accepted
D1 to D12 on 2026-11-22 as proposed, answering Q1 to Q4 with the proposals. Audited the same day by GPT-6.2-Astra
against `2f129b7b2`: [report](../reports/audits/plan-runner/tokenizer-worker-2026-11-22.md), 18 findings (1 P1, 10 P2,
7 P3) and 8 more in the corrections (4 P2, 4 P3), all fixed in this text. Two corrections changed what the owner
accepted, and the owner approved them on 2026-11-22 before any run: D11 (a worker with work holds the process, in
place of always `unref`ed) and D4 with D8 (the length limit is not a bound on time). Landed: 1 (`07376234a`), 2 (`349d882c4`), 3 (`737a559ec`), 4 (`0cfa55abd`).

Sources: `server/src/prompt/tokenizers/` (every file), `server/src/prompt/tokens.ts`, `server/src/routes/tokens.ts`,
`shared/prompt/chatTokens.ts`, the counter's call sites, `server/src/app.ts` (`createServerContext`), and the existing
worker runners (`server/src/data/restore/validateRunner.ts`, `server/src/scripts/workerPool.ts`,
`server/src/prompt/transformersWorker.ts`), read at `2f129b7b2`; the [LLM requests](../structure/llm-requests.md),
[server generation](../structure/server-generation.md), and [test harness](../structure/test-harness.md) guides. The
figures under Measured come from throwaway scripts run on 2026-11-22 (Node 24.21.0, one shared machine, one run each);
everything else under Current State comes from reading the code. Identifiers are the anchors; re-verify each cited
location before editing (STRUCTURE.md protocol step 5).

## Goal

A token count never holds the server's thread, whatever the text and the tokenizer family.

- **Encoding leaves the main thread.** Every local tokenizer family loads and encodes in a worker thread. A boot read,
  a stream, a socket frame, or a write is answered while a count runs.
- **A long text does not hold the other counts.** A text over a length limit is counted in a second worker, so the
  counts of an ordinary send wait behind ordinary texts only.
- **A long count can be given up.** A caller that leaves (a closed HTTP request, an aborted signal) ends the long
  count it was waiting for; the thread is stopped, not left to finish.
- **Counts and ids do not change.** The same encoders run, so every frozen id and count of the token tests holds.

Not goals: making any encoder faster; a limit on the text one count may take, or a deadline that fails a slow count (a
legitimate 2 MiB text is still counted, and its own caller still waits for it); stopping a job's count when the job is
stopped (Q3); moving Jinja rendering, CBS evaluation, or lore matching off the main thread; the tab's own work before
it asks for a count.

## Current State

- `createTokenizers` (`server/src/prompt/tokenizers/index.ts`) is a lazy registry of fifteen families (`LOADERS`). A
  family loads on first use and stays loaded; a failed load is not kept. `encode(family, text)` and
  `count(family, text)` await the load and then call the encoder, which is synchronous, on the calling thread.
  `dispose` is terminal: later calls reject with `The tokenizers are disposed`, pending loads settle, and each loaded
  encoder is freed once.
- `createServerContext` (`server/src/app.ts`) creates one set and one `createTokenCounter` over it. The counter goes
  to the request layer, the translation runner, the memory tasks, the generation runner's dependencies, and the
  Structured Memory routes; the token routes get the counter and the set. Shutdown disposes the set after the
  diagnostics finish and before the script workers.
- The set's `encode` has four callers: the counter's family path, its fallback after a Google count that did not
  answer 200 (`gemmaSentencePiece`), `countLocal` (`server/src/prompt/tokens.ts`), and the encode route
  (`server/src/routes/tokens.ts`). Nothing else on the server holds a tokenizer; `util/memoryEval.mjs` and
  `loadAll.ts` create their own set.
- The counter's `encode(text, scope, signal?)` checks its signal once on entry, before the cache lookup and the family
  choice (an already aborted call rejects even on a cache hit), and after that uses it only for a Google count. Two
  calls pass a signal: the count route (the HTTP request's) and the runner's count of the tool schemas
  (`nativeCtx.signal` in `server/src/prompt/runner.ts`, the job's signal joined with its fatal-error signal in
  `server/src/jobs/runSetup.ts`). Nine uses pass none: `jobChatTokenCounter`, the output meter's `countLocal`, and
  `tokenizeNum` in `runner.ts`; `tokenizeNum` in `server/src/llm/requests.ts`; the translation runner; the memory
  task host's two (its chat counter and its `tokenize`, both raced against the task's signal with `untilAborted`,
  which leaves the count running); two in `server/src/lua/bindings.ts`. The memory tasks' tracking adapters
  (`trackCall` in `server/src/prompt/memory/memoryTasks.ts`) forward `encode` and `count` with the text and the scope
  only, which makes eleven call expressions without a signal. The encode route reads its request's signal once,
  before the encode.
- A job the registry aborts may end at once. One that is still live when the grace timer fires
  (`JOB_ABORT_GRACE_MS`, 5 s by default, armed by the first abort in `server/src/jobs/generationJobs.ts`) is ended by
  the registry, whatever it still awaits. A synchronous encode on the server's thread delays that timer today.
- `ChatTokenCounter` (`shared/prompt/chatTokens.ts`) counts a prompt one text after another: each message's content,
  then its name, then its thoughts.
- Ids come back as a `Uint32Array` (tiktoken), an `Int32Array` (`@mlc-ai/web-tokenizers` 0.1.6), or a plain array
  (`GemmaTokenizer` of `@huggingface/transformers` 4.3.2). Consumers read the length, index the ids (`tokenizeNum`,
  for token biases), or copy them (`Array.from` in the encode route). The counter keeps the ids of up to 1,500 texts
  when `useTokenizerCaching` is on.
- A text refusal is recognized by its message (`isTokenizerTextRefusal`: an `Error` whose message starts with
  `The text contains a special token that is not allowed: `). Only the tiktoken families refuse.
- `tokenizers/tiktoken.ts` splits a pre-tokenizer piece over 512 UTF-8 bytes, which bounds the two tiktoken families
  for ordinary text; the other thirteen families have no bound
  ([found issues](../backlog/found-issues.md): at 2 MiB, 38.9 s for `novellist` on emoji, 16.2 s
  for `gemma` on letters, 6.0 s for `claude`, the rest 1 to 4 s).
- The count route takes a body of up to 2 MiB and 512 texts and has no limit per text.
- The server already runs worker threads from source files: the script pool and the restore, import, export, and
  scrub workers each start `new Worker(new URL("./<file>.ts", import.meta.url))`; the script pool `ref`s a
  worker when it hands it work and `unref`s it when idle. The Transformers.js models run in a child process, not a
  thread, because ending a thread inside an `onnxruntime-node` native call aborts the process
  (`server/src/prompt/transformersWorker.ts`). The `gemma` family imports the same package on the server's thread for
  its `GemmaTokenizer` class only.
- `tokens.test.ts`, `tokenParity.test.ts`, `commandSequences.test.ts`, and `promptRunner.test.ts` build their own
  `createTokenizers` set. `tokenRoutes.test.ts` builds one as its oracle and sends its requests through a
  `createServerContext`, so its parity cases pass with either implementation behind the context.
  `llmRequests.test.ts` and `commandSequences.test.ts` assert that the counter calls the set with exactly the family
  and the text. `tokenPlainNode.test.ts` (slow as a whole file, with a whole-file row in the slow-test table) loads
  every family in a fresh plain `node` process from an image-layout root.
- The tokenizers' owning guide is [LLM requests](../structure/llm-requests.md), which is 39,978 bytes: 22 under the
  40,000-byte limit of a guide file (`pnpm check:docs`), so it cannot take this plan's additions as it is. Its Gotchas
  say that local families encode synchronously on the server thread. `docs/structure/ownership.json` gives that guide
  the tokenizer sources, the payloads (`server/assets/token/**`), and the tokenizer tests and their helper; the frozen
  fixtures under `server/src/tests/fixtures/tokens/` fall to the `server/**` rule.
- The [server generation](../structure/server-generation.md) guide's Limitations record "tokenizer calls after model
  load" among the prompt work that runs on the main thread (owner, 2026-11-10).
  [Deferred work](../backlog/deferred-work.md) has, under Generation Progress Window, the output count running the
  local tokenizer on the serving thread.

### Measured

Scripts: a worker that owns a `createTokenizers` set and answers `load`, `count`, and `encode` messages, driven from a
second file. Not kept in the repository.

- **Every family loads in a worker thread** and counts the same sample text as on the main thread (fifteen equal
  counts). Load times are the main thread's (6 to 770 ms a family).
- **Memory.** With all fifteen families loaded the process's resident set is 679 MB when the main thread loads them
  and 681 MB when the worker does (74 MB before either). After the worker is terminated it is 300 MB.
- **A round trip costs about 0.1 ms.** 2,000 texts of about 330 characters, one awaited after another: 371 ms in
  thread and 593 ms through the worker for `cl100k_base`, 459 and 681 for `claude`, 334 and 541 for `llama3`, 177
  and 402 for `novelai`, 394 and 642 for `gemma`. Returning the ids (a transferred `Uint32Array`) costs the same as
  returning the count. Posting all 2,000 at once saves about a fifth of the worker figure.
- **The main thread stays free.** While the worker counted 1 MiB of one letter with `gemma` (2.9 s), the main
  thread's longest event loop delay was 5 ms.
- **A worker can be terminated inside an encode.** `gemma` at 1.5 s into a 2 MiB text (with
  `@huggingface/transformers`, and so `onnxruntime-node`, loaded in that thread), `novellist`, and `claude`:
  `terminate` settled in 8 to 35 ms, the process went on, and a new worker loaded the family in 174 to 488 ms and
  counted.
- **Worst time by length**, each family over nine kinds of text (one letter, spaced words, Hangul, CJK, emoji,
  digits, punctuation, spaces, mixed) of the same length in UTF-16 units, in thread:

  | Length  | Slowest                        | Second                       | Every other family |
  | ------- | ------------------------------ | ---------------------------- | ------------------ |
  | 65,536  | `gemma` on Hangul, 322 ms      | `cohere` on digits, 118 ms   | under 100 ms       |
  | 131,072 | `gemma` on Hangul, 585 ms      | `novellist` on emoji, 357 ms | under 240 ms       |
  | 262,144 | `novellist` on emoji, 1,408 ms | `gemma` on Hangul, 1,189 ms  | under 470 ms       |

  These nine kinds are not the slowest text of a length. A text that keeps tiktoken's package path is not split
  (one code point of the Unicode-table differences in `tokenizers/tiktoken.ts` is enough, and `tokenParity.test.ts`
  pins that path): the audit measured 6.5 s for `cl100k_base` on 65,535 letters followed by U+0295.

## Decisions

Accepted by the owner on 2026-11-22 as proposed. The audit then corrected D4, D8, and D11 in ways that change what
was accepted (Status), and the owner approved those three as corrected the same day.

- **D1. The boundary is the tokenizer set.** `Tokenizers` becomes an explicit type (`load`, `encode`, `count`,
  `dispose`) with two implementations: `createTokenizers`, unchanged, and a new `createWorkerTokenizers` that owns
  the worker threads. `createServerContext` uses the second. The counter, the routes, and every call site keep their
  code, because both calls were already asynchronous; the two edits of D8 are the exception. `createTokenizers` stays
  for the worker's own use, `loadAll.ts`, `util/memoryEval.mjs`, and the tests that build a set.
- **D2. Every local encode crosses; the main thread loads no family.** There is no size below which a text is counted
  in thread: that would need each family loaded twice (up to about 600 MB more with every family in use), and the
  round trip costs 0.1 ms, so a prompt of 2,000 texts gains about 0.2 s. A cache hit of the counter and a Google count
  that answers 200 reach no set, as now. A worker starts with the first call that needs it, so a server that never
  counts starts none.
- **D3. One call at a time per worker, queued on the server's thread.** An encode is synchronous, so a worker cannot
  run two; the host keeps each worker's queue in arrival order and posts the next call when the previous one answers.
  The host therefore always knows which call a worker is running (D7, D8), and a waiting call is given up by removing
  it from the queue.
- **D4. Two workers, chosen by the text's length.** A text of more than `LONG_TEXT_UNITS` (131,072 UTF-16 units,
  read from `text.length`) goes to the long worker; every other text and every `load` goes to the ordinary worker.
  The limit is on length, not on bytes or on the family, so the choice costs nothing to make. It is not a bound on
  time: at that length the slowest sampled count is 0.6 s, and a text that keeps tiktoken's package path took 6.5 s at
  half of it (Measured). Calls on the ordinary worker wait behind texts under the limit, whatever those take.
- **D5. The long worker ends when idle.** It exits `LONG_WORKER_IDLE_MS` (60 s) after its queue empties and starts
  again with the next long text, loading only the families it is asked for. While it lives, a family that both
  workers were asked for is loaded twice. The ordinary worker stays for the life of the server, as the loaded
  families do today.
- **D6. What crosses.** A call is `{ id, op, family, text }`, with `op` one of `load`, `count`, and `encode`. A load
  answers its id alone, a count a number, and an encode a new `Uint32Array` that the worker fills from the encoder's
  result and whose buffer it transfers: one owned form for the three result types. A failure answers its message, and
  the host rejects with an `Error` of that message, so `isTokenizerTextRefusal` matches as before and the count route
  still answers a refused text `null`. The worker's `workerData` is `{ rootDir, latch? }` (D12). The counter's `count`
  is the length of its `encode`, so a count through the server asks the worker for ids.
- **D7. A worker that ends fails one call.** When a worker errors or exits outside D5, D8, and D9, the call it was
  running rejects with `The tokenizer worker stopped` and the reason; the calls still queued stay, and a new worker
  starts for the first of them. The failed call is not sent again, since its text may be what ended the worker. A
  worker that cannot start fails the queue one call at a time and starts nothing while no call waits. A worker's
  `error` fails the running call once; the `exit` that follows fails no other call and is where the replacement
  starts (D11).
- **D8. Abort.** `encode` and `count` of the type take an optional signal; the in-thread set ignores it beyond a
  check before the encode. In the worker set, a call whose signal aborts rejects with the signal's reason at once.
  If it was queued, it is removed. If it was running on the long worker, that worker is terminated and the queue goes
  on in a new one. If it was running on the ordinary worker, the worker finishes it and the answer is dropped, so the
  ordinary worker is never terminated for a caller; the calls behind it wait until it ends (D4). The counter keeps
  its check on entry and passes the caller's signal on for a family count, and the shared Google request's own signal
  for that request's fallback; with no signal it calls the set with two arguments, as now. The encode route passes
  its request's signal. So an outstanding family count can be given up by the two callers that pass a signal today
  (the count route and the tool-schema count), and nothing aborted or dropped reaches the counter's cache. No other
  call site changes (Q3).
- **D9. Dispose.** Terminal and shared between concurrent calls, as now. Queued and running calls reject with
  `The tokenizers are disposed`, both workers are terminated, and the promise resolves after they have ended. No
  encoder is freed one by one: the threads end. A call after dispose rejects with the same message and starts no
  worker.
- **D10. No new limit.** The route keeps its 2 MiB body and 512 texts. No text is refused for its length and no local
  count gets a deadline (a Google count keeps its 30 s): a long text costs its own caller the time it takes, and one
  long text at a time is counted.
- **D11. Default resource limits; a worker holds the process only while it has work.** No heap limit is set: where a
  family's memory lives differs by family (wasm memory for the web tokenizers and tiktoken, JavaScript maps and
  arrays for `gemma`), and nothing measured gives a limit to choose. A worker failure that Node reports to the host,
  an out-of-memory end of the thread among them, takes the D7 path; memory exhaustion of the whole process is not
  handled here. A worker is `ref`ed while its lane has a running call, a queued call, or a start or a
  replacement owed, and `unref`ed only when it has none of them, as the script pool does
  (`server/src/scripts/workerPool.ts`). A replacement is started from the ended worker's exit handler, so no gap is
  held by a promise alone. The idle timer of D5 is `unref`ed. A script that awaits a count therefore
  gets its answer, and one that never disposes still exits.
- **D12. Seams for tests.** `createWorkerTokenizers` takes the function that starts a worker and the timer of D5 as
  options, with the real ones as defaults, so the queue, the two lanes, D7, D8, and D5 are tested against a scripted
  port and a fake timer. The worker file takes a test latch in its `workerData` and posts a `held` notification,
  which is not an answer, once it has taken the call the latch holds, as `validateWorker.ts` does, so a test can hold
  a real worker inside a call without a sleep.

### Questions the owner answered

Answered on 2026-11-22, each with the proposal.

- **Q1 (D4, D5). Two workers or one?** Two. One worker already keeps the main thread free and is slice 2 alone, but
  with one a 39 s count holds every other count for 39 s (a send in another chat waits for its prompt count), and
  giving up a count would mean terminating the worker every caller shares.
- **Q2 (D5). Should the ordinary worker also end when idle?** Not in this plan. It would give back most of the
  tokenizer memory (681 to 300 MB in the measurement with every family loaded) at the cost of a reload, 0.1 to 0.8 s a
  family, on the first count after a pause; when memory is held is a separate question from the stall.
- **Q3 (D8). Should stopping a job end its count?** Later, recorded in deferred work. The uses without a signal
  would each need the job's or the task's signal, the memory tasks' tracking adapters included. Without it, a stopped
  job ends on its own terms (the registry ends a job that is still live when its grace timer fires, 5 s by default,
  and a memory task's `untilAborted` releases its caller) while the count it started runs on: a count over the limit
  then holds the long worker, and the long calls behind it, until it ends. A Google count whose fallback is still
  encoding keeps one of the eight Google slots the same way.
- **Q4 (D4). The limit.** 131,072 units, which keeps one ordinary count of the sampled texts at about 0.6 s on the
  measuring machine (65,536 would keep it at about 0.3 s and send more texts to the long worker).

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_.

- **Checks.** `pnpm check`; the focused paths the slice names through `pnpm --silent test:agent <paths>` while
  iterating; `pnpm --silent test:agent` once whole after the last source edit; the slow tests the slice names, which
  are the slow-test table's rows for the paths it edits; `pnpm format:check`; `pnpm check:docs` for a guide edit;
  `pnpm check:tests` after adding or tagging a test.
- **V6.** Each new test is shown to fail with the guarded line broken, and the report says which line.
- **No timing in the gate.** A gate test does not assert how long a count took and does not race a real encode: a
  scripted port, a fake timer, or the latch holds the state it needs (test rules, Determinism).
- **Plain Node.** The worker file and everything it imports run under Node's type stripping without Vite: relative
  `.ts` imports and erasable TypeScript only, as the files beside it already are.
- **Ids are frozen.** No slice changes an encoder, `LOADERS`, or a fixture under
  `server/src/tests/fixtures/tokens/`.
- **Guides.** The slice updates the guide statements its change makes false, in the same commit; `pnpm docs:owner
<path>` names the owning guide of a file.
- **Shared files.** The slices run one after another. Edited by more than one slice:
  `server/src/prompt/tokenizers/index.ts`, `workerHost.ts`, and `server/src/tests/tokenWorker.test.ts` (2 and 3;
  `worker.ts` is slice 2's alone); the tokenizers guide of slice 1 (every slice); the server generation guide (2, 3,
  and 4); `docs/backlog/found-issues.md` (1, 2, and 3); `docs/backlog/deferred-work.md` (2 and 3). Slice 3 alone edits
  `server/src/prompt/tokens.ts` and `server/src/routes/tokens.ts`: slice 2 leaves them as they are.

## Slices

### 1. A guide of its own for the tokenizers (_small_)

Documentation only, and its own commit before any source edit (Doc Maintenance, Size limits: a split lands first).

- A new `docs/structure/tokenizers.md` with the nine headings of the guide outline (`Flows` and `State` included)
  takes what the LLM requests guide says about token counting: its Files sections "Tokenizer selection and server
  counting" and "Tab token counting", and the tokenizer statements of its Scope, Coupling, Invariants, Recipes, Tests,
  and Known Hazards (the tiktoken split, the text refusal rule, the plugin `tokenizerFunc` note, the Gotcha about
  synchronous encoding). The LLM requests guide keeps one link to it and its title loses "Tokenizers"; its Request
  routing flow's reference to its own Invariants for the main-model tokenizer rule points to where that rule now is.
- Ownership, in `docs/structure/ownership.json` (`pnpm docs:owner <path>` before and after). To the new guide, from
  the LLM requests guide: `server/src/prompt/tokenizers/**`, `server/src/prompt/tokens.ts`, `server/assets/token/**`,
  `shared/tokenizerChoice.ts`, `src/ts/tokenizer.ts`, `src/ts/tokenCountField.ts`, the tests
  `server/src/tests/{imageTokens,tokenParity,tokenPlainNode,tokens}.test.ts`, `src/ts/tokenizer.test.ts`, and
  `src/ts/process/prompt.tokenize.test.ts`, the helper `server/src/tests/tokenFixtures.ts`, and
  `shared/prompt/chatTokens.ts` and `shared/prompt/imageTokens.ts`. The four server tests leave the mixed rule they
  are in for a rule of their own that also names slice 2's test, so that it is owned from the start:
  `server/src/tests/{imageTokens,tokenParity,tokenPlainNode,tokens,tokenWorker}.test.ts` (a rule must be the first
  match of some existing path, which the four give it). Also to the new guide: `server/src/tests/fixtures/tokens/**`,
  which the `server/**` rule owns today. Staying where they are: `server/src/routes/tokens.ts` and
  `tokenRoutes.test.ts` (server generation), `tokenCountField.test.ts` (UI), and `shared/contextReport.ts`.
- Routing and links: the Choose By Task row of `STRUCTURE.md` names the new guide for token counts. References to the
  LLM requests guide that are about token counting point to the new guide: the Scope of `chat-pipeline.md`, the
  `tokenizerFunc` note of `plugin-sandbox.md`, and the found-issues entry's "The `llm-requests` guide's Limitations
  record the split".
- Nothing is reworded beyond what the move needs, and no statement is dropped. The commit message records each moved
  fact's destination (Doc Maintenance, Update and verify a guide).
- Checks: `pnpm check:docs`, `pnpm docs:ledger llm-requests`, `pnpm format:check`. The source and test checks of
  Rules For Every Slice do not apply.
- Done when `pnpm check:docs` passes, every moved statement is in the new guide, and the LLM requests guide shrank
  by what moved. A `near` report that remains is named in the slice's report (Doc Maintenance).

### 2. The worker and its host, one lane (_hard_)

Depends on 1.

- `server/src/prompt/tokenizers/index.ts`: the explicit `Tokenizers` type (D1). `createTokenizers` keeps its
  behavior; its comments stop saying that the server context owns this set.
- `server/src/prompt/tokenizers/worker.ts`: the worker file. It owns one `createTokenizers` set over its `rootDir`
  and answers one call at a time (D6), with the latch and its `held` notification (D12).
- `server/src/prompt/tokenizers/workerHost.ts`: `createWorkerTokenizers` with one worker: the lazy start (D2), the
  queue (D3), the answers and errors (D6), a worker's end (D7), dispose (D9), the limits and the `ref` rule (D11),
  and the start function as an option (D12).
- `server/src/app.ts`: `createServerContext` creates the worker set. Its place in the shutdown order stays.
- Tests, in a new `server/src/tests/tokenWorker.test.ts`. Against a scripted port: calls are posted one at a time in
  arrival order; a `load` is released by its answer and the `encode` behind it is posted then; a failure's message
  becomes the rejection's and a refusal is still recognized; a worker's end fails the running call, keeps the queue,
  and starts one new worker; an `error` followed by an `exit` of the same worker fails one call, starts the
  replacement at the `exit`, and leaves the replacement's first call alone; a worker that cannot start fails one call
  per start; no worker starts before the first call or after dispose; the worker is `ref`ed while its one call runs
  with nothing queued, and `unref`ed only once nothing runs, waits, or is owed a replacement;
  dispose rejects what waits and what runs, and concurrent disposes share one end. Against a real worker over a small
  family (`llama` loads in under 10 ms): the ids of a fixture text equal the in-thread set's and arrive as a
  `Uint32Array`; a `cl100k_base` special-token text is refused with the recognized message; a call held by the latch
  is failed by terminating the worker from the test, and the next call is answered by a new one.
- The context's wiring, in `tokenWorker.test.ts`: with a call-through spy on `Worker.prototype.postMessage` (as
  `scriptWorkerOptions.test.ts` observes the script pool), an authenticated count of an uncached text of a local
  family through a fresh `createServerContext` posts an `encode` of that family and text, and nothing is posted to a
  tokenizer worker before it. It is shown to fail with `createTokenizers` put back in `app.ts` (the existing route
  parity cases pass either way). No option is added to `createServerContext`.
- Slow tests: in `tokenPlainNode.test.ts`, a fresh `node` process that builds the worker set from an image-layout
  root, counts the smoke strings of every family as the in-thread set does, and exits by itself without a dispose.
  The file's whole-file row in the slow-test table covers it; no row is added.
- Guides: the tokenizers guide's Files, a new flow (the two sets, which one the server uses, and that a replaced
  worker loses nothing but its loaded families), its Gotcha about synchronous encoding, and its Tests list;
  [server generation](../structure/server-generation.md) Limitations (tokenizer calls leave the main-thread
  sentence). [Found issues](../backlog/found-issues.md): the entry is rewritten to what is left, in the present
  tense: a long count holds the other counts, not the server, and nothing ends it early.
  [Deferred work](../backlog/deferred-work.md): the Generation Progress Window entry about the output count on the
  serving thread is deleted, with any guide sentence that says the same.
- Focused: `pnpm --silent test:agent server/src/tests/{tokenWorker,tokens,tokenParity,tokenRoutes,llmRequests}.test.ts`,
  and `pnpm --silent test:agent --tags-filter=slow server/src/tests/{tokenPlainNode,tokenParity,shutdown}.test.ts`.
- Done when the server holds no tokenizer on its own thread, shown by the wiring test, and every existing token test
  passes unchanged.

### 3. The long worker and abort (_hard_)

Depends on 2.

- `workerHost.ts`: the second worker and the choice by length (D4), its idle end with the timer as an option (D5,
  D12), and the signal (D8). `index.ts`: the optional signal on the type and the in-thread set's check.
- `server/src/prompt/tokens.ts`: the counter passes the caller's signal on for a family count and the shared Google
  request's own signal for its fallback, and calls the set with two arguments when it has no signal (D8);
  `countLocal` takes none and passes none. `server/src/routes/tokens.ts`: the encode route passes its request's
  signal and answers an aborted encode as the count route answers an aborted batch.
- Tests in `tokenWorker.test.ts`, against scripted ports: a text of exactly `LONG_TEXT_UNITS` goes to the ordinary
  worker and one unit more to the long one; `load` goes to the ordinary worker; an ordinary call is answered while a
  long call is still running; the long worker ends after the idle time and not while a call waits, and the next long
  text starts a new one; an abort removes a queued call without a post, terminates the long worker for a running
  call and continues its queue in a new one, and on the ordinary worker rejects at once, posts nothing new until the
  answer arrives, and drops that answer; the rejection is the signal's own reason; dispose ends both workers. Against
  a real worker: a long call held by the latch is aborted, and the next long call is answered.
- Tests in `tokens.test.ts` (its set stub records the signal too): an aborted signal still rejects on a cache hit; a
  family count aborted while outstanding rejects with the reason and caches nothing, and the same text counts
  afterwards; a call without a signal reaches the set with two arguments; under a Google fallback, one caller that
  leaves does not disturb the other, and the last one leaving reaches the set through the shared signal. In
  `tokenRoutes.test.ts`: a client that disconnects during an encode gets no ids and the set receives the abort.
- Guides: the tokenizers guide (the two workers, the limit and that it is not a bound on time, the abort rule;
  Limitations: what Q3 leaves, and that a long count still takes its time for its caller);
  [server generation](../structure/server-generation.md) "LLM and token routes".
  [Found issues](../backlog/found-issues.md): the entry is deleted with its section and its Contents line, and the
  tokenizers guide's tiktoken Limitation, which links to that section, keeps its fact and loses the link; what the
  owner accepted is in the Limitations above. [Deferred work](../backlog/deferred-work.md): Q3 under this plan's
  heading, naming the tracking adapters.
- Focused:
  `pnpm --silent test:agent server/src/tests/{tokenWorker,tokens,tokenRoutes,llmRequests,commandSequences}.test.ts`,
  and `pnpm --silent test:agent --tags-filter=slow server/src/tests/{tokenPlainNode,tokenParity}.test.ts`.
- Done when an ordinary count is answered while a long one runs, and an aborted long count ends its thread, both
  shown by the tests.

### 4. Measure a running server and close (_small_)

Depends on 3.

- A script against a started server (`pnpm server` from the checkout with `RISU_SAVE_DIR` at a scratch save, or the
  harness the existing server measurements used): while one authenticated `POST /api/tokens/count` holds one long
  text for `novellist` (emoji) and for `gemma` (one letter), it times an unrelated authenticated read every 50 ms and
  a second count of a short text. The long text is sized so that the whole JSON body, scope included, stays within
  `MAX_TOKEN_BODY_BYTES`; the scope is a valid one for the family with `useTokenizerCaching` off; a long count that
  does not answer 200 with `counts` holding one non-negative integer voids the run. Run at this plan's base commit
  and at the slice's base, on one machine, and record the text's units and bytes and the body's bytes for both.
- A report under `docs/reports/measurements/server/` with both runs, the round-trip cost of a prompt-sized batch,
  the resident set with the families a real send uses, and this plan's Measured figures; its row in the
  measurements index.
- Guides: the figures the tokenizers and server generation guides quote link to the report.
- Done when the report shows the read and the short count answered during the long count, with the figures of both
  commits.

## Manual Checks

For the owner, after the last slice; a check that is not run moves to the manual checks backlog when the plan is
retired.

- On the real instance, with a model whose family is not tiktoken (a Claude, Gemma, or NovelAI model): open the
  editor of a character whose description is very long while a reply streams in another chat. The stream keeps
  moving and the count appears when it is ready.
- The Docker image: the first send after a start counts its prompt (the worker finds `server/assets/token/` under
  the image's root), and the container stops within its grace period while a count is running.
- The tokenizer playground encodes a short text with each tokenizer in its list.
- Start a very long count in the tokenizer playground and close the browser tab (a real disconnect: editing the text
  or leaving the page does not end the request). A second very long count from another tab then finishes in about
  the time of one such count, not two. A short count answers at once in either case.
