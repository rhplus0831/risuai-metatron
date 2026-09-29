# Slice: CBS And Regex Services

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 1 (the CBS evaluator and the regex
engine); PLAN.md Decision 5 and Decision 2 (the shared-module convention, extended here to
runtime modules). Also Phase 4's "CBS" item (keep the injected host callbacks and feed them read
models), folded in here so that the same seam has one owner.

Depends on: nothing in Phases 3 or 4. Startable now. `lore-templates-and-tokens` injects the token
counter; `script-worker-spike` provides the boundary the regex engine runs behind on the server.

## Scope

Allowed files: `shared/cbs/registry.ts` (moved from `src/ts/cbs.ts`, which becomes a re-export),
`shared/cbs/evaluator.ts` (the evaluation loop extracted from `src/ts/parser/parser.svelte.ts`),
`shared/cbs/types.ts` (`CbsConditions` from `parser.svelte.ts:1078`, `matcherArg`),
`shared/llm/model.ts` (`LLMModel` from `src/ts/model/types.ts:27`, needed by the registry's
`getModelInfo` callback; the catalogue itself moves in `request-layer-and-llm-secrets`),
`shared/scripts/regex.ts` (the regex engine extracted from `src/ts/process/scripts.ts`),
`src/ts/cbs.ts`, `src/ts/parser/parser.svelte.ts`, `src/ts/process/scripts.ts`,
`src/ts/process/infunctions.ts` (`calcString` takes its variable accessors as parameters),
`src/ts/model/types.ts` (re-export), `docs/plan/PLAN.md` Decision 2 (one sentence: runtime
modules allowed in `shared/`). Tests belong to the review step.

Identifiers (verified 2026-09-30): `registerCBS`, `CBSRegisterArg` (`src/ts/cbs.ts:103-137`:
`registerFunction`, `getDatabase`, `getUserName`, `getPersonaPrompt`, `risuChatParser`, `makeArray`,
`safeStructuredClone`, `parseArray`, `parseDict`, `getChatVar`, `setChatVar`, `getGlobalChatVar`,
`calcString`, `dateTimeFormat`, `getModules`, `getModuleLorebooks`, `pickHashRand`,
`getSelectedCharID`, `getModelInfo`, `callInternalFunction`, `isMobile`, `appVer`), `matcherArg`,
`defaultCBSRegisterArg`. The three direct host reads to move behind callbacks:
`get(CurrentTriggerIdStore)` in `trigger_id` (`cbs.ts:222`; the phase file says line 201),
`window.innerWidth`/`innerHeight` in `screenwidth`/`screenheight` (1520, 1530), and
`navigator.language` in `metadata` (2096), which the phase file does not name. The only non-type
imports of `cbs.ts` are `get` from `svelte/store` (5) and `CurrentTriggerIdStore` (6). In
`parser.svelte.ts`: `initMatcher` (1087-1141), `matcher` (1154), `risuChatParser` (1668-1966;
reads `DBState.db` at 1688-1689 and 1710-1711 and `get(selectedCharID)` at 1712 for defaults, no
DOM inside the loop), `makeArray`/`parseArray`/`parseDict` (1252-1281), `hasher` (1074,
`crypto.subtle` SHA-256). In `scripts.ts`: `ScriptMode` (31), `processScript` (39-47),
`processScriptFull` (127-449) with the order Lua (137-142), display trigger (144-161), plugin
`pluginHooks[mode]` handlers for every mode including `editprocess` (163-170), CBS (172), script
collection `db.presetRegex ++ char.customscript ++ getModuleRegexScripts(chatRef)` (173), cache
(174-183; `processScriptCache` 88-89, `resetScriptCache` 123-125), flags and `<order n>`
(354-391), `executeScript` (184-304: synchronous `new RegExp(input, flag)` and `data.replace`),
dynamic assets through `HypaProcesser` (400-443), the `@@inject` write `setMessageText(...)` (258),
the `@@emo` write to `CharEmotion` (230-251). `calcString` (`infunctions.ts:173`) imports
`getChatVar`/`getGlobalChatVar` from `chatVar.svelte`.

