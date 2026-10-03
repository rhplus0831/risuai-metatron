# Long-Term Memory and Embeddings

## Scope

- Owns: the summarization and retrieval memory algorithms (SupaMemory, HypaMemory V2, HypaMemory V3, Hanurai), the embedding processors, the rate limiter, local Transformers.js models, the HypaV3 editor modal, the progress overlay, and the embedding playground.
- Paths: `src/ts/process/memory/*`, `src/ts/process/transformers.ts`, `src/lib/Others/HypaV3Modal.svelte`, `src/lib/Others/HypaV3Modal/*`, `src/lib/Others/HypaV3Progress.svelte`, `src/lib/Playground/PlaygroundEmbedding.svelte`; the server copies in `server/src/prompt/memory/*`, `server/src/prompt/embeddings.ts`, `server/src/prompt/transformers.ts`, `server/src/prompt/transformersWorker.ts`, `server/src/data/vectorCache.ts`; `shared/taskRateLimiter.ts`.
- Not here:
  - Where memory plugs into the prompt → `chat-pipeline.md` (`sendChat`, memory step).
  - Settings UI placement → `settings-i18n.md` (`OtherBotSettings.svelte`).

## Files

Algorithms:

- SupaMemory, HypaV2, and Hanurai run only in the server job since the Phase 5 cutover (`server/src/prompt/memory/`, below); their browser copies were removed with the browser generation path. Their data shapes stay in `shared/memory.ts` (`HypaV2Data`, `SerializableHypaV2Data`, `convertOldToNewHypaV2Data`); `Chat.supaMemoryData` is `lastId + '\n' + text`, or `hypa:\n` followed by JSON `HypaData[]` (`asHyper`).
- `memory/hypav3.ts`: the V3 implementation the tab keeps for the modal (resummarize, reroll); a send's V3 step is the server's port.
  - Entry: `hypaMemoryV3`. Dispatches to `hypaMemoryV3Main`, or to `hypaMemoryV3MainExp` when the active preset has `useExperimentalImpl`.
  - Exports: `summarize(oaiMessages, isResummarize?, context?)` (`context`: the `SummarizeContext` of the send or the modal action, its chat and plugin call context, passed to `requestChatData`), `getCurrentHypaV3Preset`, `createHypaV3Preset` (re-exported from `shared/hypaV3Presets.ts`; keeps a valid `id` or assigns one), `HypaV3Settings`, `SerializableHypaV3Data`, `SerializableSummary`.
  - Private: the processor subclass `HypaProcesserEx`.

Embedding processors:

- `memory/hypamemory.ts`: the shared V1 embedding engine, used well beyond memory.
  - `HypaProcesser` has `addText`, `similaritySearchScored`, and `getEmbeds`.
  - Also exports the `HypaModel` union, the `localModels` registry, and `similarity`/`cosineSimilarity`/`contextHash`.
