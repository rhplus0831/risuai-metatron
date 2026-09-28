# Persistence: Database, Server Resources, Save Adapter

## Scope

- Owns:
  - the persisted DB model and its migrations,
  - how the in-memory `Database` maps onto the server resources (load, the save adapter, conflicts),
  - the browser-local data import and the list of stores that stay browser-local,
  - chat paging defaults.
- Paths: `src/ts/storage/*`, `src/ts/chatLoadPages.ts`, `shared/` (the persisted shapes; the meaning of a shape stays with the guide that owns its original module, e.g. `shared/triggers.ts` → `scripts-triggers.md`, `shared/llm.ts` → `llm-requests.md`), plus their tests.
- Not here:
  - The server side of the resources (store, routes, snapshots, archives) → `self-host-server.md`.
  - Backup and export UI → `backup-sync-hub.md`.
  - `saveDb` is exported from `src/ts/globalApi.svelte.ts` (see `global-api.md`); it only starts the adapter described here.

## Files

- `shared/`: the persisted shapes, compiled by both the client (`tsconfig.json`) and the server (`server/tsconfig.json`, strict). `database.ts` (`Database`, `character`, `groupChat`, `Chat`, `Message`, `MessageGenerationInfo`, `loreBook`, `customscript`, `botPreset`, `RisuPersona`, ...), `resources.ts` (resource kinds, `SINGLETON_RESOURCE_ID`, `ROOT_EXCLUDED_KEYS`, `RootResource`, `InlayResource`, `PluginPermissionGrants`, `RESOURCE_EPOCH_HEADER`, the route wire types, `BackupArchiveManifest`), `triggers.ts`, `prompt.ts`, `memory.ts`, `modules.ts`, `plugins.ts`, `settings.ts`, `openai.ts`, and `llm.ts` (the `LLMFlags`/`LLMFormat`/`LLMTokenizer` constants). Each old module re-exports its types, so importers keep their paths.
  - Rules: type declarations and plain `as const` objects only (no enums, namespaces, parameter properties, runes, or DOM types); imports only between `shared/` files, relative with a `.ts` extension, `import type` for types. Node runs these files directly in the server, and the `Dockerfile` runtime stage copies the folder.
- `src/ts/storage/database.svelte.ts`: DB helpers; re-exports the `shared/database.ts` types.
  - Normalization: `setDatabase` (defaults and migrations), `setDatabaseLite` (assign only).
  - Accessors: `getDatabase({snapshot?})`, `getCurrentCharacter`, `getCurrentChat`, `setCurrentChat`, `getCharacterByIndex`, `setCharacterByIndex` (marks the character for saving).
  - Presets: `saveCurrentPreset`, `changeToPreset`, `setPreset`, `downloadPreset`, `importPreset`.
  - Defaults: `presetTemplate`, `defaultAIN`, `defaultOoba`.
  - `appVer`.
