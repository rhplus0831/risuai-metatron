# Global API, Network, Utilities, Alerts

## Scope

- Owns: `src/ts/globalApi.svelte.ts`, the client I/O facade:
  - asset I/O,
  - save entry points (the adapter is owned by persistence),
  - `globalFetch`/`fetchNative` routing,
  - this tab's in-memory request log,
  - writers,
  - chat-fold state.
- Also owns: `src/ts/util.ts` helpers, the alert protocol (`src/ts/alert.ts` and `src/lib/Others/AlertComp.svelte`), the network clients in `src/ts/network/` except `requestHistory.ts` ([diagnostics](diagnostics.md)) (`localNetwork.ts`, `auxFetch.ts`, the generation job client and channel, the live-update feed), `src/ts/sourcemap.ts`, `src/ts/dragTypes.ts`, `src/ts/licenses.ts`, `src/ts/util/inlayTokens.ts`, `src/ts/util/koreanSearch.ts`, and the Iris assistant (`src/ts/iris.ts`, `src/lib/Others/IrisModal.svelte`).
- Not here:
  - The save format and backends → `persistence.md` (this guide only covers save entry points).
  - Provider request bodies → `llm-requests.md`.
  - Server-side proxy routes → `self-host-server.md`.

## Files

The request-log viewer, browser collector, reports, and support sharing are documented in [diagnostics](diagnostics.md). The transport below retains this tab's in-memory log.

`src/ts/globalApi.svelte.ts` exports, grouped:

- Storage and assets:
  - `saveAsset`: stores the bytes as `assets/<sha256>.<ext>` by default, using the caller's custom id when supplied or a UUID if hashing fails; the extension defaults to `png`. An optional `{ signal }` aborts the write. `assetKey(data, customId?, fileName?)` is that key; `saveAssetBatch(items, { signal? })` writes `{ key, bytes }` items over `writeAssets`. Bulk imports save through `saveAssets` (`storage/assetQueue.ts`, see `persistence.md`), which uses both.
  - `loadAsset`, `readImage`; `loadAssets(keys, { signal? })` reads a batch in key order over `readAssets`, preserving duplicates and returning `null` per missing or empty record. Exporters reach it through `loadAssetsInBatches` (`storage/assetQueue.ts`, [persistence](persistence.md)).
  - `getFileSrc`: with worker use enabled, a reported `directAssets: true` capability, and `navigator.serviceWorker.controller` present at the call, immediately resolves `/api/asset/<hex(utf-8 key)>` (`""` for an empty key). It reads no bytes, looks up no Cache Storage entry, registers nothing, and creates no shared file source or pin; nothing needs revoking. The worker signs subresource loads and the browser HTTP cache holds the bytes. A missing file is not detected here: its element receives a 404. Controller loss or a `controllerchange` capability re-probe sends new calls through the fallback until direct mode is available again.
  - `getFileSrc` fallback: returns `/sw/img/<hex>` when the service worker holds the file. When worker use is enabled, a remembered path returns at once; other paths share one `caches.open("risuCache")` promise and directly call `cache.match("/sw/img/<hex>")`. A hit remembers the path without a worker round trip; a miss reads the bytes and posts to `/sw/register/<hex>` before remembering it. Missing Cache Storage or a failed lookup falls back to `/sw/check/<hex>` for that read, with a later read able to retry opening the cache. Each worker request is bounded at 10 s; a failed worker request falls back to an object URL (`blob:`, `image/png`) of its bytes pinned for the page by this plain read (including when boot continues without a ready worker; a data URL would inflate the text a display transform sends). Concurrent reads of a path share one load; a missing or empty file is never registered and resolves `""`, as does a failed load, and either is dropped so the next read tries again.
  - `holdFileSrc`: returns `{ src, release }` for previews. In direct mode it immediately resolves the same direct URL as `getFileSrc`, with a no-op release and no read, pin, or revoke. Otherwise it shares the fallback cached load: the last release revokes and drops an unpinned `blob:` URL after a 100 ms grace period, cancelled by a new hold or plain read so shifted list rows can reuse it. A release before loading finishes is applied after resolution unless the source was held or pinned again. Service-worker URLs are never revoked; plain fallback reads stay pinned. Switching modes leaves existing fallback sources' pin/hold lifetimes intact.
  - `getThumbSrc(loc, size: 256 | 512)`: in direct mode, immediately resolves `/api/asset/<hex>?w=<size>` (`""` for an empty key), with no read, registration, shared file source, or pin. The server answers a WebP thumbnail or a 307 redirect to the query-free original, which the worker follows. Otherwise it returns `getFileSrc(loc)`'s own promise: the full image, the same shared load and plain-read pin, never a thumbnail request. Pages without a worker, uncontrolled pages, and fallback loads get no decoded-memory win; this is an accepted trade-off.
  - `getDirectAssetSrc(loc)`: returns `/api/asset/<hex(utf-8 key)>` (`""` for an empty key) under the same direct-mode check as `getFileSrc` at the call (worker use enabled, the `directAssets` capability, a controller present), else `null`. The parser uses it for inlay audio and video ([CBS rendering](cbs-rendering.md)).
  - `fetchFileSrc`: fetches a displayed URL for rich copy's message images and character/user icons. Only same-origin `/api/asset/<hex>` URLs whose hex decodes as UTF-8 to an `assets/` key receive a fresh `risu-auth` token, for `GET`/`HEAD` without an existing auth header; signed requests use `mode: "same-origin"` to prevent cross-origin redirects. Other requests pass through unchanged. The worker does not sign `fetch()`.
  - `withFileSrcFetch`: runs a callback while global `fetch` signs the same requests as `fetchFileSrc`, calling the captured original fetch directly. Screenshot capture uses it for images, computed-style URLs from shared chat styles outside the rows, and fonts. It passes `SCREENSHOT_CAPTURE_OPTIONS` (`src/lib/ChatScreens/screenshotCapture.ts`, `includeQueryParams: true`), so html-to-image's cache is keyed by the full URL: `?w=256`, `?w=512`, and the original are three entries per asset, and a captured thumbnail never stands in for a later full-size image. Plugins can already read any `assets/` key through v3 `readImage`, so this temporary signing grants no new asset access. Nested and overlapping runs share a depth counter. The last run's `finally` disables signing (including a token still being obtained) and restores fetch only if it is still this wrapper; a wrapper retained by another script stays inactive.
  - `downloadFile`, `getBasename`.
