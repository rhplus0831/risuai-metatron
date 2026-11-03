# Server Plugin Runtime Plan

Status: drafted 2026-11-01, no slice landed. Decisions D1–D10 are recommendations for the owner; the
**Open questions** need an answer before Slice 2 (Q1) and Slice 4 (Q2, Q3). Code anchors were checked at
`e294d957a`; verify them again before editing (STRUCTURE.md protocol step 5).

Sources: the owner's 2026-10-25 question (move plugin v3 execution to the server) and the split-runtime
recommendation given then; the owner's 2026-11-01 "virtual client" proposal (a headless browser the server
spawns to run Asset Maid's hooks) and its assessment, which ranked the work: absent-tab hooks first (landed, see
**Current state**), an opt-in server runtime with the plugin authors second, headless Chromium last; the
[plugins and MCP guide](../structure/plugins-mcp.md) (Sandbox host, Host API, Hook entry points, Job owner
presence) and the [server generation guide](../structure/server-generation.md) (Generation channels, Job chat
and barriers) at `e294d957a`; the [plugin author contract](../../plugins.md).

Owning guides when sliced: [plugins and MCP](../structure/plugins-mcp.md) (the runtime, its host API, the
author contract), [server generation](../structure/server-generation.md) (hook dispatch in a job, the hook
list of a create), [scripts and triggers](../structure/scripts-triggers.md) (the worker pool's new task kind),
[global API](../structure/global-api.md) (the job channel's per-plugin callbacks), [self-host server](../structure/self-host-server.md)
(the egress helper, the server option), [settings and i18n](../structure/settings-i18n.md) (the plugin page).

## Goal

A generation job's plugin hooks complete while the owner tab is asleep or gone, for a plugin whose author
opts in:

- The hook half of an API 3.0 plugin (`editinput`, `editprocess`, `editoutput`, the `beforeRequest` and
  `afterRequest` replacers, `chatOutput` listeners; `editdisplay` in the transform route as the last slice)
  runs on the server, inside the job, without a browser tab.
- The tab runtime stays the default and unchanged: a plugin that does not opt in runs exactly as today,
  including the skip-and-replay path.
- A plugin that opts in but cannot run on the server (its startup failed, the runtime is off, a permission
  it needs was never granted) falls back to the tab path for every hook, with the same skip-and-replay.
- The same plugin running in a live tab keeps its UI, and no hook runs twice for one event.
- The plugin's secrets stay where they are now (its `pluginStorage` and arguments); the server runtime adds
  no listener, route, or ambient capability a plugin could reach.

Not goals: a DOM on the server (no virtual document, no mutation streaming), headless Chromium, plugin
providers (`addProvider`) or plugin MCP tools on the server, declarative UI mirrored to tabs, `sendChat`
or `runLLMModel` from the server copy (see **Later**).

## Current state

The baseline is `e294d957a` on `dev` (2026-11-01). This plan does not re-propose it.

- **Hooks are tab callbacks.** A create carries `GenerationHooks` (`shared/jobs.ts`): aggregate flags
  built by `registeredHooks` (`src/ts/network/jobChannel.ts`) from the tab's registries (`pluginHooks`,
  `src/ts/plugins/pluginHooks.ts`: one `Set` of handler functions per hook, across every plugin). The
  server calls the tab back through `job.channel.callback` for exactly these names: `pluginHook` in
  `server/src/prompt/scripts.ts` (the three script modes), `replacer` in `server/src/lua/bindings.ts`
  (both replacers, as `OuterRequestDeps` of `server/src/llm/outer.ts`), `tailCallback` in
  `server/src/prompt/runner.ts` (`chatOutput`). `hasHook` (`server/src/jobs/channel.ts`) refuses a
  callback the create did not list (`unregistered`, which keeps the text). The tab's `runHook` runs every
  handler of the named hook in registration order, with the job's targets as the plugin call context.
- **Absent owner.** Request-side hooks (`editinput`, `editprocess`, `replacerbeforeRequest`,
  `bodyIntercepter`, `provider`) still end the job `failed` on `disconnected` (120 s absence bound,
  `OWNER_ABSENT_MS`). A completed reply's `editoutput` and `replacerafterRequest` keep the text and
  `chatOutput` runs nothing; the three are recorded in order as `done.skipped` (`SkippedHook`). A
  `chatOutput` callback a tab took before it left settles `disconnected` with `delivered: true` and is not
  recorded. The reattaching tab runs the skipped listeners once (`replaySkippedListeners`, called by
  `followJobToEnd` in `src/ts/process/serverCommands.ts` after the chat is current, the terminal's revision
  held, and `pluginsStarted()`), and toasts `serverJob.hooksSkipped` for the text hooks.
- **The tab sandbox.** `SandboxHost` (`src/ts/plugins/apiV3/factory.ts`) runs each plugin in an iframe
  under a CSP with no `connect-src`, no `unsafe-eval`, and a nonce for the guest bridge; the host API
  (`makeRisuaiAPIV3`, `v3.svelte.ts`) is async RPC, and `nativeFetch` is the only network. The script is
  transpiled with `sucrase` (`pluginCodeTranspiler`). `getRuntimeInfo()` already answers
  `platform: "node"` in the tab (the client requires the Node server), so a plugin cannot tell the two
  runtimes apart by `platform`.
- **Server-side engines.** `server/src/scripts/workerPool.ts` runs Lua (`wasmoon`, a wasm module per
  worker, `server/src/lua/runtime.ts`) and the regex engine in `worker_threads` workers with V8
  `resourceLimits`, a CPU watchdog (`eventLoopUtilization` less synchronous host answers), a wall cap, a
  bounded queue, and termination plus replacement of a runaway worker. One top-level task per worker; a
  host call is a message to the main thread (`ToWorker`/`FromWorker`, `server/src/scripts/worker.ts`).
  Lua's `request` has its own strict egress guard (`server/src/lua/egress.ts`: HTTPS, 120 characters,
  2 MB, 30 per minute), stricter than what a plugin's `nativeFetch` needs.
