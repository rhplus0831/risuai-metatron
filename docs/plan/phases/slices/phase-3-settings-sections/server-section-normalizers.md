# Slice: Server Sections, Collections, And Their Normalizers

Status: implemented (2026-09-30); see Implementation record.

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

## Implementation record

Implemented by Claude Opus on 2026-09-30, following `implementation-plan.md` (the slice 3
amendments: `materialize`, the store-owned pass, `clientReadable`, `statics`, shape validation).

- Kinds: `RESOURCE_KIND` gains the 5 sections and 13 collections (spelled out, with a
  `satisfies` against `SECTION_KIND` and `COLLECTION_KIND`, because `shared/sections.ts` imports
  `shared/resources.ts` and a value import back would be a cycle). `DEFAULT_RESOURCE_KINDS`
  registers them as singletons with `materialize: true`; `llmSecrets` also has
  `clientReadable: true`. `createKindRegistry` refuses `materialize` on a non-singleton.
- Normalizers (`server/src/data/normalize/`): `normalizeSection` builds every field of
  `SECTION_FIELDS[section]` in order: the value when its JSON kind (`shared/valueKinds.ts`)
  matches the field's, the default otherwise (missing, `null`, or the wrong kind), and no other
  key. Each section's `SectionSpec` was generated from the boot snapshot (the kind and value of
  every field the snapshot has) and from the declared `Database` type (the kind of the 85 fields
  a fresh boot leaves unset, which stay absent). The type makes a missing or extra field a
  compile error, and it checks each default against the field's type. `colorScheme` and
  `customColorScheme` use `defaultColorScheme`, and `ollamaRequestFormat` uses `LLMFormat.Ollama`.
- Migrations ported from `setDatabase`: the keep-on-switch containers in `providers`
  (`migrateKeepOnSwitchFields`, shared with `normalizePreset`), `hypaCustomSettings` rebuilt to
  three strings (`secrets`), `google.accessToken`/`projectId` (`llmSecrets`), the NAI v4 fields
  (`memoryTranslateMedia`), and in `ui` the custom color scheme taken from `colorScheme` when
  `colorSchemeName` is `custom`, the two quote colors, and `normalizeChatLoadPages`.
- Not ported: the `antiClaudeOverload` migration (a dropped field), the `largeChatPerformanceMode`
  rename (that key is never in a section record), the `ollamaCloudModel` copy, and
  `enableRisuaiProTools ??= plugins.length > 0` (both are fresh-boot constants now). The
  `enableScrollToActiveChar` hotkey filter moves to the client in slice 4 (`hotkey.ts`).
- Collections: containers are checked, and a record or element of the wrong shape is a 400. So
  are `characterOrder` entries other than ids and folders, and `enabledModules` entries other
  than strings. `authRefreshes` entry fields must be strings or absent: an MCP public client has
  no `clientSecret`, so "every field a string" would refuse real writes. `customModels` entries
  need string `id` and `internalId`. `statics` counters default to 0. `hotkeys` appends each
  built-in hotkey whose `action` is missing. `personas` gets an id backstop (a repeated id is
  re-keyed); `undefined` becomes the fresh-boot persona, and an empty list stays empty (the
  client never holds one without a persona, so there is nothing to invent). `translatorPresets`
  and `hypaV3Presets` rebuild each item with `createTranslatorPreset`/`createHypaV3Preset`
  (valid ids kept, repeats re-keyed). An empty list gets one default item, as
  `normalizeTranslatorPresetState` did (the HypaV3 UI refuses to delete the last preset), and
  `selectedId` falls back to the first item.
- `presets`: `normalizePresets` behind the Phase 1 array-of-objects check, and materialized (after the Astra challenge, point 3): a fresh store and a restored snapshot without it get one default preset, so slice 4's assembly never needs the client fallback. The client runs the
  same function in `setDatabase`, so its text is already the fixed point.
- Shape validation (the Astra challenge of slice 2, point 3): `normalizePreset` replaces a value
  of the wrong JSON kind with the default, or leaves it absent when there is no default or the
  field is keep-on-switch. The kinds are `PRESET_FIELD_KINDS`, taken from the default, or from
  `kindsWithoutDefault` for the seven fields without one; an unresolved kind throws on load.
  `null` stays accepted everywhere (the slice 2 null policy). The `openrouterProvider`
  string-to-object migration now runs before the kind check. Before that fix the check had
  replaced a legacy string with the default, which `presetSchema.test.ts` caught.
- The pass (`normalizeStoredRecords` in `resourceStore.ts`) runs when the store opens and inside
  `replaceAll`'s transaction, before the epoch changes. It re-normalizes every record of every
  registered kind and rewrites the ones whose text changed, with the revision counter advanced
  and the same `seq`. It then inserts each missing `materialize` singleton as
  `normalize(undefined)`. The store counts the rewrites in `writeCount`. There is no `app.ts`
  change (amendment).

Deviations from this file:

- Allowed files: `shared/presets.ts` (shape validation, `migrateKeepOnSwitchFields`) and the new
  `shared/valueKinds.ts` were added. `server/src/app.ts` is unchanged. `util/playwright/stack.mjs`
  gains `restartServer()` (a tool, for the restart check).
