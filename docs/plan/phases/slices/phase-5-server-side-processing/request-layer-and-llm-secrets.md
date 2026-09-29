# Slice: Request Layer And LLM Secrets

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 2 (the request layer on the
server, `llmSecrets` write-only, LLM calls off the proxy); PLAN.md Decision 6 (credentials).

Depends on: `job-channel` (the `requestLog` notice and the replacer callbacks). Contingent on
Phase 3: its drafts make `llmSecrets` a singleton kind holding the LLM credential fields under
their `Database` names (`openAIKey`, `claudeAPIKey`, `openrouterKey`, `nanogptKey`, `mistralKey`,
`cohereAPIKey`, `ollamaApiKey`, `novellistAPI`, `mancerHeader`, `google`, `hordeConfig`,
`novelai`, `vertexPrivateKey`, `vertexClientEmail`, `vertexAccessToken`,
`vertexAccessTokenExpires`, `OaiCompAPIKeys`; the containers move whole) plus
`presets: Record<presetId, { proxyKey }>`, marked `clientReadable` until this phase, with preset
copy, delete, and import carrying the entry client-side in one batch; `customModels[].key` stays
in `customModels`; `authRefreshes` stays a client-readable collection
(`docs/plan/phases/slices/phase-3-settings-sections/{preset-persona-schema,credentials-and-closeout}.md`).

## Scope

Allowed files: `server/src/llm/**` (new: the port of `src/ts/process/request/{request,shared,additionalParams,anthropic,google}.ts`,
`request/openAI/{requests,responses,types,shared}.ts`, `src/ts/process/models/nai.ts`,
`src/ts/process/stringlize.ts`), `shared/llm/**` (the catalogue from
`src/ts/model/{modellist,types}.ts` and `providers/*.ts`, minus the dynamic registry and the plugin
store), `server/src/routes/llm.ts` (new: `POST /api/llm/request`, the discovery and count
endpoints), `server/src/routes/llmSecrets.ts` (new), `server/src/data/kinds.ts` and
`server/src/routes/resources.ts` (the read projection of the `llmSecrets` kind and the write
guard), `shared/resources.ts`, `server/src/app.ts` (registration), `src/ts/process/request/request.ts`
(`requestChatData` and `requestChatDataMain` keep their signatures and become the transport),
`src/ts/model/{modellist,openrouter,nanogpt,ollama}.ts` and `src/ts/tokenizer.ts`
(`tokenizeGoogleCloud`) (their authenticated calls go through the server endpoints),
`src/ts/storage/database.svelte.ts` (`copyPreset`, `importPreset`, the delete handler: the
`proxyKey` entry moves through a server operation), `src/lib/Setting/**` (masked status and
"replace" inputs for the credential fields; the sibling non-secret fields keep binding),
`src/lang/en.ts`. The client provider modules are deleted in `cutover-and-docs`. Tests belong to
the review step.