- `memory/hypamemoryv2.ts` `HypaProcessorV2`: the newer generic processor, used only by experimental V3. Supports batching, rate limits, and grouped contextual documents.
- `memory/contextualEmbedding.ts`: `ContextualEmbeddingProvider`, `isContextModel`, `getContextProvider`. Voyage Context 3 (`voyageApiKey`) is the only provider.
- `shared/taskRateLimiter.ts` `TaskRateLimiter` (re-exported by `memory/taskRateLimiter.ts`; the server's memory code uses the same file): per-minute and concurrency limits, `failFast`, `TaskCanceledError`.
- `process/transformers.ts`: Transformers.js wrappers backed by Cache Storage `tfCache`.
  - `runEmbedding`: caches only the extractor, not the vectors.
  - `runSummarizer`, `runImageEmbedding` (captioning), `runVITS`, `runTransformers`.

UI:

- `HypaV3Modal.svelte` and its children in `HypaV3Modal/` edit a synced copy of the current chat's `hypaV3Data` (passed down as the `hypaV3Data` prop) and save every change with `setChatMeta`: search, filters, categories, tags, bulk edit, resummarize, reset, and V2→V3 conversion. A send's memory data is written by the job (below).
- The modal's resummarize and reroll actions capture the open chat (`currentChatRef`) and its plugin context (`capturePluginContext`) when the action begins and pass them to `summarize`, so the request is that chat's whatever is selected when it runs.
- `HypaV3Modal/utils.ts` `processRegexScript`: routes messages through `risuChatParser` and the server transform's `editprocess` (`serverProcessScript`; `scripts-triggers.md`); without a context (a chat not saved on the server yet) the CBS-parsed text stays.
- `HypaV3Progress.svelte` renders `hypaV3ProgressStore`.

## Flows

Selection, in `sendChat`:

- Memory runs only when `nowChatroom.supaMemory` is set on the character or group.
- The priority order is `db.hanuraiEnable` → `db.hypav2` → `db.hypaV3` → otherwise `supaMemory` (as selected by `supaModelType`).
- The result is written back to the current chat: `hypaV2Data`, `hypaV3Data`, or `supaMemoryData`.
- `memoryAlgorithmType` is written by the UI and never read.

V3 standard flow:

1. Summarize the oldest eligible chats into `Summary {text, chatMemos:Set<string>, isImportant, categoryId?, tags?}`.
2. Select summaries within the memory token budget, in the order important → recent → similar (embeddings) → random.
3. Record the selection in `metrics`.
4. Prepend a `<Past Events Summary>` card with `memo:'supaMemory'`.

V3 `summarize`:

1. Replaces inlay tokens with `[Image]`.
2. Expands `{{slot}}` and runs `parseChatML`.
3. Calls `requestChatData(..., 'memory')` for the submodel, or WebLLM `chatCompletion` for local models.
4. Strips thought blocks from the result.

Embedding routing:

- `HypaProcesser.getEmbeds` tries, in order: contextual Voyage, then `localModels` (Transformers.js), then custom or OpenAI APIs through `globalFetch`.
- Vector records are cached in LocalForage `hypaVector`.

## Server (Phase 5 slice 10)

A send's memory step runs in the job (`server/src/prompt/assemble.ts`, the gate and priority of the former browser `sendChat`). The browser code above serves the HypaV3 modal and the playground.

- `server/src/prompt/memory/{supaMemory,hypav2,hypav3,hanurai}.ts`: the four algorithms, ported statement for statement. Each takes a `MemoryHost` (`memory/host.ts`) first: the job's settings projection, `tokenize`, `request` (the job's `memory` request with its `request` trigger and fallback models), `completions` (OpenAI's `/v1/completions` with the stored memory key; an answer that is not JSON is a failure, and a successful one that carries the key is refused, as the browser path's proxy refuses it), `summarizer`, the job's `EmbeddingEnv`, `parseChatML` with the job's CBS, the effective persona's name, `progress`, `random`, `redact`, `fence`, and the run's signal. The client's console output is not ported (it prints the chat).
- Persistence: `assemblePrompt` writes what an algorithm returns as a `meta` operation on the chat as stored then (`AssemblyHost.writeMemory`): `hypaV2Data` on success; `hypaV3Data` on success and with a returned error; `supaMemoryData` and `lastMemory` with the stored values as fallbacks; nothing for Hanurai. The write happens before the provider request, as in the tab, and a preview makes it too. An algorithm's error is the send's `throwError`; Hanurai's "too many tokens" is the job's error without the inlay error message (the tab alerts).
- `server/src/prompt/embeddings.ts`: `HypaProcesser`, `HypaProcessorV2`, and the Voyage provider on an `EmbeddingEnv` bound to one job (`createEmbeddings(...).forJob`). The cache keys are the client's. The providers are called from the server: OpenAI with `llmSecrets.supaMemoryKey`, Voyage and the custom URL with the keys in `secrets`. A provider's answer is checked before it is ranked or stored (the expected count, finite numbers, one length), and every error text is redacted of the three keys (a value of whitespace only is not a key). `HypaProcesser.testText` is not ported (nothing calls it). `HypaProcessorV2`'s local batch size is the server's core count (at most 10).
- `server/src/data/vectorCache.ts`: the vectors, in `save/data/vectors.sqlite` (see `self-host-server.md`). One cache for all clients; browser vectors are not migrated.
- `server/src/prompt/transformers.ts` and `transformersWorker.ts`: the local models in one child process (embeddings, the `distilbart` summarizer, the captioner, text generation), one task at a time. Model files come from `huggingface.co` into `save/models/transformers` (the browser's mirror is not used). The `GPU` embedding variants run the same model on the CPU.
- HypaV3's local summarization models (`summarizationModel` other than `subModel`) need the browser's WebLLM engine: on the server a summary with such a preset fails with `Local summarization models are unsupported on the server`. A send that needs no new summary still works.
- HypaV3's progress overlay is fed by `progress` notices; the tab closes an overlay a job left open when that job ends (`jobChannel.ts` `endJobChannel`), since an abort closes the job's channel before a closing notice can arrive. The random selection draws from the job's random source.
- Other users of the server embeddings: `additionalInformations` and image captions in `assemblePrompt`, the dynamic-asset step of `server/src/prompt/scripts.ts` (never reached by the two server script modes yet), Lua `similarity` and `v2CheckSimilarity` (`LuaBindingServices.similarity`).

## State

- DB settings:
  - Algorithm flags: `hypaMemory`, `hypav2`, `hypaV3`, `hanuraiEnable`, `hanuraiSplit`, `hanuraiTokens`, `memoryAlgorithmType` (unused).
  - Models and keys: `hypaModel`, `supaModelType`, `supaMemoryKey`, `voyageApiKey`.
  - Sizing: `hypaChunkSize`, `hypaAllocatedTokens`, `hypaCustomSettings`.
  - Presets: `hypaV3Presets`, `hypaV3PresetId` (the selected preset's id; `selectedHypaV3Preset` in `shared/hypaV3Presets.ts` resolves it, falling back to the first). Both travel in the `hypaV3Presets` record as `{ items, selectedId }`.
- Per-chat fields: `supaMemoryData`, `hypaV2Data`, `hypaV3Data`, `lastMemory`.
- Stores: `hypaV3ModalOpen`, `hypaV3ProgressStore`.

## Coupling

- The tab's HypaV3 depends on `requestChatData`, `webllm`, `ChatTokenizer`, `parseChatML`, `risuChatParser`, `inlayTokenRegex`, localforage, and Transformers.js. The server ports depend on `MemoryHost` only.
- Users of the tab's `HypaProcesser`: `files/multisend.ts`, `mcp/graphmem.ts` (the tab's graph memory host), HypaV3, and the playground. Dynamic assets, Lua `similarity`, and the similarity effects use the server's (`server/src/prompt/embeddings.ts`).

## Invariants

- Never persist a runtime `Set`. Use the `toSerializable*` and `to*Data` converters in both directions.
- `chatMemos` reference `Message.chatId` values. Rewriting chat IDs orphans summaries, which get cleaned unless `preserveOrphanedMemory` is set.
- The memory card `memo` values `supaMemory` and `hypaMemory` are special-cased later in prompt assembly (`assemblePrompt`). Do not rename them.
- V3 token accounting reserves memory tokens, subtracts `db.maxResponse`, and keeps `queryChatCount` recent chats. Behavioral changes must be applied to both `hypaMemoryV3Main` and `hypaMemoryV3MainExp`.
- A HypaV3 or processor change is made in both copies: `src/ts/process/memory/` (HypaV3, `HypaProcesser`) and `server/src/prompt/memory/` with `server/src/prompt/embeddings.ts`; SupaMemory, HypaV2, and Hanurai exist only on the server. The server copies keep the former client statements and texts.
- The embedding keys stay inside `embeddings.ts` and the runner's `MemoryHost`: no CBS text, Lua value, notice, error, log line, or cache row carries one.
- Embedding cache keys must include the model identity. Voyage contextual keys also include the group hash. `testText` caches by raw text only.
- Adding a local embedding model means updating `HypaModel`, `localModels.models`, `localModels.gpuModels`, the narrower `EmbeddingModel` union in `transformers.ts`, and the options in both settings and the playground.
- `TaskRateLimiter` rejects `maxConcurrentTasks > tasksPerMinute`.

## Recipes

- Add or change a top-level algorithm: the selector in `OtherBotSettings.svelte`, the DB fields and defaults in `setDatabase`, and the branch plus persistence in the server's `assemblePrompt`. Verify the `supaMemory` gate and the priority order.
- Add an embedding model: `hypamemory.ts` (`HypaModel`, `localModels`, `getEmbeds`), `hypamemoryv2.ts:getAPIEmbeds`, `transformers.ts` `EmbeddingModel`, and the UI options.
- Add a contextual provider: `contextualEmbedding.ts`, the grouped paths in `HypaProcessorV2`, and `HypaProcesserEx.addSummaryChunksContextual`.
- Change V3 behavior: both V3 mains, `HypaV3Settings`, `createHypaV3Preset`, and the settings bindings.
- Add summary metadata: the serializable types in `shared/memory.ts` (with `HypaV3Data`, `Summary`, and `DISPLAY_MODE`), `HypaV3Modal/types.ts`, the modal, and its child components. Keep the modal's `$derived`/`$effect.pre` patterns.

## Tests

- `src/ts/process/memory/hypaV3Presets.test.ts`: `selectedHypaV3Preset` (by id, the first-preset fallback, no state write, undefined for an empty list).
- `src/lib/Setting/Pages/OtherBotSettings.hypaV3Export.test.ts` (mounted under happy-dom): the HypaV3 preset export button writes exactly `{ type: "risu", ver: 1, data: { name, settings } }` without the id, and the import button gives that file a fresh id and selects it.
- `src/ts/process/memory/memoryOracle.test.ts` (Phase 5 slice 10; narrowed at the cutover to the client copy that stays): the tab's HypaV3 (standard and experimental) runs the V3 scenarios of `server/src/tests/fixtures/memory/scenarios.ts` over fake dependencies, and each outcome must equal `server/src/tests/fixtures/memory/algorithms.json` (recorded from the browser path before the cutover; the server ports of all four algorithms are held to the whole fixture by `server/src/tests/memoryAlgorithms.test.ts`, and nothing recaptures it from the server). It also pins the summary requests' `chatRef` and `pluginContext`.
- `server/src/tests/embeddings.test.ts`, `vectorCache.test.ts`, `transformers.test.ts`, `memoryJobs.test.ts` (`self-host-server.md`): the server processors and cache, the model process, and memory on a real server job.
- Not covered: the modal, the rate limiter on its own, the browser Transformers wrappers.

## Known Hazards

- `memoryAlgorithmType` can disagree with the actual boolean flags on old saves.
- `voyageApiKey` and `hypaCustomSettings.key` are in the client-readable `secrets` section (Phase 3): the tab reads them, and the job's settings projection holds them. Only `supaMemoryKey` is write-only.
- The embedding cache key names the model, not the endpoint: a custom server changed under the same model name reuses the old vectors. The Voyage group hash is a 32-bit hash of the group's texts. Both are the client's rules, kept on the server, where the cache is shared by every client.
- The server and the tab do not share vectors or model files, and their local models can differ in weights revision and kernels: a ranking near a tie can differ between the two paths.
- In the tab, `parseChatML` evaluates a summary prompt's CBS without a chat context (the selection as it is when the summary runs), while the summary request carries the send's or the modal action's context. The server evaluates both for the job's chat.
- On the server, HypaV3's `summaryChunkSeparator` regular expression, the dot products, and the sorts run on the main thread, outside the CBS limits.
- The catalogue's Transformers.js generation models publish no 8-bit `model_quantized.onnx`: they do not load in the browser. The server loads their `fp32` weights, so a job can use `opt-350m` and `tiny-random-mistral`; `gpt2-large-conversational` has no usable file in either place.
- The Transformers `EmbeddingModel` union names only MiniLM and nomic, while `localModels` lists more models.
