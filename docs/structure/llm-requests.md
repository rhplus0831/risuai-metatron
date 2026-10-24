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
  - the named API keys ([credential binding](llm-requests.md)): which key a model sends (the slot table, the shared binding decision, the server resolver) and their UI (the Model menu's API Keys tab, the per-model key select),
  - the model-picker UI.
- Paths:
  - `src/ts/process/request/*` (including `tests/`)
  - `server/src/llm/**`, `server/src/routes/llm.ts` (the server request layer)
  - `shared/llm/**` (the static catalogue and the `/api/llm/request` contract)
  - `src/ts/model/*`
  - `src/ts/process/webllm.ts`
  - `src/ts/horde/getModels.ts`
  - `src/ts/tokenizer.ts`, `src/ts/tokenCountField.ts`, `shared/tokenizerChoice.ts`, `shared/prompt/{chatTokens,imageTokens}.ts`
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
- `shared/llm/thinkingResolver.ts` `resolveClaudeThinkingType`: shared by `requestClaude` and `botSettingsParamsData.ts` for the thinking-mode value and budget/adaptive control visibility.
- `shared/llm/reverseProxy.ts` `applyReverseProxyOverride`: the tab and server apply the profile's `customProxyRequestModel` and `customAPIFormat` to the reverse proxy's request-local descriptor before dispatch.
- `shared/llm/models.ts`: `BASE_LLM_MODELS`, the static list assembled from the provider arrays (with the derived `-response-api` variants of OpenAI models and `-vertex` variants of Google models), and `resolveModelInfo(id, { enableCustomFlags, customFlags, customModels, extraModels, pluginModels })`: static IDs (then `extraModels`), `hf:::`, `horde:::`, `xcustom:::`, `pluginmodel:::`, `dynamicModelOf(id)`, else an as-is OpenAI-compatible model. `dynamicModelOf` is the one discovery template builder: nonempty `dynamic_google_<id>` (Google, upstream id without a leading `models/`), `dynamic_anthropic_<id>` (Anthropic), and `gpt-<id>` / `gpt-<id>-response-api` (OpenAI Chat / Responses, upstream id without the Responses suffix). These resolve without a tab descriptor or registry setting, including jobs, translation, transforms, image flags, CBS, and token scopes; custom flags apply as for listed models. The server names dynamic models by id; the tab keeps the provider's display name. Static and explicit extra/prefixed models keep precedence.
- `shared/llm/credentialSlots.ts` `credentialSlotOf(modelId, modelInfo)`: a model's credential slot, `{ slot, accepts, defaultDescription }` or `null` (no named key). The binding itself is always the profile's `credentialId`. In precedence order: `xcustom:::` → `customModel` and `reverse_proxy` → `reverseProxy` (every type but `vertex`; no flat default: with no named key they send none, [credential binding](llm-requests.md)), a `keyIdentifier` model (DeepSeek, DeepInfra) → `keyIdentifier` (`custom` only; default `OaiCompAPIKeys.<id>`), then by id `openrouter`, `nanogpt` (every NanoGPT format), `ollama-cloud`, then by provider `OpenAI`, `Anthropic`, `AWS` (`bedrock` only, the composite `accessKeyId:secretAccessKey:region`), `GoogleCloud`, `VertexAI` (`vertex` only), `Mistral`, `Cohere`, `NovelAI`, and an as-is or keyless DeepSeek/DeepInfra OpenAI-format model (`openai`); a provider slot accepts its own type and `custom`. Mancer, NovelList, Horde, Ooba/Kobold, local Ollama, plugin, WebLLM, and Echo have none.
- `shared/llm/credentialBinding.ts` `resolveCredentialBinding(modelId, modelInfo, profile, credentials, hasKey)`: the one binding decision the tab and the server share. It reads the profile's own `credentialId` (none, or no profile, is `default`) and answers `default`, `bound`, or `refused` with the first failing reason: `unsupportedModel` (a binding on a model with no slot), `missing`, `empty` (`hasKey` false: the plaintext on the server, the masked status in the tab), `typeMismatch`, `vertexEmailMissing`.
- `shared/llm/modelSlots.ts`: the slot routing both runtimes share ([model profiles and slots](llm-requests.md)). `resolveSlotProfile(modelPreset, profiles, mode, staticModel?, profileId?)` answers `{ kind: "profile", profile, modelId }`, `{ kind: "none", modelId }` (no profile: the profile fields at their schema defaults and the flat default key), or `{ kind: "refused", reason: "missingProfile" | "missingNamedProfile" | "needsProfile" }`. `definitionNeedsProfile(modelId)`: the definitions a bare slot cannot run (`reverse_proxy`, `openrouter`, `nanogpt`, `ollama-hosted`, `ollama-cloud`, `ooba`, `mancer`, `kobold`, the legacy plugin `custom`, every `xcustom:::`).
- `shared/llm/validate.ts` `isModelDescriptor`: the `LLMModel` fields the server reads (a hook list's provider descriptors, a request's dynamic model).
- `model/modellist.ts`: the tab's registry.
  - `LLMModels`: this tab's copy of `BASE_LLM_MODELS`, which `registerModelDynamic` appends to (`isDynamicModel(id)` says which ids it added).
  - `registerModelDynamic`: when `dynamicModelRegistry` is on, fetches model lists from Google, Anthropic, and OpenAI. It uses `dynamicModelOf` for all descriptor fields except display names and recommendations; Google strips `models/` before building the id.
  - `getModelInfo(id, scope?, profile?)`: `resolveModelInfo` with the custom flags of `profile` (`null`: the schema defaults, no profile), else of the main profile of `scope`'s model preset (a request's captured pair) or of the selected one, `settings.customModels` (the record views), this tab's list, and `customV3ProviderMetaStore`. `getModelInfoForMode(mode, scope?)`: the same for the profile a mode resolves to (`resolveModelSlot`).
  - `getModelList`: grouped models for the UI, or a new ungrouped array of catalogue and plugin models; listing never appends plugins to `LLMModels`.
