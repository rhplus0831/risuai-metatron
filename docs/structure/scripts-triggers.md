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

- `shared/scripts/regex.ts`: the regex engine both the client and the server run (Phase 5).
  - `runRegexScripts(data, scripts, { mode, chatID, parse, repeatBackSource, applyEffect? })` returns `{ data, effects }`: flags, `<order n>` and the other `<...>` actions, the `@@` directives, and the script loop (a script that throws is skipped). It writes nothing itself: `@@emo` and `@@inject` go to `applyEffect` where their script matched, inside that script's `try` (so a later script's CBS reads the write, and a throwing sink skips the rest of that script only), and are also returned as the ordered `effects` (`{ kind: "emotion", name }`, `{ kind: "inject", text }`). `parse` is the run's CBS; `repeatBackSource` answers `@@repeat_back`'s previous message.
  - `regexScriptCacheKey` and `createScriptCache` (the final output, 1,000 entries).
- `scripts.ts`: the client orchestration around the engine.
  - `ScriptMode` = `editinput|editoutput|editprocess|editdisplay` (`RegexScriptMode`).
  - `processScriptFull(char, data, mode, chatID, cbsConditions, chatRef, pluginContext)` returns `{data, emoChanged}`. `processScript` returns only `.data`.
  - `exportRegex`/`importRegex`, `resetScriptCache`.
  - Internal: `processScriptCache`, `bestMatchCache` (dynamic assets), and the effect applier (`CharEmotion`, `setMessageText`).
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
7. `runRegexScripts`: each script whose `type === mode`, in declaration order, or by descending `<order n>` if any script is ordered. Its `applyEffect` is the wrapper's applier, called where the script matched: `@@emo` to `CharEmotion` (`emoChanged`), `@@inject` to the message at `chatID` (resolved to a message id before the awaits; a locked message is skipped with a warning).
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

