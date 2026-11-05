# Plugins: v3 Sandbox, Host API, Hooks, Storage, Permissions

## Scope

- Owns:
  - plugin install, metadata parsing, and persistence,
  - the v3 iframe sandbox RPC and host API,
  - plugin permissions, plugin storage, plugin-provided AI providers, hooks, and UI extensions,
  - the plugin reload and the idle rule it waits for.
- Paths:
  - `src/ts/plugins/` (`plugins.svelte.ts`, `pluginHooks.ts`, `pluginSafeClass.ts`) and `src/ts/plugins/apiV3/`
    (`factory.ts`, `v3.svelte.ts`, `pluginContext.ts`, `permissionStore.ts`, `risuai.d.ts`, `developMode.ts`,
    `transpiler.ts`); `v3.svelte.ts`'s projection refresh is structured-memory's
  - `shared/plugins.ts`
  - `plugins.md` (the plugin author guide, at the repository root)
  - `src/ts/storage/pluginStorageStore.svelte.ts`
  - `src/lib/Setting/Pages/PluginSettings.svelte`
  - `src/lib/Others/PluginDefinedIcon.svelte`
  - `public/plugin_start.7z` (the starter template, binary)
- Not here:
  - The MCP client registry, the remote and internal clients, RisuAccess, a plugin's MCP client, and tool dispatch →
    [mcp](mcp.md).
  - The provider request loop that calls tools → `llm-requests.md`.
  - TTS hook internals → `media-aux.md`.

## Files

A module header, component contract, or identifier JSDoc named below holds the contract; other identifiers are lookup
entrypoints.

### Plugin install and registries

- `src/ts/plugins/plugins.svelte.ts`: import and the serialized reload (module header): `importPlugin`, `loadPlugins`,
  `loadPluginsForBoot`, `captureBootGuests`, `reportUnsupportedPlugins`, `loadSignature`, `queueDeferredCheck`,
  `allowedDbKeys`, `handlePluginInstallViaPlugin`.
- `shared/plugins.ts`: `RisuPlugin`. Only `version: '3.0'` loads; a saved entry of another version stays listed and
  `src/lib/Setting/Pages/PluginSettings.svelte` (component contract) marks it "Unsupported API".
- `src/ts/plugins/pluginHooks.ts`: the live hook registries (module header): `pluginHooks`, `clearPluginHooks`,
  `customProviderStore`.
- `src/ts/plugins/apiV3/pluginContext.ts`: a hook's call context, a stack per loaded instance (module header):
  `PluginCallContext`, `capturePluginContext`, `invokeHook`, `currentContext`, `hasReadOnlyContext`,
  `PluginTargetGoneError`.
- `src/ts/storage/pluginStorageStore.svelte.ts`: the only runtime writer of `pluginCustomStorage` (module header).
  `src/ts/plugins/pluginSafeClass.ts`: `isJsonValue`, `SafeLocalStorage`, `SafeLocalPluginStorage`.
