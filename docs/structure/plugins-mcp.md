# Plugins (Legacy v2.1 and v3 Sandbox) and MCP Tools

## Scope

- Owns:
  - plugin install, metadata parsing, and persistence,
  - legacy v2/v2.1 main-document execution,
  - the v3 iframe sandbox RPC and host API,
  - plugin permissions, plugin storage, plugin-provided AI providers, hooks, and UI extensions,
  - the MCP client registry, the internal MCP servers, and tool dispatch.
- Paths:
  - `src/ts/plugins/*` (`plugins.svelte.ts`, `pluginSafety.ts`, `pluginSafeClass.ts`, `migrationGuide.md`, `apiV3/{factory.ts,v3.svelte.ts,risuai.d.ts,developMode.ts,transpiler.ts}`)
  - `plugins.md` (the plugin author guide)
  - `src/ts/process/mcp/*` (including `risuaccess/`)
  - `src/lib/Setting/Pages/PluginSettings.svelte`
  - `src/lib/Others/{PluginAlertModal,PluginDefinedIcon}.svelte`
  - `src/lib/Playground/PlaygroundMCP.svelte`
  - `public/plugin_start.7z` (the starter template, binary)
- Not here:
  - The provider request loop that calls tools → `llm-requests.md`.
  - TTS hook internals → `media-aux.md`.

## Files

Plugins:

- `plugins/plugins.svelte.ts`: plugin install, loading, and the legacy API.
  - `RisuPlugin` (the persisted shape).
  - `importPlugin`: parses the `//@name`, `//@api`, `//@display-name`, `//@arg`/`//@risu-arg`, `//@link`, `//@update-url`, `//@version`, `//@allowed-ipc` headers, then transpiles TypeScript.
  - `loadPlugins`: splits the enabled plugins by version.
  - `loadV2Plugin`: `new Function` in the main document, after `checkCodeSafety`.
  - `getV2PluginAPIs`, `pluginV2` (the hook and provider registries), `customProviderStore`, `handlePluginInstallViaPlugin`.
- `plugins/pluginSafety.ts` `checkCodeSafety`: an Acorn rewrite of the dangerous globals used by v2.1.
- `plugins/pluginSafeClass.ts`: `SafeLocalStorage`, `SafeLocalPluginStorage`, `SafeIdbFactory`, `SafeDocument` (tag whitelist).
- `plugins/apiV3/factory.ts` `SandboxHost`: sets the iframe sandbox and CSP, writes the RPC bridge `GUEST_BRIDGE_SCRIPT` into the guest, and relays calls.
  - Message types: `CALL_ROOT`/`CALL_INSTANCE` → `RESPONSE`.
  - Handles callbacks, remote references (`__classType='REMOTE_REQUIRED'`), abort signals, and MessagePort streams.
- `plugins/apiV3/v3.svelte.ts`: the v3 host API.
  - `makeRisuaiAPIV3`: the host implementation of the `risuai` global.
  - `loadV3Plugins`, `executePluginV3`, `getV3PluginInstance`.
  - `customV3ProviderMetaStore`: `pluginmodel:::` models.
  - Permissions, runtime `SafeElement`, unload callbacks.
- `plugins/apiV3/risuai.d.ts`: the public v3 API declarations (`RisuaiPluginAPI`, `MCPToolDef`, ...).
- `plugins/apiV3/developMode.ts` `hotReloadPluginFiles`: polls the File System Access API.
- `plugins/apiV3/transpiler.ts` `pluginCodeTranspiler`: Sucrase.

MCP:

- `mcp/mcp.ts`: the client registry and tool dispatch.
  - `initializeMCPs`: sets up internal, `plugin:`, and remote clients. A `stdio:` entry with `url` is treated as remote; one with `command`/`args` is rejected (`stdio MCPs are not supported`).
  - `MCPs`, `callOnlyMCPs`.
  - `getMCPTools`, `getTools`, `callTool`, `callMCPTool`.
  - `importMCPModule`.
  - `encodeToolCall`/`decodeToolCall`: remembered calls in LocalForage `mcp-tool-calls`.
- `mcp/mcplib.ts` `MCPClient`: remote JSON-RPC over streamable HTTP or SSE, OAuth, sessions, pagination. Protocol versions `2025-03-26`/`2024-11-05`.
- `mcp/internalmcp.ts` `MCPClientLike`: base class for local clients.
- Local clients:
  - `filesystemclient.ts`: File System Access.
  - `googlesearchclient.ts`: `google_search`, `google_search_images`.
  - `dice.ts`.
  - `graphmem.ts`: chat variable `graphmem_graph` plus `HypaProcesser`.
  - `aiaccess.ts`: `runLLM` → `requestChatData`.
- `mcp/pluginmcp.ts`: `registerMCPModule`/`unregisterMCPModule` and `registeredCustomPluginMCPs`. IDs must start with `plugin:`.
- `mcp/risuaccess/`: `RisuAccessClient` with `CharacterHandler`, `ChatHandler`, and `ModuleHandler`. Tools that read and write characters, lore, regex, Lua, and modules. Writes go through a `promptAccess` confirmation.

## Flows

Plugins:

1. `bootstrap.ts:loadData` → `loadPlugins`:
   - Saved `2`/`'2.1'` → `loadV2Plugin`.
   - `'3.0'` → `loadV3Plugins`.
