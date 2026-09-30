# Phase 3: Settings Sections

Status: implemented on 2026-09-30 in seven slices; see Implementation Record.

Depends on: Phase 1. Independent of Phase 2. Implements the Phase 3 part of Decision 3 in `PLAN.md`.

## Objective

Split the `root` resource into typed sections with server-side defaults, move the remaining
collections out of root into their own resources, and separate per-client selection state from
data.

## Required Work

- **Sections.** Use the field taxonomy from the opening baseline: `providers` (45 provider
  settings), `secrets` (29 credential fields), `ui` (120 preferences), and `memoryTranslateMedia`
  (66 fields). The 75 preset-owned fields are not a section: they live only in the presets and are
  reached through the forwarding layer below. The 22 transient or legacy fields are dropped or
  become server-only state; record each in this file.
- **Remove the working copies.** `changeToPreset`, `saveCurrentPreset`, and `setPreset` in
  `src/ts/storage/database.svelte.ts` copy the selected preset into root and back, and
  `changeUserPersona` and `saveUserPersona` in `src/ts/persona.ts` do the same for `username`,
  `userIcon`, `personaPrompt`, and `userNote`. Replace both copies with a forwarding layer:
  `DBState.db` keeps the field names (D3) and reads and writes the selected preset or persona;
  every forwarded write is a mutation carrying the id captured at edit time, which replaces the
  current preset watcher (it observes only the selection and the array length). The Svelte 5
  `$state` proxy rejects accessors added through `defineProperty` (`state_descriptors_fixed`), so
  install enumerable accessors on the raw root before it is proxied and reinstall them in
  `setDatabaseLite` and plugin `setPluginDatabaseLite`. First run a spike on one settings page that
  proves the layer against `bind:value`, `$state.snapshot` (plugin `getDatabase` snapshots and
  exports), the `for ... in` root diff in `saveDb`, plugin `setPluginDatabase` writes, and an edit
  followed by an immediate selection switch and a reload, which must leave the edit in the original
  record. If the spike fails, add an explicit selected preset and persona projection and move the
  call sites to it instead.
- **Field map.** The layer maps the names that differ between root and preset: `NAIsettings` and
  `NAISettings`, `reasoningEffort` and `reasonEffort`, and `presetRegex` and `regex`. This map is
  the canonical preset field list the normalizer uses. A preset missing a field now gets the normalizer default instead of
  inheriting the previous preset's value through `newPres.x ?? db.x`; record this behavior change.
- **Keep-on-switch settings.** Deferred (Decision 3): `setPreset` honors
  `doNotChangeSeperateModels`, `doNotChangeFallbackModels`, and
  `disableSeperateParameterChangeOnPresetChange`, which keep `seperateModels`,
  `seperateModelsForAxModels`, `fallbackModels`, `fallbackWhenBlankResponse`, and
  `seperateParameters` across a switch. This phase leaves those five fields and the three toggles
  on today's path: root fields that `setPreset` and `saveCurrentPreset` copy exactly as today,
  outside the forwarding layer and the field map. Record the remaining cross-client shared-copy
  hazard for them in this file. The follow-up after this plan decides their owner.
- **Ids.** Presets gain a required id and `RisuPersona.id` becomes required, both assigned by the
  normalizer. `copyPreset` and `importPreset` assign fresh ids, and `downloadPreset` strips the id
  so `.risup` stays byte-compatible (superseded: compatibility is by decoded content, since the
  canonical field list changes the key order; see the Implementation Record). The normalizer keeps at least one preset, which removes the
  `botPresetsId === -1` branch in `saveCurrentPreset`, and falls back to the first record when a
  selected one disappears. `translatorPresetId` and `hypaV3PresetId` become ids with their
  collections. `selectUserImg` in `src/ts/persona.ts` assigns a new `v4()` id on
  every icon change, which breaks `bindedPersona` references; it keeps the id instead.
- **Collections still in root.** `loreBook`, `globalscript`, `hotkeys`,
  `customSidebarItems`, `characterOrder`, `authRefreshes`, `globalChatVariables`, `personas`,
  `translatorPresets`, `hypaV3Presets`, `customModels`, and `enabledModules` become small resources
  of their own.
- **Server normalizers.** Port the defaults and migrations in `setDatabase` section by section to
  pure functions under `server/src/data/normalize/` with node-environment tests, including the
  preset consistency rules between `botPreset`, `presetTemplate`, `saveCurrentPreset`, `setPreset`,
  and `importPreset` (the field sets differ today; the normalizer makes one list canonical). The
  client `setDatabase` shrinks by the same sections.
