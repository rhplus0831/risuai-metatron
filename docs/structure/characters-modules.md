# Characters, Cards, Modules, Personas

## Scope

- Owns:
  - character and group CRUD,
  - character card import and export (PNG, JSON, CharX, V2/V3, off-spec Tavern),
  - PNG tEXt chunks,
  - CharX zip read and write,
  - modules (the `.risum` codec, activation, the effective-set getters),
  - module/character/persona conversion,
  - personas,
  - the character editor and lorebook editor UI.
- Paths:
  - `src/ts/{characterCards,characters,persona,pngChunk,interchangeability}.ts`
  - `src/ts/process/{processzip,modules}.ts`
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
  - Bot preset codecs (`downloadPreset`/`importPreset` in `database.svelte.ts`) → `settings-i18n.md`.
  - The Realm hub → `backup-sync-hub.md`.

## Files

- `characterCards.ts`: card import, export, and hub helpers.
  - Import: `importCharacter` (file picker), `importCharacterProcess` (dispatch by extension), private `importCharacterCardSpec` (V2/V3), `convertOffSpecCards`, `convertCharbook`.
  - Export: `exportChar` (dialog), `exportCharacterCard` (writer), `createBaseV2`/`createBaseV3`.
  - Hub and links: `characterURLImport` (deep links and shares), `hubURL`, `getRisuHub`/`downloadRisuHub`/`getRealmInfo`. `hubURL` is the self-host server's same-origin `/hub-proxy`.
- `characters.ts`: character lifecycle.
  - Create and select: `addCharacter`, `createNewCharacter`, `createBlankChar`, `createNewGroup` (the add dialog no longer offers it; its `createGroup` result is still handled, and existing groups keep working), `changeChar` (refused while a send runs; makes sure the character has a chat (`ensureChat`), then selects it; it applies no defaults and stamps no `lastInteraction`).
  - Delete: `removeChar` (soft delete via `trashTime`, or permanent).
  - Image, emotion, and chat import/export helpers.
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
- `persona.ts`: `changeUserPersona(id, target?)` (picks the persona where the screen shows it, through `pickBinding`: with a chat open it binds that chat, at home it selects for this client; `target` names a chat or `null` for the tab; the persona fields are forwarded, so nothing is copied), `selectUserImg` (captures the selected persona before the file dialog and sets its icon, keeping its id, so bound chats stay bound). `exportUserPersona`/`importUserPersona` use a PNG `persona` tEXt chunk.
- UI:
  - `CharConfig.svelte`: the main editor, binding the selected character's record (`currentCharacter`, `$derived(selectedCharacter())`). Tabs cover identity, greetings, images, emotions, assets, lore, regex, triggers, TTS, export, and delete.
  - Lorebook:
    - `LoreBookSetting.svelte`: tabs for character, chat, and settings.
    - `LoreBookList.svelte`: SortableJS lists and folders.
    - `LoreBookData.svelte`: a single entry. `activateLocally` creates a `mode:'child'` link.
  - Modules:
    - `ModuleSettings.svelte`: the catalog.
    - `ModuleMenu.svelte`: the editor.
    - `ModuleChatMenu.svelte`: per-chat and per-character toggles.
  - `GridCatalog.svelte`: the catalog plus trash.
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
- The result is a new `character` with a fresh `chaId`, added through the character module's `addCharacter` (`storage/characterStore.svelte.ts`): the card is checked as JSON data (a refused card leaves the character list, its chats, and the order unchanged; the importer is not transactional, so the `statics.imports` stamp and a saved image stay), its chats get ids, and it joins the character order. Module, persona, and preset imports likewise go through `addModule`, `addPersona`, and `addPreset` (after `normalizePreset`), and the global lore import through `updateCharacter` by the id captured before the file dialog.
- `importChat` captures the selected character's id before the file dialog, resolves it again afterwards (a deleted one stops with `importTargetGone`), reads its name and folders from that record, writes the folders with `updateCharacter`, and switches to the imported chat only while that character is still selected.

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

- `importUserPersona` stores and re-encodes the PNG icon first, then adds the persona (`addPersona`, a fresh id) to the live list, so a collection another client replaced during the icon's save keeps both the new list and the icon.
- A CharX import whose module is refused alerts `noData` and adds no module (no success alert); the character's data is unchanged.
- Character imports count `statics.imports` for PNG, JPG, and CharX files before parsing (a card refused later still counts); a JSON card does not count.

