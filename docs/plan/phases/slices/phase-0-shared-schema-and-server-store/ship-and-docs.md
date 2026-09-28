# Slice: Ship And Docs

Status: done on 2026-09-29.

Phase: [Phase 0](../../phase-0-shared-schema-and-server-store.md), plan steps 5 and 6.

## Scope

Allowed files: `Dockerfile`, `STRUCTURE.md`, `docs/structure/*.md`, `docs/plan/**`.

Stopping condition: the image fails to start or cannot import `shared/`.

## Work

- `Dockerfile` runtime stage copies `shared/`.
- Guides: `self-host-server.md` (Files, Routes, State, Coupling, Invariants, Recipes, Tests, Known
  Hazards), `persistence.md` (Scope, Files, Recipes), `build-test-platforms.md` (tsconfigs), and
  the guides that named moved declarations: `app-shell.md`, `scripts-triggers.md`,
  `chat-pipeline.md`, `llm-requests.md`, `media-aux.md`, `memory.md`, `plugins-mcp.md`,
  `ui-theming.md`. `STRUCTURE.md`: T2, D1, the path ownership row for `shared/`, and the scoped
  update date. `PLAN.md`: status line and the token format under Decision 1.

## Validation

`docker build -t risu-metatron:phase0 .` succeeded. The container served `/` (200),
`/api/test_auth` (`{"status":"unset"}`), and `/api/resources/root` (400 `No auth header`), created
`/app/save/data/resources.sqlite` with its `-wal` and `-shm` files at startup, and imported every
`/app/shared/*.ts` with plain `node`. The only log line besides startup was the existing SSL
fallback notice. `pnpm format:check` passes.

## Residual risk

None known.
