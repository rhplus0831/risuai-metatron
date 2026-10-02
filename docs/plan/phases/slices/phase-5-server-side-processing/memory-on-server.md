# Slice: Memory On The Server

Status: implemented (2026-10-03). The sections from "Scope" to "Residual risk" are the plan as
drafted; "What landed" and the sections after it record what was built and decided.

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

## What landed

Files beyond the drafted list: `server/src/prompt/memory/host.ts` (`MemoryHost`),
`server/src/prompt/transformersWorker.ts`, `shared/taskRateLimiter.ts` (moved; the client file
re-exports it), `server/src/app.ts`, `server/src/jobs/runSetup.ts`, `server/src/prompt/assemble.ts`,
`server/src/prompt/scripts.ts`, `server/src/prompt/triggers.ts`, `server/src/lua/bindings.ts`,
`server/src/lua/runtime.ts`, `server/src/llm/{request,requests,context}.ts`,
`src/ts/process/index.svelte.ts`, `src/ts/network/jobChannel.ts`. `server/src/data/snapshots.ts`
did not change: a snapshot and an archive copy only `resources.sqlite`.

- **Backend check** (Node 24 on the host and in the image `node:24-slim`, `@huggingface/transformers`
  3.8.1 with `onnxruntime-node` 1.21.0 and `sharp`, files from `huggingface.co`): all four pipelines
  run, so the stopping condition is not met.

  | pipeline                         | model                                           | result                                                                          | resident while loaded           |
  | -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
  | feature-extraction, `q8`         | `Xenova/all-MiniLM-L6-v2`                       | 384 dimensions, the same vector on the host and in the image; 22 ms for 2 texts | about 0.25 GB                   |
  | feature-extraction, `q8`         | `nomic-ai/nomic-embed-text-v1.5`                | 768 dimensions; 1.3 s for 50 texts                                              | about 0.6 GB                    |
  | image-to-text, `q8`              | `Xenova/vit-gpt2-image-captioning`              | a caption; 2.3 s with a warm file cache                                         | about 0.9 GB (2.5 GB at `fp32`) |
  | summarization, `q8`              | `Xenova/distilbart-cnn-6-6`                     | a summary; 3.4 s                                                                | about 1.0 GB (2.9 GB at `fp32`) |
  | text-generation, default weights | `Xenova/tiny-random-mistral`, `Xenova/opt-350m` | text; `opt-350m` 83 s with its 1.3 GB download                                  | the `fp32` weights              |

  The catalogue's generation models publish no `model_quantized.onnx`, so they do not load in the
  browser at all; the server loads their default weights. `Xenova/gpt2-large-conversational` has no
  usable file in either place.

- **The model process.** The models run in one child process (`transformers.ts`,
  `transformersWorker.ts`), not on the main thread and not in a worker thread: ending a worker
  thread in the middle of native inference aborted the whole Node process
  (`terminate called after throwing an instance of 'Napi::Error'`). Measured with the process: the
  server's main thread lags at most 7 ms during a 1.3 s inference and during model loads, and its
  memory stays at about 72 MB.
- **The vector cache** (`vectorCache.ts`), **the embeddings** (`embeddings.ts`), **the four
  algorithms** (`memory/`), **the memory step, `additionalInformations`, and the caption**
  (`assemble.ts`, `runner.ts`), **the dynamic-asset step** (`scripts.ts`), **similarity**
  (`bindings.ts`, `runtime.ts`, `triggers.ts`), **`LLMFormat.WebLLM` for a job** (`llm/`), and
  **P10** on the client: as `docs/structure/memory.md` ("Server") and `self-host-server.md` describe
  them.
- **HypaV3's WebLLM summarization models** are refused where a local summary is needed (owner
  answer 5).

## Plan review (GPT-6-Astra, 16 points) and decisions

1. The credential contract: **adopted as the alternative**. `voyageApiKey` and
   `hypaCustomSettings.key` stay in the client-readable `secrets` section (Phase 3; the amendment
   "the others from `secrets`"). Server memory adds no disclosure, and the exception is recorded.
   Moving the two keys to `llmSecrets` would need server-side injection for the browser consumers
   that stay: a later decision.
