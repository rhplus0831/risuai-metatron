# Module and Persona Folders Plan

Status: drafted 2026-11-17 at `ace54e7da` from the owner's request of the same day (folders for the module list and the
persona list). Audited against the code at that commit before it was committed
([report](../reports/audits/plan-runner/module-persona-folders-2026-11-17.md)) and corrected in the same commit as the
report. D1 to D4 are the owner's choices of 2026-11-17; D5 on are this plan's own and open to the owner's change. The
folder choices of the move dialog, the registries of slice 1, and the Sortable rules of slice 3 took their present
form from the audit. Landed: 1 (`e3bba40b2`), 2 (`683f03275`).

Sources: `RisuModule` and `normalizeModule` in `shared/modules.ts`; `normalizePersonas` and `normalizePersonaModules` in
`shared/personas.ts`; `folder` and `ChatFolder` in `shared/database.ts`; `COLLECTION_KIND` and `COLLECTION_FIELDS` in
`shared/sections.ts`; `RESOURCE_KIND` and `BOOT_CACHE_ELIGIBILITY` in `shared/resources.ts`; `itemIds` in
`shared/recordPatch.ts`; `COLLECTION_MERGE_POLICIES` and `mergeItems` in `src/ts/storage/recordMerge.ts`; `settingsKind`
in `server/src/data/kinds.ts`; `server/src/data/normalize/collections.ts`; `METATRON_ONLY_SETTINGS` in
`server/src/data/upstream/exportDatabase.ts`; `removeModule`, `addPersona`, `setModules`, and `setPersonas` in
`src/ts/storage/collectionStore.svelte.ts`; `batchRecordWrites` in `src/ts/storage/records.svelte.ts`; `getModules` in
`src/ts/process/modules.ts` and `jobModules` in `server/src/jobs/cbsHost.ts`; `exportModuleLegacy` in
`src/ts/process/modules.ts`; `importUserPersona` in `src/ts/persona.ts`; `allowedDbKeys` in
`src/ts/plugins/plugins.svelte.ts`; `src/lib/Setting/Pages/Module/ModuleSettings.svelte` and `ModuleChatMenu.svelte`;
`src/lib/Setting/Pages/PersonaSettings.svelte`; `src/lib/SideBars/chatFolders.ts`; the device-local id list of
`src/ts/ooc/oocToggleSettings.svelte.ts`; `src/lang/en.ts` and `src/lang/ko.ts`. The identifiers are the anchors.
Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

The user can file modules and personas into named folders, one level deep, and the lists that grow longest show them
grouped.

- **A folder only organizes (D1).** It never decides which modules run. `getModules`, `jobModules`, a chat's and a
  character's `modules`, `enabledModules`, and a persona's `modules` keep their meaning.
- **A folder can switch its modules together (D1).** The folder row's button writes the same ids the per-module buttons
  write, in one write.
- **Organizing never touches a module or persona record.** A move changes a small folder record only, so it cannot
  conflict with an edit of the module's content and nothing about folders reaches a `.risum`, a CharX, a persona PNG,
  or an upstream export.
- **Fold state stays on the device (D2).** Collapsing a folder writes nothing to the server.

Not goals: nested folders, a folder color or icon, folders in the chat's persona picker (`listedPersona.svelte`), the
binding panel, or the persona editor's module-link list (D3), and any change to what a request is sent with.

## Current State

- **Modules** are the `modules` singleton record, a list of `RisuModule` merged per item (`COLLECTION_MERGE_POLICIES`
  `modules: "items"`, the whole item is one unit). `ModuleSettings.svelte` and `ModuleChatMenu.svelte` each sort the
  whole list by name with their own `sortModules` and filter it by the search query; neither has a user order.
- **A module record travels.** `exportModuleLegacy` writes the whole module object into the `.risum` main record, and
  `normalizeModule` keeps every field, so a field added to `RisuModule` would be exported and re-imported.
