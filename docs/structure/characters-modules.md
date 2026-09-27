# Characters, Cards, Modules, Personas, Loadouts

## Scope

- Owns:
  - character and group CRUD,
  - character card import and export (PNG, JSON, CharX, V2/V3, off-spec Tavern),
  - PNG tEXt chunks,
  - CharX zip read and write,
  - modules (the `.risum` codec, activation, the effective-set getters),
  - module/character/persona conversion,
  - personas, loadouts,
  - the character editor and lorebook editor UI.
- Paths:
  - `src/ts/{characterCards,characters,persona,loadout,pngChunk,interchangeability}.ts`
  - `src/ts/process/{processzip,modules}.ts`
  - `src/lib/SideBars/CharConfig.svelte`
  - `src/lib/SideBars/LoreBook/*`
  - `src/lib/Setting/Pages/Module/*`
  - `src/lib/Setting/Pages/PersonaSettings.svelte`
  - `src/lib/Setting/listedPersona.svelte`
  - `src/lib/Others/{LoadoutModal,GridCatalog}.svelte`
  - `src/lib/ChatScreens/AssetInput.svelte`
- Not here:
  - Lore activation at prompt time → `chat-pipeline.md`.
  - Asset byte storage (`saveAsset`) → `global-api.md`.
  - Bot preset codecs (`downloadPreset`/`importPreset` in `database.svelte.ts`) → `settings-i18n.md`.
  - The Realm hub → `backup-sync-hub.md`.

## Files

- `characterCards.ts`: card import, export, and hub helpers.
  - Import: `importCharacter` (file picker), `importCharacterProcess` (dispatch by extension), private `importCharacterCardSpec` (V2/V3), `convertOffSpecCards`, `convertCharbook`.
  - Export: `exportChar` (dialog), `exportCharacterCard` (writer), `createBaseV2`/`createBaseV3`.
  - Hub and links: `characterURLImport` (deep links and shares), `hubURL`, `getRisuHub`/`downloadRisuHub`/`getRealmInfo`. `hubURL` is `/hub-proxy` on Node, otherwise `https://sv.risuai.xyz`.
- `characters.ts`: character lifecycle.
  - Create and select: `addCharacter`, `createNewCharacter`, `createBlankChar`, `createNewGroup`, `changeChar` (runs `characterFormatUpdate`).
  - Delete: `removeChar` (soft delete via `trashTime`, or permanent).
  - `updateLorebooks`, plus image, emotion, and chat import/export helpers.
- `pngChunk.ts` `PngChunk`: `read`, `readGenerator` (streaming), `trim`, `write`, `streamWriter`. Other chunks are preserved.
- `process/processzip.ts`:
  - `CharXWriter`: sanitizes and uniquifies asset names, skips files over 50 MiB.
  - `CharXImporter`: `parse`, then `done()` must be awaited.
  - `processZip`: used by NovelAI image ZIPs.
- `process/modules.ts`: modules.
  - `RisuModule`.
  - Codecs: `exportModule` (CharX via character conversion), `exportModuleLegacy`/`readModule` (`.risum`: magic byte `111`, version `0`, RPack JSON plus asset records), `importModule` (JSON, lorebook JSON, regex JSON, `.risum`, `.charx`).
  - Effective sets: `getModules`, then `getModuleLorebooks`, `getModuleAssets`, `getModuleTriggers`, `getModuleRegexScripts`, `getModuleToggles`, `getModuleMcps`.
  - `applyModule`, `moduleUpdate`, `refreshModules`.
- `interchangeability.ts`: `convertModuleToCharacter`, `convertCharacterToModule`, persona↔character, persona↔module (an embedded module ID is normalized to `$embedded`).
- `persona.ts`: `saveUserPersona`, `changeUserPersona`, `selectUserImg`. `exportUserPersona`/`importUserPersona` use a PNG `persona` tEXt chunk.
- `loadout.ts`: `Loadout`, `makeLoadout`, `applyLoadout`, `saveCurrentLoadout`. `exportLoadout`/`importLoadout` are TODO stubs.
- UI:
  - `CharConfig.svelte`: the main editor, binding `DBState.db.characters[$selectedCharID]`. Tabs cover identity, greetings, images, emotions, assets, lore, regex, triggers, TTS, export, and delete.
  - Lorebook:
    - `LoreBookSetting.svelte`: tabs for character, chat, and settings.
    - `LoreBookList.svelte`: SortableJS lists and folders.
    - `LoreBookData.svelte`: a single entry. `activateLocally` creates a `mode:'child'` link.
  - Modules:
    - `ModuleSettings.svelte`: the catalog.
    - `ModuleMenu.svelte`: the editor.
    - `ModuleChatMenu.svelte`: per-chat and per-character toggles.
  - `GridCatalog.svelte`: the catalog plus trash.
  - `LoadoutModal.svelte`.
  - `AssetInput.svelte`: chat stickers from `additionalAssets`.

## Flows

Import (`importCharacterProcess`):

- `.json`: `importCharacterCardSpec`, falling back to `convertOffSpecCards`.
- `.png`/`.jpg`:
  1. `PngChunk.readGenerator` reads the `chara` (V2) and `ccv3` (V3) keys. `ccv3` wins when both exist.
  2. `chara-ext-asset_<id>` chunks carry the assets.
  3. Legacy `rccv1` cards are decrypted.
