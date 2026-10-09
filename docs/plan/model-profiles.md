# Model Profiles Plan

Status: done (slices 1–6, 2026-10-09); the `submodel` slot and the
remaining global provider toggles (O7) are the open follow-ups. Split the model preset into **model profiles** (which model, with
which key, reached how) and the **model preset** (which profile each slot
uses). The auxiliary model separation (`seperateModelsForAxModels`)
becomes a per-slot profile choice, so each auxiliary model gets its own key,
endpoint, and compatibility options.

Builds on [Split Preset](split-preset.md) and [Shared API Keys](shared-api-keys.md).
It supersedes Shared API Keys decision 1 (one global key per model id).

## Terms

Three layers. The names in code must not reuse `modelInfo`, which already
means the catalogue `LLMModel` (`getModelInfo`, `resolveModelInfo`).

| Layer                   | What it is                                                                                                                 | Where                                                                                                           | Referenced by                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Model definition**    | What a model is and accepts, the same for every user: format, `LLMFlags`, tokenizer, parameters, internal id, provider URL | The catalogue (`shared/llm/models.ts`, `dynamicModelRegistry`) and custom models (`customModels`, `xcustom:::`) | Model id string                     |
| **Model profile** (new) | One way to use a definition: the definition, the key, and the connection and compatibility options                         | New collection `modelProfiles`                                                                                  | Record id                           |
| **Model preset**        | Which profile each slot uses                                                                                               | The `modelPresets` collection                                                                                   | `selection.modelPresetId` (per tab) |

Test for where a field goes: if everyone who uses this model would set it the
same way, it belongs to the definition; if it depends on how I use the model,
it belongs to the profile.

Two kinds of definition need the profile to fill them in:

- **Generic definitions** (`reverse_proxy`, `openrouter`, Ooba/Kobold/textgen,
  `nanogpt`, `ollama-*`) are only a shape. The profile supplies the URL, the
  wire format, and the upstream model name.
- **Overridable definition fields**: `enableCustomFlags`/`customFlags`
  replace a catalogue model's `LLMFlags` (`resolveModelInfo`; custom,
  `hf:::`, `horde:::`, and plugin models keep their own), and the system
  content/role replacement changes how `reformater` treats system turns. A
  wrong value silently changes the prompt shape (`llm-requests.md`
  invariants).

A custom model is a definition even though the user creates it: its URL,
format, tokenizer, and flags define the model, and it holds no key. A
reverse proxy is the opposite: its URL is chosen per use, so the URL is a
profile field.

## Product decisions

Confirmed 2026-10-09:

1. **A profile owns the key.** The credential binding moves from the three
   current stores to the profile. Two profiles can use the same model id with
   different keys (Opus on key A for chat, Opus on key B for memory).
2. **A profile owns how the model is reached and what it accepts.** Every
   model preset field except the slot choices moves to the profile (table
   below). Today these fields are shared by every slot of a preset: an
   auxiliary `reverse_proxy` request goes to the main model's
   `forceReplaceUrl`, and `customFlags` replace the auxiliary model's flags
   too (`server/src/llm/request.ts` `requestChatDataMain`, `buildContext` in
   `server/src/llm/requests.ts`).
