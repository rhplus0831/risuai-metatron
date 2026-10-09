# Shared API Keys Plan

Status: done (slices 1–5); named keys for the auxiliary operations are the
open follow-up. Move LLM credentials out of the model information into a
list of named keys, and let each model choose which key it sends. Two goals:

- the same provider with different keys (Claude Opus on one key, the
  auxiliary Haiku on another);
- several Custom API (`xcustom:::`) models sharing one key.

## Product decisions

Confirmed 2026-10-08:

1. **Global binding.** A model id chooses its key once, for every model
   preset that uses it. No per-preset override in this plan. _Superseded by
   [Model Profiles](model-profiles.md): the binding is each profile's
   `credentialId`, and `providers.modelCredentials` is removed._
2. **The current keys stay as the defaults.** `openAIKey`, `claudeAPIKey`,
   `OaiCompAPIKeys.<id>`, each custom model's own key, and each model preset's
   `proxyKey` are not migrated. A model without a binding sends exactly what
   it sends today. A binding is an override. _The custom model's own key and
   `proxyKey` were removed by Model Profiles O2: those two send no key
   unless a named key is chosen._
3. **A dangling binding refuses the request.** A binding whose key was
   deleted, has no value, or has the wrong type fails the request
   (`noRetry`, so neither retries nor fallback models run). It is never
   redirected to the default key. This follows `b86334b1` (a captured preset
   that is gone refuses the request).

Derived from 1 (record if reopened): **the binding lives next to the URL the
key is sent to.**

- A catalogue model has a fixed provider URL, so its binding is global
  (`providers.modelCredentials`).
- A custom model's URL is on its record, so its binding is
  `customModels[].credentialId`. That is still global, since a custom model
  is one record shared by all presets.
- `reverse_proxy`'s URL (`forceReplaceUrl`) belongs to the model preset, so
  its binding is the model preset's `proxyCredentialId`. A global binding
  would send one key to every preset's proxy URL.

## Data model

| What                  | Where                                                             | Readable by the tab                                 |
| --------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| The key list          | new collection `credentials` (`COLLECTION_KIND.credentials`)      | yes: `{ id, name, type, clientEmail?, projectId? }` |
| Each key's value      | `llmSecrets.credentials.<id>.key` (a `SECRET_ENTRY_MAPS` entry)   | no (masked leaf)                                    |
| Catalogue model → key | `providers.modelCredentials: { [modelId]: credentialId }`         | yes (ids only)                                      |
| Custom model → key    | `CustomModel.credentialId?: string`                               | yes                                                 |
| Reverse proxy → key   | model preset `proxyCredentialId?: string` (`MODEL_PRESET_FIELDS`) | yes                                                 |

- `Credential` (`shared/database.ts`): `id` (a record id, `isRecordId`),
  `name`, `type: CredentialType`, and `clientEmail` and `projectId` for
  `vertex` only (neither is a secret; the private key is the `key` leaf). A
  Vertex key's non-empty `projectId` replaces the global `google.projectId`
  in its request URL, so a service account from another project works.
- `CredentialType`: `openai`, `anthropic`, `bedrock`, `google`, `vertex`,
  `openrouter`, `nanogpt`, `mistral`, `cohere`, `ollama`, `novelai`, `custom`.
  `custom` is a plain bearer string accepted wherever a single string key is.
  `bedrock` holds the composite `accessKeyId:secretAccessKey:region`, as
  `claudeAPIKey` does today.
- `SECRET_ENTRY_MAPS` gains `credentials: "key"`. That alone gives the path
  codec, `maskLlmSecrets`, `withStoredSecrets`, the routes
  (`/api/llm-secrets/credentials/~<id>/key`), the client `pathsOf`,
  `SecretInput`, and `prepareEntryCredentials`. A `{ id, key }` written into
  the `credentials` list is routed to the secret and stripped from the
  record, exactly like `customModels`.
- `modelCredentials` keys are model ids (any string, including `xcustom:::…`
  that is ignored there, and `__proto__`): build the map with own properties
  only, as `OaiCompAPIKeys` does.
- Deleting a key removes its record and its secret entry
  (`deleteEntrySecret("credentials", id)`). It leaves the bindings that name
  it, so those requests refuse (decision 3) and the UI shows them as missing.

### The credential slot table

One shared function, `credentialSlotOf(modelId, modelInfo)` in
`shared/llm/credentialSlots.ts`, says which default a model reads, where its
binding lives, and which key types it accepts. The server's resolver and the
UI's selects both use it, so the two cannot disagree.

