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
  - `src/lib/Setting/Pages/PluginSettings.svelte`, `PluginDataSettings.svelte`
  - `src/lib/Others/PluginDefinedIcon.svelte`
  - `public/plugin_start.7z` (starter template)
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
  `hotReloadPluginFiles`, `databaseAccessRecorderScript`. `src/ts/plugins/apiV3/transpiler.ts`: `pluginCodeTranspiler`.

### Sandbox host

- `src/ts/plugins/apiV3/factory.ts`: sandbox RPC (`SandboxHost`, module header); `run`, `GuestStartup`, `startup`,
  `isIdle`, `onActivityChanged`, `terminate`, `UNREAD_PLUGIN_STREAM_TIMEOUT_MS`, `deserializeArgs`,
  `reconstructStreamsFromPorts`.

### Host API

- `src/ts/plugins/apiV3/v3.svelte.ts`: host API (`makeRisuaiAPIV3`; module header). `risuai.d.ts` declares the `risuai`
  global (`RisuaiPluginAPI`).
- Lookup in `v3.svelte.ts`: `addProvider` (permission per call), `nativeFetch` (its response body is bridged:
  [Sandbox host](#sandbox-host)), `onStorageDiscarded`, `parseRisuChat`, `runLLMModel`, `loadV3Plugins`,
  `unloadV3Plugin`, `pluginWorkIdle`, `onPluginWorkChange`, `customV3ProviderMetaStore`.
- Database setters: `setPluginDatabase`, `setPluginDatabaseLite`, `applyPluginDatabaseWithChats`, `applyPluginKey`,
  `pluginKeyOrder`, `warnRefused` (`[Plugin] Refused ...`). Model roots go to `writeModelRoot`
  ([compatibility model-root write rules](llm-requests.md#compatibility-model-root-writes)); a refusal warns
  `[Settings] Refused ...`. Preset fields go to the hook's ids, else `settingsWriteScope` taken at call start; a target
  gone by the apply refuses the whole call.

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

- Only a change from the running signature counts; `loadSignature`'s JSDoc defines its fields and order.
- Idle (`pluginWorkIdle`, `src/ts/plugins/apiV3/v3.svelte.ts`; `onPluginWorkChange` hears changes) means all of:
  - no send of this tab (`anyLocalSend`);
  - no job of this tab that may still call its hooks (`generationPluginWorkActive`, `src/ts/network/generationJobs.ts`):
    a job calls the hooks it listed at creation until it ends, so a reload between two callbacks would fail the later
    one as an unregistered hook;
  - no host-side hook invocation running (every wrapped hook, and a provider from before its permission prompt);
  - every sandbox idle (`SandboxHost.isIdle`).
- Idle scheduling and final checks: `queueDeferredCheck` JSDoc. Work that never ends defers reload
  ([Limitations](#limitations)).

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
  - `db.pluginCustomStorage` (`pluginStorage` record): `_ownedPluginStorage` by plugin name, `_pluginStorage` legacy
    read-through until claim-on-write or owner `clear()`; U+0000 names use legacy storage (module header). Shared
    top-level custom keys are non-`allowedDbKeys` keys of `setDatabase`/`setDatabaseLite`; replacement keeps omitted
    reserved dictionaries. `setItem` JSON-normalizes values (BigInt throws).
  - Plugins share one record. Writes resolve when queued. Concurrent tab/device writes are
    [merged key by key](resource-sync.md#record-merge); `onStorageDiscarded` reports each listener's own lost keys and
    legacy keys.
  - Shared `getLocalPluginStorage()` (`SafeLocalPluginStorage`) is saved under `_safeLocalPluginStorage`; boot imports
    legacy browser-local values. JSON validation: `pluginSafeClass.ts` `SafeLocalPluginStorage`, `isJsonValue`.
  - String-key rules and the owner key cache (`pluginStorageRevision`): `pluginStorageStore.svelte.ts` module header;
    the save adapter [preserves `__proto__`](resource-sync.md#invariants).
  - `safeLocalStorage` (`SafeLocalStorage`) stays device-local (`localStorage` `safe_plugin_*`).
- v3 permission grants live in the server-owned `pluginPermissions` resource (`permissionStore.ts`; its header names the
  only writers), outside the settings records: `grants` keyed by `<sha256 of the script>_<permission>`, `lastGrantTime`
  by plugin name and permission, `resets` by plugin name.
  - The script hash is taken from the script the plugin was loaded with, and answers are cached per plugin and
    permission for the page load (cleared on unload).
  - Only the settings page revokes (`resetPluginPermissions`, `removeOrphanPluginPermissionGrants`); a revoked grant
    drops its cached answer in every tab. A reset always bumps `resets`: every tab drops the plugin's answers, and a
    prompt open across it (or an unload) answers `false`.
- `PluginDataSettings.svelte` (component contract): namespace sizes, owned keys by owner; legacy keys assigned or
  deleted through the mutations above.

## Coupling

- Plugin consumers: `bootstrap.ts`, `PluginSettings.svelte`, `globalApi.svelte.ts`, `modellist.ts`
  (`customV3ProviderMetaStore`). Hook-registry consumers: `ModelSettings.svelte`, `request.ts`, `transformClient.ts`,
  `jobChannel.ts`, `tokenizer.ts`.

## Invariants

- The plugin's internal `name` is its identity: storage, IPC allowlists, arguments and grant timestamps use it; grants
  use script hashes. Updates must keep the name.
- Only API 3.0 exists. Plugins run only inside the iframe, never in the main document.
- RPC values and streams: `v3.svelte.ts` and `factory.ts` module headers.
- A host call's abort controllers live until every response stream finishes (done, error, guest cancel, unread expiry,
  rollback, or termination). A guest callback's mirrored controllers likewise live until every returned stream ends, so
  a host abort still reaches the plugin and requests using its signal after the callback returns. Calls and callbacks
  that throw or return no streams release their controllers at once. Termination closes both bridges.
- The sandbox host never logs an RPC message or its answer: their arguments carry the plugin's `nativeFetch` headers
  (API keys) and bodies.
- Main-document DOM access requires the v3 `getRootDocument` permission plus the Safe wrappers.
- Any new v3 UI or hook must call `addPluginUnloadCallback` and sanitize external HTML and URLs.
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
- `changeColorScheme` with an unknown name changes neither the active scheme nor its stored name.
- A `SafeElement` listener hears only events reaching its element through DOM propagation; `SafeDocument` from
  `getRootDocument` registers on `document`. Each registration keeps its target, type and options; removal by id and
  reload teardown replay that record whatever the caller passes to `removeEventListener`.
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
  each new or changed plugin. `setDatabaseLite` drops `plugins` before it applies anything; the call's other keys still
  apply.
- `risu-set-module-info` checks every recognized field's type before it writes any field or `enabledModules`.
- `updateModule` validates a detached patched copy, then applies the patch to the live module in place, so a plugin's or
  editor's retained module reference stays current.

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
- `slow`: none.
- `e2e/transformGolden.spec.ts`: edit hooks.
- `e2e/settingsPages.spec.ts`: the page.
- `e2e/pluginSandbox.spec.ts`: real-browser sandbox isolation and detached database reads.
- `SandboxHost` stub (`vi.mock` of `./factory`, most of `apiV3/`): the real API object is driven directly.
- `guestBridge.test.ts`: the srcdoc's guest half over a fake window; it still logs its property initialization.
- `sandboxActivity.test.ts`: a real `SandboxHost`, the guest simulated by window messages.
- `databaseAccessRecorder.test.ts`: the developer `getDatabase` recorder in the real srcdoc guest, fake timers.
- `pluginDeferredReload.test.ts`, `pluginSafeBoot.test.ts`: a mocked v3 loader, the idle predicate and safe-boot flag
  controlled.
- `pluginWorkIdle.test.ts`: a controllable sandbox idle flag, the job channel real.
- `storeBackedServer.ts`: the real save adapter over the real server store, for writes and detached reads.
- `getDatabaseDetached.test.ts`: database reads, cache reuse, setter load skipping, and scoped reads (summaries,
  `getChats`) over `StoreBackedServer`.
- `permissionStore.test.ts`: grants over `FakeResourceServer`.
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
  chat at call time (`captureChatBaseline` right before `applyChatResult`), not as the plugin read it. So a change
  another writer made after the plugin's read is overwritten: a changed message field or chat field is set back to the
  copy's value (a `CHAT_META_MERGE_KEYS` map only in the entries that differ), and a message added meanwhile is removed.
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
  hooks registered at that time. Decision: RisuNest Small Wins D4, archive.
- A cancelled hook that never settles keeps plugin `sendChat` refused (`channelCallbacksRunning`), and after the
  server's `CANCELLED_CALLBACK_DRAIN_MS` (60 s) a later job's root callbacks are refused on this tab, both until the
  page reloads; admitting another root while the cancelled hook can still write would let it overlap later work.
  Decision: Per-Chat Send D8, archive.
- A plugin's timers and UI callbacks share the instance's ambient `PluginCallContext`, so they may inherit an in-flight
  hook's context. Exact per-call attribution needs an RPC correlation id. Decision:
  [`pluginContext.ts`](../../src/ts/plugins/apiV3/pluginContext.ts).
- Aux calls (`runLLMModel`, `imggen` prompt requests) made through `channelCall` end with their hook callback; calls
  without that context do not. The send guard accepts its job ids only while the callback runs uncancelled and checks a
  stale context against the chat binding. Decision: Per-Chat Send D8, archive.
- A plugin's ambient context carries its hook callback, but body interceptors have no context, a provider's context ends
  when it returns its stream, and tab `internal:aiaccess` captures chat context without `channelCall`; requests from
  those paths are not ended with the callback. Decision: Per-Chat Send D8, archive.
- A plugin setter's non-null section value is not normalized on the writing tab: the server normalizes its copy, but the
  batch answer carries revisions only, so the tab keeps the value until reread or a live update. Decision: accepted
  mirror-normalization limit in [persistence](persistence.md#known-hazards).
- A plugin call that adds a character and also passes `characterOrder` without the new id: the order is written after
  the add and overwrites the add's repair, so the id is missing from the order until the next `checkCharOrder`.
  Decision: [`pluginKeyOrder`](../../src/ts/plugins/apiV3/v3.svelte.ts).

### Gotchas

- Full character reads use `withChatsCopy`; records hold no chats. Outside hooks, `getDatabase` and `getChats` use
  `withDetachedDatabaseChats`: flush, then shared unloaded reads or `src/ts/plugins/apiV3/detachedChatCache.ts`, never
  installed; held chats stay pinned until the synchronous copy. A fully held page skips the flush. Unsafe copies and
  hooks load (a page, its members: `withHeldChatPage`). A failed flush or read falls back to that loading; after a
  restore halt every such call rejects, a fully held page included.
- `getDatabase(keys, { chats: "summaries" })` reads, flushes, pins, and loads no chat (`chatSummaryList` in
  `src/ts/storage/chatStore.svelte.ts`); every plugin character setter strips `chatSummaries`.
- `getChatFromIndex`, `setChatToIndex`, `parseRisuChat`, and `sendChat` capture their chat by id first and await
  `ensureChatLoaded`. `setDatabase`/`setDatabaseLite` skip loading omitted chats and exact round trips, rechecked before
  applying, else load (`applyPluginDatabaseWithChats` JSDoc). Other character setters capture targets, pin and load,
  then apply synchronously.
- Plugins hand back whole objects, but [chats are saved as changes](chat-store.md#whole-chat-writers).
  `applyPluginCharacter`/`applyPluginCharacters` JSDoc holds reconciliation rules (`reconcileCharacterChats`,
  `applyChatResult`); a chat left out is deleted, never the last one. New setters use these functions, never assign
  `chats` or `chatPage`.
- When a whole-chat diff would change or remove a message being generated (`assertUnlocked`), that chat's update is
  skipped with a warning; a reorder of unchanged messages while it generates drops only the order change.
- Generating-character and duplicate-id refusals: `applyPluginCharacter`/`applyPluginCharacters`; `removeChar` also
  refuses permanent deletion during generation.
- A custom `tokenizerFunc` is never called: tab token counts run on the server, which uses `cl100k_base` for a
  provider's `custom` tokenizer ([LLM requests](llm-requests.md)).
