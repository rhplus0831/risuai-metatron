# Phase 4: External Contracts

Status: in progress (started 2026-09-30). Plan:
[`slices/phase-4-external-contracts/implementation-plan.md`](slices/phase-4-external-contracts/implementation-plan.md).

Depends on: Phases 2 and 3.

## Objective

Re-point everything outside the core app that writes the database at explicit client mutations
and the server resources: the plugin API v3 host, the MCP RisuAccess tools and the other MCP
writers, the Lua and trigger APIs, and the import paths. The API shapes stay the same. The
settings-UI import handlers (translator, HypaV3, theme, regex, and the preset buttons) are core
app and belong to Phase 6.

## Required Work

- **Mutation modules.** Client functions that validate and detach their input, write the mirror
  by id, and mark a record the adapter's watchers would miss:
  - characters (`characterStore.svelte.ts`);
  - the settings sections and collections, and presets (`collectionStore.svelte.ts`);
  - plugin storage (`pluginStorageStore.svelte.ts`);
  - `checkCharOrder` (`characterOrder.ts`).

  A mutation scope (`beginMutationScope()` with `flushResources({ scope })`) reports every
  discard since a callback began, so a callback's writes either persist without a discard or the
  callback fails with the discarded keys.

- **Plugin API v3** (`src/ts/plugins/apiV3/v3.svelte.ts`, `plugins.svelte.ts`,
  `pluginSafeClass.ts`, `src/ts/gui/colorscheme.ts`).
  - `setPluginDatabase` and `setPluginDatabaseLite` route each `allowedDbKeys` key to its owning
    mutation; the whole-database normalizer call goes. New characters are appended, and confirmed
    plugins are upserted.
  - `setChar` and `setCharacterToIndex` go through the character module. The chat half is
    already done: `setChatToIndex` calls `applyChatResult` (Phase 2).
  - The v3 `pluginStorage` functions and `SafeLocalPluginStorage` write through the plugin
    storage module.
  - The host exports that write through helpers go through the modules: the argument setters,
    the color and text theme setters, `changeColorScheme`, `checkCharOrder`, and `importPlugin`.
  - `getDatabase`, `getChar`, and the indexed getters already return snapshots; they stay.
  - The declared surface in `risuai.d.ts` does not change.
- **Plugin call context.** Inside a hook (a `chatOutput` listener, a script handler, a replacer,
  a provider), the host functions resolve the character, chat, and preset from a context the hook
  runner captured, keyed by plugin. A target that is gone fails; outside a hook the tab's
  selection applies.
- **MCP.**
  - The RisuAccess set and delete tools (`src/ts/process/mcp/risuaccess/characters.ts`,
    `modules.ts`) write by id through the modules and re-resolve after consent.
  - `getCharacter` in `utils.ts`, and a new `findModule`, return read-only views; the read tools
    are unchanged.
  - The writers outside `risuaccess/` go through the modules as well: `registerRefresh` and
    `importMCPModule` in `mcp.ts`, and the credential prompt in `googlesearchclient.ts`.
- **Lua and triggers** (`src/ts/process/scriptings.ts`, `src/ts/process/triggers.ts`).
  - The four Lua character setters (`setName`, `setDescription`, `setCharacterFirstMessage`,
    `setBackgroundEmbedding`) and their getters address the run's character (the speaking member
    in a group) through the character module.
  - The eight trigger character effects (`v2SetCharacterDesc`, `v2SetReplaceGlobalNote`, and the
    six lorebook effects) patch the trigger's character. `v2SetPersonaDesc` updates the selected
    persona.
  - Already mutations (Phase 2): `upsertLocalLoreBook`, the Lua chat functions, `v2SetVar`, and
    `v2SetAuthorNote`. `runTrigger` results are persisted with `applyChatResult` at every caller.
  - Which of these later run on the server is Phase 5's concern.
- **CBS.** Done by Phase 5's `cbs-and-regex-services` (the shared evaluator move); Phase 4 touches
  no CBS file.
- **Export and import.**
  - The card import in `src/ts/characterCards.ts`, the module imports (`importModule`,
    `characterURLImport`, the drop handler in `App.svelte`), `importUserPersona`, the global
    `importLoreBook`, `importPreset`, and `importChat` (its folders and its target) create
    records through the modules.
  - `exportAsDataset` reads a snapshot.
  - Already snapshot-based: `exportChar` and `SettingsExportButtons.svelte`. Already done
    (Phase 2): `importChat`'s chats.
- **Docs.** `docs/structure/plugins-mcp.md`, `scripts-triggers.md`, `backup-sync-hub.md`,
  `characters-modules.md`, `persistence.md`, `chat-pipeline.md`, `self-host-server.md`,
  `global-api.md`; `STRUCTURE.md` D1 and D4; `plugins.md`.

Invariant 2 in this phase: `pluginStorage` is the one collection that switches to explicit
mutations; its watcher is deleted once every writer is routed. The save adapter stays the
transport for characters, sections, and the other collections until Phase 6.

## Safety Contract

No plugin-visible API changes shape or permission semantics. Every write that reached `DBState.db`
from these contracts now reaches a resource; none is dropped. An archive produced with the
supported schema version (since Phase 3) still restores.

## Exit Criteria

- **Function-level audit.** The contract functions assign nothing into `DBState.db` outside the
  mutation modules: the rooted discovery grep, published with its exclusions, answers only the
  residual hits each slice lists by identifier, and every hit is classified in this file. The
  core-app writers are recorded as the allowlist Phase 6 inherits (and Phase 5, for the CBS and
  request-layer writes). Settings bindings keep the section watchers until Phase 6.
- The plugin tests (`src/ts/plugins/**/*.test.ts`) and the MCP RisuAccess tests, extended with
  write cases, pass against the mutation API.
- A backup round trip and a card import work against server resources.

## Validation

Plugin and MCP test suites, a backup round-trip check recorded in this file, and `pnpm check`,
`pnpm test`, `pnpm format:check`, `pnpm build`.
