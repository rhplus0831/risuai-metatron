# Slice: Tokenizer Node Spike

Status: planned (drafted 2026-09-30, refined after review, not started).

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
remote, `google.accessToken` as a bearer token), `geminiTokenizer` (342-368, unused). Families and
payloads under `public/token/`: `claude/claude.json`, `cohere/tokenizer.json`,
`deepseek/tokenizer.json`, `deepseek/v4/tokenizer.json`, `gemma/tokenizer.model`,
`glm4/tokenizer.json`, `glm5/tokenizer.json`, `llama/llama.model`, `llama/llama3.json`,
`mistral/tokenizer.model`, `nai/nerdstash_v2.model`, `trin/spiece.model` (1-17 MiB each).
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
  exported by the package, and is byte-equivalent to `src/etc/o200k_base.json` (same `pat_str`,
  two special tokens, identical `bpe_ranks`; verified 2026-09-30).
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
- Memory (proposed): lazy per-family loading with one cached instance per family, as the client
  does (`tokenizer.ts:264-267`); the spike records the resident set after loading every family.

## Validation

`pnpm check`, `pnpm format:check`; the spike's `loadAll` entry run with plain `node` from the
repository root and from a directory holding only `dist/token/` plus `node_modules` (the image
shape), printing per family: loaded (ms), the token counts of three fixed strings compared with the
client's counts captured once in the browser (actual encoding, not module loading), and the
resident set. The review step turns the per-family checks into `server/src/tests/tokenizers.test.ts`.

## Residual risk

The counts must match the client's for the golden prompt test to hold; a family whose Node build
differs from the browser build would surface there. The `vm` shim depends on the UMD wrapper shape
of `@mlc-ai/web-tokenizers` 0.1.6; a version bump needs a re-check.