- `.charx`:
  1. `CharXImporter` reads `card.json`, the optional `module.risum` (its triggers, regex, and lore are merged in), and the assets.
  2. `await done()`.
- V3 asset URIs: `__asset:<id>`, `embeded://path`, `ccdefault:`, `data:`.
- The result is a new `character` with a fresh `chaId`, pushed to `DBState.db.characters`.

Export (`exportChar`, groups are not exportable):

- V3 PNG: `ccv3` plus `chara-ext-asset_*` chunks.
- V3 JSON: assets as data URIs.
- CharX: `card.json`, `module.risum`, `assets/...`, `x_meta/...`.
- V2 PNG: `chara`. This is the default in `exportCharacterCard` for compatibility.

Drops and deep links (`App.svelte`, `characterURLImport`):

- `.risup`/`.risupreset` → `importPreset`.
- `.risum` → `readModule`.
- Anything else → `importCharacterProcess`.

Module activation (`getModules`): the union of:

1. `db.enabledModules` (global),
2. `chat.modules`,
3. `character.modules`,
4. the bound persona's embedded module,
5. namespace matches in `db.moduleIntergration`.

The consumers are lorebook, scripts, triggers, parser assets, CBS, MCP, and `ChatBody`.

## State

- `character`: identity and content fields plus `emotionImages`, `additionalAssets` (`[name, path, ext][]`), `ccAssets`, `customscript`, `triggerscript`, `globalLore`, `loreSettings`, `modules`, `lowLevelAccess`, the TTS fields, and `trashTime`.
- `groupChat`: `type:'group'`, `characters: string[]`, `characterTalks`, `characterActive`, `autoMode`, `useCharacterLore`.
- `loreBook`: `key`/`secondkey` (comma-separated), `content`, `insertorder`, `alwaysActive`, `selective`, `mode` (`normal|folder|child|...`), `useRegex`, `id`, `folder`, `bookVersion`.
- `RisuModule`: `id`, `name`, `lorebook`, `regex`, `trigger`, `assets`, `backgroundEmbedding`, `customModuleToggle`, `namespace`, `lowLevelAccess`, `hideIcon`, `mcp`.
- `RisuPersona`: `name`, `icon`, `personaPrompt`, `note`, `id`, `largePortrait`, `embeddedModule`. The active persona is mirrored into the legacy DB fields `username`, `userIcon`, `personaPrompt`, `userNote`.

## Coupling

- Depends on `database.svelte.ts`, `stores.svelte.ts` (`selectedCharID`, `ReloadGUIPointer`, `moduleBackgroundEmbedding`), `globalApi` assets and writers, `alert.ts`, `util.ts`, `media/`, the lorebook codecs, scripts, triggers.
- `@risuai/ccardlib` is imported for types only. There is no runtime validation.

## Invariants

- Keep both the V2 `chara` and V3 `ccv3` readers, and the off-spec Tavern heuristics, `convertCharbook` migrations, and V2 `character_version` handling.
- CharX: always await `CharXImporter.done()`. Never drop `module.risum`.
- Asset references in cards and modules are storage IDs or protocol URIs, never local filesystem paths.
- PNG text size is capped at 5 MiB. CRC is checked only in non-stream reads.
- `createBaseV2` intentionally omits emotions and additional assets. V3 is the full-fidelity path.
- The exported `virtualscript` is intentionally blank (security). Cards and modules with low-level access require confirmation on import.
- The `getModules` cache is keyed by joined IDs. After editing module contents in place, call `refreshModules` or `moduleUpdate`.
- `getModuleTriggers` mutates the triggers' `lowLevelAccess`. Aggregate order follows the DB module order.
- Keep `character.modules`, `chat.modules`, `enabledModules`, and `moduleIntergration` (which matches namespaces) distinct.
- `LoreBookList` must rebuild its Svelte arrays after SortableJS DOM moves. `characterFormatUpdate` and `updateLorebooks` are the lore migration points.
- `chaId` and chat IDs must be unique. `bootstrap.ts:assignIds` repairs duplicates.

## Recipes

- Add a card field: `createBaseV2`/`createBaseV3`, `importCharacterCardSpec`, and the `character` type plus its `setDatabase` default. Verify PNG, JSON, and CharX round trips and old Tavern input.
- Add an asset kind: the tuple creation in `CharConfig.svelte`/`AssetInput.svelte`, the asset typing in `createBaseV3`, the embedding in `exportCharacterCard`, and the resolution in `importCharacterCardSpec`.
- Add a module capability: `RisuModule`, `ModuleMenu.svelte`, `exportModuleLegacy`/`readModule`, a `getModule*` getter, and the consuming code path. Call `refreshModules`.
- Change the lorebook editor: `LoreBookSetting`/`LoreBookList`/`LoreBookData`. Keep `mode`, `id`, `folder`, and `bookVersion`.
- Change character CRUD: `characters.ts`, `GridCatalog.svelte`, `CharConfig.svelte`. Verify trash restore and groups.

## Tests

- None cover cards, PNG, CharX, `.risum`, personas, loadouts, or the editors.
- Adjacent: `mcp/risuaccess/tests/modules.test.ts`.

## Known Hazards

- `applyLoadout` appends the current character ID on every apply, so repeated applies create duplicates.
- Loadout export and import are unimplemented.
- There is no dedicated "duplicate character" API. Copies come from module→character conversion or re-import.
