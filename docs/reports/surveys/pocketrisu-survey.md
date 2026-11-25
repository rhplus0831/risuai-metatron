# PocketRisu survey: what the fork adds or changes compared with upstream RisuAI

Surveyed: `/home/codex/PocketRisu`, at `f71e1ccc` (2026-10-19, "Merge branch 'develop' for v1.15.0"). Origin is `https://github.com/PocketRisu/PocketRisu.git` and the package version is 1.15.0. The repository was only read, never modified. Every `path:line` pointer was checked against this tree. Commit hashes are PocketRisu commits.

**How fork-only work was identified.** The fork starts at `9055a440` (2026-03-17, "chore: rename project to risuai-nodeonly"). It was renamed from "Risuai-NodeOnly" to PocketRisu around v1.6.0. Upstream RisuAI was merged in periodically as `merge: upstream sync vYYYY.M.NNN` commits (`7dddd460`, `97c2e838`, `dac94b5b`, `b315ca84`, `fe53bee0`, `d26a2393`, `4ba58f79`, `626899d6`).

- **Fork commits:** filtered by fork authors (mrbart3885, about 1,210 commits, plus contributors Nodridan, hanmiyoo10-alt, Laily6026, rakey0, tasoo-oos). That gives about 1,110 non-merge commits: 339 `feat`, 32 `perf`, 454 `fix`, 80 `refactor`.
- **Upstream ports inside the fork:** these carry `Cherry-picked-from:` / `Original-Author:` trailers, or "(upstream: …)" in the title. They are marked as upstream ports below where it matters.
- **Releases:** tags run from v0.1.0 (2026-03-21) to v1.15.0 (2026-10-19).

---

## 1. Overview

PocketRisu is RisuAI reduced to a **single Node.js self-host target**.

- **What was removed.** Tauri, Capacitor and the hosted-web code paths are gone (`f90a137a`, `36bf7356`). localStorage and localforage were replaced by the Node storage API. RisuAI account sync and remote saving are disabled (`82999869`). Group chats, Loadout, Easy Panel and LoreBook+ were also removed.
- **Storage.** Upstream's Node server kept one hex-named file per key in `save/`. PocketRisu keeps **all data in one SQLite file** (`save/risuai.db`, a single `kv` table driven by better-sqlite3).
  - Large values (the `database.bin` blob and archived characters) are stored with **content-defined chunking and deduplication**, so DB snapshots are almost free.
  - Inlays are moved out to plain files under `save/inlays/`.
  - Separate SQLite files hold system logs (`logs.db`), request and usage logs (`request-logs.db`) and model jobs (`model-jobs.db`).
- **The server is active, not a dumb blob store.**
  - **It holds the authoritative database in memory** (`dbCache`). It accepts **JSON-Patch saves** checked by a compositional hash and an ETag, and persists to disk on a 5 s debounce.
  - **It strips the database for the browser.** Chats become stubs and are loaded lazily, with message-level delta sync. Big asset lists become lazy "manifests". Plugin storage becomes per-key KV. Unused characters become server-side archive rows.
  - **It re-inflates everything** into the upstream-compatible legacy shape on disk and in `.bin` exports. Backups therefore still load in upstream RisuAI, and upstream backups load here. A compat test suite in `test/compat/` exercises this against a real spawned server.
- **Other server responsibilities:**
  - a **single-writer session lock** across tabs and devices;
  - **durable model-request jobs**: the server makes the provider call, journals the raw bytes, and the client re-attaches or recovers after a tab death;
  - request and token-usage logs;
  - server-side `.bin` backups, snapshots and restore;
  - orphan sweeps and SQLite maintenance;
  - a Cloudflare quick tunnel for remote access;
  - self-update for the portable builds.
- **Client changes:**
  - a bits-ui/shadcn-style component layer (`Sh*`);
  - a declarative row-layout settings system with search;
  - a storage dashboard;
  - a large **ModelPreset** system: a profile registry plus three wire adapters, replacing the legacy per-provider model settings for new setups;
  - per-chat binding of model, prompt preset, persona, memory preset and toggles;
  - a redesigned composer with per-chat drafts;
  - persistent swipes;
  - a character manager with folders, hiding and archive-based trash;
  - many mobile and remote-latency performance passes.
- **Project policy** (`CONTRIBUTING.md`):
  - Node only.
  - Existing save folders and backups must stay readable, both ways with upstream.
  - Keep the upstream diff small.
  - Fork-only database fields are prefixed `nodeOnly*`.

---

## 2. Feature inventory

Size key: S = small (under about 200 lines or one module), M = medium, L = large (several modules or more than 1,000 lines).

### 2.1 Server and storage

#### SQLite KV store replacing `save/` hex files (L)

- **What it does for the user.** Everything (DB blob, assets, plugin storage, snapshots, caches, config) lives in `save/risuai.db`. Old hex-file `save/` folders are migrated automatically on first boot; the originals are kept until the user removes them from the migration page.
- **Mechanism.**
  - Schema: `kv(key TEXT PRIMARY KEY, value BLOB, updated_at INTEGER)`.
  - Pragmas: WAL, `synchronous=NORMAL`, 64 MB cache, 256 MB mmap, `busy_timeout` 5 s, `journal_size_limit` 256 MB.
  - `SQLITE_TMPDIR` is set to `save/` so VACUUM does not fill a RAM-backed `/tmp` (Docker, Termux).
  - API: `kvGet/kvSet/kvDel/kvList/kvDelPrefix/kvListWithSizes/kvCopyValue`.
  - Key namespaces: `database/database.bin`, `database/dbbackup-<ts>.bin`, `assets/`, `remotes/`, `inlay*/`, `coldstorage/`, `archive/`, `archive-meta/`, `plugin-storage/`, `drafts/`, `cache/*`, `config/*`.
  - HTTP surface (inherited names): `GET /api/read`, `POST /api/write`, `GET /api/list` (`key-prefix` header), `GET /api/remove`. Keys are hex-encoded in the `file-path` header.
  - Pointers: `server/node/db.cjs:36` (schema), `server/node/db.cjs:53` (`migrateFromSaveDir`), `server/node/db.cjs:138` (`kvSet` routes `database.bin` and `archive/*` to the chunk store).
- **Design decisions.**
  - b3bc0644 originally added per-entity tables (characters, chats, presets). 4934971a dropped them in favour of one blob plus patches; the tables remain orphaned.
  - Prefix scans use an index range instead of `LIKE`, because `LIKE` is case-insensitive and never used the BINARY primary-key index. This made large saves on slow disks go from tens of seconds to near-instant (65a90d95; `server/node/db.cjs:176` `prefixRange`).
  - `/api/remove` refuses `assets/` and `remotes/` keys (409), so stale client bundles cannot delete shared assets (459873b2).

#### Content-defined chunk store with dedup, snapshot sharing and mark-sweep GC (M)

- **What it does for the user.**
  - A huge `database.bin` no longer hits SQLite's single-BLOB limit.
  - A small edit rewrites only the changed chunks.
  - Snapshots of the DB cost only their marginal chunks.
  - "Optimize" reclaims unreferenced chunks.
- **Mechanism.**
  - Chunking: FastCDC-style gear rolling hash (min 4 KB, max 64 KB, about 16 KB average), each chunk keyed by SHA-256.
  - Tables: `chunks(hash PK, data)` and `manifest_chunks(manifest_key, seq, hash)`. A chunked kv row holds the sentinel `\0RISUCHUNKED\0`.
  - Values up to 16 MB stay as raw rows (`POCKETRISU_CHUNK_THRESHOLD`).
  - `snapshotValue` copies only manifest rows. `snapshotCost` measures a snapshot's marginal bytes.
  - `gc()` deletes stale manifests, then `DELETE FROM chunks WHERE hash NOT IN (SELECT hash FROM manifest_chunks)`.
  - Pointers: `server/node/chunkStore.cjs:23` (`cdcSplit`), `server/node/chunkStore.cjs:120` (`putValue` transaction), `server/node/chunkStore.cjs:188` (`gc`).
- **Design decisions.**
  - Chunking is limited to the DB blob and archive rows; assets are already one row each.
  - GC is stateless and recomputed every run, so it cannot over-delete. It never runs on the hot save path; it runs inside `/api/db/optimize` before VACUUM (319ed319).
  - Commits: 32a7f50b, f3f781e3, 4bc5ed48, 770c64ce, 201d752f. Follow-up fixes: 365af41c, 77d273ac, 9fb5b2b4.

#### Patch-sync save protocol (`/api/patch`, `/api/write`, `/api/read`) (L)

- **What it does for the user.** A normal save sends a small JSON Patch of the stripped database instead of re-uploading `database.bin`. The server applies it in memory and persists on a 5 s debounce. A full upload remains the fallback.
- **Mechanism.**
  - **Server state:**
    - `dbCache` holds the stripped client view.
    - `fullChatStore` maps `chaId → chatId → full chat`.
    - `dbEtag` is the MD5 of the encoded view.
    - All mutating storage routes run through one promise chain, `queueStorageOperation` (`server/node/server.cjs:121`).
  - **`/api/patch` steps:**
    1. Check auth and the session lock.
    2. Cold-load the cache inside the queue if needed.
    3. Reject chat-internal ops (`CHAT_GUARD_REJECTED`).
    4. Redirect old-client `/pluginCustomStorage/<k>` ops to KV.
    5. Compare `expectedHash` with the compositional hash, else 409 `HASH_MISMATCH`.
    6. Apply the patch to a selectively cloned root.
    7. Run the asset-manifest guard and the archive guard.
    8. Swap in the new root, schedule persist, recompute the ETag.
    9. Return `{etag, timings, persistWarning?}`.
  - **`/api/write`:** a full write checked against `x-if-match`.
  - **`/api/read`:** for the DB key, flushes pending writes, then serves the stripped view with `x-db-etag` and honours `If-None-Match` → 304.
  - Pointers: `server/node/server.cjs:4567` (`/api/patch`), `server/node/server.cjs:4322` (`/api/write`), `server/node/server.cjs:1026` (`persistDbCacheWithChats`).
  - **Client side** (`persistTrackedChanges`, `src/ts/globalApi.svelte.ts:1203`):
    - Svelte `$effect`s `deepTouch` root keys and the active character and chat, filling a change tracker.
    - Changed chats are uploaded through chat-content.
    - `RisuSavePatcher` (`src/ts/storage/risuSave.ts:911`) diffs per root key, per character and per module, and short-circuits with string compares.
    - On a 409 with a foreign ETag it **rebases**: download the server DB, merge the tracked local changes (`src/ts/storage/rebaseMerge.ts:25`), re-seed the patcher, retry.
    - Otherwise it falls back to a full write.
- **Design decisions.**
  - Cached branches are never mutated in place (invariant comment near `server.cjs:66`). This lets two caches key on object identity: the per-key hash cache (`server/node/patch-hash-cache.cjs:37`, 87561137) and the selective clone that copies only the branches a patch touches (`server/node/patch-selective-clone.cjs:36`, f60e0618). Both were contributed by hanmiyoo10-alt.
  - The server takes `structuredClone` snapshots rather than a JSON round-trip, which hit V8's string ceiling (e2c6d157).
  - The client never adopts the server ETag on a 409. Adopting it would let the full-write fallback overwrite another device's change (7dc9557a, c51aceb0).
  - A 409 carries per-root-key and per-character hashes. The client logs which keys diverged (`databaseHashDiagnostics`, `server/node/server.cjs:101`; 08d89655).

#### Lazy chat loading with server-side strip and merge, plus message-level delta sync (L)

- **What it does for the user.**
  - The boot download contains only chat stubs. A chat's messages are fetched when it is opened and saved separately.
  - Reopening or saving a long chat transfers only new messages. Measured on a 2,000-message chat: open time went from about 14 s to about 0.9 s, and saves from about 2 MB to 0.1–3 KB (f91987b1).
- **Mechanism.**
  - **Stubs and merge.** `chatToStub` keeps `id, name, _stub, lastDate, folderId, modules`. The merge uses `in` semantics so a field cleared on the client stays cleared.
  - **Load and save.** `GET` and `POST /api/chat-content/:chaId/:chatIndex` carry an `x-chat-id` header and a msgpack body (a764d775).
  - **Delta sync:**
    - Each message has a 64-bit fingerprint over a canonical rendering.
    - The client keeps IndexedDB copies of long chats (40+ messages, 24 most recent chats).
    - GET sends `x-chat-base-count`/`x-chat-base-fp`, and the server replies with `message[count:]`.
    - POST splices only after verifying the stored prefix, otherwise 409 `CHAT_DELTA_BASE_MISMATCH` and a full resend.
    - Upload bodies of 8 KB or more are gzipped with `CompressionStream`.
  - Pointers: `server/node/server.cjs:6057` (GET), `server/node/server.cjs:6102` (POST), `server/node/chatFingerprint.cjs:73` (`prefixFingerprint`), `src/ts/storage/chatDeltaSync.ts:44`.
