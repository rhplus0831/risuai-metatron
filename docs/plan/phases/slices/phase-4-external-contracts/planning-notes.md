# Planning notes: Phase 4 (External Contracts)

## Provenance

Drafted 2026-09-30 on `metatron` at `577c43ae`, before the phase started, as a validation of
[`phase-4-external-contracts.md`](../../phase-4-external-contracts.md) against the tree after
Phases 0 to 2 and against the planned Phase 3 and Phase 5 slices (Phase 4 depends on Phase 3;
Phase 5 depends on Phase 4). Reviewed by GPT-6-Astra (11 points) and Claude Opus (13 points),
then refined; the decision on every point is in [`review-decisions.md`](review-decisions.md).
Every identifier below was verified against that commit (three Luna fan-outs and direct reads
of every cited line); line numbers drift, so grep the identifier before relying on one.

## Drift between the phase file and the tree

Each item names the evidence and the proposed phase-file edit. The plan owner applies the edits;
the closeout slice checks the CBS amendment (item 6) is in the file before the phase is declared
complete.

1. **The plugin getters are already snapshots.** The host `getDatabase` returns `$state.snapshot`
   per allowed key (`v3.svelte.ts:1059-1073`); `getChar` is `getCurrentCharacter({ snapshot: true })`
   (694-696); `getCharacterFromIndex` (1181-1189) and `getChatFromIndex` (1198-1209) snapshot.
   Edit: "`getDatabase`, `getChar`, and the indexed getters already return snapshots (Phase 2);
   keep them".
2. **`setChatToIndex` is already a mutation.** It captures a baseline and calls
   `applyChatResult` (1256-1273, Phase 2). `setChar`/`setCharacterToIndex` go through
   `applyPluginCharacter` → `setCharacterByIndex` + `reconcileCharacterChats` (716-743): the
   chat half is done, the character half is a mirror write plus `markCharacterDirtyAt`. Edit:
   name the character half only.
3. **"Instead of assigning `DBState.db`."** `setPluginDatabaseLite` ends with `DBState.db = db`
   where `db` is the live proxy (878, a self-assignment); `setPluginDatabase` runs the
   whole-database normalizer `setDatabase(db)` on the live proxy (903). Phase 3's notes already
   record that no accessor reinstall is needed there. The real work is the per-key routing (23
   keys crossing Phase 3's sections, forwarded preset keys, keep-on-switch fields, the derived
   `selectedPersona`, three collections, the Phase 1 kinds). Two defects on the same path:
   `applyPluginCharacters` reorders the mirror to the plugin's list (792; the order is
   transient), and `setDatabase({ plugins: [...existing, new] })` assigns only the newly
   confirmed plugins as the whole list (`plugins.svelte.ts:415-437`, `v3.svelte.ts:898`), so it
   uninstalls the rest. Edit: describe the routing table; say the normalizer call goes
   (Invariant 5), new characters are appended, and confirmed plugins are upserted.
4. **Plugin writers the phase file does not name:** `setArg`/`setArgument`
   (`plugin.realArg[...] =`, 807-815, 1173-1180); the theme setters `setColorScheme`,
   `changeTextTheme`, `setCustomTextTheme` (1102-1149, `ui` fields); the host export
   `changeColorScheme` (1078) writing through `colorscheme.ts:226-234`; the host export
   `checkCharOrder` (1560) writing `characterOrder` through `globalApi.svelte.ts:580-638`;
   `importPlugin` in `plugins.svelte.ts` (360-370); `SafeLocalPluginStorage`
   (`pluginSafeClass.ts:86-140`, five writes into `pluginCustomStorage`). Edit: add them to the
   plugin item ("`pluginStorage` and `getLocalPluginStorage()` writes; the host exports that
   write through helpers").
5. **MCP: three writers outside `risuaccess/`.** `mcp.ts:102-107` pushes into
   `DBState.db.authRefreshes`, `mcp.ts:231-251` pushes a module, `googlesearchclient.ts:78-83`
   assigns `googleSearchCredentials`. `getCharacter` in `utils.ts:4-5` returns the live object
   and every write handler mutates it through that alias (the two field writes carry
   `// @ts-ignore`, `characters.ts:592`, `modules.ts:463`); every handler mutates the record it
   resolved before awaiting consent (`modules.ts:546-551`); `CharacterHandler.handle` marks the
   character dirty after any `set|delete` dispatch, even a refused one (348-358); the module
   tools rely on the deep `modules` watcher; `chats.ts` is read-only. "The MCP RisuAccess tests"
   is one file (`risuaccess/tests/modules.test.ts`, eight read cases; no write handler is
   exercised). Edit: name the three extra writers; "the RisuAccess tests, extended with write
   cases".
6. **CBS item has no owner in Phase 4.** Phase 5's `cbs-and-regex-services` folds it in ("Phase 4
   leaves `cbs.ts` untouched") and both Phase 5 reviewers asked for one owner in sequence. The
   host `getDatabase` callback is fed the live `DBState.db` (`parser.svelte.ts:1107`);
   `setChatVar` goes through `setChatMeta` (`chatVar.svelte.ts:31-67`); the one direct write is
   `setGlobalChatVar`'s `DBState.db.globalChatVariables[key] = value` (117), a
   `globalChatVariables` collection field after Phase 3 (its watcher transports it). Edit (a
   scope amendment): replace the CBS item with "done by Phase 5's `cbs-and-regex-services` (the
   shared evaluator move); Phase 4 touches no CBS file".
