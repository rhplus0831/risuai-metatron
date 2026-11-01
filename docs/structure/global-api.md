# Global API, Network, Utilities, Alerts

## Scope

- Owns: `src/ts/globalApi.svelte.ts`, the client I/O facade:
  - asset I/O,
  - save entry points (the adapter is owned by resource-sync),
  - `globalFetch`/`fetchNative` routing,
  - this tab's in-memory request log,
  - writers,
  - chat-fold state.
- Also owns: `src/ts/util.ts` helpers, the alert protocol (`src/ts/alert.ts`, `src/ts/alertQueue.ts`, and
  `src/lib/Others/AlertComp.svelte`), the network clients in `src/ts/network/` except `requestHistory.ts`
  ([diagnostics](diagnostics.md)) (`localNetwork.ts`, `auxFetch.ts`, the generation job client and channel, the
  live-update feed), `src/ts/sourcemap.ts`, `src/ts/dragTypes.ts`, `src/ts/licenses.ts`, `src/ts/util/inlayTokens.ts`,
  `src/ts/util/koreanSearch.ts`, and the Iris assistant (`src/ts/iris.ts`, `src/lib/Others/IrisModal.svelte`).
- Also owns the asset transport: `src/ts/storage/assetClient.ts`, `src/ts/storage/assetQueue.ts`,
  `shared/assetBatch.ts`.
- Not here:
  - The save format and backends → `persistence.md` (this guide only covers save entry points).
  - Provider request bodies → `llm-requests.md`.
  - Server-side proxy routes → `self-host-server.md`.

## Files

The request-log viewer, browser collector, reports, and support sharing are documented in [diagnostics](diagnostics.md).
The transport below retains this tab's in-memory log.

### Asset sources

