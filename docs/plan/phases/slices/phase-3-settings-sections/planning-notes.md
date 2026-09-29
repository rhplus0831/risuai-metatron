# Planning notes: Phase 3 (Settings Sections)

## Provenance

Drafted 2026-09-30 on `metatron` at `577c43ae`, before the phase started, as a validation of
[`phase-3-settings-sections.md`](../../phase-3-settings-sections.md) against the tree after
Phases 0 to 2. Reviewed by GPT-6-Astra (12 points) and Claude Opus (14 points), then refined;
the decision on every point is in [`review-decisions.md`](review-decisions.md). The slices are
the seven in this folder, in the order of [`README.md`](README.md).

## Drift between the phase file and the tree

Every identifier in the phase file was re-verified. Each item gives the evidence and the
proposed phase-file edit (the phase file itself is edited when the phase runs, by slice 7).

1. **"The current preset watcher (it observes only the selection and the array length)" no
   longer exists.** It was the pre-Phase 1 `changeTracker.botPreset` effect
   (`git show 46d63674^:src/ts/globalApi.svelte.ts`, lines 270-272). Phase 1 replaced it with a
   deep watcher in `resourceSync.svelte.ts` `startResourceSync`
   (`$state.snapshot(DBState.db.botPresets)`). Edit: "every forwarded write lands in the selected
   record by id; the deep `presets` watcher of Phase 1 saves it".
2. **The `for ... in` root diff is not in `saveDb`.** `saveDb` only calls `startResourceSync`. The
   diff is `projectCollection("root")` and the root `$effect` in `resourceSync.svelte.ts`; the
   `root` branch of `applyToMirror` also deletes keys the server record lacks. On Svelte 5.57.1,
   `deleteProperty` shadows an accessor's reads for good (writes still reach the setter). The
   slice order avoids the coexistence: the residual root is projected from an explicit key list
   (slice 4) before any accessor exists (slice 5). Edit: name the sites.
3. **Reinstalling accessors in plugin `setPluginDatabaseLite` is unnecessary and would throw.**
   It, `setPluginDatabase`, `importPlugin` (`plugins.svelte.ts`), and `WelcomeRisu.svelte:76` pass
   the live proxy back; only `bootstrap.ts` hands a raw object to `setDatabase`. `defineProperty`
   through the proxy throws `state_descriptors_fixed`; the install is idempotent by descriptor
   check. Edit: "install in `setDatabaseLite` for a raw object".
4. **Server-assigned ids and normalized data never reach the writing client.** `cycle` records
   `op.text` as the persisted text and `ResourceBatchResult.results` carries revisions only. The
   phase file's "both assigned by the normalizer" cannot be the primary mechanism. Edit: "ids are
   assigned by the client at creation (as Phase 2 does for message ids); the server normalizer
   keeps them and backstops; a startup pass persists any normalization so reads are
   deterministic".
5. **Fresh-boot defaults are not `presetTemplate`'s.** `setDatabase` defaults `maxResponse` 500
   (template 300), `textgenWebUIStreamURL` `"wss://localhost/api/"` and `textgenWebUIBlockingURL`
   `"https://localhost/api/"` (template `""`); `checkNewFormat` raises `loreBookToken` 800 to 8000
   on a fresh boot; `getDefaultTranslatorPreset` seeds an empty prompt. Edit: the pre-phase
   snapshot is captured before the phase (step 0) and is the source of the server defaults.
6. **The leftover `root` row would make every later snapshot unrestorable.** `backupTo` copies
   the whole file and `readSnapshot` refuses unregistered kinds. Slice 6 bumps `SCHEMA_VERSION`
   to 3 and refuses version 2, as version 1 is refused today. Edit: record under the safety
   contract that version-2 databases, snapshots, and archives are refused (no migration owed).
7. **A byte-identical `.risup` round trip cannot pass.** `encryptBuffer` has a fixed IV, so
   bytes follow msgpack key order; `saveCurrentPreset` writes keys in literal order and omits
   `autoSuggestPrefix`/`autoSuggestClean`; the canonical list changes the order. Edit: the exit
   criterion becomes a decoded comparison ignoring key order and `id`, plus the pre-phase reader
   accepting the new export.
