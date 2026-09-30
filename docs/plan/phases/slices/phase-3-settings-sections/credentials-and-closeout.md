# Slice: Preset Credentials, Boot-Snapshot Comparison, And Closeout

Status: implemented 2026-09-30 (record below).

Phase: [Phase 3](../../phase-3-settings-sections.md), "Secrets" (the preset lifecycle part),
"Preset formats", "Docs", the Safety Contract (the boot-snapshot comparison), and the Exit
Criteria; `PLAN.md` Decision 6 and invariants 6 and 7.

Depends on: slice 6 (`root` gone; the layer forwards `proxyKey` to `llmSecretPresets`).

## Scope

Allowed files: `src/ts/storage/database.svelte.ts` (`copyPreset`, `downloadPreset`,
`importPreset`), `src/lib/Setting/botpreset.svelte` (the delete handler),
`src/ts/storage/llmSecrets.svelte.ts` (lifecycle helpers if missing), `shared/presets.ts`
(`proxyKey` leaves `PRESET_FIELDS`), `server/src/data/normalize/presets.ts` (drops `proxyKey`
and `openAIKey` from preset objects), `src/ts/storage/tests/fixtures/phase3/` (read only), the
comparison test file, `docs/structure/persistence.md` (`Files`, `Flows`, `State`, `Invariants`,
`Recipes`, `Tests`), `docs/structure/settings-i18n.md` (`State`, `Invariants`: the preset-field
recipe names `PRESET_FIELDS`), `docs/structure/self-host-server.md` (kinds, `State`, `Tests`),
`docs/structure/characters-modules.md` (the persona `State` line), `docs/structure/media-aux.md`
(translator presets by id, no legacy sync), `docs/structure/memory.md` (HypaV3 presets by id),
`docs/structure/global-api.md` (`saveDb`), `STRUCTURE.md` (D1, D2, D4; D2 points at the server
normalizers), `docs/plan/PLAN.md` (status line), `docs/plan/phases/phase-3-settings-sections.md`
(status, records, Implementation Record), and these slice files. Tests belong to the review step.

Identifiers (verified): `downloadPreset` (blanks `openAIKey`, `forceReplaceUrl`,
`forceReplaceUrl2`, `proxyKey`, `textgenWebUIStreamURL`, `textgenWebUIBlockingURL`; writes
`presetVersion: 2`, `type: "preset"`, msgpack encrypted with `encryptBuffer` (a fixed IV, so the
bytes depend only on key order and values: Opus P6) inside `fflate` and `rpack`), `importPreset`
(accepts `presetVersion` 0 and 2, NAI presets `>= 3`, SillyTavern `prompt_order` files, plain
JSON; spreads `presetTemplate` under the file), `copyPreset`, the delete handler in
`botpreset.svelte`, `llmSecretPresets` and its helpers (slice 4), `proxyKey` readers
(`request/request.ts`, `request/openAI/requests.ts`, `request/openAI/responses.ts`,
`request/anthropic.ts`: they read `db.proxyKey`, the forwarded name), `openAIKey` readers
(`request/openAI/requests.ts`, `responses.ts`, `tts.ts`, `stableDiff.ts`), `google.accessToken`
readers (`request/google.ts`, and `stableDiff.ts` for Imagen), the settings report redaction in
`SettingsExportButtons.svelte`.

Stopping condition: a pre-phase `.risup` fixture that does not import to the same preset
(decoded comparison), or a boot snapshot that differs outside the comparison rule below.

## Assumptions

- `llmSecrets` is a section with the LLM credential fields flat in `DBState.db` (slice 4) plus
  the `presets` map in `llmSecretPresets` (slice 4), and slice 5's `proxyKey` accessor reads and
  writes that map for the selected id. `openAIKey` is an ordinary flat field (Astra P6).
- Preset objects carry `proxyKey` until this slice; `.risup` files have `proxyKey: ""` and no
  `id`, so removing the key from preset objects changes no exported value.