- **Client mirror.** `DBState.db` keeps the same field names (invariant D3), but each section is a
  mirror with its own debounced write. The root watcher in `saveDb` is replaced by per-section
  watchers, each deleted when its section gets explicit mutation functions.
- **Selection state.** The selected preset and persona become per-client ids, and `loreBookPage`
  becomes per-client UI state, in a client-local store (`localStorage` is acceptable). The mirror
  derives `botPresetsId` and `selectedPersona` from the ids until Phase 6. The selected chat is
  Phase 2's.
- **Secrets.** Split credentials per Decision 6: LLM provider credentials go to `llmSecrets`, the
  rest to `secrets`. `openAIKey` is effectively global today (`setPreset` never restores it), so it
  stays one global entry; `proxyKey` leaves the preset objects for `llmSecrets` keyed by preset id,
  and preset copy, delete, and import carry that entry. The forwarding layer resolves it for the
  selected preset. Both sections stay readable by the client until Phase 5 makes `llmSecrets` write-only,
  because the client still calls providers through the proxy. Mark `llmSecrets` so Phase 5 can flip it
  without a schema change.
- **Preset formats.** `downloadPreset` and `importPreset` keep the `.risup` and `.risupreset`
  formats byte-compatible (invariant D5; superseded: decoded-content compatibility, see the
  Implementation Record).
- **Docs.** `docs/structure/persistence.md` (`State`, `Recipes`), `docs/structure/settings-i18n.md`,
  and the D2 invariant, which now points at the server normalizers.

## Safety Contract

A fresh server produces the same normalized database as `setDatabase` did: compare a snapshot of
`getDatabase()` after boot on an empty save before and after the phase, ignoring the fields this
file records as dropped, with the forwarded fields read through the layer. Settings pages keep
binding to `DBState.db`.

## Exit Criteria

- No `root` resource remains.
- Every section and collection has a normalizer with tests, and the client `setDatabase` contains no
  defaults for migrated sections.
- The empty-save boot snapshot matches, apart from the recorded drops.
- Preset export and import round-trip against a `.risup` file produced before the phase.
- No root working copy of a preset or persona remains, and switching presets or personas on one
  client does not change another client's settings or presets.
- A chat bound to a persona keeps its binding after the persona's icon changes.

## Validation

Normalizer tests, a boot-snapshot comparison recorded in the phase file, a preset round-trip check,
and `pnpm check`, `pnpm test`, `pnpm format:check`.

## Implementation Record

Implemented on 2026-09-30 from a plan reviewed by GPT-6-Astra (A1 to A18) and evaluated by Claude
Fable (F-a to F-g), in seven slices with three user stops, each slice challenged by Astra and
reviewed by Fable (a Fable test-adapter adapted the tests each slice deliberately invalidated; the
Fable reviewer wrote the review-step tests; slice 7's review is recorded in its slice file). Plan,
slices, and per-slice records (decisions,
challenge points and decisions, checks):
[`slices/phase-3-settings-sections/`](slices/phase-3-settings-sections/)
(`implementation-plan.md` first). One commit per slice.

- **Schema and ids** (slice 2). `shared/sections.ts` is the field-to-resource map (`SECTION_FIELDS`,
  `COLLECTION_FIELDS`, `COLLECTION_SELECTION_FIELDS`, `FORWARDED_ROOT_KEYS`, `DROPPED_FIELDS`,
  `PHASE1_FIELDS`), checked to partition `keyof Database` at the type level and at run time.
  `shared/presets.ts` holds the canonical preset schema (`PRESET_DEFAULTS` from the fresh-boot
  values, `PRESET_FIELD_KINDS`, `PRESET_NULLABLE_FIELDS`, `normalizePreset`, `normalizePresets`).
  Presets, personas, translator presets, and HypaV3 presets carry ids from creation; copies and
  imports get fresh ids; the `.risup`, `.risutl`, and HypaV3 JSON exports carry none.
- **Server sections and collections** (slice 3). Five singleton sections (`providers`, `secrets`,
  `llmSecrets`, `ui`, `memoryTranslateMedia`) and thirteen collections (`loreBook`, `globalscript`,
  `hotkeys`, `customSidebarItems`, `characterOrder`, `authRefreshes`, `globalChatVariables`,
  `personas`, `translatorPresets`, `hypaV3Presets`, `customModels`, `enabledModules`, `statics`),
  each with a normalizer in `server/src/data/normalize/` that owns its defaults and migrations. The
  store runs a normalization pass when it opens and inside `replaceAll` (one transaction): a stale
  record is rewritten with its revision advanced, a missing `materialize` singleton is created, a
  record of a newer schema version stops the start. `llmSecrets` is marked `clientReadable` (Phase
  5 makes it write-only).
- **Client mirrors** (slice 4). `assembleDatabase` builds the flat `DBState.db` from the sections
  and collections; one watcher per record projects exactly its fields (`JSON.stringify` of the live
  values, so an own `__proto__` key of a user-keyed map survives), and the projection equals the
  server's normalized text, so an idle boot writes nothing (`normalize(project(assemble(x))) === x`
  for every kind). `setDatabase` keeps only the Phase 1 guards, the removed-feature deletions, and
  the preset and persona backstops. `translatorPresetId` and `hypaV3PresetId` are ids.
