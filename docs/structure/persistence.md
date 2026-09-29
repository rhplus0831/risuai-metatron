# Persistence: Database, Server Resources, Save Adapter

## Scope

- Owns:
  - the persisted DB model and its migrations,
  - how the in-memory `Database` maps onto the server resources (load, the save adapter, conflicts),
  - the chat mutation module (every chat write, the generation lock, streaming checkpoints, per-tab chat selection),
  - the browser-local data import and the list of stores that stay browser-local,
  - chat paging defaults.
- Paths: `src/ts/storage/*`, `src/ts/chatLoadPages.ts`, `shared/` (the persisted shapes; the meaning of a shape stays with the guide that owns its original module, e.g. `shared/triggers.ts` → `scripts-triggers.md`, `shared/llm.ts` → `llm-requests.md`), plus their tests.
- Not here:
  - The server side of the resources (store, routes, snapshots, archives) → `self-host-server.md`.
  - Backup and export UI → `backup-sync-hub.md`.
  - `saveDb` is exported from `src/ts/globalApi.svelte.ts` (see `global-api.md`); it only starts the adapter described here.

## Files

- `shared/`: the persisted shapes, compiled by both the client (`tsconfig.json`) and the server (`server/tsconfig.json`, strict). `database.ts` (`Database`, `character`, `groupChat`, `Chat`, `Message`, `MessageGenerationInfo`, `loreBook`, `customscript`, `botPreset`, `RisuPersona`, ...), `resources.ts` (resource kinds, `SINGLETON_RESOURCE_ID`, `ROOT_EXCLUDED_KEYS`, `RootResource`, `InlayResource`, `PluginPermissionGrants`, `RESOURCE_EPOCH_HEADER`, the route wire types, `BackupArchiveManifest`), `chats.ts` (the chat wire contract: `ChatOp`, `MessageGeneration`, `ChatGroupResult`, `ChatRecord`, `ChatOrderRecord`, the chat conflicts, `CHAT_META_FORBIDDEN_KEYS`), `readonly.ts` (`DeepReadonly`), `triggers.ts`, `prompt.ts`, `memory.ts`, `modules.ts`, `plugins.ts`, `settings.ts`, `openai.ts`, and `llm.ts` (the `LLMFlags`/`LLMFormat`/`LLMTokenizer` constants). Each old module re-exports its types, so importers keep their paths.
  - Rules: type declarations and plain `as const` objects only (no enums, namespaces, parameter properties, runes, or DOM types); imports only between `shared/` files, relative with a `.ts` extension, `import type` for types. Node runs these files directly in the server, and the `Dockerfile` runtime stage copies the folder.
- `src/ts/storage/database.svelte.ts`: DB helpers; re-exports the `shared/database.ts` types.
  - Normalization: `setDatabase` (defaults and migrations), `setDatabaseLite` (assign only).
  - Accessors: `getDatabase({snapshot?})`, `getCurrentCharacter`, `getCurrentChat` (read-only), `getCharacterByIndex`, `setCurrentCharacter` (resolves the selected character by `chaId`)/`setCharacterByIndex` (by index) (replace a character's own fields, keep the mirror's chats, and mark it for saving). There is no chat setter: chats change through `chatStore.svelte.ts`.
  - Presets: `saveCurrentPreset`, `changeToPreset`, `setPreset`, `downloadPreset`, `importPreset`.
  - Defaults: `presetTemplate`, `defaultAIN`, `defaultOoba`.
  - `appVer`.
