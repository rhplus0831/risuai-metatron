# Regex Scripts, Triggers, Lua Scripting

## Scope

- Owns:
  - regex find/replace scripts,
  - triggers v2 and Lua (the data model, the runtime, and the editors),
  - the Lua runtime (wasmoon) and the injected API.
- Paths:
  - `src/ts/process/{scripts,triggers,scriptings}.ts`
  - `src/ts/process/scriptings.test.ts`
  - `public/lua/json.lua`
  - `src/lib/SideBars/Scripts/*`
  - `src/lib/Setting/Pages/GlobalRegex.svelte`
  - `src/lib/Playground/{PlaygroundSyntax,PlaygroundParser}.svelte`
- Not here:
  - `edittrans` regex application → `media-aux.md` (`translator.ts:applyEdittransRegex`).
  - Module-provided scripts are collected by `process/modules.ts` → `characters-modules.md`.

## Files

- `scripts.ts`: regex script execution.
  - `ScriptMode` = `editinput|editoutput|editprocess|editdisplay`.
  - `processScriptFull(char, data, mode, chatID, cbsConditions)` returns `{data, emoChanged}`. `processScript` returns only `.data`.
  - `exportRegex`/`importRegex`, `resetScriptCache`.
  - Internal: `executeScript`, `processScriptCache`, `bestMatchCache`.
- `triggers.ts`: the trigger runtime. The trigger model (`triggerscript`, `triggerEffect`, the `triggerV2*` effect types) is declared in `shared/triggers.ts` and re-exported here.
  - Types: `triggerscript`, `triggerEffect` = `triggerCode | triggerEffectV2`.
  - `triggerscript.conditions` is `unknown[]`, kept for shared-format compatibility with upstream readers. Newly created triggers write `[]`; imported arrays are preserved, and `runTrigger` skips triggers with non-empty conditions.
  - Allowlists: `displayAllowList`, `requestAllowList`.
  - `runTrigger(char, mode, {chat, displayData, manualName, ...})` returns `{additonalSysPrompt, chat, tokens, stopSending, sendAIprompt, displayData, tempVars}`.
- `scriptings.ts`: Lua orchestration.
  - `runScripted`: one engine per mode, serialized by `Mutex`.
  - `runLuaEditTrigger`: `editinput`/`editoutput`/`editdisplay`, plus `editRequest` from `sendChat`.
  - `runLuaButtonTrigger`: `onButtonClick`.
  - Internal: `declareAPI`, `luaCodeWrapper`, `ScriptingEngines`, and the permission ID sets.
- `SideBars/Scripts/RegexData.svelte`, `RegexList.svelte`: the regex editor. Flags are native `g/i/m/u/s` plus `<move_top>`, `<move_bottom>`, `<repeat_back>`, `<cbs>`, `<no_end_nl>`, `<order n>`.
- `SideBars/Scripts/TriggerList.svelte`: picks the editor mode (v2 or Lua). Any other non-empty list (legacy v1 data, `triggercode`) shows `triggerLegacyUnsupported` and is replaced when switching mode.
- `TriggerV2List.svelte`: the v2 editor, about 4100 lines.
  - `effectCategories`, `checkSupported`, `makeDefaultEditType`.
  - Block edit helpers: `deleteEffect`, `copyEffect`, `getInsertIndent`, `getBlockRange`.
  - Save-time `v2EndIndent` generation.
- `GlobalRegex.svelte`: edits `db.globalscript`, which the runtime never reads.

## Flows

Where each hook runs:

| Hook                                                                                                                 | Caller                       |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `runTrigger('input')` then `processScript('editinput')`                                                              | `DefaultChatScreen.sendMain` |
| `runTrigger('start')`, `processScriptFull('editprocess')`, `processScriptFull('editoutput')`, `runTrigger('output')` | `sendChat`                   |
| `processScriptFull('editdisplay')`, which runs `runTrigger('display')` first                                         | `ParseMarkdown`              |
| `runTrigger('request', {displayMode})`                                                                               | `requestChatData`            |
| `runTrigger('manual')`                                                                                               | `command.ts`                 |
| `runLuaButtonTrigger`                                                                                                | `Chat.svelte`                |

`processScriptFull` steps:

1. `runLuaEditTrigger`.
2. Display trigger, only for `editdisplay`.
3. Plugin `edit*` replacers.
4. CBS.
5. Collect the scripts: `db.presetRegex ++ char.customscript ++ getModuleRegexScripts()`.
6. Cache lookup.
7. Run each script whose `type === mode`, in declaration order, or by descending `<order n>` if any script is ordered.
8. Dynamic asset replacement.
9. Cache write.

