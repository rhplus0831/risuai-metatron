# Slice: Memory On The Server

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 5 (the memory algorithms move
with the pipeline; embeddings move to a server vector store) and the local-model parts of steps 4
and 9 (captioning, local Transformers.js generation); PLAN.md Decision 5.

Depends on: `prompt-assembly`, `request-layer-and-llm-secrets`, `job-channel`. Contingent on
Phase 3 for the section holding `supaMemoryKey`, `hypaMemoryKey`, `voyageApiKey`,
`hypaCustomSettings.key` (its drafts put them in `secrets`, client-readable; the server reads
them from there).

## Scope

Allowed files: `server/src/prompt/memory/{supaMemory,hypav2,hypav3,hanurai}.ts` (ports),
`server/src/prompt/embeddings.ts` (new: the processor), `server/src/data/vectorCache.ts` (new: a
separate SQLite file `save/data/vectors.sqlite`), `server/src/prompt/transformers.ts` (new: the
Node Transformers.js wrapper for embeddings, captioning, summarization, and `runTransformers`
generation), `server/src/prompt/runner.ts` (the memory branch, captioning, `requestWebLLM`),
`server/src/data/snapshots.ts` only to exclude the cache file, `src/ts/process/memory/*` and
`src/lib/Others/HypaV3Modal/*` only for the modal's `summarize` call becoming an `aux` request.
Tests belong to the review step.

Identifiers (verified 2026-09-30): `supaMemory(...)` (`supaMemory.ts:12-20`; `globalFetch` 210,
`HypaProcesser` 135, `runSummarizer` 189, `requestChatData` 268); `hypaMemoryV2(...)`
(`hypav2.ts:302-314`; `HypaProcesser` 560, `runSummarizer`, `requestChatData` 101);
`hypaMemoryV3(...)` (`hypav3.ts:57-64`; `hypaV3ProgressStore` 292-638; WebLLM `chatCompletion`
95 and 1524 for local models through `webllm.ts` (`@mlc-ai/web-llm`); `HypaProcessorV2` 499-504
and `HypaProcesserEx` 1152; `summarize` 1455); `hanuraiMemory(...)` (`hanuraiMemory.ts:9-16`;
`alertError` 68). Embeddings: `HypaProcesser` (`hypamemory.ts:32-227`; LocalForage `hypaVector`
40-42; `getEmbeds` 69-130; keys `text + '|' + model` plus the custom-model suffix 156-165),
`HypaProcessorV2` (`hypamemoryv2.ts:30-60`; its own `hypaVector` instance 35-37;
`"gpu" in navigator` 370). `transformers.ts`: `runEmbedding` (74-110, `caches.open("tfCache")`
22, device `webgpu` or `wasm`), `runSummarizer` (63-69), `runImageEmbedding` (112-118,
`Xenova/vit-gpt2-image-captioning`), `runTransformers` (46-61, text generation; called by
`requestWebLLM` in `request.ts:1514-1547`). Other users of `HypaProcesser` the server services:
`scripts.ts` dynamic assets (400-443), `scriptings.ts` `similarity` (417-424), `triggers.ts`
`v2CheckSimilarity` (730), `embedding/addinfo.ts`, `mcp/graphmem.ts`, the embedding emotion mode
(`index.svelte.ts:2347-2384`); the browser keeps `PlaygroundEmbedding.svelte` (uses
`HypaProcesser` directly) and `CharConfig.svelte` `registerOnnxModel`, `tts.ts` `runVITS`. Memory
results are persisted with `setChatMeta` in the client pipeline; on the server they are `meta`
ops in the job's writes.

Stopping condition: a local model path that the in-slice check shows cannot run in Node with the
installed backend; the algorithm then reports an explicit error for local models and the owner
decides between "unsupported on the server" and a client callback.

## Assumptions

- The runner's memory branch has the client's signature and persists the returned data with the
  reply.
- `@huggingface/transformers` imports under plain Node (checked 2026-09-30); whether its Node
  backend runs the embedding, captioning, summarization, and text-generation pipelines with
  acceptable memory is measured at the start of this slice and recorded here before the
  algorithms are ported.

## Proposed decisions

- Vector cache (proposed): a separate `save/data/vectors.sqlite` (`model`, `textHash`, `vector`
  blob, `createdAt`), keyed as the client keys `hypaVector` (model identity plus text; the
  contextual group hash for Voyage), excluded from snapshots, archives, and restore (a
  rebuildable cache needs neither), cleared and rebuilt after a restore, bounded by an LRU size
  (proposed 256 MiB) with periodic trimming. No migration of browser vectors. Alternative: a table
  in `resources.sqlite` (rejected: it would need snapshot and restore integration for cache data).
- Providers (proposed): Voyage contextual, custom URL, and OpenAI embeddings through Node `fetch`
  with the server-side keys; local Transformers.js models on the Node backend when the in-slice
  check passes, otherwise "local models are unsupported on the server" as an explicit error
  (recorded). The same check covers captioning (`runImageEmbedding`, wired into the runner's
  multimodal branch), `runSummarizer`, and `runTransformers` for `LLMFormat.WebLLM`
  (`requestWebLLM` is Transformers.js, not WebLLM). `hypav3.ts`'s WebLLM path (`@mlc-ai/web-llm`)
  cannot run in Node: an explicit error for that selection (recorded; owner question whether a
  client callback is wanted instead).
- Progress: `hypaV3ProgressStore` writes become `progress` notices; the modal's resummarize goes
  through an `aux` request.
- The dynamic-asset callback of the regex engine, Lua `similarity`, `v2CheckSimilarity`,
  `additionalInformations`, `graphmem`, and the embedding emotion mode get the server processor
  from this slice.
- `taskRateLimiter.ts` is pure and moves as is.

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`; the in-slice Node backend check
recorded here; the review step adds `server/src/tests/embeddings.test.ts` (the cache file, keys
with the model identity, a fake embedding upstream, the contextual group hash, the LRU trim, the
cache surviving a restore untouched but cleared) and extends `assemble.test.ts` with a memory
fixture per algorithm against canned summaries (the memory card position and the persisted data
equal the client's). Manual: a HypaV3 chat sends with the flag on, the modal shows the summaries
after reload; a model without image input gets a caption for an inlay.

## Residual risk

Summaries produced on the server and on the client for the same chat can differ by provider
nondeterminism; the golden test uses canned responses. The browser keeps `hypaVector` and
`tfCache` for the playground and the remaining browser Transformers users; they are not unused
caches (see `cutover-and-docs`).
