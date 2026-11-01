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
  - Transport (`globalFetch`/`fetchNative`) → `global-api.md`.
  - MCP tool definitions → `plugins-mcp.md`.
  - Prompt assembly → `chat-pipeline.md`.

## Files

### Catalogue and model resolution

- `shared/llm.ts` declares `LLMFlags`, `LLMProvider`, `LLMFormat`, `LLMTokenizer` (persisted numeric codes), `LLMModel`,
  and `LLMParameter`. `shared/llm/types.ts` re-exports them and adds `ProviderNames` and the parameter presets such as
  `OpenAIParameters`/`ClaudeParameters`.
- `shared/llm/models.ts`: `BASE_LLM_MODELS`, the static list assembled from the provider arrays (with the derived
  `-response-api` variants of OpenAI models and `-vertex` variants of Google models), and
  `resolveModelInfo(id, { enableCustomFlags, customFlags, customModels, extraModels, pluginModels })`: static IDs (then
  `extraModels`), `hf:::`, `horde:::`, `xcustom:::`, `pluginmodel:::`, `dynamicModelOf(id)`, else an as-is
  OpenAI-compatible model. Static and explicit extra/prefixed models keep precedence over dynamic ids.
- `dynamicModelOf` (`shared/llm/models.ts`) is the one discovery template builder: nonempty `dynamic_google_<id>`
  (Google, upstream id without a leading `models/`), `dynamic_anthropic_<id>` (Anthropic), and `gpt-<id>` /
  `gpt-<id>-response-api` (OpenAI Chat / Responses, upstream id without the Responses suffix). These resolve without a
  tab descriptor or registry setting, including jobs, translation, transforms, image flags, CBS, and token scopes;
  custom flags apply as for listed models. The server names dynamic models by id; the tab keeps the provider's display
  name.
- `model/modellist.ts`: the tab's registry.
  - `LLMModels`: this tab's copy of `BASE_LLM_MODELS`, which `registerModelDynamic` appends to (`isDynamicModel(id)`
    says which ids it added).
  - `registerModelDynamic`: when `dynamicModelRegistry` is on, fetches model lists from Google, Anthropic, and OpenAI.
    It uses `dynamicModelOf` for all descriptor fields except display names and recommendations.
  - `getModelInfo(id, scope?, profile?)`: `resolveModelInfo` with the custom flags of `profile` (`null`: the schema
    defaults, no profile), else of the main profile of `scope`'s model preset (a request's captured pair) or of the
    selected one, `settings.customModels` (the record views), this tab's list, and `customV3ProviderMetaStore`.
    `getModelInfoForMode(mode, scope?)`: the same for the profile a mode resolves to (`resolveModelSlot`).
  - `getModelList`: grouped models for the UI, or a new ungrouped array of catalogue and plugin models; listing never
    appends plugins to `LLMModels`.

### Model preset slots

A slot here is a model preset's routing position (`mainSlot`, `subSlot`, `auxSlots`). A credential slot, under
`Credentials`, is a different thing: the kind of key a model accepts. `shared/database.ts` declares `ModelSlot`,
`ModelPreset`, and the profile record `ModelProfile`.

- `shared/llm/modelSlots.ts`: the slot routing both runtimes share.
  `resolveSlotProfile(modelPreset, profiles, mode, staticModel?, profileId?)` answers
  `{ kind: "profile", profile, modelId }`, `{ kind: "none", modelId }` (no profile: the profile fields at their schema
  defaults and the flat default key), or
  `{ kind: "refused", reason: "missingProfile" | "missingNamedProfile" | "needsProfile" }`.
- `definitionNeedsProfile(modelId)` (`shared/llm/modelSlots.ts`): the definitions a bare slot cannot run
  (`reverse_proxy`, `openrouter`, `nanogpt`, `ollama-hosted`, `ollama-cloud`, `ooba`, `mancer`, `kobold`, the legacy
  plugin `custom`, every `xcustom:::`).

