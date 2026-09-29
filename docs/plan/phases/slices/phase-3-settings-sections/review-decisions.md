# Review decisions: Phase 3 slices

The slices were reviewed before the phase started by GPT-6-Astra (12 points) and Claude Opus
(14 points). Every point was checked against `577c43ae` before deciding: direct reads of the
cited files, and one Luna fan-out for the two searches (the id-less creation sites of the four
id-bearing collections; `forceReplaceUrl2` and the element exports). The refined slices are the
seven in this folder.

## Astra

- Astra P1, normalization lacks a persistence and acknowledgement protocol: adopt — verified
  (`cycle` in `resourceSync.svelte.ts` records `op.text`; `ResourceBatchResult` carries revisions
  only). No normalize-on-read; ids are client-assigned at every creation site with the server
  normalizer as a backstop, and a startup pass persists normalized records with a revision bump
  (slice 3); databases without ids from before the phase are refused by the schema bump (slice 6).
- Astra P2, capturing selection in the accessor is too late for deferred writers: adopt —
  reproduced by the wrapper source (`localValue` plus two `$effect`s in seven wrappers). Slice 5
  rewrites the wrappers to synchronous function bindings, the spike proves the old pattern
  misroutes and the new one does not (proof 4), and every asynchronous writer (`selectUserImg`,
  the preset image handler) captures the id before its first `await`.
- Astra P3, selection handling does not survive collection replacement: adopt — the getter and
  setter resolve the record from the selection id and the current collection on every access (no
  cached object), `reconcileSelection` runs after every collection replacement or removal, and
  all three selection keys leave `root` (spike proof 5, slice 5, slice 6).
- Astra P4, preset and credential changes are not an atomic operation: reject — in the
  single-client case the preset copy and its `llmSecrets` entry are dirty in the same cycle and
  travel in one atomic batch, so nothing is lost; the loss needs a 409 on `llmSecrets` alone from
  another device, and this is an alpha, single-user project. Recorded verbatim as residual risk
  of slice 7 with the scenario; no lifecycle ops or indivisible batch groups.
- Astra P5, credential classification and validation are incomplete: adopt with changes —
  `supaMemoryKey` (OpenAI completions in `supaMemory.ts`, verified) moves to `llmSecrets`;
  Imagen's use of `google.accessToken` (`stableDiff.ts:695`, verified) and the `openAIKey`
  TTS/DALL-E uses are recorded as auxiliary consumers for Phase 5; `vertexAccessTokenExpires`
  gets a finite-number validator; the "only a read filter" claim is removed. Changed:
  `customModels[].key` stays in the `customModels` collection in Phase 3 (proposed default) with
  the `llmSecrets` alternative as an open question; mixed containers still move whole (allowed
  either way by invariant 6, and a split buys nothing before Phase 5).
- Astra P6, the per-preset secret map has no implementing owner: adopt — `llmSecretPresets` is
  owned by slice 4 (`src/ts/storage/llmSecrets.svelte.ts`: assembly, projection, watcher,
  conflict reload, lifecycle helpers); `openAIKey` is an ordinary flat field, the extra accessor
  is gone.
- Astra P7, moving prompt normalization introduces a proxy-cloning failure: adopt — confirmed
  (`safeStructuredClone` exists precisely because native `structuredClone` throws on the proxy).
  The shared normalizers clone with a plain recursive JSON clone and every client caller passes
  `$state.snapshot` of a proxied value (slice 5).
- Astra P8, proposed defaults do not preserve the fresh-boot behavior: adopt — verified
  (`maxResponse` 500 vs 300, the textgen URLs, `loreBookToken` 8000 after `checkNewFormat` even on
  a fresh boot, the empty translator prompt). Step 0 captures the pre-phase boot snapshot before
  slice 2, `PRESET_FIELDS` defaults are taken from it, and slice 7 states a comparison rule that
  canonicalizes ids and the two shape changes instead of dropping differences.
- Astra P9, the dependency graph and allowed files cannot support the intermediate states:
  adopt — the taxonomy, alias maps, id-bearing types, and every constructor and
  identity-preserving writer are activated together in slice 2 (which now edits the client
  creation sites); `llmSecrets` is registered in slice 3 with the other sections;
  `shared/settings.ts`, `shared/memory.ts`, and `shared/database.ts` are in slice 2's allowed
  files; the forwarding slices depend on slice 4, which depends on slice 3.
- Astra P10, the spike cannot execute its stated proofs within its scope: adopt with changes —
  the spike is a vitest-only harness with its own stable ids and a switch that only changes the
  selection, and the fixtures are step 0 gating slices 1 and 2. Changed: no browser proofs in the
  spike (the manual checks move to slice 5), and the fallback plan now states how the plugin
  setters stay effective.
- Astra P11, leaving the root row makes newly created backups unrestorable: adopt — verified
  (`backupTo` copies the file, `readSnapshot` refuses unregistered kinds). Slice 6 bumps
  `SCHEMA_VERSION` to 3 and refuses version 2 at startup and in `readSnapshot`, matching the
  version-1 precedent; no silent purge.
- Astra P12, artifact validation conflates compatibility with identical serialization: adopt —
  decoded deep comparison ignoring key order and `id`, redaction and no-id assertions, the
  pre-phase `importPreset` logic run over the new export, a non-default `custom.risup` fixture,
  `.risutl` and the HypaV3 JSON export covered; byte identity dropped as a criterion.

