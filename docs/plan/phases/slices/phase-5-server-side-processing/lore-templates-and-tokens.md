# Slice: Lore, Templates, And Tokens

Status: planned (drafted 2026-09-30, refined after review, not started).

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
