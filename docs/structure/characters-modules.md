# Characters, Cards, Modules, Personas

## Scope

- Owns character and group CRUD, card import and export (PNG, JSON, CharX, V2/V3, off-spec Tavern), PNG tEXt chunks,
  CharX zip read and write, modules (the `.risum` codec, activation, the effective-set getters),
  module/character/persona conversion, personas, and the character and lorebook editor UI.
- Paths:
  - `src/ts/{characterCards,characters,persona,pngChunk,interchangeability,assetList}.ts`
  - `src/ts/process/{processzip,modules}.ts`
  - `src/ts/rpack/` (client bridge to the shared codec)
  - `shared/{charxImport,moduleImport,rpack}.ts`
  - Format readers: `server/src/routes/{importCharx,importModule,importPng}.ts`
  - `src/lib/SideBars/CharConfig.svelte`
  - `src/lib/SideBars/LoreBook/*`
  - `src/lib/Setting/Pages/Module/*`
  - `src/lib/Setting/Pages/PersonaSettings.svelte`
  - `src/lib/Setting/listedPersona.svelte`
  - `src/lib/Others/GridCatalog.svelte`
  - `src/lib/ChatScreens/AssetInput.svelte`
- Not here:
  - Lore activation at prompt time → `chat-pipeline.md`.
  - Asset byte storage (`saveAsset`) → `global-api.md`.
  - Bot preset codecs (`downloadPreset`/`importPreset` in `presets.svelte.ts`) → `settings-i18n.md`.
  - The Realm hub → `backup-sync-hub.md`.

## Files

### Cards and CharX

- `characterCards.ts`: card import, export, and hub helpers. `hubURL` is the self-host server's same-origin
  `/hub-proxy`.
- `CharXImporter` (`process/processzip.ts`) is the in-tab reader, for bytes and streams only (tests). Assets save
  through an `AssetSaveQueue` (10 at once); the feed loop pushes 64 KiB slices, each after `whenReady()`, so only about
  ten decoded, unsaved assets are held.
- A ZIP callback or input-read failure cancels it, aborts and drains queued uploads, clears partial results, and rejects
  both `parse()` and `done()` with the original error. Upload failures still reject `done()` after the saves settle.
- `shared/charxImport.ts`: the format both readers follow (`charxEntryKind`, `MAX_CHARX_ENTRY_BYTES`,
  `excludedBeforeReading`) and the server's zip parsers, for `server/src/routes/importCharx.ts`
  ([server resources](server-resources.md)).
- Entries: `card.json` is the card (UTF-8), `module.risum` the embedded module, any other `.json` (`x_meta/*.json`) is
  ignored, every other entry is an asset stored under `assets/<sha256 hex>.png`.

### Characters

- `characters.ts`: `createNewGroup` (the add dialog does not offer it; its `createGroup` result is still handled, and
  existing groups keep working), `changeChar` (ensures a chat, then selects; it applies no defaults and writes no
  activity field), `removeChar` (soft delete via `trashTime`, or permanent).
- Recent ordering: home and mobile use the chat module's `characterLastChattedAt`; only when no chat has a value does it
  use finite stored `lastInteraction` (else 0). Groups use their own chats.
