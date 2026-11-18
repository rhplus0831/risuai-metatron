# Regex Scripts, Triggers, Lua Scripting

## Scope

This guide owns the shared regex engine, trigger and Lua semantics, their editors and the jobs that chat buttons, forms
and manual triggers start. For prompt orchestration and request hooks, follow [server generation](server-generation.md).
[CBS rendering](cbs-rendering.md#display-transform) owns the tab side of display transforms.
[Translation](translation.md) owns the browser’s `applyEdittransRegex`, and
[characters and modules](characters-modules.md) owns collection of enabled module scripts. The author examples are in
`src/etc/docs/regex.cbs`.

## Files

Each module's contract is its header comment (a Svelte component's, the JSDoc block at the top of its `<script>`).

- `shared/scripts/regex.ts`: the regex engine the server's script workers run. `runRegexScripts` (flags, `<order n>`,
  the `@@` directives, the CBS skip rule), `RegexScriptRun` (`parse`, `repeatBackSource`, `applyEffect`),
  `RegexScriptEffect`, `RegexScriptMode`, `regexScriptCacheKey`, `createScriptCache`.
- `shared/triggers.ts`: the trigger model and the v2 layout. `triggerscript` (`conditions`), `triggerEffect` =
  `triggerCode | triggerEffectV2`, the `triggerV2*` effect types (`v2Header`, `v2Else`, `v2EndIndent`, `endOfLoop`),
  `displayAllowList`/`requestAllowList` over `safeSubset`. The runtime that executes them is
  `server/src/prompt/triggers.ts` ([server-generation](server-generation.md)).
- `server/src/scripts/workerPool.ts`: the script worker pool (`createScriptWorkerPool`, `createLuaBudget`,
  `resolveJsonLuaPath`, the `MAX_*` bounds). `server/src/scripts/worker.ts`: one worker (`REGEX_SCRIPTS_MODE`,
  `RegexScriptsInput`, `runRegexOp`, `RegexOp`). `server/src/scripts/smoke.ts`: the pool's smoke checks.
  `public/lua/json.lua`: the JSON library the workers load.
- `server/src/lua/runtime.ts`: the Lua engine in a worker (`createLuaRuntime`, `LUA_PRELUDE`, `declareBuiltins`).
  `server/src/lua/bindings.ts`: a job's Lua and trigger host functions (`createLuaBindings`, `LuaJobFatalError`).
  `server/src/lua/egress.ts` guards Lua `request` (`serverLuaRequest`, `validateEgressUrl`). For a wasmoon upgrade,
  check both private API consumers in the runtime, `installValueGuard` and `installHook`.
