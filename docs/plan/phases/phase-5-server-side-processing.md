# Phase 5: Server-Side Processing

Status: planned on 2026-10-01; not started. The execution plan, the slice amendments, and the
owner's answers are in
[`slices/phase-5-server-side-processing/implementation-plan.md`](slices/phase-5-server-side-processing/implementation-plan.md).

Depends on: Phase 4. Implements Decisions 5 and 6 and the Phase 5 parts of Decisions 3 and 4 in
`PLAN.md`.

## Objective

Run generation on the server as a job that streams events and persists the reply, move every Lua
entry point, trigger, and the script transform to the server, reach browser plugins and UI effects
through a job-to-client channel, and remove LLM provider credentials from the client. The browser
assembly path stays behind a client-local flag until the server job passes the same send
scenarios. Provider calls go through the server from the request-layer step on, for both paths, so
the browser path holds no LLM key either.

## Required Work

Ordered; each step is a slice or several. The slices run 1, 2, 3, 6, the runtime part of 7, 4, 5,
the callback and MCP parts of 7, 9, then 8: prompt assembly needs the Lua and trigger runtimes
first, because its first stages are hooks.

1. **Pure services on the server.**
   - A CBS evaluator built from `src/ts/cbs.ts`. Its host access is mostly injected callbacks, but
     three host reads are direct: `CurrentTriggerIdStore` (`cbs.ts:222`), the viewport
     (`window.innerWidth`/`innerHeight`, 1520 and 1530), and `navigator.language` (2096). All
     three move behind callbacks. `calcString` (`infunctions.ts:173`) still imports the chat
     variable store and takes its accessors as parameters. The parser's group path takes a
     character lookup callback instead of importing `util.ts`.
   - The DOM-dependent rendering in `src/ts/parser/parser.svelte.ts` stays in the client.
   - Lorebook activation (`loadLoreBookV3Prompt`), regex scripts (`processScriptFull` without the
     plugin hooks), Jinja templates (`templates/chatTemplate.ts`), and template validation.
     `templateCheck.ts` and `chatTemplate.ts` take shared types instead of the client `Database`.
     The user-supplied regexes of lore activation run behind the script worker's limits on the
     server.
   - These runtime modules live in `shared/`, with host access only through an injected object
     (the Decision 2 extension).
   - Token counting with the tokenizer engines loaded from disk rather than through
     `tokenizeAccurate`. A spike first loads each tokenizer family under Node:
     - the payloads load from `dist/token/` (the image) or `public/token/`;
     - `o200k_base` loads from the `@dqbd/tiktoken` package (`src/etc/` is not in the image),
       and the encoders load through `createRequire`;
     - `@mlc-ai/web-tokenizers` loads through a `vm.compileFunction` shim.

     Plugin tokenizers (`providerOptions` `tokenizerFunc` in `src/ts/tokenizer.ts`) are replaced
     by the built-in tokenizer on the server.

   - The moved modules are fixed to strict mode without semantic change.
2. **Request layer behind a job.**
   - `requestChatData` and the LLM provider modules under `src/ts/process/request/` move to the
     server behind a `POST /api/generations` route. The route creates a job with `accepted`,
     `chunk`, `done`, and `error` events over the WebSocket. Abort is a `DELETE`.
   - The job socket shares the WebSocket upgrade with `proxyStreamJobs.ts` through one
     dispatcher; the proxy jobs' replay and cleanup rules do not apply. The generation socket
     authenticates with the JWT only.
   - The request carries the execution context of Decision 5: character and chat ids, the
     selected preset id, the effective persona id, the mode, and the raw input. The client
     settles its pending writes (`flushResources()`) before it sends, and the job freezes the
     context.
   - The job resolves `presetChain` and reports the chosen preset id in an event the client
     applies to its selection.
   - A chat has at most one active job, and a second send gets 409.
   - The server refuses edits to the message a job owns until the job's last persistence step,
     with a 409 carrying `reason: "generating"`. The refusal covers every destructive path,
     including a `begin` takeover and character deletion. Only in-process writes with the job's
     token pass.
   - A job is tracked like a resource handler and carries its epoch. A restore or shutdown during
     a job aborts it.
   - A job keeps running and persists after its client disconnects. A reconnecting client
     receives the current message instead of a replay of chunks. Records the job changes besides
     the reply reach the owner client as `resource` hydration events.
   - LLM provider calls stop using `fetchNative` and `/proxy2`, for both the job and the browser
     path. Every client `requestChatData` caller, the authenticated discovery and account calls,
     and the remote Google count go through server endpoints (`POST /api/llm/request` and the
     discovery, account, and count routes).
   - `llmSecrets` becomes write-only (set, replace, clear, masked status), with
     `customModels[].key` moved into it. The credential locations are: `supaMemoryKey` and the
     provider keys in `llmSecrets`; `voyageApiKey` and `hypaCustomSettings` in `secrets`;
     `vertexRegion` in `providers`.
   - A downloaded backup archive omits the `llmSecrets` record. Snapshots on the server keep it.
   - Auxiliary providers keep their client calls and the proxy (Decision 6): TTS, image
     generation, DeepL, Google search, and the memory processors' direct calls. Those that used an
     LLM key (OpenAI TTS, DALL-E, Whisper, Imagen, and the memory completions and embeddings) get
     it injected by `/proxy2` for a typed operation.