### Credentials

- `shared/llm/credentialSlots.ts` `credentialSlotOf(modelId, modelInfo)` maps a model to its accepted named-key type, or
  `null`. The binding is the profile's `credentialId`; the source table owns provider and model exceptions. Reverse
  proxies and custom endpoints have no flat default. Key-identifier models use their own `OaiCompAPIKeys` entry unless a
  `custom` credential is bound.
- `shared/llm/credentialBinding.ts` `resolveCredentialBinding(modelId, modelInfo, profile, credentials, hasKey)`: the
  one binding decision the tab and the server share. It reads the profile's own `credentialId` (none, or no profile, is
  `default`) and answers `default`, `bound`, or `refused` with the first failing reason: `unsupportedModel` (a binding
  on a model with no slot), `missing`, `empty` (`hasKey` false: the plaintext on the server, the masked status in the
  tab), `typeMismatch`, `vertexEmailMissing`.
- `model/credentials.ts`: the tab's named key readers. `credentialFor(profile, modelId?)` is `resolveCredentialBinding`
  over the profile, the records, and `secretStatus` with pending writes. An absent `credentials` or `modelProfiles`
  collection reads as empty.
- `credentialsAccepted(modelId)` (`model/credentials.ts`): the records the slot accepts, in list order: the select
  options. `credentialsUsing(credentialId)`: every profile naming the key, profiles no preset uses included: the delete
  confirmation.
- `credentialStatusFor(profile, defaultPath)` (`model/credentials.ts`) supplies discovery key gates and a refresh
  identity containing the profile, binding path, refusal state, and that key's `secretVersion`, so switching between
  named keys or from default to bound refetches.
- `model/{openrouter,nanogpt,ollama}.ts`: supported discovery/account fetches take the edited profile through
  `auxFetch`. A refused binding does not fall back to a public/default account; discovery refreshes on binding identity
  or key-version changes.
- `server/src/llm/credentials.ts` `resolveCredential(db, aiModel, modelInfo, profile)`: `resolveCredentialBinding` with
  the resolved profile and the plaintext keys, as `default`, `key`, `vertex` (`clientEmail`, `privateKey`,
  `projectId?`), or `refused` with an English message (`messages.ts` `errors.credential*`) naming the model and the
  key's name, never its value.
- `server/src/llm/auxOps.ts`: the `/proxy2` auxiliary operations (`self-host-server.md`): the media, memory, model
  discovery, account, and count calls the tab makes with a stored key (`global-api.md` `auxFetch`).
- `planAuxOp` (`auxOps.ts`) optionally takes the stored profile's credential decision: five NanoGPT rows use slot
  `nanogpt`, Ollama cloud tags `ollama`, OpenRouter models/providers `openrouter`. A profile on any other row or a
  different slot refuses (400); invalid bindings use generation's refusal message, never a default key. The app resolves
  the profile with `resolveCredential` and the shared credential merge; selected named keys join the plan's redaction
  secrets.

### Tab request layer

