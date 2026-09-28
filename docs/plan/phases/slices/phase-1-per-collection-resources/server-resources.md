# Slice: Server Resources

Status: done on 2026-09-29 (review round 1).

Phase: [Phase 1](../../phase-1-per-collection-resources.md), plan sections A1-A5.

## Scope

Allowed files: `shared/resources.ts`, `server/src/data/{kinds,resourceStore}.ts`,
`server/src/routes/resources.ts`, `server/src/app.ts`. Tests belong to the review step.

Stopping condition: a client need the server contract cannot express without a Phase 2 decision
(chat rows, message ids).

## Decisions

- Ids: 1-512 UTF-16 units, well-formed Unicode, no control characters, not `.`/`..`. Chosen over
  mapping ids (a second id space and a hash lookup per inlay read). Changes the Phase 0 rule.
- Kinds: eight, with `singleton` for the six single-record kinds (only id `main`, not deletable).
  `normalize(input, { id })` so the character normalizer can require `chaId === id`.
- Epoch fencing with an explicit header instead of parsing tokens (tokens stay opaque, and a create
  with `baseRevision: null` after a restore is refused too).
- One atomic batch per save cycle (up to 5,000 operations under the existing 100 MiB body limit;
  the old autosave already uploaded the whole uncompressed database under the same limit). No split
  protocol; a single character over the limit is a Phase 2 problem.
- Consistent reads are single synchronous store calls (one connection; no read transaction needed).

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`; the scratch smoke script over `app.request()`; Astra
challenges 1 and 2 and Fable's review (see the phase file).

## Residual risk

A reverse proxy that rewrites `%2F` in paths breaks ids containing `/` (inlay ids from Lua); recorded
as a deployment limit.