8. **Deferred writes in the settings wrappers.** Seven wrappers
   (`src/lib/Setting/Wrappers/Setting{Check,Number,Text,Textarea,Select,Slider,Color}.svelte`)
   write through an `$effect` on a `localValue`, so an edit and a switch in one flush misroute;
   the spike proves it and slice 5 rewrites them to synchronous function bindings; asynchronous
   writers capture the id before their `await` (`selectUserImg`, the preset image handler).
9. **Preset key counts:** `presetTemplate` 30, `saveCurrentPreset` 78, `setPreset` 77 keys.
   `setPreset` restores `autoSuggestPrefix` and `autoSuggestClean` that `saveCurrentPreset` never
   writes, so they are global today: they become `ui` fields, not forwarded. `forceReplaceUrl2`
   has no reader (template and exporter only): dropped from the canonical list. Canonical list:
   77 keys while `proxyKey` stays, 76 after slice 7.
10. **Nested preset migrations live in the root copy today:** `NAIsettings.starter`, `cfg_scale`,
    `mirostat_tau`, `mirostat_lr`; `promptSettings.maxThoughtTagDepth`; the `formatingOrder`
    insertion of `"personaPrompt"`; the `top_p` non-number fix; the `localNetworkMode`/`localNetworkTimeoutSec`
    coercion; `seperateParameters.overrides`; the `fallbackModels` empty-string filter; the
    `customAPIFormat` default; `openrouterProvider` string-to-object. All move into
    `normalizePreset` (slice 2).
11. **Preset-creating paths beyond `copyPreset` and `importPreset`:** `promptConvertion`
    (`prompt.ts:356`, `:437`), the new-preset button (`botpreset.svelte:338-342`, cloning
    `prebuiltPresets.OAI2`), `importPreset` callers `App.svelte:98` and `characterCards.ts:388,426,459`,
    `WelcomeRisu.svelte:76` calling `setPreset`. Persona creators without ids: the
    create-from-scratch push (`PersonaSettings.svelte:115`), `importUserPersona` (`persona.ts:126`),
    `interchangeability.ts:136,176`, plugin `setDatabase({ personas })`. Edit: list them under
    "Ids".
12. **`assembleDatabase` (Phase 1) already defaults an empty preset list** to `presetTemplate`
    and `botPresetsId = 0`; server materialization replaces it. Persona ids are already assigned
    on the client in four places (`checkNewFormat`, `PersonaSettings.svelte:30`,
    `SideChatList.svelte:396-404`, `CustomSidebar.svelte:66-68`) and chats bind by id
    (`Chat.bindedPersona`, resolved in `util.ts:69-82`).
13. **A third working copy the phase file does not mention:** `translatorPrompt` and
    `translatorMaxResponse` mirror the selected translator preset
    (`syncCurrentTranslatorPresetToLegacyFields` in `translator/presets.ts`), and `hypaV3Settings`
    seeds the first HypaV3 preset (`database.svelte.ts:623-627`). No runtime reader; proposed
    drop (open question 3).
14. **`translatorPresetId` and `hypaV3PresetId` are numbers and their elements have no id**
    (`TranslatorPreset` in `shared/settings.ts`, `HypaV3Preset` in `shared/memory.ts`). Making
    them ids needs `id` on both types; the `.risutl` encoder already rebuilds
    `{ name, prompt, maxResponse }` (no leak); the HypaV3 JSON export
    (`OtherBotSettings.svelte:1250`, `data: preset`) must strip it. Readers to change:
    `stores.svelte.ts:173`, `hypav3.ts:1549`, `OtherBotSettings.svelte`, `translator/presets.ts`,
    `TranslatorPresetSettings.svelte`. Edit: say so.
15. **Credential classification.** 33 credential-bearing top-level fields plus keys inside
    `customModels[]` and `authRefreshes[]` and the per-character `oaiTTSConfig.apiKey`.
    `supaMemoryKey` is sent to OpenAI completions (`supaMemory.ts`) and is an LLM credential;
    `google.accessToken` is also used by Imagen (`stableDiff.ts:695`) and `openAIKey` by TTS and
    DALL-E; `vertexAccessToken`/`vertexAccessTokenExpires` are a runtime cache written by
    `request/google.ts:512-516` through `setDatabase(db2)`; `hypaMemoryKey` has no reader. Edit:
    record the two lists below and the `google.ts` writer.
