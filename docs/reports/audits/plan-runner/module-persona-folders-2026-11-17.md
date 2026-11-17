# Module and Persona Folders Plan audit, 2026-11-17

- Plan: `docs/plan/module-persona-folders.md`
- Commit audited: `ace54e7da` (`dev`), with the plan as an uncommitted draft in the working tree. The corrected plan
  is committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, in place of the procedure's Sol because slice 1 changes `shared/` and
  `server/` contracts; report written by the session that drafted the plan (Claude Fable 5.2), before any plan-runner
  run

| Severity   | Count |
| ---------- | ----- |
| P1         | 1     |
| P2         | 0     |
| P3         | 6     |
| unverified | 0     |

All seven findings are closed and `fixed in plan`. The first turn filed A1 to A5. The second turn read the drafted
corrections, confirmed A2 and A5, disputed A1 (the first correction replaced `||` inside a label and missed pipes at
the edges of two adjacent labels) and two details of A3, asked for one more sentence on A4, and filed A6 and A7 against
the corrections themselves. The third turn confirmed the second corrections of A1, A4, A6, and A7 and found nothing
new.

Astra changed no file in the repository and ran no test or type check: the audit is a reading of the code. During the
first turn the read-only check reported a changed git state with no changed path; it was another session's commit on
its own branch in another worktree, and `dev` and this checkout's files were as before. The three turns took about 20
minutes and 6.3 M tokens.

Re-check list: the plan adds two resource kinds, so two entries apply. Feed rows are measured whole against
`MAX_FEED_PATCH_BYTES` (`shared/resources.ts:540`, `server/src/data/resourceStore.ts:3709`): a membership change
carries the changed folder's whole `data` list, and a row past 64 KiB falls back to a reference the client reads, so
no limit or branch is needed. `STORE_TABLES_SQL` runs only on a fresh database (`resourceStore.ts:3861`):
`resources.kind` is unconstrained text (`:115`) and a missing singleton row is inserted when an existing store opens
(`:988`), so the new kinds need no table change and no migration. `patchMessage` and `sendText` do not apply: the plan
patches no message and adds no job notice.

Found consistent: a new settings collection is served by the settings views, the boot, the save and feed paths, the
journal, the server projection, the job scope, and the upstream importer through the collection maps
(`src/ts/storage/records.svelte.ts:87`, `:143`, `src/ts/storage/settingsViews.svelte.ts:701`, `src/ts/bootstrap.ts:94`,
`:259`, `src/ts/storage/resourceSync.svelte.ts:257`, `:4776`, `server/src/jobs/jobScope.ts:133`,
`server/src/data/upstream/importDatabase.ts:254`); a whole-list assignment still saves as an item patch when the ids
are valid, and a conflict reaches `mergeItemCollection` without a `BY_ID_FIELDS` entry, as `credentials` and
`customModels` do (`resourceSync.svelte.ts:1939`, `:2677`, `:3938`, `:4129`); the normalizer's fresh id for a bad one
keeps the fixed point, as `normalizePersonas` does (`shared/personas.ts:56`); `METATRON_ONLY_SETTINGS` drops and
reports a collection field (`server/src/data/upstream/exportDatabase.ts:158`, `:421`); native backup and restore carry
resource rows of any registered kind (`server/src/routes/backups.ts:333`, `resourceStore.ts:3245`); a plugin's
database object holds only `allowedDbKeys`, so it neither reads nor overwrites a folder record
(`src/ts/plugins/apiV3/v3.svelte.ts:2892`, `:2314`); `getModules`, `jobModules`, and the RisuAccess hosts need no
change (`src/ts/process/modules.ts:807`, `server/src/jobs/cbsHost.ts:357`, `src/ts/process/mcp/risuaccess/host.ts:51`,
`server/src/mcp/internal.ts:260`); `normalizeModule` keeps unknown fields and `exportModuleLegacy` serializes the
module object (`shared/modules.ts:87`, `src/ts/process/modules.ts:154`), which is D5's reason; the persona page
rebuilds the whole list from rendered indexes (`src/lib/Setting/Pages/PersonaSettings.svelte:75`); the fold store's
model (`src/ts/ooc/oocToggleSettings.svelte.ts:48`); the chat menu's `alertMode`, its rows without a handler for
globally enabled modules, and its two writes (`src/lib/Setting/Pages/Module/ModuleChatMenu.svelte:90`, `:124`);
`alertInput` (`src/ts/alert.ts:480`); every "Existing" path, every "New" path being free and already covered by an
ownership rule, and the order 1, 2, 3.

