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
  - `shared/cbs/{registry,evaluator,types,calc}.ts` (the runtime both the client and the server run)
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

- `shared/cbs/registry.ts`: the CBS function catalogue (re-exported by `cbs.ts`).
  - `registerCBS(arg: CBSRegisterArg)` enumerates every built-in function (name, callback, aliases, description, `internalOnly`/`doc_only`) into a callback supplied by the consumer. Every host read goes through `CBSRegisterArg`, including `getTriggerId` (`trigger_id`), `getViewport` (`screenwidth`/`screenheight`), and `getBrowserLanguage` (`metadata::browserlang`).
  - `contextChar`/`contextChat`: the parse's `chatRef` character and chat, or the selected ones.
  - `prefillsupported` (`prefill_supported`, `prefill`): for a model whose descriptor (`CBSRegisterArg.getModelInfo`, which both hosts resolve through `shared/llm/models.ts` `resolveModelInfo` with the custom flags) is Anthropic or Anthropic legacy format, its `hasPrefill` flag (so an adaptive-only Claude model answers `0`); for any other format, whether `aiModel` starts with `claude`.
  - `defaultCBSRegisterArg` is a placeholder adapter for docs and scaffolding.
- `shared/cbs/types.ts`: `CBSRegisterArg` (injected runtime helpers), `matcherArg` (per-call context), `RegisterCallback`, `CbsConditions`.
- `shared/cbs/evaluator.ts` `createCbsEvaluator(host: CbsHost)`: the parse/eval loop (`risuChatParser(text, arg)`; the depth of nested parses is capped at 20, derived per child from `arg.callStack` without writing the caller's object, so sibling `call::` and `history` parses do not count), the block matchers, and its own function map, filled from `registerCBS` on first use. `CbsHost` is `CBSRegisterArg` without the parts the evaluator supplies itself (`registerFunction`, `risuChatParser`, `makeArray`, `parseArray`, `parseDict`, `dateTimeFormat`), plus `findCharacterById` (a group's last speaker). Also `risuEscape`/`risuUnescape`.
- `shared/cbs/limits.ts`: cooperative evaluation limits for a host that sets `CbsHost.limits` (the server's `serverCbsLimits`, and the client's `CLIENT_CBS_LIMITS` in `parser.svelte.ts`: the shared `DEFAULT_CBS_MAX_WORK` of 10,000,000 units and 2 s per top-level parse, so a text the tab shows the server transform also accepts; an evaluator without limits never counts or reads the clock). `CbsLimits` (`maxWork`, `maxMs`, an optional shared `total` allowance, `now`), `CbsLimitError` (`reason`: `work`, `time`, `total`), the budget of one top-level parse shared by its nested parses (`enterCbsParse`/`leaveCbsParse`, `spendCbsWork`, `checkCbsClock`), and `replaceAllBound` (the length of a `replaceAll` result, counted before it is built). The evaluator charges a unit per scanned character and per character a function returns, the stack moves of `{{` and of the unfinished-syntax drain, each `#each` piece and `call::` substitution before it is built, and the `#each` splice; the registry charges its counted loops through `CBSRegisterArg.spend` (a no-op without limits). The matcher's swallow-all `catch` lets `CbsLimitError` through.
- `shared/cbs/calc.ts` `calcString(text, { getChatVar, getGlobalChatVar })`: the `{{? ...}}` and trigger calculator (`$name` a chat variable, `@name` a global). `process/infunctions.ts` binds it to the selected chat's variables.
- `parser/parser.svelte.ts`: the client host of the evaluator, and the renderer.
  - `risuChatParser(text, arg)`: the shared evaluator with the client host (the live database, the selected character, `CurrentTriggerIdStore`, `window`, `navigator`, `findCharacterbyId`, `CLIENT_CBS_LIMITS`). A parse that reaches the budget throws `CbsLimitError` to its caller (the server's `cbs` callback fails its request on purpose, `transport.ts`); `risuChatParserForDisplay` catches only that error and answers `language.cbsLimitReached` with the reason, for the places that show the result: the chat row's pre-pass (`Chat.svelte` `displayPrePass`, also the copy of a streaming row), `BackgroundDom.svelte`, and the `PopupEditor.svelte` preview.
  - `ParseMarkdown`, `renderMarkdown`/`renderHighlightableMarkdown` (markdown-it + KaTeX + highlight.js), `trimMarkdown` (DOMPurify plus scoped-style restore), `trimMarkdownSharingStyles` (the same, with the styles taken out for the chat screen), `parseMarkdownSafe`.
  - Assets: `parseAdditionalAssets`, `assetRegex`, `resetAssetsCache`, `syncAssetsCache`; `getClosestMatch`/`fuzzyIndexOf` use a per-character-list fuzzy index and bounded result memo.
  - Inlays: `parseInlayAssets` (inside `ParseMarkdown`) expands `{{inlay::id}}`, `{{inlayed::id}}`, and `{{inlayeddata::id}}` from `getInlayMedia` (the asset key only, no bytes). Images use `getFileSrc` in both of its modes ([global API](global-api.md)). Audio and video have two modes:
    - Direct mode (`globalApi.svelte.ts` `getDirectAssetSrc` answers a URL: worker use enabled, the `directAssets` capability, and a controlling worker at the call): `/api/asset/<hex(utf-8 key)>`, the same URL `getFileSrc` gives. No bytes are read and no object URL is made; a missing file shows as the element's 404.
    - Fallback (`getDirectAssetSrc` answers `null`): the typed object URL from `files/inlays.ts` `getInlayObjectUrl`, kept for the page; a missing file or one without bytes leaves the tag in place.
    - Either way the `<source>` `type` is `shared/assetMime.ts` `assetMimeType` of the asset key's extension, so it matches the asset route's `Content-Type`. An extension the table does not know (`application/octet-stream`, for example `flac` or `mkv`) gets no `type` attribute, so the browser sniffs the bytes instead of skipping the source.
    - Both URLs are stable strings that are never revoked, so cached renders and translations keep working ones. A page that loses its controller renders new inlays through the fallback; HTML rendered before keeps its direct URLs.
  - Also `postTranslationParse`, `applyMarkdownToNode`, `addMetadataToElement`, `hasher`, and the re-exported `risuEscape`/`risuUnescape` and `CbsConditions`.
- `parser/chatStyles.ts`: `ChatStyleRegistry` (the chat screen's shared row stylesheets: `acquire(style, messageIndex, slot)` takes a `ChatStyle` with CSS and sanitized attributes and returns a release, `attach(host)` for `{@attach}`, `destroy`) and `setChatStyleRegistry`/`getChatStyleRegistry` (context). `src/lib/ChatScreens/ChatRowStyles.svelte` holds a row's uses (by value, so an equal re-render keeps them). See Display.
- `parser/assetSearch.ts`: `boundedDistance` (shared reusable two-row UTF-16 Levenshtein scratch space, length/band/row-minimum pruning) and `findAssetPrefix` (`ChatBody.svelte`'s strict first-best prefix scan).
- `parser/transformClient.ts`: the client of the server script transform (`POST /api/transform`, `self-host-server.md`); the only script stage of a render (there is no browser Lua or trigger runtime, and no browser regex stage of a render; the translator's `edittrans` regex is the one regex the tab still runs, `media-aux.md`). `captureTransform(chatID, { chatRef?, pluginContext? })` reads the call's context before its first await (the chat, the message id at `chatID`, the chat's display ids (`chatDisplayIds`, [chat bindings](persistence.md): per field the bound record when it exists, else the tab's; the persona sent as both the effective and the selected one), the plugin call context, the message's lock, its Re-render generation; the first transform sent at a Re-render's generation takes its cache bypass, for every later stage too); `ChatBody.svelte` `markParsing` captures once and passes it to `ParseMarkdown`, `translateHTML`, and its retries (their last argument: a capture, `null` for none, or none to capture there); it answers null without a chat, for a chat the server has not stored yet (no held revision), or without a preset or persona, and the caller then skips the script stage (the text as the CBS pre-pass and the assets leave it). `Chat.svelte` renders a row again once its chat's first save lands (`chatStore.svelte.ts` `chatSaveVersion`), so a new chat's rows get their transform. `serverProcessScript(char, data, mode, chatID, cbsConditions, captured, kind)` runs `editdisplay` and `editprocess` on the server (`{ data, emoChanged }`). `rerenderMessage(chatRef, messageId)` makes the message's next render skip the server cache and an older answer apply no effects. `resetTransformEffects` (on the `ReloadGUIPointer` bump) forgets which results' emotions were applied.
- `parser/chatVar.svelte.ts`: variable accessors.
  - Chat variables: `getChatVar`/`setChatVar`, stored in `Chat.scriptstate` as `$name`. A write merges that one entry (`mergeChatMeta`, a `meta` op's `merge`; `persistence.md`), so the other variables keep what another tab or a job set meanwhile (the same variable is last writer wins). A parse given `chatRef` (`risuChatParser(text, { chatRef })`, set by the send pipeline, triggers, and Lua) reads and writes that chat's variables and messages (`getChatVarOf`/`setChatVarOf`, `contextChar`/`contextChat` in `shared/cbs/registry.ts`); without it, the selected character's selected chat.
  - Globals: `getGlobalChatVar`/`getGlobalChatVarOf` use `shared/prompt/toggles.ts:resolveGlobalChatVar`: chat override, legacy global, then a defined toggle's kind default (`"0"` for checkbox/select, `""` for text/textarea), else `"null"`. Empty text/textarea values count as set. Definitions come from the ref/scope's preset, enabled modules, and chat owner, first key wins; parsing is cached by source text. `globalToggleDefinitions` also supplies `toggles/chatToggles.svelte.ts:chatToggleDefinitions` for the sidebar and preset operations. The sidebar and `toggles/togglePresets.svelte.ts` call `resolveGlobalChatVar` with one computed definitions text; `shared/togglePresets.ts` captures resolved values and compares/projects saved keys and kinds. `setChatToggle(ref, key, value)` writes only that loaded chat's `GLGlobalVariables` through `mergeChatMeta`, skipping unchanged stored values; the legacy `db.globalChatVariables` collection is read-only. Opening a chat never seeds values.
- `parser/chatML.ts` `parseChatML`: a lightweight `<|im_start|>` splitter that extracts `<Thoughts>` and CBS-parses each part. Used by `sendChat` `chatML` cards, the translator, and memory.
- `parser/partialEdit.ts`: maps rendered text back to markdown ranges.
  - `findAllOriginalRangesFromText`/`FromHtml` match in stages: exact, then anchor, then fuzzy, then bigram. The answer is sorted by confidence then position and deduplicated by identical source range only, so two identical occurrences on one source line both come back and the controller shows its chooser.
  - The normalization maps every character of the normalized text to a source offset; a typographic ellipsis becomes three dots that all map to the ellipsis, so a selection ending in one stops at it.
  - Also `replaceRange` and `EDITABLE_BLOCK_SELECTORS`.
- `gui/highlight.ts`: editor highlighting and autocomplete.
  - `highlighter` uses the CSS Custom Highlight API with `::highlight(cbsnest0..4)` etc. in `src/styles.css`.
  - `AllCBS` is the autocomplete list, maintained by hand.
  - Used by `src/lib/UI/GUI/TextAreaInput.svelte`.
- `gui/codearea/cbsMonaco.ts`: `registerCBSMonaco` is empty, so Monaco has no CBS language support.
- `PartialEditController.svelte`: hover and drag-select editing of rendered messages. Dispatches `save`, which `Chat.svelte:handlePartialEditSave` handles; a translation edit goes through the awaitable `saveTranslation` prop instead when the parent passes one (`media-aux.md`, the stored path), and the draft stays when that write is refused.

## Flows

Evaluation:

1. Callers pass the text to `risuChatParser`. Callers include `Chat.svelte`, `tokenizeAccurate`, `command.ts`, the HypaV3 modal, the plugin API, the lorebook, and the playground (the server evaluates its own CBS with `shared/cbs/`).
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
   2. `serverProcessScript(...,'editdisplay')` (skipped without a context, above): the context is captured before the first asset pass, the context is the render's (`markParsing`'s capture), the call joins the frame's batch (or a 16 ms timer's) for its chat, mode, and plugin handler set, and the server runs Lua `editDisplay`, the `display` trigger, CBS, and the regex scripts (the tab's `editdisplay` plugin handlers run between the two calls); the target is `background` for `mode:'back'`, else `message`. A message locked by a generation (it streams) skips this step and renders again when the lock ends. A failed request or target leaves the text as it came in (one toast per batch, on its first failure). The CBS of step 1 and every other step stay in the browser.
   3. Assets again, then inlays.
   4. Thoughts and tools.
   5. Style encoding.
   6. Markdown.
   7. `trimMarkdown`.
3. The template renders `{@html addMetadataToElement(pruneEmptyBilingualPairs(trimMarkdown(md)))}`. Under the chat screen (`DefaultChatScreen` provides a `ChatStyleRegistry`, `src/ts/parser/chatStyles.ts`), a body that holds a `<style>` or `<risu-style>` goes through `trimMarkdownSharingStyles` instead: the same sanitized tree, styles restored only when the input includes the case-sensitive `<risu-style` prefix (as in `trimMarkdown`), and bilingual pairs pruned on it before extracting styles.
   - Shared styles: each nonempty `<style>` whose CSS does not match `/@layer\b|\blayer\(|@scope\b/i` gets the inert comment `/**/` in place of its CSS. The element and its attributes stay, so structural selectors, including `:empty`, match as before. `ChatRowStyles` holds its CSS and sanitized attribute list in the registry, keyed by value. The registry keeps one `<style>` per distinct CSS and attribute list in a hidden container at the end of `.default-chat-screen`, after the rows, greeting, `BackgroundDom`, suggestions, and plugin panels. It copies attributes with `setAttribute` and CSS with `textContent`, so CSS never re-enters the HTML parser; a sheet is removed when no mounted row uses it.
   - Ordering among shared sheets follows the rows' last copies: rows sit in the DOM newest message first, then the greeting, so each use has the position (-message index, slot), a sheet stands at the maximum of its users' positions, and the oldest message's style (the greeting's last) wins a tie. A sheet moves (and is parsed again) only when that order between distinct sheets changes. Releases and moves wait for the next microtask; a release and re-acquire in one synchronous flush are coalesced, so the sheet is retained.
   - Retained styles: custom-GUI sheets in `Chat.svelte` and sheets containing `@layer`, `layer(`, or `@scope` stay at their row positions; empty sheets stay untouched too. This preserves the first declaration order of layers and the parent of implicit scopes. Their order against a newer row's shared sheet can reverse; this matters for conflicts the layer/scope-proximity steps do not already decide. Layers declared inside imported files are not detected and remain a limit.
   - `Chats` mounts its rows with its contexts (`getAllContexts`). Without a registry (`BookmarkList`, an `App` sibling, and component tests) a row keeps its own `<style>`s.

## State

- Variable storage:

  | Kind                | Storage                                                                                                                                                                  | Persisted |
  | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
  | Chat vars           | `Chat.scriptstate['$'+name]`, falling back to character `defaultVariables`, then `db.templateDefaultVariables`, then `'null'`                                            | yes       |
  | Globals             | `Chat.GLGlobalVariables` (written per chat) → `db.globalChatVariables` (read-only legacy fallback) → defined `toggle_<name>` kind default (`"0"` or `""`), else `"null"` | yes       |
  | Temp vars           | per `risuChatParser` call                                                                                                                                                | no        |
  | `#func` definitions | per call                                                                                                                                                                 | no        |

- Caches: the parser's file-source, blob-URL, and encoded-metadata maps, the scoped evaluators (`scopedEvaluators`), the asset maps (reset by `resetAssetsCache` and by `syncAssetsCache` in an `$effect.root` and at the start of an asset parse), and global `CSS.highlights`.

## Coupling

- `stores.svelte.ts` imports `resetTransformEffects` from `transformClient.ts`, which imports the stores back. Keep the module-level reads lazy (the subscriber runs at once).
- `chatVar.svelte.ts` is used by scripts, triggers, the lorebook, `infunctions.ts`, `mcp/graphmem.ts`, and `Toggles.svelte`.
- `registerCBS` consumers: the evaluator (`shared/cbs/evaluator.ts`), and through `cbs.ts` `PlaygroundDocs.svelte` (live docs from `description`) and `cbsMonaco.ts`.
- `stores.svelte.ts` and `parser/transformClient.ts` import each other; the `ReloadGUIPointer` subscriber in `stores.svelte.ts` skips its first, synchronous call so that loading either module first never calls into the other before its bindings exist (`stores.importOrder.test.ts`).

## Invariants

- `ParseMarkdown` output must go through `trimMarkdown` before `{@html}`. `mode:'notrim'` is an intermediate result, not a final one.
- Keep the DOMPurify hooks intact: class prefixing, the href policy, the YouTube iframe allowlist, and blob `src` retention.
- CSS must stay scoped:
  - Selectors are prefixed with `.chattext`.
  - Classes get the `x-risu-` prefix.
  - `<risu-style>` uses a hex round-trip so decoded CSS cannot re-enter the HTML parser.
- On the chat screen a row's shared `<style>` elements keep their attributes and an inert `/**/` comment: their CSS is in the screen's shared sheets. Custom-GUI sheets and layer/scope sheets remain at their row positions, with the cascade limits described in Display. Code that serializes or clones a row (plugins reading `.chattext`, `html-to-image` screenshots, which inline computed styles) gets the placeholders without the shared CSS, plus any retained sheets. A row whose sheet was removed after a real gap (a `{#key}` reload, a remount) gets a new one; a release and re-acquire in one synchronous flush keep the same sheet until the next microtask reconciles. Rows `Chats` trims are detached at once but unmounted over the next frames, and keep their sheets until then.
- Mutating functions must respect `rmVar`/`runVar`. Display evaluation uses `rmVar:true`. `setvar` is a no-op unless `runVar` is set.
- Keep aliases and name normalization compatible. Shared cards use historical spellings.
- `partialEdit` offsets refer to the original markdown, not the rendered HTML. It special-cases `{{ruby::...}}`.
- Asset path maps are built lazily by the first parse after a change. Asset inputs are separate derived values: the character's own asset/emotion tuples and `getModuleAssets`' plain shared tuples. An enabled asset edit changes the input value and reruns readers; lorebook edits and disabled modules' asset edits do not rebuild the parser maps or `ChatBody`'s `imageAssets`. A parse reads the input key itself, so it sees current assets even before an effect flush. `resetAssetsCache(charAssets, emoAssets, moduleAssets)` keeps its public signature and map shape; an explicit reset (including `[]` modules in the golden fixture) wins until live inputs change.
- Parser fuzzy matching scans only the character's additional assets, in order. Trimmed exact names use the first entry; other candidates must strictly improve the best and fit `floor(assetMaxDifference)`. Non-finite thresholds leave the scan unbounded by settings, and the final `dist > threshold` comparison preserves existing acceptance (including NaN and negative infinity). A distance-1 winner ends a normal scan. Cached hits remain globally closest; cached misses are reused only at an equal or smaller cutoff. Keep `trimmer`'s `[_ -.]` range and UTF-16 code-unit semantics.
- `ChatBody`'s image fallback scans character plus module assets with the existing prefix rule, first strict improvement below 1000, and empty-path/none behavior. Its per-name hit/miss memo belongs to the `imageAssets` value, so unchanged rows do not rescan; both fuzzy result memos clear at 10,000 names. `getDistance` remains exported with its original results. Names beyond 32,767 code units can make its Int16 table wrap negative: the bounded helper uses the same recurrence in two Int16 rows for those inputs, without unsound length/row pruning, and the parser disables its distance-1 stop when overflow is possible.
- CBS date and time functions on the server use the server's time zone and default locale; the tab's language reaches CBS only as `metadata::browserlang`.

## Recipes

- Add a CBS function:
  1. Add an entry in `shared/cbs/registry.ts:registerCBS`: name, callback, aliases, precise `description`. Use only injected helpers (a new host read is a new `CBSRegisterArg` field, wired in `parser.svelte.ts` and on the server). The file is strict-checked by the server `tsc`.
  2. Add it to the matching list in `gui/highlight.ts` (`normalCBS`, `normalCBSwithParams`, `displayRelatedCBS`, or `nestedCBS`).
  3. Add a test under `src/ts/parser/tests/cbs/` using the `cbs` helper from `lib.ts`.
  4. Confirm it appears in Playground → CBS docs.
- Change message display: `Chat.svelte:displaya` or `ChatBody.svelte:markParsing` for call order, and `ParseMarkdown`, `parseAdditionalAssets`, `renderMarkdown`, or `trimMarkdown` for rendering and security. Run `trimMarkdownStyle.test.ts`.
- Change variable semantics: `chatVar.svelte.ts` plus the `getvar`/`setvar`/`tempvar`/`getglobalvar` callbacks.

## Tests

- Server transform anchors: `server/src/tests/transform.test.ts` uses real Lua/regex workers and a fake embedding server for script order/effects; `server/src/tests/transformService.test.ts` covers held work, queue/admission, pause/close, cache and continuation fences; `server/src/tests/dynamicAssets.test.ts` ranks markers with deterministic vectors, including zero-regex-script paths.

- `src/ts/parser/tests/cbs/{conditionals,escapes,loop,strings}.test.ts`.
- `src/ts/parser/tests/cbs/limits.test.ts`: the client budget: a huge `range` ends with the work limit through `risuChatParser`, the budget starts over for the next top-level parse, a non-advancing range answers `[]`, `risuChatParserForDisplay` answers `language.cbsLimitReached` with the reason and warns once, and 25 sibling calls answer on the client host while genuine recursion stops.
- `server/src/tests/cbsCallDepth.test.ts` (node): the call depth counts nested parses only: 20/25/100 sibling calls, calls inside `#each`, 25 `{{description}}` and a 25-message `{{history}}`, a chain of nested functions answering at depth 20 and erroring past it, the caller's argument object untouched, a function defined inside a called body still visible, no leak of a `#func` from one history message to the next, and the fan-out bounded by the work budget. The `range` refusals (zero or negative step, non-finite bounds, the 2^53 stall) are in `server/src/tests/cbsLimits.test.ts`.
- `src/ts/parser/tests/cbs/prefill.test.ts`: `prefillsupported` through the tab parser and the real catalog: a Claude model with `hasPrefill` answers `1`, the adaptive-only `claude-opus-4-8` answers `0` (also as `prefill`), and a non-Anthropic-format model keeps the name-prefix answer (`gpt4o` `0`, an unlisted `claude-` id `1`).
- `chatVar.svelte.test.ts`.
- `chatML.test.ts`: has skipped and FIXME cases.
- `trimMarkdownStyle.test.ts`: covers sanitizer and XSS regressions.
- `server/src/tests/cbs.test.ts` (node; host `server/src/tests/cbsHost.ts`): the shared evaluator from a Node host against the browser-path baseline (`fixtures/baseline/markdown.json`: the `Mark` chat's `editprocess` and pre-pass texts, the random message by shape) and the host-parity cases of `fixtures/cbs-parity.json`; independent evaluators; a throwing host callback leaves the literal.
- `src/ts/parser/tests/cbs/hostParity.test.ts`: the same `cbs-parity.json` cases through the client wrapper (the selection, `CurrentTriggerIdStore`, `window`, `navigator`, the chat variables): recursive `#func`/`call`, the call-stack limit, the second `time` registration, the fixed clock in UTC, group speakers, `chatRef` versus the selection (messages, variables, the bound persona, local globals), the calculator (bound to the selection), `#when` operators, Unicode and XOR, the viewport, language, and trigger callbacks.
- `src/ts/parser/tests/transformClient.test.ts` (helper `transformReactive.svelte.ts`): the server transform client. When `captureTransform` applies, and that a computation calling it does not depend on the lock state; batching, shared identical targets, the frame-or-timer dispatch; the 64-target, 4 MiB, and 512 KiB splits; a failed target, a failed request, a 412 epoch mismatch, a missing or duplicate answer (one toast per batch); the handler-set id, hook order and plugin context, a thrown hook; the handler and chunk deadlines (a hung hook, a late first call, a call that never answers); the Re-render bypass (not taken by an older render, kept past a locked or unused capture, shared by every stage); emotions (once per key, the five-entry trim, none for `simple`, none from an answer older than a Re-render, again after a reset); a 412 on either call answers raw with no toast, while ordinary failures still toast.
- `e2e/serverTransform.spec.ts` (mock provider): one send per streaming mode (raw while streaming, transformed once at the end, no other row transformed, 0 DOM mutations on an unrelated row, an open `<details>` stays open); a locked row that is not the last renders raw with no request and is transformed once when the lock ends; Re-render sends one request with a bypass target for that message only; a chat switch while answers are held (A's answer does not land in B, stored variables unchanged).
- `e2e/transformGolden.spec.ts`: the script-transform golden. All of `fixtures/baseline/markdown.json` (`direct`, `prePass`, `back`, `editprocess`, with and without hooks) on the server path against the fixture recorded from the browser path before the cutover; the server-evaluated random and clock messages (`m-m3`, `m-m4`) are compared by format. Independent cases against their expected output recorded from the browser path at `219dfb51` (`server/src/tests/fixtures/transform/display-trigger-assets.json`, with its provenance): a v2 `display` trigger and both asset passes. On a page's first load (no controlling worker) the same render holds object URLs, a large image included, and otherwise matches the recording.
- A new chat's first-save re-render: the `chatSaveVersion` count it keys on is pinned in `src/ts/storage/tests/resourceSyncChats.test.ts` ("a chat's first save", `persistence.md`); the `Chat.svelte` effect itself runs only in the component.
- `src/lib/ChatScreens/PartialEditController.test.ts`: the controller's translation writes through `saveTranslation` and the dispatched `save` without it (`media-aux.md` Tests); occurrence targeting (two identical blocks on one line offered as a choice for an edit and a delete, the chosen one changed; a drag selection ending in an ellipsis edits exactly the selection).
- `src/ts/parser/tests/partialEdit.test.ts`: the matcher's occurrences (both on one line, from text and from a block's HTML, the `maxResults` cap) and the ellipsis mapping (before text, a space, a paragraph break, another ellipsis, at the end, selected as ASCII dots; ASCII dots in the source and the ruby case unchanged).
- `src/ts/parser/tests/assetFuzzy.test.ts` (flat fixture, `getFileSrc` and the transform client mocked): through `ParseMarkdown`, a module or character asset edit is seen at the next parse and by a tracked derived before any flush, and an explicit `resetAssetsCache` wins until a live input changes; the fuzzy path picks the first asset at the minimum, normalizes names, keeps the threshold comparison semantics (0, fractions, NaN, undefined, negative, infinities), rescans a cached miss when the threshold grows, matches a full `getDistance` scan on random UTF-16 names (surrogates included) and keeps the Int16 overflow precedence; `boundedDistance` equals `getDistance` inside the cutoff and is Infinity outside, also around the 32,767-unit wrap; `findAssetPrefix` agrees with the strict first-best prefix scan (ties, empty paths, the 1000 boundary).
- `src/ts/parser/tests/inlayAssets.test.ts` (`getDirectAssetSrc`, `getFileSrc`, and the inlay client mocked): through `ParseMarkdown`, inlay video and audio take the direct asset URL and their real MIME type (`.webm`, `.ogg`, `.m4a`) without an object URL in direct mode, the object URL with the real type in the fallback, and no `type` for an unknown extension in either.
- Not tested: most of `shared/cbs/registry.ts`, inlay image and dynamic-asset rendering, the matcher's anchor, fuzzy and bigram stages, `highlight.ts`.
- Not tested: the transform cache key's dependency on `GLGlobalVariables`, the preset and persona ids, the greeting, and the background targets (the chat's variables, note, local lore, source character, and language are).

## Known Hazards

- A CSS-only change to a shared sheet does not mutate the row's DOM, so `Chats` does not re-observe a `.far` row. Its remembered `contain-intrinsic-block-size` updates when the row renders near the viewport through `content-visibility: auto`.
- `src/ts/gui/codearea/cbsMonaco.ts` has an empty `registerCBSMonaco`; active CBS highlighting lives in `src/ts/gui/highlight.ts`.

- `escapes.test.ts` documents a known broken `cbr` repetition case.
- The evaluator has quadratic paths: `{{` nesting (`unshift`), the `#each` splice, `filter` with `unique`/`all`; the limits bound them on both hosts, and a row that reaches the client budget shows the limit text instead of its content. A fan-out of `call::` (a function calling itself twice) is bounded by the work budget only, so on the server it fails the job where the old shared call counter answered a short text with error strings.
- `removeHighlight` deletes the stored ID but leaves the global `CSS.highlights` ranges in place.
- `chatML.ts` references `OpenAIChat` without importing it and relies on an ambient declaration.
- The no-argument date and time functions do not pad: `YYYY-M-D` and `H:m:s`.
- The legacy `lastmessage` returns the last message's stored `data` without parsing its CBS, and `""` with no character selected.
- Unconfirmed: a transform's tab-side plugin handlers run with a captured plugin context whose API still has the persistent setters; the server transform itself writes nothing, but no test pins a setter called from a handler, so the text-only contract is not enforced.
- Unconfirmed follow-ups, deferred and not reproduced since: a hang in the additional-asset passes and a duplicate render after "Re-render" (`rerenderMessage` bypasses the transform cache). Both code paths remain.
