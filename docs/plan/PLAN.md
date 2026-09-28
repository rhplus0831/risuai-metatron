# Server Data Ownership Plan

Date: 2026-09-28

Status: decisions confirmed on 2026-09-28. Phase 0 done on 2026-09-29, Phase 1 implemented on
2026-09-29 (see their phase files). Phases 2 and 3 are next.

## Goal

Move the client's single mutable `Database` object, and the structures that depend on it, to the
self-host server piece by piece, until the server owns, validates, and processes user data and the
client only makes requests and renders.

This plan follows the `PLAN.md` plus `phases/` layout of the archived `client-resource-ownership`
and `cross-runtime-boundaries` workstreams in the `risuai-fastify` checkout. It is standalone:
nothing in that checkout is a dependency, and where the two codebases differ this plan follows the
code in this repository. The phase files translate this plan into bounded outcomes; see
[`phases/README.md`](phases/README.md). Current runtime behavior is documented by
[`STRUCTURE.md`](../../STRUCTURE.md) and `docs/structure/`, which stay the source of truth for
shipped behavior.

## Opening Baseline

Measured on the `metatron` branch at `1f262b61` on 2026-09-28. Identifiers are pointers to verify
with `rg`, as `STRUCTURE.md` asks.

| Coupling                                                                                                | Measured                                                                 |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| References to `DBState.db`                                                                              | 2,355 across 120 files                                                   |
| Two-way `bind:` onto `DBState.db` in `src/lib`                                                          | 396 across 26 files                                                      |
| Direct assignments into `DBState.db`                                                                    | 208 in `src/lib`, 75 in `src/ts`                                         |
| Callers of `getDatabase()` (the live object unless `snapshot: true`)                                    | 232 across 56 files                                                      |
| Top-level `Database` fields                                                                             | 375                                                                      |
| Of those: preset-owned / secrets / provider config / UI preferences                                     | 75 / 29 / 45 / 120                                                       |
| Of those: memory, translation, media / entity collections / transient or legacy                         | 66 / 18 / 22                                                             |
| Distinct root fields read through `DBState.db` by `process`, `parser`, `cbs`, `tokenizer`, `translator` | 59 (the UI touches 252)                                                  |
| `character` / `groupChat` / `Chat` / `Message` / `botPreset` fields                                     | 81 / 63 / 23 / 10 / 81                                                   |
| Server understanding of the data                                                                        | none: three namespaces of opaque bytes (`database`, `assets`, `remotes`) |

Structural facts the plan builds on:

- **The save format already has the seams.** `RisuSaveEncoder` in `src/ts/storage/risuSave.ts`
  writes `root`, `preset`, `modules`, `plugins`, `pluginStorage`, `config`, and one
  `CHARACTER_WITH_CHAT` block per character. `saveDb` in `src/ts/globalApi.svelte.ts` tracks changes
  with `toSaveType` at exactly that granularity. But `encode()` concatenates every block, so each
  debounced save uploads the whole database to `database/database.bin` and again as a
  `database/dbbackup-*.bin` copy.
- **A chat has no unit of its own.** A character block carries all of its chats. `sendChat` in
  `src/ts/process/index.svelte.ts` pushes and rewrites live `Message` objects while streaming, and
  dozens of other sites write chats from UI handlers, slash commands, triggers, Lua, plugins, and
  importers.
- **Writes are implicit.** The `$effect` watchers in `saveDb` diff the root object and the selected
  character; nothing calls save. `getDatabase()` returns the live proxy. The plugin API can replace
  the whole object (`setPluginDatabaseLite`), and the MCP RisuAccess tools, Lua, and triggers mutate
  live objects.
- **The processing layer is browser-bound as wired.** `index.svelte.ts` uses Svelte stores and
  blocking alerts; `parser.svelte.ts` needs DOMPurify and the DOM; `tokenizeAccurate` calls the
  parser; the memory algorithms keep vectors in LocalForage `hypaVector` and run transformers on wasm
  or WebGPU; inlays live in LocalForage `inlay` although chat text references them by id. Portable
  today: `templates/chatTemplate.ts`, `templates/templateCheck.ts`, `templates/templates.ts`,
  `request/additionalParams.ts`, `request/shared.ts`, `groupOrder`, `memory/taskRateLimiter.ts`.
