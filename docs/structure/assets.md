# Assets: Sources, Client, Queues, Batch Codec

## Scope

- Owns the tab's asset transport: how `assets/` keys become URLs (direct mode and the worker fallback, thumbnails, holds
  and releases, the signed fetch for copies and screenshots), the asset client's reads and writes with the missing check
  and the batch caps, the bounded save queues and batched reads of bulk imports and exports, and the batch record
  framing both sides share.
- Paths: the asset functions of `src/ts/globalApi.svelte.ts`, `src/ts/storage/{assetClient,assetQueue}.ts`, and
  `shared/assetBatch.ts`.
- Not here:
  - The asset routes, their verification budget, and the HTTP cache → [self-host server](self-host-server.md).
  - The worker that signs subresource loads → [build-test-platforms](build-test-platforms.md).
  - Inlay storage → `chat-pipeline.md` (`files/inlays.ts`); the card and module import pipelines →
    [characters-modules](characters-modules.md).
  - The rest of `globalApi.svelte.ts`, the alerts, and `util.ts` → [global-api](global-api.md); fetch routing and the
    job client → [network-jobs](network-jobs.md).

## Files

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

## Flows

Asset sources use direct URLs only while the controlling worker reports `directAssets: true`; otherwise calls use the
fallback in [Asset sources](#asset-sources). Direct-mode 401s and network failures do not retry through `readAsset`.
Worker details: [build/test](build-test-platforms.md); asset route and HTTP cache behavior:
[server](self-host-server.md).

## State

- Asset logical keys (`storage/assetClient.ts`): `assets/*` only (the database is in the server resources).

## Coupling

- Assets go `globalApi` (`readImage`, `saveAsset`, `loadAsset`, `getFileSrc`) or `inlays.ts` → `assetClient.ts` →
  `/api/read|write`; its batch calls go to `/api/assets/write|read`, and a canonical `saveAsset` asks
  `/api/assets/missing` first.
- Bulk import writes go `saveAssets` → `saveAssetBatch` → `writeAssets`; card and module export reads go
  `loadAssetsInBatches` → `loadAssets` → `readAssets` ([Asset client](#asset-client)).

## Invariants

- Asset references are logical `assets/...` paths, never URLs or OS paths.
- Bulk asset writes use `saveAssets`, or `AssetSaveQueue` for arriving items, never a `saveAsset` loop: each fresh
  canonical asset makes a missing check and a write in the storage rate bucket (`server/src/app.ts`). Keep loads lazy
  and producers under queue admission.

## Recipes

- Add an asset kind: `saveAsset`, `loadAsset`, `readImage`, `getFileSrc`, plus migrations. Verify Node storage and the
  service worker.

## Tests

- Vitest:
  `pnpm --silent test:agent src/ts/globalApi{Retention,Thumbnails}.test.ts src/ts/screenshotCaptureCache.test.ts src/ts/storage/tests/asset{Client,Queue}.test.ts shared/tests/assetBatch.test.ts`.
- Asset fixture: `src/ts/storage/tests/assetClientMock.ts` (`createAssetClientMock`) reports every asset missing.
  `src/ts/storage/tests/assetClient.test.ts` uses fake routes controlled through mocked `authFetch` and
  `answer.current`.
- Browser specs: `pnpm --silent test:agent --e2e e2e/storedFileSrc.spec.ts` ([test-harness](test-harness.md)). Probes:
  `util/playwright/measureFileSources.mjs` and `probeDirectAssets.mjs`.
- Slow: no client tests; the server asset batch cap in `server/src/tests/assets.test.ts` is `slow`
  ([test-harness](test-harness.md)).
- Not tested: none recorded beyond that; the browser spec and the probes cover the worker paths.

## Known Hazards

### Issues

- Direct URLs already handed out are not re-rendered when the page loses its controller or capability. Without a signing
  worker they load from the browser HTTP cache or fail with 401; only new source calls use the fallback.