- Rejection vs repair: a section's field of the wrong kind is repaired (the default), but a
  record that is not the right container, or a collection element of the wrong shape, is
  rejected with a 400 on write. `normalize(undefined)` is reachable only from materialization,
  because the batch route requires `data`.
- The pass stops the start when a stored record fails its normalizer. The error names the kind
  and id, and the transaction rolls back. The alternative, leaving the record as it is, would let
  a later restore refuse the snapshot instead.
- The pass reads every record of every kind, including `characters`, so start time grows with the
  resource data (chats are excluded, being in their own tables).
- Numeric strings in `chatLoadInitialPages`/`chatLoadAdditionalPages` now get the default. The
  kind check runs before `normalizeChatLoadPages`, which used to parse them. No writer stores a
  string there (`NumberInput` binds a number).

After the Astra challenge (same session as the plan review):

1. HypaV3 settings copy (blocking): `createHypaV3Preset` used `key in target`, which matches
   `__proto__`, so a stored `settings.__proto__` swapped the copy's prototype and made the
   normalizer non-idempotent. Adopted: own keys only (`Object.hasOwn`); `shared/hypaV3Presets.ts`
   joins the allowed files.
2. Non-finite numbers (blocking): `plainClone` turned a nested `1e400` (`Infinity` after
   `JSON.parse`) into `null` before `serialize` could refuse it. Adopted: the store runs every
   normalizer (`put`, `applyChanges`, `readSnapshot`, the pass) on `serialize(input).stored`
   (`normalizeInput`), so the input gets the same refusals as the output, with the same messages.
3. `presets/main` not materialized: adopted in this slice (above). `modules`, `plugins`, and
   `pluginStorage` stay client-created; slice 4 decides whether its assembly needs them from the
   server.
4. `$state.snapshot` drops own `__proto__` keys that `llmSecrets.presets` and
   `globalChatVariables` accept: a slice 4 requirement, recorded in
   `client-section-mirrors.md`.
5. The persona collection accepts `[]` and id-only entries: a slice 6 requirement, recorded in
   `forwarding-personas.md`. The Implementation note above ("the client never holds one without a
   persona") is too strong: the plugin setters accept `personas: []`.
6. Schema versions (adopted): the pass also rewrites a record whose stored `schemaVersion`
   differs from its kind's, and stops the start on a newer one instead of downgrading it.

Rechecked after the fixes: `pnpm check`; the Astra reproductions (`1e400` in `providers` and
`globalChatVariables` is a 400; the `__proto__` HypaV3 case is idempotent with a plain
prototype); the Playwright script (first boot writes only `root`, `modules`, `plugins`; idle
reload writes nothing; a restart changes nothing). Materializing `presets` invalidates four
more tests: the registry expectation in `kinds.test.ts`, the `presets/main` creates in
`resources.test.ts` and `resourcesBatch.test.ts` (two cases).

Behavior until slice 4: the client still reads and writes these fields through `root`. The
section and collection records are created from the fresh-boot defaults and are not filled from
an existing `root` (no migration is owed). So when slice 4 switches the client to them, a store
created before slice 4 shows default settings; its old `root` values are not carried over.

Checks: `pnpm check` (client and strict server), `pnpm format:check`, and `pnpm test`. The test
run failed only in the expected invalidations: `kinds.test.ts` (the kind count, and `presets: []`
no longer unchanged), `backups.test.ts` (three row-id lists now include the materialized rows),
`chatStore.test.ts` and `resourcesChats.test.ts` (a character's `seq` is no longer 1),
`shutdown.test.ts` (the row list). A script check (`node`, over `DEFAULT_RESOURCE_KINDS`):

- Every section's `normalize(undefined)`, and the boot snapshot normalized, equals the snapshot's
  values for that section's fields, in order.
- Every collection's `normalize(undefined)` equals the snapshot's collection apart from ids, and
  `selectedId` is the first item.
- Every kind is idempotent on its materialized value and on the snapshot-derived input.

Playwright (`playwright-core` script, one fresh context):

- First boot: the 18 records exist at revision 1, and the only batch is the client's `root`,
  `presets`, `modules`, `plugins` creation.
- An idle reload sends no batch.
- `restartServer()` over the same `save/` leaves the epoch, every revision, and every record's
  data unchanged: the pass rewrites nothing, including the client-written `presets`.
- A `root` edit (`zoomsize`) is saved in one `root` batch and survives a reload.
- No page errors.

Reviews: the Fable test-adapter adapted the 13 invalidated tests in `kinds`, `backups`,
`chatStore`, `resourcesChats`, `shutdown`, `resources`, and `resourcesBatch`, and refused none.
The Fable reviewer found no problem and confirmed each adaptation is an expected invalidation. It
also added `server/src/tests/normalizeSections.test.ts`, `normalizeCollections.test.ts`, and
`normalizationPass.test.ts` (44 tests), which cover the plan's and Astra's slice 3 testing
advice. Final checks: `pnpm check`, `pnpm format:check`, and `pnpm test` (66 files, 695 passed,
3 skipped).