`runTrigger` steps:

1. Clone the character and chat. Display and request runs clone the character not at all and copy only the chat and its message list (they run per rendered message); their effects replace messages instead of editing them. For other runs, the caller captures a chat baseline and applies the returned chat with `applyChatResult` (`persistence.md`); chat variables and the author's note are also written to the live chat as the trigger runs (`setChatMeta`), so later effects and CBS read them. Display and request runs pass `displayMode: true`, which leaves `chatTarget` null: variables use `tempVars`, and nothing is written to the live chat.
2. Copy the character's `lowLevelAccess` onto its triggers.
3. Append `getModuleTriggers()`.
4. Resolve variables.
5. Filter by event type (`start|manual|output|input|display|request`).
6. Skip any trigger with non-empty legacy `conditions` (trigger v1 was removed; these are not evaluated).
7. Run the effects in order. Legacy v1 effect types have no case and are ignored.
8. The character effects (`v2SetCharacterDesc`, `v2SetReplaceGlobalNote`, and the six lorebook writers) edit the working copy and write the one field they change to the trigger's character (the copy's `chaId`: the send's character, in a group send the speaking member) through `updateCharacter`, never the selected character and never the whole copy, so other fields edited while the trigger ran are kept. `v2SetPersonaDesc` writes the persona selected at effect time through `updatePersona` (a missing selection warns and writes nothing). Display and request runs make no character or persona write (their lore effects still edit the live `globalLore` in place until Phase 5).

v2 layout:

- A flat effect array. Index 0 of the trigger list is the `v2Header` sentinel.
- Blocks are expressed with `indent`, `v2Else`, and generated `v2EndIndent` entries. Loops jump using `endOfLoop`.

Lua:

- The wasmoon factory loads lazily and mounts `/lua/json.lua` (up to 3 retries).
- Read context: the Lua `cbs`, persona, global-variable, and lore APIs (`getLoreBooks`, `loadLoreBooks`) read the run's chat (`contextRef`: a trigger's chat, or the live chat). In a trigger's working copy, `cbs` and `loadLoreBooks` still read the live chat, as trigger CBS always has, while the message getters and `getLoreBooks`' local lore read the copy; `loadLoreBooks` records its keep/don't-activate-after-match flags on the live chat.
- Chat functions (`setChat`, `setChatRole`, `cutChat`, `removeChat`, `addChat`, `insertChat`, `setFullChat`, `upsertLocalLoreBook`) and chat variables: inside `runTrigger` they use the trigger's working copy and its variable accessors; elsewhere (edit hooks, buttons) they use the chat the run was given (`runScripted`'s `chatRef`; default: the chat selected when the run started), looked up again on every call (a replacement or reload installs a new object), and write through the chat module, resolving an index to a message id when called. A write the module refuses (the message is being generated) is skipped with a warning.
- Character functions (`getName`/`setName`, `getDescription`/`setDescription`, `getCharacterFirstMessage`/`setCharacterFirstMessage`, `getBackgroundEmbedding`/`setBackgroundEmbedding`): they address the run's character, the id `runScripted` captures before its first await from its `char` argument (else the selection at entry; in a group send the speaking member, while the chat functions keep the group's chat). A `simple` argument (a module or translation run) has no writable character: the getters read `""` and the setters write nothing (`setCharacterFirstMessage` and `setBackgroundEmbedding` return `false`). The setters write through `updateCharacter`; an existing character's missing field reads as `nil`. The engine state holds the id per run, so a reused engine reads the current run's character, and `generateImage` and `upsertLocalLoreBook`'s type check read it too.
- Each call gets a UUID access key registered in `ScriptingSafeIds`, `ScriptingEditDisplayIds`, and `ScriptingLowLevelIds` as appropriate. It is removed afterwards.

## State

- `customscript` = `{comment, in, out, type, flag?, ableFlag?}` (declared in `shared/database.ts`). `type` is a free string. The UI also offers `edittrans` and `disabled`.
- Sources:
  - DB: `presetRegex` (active) and `globalscript` (unused).
  - Character: `customscript`, `triggerscript`, `lowLevelAccess`.
  - Module: `regex`, `trigger`, `lowLevelAccess`.
- Runtime variables are strings. They persist as `chat.scriptstate['$'+key]`, written with `setChatMeta` (the whole `scriptstate` object; two tabs changing different variables of one chat at once keep the later write). Display-mode triggers use temp variables only. Lua `editDisplay` hooks are the exception, as before: `setChatVar` there writes the chat (a hook that changes a variable on every render causes a save each time).
- `processScriptCache` holds at most 1000 entries and is reset by `resetScriptCache` (called on the `ReloadGUIPointer` bump). `bestMatchCache` has no cap.

