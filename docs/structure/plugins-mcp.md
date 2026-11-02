# Plugins (v3 Sandbox) and MCP Tools

## Scope

- Owns:
  - plugin install, metadata parsing, and persistence,
  - the v3 iframe sandbox RPC and host API,
  - plugin permissions, plugin storage, plugin-provided AI providers, hooks, and UI extensions,
  - the MCP client registry, the internal MCP servers, and tool dispatch.
- Paths:
  - `src/ts/plugins/*` (`plugins.svelte.ts`, `pluginHooks.ts`, `pluginSafeClass.ts`,
    `apiV3/{factory.ts,v3.svelte.ts,risuai.d.ts,developMode.ts,transpiler.ts}`)
  - `shared/plugins.ts`
  - `plugins.md` (the plugin author guide)
  - `src/ts/process/mcp/*` (including `risuaccess/`)
  - `shared/mcp/*`, `server/src/mcp/*`
  - `src/ts/storage/pluginStorageStore.svelte.ts`
  - `src/ts/process/dynamicutils/pdf.ts` (PDF rendering used by the filesystem MCP tool)
  - `src/lib/Setting/Pages/PluginSettings.svelte`
  - `src/lib/Others/PluginDefinedIcon.svelte`
  - `src/lib/Playground/PlaygroundMCP.svelte`
  - `public/plugin_start.7z` (the starter template, binary)
- Not here:
  - The provider request loop that calls tools → `llm-requests.md`.
  - TTS hook internals → `media-aux.md`.

## Files

### Plugin install and registries

