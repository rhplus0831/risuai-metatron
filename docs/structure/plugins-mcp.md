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
- `plugins/pluginHooks.ts`: `pluginHooks` (the provider, script-handler, replacer, and chat-output registries), `clearPluginHooks`, `customProviderStore`, and the provider/hook types.
- `plugins/pluginSafeClass.ts`: `SafeLocalStorage`, `SafeLocalPluginStorage`, `setSafeLocalPluginValue` (any key becomes an own key, `__proto__` included), `isJsonValue`, `SAFE_LOCAL_PLUGIN_STORAGE_KEY`, `tagWhitelist`.
- `plugins/apiV3/permissionStore.ts`: the v3 permission grants in the server-owned `pluginPermissions` resource (`loadPluginPermissions`, `hasPermissionGrant`, `getLastGrantTime`, `recordPermissionGrants`).
- `plugins/apiV3/factory.ts` `SandboxHost`: sets the iframe sandbox and CSP, writes the RPC bridge `GUEST_BRIDGE_SCRIPT` into the guest, and relays calls.
  - Message types: `CALL_ROOT`/`CALL_INSTANCE` → `RESPONSE`.
  - Handles callbacks, remote references (`__classType='REMOTE_REQUIRED'`), abort signals, and MessagePort streams.
- `plugins/apiV3/v3.svelte.ts`: the v3 host API.
  - `makeRisuaiAPIV3`: the host implementation of the `risuai` global. Older API names (`getChar`/`setChar`, `getArg`/`setArg`, `risuFetch`, `readImage`, `setDatabase`/`setDatabaseLite`, ...) are implemented by module-level helpers in the same file.
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

1. `bootstrap.ts:loadData` → `loadPlugins` → `clearPluginHooks` → `loadV3Plugins`.
2. `executePluginV3` builds a hidden iframe, then `new SandboxHost(makeRisuaiAPIV3(...))`, then `host.run(code)`.
3. Hook entry points in the host:
   - `processScriptFull` iterates `pluginHooks.edit*`.
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

- `db.plugins: RisuPlugin[]`: name, script, version, arguments, `realArg`, `enabled`, `allowedIPC`, update URL. Saved as the `plugins` resource.
- Plugin storage:
  - `pluginStorage` is saved data in `db.pluginCustomStorage` (the `pluginStorage` resource). It uses the reserved `_pluginStorage` sub-object, and `setItem` JSON-normalizes values (throws on BigInt). The top level holds the non-`allowedDbKeys` properties written through `setDatabase`/`setDatabaseLite`.
  - `getLocalPluginStorage()` (`SafeLocalPluginStorage`) is saved too, under the reserved `_safeLocalPluginStorage` sub-object of `pluginCustomStorage` (it was browser-local before Phase 1; old browser values are imported at boot). Values must be plain JSON (`isJsonValue`); anything else throws `TypeError` and changes nothing. `setItem(key, undefined)` stores `null`. Any string is a key, `__proto__` included (`setSafeLocalPluginValue` rebuilds the dictionary for it, and the save adapter serializes `pluginStorage` straight from the proxy so the key reaches the server).
  - `safeLocalStorage` (`SafeLocalStorage`) stays device-local (`localStorage` `safe_plugin_*`), as documented for plugin authors.
- v3 permission grants live in the server-owned `pluginPermissions` resource, outside `DBState.db`: `grants` keyed by `<sha256 of the script>_<permission>`, `lastGrantTime` keyed by `<plugin name>_<permission>_lastGrantTime`. Only `getPluginPermission` (host consent) adds to it; no plugin API, `getDatabase` snapshot, `setDatabase`/`setDatabaseLite`, or `pluginCustomStorage` write can reach it. The script hash is taken from the script the plugin was loaded with, and answers are cached per plugin and permission for the page load (cleared on unload). The permission names are `fetchLogs`, `db`, `mainDom`, `replacer`, `provider`, `sendChat`, `inlay`.

## Coupling

- Plugins depend on `database.svelte.ts`, `globalFetch`/`fetchNative`, assets, `scripts.ts`, model types, `ttsHooks`, theme functions, UI stores, alerts, `pluginmcp`.
- Plugin consumers: `bootstrap.ts`, `PluginSettings.svelte`, `globalApi.svelte.ts`, `modellist.ts` (`customV3ProviderMetaStore`). Hook-registry (`pluginHooks.ts`) consumers: `BotSettings.svelte` (custom providers), `request.ts`, `scripts.ts`, `index.svelte.ts`, `tokenizer.ts`.
- MCP consumers: `request.ts` and the provider adapters, `PlaygroundMCP.svelte`, `IrisModal.svelte`/`iris.ts`.

