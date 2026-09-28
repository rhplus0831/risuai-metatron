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

1. Clone the character and chat. Display mode is the exception and mutates in place.
2. Copy the character's `lowLevelAccess` onto its triggers.
3. Append `getModuleTriggers()`.
4. Resolve variables.
5. Filter by event type (`start|manual|output|input|display|request`).
6. Skip any trigger with non-empty legacy `conditions` (trigger v1 was removed; these are not evaluated).
7. Run the effects in order. Legacy v1 effect types have no case and are ignored.

v2 layout:

- A flat effect array. Index 0 of the trigger list is the `v2Header` sentinel.
- Blocks are expressed with `indent`, `v2Else`, and generated `v2EndIndent` entries. Loops jump using `endOfLoop`.

Lua:

- The wasmoon factory loads lazily and mounts `/lua/json.lua` (up to 3 retries).
- Each call gets a UUID access key registered in `ScriptingSafeIds`, `ScriptingEditDisplayIds`, and `ScriptingLowLevelIds` as appropriate. It is removed afterwards.

## State

- `customscript` = `{comment, in, out, type, flag?, ableFlag?}` (declared in `shared/database.ts`). `type` is a free string. The UI also offers `edittrans` and `disabled`.
- Sources:
  - DB: `presetRegex` (active) and `globalscript` (unused).
  - Character: `customscript`, `triggerscript`, `lowLevelAccess`.
  - Module: `regex`, `trigger`, `lowLevelAccess`.
- Runtime variables are strings. They persist as `chat.scriptstate['$'+key]`. Display mode uses temp variables only.
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
- `src/ts/translator/edittransRegex.test.ts`: the `edittrans` path only.
- Not tested: `processScriptFull` ordering and cache, `runTrigger`, v2 editing, Lua permissions.

## Known Hazards

- `GlobalRegex.svelte` ignores the return value of `importRegex()`.
- `triggercode` effects have no runtime case. Only `triggerlua` executes.
