# Slice: Imports Through The Module

Status: implemented (2026-10-01, on `5ad9f749`; record below).

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

## Implementation record

Implemented 2026-10-01 on `5ad9f749`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 7).

- **`characterCards.ts`**:
  - The two off-spec pushes of `importCharacterProcess` and the push of `importCharacterCardSpec`
    call `addCharacter`, which checks the card, gives its chats ids, and puts it into the order.
    The index results are still read from the mirror afterwards.
  - The `statics.imports` stamp is `incrementStatic("imports")`.
  - The three module pushes of `characterURLImport` call `addModule`.
  - `importCharacterCardSpec`'s unused `let db = DBState.db` is removed. `exportChar` and
    `exportCharacterCard` are unchanged.
- **`modules.ts`**: the six pushes of `importModule` call `addModule`. The CharX branch reports
  success only after the add (challenge 1).
- **`App.svelte`**: the drop handler's module push calls `addModule`.
- **`persona.ts`**: `importUserPersona` keeps Phase 3's icon-first order, then calls
  `addPersona`.
- **`database.svelte.ts`** (A24): the three `botPresets` pushes of `importPreset` call
  `addPreset(normalizePreset(...))`.
  - The converted preset is normalized first, as the old push did. The ST conversion computes
    `pre.presence_penalty * 0.7 * 100`, which is `NaN` for a file without that parameter; the
    normalizer gives the field its default, where `addPreset`'s JSON check would refuse it (the
    `presetIds.test.ts` ST case showed this).
  - The generic path takes its id from `addPreset`, and the file's `proxyKey` still goes to the
    per-preset secret map. The `botPresets` array guard is gone: presets are always a list since
    Phase 3.
- **`lorebook.svelte.ts`**: `importLoreBook("global")` writes
  `updateCharacter(chaId, { globalLore: [...current, ...imported] })`. It reads the current list
  through `findCharacter` by the id captured before the dialog. A character removed meanwhile gets
  nothing, and its own mark goes. `"local"` and `"sglobal"` are unchanged.
- **`characters.ts`**, `importChat` as a whole (A23):
  - it captures `chaId` before the file dialog, then resolves it again by id afterwards, and stops
    with an error when that character was deleted meanwhile (a new `language.errors.importTargetGone`,
    challenge 2; `src/lang/en.ts` joins the files, and the other locales fall back to English);
  - the Tavern name and the folders are read from that record;
  - the folders are written with `updateCharacter(chaId, { chatFolders })`;
  - `changeChatTo(0)` runs only while that character is still selected.
- **`exportAsDataset.ts`**: `getDatabase({ snapshot: true })`.

Recorded behavior changes:

- A card that is not JSON data (a function, a non-finite number, a class instance) is refused by
  `addCharacter`. The character list, its chats, and the order are then unchanged. The importer as
  a whole is not transactional: the `statics.imports` stamp (taken before parsing) and an image
  already saved stay (challenge 3). Before, such a card was pushed as is.
- A CharX module import that `addModule` refuses reports the error only. Before, it also reported
  success (challenge 1).
- `importChat` writes the character selected when the dialog opened, even if the selection moved
  while it was open. It reads that character's name and folders. Before, it read and wrote
  whatever was selected when the file arrived (recorded as fixed).
- `importLoreBook("global")` already used the captured id; it now writes through the character
  module.

No stopping condition was met.

Exit checks:

- The rooted pattern over the eight named functions (`importCharacterProcess`,
  `importCharacterCardSpec`, `characterURLImport`, `importChat`, `importModule`,
  `importUserPersona`, `importLoreBook`, `exportAsDataset`) and over `importPreset` answers nothing.
- The hits left in those files are core-app functions on the closeout's allowlist:
  - `createNewCharacter` and `createNewGroup`;
  - the image and emotion helpers;
  - `removeChar` and `restoreChar`;
  - the lore editors' `addLorebook`.
- `rg -n 'getDatabase\(\)' src/ts/storage/exportAsDataset.ts` answers nothing.

The deliberately invalidated tests: none. The `presetIds.test.ts` failure above was fixed in source
(the normalization order), not by changing the test, so no test adapter ran.

Checks:

- `pnpm check`, `pnpm format:check`, and `pnpm build` pass.
- `pnpm test`: 93 files, 976 passed, 3 skipped.
- `pnpm test:e2e`: 5 passed.

