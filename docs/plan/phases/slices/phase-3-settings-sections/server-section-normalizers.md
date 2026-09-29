# Slice: Server Sections, Collections, And Their Normalizers

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 3](../../phase-3-settings-sections.md), "Sections", "Collections still in root",
"Server normalizers", and the server side of "Secrets" (both `secrets` and `llmSecrets`);
`PLAN.md` Decision 6 and invariant 5 (normalization moves to the server per collection as pure
functions with node tests).

Depends on: slice 2 (`shared/sections.ts`, `shared/presets.ts`, the id-bearing element types,
`shared/resources.ts` kind names and payload types). No client change; the client keeps reading
and writing `root` until slice 4. `root` stays registered until slice 6.

## Scope

Allowed files: `server/src/data/normalize/{shared,presets,personas,providers,secrets,llmSecrets,ui,memoryTranslateMedia,collections}.ts`
(new), `server/src/data/kinds.ts`, `server/src/data/resourceStore.ts` (the startup
normalization pass, materialization, the `normalize` hook in `replaceAll`), `server/src/app.ts`
(run the pass after `createResourceStore` and after a restore or import), `shared/resources.ts`
(only if a payload type needs a server-side helper type), and the docs rows in
`docs/structure/self-host-server.md` (`Files`, `State`). The pure helpers the normalizers reuse
(`defaultHotkeys`, `defaultColorScheme`, `createHypaV3Preset`, `createTranslatorPreset`,
`normalizeTranslatorPresetState`, `normalizeChatLoadPages`, `prebuiltNAIpresets`) were moved to
`shared/` by slice 2. Tests belong to the review step.