- Save:
  - `saving`: indicator state (re-exported from the adapter).
  - `loadInternalBackup`: lists the server's resource snapshots, restores the chosen one, reloads.
  - `setUsingSw`: boot enables worker-backed asset URLs only after `registerSw` returns `ready`. Without it, new asset loads go directly to the object-URL fallback without cache lookups or worker requests; existing shared file sources keep their pin/hold lifetimes.
  - `setDirectAssets`: boot records the `/sw/init` capability separately from worker availability. Non-JSON responses (including older workers), missing/false flags, unavailable workers, and unsupported browsers leave it false. A single guarded `controllerchange` listener clears the capability and probes the new controller; only the newest probe can set it again. Each `getFileSrc`/`holdFileSrc` call also checks for a controller.
- Network:
  - `globalFetch(url, GlobalFetchArgs)`: buffered, returns `{ok,data,headers,status}`.
  - `fetchNative(url, args)`: returns a `Response` or stream.
  - `addFetchLog`, `appendFetchLog`, `getFetchLogs`: all writers (including `addFetchLogInGlobalFetch`) use `writeFetchLog`, which trims the live array in place to `FETCH_LOG_MAX_ENTRIES` (20) and `FETCH_LOG_MAX_CHARS` (16 Mi UTF-16 code units of `body`, `header`, and `response`). The newest entry always survives whole, even alone over budget.
  - `openURL`.
- Writers: `LocalWriter` (the backup record framing `writeBackup`, streamed through `streamsaver`), `VirtualWriter`, `BlankWriter`, `AppendableBuffer`. `LocalWriter.abort(reason?)` drops a partial download through streamSaver's writer and never throws: safe before `init`, after `close`, or when called twice. `VirtualWriter.abort()` is a no-op.
- Chat and UI:
  - `changeChatTo` (selects a chat of the selected character by id, or by its index in `chatList`, through the chat module's `selectChat`, and opens it with `setChatOpen`; per tab), `openPinnedChat` (shared home/rail navigation by `{ chaId, chatId }`: optional sidebar reset, ensure membership, select chat before character, clear Realm/set playground mode, open and bump `ReloadGUIPointer`), `createChatCopyName` (unique against `chatList`'s names).
  - `chatFoldedState`, `chatFoldedStateMessageIndex`, `foldChatToMessage`.
  - `checkCharOrder`: re-exported from `storage/characterOrder.ts` (the character module calls it without importing this file); the plugin-visible export is unchanged.
  - `toggleFullscreen`.
- Misc:
  - `getVersionString`.
  - `getLanguageCodes`.
  - `aiLawApplies`: always true.
  - `aiWatermarkingLawApplies`: always false.
  - `PerformanceDebugger`, `toGetter`, `trimNonLatin`.