Identifiers (verified 2026-09-30): `requestChatData(arg: requestDataArgument, model: ModelModeExtended, abortSignal)`
(`request.ts:217-221`; replacers 254-257 and 306-309, `runTrigger(currentChar, "request", ...)`
267-278), `requestChatDataMain` (456-460; the `LLMFormat` switch 508-552; `requestPlugin` 892-936;
`requestWebLLM` 1514-1547 calls `runTransformers` from `transformers.ts`, not `@mlc-ai/web-llm`),
`requestDataArgument` (31-58: `formated`, `bias`, `biasString`, `currentChar`, `temperature`,
`maxTokens`, `PresensePenalty`, `frequencyPenalty`, `useStreaming`, `forceStreaming`, `isGroupChat`,
`useEmotion`, `continue`, `chatId`, `chatRef`, `noMultiGen`, `schema`, `extractJson`,
`imageResponse`, `previewBody`, `staticModel`, `escape`, `tools`, `rememberToolUsage`,
`blockPlugins`), `requestDataResponse` (72-98). Plugin `runLLMModel` (`v3.svelte.ts:1646-1668`)
calls `requestChatDataMain` directly with `blockPlugins: !options.allowPlugins`, bypassing the
replacers and the request trigger. Transport today: streaming calls use `fetchNative` without a
network route (direct, not `/proxy2`); buffered `globalFetch` calls default to `/proxy2`; Horde and
the Google OAuth refresh use raw `fetch`; the Google API key travels in the query string
(`google.ts:552-557`, `568-572`), Vertex as a bearer header. Credential reads outside the request
layer (the consumer inventory): `tts.ts:200` (OpenAI TTS fallback on `openAIKey`),
`stableDiff.ts:419` (DALL-E, `openAIKey`) and 695 (Imagen, `google.accessToken` in the query),
`PlaygroundSubtitle.svelte:288` (Whisper, `openAIKey`, raw `fetch`), `modellist.ts:641-643`
(`google.accessToken`), 699-704 (`claudeAPIKey`), 745-749 (`openAIKey`) in `registerModelDynamic`,
`openrouter.ts:37, 58` and `nanogpt.ts:165` (`openrouterKey`, `nanogptKey`),
`BotSettings.svelte:354, 432, 462, 480` (Ollama cloud tags with `ollamaApiKey`, NanoGPT balance,
subscription, and providers with `nanogptKey`), `tokenizer.ts:349` (`google.accessToken` for
`countTextTokens`), `SettingsExportButtons.svelte:37-89` (the settings report removes them), and
the settings pages that bind the fields for editing. Client callers of `requestChatData` outside
`sendChat`: `translator.ts:553`, `Suggestion.svelte:114`, `IrisModal.svelte:238`, `stableDiff.ts:32`,
`PlaygroundSubtitle.svelte:74, 295`, `PlaygroundImageTrans.svelte:177`, `mcp/aiaccess.ts:65`,
memory (`supaMemory.ts:268`, `hypav2.ts:101`, `hypav3.ts:1484`), Lua (`scriptings.ts:676, 727, 1076`),
triggers (`triggers.ts:760`), the emotion and `igp` steps in `index.svelte.ts`. Request logs:
`fetchLog` (`globalApi.svelte.ts:44-56`), read by `AlertComp.svelte` and `DevTool.svelte`.

Strict-mode cost: about 190 errors across the request files (review count: `google.ts` 51,
`openAI/requests.ts` 46, `request.ts` 40, `anthropic.ts` 29, `responses.ts` 21), to fix as part of
the move.

Stopping condition: a provider whose Node transport differs from the browser's in a way the port
cannot hide; recorded, and that provider stays on the client transport with its key readable
until the owner decides (the flip waits for it).

## Assumptions

- Phase 3 shipped `llmSecrets` as its drafts describe; if a field named above is elsewhere, the
  inventory in this slice is the list to reconcile at phase start.
- `@smithy/signature-v4`, `ollama`, `ipaddr.js` import under plain Node (checked 2026-09-30).
- Decision 6 keeps TTS, image generation, DeepL, and the Google search MCP client on the client
  with the proxy; their own keys stay in `secrets`.

## Proposed decisions

- Unconditional server transport (proposed): `POST /api/llm/request` (JSON body = the full
  `requestDataArgument` minus `currentChar` and `tools` objects, which become `characterId` and
  tool names, plus `mode: ModelModeExtended`, `entry: "requestChatData" | "requestChatDataMain"`,
  and `jobId?`) runs the server request layer and answers buffered or as an SSE stream of
  cumulative chunks; it is not a job, takes no chat lock, has no persistence, and is exempt from
  one-job-per-chat. From this slice the client's `requestChatData` and `requestChatDataMain` are
  thin transports to it for both pipelines: the browser assembly path keeps its replacers and the
  request trigger client-side around the call (`entry: "requestChatDataMain"`), while a server job
  runs them itself; `bodyIntercepter` registrations are answered through a channel callback when a
  `jobId` is present and are skipped otherwise (recorded). The browser assembly path therefore
  stays the rollback seam while no client code holds a key. Alternative: keep `llmSecrets`
  readable until cutover (rejected: the credential criterion becomes a big bang and `aux` callers
  are never exercised against write-only secrets before then).
