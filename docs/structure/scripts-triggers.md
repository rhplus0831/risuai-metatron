# Regex Scripts, Triggers, Lua Scripting

## Scope

- Owns:
  - regex find/replace scripts (the shared engine and the editors),
  - triggers v2 and Lua (data model, editors, runtime semantics, and the regex worker),
  - the server's script entry points as the tab reaches them (Lua buttons, manual triggers, the script transform).
- Paths:
  - `shared/scripts/regex.ts`, `shared/triggers.ts`
  - `server/src/lua/*`, `server/src/scripts/*` (Lua runtime and regex worker)
  - `src/ts/process/regexFiles.ts`
  - `src/ts/process/serverCommands.ts`
  - `public/lua/json.lua` (read by the server's script workers)
  - `src/lib/SideBars/Scripts/*`
  - `src/lib/Playground/{PlaygroundSyntax,PlaygroundParser}.svelte`
  - `src/etc/docs/regex.cbs` (example script documentation)
- Not here:
  - Prompt adapters and job orchestration: `server/src/prompt/{scripts,triggers,commands}.ts` → `server-generation.md`.
  - `edittrans` regex application → `translation.md` (`translator.ts:applyEdittransRegex`, the one regex the tab still
    runs: plain `RegExp` replacement on translation text, no Lua or trigger).
  - Module-provided scripts are collected by `process/modules.ts` → `characters-modules.md`.

## Files

- `shared/scripts/regex.ts`: the regex engine (the server's workers run it).
  - `runRegexScripts(data, scripts, { mode, chatID, parse, repeatBackSource, applyEffect? })` returns
    `{ data, effects }`: flags, `<order n>` and the other `<...>` actions, the `@@` directives, and the script loop (a
    script that throws is skipped).
    - It writes nothing itself: `@@emo` and `@@inject` go to `applyEffect` where their script matched, inside that
      script's `try` (so a later script's CBS reads the write, and a throwing sink skips the rest of that script only),
      and are also returned as the ordered `effects` (`{ kind: "emotion", name }`, `{ kind: "inject", text }`).
    - `parse` is the run's CBS; ordinary replacements skip it only when the result is unchanged (`replaced === data`, so
      a match replacing with the same string counts too) and `isCbsPlainText` in `shared/cbs/evaluator.ts` finds no CBS
      constructs (`{{`, `{#`, or case-insensitive `<user>`/`<char>`/`<bot>`). Skipping that host parse also skips its
      CBS budget check; changed text and moved results still pass through CBS. This examines the current text, including
      constructs introduced by an earlier script.
    - `repeatBackSource` answers `@@repeat_back`'s previous message.
  - `RegexScriptMode` = `editinput|editoutput|editprocess|editdisplay`.
  - `regexScriptCacheKey` and `createScriptCache` (the final output, 1,000 entries).
- `regexFiles.ts`: `exportRegex`/`importRegex` for the regex editors; export without an explicit list falls back to the
  legacy `settings.globalscript` record.
- `shared/triggers.ts`: the trigger model (`triggerscript`, `triggerEffect` = `triggerCode | triggerEffectV2`, the
  `triggerV2*` effect types) and the allowlists `displayAllowList`/`requestAllowList` (with their side-effect-free
  subset; the server runtime and `TriggerV2List.svelte` both read them).
  - `triggerscript.conditions` is `unknown[]`, kept for shared-format compatibility with upstream readers. Newly created
    triggers write `[]`; imported arrays are preserved, and the runtime skips triggers with non-empty conditions.
- `serverCommands.ts`: the tab's side of a server command job (`runServerButton`, `runServerManualTrigger`, both
  returning the outcome) and of a send job (`runServerJob`), and the job follow (`followJobToEnd`, `resumeServerJobs`,
  and `readChatAgain`/`refreshChatAfterPush`, the chat read again for a viewed lost chat or a completion push).
  - `followedJobs` is the reactive registry of those follows by job id, with a chat key once known;
    `followedJobsOf(jobs, ref)` returns that chat's job ids.
  - A Lua button's or manual trigger's command job on the selected chat shows Stop, which aborts it from the chat
    screen.
- `SideBars/Scripts/RegexData.svelte`, `RegexList.svelte`: the regex editor. Flags are native `g/i/m/u/s` plus
  `<move_top>`, `<move_bottom>`, `<repeat_back>`, `<cbs>`, `<no_end_nl>`, `<order n>`.
- `SideBars/Scripts/TriggerList.svelte`: picks the editor mode (v2 or Lua). Any other non-empty list (legacy v1 data,
  `triggercode`) shows `triggerLegacyUnsupported` and is replaced when switching mode.
- `TriggerV2List.svelte`: the v2 editor.
  - `effectCategories`, `checkSupported`, `makeDefaultEditType`.
  - Block edit helpers: `deleteEffect`, `copyEffect`, `getInsertIndent`, `getBlockRange`.
  - Save-time `v2EndIndent` generation.

## Flows