| Slot            | Models                                                                       | Default today                            | Binding             | Accepts                    |
| --------------- | ---------------------------------------------------------------------------- | ---------------------------------------- | ------------------- | -------------------------- |
| `openai`        | provider `OpenAI` (Chat, Responses, legacy instruct)                         | `openAIKey`                              | global              | `openai`, `custom`         |
| `anthropic`     | provider `Anthropic`                                                         | `claudeAPIKey`                           | global              | `anthropic`, `custom`      |
| `bedrock`       | provider `AWS`                                                               | `claudeAPIKey` (composite)               | global              | `bedrock`                  |
| `google`        | provider `GoogleCloud`                                                       | `google.accessToken`                     | global              | `google`, `custom`         |
| `vertex`        | provider `VertexAI`                                                          | `vertexClientEmail` + `vertexPrivateKey` | global              | `vertex`                   |
| `mistral`       | provider `Mistral`                                                           | `mistralKey`                             | global              | `mistral`, `custom`        |
| `cohere`        | provider `Cohere`                                                            | `cohereAPIKey`                           | global              | `cohere`, `custom`         |
| `novelai`       | provider `NovelAI`                                                           | `novelai.token`                          | global              | `novelai`, `custom`        |
| `openrouter`    | `openrouter`                                                                 | `openrouterKey`                          | global              | `openrouter`, `custom`     |
| `nanogpt`       | `nanogpt` (every NanoGPT format)                                             | `nanogptKey`                             | global              | `nanogpt`, `custom`        |
| `ollama`        | `ollama-cloud`                                                               | `ollamaApiKey`                           | global              | `ollama`, `custom`         |
| `keyIdentifier` | a model with `keyIdentifier` (DeepSeek, DeepInfra)                           | `OaiCompAPIKeys.<keyIdentifier>`         | global              | `custom`                   |
| `customModel`   | `xcustom:::…`                                                                | `llmSecrets.customModels.<id>.key`       | `credentialId`      | every type except `vertex` |
| `reverseProxy`  | `reverse_proxy`                                                              | `llmSecrets.modelPresets.<id>.proxyKey`  | `proxyCredentialId` | every type except `vertex` |
| none            | Mancer, NovelList, Horde, Ooba/Kobold, `ollama-hosted`, plugin, WebLLM, Echo | unchanged                                | not offered         | —                          |

The `keyIdentifier` row is checked before the provider rows, and the
`customModel` and `reverseProxy` rows before both. Each row must be checked
against the adapter it stands for before it is written down: the "Default
today" column is what the adapters read now (see Server). The "none" models
keep their flat fields. A binding stored for one of them is refused like a
mismatch.

## Server

- `server/src/llm/settings.ts` `loadRequestDb`: add
  `db.credentials: Record<id, { name, type, key, clientEmail?, projectId? }>` from the
  `credentials` collection merged with `llmSecrets.credentials`, the way
  `customModels` gets its keys. Add `modelCredentials` from `providers`
  (already copied if it is in `SECTION_FIELDS.providers`) and
  `proxyCredentialId` through the model preset fields. Read the
  `credentials` kind in the same synchronous `readKinds`. Jobs use the same
  frozen result (`runInJob`), so they are covered.
- New `server/src/llm/credentials.ts`
  `resolveCredential(db, aiModel, modelInfo, modelPresetBinding)`. It returns
  one of:
  - `{ kind: "default" }`: no binding, so the adapter reads what it reads today;
  - `{ kind: "key", key }` or `{ kind: "vertex", clientEmail, privateKey, projectId? }`;
  - `{ kind: "refused", reason }`: unknown id, empty key, a type the slot does
    not accept, or a binding on a "none" slot.
- `requestChatDataMain` (`server/src/llm/request.ts`, next to the
  `reverse_proxy` and `xcustom:::` blocks): call the resolver after
  `targ.aiModel` and `targ.modelInfo` are final. This covers the main, sub,
  separate, and fallback models alike, since each attempt passes through it.
  - A refusal returns `{ type: "fail", result: <English message from messages.ts>, noRetry: true }`.
  - A key sets `targ.key`; a Vertex result sets a new `targ.vertexCredential`.
  - With no binding, the existing `proxyKey` and custom model key
    assignments stay as they are.
- Adapter cleanup, so that `arg.key` wins everywhere a slot is offered:
  - `openAI/requests.ts` and `openAI/responses.ts`: the `keyIdentifier`
    header override replaces `arg.key`. Move the `OaiCompAPIKeys` lookup into
    the resolver's default path, which sets `targ.key` when there is no
    binding, and delete both overrides. Nothing else sets `arg.key` for a
    `keyIdentifier` model today, so the move is equivalent.
  - `request.ts` Ollama cloud: the three `arg.key = db.ollamaApiKey` become
    `arg.key ??= db.ollamaApiKey`, and the native-mode header reads the
    resolved key.
  - `google.ts` Vertex: read `arg.vertexCredential ?? { db.vertexClientEmail, db.vertexPrivateKey }`.
    `vertexToken.ts` already caches per email and key.
  - `anthropic.ts` (`arg.key ||`), `google.ts` (`arg.key ||`), Mistral,
    Cohere, NovelAI, and legacy instruct (`arg.key ??`) already prefer
    `arg.key`. Check that Bedrock's `getCredentialParts` splits the resolved
    key.
