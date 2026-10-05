# Slice: Readers, Characters

Status: implemented 2026-10-05 (see "Implementation notes").

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Projections" (`CharConfig.svelte`,
`DefaultChatScreen.svelte`, and `Chat.svelte` of the named top consumers, for their character
reads; the list readers) and the Safety Contract measurement; `PLAN.md` invariant 3 and Decision 3.

Depends on: `character-ownership` (the records, the list, the id selection, the shim). Parallel
with `readers-settings-pages`; after `readers-settings-consumers` in the files both touch.
`chat-projection-and-lazy-loading` follows this slice.

## Scope

Allowed files: `src/lib/SideBars/CharConfig.svelte` (265 matching lines, 71 bindings, all on
`characters[$selectedCharID]`; the editors and `1005`, `1773` of the allowlist), `src/lib/SideBars/Sidebar.svelte`
(26; the reorders at 153-198, 288-300), `src/lib/SideBars/LoreBook/{LoreBookSetting,LoreBookList,LoreBookData}.svelte`,
`src/lib/SideBars/{Toggles,CustomSidebar,DevTool}.svelte` (character reads), `src/lib/Mobile/MobileCharacters.svelte`,
`src/lib/Others/{GridCatalog,AlertComp,ChatList,HypaV3Modal}.svelte` and `HypaV3Modal/*`
(character reads), `src/lib/Setting/Pages/Module/{ModuleChatMenu,ModuleSettings}.svelte`
(character reads; the creation at `ModuleSettings.svelte:87-90`), `src/lib/Setting/Pages/OtherBotSettings.svelte`
(its one character read), `src/lib/ChatScreens/{ChatScreen,DefaultChatScreen,Chat,ChatBody,Suggestion,BackgroundDom}.svelte`
(character reads; chat reads move in the next slice), `src/lib/Playground/PlaygroundMenu.svelte`,
`src/ts/characters.ts` (`changeChar`, `addCharacter`'s callers, `createNewCharacter`,
`createNewGroup`, the image and emotion helpers, `restoreChar`, `removeChar`, `exportChat`'s
character reads), `src/ts/characterCards.ts` (the import callers' selection and `characters.length`
reads), `src/ts/globalApi.svelte.ts` (`changeChatTo`, the chat-fold effects, `loadInternalBackup`),
`src/ts/hotkey.ts` (86, 115, 133), `src/ts/util.ts` (`findCharacterbyId`, `findCharacterIndexbyId`,
`getCharacterIndexObject`, `getEmotion`), `src/ts/process/group.ts`, `src/ts/process/modules.ts`
(`applyModule`, the selected-character reads), `src/ts/process/lorebook.svelte.ts` (`addLorebook`,
`addLorebookFolder`), `src/ts/process/index.svelte.ts` (the `lastInteraction` pre-send write,
`bumpReloadKey`), `src/ts/process/mcp/risuaccess/{utils,characters,modules}.ts` (reads; the
writers are Phase 4's), `src/ts/plugins/apiV3/v3.svelte.ts` (the character getters over the
records), `src/lang/en.ts`. Tests belong to the review step.

