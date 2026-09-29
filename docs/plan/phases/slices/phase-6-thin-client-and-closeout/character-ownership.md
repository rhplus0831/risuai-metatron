# Slice: Character Ownership

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Projections" (the character list
summary and the selected character as records, the source of truth flipped under the flat
mirror), "Accessors" (`setCurrentCharacter`, `setCharacterByIndex`, `getCharacterByIndex`
become wrappers to delete), and the character part of "Save loop" (the selected-character and
membership watchers and `markCharactersDirty` deleted); `PLAN.md` invariant 2 and Decision 3
(per-client selection).

Depends on: `settings-ownership` (`records.svelte.ts`, `queueRecordWrite`, `settings.characterOrder`).
Phase 4 `character-and-collection-mutations` (`characterStore.svelte.ts`) and `plugin-call-context`
(`pluginContext.ts`: the hook's context character). Sequential after `settings-ownership`.

## Scope

Allowed files: `src/ts/storage/characterStore.svelte.ts` (Phase 4's module, extended:
`characterRecords`, `characterList`, `selectedCharacter`, `selectCharacter`; the transport
swapped from the watchers to `queueRecordWrite`; `addCharacter`, `updateCharacter`,
`replaceCharacterFields`, `replaceCharacterAt`, `removeCharacter`, `findCharacter` keep their
signatures), `src/ts/storage/selection.svelte.ts` (`selection.characterId`), `src/ts/stores.svelte.ts`
(`selectedCharID` and `selIdState.selId` become derived shims over `selection.characterId`; the
`supaMemory` write at 168-177 becomes `updateCharacter(chaId, { supaMemory: true })`; the
`moduleUpdate` effect reads the record), `src/ts/storage/forwarding.svelte.ts` (the
`DBState.db.characters` accessor returning the records' array), `src/ts/storage/database.svelte.ts`
(`getCurrentCharacter` over `selectedCharacter`; `setCurrentCharacter`, `setCharacterByIndex`,
`getCharacterByIndex`, `replaceCharacterFields` stay as wrappers until `aggregate-removal`),
`src/ts/storage/resourceSync.svelte.ts` (the selected-character deep watcher, the membership
watcher, `markCharactersDirty`, `markCharacterDirtyAt`, `setGeneratingCharacter`, and
`deferredCharacters` deleted; the create and delete membership ops driven by `addCharacter` and
`removeCharacter`; `applyToMirror`'s character branch writes the records), `src/ts/bootstrap.ts`
(`assembleDatabase`'s character part builds the records; the trash pruning in `checkNewFormat`
calls `removeCharacter`; `watchGeneration`'s dirty mark and `setGeneratingCharacter` go),
`src/ts/characters.ts` (`characterFormatUpdate` split: the pure defaults into `addCharacter`,
the non-pure steps as named below), `src/ts/characterCards.ts` (the `postHistoryInstructions`
transfer as an import-handling step), `server/src/data/normalize/characters.ts` (new) and its
registration. No `src/lib` file (the readers move in `readers-characters`). Tests belong to the
review step.

Identifiers (verified 2026-09-30): `selectedCharID` (`stores.svelte.ts:26`; 565 matching lines
in 49 non-test files), `selIdState` (59-61; 48 in 16), the `$effect.root` at 168-177 (the
`supaMemory` write at 174) and the `moduleUpdate` effect (178-188); indexed selected-character
sites (`rg -n 'characters\[\$selectedCharID\]|characters\[selIdState' src`, non-test): 417
matching lines in 21 files; the watchers `resourceSync.svelte.ts:1281-1294`; `markCharactersDirty`
callers `characters.ts:165, 182, 192, 885, 911, 945`, `bootstrap.ts:169`, `lorebook.svelte.ts:731`,
`risuaccess/characters.ts:356` (Phase 4 removes), `v3.svelte.ts:880, 905` (Phase 4 removes),
`CharConfig.svelte:1005`; `markCharacterDirtyAt` callers `database.svelte.ts:784, 802`,
`index.svelte.ts:370` (the `lastInteraction` stamp Phase 5 keeps client-side), `v3.svelte.ts:730`
(Phase 4 removes); `characterFormatUpdate` (`characters.ts:611-716`: creates a chat for a
chatless character at 619-620, moves `postHistoryInstructions` into the selected chat's note at
665-674, stamps `lastInteraction` at 715, fills `fmIndex` per chat at 719-721, and applies the
pure field defaults between; called by `changeChar`), the trash pruning `bootstrap.ts:403-410`,
`checkCharOrder` (Phase 4 moves it to `src/ts/storage/characterOrder.ts`), `replaceCharacterFields`
(`database.svelte.ts:805-820`), `reloadKeys` (bumped by `bumpReloadKey`, `index.svelte.ts:216-221`);
list readers and their fields: `Sidebar.svelte:76-120, 551-805` (`image`, `name`, `chaId`;
folders from `characterOrder`), `MobileCharacters.svelte:52-100` (`trashTime`, `name`, `image`,
`chats.length`, `lastInteraction`), `GridCatalog.svelte:21-50` (`trashTime`, `name`, `image`,
`type`, `creatorNotes`, `chaId`), `AlertComp.svelte:374-405` (`type`, `image`, `chaId`); Phase
4's `characterStore.svelte.ts` (`findCharacter`, `addCharacter`, `updateCharacter`,
`replaceCharacterFields`, `replaceCharacterAt`, `removeCharacter`; trash and restore are
`updateCharacter({ trashTime })`); the server `characters` normalizer checks shape only
(`kinds.ts`, Phase 1); Phase 5's generation lock protects the generating message and the
destructive cascades, not ordinary character-field updates (Astra's drift note).

Stopping condition: a reader that needs the character array index as persisted or shared state
(none found), or a `characterFormatUpdate` step that is neither a pure default nor one of the
four named non-pure steps.

## Assumptions

- Phase 4 (verified against its slices): `characterStore.svelte.ts` exists with the functions
  above, validates and clones its inputs, writes the mirror by id, and marks through
  `markCharactersDirty`; `setCurrentCharacter` and `setCharacterByIndex` are wrappers for
  `characterFormatUpdate` and `applyModule`; the plugin, MCP, Lua, and trigger writers call the
  module; the eight `triggers.ts` `setCurrentCharacter` calls are gone; the core-app writers in
  the allowlist (`createNewCharacter`, `createNewGroup`, the image and emotion helpers,
  `restoreChar`, `removeChar`, `addLorebook`, `applyModule`, `ModuleSettings.svelte:87-90`, the
  sidebar reorders, the `CharConfig.svelte` editors, `PlaygroundMenu.svelte:44`) write the mirror
  directly and are `readers-characters`' to route.
- Phase 5 moved the Lua and trigger runtimes to the server; `lastInteraction` and
  `statics.messages` are written by the client before a send (`prompt-assembly`); the server
  writes characters through `applyChanges` and the client learns of them through the job
  socket's `resource` events and the feed.
- Phase 3 removed `root`; `characterOrder` is `settings.characterOrder` after `settings-ownership`.
- All character records still load at boot; this slice does not lazy-load characters.

## Proposed decisions

- Ownership flip (Opus P1 option (a)): `characterRecords` (every loaded character as a
  write-through record keyed by `chaId`, creation order) is the source of truth;
  `DBState.db.characters` becomes an accessor on the raw root returning the records' array (the
  same array object, so index reads, `push`, and `splice` by the allowlist writers keep working
  and are captured by the record pattern); `characterList` is a `$derived` summary per record
  (`chaId`, `name`, `image`, `type`, `trashTime`, `creatorNotes`, `lastInteraction`, and
  `chatCount` from the chat order's id count); `selection.characterId: string | null` (per tab,
  not persisted; `null` is home); `selectedCharacter`; `selectCharacter(chaId | null)`.
  `selectedCharID` and `selIdState.selId` stay as derived shims (getter: the index of the
  selected id in creation order or -1; setter: selects the id at that index), so U4's `-1`
  convention and the 565 references keep working; the phase's exit criterion names only
  `DBState.db`, so the shim is not a gate (Opus P15); `aggregate-removal` deletes it if its
  references reach zero and otherwise keeps it as a derived store, with U4 in `STRUCTURE.md`
  updated either way (Astra's drift note).
- Transport (proposed): the character record's writes go through `queueRecordWrite("characters", chaId)`;
  `markCharactersDirty` and `markCharacterDirtyAt` are deleted with the two watchers;
  `addCharacter` and `removeCharacter` queue the create and delete membership ops (replacing the
  membership watcher). `setGeneratingCharacter` and `deferredCharacters` go: after Phase 5 no
  client-side generation holds a character; Phase 5's frozen execution scope makes a mid-job
  character edit harmless to the job (it does not affect the job) and the lock is not claimed
  to protect ordinary field updates.
- Normalization (Astra P5, Phase 3's approach): the pure defaults of `characterFormatUpdate`
  are applied by `addCharacter` at creation (every creator and importer, including Phase 4's
  routed ones, goes through it) and by `normalize/characters.ts` on the server as the backstop
  with Phase 3's startup pass persisting its result; no batch result returns data. The four
  non-pure steps are separated: the chat for a chatless character is the chat module's
  `ensureChat` (exists); `fmIndex` per chat is set by `createChat`; the `postHistoryInstructions`
  transfer into a chat note becomes an import-handling step in `characterCards.ts` (it runs once
  on import, through `setChatMeta`); the `lastInteraction` stamp is the pre-send write
  (`updateCharacter(chaId, { lastInteraction })`) and is no longer applied on selection.
  Obsolete save-layout migrations in `characterFormatUpdate` are dropped. Recorded behavior
  change: selecting a character no longer stamps `lastInteraction`.
- Trash pruning (proposed): stays a client operation at boot calling `removeCharacter` for
  expired records (open question 6 in the report: a server startup sweep is the alternative).
- The `supaMemory` selection write (`stores.svelte.ts:174`) becomes
  `updateCharacter(chaId, { supaMemory: true })` (Opus P14); the `moduleUpdate` effect reads the
  selected record through the module.
- Plugin and MCP getters keep creation order for their index-based APIs through the shim;
  `pluginContext.ts` (Phase 4: `invokeHook(fn, context)` and `currentContext(pluginName)`)
  decides which character a hook means, unchanged.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Review-step tests over
`storeBackedServer.ts`: a write through the facade (`DBState.db.characters[i].name = x`) and
through `updateCharacter` on a non-selected character queue one op with the held revision and
no watcher or mark; `addCharacter` creates the record, its order, and its chats; `removeCharacter`
deletes and cascades; a conflict reload replaces the record; remote deletion of the selected
character moves the selection home; the shim maps both ways; trash pruning through
`removeCharacter`; the character normalizer tests; `addCharacter` applying the former
`characterFormatUpdate` defaults; the import-time `postHistoryInstructions` transfer; the Phase 4
suites unchanged. Manual, recorded here: create, edit, trash, restore, delete, reorder, folder,
group, playground character, card import, all through the unchanged UI; a reload shows
everything; two tabs converge on a character edit. Scoped gate:
`rg -n '\$effect|markCharactersDirty|markCharacterDirtyAt|setGeneratingCharacter' src/ts/storage/resourceSync.svelte.ts src/ts/bootstrap.ts`
returns nothing.

## Residual risk

The facade keeps `DBState.db.characters[i].chats` and `chatPage` served by the chat module's
mirror until `chat-projection-and-lazy-loading`; the record type still carries them (Astra P7's
contradiction is resolved by keeping them until that slice). Index-based plugin APIs keep
creation order (Phase 1's rule). The `selectedCharID` shim is a second selection surface until it
is removed.
