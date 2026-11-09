# Persistence: Database, Records, Mutation Stores

## Scope

- Owns the persisted `Database` model and field-to-resource map; the settings, preset, and character records; the
  mutation modules; the settings views and selection; the browser-local import and device stores.
- Paths: `src/ts/storage/` except the files the guides below own, `src/ts/toggles/`, `src/ts/chatLoadPages.ts`, and the
  persisted shapes in `shared/` (a shape's meaning stays with its original module's guide, such as `shared/llm.ts` →
  [LLM requests](llm-requests.md)).
- Not here: [save loop, boot](resource-sync.md), [live updates](live-updates.md),
  [chat module, checkpoints](chat-store.md), [journal, recovery](draft-recovery.md),
  [server store, routes, archives](server-resources.md), [backup UI, upstream converters](backup-sync-hub.md),
  [asset client and queues](assets.md#asset-client), [import transports](characters-modules.md#import-transports).
- A `Decision:` plan name resolves through [the archive](../archived-plan/README.md).

## Files

Each entry is the path, its role, and the identifiers to look up; the rules are the doc comments on those identifiers
and the module headers.

### Shared shapes

`shared/` is consumed by the client and strict server; its runtime restrictions are in
[STRUCTURE T2](../../STRUCTURE.md#repository-wide-invariants). The shared modules are the contracts to read with their
callers:

- Runtime exceptions (`cbs/`, `scripts/regex.ts`, `lore/`, `prompt/{chatTemplate,templateCheck,chatTokens}.ts`,
  `tokenizerChoice.ts`) reach application state through an injected object and may import the pure packages
  `@risuai/ccardlib` and `@huggingface/jinja`; their domain guides own the behavior.
- `shared/sections.ts`: `SECTION_FIELDS`, `COLLECTION_FIELDS`, `FORWARDED_ROOT_KEYS`, `DROPPED_FIELDS`.
- `shared/resources.ts` and `shared/chats.ts`: resource and chat wire types and revision helpers.
- `shared/presets.ts`, `shared/characters.ts`, `shared/personas.ts`, `shared/translatorPresets.ts`,
  `shared/togglePresets.ts`: record schemas and normalizers.
- `shared/recordPatch.ts`, `shared/mutationValidation.ts`: patch validation/application and mutation errors.
- `shared/chatCheckpoints.ts`, `shared/jobs.ts`, `shared/chatBinding.ts`, `shared/chatLoadPages.ts`, `shared/ids.ts`:
  checkpoint, job, binding, chat load-count, and id helpers; their domain guides own semantics.

Client entry modules re-export `shared/` modules: `src/ts/storage/database.svelte.ts` (also `appVer`, `saveImage`),
`src/ts/storage/mutationValidation.ts`, `src/ts/chatLoadPages.ts`.

### Settings records

- `src/ts/storage/selection.svelte.ts`: client selection (`selection`, `loadSelection`, `persistSelection`); character
  and chat selection are per tab.
- `src/ts/storage/settingsViews.svelte.ts`: record views and lookup/write helpers (`settings`, `activePreset`,
  `activeModelPreset`, `activePersona`, `profileForSlot`, `PresetScope`, `writeModelRoot`). The open-chat binding and
  fallback rules are in [Chat binding](#chat-binding).
- `src/ts/storage/presets.svelte.ts`: the preset list operations (`changeToPreset`, `copyPreset`, `importPreset`,
  `downloadPreset`, `applyPresetTemplate`, `copyModelPreset`, `removeModelPreset`).
- `src/ts/storage/llmSecrets.svelte.ts`: masked state and credential write queue (`setSecret`, `clearSecret`,
  `deleteEntrySecret`, `setMaskedSecrets`, `mirrorFields`).
- `src/ts/storage/snapshots.svelte.ts`: legacy shape builders and reports. `src/ts/storage/serverAuth.ts`: `authFetch`.
  `src/ts/storage/exportAsDataset.ts`: `dataset.json` export.

### Mutation modules

The external contracts (plugins, MCP, imports) write these records only through the modules below and the chat module; a
refusal changes nothing (`shared/mutationValidation.ts`). An object value must be plain (`isPlainObject` in
`shared/valueKinds.ts`: prototype `Object.prototype` or `null`), so a `Map`, a `Date`, or a class instance is refused.

- `src/ts/storage/characterStore.svelte.ts`: characters (`characterList`, `characterSnapshot`, `selectedCharacter`,
  `addCharacter`, `adoptCharacter`, `updateCharacter`, `CHARACTER_FIXED_FIELDS`, `replaceCharacterAt`,
  `removeCharacter`, `removeCharacters`, `selectCharacter`).
- `src/ts/storage/collectionStore.svelte.ts`: settings and collection writes (`updateSettings`, `addAuthRefresh`,
  `addCredential`, `deleteCredential`, `copyModelProfile`, `deleteModelProfile`, `incrementStatic`). A deleted
  credential or profile leaves the bindings naming it, which refuse their requests
  ([LLM requests](llm-requests.md#invariants)).
- `src/ts/storage/pluginStorageStore.svelte.ts`: `pluginCustomStorage` ([plugins](plugin-sandbox.md)).

### Record wrappers

`src/ts/storage/records.svelte.ts` owns settings and character record wrappers. Its module header is the wrapper
contract; use these identifiers to trace installation, writes, and save-loop coupling:

- Installation and writes: `initializeRecords`, `applyRaw`, `replaceRecord`, `batchRecordWrites`,
  `setRecordWriteListener`, `setCharacterWriteListener`.
- Wrapper identity and list operations: `trackedRecord`, `BY_ID_FIELDS`, `moveRecordListItem`, `replaceRecordList`,
  `DetachedWrapperError`, `DuplicateIdError`.
- Save projections and adoption: `characterFieldStamp`, `moduleItemFieldStamp`, `adoptCharacterValue`,
  `adoptModuleValue`, `adoptPluginStorageValue`, `applyRawCharacter`, `patchRawCharacter`.
- Credential routing: `CredentialRefusedError`; the external mutation boundary is described above.

## Flows

### Resources

Kinds (`shared/resources.ts`):

- Singletons, id `main`: `presets` (`botPresets`), `modules`, `plugins`, `pluginStorage` (`pluginCustomStorage`),
  `pluginPermissions` (not in `Database`).
- Settings singletons, id `main`, created and normalized by the server (`server/src/data/normalize/`): the five sections
  (`SECTION_FIELDS`) and the collections of `COLLECTION_FIELDS`, served under the same flat names. `translatorPresets`
  and `hypaV3Presets` hold `{ items, selectedId }` (served as `translatorPresetId`, `hypaV3PresetId`); `togglePresets`
  is a plain list, default `[]`.
- `llmSecrets` is write-only and read masked; it also holds the entry map `credentials` (`SECRET_ENTRY_MAPS`), each
  named API key's `key` by id ([credential binding](llm-requests.md)), and normalization drops older `modelPresets` and
  `customModels` maps.
- `ui.blockedRealmCreators`: unique `{ id, name }` entries (`normalizeUi`).
- Per record: `characters` (id = `chaId`, without `chats`, `chatPage`, `reloadKeys`), `inlays`
  ([chat pipeline](chat-pipeline.md)).
- Chats (their own tables, not a kind; [server](server-resources.md)): messages as rows by message id, one revision per
  chat, one order per character. They travel as `chats` groups of ops and `chatOrders`, read with `?chats=1` or
  `refs`/`chats`/`chatCollections`.

### Browser-local import

`importBrowserLocalData` (`src/ts/storage/browserLocalImport.ts`), awaited by every boot before plugins load, moves the
data older versions kept only in the browser to the server: LocalForage `inlay`, `plugin`, `plugin_permissions`,
`iris_dialogues`, and `google-search-credentials`. Its module header holds the per-entry order (the server's copy wins;
write, read back, then delete only a local entry still holding the imported value, which another tab may have changed).

- A restore meanwhile (412) stops the import; any other failed step leaves its entries for the next boot.
- Permission grants merge once per browser (a `localStorage` marker), so a revoked grant stays revoked.
- An inlay whose server metadata lacks its file is repaired from the browser's bytes only when they are the file the
  metadata names (`repairInlayMedia`, `src/ts/process/files/inlays.ts`); otherwise the browser copy stays.
- Deleting `firefox-translations-models` is not awaited: another tab can block it, and a later boot retries.

### Access

- UI reads and mutates settings through the views and characters through `selectedCharacter()`, `characterList()`, and
  their wrappers, reactively; chats are read from the mirror and changed through `chatStore.svelte.ts` or
  `chatEdits.ts`.
- Code that serializes, exports, syncs, or hands data to plugins takes a snapshot builder, `$state.snapshot`, or
  `safeStructuredClone`.
- A plugin never reaches a named API key: it holds no wrapper, and `applyPluginKey` (`v3.svelte.ts`) stores a key
  outside `allowedDbKeys`, `credentials` included, as plain `pluginCustomStorage` data, with no credential refusal.
  `updateSettings` refuses the `llmSecrets` fields itself; `CredentialRefusedError` (`records.svelte.ts`) decides only
  for writes through the views and [wrappers](#record-wrappers).

### Backend

- The block save format (`risuSave.ts`, `database/database.bin`, `dbbackup-*.bin`, `remotes/*`) and remote saving are
  unused: `save/database` and `save/remotes` stay on disk, never read. That data comes back only through a `.bin`
  backup, by the [compatibility rule](#invariants).
- Cold-stored data (browser OPFS `coldstorage_<uuid>.json`, Node `coldstorage/<uuid>`) stays there, never read; cold
  records in a `.bin` backup are read on [import](backup-sync-hub.md#upstream-library-import) only. Skeleton characters
  with a stale `coldstorage` field and chats whose only message is a `COLDSTORAGE<uuid>` pointer load as ordinary ones.

### Device caches

The browser-local stores that remain are rebuildable caches or this device's own state, not user data: nothing cleans
them up, and a backup does not carry them.

- `hypaVector` (LocalForage): embeddings of the browser's `HypaProcesser`, by text and model, for file attachments,
  graph memory, the embedding playground, and the HypaV3 modal.
- `tfCache` (Cache API): Transformers.js model files (`runTransformers`, `runEmbedding`, `runVITS`, the ONNX
  registration in `CharConfig.svelte`).
- `LLMTranslateCache` (LocalForage): translations keyed `llm:<hash>:<source>`, hashing the pipeline signature, the
  languages, and the translator note ([translation](translation.md)); bare-source entries are never read or migrated.
- `localStorage`: `risu-selection`, `risu-selected-chats`, the plugin `SafeLocalStorage` (`safe_plugin_*`, documented to
  plugins as device-specific).
- `sessionStorage`: `risu-selection`, `risu-generation-client` and `risu-generation-jobs` (a reloaded tab reattaches:
  `resumeServerJobs`), `risu-generation-client-claim` (a copied session gets a new id).
- `DPoPDB` (IndexedDB): this browser's non-extractable auth key pair, written and read by `src/ts/storage/serverAuth.ts`
  through the `src/ts/util.ts` keypair store ([global-api](global-api.md#utilts)) and read by `public/sw.js`.

### Character order repair

`src/ts/storage/characterOrder.ts` (its module header): `checkCharOrder` after a change in this tab,
`checkCharOrderAtBoot` over the boot's complete inventory, `queueRemoteCharOrderRepair` for another writer's order.

- Another writer's order (a conflict reload, a live update, a whole read) reaches `onRemoteRecordApplied`, which the
  boot (`watchRemoteRecords`) routes to `queueRemoteCharOrderRepair`, not to `checkCharOrder`. In a microtask after the
  apply step it reads the live characters that order lists nowhere from the server (`readRefs`) and appends at the root
  each one the server holds untrashed, or holds none of while the save adapter has no saved revision of it (this tab's
  create, refused together with its order write): the server's copy decides, since this tab's may be older.
- A read during which another order arrived or the order changed here is dropped, and the repair restarts from the
  newest order.
- It never removes or moves an entry, so an id this tab has not read yet keeps its folder, and it writes only when it
  appends.

### Selection and deletion

- Deleting the selected prompt preset selects the first remaining active one, else the first; a selected model preset or
  persona, the first remaining. Deleting another keeps the selection, and a reorder keeps the selected id
  (`botpreset.svelte`, `removeModelPreset`, `PersonaSettings.svelte`).
- A deletion moves only the tab's selection, never a chat's binding: chats bound to the record show it as deleted and
  are not sent until another one is picked; the confirmation names how many (`chatsBoundTo`).

## State

### Database

- `Database` is the flat compatibility shape in `shared/database.ts`; its fields' stored kinds are mapped under
  [Resources](#resources). `globalChatVariables` remains a read-only legacy toggle fallback.
- Shared `character`/`groupChat` shapes retain `chats` and `chatPage` for server job projections, cards, and plugin
  snapshots; `ClientCharacter`/`ClientGroup` omit them, so records hold no chats. A group has `type: 'group'` and member
  ids in `characters`.
- `pluginCustomStorage` (custom `setDatabase` keys, reserved plugin storage dictionaries): the
  `src/ts/storage/pluginStorageStore.svelte.ts` module header, [plugins State](plugin-sandbox.md#state).

### Chat fields

- `ChatMeta` is defined in `shared/chats.ts`; fields are stored largely as sent, with defaults at their readers. The
  translation lists are owned by [translation](translation.md). Non-obvious field rules:
- `loreOverrides?` (`shared/lore/overrides.ts`) is not defaulted on write: readers use `?? []`. `normalizeChatMeta`
  refuses a present value that is not an array of `{ entry: { id: non-empty string, … }, off: boolean }`
  (`assertLoreOverrides`) and keeps only the first override per `entry.id`, the one the merge applies. The upstream
  import drops a refused value and keeps the chat. Checkpoints capture it, the transform cache key includes it, the
  upstream export strips it.
- `loreBudgetWarnOff?: true` silences the context meter's left-out lore warning ([UI theming](ui-theming.md)); present
  only while set, not a summary field. Copies and chat imports keep it, checkpoints keep the current value, the upstream
  export strips it.
- `isStreaming`/`activeStreamingDisplayOptimizationMode` remain in the type for old data, never stored; a chat's
  streaming message is its `streamingEntry`.

### Chat binding

- List fields `bindedPersona`, `promptPresetId`, `modelPresetId`, `bindingReview`, resolved by `resolveChatBinding`
  (`shared/chatBinding.ts`): strict, no fallback.
- `chatBinding.svelte.ts`: `chatBinding` for a send; `chatDisplayIds` for a render (per field the bound id when its
  record exists, else the tab's); `chatBindingPatch` through `setChatMeta`.
- `pickBinding(field, id, target?)` (`chatBindingPick.ts`): a `ChatRef` binds that chat, `null` selects for the tab,
  `undefined` binds the open chat, or selects for the tab at home.
- The `ui` field `newChatBinding`: `inherit`, the default, copies the selected chat's ids that exist, never
  `bindingReview` (`initialChatBinding`); `empty` leaves a new chat unbound. A character's first chat starts unbound, a
  copy or branch keeps its source's binding, and `importChat` keeps only ids that exist and sets `bindingReview`
  (`importedChatBinding`).

### Chat toggles

- `GLGlobalVariables`: the chat's variable overrides, prompt toggles included (`toggle_<key>` → string), not a summary
  field. `setChatToggle` merges one entry (`mergeChatMeta`), only while loaded and only when the stored value changes. A
  plugin chat result can merge any key, and `resolveGlobalChatVar` takes overrides without the toggle prefix too.
- `initialChatToggles` copies the selected loaded chat's map and `togglePresetId` unless `newChatBinding` is `empty`; a
  chat without a loaded source starts without them and reads legacy/default values. Opening a chat or mounting the panel
  writes no defaults.
- Checkpoint loads split the map by the case-sensitive `toggle_` prefix alone (`isToggleKey`): they keep the current
  toggle entries and restore every other entry.
- `togglePresetId?: string`, stored as sent; a deleted preset leaves it dangling. Unset with `setChatMeta`'s `unset`,
  never null. Neither a summary field nor a merge key, and absent from the transform key's metadata digest, though a
  saved change moves the chat revision and so the key. `importedChatTogglePreset` removes a non-string or locally
  missing id; imported toggle values stay as sent.
- `togglePresets.svelte.ts`: chat operations require `findChat(ref)`; overwrite replaces both maps to drop stale keys.
  Apply projects only defined keys (`toggleValuesForChat`), defaults missing or incompatible values, merges only entries
  whose raw values differ, then links; the two unsent writes coalesce. Never replace the whole map.

### Messages

- `Message` is defined in `shared/database.ts`; `chatId` is its stable per-chat id, assigned by the module.
- `generationInfo.context` (`ContextReport`) is stored as the server wrote it: it travels in checkpoints, exports,
  backups, and every generation patch of its message, and a text edit keeps it. Its size is bounded by the section
  kinds, the 8-entry trim queue, the 8 named rejected lore entries, and at most three HypaV3 budget reductions. Readers
  use `parseContextReport`; data without a valid report reads as none.
- `candidates`, `selected`, `candidatesRevision`, `scriptstateCheckpoint` (`shared/rerollCandidates.ts`): a reply's
  alternatives, its own fields the selected one's. Op writes refuse a bad field; imports and reads drop it. The store
  owns `candidatesRevision`; an append clears other checkpoints.

## Coupling

- The chain to the server: [resource sync](resource-sync.md#coupling). Snapshots: `characterCards.ts`. Contracts:
  `plugins/apiV3/v3.svelte.ts`, `process/mcp/*`, the import functions.

## Invariants

- The boot installs the records as the server sent them (`installBootRecords`), with no client normalization or
  legacy-field cleanup: a leftover `pluginCustomStorage._coldplugin` key is kept as data. Initialize nested parents
  before assigning children (`??=`).
- Every `Database` field belongs to exactly one resource (`shared/sections.ts`: a section, a settings collection, or
  another kind), is forwarded (`FORWARDED_ROOT_KEYS`: served from the selected preset or persona, or this client's
  selection), or is dropped (`DROPPED_FIELDS`). The boot, the records, the views, the projections, and `applyToMirror`
  iterate those lists, so a new field needs only its place there and its `SectionSpec` entry.
- A new kind also needs `server/src/data/kinds.ts` and the branches in `bootstrap.ts` and `resourceSync.svelte.ts`.
- A section or settings collection's projection must equal the server's normalized text for an unchanged record
  (`normalize(project(assemble(normalized))) === normalized`); otherwise every boot writes it. So the client applies no
  default to those fields, and boot code must not rewrite them.
- Character defaults live in `normalizeCharacter` (`shared/characters.ts`). The server applies it on every write and in
  its normalization pass; the client when a character enters (`prepareNewCharacter`, with the creation steps), to a
  whole replacement (`replaceCharacterFields`), and raw before a save whose projection lacks a default
  (`canonicalCharacter`, no mark), so the text sent is the server's normalized text.
- No default is applied at boot or on selection. Neither selection nor an ordinary send writes `lastInteraction` or
  moves the character revision, except the `supaMemory` turn-on.
- Every write of a character's own fields is saved, whichever character is selected. Membership changes only through
  `addCharacter`, `addPreparedCharacters` (a batch: one id set, one membership change, one order repair),
  `replaceCharacterAt`, `removeCharacter`, and `removeCharacters`: a `push`, `splice`, or index assignment through
  `characterList()` throws, and a `chaId` never changes.
- The settings and character records transport their own writes: a write through a view or wrapper, from the UI or a
  `bind:`, is saved without any watcher, and a bulk writer runs in one `batchRecordWrites` scope. External contracts go
  through a mutation module or the chat module.
- Keep the logical asset keys (`assets/<name>`): they are on-disk names.
- A preset field goes in `botPreset` and `PRESET_DEFAULTS`, which `normalizePreset` and the `shared/sections.ts`
  partition follow. Without a default, or with a `null` one, it also needs its kind in `kindsWithoutDefault`, or
  `shared/presets.ts` throws on load. A `null` readers handle goes in `PRESET_NULLABLE_FIELDS` (`normalizePreset`
  replaces any other).
- Every preset of each kind and every persona carries an `id`, assigned synchronously at creation (`normalizePreset`,
  `newPersonaId`, `createTranslatorPreset`, `createHypaV3Preset`, `createTogglePreset`). Copies and imports get fresh
  ids; the `.risup`, `.risutl`, and HypaV3 JSON exports carry none.
- Preset and profile objects carry no credentials: `openAIKey` is a global `llmSecrets` field, the reverse proxy's and a
  custom model's key is a named key a profile binds, `proxyKey` is dropped. The normalizers keep only their record's
  fields, so the server drops any key from stored records. `downloadPreset` exports only the record and prompt field
  lists, so a secret never joins them.
- The `customModels` normalizer drops a legacy `key` and `credentialId`: the profile that uses a custom model binds the
  key. The `credentials` normalizer drops a `key` (and keeps `clientEmail`/`projectId` only on `vertex`); a named key's
  value exists only in `llmSecrets.credentials`.
- `exportAsDataset` does no redaction. The settings report (`buildSettingsReport`) drops every `llmSecrets` field,
  `REPORT_REMOVED_KEYS` (personal or bulky keys, those holding URLs, free text, or third-party names), and every key
  whose name contains `key`, `proxy`, or `hypa`.
- Compatibility rule: data in an upstream RisuAI format is owed a one-way migration into the current store: an upstream
  `.bin` backup (`database.risudat`, its cold-storage records and assets) and an older metatron backup holding
  `database.risudat`. That file is upstream's legacy MessagePack save or the block save; both import, and a live block
  save whose data lies outside the file is refused ([server](server-resources.md) `risuSave.ts`).
- Formats metatron created during its own implementation phases are owed none: the version-1 and version-2 resource
  stores, fields and records marked "alpha, no migration", the removed browser stores. Those are refused or ignored,
  with a message where the user sees one, and changing them needs no converter.

## Recipes

- Add a persisted setting:
  1. Add the field to `Database` in `shared/database.ts`.
  2. Give it its place in `shared/sections.ts` (`SECTION_FIELDS`, a collection, or a preset field in `PRESET_DEFAULTS`).
  3. A section field gets its JSON kind and fresh-boot default in its `SectionSpec` (`server/src/data/normalize/`; the
     type makes a missing entry an error), and any migration there; a preset field its default in `PRESET_DEFAULTS`.
  4. Verify: a fresh server shows the default, the value survives a reload, and an idle reload writes nothing.
- Add a collection with its own resource: see [Invariants](#invariants). Verify a save, a reload, a two-tab conflict,
  and a backup round trip.
- Move more browser-local user data to the server: add a step to `importBrowserLocalData` that writes, reads back, and
  only then deletes the local entry.
- Change the asset backend: `assetClient.ts` (and the auth in `serverAuth.ts`). Asset keys are logical: the server maps
  `assets/<name>` to `save/assets/<encoded name>` and accepts no other namespace ([server](self-host-server.md)).

## Tests

- Focused: `pnpm --silent test:agent records settingsViews presetViews characterStore collectionStore bootSnapshot`.
- `src/ts/storage/tests/mutationStoresHarness.ts` boots mutation tests through `installBootRecords` against
  [`StoreBackedServer`](resource-sync.md#tests), with two of each preset kind, a plugin, and a two-chat character.
- `src/ts/storage/tests/installFlatDatabase.ts` and its `installFlatDatabaseWithChats` helper move root preset fields
  into a preset, reconcile selection, and optionally assemble legacy chats.
- `src/ts/storage/tests/reactiveProbe.svelte.ts` checks tracked reads and untracked writes with runes but no component;
  `derivedProbe.svelte.ts` runs a callback as a `$derived` body.
- `src/ts/storage/tests/bootSnapshot.test.ts` pins server-normalized defaults; intentional default changes update the
  normalizer (or `PRESET_DEFAULTS`) and `fixtures/boot/boot-snapshot.json` together, including omitted `llmSecrets`
  fields held as `""` ([fixture rule](../../src/ts/storage/tests/fixtures/boot/README.md)).
- `src/ts/storage/tests/presetIds.test.ts` pins exact `.risup` export shape (including explicit `undefined` keys) and
  the pre-normalization reader over a second cycle; `src/ts/storage/tests/settingsViews.test.ts` derives its oracle from
  the shared partition tables, and `src/ts/storage/tests/characterOrderRepair.test.ts` defers `readRefs`.
- `slow`: two real-time comparisons in `src/ts/storage/tests/projectionBindings.test.ts`. `e2e`:
  `e2e/0-idleReload.spec.ts`, `settingsPages`, `recordsCharacters`, `presetSelection`, `personaBinding`, `chatBinding`.
- Not tested: `maintainCharacters` beyond the trash pruning (its `checkCharOrderAtBoot` call is not driven).
- Not tested: the records' cost beyond a loose bound: the benchmark asserts nested-write ratios under 10× and nothing
  about the lorebook drag or preset reorder; `measureRecords.mjs` and `measureCharacters.mjs` are manual.

## Known Hazards

### Issues

- The browser-local import has no cross-tab lock: a change another tab lands between `removeIfUnchanged`'s comparison
  and its deletion is lost.
- `replaceCharacterAt` does not repair `characterOrder`: a new id is missing until the next `checkCharOrder`. The old id
  is removed then only if a repair observed it; otherwise boot removes it.
- A character trashed or deleted on the server after the remote repair's read and before its write, with no order change
  between, can be appended. Its id leaves only once this tab holds the trash or deletion and a later `checkCharOrder`
  runs (arrival alone does not run the repair).

### Limitations

- A browser's LocalForage `mcp-tool-calls` store is never read: a tool call remembered only there does not resolve
  (`chat.toolCalls` holds them). Decision: owed no migration ([compatibility rule](#invariants)).
- The section normalizers apply fresh-boot defaults with no cross-section migration: a root `formatversion` is dropped,
  and `providers.loreBookToken` takes its default (8000), not a value derived from older data. Decision: owed no
  migration ([compatibility rule](#invariants)).
- The mutation modules check kind and shape but do not normalize, so a non-canonical value stays in the mirror after the
  server normalized its copy, until a reload or a later server copy. Decision: an accepted limit
  (`collectionStore.svelte.ts` header).
- Two tabs counting at once in `incrementStatic` take the ordinary conflict path,
  [merged](resource-sync.md#record-merge) as a best-effort count. Decision: a whole-record write, not an atomic counter
  (`incrementStatic`).
- An id no repair has observed (a remote character deleted here before any walk, or an id put back after it was
  forgotten) stays in the order, hidden, until the next boot. Decision: unknown ids keep their place, since another
  tab's order can arrive before its characters (`checkCharOrder`).
- The remote repair appends at the root: a folder this tab chose for its new character is lost with the discarded order
  write. A failed read ends the repair (logged) unless another order was announced meanwhile; the next remote order or
  `checkCharOrder` repairs again. Decision: the repair only adds (`queueRemoteCharOrderRepair`).

### Gotchas

- `setCharacterOrder` refuses a folder without a `data` list, while `checkCharOrder` reads one as empty. The repairs
  remove empty folders before filtering members, so a folder their filtering empties survives one call and goes on the
  next.
- A server job's MCP login writes the `authRefreshes` collection (`refreshChanges` in `server/src/mcp/registry.ts`)
  without a `resource` event, so live updates carry it; a tab that saved its own list meanwhile conflicts, reloads the
  server's list, and loses its own addition, so the server that addition named asks for a login again
  (`addAuthRefresh`).
- The sidebar hides a held deletion or trash at once, resolving only own ids; its drag targets use persisted order
  positions, hidden slots included.
- Records have no resolve cache (one halved the cost, but its invalidation rule was never proven). Their cost shows in
  list re-renders reading every row through its wrapper, so a bulk writer changes a list in one write
  ([measurements](../audit/projection-bindings-2026-10-04.md)).
- With large plugin data a warm boot's answer is mostly `plugins` and `pluginStorage`, which stay out of the boot cache
  ([measurements](../audit/boot-measurements-2026-10-29.md)).
