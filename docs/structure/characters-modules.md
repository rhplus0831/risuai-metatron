# Characters, Cards, Modules, Personas

## Scope

- Owns character and group CRUD, card import and export (PNG, JSON, CharX, V2/V3, off-spec Tavern), PNG tEXt chunks,
  CharX zip read and write, modules (the `.risum` codec, activation, the effective-set getters),
  module/character/persona conversion, personas, and the character and lorebook editor UI.
- Paths:
  - `src/ts/{characterCards,characters,persona,pngChunk,interchangeability,assetList,lowLevelAccessImport}.ts`
  - `src/ts/process/{processzip,modules}.ts`
  - `src/ts/rpack/` (client bridge to the shared codec)
  - `shared/{charxImport,moduleImport,rpack}.ts`
  - Format readers: `server/src/routes/{importCharx,importModule,importPng}.ts`
  - `src/lib/SideBars/CharConfig.svelte`
  - `src/lib/SideBars/LoreBook/{LoreBookSetting,LoreBookList,LoreBookData,LoreEntryFields,LoreOverrideList,LoreOverrideRow}.svelte`
  - `src/lib/Setting/Pages/Module/{ModuleSettings,ModuleMenu,ModuleChatMenu,ModuleFolderRow}.svelte`,
    `src/lib/Setting/Pages/Module/moduleCatalog.ts`
  - `src/lib/Setting/Pages/PersonaSettings.svelte`, `src/lib/Setting/Pages/personaGrid.ts`
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
- Recent ordering on home and mobile reads `characterLastChattedAt` (`src/ts/storage/chatStore.svelte.ts`,
  [State](#state)).

### Modules

- `src/ts/process/modules.ts`: `RisuModule`, the codecs (`exportModule`, `exportModuleLegacy`, `readModule`), the
  imports, `getModules` and its `getModule*` getters, and `moduleUpdate`.
- The `.risum` layout and the server reader are `shared/moduleImport.ts` (`decodeModuleMain`, the route
  `server/src/routes/importModule.ts`); `shared/rpack.ts` owns `encodeRPack`/`decodeRPack`, which `src/ts/rpack/`
  bridges for the tab.

### Module import

- `src/ts/process/modules.ts`: `importModuleFile`, `prepareModuleImport`, `addImportedModule`, `importModule`, and
  `serverImportErrorMessage`. File imports go through `importModuleFile`; the MCP URL path `importMCPModule` adds
  directly. `addImportedModule` waits for the save acknowledgement before reporting success, and a card import does the
  same for its character and first chat (an unconfirmed save is reported; the records stay in memory and in the
  journal).
- `characterURLImport` opens module settings after a saved import and consumes `#share_module` once the module was
  added. Upload paths and response handling are in [Import transports](#import-transports).

### Personas and conversion

- `src/ts/interchangeability.ts`: module, character, and persona conversions (`convertModuleToCharacter`,
  `convertCharacterToModule`, `convertPersonaToModule`, and the rest).
- `src/ts/persona.ts`: `changeUserPersona(id, target)` (through `pickBinding`, `src/ts/storage/chatBindingPick.ts`: a
  `ChatRef` binds that chat, `null` selects for the tab), `selectUserImg`, `exportUserPersona`/`importUserPersona`
  (returns the new persona's id, or null on every path that adds none).
- `src/lib/Setting/Pages/PersonaSettings.svelte` edits the tab's persona. The grid opens at the root or shows one folder
  (`openFolderId`); the editor's Folder control acts on `editedPersonaRecord()`. Drag sorting uses
  `src/lib/Setting/Pages/personaGrid.ts` `reorderShown`, preserving the list positions of personas outside this view.
- `src/lib/Setting/listedPersona.svelte` is the separate flat picker, including when opened from a chat's binding panel.
  It passes its `chatRef` or `null` to `changeUserPersona`.

### Character editor

- `src/lib/SideBars/CharConfig.svelte`: the character and group editor (emotion and asset tables, group image).
  `customNotificationMessage` (a completion text, [Web Push](network-jobs.md)) is local: the card-license guard does not
  hide it, and `createBaseV2`/`createBaseV3` and the card import never carry it.
- `src/lib/Others/GridCatalog.svelte`: the character catalog.

### Lorebook editor

- `src/lib/SideBars/LoreBook/LoreBookSetting.svelte` (the lore tabs), `src/lib/SideBars/LoreBook/LoreBookList.svelte`
  (`removeEntry`, open details, `LORE_FILTER`, `filterMatches`), `src/lib/SideBars/LoreBook/LoreBookData.svelte`
  (`activateLocally`, the delete cascade), `src/lib/SideBars/LoreBook/LoreEntryFields.svelte` (fields and token
  counter).
- The editor and the lorebook file codecs (`importLoreBook`/`exportLoreBook`, `src/ts/process/lorebook.svelte.ts`)
  support character and chat lore only; persisted global lore pages remain for snapshots and upstream backups, without a
  UI entry.

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
  `src/lib/Setting/Pages/Module/ModuleChatMenu.svelte` (the chat's and character's module toggles).
- Catalog export captures the module id before its dialog and resolves it afterwards, cancelling if absent. Exporters
  receive detached records. Catalog deletion captures the named row's identity before confirmation and cancels if that
  row is removed or replaced. `ModuleMenu` regex, lorebook, and asset imports capture backing-module identity before
  picking and recheck after upload, cancelling on navigation, replacement, removal, or editor destruction.
- `src/lib/Setting/Pages/Module/moduleCatalog.ts` builds both the catalog and chat menu rows (`moduleCatalog`,
  `catalogRows`). It resolves membership in stored folder order before sorting by name. Search forces matching folders
  open. `src/lib/Setting/Pages/Module/ModuleFolderRow.svelte` renders the shared folder row with
  [device-local fold state](ui-theming.md#state).
- A catalog move captures the module id and `folderChoices` before asking. After the answer, `choiceForAnswer` maps to
  the captured folder id or the root, filing rows with the same id together. `moveItemToFolder` requires the module and
  any chosen folder to still exist. Use the collection store for folder writes. Folder deletion keeps the modules.
- A folder's switch acts on every current member, even while search shows only matches. `switchAllGlobally` changes
  `enabledModules` once. `switchAllForChat` changes the chat's `modules` once via `setCurrentChatMeta`, skipping
  globally enabled modules. Character activation stays per module.

### Asset pickers and lists

- The asset pickers (`src/lib/SideBars/CharConfig.svelte`, `src/lib/Setting/Pages/Module/ModuleMenu.svelte`,
  `src/lib/ChatScreens/AssetInput.svelte`, `addCharEmotion`) save the picked `File`s with `savePickedFiles`
  (`src/ts/storage/assetQueue.ts`) and push every row in one write once all are saved; a failed save alerts and adds
  none.
- `src/ts/assetList.ts`: `matchingAssetIndices`, `characterAssetNames`, `moduleAssetNames`, the name search of the
  [asset list rows](#asset-list-rows).

### Import transports

- `src/ts/storage/serverImportClient.ts` `importFileOverServer` uploads the file and reads the NDJSON answer.
  `src/ts/storage/moduleImportClient.ts` `importModuleOverServer` and the `ModuleImport*` error classes, and
  `src/ts/storage/charxImportClient.ts` `importCharxOverServer` select the routes; their response contracts are in
  `src/ts/process/modules.ts` and `shared/charxImport.ts`.

## Flows

### Card import

`importCharacterProcess` dispatches by extension; format details stay in its source and reader comments. PNG imports
stream chunks and upload assets in batches. A CharX/JPEG `File` or `Blob` goes to the server once; bytes or a stream use
the in-tab importer in tests. The low-level access question and the final asset-key check happen before the character is
added (`src/ts/characterCards.ts`).

### Realm download

Realm downloads use the standard PNG/CharX readers after the server stages a card. The prepare, confirmation, cancel,
and commit contract is owned by [backup-sync-hub](backup-sync-hub.md#realm-download).

### Import results

- `importLoreBook("global")` writes the character's lore through `updateCharacter`, using the id captured before the
  file dialog. The `"local"` path targets the captured chat and respects the [send fence](#lorebook-rows-and-writers).
  Settings-level global lore pages have no import action here.
- A chat's JSON file carries its structured memory beside `data`, which `importChat` restores behind the action:
  [Chat files](structured-memory/lifecycle.md#chat-files).

### Card export

`exportChar` chooses the card format; `exportCharacterCard` and `exportModuleLegacy` read assets in batches and write
through a `LocalWriter`. Their source comments own the size, missing-asset, and failure contracts. Keep V2/V3 output
compatible with existing readers ([card formats](#card-formats)).

### Drops and deep links

`src/App.svelte` passes drops to `importDroppedFile`; `characterURLImport` handles links, shares, and launch-queue
files. CharX/JPEG cards and `.risum` modules upload as `File`/`Blob`; PNG cards stream through the tab's PNG reader and
upload extracted assets, while preset imports read bytes. Module shares are consumed after the module is added
([module import](#module-import)).

## State

- Character, group, and persona fields belong to resource records; chats live in the chat module, not on the character
  record ([persistence](persistence.md)). `shared/personas.ts` owns persona defaults and canonical module links.
- Module and persona folder records (`moduleFolders`, `personaFolders`) name member ids. The item lists remain
  authoritative for which items exist. Read membership with `folderOfItem` or `groupByFolder` in
  `shared/itemFolders.ts`, including for conflicting or stale member ids. Folders affect neither `getModules` /
  `jobModules` nor an individual module or persona file. See [resource records](persistence.md#resources) for merging
  and [upstream database export](backup-sync-hub.md#upstream-database-export) for compatibility.
- `lastInteraction` is preserved stored data; home ordering derives from it only when no chat has a timestamp. Plugin
  snapshots may expose that derived value without saving it back (`src/ts/plugins/apiV3/v3.svelte.ts`); upstream export
  has its own cold-storage rule ([backups](backup-sync-hub.md#upstream-database-export)).

## Coupling

- Depends on `database.svelte.ts`, `stores.svelte.ts` (`ReloadGUIPointer`, `moduleBackgroundEmbedding`),
  `selection.svelte.ts`, `globalApi` assets and writers, `alert.ts`, `util.ts`, `media/`, the lorebook codecs, scripts,
  triggers.
- `@risuai/ccardlib` is imported for types only. There is no runtime validation.

## Invariants

### Card formats

- Keep the V2 `chara` and V3 `ccv3` readers, off-spec Tavern handling, `convertCharbook` migrations, and V2
  `character_version` behavior. `src/ts/characterCards.ts` owns the client import/export details.
- The client and server CharX readers share entry rules in `shared/charxImport.ts`; the server parses the central
  directory and the test-only in-tab reader scans signatures, the intended D5 difference in `STRUCTURE.md`. Always await
  `CharXImporter.done()` and preserve an embedded `module.risum`.
- Keep client/server PNG card and asset-index behavior aligned; the server reader intentionally refuses more malformed
  or oversized input before writing. Reader details live in `src/ts/pngChunk.ts` and `server/src/routes/importPng.ts`.
- Card asset references are storage IDs or protocol URIs, never local filesystem paths; exporter numbering follows the
  original asset lists, not the order assets were fetched.
- V3 JSON export refuses an asset whose compressed base64 text reaches the importer's strict 50 MiB limit, naming it
  with `jsonExportAssetTooLarge` and directing the user to CharX; the total decoded-byte cap remains 64 MiB.
- `exportModuleLegacy` refuses modules with an icon before encoding or writer initialization
  (`moduleLegacyExportIconUnsupported`); CharX carries the portrait.
- `importCharacterCardSpec` maps a well-formed `extensions.depth_prompt` to the native field. `createBaseV2` omits
  emotions and additional assets; `createBaseV3` includes both. Local fields such as `customNotificationMessage` stay
  out of both card formats.
- Every card and module export passes asset bytes through `compressImage`
  (`src/ts/media/compressImage/compressImage.ts`): with `db.imageCompression` on, the default, a JPEG, PNG, GIF, or BMP
  is re-encoded as WebP at quality 0.75 with its longer side capped at 3000 px, so no export form keeps those bytes.
  Stored originals are untouched. The export's completion notice says how many images came out with other bytes
  (`exportReencodedImages`), and the setting's help text names characters and modules.
- A card whose `character_book` sets `scan_depth`, `token_budget`, and `recursive_scanning` imports as `loreSettings`,
  overriding the global lorebook settings; its success notice (`importedCharacterNotice`) appends
  `importedLoreSettings.warning` and lists each value beside the global one.
- Cards and modules with low-level access ask on import (`confirmLowLevelAccessImport`,
  `src/ts/lowLevelAccessImport.ts`): import with it, without it, or cancel (Escape cancels). Without it clears the flag
  on the object the record is later built from, so the record stores `lowLevelAccess: false`; importers must not re-read
  the card or module after the question. A `.risum` asks before upload, and a cancelled card imports nothing without
  falling through to the off-spec JSON reader.
- A module file or link never brings an MCP server: `readModule`, `importModuleFile`, the module JSON branch of
  `importModule`, and `#import_module=` delete `mcp` (`stripImportedModuleMcp`); only `importMCPModule` adds one. The
  user-facing paths report a dropped field with one `moduleImportMcpDropped` toast that `addImportedModule` installs
  after a confirmed save, behind any success dialog; `readModule` (CharX embeds) drops it silently.

### Asset list rows

- `src/ts/assetList.ts` matches trimmed, case-insensitive substrings in asset names and supplies paging indices;
  `CharConfig` and `ModuleMenu` keep rename rows visible while their own list replacement is current.
- Module assets and character asset/emotion lists are immutable: editors replace the whole list, and a rename copies its
  tuple. New file picks append to the latest character list after resolving `chaId` again.
- The editor rows address source indices. Never carry a row index across an owner or list replacement; the sticker
  picker reads the current tuple. `AssetInput` selects but does not rename rows.
- `moduleFieldPlain` and `characterFieldPlain` return detached read copies; `characterData()` is an untracked raw list
  for synchronous lookups only. Write through record wrappers or collection mutations.

### Effective modules

- `getModules` combines global, character, chat, bound-persona, and prompt-preset sources. Id/namespace matching and
  persona-link matching differ; the server's `jobModules` in `server/src/jobs/cbsHost.ts` must stay aligned.
- Persona links use the chat's bound persona, match stored modules by id, and skip MCP modules. The bound persona's
  embedded module resolves to a stored module with its id when present; otherwise the embedded object is appended.
- `addModule` refuses duplicate ids. `removeModule` clears the id from global `enabledModules` and `moduleFolders` when
  the last row with that id is deleted. Persona, character and chat module links keep their ids.
- Keep `character.modules`, `chat.modules`, `enabledModules`, and `moduleIntergration` distinct. Membership revisions
  invalidate the `getModules` memo synchronously; `getModuleAssets` returns detached tuples and must not be mutated.

### Lorebook rows and writers

- `LoreBookList` rows are keyed by entry and guard reads/writes against live-list membership; a remote replacement or
  removal drops the old row's write. Its tests cover focused-field removal. `CharConfig` and `ModuleMenu` asset/emotion
  name rows remain index-addressed; owner changes or outside row replacement release a focused name input
  (`guardNameFocus`), including list shrink, so the next key writes nowhere; a local rename keeps its input and caret.
- `LoreBookList` rebuilds its Svelte arrays after SortableJS DOM moves. Avoid `bind:list[i]` in any other unkeyed list
  that can change while a focused input is removed.
- Old lorebook entries (below `bookVersion` 2) are converted only as they enter: a character's creation
  (`prepareNewCharacter`), a lorebook file imported into a character (`importLoreBook`), and the module import paths
  (`upgradeLorebook`, `shared/modules.ts`); later updates keep their content.
- V2/V3 card writers carry each lore entry's `bookVersion` in `extensions.risu_bookVersion`; `convertCharbook` restores
  numeric versions before creation's legacy text migration. Missing or nonnumeric versions retain that migration.
- The chat lorebook writers in `lorebook.svelte.ts` (`addLorebook`/`addLorebookFolder` with a chat target,
  `importLoreBook("local")`) send the chat's whole `localLore`, so they share the
  [lore draft's fence](chat-store.md#whole-chat-writers): while this tab's send (`isLocalSend`) or a job this tab knows
  of (`generatingChatKeys()`) runs in the chat, they refuse with `chatGenerating` and write nothing; the import checks
  at its write, after the file dialog.
- `exportLoreBook("local")` while the selected chat loads refuses with `localLoreExportNotLoaded`.
- Under the lore draft's fence the chat's lore is read-only, not undone after an edit: the chat tab shows the
  `chatGenerating` notice and disables its rows, folder lists, drag (`locked`), add, folder and import buttons, CHAT
  bulk toggle, override controls and orphan buttons; export and the character tab stay. The local activation checkbox is
  disabled from any tab.
- A character entry whose ids the fenced chat links is not deleted, so its `child` links never outlive it. The
  write-time checks stay for a fence that arrives during a dialog or a file picker.
- Character identity is `chaId`; imports and core creators add through `characterStore`. Create, copy, or ensure chats
  through the chat module after the character is in its mirror. See [persistence](persistence.md) and
  [chat store](chat-store.md#chat-writes) for chat ownership. `importChat` validates every chat before adding folders or
  chats.
- Before insertion, `prepareNewCharacter` supplies a first chat when needed, moves `postHistoryInstructions` into the
  selected chat note, and prepares `fmIndex` and `localLore`; the character record itself holds no chats.

### Personas

- Module links resolve from the chat's bound persona, never the tab's selected persona; client `getModules` and server
  `jobModules` share `personaModuleIdSet`/`personaLinksModule`. Persona settings edit the shown record, and deleting a
  module leaves its id in the persona, character, or chat list.
- `changeUserPersona(id, target)` with an id that is not in `settings.personas`, or for a chat that is gone, does
  nothing and returns false. `PersonaSettings.svelte` edits the tab's selected persona: a grid click and a created
  persona select for the tab (`null`), also with a chat open; a deletion moves only the tab's selection, never a chat's
  binding.
- `removePersona` (`collectionStore.svelte.ts`) is the store's deletion: it refuses the last persona, moves the tab's
  selection off the deleted one first, and takes the id out of `personaFolders` in the same batch. The folder record and
  the item record save apart, so a deletion that saves alone leaves a stale member id, which the read rules ignore.
- In the grid only persona tiles participate in a drag. Sorting reorders the visible personas without moving other
  personas or changing folder membership (`reorderShown`). Changing folders rebuilds the Sortable instance.
- A persona created with the add tile, or imported by either import button, while a folder is open is filed into the
  folder that was open at the click, when it still exists; a created one is selected for the tab, an imported one is
  not. The page's deletion goes through `removePersona`.

## Recipes

- Add a card field: `createBaseV2`/`createBaseV3`, `importCharacterCardSpec`, the `character` type in
  `shared/database.ts`, and its default in `normalizeCharacter` (`shared/characters.ts`;
  [persistence](persistence.md#invariants)). Verify PNG, JSON, and CharX round trips and old Tavern input.
- Add an asset kind: the tuple creation in `CharConfig.svelte`/`AssetInput.svelte`, the asset typing in `createBaseV3`,
  the embedding in `exportCharacterCard`, and the resolution in `importCharacterCardSpec`.
- Add a module capability: `RisuModule`, `ModuleMenu.svelte`, `exportModuleLegacy`/`readModule` and the server reader
  (`shared/moduleImport.ts` `decodeModuleMain`, which returns the module as parsed, and
  `server/src/routes/importModule.ts`), a `getModule*` getter, and the consuming code path. Write through the record
  wrappers or collection mutations; membership and assets invalidate synchronously without a refresh call.
- Change the lorebook editor: `LoreBookSetting`/`LoreBookList`/`LoreBookData`, `LoreEntryFields`,
  `LoreOverrideList`/`LoreOverrideRow`. Keep `mode`, `id`, `folder`, and `bookVersion`.
- Change module or persona folders: update the shared folder reader for membership rules and the collection store for
  writes. For display or ordering, change `moduleCatalog` (catalog and chat menu) or `PersonaSettings` and
  `reorderShown` (grid). Verify deletion, a filtered or folder-only view, and a stale member id.
- Change character CRUD: `characters.ts`, `GridCatalog.svelte`, `CharConfig.svelte`. Verify trash restore and groups.

## Tests

- Focused tab tests:
  `pnpm --silent test:agent src/ts/characterCards src/ts/characters src/ts/exportBatches src/ts/assetList src/ts/personaImport src/ts/process/modulesImport src/ts/process/lorebook src/lib/SideBars/LoreBook src/lib/SideBars/CharConfig src/lib/Setting/Pages/Module src/lib/Setting/Pages/PersonaSettings src/lib/Setting/Pages/personaGrid src/ts/storage/tests/{moduleCache,personaModuleLinks,moduleImportClient,charxImportClient}`.
- Persona picker and catalog UI tests:
  `pnpm --silent test:agent src/lib/Setting/listedPersona.test.ts src/lib/Others/GridCatalog.test.ts`.
- Folder readers, mutations, and device-local fold state:
  `pnpm --silent test:agent shared/itemFolders.test.ts src/ts/storage/tests/collectionStore.test.ts src/ts/gui/itemFolderFold.test.ts`.
- Focused server/shared tests:
  `pnpm --silent test:agent server/src/tests/{importCharx,importModule,importRealm,jobModules}.test.ts shared/tests/{rpack,personaModules}.test.ts`.
- `slow`: `pnpm --silent test:agent --tags-filter=slow server/src/tests/{importPngCaps,importCharx}.test.ts`; `e2e`:
  `e2e/chatLoreOverrides.spec.ts`, `e2e/readersCharacters.spec.ts`, `e2e/recordsCharacters.spec.ts`,
  `e2e/personaBinding.spec.ts`, `e2e/chatBinding.spec.ts`, and `e2e/welcomeAndChatSettings.spec.ts`.
- Import harnesses: `StoreBackedServer` connects the client save adapter and server store; `createResourceTestClient`
  exercises real import routes with lowered limits. `importFixtures.ts` supplies PNG, CharX, and V2/V3 cards;
  `importRealm.test.ts` uses a local Realm stand-in. Tests run the real RPack codec.
- Lore editor tests use real records/chat drafts; `LoreBookList` uses a fake SortableJS instance.
- Not tested: the `charxJpeg` export variant, real ZIP64 or CharX imports larger than 4 GiB through
  `server/src/routes/importCharx.ts` `planCharxFile`, the performance cost of lorebook drag sorting, and its recovery
  after the lorebook filter clears (`onEnd`).

## Known Hazards

### Limitations

- Folders are one level deep, and the chat's persona picker, the binding panel, and a persona's module links are flat.
  Folder reads ignore member ids whose items are gone, even if a remote deletion leaves the ids stored. See the
  [decision in the archive](../archived-plan/README.md) at `50c75d147`.
- `CharConfig.svelte`'s additional-asset picker and `characters.ts` `addCharEmotion` call `savePickedFiles` without
  `onProgress`, so picked-file saves show no upload progress. Decision: Large Asset Import and Export, kept limits,
  [archive](../archived-plan/README.md).
- The in-tab `CharXImporter` (tests only) runs fflate's streaming `Unzip`, which finds the end of a data-descriptor
  entry (every `CharXWriter` entry) by scanning its bytes for the signatures `0x04034b50`, `0x08074b50`, and
  `0x02014b50`: a stored entry whose bytes hold one is cut short and the parser goes on inside it (`unexpected EOF`, an
  unknown compression type), losing the entries after it, `card.json` included. It also keeps a skipped entry's
  compressed bytes in `Unzip` until it is dropped. Decision: Large Asset Import and Export, kept limits,
  [archive](../archived-plan/README.md).
- An excluded CharX entry (over 50 MiB) that the card references (`embeded://` or `__asset:`) makes
  `importCharacterCardSpec` throw `asset … not found`, so the import fails; both readers exclude alike. Decision: Large
  Asset Import and Export, [archive](../archived-plan/README.md).
- Pinning a duplicate-id original assigns it a fresh id. This can detach another chat's `child` link or make another
  chat's override match a different entry; the previously ambiguous link is not migrated. Decision: Chat Lore Override
  States, duplicate owner ids out of scope, [archive](../archived-plan/README.md).

### Gotchas

- `LoreEntryFields.svelte` calls `tokenCountInput` inside its content effect, so CBS expansion runs synchronously on
  each content edit before `createTokenCountField` debounces the server count; expensive CBS still occupies the tab
  while typing.
- `LoreOverrideList.svelte` keys orphan rows by override object, so legacy duplicate ids remain separate rows and
  `resolveOrphan` removes only the selected object. `server/src/data/chats.ts` `normalizeChatMeta` collapses their
  stored ids with `firstOverridePerId` on a metadata write; a normalized reread can therefore collapse the rows.
- In `src/ts/exportBatches.test.ts`, `afterEach` resets timers and mocks but does not cancel a timed-out async body;
  that body can resume against the next case's fakes, so later failures can be secondary.
- There is no dedicated "duplicate character" API. Copies come from module→character conversion or re-import.
- The lorebook filter query resets on an owner change, not a same-owner module replacement (`LoreBookList.filterOwner`).
- The drag sort of the keyed lore rows stores a copy of the moved entry (that row gets a new key), and its `recreateStb`
  bumps `sorted`, which recreates every row of that list instance through `{#key sorted}`.
- `characterStore.svelte.ts` imports `./selection.svelte` before anything that loads `../stores.svelte`; the other order
  makes the `stores` and parser module effects read state that is not initialized yet under Vitest (TDZ errors). An
  editor's "optimize imports" undoes it; `pnpm test` catches that.
