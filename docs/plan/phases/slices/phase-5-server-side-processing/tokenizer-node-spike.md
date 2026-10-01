# Slice: Tokenizer Node Spike

Status: implemented 2026-10-01 (see the implementation record).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 1 (the tokenizer spike); PLAN.md
Decision 5 (the built-in tokenizer replaces plugin tokenizers on the server).

Depends on: nothing in Phases 3 or 4. Startable now.

## Scope

Allowed files: `server/src/prompt/tokenizers/` (new: one loader per family, a `loadAll` smoke
entry), and the spike record appended to this file. No client file changes; `src/ts/tokenizer.ts`
stays as it is; no `Dockerfile` change (see the payload decision). Tests belong to the review step.

Identifiers (verified 2026-09-30): the client loaders in `src/ts/tokenizer.ts`: `tikJS` (322-340,
the `@dqbd/tiktoken` root import plus `@dqbd/tiktoken/encoders/cl100k_base.json`, and
`src/etc/o200k_base.json` imported as a module at 332-336, so Vite bundles it into a chunk),
`gemmaTokenize` (313-320, `@huggingface/transformers` `GemmaTokenizer` over `/token/llama/llama3.json`,
not `gemma/`), `tokenizeWebTokenizers` (370-439, `@mlc-ai/web-tokenizers` `Tokenizer.fromJSON` and
`fromSentencePiece` over root-relative `fetch('/token/...')`), `tokenizeGoogleCloud` (271-311,
remote, `google.accessToken` in the `?key=` query), `geminiTokenizer` (342-368, unused). Families and
payloads under `public/token/`: `claude/claude.json`, `cohere/tokenizer.json`,
`deepseek/tokenizer.json`, `deepseek/v4/tokenizer.json`, `gemma/tokenizer.model`, `gemma/tokenizer.json` (unused),
`glm4/tokenizer.json`, `glm5/tokenizer.json`, `llama/llama.model`, `llama/llama3.json`,
`mistral/tokenizer.model`, `nai/nerdstash_v2.model`, `trin/spiece.model`.
`LLMTokenizer` in `shared/llm.ts:62-81` (17 values) and the fallback table in
`tokenizer.ts:210-240` map models to families.

Stopping condition: a family that cannot load under plain Node with a shim confined to the server
tree (no patch of `node_modules`, no build step, no new dependency, no Node flag) is recorded with
its error and the slice stops for the owner's decision on that family; the other families are
still reported. The fallback (count that family with `cl100k_base` and record it) is the owner's
choice at that point, not the spike's.

## Assumptions

- The server runs `.ts` files as ESM under Node 24 (`package.json` `type: module`). Checked:
  Node 24.21.0.
- The Docker `runtime` stage copies `server`, `shared`, `dist`, and the production
  `node_modules`; `public/` reaches the image only as `dist/` (Vite copies it; `vite.config.ts`
  has no `publicDir` override), and `src/etc/` does not reach it at all.
- `@dqbd/tiktoken` 1.0.22, `@mlc-ai/web-tokenizers` 0.1.6, `@huggingface/transformers` 3.8.x are
  production dependencies. `node_modules/@dqbd/tiktoken/encoders/o200k_base.json` exists, is
  exported by the package, and is semantically equal to `src/etc/o200k_base.json` (same `pat_str`,
  two special tokens, identical `bpe_ranks`, not byte for byte; verified 2026-09-30).
