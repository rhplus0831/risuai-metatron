# Network and Jobs: Fetch Routing, Aux Fetch, Generation Job Client, Job Channel, Web Push

## Scope

- Owns the tab's network: `globalFetch`/`fetchNative` routing and the proxy headers, this tab's in-memory request log,
  `auxFetch` for calls that need a stored LLM credential, the local-network policy, socket liveness, the generation job
  client (ids, saved jobs, the follow, events, stages), the job channel dispatcher (notices, questions, hooks,
  callbacks, MCP in the tab), and this browser's Web Push.
- Paths: the network functions of `src/ts/globalApi.svelte.ts`, `src/ts/network/` except `requestHistory.ts`
  ([diagnostics](diagnostics.md)), and `shared/{localNetwork,notifications}.ts`.
- Not here:
  - The server job, its channel, and call dispatch → [server generation](server-generation.md#generation-channels).
  - Plugin hooks and the API a plugin sees → [plugins](plugin-sandbox.md); the MCP clients a callback reaches →
    [mcp](mcp.md).
  - Provider request bodies → `llm-requests.md`; server-side proxy routes → `self-host-server.md`.
  - The live-update feed's save loop → [resource-sync](resource-sync.md#feed-connection); the durable request history →
    [diagnostics](diagnostics.md).
  - The asset transport → [assets](assets.md); the alerts a notice maps to → [global-api](global-api.md).

## Files

The request-log viewer, browser collector, reports, and support sharing are documented in [diagnostics](diagnostics.md).
The transport below retains this tab's in-memory log.

### Network clients

- `shared/localNetwork.ts` (re-exported by `src/ts/network/localNetwork.ts`; the server request layer uses it too):
  `isLocalNetworkHost`, `isLocalNetworkUrl`. Accepts private/loopback/link-local IPs, `.local`, and bare single-label
  hosts.
- `src/ts/network/auxFetch.ts`: `auxFetch(op, url, { method, headers, body, signal, interceptor, chatId, profileId })`,
  a call that needs a stored LLM credential, sent to `/proxy2` with `risu-aux-op` (`self-host-server.md`): the server
  adds the key, the tab never holds it. Its comment states the steps. `auxFetchJson` answers in `globalFetch`'s
  `{ ok, data, status }` shape.
- `auxFetch` order: with `profileId`, it first awaits `flushResources()` so a changed binding, new profile, or named-key
  record is stored before the server reads it, and sends `risu-aux-profile` for the supported discovery/account rows. It
  then awaits `awaitSecretWrites()`, so a key entered just before is used and a refused or unsaved key fails the call.
  `authFetch`'s `beforeDispatch` checks the abort and the save admission after authentication and signing.
- `auxFetch` callers: model discovery (`modellist.ts` `registerModelDynamic`, `openrouter.ts`, `ollama.ts` cloud tags),
  NanoGPT (`nanogpt.ts`), OpenAI TTS (`tts.ts`; a custom URL with a stored key and no own key alerts
  `ttsCustomUrlNeedsKey`), DALL-E and Imagen (`stableDiff.ts`), Whisper (`PlaygroundSubtitle.svelte`), and the memory
  embeddings (`hypamemory.ts`, `hypamemoryv2.ts`, unless the processor has its own key). The tab makes no
  `openai-completions` call; that server operation stays.
- `src/ts/network/channelCallSource.ts`: `channelCallTargets(call)`, the targets of the job callback a plugin call
  context names (`PluginCallContext.channelCall`) while it runs in this tab and the server has not cancelled it, else
  null. `request.ts`'s send guard reads it; it never picks a callback for a request.
- `src/ts/network/eventFeed.ts`: the client of the live-update socket `/api/events/ws`;
  [documented with the save loop it feeds](resource-sync.md#feed-connection).
- `src/ts/network/socketLiveness.ts`: liveness of the feed and job sockets (the server pings both every 15 s), stated in
  its comments, its windows in `CONNECT_TIMEOUT_MS` (10 s), `STALE_AFTER_MS` (45 s), `WATCHDOG_INTERVAL_MS` (15 s),
  `RESUME_AFTER_HIDDEN_MS` (30 s), and `RESUME_FOLD_MS` (250 ms). The caller abandons its socket on each callback.

### Generation job client

`src/ts/network/generationJobs.ts`: the client transport of server generation jobs (`shared/jobs.ts`; server in
`server-generation.md`).

- `generationClientId`: one per tab, in `sessionStorage`. A page claims it before reading the id or its saved jobs,
  marking `risu-generation-client-claim` held, and releases it on `pagehide`.
- A page that finds the claim held by a live page (a window opened with an opener, a duplicated tab) mints a new id and
  drops the copied saved jobs, while a reload, a same-tab navigation or a `document.wasDiscarded` page keeps it.
- The saved jobs per chat: `savedGenerationJobs`, `rememberGenerationJob`, `forgetGenerationJob`. Boot attaches again to
  them through `serverCommands.ts` `resumeServerJobs` (`followJobToEnd`).
- `createGenerationJob` sends `registeredHooks()` unless the caller passes a list. It refuses with
  `GenerationBusyError`, `GenerationStaleError`, `ChatBindingRefusedError` for 409 `chatBindingIncomplete` or
  `chatBindingMismatch`, `ChatLoreOverrideOrphanedError`, or the epoch mismatch.
- `readGenerationJob`, `abortGenerationJob`, `followGenerationJob`: the follow is the owner socket with a fresh JWT.
  Events of another epoch are dropped, `send` carries the channel's answers, and a 412 runs the resource client's
  restore halt. Its comment states when it gives its socket up and what it resolves with.
- A newer follow of the same job cancels the older one (its socket, even while connecting, its events, and its sends)
  and sends a higher `attach` stamp, increasing across reloads.
- `applyGenerationEvent(jobId, ref, event, transport?)` feeds `applyServerGeneration`, `applyHydration`,
  `applyPatchHydration` (a `chatPatch`), and `endServerJob`. Channel events go to `jobChannel.ts` with the follow as
  their transport; the dispatcher loads on first use and runs on one chain in socket order.
- A `mismatch` patch sends one `{ type: "resync" }` per follow through `transport` until a whole job chat arrives. A
  `busy` patch, or a whole job chat refused for local work, sends it after `flushResources` while the chat is still
  stale and `chatHydrationHold` is `none`, one recovery per follow.
- Stages: creation and the first `accepted` seed `preparing` in `jobStages` only while the job has no known stage. A
  `stage` event replaces it and is kept per job until `releaseGenerationJob`, which also drops the stage when a follow
  is lost.
- A `preset` event, a send's `presetChain` pick, changes nothing: the pick is the job's own
  ([chat bindings](persistence.md)).

### Job channel

`src/ts/network/jobChannel.ts`: the client dispatcher of the job channel. Its header states event order, the UI queue,
the barrier, request state, the root lane, and each hook's call context. A new call: [Recipes](#recipes).

- Notices map to `alert.ts`, `ReloadGUIPointer`/`ReloadChatPointer` (by `chaId`/`chatId`/`messageId` when that chat is
  shown), `CharEmotion`, `hypaV3ProgressStore`, `sayTTS`, and `showCompletionNotification` (the server's title and body,
  never a permission request). The `openURL` notice opens an `http(s)` address (an MCP server's OAuth page). A job that
  ends closes the HypaV3 progress overlay it left open.
- The UI queue is one queue across jobs: while a question or a modal notice is open, later alert notices (toasts too)
  and questions wait, and each modal notice's own dialog is awaited (`openAlertDialog`), not every queued local dialog.
- A question is answered with the alert's raw result: the alert API has no separate dismissal, so `cancelled` is not
  produced.
- A job's end drops its queued `alertWait`, `alertClear`, and `alertToast` notices and clears its installed status only
  while that exact object still owns the status slot; its modal notices remain queued.
- Callback failures: a barrier miss, a discarded key, or a rejected flush is `failed`/`barrier`; the hook's own throw is
  `failed`/`hook`, and the flush still runs. Plugin MCP listings and tool calls receive the job targets; interceptors
  run without the hook context.
- Replacers and edit hooks stop at the first throw; interceptors log and continue. `chatOutput` runs the output
  listeners in order, each with a plain copy of the speaker and the chat as they are then and indices looked up again,
  logs a listener's throw, and answers `true`. `replaySkippedListeners` runs them again for the `chatOutput` entries of
  `done.skipped` (replies that completed with no tab attached): `followJobToEnd` calls it after the terminal's chat read
  took, under `capturePluginContext` of the chat.
- A late listener run waits for the plugins' startup (`pluginsStarted`) and holds plugin work
  (`holdGenerationPluginWork`) from before the terminal is applied until it ran, so a deferred reload neither empties
  the registry meanwhile nor precedes the guests' registrations. A `chatOutput` callback a tab had taken before it left
  (`delivered`) is not listed, so it is never run twice; the other skipped hooks are named once in a toast
  (`serverJob.hooksSkipped`).
- `imggen` runs `stableDiff` and `generateImage` runs `generateAIImage` with the callback's `AbortSignal`, which the
  callback's cancel or the job's end aborts; neither answers a result that arrives after the cancel.
- `provider` calls the plugin provider with the server's argument and an `AbortSignal` the callback's cancel aborts. A
  text answers `{ success, content }`. A text over `MAX_PROVIDER_TEXT_CHARS` (4 Mi characters) or a provider no longer
  loaded is a `hook` failure.
- A `provider` stream is read here and sent as `chunk` messages with the text so far, the first at once, then at most
  every 50 ms (`PROVIDER_CHUNK_INTERVAL_MS`) and at the end, before the answer `{ success: true, streamed: true }`. A
  failed stream is read whole into the answer. Either reader is cancelled when the callback ends first.
- `mcpList` and `mcpTool` answer for an MCP that lives in the tab: a `plugin:` MCP as it is registered now, or
  `internal:fs`/`internal:googlesearch` through `readyTabClient` (`mcp.md`; the handshake may show a directory picker or
  a credential prompt). A client's throw is a `hook` failure.
- A duplicate or same-page `replay` resends the cached answer and never runs twice; a `replay` the page has no state
  for, as after a reload, is refused (`failed`/`protocol`).
- A cancelled callback that settled, or one whose answer crossed the cancel, is reported drained
  (`reportCallbackDrained`, `POST /api/generations/:id/drained`), which frees the lane the server kept for it.
- A replacement child of the top live parent waits while that parent's cancelled child hooks drain. Only one live child
  is admitted, and it never starts after its own deadline; the server owns timeout outcomes.

### Web Push

`src/ts/network/pushNotifications.ts`: this browser's Web Push. The file header states the model, and the function and
flag comments state enable, disable, the banner, and the flags' storage fallback.

- `startPushNotifications` runs after `startRouter` in `bootstrap.ts`. `onCompletionPush` receives the chat of the
  worker's `risu-push-completion` messages (a checked chat route, `shared/notifications.ts` `parseChatRoutePath`), and
  `bootstrap.ts` passes `serverCommands.ts` `refreshChatAfterPush` ([chat pipeline](chat-pipeline.md)).
- Each chat has its own tag (`completionNotificationTag`), so a later notice of a chat replaces only that chat's. The
  server sends the tag's hash as the push `topic`, so a push service replaces only that chat's undelivered completion.
- A shown page closes the completion notifications of every chat, picked by the tag's prefix; a `push` `dismissedByPage`
  diagnostic event records the count.
- `reconcilePush` reads `/api/push/key` on each sync (the boot's read serves its first), so an open tab follows a server
  key change. When the read fails, the sync goes on with the last key read but replaces no subscription made for another
  key, and fails with the read's error.
- The `risu-push-registered` localStorage stamp (`{ endpoint, p256dh, auth, serverKey, at }`) skips an identical
  registration for `PUSH_REGISTRATION_REFRESH_MS` (24 h); a new endpoint, changed keys, a new server key, or a click to
  enable always registers.
- The stamp is read and written only inside the push lock, and invalid evidence causes a PUT. A successful PUT stamps
  it; a failed PUT, a disable, an unsubscribe, or a successful server removal of its endpoint clears it.
- The client cannot inspect the server subscription list: an identical subscription dropped by a delivery 404/410 or the
  50-entry cap returns at the first sync after the stamp is 24 h old, or immediately by turning this browser off and on.
- `enablePushOnThisBrowser` must run inside a click: the permission request is its first step.
- An `unsubscribe()` that rejects or resolves `false` is reported in `error`, the opt-out stays, and the settings' off
  button alerts it. While the browser stays opted out it is retried at the next sync (`risu-push-pending-unsubscribe`).
  A failed server removal is retried at the next sync as well.
- Enable, disable, and sync run one at a time through `navigator.locks.request("risu-push", ...)` across tabs when
  available, otherwise through the in-tab chain. The enable permission request stays synchronous before the queue or
  lock.
- Reconciliations waiting for the queue or lock share one promise until the task starts; one already running allows one
  further queued run. Enqueueing enable or disable ends that fold, preserving action order.
- `pushBrowserState` (a store) feeds `NotificationToggle.svelte` and `src/lib/Others/PushPrompt.svelte` (the one-time
  banner, mounted in `App.svelte` after loading). A failed enable from either is alerted with
  `pushNotifications.failed`.

## Flows

`globalFetch`:

1. Applies `bodyIntercepterStore` interceptors, timeout, and local-network policy.
2. Picks a transport, in order: a qualifying local-network route → the proxy; otherwise plain `fetch` (localhost hosts,
   `plainFetchForce`/`usePlainFetch`), userscript `userScriptFetch`, or the proxy.
3. Proxy target: same-origin `/proxy2` on the self-host server.
   - Headers: `risu-url`, `risu-header` (encoded JSON), optional `risu-auth` and `x-risu-tk`, timeout.

`fetchNative`:

1. The optional body is a string, `Uint8Array`, or `ArrayBuffer`. The internal method defaults to POST; only GET and
   HEAD discard a body, while DELETE/PATCH keep it.
   - The plugin `nativeFetch` adapter (`v3.svelte.ts`) adapts only `method`, `headers`, `body`, and `signal` and
     defaults to GET. It normalizes record/pair headers, the sandbox-supported forms, before its sensitive-header scan,
     takes string, ArrayBuffer, ArrayBufferView, and Blob bodies (any other throws), supplies string/Blob content types
     when absent, and refuses GET/HEAD bodies.
2. A qualifying local-network route goes through `/proxy2`.
3. Otherwise userscript `userScriptFetch` when present, else a direct `fetch`.

## State

- `fetchLog[]` is private, this tab's list only (the durable history is the server's). `getFetchLogs` exposes the live
  array (the popup's "This tab" and plugins' `getFetchLogs`); its identity stays fixed.
- Every writer (including `addFetchLogInGlobalFetch`) uses `writeFetchLog`, which trims the live array in place to
  `FETCH_LOG_MAX_ENTRIES` (20) and `FETCH_LOG_MAX_CHARS` (16 Mi UTF-16 code units of `body`, `header`, and `response`),
  repairing an already oversized list too. The newest entry always survives whole, even alone over budget.
- `getFetchData` finds an entry by `chatId`, and `addFetchLog` returns 0. `appendFetchLog(entry)` adds an entry the
  server built (the `log` events of `/api/llm/request`, credentials redacted): the provider calls the server makes
  appear in the tab's request log.

## Coupling

- Job client and channel: `shared/jobs.ts` is the message contract. The server job, the channel, and call dispatch
  (`server/src/jobs/channel.ts`) are in [server generation](server-generation.md#generation-channels); plugin hooks and
  the API a plugin sees are in [plugins](plugin-sandbox.md).

## Invariants

- Use `globalFetch`/`fetchNative` for every remote call so that proxy, Node routing, and logs apply; a call that needs a
  stored LLM credential uses `auxFetch` with a `server/src/llm/auxOps.ts` row instead (the tab never reads a
  credential).
- Do not bypass the proxy auth headers. On Node, the server's `sanitizeTargetUrl` is a second SSRF boundary for proxy
  jobs only.
- The job channel's rules (UI order, the barrier, one root callback) are in the `jobChannel.ts` header; its failure
  classes are under [Job channel](#job-channel).

## Recipes

- Change network routing:
  1. Edit `globalFetch`, `fetchWithProxy`, and `fetchNative`.
  2. Update `server/src/routes/proxy.ts` if the contract changes.
  3. Verify direct, proxied, local-network, abort, and timeout behavior.
- Add a job call (`shared/jobs.ts`; client `jobChannel.ts`; server `server/src/jobs/channel.ts`). A callback needs
  `CallbackName`, `CallbackPayloads`, `runHook`, and `hasHook`; a plugin hook also needs `GenerationHooks`,
  `NO_GENERATION_HOOKS`, `registeredHooks`, and `parseGenerationHooks`. A notice needs `GenerationNotice` and
  `applyEffect`, or `showNotice` with `QUEUED_NOTICES`, and `MODAL_NOTICES` if modal. A question needs
  `GenerationQuestion` and `ask`.

## Tests

- Vitest: `pnpm --silent test:agent src/ts/network src/ts/globalApiNativeFetch.test.ts`.
- Client test fakes: job-follow tests use `FakeSocket` and fake timers; push tests use
  `fakeSubscription`/`FakeNotification`. Typed shared double: `src/ts/network/tests/generationJobsMock.ts`.
- Browser probe: `util/playwright/checkJobProtocol.mjs` (a real v3 plugin provider answers job callbacks,
  [test-harness](test-harness.md)). `slow`: none.
- Not tested: `globalFetch` routing beyond `fetchNative` method/body handling.

## Known Hazards

### Issues

- A tab MCP tool call from the job channel (`getToolList`, `callTool`) has no abort signal: once it starts, ending the
  request does not stop it.

### Limitations

- A plugin hook already inside `invokeHook` cannot be aborted: a cancellation skips the later hooks, but the running one
  finishes, its writes flush, and it holds the callback lane until it settles. Decision: RisuNest Small Wins D4 and
  Per-Chat Send D1, [archive](../archived-plan/README.md).
- A `provider` callback (a plugin provider model of a server job) is the tab's outstanding callback for as long as its
  stream is read. The server sends no other root callback of this tab meanwhile, and one that arrives anyway is refused
  ("A callback may run only inside the outstanding one"). Decision: Per-Chat Send D1,
  [archive](../archived-plan/README.md).
- A cancelled hook that never settles keeps refusing roots (and plugin `sendChat`) until the page reloads. The server
  stops holding its lane `CANCELLED_CALLBACK_DRAIN_MS` after the cancel, so a later job's root callback is then refused
  rather than queued forever. Decision: Per-Chat Send D1, [archive](../archived-plan/README.md).
- The job owner identity's claim marker is copied with `sessionStorage`, so it reflects the source page when copied, not
  now: a tab duplicated after its page released the id on `pagehide` and before the next page claimed it shares the id
  with that page, and a tab killed without `pagehide` (and not reported as `wasDiscarded`) mints a new id on return and
  loses reload recovery of its jobs. Decision: U1, [audit](../audit/job-protocol-2026-10-29.md).

### Gotchas

- An unloaded provider fails its `provider` callback, so the server reports the request as
  `Plugin Error from <provider>: ...`, not as the unknown-plugin message.