16. **Plugin `allowedDbKeys` cross the new boundaries** (forwarded preset fields
    `temperature`, `maxContext`, `maxResponse`, `frequencyPenalty`, `PresensePenalty`,
    `moduleIntergration`; keep-on-switch `seperateModels`, `seperateModelsForAxModels`;
    `selectedPersona`, `personas`, `characterOrder`, `enabledModules`; `ui` fields). All keep
    working through the flat mirror; `setDatabase({ selectedPersona })` becomes per client.
    `risuai.d.ts` `DatabaseSubset` lacks `selectedPersona` and `characterOrder` (pre-existing).
17. **No pre-phase fixtures exist** (no `.risup`, no boot snapshot tracked). Step 0 captures
    them before slice 2, which derives defaults from the snapshot.
18. **"Transient or legacy" is 21 dropped fields plus the 3 selection keys** (list below); four
    the phase file may have counted are already gone (`account`, `coldstorage`,
    `enableRemoteSaving`, `largeChatPerformanceMode`).
19. **Per-section "own debounced write":** one loop with per-section dirty keys is proposed
    (open question 1); a timer per section would multiply requests.
20. **`checkNewFormat` root steps** (persona ids, `formatversion` path cleaning, `loreBookToken`
    floor, `characterOrder` default, the `mainPrompt` migration with its `oldJailbreak` bug):
    proposed dropped except the `loreBookToken` value, which becomes the default (8000).
21. **Exit criterion vs Decision 3:** "switching presets on one client does not change another
    client's settings" fails by design for the five keep-on-switch fields. Edit: except them
    (text below).
22. **Invariant 2 statement:** the phase file should say that no collection switches to explicit
    mutations in Phase 3 and no watcher is deleted.
23. **Docs list.** Also affected: `characters-modules.md` (the persona `State` line),
    `media-aux.md` (translator presets by id, no legacy sync), `memory.md` (HypaV3 presets by
    id), `self-host-server.md` (kinds, `State`), `global-api.md` (`saveDb`), D1 and D4.

No conflict with the STRUCTURE.md or PLAN.md invariants was found. D3 is respected by keeping
every field name flat in `DBState.db`; D5 by stripping ids in the exporters and comparing
decoded artifacts.

### Proposed phase-file records

**Section taxonomy** (`SECTION_FIELDS` in `shared/sections.ts`; the partition test fixes the
final lists):

- `providers` (65): `loreBookToken`, `additionalPrompt`, `descriptionPrefix`, `requestRetrys`,
  `useStreaming`, `usePlainFetch`, `openrouterMiddleOut`, `openrouterFallback`,
  `nanogptRequestModel`, `nanogptRequestModelName`, `nanogptProvider`,
  `nanogptUseSubscriptionEndpoint`, `nanogptSubscriptionState`, `autofillRequestUrl`,
  `generationSeed`, `newOAIHandle`, `gptVisionQuality`, `reverseProxyOobaMode`, `chainOfThought`,
  `genTime`, `additionalParams`, `applyAdditionalParamsToAll`, `ollamaURL`, `ollamaModel`,
  `ollamaModelSource`, `ollamaInputMode`, `ollamaRequestFormat`, `ollamaModelName`,
  `ollamaCloudModel`, `ollamaCloudModelName`, `ollamaThinkingMode`, `autoContinueChat`,
  `autoContinueMinTokens`, `removeIncompleteResponse`, `customTokenizer`, `useTokenizerCaching`,
  `OAIPrediction`, `vertexRegion`, `googleClaudeTokenizing`, `banCharacterset`,
  `inlayErrorResponse`, `antiServerOverloads`, `automaticCachePoint`, `claudeRetrivalCaching`,
  `claudeBatching`, `claude1HourCaching`, `igpPrompt`, `openAIFlexProcessing`,
  `rememberToolUsage`, `simplifiedToolUse`, `streamGeminiThoughts`, `echoMessage`, `echoDelay`,
  `dynamicModelRegistry`, `seperateParametersByModel`, `saveSignatures`, `presetChain`, and the
  keep-on-switch group `seperateModels`, `seperateModelsForAxModels`, `fallbackModels`,
  `fallbackWhenBlankResponse`, `seperateParameters`, `doNotChangeSeperateModels`,
  `doNotChangeFallbackModels`, `disableSeperateParameterChangeOnPresetChange` (open question 6).