- **Design decisions.**
  - Patches may touch only stub metadata or whole chat slots (`findChatInternalFieldOps`, `server/node/server.cjs:948`, with a client twin).
  - A disk-side guard refuses to persist a chat that lost `_stub` without gaining a body.
  - Client and server fingerprints must match byte for byte, and a test pins this. A mismatch only costs a full transfer.
  - Data-loss fixes along the way: 22df0cf6, f2fadc82, a7958139, 8e7284b0 (hybrid stub self-heal).

#### Server-side duplicate-ID repair (S)

- **What it does for the user.** If two characters or two chats share an id, the server renames the later ones once, on the fully decoded DB, and persists the result.
- **Mechanism.** `dedupeCharacterAndChatIds` (`server/node/server.cjs:460`), plus a test at `server/node/duplicateIds.test.ts`.
- **Design decisions.** The browser used to rename duplicates locally, which left the body under the old id on the server; the next save then dropped it (4f43a9e0, 001b151a).

#### Lazy asset manifests (L; contributed by Laily6026)

- **What it does for the user.** Characters and modules with thousands of emotion or additional assets no longer put whole name→path tables into the reactive DB. They are fetched lazily and cached, which speeds up boot and lowers memory use.
- **Mechanism.**
  - **Storage.** Manifests are ordered `[name, path, ext?]` tuples, deflate-compressed, in tables `asset_manifests`, `asset_manifest_live` and `asset_manifest_migration`. Ids are content-addressed: `sha256(kind\0owner\0contentHash)`.
  - **Strip and hydrate.** `stripAssetManifests` and `hydrateAssetManifests` swap `module.assets`, `character.additionalAssets` and `persona.embeddedModule.assets` for descriptors in the client view, and restore the legacy shape on disk and in exports.
  - **Routes:**
    - `GET /api/asset-manifests/:id` (paged, `immutable`)
    - `POST /api/asset-manifests/resolve` (fuzzy name match)
    - `PATCH /api/asset-manifests/owner/:kind/:ownerId` (append/insert/remove/rename/replace against `expectedManifestId`)
  - **Client:** an LRU with 64 entries / 32 MB, a prefetch on chat entry, and a local copy of the server resolver (`assetNameLocalResolver.ts`), so rendering needs no network once a manifest is cached (f3911493, which fixed blank messages over Tailscale).
  - Pointers: `server/node/assetManifestStore.cjs:118`, `server/node/assetManifestMigration.cjs:38` (strip) and `:147` (hydrate), `server/node/server.cjs:4923-4982` (routes).
- **Design decisions.**
  - Content addressing makes rows immutable and lets responses be cached as `immutable`.
  - A long fix series makes plugins see hydrated arrays, and lets only a list the plugin actually received replace a manifest (4a70de8d, f79c8989, b69fafa9, 856807a2).

#### Inlays as files, server thumbnails, WebP by default, direct asset URLs (L)

- **What it does for the user.**
  - Chat images, audio and video ("inlays") are stored as `save/inlays/<id>.<ext>` with a `.meta.json` sidecar instead of base64 KV rows.
  - Galleries get 320 px WebP thumbnails built by the server.
  - New images are re-encoded to WebP (q 0.85, at most 1 MP) unless "lossless" is set.
  - A bulk-compress button converts existing inlays.
  - `<img src="/api/asset/<hex>">` URLs are cached by the browser (`immutable`, ETag from file mtime).
  - In "image-first" mode, every unknown inlay is rendered as `<img>` immediately, with an `onerror` fallback for media.
- **Mechanism.**
  - Migration: `server/node/server.cjs:1893`. Writer: `server/node/server.cjs:1772` (`writeInlayFile`).
  - Thumbnails: wasm-vips `thumbnailBuffer`, cached as `inlays/.thumbs/<id>.<mtimeMs>-<size>.webp` (`server/node/server.cjs:3853`). Builds are serialized through one queue (72c3dbf4).
  - Bulk compress: SSE `POST /api/inlays/compress` (`server/node/server.cjs:8318`).
  - Image-first: `src/ts/parser/parser.svelte.ts:865`.
- **Design decisions.**
  - Thumbnail file names include the source mtime and size, so a cache hit can never be stale.
  - sharp was replaced by wasm-vips for Termux (fba9a53a).
  - Session cookies authenticate `<img>` loads (d86f50d4).
  - The inlay N+1 info requests became a batch call (7f9ee47b).

#### Character deactivation into a server-side archive, and archive-based trash (L)

- **What it does for the user.**
  - "Deactivate" moves a character's card, lorebook, scripts and every chat out of `database.bin` into its own server row. A dimmed stub stays in the lists; one click reactivates it.
  - Trash means "deactivate plus a trash marker". It is never auto-purged.
  - The character manager can deactivate or trash many characters at once, with progress.
  - The dashboard lists unreferenced archive rows and can purge them.
  - User guide: `docs/en/deactivate-characters.md`.
- **Mechanism.**
  - **Stub** in the DB: `db.nodeOnlyArchivedCharacters` (`src/ts/storage/database.svelte.ts:1743`).
  - **Rows:**
    - `archive/<chaId>/<archivedAt>`: the full character with chats inline, legacy-encoded and chunked.
    - `archive-meta/...`: sizes, `assetRefs`, `inlayRefs`.
  - **Routes:**
    - `POST /api/characters/:chaId/archive` (`server/node/server.cjs:6993`). The server writes the row, reads it back and compares hashes.
    - `POST /api/characters/archive-batch` (at most 100)
    - `POST /api/characters/:chaId/activate`
    - `GET /api/characters/archived/inline`
    - `POST /api/db/archive/purge-orphans` (10-minute grace period)
  - **Client:** moving a character between `characters` and the stub list is an ordinary `/api/patch` (`src/ts/characterArchive.ts:73` archive, `:265` activate). The server rejects a patch that leaves a chaId in both lists.
- **Design decisions** (96d58161, 35cc6fd3):
  - Archive rows are immutable, one per deactivation, and never auto-deleted. Any DB snapshot therefore restores exactly the chats it was taken with.
  - Exports inline archived characters as normal characters (`trashedAt` becomes `trashTime`), so upstream files them in its own trash.
  - Plugins see deactivated characters as deleted: the stub key is not in `allowedDbKeys`.
  - Activation races with pending saves were fixed in 64659d41, e697e1b7 and 75955ec9.

#### Plugin storage moved out of `database.bin` into per-key server KV (L)

See 2.6.

#### Per-chat composer drafts stored server-side (M)

See 2.3. Each draft is its own KV row, `drafts/<chaId>/<chatId>`.

### 2.2 Data safety and backup

#### Server-side DB snapshots with retention, sizing and in-place restore (M)

- **What it does for the user.**
  - The DB is snapshotted automatically, at most every 5 minutes after a successful persist, and before one-way migrations.
  - The user can set count and byte limits (defaults 20 and 500 MB), see each snapshot's logical size and dedup savings, delete one, or restore one in place.
- **Mechanism.**
  - Snapshot keys are `database/dbbackup-<ts>.bin`, made with `kvCopyValue`, which copies the manifest only. The plugin-storage snapshot is taken in the same transaction.
  - `trimSnapshotsToLimits` keeps the newest snapshot and never trims the one being restored.
  - Routes: `/api/db/snapshots`, `/api/db/snapshots/limits`, `/api/db/snapshots/restore`.
  - Pointers: `server/node/server.cjs:310` (`createBackupAndRotate`), `server/node/server.cjs:218` (`trimSnapshotsToLimits`), `server/node/server.cjs:8161` (restore).
- **Design decisions.**
  - Restore moved server-side because client `setDatabase` plus reload raced the debounced save (c7fe5fc7, 0b6cb5cb).
  - Trimming uses marginal size, while the UI shows logical size (50509bbc); a marginal size near 0 looked to users like a lost backup.
  - A failed restore no longer wipes plugin storage (adf1ab95).

#### Server-side `.bin` backups (save, list, restore, download, change directory) (M)

- **What it does for the user.** Full backups are written to a folder on the server. Downloads go through the browser's download manager, streamed to disk rather than held in tab memory.
- **Mechanism.**
  - `POST /api/backup/server/save` (`server/node/server.cjs:5571`) checks free space against the estimate plus 5%, streams NDJSON progress, and writes `.tmp` then renames.
  - The download uses a cookie (`checkBackupDownloadAuth`, `server/node/server.cjs:2006`). The client refreshes the session cookie, then clicks a hidden `<a download>` (`src/ts/storage/nodeStorage.ts:914` `startCookieDownload`).
  - A custom backup directory is remembered in a plaintext marker file, `save/__backup_path`, so the updater (which cannot read SQLite) preserves it.
- **Design decisions.**
  - Safari buffered whole files in tab memory, and non-secure origins routed downloads through a third-party page (8bfa7c9d).
  - Backup downloads deliberately omit `x-session-id`, so they never move the writer lock.

#### Backup export variants: full, upstream-targeted, settings-only (M)

- **What it does for the user.**
  - **Full:** streams every asset, with plugin storage and archived characters re-inlined.
  - **Upstream:** drops the inlay namespaces, whose slash-containing entry names break upstream's importer (5e461a0d).
  - **Settings-only:** keeps referenced assets and drops characters, chats and inlays, with a size estimate shown first (b6156083).
- **Mechanism.** `GET /api/backup/export?target=upstream|mode=settings` (`server/node/server.cjs:5282`), `buildSettingsOnlyPlan` (`:5178`), `buildFullExportDbValue` (`:5232`). Writes respect backpressure and abort on client disconnect.
- **Design decisions.**
  - The estimate and the export share one plan, so their numbers cannot drift.
  - A module's cost is computed as "all minus without-modules", so assets shared with others are never billed to the module.

#### Backup import hardening (M)

- **What it does for the user.**
  - Before upload the server checks a size cap and requires free disk of at least twice the backup size.
  - The import streams NDJSON progress with heartbeats, so reverse proxies do not 502.
  - Encrypted upstream account backups and undecodable databases are rejected without touching existing data.
  - A forced snapshot is taken before the import.
  - Newer upstream cold-storage formats are folded back in.
- **Mechanism.** `POST /api/backup/import/prepare` (`server/node/server.cjs:5441`), then the streaming `POST /api/backup/import`:
  - Entries are committed in batches of 5,000.
  - `database.risudat` is held back until the stream ends and checked by `assertBackupDatabaseDecodable` (`server/node/server.cjs:2821`).
  - `plugin-storage/` is cleared only in the final transaction.
- **Design decisions.**
  - Up to v1.11.2, a corrupt or encrypted DB was committed first, which made the server unbootable (4594674b).
  - Other commits: f3426126 (NDJSON instead of a long silent request), e7e5564b (quadratic `Buffer.concat`), 0f8018cc and c942a040 (upstream `_coldplugin` and flat `coldstorage_<uuid>.json` entries, applied only as a migration).

#### Boot backup reminder, disk warnings, transfer-size warning (S)

- **What it does for the user.**
  - An optional boot prompt offers to back up first. Its button is disabled when the estimated backup would not fit on disk.
  - Disk use warns at 90% and 95%, tracked separately for the backup disk.
  - A main-menu banner appears when the full-write payload reaches 80 MB, because Cloudflare Quick Tunnel caps request bodies at 100 MB. It clears below 70 MB and can be turned off.
- **Mechanism.** `/api/backup/boot-reminder` (`server/node/server.cjs:8246`). `src/ts/transferSize.ts:36` (`nextTransferSizeState`, with hysteresis). Boot estimates never override a size measured from an actual save.

#### Orphan sweeps (auto and manual) and save-folder migration (M)

- **What it does for the user.**
  - At boot, remote caches of deleted characters are removed after 7 days.
  - Unreferenced `assets/*` older than 7 days are removed only if the user opted in (`nodeOnlyAutoCleanAssets`).
  - The dashboard can purge orphans manually.
  - Old NodeOnly or upstream `save/` folders can be imported by server path or as a zip upload, atomically. The hex files left behind can then be cleaned up.
- **Mechanism.**
  - `computeAssetSweep` (`server/node/server.cjs:7401`) builds the referenced set from the DB walk, live manifests, archive `assetRefs` and plugin-storage refs.
  - Routes: `/api/db/assets/auto-sweep`, `/api/db/assets/purge-orphans`, `/api/migrate/save-folder/*` (`server/node/server.cjs:6226` `clearExistingData`, `:6375` upload).
- **Design decisions.**
  - The sweep moved server-side because a stale client view deleted assets another device had just attached (459873b2).
  - It refuses to run when the reference walk fails or comes back empty.
  - GPT-SoVITS reference audio and plugin-stored assets are protected (3b8b6401).

#### Persist failures surfaced as toasts, and retry (S)

- **What it does for the user.** A failed debounced disk write (for example a BLOB that is too large) is reported on the next patch response as `persistWarning`, and the client shows one toast. The server retries after 30 s.
- **Mechanism.** `recordPersistFailure` (`server/node/server.cjs:140`), `retryDatabasePersistLater` (`:370`), `showPersistWarningOnce` (`src/ts/globalApi.svelte.ts:434`).
- **Design decisions.** Before fb3316af and c3fa8e84, failures were dropped until the next edit, which lost data if the server restarted.

