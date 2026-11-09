# Assets: Sources, Client, Queues, Batch Codec

## Scope

- Owns the tab's asset transport: how `assets/` keys become URLs (direct or fallback, thumbnails, holds, signed
  fetches), the asset and storage report clients, the bulk save queues and batched reads, and the batch record framing
  both sides share.
- Paths: the asset functions of `src/ts/globalApi.svelte.ts`, `src/ts/storage/asset{Client,Queue,LifecycleClient}.ts`,
  and `shared/assetBatch.ts`.
- Not here:
  - The asset routes, their verification budget, and the HTTP cache → [self-host server](self-host-server.md).
  - The worker that signs subresource loads → [build-test-platforms](build-test-platforms.md).
  - Inlay storage → `chat-pipeline.md` (`files/inlays.ts`); the card and module import pipelines →
    [characters-modules](characters-modules.md).
  - The rest of `globalApi.svelte.ts`, the alerts, and `util.ts` → [global-api](global-api.md); fetch routing and the
    job client → [network-jobs](network-jobs.md).

## Files

### Asset sources

`src/ts/globalApi.svelte.ts` (its asset functions) turns `assets/` keys into URLs, each call in direct mode or the
fallback ([Flows](#flows)). The mode, lifetime, and failure rules are on each export and on `loadFileSrc`.

- `getFileSrc` (a fallback source stays pinned for the page; a failed read resolves `""` unless the caller passes
  `rejectFailedReads`, which only a chat row's render does; only network failures, 408, 429 and 5xx retry),
  `holdFileSrc` (`{ src, release }` for previews), `getThumbSrc(loc, 256 | 512)`, and `getDirectAssetSrc` (inlay audio
  and video, [CBS rendering](cbs-rendering.md)); the fallback's `fileSources`, `loadFileSrc`, `SW_REQUEST_TIMEOUT_MS`,
  and `FILE_SOURCE_RELEASE_GRACE_MS`.
- `fetchFileSrc` (rich copy's images and icons) and `withFileSrcFetch` (screenshot capture) sign `fetch()` of displayed
  asset URLs, which the worker does not sign. `SCREENSHOT_CAPTURE_OPTIONS` (`src/lib/ChatScreens/screenshotCapture.ts`)
  keeps a captured thumbnail from standing in for the full image.
- `setUsingSw`, `setDirectAssets`: the two flags `src/ts/bootstrap.ts` sets.

### Asset client

`src/ts/storage/assetClient.ts`: the asset files, which `globalApi.svelte.ts` reads and writes through it. Its header
has the routes, the record framing ([batch codec](#batch-codec)), and the retry rule; each function's comment has its
errors.

- One file: `readAsset`, `writeAsset`, behind globalApi's `saveAsset` (key from `assetKey`; a canonical save asks
  `missingAssets` first; present means a one-hour lease), `loadAsset`, and `readImage`. A non-2xx `readAsset` response
  throws an `AssetReadError` with numeric `status` and message `"getItem Error"`.
- Batches: `writeAssets` (the skip rule for `AssetWriteItem.sha256`, asked per batch), `readAssets`, and
  `missingAssets`, behind globalApi's `saveAssetBatch` and `loadAssets`; `ASSET_BATCH_CLIENT_RECORDS`,
  `ASSET_BATCH_CLIENT_BYTES`, `MISSING_CHECK_DEADLINE_MS`, and `assetContentHash`.
- `src/ts/storage/assetLifecycleClient.ts`: the Storage page's report, scan, sweep, and lease-free preview calls.

### Asset queues

`src/ts/storage/assetQueue.ts`: the bounded save queues for bulk imports and the batched export reads. Its comments
state admission, batching, settlement, and failure.

- `saveAssets` (`AssetSaveItem`, `AssetSaveError`; asks again before returning), `savePickedFiles`, `AssetSaveQueue`
  (the in-tab `CharXImporter`, `src/ts/process/processzip.ts`), and `loadAssetsInBatches`.

### Batch codec

`shared/assetBatch.ts`: the batch routes' record framing, shared with the backup archive (`server/src/data/archive.ts`);
it runs on both sides.

- `encodeAssetRecordHeader`, `AssetRecordParser` (`push`, `events`), `AssetBatchFormatError`, `MAX_ASSET_BATCH_RECORDS`,
  `MAX_ASSET_BATCH_NAME_BYTES`, `ASSET_BATCH_WRITE_PATH`, and `ASSET_BATCH_READ_PATH`.

## Flows

Asset sources use direct URLs only while boot recorded a ready worker (`setUsingSw`) and the controlling worker reports
`directAssets: true` on `/sw/init` (`setDirectAssets`); otherwise each call takes the fallback, a worker cache URL or an
object URL ([Asset sources](#asset-sources)). A `controllerchange` clears the capability until the new controller's
probe answers; a direct `img`, `audio`, `video`, or `source` already on the page that then errors retries once through
the fallback (`recoverDirectAssetElement`: a capture-phase `error` listener per chat body, the lazy image wrappers, and
the home and settings images), and an error while direct assets are still usable is left alone. A change that leaves no
controller also drops the resolved `/sw/img` sources (`invalidateWorkerFileSources`) and the parser's `fileSrcCache`,
and the fallback never returns a `/sw/img` URL without a controller, so later reads take an object URL. The probe and
the worker's signing: [build/test](build-test-platforms.md#direct-assets); the asset route, thumbnails, and HTTP cache:
[server](self-host-server.md#storage-routes).

## State

- Asset logical keys (`storage/assetClient.ts`): `assets/*` only (the database is in the server resources).

## Coupling

- Assets go `globalApi` ([Asset client](#asset-client)) or `inlays.ts` → `assetClient.ts` → `/api/read|write`; its batch
  calls go to `/api/assets/write|read`.
- Bulk import writes go `saveAssets` → `saveAssetBatch` → `writeAssets`; card and module export reads go
  `loadAssetsInBatches` → `loadAssets` → `readAssets` ([Asset client](#asset-client)).

## Invariants

- Asset references are logical `assets/...` paths, never URLs or OS paths.
- Bulk asset writes use `saveAssets`, or `AssetSaveQueue` for arriving items, never a `saveAsset` loop: each fresh
  canonical asset makes a missing check and a write in the storage rate bucket (`server/src/app.ts`), which
  `AssetSaveQueue` bounds but still makes per item. Keep loads lazy and producers under queue admission.

## Recipes

- Add an asset kind: `saveAsset`, `loadAsset`, `readImage`, `getFileSrc`, plus migrations. Verify Node storage and the
  service worker.

## Tests

- Vitest:
  `pnpm --silent test:agent src/ts/globalApi{Retention,Thumbnails}.test.ts src/ts/screenshotCaptureCache.test.ts src/ts/storage/tests/asset{Client,Queue,LifecycleClient}.test.ts shared/tests/assetBatch.test.ts`.
- Asset fixture: `src/ts/storage/tests/assetClientMock.ts` (`createAssetClientMock`) reports every asset missing.
  `src/ts/storage/tests/assetClient.test.ts` uses fake routes controlled through mocked `authFetch` and
  `answer.current`.
- Browser specs: `pnpm --silent test:agent --e2e e2e/storedFileSrc.spec.ts` ([test-harness](test-harness.md)). Probes:
  `util/playwright/measureFileSources.mjs` and `probeDirectAssets.mjs`.
- Slow: the server asset batch cap in `server/src/tests/assets.test.ts` is `slow` ([test-harness](test-harness.md)).

## Known Hazards

### Limitations

- A PNG card read from a one-shot stream (a Chub download) keeps each asset's base64 text in its `saveAssets` item for
  the final presence pass; a `File` or `Blob` rereads its byte range. Decision: Implementation Audit Fixes Q1.
- Likewise a JSON card's embedded assets (`saveEmbeddedAssets`) and a V3 card's `data:` URI assets
  (`src/ts/characterCards.ts`) keep their base64 text, about 4/3 of the decoded bytes, reachable until the import's
  hand-off ends: `saveAssets` and the hand-off replay an item's `load`, and a JSON string has no byte range to reread.
  Decision: Found Issues Clearance AUD-5 (owner, 2026-11-09).
- In the fallback every plain `getFileSrc` read (parser HTML, chat rows, icons) pins its source for the page; only
  `holdFileSrc` previews release theirs, so pinned `blob:` URLs grow with the distinct assets rendered until a reload. A
  fallback `blob:` URL is typed `image/png`; video and audio rely on the `<source type>` the parser writes. Decision:
  asset-scale D2b left open (2026-10-23), Audit Findings and Performance Leftovers,
  [archive](../archived-plan/README.md).
- The asset UIs' first name filter after an edit of a character's asset field copies the live list once
  (`characterAssetNames`, `src/ts/assetList.ts`; about 0.3 to 0.6 s at 100,000 assets); later queries reuse the names
  until the field changes. Decision: Heap Memory Reduction, [archive](../archived-plan/README.md); Found Issues
  Clearance (owner, 2026-11-09).
- Without a capable controlling service worker, the fallback's audio and video object URLs (`getInlayObjectUrl`,
  `mediaObjectUrls` in `src/ts/process/files/inlays.ts`) live for the page: they grow with the distinct media played,
  past the 64 MiB `blobCache` budget, until a reload. Decision: Found Issues Decisions (owner, 2026-11-08).