7. **Lua: three of the five named setters are already routed** (Phase 2): `upsertLocalLoreBook`
   (`scriptings.ts:909-959`), `setChatVar` (139-152 → `setChatVarOf` → `setChatMeta`), the chat
   functions (246-393). The four character setters (770-866) write the selected character by
   index instead of the run's character: a wrong-target write (the selected character is watched
   and saved), which in a group send would address the group if they followed `contextRef`
   (`engineCharacter`, 127-132) while the script belongs to the speaking member
   (`index.svelte.ts:439-459`); `setDescription` type-checks `data` instead of `desc` (799). Edit:
   list the four setters, drop `upsertLocalLoreBook`, record the wrong-target write and the
   executing-member rule.
8. **Triggers: `v2SetVar` and `v2SetAuthorNote` are already mutations** (`setVar` 284-307 and
   `writeChatMeta` at 1801-1808, Phase 2); "`runTrigger` results are persisted with `replaceChat`"
   is `applyChatResult` at every caller (`index.svelte.ts:1082-1091`, `2088-2096`, `2200-2208`;
   `DefaultChatScreen.svelte:227-234`; `command.ts:252-260`; `Chat.svelte:446-464`), with
   `replaceChat` its reorder fallback. The unnamed writers are `v2SetCharacterDesc`,
   `v2SetReplaceGlobalNote`, and six lore effects (`v2ModifyLorebook`, `v2SetLorebookActivation`,
   `v2CreateLorebook`, `v2ModifyLorebookByIndex`, `v2DeleteLorebookByIndex`,
   `v2SetLorebookAlwaysActive`), each writing two targets: the _selected_ character's field by
   index through a live `getDatabase()` alias, then `setCurrentCharacter(clone)`, which replaces
   every own field of the _trigger's_ character with the copy taken at run start
   (`v2ModifyLorebook` passes the live selected record instead, so only the selected character
   gets the lore); in a group send the group record gets the field and the member gets the
   clone. `v2SetPersonaDesc` writes `DBState.db.personas[selectedPersona].personaPrompt` and the
   root copy (1106-1115), which Phase 3 rewrites to the forwarded field, as it rewrites
   `v2GetPersonaDesc`. Edit: name the eight effects and `v2SetPersonaDesc`; "`applyChatResult`";
   record the two-target write and the group case.
9. **Export and import: most of the item is done.** `exportChar` is snapshot-based (574-576),
   `SettingsExportButtons.svelte` is (37-41), `importChat` calls `createChat` (Phase 2,
   `characters.ts:439`); `exportAsDataset` reads the live `getDatabase()` but only reads (7-24).
   The card import pushes at `characterCards.ts:81`, `291`, `933` (through `let db = DBState.db`
   at 625) and stamps `db.statics.imports += 1` (89-90); `characterURLImport` pushes modules
   (379, 415, 471) and calls `importPreset`; `App.svelte:103` pushes a module; `importModule`
   pushes six ways (`modules.ts:289-358`); `importUserPersona` pushes (`persona.ts:126`);
   `importLoreBook("global")` writes and marks (`lorebook.svelte.ts:726-731`) while `"sglobal"`
   writes nothing (a core-app UI gap in `LoreBookSetting.svelte:192`, outside the safety
   contract); `importChat` writes `chatFolders` without a mark (502-504, on the selected
   character). Edit: name these sites; mark `exportChar` and `importChat` done.
