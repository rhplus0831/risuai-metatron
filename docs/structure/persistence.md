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

### Shared shapes

`shared/` compiles in the client and the strict server (`server/tsconfig.json`). Node runs it directly, and the
`Dockerfile` runtime stage copies it. Old client modules re-export what moved here, so importers keep their paths.

- Rules: STRUCTURE T2, and only type declarations, `as const` objects, primitive constants, plain constant arrays, and
  small pure functions with no runtime dependencies; imports only between `shared/` files.
- Exception: the runtime modules `cbs/`, `scripts/regex.ts`, `lore/`,
  `prompt/{chatTemplate,templateCheck,chatTokens}.ts`, and `tokenizerChoice.ts` reach application state only through an
  injected object and may import pure packages that run in both runtimes (`@risuai/ccardlib`, `@huggingface/jinja`).
  Domain guides own their semantics.
- `chats.ts`: the chat wire contract; a conflict's `reason` is `generating` (a generation lock) or `expired` (a possibly
  forgotten group id). `chatCheckpoints.ts`: `CHECKPOINT_CHAT_FIELDS` classifies every `ChatMeta` key as `capture`,
  `keep`, or `split`. `jobs.ts`: the generation job contract ([server](server-generation.md)).
- `resources.ts`: wire types. `compareRevision` orders two tokens of one epoch by `(seq, revision)` for hydration;
  `revisionDigest` is an order-independent fingerprint. Resource ownership is in [Resources](#resources).
- `sections.ts`: the [field-to-resource map](#invariants). `modelPresetRootValue` derives one model root for the server
  and views; `forwardPresetRoots` gives a job's or request's preset roots (slot model ids, main-profile fields, and
  prompt `maxContext` override from `maxContextOverrideOf`).
- `presets.ts`: the schema of both preset records: `PRESET_DEFAULTS` (every field's fresh-boot default),
  `PRESET_FIELD_KINDS`, and the partition `MODEL_PRESET_FIELDS` (slots, toggle), `MODEL_PROFILE_FIELDS`,
  `PROMPT_PRESET_FIELDS`, `PRESET_RECORD_FIELDS` ([profiles and slots](llm-requests.md)).
- `PROMPT_PRESET_LOCAL_FIELDS` (`archived`, list metadata) is kept by `normalizePreset`, served by no root view or
  `activePreset`, and not exported. `normalizePreset` keeps prompt fields only; `normalizeModelPreset` tags slots, main
  and sub always a profile; `normalizeModelProfiles` is never empty (`DEFAULT_MODEL_PROFILE_ID`).
- `personas.ts` `normalizePersonas`: never empty, the four persona fields strings, unique ids (the server's normalizer
  runs it). `ids.ts` `newId`: a v4 UUID from `crypto.getRandomValues`, which works outside a secure context.
- `translatorPresets.ts` `normalizeTranslatorSteps`: 1 to 5 steps, the old `{ prompt, maxResponse }` shape as one step;
  `sendTextAsIs` and `excludeThoughts` kept only as `true`.
- `togglePresets.ts`: `normalizeTogglePresets` gives a possibly empty list with unique ids, bare-key string values and
  known kinds, deterministic timestamp fallbacks; `captureToggleValues`, `toggleValuesForChat`, and
  `compareTogglePreset` work on joined definition text, first key winning.

### Settings records

- `selection.svelte.ts`: `presetId`, `modelPresetId`, `personaId`, `loreBookPage` per client, under `risu-selection` in
  `sessionStorage` (this tab's, read first) and `localStorage` (a new tab's start), never on the server; `characterId`
  and `chatOpen` are per tab, held by the URL. `loadSelection` runs before the installation; `persistSelection` stores
  one for the next load without applying it.
- `settingsViews.svelte.ts`: the selected presets and persona over the records. Every access resolves anew, a read
  writes no record, and writes resolve untracked.
- A preset field reads from the selected preset that owns it: `activePreset` (prompt fields), `activeModelPreset`
  (slots, toggle), `profileForSlot(slot)`/`activeMainProfile`/`activeSubProfile` (never redirecting a missing profile),
  and the derived model roots through `modelPresetRootValue`, written through `writeModelRoot` under the plugin
  [write rules](llm-requests.md#invariants).
- `presetFieldValue` (shared with the server): a missing value reads as its `PRESET_DEFAULTS` value, a `null` in an
  object or array field outside `PRESET_NULLABLE_FIELDS` as a fresh default, any other `null` as `null`. A missing or
  non-string persona field reads as its `PERSONA_DEFAULTS` value.
- The open chat's [binding](#chat-binding) comes first: a bound id naming a record wins, then the tab's selection. The
  chat module registers that reader (`setOpenChatBindingSource`), since it imports the views. A tab id naming no record
  falls back to the first record on read and becomes the selection, never the chat's; a write while it names none is
  dropped.
- `currentPresetRecord` and its kin have that fallback; `presetRecordForWrite` and its kin lack it and follow the same
  order, so a settings page edits what the open chat uses. `tabSelectionIds()`/`tabPersonaRecord()` ignore the chat.
  `selectedPresetIndex`/`selectedPersonaIndex`: the legacy `botPresetsId`/`selectedPersona`, 0 with none.
- A captured `PresetScope` pair (`readPresetFieldOf`, `writePresetField`, `missingPresetTarget`) resolves by id, never
  redirected; `scopedPresetRoot` throws `PresetTargetGoneError` for a gone preset.
  `readSettingsRoot`/`writeSettingsRoot` reach a field by its flat root name.
- `presets.svelte.ts`: `changeToPreset(id)` only selects: every field lives in its preset. `copyPreset` and
  `importPreset` give fresh ids on every path and drop `archived`. An import ignores the model fields and a `proxyKey`,
  except that the file's `maxContext` seeds an unset `maxContextOverrideSize`, the override left off unless the file
  turns it on.
- `downloadPreset(id)`: `name`, `image`, and the prompt fields; no id, `archived`, or credential; one model field,
  upstream's `maxContext`, the main model's effective size (`maxContextOverrideOf`, else the main profile's when above
  0, else 4000). `applyPresetTemplate` keeps the selected preset's id, name, image, and `archived`. `copyModelPreset`
  names the same profiles. `removeModelPreset` never removes the last one.
- `llmSecrets.svelte.ts`: `llmSecretState` holds the masked record last answered, a version per credential path, and the
  queue of credential writes (`setSecret`, `clearSecret`, `deleteEntrySecret` for a deleted named key's entry). A
  write's plaintext lives only in its queued op until it is sent.
- `secretStatus(path)` is the masked leaf with the queued writes applied in queue order (`pending` while one is
  unacknowledged). `setMaskedSecrets(masked, invalidate)` bumps a path's version when its status changed, for each path
  in `invalidate` (an acknowledged write's target), and for every path on `"all"` (a changed reread or a remote reload).
- `mirrorFields`: what the tab's record holds: the readable siblings, every credential field `""`, `OaiCompAPIKeys`
  `{}`. `llmSecretsText`: the sibling-only text the adapter writes and compares.
- `snapshots.svelte.ts`: builders of the legacy flat shape, each a fresh plain copy, never reactive, cached, or written
  back: `rootSnapshot` (`undefined` kept as an own key), `buildDatabaseSubset` (the plugin `getDatabase`),
  `buildSettingsReport`, `buildBackupInventory`.
- `serverAuth.ts`: ES256 JWT over a non-extractable P-256 key; parallel requests share one check, and setting the
  password on a fresh server also registers this browser's key. `authFetch`'s `beforeDispatch` runs after signing, right
  before the request, and a throw stops it.
- `exportAsDataset.ts`: chats and lore as `dataset.json`. `chatLoadPages.ts`: defaults of 30 initial pages, 15
  additional.

### Mutation modules

The external contracts (plugins, MCP, imports) write only through these. Each validates its whole input and detaches it
before the mirror changes (a refusal throws `MutationValidationError` and changes nothing; a record gone by id throws
`MutationTargetGoneError` or returns `false`), then writes by id.

- `characterStore.svelte.ts`: `characterList()` (creation order), `characterSnapshot(chaId)` (detached, without chats).
  `addCharacter` gives the chats ids and queues their creates (`adoptCharacter`), then joins the order.
  `updateCharacter` refuses `CHARACTER_FIXED_FIELDS`. `removeCharacters` (the boot's trash pruning) makes one list
  change, keeps generating characters, and repairs the order once.
- Selecting a character turns on `supaMemory` when the HypaV3 preset has `alwaysToggleOn`.
- `collectionStore.svelte.ts` `updateSettings(patch, { presetId?, modelPresetId? })`: section fields into their section,
  preset fields into the named preset, else the one a view reads now (a gone one refused), a model root through
  `writeModelRoot`. The `llmSecrets` fields, `proxyKey`, the persona fields, and the selection indexes are refused.
- `addAuthRefresh`: one OAuth refresh entry per MCP server `url`, a new login replacing it. A server job's login writes
  the same collection without a `resource` event; live updates carry it, and a tab that saved its own list meanwhile
  conflicts and loses the entry it added, so that server asks for a login again.
- `addCredential` stores metadata only, under a fresh id, the two Vertex fields only on `vertex`; the value goes through
  `setSecret` on `{ kind: "entry", field: "credentials", id }`. A credential's type is fixed. `deleteCredential` takes
  the record and its key entry; every binding naming it stays and refuses its requests.
- `copyModelProfile` copies the binding, never a key; `deleteModelProfile` never removes the last one, and slots naming
  it stay dangling and refuse their requests. These writes queue each record once per call (`batchRecordWrites`).
- `pluginStorageStore.svelte.ts`: the only runtime writer of `pluginCustomStorage` ([plugins](plugin-sandbox.md)); each
  writer is one `batchRecordWrites` scope. A read never creates the record.
- `shared/mutationValidation.ts` (the server's RisuAccess host uses it too): `requireJsonData` takes JSON up to 256
  levels, no class instances, cycles, or non-finite numbers; `writeEntries` makes an inherited-name key such as
  `constructor` an own key through a rebuilt object.

### Record wrappers

`records.svelte.ts` is the source of truth of the sections, the settings collections, `presets`, `modules`, `plugins`,
`pluginStorage`, and the characters, each a deep write-through record.

- `trackedRecord(kind)` wraps the `$state` data: a nested read returns a wrapper; a write, `delete`, or `defineProperty`
  at any depth writes the data and queues the save in the same task (`setRecordWriteListener`, the adapter's `markKey`).
  Nothing is wrapped while a record is absent (`hasRecord`).
- Identity: the root resolves by kind on every access, `BY_ID_FIELDS` elements by id, others by object
  (`DetachedWrapperError` for a gone one, `DuplicateIdError` for an ambiguous id). A same-record wrapper assigned stores
  its current object, a foreign one a detached copy.
- Credentials never enter a record. On `llmSecrets` every credential path, and a named key's `key` on any element or
  list written (a non-empty one routed with the element's id, a blank or absent one ignored, a leaf `""` clears), go to
  `setSecret`/`clearSecret` or are refused (`CredentialRefusedError`) before anything changes. The inline keys
  `customModels[].key`, `modelPresets[].proxyKey`, a profile's `key`/`proxyKey`, and old `llmSecrets` maps are refused.
- `initializeRecords` (an installation) and `applyRaw` (a server copy) never queue; `replaceRecord` and every wrapper
  write do. `batchRecordWrites(fn)` queues once per kind. `moveRecordListItem` and `replaceRecordList` change a list in
  one write.
- A character leaving the list loses its canonical node; its meta stays, so a same-id re-add stamps the same one. A
  retained wrapper throws `DetachedWrapperError` while the id is absent, then follows a re-add by id, as another object
  than the fresh wrapper.
- A list that shrinks locally drops its index children. `trimRootList` cuts a root list's original array to the live
  elements after the pending Svelte flush, since Svelte never writes that array; the `$state` list stays the same
  object, or unread reactions would keep the old list's sources.
- After a raw change `unpinBelow` releases the objects the cached nodes hold; the nodes stay and follow their paths, so
  retained and fresh wrappers stay one object. Not during a mutator, for an object displaced in the current task, or
  after a local change, whose moved element is followed by identity.
- Still retained: a throwing mutator's shrink; a local replacement's old value until its node's next read; removed
  elements' nodes in the other by-id lists; nested containers' and in-place replaced elements' original Svelte targets
  (bounded by the data installed). A `length` set through `defineProperty` is not pruned.
- Two tracked module revisions, independent of saving, advance under `untrack` at the write, before batched dispatch, on
  a never-reset counter: `moduleMembershipRevision` (replacements, order, `id`/`namespace`/`mcp` writes, a rebuilt
  element whatever its written field) and `moduleAssetsRevision` (asset writes and replacements).
- `moduleFieldPlain` and `characterFieldPlain` return a shared detached copy (a verified frozen list as itself),
  read-only by contract, memoized by `$state` proxy identity and field stamp, never by id or raw target. A field may be
  read from `proxy[STATE]` only while its stamp equals the meta lifetime: Svelte does not update the raw target. Reading
  writes no record state. Uncacheable data is copied on every read, and each of its wrapper writes advances the assets
  revision.
- Asset lists are immutable: a module's `assets` (`[name, path, ext]` tuples), a character's `additionalAssets` and
  `emotionImages` (tuples) and `ccAssets` (flat records). Each is frozen, entries then list, on entering the record and
  remembered as verified per shape; a list of another shape stays mutable and wrapped. Svelte proxies such a list once,
  never its entries, and a wrapper read returns the list itself (`frozenAssetOf`).
- The raw paths (`applyRaw`, `initializeRecords`, `applyRawCharacter`, `patchRawCharacter`) freeze handed-over data in
  place: a caller that keeps editing its input passes a copy. Local writes freeze an owned copy (`adoptModuleValue`,
  `freshAssetList`), so no live object of a record is ever frozen.
- An edit replaces the whole list (`module.assets = next`), reusing verified entries. A write into a frozen target
  through any path throws a `TypeError` before anything changes (`refuseFrozen`: Svelte's traps would change their
  sources first). `isFrozenAssetList` lets readers key caches by identity (`characterAssetNames`, the parser's fuzzy
  index), retained wrappers excluded.

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

`importBrowserLocalData` (`browserLocalImport.ts`), every boot before plugins load, moves data older versions kept only
in the browser to the server.

- LocalForage `inlay` (old data-URI values included), `plugin` (`safe_plugin_*`), `plugin_permissions`,
  `iris_dialogues`, and `google-search-credentials`, each into its record.
- Per entry: a copy the server holds wins; otherwise it is written and read back. Only then is the local entry deleted,
  and only while it still holds the imported value (`sameLocalValue`, Blob-aware).
- An inlay whose metadata exists without its file (a partial restore) is repaired from the local bytes when they are the
  file the metadata names, else kept. A non-JSON value stays. A failed step leaves its entries for the next boot; a
  restore stops the run.
- `risuSaveCache` and the `risuauth` `localStorage` key are removed. Deleting `firefox-translations-models` (the
  Bergamot translator's models) is attempted without waiting: another tab can block it, and a later boot tries again.

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
- `DPoPDB` (IndexedDB): this browser's non-extractable auth key pair.

### Character order repair

`characterOrder.ts`. Every walk remembers all held ids, trash included, and forgets ids absent from both the list and
the order.

- `checkCharOrder` (re-exported by `globalApi.svelte.ts`) appends live unordered characters except `§playground` and
  removes only held trash or observed ids now absent; unknown ids keep their place and folder. `checkCharOrderAtBoot`
  has the complete inventory: it alone drops never-observed ids, and it resets the observed set.
- Another writer's order (a conflict reload, a feed patch, a whole read) goes to `queueRemoteCharOrderRepair`
  (`watchRemoteRecords`), not `checkCharOrder`. In a microtask after the apply step, the live characters the order lists
  nowhere are read from the server (`readRefs`, 1,000 refs per read), each appended at the root when the server holds an
  untrashed copy, or none while this tab holds no saved revision (its own create, refused with the order write batched
  with it).
- It never removes or moves an entry, so an id this tab has not read yet (a capped read applies the order first) keeps
  its folder, also through a later `checkCharOrder`.
- This tab's copy only picks candidates and can veto (a character trashed here); the server's copy decides, since this
  tab's may be older.
- A read is dropped when another order arrived or the order changed here; the repair restarts from the newest order
  until an attempt ends with it unchanged. It writes once, only when it appends, so its write comes back with nothing to
  append.

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
- `pluginCustomStorage` holds at its top level the custom DB properties the plugin `setDatabase`/`setDatabaseLite` APIs
  route there (keys outside `allowedDbKeys`). Reserved: `_pluginStorage` (plugin `pluginStorage`, JSON-normalized on
  write) and `_safeLocalPluginStorage` (`getLocalPluginStorage()`, JSON values only).

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
  `addCharacter`, `replaceCharacterAt`, `removeCharacter`, and `removeCharacters`: a `push`, `splice`, or index
  assignment through `characterList()` throws, and a `chaId` never changes.
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
- The sidebar hides a held deletion or trash at once, resolving only own ids; its drag targets use persisted order
  positions, hidden slots included.
- Records have no resolve cache (one halved the cost, but its invalidation rule was never proven). Their cost shows in
  list re-renders reading every row through its wrapper, so a bulk writer changes a list in one write
  ([measurements](../audit/projection-bindings-2026-10-04.md)).
- With large plugin data a warm boot's answer is mostly `plugins` and `pluginStorage`, which stay out of the boot cache
  ([measurements](../audit/boot-measurements-2026-10-29.md)).