## Coupling

- `scripts.ts` depends on the parser, modules, plugins, `HypaProcesser` (dynamic assets), Lua, triggers, and `CharEmotion`.
- `triggers.ts` depends on the parser, modules, `ReloadChatPointer`/`ReloadGUIPointer`, `CurrentTriggerIdStore`, commands, the tokenizer, `requestChatData`, `stableDiff`, inlays, and Lua.
- UI owners:
  - Character regex and triggers: `CharConfig.svelte`.
  - `presetRegex`: `BotSettings.svelte`.
  - Module regex and triggers: `ModuleMenu.svelte`.

## Invariants

- Never rename the serialized discriminators: `customscript.type`, `triggerscript.type`, effect `type`, v2 `indent`, the header at index 0.
- Regex order matters. `<order n>` applies only when `ableFlag` is true. Native flags are sanitized to `dgimsuvy`, deduplicated, and default to `u`.
- The cache stores final output, not compiled `RegExp` objects. An empty-string result is falsy and therefore never cache-hits.
- Display and request modes silently skip effects missing from `displayAllowList`/`requestAllowList`. The editor's `checkSupported` mirrors those lists. Keep them in sync.
- Low-level effects are gated twice: filtered in the UI and checked at runtime via `trigger.lowLevelAccess`. Lua edit hooks always run with `lowLevelAccess:false`.
- Normal `runTrigger` returns a new `chat`. The caller must persist it.
- A trigger effect or Lua function that changes a character writes one field of the run's character through `updateCharacter`; never `setCurrentCharacter`, the selected index, or the whole working copy.
- v2 block edits must preserve paired `v2EndIndent` entries and indentation.
- Lua `request` restrictions: HTTPS only, URL at most 120 characters, 5 requests per minute, some Risu endpoints blocked, and it requires low-level access. There is no CPU or memory limit.

## Recipes

- Add a regex mode: extend `ScriptMode`, wire its caller, add the UI option in `RegexData.svelte`, and update `translator.ts:applyEdittransRegex` if the mode is translation-only.
- Add a regex flag: add it to the UI in `RegexData.svelte`, parse the `<...>` metadata in `processScriptFull`, implement it in `executeScript`, and add the translator equivalent if needed.
- Add a v2 effect:
  1. Add the type and union member in `shared/triggers.ts`.
  2. Update `effectCategories`, `checkSupported`, and `makeDefaultEditType` in `TriggerV2List.svelte`.
  3. Add the field editor branch.
  4. Add a `runTrigger` case.
  5. Update the allowlists if the effect should run in display or request mode.
  6. Add the `triggerDesc` language key in `src/lang/en.ts`.
- Add a block-type v2 effect: also update `deleteEffect`, `copyEffect`, `getInsertIndent`, `getBlockRange`, and the save-time `v2EndIndent` generation.
- Add a Lua API: `declareAPI` in `scriptings.ts`, plus a `luaCodeWrapper` wrapper if it is async or JSON-based, plus the correct Safe/EditDisplay/LowLevel guard. Add a test in `scriptings.test.ts`.

## Tests

- `src/ts/process/scriptings.test.ts`: Lua stop-signal semantics.
- `src/ts/process/scriptingsSetters.test.ts`: the four Lua character getters and setters on a real wasmoon engine over the real store: a character that is not selected, a group member on the group's chat, engine reuse across runs and a `simple` run, the entry-time id, removal and replacement mid-run, `nil` for a missing field.
- `src/ts/process/triggers.test.ts`: the eight character effects and `v2SetPersonaDesc` over the real store: the trigger's character (a group member), one-field patches, a suspended trigger with the selection moved, deletion and refusal, the activation index guard, Lua and native effects in one trigger, and no mutation call from display and request runs.
- `src/ts/translator/edittransRegex.test.ts`: the `edittrans` path only.
- Not tested: `processScriptFull` ordering and cache, v2 editing, Lua permissions.

## Known Hazards

- `GlobalRegex.svelte` ignores the return value of `importRegex()`.
- `triggercode` effects have no runtime case. Only `triggerlua` executes.
- The deprecated `v2ModifyLorebook`, `v2SetLorebookActivation`, and their reads address lore entries as arrays (`entry[0]`, `entry[2]`), but entries are objects: the first never matches, the second adds a junk `"2"` key (pre-existing; a separate task).
- After a Lua setter writes the live character inside a trigger, the native getters (`v2GetCharacterDesc`, ...) still read the working copy taken at run start, so a native set fed from them can restore the old value (Phase 5's `trigger-runtime`).