10. **Safety contract: "A backup archive produced since Phase 1 still restores" is false after
    Phase 3.** Phase 3's `forwarding-personas` bumps `SCHEMA_VERSION` to 3 and refuses version-2
    files, snapshots, and archives; today's `readSnapshot` already requires the current version
    (`resourceStore.ts:681`). Edit: "an archive produced with the supported schema version (since
    Phase 3)".
11. **Exit criterion 1 is Phase 6's.** "No code path outside the mutation modules and the
    settings write adapter assigns into `DBState.db`" cannot hold while the UI binds to
    `DBState.db` (Invariant 3) and the core CRUD writes it: 206 direct writes in 27 files under
    `src/ts` outside the storage layer and 54 collection add/remove/reorder statements in 11
    `src/lib` files today, plus the `bind:` sites. Edit: scope it to the contract functions with
    the function-level audit of the closeout and an allowlist of the core-app writers left for
    Phase 6 (both `src/ts` and `src/lib`); the Objective's "outside the core app" already says so
    in substance.
12. **Invariant 2 statement.** The phase file does not say which collections switch to explicit
    mutations. The slices propose: `pluginStorage` switches (its deep watcher is deleted by the
    plugin host slice once every writer is routed; the writers are the plugin code, the
    browser-local import, and boot-time normalization); nothing else does; the adapter stays
    the transport for characters, sections, and collections until Phase 6. Edit: add the
    sentence.