- `src/ts/storage/resourceClient.ts`: transport for `/api/resources` and `/api/backups` (`readKinds`, `readRefs`, `getResource`, `putResource`, `deleteResource`, `applyBatchText`, `listBackups`, `restoreBackup`, `exportBackup`, `importBackup`). Sends the loaded epoch (`setResourceEpoch`) on every mutation, and checks the epoch every read answers with once one is loaded. Errors: `ResourceConflictError` (409, `conflicts`), `ResourceEpochMismatchError` (412, or a read from another epoch; the one listener set by `setEpochMismatchListener` runs first), `ResourceRequestError` (`status`, 0 = no response).
- `src/ts/storage/resourceSync.svelte.ts`: the save adapter. `seedResources`, `startResourceSync`, `markCharactersDirty`, `markCharacterDirtyAt`, `flushResources`, `setGeneratingCharacter`, `releaseDeferredCharacters`, `onRemoteRecordApplied`, and the `saving` state (`utf8ByteLength` and `splitBatches` are exported for tests).
- `src/ts/storage/browserLocalImport.ts` `importBrowserLocalData`: moves data older versions kept only in the browser to the server (see Flows); `sameLocalValue` is the Blob-aware equality it deletes by.
- `src/ts/storage/autoStorage.ts` `AutoStorage`: lazy wrapper that always uses `NodeStorage`. The client never runs without the self-host server (see `app-shell.md`). Only the `assets` namespace remains.
- `src/ts/storage/nodeStorage.ts` `NodeStorage`: the asset backend over `/api/read|write|list|remove`, with ES256 JWT auth; `authFetch` (any server route with a fresh `risu-auth`), `getNodeServerProxyAuth`, `digestPassword`. Setting the password on a fresh server also registers this browser's key; parallel requests share one auth check.
- `src/ts/storage/defaultPrompts.ts`: default main/jailbreak prompts.
- `src/ts/storage/exportAsDataset.ts`: exports chats and lore as `dataset.json`, unredacted.
- `src/ts/chatLoadPages.ts`: `normalizeChatLoadPages` (defaults: 30 initial pages, 15 additional).

## Flows

Resources (server kinds; `shared/resources.ts`):

- Singletons, id `main`: `root` (every `Database` field except `ROOT_EXCLUDED_KEYS`: `characters`, `botPresets`, `modules`, `plugins`, `pluginCustomStorage`), `presets` (`botPresets`), `modules`, `plugins`, `pluginStorage` (`pluginCustomStorage`), `pluginPermissions` (not in `Database`).
- Per record: `characters` (id = `chaId`, the whole character with all its chats until Phase 2 of `docs/plan/PLAN.md`), `inlays` (id = inlay id; see `chat-pipeline.md`).

Load (`bootstrap.ts:loadData`):

1. `readKinds` for every kind in one request (one committed state plus the epoch).
2. `seedResources` records each record's revision and JSON text before anything changes the data; `seedInlays` fills the inlay cache.
3. The `Database` is assembled: the `root` record (or `{}`), the four collections (an empty preset list gets `presetTemplate`), and the characters in store order (creation order).
4. `setDatabase`, `checkNewFormat`, and `assignIds` normalize as before.
5. `saveDb()` starts the adapter, which marks every collection and character once so the normalization is saved (unchanged records compare equal and are not sent).
6. `importBrowserLocalData`, `loadPluginPermissions`, then `loadPlugins`, then the UI flags.

Save (the adapter, `resourceSync.svelte.ts`):

