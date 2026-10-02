# Slice: Request Layer And LLM Secrets

Status: 7a (transport) implemented (2026-10-01); 7b (write-only) implemented (2026-10-02).

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

## Implementation record (7a, transport)

Implemented 2026-10-01 on `250c0f96`, by the slice 7a amendments of
[`implementation-plan.md`](implementation-plan.md) and Astra's plan review (18 points: 15
adopted, 3 adopted with changes, none rejected).

- **The catalogue** (`shared/llm/`): the provider arrays and `types.ts` moved from
  `src/ts/model/` (`model/types.ts` re-exports them); `models.ts` holds the static list
  (`BASE_LLM_MODELS`) and `resolveModelInfo`, the client's `getModelInfo` resolution with its
  reads passed in. The client keeps its own copy of the list for `registerModelDynamic`
  (`isDynamicModel`). `validate.ts` `isModelDescriptor` (moved from the job channel).
  `shared/localNetwork.ts` (moved from `src/ts/network/`); `presetFieldValue` (moved from the
  forwarding layer to `shared/presets.ts`).
- **The server request layer** (`server/src/llm/`, `llm-requests.md`): the port of
  `requestChatDataMain` and every per-format function except the plugin provider and WebLLM, the
  four adapters, `shared.ts`, `additionalParams.ts`, `nai.ts`, `stringlize.ts`, `jsonSchema.ts`,
  `chatTemplate.ts`; every client dependency is a member of `RequestContext` (`arg.ctx`).
  `settings.ts` `loadRequestDb`, `transport.ts`, `redact.ts`, `vertexToken.ts`,
  `claudeObserver.ts`, `auxOps.ts`, `requests.ts` (the live requests and the callback leg).
  Strict mode: 124 errors after the mechanical port (the copies were not counted before the
  rewrite), all fixed with type-only edits (`!`, casts, annotations, and `async` where a CBS
  parse now waits on the tab).
- **The routes** (`self-host-server.md`): `POST /api/llm/request` (SSE),
  `POST /api/llm/request/:id/answer`, and the `risu-aux-op` branch of `/proxy2`; the server
  context creates the tokenizers and the token counter, the Vertex cache, the Claude observer,
  and the request registry, pauses it during maintenance, and ends it at shutdown.
  `generationJobs.parentCallback` and the hub's `watchCallback` link an aux request to the job
  callback it runs inside.
- **The client** (`src/ts/process/request/`): `requestChatData` is unchanged; `requestChatDataMain`
  sends every format but `Plugin` and `WebLLM` to `transport.ts` `requestServer`; the per-format
  functions the server now runs are removed from `request.ts` (the provider modules stay, unused
  by the send path, until cutover). `parser.svelte.ts` `risuChatParserScoped` (a frozen preset and
  persona), used by the plugin `parseRisuChat` inside a hook and by the `cbs` callback;
  `stableDiff.ts` takes the send's `chatRef` and `pluginContext`; `globalApi.svelte.ts`
  `appendFetchLog`; `network/channelCallSource.ts`. `globalApi.svelte.ts`, `parser.svelte.ts`,
  `v3.svelte.ts`, `index.svelte.ts`, `forwarding.svelte.ts`, `jobChannel.ts`, and
  `channel.ts`/`generationJobs.ts` are outside the slice's listed files (recorded).

Deviations from the reviewed plan (`p5s7a-decisions.md`):

- The server has no outer `requestChatData` loop yet: nothing on the server calls it before
  slice 9, which ports it with its hooks.
