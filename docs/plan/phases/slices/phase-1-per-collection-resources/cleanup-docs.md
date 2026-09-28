# Slice: Namespace Cleanup And Docs

Status: done on 2026-09-29 (review round 2).

Phase: [Phase 1](../../phase-1-per-collection-resources.md), plan sections A9 and D.

## Scope

`server/src/routes/storage.ts` (`STORAGE_NAMESPACES` = `assets`), `STRUCTURE.md` (D1, D4, glossary),
`docs/structure/{persistence,self-host-server,global-api,app-shell,backup-sync-hub,plugins-mcp,chat-pipeline,media-aux}.md`,
`docs/plan/PLAN.md`, the phase file, and these slice files.

## Validation

`pnpm format:check`; the guides name only identifiers that exist (`rg`).