- `src/ts/process/regexFiles.ts`: `exportRegex`/`importRegex` for the regex editors.
- `src/ts/process/serverCommands.ts`: the tab's side of command and send jobs and their follow. `runServerButton`,
  `runServerManualTrigger`, `runServerJob`, `followJobToEnd`. See [job recovery](network-jobs.md#job-recovery) for
  follows, resume and push refreshes.
- `src/lib/SideBars/Scripts/RegexData.svelte`, `src/lib/SideBars/Scripts/RegexList.svelte`: the regex editor.
- `src/lib/SideBars/Scripts/TriggerList.svelte`: picks the editor mode (v2 or Lua); `triggerLegacyUnsupported`.
- `src/lib/SideBars/Scripts/TriggerV2List.svelte`: the v2 editor. `effectCategories`, `checkSupported`,
  `makeDefaultEditType`, and the block helpers `deleteEffect`, `copyEffect`, `getInsertIndent`, `getBlockRange`.
- `src/lib/SideBars/Scripts/triggerEffectDisplay.ts`: the v2 effect list's summary markup (`formatEffectDisplay`, given
  the editor's `checkSupported` answer) and its drag-preview text (`effectDisplayText`).
- `src/lib/Playground/PlaygroundSyntax.svelte`, `src/lib/Playground/PlaygroundParser.svelte`: the CBS and
  `ParseMarkdown` playgrounds.

## Flows

The tab owns the editors and starts jobs. Lua and trigger effects execute on the server; the shared regex engine runs in
the server's script worker. The translator's `edittrans` regex is the client-side exception (`translation.md`).

| Hook                                                               | Where                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| the `input` trigger, then `editinput`                              | the send job's input stage (`server/src/prompt/runner.ts`) |
| `start` trigger, `editprocess`, `editoutput`, `output` trigger     | the send job (`assemblePrompt`, the tail)                  |
| `editdisplay` (Lua `editDisplay`, the display trigger, CBS, regex) | `/api/transform` (`ParseMarkdown`, `transformClient.ts`)   |
| the `request` trigger                                              | a server job's requests, each attempt (`runSetup.ts`)      |
| `manual` trigger                                                   | a `command` job (`runServerManualTrigger`)                 |
| Lua `onButtonClick`                                                | a `command` job (`runServerButton`)                        |
| Lua `onFormSubmit`                                                 | a `command` job (`Chat.svelte` `handleFormTriggerWithin`)  |

The tab's own LLM requests (translation, suggestions, the HypaV3 modal, plugins) run no `request` trigger, nor does a
group chat's job (`setRequestTrigger` in `server/src/jobs/runSetup.ts`).

A command job of a Lua button or manual trigger on the selected chat shows Stop in
`src/lib/ChatScreens/DefaultChatScreen.svelte`: `followedJobsOf` makes it stoppable and `abortChat` aborts it
(`abortGenerationJob`); `stopChatJob` is the button for a job another tab started.

## State

- Persisted shapes: `customscript` is `{comment, in, out, type, flag?, ableFlag?}` (`shared/database.ts`); `type` is a
  free string. The UI also offers `edittrans` and `disabled`. Presets store active `presetRegex`; the legacy
  `globalscript` record is not an execution source or edited in the UI, though `regexFiles.ts` uses it as the default
  export list. Characters store `customscript`, `triggerscript`, and `lowLevelAccess`; modules store `regex`, `trigger`,
  and `lowLevelAccess`.
- Runtime variables live in `chat.scriptstate['$'+key]`. Readers return text, while Lua setters preserve raw finite
  numbers and booleans. V2 setters in display and request mode keep their changes in temporary variables. A reroll in
  place restores what its previous reply set, unless changed since; a failed one undoes its own writes
  ([server generation](server-generation.md#reroll-in-place)).
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
- Regex order matters. `<order n>` and `<cbs>` (cache key too) apply only when `ableFlag` is true. Native flags are
  sanitized to `dgimsuvy`, deduplicated, and default to `u`.
- The cache stores final output, not compiled `RegExp` objects. An empty-string result is falsy, so never cache-hits.
- Display and request modes silently skip effects missing from `displayAllowList`/`requestAllowList`. The editor's
  `checkSupported` reads the same lists (`shared/triggers.ts`).
- Low-level effects are filtered in the UI and checked at runtime via `trigger.lowLevelAccess`, derived from the owning
  character or module rather than the stored trigger's claim. Lua edit hooks always run with `lowLevelAccess:false`.
- Without the initiating owner's grant, `v2Command` consumes `/multisend` and `/speak` without provider work while
  ordinary piped commands still run.
- `v2SetPersonaDesc` requires that grant to write the effective shared persona and belongs in the editor's Low Level
  palette; `v2GetPersonaDesc` stays in Data.
- Without the owner's grant, Lua `getTokens`, `v2Tokenize`, `/test_lorebook`, and trigger-added system-prompt slots use
  the model's local counting fallback without changing settings. Mixed or unknown slot provenance stays local across
  nested runs.
- Trigger mode changes and V2 imports capture the editor owner and backing-list identity before waiting, cancelling on
  owner/list replacement or editor destruction.
- Regex deletion captures owner and row identity before confirmation and resolves that row again before removal; preset
  imports parse a detached list and apply only while the captured owner/list remains current.
- The server trigger runtime checks job cancellation during execution and enforces a 100,000-effect limit across nested
  triggers in the job. It yields after 50 ms of effect work so pending I/O and abort callbacks can run; a privileged
  recursive trigger is ended by the shared limit, not the JavaScript stack.
- Lua's chat getters give each message its `id`. `setFullChat` (`fullChatMessages`, `server/src/lua/bindings.ts`) keeps
  the message an item's `id` names and lays role and text over it, as `setChat` does; an item without a usable `id`
  keeps the stored message at its position when role and text are equal and is a new message otherwise; a message the
  list leaves out is removed. The live chat and a trigger's working copy follow the same rule.
- A trigger effect or Lua function that changes a character writes one field of the run's character; never the selected
  index or the whole working copy. A lore effect writes one `globalLore` entry (`GlobalLoreChange`, applied to the
  current record inside each revision-checked write: by `id`, or by index with an unchanged-value check for legacy
  entries without one), so another writer's edit to a different entry survives the run.
- v2 block edits must preserve paired `v2EndIndent` entries and indentation.
- The v2 effect list renders its summaries as HTML: every stored effect value, and a `type` shown without a language
  description, is HTML-escaped there, and `indent` is written as a number (`0` when it is not one). Only the language
  description templates are trusted markup; an imported card's or module's trigger is not.
- Keep Lua network requests behind the owner's low-level grant. `createLuaBindings` returns Lua `nil` on a refused
  `request(id, url)` before any network call. `server/src/lua/egress.ts` owns URL admission, address pinning and the
  rate, time and response-size bounds.
- Lua values cross a typed store boundary. `server/src/lua/bindings.ts` (`createLuaBindings`) and
  `server/src/tests/luaBindings.test.ts` own each getter's missing-character and access results, setter value types, and
  conversion of non-finite numbers. Trigger variable serialization and lore insert order are in
  `server/src/prompt/triggers.ts`.

- During rerolls, Lua getters and indexed setters share the carrier-hidden history view; setters write by message id,
  and insertions beside the carrier anchor as trigger insertions do. The server slash commands `/comment`, `/cut` and
  `/del` resolve "last" and indexes through the same view (`CommandHost.historyMessages`), so the carrier is never their
  target.
- Lua `getLoreBooksMain` searches the chat's `localLore`, the character's `globalLore` with the chat's `loreOverrides`
  applied (`mergeOwnerLore`, [chat pipeline](chat-pipeline.md)), and the chat's module lore; `upsertLocalLoreBookMain`
  writes `localLore` only. Trigger v2 lore effects read and write the raw character lore.
- Trigger character effects warn and skip a gone character, and a lore effect whose target entry is gone, duplicated, or
  (without an id) changed; a patch the store refuses is a fatal failure that ends the job (`LuaJobFatalError`,
  `server/src/lua/bindings.ts`); `v2SetLorebookActivation` warns and changes nothing for a non-integer, negative, or
  missing lore index.
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

- Regex and the worker boundary run with
  `pnpm --silent test:agent server/src/tests/{regex,regexScriptsTask,scriptWorker,scriptWorkerOptions}.test.ts src/ts/translator/edittransRegex.test.ts`.
- For triggers, permissions, Lua and command dispatch, use
  `pnpm --silent test:agent server/src/tests/{triggerRuntime,luaRuntime,luaRuntimeCharge,luaBindings,luaBindingsFences,commandExecutor,manualTriggers,commandRunner,commandSequences}.test.ts`.
  For form admission use `server/src/tests/generations.test.ts`.
- For trigger writes use `server/src/tests/{manualTriggerMetadata,chatMetadataCoalescing,chatResult}.test.ts`.
  `server/src/tests/promptRunner.test.ts` runs an end-to-end send through real Lua and regex workers with a fake
  provider and a plugin hook.
- For the editors and tab dispatch run
  `pnpm --silent test:agent src/lib/SideBars/Scripts src/ts/process/{command,serverCommands}.test.ts src/lib/ChatScreens/Chat.test.ts`.
  The rendered display integration runs in `e2e/transformGolden.spec.ts` and `e2e/serverTransform.spec.ts`.
- Some worker, Lua, trigger and prompt cases are slow. Use `pnpm --silent test:agent --all <file>` for an affected file
  and see the [slow-test table](test-harness.md#slow-test-table) for membership.
- Not tested: most v2 block-editor interactions, the chat row's trigger-id owner token, and following a command job
  after `runPinnedServerJob`'s `onStart` callback throws.

## Known Hazards

### Limitations

- `triggercode` effects have no runtime case. Only `triggerlua` executes. Decision: `triggercode` is legacy and
  unsupported (`TriggerList.svelte`, Files above).
- Trigger and command runs are not atomic: character/lore writes and mutating commands can commit before the run ends;
  `scriptstate` and `note` setters batch, while message effects edit a working copy applied by `applyTriggerChat` in one
  atomic write. A command pipeline rereads the chat before each command, and waits can expose intermediate revisions.
  See `server/src/jobs/chatResult.ts:applyTriggerChat`. Decision: owner, 2026-11-10 (known-issues review): no
  transaction or rollback policy is wanted.
- That working copy is applied at the trigger's end and before each slash command the trigger runs; after the command
  the copy and its baseline are read again from storage (`runOnCopy`, `server/src/jobs/runSetup.ts`). A command's write
  is therefore not replayed over, a later setter of the trigger still wins, and a message the trigger appends after a
  command follows the command's messages.
- A regex script with `ableFlag` set whose action metadata leaves the flags empty runs with the legacy `g` flag.
  `server/src/tests/regex.test.ts` pins it as a quirk. Decision: owner, 2026-11-10 (known-issues review): compatibility
  with existing cards.
- `v2Calculate` substitutes chat variables and calls the calculator directly, outside the CBS evaluator's cooperative
  work/time budget; expensive expressions can hold the server thread. Decision: owner, 2026-11-10 (known-issues review):
  isolation would be designed with the server CBS thread (server-generation).

### Gotchas

- In `server/src/tests/scriptWorker.test.ts`, the gated `summed across them` and `right after a resumption` cases can
  exhaust their Lua budget under load before exercising their intended distinction; a passing gate alone does not prove
  those distinctions. `luaRuntimeCharge.test.ts` checks summation with a controlled clock.
- `src/ts/process/serverCommands.ts` `followJobToEnd` accepts the terminal result even when a resumed reply is already
  present and streaming; successful completion need not increase the message count, so recovery must not use that count
  as its success check.
- `src/lib/Playground/PlaygroundRegex.svelte` is empty; it is not an implemented regex playground.
- Job `scriptstate` and `note` setters batch until a microtask or explicit flush; yielding or awaiting can split writes.
  Other chat writes flush first, so their refusal preserves earlier setters.
  - `applyTriggerChat` merges map fields from `shared/chats.ts` (`CHAT_META_MERGE_KEYS`, including `oocLog`) against the
    trigger baseline via `meta.merge`/`mergeUnset`. Only changed entries win over concurrent writes.
  - The metadata write also advances the revision, so that trigger's reorder may be dropped.
  - `server/src/tests/chatMetadataCoalescing.test.ts` pins the batching boundary.