Strict-mode cost: the client compiles with `strict: false`; `shared/` and the server compile
strict. A read-only `tsc --strict --lib es2023` run by the review counted about 81 errors in
`cbs.ts`, 73 in `parser.svelte.ts`, and 15 in `scripts.ts`; the moved parts must be fixed to
strict as part of this slice (type narrowing, no semantic change; a fix that would change behavior
is a stopping condition).

Stopping condition: a CBS function or regex flag whose behavior cannot be reproduced without the
DOM beyond the three named reads, or a strict-mode error whose fix would change a result; recorded,
and the server returns its literal input for that function until the owner decides.

## Assumptions

- Phase 4's CBS item is done here, not in Phase 4: the callbacks are fed read models (a frozen
  `Database`-shaped view) by this slice's wrappers, and Phase 4 leaves `cbs.ts` untouched. This is
  a proposed edit to the Phase 4 file (see the report).
- `shared/` compiles under both tsconfigs with `strict`, `erasableSyntaxOnly`, `lib: es2023`, no
  DOM types, relative `.ts` imports (Decision 2, Phase 0 record).
- `@risuai/ccardlib` and `mnemonist` import under plain Node (checked 2026-09-30).

## Proposed decisions

- Location (proposed): runtime code that both runtimes execute lives in `shared/` next to the
  types, with host access only through an injected object; PLAN.md Decision 2 records the
  extension, and `STRUCTURE.md` T2/D1 say so at cutover. Alternative: a server copy under
  `server/src/prompt/` (rejected: two evaluators drift and the golden test would compare the
  server against itself). Alternative: the client imports from `server/` (rejected).
- New host callbacks (proposed): `getTriggerId(): string | null`, `getViewport(): { width, height }`,
  `getBrowserLanguage(): string`. The client wires them to `CurrentTriggerIdStore`, `window`, and
  `navigator`; the server wires `getTriggerId` to the job or transform context and the other two to
  what the transform request carries (a generation job answers `0` and the server locale; recorded).
- The evaluator is `evaluateCBS(text, arg, host)` in `shared/cbs/evaluator.ts`; the client's
  `risuChatParser(text, matcherArg)` keeps its signature and supplies the `DBState.db` default and
  the selected character. `tokenizeAccurate` and `consistantChar` are unchanged.
- The regex engine is `runRegexScripts(data, scripts, mode, { cbsConditions, host, limits })`
  returning `{ data, effects: { emotion?, inject?: { messageId, text }, repeatBack? } }`: the
  `@@emo` and `@@inject` side effects become returned effects that the client orchestrator applies
  as today and the server applies under the job context (the transform discards `inject`). The
  cache stays inside the engine (final output, 1,000 entries), one instance per host. Dynamic
  assets are a host callback (`matchDynamicAssets`) that the server leaves unimplemented until
  `memory-on-server` (recorded). On the server the engine runs inside the script worker
  (`script-worker-spike`); the engine itself has no worker dependency, so the client runs it in
  place.
- The orchestration around the engine (Lua edit hook, display trigger, plugin handlers) stays in
  `src/ts/process/scripts.ts` for the client and is rebuilt on the server in `trigger-runtime`
  and `script-transform`; this slice changes no call site's behavior.

## Validation

`pnpm check`, `pnpm test` (`src/ts/parser/tests/cbs/*.test.ts`, `chatVar.svelte.test.ts`,
`trimMarkdownStyle.test.ts`, `edittransRegex.test.ts` through the wrappers), `pnpm build`,
`pnpm format:check`; `server/src/tests/sharedImports.test.ts` extended to the subfolders; the
review step adds `server/src/tests/cbs.test.ts` and `regex.test.ts` running the same fixture
strings under `// @vitest-environment node` and comparing with the client wrapper's output (the
first golden test of the phase).

## Residual risk

The second `time` registration in `registerCBS` overwrites the first (`cbs.ts:582-590`,
`1761-1779`); the move keeps that order. CBS functions that depend on time, randomness, the
viewport, other messages, or the persona evaluate on the server at transform time; their caching
is `script-transform`'s recorded change.
