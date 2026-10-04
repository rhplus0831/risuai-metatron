# Slice: Character Ownership

Status: split at slice start (2026-10-04, F-l). 5a (ownership) implemented; 5b (normalization) planned. See "Implementation notes".

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
registration. No `src/lib` file (the readers move in `readers-characters`); 5a widened this to the structural writer sites (`implementation-plan.md` "Slice 5", R2). Tests belong to the
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

## Implementation notes (2026-10-04)

### The split

The diff would exceed one review, so the slice is split before Stop B (the planner's call at slice
start, `implementation-plan.md` "Slice 5", F-l). Stop B follows 5b.

- **5a, ownership (implemented):** the character records, the transport, selection by id, the
  structural writers and dirty-mark callers, the deferral, the boot's trash pruning, and the id
  integrity (moved from 5b's `assignIds` drop: by-id wrappers need valid, unique ids before they
  exist).
- **5b, normalization (next):** the shared pure character defaults (from `characterFormatUpdate` and
  `checkNewFormat`'s character block) for `addCharacter` and a server `normalize/characters.ts`; the
  import steps (`postHistoryInstructions`, lore v1, TTS `none`); `creation_date` once at creation;
  `lastInteraction` only at send (owner decision 2); `fmIndex` from `createChat`; the rest of
  `checkNewFormat`'s character block dropped. Until then `changeChar` still runs
  `characterFormatUpdate`, now in one `batchRecordWrites` scope.

### 5a as built (deviations from "Proposed decisions")

- **Records.** The characters live in `records.svelte.ts` beside the settings records, as one list
  (`characters`, not a settings `RecordKind`) whose elements are by id on `chaId`. Each character is its
  own owner: its element and everything under it share a meta (owned objects, displacement, epoch), so
  a value of character A assigned into B is stored as a detached copy and an edit of one never changes
  the other. A raw application bumps only that character's epoch (one counter; a node takes the later of
  its character's and the list's), so retained wrappers of other characters are unaffected. The ids are
  unique by construction (`initializeRecords` repairs a fixture's missing or repeated ids before any
  wrapper exists; every insertion refuses a taken id), so a character's writes skip the duplicate scan.
- **Local fields.** `chats`, `chatPage`, and `reloadKeys` of a character are outside its record: every
  trap (`get`, `getOwnPropertyDescriptor`, `set`, `defineProperty`, `deleteProperty`) acts on the raw
  value and queues nothing, so the chat module and the message rendering never go through wrappers.
  Storing a whole character keeps its own local values by identity and copies a `$state` value from
  elsewhere.
- **Structural writes are refused through the facade** (the plan review's smaller alternative to
  emulating native array membership): a `push`, `splice` (any mutator), index or `length` assignment,
  `delete`, `defineProperty`, or list assignment through `DBState.db.characters` throws `TypeError`,
  except the no-op Svelte 3 self-assignments. Membership changes go through `characterStore`
  (`addCharacter`, `replaceCharacterAt`, `removeCharacter`, the new bulk `removeCharacters`), which call
  the records' list operations (`insertCharacterRecord`, `replaceCharacterRecordAt`,
  `removeCharacterRecords`): one raw change, the membership and the stored ids queued once, then the
  selection's hook. A character's `chaId` never changes (assignment of another value, `delete`, and
  `defineProperty` refused). Inside a character, an array mutator runs in one batch.
- **Transport.** `setCharacterWriteListener` (a character's write → its key; membership → the loop
  wakes); the two `$effect`s, `markCharactersDirty`, `markCharacterDirtyAt`, and `dedupeCharacterIds`
  are gone. The save loop reads the raw list (`characterData`) and applies server copies raw
  (`applyRawCharacter`; `patchRawCharacter` for `mergeConcurrentChange`).
- **Deferral removed** with `setGeneratingCharacter`, `releaseDeferredCharacters`, and the generating
  restriction of `benignChanges` (`OPEN_DEFAULTS`). The neighbouring gates (in-flight, quarantine,
  local change, revision, server-job-blocked deletes, chat deferrals) are unchanged. Visible effect: a
  conflict on a character during a send reloads it at once.