- **User data already lives outside the database in the browser.** Inlays, plugin safe storage
  (`SafeLocalPluginStorage`), plugin permissions, the Iris dialogue, and the Google search
  credentials are browser-local and do not survive a second browser.
- **No migration is owed.** `CLAUDE.local.md` states that the save folder is disposable alpha data.
  The block codec, the backup scheme, remote saving, and the on-disk layout may be replaced. The
  cross-user formats (invariant D5) and the plugin API shape are the only compatibility contracts.

## End State

- The server holds every persisted user record as a typed, versioned resource, validates and
  normalizes it, and the client never encodes a save file.
- Chats and messages are server resources. Generation runs on the server as a job that streams
  events to the client and persists the reply.
- LLM provider credentials are stored and used only on the server, and LLM provider calls no longer
  use the reverse proxy (Decision 6). Auxiliary credentials follow in later work.
- The client keeps per-screen projections of server data, receives changes over a socket, and writes
  only through explicit mutation calls.
- Plugins remain browser-side with the same v3 API shape; the server reaches their hooks through a
  job-to-client channel. Lua runs only on the server, and so do triggers and the `editdisplay`
  transform. The browser keeps rendering: Markdown, style handling, sanitization, and the DOM.
- Cross-user formats (cards, presets, modules, translator presets, plugin scripts) are unchanged.

## Invariants

1. Ownership moves by collection, in the order of the existing save blocks, never field by field.
2. Every write ends in an explicit mutation. Until a collection's writers are routed, the old
   implicit writes reach the server through an adapter (the `$effect` diffing in `saveDb`, later
   per-section watchers) that owns dirty tracking and transport; hydration from the server never
   becomes an outgoing edit. Each phase file states which collections switch to explicit mutations
   in it, and the adapter is deleted per collection.
3. `DBState.db` stays the reactive read model for the UI until Phase 6. Its source of truth changes
   first; its shape shrinks last.
4. Every server resource carries a revision. A write names the revision it was based on, and a stale
   write is rejected with 409. This replaces the `BroadcastChannel` tab guard. Chat operations that
   address one message by id are the exception defined in Decision 4.
5. Normalization and defaults move to the server per collection as pure functions with
   node-environment tests. The client stops guessing defaults for a migrated collection.
6. Persisted keys are never renamed (D3) in the shared formats and in the compatibility projection
   that `DBState.db` presents; internal storage shapes may change. Shared artifact formats and discriminators are never
   changed (D5). Removing an effect or hook from a server context is a behavior change and is
   recorded in the phase file, never silent.
7. Each phase updates `docs/structure/persistence.md`, `docs/structure/self-host-server.md`, the
   guides it touches, and invariants D1 to D4 in `STRUCTURE.md` in the same change.
8. `pnpm check`, `pnpm test`, and `pnpm format:check` pass at every phase boundary. New server routes
   get tests in `server/src/tests/`.

## In Scope

- `Database`, `character`, `groupChat`, `Chat`, `Message`, `botPreset`, `RisuModule`, `RisuPersona`,
  `RisuPlugin`, `pluginCustomStorage`, and the browser-local user stores named above.
- `saveDb`, `RisuSaveEncoder`, `RisuSaveDecoder`, `NodeStorage`, `AutoStorage`, `loadData`,
  `setDatabase`, `checkNewFormat`, `assignIds`.
- `server/src/routes/storage.ts` and a new server data layer.
- The send pipeline, request layer, memory algorithms, Lua, triggers, regex scripts, and CBS
  evaluation, as far as Phase 5 moves them.
- Plugin API v3 host functions, MCP RisuAccess tools, backup, export, and import paths.

## Non-Goals

- Multi-user accounts or authorization beyond the current single password. Revisions and sockets
  prepare for several clients of one user, not for several users.
- Porting browser plugins to the server. Provider plugins keep working through the hybrid path in
  Decision 5, or opt into a future server plugin kind that this plan does not define.
- Changing shared formats or the plugin API surface.
- Rewriting the UI. Components keep binding to `DBState.db` until Phase 6.
- Renaming `botPreset` or reworking the separate-model concept (`seperateModels`, `fallbackModels`,
  `seperateParameters`, and their keep-on-switch toggles). A follow-up does that after this plan.