- `request/request.ts`: request entry points.
  - `requestChatData(arg, mode, abortSignal)`: the public entry. Handles retries, plugin before/after replacers, and
    escaping, in the tab. The character's `request` trigger runs only for a server job's requests: the tab's own
    requests go out without it.
  - `requestChatDataMain`: resolves the slot (`resolveModelSlot`, the shared resolver over the captured model preset,
    with the request's `profileId`; a refusal fails with `noRetry`); `LLMFormat.Plugin` and `LLMFormat.WebLLM` run here
    with a detached copy of the resolved profile (its system replacement, plugin provider, and chat template) and its
    named-key decision (`requestPlugin`, `requestWebLLM`, after `reformater`), every other format goes to the server
    through `requestServer`.
  - `requestIds` (a chatless request's captured prompt preset, model preset, and persona; the tab's translator pipeline
    captures them once per run, `src/ts/translator/translator.ts`): used where a plugin context's ids would be (the
    preset-gone checks before each attempt, `requestChatDataMain`'s scope, WebLLM's user name, the transport's ids); a
    request with a chat ignores it.
- `request/transport.ts` `requestServer(arg, mode, abortSignal, modelInfo)`: the tab half of `POST /api/llm/request`. It
  captures the chat/preset/persona and tokenizer scope before awaiting the resource flush, then posts serializable
  request args and tool descriptors. It consumes result and stream events, handles log/inlay/tool records, and answers
  MCP/CBS callbacks; cancelling the response aborts the request, and a stream without a terminal is an error. Only a
  plugin callback carries its `channelCall` parentage (see [plugins](plugins-mcp.md)).
- The provider adapters exist only on the server (`server/src/llm/`); the tab has no copy. `process/stringlize.ts`
  `unstringlizeChat` serves the tab's plugin provider path.
- `request/shared.ts` `applyParameters`: the preset's parameters, for every mode. A preset's stored `seperateParameters`
  fields are never read.

### Server request layer

- `server/src/llm/request.ts` `requestChatDataMain(arg, mode, ctx)`: the server resolves the shared slot/profile, builds
  request-local settings and model info from that profile, then dispatches to a provider adapter. Provider adapters live
  in `server/src/llm/{anthropic,google,openAI/*,nai,openrouter}.ts`.
- Auxiliary requests (`server/src/llm/request.ts`) use their own URL, routing, flags, and templates without mutating the
  job's frozen database. Plugin providers and WebLLM are explicit job-side exceptions; they use the request context's
  tab callback and server model service.
- `server/src/llm/openAI/shared.ts` `getLocalNetworkRequestOptions(url, db, useStreaming)`: when the resolved profile's
  `localNetworkMode` is on and the URL is local-network, it supplies `networkRoute: "local_network"`; streaming calls
  also receive the profile's positive `localNetworkTimeoutSec` (default 600 seconds). OpenAI Chat and Responses use it
  for request and replacement URLs.
- `server/src/llm/sseLines.ts` `SseLines`: one streaming UTF-8 decoder per response body, retaining only the unparsed
  line suffix and flushing an unterminated final line. Each tool follow-up body gets fresh parser state.
- The line-based parsers, OpenAI Chat (`openAI/requests.ts`), Google/Vertex Gemini (`google.ts`), and Anthropic
  (`anthropic.ts`), apply each provider event once, skip malformed lines individually, and emit at most one cumulative
  snapshot per read that applies an event. OpenAI content, reasoning, and tool argument deltas are concatenated as
  deltas. Snapshots carry key `"0"`; tool metadata and Gemini thoughts, signatures, usage, and model status survive to
  the final snapshot.
- `server/src/llm/settings.ts` `loadRequestDb(store, kinds, ids)`: takes one store read and builds the request database
  from the selected preset/profile, persona, provider settings, custom model definitions, credentials, and their secret
  values. A missing preset or persona throws `RequestTargetGoneError`; a request never falls back to another selection.
- `server/src/llm/requests.ts` `createLlmRequests`: owns request admission and `runInJob`, which carries the job's
  frozen settings, tokenizer scope, tools, callbacks, and abort signal into a request. Its `strongBan` token cache is
  keyed by tokenizer identity. Request history and observer details are in [diagnostics](diagnostics.md) and
  [server](self-host-server.md).

### Tokenizer selection and server counting

- `shared/tokenizerChoice.ts` `selectTokenizer`: which tokenizer family counts a model's text
  (`openrouter`/`reverse_proxy` by `customTokenizer`, a legacy plugin `custom` model by its declared tokenizer, else the
  catalogue family; `Llama3`, `Local`, and `Unknown` count with `cl100k_base`), used for selection by the server counter
  and routes. The module also defines `TabTokenScope` and `tokenizerIdentityKey` for the tab's scope and count cache.
- Encoders: `server/src/prompt/tokenizers/index.ts` `LOADERS` holds one loader per `TokenizerFamily`; `createTokenizers`
  loads a family on first use and keeps it. Payloads are `server/assets/token/` files (`payloads.ts`) read through
  `webTokenizers.ts` or `gemma.ts`; the tiktoken families use the package's data (`tiktoken.ts`).
- The server counter (`server/src/prompt/tokens.ts` `createTokenCounter`) shares one Google call among concurrent counts
  of the same text and model and keeps at most `GOOGLE_COUNT_MAX_CONCURRENT` (8) Google calls outstanding; the 30 s
  timeout starts when a call is sent.
- `shared/prompt/chatTokens.ts` `ChatTokenCounter`: a prompt's token arithmetic over `ChatTokenHost.count`. Both
  production hosts supply `mainModel` (the resolved main `LLMModel`) and `requestModel` (the selected OpenRouter/NanoGPT
  wire id, otherwise undefined), read only when image input is supported; count-only hosts may omit these and use the
  unknown-model fallback.
- `shared/prompt/imageTokens.ts` applies model- and detail-dependent OpenAI tile/patch rules to images, with the GPT-4o
  85/170 tile rule as the explicit fallback for unknown wire ids. Only formats using the OpenAI Chat/Responses image
  adapters honor low detail; everything else counts as high. Missing image dimensions count as 512×512;
  video/audio/signature entries count a flat 85. A model without image input keeps counting each entry as
  `chatAdditionalTokens`.
- The context report (`shared/contextReport.ts`, written by `assemblePrompt`) makes no counts of its own: it records the
  counts assembly already makes. Its `tokenScope` is the job scope's `tokenizerIdentityKey` (`tokenScopeFor`,
  `pluginTokenizer: "none"`), so a tab comparing it uses that scope too.

