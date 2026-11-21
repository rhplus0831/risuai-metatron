# Tokenizers

## Scope

- For token counts, tokenizer choice, and the tokenizer playground, start at
  [tokenizer selection and server counting](#tokenizer-selection-and-server-counting) or
  [tab token counting](#tab-token-counting). To add a tokenizer, follow [Recipes](#recipes).
- For provider requests see [LLM requests](llm-requests.md), for the token routes see
  [server generation](server-generation.md#llm-and-token-routes), and for the count field's editors see
  [UI](ui-theming.md#editor-token-counts).

## Files

### Tokenizer selection and server counting

- `shared/tokenizerChoice.ts`: `selectTokenizer` (which family counts a model's text, for the server counter and
  routes), `TabTokenScope`, `tokenizerIdentityKey`, `byName`, `playgroundFamily`.
- `server/src/prompt/tokenizers/index.ts` `LOADERS`, `createTokenizers`, `Tokenizers`: one loader per `TokenizerFamily`;
  payloads are `server/assets/token` files (`server/src/prompt/tokenizers/payloads.ts`). `createTokenizers` is the
  in-thread set (the worker's own, `loadAll.ts`, `util/memoryEval.mjs`, and the tests that build a set).
- `server/src/prompt/tokenizers/workerHost.ts` `createWorkerTokenizers`: the server context's set, which sends every
  `load`, `count`, and `encode` to one worker thread (`server/src/prompt/tokenizers/worker.ts`, which owns a
  `createTokenizers` set); an encode answers a `Uint32Array`.
- `server/src/prompt/tokens.ts` `createTokenCounter`, `isTokenizerTextRefusal`, `GOOGLE_COUNT_MAX_CONCURRENT`: the
  server counter; the routes are `server/src/routes/tokens.ts`. `countLocal` is the same choice without either cache and
  without Google's endpoint (a `googleCloud` choice counts with `gemmaSentencePiece`); the streamed reply's output meter
  uses it.
- `shared/prompt/chatTokens.ts` `ChatTokenCounter`, `ChatTokenHost`, and `shared/prompt/imageTokens.ts` `imageTokens`: a
  prompt's token arithmetic, the same on both runtimes.
- `shared/contextReport.ts`: `assemblePrompt` records its existing counts, with `toolSchemas` and `interceptions`
  outside `input`. Its `tokenScope` is the job's `tokenizerIdentityKey` (`tokenScopeFor`, `pluginTokenizer: "none"`).
  Use the same scope when comparing a tab's count.

### Tab token counting

- `src/ts/tokenizer.ts`: counts through the server routes, with no tokenizer in the tab: `tabTokenScope` (also what
  `requestServer` sends), `tokenScopeKey`, `jobTokenScope`, `countTokens`, `tokenizeAccurate`, `tokenCountInput`,
  `ChatTokenizer`, `tokenizerList`.
- `src/ts/tokenCountField.ts` `createTokenCountField`: the reusable UI count lifecycle. Editor call sites and component
  behavior are indexed in [UI](ui-theming.md).

## Flows

- The tab counts through the server routes. See [tab token counting](#tab-token-counting).
- The server's count: `createServerContext` (`server/src/app.ts`) builds `createWorkerTokenizers`, so the main thread
  loads no family. The first call starts the worker; calls go to it one at a time in arrival order, and the next is
  posted when the previous one answers. A failure answers its message, rejected as an `Error` of that message, so a text
  refusal is still recognized.
- A worker that errors or exits fails the call it was running (that call is not sent again), and a new worker starts at
  its exit for the calls still queued; the replacement loses nothing but the loaded families, which load again on use.
  The worker holds the process only while it has a call running or queued or a replacement owed. Dispose rejects what
  runs and waits and resolves once the thread has ended.

## State

- Encoders stay loaded in the server context's tokenizer worker until that worker exits or the set is disposed. See
  [tokenizer selection and server counting](#tokenizer-selection-and-server-counting).

## Coupling

- [Server generation](server-generation.md#llm-and-token-routes) owns `server/src/routes/tokens.ts`.
- [UI](ui-theming.md#editor-token-counts) indexes the token count field's editors.
- [Chat pipeline](chat-pipeline.md#context-report) owns `shared/contextReport.ts`.
- The [LLM request layer](llm-requests.md#tab-request-layer) sends `tabTokenScope` through `requestServer`.
- [Test harness](test-harness.md#fixtures) covers test fixtures.

## Invariants

- `cl100k_base` and `o200k_base` refuse text containing their special tokens; the count route returns `null` and the tab
  rejects that count.
- Tokenization does not follow a per-call `profileId`: a request's tokenizer scope is still the main model's (the tab's
  `context.tokenizer`, a job's `tokenScopeFor`), so token biases and bans of a per-call request use the main model's
  tokenizer (translation sends none).

## Recipes

- Add a tokenizer:
  1. Append to `LLMTokenizer` (`shared/llm.ts`), add the `TokenizerFamily` and its `selectTokenizer` case
     (`shared/tokenizerChoice.ts`), and for a name a user can pick, `byName` and `playgroundFamily` there and
     `tokenizerList` (`src/ts/tokenizer.ts`). Add the `CustomModelsSettings` option.
  2. Put the payload under `server/assets/token/` and add a `LOADERS` row (`json` or `sentencePiece`).
  3. Text refusal: only the tiktoken families refuse text with a special token. If a new encoder refuses, it must throw
     the message `isTokenizerTextRefusal` matches (`server/src/prompt/tokens.ts`), so the count route answers that text
     `null`; any other throw fails the whole batch.
  4. `tokens.test.ts` requires a `browser-ids.json` record per family (the fixture's `README.md`). Check the load with
     `node server/src/prompt/tokenizers/loadAll.ts`.

## Tests

- Focused: `pnpm --silent test:agent src/ts/tokenizer.test.ts src/ts/process/prompt.tokenize.test.ts` for the tab;
  `pnpm --silent test:agent server/src/tests/{token*,imageTokens}.test.ts` for the server.
- `slow`: `pnpm --silent test:agent --tags-filter=slow server/src/tests/{tokenParity,tokenPlainNode}.test.ts`
  ([test-harness](test-harness.md) `Slow-test table`).
- `tokenWorker.test.ts`: the worker set's queue, a worker's end, dispose, and the `ref` rule against a scripted port;
  ids, a refusal, and a replaced worker against a real worker (held by the worker's test latch); and that the server
  context's count reaches the worker.
- Token fixtures: `server/src/tests/tokenFixtures.ts` loads the frozen ids in `fixtures/tokens/browser-ids.json` for the
  tokenizer tests ([test fixtures](test-harness.md#fixtures)).
- Not tested: aborting the last caller while `server/src/prompt/tokens.ts` `scheduleGoogleCount` waits for a limiter
  slot; `tokens.test.ts` covers active-call cancellation and queue draining, but not cancellation while queued.

## Known Hazards

### Limitations

- Auxiliary requests still tokenize bias strings with the main model, not their own profile's tokenizer. Decision:
  `shared/llm/request.ts` `tokenizer`.
- A legacy plugin `custom` tokenizer counts with `cl100k_base` on screen and for `/api/llm/request` calls using the
  tab-supplied scope. Job prompt counts use `pluginTokenizer: "none"` and `o200k_base`. Its `tokenizerFunc` is never
  called, and delayed on-screen counts do not track the plugin tokenizer map. Decision: Server Tokenizer D1 and Combine
  Audit Fixes, [archive](../archived-plan/README.md).
- The server's `gemma` tokenizer loads `llama/llama3.json`, so Gemma counts are Llama 3 counts (also for on-screen
  counts). Decision: `server/src/prompt/tokenizers/gemma.ts` header.
- The tiktoken families take quadratic time on one long pre-tokenizer piece, so `tokenizers/tiktoken.ts` splits a piece
  over 512 UTF-8 bytes before encoding. Text without such a piece gets the package's ids; a split run may count a few
  tokens more per cut. Text with a code point whose Unicode category differs between Node and the package, non-ASCII
  text on an unmeasured Unicode version, and a pattern JavaScript cannot compile keep the package path. The other
  families are not bounded ([found issues](../backlog/found-issues.md#server-generation)). Decision: owner, 2026-11-15.
- Multimodal counts remain approximate: Claude/Gemini images use the GPT-4o fallback; video/audio/signature entries use
  a flat 85 tokens. Decision: owner, 2026-11-10 (known-issues review).

### Gotchas

- The server's local families load and encode in its tokenizer worker, one call at a time, so a long count holds the
  counts behind it, not the server ([found issues](../backlog/found-issues.md#server-generation)). Inside that worker
  the web-tokenizer module loader is shared and serialized; an in-thread `createTokenizers` set elsewhere loads its own
  families, and its disposal does not guarantee that the memory returns to the OS.
