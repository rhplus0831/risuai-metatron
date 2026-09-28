# Slice: Shared Schema

Status: done on 2026-09-29.

Phase: [Phase 0](../../phase-0-shared-schema-and-server-store.md), plan steps 1 and 2.

## Scope

Allowed files: `tsconfig.json`, `server/tsconfig.json`, `shared/**`, and the modules that declared
persisted types: `src/ts/storage/database.svelte.ts`, `src/ts/process/triggers.ts`,
`src/ts/process/prompt.ts`, `src/ts/process/memory/{hypav3,hypav2,hypamemory}.ts`,
`src/lib/Others/HypaV3Modal/types.ts`, `src/ts/process/modules.ts`,
`src/ts/plugins/plugins.svelte.ts`, `src/ts/process/models/nai.ts`, `src/ts/gui/colorscheme.ts`,
`src/ts/model/{ooba,types}.ts`, `src/ts/translator/presets.ts`, `src/ts/process/transformers.ts`,
`src/ts/defaulthotkeys.ts`, `src/ts/process/index.svelte.ts`.

Stopping condition: a strict-mode error that would require changing a persisted field's type.
None occurred.

## Work

1. Import convention first: root `noEmit: true`, `allowImportingTsExtensions`, both includes gain
   `shared`, and `shared/llm.ts` takes the three LLM constants. `pnpm check` (0 errors), `pnpm build`,
   and a plain `node` import passed before anything else moved.
2. Declarations moved verbatim into topic files. Old modules use `import type` for what they still
   use and re-export the rest (`export type *` for the trigger and database blocks). Shared files
   import only each other. A diff check confirmed every removed line reappears in `shared/` except
   the four helpers made exported, the `DisplayMode` alias rename, and the `triggerscript` alias.

## Validation

`pnpm check` 0 errors (5,046 files); `pnpm test` all passing at this slice (308 passed, 3 skipped);
`pnpm build` passes; plain `node` imports each `shared/*.ts`; `git diff --name-only` lists only the
allowed files.

## Residual risk

None known. Vitest resolves imports through Vite and would not notice a missing `.ts` extension in
`shared/`; the plain `node` import check covers that.
