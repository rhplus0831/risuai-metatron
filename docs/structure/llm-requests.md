# LLM Requests, Model Catalogue, Tokenizers

## Scope

- Resolve a catalogue or discovery model, a preset slot, a named profile, or the credential that model sends. See
  [catalogue and model resolution](#catalogue-and-model-resolution), [model preset slots](#model-preset-slots), and
  [credentials](#credentials). The model selectors and API Keys tab are in [settings pages](#settings-pages).
- Change a provider request, wire format, streaming, retries, tool-call loop, or model parameter. For mode-specific
  prompt insertion follow [request interception](#request-interception). For tab plugin callbacks see
  [hook entry points](plugin-sandbox.md#hook-entry-points).
- For token counts and playgrounds start at
  [tokenizer selection and server counting](#tokenizer-selection-and-server-counting). The tab's WebLLM adapter uses
  `src/ts/process/webllm.ts`. Horde model discovery uses `src/ts/horde/getModels.ts`.
- Neighboring owners cover [prompt assembly](chat-pipeline.md), [MCP tool definitions](mcp.md),
  [network transport](network-jobs.md), [credential storage](persistence.md) and
  [credential writes](resource-sync.md#credential-writes).

## Files

Each module's rules are in its doc comments (module header, then the named exports); an entry names the path, its role,
and what to look up.

### Catalogue and model resolution

- `shared/llm.ts`: the persisted descriptor codes (`LLMFlags`, `LLMProvider`, `LLMFormat`, `LLMTokenizer`), `LLMModel`,
  and `LLMParameter`. `shared/llm/types.ts` re-exports the four code objects and `LLMModel` with `ProviderNames` and the
  parameter presets (`OpenAIParameters`, `ClaudeParameters`); static entries are in `shared/llm/providers/`.
- `shared/llm/models.ts`: the catalogue and resolver both runtimes share: `BASE_LLM_MODELS`, `resolveModelInfo`,
  `dynamicModelOf`, and `isUnresolvedModelId` (true when resolution reaches the final as-is OpenAI-compatible fallback;
  `ModelProfileEditor.svelte` then shows `modelProfiles.unresolvedModelNotice` beside the model field).
- `shared/llm/thinkingResolver.ts` `resolveClaudeThinkingType`: stored versus displayed Claude thinking mode.
- `shared/llm/interception.ts`: the request interception rules (`RequestInterception`, `MAX_REQUEST_INTERCEPTIONS`,
  `normalizeRequestInterceptions`) and their insertion (`interceptionMessages`, `applyRequestInterceptions`), stored as
  `providers.requestInterceptions` ([request interception](#request-interception)).
- `src/ts/model/modellist.ts`: the tab's registry and lookups: `LLMModels`, `isDynamicModel`, `registerModelDynamic`
  (with a `profileId`, as the profile editor's `ModelList.svelte` passes on open, it discovers that profile's provider
  with the profile's credential), `getModelInfo`, `getModelInfoForMode`, `getModelList`. The server's lookup is
  `server/src/llm/request.ts` `requestModelLookup`.

### Model preset slots

A slot here is a model preset's routing position (`mainSlot`, `subSlot`, `auxSlots`); a credential slot, under
`Credentials`, is the kind of key a model accepts.

- `shared/llm/modelSlots.ts`: the slot routing both runtimes call: `resolveSlotProfile` (the answer kinds, the refusal
  reasons, the routing order) and `definitionNeedsProfile` (the definitions a bare slot cannot run). The tab calls it
  through `src/ts/storage/settingsViews.svelte.ts` `resolveModelSlot` ([persistence](persistence.md) owns that file).

### Credentials

- `shared/llm/credentialSlots.ts` `credentialSlotOf`: the named-key type a model accepts, and the provider and model
  exceptions (`CREDENTIAL_TYPES` in `shared/database.ts`).
- `shared/llm/credentialBinding.ts` `resolveCredentialBinding`: the one binding decision the tab and the server share,
  with its refusal reasons in order.
- `src/ts/model/credentials.ts`: the tab's readers: `credentialFor`, `credentialsAccepted` (the select options),
  `credentialsUsing` (the delete confirmation), and `credentialStatusFor` (the discovery key gate `keySet` and the
  refresh identity `keyVersion`).
- `src/ts/model/openrouter.ts`, `src/ts/model/nanogpt.ts`, `src/ts/model/ollama.ts`: discovery and account fetches with
  the edited profile, through `auxFetch` ([network jobs](network-jobs.md)) to the server's `/proxy2` rows (NanoGPT's
  keyless public list and a local Ollama host go through `globalFetch` instead; the module headers say how). Their
  callers, the pickers and panels `src/lib/Setting/Pages/Model/ModelProfileEditor.svelte` mounts
  (`NanoGPTDashboard.svelte` among them), refetch on `keyVersion`.
- `server/src/llm/credentials.ts` `resolveCredential`, `defaultCredentialKey`: the server's resolver over the plaintext
  keys; refusal messages are `server/src/llm/messages.ts` `errors.credential*`.
- `server/src/llm/auxOps.ts` `AUX_OPS`, `planAuxOp`: the `/proxy2` auxiliary operations ([server](self-host-server.md)):
  the media, memory, model discovery, account, and count calls the tab makes with a stored key, and which rows accept a
  profile (the rows with a `slot`: NanoGPT, OpenRouter, Ollama, and the Google, Anthropic, and OpenAI model discovery).
  `server/src/routes/proxy.ts` reads the `risu-aux-profile` header, and `server/src/app.ts` `auxCredential` resolves
  that profile with `resolveCredential` over the merged records (`server/src/llm/settings.ts` `mergeCredentials`).

### Tab request layer

- `src/ts/process/request/request.ts`: `requestChatData`, `requestChatDataMain`, `reformater`, and
  `RequestDataArgumentExtended.requestIds`; their comments define the tab loop, chat pinning, and dispatch boundary.
- `src/ts/process/request/transport.ts` `requestServer`: the tab half of `POST /api/llm/request`; the server half is
  `server/src/routes/llm.ts`. A plugin callback's `channelCall` parentage: [plugins](plugin-sandbox.md).
- `src/ts/process/request/shared.ts` `applyParameters`, `applyAdditionalParameters`: the tab's copy of
  `server/src/llm/shared.ts` (`applyParameters` for Plugin requests, `applyAdditionalParameters` for WebLLM). The
  provider adapters exist only on the server; `src/ts/process/stringlize.ts` `unstringlizeChat` serves the tab's WebLLM
  path.

### Server request layer

- `server/src/llm/request.ts`: `requestChatDataMain` (named key, `reformater`, dispatch by `LLMFormat`),
  `resolveRequestModel` (the request-local `db` every mode, an auxiliary one included, runs on),
  `resolveJobRequestModel`, and the per-format functions; the other adapters are `server/src/llm/anthropic.ts`,
  `server/src/llm/google.ts`, and `server/src/llm/openAI/` (helpers `server/src/llm/nai.ts`,
  `server/src/llm/openrouter.ts`). `server/src/llm/outer.ts` `requestChatDataOuter` is a job's outer loop.
- The streaming decision (`requestChatDataMain`): a request streams when it sets `forceStreaming`, else when both
  `providers.useStreaming` and its own `useStreaming` are on; an adapter may still answer buffered (`Invariants`). A
  job's reply request sets `forceStreaming` only under Half Streaming
  ([server generation](server-generation.md#prompt-job-execution)).
- `server/src/llm/providerFetch.ts` `providerFetch`, `PROVIDER_RESPONSE_TIMEOUT_MS`: the fetch of provider requests (the
  transport's default and the local Ollama client). Its undici `Agent` waits 30 minutes for the headers and between body
  chunks; Node's own 300 s bound failed, and re-sent, a long non-streaming generation.
- `server/src/llm/openAI/shared.ts`: `getOpenAIRequestKey` and `getLocalNetworkRequestOptions`.
- `server/src/llm/shared.ts` `applyParameters`, `applyAdditionalParameters`: server parameter application and the
  trusted custom-parameter syntax, mirrored in `src/ts/process/request/shared.ts`.
- `server/src/llm/redact.ts`: `collectSecrets`, `createRedactor`, and re-exported `REDACTED`/`redactHeaderText` from
  `shared/logRedaction.ts`; the secret projection shares header redaction with the [tab log](network-jobs.md#state).
- `server/src/llm/sseLines.ts` `SseLines`, and the stream parsers in `server/src/llm/openAI/requests.ts`,
  `server/src/llm/google.ts`, and `server/src/llm/anthropic.ts` (comments on each parser), under the snapshot contract
  in `Flows`.
- `server/src/llm/settings.ts` `loadRequestDb`, `RequestTargetGoneError`, `tokenScopeFor`: the request database.
- `server/src/llm/toolSchemas.ts` `serializeToolSchemas`: a job send's MCP descriptors in its resolved adapter's tools
  form (none for a format that sends no tools), counted for assembly's recheck. It mirrors each adapter's tools
  assignment, so a change to that form changes both.
- `server/src/llm/requests.ts` `createLlmRequests`: admission, `runInJob`, and the `strongBan` cache. Request history
  and observer details are in [diagnostics](diagnostics.md) and [server](self-host-server.md).

### Tokenizer selection and server counting

- `shared/tokenizerChoice.ts`: `selectTokenizer` (which family counts a model's text, for the server counter and
  routes), `TabTokenScope`, `tokenizerIdentityKey`, `byName`, `playgroundFamily`.
- `server/src/prompt/tokenizers/index.ts` `LOADERS`, `createTokenizers`: one loader per `TokenizerFamily`; payloads are
  `server/assets/token/` files (`server/src/prompt/tokenizers/payloads.ts`).
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

### Settings pages

Each component's contract is the JSDoc block at the top of its `<script>`.

- `src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte`: the `db.customModels` definitions (`CustomModel`), which
  hold no key.
- `src/lib/Setting/Pages/ModelProfilesSettings.svelte` (`MODEL_PROFILES_SETTINGS_MENU`; the Model menu's "Connections" /
  "연결" tab): the profile list, a delete confirmed with `presetsUsingModelProfile` and
  `translatorPresetsUsingModelProfile` (the last profile is kept), and `Model/ModelProfileEditor.svelte`, which edits
  the selected profile by id.
- `src/lib/Setting/Pages/ApiKeysSettings.svelte` (`API_KEYS_SETTINGS_MENU`; the Model menu's API Keys tab): the named
  keys and the bindings. It hosts `Model/ProviderDefaultKeys.svelte`, each provider's flat default key for the models
  the selected model preset's slots use; that is the only place that edits the OpenAI and Google keys, listed there also
  while the image provider is DALL-E or Imagen, or when a status link asked for them; see [settings](settings-i18n.md).
- `src/lib/Setting/Pages/ModelSettings.svelte` and `Model/ModelProfileEditor.svelte` bind the global Response Streaming
  (`providers.useStreaming`) and, under it while it is off, Half Streaming (`providers.halfStreaming`), which only a
  server job's reply request reads.
- `src/lib/UI/GUI/CredentialSelect.svelte`: the per-profile key select.
- `src/lib/UI/ModelList.svelte`, `src/lib/UI/ModelGrid.svelte`, `src/lib/UI/OpenrouterProviderList.svelte`,
  `src/lib/UI/NanoGPTProviderPicker.svelte`: pickers that write only their bindable `value`; slot writes are
  `src/lib/Setting/Pages/Model/ProfileSlotSelect.svelte`'s (see `Coupling`).
- `src/lib/UI/NanoGPTDashboard.svelte`: the edited profile's account panel, which writes global
  `settings.providers.nanogptSubscriptionState`; its header defines the stale-answer guard.

## Flows

### Request routing

- A tab request enters `requestChatData` for retries and replacers, then `requestChatDataMain`. Plugin and WebLLM
  dispatch locally; other formats go through `requestServer`. A job enters `requestChatDataOuter` on the server,
  including its character's `request` trigger. Jobs run WebLLM through `ctx.localGeneration` and plugin providers
  through a callback to their owning tab. Both dispatchers use `applyReverseProxyOverride` in
  `shared/llm/reverseProxy.ts`.
- A plugin's `runLLMModel` calls `requestChatDataMain` directly. It skips the outer retry and replacer loop, still
  checks the chat binding and requires `allowPlugins` for any descriptor resolving to the Plugin format.
- A chat request uses the chat's binding or its active job callback's captured IDs. See `chatRequestRefusal` in
  `src/ts/process/request/request.ts` for the binding recheck across hook awaits. A named `profileId` takes precedence
  over a `staticModel` or preset slot. `resolveSlotProfile` defines the remaining order and refusals on both runtimes
  ([slot resolver](#model-preset-slots)).
- Memory-host requests pass the chat's captured `memoryProfileId` as the named `profileId`; without one they use the
  model preset's `memory` slot. `resolveScopeMemoryModel` in `server/src/jobs/jobScope.ts` supplies the same resolution
  to fingerprints, task checks, and writer runs. The tab's HypaV3 `summarize` also passes the chat's named profile.
  Deleted named profiles refuse with `missingNamedProfile`, never fall back. Lua's own `memory`-mode request in
  `server/src/lua/bindings.ts` keeps the slot. Tokenization still follows the main model ([Invariants](#invariants)).
- An input hook (`src/ts/process/inputHooks.ts` `runInputHook`, [chat pipeline](chat-pipeline.md#input-hooks)) is a tab
  request in `otherAx` mode with the chat's `chatRef` and owner, so it runs on the chat's bound model preset; a hook
  whose model is a profile passes it as `profileId`. It passes `tools: []` (no tool-call record in the chat), but the
  plugins' replacers still run. Server-dispatched attempts are recorded in request history. It asks for a buffered,
  single reply and treats a stream or a `multiline` result as a failure.
- The server builds a detached request context with profile roots, resolves the named credential, reforms the prompt
  from model flags, and dispatches by `LLMFormat`. A bound Vertex account populates `vertexCredential`; other bound keys
  replace `arg.key`. See [credential binding](#credentials).

### Request interception

- The [settings page](settings-i18n.md#pages) edits global `providers.requestInterceptions`. The runtime dispatching a
  format calls `applyRequestInterceptions` exactly once on a cloned prompt, after any outer before-request replacers and
  job request trigger, before `reformater`. It applies only enabled rules listing this mode with nonblank text. Rule
  text is literal. The label stays out of the provider message.
- Start and end groups each keep list order. End entries precede a trailing assistant prefill. The next request attempt
  starts with a fresh clone. For later provider-body rewrites see [plugin hooks](plugin-sandbox.md#hook-entry-points).
- Chat-reply assembly uses `interceptionMessages` to estimate tokens for its final recheck, including preview. This
  estimate is `interceptions` in the context report, omitted when zero. The server dispatcher reports a positive count
  of inserted messages through `describe`. [Request history](diagnostics.md) list and detail JSON carry
  `interceptions: null` when there is no count. Tab-local Plugin/WebLLM calls have no server row.

### Provider responses and tools

- Server parsers produce cumulative `StreamResponseChunk` snapshots; `POST /api/llm/request` sends them as
  `set`/`append`/`remove` patches (legacy Ooba strings as `chunkText`), and `requestServer` rebuilds the snapshots. Job
  requests read the snapshots directly. Adapter comments own parser details. A tab request's tool calls go through the
  `mcpTool` callback (`mcp.ts` `callTool`), a job's through its job tool service; the adapter appends the results and
  sends the follow-up request.
- `requestChatDataMain` dispatches only a tool name the request offered and answers any other as an unknown tool. An
  explicit `tools: []` also leaves out the configured Responses web search; an omitted or automatically listed empty set
  keeps it (`allowConfiguredTools`).
- Gemini thought signatures (`providers.saveSignatures`, the Model page's toggle for a `geminiThinking` model): only a
  `model`-mode request saves them (`requestChatDataMain` sets `saveSignatures`; translation, memory, and the other
  auxiliary modes never do, since their hosts' `saveSignature` throws). The marker renders as nothing
  ([rendering](cbs-rendering.md#inlays)).
- `server/src/llm/google.ts` stores each part's `thoughtSignature` token as a signature inlay (raw JSON text) and
  appends its `{{inlayeddata::<id>}}` marker to the reply, after JSON extraction on the buffered path; a streaming tool
  follow-up's text drops the markers. Assembly passes the inlay back as a `signature` multimodal, and while the setting
  is on the adapter replays the token as `thoughtSignature` (an unparsable value is skipped).

## State

- `db` fields:
  - Model choice: the model preset's `mainSlot`, `subSlot`, `auxSlots` (`{ profileId }`, or `{ modelId }` in an
    auxiliary slot) and `seperateModelsForAxModels`; each profile's `modelId`. The root names `aiModel`, `subModel`, and
    `seperateModels` are derived model ids, never stored.
  - Profiles (`modelProfiles`): the model id, `credentialId?`, and the connection, routing, compatibility, and capacity
    fields, including the NanoGPT and Ollama model fields, `customTokenizer`, `localNetworkMode`, and
    `localNetworkTimeoutSec`; at root, the main profile's values.
  - Custom models and parameters: `customModels` (definitions), `additionalParams`.
  - Keys per provider: the flat defaults (`llmSecrets` flat fields, `OaiCompAPIKeys`); a custom model and the reverse
    proxy have none.
  - Named API keys: `credentials` (records), `llmSecrets.credentials.<id>.key` (values), and the profiles'
    `credentialId`.
  - Provider behavior toggles (OpenRouter middle-out and fallback, caching, `autofillRequestUrl`, ...) stay in
    `providers`.
  - `dynamicModelRegistry`.
- `requestDataResponse` is `{type: 'success'|'fail'|'streaming'|'multiline', result, ...}`.

## Coupling

- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (`globalFetch`/`fetchNative`), `stringlize.ts`,
  `templates/chatTemplate.ts`, `tokenizer.ts`, `mcp.ts`, plugin stores (`pluginHooks.ts`
  `pluginHooks`/`customProviderStore`, `customV3ProviderMetaStore`), inlays, and `platform.ts`.
- The settings pages (`Model/ProfileSlotSelect.svelte`, `Model/ModelProfileEditor.svelte`) write the slots through the
  store actions (`setMainModelSlot`, `setSubModelSlot`, `setAuxModelSlot`) and edit profiles through
  `profileForSlot`/`updateModelProfile` (`settingsViews.svelte.ts`, `collectionStore.svelte.ts`).

## Invariants

- `LLMFlags`, `LLMProvider`, `LLMFormat`, and `LLMTokenizer` are persisted numeric codes; append values only
  ([STRUCTURE D5](../../STRUCTURE.md#data-and-persistence)).
- Keep a model's `format`, `flags`, `parameters`, `internalID`, endpoint, and tokenizer consistent; the shared
  descriptor comment explains the prompt-shape failure.
- Both runtimes use `dynamicModelOf` for discovery ids. Its source comment owns provider-specific inheritance and
  fallback behavior.
- Profile custom flags replace catalogue flags. Model profile and custom model editors expose flags by `LLMFlags` name.
- Claude thinking payloads follow model flags. `resolveClaudeThinkingType` displays stored `budget` as `adaptive` only
  on adaptive-only models and never rewrites the stored value; `claudeThinkingOnByDefault` sends an explicit disabled
  thinking mode when off, while models without it omit the field.
- Streaming consumers expect cumulative text, not deltas. Tool metadata must survive to the final chunk.
- `escape` disables streaming, `forceStreaming` included; an attempt that streams anyway (a plugin provider) is read to
  its last snapshot and escaped as a buffered success. Audio and image output modalities disable streaming.
- Mode `submodel` is not a `seperateModels` key.
- `applyAdditionalParameters` accepts trusted configuration that can override or delete body fields and headers; its
  comment defines the syntax and notes that an adapter may still set fields afterward. `setObjectValue` (both copies)
  skips, with a warning, a dotted key with a `__proto__`, `constructor` or `prototype` segment, and walks own properties
  only, so no key reaches a prototype.
- Configured provider URLs are fetched from the server, so `localhost` is the server's (in Docker, the container's: use
  `host.docker.internal` or the host's address).
- A provider change belongs in the server adapters; they read only `arg.ctx` and their arguments
  (`server/src/llm/request.ts`).
- Slot routing and named-key binding use the shared `resolveSlotProfile` and `resolveCredentialBinding` decisions.
  Refusals fail closed: there is no alternate profile or default-key fallback.
- Auxiliary profile roots are detached into request-local `ctx.db`; adapters cannot mutate a job's frozen settings.
- Adapters use the resolved key. `getOpenAIRequestKey` owns the OpenAI key precedence and never crosses provider
  defaults.
- `redact.ts` owns the secret projection of logs, errors, notices, callbacks, and tool records. New credential fields
  join `collectSecrets`; model answer text remains unredacted.
- On the server an unhandled promise rejection ends the process: a fire-and-forget promise in a ported adapter (a
  `pipeTo`, a `fetch`) must catch.
- `cl100k_base` and `o200k_base` refuse text containing their special tokens; the count route returns `null` and the tab
  rejects that count.
- Tokenization does not follow a per-call `profileId`: a request's tokenizer scope is still the main model's (the tab's
  `context.tokenizer`, a job's `tokenScopeFor`), so token biases and bans of a per-call request use the main model's
  tokenizer (translation sends none).
- Tool-call and overload retries stay bounded and abortable; the adapter and `outer.ts` comments own the retry limits. A
  job's own request reports each re-send right before it (`reportRetry` on `OuterRequestDeps` and `RequestContext`,
  supplied by `server/src/lua/bindings.ts`); the [job registry](server-generation.md) counts the reports.

### Compatibility Model-Root Writes

`src/ts/storage/settingsViews.svelte.ts` `writeModelRoot` is the client compatibility boundary for flat model roots used
by plugins and settings views. A supplied `scope.modelPresetId` fixes the target; otherwise the model preset selected
when the write runs is used. `modelId` and `credentialId` are not forwarded profile roots.

- An equal read-back value is a no-op; it never re-matches or repairs a slot. A changed `aiModel`/`subModel` must name
  exactly one profile, then writes that profile id into the corresponding main/sub slot. Missing or ambiguous matches
  refuse.
- An auxiliary `seperateModels.<mode>` value of `""` clears that slot. One matching profile binds it; zero matches
  produces a bare `{ modelId }` only when `definitionNeedsProfile` is false; several matches refuse.
- A whole `seperateModels` object applies only its supplied modes, independently. A refused mode does not roll back
  another mode. The auxiliary toggle accepts a boolean.
- Profile-root writes, including `maxContext`, update the existing main profile after `isJsonData` validation and a
  detached clone; they do not create a profile. Shared profiles therefore affect every preset that names them.
- Refusals warn, retain the old value, and return false without throwing so later plugin keys can still apply. New UI
  code should use explicit profile/slot actions; [persistence](persistence.md) owns the record/view write boundaries.

## Recipes

- Change request interception end to end through `shared/llm/interception.ts`, both dispatchers, and the chat assembly
  reservation in `server/src/prompt/runner.ts`. Check the provider payload, history count and preview token budget
  separately ([request interception](#request-interception)).
- Add a model to a static provider: add an `LLMModel` in `shared/llm/providers/<p>.ts` with a stable `id`, the
  wire-level `internalID`, and accurate flags, parameters, and tokenizer. Verify with `getModelInfo(id)`,
  `getModelList`, and a request preview.
- Add a custom endpoint without code: use `CustomModelsSettings` to create an `xcustom:::` model.
- Add a provider that reuses an existing wire format: add a provider name, the model records, and the endpoint/key
  selection, then route through the existing handler. For named keys, give it a `credentialSlotOf` row (a
  `CREDENTIAL_TYPES` entry if it needs its own type, with `language.sharedApiKeys.types`/`defaults` strings), make its
  adapter prefer `arg.key`, and cover it in `credentialSlots.test.ts`.
- Add a provider parameter:
  1. Add to `LLMParameter` (`shared/llm.ts`) and a model's `parameters` or a `shared/llm/types.ts` preset.
  2. Add its `Database`/`botPreset` fields (`shared/database.ts`) and `PRESET_DEFAULTS` (`shared/presets.ts`).
  3. Extend `applyParameters` in `server/src/llm/shared.ts` and `src/ts/process/request/shared.ts` (plugins), and the
     adapters' fixed lists and `rename` maps; `-1000` is left out. WebLLM uses `transformersParams`.
  4. Add it to `allBasicParameterItems` (`src/ts/setting/botSettingsParamsData.ts`), gated by `modelInfo.parameters`.
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
- Add a new wire format:
  1. Append the enum values in `shared/llm.ts`.
  2. Add catalogue entries and UI options, including the `CustomModelsSettings` option lists.
  3. Write a handler that returns `requestDataResponse`.
  4. Add a `requestChatDataMain` case.
  5. Call `applyParameters` and `applyAdditionalParameters`.
  6. Implement streaming, tools, reasoning, and images, plus a tokenizer mapping.
  7. Add tests next to `server/src/tests/llmProviderAdapters.test.ts` (the adapter's whole request and answer) and
     `llmResponsesApi.test.ts` (the Responses API helpers).

## Tests

- Focused:
  `pnpm --silent test:agent shared/llm src/ts/model src/ts/process/request src/ts/tokenizer.test.ts src/ts/process/prompt.tokenize.test.ts src/lib/UI/NanoGPTDashboard.test.ts`
  for the tab and shared code;
  `pnpm --silent test:agent server/src/tests/{llm*,token*,toolSchemas,sseLines,imageTokens,auxOps,providerModels}.test.ts`
  for the server.
- Interception coverage crosses `shared/llm/tests/interception.test.ts` (rule order and normalization),
  `requestPresetScope.test.ts` (plugin provider), `llmRequests.test.ts` (server payload, retries and history), and
  `server/src/tests/promptRunner.test.ts` (preview and send token budget).
- `slow`:
  `pnpm --silent test:agent --tags-filter=slow server/src/tests/{llmCharsetRetries,tokenParity,tokenPlainNode}.test.ts`
  ([test-harness](test-harness.md) `Slow-test table`).
- `e2e`: `e2e/apiKeys.spec.ts` (key editing and profile binding through the real server); `e2e/chatBinding.spec.ts` (two
  bound chats reach a mock provider with their own model and `max_tokens`).
- Adapter oracle: `server/src/tests/llmProviderAdapters.test.ts` runs `requestChatDataMain` over one `loadRequestDb`
  read, frozen time and ids, and one recording upstream. Its expected values are recorded browser output, not server
  output (the file's header). Fake timers drive the tool-call retry waits.
- `server/src/tests/llmStreamParsing.test.ts` runs the adapters over the real transport and explicit upstream reads; its
  oracles are the SSE and delta contract, not captures.
- `server/src/tests/llmRequests.test.ts` `fakeStore` stands in for the `ResourceStore` under `createLlmRequests`, over
  records the test sets (`makeRecords`).
- `src/ts/process/request/tests/transport.test.ts` `controlledResponse` stands in for the `POST /api/llm/request` body:
  the test pushes its frames and closes it. The file runs in happy-dom, since the record views need client `$state`.
- `createRequestMock` (`src/ts/process/request/tests/requestMock.ts`) stands in for the request module, for callers that
  test routing into requests rather than providers.
- `server/src/tests/llmCharsetRetries.test.ts` drives `requestChatDataOuter` with finite attempt scripts, where an extra
  attempt throws; its `slow` cases run a real group send in a child process the test kills.
- Token fixtures: `server/src/tests/tokenFixtures.ts` loads the frozen ids in `fixtures/tokens/browser-ids.json` for the
  tokenizer tests ([test fixtures](test-harness.md#fixtures)).
- Browser checks outside the gate: `util/playwright/checkCredentialTraffic.mjs` (coverage and exclusions in the file)
  and `checkLlmTransport.mjs`.
- For transport routing coverage and gaps see [network jobs](network-jobs.md#tests). The `checkCredentialTraffic.mjs`
  browser probe omits non-OpenAI sends, several discovery/account calls, previews, and Whisper through its component.
- Not tested: aborting the last caller while `server/src/prompt/tokens.ts` `scheduleGoogleCount` waits for a limiter
  slot; `tokens.test.ts` covers active-call cancellation and queue draining, but not cancellation while queued.

## Known Hazards

### Limitations

- The `/proxy2` media, memory, and count rows (`AUX_OPS` rows without a `slot`) use their flat default keys and accept
  no profile; discovery and NanoGPT account rows accept a matching profile. See `server/src/llm/auxOps.ts` `planAuxOp`.
  Decision: owner, 2026-11-10 (known-issues review): the profile editor's model list was the case that mattered.

- An overload error event inside an Anthropic stream becomes redacted `Error:<message>` answer text (an OpenAI Responses
  error event becomes the answer too; an OpenAI Chat `error` event fails the stream). There is no in-stream retry;
  `outer.ts` `requestChatDataOuter` owns the retry policy and honors `antiServerOverloads`. Decision:
  `server/src/llm/anthropic.ts`, the stream error comment.
- Claude tool calls are not streamed or batched: `requestClaude` sends a request that offers tools buffered and
  directly, with `stream: false` on it and every tool follow-up, even with `useStreaming` or `claudeBatching` on. The
  SSE and batch result parsers read text and thinking only. Upstream has the same gap. Decision: owner, 2026-11-08.
- MCP tool schemas and the chat reply's request interception messages are charged only in assembly's final recheck, as
  an estimate (other modes get no reservation): memory budgets and the no-memory trim plan without them, so the recheck
  can drop removable entries they kept. Decision: Found Issues Clearance Q2, 2026-11-09; the interceptions, Request
  Interception plan, 2026-11-17.
- Request capture: a stream capture flushed by an abort, a cancel, or a read error is not trimmed for a trailing
  credential prefix (`trimPartial` runs only when the 4 MiB + 16 KiB `STREAM_CAPTURE_BYTES` bound cuts it,
  `server/src/llm/requests.ts`) and can end in U+FFFD; an adapter's `addLog` (the Anthropic batch) counts logged text,
  not wire bytes; exchanges are stored in completion order, not start order. Decision: Request History and Diagnostics
  trade-offs (`ab11ea9d0`, [archive](../archived-plan/README.md)), recorded by Found Issues Clearance (owner,
  2026-11-09).
- Request interception reaches only requests made through the request layer in one of its modes: the HypaV3 modal's
  `summarize` with a summarization model other than `subModel` (`chatCompletion` in `src/ts/process/webllm.ts`),
  SupaMemory and HypaV2 with a fixed model (`host.completions`), the local summarizer, token counting, embeddings,
  images, and TTS are not intercepted. What rewrites the provider body afterwards (additional parameters, a plugin's
  body interceptor, a plugin provider) can still change or drop the inserted text. Decision: Request Interception plan,
  owner, 2026-11-17.
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
- NanoGPT's `providers.nanogptSubscriptionState` and `nanogptUseSubscriptionEndpoint` remain global: two profiles on
  different accounts share subscription state and endpoint selection. A model-profile follow-up
  ([deferred work](../backlog/deferred-work.md#model-profiles)). Decision: owner, 2026-11-10 (known-issues review).
- Multimodal counts remain approximate: Claude/Gemini images use the GPT-4o fallback; video/audio/signature entries use
  a flat 85 tokens. Decision: owner, 2026-11-10 (known-issues review).

### Gotchas

- Local tokenizer families encode synchronously on the server thread. Encoders stay loaded per server context until
  disposal; the web-tokenizer module loader is process-wide and serialized, and disposal does not guarantee that the
  memory returns to the OS.
