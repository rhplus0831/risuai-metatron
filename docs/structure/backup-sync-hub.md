# Backups, Realm Hub

## Scope

- Owns:
  - local `.bin` backup export and import (full and partial) and the server snapshot restore button, as client UI over
    the server backup routes,
  - Realm hub browse and download (upload, report, and remove were removed),
  - the settings report export.
- Paths:
  - `src/ts/drive/*` (the folder name is historical; Google Drive sync, Risu Account sync, and Kei auto-backup were
    removed)
  - `src/ts/realmBlocking.ts` (creator block-list rules used by the Realm UI and card entry points)
  - `src/ts/realmTerms.ts` (the RisuRealm terms acceptance every Realm entry point awaits)
  - `src/lib/UI/Realm/*`
  - `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`
- Not here:
  - The save adapter → `resource-sync.md`; resources → `persistence.md`.
  - The archive format, snapshots, and the backup routes → `server-resources.md`.
  - Hub URL and card codecs → `characters-modules.md` (`characterCards.ts`).
  - Node `/hub-proxy` → `self-host-server.md`.
  - `localNetwork.ts` → `global-api.md`.

## Files

- `drive/backuplocal.ts` (the server builds and reads the archive; see `server-resources.md`):
  - `SaveLocalBackup`: `flushResources`, then `POST /api/backups/export` (every asset on the server, inlays included,
    plus a snapshot of the resources), streamed to a file through `LocalWriter.write`. The manifest (first record) is
    read from the stream head; assets the database references but the archive lacks are reported.
    - When the pre-backup flush replaced a local change (`flushResources`' `discarded` is non-empty: another writer's
      version is what the archive holds), a warning (`backupDiscardedChanges`) is in the success alert or ahead of the
      missing-asset list; the reload notice, in its own store, also stays above the progress alerts.
    - Full and partial exports also carry the flush’s `refused` keys: the archive is still produced, and the report
      names each refused item with the refusal banner’s labels (ids when names are missing) and warns that it holds the
      server’s copy without those local changes (`backupRefusedChanges`).
  - `SavePartialLocalBackup`: two confirmations first (`partialBackupFirstConfirm`, `partialBackupSecondConfirm`; either
    refusal stops it), then the same with `{ partial: true }`.
    - The server selects character/group profile images, persona icons (including the selected user icon), background,
      folder images, and preset images from the resource snapshot it archives (no inlays, emotion images, additional
      assets, VITS, or CC assets). `shared/backups.ts` `selectPartialBackupAssets` defines these categories for both
      sides; the client's `partialAssets` uses it only to label the manifest's `missing` entries. A key absent from the
      client's inventory is reported as "Unknown Asset".
  - `SaveUpstreamLocalBackup` ("RisuAI-compatible backup"): a `.bin` upstream RisuAI's "Load Backup" restores. See
    Flows. It shares `streamToFile` (the `LocalWriter` loop with the size wait text, cancel and abort on failure) with
    `downloadArchive`, and names the file `upstreamBackupFileName()` (`RisuAI-backup-YYYY-MM-DD.bin`, local date).
  - `LoadLocalBackup`: reads the chosen file's first record name (`readFirstRecordName`, from
    `file.slice(0, 4 + 4096)`). `manifest.json` (a version-2 archive): posts the `File` to `POST /api/backups/import`
    and reloads. Anything else goes to the upstream import (`upstreamBackupClient.ts`, loaded on demand): upstream
    RisuAI backups and metatron's older upstream-format backups (`database.risudat`), which the compatibility rule
    (`persistence.md` Invariants) owes a one-way migration.
