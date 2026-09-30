# Slice: Character And Collection Mutations

Status: implemented 2026-09-30 (record below; the implementation plan's amendments apply).

Phase: [Phase 4](../../phase-4-external-contracts.md), the Objective ("re-point everything
outside the core app ... at the mutation API"): this slice is the mutation API the other seven
slices re-point at. `PLAN.md` Invariant 2 (every write ends in an explicit mutation; the adapter
stays the transport for a collection until its writers are routed, and is deleted per
collection), Invariant 3 (`DBState.db` stays the read model until Phase 6), and Decision 3 (a
forwarded settings write is a mutation carrying the selected id).

Depends on: Phase 2 (`chatStore.svelte.ts`: `normalizeNewCharacter`, `reconcileCharacterChats`,
`isCharacterGenerating`; `resourceSync.svelte.ts`: `markCharactersDirty`, `flushResources`),
Phase 3 (`shared/sections.ts`: `SECTION_FIELDS`, `FORWARDED_PRESET_KEYS`; `shared/presets.ts`:
`PRESET_KEEP_ON_SWITCH_FIELDS`, `PRESET_ROOT_ALIASES`, `newPersonaId`;
`src/ts/storage/selection.svelte.ts`: `selectPersona`, `reconcileSelection`; the section and
collection watchers; no `root` kind). First slice of the phase; the other seven depend on it.

## Scope

Allowed files: `src/ts/storage/characterStore.svelte.ts` (new), `src/ts/storage/collectionStore.svelte.ts`
(new), `src/ts/storage/pluginStorageStore.svelte.ts` (new), `src/ts/storage/characterOrder.ts`
(new: `checkCharOrder` moved here), `src/ts/globalApi.svelte.ts` (re-exports `checkCharOrder`;
nothing else), `src/ts/storage/database.svelte.ts` (`setCurrentCharacter`, `setCharacterByIndex`,
`replaceCharacterFields` delegate to the character module), `src/ts/storage/resourceSync.svelte.ts`
(`markPluginStorageDirty`, `beginMutationScope`, the `flushResources({ scope })` option, the
drift token bump inside `markCharactersDirty` and `markCharacterDirtyAt`; the
`pluginCustomStorage` watcher is kept). No contract file, no `src/lib` file, no server file, no
`docs/structure/` file (the closeout edits the guides). Tests belong to the review step.

Identifiers (verified 2026-09-30 at `577c43ae`): `getDatabase` (`database.svelte.ts:753-758`),
`getCurrentCharacter` (760-767), `setCurrentCharacter` (774-785: finds by `chaId`, then
`replaceCharacterFields` and `markCharacterDirtyAt`), `getCharacterByIndex` (787-794),
`setCharacterByIndex` (797-803), `replaceCharacterFields` (805-820: keeps the mirror's `chats`,
`chatPage`, `reloadKeys`); `markCharactersDirty` (`resourceSync.svelte.ts:243-250`),
`markCharacterDirtyAt` (253-258), the settled-generation map `acked` (129-132: saved, unchanged,
or discarded by a conflict all count as settled), `acceptRemote` (823-847: discards the local
edit, `discardSequence`, `discarded`), `flushResources` (1087-1145: `await tick()` first, then
its discard watermark `firstDiscard = discardSequence + 1`, returns `{ discarded }` since that
watermark), `planBatches` (563-635: splits by bytes and operation count; `isolateBatches` sends
units separately), the private `markKey`/`collectionKey`, the watchers in `startResourceSync`
(1256-1294: `botPresets`, `modules`, `plugins`, `pluginCustomStorage` at 1268-1271, the root
keys, the membership effect, the selected character), the boot marks of every collection and
character (1245-1248), `projectCollection`'s `pluginStorage` branch (306-309: serialized
straight from the proxy so an own `__proto__` key survives), `applyToMirror` (1020-1077);
chat module: `normalizeNewCharacter` (`chatStore.svelte.ts:1470-1490`), `reconcileCharacterChats`
(1287-1329), `noteMirrorReplaced` (2437-2439), `startChatDriftCheck` (2413-2435: dev-only,
polled every 2 s, compares a JSON snapshot against `mutationToken`); `checkCharOrder`
(`globalApi.svelte.ts:580-638`, the only writer of `characterOrder` on add, remove, restore,
and import; `globalApi.svelte.ts:1-40` imports plugins, `characterCards`, the parser,
`streamsaver`, and `resourceSync`, so a storage module must not import it); the plugin-visible
`checkCharOrder` export (`v3.svelte.ts:1560`, `risuai.d.ts:2048`); `findCharacterIndexbyId`;
`DeepReadonly` (`shared/readonly.ts`, a compile-time type). The core-app callers that mark
themselves and stay direct: `characters.ts:165, 182, 192, 885, 911, 945`, `bootstrap.ts:169`,
`index.svelte.ts:370`; the wrapper callers that remain: `characterFormatUpdate`
(`characters.ts:611-716`, `setCharacterByIndex`) and `applyModule` (`modules.ts:538-562`,
`setCurrentCharacter`).

Stopping condition: a writer in a later slice that the API below cannot express by id (the
report lists the writers; each maps to one function), or a value validation rule that would
refuse a value the server normalizer accepts today (then the rule is loosened, never the mirror
left different from the server).

## Assumptions

- Phase 3 landed: `shared/sections.ts` partitions `keyof Database`; every section and
  collection has a watcher; `selection.svelte.ts` holds `presetId` and `personaId`; persona ids
  are client-assigned (`newPersonaId`) with a server backstop; `root` is gone. No collection has
  explicit mutation functions and no watcher was deleted in Phase 3 (its record).
- The adapter watches only the selected character deeply (D4); `markCharactersDirty` is the
  dirty entry for any other character; additions and removals wake the loop through the
  membership effect and need no mark.
- Batch results carry revisions only and `cycle` records the submitted text as persisted
  (Phase 3's record), so a value the client writes is what the server stores: the mutation
  functions must refuse what the server would not accept, since nothing normalizes it back.
- `flushResources()` resolves once every key dirty at its call is settled, and "settled"
  includes "discarded by a conflict" (`acked`); a discard that happened before the call is not
  in its `discarded` list. A callback's persistence contract therefore needs a scope that
  starts before the callback (the mutation scope below).
- Phase 3's spike verdict does not change this slice: the forwarding accessors (or, in the
  fallback, the `SelectedPreset` projection) are what `updateSettings` and `readSetting` write
  and read through; the mapping lives here, so the callers never see the difference.

## Proposed decisions

- The mutation form (proposed; the phase's central decision, confirmed by both reviews): a
  mutation function validates every value before the mirror changes (a refusal throws and
  leaves the mutation unchanged), detaches the caller's data (`safeStructuredClone`), writes the
  mirror by id, and marks the record dirty where the adapter's watchers would miss the write (a
  non-selected character; `pluginStorage` once its watcher is gone). The save adapter of Phases
  1 and 3 stays the transport for characters, sections, and collections until Phase 6.
  Alternative: an op queue per collection like `chatStore` (rejected: Phase 6 deletes the
  adapter in favor of projections and live updates, so a second op protocol for records the UI
  still binds to would be thrown away; Phase 5 needs id-addressed signatures and a persistence
  contract, and both exist). Consequence for Invariant 2: Phase 4 switches one collection to
  explicit mutations (`pluginStorage`, its watcher deleted by `plugin-host-setters` once every
  writer is routed) and no other; the phase file should say so (proposed edit in the report).
- Value validation (proposed): every function checks its input before touching the mirror:
  JSON-serializable (no functions, symbols, `BigInt`, cycles), finite numbers, a settings value
  of the same JS type as the current mirror value (or `null`/`undefined` where the current value
  is nullish), a collection element that is an object with a string `id` (personas, modules;
  a persona without an id gets `newPersonaId` first), a character with a string `chaId`, `name`,
  and `type` `"character"` or `"group"`. No normalized value is returned or hydrated (the
  alternative, batch results carrying data, is transport work outside this phase). A refused
  patch throws `MutationValidationError` naming the key.
- `characterStore.svelte.ts` (proposed): `findCharacter(chaId): DeepReadonly<character | groupChat> | undefined`
  (the mirror record, read-only typed); `addCharacter(char): string` (a validated, detached
  character with its initial chats appended to the mirror, `normalizeNewCharacter(chaId)`,
  `checkCharOrder()`; a `chaId` already present is refused; returns the id);
  `updateCharacter(chaId, patch): boolean` (own fields only: `chats`, `chatPage`, `reloadKeys`,
  `chaId`, and `type` throw; the patch is validated and cloned and assigned field by field on the
  mirror record; `markCharactersDirty([chaId])`; a missing character returns `false`);
  `replaceCharacterFields(chaId, char)` (today's `setCurrentCharacter`: every own field
  replaced, the mirror's chats kept); `replaceCharacterAt(index, char)` (a character with
  another `chaId` at an index: today's replacement branch of the plugin `applyPluginCharacter`,
  with the duplicate-id refusal and `normalizeNewCharacter`); `removeCharacter(chaId)`
  (permanent: splice, `checkCharOrder()`; refuses while `isCharacterGenerating`). Trash and
  restore are `updateCharacter(chaId, { trashTime })`. `setCurrentCharacter` and
  `setCharacterByIndex` in `database.svelte.ts` become wrappers over `replaceCharacterFields`
  for their remaining callers (`characterFormatUpdate`, `applyModule`); Phase 6 removes them.
- `characterOrder.ts` (proposed; Opus P7): `checkCharOrder` moves from `globalApi.svelte.ts`
  into `src/ts/storage/characterOrder.ts` unchanged in behavior (it is the `characterOrder`
  mutation: add, remove, restore, import); `globalApi.svelte.ts` re-exports it so every caller,
  including the plugin-visible `checkCharOrder`, is unchanged. Reason: the character module
  must call it, and importing `globalApi.svelte.ts` from the storage layer would create the
  cycle `database.svelte.ts` → `characterStore` → `globalApi` → `database.svelte.ts` and pull
  the whole app graph into the storage tests.
- `collectionStore.svelte.ts` (proposed): personas `setPersonas(list)` (validates and clones,
  assigns `newPersonaId` to an element without one, keeps existing ids, `reconcileSelection()`),
  `addPersona(persona)`, `updatePersona(id, patch)`; modules `setModules(list)`,
  `addModule(module)` (a `v4()` id when missing), `updateModule(id, patch)`, `removeModule(id)`;
  `setEnabledModules(ids)`, `setModuleEnabled(id, on)`; `setCharacterOrder(order)`;
  `setPlugins(list)`, `upsertPlugin(plugin)` (by `name`), `setPluginArgument(pluginName, key, value)`;
  `addAuthRefresh(entry)`; `updateSettings(patch, options?: { presetId?: string })` (keys
  restricted to `SECTION_FIELDS` of `providers`, `ui`, `memoryTranslateMedia`, and `secrets`,
  plus `FORWARDED_PRESET_KEYS` and `PRESET_KEEP_ON_SWITCH_FIELDS`; each value validated, then
  assigned as `DBState.db[key] = clone(value)`, so a forwarded key goes through the accessor into
  the selected preset by the id captured at the call; with `presetId`, a forwarded key is written
  into that preset record through `PRESET_ROOT_ALIASES` instead of the accessor, for a caller
  that captured its preset before an await (the plugin call context); `llmSecrets` keys are
  refused, since Phase 5 makes them write-only; an unknown key throws); `readSetting(key)`
  (the read counterpart: the accessor, or under Phase 3's fallback the `SelectedPreset`
  projection, so the plugin `getDatabase` snapshot keeps its forwarded keys under both
  implementations). The section and collection watchers of Phases 1 and 3 transport these; no
  mark is needed. Selection is not a setting: callers use `selectPersona(id)`.
- `pluginStorageStore.svelte.ts` (proposed): `getPluginStorageValue(key)`,
  `setPluginStorageItem(key, value)`, `removePluginStorageItem(key)`, `clearPluginStorage()`
  (the reserved `_pluginStorage`), `setPluginCustomValue(key, value)` (a top-level custom key),
  `replacePluginCustomStorage(object)` (the whole `pluginCustomStorage` allowed key),
  `setSafeLocalPluginValue(key, value)` (the `_safeLocalPluginStorage` dictionary, keeping the
  `__proto__` rebuild), `removeSafeLocalPluginValue(key)`, `clearSafeLocalPluginStorage()`; each
  validates (JSON), writes the mirror, and calls `markPluginStorageDirty()` (one new export
  beside `markCharactersDirty`). The deep `pluginCustomStorage` watcher stays in this slice
  (Astra P4, Opus P1): the v3 storage functions, the custom-key routing, and
  `SafeLocalPluginStorage` still write directly until `plugin-host-setters` routes them, and
  Invariant 2 keeps the implicit path until then; that slice deletes the watcher as its last
  step. The existing `pluginSafeClass.ts` is not touched here (it is routed in the plugin slice).
- Mutation scope (proposed; Astra P1): `beginMutationScope(): MutationScope` records the
  current `discardSequence` and the chat discard sequence; `flushResources({ scope })` uses the
  scope's sequences as its watermark instead of its own, so every key discarded by a conflict
  since the scope began is in the returned `discarded` list, including one discarded while a
  callback was still running. A caller that must know a callback's writes persisted (Phase 5's
  `job-channel`) calls `beginMutationScope()` before invoking the callback and fails the
  callback when the flush returns a non-empty list; the contract is "persisted without discard,
  else the callback fails with the discarded keys" (a Phase 5 boundary and a proposed edit to
  its slice). Without `scope`, `flushResources` behaves as today.