Manual check (Playwright, scratchpad `checkP4Slice7.mjs`; the dialogs go through Playwright's
file chooser). With Alpha selected:

- A character with an image and a lore entry was exported to PNG (v2) and CharX (v3) through the
  app's writer, then imported back. A hand-written v2 JSON card and an off-spec JSON card were
  imported too. Each import added one character with its chat, lore, and image (PNG and CharX),
  and the order grew to match.
- `statics.imports` counted the PNG and CharX imports. The JSON paths return before the stamp, as
  before.
- A `jsonl` chat and a `risuChat` v2 chat with a folder imported into Alpha, with the folder
  added and the chat in it.
- A `risuModule` JSON imported with a fresh id.
- A global lore import opened its dialog with Alpha selected, and the selection moved to Beta
  before the file was chosen. The entry landed in Alpha, and Beta was unchanged.
- Everything held after a reload.
- The dataset export downloaded `dataset.json` with the characters' chats.
- No page errors. The console's 502s are the Realm hub proxy, which has no network in the
  sandbox.

Found in passing, and left alone as pre-existing: an off-spec card with only `char_name` imports as
"unknown name". The check accepts `char_name`, but `convertOffSpecCards` reads `name`.

## Tests

Written by the Fable review (verdict: no problem), over the real save adapter and server store.
The fixtures are in `src/ts/storage/tests/importFixtures.ts`: a hand-built PNG (tEXt chunks), a
CharX zip, V2 and V3 cards, and an object nested past the JSON limit.

- **`src/ts/characterCardsImport.test.ts` (10).**
  - JSON V2, off-spec JSON, PNG, and CharX (the real chunk reader and zip importer) each create a
    character with a fresh id, a chat with an id, and an order entry, all on the server after one
    cycle.
  - `returnCharacter` adds nothing, and the stamp goes through `incrementStatic`.
  - A refused card changes no character, chat, or order. Through PNG, the stamp and the saved image
    stay (the narrowed boundary). `importCharacter` reports the refusal.
- **`src/ts/charactersImportChat.test.ts` (7).** A jsonl chat and a v2 chat with folders import into
  the character captured before the dialog, even after:
  - the selection moved;
  - the list was reordered;
  - the record was replaced under the same id.

  The name is substituted from the re-resolved record. A folder id collision is remapped. The other
  character's chat selection is untouched. A deleted target answers `importTargetGone` and writes
  nothing.

- **`src/ts/process/modulesImport.test.ts` (8).** Every file kind: `.risum`, CharX (no character is
  created), native module JSON (a fresh id, with the `lowLevelAccess` confirmation kept), native and
  external lore, and regex. A refused CharX module reports the error only and inserts nothing.
- **`src/ts/personaImport.test.ts` (3).** An imported persona gets an id and the saved icon, and the
  selection is unchanged. With the collection replaced during the icon save, the persona lands in
  the current list. A file without the chunk adds nothing.
- **`src/ts/process/lorebookImport.test.ts` (3).**
  - The global lore lands in the captured character when it is not selected, and only that record
    is sent.
  - A record replaced with newer lore during the dialog gets the entries appended to its current
    list.
  - A deleted target gets nothing and is not recreated.
- **`src/ts/storage/tests/presetIds.test.ts` (+3).** An ST preset without `presence_penalty` gets
  the field's default. An NAI preset with omitted parameters gets the NAI defaults. A JSON
  `proxyKey` goes to the new preset's secret only.

`pnpm test`: 98 files, 1010 passed, 3 skipped. `pnpm check` and `pnpm format:check` pass.

## Astra challenge

Astra (the open plan-review session) challenged the implementation. Report:
`astra-p4-slice7-challenge.md` (scratchpad). It found no target-identity or persistence-routing
defect, and it accepted the preset pre-normalization, the removed array guard, and the missing test
adapter. Decisions:

1. **Medium: a refused CharX module import reported an error and then success.** The success alert
   followed the `try`. **Adopted:** it now follows the successful `addModule`.
2. **Low: the new deleted-character error was a hard-coded English string** (STRUCTURE U2).
   **Adopted:** `language.errors.importTargetGone` in `src/lang/en.ts`.
3. **Low: "a malformed card changes nothing" overstated the refusal.** The stamp and a saved image
   stay. **Adopted:** the behavior change is narrowed to the character list, its chats, and the
   order; the importer stays non-transactional.

Astra's testing advice goes to the Fable review with Opus's judgement.
