# LLM Requests, Model Catalogue, Tokenizers

## Scope

- Owns:
  - the model catalogue and model-ID resolution,
  - request dispatch by wire format,
  - provider request builders and stream parsers (OpenAI Chat, OpenAI Responses, Anthropic/Bedrock, Google/Vertex, NovelAI, Ooba, Ollama, Cohere, Horde, WebLLM, plugin providers),
  - parameter application,
  - tool-call loops (dispatch side),
  - tokenizers,
  - auxiliary-model routing,
  - the model-picker UI.
- Paths:
  - `src/ts/process/request/*` (including `openAI/`, `tests/`)
  - `src/ts/model/*` (including `providers/`)
  - `src/ts/process/models/{nai,local,modelString}.ts`
  - `src/ts/process/webllm.ts`
  - `src/ts/horde/getModels.ts`
  - `src/ts/tokenizer.ts`
  - `src/lib/UI/{ModelList,ModelGrid,OpenrouterProviderList,NanoGPTDashboard,NanoGPTProviderPicker}.svelte`
  - `src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte`
- Not here:
  - Transport (`globalFetch`/`fetchNative`) → `global-api.md`.
  - MCP tool definitions → `plugins-mcp.md`.
  - Prompt assembly → `chat-pipeline.md`.

## Files

- `model/types.ts`: the catalogue types. `LLMFlags`, `LLMFormat`, `LLMTokenizer`, and `LLMProvider` (persisted numeric codes) and the `LLMModel` and `LLMParameter` types are declared in `shared/llm.ts` and re-exported here (`LLMParameter` also from `request/shared.ts`).
  - Numeric enums `LLMFlags`, `LLMProvider`, `LLMFormat`, `LLMTokenizer`.
  - `LLMModel`: `id`, `name`, `internalID`, `provider`, `format`, `flags[]`, `parameters`, `tokenizer`, `endpoint`, `keyIdentifier`.
  - `ProviderNames`, and parameter presets such as `OpenAIParameters`/`ClaudeParameters`.
- `model/providers/{openai,anthropic,google}.ts`: static `LLMModel[]` catalogues.
- `model/providers/nanogpt.ts`: endpoint constants.
- `model/modellist.ts`: model registry and resolution.
  - `LLMModels`: mutable singleton assembled from the provider arrays. It also auto-derives `-response-api` variants of OpenAI models and `-vertex` variants of Google models.
  - `registerModelDynamic`: when `dynamicModelRegistry` is on, fetches model lists from Google, Anthropic, and OpenAI.
  - `getModelInfo(id)`: resolves static IDs and `hf:::`, `horde:::`, `xcustom:::`, `pluginmodel:::` IDs. Falls back to an as-is OpenAI-compatible model.
  - `getModelList`: grouped models for the UI.
- `model/{openrouter,nanogpt,ollama}.ts`: dynamic catalogue fetch, normalized to `ModelGridItem`.
- `model/ooba.ts`: re-exports `OobaChatCompletionRequestParams` from `shared/settings.ts`.
- `model/modelGrid.ts`: UI types.
- `request/request.ts`: request entry points and dispatch.
  - `requestChatData(arg, mode, abortSignal)`: the public entry. Handles fallback models, retries, plugin before/after replacers, `runTrigger('request')`, escaping, blank-response fallback, and attribution.
  - `requestChatDataMain`: picks the model, runs `reformater`, then switches on `LLMFormat`.
  - `requestPlugin`: plugin providers.
  - Also contains the legacy handlers for Ooba, NovelAI, Kobold, Horde, Cohere, WebLLM, and Echo.
- `request/shared.ts`:
  - `ModelModeExtended` = `model|submodel|memory|emotion|otherAx|translate`.
  - `applyParameters`: global parameters, or per-mode `seperateParameters` when enabled.
  - `getAdditionalParameters`/`applyAdditionalParameters`: user body/header overrides.
- `request/additionalParams.ts`: relaxed JSON parser.
- `request/openAI/requests.ts`: `requestOpenAI` (chat completions, Mistral, NanoGPT), `requestOpenAILegacyInstruct`, `getTranStream` (SSE), and `wrapToolStream`.
- `request/openAI/responses.ts`: `requestOpenAIResponseAPI`, `buildResponsesBody`, `buildResponseInputItems`, and `getResponsesTranStream`.
- `request/openAI/types.ts`: wire types.
- `request/openAI/shared.ts`: `getLocalNetworkRequestOptions`.
- `request/openAI/index.ts`: barrel.
- `request/anthropic.ts`:
  - `requestClaude`: Anthropic, Ollama-Anthropic, and AWS Bedrock with signing.
  - `requestClaudeHTTP`: SSE parsing, thinking → `<Thoughts>`, and the tool loop.
- `request/google.ts`: `requestGoogleCloudVertex` (Gemini and Vertex, with OAuth refresh), `getTranStream`, and handling of thought signatures and tools.
- `process/models/nai.ts`: NovelAI serialization and `NovelAIBadWordIds`.
- `process/models/modelString.ts`: display labels.
- `process/webllm.ts`: MLC WebLLM engine, used by Hypa summarization.
- `tokenizer.ts`: tokenizer selection and counting.
  - `encode`: LRU cache of 1500 entries keyed by text, model, and tokenizer.
  - `encodeWithTokenizer`, `tokenizerList`, `ChatTokenizer`, `tokenizeAccurate`, `strongBan`.
  - Loaders for tiktoken, Claude, Llama/Llama3, Mistral, NovelAI, NovelList, Gemma, Cohere, DeepSeek, and GLM. Tokenizer files come from `public/token/`.
