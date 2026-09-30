# Phase 4: External Contracts

Status: implemented on 2026-10-01 in eight slices; see Implementation Record. Plan:
[`slices/phase-4-external-contracts/implementation-plan.md`](slices/phase-4-external-contracts/implementation-plan.md).

Depends on: Phases 2 and 3.

## Objective

Re-point everything outside the core app that writes the database at explicit client mutations
and the server resources: the plugin API v3 host, the MCP RisuAccess tools and the other MCP
writers, the Lua and trigger APIs, and the import paths. The API shapes stay the same. The
settings-UI import handlers (translator, HypaV3, theme, regex, and the preset buttons) are core
app and belong to Phase 6.

## Required Work

- **Mutation modules.** Client functions that validate and detach their input, write the mirror
  by id, and mark a record the adapter's watchers would miss:
  - characters (`characterStore.svelte.ts`);
  - the settings sections and collections, and presets (`collectionStore.svelte.ts`);
  - plugin storage (`pluginStorageStore.svelte.ts`);
  - `checkCharOrder` (`characterOrder.ts`).

  A mutation scope (`beginMutationScope()` with `flushResources({ scope })`) reports every
  discard since a callback began, so a callback's writes either persist without a discard or the
  callback fails with the discarded keys.

- **Plugin API v3** (`src/ts/plugins/apiV3/v3.svelte.ts`, `plugins.svelte.ts`,
  `pluginSafeClass.ts`, `src/ts/gui/colorscheme.ts`).
  - `setPluginDatabase` and `setPluginDatabaseLite` route each `allowedDbKeys` key to its owning
    mutation; the whole-database normalizer call goes. New characters are appended, and confirmed
    plugins are upserted.
  - `setChar` and `setCharacterToIndex` go through the character module. The chat half is
    already done: `setChatToIndex` calls `applyChatResult` (Phase 2).
  - The v3 `pluginStorage` functions and `SafeLocalPluginStorage` write through the plugin
    storage module.
  - The host exports that write through helpers go through the modules: the argument setters,
    the color and text theme setters, `changeColorScheme`, `checkCharOrder`, and `importPlugin`.
  - `getDatabase`, `getChar`, and the indexed getters already return snapshots; they stay.
  - The declared surface in `risuai.d.ts` does not change.
- **Plugin call context.** Inside a hook (a `chatOutput` listener, a script handler, a replacer,
  a provider), the host functions resolve the character, chat, and preset from a context the hook
  runner captured, keyed by plugin. A target that is gone fails; outside a hook the tab's
  selection applies.
- **MCP.**
  - The RisuAccess set and delete tools (`src/ts/process/mcp/risuaccess/characters.ts`,
    `modules.ts`) write by id through the modules and re-resolve after consent.
  - `getCharacter` in `utils.ts`, and a new `findModule`, return read-only views; the read tools
    are unchanged.
  - The writers outside `risuaccess/` go through the modules as well: `registerRefresh` and
    `importMCPModule` in `mcp.ts`, and the credential prompt in `googlesearchclient.ts`.
- **Lua and triggers** (`src/ts/process/scriptings.ts`, `src/ts/process/triggers.ts`).
  - The four Lua character setters (`setName`, `setDescription`, `setCharacterFirstMessage`,
    `setBackgroundEmbedding`) and their getters address the run's character (the speaking member
    in a group) through the character module.
  - The eight trigger character effects (`v2SetCharacterDesc`, `v2SetReplaceGlobalNote`, and the
    six lorebook effects) patch the trigger's character. `v2SetPersonaDesc` updates the selected
    persona.
  - Already mutations (Phase 2): `upsertLocalLoreBook`, the Lua chat functions, `v2SetVar`, and
    `v2SetAuthorNote`. `runTrigger` results are persisted with `applyChatResult` at every caller.
  - Which of these later run on the server is Phase 5's concern.
- **CBS.** Done by Phase 5's `cbs-and-regex-services` (the shared evaluator move); Phase 4 touches
  no CBS file.
- **Export and import.**
  - The card import in `src/ts/characterCards.ts`, the module imports (`importModule`,
    `characterURLImport`, the drop handler in `App.svelte`), `importUserPersona`, the global
    `importLoreBook`, `importPreset`, and `importChat` (its folders and its target) create
    records through the modules.
  - `exportAsDataset` reads a snapshot.
  - Already snapshot-based: `exportChar` and `SettingsExportButtons.svelte`. Already done
    (Phase 2): `importChat`'s chats.
