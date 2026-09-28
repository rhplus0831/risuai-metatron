# Slice: Server Store And Resource Routes

Status: done on 2026-09-29.

Phase: [Phase 0](../../phase-0-shared-schema-and-server-store.md), plan steps 3 and 4.

## Scope

Allowed files: `server/src/data/{resourceStore,kinds}.ts`, `server/src/routes/resources.ts`,
`server/src/app.ts`. Tests belong to the review step: `server/src/tests/resources.test.ts`, a store
test, and the three `save/` layout assertions in `server/src/tests/app.test.ts`.

Stopping condition: a design point that needs a Phase 1 decision (payload types, the `root` field
set, ordering). Those were left to Phase 1 and recorded in the phase file.

## Plan review decisions

From GPT-6-Astra's review, with Claude Fable's evaluation:

- Adopted: revision token `<epoch>:<seq>:<revision>` (a delete and recreate cannot reuse a
  token); explicit imports for private helpers still used by old modules; normalization inside
  `put`, with a JSON serialization check; rollback-only after any conflict in a transaction;
  409 with `revision: null` for writes to a missing record; route envelope checks (non-array
  object, own `data`, `baseRevision` string or null); parent directory creation, one-transaction
  schema and epoch setup, startup error on an unknown `user_version` or missing epoch, idempotent
  `close`; no Vite, Vitest, or `package.json` changes; six kinds registered now; body and query
  revisions instead of `If-Match`; a `resourceKinds` test seam; `save/data/resources.sqlite`.
- Adopted with changes: the store is generic over `ResourceKind<T>`, but the six kinds stay
  `unknown` with identity normalizers. Binding them to `Database` shapes and choosing `root`'s
  exclusion set is Phase 1 work; typing unchecked input would be a cast, not a guarantee.
- Rejected: a transaction-scoped store facade. An async callback could still call the outer store,
  so the facade would not enforce containment. Instead `transaction` is documented as
  synchronous-only, and a returned promise rolls back and throws.

## Challenge fix round

GPT-6-Astra's challenge of the implementation found five points; Claude Fable confirmed all of them
and the user approved one fix round:

1. A transaction body that awaited could write after the rollback, and that write autocommitted.
   Fixed with an `AsyncLocalStorage` scope around the body: once it returns, writes from work it
   started throw. The signature (`TransactionBody`) also rejects promise-returning bodies at compile
   time while accepting `() => {}`. This supersedes the plan-stage rejection of a facade, which could
   not stop calls through the outer store.
2. `put` stored `1e400` (parsed as `Infinity`) as `null`, answered 500 for very deep nesting, and
   threw `TypeError` for bigint or cyclic normalizer output. `serialize` now rejects non-finite
   numbers, bigints, and nesting beyond 256 levels (which also ends cycles) before `JSON.stringify`,
   and maps any stringify failure to `ResourceValidationError` (400).
3. The store accepted any kind object, so a caller could substitute a normalizer. The store now
   takes the registry (`createResourceStore({ file, kinds })`, as the plan first said) and refuses
   unregistered kind objects.
4. An empty `?baseRevision=` answered 400; it is now a malformed token (409).
5. The guide named test suites that do not exist yet; it now says they are pending.

## Second challenge fix round

GPT-6-Astra's challenge of the first fix round found four more points; Claude Fable confirmed them
and tested the fixes; the user approved a second round:

1. A custom thenable returned by the body ran its `then` outside the transaction scope, so its
   continuation could still write. The thenable check and the rejection handler now run inside the
   scope.
2. Validation walked the raw value while `JSON.stringify` stored the `toJSON` result, so a `toJSON`
   returning `Infinity` stored `null` and a deep `toJSON` result passed the depth limit.
   `serialize` now rejects non-finite numbers in a replacer (which sees post-`toJSON` values), maps
   every stringify failure to `ResourceValidationError`, and checks depth on the parsed JSON, which
   `put` returns. The contract is now "stored as `JSON.stringify` produces it", not "unchanged".
