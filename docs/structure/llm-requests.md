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
  - the named API keys (`docs/plan/shared-api-keys.md`): which key a model sends (the slot table, the shared binding decision, the server resolver) and their UI (the API Keys page, the per-model key select),
  - the model-picker UI.
- Paths:
  - `src/ts/process/request/*` (including `tests/`)
  - `server/src/llm/**`, `server/src/routes/llm.ts` (the server request layer)
  - `shared/llm/**` (the static catalogue and the `/api/llm/request` contract)
  - `src/ts/model/*`
  - `src/ts/process/webllm.ts`
  - `src/ts/horde/getModels.ts`
  - `src/ts/tokenizer.ts`, `shared/tokenizerChoice.ts`, `shared/prompt/chatTokens.ts`
  - `src/lib/UI/{ModelList,ModelGrid,OpenrouterProviderList,NanoGPTDashboard,NanoGPTProviderPicker}.svelte`
  - `src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte`, `src/lib/Setting/Pages/ApiKeysSettings.svelte`, `src/lib/UI/GUI/CredentialSelect.svelte`
- Not here:
  - The `credentials` collection, `llmSecrets.credentials`, and their save path → `persistence.md` (the write-only record: `self-host-server.md`).
  - Transport (`globalFetch`/`fetchNative`) → `global-api.md`.
  - MCP tool definitions → `plugins-mcp.md`.
  - Prompt assembly → `chat-pipeline.md`.

## Files

- `shared/llm/types.ts` (re-exported by `model/types.ts`): the catalogue types. `LLMFlags`, `LLMFormat`, `LLMTokenizer`, and `LLMProvider` (persisted numeric codes) and the `LLMModel` and `LLMParameter` types are declared in `shared/llm.ts` and re-exported here (`LLMParameter` also from `request/shared.ts`).
  - Numeric enums `LLMFlags`, `LLMProvider`, `LLMFormat`, `LLMTokenizer`.
  - `LLMModel`: `id`, `name`, `internalID`, `provider`, `format`, `flags[]`, `parameters`, `tokenizer`, `endpoint`, `keyIdentifier`.
  - `ProviderNames`, and parameter presets such as `OpenAIParameters`/`ClaudeParameters`.
- `shared/llm/providers/{openai,anthropic,google}.ts`: static `LLMModel[]` catalogues. `shared/llm/providers/nanogpt.ts`: endpoint constants.
- `shared/llm/models.ts`: `BASE_LLM_MODELS`, the static list assembled from the provider arrays (with the derived `-response-api` variants of OpenAI models and `-vertex` variants of Google models), and `resolveModelInfo(id, { enableCustomFlags, customFlags, customModels, extraModels, pluginModels })`: static IDs (then `extraModels`), `hf:::`, `horde:::`, `xcustom:::`, `pluginmodel:::`, else an as-is OpenAI-compatible model.
- `shared/llm/credentialSlots.ts` `credentialSlotOf(modelId, modelInfo)`: a model's credential slot, `{ slot, binding, accepts, defaultDescription }` or `null` (no named key). In precedence order: `xcustom:::` → `customModel` (binding on the record's `credentialId`; every type but `vertex`; default its own key), `reverse_proxy` → `reverseProxy` (binding on the model preset's `proxyCredentialId`; every type but `vertex`; default the preset's `proxyKey`), a `keyIdentifier` model (DeepSeek, DeepInfra) → `keyIdentifier` (`custom` only; default `OaiCompAPIKeys.<id>`), then by id `openrouter`, `nanogpt` (every NanoGPT format), `ollama-cloud`, then by provider `OpenAI`, `Anthropic`, `AWS` (`bedrock` only, the composite `accessKeyId:secretAccessKey:region`), `GoogleCloud`, `VertexAI` (`vertex` only), `Mistral`, `Cohere`, `NovelAI`, and an as-is or keyless DeepSeek/DeepInfra OpenAI-format model (`openai`); a provider slot accepts its own type and `custom`; every catalogue slot binds globally (`providers.modelCredentials[modelId]`). Mancer, NovelList, Horde, Ooba/Kobold, local Ollama, plugin, WebLLM, and Echo have none.
- `shared/llm/credentialBinding.ts` `resolveCredentialBinding(modelId, modelInfo, sources, credentials, hasKey)`: the one binding decision the tab and the server share. It reads the binding from the slot's own source (an own string property; a global entry for a custom model or the reverse proxy is ignored) and answers `default` (no binding), `bound`, or `refused` with the first failing reason: `unsupportedModel` (a binding on a model with no slot), `missing`, `empty` (`hasKey` false: the plaintext on the server, the masked status in the tab), `typeMismatch`, `vertexEmailMissing`.
- `shared/llm/validate.ts` `isModelDescriptor`: the `LLMModel` fields the server reads (a hook list's provider descriptors, a request's dynamic model).
- `model/modellist.ts`: the tab's registry.
  - `LLMModels`: this tab's copy of `BASE_LLM_MODELS`, which `registerModelDynamic` appends to (`isDynamicModel(id)` says which ids it added).
  - `registerModelDynamic`: when `dynamicModelRegistry` is on, fetches model lists from Google, Anthropic, and OpenAI.
  - `getModelInfo(id, scope?)`: `resolveModelInfo` with the custom flags of `scope`'s model preset (a request's captured pair) or else the selected one, `settings.customModels` (the record views), this tab's list, and `customV3ProviderMetaStore`.
  - `getModelList`: grouped models for the UI.
