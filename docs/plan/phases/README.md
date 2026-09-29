# Server Data Ownership Phase Guide

The phase files translate [`PLAN.md`](../PLAN.md) into bounded outcomes. Each file records its
status, dependencies, objective, required work with the identifiers to grep, a safety contract, exit
criteria, and validation. Update the status line of a phase in the same change that advances it.

## Execution Order

Phase 0 makes the persisted types compile in both runtimes and gives the server a typed store.
Phase 1 replaces the save blob with per-collection resources and moves browser-local user data to
the server. Phases 2 and 3 split chats and settings out of their blocks and may run in parallel.
Phase 4 re-points every external contract at the mutation API. Phase 5 moves generation, all Lua,
the triggers, and the display transform to the server. Phase 6 thins the client and closes out.

## Phase Index

- [Phase 0: Shared schema and server store](phase-0-shared-schema-and-server-store.md)
  (done; slices in [`slices/phase-0-shared-schema-and-server-store/`](slices/phase-0-shared-schema-and-server-store/))
- [Phase 1: Per-collection resources](phase-1-per-collection-resources.md)
  (done; slices in [`slices/phase-1-per-collection-resources/`](slices/phase-1-per-collection-resources/))
- [Phase 2: Chat resource and mutation API](phase-2-chat-resource-and-mutation-api.md)
  (done; slices in [`slices/phase-2-chat-resource-and-mutation-api/`](slices/phase-2-chat-resource-and-mutation-api/))
- [Phase 3: Settings sections](phase-3-settings-sections.md)
  (planned slices in [`slices/phase-3-settings-sections/`](slices/phase-3-settings-sections/))
- [Phase 4: External contracts](phase-4-external-contracts.md)
  (planned slices in [`slices/phase-4-external-contracts/`](slices/phase-4-external-contracts/))
- [Phase 5: Server-side processing](phase-5-server-side-processing.md)
  (planned slices in [`slices/phase-5-server-side-processing/`](slices/phase-5-server-side-processing/))
- [Phase 6: Thin client and closeout](phase-6-thin-client-and-closeout.md)
  (planned slices in [`slices/phase-6-thin-client-and-closeout/`](slices/phase-6-thin-client-and-closeout/))

## Slices

Each phase is split into slices under `phases/slices/phase-<n>-<slug>/<slice>.md`, with a `README.md`
in the folder giving the execution order and the dependencies. One slice migrates one collection,
one write-site group, one processing stage, or one spike. A slice records its status, the exact
files and identifiers it touches, the allowed files, its stopping condition, the validation it ran
with results, and residual risk.

Slices may be written before their phase starts, as a validation of the phase file against the
tree. A slice written that way has status `planned` and two extra sections: `Assumptions`, the
decisions of earlier phases or slices it rests on, stated as checkable lines, and
`Proposed decisions`, the design choices it recommends. When the phase starts, the first step is
to re-verify every Assumption and every identifier against the tree; a false Assumption re-plans
that slice, and a `planned` slice becomes `in progress` only after that check. The folder's
`planning-notes.md` records what the pre-planning found: the drift between the phase file and the
tree with the proposed phase-file edits, the boundaries that depend on other phases, and the open
questions for the plan owner; `review-decisions.md` records the review points raised against the
planned slices and the decision on each. Phase-file edits proposed there are applied when the phase
starts, in the same change that advances its status line. A proposed exception to the Common Entry
Gate below (for example, starting a phase's independent slices before its dependencies are complete)
takes effect only once it is recorded in this file.

## Common Entry Gate

- The dependencies named in the phase file are complete.
- The Decisions in `PLAN.md` that the phase implements are still current.
- The previous path (reader, writer, or client-side stage) is still in place as the rollback seam.

## Common Exit Gate

- The phase's exit criteria are met and recorded in the phase file.
- `pnpm check`, `pnpm test`, and `pnpm format:check` pass.
- New server routes have tests in `server/src/tests/`; new pure modules have colocated tests.
- `docs/structure/` guides and the `STRUCTURE.md` invariants that the phase affects are updated in
  the same change.
- Any hook, effect, or function that stops working in a server context is listed in the phase file
  under its safety contract.