Identifiers (verified 2026-09-30; matching lines, tests excluded): the 417 indexed sites in 21
files (`CharConfig.svelte` 253, `DefaultChatScreen.svelte` 46, `AlertComp.svelte` 19,
`Chat.svelte` 18, `LoreBookSetting.svelte` 14, `ModuleChatMenu.svelte` 11, `DevTool.svelte` 11,
`LoreBookList.svelte` 10, `ChatList.svelte` 7, `HypaV3Modal.svelte` 5, `modal-summary-item.svelte`
4, `ChatScreen.svelte` 3, `Suggestion.svelte` 3, `Sidebar.svelte` 3, `globalApi.svelte.ts` 3,
`modal-footer.svelte` 2, `BookmarkList.svelte` 1, `OtherBotSettings.svelte` 1, `CustomSidebar.svelte`
1, `SideChatList.svelte` 1, `stores.svelte.ts` 1); the selection writers (`characters.ts:951, 962, 1000`,
`PlaygroundMenu.svelte:37`, `hotkey.ts:86, 115, 133`, `Sidebar.svelte:395, 435, 480, 493, 916, 929`
and `changeChar` at 575, 581, 788, 794, `MobileCharacters.svelte:84`, `GridCatalog.svelte:121-188`);
`CharConfig.svelte` is overwhelmingly own-field reads and binds (376-391, 536-637, 1527-1724)
with a few current-chat reads (469, 1748-1788: the next slice's); `DefaultChatScreen.svelte`
mostly reads the current chat (271-306, 352, 678, 966-1012, 1066-1087: the next slice's) and
own fields for the initial-message card and menu (967-984, 1017-1052); `Chat.svelte` reads
current-chat fields (316, 480-481, 572-573, 1515-1516, 1563-1567) and `image`, `type`, TTS,
`chatFolders`, `chaId` (897, 1061, 1197-1198, 1287); group members resolved one at a time
(`util.ts:192-204, 253-308`, `group.ts:10-90`); the Phase 4 allowlist entries in this group
(named in the scope).

Stopping condition: a reader that needs the character index as shared state (none found), or a
character write in this group that no Phase 4 function or record write expresses (reported).

## Assumptions

- `character-ownership` landed: `characterRecords`, `characterList`, `selectedCharacter`,
  `selection.characterId`, `selectCharacter`, the `selectedCharID` shim, `addCharacter` applying
  the former `characterFormatUpdate` defaults.
- Phase 4 (verified): the contract writers are routed; `pluginContext.ts` resolves the hook's
  character; the allowlist entries above are the writers this slice routes.
- `readers-settings-consumers` already changed the settings reads in the shared files.

## Proposed decisions

- Reads become `selectedCharacter.<field>`, `characterList`, `findCharacter(chaId)`, or the
  records; writes go through `updateCharacter`, `addCharacter`, `removeCharacter`,
  `replaceCharacterFields`, or the record's write-through; selection writes call
  `selectCharacter(chaId)` (`changeChar(index)` maps the index over the records for its
  remaining callers, then goes). `CharConfig.svelte` binds `selectedCharacter.<field>` (71
  bindings); its nested lorebook and script editors use the spike's pattern for nested containers
  or the `useLocalLoreDraft` editing-copy precedent. `hotkey.ts` maps its sorted index to a
  `chaId`. `MobileCharacters.svelte` reads `chatCount` from the list summary.
- Group chats: members stay resolved by id one at a time (no consumer needs all members' full
  records at once).

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Review-step tests: `hotkey.ts`
previous/next over the list; `changeChar` and `selectCharacter` mapping; the `CharConfig`
editors over `storeBackedServer.ts` (a lorebook entry edit queues one character write).
Manual, recorded here: every CharConfig tab, the sidebar (reorder, folders, trash), the mobile
list, the grid catalog, the character picker, a group with three members, the playground
character. Scoped gate: `rg -n 'DBState\.db\.characters|characters\[\$selectedCharID\]|characters\[selIdState' src/lib src/ts`
lists only chat reads (`.chats[` and `.chatPage`) owned by the next slice.

## Residual risk

The chat reads inside the same components stay on the facade until
`chat-projection-and-lazy-loading`; these files are edited again there (sequential).

## Implementation notes (2026-10-05)

After the plan review (Astra, segment C):

- **The readers' API** (`characterStore.svelte.ts`): `selectedCharacter()` (already there), `characterList()`
  (the list wrapper), `characterSnapshot(chaId)` (a detached copy with its chats); `findCharacter` stays
  read-only typed, and a writer uses the writable wrapper from `characterList()`/`selectedCharacter()` or a
  mutation function. A component reads the selected character as
  `const currentCharacter = $derived(selectedCharacter())` (one lookup per selection or membership change); a
  handler that runs later reads `selectedCharacter()` when it runs. `Toggles`/`SideChatList` get the record as
  a plain prop (they never reassign it). A scripted rewrite replaced the `characters[$selectedCharID]`,
  `characters[selIdState.selId]`, `characters[get(selectedCharID)]` reads and `getCurrentCharacter()`; the rest
  was done by hand.
- **Ids, not indexes.** Home checks test for no selected character; active rows and change detection compare
  `chaId`s (`DefaultChatScreen`'s reroll reset and auto mode, `Suggestion`'s request guard). The Sidebar,
  grid catalog, and mobile list rows carry their `chaId`, and `changeChar(chaId)` selects it.
  `selectCharImg`, `dumpCharImage`, `changeCharImage`, `addCharEmotion`, `rmCharEmotion`, and `exportChar`
  take a `chaId`. Handlers that await capture the character first and find it again after each await:
  `exportChat`, `addCharEmotion`, `addGroupChar`, `applyModule` (now targeting the character selected when
  its dialog opened), CharConfig's additional assets, VITS model, and reference audio, and the Sidebar's
  folder actions (by folder id). `applyModule`'s write-back is gone (its pushes write through).
- **Imports** return the new character's `chaId` from every branch (`importCharacterCardSpec`,
  `importCharacterProcess`, `importCharacter` the last one it imported, `createNewCharacter`,
  `createNewGroup`), and `addCharacter()` and the Realm import select that id, not the last in the list;
  `returnCharacter` mode still returns the detached character.
- **Hotkeys** sort a copy of the list by name and step by `chaId`. The bounds are fixed: previous does nothing
  from the first character or home, next does nothing from the last and selects the first from home (they
  used to refuse position 0 both ways, previous refused the last, and previous from home threw).
- **Plugin index APIs** keep the list position as their index (`getCharacterFromIndex`, `setCharacterToIndex`,
  `getChatFromIndex`, `setChatToIndex`, `getCurrentCharacterIndex`, a hook's `characterIndex`).
- **The order:** the Sidebar's reorders, `getFolderIndex`, and `checkCharOrder` read and write
  `settings.characterOrder` and resolve characters through `characterList()`.
- **Left in place**, with their owners: the chat module's reads (`chatStore.svelte.ts`) and
  `localLoreDraft.svelte.ts` (slice 9a); for slice 10, `database.svelte.ts`' legacy wrappers
  (`getCurrentCharacter`, `setCurrentCharacter`, `getCharacterByIndex`, no caller left outside storage),
  `characterStore`'s own `list()`, the records and resource sync, the boot assembly, the snapshot consumers
  (`backuplocal.ts`, `exportAsDataset.ts`), the CBS host's `getSelectedCharID`, and `selectedCharID`/`selIdState`
  as subscription shims.
- **After the challenge** (Astra, 2026-10-05): the Sidebar's folder menu captures the folder's id and name
  before its first dialog (the row it reads from is live); `exportChat` captures the chat's id with the
  character's and exports a copy of that chat; `importCharacter` returns the last id it imported even when a
  later file throws; the hotkeys read the selected id once.

### Measurements

`util/playwright/measureCharacters.mjs` (300 characters, one with a 300-entry lorebook and a 400-message
chat), production builds, headless Chrome, against the slice 7 build (`d6fd621b`) on the same machine;
task-latency medians of 10 (typing: 101), two runs each:

| Workload                         | Baseline (`d6fd621b`) | This slice       |
| -------------------------------- | --------------------- | ---------------- |
| Select the big character         | 37.0 / 37.6 ms        | 36.1 / 36.6 ms   |
| Select a small character         | 7.0 / 7.1 ms          | 7.2 / 8.1 ms     |
| A keystroke into the description | 10.4 / 10.6 ms        | 10.0 / 10.1 ms   |
| Lorebook drag, 300 entries       | 115.4 / 117.9 ms      | 109.1 / 105.5 ms |

Every check passed in all four runs (the typed description and the dragged order on the server, one batch
each, no page error, no unexpected egress).

### After the review

The review (2026-10-05) found no problem.

- **Before the review:** in `characterStore.svelte.ts`, the `./selection.svelte` import was moved ahead of `../stores.svelte`. The modules `stores.svelte` and `parser.svelte` now import `characterStore`. Under Vitest's loader, their module effects called `selectedCharacter()` before `selection` was bound, which threw 14 unhandled TDZ errors. While modules load, `selection.characterId` is `null`, so the call now returns early. Native ESM is not affected.
- **After the review:** three small fixes.
  - `SideChatList` passes `chara` to `Toggles` without `bind:`. The binding produced Svelte's dev-only `ownership_invalid_binding` warning.
  - An unused import was removed from `chatTemplate.ts`.
  - `activeHotkeys`' doc comment is back above it.
- **Review-step tests:**
  - New files: `src/ts/charactersCapture.test.ts` and `e2e/readersCharacters.spec.ts`.
  - Cases added to:
    - `hotkey.test.ts`: the bounds of the first, last, and home positions;
    - `storage/tests/characterStore.test.ts`: reads follow the id across a removal;
    - `characterCardsImport.test.ts`: the returned ids;
    - `plugins/apiV3/hostApi.test.ts`: the index APIs keep the list position.
- **Defect at the base, not fixed here:** a lorebook entry's prompt can still have focus when the selection changes, for example by the next-character hotkey. When the field unmounts, its `onchange` writes into the new character's missing entry. This throws `TypeError` and then `state_unsafe_mutation`, and CharConfig stops following its submenu. A mouse click blurs the field first, so clicking does not trigger it.