- **Personas** are the `personas` collection (`nonemptyItems`), in the user's order: `PersonaSettings.svelte` renders
  every persona as a tile and its Sortable `onEnd` rebuilds `settings.personas` from the indexes of the rendered tiles
  (`data-risu-idx`). A persona missing from the DOM would be dropped from the list by that rebuild.
- **Two folder designs exist.** Character folders are entries of `characterOrder` (`(string | folder)[]`, merged
  `whole`); the order record decides what is listed, so `src/ts/storage/characterOrder.ts` repairs it at three entry
  points. Chat folders are a `ChatFolder[]` on the character plus `Chat.folderId`; `chatFolderOf` reads a dangling id
  as unfiled, so nothing repairs it.
- **Deletion has two module paths.** `removeModule` in `collectionStore.svelte.ts` removes the module and its id from
  `enabledModules` in one `batchRecordWrites`. The catalog's trash button splices `settings.modules` and
  `settings.enabledModules` itself. The persona page splices `settings.personas` itself.
- **`inputHooks` and `togglePresets` are the latest collections added.** The registries they appear in are the list a
  new collection follows (`rg -n "togglePresets" shared server/src src/ts`).
- **The plugin database object exposes only `allowedDbKeys`** and the collections `applyPluginKey` names; any other key
  a plugin writes goes into `pluginCustomStorage`.

## Rules For Every Slice

- `RisuModule`, `RisuPersona`, and every stored module and persona keep their fields. No slice adds a folder field to
  either.
- The item lists stay the source of what is listed and in what order: an item named by no folder is at the root, an
  item named by several folders belongs to the first of them in list order, and an id that names no item is ignored and
  left as stored. No slice adds a repair pass.
- `getModules`, `jobModules`, `personaModuleIdSet`, the RisuAccess tools, and `allowedDbKeys` do not change.
- User-visible strings go to `src/lang/en.ts` with their Korean text in `src/lang/ko.ts`; other locales fall back.
- V1 to V9 apply. Each slice updates the guides it names (`pnpm docs:owner <path>`, `pnpm check:docs`). Full checks:
  `pnpm check`, `pnpm check:docs`, `pnpm format:check`, `pnpm --silent test:agent`, and the specs
  `pnpm --silent test:agent --e2e` selects for the diff.
- Workflows: `opus-lite` for a slice without a size, `opus-workflow` for a _hard_ slice.

## Order

1, then 2, then 3. Slices 2 and 3 use the records and helpers of slice 1. They touch different screens, but both edit
`src/lang/en.ts`, `src/lang/ko.ts`, and `docs/structure/characters-modules.md`, so they run one after the other.

## Slice 1. The folder records (_hard_, `persistence.md`, `resource-sync.md`, `characters-modules.md`, `backup-sync-hub.md`, `server-resources.md`, `server-generation.md`)

No screen changes in this slice.

Existing: `shared/database.ts`, `shared/sections.ts`, `shared/resources.ts`, `server/src/data/kinds.ts`,
`server/src/data/normalize/collections.ts`, `server/src/data/upstream/exportDatabase.ts`,
`src/ts/storage/recordMerge.ts`, `src/ts/storage/collectionStore.svelte.ts`, `server/src/prompt/displayKinds.ts`,
`src/ts/storage/snapshots.svelte.ts`, and the tests and fixtures that list every collection:
`server/src/tests/kinds.test.ts` (`settingsKinds`), `src/ts/storage/tests/presetSchema.test.ts` (the collection count,
17 today), `src/ts/storage/tests/fixtures/boot/boot-snapshot.json` (both defaults `[]`), and
`src/ts/storage/tests/snapshots.test.ts` (`LATER_REMOVED_KEYS`). New: `shared/itemFolders.ts` and its test.

- **Shape** (`shared/database.ts`): `ItemFolder { id: string; name: string; data: string[] }`, and
  `Database.moduleFolders: ItemFolder[]` and `Database.personaFolders: ItemFolder[]`. `data` holds module ids or
  persona ids; its order means nothing.