- `src/ts/storage/chatStore.svelte.ts`: the chat mutation module, the only writer of `character.chats` and `chatPage` (see Chats below).
  - Reads: `findChat(ref)` (read-only), `chatRef`, `currentChatRef`, `isMessageLocked`, `isChatGenerating` (both reactive: a lock lasts until its final write is acknowledged), `isCharacterGenerating`, `isStreamingMessage`/`streamingState` (the message the chat screen shows as streaming).
  - Chat membership and selection: `createChat`, `ensureChat`, `deleteChat`, `reorderChats`, `selectChat`, `syncChatPage`, `loadSelectionPreference`.
  - Messages and metadata: `appendMessage` (end, start, or after a message id), `replaceMessage`, `setMessageText`, `removeMessages`, `setChatMeta` (per-field set and unset), `replaceChat`; `captureChatBaseline` + `applyChatResult` apply a changed copy of a chat as by-id ops.
  - Generations: `beginGeneration`, `checkpointGeneration`, `checkpointAllGenerations`, `endGeneration`, `setStreamingState`, `hasRunningGenerations`, `unloadCheckpoint`, `trackUnloadCheckpoint`, `settleUnloadCheckpoint`.
  - Plugins and boot: `reconcileCharacterChats` (a whole chat list a plugin hands back), `normalizeNewCharacter` (chat and message ids for a character a plugin adds or swaps in, so its chats are addressable before the save loop adopts it), `seedChats`, `assembleChats`, `initializeChats`, `startChatDriftCheck` (dev only).
  - The save adapter's side: `takeChatWork`, `chatWorkBody`, `rebaseChatOrders`, `ackChatWork`, `requeueChatWork`, `quarantineChat`, `recoverChatConflicts`, `acceptRemoteChat`, `acceptRemoteCollection`, `deferredReloads`, `finishDeferredReload`, `adoptCharacter`, `forgetCharacter`, the obligation and discard reports.
- `src/ts/storage/chatEdits.ts`: helpers over the module for writers that work on a whole chat copy: `editChat` (may await), `editChatSync`, `editCurrentChat`, `setCurrentChatMeta`.
- `src/ts/storage/localLoreDraft.svelte.ts`: `useLocalLoreDraft`, the selected chat's local lorebook as an editable copy for the deep-bound lorebook editors, saved through `setChatMeta` on every change.
- `src/ts/storage/resourceClient.ts`: transport for `/api/resources` and `/api/backups` (`readKinds`/`readRefs` with `chats`/`chatCollections`, `getResource`, `putResource`, `deleteResource`, `applyBatchText`, `prepareUnloadAuth` + `sendBatchOnUnload` (a `keepalive` batch with a pre-signed token), `listBackups`, `restoreBackup`, `exportBackup`, `importBackup`). Sends the loaded epoch (`setResourceEpoch`) on every mutation, and checks the epoch every read answers with once one is loaded. Errors: `ResourceConflictError` (409, `conflicts`), `ResourceEpochMismatchError` (412, or a read from another epoch; the one listener set by `setEpochMismatchListener` runs first), `ResourceRequestError` (`status`, 0 = no response).
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
- Per record: `characters` (id = `chaId`, the character without `chats`, `chatPage`, and `reloadKeys`), `inlays` (id = inlay id; see `chat-pipeline.md`).
- Chats (their own tables, not a kind; see `self-host-server.md`): one chat per (`chaId`, chat id) with its metadata, its messages as rows keyed by message id, one revision per chat, and one chat order per character. They travel in the batch as `chats` groups of ops and `chatOrders`, and are read with `?chats=1` or `refs`/`chats`/`chatCollections`.

Load (`bootstrap.ts:loadData`):

1. `readKinds` for every kind and every chat in one request (one committed state plus the epoch).
2. `seedResources` records each record's revision and JSON text before anything changes the data; `seedChats` records each chat's and chat order's revision; `seedInlays` fills the inlay cache.
3. The `Database` is assembled: the `root` record (or `{}`), the four collections (an empty preset list gets `presetTemplate`), and the characters in store order (creation order). `assembleChats` puts each character's chats in its chat order (a chat missing from the order is appended, an order entry without a chat is skipped, both logged).
4. `setDatabase`, `checkNewFormat`, and `assignIds` (character ids only) normalize as before. `initializeChats` selects each character's remembered chat (`localStorage` preference) and gives a character without chats a new one.
5. `saveDb()` starts the adapter, which marks every collection and character once so the normalization is saved (unchanged records compare equal and are not sent).
6. `importBrowserLocalData`, `loadPluginPermissions`, then `loadPlugins`, then the UI flags.