- The wasmoon factory loads lazily, with wasmoon's `glue.wasm` from the app's own origin (a Vite `?url` asset of the installed package, deployed with the JS in `dist`; without a URL wasmoon would fetch it from unpkg), and mounts `/lua/json.lua` (up to 3 retries).
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
- Server Lua (Phase 5 slice 8a; `self-host-server.md`): with the client-local flag `risu.serverGeneration` (`src/ts/storage/clientFlags.ts`, `localStorage`, off by default), a Lua button (`risu-btn`, not a manual trigger: an element with both attributes runs its trigger in the tab) runs on the server: `serverCommands.ts` `runServerButton` takes the target and settings ids before any await, flushes (a refused or discarding flush runs nothing), posts a `command` job, and follows it to its end (`followJobToEnd`: one follow per job, shared by the button, a busy job of this tab, and the boot resume `resumeServerJobs`; a socket that closes early attaches again, five times at most, a failed status read is retried, an ended job is attached again for its final records; the end is reported once; a lost job is released like an ended one, its channel requests cancelled). The job's chat and character changes arrive as the server's records; its alerts and questions through the job channel, shown one at a time (in the tab, `alertNormal` does not wait and a following question replaces it at once). `server/src/lua/bindings.ts` serves the host functions there: the client's guards, exposures (synchronous or a promise), and results; chat functions on the job's chat by id through `job.write`, the chat read again after every write and callback; setters on the run's character, read live; `cbs`, persona, and lore over the job's frozen scope (`jobScope.ts`, `cbsHost.ts`); `LLM`/`axLLM`/`simpleLLM` through the server request layer (`runInJob` with the client's outer loop, `outer.ts`; no tools until slice 12; a plugin or a tab's dynamic model is refused, as it runs in the browser); `getTokens` with the server counter; `hash` SHA-256; `generateImage` a `generateImage` callback (the tab generates and writes the inlay; no run character: the failure string without a callback); `getCharacterImage`/`getPersonaImage` an inlay under the asset key (an existing image inlay whose media is stored at once, else an `inlayImage` callback: the tab's canvas draws it; the tab's inlay writer stops when the callback is cancelled); `similarity` raises until slice 10. A refused write of a message another generation owns is skipped as in the tab; any other conflict, a lost owner, a barrier failure, or an abort ends the job (`LuaJobFatalError`, latched outside Lua). Each run is a fresh engine: Lua globals do not survive between runs (Safety Contract).
- Server manual triggers (Phase 5 slice 8b; `self-host-server.md`): with the same flag, a manual trigger (`risu-trigger` in `Chat.svelte`, with its `risu-id`; `/trigger name` typed in the chat input, `processMultiCommand(..., { fromInput: true })` from `DefaultChatScreen.svelte`) runs on the server as a `command` job `{ type: "manual", name }` with `context.triggerId` (`serverCommands.ts` `runServerManualTrigger`, the button's preflight and follow; `CurrentTriggerIdStore` is set once the job exists and cleared 100 ms after, as in the tab). A browser trigger's `v2Command` keeps its `/trigger` in the tab until its own cutover. `server/src/prompt/triggers.ts` `createTriggerRuntime` is the port of `runTrigger` with the same effect switch, allowlists, defaults, and early returns; `server/src/prompt/commands.ts` the port of `processMultiCommand` on the job's chat; `server/src/jobs/chatResult.ts` `applyTriggerChat` the port of `applyChatResult` as one atomic job write. Recorded differences on the server path: the character is always a deep copy (display and request runs no longer edit the live lore in place); every effect checks the job's abort, and a job stops with an error past 100,000 effects (nested runs and `/trigger` included; a privileged recursion yields each level, so the limit ends it, not the stack); a question that is not answered ends the job with its error; `v2RunTrigger` passes the display mode, display data, and temporary variables to the nested run and takes its display data back; `v2Command` always targets the job's chat; `{{trigger_id}}` is the job's id throughout; `v2SetPersonaDesc` writes the job's effective persona while `v2GetPersonaDesc` reads the selected persona as frozen with the job; `v2CheckSimilarity` answers `"null"` until slice 10; `v2ConsoleLog` goes to the server log; `/multisend` is refused with an `alertError`; `/speak` is a `tts` notice; `/?` an `alertMd` notice; the six native regex sites (`v2ExtractRegex`, `v2SplitString`, `v2QuickSearchChat`, `v2GetLorebookByName`, `v2RegexTest`, `v2ReplaceString`) run in the worker's regex tasks, each with the tab's error behavior (a regex the tab would throw on ends the job). A `triggerlua` effect runs on the trigger's working copy (`bindings.withWorking`): the chat functions read and edit the copy, `getChatVar`/`setChatVar` go through the trigger's variables, CBS, lore activation, and the character functions keep the job's chat and records; a Lua character setter also updates the copy of every running trigger of that character, so a native getter after it reads the new value (the Phase 4 residual). Inherited from the tab and kept: the final diff re-sets `scriptstate` and the note from the copy, so a command's `/setvar` during the run can be overwritten by the copy's older map; the variable writes during a run change the chat's revision, so a reorder by the trigger is then dropped.

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
- Add a regex flag: add it to the UI in `RegexData.svelte`, parse the `<...>` metadata in `parseScripts` and implement it in `executeScript` (both in `shared/scripts/regex.ts`, strict-checked by the server `tsc`), and add the translator equivalent if needed.
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
- `server/src/tests/regex.test.ts` (node): the shared engine: mode filter and `<order n>`, skipped scripts (empty or malformed pattern), flag cleanup, `<cbs>` patterns, `@@move_top`/`@@move_bottom`, the effects in script order and `applyEffect` at the match (a later script's `{{lastmessage}}` reads the write; a throwing sink skips the rest of that script only), `@@repeat_back` (positions, the null-match skip, a throwing source), and the cache key and eviction. The legacy quirks are pinned by name (`{{data}}` stays literal; an `@@inject` without a message index or a `@@repeat_back` whose text already matches write the directive text).
- `src/ts/process/scripts.test.ts`: the client wrapper over the real evaluator and chat module: `@@inject` then `{{lastmessage}}` and a `<cbs>` pattern reading the injected text, the cache (a `<cbs>` key expanded before the run; a hit applies no effect), a missing target, a locked message (rejected write), interleaved `@@emo`/`@@inject` order, a failing effect skipping its script only, and `@@repeat_back` through the client's lookup.
- `server/src/tests/luaBindings.test.ts` and `server/src/tests/luaBindingsFences.test.ts` (node; `self-host-server.md`): the server Lua host functions through the real worker and the production bindings (the 54-name contract, guards per trigger provenance, the chat writes by id, the fatal latch, the cancellation fences).
- `src/ts/process/serverCommands.test.ts`: the tab's side of a server Lua button over a stubbed transport: one `followJobToEnd` lifecycle per job shared by a button, a busy job, and the boot resume (one socket, the terminal applied once, no release or alert for `done`); the bounded reattach after a socket closed without the terminal (a failed status read retried, an unknown or other-epoch job released as lost with one alert, an aborted end not alerted, five attaches at most); the boot discovery retried inside the lifecycle, joining an active follow without a status read, and a button joining a discovery in progress; `runServerButton` (ids taken before the flush, the command body, nothing for a group, a discarding or rejected flush, a chat gone meanwhile, or an unsaved chat, and the owned-busy follow versus another owner's busy alert); `runServerManualTrigger` (slice 8b: the manual body with `mode: "manual"` and the trigger id present or omitted, `onStart` once the job exists and before the follow, the outcomes `started` for a done or error terminal, `refused` without `onStart` for every preflight refusal and another owner's busy job, `followed` for this tab's busy job).
- `src/ts/process/command.test.ts` also covers `/trigger` on the server (slice 8b): a line typed in the chat input (`fromInput`) with `risu.serverGeneration` on hands the CBS'd name to `runServerManualTrigger` and runs no browser trigger; without the flag, or for a trigger's own command line without `fromInput`, the browser path runs.
- `server/src/tests/triggerRuntime.test.ts` (node; `self-host-server.md`): the server trigger runtime over controlled job services, the real regex engine (`runRegexOp`), and the real command executor, with the expected values derived from the client's effect switch: variables (every operator, the whole-map immediate write that CBS reads, the local → scriptstate → defaults → temp precedence, display-mode temp variables with nothing persisted, the owned temp map returned, a gone chat warned), control flow (every condition, `v2IfAdvanced` source types, else, loops with per-trigger counters, break, stop, the loop yield), the manual-name and mode filters with Lua modes (the name, `"manual"` when none, `""` kept) and module triggers, the allowlists and the bare returns, the array, dictionary, string, and calculator effects with the client's fallback values, the output-name evaluation order (before a throwing access, before an awaited count), the six regex sites (extract, split, quick search, lore by name compiled on empty input, test, replace against the client's replacer as the oracle, each site's error behavior), the chat, character (one field per patch), persona, and UI effects (notices, questions, `reloadChat` of the stored message), `v2ImgGen`/`v2RunLLM`/`v2CheckSimilarity`/`v2SendAIprompt` with and without `lowLevelAccess`, `triggerlua` on the working copy with the character-patch listener, recursion (the depth rule, display data and temp variables through a nested run, the shared effect limit on the native and the `/trigger` route without a stack overflow, an endless loop), and the fences (an abort during a final token count, a waiting question, a regex, or between effects; a fatal failure escaping the fallback catches; `v2Wait` ending with the signal's reason).
- `server/src/tests/commandExecutor.test.ts` (node): the server command executor over the production bindings' services on a real in-memory store: pipes split outside quotes (the quotes kept), `{{pipe}}`/`{{slot}}` and the empty argument, CBS on the arguments, `/echo`/`/popup`/`/?` notices, `/input`/`/buttons` questions and a question not answered ending the line, `/speak` as a `tts` notice, the append-only `/send`/`/sendas`, `/comment`, the `/cut` and `/del` index rules (a negative index on the range branch), `/setvar`/`/addvar` merged with the variables as stored at the write (a key added during a question kept; `/addvar` on a missing variable `"NaN"` as in the tab), `/getvar`, a chat deleted during a question consuming the line, a gone character answering `""`, `/trigger` handed to the job's manual run (refused for a group), `/multisend` refused with an `alertError`, `/setinput` and unknown commands `false`.
- `server/src/tests/manualTriggers.test.ts` (node; `self-host-server.md`): a manual trigger as a `command` job end to end on a real listening server (the runtime, the executor, the applier, the worker's regex and Lua, the channel).
- Not tested: v2 editing, Lua permissions in the tab, the `Chat.svelte` trigger-id owner token (the server branch's `onStart`/outcome contract is pinned in `serverCommands.test.ts`; the owner logic runs only in the component).

## Known Hazards

- `GlobalRegex.svelte` ignores the return value of `importRegex()`.
- `triggercode` effects have no runtime case. Only `triggerlua` executes.
- The deprecated `v2ModifyLorebook`, `v2SetLorebookActivation`, and their reads address lore entries as arrays (`entry[0]`, `entry[2]`), but entries are objects: the first never matches, the second adds a junk `"2"` key (pre-existing; a separate task).
- After a Lua setter writes the live character inside a trigger, the native getters (`v2GetCharacterDesc`, ...) still read the working copy taken at run start, so a native set fed from them can restore the old value (Phase 5's `trigger-runtime`).