3. `TransactionBody` rejected `() => never` bodies and let promise-or-value unions through. It now
   tests `Extract<ReturnType<F>, PromiseLike<unknown>>` against `never`, documented as best-effort.
4. Callbacks registered on an event emitter do not inherit an `AsyncLocalStorage` scope. The docs
   now limit the guarantee to awaits, promise continuations, and timers; binding emitter callbacks
   is not part of Phase 0.

## Third challenge fix round

GPT-6-Astra's challenge of the second round found three edge cases and one risk; Claude Fable
confirmed them and probed the fixes; the user approved the fixes:

1. The `instanceof Number` branch in the replacer missed cross-realm and `Symbol.toPrimitive`
   boxes, called `valueOf` twice, and rejected `Object.create(Number.prototype)`. The replacer now
   detects real boxes with `util.types.isNumberObject`, converts once with `Number()`, and
   serializes that primitive, as `JSON.stringify` would.
2. `JSON.rawJSON("1e400")` bypassed the replacer and stored `Infinity`. The walk over the parsed JSON
   form (`assertStoredJson`) now also rejects non-finite numbers.
3. `TransactionBody` rejected bodies returning `any` (`() => JSON.parse(text)`). `any` now passes; the
   doc says an overloaded function reference is judged by its last overload.
4. Accepted as a documented risk (`self-host-server.md` Known Hazards): depth is checked after full
   serialization and parsing.

## Fourth challenge fix round

GPT-6-Astra's challenge of the third round confirmed its three fixes and found one new defect, which
it classified as an exotic edge case unlikely in real-world use. Under the user's instruction for the
round, Claude Fable judged and fixed it, then wrote the tests:

1. `rejectNonFiniteNumber` converted a `Number` box with `Number()` (`ToNumeric`), which accepts a
   bigint returned by the box's `valueOf` or `Symbol.toPrimitive` hook and rounds it, where
   `JSON.stringify` (`ToNumber`) throws. The replacer now uses unary plus, which is `ToNumber`: the
   value is refused as not serializable, and every other probed case (cross-realm and symbol-coerced
   boxes, prototype-only objects, stateful `valueOf`, `JSON.rawJSON`, depth 256/257, transaction
   exception ordering) is unchanged. HTTP JSON cannot express a `Number` box and no realistic
   normalizer produces one.
2. Astra's accepted risk stands as documented: depth is validated after full serialization.

## Validation

Repository tests added by the review step (`pnpm test`: 335 passed, 3 skipped, 38 files):
`server/src/tests/resources.test.ts` (10 route tests), `server/src/tests/resourceStore.test.ts`
(16 store tests, including `@ts-expect-error` checks of `TransactionBody` that the server `tsc` in
`pnpm check` verifies), `server/src/tests/sharedImports.test.ts` (plain `node` imports every
`shared/*.ts`; a dropped `.ts` on a value import fails it, a type-only import is erased first and is
`tsc`'s job), and the three `save/` layout assertions in `app.test.ts`. The bigint-box test fails
with the round-3 `Number()` conversion and passes with the fix. `createTestServer` in
`testSupport.ts` gained the optional `resourceKinds` seam.

Earlier ad hoc smoke run (not a repository test) through `app.request()` and the store: create, duplicate
create 409, update, stale 409, falsy `data`, array and missing-field bodies 400, invalid JSON 400,
normalizer rejection 400 through the seam, list order, malformed token 409, delete without
`baseRevision` 400, stale delete 409, delete, delete of a missing record 409 `null`, recreate and
old token 409, the SQLite file under `save/data/`, double `dispose`, transaction rollback on throw
and on a caught conflict, nested transaction rejected, async callback rolled back, reopen keeps the
epoch and tokens, and another epoch's token rejected. All matched the plan. `pnpm check` passes.

## Residual risk

None beyond the documented Known Hazards of `docs/structure/self-host-server.md`. The three
`app.test.ts` layout assertions now include `data`.
