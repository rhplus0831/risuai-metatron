# Assets: Sources, Client, Queues, Batch Codec

## Scope

Use this guide for the tab's logical asset keys, display URLs, thumbnails, preview lifetimes, signed fetches, bulk save
and read queues, Storage cleanup client and shared batch framing. The [server](self-host-server.md#storage-routes) owns
storage routes and caching. The [service worker](build-test-platforms.md#direct-assets) signs subresources. For the
contents of an import, see [cards and modules](characters-modules.md) or [inlays](chat-pipeline.md).

## Files

### Asset sources

- `src/ts/globalApi.svelte.ts` exposes `getFileSrc` for display, `holdFileSrc` for releasable previews, `getThumbSrc`
  for thumbnail variants and `getDirectAssetSrc` for inlay media. `getFileSrc` and `loadFileSrc` document direct and
  fallback errors, chat render retries (`rejectFailedReads`), worker timeouts and source lifetime.
- `fetchFileSrc` (rich copy) and `withFileSrcFetch` (screenshots) sign programmatic asset fetches of displayed URLs. The
  worker signs eligible element loads. For full-resolution capture, follow `SCREENSHOT_CAPTURE_OPTIONS` in
  `src/lib/ChatScreens/screenshotCapture.ts`.

### Asset client

- `src/ts/storage/assetClient.ts` owns authenticated reads and writes (`readAsset`, `writeAsset`, `readAssets`,
  `writeAssets`). In `src/ts/globalApi.svelte.ts`, `saveAsset` derives its key with `assetKey`. For a canonical key
  without a custom id it first asks `missingAssets`. Verified presence establishes a one-hour lease. `AssetReadError`
  preserves HTTP status for callers that retry rendering. `AssetWriteError` preserves a failed write's status (its
  message stays `setItem Error`, never the server's text); the chat attachment alert names a 413
  (`src/ts/process/files/multisend.ts`).
- For batch transfers, follow globalApi's `saveAssetBatch`/`loadAssets` into `writeAssets`/`readAssets`.
  `AssetWriteItem.sha256` controls when a verified upload may be skipped. Batch limits and `MISSING_CHECK_DEADLINE_MS`
  live beside these calls.
- `src/ts/storage/assetLifecycleClient.ts` serves the Storage page. `readStorageStatus` polls without fetching the
  candidate list. `loadAssetPreview` returns a releasable, lease-free preview. `sweepAssets` sends selected keys and
  inlay ids to the [cleanup routes](self-host-server.md#storage-routes).

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

1. `src/ts/bootstrap.ts` probes the worker at `/sw/init` during registration. Direct display requires the ready-worker
   flag (`setUsingSw`), a positive capability (`setDirectAssets`) and a controller. Otherwise display calls use
   `loadFileSrc` for a worker cache URL or an object URL.
2. A controller change clears the capability. Loss of the controller also invalidates resolved `/sw/img` sources
   (`invalidateWorkerFileSources`) and the parser's `fileSrcCache`.
3. If an existing direct image, audio, video or source element fails after capability loss, `recoverDirectAssetElement`
   retries it once through the fallback. See [worker signing](build-test-platforms.md#direct-assets) and
   [server caching](self-host-server.md#storage-routes).

## State

The server stores asset bytes by logical `assets/` key. Direct display uses the browser's private HTTP cache. In the
fallback, `fileSources` in `src/ts/globalApi.svelte.ts` tracks pinned page reads and releasable preview holds. Its
`FILE_SOURCE_RELEASE_GRACE_MS` allows another preview to reuse an unpinned object URL before revocation.

## Coupling

- Card and module importers use `saveAssets` or `AssetSaveQueue` for incoming items. Their exporters consume
  `loadAssetsInBatches`. Each crosses the [asset client](#asset-client) and [batch codec](#batch-codec) to reach the
  [server storage routes](self-host-server.md#storage-routes). Inlay metadata belongs to
  [the chat pipeline](chat-pipeline.md).
- An archive shares the batch record framing. A codec change also reaches `server/src/data/archive.ts` and the
  [backup importer and exporter](server-resources.md#archive-export-and-import).

## Invariants

- Asset references are logical `assets/...` paths, never URLs or OS paths.
- Bulk asset writes use `saveAssets`, or `AssetSaveQueue` for arriving items, never a `saveAsset` loop: each fresh
  canonical asset makes a missing check and a write in the storage rate bucket (`server/src/app.ts`), which
  `AssetSaveQueue` bounds but still makes per item. Keep loads lazy and producers under queue admission.
- An import or export path over a whole file or many assets reuses `serveFileImport` (`server/src/http/fileImport.ts`),
  `loadAssetsInBatches`, and `saveAssetBatch`, never a loop of its own: the local loops they replaced copied whole files
  in memory and sent one request per asset.

## Recipes

- For a new stored asset kind, start with `saveAsset` and `assetKey`, add the logical reference to its owning resource,
  and check the [server mark](self-host-server.md#asset-mark) retains it. Verify the appropriate MIME classification in
  `shared/assetMime.ts` and display with and without a direct-capable worker.
- For candidate cleanup previews use `loadAssetPreview` and release it on unmount. A normal asset read would renew the
  candidate's lease.

## Tests

- Vitest:
  `pnpm --silent test:agent src/ts/globalApi{Retention,Thumbnails}.test.ts src/ts/screenshotCaptureCache.test.ts src/ts/storage/tests/asset{Client,Queue,ReadQueue,LifecycleClient}.test.ts shared/tests/assetBatch.test.ts`.
- Asset fixture: `src/ts/storage/tests/assetClientMock.ts` (`createAssetClientMock`) reports every asset missing.
  `src/ts/storage/tests/assetClient.test.ts` uses fake routes controlled through mocked `authFetch` and
  `answer.current`.
- Controller loss and chat-row retries:
  `pnpm --silent test:agent src/ts/bootstrap.serviceWorker.test.ts src/lib/ChatScreens/ChatBody.assetReads.svelte.test.ts`.
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