### Tab token counting

- `tokenizer.ts` routes on-screen counts and playground ids through authenticated server routes; tokenizers do not load
  in the tab. `tabTokenScope` captures the main model's tokenizer settings at call time and is shared with
  `request/transport.ts`; `tokenScopeKey` derives its identity. `jobTokenScope` sets `pluginTokenizer: "none"`, which
  the context meter compares with the report's `tokenScope`.
- `countTokens` posts the captured scope to `/api/tokens/count`. Signal-less calls in one macrotask coalesce by scope;
  batches split at 256 texts or 1 MiB of JSON-escaped UTF-8, with oversized texts sent alone. Its 1500-entry LRU is
  keyed by text and tokenizer identity when caching is enabled. A `null` rejects one text; a failed or malformed batch
  rejects as a whole. Aborts stop remaining server work and cancel a shared Google count only after its last waiter
  leaves.
- `tokenizeAccurate` expands CBS before counting; `ChatTokenizer` supplies the prompt counter. `tokenCountInput` also
  captures expanded text and tokenizer identity so delayed UI counts are invalidated by relevant model or CBS changes.
- `src/ts/tokenCountField.ts` `createTokenCountField`: reusable UI count lifecycle. The first input runs immediately or
  through a caller-provided scheduler; later inputs wait 400 ms by default, abort superseded work, ignore late results,
  and keep the last applied value after failure. It runs the count untracked so the caller's input is the reactive
  dependency. Editor call sites and component behavior are indexed in [UI](ui-theming.md).

### Settings pages

- `CustomModelsSettings.svelte` edits `db.customModels` entries (`shared/database.ts` `CustomModel`): definitions with
  no key; a profile that uses one picks the key.