- Development drift check (proposed; Opus P6): `startCharacterDriftCheck` modeled on
  `startChatDriftCheck` (dev-only, polled every 2 s): a JSON snapshot of the own fields of the
  characters that are not selected, compared against a `characterMutationToken` that
  `markCharactersDirty` and `markCharacterDirtyAt` bump (not the module: the core-app writers
  above mark themselves, so only an unmarked write to a non-selected character, the real
  lost-write class, is reported); a change without a bump logs "changed outside a marked write;
  the change is not saved". The selected character is watched by the adapter and excluded.
  Optional; it costs one snapshot of the non-selected characters' fields, without chats, per
  tick.
- Location and style: beside `chatStore.svelte.ts` (persistence.md path ownership), `.svelte.ts`
  because they call `$state.snapshot`; every function is synchronous; none awaits.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Review-step tests over
`src/ts/storage/tests/storeBackedServer.ts` (the `chatStore.test.ts` pattern; the real store in
memory, so the server normalizers see every value): `updateCharacter` on a character that is
not selected sends that record in the next cycle with only the patched field changed; a refused
key or a non-JSON, non-finite, or wrong-typed value throws and changes nothing (mirror and
server compared after the next cycle); `addCharacter` creates the record, its chats, and the
order entry; `removeCharacter` deletes and refuses a generating character; `replaceCharacterAt`
refuses a duplicate id; `setPersonas` assigns ids to new elements, keeps existing ones, and
`reconcileSelection` runs; `updateSettings` with a forwarded key lands in the selected preset by
id, with `presetId` in that preset after a switch, with a keep-on-switch key in `providers`,
with an `llmSecrets`, unknown, or wrong-typed key throws; `readSetting` under both Phase 3
implementations; every `pluginStorageStore` function is sent (the watcher still exists here;
the "without the watcher" case belongs to `plugin-host-setters`), including an own `__proto__`
key; `checkCharOrder` from its new module passes the existing `characters.test.ts` cases;
`beginMutationScope` + `flushResources({ scope })` reports a key discarded by a conflict raised
before the flush was called and one raised during it; the drift check stays silent for a marked
write and logs an unmarked one; `globalApi.svelte.ts` is not imported by any storage module
(a test that imports `characterStore` under `// @vitest-environment node` fails otherwise). No
manual check of its own: this slice has no caller yet (a branch checkpoint, like Phase 2's
client module); the following slices carry the manual checks.