- `lastInteraction` is frozen stored data, never written or migrated. Plugin `withChatsCopy` snapshots fill a positive
  derived time into it, and same-character `applyPluginCharacter` setters preserve the stored field, including absence,
  so a round trip never saves the derived value. New characters and imports retain their input value. Upstream export
  has its own cold-storage rule ([backups](backup-sync-hub.md#upstream-database-export)).

### Modules

- `process/modules.ts`: `RisuModule`, `getModules` and its `getModule*` getters, `moduleUpdate` (the selected chat's
  icon/background stores and one GUI reload).
- Codecs: `exportModule` (CharX via character conversion), `exportModuleLegacy`/`readModule` (`.risum`: magic byte
  `111`, version `0`, RPack JSON plus asset records). `shared/moduleImport.ts` is the server reader, `shared/rpack.ts`
  owns `encodeRPack`/`decodeRPack`, and the route is `server/src/routes/importModule.ts`.
- `exportModuleLegacy` snapshots asset tuples before awaiting reads, preserving metadata and payload order.

### Module import

- `importModuleFile(file: Blob)` is every `.risum` entry point's import. It reads only the file's header and main
  record; before anything is sent, it asks `lowLevelAccessConfirm` for a `lowLevelAccess` module and runs
  `prepareModuleImport` (a declined question sends nothing).
- It uploads the `File`/`Blob` itself in one request ([import transports](#import-transports)), then copies only the
  stored keys (`assets[i][1]`) from the server's module into the prepared one (another asset count is `noData`). It
  returns that module under a fresh id, or `null` once a question was declined or a failure is alerted.
- `serverImportErrorMessage` picks both file imports' alert by the answer's status and `error` text (the route's
  invalid-file text is `noData`; too large, busy, maintenance, a timeout, or the server's text), a failure line, or an
  interrupted upload.
- Every module import entry point adds through `addImportedModule`: it adds the module in a mutation scope, then waits
  under `moduleImportSaving` for `flushResources({ scope })`, which saves every pending change, not only the module.
- `successImport` comes only after that acknowledgement, and only while that wait alert is still showing; an intervening
  alert stays on screen. The dialog's JSON, lore, and regex branches stay silent and clear the wait alert.
- `modules/main` in the scope's `discarded` is `moduleImportDiscarded`: a conflict replaced this tab's modules (an add
  alone is [rebased](resource-sync.md#record-merge) over another tab's list).
- A failed flush is `moduleImportUnconfirmed`, and the module stays in the list; one a conflict discarded is
  `moduleImportDiscarded` even if the flush later fails.
- `characterCards.ts` opens the module settings only when the helper reports the save. `#share_module` consumes its
  pending share once the module was added, whatever the save's outcome (a second import would add it twice).

### Personas and conversion

- `interchangeability.ts`: module, character, and persona conversions (an embedded module ID is normalized to
  `$embedded`).
- `persona.ts`: `changeUserPersona(id, target?)` picks the persona where the screen shows it, through `pickBinding`:
  with a chat open it binds that chat, at home it selects for this client; `target` names a chat or `null` for the tab.
- `selectUserImg` captures the selected persona before the file dialog and sets its icon, keeping its id, so bound chats
  stay bound. `exportUserPersona`/`importUserPersona` use a PNG `persona` tEXt chunk.

### Character editor

- The emotion image table pages like the asset lists, without search; a rename writes nothing once the index is past the
  list's end.
- `customNotificationMessage` (a character's or a group's completion text, [Web Push](global-api.md)) is outside the
  card-license guard: it is local, and `createBaseV2`/`createBaseV3` and the card import never carry it.

### Lorebook editor

- The editor and lorebook file codecs support character and chat lore only; persisted global lore pages remain for
  snapshots and upstream backups, without a UI entry.
- `LoreBookList.svelte`: `removeEntry` deletes by identity, returning whether it removed the entry and doing nothing
  when the shown list no longer holds it.
- Open details count only `mode !== "folder"` rows; nested lists own their members' open state. Membership changes, an
  owner switch or a chat draft resync included, prune stale open refs and recount, recreating Sortable synchronously at
  zero; creation never adds a second live instance.
- `LoreBookData.svelte`: `activateLocally` creates a live `mode:'child'` link, independent of frozen chat overrides. Its
  checkbox shows, and unchecking removes, only `mode:'child'` links with the entry id, so a plain chat entry that kept
  the same id (an import) is neither shown as linked nor deleted.
- Delete captures the entry id, a folder's member ids (`folder === key`), its membership in the selected character's
  `globalLore`, the chat ref and the owner token before either dialog. Only a successful `onRemove` of a character entry
  deactivates those ids in the captured chat: after `ensureChatLoaded` it checks the owner token and the local-send/job
  fence at the write, then removes matching `child` links in one `setChatMeta`.
- A chat-local row (including a child link or a nested folder member) is removed only through its list's draft, with no
  separate id cascade.
- `LoreEntryFields.svelte`: the shared non-folder fields and token counter, mounted only while an entry body is open;
  unmount disposes pending counts.

### Lorebook filter

- The outermost `LoreBookList` owns the query and match set; folder lists read them through the `LORE_FILTER` context.
  The query resets when the owner changes (the character, the chat, or the tab between them).
- An entry matches on `comment`, `key` and `secondkey` (a chat's `child` link also on the entry it links), never
  `content`; a folder's name shows all of its entries; a shown entry shows its folders.
- Matches are computed once at the root from a tracked copy of the list, reading fields untracked, so a row renamed
  under the filter stays shown until the query or the membership changes.
- Hidden rows stay mounted, keeping their open details. A shown folder opens through `forceOpen` without writing
  `openedRefs`.
- Every SortableJS instance is disabled while the query is non-empty, and a drop that ends while filtering writes
  nothing.

### Chat lore overrides

- `LoreOverrideList.svelte` / `LoreOverrideRow.svelte` show the chat owner's `globalLore` (the group's own lore for a
  group), nested by non-empty string folder key, repeated/cyclic keys guarded. First-owner/first-override matching
  follows `mergeOwnerLore` before folder grouping.
- The `stateFor(name)` controls show an entry's state from its override (Original: none, Override: `off: false`, Off:
  `off: true`) and a folder's On or Off. They bind through getter/setter functions, so a refused, cancelled or aborted
  change keeps the old segment.
- Override or Off pins a full copy into `useLoreOverridesDraft` in one push, after the loaded-chat and
  [send-fence](#lorebook-rows-and-writers) checks, giving a missing or duplicate original id a fresh UUID through a
  nested character write. Override ↔ Off flips `off` on the copy and keeps its edits.
- A folder's Off sets `off` on its override, or pins the folder with `off: true`. On removes every override with its id
  from the draft without confirmation, so members return to their own states. A parent never changes a nested folder.
- Bulk release covers the overrides a folder's indicator counts by the owner's current keys (entry overrides and nested
  folders that are off), never the folder's own.
- Turn-off-all sets each entry inside the folder, nested folders' included, Off on its own in one draft change, without
  confirmation (an existing override keeps its edits, a missing one is pinned). No folder's state changes, so a
  later-added entry is not turned off.
- Editable bodies are keyed by override object; their guarded bindings return a throwaway after the draft releases the
  object or switches chats.
- Release (an entry back to Original, and a folder's bulk release) captures the chat ref, owner token and ids, reloads
  the captured chat, re-reads its owner's lore by the captured `chaId`, and rechecks the owner and fence. An entry
  confirms only when a collected copy differs from its owner entry (an owner folder's copy never counts); bulk always
  confirms with the count.
- After a release dialog it reloads and rechecks again and writes nothing if the collected overrides changed; otherwise
  one `setChatMeta` removes every override with a target id.
- Orphans: delete and move target the selected override object, never every duplicate id. Move, only for an on override,
  atomically removes it while appending a deep copy to `localLore`, with a fresh id, unchanged mode and no folder key.
  Both confirm and recheck the captured owner and send fence.
- Off wins over a local activation: the override row, the character local-activation checkbox and the chat `child` row
  use `offOverrideIds` for the off-precedence notices.

### Module settings

- `ModuleSettings.svelte`: edit mode retains only the module id and resolves its live record wrapper from the current
  list, so `ModuleMenu` edits save immediately and follow a remote list replacement; a missing module returns to the
  catalog without a write.
- Create mode adds its plain-object draft to `settings.modules` once, by the final button, only when a non-`id` field
  has content. Asset bytes uploaded meanwhile stay stored.
- The share button adds no error alert: both exporters alert their own failure. Once the export settles,
  `clearStaleExportWait` clears only the exact status passed to `onInstall`; a newer status and any error or success
  dialog stay.

### Asset pickers and lists

- The asset pickers (`CharConfig`, `ModuleMenu`, `AssetInput`, `addCharEmotion`) save the picked `File`s with
  `savePickedFiles` and push every row in one write once all are saved; a failed save alerts and adds none.
- `assetList.ts`: `matchingAssetIndices` returns source indices; `characterAssetNames` and `moduleAssetNames` supply
  cached lowercase names, a character's by a frozen list's identity, else by `wrapperFieldStamp`, a module's by the
  shared `moduleFieldPlain` copy.

### Import transports

- `src/ts/storage/serverImportClient.ts` `importFileOverServer(path, file, readResult, { onProgress })` sends the
  `File`/`Blob` itself as the body of `POST path` through `authFetch` (never a `ReadableStream`): one request, never
  retried, since a refusal before the body is read can reach the browser as a network failure, the `TypeError` it leaves
  to the caller.
- The NDJSON answer is read as it streams: `{ error }` throws `ServerImportFailedError`, the line `readResult`
  recognizes resolves, and `{ done, total }` lines call `onProgress`.
- A non-2xx answer throws `ServerImportRequestError` (`status`, `serverError`); an answer that is not the route's NDJSON
  (an unknown or malformed line, a line after the result, a truncated body) throws `ServerImportAnswerError`.
- `moduleImportClient.ts` `importModuleOverServer` (`POST /api/import/module`, the result line told by its `module`, the
  error classes re-exported as `ModuleImport*`) and `charxImportClient.ts` `importCharxOverServer`
  (`POST /api/import/charx`, told by its `assets`, shape-checked against `CharxImportResult`) wrap it.

## Flows

### Card import

`importCharacterProcess` dispatches by extension.

- `.json`: `importCharacterCardSpec`, falling back to `convertOffSpecCards`.
- `.png`:
  1. `PngChunk.readGenerator` reads the `chara` (V2) and `ccv3` (V3) keys. `ccv3` wins when both exist.
  2. `chara-ext-asset_<id>` chunks feed `saveAssets` as they are read, written in batches (`POST /api/assets/write`),
     the reader held back once a batch's worth is waiting.
  3. `importPngCard`: `readPngCard` reads the text (base64 JSON, or a legacy `rccv1` card, checked and decrypted: a
     wrong password is `wrongPassword`, a dismissed prompt adds nothing), `confirmCardLowLevelAccess` asks a v2/v3
     card's `lowLevelAccess`, and `importPngCharacter` adds it (an off-spec card through `convertOffSpecCards`).
- `.charx` and `.jpg`/`.jpeg` (a `charxJpeg`: a JPEG, then the zip):
  1. A `File` or `Blob` is uploaded as it is, once (`importCharxOverServer`). The server stores the assets and answers
     the card's text, the embedded `module.risum` (base64), each asset entry's stored key, and the excluded entries. A
     failure is alerted (`serverImportErrorMessage`) and returns `null`.
  2. A `Uint8Array` or a `ReadableStream` (tests) is read by the in-tab `CharXImporter`.
  3. Then, either way: `readCharxCard` (no card is `noData`; the `chara_card_v3` check), then `importCharxCard`: the
     card's `lowLevelAccess` asked (before the module's assets are saved), `readModule` of the embedded module (its
     triggers and regex replace the card's; its lore, if any, replaces the `character_book` entries), then
     `importCharacterCardSpec` with the entry name → key map.
- The character's gate is the card's `extensions.risuai.lowLevelAccess`; the embedded module's own `lowLevelAccess` is
  not carried onto the character, so it is not asked.
- Input: `data` is a `Uint8Array`, a `ReadableStream`, or a `Blob`, told apart without `instanceof Blob` (in tests
  `Response.blob()` is not the environment's `Blob`). A `.json` card is read whole; no PNG input is read into bytes
  first, a `Blob` streaming with `stream()` where it exists.
- V3 asset URIs: `__asset:<id>`, `embeded://path`, `ccdefault:`, `data:`.

### Realm download

`downloadRisuHub` → `POST /api/import/realm`: the server reads the file, and the prepare answers before anything is
stored.

- PNG: the prepare answers the card text, the tab runs `readPngCard` and `confirmCardLowLevelAccess` (cancelling a
  declined or failed card), and the commit answers the trimmed image's key and the asset keys for `importPngCharacter`.
- CharX: the prepare answers the `card.json` text and the `module.risum` bytes, the tab runs `readCharxCard` and the
  `lowLevelAccess` question (cancelling a declined card), and `importCharxCard` runs with the commit's keys and the
  question already asked.

### Import results

- A card becomes a new `character` with a fresh `chaId` through `addCharacter`: the card is checked as JSON data (a
  refused card leaves the character list, its chats, and the order unchanged; the importer is not transactional, so the
  `statics.imports` stamp and a saved image stay), its chats get ids, and it joins the character order.
- The global lore import writes through `updateCharacter` by the id captured before the file dialog.
- `importCharacterCardSpec` asks `lowLevelAccess` before any asset of the card is saved; a caller that asked already
  passes `lowLevelAccessAsked`.
- Character imports count `statics.imports` for PNG, JPG, and CharX files before parsing (a card refused later still
  counts); a JSON card does not count. A Realm download counts once the server answered a staged CharX or PNG card (a
  failed download or a file the server refused does not count; a card declined afterwards does).
- `importModule`'s `.charx` branch adds no alert when `importCharacterProcess` returns `null` or `undefined` (already
  alerted); `false` or a string is `noData`. A CharX whose module is refused alerts `noData` and adds no module (no
  success alert); the character's data is unchanged.
- `importChat` captures the selected character's id before the file dialog, resolves it again afterwards (a deleted one
  stops with `importTargetGone`), and switches to the imported chat only while that character is still selected.
- `importUserPersona` saves the PNG icon first, then adds the persona (a fresh id) to the live list, so a collection
  another client replaced meanwhile keeps both the new list and the icon.

### Card export

`exportChar`; groups are not exportable. The written bytes are unchanged for the same inputs (STRUCTURE D5), so the
existing card and module readers remain compatible.

- V3 PNG: `ccv3` plus `chara-ext-asset_*` chunks.
- V3 JSON: assets as data URIs, capped at `JSON_EXPORT_ASSET_LIMIT` (64 MiB): the read bytes of the embedded assets, the
  `ccdefault:` portrait included, summed as each arrives, before compression. One byte over refuses the export with
  `jsonExportTooLarge` before `JSON.stringify`, cancelling the pending batch read, with no download and no success alert
  (a supplied writer gets the rethrow instead).
- V2 JSON: `__asset:N` references only, so it has no cap.
- CharX: `card.json`, `module.risum`, `assets/...`, `x_meta/...`.
- V2 PNG: `chara`, the `exportCharacterCard` default for compatibility.

### Export reads and failures

- `exportCharacterCard` and `exportModuleLegacy` read through `loadAssetsInBatches`, 200 keys per
  `POST /api/assets/read`, at most one request in flight; read memory is bounded by two batches plus the asset being
  written. JSON cards still accumulate data URIs (up to the cap), and `saveData: false` still buffers the `.risum`.
- A `null` record means a missing or empty file: write an empty asset, count it, warn with its key, and report the count
  in the end alert (`exportMissingAssets`) when end alerts are enabled. Transport, framing, compression, and output
  errors stay fatal.
- A missing or empty portrait exports with `/none.webp` and a console warning naming its key (none when no portrait is
  set), without counting as an empty asset; a portrait read that throws fails the export.
- Any failure aborts the open `LocalWriter`, cancels and settles the pending read, and shows no success alert. Whether
  the cancelled partial download is removed is streamSaver's and the browser's behavior, not the exporter's.
- Alert owners: `exportChar`'s card exports alert their own failure or success. With a supplied writer,
  `exportCharacterCard` aborts and rethrows without an alert. `exportModule` catches and alerts once, and reports
  completion only when `alertEnd` is true.
- `exportModuleLegacy` alerts failures and, when `alertEnd` is true, completion, except
  `saveData: false, alertEnd: false` (caller-owned bytes, the CharX embed), which aborts and rethrows.

### Drops and deep links

`App.svelte` and `characterURLImport`:

- `.risup`/`.risupreset` → `importPreset`.
- `.risum` → `importModuleFile`, then `addImportedModule`.
- Anything else, a CharX (`.charx`, `.jpg`, `.jpeg`) and a `.png` card included → `importCharacterProcess`.
- Cards and modules go as the `File` or `Blob` itself; `characterURLImport` reads only presets into bytes.

### Module activation

`getModules` returns the union of:

1. `db.enabledModules` (global),
2. `chat.modules`,
3. `character.modules`,
4. the bound persona's embedded module (through the id list above, like the others),
5. the bound persona's linked modules (`RisuPersona.modules`), resolved apart from that list: by id only, never by
   namespace, and never an MCP module (`personaLinksModule` in `shared/personas.ts`),
6. namespace matches in `db.moduleIntergration`.

## State

- `character`: identity and content fields plus `emotionImages`, `additionalAssets` (`[name, path, ext][]`), `ccAssets`,
  `customscript`, `triggerscript`, `globalLore`, `loreSettings`, `modules`, `lowLevelAccess`, the TTS fields, and
  `trashTime`.
- `groupChat`: `type:'group'`, `characters: string[]`, `characterTalks`, `characterActive`, `useCharacterLore`.
- `loreBook`: `key`/`secondkey` (comma-separated), `content`, `mode` (`normal|folder|child|...`), `id`, `folder`,
  `bookVersion`.
- `RisuPersona`: `embeddedModule`, `modules` (linked module ids, canonical by `normalizePersonaModules`: non-blank
  strings, each once; kept when no module has them, and not carried by the persona PNG export). The active persona is
  mirrored into the legacy DB fields `username`, `userIcon`, `personaPrompt`, `userNote`.

## Coupling

- Depends on `database.svelte.ts`, `stores.svelte.ts` (`ReloadGUIPointer`, `moduleBackgroundEmbedding`),
  `selection.svelte.ts`, `globalApi` assets and writers, `alert.ts`, `util.ts`, `media/`, the lorebook codecs, scripts,
  triggers.
- `@risuai/ccardlib` is imported for types only. There is no runtime validation.

## Invariants

### Card formats

- Keep both the V2 `chara` and V3 `ccv3` readers, and the off-spec Tavern heuristics, `convertCharbook` migrations, and
  V2 `character_version` handling.
- Exporters walk the original asset lists for `assetIndex`, `__asset:N`, the `ccdefault:`/`isKnownUri` branches, and
  CharX member names; fetched bytes match positions in the per-kind key list, and a fetched index never determines
  original-list numbering.
- `StreamChunkWriter.end()` awaits the writer's close, and `CharXWriter` rethrows a zip callback error at the next
  `write`/`end`, so output failures reach the exporter's cleanup.
- CharX: always await `CharXImporter.done()`. Never drop `module.risum`. Keep the two readers' entry rules alike
  (`shared/charxImport.ts`), and never hand the in-tab reader a file. The server delimits entries by the central
  directory and the in-tab reader by fflate's streaming signature scan: the intended difference (D5 in `STRUCTURE.md`).
- CharX sizes: the in-tab reader skips a declared size of at least 50 MiB when known before inflation and otherwise
  excludes decoded entries over 50 MiB (`excludedFiles`); the server also skips oversized central-directory declarations
  and compressed entries before reading.
- `CharXWriter.write` sanitizes the member name and renames a collision; it returns the name it wrote, and an
  `embeded://` reference in the card is set from that return value, never from the name asked for.
- The PNG card writer (`StreamChunkWriter`) copies every chunk of the portrait whole except the `chara` and `ccv3` text
  chunks it replaces; a keyword is read from the chunk's own start, so other `tEXt` chunks (`Comment`, `parameters`)
  survive with valid CRCs.
- `importCharacterCardSpec` copies a well-formed `extensions.depth_prompt` (`{ depth: number, prompt: string }`) into
  the native field before it drops the duplicate from the extensions bag.
- Asset references in cards and modules are storage IDs or protocol URIs, never local filesystem paths.
- In-tab PNG reads let a later `chara`/`ccv3` chunk replace the text only while the text held is shorter than 5 MiB;
  there is no size cap on a chunk. CRC is checked only in non-stream reads.
- The server PNG reader (`importPng.ts`) walks chunks from the 8-byte signature and keeps the tab's `tEXt` key/value,
  `chara`/`ccv3` preference and 5 MiB, and asset-index rules. It decodes asset text with the tab's `buffer` package so
  stored asset bytes and keys match; its image bytes match `PngChunk.trim` byte-for-byte.
- It deliberately refuses more malformed or oversized files than the tab reader, before writing anything: a missing PNG
  signature, truncated structure, empty card, oversized card/asset text, or too many asset/total chunks.
- Preserve byte compatibility among `exportModuleLegacy`, `readModule`, and the server's `decodeModuleMain`.
- `createBaseV2` intentionally omits emotions and additional assets. V3 is the full-fidelity path.
- Cards and modules with low-level access require confirmation on import; a `.risum` asks before its upload.

### Asset list rows

- The three asset lists (`CharConfig`, `ModuleMenu`, `AssetInput`) match only the name (`asset[0]`), using a trimmed,
  case-insensitive substring. Empty search skips the name cache and scan. Search resets per owner; paging resets per
  owner/query to `ASSET_LIST_PAGE` (100), and Load More adds 100 matching rows.
- Match sets track only the owner, query, field read and length, so a renamed row stays visible until the query, list
  identity or length changes. `ModuleMenu` and `CharConfig` keep the previous matches only while the live list is the
  one their own rename stored, under the same owner and query.
- A module's list and a character's `additionalAssets`, `emotionImages` and `ccAssets` are immutable (`persistence.md`),
  so every editor replaces them whole (`ModuleMenu`, `CharConfig`, and `characters.ts` `dumpCharImage`,
  `changeCharImage`, `addCharEmotion`, `rmCharEmotion`), a rename copying only its tuple.
- Adds re-resolve the character by `chaId` after their awaits and append to its latest list (`CharConfig`,
  `AssetInput`).
- Rows stay unkeyed and read the live list by matched source index: inputs and deletes write the record, previews and
  prebuilt-exclude use its path, and sticker selection receives its live tuple.
- Never mutate or render editor rows from the shared `moduleFieldPlain`/`characterFieldPlain` values; lowercase names
  live in separate arrays. `characterData()` is reserved for the save loop.

### Effective modules

- The `getModules` memo is keyed by `JSON.stringify([ids, [...personaIds]])` plus the tracked
  `moduleMembershipRevision()`, which every call reads, including a cache hit. Whole-record replacements (local or
  remote, including remote item patches through `applyRaw`), list writes/moves, element rebuilds, and writes under
  `id`/`namespace`/`mcp` advance it synchronously, even inside a write batch.
- Initialization/reset never reuses that revision, and the next call resolves the current list without an effect flush
  or a detached-wrapper read. Asset/lore/trigger edits leave membership alone. `moduleUpdate` uses this same memo and
  publishes its stores under `untrack`.
- `getModuleAssets` returns plain tuples from `moduleFieldPlain(module, "assets")`: never mutate these copies, edit the
  module's record wrapper. A weak tree keyed by the copies preserves each aggregate's identity across other chats' reads
  and disabled-module edits, and its tracked assets revision observes writes immediately.
- `ModuleChatMenu` toggles only the chat/character list. `moduleUpdate` reloads once when the resolved id array or
  element wrappers change (duplicate ids can select a different element via namespaces or persona links). Toggling a
  module already enabled through another source leaves the effective set unchanged and needs no row reload.
- `getModuleTriggers` mutates the triggers' `lowLevelAccess`. Aggregate order follows the DB module order.
- Keep `character.modules`, `chat.modules`, `enabledModules`, and `moduleIntergration` (which matches namespaces)
  distinct.

### Lorebook rows and writers

- Rows over a list that can change under a focused input (`LoreBookList`'s three branches) are keyed by entry and bind
  to the entry captured at mount through getter/setter functions; a read or write whose entry the shown list no longer
  holds is answered with a throwaway value and dropped. `CharConfig`'s emotion and additional-asset tables stay unkeyed
  and write through index-checked rename helpers.
- Never `bind:` `list[i]` in an unkeyed `#each` there: Chrome fires `change` on a focused, edited control while removing
  it, and a lazily resolved index binding then writes into whatever sits at that index now. A removed entry's record
  wrapper throws when read, so never read a captured entry before checking membership.
- `LoreBookList` must rebuild its Svelte arrays after SortableJS DOM moves.
- Old lorebook entries (below `bookVersion` 2) are converted only as they enter: a character's creation
  (`prepareNewCharacter`), a lorebook file imported into a character (`importLoreBook`), and the module import paths
  (`upgradeLorebook`, `shared/modules.ts`); later updates keep their content.
- The chat lorebook writers in `lorebook.svelte.ts` (`addLorebook`/`addLorebookFolder` with a chat target,
  `importLoreBook("local")`) send the chat's whole `localLore`, so they share the
  [lore draft's fence](chat-store.md#whole-chat-writers): while this tab's send (`isLocalSend`) or a job this tab knows
  of (`generatingChatKeys()`) runs in the chat, they refuse with `chatGenerating` and write nothing; the import checks
  at its write, after the file dialog.
- `exportLoreBook("local")` while the selected chat loads refuses with `localLoreExportNotLoaded`. Add and folder
  actions accept character (0) or chat (1) targets; other values write nothing.

### Characters and chats

- `chaId` and chat IDs must be unique. The installation (`initializeRecords`) gives a character without a valid or
  unique id a new one, and a character's id never changes afterwards; chat and message ids are assigned by the chat
  module (`createChat`, `appendMessage`) and kept unique by the server.
- An import path adds a character only through `addCharacter` (and modules, personas, and presets through the collection
  module). The core-app creators (`createNewCharacter`, `createNewGroup`) add through it too.
- A character's chats are created through the chat module once it is in the mirror: `importChat` calls `createChat` (a
  copy gets a fresh chat id and keeps its message ids), and `changeChar` calls `ensureChat` for a character without one.
- A character not yet added (a new card, an import) carries its initial chats in its input. `prepareNewCharacter` gives
  it a first chat when it has none, each chat its `fmIndex` (the character's `firstMsgIndex`) and `localLore`
  (`prepareChatInput`), and moves `postHistoryInstructions` into the note of the chat at `chatPage`.
  `addCharacter`/`replaceCharacterAt` hand the chats to the chat module (`installCharacterChats`: the record holds
  none), and the save loop creates them with the character.

### Personas

- Persona module links activate only through the chat's bound persona (`checkPersonaBinded`, `chat.bindedPersona` on the
  server), never the tab's selected persona; the tab's `getModules` and the server's `jobModules` resolve them alike
  (`personaModuleIdSet`, `personaLinksModule`). `PersonaSettings.svelte` edits the links of the persona the editor shows
  (`currentPersonaRecord`). Deleting a module leaves its id in persona links, as in `chat.modules` and
  `character.modules`.
- `changeUserPersona(id)` with an id that is not in `settings.personas`, or for a chat that is gone, does nothing and
  returns false. `PersonaSettings.svelte` creation captures its target before its dialog; a deletion moves only the
  tab's selection, never a chat's binding.

## Recipes

- Add a card field: `createBaseV2`/`createBaseV3`, `importCharacterCardSpec`, and the `character` type plus its default
  in the server's character normalizer (`normalizeCharacter`). Verify PNG, JSON, and CharX round trips and old Tavern
  input.
- Add an asset kind: the tuple creation in `CharConfig.svelte`/`AssetInput.svelte`, the asset typing in `createBaseV3`,
  the embedding in `exportCharacterCard`, and the resolution in `importCharacterCardSpec`.
- Add a module capability: `RisuModule`, `ModuleMenu.svelte`, `exportModuleLegacy`/`readModule` and the server reader
  (`shared/moduleImport.ts` `decodeModuleMain`, which returns the module as parsed, and
  `server/src/routes/importModule.ts`), a `getModule*` getter, and the consuming code path. Write through the record
  wrappers or collection mutations; membership and assets invalidate synchronously without a refresh call.
- Change the lorebook editor: `LoreBookSetting`/`LoreBookList`/`LoreBookData`, `LoreEntryFields`,
  `LoreOverrideList`/`LoreOverrideRow`. Keep `mode`, `id`, `folder`, and `bookVersion`.
- Change character CRUD: `characters.ts`, `GridCatalog.svelte`, `CharConfig.svelte`. Verify trash restore and groups.

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/characterCards src/ts/characters src/ts/exportBatches src/ts/assetList src/ts/personaImport src/ts/process/modulesImport src/ts/process/lorebook src/lib/SideBars/LoreBook src/lib/SideBars/CharConfig src/lib/Setting/Pages/Module src/lib/Setting/Pages/PersonaSettings src/ts/storage/tests/{moduleCache,personaModuleLinks,moduleImportClient,charxImportClient}`
  for the tab;
  `pnpm --silent test:agent server/src/tests/{importCharx,importModule,importRealm,jobModules}.test.ts shared/tests/{rpack,personaModules}.test.ts`
  for the server and shared code.
- `slow`: `pnpm --silent test:agent --tags-filter=slow server/src/tests/{importPngCaps,importCharx}.test.ts`
  ([test-harness](test-harness.md) `Slow-test table`).
- `e2e`: `e2e/chatLoreOverrides.spec.ts`, `e2e/readersCharacters.spec.ts`, `e2e/recordsCharacters.spec.ts`,
  `e2e/personaBinding.spec.ts`, `e2e/chatBinding.spec.ts` (an imported chat), `e2e/welcomeAndChatSettings.spec.ts` (a
  module hiding the icons).
- `StoreBackedServer` with `bootMutations` (`src/ts/storage/tests/`): the real save adapter over the real server store,
  also answering both file import routes, for the card, module, persona, and lore import tests. Some mock `rpack_js`
  from `rpack_map.bin`.
- `importFixtures.ts`: PNG cards, CharX zips, and V2/V3 cards. The image is a placeholder `IHDR`: readers never decode
  pixels.
- `createResourceTestClient`: the real routes for the server readers; `routeLimits.charxEntryBytes` lowers the entry
  limit for the fast cases.
- `importRealm.test.ts`: `startRealm`, a local stand-in for Realm; expected PNG bytes are built without the server
  reader.
- `importCharx.test.ts` `descriptorArchive`: the `CharXWriter` shape with embedded signatures.
- `LoreOverrideList.test.ts`: over the real records, chat module, and drafts (`installFlatDatabaseWithChats`); rows are
  found by their `stateFor(name)` group name.
- `LoreBookList.test.ts`: a fake `Sortable` records each instance's `disabled` option and destruction.
- Not tested: the `charxJpeg` export variant and the performance cost of lorebook drag sorting.

## Known Hazards

### Issues

- An off-spec card with only `char_name` imports as "unknown name": the check accepts `char_name`, but
  `convertOffSpecCards` reads `name`.
- A bound persona's embedded module joins the effective modules only when a module with its id exists in
  `settings.modules`: the tab's `getModules` and the server's `jobModules` add the persona's `embeddedModule.id`, then
  resolve ids against the stored list only (`getModuleByIds`, `modulesByIds`), so an embedded module never stored
  contributes nothing. Kept for parity as a candidate for a later fix.
- `addModule` does not refuse a duplicate module id, so two modules can share one; `removeModule` removes the module but
  leaves its id in `enabledModules` until that list changes.
- The keyed lore editor rows (`LoreBookList`) key record entries by their wrapper, which follows an element through
  local moves but, across a remote raw replacement, stands for whatever element now sits at its old index. A row kept
  across such a replacement edits the entry now at its index, and a delayed write from it (the prompt's popup editor)
  lands there. `CharConfig`'s emotion and asset tables and `ModuleMenu`'s and `AssetInput`'s asset rows are unkeyed
  index bindings, with the same exposure.

### Limitations

- The in-tab `CharXImporter` (tests only) runs fflate's streaming `Unzip`, which finds the end of a data-descriptor
  entry (every `CharXWriter` entry) by scanning its bytes for the signatures `0x04034b50`, `0x08074b50`, and
  `0x02014b50`: a stored entry whose bytes hold one is cut short and the parser goes on inside it (`unexpected EOF`, an
  unknown compression type), losing the entries after it, `card.json` included. It also keeps a skipped entry's
  compressed bytes in `Unzip` until it is dropped. Decision: Large Asset Import and Export, Remaining Follow-Ups,
  [archive](../archived-plan/README.md).
- An excluded CharX entry (over 50 MiB) that the card references (`embeded://` or `__asset:`) makes
  `importCharacterCardSpec` throw `asset … not found`, so the import fails; both readers exclude alike. Decision: Large
  Asset Import and Export, [archive](../archived-plan/README.md).
- Pinning a duplicate-id original assigns it a fresh id. This can detach another chat's `child` link or make another
  chat's override match a different entry; the previously ambiguous link is not migrated. Decision: Chat Lore Override
  States, duplicate owner ids out of scope, [archive](../archived-plan/README.md).

### Gotchas

- There is no dedicated "duplicate character" API. Copies come from module→character conversion or re-import.
- The drag sort of the keyed lore rows stores a copy of the moved entry (that row gets a new key), and its `recreateStb`
  bumps `sorted`, which recreates every row of that list instance through `{#key sorted}`.
- `characterStore.svelte.ts` imports `./selection.svelte` before anything that loads `../stores.svelte`; the other order
  makes the `stores` and parser module effects read state that is not initialized yet under Vitest (TDZ errors). An
  editor's "optimize imports" undoes it; `pnpm test` catches that.