## P1

### A1 — Slice 2: folder names passed to `alertSelect` can shift the answer — fixed in plan

- Plan (Slice 2, the catalog): "A module row gains a "move to folder" button: it captures the module id, asks with
  `alertSelect` (the folders by name, then "No folder"), and calls `moveItemToFolder` with the folder id resolved after
  the dialog; a module or folder gone meanwhile cancels."
- Code: `alertSelect` joins its labels with `||` without escaping (`src/ts/alert.ts:329`), and the dialog splits on
  `||` and answers with a button index (`src/lib/Others/AlertComp.svelte:510`). With folders named `A||B` and `C`, the
  dialog shows A, B, C, and "No folder"; a click on C answers 2, which the three-entry list maps to "No folder", so the
  module is unfiled instead of moved. A cancel and Escape answer `""` (`src/ts/alertQueue.ts:169`,
  `src/ts/hotkey.ts:78`), which `parseInt` turns into `NaN`.
- First correction, disputed: showing `||` inside a label as `| |`. Two folders both named `|` still produce a run of
  pipes across the label boundaries and one button too many.
- Correction, confirmed: "Before the dialog it captures the module id and the choices (`folderChoices` in
  `moduleCatalog.ts`: the folder ids by name, then null for "No folder", with one label each). `alertSelect` encodes
  its options with `||` and reads a leading `__DISPLAY__`, so the call always passes a `display` line (a fixed
  localized line without `||`) and a label holds no ASCII `|` (each is shown as `｜`, U+FF5C); stored names are not
  changed. The answer is mapped through the captured ids; an answer that is not an integer within the list (a cancel
  and Escape answer `""`) does nothing. `moveItemToFolder` then runs only when the module and the chosen folder still
  exist." A blank name shows as the localized "Unnamed folder" wherever a folder is listed, `addItemFolder` and
  `renameItemFolder` both refuse a blank name, and the slice's tests name the folders `A||B`, `|`, `|`, and `C`.
- Graded P1 by the auditor as a mechanism that misfiles as written. No module or persona record is changed by it; the
  cost would have been a module landing at the root or in another folder.

## P3

### A2 — Slice 1: a deletion and its folder cleanup can settle apart — fixed in plan

- Plan (Slice 1, Deletion): "`removeModule` also removes the id from `moduleFolders`, inside its `batchRecordWrites`."
- Code: `batchRecordWrites` groups the local notifications per kind (`src/ts/storage/records.svelte.ts:668`); one
  server batch is transactional (`server/src/data/resourceStore.ts:1906`, `:2008`), but a conflict or a refusal is then
  handled per record (`src/ts/storage/resourceSync.svelte.ts:4295`, `:4395`, `:3166`). A deletion that loses to another
  tab's edit of the module leaves the module alive while the folder cleanup saves.