## State

- `character`: identity and content fields plus `emotionImages`, `additionalAssets` (`[name, path, ext][]`), `ccAssets`, `customscript`, `triggerscript`, `globalLore`, `loreSettings`, `modules`, `lowLevelAccess`, the TTS fields, and `trashTime`.
- `groupChat`: `type:'group'`, `characters: string[]`, `characterTalks`, `characterActive`, `autoMode`, `useCharacterLore`.
- `loreBook`: `key`/`secondkey` (comma-separated), `content`, `insertorder`, `alwaysActive`, `selective`, `mode` (`normal|folder|child|...`), `useRegex`, `id`, `folder`, `bookVersion`.
- `RisuModule`: `id`, `name`, `lorebook`, `regex`, `trigger`, `assets`, `backgroundEmbedding`, `customModuleToggle`, `namespace`, `lowLevelAccess`, `hideIcon`, `mcp`.
- `RisuPersona`: `name`, `icon`, `personaPrompt`, `note`, `id`, `largePortrait`, `embeddedModule`. The active persona is mirrored into the legacy DB fields `username`, `userIcon`, `personaPrompt`, `userNote`.

## Coupling

- Depends on `database.svelte.ts`, `stores.svelte.ts` (`ReloadGUIPointer`, `moduleBackgroundEmbedding`), `selection.svelte.ts`, `globalApi` assets and writers, `alert.ts`, `util.ts`, `media/`, the lorebook codecs, scripts, triggers.
- `@risuai/ccardlib` is imported for types only. There is no runtime validation.

## Invariants

- Keep both the V2 `chara` and V3 `ccv3` readers, and the off-spec Tavern heuristics, `convertCharbook` migrations, and V2 `character_version` handling.
- CharX: always await `CharXImporter.done()`. Never drop `module.risum`.
- Asset references in cards and modules are storage IDs or protocol URIs, never local filesystem paths.
- PNG text size is capped at 5 MiB. CRC is checked only in non-stream reads.
- `createBaseV2` intentionally omits emotions and additional assets. V3 is the full-fidelity path.
- Cards and modules with low-level access require confirmation on import.
- The `getModules` cache (`lastModules`) is keyed by the joined enabled IDs, and only `refreshModules` clears it (`moduleUpdate` reads through it). After editing module contents in place, call `refreshModules`.
- `getModuleTriggers` mutates the triggers' `lowLevelAccess`. Aggregate order follows the DB module order.
- Keep `character.modules`, `chat.modules`, `enabledModules`, and `moduleIntergration` (which matches namespaces) distinct.
- `LoreBookList` must rebuild its Svelte arrays after SortableJS DOM moves. Old lorebook entries (below `bookVersion` 2) are converted only as they enter: a character's creation (`prepareNewCharacter`), a lorebook file imported into a character (`importLoreBook`), and the module import paths (`upgradeLorebook`, `shared/modules.ts`); later updates keep their content.
- `chaId` and chat IDs must be unique. The installation (`initializeRecords`) gives a character without a valid or unique id a new one, and a character's id never changes afterwards; chat and message ids are assigned by the chat module (`createChat`, `appendMessage`) and kept unique by the server.
- An import path adds a character only through `addCharacter` (and modules, personas, and presets through the collection module). The core-app creators (`createNewCharacter`, `createNewGroup`) add through it too.
- A character's chats are created through the chat module once it is in the mirror: `importChat` calls `createChat` (a copy gets a fresh chat id and keeps its message ids), and `changeChar` calls `ensureChat` for a character without one. A character that is not yet added (a new card, an import) carries its initial chats in its input; its creation (`prepareNewCharacter`) gives it a first chat when it has none, each chat its `fmIndex` (the character's `firstMsgIndex`) and `localLore` (`prepareChatInput`), and moves `postHistoryInstructions` into the note of the chat at `chatPage`; `addCharacter`/`replaceCharacterAt` then hand the chats to the chat module (`installCharacterChats`: the record holds none) and the save loop creates them with the character.
- `changeUserPersona(id)` with an id that is not in `settings.personas`, or for a chat that is gone, does nothing and returns false. `PersonaSettings.svelte` creation captures its target before its dialog; a deletion moves only the tab's selection, never a chat's binding.

## Recipes

