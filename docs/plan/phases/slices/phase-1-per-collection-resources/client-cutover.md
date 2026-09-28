# Slice: Client Cutover

Status: done on 2026-09-29 (review round 2).

Phase: [Phase 1](../../phase-1-per-collection-resources.md), plan sections B1-B5.

## Scope

Allowed files: `src/ts/bootstrap.ts`, `src/ts/globalApi.svelte.ts`,
`src/ts/storage/{resourceClient.ts,resourceSync.svelte.ts,nodeStorage.ts,database.svelte.ts}`,
`src/ts/storage/risuSave.ts` (deleted), `src/ts/drive/backuplocal.ts`, `src/ts/characters.ts`,
`src/ts/plugins/apiV3/v3.svelte.ts`, `src/ts/process/mcp/risuaccess/characters.ts`,
`src/ts/setting/advancedSettingsData.ts`, `shared/database.ts`, `src/lang/*.ts`.

## Decisions

- The adapter keeps plain transport state; watchers only mark keys dirty; one cycle in flight; the
  sent text becomes the saved text; a key marked again during a request stays dirty.
- Hydration never echoes: the saved text is seeded from the raw boot response before normalization,
  and a conflict reload records the fetched text.
- The per-chat streaming flags are not saved (client-only state `setDatabase` resets on load).
- Writers of non-selected characters call `markCharactersDirty`: plugin setters,
  `setCharacterByIndex`, MCP character tools, and the end of a generation.
- A 409 reloads only the conflicting records; the selected character is not swapped out during a
  generation. A 412 stops saving and reloads the page.
- Setting the password on a fresh server also logs in, so the first run works without a reload
  (found by the manual first-run check).

## Validation

Manual checks with the built client in headless Chrome over the DevTools protocol against a fresh
server (see the phase file). Tests: review round 2.

## Residual risk

Writes to non-selected characters through paths not listed above are not saved (as before, when
they needed `requiresFullEncoderReload`); Phase 2 routes every chat writer.
