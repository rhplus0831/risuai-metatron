# Server Data Ownership Phase Guide

The phase files translate [`PLAN.md`](../PLAN.md) into bounded outcomes. Each file records its
status, dependencies, objective, required work with the identifiers to grep, a safety contract, exit
criteria, and validation. Update the status line of a phase in the same change that advances it.

## Execution Order

Phase 0 makes the persisted types compile in both runtimes and gives the server a typed store.
Phase 1 replaces the save blob with per-collection resources and moves browser-local user data to
the server. Phases 2 and 3 split chats and settings out of their blocks and may run in parallel.
Phase 4 re-points every external contract at the mutation API. Phase 5 moves generation, Lua, and
data-only hooks to the server. Phase 6 thins the client and closes out.

## Phase Index

- [Phase 0: Shared schema and server store](phase-0-shared-schema-and-server-store.md)
- [Phase 1: Per-collection resources](phase-1-per-collection-resources.md)
- [Phase 2: Chat resource and mutation API](phase-2-chat-resource-and-mutation-api.md)
- [Phase 3: Settings sections](phase-3-settings-sections.md)
- [Phase 4: External contracts](phase-4-external-contracts.md)
- [Phase 5: Server-side processing](phase-5-server-side-processing.md)
- [Phase 6: Thin client and closeout](phase-6-thin-client-and-closeout.md)

## Slices

When a phase starts, split it into slices under `phases/slices/phase-<n>-<slug>/<slice>.md`. One
slice migrates one collection, one write-site group, or one processing stage. A slice records its
status, the exact files and identifiers it touches, the allowed files, the validation it ran with
results, residual risk, and its stopping condition. No slice exists yet.

## Common Entry Gate

- The dependencies named in the phase file are complete.
- The Open Decisions in `PLAN.md` that the phase needs are confirmed.
- The previous path (reader, writer, or client-side stage) is still in place as the rollback seam.

## Common Exit Gate

- The phase's exit criteria are met and recorded in the phase file.
- `pnpm check`, `pnpm test`, and `pnpm format:check` pass.
- New server routes have tests in `server/src/tests/`; new pure modules have colocated tests.
- `docs/structure/` guides and the `STRUCTURE.md` invariants that the phase affects are updated in
  the same change.
- Any hook, effect, or function that stops working in a server context is listed in the phase file
  under its safety contract.
