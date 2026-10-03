# Global API, Network, Utilities, Alerts

## Scope

- Owns: `src/ts/globalApi.svelte.ts`, the cross-platform "kernel":
  - asset I/O,
  - save loop,
  - `globalFetch`/`fetchNative` routing,
  - request logs,
  - writers,
  - chat-fold state.
- Also owns: `src/ts/util.ts` helpers, the alert protocol (`src/ts/alert.ts` and `src/lib/Others/AlertComp.svelte`), the local-network and proxy-stream helpers in `src/ts/network/`, `src/ts/sourcemap.ts`, `src/ts/dragTypes.ts`, `src/ts/licenses.ts`, `src/ts/util/inlayTokens.ts`, and the Iris assistant (`src/ts/iris.ts`, `src/lib/Others/IrisModal.svelte`).
- Not here:
  - The save format and backends → `persistence.md` (this guide only covers the save loop as an entry point).
  - Provider request bodies → `llm-requests.md`.
  - Server-side proxy routes → `self-host-server.md`.

## Files

`src/ts/globalApi.svelte.ts` exports, grouped:

- Storage and assets:
  - `forageStorage`: the `AutoStorage` singleton.
  - `saveAsset`: hashes the bytes and stores them as `assets/<hash>.<ext>`.
  - `loadAsset`, `readImage`.
  - `getFileSrc`: returns a displayable URL: `/sw/img/<hex>` when a service worker is present, or a data URL.
  - `downloadFile`, `getBasename`.
- Save:
  - `saveDb`: starts the resource save adapter (`storage/resourceSync.svelte.ts`, see `persistence.md`); called once from `loadData`.
  - `saving`: indicator state (re-exported from the adapter).
  - `loadInternalBackup`: lists the server's resource snapshots, restores the chosen one, reloads.
  - `setUsingSw`.
- Network:
  - `globalFetch(url, GlobalFetchArgs)`: buffered, returns `{ok,data,headers,status}`.
  - `fetchNative(url, args)`: returns a `Response` or stream.
  - `textifyReadableStream`.
  - `addFetchLog`, `getFetchLogs`, `getRequestLog`.
  - `openURL`.
