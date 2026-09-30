# Long-Term Memory and Embeddings

## Scope

- Owns: the summarization and retrieval memory algorithms (SupaMemory, HypaMemory V2, HypaMemory V3, Hanurai), the embedding processors, the rate limiter, local Transformers.js models, the HypaV3 editor modal, the progress overlay, and the embedding playground.
- Paths: `src/ts/process/memory/*`, `src/ts/process/transformers.ts`, `src/lib/Others/HypaV3Modal.svelte`, `src/lib/Others/HypaV3Modal/*`, `src/lib/Others/HypaV3Progress.svelte`, `src/lib/Playground/PlaygroundEmbedding.svelte`.
- Not here:
  - Where memory plugs into the prompt → `chat-pipeline.md` (`sendChat`, memory step).
  - Settings UI placement → `settings-i18n.md` (`OtherBotSettings.svelte`).

## Files

Algorithms:

- `memory/supaMemory.ts` `supaMemory`: the older summarizer and the fallback branch. It persists `Chat.supaMemoryData` in one of two formats:
  - `lastId + '\n' + text`, or
  - `hypa:\n` followed by JSON `HypaData[]`, used when `arg.asHyper` is set.
- `memory/hanuraiMemory.ts` `hanuraiMemory`: pure retrieval with no summaries.
  1. Embeds the recent chats.
  2. Scores the last 3 chats as queries.
  3. Trims the history.
  4. Prepends a `memo:'supaMemory'` card.
- `memory/hypav2.ts` `hypaMemoryV2`: the active V2 algorithm.
  - Chunked summaries plus `HypaProcesser` retrieval, wrapped in `<Past Events Summary>`/`<Past Events Details>`.
  - Types (declared in `shared/memory.ts`, re-exported): `HypaV2Data` (runtime, uses `Set`), `SerializableHypaV2Data` (arrays). `convertOldToNewHypaV2Data` converts the legacy shape.
  - `regenerateSummary` is an empty stub.
- `memory/hypav3.ts`: the current V3 implementation.
  - Entry: `hypaMemoryV3`. Dispatches to `hypaMemoryV3Main`, or to `hypaMemoryV3MainExp` when the active preset has `useExperimentalImpl`.
  - Exports: `summarize`, `getCurrentHypaV3Preset`, `createHypaV3Preset` (re-exported from `shared/hypaV3Presets.ts`; keeps a valid `id` or assigns one), `HypaV3Settings`, `SerializableHypaV3Data`, `SerializableSummary`.
  - Private: the processor subclass `HypaProcesserEx`.

Embedding processors:

- `memory/hypamemory.ts`: the shared V1 embedding engine, used well beyond memory.
  - `HypaProcesser` has `addText`, `similaritySearchScored`, and `getEmbeds`.
  - Also exports the `HypaModel` union, the `localModels` registry, and `similarity`/`cosineSimilarity`/`contextHash`.
- `memory/hypamemoryv2.ts` `HypaProcessorV2`: the newer generic processor, used only by experimental V3. Supports batching, rate limits, and grouped contextual documents.
- `memory/contextualEmbedding.ts`: `ContextualEmbeddingProvider`, `isContextModel`, `getContextProvider`. Voyage Context 3 (`voyageApiKey`) is the only provider.
- `memory/taskRateLimiter.ts` `TaskRateLimiter`: per-minute and concurrency limits, `failFast`, `TaskCanceledError`.
- `process/transformers.ts`: Transformers.js wrappers backed by Cache Storage `tfCache`.
  - `runEmbedding`: caches only the extractor, not the vectors.
  - `runSummarizer`, `runImageEmbedding` (captioning), `runVITS`, `runTransformers`.

UI:

- `HypaV3Modal.svelte` and its children in `HypaV3Modal/` edit a synced copy of the current chat's `hypaV3Data` (passed down as the `hypaV3Data` prop) and save every change with `setChatMeta`: search, filters, categories, tags, bulk edit, resummarize, reset, and V2→V3 conversion. `sendChat` saves the memory data the memory functions return the same way (they get a detached copy of the chat).
- `HypaV3Modal/utils.ts` `processRegexScript`: routes messages through `risuChatParser` and `processScriptFull(..., 'editprocess')`.
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

