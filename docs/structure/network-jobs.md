# Network and Jobs: Fetch Routing, Aux Fetch, Generation Job Client, Job Channel, Web Push

## Scope

- Owns the tab's network: `globalFetch`/`fetchNative` routing and the proxy headers, this tab's in-memory request log,
  `auxFetch` for calls that need a stored LLM credential, the local-network policy, the generation job client (ids,
  saved jobs, the follow, events, stages, retry counts), the job channel dispatcher (notices, questions, hooks,
  callbacks, MCP in the tab), and this browser's Web Push.
- Paths: the fetch functions and log of `src/ts/globalApi.svelte.ts`, `src/ts/network/` except
  `src/ts/network/requestHistory.ts` ([diagnostics](diagnostics.md)), `src/ts/network/eventFeed.ts` and
  `src/ts/network/socketLiveness.ts` ([live-updates](live-updates.md)); `shared/localNetwork.ts` and
  `shared/{logRedaction,notifications}.ts`. The hydration memory in `src/ts/network/jobChannel.ts` belongs to
  [chat-store](chat-store.md).
- Not here:
  - The server job, its channel, and call dispatch → [server generation](server-generation.md#generation-channels).
  - Plugin hooks and the API a plugin sees → [plugins](plugin-sandbox.md); the MCP clients a callback reaches →
    [mcp](mcp.md).
  - Provider request bodies → `llm-requests.md`; server-side proxy routes → `self-host-server.md`.
  - The live-update feed's save loop → [live-updates](live-updates.md#feed-connection); the durable request history →
    [diagnostics](diagnostics.md).
  - The asset transport → [assets](assets.md); the alerts a notice maps to → [global-api](global-api.md).

## Files

The request-log viewer, browser collector, reports, and support sharing are documented in [diagnostics](diagnostics.md).
The transport below retains this tab's in-memory log.

### Network clients

- `src/ts/globalApi.svelte.ts`: `globalFetch`, `fetchWithProxy`, `fetchNative`, and the tab-log helpers. Their comments
  own routing, proxy headers, timeouts, and log limits.
- `shared/localNetwork.ts`: host classification shared with the server request layer; `isLocalNetworkHost`,
  `isLocalNetworkUrl`. `src/ts/network/localNetwork.ts` is the client re-export.
- `src/ts/network/auxFetch.ts`: transport for stored LLM credentials; `auxFetch`, `auxFetchJson` and their contracts.
- `src/ts/network/channelCallSource.ts`: lookup of a captured callback's live targets; `channelCallTargets`,
  `setChannelCallSource` and the module header.
- `src/ts/network/eventFeed.ts`: `/api/events/ws` client, owned by [live-updates](live-updates.md#feed-connection);
  `startEventFeed`.
- `src/ts/network/socketLiveness.ts`: shared liveness for job follows and the feed, owned by
  [live-updates](live-updates.md); `watchSocket`, `watchResume` and the module header.

### Generation job client

- `src/ts/network/generationJobs.ts`: transport; header contracts cover identity and saved jobs. Look up
  `generationClientId`, `savedGenerationJobs`, `rememberGenerationJob`, `forgetGenerationJob`.
- Admission/control: `createGenerationJob`, `GenerationCreateError`, `GenerationBusyError`, `GenerationStaleError`,
  `ChatBindingRefusedError`, `ChatLoreOverrideOrphanedError`, `readGenerationJob`, `abortGenerationJob`,
  `takeoverGenerationJob`, `requestGenerationHandoff`.
- Socket/events: `GenerationFollow`, `followGenerationJob`, `applyGenerationEvent`, `releaseGenerationJob`,
  `detachGenerationJob`, `resyncAfterLocalWork`, `requestResync`, `dispatcher`.
- `src/ts/network/handoff.ts`: local preferences, offers, acceptance, presence and manual requests; module contract,
  `replaceHandoffOffers`, `receiveHandoffOffer`, `setHandoffWork`, `connectedClients`, `handoffTargets`, `handOffJob`.
  `src/lib/Others/HandoffStatus.svelte` renders worker progress.
- `src/ts/network/remoteHost.ts`: device-local `hostMode` (`localStorage` `risu-remote-host`, `preference`) and the
  newest ten acknowledged command states (`hostCommandLog`, `noteHostCommand`). The mode joins feed registration as
  `host`; `jobChannel.ts` skips `tts` and `notification` notices while it is on. Completion Web Push is unchanged.
- `receiveHostCommand` reads a relay command over authenticated HTTP, holds plugin work through startup and the send,
  pins and selects its chat, and runs `sendChat` with the sender's ids and returned reports. Duplicate frames stop the
  active run or repeat its latest report. No composer or draft state enters the host's send.
- A `reload` command (`mode` `plugins` or `page`) holds no plugin work. `plugins` reports `running`, awaits
  `reloadPluginsWhenIdle` ([deferred reload](plugin-sandbox.md#deferred-reload)) and reports `done` with its `outcome`.
  `page` saves its id (no save: `done` `notReloaded`, no reload), reports `running`, flushes with a bound and reloads;
  the next page reports `done` with `bootPluginLoadOutcome`. A reload id runs once per page: recovery reserves it before
  any await, and a later frame only repeats its report, never a second read (which would supersede the saved attempt).
- `requestHostReload` is the requester: it offers the two modes, always confirms `page` (progress names a job's creator,
  not a takeover's owner), posts a new command id and polls its status (state frames reach only `remoteSend.ts`'s
  waiters) for up to two minutes, then shows one outcome toast. Settings → Display host rows and Settings → Plugins
  offer it.
- Relay reads and serialized state reports use `/api/remote-commands`, the resource epoch and the read's attempt. Newer
  states replace queued retries; transient failures retry with bounded waits for the open-command lifetime. Report texts
  shrink to the body cap; acknowledged states enter the lock screen list.
- `src/ts/network/remoteSend.ts`: the sender's side. Device-local `remoteSend` (off), `remoteSendHost` (a name;
  `hostTargets` in `handoff.ts` picks its newest host registration) and `remoteSendFallback` (on); `remoteSendEligible`,
  `sendChatRemotely`, `receiveRemoteCommandState` (the feed's `remoteCommandState` frames) and `reconcileRemoteSends`
  (each same-epoch hello). The module header owns the contract; see [Remote send](#remote-send).
- Remote send UI: Settings → Display (`RemoteHostControls.svelte`) edits the three preferences and lists `hostTargets`;
  the composer's `RemoteSendMarker.svelte` names the host and whether it is connected ([UI](ui-theming.md#composer)).

### Job channel

- `src/ts/network/jobChannel.ts`: dispatcher of notices, questions and tab callbacks; module header,
  `ChannelTransport.viewing`, `handleChannelEvent`, `runHook`, `runCallback`, `CallbackFailed` (failure mapping),
  `drainUi`, `endJobChannel`, `registeredHooks`, `replaySkippedListeners`. For a new call, see [Recipes](#recipes).

### Web Push

- `src/ts/network/pushNotifications.ts`: this browser's push lifecycle and page notifications; module header,
  `PushAvailability`, `PushBrowserState`, `pushBrowserState`, `startPushNotifications`, `reconcilePush`,
  `ensureSubscribed`, `enablePushOnThisBrowser`, `disablePushOnThisBrowser`, `dismissCompletionNotifications`,
  `showCompletionNotification`.
- `shared/notifications.ts`: completion text, tags and worker payload shared with the server; `completionNotification`,
  `completionNotificationTag`, `parseChatRoutePath`, `COMPLETION_NOTIFICATION_TITLE`, `NOTIFICATION_ICON`,
  `PUSH_REGISTRATION_REFRESH_MS`.

## Flows

### Plugin fetch boundary

- The plugin `nativeFetch` adapter in `src/ts/plugins/apiV3/v3.svelte.ts` defaults to GET and passes only method,
  headers, body, and signal to `fetchNative`. It normalizes record/pair headers before the sensitive-header scan,
  accepts string, ArrayBuffer, ArrayBufferView, and Blob bodies, supplies absent string/Blob content types, and refuses
  GET/HEAD bodies. `fetchNative` owns internal routing and timeout behavior.

### Auxiliary credentials

- Model discovery (`src/ts/model/modellist.ts` `registerModelDynamic`, `src/ts/model/openrouter.ts`,
  `src/ts/model/ollama.ts` cloud tags) and NanoGPT (`src/ts/model/nanogpt.ts`) use `auxFetch` to reach the server's
  credentialed operations in `server/src/llm/auxOps.ts`. The tab makes no `openai-completions` call; that server
  operation remains available.
- OpenAI TTS (`src/ts/process/tts.ts`), DALL-E/Imagen (`src/ts/process/stableDiff.ts`), Whisper
  (`src/lib/Playground/PlaygroundSubtitle.svelte`), and embeddings (`src/ts/process/memory/hypamemory.ts`,
  `src/ts/process/memory/hypamemoryv2.ts`, unless the processor has its own key) also use that transport. TTS with a
  custom URL, a stored key, and no own key alerts `ttsCustomUrlNeedsKey`.

### Job recovery

- Boot resumes saved jobs through `resumeServerJobs` / `followJobToEnd` (`src/ts/process/serverCommands.ts`). Their
  contracts cover recovery, roles, warnings and late listeners. Control-response 412s reach the resource client's
  `epochMismatch` and resource sync's restore halt.
- `handoff.ts` holds plugin work through `pluginsStarted` and takeover; the follow holds it through attach and, when
  needed, terminal application and late listeners.
- `remoteHost.ts` saves `{ commandId, epoch, attempt, kind? }` in `sessionStorage` `risu-remote-host-commands` before
  sending or reloading (`kind` is a reload's mode). Final acceptance or a permanently closed/lost attempt removes it.
  The feed's first matching hello calls `recoverHostCommands` even with host mode off: a saved send or `plugins` reload
  reports `uncertain` before the same id can be read again, a saved `page` reload reports `done` after the boot's plugin
  load (not after resumed jobs or idle); other epochs are discarded.

### Remote send

- `runSend` (`src/ts/process/index.svelte.ts`) routes an eligible send to `sendChatRemotely` after `beginLocalSend`:
  input, `userMessageId` and `requestId`, not in host mode, not `localOnly`, with no continue, reroll, speaker, preview
  or plugin context. The reservation covers the remote wait and a fallback. It pins the chat, runs `prepareServerJob`
  (the job preflight of `serverCommands.ts`), and posts the command with the request id as its id (`uncertain` when the
  send is marked `requestUncertain`); a retry goes to the host it went to while that host stays connected.
- The waiter is installed before the post. Frames are wakeups for status reads; a status is also read every
  `REMOTE_COMMAND_PICKUP_MS` and after each hello. The post's own open answer is never an outcome, and a re-posted
  `uncertain` without a frame ends uncertain after `REMOTE_COMMAND_PICKUP_MS`. An `uncertain` ends the send; a later
  result is ignored.
- Definite (no connected host of the name, `targetUnavailable`, `targetFull`, 413, `expired`, `refused`): the fallback
  (`sendChatOnServer` with the same ids, after a `fallback` toast with the reason) when it is on and the send is not
  marked, else a toast; a marked send stays uncertain. `commandChanged` keeps it uncertain. A `done` result's notices
  are one toast; the chat is read (`readRecoveringChat`); a failed result's `loreStop` goes to the caller, else its
  errors or the "shown on the host" line, each once per command id.
- Uncertain: an `uncertain` state, `forgotten`, a status of `unknownCommand`, a post or status read without an answer,
  `cancelled` without a Stop, or the host absent from presence for 60 s.
- Stop after the post: the relay cancel (its answer is not read) and, at once, `sendChatOnServer` with the aborted
  signal, `requestUncertain` and a discarded `reports` sink, which cancels the generation by request id
  (`cancelGenerationRequest`) and creates nothing. A settled answer ends the send; otherwise it waits for the host's
  closed state. A stopped send never falls back and shows no host report.

### Job callbacks

- The send guard in `src/ts/process/request/request.ts` reads `channelCallTargets` using the captured
  `PluginCallContext.channelCall`. The callback registry is read when `runHook` runs, not when the job is created
  ([plugins](plugin-sandbox.md)); cancellation and the live lookup govern whether a captured context still applies.

### Push delivery

- `src/ts/bootstrap.ts` calls `startPushNotifications` after `startRouter`. The server's completion payload reaches
  `public/sw.js`, which shows it and sends `risu-push-completion` to pages. The client checks the chat route with
  `parseChatRoutePath`; boot wires `onCompletionPush` to `refreshChatAfterPush` in `src/ts/process/serverCommands.ts`
  ([chat pipeline](chat-pipeline.md)).
- `server/src/push/pushService.ts` sends the `completionNotificationTag` hash as the push `topic`, so a service replaces
  only that chat's undelivered completion. Shown notices use the per-chat tag in `shared/notifications.ts`.
- The client cannot inspect the server's subscription list. An identical subscription removed after delivery 404/410 or
  the 50-entry cap returns at the first eligible sync after the `risu-push-registered` stamp is 24 h old, or by turning
  this browser off and on.
- `pushBrowserState` feeds `src/lib/Setting/Pages/Display/NotificationToggle.svelte` and
  `src/lib/Others/PushPrompt.svelte`, the one-time banner mounted by `src/App.svelte` after loading. A failed enable
  from either alerts `pushNotifications.failed`.
- A failed disable (`error`, which the settings' off button alerts) retries at the next sync:
  `disablePushOnThisBrowser`, `flushPendingUnsubscribe`, `flushPendingRemoval` comments.
- Without Web Locks the push queue is per tab, so another tab can opt this browser out while `ensureSubscribed` waits on
  `subscribe`: it reads the opt-out flag again after `subscribe` and undoes a subscription it just made, unregistered.

## State

- `handoff.ts` state is in its module contract and `setHandoffWork`; `eventFeed.ts` feeds offers and presence, and
  `serverCommands.ts` owns roles and lifetime.
- `fetchLog[]` is private, this tab's list only (the durable history is the server's). `getFetchLogs` exposes the live
  array (the popup's "This tab" and plugins' `getFetchLogs`); its identity stays fixed.
- Every writer uses `writeFetchLog`, which redacts copied credential headers and OAuth secret fields in form/JSON
  request and response bodies with `shared/logRedaction.ts` before retaining them, leaving transport data unchanged. Its
  comment and `FETCH_LOG_MAX_*` constants own in-place trimming; the server's request history shares the header
  redactor.
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
- Do not bypass the proxy auth headers. `/proxy` and `/proxy2` accept any target after JWT authentication, with no
  address or local-network restriction; see [Proxying](self-host-server.md#proxying) and the
  `server/src/routes/proxy.ts` contract.
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
- Tab request-log retention: run `src/ts/globalApiRetention.test.ts`, included in the
  [assets test command](assets.md#tests).
- Client test fakes: job-follow tests use `FakeSocket` and fake timers; push tests use
  `fakeSubscription`/`FakeNotification`. Typed shared double: `src/ts/network/tests/generationJobsMock.ts`.
- Browser probe: `util/playwright/checkJobProtocol.mjs` (a real v3 plugin provider answers job callbacks,
  [test-harness](test-harness.md)). `slow`: none.
- `globalFetch`'s default content type per route (none for a GET): `src/ts/globalApiNativeFetch.test.ts`.
- Not tested: `globalFetch` routing beyond `fetchNative` method/body handling and that default.

## Known Hazards

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
  loses reload recovery of its jobs. Decision: U1, [audit](../reports/audits/job-protocol-2026-10-29.md).
- A remote send ends uncertain whenever its state cannot be established (a status read that races the post, the sender's
  own feed down for 60 s, a host result after the end). The draft keeps its ids and the next Send re-posts the command.
  A Stop whose chat has left the list sends no generation cancel. Decision: Remote Host plan (slice 4).
- A notification click whose route is `/` (a payload without a chat route, `safeRoute` in `public/sw.js`) focuses an
  existing window or opens `/` if none exists. Whether the enable button keeps its user activation when it waits behind
  a reconcile, and whether `navigator.serviceWorker.ready` names the old worker during an upgrade, are browser behaviors
  the tests cannot show (left to a real-browser check). Decision: Web Push (`e148f7276`,
  [archive](../archived-plan/README.md)); Found Issues Clearance (owner, 2026-11-09).

### Gotchas

- An unloaded provider fails its `provider` callback, so the server reports the request as
  `Plugin Error from <provider>: ...`, not as the unknown-plugin message.