- Re-adding cold storage, Risu Account sync, or remote character saving.

## Decisions

Confirmed on 2026-09-28, then revised the same day after an independent review by GPT-6-Astra and
Claude Fable. The phase files carry the work each decision implies; a phase that needs to deviate
records why in its own file and updates this section in the same change.

| Decision                                                     | Needed by      |
| ------------------------------------------------------------ | -------------- |
| [1. Storage engine](#1-storage-engine)                       | Phase 0        |
| [2. Shared-module convention](#2-shared-module-convention)   | Phase 0        |
| [3. Selection state](#3-selection-state)                     | Phases 2 and 3 |
| [4. Chat writes and streaming](#4-chat-writes-and-streaming) | Phases 2 and 5 |
| [5. Hooks and Lua](#5-hooks-and-lua)                         | Phase 5        |
| [6. Credentials](#6-credentials)                             | Phases 3 and 5 |

Deferred: the owner of the three "keep on preset change" settings (Decision 3) is left to the
follow-up that cleans up `botPreset` and the separate-model concept after this plan.

### 1. Storage engine

- Resources live in one `node:sqlite` database under `save/`, from Phase 0. One JSON file per
  resource was rejected: the plan needs compare-and-set revisions, writes that span several
  resources (`createChat`, `changeToPreset`, `removeChar`), and consistent backups, and the file
  writer has neither locks nor transactions (`server/src/routes/storage.ts`).
- The Node 24 documentation lists `node:sqlite` as Stability 1.2, release candidate, with no flag;
  it loads without a warning on the installed Node 24.21.
- Generic documents use one table: `kind`, `id`, `revision`, `schemaVersion`, `data`. A stale write
  fails through `UPDATE ... WHERE revision = ?`. Multi-resource writes use one short transaction,
  never held across a provider call or a user question. Kinds that need rows of their own (chat
  messages, Decision 4) get their own tables behind the same `ResourceStore` interface. The
  connection opens with `journal_mode=WAL`, a `busy_timeout`, and `foreign_keys=ON`.
- Periodic snapshots use the asynchronous `sqlite.backup()`, not a synchronous `VACUUM INTO` on the
  serving thread. Assets stay files in the `assets` namespace.
- Restore is a server operation: it drains jobs and mutations, imports atomically, and advances a
  database epoch that is part of every revision token and cache namespace, so a client holding
  pre-restore revisions refetches instead of passing a compare-and-set by coincidence.
- A revision token is `<epoch>:<seq>:<revision>`. `seq` is the record's incarnation (an
  autoincrement row id), so a deleted and recreated record never accepts a token from its previous
  life; a write to a missing record is a conflict, not a 404 (Phase 0). Every mutation also names
  the epoch in an `x-resource-epoch` header, so after a restore even a create is refused (Phase 1).

### 2. Shared-module convention

- Persisted types live in a root `shared/` folder compiled by both tsconfigs. Imports inside it are
  relative with `.ts` extensions, because the server runs `.ts` files directly under Node.
- The root `tsconfig.json` gains `allowImportingTsExtensions` and `noEmit: true`. Nothing emits
  through `tsc`: Vite builds the client, Node runs the server, and `pnpm check` only type-checks.
  Both the root and the server `include` gain the `shared` folder, so a shared module is
  strict-checked even before the server imports it.
- Shared modules must pass the server compiler: `strict`, `erasableSyntaxOnly`, `lib: es2023`, and
  no DOM types.
- The `runtime` stage of the `Dockerfile` copies only `server` and `dist`; it gains a copy of
  `shared`, or the image fails at the first import.

### 3. Selection state

- The root working copies are removed. Today `changeToPreset` writes the root copy back into
  `botPresets[botPresetsId]` and copies the next preset over about 75 root fields, and
  `changeUserPersona` does the same for `username`, `userIcon`, `personaPrompt`, and `userNote`.
  With the copy shared and the selection per client, one client's switch would overwrite another
  client's preset.
- The selected preset and persona become per-client ids (not indexes). `DBState.db` keeps the old
  field names (D3) through a forwarding layer that reads and writes the selected preset or persona,
  and every forwarded write is a mutation that carries the id captured at edit time.
- The Svelte 5 `$state` proxy rejects accessor descriptors added through `defineProperty`
  (`state_descriptors_fixed`), so the layer installs enumerable accessors on the raw root object
  before it is proxied and reinstalls them wherever the root is replaced (`setDatabaseLite`, plugin
  `setPluginDatabaseLite`). A spike proves `bind:value`, `$state.snapshot`, the `for ... in` root
  diff in `saveDb`, plugin `setPluginDatabase` writes, and that an edit followed by an immediate
  selection switch and a reload lands in the original record. If the spike fails, Phase 3 uses an
  explicit selected preset and persona projection and moves the call sites instead.
- Presets gain required ids and persona ids become required, both assigned by the server
  normalizer. Copy and import assign fresh ids; `downloadPreset` strips the id so `.risup` stays
  byte-compatible (D5). The normalizer guarantees at least one preset, which removes the
  `botPresetsId === -1` state, and falls back to the first record when a selected one disappears.
  `translatorPresetId` and `hypaV3PresetId` become ids with their collections.
- The forwarding layer maps the fields whose names differ between root and preset (`NAIsettings`
  and `NAISettings`, `reasoningEffort` and `reasonEffort`, `presetRegex` and `regex`). A preset
  missing a field gets the normalizer default instead of inheriting the previous preset's value,
  which is a recorded behavior change.
- Deferred: `setPreset` honors three "keep on preset change" toggles (`doNotChangeSeperateModels`,
  `doNotChangeFallbackModels`, `disableSeperateParameterChangeOnPresetChange`) that keep
  `seperateModels`, `seperateModelsForAxModels`, `fallbackModels`, `fallbackWhenBlankResponse`, and
  `seperateParameters` across a switch. Without the root copy those values need an owner outside
  the selected preset, or the toggles go. That choice is left to a follow-up after this plan, which
  also renames the ambiguous `botPreset` and reworks the separate-model concept. Until then Phase 3
  leaves these five fields and the three toggles on today's path: they stay root fields that
  `setPreset` and `saveCurrentPreset` copy exactly as today, outside the forwarding layer. Because
  selection is per client, these five fields keep the shared-copy hazard across clients; that is
  accepted until the follow-up.
- `presetChain` switches the preset inside `sendChat`. From Phase 5 the job resolves the chain and
  reports the chosen preset id, and the client applies it to its selection.
- The selected chat becomes a per-client chat id, decided in Phase 2 because `chatPage` is a
  `character` and `groupChat` field. `loreBookPage` becomes per-client UI state.

### 4. Chat writes and streaming

- Messages are rows keyed by (`chat id`, `message id`) with an order key and data; ids are unique
  within a chat, and the normalizer de-duplicates them. The chat keeps its metadata as a resource
  with one revision that every operation advances. Message-id assignment moves to the normalizer
  on its own; `assignIds` assigns only character and chat ids today.
- The message being generated is locked against editing from the first chunk until the reply's
  last persistence step, including the asynchronous inlay. While the client generates (Phases 2 to 4) the lock is a client rule; from Phase 5 the server rejects edits to a message its job owns.
  Checkpoints carry the generation id and are accepted only while that generation holds the lock,
  so a late checkpoint cannot overwrite the final text.
- Operations that address one unlocked message by id (`appendMessage`, `setMessageText`,
  `removeMessage`) apply against a stale chat revision as long as the target exists. `setChatMeta`
  is a per-field merge that also applies against a stale revision. `replaceChat`, reordering, and
  bulk removal require the current revision. Whole-chat results from triggers and Lua are diffed
  against the chat they started from and applied as by-id operations; `replaceChat` is the
  fallback only for changes a diff cannot express.
- Writers address messages by `Message.chatId`, never by index. The streaming loop in
  `src/ts/process/index.svelte.ts` fixes `msgIndex` when the stream starts.
- Stream chunks carry the whole text so far. Checkpoints run every three seconds, at stream end,
  and on abort; the durability promise is the last acknowledged checkpoint. While the client still
  generates it also tries a `pagehide` flush with `fetch` `keepalive`, sending the whole text only
  under the 64 KiB keepalive budget and otherwise only the suffix since the last acknowledged
  checkpoint; this flush is best effort. The 125 ms display flush stays separate from persistence.
- Until Phase 5 checkpoints hold what the mirror holds today: the `editoutput` result, or the
  pre-`editoutput` text in the strong streaming display mode. From Phase 5 they hold the raw text
  and the final write holds the `editoutput` result.
- A reply persists at stream end, after the output trigger, and after inlays. The streaming path
  runs the output trigger before inlays and the non-streaming path runs inlays first; both orders
  are kept. A crash keeps the last committed text; no external effect is replayed.
- `isStreaming` and `activeStreamingDisplayOptimizationMode` leave the persisted schema
  (`setDatabase` already resets them on load); a client-local streaming store replaces them for
  `Chats.svelte`.
- Chat data stays eagerly loaded until Phase 6. Lazy loading waits for the projections, because
  dataset export, chat export, the plugin chat getters, and the MCP read tools walk every chat.
- From Phase 5 a chat has at most one active generation job; a second send gets 409. A job keeps
  running and persists after its client disconnects, and a reconnecting client receives the current
  message instead of a replay of chunks.

### 5. Hooks and Lua

- Hooks are split by capability, not by hook name. The server job runs every generation-path hook:
  the `input`, `start`, `request`, and `output` triggers with their Lua entry points; `editinput`
  and `editoutput` regex, Lua, and plugin handlers; `editprocess` regex and plugin handlers (Lua
  skips `editprocess`); Lua `editRequest` (there is no `editRequest` regex); inlay generation; and
  the `sendAIprompt` loop. The `editdisplay` transform also runs on the server. The client keeps
  TTS playback, notifications, Markdown, style handling, sanitization, and the DOM.
- A generation request carries an execution context: character and chat ids, the selected preset
  id, the effective persona id (a bound persona wins), the mode, and the raw input. The client
  settles its pending writes before it sends and fails visibly if they do not settle. The context is
  frozen for the job and reaches every callback and auxiliary model call.
- Lua has one runtime, on the server. Buttons and manual triggers run through a server command
  endpoint, and wasmoon leaves the client bundle. Lua engines are one-use from a pre-warmed pool;
  Lua globals no longer survive between turns, which is a recorded behavior change. Regex and Lua
  run behind a bounded, terminable worker with input, output, batch, and engine memory limits, and
  the per-mode `lowLevelAccess` restrictions (STRUCTURE S2) stay.
- UI effects reach the client through a job-to-client channel instead of failing. Notices
  (`alertNormal`, `alertError`, `reloadDisplay`, `reloadChat`, `v2UpdateGUI`) are events. Questions
  (`alertInput`, `alertSelect`, `alertConfirm`, `v2GetAlertInput`, `v2GetAlertSelect`) are requests
  with a timeout that fail explicitly when no client answers. `v2Command` runs data-changing
  commands on the server under the job context and sends only UI effects to the client.
- The client lists its registered plugin hooks when it creates a job, and the server calls back
  through the same channel only for those, at their current positions: `beforeRequest` and
  `afterRequest` replacers, body and metadata interceptors (without credential headers), and the
  `input`, `process`, and `output` script handlers. A callback envelope names the job, callback,
  targets, and revisions; the client that created the job answers and other clients only observe.
  Server-side changes reach the client before a callback runs, the callback's own mutations settle
  before the job resumes, and callbacks are serialized per client at first. A callback timeout ends
  the job with an explicit error.
- `chatOutput` listeners run on the client as an acknowledged per-reply callback at their current
  position, before auto-continue or `sendAIprompt` recursion; they are skipped for a reply that
  completes while its client is disconnected.
- MCP tools split the same way: remote MCP servers and internal tools run through server adapters,
  and plugin and browser-file tools are channel callbacks.
- Plugin tokenizers are replaced by the built-in tokenizer on the server. Provider plugins
  (`pluginmodel:::`) use a hybrid step: the job sends the assembled prompt, the client runs the
  provider, and the stream returns to the job, which still persists and runs the output hooks.
- The script transform is a read-only batch endpoint with a mode parameter: `editdisplay` for
  rendering, where `parser.svelte.ts` calls `processScriptFull`, and `editprocess` for the HypaV3
  modal and the plugin parser API. For display the server runs Lua `editDisplay`, the `display`
  trigger, CBS, and regex; the browser keeps both additional-asset passes, inlays, thoughts, style,
  Markdown, and sanitization. Targets cover messages, first greetings, background HTML, and
  translated text, each with an owner id and the supplied source.
- Each target runs in a fully isolated context: persistent setters are disabled, Lua
  `editDisplay` chat-variable writes (which persist today) are discarded, `@@inject` does not write
  message text, and `@@emo` comes back as a presentation effect. Registered plugin display handlers
  run between two server calls, keeping today's order (Lua, trigger, plugin, CBS, regex); the first
  call returns its script-state delta and the second applies it, so CBS still sees Lua's writes.
- Display results are cached whatever the CBS in them, by target id, source text hash, transform
  version, and the revisions of the character, modules, and preset regex. CBS that depends on time,
  randomness, the viewport, other messages, or the persona stays as first rendered until a keyed
  revision changes or the user picks the new "Re-render" item in the message menu, which bypasses
  and replaces the cache entry. This is a recorded behavior change.
- While a message streams, the client shows its raw text through the browser-side steps only; the
  server transform runs once the message completes. This is a recorded behavior change. The first
  version answers with JSON; SSE and priority scheduling wait for a measured need. A failure shows
  the unprocessed text with a notice, with no browser fallback.

### 6. Credentials

- Only LLM provider credentials move behind the server for now. From Phase 5 they sit in a
  write-only `llmSecrets` section (set, replace, clear, masked status), the request layer uses them
  on the server, and LLM provider calls stop using the reverse proxy.
- `openAIKey` is effectively global today (`setPreset` never restores it), so it stays one global
  secret. `proxyKey` is restored per preset, so it moves out of the preset objects into
  `llmSecrets` keyed by preset id; copy, delete, and import of a preset carry that entry.
- Auxiliary credentials stay client-readable in the `secrets` section and their calls keep the
  proxy: TTS (including the per-character `oaiTTSConfig.apiKey`), image generation, DeepL
  translation, and the Google search MCP client. Moving them is later work.
- Credentials that browser plugins manage in their own storage or arguments are outside the
  guarantee.

## Phase Order

|                                                                                 Phase | Outcome                                                                                                                   |
| ------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------- |
| [0. Shared schema and server store](phases/phase-0-shared-schema-and-server-store.md) | Types both runtimes compile, a typed server data layer with revisions, no behavior change.                                |
|             [1. Per-collection resources](phases/phase-1-per-collection-resources.md) | The blob, client backups, remote saving, and the tab channel are gone; browser-local user data moves to the server.       |
| [2. Chat resource and mutation API](phases/phase-2-chat-resource-and-mutation-api.md) | Chats are their own resource, and every chat write is explicit.                                                           |
|                           [3. Settings sections](phases/phase-3-settings-sections.md) | Root splits into typed sections with server-side defaults.                                                                |
|                         [4. External contracts](phases/phase-4-external-contracts.md) | Plugin, MCP, Lua, trigger, CBS, backup, and export paths use the mutation API and server endpoints.                       |
|                 [5. Server-side processing](phases/phase-5-server-side-processing.md) | Generation is a server job, all Lua, triggers, and the script transform run on the server, and LLM keys leave the client. |
|             [6. Thin client and closeout](phases/phase-6-thin-client-and-closeout.md) | Per-screen projections, live updates, the aggregate object removed, docs final.                                           |

Phases 2 and 3 are independent of each other and may run in parallel after Phase 1. Phase 4 needs
both. Phase 5 needs Phase 4. Phase 6 needs everything.

## Rollback

Each phase migrates one collection or one processing stage at a time and keeps the previous path
until the new one passes its exit criteria. Roll back by restoring that collection's previous reader
and writer, not by reverting other phases. The on-disk layout changes in Phase 1 and no migration is
owed, so rolling back across Phase 1 means discarding the `save/` folder, which the project rules
allow.

## Closeout Criteria

- No production code reads `getDatabase()` for a live object, and no client code encodes a save
  file.
- Every collection has a server resource with revision checks, normalization, and route tests.
- A send round trip runs as a server job with streamed events and persisted messages, and provider
  keys are absent from the client's network traffic.
- Two clients of the same server converge after a write in either.
- `docs/structure/` describes the final architecture, and this plan is archived.
