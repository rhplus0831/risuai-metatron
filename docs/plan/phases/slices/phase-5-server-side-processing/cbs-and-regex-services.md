# Slice: CBS And Regex Services

Status: implemented (2026-10-01).

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

## Implementation record

Implemented 2026-10-01 on `50f581d4`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 3). No stopping condition triggered: no
CBS function or regex flag needs the DOM beyond the three named reads, and every strict-mode fix
is a type annotation, a non-null assertion, or a cast, which the compiler erases.

- **`shared/cbs/types.ts`**: `CbsConditions` (from `parser.svelte.ts`), `matcherArg`,
  `RegisterCallback`, and `CBSRegisterArg` (from `cbs.ts`). `CBSRegisterArg` gains the three host
  reads: `getTriggerId` (`trigger_id`, the client's `CurrentTriggerIdStore`), `getViewport`
  (`screenwidth`/`screenheight`, the client's `window`), and `getBrowserLanguage`
  (`metadata::browserlang`, the client's `navigator.language`). `matcherArg.var` may be `null`,
  which the evaluator always passed.
- **`shared/cbs/registry.ts`**: `registerCBS` and `defaultCBSRegisterArg`, moved from `cbs.ts` with
  the three reads behind the callbacks. `contextChar`/`contextChat` are typed as the record the
  callbacks dereference without checks, as before: a missing record still throws inside the
  callback and the matcher still turns that into the literal text.
- **`shared/cbs/evaluator.ts`** `createCbsEvaluator(host: CbsHost)`: the loop, the block matchers,
  `dateTimeFormat`, `makeArray`/`parseArray`/`parseDict`, and `risuEscape`/`risuUnescape`, moved
  from `parser.svelte.ts`. Each evaluator owns its function map and registers on first use, as
  `initMatcher` did. `CbsHost` is `CBSRegisterArg` without what the evaluator supplies itself,
  plus `findCharacterById` (the group path's `findCharacterbyId`).
- **`shared/cbs/calc.ts`** `calcString(text, { getChatVar, getGlobalChatVar })`: the calculator,
  moved from `infunctions.ts`, which keeps `calcString(text)` bound to the selected chat's
  variables (unchanged for the matcher and the trigger effect).
- **`shared/scripts/regex.ts`**: `runRegexScripts(data, scripts, { mode, chatID, parse,
repeatBackSource, applyEffect })` returning `{ data, effects }`, `regexScriptCacheKey`, and
  `createScriptCache` (1,000 entries). The loop is `executeScript` and the `<...>` parsing as they
  were; `@@emo` and `@@inject` go to the run's `applyEffect` where their script matched (inside
  its `try`, so a later script's CBS reads the write) and are also returned as the ordered
  `effects`; `@@repeat_back`'s previous message
  comes from `repeatBackSource`, and its null dereference is kept (the script is skipped). The
  script copy before the flag rewrite is a shallow copy instead of `safeStructuredClone`: only
  `flag` is reassigned.
- **`shared/llm.ts`** gains `LLMParameter`, `LLMProvider`, and `LLMModel` (the registry's
  `getModelInfo` returns one). Deviation from the plan's `shared/llm/model.ts`: `shared/llm.ts`
  already holds `LLMFlags`, `LLMFormat`, and `LLMTokenizer`, and a `shared/llm/` folder beside it
  would split one subject. `model/types.ts` and `request/shared.ts` re-export them.
- **`src/ts/cbs.ts`** re-exports the registry. **`src/ts/parser/parser.svelte.ts`** builds the
  client evaluator lazily with the client host (the live database, `selectedCharID`,
  `CurrentTriggerIdStore`, `window`, `navigator`, `findCharacterbyId`, the `chatRef`-aware
  variable accessors) and keeps `risuChatParser(text, arg)`, `CbsConditions`, `risuEscape`, and
  `risuUnescape` as exports, so no caller changes.
- **`src/ts/process/scripts.ts`**: `processScriptFull` keeps its seven-argument signature and its
  `{ data, emoChanged }` result. Around the engine it keeps the Lua edit hook, the display
  trigger, the plugin handlers, the CBS pass, the script collection, the cache, the repeat-back
  lookup, and dynamic assets (`bestMatchCache`). Its `applyEffect` writes `@@emo` to
  `CharEmotion` and `emoChanged`, and `@@inject` to the message id resolved before the awaits,
  at the point the script matched, as before.

Strict-mode count. Reproducible now: `pnpm exec tsc -p server/tsconfig.json` (strict, `es2023`,
no DOM; it includes `shared/**`) reports 0 errors, and `pnpm check` is clean. Measured during the
move with the same command, but not reproducible (the pre-fix files were not kept): the registry
had 81 errors, the evaluator 60, and the calculator 32, each copied unchanged except for the
import paths and the three host reads; the regex engine was written against the strict compiler.

Globals the shared modules still use (both runtimes have them): `Buffer` (the client's polyfill),
`TextEncoder`/`TextDecoder`, `Math.random`, `console`, and `Date`/`Intl` with the runtime's own
timezone and default locale. On the server the date functions (`{{date}}`, `{{time}}`,
`dateTimeFormat`, `toLocaleDateString`) therefore follow the server's timezone and locale, not the
browser's; `script-transform` records that difference or passes the client's timezone before
judging parity. `getBrowserLanguage` covers only `metadata::browserlang`.

Evidence that the client path is unchanged, for the scenarios the baseline covers: the baseline capture
(`util/playwright/capturePhase5Baseline.mjs`) rerun against this tree gives the same
`prompts.json`, `markdown.json`, `token-counts.json`, `lore-regex.json`, `igp.json`, and
`scenario.json` as the fixtures of `50f581d4`. Plain Node imports every new `shared/` module, and
a node-only evaluator with a stub host parses `{{char}}`, `{{? 1+2*3}}`, `#if`, and the three new
host reads.

## Astra challenge (2026-10-01) and decisions

1. Blocking: the first version applied `@@inject` and `@@emo` after the whole loop, so a later
   script's CBS (`{{lastmessage}}`) read the old message. Adopted: `applyEffect` at the match,
   inside the script's `try`; Astra's probe now returns HEAD's result.
2. Non-blocking: "every host read is injected" overstated portability. Adopted as documentation:
   the globals the modules still use are named in their headers and above; injecting codecs, the
   clock, and randomness was rejected as interface growth with no current need.
3. Non-blocking: the strict re-count had no reproducible command. Adopted: the record above.

## Checks

`pnpm check`, `pnpm format:check`, `pnpm test` (107 files, 1,223 passed, 3 skipped), `pnpm build`,
and `pnpm test:e2e` (5 passed) pass; the baseline re-capture matches the fixtures.

## Tests

Written by the Fable reviewer (verdict: no problem):

- `server/src/tests/cbs.test.ts` with `server/src/tests/cbsHost.ts` (a Node host) and
  `server/src/tests/fixtures/cbs-parity.json` (37 cases), and
  `src/ts/parser/tests/cbs/hostParity.test.ts` running the same cases through the client
  wrapper: recursive `#func`/`call`, the call-stack limit, the second `time` registration, group
  speakers, `chatRef` against the selection, the calculator, Unicode codecs, the three host reads,
  and a fixed clock with an explicit timezone. The Node test also reproduces the baseline
  `markdown.json` texts of the `Mark` chat.
- `server/src/tests/regex.test.ts` and `src/ts/process/scripts.test.ts`: `@@inject` followed by
  `{{lastmessage}}` and a `<cbs>` pattern (with and without the effect sink), interleaved effects
  in order, a missing target, a write refused by a generation lock, a failing effect skipping only
  its script, the `@@repeat_back` null match, ordering, malformed patterns, and the cache key,
  eviction, reset, and hit.
- `server/src/tests/sharedImports.test.ts` now recurses into `shared/**`.

Fable judged all five items of Astra's testing advice and the `sharedImports` recursion necessary
and covered them. Legacy quirks found and pinned (identical in the old inline code): `{{data}}` in
`out` never expands; `@@inject` at `chatID` -1 and a matching `@@repeat_back` write the directive
text into the output; an action-only flag falls back to `g`; `lastmessage` returns unparsed text;
the cache ignores chat content unless a `<cbs>` pattern changes.