#### Storage request retries and real error messages (S)

- **What it does for the user.**
  - `authFetch` retries 502/503/504 responses and network `TypeError`s up to 3 times with jitter, regenerating auth headers on each attempt.
  - Failures surface as a `StorageRequestError` with the operation and HTTP status.
  - A 413 on a write maps to an actionable "size limit" message.
- **Mechanism.** `src/ts/storage/nodeStorage.ts` (e57c0435).

#### `beforeunload` guard, SQLite WAL management (S)

- **What it does for the user.**
  - A `beforeunload` guard was restored (eac0954a).
  - The WAL file stays small: `journal_size_limit` plus a TRUNCATE checkpoint every 5 minutes and on SIGTERM.
  - The dashboard offers WAL truncate and VACUUM. VACUUM requires free space of at least 2.2× the DB size and spills its temp files to disk, not RAM.
- **Mechanism.** `server/node/server.cjs:7985` (optimize), `:8042` (wal-checkpoint), `:9047` (graceful shutdown).
- **Commits.** b4735168, 6f1ef9f2, f437a4c8.

### 2.3 Generation and model jobs

#### Durable server-side model job relay (L)

- **What it does for the user.** For model-preset requests, the server, not the browser, makes the provider call. Locking the phone, closing the tab or losing Wi-Fi no longer kills a generation: the server keeps reading and stores the reply, and the client puts it into the chat when it comes back. This is on by default (`nodeOnlyServerSideRequests ??= true`, b1506ecf).
- **Mechanism.**
  - **The server is a pure recorder.** It relays the provider's raw bytes unchanged and appends the same bytes to a journal file, `save/model-jobs/<id>`. It never parses SSE or JSON.
  - **Metadata** is stored in `save/model-jobs.db`, table `model_jobs`: chat_id, generation_id, adapter_kind, model, model_label, `kind` main|aux, status, upstream_status, bytes, `claimed`, token estimates.
  - **Routes:**
    - `POST /api/model-jobs`: create
    - `GET /api/model-jobs?active=1|unclaimed=1`: list
    - `GET /api/model-jobs/:id/stream`: replay from byte 0, then follow live
    - `POST /api/model-jobs/:id/claim`
    - `DELETE /api/model-jobs/:id`: abort or delete
  - **Limits.** Readers are woken by in-process waiters. Default timeout is 10 minutes, maximum 1 hour. Up to 50 finished jobs are kept, for up to 7 days.
  - Pointers: `server/node/model-jobs.cjs:172` (schema), `:482` (`createJob`), `:593` (`streamJob`). Registered at `server/node/server.cjs:3717`.
- **Design decisions.**
  - **No secrets on disk.** The URL, headers and body live only in memory. `target_origin` drops the query string, because Gemini puts its key there.
  - **Plain bytes only.** `accept-encoding: identity` is forced so the journal can be replayed as-is.
  - **No keepalive probes.** TCP keepalive is disabled because the probes caused ETIMEDOUT during long thinking pauses.
  - **Race-free finish.** A job is marked done only after its file is flushed, so "EOF + done" can be trusted.
  - **Unrecovered replies are kept longest.** Unclaimed main jobs are evicted last and never expire by age.
  - **Restart means failed.** A server restart marks running jobs failed, because the credential existed only in memory.
  - Commits: 924b51ed, 00ad8601, e6d510e7, 393c8700, 29431409, 9c9e5770.

#### Client job transport: `jobFetch` (M)

- **What it does for the user.** A dropped stream resumes in place without an error. A send retried after a gateway timeout re-attaches to its own job instead of failing with "chat busy".
- **Mechanism.** `makeJobFetch()` returns a drop-in replacement for `fetch`, plugged into the adapters' `fetchImpl`, so the parsers still see a normal provider `Response`.
  1. **Create the job.** If creation fails with a network error, 404 or 5xx, fall back to the direct proxied path.
  2. **Handle 409.** A 409 carrying the same `generationId` means "my own job": re-attach. A different generation raises `ModelJobBusyError`.
  3. **Attach** to `/stream` with backoff. Middlebox 408 and ≥502 responses are retried.
  4. **On EOF, ask for the job status.** If it is still running, re-attach, replay and skip the bytes already delivered.
  - Retry limits: at most 5 attempts per cycle and 3 cycles with no progress.
  - Aborting deletes the job, or finds the orphan by `generationId` if the job id was never received.
  - Pointers: `src/ts/process/request/jobFetch.ts:90`, `:127` (409 re-attach), `:266` (`tryReattach`).
- **Design decisions.**
  - **"A closed stream is not a completed response."** `ModelJobConnectionLostError` enforces this.
  - **No direct fallback after a 409.** Falling back there would generate twice (97d0efde).
  - **Aborts reach the provider at once.** Client aborts cancel the upstream request immediately (3b715ae9).

#### Boot and tab-return recovery, partial fill (L)

- **What it does for the user.** Replies that finished while the tab was dead show up in their chats at boot or on return. Generations still running show a "background" toast and are slotted in when done. A message that was only partly saved is completed from the journal.
- **Mechanism.** `initModelJobRecovery()` (`src/ts/process/request/jobRecovery.ts:885`) runs discovery at boot, on `visibilitychange` and on `online`. The pass is single-flight and retries with backoff.
  - **Finished jobs** (`recoverTerminalJob`, `:459`): fetch the journal and decode it with the same pure parsers a live run uses. Then insert a new message, or fill the message whose `generationInfo.generationId` or `message.chatId` matches, but only if the stored text is shorter. Failures become a `risuerror` block. Then save and claim.
  - **Running jobs:** hold a `'background'` entry in the per-chat generation map (`src/ts/process/generationState.ts:73`), which blocks new sends in that chat but does not set the global `doingChat`. Poll every 3 s, backing off to 15 s, up to 65 minutes. The Stop button DELETEs the job.
- **Design decisions.**
  - **Raw text only.** Recovery skips edit-output scripts, triggers, translation, TTS and auto-continue, so no side effects fire in a chat the user is not viewing.
  - **Live sends win.** Recovery skips a chat that a live send owns (2c6cc724).
  - **Order is preserved.** The oldest job is recovered first (342b3a8a).
  - **Metadata survives.** Model, label and token counts are restored (d075af20, 420eba54).
  - **Discovery always runs**, even with the feature switched off.

#### Resumable sends: pending-send tombstones with atomic claim (M)

- **What it does for the user.** If the tab dies before the main request fires (for example during input translation or memory summarization), opening that chat later re-runs the send. This happens exactly once, on one device.
- **Mechanism.**
  - **Server table** `pending_sends(chat_id PK, generation_id, created_at)`, swept after 48 h.
  - **Claim** is `POST /api/pending-sends/:chatId/claim`, a single `DELETE` that reports `changes>0` (`server/node/model-jobs.cjs:404`).
  - **Registration.** `sendChat` registers a tombstone before the pipeline and every exit path clears it. Requests are chained per chat so a clear can never overtake the register (`src/ts/process/request/pendingSends.ts:79`).
  - **Evaluation** (`evaluatePendingSend`, `jobRecovery.ts:687`):
    - Ignore records younger than 3 minutes, so a send still running on another device is not raced.
    - Clear the record if the reply already exists, a job exists, or the last message is not from the user.
    - Otherwise flag the chat.
  - **Resume.** `resumeInterruptedSend` (`src/lib/ChatScreens/DefaultChatScreen.svelte:651`) checks again, claims, then runs `sendChat(-1)` without touching the draft.
  - **Continues.** A continue stamps the previous reply with the new generationId up front, so recovery fills that message instead of duplicating it (38b86850).
- **Design decisions.**
  - **The tombstone holds no pipeline state.** The user message is already saved, partial HypaV3 state is in `hypaV3Data`, and the reply is in the job journal.
  - Commits: a994b904, 706f170d.

#### Stop escalation and per-chat generation state (M)

- **What it does for the user.**
  - Generation state is a per-chat map instead of a single global flag. A send blocked by another chat now says which chat (ab77ae21).
  - If a generation ignores its abort signal (a stalled plugin provider or stream), Stop drops its entry after 8 s and clears its tombstone.
  - A send blocked for more than 3 minutes by another chat's live generation offers to stop that one.
- **Mechanism.**
  - `src/ts/process/generationState.ts` holds a `Map<chatId, {generationId, kind:'live'|'background', abortController}>`. The legacy `doingChat` store is derived from it.
  - `endGeneration` is owner-scoped, so a send released late cannot end a newer one.
  - Commit: 4302bbee.

#### Request log and token-usage statistics (L)

- **What it does for the user.**
  - A **Request log** tab lists every provider request with the body sent, the assembled response, timings, route and tokens, with filters.
  - A **Usage** tab shows summary cards, a per-day stacked chart, and per-model and per-source tables.
  - The per-message "log" view now works after a reload and for generations that ran as server jobs.
- **Mechanism.**
  - **Storage** is `save/request-logs.db`, which is never exported.
  - **`requests` table:**
    - Rotated by bytes: 256 MB total, at least 50 rows kept, 32 MB cap for plugin rows.
    - Each entry is capped at 2 MB, keeping the head and tail of long bodies.
  - **`usage` table:** about 100 B per row and never rotated, so usage outlives the bodies.
  - **Routes** are `/api/request-logs*` (`server/node/request-logs.cjs:552-628`).
  - **Client:** `createRequestLogScope().wrap(fetch)` (`src/ts/requestLog.ts:418`) wraps whichever transport is used (direct, proxy or job). It tees and assembles the streamed body, waits for provider usage, then posts one batch.
  - **Excluded or masked:** inline base64 media is stripped and binary responses are excluded (eb55bfbd). Headers, URL, body and response are masked with `maskSensitive`.
  - **Coverage** includes plugin fetches and Ollama, Horde and Stability calls (2deffd1f). Commits: c97cb83b, 518e30b5, fa4680a6.
- **Trade-offs.** If a tab dies mid-request, that log entry is lost. Job-recovered entries have no request body.

#### ModelPreset system: profile registry, adapters, schema-driven editor (L, the largest client feature)

- **What it does for the user.** Instead of upstream's per-provider model settings, the user builds **model presets** from a catalog of provider/model **profiles**: OpenAI, Anthropic, Google, Vertex, OpenRouter, Vercel AI Gateway, NanoGPT, Ollama Cloud, DeepSeek, and "Compatible (Custom)" endpoints. The catalog updates from GitHub at runtime. The preset editor is generated from each profile's schema, and also offers:
  - a key pool (saved API keys reused across presets);
  - per-preset streaming and "decoupled streaming";
  - a max context budget, with the profile's cap shown and an "ignore cap" option;
  - opt-in tool calling;
  - image input;
  - system/role folding;
  - a reasoning display;
  - an additional-parameters box;
  - a **test-request tab**.
- **Mechanism.**
  - **Registry.**
    - A bundled snapshot is loaded via `import.meta.glob` (`src/ts/preset/registry/loader.ts:40`).
    - The remote sync (`src/ts/preset/registry/remote.ts:158`) reads `index.json` and its `hash`. It downloads `catalog.json` only when the hash changed, checks that `catalog.hash` matches the index, validates all-or-nothing, and swaps atomically.
    - A custom registry URL must be https and never silently falls back to the official one.
    - Custom profiles live under the `custom::` namespace.
  - **Snapshots.** A preset stores a resolved `profileSnapshot`, so registry changes never mutate existing presets. Updates are offered as a diff (`profileUpdate.ts`).
  - **Adapters.** There are three wire formats, `openai-compatible`, `anthropic-messages` and `google-gemini`. A shared builder maps schema fields onto the body, headers, query or auth via `mapsTo` (`src/ts/preset/adapter/buildRequest.ts:15`). Each adapter has `send*`, `stream*`, `preview*` and pure `parse*` functions.
  - **Vertex.** Service-account JSON is exchanged for a token on the server, because the browser cannot sign RS256 over plain HTTP: `POST /api/model-preset/google-service-account/token` (`server/node/server.cjs:3976`, 10e8645b).
  - **Key pool:** `src/ts/preset/apiKeyPool.ts:17`.
  - **Context budget:** `src/ts/process/request/contextBudget.ts:24`.
  - **Editor:** `src/lib/UI/GUI/SchemaFormRenderer.svelte` and `SchemaFieldRenderer.svelte`.
- **Design decisions.**
  - **Adapters never read the DB.** Everything is passed in, which is what makes byte-identical preview and job recovery possible.
  - **Off means byte-identical.** Every optional feature defaults off, and code comments repeat that off must produce byte-identical requests.
  - **Tool steps have their own budget**, separate from network retries, so tools that have already run are never re-run.
  - **Anthropic prompt-cache breakpoints** are sent on the preset path (7370875c).
  - **Gaps.** The migration from legacy settings was shelved (tag `shelf/model-preset-migration`). `tokenizerOverride` is stored and editable but nothing reads it.
  - Commits: f80aaaf6, 2ee61b3e, fb87a537, 7b58ecd1, baa6eeca, a5e8db48, 3caee21b, ecbc8395, 8e24ca96, 48f20097.