- **What the server already holds.** The `plugins` resource (the script, arguments, `enabled`), the
  `pluginStorage` resource (every plugin's `pluginStorage` and `getLocalPluginStorage()` data, merged key
  by key on conflict), and `pluginPermissions` (grants keyed by script hash and permission, written only by
  the tab's consent prompt). A job's `LuaBindingServices` (`server/src/lua/bindings.ts`) already give a
  fenced `liveChat`, `writeChat`, `patchCharacter`, `notice`, `request`, and `parse` on the job's targets.
  `writeContentAsset` (`server/src/http/contentAsset.ts`) stores a content-addressed asset.
- **Asset Maid** (the motivating plugin, `save/asset-maid.js`, not in the repository): an observe-only
  `editoutput` handler, both replacers, and a `chatOutput` listener that calls NovelAI through
  `nativeFetch` and writes an image into the message; its UI is a React bundle that needs the document.
  Its author already probes the runtime; the split this plan builds is the one they need.

## Decisions

- **D1. Opt-in by header, with a per-plugin override.** A plugin declares `//@runtime server` in its
  metadata comments. The server reads the header from its own copy of the script (a shared parser,
  `pluginRuntimeHeader` in `shared/plugins.ts`), never from a tab's claim. `RisuPlugin.serverRuntime`
  (`"on" | "off"`, absent = the header) lets the user turn a declared plugin's server copy off from the
  plugin page without editing the script. No auto-detection: a static scan cannot tell a bundle that
  touches `document` at startup from one that branches on the runtime, and a wrong guess costs a failed
  startup per boot; the author knows. Rejected: an allowlist by plugin name on the server (a second
  place to keep in step with the header).
- **D2. Host: QuickJS-wasm inside the existing script worker pool, one pinned worker per plugin.**
  - The engine is `quickjs-emscripten` (the synchronous release variant; host functions return guest
    promises the worker resolves from its own event loop, then pumps `executePendingJobs`), loaded once
    per worker like the Lua wasm module. Its memory limit and interrupt handler give the heap and CPU
    caps inside the engine; the pool's watchdog, `resourceLimits`, and termination stay the backstop, as
    for Lua. The isolation is structural: the guest's only exits are the host functions the worker
    installs; there is no `process`, `require`, `fetch`, or file system to reach, so a plugin cannot read
    the server's LLM secrets, environment, or `save/` directory even by escaping its realm.
  - Rejected: `node:vm` in a worker (no boundary: a host function's `constructor` reaches the worker
    realm, and `process.getBuiltinModule` reaches `fs`; the server, unlike the tab, holds every secret);
    `isolated-vm` (a native addon to build on every Docker image and Windows `server.bat` install, with
    Node 24 prebuilds not guaranteed; otherwise the fastest option); a separate Node process under the
    permission model (network stays unrestricted there, a new egress surface this plan forbids); headless
    Chromium (ranked last on 2026-11-01: a browser per server, job-owner delegation, no limits).
  - Lifecycle in the pool: a `plugin` worker is pinned to one plugin instance and is not in the free-slot
    queue; it holds the instance's QuickJS runtime for the life of the instance (plugin state lives in
    its globals, and a 4.6 MB bundle is parsed once per load, not per send). A hook call is a task on that
    worker, serialized per plugin as Lua tasks are per worker. A pinned worker counts toward `maxSize`
    only for its own thread; one is expected per opted-in plugin (one to three in practice).
  - Limits (constants in the pool, test-overridable): startup CPU 60 s and wall 120 s; a hook call's CPU
    budget 30 s (`DEFAULT_LUA_BUDGET_MS`), its wall deadline the deadline the callback it replaces would
    have had (`CALLBACK_TIMEOUT_MS` 60 s; Q2 for `chatOutput`); engine memory 256 MB and the worker's
    `maxOldGenerationSizeMb` 512; host-call argument and result JSON at most 16 MiB
    (`MAX_TASK_JSON_CHARS`); at most 4 `nativeFetch` calls in flight per plugin, each body buffered to at
    most 64 MiB. A terminated worker fails its running hook as a hook failure (D6) and the instance is
    restarted; three terminations or crashes within 10 minutes quarantine the instance (status `failed`,
    reason `quarantined`) until the next `plugins` change or server start.
  - The guest prelude (the server's counterpart of `GUEST_BRIDGE_SCRIPT`, a JS file run first in every
    runtime) installs `Risuai` as RPC proxies over the host functions, and the web globals plugins rely
    on and QuickJS lacks: `setTimeout`/`clearTimeout`/`setInterval`/`queueMicrotask` (host timers),
    `TextEncoder`/`TextDecoder`, `atob`/`btoa`, `URL`/`URLSearchParams`, `AbortController`/`AbortSignal`,
    `crypto.getRandomValues`/`crypto.randomUUID` (host entropy), `performance.now`, `console`, a minimal
    in-memory `Blob`, and a `Response` class for `nativeFetch` (`ok`, `status`, `headers`, `text()`,
    `json()`, `arrayBuffer()`, `blob()`; no streaming body in this plan). It removes `eval` and the
    `Function` constructor from the global, matching the tab's CSP, so a plugin that needs them fails to
    start and falls back (D5). The script is transpiled with `sucrase` as the tab does.
