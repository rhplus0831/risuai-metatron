# CBS Template Language and Message Rendering

## Scope

- Owns the shared CBS evaluator/registry and variables, Markdown/HTML rendering and sanitization, CSS scoping, rendered
  asset/inlay expansion, the tab's display-transform client and its failure retries, ChatML, partial edits, and CBS
  editor highlighting/autocomplete.
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

Each entry is the path, its role, and the identifiers to look up; the rules are the doc comments on those identifiers
and the module headers.

### CBS runtime

- `shared/cbs/registry.ts`: the CBS function catalogue, re-exported by `src/ts/cbs.ts` (`registerCBS`,
  `defaultCBSRegisterArg`). A function's rule is the comment at its registration (`lorebook`, `prefillsupported`).
- `shared/cbs/types.ts`: the host boundary (`CBSRegisterArg`, `RegisterCallback`, `CbsDatabase`, `CbsConditions`,
  `matcherArg`). A new host read is a new `CBSRegisterArg` field, wired on both hosts (`src/ts/parser/parser.svelte.ts`,
  `server/src/jobs/cbsHost.ts`).
- `shared/cbs/evaluator.ts`: the parse loop, block statements, and matcher (module header; `createCbsEvaluator`,
  `CbsHost`, `CbsParseArg` `callStack`, `risuEscape`/`risuUnescape`, `isCbsPlainText`).
- `shared/cbs/limits.ts`: cooperative evaluation limits (module header; `CbsLimits`, `CbsLimitError`, `CbsLimitReason`,
  `DEFAULT_CBS_MAX_WORK`, `enterCbsParse`/`leaveCbsParse`, `spendCbsWork`, `replaceAllBound`). The hosts are the
  client's `CLIENT_CBS_LIMITS` (2 s per top-level parse) and the server's `serverCbsLimits` (5 s per template, 60 s per
  job, `server/src/jobs/cbsHost.ts`), both on `DEFAULT_CBS_MAX_WORK`, so a text within the tab's work budget is within
  the server transform's.
- `shared/cbs/calc.ts`: the `{{? ...}}` and trigger calculator (`calcString`, `CalcVariables`);
  `src/ts/process/infunctions.ts` binds it to the selected chat's variables.

### Client host and renderer

- `src/ts/parser/parser.svelte.ts`: the client host of the evaluator and the renderer (module header; `risuChatParser`,
  `risuChatParserScoped`, `risuChatParserForDisplay`, `CLIENT_CBS_LIMITS`, `ParseMarkdown`,
  `renderMarkdown`/`renderHighlightableMarkdown`, `trimMarkdown`, `trimMarkdownSharingStyles`, `parseMarkdownSafe`,
  `addMetadataToElement`; assets: `parseAdditionalAssets`, `assetRegex`, `resetAssetsCache`, `syncAssetsCache`,
  `getClosestMatch`, `getDistance`).
  - A parse that reaches its budget throws `CbsLimitError` to its caller; the server's `cbs` callback fails its request
    on purpose (`src/ts/process/request/transport.ts`). The places that show a result call `risuChatParserForDisplay`
    instead: `src/lib/ChatScreens/Chat.svelte` `displayPrePass` (also the copy of a streaming row),
    `src/lib/ChatScreens/BackgroundDom.svelte`, and the `src/lib/Others/PopupEditor.svelte` preview.