- `redact.ts`: add every `db.credentials[*].key` (and its `:` parts, for
  `bedrock` and `custom`) and every `clientEmail`. **Without this a bound key
  leaks into logs and errors sent to the tab.**
- `server/src/data/normalize/`:
  - `collections.ts` `normalizeCredentials`: entries need a record id, a
    string `name`, and a known `type`; `key` is dropped, as in
    `normalizeCustomModels`; `clientEmail` and `projectId` are kept only for
    `vertex`.
  - `llmSecrets.ts`: read `credentials` like `customModels`
    (`{ key: string }` by record id).
  - `providers.ts`: `modelCredentials: ["object", {}]`, values must be
    strings.
  - `normalizeCustomModels`: `credentialId` is optional and must be a string.
  - `shared/presets.ts`: `proxyCredentialId` in `PRESET_DEFAULTS` and
    `MODEL_PRESET_FIELDS`, with an absent default.
  - Each one gets a resource kind registration next to `customModels`.
- `jobScope.ts` `mirrorSecrets` needs no change: entry maps are outside
  `SECTION_FIELDS.llmSecrets`. Confirm that the `credentials` entry map
  stays out of the job's mirror.
- Out of scope: the `/proxy2` auxiliary operations (`auxOps.ts`: TTS, DALL-E,
  Whisper, embeddings, model discovery, NanoGPT account) and
  `openrouter.ts` `getFreeOpenRouterModels` keep the flat default keys.

## Client

- `shared/sections.ts` / `shared/resources.ts`: the `credentials`
  collection (`COLLECTION_KIND`, `COLLECTION_FIELDS`, `RESOURCE_KIND`), and
  `modelCredentials` in `SECTION_FIELDS.providers`.
- `src/ts/storage/collectionStore.svelte.ts`: `addCredential(name, type)`
  (a new record id) and `deleteCredential(id)` (the record and
  `deleteEntrySecret("credentials", id)`).
- `src/ts/storage/snapshots.svelte.ts`: add `credentials` (names and types
  only) beside `customModels` for the legacy flat shape.