- The three fixtures from step 0 exist under `src/ts/storage/tests/fixtures/phase3/`.

## Proposed decisions

- `proxyKey` per preset (decided by the plan; lifecycle proposed): `copyPreset` calls
  `copyPresetSecret(from, to)`; the delete handler calls `deletePresetSecret(id)`;
  `importPreset` writes a non-empty `proxyKey` from a hand-written JSON into the map for the new
  id and never into the preset object; `downloadPreset` keeps blanking both credentials. Both
  records are dirty in the same cycle and travel in one batch. No lifecycle operation or
  indivisible batch group is added (Astra P4 rejected for this alpha, single-user project); the
  multi-device scenario is recorded below as residual risk.
- Credential classification (decided by the plan; list corrected after Astra P5, held in
  `SECTION_FIELDS` since slice 2): `llmSecrets` = `openAIKey`, `claudeAPIKey`, `openrouterKey`,
  `nanogptKey`, `mistralKey`, `cohereAPIKey`, `ollamaApiKey`, `novellistAPI`, `mancerHeader`,
  `supaMemoryKey` (OpenAI completions in `supaMemory.ts`, embeddings in `hypav2.ts`), `google`,
  `hordeConfig`, `novelai`, `vertexPrivateKey`, `vertexClientEmail`, `vertexAccessToken`,
  `vertexAccessTokenExpires`, `OaiCompAPIKeys`, plus the `presets` map; `secrets` = `NAIApiKey`,
  `elevenLabKey`, `voyageApiKey`, `deeplOptions`, `deeplXOptions`, `huggingfaceKey`,
  `fishSpeechKey`, `stabilityKey`, `falToken`, `hypaCustomSettings`, `openaiCompatImage`,
  `wavespeedImage`, `googleSearchCredentials` (`hypaMemoryKey` is dropped: no reader). A mixed
  container moves whole (the mirror shape is unchanged; a split is allowed by invariant 6 but
  buys nothing before Phase 5). `customModels[].key` stays in the `customModels` collection in
  this phase (proposed default; the alternative, `llmSecrets.customModels[id].key` with a
  forwarding accessor per custom model, is an open question for the plan owner). `authRefreshes`
  stays its own auxiliary collection (the Phase 5 draft proposes moving it into `llmSecrets`;
  reconciled in the report). Auxiliary consumers of LLM credentials recorded for Phase 5:
  `openAIKey` in `tts.ts` and `stableDiff.ts` (DALL-E), `google.accessToken` in `stableDiff.ts`
  (Imagen); Phase 5's write-only flip needs a decision for them, not only a read filter.
- Boot-snapshot comparison rule (Astra P8, Opus P3): a vitest over the real module graph boots
  the client against `storeBackedServer.ts` (the real store, so the server normalizers and the
  startup pass run) on an empty database and takes `getDatabase({ snapshot: true })`. Compared
  with `boot-snapshot.json`: (1) every root field of the fixture that is not in `DROPPED_FIELDS`
  and not a selection key must equal the post-phase value, forwarded fields read through the
  layer; (2) `botPresets[0]` is compared after `normalizePreset` of both sides, ignoring `id`;
  (3) `personas[0]` ignoring `id`; (4) `translatorPresets`/`hypaV3Presets` unpacked, ignoring
  `id` and comparing `selectedId` as "the first item"; (5) every other collection deep-equal.
  A difference is fixed in the normalizer that owns it or, only when it is a recorded behavior
  change, listed in the phase file with its reason; "dropped" is never used to absorb an
  arbitrary difference.
- `.risup` round trip (Astra P12, Opus P6): for each fixture, `importPreset` on the post-phase
  tree, then `downloadPreset`, then decode both files (`rpack`, `fflate`, `decryptBuffer`,
  msgpack) and deep-compare the preset objects ignoring key order and `id`, and assert the export
  has no `id` and blank credentials; and run the pre-phase `importPreset` logic (kept as a test
  helper copied from `577c43ae`) over the new export to prove old readers accept it. `.risutl`
  gets the same decoded round trip; the HypaV3 JSON export is checked for no `id`. Byte identity
  is not a criterion (the key order changes with the canonical list).
