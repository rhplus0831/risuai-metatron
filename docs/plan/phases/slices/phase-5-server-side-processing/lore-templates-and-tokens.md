# Slice: Lore, Templates, And Tokens

Status: implemented (2026-10-01).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 1 (lorebook activation, Jinja
templates, template validation, token counting); PLAN.md Decision 5 (plugin tokenizers replaced
by the built-in tokenizer on the server).

Depends on: `tokenizer-node-spike`, `cbs-and-regex-services`. No Phase 3 or 4 dependency.

## Scope

Allowed files: `shared/lore/activation.ts` (moved from `src/ts/process/lorebook.svelte.ts`
`loadLoreBookV3Prompt`, which becomes a wrapper), `shared/prompt/chatTemplate.ts` (moved from
`src/ts/process/templates/chatTemplate.ts`), `shared/prompt/templateCheck.ts` (moved verbatim),
`server/src/prompt/tokens.ts` (new: the server counter), `src/ts/process/lorebook.svelte.ts`,
`src/ts/process/templates/{chatTemplate,templateCheck}.ts` (re-exports and wrappers),
`src/ts/tokenizer.ts` only if a shared helper is extracted (the `LLMTokenizer` fallback table and
the `ChatTokenizer` arithmetic). Tests belong to the review step.

Identifiers (verified 2026-09-30): `loadLoreBookV3Prompt(chatRef?)` (`lorebook.svelte.ts:89-701`;
reads `DBState.db.characters` (92-93), `loreBookDepth` (100), `loreBookToken` (101), `username`
(145), `get(selectedCharID)` (93), `getModuleLorebooks(ref)` (97), `risuChatParser` and `tokenize`
(607), writes lore flags with `setChatVarOf` (615-625), decorators through `CCardLib.decorator.parse`);
`applyChatTemplate(messages, { type?, custom? })` (`chatTemplate.ts:23-98`; `getDatabase()` and
`getCurrentCharacter()` at 30-31, `db.instructChatTemplate`/`db.JinjaTemplate` at 32 and 38,
`getUserName()` at 95, the global `safeStructuredClone` at 36; `@huggingface/jinja` at 1, 38,
90), `chatTemplates` and `templateEffect` (6-21, pure data); `templateCheck(db)`
(`templateCheck.ts:3-77`, pure). Token counting: `encode` (`tokenizer.ts:89-247`, LRU of 1,500),
the `LLMTokenizer` fallback table (210-240; `Llama3` and `Local` fall to `cl100k_base`; the
custom-tokenizer branch maps `llama3` to the `llama` web tokenizer at 130-131 and 172-173),
`encodeWithTokenizer` (53-87), `tokenizeAccurate(data, consistantChar?)` (451-458),
`ChatTokenizer` (460-534), the plugin entry `pluginHooks.providerOptions.get(db.currentPluginProvider)?.tokenizerFunc`
(199-203), and `tokenizeGoogleCloud` (271-311, a remote count with `google.accessToken`).

Strict-mode cost: about 19 errors in `lorebook.svelte.ts` (review count) to fix as part of the
move.

Stopping condition: a lore or template behavior that depends on the selected character where the
job context has none and cannot be expressed through the host; recorded, and the client wrapper
keeps the old behavior.

## Assumptions

- The tokenizer spike settled the loading shim, the `o200k_base` source, and the payload path;
  any family the owner decided to approximate is counted with `cl100k_base` here and recorded.
- `@huggingface/jinja` and `@risuai/ccardlib` import under plain Node (checked 2026-09-30).
- Phase 3 keeps `loreBookDepth`, `loreBookToken`, `instructChatTemplate`, `JinjaTemplate`,
  `customTokenizer`, `googleClaudeTokenizing`, `aiModel`, `currentPluginProvider` readable through
  the read model (they move sections but keep names, D3).

## Proposed decisions