- `src/ts/plugins/apiV3/permissionStore.ts`: the `pluginPermissions` grants (module header; [State](#state)).
- `src/lib/Others/PluginDefinedIcon.svelte`: plugin icons (component contract). `src/ts/plugins/apiV3/developMode.ts`:
  `hotReloadPluginFiles`. `src/ts/plugins/apiV3/transpiler.ts`: `pluginCodeTranspiler`.

### Sandbox host

- `src/ts/plugins/apiV3/factory.ts`: `SandboxHost` (module header: the iframe sandbox and CSP, `GUEST_BRIDGE_SCRIPT`,
  the message-source checks, the RPC relay). Lookup: `startup` (`GuestStartup`; safe boot), `isIdle` and
  `onActivityChanged` (the [deferred reload](#deferred-reload)), `terminate`, `UNREAD_PLUGIN_STREAM_TIMEOUT_MS` (an
  unread bridged stream expires at 60 s), `deserializeArgs` and `reconstructStreamsFromPorts` (callback rollback).

### Host API

- `src/ts/plugins/apiV3/v3.svelte.ts`: `makeRisuaiAPIV3` implements the `risuai` global; `risuai.d.ts` declares it
  (`RisuaiPluginAPI`). The module header holds the RPC value rules and hook targeting: a selection-dependent call
  captures `currentContext` before its first await and acts on the hook's targets, else the tab's selection and settings
  views.
- Lookup in `v3.svelte.ts`: `addProvider` (permission per call), `nativeFetch` (its response body is bridged:
  [Sandbox host](#sandbox-host)), `onStorageDiscarded`, `parseRisuChat`, `runLLMModel`, `loadV3Plugins`,
  `unloadV3Plugin`, `pluginWorkIdle`, `onPluginWorkChange`, `customV3ProviderMetaStore`.
- Database setters: `setPluginDatabase`, `setPluginDatabaseLite`, `applyPluginKey` (each key to the mutation module that
  owns it), `pluginKeyOrder`, `warnRefused` (`[Plugin] Refused ...`). The model roots go on to `writeModelRoot`
  ([compatibility model-root write rules](llm-requests.md#compatibility-model-root-writes)); a refusal warns
  `[Settings] Refused ...`. Outside a hook, a preset field lands where the settings views resolve when the waits end
  (the open chat's bound preset, else this tab's selection).

## Flows

### Load and reset

- `bootstrap.ts:loadData` calls `loadPluginsForBoot`, anything else `loadPlugins`; both run these steps.
- Safe boot: while plugins are off for this page load (`safeBootOff("plugins")`, [app-shell](app-shell.md) Safe boot) a
  load returns at once: nothing loads, nothing is reported, the remote listener of the
  [deferred reload](#deferred-reload) is never registered (and a queued deferred reload also checks the flag), so the
  settings toggle, removal, and import save without loading.
- Chain: the hook reset and reload run on the `pluginReload` chain, each caller's enabled list captured before it waits.
  The first load registers the remote `plugins` listener; every load cancels a waiting deferred reload.
- Reset: `clearPluginHooks`, then `loadV3Plugins` with the enabled `'3.0'` plugins: it unloads a snapshot of the
  instances, waits for their callbacks and termination, resets the providers and `customV3ProviderMetaStore` again,
  removes every plugin event listener from its target, and starts the replacements.
- Unload (`unloadV3Plugin`) unregisters each instance's MCP clients (an identifier replaced by another client is kept),
  removes the plugin's replacers and script handlers, and rejects its pending callbacks.
- `loadPluginsForBoot` captures its guests' startup right after `loadV3Plugins` (`captureBootGuests`): `ready` succeeds,
  `failed` or a missing initial instance fails at once, a `stopped` one follows its replacement
  ([app-shell](app-shell.md) Safe boot); `loadPlugins` does not inspect startup.

### Hook entry points

The runners of the hooks that have a chat call each hook through `invokeHook` with the context they captured
(`capturePluginContext`) or were given:

- `editdisplay` and `editprocess` handlers of a render (`src/ts/parser/transformClient.ts`, its module header and
  `handlerSet`) run between the script transform's two calls with read-only `purpose: "transform"`; the results, or a
  handler's error per target, go to `/api/transform/continue`. `runHandlers` bounds the wait without stopping guest
  code, and the handler set's identity is per document, mode, and ordered hook list.
- `requestChatData` runs the before/after replacers, and `requestPlugin` for providers.
- Server jobs: the tab lists its hook names at job creation (`registeredHooks`, `src/ts/network/jobChannel.ts`), and the
  server calls back by name; the registry is read when the callback runs ([network jobs](network-jobs.md)).
- `chatOutput` listeners: a server send's `runChatOutputListeners` (`server/src/prompt/runner.ts`) reaches them through
  the job channel's `chatOutput` callback, with the job's targets.
- MCP listing and tool callbacks: the job channel passes its targets; `request.ts` passes `pluginContext` through
  `getTools`, and `transport.ts` through `callTool` for both the ownership listing and the call. The plugin client
  invokes the wrapped callback synchronously with the context, after registry awaits have finished.

Chat-bound HypaV3 summaries capture and pass their context; server callbacks, including image-view generation, run under
the job targets.

Called directly, without a context, `globalFetch` runs `bodyIntercepterStore`, and `ttsHooks.ts` runs the TTS pre- and
postprocessors: the tab's selection, or an ambient context of the same plugin, applies, not a hook target.

### Deferred reload

A remote `plugins` change (another tab or device; `onRemoteRecordApplied` after a live record, a live patch, or a
conflict reload) reloads the plugins here once plugin work is idle (`queueDeferredCheck`).

- Only a change to the load signature counts (`loadSignature`: each enabled `'3.0'` plugin's name, script, and
  `allowedIPC`, in list order), compared with the plugins running now.
- Idle (`pluginWorkIdle`, `src/ts/plugins/apiV3/v3.svelte.ts`; `onPluginWorkChange` hears changes) means all of:
  - no send of this tab (`anyLocalSend`);
  - no job of this tab that may still call its hooks (`generationPluginWorkActive`, `src/ts/network/generationJobs.ts`):
    a job calls the hooks it listed at creation until it ends, so a reload between two callbacks would fail the later
    one as an unregistered hook;
  - no host-side hook invocation running (every wrapped hook, and a provider from before its permission prompt);
  - every sandbox idle (`SandboxHost.isIdle`).
- Each source notifies on a change toward idle. When idle, one reload is queued on the `pluginReload` chain; it checks
  idleness again right before it clears anything and waits again when work started meanwhile. It loads the list as it is
  then. There is no wait limit or interruption: work that never ends is in [Limitations](#limitations).

### Job owner presence

[Generation channels](server-generation.md#generation-channels) owns presence, deadlines and safe-boundary transfers;
`src/ts/network/jobChannel.ts` documents callback execution and viewer refusal.

- Hooks may run on a worker showing another chat: `getRootDocument` finds no message DOM there. Targets remain the
  job's; device-local keys are the worker's. A delivered callback never runs on a second tab, even if its device sleeps.
- A hidden worker tab answered a hook in 19 ms (`checkJobHandoff.mjs`); Chrome's intensive timer throttling after 5
  minutes hidden, which can delay a hook that waits on a timer, is unmeasured.
- MCP excludes silent owners; a live tab answering pings keeps a long provider call alive. Absence failure saves partial
  text and ends the job. Completed-reply transforms keep text; undelivered listeners run late, delivered ones are
  missed.

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

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/plugins src/ts/storage/tests/{pluginStorageStore,collectionStore}.test.ts src/ts/network/generationJobsPluginWork.test.ts`.
  The MCP clients and tool dispatch: [mcp](mcp.md#tests).
- `slow`: none. `e2e`: `e2e/transformGolden.spec.ts` (edit hooks), `e2e/settingsPages.spec.ts` (the page).
- `SandboxHost` stub (`vi.mock` of `./factory`, most of `apiV3/`): the real API object is driven directly.
- `guestBridge.test.ts`: the srcdoc's guest half over a fake window; it still logs its property initialization.
- `sandboxActivity.test.ts`: a real `SandboxHost`, the guest simulated by window messages.
- `pluginDeferredReload.test.ts`, `pluginSafeBoot.test.ts`: a mocked v3 loader, the idle predicate and safe-boot flag
  controlled. `pluginWorkIdle.test.ts`: a controllable sandbox idle flag, the job channel real.
- `storeBackedServer.ts`: the real save adapter over the real server store, for saved writes. `FakeResourceServer`:
  `permissionStore.test.ts`.
- Browser checks, not in the gate ([test-harness](test-harness.md)): `util/playwright/checkJobProtocol.mjs` (a real v3
  plugin provider answers job callbacks from the sandbox) and `checkJobHandoff.mjs` (hooks move between two tabs).
- Not tested: hot reload, and the remaining sandbox RPC surface.

## Known Hazards

### Issues

- The declarations and runtime disagree:
  - `risuFetch` and `setChatPanel` are implemented but not declared.
  - The arity of `saveSecretHeader` differs.
  - The `SafeDocument.createElement` declarations are synchronous.
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

- The character records hold no chats: the plugin getters build the legacy shape at the boundary (`withChatsCopy`). The
  getters pin the chats, await `loadChats`, and copy from the chat module, so `getDatabase` with `characters` loads
  every chat that is not loaded, and idle chats can be evicted afterwards. It reads through the store, not detached:
  unsaved local changes are in the copy.
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