- The client sends what the browser path reads from the tab and the server cannot know: the tab's
  whole `encode` scope (`tokenizer`: the main model's id, family, and internal id, the plugin
  provider and its declared tokenizer, the custom tokenizer, the Google and caching switches; the
  client tokenizes bias strings with its main model whatever the request's preset), whether the
  main model takes images (`mainModel.imageInput`), and the selected persona beside the effective
  one (`db.username` is the selected persona's, `getUserName()` the bound one's).
- The Vertex token's stored fields are neither read nor written (the plan kept them as a seed).
- A model's answer (success results, chunks) is not redacted: value and query redaction would
  rewrite URLs in the user's text; failures, previews, logs, notices, errors, and callback payloads
  are.
- A repeated answer after the request ended is a 404 (the request is gone), not `ignored`; the
  client stops on either.

Recorded behavior and limits:

- configured provider URLs are fetched from the server (Docker: `localhost` is the container);
  kept at Stop B: a host provider is configured as `host.docker.internal` or the host's address
  (README Docker note);
- an aux call whose `chatRef` names another chat than the selected one names the selected
  character, as before (the `selectedCharacterId` the tab sends); `requestOllama` names the
  replying character;
- server error strings are English whatever the tab's language (kept at Stop B, not in this plan);
- the Claude cache warmer is one per server, not per tab, and its requests are in no request log;
- `strongBan` is cached on the server by the text alone and returns the stored bias on a hit, as
  the client did (suspected defect: a hit drops the current bias; Stop B: not in this plan);
- OobaLegacy's stream enqueues strings, not chunk maps, as before (suspected defect: the send
  path reads it as a map; Stop B: not in this plan);
- `bodyIntercepter` is skipped for a request outside a job callback; inside one it runs through
  the job's channel as a child callback (skipped only when the job's hook list has none; a nesting
  or queue refusal fails the request); a body that carries a stored credential is not handed to a
  plugin interceptor and fails the request;
- content the tab must get unaltered (a callback payload, a remembered tool call, a body for a
  plugin interceptor) is never redacted: one that carries a stored credential, in a value or a
  property name, fails the request; logs, notices, errors, fail results, and previews are
  redacted field by field (the event's type, ids, names, and chat refs are protocol and never
  rewritten);
- the client's request-log entries come from the server (`appendFetchLog`), redacted; the
  transport's own buffered-fetch log is capped at 20 entries, the server-built ones are not;
- a tool already running in the tab when its request ends cannot be stopped;
- the abort reaches the OobaLegacy handshake, the Ollama SDK, Horde's polling, and the Vertex
  refresh, which the browser path did not stop; the remote Google token count takes no signal;
- the `slice(len, 0)` `decodeToolCall` defect is untouched (slices 11 and 12);
- a `cbs` parse without its own chat runs on the chat selected when the request started (the
  client parsed on the chat selected at parse time), with the request's preset and persona; a
  scoped preset or persona that no longer exists fails the parse (`PluginTargetGoneError`);
- a failed `cbs` callback, any callback timeout or malformed answer, and a child interceptor's
  barrier failure, timeout, or disconnect end the request with an error whatever the adapter does
  with the failure (the adapters fall back in many places); the last three also end the job (as
  `failed`); a child interceptor whose hook threw is logged and the body sent, as the browser
  path does; a tool the tab answered `failed` returns to the model;
- a network failure names the URL the server could not reach;
- the ported adapters' debug `console.log` calls are removed (they printed prompts and bodies into
  the server log); the transport's error log is redacted.