- `model/credentials.ts`: the tab's named key readers. `credentialFor(modelId, scope?)` (`resolveCredentialBinding` over the records, the scope's or the active model preset, and `secretStatus` with pending writes: `{ slot, state: default | bound | refused, credentialId?, record?, reason? }`), `credentialsAccepted(modelId)` (the records the slot accepts, in list order: the select options), `credentialsUsing(credentialId)` (every binding naming the key, inactive model presets included: the delete confirmation). An absent `credentials` collection or binding map reads as empty.
- `model/{openrouter,nanogpt,ollama}.ts`: dynamic catalogue fetch, normalized to `ModelGridItem`.
- `model/ooba.ts`: re-exports `OobaChatCompletionRequestParams` from `shared/settings.ts`.
- `model/modelGrid.ts`: UI types.
- `request/request.ts`: request entry points.
  - `requestChatData(arg, mode, abortSignal)`: the public entry. Handles fallback models, retries, plugin before/after replacers, escaping, blank-response fallback, and attribution, in the tab. The character's `request` trigger runs only for a server job's requests: the tab's own requests go out without it.
  - `requestChatDataMain`: picks the model; `LLMFormat.Plugin` and `LLMFormat.WebLLM` run here (`requestPlugin`, `requestWebLLM`, after `reformater`), every other format goes to the server through `requestServer`.