- `CustomModelsSettings.svelte`: edits `db.customModels` entries `{id:'xcustom:::uuid', internalId, url, format, tokenizer, key, name, params, flags}`.

## Flows

1. Callers invoke `requestChatData`. They include `sendChat`, the translator (`'translate'`), memory (`'memory'`), emotion, triggers and Lua (`runLLM`), `Suggestion.svelte`, MCP `aiaccess`, `IrisModal` (`'otherAx'`), and the playground. Plugin v3 `runLLMModel` calls `requestChatDataMain` directly.
2. `requestChatDataMain` resolves the model:
   1. `staticModel`.
   2. Mode `model` → `db.aiModel`.
   3. Any other mode → `db.subModel`, unless `seperateModelsForAxModels` is on, in which case → `db.seperateModels[mode]`.
   4. Then `getModelInfo`, reverse-proxy and custom URL/key injection, and `reformater`.
3. `reformater` is driven by the model's `LLMFlags`. It moves system prompts, merges same-role turns, and inserts a starter user turn.
4. Dispatch by format:
   - `OpenAICompatible`/`Mistral`/`NanoGPT` → `requestOpenAI`.
   - `OpenAIResponseAPI`/`NanoGPTResponses` → `requestOpenAIResponseAPI`.
   - `Anthropic`/`NanoGPTMessages`/`AWSBedrockClaude` → `requestClaude`.
   - `GoogleCloud`/`VertexAIGemini` → `requestGoogleCloudVertex`.
   - Legacy instruct formats → `requestOpenAILegacyInstruct`.
   - The rest go to their own handlers.
5. Streams yield cumulative `StreamResponseChunk` snapshots (key `'0'`, plus metadata such as `__tool_calls`). Tool calls go through `mcp.ts:callTool`, the results are appended, and the request recurses.

## State

- `db` fields:
  - Model choice: `aiModel`, `subModel`, `seperateModels`, `seperateModelsForAxModels`, `doNotChangeSeperateModels`, `fallbackModels`.
  - Custom models and parameters: `customModels`, `customFlags`, `additionalParams`, `seperateParameters`.
  - Keys and URLs per provider.
  - Provider settings: OpenRouter, NanoGPT, and Ollama fields.
  - `dynamicModelRegistry`.
- `requestDataResponse` is `{type: 'success'|'fail'|'streaming'|'multiline', result, ...}`.

## Coupling

- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (`globalFetch`/`fetchNative`), `stringlize.ts`, `templates/chatTemplate.ts`, `tokenizer.ts`, `mcp.ts`, plugin stores (`pluginHooks.ts` `pluginHooks`/`customProviderStore`, `customV3ProviderMetaStore`), inlays, and `platform.ts`.
- UI model pickers mutate `DBState.db` directly.

## Invariants

- Only append to the numeric enums (`LLMFlags`, `LLMProvider`, `LLMFormat`, `LLMTokenizer`). Saved custom models store these numbers.
- A model's `format`, `flags`, `parameters`, `internalID`, endpoint, and tokenizer must agree. Wrong flags silently change the prompt shape.
- Streaming consumers expect cumulative text, not deltas. Tool metadata must survive to the final chunk.
- `escape` disables streaming. Audio and image output modalities disable streaming.
- With separate parameters enabled, a missing per-model override throws. Mode `submodel` maps to `otherAx` for parameters, but `submodel` is not a `seperateModels` key.
- Additional parameters apply last and can override or delete body fields and headers:
  - `header::` targets a header.
  - `{{none}}` deletes the field.
  - `json::` parses a JSON value.
  - Dotted keys address nested fields.
  - Treat these as trusted user configuration.
- Browser streaming to localhost or private endpoints is rejected unless running on Node.
- `requestChatDataMain` mutates its argument object. Do not reuse it after the call.

## Recipes

- Add a model to a static provider: add an `LLMModel` in `model/providers/<p>.ts` with a stable `id`, the wire-level `internalID`, and accurate flags, parameters, and tokenizer. Verify with `getModelInfo(id)`, `getModelList`, and a request preview.
- Add a custom endpoint without code: use `CustomModelsSettings` to create an `xcustom:::` model.
- Add a provider that reuses an existing wire format: add a provider name, the model records, and the endpoint/key selection, then route through the existing handler.
- Add a new wire format:
  1. Append the enum values in `types.ts`.
  2. Add catalogue entries and UI options, including the `CustomModelsSettings` option lists.
  3. Write a handler that returns `requestDataResponse`.
  4. Add a `requestChatDataMain` case.
  5. Call `applyParameters` and `applyAdditionalParameters`.
  6. Implement streaming, tools, reasoning, and images, plus a tokenizer mapping.
  7. Add tests next to `requests.responses.test.ts`.

## Tests

- `request/openAI/requests.responses.test.ts`: Responses API bodies, reasoning, tools, continuation sanitizing, and SSE parsing.
- `request/tests/additionalParams.test.ts`.
- Not tested: OpenAI Chat SSE and tools, Anthropic, Gemini, the legacy handlers, `getModelInfo`, tokenizer selection, and proxy routing.

## Known Hazards

- `getModelList` pushes plugin models into `LLMModels`, so repeated calls can duplicate them.
- In the `encode` custom-tokenizer path, `llama3` calls the `llama` tokenizer. `encodeWithTokenizer` does not do this.
- `CustomModelsSettings` does not expose every format or tokenizer value (Plugin, Ollama, Horde, Echo, NanoGPT variants, and `Local` are missing).
