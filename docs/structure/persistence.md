# Persistence: Database, Save Format, Storage Backends

## Scope

- Owns:
  - the persisted DB model and its migrations,
  - the save-file encoding,
  - the choice of storage backend per platform,
  - chat paging defaults.
- Paths: `src/ts/storage/*`, `src/ts/chatLoadPages.ts`, plus their tests.
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
   - every root key except `characters`, `botPresets`, `modules`, `plugins`, `pluginCustomStorage`,
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
  - `preset`, `modules`, `plugins`, `pluginStorage`, `config`.
  - One block per character.
- Remote characters are stored as `REMOTE` descriptor blocks. Their payload lives at `remotes/<chaId>.local.bin`.

Backend selection (`AutoStorage.Init`):

1. `NodeStorage`, when `isNodeServer`.
2. OPFS, when supported and the `opfs_flag!` flag is set.
3. Otherwise localforage `risuai` (IndexedDB).

- Risu Account sync was removed. A leftover `localStorage.accountst === 'able'` flag is ignored, so such a browser falls through to local storage.

Cold storage (removed):

- Cold storage was removed without a migration. Data it had offloaded (OPFS `coldstorage_<uuid>.json`, Node `coldstorage/<uuid>`) is no longer read, and those files are left on disk.
- Old saves may still hold skeleton characters with a stale `coldstorage` field and chats whose only message is a `\uEF01COLDSTORAGE\uEF01<uuid>` pointer. They load as ordinary characters and chats.

## State

- `Database` covers:
  - characters, prompts and templates,
  - provider keys and URLs, model/memory/translator/image/TTS settings,
  - `botPresets` + `botPresetsId`, `modules` + `enabledModules`, `personas` + `selectedPersona`, `plugins` + `pluginCustomStorage`,
  - `enableRemoteSaving`, `characterOrder`, `globalChatVariables`, `hotkeys`.
- `character | groupChat`: groups have `type:'group'` and member `characters: string[]`. Both own `chats`, `chatPage`, and `chaId`.
- `Chat`:
  - `message`, `note`, `localLore`, `scriptstate` (keys prefixed with `$`), `modules`, `bindedPersona`, `fmIndex`, `id`,
  - memory fields: `supaMemoryData`, `hypaV2Data`, `hypaV3Data`,
  - `isStreaming`, bookmarks.
- `Message`: `role` (`'user' | 'char'`), `data`, `chatId`, `time`, `saying`, `generationInfo`, `promptInfo`, `disabled`.
- `pluginCustomStorage` holds, at its top level, the custom DB properties that the plugin `setDatabase`/`setDatabaseLite` APIs route there (keys outside `allowedDbKeys`). Plugin `pluginStorage` values live under its reserved `_pluginStorage` key, JSON-normalized on write.

## Coupling

- The chain is `DBState` → `database.svelte.ts` helpers → `forageStorage` (in `globalApi`) → `AutoStorage` → backend.
- Callers:
  - `bootstrap.ts`: load and migrate.
  - `globalApi.saveDb`: save.
  - `drive/*` and `backuplocal.ts`: backups.
  - `characterCards.ts`: snapshots.
  - `plugins/apiV3/v3.svelte.ts`: plugin DB API.

## Invariants

- Every decoded or imported DB must pass through `setDatabase`. It also deletes the legacy Risu Account `account` token, the legacy `coldstorage` flag, and `pluginCustomStorage._coldplugin`. Initialize nested parents before assigning children (`??=`).
- `RisuSaveEncoder` serializes root fields by exclusion. If you add a new excluded collection, you must also add its encoder block, a `RisuSaveDecoder` case, a `toSaveType` field, and `saveDb` watchers. Otherwise the collection silently disappears.
- There is no chat-granular block. A chat change rewrites its whole character block.
- Only the selected character is tracked. When mutating other characters, set `requiresFullEncoderReload.state = true`. Imports and sync both do this or reselect.
- Remote character blocks are descriptors. Never delete `remotes/*` payloads while a descriptor references them.
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
- Change remote retention: `risuSave.ts` (`encodeRemoteBlock`, decoder). Nothing deletes orphaned `remotes/*.local.bin` payloads; the boot-time `cleanChunks` purge was removed together with cold storage.

## Tests

- `src/ts/chatLoadPages.test.ts`.
- `src/ts/storage/autoStorage.test.ts`: backend selection.
- `src/ts/storage/database.setDatabase.test.ts`: `setDatabase` drops the legacy `coldstorage` flag and `pluginCustomStorage._coldplugin` and leaves stale per-character cold pointers alone.
- Not tested: the rest of the `setDatabase` migrations, `RisuSaveEncoder`/`Decoder` compatibility, `saveDb` tracking, and any backend class.

## Known Hazards

- `NodeStorage.removeItem(string[])` hex-encodes each key separately and joins them with `$$`; the server validates every segment before deleting. A filesystem error mid-batch (e.g. a missing file) returns 500 and keeps earlier deletions.
- `getCurrentChat` has no snapshot option, unlike `getDatabase` and `getCurrentCharacter`.
