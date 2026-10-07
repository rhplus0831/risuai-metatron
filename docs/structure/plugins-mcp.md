# Plugins (v3 Sandbox) and MCP Tools

## Scope

- Owns:
  - plugin install, metadata parsing, and persistence,
  - the v3 iframe sandbox RPC and host API,
  - plugin permissions, plugin storage, plugin-provided AI providers, hooks, and UI extensions,
  - the MCP client registry, the internal MCP servers, and tool dispatch.
- Paths:
  - `src/ts/plugins/*` (`plugins.svelte.ts`, `pluginHooks.ts`, `pluginSafeClass.ts`, `apiV3/{factory.ts,v3.svelte.ts,risuai.d.ts,developMode.ts,transpiler.ts}`)
  - `plugins.md` (the plugin author guide)
  - `src/ts/process/mcp/*` (including `risuaccess/`)
  - `src/lib/Setting/Pages/PluginSettings.svelte`
  - `src/lib/Others/PluginDefinedIcon.svelte`
  - `src/lib/Playground/PlaygroundMCP.svelte`
  - `public/plugin_start.7z` (the starter template, binary)
- Not here:
  - The provider request loop that calls tools → `llm-requests.md`.
  - TTS hook internals → `media-aux.md`.

## Files

Plugins:

- `plugins/plugins.svelte.ts`: plugin install and loading.
  - `RisuPlugin` (the persisted shape, declared in `shared/plugins.ts`). New imports store `version: '3.0'`; saved entries with any other version stay in the list but never load.
  - `importPlugin`: parses the `//@name`, `//@api`, `//@display-name`, `//@arg`/`//@risu-arg`, `//@link`, `//@update-url`, `//@version`, `//@allowed-ipc` headers, then transpiles TypeScript. Rejects any plugin whose `//@api` tokens do not include `3.0` (`pluginApiVersionUnsupported`).
  - `loadPlugins`: `clearPluginHooks`, then `loadV3Plugins` with the enabled `'3.0'` plugins.
  - `allowedDbKeys` (the DB keys the plugin DB API reads and writes directly), `handlePluginInstallViaPlugin`.