- **D3. The host API subset.** Inside a hook, the selection-dependent functions act on the hook's
  targets (the job's chat, character, presets, persona), as the tab's `currentContext` does; outside a
  hook (startup, a timer) they throw `noContext`, since a server copy has no selection to fall back to.
  - Available: `nativeFetch` (D8), the `pluginStorage` family (`_getPluginStorage` and its aliases, the
    `_safeLocalPluginStorage` of `getLocalPluginStorage()`) over the `pluginStorage` resource through the
    server store, under the same key-by-key merge the tab's writes get; `getArgument`/`setArgument` (the
    `plugins` record; `setArg` on another plugin's key is refused as in a transform); `getChar`/`setChar`,
    `getCharacter`/`setCharacter`, `getCharacterFromIndex`/`setCharacterToIndex`, `getChatFromIndex`/
    `setChatToIndex`, `getCurrentCharacterIndex`/`getCurrentChatIndex` (the job's chat as stored now,
    writes through `writeChat` and `patchCharacter` of `LuaBindingServices`, with their fences: a message
    a generation owns is refused as `@@inject` is); `saveAsset` (`writeContentAsset`, answering the same
    logical `assets/<hash>.<ext>` reference); `log` (the server log, `MAX_LOG_CHARS_PER_RUN` applies);
    `getRuntimeInfo`; `requestPluginPermission`, `addRisuScriptHandler`/`addRisuReplacer`/
    `addRisuChatListener` and their removals, `onStorageDiscarded`; `alert` and `alertError` (a job notice
    when inside a hook, a log line outside); `safeLocalStorage` (device-local in the tab) as an in-memory
    store per instance, lost on reload, documented.
  - Permission-gated functions (`getDatabase`, `setDatabase`, `setDatabaseLite`, `addRisuReplacer`'s
    `replacer` grant, `getFetchLogs`) answer from the stored `pluginPermissions` grants only, keyed by the
    hash of the script the server loaded: granted in a tab earlier, allowed; otherwise refused as a denied
    prompt is in the tab, and the instance status names the permission (`permissionNeeded`) so the user
    grants it from the tab copy. A grant change reloads the instance (its registrations may depend on it).
  - Refused on the server, throwing `PluginRuntimeError` with code `unavailableOnServer` and the API's
    name: the DOM and UI surface (`getRootDocument`, `showContainer`, `setChatPanel`,
    `createMutationObserver`, settings items, the floating button, the theme and color-scheme setters),
    `alertConfirm` and the other answering alerts, `sendChat`, `runLLMModel`, `parseRisuChat`,
    `addProvider`, the MCP registration, `getFetchLogs`'s unsafe log, `installPlugin`, `loadPlugins`. A
    throw, not a silent return: the plugin's own `try`/`catch` decides, an unguarded call at startup fails
    the start (the right outcome for a plugin not written for the server), and each refusal is counted per
    API in the instance status.
- **D4. `getRuntimeInfo().runtime`.** The tab answers `runtime: "tab"`, the server `runtime: "server"`;
  `platform` stays `"node"` in both (a plugin that branches on it today keeps working, and `saveMethod`
  is unchanged). This is the discriminator the author contract documents; Asset Maid's hook half branches
  on it.
- **D5. Where a hook runs: per plugin, per hook, server registration shadows tab registration.** The
  tab's create lists its hooks per plugin: `GenerationHooks.byPlugin: { name, scriptHash, hooks:
HookName[] }[]` beside the aggregate flags (kept for older servers), from a per-plugin index the host
  API keeps when it wraps a handler. When a hook comes due, the job's hook runner (D6) runs the handlers
  of every `ready` server instance that registered that hook, in `db.plugins` order, then, if any plugin
  of `byPlugin` registered it and is not shadowed, calls the tab back with the payload plus
  `plugins: string[]`, the names whose handlers the tab must run; the tab's `runHook` runs only those (an
  older tab, which sent no `byPlugin`, gets no `plugins` field and the job runs entirely on the tab path).
  A plugin is shadowed for a hook when its server instance is `ready` and registered that hook; a hook the
  server copy did not register (the author kept it in the tab on purpose, by branching on `runtime`) still
  runs in the tab. The text flows server handlers first, then tab handlers; the order across plugins is
  therefore server-run plugins before tab-run ones, a recorded limitation. Membership is read when the
  hook comes due, as the tab reads it today: an instance that failed or was quarantined mid-job hands its
  hooks to the tab copy from the next hook on. `hasHook` accepts a callback when any of its `plugins` is
  in `byPlugin` with that hook.
- **D6. Relation to skip-and-replay.** A server-run hook is never recorded as skipped: it ran, or it
  failed, and a failure follows the policy the tab's hook throw already has (`CallbackResult` `failed`/
  `hook`): a request-side hook's failure ends the job at `stage: "script"`, a completed reply's
  `editoutput` or `replacerafterRequest` failure ends the job as today's hook failure does, a `chatOutput`
  listener's throw is logged and the tail goes on. Only the tab leg of a hook can settle `disconnected`,
  and then exactly today's rules apply: request hooks end the job, reply hooks are recorded in
  `done.skipped`. A `chatOutput` entry of `SkippedHook` gains `plugins: string[]`, the tab-run plugins the
  callback named, and `replaySkippedListeners` runs only those (never a shadowed plugin's listener, which
  already ran on the server). `delivered: true` keeps its meaning for the tab leg. A plugin that opted in
  but has no `ready` instance is a tab-run plugin for every hook, so it gets skip-and-replay unchanged.
  The hook runner lives in one module, `server/src/jobs/pluginHooks.ts`, replacing the three call sites'
  own `callback` switches, so the policies above are written once.
- **D7. Instance lifecycle and status.** `server/src/plugins/runtime.ts` loads the enabled plugins whose
  header (or override) says server at server start, after the store opens and the pool is warm, and
  reloads on a `plugins` or `pluginPermissions` change of the change feed (`createChangeFeed`), debounced
  like the tab's deferred reload: a new instance starts first, the old one finishes its in-flight hook
  calls (bounded by their deadlines), then terminates. States: `starting`, `ready`, `failed` (reason:
  `startup`, `quarantined`, `permissionNeeded`, `runtimeOff`), `stopped`. A hook that comes due while the
  instance is `starting` waits for it, within the hook's own deadline (the tab's `pluginsStarted` wait).
  The status of every opted-in plugin (state, reason, last error, refusal counts, load time) is a frame
  on the live-update socket (`/api/events/ws`), sent at hello and on change, kept in a tab store for the
  plugin page; no new route. An operator switch, `pluginRuntime: "on" | "off"` on the app options
  (`RISU_PLUGIN_RUNTIME`, default `on`), turns the whole runtime off; every opted-in plugin then reads
  `runtimeOff` and runs on the tab path.
- **D8. `nativeFetch` through the server's egress rules.** One helper, `server/src/http/egress.ts`,
  extracted from the `/proxy` route's upstream call (the hop-by-hop and `risu-auth` scrubbing, the route's
  limiter budget charged to the plugin) and extended with the tab's `urlBlacklist` (moved to
  `shared/plugins.ts` so both runtimes read one list) and the local-network check the LLM transport
  applies (`isLocalNetworkUrl`, allowed only as the proxy allows a tab's local route). The plugin caps
  of D2 apply on top. The request is recorded in the request history as a plugin request (source:
  the plugin's name, the hook when inside one), with the header redaction the history already does. The
  Lua guard stays Lua's: its 2 MB and 120-character caps would break the image downloads this plan is
  for. A plugin never receives the job's auth, a tab's token, or an LLM credential: `nativeFetch` sends
  only the headers the plugin wrote.
- **D9. Security summary.** The plugin's secrets stay in its `pluginStorage` and arguments, readable by
  its tab copy and its server copy alike, as today. The server runtime exposes no new listener or route
  (the status rides the existing socket), no ambient I/O (D2), no credential (D8), and no write path that
  bypasses the store's fences (D3 writes go through the job services). The script the server runs is the
  one in the `plugins` record, hashed for the grant lookup like the tab's. Limits bound a runaway plugin
  to one worker (D2). What the server copy can do that the tab copy cannot: run with no tab attached,
  which is the point; the operator switch and the per-plugin override are the brakes.
- **D10. Compatibility tiers.** Tier 0, the default: no header, the tab runtime, skip-and-replay. Tier 1:
  `//@runtime server`, the hook half on the server by D5, the UI half in tabs. A job created by an older
  tab (no `byPlugin`) is Tier 0 for that job; a header an older server does not know is ignored (Tier 0).
  `GenerationHooks`' aggregate flags stay and stay truthful (they describe the tab's registrations), so an
  older server reads a new tab's create as today.

