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
  - `src/lib/SideBars/LoreBook/{LoreBookSetting,LoreBookList,LoreBookData,LoreEntryFields,LoreOverrideList,LoreOverrideRow}.svelte`
  - `src/lib/Setting/Pages/Module/{ModuleSettings,ModuleMenu,ModuleChatMenu}.svelte`
  - `src/lib/Setting/Pages/PersonaSettings.svelte`
  - `src/lib/Setting/listedPersona.svelte`
  - `src/lib/Others/GridCatalog.svelte`
  - `src/lib/ChatScreens/AssetInput.svelte`
- Not here:
  - Lore activation at prompt time → `chat-pipeline.md`.
  - Asset byte storage (`saveAsset`) → `assets.md`.
  - Bot preset codecs (`downloadPreset`/`importPreset` in `presets.svelte.ts`) → `settings-i18n.md`.
  - The Realm hub → `backup-sync-hub.md`.

## Files

Each module's header or the JSDoc of the identifiers named holds its rules; read it with the code.

### Cards and CharX

- `src/ts/characterCards.ts`: card import, export, the drop/link import, and the Realm/hub helpers (`hubURL`). Import:
  `importCharacterProcess`, `readPngCard`, `importPngCard`, `readCharxCard`, `importCharxCard`,
  `importCharacterCardSpec`, `convertOffSpecCards`. Export: `exportChar`, `exportCharacterCard`, `createBaseV2`,
  `createBaseV3`, `JSON_EXPORT_ASSET_LIMIT`. Its header holds the `statics.imports` counting rule.
- `src/ts/pngChunk.ts`: `PngChunk` (`readGenerator`, `trim`) and `StreamChunkWriter`, the in-tab PNG text chunks.
- `src/ts/process/processzip.ts`: `CharXImporter`, the in-tab CharX reader for bytes and streams only (tests; a file
  goes to the server), and `CharXWriter`.
- `shared/charxImport.ts`: the CharX format both readers follow (`charxEntryKind`, `MAX_CHARX_ENTRY_BYTES`,
  `excludedBeforeReading`) and the zip parsers of `server/src/routes/importCharx.ts`
  ([server resources](server-resources.md)).

### Characters

- `src/ts/characters.ts`: character and group CRUD (`createNewCharacter`, `createNewGroup`, `addCharacter`,
  `changeChar`, `removeChar`, `restoreChar`), the chat file import/export (`importChat`, `exportChat`), and images
  (`makeGroupImage`, `addCharEmotion`, `changeCharImage`).