- `llmSecrets` (18 flat + the per-preset map): `openAIKey`, `claudeAPIKey`, `openrouterKey`,
  `nanogptKey`, `mistralKey`, `cohereAPIKey`, `ollamaApiKey`, `novellistAPI`, `mancerHeader`,
  `supaMemoryKey`, `google`, `hordeConfig`, `novelai`, `vertexPrivateKey`, `vertexClientEmail`,
  `vertexAccessToken`, `vertexAccessTokenExpires` (finite number), `OaiCompAPIKeys`; plus
  `presets: Record<presetId, { proxyKey }>`.
- `secrets` (13, auxiliary, client-readable): `NAIApiKey`, `elevenLabKey`, `voyageApiKey`,
  `deeplOptions`, `deeplXOptions`, `huggingfaceKey`, `fishSpeechKey`, `stabilityKey`, `falToken`,
  `hypaCustomSettings`, `openaiCompatImage`, `wavespeedImage`, `googleSearchCredentials`.
- `memoryTranslateMedia` (56): `loreBookDepth`, `supaMemoryPrompt`, `translator`,
  `autoTranslate`, `sdProvider`, `webUiUrl`, `sdSteps`, `sdCFG`, `sdConfig`, `NAIImgUrl`,
  `NAIImgModel`, `NAII2I`, `NAIImgConfig`, `ttsAutoSpeech`, `emotionPrompt2`, `voicevoxUrl`,
  `supaModelType`, `useAutoTranslateInput`, `imageCompression`, `hypaMemory`, `hypav2`,
  `hypaModel`, `emotionProcesser`, `translatorType`, `translatorInputLanguage`, `htmlTranslation`,
  `removePunctuationHypa`, `noWaitForTranslate`, `maxSupaChunkSize`, `hanuraiTokens`,
  `hanuraiSplit`, `hanuraiEnable`, `combineTranslation`, `dynamicAssets`, `hypaAllocatedTokens`,
  `hypaChunkSize`, `dallEQuality`, `stabilityModel`, `stabllityStyle`, `legacyTranslation`,
  `comfyConfig`, `comfyUiUrl`, `falModel`, `falLora`, `falLoraScale`,
  `translateBeforeHTMLFormatting`, `autoTranslateCachedOnly`, `hypaV3`,
  `useExperimentalGoogleTranslator`, `playMessageOnTranslateEnd`, `newImageHandlingBeta`,
  `ImagenModel`, `ImagenImageSize`, `ImagenAspectRatio`, `ImagenPersonGeneration`.
