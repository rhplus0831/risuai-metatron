# Slice: Preset Credentials, Boot-Snapshot Comparison, And Closeout

Status: planned (drafted 2026-09-30, refined after review, not started).

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