- `model/credentials.ts`: the tab's named key readers. `credentialFor(profile, modelId?)` (`resolveCredentialBinding` over the profile, the records, and `secretStatus` with pending writes: `{ slot, state: default | bound | refused, credentialId?, record?, reason? }`), `credentialsAccepted(modelId)` (the records the slot accepts, in list order: the select options), `credentialsUsing(credentialId)` (every profile naming the key, `{ kind: "modelProfile", id, name }`, profiles no preset uses included: the delete confirmation). An absent `credentials` or `modelProfiles` collection reads as empty. `credentialStatusFor(profile, defaultPath)` supplies discovery key gates and a refresh identity containing the profile, binding path, refusal state, and that key's `secretVersion`, so switching between named keys or from default to bound refetches.
- `model/{openrouter,nanogpt,ollama}.ts`: discovery/account fetches take the edited profile and pass its id to `auxFetch` (Ollama cloud only). NanoGPT's personalized/public and subscription-list gates follow `credentialStatusFor`; a refused binding does not fall back to a public or default account. The editor, OpenRouter provider list, NanoGPT dashboard, and NanoGPT provider picker refresh on binding identity or key version changes. Model lists normalize to `ModelGridItem`.
- `model/ooba.ts`: re-exports `OobaChatCompletionRequestParams` from `shared/settings.ts`.
- `model/modelGrid.ts`: UI types.
- `request/request.ts`: request entry points.
  - `requestChatData(arg, mode, abortSignal)`: the public entry. Handles retries, plugin before/after replacers, and escaping, in the tab. The character's `request` trigger runs only for a server job's requests: the tab's own requests go out without it.
  - `requestChatDataMain`: resolves the slot (`resolveModelSlot`, the shared resolver over the captured model preset, with the request's `profileId`; a refusal fails with `noRetry`); `LLMFormat.Plugin` and `LLMFormat.WebLLM` run here with a detached copy of the resolved profile (its system replacement, plugin provider, and chat template) and its named-key decision (`requestPlugin`, `requestWebLLM`, after `reformater`), every other format goes to the server through `requestServer`.
  - `requestIds` (a chatless request's captured prompt preset, model preset, and persona; the tab's translator pipeline captures them once per run, `src/ts/translator/translator.ts`): used where a plugin context's ids would be (the preset-gone checks before each attempt, `requestChatDataMain`'s scope, WebLLM's user name, the transport's ids); a request with a chat ignores it.