## Open questions

- **Q1. The engine package.** `quickjs-emscripten` (recommended: maintained, pure wasm, memory limit and
  interrupt handler built in, no native build) or a smaller single-variant build. Decide before Slice 2;
  the slice measures the load time of a 4.6 MB bundle and records it in the guide's Gotchas.
- **Q2. The wall deadline of a server-run `chatOutput` listener.** Parity with the callback it replaces
  (60 s), or longer since no tab waits (recommended: 120 s, a constant the guide names), given that the
  chat stays busy meanwhile. Decide before Slice 4.
- **Q3. Operator default.** `pluginRuntime` on by default (recommended: the plugin must opt in anyway and
  the user chose to install it) or off until the first release has run on the owner's server. Decide
  before Slice 3; it changes one default and one sentence of the guide.

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Slices 1, 4,
and 5 edit `shared/jobs.ts`, `server/src/jobs/channel.ts`, or `src/ts/plugins/apiV3/v3.svelte.ts`: run them
one at a time, not in parallel worktrees. Slices 2 and 3 touch the pool and the runtime only and can run
beside Slice 1.

### Slice 1: per-plugin hooks on the wire (D1 header, D4 tab side, D5 wire, D6 replay filter; needs nothing)

Files: `shared/plugins.ts` (`pluginRuntimeHeader`, `RisuPlugin.serverRuntime`, `urlBlacklist` moved here),
`shared/jobs.ts` (`HookName`, `GenerationHooks.byPlugin`, `plugins` on the hook payloads and on
`SkippedHook`'s `chatOutput` entry), `src/ts/plugins/pluginHooks.ts` (the per-plugin index beside the
sets), `src/ts/plugins/apiV3/v3.svelte.ts` (handlers wrapped with their plugin's name; `getRuntimeInfo`
answers `runtime: "tab"`), `src/ts/plugins/plugins.svelte.ts` (`importPlugin` reads the header into the
record), `src/ts/network/jobChannel.ts` (`registeredHooks` builds `byPlugin`; `runHook` and
`replaySkippedListeners` honor `plugins`), `server/src/jobs/channel.ts` (`parseGenerationHooks` validates
`byPlugin`; `hasHook` by plugin), `src/ts/plugins/apiV3/risuai.d.ts`. No server runtime yet: the server
still calls the tab for every hook, now naming every registered plugin, so behavior is unchanged.