- `src/ts/parser/chatStyles.ts`: the chat screen's shared row stylesheets (module header; `ChatStyleRegistry`,
  `ChatStyle`, `setChatStyleRegistry`/`getChatStyleRegistry`); `src/lib/ChatScreens/ChatRowStyles.svelte` holds a row's
  uses by value, so an equal re-render keeps them. See [Shared styles](#shared-styles).
- `src/ts/parser/assetSearch.ts`: the bounded asset-name distance (`boundedDistance`) and
  `src/lib/ChatScreens/ChatBody.svelte`'s image prefix scan (`findAssetPrefix`).

### Inlays

`parseInlayAssets` in `src/ts/parser/parser.svelte.ts` expands the inlay tags inside `ParseMarkdown`; its comment has
the tags, the missing-file rule, and the `<source>` `type` rule. Images use `getFileSrc` ([assets](assets.md)). Audio
and video have two modes:

- Direct (`src/ts/globalApi.svelte.ts` `getDirectAssetSrc` answers a URL: worker use enabled, the `directAssets`
  capability, and a controlling worker at the call): `/api/asset/<hex(utf-8 key)>`, the URL `getFileSrc` gives, served
  with the `Content-Type` of `shared/assetMime.ts` `assetMimeType` (`audio/flac` and `video/x-matroska` included). No
  bytes are read; a missing file shows as the element's 404.
- Fallback (`getDirectAssetSrc` answers `null`): the typed object URL of `src/ts/process/files/inlays.ts`
  `getInlayObjectUrl`, kept for the page; its Blobs take their type from the same table (`application/octet-stream` for
  unknown media, `application/json` for signatures).
- HTML rendered before a page loses its controller keeps its direct URLs; later inlays take the fallback.

### Script transform client

- `src/ts/parser/transformClient.ts`: the client of the server script transform (`POST /api/transform`,
  [server generation](server-generation.md)), the only script stage of a render (module header; `captureTransform`,
  `CapturedTransform`, `serverProcessScript`, `rerenderMessage`, `resetTransformEffects`). The translator's `edittrans`
  regex is the one regex the tab still runs ([translation](translation.md)).
  - A capture's display ids are `chatDisplayIds` ([chat bindings](persistence.md)).
  - `src/lib/ChatScreens/ChatBody.svelte` `markParsing` captures once and passes the capture to `ParseMarkdown`,
    `translateHTML`, and its retries; `src/lib/ChatScreens/Chat.svelte` renders a row again once its chat's first save
    lands (`src/ts/storage/chatStore.svelte.ts` `chatSaveVersion`).
- `src/ts/parser/transformResults.ts`: the tab's bounded transform cache (module header; `getTransformResult`,
  `replaceTransformResult`, `confirmTransformResult`, `clearTransformResults`). See [Caches](#caches).
- `src/ts/parser/displayTransformRecovery.svelte.ts`: failed display transforms and their retry rounds (module header;
  `markDisplayTransformFailed`, `markDisplayTransformSucceeded`, `showDisplayTransformSource`,
  `displayTransformRetryRound`). See [Display transform failures](#display-transform-failures).
- `src/lib/ChatScreens/settledRender.svelte.ts`: [the mixed render refresh](#mixed-render-refresh).

### Variables

- `src/ts/parser/chatVar.svelte.ts`: the variable accessors (`getChatVar`/`setChatVar`, `getChatVarOf`/`setChatVarOf`,
  `getGlobalChatVar`/`getGlobalChatVarOf`, `globalToggleDefinitions`). Chat variables are `Chat.scriptstate` entries; a
  write [merges that one entry](chat-store.md#map-merges) (`mergeChatMeta`). A parse given `chatRef` (the send pipeline,
  triggers, Lua) reads and writes that chat; without it, the selected chat.
- `shared/prompt/toggles.ts`: toggle definitions and the global-value resolution (`parseToggleSyntax`, `valueToggles`,
  `toggleDefault`, `resolveGlobalChatVar`).
  - `globalToggleDefinitions` also supplies `src/ts/toggles/chatToggles.svelte.ts` `chatToggleDefinitions` for the
    sidebar and preset operations. The sidebar and `src/ts/toggles/togglePresets.svelte.ts` call `resolveGlobalChatVar`
    with one computed definitions text; `shared/togglePresets.ts` captures resolved values and compares/projects saved
    keys and kinds.
  - `setChatToggle` (`src/ts/toggles/chatToggles.svelte.ts`) writes only that loaded chat's `GLGlobalVariables` through
    `mergeChatMeta`, skipping unchanged stored values. Opening a chat never seeds values.

### Other parsers and editors

- `src/ts/parser/chatML.ts`: the ChatML splitter (`parseChatML`), used by `sendChat`'s `chatML` cards, the translator,
  and memory.
- `src/ts/parser/partialEdit.ts`: rendered text back to markdown ranges (module header;
  `findAllOriginalRangesFromText`/`FromHtml`, `replaceRange`, `EDITABLE_BLOCK_SELECTORS`).
- `src/ts/gui/highlight.ts`: editor highlighting and autocomplete (module header; `highlighter`, `removeHighlight`,
  `AllCBS`, and the hand-kept lists `normalCBS`, `normalCBSwithParams`, `displayRelatedCBS`, `nestedCBS`).
- `src/ts/gui/codearea/cbsMonaco.ts`: `registerCBSMonaco`, empty, so `src/lib/Others/MonacoEditor.svelte` has no CBS
  language support.
- `src/lib/ChatScreens/PartialEditController.svelte`: hover and drag-select editing of rendered messages (component
  contract); its `save` goes to `src/lib/ChatScreens/Chat.svelte` `handlePartialEditSave`, a translation edit to the
  `saveTranslation` prop ([translation](translation.md), the stored path).

## Flows

### Evaluation

- Callers of `risuChatParser` include `src/lib/ChatScreens/Chat.svelte`, `tokenizeAccurate`, `command.ts`, the HypaV3
  modal, the plugin API, the lorebook, and the playground; the server evaluates its own CBS with `shared/cbs/`. The
  scan, the matcher's name normalization, and a callback's result forms are the `shared/cbs/evaluator.ts` header.

### Display

1. `src/lib/ChatScreens/Chat.svelte` `displaya` runs the row's CBS pre-pass (`displayPrePass`:
   `risuChatParserForDisplay` with `rmVar` and `visualize`).
2. `src/lib/ChatScreens/ChatBody.svelte` `markParsing` captures the transform context and calls `ParseMarkdown` in
   `notrim` mode for the body (`pretranslate` for translation inputs); its steps are the `ParseMarkdown` comment. Only
   the `editdisplay` step leaves the browser: [Display transform](#display-transform).
3. `ChatBody`'s `shownBody` sanitizes the result (`addMetadataToElement(pruneEmptyBilingualPairs(trimMarkdown(...)))`).
   Under the chat screen (`DefaultChatScreen` provides a `ChatStyleRegistry`), a body that holds a `<style>` or
   `<risu-style>` goes through `trimMarkdownSharingStyles` instead: [Shared styles](#shared-styles).

### Display transform

- The batching, the skip of a locked (streaming) message, the provisional display and its correction, and the failure
  toast are the `src/ts/parser/transformClient.ts` header.
- The server (`server/src/prompt/transform.ts`) runs Lua `editDisplay`, the `display` trigger, CBS, and the regex
  scripts; the tab's `editdisplay` plugin handlers run read-only between its two calls ([Invariants](#invariants)).
- `ChatBody` shows provisional text on its stored and plain display paths; translation inputs and auto-translate probes
  wait for the answer.

### Display transform failures

- A failed `editdisplay` transform records a `notice` `transformFailed` diagnostics event. For a message with a captured
  id and current cache and Re-render generations, `transformClient.ts` registers it with
  `displayTransformRecovery.svelte.ts` unless it is permanent (the `transformClient.ts` header; the server's marks come
  from `server/src/prompt/transform.ts`: a text or loaded scope over a limit on its own).
- A permanent failure waits for a changed source or context, a later mount, or a Re-render.
- When a round runs and how its backoff grows and resets are the `src/ts/parser/displayTransformRecovery.svelte.ts`
  header.
- Each `Chat.svelte` row reports what it shows (`displaya`: the display text and the bilingual source side) through
  `showDisplayTransformSource`. A row showing another source (an edit or a saved edit from another tab, which mount a
  transcript row again, a stream, or a switch to or from the stored translation) drops the old failure.
- In a round, each mounted `Chat.svelte` row it names calls `rerenderMessage` and renders again.
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

- `trimMarkdownSharingStyles` and the `src/ts/parser/chatStyles.ts` header have the placeholder, ordering, and
  retained-sheet rules; `ChatBody` prunes bilingual pairs before the styles are taken out.
- Retained layer and scope sheets keep the first declaration order of layers and the parent of implicit scopes. Their
  order against a newer row's shared sheet can reverse, which matters only for conflicts the layer and scope-proximity
  steps do not already decide.
- The registry's hidden container sits at the end of `.default-chat-screen`, after the rows, greeting, `BackgroundDom`,
  suggestions, and plugin panels. Custom-GUI sheets in `Chat.svelte` stay at their row positions.
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
