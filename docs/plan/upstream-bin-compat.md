# Upstream `.bin` Compatibility Plan

Status: planned 2026-10-20 at `437bcdfe9`. Landed on branch `upstream-bin-compat`: S1, S2 and S3
(merged as `ca2592b59`, `d651f3b2a`, `3eedde66f`), then S4 and S6 (merged as `767db8df3`,
`ac5c6fd05`), then S6's four round trips through S4's importer and one asset walker for both
(`d9532709e`, merged as `0e6317f92`; `pnpm check`, `test:agent` and `pnpm build` pass on the
merge), then S5 (merged as `0a6484846`), then S7 (on its own branch, not yet merged into `upstream-bin-compat`). Next: S8 after S7's merge. Each landed slice's section ends with a _Landed_ note on where it
departed from this plan; S4–S7 open with what the earlier slices handed over. `heap-memory-reduction` merged
into `metatron` (`b122ae132`, plan archived `fd13d5381`) before the first slice, so no slice
waits on it. Work branch: `upstream-bin-compat`. Source: the open decisions in
[docs/research/README.md](../research/README.md) (RisuNest item 10, Haejeok A14), answered
by the user on 2026-10-20 (U1–U4 below). Upstream RisuAI is read at `/home/codex/Risuai`
(HEAD `669b12ce`); reference ports at `/home/codex/HaejeokRisuai`
(`packages/backup-core/`), `/home/codex/RisuNest` (`src/ts/storage/upstreamImport.ts`,
`src-tauri/src/native_file_jobs/legacy_backup/`) and `/home/codex/PocketRisu`
(`test/compat/`). **U** paths below are upstream's `src/ts/`, the others metatron's. Line
numbers are approximate; the identifiers are the anchors. Re-verify each cited location
before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm --silent test:agent`
(`--tags-filter=slow` where it says so) and the guide's focused checks, and updates the
owning guide where it changes a documented contract.

## User decisions (2026-10-20)

- **U1. Migration stance.** "No migration owed" was a misreading of the earlier rule
  "formats created during the implementation phase need no compatibility". The rule
  now reads:
  - Upstream RisuAI formats get a one-way migration path. That covers upstream `.bin`
    backups and metatron's own backups from before Phase 1 (`46d63674c`, 2026-09-29),
    which are the same format.
  - Formats that metatron created during implementation still need none: version 1/2
    resource stores, alpha-only fields, the removed LocalForage stores.
  - Recorded as the compatibility rule in `persistence.md` Invariants (`bae614cff`); the
    backup and server guides point at it.
- **U2. Scope.** Both directions: import an upstream `.bin`, and export a `.bin` that
  upstream RisuAI restores.
- **U3. Import semantics.** Full replace, like today's archive restore. The import takes a
  safety snapshot, gets a new epoch, and every tab reloads. There is no merge mode.
- **U4. Risu Account backups** (`encryption.risudat`). Refuse them with an error that
  says why, write nothing, and return to the settings page.

## Goal

- A user coming from upstream RisuAI restores their whole library from one `.bin`: characters
  and groups with every chat, presets, personas, modules, lorebooks, plugins, settings, API
  keys and the `.png` assets. Before anything is replaced, they see a report of what was
  kept, converted, or left out, and can cancel.
- A metatron user exports a `.bin` that upstream RisuAI's "Load Backup" restores, with a
  report of what upstream cannot hold.
- The existing version-2 archive export and import do not change.

## Format facts the slices rely on

Verified by reading upstream; evidence in the research pass of 2026-10-20.

- **Container.** Records are `u32le nameLen | utf-8 name | u32le dataLen | data`, with no
  header or trailer (U `globalApi.svelte.ts` ~1272, `drive/backuplocal.ts` ~441). This is
  the same framing metatron's `server/src/data/archive.ts` (`indexArchive`, `readRecord`,
  `copyRecordToFile`) already reads.
  - Upstream writes basenames only, `.png` assets only (backuplocal ~96), then cold-storage
    records, then `encryption.risudat` if any, then `database.risudat` last. Readers
    must not depend on that order.
  - On restore, upstream writes any non-cold-storage record to `assets/<name>` (~509).
- **`database.risudat`.** Every upstream backup since the feature appeared (`4f58a12b`,
  2023-12-02) is `\0RISUSAVE\0\x08` + `fflate.compressSync` (gzip) of
  `Packr({ useRecords: false })` msgpack of the flat `Database`, with `account: undefined`
  (U `storage/risuSave.ts` ~52, backuplocal ~161).
  - Decoder traps: `undefined` is encoded as fixext type 0 (`d4 00 00`), and integers over
    32 bits are float64. The default `decode` turns int64 into BigInt, so decode with
    `int64AsType: "number"`.
  - The block format (`RISUSAVE\0`, REMOTE blocks) is for live saves and never appears in
    a backup. PocketRisu may write `\x07` (raw msgpack); Haejeok also accepts `\x09`.
- **`encryption.risudat`.** It holds `{time, type: "account"}`, and the database is AES-GCM
  encrypted with a key fetched from `sv.risuai.xyz` (U `util.ts` ~378). It cannot be
  decrypted offline (U4).
- **Cold storage.**
  - Payloads are `coldstorage_<uuid>.json` (plain JSON). Builds v2026.4.120 to v2026.6.215
    wrote a bare `<uuid>.json` (U `coldstorageData.ts` ~7, regex
    `^(coldstorage[/_])?<uuid>.json`). Backups made before v2026.4.120 carry pointers with
    no payloads.
  - A cold character is a stub `{type, image, name, chaId, coldstorage: id,
coldStoragedChats, one empty chat}` with payload `{character}`.
  - A cold chat has `message[0].data = "COLDSTORAGE" + id`, with payload
    `{message, hypaV2Data, hypaV3Data, scriptstate, localLore}` (older payloads are a bare
    message array).
  - Plugin values are referenced from `pluginCustomStorage._coldplugin` (U
    `coldstorage.svelte.ts` ~390-552).
- **Not in a `.bin`:**
  - inlays (LocalForage `inlay`; a backup of them was reverted, `a006375e`, and no tag
    ships it);
  - plugin storage outside `pluginCustomStorage` (LocalForage `plugin`, `safe_plugin_*`,
    `plugin_permissions`);
  - non-`.png` assets.
- **Upstream boot defaults** (`setDatabase`, U `storage/database.svelte.ts` ~30-722, and
  `checkNewFormat`, U `bootstrap.ts` ~337-500) fill most missing fields. An exported
  database must still not trip them:
  - no `null` character;
  - a non-empty `botPresets`;
  - `formatversion: 5`;
  - every chat has a `message` array, every lorebook entry a string `content`, and every
    group a `characters` array;
  - `hotkeys` is an array, and `fallbackModels` is absent or carries all five arrays.
- **Groups.** A group is `type: "group"` in `characters`, with `characters` (chaIds),
  `characterTalks`, `characterActive`, `autoMode` and `useCharacterLore`. A group message
  names its speaker in `saying`. metatron keeps the same shape (`normalizeCharacter`
  rebuilds mismatched talk/active lists).
- **Ids.** Inlay references are `{{inlay::id}}`, `{{inlayed::id}}` and
  `{{inlayeddata::id}}` on both sides. Upstream creates message `chatId`s lazily, so old
  messages lack them.

## Design

**Import** (server, slices 1–5):

1. The tab picks a `.bin`. If its first record is not `manifest.json`, it calls
   `POST /api/backups/import-upstream/prepare` instead of the version-2 import.
2. The server spools the upload and classifies it:
   - `encryption.risudat` → refused (U4);
   - no `database.risudat` → refused;
   - an unexpected name with a `/` → refused.
3. A worker does the heavy work (D1). It is a `worker_threads` thread inside the server
   process, not a browser worker, so the event loop keeps serving every other request.
   The worker:
   - decodes `database.risudat`;
   - folds the cold-storage payloads back in;
   - converts the flat `Database` into a fresh version-3 `resources.sqlite` in a staging
     folder, built with `createResourceStore` and its normal writes;
   - validates the result with `readSnapshot` (every kind's normalizer and the chat
     checks), so a bad file is refused before the user is asked anything;
   - returns the report.
4. The route keeps the staging under a token (the Realm pattern), records the store's
   `writeCount()`, and answers the report.
5. The tab shows the report. The user commits or cancels:
   - **Commit** (`/commit`) first compares `writeCount()` with the value recorded at
     prepare. If it changed and the user has not confirmed, it answers `409
changedSinceReview` without touching anything (D13). Otherwise it runs, under
     `withMaintenance`, the epoch checks, `readSnapshot` on the staged file on the main
     thread, a safety snapshot, a hard link for each asset that does not exist yet, and
     `replaceAll`. It answers the new epoch and the selection to apply (D4). The tab writes
     that selection and reloads.
   - **Cancel**, the TTL expiring, or server shutdown deletes the staging.

**While a restore is in progress**:

- **Prepare and review** (minutes, up to the 10-minute TTL): the live store is untouched,
  and the server serves everything as usual. Other tabs and devices keep chatting,
  generating and saving. Only a second import is refused (409).
- **Commit** (`withMaintenance`, today's mechanism):
  1. The maintenance listeners end the running generation jobs, LLM requests and server
     translations. Their abort checkpoints land in the old database and in the safety
     snapshot.
  2. The gate closes. New resource, asset, `llm-secrets` and job writes answer `503
