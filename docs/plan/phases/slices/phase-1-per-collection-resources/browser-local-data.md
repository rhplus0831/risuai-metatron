# Slice: Browser-Local Data

Status: done on 2026-09-29 (review round 2).

Phase: [Phase 1](../../phase-1-per-collection-resources.md), plan sections B6-B9.

## Scope

Allowed files: `src/ts/process/files/inlays.ts`, `src/lib/Playground/PlaygroundInlayExplorer.svelte`,
`src/ts/plugins/pluginSafeClass.ts`, `src/ts/plugins/apiV3/permissionStore.ts`,
`src/ts/plugins/apiV3/v3.svelte.ts`, `src/lib/Others/IrisModal.svelte`,
`src/ts/process/mcp/googlesearchclient.ts`,
`src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`,
`src/ts/storage/browserLocalImport.ts`, `plugins.md`, `src/ts/plugins/apiV3/risuai.d.ts`.

## Decisions

- Inlay blobs are content-hash assets and are never deleted in this phase; metadata is a resource.
- `SafeLocalPluginStorage` moves into `pluginCustomStorage._safeLocalPluginStorage` with the
  documented JSON-only contract; `SafeLocalStorage` stays device-local (documented as such).
- Permission grants are a server-owned record outside `DBState.db`, append-only, merged on
  conflict; answers cached per plugin and permission; the hash is of the loaded script.
- The Iris dialogue and the Google credentials are root fields, redacted from the settings report.
- The import writes, reads back, and only then deletes each local entry; the server wins on a clash;
  no cross-tab lock.

## Validation

Manual checks (see the phase file): legacy entries in every store moved and deleted locally, a
non-JSON value kept locally, inlays render after clearing site data. Tests: review round 2.

## Residual risk

`mainDom`, `nativeFetch`, and the RPC dispatcher are pre-existing plugin capabilities recorded in
`plugins-mcp.md` for Phase 4.
