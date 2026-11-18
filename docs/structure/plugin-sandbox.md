# Plugins: v3 Sandbox, Host API, Hooks, Storage, Permissions

## Scope

- Install, update, or reload an API 3.0 plugin. For metadata and the public API, see the
  [plugin author guide](../../plugins.md). The starter is `public/plugin_start.7z`.
- Change iframe RPC, permissions, storage, UI extensions, providers, or a hook's chat context. The
  [hook entry points](#hook-entry-points) identify which process invokes each callback.
- For the host's remote command or completion Web Push, see [remote sends](network-jobs.md#remote-send) and
  [completion holds](server-generation.md#completion-holds). For unattended Chrome, see
  [headless host](build-test-platforms.md#headless-host).
- For neighboring dispatch paths see [MCP tools](mcp.md), [LLM requests and interception rules](llm-requests.md#flows),
  [TTS](media-aux.md), and [structured memory](structured-memory/README.md) for `v3.svelte.ts`'s projection refresh.

## Files

A module header, component contract, or identifier JSDoc named below holds the contract; other identifiers are lookup
entrypoints.

### Plugin install and registries

- `src/ts/plugins/plugins.svelte.ts`: import and the serialized reload (module header): `importPlugin`, `loadPlugins`,
  `loadPluginsForBoot`, `captureBootGuests`, `reportUnsupportedPlugins`, `loadSignature`, `queueDeferredCheck`,
  `allowedDbKeys`, `handlePluginInstallViaPlugin`.
- `shared/plugins.ts`: `RisuPlugin`, `PLUGIN_COMPLETION_QUIET_SECONDS`, `pluginCompletionQuietMs`. Only `version: '3.0'`
  loads; a saved entry of another version stays listed and `src/lib/Setting/Pages/PluginSettings.svelte` (component
  contract) marks it "Unsupported API".
- `src/ts/plugins/pluginQuiet.ts`: `waitForPluginsQuiet` ([Activity by plugin](#activity-by-plugin)).
- `PluginSettings.svelte` captures the plugin name before update confirmation, resolves it afterwards, and passes a
  detached record to `updatePlugin`; a removed plugin cancels the update.
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
  `unloadV3Plugin`, `pluginWorkIdle`, `onPluginWorkChange`, `pluginBusy`, `onPluginActivity`,
  `customV3ProviderMetaStore`.
- Database setters: `setPluginDatabase`, `setPluginDatabaseLite`, `applyPluginDatabaseWithChats`, `applyPluginKey`,
  `pluginKeyOrder`, `warnRefused` (`[Plugin] Refused ...`). Model roots go to `writeModelRoot`
  ([compatibility model-root write rules](llm-requests.md#compatibility-model-root-writes)); a refusal warns
  `[Settings] Refused ...`. Preset fields go to the hook's ids, else `settingsWriteScope` taken at call start; a target
  gone by the apply refuses the whole call.

## Flows

### Load and reset

- `bootstrap.ts:loadData` calls `loadPluginsForBoot`. It captures guest startup inside the reload chain.
  `captureBootGuests` defines how a stopped guest follows its replacement or removal. See
  [safe boot](app-shell.md#safe-boot). Other callers use `loadPlugins`, which returns after the loader runs.
- Under `safeBootOff("plugins")`, UI edits persist but neither loader starts guests, reports unsupported entries or
  installs deferred-reload listeners. Otherwise each captures its enabled list before joining the `pluginReload` chain.
- `applyPluginLoad` calls `clearPluginHooks`, then `loadV3Plugins` for enabled API 3.0 entries. It unloads existing
  instances before resetting providers, model metadata and DOM listeners and starting replacements. See
  `executePluginV3` for failed-start cleanup and `unloadV3Plugin` for callback rejection, replacer teardown and
  instance-specific MCP cleanup.
- To use the hooks a guest registers during startup, wait for `pluginsStarted`. Remote host sends, job-channel resume
  and takeover hold generation plugin work across that wait so a deferred reload cannot replace the hooks underneath
  them.

### Hook entry points

The runners of the hooks that have a chat call each hook through `invokeHook` with the context they captured
(`capturePluginContext`) or were given:

- `editdisplay` and `editprocess` handlers of a render (`src/ts/parser/transformClient.ts`, its module header and
  `handlerSet`) run between the script transform's two calls with read-only `purpose: "transform"`; the results, or a
  handler's error per target, go to `/api/transform/continue`. `runHandlers` bounds the wait without stopping guest
  code, and the handler set's identity is per document, mode, and ordered hook list.
- Tab `requestChatData` runs the before-request replacers on the prompt and the after-request replacers on a buffered
  success. The inner dispatcher inserts [request interception rules](llm-requests.md#request-interception) before
  model-specific formatting. A plugin's own `runLLMModel` enters that dispatcher directly, skipping the outer replacers.
- Server jobs: the tab lists its hook names at job creation (`registeredHooks`, `src/ts/network/jobChannel.ts`), and the
  server calls back by name; the registry is read when the callback runs ([network jobs](network-jobs.md)).
- `chatOutput` listeners: a server send's `runChatOutputListeners` (`server/src/prompt/runner.ts`) reaches them through
  the job channel's `chatOutput` callback, with the job's targets.
- MCP listing and tool callbacks: the job channel passes its targets; `request.ts` passes `pluginContext` through
  `getTools`, and `transport.ts` through `callTool` for both the ownership listing and the call. The plugin client
  invokes the wrapped callback synchronously with the context, after registry awaits have finished.

Chat-bound HypaV3 summaries capture and pass their context; server callbacks, including image-view generation, run under
the job targets.

Body interceptors (`registerBodyIntercepter`, `bodyIntercepterStore`) run on opted-in fetches in `globalFetch`,
`fetchNative` or `auxFetch`, or through a job's `bodyIntercepter` callback on the built provider body. They receive no
explicit hook context. The TTS pre- and postprocessors in `ttsHooks.ts` also use the tab selection or the same
instance's ambient context.

### Deferred reload

- A remote `plugins` record, patch or conflict reload triggers `onRemoteRecordApplied`. A changed `loadSignature`, a
  permission reset of a running plugin, or an explicit host reload queues `queueDeferredCheck`.
- `pluginWorkIdle` requires no local send, no job still able to call this tab's hooks, no host hook in progress
  (including provider consent), and every sandbox idle. `onPluginWorkChange` retries the check. The loader checks again
  inside the chain before replacing hooks. Work that never settles defers reload ([Limitations](#limitations)).
- The host's `reloadPluginsWhenIdle` forces one load even with the same signature. A local load satisfies requests
  pending at its start. Outcomes are `applied`, `failed` or `pluginsOff`. A host page reload reads
  `bootPluginLoadOutcome`. Both report the loader outcome independently of guest startup.

### Activity by plugin

- `pluginBusy(name)` checks the running instance's sandbox and host hooks. `onPluginActivity` reports the name when
  sandbox work or a host hook settles, and on unload. `pluginWorkIdle` separately covers the whole tab.
- At remote-send admission, `src/ts/network/remoteHost.ts` captures only enabled API 3.0 entries with a loaded instance
  and a configured quiet period. With notifications enabled, that set can hold the send's completion Web Push.
  `waitForPluginsQuiet` starts each target's clock at wait entry and restarts it on that plugin's reports. Its outcomes
  are `quiet`, `cap` and `aborted`. The host rechecks activity across the save flush before release
  ([remote host commands](network-jobs.md#remote-host-commands)).

### Permission list

- A settings row or a regular import opens `reviewPluginPermissions` in a single `alertConfirmWithChecklist`. Imports
  skip it for hot reload and the blank template. Updates preselect the replaced script's grants. Declining writes
  nothing and the import continues.
- Confirming calls `setStandingPermissionGrants`: checked grants belong to the script hash and skip periodic prompts.
  Unchecked grants are revoked, including matching permissions on a running script of that name. A changed list bumps
  the plugin's reset count, invalidates cached answers across tabs and reloads the plugin.
- For a list that would write, `StalePermissionListError` guards the reset count across writes and conflicts.
  `stillCurrent` guards script replacement, which alone does not bump that count. `importPlugin` rechecks the installed
  script after review before replacing it. See `getPluginPermission` for sharing an in-flight check by plugin,
  permission and reconfirm mode.

- `setChatPanel` HTML that carries a `style` element (HTML or SVG) needs `globalStyle`, asked once: the panel is
  inserted into the main document, where the rules reach the whole app. Denied, the panel is shown without its `style`
  elements. HTML without one asks nothing.
- A chat panel's `section` has paint containment and carries no plugin attribute: the plugin's `className` and the panel
  id sit on a wrapper inside it, so inline styles and classes cannot place content over the app, and content that
  overflows the panel (a dropdown) is clipped. Decision: owner, 2026-11-15.
- A `setChatPanel` call that waited applies only while it is the latest call for its panel id and its instance is not
  unloading. Panel ids are one namespace over every plugin, and a removal (`unregisterUIPart`, unload) counts as a call
  (`chatPanelCalls`).

### Job owner presence

[Generation channels](server-generation.md#generation-channels) owns presence, deadlines and safe-boundary transfers;
`src/ts/network/jobChannel.ts` documents callback execution and viewer refusal.

- Hooks may run on a worker showing another chat: `getRootDocument` finds no message DOM there. Targets remain the
  job's; device-local keys are the worker's. A delivered callback never runs on a second tab, even if its device sleeps.
- MCP excludes silent owners; a live tab answering pings keeps a long provider call alive. Absence failure saves partial
  text and ends the job. Completed-reply transforms keep text; undelivered listeners run late, delivered ones are
  missed.

## State

- `db.plugins: RisuPlugin[]`, saved as the `plugins` resource.
- An entry's `completionWait` (off by default) and `completionQuietSeconds` (wait for this plugin before a remote host's
  completion notification, and its quiet time) are read only through `pluginCompletionQuietMs`, which defaults, floors,
  and clamps them; the server keeps them as stored. `upsertPlugin` gives a replacing entry its predecessor's two fields
  and drops supplied ones, so an update, a re-import, or the plugin API's `setDatabase` keeps them and cannot set them.
  They are not in `loadSignature`: a change reloads nothing.
- `importPlugin` (import, update, hot reload) keeps the replaced plugin's enabled state and each argument value whose
  name and declared type are unchanged, and loads the plugin only after its scoped save is acknowledged; an unconfirmed
  save is reported and nothing is started.
- Only `PluginSettings.svelte` writes those two fields: an API `3.0` row has the switch and, while the helper reads it
  on, the quiet time within `PLUGIN_COMPLETION_QUIET_SECONDS` and a line naming the time limit
  (`completionWaitMaxSeconds`).
- Plugin storage:
  - `db.pluginCustomStorage` (`pluginStorage` record): `_ownedPluginStorage` by plugin name, `_pluginStorage` legacy
    read-through until claim-on-write or owner `clear()`; U+0000 names use legacy storage (module header). Shared
    top-level custom keys are non-`allowedDbKeys` keys of `setDatabase`/`setDatabaseLite`; replacement keeps omitted
    reserved dictionaries. `setItem` JSON-normalizes values (BigInt throws) and throws for an owner not in
    `settings.plugins` (a removed plugin still running elsewhere).
  - Plugins share one record. A plain value written into it is copied (`adoptPluginStorageValue`), so the caller's
    object stays outside it. Writes resolve when queued. Concurrent tab/device writes are
    [merged key by key](resource-sync.md#record-merge); `onStorageDiscarded` reports each listener's own lost keys and
    legacy keys.
  - Shared `getLocalPluginStorage()` (`SafeLocalPluginStorage`) is saved under `_safeLocalPluginStorage`; boot imports
    legacy browser-local values. JSON validation: `pluginSafeClass.ts` `SafeLocalPluginStorage`, `isJsonValue`.
  - String-key rules and the owner key cache (`pluginStorageRevision`): `pluginStorageStore.svelte.ts` module header;
    the save adapter [preserves `__proto__`](resource-sync.md#invariants).
  - `safeLocalStorage` (`SafeLocalStorage`) stays device-local (`localStorage` `safe_plugin_*`).
- v3 permission grants live in the server-owned `pluginPermissions` resource (`permissionStore.ts`; its header names the
  only writers), outside the settings records: `grants` keyed by `<sha256 of the script>_<permission>`, `lastGrantTime`
  by plugin name and permission, `resets` by plugin name, `standing` by grant key ([permission list](#permission-list)).
  - The script hash is taken from the script the plugin was loaded with, and answers are cached per plugin and
    permission for the page load (cleared on unload).
  - Only the settings page revokes (`resetPluginPermissions`, `removeOrphanPluginPermissionGrants`, and the permission
    list's unchecked rows); a revoked grant drops its cached answer in every tab. A reset always bumps `resets`: every
    tab drops the plugin's answers, and a prompt open across it (or an unload) answers `false`.
  - A reset reloads the plugins here (the settings page calls `loadPlugins` after the revoke, even a failed one). Every
    tab that runs the plugin hears the `resets` change (`onPermissionGrantsRemoved`) and defers a forced reload, which a
    local load supersedes, so no running guest keeps a capability it obtained before the reset.
- `PluginDataSettings.svelte` (component contract): namespace sizes, owned keys by owner; legacy keys assigned or
  deleted through the mutations above.

## Coupling

- Plugin consumers: `bootstrap.ts`, `src/lib/Setting/Pages/PluginSettings.svelte`, `globalApi.svelte.ts`, `modellist.ts`
  (`customV3ProviderMetaStore`). Hook-registry consumers: `src/lib/Setting/Pages/Model/ModelProfileEditor.svelte`,
  `request.ts`, `transformClient.ts`, `jobChannel.ts`, `tokenizer.ts`.

## Invariants

- The plugin's internal `name` is its identity: storage, IPC allowlists, arguments and grant timestamps use it; grants
  use script hashes. Updates must keep the name.
- Only API 3.0 exists. Plugins run only inside the iframe, never in the main document.
- `factory.ts` owns the RPC lifetime contract. Check `SandboxHost`, `RELEASE_INSTANCE` and `RELEASE_CALLBACK` before
  changing serialization or teardown. Both peers verify the source window. Callback arguments use the result bridge
  (including remote proxies); plain objects retain an own `__proto__` as data. Keep fetch headers and bodies out of RPC
  logs.
- `hostCallSignal` must be read synchronously on host API entry. Host and guest controllers outlive a returned stream
  until its streams finish or are cleaned up. Termination aborts outstanding work and closes both bridges. See the
  `factory.ts` header and the stream and proxy cases in `sandboxActivity.test.ts` and `guestBridge.test.ts`.

- `risuFetch` and `nativeFetch` refuse a URL whose host is a blocked name or a subdomain of one (`urlBlacklist`,
  `assertPluginUrlAllowed`): the URL is parsed alone and against the page, the hostname lowercased and its trailing dots
  stripped. A blocked name in a path or query passes, and the transport receives the caller's original string.
- Main-document DOM access uses `getRootDocument`, which requires the `mainDom` permission and returns the Safe
  wrappers.
- Any new v3 UI or hook must call `addPluginUnloadCallback` and sanitize external HTML and URLs.
- A plugin or MCP write goes through a mutation module (`characterStore.svelte.ts`, `collectionStore.svelte.ts`,
  `pluginStorageStore.svelte.ts`, the chat module); a new host setter or tool never writes a record or a chat directly.
  A refused value warns (plugins) or answers an error (MCP) and changes nothing.
- `setDatabase`, `setDatabaseLite`, `setChar`, `setCharacter`, `setCharacterToIndex` and `setChatToIndex` need the
  `dbWrite` grant (asked `periodically`; a `db` grant does not count), checked after `refuseTransformWrite` and before
  validation, chat loading or the install prompt. The context, settings write scope, target ids, their owner tokens and
  a hook `chatPage` match are captured before that await, so a change during the prompt cannot retarget the write; a
  refusal warns and writes nothing. `getPluginPermission` refuses a name outside `permissionConsentTexts` first.
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
  reload teardown replay that record whatever the caller passes to `removeEventListener`. Wrappers for the same target
  share listener IDs, and a fired `once` listener leaves the teardown list.
- Hook registrations after an instance begins unloading are discarded with a warning, including registrations that
  awaited permission. The same instance fence covers providers, script/replacer/chat/TTS hooks, MCP, IPC, storage
  listeners, and UI registrations; replacements get a fresh fence.
- Plugin key listeners (`keydown`/`keyup`/`keypress`, on any element or the document, capture phase included) receive
  nothing from the terminal notice's opening until reload, its acknowledgement key release included
  (`terminalNoticeShown`): the notice stops only bubbling.
- A plugin character applied over the same `chaId` (`applyPluginCharacter`) keeps the stored `supaMemoryOnCount`
  whatever its copy says, and bumps it when it turns `supaMemory` on (`memory.md`).
- The v3 `sendChat` captures the hook's chat, else the selection at API entry, and its owner before consent; it pins
  through loading and dispatch and refuses a deleted or replaced target. It returns whether the send ran, refusing ("A
  chat is already in progress") before appending, checked again after loading:
  - while that chat is busy (`isChatBusy`: a send of this tab, a followed job, or a lock; a generation hook's chat in a
    job channel callback always is);
  - while a job channel callback runs in this tab (`channelCallbacksRunning`: a hook or provider that waited for a new
    job of this tab would hold the lane that job's callbacks need; a cancelled callback counts until its hook settles).
- After those checks, orphaned lore overrides refuse before appending, with an alert and false.
- With no job channel callback running, idle chat B can send while A sends here; shared flush
  (`GenerationBlockedError`), binding, and server refusals still apply.
- A plugin changes the installed plugin list only through `setDatabase({ plugins })`, which asks the user to confirm
  each new or changed plugin. `setDatabaseLite` drops `plugins` before it applies anything; the call's other keys still
  apply.
- `updateModule` validates a detached patched copy, then applies the patch to the live module in place, so a plugin's or
  editor's retained module reference stays current.

## Recipes

- Add a field where a password or credential is typed as visible text: `<TextInput secret>` or
  `alertInput(msg, undefined, undefined, { secret: true })`, so `isSecretKeyEvent` (`v3.svelte.ts`) keeps its keys from
  plugin listeners. A password input needs nothing.
- Add a method to a host wrapper class: define it on the class or the instance. `getInstanceMethod` (`factory.ts`)
  refuses a name that comes from `Object.prototype` or `Function.prototype`.
- Add a v3 API function:
  1. Implement it in `v3.svelte.ts:makeRisuaiAPIV3`. Nested objects need flat host functions plus `_getAliases`.
     Constants go in `_getPropertiesForInitialization`.
  2. Declare it in `risuai.d.ts:RisuaiPluginAPI`.
  3. Document it in `plugins.md`.
  4. Verify with a real v3 plugin, including the callback and error paths.
- Change a per-plugin completion wait in `shared/plugins.ts`, `PluginSettings.svelte` and `pluginQuiet.ts`. For host
  selection and release of the notification follow [Activity by plugin](#activity-by-plugin).
- Add plugin metadata: `importPlugin`, `RisuPlugin` (`shared/plugins.ts`), `PluginSettings.svelte`, `risuai.d.ts`
  comments, and `plugins.md`.

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/plugins shared/plugins.test.ts src/ts/storage/tests/{pluginStorageStore,collectionStore}.test.ts src/ts/network/generationJobsPluginWork.test.ts`.
  The MCP clients and tool dispatch: [mcp](mcp.md#tests).
- `slow`: none.
- `e2e/transformGolden.spec.ts`: edit hooks.
- `e2e/settingsPages.spec.ts`: the page.
- `e2e/pluginSandbox.spec.ts`: real-browser sandbox isolation, detached database reads, and panel style consent (an SVG
  `style` element is tested only here: happy-dom's parser drops it).
- `SandboxHost` stub (`vi.mock` of `./factory`, most of `apiV3/`): the real API object is driven directly.
- `guestBridge.test.ts`: the srcdoc's guest half over a fake window; it still logs its property initialization.
- `sandboxActivity.test.ts`: a real `SandboxHost`, the guest simulated by window messages.
- `databaseAccessRecorder.test.ts`: the developer `getDatabase` recorder in the real srcdoc guest, fake timers.
- `pluginDeferredReload.test.ts`, `pluginSafeBoot.test.ts`: a mocked v3 loader, the idle predicate and safe-boot flag
  controlled.
- `pluginWorkIdle.test.ts`: a controllable sandbox idle flag, the job channel real; it also covers `pluginBusy` and
  `onPluginActivity`.
- `pluginQuiet.test.ts`: `waitForPluginsQuiet` under fake timers. `shared/plugins.test.ts`: `pluginCompletionQuietMs`.
- `storeBackedServer.ts`: the real save adapter over the real server store, for writes and detached reads.
- `getDatabaseDetached.test.ts`: database reads, cache reuse, setter load skipping, and scoped reads (summaries,
  `getChats`) over `StoreBackedServer`.
- `permissionStore.test.ts`: grants over `FakeResourceServer`.
- Browser checks, not in the gate ([test-harness](test-harness.md)): `util/playwright/checkJobProtocol.mjs` (a real v3
  plugin provider answers job callbacks from the sandbox) and `checkJobHandoff.mjs` (hooks move between two tabs). Its
  hidden-worker case covers a newly hidden tab. Hooks waiting on timers after prolonged background throttling still need
  a browser check.
- `plugins.test.ts` covers import/update argument retention and hot reload's skipped consent review. The file-picker and
  polling loop in `hotReloadPluginFiles` and the remaining sandbox RPC surface lack end-to-end coverage.

## Known Hazards

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
- An owned `setItem` that reaches the server between a plugin's removal (with its data deleted) and another tab's
  receipt of the plugin list change can still restore a key; delete it again from the plugin data page. A removed
  plugin's `onUnload` writes are refused in the removing tab too, so with "Also delete its stored data" unchecked its
  last `onUnload` write is not kept. Decision: Found Issues Decisions B1 (owner, 2026-11-08).
- v3 `pluginStorage.setItem` converts a value through JSON without an error (`_setPluginStorage`): a `Set` or `Map`
  reads back as `{}`, a typed array as an index object, a `Date` as a string, `NaN` and `Infinity` as `null`, and an
  `undefined` property is dropped; a `bigint` or a cycle throws. `getLocalPluginStorage().setItem` refuses those values
  instead (`isJsonValue`). Decision: upstream parity, Found Issues Decisions (owner, 2026-11-08).
- Plugin storage is last-writer-wins per key once a remote value has reached the tab: a `setItem` of an object the
  plugin read earlier replaces a newer value from another tab or device with no conflict (reproduced 2026-11-17,
  cross-check F3). Before the feed delivers that value the write is answered 409 and `onStorageDiscarded` fires. A
  plugin that reads a key again right before writing it is safe. Decision: owner, 2026-11-17: refusing stale writes
  would fail a plugin that writes from memory on every save, and a host merge cannot see inside string values.
- With `mainDom` consent a plugin can query and change the whole document (`getRootDocument`) and receives the keys
  typed into every field that is not a password input or marked `data-plugin-secret`; `nativeFetch` lets a plugin choose
  its request headers. Decision: owner, 2026-11-10 (known-issues review): the consent is the boundary, and plugin
  providers send their own API keys.

### Gotchas

- Plugin argument popups include backing-row identity, position, name, and argument in their context; an outside row
  replacement or move discards the draft even when names and text match.
- `SafeMutationObserver` wraps a non-element mutation target's parent element in `SafeElement`; parentless records are
  omitted without dropping the other records in the batch.
- `PluginSettings.svelte` uses one `alertConfirmWithCheckbox` for removal; "Also delete its stored data" controls
  `deleteOwnedPluginStorage`, which runs after `loadPlugins`, so removing a plugin alone retains its stored data.
- Full character reads use `withChatsCopy`; records hold no chats. Outside hooks, `getDatabase` and `getChats` use
  `withDetachedDatabaseChats`: flush, then shared unloaded reads or `src/ts/plugins/apiV3/detachedChatCache.ts`, never
  installed; held chats stay pinned until the synchronous copy. A fully held current page skips the flush. Unsafe copies
  and failed flushes or reads fall back to loading. Restore halts reject these outside-hook reads, fully held pages
  included.
- Full-chat reads inside hooks use `withChatsLoaded`, loading whole characters. Outside-hook page fallbacks use
  `withHeldChatPage` (JSDoc); more than 32 missing members use the whole-character loader.
- The server projects a detached read by each chat's saved memory algorithm (its stored mode, else the saved global
  selection), so every unloaded copy carries its chat's classification. A chat whose classification moves before the
  final assembly discards only its own copy, a change of the global fallback discards them all, and either reads once
  more after flushing; a second change loads. A body whose mode disagrees with its list entry loads that chat alone.
- `getDatabase(keys, { chats: "summaries" })` reads, flushes, pins, and loads no chat (`chatSummaryList` in
  `src/ts/storage/chatStore.svelte.ts`); every plugin character setter strips `chatSummaries`.
- `getChatFromIndex`, `setChatToIndex`, `parseRisuChat`, and `sendChat` capture their chat by id first and await
  `ensureChatLoaded`; the two index accessors take only a nonnegative integer index and read one member
  (`chatMemberPage`). Other character setters capture targets, pin and load, then apply synchronously.
- `setDatabase` and `setDatabaseLite` capture exact chat round trips at entry and preserve them across consent and
  installation prompts; omitted chats also skip loading and reconciliation. Other supplied chats follow
  `applyPluginDatabaseWithChats`'s match recheck or load before applying.
- Plugins hand back whole objects, but [chats are saved as changes](chat-store.md#whole-chat-writers).
  `applyPluginCharacter`/`applyPluginCharacters` JSDoc holds reconciliation rules (`reconcileCharacterChats`,
  `applyChatResult`); a chat left out is deleted, never the last one. New characters append in one batch after the
  updates (`addPreparedCharacters`). New setters use these functions, never assign `chats` or `chatPage`.
- The chat and character getters retain the read as a baseline (16 chats per instance, least recently read evicted,
  cleared on unload) and the setters consume it once, so a change another writer made after the read survives; a write
  without a retained read diffs against the chat at the call. A setter captures the baseline at entry, before the
  `dbWrite` prompt, so a read made during the prompt cannot replace it.
- When a whole-chat diff would change or remove a message being generated (`assertUnlocked`), that chat's update is
  skipped with a warning; a reorder of unchanged messages while it generates drops only the order change.
- Generating-character and duplicate-id refusals: `applyPluginCharacter`/`applyPluginCharacters`; `removeChar` also
  refuses permanent deletion during generation.
- A custom `tokenizerFunc` is never called: tab token counts run on the server, which uses `cl100k_base` for a
  provider's `custom` tokenizer ([LLM requests](llm-requests.md)).