- `request/transport.ts` `requestServer(arg, mode, abortSignal, modelInfo)`: the tab half of `POST /api/llm/request`. It captures the chat/preset/persona and tokenizer scope before awaiting the resource flush, then posts serializable request args and tool descriptors. It consumes result and stream events, handles log/inlay/tool records, and answers MCP/CBS callbacks; cancelling the response aborts the request, and a stream without a terminal is an error. Only a plugin callback carries its `channelCall` parentage (see [plugins and MCP](plugins-mcp.md)).
- The provider adapters exist only on the server (`server/src/llm/`); the tab has no copy. `process/stringlize.ts` stays (`unstringlizeChat` for the tab's plugin provider path).
- `server/src/llm/request.ts` `requestChatDataMain(arg, mode, ctx)`: the server resolves the shared slot/profile, builds request-local settings and model info from that profile, then dispatches to a provider adapter. A missing profile or a bare definition that requires one refuses before an upstream call. Auxiliary requests use their own URL, routing, flags, and templates without mutating the job's frozen database. Plugin providers and WebLLM are explicit job-side exceptions; they use the request context's tab callback and server model service. Provider adapters live in `server/src/llm/{anthropic,google,openAI/*,nai,openrouter}.ts`.
- `server/src/llm/openAI/shared.ts` `getLocalNetworkRequestOptions(url, db, useStreaming)`: when the resolved profile's `localNetworkMode` is on and the URL is local-network, it supplies `networkRoute: "local_network"`; streaming calls also receive the profile's positive `localNetworkTimeoutSec` (default 600 seconds). OpenAI Chat and Responses use it for request and replacement URLs.
- `server/src/llm/{settings.ts,transport.ts,requests.ts,outer.ts,credentials.ts,redact.ts}`: request database loading, transport and history capture, live request admission/retries, credential resolution, and secret redaction. `context.ts` carries the request's database, transport, tokenizer, CBS, tools, and callbacks.
  - `sseLines.ts` `SseLines`: one streaming UTF-8 decoder per response body, retaining only the unparsed line suffix and flushing an unterminated final line. The line-based OpenAI Chat (`openAI/requests.ts`), Google/Vertex Gemini (`google.ts`), and Anthropic (`anthropic.ts`) parsers apply each provider event once, skip malformed lines individually, and emit at most one cumulative snapshot per read that applies an event. OpenAI content, reasoning, and tool argument deltas are concatenated as deltas. Snapshots carry key `"0"`; tool metadata and Gemini thoughts, signatures, usage, and model status survive to the final snapshot. Each tool follow-up body gets fresh parser state.
  - `settings.ts` `loadRequestDb(store, kinds, ids)`: takes one store read and builds the request database from the selected preset/profile, persona, provider settings, custom model definitions, credentials, and their secret values. A missing preset or persona throws `RequestTargetGoneError`; a request never falls back to another selection.
  - `transport.ts`: server provider calls use `globalFetch`/`fetchNative`, with local-network options from `getLocalNetworkRequestOptions` and request-history exchange capture through `record` ([diagnostics](diagnostics.md)).
  - `requests.ts` `createLlmRequests`: owns request admission and `runInJob`, which carries the job's frozen settings, tokenizer scope, tools, callbacks, and abort signal into a request. Its `strongBan` token cache is keyed by tokenizer identity. Request history and observer details are in [diagnostics](diagnostics.md) and [self-host server](self-host-server.md).
  - `outer.ts` `requestChatDataOuter(arg, mode, deps)`: the client's outer `requestChatData` loop for a job (retries with `antiServerOverloads`, `escape`, the plugin replacers through the job's channel, the `request`-trigger slot, `banCharacterset`). Charset rejections count against `requestRetrys` and end with a failure when exhausted. The loop yields an event-loop turn before every attempt.
  - `credentials.ts` `resolveCredential(db, aiModel, modelInfo, profile)`: `resolveCredentialBinding` with the resolved profile and the plaintext keys, as `default`, `key`, `vertex` (`clientEmail`, `privateKey`, `projectId?`), or `refused` with an English message (`messages.ts` `errors.credential*`) naming the model and the key's name, never its value.
  - `redact.ts`: the secret-free projection of what goes back to the tab (logs, notices, errors, fail results, previews, callback payloads): every credential value of the request (also JSON-escaped and URL-encoded, the Bedrock key's parts, every named key's value, its `:` parts, and its client email, each Vertex token handed out) and the named credential headers and query parameters.
  - `vertexToken.ts`: Vertex service-account tokens in memory per email and key (concurrent refreshes shared; cleared at maintenance and dispose); the stored `vertexAccessToken` fields are not used.
  - `claudeObserver.ts`: the Claude cache warmer, one per server, disposed with it.
  - `auxOps.ts`: the `/proxy2` auxiliary operations (`self-host-server.md`): the media, memory, model discovery, account, and count calls the tab makes with a stored key (`global-api.md` `auxFetch`). `planAuxOp` optionally takes the stored profile's credential decision: five NanoGPT rows use slot `nanogpt`, Ollama cloud tags `ollama`, OpenRouter models/providers `openrouter`. A profile on any other row or a different slot refuses (400); invalid bindings use generation's refusal message, never a default key. The app resolves the profile with `resolveCredential` and the shared credential merge; selected named keys join the plan's redaction secrets.