The tab owns the editors and starts jobs. Lua and trigger effects execute on the server; the shared regex engine runs in
the server's script worker. The translator's `edittrans` regex is the client-side exception (`translation.md`).

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

- Persisted shapes: `customscript` is `{comment, in, out, type, flag?, ableFlag?}` (`shared/database.ts`); `type` is a
  free string. The UI also offers `edittrans` and `disabled`. Presets store active `presetRegex`; the legacy
  `globalscript` record is not an execution source or edited in the UI, though `regexFiles.ts` uses it as the default
  export list. Characters store `customscript`, `triggerscript`, and `lowLevelAccess`; modules store `regex`, `trigger`,
  and `lowLevelAccess`.
- Runtime variables are strings persisted as `chat.scriptstate['$'+key]`; display-mode triggers use temporary variables
  only.
- The tab starts command jobs and `/api/transform`; the server owns Lua, triggers, send-script stages, and request
  triggers. See [server-generation](server-generation.md) for job and host semantics, [cbs-rendering](cbs-rendering.md)
  for display transforms, and [LLM requests](llm-requests.md) for request timing.
- `runScriptTail` filters preset, character, and module scripts by `script.type === mode` before dispatch. With no
  matching regex scripts, it skips the regex worker but still applies dynamic assets and caches final output.
- The tab captures the target chat before flushing a command job. Chat-row forms prevent navigation, send string values
  (repeated names become arrays), and are capped at 64 KiB of JSON by the server.

## Coupling

- The tab's script entry points (`serverCommands.ts`, `transformClient.ts`) depend on the job channel, the chat module,
  and the save adapter's flush.
- UI owners:
  - Character regex and triggers: `CharConfig.svelte`.
  - `presetRegex`: `PromptPresetSettings.svelte`.
  - Module regex and triggers: `ModuleMenu.svelte`.

## Invariants

- Never rename the serialized discriminators: `customscript.type`, `triggerscript.type`, effect `type`, v2 `indent`, the
  header at index 0.
- Regex order matters. `<order n>` applies only when `ableFlag` is true. Native flags are sanitized to `dgimsuvy`,
  deduplicated, and default to `u`.
- The cache stores final output, not compiled `RegExp` objects. An empty-string result is falsy and therefore never
  cache-hits.
- Display and request modes silently skip effects missing from `displayAllowList`/`requestAllowList`. The editor's
  `checkSupported` reads the same lists (`shared/triggers.ts`).
- Low-level effects are gated twice: filtered in the UI and checked at runtime via `trigger.lowLevelAccess`. Lua edit
  hooks always run with `lowLevelAccess:false`.
- The server trigger runtime checks job cancellation during execution and enforces a 100,000-effect limit across nested
  triggers in the job. It yields after 50 ms of effect work so pending I/O and abort callbacks can run; a privileged
  recursive trigger is ended by the shared limit, not the JavaScript stack.
- A trigger effect or Lua function that changes a character writes one field of the run's character; never the selected
  index or the whole working copy.
- v2 block edits must preserve paired `v2EndIndent` entries and indentation.
- Lua `request` restrictions (`server/src/lua/egress.ts`): HTTPS only, URL at most 120 characters, the three banned Risu
  prefixes, no `localhost` and only public addresses, 30 requests per minute per server, a 10 s timeout and a 2 MB
  answer; it requires low-level access.
- Lua character getters return `""` when the run has no resolvable character, and the stored value (possibly
  `undefined`) for a resolvable one; character setters return without writing when no character resolves.
- Lua `setDescription` refuses a non-string value ("Invalid data type") and writes nothing.
- Lua `getLoreBooksMain` searches the chat's `localLore`, the character's `globalLore` with the chat's `loreOverrides`
  applied (`mergeOwnerLore`, [chat pipeline](chat-pipeline.md)), and the chat's module lore; `upsertLocalLoreBookMain`
  writes `localLore` only. Trigger v2 lore effects read and write the raw character lore.
- Trigger character effects warn and skip a gone character; a patch the store refuses is a fatal failure that ends the
  job (`LuaJobFatalError`, `server/src/lua/bindings.ts`); `v2SetLorebookActivation` warns and changes nothing for a
  non-integer, negative, or missing lore index.
- Lua `request(id, url)` returns `nil` at once, without any egress, when `id` has no low-level access.
- `logMain` passes its text through as is; the Lua `log` wrapper JSON-encodes its value before calling it.

## Recipes

- Add a regex mode: extend `RegexScriptMode` (`shared/scripts/regex.ts`), wire its caller on the server, add the UI
  option in `RegexData.svelte`, and update `translator.ts:applyEdittransRegex` if the mode is translation-only.
- Add a regex flag: add it to the UI in `RegexData.svelte`, parse the `<...>` metadata in `parseScripts` and implement
  it in `executeScript` (both in `shared/scripts/regex.ts`, strict-checked by the server `tsc`), and add the translator
  equivalent if needed.