Tests the change invalidates on purpose (for the Fable test-adapter):
`src/ts/plugins/apiV3/pluginContext.test.ts` "parseRisuChat parses with the hook's character and
chat, and with processRegex its script handlers run with the hook's context": inside a hook
`parseRisuChat` now calls `risuChatParserScoped(text, arg, { presetId, personaId })` instead of
`risuChatParser(text, arg)` (assertion change: the hook path's parse goes to the scoped parser with
the hook's preset and persona; harness change: the parser mock needs `risuChatParserScoped`).

Evidence: `pnpm check` 0 errors, `pnpm format:check` clean, `pnpm test` 1,450 passed (the one test
above fails as intended), `pnpm build` ok, `pnpm test:e2e` 5 passed; a scratch smoke against a
listening server (31 checks, all passing) and the browser check
`util/playwright/checkLlmTransport.mjs` (12 checks, all passing; see the two lists below).

The smoke (`p5s7a-smoke.ts`, a mock provider on another origin, the fixed provider origins routed
to it): a buffered request (the stored proxy key and the preset's model upstream, a redacted log
with the authorization header masked, no credential in any event); a stream rebuilt from `set`
and `append` deltas ending in `end`; a preview with the credential redacted; a failure whose
upstream echoed the key, redacted; a tool round trip (`mcpTool` callback with the call's name and
arguments, the answer accepted, the second upstream request carrying the tool result, the final
answer); the CBS callbacks of an interface schema and an extract path in order, the extracted
answer, and a failed `cbs` answer ending the request; a client abort mid-stream closing the
upstream with no live request left; 412, 400, a missing preset as a fail result, a 404 answer, a
409 `channelCall`, no JWT refused; Google with the key in the query and none in any event; the
`openai-tts` auxiliary operation with the stored key replacing the client's, another origin
refused, the password form refused; shutdown ending a live stream.

The browser check (`util/playwright/checkLlmTransport.mjs`, the browser assembly path, a mock
provider on another origin): a send, a no-chat translate-mode call, a submodel call, an edit
followed at once by a call (the provider got the edited model), and a streaming send all answer
through `/api/llm/request`; the browser made no request to the provider and none outside the
settings writes carried the stored key; every browser request was same-origin; no page errors.

## Astra challenge (2026-10-01) and decisions

Round 1 (`/tmp/astra-p5s7a/challenge-1.md`): 12 blocking, 3 not; every point adopted.

1. C1, a failed extraction parse became a successful raw answer: a fatal failure now aborts the
   request with its reason, so the terminal is an error whatever an adapter's catch returns.
2. C2, a child interceptor's failure was ignored: the outcomes are handled one by one (answered,
   refused, a hook's throw logged as on the client; barrier, timeout, and disconnect fatal and
   ending the job).
3. C3, provider errors the adapters put into the answer text were not redacted:
   `ctx.redactText` at those sites (Responses, Anthropic stream and batch errors).
4. C4, the job-channel interceptor payload and tool records were not redacted: the payload is
   masked with placeholders the server restores in the returned body; tool records are redacted
   (the server keeps the original for decoding).
5. C5, short credentials, aux response headers, and server console output: every non-empty value
   is redacted; aux response header values are redacted; the debug prints are removed and the
   transport's errors redacted.
6. C6, the `cbs` parse ignored the captured chat and persona: the captured chat is the default
   target; the scoped parser reads the frozen persona and refuses a gone preset or persona.
7. C7, the client's abort missed the preparation and queued callbacks: the abort is watched from
   before the flush; a stopped request handles no more events and starts no callback.
8. C8, local Ollama ignored the abort and the registry waited for abandoned work: local Ollama's
   fetch carries the request signal; a request is finalized when it is aborted (stream closed,
   entry removed, callbacks rejected, later events fenced), its work draining in the background.
9. C9, OobaLegacy's socket could hang or throw outside the request: one guarded terminal for the
   socket and the stream.
10. C10, Vertex: one refresh per credential with its own controller, aborted when its last waiter
    leaves and at maintenance or dispose; a pre-aborted request does not start one; no unhandled
    rejection.
11. C11, the Claude warmer could retry after dispose and kept old credentials across
    maintenance: attempts are owned by a registration period; `reset` (maintenance) forgets the
    request; `dispose` (shutdown) stops it for good.
12. C12, the tokenizer scope mixed the tab's model with the preset's id: the tab's whole scope is
    sent.
13. N1, a duplicate in-flight callback ran twice: one answer promise per callback id.
14. N2, tool descriptors were aliased until the POST, and the base catalogue was mutable: cloned at
    capture; the base list is frozen and the client works on a deep copy.
15. N3, network failures did not name the URL: they do.

Found while rerunning the browser check after the fixes: a fresh store leaves some tokenizer
fields unset, which the route refused; the client sends the falsy value `encode` treats them as.

Round 2 (`/tmp/astra-p5s7a/challenge-2.md`): the round-1 cases resolved; 7 blocking follow-ups
and 1 not, every one adopted.

1. R1, a request whose client was gone before admission was registered after it was finalized:
   such a request is refused, and a request is registered before anything can finalize it.