- `plugins/pluginHooks.ts`: `pluginHooks` (the provider, script-handler, replacer, and chat-output registries), `clearPluginHooks`, `customProviderStore`, and the provider/hook types. A server job reaches them through the job channel (`src/ts/network/jobChannel.ts`, `global-api.md`): the client lists its registered hooks at job creation (`registeredHooks`), and the server calls back by hook name; a set's membership is read when the callback runs.
- `plugins/pluginSafeClass.ts`: `SafeLocalStorage`, `SafeLocalPluginStorage` (delegates to the plugin storage module), `isJsonValue`, `tagWhitelist`.
- `storage/pluginStorageStore.svelte.ts`: the only runtime writer of `pluginCustomStorage` (the boot installs it as the server holds it, before the adapter's start-up mark). `setPluginStorageItem`/`removePluginStorageItem`/`clearPluginStorage` (the reserved `_pluginStorage` namespace, `PLUGIN_STORAGE_KEY`), `setSafeLocalPluginValue`/`removeSafeLocalPluginValue`/`clearSafeLocalPluginStorage` (`_safeLocalPluginStorage`, `SAFE_LOCAL_PLUGIN_STORAGE_KEY`; any key becomes an own key, `__proto__` included), `setPluginCustomValue` and `replacePluginCustomStorage` (the top-level keys `setDatabase` writes), and the readers. An array-shaped namespace is read as a copy of its entries and converted to a dictionary on its first write.
- `plugins/apiV3/pluginContext.ts`: the per-plugin call context of a hook. `PluginCallContext` (`chatRef`, `presetId`, `personaId`), `capturePluginContext(chatRef)`, `invokeHook(hook, context, ...args)` (the handoff slot the hook's wrapper takes on its first line), `enterContext(owner, context)`/`currentContext(owner)` (a stack per loaded plugin instance), and `PluginTargetGoneError`.
- `plugins/apiV3/permissionStore.ts`: the v3 permission grants in the server-owned `pluginPermissions` resource (`loadPluginPermissions`, `hasPermissionGrant`, `getLastGrantTime`, `recordPermissionGrants`).
- `plugins/apiV3/factory.ts` `SandboxHost`: sets the iframe sandbox and CSP, writes the RPC bridge `GUEST_BRIDGE_SCRIPT` into the guest, and relays calls.
  - Message types: `CALL_ROOT`/`CALL_INSTANCE` → `RESPONSE`.
  - Handles callbacks, remote references (`__classType='REMOTE_REQUIRED'`), abort signals, and MessagePort streams.
- `plugins/apiV3/v3.svelte.ts`: the v3 host API.
  - `makeRisuaiAPIV3`: the host implementation of the `risuai` global. Older API names (`getChar`/`setChar`, `getArg`/`setArg`, `risuFetch`, `readImage`, `setDatabase`/`setDatabaseLite`, ...) are implemented by module-level helpers in the same file.
  - `applyPluginKey`: the routing of `setDatabase`/`setDatabaseLite`, one key at a time to the mutation that owns it (`characters` → `applyPluginCharacters`, `personas` → `setPersonas`, `modules`/`enabledModules`/`characterOrder`/`plugins` → the collection module, `pluginCustomStorage` and unknown keys → the plugin storage module, `selectedPersona` → `selectPersonaAt`, the other `allowedDbKeys` → `updateSettings` with the hook's preset). `pluginKeyOrder` applies `characterOrder` and `selectedPersona` last. `warnRefused` turns a `MutationValidationError` into a `[Plugin] Refused ...` console warning and keeps the old value.
  - Each API object wraps the hooks its plugin registers (script handlers, replacers, chat listeners, providers) so the hook's call context is on that instance's stack while the hook runs.
  - `loadV3Plugins`, `executePluginV3`, `getV3PluginInstance`.
  - `customV3ProviderMetaStore`: `pluginmodel:::` models.
  - Permissions, runtime `SafeElement`, unload callbacks.
- `plugins/apiV3/risuai.d.ts`: the public v3 API declarations (`RisuaiPluginAPI`, `MCPToolDef`, ...).
- `plugins/apiV3/developMode.ts` `hotReloadPluginFiles`: polls the File System Access API.
- `plugins/apiV3/transpiler.ts` `pluginCodeTranspiler`: Sucrase.

MCP:

- `mcp/mcp.ts`: the client registry and tool dispatch.
  - `initializeMCPs`: sets up internal, `plugin:`, and remote clients. A `stdio:` entry with `url` is treated as remote; one with `command`/`args` is rejected (`stdio MCPs are not supported`).
  - `readyTabClient(identifier)`: the `internal:fs` or `internal:googlesearch` client, one instance for this registry and for a server job's callbacks, handshaken (concurrent first uses share one handshake, so one directory picker). The registry's cleanup drops its own reference only.
  - `MCPs`, `callOnlyMCPs`.
  - `getMCPTools`, `getTools`, `callTool`, `callMCPTool`.
  - `importMCPModule`.
  - `encodeToolCall(call, chatRef?)`/`decodeToolCall(text, chatRef?)`: remembered calls. With the request's chat they live in `chat.toolCalls` (written with `mergeChatMeta`, so two devices adding calls keep each other's; the server reads and writes the same field for a job's request). A call without a chat, or whose chat is gone when it is remembered, is not remembered (logged once); a marker remembered in the browser's former LocalForage store `mcp-tool-calls` (by an older version, or without a chat) no longer resolves (the store was removed; alpha, no migration). `transport.ts` passes the request's chat for both.
- `mcp/mcplib.ts` `MCPClient`: remote JSON-RPC over streamable HTTP or SSE, OAuth, sessions, pagination. Protocol versions `2025-03-26`/`2024-11-05`. Events are framed by `shared/mcp/sse.ts` (`SseFramer`: bytes in, each event's text out, CRLF, LF, or CR line ends; `parseSseEvent`: `data:` and `event:` with or without the space, comments skipped), as in the server's client. A session id is taken from an `initialize` answer in JSON or as an event stream. A stored refresh token is used when the token endpoint answers 200 with a token, and a new `refresh_token` in that answer replaces the stored one (`registerRefreshToken`); anything else goes on to a full login; the authorization endpoint a server names must be `http:` or `https:` before it is opened. `addAuthRefresh` (`persistence.md`) keeps one entry per server URL. `destroy()` retires the client (the registry dropped it): it starts no request, handshake, login step, or stream reader afterwards, and an answer that completes later (a session id, server info, a tool or prompt list, a tool result, a token or rotated refresh token) is refused with `The MCP client was closed`; the session reset after a 404 or 401 (`reset`) keeps the client usable. A request already sent when the client was retired is not aborted (a refresh sent then may still spend the stored token), a stream reader already running still dispatches its events, and the custom transport (`customTransport`, no caller in the app) is not fenced.
- `mcp/internalmcp.ts` `MCPClientLike`: base class for local clients.
- Local clients:
  - `filesystemclient.ts`: File System Access.
  - `googlesearchclient.ts`: `google_search`, `google_search_images`.
  - `dice.ts`.
  - `graphmem.ts`: chat variable `graphmem_graph` plus `HypaProcesser`. The tools and their logic are `shared/mcp/graphmem.ts` (`GRAPHMEM_TOOLS`, `callGraphMemTool` over a `GraphMemHost`: the variable and a similarity search), shared with the server; this file is the tab's host. A chat without the variable (it reads as `null`) or with a non-array value starts an empty graph, and the search fills the processor with `addText` before ranking (both hosts); the ranking returns every entry by similarity, without a threshold.
  - `aiaccess.ts`: `runLLM` → `requestChatData`. Shared the same way: `shared/mcp/aiaccess.ts` (`AIACCESS_TOOLS`, `callAiAccessTool` over an `AiAccessHost`).
- `mcp/pluginmcp.ts`: `registerMCPModule`/`unregisterMCPModule` and `registeredCustomPluginMCPs`. IDs must start with `plugin:`.
- `mcp/risuaccess/`: `RisuAccessClient` with `CharacterHandler`, `ChatHandler`, and `ModuleHandler`. Tools that read and write characters, lore, regex, Lua, and modules. The three handlers are `shared/mcp/risuaccess/{characters,chats,modules}.ts` over a `RisuAccessHost` (`host.ts`: the records as they are now, the two writes, the current chat's messages, the consent prompt; `index.ts` `createRisuAccess` is the list and dispatch for a host), so a server job runs the same tools on its store (`server/src/mcp/internal.ts`). The classes here are the shared handlers over `host.ts` `tabRisuAccessHost` (the mirror, `updateCharacter`/`updateModule`/`setModuleEnabled`, `alertConfirm` with `language.mcpAccessPrompt`); `mcplib.ts` re-exports `MCPTool` and `MCPToolHandler` from the shared host file.
  - `utils.ts` `getCharacter(id)` (by `chaId`, else name; the selected one for an empty id) and the collection module's `findModule(id)` return the mirror records typed `DeepReadonly`.
  - Every write goes through `writeConfirmed(id, tool, action, write)`: resolve, `promptAccess` confirmation, resolve again by the captured id (never by name) and recheck the type (a group, an MCP module), then run the synchronous `write` on that record. The write builds the one list or field set it changes and calls `updateCharacter`/`updateModule`; a `MutationValidationError` answers an `Error:` text.

## Flows

Plugins:

1. `bootstrap.ts:loadData` → `loadPlugins` → `clearPluginHooks` → `loadV3Plugins`.
2. `executePluginV3` builds a hidden iframe, then `new SandboxHost(makeRisuaiAPIV3(...))`, then `host.run(code)`.
3. Hook entry points in the host. The runners of the hooks that have a chat capture the call context (`capturePluginContext` of their chat) before their first await, or take the one they were given, and call each hook through `invokeHook`:
   - The `edit*` hooks: a render's `editdisplay` and `editprocess` handlers (`parser/transformClient.ts`) run between the script transform's two calls: the server answers the texts before the handlers and keeps the rest; the tab runs the mode's handlers in order on each text with the captured context (`invokeHook`; the texts side by side), and sends the results, or a handler's error per target, to `/api/transform/continue`; the handlers end 23 s after the first call (5 s before the chunk's 28 s, kept for the second call): a handler still running then fails its own target, and the other texts go out in the second call (it is not stopped, but no later handler of that text is started). The handler set's identity is per document (a nonce, the mode, and a version that changes with the mode's ordered hook list), so a reload or a plugin change does not reuse a cached result made with other handlers.
   - `requestChatData` runs the before/after replacers, and `requestPlugin` for providers.
   - `sendChat:runChatOutputListeners` (the send passes its context down to its scripts, requests, and recursions).

   Called directly, without a context (the tab's selection, or an ambient context of the same plugin, applies):
   - `globalFetch` runs `bodyIntercepterStore`;
   - TTS hooks via `ttsHooks.ts`;
   - the memory summarization and image-generation paths.

4. Inside a hook, the selection-dependent host functions read `currentContext` of their plugin instance on their first line: `getCharacter`/`setCharacter`, `getChar`/`setChar`, `getCurrentCharacterIndex`, `getCurrentChatIndex`, `getCurrentLorebookEntries`, `parseRisuChat`, `sendChat`, `runLLMModel`, `getDatabase`, and `setDatabase`/`setDatabaseLite`. They act on the hook's character, chat, and preset, and throw `PluginTargetGoneError` when the target the call needs no longer exists (a gone preset fails only the preset keys of `getDatabase`/`setDatabase`). `runLLMModel` uses the hook's chat for its parsing and for the provider hooks it triggers; the model settings stay the current ones. `parseRisuChat` inside a hook parses with `risuChatParserScoped` (the hook's preset fields and persona, `parser.svelte.ts`). With no context on the stack, the tab's selection applies.
5. UI extensions push into the rune arrays in `stores.svelte.ts` (`additionalSettingsMenu`, `additionalChatMenu`, `chatPanelStore`, ...) and must register cleanup with `addPluginUnloadCallback`.

MCP:

1. `getTools` collects the schemas.
2. Provider adapters (OpenAI Chat/Responses, Google, Anthropic) run model tool calls.
3. `callTool` dispatches by tool name, first match wins, and the result is appended. A server job does not use this registry (`server/src/mcp/`, `self-host-server.md`): remote servers and `internal:dice` run on the server; `internal:fs`, `internal:googlesearch`, and a `plugin:` MCP registered when the job was created run in the job's tab through the `mcpList` and `mcpTool` callbacks (`src/ts/network/jobChannel.ts`); `internal:aiaccess`, `internal:risuai`, and `internal:graphmem` run on the server over the job's data, with the same tools and logic as here (`shared/mcp/`). The rest of this step is the tab's own requests (`/api/llm/request`). The tool loops run on the server (`server/src/llm/`): a tool call becomes an `mcpTool` callback of `/api/llm/request`, which the tab answers with `callTool`, and a remembered call (`rememberToolUsage`) is stored in the tab by `encodeToolCall` from the request's `toolRecord` event; the tab sends the records a prompt's markers name with the request.
4. The adapter recurses.

- The v3 database setters apply key by key: a `MutationValidationError` warns and keeps that key's old value while the later keys still run; a gone target and any unexpected error propagate to the plugin.
- `GoogleSearchClient.initializeCredentials` refuses a missing, cancelled, or blank API key or engine id before anything is written, and trims accepted values before `googleSearchCredentials` is saved.

## State

- `db.plugins: RisuPlugin[]`: name, script, version, arguments, `realArg`, `enabled`, `allowedIPC`, update URL. Saved as the `plugins` resource.
- Plugin storage:
  - `pluginStorage` is saved data in `db.pluginCustomStorage` (the `pluginStorage` resource), written only through `pluginStorageStore.svelte.ts` (a settings record: each write queues its save once, `records.svelte.ts`). It uses the reserved `_pluginStorage` sub-object, and `setItem` JSON-normalizes values (throws on BigInt). The top level holds the non-`allowedDbKeys` properties written through `setDatabase`/`setDatabaseLite`.
  - `getLocalPluginStorage()` (`SafeLocalPluginStorage`) is saved too, under the reserved `_safeLocalPluginStorage` sub-object of `pluginCustomStorage` (it was browser-local before Phase 1; old browser values are imported at boot). Values must be plain JSON (`isJsonValue`); anything else throws `TypeError` and changes nothing. `setItem(key, undefined)` stores `null`. Any string is a key, `__proto__` included (the module rebuilds the dictionary for it, and the save adapter serializes `pluginStorage` straight from the proxy so the key reaches the server).
  - `safeLocalStorage` (`SafeLocalStorage`) stays device-local (`localStorage` `safe_plugin_*`), as documented for plugin authors.
- v3 permission grants live in the server-owned `pluginPermissions` resource, outside the settings records: `grants` keyed by `<sha256 of the script>_<permission>`, `lastGrantTime` keyed by `<plugin name>_<permission>_lastGrantTime`. Only `getPluginPermission` (host consent) adds to it; no plugin API, `getDatabase` snapshot, `setDatabase`/`setDatabaseLite`, or `pluginCustomStorage` write can reach it. The script hash is taken from the script the plugin was loaded with, and answers are cached per plugin and permission for the page load (cleared on unload). The permission names are `fetchLogs`, `db`, `mainDom`, `replacer`, `provider`, `sendChat`, `inlay`.

## Coupling

- Plugins depend on `database.svelte.ts`, `globalFetch`/`fetchNative`, assets, `transformClient.ts`, model types, `ttsHooks`, theme functions, UI stores, alerts, `pluginmcp`.
- Plugin consumers: `bootstrap.ts`, `PluginSettings.svelte`, `globalApi.svelte.ts`, `modellist.ts` (`customV3ProviderMetaStore`). Hook-registry (`pluginHooks.ts`) consumers: `BotSettings.svelte` (custom providers), `request.ts`, `transformClient.ts`, `jobChannel.ts` (a job's callbacks), `generationJobs.ts` (`registeredHooks`), `tokenizer.ts`.
- MCP consumers: `request.ts` and the provider adapters, `PlaygroundMCP.svelte`, `IrisModal.svelte`/`iris.ts`.

## Invariants

- The plugin's internal `name` is its identity. Updates must not change it, because permission hashes, IPC allowlists, storage, and arguments are keyed by it.
- Only API 3.0 exists. Plugins run only inside the iframe; nothing executes plugin code in the main document.
- v3 calls are async RPC. Nested classes and callbacks inside values are unsupported. Streams need MessagePort credit/cancel, and `terminate` must close them.
- Main-document DOM access requires the v3 `getRootDocument` permission plus the Safe wrappers.
- Any new v3 UI or hook must call `addPluginUnloadCallback` and must sanitize external HTML and URLs.
- Tool names are resolved globally, first match wins. Adapters usually keep only text content.
- A plugin or MCP write goes through a mutation module (`characterStore.svelte.ts`, `collectionStore.svelte.ts`, `pluginStorageStore.svelte.ts`, the chat module); a new host setter or tool never writes a record or a chat directly. A refused value warns (plugins) or answers an error (MCP) and changes nothing.
- A hook runner captures the call context before its first await and passes it to every hook it calls; a new selection-dependent host function reads `currentContext` on its first line.
- An MCP write tool re-resolves its record by the id captured before the consent prompt, and builds its patch synchronously after that lookup.
- v3 plugin storage accepts JSON data only, at most 256 levels deep (`requireJsonData`); a refused value leaves the stored one unchanged.
- `changeColorScheme` with an unknown name changes nothing: neither the active scheme nor its stored name.
- The v3 `sendChat` refuses ("A chat is already in progress") while another send runs (`doingChat`), from a hook too.
- `risu-set-module-info` checks every recognized field's type before it writes any field or `enabledModules`.
- `updateModule` validates a detached patched copy, then applies the patch to the live module in place, so a plugin's or an editor's retained module reference stays current.

## Recipes

- Add a v3 API function:
  1. Implement it in `v3.svelte.ts:makeRisuaiAPIV3`. Nested objects need flat host functions plus `_getAliases`. Constants go in `_getPropertiesForInitialization`.
  2. Declare it in `risuai.d.ts:RisuaiPluginAPI`.
  3. Document it in `plugins.md`.
  4. Verify with a real v3 plugin, including the callback and error paths.
- Add plugin metadata: `importPlugin`, `RisuPlugin` (`shared/plugins.ts`), `PluginSettings.svelte`, `risuai.d.ts` comments, and `plugins.md`.
- Add an internal MCP server: subclass `MCPClientLike` (`getToolList`, `callTool`), add a switch case in `mcp.ts:initializeMCPs`, and optionally add a choice to `importMCPModule`.
- Change the tool loop: `mcp.ts` `getTools`/`callTool` plus every server adapter (`server/src/llm/openAI/requests.ts`, `openAI/responses.ts`, `google.ts`, `anthropic.ts`) and the callback leg (`server/src/llm/requests.ts`, `src/ts/process/request/transport.ts`).

## Tests

- `src/ts/process/mcp/risuaccess/tests/modules.test.ts`: property-based and snapshot tests of the module read tools.
- `risuaccess/tests/characters.test.ts` and `moduleWriters.test.ts`: every character and module write tool over the real save adapter and server store: the target by id when not selected, denial, refused patches, the consent gap (a replacement, a type change, or a removal while the prompt is open), and the module info field types. `mcp/tests/mcpWriters.test.ts`: `importMCPModule`, the OAuth refresh registration, and the Google credential prompt.
- `server/src/tests/llmProviderAdapters.test.ts` and `llmResponsesApi.test.ts`: the server adapters' tool loops (OpenAI-compatible, the Responses API buffered and streaming, Google), with the tool calls faked; the Anthropic tool loop is not pinned.
- `src/ts/process/mcp/tests/toolCallStore.test.ts`: `encodeToolCall` storing with the request's chat (`mergeChatMeta`) and nothing without one; `decodeToolCall` reading the chat (a copy), both marker forms, a missing chat or a former browser-store marker not found, and prototype names not found.
- `src/ts/process/mcp/tests/mcpLeases.test.ts`: per-call client sets leased in both initialization orders with an ambient initialization between, identical tool names resolving per chat, a concurrent initialization sharing one client, destruction deferred while leased, and release on a failed listing.
- Slice 12a: `mcpWriters.test.ts` also covers `readyTabClient` (one instance and one handshake for concurrent first uses, `initializeMCPs` taking it, its cleanup dropping only the reference), `phase5BaselineDefects.test.ts` the fixed OAuth refresh, and `src/ts/storage/tests/collectionStore.test.ts` `addAuthRefresh` replacing a server's entries.
- `src/ts/plugins/apiV3/pluginStorage.test.ts`: v3 `pluginStorage` isolation under `pluginCustomStorage._pluginStorage`, JSON normalization, and the BigInt rejection. It captures the API object by mocking `SandboxHost`.
- `src/ts/plugins/plugins.test.ts`: `importPlugin` acceptance/rejection by `//@api` tokens, and `loadPlugins` clearing the hook registries before loading only enabled `'3.0'` plugins.
- `src/ts/plugins/apiV3/hostApi.test.ts`: `setDatabase`/`setDatabaseLite` into `pluginCustomStorage`, the per-key refusals, the `personas` normalization, and the `_*SafeLocalStorage` aliases called detached. `hostApiRouting.test.ts`: every routed key to its mutation, the per-key refusal warnings, the late keys, the installed plugins kept. `hostApiChats.test.ts`: the getters' detached legacy shape with `chatPage`, `getDatabase` with every character's chats, `getChatFromIndex` after a change or a deletion during its load, `setChar` (fields, an omitted chat deleted but never the last, `chatPage` selecting), pins released after a refusal, `setDatabaseLite` applying at once without `characters` and after the load with them, and a character deleted during the list's load skipped. `v3SavedWrites.test.ts`: the routed writes reach the server. `v3SetDatabase.test.ts` and `v3SetPersonas.test.ts`: the setters' writes into the selected preset and persona, the install prompt awaited first, and `selectedPersona` applied after `personas`. Slice 9b adds to `hostApiChats.test.ts`: the deletion and `setDatabaseLite` cases crossing a real gated load, a getter on an unloaded character (one read, complete, pins released), `setChar` after an eviction (a `meta` op, no create; an omitted unloaded chat deleted through the order), and a character replaced under the same ids during a setter's or getter's load refused.
- `src/ts/plugins/apiV3/pluginContext.test.ts` and `pluginContextSaved.test.ts`: the handoff and the per-instance stacks; a captured context's persona falling back to the selected one when its bound persona is gone, and to the first when the selection names none; inside a hook after the selection moved, `getCharacter`/`setCharacter`, `getChar`, the two index getters, `getDatabase`/`setDatabase`/`setDatabaseLite` on the hook's preset, `sendChat`, `parseRisuChat` (the hook's character and chat ref to the parser, and the `processRegex` script path with the hook's context), `runLLMModel` (`chatRef` and `pluginContext` on the request, the plugin-model block unless `allowPlugins`), and `getCurrentLorebookEntries` (distinct character, chat, and module lore of the hook's chat); `PluginTargetGoneError` from every chat-bound function; the runners' handoff; unload; and the saved result.
- `src/ts/plugins/pluginSafeClass.test.ts`: `isJsonValue` and `SafeLocalPluginStorage` over the `pluginStorage` record: clones both ways, falsy values, `undefined` as `null`, the `TypeError` for non-JSON values, and `__proto__` as an ordinary key.
- `src/ts/plugins/apiV3/permissionStore.test.ts`: the grants record over the fake resource server: load, append-only merges, newest grant time, conflict re-read and merge, a create that lost to another tab, serialized calls, prototype-named keys, 412 and failure propagation. Live updates: `refreshPluginPermissions` reads a newer revision and skips a held one (this tab's echo), loses no grant queued ahead of it, keeps a newer copy the tab came to hold during its read, and forgets the grants of a deleted record.
- `src/ts/plugins/apiV3/permissions.test.ts`: `getPluginPermission` through the captured API (`SandboxHost` mocked, `permissionStore` mocked): a grant answers one permission of one plugin, consent recorded under the (script hash, permission) key and cached, denial cached per permission, the hash of the script captured at load rather than the database copy, consent kept when saving fails, answers dropped on unload, and the three-day re-confirmation of periodic permissions.
- Stop D fixes (13d): `src/ts/process/mcp/tests/mcplib.test.ts` (the tab's `MCPClient`: `connectSSE` framing and dispatch order, the session id from an event-stream or JSON `initialize` sent on later requests, the rotated refresh token twice with the client recreated and kept for a missing, empty, or non-string rotation or a failed refresh, retirement by `destroy()` against the 404 and 401 resets); `src/ts/process/mcp/tests/graphmemHost.test.ts` (the tab's graph memory host with the real `HypaProcesser`: a fresh-chat write then a ranked read, a cold then warm cache); `server/src/tests/mcpSse.test.ts` (`shared/mcp/sse.ts`: every line end split at every byte pair with empty chunks at the exact bound, CR at the end, the bound's byte count, an event before an oversized one, many small events, split UTF-8, field parsing).
- Not tested: the sandbox RPC, hot reload, provider cleanup, filesystem tools; the tab's remote MCP stream cleanup (a recorded hazard).
- Not tested: a cancellation while the job channel's dynamic MCP module import is pending (the dispatcher checks `stillWanted` only after the import).

## Known Hazards

- `loadV3Plugins` unloads the running plugins with `v3PluginInstances.map(...)` while each `unloadV3Plugin` splices that array synchronously, so with two or more running plugins every other one is skipped and then reported as "already running" when it is loaded again (it keeps its old script). Pre-existing; the boot call starts from an empty list. `permissions.test.ts` works around it (`unloadAll`).
- The declarations and runtime disagree:
  - `risuFetch` and `setChatPanel` are implemented but not declared.
  - The arity of `saveSecretHeader` differs.
  - The `SafeDocument.createElement` declarations are synchronous.
- Plugin reload only resets the registries in `clearPluginHooks`. `providerOptions`, `customProviderStore`, and `customV3ProviderMetaStore` are never reset, so reloading can leave duplicate provider entries. (An unloaded plugin's replacers and script handlers are removed, and its pending callbacks reject.)
- `filesystemclient.ts` advertises `fs_watch_directory` but has no dispatch for it.
- Remote MCP, in both clients (`mcplib.ts` and the server's port): a 404 with a session or a 401 with a token resets the session and repeats the request once without them (the call after that handshakes again).
- A rotated refresh token is stored as a whole-collection `authRefreshes` edit from the tab (and the server job's write to the same collection is not hydrated into the tab): another tab or device writing the collection at the same time can make the tab's write conflict and be discarded, and the next refresh then sends a token the server may have spent (a full login follows).
- `mcplib.ts` `connectSSE` keeps an ended stream in `sses` with its reader locked, and a stream that ends or fails without the answer leaves that request pending (its listener stays; a read error is not caught). The server's client cancels the reader and settles the request.
- A server job's remote MCP requests leave from the server's host, not from the browser: a URL that only the browser reaches (its own `localhost`, a userscript or cookie session) does not work for a job, and a module's MCP URL reaches whatever the server's host reaches, loopback and private addresses included.
- `internal:fs` for a server job asks for the directory inside a callback, after the send's click: the browser may refuse the picker without a user gesture (the browser path calls it after awaits too). The OAuth page of a job's remote server is opened by an `openURL` notice, which a popup blocker may stop.
- Consented capabilities reach further than their names suggest (never reviewed): `mainDom` `SafeElement.addEventListener` listens on `document` and forwards keys, so a plugin could observe typing in the password or credential prompts; `mainDom` also allows document-wide queries and mutation; `nativeFetch` lets a plugin choose its request headers; the RPC dispatcher in `factory.ts` looks callables up without an explicit allowlist.
- The call context attributes by plugin instance, not by call: two hooks of one plugin in flight resolve to the innermost, a hook that never settles keeps its context, and a plugin's own timers and UI callbacks see an ambient context while one of its hooks is in flight. Exact attribution needs a correlation id in the sandbox RPC. Memory summarization and image generation still run their plugin hooks against the tab's selection.
- `setDatabaseLite({ plugins })` replaces the installed list without the install confirmation that `setDatabase({ plugins })` asks for (pre-existing).
- The plugin `setDatabase`/`setDatabaseLite` apply `personas` through `setPersonas` (`normalizePersonas`; a non-list is refused) and apply `characterOrder` and `selectedPersona` last, whatever the object's key order. The preset fields they set land in the hook's preset, else this client's selected one, and `selectedPersona` (an index) selects on this client only. `setDatabase` preflights every plugin and awaits the install prompt before it assigns anything; a `characters` list keeps the mirror's order and appends new characters.
- The character records hold no chats: the plugin getters build the legacy shape at the boundary (`withChatsCopy`: the character with its chats and `chatPage`). `getChar`/`getCharacter`, `getCharacterFromIndex`, and `getDatabase` with `characters` pin the characters' chats, await `loadChats`, and copy from the chat module (this loads every chat a getter copies, so `getDatabase` with `characters` reads every chat that is not loaded, the cost of a full boot read per call; the chats are evicted again afterwards. It reads through the store, not detached: unsaved local changes are in the copy and no save has to succeed first). Every target is checked again right before the copy, so a chat added meanwhile is loaded too; `getChatFromIndex`, `setChatToIndex`, `parseRisuChat`, and `sendChat` capture their chat by id first and await `ensureChatLoaded`. The setters (`setChar`/`setCharacter`, `setCharacterToIndex`, `setDatabase`/`setDatabaseLite` with `characters`) capture their targets, pin and load the chats, then apply synchronously as before; they now return Promises (the bridge always awaited them).
- Plugins hand back whole objects, but chats are saved as changes (`persistence.md`). `applyPluginCharacter`/`applyPluginCharacters` (`v3.svelte.ts`) write a character's own fields and pass its `chats` to `reconcileCharacterChats`: a chat with a known id is diffed against the chat as it is at the call and applied (`applyChatResult`: the plugin's copy wins wherever it differs, so a stale copy overwrites edits made after the plugin read it), a chat without an id or with a new one is created, a chat left out is deleted (never the last one), the list order becomes the chat order, and a supplied `chatPage` selects that chat in this tab. `setChatToIndex` diffs the given chat against the current one the same way. A change that touches a message being generated skips that chat with a console warning, a character that is generating is neither replaced (another `chaId` at its index) nor removed (left out of a `characters` list), and a `characters` list with duplicate `chaId` values is refused as a whole; `removeChar` refuses a permanent delete of it too. `sendChat` appends through the module. New setters go through the same functions; never assign `chats` or `chatPage`.
- A plugin setter's non-null section value is not normalized on the client: the server normalizes its copy, but the batch answer carries revisions only, so the writing tab keeps the value as written until a reread or a live update (`persistence.md`).
- A plugin call that adds a character and also passes `characterOrder` without the new id: the order is written after the add and overwrites the add's repair, so the id is missing from the order until the next `checkCharOrder`.
- The `bodyIntercepter`, a custom `tokenizerFunc`, and the TTS pre- and postprocessors run without a captured plugin context; selection-dependent host calls from them use the tab's current selection, not a hook target.
- The plugin `setDatabase` and `setDatabaseLite` are async: they wait for the reconciled characters' chats to load (and `setDatabase` for the plugin install prompt) before applying, and outside a hook a forwarded preset field lands in the preset selected at that point, not at the call. The selection can change meanwhile, including its repair moving a gone preset selection to the first preset (`hostApiRouting.test.ts` selects `gone` again before its second call for that reason).
- `unloadV3Plugin` waits up to one second after the unload callbacks before `SandboxHost.terminate`; a plugin's pending async work can still register a hook in that window.
- A plugin provider whose model descriptor fails `isModelDescriptor` makes the generation's hook list fail with HTTP 400 on the server, although the tab registered it without complaint.