Retry-After: 5`, and the clients retry them. Writes admitted earlier finish first.
     Reads and the live-update sockets are not gated.
  3. The main thread is busy for the main-thread `readSnapshot` and the synchronous
     `replaceAll` transaction. This is the only window in which every request waits, and
     writes are closed during it anyway.
- **After commit**: every tab learns the new epoch (socket `epoch` frame, the `hello` of a
  reconnect, or a 412 on its next request) and reloads (`haltForRestore`). A tab whose job
  the maintenance ended also watches for the replacement (`watchForRestore`).

**Export** (server, slices 6–7):

1. `POST /api/backups/export-upstream/prepare` takes the tab's selection
   (`promptPresetId`, `modelPresetId`, `personaId`) and `includeSecrets`.
2. Under `snapshots.exclusive`, it reads one consistent copy of the store: `backupTo` into
   staging, as the version-2 export does.
3. It projects that copy to an upstream flat `Database` and encodes `database.risudat`
   (`\x08`). The bytes are kept in staging under a token, and the route answers the report.
4. The tab shows the report. Download (`GET .../download?token=`) streams the referenced
   assets as basename records, then `database.risudat`, through the existing
   `downloadArchive`/`LocalWriter` path.

**New code** goes under `server/src/data/upstream/`, with shared report types in
`shared/upstreamBackup.ts`. On the client, it goes in `src/ts/drive/backuplocal.ts` and a
new `src/ts/drive/upstreamBackupClient.ts`. Keep the client code there; edit
`src/ts/storage/*` only where a step needs an export it lacks.

## Invariants

- The version-2 archive path is unchanged: `planImport`, `runImport`,
  `POST /api/backups/import`, `POST /api/backups/export` and the manifest format. An
  upstream file never reaches `planImport`'s refusal message again, because the client
  routes it first. The server still refuses `database.risudat` there with a message that
  names the upstream import.
- Import never writes the live store before commit. Commit goes through
  `withMaintenance` → `readSnapshot` → safety snapshot → `replaceAll`, with the
  `assertEpoch` checks of `runImport`. `fs.link` never overwrites an existing asset
  (`self-host-server.md` invariant).
- The event loop is blocked only inside the commit's maintenance window (main-thread
  `readSnapshot` and `replaceAll`). Decode, conversion, the staged-store writes and the
  first validation run in the worker.
- Changes committed after prepare are not replaced silently. The commit compares
  `store.writeCount()` with the prepare's value and asks first (D13). The safety
  snapshot still holds them after a confirmed replace.
- One import at a time. The upstream prepare and the version-2 import share the
  `importing` guard, or an equivalent slot. A prepared but uncommitted import holds no
  lock on the live store.
- Every converted record passes its kind's normalizer and the chat snapshot checks, with
  no special case added to `readSnapshot`. A record the converter cannot make valid is
  dropped and reported, and it never fails the whole import, unless it is the database
  itself.
- The worker holds no handle on the live `resources.sqlite`. It writes only into its own
  staging folder under `save/.tmp/`, and a crash, abort, out-of-memory end or shutdown
  leaves nothing outside it. Its memory is capped (`resourceLimits`), so an oversized
  database ends the worker, not the server.
- Decoding the database matches upstream byte for byte. Export output is decoded by
  upstream's own `decodeRisuSave` and restored by its `LoadLocalBackup` without error
  (slice 8 checks this against the pinned checkout).
- The export carries no LLM credential unless the user ticks the option (D7). It
  follows the version-2 rule that a downloaded archive carries none (owner answer 12 (a),
  `backups.ts` ~158).
- Shared code follows T2: no DOM, no runes. `shared/database.ts` asset lists are
  `readonly` (`heap-memory-reduction` B1/B2, merged), so the converter builds fresh arrays
  and never mutates input lists in place.
- Messages: `Message.chatId` is kept when valid and unique. `normalizeMessageList` assigns
  the rest. Group speakers (`saying`) keep their chaIds.

## Order

S1 ∥ S2 ∥ S3 → S4 → S5; S6 after S1 (∥ S3–S5) → S7 after S5 and S6 → S8.

- S1 (codec), S2 (archive classification) and S3 (settings converter) touch disjoint new
  files and can each run in their own worktree.
- S4 extends S3's converter and report. S5 needs S1, S2 and S4.
- S6 (export projection) needs only S1's encoder, so it can run alongside S3–S5.
- S7 edits `backups.ts` and `backuplocal.ts` after S5 did.
- S8 checks the finished work against upstream and closes out the guides.

**After `heap-memory-reduction`.** It merged into `metatron` as `b122ae132` before any slice
started, so the earlier rule (no edits to `src/ts/storage/*`, `src/ts/stores.svelte.ts`, the
boot path or `shared/database.ts` until the merge) is lifted. What it changed and this plan
must respect: frozen asset lists replaced whole (`records.svelte.ts`, B1/B2), one shared
string per equal record text in the save caches (A1), and `readonly` asset tuple types in
`shared/database.ts`. Re-read those before a slice touches the records layer.

## Index

| Slice | What                                                                                 | Kind  | Guide                                  |
| ----- | ------------------------------------------------------------------------------------ | ----- | -------------------------------------- |
| S1    | `risuSave` codec (decode `\x07`/`\x08`/`\x09`, encode `\x08`)                        | small | `self-host-server`                     |
| S2    | Upstream archive classification and cold-storage index                               | small | `self-host-server`                     |
| S3    | Converter: settings, presets/model presets/profiles, personas, secrets               | hard  | `persistence`                          |
| S4    | Converter: characters, groups, chats, cold storage, modules, plugins, assets, report | hard  | `persistence`                          |
| S5    | Import worker, prepare/commit/cancel routes, client report dialog                    | hard  | `self-host-server` + `backup-sync-hub` |
| S6    | Exporter: store copy → upstream `Database` + report                                  | hard  | `persistence`                          |
| S7    | Export routes and the "RisuAI-compatible backup" button                              | small | `backup-sync-hub`                      |
| S8    | Compatibility checks against pinned upstream, guide close-out                        | small | `backup-sync-hub`                      |

## S1. `risuSave` codec (_small_, `self-host-server.md`)

Depends: nothing.

- New `server/src/data/upstream/risuSave.ts`:
  - `decodeUpstreamDatabase(bytes, { maxDecodedBytes })` accepts:
    - `\0RISUSAVE\0\x07` (raw msgpack);
    - `\x08` (gzip, `fflate.decompressSync` with an output-size check before or while
      inflating; a gzip stream's trailer size field gives the size of the last member);
    - `\x09` (gzip from `CompressionStream`; the same inflate).
  - Decode with `new Unpackr({ useRecords: false, int64AsType: "number" })`.
    msgpackr is already `1.10.1` in `package.json`, so check the option names against that
    version. Map ext 0 to `undefined`; confirm msgpackr's default does this.
  - Refuse the block format (`RISUSAVE\0`), headerless data and anything else with
    `UpstreamFormatError` and a message that names the format.
  - The decoded root must be a plain object with a `characters` array. Otherwise the
    error is "not a RisuAI database".
  - `encodeUpstreamDatabase(db)` writes `\x08` exactly as upstream's
    `encodeRisuSaveLegacy(db, "compression")`: `Packr({ useRecords: false })`, then
    `fflate.compressSync`, then the 11-byte header.
- Both functions are synchronous and pure, so S5's worker and S6 can call them.
- Test (`server/src/tests/upstreamRisuSave.test.ts`, node):
  - an encode/decode round trip of a nested object with `undefined`, a large integer,
    `Uint8Array` and non-ASCII strings;
  - a frozen `\x08` fixture made with upstream's encoder logic, decoded to the expected
    object (`server/src/tests/fixtures/upstream/`, with a README giving its provenance:
    upstream commit, the script used, no user data);
  - `\x07` and `\x09` inputs;
  - the block-format header, a truncated gzip, and a decoded size over the cap each throw
    `UpstreamFormatError`.
- Docs: `self-host-server.md` `Files` (the new module).

_Landed_ (`620fc6fc1`, `48d5571af`):

- **API**: `decodeUpstreamDatabase(bytes, { maxDecodedBytes })` and `encodeUpstreamDatabase(db)`
  in `server/src/data/upstream/risuSave.ts`. `UpstreamFormatError` carries a `format`
  field (`UpstreamSaveFormat`).
- **Inflate**: `node:zlib` `gunzipSync` with `maxOutputLength`, not `fflate.decompressSync`.
  fflate trusts the gzip trailer's size field and never checks the CRC. A zlib or
  raw-deflate payload is therefore refused, and concatenated gzip members inflate as a
  whole.
- **msgpackr**: pinned to exactly `2.0.6`. 1.10.1 throws `ERR_BUFFER_OUT_OF_BOUNDS` on Node 24
  for strings of 64 or more characters, which was fixed upstream in 1.11.1.
  - An Opus parity check compared 21 builds in browser and Node modes. The real backup
    `save/Binary.bin` and a 45 MB synthetic database re-encode byte-identical to
    upstream's 1.10.1 browser output.
  - Byte differences appear only for types RisuAI does not store (`Error`, inherited
    properties, more than 65,535 keys, `DataView`). Decoding differs only for invalid
    UTF-8, which becomes `U+FFFD`; the server already did this through
    `msgpackr-extract`.
  - `.risup` and `.risutl` bytes are unchanged.
- **int64**: upstream's `\x08` reader uses the default `decode` (BigInt). This codec returns
  numbers (`int64AsType: "number"`). Upstream's encoder never writes int64 for a number,
  so nothing real differs; the code and the guide note the exception.
- **Memory**: the decoded-size cap does not bound MessagePack decode memory. 2.0.6 caps a
  single array or map header by the bytes left (a 5-byte array32 header now costs 192 KiB
  instead of ~128 MiB), but nested headers can each allocate up to that bound. S5's
  worker heap limit (D1) is therefore required, not optional.
- **Fixture**: `server/src/tests/fixtures/upstream/database-v8.risudat` was written with
  upstream's own library versions (msgpackr 1.10.1 `index-no-eval`, fflate 0.8.2) by the
  committed `make-database-v8.mjs`. Its README gives the provenance.

## S2. Upstream archive classification (_small_, `self-host-server.md`)

Depends: nothing.

- New `server/src/data/upstream/archive.ts`:
  - `planUpstreamArchive(handle)` runs `indexArchive` and returns
    `{ database, assets, cold, ignored }`. It does not read the database.
  - It refuses with `ArchiveRejectedError` and these messages:
    - `encryption.risudat` (U4): "This backup was encrypted with a Risu Account. RisuAI
      can only decrypt it on risuai.xyz; export an unencrypted backup there and import
      that file";
    - no `database.risudat`, or two of them;
    - a duplicate name;
    - a name with `/` or `\`.
  - It classifies the records:
    - `database.risudat` is the database;
    - `coldstorage_<uuid>.json` and bare `<uuid>.json` (UUID-shaped names only) are cold
      storage;
    - every other name is an asset, checked with `resolveStorageKey("assets/" + name)`;
      an invalid key goes to `ignored` and is reported;
    - `manifest.json` or `resources.sqlite` means a version-2 archive, refused with
      "use the regular import".
  - `readColdRecord(handle, record, cap)` JSON-parses one payload under a 64 MiB cap
    (D1). An oversized or unparsable record is reported, not thrown.
- `planImport` (`backups.ts` ~436): keep the refusal of `database.risudat` on the
  version-2 route, but change its message to point at the upstream import ("This is a
  RisuAI backup; choose it again and it will be imported as one"). This message only
  shows if a client older than S5 posts the file. The `encryption.risudat` message stays
  as it is.
- Test (`server/src/tests/upstreamArchive.test.ts`, node), over `testSupport.ts`
  `buildArchive`:
  - an archive with assets, cold records in both name forms and a database classifies
    them correctly;
  - `encryption.risudat`, a missing or doubled database, a slashed name and a version-2
    archive are refused with their messages;
  - an asset name `resolveStorageKey` rejects is ignored and listed;
  - an oversized cold record is reported.
- Docs: `self-host-server.md` (the classification rules).

_Landed_ (`3d5c8b747`):

- **API**:
  - `planUpstreamArchive(handle, savePath)` takes `savePath`, because `resolveStorageKey`
    needs it. Each asset comes back with its storage target, as `planImport` does.
  - Cold storage is `UpstreamColdEntry = { key, records[] }`, with the records in
    archive order.
  - `readColdEntry` returns the last valid payload of a key, as upstream's restore does.
    `readColdRecord` reports `tooLarge`, `invalidJson` or `invalidPayload` and never
    throws.
  - Payload shape is checked as upstream's `isColdStorageBackupData` checks it.
- **Refusal order**: a malformed container, `encryption.risudat` (`UPSTREAM_ENCRYPTED_MESSAGE`),
  a version-2 archive, a duplicate name (which also covers two databases), a slashed name,
  then no database.
- **`ArchiveRejectedError`** moved from `routes/backups.ts` to `server/src/data/archive.ts` and is
  exported, so S5's routes answer these refusals with the same 400.
- **Bare `<uuid>.json` cold records**: confirmed. Upstream wrote `coldstorage/<uuid>.json`,
  and its writer cut that to the basename.

## S3. Converter: settings, presets, personas, secrets (_hard_, `persistence.md`)

Depends: nothing (works on plain decoded objects; S1 is not needed to test it).

- New `server/src/data/upstream/importDatabase.ts`:
  - `convertUpstreamDatabase(db, { report })` returns
    `{ resources: { kind, id, data }[], selection, report }`.
  - S4 adds characters and chats to the same function.
  - The report type is `UpstreamImportReport` in new `shared/upstreamBackup.ts`:
    - counts per category;
    - `converted` and `excluded` lists of `{ code, count, examples: string[] }`, at most 5
      names each;
    - codes are stable strings that the client maps to `language.*` text.
- **Sections and collections.** Pass the flat `db` straight to each section normalizer.
  `normalizeSection` keeps only the section's `SECTION_FIELDS`. Unpack each
  `COLLECTION_FIELDS` entry, and build `COLLECTION_SELECTION_FIELDS` records
  (`translatorPresets` with `translatorPresetId`, `hypaV3Presets` with `hypaV3PresetId`)
  as `{ items, selectedId }`.
  - Report each upstream root field that is in no list (not `SECTION_FIELDS`,
    `COLLECTION_FIELDS`, `PHASE1_FIELDS`, `FORWARDED_ROOT_KEYS` or `DROPPED_FIELDS`) under
    `excluded: unknown-setting`, with its name.
  - `DROPPED_FIELDS` that upstream still uses (`apiType`, `proxyKey`, `formatversion`)
    are consumed by the steps below, not reported.
  - Apply the upstream migrations that metatron's normalizers no longer carry, only where
    the field still exists in metatron:
    - `openrouterProvider` string → object;
    - `antiClaudeOverload` → `antiServerOverloads`;
    - `largeChatPerformanceMode` → `streamingDisplayOptimizationMode`;
    - the `formatversion` < 5 `loreBookToken` floor.
      Check each against the upstream code cited in the research pass, and skip any whose
      target field metatron dropped.
- **Presets** (D6). The upstream root holds the working copy of
  `botPresets[botPresetsId]`, so first overlay the root fields onto that entry. Use
  `FORWARDED_PRESET_KEYS`, `PRESET_ROOT_ALIASES` (`NAIsettings` → `NAISettings`,
  `reasoningEffort` → `reasonEffort`, `presetRegex` → `regex`) and the model and profile
  root fields. Then, for each upstream preset, in order:
  - a prompt preset: the fields `presetFieldOwner` assigns to `"prompt"`, through
    `normalizePreset`. `maxContext` goes into `maxContextOverride*` as `importPreset` does
    on the client (`src/ts/storage/presets.svelte.ts` ~167); that function is client-only,
    so port the logic and do not import it;
  - model profiles: one for `aiModel` and one for `subModel` (with `seperateModels` aux
    models as `{ modelId }` aux slots). Each holds the `"profile"` fields
    (`MODEL_PROFILE_FIELDS`), through `normalizeModelProfile`. Deduplicate profiles across
    presets by equal normalized content, so ten presets on one endpoint make one profile.
    The `default` profile that `normalizeModelProfiles` materializes stays;
  - a model preset with the preset's name: `mainSlot: { profileId }`,
    `subSlot: { profileId }`, `auxSlots`, `seperateModelsForAxModels`.
  - Check the profile id rule (`isValidResourceId`) and how `modelProfiles` and
    `modelPresets` records hold their lists (`shared/presets.ts`, `kinds.ts`) before
    writing.
- **Secrets.** Import keys by default; the user's own backup carries them, and U3 is a
  full restore.
  - Root credential fields → `llmSecrets` flat fields (`FLAT_SECRET_FIELDS`,
    `google.accessToken`, `hordeConfig.apiKey`, `novelai.token`, `OaiCompAPIKeys`),
    through `normalizeLlmSecrets`.
  - A preset whose `openAIKey` or `proxyKey` differs from the root's → a named credential:
    a `credentials` entry plus `llmSecrets.credentials[id].key`, bound by its profile's
    `credentialId`, and reported as `converted: preset-key-to-credential`.
  - `customModels[].key` → a named credential bound the same way. `normalizeCustomModels`
    drops `key`, so convert before normalizing.
  - The staged store gets plaintext keys directly through `store.put`, which skips the
    `prepareWrite` guard (`kinds.ts` ~207). The masked projection stays in force for every
    read after commit.
- **Personas.** Write the root `username`, `userIcon`, `personaPrompt` and `userNote`
  (`PERSONA_ROOT_ALIASES`) into `personas[selectedPersona]`, then run `normalizePersonas`,
  which assigns missing ids.
- **Selection** (D4). Return `{ promptPresetId, modelPresetId, personaId }` for the
  upstream `botPresetsId` and `selectedPersona`.
- **Dropped.** `account`, `loadouts`, Risu Account, Drive and sync fields, and fields of
  other removed features (the `metatron-inventory` research list) are each reported once
  under `excluded`.
- Test (`server/src/tests/upstreamImportSettings.test.ts`, node, plain objects):
  - every resource the converter returns passes its kind's normalizer unchanged (the
    normalizer is idempotent on the output);
  - two upstream presets on the same endpoint share one profile, and different endpoints
    get two;
  - the root working copy wins over the selected preset's stale fields, and not over
    other presets;
  - aliases map (`NAIsettings`, `presetRegex`);
  - a preset-level `proxyKey` becomes a credential bound to its profile;
  - a `customModels` key moves to a credential;
  - root keys land in `llmSecrets`;
  - the selected persona gets the root persona fields;
  - an unknown root field is reported;
  - the `openrouterProvider` string migrates.
- Docs: `persistence.md` (the converter as a writer of resources; the `Backend` note on
  the removed block save format, ~130, names the converter instead of "not built yet").

_Landed_ (`cb4c9ca48`):

- **API**:
  - `convertUpstreamDatabase(db, { report })` returns `{ resources, selection, report }`
    (`UpstreamConversion`, `server/src/data/upstream/importDatabase.ts`).
  - It is pure and does not mutate its input.
  - Every record is exactly what its kind's normalizer keeps.
  - A bad setting or list entry is dropped, or reset to its default, and reported. Only a
    non-object database fails the whole conversion.
- **Report**: the report type, the code lists (`UPSTREAM_CONVERTED_CODES`,
  `UPSTREAM_EXCLUDED_CODES`) and the helpers (`createUpstreamImportReport`,
  `addUpstreamReportEntry`) are in `shared/upstreamBackup.ts`. `UpstreamImportSelection`
  is there too.
- **Profile deduplication**: two profiles are the same when their normalized content is
  equal, compared as key-sorted JSON without `id` and `name`. `modelId`, `maxContext` and
  `credentialId` all count. Auxiliary-slot models also get deduplicated profiles. The
  materialized `default` profile is kept, and nothing is merged into it.
- **Departures from this plan** (each checked against upstream `669b12ce`):
  - A preset's own `openAIKey`: upstream stopped restoring it on a preset switch
    (`501167dd`), so only the root key is ever used. A differing preset key is kept as an
    unbound `openai` named key.
  - `proxyKey`: metatron's reverse proxy reads no default key, so every distinct proxy key,
    the root's included, becomes a `custom` named key, bound by that preset's
    `reverse_proxy` profiles.
  - Non-selected presets: upstream's `setPreset` lets a preset inherit root values or fixed
    defaults for fields it lacks. That inheritance is ported. Global fields (NanoGPT,
    Ollama options) stay the root's.
  - `translatorPresetId` and `hypaV3PresetId` are list positions upstream. They are mapped
    to the selected item's id.
  - Auxiliary slots become profiles, not bare `{ modelId }` slots. A bare slot loses the
    global connection options and is refused for models that need a profile.

## S4. Converter: characters, chats, cold storage, the rest (_hard_, `persistence.md`)

Depends: S3.

Handed over from S2 and S3:

- S3 emits `characterOrder` and `enabledModules` unfiltered. S4 replaces both after
  dropping characters and modules.
- Repair old character image paths in databases with `formatversion` below 2. Upstream's
  `checkNewFormat` does this (`bootstrap.ts` ~432).
- Cold-storage input comes from S2: `UpstreamColdEntry` read with `readColdEntry`.
  Decide how a key whose records are all invalid is reported; it falls under D3
  (`cold-missing`).
- Extend S3's report and code lists in `shared/upstreamBackup.ts`; do not start a second
  report.

- **Cold storage first.** Use the payloads S2 indexed (passed in as a map; the
  converter does no I/O):
  - a stub character with `coldstorage` → replace it with its `{character}` payload,
    checking that `chaId` matches;
  - a chat whose `message[0].data` starts with `COLDSTORAGE` → take `message`,
    `hypaV2Data`, `hypaV3Data`, `scriptstate` and `localLore` from its payload (a bare
    array is `message`);
  - `pluginCustomStorage._coldplugin` → fold each referenced value into
    `pluginCustomStorage`, then delete `_coldplugin`;
  - a missing or invalid payload (D3) → keep the stub character (name, image) or keep the
    chat with its metadata and no messages, and report `excluded: cold-missing` with the
    names.
- **Characters and groups** (D2):
  - drop `null` entries, and `§temp` and `§playground` (multiuser and playground leftovers,
    U `globalApi.svelte.ts` ~1103);
  - assign a missing or duplicate `chaId` (`isValidResourceId`, `randomUUID`);
  - mirror the client's `prepareNewCharacter` (`src/ts/storage/characterStore.svelte.ts`
    ~145, client-only; `shared/characters.ts` holds the helpers it shares) on the
    server: `upgradeLorebook` (`shared/modules.ts`), `ttsMode: "none"` → `""`,
    `creation_date` when absent, `postHistoryInstructions` → the note of the chat at
    `chatPage`, and a first chat when there are none. Reuse the shared helpers and port
    only what the server lacks, into `server/src/data/upstream/`, without editing
    `characterStore.svelte.ts`;
  - strip `chats`, `chatPage`, `coldstorage`, `coldStoragedChats`, `realmId`; then run
    `normalizeCharacterRecord`;
  - groups keep `type: "group"`; drop member chaIds that no longer exist, and report them.
- **Chats.** Each chat, in upstream order, becomes a `create` in the staged store (S5
  writes them through `store.applyChanges`):
  - meta from `normalizeChatMeta`, a chat `id` assigned when missing or duplicate, and
    `fmIndex` defaulted;
  - messages through `normalizeMessageList`, which keeps valid unique `chatId`s and
    assigns the rest.
  - Bindings (D5): `promptPresetId` and `modelPresetId` get the converted selection;
    `bindedPersona` stays when that persona exists and otherwise becomes the selected
    persona; no `bindingReview`.
  - Chat toggles (corrected during S4, checked against U `chatVar.svelte.ts`
    `getGlobalChatVar`): upstream reads the chat's `GLGlobalVariables` first, with or
    without `useLocallySetGlobalVariables`. The flag only decides where writes go. An empty
    `""` value counts as unset there, so the global `globalChatVariables` value applies.
    metatron also reads the chat's `GLGlobalVariables` first, with `globalChatVariables`
    only as the read-only legacy fallback (`cbs-rendering.md` Globals row), but treats `""`
    as set for text toggles. So keep `GLGlobalVariables`, remove its `toggle_*` keys whose
    value is `""`, and drop the flag.
  - The chat order is upstream's array order.
- **`characterOrder`.** Upstream ids and folders, through `normalizeCharacterOrder`;
  remove ids of dropped characters.
- **Modules, plugins, plugin storage, the rest.**
  - `modules` through `normalizeModule` per entry; a failing module is dropped and
    reported, never a whole-import failure. `enabledModules` loses ids it no longer
    resolves.
  - `plugins` are kept as stored. Report each plugin whose `version` is not `"3.0"` under
    `excluded: plugin-unsupported-version` (metatron loads only v3; RisuNest small wins P1
    adds the in-app badge).
  - `pluginCustomStorage` → `pluginStorage`. Upstream's v3 storage in LocalForage is not
    in the file; report `excluded: plugin-device-storage` once.
  - No `pluginPermissions` record: grants are asked again.
- **Assets.**
  - Collect every `assets/...` key the converted records reference: the existing
    reference walker of the export's missing-asset report (`buildBackupInventory` /
    `selectPartialBackupAssets` categories in `shared/backups.ts`), or a server
    equivalent.
  - Keys present in the archive are linked at commit. Absent keys go into the report's
    `missing` list (by character and role, as the version-2 export reports them). Absent
    non-`.png` keys are expected (upstream never backs them up), and the report says so.
  - Upstream inlays are not in the file: count chats whose text has `{{inlay*::id}}` and
    report `excluded: inlays-not-in-backup`.
- Test (`server/src/tests/upstreamImportCharacters.test.ts`, node):
  - a cold character and a cold chat are restored from their payloads (both payload
    shapes and both record names);
  - a missing payload keeps the stub and reports it;
  - `_coldplugin` folds;
  - null, `§temp` and duplicate-id characters;
  - messages without `chatId` get unique ids, and duplicates are replaced;
  - a group with a missing member;
  - `postHistoryInstructions` moves into the selected chat's note;
  - a chat gets the converted bindings;
  - a failing module is dropped and reported;
  - `characterOrder` loses dropped ids;
  - an inlay reference is counted;
  - missing assets are reported by character.
  - Then an end-to-end check: write the converted output into a fresh
    `createResourceStore({ file })`, `backupTo` a file, and `readSnapshot` accepts it.
  - Before committing, the slice also runs the converter once on the real backup
    `save/Binary.bin` in the main checkout (see S8; read only, never committed). Five of
    its six characters are cold-storage stubs, so this is the cold-character path on real
    data. Expect all six characters restored, with their chats and messages from the cold
    records, and no `cold-missing` entry. Report counts only, never names or text.
- Docs: `persistence.md` (the cold-storage fold on import; the cold-storage removal note at
  ~141 now says upstream payloads are read on import only).

_Landed_ (`0952e2113`, merged as `767db8df3`):

- **API**: `convertUpstreamDatabase(db, { cold, assetKeys, now? })` returns `{ resources,
characters, chats, selection, report }`. `cold` holds S2's `readColdEntry` results and
  `assetKeys` the archive's asset keys; the converter still does no I/O. One report serves
  one conversion.
  - `chats` are ready `ChatGroup`s, one per chat: `{ characterId, chatId, baseRevision:
null, ops: [{ op: "create", chat }] }`, in upstream order.
  - Every message already has a valid, unique `chatId`, so the store renames nothing.
- **Files**: `importCharacters.ts` (characters, groups, chats, cold stubs),
  `importCollections.ts` (`characterOrder`, `enabledModules`, modules, plugins,
  `pluginStorage`), `assetReferences.ts` (`collectAssetReferences`) and `importRecords.ts`
  (record helpers moved out of `importDatabase.ts`), all in `server/src/data/upstream/`.
- **Recovery**: a bad message, field or chat is dropped and reported one at a time, never
  failing the whole import. A message at the depth limit drops only itself. Repairs (ids,
  lorebooks, group members) are reported.
- **Real backup** (`save/Binary.bin`, counts only): 6 characters, 5 from cold records, no
  `cold-missing`; 8 chats and 2 messages, equal to the raw upstream totals; 2 modules,
  0 plugins; 0 of 3,393 assets missing. The staged store's `backupTo` copy passes
  `readSnapshot`.
- **Departures from this plan** (each checked against upstream `669b12ce`):
  - Chat toggles: the plan's rule was wrong. The corrected rule is in the Chats bullet
    above.
  - The cold-chat marker is `"COLDSTORAGE" + key`, not `"COLDSTORAGE" + key`.
  - `_coldplugin` values go into `pluginCustomStorage._pluginStorage`, where metatron's
    v3 plugin storage lives, not the top level.
  - Before upstream `cad8595a`, upstream kept v3 plugin values at the top level of
    `pluginCustomStorage`. A file without `_pluginStorage` gets those copied into it.
  - Upstream's backup writes a cold value only when it is a list, or an object with
    `character` or `message`. Most `_coldplugin` values are therefore never in the file;
    their pointers are reported as `cold-missing`.
  - `enabledModules` selects by id or by namespace, so both are kept when they resolve.
  - Characters missing from `characterOrder` are not appended; metatron's boot does that.
  - Old image paths are repaired whatever `formatversion` says.

## S5. Import worker, routes, and the report dialog (_hard_, `self-host-server.md` + `backup-sync-hub.md`)

Depends: S1, S2, S4.

Handed over from S1–S4:

- A fresh `createResourceStore` materializes the singleton records. The worker must
  update those at their current revision, not create them.
- The worker heap limit (`resourceLimits`) is mandatory (S1 _Landed_, Memory).
- Call `planUpstreamArchive(handle, savePath)`. Answer `ArchiveRejectedError` from
  `server/src/data/archive.ts` with 400.
- Write S4's output in this order:
  1. `resources`: `store.put(kind, "main", data, store.get(kind, "main")?.revision ??
null)`. The S3 kinds already exist in a fresh store; `modules`, `plugins` and
     `pluginStorage` do not, so they are created.
  2. `characters`: `store.put(characters, id, data, null)` for each. This also creates
     each character's empty chat order.
  3. `chats`: `store.applyChanges({ chats })` in batches, in array order. Each create
     appends, so every chat order matches upstream's.
- Pass `convertUpstreamDatabase` the cold entries and the archive's asset keys; use a new
  report per conversion.

- **Worker.** New `server/src/data/upstream/importWorker.ts`, one `worker_threads` worker
  per import, inside the server process (D1). For the pattern, see
  `server/src/scripts/workerPool.ts`: `new URL("./worker.ts", import.meta.url)` and its
  `ResourceLimits`.
  - Input: the spooled archive path, the staging folder (under `save/.tmp/`, from
    `makeStaging`), and the caps.
  - It runs S2's index, S1's decode, the cold reads, and S3+S4's conversion.
  - It writes the staged store with `createResourceStore` (`file: stagingFile`, `kinds:
createKindRegistry(DEFAULT_RESOURCE_KINDS)`), then `store.put` and
    `store.applyChanges` with the chats in batches. It then calls `backupTo` to write one
    self-contained file.
  - It validates that file with `readSnapshot` and returns only success, or the
    validation error. The `ValidatedSnapshot` is not posted back: copying it across
    threads would double the memory, and commit validates again.
  - It posts progress (`{ phase, done, total }`), then the report.
  - `resourceLimits.maxOldGenerationSizeMb` defaults to a size derived from D1's 1 GiB
    database cap, overridable. `ERR_WORKER_OUT_OF_MEMORY` and any other worker exit become
    a 400 that says the backup is too large or unreadable.
  - Abort: `worker.terminate()`, then removing the staging folder.
  - Check first that `createResourceStore` starts no timer or feed that would keep the
    worker alive or touch the live store, and that `node:sqlite` works inside a worker on
    Node 24.
- **Shutdown and disconnect.**
  - The prepare is admitted through `serveFileImport`'s `admit`, so `snapshots.track`
    covers it and `stop` waits for it. Its `signal` aborts when the request does: the
    client disconnects, or shutdown force-closes the remaining connections after its 8 s
    HTTP drain (`main.ts`).
  - The worker listens to that signal. An abort terminates it at once (`worker.terminate()`)
    and removes the staging, so `stop` never waits for a conversion that can take minutes.
  - Also check whether a shutdown should abort the prepare before the 8 s drain ends,
    through a shutdown hook rather than the request signal. If so, add one and say so in
    the guide.
  - Staged tokens waiting for a commit are removed on close, as `createRealmStaging`'s
    `close` does (`importRealm.ts` ~91).
  - A crash that skips this cleanup is covered, because `registerStorageRoutes` empties
    `save/.tmp/` at startup.
- **Routes** (`server/src/routes/backups.ts`, or a new `backupsUpstream.ts` registered next
  to it):
  - `POST /api/backups/import-upstream/prepare`: checks auth, `assertEpoch`, the
    `maxImportBytes` cap and the shared `importing` guard, then spools the upload and runs
    the worker.
    - It does not run `readSnapshot` on the main thread; the worker did.
    - Under a token, it stores the staged file, the assets folder, the selection, the
      report, the epoch, and `writeCount()` at the end of prepare. It uses
      `createRealmStaging`'s slot/TTL pattern (`importRealm.ts` ~91): 10 minutes, at most
      1 waiting import.
    - It answers NDJSON progress lines, then `{ token, report }` (`serveFileImport` /
      `lines`, `http/fileImport.ts`).
  - `POST /api/backups/import-upstream/commit` `{ token, acceptWrites? }`:
    1. **Changed-since-review check** (D13), before `withMaintenance`, so a refusal
       aborts no running job. Compute `writeCount() - prepared`. If it is above 0 and
       differs from `acceptWrites`, answer `409 { error: "changedSinceReview", writes }`.
       The token is kept, and nothing else happens.
       - Do not repeat the check inside the maintenance callback. The maintenance
         listeners' own abort checkpoints count as writes, so the check would always fire
         when a job was running.
       - The window between this check and the gate closing is accepted; the safety
         snapshot covers it.
    2. Then, under `withMaintenance`:
       - `assertEpoch`;
       - `store.readSnapshot(stagedFile)`, on the main thread inside the window where
         writes are closed anyway;
       - the safety snapshot;
       - asset hard links. Extract each asset record with `copyRecordToFile` into the
         staging `assets/` first, during prepare, so commit only links;
       - `assertEpoch`, then `replaceAll`.
    - Lift the steps after `readSnapshot` out of `runImport` into a shared helper, so both
      routes run the same code. The version-2 `runImport` keeps its order (`readSnapshot`
      before `withMaintenance`) and its behavior.
    - A `readSnapshot` failure at commit (unexpected after the worker's check) is a 400.
      The jobs it ended stay ended, which is the cost of validating inside the window.
    - It answers `{ epoch, assetsWritten, assetsSkipped, selection }` and frees the token.
  - `POST /api/backups/import-upstream/cancel` `{ token }` and the TTL expiry delete the
    staging. A 404 `Import expired` matches the Realm wording.
  - Errors use `backupErrorResponse`'s mapping. A worker crash or decode failure is a 400
    with the format message. The staging is always removed.
- **Client.**
  - `LoadLocalBackup` (`src/ts/drive/backuplocal.ts` ~250) reads the first record header
    from the `File` (`file.slice(0, 4 + 4096)`): `manifest.json` takes today's path, and
    anything else goes to the upstream path in new `src/ts/drive/upstreamBackupClient.ts`.
    That module holds the prepare with progress, commit and cancel, through `authFetch`
    and the NDJSON reader of `src/ts/storage/serverImportClient.ts` (imported, not
    edited).
  - The report dialog (new `src/lib/Setting/Pages/UpstreamImportReport.svelte`, opened
    through an `alert.ts` helper or the existing markdown alert; check which fits U3):
    - the counts;
    - a "converted" list and a "left out" list, each code as one translated line with its
      examples;
    - missing assets;
    - Cancel and Restore buttons, with the full-replace warning. The warning says that
      running generations on every device are stopped and every open tab reloads.
  - A `409 changedSinceReview` asks again: "N changes were saved after this preview (on
    this or another device). Restoring replaces them; the safety snapshot keeps them.
    Restore anyway?" A yes resends the commit with `acceptWrites: N`, and a no cancels.
    A second 409 (more writes meanwhile) asks again with the new count.
  - While the commit runs, the dialog shows a wait state until the answer arrives, so it
    does not look like a hang. Other tabs see the 503 retries and then reload.
  - After commit, write the returned `selection` into the tab's selection storage the way
    `selection.svelte.ts` persists it, then reload. If that module has no export for it,
    add one there rather than writing the `risu-selection` localStorage shape from the
    drive module.
  - An `encryption.risudat` refusal shows the U4 message through `alertError` and stays
    on the settings page.
- Strings: `language.upstreamImport*` in `src/lang/en.ts` (and `ko.ts`, D11).
- Test:
  - `server/src/tests/upstreamImportRoute.test.ts` (node): prepare → commit replaces the
    store (new epoch, safety snapshot listed, assets linked, existing assets untouched);
    prepare → cancel leaves the store and disk unchanged; an expired token is a 404; a
    second prepare while one waits is a 409; an encrypted archive is a 400 with the U4
    message; an epoch mismatch at commit is a 412; a worker that throws leaves no staging
    folder.
  - Changed-since-review: a resource write between prepare and commit gets `409
changedSinceReview` with the count, and the store is unchanged and no job aborted;
    the commit with that `acceptWrites` replaces; a further write after the confirmation
    gets a 409 again; no write means no 409.
  - Abort cases: a running job during commit ends with `maintenance`, and its checkpoint
    is in the safety snapshot; a worker over its memory limit answers 400 and leaves no
    staging folder; a shutdown during prepare terminates the worker, removes the staging,
    and `stop` resolves without waiting for the conversion.
  - The event loop stays free during prepare: a resource read answered while the worker
    converts (drive it with a latch in the worker input, not a timer, V3).
  - Tag the full-pipeline cases `slow` if the worker boot breaks V3.
  - `src/ts/drive/backuplocal.test.ts`: a `manifest.json` head takes the version-2 path,
    and anything else takes the upstream path; the report is shown before commit; Cancel
    calls cancel; a 409 `changedSinceReview` asks with the count and resends with
    `acceptWrites`, or cancels on no; commit writes the selection and reloads; a refusal
    is shown.
- Docs:
  - `self-host-server.md` `Routes` and `Flows` (backup archives: the worker, where the
    event loop is blocked, the changed-since-review check, shutdown).
  - `self-host-server.md` Known Hazards: the entry on restore and import validating
    synchronously on the serving thread (~501) now names the version-2 path only. The
    upstream import blocks only inside its maintenance window.
  - `backup-sync-hub.md` `Files`, `Flows`, and `Invariants`: the U1 rule is already
    written there (`bae614cff`) with "not built yet". Replace that with how pre-Phase-1
    and upstream `.bin` files are restored through the upstream import. Other store
    versions are still refused.
  - `persistence.md` Invariants, compatibility rule: drop "not built yet" and the
    sentence that the server refuses `database.risudat` archives.

_Landed_ (S5 branch, one commit; `opus-workflow`: Sol plan review and challenge, Fable review and tests, Astra fixes):

- **Files**: `server/src/data/upstream/importStage.ts` (`stageUpstreamImport`, the worker's body without
  worker APIs, so tests run it in process), `importWorker.ts` (entry; a `latch` test hook),
  `importRunner.ts` (`runUpstreamImportWorker`, `UpstreamImportRunner`), `server/src/routes/backupsUpstream.ts`
  (`createUpstreamImportStaging`, `registerUpstreamImportRoutes`), `src/ts/drive/upstreamBackupClient.ts`,
  `src/lib/Setting/Pages/UpstreamImportReport.svelte`. Route paths, TTL, line and result types in
  `shared/upstreamBackup.ts`.
- **Departures from this plan**:
  - Classification (`planUpstreamArchive`, now with an abort signal through `indexArchive`) runs on the
    serving thread in `serveFileImport`'s `prepare`, so an archive refusal (U4 included) is a real 400
    before anything streams. The worker does the decode, cold reads, conversion, staged store,
    validation and asset extraction. The synchronous classification pass (at most 200,000 names) is a
    Known Hazard in `self-host-server.md`.
  - Worker failures (a damaged database, out of memory, any exit before a result) are the last NDJSON
    line `{ error }` of a 200 answer, not a 400: the headers are sent once progress streams. The test
    list's "400" for those cases reads as that line.
  - The prepare's result line is `{ token, report, selection }`. The tab registers a synchronous
    `beforeRestoreReload` hook (`resourceSync.svelte.ts`) before each commit, so when its own socket
    reports the new epoch before the commit's answer, the selection is written before the restore
    notice; the notice never waits on the network. The commit still answers `selection` (D4).
  - The D13 re-ask is shown in the same report dialog (`changedWrites` notice), and only that dialog's
    own Restore button authorizes a commit (`alertUpstreamImportReport` records its own answer; a plugin
    dialog answered "yes" over it does not count).
  - The version-2 import's `importing` flag became an `ImportSlot` that the upstream prepare and commit
    share (the commit holds it). `serveFileImport` gained an optional `preflight(c)` (the prepare's epoch
    and waiting-import checks, synchronous before admission) and `abort` signal (shutdown); `spool` takes
    that signal only for a route that sets `abort` (passing it always changed the Realm route's 502 to a
    500). `serverImportClient.importOverServer` gained optional `headers` (the prepare's epoch).
  - Shutdown: `beginShutdown` calls `upstreamStaging.close()`, which aborts a running prepare at once
    (worker terminated, folder removed after it ended), so `snapshots.stop()` does not wait out the 8 s
    HTTP drain for a conversion; `dispose` awaits it.
  - Every archive asset is extracted during prepare (two copies on disk until commit, cancel or expiry),
    so the commit only links.
  - Caps: decoded database `RISU_MAX_UPSTREAM_DB_BYTES` (1 GiB); a `database.risudat` record over
    `maxEncodedDatabaseBytes(cap)` is refused before it is read; worker heap `RISU_UPSTREAM_IMPORT_HEAP_MB`,
    default twice the cap in MiB within 256..4096 (2048). The heap limit covers the JavaScript heap only.
  - New excluded code `asset-name-invalid` (S2's ignored records). The commit's diagnostics event reuses
    lifecycle phase `import`. A lost commit answer says the restore may have happened (`commitInterrupted`).
- **Real backup** (`save/Binary.bin` read in place, disposable save dir, counts only): prepare answered
  3,409 NDJSON lines; report 6 characters (5 restored from cold storage), 8 chats, 2 messages, 4 prompt
  presets, 4 model presets, 6 profiles, 1 persona, 2 modules, 0 missing assets; commit linked 3,393
  assets, gave a new epoch and one safety snapshot, and left `save/.tmp` empty. A 10 ms interval kept
  ticking during the prepare.
- **For S7**: register the export routes in `shared/diagnostics.ts` `ROUTE_TEMPLATES` (a test checks every
  registered route) and in `app.ts`'s body-limit list if the export body needs it; `createUpstreamImportStaging`
  is the pattern to copy for the export's token; `backupErrorResponse` is exported from `backups.ts`.
- **Tests**: `upstreamImportRoute.test.ts` (default suite, in-process runner), `upstreamImportWorker.test.ts`
  (`slow`: the real worker, out of memory, the latch, shutdown), plus `upstreamArchive`, `backuplocal`,
  `alertUpstreamImportReport`, `selection` and `resourceSync` cases. Not tested: a worker that exits
  cleanly without a result (no seam to make one; the out-of-memory case covers the same path), and a
  generation job ended by the commit's maintenance (unchanged `withMaintenance`, covered elsewhere).
- **Not verified**: no browser check of the dialog, the reload, or other tabs (S8's manual checks);
  Docker image not rebuilt.

## S6. Exporter: store copy → upstream `Database` (_hard_, `persistence.md`)

Depends: S1.

Handed over from S1 and S3:

- Encode with `encodeUpstreamDatabase` (msgpackr 2.0.6, byte-identical to upstream for
  RisuAI data).
- S3's import mapping is the inverse to round-trip against:
  - preset keys as named keys;
  - every proxy key as a `custom` named key bound by `reverse_proxy` profiles;
  - auxiliary slots as profiles;
  - translator and HypaV3 selections as list positions upstream.

  S6's round-trip test (export → decode → S3/S4 import) must hold for these.

- New `server/src/data/upstream/exportDatabase.ts`:
  - `buildUpstreamDatabase(rows, chats, options)` takes the rows of a staged `backupTo`
    copy, opened read-only, plus `{ promptPresetId, modelPresetId, personaId,
includeSecrets }`. It returns `{ db, assetKeys, report }`.
  - Reuse `loadJobScope`'s per-field steps (`server/src/jobs/jobScope.ts` ~223-306): the
    section loop, collection unpacking, `forwardPresetRoots`, the persona aliases and the
    character shell. Extract them into shared helpers where both can call them, and keep
    job-only logic out.
- **Presets** (D10). Build one upstream `botPreset` per prompt preset, in stored order:
  - copy the stored prompt fields (stored names, not root aliases);
  - set `aiModel`, `subModel` and `seperateModels` from the chosen model preset
    (`modelPresetRootValue`, `modelIdOfSlot`), plus the main profile's fields
    (`presetFieldValue`, excluding `modelId` and `credentialId`);
  - set `maxContext` from `maxContextOverrideOf(prompt)` or else the profile's;
  - strip `id`, `archived`, `maxContextOverride*` and `proxyCredentialId`.
  - The selected pair also fills the root fields (`forwardPresetRoots`), and
    `botPresetsId` is its index.
  - Report `converted: model-presets-flattened` with the model presets that are not
    exported. Upstream has no separate model presets; each prompt preset is exported with
    the chosen model preset.
  - Guarantee `botPresets.length >= 1`.
- **Personas.** `personas` as stored, minus metatron's `modules`. `selectedPersona` is the
  chosen persona's index, and the root persona fields come from it.
- **Characters and chats.** Each character gets `chats` in `chatOrders` order.
  - `chatPage` is 0, or the index of the chat the tab names (optional input).
  - Messages keep `chatId`; drop the `generation*` columns, and drop `translation` (D12).
  - Chat-level metatron fields (`pinned`, `memoryTrimAck`, `bindingReview`, `toolCalls`,
    `togglePresetId`, `promptPresetId`, `modelPresetId`, `translatorPresetId`,
    `autoTranslate`, `translateBotOnly`, `bilingual*`) are stripped (D12) and reported
    once.
  - A chat with toggles in `GLGlobalVariables` gets `useLocallySetGlobalVariables: true`.
  - Each chat gets `lastDate` from its newest message `time`, so upstream's first boot
    sends no recent chat to cold storage. Check the field upstream's
    `coldstorage.svelte.ts` (~453-483) actually reads.
- **Settings.** The sections and collections as `loadJobScope` builds them, plus
  `formatversion: 5`. Fill upstream-required shapes: `hotkeys` an array; `fallbackModels`
  absent; no `null` character. Then strip `DROPPED_FIELDS` and metatron-only settings,
  reported once.
- **Secrets** (D7). With `includeSecrets`, read the raw `llmSecrets` row and put the keys
  back:
  - the flat fields;
  - `customModels[].key` from each model's credential;
  - each exported preset's `openAIKey`/`proxyKey` from its main profile's credential.
  - Without `includeSecrets`, every key field is `""`, and the report says so.
- **Plugins and storage.** `plugins` as stored. In `pluginCustomStorage`, strip
  `_pluginStorage` and `_safeLocalPluginStorage`, since upstream keeps those in
  LocalForage. Report `excluded: plugin-storage` with the plugin names. No
  `_coldplugin`.
- **Inlays** (D8). Default: not exported. Count chats with `{{inlay*::id}}` references
  and report `excluded: inlays`. The text stays as it is.
- **Assets.** Collect `assets/...` keys from the exported records (the same walker as
  S4). A key absent on disk goes to `missing`.
- Encoding: S1's `encodeUpstreamDatabase`.
- Test (`server/src/tests/upstreamExport.test.ts`, node):
  - export → S1 decode → S3/S4 import → the same characters, chats, messages, prompt
    presets and personas (the round-trip check that S8 repeats against upstream);
  - `botPresets` is never empty;
  - the selected pair fills the root;
  - without `includeSecrets`, no key string from `llmSecrets` appears anywhere in the
    encoded bytes (search the decoded object and the raw buffer);
  - with it, the keys land in the root, the presets and `customModels`;
  - metatron chat fields are stripped; toggles set `useLocallySetGlobalVariables`;
  - plugin storage keys are stripped and reported;
  - inlay references are counted.
- Docs: `persistence.md` (the exporter as a reader of every kind).

_Landed_ (`adc90f97d`, merged as `ac5c6fd05`):

- **API**: `buildUpstreamDatabase(rows, chats, options)` returns `{ db, assetKeys, report }`
  (`server/src/data/upstream/exportDatabase.ts`). It is pure and synchronous. The options
  take `selectedChat: { characterId, chatId }` instead of `chatPage`, `hasAsset` to fill the
  `missing` list, and `now` for the trash times. The report types are in
  `shared/upstreamExportReport.ts`.
- **Shared helpers**: `loadJobScope`'s per-field steps moved into
  `server/src/data/databaseProjection.ts` (`mirrorSecrets`, `projectSections`,
  `projectCollections`, `forwardSelectedPreset`, `forwardPersonaRoots`, `characterShell`).
  `loadJobScope` calls them with unchanged behavior.
- **Checks**: 27 tests in `upstreamExport.test.ts`. The four character, chat, module and
  plugin round trips through S4's importer were left as `it.todo` until S4 merged, then
  enabled in `d9532709e`: each writes the converted result into a fresh staged store in S5's
  write order. A throwaway check (not committed) decoded a synthetic export with upstream's
  own decoder (msgpackr 1.10.1 `index-no-eval` and fflate), and the result matched exactly.
- **Follow-up `d9532709e`**:
  - The round trips found one exporter mismatch: a character or group without chats was
    exported with `chats: []`, while upstream reads `chats[chatPage]` unguarded. It now gets
    the empty first chat upstream's own creation makes (no id; upstream's boot assigns one).
  - One asset walker: `collectUpstreamAssetReferences(db)` moved to `assetReferences.ts`
    and walks an upstream `Database`. The importer's `collectAssetReferences(records)`
    places the stored records where upstream keeps them and calls it. One role type,
    `UpstreamAssetRole` in `shared/upstreamBackup.ts`. The merge fixed S4's missing
    GPT-SoVITS reference audio and S6's throw on a `null` entry. A round-trip assertion pins
    that import and export report the same keys, owners and roles.
- **Departures from this plan** (each checked against upstream `669b12ce`):
  - `lastDate`: upstream's cold storage runs only when `coldstorage` is on, which
    `setDatabase` sets by default when there are no plugins. A chat goes cold when the
    larger of `lastDate` and its message times is more than 10 days old, so raising
    `lastDate` adds nothing. It is kept. A character goes cold by its own
    `lastInteraction`, so that is raised to its newest chat.
  - Trash: upstream's boot deletes characters trashed more than 3 days ago. The export
    refreshes expired trash times so those characters survive the restore, and reports it.
  - Translator presets change shape, not just index: upstream rebuilds them as `{ name,
prompt, maxResponse }`. The export takes these from the first enabled step and reports
    lost steps and options.
  - Credentials: without `includeSecrets`, the export also blanks the auxiliary service
    keys in `secrets` (TTS, image, DeepL, embeddings), the characters' TTS keys and the MCP
    OAuth secrets. The version-2 export keeps all of these. A key typed into free text (a
    message, a lorebook) is exported as it is; refusing such an export was rejected.

## S7. Export routes and button (_small_, `backup-sync-hub.md`)

Depends: S5, S6.

Handed over from S6:

- The prepare body names the tab's chat as `selectedChat: { characterId, chatId }` (S6's
  option), not `chatPage`. The route passes `hasAsset` (an asset file exists on disk) and
  `now`.
- The "Include API keys?" question must say that it covers every key: without it, the
  auxiliary service keys, the characters' TTS keys and the MCP OAuth secrets are blanked
  too (S6 _Landed_).

- **Routes.**
  - `POST /api/backups/export-upstream/prepare` `{ promptPresetId, modelPresetId,
personaId, includeSecrets, selectedChat? }`:
    - `snapshots.exclusive(() => store.backupTo(stagingFile))`;
    - S6 on the copy;
    - the encoded bytes are written to staging under a token (same slot/TTL pattern);
    - the answer is `{ token, report }`.
  - `GET /api/backups/export-upstream/download?token=` streams one record per existing
    asset (basename = key without `assets/`), then `database.risudat`. Use `fileRecord` /
    `iteratorStream` and the `snapshots.track`/abort lifecycle of the version-2 export
    (`backups.ts` ~139-289). The token is freed at the end of the stream or on abort.
- **Client.**
  - A third button, "RisuAI-compatible backup", in `UserSettings.svelte` next to the two
    backup buttons.
  - It runs `flushResources` first, as `downloadArchive` does, then prepare with the tab's
    selection (read through the existing exported readers, not edited).
  - It asks "Include API keys?" (`alertConfirm`, default no), shows the report, and
    downloads through `LocalWriter` to `RisuAI-backup-<date>.bin`.
  - No manifest is read from the stream.
- Strings in `en.ts` (and `ko.ts`, D11).
- Test:
  - route (node): prepare → download yields a stream that `parseArchive` splits into the
    assets and a last `database.risudat` that S1 decodes; an expired token is a 404; an
    abort mid-stream frees the token;
  - `backuplocal.test.ts`: the flush runs before prepare, the keys question's answer is
    sent, and the writer gets the stream.
- Docs: `backup-sync-hub.md` (`Files`, `Flows`, `Recipes`), `self-host-server.md`
  `Routes`.

_Landed_ (S7 branch, one commit; `opus-lite`: Sol found two blocking issues and one minor, all fixed in one round):

- **Files**: `server/src/routes/backupsUpstreamExport.ts` (`createUpstreamExportStaging`,
  `registerUpstreamExportRoutes`), route paths, TTL, cap, request and answer types in
  `shared/upstreamExportReport.ts`; `upstreamAssetRecordName` in `server/src/data/upstream/archive.ts`;
  `listAssetKeys` exported from `backups.ts`; client `SaveUpstreamLocalBackup` and `streamToFile` in
  `backuplocal.ts`, `tabExportRequest`/`prepareUpstreamExport`/`downloadUpstreamExport`/`cancelUpstreamExport`
  in `upstreamBackupClient.ts`; `language.upstreamExport` in `en.ts` and `ko.ts`.
- **Slot decision**: the export stays out of S5's import slot. It writes nothing live (a `backupTo` copy
  under `snapshots.exclusive`, as the version-2 export, which takes no slot either), so it runs beside a
  waiting or running import. It has its own staging (10-minute TTL, at most 4 waiting or being prepared;
  a burst past that is refused before it copies the store).
- **Departures from this plan**:
  - A third route, `POST /api/backups/export-upstream/cancel` `{ token }` (204 always), used when the user
    declines the report, so a declined export does not hold a place for 10 minutes.
  - The download takes the token out when it starts: a second download, or one after an interrupted
    stream, is a 404 (prepare again).
  - Order in the tab: the keys question comes before the flush and the prepare, because its answer is a
    prepare parameter. The report is a confirmation ending in "Download it now?"; No cancels. The
    button keeps the sibling buttons' `backupConfirm` first.
  - The tab's selection is `tabSelectionIds()` (the tab's records, not the open chat's binding); the open
    chat is `currentChatRef()`. Both are read in `upstreamBackupClient.ts`, because `backuplocal.ts` also
    runs in a node-environment test that cannot load rune modules statically.
  - Asset records: a referenced key whose name no record can hold, or that upstream's restore would not
    read back as that asset (`/` or `\`, `database.risudat`, `encryption.risudat`, a cold-storage name,
    `manifest.json`/`resources.sqlite`, a leading BOM or lone surrogate that upstream's `TextDecoder`
    changes) gets no record and is reported under a new excluded code `asset-names`; a file that is no
    longer a regular file, or is over 4 GiB, is moved to `missing` after the projection. The report's
    `counts.assets` is the number of records written.
  - The staged store copy is removed as soon as it is projected; only `database.risudat` waits (with the
    keys when `includeSecrets` was chosen) until download, cancel, expiry, or shutdown.
  - 413 when the encoded database is over 4 GiB or the records exceed `MAX_ARCHIVE_RECORDS`.
- **For S8**: the prepare's `readSnapshot`, projection, and encoding run synchronously on the serving
  thread and hold the whole store in memory (Known Hazard in `self-host-server.md`); measure it on the real
  backup's store. The export of the real library can be produced with the button or the two routes; this
  server's own import reads an export back (route test), but upstream's `LoadLocalBackup` was not run.
- **Tests**: `server/src/tests/upstreamExportRoute.test.ts` (9, default suite: the layout and decode, keys
  only with `includeSecrets`, `asset-names`, the read-back through the upstream import, refusals and the
  cap, expiry under fake timers, a client leaving mid-download, the staging, the name rule) and 7
  `SaveUpstreamLocalBackup` cases in `backuplocal.test.ts`. Not tested: the client sending `selectedChat`
  (the fake inventory holds no open chat; the server side of `selectedChat` is tested), and shutdown during
  a prepare (Sol reproduced it against the code before its fix, in a throwaway script).
- **Not verified**: no browser check of the button, the dialogs, or the streamSaver download; no restore
  in upstream RisuAI (S8).

## S8. Compatibility checks and close-out (_small_, `backup-sync-hub.md`)

Depends: S1–S7.

- **Pinned upstream decoder check.** New `util/upstream/checkBinCompat.mjs` (not part of
  `pnpm test`):
  - it reads upstream's `risuSave.ts` decoder from a checkout given by `RISU_UPSTREAM_DIR`
    at a pinned commit (start with `669b12ce`, recorded in the script);
  - it runs that decoder on S7's export of the fixture library and on S1's encoder output,
    and compares the result with the input;
  - it runs upstream's `setDatabase` default pass, where it can be loaded without the
    browser, to check for throws.
  - Following RisuNest item 13, it never installs or starts the upstream app.
- **Manual browser checks** (`util/playwright`, one dev stack at a time):
  - a real upstream `.bin`: `save/Binary.bin` in the main checkout, which the user
    provided. It holds private data: read it in place, never copy it into a fixture,
    commit or log, and report counts only. Checked 2026-10-20:
    - **Container**: 3,399 records, ending exactly at the file's 332,626,296 bytes. They
      are 3,393 `.png` assets, 5 `coldstorage_<uuid>.json` records and one
      `database.risudat`.
    - **Database**: `\0RISUSAVE\0\x08` + gzip, 353,691 bytes compressed and about 1 MB
      decoded, with 292 root keys and `formatversion: 5`. It decodes with S1's settings
      (`Unpackr({ useRecords: false, int64AsType: "number" })`).
    - **Contents**: 6 characters, 5 of them cold stubs matching the 5 cold records; no
      group and no cold chat. Messages have no `chatId`. There are 4 `botPresets`, 1
      persona, 2 modules, no plugins, no `modelPresets` (made by upstream, not by
      metatron after Phase 3) and no `_coldplugin`.

    Check that the report matches these counts, that Restore brings the characters (cold
    ones included), chats, presets and assets back, and that a send works on an imported
    chat. Use a disposable save directory (`RISU_SAVE_DIR`), never the main checkout's
    `save/`. Then export it with S7 and import that export again: the counts must match;

  - an exported `.bin` restored in a local upstream dev build (the user's step if a local
    upstream build is not available), whose characters and chats open there.
  - Record what could not be checked as unverified.
- **Close-out.**
  - Update `docs/research/README.md`: RisuNest item 10 and Haejeok A14 are done.
  - Archive this plan as `docs/archived-plan/README.md` describes, with each slice's
    commit, the decisions taken and the leftovers.

## Verification

- Every slice: its tests, `pnpm check`, `pnpm --silent test:agent`, and the guide's focused
  checks. S5 and S7 also run `--tags-filter=slow` if they tagged anything.
- Run tests from the slice's own worktree. In the main checkout, add
  `--exclude ".claude/**"` (Vitest picks up nested worktrees, this plan's included).
- S5, S7, S8: the browser checks above.

## Decisions

The runner takes each default unless the user overrides it.

- **D1. Decode strategy and caps.** Options:
  - (a) whole-object decode in a per-import `worker_threads` worker (a thread of the
    server process). The caps are: decoded database 1 GiB (`RISU_MAX_UPSTREAM_DB_BYTES`),
    the worker heap through `resourceLimits`, cold record 64 MiB, and the existing
    `maxImportBytes` for the file. The worker also runs the first `readSnapshot`;
  - (b) the same on the request thread (simpler, but every request waits while a large
    database decodes);
  - (c) a streaming msgpack walker like Haejeok's `legacyStream.ts` (~1k lines).
  - S1 showed that nested MessagePack headers can allocate past the decoded-size cap, so
    (a)'s worker heap limit is required and (b) has no memory bound.
  - Default (a). It keeps the server responsive while a large database decodes, and (c)
    can follow if a real backup exceeds the cap.
- **D2. Group chats.** Options: (a) import them as groups (metatron supports groups);
  (b) drop them, as RisuNest does. Default (a).
- **D3. Cold-storage pointer without a payload.** Options:
  - (a) keep the stub or the chat without its messages, and report it;
  - (b) drop it;
  - (c) refuse the import.
  - Default (a).
- **D4. Selection after import.** Options: (a) the commit returns the upstream-selected
  prompt preset, model preset and persona ids, and the tab applies them before the
  reload; (b) none (each tab falls back to the first record). Default (a).
- **D5. Bindings of imported chats.** Options:
  - (a) bind each chat to the converted selected prompt and model preset, with
    `bindedPersona` when it exists and otherwise the selected persona; no review (the
    upstream behavior, where every chat uses the global selection);
  - (b) leave them unbound (the first send asks);
  - (c) bind and set `bindingReview`.
  - Default (a).
- **D6. Preset split.** Options:
  - (a) one prompt preset and one model preset per upstream preset, with profiles
    deduplicated by content;
  - (b) one prompt preset per upstream preset, and a model preset only per distinct
    model/profile pair (fewer model presets, but the names no longer match);
  - Default (a).
- **D7. API keys in the export.** Options: (a) ask at export time, default no; (b) never;
  (c) always. Default (a). Import always brings keys (U3).
- **D8. Inlays in the export.** Options:
  - (a) not exported, counted in the report;
  - (b) written as `inlay_<uuid>.<ext>` asset records (upstream restores them into
    `assets/`, where nothing references them);
  - (c) rewrite `{{inlay::id}}` to an asset image reference (lossy, and the text
    changes).
  - Default (a).
- **D9. Old formats accepted.** Options: (a) `\x07`, `\x08`, `\x09` and both cold-record
  name forms; (b) also the block format with REMOTE blocks (only live saves, not
  backups). Default (a).
- **D10. Model preset used for the export.** Options: (a) the tab's selected model preset
  for every exported preset; (b) per prompt preset, the model preset most chats bind it
  with. Default (a).
- **D11. Locales.** Options: (a) `en.ts` only (others fall back); (b) `en.ts` and `ko.ts`.
  Default (b): the report is long, user-facing text.
- **D12. metatron-only chat and message fields in the export.** Options: (a) strip them
  (upstream ignores them, but they would come back stale on a later import); (b) keep
  them. Default (a). `translation` (bilingual text) is included in the strip.
- **D13. Writes between prepare and commit.** Options:
  - (a) warn in the report dialog only; the commit replaces them (as the version-2 import
    does today), and the safety snapshot keeps them;
  - (b) the commit compares `store.writeCount()` with the value recorded at prepare. On
    a difference it answers `409 changedSinceReview` with the count, before maintenance,
    so no job is aborted. The user confirms and the commit is resent with
    `acceptWrites`;
  - (c) refuse outright and require a new prepare.
  - Default (b). Notes on the count:
    - `writeCount` counts committed resource writes (records, chats, messages, job
      writes), including ones made by the importing tab itself.
    - Asset file writes are not counted. They are never removed by an import, so nothing
      is lost there.

## Not in this plan

- Decrypting Risu Account backups (U4).
- Merge import (U3).
- PocketRisu-, RisuNest- or Haejeok-specific formats (chunk stores, `.risuinlay`, branch
  trees).
- An upstream-compatible partial backup.
- Upstream inlays: they are not in any upstream `.bin`. Reading them would need a
  separate upstream-side export.
- A resumable or chunked upload (Haejeok C1). The 4-hour request timeout and the 16 GiB
  cap still apply.
- Pinning upstream for the other cross-user formats (RisuNest item 13 beyond `.bin`).

## Leftovers

- S6, accepted minor issues (found by the Fable review):
  - Without keys, `authRefreshes` is written as `[]` even when the store had none.
  - A chosen slot whose credential no longer exists does not keep its field, so a later
    slot's key can take it.
- S3, accepted minor issues:
  - A repaired model-preset reference is reported by its generated id, not a name.
  - `loreBook: null` is reported, where upstream fills the default silently.
  - `autoTranslate` and `htmlTranslation` are reported as removed, although metatron keeps
    them per chat.
  - Rethrowing unexpected errors (S3 review fix 5) has no test, because it would need a
    private module mocked.
- S2: its 11 tests in `upstreamArchive.test.ts` were written after Sol's review and were not
  reviewed by Sol.
- S1: Docker image not rebuilt since the msgpackr pin (the Dockerfile is back to its
  pre-S1 state); native `msgpackr-extract` loading in the image is unverified. Real
  browsers and Vite's bundling of msgpackr 2.0.6 were not checked beyond `pnpm build`.
