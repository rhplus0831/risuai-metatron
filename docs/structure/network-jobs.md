# Network and Jobs: Fetch Routing, Aux Fetch, Generation Job Client, Job Channel, Web Push

## Scope

For a tab's outbound fetch, proxy selection, auxiliary credential, generation socket, remote host or Web Push, start
here. A job handoff transfers responsibility for browser callbacks on an existing job. A remote send asks another
browser to start the send and provide those callbacks.

- [Server generation](server-generation.md#generation-channels) owns job admission and server-side channel dispatch.
  [Live updates](live-updates.md) owns the tab's feed socket, including the progress snapshot an observing tab sees
  before a reply. [Chat store](chat-store.md) owns hydration inside `src/ts/network/jobChannel.ts`.
- [Plugins](plugin-sandbox.md) owns hook registration, consent and guest execution. [MCP](mcp.md) owns the clients
  reached by tool callbacks. Provider requests and prompt interception belong to [LLM requests](llm-requests.md).
- [Self-host server](self-host-server.md) owns the proxy and remote-command HTTP routes, [diagnostics](diagnostics.md)
  the durable request history, [assets](assets.md) the asset transport, and [global API](global-api.md) the notice UI.

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
  `takeoverGenerationJob`, `requestGenerationHandoff`, `releaseCompletionHold` (at most three tries, a retry only when
  no answer came; never throws).
- Socket/events: `GenerationFollow`, `followGenerationJob`, `applyGenerationEvent`, `releaseGenerationJob`,
  `detachGenerationJob`, `resyncAfterLocalWork`, `requestResync`, `dispatcher`.
- `src/ts/network/handoff.ts`: local preferences, offers, acceptance, presence and manual requests; module contract,
  `replaceHandoffOffers`, `receiveHandoffOffer`, `setHandoffWork`, `connectedClients`, `handoffTargets`, `handOffJob`.
  `src/lib/Others/HandoffStatus.svelte` renders worker progress.
- `src/ts/network/remoteHost.ts` receives command frames and runs or reloads the selected host. `hostMode` is
  device-local. `receiveHostCommand`, `recoverHostCommands` and `requestHostReload` handle a command, its saved attempt
  and a requester's reload, respectively. See [remote host commands](#remote-host-commands).
- `src/ts/network/remoteSend.ts` owns the sender's `remoteSendEligible`, `sendChatRemotely` and
  `receiveRemoteCommandState`. Device-local preferences choose a host by name and allow local fallback.
  `RemoteHostControls.svelte` in Settings → Device Link edits those preferences; `RemoteSendMarker.svelte` shows the
  selected host's connection in the composer ([remote send](#remote-send)).
- `util/headlessHost.mjs` runs an unattended host on loopback. For its dialog handling, configuration and standing
  plugin grants, see [headless host](build-test-platforms.md#headless-host).

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

- Use `globalFetch` for a buffered result and `fetchNative` for a streamed `Response`. Both consult the local-network
  classification on an explicit local route. The buffered path otherwise selects direct, userscript, or proxy fetch; the
  streaming path selects userscript or direct fetch. Their function comments specify headers, error and abort behavior.
- The plugin `nativeFetch` adapter in `src/ts/plugins/apiV3/v3.svelte.ts` defaults to GET and passes only method,
  headers, body, and signal to `fetchNative`. It normalizes record/pair headers before the sensitive-header scan,
  accepts string, ArrayBuffer, ArrayBufferView, and Blob bodies, supplies absent string/Blob content types, and refuses
  GET/HEAD bodies. Both plugin fetch adapters check the URL. Plugin body interceptors are opt-in transport hooks;
  configured request interception inserts prompt messages in the
  [LLM request layer](llm-requests.md#request-interception).

### Auxiliary credentials

- `auxFetch` waits for queued credential ops through `awaitSecretWrites`. A failed or expired save rejects that wait
  while the save loop can retry the queued op. Calls through a stored profile first wait for its resource flush. See
  [Credential writes](resource-sync.md#credential-writes) and the shared [auth check](resource-sync.md#transport), which
  bounds noninteractive steps and can start fresh after timeout.
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
- A job follow's `resyncAfterLocalWork` retries a rejected [resource flush](resource-sync.md#flushresources) while
  following the job. New-chat memory [inheritance](structured-memory/lifecycle.md#copies-and-branches) and
  [restore](structured-memory/lifecycle.md#chat-files) wait for the create to settle, then bound their own requests.
- `handoff.ts` holds plugin work through `pluginsStarted` and takeover; the follow holds it through attach and, when
  needed, terminal application and late listeners.
- `remoteHost.ts` saves `{ commandId, epoch, attempt, kind?, clientId }` in `sessionStorage` `risu-remote-host-commands`
  before sending or reloading (`kind` is a reload's mode, `clientId` the id the command was read under). Every report of
  the attempt carries that id, not the page's own: the relay answers a report from another id `unknownCommand`, and the
  page after a reload can hold a new one. Final acceptance or a permanently closed/lost attempt removes the entry.
- The feed's first matching hello calls `recoverHostCommands` even with host mode off: a saved send or `plugins` reload
  reports `uncertain` before the same id can be read again, a saved `page` reload reports `done` after the boot's plugin
  load (not after resumed jobs or idle); other epochs are discarded.

### Remote host commands

- The host advertises `hostMode` on the live-update feed. `receiveHostCommand` reads the body through the
  [authenticated relay](self-host-server.md#remote-command-routes). A send pins and selects the target chat and holds
  plugin work through startup and the send. It passes the sender's ids, original draft, lore-stop flag and action fields
  to `sendChat` under `localOnly`. The versioned read prevents older hosts from turning Continue or reroll into an
  ordinary send.
- `receiveHostCommand` checks `canSelectCharacter` before and after plugin startup and returns `chatMissing` for an
  archived group before pinning or selecting its chat.
- The host serializes state reports for one read attempt. `hostCommandLog` holds the ten latest command states for the
  lock screen. The host suppresses its job's TTS and page notification notices. When notifications and an opted-in
  running v3 plugin are enabled, the send takes a mutation mark and requests a
  [server push hold](server-generation.md#completion-holds).
- A settled failure can release the hold immediately. On success the host queues its terminal report and waits for the
  opted-in plugins to go quiet, then flushes the marked work. Activity during the flush requires another quiet period; a
  failed or lossy flush waits until the cap. This wait holds neither the chat pin nor plugin work. An uncertain send or
  epoch change leaves release to the server deadline.
- `requestHostReload` polls HTTP status for one outcome. A plugins-only reload waits for
  [deferred reload](plugin-sandbox.md#deferred-reload). A confirmed page reload saves its attempt before navigating and
  reports the next boot's plugin load outcome. Without a saved attempt it reports `notReloaded`.
  [Job recovery](#job-recovery) covers replay after reload.

### Remote send

- `runSend` (`src/ts/process/index.svelte.ts`) routes an eligible send to `sendChatRemotely` after `beginLocalSend`: a
  caller-owned `requestId` (with `userMessageId` when there is input), not in host mode, not `localOnly`, with no
  preview or plugin context. The screen's Send, Send Draft, Continue and in-place reroll carry one (`sendChatMain` mints
  a fresh id per press for a Continue without input and an in-place reroll); auto mode, an empty Send, the removal
  reroll and the other `sendChat` callers carry none and stay local. The reservation covers the remote wait and a
  fallback.
- The adapter pins the chat, runs `prepareServerJob` (the job preflight of `serverCommands.ts`), and posts the command
  with the request id as its id (`uncertain` when the send is marked `requestUncertain`); a retry goes to the host it
  went to while that host stays connected.
- A send's wait for the resource flush in that preflight ends on Stop or after 30 seconds (`waitForSendFlush`,
  `SEND_FLUSH_DEADLINE_MS`): before a local job, before the relay post, and on the receiving host. It answers the
  pre-dispatch refusal with any earlier request uncertainty and leaves the shared write running.
- Command jobs and the callers a user waits on end their wait the same way (`waitForResourceFlush` in
  `src/ts/storage/resourceFlushWait.ts`), each through its own failure path; an import that timed out says its entry is
  already listed. When the server stays silent, the caller reaches its save-pending timeout while the shared
  [flush](resource-sync.md#flushresources) continues through backoff after bounded save attempts.
- A Continue without input names the message it continues (`continueMessageId`, the chat's last message when pressed),
  so a message that lands before the host runs is not continued instead. A Continue with input names nothing: its job
  appends the user message and continues it. A Continue or reroll is never retried under its request id (each press is a
  new command, as locally); the adapter forgets such a command at its end.
- The relay's route (`parsePost` in `server/src/routes/remoteCommands.ts`) answers 400 to a send whose fields have no
  effect, so they cannot change the command's retry identity: `continueMessageId` on a plain send, `userMessageId` on a
  Continue without input, `input` or `userMessageId` on a reroll.
- The removal reroll stays local: its bundle history cannot be kept through a host. An uncertain end leaves the host's
  later replies unrecorded, so Undo loses the removed bundle; Undo (`rerollHistory.back`) has no settlement guard while
  the host's job may still write; and a host `busy` refusal is settled without `blockedChats`, so restoration could
  write the removed replies beside the host's other send.
- The waiter is installed before the post. Frames wake status reads; the relay's refused, expired, cancelled or
  forgotten transition can itself settle the wait. Results come from HTTP. Status is also read every
  `REMOTE_COMMAND_PICKUP_MS` and after each hello. The post's own open answer is never an outcome, and a re-posted
  `uncertain` without a frame ends uncertain after `REMOTE_COMMAND_PICKUP_MS`. An `uncertain` ends the send; a later
  result is ignored.
- Definite (no connected host of the name, `targetUnavailable`, `targetFull`, 413, `expired`, `refused`, including the
  relay's `unsupported` for a host on an older contract): the fallback (`sendChatOnServer` with the same ids, after a
  `fallback` toast with the reason) when it is on and the send is not marked, else a toast; a marked send stays
  uncertain. `commandChanged` keeps it uncertain. A `done` result's notices are one toast; the chat is read
  (`readRecoveringChat`); a failed result's `loreStop` goes to the caller, else its errors or the "shown on the host"
  line, each once per command id.
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
- After a disconnect only undelivered `chatOutput` listeners run late. `replaySkippedListeners` uses the current
  listeners and captured chat after the terminal revision is held. The late-replay recipient sees the skipped text-hook
  warning; only the creator sees the warning for delivered listeners whose outcome was missed
  ([generation channels](server-generation.md#generation-channels)).

### Push delivery

- `src/ts/bootstrap.ts` calls `startPushNotifications` after `startRouter`. The server's completion payload reaches
  `public/sw.js`, which shows it and sends `risu-push-completion` to pages. The client checks the chat route with
  `parseChatRoutePath`; boot wires `onCompletionPush` to `refreshChatAfterPush` in `src/ts/process/serverCommands.ts`
  ([chat pipeline](chat-pipeline.md)).
- `server/src/push/pushService.ts` sends the `completionNotificationTag` hash as the push `topic`, so a service replaces
  only that chat's undelivered completion. Shown notices use the per-chat tag in `shared/notifications.ts`.
- A job created with `context.completionHoldMs` has its push held on the server until
  `POST /api/generations/completion-release` names its request id, or until that long after the job ends
  ([completion holds](server-generation.md#completion-holds)); the tab's `notification` notice is not held.
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

- For a new remote action, change `shared/remoteCommands.ts`, the
  [HTTP relay](self-host-server.md#remote-command-routes), and both tab adapters. Check replay identity, older hosts'
  declared action support, cancellation and fallback under uncertainty. Exercise `remoteSend.test.ts` and
  `remoteHost.test.ts` from both ends.
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
- Not tested: the full `globalFetch` route-precedence matrix, including combinations of explicit routing, user
  preference and userscript availability. `src/ts/globalApiNativeFetch.test.ts` covers buffered GET/POST headers on all
  three routes and streaming transport, method/body and abort behavior.

## Known Hazards

### Limitations

- Pre-upgrade work can still name an archived group chat at boot resumption, handoff, completion push refresh or Retry
  of a held write. The refused-data banner offers Export and Discard for that write in place of Open. Decision: owner,
  2026-11-23.
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
  loses reload recovery of its jobs. Decision: U1, [audit](../reports/audits/finished-plans/job-protocol-2026-10-29.md).
- A remote send ends uncertain whenever its state cannot be established (a status read that races the post, the sender's
  own feed down for 60 s, a host result after the end). The draft keeps its ids and the next Send re-posts the command.
  A Stop whose chat has left the list sends no generation cancel. Decision: Remote Host plan (slice 4).
- A host whose command read reached the relay but whose answer was lost runs nothing and reports nothing: the command
  stays `delivered` until the host's next registration notifies it again. Decision: Remote Host plan (slice 3).
- A notification click whose route is `/` (a payload without a chat route, `safeRoute` in `public/sw.js`) focuses an
  existing window or opens `/` if none exists. Whether the enable button keeps its user activation when it waits behind
  a reconcile, and whether `navigator.serviceWorker.ready` names the old worker during an upgrade, are browser behaviors
  the tests cannot show (left to a real-browser check). Decision: Web Push (`e148f7276`,
  [archive](../archived-plan/README.md)); Found Issues Clearance (owner, 2026-11-09).
- A remote command's attempt is kept in the host tab's `sessionStorage` (`remoteHost.ts`). The headless host's own
  restarts (a crashed or closed page, a failed load, a dialog it cannot dismiss, the plugins-off reload) open a new tab
  (`util/headlessHost.mjs` `openPage`) with no record and a new client id: the requesting device shows "no answer" after
  two minutes, and the relay keeps the entry until it drops it. A remote "Reload page" keeps the tab. No chat data is
  lost. Decision: owner, 2026-11-21 (found-issues review): rare, and a fix changes where attempts are stored.

### Gotchas

- An unloaded provider fails its `provider` callback, so the server reports the request as
  `Plugin Error from <provider>: ...`, not as the unknown-plugin message.