- **Docs.** `docs/structure/plugins-mcp.md`, `scripts-triggers.md`, `backup-sync-hub.md`,
  `characters-modules.md`, `persistence.md`, `chat-pipeline.md`, `self-host-server.md`,
  `global-api.md`; `STRUCTURE.md` D1 and D4; `plugins.md`.

Invariant 2 in this phase: `pluginStorage` is the one collection that switches to explicit
mutations; its watcher is deleted once every writer is routed. The save adapter stays the
transport for characters, sections, and the other collections until Phase 6.

## Safety Contract

No plugin-visible API changes shape or permission semantics. Every write that reached `DBState.db`
from these contracts now reaches a resource; none is dropped. An archive produced with the
supported schema version (since Phase 3) still restores.

## Exit Criteria

- **Function-level audit.** The contract functions assign nothing into `DBState.db` outside the
  mutation modules: the rooted discovery grep, published with its exclusions, answers only the
  residual hits each slice lists by identifier, and every hit is classified in this file. The
  core-app writers are recorded as the allowlist Phase 6 inherits (and Phase 5, for the CBS and
  request-layer writes). Settings bindings keep the section watchers until Phase 6.
- The plugin tests (`src/ts/plugins/**/*.test.ts`) and the MCP RisuAccess tests, extended with
  write cases, pass against the mutation API.
- A backup round trip and a card import work against server resources.

## Validation

Plugin and MCP test suites, a backup round-trip check recorded in this file, and `pnpm check`,
`pnpm test`, `pnpm format:check`, `pnpm build`.

## Implementation Record

Implemented on 2026-09-30 and 2026-10-01 from a plan reviewed by GPT-6-Astra (A1 to A27) and
evaluated by Claude Fable (F-a to F-i), in eight slices with three user stops. Each of slices 1 to
7 was challenged by Astra and reviewed by Fable: a Fable test-adapter adapted the tests a slice
deliberately invalidated, and the Fable reviewer wrote the review-step tests. The plan, slices,
and per-slice records (decisions, challenge points and decisions, checks, tests) are in
[`slices/phase-4-external-contracts/`](slices/phase-4-external-contracts/)
(`implementation-plan.md` first). One commit per slice.

- **Mutation modules** (slice 1, `8526502b`). `characterStore.svelte.ts`,
  `collectionStore.svelte.ts`, `pluginStorageStore.svelte.ts`, and `mutationValidation.ts` (see
  `docs/structure/persistence.md`). Each validates and detaches its whole input before the mirror
  changes, and writes by id. `checkCharOrder` moved to `characterOrder.ts`. There is a mutation
  scope (`beginMutationScope`, `flushResources({ scope })`), and `updateSettings` takes an
  explicit preset.
- **Plugin host setters** (slice 2, `4237e85c`). `setDatabase`/`setDatabaseLite` route each key to
  its mutation; the whole-database normalizer call is gone. The argument, theme, and
  `pluginStorage` functions, `SafeLocalPluginStorage`, `importPlugin`, and `changeColorScheme` go
  through the modules. The `pluginCustomStorage` watcher is deleted.
- **Plugin call context** (slice 3, `0d7c1cd6`). The hook runners (the send, `processScriptFull`,
  `requestChatData`, `requestPlugin`) capture the context before their first await and hand it to
  each hook. The host functions inside a hook act on its character, chat, and preset, and throw
  `PluginTargetGoneError` when one is gone. An unloaded plugin's replacers and script handlers are
  removed, and its pending callbacks reject.
- **MCP** (slice 4, `ff74cf2e`). The RisuAccess write tools re-resolve by the captured id after
  consent and write synchronously through `updateCharacter`/`updateModule`. `getCharacter` and
  `findModule` return read-only views, and the three `@ts-ignore` lines are gone. `importMCPModule`,
  `registerRefresh`, and the Google credential prompt go through the modules.
- **Lua** (slice 5, `5b177560`). The four character setters and their getters address the run's
  character, by the id captured at entry, through `updateCharacter`.
- **Triggers** (slice 6, `5ad9f749`). The eight character effects write one field of the trigger's
  character; `v2SetPersonaDesc` writes the selected persona through `updatePersona`; display and
  request runs make no mutation call.
- **Imports** (slice 7, `6aa4bd48`). Cards through `addCharacter`, modules, personas, and presets
  through the collection module, the global lore import and `importChat`'s folders by the id
  captured before the dialog; `exportAsDataset` reads a snapshot.