- `ui` (about 110): `askRemoval`, `jailbreakToggle`, `language`, `zoomsize`, `customBackground`,
  `playMessage`, `iconsize`, `theme`, `waifuWidth`, `waifuWidth2`, `swipe`, `instantRemove`,
  `textTheme`, `customTextTheme`, `useSayNothing`, `didFirstSetup`, `showUnrecommended`,
  `useExperimental`, `roundIcons`, `textScreenColor`, `textBorder`, `textScreenRounded`,
  `textScreenBorder`, `sendWithEnter`, `fixedChatTextarea`, `clickToEdit`,
  `enableBlockPartialEdit`, `enableDragPartialEdit`, `useAutoSuggestions`, `autoSuggestPrefix`,
  `autoSuggestClean`, `useChatCopy`, `classicMaxWidth`, `useChatSticker`,
  `useAdditionalAssetsPreview`, `personaNote`, `assetWidth`, `animationSpeed`,
  `botSettingAtStart`, `hideRealm`, `colorScheme`, `colorSchemeName`, `customColorScheme`,
  `showMenuChatList`, `allowAllExtentionFiles`, `memoryLimitThickness`, `sideMenuRerollButton`,
  `requestInfoInsideChat`, `heightMode`, `textAreaSize`, `sideBarSize`, `textAreaTextSize`,
  `dynamicAssetsEditDisplay`, `goCharacterOnImport`, `font`, `customFont`, `lineHeight`,
  `useLegacyGUI`, `hideApiKey`, `unformatQuotes`, `enableDevTools`, `customCSS`, `customQuotes`,
  `customQuotesData`, `guiHTML`, `notification`, `assetMaxDifference`,
  `auxModelUnderModelSettings`, `menuSideBar`, `showSavingIcon`, `showPromptComparison`,
  `realmDirectOpen`, `bulkEnabling`, `showTranslationLoading`, `returnCSSError`,
  `localActivationInGlobalLorebook`, `showFolderName`, `showMenuHypaMemoryModal`,
  `promptInfoInsideChat`, `promptTextInfoInsideChat`, `showFirstMessagePages`,
  `enableScrollToActiveChar`, `settingsCloseButtonSize`, `promptDiffPrefs`, `enableBookmark`,
  `hideAllImages`, `autoScrollToNewMessage`, `alwaysScrollToNewMessage`, `newMessageButtonStyle`,
  `chatLoadInitialPages`, `chatLoadAdditionalPages`, `streamingDisplayOptimizationMode`,
  `createFolderOnBranch`, `hamburgerButtonBottom`, `blockquoteStyling`, `enableRisuaiProTools`,
  `epEnabled`, `keepSessionAlive`, `longPressToPopupEditor`, `statics`, `irisDialogue`,
  `legacyMediaFindings`, `showMemoryLimit`, `showDeprecatedTriggerV2`,
  `moveInsteadOfCopyOnCMPConvert`, `pluginDevelopMode`, `memoryAlgorithmType`,
  `forceProxyAsOpenAI` (open question 5). The rule `customColorScheme ??= colorSchemeName ===
"custom" ? colorScheme : defaultColorScheme` stays inside `ui`.
- Forwarded preset keys (70) plus `proxyKey`, keep-on-switch (5), persona (4), selection (3),
  collections (12: `loreBook`, `globalscript`, `hotkeys`, `customSidebarItems`, `characterOrder`,
  `authRefreshes`, `globalChatVariables`, `personas`, `translatorPresets` with
  `translatorPresetId`, `hypaV3Presets` with `hypaV3PresetId`, `customModels`, `enabledModules`),
  Phase 1 fields (`characters`, `botPresets`, `modules`, `plugins`, `pluginCustomStorage`), and
  `DROPPED_FIELDS` complete the partition.

**Cross-section defaults becoming constants** (each equals the pre-phase boot value on an empty
save): `enableRisuaiProTools` → `false`; `ollamaModelSource` → `"local"`, `ollamaCloudModel` →
`""`; `hypaV3Presets` → `[createHypaV3Preset("Default")]`; `translatorPresets` →
`[createTranslatorPreset("Default")]` with an empty prompt; the `enableScrollToActiveChar` hotkey
filter moves to `hotkey.ts`.

**Dropped or server-only fields** (21 + 3 selection keys): no reader: `saveTime`,
`lastPatchNoteCheckVersion`, `hubServerType`, `disableAprilFools`, `geminiStream`, `claudeAws`,
`falLoraName`, `fullScreen`, `NAIREF`, `customGUI`, `checkCorruption`,
`toggleConfirmRecommendedPreset`, `hypaMemoryKey`, `forceReplaceUrl2` (preset key); write-only:
`cipherChat` (`openAI/requests.ts:352`), `claudeCachingExperimental` (`WelcomeRisu.svelte:159`);
migrated at load: `antiClaudeOverload`; default only: `emotionPrompt`; legacy mirrors:
`translatorPrompt`, `translatorMaxResponse`, `hypaV3Settings`; client migration marker:
`formatversion`. Leaving the persisted schema for the per-client store: `botPresetsId`,
`selectedPersona`, `loreBookPage`. Staying in `llmSecrets` until Phase 5: `vertexAccessToken`,
`vertexAccessTokenExpires`.

**Shared-copy hazard and the exit-criterion exception:** "`seperateModels`,
`seperateModelsForAxModels`, `fallbackModels`, `fallbackWhenBlankResponse`, and
`seperateParameters` stay `providers` fields that `changeToPreset` copies into the current preset
before switching and out of the new preset after, honoring `doNotChangeSeperateModels`,
`doNotChangeFallbackModels`, and `disableSeperateParameterChangeOnPresetChange`. Because
selection is per client and the section is shared, a switch on one client overwrites these five
fields for every client; accepted until the follow-up. The exit criterion 'switching presets on
one client does not change another client's settings' excepts these five fields."