- `request/shared.ts`:
  - `ModelModeExtended` = `model|submodel|memory|emotion|otherAx|translate`.
  - `applyParameters`: the preset's parameters, for every mode (the per-role `seperateParameters` were removed; the fields stay unread).
  - `getAdditionalParameters`/`applyAdditionalParameters`: user body/header overrides.
- `request/additionalParams.ts`: relaxed JSON parser.
- `process/webllm.ts`: MLC WebLLM engine, used by Hypa summarization.
- `shared/tokenizerChoice.ts` `selectTokenizer({ aiModel, customTokenizer, pluginTokenizer, modelTokenizer, googleClaudeTokenizing })`: which tokenizer family counts a model's text (`openrouter`/`reverse_proxy` by `customTokenizer`, a legacy plugin `custom` model by its declared tokenizer, else the catalogue family; `Llama3`, `Local`, and `Unknown` count with `cl100k_base`), used for selection by the server counter (`server/src/prompt/tokens.ts`) and routes. The module also defines `TabTokenScope` and `tokenizerIdentityKey` for the tab's scope and count cache.
- `shared/prompt/chatTokens.ts` `ChatTokenCounter`: a prompt's token arithmetic (message text plus `chatAdditionalTokens` once, the name, thoughts, and multimodal entries) over `ChatTokenHost.count(text): Promise<number>`. Both production hosts supply `mainModel` (the resolved main `LLMModel`) and `requestModel` (the selected OpenRouter/NanoGPT wire id, otherwise undefined), read only when image input is supported; count-only hosts may omit these and use the unknown-model fallback. `shared/prompt/imageTokens.ts` applies model- and detail-dependent OpenAI tile/patch rules to images, with the GPT-4o 85/170 tile rule as the explicit fallback for unknown wire ids. Only formats using the OpenAI Chat/Responses image adapters honor low detail; everything else counts as high. Missing image dimensions count as 512×512; video/audio/signature entries count a flat 85. A model without image input keeps counting each entry as `chatAdditionalTokens`.
- `tokenizer.ts`: on-screen counts and playground ids through the authenticated server routes; no tokenizer loads in the tab.
  - `tabTokenScope(presetScope?, mainModel?)`: captures the main model's tokenizer settings, shared with `request/transport.ts`'s `context.tokenizer`; an already resolved model avoids another lookup. `tokenScopeKey(captured = tabTokenScope())` returns that scope's `tokenizerIdentityKey`; `countTokens` uses its own captured scope for the cache key, including when given a preset scope.
  - `countTokens(text, scope?, signal?)`: `POST /api/tokens/count` with the scope captured at call time. Signal-less calls in the same macrotask coalesce by the whole scope (`setTimeout(0)`); batches split at 256 texts or 1 MiB of JSON-escaped UTF-8 text, with an oversized text sent alone. A signal owns its request; an already-aborted signal sends nothing. The 1500-entry LRU caches counts by text and `tokenizerIdentityKey` only when the captured caching flag is on. A `null` count refuses only that text; failed requests and malformed answers reject their whole batch, without retries. An aborted request also stops the server's work: it counts no further text of the batch and aborts a Google `countTokens` call in flight unless another caller still waits on it. The server counter (`server/src/prompt/tokens.ts` `createTokenCounter`) shares one Google call among concurrent counts of the same text and model and keeps at most `GOOGLE_COUNT_MAX_CONCURRENT` (8) Google calls outstanding; the 30 s timeout starts when a call is sent.
  - `tokenize`, `tokenizerChar`, and `tokenizeAccurate` use `countTokens`; `tokenizeAccurate` parses CBS synchronously before queuing its count and accepts an optional signal. `ChatTokenizer` supplies `ChatTokenHost.count` with the same main-model and image fields.
  - `tokenCountInput(text)` reads the CBS-expanded text (the same expansion as `tokenizeAccurate`) and tokenizer identity synchronously for delayed on-screen counts, or carries a preparation error. `LoreBookData` reads this input in its effect, so a model or referenced CBS value changing recounts without a text change. Both `PromptSettings` totals include `tokenScopeKey()` beside the template snapshot; their per-item CBS expansion stays inside the count. A failed preparation (a CBS limit, no model preset) is a failed count: it supersedes older counts and keeps the last shown number.
  - `getChatToken`, `getCharToken`, and `process/prompt.ts` `tokenizePreset` start their eligible texts together in one batch (subject to the split limits); preset parsing stays in item order. `shared/lore/activation.ts` starts counts while parsing CBS in entry order, handles early rejections, then awaits all counts before the budget pass.
  - `encodeWithTokenizer` posts `{ tokenizer, text }` to `/api/tokens/encode` and validates the returned ids. `tokenizerList` remains the playground and model editor's list of names.