- **Closeout** (slice 8). The docs, the audit below, the backup round trip, and the built-client
  check.

Invariant 2 in this phase: `pluginStorage` is the one collection that switched to explicit
mutations (its watcher is gone). The save adapter stays the transport for characters, the
sections, and the other collections until Phase 6: the modules write the mirror, and the
watchers (or the character mark) carry the write.

### Function-level audit (exit criterion 1)

Command, on the final tree, with storage and test files excluded:

```
rg -n --pcre2 '\b(db|DBState\.db)(\.[\w$]+|\[[^\]]+\])+\s*(=(?!=)|\+=|-=|\?\?=|\|\|=)|\b(db|DBState\.db)(\.[\w$]+|\[[^\]]+\])+\.(push|splice|unshift)\(|\bdelete (db|DBState\.db)\.' src --glob '!src/ts/storage/**' --glob '!**/*.test.ts' --glob '!**/tests/**'
```

It answers 309 hits in 44 files, down from 377 in 56 files at `e9e608ad`: 38 in 11 `src/ts`
files and 271 in 33 `src/lib` files.

**Contract functions: none.** The pattern over `src/ts/plugins`, `src/ts/process/mcp`,
`scriptings.ts`, `triggers.ts`, `characterCards.ts`, `persona.ts`, `process/modules.ts`, and
`exportAsDataset.ts` answers nothing. The hits left in `characters.ts`, `lorebook.svelte.ts`,
`database.svelte.ts`, and `App.svelte` are outside the named import functions and `importPreset`.

`getDatabase()` in the contract files answers only reads:

- `triggers.ts`: `templateDefaultVariables`, `v2GetPersonaDesc`;
- `scriptings.ts`: `engineCharacter`, `getCharacterImageMain`, `getLoreBooksMain`,
  `loadLoreBooksMain`, and both `getCharacterLastMessage` declarations;
- `v3.svelte.ts`: `getArg`, `getArgument`;
- `plugins.svelte.ts`: `importPlugin`, `loadPlugins`.

**Alias writes: none left in the contract functions.** In the contract functions, the aliases left
are reads, detached copies, or arguments handed to a mutation:

- `getCharacter` and `findModule` return `DeepReadonly`, and the `@ts-ignore` lines are gone, so
  `pnpm check` lists any mutation through them;
- the Lua and trigger working copies are written back only through `updateCharacter`;
- the plugin setters hand their input to the modules, which detach it.

The grep cannot see local aliases. These are the core-app ones, by binding, function, written
fields, and owner:

