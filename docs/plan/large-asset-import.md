# Large Asset Import and Export Plan

Status: slices 1a (a034d709b), 1b (b30ed11a3), 1c (0b4ff36e0), 2a (6e05701ad), 2b (e827f55ef), 2c (278ac122b), 2d (7faeb8546), 2e (646e44b12), 3a (19e9642ab), 3b (4e30454ba), 3c (34e2c6eae), 4a (1f7db4939), and 4b (187760182) landed on 2026-10-17 and 2026-10-18; every slice has landed. Each slice is one session, one
commit, one file cluster. Re-verify the cited identifiers before editing.

## Problem

Importing `save/XX asset default SFW.risum` (580 MB, 11,033 rpack-encoded
assets of about 50 KB each) fails on two fronts, and an audit of 2026-10-17
(two independent read-only passes, every finding below re-read in the code)
found the same two mechanisms on most other bulk import, export, and listing
paths:

- **(A) Whole file in memory, copied several times.** `selectSingleFile` reads
  the File with `FileReader`; `importModule` copies it again with
  `Buffer.from(Uint8Array)` (the `buffer` polyfill copies a typed array; it
  wraps an `ArrayBuffer`); `readModule` decodes each asset into a third
  array and keeps the whole input alive until the last upload finishes.
- **(B) One authenticated request per asset.** `saveAsset` → `writeAsset` →
  `POST /api/write`, ten in flight. The server's `authenticatedRouteLimiter`
  (`server/src/app.ts`) is one bucket of 2000 requests per minute per client
  IP, shared by storage, resources, generation, and the proxies. The asset
  client never retries a 429 (`readAsset`/`writeAsset` throw `getItem Error` /
  `setItem Error`); only `readModule` retries, three times with a 5 s sleep,
  which is not enough for 11k writes. The storm also 429s the tab's resource
  sync and every other tab behind the same IP.

The model for a good large-file path already exists: `POST /api/backups/import`
(`server/src/routes/backups.ts`) spools its raw body to `save/.tmp/`, exempt
from the 100 MiB `bodyLimit` and capped by `RISU_MAX_IMPORT_BYTES`, then
processes records from the file.

### Audit findings (the inventory this plan closes)