- **Forwarding layer** (slices 5 and 6). `src/ts/storage/forwarding.svelte.ts` installs enumerable
  accessors on the raw database before it is proxied: the flat preset fields read and write the
  selected preset, `proxyKey` that preset's `llmSecrets.presets` entry, the four persona fields the
  selected persona, and `botPresetsId`, `selectedPersona`, and `loreBookPage` the per-client
  selection (`selection.svelte.ts`: `sessionStorage` per tab, `localStorage` for a new tab). Every
  access resolves the record anew; a read with a stale id falls back to the first record and
  selects it (the only write a read makes: the selection, never a preset or persona record); a write
  with a stale id is dropped, never redirected. The settings wrappers write synchronously through
  function bindings, so an edit lands in the record selected at that moment. The preset image and
  the persona icon capture their target before their file dialog; persona import finishes its image
  before it reads the live list; the plugin `setDatabase` awaits its install prompt before it
  assigns anything, into the records selected then. `changeToPreset(id)` copies only the five
  keep-on-switch fields; hotkeys and `presetChain` switch by id.
- **Root removal** (slice 6). The `root` kind is gone, and the resource database is version 3: a
  version-2 file is refused at startup with a message naming it, and a snapshot or archive of
  another version is refused on restore (the reset point; no migration is owed).
- **Credentials and closeout** (slice 7). `proxyKey` left `PRESET_FIELDS`: preset objects carry no
  credentials (the server normalizer keeps only the canonical fields); `.risup` exports still write
  `proxyKey`, `openAIKey`, and the endpoint fields blank, and every canonical field (an unset one as
  an explicit `undefined`), so a decoded export has the pre-phase key set and values. Byte identity
  is not kept: the canonical field list changes the key order.

Dropped or server-only fields (`DROPPED_FIELDS`, never produced by the assembly): `saveTime`,
`lastPatchNoteCheckVersion`, `hubServerType`, `disableAprilFools`, `geminiStream`, `claudeAws`,
`falLoraName`, `fullScreen`, `NAIREF`, `customGUI`, `checkCorruption`,
`toggleConfirmRecommendedPreset`, `hypaMemoryKey`, `cipherChat`, `claudeCachingExperimental`,
`antiClaudeOverload`, `emotionPrompt` (no reader, write-only, or legacy flags);
`translatorPrompt`, `translatorMaxResponse`, `hypaV3Settings` (legacy mirrors of the selected
translator and HypaV3 preset, read only by their own sync code); `formatversion` (its migrations
were dropped). The `botPresets[0]` template payload and the root working copies are gone.

Boot-snapshot comparison (Safety Contract; `boot-snapshot.json` from `4914ccc7`, before any
Phase 3 change, against a fresh boot of the final tree through the forwarding layer, by the rule
in `credentials-and-closeout.md` amended by A10): every root field outside `DROPPED_FIELDS` and
the selection keys equals its value before, apart from nine preset fields the pre-phase first boot
left unset in the root (`moduleIntergration`, `JinjaTemplate`, `jsonSchemaEnabled`, `jsonSchema`,
`extractJson`, `groupTemplate`, `thinkingTokens`, `outputImageModal`, `dynamicOutput`), which now
read the canonical default (`""`, `false`, or `null`: the value `saveCurrentPreset` already wrote
into every preset); the selected preset equals the old effective root through
`PRESET_ROOT_ALIASES` with the same nine exceptions (the keep-on-switch fields are `providers`
fields and equal there); `personas[0]` and the translator and HypaV3 preset lists are equal apart
from ids, with the first item selected; every other collection is deep-equal.

Recorded behavior changes:

- Settings of a store older than version 3 are not carried over: such a server refuses to start
  (move or delete `save/data/resources.sqlite`). A store created by slices 3 to 5 showed section
  defaults instead of its old root values.
- A preset lacking a field reads the canonical default; nothing is inherited from the previously
  selected preset. A `null` is kept only in `PRESET_NULLABLE_FIELDS` and the keep-on-switch fields;
  any other becomes the default when the server stores it (a cleared number field comes back as
  its default after a reload; `systemContentReplacement` `null` now becomes `"system: {{slot}}"`).