- `src/ts/model/credentials.ts` (the tab's reader): `credentialFor(modelId)`
  returns the bound record, `missing`, or `default`; `credentialsUsing(id)`
  lists the bindings that name a key, for the delete confirmation.

## UI

- **API Keys page** (new settings menu entry, near Model):
  - The key list: name, type, masked hint (`SecretInput` on
    `{ kind: "entry", field: "credentials", id }`), and rename.
  - Delete, confirmed through `alertConfirm` and naming the models that use
    the key (`credentialsUsing`).
  - "Add key": name and type, plus a client email field for Vertex.
  - The bindings: each bound model with its key, a "missing" badge for a
    dangling one, and a remove action (back to the default).
- **`CredentialSelect.svelte`** (`src/lib/UI/GUI/`): the options are
  `Default (<slot default name>)`, then the keys `credentialSlotOf` accepts,
  then a disabled "missing" entry when the binding dangles. It is hidden for
  a "none" slot.
- **`ModelSettings.svelte`**:
  - a `CredentialSelect` under the main and sub model pickers;
  - the existing default key inputs (`openAIKey` and so on) stay, labelled as
    the default key;
  - the separate auxiliary models and the fallback models get the select per
    row where the row layout allows it. The API Keys page covers any row
    that does not.
- **`CustomModelsSettings.svelte`**: the key field becomes a
  `CredentialSelect` whose default is "This model's own key", which keeps
  the existing `SecretInput` below it.
- **Reverse proxy block** (`ModelSettings.svelte`): the same select, bound to
  `activeModelPreset.proxyCredentialId`, with the existing `proxyKey` input
  as the default.
- Strings go in `src/lang/en.ts` (and `ko.ts`).

## Import / export

- `.risup` (prompt preset) is unaffected.
- Model presets have no file format.
- The settings report and backups carry key names and bindings, never
  values. Check that the backup inventory (`backup-sync-hub.md`) picks up the
  new collection.
- A restored or shared setup whose bindings point to missing keys refuses
  those requests until the user picks a key: decision 3, shown as "missing"
  in the UI.

## Slices

1. Shared schema:
   - the `Credential` type and the `credentials` collection kind;
   - `SECRET_ENTRY_MAPS.credentials`;
   - `modelCredentials`, `CustomModel.credentialId`, `proxyCredentialId`;
   - the normalizers;
   - `credentialSlotOf` with a table test.
2. Server:
   - `loadRequestDb`, `resolveCredential`, and the refusal;
   - the adapter cleanup (the `keyIdentifier` overrides, Ollama cloud, Vertex);
   - `redact.ts`.
3. Client storage: the collection actions, the snapshot, and the
   `credentialFor`/`credentialsUsing` readers.
4. UI: the API Keys page, `CredentialSelect`, ModelSettings,
   CustomModelsSettings, the reverse proxy block, and the strings.
5. Docs: `llm-requests.md` (the slot table, the resolver, `Known Hazards`
   for the auxiliary operations), `persistence.md` (the new kind and entry
   map), `settings-i18n.md` (the page), and `STRUCTURE.md` D1/P2 anchors.

## As built

Commits: `ca821177` (schema), `389805fe` (a NanoGPT fix found on the way),
`97b0d618` (server), `e2354fd3` (client storage), `418b9cb1` (UI), and this
docs change. Where the result differs from the sections above:

- **NanoGPT first.** The Messages and Legacy formats sent the Claude and the
  OpenAI key to Anthropic and OpenAI. They were fixed to go to NanoGPT with
  `nanogptKey` before the server slice (`389805fe`), so every NanoGPT format
  has one `nanogpt` slot. The Responses subscription route did not exist and
  was dropped too.
- **The slot table** gained a row the plan missed: an as-is or keyless
  DeepSeek/DeepInfra OpenAI-format model reads `openAIKey`, so it is the
  `openai` slot.
- **`keyIdentifier` keys** are resolved in the adapters, not in
  `requestChatDataMain`: `openAI/shared.ts` `getOpenAIRequestKey` takes
  `arg.key`, else the model's own `OaiCompAPIKeys` entry or `""`. A direct
  adapter call must never fall through to `openAIKey`.
- **Vertex keys carry `projectId`.** The Vertex URL used the global
  `google.projectId`, so a service account from another project could not
  work. The credential's non-empty `projectId` now wins.
- **One shared decision.** Slice 3 moved the binding rules into
  `shared/llm/credentialBinding.ts` `resolveCredentialBinding`, used by both
  the server resolver and the tab readers.
- **The settings report** drops `credentials` (the names are personal) and
  keeps `modelCredentials` (ids only). The backup and the plugin
  `getDatabase` needed no change.
- **No settings-search entry.** `getFullSettingsData` has no UI consumer.
- **The readers tolerate a missing collection.** An absent `credentials` list
  or `modelCredentials` map reads as empty, so a settings page never fails on
  it.
- **Mancer, NovelList, and Horde** keep their plain "API Key" labels: they
  have no slot, so their key is not a "default".

Open follow-up: let the `/proxy2` auxiliary operations (TTS, DALL-E,
Whisper, embeddings, model discovery, the NanoGPT account calls) and
`getFreeOpenRouterModels` use a bound key. Today they read the default keys
(`llm-requests.md` "Known Hazards").

## Tests

- `shared`: `credentialSlotOf` over every catalogue provider and the virtual
  ids (`openrouter`, `nanogpt`, `ollama-cloud`, `reverse_proxy`,
  `xcustom:::`, a `keyIdentifier` model, a "none" model).
- `server/src/tests/llmSecrets.test.ts`: the `credentials/~<id>/key` path
  round trip, masking, and the 400 on a bad path.
- `server/src/tests/normalizeCollections.test.ts` and
  `normalizeSections.test.ts`: `credentials` (key dropped, bad type refused,
  `clientEmail` only for Vertex), `modelCredentials`, `credentialId`.
- `server/src/tests/llmProviderAdapters.test.ts`, asserting the upstream
  `Authorization` (or `x-api-key`, `x-goog-api-key`, the SigV4 signature)
  each time:
  - a bound OpenAI key;
  - two Anthropic models on two different keys;
  - two custom models sharing one key;
  - a bound `keyIdentifier` model;
  - Ollama cloud;
  - Vertex with a bound service account;
  - Bedrock;
  - a reverse proxy bound per model preset;
  - each refusal (deleted key, empty key, wrong type, "none" slot), with no
    upstream request and no fallback attempt;
  - an unbound model unchanged.
- Redaction: a bound key that appears in a provider error comes back
  redacted.
- `src/ts/storage/tests/resourceSyncSecrets.test.ts` /
  `llmSecrets.test.ts`: a `{ id, key }` written into `credentials` is
  routed to the secret and stripped from the record.
- `src/ts/storage/tests/presetSchema.test.ts`: the field counts change on
  purpose (`proxyCredentialId`).

Each slice runs `pnpm check`, `pnpm test`, and the tests above that it
touches.
