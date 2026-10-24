# Regex Scripts, Triggers, Lua Scripting

## Scope

- Owns:
  - regex find/replace scripts (the shared engine and the editors),
  - triggers v2 and Lua (the data model and the editors; the runtime is the server's),
  - the server's script entry points as the tab reaches them (Lua buttons, manual triggers, the script transform).
- Paths:
  - `shared/scripts/regex.ts`, `shared/triggers.ts`
  - `src/ts/process/regexFiles.ts`
  - `src/ts/process/serverCommands.ts`
  - `public/lua/json.lua` (read by the server's script workers)
  - `src/lib/SideBars/Scripts/*`
  - `src/lib/Playground/{PlaygroundSyntax,PlaygroundParser}.svelte`
  - `src/etc/docs/regex.cbs` (example script documentation)
- Not here:
  - The runtime itself: `server/src/prompt/{scripts,triggers,commands}.ts`, `server/src/lua/*`, `server/src/scripts/*` → `self-host-server.md`.
  - `edittrans` regex application → `media-aux.md` (`translator.ts:applyEdittransRegex`, the one regex the tab still runs: plain `RegExp` replacement on translation text, no Lua or trigger).
  - Module-provided scripts are collected by `process/modules.ts` → `characters-modules.md`.

## Files

- `shared/scripts/regex.ts`: the regex engine (the server's workers run it).
  - `runRegexScripts(data, scripts, { mode, chatID, parse, repeatBackSource, applyEffect? })` returns `{ data, effects }`: flags, `<order n>` and the other `<...>` actions, the `@@` directives, and the script loop (a script that throws is skipped). It writes nothing itself: `@@emo` and `@@inject` go to `applyEffect` where their script matched, inside that script's `try` (so a later script's CBS reads the write, and a throwing sink skips the rest of that script only), and are also returned as the ordered `effects` (`{ kind: "emotion", name }`, `{ kind: "inject", text }`). `parse` is the run's CBS; `repeatBackSource` answers `@@repeat_back`'s previous message.
  - `RegexScriptMode` = `editinput|editoutput|editprocess|editdisplay`.
  - `regexScriptCacheKey` and `createScriptCache` (the final output, 1,000 entries).
- `regexFiles.ts`: `exportRegex`/`importRegex` (the regex file export and import of the editors).
- `shared/triggers.ts`: the trigger model (`triggerscript`, `triggerEffect` = `triggerCode | triggerEffectV2`, the `triggerV2*` effect types) and the allowlists `displayAllowList`/`requestAllowList` (with their side-effect-free subset; the server runtime and `TriggerV2List.svelte` both read them).
  - `triggerscript.conditions` is `unknown[]`, kept for shared-format compatibility with upstream readers. Newly created triggers write `[]`; imported arrays are preserved, and the runtime skips triggers with non-empty conditions.
- `serverCommands.ts`: the tab's side of a server command job (`runServerButton`, `runServerManualTrigger`) and of a send job (`runServerJob`), and the job follow (`followJobToEnd`, `resumeServerJobs`). `followedJobs` is the reactive registry of those follows by job id, with a chat key once known; `followedJobsOf(jobs, ref)` returns that chat's job ids. A Lua button's or manual trigger's command job on the selected chat shows Stop, which aborts it from the chat screen.
- `SideBars/Scripts/RegexData.svelte`, `RegexList.svelte`: the regex editor. Flags are native `g/i/m/u/s` plus `<move_top>`, `<move_bottom>`, `<repeat_back>`, `<cbs>`, `<no_end_nl>`, `<order n>`.
- `SideBars/Scripts/TriggerList.svelte`: picks the editor mode (v2 or Lua). Any other non-empty list (legacy v1 data, `triggercode`) shows `triggerLegacyUnsupported` and is replaced when switching mode.
- `TriggerV2List.svelte`: the v2 editor, about 4100 lines.
  - `effectCategories`, `checkSupported`, `makeDefaultEditType`.
  - Block edit helpers: `deleteEffect`, `copyEffect`, `getInsertIndent`, `getBlockRange`.
  - Save-time `v2EndIndent` generation.

## Flows

The tab owns the editors and starts jobs. Lua and trigger effects execute on the server; the shared regex engine runs in the server's script worker. The translator's `edittrans` regex is the client-side exception (`media-aux.md`).

| Hook                                                               | Where                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| the `input` trigger, then `editinput`                              | the send job's input stage (`server/src/prompt/runner.ts`) |
| `start` trigger, `editprocess`, `editoutput`, `output` trigger     | the send job (`assemblePrompt`, the tail)                  |
| `editdisplay` (Lua `editDisplay`, the display trigger, CBS, regex) | `/api/transform` (`ParseMarkdown`, `transformClient.ts`)   |
| the `request` trigger                                              | every request of a server job (`runSetup.ts`)              |
| `manual` trigger                                                   | a `command` job (`runServerManualTrigger`)                 |
| Lua `onButtonClick`                                                | a `command` job (`runServerButton`)                        |
| Lua `onFormSubmit`                                                 | a `command` job (`Chat.svelte` `handleFormTriggerWithin`)  |

The tab's own LLM requests (translation, suggestions, the HypaV3 modal, plugins) run no `request` trigger.

v2 layout:

- A flat effect array. Index 0 of the trigger list is the `v2Header` sentinel.
- Blocks are expressed with `indent`, `v2Else`, and generated `v2EndIndent` entries. Loops jump using `endOfLoop`.

## State

- `customscript` = `{comment, in, out, type, flag?, ableFlag?}` (declared in `shared/database.ts`). `type` is a free string. The UI also offers `edittrans` and `disabled`.
- Sources:
  - DB: `presetRegex` (active) and `globalscript` (unused; no UI edits it).
  - Character: `customscript`, `triggerscript`, `lowLevelAccess`.
  - Module: `regex`, `trigger`, `lowLevelAccess`.
- Runtime variables are strings. They persist as `chat.scriptstate['$'+key]`. Display-mode triggers use temp variables only.
- Command jobs (`self-host-server.md`): `runServerButton` handles `risu-btn`, `runServerManualTrigger` handles `risu-trigger` and `/trigger`, and the chat row routes `risu-form` submits through `runServerJob`. The client captures the chat before awaiting its save flush. Chat-row forms always prevent navigation, send string values (repeated names become arrays), and are capped at 64 KiB of JSON by the server. Job lifecycle and Lua host behavior belong to `self-host-server.md`.
- Runtime boundary (`self-host-server.md`): `server/src/prompt/triggers.ts:createTriggerRuntime` runs v2 effects and `triggerlua` with the job's chat and abort signal. `shared/triggers.ts` owns the serialized effect types and display/request allowlists; the runtime copies the character for each run and shares its asset lists read-only.
- Send scripts (`self-host-server.md`): `server/src/prompt/scripts.ts:createScriptProcessor` handles `editinput`, `editprocess`, and `editoutput`. It runs Lua edit hooks where defined, the plugin hook, CBS, then regex scripts. Dynamic assets can run without regex scripts for `editoutput` and configured `editdisplay`; regex effects are applied at the match and returned in order, while the cache stores final output.
- Display transform (`cbs-rendering.md`): `ParseMarkdown` and the translator call `/api/transform` for server-side `editdisplay`; a missing chat, server record, preset, or persona skips the request. The transform does not persist chat variables; `@@emo` effects are applied by the tab.
- The request trigger runs before each provider attempt of a server job. Tab-only LLM requests do not run it. Request construction and job boundaries are covered by `llm-requests.md` and `self-host-server.md`.

## Coupling

- The tab's script entry points (`serverCommands.ts`, `transformClient.ts`) depend on the job channel, the chat module, and the save adapter's flush.
- UI owners:
  - Character regex and triggers: `CharConfig.svelte`.
  - `presetRegex`: `PromptPresetSettings.svelte`.
  - Module regex and triggers: `ModuleMenu.svelte`.

## Invariants

- Never rename the serialized discriminators: `customscript.type`, `triggerscript.type`, effect `type`, v2 `indent`, the header at index 0.
- Regex order matters. `<order n>` applies only when `ableFlag` is true. Native flags are sanitized to `dgimsuvy`, deduplicated, and default to `u`.
- The cache stores final output, not compiled `RegExp` objects. An empty-string result is falsy and therefore never cache-hits.
- Display and request modes silently skip effects missing from `displayAllowList`/`requestAllowList`. The editor's `checkSupported` reads the same lists (`shared/triggers.ts`).
- Low-level effects are gated twice: filtered in the UI and checked at runtime via `trigger.lowLevelAccess`. Lua edit hooks always run with `lowLevelAccess:false`.
- The server trigger runtime checks job cancellation during execution and enforces a 100,000-effect limit across nested triggers in the job. It yields after 50 ms of effect work so pending I/O and abort callbacks can run; a privileged recursive trigger is ended by the shared limit, not the JavaScript stack.
- A trigger effect or Lua function that changes a character writes one field of the run's character; never the selected index or the whole working copy.
- v2 block edits must preserve paired `v2EndIndent` entries and indentation.
- Lua `request` restrictions (`server/src/lua/egress.ts`): HTTPS only, URL at most 120 characters, the three banned Risu prefixes, no `localhost` and only public addresses, 30 requests per minute per server, a 10 s timeout and a 2 MB answer; it requires low-level access.
- Lua character getters return `""` when the run has no resolvable character, and the stored value (possibly `undefined`) for a resolvable one; character setters return without writing when no character resolves.
- Lua `setDescription` refuses a non-string value ("Invalid data type") and writes nothing.
- Trigger character effects warn and skip a gone character; a patch the store refuses is a fatal failure that ends the job (`LuaJobFatalError`, `server/src/lua/bindings.ts`); `v2SetLorebookActivation` warns and changes nothing for a non-integer, negative, or missing lore index.
- Lua `request(id, url)` returns `nil` at once, without any egress, when `id` has no low-level access.
- `logMain` passes its text through as is; the Lua `log` wrapper JSON-encodes its value before calling it.

## Recipes

- Add a regex mode: extend `RegexScriptMode` (`shared/scripts/regex.ts`), wire its caller on the server, add the UI option in `RegexData.svelte`, and update `translator.ts:applyEdittransRegex` if the mode is translation-only.
- Add a regex flag: add it to the UI in `RegexData.svelte`, parse the `<...>` metadata in `parseScripts` and implement it in `executeScript` (both in `shared/scripts/regex.ts`, strict-checked by the server `tsc`), and add the translator equivalent if needed.
- Add a v2 effect:
  1. Add the type and union member in `shared/triggers.ts`.
  2. Update `effectCategories`, `checkSupported`, and `makeDefaultEditType` in `TriggerV2List.svelte`.
  3. Add the field editor branch.
  4. Add a case to the server runtime (`server/src/prompt/triggers.ts`).
  5. Update the allowlists (`shared/triggers.ts`) if the effect should run in display or request mode.
  6. Add the `triggerDesc` language key in `src/lang/en.ts`.
- Add a block-type v2 effect: also update `deleteEffect`, `copyEffect`, `getInsertIndent`, `getBlockRange`, and the save-time `v2EndIndent` generation.
- Add a Lua API: the server bindings (`server/src/lua/bindings.ts`, with the guard of its provenance), plus the prelude wrapper in `server/src/lua/runtime.ts` if it is async or JSON-based. Add a case to `server/src/tests/luaBindings.test.ts` (the name contract).

## Tests

- Regex engine: `server/src/tests/regex.test.ts` covers parsing, mode and order rules, effects, and final-output caching. `server/src/tests/regexScriptsTask.test.ts` covers worker serialization, aborts, bounds, and failure fencing; `src/ts/translator/edittransRegex.test.ts` covers the client-only translation mode.
- Trigger and Lua runtime: `server/src/tests/triggerRuntime.test.ts` covers v2 effects, mode allowlists, aborts, and the job-wide effect limit; `server/src/tests/{luaRuntime,luaRuntimeCharge,luaBindings,luaBindingsFences}.test.ts` cover the Lua engine, budget, host, and cancellation. `server/src/tests/{commandExecutor,manualTriggers,commandRunner}.test.ts` cover command jobs, manual triggers, and forms; `server/src/tests/generations.test.ts` pins form-command validation.
- Send integration: `server/src/tests/promptRunner.test.ts` covers the server send's script stages with real Lua/regex workers, a plugin hook, and a fake provider. The chat-pipeline guide also routes this shared send test.
- Client job boundary: `src/ts/process/serverCommands.test.ts` covers job creation, following, and resume; `src/ts/process/command.test.ts` covers `/trigger` dispatch; `src/lib/ChatScreens/Chat.test.ts` covers form submission and click-to-edit behavior.
- Worker and write boundaries: `server/src/tests/{manualTriggerMetadata,chatMetadataCoalescing,chatResult,scriptWorker,scriptWorkerOptions}.test.ts` pin metadata batching, final trigger application, Lua host values, and worker limits.
- Gaps: v2 editor behavior and `Chat.svelte`'s trigger-id owner token are not directly tested.

## Known Hazards

- `src/lib/Playground/PlaygroundRegex.svelte` is empty; it is not an implemented regex playground.

- `triggercode` effects have no runtime case. Only `triggerlua` executes.
- The deprecated `v2ModifyLorebook`, `v2SetLorebookActivation`, and their reads address lore entries as arrays (`entry[0]`, `entry[2]`), but entries are objects: the first never matches, the second adds a junk `"2"` key (pre-existing; a separate task).
- Trigger and command runs are not atomic: each trigger effect and each mutating command is its own job write (a command pipeline rereads the chat before each command), so a later refused effect leaves the earlier writes committed, and a command's wait can expose an intermediate revision; only the final `applyTriggerChat` diff is one write.
- Trigger character effects write one patch per effect; a long run that writes a whole `globalLore` array from its starting copy overwrites lore edits made after that copy was taken.
- A regex script with `ableFlag` set whose action metadata leaves the flags empty runs with the legacy `g` flag.
- A Lua button ignores `stopSending`: `stopChat` marks the run but neither stops the later button triggers nor changes the `done` event, while the trigger runtime honors it.
- Job setters for `scriptstate` and `note` share a pending metadata write until a microtask or explicit flush; a yielded trigger or awaited command can split one run across writes. Another chat write flushes that batch first, so a refused message write cannot discard an earlier setter. A changed trigger copy can then write its whole `scriptstate` map and replace keys another command added during the run; the metadata write also advances the revision, so that trigger's reorder may be dropped. `server/src/tests/chatMetadataCoalescing.test.ts` pins the batching boundary.
- `v2Calculate` substitutes chat variables and calls the calculator directly, outside the CBS evaluator's cooperative work/time budget; expensive expressions can hold the server thread.
- With no request-trigger script the server still runs the request-trigger hook before each provider attempt; its empty result logs "Invalid return" each time, and the prompt is unchanged.