**Behavior changes to record:** a preset missing a field gets the normalizer default (no
inheritance); preset objects carry no `openAIKey`, `forceReplaceUrl2`, or (after slice 7)
`proxyKey`; `autoSuggestPrefix` and `autoSuggestClean` are `ui` fields; `translatorPresetId` and
`hypaV3PresetId` are string ids and their elements carry ids; plugin
`setDatabase({ selectedPersona })` is per client; version-2 databases, snapshots, and archives are
refused; the constants above; hotkeys and `presetChain` switch by id; ids are assigned by the
client at creation; no collection switches to explicit mutations and no watcher is deleted in
this phase.

## Contingent boundaries

- **Spike verdict (slice 1).** On failure slices 5 and 6 run in fallback form (a
  `SelectedPreset` and `SelectedPersona` projection written synchronously by id; 144 preset
  `bind:` sites in 8 files, 43 assignments, the `bindKey` items, and the process-layer readers
  move to it; Phase 4's `updateSettings` and `readSetting` carry the plugin mapping). Phase 6's
  "remove the forwarding layer" then reads "remove the projection".
- **`{ items, selectedId }` shape for `translatorPresets` and `hypaV3Presets` (slice 3)** vs the
  selected id as a section field: changes slices 3 and 4 only; Phase 6 unpacks either.
- **`llmSecrets` client-readable until Phase 5:** Phase 5 needs a decision for the auxiliary
  consumers of `openAIKey` (TTS, DALL-E) and `google.accessToken` (Imagen), not only a read
  filter. The Phase 5 draft proposes moving `authRefreshes[]` into `llmSecrets`; this draft keeps
  it an auxiliary collection; reconcile before either phase starts.
- **Phase 5 `presetChain`:** the job reports the chosen preset id; the client calls
  `selectPreset(id)`.
- **`checkCharOrder` and trash pruning** stay client-side (they need `characterOrder` and
  `characters`); Phase 6 decides.
- **Batch results carry revisions only:** the client-assigned-id rule holds this. If a later
  phase needs a normalizer to change what a client sent, the batch result must return normalized
  data (recorded alternative).

## Open questions for the plan owner

1. "Own debounced write" per section: one loop with per-section dirty keys (proposed) or a timer
   per section (the phase-file wording)?
2. The `{ items, selectedId }` collection shape for translator and HypaV3 presets (proposed) or
   the selected ids as `memoryTranslateMedia` fields?
3. Drop `translatorPrompt`, `translatorMaxResponse`, and `hypaV3Settings` (proposed: no reader)?
4. The cross-section defaults becoming constants: accepted as recorded behavior changes?
5. Dead-but-visible toggles (`pluginDevelopMode`, `memoryAlgorithmType`, `forceProxyAsOpenAI`,
   `showMemoryLimit`): keep in `ui` (proposed) or drop with their settings items?
6. The three keep-on-switch toggles and `presetChain`: `providers` (proposed) or `ui`?
7. `customModels[].key`: stays in the `customModels` collection in Phase 3 (proposed default) or
   moves to `llmSecrets` keyed by custom model id with a per-model accessor now?
8. `irisDialogue` and `statics` (user data, not preferences): `ui` fields (proposed) or own
   resources?
9. The `mainPrompt`/`formatversion` migrations: drop (proposed) or port?
10. The pre-existing `getModules` gap (a bound persona's `$embedded` module is never resolved:
    `getModuleByIds` in `modules.ts` filters `db.modules` only): out of scope, recorded so it is
    not mistaken for a regression.

## Boundaries Phase 4, 5, and 6 depend on

- **Forwarding layer** (`src/ts/storage/forwarding.svelte.ts`): `installForwarding(raw)` in
  `setDatabaseLite`; 70 preset accessors, `proxyKey` over `llmSecretPresets`, four persona
  accessors, and the derived `botPresetsId`, `selectedPersona`, `loreBookPage`; records resolved
  on every access from the selection id and the current collection. Phase 6 deletes the module.
- **Selection store** (`src/ts/storage/selection.svelte.ts`): `selection.presetId`,
  `selection.personaId`, `selection.loreBookPage`; `selectPreset(id)`, `selectPersona(id)`,
  `loadSelection()`, `reconcileSelection()`; `localStorage` key `risu-selection` (a boot
  preference, not live tab sync). Phase 5 jobs report `presetId`; the client applies it.
- **Ids**: client-assigned at creation for presets, personas, translator and HypaV3 presets
  (`newPresetId`, `newPersonaId`, `createTranslatorPreset`, `createHypaV3Preset`), server
  backstop plus startup pass. Phase 4's plugin, MCP, and Lua setters must assign ids for new
  elements (Phase 4's `setPersonas` takes over the plugin path).
- **Preset schema** (`shared/presets.ts`): `PRESET_FIELDS`, `PRESET_ROOT_ALIASES`,
  `PERSONA_ROOT_ALIASES`, `PRESET_KEEP_ON_SWITCH_FIELDS`, `presetTemplate`, `normalizePreset`,
  `normalizePresets`; callers snapshot proxies before calling; `changeToPreset(id: string)`.
- **Settings write adapter** (invariant 2): `resourceSync.svelte.ts` with `COLLECTIONS` = Phase
  1 kinds + five sections + twelve collections; one projection and watcher per kind, one
  debounce, one batch; `llmSecretPresets` projected inside `llmSecrets`. No explicit mutation
  functions after Phase 3; Phase 4 routes plugins, MCP, and Lua through the flat mirror or adds
  section mutations (`updateSettings`) and deletes watchers per section; Phase 6 deletes the
  loop.
- **Per-section mirrors**: `DBState.db` stays flat (D3); `shared/sections.ts` (`SECTION_KIND`,
  `SECTION_FIELDS`, `COLLECTION_KIND`, `RESIDUAL_ROOT_KEYS` (empty after slice 6),
  `FORWARDED_PRESET_KEYS`, `DROPPED_FIELDS`) is the single field-to-resource map; Phase 6 builds
  the settings projection from it.
- **Resources after Phase 3**: sections `providers`, `secrets`, `llmSecrets` (marker
  `clientReadable: true`), `ui`, `memoryTranslateMedia` (singletons, materialized, normalized at
  startup); collections `loreBook`, `globalscript`, `hotkeys`, `customSidebarItems`,
  `characterOrder`, `authRefreshes`, `globalChatVariables`, `personas`, `translatorPresets` and
  `hypaV3Presets` (`{ items, selectedId }`), `customModels`, `enabledModules`; Phase 1 kinds
  `presets` (ids), `modules`, `plugins`, `pluginStorage`, `pluginPermissions`, `characters`,
  `inlays`; chats as in Phase 2. `root` is gone; resource database schema version 3.
- **Server normalizers**: `server/src/data/normalize/*.ts`, pure, returning new objects; the
  startup pass in `createResourceStore` and `replaceAll`; tests in `server/src/tests/`.

## Edits applied from other phases

- From the Phase 4 draft (`plugin-host-setters.md`): the `ensureIds` pass for `personas` in the
  plugin setters that slice 2 adds is superseded by Phase 4's `setPersonas`, which assigns ids
  itself; slice 2 keeps the pass until Phase 4 lands (a note in `shared-schema-and-ids.md`; no
  change to Phase 3's order).
- From the Phase 4 draft (`plugin-host-setters.md`, `plugin-call-context.md`): in the fallback
  form of `forwarding-presets-and-selection.md`, the plugin mapping of forwarded keys is carried
  by Phase 4's `updateSettings` and `readSetting`, not by `setPluginDatabase` directly.
- From the Phase 6 draft (`aggregate-removal.md`, `settings-ownership.md`): the derived index
  shims and the accessors of `forwarding-presets-and-selection.md` and `forwarding-personas.md`
  are removed when Phase 6's `aggregate-removal` deletes `forwarding.svelte.ts` whole (the Phase
  3 accessors, the three derived shims, and the Phase 6 facade that `settings-ownership` adds),
  not by a separate shim removal; the two slices say so.