2. Redaction on every outward path, and validated vectors: **adopted**.
3. Event-loop isolation: **adopted**, as a child process (see above).
4. Cancellation, queue recovery, maintenance fencing: **adopted**.
5. The capacity claim: **adopted**: the embedding pipeline is disposed before a heavier one, the
   process ends after 5 idle minutes, and the docs give figures instead of a bound.
6. The implicit CBS and identity context: **adopted**.
7. The P10 call-site map: **adopted**. The client's ChatML CBS parse keeps reading the selection
   (recorded as a hazard); the server evaluates it for the job's chat.
8. Hanurai's error: **adopted**: `{ type: "alert" }`, the job's error without the inlay message.
9. Persistence timing and merge: **adopted**. The assumption above ("with the reply") was wrong:
   the client writes the memory data before the provider request, and so does the server.
10. Cache key and object shapes: **adopted** (vector-only adapters; a `HypaProcessorV2` hit has no
    `id`, as on the client).
11. The inherited cache identity: **adopted as recommended**: kept and recorded.
12. The cache bound: **adopted** (a bound on vector bytes; oversize entries skipped).
13. The WebLLM port: **adopted**.
14. Output parity between the two backends: **recorded**; the vector comparison went to the review
    as testing advice.
15. The remaining consumers and the strict recount: **adopted**. The recount is
    `tsc -p server/tsconfig.json` over the moved and ported files: the annotations are non-null
    assertions, `as string` on `memo`, and typed nullables in the rate limiter.
16. Both the challenge and the review ran.

## Challenge (GPT-6-Astra, two rounds)

A differential run of the client's algorithms and processors against the ports (108 cases: the four
algorithms, both HypaV3 implementations, local, custom, and Voyage embeddings) found no difference.

Round 1, seven defects, all fixed:

1. A successful completions answer that carried the memory key went into the summary: now refused,
   as the browser path's proxy refuses it.
2. An abort during a failed spawn left the next model task waiting for ever.
3. A new model process could start while a killed one was still exiting, and `dispose` did not wait
   for it: process lifetime is now serial.
4. A failed cache clear kept serving the old vectors: the cache now belongs to the resource
   database's epoch and answers nothing until an emptying succeeds.
5. A forced job end could leave HypaV3's progress overlay open: the tab closes it when the job ends.
6. The cache key hash merged strings that differ only in lone surrogates: hashed as UTF-16.
7. A completions answer that is not JSON gave a `TypeError` text instead of the provider's.

Round 2, four defects, all fixed: a synchronous spawn failure stopped the queue; an error of a live
process and a rejected kill were treated as an exit; another job's closing notice hid the showing
job's overlay; a whitespace-only unused key made every summary look like it carried a credential.

Recorded, not changed: the redactor does not match a percent-encoding with lowercase escapes; a
cancelled rate-limited batch leaves its timer running for up to a minute; the cache trim runs on the
main thread; the process is not a memory boundary.

## Live check

A fresh server with the flag on, a mock chat provider, and a mock embedding server (42 checks in one run):
each algorithm's summary requests, memory card, and stored data; the vector cache reused on a second
send; the tab's chat after a reload; a failing summary; an embedding error that echoes the key (in
no error, frame, or log line); HypaV3's error path keeping earlier summaries; progress notices; a
send with local MiniLM embeddings while other requests answer in 23 ms; `additionalInformations`;
Lua and native similarity; a caption; a local generation model as the main model. The model process
was also run inside the image (the same vectors, a kill on abort, a restart).

## Review

The reviewer found no problem and wrote the tests: the client algorithms as an oracle
(`src/ts/process/memory/memoryOracle.test.ts`, 44 scenarios recorded in
`server/src/tests/fixtures/memory/algorithms.json`), the ports against that fixture
(`memoryAlgorithms.test.ts`), the jobs end to end against mock providers (`memoryJobs.test.ts`),
and the cache, the model process, and the embeddings (`vectorCache.test.ts`,
`transformers.test.ts`, `embeddings.test.ts`).

After the challenge, the test adaptation found that the prelude's JSON wrapper gave a refused
`similarity` call a null userdata instead of `nil`. `similarity` and `simpleLLM` (the same wrapper
since slice 8a) now use `__decoded`, which keeps `nil`.

Not pinned end to end: the runner's check of a completions answer for the memory key (its parts are
pinned; the OpenAI and Voyage URLs are fixed, and the server context has no fetch seam for the
embeddings service), captions and local generation (they need a model), and the modal's capture of
its chat when an action begins.