- Add a v2 effect:
  1. Add the type and union member in `shared/triggers.ts`.
  2. Update `effectCategories`, `checkSupported`, and `makeDefaultEditType` in `TriggerV2List.svelte`.
  3. Add the field editor branch.
  4. Add a case to the server runtime (`server/src/prompt/triggers.ts`).
  5. Update the allowlists (`shared/triggers.ts`) if the effect should run in display or request mode.
  6. Add the `triggerDesc` language key in `src/lang/en.ts`.
- Add a block-type v2 effect: also update `deleteEffect`, `copyEffect`, `getInsertIndent`, `getBlockRange`, and the
  save-time `v2EndIndent` generation.
- Add a Lua API: the server bindings (`server/src/lua/bindings.ts`, with the guard of its provenance), plus the prelude
  wrapper in `server/src/lua/runtime.ts` if it is async or JSON-based. Add a case to
  `server/src/tests/luaBindings.test.ts` (the name contract).

## Tests

- Regex engine: `server/src/tests/regex.test.ts` covers parsing, mode and order rules, effects, and final-output
  caching. `server/src/tests/regexScriptsTask.test.ts` covers worker serialization, aborts, bounds, and failure fencing;
  `src/ts/translator/edittransRegex.test.ts` covers the client-only translation mode.
- Trigger and Lua runtime: `server/src/tests/triggerRuntime.test.ts` covers v2 effects, mode allowlists, aborts, and the
  job-wide effect limit; `server/src/tests/{luaRuntime,luaRuntimeCharge,luaBindings,luaBindingsFences}.test.ts` cover
  the Lua engine, budget, host, and cancellation.
  `server/src/tests/{commandExecutor,manualTriggers,commandRunner}.test.ts` cover command jobs, manual triggers, and
  forms; `server/src/tests/generations.test.ts` pins form-command validation.
- Send integration: `server/src/tests/promptRunner.test.ts` covers the server send's script stages with real Lua/regex
  workers, a plugin hook, and a fake provider. The chat-pipeline guide also routes this shared send test.
- Client job boundary: `src/ts/process/serverCommands.test.ts` covers job creation, following, and resume;
  `src/ts/process/command.test.ts` covers `/trigger` dispatch; `src/lib/ChatScreens/Chat.test.ts` covers form submission
  and click-to-edit behavior.
- Worker and write boundaries:
  `server/src/tests/{manualTriggerMetadata,chatMetadataCoalescing,chatResult,scriptWorker,scriptWorkerOptions}.test.ts`
  pin metadata batching, final trigger application, Lua host values, and worker limits.
- Gaps: v2 editor behavior and `Chat.svelte`'s trigger-id owner token are not directly tested.

## Known Hazards

### Issues

- The deprecated `v2ModifyLorebook`, `v2SetLorebookActivation`, and their reads address lore entries as arrays
  (`entry[0]`, `entry[2]`), but entries are objects: the first never matches, the second adds a junk `"2"` key
  (pre-existing; a separate task).
- Trigger and command runs are not atomic: each trigger effect and each mutating command is its own job write (a command
  pipeline rereads the chat before each command), so a later refused effect leaves the earlier writes committed, and a
  command's wait can expose an intermediate revision; only the final `applyTriggerChat` diff is one write.
- Trigger character effects write one patch per effect; a long run that writes a whole `globalLore` array from its
  starting copy overwrites lore edits made after that copy was taken.
- A regex script with `ableFlag` set whose action metadata leaves the flags empty runs with the legacy `g` flag.
  `server/src/tests/regex.test.ts` pins it as a quirk.
- A Lua button ignores `stopSending`: `stopChat` marks the run but neither stops the later button triggers nor changes
  the `done` event, while the trigger runtime honors it.
- `v2Calculate` substitutes chat variables and calls the calculator directly, outside the CBS evaluator's cooperative
  work/time budget; expensive expressions can hold the server thread.

### Limitations

- `triggercode` effects have no runtime case. Only `triggerlua` executes. Decision: `triggercode` is legacy and
  unsupported (`TriggerList.svelte`, Files above).

### Gotchas

- `src/lib/Playground/PlaygroundRegex.svelte` is empty; it is not an implemented regex playground.
- Job setters for `scriptstate` and `note` share a pending metadata write until a microtask or explicit flush; a yielded
  trigger or awaited command can split one run across writes. Another chat write flushes that batch first, so a refused
  message write cannot discard an earlier setter.
  - The final `applyTriggerChat` write reconciles the map fields (`CHAT_META_MERGE_KEYS`: `scriptstate`,
    `GLGlobalVariables`, `toolCalls`, `bookmarkNames`) entry by entry against the trigger's baseline
    (`meta.merge`/`mergeUnset`), so a variable another command or tab saved during the run survives and the trigger's
    final value wins only for keys it changed; a key the trigger changed and then restored to its baseline value is not
    written, so a concurrent value of that key stays.
  - The metadata write also advances the revision, so that trigger's reorder may be dropped.
  - `server/src/tests/chatMetadataCoalescing.test.ts` pins the batching boundary.
