# Phase 0: Shared Schema And Server Store

Status: not started.

Depends on: nothing. Confirm the storage-engine and shared-module Open Decisions first.

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
  Move each declaration into a shared schema folder that both tsconfigs include, and re-export it
  from its old location so no importer changes in this phase.
- **Respect both compilers.** `server/tsconfig.json` sets `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  and `nodenext`, so shared modules may contain no `enum`, no namespaces, no parameter properties, no
  runes, and only relative imports with `.ts` extensions. The LLM enums are already `as const`
  objects with union types, so they qualify. `database.svelte.ts` keeps `getDatabase()` and its one
  `$state.snapshot` call; only declarations move.
- **Settle the import convention.** The root `tsconfig.json` uses `moduleResolution: bundler` with
  `noEmit: false`, which rejects `.ts` extensions in import paths. The expected change is
  `allowImportingTsExtensions` plus `noEmit: true` (Vite performs the build regardless). Prove it with
  `pnpm check` and `pnpm build` before the schema moves.
- **Add the server data layer.** A `server/src/data/` module with a `ResourceStore` that reads,
  writes, lists, and removes typed resources as one JSON file each under `save/<kind>/<id>.json`,
  reusing `encodeFileName` and the stage-and-rename write path from `server/src/routes/storage.ts`.
  Each stored document carries `revision` and `schemaVersion`. A write takes the expected revision
  and fails with a conflict when it differs. Each resource kind registers a pure `normalize`
  function; for this phase the functions are identity.
- **Add the resource routes.** `server/src/routes/resources.ts`, registered in `createServerContext`
  behind `auth.checkAuth` and the shared limiter: get, put, list, and delete per kind, returning
  `{ revision, data }`, 409 on a stale revision, 400 on a body the normalizer rejects. No client
  caller yet.
- **Tests.** `server/src/tests/resources.test.ts` using `createServerContext({ rootDir: tmp })` and
  the signer in `testSupport.ts`: round trip, stale revision rejected, malformed body rejected, list
  order, delete.
- **Docs.** Add the data layer and routes to `docs/structure/self-host-server.md` (`Files`, `Routes`,
  `Tests`) and the schema folder to `docs/structure/persistence.md` and the `STRUCTURE.md` path
  ownership table.

## Safety Contract

No client behavior changes. `NodeStorage`, the storage routes, the save file format, and every
importer of `database.svelte.ts` keep working unchanged. The new routes are unused by the client.

## Exit Criteria

- `pnpm check` type-checks the shared schema through both the Svelte project and the server project.
- The resource routes have passing tests, and `pnpm test` still runs the existing client suite.
- The Open Decisions for storage engine and import convention are recorded as confirmed in
  `PLAN.md`.
- The touched guides list the new modules.

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`, and `server/src/tests/resources.test.ts`.
