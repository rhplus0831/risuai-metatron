# Phase 4 implementation plan (Opus, final)

Written 2026-09-30 at `e9e608ad` (Phase 3 closed), after a plan review by GPT-6-Astra (A1 to A27)
and an evaluation of the draft and that review by Claude Fable (its additions F-a to F-i). The
slice files in this folder stay canonical for content; this file records how they are executed
and the amendments to them. Where this file and a slice disagree, this file wins until the slice
is updated in the same change as its implementation.

## Goal

Implement [`phase-4-external-contracts.md`](../../phase-4-external-contracts.md): the client
mutation modules (characters, the settings sections and collections, presets, plugin storage)
and every external contract re-pointed at them: the plugin API v3 host setters, a per-plugin call
context for hooks, the MCP RisuAccess writers, the Lua character setters, the trigger character
effects, and the import paths. No plugin-visible API shape or permission changes. No server
route, kind, or table changes.

## Baseline

The slices were drafted at `577c43ae`, before Phase 3 was built. A Luna fan-out (eight workers,
one per slice, `xhigh`) re-verified every identifier and assumption at `e9e608ad`, and Astra and
Fable checked the result. Line numbers drifted everywhere; each slice's Identifiers paragraph is
re-derived during its implementation. The substantive drift:

- **The forwarding spike held.** Every "under Phase 3's fallback" branch is void: no
  `SelectedPreset` or `SelectedPersona` projection exists. The plugin `getDatabase` reads the
  forwarded keys through the accessors (`$state.snapshot(db[key])`).
- **Phase 3 already changed the plugin setters** (`v3.svelte.ts`):
  - `normalizedPluginPersonas` applies the shared `normalizePersonas` contract, and a non-list is
    refused.
  - `pluginKeyOrder` applies `selectedPersona` last.
  - `assignPluginField` warns about and keeps a `null` or `undefined` for a server-normalized
    field; any other value is stored and the server repairs it.
  - `setPluginDatabase` awaits the install prompt before it assigns anything.
  - `setDatabase(db)` still ends the full setter and re-runs `normalizePresets` and
    `normalizePersonas` over the live lists.
- **`statics` is its own collection**, not a `ui` field.
- **`reconcileSelection`** lives in `forwarding.svelte.ts`.
- **`checkCharOrder` is still in `globalApi.svelte.ts`.** The storage layer is not isolated from
  the app graph: `database.svelte.ts` and `exportAsDataset.ts` import `globalApi.svelte.ts`, and
  `stores.svelte.ts` imports `process/modules` and `process/scripts` and touches `window` at
  module initialization.