## State

- DB settings:
  - Algorithm flags: `hypaMemory`, `hypav2`, `hypaV3`, `hanuraiEnable`, `hanuraiSplit`, `hanuraiTokens`, `memoryAlgorithmType` (unused).
  - Models and keys: `hypaModel`, `supaModelType`, `supaMemoryKey`, `voyageApiKey`.
  - Sizing: `hypaChunkSize`, `hypaAllocatedTokens`, `hypaCustomSettings`.
  - Presets: `hypaV3Presets`, `hypaV3PresetId` (the selected preset's id; `selectedHypaV3Preset` in `shared/hypaV3Presets.ts` resolves it, falling back to the first). Both travel in the `hypaV3Presets` record as `{ items, selectedId }`.
- Per-chat fields: `supaMemoryData`, `hypaV2Data`, `hypaV3Data`, `lastMemory`.
- Stores: `hypaV3ModalOpen`, `hypaV3ProgressStore`.

## Coupling

- Memory depends on `requestChatData`, `webllm`, `ChatTokenizer`, `parseChatML`, `processScriptFull`, `risuChatParser`, `inlayTokenRegex`, localforage, and Transformers.js.
- Users of `HypaProcesser`:
  - `scripts.ts`: dynamic assets.
  - `scriptings.ts`: the Lua similarity API.
  - `triggers.ts`: similarity effects.
  - `files/multisend.ts`, `embedding/addinfo.ts`, `mcp/graphmem.ts`, the main pipeline, and the playground.

## Invariants

- Never persist a runtime `Set`. Use the `toSerializable*` and `to*Data` converters in both directions.
- `chatMemos` reference `Message.chatId` values. Rewriting chat IDs orphans summaries, which get cleaned unless `preserveOrphanedMemory` is set.
- The memory card `memo` values `supaMemory` and `hypaMemory` are special-cased later in prompt assembly. Do not rename them.
- V3 token accounting reserves memory tokens, subtracts `db.maxResponse`, and keeps `queryChatCount` recent chats. Behavioral changes must be applied to both `hypaMemoryV3Main` and `hypaMemoryV3MainExp`.
- Embedding cache keys must include the model identity. Voyage contextual keys also include the group hash. `testText` caches by raw text only.
- Adding a local embedding model means updating `HypaModel`, `localModels.models`, `localModels.gpuModels`, the narrower `EmbeddingModel` union in `transformers.ts`, and the options in both settings and the playground.
- `TaskRateLimiter` rejects `maxConcurrentTasks > tasksPerMinute`.

## Recipes

- Add or change a top-level algorithm: the selector in `OtherBotSettings.svelte`, the DB fields and defaults in `setDatabase`, and the branch plus persistence in `sendChat`. Verify the `supaMemory` gate and the priority order.
- Add an embedding model: `hypamemory.ts` (`HypaModel`, `localModels`, `getEmbeds`), `hypamemoryv2.ts:getAPIEmbeds`, `transformers.ts` `EmbeddingModel`, and the UI options.
- Add a contextual provider: `contextualEmbedding.ts`, the grouped paths in `HypaProcessorV2`, and `HypaProcesserEx.addSummaryChunksContextual`.
- Change V3 behavior: both V3 mains, `HypaV3Settings`, `createHypaV3Preset`, and the settings bindings.
- Add summary metadata: the serializable types in `shared/memory.ts` (with `HypaV3Data`, `Summary`, and `DISPLAY_MODE`), `HypaV3Modal/types.ts`, the modal, and its child components. Keep the modal's `$derived`/`$effect.pre` patterns.

## Tests

- `src/ts/process/memory/hypaV3Presets.test.ts`: `selectedHypaV3Preset` (by id, the first-preset fallback, no state write, undefined for an empty list).
- None cover the algorithms, processors, rate limiter, or modal.
- `scriptings.test.ts` only mocks `HypaProcesser`.

## Known Hazards

- `memoryAlgorithmType` can disagree with the actual boolean flags on old saves.
- The Transformers `EmbeddingModel` union names only MiniLM and nomic, while `localModels` lists more models.