| Id  | Path                                                                                           | Class | Mechanism                                                                                                                                                                                                                                                              | Severity    |
| --- | ---------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| M1  | `.risum` import, `src/ts/process/modules.ts` `readModule`/`importModule`                       | A+B   | The problem above. Entry points: `importModule`, `src/App.svelte` drop, `#share_module` (the worker's `risuCache` copy), launchQueue and `#import=`, and a CharX's `module.risum` (`characterCards.ts`).                                                               | high        |
| M2  | `.risum` import                                                                                | —     | `readModule` never asks the `lowLevelAccessConfirm` question; the JSON path does (`characters-modules.md` Invariants say every module import must).                                                                                                                    | medium      |
| C1  | CharX import, `src/ts/process/processzip.ts` `CharXImporter`                                   | A+B   | One `saveAsset` per zip entry behind a 10-wide `Semaphore`, no retry, `done()` rejects with an `AggregateError`. `#handleFileData` does not await `#processAssetQueue`, so fflate decodes the whole archive into queued buffers.                                       | high        |
| C2  | CharX import, `processzip.ts` `#handleFile`                                                    | A     | `file.originalSize ?? 0 < MAX_ASSET_SIZE_BYTES` parses as `originalSize ?? (0 < MAX)`, so the 50 MiB skip never runs; an oversized entry is fully inflated into a doubling `AppendableBuffer`, copied by `.buffer`, then excluded.                                     | medium      |
| C3  | Realm download, launchQueue, `#import=` (`characterCards.ts`)                                  | A     | `res.arrayBuffer()` / `file.arrayBuffer()` instead of a stream, so CharX and PNG lose the streaming the importers support.                                                                                                                                             | low–medium  |
| P1  | PNG card import, `characterCards.ts` `importCharacterProcess`                                  | A+B   | A `ReadableStream` input is `tee()`d and one branch fully consumed to count `chara-ext-asset_` chunks, so the other branch buffers the whole download; then one serial `saveAsset` per chunk, no retry, orphans on failure.                                            | medium–high |
| P2  | Embedded base64 assets, `characterCards.ts` `importCharacterCardSpec`                          | B     | v2 emotions, `additionalAssets`, `vits`, and v3 `data:` URIs: one `saveAsset` each; hub mode adds a `GET /hub-proxy/resource/...` per asset under the same bucket. `.json` import copies the file once more (`Buffer.from`) then parses.                               | medium      |
| E1  | Legacy module export, `modules.ts` `exportModuleLegacy`                                        | A+B   | 11k serial `readImage` calls, no retry; the output grows in a doubling `AppendableBuffer` (1 GiB for the sample), `.buffer` slices it, `downloadFile` copies it (`new Uint8Array(dat)`), the Blob copies it again: about 2.5–3 GB peak.                                | high        |
| E2  | Module export, `ModuleSettings.svelte` (the share button)                                      | —     | `exportModule`/`exportModuleLegacy` are neither awaited nor caught, so a failure leaves the "Adding Assets i / N" wait alert on screen.                                                                                                                                | low         |
| E3  | Card and module export, `characterCards.ts` `exportCharacterCard`, `modules.ts` `exportModule` | B     | One `readImage`/`loadAsset` per emotion, additional asset, VITS file, and v3 asset, serial, no retry; a 429 is alerted but the streamSaver `LocalWriter` is never aborted, so the user keeps a truncated file. A missing asset (`null`) throws out of `compressImage`. | high        |
| E4  | JSON card export (`exportCharacterCard`, type `json`)                                          | A     | Every asset becomes a base64 `data:` URI inside the card, then `JSON.stringify(card, null, 4)`; the sample would be about 740M characters, at or past V8's string limit, before the `Buffer.from` and `downloadFile` copies.                                           | medium      |
| U1  | Emotion image list, `src/lib/SideBars/CharConfig.svelte` (`{#each emos}`)                      | A+B   | Not paged, unlike the additional-asset list: `getCharImage` → `getFileSrc` for every row at render, no concurrency cap, and `getFileSrc` pins each object URL for the page.                                                                                            | medium–high |
| U2  | `GridCatalog.svelte`, `Sidebar.svelte`, `PersonaSettings.svelte` icon loads                    | B     | `getCharImage` for every entry; only matters with thousands of characters (a large backup restore).                                                                                                                                                                    | low         |
| F1  | Bulk file selection, `src/ts/util.ts` `selectMultipleFile`                                     | A+B   | Every picked file is read before the first upload; callers (`CharConfig.svelte`, `ModuleMenu.svelte`, `AssetInput.svelte`, `characters.ts` `addCharEmotion`) then save one at a time with no retry, plus one record write per push.                                    | medium      |
| F2  | ONNX/VITS zip import, `src/ts/process/transformers.ts` `registerOnnxModel`                     | A+B   | Full-buffer `fflate.unzip`, the filter admits any `.onnx` member, then one `saveAsset` per member; a member over 100 MiB fails `/api/write`.                                                                                                                           | medium      |
| S1  | Rate limiter, `server/src/app.ts`                                                              | B     | One 2000/min bucket for everything authenticated; a storm on one path starves resource sync and other tabs. Resource sync backs off; asset paths do not.                                                                                                               | medium      |

Checked and fine (no need to re-audit): server `/api/read` streams with
`createReadStream` and supports HEAD; `/api/list` is one `readdir`; backups
stream on export and spool on import; the additional-asset, module-asset, and
sticker lists are paged (`ASSET_LIST_PAGE`) with `LazyFileSrc`; `assetList.ts`
indexes names only; `PngChunk.streamWriter` and `CharXWriter` stream into
`LocalWriter`; the hub proxy streams; `readAsset`'s `Buffer.from(ArrayBuffer)`
does not copy; inlays deduplicate reads under an LRU.

Deferred, out of this plan: the Safari/WebKit streamSaver fallback that
retains whole exports (platform behavior); "Export All Chats" materializing a
whole history (history, not assets); the one-time legacy browser-local inlay
migration; unbounded persona and preset decoders (small files in practice).

## Design decisions

1. **Bulk imports run on the server.** A `.risum` or CharX body is spooled to
   `save/.tmp/` like a backup archive, parsed from the file one asset at a
   time, hashed and written with `writeStorageFile`, and the metadata comes
   back with asset keys rewritten. The tab never holds the file: `fetch` with a
   `File`/`Blob` body streams it. This removes both (A) and (B) for M1 and C1
   at once; the client keeps ownership of the record (`prepareModuleImport`,
   the `lowLevelAccess` question, `addModule`/`addCharacter`), so persistence
   invariants D1–D4 are unchanged.
2. **Remaining per-asset paths get batch routes, not bigger limits.** One
   request carrying up to N assets in the backup archive's record framing
   (`server/src/data/archive.ts` `encodeRecordHeader`/`readRecord`), for reads
   (export) and writes (PNG chunks, embedded base64, picked files, zip members).
   The 2000/min bucket stays; a separate storage bucket is a backstop only.
3. **The asset client retries.** `readAsset`/`writeAsset` honor `Retry-After`
   on 429 and 503 with bounded exponential backoff, and a shared save queue
   replaces the three ad-hoc concurrency loops (`readModule`'s
   `runAssetTasks`, `CharXImporter`'s `Semaphore`, the serial loops).
4. **Hashes and keys stay as they are.** Server-side hashing is SHA-256 hex of
   the stored bytes, the same as the client `hasher`, and module assets keep
   the `.png` extension the client has always given them (the extension is not
   sniffed; keeping it means re-imports dedupe against earlier ones).
5. **Fail closed, orphans allowed.** An import that cannot write every asset
   adds no record; already-written asset files are content-addressed and
   harmless, as with today's partial failures.
6. **The rpack codec moves to `shared/`.** It is 20 lines over a 512-byte map
   (`src/ts/rpack/rpack_map.bin`); inline the map as a hex constant in
   `shared/rpack.ts`, keep the vendored directory's license files, and have
   `src/ts/rpack/rpack_js.js` re-export it so existing imports keep working.

## Phase 1: Foundations (client retry, save queue, batch routes)

- **1a. Asset client retry and save queue** (_small_, `global-api.md`,
  `persistence.md`). In `src/ts/storage/assetClient.ts`, retry 429/503 (and
  network failure) with `Retry-After` when present, else 1 s doubling to 30 s,
  at most 8 tries, abortable. Add `src/ts/storage/assetQueue.ts`: a
  `saveAssets(items, { concurrency, onProgress, signal })` helper over
  `saveAsset` that bounds in-flight work _and_ admission (an item is not
  decoded or read until a slot is free). Use it in `readModule`,
  `CharXImporter` (which also fixes the unawaited `#processAssetQueue`: the
  feed loop awaits admission before pushing the next zip chunk), the PNG
  import, `importCharacterCardSpec`, and `registerOnnxModel`. Tests:
  `src/ts/storage/tests/assetClient.test.ts` (a 429 with and without
  `Retry-After`, the cap, abort) and a queue test (admission blocks, order of
  progress, one failure rejects after the others settle). Closes C1's
  backpressure half and the retry half of every B finding.
- **1b. Batch asset routes** (_hard_, `self-host-server.md`, `persistence.md`). The design the
  2026-10-17 challenge settled on. A shared codec, `shared/assetBatch.ts`: the route paths,
  `MAX_ASSET_BATCH_RECORDS` (2000, the server's cap per request), `MAX_ASSET_BATCH_NAME_BYTES`
  (4096), `encodeAssetRecordHeader` (the backup archive's `u32le nameLength`, UTF-8 name,
  `u32le dataLength` framing; `archive.ts` `encodeRecordHeader` now calls it), and the incremental
  `AssetRecordParser` (`push` returns whole records, `events` yields `start`/`data`/`end` so a
  streaming reader never holds a record, `end` refuses a trailing partial record; a zero-length,
  over-cap, or non-strict-UTF-8 name and a record past the cap are `AssetBatchFormatError`).
  `POST /api/assets/write` (`checkAuth`, raw body): each record's name is the client's full logical
  key, resolved with `resolveStorageKey` (no server-side hashing: `saveAsset`'s `customId` and uuid
  fallbacks and the inlays name their own keys, and `/api/write` already takes any key). Its bytes
  stream into a `save/.tmp/<uuid>.tmp` staging file as they arrive (memory holds a chunk, not a
  record); once the record is complete the route enters the maintenance gate for that record only,
  renames the file into place (always overwriting, as `/api/write` does, so `customId` keys such as
  inlays keep overwriting; a zero-length record is an empty file), and leaves. The gate is never
  held across the body read, because `withMaintenance` waits for every admitted mutation. The
  answer is `{ success: true, written }`. At the first failure (a key with no storage location:
  400 `{ error: "Invaild Path", index }`; a malformed or truncated body: 400
  `{ error: "Invalid asset batch" }`; the gate closed: 503 with `Retry-After: 5`; a filesystem
  error: 500) the route stops writing and removes the staged file, but reads the rest of the body
  to its end before it answers: `@hono/node-server` resets a connection whose body is left unread
  (after 500 ms or 64 MiB), which the client would see as a network failure and resend. Records
  renamed before the failure stay in place; the client resends the whole batch, overwriting them.
  `POST /api/assets/read` (`checkAuth`, JSON `{ keys }` of 1 to 2000 keys, else 400) answers a
  chunked `application/octet-stream` with `Cache-Control: no-store`: one record per key in the
  order asked, duplicates kept, each file read as the backup export reads it (`fileRecord` and
  `iteratorStream`, moved to `server/src/http/recordStream.ts`: no symlinks, size and bytes from one
  handle, a file that shrinks fails the stream), and a zero-length record for a key with no storage
  location, a missing file, a symlink, or a non-regular file (the `/api/read` rule). A client that
  leaves cancels the stream, which closes the open file. Both routes stay under the global 100 MiB
  body limit (Hono passes a `Content-Length` body through untouched; an asset over it fails with
  413, as through `/api/write`) and the 2000/min limiter. Client: `writeAssets(items, { signal })`
  and `readAssets(keys, { signal })` in `assetClient.ts`, over 1a's retry, one batch at a time:
  writes in batches of at most 500 records and 64 MiB of record bytes (a larger single asset goes
  alone), reads in batches of 500 keys; `null` for a zero-length record; `"setItem Error"` /
  `"getItem Error"` for a non-2xx answer, and `"getItem Error"` for a truncated or malformed answer.
  `saveAsset`, `loadAsset`, and the save queue are rewired in 3a and 3c. Tests:
  `server/src/tests/assets.test.ts` (a write batch lands files byte-for-byte readable through
  `/api/read`; an invalid key mid-batch is a 400 with the earlier records kept and the body
  drained; a truncated body is a 400; the gate 503; an oversized body 413; a read batch returns the
  bytes, and a zero-length record for a missing key, a key with no location, and a symlinked file;
  it refuses a non-array or empty `keys` and keeps duplicates in order; the record cap) and a client
  test (the codec round trip and the batch splitting).
- **1c. Storage limiter bucket** (_small_, `self-host-server.md`). Give
  `/api/read`, `/api/write`, `/api/assets/*` their own `createRateLimiter`
  bucket so an asset burst cannot 429 resource sync (`rateLimit.ts` already
  sends `Retry-After` on a 429, which 1a reads). Test in `app.test.ts`.
  Closes S1.

## Phase 2: Server-side bulk import

- **2a. Shared rpack codec** (_small_, `characters-modules.md`). Decision 6.
  `shared/rpack.ts` with `encodeRPack`/`decodeRPack` (synchronous; in-place
  variants for a borrowed buffer) and a test that the inlined map equals
  `rpack_map.bin`. Must precede 2b.
- **2b. `.risum` import route** (_hard_, `self-host-server.md`,
  `characters-modules.md`). `POST /api/import/module`: raw body, exempt from
  `bodyLimit` like the backup import, spooled with `spool` under
  `maxImportBytes`, one import at a time (409 otherwise), 503 under
  maintenance. Parse from the file handle: magic `111`, version `0`, the main
  record (capped at 64 MiB, rpack-decoded, `JSON.parse`, `type` must be
  `risuModule`), then per asset record: decode in place, SHA-256, write
  `assets/<hash>.png` via `writeStorageFile` (skip if present, under
  `maintenance.enter()` per write), free the buffer. Answer as NDJSON: progress
  lines `{ done, total }` then the final `{ module, assetsWritten, assetsSkipped }`
  with `module.assets[i][1]` rewritten, or `{ error }`. Diagnostics record a
  `lifecycle` event like the backup import. Tests in
  `server/src/tests/importModule.test.ts` over an in-test encoded `.risum`
  (the shared codec): keys match the client `hasher`, a truncated file is a
  400 with nothing added, a second import skips existing keys, maintenance
  refuses, the size cap.
- **2c. Client `.risum` path over the route** (_hard_, `characters-modules.md`).
  `selectSingleFile` gains a `File`-returning variant (`selectSingleFileHandle`);
  `readModule(buf)` stays for the CharX-embedded `module.risum` (small) and
  tests, and a new `importModuleFile(file: Blob)` does: read the header and
  main record from `file.slice(0, 6 + mainLen)` locally (cheap: 937 KB for the
  sample), ask `lowLevelAccessConfirm` when set (closes M2, before any upload),
  then `authFetch` the whole `Blob` as the body and consume the NDJSON for
  `alertWait` progress. Switch every entry point: `importModule`, the
  `App.svelte` drop (`file`), `#share_module` (`pending.blob()` instead of
  `arrayBuffer()`), launchQueue and `#import=`. Keep `Buffer.from` out of the
  path. Tests: extend `src/ts/process/modulesImport.test.ts` with a mocked
  route (progress rendered, refusal adds nothing, the lowLevelAccess refusal
  sends nothing). Manual: import the sample through Chrome with the CDP
  profile driver (`playwright-check-runs` memory) and record peak JS heap and
  request count. Closes M1 and M2.
- **2d. CharX import route** (_hard_, `self-host-server.md`,
  `characters-modules.md`). `POST /api/import/charx`: spool, then stream the
  zip from the file (fflate `Unzip` in Node) writing each entry over 50 MiB
  nowhere (closes C2 properly), `card.json` and `module.risum` kept in memory
  (capped), every other entry hashed and written; answer NDJSON progress then
  `{ card, module?, assets: { [entryName]: key }, excluded }`. Client:
  `CharXImporter.fromServer(file)` producing the same `cardData`, `moduleData`,
  `assets`, `excludedFiles`, so `importCharacterProcess` and `importModule`'s
  `.charx` branch keep their post-parse steps (`convertCharacterToModule`, the
  lowLevelAccess question, `addCharacter`/`addModule`). The in-tab importer
  stays for `Uint8Array` inputs (tests, the preview path). Tests: server route
  over an in-test `CharXWriter` zip; `characterCardsRoundTrip.test.ts` export →
  server import. Closes C1.
- **2e. Streaming entry points** (_small_, `characters-modules.md`). The Realm
  PNG download passes `res.body` (its `.charx` download, launchQueue, and
  `#import=` already hand the `Blob`/`File` to the server routes since 2c and
  2d; the `.png` card and the presets of `importFile` and the shares still read
  into bytes); the PNG import drops the `tee()` prereader (progress shows a
  running count, or the count comes from a first pass over `file.slice` only
  when the input is a `File`). Closes C3 and P1's buffering half.

## Phase 3: Exports and the remaining writers

- **3a. Export reads in batches** (_hard_, `characters-modules.md`). In
  `exportCharacterCard` and `exportModuleLegacy`, collect the asset keys per
  kind, fetch them with `readAssets` in batches of 200 (one in flight, next
  batch prefetched), and write each result to the `LocalWriter` or PNG chunk
  writer as it arrives; a `null` record becomes an empty asset with a warning
  instead of a throw; any failure aborts the `LocalWriter` (`abort()`) so no
  truncated file is kept. `exportModuleLegacy` writes through a `LocalWriter`
  stream instead of the `AppendableBuffer` + `downloadFile` pair (the header's
  `mainLen` is known before the assets; each asset record is `[1][len][bytes]`
  so no backpatching is needed). Closes E1 and E3.
- **3b. Module export call site and JSON export cap** (_small_,
  `settings-i18n.md`, `characters-modules.md`). `ModuleSettings.svelte` awaits
  the export inside try/catch and clears the alert; the JSON card export
  refuses (with a message pointing to CharX) when the assets' total exceeds
  64 MiB instead of building a card that cannot be stringified. Closes E2, E4.
- **3c. Batched writes for the remaining importers** (_small_,
  `characters-modules.md`, `media-aux.md`). PNG chunk assets, embedded base64
  assets (P2; hub resources still fetched one by one but written in batches),
  `selectMultipleFile` callers (F1: return `File`s and read each one only when
  its queue slot is free, then `writeAssets` per 64 MiB), and `registerOnnxModel`
  (F2: stream the zip with fflate `Unzip`, skip members over 100 MiB with a
  message, batch the writes). Closes P1's request half, P2, F1, F2.

## Phase 4: Lists

- **4a. Paged emotion list** (_small_, `characters-modules.md`). Page
  `CharConfig.svelte`'s emotion table like the additional-asset list
  (`ASSET_LIST_PAGE`, Load More) and render rows through `LazyFileSrc` so only
  visible rows load; keep the rename/delete bindings by source index as the
  asset list does. Extend `ModuleMenu.assets.test.ts`'s pattern with an
  emotion-tab test. Closes U1.
- **4b. Lazy icons in long lists** (_small_, `ui-theming.md`). `GridCatalog`,
  the sidebar character list, and the persona list load icons through
  `LazyFileSrc` (or an `IntersectionObserver` wrapper of `getCharImage`).
  Closes U2.

## Order and parallelism

1a → (1b, 1c, 2a in parallel) → 2b → 2c → (2d, 2e, 3a) → (3b, 3c, 4a, 4b).
1a, 2a, and 1c are independent first commits. 2b and 2d share the spool and
NDJSON helpers (extract them from `backups.ts` into `server/src/http/spool.ts`
in 2b). 3a depends on 1b; 3c on 1a and 1b; 4a and 4b on nothing.

Workflow per slice: `opus-lite` for _small_, `opus-workflow` or
`delegate-implementation` for _hard_. Each slice ends with `pnpm check`,
`pnpm --silent test:agent`, the guide's focused tests, and for 2c and 3a a
browser measurement against the sample file (peak heap, request count, wall
time) recorded in the commit message.

## Guide updates

- `self-host-server.md`: the routes table (batch assets, import module/charx,
  the storage limiter bucket), `spool.ts`.
- `characters-modules.md`: the `.risum` codec split (local header read, server
  import), `CharXImporter.fromServer`, export batching, the emotion list paging.
- `global-api.md` / `persistence.md`: `assetClient` retry and batch calls,
  `assetQueue.ts`.
- `STRUCTURE.md` D5: the `.risum` reader on the server is a second reader of
  a cross-user format; keep it byte-compatible with `exportModuleLegacy`.
