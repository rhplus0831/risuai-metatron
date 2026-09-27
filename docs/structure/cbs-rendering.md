# CBS Template Language and Message Rendering

## Scope

- Owns:
  - CBS (`{{fn::arg}}`, `{{#if}}`/`{{#when}}`/`{{#each}}`/`{{#func}}` blocks): the function registry and the evaluator,
  - chat, global, and temp variables,
  - markdown/HTML rendering and sanitization (DOMPurify) and CSS scoping,
  - asset and inlay expansion at render time,
  - ChatML parsing,
  - partial edit of rendered messages,
  - CBS editor highlighting and autocomplete.
- Paths:
  - `src/ts/cbs.ts`
  - `src/ts/parser/{parser.svelte,chatVar.svelte,chatML,partialEdit}.ts`
  - `src/ts/parser/tests/*`
  - `src/ts/gui/highlight.ts`
  - `src/ts/gui/codearea/cbsMonaco.ts` (stub)
  - `src/lib/Others/MonacoEditor.svelte`
  - `src/lib/ChatScreens/PartialEditController.svelte`
  - Static docs: `src/etc/airisu.cbs`, `src/etc/docs/*.cbs` (search-ignored)
- Not here:
  - Regex scripts that run inside rendering → `scripts-triggers.md`.
  - The chat component tree → `ui-theming.md`.
  - Translation of rendered HTML → `media-aux.md`.

## Files

- `cbs.ts`: the CBS function catalogue.
  - `registerCBS(arg: CBSRegisterArg)` enumerates every built-in function (name, callback, aliases, description, `internalOnly`/`doc_only`) into a callback supplied by the consumer.
  - Types: `CBSRegisterArg` (injected runtime helpers), `matcherArg` (per-call context), `RegisterCallback`.
  - `defaultCBSRegisterArg` is a placeholder adapter for docs and scaffolding.
- `parser/parser.svelte.ts`: the runtime evaluator and renderer.
  - `risuChatParser(text, matcherArg)`: the parse/eval loop. Call depth is capped at 20.
  - `matcher`/`initMatcher`: the parser-local `matcherMap`, filled from `registerCBS`.
  - `ParseMarkdown`, `renderMarkdown`/`renderHighlightableMarkdown` (markdown-it + KaTeX + highlight.js), `trimMarkdown` (DOMPurify plus scoped-style restore), `parseMarkdownSafe`.
  - Assets: `parseAdditionalAssets`, `assetRegex`, `resetAssetsCache`.
  - Also `postTranslationParse`, `applyMarkdownToNode`, `risuEscape`/`risuUnescape`, `addMetadataToElement`, `hasher`, `CbsConditions`.
- `parser/chatVar.svelte.ts`: variable accessors.
  - Chat variables: `getChatVar`/`setChatVar`, stored in `Chat.scriptstate` as `$name`.
  - Globals: `getGlobalChatVar`/`setGlobalChatVar` (`db.globalChatVariables`, or chat-local overrides when `useLocallySetGlobalVariables`), plus `getGLChatVar`/`setGLChatVar` and `isLocallyHandledGlobalChatVar`.
- `parser/chatML.ts` `parseChatML`: a lightweight `<|im_start|>` splitter that extracts `<Thoughts>` and CBS-parses each part. Used by `sendChat` `chatML` cards, the translator, and memory.
- `parser/partialEdit.ts`: maps rendered text back to markdown ranges.
  - `findAllOriginalRangesFromText`/`FromHtml` match in stages: exact, then anchor, then fuzzy, then bigram.
  - Also `replaceRange` and `EDITABLE_BLOCK_SELECTORS`.
- `gui/highlight.ts`: editor highlighting and autocomplete.
  - `highlighter` uses the CSS Custom Highlight API with `::highlight(cbsnest0..4)` etc. in `src/styles.css`.
  - `AllCBS` is the autocomplete list, maintained by hand.
  - Used by `src/lib/UI/GUI/TextAreaInput.svelte`.
- `gui/codearea/cbsMonaco.ts`: `registerCBSMonaco` is empty, so Monaco has no CBS language support.
- `PartialEditController.svelte`: hover and drag-select editing of rendered messages. Dispatches `save`, which `Chat.svelte:handlePartialEditSave` handles.

## Flows

Evaluation:

1. Callers pass the text to `risuChatParser`. Callers include `Chat.svelte`, `processScriptFull`, `sendChat`/`runCurrentChatFunction`, `tokenizeAccurate`, `command.ts`, triggers, the lorebook, and the playground.
2. `<user>`, `<char>`, and `<bot>` are normalized to CBS.
3. The scanner handles nested `{{...}}`, blocks, comments, `#each`, and `#func`/`call`.
4. Plain functions go to `matcher`:
   1. Split the arguments on `::`.
   2. Normalize the name: lowercase, and remove whitespace, `_`, and `-`.
   3. Invoke the callback.
   4. Unknown functions stay as literal text.