- Writers: `LocalWriter` (the backup record framing `writeBackup`, streamed through `streamsaver`), `VirtualWriter`, `BlankWriter`, `AppendableBuffer`.
- Chat and UI:
  - `changeChatTo` (selects a chat of the selected character by index through the chat module's `selectChat`; per tab), `createChatCopyName`.
  - `chatFoldedState`, `chatFoldedStateMessageIndex`, `foldChatToMessage`.
  - `checkCharOrder`: re-exported from `storage/characterOrder.ts` since Phase 4 (the character module calls it without importing this file); the plugin-visible export is unchanged.
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
  - `selectSingleFile`, `selectMultipleFile`, `selectFileByDom`. Both selectors use the DOM picker.
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
- UI data: `TagList`/`searchTagList`, `parseToggleSyntax` (the `sidebarToggle` union), `sortableOptions`, `getCustomBackground`.
- Concurrency and storage:
  - `sleep`.
  - `Semaphore`.
  - `openKeypairStoreDB`/`saveKeypairStore`/`getKeypairStore`: IndexedDB `DPoPDB` store `dpop`.
  - `base64url`.
  - `simplifySchema`.
  - `prebuiltAssetCommand`.

Other files:

- `src/ts/alert.ts`:
  - `alertData` (discriminated `type`).
  - `alertNormal`, `alertError`, `alertConfirm`, `alertSelect`, `alertInput`.
  - `alertCardExport`: character export only (V3 or V2).
  - `alertRequestData`, `alertRequestLogs`, `alertGenerationInfoStore`.
  - The real store is `stores.svelte.ts:alertStore`.
- `src/lib/Others/AlertComp.svelte`: renders every alert type and resolves each by writing `type: 'none'` back. Translates stack traces with `sourcemap.ts:translateStackTrace`.
- `shared/localNetwork.ts` (re-exported by `src/ts/network/localNetwork.ts`; the server request layer uses it too): `isLocalNetworkHost`, `isLocalNetworkUrl`. Accepts private/loopback/link-local IPs, `.local`, and bare single-label hosts.
- `src/ts/network/auxFetch.ts` (Phase 5 slice 7b): `auxFetch(op, url, { method, headers, body, signal, interceptor, chatId })`, a call that needs a stored LLM credential, sent to `/proxy2` with `risu-aux-op` (`self-host-server.md`): the server adds the key, the tab never holds it. It awaits `awaitSecretWrites()` first (a key entered just before is used; a refused or unsaved key fails the call; an abort settles the call at once while the save goes on, and no interceptor or request starts after it; `authFetch`'s `beforeDispatch` checks the abort and the save admission after authentication and signing, so nothing goes out once saving halted for a restore), runs the plugin body interceptors for `interceptor` as `globalFetch` does, keeps the operation's method (a GET has no body), sends a `FormData` body serialized once with its boundary, and logs the request (no credential in it). `auxFetchJson` answers in `globalFetch`'s `{ ok, data, status }` shape. Callers: model discovery (`modellist.ts` `registerModelDynamic`, `openrouter.ts`, `ollama.ts` cloud tags), NanoGPT (`nanogpt.ts`), Google token counts (`tokenizer.ts`), OpenAI TTS (`tts.ts`, the official URL with a stored key; a custom URL with a stored key and no own key alerts `ttsCustomUrlNeedsKey`), DALL-E and Imagen (`stableDiff.ts`), Whisper (`PlaygroundSubtitle.svelte`), the memory embeddings (`hypamemory.ts`, `hypamemoryv2.ts`, unless the processor has its own key; the browser's memory summarizers that made the completions calls were removed at the Phase 5 cutover, the server's `openai-completions` operation stays).
- `src/ts/network/channelCallSource.ts` (Phase 5 slice 7a): `activeChannelCall()`, the job callback running in this tab (`jobChannel.ts` registers its `currentChannelCall` when it loads; before that none runs), which `requestServer` sends as `channelCall`.
- `src/ts/network/generationJobs.ts` (Phase 5 slice 5): the client transport of server generation jobs (`shared/jobs.ts`; server side in `self-host-server.md`). `generationClientId` (one per tab, `sessionStorage`), the saved jobs per chat (`savedGenerationJobs`, `rememberGenerationJob`, `forgetGenerationJob`), `createGenerationJob` (`GenerationBusyError`, `GenerationStaleError`, the epoch mismatch), `readGenerationJob`, `abortGenerationJob`, `followGenerationJob` (the owner socket with a fresh JWT; events of another epoch dropped; `send` for the channel's answers; a newer follow of the same job cancels the older one (its socket, even while connecting, its events, and its sends) and sends a higher `attach` stamp (`performance.timeOrigin + performance.now()`, increasing across reloads); `closed` reports whether a terminal event arrived; a 412 runs the resource client's restore halt), `applyGenerationEvent(jobId, ref, event, transport?)` (into `applyServerGeneration`, `applyHydration`, and `endServerJob`; channel events to `jobChannel.ts` with the follow as their transport; the dispatcher loads on first use and runs on one chain in socket order; a `preset` event, a send's `presetChain` pick, applied with `changeToPreset(id, true)` once per job and page, slice 9), and `resumeSavedGenerations` (attach again after a reload). `createGenerationJob` sends `registeredHooks()` unless the caller passes a list.
- `src/ts/network/jobChannel.ts` (Phase 5 slice 6): the client dispatcher of the job channel. Notices map to `alert.ts`, `ReloadGUIPointer`/`ReloadChatPointer` (by `chaId`/`chatId`/`messageId` when that chat is shown), `CharEmotion`, `hypaV3ProgressStore`, `sayTTS`, and `Notification`. The alert store is one queue: while a question or a modal notice is open, alert notices (toasts too) and later questions wait, and each modal is awaited; a `cancel` closes the question showing (`alertClear`) and drops its result. A question is answered with the alert's raw result (the alert API has no separate dismissal; `cancelled` is not produced). Callbacks run behind the barrier (`flushResources()`, the newest remembered hydration of every listed receipt applied again, each held at least as new, else `failed`/`barrier`), then the hook set by name under the job's targets (`invokeHook`; interceptors and MCP tools run without the hook context, as the browser path does), then `flushResources({ scope })` even when the hook threw (discarded keys or a rejection: `failed`/`barrier`; the hook's throw: `failed`/`hook`). Replacers and edit hooks stop at the first throw; interceptors log and continue. `chatOutput` (slice 11a) runs the output listeners in order, each with a plain copy of the speaker and the chat as they are then and indices looked up again, logs a listener's throw, and answers `true`; `imggen` runs `stableDiff` for the job's chat (its `check` stops it before the image request once the callback is cancelled); `provider` (slice 11b) calls the plugin provider with the server's argument and an `AbortSignal` the callback's cancel aborts: a text answers `{ success, content }`; a stream is read here and sent as `chunk` messages with the text so far (the first at once, then at most every 50 ms and at the end) before the answer `{ success: true, streamed: true }`, a failed stream is read whole into the answer, and either reader is cancelled when the callback ends first (also when the provider returned the stream after the cancel); a text over 4 MiB characters or a provider no longer loaded is a `hook` failure. `mcpList` and `mcpTool` (slice 12) answer the tools and a tool's content of an MCP that lives in the tab: a `plugin:` MCP as it is registered now, or `internal:fs`/`internal:googlesearch` through `readyTabClient` (`plugins-mcp.md`; the handshake may show a directory picker or a credential prompt); a client's throw is a `hook` failure. The `openURL` notice opens an `http(s)` address (an MCP server's OAuth page). `selectedChat` (slice 12b) answers the id of the chat this tab has selected for a character (the selection is per tab), or `null`. `recentEmotions(chaId)` gives the emotions the tab showed last for a chat's character or group members, which `createGenerationJob` sends as `context.client.emotions`. A job that ends closes the HypaV3 progress overlay it left open. Request state is kept in memory: a duplicate never runs twice (the cached answer is resent), and a `replay` the page has no state for is refused. `currentChannelCall()` is the innermost callback running (registered with `channelCallSource.ts` for slice 7a's aux requests); `registeredHooks()` builds the hook list from the active registries (`createGenerationJob` sends it).
- `src/ts/dragTypes.ts`: `RISU_*_DRAG_TYPE` custom MIME types. They keep in-app drags from being treated as file imports.
- `src/ts/iris.ts` `getIrisSystemPrompt`, and `IrisModal.svelte`: a visual-novel-style assistant. It calls `requestChatData(..., 'otherAx')` and persists the dialogue in `irisDialogue` (a `ui` field) (saved on the server; older browser copies are imported at boot).

## Flows

`globalFetch`:

1. Applies `bodyIntercepterStore` interceptors, timeout, and local-network policy.
2. Picks a transport, in order: a qualifying local-network route → the proxy; otherwise plain `fetch` (localhost hosts, `plainFetchForce`/`usePlainFetch`), userscript `userScriptFetch`, or the proxy.
3. Proxy target: same-origin `/proxy2` on the self-host server.
   - Headers: `risu-url`, `risu-header` (encoded JSON), optional `risu-auth` and `x-risu-tk`, timeout.

`fetchNative`:

1. The body must be a string, `Uint8Array`, or `ArrayBuffer`, and is required for POST/PUT.
2. A qualifying local-network route goes through `/proxy2`.
3. Otherwise userscript `userScriptFetch` when present, else a direct `fetch`.

(The local-network OpenAI streaming path through `/proxy-stream-jobs`, `fetchViaProxyJobWs`, served only the browser's provider adapters and was removed at the Phase 5 cutover; the server route stays for one more phase, `self-host-server.md`.)

Alerts:

1. The caller runs, e.g., `await alertConfirm(msg)`, which writes `alertStore`.
2. `AlertComp` renders.
3. A button sets `{type:'none', msg:result}`.
4. The helper's poll loop resolves.

## State

- `forageStorage` logical keys: `assets/*` only (the database is in the server resources).
- `fetchLog[]` is private. `getFetchLogs` exposes the live array. `appendFetchLog(entry)` adds an entry the server built (the `log` events of `/api/llm/request`, credentials redacted): the provider calls the server makes appear in the tab's request log.
- `chatFoldedState.data` is `{charId, chatId, messageId}`.

## Coupling

- `globalApi.svelte.ts` imports `database.svelte.ts`, `storage/resourceSync.svelte.ts`, `storage/resourceClient.ts`, `stores.svelte.ts`, alerts, `characterCards.ts` (`characterURLImport`), and the network helpers.
- Its importers: nearly every process, storage, UI, and plugin module.

## Invariants

- Use `globalFetch`/`fetchNative` for every remote call so that proxy, Node routing, and logs apply; a call that needs a stored LLM credential uses `auxFetch` with a `server/src/llm/auxOps.ts` row instead (the tab never reads a credential).
- Do not bypass the proxy auth headers. On Node, the server's `sanitizeTargetUrl` is a second SSRF boundary for proxy jobs only.
- Asset references are logical `assets/...` paths, never URLs or OS paths.
- Each alert close path must write `type: 'none'`, or the awaiting caller hangs forever.
  - `alertSelect` encodes options joined with `||`.
  - `alertConfirm` returns true only for the exact `'yes'`.
- Keep the keypair stored by `util.ts:saveKeypairStore` non-extractable. `NodeStorage` keeps its JWT signing key in IndexedDB `DPoPDB`, store `node`, record `dpop`; keep that format.

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
- Change save behavior: `storage/resourceSync.svelte.ts` and the callers of `markCharactersDirty`. See `persistence.md`.

## Tests

- `src/ts/sourcemap.test.ts`, `src/ts/network/localNetwork.test.ts`.
- `src/ts/network/generationJobs.test.ts` also covers the `preset` event (slice 9): applied with `changeToPreset(id, true)` once per job, a repeated or changed event of the same job ignored, another job's applied again.
- `src/ts/network/auxFetch.test.ts`: `auxFetch` (Phase 5 slice 7b): the save barrier before anything is sent, the operation's method and the caller's headers with no credential, JSON, bytes, and a `FormData` body serialized once with its boundary, the body interceptors in order, a failed key save or a halt failing the call, an abort during the barrier or an interceptor settling at once with no later interceptor or request, no unobserved rejection from a hook that aborts synchronously or rejects late, the dispatch check after authentication, and `auxFetchJson`.
- Nothing directly tests `globalFetch`/`fetchNative` routing, `saveDb`, the writers, the alert protocol, or `util.ts`.

## Known Hazards

- `addFetchLog` always returns 0, and streamed log piping assumes the newest entry is at index 0. Concurrent streams can attach response text to the wrong log.
- The client `isLocalNetworkHost` accepts bare single-label hosts, but the server's version does not. A Node proxy job can be rejected, and the request then falls back to unrestricted `/proxy2`.