Save (the adapter, `resourceSync.svelte.ts`):

1. `$effect` watchers mark collections dirty: the root fields, `botPresets` (deep), `modules`, `plugins`, `pluginCustomStorage`, and the selected character's own fields (not its chats). Chat writes reach the loop through the chat module's work listener. A membership effect over the `chaId` list wakes the loop when a character is added or removed. Writers that change a character that is not selected call `markCharactersDirty` (plugin `setChar`, `setCharacterToIndex`, `setDatabase`/`setDatabaseLite` with `characters`, MCP character tools, `setCharacterByIndex`, a send's `lastInteraction` stamp, and the end of a generation for the character it ran on; plugin `setChatToIndex` goes through the chat module).
2. After a 500 ms debounce one cycle runs (never two at once). Each dirty collection is serialized (`$state.snapshot` + `JSON.stringify`; a character without `chats`, `chatPage`, and `reloadKeys`) and skipped when the text equals what the server holds. The `chaId` list is diffed against the saved characters: new ids are created, vanished ids deleted, duplicate ids renamed first.
3. Everything goes in one `POST /api/resources/batch` with the chat module's unsent work (`takeChatWork`: per chat one group of ops on the chat revision it was based on, plus reorders; one transaction on the server; split only above 5,000 operations or the 100 MiB body limit, measured in UTF-8 bytes, a chat's group never split inside a request; a chat with more than 5,000 unsent ops sends them over several cycles; a single record over the limit is a permanent 413). A chat created with its character travels in the same request as the character. On success the sent text becomes the saved text and `ackChatWork` records the chat revisions; a key marked again during the request stays dirty.
4. A network error, 5xx, or 429 retries with backoff (up to 30 s); a chat create whose answer was lost is resent and recognized when the server already holds it. A 400 that names one chat group (`chats[i]...`) quarantines that chat (one alert; its later edits are not sent) and resends the rest (a chat group over the body limit is quarantined client-side before any request); any other 400 or 413 alerts once and waits for the next change.
5. A 409 reads the conflicting records back (`readRefs`) and writes them into the mirror in place (root keys replaced, a collection replaced, a character replaced, inserted, or removed; the selected character removed → home screen). The local edits of those records are discarded and `resourceReloaded` is shown once per episode. When the server already holds exactly what was sent (a retry after a lost response), nothing is reloaded. A chat conflict (`recoverChatConflicts`) reads the chat back: by-id work that the server can still apply is kept, the rest is discarded with the notice, and a chat with a running generation is reloaded only once the generation ends (`isChatDeferred`). The character a generation runs on (`setGeneratingCharacter`, wired by `bootstrap.ts`) is not swapped out: it is neither written nor deleted meanwhile, its reload runs inside a later cycle once the generation ends (`releaseDeferredCharacters` wakes the loop; a failed read retries with the cycle's backoff), and `flushResources` rejects while that character still has a pending edit. Every reloaded record is announced to `onRemoteRecordApplied` listeners (boot registers the inlay cache invalidation).
6. A 412 (the server was restored) stops saving, shows `resourceRestored`, and reloads the page. The transport runs the same halt for a 412 on any other resource request (inlays, permissions, a backup import) and for a read after boot that answers with another epoch.

`flushResources()` checkpoints running generations, saves everything changed before the call (including queued chat work), and resolves when it is on the server, with the keys a conflict discarded (`chats/<chaId>/<chatId>` for chats); backup export and the browser-local import call it.

Chats (`chatStore.svelte.ts`):

- Every chat write goes through the module: it updates the mirror, bumps the chat's local version, and queues an op; ops of one chat coalesce (text writes, meta patches, end appends) until the save loop takes them. `character.chats` and `chatPage` are typed read-only (`DeepReadonly`), so a direct assignment, `push`, or `splice` fails `pnpm check`; `bind:` on a chat field does not, so components bind through getter/setter pairs or a synced editing copy (HypaV3 modal, local lore draft).
- Ops address messages by `Message.chatId`, never by index. By-id ops (`append`, `setMessage`, `setText`, single `remove`, `meta`) apply to a stale chat revision while their message exists; `replace`, `delete`, bulk `remove`, reorders, and a `begin` of an unknown generation need the current revision. A result applied on an older revision says `stale: true` and keeps the older base, so the next revision-bound op conflicts and reloads.
- Selection is per tab: the module keeps the selected chat id per character, derives `chatPage` from it after every create, delete, reorder, and reload, and remembers the last selection in `localStorage` as a preference for the next boot (not synchronized live between tabs).
- Whole-chat writers (triggers, Lua `setFullChat`, plugin setters, `editChat`) capture a baseline and call `applyChatResult`: the changed copy is diffed three ways against the baseline and the chat as it is now, and applied as by-id ops, with `replaceChat` only when a diff cannot express it. Changes made meanwhile by others are kept.
- Generation lock: `beginGeneration` locks the reply message (the server fences it with the generation id); only writes carrying that generation id may change or remove it until the final text is acknowledged or discarded. The module checkpoints the text every three seconds; `endGeneration` queues the final text. A server answer `ignored` stops the generation's saving; `duplicate` keeps it. A new generation may take over a message whose previous generation is ending (continue).
- Unload: while a generation runs, the save loop keeps a signed token ready; on `pagehide` it sends one `keepalive` batch with the whole current text of each running generation the server already knows, only while the body fits 60 KiB (whole or nothing, never a suffix); a chat with a request in flight is skipped. Its groups count as in flight until the answer settles them (`settleUnloadCheckpoint`: the ordinary revision rule, so a page that survives in the back-forward cache does not conflict with its own write) or the request fails. Best effort; the durability promise is the last acknowledged checkpoint.

Browser-local import (`importBrowserLocalData`, every boot, before plugins load):

- LocalForage `inlay` (inlays, incl. old data-URI values), `plugin` (`safe_plugin_*` → `pluginCustomStorage._safeLocalPluginStorage`), `plugin_permissions` (→ the `pluginPermissions` record), `iris_dialogues`/`current_dialogue` (→ root `irisDialogue`), and `google-search-credentials`/`credentials`/`google-search-creds` (→ root `googleSearchCredentials`).
- Per entry: when the server already holds it, the server copy wins; otherwise it is written, read back from the server, and only then deleted locally. A local entry is deleted only while it still holds the value that was imported (`sameLocalValue`; another tab may have changed it). An inlay whose server metadata exists without its media file (a partially restored archive) is repaired from the local bytes when they are the file the metadata names, and kept in the browser otherwise. A value that is not plain JSON (plugin storage) stays in the browser. A failed step leaves its entries for the next boot. The `risuSaveCache` database and the `risuauth` `localStorage` key are removed.

Access:

- UI reads and mutates `DBState.db` reactively, except chats: they are read from the mirror and changed through `chatStore.svelte.ts` (or `chatEdits.ts`).
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
- `character | groupChat`: groups have `type:'group'` and member `characters: string[]`. Both own `chats` and `chatPage` (read-only mirror fields, not part of the character record) and `chaId`.
- `Chat`:
  - `message`, `note`, `localLore`, `scriptstate` (keys prefixed with `$`), `modules`, `bindedPersona`, `fmIndex`, `id`,
  - memory fields: `supaMemoryData`, `hypaV2Data`, `hypaV3Data`,
  - bookmarks, `folderId`, `suggestMessages`, `lastMemory`,
  - `isStreaming`/`activeStreamingDisplayOptimizationMode` remain in the type for old data but are never stored; the streaming message is `streamingState` (`chaId`, `chatId`, `messageId`, `mode`).
- `Message`: `role` (`'user' | 'char'`), `data`, `chatId` (the message id, unique in its chat; assigned by the module), `time`, `saying`, `generationInfo`, `promptInfo`, `disabled`.
- `pluginCustomStorage` holds, at its top level, the custom DB properties that the plugin `setDatabase`/`setDatabaseLite` APIs route there (keys outside `allowedDbKeys`). Reserved keys: `_pluginStorage` (plugin `pluginStorage`, JSON-normalized on write) and `_safeLocalPluginStorage` (`getLocalPluginStorage()`, JSON values only).
- The adapter keeps plain maps (not runes): the saved revision and text of every record, dirty keys with a generation counter, and discarded keys. The chat module keeps per chat its revision, unsent and in-flight ops, local version, generation locks, deferred and quarantined chats, and per character the selection and chat order revision.

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
- Chats are their own records: two tabs editing different chats, or different messages of one chat, save independently. A chat change never rewrites its character.
- Only `chatStore.svelte.ts` writes `character.chats` and `chatPage` (the module's `writable` view). Code that holds a changed copy of a chat applies it with `applyChatResult` (or `chatEdits.ts`); code that changes a chat field calls `setChatMeta`.
- A message being generated is changed only by its generation. Other writers get an error from the module (`Chat.svelte` disables that message's edit, partial edit, delete, disable, and regenerate controls from `isMessageLocked` and checks every affected id again when the write is made (a delete-from-here that reaches a locked reply alerts), which also covers a finished reply whose final write is not yet acknowledged and a previous group speaker's reply; reroll and chat deletion check `isChatGenerating` and alert `chatGenerating`).
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
- `src/ts/storage/tests/storeBackedServer.ts`: an `authFetch` stand-in over the real server store (`createResourceStore`, SQLite in memory), loaded at run time; `chatStore.test.ts` (the module: coalescing, detached inputs, ids, locks, selection, three-way apply, boot assembly, plugin reconciliation) and `resourceSyncChats.test.ts` (the save loop's chat paths: creates with their character, lost acknowledgements, conflicts and deferral, quarantine, op-cap splitting, the flush barrier) run against it.
- `src/ts/storage/tests/resourceClient.test.ts`: the epoch header on mutations only, single encoding of ids, typed errors, batch and single-route conflicts, the epoch-mismatch listener for 412 and for reads from another epoch, the boot read and a restore's new epoch accepted.
- `src/ts/storage/tests/browserLocalImport.test.ts`: every store moved, verified, and deleted; kept on a failed write, when the server holds it without its media (repaired when the bytes match), when another tab changed it meanwhile, or when it is not JSON; the server wins; the run continues after a failed step, drops the old caches, and stops on a restore; `sameLocalValue`.
- `src/ts/storage/tests/nodeStorage.test.ts`: the first run sets the password and registers the key with the same digest, an unknown key logs in once, a failed login alerts and throws, one check for parallel requests, `authFetch` signing.
- Server side of the resources: `server/src/tests/*` (see `self-host-server.md`).
- Not tested: the rest of the `setDatabase` migrations, `assembleDatabase` in `bootstrap.ts` (private; covered by the manual first-run and reload checks recorded in the phase file), and `AutoStorage` beyond backend selection.

## Known Hazards

- One chat group larger than the server's 100 MiB body limit cannot be saved (the adapter quarantines the chat and alerts).
- `NodeStorage.removeItem(string[])` hex-encodes each key separately and joins them with `$$`; the server validates every segment before deleting. A filesystem error mid-batch (e.g. a missing file) returns 500 and keeps earlier deletions.
- `getCurrentChat` returns the live read-only mirror chat; take `$state.snapshot` before handing it to code that mutates.
- Folder moves touch the character (`chatFolders`), the chat (`folderId`), and the chat order; a conflict on one of them can leave them inconsistent until a reload.
- A chat quarantined after a 400 stops saving for the rest of the session; `flushResources` then rejects after its retry cycles.
- Generation locks are per client: another device can still edit a message this tab is generating (the server fence makes the later writer win per message).
- A tab does not see another tab's changes until it reloads or a conflict reloads that record (no live updates before Phase 6).