Astra's drift corrections: the new-preset button clones `prebuiltPresets.OAI2` (adopted); after a
`delete` the setter still runs and reads are shadowed (adopted, text corrected); `hypaMemoryKey`
removed from `secrets` (adopted); the `customColorScheme` rule kept inside `ui` (adopted); the
partition test now includes the Phase 1 fields, the selection keys, and both fields of each
`{ items, selectedId }` pair (adopted); the `providers` list recounted to 65 (adopted).

## Opus

- Opus P1, server-assigned ids and normalized data never reach the client that wrote them:
  adopt — fix (a): client-assigned ids at every creation site (the list from the Luna fan-out is
  in slice 2), server backstop, a startup pass that persists instead of normalize-on-read, and
  the schema bump removes the legacy id-less rows.
- Opus P2, the leftover `root` row makes every post-phase snapshot and archive unrestorable:
  adopt — `SCHEMA_VERSION` 3 in slice 6 with the version-2 refusal message; the purge alternative
  rejected as silent deletion.
- Opus P3, the empty-save boot snapshot cannot match on forwarded fields: adopt —
  `PRESET_FIELDS` defaults are the pre-phase boot values (captured in step 0), materialization
  uses `normalizePreset({ name: "New Preset" })`, `presetTemplate` stays the `importPreset` base,
  and slice 7 states the comparison rule.
- Opus P4, preset migrations and nested defaults are not ported: adopt — verified in
  `setDatabase`/`setPreset`: the nested `NAIsettings`, `promptSettings.maxThoughtTagDepth`,
  `formatingOrder` insertion, `top_p`, `localNetworkMode` coercion, `seperateParameters.overrides`,
  `fallbackModels` filter, `customAPIFormat` default, and the preset-owned `openrouterProvider`
  migration are listed in slice 2's `normalizePreset` scope and tests and removed from slice 3.
- Opus P5, `autoSuggestPrefix` and `autoSuggestClean` are effectively global today: adopt —
  verified (`saveCurrentPreset` never writes them). They become `ui` fields, leave
  `PRESET_FIELDS`, and are not forwarded (70 forwarded keys plus `proxyKey`); recorded as a
  behavior change only in that exported presets never carried them.
- Opus P6, the planned round-trip check fails without a regression: adopt — same fix as Astra
  P12.
- Opus P7, an exit criterion contradicts the accepted keep-on-switch hazard: adopt — the two-tab
  check excepts the five keep-on-switch fields, and `planning-notes.md` proposes the phase-file
  edit to the exit criterion.
- Opus P8, the `llmSecrets` boundary runs backwards: adopt — `llmSecrets` is registered in slice
  3 with the other sections and its field list lives in `SECTION_FIELDS` (slice 2); slice 7
  keeps only the `proxyKey` lifecycle and the closeout; `hypaMemoryKey` is dropped everywhere.
- Opus P9, persona field-name map and persona ids: adopt — `PERSONA_ROOT_ALIASES`
  (`username`↔`name`, `userIcon`↔`icon`, `userNote`↔`note`, `personaPrompt`↔`personaPrompt`) in
  `shared/presets.ts` (slice 2).
- Opus P10, the HypaV3 export would leak the new `id`: adopt — verified
  (`OtherBotSettings.svelte:1250` writes `data: preset`); slice 4 strips `id` from that export
  and the `.risutl` exporter.
- Opus P11, the spike's form is heavier than needed: adopt — vitest-only harness, no production
  code, fixtures as step 0; the delete-semantics correction taken.
- Opus P12, slice order and size: adopt with changes — the order is now 2 → 3 → 4 (mirrors, with
  a residual `root` holding only the preset and persona working copies and the three selection
  indexes, projected from an explicit key list) → 5 (presets and selection) → 6 (personas and
  root removal), so accessors never coexist with a generic root enumeration and slices 3 and 4
  do not wait for the spike; the forwarding slice is split into presets and personas. Changed:
  the translator/HypaV3 id-and-shape change stays in slice 4 rather than a separate slice, to
  hold seven slices; the id part is already in slice 2 and the server shape in slice 3, so slice
  4 only changes two selectors and two exporters.
- Opus P13, "proposed" decisions the plan already made: adopt — the items the plan already fixed
  (`openAIKey` global, `proxyKey` per preset id, the `clientReadable` marker, the `localStorage`
  selection store, the keep-on-switch path, presets as one collection, Phase 5 applying
  `presetChain`'s id) are marked "decided by the plan" in the slices; the open questions keep
  only the shared-debounce reading, the `{ items, selectedId }` shape, dropping the three legacy
  mirror fields, the cross-section constants, `customModels[].key`, and the dead-but-visible
  toggles.
- Opus P14, identifier errors: adopt — verified: `src/ts/characters.test.ts` (5 root refs) and
  `src/ts/drive/backuplocal.test.ts` (0), `snapshots.test.ts` (0), `resourceStore.test.ts` (15)
  and `resourceClient.test.ts` (15) corrected in slices 4 and 6; the `"root"` grep excludes
  `CustomGUISettingMenu.svelte`; the canonical count is 79 while `proxyKey` stays (77 after
  removing the two auto-suggest fields, 76 after slice 7); `forceReplaceUrl2` has no reader
  (Luna fan-out) and is dropped from `PRESET_FIELDS` and kept blank in the exporter; the
  partition test lists the selection keys and the Phase 1 fields; materialization passes
  `undefined`.

Totals: Astra 9 adopt, 2 adopt with changes, 1 reject; Opus 13 adopt, 1 adopt with changes,
0 reject.
