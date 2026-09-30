# Slice: Closeout

Status: implemented (2026-10-01, on `6aa4bd48`; record below).

Phase: [Phase 4](../../phase-4-external-contracts.md), "Docs", the Safety Contract (the backup
round trip), and the Exit Criteria (the assignment audit, the test suites, the backup and
card-import checks); `PLAN.md` Invariant 7 (the docs and D1 to D4 in the same change) and
Invariant 2 (the statement of which collection switched).

Depends on: every other slice of the phase.

## Scope

Allowed files: `docs/structure/plugins-mcp.md`, `docs/structure/scripts-triggers.md`,
`docs/structure/backup-sync-hub.md`, `docs/structure/characters-modules.md`,
`docs/structure/persistence.md`, `docs/structure/chat-pipeline.md`,
`docs/structure/self-host-server.md`, `docs/structure/global-api.md` (`checkCharOrder`'s new
home), `STRUCTURE.md` (D1, D4), `plugins.md` (the author guide), `docs/plan/PLAN.md` (status
line), `docs/plan/phases/phase-4-external-contracts.md` (status, records, Implementation
Record), and these slice files. No source file: an exit-audit hit that no slice owns is
reported, not fixed here. Tests belong to the review step.

Identifiers (verified 2026-09-30 at `577c43ae`): the backup path `drive/backuplocal.ts` (server
routes only, `flushResources` first; `backuplocal.test.ts` twelve cases),
`server/src/tests/backups.test.ts` (914, 982: the snapshot and archive round trips);
`SCHEMA_VERSION` 3 after Phase 3 (`forwarding-personas`), version 2 refused at startup and in
`readSnapshot` (today `resourceStore.ts:681` already requires the current version). The
core-app writers left direct for Phase 6 (the allowlist; Luna fan-outs A, B, and C, verified):
under `src/ts`: `characters.ts` (`createNewCharacter` 36, `createNewGroup` 42, the image and
emotion helpers 160-222, 884, `restoreChar` 910, `removeChar` 944-950), `lorebook.svelte.ts`
(`addLorebook` 31, `addLorebookFolder` 62), `process/modules.ts` (`applyModule` 538-562 through
the `setCurrentCharacter` wrapper), `globalApi.svelte.ts` (`loadInternalBackup` and the boot
paths), `bootstrap.ts` (`checkNewFormat`, `assignIds`, the generation-end mark at 169),
`process/index.svelte.ts` (`statics.messages` 357, `lastInteraction` 368-370, `reloadKeys` 220),
`process/group.ts` (29-43), `persona.ts` (`selectUserImg`, `changeUserPersona`: Phase 3's),
`gui/colorscheme.ts` (the UI callers after the plugin slice routes `changeColorScheme`),
`setting/*.svelte.ts` (the settings wrappers), `stores.svelte.ts:174`,
`process/request/google.ts:514-515` (Phase 3's Vertex token), `process/request/openAI/requests.ts:352`;
under `src/lib` (54 statements in 11 files): `PlaygroundMenu.svelte:44`,
`SideBars/CharConfig.svelte:1773` and its editors, `SideBars/Sidebar.svelte:153-198, 288-300`,
`Setting/Pages/Module/ModuleSettings.svelte:88, 110-117, 170-178, 203, 240`,
`Setting/Pages/PersonaSettings.svelte:50, 115-120, 196-197`, `Setting/botpreset.svelte:62, 290-291, 340-342`,
`Setting/lorepreset.svelte:52-53, 76-78`, `Setting/Pages/PluginSettings.svelte:119-120`,
`Setting/Pages/Advanced/CustomModelsSettings.svelte:67, 82, 93-94, 206-216`,
`Setting/Pages/Language/TranslatorPresetSettings.svelte:53-54, 79, 103-104, 149-150`,
`Setting/Pages/OtherBotSettings.svelte:1171-1172, 1196, 1219-1220, 1278-1279`, plus every
two-way `bind:` onto `DBState.db` (396 across 26 files in the opening baseline). Phase 6 owners
of the allowlist (from Phase 6's refined slices, by file): its slice 4 `character-ownership`
takes `bootstrap.ts:169` and `stores.svelte.ts:174`; its slice 5 `readers-settings-pages` takes
`PersonaSettings.svelte`, `botpreset.svelte`, `lorepreset.svelte`, `PluginSettings.svelte`,
`CustomModelsSettings.svelte`, `TranslatorPresetSettings.svelte`, `OtherBotSettings.svelte`,
`ModuleSettings.svelte:110-117, 170-178, 203, 240`, and the settings wrappers
(`setting/*.svelte.ts`), where the registry's eight item-level `getValue`/`setValue` functions
(the four `customQuotesData` items, `displaySettingsData.svelte.ts:417-454`, called by
`getSettingValue` at `src/ts/setting/utils.ts:32` and `setSettingValue` at `:50`) are part of
the settings-page migration; its slice 6 `readers-settings-consumers` takes `persona.ts`,
`gui/colorscheme.ts:272, 307`, and `index.svelte.ts:357`; its slice 7 `readers-characters` takes
`characters.ts`, `lorebook.svelte.ts`, `process/modules.ts` (`applyModule`), `process/group.ts`,
`globalApi.svelte.ts`, `index.svelte.ts:220, 368-370`, `Sidebar.svelte`, `CharConfig.svelte`,
`PlaygroundMenu.svelte:44`, and the character creation at `ModuleSettings.svelte:87-90` (the
character reader slice, not the settings-page slice, although both edit that file); the two
request-layer writes (`google.ts:514-515`, `openAI/requests.ts:352`) leave with Phase 5's
`request-layer-and-llm-secrets`, or fall to Phase 6's slice 6 if any client read of them
survives Phase 5.

Stopping condition: an exit-audit hit in a contract function that no slice owns, or a backup
round trip that fails on a version-3 store (reported to the owner; not fixed here).

## Assumptions

- Every other slice landed and its own discovery grep answers as it states.
- After Phase 3 the resource database is version 3 and the server refuses version-2 files,
  snapshots, and archives; an archive from before Phase 3 does not restore (no migration owed).
  The phase file's "A backup archive produced since Phase 1 still restores" is false as written
  (drift); the edit is "an archive produced with the supported schema version (since Phase 3)".
- The phase-file amendment moving the CBS item to Phase 5's `cbs-and-regex-services` has been
  applied by the plan owner (the report proposes it); this slice checks it is in the file
  before declaring the phase complete.

## Proposed decisions

- Exit criterion 1, the grep-able form (proposed; the phase file's wording is Phase 6's and
  cannot hold while the UI binds to `DBState.db`, Invariant 3): the audit is function-level,
  not file-level. For each contract function set (the plugin host file and its helpers, the
  plugin context, `risuaccess/*`, `mcp.ts`'s two writers, `googlesearchclient.ts`, the four Lua
  setters and getters, the eight trigger effects and `v2SetPersonaDesc`, the eight import
  functions, `exportAsDataset`), the rooted discovery grep
  `rg -n --pcre2 '\b(db|DBState\.db)(\.[\w$]+|\[[^\]]+\])+\s*(=(?!=)|\+=|-=|\?\?=|\|\|=)|\b(db|DBState\.db)(\.[\w$]+|\[[^\]]+\])+\.(push|splice|unshift)\(|\bdelete (db|DBState\.db)\.'`
  over the file answers only the residual hits each slice lists by identifier (the core-app
  functions kept in the same files), and `rg -n 'getDatabase\(\)'` answers only the reads each
  slice lists; every hit is classified in the phase file. Grep is discovery: aliases through
  `getCharacter()`, `getCurrentCharacter()`, and helpers are caught at the type level
  (`findCharacter` and `getCharacter` return `DeepReadonly`, the two `@ts-ignore` lines are
  gone, `pnpm check` lists a mutation of a read-only value), by the host-function callee audit
  of the plugin slice, and by the review-step tests over the real store. The core-app writers
  above are recorded in the phase file as the allowlist Phase 6 inherits (both `src/ts` and
  `src/lib`).
- Backup round trip (proposed): the server tests already cover snapshot and archive round
  trips with chats; the phase check is manual on a fresh version-3 server: export, change a
  character through a plugin `setCharacter` and an MCP tool, import the archive, restore a
  snapshot; recorded in the phase file. A pre-Phase 3 archive is refused with the message; the
  safety contract is edited accordingly. No Docker smoke: the phase changes no server code,
  image, or route.
- Docs (proposed; every guide edit of the phase lives here so the parallel slices never touch
  one guide twice): `plugins-mcp.md` (`State`: the routing table, the storage module, the
  per-plugin call context; `Invariants`: new setters go through the modules; `Known Hazards`:
  the `markCharactersDirty` line goes, the `setDatabaseLite({ plugins })` confirmation gap and
  the same-plugin overlap are listed), `scripts-triggers.md` (`Flows`: the Lua and trigger
  character targets, the speaking member in a group; `Invariants`: "the caller must persist the
  returned chat" stays), `backup-sync-hub.md` (`Invariants`: archives from before Phase 3),
  `characters-modules.md` (`Invariants`: a character enters the mirror through `addCharacter`
  on the import paths; the core-app creators until Phase 6), `persistence.md` (`Files`: the
  three modules and `characterOrder.ts`; Save step 1: the callers of `markCharactersDirty`
  shrink to the modules, the send stamp, and the core helpers; `Invariants`: the mutation rule
  per collection, `pluginStorage` has no watcher, the mutation scope; `Tests`),
  `chat-pipeline.md` (the hook handoff in `runChatOutputListeners`), `global-api.md`
  (`checkCharOrder` re-exported from the storage layer), `self-host-server.md` (Phase 4 changed
  no route, kind, or table), `STRUCTURE.md` D1 (the character and collection modules beside the
  chat module) and D4 (`pluginStorage` written only through its module; `markCharactersDirty`
  wording), `plugins.md` ("Character Operations" and "Database Access": which character and
  preset the functions mean inside a hook; `setDatabase({ characters })` appends new characters
  and does not reorder), `PLAN.md` status, and the phase file's Implementation Record in the
  format of Phases 1 and 2 with the recorded behavior changes from every slice (the Lua and
  trigger target character and the group member; the single-field trigger patch; the per-plugin
  hook context; `setPluginDatabase` without the whole-database normalizer; `setDatabase({ characters })`
  no longer reordering; `setDatabase({ plugins })` upserting instead of replacing; a malformed
  plugin value refused instead of normalized; the `pluginStorage` watcher deletion;
  `setDescription`'s type check fixed) and the Invariant 2 statement (only `pluginStorage`
  switched; the adapter stays the transport for the rest until Phase 6).

## Validation

`pnpm check`, `pnpm test` (the plugin suites, `risuaccess/tests/*`, `scriptings.test.ts`,
`command.test.ts`, `characters.test.ts`, `characterCards.test.ts`, `backuplocal.test.ts`,
`server/src/tests/backups.test.ts`), `pnpm format:check`, `pnpm build`; the discovery greps
above with every hit classified and pasted into the phase file; the manual backup round trip;
the manual import checks listed in `imports-through-the-module`; the manual checks of the
plugin, context, MCP, Lua, and trigger slices re-run on the final tree. No review-step test of
its own beyond the classification.

## Residual risk

The allowlist is a snapshot of `577c43ae`; Phase 6 re-derives it. Lazy loading waits for Phase 6. The phase-file CBS amendment is the owner's; if it is not applied, the phase file still
names work that no Phase 4 slice does.

## Implementation record

Implemented 2026-10-01 on `6aa4bd48`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 8, A25). Docs and the review-step tests
below; no source file.

- **Audit.** The command, the exclusions, the classification of all 309 hits by function and
  owner, the `getDatabase()` reads, the alias classes, and the proposed edits for the three
  unowned hits are in the phase file's Implementation Record. The three unowned hits are
  `NanoGPTDashboard`, `PromptDiffModal`, and `promptConvertion`. The contract functions answer
  nothing.
- **Backup round trip** (`checkP4Backup.mjs`): export, a change through an MCP tool and a plugin
  `setCharacter`, then an archive import (the change is gone) and a restore of the import's safety
  snapshot (the change is back), on a version-3 store.
- **Built-client check** (`checkP4Built.mjs`): the built `dist` served by the self-host server:
  open, send, reload.
- **Manual checks of slices 2 to 7**, re-run on the final tree: the same results. The slice 6
  script failed once in the sequential batch, with its message cut off in the log, and passed on
  three later runs.
- **Docs:**
  - the guides: `plugins-mcp.md`, `scripts-triggers.md`, `backup-sync-hub.md`,
    `characters-modules.md`, `persistence.md`, `chat-pipeline.md`, `global-api.md`, and
    `self-host-server.md`;
  - `STRUCTURE.md` D1 and D4, and `plugins.md` ("Database Access" and "Character Operations");
  - the `PLAN.md` status;
  - the phase file: its status and its Implementation Record, with the recorded behavior changes of
    every slice and the Invariant 2 statement.
- **The CBS amendment** is in the phase file: CBS is done by Phase 5's `cbs-and-regex-services`,
  and Phase 4 touched no CBS file.

Checks on the final tree: see the phase file's Implementation Record, "Checks".

### Astra challenge

Astra (the open plan-review session) challenged the closeout. Report:
`astra-p4-slice8-challenge.md` (scratchpad). It found no missed write in the contract functions.
All eight points were adopted:

1. **Medium: the classification was grouped loosely, not per hit.** **Adopted:** the audit ledger
   below lists every hit once, by category, file, and enclosing function, and the categories' counts
   add up to 309.
2. **Medium: the alias inventory was incomplete.** **Adopted:** the phase file's alias table names
   `persona`, `group`, `currentChar`, `nowChatroom`, `character`, `current`/`char`/`dbChar`, and
   `db2`.
3. **Medium: the hook docs promised a context where none is passed.** Body interceptors, TTS
   hooks, memory summarization, and image generation run their hooks without one, and a plugin's
   own timers can see a context ambiently while one of its hooks runs. **Adopted:** `plugins.md`
   and `plugins-mcp.md` say so.
4. **Medium: two lists named functions that do not mark characters dirty.** **Adopted:**
   `persistence.md` names only the marking functions, and notes that `addCharacter`,
   `removeCharacter`, and the emotion helpers do not mark.
5. **Medium: no test showed that `parseRisuChat`, `runLLMModel`, and `getCurrentLorebookEntries`
   use the hook's target.** The suite covered only their gone-target rejections. **Adopted as
   testing advice:** passed to the Fable review, which agreed and wrote the tests below.
6. **Low: the behavior record left out changes and stated the Lua change too broadly.**
   **Adopted:** the record is scoped to the four Lua pairs and adds the nesting limit, the new
   warnings, the render-key repair, and the late keys.
7. **Low: "only writer" of plugin storage needed its boot exception.** **Adopted:** `STRUCTURE.md`
   and `persistence.md` name the boot assignment and the `_coldplugin` delete.
8. **Low: the final check results were not in the repository.** **Adopted:** the phase file's
   "Checks".

### Tests

Written by the Fable review (verdict: no problem; every adopted doc correction checked against the
code, and the ledger checked by program against the grep output).

- **`src/ts/plugins/apiV3/pluginContext.test.ts` (+3)**, "the host functions that forward the
  hook's target". The observer in each is a second plugin instance, because the calling plugin's
  own hooks would see the context ambiently even if the forward were lost. The selection moves
  away from the hook's character, chat, and preset first.
  - `parseRisuChat` hands the parser the hook's character and `chatRef`. With `processRegex`, the
    other plugin's handler sees the hook's chat and preset. Outside a hook the parser gets the
    selection and no `chatRef`.
  - `runLLMModel` hands `requestChatDataMain` the hook's `chatRef` and context, and the other
    plugin's provider sees the hook's chat and preset. The default call is blocked before the
    provider runs. Outside a hook neither key is passed.
  - `getCurrentLorebookEntries` returns the hook's global, chat-local, and module lore (from
    distinct fixtures), and the selection's outside a hook.

`pnpm test`: 98 files, 1013 passed, 3 skipped. `pnpm check` and `pnpm format:check` pass.

## Audit ledger

All 309 hits of the published command, each listed once, by category, file, and enclosing function. A Svelte template handler is named by its event attribute, and `script level` is component script code outside a function. Line numbers are at `6aa4bd48`.

**Settings pages: settings, presets, collections, and selection** (171):

- `src/lib/Setting/botpreset.svelte` (Phase 6 readers-settings-pages): `movePreset` 57; `onclick handler` 348
- `src/lib/Setting/Pages/OpenrouterSettings.svelte` (Phase 6 readers-settings-pages): `onclick handler` 51, 59, 82, 90, 113, 121
- `src/lib/Setting/Pages/PersonaSettings.svelte` (Phase 6 readers-settings-pages): `onEnd` 33; `onclick handler` 97
- `src/lib/Setting/lorepreset.svelte` (Phase 6 readers-settings-pages): `onclick handler` 27, 50, 53, 78
- `src/lib/Setting/Pages/OobaSettings.svelte` (Phase 6 readers-settings-pages): `script level` 139, 141; `onclick handler` 154, 169
- `src/ts/setting/displaySettingsData.svelte.ts` (Phase 6 readers-settings-pages): `module level` 419, 420, 431, 432, 443, 444, 455, 456
- `src/lib/Setting/Pages/BotSettings.svelte` (Phase 6 readers-settings-pages): `$effect` 60, 61, 73, 85, 86, 87, 88, 89, 113, 133, 134; `clearVertexToken` 118, 119; `onchange handler` 233, 308, 383; `oninput handler` 351, 405, 406, 459; `onselect handler` 364, 365, 475, 669, 671; `onclick handler` 684, 699, 858, 882, 904, 921, 945, 965, 976, 978, 1028, 1030
- `src/lib/Setting/Pages/GlobalRegex.svelte` (Phase 6 readers-settings-pages): `onclick handler` 24
- `src/lib/Setting/Pages/OtherBotSettings.svelte` (Phase 6 readers-settings-pages): `handleModelChange` 180, 181, 182, 187; `$effect` 217; `onclick handler` 425, 430, 434, 436, 438, 440, 449, 461, 486, 487, 572, 574, 604, 605, 651, 653, 682, 683, 975, 978, 1008, 1009, 1177, 1178, 1230, 1288, 1289; `onchange handler` 516, 1084, 1085, 1086, 1087, 1088, 1090, 1091, 1092, 1093, 1094, 1096, 1097, 1098, 1099, 1100, 1102, 1103, 1104, 1105, 1106, 1108, 1109, 1110, 1111, 1112, 1163
- `src/lib/Setting/Pages/PluginSettings.svelte` (Phase 6 readers-settings-pages): `onclick handler` 97, 116, 120, 173, 191, 205
- `src/ts/setting/languageSettingsData.svelte.ts` (Phase 6 readers-settings-pages): `langState` 64
- `src/lib/Setting/Pages/Advanced/BanCharacterSetSettings.svelte` (Phase 6 readers-settings-pages): `onclick handler` 56, 58
- `src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte` (Phase 6 readers-settings-pages): `onclick handler` 28, 30, 67, 82, 94, 206; `onchange handler` 116, 141
- `src/lib/Setting/Pages/PromptSettings.svelte` (Phase 6 readers-settings-pages): `handlePromptDrop` 106; `onclick handler` 189, 214, 236, 265, 348, 356
- `src/lib/Setting/Pages/Display/NotificationToggle.svelte` (Phase 6 readers-settings-pages): `script level` 26
- `src/lib/Setting/Pages/Display/NullableTextColorToggle.svelte` (Phase 6 readers-settings-pages): `script level` 21; `oninput handler` 31, 41
- `src/lib/Setting/Pages/Module/ModuleSettings.svelte` (Phase 6 readers-settings-pages): `onclick handler` 110, 115, 117, 170, 174, 177, 178, 203, 240, 251
- `src/lib/Setting/Pages/Display/CustomBackgroundToggle.svelte` (Phase 6 readers-settings-pages): `script level` 14, 17, 21, 23
- `src/lib/Setting/Pages/Language/TranslatorPresetSettings.svelte` (Phase 6 readers-settings-pages): `script level` 31; `onclick handler` 45, 46, 96, 139, 140

**Settings writes outside the settings pages** (59):

- `src/lib/UI/PromptDataItem.svelte` (Phase 6 readers-settings-consumers): `replacePrompt` 120, 125
- `src/lib/Others/CustomSidebarConfig.svelte` (Phase 6 readers-settings-consumers): `onclick handler` 35, 66, 80, 94, 138
- `src/lib/Others/IrisModal.svelte` (Phase 6 readers-settings-consumers): `saveDialogue` 173
- `src/lib/Others/WelcomeRisu.svelte` (Phase 6 readers-settings-consumers): `script level` 25; `send` 35, 58, 61, 64; `$effect` 77, 82, 83, 87, 88, 92, 93, 97, 98, 104, 105, 109, 110, 114, 115, 116, 119, 120, 125, 129, 133, 137, 141, 145, 151, 152, 153, 156; `onclick handler` 187, 195, 203, 211, 219, 227
- `src/lib/Others/ProTools/EasyPanel.svelte` (Phase 6 readers-settings-consumers): `onclick handler` 71, 72, 73, 79, 80, 121, 122
- `src/ts/gui/colorscheme.ts` (Phase 6 readers-settings-consumers): `changeColorSchemeType` 259; `importColorScheme` 294
- `src/lib/ChatScreens/DefaultChatScreen.svelte` (Phase 6 readers-settings-consumers): `onclick handler` 1169, 1211
- `src/ts/process/index.svelte.ts` (Phase 6 readers-settings-consumers): `sendChatInner` 370

**Core-app character and collection writers** (61):

- `src/lib/Playground/PlaygroundMenu.svelte` (Phase 6 readers-characters): `playgroundChat` 34, 44
- `src/ts/stores.svelte.ts` (Phase 6 character-ownership): `selectedCharID.subscribe` callback (in `$effect.root`) 175
- `src/ts/characters.ts` (Phase 6 readers-characters): `createNewCharacter` 37; `createNewGroup` 43; `dumpCharImage` 182; `changeCharImage` 192; `addCharEmotion` 213; `rmCharEmotion` 223; `makeGroupImage` 888; `restoreChar` 914; `removeChar` 954
- `src/lib/ChatScreens/Chat.svelte` (Phase 6 readers-characters): `onclick handler` 1197, 1198
- `src/lib/Setting/Pages/Module/ModuleChatMenu.svelte` (Phase 6 readers-characters): `oncontextmenu handler` 114, 117, 122
- `src/lib/Setting/Pages/Module/ModuleSettings.svelte` (Phase 6 readers-characters): `onclick handler` 88
- `src/lib/ChatScreens/DefaultChatScreen.svelte` (Phase 6 readers-characters): `onclick handler` 1025
- `src/lib/SideBars/LoreBook/LoreBookSetting.svelte` (Phase 6 readers-characters): `onclick handler` 110, 146
- `src/lib/SideBars/LoreBook/LoreBookList.svelte` (Phase 6 readers-characters): `onEnd` 294, 296; `onClose` 466
- `src/ts/process/lorebook.svelte.ts` (Phase 6 readers-characters): `addLorebook` 31; `addLorebookFolder` 62
- `src/lib/SideBars/Sidebar.svelte` (Phase 6 readers-characters): `inserter` 151, 153, 155, 175, 186, 194, 198; `createFolder` 283, 286, 288, 294, 296, 300; `oncontextmenu handler` 624, 644, 676
- `src/lib/SideBars/CharConfig.svelte` (Phase 6 readers-characters): `moveAlternateGreetingUp` 289; `moveAlternateGreetingDown` 300; `onclick handler` 553, 764, 843, 853, 858, 911, 925, 931, 936, 986, 1269, 1309, 1535, 1646, 1694, 1773; `onchange handler` 657

**Boot paths** (10):

- `src/ts/bootstrap.ts` (Phase 6 character-ownership, settings-ownership, aggregate-removal): `assembleDatabase` 154, 168, 171, 175, 179, 182; `checkNewFormat` 277, 307, 361, 369

**Phase 5 residuals** (1):

- `src/ts/parser/chatVar.svelte.ts` (Phase 5 cbs-and-regex-services): `setGlobalChatVar` 117

**No owner yet (proposed edits)** (4):

- `src/lib/UI/NanoGPTDashboard.svelte` (proposed: readers-settings-consumers): `fetchDashboard` 26
- `src/lib/Others/PromptDiffModal.svelte` (proposed: readers-settings-consumers): `savePrefsToDB` 170
- `src/ts/process/prompt.ts` (proposed: readers-characters or readers-settings-consumers): `promptConvertion` 357, 438

**False positives** (3):

- `src/lib/Setting/Pages/PersonaSettings.svelte` (a type annotation): `onEnd` 29
- `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte` (a snapshot copy): `onclick handler` 92
- `src/ts/process/request/openAI/requests.ts` (a type position): `requestOpenAI` 459