2. `executePluginV3` builds a hidden iframe, then `new SandboxHost(makeRisuaiAPIV3(...))`, then `host.run(code)`.
3. Hook entry points in the host:
   - `processScriptFull` iterates `pluginV2.edit*`.
   - `requestChatData` runs the before/after replacers, and `requestPlugin` for providers.
   - `sendChat:runChatOutputListeners`.
   - `globalFetch` runs `bodyIntercepterStore`.
   - TTS hooks via `ttsHooks.ts`.
4. UI extensions push into the rune arrays in `stores.svelte.ts` (`additionalSettingsMenu`, `additionalChatMenu`, `chatPanelStore`, ...) and must register cleanup with `addPluginUnloadCallback`.

MCP:

1. `getTools` collects the schemas.
2. Provider adapters (OpenAI Chat/Responses, Google, Anthropic) run model tool calls.
3. `callTool` dispatches by tool name, first match wins, and the result is appended.
4. The adapter recurses.

## State

- `db.plugins: RisuPlugin[]`: name, script, version, arguments, `realArg`, `enabled`, `allowedIPC`, update URL. Saved in the `plugins` save block.
- Plugin storage:
  - `pluginStorage` is save-file data in `db.pluginCustomStorage` (the `pluginStorage` save block). v2.1 uses its top level, shared with v2.1 `getDatabase` custom properties. v3 uses the reserved `_pluginStorage` sub-object, and `setItem` JSON-normalizes values (throws on BigInt).
  - `safeLocalStorage` and `getLocalPluginStorage` are device-local.
- v3 permissions are persisted in LocalForage, keyed by script hash plus permission. The permission names are `fetchLogs`, `db`, `mainDom`, `replacer`, `provider`, `sendChat`, `inlay`.

## Coupling

- Plugins depend on `database.svelte.ts`, `globalFetch`/`fetchNative`, assets, `scripts.ts`, model types, `ttsHooks`, theme functions, UI stores, alerts, `pluginmcp`.
- Plugin consumers: `bootstrap.ts`, `PluginSettings.svelte`, `BotSettings.svelte` (custom providers), `request.ts`, `scripts.ts`, `index.svelte.ts`, `tokenizer.ts`, `modellist.ts`, `globalApi.svelte.ts`.
- MCP consumers: `request.ts` and the provider adapters, `PlaygroundMCP.svelte`, `IrisModal.svelte`/`iris.ts`.

## Invariants

- The plugin's internal `name` is its identity. Updates must not change it, because permission hashes, IPC allowlists, storage, and arguments are keyed by it.
- New installs of API 2.0 and 2.1 are rejected. Saved v2.1 plugins still execute. v3 runs only inside the iframe.
- v3 calls are async RPC. Nested classes and callbacks inside values are unsupported. Streams need MessagePort credit/cancel, and `terminate` must close them.
- Main-document DOM access requires the v3 `getRootDocument` permission plus the Safe wrappers.
- Any new v3 UI or hook must call `addPluginUnloadCallback` and must sanitize external HTML and URLs.
- Tool names are resolved globally, first match wins. Adapters usually keep only text content.

## Recipes

- Add a v3 API function:
  1. Implement it in `v3.svelte.ts:makeRisuaiAPIV3`. Nested objects need flat host functions plus `_getAliases`. Constants go in `_getPropertiesForInitialization`.
  2. Declare it in `risuai.d.ts:RisuaiPluginAPI`.
  3. Document it in `plugins.md`.
  4. Verify with a real v3 plugin, including the callback and error paths.
- Add plugin metadata: `importPlugin`, `RisuPlugin`, `PluginSettings.svelte`, `risuai.d.ts` comments, and `plugins.md`.
- Add an internal MCP server: subclass `MCPClientLike` (`getToolList`, `callTool`), add a switch case in `mcp.ts:initializeMCPs`, and optionally add a choice to `importMCPModule`.
- Change the tool loop: `mcp.ts` `getTools`/`callTool` plus every adapter (`openAI/requests.ts`, `openAI/responses.ts`, `google.ts`, `anthropic.ts`). Update `requests.responses.test.ts`.

## Tests

- `src/ts/process/mcp/risuaccess/tests/modules.test.ts`: property-based and snapshot tests.
- `requests.responses.test.ts`: the tool loop, with `callTool` mocked.
- `src/ts/plugins/apiV3/pluginStorage.test.ts`: v3 `pluginStorage` isolation under `pluginCustomStorage._pluginStorage`, JSON normalization, and the BigInt rejection. It captures the API object by mocking `SandboxHost`.
- Not tested: the sandbox RPC, permissions, v2 safety, hot reload, provider cleanup, remote MCP, filesystem tools.

## Known Hazards

- `migrationGuide.md` claims defaults such as "missing `@api` means 2.1". The code defaults to 2.0 and picks the first recognized version token. Trust the code.
- The declarations and runtime disagree:
  - `risuFetch` and `setChatPanel` are implemented but not declared.
  - The arity of `saveSecretHeader` differs.
  - The `SafeDocument.createElement` declarations are synchronous.
- v3 provider metadata is appended and never removed, so reloading plugins can duplicate provider models.
- `pluginAlertModalStore` is never written, so `PluginAlertModal` never opens.
- The v2.1 safety checker does not block execution, and it appends a generic warning to every result.
- `filesystemclient.ts` advertises `fs_watch_directory` but has no dispatch for it.
