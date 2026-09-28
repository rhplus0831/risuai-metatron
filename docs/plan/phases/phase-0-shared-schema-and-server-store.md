# Phase 0: Shared Schema And Server Store

Status: done on 2026-09-29 (implemented, challenged four times by GPT-6-Astra, reviewed and tested
by Claude Fable, Docker image checked). See [Implementation Record](#implementation-record) and the slices in
[`slices/phase-0-shared-schema-and-server-store/`](slices/phase-0-shared-schema-and-server-store/).

Depends on: nothing. Implements Decisions 1 and 2 in `PLAN.md`.

## Objective

Make the persisted types compile in both the client and the server, and give the server a typed
resource store with revisions and normalization hooks, without changing client behavior.

## Required Work

- **Extract the persisted types into plain modules.** `src/ts/storage/database.svelte.ts` declares
  `Database`, `character`, `groupChat`, `Chat`, `Message`, `MessageGenerationInfo`, `botPreset`,
  `loreBook`, `customscript`, `RisuPersona`, `folder`, and `CustomSideBarItem`, and imports the rest
  from client modules: `RisuPlugin` (`plugins/plugins.svelte.ts`), `triggerscript`
  (`process/triggers.ts`), `NAISettings` (`process/models/nai.ts`), `ColorScheme`
  (`gui/colorscheme.ts`), `PromptItem` and `PromptSettings` (`process/prompt.ts`),
  `OobaChatCompletionRequestParams` (`model/ooba.ts`), `HypaV3Settings`, `HypaV3Preset`, and
  `SerializableHypaV3Data` (`process/memory/hypav3.ts`), `SerializableHypaV2Data`
  (`process/memory/hypav2.ts`), `HypaModel` (`process/memory/hypamemory.ts`), `TranslatorPreset`
  (`translator/presets.ts`), `RisuModule` (`process/modules.ts`), `OnnxModelFiles`
  (`process/transformers.ts`), `Hotkey` (`defaulthotkeys.ts`), `OpenAIChat`
  (`process/index.svelte.ts`), and `LLMFlags`, `LLMFormat`, `LLMTokenizer` (`model/types.ts`).
  Move each declaration into the root `shared/` folder that both tsconfigs include, and re-export
  it from its old location so no importer changes in this phase.
- **Respect both compilers.** `server/tsconfig.json` sets `strict`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `nodenext`, and `lib: es2023` without DOM types, so shared modules may
  contain no `enum`, no namespaces, no parameter properties, no runes, no DOM types, and only
  relative imports with `.ts` extensions, and they must pass strict mode although the root project
  does not use it. The LLM enums are already `as const`
  objects with union types, so they qualify. `database.svelte.ts` keeps `getDatabase()` and its one
  `$state.snapshot` call; only declarations move.
- **Settle the import convention.** The root `tsconfig.json` uses `moduleResolution: bundler` with
  `noEmit: false`, which rejects `.ts` extensions in import paths. Add `allowImportingTsExtensions`
  and `noEmit: true` (nothing emits through `tsc`), and add `shared/**/*.ts` to its `include`; add the `shared` folder to the server `include` as well,
  so shared modules are strict-checked even before the server imports them. Prove
  it with `pnpm check` and `pnpm build` before the schema moves.
- **Ship the folder.** The `runtime` stage of the `Dockerfile` copies only `server` and `dist`. Add
  `shared`, and confirm the image starts.
- **Add the server data layer.** A `server/src/data/` module with a `ResourceStore` over one
  `node:sqlite` database under `save/`. Generic documents share one table (`kind`, `id`,
  `revision`, `schemaVersion`, `data`). A write takes the expected revision and fails with a
  conflict through `UPDATE ... WHERE revision = ?`; a unit of work spanning several resources runs
  in one transaction. The interface leaves room for kinds with tables of their own (chat messages
  in Phase 2). Each resource kind registers a pure `normalize` function; for this phase the
  functions are identity. Open the connection with `journal_mode=WAL`, a `busy_timeout`, and
  `foreign_keys=ON`. Revision tokens include a database epoch (Decision 1).
- **Add the resource routes.** `server/src/routes/resources.ts`, registered in `createServerContext`
  behind `auth.checkAuth` and the shared limiter: get, put, list, and delete per kind, returning
  `{ revision, data }`, 409 on a stale revision, 400 on a body the normalizer rejects. No client
  caller yet.
- **Tests.** `server/src/tests/resources.test.ts` using `createServerContext({ rootDir: tmp })` and
  the signer in `testSupport.ts`: round trip, stale revision rejected, malformed body rejected, list
  order, delete, and a multi-resource transaction that rolls back as a whole.
- **Docs.** Add the data layer and routes to `docs/structure/self-host-server.md` (`Files`, `Routes`,
  `Tests`) and the schema folder to `docs/structure/persistence.md` and the `STRUCTURE.md` path
  ownership table.

## Safety Contract

No client behavior changes. `NodeStorage`, the storage routes, the save file format, and every
importer of `database.svelte.ts` keep working unchanged. The new routes are unused by the client.

## Exit Criteria

- `pnpm check` type-checks the shared schema through both the Svelte project and the server project.
- The resource routes have passing tests, and `pnpm test` still runs the existing client suite.
- The runtime Docker image starts and serves the resource routes.
- The touched guides list the new modules.

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`, `server/src/tests/resources.test.ts`,
and a Docker image build and start.

## Implementation Record

Implemented on 2026-09-29 from a plan reviewed by GPT-6-Astra and Claude Fable.

- **Shared schema.** `shared/` holds `database.ts`, `triggers.ts`, `prompt.ts`, `memory.ts`,
  `modules.ts`, `plugins.ts`, `settings.ts`, `openai.ts`, and `llm.ts` (the only runtime values:
  `LLMFlags`, `LLMFormat`, `LLMTokenizer`, and `DISPLAY_MODE` in `memory.ts`). Declarations moved
  verbatim; four private helpers the old modules still use became exported (`AINsettings`,
  `ProviderPluginCustomLink`, `HypaV3Data`, `Summary`). `triggerMode` and `additonalSysPrompt` are
  runtime-only and stayed in `triggers.ts`. Every old module re-exports its types; no importer
  changed. `DisplayMode` (with `DISPLAY_MODE`) moved from `HypaV3Modal/types.ts` because
  `HypaV3Data` needs it.
- **Store.** `server/src/data/resourceStore.ts` and `kinds.ts`, at `save/data/resources.sqlite`.
  Revision tokens are `<epoch>:<seq>:<revision>` (Decision 1). The six kinds are registered with
  identity normalizers and `unknown` payloads; the store is generic over `ResourceKind<T>`, is built
  with the kind registry, and refuses kind objects the registry does not hold, and Phase 1 binds the
  payload types. Values are stored as `JSON.stringify` produces them; a JSON form that would lose a
  non-finite number, fails to serialize, or nests deeper than 256 levels is refused. `transaction`
  takes a synchronous body (a promise-returning body does not type-check, best-effort, and rolls
  back at runtime); any conflict inside it rolls the unit back even when the body caught it; an
  `AsyncLocalStorage` scope makes writes from work the body started through awaits, promises, or
  timers throw once it returns (event-emitter callbacks are not covered). Plan-review and challenge
  decisions are recorded in the slice files.
- **Routes.** `server/src/routes/resources.ts`. PUT takes `{ baseRevision, data }`, DELETE takes
  `?baseRevision=` (an empty value is a malformed token, 409); a write to a missing record is a 409
  with `revision: null`; DELETE answers
  `{ success: true }` like the storage routes.
- **Behavior change.** None for the client. The server creates `save/data/` at startup, so three
  existing `app.test.ts` assertions that list the exact top-level contents of `save/` need a `data`
  entry (updated by the review step).

Validation on 2026-09-29, before the review step: `pnpm check` 0 errors (5,046 files, server `tsc`
included); `pnpm build` passes; `pnpm format:check` passes; `pnpm test` 305 passed, 3 failed (the
three `save/` layout assertions above, updated in the review), 3 skipped; plain `node` imports every `shared/*.ts`; `docker build` succeeds and
the container serves `/` (200), `/api/test_auth` (`{"status":"unset"}`), and `/api/resources/root`
(400 `No auth header`), creates `/app/save/data/resources.sqlite` with its WAL files at startup, and
imports every `/app/shared/*.ts` with plain `node`.

Review on 2026-09-29 (Claude Fable, after four GPT-6-Astra challenge rounds recorded in
`slices/phase-0-shared-schema-and-server-store/store-and-routes.md`): the fourth challenge found one
exotic edge case, fixed by Fable under the user's instruction for that round: the store's
`JSON.stringify` replacer converted a `Number` box with `Number()`, which accepts a bigint returned by
the box's `valueOf` or `Symbol.toPrimitive` and rounds it, where `JSON.stringify` throws; it now uses
unary plus (`ToNumber`), so such a value is refused (400 / `ResourceValidationError`), and Astra's
probes confirm the other cases unchanged. Tests added: `server/src/tests/resources.test.ts` (routes),
`server/src/tests/resourceStore.test.ts` (store, including the `TransactionBody` compile-time
checks), `server/src/tests/sharedImports.test.ts` (plain `node` imports every `shared/*.ts`), and the
three `save/` layout assertions in `app.test.ts` now include `data`. Results: `pnpm check` 0 errors
(5,046 files, server `tsc` included); `pnpm test` 335 passed, 3 skipped (38 files); `pnpm build`
passes; `pnpm format:check` passes. The Docker recheck after the review passed: the image built
from the final tree serves `/` (200), `/api/test_auth` (`{"status":"unset"}`), and
`/api/resources/root` (400 `No auth header`), creates `/app/save/data/resources.sqlite`, and imports
every `/app/shared/*.ts` with plain `node`.

Observations for Phase 1:

- `RisuSaveEncoder.init` excludes `characters`, `botPresets`, and `modules` from the root block,
  while `set` also excludes `plugins` and `pluginCustomStorage`. Phase 1 picks the canonical
  exclusion set for the `root` kind.
- `list` returns records in creation order (`seq`). That is not a client ordering contract;
  `characters` order needs its own key when Phase 1 splits them.