- `request/transport.ts` `requestServer(arg, mode, abortSignal, modelInfo)`: the client half of `POST /api/llm/request`. It reads the context ids before any await (the preset and persona of `arg.pluginContext` or the selection, the persona `getUserName()` reads, the selected character, the replying character, the main model's tokenizer and image input, the legacy plugin tokenizer), awaits `flushResources()` (a refused flush fails the request), collects the remembered tool calls the prompt names (`decodeToolCall` per `<tool_call>` marker), and posts the caller's serializable arguments (`REQUEST_ARG_KEYS`), the tool descriptors, a dynamic model's descriptor, and `channelCall` (the job callback running in this tab, `channelCallSource.ts`). It reads the SSE events in order: `log` → the request log (`appendFetchLog`), `notice` → `alertError`, `inlay` and `toolRecord` → the inlay helpers and `encodeToolCall`, finished before any later event; `callback` (`mcpTool` → `callTool`, `cbs` → `risuChatParserScoped` with the request's preset and persona) answered without holding the stream, a computed answer resent rather than rerun; `result`, or `streaming` with `chunk` deltas rebuilt into cumulative snapshots (`chunkText` for OobaLegacy's string chunks) and `end`/`error`. A stream that ends without a terminal is a failure; cancelling the returned stream aborts the request.
- The provider adapters exist only on the server (`server/src/llm/`); the tab has no copy. `process/stringlize.ts` stays (`unstringlizeChat` for the tab's plugin provider path).
- `server/src/llm/`: the Node port of the request layer. `request.ts` `requestChatDataMain(arg, mode, ctx)` (the model, the argument defaults, the reverse-proxy and custom-model overrides, `reformater`, the per-format functions; `Plugin`, a plugin provider model, is called in the job's tab for a job's request (`RequestContext.pluginProvider`: `requestPlugin` builds the argument with `applyParameters` from the job's settings; the answer is text, a stream of cumulative text, or a failure); `WebLLM`, a local Transformers.js generation model, runs in the server's model process for a job's request (`RequestContext.localGeneration`); both fail for a tab's request, which never sends them, and a tab's `dynamic_` model is refused for a job), `shared.ts`, `additionalParams.ts`, `anthropic.ts`, `google.ts`, `openAI/*`, `nai.ts`, `stringlize.ts`, `jsonSchema.ts`, `chatTemplate.ts`, `openrouter.ts` (`getFreeOpenRouterModels`), `messages.ts` (the English `language` strings), `util.ts`. Each function reads its database, names, transport, tokenizer, CBS parser, tool seam, inlay writers, and interceptor from the request's `RequestContext` (`context.ts`), threaded as `arg.ctx`.
  - `settings.ts` `loadRequestDb(store, kinds, ids)`: `RequestDb` (the `providers` and `llmSecrets` sections, the preset's fields under their root names through `presetFieldValue`, its `proxyKey`, the selected persona's `username`/`personaPrompt`, `ui.autoSuggestPrefix`, `customModels` with each model's `key` merged from `llmSecrets.customModels` (the stored custom models carry no key), and `credentials`, the named API keys by id with each `key` merged from `llmSecrets.credentials` (`""` when absent) beside the record's `name`, `type`, and the Vertex `clientEmail`/`projectId`; the bindings arrive as `providers.modelCredentials` and the model preset's `proxyCredentialId`) and the names of the two characters and the effective persona, from one store read. A missing preset or persona throws `RequestTargetGoneError` (never a redirect).
  - `transport.ts`: `globalFetch` (`fetchBuffered`, answering as `fetchWithProxy` does) and `fetchNative` (`fetchStream`) without the browser routing: every fetch goes from the server to the provider; the local-network timeout and the interceptor hook stay; log entries are built as the client builds them.
  - `requests.ts` `createLlmRequests`: the live requests (`self-host-server.md`), `strongBan` with a server LRU, the callback leg. `buildContext` is the `RequestContext` both entries share. `runInJob(spec)` is a request a server job makes in-process: the job's frozen `loadRequestDb` result, the token scope `tokenScopeFor` derives (`settings.ts`; no plugin tokenizer), the job's CBS evaluator for `parseCbs`, `bodyIntercepter` as a root callback of the job's channel (`channelIntercept`, the same failure policy as a child callback), signature and audio inlays persisted by the caller, images drawn by the tab (`inlayImage`), the job's MCP tools (`spec.tools`, with `tools.attempt` charging the job's tool budget for every call a model asks for; `self-host-server.md`); admitted and ended like a tab's request (shutdown, maintenance, `dispose`), a failure's and a preview's text redacted, a stream handed back live until read or cancelled; a job abort rejects.
  - `outer.ts` `requestChatDataOuter(arg, mode, deps)`: the client's outer `requestChatData` loop for a job (fallback models, retries with `antiServerOverloads`, `escape`, the plugin replacers through the job's channel, the `request`-trigger slot, `banCharacterset`, `fallbackWhenBlankResponse`).
  - `credentials.ts` `resolveCredential(db, aiModel, modelInfo)`: `resolveCredentialBinding` with the plaintext keys, as `default`, `key`, `vertex` (`clientEmail`, `privateKey`, `projectId?`), or `refused` with an English message (`messages.ts` `errors.credential*`) naming the model and the key's name, never its value.
  - `redact.ts`: the secret-free projection of what goes back to the tab (logs, notices, errors, fail results, previews, callback payloads): every credential value of the request (also JSON-escaped and URL-encoded, the Bedrock key's parts, every named key's value, its `:` parts, and its client email, each Vertex token handed out) and the named credential headers and query parameters.
  - `vertexToken.ts`: Vertex service-account tokens in memory per email and key (concurrent refreshes shared; cleared at maintenance and dispose); the stored `vertexAccessToken` fields are not used.
  - `claudeObserver.ts`: the Claude cache warmer, one per server, disposed with it.
  - `auxOps.ts`: the `/proxy2` auxiliary operations (`self-host-server.md`): the media, memory, model discovery, account, and count calls the tab makes with a stored key (`global-api.md` `auxFetch`).
- `request/shared.ts`:
  - `ModelModeExtended` = `model|submodel|memory|emotion|otherAx|translate`.
  - `applyParameters`: the preset's parameters, for every mode (the per-role `seperateParameters` were removed; the fields stay unread).
  - `getAdditionalParameters`/`applyAdditionalParameters`: user body/header overrides.
- `request/additionalParams.ts`: relaxed JSON parser.
- `process/webllm.ts`: MLC WebLLM engine, used by Hypa summarization.
- `shared/tokenizerChoice.ts` `selectTokenizer({ aiModel, customTokenizer, pluginTokenizer, modelTokenizer, googleClaudeTokenizing })`: which tokenizer family counts a model's text (`openrouter`/`reverse_proxy` by `customTokenizer`, a legacy plugin `custom` model by its declared tokenizer, else the catalogue family; `Llama3`, `Local`, and `Unknown` count with `cl100k_base`), shared by the client's `encode` and the server counter (`server/src/prompt/tokens.ts`), so the two route alike.
- `shared/prompt/chatTokens.ts` `ChatTokenCounter`: a prompt's token arithmetic (message text plus `chatAdditionalTokens`, the name, thoughts, and the image tile formula) over an injected encoder.
- `tokenizer.ts`: tokenizer loading and counting on the client.
  - `encode`: `selectTokenizer`, then the family's loader; LRU cache of 1500 entries keyed by text, model, and tokenizer.
  - `encodeWithTokenizer`, `tokenizerList`, `ChatTokenizer` (`ChatTokenCounter` with `encode`), `tokenizeAccurate`.
  - Loaders for tiktoken, Claude, Llama/Llama3, Mistral, NovelAI, NovelList, Gemma, Cohere, DeepSeek, and GLM. Tokenizer files come from `public/token/`.
- `CustomModelsSettings.svelte`: edits `db.customModels` entries `{id:'xcustom:::uuid', internalId, url, format, tokenizer, key, name, params, flags, credentialId?}`; a `CredentialSelect` per model, whose default is the model's own key (its `SecretInput` hidden while a shared key is chosen; the stored value is kept).
- `CredentialSelect.svelte` (`src/lib/UI/GUI/`): a model's key select: "Default (<slot default>)", the keys `credentialsAccepted` offers, a disabled "Missing key" entry for a dangling binding, and the refusal reason (`text-draculared`). It writes the slot's binding (`setModelCredential`, `setCustomModelCredential`, or `setProxyCredential` on the scope's or active model preset); "Default" removes it. Nothing renders for a model with no slot unless a binding exists (then the refusal and a remove button). Used by `ModelSettings` (main and sub models, the reverse proxy block), `Model/AuxModelSelectors`, the fallback rows, and `CustomModelsSettings`.
- `ApiKeysSettings.svelte` (`API_KEYS_SETTINGS_MENU`, 17): the named keys (name, type, the write-only value through `SecretInput` on `{ kind: "entry", field: "credentials", id }`, the Vertex client email and project id), Add key, a delete confirmed with `credentialsUsing`, and every binding (global, custom model, model preset) with a missing key marked and a "Use default key" action.

## Flows

0. Every provider call except a plugin provider and WebLLM runs on the server: the tab's `requestChatData` loop calls `requestChatDataMain`, which hands the request to `requestServer`; the server reads the settings and credentials by the ids it is sent, runs its `requestChatDataMain`, and streams the answer back. A server job calls the server's outer loop directly (`outer.ts`). The steps below describe the server copy.
1. The tab's callers invoke `requestChatData`: the translator (`'translate'`), the HypaV3 modal's summaries (`'memory'`), `Suggestion.svelte`, MCP `aiaccess`, `IrisModal` (`'otherAx'`), image prompts (`stableDiff.ts`), and the playground. Plugin v3 `runLLMModel` calls `requestChatDataMain` directly. A send, memory, emotion, triggers, and Lua (`runLLM`) request from the server job.
2. `requestChatDataMain` resolves the model:
   1. `staticModel`.
   2. Mode `model` → `db.aiModel`.
   3. Any other mode → `db.subModel`, unless `seperateModelsForAxModels` is on, in which case → `db.seperateModels[mode]`.
   4. Then `getModelInfo`, reverse-proxy and custom URL/key injection, the named key (`resolveCredential`: a bound key replaces `targ.key`, a bound Vertex account sets `targ.vertexCredential`, a binding that cannot be honored returns `{ type: "fail", noRetry: true }` before any upstream call, so neither retries nor fallback models run), and `reformater`.
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
  - Model choice (the model preset's): `aiModel`, `subModel`, `seperateModels`, `seperateModelsForAxModels`, `fallbackModels`.
  - Custom models and parameters: `customModels`, `customFlags`, `additionalParams`.
  - Keys and URLs per provider: the default keys (`llmSecrets` flat fields, `OaiCompAPIKeys`, a custom model's own key, the model preset's `proxyKey`).
  - Named API keys: `credentials` (records), `llmSecrets.credentials.<id>.key` (values), and the bindings `providers.modelCredentials`, `customModels[].credentialId`, and the model preset's `proxyCredentialId`.
  - Provider settings: OpenRouter, NanoGPT, and Ollama fields.
  - `dynamicModelRegistry`.
- `requestDataResponse` is `{type: 'success'|'fail'|'streaming'|'multiline', result, ...}`.

## Coupling

- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (`globalFetch`/`fetchNative`), `stringlize.ts`, `templates/chatTemplate.ts`, `tokenizer.ts`, `mcp.ts`, plugin stores (`pluginHooks.ts` `pluginHooks`/`customProviderStore`, `customV3ProviderMetaStore`), inlays, and `platform.ts`.
- UI model pickers bind the selected preset's model fields through `activePreset` (`settingsViews.svelte.ts`).

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
- Configured provider URLs are fetched from the server, so `localhost` is the server's (in Docker, the container's: use `host.docker.internal` or the host's address).
- `requestChatDataMain` mutates its argument object. Do not reuse it after the call.
- A provider change goes into the server's adapters (`server/src/llm/`). They read nothing outside `arg.ctx` and their arguments.
- A named key binding that cannot be honored refuses the request and never falls back to the default key. The tab's state and the server's decision both come from `resolveCredentialBinding`; change the rules there, not in one caller.
- An adapter prefers `arg.key` where its model has a credential slot (the resolver's bound key arrives there). The OpenAI Chat, Responses, and legacy instruct adapters take their key from `openAI/shared.ts` `getOpenAIRequestKey`: `arg.key`, else a `keyIdentifier` model's own `OaiCompAPIKeys` entry or `""` (never another provider's key), else the provider default.
- Every credential value a request can carry is collected by `redact.ts` `collectSecrets`: a new credential field or map joins it.
- Nothing the tab receives from `/api/llm/request` but a model's answer (results, chunks) skips `redact.ts`; a model's answer is not redacted (it would rewrite URLs in the text).
- On the server an unhandled promise rejection ends the process: a fire-and-forget promise in a ported adapter (a `pipeTo`, a `fetch`) must catch.
- `cl100k_base` and `o200k_base` throw on text containing the special token `<|endoftext|>`, on the server as in the tab.

## Recipes

- Add a model to a static provider: add an `LLMModel` in `model/providers/<p>.ts` with a stable `id`, the wire-level `internalID`, and accurate flags, parameters, and tokenizer. Verify with `getModelInfo(id)`, `getModelList`, and a request preview.
- Add a custom endpoint without code: use `CustomModelsSettings` to create an `xcustom:::` model.
- Add a provider that reuses an existing wire format: add a provider name, the model records, and the endpoint/key selection, then route through the existing handler. For named keys, give it a `credentialSlotOf` row (a `CREDENTIAL_TYPES` entry if it needs its own type, with `language.sharedApiKeys.types`/`defaults` strings), make its adapter prefer `arg.key`, and cover it in `credentialSlots.test.ts`.
- Add a new wire format:
  1. Append the enum values in `types.ts`.
  2. Add catalogue entries and UI options, including the `CustomModelsSettings` option lists.
  3. Write a handler that returns `requestDataResponse`.
  4. Add a `requestChatDataMain` case.
  5. Call `applyParameters` and `applyAdditionalParameters`.
  6. Implement streaming, tools, reasoning, and images, plus a tokenizer mapping.
  7. Add tests next to `server/src/tests/llmProviderAdapters.test.ts` (the adapter's whole request and answer) and `llmResponsesApi.test.ts` (the Responses API helpers).

## Tests

- `server/src/tests/llmProviderAdapters.test.ts` (node): the server adapters end to end over a fake transport, each run's upstream requests, result, stream chunks, tool calls, remembered records, inlays, CBS parses, alerts, observer registrations, and logs asserted whole: OpenAI-compatible buffered and streaming, a JSON schema with its CBS parses, an OpenAI tool round trip, a provider failure and a preview, a custom model, Mistral, the legacy instruct format, the auxiliary and sub models, the Responses API buffered and streaming with a tool call, Anthropic buffered (with the cache warmer's registration) and streaming, Bedrock's SigV4 signature with a frozen clock, Google buffered (inlays), streaming, a preview, and a tool round trip, Vertex, NanoGPT Messages, Legacy, and Responses (each format's endpoint with and without the subscription flag, the NanoGPT key and no other provider's, the request model, `X-Provider`, no Messages batch), and a request without a selected character. The expected values are the former browser adapters' output on the same inputs, except the NanoGPT cases.
- `server/src/tests/llmResponsesApi.test.ts` (node): the Responses API helpers (`__testResponsesAPI`): the request body (reasoning mapping, verbosity, JSON schema, the developer role, multimodal input, tools), endpoints and auth (OpenAI, a custom model, NanoGPT, the reverse proxy with additional parameters), the output extraction (thoughts, refusals, incomplete and failed answers), the `store: false` sanitizing, the buffered and streaming tool continuations, and the SSE parser.
- `server/src/tests/llmProviderAdapters.test.ts`, "named credentials": a global binding replacing the default and an unbound model keeping it, two Anthropic models on two keys, two custom models sharing a key over their own keys (a global entry ignored), the reverse proxy bound per model preset, a `keyIdentifier` model with a bound, a stored, and no key (`Bearer `, never the OpenAI key), Ollama cloud, Bedrock signing with a bound key and its region, Vertex logging in with a bound account and its project, and each refusal (no upstream call, `noRetry`, no key in the message). `llmServices.test.ts`: the named keys' redaction.
- `shared/llm/tests/credentialSlots.test.ts` (the slot of every catalogue model and virtual id), `shared/llm/tests/credentialBinding.test.ts` (the sources and the reason order), `model/tests/credentials.test.ts` (the tab readers: states, a pending key, the reverse proxy scope, options, usages).
- `e2e/apiKeys.spec.ts`: add a key and its value, bind it on the Model page, the binding listed and kept after a reload, a delete confirmed with its use, the missing binding shown on both pages, and back to the default, with no key value in any settings batch.
- `request/tests/additionalParams.test.ts`.
- `request/tests/requestPresetScope.test.ts` and `model/tests/modelInfoScope.test.ts`: a tab-run request uses its captured model preset (provider, custom flags), and a captured preset deleted before or during the request (a `getTools` await, a `replacerbeforeRequest` hook) refuses it instead of reading the selection.
- `src/lib/UI/NanoGPTDashboard.test.ts` (happy-dom, Svelte `mount`): one fetch per stored key version; an answer arriving after the key was cleared, replaced, or the dashboard left must not write the subscription state.
- Not tested: tokenizer selection and proxy routing in the tab.
- Not tested by the credential capture (`checkCutoverCredentials.mjs`): sends through the provider families other than OpenAI (the script's closing note lists them), the OpenRouter, NanoGPT, and Ollama discovery and account calls, previews, and Whisper through its component.

## Known Hazards

- Named keys do not reach the `/proxy2` auxiliary operations (`auxOps.ts`: TTS, DALL-E, Whisper, embeddings, model discovery, the NanoGPT account calls), `openrouter.ts` `getFreeOpenRouterModels`, or the NanoGPT dashboard: they keep the default keys.
- A global binding is keyed by model id: a catalogue id that is renamed or removed leaves its `modelCredentials` entry behind (listed on the API Keys page, read by no request).

- `getModelList` pushes plugin models into `LLMModels`, so repeated calls can duplicate them.
- In the `encode` custom-tokenizer path, `llama3` calls the `llama` tokenizer. `encodeWithTokenizer` does not do this.
- `CustomModelsSettings` does not expose every format or tokenizer value (Plugin, Ollama, Horde, Echo, NanoGPT variants, and `Local` are missing).
- The server's `strongBan` cache is an LRU keyed by the text alone: a hit returns the bias it stored before and drops the current request's bias.
- Multimodal token counting clamps one image side before scaling the other, so a 1000×2000 image counts eight 512-pixel tiles.
- The server's `gemma` tokenizer loads `llama/llama3.json`, so Gemma counts are Llama 3 counts (on purpose, as in the tab).
