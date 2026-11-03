# CBS Template Language and Message Rendering

## Scope

- Owns the shared CBS evaluator/registry and variables, Markdown/HTML rendering and sanitization, CSS scoping, rendered
  asset/inlay expansion, ChatML, partial edits, and CBS editor highlighting/autocomplete.
- Paths:
  - `shared/cbs/{registry,evaluator,types,calc,limits}.ts` (the runtime both the client and the server run)
  - `shared/prompt/toggles.ts` (toggle definitions and global-value resolution)
  - `src/ts/cbs.ts`
  - `src/ts/parser/{parser.svelte,chatVar.svelte,chatML,partialEdit}.ts`
  - `src/ts/parser/{assetSearch,chatStyles,sentenceBreaks}.ts`
  - `src/ts/gui/highlight.ts`
  - `src/ts/gui/codearea/cbsMonaco.ts` (stub)
  - `src/lib/Others/MonacoEditor.svelte`
  - `src/lib/ChatScreens/PartialEditController.svelte`
  - Static CBS docs: `src/etc/airisu.cbs`, `src/etc/docs/{cbs_docs,cbs_intro,docs_text}.cbs` (search-ignored)
- Not here:
  - Regex scripts that run inside rendering → `scripts-triggers.md`.
  - The chat component tree → `ui-theming.md`.
  - Translation of rendered HTML → `translation.md`.
  - Bilingual sentence grouping before interleaving → `translation.md` (`parser/sentenceBreaks.ts`).
  - Chat-toggle writes and saved toggle presets → `persistence.md` (`src/ts/toggles/`, `shared/togglePresets.ts`).

## Files

### CBS runtime

- `shared/cbs/registry.ts`: the CBS function catalogue (re-exported by `cbs.ts`).
  - `registerCBS(arg: CBSRegisterArg)` enumerates every built-in function (name, callback, aliases, description,
    `internalOnly`/`doc_only`) into a callback supplied by the consumer. Every host read goes through `CBSRegisterArg`,
    including `getTriggerId` (`trigger_id`), `getViewport` (`screenwidth`/`screenheight`), and `getBrowserLanguage`
    (`metadata::browserlang`).
  - `{{lorebook}}` (`worldinfo`) returns the character's `globalLore` with the chat's `loreOverrides` applied
    (`shared/lore/overrides.ts` `mergeOwnerLore`: an override's copy in the original's place, an off entry left out, an
    off folder with every entry inside it, an orphan not inserted; a group character contributes none), then the chat's
    `localLore`, then the chat's module lore.
  - `contextChar`/`contextChat`: the parse's `chatRef` character and chat, or the selected ones.
  - `prefillsupported` (`prefill_supported`, `prefill`): for a model whose descriptor (`CBSRegisterArg.getModelInfo`,
    which both hosts resolve through `shared/llm/models.ts` `resolveModelInfo` with the custom flags) is Anthropic or
    Anthropic legacy format, its `hasPrefill` flag (so an adaptive-only Claude model answers `0`); for any other format,
    whether `aiModel` starts with `claude`.
