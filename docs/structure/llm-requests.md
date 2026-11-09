# LLM Requests, Model Catalogue, Tokenizers

## Scope

- Owns:
  - the model catalogue and model-ID resolution,
  - request dispatch by wire format,
  - provider request builders and stream parsers (OpenAI Chat, OpenAI Responses, Anthropic/Bedrock, Google/Vertex,
    NovelAI, Ooba, Ollama, Cohere, Horde, WebLLM, plugin providers),
  - parameter application,
  - tool-call loops (dispatch side),
  - tokenizers,
  - auxiliary-model routing,
  - the named API keys (credential binding): which key a model sends (the slot table, the shared binding decision, the
    server resolver) and their UI (the Model menu's API Keys tab, the per-model key select),
  - the model-picker UI.
- Paths:
  - `src/ts/process/request/*` (including `tests/`)
  - `server/src/llm/**`, `server/src/routes/llm.ts` (the server request layer)
  - `shared/llm.ts`, `shared/llm/**` (the static catalogue and the `/api/llm/request` contract)
  - `src/ts/model/*`
  - `src/ts/process/webllm.ts`
  - `src/ts/horde/getModels.ts`
  - `src/ts/tokenizer.ts`, `src/ts/tokenCountField.ts`, `shared/tokenizerChoice.ts`,
    `shared/prompt/{chatTokens,imageTokens}.ts`
  - `server/src/prompt/tokens.ts`, `server/src/prompt/tokenizers/`, `server/assets/token/`
  - `src/lib/UI/{ModelList,ModelGrid,OpenrouterProviderList,NanoGPTDashboard,NanoGPTProviderPicker}.svelte`
  - `src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte`, `src/lib/Setting/Pages/ApiKeysSettings.svelte`,
    `src/lib/UI/GUI/CredentialSelect.svelte`
- Not here:
  - The `credentials` collection, `llmSecrets.credentials` → `persistence.md` (the write-only record:
    `server-resources.md`); [save path](resource-sync.md#credential-writes).
  - Transport (`globalFetch`/`fetchNative`) → `network-jobs.md`.
  - MCP tool definitions → `mcp.md`.
  - Prompt assembly → `chat-pipeline.md`.

## Files

Each module's rules are in its doc comments (module header, then the named exports); an entry names the path, its role,
and what to look up.

### Catalogue and model resolution

- `shared/llm.ts`: the persisted descriptor codes (`LLMFlags`, `LLMProvider`, `LLMFormat`, `LLMTokenizer`), `LLMModel`,
  and `LLMParameter`. `shared/llm/types.ts` re-exports the four code objects and `LLMModel` with `ProviderNames` and the
  parameter presets (`OpenAIParameters`, `ClaudeParameters`); static entries are in `shared/llm/providers/`.
- `shared/llm/models.ts`: the catalogue and resolver both runtimes share: `BASE_LLM_MODELS`, `resolveModelInfo`, and
  `dynamicModelOf`.
- `shared/llm/thinkingResolver.ts` `resolveClaudeThinkingType`: stored versus displayed Claude thinking mode.
- `src/ts/model/modellist.ts`: the tab's registry and lookups: `LLMModels`, `isDynamicModel`, `registerModelDynamic`,
  `getModelInfo`, `getModelInfoForMode`, `getModelList`. The server's lookup is `server/src/llm/request.ts`
  `requestModelLookup`.

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
  keyless public list and a local Ollama host are fetched directly; the module headers say how). Their callers, the
  pickers and panels `src/lib/Setting/Pages/Model/ModelProfileEditor.svelte` mounts (`NanoGPTDashboard.svelte` among
  them), refetch on `keyVersion`.
- `server/src/llm/credentials.ts` `resolveCredential`, `defaultCredentialKey`: the server's resolver over the plaintext
  keys; refusal messages are `server/src/llm/messages.ts` `errors.credential*`.
- `server/src/llm/auxOps.ts` `AUX_OPS`, `planAuxOp`: the `/proxy2` auxiliary operations ([server](self-host-server.md)):
  the media, memory, model discovery, account, and count calls the tab makes with a stored key, and which rows accept a
  profile. `server/src/routes/proxy.ts` reads the `risu-aux-profile` header, and `server/src/app.ts` `auxCredential`
  resolves that profile with `resolveCredential` over the merged records (`server/src/llm/settings.ts`
  `mergeCredentials`).

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
- `server/src/llm/openAI/shared.ts`: `getOpenAIRequestKey` and `getLocalNetworkRequestOptions`.
- `server/src/llm/shared.ts` `applyParameters`, `applyAdditionalParameters`: server parameter application and the
  trusted custom-parameter syntax, mirrored in `src/ts/process/request/shared.ts`.
- `server/src/llm/redact.ts`: `REDACTED`, `collectSecrets`, `createRedactor`; the secret projection.
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
  server counter; the routes are `server/src/routes/tokens.ts`.
- `shared/prompt/chatTokens.ts` `ChatTokenCounter`, `ChatTokenHost`, and `shared/prompt/imageTokens.ts` `imageTokens`: a
  prompt's token arithmetic, the same on both runtimes.
- The context report (`shared/contextReport.ts`, written by `assemblePrompt`) makes no counts of its own: it records the
  counts assembly already makes; `toolSchemas` is the send's schema estimate, outside `input`. Its `tokenScope` is the
  job scope's `tokenizerIdentityKey` (`tokenScopeFor`, `pluginTokenizer: "none"`), so a tab comparing it uses that scope
  too.

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
- `src/lib/UI/GUI/CredentialSelect.svelte`: the per-profile key select.
- `src/lib/UI/ModelList.svelte`, `src/lib/UI/ModelGrid.svelte`, `src/lib/UI/OpenrouterProviderList.svelte`,
  `src/lib/UI/NanoGPTDashboard.svelte`, `src/lib/UI/NanoGPTProviderPicker.svelte`: pickers and panels that write only
  their bindable `value`; slot writes are `src/lib/Setting/Pages/Model/ProfileSlotSelect.svelte`'s (see `Coupling`).

## Flows

- Every provider request except plugin providers and WebLLM runs on the server; a job's WebLLM request runs there too,
  through the job's `ctx.localGeneration`, and a job calls plugin providers in its tab. Tab requests go through
  `requestChatData` → `requestChatDataMain` → `requestServer`; jobs enter the server outer loop (`requestChatDataOuter`)
  directly. Plugin v3 calls `requestChatDataMain` itself (`src/ts/plugins/apiV3/v3.svelte.ts`). Both runtimes apply
  `applyReverseProxyOverride` (`shared/llm/reverseProxy.ts`) before dispatch.
- Slot routing is `resolveSlotProfile`'s on both runtimes ([slot resolver](#model-preset-slots)): a refusal fails the
  tab's attempt with `noRetry` and the server's before dispatch; no alternate profile is tried.
- The server builds a detached request context with profile roots, resolves the named credential, reforms the prompt
  from model flags, and dispatches by `LLMFormat`. A bound Vertex account populates `vertexCredential`; other bound keys
  replace `arg.key`. See [credential binding](#credentials).
- Server parsers produce cumulative `StreamResponseChunk` snapshots; `POST /api/llm/request` sends them as
  `set`/`append`/`remove` patches (legacy Ooba strings as `chunkText`), and `requestServer` rebuilds the snapshots. Job
  requests read the snapshots directly. Adapter comments own parser details. A tab request's tool calls go through the
  `mcpTool` callback (`mcp.ts` `callTool`), a job's through its job tool service; the adapter appends the results and
  sends the follow-up request.
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
- Tool-call and overload retries stay bounded and abortable; the adapter and `outer.ts` comments own the retry limits.

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
  tokenizer tests ([test-harness](test-harness.md) `Fixtures`).
- Browser checks outside the gate: `util/playwright/checkCredentialTraffic.mjs` (coverage and exclusions in the file)
  and `checkLlmTransport.mjs`.
- Not tested: proxy routing in the tab. `checkCredentialTraffic.mjs` omits non-OpenAI provider sends, several
  discovery/account calls, previews, and Whisper through its component.

## Known Hazards

### Issues

- The `/proxy2` media, memory, and count rows and the Google/Anthropic/OpenAI discovery lists keep flat default keys;
  they do not accept a profile. A model-profile follow-up (Remaining Follow-Ups in the
  [archive](../archived-plan/README.md)).
- NanoGPT's `providers.nanogptSubscriptionState` and `nanogptUseSubscriptionEndpoint` remain global: two profiles on
  different accounts share subscription state and endpoint selection. A model-profile follow-up (Remaining Follow-Ups in
  the [archive](../archived-plan/README.md)).
- A profile whose `modelId` names a catalogue id that is later renamed or removed keeps it: unless the id matches a
  dynamic template, the profile resolves as an as-is OpenAI-compatible model until the user picks another model.
- The server counter's `selectTokenizer` maps a `llama3` custom or plugin tokenizer override to `llama`; the playground
  route uses the `llama3` family.
- `CustomModelsSettings` does not expose every format or tokenizer value (Plugin, Ollama, Horde, Echo, NanoGPT variants,
  WebLLM, and `Local` are missing).
- Multimodal counts remain approximate: Claude/Gemini images use the GPT-4o fallback; video/audio/signature entries use
  a flat 85 tokens.
- `server/src/llm/redact.ts` matches a credential's stored, JSON-escaped, and `encodeURIComponent` forms. Its exact
  string matcher does not normalize lowercase percent escapes; designated `key`, `api_key`, and `token` query parameters
  are still redacted by name.

### Limitations

- An overload error event inside an Anthropic stream becomes redacted `Error:<message>` answer text (an OpenAI Responses
  error event becomes the answer too; an OpenAI Chat `error` event fails the stream). There is no in-stream retry;
  `outer.ts` `requestChatDataOuter` owns the retry policy and honors `antiServerOverloads`. Decision:
  `server/src/llm/anthropic.ts`, the stream error comment.
- Claude tool calls are not streamed or batched: `requestClaude` sends a request that offers tools buffered and
  directly, with `stream: false` on it and every tool follow-up, even with `useStreaming` or `claudeBatching` on. The
  SSE and batch result parsers read text and thinking only. Upstream has the same gap. Decision: owner, 2026-11-08.
- MCP tool schemas are charged only in assembly's final recheck, as an estimate: memory budgets and the no-memory trim
  plan without them, so the recheck can drop removable entries they kept. Decision: Found Issues Clearance Q2,
  2026-11-09.
- Auxiliary requests still tokenize bias strings with the main model, not their own profile's tokenizer. Decision:
  `shared/llm/request.ts` `tokenizer`.
- A legacy plugin `custom` tokenizer counts with `cl100k_base` on screen and in server requests; its `tokenizerFunc` is
  never called, and delayed on-screen counts do not track the plugin tokenizer map. Decision: Server Tokenizer D1 and
  Combine Audit Fixes, [archive](../archived-plan/README.md).
- The server's `gemma` tokenizer loads `llama/llama3.json`, so Gemma counts are Llama 3 counts (also for on-screen
  counts). Decision: `server/src/prompt/tokenizers/gemma.ts` header.

### Gotchas

- Local tokenizer families encode synchronously on the server thread. Encoders stay loaded per server context until
  disposal; the web-tokenizer module loader is process-wide and serialized, and disposal does not guarantee that the
  memory returns to the OS.