`src/ts/util.ts` exports, grouped:

- Messages and chars:
  - `Messagec`.
  - `messageForm`.
  - `findCharacterbyId`, `findCharacterIndexbyId`, `getCharacterIndexObject`.
  - `getEmotion`, `defaultEmotion`.
  - Persona accessors, including `checkPersonaBinded`.
- Files:
  - `selectSingleFile`, `selectMultipleFile`, `selectFileByDom`, `selectSingleFileHandle` (the picked `File` itself, unread, or `null` when none is picked: the module dialog's `.risum` and `.charx` imports upload it as it is, and the VITS model import reads its zip by slices), and `selectMultipleFileHandles` (the picked `File`s, unread, `[]` when none: the asset pickers save them with `savePickedFiles`). The selectors use the DOM picker.
- Crypto: `encryptBuffer`/`decryptBuffer` (AES-GCM), `pickHashRand`, `sfc32`, `uuidtoNumber`.
- Text:
  - `BufferToText`.
  - Multilingual encode/parse (`encodeMultilangString`).
  - `languageCodes`.
  - Punctuation trimming.
  - `getNodetextToSentence`.
  - `replaceAsync`.
  - `jsonOutputTrimmer`.
  - `asBuffer`.
- UI data: `TagList`/`searchTagList`, `parseToggleSyntax` and the `sidebarToggle` union (re-exported from `shared/prompt/toggles.ts`), `sortableOptions`, `getCustomBackground`.
- Concurrency and storage:
  - `sleep`.
  - `openKeypairStoreDB`/`saveKeypairStore`/`getKeypairStore`: IndexedDB `DPoPDB` store `dpop`.
  - `base64url`.
  - `simplifySchema`.
  - `prebuiltAssetCommand`.

Other files:

- `src/ts/alertQueue.ts`: `createAlertQueue` (the store `stores.svelte.ts:alertStore` is one instance) and `createDialogKeyGate` (for `hotkey.ts`). The alert slot holds one status (`wait`, `progress`, `toast`: the newest replaces it) and a first-in, first-out queue of dialogs (every other type), shown one at a time; a dialog supersedes the status set before it, not one set after it (that one shows once the dialogs close). `open(data)` queues a dialog and returns its handle (`closed`, the `msg` it closes with; `cancel()`, which removes it shown or queued and closes it with ""); `answer(msg, expected?)` closes the shown dialog (only while `expected` is the one shown); `clearStatus(expected?)`, `status()`, `idle()`, `dialogVisible()`, `hasDialogs()`. `set` routes by type: a status replaces the status, `none` closes the shown dialog (or, with none shown, clears the status), anything else queues a dialog. After a dialog closes, the next one shows `NEXT_DIALOG_GAP_MS` (150 ms) later, also one opened after the close; meanwhile the store reads `none` with `dialogPending`. An identical `normal`, `error`, `markdown` or `wait2` right behind the last queued dialog folds into it (same handle; never an error with `jobFailure`). The key gate lets a dialog take Enter or Escape only from a stroke that began after it appeared: never a repeat, the stroke held when it appeared, or a composing key; a later non-repeated keydown counts as a new stroke even if its keyup was lost.
- `src/ts/alert.ts`:
  - `alertData` (discriminated `type`).
  - `alertNormal`, `alertError`, `alertConfirm`, `alertSelect`, `alertInput`.
  - `alertCardExport`: character export only (V3 or V2).
  - `alertRequestData` (its dialog renders the generation info and the message copy it was opened with), `alertRequestLogs`.
  - Each dialog helper queues its dialog; an awaited one resolves with its own dialog's answer, parsed as before (`alertConfirm` true only for `"yes"`, `alertChatOptions` a number, `alertCardExport` the parsed object). `waitAlert` waits until no dialog is shown or queued; `doingAlert` is true while a dialog is shown or queued, or a progress overlay shows; `alertClear` clears the status only. `alertStore` (here) is a `set` wrapper over the real store `stores.svelte.ts:alertStore`. `openAlertDialog(open)` (for `jobChannel.ts`) runs one helper call and returns its result with the handle of the dialog it queued.
  - `alertTerminal(msg)`, `terminalNotice` (read-only), `acknowledgeTerminalNotice`, `terminalNoticeShown()` (set and cleared synchronously with the notice; the plugin key listeners read it): the notice the page ends on (the restore notice), outside `alertStore`. Single-flight; it resolves only when the user acknowledges it, so no other alert (a toast, an error, `alertClear`, a `wait`) can replace or dismiss it.
  - `alertReloadNotice(msg)`, `reloadNotice` (read-only), `dismissReloadNotice`: the save adapter's reload notice (`resourceReloaded`: a conflict replaced a local change), outside `alertStore` beside the terminal notice. Latched until dismissed: a call while one is shown keeps it (one notice per episode on screen), the first call after a dismissal shows it again; no other alert replaces or hides it.
- `src/lib/Others/AlertComp.svelte`: renders the head of `alertStore` (the shown dialog, else the status) and answers a dialog with `alertStore.answer(msg)`. A toast's end clears the status only while it is still that toast. The error alert's "Open in request history" closes the error before opening the history; the request history popup passes its own close to `ServerRequestHistory.svelte`, which closes it before its delete confirmation (then opens it again) and before a share error. Translates stack traces with `sourcemap.ts:translateStackTrace`.
- `src/lib/Others/TerminalNotice.svelte` (mounted unconditionally in `App.svelte`): the terminal notice as a native modal `<dialog>` (`showModal()`: the top layer, above every z-index; focus on its OK; the page inert). Only its OK acknowledges it: Escape is prevented (and a forced close shows it again), a held or composing Enter is ignored, no key event leaves the dialog (a panel's own `window` listener behind it never sees one; a capture listener still does), and `hotkey.ts` runs no shortcut while it is shown.
- `src/lib/Others/ReloadNotice.svelte` (mounted unconditionally in `App.svelte`, before `TerminalNotice`): the reload notice as a fixed, non-modal panel (`role="status"`) at the top, above the alert overlay (`z-[60]`), until its own OK dismisses it. The page behind it stays live; a key event on its OK does not leave the panel (an Enter would otherwise reach `hotkey.ts` and answer the alert underneath as yes). The terminal notice's dialog still covers it.
- `shared/localNetwork.ts` (re-exported by `src/ts/network/localNetwork.ts`; the server request layer uses it too): `isLocalNetworkHost`, `isLocalNetworkUrl`. Accepts private/loopback/link-local IPs, `.local`, and bare single-label hosts.
- `src/ts/network/auxFetch.ts`: `auxFetch(op, url, { method, headers, body, signal, interceptor, chatId, profileId })`, a call that needs a stored LLM credential, sent to `/proxy2` with `risu-aux-op` (`self-host-server.md`): the server adds the key, the tab never holds it. With `profileId`, it first awaits `flushResources()` so a changed binding, new profile, or named-key record is stored before the server reads it, and sends `risu-aux-profile` for the supported discovery/account rows. It then awaits `awaitSecretWrites()` (a key entered just before is used; a refused or unsaved key fails the call; an abort settles the call at once while the save goes on, and no interceptor or request starts after it; `authFetch`'s `beforeDispatch` checks the abort and the save admission after authentication and signing, so nothing goes out once saving halted for a restore), runs the plugin body interceptors for `interceptor` as `globalFetch` does, keeps the operation's method (a GET has no body), sends a `FormData` body serialized once with its boundary, and logs the request (no credential in it). `auxFetchJson` answers in `globalFetch`'s `{ ok, data, status }` shape. Callers: model discovery (`modellist.ts` `registerModelDynamic`, `openrouter.ts`, `ollama.ts` cloud tags), NanoGPT (`nanogpt.ts`), OpenAI TTS (`tts.ts`, the official URL with a stored key; a custom URL with a stored key and no own key alerts `ttsCustomUrlNeedsKey`), DALL-E and Imagen (`stableDiff.ts`), Whisper (`PlaygroundSubtitle.svelte`), the memory embeddings (`hypamemory.ts`, `hypamemoryv2.ts`, unless the processor has its own key; the browser's memory summarizers that made the completions calls were removed when memory summarization moved to the server, the server's `openai-completions` operation stays).
- `src/ts/network/channelCallSource.ts`: `channelCallTargets(call)`, the targets of the job callback a plugin call context names (`PluginCallContext.channelCall`) while it runs in this tab and the server has not cancelled it, else null (`jobChannel.ts` registers its `liveChannelCallTargets` when it loads; before that none runs). `request.ts`'s send guard reads it; it never picks a callback for a request.
- `src/ts/network/generationJobs.ts`: the client transport of server generation jobs (`shared/jobs.ts`; server side in `self-host-server.md`). `generationClientId` (one per tab, `sessionStorage`), the saved jobs per chat (`savedGenerationJobs`, `rememberGenerationJob`, `forgetGenerationJob`), `createGenerationJob` (`GenerationBusyError`, `GenerationStaleError`, `ChatBindingRefusedError` for 409 `chatBindingIncomplete`/`chatBindingMismatch`, the epoch mismatch), `readGenerationJob`, `abortGenerationJob`, `followGenerationJob` (the owner socket with a fresh JWT; events of another epoch dropped; `send` for the channel's answers; a newer follow of the same job cancels the older one (its socket, even while connecting, its events, and its sends) and sends a higher `attach` stamp (`performance.timeOrigin + performance.now()`, increasing across reloads); `closed` reports whether a terminal event arrived; a 412 runs the resource client's restore halt), `applyGenerationEvent(jobId, ref, event, transport?)` (into `applyServerGeneration`, `applyHydration`, `applyPatchHydration` (a `chatPatch`; a `mismatch` sends one `{ type: "resync" }` per follow through `transport` until a whole job chat arrives; a `busy` patch, or a whole job chat refused for local work, sends it after `flushResources` while the chat is still stale and `chatHydrationHold` is `none`, one recovery per follow retried with a growing wait until it asks or the follow ends (`done`/`error`, or its `closed`)), and `endServerJob`; channel events to `jobChannel.ts` with the follow as their transport; the dispatcher loads on first use and runs on one chain in socket order; a `stage` event is kept per job in `jobStages`; a `preset` event, a send's `presetChain` pick, changes nothing: the pick is the job's own, [chat bindings](persistence.md)), and `resumeSavedGenerations` (attach again after a reload). `createGenerationJob` sends `registeredHooks()` unless the caller passes a list.
- `src/ts/network/eventFeed.ts`: the client of the live-update socket `/api/events/ws` (`startEventFeed`, `stopEventFeed`); documented with the save loop it feeds in `persistence.md`.
- `src/ts/network/jobChannel.ts`: the client dispatcher of the job channel. Notices map to `alert.ts`, `ReloadGUIPointer`/`ReloadChatPointer` (by `chaId`/`chatId`/`messageId` when that chat is shown), `CharEmotion`, `hypaV3ProgressStore`, `sayTTS`, and `showCompletionNotification` (`pushNotifications.ts`: the server's title and body, never a permission request). Its UI queue is one queue across jobs, so every job's notices and questions keep their order: while a question or a modal notice is open, later alert notices (toasts too) and questions wait, and each modal notice's own dialog is awaited (`openAlertDialog`), not every queued local dialog. The alert store queues the dialogs themselves: a local alert never replaces a job's question, and a job's dialog may wait behind local ones. A `cancel` (or the job's end) removes the question's own dialog, shown or still queued, and drops its result. A question is answered with the alert's raw result (the alert API has no separate dismissal; `cancelled` is not produced). Callbacks run behind the barrier (`flushResources()`, the newest remembered hydration of every listed receipt applied again, each held at least as new, else `failed`/`barrier`), then the hook set by name under the job's targets (`invokeHook`; plugin MCP listings and tool calls also receive the job targets; interceptors run without the hook context), then `flushResources({ scope })` even when the hook threw (discarded keys or a rejection: `failed`/`barrier`; the hook's throw: `failed`/`hook`). Replacers and edit hooks stop at the first throw; interceptors log and continue. `chatOutput` runs the output listeners in order, each with a plain copy of the speaker and the chat as they are then and indices looked up again, logs a listener's throw, and answers `true`; `imggen` runs `stableDiff` and `generateImage` runs `generateAIImage` with the callback's `AbortSignal`, which the callback's cancel or the job's end aborts; neither answers a result that arrives after the cancel; `provider` calls the plugin provider with the server's argument and an `AbortSignal` the callback's cancel aborts: a text answers `{ success, content }`; a stream is read here and sent as `chunk` messages with the text so far (the first at once, then at most every 50 ms and at the end) before the answer `{ success: true, streamed: true }`, a failed stream is read whole into the answer, and either reader is cancelled when the callback ends first (also when the provider returned the stream after the cancel); a text over 4 MiB characters or a provider no longer loaded is a `hook` failure. `mcpList` and `mcpTool` answer the tools and a tool's content of an MCP that lives in the tab: a `plugin:` MCP as it is registered now, or `internal:fs`/`internal:googlesearch` through `readyTabClient` (`plugins-mcp.md`; the handshake may show a directory picker or a credential prompt); a client's throw is a `hook` failure. The `openURL` notice opens an `http(s)` address (an MCP server's OAuth page). `selectedChat` answers the id of the chat this tab has selected for a character (the selection is per tab), or `null`. `recentEmotions(chaId)` gives the emotions the tab showed last for a chat's character or group members, which `createGenerationJob` sends as `context.client.emotions`. A job that ends closes the HypaV3 progress overlay it left open. Request state is kept in memory: a duplicate never runs twice (the cached answer is resent), and a `replay` the page has no state for is refused. Each hook runs with the job's targets plus `channelCall` (the job and callback ids) as its call context, so an aux request made from it names that callback as its parent; nothing else the tab requests does. One root callback runs at a time: a `cancel` only marks a running callback (its hook's `AbortSignal`, if any, aborts) and it stays outstanding until its hook settles, a root arriving meanwhile is refused, and once it settles (or at once for a callback whose answer crossed the cancel) the tab reports it drained (`reportCallbackDrained`, `POST /api/generations/:id/drained`), which frees the lane the server kept for it. `liveChannelCallTargets(call)` answers a running, uncancelled callback's targets (registered with `channelCallSource.ts`); `registeredHooks()` builds the hook list from the active registries (`createGenerationJob` sends it).
- `src/ts/network/pushNotifications.ts` ([Web Push](global-api.md)): this browser's Web Push. `startPushNotifications` (after `startRouter` in `bootstrap.ts`) reads the availability (`insecure` off HTTPS, `ios-home-screen` for iOS outside a Home Screen app, `unsupported`, `server-off` when `/api/push/key` answers null), answers the service worker's `risu-open-route` messages with `openRoute` (`router.svelte.ts`), closes the completion notifications of every chat whenever the page is shown (each chat has its own tag, `shared/notifications.ts` `completionNotificationTag`, so a later notice of a chat replaces only that chat's; they are picked by the tag's prefix), and runs `reconcilePush`: with `settings.ui.notification` on, the permission granted, and this browser not opted out, it registers the subscription (a new one when the browser has none or one for an older server key). `enablePushOnThisBrowser` must run inside a click: the permission request is its first step. `disablePushOnThisBrowser` opts this browser out (`risu-push-browser-off`) and unsubscribes; a server removal that failed is retried at the next sync. An `unsubscribe()` that rejects or resolves `false` is reported in `error` (the opt-out stays, and the settings' off button alerts it) and, while the browser stays opted out, retried at the next sync (`risu-push-pending-unsubscribe`, dropped when the browser is turned on again here or in another tab; the flags are read again just before the retried `unsubscribe()` and after it, and a browser turned on meanwhile is subscribed again in the same sync); a subscription for an older server key that the browser keeps fails the sync with that error, so the next sync retries it. Every failure detail is a `language.pushNotifications.*` string; `NotificationToggle.svelte` shows `error` under this browser's status until a sync clears it (a successful registration, or a sync that has nothing to register and no unsubscribe pending). Enable, disable, and sync run one at a time. `showCompletionNotification` shows the tab's notice unless this browser is subscribed (the push shows it) or the page is visible with the focus (so it does not sound after the message sound, `playMessage`, when that is on; another app window's focus is not seen). `pushBrowserState` (a store) feeds `NotificationToggle.svelte` (the synced switch, this browser's status, and its on/off button) and `src/lib/Others/PushPrompt.svelte` (the one-time banner, mounted in `App.svelte` after loading; either button sets `risu-push-prompt-dismissed`; a failed enable from either is alerted with `pushNotifications.failed`). A flag whose storage write failed is kept in memory for the page and wins until a later write of it succeeds; otherwise storage is read as it is.
- `src/ts/util/koreanSearch.ts` (client only, over `es-hangul`): the shared text matcher of list filters and settings search. `prepareQuery(query)` NFC-normalizes, lowercases (ς folded to σ) and drops whitespace (`null` when nothing is left) and precomputes the query's jamo, whether every character is an initial consonant, and, for an all-Latin query, its Hangul as typed on a QWERTY layout (in the typed case, where Shift types ㄲ/ㅃ/ㅉ/ㄸ/ㅆ/ㅒ/ㅖ, and lowercased; a form `es-hangul` cannot assemble, such as `jinja`, is skipped). `matchText(text, query)` answers 0 or a `MATCH_SCORE` tier, best first: exact, prefix (both over the text without whitespace), substring, space-insensitive substring, choseong (an all-choseong query in the text's initials, Hangul only; such a query takes no later tier), jamo (the half-composed last syllable: 해저 finds 해적), QWERTY (`gowjr` finds 해적). Romanized queries are not matched. `matchesAny(texts, query)` is the lists' boolean. Derived forms of a text are computed per call, never cached by text.
- `src/ts/dragTypes.ts`: `RISU_*_DRAG_TYPE` custom MIME types. They keep in-app drags from being treated as file imports.
- `src/ts/iris.ts` `getIrisSystemPrompt`, and `IrisModal.svelte`: a visual-novel-style assistant. It calls `requestChatData(..., 'otherAx')` and persists the dialogue in `irisDialogue` (a `ui` field) (saved on the server; older browser copies are imported at boot).

## Flows

Asset sources:

1. Each source call chooses direct mode with worker use enabled and a controlling worker that reported `directAssets: true`.
2. Otherwise it uses the fallback: no worker support, registration or `/sw/init` failure, an older worker or a missing/false flag, the first load before the worker claims the page, or a lost controller.
3. In direct mode, a missing key or failed signature makes the worker fetch unsigned. A 401 after its one retry or a network error fails the element's load; neither switches modes or retries through `readAsset`.
   Worker details: [build & test platforms](build-test-platforms.md); asset route and HTTP cache behavior: [self-host server](self-host-server.md).

`globalFetch`:

1. Applies `bodyIntercepterStore` interceptors, timeout, and local-network policy.
2. Picks a transport, in order: a qualifying local-network route → the proxy; otherwise plain `fetch` (localhost hosts, `plainFetchForce`/`usePlainFetch`), userscript `userScriptFetch`, or the proxy.
3. Proxy target: same-origin `/proxy2` on the self-host server.
   - Headers: `risu-url`, `risu-header` (encoded JSON), optional `risu-auth` and `x-risu-tk`, timeout.

`fetchNative`:

1. The optional body is a string, `Uint8Array`, or `ArrayBuffer`. The internal method defaults to POST; only GET and HEAD discard a body, while DELETE/PATCH keep it. The public plugin `nativeFetch` adapter defaults to GET and honors only `method`, `headers`, `body`, and `signal`: record/pair headers are normalized before scanning/logging, ArrayBufferView and Blob bodies become bytes, string/Blob content types default when absent, and GET/HEAD bodies are refused. `Headers`, `FormData`, `URLSearchParams`, and streams cannot cross the sandbox RPC.
2. A qualifying local-network route goes through `/proxy2`.
3. Otherwise userscript `userScriptFetch` when present, else a direct `fetch`.

Alerts:

1. The caller runs, e.g., `await alertConfirm(msg)`, which queues its dialog in `alertStore` (`open`).
2. `AlertComp` renders it once the dialogs before it closed (150 ms after the previous one).
3. A button, Enter (`ask`, `normal`, `error`: `"yes"`), or Escape (`""`) answers the shown dialog (`alertStore.answer`).
4. The dialog's `closed` resolves the helper with that answer; the next dialog follows after the gap.

## State

- Asset logical keys (`storage/assetClient.ts`): `assets/*` only (the database is in the server resources).
- `fetchLog[]` is private, this tab's list only (the durable history is the server's). `getFetchLogs` exposes the live array (the popup's "This tab" and plugins' `getFetchLogs`); its identity stays fixed. Every insertion through `writeFetchLog` keeps the newest entries within the count and text budgets above (the newest entry alone may exceed the text budget), repairing an already oversized list too. `getFetchData` still finds an entry by `chatId`, and `addFetchLog` still returns 0. `appendFetchLog(entry)` adds an entry the server built (the `log` events of `/api/llm/request`, credentials redacted): the provider calls the server makes appear in the tab's request log.
- `chatFoldedState.data` is `{charId, chatId, messageId}`.

## Coupling

- `globalApi.svelte.ts` imports `database.svelte.ts`, `storage/resourceSync.svelte.ts`, `storage/resourceClient.ts`, `stores.svelte.ts`, alerts, `characterCards.ts` (`characterURLImport`), and the network helpers.
- Its importers: nearly every process, storage, UI, and plugin module.

## Invariants

- Use `globalFetch`/`fetchNative` for every remote call so that proxy, Node routing, and logs apply; a call that needs a stored LLM credential uses `auxFetch` with a `server/src/llm/auxOps.ts` row instead (the tab never reads a credential).
- Do not bypass the proxy auth headers. On Node, the server's `sanitizeTargetUrl` is a second SSRF boundary for proxy jobs only.
- Asset references are logical `assets/...` paths, never URLs or OS paths.
- Each dialog close path must answer it (`alertStore.answer`; `set({ type: 'none' })` closes the shown dialog too), or the awaiting caller hangs forever. A status writer ends its status with `alertClear()`, never a `none` write, which would answer a dialog that appeared meanwhile.
  - An alert opened from inside a shown dialog (a popup's own confirmation) queues behind it: close the owning dialog first.
  - `alertSelect` encodes options joined with `||`.
  - `alertConfirm` returns true only for the exact `'yes'`.
- Keep the keypair stored by `util.ts:saveKeypairStore` non-extractable. `storage/serverAuth.ts` keeps its JWT signing key in IndexedDB `DPoPDB`, store `node`, record `dpop`; keep that format.

## Recipes

- Change network routing:
  1. Edit `globalFetch`, `fetchWithProxy`, and `fetchNative`.
  2. Update `server/src/routes/proxy.ts` if the contract changes.
  3. Verify direct, proxied, local-network, abort, and timeout behavior.
- Add an asset kind: `saveAsset`, `loadAsset`, `readImage`, `getFileSrc`, plus migrations. Verify Node storage and the service worker.
- Add an alert:
  1. Extend `alertData`.
  2. Add a helper in `alert.ts`.
  3. Add a render and resolve branch in `AlertComp.svelte`.
- Change save behavior: `storage/resourceSync.svelte.ts` and the records (`storage/records.svelte.ts`). See `persistence.md`.

## Tests

- `src/ts/sourcemap.test.ts` covers stack translation. `src/ts/network/localNetwork.test.ts`, `src/ts/network/auxFetch.test.ts`, and `src/ts/network/eventFeed.test.ts` cover local-network matching, credentialed auxiliary requests, and live-update connection behavior.
- Generation jobs and callbacks: `src/ts/network/generationJobs.test.ts`, `src/ts/network/generationJobsDelta.test.ts`, `src/ts/network/generationJobsPluginWork.test.ts`, `src/ts/network/jobChannel.test.ts`, and `src/ts/network/jobChannelBarrier.test.ts` cover job transport, event application, plugin work, and callback barriers.
- Web Push: `src/ts/network/pushNotifications.test.ts` covers browser opt-out, subscription reconciliation, and notification navigation.
- Alerts: `src/ts/alertQueue.test.ts` covers the status/dialog queue and key gate; `src/ts/alertTerminal.test.ts` covers the terminal notice.
- Assets and request history: `src/ts/globalApiRetention.test.ts` covers fetch-log budgets, worker-backed and fallback file sources, holds, and signed copy/screenshot reads. `src/ts/globalApiThumbnails.test.ts`, `src/ts/screenshotCaptureCache.test.ts`, and `e2e/storedFileSrc.spec.ts` cover thumbnail URLs and screenshot cache keys.
- `src/ts/globalApiNativeFetch.test.ts` covers `fetchNative` method and body handling. There are no direct tests for the rest of `globalFetch` routing, the full alert protocol, or `util.ts`.
- `src/ts/util/koreanSearch.test.ts` covers the shared Korean-aware matcher.

## Known Hazards

- A fallback `/sw/img/<hex>` URL stays in already rendered rows after a worker update deletes the `/sw/img/` cache entries. Image, audio, and video loads recover through the signed asset route, but `fetchFileSrc` (copy-to-HTML) and fetches under `withFileSrcFetch` (screenshots) reject on that miss: the helpers sign only `/api/asset/` URLs, and the worker recovers only allowed destinations. New `getFileSrc` calls use direct URLs once the capability returns; the parser's `fileSrcCache` can still reuse an old `/sw/img/` URL.
- Direct URLs already handed out are not re-rendered when the page loses its controller or capability. Without a signing worker they load from the browser HTTP cache or fail with 401; only new source calls use the fallback.
- The client `isLocalNetworkHost` accepts bare single-label hosts, but the server's version does not. A Node proxy job can be rejected, and the request then falls back to unrestricted `/proxy2`.
- A plugin hook already inside `invokeHook` cannot be aborted: a cancellation skips the later hooks, but the running one finishes, its writes flush, and it holds the callback lane until it settles.
- A `provider` callback (a plugin provider model of a server job) is the tab's outstanding callback for as long as its stream is read; the server sends no other root callback of this tab meanwhile, and one that arrives anyway is refused ("A callback may run only inside the outstanding one"). A cancelled hook that never settles keeps refusing roots (and plugin `sendChat`) until the page reloads; the server stops holding its lane `CANCELLED_CALLBACK_DRAIN_MS` after the cancel, so a later job's root callback is then refused rather than queued forever. An unloaded provider fails the callback, so the server reports the request as `Plugin Error from <provider>: ...`, not as the unknown-plugin message.
- A tab MCP tool call from the job channel (`getToolList`, `callTool`) has no abort signal: once it starts, ending the request does not stop it.