13. **Docs list.** Invariant 7 requires `persistence.md`, `self-host-server.md`, and D1 to D4
    every phase; the phase file lists four guides. Also touched: `chat-pipeline.md` (the hook
    handoff), `global-api.md` (`checkCharOrder`'s new home), `plugins.md` (the author guide).
    Edit: add them.
14. **Phase 3 interplay the phase file predates.** After Phase 3 the plugin `allowedDbKeys`
    cross five owners (forwarded preset keys `temperature`, `maxContext`, `maxResponse`,
    `frequencyPenalty`, `PresensePenalty`, `moduleIntergration`; keep-on-switch `seperateModels`,
    `seperateModelsForAxModels`; `ui` fields; the collections `personas`, `characterOrder`,
    `enabledModules`; the derived `selectedPersona`), and `personas` needs ids at creation
    (Phase 3 puts an `ensureIds` pass into the plugin setters; the plugin host slice moves it into
    `setPersonas`). Under Phase 3's fallback the forwarded keys leave `DBState.db`, so the plugin
    `getDatabase` snapshot must read them through the module. Edit: say the per-collection
    application follows `shared/sections.ts` and both Phase 3 implementations.
15. **Captured-context plugin access is a Phase 4 boundary named by Phase 5** (`job-channel` and
    `post-generation-and-plugin-callbacks`). Today every selection-dependent host function reads
    `selectedCharID` (`v3.svelte.ts:699, 1223, 1275, 1279, 1283, 1689`), `parseRisuChat` calls
    the parser and `processScriptFull` without a ref (1240, 1252), `getCurrentLorebookEntries`
    calls `getModuleLorebooks()` without one (1291), `sendChat` sends the selected chat
    (`processSendChat(-1, {})`, 1698), `runLLMModel` passes no ref (1646-1668); the edit hooks
    receive only text (`scripts.ts:163-170`), replacers only text and the model
    (`request.ts:254-257, 306-309`), `chatOutput` listeners indices resolved by the send's
    `chatTarget` (`index.svelte.ts:79-100, 208-213`); each plugin has its own `SandboxHost` and
    API object (1799) and the RPC has no correlation between a hook and a child host call
    (`factory.ts:255-263, 540-593`). Edit: add the context item to the plugin work ("host
    functions resolve the character, chat, and preset from the hook's captured context, keyed by
    plugin; a gone target fails; else the tab's selection").
16. **`flushResources()` is not by itself a persistence acknowledgement.** A key discarded by a
    conflict counts as settled (`resourceSync.svelte.ts:129-132`, `acceptRemote` 823-847) and
    the flush's discard watermark starts after its own `tick()` (1088-1102), so a discard before
    the call is not reported. Phase 5's `job-channel` answers the job from that flush. Edit: the
    plugin item gains "a mutation scope that reports every discard since a callback began; a
    callback persists without discard or fails with the discarded keys".
17. **`DatabaseSubset` in `risuai.d.ts` (368-420) lacks `selectedPersona` and `characterOrder`**
    that `allowedDbKeys` has (pre-existing). Not a Phase 4 change: the phase file says the
    declared surface does not change. Recorded, not open.
18. **Atomicity.** A mutation touching two records is atomic per request, not per mutation:
    `planBatches` (563-635) splits by bytes and operation count and `isolateBatches` sends units
    separately. No phase-file text claims otherwise; the slices document it.

No conflict with the STRUCTURE.md or PLAN.md invariants was found. D5 is untouched (no shared
format changes); the plugin API shape is unchanged (`risuai.d.ts` untouched; the context is
ambient per plugin, not a parameter).

## Contingent boundaries on Phase 3

- **Spike verdict** (`spike-forwarding-layer`): with the accessor layer, `updateSettings` writes
  a forwarded key through `DBState.db[key]` and the accessor lands it in the selected preset by
  the id captured at the call, and `readSetting` reads the accessor; under the fallback both map
  to the `SelectedPreset` projection (Phase 3's slice 5 assigns that mapping to
  `setPluginDatabase`; slice 1 owns it now, so the plugin `getDatabase` snapshot and the routing
  table do not change). The trigger slice's `v2SetPersonaDesc` reads the persona id from
  `selection.personaId` or, under the fallback, `SelectedPersona`. No function signature changes
  either way.
- **Section taxonomy** (`shared/sections.ts`, `shared/presets.ts`): `updateSettings`'s accepted
  key set is `SECTION_FIELDS` (`providers`, `ui`, `memoryTranslateMedia`, `secrets`) plus
  `FORWARDED_PRESET_KEYS` and `PRESET_KEEP_ON_SWITCH_FIELDS`; if Phase 3 moves a key between
  sections nothing in Phase 4 changes; if it drops a key a plugin can set, that key would become
  a custom key.
- **`googleSearchCredentials` in `secrets` and `authRefreshes` as its own collection** (Phase
  3's notes reconciled the Phase 5 draft that wanted `authRefreshes` in `llmSecrets`): the MCP
  slice's `addAuthRefresh` and `updateSettings({ googleSearchCredentials })` target those; a
  different placement changes the function's target, not the slice.
- **`ensureIds` in the plugin setters** (Phase 3's `shared-schema-and-ids`): the plugin host
  slice replaces it with `setPersonas`; if Phase 3 lands first, the pass is moved, not
  duplicated.
- **Schema version 3** (`forwarding-personas`): the backup safety contract and the closeout's
  round trip assume it; if Phase 3 keeps version 2, the round trip covers archives since Phase 1.
- **Phase 3 open question 1** (one loop with per-section dirty keys or a timer per section):
  `updateSettings` relies on the section watchers either way.
- **Presets and translator/HypaV3 presets**: no Phase 4 contract creates them (`botPresets` is
  not in `allowedDbKeys`; MCP and Lua have no preset tools), so the id and credential lifecycle
  rules of Phase 3 need nothing from Phase 4; only personas are reachable
  (`setDatabase({ personas })` → `setPersonas` assigns ids).

## Open questions for the plan owner

1. `pluginStorage` as the one collection switching to explicit mutations in Phase 4 (its deep
   watcher deleted by the plugin host slice once every writer is routed): accept, or keep every
   watcher until Phase 6?
2. The plugin call context, narrowed: set it in the client hook runners now (so `chatOutput`,
   `edit*`, replacer, and provider hooks act on their own chat and preset before Phase 5), or
   only in Phase 5's serialized job callbacks, leaving the client runners on the tab's selection
   until cutover? The mechanism itself is a Phase 4 deliverable by Phase 5's decisions.
3. MCP `getCharacter` as a `DeepReadonly` view instead of a `$state.snapshot` (the snapshot
   copies every chat per tool call): accept?

Settled by existing documents and folded into the slices: the `DatabaseSubset` gap is left (the
declared surface does not change); the trigger target is Decision 5's frozen character (only the
recording is owed); the whole-database normalizer goes by Invariant 5;
`importLoreBook("sglobal")` is a core-app UI gap outside the safety contract;
`setDatabaseLite({ plugins })` keeps its semantics (no permission change); exit criterion 1's
wording is the Objective's "outside the core app" (the owner ratifies the wording).

## Proposed edits to other phases

The Phase 3 and Phase 5 drafters have been asked to apply these.

- **Phase 5 `job-channel.md`**: the settle rule ("Phase 4 made every plugin write a mutation
  ... `flushResources()`") becomes "`beginMutationScope()` before the callback,
  `flushResources({ scope })` after; a non-empty `discarded` list answers `outcome: "failed"`
  with those keys"; "Plugin APIs that resolve the selected character (`getChar`, `setChar`) act
  on the tab's selection, as today" becomes "the dispatcher hands the job's context (`chatRef`,
  `presetId`, `personaId`) to each callback through `plugin-call-context`'s per-plugin handoff".
- **Phase 5 `lua-bindings-and-buttons.md` and `trigger-runtime.md`**: the Assumptions gain "the
  setters address the executing character (the speaking member in a group), not the chat's
  owner"; `trigger-runtime` may re-target `v2SetPersonaDesc` to the frozen effective persona
  (the Phase 4 handoff: Phase 4 keeps the selected persona).
- **Phase 5 `post-generation-and-plugin-callbacks.md`**: "Phase 4 made the plugin whole-object
  setters diffs" → "chats are diffed (Phase 2); a plugin `setCharacter` replaces the character's
  own fields whole".
- **Phase 3 `shared-schema-and-ids.md`**: the `ensureIds` pass in the plugin setters is replaced
  by Phase 4's `setPersonas` (a note, no change in Phase 3's order).
- **Phase 3 `forwarding-presets-and-selection.md`**: "`setPluginDatabase` maps the forwarded keys
  of `allowedDbKeys` to the projection" (the fallback form) → "Phase 4's `updateSettings` and
  `readSetting` carry that mapping".

## Boundaries Phase 5 and Phase 6 depend on

- **Mutation modules** (slice 1): `src/ts/storage/characterStore.svelte.ts` (`findCharacter`,
  `addCharacter`, `updateCharacter`, `replaceCharacterFields`, `replaceCharacterAt`,
  `removeCharacter`), `collectionStore.svelte.ts` (`setPersonas`, `addPersona`, `updatePersona`,
  `setModules`, `addModule`, `updateModule`, `removeModule`, `setEnabledModules`,
  `setModuleEnabled`, `setCharacterOrder`, `setPlugins`, `upsertPlugin`, `setPluginArgument`,
  `addAuthRefresh`, `updateSettings(patch, { presetId? })`, `readSetting`),
  `pluginStorageStore.svelte.ts`, `characterOrder.ts` (`checkCharOrder`); synchronous, by id,
  input validated and cloned, a refusal throws `MutationValidationError` and changes nothing.
  Phase 5's Lua, trigger, and plugin ports map these signatures to `applyChanges` under the job
  token; the Phase 6 reviews confirm Phase 6 extends the three modules under their existing
  names and swaps only their transport (from the watchers to explicit record writes), keeping
  the signatures.
- **Persistence contract** (slice 1): `beginMutationScope()` + `flushResources({ scope })`;
  "persisted without discard, else fail with the discarded keys". Atomicity is per request.
  `flushResources` awaits `tick()` first, so writes that only the watchers track (sections,
  collections) are covered by the scope without explicit marks.
- **Adapter after Phase 4**: unchanged except `markPluginStorageDirty`, the mutation scope, the
  drift token, and no `pluginCustomStorage` watcher: `pluginStorage` is the only collection
  without a watcher, so every later writer calls the store module; `setCurrentCharacter` and
  `setCharacterByIndex` are wrappers for `characterFormatUpdate` and `applyModule` (Phase 6
  removes them with the live `getDatabase()`).
- **Plugin call context** (slice 3): `src/ts/plugins/apiV3/pluginContext.ts`; a per-plugin stack
  fed by a synchronous handoff at hook invocation, popped by identity; `{ chatRef, presetId,
personaId }`; a gone target throws `PluginTargetGoneError`; Phase 5's dispatcher uses the same
  handoff. Once chats are lazy (Phase 6), the context character is the one whose chats the
  plugin getters and setters (`getChar`, `setChar`, `getCurrentChatIndex`,
  `getCurrentLorebookEntries`, `sendChat`) must load first, and `setChar`'s chat reconciliation
  needs those chats resident between a plugin's `getChar` and its `setChar` (the Phase 6 reviews
  name both).
- **Executing-character rule** (slices 5 and 6): Lua setters and trigger effects address the
  run's character (`arg.char.chaId`, the speaking member in a group), never the chat's owner or
  the selection; chat operations keep the chat ref. Phase 5's `lua-bindings-and-buttons` and
  `trigger-runtime` inherit one rule; the effective persona under Decision 5 is Phase 5's
  handoff (Phase 4 keeps the selected persona).
- **Whole-object plugin setters**: a plugin `setCharacter` replaces the character's own fields
  whole (last writer wins); only chats are diffed (Phase 2). Phase 5's callback slice assumes
  the chat half.
- **Exit audit and the Phase 6 allowlist** (slice 8): the contract function sets, the rooted
  discovery grep, the type-level alias catch (`DeepReadonly` returns, no `@ts-ignore`), and the
  known escapes (the cast form `(db.characters[i] as character).x =`, helper aliases). The
  allowlist Phase 6 inherits, every entry needing an owning Phase 6 slice: under `src/ts`,
  `characters.ts` (`createNewCharacter` 36, `createNewGroup` 42, the image and emotion helpers
  160-222, 884, `restoreChar` 910, `removeChar` 944-950), `lorebook.svelte.ts` (`addLorebook` 31,
  `addLorebookFolder` 62), `process/modules.ts` (`applyModule` 538-562), `bootstrap.ts` (169),
  `process/index.svelte.ts` (357, 368-370, 220), `process/group.ts` (29-43), `persona.ts`
  (Phase 3's), `gui/colorscheme.ts` (272, 307), `setting/*.svelte.ts`, `stores.svelte.ts:174`,
  `process/request/google.ts:514-515`, `process/request/openAI/requests.ts:352`; under `src/lib`,
  54 add/remove/reorder statements in 11 files (`PlaygroundMenu.svelte:44`,
  `SideBars/CharConfig.svelte:1773`, `SideBars/Sidebar.svelte:153-198, 288-300`,
  `Setting/Pages/Module/ModuleSettings.svelte:88, 110-117, 170-178, 203, 240`,
  `Setting/Pages/PersonaSettings.svelte:50, 115-120, 196-197`, `Setting/botpreset.svelte:62,
290-291, 340-342`, `Setting/lorepreset.svelte:52-53, 76-78`,
  `Setting/Pages/PluginSettings.svelte:119-120`,
  `Setting/Pages/Advanced/CustomModelsSettings.svelte:67, 82, 93-94, 206-216`,
  `Setting/Pages/Language/TranslatorPresetSettings.svelte:53-54, 79, 103-104, 149-150`,
  `Setting/Pages/OtherBotSettings.svelte:1171-1172, 1196, 1219-1220, 1278-1279`) plus every
  two-way `bind:` onto `DBState.db`.
- **Behavior changes recorded for the phase file**: Lua and trigger character writes target the
  run's character (the member in a group); trigger character effects patch one field; inside a
  plugin hook the selection-dependent functions and settings writes mean the hook's chat and
  preset; `setPluginDatabase` without the whole-database normalizer; `setDatabase({ characters })`
  no longer reorders the mirror; `setDatabase({ plugins })` upserts; a malformed plugin value is
  refused; `pluginStorage` saved through explicit marks; `setDescription`'s type check fixed.

## Edits applied from other phases

- **From Phase 6** (its report, "Proposed edits to other phases"; verified against its refined
  slices `readers-settings-pages.md`, `readers-settings-consumers.md`, `readers-characters.md`,
  and `character-ownership.md`): `closeout.md`'s Phase 6 allowlist now names its Phase 6 owners
  by file (slice 4 `character-ownership` for `bootstrap.ts:169` and `stores.svelte.ts:174`;
  slice 5 `readers-settings-pages` for the settings-page collection pushes and reorders and the
  settings wrappers; slice 6 `readers-settings-consumers` for `persona.ts`,
  `colorscheme.ts:272, 307`, `index.svelte.ts:357`; slice 7 `readers-characters` for the
  character CRUD, helpers, sidebar reorders, `CharConfig.svelte`, `PlaygroundMenu.svelte:44`, and
  `ModuleSettings.svelte:87-90`), notes that `ModuleSettings.svelte:87-90` belongs to the
  character reader slice although the settings-page slice edits the same file, and that the
  registry's eight item-level `getValue`/`setValue` functions (`displaySettingsData.svelte.ts:417-454`,
  through `src/ts/setting/utils.ts:32` and `:50`) are part of the settings-page migration. The
  two request-layer writes in the allowlist (`google.ts:514-515`, `openAI/requests.ts:352`) are
  noted as leaving with Phase 5's request layer.
