# Phase 0: Shared Schema And Server Store

Status: not started.

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