- Records written to the phase file (decided by the phase file; content proposed in the
  report): the dropped or server-only fields with their disposition (`DROPPED_FIELDS`), the
  shared-copy hazard for the five keep-on-switch fields and three toggles with the exit-criterion
  exception (Opus P7), the behavior changes (a preset missing a field gets the default; no
  `openAIKey` or `proxyKey` in preset objects; `autoSuggestPrefix`/`autoSuggestClean` are `ui`
  fields; `translatorPresetId` and `hypaV3PresetId` are string ids and their elements carry ids;
  plugin `selectedPersona` is per client; version-2 databases, snapshots, and archives are
  refused; the cross-section constants; hotkeys and `presetChain` switch by id), the statement
  that no collection switches to explicit mutations in this phase (invariant 2), and the
  Implementation Record in the format of Phases 1 and 2.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`, the boot-snapshot comparison test,
the decoded round trips, and the exit-criteria walk: no `root` kind or resource use remains;
every section and collection has a normalizer test; switching presets or personas in one client
does not change another client's settings apart from the five keep-on-switch fields (two
headless Chrome tabs against one server, recorded); a chat bound to a persona keeps its binding
after an icon change. Docker smoke as in Phases 1 and 2 (fresh volume, first run, settings
survive `docker restart`, a snapshot and an archive restore).

## Residual risk

Multi-device: when `presets` and `llmSecrets` are copied in one cycle and only `llmSecrets`
conflicts because another device wrote it, `recoverFromConflict` reloads `llmSecrets` (the new
entry is discarded) while the copied preset saves in the next cycle without its `proxyKey`
entry; the user re-enters the key for that preset (Astra P4, accepted for this alpha).
`llmSecrets` is readable by the client until Phase 5 (by design). Custom-model keys stay in a
client-readable collection. The shared-copy hazard for the keep-on-switch fields stays until the
follow-up after this plan.

## Implementation record

Implemented on 2026-09-30 by Opus on `2dc2efa3` (slice 6).

The `proxyKey` lifecycle (copy, delete, import into the map, `downloadPreset` blanking) moved to
slice 5 (amendment A11) and was verified there. This slice:

- `shared/presets.ts`: `proxyKey` leaves `PRESET_DEFAULTS` and so `PRESET_FIELDS` (added to
  `PresetOnlyExcluded` with a comment naming where both credentials live). `normalizePreset` keeps
  only the canonical fields, so the server `presets` normalizer (unchanged, it runs
  `normalizePresets`) drops `proxyKey` and `openAIKey` from stored presets through the startup
  pass. `presetTemplate` (the import base) and the prebuilt templates keep their `proxyKey: ""`: the
  import base is unchanged so old files import as before, and the normalizer drops the key.
- `shared/sections.ts`: `proxyKey` left the not-forwarded set (it is no longer a preset field);
  `FORWARDED_PRESET_KEYS` is still 69.
- `database.svelte.ts`: `importPreset` no longer blanks the record's `proxyKey` (there is none);
  `downloadPreset` still writes `proxyKey: ""` and `openAIKey: ""` with the endpoint fields, so the
  exported keys are those of the pre-phase format.
- Credential classification: unchanged from slice 2 (`SECTION_FIELDS`), as the decisions above
  list. `customModels[].key` stays in its collection and `authRefreshes` stays its own collection
  (recorded in the phase file for Phase 5, with the auxiliary `openAIKey` and `google.accessToken`
  consumers).
- Docs: the phase file (status, dropped fields, the boot-snapshot comparison, behavior changes,
  residual risk, Implementation Record), `PLAN.md` (status), `persistence.md` (the credential
  invariant), `settings-i18n.md` (a preset field is never a secret), `plugins-mcp.md` (test
  inventory). `STRUCTURE.md` D1, D2, and D4, `media-aux.md`, `memory.md`, `global-api.md`,
  `self-host-server.md`, and `characters-modules.md` were already current from slices 3 to 6.

Tests invalidated (6 cases in 3 files, all from `proxyKey` leaving the preset record):
`presetSchema.test.ts` (2: the `PRESET_DEFAULTS` credential list and the `PRESET_FIELDS` count
behind the 69 forwarded keys), `presetIds.test.ts` (2: the imported record no longer has
`proxyKey: ""`; the decoded export still equals the fixture), `forwarding.test.ts` (2: "the
record's field stays empty" now means absent).

Boot-snapshot comparison: run with `compareBoot.mjs` (session scratchpad; Playwright on a fresh
server, the rule above as amended by A10); the result is recorded in the phase file (nine preset
fields the pre-phase first boot left unset now read the canonical default; the keep-on-switch
fields are compared in `providers`; everything else equal apart from ids and the id selections).
The comparison as a kept vitest, the decoded `.risup` round trips through the pre-phase reader,
the `.risutl` round trip, and the HypaV3 export check belong to the review step.

Docker smoke (`dockerSmoke2.mjs`, image `risu-metatron:phase3`, fresh volume, port 6195): the
first run stores version 3 with every section and collection; a batch editing `ui.zoomsize`,
`presets[0].temperature`, and `personas[0].name` survives `docker restart` (SIGTERM logged, the
rows read back from the volume); the browser reload afterwards writes nothing; an archive export
(200), its import (200, new epoch), and the restore of the listed snapshot (200) leave the edited
values intact.

Exit-criteria walk:

- No `root` resource remains: `rg "RESOURCE_KIND.root"` and `rg 'kind: "root"'` find nothing in
  source; the server answers 400 for `root` (slice 6).
- Every section and collection has a normalizer with tests (`normalizeSections.test.ts`,
  `normalizeCollections.test.ts`, the fixed-point cases), and `setDatabase` holds no section
  defaults.
- The empty-save boot snapshot matches apart from the recorded differences (above).
- Preset export and import round-trip against the pre-phase `.risup` fixtures (`presetIds.test.ts`,
  decoded comparison).
- No root working copy remains; two clients with different presets or personas keep their own
  (slices 5 and 6, `presetSelection.spec.ts`, `personaBinding.spec.ts`), apart from the five
  keep-on-switch fields.
- A chat bound to a persona keeps its binding after an icon change (`personaBinding.spec.ts`).

Checks: `pnpm check` and `pnpm build` pass; `pnpm test` fails only the 6 invalidated cases before
the adapter.

## Astra challenge (2026-09-30) and decisions

1. The `.risup` export was a JSON copy of the normalized record, which omits unset fields
   (`promptPreprocess`, `koboldURL`, `proxyRequestModel`, `localStopStrings`, and an absent
   keep-on-switch field) that the pre-phase export carried as explicit `undefined`; an importer
   spreads `presetTemplate` under the file, so `promptPreprocess` became `false` instead of keeping
   the reader's value. The existing round trip used `toEqual`, which treats a missing key and an
   `undefined` one alike. **Adopted**: `downloadPreset` writes every `PRESET_FIELDS` key, an unset
   one as `undefined`. Verified with `risupKeys.mjs` (session scratchpad): importing each fixture and
   decoding its export gives exactly the fixture's keys, values, and `undefined`s.
2. The comparison script did not exclude the keep-on-switch fields from the selected-preset rule and
   only logged differences. **Adopted**: `compareBoot.mjs` excludes them there, compares them as
   `providers` fields against the fixture's root, asserts one initial preset, pins the nine allowed
   differences by field and value, and exits non-zero on anything else (result: 25 allowed
   differences, all of the recorded kinds, 0 unexpected).
3. The closeout left out accepted qualifications from slices 3 and 4. **Adopted**: the phase file
   now records the server validation changes, the startup pass cost and refusal, the two intended
   boot mutations, and the `ui` conflict reload not rerunning the presentation functions.
4. The Phase 5 credential consumers were incomplete. **Adopted**: `PlaygroundSubtitle.svelte` and
   `model/modellist.ts` added.
5. Overstated statements. **Adopted**: reads write only the selection; the asynchronous writers are
   described as they work; the byte-compatibility promise of the phase file's Required Work is
   marked superseded by decoded compatibility; the slice 7 review is recorded in its slice file; the
   `normalizePreset` comment recommends `plainClone`. The `persistence.md` "same keys" statement
   holds after point 1.

Astra's testing advice goes to the Fable reviewer, including a stronger Docker smoke (change the
values after the export, then check that the import and the restore bring the earlier values back).

## Fable review (2026-09-30)

Verdict: no problem. The diff (`shared/presets.ts`, `shared/sections.ts`, `database.svelte.ts`, the
docs) matches the record above; the six adapted cases are expected invalidations of `proxyKey`
leaving the record (none masks a regression: the strict `.risup` check below covers what
`toEqual` could not). Checks on the final tree: `pnpm check`, `pnpm test`, `pnpm format:check`, and
`pnpm test:e2e` (5 passed; a first run had one load-induced timeout in `personaBinding.spec.ts`
while a Docker build and the vitest suite ran beside it, and passed alone).

Tests written (every Astra testing-advice item was judged necessary and done):

- `src/ts/storage/tests/bootSnapshot.test.ts`: the boot-snapshot comparison as a kept vitest over
  the real server store (`storeBackedServer.ts`, the normalizers materialize a fresh store), by the
  A10 rule: the nine allowed differences pinned by field and value as root reads and as the
  selected preset's fields, the keep-on-switch fields compared as `providers` fields (unset in
  both roots except `fallbackModels` and `seperateParameters`), the five unset preset fields
  `undefined` in both, one initial preset, personas and the id collections equal apart from ids
  with the first item selected, every other collection deep-equal.
- `src/ts/storage/tests/presetIds.test.ts` (new describe): both fixtures through the real codecs
  with `toStrictEqual` (a missing key is not an `undefined` one), the exact key set, a second
  import/export cycle, and the pre-phase `importPreset` logic (`577c43ae`) storing the same preset
  from the new export as from the fixture, `promptPreprocess` kept `undefined`; the JSON export
  drops the unset keys as before.
- `src/ts/translator/presetsCodec.test.ts`: the `.risutl` round trip through the real codecs.
- `src/lib/Setting/Pages/OtherBotSettings.hypaV3Export.test.ts`: the page mounted on the HypaV3
  section; the export button's file is exactly `{ type, ver, data: { name, settings } }` with no id,
  and the import button gives it a fresh id and selects it.
- `server/src/tests/normalizationPass.test.ts` (new case): a stored `presets` record carrying
  `proxyKey` and `openAIKey` is rewritten once without them, ids kept, the `llmSecrets.presets`
  map untouched, and the result is a fixed point.

Docker (image `risu-metatron:phase3` rebuilt from this tree, fresh volume, port 6195; the
container and volume were removed afterwards): the first run stores version 3 with every section
and collection and the first boot writes only `modules` and `plugins`; the stored preset has no
`proxyKey` or `openAIKey` key; a batch edit V1 (`ui.zoomsize` 123, `presets[0].temperature` 42,
`personas[0].name` "Docker V1"), an archive export (200), a second edit V2 (77, 13, "Docker V2"),
then the import of the archive (200, new epoch) brought V1 back in the rows; the restore of the
safety snapshot the import took (200) brought V2 back; a browser reload afterwards sent no batch;
`docker restart` (SIGTERM logged) kept V2. The export streams a fresh snapshot without retaining
it, so the list holds only the import's safety snapshot.
