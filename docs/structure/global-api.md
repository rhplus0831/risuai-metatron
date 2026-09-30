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
  - `fetchViaProxyJobWs`: internal.
- Writers: `LocalWriter` (the backup record framing `writeBackup`, streamed through `streamsaver`), `VirtualWriter`, `BlankWriter`, `AppendableBuffer`.
- Chat and UI:
  - `changeChatTo` (selects a chat of the selected character by index through the chat module's `selectChat`; per tab), `createChatCopyName`.
  - `chatFoldedState`, `chatFoldedStateMessageIndex`, `foldChatToMessage`.
  - `checkCharOrder`.
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
- `src/ts/network/localNetwork.ts`: `isLocalNetworkHost`, `isLocalNetworkUrl`. Accepts private/loopback/link-local IPs, `.local`, and bare single-label hosts.
- `src/ts/network/proxyJobWs.ts`: the `ProxyJobWsEvent` union (`job_accepted|upstream_headers|chunk|error|done|ping`), plus `parseProxyJobWsEvent`, `decodeProxyJobWsChunk`, `formatProxyStreamErrorMessage`.
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
2. A qualifying local-network route goes through the proxy: step 4 for OpenAI streaming, otherwise `/proxy2`.
3. Otherwise userscript `userScriptFetch` when present, else a direct `fetch`.
4. Local-network OpenAI streaming → `fetchViaProxyJobWs`:
   1. POST `/proxy-stream-jobs`.
   2. Open the WS `/proxy-stream-jobs/:id/ws`.
   3. DELETE on abort.
   4. Falls back to `/proxy2`.

Alerts:

1. The caller runs, e.g., `await alertConfirm(msg)`, which writes `alertStore`.
2. `AlertComp` renders.
3. A button sets `{type:'none', msg:result}`.
4. The helper's poll loop resolves.

## State

- `forageStorage` logical keys: `assets/*` only (the database is in the server resources).
- `fetchLog[]` is private. `getFetchLogs` exposes the live array.
- `chatFoldedState.data` is `{charId, chatId, messageId}`.

## Coupling

- `globalApi.svelte.ts` imports `database.svelte.ts`, `storage/resourceSync.svelte.ts`, `storage/resourceClient.ts`, `stores.svelte.ts`, alerts, `characterCards.ts` (`characterURLImport`), and the network helpers.
- Its importers: nearly every process, storage, UI, and plugin module.

## Invariants

- Use `globalFetch`/`fetchNative` for every remote call so that proxy, Node routing, and logs apply.
- Do not bypass the proxy auth headers. On Node, the server's `sanitizeTargetUrl` is a second SSRF boundary for proxy jobs only.
- Asset references are logical `assets/...` paths, never URLs or OS paths.
- Each alert close path must write `type: 'none'`, or the awaiting caller hangs forever.
  - `alertSelect` encodes options joined with `||`.
  - `alertConfirm` returns true only for the exact `'yes'`.
- Keep the keypair stored by `util.ts:saveKeypairStore` non-extractable. `NodeStorage` keeps its JWT signing key in IndexedDB `DPoPDB`, store `node`, record `dpop`; keep that format.

## Recipes

- Change network routing:
  1. Edit `globalFetch`, `fetchWithProxy`, `fetchNative`, and `fetchViaProxyJobWs`.
  2. Update `server/src/routes/proxy.ts` if the contract changes.
  3. Verify direct, proxied, local-network, abort, and timeout behavior.
- Add an asset kind: `saveAsset`, `loadAsset`, `readImage`, `getFileSrc`, plus migrations. Verify Node storage and the service worker.
- Add an alert:
  1. Extend `alertData`.
  2. Add a helper in `alert.ts`.
  3. Add a render and resolve branch in `AlertComp.svelte`.
- Change save behavior: `storage/resourceSync.svelte.ts` and the callers of `markCharactersDirty`. See `persistence.md`.

## Tests

- `src/ts/sourcemap.test.ts`, `src/ts/network/localNetwork.test.ts`, `src/ts/network/proxyJobWs.test.ts`.
- Nothing directly tests `globalFetch`/`fetchNative` routing, `saveDb`, the writers, the alert protocol, or `util.ts`.

## Known Hazards

- `addFetchLog` always returns 0, and streamed log piping assumes the newest entry is at index 0. Concurrent streams can attach response text to the wrong log.
- The client `isLocalNetworkHost` accepts bare single-label hosts, but the server's version does not. A Node proxy job can be rejected, and the request then falls back to unrestricted `/proxy2`.
