# Slice: Closeout

Status: planned (drafted 2026-09-30, refined after review, not started).

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