2. R2, whole-event redaction rewrote event types and ids for a short credential: the projection
   is field by field (content redacted, protocol kept).
3. R3 and R4, the interceptor mask could miss encoded forms, corrupt its placeholders, and restore
   unissued credentials: removed; a body carrying a stored credential is not sent to a plugin
   interceptor (the request fails).
4. R5, every refusal skipped the interceptor: the channel's refusals carry a reason
   (`unregistered`, `nesting`, `queue`); only `unregistered` skips it.
5. R6, drained work could register the old request with the Claude warmer after maintenance:
   only a live request registers.
6. R7, adapter error logs were not redacted: they are (Gemini metadata, Claude batch, the job's
   end); the schema print is removed.
7. N4, the client reader did not check an abort at entry or after the POST: it does, and marks
   itself stopped at the end of the stream.

Found while rechecking R2: with a short credential, redacting a `cbs` payload would change the text
the tab parses; a callback whose payload carries a stored credential now fails the request.

Round 3 (`/tmp/astra-p5s7a/challenge-3.md`): the round-2 fixes resolved; 3 blocking redaction
gaps, adopted with one rule (`redactor.carries`, a stored credential in a string or a property
name at any depth): F1, a tool record's content discriminators were redacted, and F3, an upstream
tool-call id could carry a credential: tool records are no longer redacted, and one that carries a
credential fails the request; F2, a credential used as a property name passed the payload checks:
callback payloads and interceptor bodies are checked with `carries`.

Round 4 (`/tmp/astra-p5s7a/challenge-4.md`): F1–F3 resolved; no blocking finding remains.

## Checks (7a)

`pnpm check`, `pnpm format:check`, `pnpm test` (125 files, 1,535 passed, 3 skipped), `pnpm build`,
and `pnpm test:e2e` (5 passed) pass on the final tree; the scratch smoke passes 31/31 and
`util/playwright/checkLlmTransport.mjs` 12/12.

## Tests (7a)

The Fable test-adapter adapted `src/ts/plugins/apiV3/pluginContext.test.ts` (the hook path's
parses go to `risuChatParserScoped` with the hook's preset and persona; the parser mock gains it).
The Fable reviewer (verdict: no problem) wrote 80 tests:

- `server/src/tests/llmRequests.test.ts`: the registry over a recording upstream with the real
  adapters: the SSE grammar and one terminal; the `mcpTool`/`cbs` leg (ownership, duplicates, late
  answers, deadlines, a failed or malformed `cbs` ending the request); pre-aborted admission; abort
  and reader cancel finalizing with the upstream aborted; the per-client cap, maintenance, and
  shutdown; the warmer fence; local Ollama's abort; OobaLegacy over a real WebSocket; the child
  interceptor taxonomy; credential refusal (payloads, records, upstream ids, interceptor bodies,
  values and keys); the protocol intact with a short credential.
- `server/src/tests/llmServices.test.ts`: the redactor and `carries`, `collectSecrets`, header
  masking; the Vertex cache's shared refresh, waiters, pre-abort, failure, and `clear`; the warmer's
  timing, retries, dispose, and reset.
- `server/src/tests/llmRoutes.test.ts`: auth, 412, the body validation, 409, the answer route, a
  real-socket disconnect, shutdown and maintenance; all six auxiliary operations (injection, the
  client's credentials stripped, bytes and multipart preserved, JWT only, the refusals, redirects,
  redacted errors and headers) and plain `/proxy2` unchanged.
- `server/src/tests/llmLegacyFormats.test.ts`: recorded bodies for NovelAI, Kobold, Cohere,
  NovelList, Horde (polling under fake timers), and Echo.
- `src/ts/process/request/tests/transport.test.ts`: the client transport (the context taken before
  the flush, the body, aborts, HTTP refusals and 412, framing across multibyte splits, the chunk
  grammar, terminals, inlay and record ordering and failure, the `cbs` scope, one tool invocation
  per id, no start after cancel).
- `src/ts/process/request/tests/serverParity.test.ts`: the parity gate (below).
- `src/ts/parser/tests/scopedParser.test.ts`: the scoped parser's frozen preset and persona, live
  edits, and gone targets.

The parity gate (differential: the client adapters as at `250c0f96` against the server port, one
`RequestDb`, independent argument clones, frozen time and ids, a recording upstream per side;
method, URL, headers, body, results, chunks, tool calls, records, inlays, CBS inputs and order,
alerts, warmer registrations, and log URLs compared): equal in every case: OpenAI-compatible
buffered (proxy key, bias strings, `strongBan`, additional parameters), streaming, a JSON schema
with an extract path, a tool round trip with a decoded earlier record, a failure, a preview;
`xcustom:::`, Mistral, legacy instruct; `seperateModels`; Responses buffered with a tool call and
streaming; Anthropic buffered (caching, prefill, warmer) and streaming with an error kept as answer
text; Bedrock (identical SigV4 headers); Google buffered (query key, image and audio inlays),
streaming, preview, a tool round trip; Vertex; a no-character translate call. The two recorded
deviations it met (the Vertex token source, CBS parses as callbacks) were equal in effect. The
formats whose client code lived in `request.ts` are covered by the diff review and the
recorded-body test; the plugin branch by the adapted test; edit-then-send, the no-chat call,
retries, and fallbacks by the browser check; the memory operations by the route test. WebLLM's
local branch has no test (it needs Transformers.js).

Fable dropped, with reasons: the Docker local-provider smoke (Stop B, decision 16); `strongBan`
hits with different biases (a suspected defect for Stop B); fields beyond the preset and persona
under a switched selection (the scoped parser leaves them live by design); a production-image
import of the server graph (the Stop B Docker smoke). Observed, not defects: a Bedrock key's
region part is a redaction target (decision 14), so a payload containing it is refused; a streaming
request with `extractJson` makes one `cbs` round trip per chunk (decision 5). Pre-existing:
`verifyJwt` answers 500, not 400, to a non-JWT `risu-auth`.

## Implementation record (7b, write-only)

Implemented 2026-10-02 on `911dfa00`, by the slice 7b amendments of
[`implementation-plan.md`](implementation-plan.md) and Astra's plan review (15 points, all
adopted).