- `ModelProfilesSettings.svelte` (`MODEL_PROFILES_SETTINGS_MENU`; the Model menu's "Connections" / "연결" tab): the
  profile list, a delete confirmed with `presetsUsingModelProfile` and `translatorPresetsUsingModelProfile` (the last
  profile is kept), and `Model/ModelProfileEditor.svelte`, which edits the selected profile by id.
- `ApiKeysSettings.svelte` (`API_KEYS_SETTINGS_MENU`; the Model menu's API Keys tab): the named keys, with the
  write-only value through `SecretInput`, a delete confirmed with `credentialsUsing`, and every profile binding with a
  missing key marked.
- `Model/ProviderDefaultKeys.svelte` (`ApiKeysSettings.svelte`): each provider's flat default key for the models the
  selected model preset's slots use. It is the only place that edits the OpenAI and Google keys, listed there also while
  the image provider is DALL-E or Imagen, or when a status link asked for them; see [settings](settings-i18n.md).

## Flows

- Every provider request except plugin providers and WebLLM runs on the server. Tab requests go through
  `requestChatDataMain` → `requestServer`; jobs enter the server outer loop directly. Plugin v3 may call
  `requestChatDataMain` itself. Both runtimes apply `applyReverseProxyOverride` before dispatch.
- `resolveSlotProfile` selects a named `profileId` first, regardless of mode. A supplied `staticModel` short-circuits
  slot routing: it uses the main profile only on an id match, otherwise it resolves as a bare static model with no
  profile (and refuses if that definition needs one). With no `staticModel`, `model` uses main, configured auxiliary
  modes use their slot, and other modes (including `submodel`) use sub. An unset auxiliary slot falls back to sub.
  Dangling profiles refuse with `noRetry`; no alternate profile is tried. The [slot resolver](#model-preset-slots) owns
  these rules.
- The server builds a detached request context with profile roots, resolves the named credential, reforms the prompt
  from model flags, and dispatches by `LLMFormat`. A bound Vertex account populates `vertexCredential`; other bound keys
  replace `arg.key`. See [credential binding](#credentials).
- Streams carry cumulative `StreamResponseChunk` snapshots (text at key `'0'` plus metadata). Tool calls go through
  `mcp.ts:callTool`; results are appended before the request recurses.

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
- UI model pickers write the slots through the store actions (`setMainModelSlot`, `setSubModelSlot`, `setAuxModelSlot`)
  and edit profiles through `profileForSlot`/`updateModelProfile` (`settingsViews.svelte.ts`,
  `collectionStore.svelte.ts`).

## Invariants

- Only append to the numeric enums (`LLMFlags`, `LLMProvider`, `LLMFormat`, `LLMTokenizer`). Saved custom models store
  these numbers.
- A model's `format`, `flags`, `parameters`, `internalID`, endpoint, and tokenizer must agree. Wrong flags silently
  change the prompt shape.
- A `dynamic_anthropic_<id>` whose suffix matches an Anthropic-provider static entry's `internalID` or `id` inherits
  that entry's capabilities, including flags, parameters, format, and tokenizer, while retaining its dynamic `id` and
  upstream `internalID`. Unknown dynamic Anthropic ids keep the generic budget/adaptive template without
  `claudeThinkingOnByDefault`. Both the tab registry and server resolution use `dynamicModelOf`.
- Profile custom flags replace catalogue flags. `ModelProfileEditor.svelte` and `CustomModelsSettings.svelte` expose
  `noStructuredOutput` (25), `geminiThinkingNoMinimal` (26), and `claudeThinkingOnByDefault` (27) alongside the earlier
  flags, labelled by their `LLMFlags` names.
- `claudeThinkingOnByDefault`: off sends `thinking: { type: "disabled" }`; models without the flag omit `thinking` when
  off.
- `resolveClaudeThinkingType` resolves stored `budget` to `adaptive` on adaptive-only models (`claudeAdaptiveThinking`
  without `claudeThinking`) at request and display time; the stored value is never rewritten. Budget-capable models keep
  their mode. Picking Adaptive while the stored value is `budget` writes nothing because it already displays as
  Adaptive.
- Streaming consumers expect cumulative text, not deltas. Tool metadata must survive to the final chunk.
- `escape` disables streaming. Audio and image output modalities disable streaming.
- Mode `submodel` is not a `seperateModels` key.
- Additional parameters apply last and can override or delete body fields and headers:
  - `header::` targets a header.
  - `{{none}}` deletes the field.
  - `json::` parses a JSON value.
  - Dotted keys address nested fields.
  - Treat these as trusted user configuration.
- Configured provider URLs are fetched from the server, so `localhost` is the server's (in Docker, the container's: use
  `host.docker.internal` or the host's address).
- `requestChatDataMain` mutates its argument object. Do not reuse it after the call.
- A provider change goes into the server's adapters (`server/src/llm/`). They read nothing outside `arg.ctx` and their
  arguments.
- Slot routing lives only in `resolveSlotProfile`: the tab and the server both call it; never keep a local copy of the
  rules. A slot naming a deleted profile refuses; it never falls back to another slot or profile.
- An auxiliary request's profile fields reach the adapters only through the request-local `ctx.db`; the job's frozen db
  and a captured profile are never mutated.
- A named key binding that cannot be honored refuses the request and never falls back to the default key. The tab's
  state and the server's decision both come from `resolveCredentialBinding`; change the rules there, not in one caller.
- An adapter prefers `arg.key` where its model has a credential slot (the resolver's bound key arrives there). The
  OpenAI Chat, Responses, and legacy instruct adapters take their key from `openAI/shared.ts` `getOpenAIRequestKey`:
  `arg.key`, else a `keyIdentifier` model's own `OaiCompAPIKeys` entry or `""` (never another provider's key), else the
  provider default (`""` for a custom model or the reverse proxy: `credentials.ts` `defaultCredentialKey`).
- Every credential value a request can carry is collected by `redact.ts` `collectSecrets`: a new credential field or map
  joins it.
- Nothing the tab receives from `/api/llm/request` but a model's answer (results, chunks) skips `redact.ts`; a model's
  answer is not redacted (it would rewrite URLs in the text).
- On the server an unhandled promise rejection ends the process: a fire-and-forget promise in a ported adapter (a
  `pipeTo`, a `fetch`) must catch.
- `cl100k_base` and `o200k_base` refuse text containing the special token `<|endoftext|>`; the count route returns
  `null` for that text, and the tab rejects its count.
- Tokenization does not follow a per-call `profileId`: a request's tokenizer scope is still the main model's (the tab's
  `context.tokenizer`, a job's `tokenScopeFor`), so token biases and bans of a per-call request use the main model's
  tokenizer (translation sends none).
- A failed request that follows a tool call (the Chat and Responses adapters in `openAI/`, the Gemini adapter; buffered
  and streaming) is retried up to `requestRetrys` times, each retry after `util.ts` `toolRetryDelay` (1, 2, 4, then 8 s)
  waited with the request's abort signal, so Stop ends the wait and sends nothing more. `google.ts` `fallBackGemini`
  (the `antiServerOverloads` re-request of a `RESOURCE_EXHAUSTED` answer) is bounded the same way: at most
  `requestRetrys` re-requests, each after that wait, then the original failure.

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
     (`shared/tokenizerChoice.ts`), and for a name a user can pick, `byName`, `playgroundFamily`, and `tokenizerList`
     (`src/ts/tokenizer.ts`). Add the `CustomModelsSettings` option.
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
  `pnpm --silent test:agent server/src/tests/{llm*,token*,sseLines,imageTokens,auxOps,providerModels}.test.ts` for the
  server.
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
  they do not accept a profile. `openrouter.ts` `getFreeOpenRouterModels` also keeps the default key. A model-profile
  follow-up (Remaining Follow-Ups in the [archive](../archived-plan/README.md)).
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

- An overload error event inside an Anthropic stream becomes redacted `Error:<message>` answer text, like other streamed
  provider errors. There is no in-stream retry; `outer.ts` `requestChatDataOuter` owns the retry policy and honors
  `antiServerOverloads`. Decision: `server/src/llm/anthropic.ts`, the stream error comment.
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