- **Two collections of their own kind**: `moduleFolders` and `personaFolders` in `COLLECTION_KIND`,
  `COLLECTION_FIELDS`, `RESOURCE_KIND`, `BOOT_CACHE_ELIGIBILITY` (`eligible`: names and ids, no credential field), and
  `server/src/data/kinds.ts` (`settingsKind`). Two more registries take both names: `DISPLAY_KIND_CLASSIFICATION` in
  `server/src/prompt/displayKinds.ts` as `drop` (no display transform reads a folder), and `REPORT_REMOVED_KEYS` in
  `snapshots.svelte.ts` (folder names are the user's free text, so the settings report leaves them out). The boot, the
  settings views, the save and feed paths, the journal, the server projection, the job scope, and the upstream
  importer derive their collections from the collection maps, and the native backup and restore carry resource rows
  whatever their kind, so none of them needs an entry. The kinds do not join
  `BOOT_ITEM_KINDS`, `COLLECTION_SELECTION_FIELDS`, `ITEM_RECORD_FIELDS`, or `allowedDbKeys`.
- **Normalizer** (`normalizeItemFolders` in `shared/itemFolders.ts`, applied by the server kind): a missing record is
  `[]`; the server refuses a value that is not a list of objects (`requireArrayOfObjects`); each entry keeps only `id`,
  `name`, and `data`; an invalid or repeated `id` gets a fresh one as `normalizePersonas` does; a `name` that is not a
  string becomes `""`; `data` becomes its non-blank strings, each once, in first-occurrence order (the rule of
  `normalizePersonaModules`, shared rather than copied). The result of a normalized list is that list (fixed point).
  An id listed by two folders is kept in both: the read rule decides.
- **Pure helpers** (`shared/itemFolders.ts`): `folderOfItem(folders, itemId)` (the first folder listing it, or null);
  `groupByFolder(items, folders)` returning every folder with its items and the root items, each item once, in the
  order `items` came in; `withItemInFolder(folders, itemId, folderId | null)` returning a list where `itemId` is in no
  folder but the target (a missing target leaves it at the root); `withoutItem(folders, itemId)`. They return new
  lists and reuse untouched folder objects.
- **Merge**: `moduleFolders: "items"` and `personaFolders: "items"` in `COLLECTION_MERGE_POLICIES`. Two tabs that
  change different folders merge, and equal changes of one folder converge; differing changes of one folder conflict,
  and the whole folder record then takes the ordinary whole-record acceptance (the server's list).
  `BY_ID_FIELDS` is unchanged: the mutations below assign the list through the settings view
  and no control binds to a folder element.
- **Mutations** (`collectionStore.svelte.ts`, keyed by `"moduleFolders" | "personaFolders"`):
  `addItemFolder(kind, name)` returning the new id, `renameItemFolder(kind, id, name)` (both refuse a blank name),
  `removeItemFolder(kind, id)` (the folder only; its items are at the root from then on), and
  `moveItemToFolder(kind, itemId, folderId | null)`. Each does nothing and returns false when its folder is gone.
- **Deletion**: `removeModule` also removes the id from `moduleFolders`, inside its `batchRecordWrites`. New
  `removePersona(id)` holds what the persona page does today (never the last persona, the tab's selection moves on
  first) plus the removal from `personaFolders`, in one `batchRecordWrites`. `setModules` and `setPersonas` (a plugin's
  whole-list write) leave the folders alone. `batchRecordWrites` groups the local notifications; the two kinds can still
  settle apart after a conflict or a refusal. A deletion that saves while the folder write does not leaves a stale
  member id, which the read rules ignore. A folder write that saves while the deletion loses to another tab's edit
  leaves the surviving item at the root; the module's global enablement and the tab's persona selection are not put
  back either, as today.
- **Upstream export**: both names join `METATRON_ONLY_SETTINGS`, so the exported database has neither and the report
  names a non-empty one as the existing mechanism does.
  An upstream database, which has neither field, imports with both at `[]`.
- Tests: the normalizer's rules and fixed point; `groupByFolder` with an id in two folders, an id naming no item, and
  an empty folder; `mergeItemCollection` for a move in one tab and a rename of another folder in the other (merges)
  and for two differing changes of one folder (null); `removeModule` and `removePersona` clearing the id;
  the upstream export
  dropping both fields; the settings report leaving both out; the existing per-kind cases gaining the two kinds
  (`resourceKinds.test.ts` `CASES`, `resourceSyncSections.test.ts` `customRecords`). A fresh server's idle reload
  writes neither record (the collection round trip of `persistence.md` Recipes).
- Guides: `persistence.md` Resources and Mutation modules name the two kinds and the mutations; `resource-sync.md`
  Record merge names their policy; `characters-modules.md` State says folders are an overlay over the item lists and
  gives the three read rules; `backup-sync-hub.md` names the two excluded fields; `server-resources.md` names the kinds
  and their normalizer; `server-generation.md` names their display classification.

## Slice 2. Module folders on the catalog and the chat menu (`characters-modules.md`, `ui-theming.md`)

Existing: `src/lib/Setting/Pages/Module/ModuleSettings.svelte`, `ModuleChatMenu.svelte` beside it, `src/lang/en.ts`,
`src/lang/ko.ts`, and the tests that mount the two components with a settings mock or a flat database that has no
folder collection (`ModuleSettings.share.test.ts`, and the fixtures `installFlatDatabase.ts` installs as given).
New: `src/lib/Setting/Pages/Module/moduleCatalog.ts` (the shared row order) and its test,
`src/ts/gui/itemFolderFold.svelte.ts` (the device's folded folder ids) and its test, and
`src/lib/Setting/Pages/Module/ModuleFolderRow.svelte`.

- **One row order for both screens** (`moduleCatalog.ts`): folders by name, each with its modules by name, then the
  root modules by name, using today's comparison (`toLowerCase().localeCompare`). Membership is resolved with the
  folders in stored order (`groupByFolder`) before the folder rows are sorted, so the first-folder rule holds.
  With a search query only matching
  modules are listed (by module name, as today), a folder without a match is left out, and the remaining folders show
  open whatever their fold state. Both components drop their own `sortModules`.
- **Fold state** (`itemFolderFold.svelte.ts`): one `localStorage` list of folded folder ids, read and written as
  `oocToggleSettings.svelte.ts` does (a failed write keeps the value in memory, a change re-renders mounted lists in
  this tab). A folder is open by default. Ids of folders that no longer exist are dropped on a write.
- **The folder row** (`ModuleFolderRow.svelte`): a chevron, a folder icon, the name
  (a blank one shows as the localized "Unnamed
  folder", in every list, tile, and choice of this plan), and the member count; a click on
  the row folds or unfolds; the caller passes the buttons. Member rows are indented under it. An empty folder shows its
  row only.
- **The catalog** (`ModuleSettings.svelte`):
  - A module row gains a "move to folder" button. Before the dialog it captures the module id and the choices
    (`folderChoices` in `moduleCatalog.ts`: the folder ids by name, then null for "No folder", with one label each).
    `alertSelect` encodes its options with `||` and reads a leading `__DISPLAY__`, so the call always passes a
    `display` line (a fixed localized line without `||`) and a label holds no ASCII `|` (each is shown as `｜`,
    U+FF5C); stored names are not changed. The answer is mapped through the captured ids; an answer that is not an
    integer within the list (a cancel and Escape answer `""`) does nothing. `moveItemToFolder` then runs only when the
    module and the chosen folder still exist. MCP modules have the button too.
  - A folder row has three buttons: switch all globally, rename (`alertInput`), and delete (`alertConfirm` saying the
    modules stay). They are hidden in character conversion mode.
  - **Switch all globally**: when every module of the folder is in `enabledModules` the button removes them all,
    otherwise it adds the missing ones; one assignment of `settings.enabledModules`. The icon is blue when all are
    enabled.
  - The bottom bar gains a "new folder" button (`alertInput`, then `addItemFolder`).
  - The trash button calls `removeModule` instead of splicing the two lists itself (it clears every copy of the id in
    `enabledModules`, where the inline code cleared one).
- **The chat menu** (`ModuleChatMenu.svelte`): the same rows, with no folder editing.
  - A folder row shows "on / total" for its modules (on: globally enabled or in the chat's `modules`) and, outside
    `alertMode` and while the chat is loaded, a "switch all for this chat" button. Its targets are the folder's modules
    that are not globally enabled (those rows are disabled today): when every target is in the chat's `modules` it
    removes them, otherwise it adds the missing ones, in one `setCurrentChatMeta`.
  - The right-click write to the character's `modules` stays per module.
- Tests: the row order (folders first, name order, the query rule, an id in two folders); `folderChoices` and the
  answer mapping for folders named `A||B`, `|`, `|`, and `C`, and for the answers `""` and an index past the list;
  the fold store (default
  open, a failed write, pruning); the two "switch all" rules as pure functions over id lists (all on, some on, none
  on, globally enabled members left out of the chat rule); a component test that the catalog's move button files a
  module and that the folder delete leaves its modules listed at the root.
- Guide: `characters-modules.md` Module settings names the row order, the folder choices, and the two "switch all"
  rules, and its Scope and Files name the new module files; `ui-theming.md`, which owns `src/ts/gui/`, names the fold
  store.

## Slice 3. Persona folders on the persona page (`characters-modules.md`, `settings-i18n.md`)

Existing: `src/lib/Setting/Pages/PersonaSettings.svelte`, `src/ts/persona.ts`, `src/lang/en.ts`, `src/lang/ko.ts`,
`src/lib/Setting/Pages/PersonaSettings.test.ts` (it selects `button[data-risu-idx]`), and
`src/ts/personaImport.test.ts`.
New: `src/lib/Setting/Pages/personaGrid.ts` (the reorder rule) and its test.

- **Two views of the grid.** The root view shows the folder tiles (by name), then the personas in no folder, in list
  order, then the add tile. A click on a folder tile opens the folder view: a back tile, then that folder's personas in
  list order, then the add tile. The open folder is the component's state (`openFolderId`); when that folder
  disappears the grid returns to the root. The page opens at the root.
- **A folder tile** shows a folder icon, the name, and the member count, and carries the selection ring when it holds
  the tab's selected persona. Folder tiles, the back tile, and the add tile are not draggable: they carry the
  `no-sort` class that `sortableOptions` filters and guards against, and the touch delay stays as it is. The page's
  Sortable also sets `preventOnFilter: false`, so a filtered tile keeps its click on every input kind. A view change
  replaces the grid's tiles, so Sortable is destroyed and created again for it the way a reorder does today
  (`sorted`, `{#key sorted}`).
- **Reorder** (`personaGrid.ts` `reorderShown(list, shownIdsInNewOrder)`): the shown personas take, in their new
  order, the list positions the shown personas held; every other persona keeps its position. `onEnd` reads the shown
  ids from the DOM (`data-risu-id` replaces `data-risu-idx`) and assigns the result once. A drag never changes a
  folder.
- **Filing**: the editor below the grid gains a "Folder" select for the shown persona (the folders by name, then "No
  folder"), written with `moveItemToFolder` for the record `editedPersonaRecord()` returns at the change. Next to it:
  "New folder" (`alertInput`), and, in a folder view, "Rename folder" and "Delete folder" (`alertConfirm` saying the
  personas stay).
- **New personas**: a persona created with the add tile, or imported, while a folder is open is filed into that
  folder. `importUserPersona` returns the new persona's id, or null on every path that adds none, and both import
  buttons of the page (the grid's and the editor's) file through it. An imported persona stays unselected, as today.
- **Deletion** calls `removePersona`.
- The grid click (`changeUserPersona(persona.id, null)`), the module-link list, and the rest of the editor are
  unchanged.
- Tests: `reorderShown` (a folder's members reordered among interleaved root personas, a shown id that is gone, an
  empty shown list); `importUserPersona`'s id on success and null otherwise; the page test's selectors by id;
  a component test that a reorder inside a folder keeps every persona outside it, that the select
  files the edited persona, and that a persona created in a folder view is listed there.
- Guide: `characters-modules.md` Personas and conversion, and Invariants Personas, describe the two views, the reorder
  rule, and where a new persona is filed; `settings-i18n.md`, which owns `src/lib/Setting/Pages/personaGrid.ts`, names
  it.

## Decisions

- **D1. A folder organizes; it is not an activation unit.** (Owner, 2026-11-17.) "Switch all" is a convenience that
  writes the per-module ids, so the client and server module resolvers stay as they are.
- **D2. Fold state is per device and not stored in a record.** (Owner, 2026-11-17.) Chat folders store `folded`;
  these do not, so folding causes no write and no conflict.
- **D3. The chat's persona picker, the binding panel, and the persona editor's module-link list come later.** (Owner,
  2026-11-17.)
- **D4. One level.** (Owner, 2026-11-17, with the design.) Character and chat folders are one level too.
- **D5. Folders are their own records that list member ids.** Rejected: a `folderId` on the item (a move would change
  the module item, which is one merge unit, so it would conflict with a content edit elsewhere, and
  `exportModuleLegacy` would export the field); folders inside an order record as `characterOrder` has them (the order
  record then decides what is listed and needs the repairs of `characterOrder.ts`).
- **D6. The item list decides what is listed; folders are an overlay.** The three read rules replace a repair pass. A
  stale id in a folder costs a few bytes and shows nothing.
- **D7. The same shape and helpers for modules and personas, in two records.** A change of module folders and a change
  of persona folders never meet in one merge.
- **D8. Per-folder merge (`items`).** Two devices organizing different folders merge. The cost: a rename of a folder
  on one device and a move into it on another conflict, and the server's copy of the whole folder list wins.
- **D9. No color or icon.** The normalizer keeps three fields; adding one later is a normalizer change.
- **D10. Modules move by a button and a list, not by dragging.** The catalog has no drag today and the button works on
  a phone. Personas keep their drag for order only and file through the select; dropping a tile onto a folder is left
  out.
- **D11. The persona grid opens a folder instead of showing sections.** The grid has one Sortable; one flat set of
  tiles per view keeps the reorder rule to one function.
- **D12. A search lists matches by module name only.** Matching folder names is open to the owner's change.

## Not In This Plan

- **Folders in `listedPersona.svelte`, `ChatBindingPanel.svelte`, and the persona module-link list** (D3).
- **Nested folders, folder colors, folder icons.**
- **A folder as something a chat, a character, or a persona links.**
- **Pruning ids of items deleted on another device.** They are ignored on read.
- **Plugin and RisuAccess access to folders.**
- **Filing on import of a `.risum`** (an imported module lands at the root).
- **A bulk switch of a folder for the character's `modules`.**
- **Dragging a module or a persona onto a folder.**

## Manual Checks

For the owner, after slice 3:

1. Create a module folder, move three modules into it, reload: the folder and its members are as left.
2. Fold the folder, reload: it is still folded on this device and open on another device.
3. Press the folder's globe with one member enabled: all three are enabled. Press again: all three are disabled.
4. In a chat's module menu, press the folder's check: its modules that are not globally enabled turn on for that chat
   only.
5. Delete the folder: its modules are listed at the root, none is deleted.
6. Export a filed module as RisuM and import it into another install: it arrives at the root.
7. On two devices, move a module into folder A on one and edit that module's lorebook on the other: both changes are
   there after both save, with no conflict notice.
8. Create a persona folder, file two personas, open the folder, drag to reorder, go back: the root personas kept their
   order and nothing disappeared.
9. Create a persona while a folder is open: it is listed in that folder and selected.
10. Delete a persona folder: its personas are listed at the root.