3. **Job-to-client channel.** The same socket carries server-to-client notices (events) and
   questions (requests with a timeout).
   - When the client creates a job it lists its registered plugin hooks, and the server calls
     back only for those. The registries are `pluginHooks.replacerbeforeRequest`,
     `replacerafterRequest`, `editinput`/`editprocess`/`editoutput`/`editdisplay`, `chatOutput`,
     `providers`, and `providerOptions`, and the plugin MCP tools.
   - Each callback envelope names the job, callback, targets, and revisions. The client that
     created the job answers, and other subscribers only observe.
   - Server-side changes reach the client before a callback runs, and the callback's own
     mutations settle before the job resumes.
   - Callbacks are serialized per client. A request made inside a callback runs its own callbacks
     as children, at most two deep.
   - A question that times out or finds no connected client fails explicitly. A plugin callback
     failure ends the job with an error.
4. **Prompt assembly.** The body of `sendChat` (history build, lore placement, memory, the final
   template pass, trimming) runs on the server against the resources from Phases 2 to 4. It
   starts with the `input` trigger and `editinput` that `DefaultChatScreen.svelte` runs today, and
   the `start` trigger. It needs the Lua and trigger runtimes of steps 6 and 7 on the server.
5. **Memory.**
   - `supaMemory`, `hypav2`, `hypav3`, and `hanuraiMemory` already return data that the pipeline
     persists, so they move with it.
   - Embeddings move to a server vector store fed by provider embeddings or by Transformers.js in
     Node. Both client processors (`HypaProcesser` and `HypaProcessorV2`) hold a LocalForage
     `hypaVector` store today.
   - Whether the Node backend runs the local models is measured in the image. A capability that
     fails is reported as unsupported on the server. WebLLM summarization (HypaV3,
     `@mlc-ai/web-llm`) is unsupported on the server.
6. **Lua on the server, only.** Port the design of the previous attempt's runtime
   (`server/fastify/src/prompt/luaRuntime.ts` in the `risuai-fastify` checkout), not its bindings.
   - wasmoon bounds JS-to-Lua calls with `functionTimeout` and a loaded chunk with
     `thread.run(0, { timeout })`. The previous runtime adds no hook of its own.
   - A worker pool is the primary design: one wasm module per worker, `resourceLimits`,
     `traceAllocations` with `setMemoryMax`, and `terminate()` on timeout. The previous runtime's
     process-wide run serialization is not ported.
   - A pool of pre-warmed one-use engines, and an aggregate budget per request. Budgets charge
     CPU time, and host waits have their own caps.
   - An abort checkpoint in every host call.
   - An egress validator for `request`: HTTPS only, public DNS-pinned targets, 30 requests per
     minute per server, 10 s, and 2 MB.
   - `simpleLLM`, `hash`, and `similarity` go through server services.
   - `generateImage` and the trigger's `v2ImgGen` are a client `generateImage` callback: Decision
     5 puts inlay generation in the job, and Decision 6 keeps image generation and its keys on the
     client.
   - `alertNormal` and `alertError` are channel notices; `alertInput`, `alertSelect`, and
     `alertConfirm` are channel questions; `reloadDisplay` and `reloadChat` are notices.
   - The image functions (`getCharacterImageMain`, `getPersonaImageMain`) return asset ids.
   - `cbs` uses the server evaluator, and `stopChat` aborts the job.
   - `scriptings.ts` has 56 registrations and 54 unique host functions. The previous runtime
     declares all 54, but it rejects the multimodal `LLMMain` and `axLLMMain` input and the image
     functions, which this phase supports.
   - Buttons (`runLuaButtonTrigger`) and manual triggers (`Chat.svelte`, `/trigger` in
     `command.ts`) run through a server command endpoint that uses the same channel.
   - Regex and Lua run behind the bounded, terminable worker with input, output, batch, and engine
     memory limits. The per-mode `lowLevelAccess` restrictions (STRUCTURE S2) stay.
   - When nothing on the client calls Lua, wasmoon leaves the client bundle.