5. A callback may return `{text, var}`. `return` sets `__force_return__`.

Display:

1. `Chat.svelte:displaya` evaluates the message with `risuChatParser(..., {rmVar:true, visualize:true})`.
2. `ChatBody.svelte:markParsing` calls `ParseMarkdown`, which runs in order:
   1. `parseAdditionalAssets`.
   2. `processScriptFull(...,'editdisplay')`.
   3. Assets again, then inlays.
   4. Thoughts and tools.
   5. Style encoding.
   6. Markdown.
   7. `trimMarkdown`.
3. The template renders `{@html addMetadataToElement(trimMarkdown(md))}`.

## State

- Variable storage:

  | Kind                | Storage                                                                                                                       | Persisted |
  | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------- |
  | Chat vars           | `Chat.scriptstate['$'+name]`, falling back to character `defaultVariables`, then `db.templateDefaultVariables`, then `'null'` | yes       |
  | Globals             | `db.globalChatVariables`; toggles use `toggle_<name>`                                                                         | yes       |
  | Temp vars           | per `risuChatParser` call                                                                                                     | no        |
  | `#func` definitions | per call                                                                                                                      | no        |

- Caches: `matcherMap`, the asset caches (reset by `resetAssetsCache` and by an `$effect.root` on character/module changes), and global `CSS.highlights`.

## Coupling

- `parser.svelte.ts` imports `processScriptFull` from `process/scripts.ts`, and `scripts.ts` imports `risuChatParser`. This is a deliberate import cycle, so keep the imports lazy-safe.
- `chatVar.svelte.ts` is used by scripts, triggers, the lorebook, `infunctions.ts`, `mcp/graphmem.ts`, and `Toggles.svelte`.
- `cbs.ts` consumers: `parser.svelte.ts`, `PlaygroundDocs.svelte` (live docs from `description`), and `cbsMonaco.ts`.

## Invariants

- `ParseMarkdown` output must go through `trimMarkdown` before `{@html}`. `mode:'notrim'` is an intermediate result, not a final one.
- Keep the DOMPurify hooks intact: class prefixing, the href policy, the YouTube iframe allowlist, and blob `src` retention.
- CSS must stay scoped:
  - Selectors are prefixed with `.chattext`.
  - Classes get the `x-risu-` prefix.
  - `<risu-style>` uses a hex round-trip so decoded CSS cannot re-enter the HTML parser.
- Mutating functions must respect `rmVar`/`runVar`. Display evaluation uses `rmVar:true`. `setvar` is a no-op unless `runVar` is set.
- Keep aliases and name normalization compatible. Shared cards use historical spellings.
- `partialEdit` offsets refer to the original markdown, not the rendered HTML. It special-cases `{{ruby::...}}`.

## Recipes

- Add a CBS function:
  1. Add an entry in `cbs.ts:registerCBS`: name, callback, aliases, precise `description`. Use only injected helpers.
  2. Add it to the matching list in `gui/highlight.ts` (`normalCBS`, `normalCBSwithParams`, `displayRelatedCBS`, or `nestedCBS`).
  3. Add a test under `src/ts/parser/tests/cbs/` using the `cbs` helper from `lib.ts`.
  4. Confirm it appears in Playground → CBS docs.
- Change message display: `Chat.svelte:displaya` or `ChatBody.svelte:markParsing` for call order, and `ParseMarkdown`, `parseAdditionalAssets`, `renderMarkdown`, or `trimMarkdown` for rendering and security. Run `trimMarkdownStyle.test.ts`.
- Change variable semantics: `chatVar.svelte.ts` plus the `getvar`/`setvar`/`tempvar`/`getglobalvar` callbacks.

## Tests

- `src/ts/parser/tests/cbs/{conditionals,escapes,loop,strings}.test.ts`.
- `chatVar.svelte.test.ts`.
- `chatML.test.ts`: has skipped and FIXME cases.
- `trimMarkdownStyle.test.ts`: covers sanitizer and XSS regressions.
- Not tested: most of `cbs.ts`, asset/inlay rendering, `partialEdit`, `highlight.ts`.

## Known Hazards

- `escapes.test.ts` documents a known broken `cbr` repetition case.
- `removeHighlight` deletes the stored ID but leaves the global `CSS.highlights` ranges in place.
- `chatML.ts` references `OpenAIChat` without importing it and relies on an ambient declaration.