Identifiers (verified): `DEFAULT_RESOURCE_KINDS`, `ResourceKind` (`name`, `schemaVersion`,
`singleton`, `normalize(input, { id })`), `createKindRegistry` (names match
`^[A-Za-z][A-Za-z0-9_-]{0,63}$`; reserved `batch`, `read`, `chat`, `chatOrder`),
`createResourceStore` (`initialize`, `readKinds`, `readRefs`, `get`, `put`, `applyChanges`,
`backupTo`, `readSnapshot` which refuses any row of an unregistered kind and re-normalizes rows
with the kind's `normalize`, `replaceAll`), `SCHEMA_VERSION` (2; unchanged in this slice),
`setDatabase` (`database.svelte.ts`, the defaults being ported: from `if (checkNullish(data.apiType))`
to `data.moveInsteadOfCopyOnCMPConvert ??= false`, minus the preset-owned ones, which slice 2's
`normalizePreset` owns), `checkNewFormat` (`bootstrap.ts`: the root steps `personas` ids,
`formatversion` branches, `loreBookToken` floor, `characterOrder` default, `mainPrompt`
migration; the character and module steps stay on the client), `checkCharOrder`
(`globalApi.svelte.ts`: stays on the client, it needs the character list), `normalizeChatMeta`
(`server/src/data/chats.ts`: the only default-applying server normalizer today).

Stopping condition: a default that depends on another section's field or on a collection and
cannot be kept inside one section or replaced by a constant equal to the pre-phase boot value.
Known cases and their resolution are in Proposed decisions; a new one is reported back.

## Assumptions

- Phase 1 normalizers check shape only and return the input unchanged; there is no
  `server/src/data/normalize/` folder.
- Slice 2 landed: `SECTION_FIELDS`, `COLLECTION_KIND`, `DROPPED_FIELDS`, `PRESET_FIELDS` with
  boot-derived defaults, `normalizePreset`/`normalizePresets` (pure, in `shared/presets.ts` so the
  client uses them too), required `id` on `botPreset`, `RisuPersona`, `TranslatorPreset`,
  `HypaV3Preset`, and the client already assigns ids at every creation site, so the server's id
  assignment is a backstop that fires only for records written by pre-slice-2 clients (Opus P1a).
- The batch result carries revisions only (`ResourceBatchResult.results`), and the client records
  the text it sent as the persisted text (`cycle` in `resourceSync.svelte.ts`). Therefore a
  normalizer must never invent state on write that the client did not send and cannot predict
  (an id it assigns as backstop is the one exception, and it is bounded by the startup pass below
  and by the client-side assignment). Nothing is normalized on read (Astra P1, Opus P1).
- `readSnapshot` and `replaceAll` already persist the normalized text of every row on restore.

## Proposed decisions

- Kinds (decided by the phase file; names proposed): five singleton section kinds `providers`,
  `secrets`, `llmSecrets`, `ui`, `memoryTranslateMedia`, and twelve singleton collection kinds
  named after their `Database` field: `loreBook`, `globalscript`, `hotkeys`, `customSidebarItems`,
  `characterOrder`, `authRefreshes`, `globalChatVariables`, `personas`, `translatorPresets`,
  `hypaV3Presets`, `customModels`, `enabledModules`. Ten collections hold the field's value as-is;
  `translatorPresets` and `hypaV3Presets` hold `{ items, selectedId }` (proposed: the phase file
  makes those selections ids "with their collections", and one record lets the normalizer keep
  the selected id valid, falling back to the first item; the mirror unpacks them into the two
  `Database` names each, D3). `llmSecrets` holds the LLM credential fields under their `Database`
  names plus `presets: Record<presetId, { proxyKey }>` (the classification is in
  `SECTION_FIELDS.llmSecrets`, slice 2; it includes `supaMemoryKey`, which is sent to OpenAI
  completions by `supaMemory.ts` and `hypav2.ts`, per Astra P5). `openAIKey` is an ordinary flat
  field of `llmSecrets` (Astra P6).
- Normalizers (proposed): one exported pure function per kind, returning a new object, never
  mutating its input (`normalizePromptTemplate` in `shared/presets.ts` clones with a plain
  recursive JSON clone, not `structuredClone`, so a proxy at the client boundary is snapshotted
  by the caller: Astra P7). A section normalizer builds every field of `SECTION_FIELDS[section]`
  (the value when it has the expected type, the boot-derived default otherwise, the migration
  where `setDatabase` has one: `antiClaudeOverload` to `antiServerOverloads`,
  `NAIImgConfig.v4_prompt`, `localNetworkMode`/`localNetworkTimeoutSec` coercion where those are
  section fields, `top_p` non-number fix and `openrouterProvider` string-to-object belong to the
  preset normalizer of slice 2 because those fields are preset-owned: Opus P4) and drops unknown
  keys. Field-specific validators where the shape is not "string or container": `vertexAccessTokenExpires`
  is a finite number (Astra P5), `authRefreshes` entries are objects with string fields,
  `customModels` entries carry string `id` and `internalId`. The `hotkeys` collection normalizer
  merges `defaultHotkeys` by `action` as `setDatabase` does; the `enableScrollToActiveChar`
  removal of the `scrollToActiveChar` hotkey moves to the client reader (`hotkey.ts`) so the two
  sections do not depend on each other.
- Cross-section defaults (proposed; each equals the pre-phase boot value on an empty save, so
  the snapshot comparison passes; recorded in the phase file by slice 7): `enableRisuaiProTools`
  (`??= plugins.length > 0`) becomes `false`; `ollamaModelSource` (`aiModel === "ollama-cloud"
...`) becomes `"local"` and `ollamaCloudModel` `""`; `hypaV3Presets` seeded from
  `supaMemoryPrompt` and `hypaV3Settings` becomes `createHypaV3Preset("Default")`;
  `translatorPresets` seeded from `translatorPrompt` becomes `createTranslatorPreset("Default")`
  with an empty prompt (what a fresh boot produces today). `customColorScheme ??= colorSchemeName
=== "custom" ? colorScheme : defaultColorScheme` stays as written: all three fields are in `ui`
  (corrected after Astra's drift check).
- Startup normalization pass instead of read-time normalization (Opus P1a, Astra P1):
  `createResourceStore` (after `initialize`) and `replaceAll` (after the restored rows are
  installed) run every registered normalizer over its stored records and persist, in one
  transaction and with a revision bump, each record whose normalized text differs; a missing
  `materialize` singleton is inserted as `normalize(undefined)` (array kinds accept `undefined`
  and return their default; Opus P14). Reads return stored text unchanged, so repeated reads are
  deterministic and a backstop id is assigned once and persisted before any client sees it. A
  client that boots after the pass seeds `persisted` from the normalized text and echoes nothing.
  A client whose write is normalized further than it sent (only the backstop ids can do that)
  learns the result at its next boot or conflict reload; slice 2 makes that case unreachable for
  new writes. Alternative (b), returning normalized data in batch results, is recorded as the
  general mechanism for a later phase if a normalizer ever needs to change what a client sent.
- `root` stays registered in this slice (the client still writes it); slice 6 removes it with
  the schema version bump.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `server/src/tests/sharedImports.test.ts`.
Review-step tests under `server/src/tests/`: one file per section normalizer (`undefined` and
`{}` yield the section's boot-derived defaults; a value of the wrong type is replaced; each
migration; unknown keys dropped; the input is not mutated), the collection normalizers
(`hotkeys` merge by `action`; `translatorPresets` and `hypaV3Presets` `selectedId` fallback and
id backstop; `personas` and `presets` from slice 2; the numeric expiry validator), the taxonomy
partition test (`SECTION_FIELDS` of every section, the collection fields, the two unpacked
selection fields, the forwarded preset and persona keys, the three selection keys, the Phase 1
fields `characters`, `botPresets`, `modules`, `plugins`, `pluginCustomStorage`, and
`DROPPED_FIELDS` partition `keyof Database`: Opus P14, Astra's drift check), and store tests for
the startup pass (a record stored before a default existed is rewritten once with a new
revision; a second start rewrites nothing; a missing singleton is materialized; `replaceAll` of
a snapshot lacking a section materializes it; a backup taken after the pass restores).

## Residual risk

Until slice 4 the client still writes `root` and never reads the sections, so a section record
and the root record can disagree; nothing reads both. Records written by a client older than
slice 2 (no ids) get backstop ids only at the next server start; two such clients could see
different ids between a write and the restart (unreachable once every client runs slice 2, which
lands before this slice is deployed). The element ids of `customSidebarItems`, `folder`, and
`customModels` are validated as strings but not de-duplicated.