| Binding                     | Function                                                                              | Writes                                            | Owner                                   |
| --------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| `persona`                   | `persona.ts` `selectUserImg`                                                          | `icon`                                            | Phase 6 `readers-settings-consumers`    |
| `group`                     | `process/group.ts` `addGroupChar`, `rmCharFromGroup`                                  | `characters`, `characterTalks`, `characterActive` | Phase 6 `readers-characters`            |
| `currentChar`               | `process/modules.ts` `applyModule` (then `setCurrentCharacter`)                       | `globalLore`, `customscript`, `triggerscript`     | Phase 6 `readers-characters`            |
| `nowChatroom`               | `process/index.svelte.ts` `sendChatInner` (then `markCharacterDirtyAt`)               | `lastInteraction`                                 | Phase 5/6 (the send pipeline)           |
| `character`                 | `process/index.svelte.ts` `bumpReloadKey`                                             | `reloadKeys` (a render key, never saved)          | none needed                             |
| `current`, `char`, `dbChar` | `characters.ts` `changeCharImage`, `dumpCharImage`, `addCharEmotion`, `rmCharEmotion` | `image`, `extentions`, `emotionImages`            | Phase 6 `readers-characters`            |
| `db2`                       | `process/request/google.ts` (Phase 3's Vertex token)                                  | the token fields                                  | Phase 5 `request-layer-and-llm-secrets` |

Every two-way `bind:` onto `DBState.db` also escapes the grep: 393 in 25 files (396 in 26 at the
opening baseline).

The `cipherChat` allowlist entry is dead (Phase 3 dropped the field) and is dropped.

**Classification of the 309 hits.** The categories are disjoint, and each hit is in exactly one.
The per-hit ledger, listing file, enclosing function or template handler, and line, is in
[`closeout.md`](slices/phase-4-external-contracts/closeout.md#audit-ledger).

- **Settings pages: settings, presets, collections, and selection (171; Phase 6
  `readers-settings-pages`).** Every `src/lib/Setting/**` hit, except `ModuleSettings.svelte:88`
  (a character) and `PersonaSettings.svelte:29` (a false positive). This includes the preset,
  lore-preset, persona, module, plugin, custom-model, and translator-preset writes, and the
  selection accessors (`loreBookPage`, `translatorPresetId`), plus the registry's
  `customQuotesData` items (`setting/displaySettingsData.svelte.ts`, 8) and
  `languageSettingsData.svelte.ts` (1).
- **Settings writes outside the settings pages (59; Phase 6 `readers-settings-consumers`).**
  `WelcomeRisu` 39 (onboarding), `EasyPanel` 7, `CustomSidebarConfig` 5, `PromptDataItem` 2,
  `IrisModal` 1, the `DefaultChatScreen` toggles 2, `gui/colorscheme.ts` `changeColorSchemeType` and
  `importColorScheme` 2, and `index.svelte.ts` `sendChatInner` `statics.messages` 1.
- **Core-app character and collection writers (61).**
  - Phase 6 `readers-characters`:
    - `characters.ts` 9: `createNewCharacter`, `createNewGroup`, `dumpCharImage`,
      `changeCharImage`, `addCharEmotion`, `rmCharEmotion`, `makeGroupImage`, `restoreChar`,
      `removeChar`;
    - `lorebook.svelte.ts` 2: `addLorebook`, `addLorebookFolder`;
    - `CharConfig` 19, `Sidebar` 16 (the reorders), `LoreBookList` 3, `LoreBookSetting` 2,
      `ModuleChatMenu` 3;
    - `DefaultChatScreen:1025` 1, `Chat.svelte` folder creation 2, `PlaygroundMenu`
      `playgroundChat` 2, and `ModuleSettings:88` 1.
  - Phase 6 `character-ownership`: `stores.svelte.ts:175` (`supaMemory`) 1.
- **Boot paths (10; Phase 6 `character-ownership`, `settings-ownership`, `aggregate-removal`).**
  `bootstrap.ts` `assembleDatabase` 6 and `checkNewFormat` 4.
- **Phase 5 residuals (1).** `parser/chatVar.svelte.ts` `setGlobalChatVar` (CBS). The `google.ts`
  token writes escape the pattern (see the alias classes).
- **No owner yet (4).** See the proposed edits below.
- **False positives (3).**
  - `process/request/openAI/requests.ts:459` is a type position.
  - `PersonaSettings.svelte:29` is a type annotation.
  - `SettingsExportButtons.svelte:92` writes a snapshot copy.

**Hits without a Phase 5 or Phase 6 owner: proposed edits** to the Phase 6 slices, for their
owner to apply:

- `readers-settings-consumers` gains:
  - `src/lib/UI/NanoGPTDashboard.svelte:26` (`nanogptSubscriptionState` through a live
    `getDatabase()` alias);
  - `src/lib/Others/PromptDiffModal.svelte:170` (`promptDiffPrefs`, the same).
- `readers-characters` (or `readers-settings-consumers`, which has the Playground files) gains
  `process/prompt.ts` `promptConvertion` (the Playground conversion tool: two `botPresets.push`
  sites). It can call `addPreset` now.

### Backup round trip (Safety Contract)

Run manually on a fresh version-3 server (Playwright, scratchpad `checkP4Backup.mjs`):

1. Alpha was saved, and an archive was exported (`exportBackup`).
2. Alpha's description was changed through the MCP tool `risu-set-character-info`, and its name
   through a plugin's `setCharacter`; both were saved.
3. The archive was imported (`importBackup`), and the page reloaded: Alpha had its original name
   and description, and the plugin was gone.
4. The import's safety snapshot was restored (`listBackups`, `restoreBackup`), and the page
   reloaded: both changes and the plugin were back.

There were no page errors. An archive or snapshot of another schema version is refused (Phase 3;
`server/src/tests/backups.test.ts`), so the safety contract reads "an archive produced with the
supported schema version (since Phase 3)".

### Built-client check

The built client (`pnpm build`) was served by the self-host server itself from its `dist`, not by
Vite (scratchpad `checkP4Built.mjs`). The store was seeded through a dev client on the same server
with a character and a plugin provider. Then, through the UI:

- the character opened;
- a message was sent, and the plugin's permission prompt was answered;
- the reply was shown;
- after a reload, both messages were there.

There were no page errors.

### Manual checks re-run on the final tree

The Playwright checks of slices 2 to 7 (`checkP4Slice2.mjs` to `checkP4Slice7.mjs`) gave the same
results as recorded in their slices. The slice 6 script failed once in a sequential batch, with
its error message cut off in the log; it passed on three later runs.

### Checks

On the final tree (the slice 8 docs and review-step tests over `6aa4bd48`):

- `pnpm check`: 5131 files, 0 errors, 0 warnings.
- `pnpm test`: 98 files, 1013 passed, 3 skipped.
- `pnpm format:check` and `pnpm build` pass.
- `pnpm test:e2e`: 5 passed.

### Recorded behavior changes

From every slice (details in each slice file):

- **Plugins.**
  - `setDatabase`/`setDatabaseLite` apply each key on its own, and a refused value warns and keeps
    the old one. There is no whole-database normalizer: a malformed value is refused instead of
    normalized, and a `null` preset field outside `PRESET_NULLABLE_FIELDS` is refused.
  - `setDatabase({ characters })` keeps the order and appends new characters.
  - `setDatabase({ plugins })` upserts the confirmed plugins instead of replacing the installed
    list.
  - `characterOrder` and `selectedPersona` are applied after the other keys.
  - Refusals that were silent now warn: `characters` that is not a list, a `selectedPersona`
    naming no persona, a plugin argument that is not a string or a finite number, and a non-JSON
    custom key.
  - v3 `pluginStorage` refuses JSON nested deeper than 256 levels.
  - An unknown color scheme name changes nothing.
  - The `pluginStorage` watcher is deleted.
  - The render key `reloadKeys` starts from 0 and is left out of the character checks. After a
    send it was `NaN`, and slice 2's checks would otherwise refuse a `getCharacter` →
    `setCharacter` round trip.
- **Plugin hooks.** Inside a hook the host functions act on the hook's character, chat, and
  preset, and a target the call needs that is gone throws `PluginTargetGoneError`. `getCharacter`
  reports the hook's chat as its `chatPage`, and `setCharacter` does not apply that page back, so a
  round trip leaves the user's chat selection alone. Unloading a plugin removes its replacers and
  script handlers, and its pending callbacks reject.
- **MCP.**
  - A refused `risu-set-character-info` field changes nothing.
  - A write builds its patch from the record as it is after consent, and a record removed during
    the prompt answers "not found".
  - `risu-set-module-info` checks its field types.
  - A denied tool marks nothing.
- **Lua.** The four character getter and setter pairs (`getName`/`setName`,
  `getDescription`/`setDescription`, `getCharacterFirstMessage`/`setCharacterFirstMessage`, and
  `getBackgroundEmbedding`/`setBackgroundEmbedding`) address the run's character. That is the
  speaking member in a group, and the run's character when the selection moved.
  - A `simple` run writes no character through them.
  - `setDescription`'s type check tests its own argument.
  - The other Lua functions are unchanged: `getCharacterImageMain` and `getCharacterLastMessage`
    still read the selection, and the chat functions keep the run's chat.
- **Triggers.** The character effects write only the trigger's character, one field at a time, so
  other fields edited meanwhile are kept. In a group send they write the speaking member. A bad
  `v2SetLorebookActivation` index is skipped. Display and request runs make no mutation call.
- **Imports.**
  - A card that is not JSON data is refused (the stamp and a saved image may stay).
  - `importChat` writes the character selected when its dialog opened, and stops when that
    character was deleted.
  - A refused CharX module import no longer reports success.
  - The ST preset conversion's `NaN` still becomes the field's default.

### Residuals

- **Phase 5.** The effective persona (`PluginCallContext.personaId` is carried and not yet read).
  Also:
  - memory summarization and image generation still run plugin hooks against the tab's
    selection;
  - the native trigger getters read the working copy after a Lua write;
  - display and request lore effects edit the live `globalLore` in place;
  - the `ScriptingEditDisplayIds` cleanup.
- **Separate tasks.**
  - The deprecated `v2ModifyLorebook`/`v2SetLorebookActivation` array entry shape.
  - `importMCPModule` on a cancelled prompt.
  - The first-reload write-back of a minimal character (`bootstrap.ts` `checkNewFormat` defaults
    that the server's character kind does not store).
  - Off-spec cards with only `char_name`.
- **Phase 6.** The allowlist above, the `bind:` count, and lazy loading. The tests for the dialog
  races and the refusal paths exist; Phase 6 re-derives the allowlist when it starts.