3. **The current bindings are replaced, not kept as fallbacks.**
   - `providers.modelCredentials` is removed. A global binding per model id
     is the limit this plan removes; keeping it as a second default would
     make the key lookup three steps deep.
   - `CustomModel.credentialId` (and, per O2, the custom model's own key) is
     removed. The custom model stays a definition; a profile that uses it
     picks the key.
   - The model preset's `proxyCredentialId` (and, per O2, `proxyKey`) moves
     to the profile along with `forceReplaceUrl`.
   - Kept unchanged: the `credentials` collection, its secret values, and the
     rule that a binding that cannot be honored refuses the request
     (`noRetry`, never a fallback to another key).

## Detailed decisions

Confirmed 2026-10-09. The rest of the plan refers to them by label.

- **O1. Names.** Code: `ModelProfile`, collection `modelProfiles`
  (`RESOURCE_KIND.modelProfiles`). UI: "연결" / "Connections" (first shipped
  as "모델 정보" / "Model profiles"; see As built).
- **O2. What "no key chosen" means.** A profile has an optional
  `credentialId` and no secret of its own. With no `credentialId`, the request sends the slot's flat default
  (`openAIKey`, `claudeAPIKey`, `OaiCompAPIKeys.<id>`, ...), exactly as an
  unbound model does today. Custom models and reverse proxies have no flat
  default, so they send no key unless a named key is chosen. This removes
  `llmSecrets.customModels`, `llmSecrets.modelPresets`, `proxyKey`, and their
  `SECRET_ENTRY_MAPS` entries, leaving one place that stores LLM keys. (Not
  chosen: a per-profile secret as the default for those two, which would
  keep the inline key field.)
- **O3. Slots.** The model preset keeps the `seperateModelsForAxModels`
  toggle. It holds a main slot, a sub slot, and four auxiliary slots (`memory`,
  `translate`, `emotion`, `otherAx`). An empty or disabled auxiliary slot uses
  the sub slot, as today. Mode `submodel` (auto-suggest, the image prompt,
  trigger v2 `runLLM` with `model: "submodel"`) stays on the sub slot and does
  not get its own slot in this plan.
- **O4. Sharing and deletion.** Profiles are one collection shared by every
  model preset. Deleting a profile leaves the slots that name it dangling, and a request on
  a dangling slot refuses (`noRetry`), like a deleted key. The UI marks the
  slot "missing" and the delete confirmation lists the presets that use it.
  The collection materializes one default profile, and the default model
  preset's main and sub slots point to it.
- **O5. Requests that name a model id (`staticModel`).** Plugin v3
  `runLLMModel` takes a free-form `staticModel`, which today skips slot
  routing but still finds the key through `modelCredentials`. A
  `staticModel` request uses the main slot's profile when that profile's
  model id equals `staticModel`. Otherwise it uses no profile: the
  profile fields at their defaults and the flat default key. A definition
  that needs a profile (O8) refuses there, as a bare slot does.
- **O6. Data migration.** None, as in Split Preset (the fork is only used
  for testing). The model preset normalizer drops the moved fields, and the default
  profile replaces them.
- **O7. Global provider fields that act as profile fields.** These
  `providers` fields pick the upstream model or URL for a generic definition,
  so two profiles of the same definition cannot differ on them:
  `nanogptRequestModel`/`nanogptRequestModelName`/`nanogptProvider`,
  `ollamaURL`/`ollamaModel`/`ollamaModelName`/`ollamaModelSource`/`ollamaInputMode`/`ollamaRequestFormat`,
  `ollamaCloudModel`/`ollamaCloudModelName`, and `customTokenizer`
  (`openrouter`/`reverse_proxy` tokenizer).
  They move to the profile in this plan. Behavior toggles
  (`openrouterMiddleOut`, `openrouterFallback`, the caching flags,
  `autofillRequestUrl`, `reverseProxyOobaMode`, `vertexRegion`) stay global
  and can follow later.
- **O8. Plugin writes.** Plugins can write `maxContext`,
  `seperateModelsForAxModels`, and `seperateModels` (`allowedDbKeys` in
  `src/ts/plugins/plugins.svelte.ts`). Reads stay as they are (see
  Compatibility).
  A write that cannot be applied is refused through
  the existing per-key path (a console warning, the old value kept, the other
  keys still applied).
  - `seperateModelsForAxModels` sets the preset toggle.
  - `seperateModels.<mode>`, checked in this order:
    1. the value read for that slot (see Compatibility) → no change. Plugins
       read, change another key, and hand everything back, so an unchanged
       value must never re-match to another profile with the same model id;
    2. `""` → the slot is cleared;
    3. exactly one profile with that model id → the slot names it;
    4. no such profile → the slot holds the bare model id (a "no profile"
       slot, see Slot resolution), unless the definition needs a profile
       (below), which is refused;
    5. more than one such profile → refused. The user split that model across
       keys on purpose, and the flat default key could bill another account.
  - `maxContext` sets the main slot's profile, which also changes every other
    preset that uses that profile. The same value is no change; a missing
    main profile is refused. The main and sub slots always name a profile, so
    this write has a target whenever the request would.
  - **Definitions that need a profile** cannot run bare, because the fields
    that complete them live on the profile: `reverse_proxy`, `openrouter`,
    `nanogpt`, `ollama-hosted`, `ollama-cloud` (O7), `ooba`, `mancer`,
    `kobold`, legacy `custom` (`currentPluginProvider`), and
    `xcustom:::` (no key without a profile, O2). One shared predicate (for
    example `definitionNeedsProfile(modelId, modelInfo)` in `shared/llm/`)
    lists them for the writes, the slot resolver, and O5.
- **O9. `apiType`.** It has no runtime reader, so it is dropped
  (`DROPPED_FIELDS`) instead of moved.

## Data model

### Field partition

| Record       | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model preset | `name`, the slot references (main, sub, `memory`, `translate`, `emotion`, `otherAx`), `seperateModelsForAxModels`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Profile      | `name`, `modelId` (a definition id), `credentialId?`; connection: `forceReplaceUrl`, `customProxyRequestModel`, `proxyRequestModel`, `customAPIFormat`, `textgenWebUIStreamURL`, `textgenWebUIBlockingURL`, `koboldURL`, `localNetworkMode`, `localNetworkTimeoutSec`, `currentPluginProvider`; routing: `openrouterRequestModel`, `openrouterProvider`, `useInstructPrompt`; compatibility: `enableCustomFlags`, `customFlags`, `systemContentReplacement`, `systemRoleReplacement`, `instructChatTemplate`, `JinjaTemplate`, `outputImageModal`, `modelTools`; capacity: `maxContext`; plus the O7 fields |
| Dropped      | `apiType` (O9); `proxyKey`/`proxyCredentialId` (moved); `providers.modelCredentials`; `CustomModel.credentialId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

- The slot references are new keys on the model preset record. Each value
  says what it holds, so a profile id is never guessed apart from a model id:
  `{ profileId }`, or, for the four auxiliary slots only, `{ modelId }` (a
  bare slot, made only by an O8 plugin write). The main and sub slots always
  hold `{ profileId }`; the normalizer drops anything else there. The old keys `aiModel`, `subModel`, and
  `seperateModels` keep their meaning (a model id) and become derived
  values, never stored (see Compatibility). D3 forbids renaming a persisted
  key, and giving an old key a new kind of value would break its old readers
  just as badly.
- One schema table, as in Split Preset: the profile's defaults, kinds, and
  null rules join `PRESET_DEFAULTS`, and a new `MODEL_PROFILE_FIELDS` joins
  the partition test (disjoint, and together equal to today's fields minus
  the dropped ones).
- `normalizeModelProfiles` in `shared/presets.ts` (next to
  `normalizeModelPresets`) gives every record an id, a string `modelId`, and
  defaults. It does not check that a `credentialId` exists (as today).
- `outputImageModal` is read only for the main job request
  (`server/src/prompt/runner.ts`). On a profile it applies when that profile
  is in the main slot.

### Slot resolution

One shared function, for example `resolveSlotProfile(modelPreset, profiles,
mode, staticModel)` in `shared/llm/`, used by the server's
`requestChatDataMain`, the tab's `requestChatDataMain` (plugin and WebLLM
models), the tokenizer, and the UI. It returns a profile, "no profile" with
a model id (O5 and bare slots), or a refusal (a missing profile, or a bare
model id whose definition needs a profile):

1. `staticModel` → O5.
2. Mode `model` → the main slot.
3. Modes `memory`, `translate`, `emotion`, `otherAx` with the toggle on and the
   slot set → that slot. A bare slot (`{ modelId }`) is "no profile": the
   profile fields at their defaults and the flat default key (O2).
4. Otherwise → the sub slot.

The tab and the server must agree, so neither keeps its own copy of these
rules (today both do: `src/ts/process/request/request.ts` and
`server/src/llm/request.ts`).

### Credentials

- `credentialSlotOf` keeps its table of accepted types and default
  descriptions; its `binding` column goes away, because every binding is now
  the profile's `credentialId`.
- `resolveCredentialBinding` takes the profile (or none) in place of
  `CredentialBindingSources`. The refusal order and reasons stay as they are.
  A `credentialId` on a "none" slot still refuses (`unsupportedModel`).
- `credentialsUsing` lists profiles instead of the three stores.

## Compatibility

Character cards, modules, plugins, and Lua are shared artifacts (D5). Their
readers see model ids, never profile ids:

- **Root names stay model ids.** The forwarded root values `aiModel`,
  `subModel`, and `seperateModels.<mode>` are the model ids of the slots'
  profiles. A bare slot reads as its model id, and a slot whose profile was
  deleted reads as `""` (so handing it back is no change, O8). The profile fields at root (`maxContext`, `forceReplaceUrl`, ...)
  are the main slot's profile's values. This keeps working:
  - CBS `{{model}}`/`{{axmodel}}` and the model metadata functions
    (`shared/cbs/registry.ts`);
  - prompt assembly, which reads `db.aiModel` and `db.maxContext`
    (`server/src/prompt/assemble.ts`);
  - token counting with the main model's tokenizer (unchanged: auxiliary
    requests tokenize with the main model today, `shared/llm/request.ts`);
  - plugin `getDatabase` reads of `maxContext`, `seperateModelsForAxModels`,
    `seperateModels`.
- **Plugin writes** follow O8. `risuai.d.ts` and `plugins.md` document them.
- **Mode-based callers do not change**: Lua `LLM`/`axLLM`, trigger v2
  `runLLM`, MCP `aiaccess` `runLLM` (`normal` → `model`, `lite` → `otherAx`),
  HypaV3 `summarizationModel: "subModel"` (mode `memory`), the emotion
  processor `submodel` (mode `emotion`), the LLM translator (mode
  `translate`), Iris (`otherAx`).

## Server

- `loadRequestDb` (`server/src/llm/settings.ts`) and `loadJobScope`
  (`server/src/jobs/jobScope.ts`) also read `modelProfiles`.
  `forwardPresetRoots` (`shared/sections.ts`) takes the profiles and writes
  the derived roots described in Compatibility. The request contracts do not
  change: `modelPresetId` already travels on every request, and the server
  reads the profiles itself.
- `requestChatDataMain` (`server/src/llm/request.ts`):
  1. resolve the slot (`resolveSlotProfile`); a missing profile returns
     `{ type: "fail", noRetry: true }` before any upstream call;
  2. build a request-local `ctx`: `ctx.db` with the profile's fields over the
     roots, and a `getModelInfo` that uses that profile's custom flags.
     Adapters read `arg.ctx.db` (`openAI/requests.ts`, `anthropic.ts`, ...), so
     this alone gives the auxiliary request its own URL, routing, flags, and
     templates. The job's frozen db is never mutated, since one job sends the
     main, emotion, and memory requests from it;
  3. the reverse-proxy block reads the overlaid fields;
  4. `resolveCredential(db, aiModel, modelInfo, profile)`.
- No per-profile secret (O2): remove `db.proxyKey`, the custom models'
  key merge, and the adapters' reverse-proxy key fallbacks
  (`openAI/requests.ts`, `anthropic.ts`). `redact.ts` loses those sources and
  keeps the named keys.
- Normalizers: `modelProfiles` registered with `settingsKind` in
  `server/src/data/kinds.ts` (materialized with one default record, O4);
  `providers` loses `modelCredentials` (and the O7 fields);
  `normalizeCustomModels` loses `credentialId`; the model preset normalizer
  keeps only the preset fields.

## Client

- `shared/resources.ts` / `shared/sections.ts`: the `modelProfiles` kind,
  `COLLECTION_KIND`, `COLLECTION_FIELDS`; `records.svelte.ts` `BY_ID_FIELDS`
  (stable wrappers by id, as `modelPresets`).
- `settingsViews.svelte.ts`: `activeModelPreset` serves the preset fields; a
  profile view (for example `profileForSlot(slot)`) serves a slot's profile.
  `buildRootRoutes` sends the derived roots through them (reads), and O8
  writes.
- `collectionStore.svelte.ts`: `addModelProfile`, `updateModelProfile`,
  `deleteModelProfile` (leaves slots dangling, O4), and the slot setters.
  `setModelCredential`, `setCustomModelCredential`, and `setProxyCredential`
  become one profile credential setter.
- Model reads move to the slot's profile: `src/ts/process/request/request.ts`
  (routing through the shared resolver; this also fixes the system
  replacement reading `activeModelPreset` instead of the captured scope),
  `tokenizer.ts`, `model/modellist.ts` (`getModelInfo` custom flags),
  `IrisModal.svelte`, `Suggestion.svelte`, `DefaultChatScreen.svelte`,
  `translator.ts`, `files/inlays.ts`, `botSettingsParamsData.ts`,
  `PromptPresetSettings.svelte`, `SettingRenderer.svelte`,
  `PlaygroundSubtitle.svelte`, and `plugins/apiV3/v3.svelte.ts`.
- `src/ts/model/credentials.ts`: `credentialFor(profile)`,
  `credentialsUsing(id)` over profiles.

## UI

- **Model profiles page** (new settings menu entry, next to Model and API
  Keys): the profile list (add, copy, rename, delete with the presets that use
  it) and the profile editor: the model picker (`ModelList`), the
  `CredentialSelect`, then the blocks `ModelSettings.svelte` shows today for
  that model (reverse proxy, OpenRouter, Ooba/Kobold/textgen URLs, Ollama and
  NanoGPT models (O7), custom flags, system replacement, chat template,
  tools, `maxContext`, image output).
- **Model page** (the preset): main and sub slot pickers, and
  `AuxModelSelectors.svelte` with the toggle and the four auxiliary slot
  pickers. Each picker lists profiles ("profile name — model name") and marks
  a missing one. A bare auxiliary slot shows as "no profile (model name)"
  with an action that creates a profile from it and selects that profile. The flat default key inputs stay on the Model page as the
  defaults (O2).
- **API Keys page**: the binding list shows profiles.
- **Custom models page**: the key select and the key input go away (O2).
- `WelcomeRisu.svelte` writes `aiModel`/`subModel` today: it creates or
  selects profiles instead.
- Strings in `src/lang/en.ts` and `ko.ts`.

## Import / export

- `.risup` (prompt preset) is unaffected.
- Model presets and profiles get no file format (they hold endpoints).
- The settings report removes `modelProfiles` like `modelPresets` (it holds
  URLs). Backups snapshot the resource database and need no change.

## Out of scope

- The `submodel` mode as its own slot (O3).
- Per-chat selection (Split Preset "Later").
- The `/proxy2` auxiliary operations, SupaMemory/HypaV3 embeddings, TTS, and
  image generation keep their own model and key fields.
- `seperateParameters` stays on the prompt preset, keyed by mode.

## Slices

1. Shared schema: the `ModelProfile` type and kind, the field partition and
   its test, `normalizeModelProfiles`, the slot fields on the model preset,
   `resolveSlotProfile` with a table test, and the credential binding over
   profiles. Remove `modelCredentials`, `CustomModel.credentialId`, and (O2)
   the per-record secret maps.
2. Server: the two loaders, `forwardPresetRoots`, the request-local `ctx` in
   `requestChatDataMain`, the missing-profile refusal, `resolveCredential`,
   the adapter key cleanup, and `redact.ts`.
3. Client storage: the views and root routes, the profile actions, the
   readers, and the request, tokenizer, and model list reads.
4. UI: the profiles page, the slot pickers, the API Keys and custom models
   pages, `WelcomeRisu`, and the strings.
5. Plugin compatibility: the O8 writes, `risuai.d.ts`, `plugins.md`.
6. Docs: `llm-requests.md` (slot resolution, the binding table),
   `media-aux.md` (`AuxModelSelectors`), `persistence.md` (the kind),
   `settings-i18n.md` (the page), and `STRUCTURE.md` anchors. Mark Shared API
   Keys decision 1 as superseded.

## As built

Choices the plan left open, as implemented:

- Slot keys: `mainSlot` and `subSlot` (`{ profileId }`) and `auxSlots`
  (`Partial<Record<AuxModelMode, { profileId } | { modelId }>>`). A missing
  or malformed main or sub slot normalizes to the default profile's id,
  `DEFAULT_MODEL_PROFILE_ID` (`"default"`), which the materialized default
  profile carries.
- `resolveSlotProfile` and `definitionNeedsProfile` live in
  `shared/llm/modelSlots.ts`; the tab wraps the resolver as
  `resolveModelSlot` (`settingsViews.svelte.ts`). The derived roots come from
  one function, `modelPresetRootValue` (`shared/sections.ts`), which both
  `forwardPresetRoots` and the tab's views use, and the server's request
  overlay is `forwardProfileRoots`.
- The O8 rules live in `writeModelRoot` (`settingsViews.svelte.ts`), which
  every root write goes through, the plugin setters included. A root write of
  `aiModel` or `subModel` (the onboarding, old callers) follows the same
  shape: the value read is no change, exactly one profile with that model id
  is selected, anything else is refused (main and sub never go bare). A
  refusal warns `[Settings] Refused ...` and returns `false`.
- `deleteModelProfile` keeps the last profile, as `removeModelPreset` keeps
  the last model preset; the server normalizer would materialize one anyway.
- The profile page is `MODEL_PROFILES_SETTINGS_MENU` (18); the profile editor
  binds to a profile by id, so a profile in no slot is editable.
- UI regroup (2026-10-09, after the slices): the profiles are shown as
  "연결" / "Connections", so the name no longer repeats "Model". The sidebar
  has one Model entry with three tabs (`Model/ModelMenuTabs.svelte`): Preset
  (menu 1, the slots), Connections (menu 18), and API Keys (menu 17). The
  flat default key inputs and the Vertex default key's client email and
  project id moved from the Preset tab to the API Keys tab
  (`Model/ProviderDefaultKeys.svelte`), so every key is on one tab; the
  Vertex region stays on the Preset tab.
- Adapters with a flat default read it through `defaultCredentialKey`
  (`server/src/llm/credentials.ts`), which answers `""` for a custom model
  and the reverse proxy.

## Tests

- `shared`: `resolveSlotProfile` over every mode, the toggle, empty and
  missing slots, and `staticModel` (O5); the field partition; the binding
  resolver over profiles (each refusal reason, a "none" slot).
- `server/src/tests/llmProviderAdapters.test.ts`, asserting the upstream URL
  and key each time:
  - one model id in two profiles on two keys (main and `memory`);
  - an auxiliary `reverse_proxy` profile with its own URL and key, beside a
    main profile on another URL;
  - custom flags on the auxiliary profile only;
  - a missing profile and a missing key, each refused with no upstream call;
  - a `staticModel` request with and without a matching main profile;
  - a bare auxiliary slot sending the flat default key, and a bare slot of a
    definition that needs a profile, refused.
- Normalizers: `modelProfiles` (ids, defaults, the default record), the
  model preset dropping moved fields, `providers` without `modelCredentials`.
- Compatibility: the derived roots (`aiModel`, `subModel`,
  `seperateModels`, `maxContext`) on the server and in the tab; CBS
  `{{axmodel}}`; plugin reads and each O8 write rule
  (`src/ts/plugins/apiV3/hostApiRouting.test.ts`): a read-modify-write that
  leaves the slot on its profile while another profile has the same model
  id, `""`, one match, no match (bare), a definition that needs a profile, two
  matches, and `maxContext` on a missing main profile.
- `src/ts/storage/tests/presetSchema.test.ts`: the field counts change on
  purpose.

Each slice runs `pnpm check`, `pnpm test`, and the tests above that it
touches.