7. **Hooks by capability.** The job runs every generation-path hook at its current position:
   - the `input`, `start`, `request`, and `output` triggers with their Lua entry points;
   - `editinput` and `editoutput` regex, Lua, and plugin handlers;
   - `editprocess` regex and plugin handlers (Lua skips `editprocess`);
   - Lua `editRequest` (there is no `editRequest` regex).

   Trigger effects that need the UI go through the channel: `v2ShowAlert`, `v2GetAlertInput`,
   `v2GetAlertSelect`, `v2UpdateGUI`, `v2UpdateChatAt`, `v2ImgGen`, and the `ReloadGUIPointer`
   bump after a variable change. `v2Command` runs data-changing commands on the server under the
   job context and sends only UI effects to the client. The native trigger regexes run behind the
   worker's limits. `v2SetPersonaDesc` writes the job's effective persona.

   Plugin callbacks:
   - Plugin `beforeRequest` and `afterRequest` replacers, body interceptors (without headers, as
     today), and the `input`, `process`, and `output` script handlers are channel callbacks.
   - `chatOutput` listeners are an acknowledged per-reply callback at their current position,
     before auto-continue or `sendAIprompt` recursion.
   - Provider plugins (`pluginmodel:::` models handled by `requestPlugin`) use a hybrid step: the
     job sends the assembled prompt, the client runs the provider, and the stream returns to the
     job, which persists and runs the output hooks.

   MCP tools split the same way:
   - remote MCP servers go through a Node MCP client, and the internal tools through server
     adapters;
   - plugin and browser-file tools (`filesystemclient.ts` needs a browser directory handle) are
     channel callbacks.
   - Remembered tool calls are conversation data, persisted as a new `chat.toolCalls` field.