#### Model binding slots, per chat and per module (L)

- **What it does for the user.**
  - Each chat has a main slot, a sub slot, and per-task aux slots (memory, emotion, translate, other).
  - A slot holds a model preset, "the global legacy model", or a pinned legacy model.
  - The aux split is a sidebar switch.
  - Modules (triggers and Lua `LLM()`) can be bound to a specific preset.
- **Mechanism.**
  - **Data.** `ModelBindingSet` with `@legacy` / `@legacy:<model>` values (`src/ts/preset/types.ts:385`). Stored in `chat.modelBinding` and `db.defaultModelBinding`, plus `db.moduleModelBindings`.
  - **Resolution:** `resolveChatModelBinding` (`src/ts/process/request/modelPresetBinding.ts:49`), called before the legacy `seperateModels` block.
  - **UI:** `src/lib/SideBars/ModelBind.svelte`.
- **Design decisions.**
  - **No silent fallback for main and sub.** An unset main or sub slot blocks the request rather than silently using another, possibly expensive, model.
  - **Aux falls back to sub.** An unset aux slot uses the sub slot.
  - **New chats snapshot the default** instead of reading it live, so changing the default never flips existing chats.
  - **Bindings to deleted presets are kept**, so they reconnect if the preset is re-imported.
  - Commits: 5216c14c, a35658e9, 47f9a412, 1da764dc, 80680a6d, b0df2a9d.

#### Gemini / Vertex context caching (L)

- **What it does for the user.** For presets with the `cache` capability, the stable start of the prompt is stored in Gemini's server-side `cachedContents`. A "cache hit N" badge appears in the status toast.
- **Mechanism.**
  - Pure decision functions: `evaluateGeminiCacheBeforeRequest` (`src/ts/preset/cache/geminiContextCache.ts:284`) and `decideGeminiCacheAfterResponse`.
  - The cache key is chat + task + presetId. Defaults are a 600 s TTL and a 4,096-token minimum. Caching is disabled for the session after 3 prefix mismatches.
  - Wiring is in `src/ts/preset/cache/geminiCacheWiring.ts`. Cache housekeeping calls always use the direct path, never jobs.
- **Design decisions.**
  - Cache state is kept in memory plus localStorage only, never in the DB or backups.
  - Only real prefix mismatches count toward disabling. When an applied cache is evicted, the request falls back to an uncached one (fb157cea).

#### Floating request-status toast (M)

- **What it does for the user.** Each request gets a sonner toast showing its phase (connecting, thinking, responding, stalled, done, failed, aborted), elapsed time, output and thinking tokens, tokens per second, and a chip saying which task it is (main, translate, memory, emotion, sub).
- **Mechanism.** `src/ts/status/requestStatus.ts:69` (store, 3 s stall threshold) and `src/lib/UI/GUI/RequestStatusToast.svelte`. Token counts are corrected from provider usage at the end (909f920c).

#### Streaming display throttle (M)

- **What it does for the user.**
  - "Balanced" (the fork default) repaints streaming text at most every 125 ms, on an animation frame.
  - "Strong" also defers edit-output scripts until the stream ends.
  - The preset path separately throttles adapter flushes to about 20 fps.
- **Mechanism.** `src/ts/process/index.svelte.ts:1654`. The mode is stamped on the chat so a mid-stream settings change is safe.
- **Origin.** Ported from upstream #1422 (49dd0b7e, default `off` there); f5a68ea9 made balanced the default; ab518fca.

#### Smaller generation items

- **Claude Message Batches API** (`db.claudeBatching`). Polling runs inside a `ReadableStream`, cancel goes to `/cancel`, and thinking blocks are aggregated (`src/ts/process/request/anthropic.ts:608`, c555455a). Legacy path only. (S)
- **NanoGPT provider** with balance and subscription lookups (`src/ts/model/nanogpt.ts`). Upstream #1343 port. (M)
- **Translator prompt presets** in `.risutl` format (`src/ts/translator/presets.ts`). Upstream #1370 port. (S)
- **`forceStreaming`** for trigger v2 `RunLLM` and Lua `LLM()`/`axLLM()` (`src/ts/process/request/request.ts:81`), collected with `collectStreamingText`. Upstream port. (S)
- **Notification sounds:** 14 bundled sounds plus uploads, per-item volume, on a dedicated settings page. Uploaded sounds are protected from GC and remapped on import (`src/ts/notificationSound.ts:66`, 6554b9b8, 01b87bb6). (S)
- **Termux native "response complete" notification.** `POST /api/termux-notify` is loopback-only, rejects requests with `X-Forwarded-For`, and spawns `termux-notification` with one reused id (`server/node/server.cjs:1219`, 3f5b8f73, 09373699). (S)
- **OpenRouter requests are identified as PocketRisu** (1b5e4bf7). (S)

### 2.4 Prompt presets, toggles and bindings

#### Per-chat prompt preset binding and parameter override (M)

- **What it does for the user.** A chat can be bound to a prompt preset. Entering the chat switches the global preset. A chat can also opt to apply the prompt preset's sampling parameters (temperature, top_p, …) on top of its model preset.
- **Mechanism.**
  - `chat.bindedBotPreset` holds a **stable string id**. Before this, a numeric index was used (3966c178, `botPreset.id`).
  - An effect in `src/lib/SideBars/PromptBind.svelte:33` does the switch.
  - `chat.usePromptPresetParams` feeds `applyPromptPresetParams` (`src/ts/process/request/modelPresetBinding.ts:305`), main mode only.
- **Design decisions.** The numeric `botPresetsId` is still the active pointer, for `.bin` compatibility. A missing selected preset is saved as a "recovered" preset (1ae2094a).

#### Toggle pins, toggle presets, default toggles, per-character toggles (L)

- **What it does for the user.**
  - **Pins:** each chat remembers its prompt-toggle values.
  - **Toggle presets:** named, with JSON export and import, a dirty highlight and a diff count on save.
  - **Defaults:** "save as default for new chats".
  - **Per character:** characters can have their own toggles (`customModuleToggle`).
  - **Off switch:** a setting turns chat toggle binding off entirely.
- **Mechanism.**
  - Values live in `db.globalChatVariables['toggle_*']`. The helpers are in `src/ts/storage/database.svelte.ts:973-1061`, including `applyToggleValues` at `:1021`.
  - Pins: `chat.savedToggleValues` + `savedToggleUnsetKeys`. Defaults: `db.defaultToggleValues`. Presets: `db.togglePresets`.
  - UI in `src/lib/SideBars/Toggles.svelte`.
- **Design decisions.**
  - **Pins record unset keys explicitly.** Loading a pin clears only those keys, so toggles added after pinning (from a new preset or module) are not wiped (8d14b6c0).
  - **Toggle presets still reset everything they do not name.**
  - Commits: e04830ef, add78e7d, 79246bcf, 104c424e, 1aec7599, 6493d859, db12f2cf, 617aa4f8, abe9d3b9.

#### Persona binding UI, persona folders and inline editor; module binding button (M)

- **What it does for the user.** The sidebar has inline controls to bind a persona, prompt preset, model preset or memory preset to the chat, plus a Modules button. Persona edits sync to the chats bound to that persona (2f1aa8ae). There is a duplicate-persona button.
- **Mechanism.** `src/lib/SideBars/SideChatList.svelte:486-505` mounts `ModelBind`, `PromptBind`, `PersonaBind`, `MemoryBind`, `Toggles` and the module button.
- **Commits.** c4a78414, 91913532, d1daac7d, 714d703a, 1b9ab5a1.

#### Role selection for prompt blocks (S)

- **What it does for the user.** Prompt blocks and lorebook entries can carry a role (`src/lib/UI/PromptDataItem.svelte:56`).
- **Origin.** Upstream port (f8fb60fb, ee98b43d).

### 2.5 Lorebook and memory

#### Long-term memory presets with per-chat or per-character binding (L)

- **What it does for the user.** Long-term memory (HypaV3 settings, with a budget) is now a preset. It is bound per chat, falling back to the character, then the global setting, with "default" and "off" options. HypaV3 also gained a configurable `queryChatCount` (0bc4ec83).
- **Mechanism.**
  - `src/ts/process/memory/memoryPresets.ts`: `getMemoryBinding` (`:130`) and `resolveMemoryPresetId`.
  - `db.memoryPresets` is the source of truth. The legacy `hypaV3Presets`, `hypaV3PresetId`, `hypaV3` and `supaMemory` fields are rewritten as a mirror by `syncMemoryMirror` (`:195`), so exported `.bin` files keep working upstream.
  - The older move of supaMemory from character to chat level (55876ce0) is now only a legacy input.
- **Design decisions.** Legacy chats that never had memory enabled stay off (0ab8207c).

#### Stable message ids for copied or branched chats (S)

- **What it does for the user.** Copying or branching a chat re-issues message ids and rewrites in-chat references. HypaV3 summaries that point past the branch cut are dropped, so memory and bookmarks never collide between the two chats.
- **Mechanism.** `reissueMessageIds` (`src/ts/chatClone.ts:21`).

#### Lorebook fixes (S)

- The global lorebook page rendering and its add-entry targeting were repaired, and global lorebook import/export was fixed (b6a0cdfb, c99ed3d4).
- CBS is evaluated before lorebook tokens are counted for cutoff (8c0a24fd, an upstream port).
- Lorebook sortable drag classes are now scoped (b0766848).
- Beyond memory presets, PocketRisu adds no new lorebook features. LoreBook+ was removed as unimplemented (d490d6ba).

### 2.6 Plugins and plugin storage

#### `pluginCustomStorage` moved to per-key server KV (L)

- **What it does for the user.** Long-term-memory plugins can store hundreds of MB without freezing the browser or breaking saves. Before this, the data sat three times in tab memory: the live DB, the patcher baseline, and per-key JSON. User guide: `docs/en/plugin-storage.md`.
- **Mechanism.**
  - **Storage.** Each key is a KV row, `plugin-storage/<base64url(key)>`. Snapshots are content-addressed (`plugin-storage-snapshot/<id>` maps plus `plugin-storage-blob/<sha256>`, with GC).
  - **Upstream compatibility.** `database.bin` keeps an empty `pluginCustomStorage: {}`, and full exports reassemble it.
  - **Server code:** `server/node/plugin-storage-store.cjs`.
  - **Client store** (`src/ts/plugins/pluginStorageStore.ts:242` `getItem`):
    - a key index;
    - a byte-capped LRU;
    - a per-key FIFO write queue;
    - local tombstones;
    - rollback by write token when a server write fails.
  - **V2/V2.1 plugins** use a synchronous API, so all keys are preloaded before the first V2 plugin runs. The preload is one streamed, gzipped NDJSON request, `GET /api/plugin-storage/all` (`server/node/server.cjs:4152`; ee482f74, cde948bf). If the preload fails, V2 plugins do not run (0c6105f4).
  - **Old clients** that send `/pluginCustomStorage/<k>` patch ops are redirected to KV.
- **Design decisions.**
  - **V3 `getDatabase()` returns an empty `pluginCustomStorage` by default.** Full data is opt-in per plugin through `nodeOnlyFullStorageAccess` (`src/ts/plugins/pluginDbProxy.ts:67`; read at `src/ts/plugins/apiV3/v3.svelte.ts:970`). The setting shows the store size and warns above 100 MB.
  - **`includeOnly:['pluginCustomStorage']` deliberately does not count as a request.** Plugin Manager lists that key by default (838b47e5).
  - **`setDatabase` merges keys instead of replacing the object** (`mergePluginCustomStorage`, `pluginDbProxy.ts:53`). This came after a real report where Module Manager and Plugin Manager round-trips wiped storage from 255 keys to 0 (ebe32742).
  - **Writes are tagged with the plugin that made them**, best-effort (`src/ts/plugins/pluginStorageMeta.ts:55`).
  - **A built-in Plugin Storage viewer** (System menu) covers save, localStorage and IndexedDB, with search, JSON edit and bulk delete (15b23d00, 90e3f4a1). It replaces a community plugin that could not reach IndexedDB from its iframe.

#### Plugin security and lifecycle changes (M)

- **Permissions:**
  - Permission grants are **permanent**. Only permission kinds a plugin has not been granted before trigger a prompt; upstream re-asks every 3 days (acb8689b).
  - Grants are keyed by `JSON.stringify([name, desc])` (23b3784d).
  - Permission dialogs are serialized so they cannot overwrite each other at boot (f757d6f6).
  - Each plugin has a permission reset button (`resetPluginPermission`, `src/ts/plugins/apiV3/v3.svelte.ts:643`; 30918a2a).
- **Install gates:**
  - V2.0 plugins can be installed and run only when `allowV2Plugin` is set (`src/ts/plugins/plugins.svelte.ts:390`, `:995`; 511b2769).
  - V2.1 installs require `allowV21Plugin` (`:369`). Upstream blocks them outright; installed ones keep running.
- **Lifecycle:**
  - Updated V3 plugins reload in isolation (a55c4eef).
  - Argument values and the enabled state survive plugin updates (c81938a4).