- Tests (tab): two plugins registering `editoutput` and a callback naming one run that one's handler only,
  in registration order; a callback without `plugins` runs all (an older server); `replaySkippedListeners`
  with `plugins` runs only those listeners; `registeredHooks` lists each plugin's hooks and its script
  hash; `importPlugin` keeps a plugin without the header at `serverRuntime` absent.
- Tests (server): `parseGenerationHooks` refuses a malformed `byPlugin` (400) and accepts a body without
  it; `hasHook` accepts a callback whose `plugins` are listed with that hook and refuses one that is not.
- The three fixtures of `promptTail.test.ts` for the no-owner tail pass unchanged.

### Slice 2: the QuickJS guest in the worker pool (D2; needs Q1)

Files: `server/src/scripts/workerPool.ts` (pinned workers, the `plugin` task kind, its limits and
watchdog accounting), `server/src/scripts/worker.ts` (the QuickJS runtime per pinned worker, host-call
bridge with guest promises, timers), new `server/src/plugins/guestPrelude.js` (D2's prelude; read as text
like `jsonLuaPath`), new `server/src/plugins/guest.ts` (load, call a registered handler, terminate; the
host-side registration index), `package.json` (the engine dependency, pinned), the scripts-triggers guide
(Files, Invariants) and the plugins guide (Files).