- **The record** (`shared/llmSecrets.ts`): the credential paths (twelve flat fields, the nested
  `google.accessToken`, `hordeConfig.apiKey`, `novelai.token`, the `OaiCompAPIKeys` map, and the
  entry maps `presets.<id>.proxyKey` and `customModels.<id>.key`), one path codec, the read and
  write helpers, `maskLlmSecrets` (`{ set, hint }` leaves, the maps keep their nesting),
  `carriesSecretPath`/`withStoredSecrets` (the write rule), and `llmSecretSiblings` (the readable
  fields). A custom model's key moves from `customModels[].key` to `llmSecrets.customModels`.
- **The server** (`self-host-server.md`): `ResourceKind` loses `clientReadable` and gains `project`
  and `prepareWrite`; every read route and the PUT response project; a resource PUT or batch write
  of `llmSecrets` may carry no credential (400) and keeps the stored ones; `/api/llm-secrets/*`
  (PUT, DELETE, the preset copy) writes them, atomically with the revision check; the exported
  archive's staged copy loses the row and is `VACUUM`ed; twelve new auxiliary rows (GET rows send no
  body, a query allowlist, `x-api-key` injection), a successful JSON answer carrying a key refused
  (502), response headers redacted; `loadRequestDb` merges the custom-model keys.
- **The client** (`persistence.md`, `global-api.md`, `settings-i18n.md`): `llmSecrets.svelte.ts`
  (the masked record, per-path versions, the write queue), the queue sent after each cycle's batch
  (`resourceSync.svelte.ts`, `resourceClient.ts` `sendSecretRequest`), the sibling-only text
  everywhere the record is seeded, compared, or written, `mirrorFields` in the boot assembly and
  the conflict reload, `SecretInput.svelte` for all 24 credential inputs (`BotSettings`,
  `OtherBotSettings`, `PlaygroundEmbedding`, `CustomModelsSettings`), the onboarding key, the
  `proxyKey` accessor and the preset copy and import through the queue, and `auxFetch` for every
  browser call that used a stored key. The settings report drops every `llmSecrets` field.