- **Data visibility.** Deactivated characters are invisible to plugins (`allowedDbKeys`, `plugins.svelte.ts:560`). Lazy asset manifests are hydrated for plugin reads (`src/ts/plugins/pluginCharacterSnapshot.ts:245`).

### 2.7 Chat UI

#### Composer redesign and fullscreen compose (L)

- **What it does for the user.**
  - A Gemini-style rounded "pill" composer with the menu on the left and a round send button.
  - It switches to a two-row layout once the text wraps, and grows up to about 60% of the viewport.
  - Fullscreen compose: Enter inserts a newline there.
  - With an empty input after a user message, the send button becomes "resend".
- **Mechanism.** `src/lib/ChatScreens/DefaultChatScreen.svelte:449` (`composerFullscreen`), `:788` (`updateInputSize`). The menu is a portal-anchored `ShDropdownMenu`.
- **Design decisions.**
  - **Layout latch.** The two-row layout stays on until the input is emptied, so it does not flip-flop between one and two rows (d8a1a5fb).
  - **Floating composer reverted.** A "floating" composer over the messages (2947e778) was reverted in 949e1359 because it ignored `fixedChatTextarea`.

#### Per-chat composer drafts (M)

- **What it does for the user.** Unsent text, including the translate buffer, survives switching chats, opening settings, reloads and moving to another device.
- **Mechanism.**
  - One KV row per draft: `drafts/<chaId>/<chatId>` (`src/ts/storage/chatDraft.ts:27`).
  - Saves are debounced by 800 ms and flushed on blur, chat switch, `visibilitychange` and `pagehide`.
  - A single prefix listing at boot builds an in-memory index, so chats with no draft cost no request.
  - Writes are serialized, so a late save cannot bring back a draft that was already sent.
  - Drafts of deleted chats are removed in one boot sweep (`sweepOrphanDrafts`, `:140`; 8e2a0ad8).

#### Persistent swipe history and swipe UI (M)

- **What it does for the user.**
  - Rerolled alternatives are kept on the message itself (`swipes[]` and `swipeId`), so they survive reloads and sync.
  - Navigation is circular, with ← → buttons and a separate ↻ regenerate button.
  - A page counter can be turned off.
  - Deleting a swipe asks for confirmation, and the reroll confirmation can be skipped.
- **Mechanism.** `DefaultChatScreen.svelte` handles `reroll`, `unReroll`, `nextSwipe` and `deleteSwipe`. The buttons are in `src/lib/ChatScreens/Chat.svelte:940-970`.
- **Origin.** Community PR #10 (a77eea6f), redesigned in b64f6250. The reroll data-loss fix is 01e732dc.

#### Smaller chat items