- Tests (`server/src/tests/pluginGuest.test.ts`, Node): a script registers an `editoutput` handler and a
  `chatOutput` listener and the host-side index lists them under the plugin's name; a handler's result
  comes back through a guest promise resolved by a host call; a busy loop is interrupted at the CPU
  budget and the worker survives; an allocation loop hits the engine memory limit and fails the call, not
  the pool; `eval` and `new Function` throw inside the guest; a startup that touches `document` fails with
  that error; `setTimeout`, `TextEncoder`, `URL`, `atob`, and `AbortController` behave as the prelude
  promises; a terminated pinned worker is replaced and its in-flight call fails; the pool's `dispose`
  terminates pinned workers.
- Measure (slow set): the load time and resident heap of a 4.6 MB bundle that branches on `runtime`
  (a generated fixture of that size, not Asset Maid), recorded in the plugins guide's Gotchas.

### Slice 3: the runtime service and its status (D7, D10 operator switch; needs 2)

Files: new `server/src/plugins/runtime.ts` (instances, states, boot load, change-feed reload, quarantine,
the override and the operator switch), `server/src/app.ts` (construction after the store, `dispose`,
`RISU_PLUGIN_RUNTIME`), `server/src/routes/events.ts` and `shared/` (the status frame at hello and on
change), `src/ts/network/eventFeed.ts` and a small tab store for the status, the self-host-server guide
(Files, the option), the plugins guide (State, Flows: Load and reset).

