# Server Data Ownership Plan

Date: 2026-09-28

Status: draft for review. No phase has started. Phase 0 is the first change.

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
- Provider credentials are stored and used only on the server; the reverse proxy is no longer used
  for provider calls.
- The client keeps per-screen projections of server data, receives changes over a socket, and writes
  only through explicit mutation calls.
- Plugins remain browser-side with the same v3 API shape. Lua and triggers that need no UI run on
  the server.
- Cross-user formats (cards, presets, modules, translator presets, plugin scripts) are unchanged.

## Invariants

1. Ownership moves by collection, in the order of the existing save blocks, never field by field.
2. Before a collection becomes remote, every write to it goes through an explicit mutation function.
   The `$effect` diffing in `saveDb` may remain only for collections that have not migrated yet and
   is deleted per collection.
3. `DBState.db` stays the reactive read model for the UI until Phase 6. Its source of truth changes
   first; its shape shrinks last.
4. Every server resource carries a revision. A write names the revision it was based on, and a stale
   write is rejected with 409. This replaces the `BroadcastChannel` tab guard.
5. Normalization and defaults move to the server per collection as pure functions with
   node-environment tests. The client stops guessing defaults for a migrated collection.
6. Persisted keys are never renamed (D3). Shared artifact formats and discriminators are never
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
  Phase 5, or opt into a future server plugin kind that this plan does not define.
- Changing shared formats or the plugin API surface.
- Rewriting the UI. Components keep binding to `DBState.db` until Phase 6.
- Re-adding cold storage, Risu Account sync, or remote character saving.

## Open Decisions

Decisions the reviewer should make or confirm before the phase that needs them.

| Decision                                      | Needed by      | Recommendation                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage engine on the server                  | Phase 0        | One JSON file per resource under `save/`, reusing the stage-and-rename writer. Move to `node:sqlite` only if message paging or search needs it.                                                                                                                                                   |
| Shared-module import convention               | Phase 0        | A `shared/` folder compiled by both tsconfigs. The server imports with `.ts` extensions; the root tsconfig gains `allowImportingTsExtensions` with `noEmit`. Verify with `pnpm check` before committing to it.                                                                                    |
| Which selection fields stay persisted         | Phase 3        | `chatPage`, `botPresetsId`, `selectedPersona`, and `loreBookPage` become per-client state. The server keeps only data.                                                                                                                                                                            |
| Streaming persistence policy                  | Phases 2 and 5 | The client mirror updates per chunk; the server persists on completion plus periodic checkpoints.                                                                                                                                                                                                 |
| Pipeline hooks once generation is server-side | Phase 5        | Tiered. Data-only regex, safe-subset triggers, and data-only Lua run on the server. Input, start, output, display, and button hooks plus plugin listeners run on the client around the job. Provider plugins and low-level Lua network or model calls use an explicit hybrid mode or are dropped. |

## Phase Order

|                                                                                 Phase | Outcome                                                                                                             |
| ------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------- |
| [0. Shared schema and server store](phases/phase-0-shared-schema-and-server-store.md) | Types both runtimes compile, a typed server data layer with revisions, no behavior change.                          |
|             [1. Per-collection resources](phases/phase-1-per-collection-resources.md) | The blob, client backups, remote saving, and the tab channel are gone; browser-local user data moves to the server. |
| [2. Chat resource and mutation API](phases/phase-2-chat-resource-and-mutation-api.md) | Chats are their own resource, and every chat write is explicit.                                                     |
|                           [3. Settings sections](phases/phase-3-settings-sections.md) | Root splits into typed sections with server-side defaults.                                                          |
|                         [4. External contracts](phases/phase-4-external-contracts.md) | Plugin, MCP, Lua, trigger, CBS, backup, and export paths use the mutation API and server endpoints.                 |
|                 [5. Server-side processing](phases/phase-5-server-side-processing.md) | Generation is a server job, Lua and data-only hooks run on the server, and provider keys leave the client.          |
|             [6. Thin client and closeout](phases/phase-6-thin-client-and-closeout.md) | Per-screen projections, live updates, the aggregate object removed, docs final.                                     |

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
