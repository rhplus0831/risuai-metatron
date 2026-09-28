# Phase 4: External Contracts

Status: not started.

Depends on: Phases 2 and 3.

## Objective

Re-point everything outside the core app that reads or writes the database at the mutation API and
the server resources: the plugin API v3 host, the MCP RisuAccess tools, the Lua and trigger APIs,
the CBS host callbacks, and the backup, export, and import paths. The API shapes stay the same.

## Required Work

- **Plugin API v3** (`src/ts/plugins/apiV3/v3.svelte.ts`). `setPluginDatabase` and
  `setPluginDatabaseLite` apply the `allowedDbKeys` subset as per-collection mutations instead of
  assigning `DBState.db`; `setChar`, `setCharacterToIndex`, and `setChatToIndex` go through the
  character and chat mutations; `pluginStorage` reads and writes target the `pluginStorage`
  resource; `getDatabase`, `getChar`, and the indexed getters keep returning snapshots. The declared
  surface in `risuai.d.ts` does not change.
- **MCP RisuAccess** (`src/ts/process/mcp/risuaccess/characters.ts`, `modules.ts`, `chats.ts`,
  `utils.ts`). The set and delete tools use mutations; `getCharacter` in `utils.ts` returns a
  snapshot rather than the live object; the read tools are unchanged.
- **Lua and triggers** (`src/ts/process/scriptings.ts`, `src/ts/process/triggers.ts`). The character
  setters (`setName`, `setDescription`, `setCharacterFirstMessage`, `setBackgroundEmbedding`),
  `upsertLocalLoreBook`, `v2SetVar`, `v2SetAuthorNote`, `v2SetCharacterDesc`, `v2SetPersonaDesc`,
  and the lorebook effects write through mutations; `runTrigger` results are persisted with
  `replaceChat`. Which of these later run on the server is Phase 5's concern.
- **CBS** (`src/ts/cbs.ts`). Keep the injected host callbacks (`getDatabase`, chat variable
  accessors, module lorebooks, selected-character accessors) and feed them read models. No CBS
  function changes.
- **Backup, export, import.** `src/ts/drive/backuplocal.ts` builds archives from server resources
  through a server export route and restores by posting resources; `src/ts/storage/exportAsDataset.ts`
  and `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte` read snapshots; card import in
  `src/ts/characterCards.ts` and `importChat` in `src/ts/characters.ts` create records through
  mutations; `exportChar` stays snapshot-based.
- **Docs.** `docs/structure/plugins-mcp.md`, `docs/structure/scripts-triggers.md`,
  `docs/structure/backup-sync-hub.md`, and `docs/structure/characters-modules.md`.

## Safety Contract

No plugin-visible API changes shape or permission semantics. Every write that reached `DBState.db`
from these contracts now reaches a resource; none is dropped. A backup produced before the phase
still restores.

## Exit Criteria

- No code path outside the mutation modules assigns into `DBState.db`.
- The plugin tests (`src/ts/plugins/**/*.test.ts`) and the MCP RisuAccess tests pass against the
  mutation API.
- A backup round trip and a card import work against server resources.

## Validation

Plugin and MCP test suites, a backup round-trip check recorded in the phase file, and `pnpm check`,
`pnpm test`, `pnpm format:check`.