- Tests: boot loads only enabled plugins with the header or the `on` override and skips `off`; a
  `plugins` change starts the replacement before the old instance stops, and the old instance's in-flight
  call completes; a `pluginPermissions` change reloads; three crashes within the window quarantine the
  instance and the status says so; the switch off marks every instance `runtimeOff` without loading; the
  status frame is sent at hello and after each state change; `dispose` waits for in-flight calls within
  their deadlines.

### Slice 4: hooks run in the job (D5 server side, D6; needs 1 and 3, Q2)

Files: new `server/src/jobs/pluginHooks.ts` (the hook runner: server handlers, then the tab leg with
`plugins`; the policies of D6), `server/src/prompt/scripts.ts` (`pluginHook` becomes a call of the
runner), `server/src/lua/bindings.ts` (the replacer deps), `server/src/prompt/runner.ts`
(`runChatOutputListeners`, `tailCallback`), `server/src/jobs/runSetup.ts` (the runner on the setup, the
hook's call context: targets and services), the server-generation guide (Flows: Generation channels,
Prompt job execution) and the plugins guide (Flows: Hook entry points, Job owner presence; Invariants).

- Tests (server, the real channel hub and a fake guest that records calls): with the owner socket closed
  from the start, a reply whose `editoutput`, `afterRequest`, and `chatOutput` belong to a server-run
  plugin completes with no `skipped` and the listener ran once; the same with a tab-only plugin added
  records exactly the tab-only plugin's hooks in `skipped`, with its name on the `chatOutput` entry; a
  server-run `editinput` that throws ends the job at `stage: "script"`; a server-run listener that throws
  is logged and the tail goes on; a plugin registered in both copies runs its handler on the server and
  the tab callback names only the other plugin; an instance that fails between two hooks hands the second
  to the tab; a hook due while the instance is `starting` waits and then runs; an older tab's create (no
  `byPlugin`) never reaches the runtime; a `chatOutput` run past Q2's deadline fails as the tab's timeout
  does; the text of two plugins flows server then tab in that order.
- Tests (tab): the `done.skipped` of the mixed case replays the tab-only listener once.

### Slice 5: the data half of the host API (D3, D8; needs 4)

Files: `server/src/plugins/hostApi.ts` (new: the host functions behind the prelude, with the hook's
context), new `server/src/http/egress.ts` (extracted from `server/src/routes/proxy.ts`, which now calls
it), `server/src/data/requestHistory.ts` (the plugin request source), the store paths for `pluginStorage`
and `plugins` writes, `server/src/http/contentAsset.ts` (`saveAsset`), `server/src/lua/bindings.ts`
(the services the host functions borrow), the plugins guide (Host API, Invariants) and the self-host
server guide (the helper).

- Tests (fake `fetch`, the real store): `pluginStorage` set, get, keys, remove, clear persist in the
  `pluginStorage` resource and survive a tab's concurrent write to another key; a `getChar` inside a hook
  answers the job's character and `setChar` patches one field through the fenced service; `setChatToIndex`
  on a message a generation owns is refused and changes nothing; `saveAsset` writes a content asset and
  answers the logical reference; `nativeFetch` refuses a blacklisted host, a local address the policy
  denies, and a fifth concurrent call, scrubs `risu-auth`, buffers a body to the cap and fails past it,
  aborts on the hook's deadline, and is recorded in the history under the plugin's name; a gated call
  with a grant for the loaded script's hash is allowed and one without is refused and counted
  `permissionNeeded`; `getRuntimeInfo` answers `runtime: "server"`; each refused API throws
  `unavailableOnServer` and is counted; `alertError` inside a hook becomes a job notice and outside a
  log line; `getChar` outside a hook throws `noContext`.

### Slice 6: the plugin page, the author contract, and the browser check (needs 5)