## Invariants

- The plugin's internal `name` is its identity. Updates must not change it, because permission hashes, IPC allowlists, storage, and arguments are keyed by it.
- Only API 3.0 exists. Plugins run only inside the iframe; nothing executes plugin code in the main document.
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
- Add plugin metadata: `importPlugin`, `RisuPlugin` (`shared/plugins.ts`), `PluginSettings.svelte`, `risuai.d.ts` comments, and `plugins.md`.
- Add an internal MCP server: subclass `MCPClientLike` (`getToolList`, `callTool`), add a switch case in `mcp.ts:initializeMCPs`, and optionally add a choice to `importMCPModule`.
- Change the tool loop: `mcp.ts` `getTools`/`callTool` plus every adapter (`openAI/requests.ts`, `openAI/responses.ts`, `google.ts`, `anthropic.ts`). Update `requests.responses.test.ts`.

## Tests

- `src/ts/process/mcp/risuaccess/tests/modules.test.ts`: property-based and snapshot tests.
- `requests.responses.test.ts`: the tool loop, with `callTool` mocked.
- `src/ts/plugins/apiV3/pluginStorage.test.ts`: v3 `pluginStorage` isolation under `pluginCustomStorage._pluginStorage`, JSON normalization, and the BigInt rejection. It captures the API object by mocking `SandboxHost`.
- `src/ts/plugins/plugins.test.ts`: `importPlugin` acceptance/rejection by `//@api` tokens, and `loadPlugins` clearing the hook registries before loading only enabled `'3.0'` plugins.
- `src/ts/plugins/apiV3/hostApi.test.ts`: `setDatabase`/`setDatabaseLite` routing into `pluginCustomStorage`, and the `_*SafeLocalStorage` aliases called detached.
- `src/ts/plugins/pluginSafeClass.test.ts`: `isJsonValue` and `SafeLocalPluginStorage` on the real `DBState` proxy: clones both ways, falsy values, `undefined` as `null`, the `TypeError` for non-JSON values, and `__proto__` as an ordinary key.
- `src/ts/plugins/apiV3/permissionStore.test.ts`: the grants record over the fake resource server: load, append-only merges, newest grant time, conflict re-read and merge, a create that lost to another tab, serialized calls, prototype-named keys, 412 and failure propagation.
- `src/ts/plugins/apiV3/permissions.test.ts`: `getPluginPermission` through the captured API (`SandboxHost` mocked, `permissionStore` mocked): a grant answers one permission of one plugin, consent recorded under the (script hash, permission) key and cached, denial cached per permission, the hash of the script captured at load rather than the database copy, consent kept when saving fails, answers dropped on unload, and the three-day re-confirmation of periodic permissions.
- Not tested: the sandbox RPC, hot reload, provider cleanup, remote MCP, filesystem tools.

## Known Hazards

- `loadV3Plugins` unloads the running plugins with `v3PluginInstances.map(...)` while each `unloadV3Plugin` splices that array synchronously, so with two or more running plugins every other one is skipped and then reported as "already running" when it is loaded again (it keeps its old script). Pre-existing; the boot call starts from an empty list. `permissions.test.ts` works around it (`unloadAll`).
- The declarations and runtime disagree:
  - `risuFetch` and `setChatPanel` are implemented but not declared.
  - The arity of `saveSecretHeader` differs.
  - The `SafeDocument.createElement` declarations are synchronous.
- Plugin reload only resets the registries in `clearPluginHooks`. Replacers, `providerOptions`, `customProviderStore`, and `customV3ProviderMetaStore` are never reset, so reloading can leave stale replacers and duplicate provider entries.
- `filesystemclient.ts` advertises `fs_watch_directory` but has no dispatch for it.
- Consented capabilities reach further than their names suggest (to review in Phase 4 of `docs/plan/PLAN.md`): `mainDom` `SafeElement.addEventListener` listens on `document` and forwards keys, so a plugin could observe typing in the password or credential prompts; `mainDom` also allows document-wide queries and mutation; `nativeFetch` lets a plugin choose its request headers; the RPC dispatcher in `factory.ts` looks callables up without an explicit allowlist.
- Plugin setters that change characters (`setChar`, `setCharacterToIndex`, `setChatToIndex`, `setDatabase`/`setDatabaseLite` with `characters`) must mark them for saving (`markCharactersDirty`); a new setter that forgets it loses writes to characters that are not selected.