- `llmSecrets` write-only, after the transport (proposed, same slice, second step): the resource
  read routes return the kind's masked projection (`{ [path]: { set, hint } }` for the credential
  paths `openAIKey`, `claudeAPIKey`, ..., `google.accessToken`, `hordeConfig.apiKey`,
  `novelai.token`, `OaiCompAPIKeys.*`, `vertexPrivateKey`, `vertexAccessToken`,
  `presets.*.proxyKey`) and the sibling non-secret fields (`google.projectId`, `hordeConfig.model`,
  `hordeConfig.softPrompt`, `novelai.model`, `vertexRegion`, `vertexClientEmail`) readable and
  writable as today; a PUT or batch write of the kind that carries a masked projection is refused
  (400) so a stale mirror cannot overwrite a value, and a write of the `llmSecrets` kind that
  omits a masked path keeps the stored value for that path (the form Phase 6's
  `updateLlmSecretSiblings(patch)` uses to change the readable sibling fields); the credential paths are written only through
  `PUT /api/llm-secrets/<path>` (set or replace) and `DELETE /api/llm-secrets/<path>`, both with
  `x-resource-epoch` and the kind's `baseRevision` like any write (invariant 4). Preset copy,
  delete, and import carry `presets.<id>.proxyKey` through `POST /api/llm-secrets/presets/copy`
  and the DELETE route, called by `copyPreset`, `importPreset`, and the delete handler in the
  same client step (Phase 3's client-side copy cannot read the value any more). `customModels[].key`
  moves to `llmSecrets` under `customModels.<id>.key` (the `customModels` record keeps the other
  fields); `authRefreshes` stays where Phase 3 put it (MCP OAuth, read server-side by
  `mcp-on-server`).
- Secret-free projection (proposed): one `redactRequest({ url, headers, body, meta })` in
  `server/src/llm/redact.ts` strips every credential path from URLs (query parameters `key`,
  `api_key`, `token`), headers (`authorization`, `x-api-key`, `x-goog-api-key`, `api-key`, and any
  header a `header::` additional parameter set), bodies, and nested metadata; it is the only shape
  the `requestLog` notice, error messages, the `previewBody` result, and callback payloads carry.
  Validated with distinct sentinel credentials per provider, including the Google query key.
- Consumers (proposed): authenticated model discovery (`registerModelDynamic`, OpenRouter,
  NanoGPT models, providers, balance, subscription, Ollama cloud tags) and the remote Google count
  go through `GET /api/llm/models/:provider`, `GET /api/llm/account/:provider/:query`, and
  `POST /api/llm/count` on the server; their client modules call those. The auxiliary readers of
  `openAIKey` (`tts.ts` OpenAI TTS, `stableDiff.ts` DALL-E, `PlaygroundSubtitle.svelte` Whisper)
  and of `google.accessToken` (Imagen) are an owner question (recorded); the proposed default is
  that `/proxy2` injects the server-side key for an allow-listed host (`api.openai.com`,
  `generativelanguage.googleapis.com`) when the client sends a placeholder header, which keeps
  Decision 6's "auxiliary calls keep the proxy". Alternatives: a separate auxiliary key in
  `secrets` (a second copy of the same key), or small server endpoints per call.
- The model catalogue in `shared/llm/` is data plus `getModelInfo`; the dynamic registry and
  `customV3ProviderMetaStore` stay client-side and are merged into the client's view; the server
  resolves `pluginmodel:::` to a `plugin` marker that `post-generation-and-plugin-callbacks`
  turns into the hybrid step, using the provider descriptor frozen in the hook list.
- Tool calls: the adapters keep their `callTool` seam, injected; wired by `mcp-on-server`.
- Keys typed into `additionalParams` (`header::Authorization`) and custom-model `params` are an
  owner question (recorded); the proposed default is that a `header::` value whose name is an
  authorization header is stored server-side under `llmSecrets.additionalHeaders.<name>` and the
  readable configuration keeps a reference.

## Validation

`pnpm check`, `pnpm test` (`requests.responses.test.ts` and `additionalParams.test.ts` move with
the code under `// @vitest-environment node`), `pnpm build`, `pnpm format:check`; the review step
adds `server/src/tests/llmRequest.test.ts` with a recording upstream (`testSupport.ts`
`startUpstream`): the credential reaches the upstream header or query and never the response, the
log, or the error; `llmSecrets.test.ts` (set, replace, clear, masked status, the sibling fields
round-trip, a masked write refused, the preset copy and delete routes, epoch and revision checks);
`redact.test.ts` with sentinel credentials for OpenAI, Anthropic, Google (query), Vertex, Bedrock,
and a `header::` parameter. Manual: with the browser assembly path (the default until cutover), a
send, a translation, a suggestion, a model-list refresh, and a DALL-E image work, and the browser's
network log shows only same-origin requests and no key (the phase's credential criterion, re-run
at cutover).

## Residual risk

`vertexAccessToken` refresh happens on the server from this slice; the client's `generateToken`
path is removed with its readers. Plugins that read `db.openAIKey` through `getDatabase` see the
masked projection (plugin-managed credentials are outside Decision 6's guarantee; recorded).