Files: `src/lib/Setting/Pages/PluginSettings.svelte` (the runtime badge, the status and last error, the
`Run on the server` override, the permission-needed hint), `src/lang/en.ts` and `ko.ts`, `plugins.md`
(the header, `getRuntimeInfo().runtime`, the available and refused API table, the shadowing rule, the
write-up of what a plugin should keep in the tab), `src/ts/plugins/apiV3/risuai.d.ts`, a new
`util/playwright/checkServerPluginRuntime.mjs` registered in the build-test-platforms guide, the plugins
guide's Tests and Known Hazards, a final pass over every guide this plan touched.

- Driver cases (a test plugin with the header, an `editoutput` handler, and a `chatOutput` listener that
  calls a local fake endpoint through `nativeFetch`, installed in the persisted plugin list as
  `checkJobProtocol.mjs` does): the owner page closed right after the send, the reply completes, the
  listener's write is in the chat when the page reopens, and no toast names a skipped hook; the same
  plugin with the override off shows the skipped-hook toast and the late listener run instead; a plugin
  whose startup touches `document` shows `failed` on the page and the send still completes on the tab
  path.
- Device checks (Asset Maid on the owner's server with the phone's screen off) go to the user as a
  checklist and are reported as not run (V5).

### Slice 7: `editdisplay` in the transform route (optional; needs 5)

Files: `server/src/prompt/transform.ts` and `server/src/routes/transform.ts` (server-run display handlers
run between the two script passes, where the continuation goes today; the continuation lists only tab-run
plugins; the handler set's version includes the server registrations), `src/ts/parser/transformClient.ts`
(the continuation's plugin filter), the cbs-rendering guide (the continuation contract).

- Tests: a document whose only display handler is server-run is answered in full on the first call; a
  mixed set answers `pending` naming only the tab-run plugin; a server registration change changes the
  handler set's version so a cached result is not reused.

## Recommended order

1 → 2 → 3 → 4 → 5 → 6, then 7 if the owner wants it. Slices 2 and 3 can run beside Slice 1 in their own
worktree (no shared file). Slice 4 is the first user-visible change; before it, nothing a tab or a plugin
sees differs except `getRuntimeInfo().runtime` and the plugin page's header reading.

Structured Memory, which overlapped this plan, landed on 2026-11-03 ([the archive](../archived-plan/README.md)); its
memory jobs also pass through `server/src/prompt/runner.ts`, so re-read that file before slicing.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for every renamed export.
- Focused: `pnpm --silent test:agent server/src/tests/pluginGuest.test.ts server/src/tests/pluginRuntime.test.ts
server/src/tests/pluginHooks.test.ts server/src/tests/promptTail.test.ts server/src/tests/jobChannel.test.ts`
  for the server; `pnpm --silent test:agent src/ts/plugins src/ts/network/jobChannel.test.ts
src/ts/process/serverCommands.test.ts` for the tab (file names as the slices create them).
- Slow: the Slice 2 bundle measurement. `e2e`: `e2e/transformGolden.spec.ts` after Slice 7. Browser:
  `util/playwright/checkServerPluginRuntime.mjs` after Slice 6, one dev stack at a time.
- Not covered by any gate: Asset Maid itself (not in the repository) and the phone-asleep case, which are
  the owner's device checks.

## Out of scope

- A DOM on the server, headless Chromium, and any plugin UI mirrored to tabs.
- Plugin providers, plugin MCP tools, and `bodyIntercepter` on the server: they stay tab hooks and keep
  today's absent-owner behavior (a provider call fails the job; an interceptor ends it).
- Multi-user servers: the runtime loads the one user's plugins, as the store holds one user's records.

## Later

- `runLLMModel` and `parseRisuChat` on the server, over `LuaBindingServices.request` and `parse` (the
  seams exist; the request's source and the hook's context need defining).
- Streaming `nativeFetch` bodies into the guest (a MessagePort-credit stream as the tab's bridge has),
  once a plugin needs more than the buffered cap.
- `alertConfirm` and `alertInput` as job questions (`services.ask`, 120 s), if a hook-time prompt proves
  needed.
- Plugin providers on the server, which would close the last absent-owner failure for plugin-model users;
  it needs the periodic `provider` re-confirmation redesigned for a tabless run.
- A survey of public v3 plugins to see which could opt in with a header alone (proposed on 2026-10-25,
  not written).