1. `$effect` watchers mark collections dirty: the root fields, `botPresets` (deep), `modules`, `plugins`, `pluginCustomStorage`, and the selected character. A membership effect over the `chaId` list wakes the loop when a character is added or removed. Writers that change a character that is not selected call `markCharactersDirty` (plugin `setChar`, `setCharacterToIndex`, `setChatToIndex`, `setDatabase`/`setDatabaseLite` with `characters`, MCP character tools, `setCharacterByIndex`, and the end of a generation for the character it ran on).
2. After a 500 ms debounce one cycle runs (never two at once). Each dirty collection is serialized (`$state.snapshot` + `JSON.stringify`; a character without the per-chat `isStreaming`/`activeStreamingDisplayOptimizationMode` flags) and skipped when the text equals what the server holds. The `chaId` list is diffed against the saved characters: new ids are created, vanished ids deleted, duplicate ids renamed first.
3. Everything goes in one `POST /api/resources/batch` (one transaction on the server; split only above 5,000 operations or the 100 MiB body limit, measured in UTF-8 bytes; a single record over the limit is a permanent 413). On success the sent text becomes the saved text; a key marked again during the request stays dirty.
4. A network error, 5xx, or 429 retries with backoff (up to 30 s). A 400 or 413 alerts once and waits for the next change.
5. A 409 reads the conflicting records back (`readRefs`) and writes them into the mirror in place (root keys replaced, a collection replaced, a character replaced, inserted, or removed; the selected character removed → home screen). The local edits of those records are discarded and `resourceReloaded` is shown once per episode. When the server already holds exactly what was sent (a retry after a lost response), nothing is reloaded. The character a generation runs on (`setGeneratingCharacter`, wired by `bootstrap.ts`) is not swapped out: it is neither written nor deleted meanwhile, its reload runs inside a later cycle once the generation ends (`releaseDeferredCharacters` wakes the loop; a failed read retries with the cycle's backoff), and `flushResources` rejects while that character still has a pending edit. Every reloaded record is announced to `onRemoteRecordApplied` listeners (boot registers the inlay cache invalidation).
6. A 412 (the server was restored) stops saving, shows `resourceRestored`, and reloads the page. The transport runs the same halt for a 412 on any other resource request (inlays, permissions, a backup import) and for a read after boot that answers with another epoch.

`flushResources()` saves everything changed before the call and resolves when it is on the server, with the keys a conflict discarded; backup export and the browser-local import call it.

Browser-local import (`importBrowserLocalData`, every boot, before plugins load):

- LocalForage `inlay` (inlays, incl. old data-URI values), `plugin` (`safe_plugin_*` → `pluginCustomStorage._safeLocalPluginStorage`), `plugin_permissions` (→ the `pluginPermissions` record), `iris_dialogues`/`current_dialogue` (→ root `irisDialogue`), and `google-search-credentials`/`credentials`/`google-search-creds` (→ root `googleSearchCredentials`).
- Per entry: when the server already holds it, the server copy wins; otherwise it is written, read back from the server, and only then deleted locally. A local entry is deleted only while it still holds the value that was imported (`sameLocalValue`; another tab may have changed it). An inlay whose server metadata exists without its media file (a partially restored archive) is repaired from the local bytes when they are the file the metadata names, and kept in the browser otherwise. A value that is not plain JSON (plugin storage) stays in the browser. A failed step leaves its entries for the next boot. The `risuSaveCache` database and the `risuauth` `localStorage` key are removed.

Access:

- UI reads and mutates `DBState.db` reactively.
- Code that serializes, exports, syncs, or hands data to plugins should take `getDatabase({snapshot:true})` or `safeStructuredClone`.

Backend (`AutoStorage.Init`):

- Always `NodeStorage`, now only for assets. The block save format (`risuSave.ts`, `database/database.bin`, `dbbackup-*.bin`, remote `remotes/*` payloads, the `risuSaveCache`) and remote saving were removed in Phase 1 without a migration; the `save/database` and `save/remotes` folders of older versions are left on disk and no longer read.
- Browser-local stores that remain (rebuildable caches or device state): `hypaVector`, `LLMTranslateCache`, the Cache API `tfCache`, `firefox-translations-models`, `mcp-tool-calls`, the `strongBan_*` and `nightlyWarned` `localStorage` keys, the plugin `SafeLocalStorage` (`localStorage` `safe_plugin_*`, documented as device-specific), and `DPoPDB` (this browser's auth key pair; not user data).

Cold storage (removed):

- Cold storage was removed without a migration. Data it had offloaded (browser OPFS `coldstorage_<uuid>.json`, Node `coldstorage/<uuid>`) is no longer read, and those files are left on disk.
- Old saves may still hold skeleton characters with a stale `coldstorage` field and chats whose only message is a `COLDSTORAGE<uuid>` pointer. They load as ordinary characters and chats.

## State

- `Database` covers:
  - characters, prompts and templates,
  - provider keys and URLs, model/memory/translator/image/TTS settings,
  - `botPresets` + `botPresetsId`, `modules` + `enabledModules`, `personas` + `selectedPersona`, `plugins` + `pluginCustomStorage`,
  - `characterOrder`, `globalChatVariables`, `hotkeys`, `irisDialogue`, `googleSearchCredentials`.
- `character | groupChat`: groups have `type:'group'` and member `characters: string[]`. Both own `chats`, `chatPage`, and `chaId`.
- `Chat`:
  - `message`, `note`, `localLore`, `scriptstate` (keys prefixed with `$`), `modules`, `bindedPersona`, `fmIndex`, `id`,
  - memory fields: `supaMemoryData`, `hypaV2Data`, `hypaV3Data`,
  - `isStreaming`, bookmarks (the streaming fields are not saved).
- `Message`: `role` (`'user' | 'char'`), `data`, `chatId`, `time`, `saying`, `generationInfo`, `promptInfo`, `disabled`.
- `pluginCustomStorage` holds, at its top level, the custom DB properties that the plugin `setDatabase`/`setDatabaseLite` APIs route there (keys outside `allowedDbKeys`). Reserved keys: `_pluginStorage` (plugin `pluginStorage`, JSON-normalized on write) and `_safeLocalPluginStorage` (`getLocalPluginStorage()`, JSON values only).
- The adapter keeps plain maps (not runes): the saved revision and text of every record, dirty keys with a generation counter, and discarded keys.

## Coupling

- The chain is `DBState` → `resourceSync.svelte.ts` → `resourceClient.ts` → `authFetch` (`nodeStorage.ts`) → `/api/resources`. Assets go `forageStorage` (`globalApi`) → `AutoStorage` → `NodeStorage` → `/api/read|write|list|remove`.
- Callers:
  - `bootstrap.ts`: load, migrate, start saving, browser-local import.
  - `globalApi.saveDb`: starts the adapter.
  - `drive/backuplocal.ts` and `globalApi.loadInternalBackup`: backups (`flushResources`, the backup routes).
  - `characterCards.ts`: snapshots.
  - `plugins/apiV3/v3.svelte.ts`: plugin DB API (`markCharactersDirty`).
  - `plugins/apiV3/permissionStore.ts`, `process/files/inlays.ts`: their own resources through `resourceClient.ts`.

## Invariants

- Every loaded or imported DB passes through `setDatabase`. It also deletes the legacy Risu Account `account` token, the legacy `coldstorage` and `enableRemoteSaving` flags, and `pluginCustomStorage._coldplugin`. Initialize nested parents before assigning children (`??=`).
- `root` holds `Database` fields by exclusion (`ROOT_EXCLUDED_KEYS`). A new collection with a resource of its own needs the key there, a server kind (`server/src/data/kinds.ts`), the assembly in `bootstrap.ts`, a projection and watcher in `resourceSync.svelte.ts`, and the conflict reload in `applyToMirror`.
- There is no chat-granular resource until Phase 2. A chat change rewrites its whole character, and two tabs editing different chats of one character conflict and one reloads.
- The adapter watches only the selected character deeply. Code that changes another character calls `markCharactersDirty([chaId])` (or `markCharacterDirtyAt(index)`); additions and removals need nothing.
- Server data never becomes an outgoing write: the saved text is recorded from the server's own response, and a mirror reload records the text of the hydrated mirror (its own key order) before the watchers run, so a root another tab wrote with its keys in another order is not echoed back.
- Every mutation carries the loaded epoch; after a restore every write is refused until the page reloads. `pluginStorage` is serialized straight from the proxy (not through `$state.snapshot`, which drops an own `__proto__` key) because plugins choose its keys.
- Keep the logical asset key conventions (`assets/<name>`). They are on-disk names.
- Preset fields must be added consistently to `botPreset`, `presetTemplate`, `saveCurrentPreset`, `setPreset`, and `importPreset`. Secret fields must also be scrubbed in `downloadPreset`.
- `exportAsDataset` does no redaction. The settings report in `SettingsExportButtons.svelte` does (it also drops `irisDialogue`, `googleSearchCredentials`, and `pluginCustomStorage`).

## Recipes

- Add a persisted setting:
  1. Add the field to `Database` in `shared/database.ts`.
  2. Add a default or migration in `setDatabase`.
  3. If it is preset-owned, update the preset functions listed above.
  4. Verify by loading an old save: `getDatabase()` has the default after normalization, and the value survives a reload.
- Add a collection with its own resource: see the `root` invariant above. Verify a save, a reload, a two-tab conflict, and a backup round trip.
- Move more browser-local user data to the server: add a step to `importBrowserLocalData` that writes, reads back, and only then deletes the local entry.
- Change the asset backend: `AutoStorage.Init` and `NodeStorage`. Asset keys are logical, not file paths: the server maps `assets/<name>` to `save/assets/<encoded name>` and accepts no other namespace (see `self-host-server.md`).

## Tests

- `src/ts/chatLoadPages.test.ts`.
- `src/ts/storage/autoStorage.test.ts`: backend selection.
- `src/ts/storage/database.setDatabase.test.ts`: `setDatabase` drops the legacy `coldstorage` flag and `pluginCustomStorage._coldplugin` and leaves stale per-character cold pointers alone.
- `src/ts/storage/tests/fakeResourceServer.ts`: an in-memory stand-in for the resource routes (revisions, epoch fence, atomic batch with every conflict listed, body limit, hooks to hold a batch, drop an acknowledgement, fail requests, or run something before a batch applies). The four tests below and the inlay, permission-store, and import tests plug it in as `authFetch`.
- `src/ts/storage/tests/resourceSync.test.ts`: the save adapter on the real Svelte module (fresh module graph and fake timers per test): seeding and no echo, the boot compare pass, streaming flags stripped, dirty generations and edits during flight, the flush barrier, membership (create, delete, add during flight, duplicate ids), conflicts (reload, discard report, notice once, reordered root keys not echoed, partial batch resent, lost acknowledgement, remote delete moving the selection home, remote-change listeners), generation deferral (flush refused, reload in the cycle, failed reload retried, deferral by generating id), 412 from a batch, from a read, and from another consumer, permanent 413, retryable 5xx, UTF-8 batch sizing and the operation cap, an own `__proto__` key of the plugin storage.
- `src/ts/storage/tests/resourceClient.test.ts`: the epoch header on mutations only, single encoding of ids, typed errors, batch and single-route conflicts, the epoch-mismatch listener for 412 and for reads from another epoch, the boot read and a restore's new epoch accepted.
- `src/ts/storage/tests/browserLocalImport.test.ts`: every store moved, verified, and deleted; kept on a failed write, when the server holds it without its media (repaired when the bytes match), when another tab changed it meanwhile, or when it is not JSON; the server wins; the run continues after a failed step, drops the old caches, and stops on a restore; `sameLocalValue`.
- `src/ts/storage/tests/nodeStorage.test.ts`: the first run sets the password and registers the key with the same digest, an unknown key logs in once, a failed login alerts and throws, one check for parallel requests, `authFetch` signing.
- Server side of the resources: `server/src/tests/*` (see `self-host-server.md`).
- Not tested: the rest of the `setDatabase` migrations, `assembleDatabase` in `bootstrap.ts` (private; covered by the manual first-run and reload checks recorded in the phase file), and `AutoStorage` beyond backend selection.

## Known Hazards

- A character with all its chats is one resource and one request; one larger than the server's 100 MiB body limit cannot be saved (the adapter alerts). Phase 2 splits chats out.
- `NodeStorage.removeItem(string[])` hex-encodes each key separately and joins them with `$$`; the server validates every segment before deleting. A filesystem error mid-batch (e.g. a missing file) returns 500 and keeps earlier deletions.
- `getCurrentChat` has no snapshot option, unlike `getDatabase` and `getCurrentCharacter`.
- A tab does not see another tab's changes until it reloads or a conflict reloads that record (no live updates before Phase 6).
