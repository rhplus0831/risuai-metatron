# Persistence: Database, Save Format, Storage Backends, Cold Storage

## Scope
- Owns:
  - the persisted DB model and its migrations,
  - the save-file encoding,
  - the choice of storage backend per platform,
  - cold storage (offloading old chats and characters),
  - chat paging defaults.
- Paths: `src/ts/storage/*`, `src/ts/process/coldstorage.svelte.ts`, `src/ts/process/coldstorageData.ts`, `src/ts/chatLoadPages.ts`, plus their tests.
- Not here:
  - The `saveDb` loop implementation lives in `src/ts/globalApi.svelte.ts` (see `global-api.md`), but its persistence rules are listed below.
  - Backup and sync exports → `backup-sync-hub.md`.
  - Node server storage routes → `self-host-server.md`.

## Files
- `src/ts/storage/database.svelte.ts`: canonical types and DB helpers.
  - Types: `Database`, `character`, `groupChat`, `Chat`, `Message`, `MessageGenerationInfo`, `loreBook`, `customscript`, `botPreset`, `RisuPersona`.
  - Normalization: `setDatabase` (defaults and migrations), `setDatabaseLite` (assign only).
  - Accessors: `getDatabase({snapshot?})`, `getCurrentCharacter`, `getCurrentChat`, `setCurrentChat`.
  - Presets: `saveCurrentPreset`, `changeToPreset`, `setPreset`, `downloadPreset`, `importPreset`.
  - Defaults: `presetTemplate`, `defaultAIN`, `defaultOoba`.
  - `appVer`.
- `src/ts/storage/risuSave.ts`: save codecs.
  - Current: `RisuSaveEncoder` (block format, `init`/`set`/`encode`), `RisuSaveDecoder`.
  - Legacy: `encodeRisuSaveLegacy`, `encodeRisuSaveCompressionStream`.
  - `decodeRisuSave` detects every format.
  - `toSaveType`: the change-tracker shape.
- `src/ts/storage/autoStorage.ts` `AutoStorage`: the backend selector, plus the one-time localforage-to-OPFS migration.
- `src/ts/storage/nodeStorage.ts` `NodeStorage`: the Node server backend over `/api/read|write|list|remove`, with ES256 JWT auth. Also exports `getNodeServerProxyAuth` and `digestPassword`.
- `src/ts/storage/opfsStorage.ts` `OpfsStorage`: OPFS backend with hex-encoded file names.
- `src/ts/storage/persistant.ts`: persistent-storage request helpers. No callers.
- `src/ts/storage/defaultPrompts.ts`: default main/jailbreak prompts.
- `src/ts/storage/exportAsDataset.ts`: exports chats and lore as `dataset.json`, unredacted.
- `src/ts/process/coldstorage.svelte.ts`:
  - `makeColdData`: evicts characters and chats unused for 10 days, in batches of 5.
  - `preLoadChat`: restores a chat when it is opened.
  - `getColdStorageItem`/`setColdStorageItem`.
  - `collectColdStorageBackupPayloads`.
  - `migratePluginStorageToColdStorage`.
- `src/ts/process/coldstorageData.ts`: pure helpers.
  - `coldStorageHeader`: the pointer prefix.
  - `listColdDataKeysFromDb`, `isColdStorageBackupData`.
- `src/ts/chatLoadPages.ts`: `normalizeChatLoadPages` (defaults: 30 initial pages, 15 additional).

## Flows
Load:
1. `bootstrap.ts:loadData` reads `database/database.bin` from `forageStorage`.
2. `decodeRisuSave` decodes it.
3. `setDatabase` normalizes the result. If decoding fails, `loadData` walks `database/dbbackup-*.bin` newest first but does not stop at the first success, so the oldest readable retained backup ends up loaded.

Access:
- UI reads and mutates `DBState.db` reactively.
- Code that serializes, exports, syncs, or hands data to plugins should take `getDatabase({snapshot:true})` or `safeStructuredClone`.

Save (`globalApi.svelte.ts:saveDb`):
1. `$effect` watchers snapshot:
   - every root key except `characters`, `botPresets`, `modules`, `loadouts`, `plugins`, `pluginCustomStorage`,
   - each of those dedicated collections separately,
   - only the selected character (`selIdState`) and its current chat.
2. Changes are debounced 500 ms and polled.
3. `RisuSaveEncoder.set(db, tracker)` re-encodes the changed blocks. `requiresFullEncoderReload.state` forces a fresh `init`.
4. The encoded bytes are written to `database/database.bin`, then a `database/dbbackup-<ts>.bin` backup (at most 20 kept).

Block format:
- The file starts with the `RISUSAVE\0` magic, followed by typed blocks.
- Each block is: type, compression flag, name length, name, payload length, payload.
- Blocks:
  - `root`: plain keys plus a `__directory`.
  - `preset`, `modules`, `loadouts`, `plugins`, `pluginStorage`, `config`.
  - One block per character.
- Remote characters are stored as `REMOTE` descriptor blocks. Their payload lives at `remotes/<chaId>.local.bin`.

Backend selection (`AutoStorage.Init`):
1. `NodeStorage`, when `isNodeServer`.
2. OPFS, when supported and the `opfs_flag!` flag is set.
3. Otherwise localforage `risuai` (IndexedDB).
- Risu Account sync was removed. A leftover `localStorage.accountst === 'able'` flag is ignored, so such a browser falls through to local storage.

