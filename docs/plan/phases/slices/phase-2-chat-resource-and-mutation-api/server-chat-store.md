# Slice: Server Chat Store

Status: done on 2026-09-29 (review round 1).

Phase: [Phase 2](../../phase-2-chat-resource-and-mutation-api.md), plan section A.

## Scope

Allowed files: `shared/chats.ts`, `shared/resources.ts`, `server/src/data/{chats,chatStore,kinds,resourceStore}.ts`,
`server/src/routes/resources.ts`. Tests belong to the review step.

Stopping condition: a client need (round 2) the op set cannot express without a new op or a revision
rule change.

## Decisions

- Chats are tables inside the resource store (`chats`, `messages`, `chatOrders`), not a resource kind:
  messages are rows with an integer position so one op touches one row. Layout version 2; a version-1
  database is refused at startup (no migration owed in alpha).
- One chat group per chat per batch; its ops apply in order in the batch's transaction. `create` only
  first, `delete` only alone, `baseRevision: null` exactly for a create group. Chat reorders are
  separate entries with their own order revision. Deleting a character cascades.
- Revision rule: by-id ops (`append`, `setMessage`, `setText`, single `remove`, `meta`) apply to an
  older revision of the same chat incarnation while their message exists and report `stale: true`;
  `replace`, `delete`, multi-id `remove`, reorders, and a `begin` of an unknown generation need the
  current revision (a `begin` on a message inserted in the same group does not). Replays are
  idempotent (identical append, single remove of a missing message).
- Generation fence per message (`generationId`, `generationSeq`, `generationFinal`, a history of up
  to 8 earlier ids): outcomes `applied`, `duplicate`, `ignored`; a manual write closes the fence;
  `replace` keeps surviving fences closed; a known generation's `begin` is a no-op replay.
- The 409 union keeps the Phase 1 resource entry shape and adds `kind: "chat"` / `"chatOrder"`
  (reserved kind names); every validation error names `chats[i].ops[j]`, including one raised while
  the group applies (round 3 fix).

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`; the scratch smoke script over the routes; Astra
challenges 1-3 and Fable's review (see the phase file).

## Residual risk

The fence orders one client's generation writes; it does not lock a message against another device
(Phase 5 moves generation to the server).