## Residual risk

Until the other slices land the module has no caller. Atomicity is per request, not per
mutation: `addCharacter` writes the character, its chats, and the order entry, which travel in
one batch when they fit and are split by `planBatches` above the byte or operation limits or
under `isolateBatches` after an unindexed refusal; a conflict on one reloads that record (D4).
No indivisible grouping is added (the alpha scope; Astra P11). The drift check, like the chat
one, misses a change made in the same tick as a marked write. The UI editors, the core-app
creators, and the helpers listed in the closeout's allowlist keep writing the mirror directly
until Phase 6.

## Implementation record

Implemented 2026-09-30 on `40ba9c0d`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 1).

- **`src/ts/storage/mutationValidation.ts`** (new; not in the allowed files above, a shared
  helper the three modules use): `MutationValidationError`, `MutationTargetGoneError`,
  `isJsonData` (plain JSON data; `undefined` accepted inside objects and arrays, where JSON drops
  it, and at the top level by flag), `requireJsonData`, `requireObject`, `requireArray`, `detach`
  (a JSON copy; an own `__proto__` survives), and `detachPatch` (checks and detaches a whole
  field patch before the first write; `__proto__` refused).
- **`src/ts/storage/characterOrder.ts`** (new): `checkCharOrder` moved; `globalApi.svelte.ts`
  re-exports it. One change: a folder without a member list counts as empty (it threw before).