- Correction, confirmed: the Deletion bullet now states both outcomes (a stale member id that the read rules ignore; a
  surviving item at the root, with the global enablement and the tab's persona selection not put back, as today). No
  test was added for them: they are the save path's existing behavior.

### A3 — Slice 1: the registries and fixtures were left to "every other registry" — fixed in plan

- Plan (Slice 1): "and every other registry `togglePresets` appears in".
- Code: `DISPLAY_KIND_CLASSIFICATION` must classify every job-scope kind (`server/src/prompt/displayKinds.ts:5`,
  `server/src/tests/transformService.test.ts:1080`); `REPORT_REMOVED_KEYS` decides what the settings report leaves out
  (`src/ts/storage/snapshots.svelte.ts:96`); `settingsKinds` (`server/src/tests/kinds.test.ts:13`), the collection
  count (`src/ts/storage/tests/presetSchema.test.ts:1086`), and the boot fixture
  (`src/ts/storage/tests/fixtures/boot/boot-snapshot.json:546`) list every collection.
- Correction, confirmed: Slice 1 names these files, gives both kinds `drop` and a place in `REPORT_REMOVED_KEYS`, says
  which paths need no entry, and lists the registries the kinds do not join (`BOOT_ITEM_KINDS`,
  `COLLECTION_SELECTION_FIELDS`, `ITEM_RECORD_FIELDS`, `allowedDbKeys`).

### A4 — Slices 2 and 3: existing tests and the Sortable contract were not named — fixed in plan

- Plan (Slice 3): "`data-risu-id` replaces `data-risu-idx`" and "`importUserPersona` returns the new persona's id (or
  null) for that"; the "Existing" lists named no test.
- Code: `PersonaSettings.test.ts` selects `button[data-risu-idx]` (`src/lib/Setting/Pages/PersonaSettings.test.ts:225`);
  `sortableOptions` filters `.no-sort` and guards a move over it (`src/ts/util.ts:850`); the page has two import
  buttons (`PersonaSettings.svelte:164`, `:257`); Sortable prevents the default of a filtered start unless
  `preventOnFilter` is false (`node_modules/sortablejs/modular/sortable.core.esm.js:1240`);
  `ModuleSettings.share.test.ts` mocks settings without a folder collection.
- Correction, confirmed: the slices name the tests; the non-draggable tiles carry `no-sort`; the page's Sortable sets
  `preventOnFilter: false` and is recreated on a view change; both import buttons file through the returned id; an
  imported persona stays unselected.

### A5 — Guides: four owners were missing — fixed in plan

- Plan: Slice 1 named four guides; Slices 2 and 3 named `characters-modules.md` only.
- Code: `docs/structure/ownership.json` gives `server/src/data/kinds.ts` and the normalizers to `server-resources`,
  `server/src/prompt/displayKinds.ts` to `server-generation`, `src/ts/gui/` to `ui-theming`, and
  `src/lib/Setting/Pages/personaGrid.ts` to `settings-i18n` (`:325`, `:392`, `:396`, `:448`, `:450`, `:455`).
- Correction, confirmed: the slice headers and Guide bullets name them.

### A6 — Slice 1: a test path in the first correction was wrong — fixed in plan

- Plan (after the first correction): "`src/ts/storage/snapshots.test.ts` (`LATER_REMOVED_KEYS`)".
- Code: the constant is in `src/ts/storage/tests/snapshots.test.ts:139`.
- Correction, confirmed: the path.

### A7 — Slice 1: backup and restore do not enumerate the collection maps — fixed in plan

- Plan (after the first correction): "the backup and restore paths enumerate the collection maps and need no entry".
- Code: a backup copies the database (`server/src/routes/backups.ts:333`) and a restore copies the staged resource
  rows (`server/src/data/resourceStore.ts:3245`).
- Correction, confirmed: "the native backup and restore carry resource rows whatever their kind".

## Noted, not recommended

- Two tabs that move one item into two different folders at once merge both memberships; the first-folder read rule
  decides which shows.
- A backup that holds these kinds is refused by an older server that does not register them
  (`server/src/data/resourceStore.ts:655`).
- An upstream-format input that names `moduleFolders` or `personaFolders` itself would be imported through the generic
  collection branch (`server/src/data/upstream/importDatabase.ts:283`); upstream's own databases have neither.
- The chat menu's "on / total" counts global and chat enablement, not the effective set, which character, persona, and
  namespace links also feed.