Deviations from the reviewed plan (`p5s7b-decisions.md`):

- A refused credential write (decision 14, "failed shown apart") is shown by the alert and by the
  status falling back to the acknowledged one; `SecretInput` has no lasting failed marker.
- `geminiTokenizer` (no caller) and the dead client key reads in `request.ts`, `hypav2.ts`, and
  `supaMemory.ts` are removed; the Vertex token's clear button is gone (the server holds the
  token in memory, 7a).

Recorded behaviors (no migration owed, alpha):

- OpenAI TTS with a custom URL and a stored key but no TTS key of its own alerts
  `ttsCustomUrlNeedsKey`: the stored key goes only to the official origin.
- Custom-model keys stored before this slice are dropped by the normalizer, not moved.
- Importing an archive (which has no `llmSecrets` row) leaves every key empty.
- A page unload does not send queued credential writes (the warning shows them as unsaved).
- The mirror holds `""` for every credential field, where a fresh store had some absent before.

## Astra challenge (7b, 2026-10-02) and decisions

Three rounds (`/tmp/astra-p5s7b/challenge-{1,2,3}.md`); every point was adopted.

- Round 1 (7 blocking, 4 non-blocking): a successful or error JSON answer is checked through its
  decoded keys and values (a Unicode-escaped echo of the key is refused); the redactor knows the
  credential as stored and as injected (trimmed); an acknowledged write bumps its path's version
  and a changed reread bumps every path (two keys can share a masked status); the secret
  acknowledgement judges the siblings by text, not by the dirty mark (unchanged → the server's;
  local-only → kept; both → the normal conflict, discarded and noticed); the queued secret
  operations are captured with the batch, so one queued meanwhile waits for the next cycle;
  `auxFetch` settles on abort at once and starts nothing after it; the barrier refuses while
  saving is halted; id segments carry a `~` prefix (`.` and `..` survive URL parsing); the queued
  status is computed in queue order; clearing the NanoGPT key invalidates an answer still on its
  way; a JSON body that fails mid-read is a 502.
- Round 2 (3 blocking): a deleted preset's or model's key is a `cleanup`, sent only once the
  owner's deletion is saved and dropped if a conflict restored the owner (an explicit clear stays a
  plain write); `authFetch` takes `beforeDispatch`, which `auxFetch` uses to check abort and save
  admission after authentication and signing; the abort race observes the raced promise first.
- Round 3: R1–R3 resolved; a cleanup waiting for a quarantined deletion no longer keeps the loop
  scheduled, and the barrier reports the quarantine at once.

Recorded limits: the cleanup check is on the client (no server-side condition); a future flow that
restores an existing id on another client would need one. A cleanup for a preset whose creation
was never saved leaves an orphan entry (masked, never read).

## Checks (7b)

The scratch smoke on a listening server passes 57/57 (masked reads on all four read routes and
the PUT response, the write rule on PUT and batch, the singleton delete refused, every secret
route with its revision, epoch, length, and path checks, the preset copy, the export scanned
byte-wise for every sentinel with the resource table present, the new auxiliary rows with their
injection, method, empty GET body, query allowlist, missing key, the carrying 502, Unicode-escaped
echoes in success and error bodies, a padded key echoed trimmed, and a body failing mid-read);
`util/playwright/checkLlmTransport.mjs` passes 17/17 (a key typed into the settings input reaches
the provider on the send right after; only the `PUT /api/llm-secrets` request carries it; no
response does; the mirror reads `""`; browser storage holds no copy; the status after a reload).

## Tests (7b)

The Fable test-adapter adapted the 13 invalidated files and the three harnesses (its report is in
the review record). The Fable reviewer (verdict: **problem**, below) wrote 50 tests, adapting none
further:

- `server/src/tests/llmSecrets.test.ts`: the masked projection on every read route and the PUT
  response with the stored record plaintext for the server; the write rule (a carrying write in any
  shape refused without an echo, an omitting write keeping every credential, a batch prepared before
  anything is applied and rolled back by one carrying op, the singleton delete refused); the secret
  routes (set, replace, clear, delete, the preset copy; 409 with the revision, 412, 503, the JWT; bad
  paths, bodies, and the length refused without an echo; the hint rule; every id through a real URL:
  `.`, `..`, slashes, percent signs, Unicode, spaces, a tilde, `__proto__`); the exported archive
  without the row or any byte of a current or replaced credential while a snapshot keeps the record;
  an import of such an archive leaving every key empty under the new epoch.
- `server/src/tests/auxOps.test.ts`: the twelve new rows (method, endpoint, injection, an empty GET
  body; another method, origin, path, query parameter, a redirect, a missing key refused) and the
  response policy (a carrying successful JSON answer refused as text, Unicode-escaped, or as a
  property name, the trimmed injected form included; a carrying JSON error refused as a whole with
  its headers redacted; a body failing mid-read or not JSON a 502; a non-JSON body passed through).
- `src/ts/storage/tests/resourceSyncSecrets.test.ts`: the queue in the save adapter (sent after the
  batch on the record's revision and never in the record; the unload warning; versions bumped on
  every acknowledged replacement; the barrier; the copy after its preset's batch and a key queued
  during an in-flight batch waiting for the next; a stale revision reread and retried a bounded
  number of times; 400 and 404 as reported discards with an alert carrying no value; 5xx and
  network failures kept; 412 halting with the barrier refusing while halted; the acknowledgement
  adopted by text in its three cases and a lost sibling acknowledgement recognized; the cleanup
  sent once the deletion is saved, dropped when a conflict restored the owner, waiting behind a
  quarantined deletion without a scheduled cycle, for presets and custom models).
- `src/ts/network/auxFetch.test.ts`: the barrier, the method and headers without a credential, the
  bodies (JSON, bytes, `FormData` serialized once with its boundary), the interceptors, the failures
  (a refused key, a halt), the abort at each stage settling at once with nothing started after it,
  no unobserved rejection, the dispatch check after authentication, `auxFetchJson`.
  `src/ts/storage/tests/nodeStorage.test.ts` gains `authFetch`'s `beforeDispatch` (after the
  authentication and the signing, before the request; a throw stops it).
- `src/ts/process/ttsOpenAI.test.ts`: the four OpenAI TTS routes (the stored key through the server
  for the official endpoint only; a character's own key to any URL; the custom-URL refusal; keyless).
- `src/lib/UI/GUI/SecretInput.test.ts` and `src/lib/UI/NanoGPTDashboard.test.ts` (with the
  `src/lib/UI/tests/reactiveProps.svelte.ts` helper): the credential input's draft rules, and the
  dashboard's stale answers.

Problem found (round 1 N3, recorded as resolved in round 2 "by inspection"): in
`NanoGPTDashboard.svelte`, `dashboardPromise` is a `$derived` that is read only inside
`{#if keySet}`. When the key is cleared, that block is torn down and nothing reads the derived, so
its no-key branch (`cleared()`, which bumps `latest`) never runs; an answer still on its way then
passes the `request !== latest` check and writes `nanogptSubscriptionState`, undoing the reset
`BotSettings` made. `NanoGPTDashboard.test.ts` fails on exactly that step (the replace and unmount
paths hold). Observed, not a defect: adopting an acknowledged `llmSecrets` record writes the
mirror, whose watcher re-marks the record until the next cycle, so the unload warning shows for up
to one debounce after each acknowledged key write (the same transient mark every reload produces).

Fixed on the owner's instruction (2026-10-02): the invalidation moved out of the derived into a
`$effect` that bumps `latest` whenever `keySet` is false, which runs on every clear whether or not
the block reads the derived. `NanoGPTDashboard.test.ts` passes; on the final tree `pnpm check`,
`pnpm format:check`, `pnpm test` (132 files, 1,587 passed, 3 skipped), `pnpm build`, and
`pnpm test:e2e` (5 passed) pass, the smoke 57/57 and the browser check 17/17.