- Evidence gathered on 2026-09-30 with plain Node from the repository root: `@dqbd/tiktoken`
  encodes with the `cl100k_base.json` module; `@huggingface/transformers` imports and exposes
  `GemmaTokenizer`; `@mlc-ai/web-tokenizers` fails under an ESM import with `require is not
defined in ES module scope` (its `lib/index.js` is a UMD bundle inside a `type: module` package
  and calls `require('url')` at load; the wasm is embedded, `lib/` holds no `.wasm`). The same file
  compiled with `vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })`
  and called with `createRequire(filename)` loads without a flag, and both
  `Tokenizer.fromJSON(public/token/claude/claude.json)` and `Tokenizer.fromSentencePiece(public/token/llama/llama.model)`
  encode `hello world` to 2 tokens. Without `importModuleDynamically` the wrapper fails with
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`; with a plain callback it needs
  `--experimental-vm-modules`; the constant is the flag-free form.

## Proposed decisions

- Loading shim for `@mlc-ai/web-tokenizers` (proposed): the `vm.compileFunction` wrapper above,
  applied once at first use to the resolved `lib/index.js`, caching the module object.
  Alternative: vendor a `.cjs` copy under `server/` (rejected: a second copy of a dependency to
  keep in sync); alternative: a prebundle step (rejected: the server has no build step).
- `o200k_base` (proposed): load `@dqbd/tiktoken/encoders/o200k_base.json` (present in the image,
  verified identical to the repository payload); `src/etc/o200k_base.json` stays for the client
  bundle. No `Dockerfile` change.
- Gemma (proposed): keep the client's choice (`GemmaTokenizer` over `llama3.json`) for parity with
  the golden test and record it as a hazard to fix after the phase; `gemma/tokenizer.model` is
  loaded only for the `GoogleCloud` fallback, as on the client. Remote `tokenizeGoogleCloud` counts
  move to the server counter (slice 4), since the token it uses becomes write-only.
- Payload path (proposed): `resolveTokenizerPayload(name)` checks `public/token/` then
  `dist/token/` relative to the server's `rootDir` (the `cwd` rule in `server/src/main.ts`), so the
  same code serves `pnpm runserver` and the image.
- Memory (proposed): lazy per-family loading with one cached instance per family. The client keeps
  one replaced instance (`tokenizer.ts:264-267`); counts are deterministic, so the counts match.
  The spike records the resident set after loading every family.

## Validation

`pnpm check`, `pnpm format:check`; the spike's `loadAll` entry run with plain `node` from the
repository root and from a directory holding only `dist/token/` plus `node_modules` (the image
shape), printing per family: loaded (ms), the token counts of three fixed strings compared with the
client's counts captured once in the browser (actual encoding, not module loading), and the
resident set. The review step turns the per-family checks into `server/src/tests/tokens.test.ts`.

## Residual risk

The counts must match the client's for the golden prompt test to hold; a family whose Node build
differs from the browser build would surface there. The `vm` shim depends on the UMD wrapper shape
of `@mlc-ai/web-tokenizers` 0.1.6; a version bump needs a re-check.

## Implementation record

Implemented 2026-10-01 on `2ddc855a`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 1). Every family loads under plain Node;
the stopping condition did not trigger.

- **`server/src/prompt/tokenizers/payloads.ts`**: `resolveTokenizerPayload(rootDir, relPath)`
  tries `public/token/` then `dist/token/` under `rootDir` (only a missing file falls through);
  `readTokenizerPayload` reads a payload into an `ArrayBuffer` of its own.
- **`tiktoken.ts`**: `loadTiktoken(encoding)` imports `Tiktoken` from `@dqbd/tiktoken` (its `node`
  export, `tiktoken.cjs`) and reads the encoder data with `createRequire`. `o200k_base` is the
  package's `encoders/o200k_base.json`.
- **`webTokenizers.ts`**: the `vm.compileFunction` shim of the Assumptions, applied once and
  cached (a failed load is not cached). `loadWebTokenizer(rootDir, "json" | "sentencepiece", relPath)`.
  Its factory calls (`fromJSON`, `fromSentencePiece`) run one at a time across the process: the
  package starts its wasm binding inside the first factory calls, and concurrent first calls each
  start one, so the tokenizers built against an overwritten binding fail to encode.
  The module's types are a local two-method interface, not the package's `.d.ts`.
- **`gemma.ts`**: `loadGemmaTokenizer(rootDir)`, Transformers.js `GemmaTokenizer` over
  `llama/llama3.json` with `{}` as the config, as the client does.
- **`index.ts`**: `createTokenizers({ rootDir })` with `load`, `encode`, `count`, and `dispose`.
  `dispose` is terminal and returns one promise: it refuses every later call, waits for the loads
  already started, and frees each loaded family once, attempting every free. The owner (the server
  context, from slice 4) creates one set and disposes it at shutdown.
  The families are the client's names: `cl100k_base`, `o200k_base`, `novellist`, `claude`,
  `novelai`, `llama`, `mistral`, `llama3`, `gemma`, `gemmaSentencePiece` (the `gemma` case of
  `tokenizeWebTokenizers`, used only when the Google count fails), `cohere`, `DeepSeek`,
  `DeepSeekV4`, `GLM4`, `GLM5`. One instance per family, loaded on first use; a failed load is not
  cached. `gemma/tokenizer.json` is unused. The model-to-family mapping (`encode`'s three switch
  blocks and the fallback table) is slice 4's.
- **`loadAll.ts`**: `loadAll(rootDir)` and the entry
  `node server/src/prompt/tokenizers/loadAll.ts [rootDir]`, which prints per family the load time
  and the counts of `SMOKE_TEXTS`, then the resident set, and exits 1 if a family failed.

The spike's results (Node 24.21.0, WSL2):

| Family               | Load (ms) | Counts    | Browser ids |
| -------------------- | --------- | --------- | ----------- |
| `cl100k_base`        | 101       | 2, 23, 27 | equal       |
| `o200k_base`         | 114       | 2, 15, 27 | equal       |
| `novellist`          | 140       | 4, 27, 44 | equal       |
| `claude`             | 176       | 2, 28, 31 | equal       |
| `novelai`            | 15        | 3, 21, 38 | equal       |
| `llama`              | 6         | 2, 30, 35 | equal       |
| `mistral`            | 7         | 3, 26, 36 | equal       |
| `llama3`             | 535       | 2, 17, 27 | equal       |
| `gemma`              | 585       | 2, 17, 27 | equal       |
| `gemmaSentencePiece` | 69        | 2, 13, 30 | equal       |
| `cohere`             | 776       | 2, 16, 31 | equal       |
| `DeepSeek`           | 353       | 2, 18, 28 | equal       |
| `DeepSeekV4`         | 330       | 2, 18, 28 | equal       |
| `GLM4`               | 779       | 2, 18, 27 | equal       |
| `GLM5`               | 821       | 2, 16, 27 | equal       |

- **The browser ids** were captured with a Playwright script against the Vite dev stack: the
  client's own `encodeWithTokenizer` for the thirteen `tokenizerList` types; `encode` with
  `aiModel: "openrouter"` and `customTokenizer: "tik"` for `o200k_base`; and `encode` with
  `gemini-2.5-flash-image`, `googleClaudeTokenizing`, and the Google count routed to a 500 for
  `gemmaSentencePiece`. Every token id is equal, not only the counts.
- **Payload locations:** the same ids came from `public/token/` (the repository root), from a
  directory holding only a copy of `dist/token/`, and from the built `dist/token/`. The run inside
  the Docker image is Stop A's.
- **Memory:** 65 MiB resident before any load, 650 MiB after all fifteen. The largest are `gemma`
  (+182 MiB), `cohere` (+123 MiB), and `GLM5` (+74 MiB). A server loads only the families its
  models use.
- **Throughput:** `cl100k_base` counts a 1,000,000-character input (200,001 tokens) in 176 ms.

Hazards found, for slice 4 and the baseline capture:

- **Special-token text.** `cl100k_base` and `o200k_base` throw on text that contains
  `<|endoftext|>` (`The text contains a special token that is not allowed`). The client's `tikJS`
  calls `encode(text)` the same way, so it throws there too. The baseline capture records the
  client's behavior for such input; slice 4 keeps it unless a fix is approved.
- **An experimental warning.** The first web-tokenizers load prints
  `ExperimentalWarning: vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature` once per
  process. It needs no flag. A plain `importModuleDynamically` callback would need
  `--experimental-vm-modules`, which the stopping condition excludes.
- **`gemma` over `llama3.json`** gives the same ids as `llama3` for these strings: the client's
  Gemma count is a Llama 3 count. Kept for parity, as decided.
- **Memory and latency are integration limits, not guarantees.** The resident set is process-wide
  and depends on load order; freeing a family does not promise the memory back. A count runs
  synchronously on the thread that owns the set. Slice 4 measures its topology under concurrent
  jobs and does not build a set per request or per script worker.

## Astra challenge (2026-10-01) and decisions

1. Blocking: concurrent cold web-tokenizer loads corrupted the shared binding. Six of twelve
   families failed to encode with `BindingError: Expected null or instance of VectorInt` after a
   concurrent first load. Adopted: factory calls are serialized per process (payload reads stay
   parallel). After the fix, a cold run of every family on two sets at once, with a duplicate
   request, gives the browser ids for all.
2. Blocking: `dispose` double-freed (a second concurrent `dispose` threw `Tokenizer instance already
deleted`) and lost an encoder loaded during disposal. Adopted: the terminal contract above. A
   double `dispose` now returns the same promise, and a load during or after it is refused.
3. Non-blocking: the image gate is outstanding (Transformers.js loads `onnxruntime-node` and
   `sharp` under Node). Adopted as planned: Stop A runs every family in the built image, with no
   source or `node_modules` mount.
4. Non-blocking: the design sections contradicted the plan's amendments (bearer, the size range,
   byte equality, the client cache, the test file name). Adopted: the sections are corrected.
5. Non-blocking: state the memory and latency limits and the set's ownership. Adopted (above).
6. From the other notes: `fs.access` errors other than a missing file are no longer read as
   "not found". Adopted.

## Checks

`pnpm check` (5131 files, 0 errors), `pnpm test` (99 files, 1045 passed, 3 skipped),
`pnpm format:check`, `pnpm build`, and `pnpm test:e2e` (5 passed). No existing test was
invalidated, so no test-adapter ran. `loadAll` exits 0 for all fifteen families. A re-capture with
`util/playwright/captureTokenizerIds.mjs` reproduces the checked-in fixture exactly.

## Tests

Written by the Fable reviewer (verdict: no problem):

- `server/src/tests/tokens.test.ts` (32 tests):
  - browser parity for all fifteen families over seven texts (ASCII, mixed scripts, chat markup,
    empty, combining marks with ZWJ and RTL, special-token text, and a 120,000-character input
    checked by count and hash);
  - the tiktoken special-token rejection, with the client's message;
  - a plain-Node child process with cold concurrent loads of every family on two sets plus duplicate
    requests, from a `dist/token`-only root;
  - the `loadAll` entry as a child process (exit 0 from the repository root; exit 1 with per-family
    errors from an empty root);
  - the `dispose` contract and failed-load retries;
  - payload resolution (public first, the `dist` fallback, exact bytes, the missing-file error, and
    a permission error that propagates).
- `server/src/tests/fixtures/tokens/browser-ids.json` and its `README.md`: the browser-captured
  ids, with provenance. The expectations come from the client path, never from the server.

Astra's testing advice, as Fable judged it: items 1 to 4 necessary and done; item 5 covered by the
child-process tests (resident set and throughput are not asserted); item 6 belongs to the baseline
capture and slice 4.

## Stop A: in the image (2026-10-01)

The image built from `70083414` (`docker build`, Node 24.21.0, x64) has no `public/`, so the
payloads resolve from `dist/token/`. `node server/src/prompt/tokenizers/loadAll.ts /app` exits 0:
all fifteen families load (6 to 793 ms each; GLM4 and GLM5 are the slowest), and the smoke counts
of every family match the local run exactly. The process ends at 655 MB resident with every
family loaded.