`src/ts/globalApi.svelte.ts` turns `assets/` keys into URLs. Each call picks direct mode or the fallback
([Flows](#flows)).

- Direct mode: `getFileSrc`, `holdFileSrc`, `getThumbSrc`, and `getDirectAssetSrc` resolve `/api/asset/<hex(utf-8 key)>`
  at once (`""` for an empty key), with no read, Cache Storage lookup, registration, shared file source, or pin, so
  nothing needs revoking. The worker signs subresource loads and the browser HTTP cache holds the bytes. A missing file
  is not detected here: its element receives a 404.
- Controller loss or a `controllerchange` capability re-probe sends new calls through the fallback until direct mode is
  available again. Switching modes leaves existing fallback sources' pin and hold lifetimes intact.
- `getFileSrc` fallback: returns `/sw/img/<hex>` when the worker holds the file. The page shares Cache Storage with the
  worker, so a hit needs no worker round trip; a miss posts the bytes to `/sw/register/<hex>`, and `/sw/check/<hex>`
  answers when Cache Storage is unavailable.
- `getFileSrc` fallback failures: a worker request is bounded at `SW_REQUEST_TIMEOUT_MS` (10 s). A failed one (an
  uncontrolled page, say) falls back to an object URL (`blob:`, `image/png`) pinned for the page by this plain read, as
  does every load when boot continued without a ready worker. A data URL would inflate the text a display transform
  sends.
- `getFileSrc` fallback loads: concurrent reads of a path share one load. A missing or empty file is never registered
  and resolves `""`, as does a failed load; either is dropped so the next read tries again.
- `holdFileSrc`: returns `{ src, release }` for previews. In the fallback the last release revokes and drops an unpinned
  `blob:` URL after `FILE_SOURCE_RELEASE_GRACE_MS` (100 ms), cancelled by a new hold or plain read so shifted list rows
  can reuse it. Service-worker URLs are never revoked; plain fallback reads stay pinned.
- `getThumbSrc(loc, size: 256 | 512)`: direct mode adds `?w=<size>`; the server answers a WebP thumbnail or a 307
  redirect to the query-free original, which the worker follows. Otherwise it returns `getFileSrc(loc)`'s own promise,
  the full image. Pages without a worker, uncontrolled pages, and fallback loads get no decoded-memory win; this is an
  accepted trade-off.
- `getDirectAssetSrc(loc)`: the direct URL, else `null`. The parser uses it for inlay audio and video
  ([CBS rendering](cbs-rendering.md)).
- `fetchFileSrc`: fetches a displayed URL for rich copy's message images and character/user icons, because the worker
  does not sign `fetch()`. It gives same-origin asset URLs a fresh `risu-auth` token and maps legacy `/sw/img/<hex>`
  URLs to `/api/asset/<hex>`, so already rendered rows remain fetchable after worker activation clears their cache
  entries. Signed requests use `mode: "same-origin"` to prevent cross-origin redirects.
- `withFileSrcFetch`: runs a callback while global `fetch` signs the same requests, for screenshot capture's images,
  computed-style URLs from shared chat styles outside the rows, and fonts. The last of nested runs disables signing and
  restores fetch only if it is still this wrapper; a wrapper retained by another script stays inactive.
- `SCREENSHOT_CAPTURE_OPTIONS` (`src/lib/ChatScreens/screenshotCapture.ts`, `includeQueryParams: true`) keys
  html-to-image's cache by the full URL, so a captured thumbnail never stands in for a later full-size image.
- `setUsingSw`, `setDirectAssets`: boot records worker availability (`registerSw` returned `ready`) and the `/sw/init`
  capability separately. Non-JSON responses (including older workers), missing or false flags, unavailable workers, and
  unsupported browsers leave the capability false. `controllerchange` clears it and probes the new controller; only the
  newest probe can set it again.

### Asset client

`src/ts/storage/assetClient.ts`: the asset files, which `globalApi.svelte.ts` reads and writes through it. Its header
has the routes, the record framing ([batch codec](#batch-codec)), and the retry rule; each function's comment has its
errors.

- `saveAsset`: stores the bytes under `assetKey(data, customId?, fileName?)`, `assets/<sha256>.<ext>` by default. A
  canonical single save first calls `missingAssets` and skips uploading bytes already verified on the server; a failed
  or timed-out check writes anyway.
- `saveAssetBatch(items, { signal? })` passes `{ key, bytes, sha256? }` items to `writeAssets`. Bulk imports use
  `saveAssets` ([queues](#asset-queues)), which supplies the already-computed digest only for items without custom ids.
- The skip rule: `writeAssets` checks the unique canonical names whose caller-computed `sha256`
  (`AssetWriteItem.sha256`) matches the name with `missingAssets` and sends only the missing ones. Custom ids and raw
  overwrites always upload, and any such item prevents skipping every item for its key in that call. A failed check, or
  one with no answer within 20 s, uploads everything.
- `saveAssetBatch`'s `{ signal }` aborts the check, write, and retries and rejects with its reason (`AbortError` for a
  nullish reason), including when all uploads could be skipped.
- `loadAsset`, `readImage`; `loadAssets(keys, { signal? })` reads a batch in key order over `readAssets`. Exporters
  reach it through `loadAssetsInBatches` ([queues](#asset-queues)).
- `missingAssets(names, { signal? })` answers the names the server does not hold verified (absent, empty, corrupt,
  non-canonical, or over its verification budget: see `self-host-server.md`), asking at most 512 names and 64 KiB of
  JSON per request. `MISSING_CHECK_DEADLINE_MS` (20 s) bounds one request, retries and body included, since the check
  only saves an upload.
- Writes go in batches of at most `ASSET_BATCH_CLIENT_RECORDS` (500) records and `ASSET_BATCH_CLIENT_BYTES` (64 MiB) of
  record bytes, headers included (a larger single item goes alone); reads in batches of 500 keys. One batch goes at a
  time, each request retried on its own.

### Asset queues

`src/ts/storage/assetQueue.ts`: the bounded save queues for bulk imports and the batched reads of exports. Its comments
state admission, batching, settlement, and failure.

- `saveAssets(items, { concurrency = 10, onProgress, signal })`: `concurrency` limits loads, not bytes. Admission pauses
  while the queued records reach `ASSET_BATCH_CLIENT_RECORDS` or `ASSET_BATCH_CLIENT_BYTES`, but an async iterator pull
  admitted earlier may still start its load. Other in-flight loads and the write batch add to it, and one item may
  exceed the byte cap.
- The loaded items are written one request at a time through `globalApi.saveAssetBatch`, each within the client caps,
  while the next batch loads. Keys resolve in item order.
- Each loaded item is keyed with `globalApi.assetKey`. An item without a `customId` carries that key's hash as its
  `sha256`, so `writeAssets` skips it when the server holds it verified, while a custom id is always sent.
- `savePickedFiles(files, fileName?)` feeds picked `File`s to it, each read when its slot comes, so a large selection is
  not read up front. `AssetSaveQueue` saves one item per `saveAsset` for a producer whose items arrive over time (the
  in-tab `CharXImporter`).
- `loadAssetsInBatches(keys, { batchSize = 200, signal })` yields `{ index, key, bytes }` in key order over
  `globalApi.loadAssets`. It holds one batch being consumed and one prefetched batch in flight; `batchSize` above
  `ASSET_BATCH_CLIENT_RECORDS` is clamped, and retries are the asset client's.

### Batch codec

`shared/assetBatch.ts`: the batch asset routes' record framing, the backup archive's (`self-host-server.md`), with
`encodeAssetRecordHeader` also the archive's encoder. It runs on both sides: `TextEncoder`/`TextDecoder` and `DataView`
only, no `Buffer`.

- `MAX_ASSET_BATCH_RECORDS` (2000 per request) is the server's cap; `MAX_ASSET_BATCH_NAME_BYTES` is 4096.
- The incremental `AssetRecordParser`: `push` returns the records a chunk completes; `events` yields
  `start`/`data`/`end` with `data` as views into the chunk, so the server streams a record without holding it. Every
  refusal is an `AssetBatchFormatError`.

### Other `globalApi` exports

- Save: `saving` (indicator state, re-exported from the adapter); `loadInternalBackup`.
- Network: `globalFetch(url, GlobalFetchArgs)` is buffered and returns `{ok,data,headers,status}`;
  `fetchNative(url, args)` returns a `Response` or stream; `addFetchLog`, `appendFetchLog`, `getFetchLogs`
  ([State](#state)); `openURL`.
- Writers: `LocalWriter` (the backup record framing `writeBackup`, streamed through `streamsaver`), `VirtualWriter`,
  `BlankWriter`, `AppendableBuffer`.
- Chat and UI: `changeChatTo` and `openPinnedChat` (shared home/rail navigation by `{ chaId, chatId }`) select per tab;
  `createChatCopyName`, `chatFoldedState`, `chatFoldedStateMessageIndex`, `foldChatToMessage`, `toggleFullscreen`.
- `checkCharOrder`: re-exported from `storage/characterOrder.ts` (the character module calls it without importing this
  file) because plugins see this export.

### `util.ts`

`src/ts/util.ts` is the inventory of small helpers: messages and characters, persona accessors, crypto, text, tag lists,
and the rest. What a caller must know:

- `selectSingleFile`, `selectMultipleFile`, and `selectFileByDom` use the DOM picker. `selectSingleFileHandle` gives the
  picked `File` unread, or `null`: the module dialog's `.risum` and `.charx` imports upload it as it is, and the VITS
  model import reads its zip by slices. `selectMultipleFileHandles` gives the `File`s unread, `[]` when none: the asset
  pickers save them with `savePickedFiles`.
- `openKeypairStoreDB`/`saveKeypairStore`/`getKeypairStore`: IndexedDB `DPoPDB` store `dpop`.

### Alert queue

`src/ts/alertQueue.ts`: `createAlertQueue` (the store `stores.svelte.ts:alertStore` is one instance) and
`createDialogKeyGate` (built in `src/ts/hotkey.ts` `initHotkey`). The `AlertQueue` interface comments state each method.

- The alert slot holds one status (`wait`, `progress`, `toast`: the newest replaces it) and a first-in, first-out queue
  of dialogs (every other type), shown one at a time. A dialog supersedes the status set before it, not one set after
  it, which shows once the dialogs close.
- After a dialog closes, the next one shows `NEXT_DIALOG_GAP_MS` (150 ms) later, also one opened after the close;
  meanwhile the store reads `none` with `dialogPending`.
- An identical `normal`, `error`, `markdown` or `wait2` right behind the last queued dialog folds into it (same handle;
  never an error with `jobFailure`).
- The key gate lets a dialog take Enter or Escape only from a stroke that began after it appeared: never a repeat, the
  stroke held when it appeared, or a composing key.
- `hotkey.ts` owns dialog keys; `AlertComp.svelte` has no key handler. Escape answers every dialog with `""`. Enter
  answers `ask`, `normal`, `error`, and an `input` dialog's value; a new accepting type extends that branch.

### Alert helpers and `AlertComp`

`src/ts/alert.ts`:

- `alertData` (discriminated `type`), with optional `chaId` for Branches and `chatRef` for HypaV2. Each target is
  captured when requested, before the dialog waits in the queue.
- Each dialog helper queues its dialog; an awaited one resolves with its own dialog's answer.
- `alertRealmTerms`: true only for Accept. Enter does not accept it; Escape declines.
- `alertCardExport`, character export only: an empty answer (including Escape) returns `{ type: "cancel", type2: "" }`,
  matching the close button's cancel shape; callers ignore the format on cancellation.
- `alertRequestLogs` is the request logs popup.
- `showHypaV2Alert` captures `currentChatRef`; its editor reads `findChat(ref)` and writes `setChatMeta(ref, ...)`,
  showing no editor and writing nothing while that chat is unloaded or has no HypaV2 data.
- `alertWait` and `alertToast` accept an optional `onInstall` callback that captures the exact status object for
  identity-checked cleanup. `alertStore` (here) is a `set` wrapper over the real store `stores.svelte.ts:alertStore`.

`src/lib/Others/AlertComp.svelte` renders the head of `alertStore` (the shown dialog, else the status) and answers a
dialog with `alertStore.answer(msg)`.

- The error alert's "Open in request history" closes the error before opening the history. The request history popup
  passes its own close to `ServerRequestHistory.svelte`, which closes it before its delete confirmation (then opens it
  again) and before a share error.
- `sourcemap.ts:translateStackTrace` translates stack traces; a translation (or its failure) that ends after the shown
  alert changed is dropped, so it never lands in a later error.

### Terminal and reload notices

Both notices live outside `alertStore`, and both components are mounted unconditionally in `App.svelte`, `ReloadNotice`
before `TerminalNotice`. The comments in `alert.ts` and the components state the rest.

- `alertTerminal(msg)`, `terminalNotice`, `acknowledgeTerminalNotice`: the notice the page ends on (the restore notice).
  It resolves only when the user acknowledges it, so no other alert (a toast, an error, `alertClear`, a `wait`) can
  replace or dismiss it. `terminalNoticeShown()` blocks plugin key listeners from opening until reload.
- `src/lib/Others/TerminalNotice.svelte`: a native modal `<dialog>` (the top layer, above every z-index; the page
  inert). Only its OK acknowledges it.
- No key event leaves the terminal dialog: a panel's own `window` listener behind it never sees one, while a capture
  listener still does. `hotkey.ts` runs no shortcut while it is shown.
- `alertReloadNotice(msg)`, `reloadNotice`, `dismissReloadNotice`: the save adapter's reload notice (`resourceReloaded`:
  a conflict replaced a local change). Latched until dismissed: one notice per episode on screen.
- `src/lib/Others/ReloadNotice.svelte`: a fixed, non-modal panel (`role="status"`) above the alert overlay (`z-[60]`).
  The page behind it stays live. The terminal notice covers it.
- While recovery drafts exist and the recovery dialog is closed, `ReloadNotice` also shows the drafts message with its
  own Dismiss and a Review button that opens the [recovery dialog](draft-recovery.md#recovery-drafts)
  (`RecoveryDrafts.svelte`, rendered here outside the notice so Settings can open it after a dismissal;
  [ui-theming](ui-theming.md)).

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
  `internal:fs`/`internal:googlesearch` through `readyTabClient` (`plugins-mcp.md`; the handshake may show a directory
  picker or a credential prompt). A client's throw is a `hook` failure.
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

### Other modules

- `src/ts/util/koreanSearch.ts` (client only, over `es-hangul`): the shared text matcher of list filters and settings
  search, with `prepareQuery`, `matchText` (0 or a `MATCH_SCORE` tier), and `matchesAny` as the lists' boolean. An
  all-choseong query takes no later tier, and romanized queries are not matched. Derived forms of a text are computed
  per call, never cached by text.
- `src/ts/dragTypes.ts`: `RISU_*_DRAG_TYPE` custom MIME types. They keep in-app drags from being treated as file
  imports.
- `src/ts/iris.ts` `getIrisSystemPrompt`, and `IrisModal.svelte`: a visual-novel-style assistant. It calls
  `requestChatData(..., 'otherAx')` and persists the dialogue in `irisDialogue`, a `ui` field saved on the server; older
  browser copies are imported at boot.

## Flows

Asset sources use direct URLs only while the controlling worker reports `directAssets: true`; otherwise calls use the
fallback in [Asset sources](#asset-sources). Direct-mode 401s and network failures do not retry through `readAsset`.
Worker details: [build/test](build-test-platforms.md); asset route and HTTP cache behavior:
[server](self-host-server.md).

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

Alerts:

1. The caller runs, e.g., `await alertConfirm(msg)`, which queues its dialog in `alertStore` (`open`).
2. `AlertComp` renders it once the dialogs before it closed (`NEXT_DIALOG_GAP_MS` after the previous one).
3. A button, Enter (`ask`, `normal`, `error`: `"yes"`), or Escape (`""`) answers the shown dialog (`alertStore.answer`).
4. The dialog's `closed` resolves the helper with that answer; the next dialog follows after the gap.

## State

- Asset logical keys (`storage/assetClient.ts`): `assets/*` only (the database is in the server resources).
- `fetchLog[]` is private, this tab's list only (the durable history is the server's). `getFetchLogs` exposes the live
  array (the popup's "This tab" and plugins' `getFetchLogs`); its identity stays fixed.
- Every writer (including `addFetchLogInGlobalFetch`) uses `writeFetchLog`, which trims the live array in place to
  `FETCH_LOG_MAX_ENTRIES` (20) and `FETCH_LOG_MAX_CHARS` (16 Mi UTF-16 code units of `body`, `header`, and `response`),
  repairing an already oversized list too. The newest entry always survives whole, even alone over budget.
- `getFetchData` finds an entry by `chatId`, and `addFetchLog` returns 0. `appendFetchLog(entry)` adds an entry the
  server built (the `log` events of `/api/llm/request`, credentials redacted): the provider calls the server makes
  appear in the tab's request log.
- `chatFoldedState.data` is `{targetCharacterId, targetChatId, targetMessageId}` (`src/ts/chatFold.svelte.ts`,
  re-exported here). `chatFoldedStateMessageIndex.index` is derived synchronously: the target message's index while the
  fold targets the selected chat, else -1, so a reader that runs before the switch effect clears `data` never sees
  another chat's fold.

## Coupling

- `globalApi.svelte.ts` imports `database.svelte.ts`, `storage/resourceSync.svelte.ts`, `storage/resourceClient.ts`,
  `stores.svelte.ts`, alerts, `characterCards.ts` (`characterURLImport`), and the network helpers.
- Assets go `globalApi` (`readImage`, `saveAsset`, `loadAsset`, `getFileSrc`) or `inlays.ts` → `assetClient.ts` →
  `/api/read|write`; its batch calls go to `/api/assets/write|read`, and a canonical `saveAsset` asks
  `/api/assets/missing` first.
- Bulk import writes go `saveAssets` → `saveAssetBatch` → `writeAssets`; card and module export reads go
  `loadAssetsInBatches` → `loadAssets` → `readAssets` ([Asset client](#asset-client)).
- Job client and channel: `shared/jobs.ts` is the message contract. The server job, the channel, and call dispatch
  (`server/src/jobs/channel.ts`) are in [server generation](server-generation.md#generation-channels); plugin hooks and
  the API a plugin sees are in [plugins and MCP](plugins-mcp.md).

## Invariants

- Use `globalFetch`/`fetchNative` for every remote call so that proxy, Node routing, and logs apply; a call that needs a
  stored LLM credential uses `auxFetch` with a `server/src/llm/auxOps.ts` row instead (the tab never reads a
  credential).
- Do not bypass the proxy auth headers. On Node, the server's `sanitizeTargetUrl` is a second SSRF boundary for proxy
  jobs only.
- Asset references are logical `assets/...` paths, never URLs or OS paths.
- Bulk asset writes use `saveAssets`, or `AssetSaveQueue` for arriving items, never a `saveAsset` loop: each fresh
  canonical asset makes a missing check and a write in the storage rate bucket (`server/src/app.ts`). Keep loads lazy
  and producers under queue admission.
- The job channel's rules (UI order, the barrier, one root callback) are in the `jobChannel.ts` header; its failure
  classes are under [Job channel](#job-channel).
- Each dialog close path must answer it (`alertStore.answer`; `set({ type: 'none' })` closes the shown dialog too), or
  the awaiting caller hangs forever. A status writer ends its status with `alertClear()`, never a `none` write, which
  would answer a dialog that appeared meanwhile.
  - An alert opened from inside a shown dialog (a popup's own confirmation) queues behind it: close the owning dialog
    first.
  - `alertSelect` encodes options joined with `||`.
  - `alertConfirm` returns true only for the exact `'yes'`.
- Keep the keypair stored by `util.ts:saveKeypairStore` non-extractable. `storage/serverAuth.ts` keeps its JWT signing
  key in IndexedDB `DPoPDB`, store `node`, record `dpop`; keep that format.

## Recipes

- Change network routing:
  1. Edit `globalFetch`, `fetchWithProxy`, and `fetchNative`.
  2. Update `server/src/routes/proxy.ts` if the contract changes.
  3. Verify direct, proxied, local-network, abort, and timeout behavior.
- Add an asset kind: `saveAsset`, `loadAsset`, `readImage`, `getFileSrc`, plus migrations. Verify Node storage and the
  service worker.
- Add an alert:
  1. Extend `alertData` and add a helper in `alert.ts`.
  2. Add a render and resolve branch in `AlertComp.svelte`; an outer branch must also be excluded from its first guard.
  3. For a new Enter answer, extend the branch in `src/ts/hotkey.ts`. Escape needs no edit.
- Add a job call (`shared/jobs.ts`; client `jobChannel.ts`; server `server/src/jobs/channel.ts`). A callback needs
  `CallbackName`, `CallbackPayloads`, `runHook`, and `hasHook`; a plugin hook also needs `GenerationHooks`,
  `NO_GENERATION_HOOKS`, `registeredHooks`, and `parseGenerationHooks`. A notice needs `GenerationNotice` and
  `applyEffect`, or `showNotice` with `QUEUED_NOTICES`, and `MODAL_NOTICES` if modal. A question needs
  `GenerationQuestion` and `ask`.
- Change save behavior: [`storage/resourceSync.svelte.ts`](resource-sync.md#save-cycle) and the records
  (`storage/records.svelte.ts`). See `persistence.md`.

## Tests

- Network and alert Vitest:
  `pnpm --silent test:agent src/ts/network src/ts/alert{Queue,Terminal,CardExport}.test.ts src/ts/sourcemap.test.ts src/ts/util/koreanSearch.test.ts`.
- Asset and fetch Vitest:
  `pnpm --silent test:agent src/ts/globalApi{Retention,Thumbnails,NativeFetch}.test.ts src/ts/screenshotCaptureCache.test.ts src/ts/storage/tests/asset{Client,Queue}.test.ts shared/tests/assetBatch.test.ts`.
- Client test fakes: job-follow tests use `FakeSocket` and fake timers; push tests use
  `fakeSubscription`/`FakeNotification`. Typed shared doubles: `src/ts/network/tests/generationJobsMock.ts`,
  `src/ts/tests/alertMock.ts`, and `src/ts/tests/globalApiMock.ts`.
- Asset fixture: `src/ts/storage/tests/assetClientMock.ts` (`createAssetClientMock`) reports every asset missing.
  `src/ts/storage/tests/assetClient.test.ts` uses fake routes controlled through mocked `authFetch` and
  `answer.current`.
- Browser specs:
  `pnpm --silent test:agent --e2e e2e/storedFileSrc.spec.ts e2e/terminalNotice.spec.ts e2e/welcomeAndChatSettings.spec.ts e2e/personaBinding.spec.ts`
  ([test-harness](test-harness.md)). Probes: `util/playwright/measureFileSources.mjs`, `probeDirectAssets.mjs`, and
  `checkJobProtocol.mjs`.
- Slow: no client tests; the server asset batch cap in `server/src/tests/assets.test.ts` is `slow`
  ([test-harness](test-harness.md)).
- Not tested: `globalFetch` routing beyond `fetchNative` method/body handling, the full alert protocol, and `util.ts`.

## Known Hazards

### Issues

- Direct URLs already handed out are not re-rendered when the page loses its controller or capability. Without a signing
  worker they load from the browser HTTP cache or fail with 401; only new source calls use the fallback.
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