- **Selection.** `selection.characterId` (`null`: home; per tab; left out of the stored selection).
  `selectedCharacterIndex` in `selection.svelte.ts` is the index store `stores.svelte.ts` exports as
  `selectedCharID`: `get` computes the index fresh, `set(index)` selects the character there, and
  subscribers are told synchronously after a selection and after every completed membership change (the
  records' hook), which also selects home when the selected character left the list. `selIdState.selId`
  is a getter and setter over a `$derived` of the same index. The `supaMemory` write is a selection
  listener registered by `characterStore` (both conditions kept). `characterList` (the summary) is left
  to `readers-characters`, its first reader.
- **Writers moved.** `createNewCharacter`, `createNewGroup`, the playground character, and the module
  conversion use `addCharacter`; `removeChar` uses `updateCharacter` (trash) or `removeCharacter`;
  `restoreChar` uses `updateCharacter`; the regex import and the send's `lastInteraction` stamp use
  `updateCharacter`; the Svelte 3 self-assignments are gone.
- **Boot.** `watchGeneration` is `watchRemoteRecords` (the inlay-cache listeners only); the trash
  pruning is one `removeCharacters`; `assignIds` is gone; `checkNewFormat`'s defaults run in one batch.

### Measurements (production build, headless Chrome, `util/playwright/measureCharacters.mjs`)

300 characters; "Big" has a 300-entry lorebook and a chat of 400 messages. Task latency medians of two
runs each, baseline `3ea20656` against 5a:

| Path                                                     | Baseline       | 5a             |
| -------------------------------------------------------- | -------------- | -------------- |
| Select Big (400-message history, default visible window) | 38.5–38.8 ms   | 37.2–38.3 ms   |
| Select a small character                                 | 7.4–7.6 ms     | 6.7–8.1 ms     |
| Typing in Big's description                              | 10.8–11.3 ms   | 9.7–10.7 ms    |
| Character lorebook drag, 300 entries                     | 100.5–105.5 ms | 110.5–110.7 ms |

The final tree (after the challenge fixes), measured again by the reviewer on an idle machine, two runs
each: Select Big 37.6 / 36.3 ms against 37.4 / 36.1 ms, Select a small character 6.4 / 7.2 ms against
8.2 / 6.9 ms, typing 11.6 / 10.9 ms against 10.0 / 10.4 ms, the drag 112.4 / 104.0 ms against
112.9 / 111.6 ms (within about 7 %). One final-tree run of mine (drag 117.8 ms) overlapped a full test
run and is not counted.

The checks passed in all four runs (the typed description and the dragged order on the server, no page
error, no egress). The drag is already one assignment of `globalLore`; its extra 5 to 10 % is the list
re-render reading through the wrappers, like slice 4's lorebook drag. It is carried to
`readers-characters` (slice 8, which moves the character lorebook's readers), with this workload
(`measureCharacters.mjs`) and slice 4's criterion: within 10 % of the baseline (100.5–105.5 ms), or the
miss reported at its stop. The selection timing covers the chat screen's default visible window
(`loadPages`), not a render of the whole 400-message history.

### After the challenge (Astra, 2026-10-04; two re-checks)

- A raw merge (`patchRawCharacter`) no longer bumps the character's epoch: it advances the epoch of
  each changed top-level field only (a node under a character carries the field it descends from, and
  resolves against the latest of the list's, the character's, and that field's epoch), so only the
  wrappers under those fields follow their paths, wherever they are, also when they are no longer in a
  child map; a retained lore entry moved locally stays that entry, and a removed one stays detached.
- A genuine same-id local replacement (`replaceCharacterRecordAt`, reached by `replaceCharacterFields`
  and the legacy setters) advances the character's epoch, so the wrappers under it follow the new
  object by path; a no-op self-replacement changes nothing.
- `initializeRecords` refuses a list that holds one object twice, before anything is installed.
- The selection store publishes through a Svelte `writable` (the standard subscribe/invalidate
  protocol and subscriber queue), set synchronously after every change and before the selection
  listeners run (a listener reads the new index; one superseded by a newer selection is skipped).
- The membership hook runs untracked, so a list change made inside a `$derived` reconciles the
  selection with it instead of throwing after the list changed.
- `resetRecords` detaches every wrapper made before it (a generation checked at the root).
- The measurement labels name the visible window.