- **`src/ts/storage/characterStore.svelte.ts`** (new):
  - `findCharacter` returns the mirror record typed `DeepReadonly`.
  - `checkCharacterInput` is a non-mutating check for a caller's list preflight. It checks the
    object, the JSON data, `type` when present, `chaId` when present, and the chats (a list of
    objects with message lists of objects, what `normalizeNewCharacter` needs).
  - `addCharacter` checks the input, then works on a detached copy, which gets the id when it is
    missing. A duplicate id is refused. After the push it runs `normalizeNewCharacter` and
    `checkCharOrder`.
  - `updateCharacter(chaId, patch)` refuses `chats`, `chatPage`, `reloadKeys`, `chaId`, and
    `type`; `undefined` removes a field; it returns `false` when the character is missing, and
    marks.
  - `replaceCharacterFields(char)` takes its target from `char.chaId`, which must be present (it
    replaces the slice's `(chaId, char)`). It keeps the mirror's chat fields.
  - `replaceCharacterAt(index, char)` takes an existing index or the length. It refuses a
    same-id character (that case is `replaceCharacterFields` plus `reconcileCharacterChats`), a
    generating one, and a duplicate id.
  - `removeCharacter` keeps the selection on its character.
  - `writeCharacterFieldsAt` is the legacy body of the two core-app wrappers in
    `database.svelte.ts`, which keep their behavior.
- **`src/ts/storage/collectionStore.svelte.ts`** (new):
  - `updateSettings(patch, { presetId? })`, with the plan's key set and value rules. Every value
    is checked and detached before the first write.
  - `incrementStatic`.
  - `setPersonas`, `addPersona`, and `updatePersona`. `updatePersona` throws
    `MutationTargetGoneError` for a missing persona and refuses `id`.
  - `findModule`, `setModules`, `addModule`, `updateModule`, and `removeModule`. A missing module
    id is assigned; duplicate module ids are not refused (imports push duplicates today);
    `removeModule` leaves `enabledModules` alone.
  - `setEnabledModules` and `setModuleEnabled`.
  - `setCharacterOrder`: stricter than the server. A folder needs a list of member ids.
  - `setPlugins`, `upsertPlugin` (by name), and `setPluginArgument` (every plugin with that name,
    as `setArg` does; `__proto__` through a rebuilt dictionary).
  - `addAuthRefresh`: its five fields are strings or absent, as the server requires.
  - `addPreset`: `normalizePreset` under a fresh id.
  - The lists are checked position by position, so a sparse list is refused.
- **`src/ts/storage/pluginStorageStore.svelte.ts`** (new):
  - The v3 `_pluginStorage` and the `_safeLocalPluginStorage` functions (get, has, keys, set,
    remove, clear). Each write calls `markPluginStorageDirty`, and `__proto__` goes through a
    rebuilt dictionary.
  - `setPluginCustomValue` accepts any key, including the two dictionary names, as today;
    `undefined` removes the key.
  - `replacePluginCustomStorage`.
  - The watcher stays until slice 2.
- **`src/ts/storage/forwarding.svelte.ts`**: `forwardedPresetField`, `hasPreset`, and
  `writePresetField(db, presetId, rootKey, value)`.
- **`src/ts/storage/resourceSync.svelte.ts`**: `markPluginStorageDirty`, `MutationScope`,
  `beginMutationScope()`, and `flushResources({ scope })`.
- **Not done:** the character drift check (dropped by the plan, A13). No caller outside the
  storage layer uses the modules yet, apart from the wrappers.

Checks: `pnpm check` 0 errors; `pnpm test` 80 files, 800 passed, 3 skipped (no existing test
invalidated); `pnpm format:check`; `pnpm build`; `pnpm test:e2e` 5 passed. A Playwright script
against a fresh server (`checkP4Slice1.mjs`, scratchpad):

- **Saved across a reload:** every mutation above, with every value there after the reload and
  no batch sent by the idle reload.
- **Refused with nothing changed:**
  - a `chats` patch, a function value, a duplicate id;
  - a string temperature, a `null` theme, `proxyKey`;
  - a mixed patch with one bad key (the good key unapplied);
  - an unknown `presetId`;
  - after the challenge fixes: malformed chats and messages, a same-id and an out-of-range
    `replaceCharacterAt`, sparse module, plugin, and enabled-module lists, an array or empty
    folder in the order, and an OAuth entry with a number.
- **Kept:** an own `__proto__` survives `replaceCharacterFields`; removing an earlier character
  keeps the selection on the selected one, and removing the selected one selects none.
- **Core-app wrapper path:** open a character, edit it, reload; the edit is saved.

## Astra challenge (2026-09-30) and decisions

Eleven points; all adopted.

1. Malformed chats or messages threw after the character was installed. `checkCharacterInput`
   now checks the chat structure first.
2. A same-id `replaceCharacterAt` bypassed the chat module. It is refused.
3. Out-of-range or fractional indexes. They are refused (the length appends).
4. Sparse lists passed and would have been refused by the server. They are now checked position
   by position.
5. Folders in the order: arrays and folders without members broke `checkCharOrder`.
   `setCharacterOrder` requires a member list, and the repair tolerates a legacy folder without
   one.
6. OAuth fields that are not strings. They are refused.
7. Reserved custom keys were refused, an unapproved change. They are accepted again.
8. Prototype-named fields: `ownFields` lost `__proto__`, and `in PERSONA_DEFAULTS` matched
   `constructor`. The fix uses `Object.fromEntries` and `Object.hasOwn`, `detachPatch` refuses
   `__proto__`, and the plugin argument goes through a rebuilt dictionary.
9. Removal shifted the selection. It now follows the adapter's remote-deletion rule.
10. Detaching inside the commit loop. Everything is detached before the first write.
11. Reads initialized `characters`. Reads no longer write.

The qualifications were adopted too:

- `replaceCharacterFields` requires the id.
- Ids are assigned on the detached copy; slice 2's preflight detects one object listed twice by
  identity.
- `checkCharacterInput` is exported for slice 2.
- `writeCharacterFieldsAt` is marked legacy only.

Astra's testing advice goes to the Fable reviewer.

## Fable review, round 1 (2026-09-30): problem, fixed on the owner's go-ahead

The reviewer found the unresolved half of Astra's point 8. A patch or storage key named like an
`Object.prototype` member (`constructor`, `toString`, `hasOwnProperty`, `valueOf`) was silently
dropped, and the function still reported success. Svelte's `$state` proxy accepts an assignment
to an inherited name without storing it; the first fix covered only `__proto__`. Affected:
`updateCharacter`, `updatePersona`, `updateModule`, `setPluginArgument`, and the plugin-storage
writes. The plugin-storage half was pre-existing in `v3.svelte.ts` and `pluginSafeClass.ts`.

The fix, chosen by the owner: `writeEntries` in `mutationValidation.ts`. When every key can be
assigned in place, it is. Otherwise the object is rebuilt with own properties and installed where
the old one was: the character record (its chats kept), the persona or module in its list,
`realArg`, the storage dictionary, or `pluginCustomStorage`. The earlier `__proto__`-only branches
are replaced by it. The Playwright script now checks that each such key lands and survives a
reload.

## Fable review, round 2 (2026-09-30): no problem

`writeEntries` was verified with its edges: an already-own inherited-name key takes the in-place
path, an existing own `__proto__` survives a rebuild, and nested values keep their identity (a
character's chats stay addressable). Every caller installs the rebuilt object where the old one
was. Two pre-existing adapter rules were noted and pinned by the tests, not changed:

- a character's or a plugin `realArg`'s own `__proto__` stays in the mirror but is dropped from
  the server text by the `$state.snapshot` projection; only `pluginStorage` is serialized from
  the proxy;
- `replaceCharacterAt` leaves the order to the next `checkCharOrder`.

The tests, 42 over the real server store (`storeBackedServer.ts`), share the harness
`src/ts/storage/tests/mutationStoresHarness.ts`:

- `characterStore.test.ts` (17): the character functions, their refusals leaving the mirror and
  the server unchanged, inherited-name keys, and `checkCharOrder` directly;
- `collectionStore.test.ts` (16): `updateSettings`' targets, rules, and refusals, plus statics,
  presets, personas, modules, the order, plugins, and OAuth entries;
- `pluginStorageStore.test.ts` (5);
- `mutationScope.test.ts` (4): a discard before and during the flush, an unrelated one, one before
  the scope, the chat sequence.

The reviewer agreed with Opus's "not necessary" list. Gates on the final tree: `pnpm check` 0
errors; `pnpm test` 84 files, 842 passed, 3 skipped; `pnpm format:check`; `pnpm test:e2e` 5 passed.
The `docs/structure/` test inventories are updated at the closeout (slice 8 owns every guide edit).