Cold storage:
- Evicting a character writes the full `{character}` payload out, then replaces the DB entry with a skeleton.
- Evicting a chat writes `{message, hypaV2Data, hypaV3Data, scriptstate, localLore}` out and leaves a one-message pointer whose data is `coldStorageHeader + uuid`.
- Restore happens in `characters.ts:changeChar` for whole characters and in `preLoadChat` (called by `DefaultChatScreen`) for chats.

## State
- `Database` covers:
  - characters, prompts and templates,
  - provider keys and URLs, model/memory/translator/image/TTS settings,
  - `botPresets` + `botPresetsId`, `modules` + `enabledModules`, `personas` + `selectedPersona`, `plugins` + `pluginCustomStorage`, `loadouts`,
  - `coldstorage`, `enableRemoteSaving`, `characterOrder`, `globalChatVariables`, `hotkeys`.
- `character | groupChat`: groups have `type:'group'` and member `characters: string[]`. Both own `chats`, `chatPage`, `chaId`, and optional `coldstorage`.
- `Chat`:
  - `message`, `note`, `localLore`, `scriptstate` (keys prefixed with `$`), `modules`, `bindedPersona`, `fmIndex`, `id`,
  - memory fields: `supaMemoryData`, `hypaV2Data`, `hypaV3Data`,
  - `isStreaming`, bookmarks.
- `Message`: `role` (`'user' | 'char'`), `data`, `chatId`, `time`, `saying`, `generationInfo`, `promptInfo`, `disabled`.
- Cold storage key conventions differ by platform and are part of the format:
  - Node: `coldstorage/<key>`.
  - OPFS: `coldstorage_<key>.json`.
- Plugin cold storage is `pluginCustomStorage._coldplugin`, mapping key to UUID.

## Coupling
- The chain is `DBState` → `database.svelte.ts` helpers → `forageStorage` (in `globalApi`) → `AutoStorage` → backend.
- Callers:
  - `bootstrap.ts`: load and migrate.
  - `globalApi.saveDb`: save.
  - `drive/*` and `backuplocal.ts`: backups.
  - `characterCards.ts` and `sync/multiuser.ts`: snapshots.
  - `plugins.svelte.ts`: DB API.
  - `characters.ts`: cold restore.
  - `DefaultChatScreen.svelte`: `preLoadChat`.

## Invariants
- Every decoded or imported DB must pass through `setDatabase`. It also deletes the legacy Risu Account `account` token. Initialize nested parents before assigning children (`??=`).
- `RisuSaveEncoder` serializes root fields by exclusion. If you add a new excluded collection, you must also add its encoder block, a `RisuSaveDecoder` case, a `toSaveType` field, and `saveDb` watchers. Otherwise the collection silently disappears.
- There is no chat-granular block. A chat change rewrites its whole character block.
- Only the selected character is tracked. When mutating other characters, set `requiresFullEncoderReload.state = true`. Imports, cold eviction, and sync all do this or reselect.
- Remote character blocks are descriptors. Never delete `remotes/*` payloads while a descriptor references them.
- Cold storage replaces data with a pointer only after a write followed by a read-back verification. After eviction, set `requiresFullEncoderReload`. New payload shapes must keep `isColdStorageBackupData` passing.
- Keep the logical key names and the platform key conventions. They are on-disk formats.
- Preset fields must be added consistently to `botPreset`, `presetTemplate`, `saveCurrentPreset`, `setPreset`, and `importPreset`. Secret fields must also be scrubbed in `downloadPreset`.
- `exportAsDataset` does no redaction. The settings report in `SettingsExportButtons.svelte` does.

## Recipes
- Add a persisted setting:
  1. Add the field to `Database`.
  2. Add a default or migration in `setDatabase`.
  3. If it is preset-owned, update the preset functions listed above.
  4. Verify by loading an old save: `getDatabase()` has the default after normalization.
- Add a split save collection: `RisuSaveEncoder.init/set`, `RisuSaveDecoder.decode`, `toSaveType`, and the `saveDb` watchers. Verify an encode/decode round trip, an incremental update, and a backup restore.
- Change backend selection: `AutoStorage.Init` and the backend class. Keep logical keys.
- Change cold eviction: `makeColdData`, `makeColdDataForCharacter`/`makeColdDataForChat`, `preLoadChat`, `characters.ts:changeChar`, and `coldstorageData.ts`.
- Change remote retention: `risuSave.ts` (`encodeRemoteBlock`, decoder) and `bootstrap.ts:cleanChunks`, which gives orphaned `remotes/*.local.bin` payloads a seven-day grace period through a `.meta` `lastUsed` file.

## Tests
- `src/ts/process/coldstorageData.test.ts`.
- `src/ts/chatLoadPages.test.ts`.
- Not tested: `setDatabase` migrations, `RisuSaveEncoder`/`Decoder` compatibility, `saveDb` tracking, `AutoStorage` selection, and any backend class.

## Known Hazards
- `NodeStorage.removeItem(string[])` hex-encodes the `$$`-joined keys, and the server then splits the hex string on `$$`. Batch removal therefore targets one nonexistent combined filename. Fix the client and server together.
- `getCurrentChat` has no snapshot option, unlike `getDatabase` and `getCurrentCharacter`.