- **The server normalizes every batch operation before storing it** (`resourceStore.ts`
  `applyChanges`); the client records the text it submitted. A value that is valid in kind but
  not canonical stays different in the mirror until reload. Phase 3 accepted this ("a cleared
  number field comes back as its default after a reload").
- **81 section fields have no default** and start absent (`normalizeSection` leaves them out).
  Among them are `guiHTML`, `seperateModels`, `seperateModelsForAxModels`, and
  `googleSearchCredentials`, which Phase 4's writers set.
- **Phase 5's `job-channel.md` already assumes the Phase 4 context handoff** (lines 101-105).
- **`importPreset` pushes into the presets list directly** (three sites in
  `database.svelte.ts`), reached from the card URL import and the drop handler. No slice covered
  it.
- **Display and request trigger runs get the live character**, not a clone (`triggers.ts:130`
  clones only normal runs), and the lore effects edit `char.globalLore` in place. Slice 6's
  "display and request runs write nothing" is false today (F-b).
- **The closeout allowlist is stale.** The rooted discovery grep answers 377 hits in 56 files
  when storage and test files are excluded (106 in 23 `src/ts` files, 271 in 33 `src/lib`
  files). The `cipherChat` entry is dead (Phase 3 dropped the field). `requests.ts:459` is a
  false positive in a type position. The `db2` token writes in `google.ts` escape the pattern.
- **The phase file has none of the planning-notes edits applied.**
- **Defects found in passing:**
  - `scriptings.ts` reuses engines across runs, so the `char` a run captured goes stale in
    `generateImage` and in `upsertLocalLoreBook`'s type check.
  - The engine cleanup never removes `ScriptingEditDisplayIds` keys.
  - `importChat` resolves its target after the file dialog, and reads the selection throughout.
  - `modules.ts` has a third `@ts-ignore` (the Lua tool).

## Order and stops

```
step 0 phase file ─→ 1 ─→ [stop A] → 2 → 3 → [stop B] → 4 → 5 → 6 → 7 → 8 [stop C]
```

- **Step 0** applies the phase-file edits with your answers to the owner questions. Docs only,
  committed together with this plan.
- **Stop A** comes after slice 1: the mutation API every later slice is written against.
- **Stop B** comes after slice 3: the plugin-visible behavior changes (routing, call context).
- **Stop C** is the closeout.
- Between stops I report and continue. A problem found by a review, or a slice stopping
  condition, is always a stop (`CLAUDE.local.md`).
- Slices 2 to 7 could run in parallel after slice 1. They run one after another here (one
  implementer, one tree). Slice 3 follows slice 2 in the same file.

## Workflow per slice

Approved by the owner on 2026-09-30.

The Phase 3 exception, proposed again, for the same reason: slices 2, 3, 5, 6, and 7 invalidate
tests on purpose.

- **Tests.** A Fable test-adapter per slice adapts exactly the tests I list as deliberately
  invalidated, each with a reason. Assertion changes and harness changes are listed separately.
  Then the Fable reviewer reviews the diff and the adaptations and writes the new tests. I edit
  no tests.
- **Reviews.** Slices 1 to 7 each get an Astra challenge (in one open session) and a Fable
  review. Slice 8 gets a challenge only, plus a Fable review if the closeout finds a test gap.
- **Commits.** One commit per slice, after its challenge and review.
- **Checks.** Per slice: `pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`,
  `pnpm test:e2e`. Manual checks run through Playwright scripts in the scratchpad (tools, not
  specs).
- **No Docker smoke.** The phase changes no server code, route, kind, or image. The closeout
  adds one check of the built client served by the self-host server (open, send, reload), since
  e2e runs on Vite's dev server.

## Step 0: phase-file edits and owner questions

The phase file gets the drift edits of [`planning-notes.md`](planning-notes.md), items 1 to 16,
updated to `e9e608ad`:

- **Name the missing writers:**
  - the plugin argument and theme setters, `importPlugin`, `SafeLocalPluginStorage`, and
    `checkCharOrder`;
  - the three MCP writers outside `risuaccess/`;
  - the four Lua setters, in place of `upsertLocalLoreBook`;
  - the eight trigger effects;
  - `importPreset`.
- **Mark what is already done:** the snapshot getters, `setChatToIndex`, `exportChar`,
  `importChat`'s chats, `v2SetVar`, and `v2SetAuthorNote`. Write `applyChatResult` for
  `replaceChat`.
- **Move the CBS item** to Phase 5's `cbs-and-regex-services`.
- **Safety contract:** "an archive produced with the supported schema version (since Phase 3)
  still restores".
- **Exit criterion 1:** the function-level audit, with the allowlist Phase 6 inherits.
- **Invariant 2:** add the sentence that only `pluginStorage` switches to explicit mutations.
- **Docs list:** the closeout's list.
- **Plugin work:** add the call context and the mutation scope.
- **Objective:** the settings-UI import handlers (translator, HypaV3, theme, regex, preset
  buttons) are Phase 6's, not Phase 4's.

Owner questions, with my recommendation; Astra and Fable agree on all three. The owner accepted
all three recommendations on 2026-09-30:

1. **`pluginStorage` switches to explicit mutations** in Phase 4, with its watcher deleted by
   slice 2. Recommended: **accept**. Every writer is contract code, and boot cleanup is covered
   by the boot marks.
2. **The plugin call context is set in the client hook runners now.** Recommended: **now**.
   Phase 5 already assumes it, and it fixes a real wrong-target write: a `chatOutput` listener's
   `setCharacter` after the user switched characters mid-send.
3. **MCP `getCharacter` returns a `DeepReadonly` view** instead of a `$state.snapshot`.
   Recommended: **accept**. A snapshot copies every chat on each tool call. Modules get the same
   through `findModule`.

## Amendments to the slices

### Slice 1 (`character-and-collection-mutations`)

- **`updateSettings(patch, { presetId? })`** (A2, A3, A4).
  - Section keys always go to their own section.
  - Forwarded preset keys go through a new `forwarding.svelte.ts` export,
    `writePresetField(db, presetId, rootKey, value)`. It is restricted to
    `FORWARDED_PRESET_KEYS` and applies `PRESET_ROOT_ALIASES`. The target is
    `options.presetId ?? selection.presetId`, and a target that names no preset throws
    `MutationTargetGoneError`. The accessor is never used for a mutation, so nothing is dropped
    silently.
  - Preset existence is checked only when the patch has a forwarded key.
  - Every key is validated before any is applied.
  - `forwarding.svelte.ts` joins the allowed files.
- **Accepted keys:** `SECTION_FIELDS` of `providers`, `ui`, `memoryTranslateMedia`, and
  `secrets`, plus `FORWARDED_PRESET_KEYS`. Refused: the `llmSecrets` fields and `proxyKey`, the
  persona keys (use `updatePersona`), and the selection keys (use `selectPreset` and
  `selectPersona`). `readSetting` is dropped.
- **Validation** (A1, A5, A6, A7). Section fields get no kind check: they are checked for JSON
  serializability, a `null` or `undefined` is refused, and anything else is stored for the server
  to repair (Phase 3's rule). Forwarded preset fields are checked against `PRESET_FIELD_KINDS`;
  `null` is accepted only for `PRESET_NULLABLE_FIELDS`, and `undefined` is refused everywhere.
  Collection elements:
  - A character needs to be an object with a string `chaId` (one is assigned when it is
    missing). `type`, when present, must be `"character"` or `"group"`; `name` is not required.
  - A module or persona needs to be an object; a missing id is assigned.

  Two lines of the slice are deleted: "never the mirror left different from the server", and the
  stopping condition's equality clause. A kind-valid but non-canonical value stays different in
  the mirror until reload; this is recorded. No shared field-kind tables are added (Astra's
  alternative, scope creep here).

- **Personas** (A8).
  - `setPersonas(list)` refuses a non-list, then applies `normalizePersonas(plainClone(list))`
    (`normalizedPluginPersonas` moves here), then `reconcileSelection`.
  - `addPersona` applies the same per-entry rules.
  - `updatePersona(id, patch)` refuses `id` in the patch and throws `MutationTargetGoneError` for
    a missing target.
  - The JSON check runs before `plainClone`, which silently drops values.
- **`addPreset(preset)`** (A24): `normalizePreset(plainClone(preset), { id })` with a fresh id,
  then a push. The `proxyKey` secret stays at the call site.
- **`incrementStatic(name)`** (A9): reads `statics` and writes it back with `name` raised by
  one (a missing or non-finite counter counts as 0, the server's rule) and the other counter
  kept. It is a whole-record write subject to conflict discard, not an atomic counter.

- **`checkCharOrder` moves to `src/ts/storage/characterOrder.ts`** unchanged in behavior, with a
  re-export from `globalApi.svelte.ts` (A10, A11). Its benefit is that the character module
  gains no direct `globalApi` import. The review test that imports the module under Node is
  dropped. Slice 7's "idempotent" wording becomes "a second call only finishes the first's
  cleanup".
- **Mutation scope** (A12): `beginMutationScope()` returns
  `{ resource: discardSequence, chat: chatDiscardSequence() }`, and `flushResources({ scope })`
  uses both as its watermarks. It is documented as a conservative time-window check: an
  unrelated discard in the window also fails the callback. It does not attribute discards to
  callbacks.
- **The character drift check is dropped from Phase 4** (A13). As designed, every conflict
  reload of a non-selected character would log a false "not saved".
- **Integration check** (A26): slice 1 has callers once `setCurrentCharacter` and
  `setCharacterByIndex` delegate, so it gets one smoke: open a character, edit it, reload.

### Slice 2 (`plugin-host-setters`)

- **Routing replaces `assignPluginField` and `normalizedPluginPersonas`** (A14).
  `pluginKeyOrder` and the install-prompt-first order stay.
  - Each settings key goes through its own `updateSettings({ [key]: value })` call.
  - The whole `characters` or `plugins` value is preflighted before any mutation for that key.
  - A `MutationValidationError` is caught per key and warned, and the mirror keeps its previous
    value. `MutationTargetGoneError` and unexpected errors propagate.
  - This replaces the slice's "the error reaches the plugin" (Phase 3's precedent; a throw is a
    failure mode plugins never saw from `setDatabase`). Recorded: a malformed preset-field value
    is now refused and warned about; section values are unchanged (the server repairs them).
- **`setDatabase(db)` goes from the full setter.** `markCharactersDirty("all")` and
  `DBState.db = db` go from both setters.
- **Plugin storage** (A16). Each boundary keeps its own contract: v3 `pluginStorage.setItem`
  normalizes through a JSON round trip, and `SafeLocalPluginStorage` throws `TypeError` for
  non-JSON with `undefined` becoming `null`. Each then calls the store module, whose check is a
  backstop. Detached reads and own `__proto__` keys are kept. `setDatabase`'s `_coldplugin`
  deletion runs only at boot and restore, which the boot marks cover; it is classified, not
  routed.
- **`replaceCharacterAt` keeps** the generating-character guard and the duplicate-id refusal
  (F-f).
- **Tests** (A15, F-g).
  - Assertion changes: `hostApi.test.ts:169`, `:231`, and `:243` (the normalizer call) and
    `:236-244` (a residual key defaulted by `setDatabase`).
  - Harness changes: the `database.svelte` mock (`:39-54`) and `pluginStorage.test.ts`'s
    plain-object `getDatabase` (the store writes `DBState.db`).
  - Preserved: the persona cases (`:141-170`, both setters), `:246-255`, `:341-354`, `:466`,
    `v3SetDatabase.test.ts`, and `v3SetPersonas.test.ts`.

### Slice 3 (`plugin-call-context`)

- **Capture points** (A18). The send captures where `chatTarget` is set, after `presetChain`.
  `requestChatData` captures once at entry, for both replacer loops and `requestPlugin`.
  `runChatOutputListeners` and `processScriptFull` capture at entry. A host call inside a hook
  reuses the hook's context.
- **Providers** (A17): the outer provider wrapper in `makeRisuaiAPIV3` takes the handoff before
  its permission await.
- **Reads before awaits** (F-a): every host function reads `currentContext(plugin.name)` on its
  first line, before any await (`getDatabase`'s permission prompt, `sendChat`, the install
  prompt), and threads it through.
- **Lifecycle** (A19).
  - `invokeHook` restores the handoff slot in `finally`.
  - The wrapper pushes before any await and pops in `finally`.
  - The wrapper cache is a `WeakMap` keyed by plugin instance and function, so removal keeps
    working.
  - Unloading a plugin clears its stack.
  - Recorded residuals: a callback that never settles keeps its context, and the plugin's own
    timers, UI callbacks, and no-chat hooks can inherit an ambient context during another hook's
    await. Exact attribution needs RPC correlation, which is a transport change.
- **Reads inside a hook** (A20): with a context, the plugin `getDatabase` overlays the forwarded
  preset keys from the captured preset by id, so a read-modify-write inside a hook stays in one
  preset. `personaId` is carried for Phase 5 only; no Phase 4 host function consumes it.
- **Settings writes** of a hook go through `updateSettings(patch, { presetId: context.presetId })`.
  A context whose preset is gone throws `PluginTargetGoneError`, like a gone chat.

### Slice 4 (`mcp-risuaccess-writers`)

- **Modules** (A21). `findModule(id): DeepReadonly<RisuModule>` is used by every module handler.
  After consent, the handler re-resolves by exact id; the name fallback is never used for that
  second lookup. `setModuleInfo` validates the whole request through `updateModule` before it
  calls `setModuleEnabled`.
- **Suppressions:** all three `@ts-ignore` lines go. The exit grep
  `rg 'markCharactersDirty|@ts-ignore' src/ts/process/mcp/risuaccess` answers nothing.
- **Test harness:** `modules.test.ts` mocks `stores.svelte` with only `DBState` and `selIdState`,
  so its harness is adapter work (F-g).

### Slice 5 (`lua-character-setters`)

- **Resolution table** (A22).
  - A real character argument resolves to its `chaId`, captured at entry.
  - An omitted `char` resolves to the selection at entry (`runScripted` resolves it at line 89).
  - A `simple` argument resolves to no writable character: the rule goes by `type`, since a
    `simple` argument always carries a `chaId`.
  - The state is reset on every run.
  - Return shapes stay: `setName` and `setDescription` return nothing, and the other two return
    `false` when unresolved. Getters return `undefined` or `""` for an unresolved target.
- **Closures** (F-d): the `declareAPI` closures capture no `char`. They read the engine state's
  `characterId` at call time, as `getPersonaDescription` does. `generateImage` and
  `upsertLocalLoreBook`'s type check read it too (the engine-reuse staleness, recorded as fixed).
- **Recorded behavior change** (F-e): a translation run's `simple` character no longer writes
  the selected character.
- **Tests:** `scriptings.test.ts`'s mocks gain the character module.
- **Deferred:** the `ScriptingEditDisplayIds` cleanup defect is recorded for Phase 5's
  `lua-bindings-and-buttons`, not fixed.
- **Exit grep:** `selectedCharID` answers `runScripted:89`, `engineCharacter`'s fallback,
  `getCharacterImageMain`, and the two `getCharacterLastMessage` callbacks.

### Slice 6 (`trigger-effect-writers`)

- **Display and request runs** (F-b). The eight character writes are gated on
  `!arg.displayMode`, like `writeChatMeta`. Recorded: in display and request runs the lore
  effects still edit the live `globalLore` in place until Phase 5 isolates those runs. The test
  becomes "they make no mutation call".
- **`v2SetPersonaDesc`** (F-c) resolves `selectedPersonaForWrite(DBState.db)?.id`, calls
  `updatePersona` with it, and warns and skips when there is no persona. It never throws inside
  the effect switch.
- **`v2ModifyLorebook`** writes only the selected character today; after the slice it writes the
  trigger's character like the other seven. Today the rooted grep finds seven hits.
- **Tests:** the review step creates `triggers.test.ts`; none exists.

### Slice 7 (`imports-through-the-module`)

- **Statics stamp:** `incrementStatic("imports")`.
- **Personas:** `importUserPersona` keeps Phase 3's icon-first order, then calls `addPersona`.
- **Presets:** the three `importPreset` pushes call `addPreset`, which puts `database.svelte.ts`
  in scope for them (A24).
- **`importChat` as a whole** (A23):
  - capture `chaId` before the dialog and re-resolve it after;
  - read names and folders from that record;
  - write `updateCharacter(chaId, { chatFolders })`;
  - call `changeChatTo(0)` only while that character is still selected;
  - stop with an error when it was deleted meanwhile.

  The scope line becomes `importChat`. Recorded as fixed.

### Slice 8 (`closeout`)

- **Audit** (A25):
  - Publish the exact command and exclusions.
  - Classify every hit by function: a contract residual (listed by its slice), a settings write
    carried by the section watchers (Phase 6's pages), a core-app writer (Phase 6's character or
    consumer slices), a Phase 5 residual (`setGlobalChatVar`, the request-layer token writes),
    or a false positive.
  - List alias bindings by identifier, and drop the dead `cipherChat` entry.
  - Hits without a Phase 5 or Phase 6 owner become proposed edits to those slices. Requiring
    every owner slice to acknowledge before closeout is dropped (scope creep).
- **Backup round trip:** runs manually on a version-3 store. Values are changed after the
  export, and both the archive and the snapshot restore paths are checked.
- **Built-client check:** the one built-client check of the Workflow section.

## Plan review decisions

- **Astra points adopted:** A2, A4, A6, A7, A8, A9, A10, A11, A12, A14, A15, A16, A17, A18, A20,
  A21, A22, A23, A24.
- **Adopted with changes (Fable's smaller fix):**
  - A1: no section kind check, instead of shared field-kind tables.
  - A3: one resolution path through `writePresetField`.
  - A5: weaker validators instead of stronger documented contracts.
  - A13: the drift check is dropped instead of redesigned.
  - A19: the cheap lifecycle rules; the rest recorded as residual.
  - A22: the rule goes by `type`, not a missing id.
  - A25: without owner acknowledgement.
  - A27: one built-client check at the closeout, not a gate per slice.
- **Rejected in part:**
  - A26's stop rule: `CLAUDE.local.md` makes a review problem a stop for you. Its other two
    parts are adopted (the slice 1 smoke, and no "no caller" rationale).
  - A26's step-0 rewrite of the slice files: this file's precedence rule covers it, and each
    slice file is updated in its own slice's commit.
- **Fable's F-a to F-i:** all adopted (above, and F-h corrects this plan's baseline and slice
  notes).
- **Testing advice:** Astra's list goes verbatim to each slice's Fable reviewer, with my reasons.
  Fable's plan evaluation already sorted it into necessary and not necessary; the reviewer judges
  again per slice.

## Checks

- **Per slice:** the project checks, the slice's discovery greps (their expected answers
  re-derived at implementation), its manual checks through Playwright against a fresh server in a
  temp directory, and the review-step tests the slices and this plan name (written by the Fable
  reviewer).
- **At the closeout:** every manual check re-run on the final tree, the backup round trip, the
  built-client check, and the classified audit pasted into the phase file.