- Recent ordering on home and mobile reads `characterLastChattedAt` (`src/ts/storage/chatStore.svelte.ts`), which falls
  back to the stored `lastInteraction` ([State](#state)).

### Modules

- `src/ts/process/modules.ts`: `RisuModule`, the codecs (`exportModule`, `exportModuleLegacy`, `readModule`), the
  imports, `getModules` and its `getModule*` getters, and `moduleUpdate`.
- The `.risum` layout and the server reader are `shared/moduleImport.ts` (`decodeModuleMain`, the route
  `server/src/routes/importModule.ts`); `shared/rpack.ts` owns `encodeRPack`/`decodeRPack`, which `src/ts/rpack/`
  bridges for the tab.

### Module import

- `importModuleFile(file: Blob)` (`src/ts/process/modules.ts`, as the rest of this heading) is every `.risum` entry
  point's import: it reads the header, asks `lowLevelAccessConfirm` and runs `prepareModuleImport` before anything is
  sent, then uploads the file once ([import transports](#import-transports)). `serverImportErrorMessage` picks both file
  imports' alert.
- Every module file or data import adds through `addImportedModule` (the MCP URL import, `importMCPModule`, adds
  directly), which waits under `moduleImportSaving` for `flushResources({ scope })`, a save of every pending change:
  `successImport`, `moduleImportDiscarded` (`modules/main` in the scope's `discarded`; an add alone is
  [rebased](resource-sync.md#record-merge)), or `moduleImportUnconfirmed`.
- `importModule` is the module dialog (`.risum`, JSON, lore, regex, `.charx`). `characterURLImport` opens the module
  settings only when the helper reports the save, and consumes `#share_module` once the module was added.

### Personas and conversion

- `src/ts/interchangeability.ts`: module, character, and persona conversions (`convertModuleToCharacter`,
  `convertCharacterToModule`, `convertPersonaToModule`, and the rest).
- `src/ts/persona.ts`: `changeUserPersona` (through `pickBinding`, `src/ts/storage/chatBindingPick.ts`),
  `selectUserImg`, `exportUserPersona`/`importUserPersona`.
- `src/lib/Setting/Pages/PersonaSettings.svelte` (the persona editor) and `src/lib/Setting/listedPersona.svelte`.

### Character editor

- `src/lib/SideBars/CharConfig.svelte`: the character and group editor (emotion and asset tables, group image).
  `customNotificationMessage` (a completion text, [Web Push](network-jobs.md)) is local: the card-license guard does not
  hide it, and `createBaseV2`/`createBaseV3` and the card import never carry it.
- `src/lib/Others/GridCatalog.svelte`: the character catalog.

### Lorebook editor

- `src/lib/SideBars/LoreBook/LoreBookSetting.svelte` (the lore tabs), `src/lib/SideBars/LoreBook/LoreBookList.svelte`
  (`removeEntry`, open details, the filter), `src/lib/SideBars/LoreBook/LoreBookData.svelte` (`activateLocally`, the
  delete cascade), `src/lib/SideBars/LoreBook/LoreEntryFields.svelte` (fields and token counter).
- The editor and the lorebook file codecs (`importLoreBook`/`exportLoreBook`, `src/ts/process/lorebook.svelte.ts`)
  support character and chat lore only; persisted global lore pages remain for snapshots and upstream backups, without a
  UI entry.

### Lorebook filter

- `src/lib/SideBars/LoreBook/LoreBookList.svelte` holds the recursive filter: the outermost list owns the query and the
  match set (`LORE_FILTER`, `filterMatches`, `filterOpens`, `filtering`).

### Chat lore overrides

- `src/lib/SideBars/LoreBook/LoreOverrideList.svelte` / `src/lib/SideBars/LoreBook/LoreOverrideRow.svelte`: the chat
  owner's `globalLore` with an Original/Override/Off state per entry (`stateFor`) and On/Off per folder, matched by
  `mergeOwnerLore` (`shared/lore/overrides.ts`) and written through `useLoreOverridesDraft`
  (`src/ts/storage/loreOverridesDraft.svelte.ts`) after the loaded-chat and [send-fence](#lorebook-rows-and-writers)
  checks. Their contracts hold pinning, folder states, bulk release, turn-off-all, the release recheck, and orphans.
- Off wins over a local activation: the override row, the character local-activation checkbox and the chat `child` row
  use `offOverrideIds` for the off-precedence notices.

### Module settings

- `src/lib/Setting/Pages/Module/ModuleSettings.svelte` (edit and create modes, the share button,
  `clearStaleExportWait`), `src/lib/Setting/Pages/Module/ModuleMenu.svelte` (the module editor), and
  `src/lib/Setting/Pages/Module/ModuleChatMenu.svelte` (the chat's and character's module toggles). The dialog's file
  import is `importModule` ([module import](#module-import)).

### Asset pickers and lists

- The asset pickers (`src/lib/SideBars/CharConfig.svelte`, `src/lib/Setting/Pages/Module/ModuleMenu.svelte`,
  `src/lib/ChatScreens/AssetInput.svelte`, `addCharEmotion`) save the picked `File`s with `savePickedFiles`
  (`src/ts/storage/assetQueue.ts`) and push every row in one write once all are saved; a failed save alerts and adds
  none.
- `src/ts/assetList.ts`: `matchingAssetIndices`, `characterAssetNames`, `moduleAssetNames`, the name search of the
  [asset list rows](#asset-list-rows).

### Import transports

- `src/ts/storage/serverImportClient.ts` `importFileOverServer(path, file, readResult, { onProgress })`: the upload of
  both file imports, the `File`/`Blob` itself as the body of one request, never retried, the NDJSON answer read as it
  streams. Errors: `ServerImportRequestError`, `ServerImportFailedError`, `ServerImportAnswerError`.
- `src/ts/storage/moduleImportClient.ts` `importModuleOverServer` (`POST /api/import/module`, the error classes
  re-exported as `ModuleImport*`) and `src/ts/storage/charxImportClient.ts` `importCharxOverServer`
  (`POST /api/import/charx`, `CharxImportResult`) wrap it.

## Flows

### Card import

`importCharacterProcess` dispatches by extension; the readers' JSDoc holds each format's rules.

- `.json`: read whole, in the tab.
- `.png`: `PngChunk.readGenerator` streams the chunks; `chara-ext-asset_<id>` chunks go to the server in batches
  (`saveAssets`, `POST /api/assets/write`) while the card is read; then `importPngCard`.
- `.charx` and `.jpg`/`.jpeg` (a `charxJpeg`): a `File` or `Blob` is uploaded once (`importCharxOverServer`); the server
  stores the assets and answers the card (`server/src/routes/importCharx.ts`'s route comment). Bytes or a stream (tests)
  go to the in-tab `CharXImporter`. Either way `importCharxCard` follows.
- When `lowLevelAccess` is asked relative to the asset saves, and the key check right before `addCharacter`
  ([characters and chats](#characters-and-chats)), are the header of `src/ts/characterCards.ts`.

### Realm download

Realm downloads use the standard PNG/CharX readers after the server stages a card. The prepare, confirmation, cancel,
and commit contract is owned by [backup-sync-hub](backup-sync-hub.md#realm-download).

### Import results

- The global lore import (`importLoreBook`) writes through `updateCharacter` by the id captured before the file dialog.
- A chat's JSON file carries its structured memory beside `data`, which `importChat` restores behind the action:
  [Chat files](structured-memory/lifecycle.md#chat-files).

### Card export

`exportChar` (groups are not exportable) and `exportModuleLegacy` read the assets from the server through
`loadAssetsInBatches` (`src/ts/storage/assetQueue.ts`, `POST /api/assets/read`) and write through a `LocalWriter`
(`src/ts/globalApi.svelte.ts`). `exportChar` picks the format and delegates to `exportCharacterCard`; the JSDoc of
`exportCharacterCard` and `exportModuleLegacy` holds the asset reads, the JSON cap, missing assets, and which function
alerts. Keep the V2/V3 formats compatible with the existing readers (see [card-format invariants](#card-formats)).

### Drops and deep links

A drop (`src/App.svelte` calls `importDroppedFile`) and `characterURLImport` (links and the launch queue) dispatch by
name and send cards and modules as the `File` or `Blob` itself:

- `.risup`/`.risupreset` → `importPreset` (read into bytes), `.risum` → `importModuleFile` then `addImportedModule`.
- Any other dropped name, and a linked `.charx`/`.jpg`/`.jpeg`/`.png`, → `importCharacterProcess`; a link ignores the
  rest.

### Module activation

`getModules` resolves the effective set: `db.enabledModules`, the chat's and the character's modules, the bound
persona's embedded module (by id, [Issues](#issues)) and linked modules (`personaLinksModule`, `shared/personas.ts`),
and the prompt preset's `moduleIntergration` namespaces. The server's `jobModules` resolves it alike
([personas](#personas)).

## State

- `character`: identity and content fields plus `emotionImages`, `additionalAssets` (`[name, path, ext][]`), `ccAssets`,
  `customscript`, `triggerscript`, `globalLore`, `loreSettings`, `modules`, `lowLevelAccess`, the TTS fields, and
  `trashTime`.
- `lastInteraction` is frozen stored data, never written or migrated: `characterLastChattedAt` uses it only when no chat
  has a time, `withChatsCopy` fills a positive derived time into plugin snapshots, and same-character
  `applyPluginCharacter` setters (`src/ts/plugins/apiV3/v3.svelte.ts`) preserve the stored field, absence included, so a
  round trip never saves the derived value. New characters and imports keep their input value. Upstream export has its
  own cold-storage rule ([backups](backup-sync-hub.md#upstream-database-export)).
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
- In-tab PNG reads let a later `chara`/`ccv3` chunk replace the text only while the text held is shorter than 5 Mi
  characters; there is no size cap on a chunk. No production caller asks for the CRC check (`checkCrc`).
- The server PNG reader (`importPng.ts`) walks chunks from the 8-byte signature and keeps the tab's `tEXt` key/value,
  `chara`/`ccv3` preference and 5 MiB, and asset-index rules. It decodes asset text with the tab's `buffer` package so
  stored asset bytes and keys match; its image bytes match `PngChunk.trim` byte-for-byte.
- It deliberately refuses more malformed or oversized files than the tab reader, before writing anything: a missing PNG
  signature, truncated structure, empty card, oversized card/asset text, or too many asset/total chunks.
- Preserve byte compatibility among `exportModuleLegacy`, `readModule`, and the server's `decodeModuleMain`.
- `createBaseV2` intentionally omits emotions and additional assets. V3 is the full-fidelity path.
- Cards and modules with low-level access require confirmation on import; a `.risum` asks before its upload, and a
  declined card imports nothing (no off-spec JSON fallback).

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
  live in separate arrays. `characterData()` exposes the raw list untracked: use it only for synchronous, read-only
  lookups or projections, capture a stable `chaId` before awaiting, and write UI edits through record wrappers or
  collection mutations.

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
  module already enabled through another source leaves the effective set unchanged unless ids or namespaces collide
  (chat and character tokens also match namespaces, persona links only ids).
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

- Focused tab tests:
  `pnpm --silent test:agent src/ts/characterCards src/ts/characters src/ts/exportBatches src/ts/assetList src/ts/personaImport src/ts/process/modulesImport src/ts/process/lorebook src/lib/SideBars/LoreBook src/lib/SideBars/CharConfig src/lib/Setting/Pages/Module src/lib/Setting/Pages/PersonaSettings src/ts/storage/tests/{moduleCache,personaModuleLinks,moduleImportClient,charxImportClient}`.
- Focused server/shared tests:
  `pnpm --silent test:agent server/src/tests/{importCharx,importModule,importRealm,jobModules}.test.ts shared/tests/{rpack,personaModules}.test.ts`.
- `slow`: `pnpm --silent test:agent --tags-filter=slow server/src/tests/{importPngCaps,importCharx}.test.ts`; `e2e`:
  `e2e/chatLoreOverrides.spec.ts`, `e2e/readersCharacters.spec.ts`, `e2e/recordsCharacters.spec.ts`,
  `e2e/personaBinding.spec.ts`, `e2e/chatBinding.spec.ts`, and `e2e/welcomeAndChatSettings.spec.ts`.
- Import harnesses: `StoreBackedServer` connects the client save adapter and server store; `createResourceTestClient`
  exercises real import routes with lowered limits. `importFixtures.ts` supplies PNG, CharX, and V2/V3 cards;
  `importRealm.test.ts` uses a local Realm stand-in. Some module tests mock the ignored `rpack_map.bin` payload.
- Lore editor tests use real records/chat drafts; `LoreBookList` uses a fake SortableJS instance.
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