- **Scroll navigation buttons** (4 / 2 / off). They appear while you scroll, move to the previous or next message, and in "4" mode also jump to the top or bottom (`DefaultChatScreen.svelte:943`; a1138e2a, 6c30f249). (S)
- **Configurable initial and incremental message render counts**, defaults 30 and 15 (`src/ts/chatLoadPages.ts`; 3e4c8072, an upstream #1448 port). (S)
- **Disable the first message per chat.** The greeting is excluded from the prompt but still shown (`Chat.firstMessageDisabled`, read at `src/ts/process/index.svelte.ts:923`; 150dcc73). (S)
- **The message copy button is always shown** (67bcd69b). (S)
- **Restore the last active character after a reload**, opt-in. Mobile browsers discard background tabs, which is what prompted it (000dd8ba, ab4670d9). (S)
- **Recent conversations list** in the home sidebar, built from the character-level `lastInteraction`, so no chat has to be loaded (`src/lib/SideBars/Sidebar.svelte:91`; f4b8c3ab). (S)
- **Chat-hydration loading overlay with Cancel**, plus a "deselected chat" state. Overlay ownership is held by a token, so a late load cannot hide a newer overlay (`claimLoadingOverlay`, `src/ts/stores.svelte.ts:205`; 16dc6c81, bf64890b, bfa18e6a). (S)
- **Error with retry when a chat body fails to load** (364b6c50). (S)
- **Per-platform send-key modes.** PC and mobile each choose Enter, Ctrl/Cmd+Enter, Shift+Enter or button-only. Matching is exact. The mobile default is Ctrl+Enter, so on-screen keyboards insert newlines while hardware keyboards still send (6b820d5a, ac91a02d). (S)
- **Textarea action bar** with copy, reset and expand on long fields (a87e65fc). (S)
- **Asset viewer popup** for character and module image assets. It uses CSS scroll-snap swipe and mounts only the slides within ±1 of the current one (`src/ts/assetViewer.svelte.ts:36`; 713675a4, 4c9f2437). (S)

### 2.8 Character and library management

#### Character manager popup (L)

- **What it does for the user.** A full-screen manager for the character rail, with:
  - search and sorting (order, recent, name, created, chats);
  - filters (all, hidden, deactivated);
  - multi-select bulk deactivate or trash;
  - a Trash tab;
  - folder display modes (icon, image or name);
  - per-character "hide from sidebar".
- **Mechanism.** `src/lib/CharacterManager/CharacterManager.svelte`, `src/ts/characterManager.ts:25` (`buildManagerEntries`). Pure, immutable helpers over `db.characterOrder` and `nodeOnlyHiddenCharacterIds` are in `src/ts/characterOrder.ts:70`.
- **Commit.** 35cc6fd3, which replaced `GridCatalog` and `MobileCharacters`.

#### Folder-organized lists everywhere (M)

- **What it does for the user.** Personas, prompt presets, model presets, modules, plugins and memory presets can all be grouped into folders, through one shared list component.
- **Mechanism.** `groupByFolder` (`src/ts/folders.ts:15`) treats items whose folder is missing as uncategorized. Folder lists are `db.personaFolders`, `promptPresetFolders`, `modelPresetFolders`, `moduleFolders`, `pluginFolders` and `memoryPresetFolders`. The shared component is `src/lib/UI/FolderedList.svelte`.
- **Commits.** d1daac7d, 8edefb60, b8edb68e, 8e01a5fa, be1781e3, 30d8e0d8.

#### Character package export and import (M)

- **What it does for the user.** One zip holds a character's card (CharX), its chats, its bound personas, and the inlays referenced from those chats. It can be imported as a new character or into an existing one.
- **Mechanism.** `src/ts/characterPackage.ts:392` (`exportCharacterPackage`), `:616` (import). Placeholder chats are hydrated before export, and the export aborts if one is missing (9a3fdb3e, 970ec0b1).

#### Character ↔ module conversion; module export as CharX or RisuM (S)

- **What it does for the user.** "Convert to Module" and "Convert to Character" buttons. Modules keep the character's icon. Module export lets the user choose CharX (recommended) or RisuM (legacy).
- **Origin and mechanism.** The conversion logic is an upstream port (`src/ts/interchangeability.ts`). The buttons and the format choice are fork-specific (c2603b52, 98f7599a, e196d2a7). Converted owners keep their own asset manifest (dd718991).

#### Removed: group chats (M)

- **What changed.** Group chats were removed: 399f8b3e deleted `src/ts/process/group.ts` and the group code paths. Legacy group entries are purged at boot (`purgeUnsupportedGroupChats`, `src/ts/storage/database.svelte.ts:1931`).
- **Also removed:** Loadout (95713491), Easy Panel (5385d5fa) and LoreBook+ (d490d6ba). `RisuSaveType.LOADOUTS` is still decoded and skipped, so old `.bin` files load.

### 2.9 Settings, dashboard and observability

#### Settings search with deep links (M)

- **What it does for the user.** A command-palette search over setting labels, keywords and help text, in the current language and English. Picking a result opens the page and sub-tab, scrolls to the row, and flashes it.
- **Mechanism.**
  - `src/ts/setting/searchIndex.ts:223` (`searchSettings`, ranking label > keyword > help, capped at 30) and `:292` (`navigateToSearchResult`).
  - The index walks the declarative `SettingItem` arrays and a hand-written manifest for hard-coded pages.
  - Rows carry `data-setting-id`.
  - The sub-tab state of each page was moved into global stores so deep links can reach tabs.
  - Page constants and `openSettings()` are in `src/ts/routing.ts:91`. Despite the name, `routing.ts` does no URL routing.
- **Commit.** 1aac7c30.

#### Declarative row-layout settings and the `Sh*` component library (L)

- **What it does for the user.** Settings pages use rows: label and short help on the left, control on the right. Sliders and text inputs move under the label on narrow screens. Dialogs, selects, switches, sliders and accordions are accessible bits-ui components.
- **Mechanism.**
  - `layout: 'stacked'|'row'|'block'` on `SettingItem` (`src/ts/setting/types.ts:29`), rendered by `src/lib/Setting/SettingRenderer.svelte` and `Wrappers/SettingRowLayout.svelte`.
  - `src/lib/UI/GUI/Sh*.svelte`. Dialogs have z-index tiers (base, alert, top), because bits-ui portals mount in timing order (02a775a5).
  - A global ESC guard blocks ESC while any `[aria-modal]` dialog is open (e16ca768).
  - `ShSlider` coarsens its step on wide ranges to avoid form lag (1f90e12a).
- **Notes.** A batch of "Kei" primitives was ported in 87274fe8 (`ShCombobox`, `SettingLayout`, `ShTooltip`, …). Several of them are not yet used anywhere.

#### Storage dashboard (L)

- **What it does for the user.** One screen shows:
  - free and used disk;
  - how `risuai.db` breaks down (KV data, chunked blob, snapshots, reclaimable freelist pages);
  - per-character and per-module usage, with a jump to the character;
  - snapshot logical size and dedup savings;
  - orphan media and orphan archive purge;
  - SQLite Optimize and WAL truncate;
  - the toggle for the transfer-size warning.
- **Mechanism.** `src/lib/Setting/Pages/SystemDashboard.svelte:165` reads `GET /api/db/stats` (`server/node/server.cjs:7572`), plus `/stats/characters` and `/stats/modules`.
- **Design decisions.**
  - Stats queries that blocked the event loop were rewritten: 1.9 s → 7 ms, and 3 s → 1.1 s (8c1257a9, f8b7da77).
  - Commits: c6a74b96, ab6d7ec3, 0b897948.

#### System logs: server and client errors persisted (L)

- **What it does for the user.** Errors and warnings from both server and client are stored in `save/logs.db` and shown under System → Logs. Filters cover level, origin and tags, plus an "explicit only" option. Times are shown in localized relative form.
- **Mechanism.**
  - **Capture.** `src/ts/log-capture.ts:89` is imported first in `main.ts`. It patches `console.error`/`warn` and listens for `error` and `unhandledrejection`.
  - **Batching.** `src/ts/log.ts:74` (`addLog`) batches every 500 ms, merges identical entries within 1 s into a count, and POSTs to `/api/logs`. Failed batches are dropped.
  - **Server.** `server/node/logs.cjs` keeps a 5,000-row ring and masks secrets (`maskSensitive`, `:95`: JWTs, bearer tokens, API keys, cookies, the hostname). It also captures server-side errors and uncaught exceptions.
  - **Toasts.** `notify*` toasts (sonner) also write log entries, except success toasts. `alertError` stamps a `[NodeOnly v…]` tag.
- **Commits.** 691328cb, e242759f, b0bc66cc, 59091bfa, fab2675a.

#### Smaller settings items

- **Theme presets** with save, load, copy, export, import and reorder. Fresh installs apply preset 0, "PocketRisu Standard" (`src/ts/storage/database.svelte.ts:2923`; f1469e30, 2446dd23). (M)
- **PocketRisu Standard theme**, with its own markup branch, the chat-width preset (standard, wide, no limit) and a light-mode fix. The upstream look is kept as "Standard Risu" (b520d880, ac58f888, 64eb0f68). (M)
- **Catppuccin and Gruvbox palettes**, with legacy palettes hidden behind a toggle (3103d74a). (S)
- **Primary theme token** (d78dc51f). (S)
- **Auto-hide thin scrollbars**, with one capture-phase listener and rAF (`src/ts/gui/scrollbarAutoHide.ts:41`). (S)
- **Sound & Notification page** (01b87bb6). (S)
- **Accessibility split into tabs** (c1933bc5). (S)
- **Expanded help text**, with `src/lang/help.en.ts` at about 800 lines (632b5221). (M)
- **Insecure-HTTP-context warning** on home, and copy buttons the browser would block are hidden (`src/ts/secureContext.ts:5`; 4b081e39). (S)
- **`alertConfirmMulti`**, a dialog with several actions (`src/ts/alert.ts:328`). (S)
- **Warning under Custom CSS and Custom Chat HTML** that upstream CSS will likely break this layout (8309e347). (S)
- **Translation cache** export, import, edit and delete UI (b7631fff, e08a2480; upstream port). (S)

### 2.10 Ops, install and update

#### Distribution: portable builds, Docker, install script, Termux (L)

- **What it does for the user.** Four ways to install:
  - **Portable archives** for win-x64, macos-arm64, linux-x64 and linux-arm64, bundling Node 24 and `cloudflared`, with native launchers (a Windows `.exe` built from `scripts/portable/launcher.c` and a generated macOS `.app`).
  - **A multi-arch Docker image** (`ghcr.io/pocketrisu/pocketrisu`).
  - **A curl `install.sh`** that builds from the release source tarball, plus `update.sh`.
  - **A Termux build script** (`scripts/termux/build.sh`).
- **Mechanism.** `.github/workflows/release.yml` and `docker-build.yml`.
  - **Smoke test.** The release workflow boots the packaged server on port 6099 and curls `/` before publishing a draft release.
  - **Server-only dependencies.** Only server runtime dependencies are shipped: `scripts/portable/gen-server-deps.cjs:45` walks the `require`/`import` graph from `server.cjs` and `updater.cjs` and pins versions from the lockfile. CI regenerates the list and diffs it against the committed copy. `node_modules` went from about 1 GB to about 40 MB (01681eeb).
- **Design decisions.**
  - sharp was swapped for wasm-vips so Termux can build (fba9a53a).
  - The Docker volume name is pinned to the legacy `risuai-nodeonly_risuai-save` so old users keep their data.
  - Release assets are published twice, under the new and legacy names, so v1.5.x self-updaters still find them.

#### Self-update for portable builds (L)

- **What it does for the user.** "Update now" in the web UI downloads the platform archive, swaps files with rollback, restarts the server, and the client polls until the new version answers. Users who installed via `update.sh` or `update.bat` get the same logic from the CLI.
- **Mechanism.**
  - **Route:** `POST /api/self-update` (`server/node/server.cjs:8441`). It requires auth, allows one update in flight, and streams NDJSON progress.
  - **Validation:** structural checks on the downloaded archive.
  - **Before the swap:** stop the tunnel, carry the SSL certificates over, write an `in-progress` marker.
  - **Swap, in phases:** move managed entries to `.update-tmp/backup`, restoring immediately on any failure; move the new entries in, handling EXDEV; then write the manifest and the version marker.
  - **Restart:**
    - Windows: an ASCII-only `.bat` waits, applies the staged `bin/` (to avoid file locks), and starts node.
    - Unix: a detached `.cjs` helper waits, checks that the port is free (so it defers to process managers), and respawns.
  - **Client:** `src/ts/update.ts:68` (`executeSelfUpdate`, `waitForServerRestart`).
- **Design decisions.**
  - **User files are protected by an installed manifest** (1483d8b6; `scripts/updater.cjs:294`). Only entries in (new package ∪ previous `.installed-manifest`) are managed. A user file that collides with a new app entry is moved to `backups/update-conflict-<ver>/`. A fixed keep-set (`save`, `backups`, `.env`, …) and the custom backup directory are never touched.
  - **Restore only after a real interruption.** A leftover backup is restored only if the in-progress marker is present (f08d52ba). The marker exists because the locked launcher `.exe` can leave a backup behind after a successful update.
  - **No checksum or signature check** of the archive; integrity relies on HTTPS plus the structural checks.

#### Update check, analytics, public stats, supporters (S, through a Cloudflare Worker)

- **What it does for the user.**
  - The home screen shows an update badge with severity, and a one-time popup per version with release-note text supplied by the worker.
  - It also shows DAU and visit badges, and a Patreon supporter dialog that the worker can switch on remotely.
- **Mechanism.**
  - `/api/update-check` (`server/node/server.cjs:8422`) calls `risu-update-worker.nodridan.workers.dev/check` with the version, deployment type (`server.cjs:1557`: `.portable` marker → `.git` → `/.dockerenv` or cgroup → `android`), OS and architecture, a per-install UUID (`save/__instance_id`) and the UI language.
  - The worker answers `hasUpdate`, `severity`, `popupMessage` and `manualOnly` (which can block self-update for a release).
  - The opt-out is the env var `RISU_UPDATE_CHECK=false`; there is no UI toggle.
  - `/api/public-stats` and `/api/supporters` proxy the same worker.
- **Notes.** These routes are unauthenticated. `/api/public-stats` ignores the opt-out.

#### Remote access: Cloudflare Quick Tunnel (M)

- **What it does for the user.** Settings → Remote Access starts a `*.trycloudflare.com` URL and shows it as a QR code. On Termux the UI hides it because `cloudflared` does not work there.
- **Mechanism.**
  - The server looks for `cloudflared` in `bin/`, then on PATH, and downloads it from GitHub if neither exists.
  - `startTunnelProcess` (`server/node/server.cjs:8916`) spawns `cloudflared tunnel --url http://localhost:PORT` and reads the URL from stderr.
  - Routes: `/api/tunnel/{status,start,stop}`. Kill switch: `RISU_TUNNEL_DISABLED`.
- **Related.** Remote access over plain HTTP required moving JWT signing to the server (see auth below). The transfer-size warning exists because the tunnel caps request bodies at 100 MB.

#### Auth: server-signed JWT, persistent session cookie, login rate limit (S)

- **Mechanism.**
  - **JWT.** Upstream signs ECDSA JWTs in the browser with `crypto.subtle`, which needs a secure context. PocketRisu signs HS256 on the server: a 5-minute token from `save/__jwt_secret`, refreshable (9ad5d4c0).
  - **Session cookie.** A `risu-session` cookie (HttpOnly, SameSite=Strict, 7 days) is persisted in `save/__sessions` so it survives restarts. It lets `<img src=/api/asset/...>` and backup downloads authenticate without JavaScript (`server/node/server.cjs:3781`).
  - **Client JWT cache.** The client caches the JWT and de-duplicates refreshes (ce2bf7c7, 1d0fb851).
  - **Rate limit.** Only `/api/login` is limited, to 10 per 30 s. Limiters on the storage APIs broke save loops, and the others threw on `X-Forwarded-For` behind proxies (242bafa1, d7064f1d).
- **Gaps.** The password is stored in plaintext in `save/__password`. `/api/token/refresh` accepts expired tokens indefinitely. There is no `trust proxy`, so behind the tunnel all clients share one rate-limit bucket.

#### Local network mode, proxy changes (M)

- **Local network mode** (an upstream port, f0c5cabe). LAN or self-hosted model servers are reached through `/proxy-stream-jobs` over a WebSocket, with caps. PocketRisu also accepts single-label hostnames such as Docker DNS names (`isLocalNetworkHost`, `server/node/server.cjs:2233`).
- **Proxy fixes:**
  - The idle watchdog on the `/proxy2` relay is 10 minutes (#84).
  - The reverse proxy drops the upstream `Content-Length` after decompression (97cb9ccf).

### 2.11 Mobile and PWA

- **Dynamic viewport height** (`src/ts/viewportHeight.ts:17`). It writes `visualViewport.height` into `--risu-height-size`, but does nothing while a text field is focused (so the native keyboard lift is undisturbed) or while pinch-zoomed (fd699924). (S)
  - It came after an iOS keyboard oscillation that a previous "root scroll guard" caused; that guard was removed (37ef6e3b).
- **Overscroll contained to the chat scroller; pull-to-refresh blocked elsewhere** (6e337d28, 429f6ead). (S)
- **Collapsible left character bar on phones** narrower than 400 px, with a new `xs` breakpoint (a50f084c, e3ffe5e2). (S)
- **Touch drag-and-drop in the sidebar.** Long-press starts a hand-rolled state machine that uses `elementFromPoint`, because HTML5 drag-and-drop does not fire on touch (`src/lib/SideBars/Sidebar.svelte:507`; a91852cd). Rendered positions are mapped back to `characterOrder` so hidden entries don't shift the drop target (c57dc57b). (M)
- **Mobile pickers fill the screen** so the close button stays reachable (8cc76944). Mobile popup-menu actions survive early unmount (872f66df). (S)
- **PWA.** `public/manifest.json` has a PocketRisu name. A broken `share_target` that blocked install on Samsung Internet was removed (221f29c2). `public/sw.js` exists but **nothing registers a service worker**; there is no offline or PWA caching. (S)
- **Screen wake lock** is allowed in plugin iframes (`src/ts/plugins/apiV3/factory.ts:794`). (S)
- **Termux:** detection, native notifications, and the build script (see above).

### 2.12 Performance work (beyond the storage items above)

| Item                                                 | Mechanism                                                                                                                                                                                                                                              | Commit                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Stop restyling every message on scroll               | The scrollbar auto-hide wrote an _inherited_ CSS custom property every frame. Registering it with `@property --risu-scrollbar-alpha { inherits:false }` (`src/styles.css:455`) cut style recalc from about 150 ms to about 5 ms on a 200-message chat. | 603fdf83                               |
| Chat render hot paths                                | Build the asset map once per message, scope `querySelector` to the chat body, memoize watermark encoding (upstream #1369 port).                                                                                                                        | 439ef0eb                               |
| Composer measurement                                 | One `$effect` per keystroke. The translate box is measured only when its value changes.                                                                                                                                                                | e218c42e, 18dc4dc2                     |
| Token counts and highlighting off the keystroke path | Per-field 400 ms trailing debounces with sequence guards, a 200 ms highlight debounce, and closed lorebook entries are not tokenized.                                                                                                                  | da9e58ea                               |
| Save change detection                                | String-compare fast paths, per-root-key and per-module diffs, `deepTouch` subscription without cloning, modules edited on a detached copy.                                                                                                             | cdb48a19, 4a0ccf3c, 9ea2a2c3, 219dc859 |
| Encode only when needed                              | The full DB is encoded only for a full write; patch saves estimate the payload size. Save stages are measured (`src/ts/storage/saveMetrics.ts`).                                                                                                       | f5b75a35                               |
| Network contention on chat open                      | Batched asset-name lookups, a shared manifest cache, home hub cards delayed by 1.5 s.                                                                                                                                                                  | 5d68dba7                               |
| Lua edit dispatch                                    | Skipped when there are no listeners; `editDisplay` is passed as a raw string.                                                                                                                                                                          | f5bccfaf                               |
| Character order lookups                              | Sets instead of `indexOf` scans.                                                                                                                                                                                                                       | c85e4a9c                               |
| Dynamic asset index                                  | The match index is built only when a tag needs it.                                                                                                                                                                                                     | e85b6031                               |
| Gemma tokenizer                                      | Loaded once.                                                                                                                                                                                                                                           | eb55bfbd                               |
| Boot remote-cache sweep                              | Uses the warm cache instead of a full DB decode.                                                                                                                                                                                                       | 792cd6fc                               |
| Snapshot sizing                                      | One pass instead of re-reading every snapshot.                                                                                                                                                                                                         | f8b7da77                               |
| Inlay cache                                          | Sized to `navigator.deviceMemory`.                                                                                                                                                                                                                     | e04f5d61                               |
| Realm search                                         | Adds a `?cache=30` hint (upstream port).                                                                                                                                                                                                               | d9a78e4b                               |

---

## 3. Concepts and ideas (patterns rather than single features)

1. **Legacy shape on disk, slim view in memory.** The browser never holds the full database. Chats are stubs, asset lists are manifest descriptors, plugin storage is empty, and deactivated characters are stubs.
   - The server keeps both views. Before writing `database.bin` or exporting a `.bin`, it re-inflates the upstream-compatible legacy shape (`stripDatabaseForClient` / `hydrateDatabaseForDisk`, `server/node/server.cjs:737` / `:745`).
   - Compatibility with upstream and with older builds is therefore an invariant of the disk format, not of the runtime model.
   - It is tested end to end: `test/compat/*` spawns the real server and round-trips upstream backups, cold-storage formats, settings-only exports and chunked DBs.

2. **One serialized storage queue on the server.** Every mutating route awaits a single promise chain (`queueStorageOperation`, `server/node/server.cjs:121`): patch, write, chat-content, flush, sweep, optimize, WAL checkpoint and snapshot restore. Cold cache loads also run inside it, so a read cannot overwrite an acknowledged patch. "Flush before read, export, snapshot or maintenance" (`flushPendingDb`, `:337`) is a standing rule.

3. **Two-layer conflict detection with a rebase instead of last-writer-wins.**
   - **Patches** carry an `expectedHash`. The server checks it against a compositional per-root-key hash that is cached by object identity (`server/node/patch-hash-cache.cjs`). This only works because cached branches are never mutated in place, and a selective clone copies only the branches a patch touches.
   - **Full writes** carry an ETag (`x-if-match`).
   - **On a 409 from a foreign write**, the client downloads the server DB and replays only its tracked local changes (`src/ts/storage/rebaseMerge.ts:25`). It never adopts the foreign ETag blindly.
   - **409 bodies say why.** A `code` names the guard that fired (`HASH_MISMATCH`, `CHAT_GUARD_REJECTED`, `ASSET_MANIFEST_GUARD_REJECTED`, `ARCHIVE_GUARD_REJECTED`, `CHAT_DELTA_BASE_MISMATCH`). Hash mismatches include per-key and per-character hashes so the divergence can be diagnosed from the system log.

4. **The single-writer lock moves on freshness plus a user gesture** (`server/node/session-lock.cjs`, with a long rationale comment at `:3-38`).
   - Page loads register a boot time but never steal the lock.
   - A non-active session takes over only if (a) it booted _after_ the active session's last accepted write, so it cannot clobber anything, and (b) the client reports a user gesture within the last 15 s (`x-user-active`).
   - Automatic writes from a fresh session (boot housekeeping, flush-on-hide) pass without moving the lock. Stale sessions get 423.
   - An unknown session counts as "unknown", not "stale", to avoid reload loops on flaky links.
   - On losing the lock with unsaved edits, the client offers "download unsaved edits as JSON / reload / cancel" (`resolveSessionHandoff`, `src/ts/globalApi.svelte.ts:585`). This replaced "last page load wins", which kicked the PC whenever the OS restored a phone tab.

5. **Durable generation by journaling raw bytes server-side.**
   - The server streams the provider response unchanged and appends it to a file. Parsing stays entirely in the client's pure adapter parsers.
   - Because of that, the same parser can decode a live stream, a resumed stream (replay from 0 and skip delivered bytes) or a recovered journal, and produce identical results.
   - Idempotency rests on three things: `generationId` (a 409 with your own id means re-attach); fill-only-if-shorter when slotting recovered text into an existing message; and claim-after-apply.
   - Things that cannot be journaled are never jobs: tool loops, cache housekeeping, and aux requests are relay-only and not recoverable.
   - Before the main request exists, a tombstone with an atomic `DELETE`-based claim gives at-most-once re-run across devices. A 3-minute minimum age avoids racing a send that is still alive elsewhere.
   - Secrets never touch disk (the URL query is stripped, headers and body live in memory only), so a restarted server marks running jobs as failed instead of retrying them.

6. **Owner-scoped generation state.** Generation state is a `Map` per chat with `kind: live | background` (`src/ts/process/generationState.ts`). Global `doingChat` is derived from it.
   - Background (recovered) jobs block new sends in their chat but not elsewhere.
   - `endGeneration` takes the owner's `generationId`, so a late wake-up cannot end a newer send.
   - Stop escalates after 8 s for generations that ignore their abort signal.
   - Loading overlays use the same idea: an owner token, so a slow earlier load cannot hide a newer overlay.

7. **Save stages are measured and shown.** The client records `chatsMs`, `patchSetMs`, `patchRequestMs`, `fullEncodeMs` and `fullWriteMs`, plus a `fullWriteReason` (`src/ts/storage/saveMetrics.ts:20`). The server returns `timings{queueMs,hashMs,applyMs,etagMs,lastPersistMs}` on every patch. The dashboard summarizes them. Performance commits quote DevTools before/after numbers (603fdf83, 8c1257a9, f91987b1).

8. **Fail closed on deletion; grace periods; opt-in auto-delete.**
   - Orphan sweeps, inlay reference scans and archive purges throw on a partial view (a missing index or an empty reference walk) instead of deleting.
   - Grace periods: 7 days for auto-sweep, 10 minutes for archive rows.
   - Automatic asset deletion is off by default.
   - The gallery re-scans references right before deleting.
   - Imports hold back the DB entry until it decodes.
   - Exports fail rather than ship a character whose archive row is missing.

9. **Content-addressed, immutable rows for caching and exact restores.**
   - Asset manifests (id = hash of owner and content), plugin-storage snapshot blobs, chunk-store chunks, one archive row per deactivation, and thumbnail filenames that embed the source mtime and size.
   - Results: `Cache-Control: immutable` is safe, a snapshot restore opens exactly what it saw, and caches can never go stale.

10. **Marginal versus logical size.** Snapshot trimming and limits use marginal (dedup-aware) bytes, but the UI shows logical size plus "saved by dedup", because users read a near-zero marginal size as a lost backup.

11. **Disk-space preflight everywhere.** Imports need 2× the backup size, server backups the estimate plus 5%, VACUUM 2.2× the DB size. SQLite temp files go to `save/`, so a single `statfs` check covers them. A transfer-size banner with hysteresis (on at 80 MB, off below 70 MB) is tied to the tunnel's 100 MB body cap.

12. **Built for remote and mobile links.** Many changes are justified by Tailscale or mobile latency and memory:
    - one streamed NDJSON request instead of N GETs (plugin storage);
    - message-level delta sync with fingerprints;
    - local mirrors of server resolvers (asset names);
    - LRU caps sized to device memory;
    - cookie auth so `<img>` tags are browser-cached;
    - NDJSON heartbeats so reverse proxies do not 502 long imports;
    - `authFetch` retrying 502/503/504 with jitter.

13. **Self-update that never deletes user files.** An installed-manifest rule decides which files are app-managed: (new package ∪ previous manifest). User files that collide with new app entries are moved to `backups/update-conflict-<ver>/`, and a fixed keep-set is never touched. Rollback happens immediately on failure. An in-progress marker distinguishes a real interruption from a leftover backup. The custom backup directory is recorded in a plaintext marker file, because the updater cannot read SQLite. The Windows restart script is kept ASCII-only for cmd.exe codepages. CLI and web updates follow the same rule.

14. **Terms-of-service gate for RisuAI-operated servers** (`src/ts/alert.ts:55-73`, `:374`).
    - PocketRisu asks the user to accept RisuAI's ToS and privacy policy before contacting RisuAI infrastructure: Realm browse and download, and the MCP OAuth helper. Gates are at `src/ts/characterCards.ts:346`, `src/ts/process/mcp/mcplib.ts:635`, and `RealmTosGate.svelte`. Realm views stay gated (a `risuTosAccepted` store) instead of popping the dialog themselves.
    - The stored value is the **terms revision** (`'2026-04-11'`), so a revision bump asks again. The legacy `tos2` key is deliberately not carried over.
    - Only the ToS dialog's own accept button counts. It writes a sentinel result (`RISU_TOS_ACCEPT_RESULT`), because the alert store is shared and a "yes" from another dialog that replaced it must not count as consent (a59c6bf4).
    - Related: local transformer models now download from Hugging Face directly instead of RisuAI's mirror (5f6b44b7), and OpenRouter requests identify as PocketRisu (1b5e4bf7).

15. **Off means byte-identical.** Every optional ModelPreset feature (tools, vision, role folding, caching, decoupled streaming, prompt-parameter override) defaults off. Comments require that "off" produce the same request bytes as before. Adapters are pure and never read the DB, which is what makes preview, testing and job recovery deterministic.

16. **Bindings snapshot their defaults and survive deletions.**
    - New chats copy the default model binding, toggles and memory preset at creation, so changing a default never retroactively flips existing chats.
    - A binding to a deleted preset is kept and falls through, so it reconnects when the preset is re-imported.
    - Toggle pins record their unset keys explicitly, so later-added toggles are not wiped.

17. **Measured observability without leaking secrets.**
    - **System log:** one `logs.db` ring buffer receives both server output and patched client `console.error`/`warn`, with masking (JWTs, bearer tokens, API keys, cookies, hostname).
    - **Request log:** a separate `request-logs.db`, rotated by bytes rather than rows, with usage rows that outlive the bodies. It masks URLs because Gemini puts keys in query strings, and is never included in backups.

18. **Compatibility-first data evolution.**
    - New fields are optional, use the `nodeOnly*` prefix, and are filled with `??=` defaults that match the old behaviour.
    - Removed features keep their enum or field values so old `.bin` files load (`LOADOUTS`, `useChatCopy`, `sendWithEnter`).
    - Behaviour that might surprise users (last-chat restore, auto asset cleanup, full plugin storage for V3) is opt-in.
    - Upstream ports carry `Cherry-picked-from:` / `Original-Author:` trailers, and are sometimes "reinterpreted as migration-only". For example, upstream cold storage is accepted on import but never written at runtime (0f8018cc, c942a040).

19. **Plain-HTTP remote access is a first-class target.**
    - JWT signing moved server-side.
    - `crypto.randomUUID` was replaced by `uuid.v4()`, because `randomUUID` exists only in secure contexts and threw when V3 plugins loaded (3ca27e1b).
    - Vertex service-account RS256 signing happens on the server.
    - Copy buttons that the browser would block are hidden, and the home screen warns about an insecure context.

---

## 4. Plugin API additions and changes compared with upstream

`plugins.md` is essentially upstream's document; only `readInlay` was added there (608e3194). Fork-specific behaviour is documented in `docs/en/plugin-storage.md` and `docs/en/deactivate-characters.md`.

| API / behaviour                                              | What it does                                                                                                                                                                                | Pointer                                                  | Origin                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Risuai.readInlay(id)`                                       | Returns `{data (data URI), ext, type}` for an inlay id, or null. Requires the `inlay` permission.                                                                                           | `src/ts/plugins/apiV3/v3.svelte.ts:938`                  | Upstream PR #1454, cherry-picked (608e3194). The permission gate is also an upstream port (d0bafc2f). |
| `Risuai.parseRisuChat(text, opts)`                           | Runs the CBS parser with character, chat and message context. Restricted to the active chat.                                                                                                | `v3.svelte.ts:1103`                                      | Upstream #1520 port (887d85e5, 448ce9ae)                                                              |
| `registerSetting(..., id?)` / `registerButton({..., id?})`   | Upsert by id instead of duplicating on re-register.                                                                                                                                         | `v3.svelte.ts:1241`                                      | 696d8e64 (port of upstream 82088217)                                                                  |
| `pluginStorage.getItem/setItem/removeItem/clear/keys/length` | Async, per key, backed by server KV. The recommended way to read another plugin's keys (the key space is shared).                                                                           | `src/ts/plugins/pluginStorageStore.ts:242`               | Fork (f0d4eee3)                                                                                       |
| `getDatabase().pluginCustomStorage`                          | **Empty by default.** Filled only when the user enables "Provide all plugin data (RisuAI compatible)" for that plugin (`nodeOnlyFullStorageAccess`). A one-time console hint explains this. | `v3.svelte.ts:970`, `src/ts/plugins/pluginDbProxy.ts:67` | Fork (cccaf9ee, 838b47e5)                                                                             |
| `setDatabase({pluginCustomStorage})`                         | **Merges** keys; missing keys are not deleted. Delete goes through `pluginStorage.removeItem/clear`.                                                                                        | `pluginDbProxy.ts:53`                                    | Fork (ebe32742)                                                                                       |
| V2/V2.1 sync storage                                         | All keys are preloaded through one gzipped NDJSON stream before the first V2 plugin runs. V2 plugins do not run if the preload fails.                                                       | `server/node/server.cjs:4152`                            | Fork (ee482f74, 0c6105f4)                                                                             |
| Origin tagging                                               | Storage writes record which plugin wrote them, shown in the Plugin Storage viewer.                                                                                                          | `src/ts/plugins/pluginStorageMeta.ts:55`                 | Fork (ec789767)                                                                                       |
| Permissions                                                  | Grants are permanent (no 3-day reconfirm). Only new permission kinds prompt. Grants are keyed by `[name, desc]`. Dialogs are serialized. Each plugin has a reset button.                    | `v3.svelte.ts:643`                                       | Fork (acb8689b, 23b3784d, f757d6f6, 30918a2a)                                                         |
| Install gates                                                | V2.0 plugins need `allowV2Plugin` to install and run. V2.1 installs need `allowV21Plugin`; upstream blocks them.                                                                            | `src/ts/plugins/plugins.svelte.ts:369`, `:390`, `:995`   | Fork opt-ins (511b2769, 127b975d)                                                                     |
| `screen-wake-lock`                                           | Allowed on the plugin iframe.                                                                                                                                                               | `src/ts/plugins/apiV3/factory.ts:794`                    | Fork (0b74cd89)                                                                                       |
| Request logging                                              | `risuFetch`/`nativeFetch` from V2 and V3 plugins are recorded in the request log (`logSource:'plugin'`, with its own 32 MB cap).                                                            | `src/ts/plugins/plugins.svelte.ts:20`                    | Fork (2deffd1f)                                                                                       |
| Asset manifests                                              | `getDatabase`/`getCharacter*` hydrate lazy manifests so plugins see legacy arrays. Write-back may replace a manifest only with a list the plugin was handed.                                | `src/ts/plugins/pluginCharacterSnapshot.ts:245`          | Fork (4a70de8d, f79c8989, b69fafa9, 856807a2)                                                         |
| Deactivated characters                                       | Invisible to plugins: the stub list is not in `allowedDbKeys`, so plugins treat them as deleted.                                                                                            | `plugins.svelte.ts:560`                                  | Fork (96d58161)                                                                                       |
| Plugin chat index APIs                                       | `getChatFromIndex`/`setChatToIndex` work on chats that have not been opened (lazy stubs).                                                                                                   | —                                                        | Fork fix (114b77d0)                                                                                   |
| Plain-HTTP origins                                           | The SandboxHost nonce uses `uuid.v4()`, so V3 plugins load without a secure context.                                                                                                        | `factory.ts`                                             | Fork fix (3ca27e1b)                                                                                   |
| Lifecycle                                                    | Updated V3 plugins reload in isolation. Argument values and enabled state survive updates. Relative icon URLs are allowed. App alerts render above fullscreen plugin frames.                | —                                                        | Fork fixes (a55c4eef, c81938a4, 52a64e8b, b88fc33d)                                                   |
| Sandbox (upstream ports)                                     | MessagePort pump for stream callbacks, listener and resource leak fixes on terminate and unload, `allowedIPC` sender check.                                                                 | `factory.ts`                                             | Upstream #1308, #1301, #1307, #1405 ports                                                             |

---

## 5. Core-RisuAI pain points PocketRisu fixed (likely shared by sibling forks)

Selection rule: `fix:` commits authored in the fork that touch code PocketRisu still shares with upstream RisuAI (request builders, chat screen, translator, plugin sandbox, save patcher, HypaV3), not PocketRisu-only subsystems. Commits marked "(upstream cherry-pick)" carry a `Cherry-picked-from:` trailer, so upstream has them too; a fork that has merged recent upstream may already have those. The rest were found and fixed in PocketRisu.

| Commit                             | Area                                       | Fix                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01e732dc`                         | chat / reroll                              | A failed or cancelled reroll lost every earlier swipe, because the cloned slice was never restored. The full message array is now restored on failure. Editing a swipe also wrote only `message.data`, so moving away and back reverted the edit; edits now also go to `swipes[swipeId]` (`src/lib/ChatScreens/Chat.svelte`, `DefaultChatScreen.svelte`).                                           |
| `4302bbee`                         | generation lock                            | A send stuck in an await that ignores its abort signal (a stalled plugin provider or stream) held the global send lock until reload. Stop now escalates: if the generation is still registered 8 s after abort, its entry is dropped. `endGeneration` is owner-scoped (by generationId), so a late wake-up cannot end a newer send (`src/ts/process/generationState.ts`).                           |
| `3b715ae9`                         | abort                                      | Cancel the upstream provider request as soon as the client aborts, instead of letting it run to completion (`src/ts/process/request/jobFetch.ts`, `google.ts`).                                                                                                                                                                                                                                     |
| `794bb80a`                         | Anthropic/Bedrock                          | Non-streaming Anthropic/Bedrock requests were not passed the abort signal, so Stop did nothing (`src/ts/process/request/anthropic.ts`).                                                                                                                                                                                                                                                             |
| `865bc087`                         | Gemini                                     | The retry loops in google.ts re-fired immediately on 429/524 and kept the UI "generating" for the whole retry budget. Retries now back off exponentially (1, 2, 4, 8 s) with an abort-aware sleep.                                                                                                                                                                                                  |
| `926ae621`                         | Anthropic/Google                           | An empty system prompt produced an API 400.                                                                                                                                                                                                                                                                                                                                                         |
| `e245c7ff`                         | OpenAI-compatible streaming                | Accumulated streamed reasoning was not reset, and OpenRouter-style incremental reasoning deltas were mishandled. `appendStreamingFragment` now handles both cumulative and incremental providers (`src/ts/process/request/openAI/requests.ts`).                                                                                                                                                     |
| `eee781c4`                         | MCP                                        | `decodeToolCall` used wrong `slice` arguments and always returned an empty string (`src/ts/process/mcp/mcp.ts`).                                                                                                                                                                                                                                                                                    |
| `ab5bd4ce`                         | prompt build                               | The personaPrompt block was gated on the global `db.personaPrompt`, so a chat-bound persona's prompt was silently dropped when the global one was empty.                                                                                                                                                                                                                                            |
| `70de21ed`                         | vision                                     | Chat formatting looked only at legacy model flags, so inlay images were dropped (and captioned locally) for vision-capable models configured another way. The fix shares one `presetSupportsVision()` gate between the formatter and the request builder.                                                                                                                                           |
| `a876e542`                         | auto-translate                             | During streamed auto-translate, every chunk re-ran the whole translation pipeline and the text flickered between blank and content. Translation now runs as one flight per message: the latest snapshot is queued and empty results cannot replace rendered content (`src/lib/ChatScreens/ChatBody.svelte`).                                                                                        |
| `be05bd5d`                         | translator / hotkeys / NAI                 | Four silent breakages. (1) The LLM translation cache was stored under the mutated text (after `<risu-style>` extraction), so every styled message missed the cache and re-billed the model. (2) A throw in the prompt-preview hotkey left a non-closable wait dialog open and the generation locked. (3) Older saves lacked the NAI vibe fields, which crashed the vibe panel. (4) Tokenizer fixes. |
| `9ff600a2`                         | HypaMemory v2                              | The in-memory embedding cache returned shared objects, and metadata was written onto them, so one query could clear a summary and crash similarity search ("reading 'text'"). Cache hits are now copied.                                                                                                                                                                                            |
| `23b3784d`                         | plugin V3 security                         | Plugin permission grants were keyed by plugin name only, so granting one permission authorized all of them, and reset prefix-matched other plugins. Grants are now keyed by `JSON.stringify([name, desc])` (`src/ts/plugins/apiV3/v3.svelte.ts`).                                                                                                                                                   |
| `7349a459`                         | plugin IPC security (upstream cherry-pick) | `postPluginChannelMessage` checked the receiver's own name, not the sender's, against `allowedIPC`.                                                                                                                                                                                                                                                                                                 |
| `3ca27e1b`                         | plain-HTTP origins                         | `crypto.randomUUID` (secure-context only) threw in SandboxHost, Pyodide and google.ts when the app was served over plain HTTP (LAN or self-host), so V3 plugins failed to load. Replaced with `uuid.v4()`, which uses `getRandomValues`.                                                                                                                                                            |
| `efe1001b`, `34a786d7`, `11c3c717` | plugin sandbox (upstream cherry-picks)     | A MessagePort pump replaces ReadableStream transfer for plugin stream callbacks (this also fixes WebKit). Also: a leaked message listener in `SandboxHost.terminate()` and resources leaked on V3 plugin unload.                                                                                                                                                                                    |
| `4fa479fc`                         | save patcher                               | `normalizeJSON` nulled the second occurrence of any shared (non-circular) object, because it tracked every visited node rather than only the ancestor path. This silently corrupted persisted data.                                                                                                                                                                                                 |
| `5c93fb9a`, `330e5b10`             | save patcher                               | `push(...arr)` spread overflowed the call stack on large character, module or preset array diffs (`src/ts/storage/risuSave.ts`).                                                                                                                                                                                                                                                                    |
| `15b729aa`                         | save / state                               | Stack overflow on circular references in module data.                                                                                                                                                                                                                                                                                                                                               |
| `758727d0`                         | Monaco popup editor                        | Chrome's Monaco EditContext kept a stale Ctrl state after opening the editor with Ctrl+X, so typed a/s/d fired global hotkeys. Fixed with `editContext:false`.                                                                                                                                                                                                                                      |
| `0b6bb772`                         | chat HTML                                  | Bot HTML/CSS z-index escaped the chat layer and covered app popups. The chat container now gets `isolation: isolate`.                                                                                                                                                                                                                                                                               |
| `fd699924`, `429f6ead`             | mobile                                     | App height is kept synced to the dynamic viewport on mobile Chrome (`src/ts/viewportHeight.ts`), and pull-to-refresh is blocked outside the chat scroller.                                                                                                                                                                                                                                          |
| `221f29c2`                         | PWA                                        | A broken `share_target` in `public/manifest.json` blocked PWA install on Samsung Internet.                                                                                                                                                                                                                                                                                                          |
| `97cb9ccf`                         | node proxy                                 | The reverse proxy forwarded the upstream `Content-Length` after Node fetch had already decompressed the body, which truncated responses.                                                                                                                                                                                                                                                            |
| `7e5f3d4a`                         | regex scripts                              | CBS macros in `@@move_top`/`@@move_bottom` output were not parsed (`src/ts/process/scripts.ts`).                                                                                                                                                                                                                                                                                                    |
| `8d14b6c0`                         | per-chat toggles                           | Loading a chat's toggle pin cleared every toggle the pin did not name, wiping toggles added later. Pins now record their unset keys explicitly. Turning a switch on and off also left a false dirty mark.                                                                                                                                                                                           |
| `d0391cc4`, `416ddf75`             | chat render                                | The previous message unmounted when the reroll target moved. Concurrent message edit modes were possible (upstream cherry-pick).                                                                                                                                                                                                                                                                    |
| `5f6b44b7`                         | local transformers                         | Local transformer models now download from Hugging Face directly instead of RisuAI's mirror (`allowLocalModels=false`; the old cache keys still resolve).                                                                                                                                                                                                                                           |
| `4594674b`, `0f8018cc`, `c942a040` | upstream backup compatibility              | Encrypted upstream account backups are rejected with an explanation, and the database is verified before it is replaced. Newer upstream cold-storage plugin storage (`_coldplugin`) and flat `coldstorage_<uuid>.json` backup entries are folded back in on import.                                                                                                                                 |

---

## Appendix A. `server/node/server.cjs` route map (fork additions and changes)

| Area           | Routes (line)                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth / session | `GET /api/test_auth` (3731) · `POST /api/login` (3750, rate-limited) · `POST /api/token/refresh` (3764) · `GET /api/session/lock-status` (3772) · `POST /api/session` (3781, cookie) · `POST /api/set_password` (4057) · `POST /api/model-preset/google-service-account/token` (3976) |
| KV / sync      | `GET /api/read` (4068) · `GET /api/remove` (4182) · `GET /api/list` (4224) · `POST /api/write` (4322) · `POST /api/db/flush` (4552) · `POST /api/patch` (4567)                                                                                                                        |
| Chats          | `GET`/`POST /api/chat-content/:chaId/:chatIndex` (6057 / 6102)                                                                                                                                                                                                                        |
| Assets         | `GET /api/asset/:hexKey` (3890) · `/api/asset-manifests/*` (4923–4982) · `POST /api/assets/bulk-read` and `bulk-write` (5049 / 5117) · `GET /api/inlays/references` (6889) · `POST /api/inlays/compress` (8318)                                                                       |
| Plugin storage | `GET /api/plugin-storage/index` (4136) · `GET /api/plugin-storage/all` (4152)                                                                                                                                                                                                         |
| Logs           | `/api/logs` POST/GET/DELETE (4248 / 4280 / 4304) · `/api/request-logs*` (`request-logs.cjs:552-628`, registered at 4320)                                                                                                                                                              |
| Model jobs     | `/api/model-jobs*`, `/api/pending-sends*` (`model-jobs.cjs`, registered at 3717) · `/proxy-stream-jobs` (3646 / 3695)                                                                                                                                                                 |
| Backup         | `/api/backup/export` (5282) + `settings-estimate` (5267) · `/api/backup/import/prepare` (5441) + `/import` (5474) · `/api/backup/server/{save,list,restore,download,path}` (5571–5825, 8265) · `/api/backup/boot-reminder` (8246)                                                     |
| Migration      | `/api/migrate/save-folder/{scan,execute,upload}` (6322–6375) · `/cleanup/{scan,execute}` (6439 / 6454)                                                                                                                                                                                |
| Archive        | `POST /api/characters/:chaId/archive` (6993) · `archive-batch` (7024) · `activate` (7062) · `GET archived/inline` (7138) · `POST /api/db/archive/purge-orphans` (7161) · `DELETE .../archive` (7182)                                                                                  |
| Dashboard      | `GET /api/db/stats{,/characters,/modules}` (7572 / 7752 / 7895) · `POST /api/db/assets/{purge-orphans,auto-sweep}` (7951 / 7966) · `POST /api/db/optimize` (7985) · `POST /api/db/wal-checkpoint` (8042) · `/api/db/snapshots{,/limits,/restore}` (8070–8161)                         |
| Ops            | `GET /api/public-stats` (8391) · `GET /api/supporters` (8406) · `GET /api/update-check` (8422) · `POST /api/self-update` (8441) · `/api/tunnel/{status,start,stop}` (8870 / 8881 / 8972) · `POST /api/termux-notify` (1219)                                                           |

## Appendix B. Gaps and risks seen while surveying (for calibrating what to copy)

- **Self-update and `cloudflared` downloads** are not checksum- or signature-verified.
- **Update check:** `/api/update-check`, `/api/public-stats` and `/api/supporters` are unauthenticated. Every client boot sends an install UUID, the OS and the UI language to a third-party worker. The only opt-out is the `RISU_UPDATE_CHECK=false` env var, and `/api/public-stats` ignores it.
- **Password, tokens and rate limit:**
  - The password is stored in plaintext in `save/__password`.
  - `/api/set_password` is open until a password has been set, and the server listens on all interfaces.
  - `/api/token/refresh` accepts expired tokens with no limit.
  - The login limiter has no `trust proxy`, so behind the tunnel it is one global bucket.
- **Inherited from upstream:** `/hub-proxy` fetches an arbitrary `x-risu-node-path` without auth unless a specific header is present.
- **Code that exists but is unused or incomplete:**
  - `tokenizerOverride` on model presets is stored and editable but never read.
  - The legacy-to-ModelPreset migration is shelved.
  - Several "Kei" UI primitives are unused.
  - `public/sw.js` is never registered.
  - Code comments cite design notes under `.agent/notes/` and `.agent/guide/` that are not in the repository.
- **Known trade-offs:**
  - A request-log entry is lost if the tab dies mid-request.
  - Recovered job text skips edit-output scripts, triggers and TTS by design.
  - The client log drops batches on network failure.