- `drive/upstreamBackupClient.ts` (routes in `server-resources.md`):
  - `prepareUpstreamImport(file, onProgress)` (the file as the body with the tab's epoch, through
    `serverImportClient.ts` `importOverServer`; its `readResult` reads each `{ phase, done, total }` line's phase).
  - `commitUpstreamImport(token, acceptWrites?)` (`{ committed }`, or `{ changedWrites }` for the server's
    `409 changedSinceReview`; a 412 goes through `epochMismatch`).
  - `cancelUpstreamImport(token)` (best effort), and `restoreUpstreamBackup(file)`, the flow below.
  - The export side (`server/src/routes/backupsUpstreamExport.ts`): `tabExportRequest(includeSecrets)`,
    `prepareUpstreamExport(request)` (`{ token, report }`), `downloadUpstreamExport(token)` (the response, the token
    used up), `cancelUpstreamExport(token)` (best effort); a refusal is `UpstreamExportRequestError` (status and the
    server's text).
- `lib/Setting/Pages/UpstreamImportReport.svelte`: the report dialog (`alert.ts`
  `alertUpstreamImportReport(report, { changedWrites? })`, alert type `upstreamImportReport`, rendered by `AlertComp`
  like the request logs popup): the counts, the converted and left-out lists (each code one `language.upstreamImport`
  line with its count and example names), the missing assets by owner and role (the first 50; non-`.png` ones marked as
  never backed up by RisuAI), the full-replace warning, Cancel and Restore.
- `shared/upstreamBackup.ts` `UpstreamImportReport`: `counts` (settings records, characters without groups, groups,
  chats, messages, modules, plugins); `converted`/`excluded` entries `{ code, count, examples }` with at most
  `UPSTREAM_REPORT_EXAMPLE_LIMIT` names (except `savekv-namespace`, which lists every distinct namespace) and never a
  value, each code counting in its own unit; and `missingAssets` (`UpstreamMissingAsset`: a referenced key the archive
  lacks, its first user and role, and `expected` for a non-`.png` key upstream never backs up).
- The stable codes are `UPSTREAM_CONVERTED_CODES`/`UPSTREAM_EXCLUDED_CODES`, which the client maps to `language.*`. Also
  `UpstreamImportSelection`, `UpstreamAssetReference`, `addUpstreamReportEntry`.
- `globalApi.svelte.ts` `loadInternalBackup` ("Load Internal Backup" in `UserSettings.svelte`): lists the server
  snapshots (taken every 10 minutes while data changes, 20 kept), restores the chosen one, reloads. The server validates
  the snapshot off its serving thread before anything closes, and a second restore waits for the first, then answers 412
  when the first went through. A restore replaces the chat checkpoints (and auto-checkpoint policies) with the
  snapshot's: a checkpoint saved after that snapshot is gone, and the safety snapshot taken before the restore still
  holds it.
- `UI/Realm/RealmMain.svelte`: browse via `characterCards.ts:getRisuHub`, reactively filter blocked creators, and open
  the management list from the menu.
- `RealmPopUp.svelte`: detail, copy link, block creator, and `downloadRisuHub`.
- `RealmBlockedCreators.svelte`: the blocked creators list (name and id), unblock and refetch, and empty state.
- `src/ts/realmBlocking.ts`: pure block lookup, add/remove, and card filtering helpers.
- `src/ts/realmTerms.ts`: `REALM_TERMS_VERSION`, the terms and privacy URLs (RisuAI's), and `ensureRealmTerms()`: true
  at once when `settings.ui.realmTermsAccepted` holds this version; otherwise `alert.ts` `alertRealmTerms`, whose Accept
  stores the version (one dialog shared by concurrent callers).
- `RealmHubIcon.svelte`, `RealmLicense.svelte` (`CCLicenseData`).
- `SettingsExportButtons.svelte`: the redacted settings report (`buildSettingsReport` and its complete field projection
  are in [persistence](persistence.md)), the request logs popup (`alertRequestLogs`, [global-api](global-api.md)), and
  statistics.

## Flows

- Entry points:
  - `UserSettings.svelte`: local backup buttons (full, partial, RisuAI-compatible), internal backup restore, dataset
    export.
- RisuAI-compatible backup (`SaveUpstreamLocalBackup`):
  - After the button's backup confirmation, "Include API keys?" (`alertConfirm`; No is the recommended answer, and the
    text says it covers every key: without it the auxiliary service keys, the characters' TTS keys, and the MCP OAuth
    secrets are blank too, unlike the version-2 archive, which keeps those).
  - Then `flushResources` (a failure stops here), and the prepare with `tabExportRequest`: this tab's selection
    (`settingsViews.svelte.ts` `tabSelectionIds`, ignoring the open chat's binding), its open chat
    (`chatStore.svelte.ts` `currentChatRef`, as `selectedChat`), and the keys answer.
  - The report (`shared/upstreamExportReport.ts`: counts, the converted and left-out lists with examples, the first 20
    missing assets by owner and role, the flush's discarded-change note and named refused-change warning that the
    archive holds the server’s copy without those local changes) is a confirmation ending in "Download it now?".
  - No cancels the prepared export; yes downloads it (the token is used up) and streams it through `LocalWriter` to
    `RisuAI-backup-<date>.bin`. Nothing is read from the stream (the file has no manifest). A refusal (409 too many
    waiting, 413 too large, 404 expired) shows the server's text.
- Upstream RisuAI backup restore (`restoreUpstreamBackup`):
  - The upload and the server's conversion show as a wait alert with the phase and its counts. A refusal (the message
    refusing a Risu Account backup, a damaged file, a backup too large or over the worker's memory limit, another import
    waiting) is an `alertError` and nothing changes; a 412 reloads.
  - Then the report dialog: Cancel cancels the prepared import. Restore commits with a wait alert; the server verifies
    the staged file first and reads no row of it.
  - A `409 changedSinceReview`, also for a write that landed during that check, asks again in the same report dialog
    with the count of changes saved since the preview (on this or another device; the safety snapshot keeps them), and
    Restore resends with `acceptWrites` set to that count (asked again if more arrived), Cancel cancels. Only the report
    dialog’s own Restore button authorizes a commit.
  - The selection (the upstream-selected prompt preset, model preset, and persona) is known from the prepare's answer.
    Before each commit, `resourceSync.svelte.ts` `beforeRestoreReload` registers a synchronous hook that writes it with
    `selection.svelte.ts` `persistSelection` (storage only, not applied) when a restore is detected, before the terminal
    notice. The notice never waits for the commit's answer; a successful answer writes its own selection and reloads.
  - A changed-since-review answer or definite refusal unregisters the hook (before epoch handling for a 412); a lost
    connection keeps it registered and reports that the restore may have happened.
  - A prepared import not committed (cancelled, refused, or failed) is cancelled on the server. Other tabs see the
    maintenance 503 retries, then the new epoch, and reload.
- PeerJS multiuser chat (rooms, peer sync, and the `peerjs` dependency) was removed.
- Realm: `MainMenu` (the Explore card) → `RealmMain` → `getRisuHub(search, page, nsfw, sort)` → `RealmPopUp` →
  `downloadRisuHub`. There is no upload path. The popup block button confirms the creator, writes
  `settings.ui.blockedRealmCreators`, closes, and shows a notice. `getRisuHub` filters both listing response shapes;
  `RealmMain` also filters reactively so a block from either popup host or another tab hides cards immediately. The
  menu’s blocked creators list removes an entry and refetches after unblocking. Cards without creator metadata stay
  visible.
- RisuRealm terms:
  - RisuRealm is RisuAI's service, so using it needs RisuAI's Terms of Service and Privacy Policy accepted once; the app
    itself asks for no terms (the startup terms dialog and the legal notice page were removed).
  - `RealmMain` awaits `ensureRealmTerms` before its first listing and leaves the Realm screen (`OpenRealmStore` false)
    on decline; `getRisuHub` (answering `[]`), `getRealmInfo` (after consuming the `?realm=` parameter), and
    `downloadRisuHub` (before the creator lookup, the wait alert, and `prepareRealmImport`) await it too and send
    nothing when it is declined.
  - The acceptance is the version string in the `ui` settings, so every device of this server shares it; raising
    `REALM_TERMS_VERSION` asks again. The previous browser-local `tos4` acceptance (upstream RisuAI's, for the whole
    app) is not carried over, and `bootstrap.ts` `cleanLegacyAccountData` still removes it.
- Realm access: client-side guards refuse blocked creators with a notice for URL/id downloads, the popup’s Chat button,
  and `?realm=` detail links. Downloads check before any wait alert or `prepareRealmImport`; a non-empty block list and
  no supplied creator require an info lookup, whose failure alerts and stops the import. The current list is re-read
  after the lookup; absent creator metadata is allowed. An empty list adds no lookup. Deep links consume the parameter
  with `replaceState` and do not open a blocked card. The server route is unchanged and stages nothing for a
  client-refused card.
- Realm download: `downloadRisuHub(id)` asks the server to download and stage the card (`prepareRealmImport`,
  `POST /api/import/realm`, `storage/realmImportClient.ts`, `server-resources.md`); the tab never fetches
  realm.risuai.net or holds the file.
  - The server validates a CharX or PNG card, writes nothing, and answers its card text (a CharX file's embedded
    `module.risum` too) and a token.
  - The tab then reads the card and asks its questions (`commitRealmCard` in `characterCards.ts`): an `rcc` card's
    password (decrypted in the tab, `readPngCard`) and the `lowLevelAccess` confirmation (`confirmCardLowLevelAccess`).
  - A card that is declined, has a wrong password, or fails to read is cancelled (`cancelRealmImport`,
    `POST /api/import/realm/cancel`), so nothing is stored; otherwise the tab commits (`commitRealmImport`,
    `POST /api/import/realm/commit`), the server stores the assets and the image and answers their keys, and the tab
    builds the character (`importCharxCard`/`importPngCharacter`, the question not asked again).
  - A commit that fails is cancelled too (404 `Import expired` after 10 minutes is `realmImportExpired`; a prepare
    refused while 4 imports wait is `realmImportTooManyWaiting`).
  - A legacy JSON answer is passed through and imported in hub mode as before (its portrait and hub-mode assets fetched
    through `/hub-proxy`).

### Upstream database import

`.bin` conversion, a writer of resources: `server/src/data/upstream/importDatabase.ts` `convertUpstreamDatabase`.

- It turns the decoded upstream flat `Database` into `{ kind, id, data }` records, the selection to apply
  (`UpstreamImportSelection`), and the report. Pure and synchronous; the input is not mutated.
- Each record's data is its kind's normalizer output for the stored form of the converted input, checked with the
  store's `serialize`, so it is a fixed point the staged store accepts. Section fields and list entries the kind refuses
  are dropped individually; a record it still refuses becomes the fresh-boot value. These repairs are reported as
  `invalid-setting`, or `invalid-custom-model` for rejected custom model definitions.
- It runs the root's upstream load migrations that metatron's normalizers do not apply (the `formatversion` < 5
  `loreBookToken` floor, the old main prompts, the Ollama cloud fields, `antiClaudeOverload`,
  `largeChatPerformanceMode`).
- Each upstream preset's effective settings are upstream `setPreset` on the root (fields a preset lacks keep the root's
  value or upstream's fixed default; `openAIKey`, the NanoGPT and Ollama options, and `customTokenizer` are global), and
  the selected preset (`botPresetsId`) takes every field the root holds.
- Each preset becomes a prompt preset (`maxContext` seeds an unset `maxContextOverrideSize`, as `importPreset` does) and
  a model preset of the same name whose main, sub, and set auxiliary slots name model profiles shared across presets by
  content (sorted-key JSON without `id` and `name`, so `maxContext` and `credentialId` count), next to the materialized
  `default` profile.
- Each distinct `proxyKey` becomes a `custom` named key bound by the `reverse_proxy` profiles of the presets that hold
  it (that model reads no flat key), a preset `openAIKey` other than the root's an unbound `openai` named key (upstream
  reads only the root's), and a `customModels[].key` a `custom` named key bound by the profiles of the first surviving
  `xcustom:::` definition with that id.
- The root persona fields go into the persona at `selectedPersona`; upstream's numeric
  `translatorPresetId`/`hypaV3PresetId` become the selected item's id; `blockedRealmCreators` is mapped to
  `{ id, name }` entries before serialization, reporting an invalid list or entry as `invalid-setting` (by index), while
  name fallbacks and duplicate removal are silent repairs.
- Root fields in no `shared/sections.ts` list are reported (`unknown-setting`), and fields of removed features only when
  they hold a value (`risu-account`, `loadouts`, `removed-feature`).

### Upstream library import

`.bin` conversion of the library: `importCharacters.ts`, `importCollections.ts`, `assetReferences.ts` beside the
converter.

- The converter also takes the archive's cold-storage payloads (`cold`: `readColdEntry` results by key) and asset keys
  (`assetKeys`) and returns `characters` (`characters` records) and `chats` (one ready create `ChatGroup` per chat,
  every message `chatId` valid and unique).
- The staged-import writer puts the singleton `resources` at the staged store's current revision or creates the ones it
  lacks (`modules`, `plugins`, `pluginStorage`), then creates each character (which creates its empty chat order), then
  sends the chats through `applyChanges` in batches in array order, so each chat order is upstream's.
- Cold storage is folded on import only: a stub character (`coldstorage`) becomes its payload's `character` when the
  `chaId` matches and it converts, a chat whose first message is the `U+EF01 COLDSTORAGE U+EF01` pointer takes the
  payload's messages and memory, and `pluginCustomStorage._coldplugin` values and `_coldpluginIndex` entries go into
  `_pluginStorage` (where metatron's v3 storage lives; index shape, `s`/`l` entries, and inline > index > `_coldplugin`
  precedence: [Invariants](#invariants)).
- A pointer without a usable payload keeps the stub (name, image, an empty chat) or the chat without messages and is
  reported (`cold-missing`).
- Characters follow the client's creation steps (`prepareNewCharacter`, ported) and the `characters` normalizer;
  `§temp`/`§playground` are dropped, a missing, invalid, or repeated `chaId` is replaced (an invalid one held once is
  rewritten in group members, message speakers, and `characterOrder`), group members that name no kept character are
  removed with their talk and active entries.
- Chats are bound to the converted selection (`bindedPersona` kept when it names a converted persona, no
  `bindingReview`), `useLocallySetGlobalVariables` is dropped and `GLGlobalVariables` kept except its `""` `toggle_*`
  values (upstream reads a chat value first, with or without the flag, and ignores `""`); a message, chat, character,
  module, or plugin the store would refuse is left out or repaired on its own and reported.
- `characterOrder` keeps only kept characters' ids, `enabledModules` only entries naming a kept module's id or
  namespace. Upstream's top-level plugin storage values (its v3 storage before cold storage) stay at the top level and,
  in a file without `_pluginStorage`, are also copied into it.
- Asset keys the converted records reference and the archive lacks go to `missingAssets` (`assetReferences.ts`
  `collectAssetReferences` places the records in upstream's shape and runs the export's walker, so both directions
  report the same fields and roles); chats showing inlays, which upstream keeps outside its backups, are counted.

### Upstream database export

`.bin` export, a reader of every kind: `server/src/data/upstream/exportDatabase.ts`
`buildUpstreamDatabase(rows, chats, options)`.

- It projects the rows of a validated store copy (`readSnapshotFile` of a `backupTo` file in the export worker,
  `exportStage.ts`: the resource rows and the chat tables) to an upstream flat `Database` that `encodeUpstreamDatabase`
  writes as `database.risudat`, with the referenced asset keys (`assetReferences.ts` `collectUpstreamAssetReferences`,
  the import's walker too; `hasAsset` moves absent ones to the report's `missing`) and the report.
- The report is `shared/upstreamExportReport.ts` `UpstreamExportReport`: counts, `converted`/`excluded` entries of the
  import report's shape, `missing`, `UpstreamAssetReference`s. Pure and synchronous; the rows are parsed, so the result
  shares nothing with them.
- The settings steps are the job projection's (`server/src/data/databaseProjection.ts`: `projectSections`,
  `projectCollections`, `forwardSelectedPreset`, `forwardPersonaRoots`, `characterShell`, also used by `loadJobScope`).
- One upstream preset per prompt preset, in stored order, each with the chosen model preset's slot model ids and its
  main profile's options (differing sub/aux profile options reported as `slot-options-flattened`, excluding root-only
  options and the separately projected `maxContext`; the NanoGPT, Ollama, and tokenizer options only at the root, as
  upstream reads them), `maxContext` from the prompt preset's override or the profile, no `id`, `archived`, or override
  fields.
- The chosen prompt preset, model preset, and persona fill the root and the selection indexes (a missing id falls back
  to the first record, reported).
- The translator presets as upstream's `{ name, prompt, maxResponse }` from the first enabled step, and both translator
  and HypaV3 selections as list positions. HypaV3 presets without `budgetMode` and the three token amounts (upstream has
  no token mode), a token-mode one with its amounts as ratios of the exported root `maxContext` (rounded to 2 decimals
  and kept in the sliders' ranges: memory in [0, 1], extra summarization in [0, 1 − memory], headroom in [0, 0.99]; its
  stored ratios when that `maxContext` is not a positive number).
- Metatron-only settings, character fields, chat fields (`loreOverrides` among them: as upstream chat lore they would
  add entries instead of replacing them), and message translations are stripped (a setting reported only when it differs
  from its fresh-boot value).
- A chat with toggle values gets `useLocallySetGlobalVariables` (upstream reads the chat's toggles first whatever the
  flag; the flag keeps its writes in the chat), `lastDate` at least its newest message time, and a character without
  chats upstream's empty `Chat 1` (upstream reads `chats[chatPage]` unguarded; the import adds the same chat).
- A character's numeric frozen legacy `lastInteraction` is raised to at least its newest chat `lastDate` (the export
  keeps this rule because upstream's cold storage, on by default without plugins, moves a character or chat idle for ten
  days; an absent field stays absent, which upstream reads as now), and a finite positive `trashTime` older than three
  days is refreshed (upstream's boot deletes characters trashed three days ago).
- Shapes upstream's boot walks unchecked are repaired in the copy (folder `data` lists, lorebook entry lists and their
  `content`). `pluginCustomStorage` loses `_pluginStorage` and `_safeLocalPluginStorage` (upstream keeps them on the
  device) and inlays are not exported, both counted. `formatversion: 5` comes last.
- Credentials without `includeSecrets`: every `llmSecrets` field is the client mirror's `""`, and the auxiliary keys of
  the `secrets` section, characters' `oaiTTSConfig.apiKey`, and the MCP OAuth secrets are cleared too, with
  `vertexAccessTokenExpires` reset to 0.
- With `includeSecrets`: the stored keys, plus each named key a chosen slot binds written into the one field upstream
  reads for that model (main → sub → enabled aux slots, default-backed slots reserving their fields before later named
  bindings, `proxyKey` for the reverse proxy, `customModels[].key` for a custom model: the import's inverse). A placed
  Vertex binding also supplies `google.projectId` when present and clears the cached token and expiry, while a binding
  without a client email is skipped.
- Every stored named key no field holds is reported as `named-keys`, including displaced bindings and keys without
  metadata (named by id). Only those credential fields are controlled: a key typed into free text (a message, a
  lorebook, plugin storage) is exported as it is.

## State

- `ui.realmTermsAccepted` ([persistence](persistence.md)): the accepted RisuRealm terms version, `""` when none.
- Realm has no account token field (the boot never installs the removed legacy `account` token); old saves may still
  carry an unused character `realmId`.
- UI state: `OpenRealmStore` in `stores.svelte.ts` ([app-shell](app-shell.md)).

## Coupling

- Depends on `database.svelte.ts`, `globalApi.svelte.ts` (`LocalWriter`, fetch), `storage/resourceClient.ts`
  (`exportBackup`, `importBackup`, `listBackups`, `restoreBackup`), `storage/resourceSync.svelte.ts` (`flushResources`,
  `beforeRestoreReload`), `storage/serverImportClient.ts` (`importOverServer`), `storage/selection.svelte.ts`
  (`persistSelection`), `storage/settingsViews.svelte.ts` (`tabSelectionIds`), `storage/chatStore.svelte.ts`
  (`currentChatRef`), `characterCards.ts` (`hubURL` and hub APIs), `alert.ts`, `platform.ts`.

## Invariants

- The archive format (version 2, `manifest.json` first) is defined by the server; the client only streams it and reads
  the manifest.
  - An archive or snapshot whose resource database schema version differs from the server's current version (3, with
    settings sections and collections) is refused with a message; metatron does not migrate these archive schemas.
  - Archives in the upstream format (upstream RisuAI and older metatron backups with `database.risudat`) are restored
    through the upstream import under the compatibility rule ([persistence](persistence.md#invariants)): a one-way,
    full-replace migration with a report before anything is replaced.
  - That covers both `database.risudat` encodings, the legacy MessagePack save and the block save current upstream
    backups write (its SaveKV namespaces are listed under the excluded code `savekv-namespace`, by namespace without a
    `kv:` prefix; this code lists every distinct namespace instead of applying the usual five-example cap).
  - A live block save whose data lies outside the file (a remote block, or a directory naming a block the file lacks) is
    refused with a message.
  - The version-2 import route still refuses upstream-format archives with a message naming the upstream import.
  - A Risu Account backup (`encryption.risudat`) is refused with a message.
- The upstream import reads plugin storage (`pluginCustomStorage`, converted by
  `server/src/data/upstream/importCollections.ts` `convertPluginStorage` into the `pluginStorage` record, v3 values
  under `_pluginStorage`) in each form upstream wrote: inline top-level values (copied into `_pluginStorage` only in a
  file without one), the older per-key `_coldplugin` pointers, and current upstream's `_coldpluginIndex`.
  - `_coldpluginIndex` is the id of one cold-storage record
    `{ type: "risu-plugin-storage-index", entries: [{ k, s?, l? }], trash }` whose `s` is a small value's JSON text and
    whose `l` names another cold record holding a large value of any JSON type (`trash` is dropped).
  - Cold records are read as `data` (a list, or an object with `character` or `message`) or `plugin` (any other JSON;
    `archive.ts` `readColdRecord`), and when both name forms of one key exist, character and chat restores read the last
    `data` record while plugin storage reads the last `plugin` one, as upstream's restore does.
  - With an index, inline copies override index values, which override `_coldplugin` (used only for keys no index entry
    claims, a failed one included); without one, `_coldplugin` overrides an inline copy as before.
  - Index entries are decided before their values are read: `l` beats `s`, and a later entry of a key replaces an
    earlier one even when it then fails.
  - Problems are listed in the report and the rest imports: a missing or unreadable index record (`cold-missing`,
    `_coldpluginIndex`: the keys cannot be named without it), a record that is not an index (`invalid-setting`), an
    entry without a key or value or a displaced duplicate or unparsable `s` (`invalid-data`), a large value whose record
    is missing, over the per-record cap, or not JSON (`cold-missing`, by key).
  - The commit stays all-or-nothing, so plugins never run against a half-restored store.
- Export, change, and restore are covered end to end on a version-3 store: an archive import undoes changes made after
  the export (a plugin `setCharacter`, an MCP tool), and restoring the safety snapshot the import took brings them back.
- A backup restore replaces every resource and only adds assets that do not exist yet; the app reloads afterwards
  because every revision the tab held is void (new epoch).
- A refused snapshot or archive, one over the server's restore memory limit (`RISU_RESTORE_HEAP_MB`) included, is
  refused before maintenance, so it ends no running job and takes no safety snapshot; the route's `error` text is what
  the tab shows.
- Full version-2 archives carry private data, including `googleSearchCredentials`, the Iris dialogue, plugin storage,
  and the plugin permission grants.

## Recipes

- Add a partial-backup asset category: `selectPartialBackupAssets` in `shared/backups.ts`, its labels and inventory
  mapping in `backuplocal.ts` `partialAssets`, and the staged-resource query in `server/src/routes/backups.ts` if
  another kind is needed (a full backup already takes every asset).
- Change the archive format: the server side (see `server-resources.md`) and `tryReadManifest` here. Add a round-trip
  test.
- Change what the RisuAI-compatible backup carries: the projection is `server/src/data/upstream/exportDatabase.ts`
  ([Upstream database export](#upstream-database-export); metatron-only chat fields such as `loreOverrides` are in its
  `METATRON_CHAT_FIELDS` strip list); a new report code goes into `shared/upstreamExportReport.ts` and
  `language.upstreamExport` (`en.ts`, `ko.ts`). The record layout (assets by basename, then `database.risudat`) is
  upstream's restore format: keep `upstreamAssetRecordName` in step with `planUpstreamArchive`, so this app's own import
  reads every export back.
- Change Realm: `characterCards.ts` hub functions and the matching `Realm*` component together. Check `hubURL` on Node
  (`/hub-proxy`).

## Tests

- `src/ts/drive/backuplocal.test.ts`: the backup functions over a fake `authFetch` and a fake `LocalWriter`, with
  `flushResources` stubbed: each test sets the routes' answers and the writer's failures. `LoadLocalBackup` routes by
  `readFirstRecordName`; its upstream path runs `restoreUpstreamBackup` over fake prepare/commit/cancel answers and a
  fake `beforeRestoreReload` whose hook the test fires itself. `SaveUpstreamLocalBackup` runs over fake export answers.
- `src/ts/alertUpstreamImportReport.test.ts`: the report dialog's answer is its own: Restore through the dialog's
  `answer(true)` resolves true, Cancel false, a generic "yes" close false (another confirmation opened meanwhile waits
  behind it in the alert queue and answers only itself), a cancelled dialog false; `changedWrites` reaches the dialog.
- `src/ts/storage/tests/selection.test.ts` `persistSelection`: both storages written with the lorebook page reset, the
  live selection untouched until `loadSelection`, throwing storages survived.
  `src/ts/storage/tests/resourceSync.test.ts` "restore (412) and errors": `beforeRestoreReload` runs synchronously after
  saving halts and before the restore notice, once; a later hook replaces an earlier one, an unregistered one is
  forgotten, a throwing one is logged and does not block the notice.
- `src/ts/drive/backuplocalSnapshot.test.ts`: `SavePartialLocalBackup` against the real export route (node environment,
  the flush stubbed): an image another writer commits while the client waits for its flush is in the archive and its
  resource snapshot, and a referenced image the server lacks is reported under the character's label.
  `shared/tests/backups.test.ts`: the selector's categories, deduplication, and what it ignores.
- `src/ts/characterCardsRealmImport.test.ts`: the real records with the server's Realm import answered by the test on
  the fake server's `fetch`. "Realm creator blocking" covers the listing, download, and deep-link refusals; "RisuRealm
  terms" answers a fake `alertRealmTerms` (the other cases start accepted). `src/ts/realmBlocking.test.ts`: block and
  unblock by id. The upstream mapping of the list: `server/src/tests/upstreamImportSettings.test.ts`.
- Adjacent: `src/ts/network/localNetwork.test.ts`.
- `util/upstream/checkBinCompat.mjs` (manual, not in `pnpm test`; `build-test-platforms.md`): the RisuAI-compatible
  export read by upstream RisuAI's own decoder and boot defaults against either pinned target (`--target legacy`, the
  default, or `--target current`); the current target also runs upstream's plugin storage migration. `--bin` checks an
  existing export; target pins and harness details: [build/test platforms](build-test-platforms.md#files).
- Not tested: the terms dialog's rendering and `RealmMain` leaving the Realm screen on decline (component level).
- Not tested: `LocalWriter` itself (streamSaver; a manual check downloaded both RisuAI-compatible exports through it,
  with its helper page served locally), the Realm components (the listing filter, the download and deep-link refusals,
  and the import of the block list are tested: `characterCardsRealmImport.test.ts`, `upstreamImportSettings.test.ts`),
  settings redaction.
- Not tested: a RisuAI-compatible export restored in upstream RisuAI's own app. `checkBinCompat.mjs` runs upstream's
  decoder and boot defaults, plus plugin storage migration for the current target, without its `LoadLocalBackup` or UI.

## Known Hazards

### Issues

- `RealmMain` renders `hubAdditionalHTML` via `{@html}`.
- The RisuRealm terms gate is client-side only: `GET /hub-proxy/*` (unauthenticated) and `POST /api/import/realm` do not
  check `ui.realmTermsAccepted`.