8. **Script transform.** A read-only batch endpoint with a mode parameter: `editdisplay` for
   rendering, where `parser.svelte.ts` calls `processScriptFull`, and `editprocess` for the
   HypaV3 modal (`src/lib/Others/HypaV3Modal/utils.ts`) and the plugin parser API
   (`parseRisuChat`).
   - **What runs where.** For display, the server runs the CBS pre-pass of `Chat.svelte` at its
     position, Lua `editDisplay`, the `display` trigger (on the target's character and chat), CBS,
     and regex. The browser keeps both `parseAdditionalAssets` passes, inlays, thoughts, style,
     Markdown, and sanitization.
   - **Targets.** Messages, first greetings, background HTML (`BackgroundDom.svelte`), and
     translated text (`ChatBody.svelte`). Each has an owner id and the supplied source. Audit every
     `ParseMarkdown` and `processScriptFull` caller first.
   - **Isolation.** Each target runs in a fully isolated context: persistent setters are
     disabled, `@@inject` does not write message text, and `@@emo` comes back as a presentation
     effect. The server stages are read-only. Browser plugin display handlers keep today's
     capabilities.
   - **Plugin handlers.** Registered plugin handlers of either mode run between two server calls,
     keeping today's order (Lua, trigger, plugin, CBS, regex). The first call returns its
     script-state delta and the second applies it.
   - **Caching.** Results are cached whatever the CBS in them. The key is the target, the source
     text hash, the transform version with the registered handler set, the character, module,
     persona, and preset revisions, the chat variables, and the epoch. A client LRU sits on top.
   - **Re-render.** The message menu gains a "Re-render" item that bypasses and replaces the cache
     entry.
   - **Streaming.** While a message streams, the client shows its raw text through the
     browser-side steps only, and the transform runs once the message completes.
   - **Format and failure.** The response is JSON; add SSE or priority scheduling only for a
     measured need. A failure shows the unprocessed text with a notice.
   - `risuai-fastify`'s `docs/structure/intermediate-display.md` records the previous design.
9. **Post-generation effects.**
   - Checkpoints hold the raw text every three seconds and on abort. `editoutput` runs on the
     completed text, and the final write holds its result.
   - The reply persists at stream end, after the output trigger, and after inlays, keeping
     today's order on each path:
     - streaming: the output trigger, inlays, the listeners, then TTS;
     - non-streaming: inlays, the append, TTS, the output trigger, then the listeners.
   - Inlay images are generated by the client through a `generateImage` callback and written
     through the inlay path. The job resumes with the inlay id.
   - `igp` appends to the reply once, after auto-continue and before the final write.
   - The emotion modes compute on the server and reach the client as a notice. `imggen` is a
     client callback before `done`.
   - A crash keeps the last committed text and replays no external effect.
   - TTS playback and notifications stay on the client. `sendAIprompt` recursion and auto-continue
     become a bounded loop inside the job.

## Safety Contract

The browser pipeline remains selectable until every scenario below passes on the server. The plugin
API does not change shape. Every effect, Lua function, or hook that behaves differently on the
server is listed here before the browser path is removed:

- Channel questions (`alertInput`, `alertSelect`, `alertConfirm`, `v2GetAlertInput`,
  `v2GetAlertSelect`) and plugin callbacks fail explicitly on timeout or with no connected client.
- `chatOutput` listeners do not run for a reply that completes while its client is disconnected.
- Lua globals no longer survive between turns, because engines are one-use.
- Rendering is read-only on the server: Lua `editDisplay` chat-variable writes, which persist
  today, are discarded, and `@@inject` does not change message text in display mode. Browser
  plugin display handlers keep today's capabilities.
- Displayed CBS that depends on time, randomness, the viewport, other messages, or the persona stays
  as first rendered until a keyed revision changes or the user re-renders the message.
- A streaming message shows raw text until it completes.
- `editoutput` applies to completed text, not per chunk; a crash mid-stream leaves raw text.
- Plugin tokenizers are not used for server-side token counting.
- The generating message cannot be edited until its job finishes.
- A button or manual trigger during a send is refused: a command job takes the chat's one job
  slot.
- `/multisend` in a server command job (a manual trigger, a button) does not send inside the job:
  its parts are queued, and the job's tab sends them after the job ends, so the trigger's later
  effects run before the sends. A reload or a closed tab meanwhile drops the parts not sent yet.
  Inside a send job it does nothing, as in the tab while a send runs.
- A plugin provider model answers a server job through a callback to the job's tab: the providers
  are the ones registered when the job was created, the argument is built on the server from the
  job's settings, and a request that carries a stored credential is not handed to a plugin.
- Remembered tool calls are stored with their chat (`chat.toolCalls`); a call remembered without a
  chat, or before this change, stays in the browser's own store.
- The resend and auto-continue loop is capped: a job runs at most 8 such rounds (all its speakers
  together); past that the reply is finished as it stands. The rounds keep the job's preset (a
  tab's recursive send picks `presetChain` again).
- `igp` runs once, on the reply no further round follows; a reply a resend follows gets none (the
  tab runs it before each resend). On the server a prompt that is not ChatML is an error notice.
- The automatic emotion modes read the emotions the tab showed last as they were when the job was
  created, plus the job's own.
- An inlay image command of a reroll alternative is not generated (the tab starts its image and
  drops it); a reply's images are asked one after the other.
- `chatOutput` listeners each get a fresh copy of the character and chat; a listener cannot rewrite
  the reply while its job runs.
- Local WebLLM summarization is unsupported on the server, and so is each local Transformers.js
  capability that fails the in-image check.
- Dynamic-asset regex replacement runs on the server only from the memory step on.
- Lua `request` allows 30 calls per minute per server, with 10 s and 2 MB caps.
- Settings changed during a job do not affect it.
- A server restart clears the generation lock.
- The request log gets server calls through a `requestLog` notice, through the secret-free
  projection.
- `v2ImgGen`'s image size comes from the callback answer.
- An image callback with no owner leaves the reply without the image.
- The CBS pre-pass and the server display stages run with the viewport and language the client
  reports.
- Every message re-renders after any chat variable changes.
- Plugins see masked LLM credentials through `getDatabase`.
- `bodyIntercepter` registrations are not applied to calls without a job.
- Inside a callback, the selection-dependent plugin functions mean the job's chat and preset
  (Phase 4's rule), except the index-based getters and setters, which keep the tab.
- The server display trigger runs on the target's character and chat, groups included. Today it
  uses the selection and skips groups.
- `v2SetPersonaDesc` writes the job's effective persona (a bound persona wins). Today it writes the
  selected persona.
- Lore matching uses the effective persona's name.
- Callbacks nest at most two deep; a deeper request is refused with an error.
- A native trigger run stops after 100,000 effects.
- Server CBS evaluation is limited (slice 9b): a job ends with an error when one template takes
  more than 10,000,000 work units or 5 s, or its templates together more than 60 s. In a tab the
  same template runs without a limit, as today.
- Memory on the server (slice 10) uses the server's own vector cache and model files (downloaded
  from `huggingface.co` on first use), not the tab's; the `GPU` embedding variants run on the CPU;
  a ranking near a tie can differ from the tab's. An embedding provider's answer that is not the
  expected vectors is an error. The Transformers.js generation models of the catalogue, which do
  not load in a browser, run on the server with their default weights.
- MCP tools of a server job (slice 12):
  - A remote MCP server is called from the server's host, not from the browser. A URL only the
    browser reaches (its own `localhost`, a userscript or cookie session) does not work for a job,
    and a module's MCP URL reaches what the server's host reaches, loopback and private addresses
    included (a local MCP server is the common case, so Lua's public-only rule is not applied).
  - A job's models may ask for 64 tool calls in all; the next one ends the job. In a tab the tool
    loop has no bound.
  - A tool's own failure is always a text result for the model
    (`Tool call failed with error: ...`); in a tab the Google and Anthropic adapters fail the
    request instead.
  - The tool list is made once per job, at its first request; a later request of the job gets the
    same list. A tab-resident tool kind (`internal:fs`, `internal:googlesearch`, a plugin MCP)
    offers nothing to a job whose tab is not connected then (after 10 s), and its call fails as a
    tool error while no tab is connected; a tab lost after the call was sent ends the job.
  - A remote server's request ends with an error after 5 minutes, a message over 8 MiB or a tool
    list over 32 pages, 512 tools, or 1 MiB is refused, and a stream that ends without the answer
    is an error; the tab's client waits without a bound.
  - `internal:dice` on the server rolls at most 1,000 dice a call from a notation of at most 200
    characters.
  - A tool call whose name or arguments carry a stored LLM credential is not sent.
  - The OAuth prompt of a job's remote server is in English, and its page opens through a notice
    (a popup blocker may stop it). A login made by a job is stored on the server; the tab's copy
    of the refresh entries stays old until a reload, and a tab that logs in on the browser path
    with that old copy loses its new entry (the server asks again later).
  - A module that names an `internal:` MCP the server does not know offers nothing; in a tab it
    fails the request.
  - RisuAccess in a job: an empty id means the job's character (in a tab, the selected one), and
    its chat history is the job's chat; another character's history is the chat the job's tab has
    selected, so it needs that tab; the consent prompt is in English and ends the job when nobody
    answers it; the tools read what is stored at that moment, not the job's frozen settings; the
    character list is in the store's order.
  - `runLLM` in a job runs one at a time: a `runLLM` asked for while another of the job runs is
    refused.
  - Tools are offered in the job's module order; the tab's registry keeps the order in which its
    clients were first made.
- `header::` values in `additionalParams` and custom-model `params` stay readable user
  configuration, outside the credential criterion.
- A downloaded backup archive carries no LLM credentials; restoring it means entering the keys
  again.
- Pre-existing defects fixed by this phase, each recorded by its slice:
  - `igp` appended the response object to the reply;
  - remembered tool calls never decoded;
  - the MCP OAuth refresh read the token only on failure;
  - lore regex keys overwrote the first key, and a key with empty flags never matched.

## Exit Criteria

- Send, continue, reroll, group, memory, and image-generation scenarios pass through the job with
  the same assembled prompt as the browser path for fixture characters. The fixtures are
  captured from the browser path before the shared modules change.
- No LLM provider credential appears in client network traffic, except the request that enters or
  replaces a key. Auxiliary credentials and plugin-managed credentials are outside this criterion
  (Decision 6).
- Lua scripts from shared modules behave the same on the server apart from the recorded exclusions,
  including their buttons, manual triggers, and alerts.
- The client bundle contains no wasmoon, and completed messages render the same HTML as the browser
  path for fixture messages whose CBS is deterministic.
- The browser generation path and its proxy usage for LLM providers are removed.

## Validation

- Server tests for the job lifecycle, the channel, the one-job-per-chat rule, and the generation
  lock (following `server/src/tests/proxyStreamJobs.test.ts`).
- Lua runtime tests: port the cases from the previous attempt's `luaRuntime.test.ts`.
- Golden tests comparing the assembled prompt, the script transform, and token counts against
  fixtures captured from the browser path before slice 3.
- `pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`, and `pnpm test:e2e`.
- A Docker smoke at each stop from the llmSecrets flip on, and the full scenario matrix in Docker
  at cutover.
