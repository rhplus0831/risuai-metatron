# Slice: Imports Through The Module

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 4](../../phase-4-external-contracts.md), "Export, import" (card import in
`characterCards.ts` and `importChat` in `characters.ts` create records through mutations;
`exportAsDataset` reads a snapshot; `exportChar` stays snapshot-based); `PLAN.md` Invariant 2 and
Invariant 6 (the shared formats are unchanged).

Depends on: `character-and-collection-mutations` only. Parallel with the plugin, MCP, Lua, and
trigger slices (disjoint source files; no docs edited here).

## Scope

Allowed files: `src/ts/characterCards.ts` (the character pushes and the `statics` stamp, the
module pushes of `characterURLImport`), `src/ts/characters.ts` (`importChat`'s `chatFolders`
write only), `src/App.svelte` (the drop handler's module push at 103), `src/ts/process/modules.ts`
(`importModule`), `src/ts/persona.ts` (`importUserPersona` only), `src/ts/process/lorebook.svelte.ts`
(`importLoreBook` only), `src/ts/storage/exportAsDataset.ts`. Tests belong to the review step;
the guides belong to the closeout. Not in scope (core app, Phase 6's allowlist):
`createNewCharacter`, `createNewGroup`, `removeChar`, `restoreChar`, the image and emotion
helpers, `addLorebook`, `applyModule`, the `CharConfig.svelte` regex import handler, the
module-to-character push in `ModuleSettings.svelte`, `PlaygroundMenu.svelte`, the lorebook and
regex editors, the sidebar reorders.

Identifiers (verified 2026-09-30 at `577c43ae`): `characterCards.ts`: `importCharacterProcess`
(64-298; `DBState.db.characters.push(convertOffSpecCards(...))` at 81 and 291; `db.statics.imports += 1`
through a live alias at 89-90), the private `importCharacterCardSpec` (609-935; `let db = DBState.db`
at 625, `db.characters.push(char)` at 933 unless `returnValue`), `characterURLImport` (315-475;
`DBState.db.modules.push` at 379, 415, 471; `importPreset` at 388, 426, 459, unchanged),
`downloadRisuHub` (1651-1713: through the importers, then `checkCharOrder()` and `changeChar`),
`exportChar` (574-576: `getDatabase({ snapshot: true })` then `safeStructuredClone`; already a
snapshot), `exportCharacterCard` (1143-1156: mutates its argument, which is the clone).
`characters.ts`: `importChat` (428-572: `createChat(chaId, chat, { index })` at 439, already the
chat module; `db.characters[selectedID].chatFolders = []` / `push(...folders)` at 502-504 on the
selected character), the chat exports (243-245, 577-591, read-only), `changeChar` (988-1001:
`characterFormatUpdate(index)` then `selectedCharID.set`). `App.svelte:98-110` (`importPreset`,
`DBState.db.modules.push(module)` at 103, `importCharacterProcess`). `modules.ts` `importModule`
(the six pushes at 289, 301, 323, 336, 347, 358). `persona.ts` `importUserPersona` (104-141,
`DBState.db.personas.push` at 126 with a `v4()` id; `exportUserPersona` 54-102 reads a snapshot).
`lorebook.svelte.ts` `importLoreBook` (704-742: `global` assigns `character.globalLore` and marks
at 726-731; `local` through `setChatMeta`; `sglobal` writes nothing: a core-app UI gap in
`LoreBookSetting.svelte:192`, out of scope by the safety contract, which covers writes that
reached `DBState.db`). `exportAsDataset.ts:7` (`getDatabase()` live, read-only).
`SettingsExportButtons.svelte:37-41` (already `getDatabase({ snapshot: true })`; unchanged).

Stopping condition: an import path whose record cannot be created through the module (none:
every one builds a detached object and pushes it).

## Assumptions

- `addCharacter(char)` (first slice) appends, normalizes chat ids, runs `checkCharOrder`, and
  validates the object; `changeChar` still runs `characterFormatUpdate` on the new character, so
  the import result is normalized exactly as today.
- `importPreset` assigns fresh ids and lands in `presets` by id (Phase 3 `shared-schema-and-ids`);
  verified here, not changed.
- Card, module, persona, and lore file formats are untouched (Invariant 6, D5): only the last
  statement of each importer changes.

## Proposed decisions

- Characters (proposed): the two off-spec pushes and the `importCharacterCardSpec` push call
  `addCharacter(char)`; the index return values are computed from the mirror after the call, as
  today. `db.statics.imports += 1` → `updateSettings({ statics: { ...statics, imports: statics.imports + 1 } })`
  (a `ui` field; `index.svelte.ts:357` does the same for `messages` and stays where it is, being
  the send pipeline, which is Phase 5's). `exportChar` and `exportCharacterCard` unchanged.
- Modules and personas (proposed): the ten `modules.push` sites (`characterCards.ts` 3,
  `App.svelte` 1, `modules.ts` 6) call `addModule`; `importUserPersona` calls `addPersona`.
- Lore and chat folders (proposed): `importLoreBook("global")` calls `updateCharacter(chaId,
{ globalLore })` (its own mark goes with it); `"local"` unchanged; `"sglobal"` unchanged (out of
  scope, above). `importChat`'s folder write → `updateCharacter(chaId, { chatFolders })`.
- `exportAsDataset` → `getDatabase({ snapshot: true })` (read-only today; the change is
  defensive and is what the phase file asks).

## Validation

`pnpm check`, `pnpm test` (`characterCards.test.ts`, `characters.test.ts`), `pnpm format:check`.
Exit check, discovery only, restricted to the named functions (not the whole files, which keep
core-app writes): the rooted pattern of the closeout over the line ranges of
`importCharacterProcess`, `importCharacterCardSpec`, `characterURLImport`, `importChat`,
`importModule`, `importUserPersona`, `importLoreBook`, and `exportAsDataset` answers nothing;
`rg -n 'getDatabase\(\)' src/ts/storage/exportAsDataset.ts` answers nothing. Review-step tests:
`characterCards.test.ts` gains an import case over `storeBackedServer.ts` (the character, its
chat, and the order entry are created in one cycle; a malformed card is refused by
`addCharacter` and changes nothing); `characters.test.ts` gains `importChat`'s folders;
`importModule` per file kind; `importUserPersona` gets an id; `importLoreBook("global")` on a
non-selected character (through a captured id). Manual, recorded in the closeout: a card
import (PNG, JSON, CharX) followed by a reload shows the character with its chat; a Realm
download with `goCharacterOnImport`; a chat import (`jsonl` and `risuChat` v2 with folders)
survives a reload; a dataset export contains every chat.

## Residual risk

The core-app creators and editors keep pushing into the mirror until Phase 6 (the closeout's
allowlist). Lazy loading waits for Phase 6, so dataset export, chat export, the plugin chat
getters, and the MCP read tools keep walking the eager mirror (the plan says so).
`checkCharOrder` is still called directly by `downloadRisuHub` and the drop handlers after
`addCharacter` already ran it (harmless: it is idempotent).