- `src/ts/tokenCountField.ts` `createTokenCountField`: reusable UI count lifecycle. The first input runs immediately or through a caller-provided scheduler; later inputs wait 400 ms by default, abort superseded work, ignore late results, and keep the last applied value after failure. It runs the count untracked so the caller's input is the reactive dependency. Editor call sites and component behavior are indexed in [UI theming](ui-theming.md).
- `CustomModelsSettings.svelte`: edits `db.customModels` entries `{id:'xcustom:::uuid', internalId, url, format, tokenizer, name, params, flags}`: definitions with no key; a profile that uses one picks the key.
- `CredentialSelect.svelte` (`src/lib/UI/GUI/`): a profile's key select (`profileId`): "Default (<slot default>)", the keys `credentialsAccepted` offers, a disabled "Missing key" entry for a dangling binding, and the refusal reason (`text-draculared`). It writes `setProfileCredential`; "Default" removes the binding. Nothing renders for a model with no slot unless a binding exists (then the refusal and a remove button). Used by the profile editor.
- `ModelProfilesSettings.svelte` (`MODEL_PROFILES_SETTINGS_MENU`, 18; the Model menu's "Connections" / "연결" tab): the profile list (add, copy, rename, delete confirmed with `presetsUsingModelProfile`; the last profile is kept) and `Model/ModelProfileEditor.svelte`, which edits the selected profile by id: the model, the key (`CredentialSelect`), and the blocks for that model (reverse proxy, OpenRouter, Ooba/Kobold/textgen URLs, Ollama and NanoGPT models, local-network access and timeout, custom flags, system replacement, chat template, tools, `maxContext`, image output).
- `ModelSettings.svelte` (the model preset, the Model menu's Preset tab) picks a profile per slot with `Model/ProfileSlotSelect.svelte` ("profile name — model name"; a dangling slot is marked missing; a bare auxiliary slot shows "no connection (model name)" with an action that creates a profile from it).
- `ApiKeysSettings.svelte` (`API_KEYS_SETTINGS_MENU`, 17; the Model menu's API Keys tab): `Model/ProviderDefaultKeys.svelte` (each provider's flat default key for the models the selected model preset's slots use, and the Vertex default key's client email and project id; the OpenAI and Google keys are also listed while the image provider is DALL-E or Imagen, or when a status link asked for them, which opens the accordion on them: the only place that edits them, see [settings-i18n](settings-i18n.md)), the named keys (name, type, the write-only value through `SecretInput` on `{ kind: "entry", field: "credentials", id }`, the Vertex client email and project id), Add key, a delete confirmed with `credentialsUsing`, and every profile binding with a missing key marked and a "Use default key" action.

## Flows

0. Every provider call except a plugin provider and WebLLM runs on the server: the tab's `requestChatData` loop calls `requestChatDataMain`, which hands the request to `requestServer`; the server reads the settings and credentials by the ids it is sent, runs its `requestChatDataMain`, and streams the answer back. A server job calls the server's outer loop directly (`outer.ts`). The steps below describe the server copy.
1. The tab's callers invoke `requestChatData`: the translator (`'translate'`), the HypaV3 modal's summaries (`'memory'`), `Suggestion.svelte`, MCP `aiaccess`, `IrisModal` (`'otherAx'`), image prompts (`stableDiff.ts`), and the playground. Plugin v3 `runLLMModel` calls `requestChatDataMain` directly. A send, memory, emotion, triggers, and Lua (`runLLM`) request from the server job.
2. `requestChatDataMain` resolves the slot's profile (`resolveSlotProfile`): 0. `profileId` (`RequestArgs.profileId`, a per-call profile: a translator step's model, [translation](media-aux.md)) → that profile whatever the mode, `staticModel` included; a missing one refuses (`missingNamedProfile`), never falling back to the slot. The route accepts it as a record id (`isRecordId`). Tokenization does not follow it: a request's tokenizer scope is still the main model's (the tab's `context.tokenizer`, a job's `tokenScopeFor`), so token biases and bans of a per-call request use the main model's tokenizer (translation sends none).
   1. `staticModel` → the main slot's profile when its model id equals `staticModel`, else no profile (a definition that needs a profile refuses).
   2. Mode `model` → the main slot.
   3. Modes `memory`, `translate`, `emotion`, `otherAx` with `seperateModelsForAxModels` on and that auxiliary slot set → that slot; a bare slot (`{ modelId }`) is no profile.
   4. Otherwise (`submodel` included) → the sub slot.
   5. A slot naming a deleted profile, or a bare definition that needs a profile, returns `{ type: "fail", noRetry: true }` before any upstream call.
   6. Then the request-local `ctx` (the profile's fields over the roots), `getModelInfo` with that profile's flags, the reverse-proxy and custom URL injection, the named key (`resolveCredential` with the profile: a bound key replaces `targ.key`, a bound Vertex account sets `targ.vertexCredential`, a binding that cannot be honored refuses the same way), and `reformater`.
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
  - Model choice: the model preset's `mainSlot`, `subSlot`, `auxSlots` (`{ profileId }`, or `{ modelId }` in an auxiliary slot) and `seperateModelsForAxModels`; each profile's `modelId`. The root names `aiModel`, `subModel`, and `seperateModels` are derived model ids, never stored.
  - Profiles (`modelProfiles`): the model id, `credentialId?`, and the connection, routing, compatibility, and capacity fields, including the NanoGPT and Ollama model fields, `customTokenizer`, `localNetworkMode`, and `localNetworkTimeoutSec`; at root, the main profile's values.
  - Custom models and parameters: `customModels` (definitions), `additionalParams`.
  - Keys per provider: the flat defaults (`llmSecrets` flat fields, `OaiCompAPIKeys`); a custom model and the reverse proxy have none.
  - Named API keys: `credentials` (records), `llmSecrets.credentials.<id>.key` (values), and the profiles' `credentialId`.
  - Provider behavior toggles (OpenRouter middle-out and fallback, caching, `autofillRequestUrl`, ...) stay in `providers`.
  - `dynamicModelRegistry`.
- `requestDataResponse` is `{type: 'success'|'fail'|'streaming'|'multiline', result, ...}`.

## Coupling

- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (`globalFetch`/`fetchNative`), `stringlize.ts`, `templates/chatTemplate.ts`, `tokenizer.ts`, `mcp.ts`, plugin stores (`pluginHooks.ts` `pluginHooks`/`customProviderStore`, `customV3ProviderMetaStore`), inlays, and `platform.ts`.
- UI model pickers write the slots through the store actions (`setMainModelSlot`, `setSubModelSlot`, `setAuxModelSlot`) and edit profiles through `profileForSlot`/`updateModelProfile` (`settingsViews.svelte.ts`, `collectionStore.svelte.ts`).

## Invariants

- Only append to the numeric enums (`LLMFlags`, `LLMProvider`, `LLMFormat`, `LLMTokenizer`). Saved custom models store these numbers.
- A model's `format`, `flags`, `parameters`, `internalID`, endpoint, and tokenizer must agree. Wrong flags silently change the prompt shape.
- A `dynamic_anthropic_<id>` whose suffix matches an Anthropic-provider static entry's `internalID` or `id` inherits that entry's capabilities, including flags, parameters, format, and tokenizer, while retaining its dynamic `id` and upstream `internalID`. Unknown dynamic Anthropic ids keep the generic budget/adaptive template without `claudeThinkingOnByDefault`. Both the tab registry and server resolution use `dynamicModelOf`.
- Profile custom flags replace catalogue flags. `ModelProfileEditor.svelte` and `CustomModelsSettings.svelte` expose `noStructuredOutput` (25), `geminiThinkingNoMinimal` (26), and `claudeThinkingOnByDefault` (27) alongside the earlier flags, labelled by their `LLMFlags` names.
- `claudeThinkingOnByDefault`: off sends `thinking: { type: "disabled" }`; models without the flag omit `thinking` when off.
- `resolveClaudeThinkingType` resolves stored `budget` to `adaptive` on adaptive-only models (`claudeAdaptiveThinking` without `claudeThinking`) at request and display time; the stored value is never rewritten. Budget-capable models keep their mode. Picking Adaptive while the stored value is `budget` writes nothing because it already displays as Adaptive.
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
- Slot routing lives only in `resolveSlotProfile`: the tab and the server both call it; never keep a local copy of the rules. A slot naming a deleted profile refuses; it never falls back to another slot or profile.
- An auxiliary request's profile fields reach the adapters only through the request-local `ctx.db`; the job's frozen db and a captured profile are never mutated.
- A named key binding that cannot be honored refuses the request and never falls back to the default key. The tab's state and the server's decision both come from `resolveCredentialBinding`; change the rules there, not in one caller.
- An adapter prefers `arg.key` where its model has a credential slot (the resolver's bound key arrives there). The OpenAI Chat, Responses, and legacy instruct adapters take their key from `openAI/shared.ts` `getOpenAIRequestKey`: `arg.key`, else a `keyIdentifier` model's own `OaiCompAPIKeys` entry or `""` (never another provider's key), else the provider default (`""` for a custom model or the reverse proxy: `credentials.ts` `defaultCredentialKey`).
- Every credential value a request can carry is collected by `redact.ts` `collectSecrets`: a new credential field or map joins it.
- Nothing the tab receives from `/api/llm/request` but a model's answer (results, chunks) skips `redact.ts`; a model's answer is not redacted (it would rewrite URLs in the text).
- On the server an unhandled promise rejection ends the process: a fire-and-forget promise in a ported adapter (a `pipeTo`, a `fetch`) must catch.
- `cl100k_base` and `o200k_base` refuse text containing the special token `<|endoftext|>`; the count route returns `null` for that text, and the tab rejects its count.

### Compatibility Model-Root Writes

`src/ts/storage/settingsViews.svelte.ts` `writeModelRoot` is the client compatibility
boundary for flat model roots used by plugins and settings views. A supplied
`scope.modelPresetId` fixes the target; otherwise the model preset selected when
the write runs is used. `modelId` and `credentialId` are not forwarded profile roots.

- An equal read-back value is a no-op; it never re-matches or repairs a slot.
  A changed `aiModel`/`subModel` must name exactly one profile, then writes that
  profile id into the corresponding main/sub slot. Missing or ambiguous matches refuse.
- An auxiliary `seperateModels.<mode>` value of `""` clears that slot. One matching
  profile binds it; zero matches produces a bare `{ modelId }` only when
  `definitionNeedsProfile` is false; several matches refuse.
- A whole `seperateModels` object applies only its supplied modes, independently.
  A refused mode does not roll back another mode. The auxiliary toggle accepts a boolean.
- Profile-root writes, including `maxContext`, update the existing main profile
  after `isJsonData` validation and a detached clone; they do not create a profile.
  Shared profiles therefore affect every preset that names them.
- Refusals warn, retain the old value, and return false without throwing so later
  plugin keys can still apply. New UI code should use explicit profile/slot actions;
  [persistence](persistence.md) owns the record/view write boundaries.

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

- Catalogue, slots, and credentials: `shared/llm/tests/{models,modelSlots,credentialSlots,credentialBinding}.test.ts`, `src/ts/model/tests/{credentials,discovery,modelInfoScope}.test.ts`, and `server/src/tests/{llmSecrets,providerModels}.test.ts` cover catalogue resolution, slot/profile routing, credential refusal, and provider discovery. `e2e/apiKeys.spec.ts` covers key editing and profile binding.
- Request construction and adapters: `src/ts/process/request/tests/{additionalParams,requestPresetScope,transport}.test.ts`, `server/src/tests/{llmRoutes,llmProviderAdapters,llmResponsesApi}.test.ts`, and `server/src/tests/llmServices.test.ts` cover request scoping, parameter application, HTTP dispatch, adapters, Responses, and secret redaction.
- Streaming: `server/src/tests/{llmStreamParsing,sseLines}.test.ts` cover provider event parsing, cumulative snapshots, split UTF-8 input, tool metadata, and cancellation.
- Token counting: `server/src/tests/{imageTokens,tokens,tokenRoutes}.test.ts`, `src/ts/tokenizer.test.ts`, and `src/ts/process/prompt.tokenize.test.ts` cover image arithmetic, server count routes, count/encode client behavior, and prompt tokenization. Lore count scheduling is in `server/src/tests/lore.test.ts`.
- UI credential and discovery refresh: `src/lib/UI/NanoGPTDashboard.test.ts`; credential-traffic coverage and its exclusions are recorded in `util/playwright/checkCredentialTraffic.mjs`.
- Additional focused checks: `server/src/tests/llmCharsetRetries.test.ts` covers the request retry/yield budget and Echo group-send regression. Proxy routing in the tab is not tested; credential capture omits non-OpenAI provider sends, several discovery/account calls, previews, and Whisper through its component.

## Known Hazards

- An overload error event inside an Anthropic stream becomes redacted `Error:<message>` answer text, like other streamed provider errors. There is no in-stream retry; `outer.ts` `requestChatDataOuter` owns the retry policy and honors `antiServerOverloads`.

- The `/proxy2` media, memory, and count rows and the Google/Anthropic/OpenAI discovery lists keep flat default keys; they do not accept a profile. `openrouter.ts` `getFreeOpenRouterModels` also keeps the default key.
- NanoGPT's `providers.nanogptSubscriptionState` and `nanogptUseSubscriptionEndpoint` remain global: two profiles on different accounts share subscription state and endpoint selection.
- A profile whose `modelId` names a catalogue id that is later renamed or removed keeps it: unless the id matches a dynamic template, the profile resolves as an as-is OpenAI-compatible model until the user picks another model.
- Auxiliary requests still tokenize with the main model (`shared/llm/request.ts`), not their own profile's tokenizer.

- The server counter's `selectTokenizer` maps a `llama3` custom or plugin tokenizer override to `llama`; the playground route uses the `llama3` family.
- A legacy plugin `custom` tokenizer counts with `cl100k_base` on screen and in server requests; its `tokenizerFunc` is never called.
- `CustomModelsSettings` does not expose every format or tokenizer value (Plugin, Ollama, Horde, Echo, NanoGPT variants, and `Local` are missing).
- Multimodal counts remain approximate: Claude/Gemini images use the GPT-4o fallback; video/audio/signature entries use a flat 85 tokens.
- The server's `gemma` tokenizer loads `llama/llama3.json`, so Gemma counts are Llama 3 counts (also for on-screen counts).
- Local tokenizer families encode synchronously on the server thread. Encoders stay loaded per server context until disposal; the web-tokenizer module loader is process-wide and serialized, and disposal does not guarantee that the memory returns to the OS.
- `server/src/llm/redact.ts` matches a credential's stored, JSON-escaped, and `encodeURIComponent` forms. Its exact string matcher does not normalize lowercase percent escapes; designated `key`, `api_key`, and `token` query parameters are still redacted by name.
