# Slice: Plugin Host Setters

Status: implemented 2026-09-30 (record below; the implementation plan's amendments apply).

Phase: [Phase 4](../../phase-4-external-contracts.md), "Plugin API v3" (all of it: `setDatabase`
and `setDatabaseLite` per collection, `setChar`, `setCharacterToIndex`, `setChatToIndex`,
`pluginStorage`, the snapshot getters, the unchanged `risuai.d.ts`); `PLAN.md` Invariant 2
(this slice switches `pluginStorage` to explicit mutations and deletes its watcher as its last
step) and Invariant 5 (the client stops guessing defaults for a migrated collection: the
whole-database normalizer call goes).

Depends on: `character-and-collection-mutations`; Phase 3 `shared-schema-and-ids` (the
`ensureIds` pass in the plugin setters, replaced here by `setPersonas`),
`forwarding-presets-and-selection` (forwarded keys through the accessor; `selectPersona`),
`client-section-mirrors` (the `ui` and `providers` fields). `plugin-call-context` follows this
slice in the same file. Parallel with the MCP, Lua, trigger, and import slices (disjoint source
files; no docs edited here).

## Scope

Allowed files: `src/ts/plugins/apiV3/v3.svelte.ts`, `src/ts/plugins/plugins.svelte.ts`
(`importPlugin`'s writes; `allowedDbKeys` unchanged), `src/ts/plugins/pluginSafeClass.ts`
(delegates to `pluginStorageStore`), `src/ts/storage/browserLocalImport.ts` (imports the helper
from its new module), `src/ts/gui/colorscheme.ts` (`changeColorScheme` and
`updateCustomColorScheme` call `updateSettings`), `src/ts/storage/resourceSync.svelte.ts` (the
`pluginCustomStorage` watcher deleted, last), the test mocks only where they stub the storage
layer: `src/ts/plugins/apiV3/{hostApi,pluginStorage,permissions}.test.ts`,
`src/ts/plugins/pluginSafeClass.test.ts`. `src/ts/plugins/apiV3/risuai.d.ts` is not touched.
Tests belong to the review step; the guides and `plugins.md` belong to the closeout.

Identifiers (verified 2026-09-30 at `577c43ae`): `allowedDbKeys` (`plugins.svelte.ts:389-413`,
23 keys: `characters`, `modules`, `enabledModules`, `moduleIntergration`, `personas`, `plugins`,
`pluginCustomStorage`, `temperature`, `askRemoval`, `maxContext`, `maxResponse`,
`frequencyPenalty`, `PresensePenalty`, `theme`, `textTheme`, `lineHeight`,
`seperateModelsForAxModels`, `seperateModels`, `customCSS`, `guiHTML`, `colorSchemeName`,
`selectedPersona`, `characterOrder`); `DatabaseSubset` (`risuai.d.ts:368-420`, the same minus
`selectedPersona` and `characterOrder`; pre-existing and left as is, since the declared surface
does not change). In `v3.svelte.ts`: the host `getDatabase` (1059-1073: `$state.snapshot` per
allowed key read from `DBState.db`, already a snapshot), `getChar` (694-696, a snapshot),
`setChar` (698-700), `assignMissingChaId` (710-714), `applyPluginCharacter` (716-743: the
replacement branch writes `DBState.db.characters[index] = char` at 729 and marks at 730; the
same-id branch calls `setCharacterByIndex` at 737 and `reconcileCharacterChats` at 739),
`applyPluginCharacters` (750-795: builds `next` in the plugin's order and assigns
`DBState.db.characters = next` at 792, which reorders the mirror and places new characters at
their positions), `setPluginDatabaseLite` (865-882: the per-key assignment at 873, custom keys
into `pluginCustomStorage` at 875, `DBState.db = db` at 878, `markCharactersDirty("all")` at
880), `setPluginDatabase` (884-907: the same plus `handlePluginInstallViaPlugin` for `plugins`,
whose return value is only the newly confirmed plugins (`plugins.svelte.ts:415-437`) and is
assigned as the whole list at 898, so a plugin sending `[...existing, new]` uninstalls the rest;
the whole-database normalizer `setDatabase(db)` at 903), `getArg`/`setArg` (797-815),
`getArgument`/`setArgument` (1165-1180), `changeColorScheme` (1078-1080 → `colorscheme.ts:226-234`,
which writes `colorScheme` and `colorSchemeName`), `setColorScheme` (1102-1106),
`changeTextTheme` (1116-1124), `setCustomTextTheme` (1146-1149), `getCharacterFromIndex`
(1181-1189, a snapshot), `setCharacterToIndex` (1190-1197), `getChatFromIndex` (1198-1209, a
snapshot), `setChatToIndex` (1256-1273, already `applyChatResult`), `checkCharOrder` (1560, the
plugin-visible export of the `characterOrder` writer), the seven `_*PluginStorage` functions
(1577-1611), `getLocalPluginStorage` (1557-1559), `runLLMModel` (1646-1668) and `sendChat`
(1670-1710) whose callees reach pipeline writes (`openAI/requests.ts:352` `cipherChat`,
`google.ts:513-516` the Vertex token, `index.svelte.ts:357` `statics.messages`, the chat module):
audited, they are the send pipeline's and Phase 5's request layer's, not this slice's. In
`plugins.svelte.ts`: `importPlugin` (`db.plugins[oldPluginIndex] = pluginData` 360, `push` 362,
`setDatabaseLite(db)` 370), `loadPlugins` (381, a read). `pluginSafeClass.ts:86-140`
(`safeLocalPluginValues`, `setSafeLocalPluginValue`, `SafeLocalPluginStorage.clear`);
`browserLocalImport.ts:146-149` (writes through `setSafeLocalPluginValue`, no mark of its own).
`resourceSync.svelte.ts:1268-1271` (the deep `pluginCustomStorage` watcher). Tests:
`hostApi.test.ts` (mocks `database.svelte` with a live `getDatabase` and a direct-assignment
`setCharacterByIndex`, 39-53; case 130 asserts the normalizer call; case 236-249 asserts the
list order after `setDatabaseLite`), `pluginStorage.test.ts` (mocks `getDatabase` with a plain
object), `pluginSafeClass.test.ts` (the real `DBState`). Grep residuals today (Luna fan-out C):
the rooted pattern finds 18 writes in `v3.svelte.ts`, 3 in `plugins.svelte.ts`, 5 in
`pluginSafeClass.ts`, 7 in `colorscheme.ts`; `getDatabase()` 13 times in `v3.svelte.ts` (the
reads `getArg` 798, `getArgument` 1166, `_getPluginStorage` 1578, `_keyPluginStorage` 1601,
`_keysPluginStorage` 1606, `_lengthPluginStorage` 1610 stay), twice in `plugins.svelte.ts` (381
stays), once in `colorscheme.ts` (248, `updateColorScheme`, stays); none in `factory.ts`.

Stopping condition: an `allowedDbKeys` key with no owner in the routing table below (each key
must map to exactly one function), or a `pluginCustomStorage` writer still standing after the
routing (then the watcher is not deleted and the report records why).

## Assumptions

- `character-and-collection-mutations` landed with the functions named below, validating their
  values; the `pluginCustomStorage` watcher still exists at the start of this slice.
- Phase 3 landed: `temperature`, `maxContext`, `maxResponse`, `frequencyPenalty`,
  `PresensePenalty`, `moduleIntergration` are forwarded preset keys; `seperateModels` and
  `seperateModelsForAxModels` are keep-on-switch `providers` fields; `askRemoval`, `theme`,
  `textTheme`, `lineHeight`, `customCSS`, `guiHTML`, `colorSchemeName`, `customColorScheme`,
  `colorScheme`, `customTextTheme` are `ui` fields; `personas`, `characterOrder`,
  `enabledModules` are collections; `selectedPersona` is the derived index accessor whose setter
  selects on this client only (Phase 3's recorded change). If the Phase 3 spike failed, the
  forwarded keys live in the `SelectedPreset` projection: `updateSettings` and `readSetting`
  carry that mapping, so this slice does not change (contingent boundary in the report).
- The mirror's character order is not persisted (`assembleDatabase` loads characters in
  creation order), so the order a plugin's list imposes is transient today.
- `hostApi.test.ts` and `pluginStorage.test.ts` stub the storage layer; the review step decides
  whether they mock the new modules or run the real ones (`pluginSafeClass.test.ts` already runs
  the real `DBState`).

## Proposed decisions

- Routing table (proposed) for `setDatabase` and `setDatabaseLite`: `characters` →
  `applyPluginCharacters` rewritten on the module (matched ids through `replaceCharacterFields`
  plus `reconcileCharacterChats`, a different id at an index through `replaceCharacterAt`, new
  ids through `addCharacter` (appended), omitted ids through `removeCharacter`; the
  generating-character guards and the duplicate-id refusal unchanged; `DBState.db.characters = next`
  and `markCharactersDirty("all")` go); `personas` → `setPersonas` (Phase 3's `ensureIds` moves
  into it); `modules` → `setModules`; `enabledModules` → `setEnabledModules`; `characterOrder` →
  `setCharacterOrder`; `plugins` → in `setDatabase`, `handlePluginInstallViaPlugin` then
  `upsertPlugin` per confirmed plugin (the confirmation is kept; the existing plugins are no
  longer removed: a pre-existing defect, recorded as fixed); in `setDatabaseLite`, `setPlugins`
  as today (no confirmation: the safety contract forbids a permission change; recorded as
  pre-existing); `pluginCustomStorage` → `replacePluginCustomStorage`; `selectedPersona` →
  `selectPersona(personas[index]?.id)`, applied after `personas` whatever the object's key order
  (so `{ selectedPersona, personas }` selects in the new list); the fifteen settings keys → one
  `updateSettings(patch)`; every other key → `setPluginCustomValue(key, value)`. Keys are
  otherwise applied in the plugin object's order, so an earlier key's refusal (a validation
  error) leaves the later ones unapplied and the error reaches the plugin. Recorded behavior
  changes: `setDatabase({ characters })` no longer reorders the mirror and new characters are
  appended (the index-based getters and `selectedCharID` keep the mirror's order; the order was
  lost on reload anyway); `setDatabase({ plugins: [...existing, new] })` keeps the existing
  plugins; a malformed value is refused by the owning function instead of normalized.
  `setPluginDatabase` no longer calls the whole-database normalizer `setDatabase(db)`: Phase 3
  moved the defaults to the server (Invariant 5) and each routed value is validated by its
  owner. `hostApi.test.ts:130` (asserts the normalizer call) and `236-249` (asserts the order
  after an omission) change accordingly.
- Character setters (proposed): `setChar(char)` → `applyPluginCharacter(index of the selected
character, char)` (the context-aware form is `plugin-call-context`'s); `applyPluginCharacter`'s
  same-id branch → `replaceCharacterFields(chaId, fields)` and `reconcileCharacterChats` as
  today; its replacement branch → `replaceCharacterAt`; `setCharacterToIndex` and `setChatToIndex`
  keep their index shape. `getChar`, `getCharacterFromIndex`, `getChatFromIndex`, and
  `getDatabase` already return snapshots (unchanged), except that `getDatabase` reads a forwarded
  key through `readSetting(key)` so the snapshot holds the same value under both Phase 3
  implementations.
- Plugin storage (proposed): the seven `_*PluginStorage` functions call `pluginStorageStore`;
  `SafeLocalPluginStorage` and `setSafeLocalPluginValue` in `pluginSafeClass.ts` delegate to it
  (the export stays for `browserLocalImport.ts`, which now imports from the store module); the
  reserved keys and the JSON rules are unchanged. Last step of the slice, once the discovery grep
  shows no `pluginCustomStorage` writer outside the store module: the deep watcher at
  `resourceSync.svelte.ts:1268-1271` is deleted, and the review test "a `pluginStorage.setItem`
  and a `getLocalPluginStorage().setItem` are sent without the watcher" moves here. This is
  Invariant 2's "adapter deleted per collection" for `pluginStorage`, done in the same checkpoint
  that routes its last writer (Astra P4, Opus P1).
- Arguments and themes (proposed): `setArg` and `setArgument` → `setPluginArgument(name, key,
value)`; `setColorScheme` → `updateSettings({ colorSchemeName: "custom", customColorScheme,
colorScheme })` then `updateColorScheme()`; `changeTextTheme` and `setCustomTextTheme` →
  `updateSettings({ textTheme, customTextTheme })` then `updateTextThemeAndCSS()`;
  `changeColorScheme` in `colorscheme.ts` (the shared helper the host exports and the UI calls)
  and `updateCustomColorScheme` compute the scheme and call `updateSettings({ colorScheme,
colorSchemeName })` (the helper calls the module; `changeColorSchemeType` 272 and
  `importColorScheme` 307 are UI-only and stay direct, in the closeout's allowlist).
  `checkCharOrder` (the host export) is the storage-layer mutation after slice 1; unchanged
  here. `importPlugin` → `upsertPlugin(pluginData)`; its `setDatabaseLite(db)` (a self-assignment
  of the proxy) goes. Host-function audit (Luna fan-out C, through callees): every exported host
  function that reaches a `DBState.db` write is one of the above or reaches the send pipeline
  and the request layer through `sendChat` and `runLLMModel` (Phase 5's), or the chat module
  through `setChatToIndex` and `parseRisuChat`'s `setvar` (Phase 2's).

## Validation

`pnpm check`, `pnpm test` (`hostApi`, `pluginStorage`, `pluginSafeClass`, `permissions`,
`permissionStore`, `plugins` tests), `pnpm format:check`, `pnpm build`. Exit check, discovery
only: the rooted pattern of the closeout over `src/ts/plugins` and `src/ts/gui/colorscheme.ts`
answers only `colorscheme.ts:272` and `307` (UI-only, allowlisted); `rg -n 'getDatabase\(\)' src/ts/plugins`
answers only the six reads listed above and `plugins.svelte.ts:381`;
`rg -n 'markCharactersDirty|setDatabaseLite\(|setDatabase\(db\)' src/ts/plugins` answers
nothing outside tests; `rg -n 'pluginCustomStorage' src/ts src/lib --glob '!*.test.ts'` answers
only the store module, the adapter's projection and hydration, `bootstrap.ts`'s assembly,
`setDatabase`'s `_coldplugin` deletion, and reads. Review-step tests: the routing table, one
case per `allowedDbKeys` key (the value lands in its owner, a forwarded key in the selected
preset by id, a custom key in `pluginCustomStorage`, `selectedPersona` selecting by id in the
new list when both keys are sent, a malformed value refused with nothing applied after it);
`setDatabase({ plugins: [...existing, new] })` keeps the existing plugins and asks once for the
new one; `setDatabase({ characters })` with a reordered list keeps the mirror order and appends
a new character (the changed `hostApi.test.ts` cases); `pluginStorage.test.ts` and
`pluginSafeClass.test.ts` over the real module; `pluginStorage.setItem`,
`getLocalPluginStorage().setItem`, a custom key, and `SafeLocalPluginStorage.clear` are sent
without the watcher (over `storeBackedServer.ts`); the plugin `getDatabase` snapshot holds a
forwarded key under both Phase 3 implementations. Manual, recorded in the closeout:
`setDatabase({ temperature })` lands in the selected preset; `pluginStorage.setItem` and
`getLocalPluginStorage().setItem` survive a reload; `changeColorScheme` from a plugin survives a
reload.

## Residual risk

`setDatabaseLite({ plugins })` installs plugins without the confirmation `setDatabase` asks
(pre-existing; permission semantics are out of scope by the safety contract). Plugin character
setters still accept malformed entries beyond the validation of slice 1 (Phase 2's known
limit). A plugin that read `pluginCustomStorage` through `getDatabase` keeps seeing the whole
object (unchanged). Every later `pluginCustomStorage` writer must call the store module: the
collection has no watcher after this slice.

## Implementation record

Implemented 2026-09-30 on `8526502b`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 2).

- **`src/ts/plugins/apiV3/v3.svelte.ts`**:
  - `applyPluginKey` routes each key of `setDatabase` and `setDatabaseLite` to its owner, as the
    routing table above has it:
    - `characters` → `applyPluginCharacters`;
    - `personas` → `setPersonas`, `modules` → `setModules`, `enabledModules` →
      `setEnabledModules`, `characterOrder` → `setCharacterOrder`;
    - `plugins`: the full setter `upsertPlugin`s each confirmed plugin, the lite one calls
      `setPlugins`;
    - `pluginCustomStorage` → `replacePluginCustomStorage`;
    - `selectedPersona` → the persona at that index, by id;
    - the fifteen settings keys → one `updateSettings({ [key]: value })` each;
    - any other key → `setPluginCustomValue`.
  - `applyPluginDatabase` applies the keys one by one inside `warnRefused`. That catches only
    `MutationValidationError`, warns, and keeps the previous value; `MutationTargetGoneError` and
    unexpected errors reach the plugin.
  - `pluginKeyOrder` applies `characterOrder` and then `selectedPersona` after every other key
    (Astra challenge point 1).
  - Gone: `assignPluginField`, `normalizedPluginPersonas`, the whole-database normalizer
    `setDatabase(db)`, `DBState.db = db`, `markCharactersDirty("all")`, and the empty
    `pluginCustomStorage` created on every call.
  - The full setter checks `plugins` (a list of plugins with names) before the install prompt,
    and passes the plugin's object on unchanged.
  - `applyPluginCharacters` checks the whole list first (`checkCharacterInput` per entry). It
    refuses duplicate ids and one object listed twice. Then it updates matched characters, appends
    new ones (`addCharacter`), and removes omitted ones (`removeCharacter`), except one that is
    generating.
  - `applyPluginCharacter`: a same-id character goes through `replaceCharacterFields` and the
    chat module. Another id goes through `replaceCharacterAt`, after the two old checks that keep
    their warnings.
  - `setArg` and `setArgument` → `setPluginArgument`.
  - `setColorScheme`, `changeTextTheme`, and `setCustomTextTheme` → `updateSettings`.
  - The seven `_*PluginStorage` functions → `pluginStorageStore`, the four reads included.
- **`src/ts/storage/collectionStore.svelte.ts`** (not in the allowed files): exports
  `checkPluginInput` for the full setter's check.
- **`src/ts/storage/pluginStorageStore.svelte.ts`** (slice 1's module; Astra challenge point 2):
  a dictionary a plugin replaced with a list reads as the list's entries, and becomes that
  dictionary before a write.
- **`src/ts/storage/mutationValidation.ts`**: the JSON refusal names the 256-level depth limit
  (Astra challenge point 3).
- **`src/ts/plugins/pluginSafeClass.ts`**: `SafeLocalPluginStorage` delegates to the store module.
  Its `TypeError` for non-JSON and `undefined` stored as `null` stay.
- **`src/ts/storage/browserLocalImport.ts`**: imports the helper from the store module, and uses
  `hasSafeLocalPluginValue`.
- **`src/ts/gui/colorscheme.ts`**: `changeColorScheme` and `updateCustomColorScheme` call
  `updateSettings`.
- **`src/ts/plugins/plugins.svelte.ts`**: `importPlugin` writes through `upsertPlugin`; its
  `setDatabaseLite(db)` is gone.
- **`src/ts/storage/resourceSync.svelte.ts`**: the `pluginCustomStorage` watcher is deleted.
  Every writer outside the store module is either the boot assembly (`bootstrap.ts`), the
  `_coldplugin` deletion (at boot and restore, covered by the boot marks), or the adapter itself.

Recorded behavior changes, beyond those the routing table records:

- A refusal that was silent before now warns: `characters` that is not a list, a `selectedPersona`
  naming no persona, a plugin argument that is neither a string nor a finite number, and a
  non-JSON custom key.
- A malformed preset-field value (`temperature: null`) is refused.
- v3 `pluginStorage` refuses JSON nested deeper than 256 levels.
- An unknown color scheme name changes nothing.
- A persisted `characterOrder` that omits a character the same call adds gets that character at
  the next order repair (the boot one included), as before.

Checks:

- `pnpm check`, `pnpm test` (86 files, 895 passed, 3 skipped), `pnpm format:check`,
  `pnpm build`, and `pnpm test:e2e` (5 passed).
- The exit greps answer what the Validation paragraph expects: the rooted pattern answers only
  `colorscheme.ts:259` and `:294`.
- A Playwright script drove a real v3 plugin in its sandbox, over RPC, against a fresh server.
  Every write survived a reload, and every refusal warned and changed nothing. The folder order
  held with a character added in the same call. Clearing both storages saved.

Observation, outside this slice: after a minimal character (`{ name, chats: [] }`) is added, the
first idle reload writes it back once, with the defaults `bootstrap.ts` `checkNewFormat` fills and
the server's character kind does not. The same happens through slice 1's `addCharacter` alone.

## Tests

- A Fable test-adapter changed the tests this slice invalidates on purpose.
  - `hostApi.test.ts`: the normalizer assertions; the "residual root key" case, now a refusal; a
    fixture with presets.
  - `plugins.test.ts`: `importPlugin` no longer calls `setDatabaseLite`.
  - `resourceSync.test.ts`: the own `__proto__` case writes through the store.
  - Harness changes in `pluginSafeClass.test.ts` and `pluginStorage.test.ts`.
- The Fable reviewer (verdict: no problem) wrote two files:
  - `src/ts/plugins/apiV3/hostApiRouting.test.ts` (44 cases): the routing of every
    `allowedDbKeys` key through both setters; refusals between valid keys; the whole-list checks;
    the order keys; plugin installs; list-valued storage dictionaries; arguments and themes.
  - `src/ts/plugins/apiV3/v3SavedWrites.test.ts` (9 cases, over `storeBackedServer.ts`): every
    plugin storage write saved without the watcher; no echo after a conflict reload; the
    arguments, the color scheme, a preset key, and the order saved.

## Astra challenge (2026-09-30) and decisions

1. Medium: a `characterOrder` sent before `characters` lost the ids the same call adds, because
   each `addCharacter` repairs the order. Adopted: the order key is applied after the others.
2. Medium: a reserved storage dictionary a plugin replaced with a list became unreadable and was
   emptied on the next write. Adopted: it reads as the list's entries and becomes that dictionary
   before a write.
3. Low: v3 `pluginStorage` refuses JSON nested deeper than 256 levels, which its JSON round trip
   accepted. Adopted with changes: the limit stays, recorded above, and the refusal names it.
4. The first-reload character write-back is inherited (not this slice's). It is tracked
   separately.
5. The four deviations (`checkPluginInput`, the storage reads, the new warnings, the kept checks)
   were judged justified.