- Lore activation takes a `LoreHost` (`characters`, `chat`, `settings` read model,
  `getModuleLorebooks`, `evaluateCBS`, `tokenize`, `setChatVar` for the keep and
  don't-activate-after-match flags) and returns `{ actives, matchLog }`; the client wrapper builds
  the host from `DBState.db` and the chat module, the server from the job's frozen scope.
- `applyChatTemplate(messages, { type, custom, instructTemplate, jinjaTemplate, characterName, userName })`
  takes its inputs as parameters; the client wrapper supplies them.
- The server counter reproduces `encode`'s selection and LRU with the model resolved from the
  frozen scope. Plugin providers: the job's hook list (`job-channel`) carries the client's
  provider descriptors, including each provider's declared `LLMTokenizer` from `addProvider`'s
  options (`v3.svelte.ts:1011`), so the server counts a `pluginmodel:::` model with that family
  (`Unknown` falls to `cl100k_base`) and never calls `tokenizerFunc`. This is the Safety Contract
  item "Plugin tokenizers are not used for server-side token counting", introduced here.
- `tokenizeGoogleCloud` on the server: the counter calls the Google `countTokens` endpoint with
  the server-side token when `googleClaudeTokenizing` is set, as the client does today; the client
  copy of that path is removed at cutover because its token becomes write-only.
- `tokenizeAccurate` on the server is `evaluateCBS(..., { tokenizeAccurate: true, consistantChar })`
  plus the counter.

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`; the review step adds
`server/src/tests/lore.test.ts` (activation order, `scanDepth`, regex keys, secondary keys,
decorators, recursion flags, the token budget) and `tokens.test.ts` (per-family counts against
the spike's captured browser counts, `ChatTokenizer` arithmetic, the multimodal tile formula, a
plugin provider counted by its declared family), and extends the CBS golden fixtures with lore
entries. Manual: the DevTool prompt preview on a fixture character lists the same lore entries
before and after.

## Residual risk

`loadLoreBookV3Prompt` writes chat variables during activation; on the server those writes go to
the job's variable engine and persist with the reply, as the client persists them today. The
`disable_ui_prompt` decorator's `disabledUIPrompts` array stays unconsumed (known hazard).

## Implementation record

Implemented 2026-10-01 on `fb434571`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 4). No stopping condition triggered:
activation reads the selected character only to pick the chat, which the client wrapper still
does and the server host replaces with the job's chat.

- **`shared/lore/activation.ts`** `activateLore(input, host)`: `loadLoreBookV3Prompt`'s body,
  moved. `LoreActivationInput` carries the character, the chat (read-only), the resolved module
  lore, `loreBookDepth`, `loreBookToken`, and the user's name; `LoreHost` carries the clone, the
  speaker-name lookup, the chat variables (the keep and don't-activate-after-match flags), CBS for
  the token count, `tokenize`, and `testRegex`, which may be asynchronous (the server runs it
  through the script worker's single-regex tasks). The search stays synchronous while
  `testRegex` answers synchronously (a generator suspends only on a promise), so the client path
  yields exactly where it did, at `tokenize`. `character` is the projection activation reads
  (`name`, `globalLore`, `loreSettings`). Only activation moved: `importLoreBook`, the
  editors, and export stay in `lorebook.svelte.ts`. `@risuai/ccardlib` (the decorator parser)
  is imported directly; it runs under plain Node.
- **The lore regex fix** (owner answer 10, both paths): a key `/pattern/flags` splits at its last
  `/`, empty flags are allowed, and no key is rewritten in place. Before, the first key was
  overwritten with the pattern and its leading `/`, a key with empty flags never matched, and a
  second scanned message threw and ended the search.
- **`src/ts/process/lorebook.svelte.ts`** `loadLoreBookV3Prompt(chatRef?)` keeps its signature and
  result; it resolves the character and chat as before and passes `getModuleLorebooks(ref)` (the
  full module resolution: global, chat, character, the bound persona's module,
  `moduleIntergration`), the two settings, `getUserName(ref)`, and the client host
  (`safeStructuredClone`, `findCharacterbyId`, `getChatVarOf`/`setChatVarOf`, `pickHashRand`,
  `risuChatParser`, `tokenize`, `new RegExp(...).test`).
- **`shared/prompt/chatTemplate.ts`** `renderChatTemplate(messages, { type, jinjaTemplate,
characterName, userName })`, `chatTemplates`, and `templateEffect`. The names are getters, read
  at render as before. Only `role` and `content` of each message are copied (they are all the
  function reads, and the effects rewrite them) instead of `safeStructuredClone` of the whole
  list. `templates/chatTemplate.ts` keeps `applyChatTemplate(messages, { type?, custom? })` with
  the client's settings and names, and re-exports the rest.
- **`shared/prompt/templateCheck.ts`** `templateCheck({ promptTemplate })`, verbatim apart from
  the type; `templates/templateCheck.ts` re-exports it.
- **`shared/tokenizerChoice.ts`** `selectTokenizer(settings)`: the routing of `encode`, extracted
  as a pure function over the server's family names (`TokenizerFamily`). The client's `encode`
  maps a family to its loaders (`encodeFamily`); `server/src/prompt/tokenizers/index.ts`'s loader
  map now `satisfies Record<TokenizerFamily, Loader>`, so the two lists cannot drift.
- **`shared/prompt/chatTokens.ts`** `ChatTokenCounter`: `ChatTokenizer`'s arithmetic over an
  injected `encode`, `supportsInlayImage`, and `gptVisionQuality`; the client's `ChatTokenizer`
  extends it with the client's, keeping its constructor.
- **`server/src/prompt/tokens.ts`** `createTokenCounter({ tokenizers, fetchImpl? })`: `encode` and
  `count` for a job's `TokenCountScope` (per section: the preset's `aiModel` and
  `currentPluginProvider`, the model's catalogue family and `internalID`, the legacy plugin
  tokenizer, `providers.customTokenizer`/`googleClaudeTokenizing`/`useTokenizerCaching`, and
  `llmSecrets.google.accessToken`), with an LRU of 1,500 keyed by the client's fields plus the
  model's `internalID` (two scopes may resolve one `aiModel` to different models). The model's
  family comes from the caller: the catalogue is still the client's until
  `request-layer-and-llm-secrets`. Nothing creates the counter yet; prompt assembly (slice 9)
  wires it and the server lore host.

Recorded behavior changes:

- the lore regex fix above (`/dragon/i` and `/dragon/` now activate on "dragon");
- the scanned user name is the effective persona's (`getUserName(ref)`: a bound persona wins, and
  a missing `username` reads `User`), not `DBState.db.username`;
- on the server, a regex key's test is awaited (the worker), so activation yields there; the
  client's synchronous test does not yield;
- on the server, a legacy plugin `custom` tokenizer is never called (`cl100k_base` counts; the
  Safety Contract item "Plugin tokenizers are not used for server-side token counting"), and
  Google's count cache is an LRU of 1,500 instead of unbounded.

Evidence: the baseline re-capture (`util/playwright/capturePhase5Baseline.mjs`) against this tree
matches the fixtures of `50f581d4` in `scenario.json`, `markdown.json`, and `igp.json`. It
differs only by the regex fix: in `lore-regex.json` the regex scenarios activate their entries
(new `actives` and `matchLog` rows, nothing removed); in `prompts.json` the `lore` fixture gains
its two regex entries ("Regex entry with empty flags.", "Regex entry with the i flag."); and in
`token-counts.json` the `lore` prompt's per-family totals grow by those two messages (302 to 315
for `cl100k_base`). The expected-delta files for these belong to the Fable review.

Strict mode: `pnpm exec tsc -p server/tsconfig.json` reports 0 errors (reproducible). Measured
during the move with the same command, not reproducible (the pre-fix files were not kept): the
moved activation had 6 errors at its first strict compile (the `inject` null type, an optional
`useRegex`, `lore.inject` after the filter, and the read-only chat), the templates 1; the token
modules were written against the strict compiler.

The regex key grammar after the fix (Astra's probe over "abc a/b aa"): `/`, `/abc` (no closing
slash), and `/abc/z` (invalid flags) match nothing; `//` (an empty pattern), `/abc/`, and `/a/b/`
(a slash inside the pattern) match. Keys still split on every comma first, so `/a{1,2}/` never
matches, and a malformed key ends its query (`/abc/z,/abc/` matches nothing); both are inherited
and carried to Stop B for the owner. A non-`/` key in a regex entry ends the search, as before.

For slice 9: the server host's `testRegex` answers the worker's `{ value }` or throws its
`{ error }`; any throw is "no match", so slice 9 decides how a worker timeout is reported. The
counter's lifetime (per job or per server) and a signal for the Google count are slice 9's too.

Tests the change invalidated on purpose: `src/ts/process/lorebookRegexBaseline.test.ts` "the
client reproduces every captured scenario over the real store" pinned the pre-fix behavior. The
Fable test-adapter flipped it to `deltas[name] ?? captured[name]` with
`server/src/tests/fixtures/baseline/deltas/lore-regex-fix.json` (the three changed scenarios,
each with its reason), and the captured "before" fixture is unchanged.

## Astra challenge (2026-10-01) and decisions

1. Blocking: the first version made `searchMatch` async and awaited it for every query, so an
   ordinary key (even a miss) yielded and a later entry could read a message changed meanwhile
   (Astra's microtask probe: HEAD `[]`, the change `["dragon"]`). Adopted: the search is a
   generator driven by `runSteps`, which suspends only on a promise; the caller awaits only a
   promise. The client path yields where HEAD did, at the first active's `tokenize`.
2. Non-blocking: the server counter's cache key left out `model.internalID`, so two scopes that
   resolve one custom `aiModel` to different Google models shared a count. Adopted: the key is a
   JSON tuple of the client's fields plus `internalID`. The client's key is unchanged (its
   `aiModel` resolves to one model at a time); the counter's lifetime is slice 9's.
3. Non-blocking: the fixed grammar still splits keys on every comma and ends a query at a
   malformed key. Adopted as documentation (the grammar table above) and carried to Stop B; the
   approved fix was not broadened.
4. Non-blocking: documentation and strict-count evidence. Adopted: the scheduling record, the
   named re-exports in `chat-pipeline.md`, the qualified import rule in `persistence.md`, and the
   strict counts labeled as not reproducible.
5. Interface (from the integration notes): `LoreActivationInput.character` required a whole client
   `character | groupChat`. Adopted: a read-only projection of `name`, `globalLore`, and
   `loreSettings`. The transform-isolation, worker-result, and timeout notes are slice 9's and
   slice 13's.

## Checks

`pnpm check`, `pnpm format:check`, `pnpm test` (110 files, 1,361 passed, 3 skipped), `pnpm build`,
and `pnpm test:e2e` pass. The baseline re-capture differs from the fixtures only by the regex fix,
as recorded above.

## Tests

Written by the Fable reviewer (verdict: no problem):

- `server/src/tests/lore.test.ts` (60): activation order and result shape, scan depth, the regex
  grammar table with escaped slashes, duplicate flags, and trimming, a second-message match, no
  rewrite of the input, secondary, additional, full-word, and exclude keys, every decorator,
  keep/don't flags through the host, budgets and priorities, recursion, child entries,
  `@@inject_lore`/`@@inject_at`, a deep-frozen input, the scheduling (a synchronous host never
  yields, an async regex yields, a rejection is no match), the real script worker pool as
  `testRegex` with a ReDoS timeout, and every `lore-regex.json` scenario from a Node host.
- `server/src/tests/chatTemplate.test.ts` (19): every built-in template, the gemma/mistral effects
  and errors, custom Jinja with render-time names, input non-mutation, and `templateCheck`.
- `server/src/tests/tokens.test.ts` (+43): `selectTokenizer` over every branch and family; the
  counter's routing, caching, every key field, LRU eviction, concurrent scopes, Google
  success/non-200/network error/disabled, the two-scope `internalID` case, all 25 captured
  `routing` configs of `token-counts.json` (the legacy `custom` plugin answering `cl100k_base`),
  and `ChatTokenCounter`'s arithmetic.
- `src/ts/process/lorebook.svelte.test.ts` (8, the real store): the plain-key microtask
  reproduction through the wrapper, the yield after the first active's CBS and variable reads,
  regex keys, the scanned persona name, module resolution, a bound persona's embedded module, the
  keep flag through the chat module, and a group speaker.
- `src/ts/tokenizer.test.ts` (+2): an absent plugin provider and a `custom` provider without
  `tokenizerFunc`; `ChatTokenizer` over the client's `encode`.
- `server/src/tests/fixtures/baseline/deltas/lore-regex-fix-{prompts,token-counts}.json`: the
  `lore` prompt's two regex entries and their per-family token counts, each with its reason.

Fable judged all seven items of Astra's testing advice necessary and covered them, except
transform variable isolation (slice 13's). Extending the CBS golden fixtures with lore entries
moves to slice 9's prompt golden, where lore first enters a rendered prompt. Inherited behaviors
pinned, unchanged from HEAD: the keep and don't-activate "seen" flags are function-wide (after one
keep entry, every later active also writes `__internal_ka_`); the image tile formula clamps one
side before scaling the other (a 1000x2000 image counts 8 tiles); a bound persona's embedded
module resolves only if a module with its id is in `db.modules`; `//` matches anything, and a bare
`/` key ends its query.