- `plugins/plugins.svelte.ts`: plugin install and [loading](#load-and-reset).
  - `RisuPlugin` (`shared/plugins.ts`): new imports store `version: '3.0'`; saved entries with any other version (an
    upstream backup's `2`, `'2.1'`, or none) stay in the list but never load, and `PluginSettings.svelte` marks their
    row "Unsupported API".
  - `importPlugin`: rejects any plugin whose `//@api` tokens do not include `3.0` (`pluginApiVersionUnsupported`).
- `plugins/pluginHooks.ts`: the hook registries. A server job reaches them through the job channel (`global-api.md`):
  the client lists its registered hooks at job creation (`registeredHooks`), and the server calls back by hook name; a
  set's membership is read when the callback runs.
- `storage/pluginStorageStore.svelte.ts`: the only runtime writer of `pluginCustomStorage` (the boot installs it as the
  server holds it, before the adapter's start-up mark). An array-shaped namespace is read as a copy of its entries and
  converted to a dictionary on its first write.
- `plugins/apiV3/pluginContext.ts`: a hook's call context, on a stack per loaded plugin instance (`currentContext`);
  `invokeHook` is the handoff slot the hook's wrapper takes on its first line.

### Sandbox host

`plugins/apiV3/factory.ts` `SandboxHost` sets the iframe sandbox and CSP, writes the RPC bridge `GUEST_BRIDGE_SCRIPT`
into the guest, and relays calls, callbacks, abort signals, and MessagePort streams.

- Both sides check the message source before reading its data: the host accepts only its iframe's window, and the guest
  only its parent.
- A host stream bridged to the guest (a `nativeFetch` body) not pulled within `UNREAD_PLUGIN_STREAM_TIMEOUT_MS` (60 s)
  gets the error `Unread plugin response expired` and its reader is cancelled, ending the host fetch and its `/proxy`
  upstream. The guest's `reconstruct` builds its stream with `{ highWaterMark: 0 }`, so it pulls only for a pending
  read.
- `startup` (safe boot): `ready`, `failed` (the top-level script threw or never ran), or `stopped` (terminated before
  either). A failed start still counts as settled for `isIdle`.
- `isIdle()`: the guest's top-level script settled while no guest-to-host call (a `nativeFetch` awaiting headers
  included), host-to-guest callback, or bridged stream either way is open, or once terminated. `onActivityChanged` hears
  every change toward idle.
- A callback that cannot be prepared or posted (including a missing guest window), or a callback result whose stream
  reconstruction fails, leaves nothing pending; rollback also cancels the guest streams already built.
- `terminate` aborts every controller it holds (host calls the guest passed a `signal`; a call without one keeps
  running), then closes the bridged streams; a host call that resolves after `terminate` posts nothing, builds no stream
  bridge, and cancels the streams of its result.

### Host API

`plugins/apiV3/v3.svelte.ts` `makeRisuaiAPIV3` implements the `risuai` global; `risuai.d.ts` declares it. Each API
object wraps the hooks its plugin registers so the hook's call context is on that instance's stack while the hook runs.

- `addProvider` replaces registrations by name (latest callback, options, and model metadata win), keeping one entry in
  each provider list.
- A registered provider asks for the `provider` permission on every call (periodic re-confirmation). A denied answer,
  prompted or cached, answers `{ success: false, content }` without calling the plugin, as does a request aborted while
  the prompt was pending; the job channel's `provider` callback and the tab's `requestPlugin` show that content as the
  request's failure.
- `onStorageDiscarded`: `customStorage` is only a flag for any other value lost (a custom key or a reserved name's own
  shape), since reading custom key names takes the `db` permission. Not awaited, a rejection logged; it needs no
  permission and has no call context.

### MCP registry

`mcp/mcp.ts` is the client registry and tool dispatch.

- `initializeMCPs`: a `stdio:` entry with `url` is treated as remote; one with `command`/`args` is rejected.
- `readyTabClient(identifier)`: the `internal:fs` or `internal:googlesearch` client, one instance for this registry and
  for a server job's callbacks, handshaken (concurrent first uses share one handshake, so one directory picker). The
  registry's cleanup drops its own reference only.
- `encodeToolCall`/`decodeToolCall`: remembered calls, in `chat.toolCalls` of the request's chat, written with
  `mergeChatMeta` so two devices adding calls keep each other's; the server uses the same field for a job's request. A
  call without a chat, or whose chat is gone when it is remembered, is not remembered (logged once).
- A browser's LocalForage store `mcp-tool-calls` (an older version's, chatless calls included) is never read, so a
  marker remembered there does not resolve (no migration).

### Remote MCP client

`mcp/mcplib.ts` `MCPClient`: remote JSON-RPC over streamable HTTP or SSE, OAuth, sessions, pagination. Events are framed
by `shared/mcp/sse.ts`, as in the server's client. A session id is taken from an `initialize` answer in JSON or as an
event stream.

- Refresh token: a stored one is used when the token endpoint answers 200 with a token, and a new `refresh_token` in
  that answer replaces the stored one (`registerRefreshToken`); anything else goes on to a full login.
- The authorization endpoint a server names must be `http:` or `https:` before it is opened.
- Retirement: `destroy()` (the registry dropped the client) starts no request, handshake, login step, or stream reader
  afterwards, and an answer that completes later (a session id, a list, a tool result, a token) is refused with
  `The MCP client was closed`. The session reset after a 404 or 401 (`reset`) keeps the client usable.
- Not fenced: other requests already sent when retired are not aborted (a refresh may still spend the stored token), and
  the custom transport (`customTransport`, no caller in the app).
- Pending SSE answers (`waitFor`, `pending`): the answer, its stream's EOF or failure, or `reset` settles them and
  removes their document listeners. An unanswered EOF on a request's own response stream returns JSON-RPC error -32000
  (`The MCP stream ended without an answer`), a read failure its message, and a reset or EOF on the current legacy GET
  `The MCP session ended`; `destroy` uses reset and the closed-client guard rejects the settled answer.
- `connectSSE` cancels and releases every reader and removes its `sses` entry in `finally`; an answered streamable
  request aborts its stream even if the server keeps it open. A ping reply's POST does not block the reader from
  observing EOF or failure.
- The legacy GET has an AbortController, its endpoint waiter also settles, and only the current legacy stream may reset
  the session on ending. The handshake refuses an ended session. A legacy waiter also settles while its POST is still
  out, and a failed POST removes its listener.

### Local MCP clients

- `mcp/internalmcp.ts` `MCPClientLike`: the base class. It accepts the optional trailing context, but dispatchers pass
  it only to plugin clients.
- Chat clients (`internal:graphmem`, `internal:risuai`, `internal:aiaccess`) have
  `callToolForChat(chatRef, name, args, scope?)`: `callMCPTool` calls it whenever it was given a chat argument (`null`
  included) and `callTool(name, args)` only when it was not (`undefined`).
- `googlesearchclient.ts`: `initializeCredentials` refuses a missing, cancelled, or blank API key or engine id before
  anything is written, and trims accepted values before `googleSearchCredentials` is saved.
- `graphmem.ts`, `aiaccess.ts`: the tab's hosts of `shared/mcp/`, whose tools and logic the server shares. For a request
  the graph is the chat variable `graphmem_graph` of its chat by id (the preset default from the request's captured
  preset when its context is for that chat, else the chat's display preset), and no chat or one that is not loaded
  answers an `Error:` text.
- `mcp/pluginmcp.ts`: `CustomPluginMCPClient` hands the context directly to its stored callbacks with `invokeHook`;
  `registerMCP` wraps those callbacks per instance with `withContext` and installs unload cleanup guarded by client
  identity. Unregister also drops that client from the tab's `MCPs`/`callOnlyMCPs`; `syncMCPs` resolves each `plugin:`
  client from the current registration on every call.

### RisuAccess

- `mcp/risuaccess/`: the handlers are `shared/mcp/risuaccess/` over a `RisuAccessHost`, so a server job runs the same
  tools on its store (`server/src/mcp/internal.ts`). `tabRisuAccessHost` serves `callTool` (no request: the Playground).
- A request's call (`callToolForChat`) runs `createRisuAccess` over `tabRisuAccessHostFor(chatRef)`, built per call: an
  empty character id names the request chat's character (`null`: none), that character's history is the request's chat,
  and another character's history is its selected chat in this tab, as a server job resolves them. Failures stay the
  tab's: no selected chat reads as an empty history.
- Every write goes through `writeConfirmed`: `promptAccess` confirmation, then the [re-resolve](#invariants) (never by
  name) and a type recheck (a group, an MCP module). A `MutationValidationError` answers an `Error:` text.

## Flows

### Load and reset

- `bootstrap.ts:loadData` calls `loadPluginsForBoot`, anything else `loadPlugins`; both run these steps.
- Safe boot: while plugins are off for this page load (`safeBootOff("plugins")`, [app-shell](app-shell.md) Safe boot) a
  load returns at once: nothing loads, nothing is reported, the remote listener of the
  [deferred reload](#deferred-reload) is never registered (and a queued deferred reload also checks the flag), so the
  settings toggle, removal, and import save without loading.
- Chain: the complete hook reset and reload run on the `pluginReload` promise chain, with each caller's enabled list
  captured before it waits; a failed reload does not block the next. The first load registers the remote `plugins`
  listener, and every load cancels a deferred reload that is waiting.
- Reset: `clearPluginHooks` (both provider maps, `customProviderStore`, the script-handler and chat-output registries),
  then `loadV3Plugins` with the enabled `'3.0'` plugins: it unloads a snapshot of the instances, waits for their
  callbacks and termination, resets the providers again and `customV3ProviderMetaStore` in place (discarding
  registrations made during unload), removes every plugin event listener from its target, and starts the replacements.
- Unload unregisters each instance's MCP clients (an identifier replaced by another client is kept), removes the
  plugin's replacers and script handlers, and rejects its pending callbacks.
- The enabled plugins of any other version are reported with one `alertError` (console only during hot reload), each
  identity once per page load: a changed script reports again.
- `loadPluginsForBoot` captures that call's startup promises immediately after `loadV3Plugins`, before another reload
  can replace the instances; `loadPlugins` does not inspect startup state. A captured guest must report `ready`;
  `failed` or a missing initial instance fails at once, and a `stopped` one follows its replacement
  ([app-shell](app-shell.md) Safe boot).

### Hook entry points

The runners of the hooks that have a chat call each hook through `invokeHook` with the context they captured
(`capturePluginContext`) or were given:

- `editdisplay` and `editprocess` handlers of a render (`parser/transformClient.ts`) run between the script transform's
  two calls with read-only `purpose: "transform"`; the results, or a handler's error per target, go to
  `/api/transform/continue`.
  - The handlers end 23 s after the first call (5 s before the chunk's 28 s, kept for the second call): a handler still
    running then fails its own target, and the other texts go out in the second call (it is not stopped, but no later
    handler of that text is started).
  - The handler set's identity is per document (a nonce, the mode, and a version that changes with the mode's ordered
    hook list), so a reload or a plugin change does not reuse a cached result made with other handlers.
- `requestChatData` runs the before/after replacers, and `requestPlugin` for providers.
- `chatOutput` listeners: a server send's `runChatOutputListeners` (`server/src/prompt/runner.ts`) reaches them through
  the job channel's `chatOutput` callback, with the job's targets.
- MCP listing and tool callbacks: the job channel passes its targets; `request.ts` passes `pluginContext` through
  `getTools`, and `transport.ts` through `callTool` for both the ownership listing and the call. The plugin client
  invokes the wrapped callback synchronously with the context, after registry awaits have finished.

Chat-bound HypaV3 summaries capture and pass their context; server callbacks, including image-view generation, run under
the job targets.

Called directly, without a context, `globalFetch` runs `bodyIntercepterStore`, and `ttsHooks.ts` runs the TTS pre- and
postprocessors: the tab's selection, or an ambient context of the same plugin, applies, not a hook target.

### Hook targets

- Inside a hook, the selection-dependent host functions read `currentContext` of their plugin instance on their first
  line (the character, chat index, lorebook, and database getters and setters, `parseRisuChat`, `sendChat`,
  `runLLMModel`). With no context on the stack, the tab's selection applies.
- They act on the hook's character, chat, and preset, and throw `PluginTargetGoneError` when the target the call needs
  no longer exists (a gone preset fails only a `getDatabase`/`setDatabase` call that names preset keys).
- `runLLMModel` uses the hook's chat for its parsing and for the provider hooks it triggers; the model settings stay the
  current ones. `parseRisuChat` inside a hook parses with `risuChatParserScoped` (the hook's preset fields and persona).

### Database setters

`setDatabase` and `setDatabaseLite` are async and apply key by key (`applyPluginKey`, to the mutation that owns the
key).

- They wait for the reconciled characters' chats to load before applying; `setDatabase` first preflights every plugin
  and awaits the install prompt, before it assigns anything.
- `plugins` (`setDatabase` only: the plugins the user confirmed) → `upsertPlugin` by name. `characters` keeps the
  mirror's order and appends new characters. `pluginCustomStorage` and unknown keys → the plugin storage module.
- The model roots `maxContext`, `seperateModels`, and `seperateModelsForAxModels` go on to `writeModelRoot`
  ([compatibility model-root write rules](llm-requests.md#compatibility-model-root-writes)): a refusal warns
  `[Settings] Refused ...`.
- `pluginKeyOrder` applies `characterOrder` and `selectedPersona` last, whatever the object's key order.
  `selectedPersona` (an index) selects on this client only.
- `warnRefused` turns a `MutationValidationError` into a `[Plugin] Refused ...` console warning and keeps that key's old
  value while the later keys still run; a gone target and any unexpected error propagate to the plugin.
- Preset fields land in the hook's preset, else this client's selected one. Outside a hook, that is the preset selected
  when the wait ends, not at the call; the selection can change meanwhile, including its repair moving a gone preset
  selection to the first preset .

### Deferred reload

A remote `plugins` change (another tab or device; `onRemoteRecordApplied` after a live record, a live patch, or a
conflict reload) reloads the plugins here once plugin work is idle.

- Only a change to the load signature counts: each enabled `'3.0'` plugin's name, script, and `allowedIPC`, in list
  order (what the sandboxes capture at start; arguments are read live), compared with the signature of the plugins
  running now (unset while a reload replaces them or after a failed one).
- While a local load is queued or running, every remote change requests the deferred check; the comparison inside the
  chain discards redundant work after the local loads settle.
- Idle (`pluginWorkIdle`, `v3.svelte.ts`; `onPluginWorkChange` hears changes) means all of:
  - no send of this tab (`anyLocalSend`);
  - no job of this tab that may still call its hooks (`generationPluginWorkActive`);
  - no host-side hook invocation running (every wrapped hook, and a provider from before its permission prompt);
  - every sandbox idle (`SandboxHost.isIdle`).
- A job counts from before `createGenerationJob` lists its hooks, or from `followGenerationJob`, and while it is saved
  for this tab, until `releaseGenerationJob`; busy attempts, queued channel events, and running channel callbacks also
  count (`generationJobs.ts`). A job captured its hook inventory at creation and the server calls those hooks until it
  ends, so a reload between two callbacks would fail the later one as an unregistered hook.
- Each source notifies on a change toward idle. When idle, one reload is queued on the `pluginReload` chain; it checks
  idleness again right before it clears anything (synchronously up to `clearPluginHooks`), and waits again when work
  started meanwhile.
- It loads the list as it is then; a list whose signature matches what runs does nothing. There is no wait limit or
  interruption.

### Tool dispatch

A server job does not use the tab's registry (`server/src/mcp/`, `server-generation.md`):

- Remote servers and `internal:dice` run on the server.
- `internal:fs`, `internal:googlesearch`, and a `plugin:` MCP registered when the job was created run in the job's tab
  through the `mcpList` and `mcpTool` callbacks (`src/ts/network/jobChannel.ts`).
- `internal:aiaccess`, `internal:risuai`, and `internal:graphmem` run on the server over the job's data (`shared/mcp/`).

The tab's own requests (`/api/llm/request`) run their tool loops on the server too (`server/src/llm/`):

- A tool call becomes an `mcpTool` callback, which the tab answers with `callTool` for the request's chat (its explicit
  chat, else the chat selected when it began). That chat picks the module MCP servers, and `internal:graphmem` and
  `internal:risuai` act on it whatever is selected when the callback arrives.
- A remembered call (`rememberToolUsage`) is stored in the tab by `encodeToolCall` from the request's `toolRecord`
  event; the tab sends the records a prompt's markers name with the request.

### Job owner presence

[Generation channels](server-generation.md#generation-channels) owns the contract a tab-side tool or hook answers inside
(pings, the 45 s silent socket, the 120 s absence bound, attach replay).

- MCP owner checks exclude silent sockets. A live tab answering pings can keep a long non-streaming provider call
  running without progress frames.
- A provider failure on absence expiry (`disconnected`) follows the partial-save and job-end path; tail hooks that skip
  on `disconnected` can continue.

## State

- `db.plugins: RisuPlugin[]`, saved as the `plugins` resource.
- Plugin storage:
  - `pluginStorage` is saved data in `db.pluginCustomStorage` (the `pluginStorage` resource), a settings record: each
    write queues its save once. It uses the reserved `_pluginStorage` sub-object, and `setItem` JSON-normalizes values
    (throws on BigInt). The top level holds the non-`allowedDbKeys` properties written through
    `setDatabase`/`setDatabaseLite`.
  - Every plugin shares the one record. The storage writes resolve when queued, not when saved. A conflict with another
    tab's or device's write is [merged key by key](resource-sync.md#record-merge), and `onStorageDiscarded` tells every
    listening plugin which keys lost a value.
  - `getLocalPluginStorage()` (`SafeLocalPluginStorage`) is saved too, under the reserved `_safeLocalPluginStorage`
    sub-object (legacy browser-local values are imported at boot). Values must be plain JSON (`isJsonValue`); anything
    else throws `TypeError` and changes nothing.
  - Any string is a `_safeLocalPluginStorage` key, `__proto__` included (the module rebuilds the dictionary for it, and
    the save adapter serializes `pluginStorage` straight from the proxy so the key reaches the server).
  - `safeLocalStorage` (`SafeLocalStorage`) stays device-local (`localStorage` `safe_plugin_*`).
- v3 permission grants live in the server-owned `pluginPermissions` resource (`permissionStore.ts`), outside the
  settings records: `grants` keyed by `<sha256 of the script>_<permission>`, `lastGrantTime` by plugin name and
  permission.
  - Only `getPluginPermission` (host consent) adds to it; no plugin API, `getDatabase` snapshot,
    `setDatabase`/`setDatabaseLite`, or `pluginCustomStorage` write can reach it.
  - The script hash is taken from the script the plugin was loaded with, and answers are cached per plugin and
    permission for the page load (cleared on unload).

## Coupling

- Plugin consumers: `bootstrap.ts`, `PluginSettings.svelte`, `globalApi.svelte.ts`, `modellist.ts`
  (`customV3ProviderMetaStore`). Hook-registry consumers: `ModelSettings.svelte`, `request.ts`, `transformClient.ts`,
  `jobChannel.ts`, `tokenizer.ts`.
- MCP consumers: `request.ts` and the provider adapters, `PlaygroundMCP.svelte`, `IrisModal.svelte`/`iris.ts`.

## Invariants

- The plugin's internal `name` is its identity. Updates must not change it, because permission hashes, IPC allowlists,
  storage, and arguments are keyed by it.
- Only API 3.0 exists. Plugins run only inside the iframe; nothing executes plugin code in the main document.
- v3 calls are async RPC. Nested classes and callbacks inside values are unsupported. Streams need MessagePort
  credit/cancel, and `terminate` must close them.
- A host call's abort controllers live until every response stream finishes (done, error, guest cancel, unread expiry,
  rollback, or termination). A guest callback's mirrored controllers likewise live until every returned stream finishes,
  errors, is cancelled by the host, or is rolled back, so a host abort still reaches the plugin and requests using its
  signal after the callback returns. Calls and callbacks that throw or return no streams release their controllers
  immediately.
- The sandbox host never logs an RPC message or its answer: their arguments carry the plugin's `nativeFetch` headers
  (API keys) and bodies.
- Main-document DOM access requires the v3 `getRootDocument` permission plus the Safe wrappers.
- Any new v3 UI or hook must call `addPluginUnloadCallback` and must sanitize external HTML and URLs.
- Tool names are resolved globally, first match wins. Adapters usually keep only text content.
- A plugin or MCP write goes through a mutation module (`characterStore.svelte.ts`, `collectionStore.svelte.ts`,
  `pluginStorageStore.svelte.ts`, the chat module); a new host setter or tool never writes a record or a chat directly.
  A refused value warns (plugins) or answers an error (MCP) and changes nothing.
- Transform continuations refuse durable-data writes at host entry without throwing. `hasReadOnlyContext` checks every
  active context of the calling instance before any await; `currentContext` still selects targets. Job-channel callbacks
  remain writable unless a transform on the same instance overlaps. API returns and exclusions are in the
  [plugin author contract](../../plugins.md#read-only-transform-continuations); the rendering
  [limitations](cbs-rendering.md#limitations) record attribution and indirect effects.
- A hook runner captures the call context before its first await and passes it to every hook it calls; a new
  selection-dependent host function reads `currentContext` on its first line.
- An MCP write tool re-resolves its record by the id captured before the consent prompt, and builds its patch
  synchronously after that lookup.
- A request's tool call reaches the chat clients with the request's chat: the graph, the implicit character's history,
  and nested LLM requests use that chat. AI access also passes the request's captured prompt and model preset scope;
  null stays chatless. Only implicit targeting without a chat argument (the Playground) uses the selection; module
  discovery keeps its own fallback.
- v3 plugin storage accepts JSON data only, at most 256 levels deep (`requireJsonData`).
- `changeColorScheme` with an unknown name changes nothing: neither the active scheme nor its stored name.
- A `SafeElement` listener hears only events that reach its element through DOM propagation; the `SafeDocument` from
  `getRootDocument` registers on `document`. Each registration keeps its target, type, and options, and removal by id
  and the reload teardown replay that record, whatever the caller passes to `removeEventListener`.
- Plugin key listeners (`keydown`/`keyup`/`keypress`, on any element or the document, capture phase included) receive
  nothing from the terminal notice's opening until reload, its acknowledgement key release included
  (`terminalNoticeShown`): the notice stops only bubbling.
- A plugin character applied over the same `chaId` (`applyPluginCharacter`) keeps the stored `supaMemoryOnCount`
  whatever its copy says, and bumps it when it turns `supaMemory` on (`memory.md`).
- The v3 `sendChat` targets the hook's chat (else the chat selected after permission resolves) and returns whether the
  send ran. It refuses ("A chat is already in progress") without appending, checked again after the chat load:
  - while that chat is busy (`isChatBusy`: a send of this tab, a followed job, or a lock; a generation hook's chat in a
    job channel callback always is);
  - while a job channel callback runs in this tab (`channelCallbacksRunning`: a hook or provider that waited for a new
    job of this tab would hold the lane that job's callbacks need; a cancelled callback counts until its hook settles).
- A chat with orphaned lore overrides is refused after that, also before anything is appended: the user sees the refusal
  alert and the call returns false.
- `sendChat`'s local checks are per chat: with no job channel callback running, a send in idle chat B can run while chat
  A sends in this tab; shared resource flush (`GenerationBlockedError`), binding, and server refusals still apply.
- A plugin changes the installed plugin list only through `setDatabase({ plugins })`, which asks the user to confirm
  each new or changed plugin. `setDatabaseLite` drops `plugins` before it applies anything; the other keys of the call
  still apply.
- `risu-set-module-info` checks every recognized field's type before it writes any field or `enabledModules`.
- `updateModule` validates a detached patched copy, then applies the patch to the live module in place, so a plugin's or
  an editor's retained module reference stays current.

## Recipes

- Add a v3 API function:
  1. Implement it in `v3.svelte.ts:makeRisuaiAPIV3`. Nested objects need flat host functions plus `_getAliases`.
     Constants go in `_getPropertiesForInitialization`.
  2. Declare it in `risuai.d.ts:RisuaiPluginAPI`.
  3. Document it in `plugins.md`.
  4. Verify with a real v3 plugin, including the callback and error paths.
- Add plugin metadata: `importPlugin`, `RisuPlugin` (`shared/plugins.ts`), `PluginSettings.svelte`, `risuai.d.ts`
  comments, and `plugins.md`.
- Add an internal MCP server: subclass `MCPClientLike` (`getToolList`, `callTool`), add a switch case in
  `mcp.ts:initializeMCPs`, and optionally add a choice to `importMCPModule`. If its tools act on a chat, add
  `callToolForChat(chatRef, name, args, scope?)` and address that chat by id (it is pinned and loaded only while a
  request's events run); `callTool` stays the no-request path.
- Change the tool loop: `mcp.ts` `getTools`/`callTool` plus every server adapter (`server/src/llm/openAI/requests.ts`,
  `openAI/responses.ts`, `google.ts`, `anthropic.ts`) and the callback leg (`server/src/llm/requests.ts`,
  `src/ts/process/request/transport.ts`).

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/plugins src/ts/process/mcp src/ts/storage/tests/{pluginStorageStore,collectionStore}.test.ts src/ts/network/generationJobsPluginWork.test.ts src/ts/process/request/tests/transport.test.ts`
  for the tab; `pnpm --silent test:agent server/src/tests/mcp{,Internal,Sse}.test.ts` for the server. Provider adapter
  tool loops: [LLM requests](llm-requests.md).
- `slow`: none. `e2e`: `e2e/transformGolden.spec.ts` (edit hooks), `e2e/lazyChats.spec.ts` (RisuAccess history),
  `e2e/settingsPages.spec.ts` (the page).
- `SandboxHost` stub (`vi.mock` of `./factory`, most of `apiV3/`): the real API object is driven directly.
- `guestBridge.test.ts`: the srcdoc's guest half over a fake window; it still logs its property initialization.
- `sandboxActivity.test.ts`: a real `SandboxHost`, the guest simulated by window messages.
- `pluginDeferredReload.test.ts`, `pluginSafeBoot.test.ts`: a mocked v3 loader, the idle predicate and safe-boot flag
  controlled. `pluginWorkIdle.test.ts`: a controllable sandbox idle flag, the job channel real.
- `storeBackedServer.ts`: the real save adapter over the real server store, for saved writes. `FakeResourceServer`:
  `permissionStore.test.ts`.
- `mcplib.test.ts`: a fake `fetchNative`. `mcpLeases.test.ts`: a fake `MCPClient` with gated calls.
- `server/src/tests/mcp.test.ts`: injected `fetch`. `mcpInternal.test.ts`: the job tool set over a real store.
- `util/playwright/checkJobProtocol.mjs` (a browser check, not in the gate): a real v3 plugin provider answers job
  callbacks from the sandbox ([test-harness](test-harness.md)).
- Not tested: filesystem MCP tools and PDF rendering, hot reload, and the remaining sandbox RPC surface; cancellation
  while the job channel's dynamic MCP module import is pending.

## Known Hazards

### Issues

- The declarations and runtime disagree:
  - `risuFetch` and `setChatPanel` are implemented but not declared.
  - The arity of `saveSecretHeader` differs.
  - The `SafeDocument.createElement` declarations are synchronous.
- `filesystemclient.ts` advertises `fs_watch_directory` but has no dispatch for it.
- A rotated refresh token is a whole-collection `authRefreshes` edit from the tab (and the server job's write to the
  same collection is not hydrated into the tab): another writer of the collection can make the tab's write conflict and
  be discarded, and the next refresh then sends a token the server may have spent (a full login follows).
- The server MCP client fences a rotated-token write against the job and client signals. If the remote server rotates
  the old refresh token before the answer arrives, an abort or client close in that window leaves the old token stored
  while the new one is lost; the next refresh may fail and require a full login. `server/src/tests/mcp.test.ts` pins the
  cancellation behavior, not the remote server's token state.
- The tab's `MCPClient` has no request timeout, and `request.ts` `getTools` does not propagate an abort signal to its
  tool listing. A stream that stays open without answering can still keep that caller waiting.
- Consented capabilities reach further than their names suggest (never reviewed): `mainDom` lets a plugin listen on
  `document` through `getRootDocument` and forwards keys (except from the terminal notice's opening until reload), so a
  plugin could observe typing in the password or credential prompts; `mainDom` also allows document-wide queries and
  mutation; `nativeFetch` lets a plugin choose its headers; the RPC dispatcher in `factory.ts` looks callables up
  without an allowlist.
- A plugin event listener lives until the wrapper that registered it removes it by id or plugins reload: removing its
  element from the page keeps it (and the element), a `once` listener that fired stays in the teardown list, and a
  wrapper queried again for the same node does not know the id.
- A plugin's whole-chat setter (`setChatToIndex`, and a character setter's `chats`) diffs the plugin's copy against the
  chat at call time: `captureChatBaseline` runs right before `applyChatResult`, not when the plugin read the chat. So a
  change another writer made after the plugin's read is overwritten: a changed message field or chat field is set back
  to the copy's value (a `CHAT_META_MERGE_KEYS` map only in the entries that differ), and a message added meanwhile is
  removed.
- `unloadV3Plugin` waits up to one second after the unload callbacks before `SandboxHost.terminate`; a plugin's pending
  async work can still register a hook in that window. The post-unload reset removes providers registered then; other
  hooks still have this hazard.
- A plugin provider whose model descriptor fails `isModelDescriptor` makes the generation's hook list fail with HTTP 400
  on the server, although the tab registered it without complaint.

### Limitations

- The [deferred reload](#deferred-reload) never interrupts, so work that never ends defers it until this tab reloads or
  a local `loadPlugins` runs: a top-level script that never settles, a hook or guest callback that never answers, a
  stream bridged either way never finished (a host stream the guest never pulls expires at 60 s), or a job this tab
  never releases. Work that starts while a reload unloads the old sandboxes is not fenced: a job created then lists the
  hooks registered at that time. Decision: RisuNest Small Wins D4, [archive](../archived-plan/README.md).
- A cancelled hook that never settles keeps plugin `sendChat` refused (`channelCallbacksRunning`), and after the
  server's `CANCELLED_CALLBACK_DRAIN_MS` (60 s) a later job's root callbacks are refused on this tab, both until the
  page reloads; admitting another root while the cancelled hook can still write would let it overlap later work.
  Decision: Per-Chat Send D8, [archive](../archived-plan/README.md).
- A server job's remote MCP requests leave from the server host, so a browser-only URL or session is unavailable and the
  module URL reaches addresses visible to that host, including loopback and private networks. See
  [STRUCTURE platform/network invariant](../../STRUCTURE.md#platform-and-network). Decision: STRUCTURE P2.
- `internal:fs` for a server job asks for the directory inside a callback, after the send's click: the browser may
  refuse the picker without a user gesture. Decision: owner-tab work in
  [`jobTools.ts`](../../server/src/mcp/jobTools.ts).
- A remote server's OAuth page opens through an `openURL` notice, which a popup blocker may stop. Decision: owner-tab
  work in [`jobTools.ts`](../../server/src/mcp/jobTools.ts).
- A plugin's timers and UI callbacks share the instance's ambient `PluginCallContext`, so they may inherit an in-flight
  hook's context. Exact per-call attribution needs an RPC correlation id. Decision:
  [`pluginContext.ts`](../../src/ts/plugins/apiV3/pluginContext.ts).
- Aux calls (`runLLMModel`, `imggen` prompt requests) made through `channelCall` end with their hook callback; calls
  without that context do not. The send guard accepts its job ids only while the callback runs uncancelled and checks a
  stale context against the chat binding. Decision: Per-Chat Send D8, [archive](../archived-plan/README.md).
- A plugin's ambient context carries its hook callback, but body interceptors have no context, a provider's context ends
  when it returns its stream, and tab `internal:aiaccess` captures chat context without `channelCall`; requests from
  those paths are not ended with the callback. Decision: Per-Chat Send D8, [archive](../archived-plan/README.md).
- A plugin setter's non-null section value is not normalized on the writing tab: the server normalizes its copy, but the
  batch answer carries revisions only, so the tab keeps the value until reread or a live update. Decision: accepted
  mirror-normalization limit in [persistence](persistence.md#known-hazards).
- A plugin call that adds a character and also passes `characterOrder` without the new id: the order is written after
  the add and overwrites the add's repair, so the id is missing from the order until the next `checkCharOrder`
  (`pluginKeyOrder` in `v3.svelte.ts`). Decision: [`pluginKeyOrder`](../../src/ts/plugins/apiV3/v3.svelte.ts).

### Gotchas

- Remote MCP, in both clients (`mcplib.ts` and the server's port): a 404 with a session or a 401 with a token resets the
  session and repeats the request once without them (the call after that handshakes again).
- A server MCP OAuth code question is tied to the MCP client's closing signal, while the caller's abort only rejects
  that caller. It can stay open until the client closes, the job channel ends, or it times out; a queued question has no
  timeout until dispatch.
- The character records hold no chats: the plugin getters build the legacy shape at the boundary (`withChatsCopy`). The
  getters pin the chats, await `loadChats`, and copy from the chat module, so `getDatabase` with `characters` loads
  every chat that is not loaded, and idle chats can be evicted afterwards. It reads through the store, not detached:
  unsaved local changes are in the copy.
- The chat getters first [refresh the chats' projections](structured-memory.md#the-hypav3-projection).
- `getChatFromIndex`, `setChatToIndex`, `parseRisuChat`, and `sendChat` capture their chat by id first and await
  `ensureChatLoaded`. The character setters capture their targets, pin and load the chats, then apply synchronously.
- Plugins hand back whole objects, but [chats are saved as changes](chat-store.md#whole-chat-writers).
  `applyPluginCharacter`/`applyPluginCharacters` pass a character's `chats` to `reconcileCharacterChats`: a chat with a
  known id is diffed against the chat as it is at the call and applied (`applyChatResult`), a chat without an id or with
  a new one is created, a chat left out is deleted (never the last one), the list order becomes the chat order, and a
  supplied `chatPage` selects that chat in this tab. New setters go through the same functions; never assign `chats` or
  `chatPage`.
- When a whole-chat diff would change or remove a message being generated (`assertUnlocked`), that chat's update is
  skipped with a console warning; a reorder of unchanged messages while it generates drops only the order change.
- A character that is generating is neither replaced (another `chaId` at its index) nor removed (left out of a
  `characters` list), a `characters` list with duplicate `chaId` values is refused as a whole, and `removeChar` refuses
  a permanent delete of it.
- A custom `tokenizerFunc` is never called: tab token counts run on the server, which uses `cl100k_base` for a
  provider's `custom` tokenizer ([LLM requests](llm-requests.md)).