- `shared/cbs/evaluator.ts` `createCbsEvaluator(host: CbsHost)`: the parse/eval loop (`risuChatParser`), the block
  matchers, and its own function map, filled from `registerCBS` on first use. Also `risuEscape`/`risuUnescape`.
  - The depth of nested parses is capped at 20, derived per child from `arg.callStack` without writing the caller's
    object, so sibling `call::` and `history` parses do not count.
  - `CbsHost` is `CBSRegisterArg` without the parts the evaluator supplies itself (`registerFunction`, `risuChatParser`,
    `makeArray`, `parseArray`, `parseDict`, `dateTimeFormat`), plus `findCharacterById` (a group's last speaker).
- `shared/cbs/limits.ts`: cooperative evaluation limits for a host that sets `CbsHost.limits`. An evaluator without
  limits never counts or reads the clock.
  - Hosts: the server's `serverCbsLimits`, and the client's `CLIENT_CBS_LIMITS` in `parser.svelte.ts`: the shared
    `DEFAULT_CBS_MAX_WORK` of 10,000,000 units and 2 s per top-level parse, so a text the tab shows the server transform
    also accepts.
  - `CbsLimits` holds `maxWork`, `maxMs`, an optional shared `total` allowance, and `now`; `CbsLimitError.reason` is
    `work`, `time`, or `total`. One top-level parse's budget is shared by its nested parses
    (`enterCbsParse`/`leaveCbsParse`). `replaceAllBound` counts a `replaceAll` result's length before it is built.
  - Charging: the evaluator charges a unit per scanned character and per character a function returns, the stack moves
    of `{{` and of the unfinished-syntax drain, each `#each` piece and `call::` substitution before it is built, and the
    `#each` splice. The registry charges its counted loops through `CBSRegisterArg.spend` (a no-op without limits). The
    matcher's swallow-all `catch` lets `CbsLimitError` through.
- `shared/cbs/calc.ts` `calcString(text, { getChatVar, getGlobalChatVar })`: the `{{? ...}}` and trigger calculator
  (`$name` a chat variable, `@name` a global). `process/infunctions.ts` binds it to the selected chat's variables.

### Client host and renderer

`parser/parser.svelte.ts` is the client host of the evaluator and the renderer.

- `risuChatParser(text, arg)`: the shared evaluator with the client host (the live database, the selected character,
  `CurrentTriggerIdStore`, `window`, `navigator`, `findCharacterbyId`, `CLIENT_CBS_LIMITS`).
- A parse that reaches the budget throws `CbsLimitError` to its caller (the server's `cbs` callback fails its request on
  purpose, `src/ts/process/request/transport.ts`). `risuChatParserForDisplay` catches only that error and answers
  `language.cbsLimitReached` with the reason, for the places that show the result: the chat row's pre-pass
  (`Chat.svelte` `displayPrePass`, also the copy of a streaming row), `BackgroundDom.svelte`, and the
  `PopupEditor.svelte` preview.
- `ParseMarkdown`, `renderMarkdown`/`renderHighlightableMarkdown` (markdown-it + KaTeX + highlight.js), `trimMarkdown`
  (DOMPurify plus scoped-style restore), `trimMarkdownSharingStyles`, `parseMarkdownSafe`.
- Assets: `parseAdditionalAssets`, `assetRegex`, `resetAssetsCache`, `syncAssetsCache`. `getClosestMatch`/`fuzzyIndexOf`
  use a per-character-list fuzzy index and bounded result memo. Video and audio `<source>` types follow the
  [inlay rule](#inlays).
- `ParseMarkdown` resolves `{{source::char}}` from the owner of its captured render chat (groups included), falling back
  to the selected character when there is no render chat or its owner is missing; it resolves `{{source::user}}` from
  that chat. Both icon paths are captured before the first await and shared across both asset passes.
- `parser/chatStyles.ts`: `ChatStyleRegistry` (the chat screen's shared row stylesheets:
  `acquire(style, messageIndex, slot)` takes a `ChatStyle` with CSS and sanitized attributes and returns a release,
  `attach(host)` for `{@attach}`, `destroy`) and `setChatStyleRegistry`/`getChatStyleRegistry` (context).
  `src/lib/ChatScreens/ChatRowStyles.svelte` holds a row's uses (by value, so an equal re-render keeps them). See
  [Shared styles](#shared-styles).
- `parser/assetSearch.ts`: `boundedDistance` (shared reusable two-row UTF-16 Levenshtein scratch space,
  length/band/row-minimum pruning) and `findAssetPrefix` (`ChatBody.svelte`'s strict first-best prefix scan).

### Inlays

`parseInlayAssets` (inside `ParseMarkdown`) expands `{{inlay::id}}`, `{{inlayed::id}}`, and `{{inlayeddata::id}}` from
`getInlayMedia` (the asset key only, no bytes). Images use `getFileSrc` in both of its modes
([global API](global-api.md)). Audio and video have two modes:

- Direct mode (`globalApi.svelte.ts` `getDirectAssetSrc` answers a URL: worker use enabled, the `directAssets`
  capability, and a controlling worker at the call): `/api/asset/<hex(utf-8 key)>`, the same URL `getFileSrc` gives. No
  bytes are read and no object URL is made; a missing file shows as the element's 404.
- Fallback (`getDirectAssetSrc` answers `null`): the typed object URL from `files/inlays.ts` `getInlayObjectUrl`, kept
  for the page; a missing file or one without bytes leaves the tag in place.
- Either way the `<source>` `type` is `shared/assetMime.ts` `assetMimeType` of the asset key's extension, so it matches
  the asset route's `Content-Type`, including `audio/flac` and `video/x-matroska`. An extension the table does not know
  (`application/octet-stream`) gets no `type` attribute, so the browser sniffs the bytes instead of skipping the source.
  Fallback Blobs use the same table, with `application/octet-stream` for unknown media and `application/json` for
  signatures.
- Both URLs are stable strings that are never revoked, so cached renders and translations keep working ones. A page that
  loses its controller renders new inlays through the fallback; HTML rendered before keeps its direct URLs.

### Script transform client

- `parser/transformClient.ts`: client of the server script transform (`POST /api/transform`, `server-generation.md`);
  the only script stage of a render. There is no browser Lua or trigger runtime and no browser regex stage of a render;
  the translator's `edittrans` regex is the one regex the tab still runs (`translation.md`).
- `captureTransform(chatID, { chatRef?, pluginContext? })` reads the call's context before its first await: the chat,
  the message id at `chatID`, the chat's display ids, the plugin call context, the message's lock, its Re-render
  generation, the tab cache generation, `chatInstallVersion` and `chatHasUnackedWork`.
  - The display ids are `chatDisplayIds` ([chat bindings](persistence.md)): per field the bound record when it exists,
    else the tab's; the persona is sent as both the effective and the selected one.
  - The first transform sent at a Re-render's generation takes its cache bypass, for every later stage too.
  - `ChatBody.svelte` `markParsing` captures once and passes it to `ParseMarkdown`, `translateHTML`, and its retries
    (their last argument: a capture, `null` for none, or none to capture there).
  - It answers null without a chat, for a chat the server has not stored yet (no held revision), or without a preset or
    persona, and the caller then skips the script stage (the text as the CBS pre-pass and the assets leave it).
    `Chat.svelte` renders a row again once its chat's first save lands (`chatStore.svelte.ts` `chatSaveVersion`), so a
    new chat's rows get their transform.
- `serverProcessScript` runs `editdisplay` and `editprocess` on the server (`{ data, emoChanged }`).
- `rerenderMessage(chatRef, messageId)` drops that message's tab results, makes its next render bypass both caches, and
  fences older answers' cache changes and effects.
- `resetTransformEffects` (on the `ReloadGUIPointer` bump) forgets which results' emotions were applied and advances the
  tab cache generation while keeping its entries, across chat switches too. Older captures cannot change or confirm the
  cache, apply emotions, or schedule a provisional correction.
- `parser/transformResults.ts`: the tab's bounded LRU of confirmed source text and server answers, with conditional
  replacement by entry version so an overlapping older answer cannot overwrite a newer entry; effects are never
  retained. See [Caches](#caches).
- `src/lib/ChatScreens/settledRender.svelte.ts`: [the mixed render refresh](#mixed-render-refresh).

### Variables

`parser/chatVar.svelte.ts` holds the variable accessors.

- Chat variables: `getChatVar`/`setChatVar`, stored in `Chat.scriptstate` as `$name`. Reads fall back to character
  `defaultVariables`, then the prompt preset's `templateDefaultVariables`, then `"null"`. A write
  [merges that one entry](chat-store.md#map-merges) (`mergeChatMeta`, a `meta` op's `merge`), so the other variables
  keep what another tab or a job set meanwhile (the same variable is last writer wins).
- A parse given `chatRef` (`risuChatParser(text, { chatRef })`, set by the send pipeline, triggers, and Lua) reads and
  writes that chat's variables and messages (`getChatVarOf`/`setChatVarOf`); without it, the selected character's
  selected chat.
- Globals: `getGlobalChatVar`/`getGlobalChatVarOf` use `shared/prompt/toggles.ts:resolveGlobalChatVar`: chat override,
  legacy global, then a defined toggle's kind default (`"0"` for checkbox/select, `""` for text/textarea), else
  `"null"`. Empty text/textarea values count as set. Definitions come from the ref/scope's preset, enabled modules, and
  chat owner, first key wins; parsing is cached by source text.
- `globalToggleDefinitions` also supplies `toggles/chatToggles.svelte.ts:chatToggleDefinitions` for the sidebar and
  preset operations. The sidebar and `toggles/togglePresets.svelte.ts` call `resolveGlobalChatVar` with one computed
  definitions text; `shared/togglePresets.ts` captures resolved values and compares/projects saved keys and kinds.
- `setChatToggle(ref, key, value)` writes only that loaded chat's `GLGlobalVariables` through `mergeChatMeta`, skipping
  unchanged stored values. Opening a chat never seeds values.

### Other parsers and editors

- `parser/chatML.ts` `parseChatML`: a `<|im_start|>` splitter that extracts `<Thoughts>` and CBS-parses each part. Used
  by `sendChat` `chatML` cards, the translator, and memory.
- `parser/partialEdit.ts`: maps rendered text back to markdown ranges.
  - `findAllOriginalRangesFromText`/`FromHtml` match in stages: exact, then anchor, then fuzzy, then bigram. The answer
    is sorted by confidence then position and deduplicated by identical source range only, so two identical occurrences
    on one source line both come back and the controller shows its chooser.
  - The normalization maps every character of the normalized text to a source offset; a typographic ellipsis becomes
    three dots that all map to the ellipsis, so a selection ending in one stops at it.
- `gui/highlight.ts`: editor highlighting and autocomplete.
  - `highlighter` uses the CSS Custom Highlight API with `::highlight(cbsnest0..4)` etc. in `src/styles.css`.
  - `AllCBS` is the autocomplete list, maintained by hand.
- `gui/codearea/cbsMonaco.ts`: `registerCBSMonaco` is empty, so Monaco has no CBS language support.
- `PartialEditController.svelte`: hover and drag-select editing of rendered messages. Dispatches `save`, which
  `Chat.svelte:handlePartialEditSave` handles; a translation edit goes through the awaitable `saveTranslation` prop
  instead when the parent passes one (`translation.md`, the stored path), and the draft stays when that write is
  refused. Escape cancels and Ctrl/Meta+Enter saves, neither while an IME composes (`src/ts/ime.ts` `isImeComposing`).

## Flows

### Evaluation

1. `risuChatParser` callers include `Chat.svelte`, `tokenizeAccurate`, `command.ts`, the HypaV3 modal, the plugin API,
   the lorebook, and the playground (the server evaluates its own CBS with `shared/cbs/`).
2. `<user>`, `<char>`, and `<bot>` are normalized to CBS.
3. The scanner handles nested `{{...}}`, blocks, comments, `#each`, and `#func`/`call`.
4. Plain functions go to `matcher`, which splits the arguments on `::`, normalizes the name (lowercased; whitespace,
   `_`, and `-` removed), and invokes the callback. Unknown functions stay as literal text.
5. A callback may return `{text, var}`. `return` sets `__force_return__`.

### Display

1. `Chat.svelte:displaya` evaluates the message with `risuChatParser(..., {rmVar:true, visualize:true})`.
2. `ChatBody.svelte:markParsing` calls `ParseMarkdown`, which runs in order:
   1. `parseAdditionalAssets`.
   2. `serverProcessScript(...,'editdisplay')`: [Display transform](#display-transform). The CBS of step 1 and every
      other step stay in the browser.
   3. Assets again, then inlays.
   4. Thoughts and tools.
   5. Style encoding.
   6. Markdown.
   7. `trimMarkdown`.
3. The template renders `{@html addMetadataToElement(pruneEmptyBilingualPairs(trimMarkdown(md)))}`. Under the chat
   screen (`DefaultChatScreen` provides a `ChatStyleRegistry`), a body that holds a `<style>` or `<risu-style>` goes
   through `trimMarkdownSharingStyles` instead: [Shared styles](#shared-styles).

### Display transform

- The step is skipped without a context ([`captureTransform`](#script-transform-client)). The render's capture is taken
  before the first asset pass.
- The call joins the frame's batch (or a 16 ms timer's) for its context, mode, plugin handler set, viewport and browser
  language (sampled at the call).
- The server runs Lua `editDisplay`, the `display` trigger, CBS, and the regex scripts; the tab's `editdisplay` plugin
  handlers run read-only between the two calls. The target is `background` for `mode:'back'`, else `message`.
- A message locked by a generation (it streams) skips this step and renders again when the lock ends.
- Provisional display: for a message whose render began without unacknowledged work, `ChatBody`'s final display stage
  can show the tab's cached transform text immediately, through the remaining asset, markdown and sanitization steps,
  while awaiting confirmation. This is enabled on the stored and plain display paths; translation inputs and
  auto-translate probes wait for the answer.
- A different full answer replaces the shown text: a correction reuses the answer without another request unless it
  mixed chat states, when it requests fresh state instead.
- A failed request or target leaves the text as it came in, replacing provisional text too (one toast per batch, on its
  first failure).

### Display transform failures

`parser/transformClient.ts` makes the batches and chunks and decides `permanent` (`permanentRefusals`);
`displayTransformRecovery.svelte.ts` holds the failures and runs the rounds.

- A failed `editdisplay` transform records a `notice` `transformFailed` diagnostics event. For a message with a captured
  id and current cache and Re-render generations, it is registered for recovery unless it is permanent.
- A failure is permanent when it is the tab's own size refusal (a source over `MAX_TRANSFORM_TEXT_BYTES`, never sent), a
  400 or 413 answer to either call of a chunk whose first request held that target alone (a refused chunk of several
  targets retries them), or a target the server marks `permanent` (a text or loaded scope over a limit on its own;
  `server/src/prompt/transform.ts`).
- A permanent failure waits for a changed source or context, a later mount, or a Re-render, and retires the message's
  older-generation failures as a success does.
- While the page is visible and failures are pending, a retry round runs after a backoff (5 s, doubling, capped at 60
  s), and at once when the page becomes visible again or the browser goes `online` (`pageVisibility.svelte.ts`).
- A successful current transform retires failures from older Re-render generations, while preserving failures from other
  targets in the same generation.
- Each `Chat.svelte` row reports what it shows (`displaya`: the display text and the bilingual source side) through
  `showDisplayTransformSource`, and a failure keeps what its message's row showed when it failed.
- A row showing another source (an edit or a saved edit from another tab, which mount a transcript row again, a stream,
  or a switch to or from the stored translation) drops that failure, because the new source renders and records its own.
- A round takes every remaining pending failure; each mounted `Chat.svelte` row in it calls `rerenderMessage` and
  renders again, and a row no longer mounted misses it (a later mount renders fresh).
- `editprocess` calls, greetings, and bookmark previews (no captured message id) register nothing.

### Mixed render refresh

- An `editdisplay` answer marks its render mixed if it began with unacknowledged work or its chat's install version
  moved before the answer, including across the plugin continuation.
- A handed-off answer carries its originating capture's install version: the correction also marks itself mixed if it
  began with unacknowledged work, its install version moved during its asset wait, or the originating and correction
  captures have different install versions. A validated handoff still returns its text without another request; the
  mixed report schedules the settled refresh.
- `ChatBody` reports the newest live render once, after any provisional confirmation/replacement decision; `Chat.svelte`
  registers it with `settledRender.svelte.ts`.
- `waitForSettledRender` holds affected mounted rows per chat until it has neither unacknowledged work nor a locked
  message, then drains each registration once, and those rows render once more through the caches (`Chat.svelte` bumps
  `chatBodyRevision`, and disposes registrations on unmount or a chat/message change). Quarantined, deferred and
  job-blocked work keep the chat unsettled.
- This refresh covers the server transform; the browser CBS pre-pass retains its own reactivity, and rows rendered
  before this window receive no refresh (they update on remount).

### Shared styles

- `trimMarkdownSharingStyles` gives the same sanitized tree and style restore as `trimMarkdown` (only when the input
  includes the case-sensitive `<risu-style` prefix), with bilingual pairs pruned on it before extracting styles.
- Each nonempty `<style>` whose CSS does not match `/@layer\b|\blayer\(|@scope\b/i` gets the inert comment `/**/` in
  place of its CSS. The element and its attributes stay, so structural selectors, including `:empty`, match as before.
- `ChatRowStyles` holds its CSS and sanitized attribute list in the registry, keyed by value. The registry keeps one
  `<style>` per distinct CSS and attribute list in a hidden container at the end of `.default-chat-screen`, after the
  rows, greeting, `BackgroundDom`, suggestions, and plugin panels. It copies attributes with `setAttribute` and CSS with
  `textContent`, so CSS never re-enters the HTML parser; a sheet is removed when no mounted row uses it.
- Ordering among shared sheets follows the rows' last copies: rows sit in the DOM newest message first, then the
  greeting, so each use has the position (-message index, slot), a sheet stands at the maximum of its users' positions,
  and the oldest message's style (the greeting's last) wins a tie. A sheet moves (and is parsed again) only when that
  order between distinct sheets changes.
- Releases and moves wait for the next microtask; a release and re-acquire in one synchronous flush are coalesced, so
  the sheet is retained.
- Retained styles: custom-GUI sheets in `Chat.svelte` and sheets containing `@layer`, `layer(`, or `@scope` stay at
  their row positions; empty sheets stay untouched too. This preserves the first declaration order of layers and the
  parent of implicit scopes. Their order against a newer row's shared sheet can reverse; this matters for conflicts the
  layer/scope-proximity steps do not already decide. Layers declared inside imported files are not detected and remain a
  limit.
- `Chats` mounts its rows with its contexts (`getAllContexts`). Without a registry (`BookmarkList`, an `App` sibling,
  and component tests) a row keeps its own `<style>`s.

## State

### Variable storage

- See [Variables](#variables) for persisted values; temp vars and `#func` definitions are per-call.

### Caches

- Parser and page caches: the parser's file-source (`fileSrcCache`) and encoded-metadata maps, the fallback's media
  object URLs in `files/inlays.ts` (`mediaObjectUrls`), the scoped evaluators (`scopedEvaluators`), the asset maps
  (reset by `resetAssetsCache` and by `syncAssetsCache` in an `$effect.root` and at the start of an asset parse), and
  global `CSS.highlights`.
- Server transform (`server/src/prompt/transformCache.ts`): an LRU of text and emotions, 512 entries / 16 MiB, at most
  512 KiB per entry.
  - `transform.ts` keys both modes by epoch, mode, captured context, handler set, viewport and browser language, the
    stored chat revision the load read, the keyed record revisions, chat metadata, and each target's kind, message id,
    index, source id/identity, conditions and source digest.
  - A result stays under the loaded revision even if the chat changes during the run; a new request reads the current
    revision. Every save of a chat makes its rows' previous entries unreachable to new requests, so remounting after a
    send renders them on the server again; a batch already running can still use its loaded revision's hits.
  - Character display identities (`displayScope.ts`) hash stored JSON before runtime chats are attached, preserving
    property order and excluding only top-level `lastInteraction`; missing characters contribute `missing`. The owner,
    group members and stored message speakers enter the shared key; each target adds its own source, so another target's
    source does not change its key.
  - The member/speaker memo uses owner id, chat id and chat revision and validates the owner's display identity; the
    all-cached probe reads revisions and chat metadata, plus character records on identity memo misses, without parsing
    configuration or messages.
  - `displayKinds.ts` drops the kinds display reads do not reach; admission kinds and `globalChatVariables` stay, and an
    unclassified kind stays keyed. The display loader's raw configuration cache still uses the full revision vector
    ([chat pipeline](chat-pipeline.md)).
- Tab transform (`parser/transformResults.ts`): 2,048 entries / an 8 MiB estimate including identity, server key,
  source, result and message strings.
  - Identity includes chat ref, mode, kind, captured message id, index, source id, a synchronous source hash with an
    exact-source hit check, conditions, captured context, handler set, viewport and browser language.
  - `transformClient.ts` sends `knownKey` for a matching entry only when the caller is `simple` or that key's emotions
    were already applied; an exact ordinary server cache hit answers `same` with id and key, confirming the tab's
    retained text. Other answers return full text; cached text and `same` apply no emotions, and full confirmed answers
    apply them once per key for non-simple callers.
  - `resourceClient.ts` clears the entries on a changed epoch through `setResourceEpoch` and immediately on
    `epochMismatch`. `clearTransformResults` is the entry point for a future sign-out (there is no sign-out flow).
    [Script transform client](#script-transform-client) has the other resets (`rerenderMessage`,
    `resetTransformEffects`).
  - Cache writes, confirmations and provisional callbacks are fenced by the captured cache and Re-render generations.

## Coupling

- `stores.svelte.ts` imports `resetTransformEffects` from `transformClient.ts`, which imports the stores back. The
  `ReloadGUIPointer` subscriber in `stores.svelte.ts` skips its first, synchronous call so that loading either module
  first never calls into the other before its bindings exist (`stores.importOrder.test.ts`); keep the module-level reads
  lazy.
- `registerCBS` also feeds `PlaygroundDocs.svelte` (live docs from `description`) and `cbsMonaco.ts`, through `cbs.ts`.

## Invariants

- `ParseMarkdown` output must go through `trimMarkdown` before `{@html}`. `mode:'notrim'` is an intermediate result, not
  a final one.
- Keep the DOMPurify hooks intact: class prefixing, the href policy, the YouTube iframe allowlist, and blob `src`
  retention.
- `trimMarkdown`'s config (`trimPurifyConfig`) keeps the chat's script attributes `risu-btn`, `risu-trigger`, `risu-id`,
  and `risu-form` (a Lua form, `scripts-triggers.md`); DOMPurify's defaults keep the form controls and strip `on*`
  handlers and `javascript:` values. A form's submit never navigates (`Chat.svelte` default-prevents every submit in a
  row).
- CSS must stay scoped:
  - Selectors are prefixed with `.chattext`.
  - Classes get the `x-risu-` prefix.
  - `<risu-style>` uses a hex round-trip so decoded CSS cannot re-enter the HTML parser.
- On the chat screen a row's shared `<style>` elements keep their attributes and an inert `/**/` comment, and custom-GUI
  and layer/scope sheets remain at their row positions: [Shared styles](#shared-styles) has the rule and its cascade
  limits.
- Code that serializes or clones a row (plugins reading `.chattext`, `html-to-image` screenshots, which inline computed
  styles) gets the placeholders without the shared CSS, plus any retained sheets.
- A row whose sheet was removed after a real gap (a `{#key}` reload, a remount) gets a new one. Rows `Chats` trims are
  detached at once but unmounted over the next frames, and keep their sheets until then.
- Tab-side plugin continuations of both `editdisplay` and `editprocess` carry `PluginCallContext.purpose: "transform"`.
  The v3 host refuses durable-data setters synchronously before any permission prompt, load or await, with a console
  warning naming the API and no exception; the
  [plugin author contract](../../plugins.md#read-only-transform-continuations) lists each API's result. `parseRisuChat`
  still parses but forces `runVar` off.
- Transform batches key the captured plugin context as well as the server context so purposes, owner lifetimes and job
  parents cannot be borrowed from another call. Job-channel callbacks keep their normal write contract.
- Mutating functions must respect `rmVar`/`runVar`. Display evaluation uses `rmVar:true`. `setvar` is a no-op unless
  `runVar` is set.
- Keep aliases and name normalization compatible. Shared cards use historical spellings.
- `partialEdit` offsets refer to the original markdown, not the rendered HTML. It special-cases `{{ruby::...}}`.
- Asset path maps are built lazily by the first parse after a change, including a chat row's `simple` character
  argument. Asset inputs are separate derived values: the character's own asset/emotion tuples and `getModuleAssets`'
  plain shared tuples. An enabled asset edit changes the input value and reruns readers; lorebook edits and disabled
  modules' asset edits do not rebuild the parser maps or `ChatBody`'s `imageAssets`.
  - A parse reads the input key itself, so it sees current assets even before an effect flush. `ChatBody` also reads its
    shared module assets before any translation/cache await, so those paths invalidate even when the parser's reads
    happen after an await.
  - `resetAssetsCache(charAssets, emoAssets, moduleAssets)` keeps its public signature and map shape; an explicit reset
    (including `[]` modules in the golden fixture) wins until live inputs change.
- Parser fuzzy matching scans only the character's additional assets, in order. Trimmed exact names use the first entry;
  other candidates must strictly improve the best and fit `floor(assetMaxDifference)`. Non-finite thresholds leave the
  scan unbounded by settings, and the final `dist > threshold` comparison preserves existing acceptance (including NaN
  and negative infinity). A distance-1 winner ends a normal scan. Cached hits remain globally closest; cached misses are
  reused only at an equal or smaller cutoff. Keep `trimmer`'s `[_ -.]` range and UTF-16 code-unit semantics.
- `ChatBody`'s image fallback scans character plus module assets with the existing prefix rule, first strict improvement
  below 1000, and empty-path/none behavior. Its per-name hit/miss memo belongs to the `imageAssets` value, so unchanged
  rows do not rescan; both fuzzy result memos clear at 10,000 names.
- `getDistance` remains exported with its original results. Names beyond 32,767 code units can make its Int16 table wrap
  negative: the bounded helper uses the same recurrence in two Int16 rows for those inputs, without unsound length/row
  pruning, and the parser disables its distance-1 stop when overflow is possible.
- CBS date and time functions on the server use the server's time zone and default locale; the tab's language reaches
  CBS only as `metadata::browserlang`.

## Recipes

### Add a CBS function

1. Add an entry in `shared/cbs/registry.ts:registerCBS`: name, callback, aliases, precise `description`. Use only
   injected helpers (a new host read is a new `CBSRegisterArg` field in `shared/cbs/types.ts`, wired in
   `parser.svelte.ts` and `server/src/jobs/cbsHost.ts`). The file is strict-checked by the server `tsc`.
2. Add it to the matching list in `gui/highlight.ts` (`normalCBS`, `normalCBSwithParams`, `displayRelatedCBS`, or
   `nestedCBS`).
3. Add a test under `src/ts/parser/tests/cbs/` using the `cbs` helper from `lib.ts`.
4. Confirm it appears in Playground → CBS docs.

### Change message display

`Chat.svelte:displaya` or `ChatBody.svelte:markParsing` for call order, and `ParseMarkdown`, `parseAdditionalAssets`,
`renderMarkdown`, or `trimMarkdown` for rendering and security.

### Change variable semantics

`chatVar.svelte.ts` plus the `getvar`/`setvar`/`tempvar`/`getglobalvar` callbacks.

## Tests

Runner, slow-test, and timing rules belong to [test-harness](test-harness.md).

- Parser, rendering, tab transform: `pnpm --silent test:agent src/ts/parser/tests`.
- Server host and limits: `pnpm --silent test:agent server/src/tests/cbs*.test.ts`.
- Server transform:
  `pnpm --silent test:agent server/src/tests/{transform,transformService,transformBudget,dynamicAssets}.test.ts`.
- `src/ts/parser/tests/cbs/lib.ts`: the `cbs` helper writes a `{{op::args}}` string; `holdMockedChats` installs fixture
  characters and chats the way boot does.
- Host parity: `server/src/tests/fixtures/cbs-parity.json` holds hand-derived cases pinning the legacy quirks, run
  through the client host (`src/ts/parser/tests/cbs/hostParity.test.ts`) and a Node host
  (`server/src/tests/cbs.test.ts`).
- `src/ts/parser/tests/transformClient.test.ts`: the server is a function of the request, the chat module a few maps,
  `transformReactive.svelte.ts` the lock source, and timers are fake.
- `e2e/serverTransform.spec.ts`, and `e2e/transformGolden.spec.ts`, which compares final browser HTML with
  `server/src/tests/fixtures/baseline/markdown.json` (read, never written).
- `slow`: the fresh-process cases of `server/src/tests/cbsLimits.test.ts`.
- `src/ts/parser/tests/chatML.test.ts` has skipped and FIXME cases.
- Not directly tested: most of `shared/cbs/registry.ts`, inlay images and dynamic-asset rendering, the matcher's
  anchor/fuzzy/bigram stages, and `highlight.ts`.
- Not tested: direct transform key tests still omit per-chat `GLGlobalVariables`, changes of context preset/persona ids,
  the greeting index and background targets; preset/persona binding refusals are covered.

## Known Hazards

### Issues

- `escapes.test.ts` documents a known broken `cbr` repetition case.
- `removeHighlight` deletes the stored ID but leaves the global `CSS.highlights` ranges in place.
- `chatML.ts` references `OpenAIChat` without importing it and relies on an ambient declaration.
- Unconfirmed: a hang in the additional-asset passes has not been reproduced. The source-image test in
  `src/ts/parser/tests/assetFuzzy.test.ts` pauses and releases `getFileSrc`, but does not test a lookup that never
  settles.
- Unconfirmed: the reported duplicate row render after Re-render is not established as a user-visible defect.
  `e2e/serverTransform.spec.ts` observes two targets in one request: the first bypasses cache and the second reuses its
  result.
- A permanent display failure is not remembered: when another target of the same row fails transiently (a legacy
  rendered translation's paragraph beside an oversized original), that row's retry round rerenders it whole, so the
  permanent target is requested and its toast shown again every round. A fix would remember terminal outcomes per
  target.
- A refused request of several targets (a sum over the continuation's text limit, or a JSON body over its cap from
  escaped sources that fit the source-byte chunking) stays transient and is batched the same way each round. A fix would
  split a refused request.
- A request of the old source still in flight when its message is edited can fail after the edited source renders. The
  failure is recorded against the source shown then, so its retry round rerenders the edited row once (typed form input
  included). The capture carries no shown source to fence it.
- The transform's invalidation guarantee does not cover inlay records or file existence read by Lua
  `getCharacterImage`/`getPersonaImage`; those inputs are not keyed.
- The tab's plugin handlers are opaque: their output is cached under the server key and handler-set identity, refreshed
  by a chat change, a viewport change or Re-render, but not by plugin-private state or records outside the key. They can
  still read `lastInteraction` through `getCharacter()`.
- A `{{random}}` or clock row may change when it remounts after its chat changed. After eviction or Re-render elsewhere,
  a random/clock/plugin row can be refilled with different text under the same key, and `same` can still confirm the
  tab's older text: the key names inputs, not output.
- Resize and rotation do not re-render rows; the new viewport takes effect on the next remount.
- A [permanent display failure](#display-transform-failures) is not retried when only the stored data shrinks: a
  transcript or character trimmed under the limit renders the row on its next mount or a Re-render, not on its own.
- A script whose output size varies (`{{random}}`, a clock) can fail the head limit once and fit on the next run; it is
  still marked permanent.
- The server checks scope limits on the scope loaded for that request, so a target whose request also named a large
  non-member source character fails permanently beside it; a chat's own members are always loaded, so its rows normally
  load the same scope.
- A screenshot taken while a provisional display awaits a replacing answer can capture the cached text:
  `ChatBody.svelte`'s `whenRendered` waits for current parses and auto-translation, not the transform confirmation.

### Limitations

- Write refusal checks every active context of a plugin instance (`hasReadOnlyContext`), while target selection uses the
  innermost (`currentContext`). A writable hook overlapping a transform on that instance is conservatively refused too;
  a handler that never settles keeps that restriction even after its transform times out. Exact call attribution needs
  an RPC call id. Decision: the [read-only continuation contract](../../plugins.md#read-only-transform-continuations).
- Plugin-private writes remain allowed: `pluginStorage` and its `_…PluginStorage` aliases, `getLocalPluginStorage()`'s
  object, safe local storage, and the calling plugin's own arguments through `setArgument`/`setArg`. They can affect
  opaque cached output without invalidating it. Decision: the
  [read-only continuation exclusions](../../plugins.md#read-only-transform-continuations).
- `runLLMModel`, `postPluginChannelMessage` and `loadPlugins` are unguarded: LLM transport can persist returned inlays,
  channel messages do not propagate the context, and newly loaded plugin instances do not inherit it. General networking
  and consent bookkeeping also remain available. This boundary governs host data setters, not every possible side
  effect. Decision: the [read-only exclusions](../../plugins.md#read-only-transform-continuations).
- The evaluator has quadratic paths: `{{` nesting (`unshift`), the `#each` splice, `filter` with `unique`/`all`; the
  limits bound them on both hosts, and a row that reaches the client budget shows the limit text instead of its content.
  A fan-out of `call::` (a function calling itself twice) is bounded by the work budget only, so on the server it fails
  the job. Decision: the limits are policy (`server/src/jobs/cbsHost.ts`); the `call::` trade-off is pinned in
  `server/src/tests/cbsCallDepth.test.ts`.

### Gotchas

- A CSS-only change to a shared sheet does not mutate the row's DOM, so `Chats` does not re-observe a `.far` row. Its
  remembered `contain-intrinsic-block-size` updates when the row renders near the viewport through
  `content-visibility: auto`.
- The no-argument date and time functions do not pad: `YYYY-M-D` and `H:m:s`.
- The legacy `lastmessage` returns the last message's stored `data` without parsing its CBS, and `""` with no character
  selected.