- Preset objects carry no `openAIKey` or `proxyKey`; a key stored in a preset before this phase is
  not moved to `llmSecrets` (re-enter it). Copy, import, and delete carry the `proxyKey` entry.
- `autoSuggestPrefix` and `autoSuggestClean` are `ui` fields; the keep-on-switch fields and their
  three toggles are `providers` fields; `statics` is its own collection.
- The preset, persona, and lorebook page selection is per client (per tab, restored on reload; a new
  tab starts from the last choice), not shared data. A plugin's `setDatabase({ selectedPersona })`
  selects on its client only, and is applied after `personas` whatever the key order.
- Deleting the selected preset or persona selects the first remaining one; deleting another one
  keeps the selection (the old code always switched to the first). A reorder keeps the selection.
- Changing a persona's icon keeps its id, so a chat bound to it stays bound.
- `personas` is never empty and every persona has string `name`, `icon`, `personaPrompt`, and
  `note`, on the server, in `setDatabase`, and in the plugin setters.
- `translatorPresetId` and `hypaV3PresetId` are string ids (the selection falls back to the first
  item); every element carries an id.
- Hotkeys 1 to 9 and `presetChain` switch presets by id; preset hotkeys are ignored while the popup
  editor is open.
- The cross-section defaults are constants equal to the fresh-boot values (they held only for
  fresh stores before). The `mainPrompt` and `formatversion` migrations were dropped;
  `loreBookToken` 8000 is the default.
- A plugin's `null` or `undefined` for a section, collection, or selection field is refused with a
  warning and the value kept.
- The server validates every section and collection: a field of the wrong JSON kind gets its
  default, a record that is not the right container or a collection element of the wrong shape is
  rejected with a 400, and numeric strings in `chatLoadInitialPages`/`chatLoadAdditionalPages` get
  the default (they were parsed before).
- The server's startup normalization pass reads every record of every kind (characters included;
  chats are in their own tables), so start time grows with the data, and a stored record its
  normalizer rejects stops the start, naming the kind and id.
- "An idle boot writes nothing" holds apart from two intended boot mutations: `checkCharOrder`
  repairing `characterOrder` against the characters, and onboarding (`WelcomeRisu`) writing the
  browser language.
- A conflict reload of `ui` assigns its fields but does not rerun the presentation functions
  (language, theme, CSS, animation speed, sizes) until the next reload; the same held for `root`
  before.

Not done in this phase (invariant 2): no collection switches to explicit mutations. The preset and
persona writes go through the forwarding layer into the `presets` and `personas` records, which the
save adapter still diffs and writes whole, so two clients editing different presets conflict at the
collection revision and one reloads.

Residual risk: the five keep-on-switch fields and their three toggles are shared `providers`
fields that `changeToPreset` copies, so two clients with different presets still overwrite each
other's copies (the exit criterion "switching presets on one client does not change another
client's settings" holds apart from them; Decision 3's follow-up decides their owner). A preset
copy, import, or delete that conflicts on only one of `presets` and `llmSecrets` reloads that
record while the other change retries (a restored preset can lose its `proxyKey` entry; accepted
for this alpha). `llmSecrets` and the `customModels[].key` values stay client-readable until Phase
5; the client-side consumers of LLM credentials outside the request layer need a decision for
Phase 5's write-only flip: `openAIKey` in `tts.ts`, `stableDiff.ts` (DALL-E), and
`PlaygroundSubtitle.svelte` (transcription), `google.accessToken` in `stableDiff.ts` (Imagen), and
the model discovery in `model/modellist.ts` (Google, Anthropic, and OpenAI keys). `presetChain` still switches the client's selection on
every send until Phase 5. A user-defined send hotkey can still switch presets through `presetChain`
while the popup editor is open.

Validation: `pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`, and `pnpm test:e2e` on
every slice from slice 4; per-slice Playwright checks on system Chrome against a fresh server
(recorded in the slice files): first boot and idle reload, edit then switch then reload (also a
real settings-page edit followed by a hotkey switch while the input has focus), two clients with
different presets and personas, conflict reloads, the `proxyKey` lifecycle, a persona's icon change
keeping its chat binding, the version-2 refusal, backup export, import, and snapshot restore, and
every settings page opening without a new error. Docker (`risu-metatron:phase3`, fresh volume): the
first run creates every section and collection at version 3, edits of `ui`, `presets`, and
`personas` survive `docker restart` (graceful, SIGTERM logged), a reload afterwards writes nothing,
and an archive export, its import, and a snapshot restore succeed with the data intact.
