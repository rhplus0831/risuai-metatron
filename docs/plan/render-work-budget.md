# Render Work Budget Plan

Status: drafted 2026-11-03, no slice landed. Decisions D1–D9 are recommendations for the owner; the
**Open questions** Q1–Q4 were answered by the owner on 2026-11-03 (the recommended option each time). Code
anchors were checked at `7e184d3c8`; verify them again before editing (STRUCTURE.md protocol step 5).

Sources: the owner's 2026-11-03 review of the
[rendering performance investigation](../research/rendering-performance-investigation.md) (inspected at
`6336e2954`), which agreed to one plan with four independent slices and a measurement slice and left the
streaming renderer and the mount scheduling for a later plan after profiling; that investigation's F2 (stylesheet
sharing comes after repeated CSS preparation: 30 preparations of a 500-rule sheet took 402.7 ms, of a 2,000-rule
sheet 1,665.8 ms), F4 (render generations protect display correctness but do not stop obsolete work; a thrown
error runs the pipeline four times), F7 (screenshot capture keeps every row canvas and resizes the merged canvas
once per source), its "Recommended implementation order", its probe appendix (the blank-page harness over
`util/playwright/stack.mjs` whose numbers are this plan's baseline), and for **Later** its F3 (full-prefix
rendering and fenced-block replacement: 1,600 separate fences took 138.3 ms against 13.7 ms in one fence) and F6
(staged opening is not continuous scheduling: 615 retained rows streamed at a 33.4 ms p95 frame interval); the
[archive](../archived-plan/README.md) entries for Heap Memory Reduction (C2 `7a986ac69`: one stylesheet per chat
style, the `ChatStyleRegistry`), the chat rendering series the investigation lists as its baseline (`2ed26dfee`
per-row streaming updates and distant-row containment, `bfdcfd508` the first screen before the rest of the
window, `52b0c6e52`, `fd0d71499`, `9489de1df`), Audit Findings and Performance Leftovers (3f: Firefox/Safari and
far-row containment unchecked), and the mount hold of `0aad24ce5` (rows added above the view held until the reader
stops scrolling, the UI guide's Limitation on scroll-animation jumps); the
[CBS and rendering guide](../structure/cbs-rendering.md) (Display, Display transform, Script transform client,
Shared styles, Caches, Invariants, Known Hazards), the [UI and theming guide](../structure/ui-theming.md) (Chat
screen, Transcript rows and the mount hold, Message row, Tests), the [media guide](../structure/media-aux.md)
(Translator, LLM translation, Stored translation, Flows), and the
[test harness guide](../structure/test-harness.md) (Browser stack, Measurement scripts, Test rules, Timeouts) at
`7e184d3c8`.

Owning guides when sliced: [CBS and rendering](../structure/cbs-rendering.md) (the render's lifetime signal
through `ParseMarkdown`, the transform client's subscribers and in-flight join, the CSS scope cache in Caches),
[UI and theming](../structure/ui-theming.md) (the row's render run and its abort, the screenshot's pages and
Blob export), [media](../structure/media-aux.md) (`translateHTML`'s signal, the global worker cap, the rendered
path's in-flight map), [chat store](../structure/chat-store.md) and [CBS and rendering](../structure/cbs-rendering.md)
for the three small items of Slice 0, [test harness](../structure/test-harness.md) (the measurement driver and
its CDP recipes).

Relation to other work: the chat rendering series and the stylesheet registry are done and stay as they are;
this plan does not re-propose far-row containment, the registry's keying and ordering, the mount hold, or the
scroll anchor. Display Evaluation (done) gave the tab's transform result cache, the provisional display and the
generation fences (`isCurrent`, `appliedEmotions`, the conditional replacement by entry version); this plan adds
cancellation beneath them and changes none of them (D7). The [Reroll Candidates plan](reroll-candidates.md)
Slice 2 edits `reroll` in `src/lib/ChatScreens/DefaultChatScreen.svelte`, the file of this plan's Slice 4
(`screenShot`): different functions, so a rebase, not a conflict, but not the same worktree at once. The
[Asset Lifecycle](asset-lifecycle.md) and [Job Handoff](job-handoff.md) plans share no file with this one.

## Goal

The chat screen stops doing work nobody will see, shares the work several rows ask for, and bounds the memory of
its one large export:

- **Obsolete render work stops.** A render run that is superseded (the row's text, character, revision or
  translation state changed) or whose row unmounts is aborted: no further parser, transform, translation or
  retry work runs for it, instead of running to completion with its result hidden.
- **Failures are classified.** A deterministic parser error renders once and alerts once; a transient I/O
  failure retries a bounded number of times, after a delay, only while the run is still live. The immediate
  four-attempt retry is retired.
- **Shared requests are cancelled only when their last subscriber leaves.** A transform batch target or a
  rendered translation two rows wait for is one request; one row's abort leaves it running for the other, and a
  late answer still reaches the rows that still wait.
- **Repeated CSS preparation is cached.** The parse, scope and stringify of identical post-CBS CSS runs once per
  distinct text within a bounded cache; thirty rows with one sheet prepare it once and still share one live
  stylesheet.
- **The screenshot export's transient memory is bounded.** The output canvas is sized once, each source canvas
  is released after it is drawn, large exports split into pages, and the PNG goes to the download as a Blob.

Not goals: an incremental streaming renderer, a time-budgeted mount queue, a moving retained window, cross-browser
measurements, any change to CBS semantics, to DOMPurify's configuration or hooks, or to the cascade order of
shared styles.

## Current state

The baseline is `7e184d3c8` on `dev` (2026-11-03). The investigation's line numbers are from `6336e2954`; the
anchors below are by identifier.

- **A render run has a generation but no lifetime.** `src/lib/ChatScreens/ChatBody.svelte` starts a run in the
  `$derived.by` of `markParsingResult` with `markParsing(msgDisplay, character, idx, renderRevision, ++parseRun)`.
  Inside `markParsing`, `run !== parseRun` and `destroyed` (set by `onDestroy`) guard the writes of `lastParsed`
  and `lastRenderedRevision` in the `finally`, the spinner (`LOADING_HTML`), `reportMixed`, and the provisional
  callback (`enableProvisional`). Nothing else is guarded: `ParseMarkdown`, `translateHTML`, `getLLMCache` and
  the transform all run to completion for a superseded or unmounted row, and no `AbortSignal` exists anywhere on
  the path. The `catch` calls `markParsing` again at once with `tries` 1, 2 and 3 (the same `run`, the same
  capture, the same stored-path state), alerting only when `tries > 2`: a consistently thrown error runs the
  pipeline four times, for a run that may already be obsolete. The existing test
  `src/lib/ChatScreens/ChatBody.svelte.test.ts` "keeps the newest render's body when an older render settles
  later" proves the hiding, not a stop; "alerts a clean parse error and preserves the original stack after
  retries fail" relies on the fourth attempt's alert.
- **The auto-translate probe parses twice.** With `autoTranslateCachedOnly` and the LLM translator, the run
  derives the cache key with `getLLMCache(await ParseMarkdown(data, charArg, "pretranslate", ...))` (or the
  `notrim` parse on the legacy path), then flips `translated` through a 10 ms `setTimeout` (`translationUpdate`,
  awaited by `whenRendered` as `pendingAutoTranslate`), and the state change starts a second run that parses
  again.
- **The pending body is prepared again.** `shownBody(source)` runs `trimMarkdown` or
  `trimMarkdownSharingStyles` (DOMPurify, the style restore, the bilingual prune, `addMetadataToElement`) for
  whatever the `{#await markParsingResult}` block renders: `lastParsed` in the pending branch and `md` in the
  `:then` branch. A render pending across a paint prepares the previous body once more, and the comment in the
  `finally` ("since trimMarkdown is fast, we don't need to cache it") does not hold for CSS-heavy content.
- **`ParseMarkdown` has four awaits and no signal.** In `src/ts/parser/parser.svelte.ts`,
  `ParseMarkdown(data, char, mode, chatID, cbsConditions, capturedTransform?)` runs `parseAdditionalAssets`,
  `serverProcessScript` (`editdisplay`, when a capture exists), the assets again, `parseInlayAssets`, the
  thoughts and tools, `encodeStyle`, `renderHighlightableMarkdown`, then `trimMarkdown` unless `notrim`. The
  guide's Display section has the order.
- **Transform batches deduplicate within a frame and never cancel for a row.** `src/ts/parser/transformClient.ts`
  `serverProcessScript` joins a `Batch` (keyed by mode, captured context, plugin context, handler set and
  client) and shares identical `inputs` through `batch.shared` as one `Operation` with one `answer` promise;
  `schedule` flushes on the next frame or a 16 ms timer: `batches.clear()`, then `sendBatch` splits by
  `MAX_TRANSFORM_TARGETS` and `MAX_TRANSFORM_REQUEST_TEXT_BYTES` and `sendChunk` posts under `CHUNK_DEADLINE_MS`
  with `AbortSignal.timeout`. Once dispatched, a batch cannot be joined and no target can be withdrawn; the
  completion applies the answer through the `isCurrent` fences (cache generation and Re-render generation, which
  do not change on unmount, so an unmounted row's answer still warms the tab cache).
- **Rendered translation has per-call workers and no in-flight map.** `src/ts/translator/translator.ts`
  `translateHTML(html, reverse, charArg, chatID, regenerate, capturedTransform?)` takes no signal. Its LLM path
  calls `translateLLM(text, context, regenerate, failure?, signal?)`, which already accepts a signal and checks
  it between steps, without passing one. Its non-LLM path runs `translateJobs` with `Math.min(10, jobs.length)`
  workers per invocation (DeepLX: sequential `■` batches), each `translate` writing the memory pair cache;
  `translate(text, reverse)` and the display-script step per job (`serverProcessScript` with kind
  `translation`) take no signal. `runTranslator` accepts `exarg.signal`. The stored path
  (`src/ts/translator/storedTranslation.svelte.ts` `requestStoredTranslation`) keeps `inFlight` per message key
  and joins a running request; the rendered path reads `readLLMCacheEntry` and otherwise requests.
- **Every row scopes its CSS itself.** `restoreStyles` calls `decodeStyleContent(hex)` per `<risu-style>`: hex
  decode, `risuChatParser(text)` (the selected chat's variables), `css.parse`, `decodeStyleRule` per rule (a
  `postcss-selector-parser` run per selector adding `.chattext ` and the `x-risu-` class prefix, nested at-rules,
  `data:` imports neutralized), `css.stringify` compressed; a parse error gives the fallback text (the error
  prefixed `CSS ERROR:` under `settings.ui.returnCSSError`, else empty). `trimMarkdownSharingStyles` sanitizes,
  restores, runs `prepare`, and extracts each shareable `<style>` as a `ChatStyle { css, attributes }`;
  `src/ts/parser/chatStyles.ts` `ChatStyleRegistry.acquire` keys by `JSON.stringify([css, attributes])`, so
  equal final CSS is one sheet, after each row has done the work.
- **The screenshot keeps everything until the end.** `src/lib/ChatScreens/DefaultChatScreen.svelte`
  `screenShot` sets `loadPages = Infinity`, awaits `whenRendered` of the rows and the greeting, captures each
  `.risu-chat` with `html-to-image`'s `toCanvas` inside `withFileSrcFetch` into a `canvases` array, reverses it,
  assigns `mergedCanvas.width` and `height` inside the summing loop (each assignment reallocates and clears the
  canvas), fills and draws, calls `canvas.remove()` on canvases that were never in the document (no release of
  their backing stores), then `toDataURL("png")`, `Buffer.from(base64)` and `downloadFile`, which makes a `Blob`
  and an object URL: the PNG bytes exist as a data URL string, a Buffer and a Blob at once. The `finally`
  restores `loadPages` and the scroll offset when `chatKey === capturedChat` and clears `takingScreenshot`.
  `src/ts/globalApi.svelte.ts` `downloadFile(name, dat: Uint8Array | ArrayBuffer | string)` takes no Blob.
- **Tests and drivers.** `ChatBody.svelte.test.ts` mocks `ParseMarkdown` as a list of deferred parses
  (`hoisted.parses`) and settles them by text; `ChatBody.styles.svelte.test.ts` runs the real parser under a
  `ChatStyleRegistry` (`src/lib/ChatScreens/tests/ChatStyleProviderFixture.svelte`);
  `src/ts/parser/tests/transformClient.test.ts` has the server as a function of the request and fake timers;
  `src/ts/parser/tests/{chatStyles,trimMarkdownSharingStyles}.test.ts` cover the registry and the extraction;
  `src/ts/translator/translatorLLM.test.ts` covers `translateLLM`'s steps and cache. No test reaches
  `screenShot` (`DefaultChatScreen.drafts.test.ts` mounts the screen for the composer;
  `src/ts/screenshotCaptureCache.test.ts` covers the capture options). `util/playwright/measureChats.mjs`
  measures the production build at up to 600 rows (with the settling and wheel-input issues the investigation
  records); `measureHeap.mjs` and `measureFileSources.mjs` have the CDP heap recipes; `stack.mjs` has
  `startStack` and `isolateContext`. `e2e/openChat.spec.ts` covers the chat open, `e2e/perChatSends.spec.ts`
  the sends of two chats and Stop, `e2e/serverTransform.spec.ts` the row render lifecycle (the final render
  once, existing rows untouched), `e2e/transformGolden.spec.ts` the final browser HTML against the baseline
  fixture.

## Decisions

- **D1. One `AbortSignal` per render run of a row.** `ChatBody.svelte` keeps an `AbortController` beside
  `parseRun`: the `$derived.by` that starts a run aborts the previous controller and makes a new one (the same
  place that already does `++parseRun`), and `onDestroy` aborts the current one. The signal travels as a trailing
  optional `signal?: AbortSignal` parameter of `markParsing`, `ParseMarkdown`, `translateHTML`,
  `serverProcessScript` and the translator's `translate`, the platform type `runTranslator`, `translateLLM` and
  `requestChatData` already take (as the Static Audit's image and TTS signals did). It is checked with
  `signal.throwIfAborted()` at the start of each stage and after every await: in `markParsing` before the
  cached-only probe, before and after each `ParseMarkdown` and `translateHTML`, and before a retry; in
  `ParseMarkdown` before each asset pass, before the transform, before the inlays, before Markdown and before the
  sanitizer; in `translateHTML` before dispatch, in each worker before it takes a job, before each job's
  display-script step and before serialization. An abort surfaces as the `AbortError` `DOMException`
  `throwIfAborted` throws; `markParsing`'s `catch` recognizes it (`signal.aborted`) and resolves quietly with
  what it had (`lastParsedQueue`), with no alert, no retry and no `lastParsed` write (the existing `finally`
  guard already skips it), so `whenRendered`'s loop, `settleFirstStageRow` and `checkImg` see a settled promise
  as today. The retries keep the run's signal (they keep its `run` and capture already). The 10 ms `translated`
  flip stays as it is: it is state the next run reads, and `whenRendered` awaits it. Rejected: a module-level
  "current run" per message (a greeting or bookmark preview has no message id, and a row can have two runs alive
  for a moment); carrying the signal inside `CapturedTransform` (it is null without a server context, and the
  capture describes the server's inputs, shared by retries by design).
- **D2. Failure classification: deterministic errors never retry, transient I/O errors retry twice with a
  delay while live.** A new `src/ts/parser/renderErrors.ts` holds `markTransient(error)` and
  `isTransient(error)`, a `WeakSet` by error identity as `transformClient.ts` does with `epochRefusals` and
  `permanentRefusals`. The I/O boundaries the render pipeline reaches mark their own failures: the translator's
  provider request (`runTranslator` around its provider call: a rejected `fetch`, a non-2xx answer it throws),
  the highlight language loader if its dynamic import rejects, and the LLM translate cache's storage read
  (`readLLMCacheEntry`). Everything unmarked is deterministic: `CbsLimitError`, Markdown, KaTeX and CSS errors,
  a `TypeError` in the pipeline, an unknown provider error. `markParsing`'s `catch`: an abort returns quietly
  (D1); a deterministic error alerts once with the wrapped message and the original stack (as the fourth attempt
  does today) and returns `data`; a transient error waits 250 ms, then 1,000 ms, under the run's signal (a
  `setTimeout` raced with the signal's `abort` event, in a small helper beside `sleep` in `src/ts/util.ts`), and
  retries at most twice; a third failure alerts as a deterministic one. The default errs toward fewer runs: a
  transient error left unmarked costs one failed render that the next edit, remount or Re-render repairs, while a
  deterministic error marked transient costs two more runs of a reproducible failure. The transform's own
  failures stay out of this: `serverProcessScript` answers the text as it came in and the display-transform
  recovery rounds retry it. Rejected: classifying by message or type (`TypeError: Failed to fetch` is
  browser-specific, and a `TypeError` is also what a parser bug throws); retrying everything after a delay (keeps
  the four-fold work for the reproducible case); no retry at all (Q1).
- **D3. Transform batches count subscribers; the request is cancelled only when the last one leaves.** In
  `transformClient.ts`, each `serverProcessScript` call that passes a signal is a subscriber of its `Operation`;
  its abort unsubscribes. A caller without a signal (a plugin, the greeting, `translateHTML`'s per-job step until
  Slice 2 passes one) is a subscriber for the operation's lifetime, so nothing changes for it. When an
  operation's count reaches zero: not yet dispatched (its batch still in `batches`), the target leaves
  `batch.pending` and `batch.shared` and is never sent; dispatched, nothing happens unless every operation of
  its chunk has zero subscribers, in which case the chunk's `AbortController` (combined with the deadline
  through `AbortSignal.any`) aborts the `fetch`, the plugin handlers of that chunk do not run, and the second
  call is not made (the server's snapshot expires with `TRANSFORM_SNAPSHOT_TTL_MS`). An answer that arrives after
  one subscriber left reaches the subscribers that remain; the unsubscribed caller's promise resolves with its
  input text and its `ParseMarkdown` ends on the next `throwIfAborted`. Dispatched operations also stay in an
  in-flight map by `inputs` until they settle, so a new subscriber with identical inputs (a row unmounted and
  mounted again, a chat switched away and back) joins the running request instead of sending again; `inputs`
  already includes the cache generation, the Re-render generation and `knownKey`, so the join is exact. The
  completion's fences stay (D7). Rejected: cancelling a caller's own target (two rows sharing one operation is
  the case this decision exists for); never cancelling a dispatched request (a screenshot or a global reload
  after a switch keeps the server's four active slots and its queue busy for rows nobody shows: the burst F6 and
  F7 describe); a grace period before the abort (Q4 covers the trade-off it would approximate).
- **D4. Rendered translation gets a global worker cap and a per-key in-flight map.** `translateHTML`'s non-LLM
  workers draw from a module-level semaphore of `MAX_TRANSLATION_WORKERS = 10` across every call, instead of ten
  per call; a worker checks its caller's signal before taking a job, an aborted call releases its slots and
  skips its remaining jobs, and a job already requested still writes the memory pair cache when it answers, so
  the next render of that text is a hit. The LLM path keeps an in-flight map keyed by the LLM cache key
  (`llmCacheKeyPrefix(context) + html`, what the cache is keyed by): a second rendered call with the same key
  awaits the same `translateLLM` promise, whose own `signal` is a shared controller aborted only when every
  awaiting caller has aborted; the result is written to the cache once. The key is the cache key rather than a
  message id because `translateHTML` has no message identity (its `chatID` is an index, never an address after
  an await) and identical texts in two messages should be one request. Duplicate provider billing was not
  reproduced by the investigation; this map is a bound, and Slice 5 counts `translateLLM` calls per key before
  and after. The stored path's `inFlight` map is unchanged. Rejected: a per-message map on the rendered path (no
  identity at the call); a global cap on LLM steps (`requestChatData`'s own queueing is the LLM request guide's
  concern).
- **D5. The CSS scope cache is keyed by the post-CBS CSS text, bounded, and never by the raw style.**
  `decodeStyleContent` splits into the uncached part (hex decode, `risuChatParser`) and `scopeCss(text)`: the
  `css.parse`, `decodeStyleRule` and `css.stringify` stage, cached in a module-level map of `parser.svelte.ts`
  keyed by the exact string handed to `css.parse`, valued with the stringified scoped CSS. A parse error is not
  cached, and its fallback text reads `settings.ui.returnCSSError` at the time, as today. The key holds no mode
  flag at `7e184d3c8` because none reaches the cached stage: `.chattext` and `x-risu-` are constants, safe mode
  acts in `Chat.svelte` (`SafeModeStore`, the custom HTML theme), and the sanitizer runs outside it; the rule for
  a later flag is that anything `decodeStyleRule` or the stringify reads joins the key. Bound: 256 entries and 4
  MiB of key plus value UTF-16 code units, evicted oldest first by last use in the insertion-order `Map` with a
  byte counter that `src/ts/parser/transformResults.ts` uses (one shape in the parser directory;
  `mnemonist`'s `LRUMap` of `tokenizer.ts` has no byte bound). Acceptance: identical content still shares one
  live sheet, which holds without a registry change because `ChatStyleRegistry` keys by the final `css` value the
  cache returns unchanged; the test counts one `css.parse` and one sheet for thirty rows. The pending body is
  retained too: `shownBody` memoizes its last `{ source, result }` by string identity (the `{#await}` block
  alternates between at most two strings), so a render pending across paints prepares `lastParsed` once; this
  memo lives in `ChatBody.svelte` and lands with Slice 1, which owns that file. Rejected: caching by the raw
  `<risu-style>` hex (CBS variables change its meaning); caching the sanitized DOM tree (`RETURN_DOM` gives a
  live tree the template consumes, and cloning it costs what it saves); a cache inside the registry (it sees only
  final CSS, after the work).
- **D6. The screenshot sizes its output once, releases each source, exports a Blob, and pages large exports.**
  The merge moves into a new pure module `src/lib/ChatScreens/screenshotExport.ts` with injected capture and
  canvas factories (so a test counts with fake canvases; happy-dom has no 2D context): `planScreenshotPages`
  measures each row with the rule `html-to-image` uses for its canvas (`getImageSize` from the library's `util`
  module if the installed version exports it, else `clientWidth` plus border widths times the pixel ratio),
  sums the heights and the maximum width, and splits whole rows into pages so that no page exceeds
  `MAX_EXPORT_PIXELS = 64_000_000` (256 MiB of RGBA) or 16,384 px on a side (Safari's canvas limit, under
  Chrome's); `composeScreenshot` then, per page, sizes the page canvas once, captures one row at a time with
  `toCanvas` inside `withFileSrcFetch`, draws it, and releases it (`width = 0`, `height = 0`: the way a canvas's
  backing store is freed; `remove()` did nothing for a detached canvas), so one source canvas is alive at a
  time; a capture that still differs from its measured slot is drawn clipped to the slot with a console warning.
  Each page goes out through `canvas.toBlob("image/png")` and a `downloadFile` that accepts a `Blob` and passes
  it to `URL.createObjectURL` without the data URL string and the Buffer copy; the names are `chat-<uuid>.png`
  for one page and `chat-<uuid>-<n>of<m>.png` for several. `screenShot` keeps `loadPages = Infinity`, the
  `whenRendered` waits, the `alertWait` progress per row, the `finally` restoration of the window and the scroll
  offset, and `takingScreenshot`. Whether a "selected range" export is a UI feature of this plan is Q2.
  Rejected: capturing every row to a PNG Blob first and decoding one at a time (sizes from the PNG headers; it
  retains the compressed bytes of every row and decodes each twice); `OffscreenCanvas` in a worker
  (`html-to-image` needs the DOM, and the merge is the cheap part); JPEG or WebP output (a format change users
  would notice).
- **D7. What stays unchanged.** The `run === parseRun` and `destroyed` guards of `ChatBody.svelte`, the
  `display.replaced` and `reportMixed` logic, the `isCurrent` fences and `appliedEmotions` of
  `transformClient.ts`, the tab cache's conditional replacement by version, the display-transform recovery
  rounds, the `ChatStyleRegistry`'s keying, ordering and microtask reconcile, and `whenRendered`'s loop. An
  aborted operation can still settle (an answer already on the wire when the abort arrives), so the stale-display
  and stale-transform-effect guards remain the correctness layer; cancellation only removes work.
- **D8. Slice 0 is included.** The investigation's three one-screen items are not in
  `docs/research/found-issues.md` (only F8 is recorded, as the `removeHighlight` Issue of the CBS and rendering
  guide), so leaving them means re-finding them. They land as one commit with a count test each, before or
  beside the other slices: F1 as a validated last-position memo in `src/ts/storage/chatStore.svelte.ts`
  (`applyServerGeneration` and `showStreamText` remember the index of the message they last addressed per held
  chat and use it only when `message[index]?.chatId` still matches, else `find` and remember again: no retained
  index is ever trusted, which keeps the chat store's by-id rule); F5 in
  `src/lib/ChatScreens/PartialEditController.svelte` (the early return compares against `"flex"`, the display it
  sets, and `hasTextContent`'s clone runs once per hovered block, remembered until the block or its content
  changes); F8 in `src/ts/gui/highlight.ts` (`highlighter` deletes the owned categories absent from
  `formatedRanges`, `removeHighlight` clears the registry entries of that id, and a delayed highlight callback
  after `TextAreaInput.svelte`'s destroy does nothing). The full per-chat message index the investigation also
  names is not taken: every write path of the chat store would have to maintain it. Q3 kept Slice 0 in the plan;
  had it been declined, the three would have moved to `found-issues.md` under one heading.
- **D9. Measurement is a driver beside the existing ones, and its numbers live in an audit document.**
  `util/playwright/measureRenderWork.mjs` starts the dev stack with `startStack` (the dev modules keep their
  function names, which the counts below need) and seeds one character whose rows repeat a 500-rule sheet, hold
  many fences, and auto-translate against a local mock provider; at 30, 150 and 600 mounted rows it records
  obsolete-work counts (open the chat, switch away 100 ms later, count the `ParseMarkdown`, `decodeStyleContent`
  and `translateLLM` invocations and the `/api/transform` targets that still ran after the switch), CSS
  preparations per identical sheet, and the screenshot's peak memory; it also records the 30/150/600 mount
  profile F3 and F6 need (long tasks and frame gaps from a `Tracing` capture, first-visible and settled times
  apart). Function counts come from CDP `Profiler.startPreciseCoverage` with `callCount` and
  `takePreciseCoverage` (per-function call counts by name and source range); request and target counts from the
  page's request events; peak memory from the renderer process's `VmHWM` in `/proc/<pid>/status` (the pid from
  CDP `SystemInfo.getProcessInfo`), in a fresh page per screenshot scenario so the peak is that scenario's,
  with the JS heap after `HeapProfiler.collectGarbage` beside it (canvas backing stores are not JS heap). It is
  Linux-only and not in the gate. Its output goes to `docs/audit/render-work-budget-<date>.md` as the doc rules
  require (a measurement never lives in a guide); the baseline run precedes Slices 1–4 and the comparison follows
  them. Rejected: a production-build driver like `measureChats.mjs` (minified names defeat the counts; the
  production frame numbers stay that driver's); spies installed through `await import("/src/...")` (ES module
  bindings cannot be reassigned); `performance.measureUserAgentSpecificMemory` (needs cross-origin isolation the
  dev stack does not serve).

## Open questions

All four were answered on 2026-11-03 with the recommended option; they are kept here as the record of why.

- **Q1. Retry policy.** Recommended: D2's bounded transient retry (two retries, 250 ms then 1,000 ms, only
  while the run is live, only for marked I/O failures). Alternative: no retry in `markParsing` at all; a
  provider failure during auto-translate then leaves the row untranslated until its next render, and the
  translator's own alert is the only notice.
- **Q2. A selected-range export.** Recommended: no UI change in this plan; D6's pages bound the memory, and a
  long chat exports as several files. Alternative: a range picker (from message to message) on the screenshot
  menu entry, which is a composer and menu change in `DefaultChatScreen.svelte` and a string in `src/lang/en.ts`,
  added to Slice 4.
- **Q3. Slice 0.** Recommended: include it (D8). Alternative: leave the three items out and move them to
  `docs/research/found-issues.md` in the first slice's commit.
- **Q4. Cancel dispatched transform requests, or let them finish.** Recommended: D3 as written, cancel when
  the chunk's last subscriber leaves, which bounds the server's queue occupancy in the burst cases. Alternative:
  withdraw only never-dispatched targets and let a dispatched request finish, because its answer still warms
  the server transform cache and the tab result cache (the completion's fences are by generation, not by mount),
  so a chat switched away and back shows the provisional text at once; D3's in-flight join covers the return
  while the request still runs, the alternative covers the return after it answered.

## Slices

Slices 1, 3 and 4 touch disjoint files except `src/ts/parser/parser.svelte.ts`, which Slice 1 edits in
`ParseMarkdown` (the signal) and Slice 3 in `decodeStyleContent` (the cache): a textual rebase, no shared logic.
Slices 1, 3 and 4 may run in parallel worktrees; Slice 2 needs Slice 1's signal; Slice 5's baseline run comes
first and its comparison last. Each slice lands alone with the gates in **Verification** and updates the guides
it changes (T5: no slice labels in code, comments or test titles).

### Slice 0: the three small items (D8; needs nothing)

Files: `src/ts/storage/chatStore.svelte.ts` (`applyServerGeneration`, `showStreamText`),
`src/lib/ChatScreens/PartialEditController.svelte` (the hover guard, `hasTextContent`), `src/ts/gui/highlight.ts`
(`highlighter`, `removeHighlight`), `src/lib/UI/GUI/TextAreaInput.svelte` (the delayed callback after destroy),
the chat store guide (Job hydration: the validated memo), the CBS and rendering guide (the `removeHighlight`
Issue deleted).

- Tests (`src/ts/storage/tests/chatStore.test.ts` or the file there that already drives
  `applyServerGeneration`, `src/lib/ChatScreens/PartialEditController.test.ts`, a new
  `src/ts/gui/highlight.test.ts` under happy-dom with a `CSS.highlights` stand-in): 200 updates to the tail of a
  2,000-message chat visit one message each after the first (the memo), a chat replacement between updates
  falls back to the search once, and updates buffered before the frame take the same path; ten mousemoves over
  one block clone it once and read its rectangle once, and the buttons end displayed `flex`; highlighting
  `{{user}}` then plain text leaves no `cbsnest` category in the registry, `removeHighlight` empties the
  registry of that id, and a callback after destroy adds nothing.

### Slice 1: the render lifetime and failure classification (D1, D2, D5's pending-body memo, D7; needs nothing)

Files: `src/lib/ChatScreens/ChatBody.svelte` (the controller beside `parseRun`, the signal through
`markParsing`, the `catch` with the three outcomes, the `shownBody` memo), new `src/ts/parser/renderErrors.ts`,
`src/ts/parser/parser.svelte.ts` (`ParseMarkdown`'s `signal` and its checks; the highlight loader marks its
import failure), `src/ts/translator/translator.ts` (`translateHTML`'s `signal` and its checks, passed on to
`translateLLM` and `runTranslator`; `runTranslator` and `readLLMCacheEntry` mark their I/O failures),
`src/ts/util.ts` (the abortable delay), `src/ts/parser/transformClient.ts` (`serverProcessScript` accepts the
signal and checks it on entry; the accounting is Slice 2), the UI and theming guide (Message row: the run's
controller, the three outcomes of a failure), the CBS and rendering guide (Display: the signal's checkpoints;
Invariants: an abort never skips the guards), the media guide (Translator: `translateHTML`'s signal).

- Tests (`src/lib/ChatScreens/ChatBody.svelte.test.ts`, a new `src/ts/parser/tests/parseMarkdownLifetime.test.ts`,
  a new `src/ts/translator/translateHtmlLifetime.test.ts`): on the translated path, a run superseded while its
  `pretranslate` parse is pending makes no `translateHTML` call and no further `ParseMarkdown` call once that
  parse settles (counts 0 for the old text), and the newest render's body still wins; a run whose row unmounts
  mid-parse makes no further call; a deterministic error calls `ParseMarkdown` once and `alertError` once with
  the original stack (the existing case, renamed and tightened from four calls to one); a marked transient error
  retries after 250 ms and again after 1,000 ms under fake timers, and a supersede during the first delay makes
  no second call; a cached-only probe whose run is superseded before `getLLMCache` answers starts no second
  parse; `shownBody` prepares a pending `lastParsed` once across two template re-renders (one `trimMarkdown`
  call); `ParseMarkdown` with a signal aborted after the first asset pass calls `serverProcessScript` zero
  times; `translateHTML` with an aborted signal calls `translate` zero times and with a signal aborted after the
  first job takes no further job.

### Slice 2: subscriber accounting for shared requests (D3, D4; needs 1)

Files: `src/ts/parser/transformClient.ts` (subscribers per `Operation`, withdrawal before dispatch, the chunk
controller and `AbortSignal.any`, the in-flight map by `inputs`), `src/ts/translator/translator.ts` (the worker
semaphore, the LLM in-flight map and its shared controller, the signal through the per-job display-script
step), the CBS and rendering guide (Script transform client: subscribers, withdrawal, the join; Known Hazards:
the "later render does not join a dispatched batch" fact replaced), the media guide (Translator: the global cap
and the map; State: the map beside the caches).

- Tests (`src/ts/parser/tests/transformClient.test.ts`, `src/ts/translator/translatorLLM.test.ts`, a new
  `src/ts/translator/translateHtmlWorkers.test.ts`): two rows awaiting one operation make one request, and when
  one row aborts the request is kept and its answer reaches the other; both aborting before the frame make no
  request; both aborting after dispatch abort the `fetch`'s signal and make no second call; a late answer after
  one abort reaches the remaining subscriber and the aborted caller's promise has resolved with its input; a
  third render with identical inputs during the flight joins it (one request); a caller without a signal keeps
  the request alive; two rendered LLM translations of one key make one `requestChatData` and one cache write,
  one abort keeps it, two abort it; three `translateHTML` calls of twenty jobs each hold at most ten `translate`
  calls open at once (a deferred provider, the count read at the peak), and an aborted call's remaining jobs are
  never requested while its answered ones are cached.

### Slice 3: the CSS scope cache (D5; needs nothing)

Files: `src/ts/parser/parser.svelte.ts` (`scopeCss` and its bounded map, `decodeStyleContent` split),
`src/ts/parser/chatStyles.ts` (read, not changed: the acceptance asserts through the registry's container), the
CBS and rendering guide (Caches: the scope cache's key and bounds beside the parser caches; Shared styles: the
sentence that each row no longer scopes its CSS itself).

- Tests (`src/ts/parser/tests/trimMarkdownSharingStyles.test.ts`, `src/lib/ChatScreens/ChatBody.styles.svelte.test.ts`,
  `src/ts/parser/tests/trimMarkdownStyle.test.ts`): thirty rows of one `<style>` call `css.parse` once (a spy on
  the `@adobe/css-tools` import) and the provider holds one sheet; two rows whose raw style is equal but whose
  CBS output differs (a variable set between them) are two preparations and two sheets; a sheet over the byte
  bound is prepared and not retained; the 257th distinct sheet evicts the oldest; a CSS parse error is not
  cached and its fallback follows `returnCSSError`; the scoped output of the golden style cases is byte-equal
  before and after (the existing expectations of `trimMarkdownStyle.test.ts` unchanged).

### Slice 4: the screenshot export (D6; needs nothing)

Files: new `src/lib/ChatScreens/screenshotExport.ts` (`planScreenshotPages`, `composeScreenshot`),
`src/lib/ChatScreens/DefaultChatScreen.svelte` (`screenShot` over the module), `src/ts/globalApi.svelte.ts`
(`downloadFile` takes a `Blob`), `src/lang/en.ts` and `ko.ts` if the progress text changes, the UI and theming
guide (Chat screen: the pages and the Blob export; Tests: the module's test), the global API guide
(`downloadFile`'s Blob).

- Tests (a new `src/lib/ChatScreens/screenshotExport.test.ts` with fake canvases that count `width` and `height`
  assignments and `drawImage` calls, a stubbed `URL.createObjectURL` for the download): N rows produce one output
  resize per page and N source releases, each release after its draw; rows are split into pages at the pixel
  budget and the side limit with no row split across pages; a capture taller than its slot is clipped and
  warned once; the download receives one Blob per page with the `<n>of<m>` names; a capture that throws leaves
  the window and scroll restoration to the caller's `finally` (the caller's test: `screenShot`'s `finally` path
  through a thrown capture in `DefaultChatScreen.drafts.test.ts`'s mounted screen, if that file's fixtures reach
  it, else noted as a browser check).

### Slice 5: the measurement driver (D9; the baseline before Slices 1–4, the comparison after)

Files: new `util/playwright/measureRenderWork.mjs`, new `docs/audit/render-work-budget-<date>.md` (the baseline
table, then the after table), the test harness guide (Measurement scripts: the driver, the precise-coverage
count recipe and the `VmHWM` peak recipe), `util/agentE2e.mjs` untouched (the driver is not a spec).

- What it records, at 30, 150 and 600 rich rows: parser, style-decode and `translateLLM` invocations and
  transform targets that ran after a switch away (the obsolete-work count), preparations per identical sheet,
  sheets in the registry, the screenshot's `VmHWM` delta and post-collection JS heap and the count of its pages,
  the mount profile (long tasks, frame gaps, first-visible and settled times) from a `Tracing` capture saved
  beside the audit document for F3 and F6. The acceptance after Slices 1–4: zero obsolete parser and translation
  invocations after a switch (transform targets: zero sent after the switch, in-flight ones at most one chunk),
  one preparation per distinct sheet, a screenshot peak under one page's RGBA plus the largest row.

### Slice 6: the guide pass (needs 1–5)

Files: a final pass over the four guides and the chat store guide for the sections the slices touched, the
`Tests` sections naming the new files and the driver, the CBS and rendering guide's Known Hazards without the
`removeHighlight` Issue, `docs/research/rendering-performance-investigation.md` left as history with one line
at its top pointing at the audit document.

## Recommended order

5 (baseline) → 0 → 1 → 2, with 3 and 4 in parallel worktrees beside 1 → 5 (comparison) → 6. Slice 1 alone
removes the four-fold retry and the obsolete parses; 2 needs its signal; 3 and 4 depend on nothing and can land
first if the baseline run shows the CSS or screenshot numbers to be the worst.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for every changed signature (`ParseMarkdown`,
  `translateHTML`, `serverProcessScript`, `translate`, `downloadFile`: `rg` their callers across `src`, `e2e`,
  `util` and `docs`), V6 for every new test (shown to fail with the guarded line broken; the count assertions
  make this one-line breaks).
- Counts, not time: every test above asserts a number of calls, requests, sheets, resizes or releases, under
  fake timers or deferred answers (V3 and the Timing-Dependent Tests archive entry); the only durations are the
  driver's, in the audit document.
- Focused: `pnpm --silent test:agent src/lib/ChatScreens/ChatBody.svelte.test.ts
src/lib/ChatScreens/ChatBody.styles.svelte.test.ts src/ts/parser/tests src/ts/translator` for Slices 1–3;
  `pnpm --silent test:agent src/lib/ChatScreens/screenshotExport.test.ts src/ts/screenshotCaptureCache.test.ts`
  for Slice 4; `pnpm --silent test:agent src/ts/storage/tests/chatStore.test.ts
src/lib/ChatScreens/PartialEditController.test.ts src/ts/gui/highlight.test.ts` for Slice 0 (file names as the
  slices create them).
- `e2e`, one run at a time: `e2e/openChat.spec.ts` and `e2e/perChatSends.spec.ts` after Slices 1 and 2 (the
  chat open and the sends of two chats render through the signal), `e2e/serverTransform.spec.ts` after Slice 2
  (the final render once, existing rows untouched, under the subscriber accounting), `e2e/transformGolden.spec.ts`
  after Slice 3 (the final browser HTML against the baseline fixture proves the cache changes no output).
- The driver (Slice 5) runs under `util/playwright/offline.sh` on a Linux host with no other dev stack of the
  checkout; its numbers are reported with the run, never as a gate.
- Not covered by any gate, the owner's device checklist: Firefox and Safari (the screenshot's page size at
  Safari's canvas limit, the `AbortSignal.any` support, the far-row containment the 3f leftover already names),
  a phone switching chats mid-auto-translate (no stale translation appears, the provider request count in the
  server's request log), a long chat's multi-page export opening in an image viewer.

## Out of scope

- F3's incremental streaming renderer (token or span assembly of highlighted fences, a per-fence result cache,
  an adaptive parse cadence) and any change to how a streaming row parses its growing prefix.
- F6's time-budgeted mount and parse queue, a moving retained window with stable-height placeholders, and
  narrowing what `ReloadGUIPointer` re-creates.
- Cross-browser measurements and a Firefox or Safari driver.
- CBS semantics, the sanitizer's configuration and hooks, the shared styles' cascade order, the stylesheet
  registry's keying, far-row containment, the mount hold and the scroll anchor.
- The server transform's admission, queue and cache (a cancelled chunk's snapshot expires by its TTL; no
  release route).
- The conditional risks the investigation tables without a reproduction (CBS limits as a frame budget, media
  fallback retention, offscreen media activity, the stored translation lookup) beyond the driver's counts.

## Later

- F3 and F6, planned after the mount profile of Slice 5's trace at 30/150/600 rows says which burst is
  material; the plan then also decides whether the retained window moves.
- A route that releases a cancelled chunk's server snapshot before its TTL, if the driver shows snapshots
  holding slots.
- Q4 reversed: let dispatched transform requests finish to warm the caches, if the switch-and-return case
  measures worse than the queue occupancy it saves.
- Q2 reversed: the selected-range export.
- The whole per-chat message index (F1's full form) with its invalidation on hydration, replacement, deletion
  and reorder, if the validated memo of Slice 0 is not enough for the stored-translation lookup
  (`storedTranslation.svelte.ts` `heldMessage`) the investigation also names.
- The `measureChats.mjs` settling delay and wheel input the investigation found, if that driver is run again
  for the production frame numbers.