- Add a card field: `createBaseV2`/`createBaseV3`, `importCharacterCardSpec`, and the `character` type plus its default in the server's character normalizer (`normalizeCharacter`). Verify PNG, JSON, and CharX round trips and old Tavern input.
- Add an asset kind: the tuple creation in `CharConfig.svelte`/`AssetInput.svelte`, the asset typing in `createBaseV3`, the embedding in `exportCharacterCard`, and the resolution in `importCharacterCardSpec`.
- Add a module capability: `RisuModule`, `ModuleMenu.svelte`, `exportModuleLegacy`/`readModule`, a `getModule*` getter, and the consuming code path. Call `refreshModules`.
- Change the lorebook editor: `LoreBookSetting`/`LoreBookList`/`LoreBookData`. Keep `mode`, `id`, `folder`, and `bookVersion`.
- Change character CRUD: `characters.ts`, `GridCatalog.svelte`, `CharConfig.svelte`. Verify trash restore and groups.

## Tests

- `src/ts/characterCardsImport.test.ts`: JSON V2, off-spec JSON, PNG, and CharX imports over the real store (fixtures in `storage/tests/importFixtures.ts`), the stamp, and a refused card. It also checks that each import returns its own `chaId` (also when two run at once), and that a multi-file `importCharacter` returns the last one imported, or `null` when none was.
- `src/ts/charactersCapture.test.ts`: `changeChar` and the add dialog select by id. `addCharEmotion`, `exportChat`, `addGroupChar`, and `applyModule` keep the target they captured before their awaits.
- `src/ts/charactersImportChat.test.ts`: `importChat`'s target captured before the dialog (the selection moved, a reorder, a same-id replacement, a deletion), name substitution, and folder remapping.
- `src/ts/process/modulesImport.test.ts`: `importModule` for `.risum`, CharX, module JSON, lore, and regex files, and a refused CharX module.
- `src/ts/personaImport.test.ts` and `src/ts/process/lorebookImport.test.ts`: the persona import's id and icon order, the persona export keeping the persona selected at its start while the selection and the name change during its awaits, and the global lore import by the captured id.
- Not tested: the editors, card export round trips.
- Adjacent: `mcp/risuaccess/tests/modules.test.ts`.
- Not tested: the character lorebook drag's cost (the list rebuilds and Sortable is recreated after the write); measured by hand (`measureCharacters.mjs`): 104–112 ms against 100.5–105.5 ms before the character records (commit `139fc73b`), within about 7%.

## Known Hazards

- There is no dedicated "duplicate character" API. Copies come from module→character conversion or re-import.
- An off-spec card with only `char_name` imports as "unknown name": the check accepts `char_name`, but `convertOffSpecCards` reads `name` (pre-existing).
- A bound persona's embedded module joins the effective modules only when a module with its id exists in `settings.modules`: the tab's `getModules` and the server's `jobModules` add the persona's `embeddedModule.id`, then resolve ids against the stored list only (`getModuleByIds`, `modulesByIds`), so an embedded module never stored contributes nothing.
- `importLoreBook("sglobal")` reads and parses the file but writes nothing: only `global` (the captured character) and `local` (the captured chat) have a write.
- `addModule` does not refuse a duplicate module id, so two modules can share one; `removeModule` removes the module but leaves its id in `enabledModules` until that list changes.
- Nothing calls `refreshModules` after a wholesale replacement of `settings.modules` (a server copy, a conflict reload) that keeps the enabled IDs; only the module settings page does (`ModuleSettings.svelte`). `getModules` then keeps serving the previous wrappers: a read of one can throw `DetachedWrapperError`, or a stale module is served.
- A lorebook prompt that still has focus when a hotkey (Ctrl+]) or code switches the character: its pending change lands on the new character's missing entry, throws (`TypeError` setting `content`, then `state_unsafe_mutation`), and the character editor stops following its submenu. A mouse click blurs the field first, so clicking does not trigger it. (Observed with a browser script in Phase 6 slice 8 and not re-verified since; the code does not show the write path plainly: `TextAreaInput` has no unmount write.)
- `characterStore.svelte.ts` imports `./selection.svelte` before anything that loads `../stores.svelte`; the other order makes the `stores` and parser module effects read state that is not initialized yet under Vitest (TDZ errors). A comment marks it; an editor's "optimize imports" undoes it, which `pnpm test` catches.
