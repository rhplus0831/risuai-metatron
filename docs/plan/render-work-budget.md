# Render Work Budget Plan

Status: drafted 2026-11-03, revised 2026-11-04 after the
[design audit](../audit/plan-design-audit-2026-11-04.md); Slice 5 split into 5a and 5b on 2026-11-05;
slices landed: 5a (`b86d2ff1f`), 0 (`b850f7a01`), 1 (`784e29d85`), 2 (`19df4fc6f`), 3 (`5e3ad8a80`), 4 (`88f523847`). Decisions D1–D9 are recommendations
for the owner; the **Open questions** Q1–Q4 were answered by the owner on 2026-11-03 (the recommended option
each time; Q3's answer narrowed on 2026-11-04). Code anchors re-checked at `215cbce1d`; verify them again before
editing (STRUCTURE.md protocol step 5).

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
screen, Transcript rows and the mount hold, Message row, Tests), the [translation guide](../structure/translation.md)
(Translator, LLM translation, Stored translation, Flows), and the
[test harness guide](../structure/test-harness.md) (Browser stack, Measurement scripts, Test rules, Timeouts) at
`7e184d3c8`; the 2026-11-04 [design audit](../audit/plan-design-audit-2026-11-04.md) (its Render Work Budget
items RW1–RW5 and cross-plan item X3) and its
[per-plan report](../audit/plan-design-audit-2026-11-04/render-work-budget.md) (fourteen findings with file and
line evidence), whose corrections this revision applies.

Owning guides when sliced: [CBS and rendering](../structure/cbs-rendering.md) (the render's lifetime signal
through `ParseMarkdown`, the transient boundaries, the transform client's subscribers, cancelled settlement and
in-flight join, the CSS scope cache in Caches, the two small items of Slice 0),
[UI and theming](../structure/ui-theming.md) (the row's render run and its abort, the probe's ownership, the
screenshot's pages and Blob export), [translation](../structure/translation.md) (`translateHTML`'s signal, the global
worker cap, the rendered path's in-flight map and its generations), [test harness](../structure/test-harness.md)
(the measurement driver and its CDP recipes).

Relation to other work: the chat rendering series and the stylesheet registry are done and stay as they are;
this plan does not re-propose far-row containment, the registry's keying and ordering, the mount hold, or the
scroll anchor. Display Evaluation (done) gave the tab's transform result cache, the provisional display and the
generation fences (`isCurrent`, `appliedEmotions`, the conditional replacement by entry version); this plan adds
cancellation beneath them and changes none of them (D7). Files shared with the other active plans: the
[Reroll Candidates plan](reroll-candidates.md) Slice 2 edits `reroll` in
`src/lib/ChatScreens/DefaultChatScreen.svelte`, the file of this plan's Slice 4 (`screenShot`): different
functions, so a rebase, not a conflict, but not the same worktree at once. The
[Job Handoff plan](job-handoff.md) Slice 3 edits the same file (its "Hand off to…" control beside Stop) and
`src/lang/en.ts` and `ko.ts`, which Slice 4 edits if its progress text changes: the same rule, and the language
files only gain keys. The [Asset Lifecycle plan](asset-lifecycle.md) Slice 4 edits `en.ts` and `ko.ts` too (its
`storage.*` keys). The [Incremental Chat Transport plan](incremental-chat-transport.md) Slice 0 owns the
per-chat message position index (the investigation's F1, D8); this plan edits neither `chatStore.svelte.ts` nor
its tests.

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
  late answer still reaches the rows that still wait. A cancelled request is not a failure: no toast, no retry
  round, no cache eviction.
- **Repeated CSS preparation is cached.** The parse, scope and stringify of identical post-CBS CSS runs once per
  distinct text within a bounded cache; thirty rows with one sheet prepare it once and still share one live
  stylesheet.
- **The screenshot export's transient memory is bounded.** The output canvas is sized once, each source canvas
  is released after it is drawn, large exports split into pages, and the PNG goes to the download as a Blob.

Not goals: an incremental streaming renderer, a time-budgeted mount queue, a moving retained window, cross-browser
measurements, any change to CBS semantics, to DOMPurify's configuration or hooks, or to the cascade order of
shared styles.

## Current state

The baseline is `7e184d3c8` on `dev` (2026-11-03), re-checked at `215cbce1d` (only documents changed between).
The investigation's line numbers are from `6336e2954`; the anchors below are by identifier.

- **A render run has a generation but no lifetime.** `src/lib/ChatScreens/ChatBody.svelte` starts a run in the
  `$derived.by` of `markParsingResult` with
  `markParsing(msgDisplay, character, idx, renderRevision, ++parseRun)`. Inside `markParsing`,
  `!destroyed && run === parseRun` (`destroyed` is set by `onDestroy`) guards the writes of `lastParsed` and
  `lastRenderedRevision` in the `finally`, and `reportMixed` and the provisional callback (`enableProvisional`)
  check both; the spinner (`LOADING_HTML`) write checks `run === parseRun` only. Nothing else is guarded:
  `ParseMarkdown`, `translateHTML`, `getLLMCache` and the transform all run to completion for a superseded or
  unmounted row, and no `AbortSignal` exists anywhere on the path. `translating` (`$bindable`, the class of the
  translate button in `Chat.svelte`) is set before each `translateHTML` await and cleared after it, with no
  `finally`. The `catch` calls `markParsing` again at once with `tries` 1, 2 and 3 (the same `run`, the same
  capture, the same stored-path state), alerting only when `tries > 2`: a consistently thrown error runs the
  pipeline four times, for a run that may already be obsolete. The existing test
  `src/lib/ChatScreens/ChatBody.svelte.test.ts` "keeps the newest render's body when an older render settles
  later" proves the hiding, not a stop; "alerts a clean parse error and preserves the original stack after
  retries fail" relies on the fourth attempt's alert.
- **The auto-translate probe parses twice.** With `autoTranslateCachedOnly` and the LLM translator, the run
  derives the cache key with `getLLMCache(await ParseMarkdown(data, charArg, "pretranslate", ...))` (or the
  `notrim` parse on the legacy path), then flips `translated` through a 10 ms `setTimeout` (`translationUpdate`,
  awaited by `whenRendered` as `pendingAutoTranslate`), and the state change starts a second run that parses
  again. The run writes the remembered probe inputs `lastCharArg`, `lastChatId` and `lastAutoTranslate` before
  the probe's first await, and the probe runs only when one of them differs, so a run started while the probe is
  pending, with the same character, chat and flag, skips it; the timer has no run guard, so today the superseded
  run still flips `translated`. The probe's inner `try` logs any error (`console.error`) and goes on to the
  untranslated parse.
- **The pending body is prepared again.** `shownBody(source)` runs `trimMarkdown` or `trimMarkdownSharingStyles`
  (DOMPurify, the style restore, the bilingual prune, `addMetadataToElement`) for whatever the
  `{#await markParsingResult}` block renders: `lastParsed` in the pending branch and `md` in the `:then` branch.
  A render pending across a paint prepares the previous body once more, and the comment in the `finally` ("since
  trimMarkdown is fast, we don't need to cache it") does not hold for CSS-heavy content. `shownBody` also reads
  the `modelShortName` prop (`addMetadataToElement`) and, through the style restore's `risuChatParser`, the
  chat's CBS variables, so the template's `{@const}` re-runs when either changes.
- **`ParseMarkdown` has five awaits and no signal.** In `src/ts/parser/parser.svelte.ts`,
  `ParseMarkdown(data, char, mode, chatID, cbsConditions, capturedTransform?)` awaits `parseAdditionalAssets`,
  `serverProcessScript` (`editdisplay`, when a capture exists), the assets again, `parseInlayAssets` and
  `renderHighlightableMarkdown` (only for `normal` and `notrim`), with the thoughts and tools and `encodeStyle`
  between, then runs `trimMarkdown` synchronously unless `notrim`. `ChatBody` passes `notrim` (or `pretranslate`
  for a translation's source), so its main path runs no sanitizer inside `ParseMarkdown`: the template's
  `shownBody` sanitizes. The guide's Display section has the order. The asset passes read file sources
  (`getFileSrcCached`, `getFileSrc`) and the inlay pass reads each inlay's record (`getInlayMedia`, whose
  `getResource` in `src/ts/process/files/inlays.ts` is not caught), so a failed read rejects `ParseMarkdown`;
  the highlight loader's dynamic imports sit inside `renderHighlightableMarkdown`'s empty `catch`, so their
  failure never leaves it.
- **Transform batches deduplicate within a frame and never cancel for a row.**
  `src/ts/parser/transformClient.ts` `serverProcessScript` joins a `Batch` (keyed by mode, captured context,
  plugin context, handler set and client) and shares identical `inputs` through `batch.shared` as one
  `Operation` with one `answer` promise; `schedule` flushes on the next frame or a 16 ms timer:
  `batches.clear()`, then `sendBatch` splits by `MAX_TRANSFORM_TARGETS` and `MAX_TRANSFORM_REQUEST_TEXT_BYTES`
  and `sendChunk` posts under `CHUNK_DEADLINE_MS` with `AbortSignal.timeout`. Once dispatched, a batch cannot be
  joined and no target can be withdrawn; the completion applies the answer through the `isCurrent` fences (cache
  generation and Re-render generation, which do not change on unmount, so an unmounted row's answer still warms
  the tab cache). `inputs` holds the identity, the text, `noCache`, both generations and `knownKey`, not the
  plugin context, which only the batch key carries (the plugin handlers run under the batch's `pluginContext`).
  Any request error, the deadline included, lands in `sendChunk`'s `catch`, which answers every open target
  `ok: false`: `settle` toasts, and each caller's completion evicts the tab-cache entry
  (`replaceTransformResult`), records a `transformFailed` client event and, for a message, schedules a retry
  round (`markDisplayTransformFailed`).
- **Rendered translation has per-call workers and no in-flight map.** `src/ts/translator/translator.ts`
  `translateHTML(html, reverse, charArg, chatID, regenerate, capturedTransform?)` takes no signal. Its LLM path
  calls `translateLLM(text, context, regenerate, failure?, signal?)`, which already accepts a signal and checks
  it between steps, without passing one; with `regenerate` it skips the cache read, and every request ends with
  an unconditional `writeLLMCacheEntry`. Its non-LLM path runs `translateJobs` with `Math.min(10, jobs.length)`
  workers per invocation (DeepLX: sequential `■` batches), each `translate` writing the memory pair cache;
  `translate(text, reverse)` and the display-script step per job (`serverProcessScript` with kind `translation`)
  take no signal. `runTranslator` accepts `exarg.signal`. Provider failures are answered inside the translator:
  DeepL and DeepLX non-2xx answers come back as `ERR::` strings that `runTranslator` alerts before returning the
  text, `globalFetch` resolves `{ ok: false }` rather than rejecting, and `translateLLM` catches every error but
  an abort, alerts and returns the text; what can reject out of `translateHTML` is the direct Google `fetch` of
  `translateMain` and the LLM cache read `readLLMCacheEntry` (in `translateHTML`, and in `translateLLM` before
  its `try`). The stored path (`src/ts/translator/storedTranslation.svelte.ts` `requestStoredTranslation`) keeps
  `inFlight` per message key and joins a running request; the rendered path reads `readLLMCacheEntry` and
  otherwise requests.
- **Every row scopes its CSS itself.** `restoreStyles` calls `decodeStyleContent(hex)` per `<risu-style>`: hex
  decode, `risuChatParser(text)` (the selected chat's variables), `css.parse`, `decodeStyleRule` per rule (a
  `postcss-selector-parser` run per selector adding `.chattext ` and the `x-risu-` class prefix, nested at-rules,
  `data:` imports neutralized), `css.stringify` compressed; a parse error gives the fallback text (the error
  prefixed `CSS ERROR:` under `settings.ui.returnCSSError`, else empty). `trimMarkdownSharingStyles` sanitizes,
  restores, runs `prepare`, and extracts each shareable `<style>` as a `ChatStyle { css, attributes }`;
  `src/ts/parser/chatStyles.ts` `ChatStyleRegistry.acquire` keys by `JSON.stringify([css, attributes])`, so
  equal final CSS is one sheet, after each row has done the work.
- **The screenshot keeps everything until the end.** `src/lib/ChatScreens/DefaultChatScreen.svelte` `screenShot`
  sets `loadPages = Infinity`, awaits `whenRendered` of the rows and the greeting, captures each `.risu-chat`
  with `html-to-image`'s `toCanvas` inside `withFileSrcFetch` into a `canvases` array (version 1.11.13 without
  `skipAutoScale` scales a capture down when a side exceeds 16,384 px), reverses it (the export runs in reverse
  DOM order), assigns `mergedCanvas.width` and `height` inside the summing loop (each assignment reallocates and
  clears the canvas), fills and draws, calls `canvas.remove()` on canvases that were never in the document (no
  release of their backing stores), then `toDataURL("png")`, `Buffer.from(base64)` and `downloadFile`, which
  copies it into a `Uint8Array` and makes a `Blob` and an object URL: the PNG bytes exist as a data URL string,
  a Buffer, that copy and a Blob at once. The `finally` restores `loadPages` and the scroll offset when
  `chatKey === capturedChat` and clears `takingScreenshot`. `src/ts/globalApi.svelte.ts`
  `downloadFile(name, dat: Uint8Array | ArrayBuffer | string)` takes no Blob.
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
  place that already does `++parseRun`), and `onDestroy` aborts the current one. The signal travels as a
  trailing optional `signal?: AbortSignal` parameter of `markParsing`, `ParseMarkdown`, `translateHTML` and
  `serverProcessScript`, the platform type `translateLLM` and `requestChatData` already take (as the Static
  Audit's image and TTS signals did); the translator's `translate(text, reverse)` takes none, because the signal
  gates taking a job, not a job already requested (D4). It is checked with `signal.throwIfAborted()` at the
  start of each stage and after every await: in `markParsing` before the cached-only probe and after each of the
  probe's awaits, before and after each `ParseMarkdown`, `translateHTML` and `postTranslationParse`, and before
  a retry; in `ParseMarkdown` before each of its five awaits (the two asset passes, the transform, the inlays,
  the Markdown render) and after the last one (its sanitizer step is synchronous and `ChatBody`'s `notrim` calls
  never reach it, so it gets no checkpoint of its own); in `translateHTML` before dispatch, in each worker
  before it takes a job, before each job's display-script step and before serialization. An abort surfaces as
  the `AbortError` `DOMException` `throwIfAborted` throws; `markParsing`'s `catch` recognizes it
  (`signal.aborted`) and resolves quietly with what it had (`lastParsedQueue`), with no alert, no retry and no
  `lastParsed` write (the existing `finally` guard already skips it), so `whenRendered`'s loop,
  `settleFirstStageRow` and `checkImg` see a settled promise as today. The retries keep the run's signal (they
  keep its `run` and capture already).

  The cached-only probe's decision belongs to the run that made it. Its inner `try` rethrows an abort instead of
  logging it in its `catch`; other errors are logged as today. The remembered inputs (`lastCharArg`,
  `lastChatId`, `lastAutoTranslate`) are written only once the probe has completed: right after it when
  `translated` keeps its value, or in the 10 ms flip together with `translated` when it changes, so a run
  aborted during the probe or before its flip leaves the next run with the same character, chat and flag to
  probe again. The flip's timer writes nothing for an aborted run, and the run's abort settles its
  `translationUpdate` and clears `pendingAutoTranslate` if it still holds that promise, so `whenRendered` never
  waits on a flip that will not come. `translating` is cleared in a `finally` around each `translateHTML` await
  by the run that set it, unless a newer run has set it since (the row remembers which run did): an aborted run
  neither leaves it stuck nor clears a newer run's.

  Rejected: a module-level "current run" per message (a greeting or bookmark preview has no message id, and a
  row can have two runs alive for a moment); carrying the signal inside `CapturedTransform` (it is null without
  a server context, and the capture describes the server's inputs, shared by retries by design); keeping the
  10 ms flip as it was, with the remembered inputs written before the probe's first await (a run aborted during
  the probe never flips `translated`, and its successor's equal remembered inputs skip the probe, so the row
  stays untranslated: design audit RW1); resetting the remembered inputs in the abort path (a late abort would
  undo a newer run's probe); clearing `translating` under `run === parseRun || signal.aborted` (an older aborted
  run would clear a newer run's flag).

- **D2. Failure classification: deterministic errors never retry, transient I/O errors retry twice with a delay
  while live.** A new `src/ts/parser/renderErrors.ts` holds `markTransient(error)` and `isTransient(error)`, a
  `WeakSet` by error identity as `transformClient.ts` does with `epochRefusals` and `permanentRefusals`. The I/O
  boundaries that can reject into `markParsing` mark their own failures, where they are awaited: the inlay media
  read (`parseInlayAssets`' `getInlayMedia`, whose `getResource` in `inlays.ts` rejects on a failed read), the
  file source reads of the asset and inlay passes (`getFileSrcCached`, `getFileSrc`), the direct Google `fetch`
  in `translateMain` (reached from `translateHTML`'s jobs through `translate` and `runTranslator`, which rethrow
  it), and the LLM translate cache's storage read `readLLMCacheEntry` (in `translateHTML`, and in `translateLLM`
  outside its later `try`). An abort is never marked. Two other failures are not retry boundaries, because they
  never reach `markParsing`: the highlight loader's import failure, swallowed by `renderHighlightableMarkdown`'s
  empty `catch` inside `ParseMarkdown`, and the translator's provider answers, which the translator alerts and
  answers itself (DeepL and DeepLX non-2xx answers return `ERR::` strings that `runTranslator` alerts before
  returning the text; `globalFetch` resolves rather than rejects; `translateLLM` catches every error but an
  abort). The probe's own `getLLMCache` failure stays logged inside the probe (D1), so a mark has no effect
  there. Everything unmarked is deterministic: `CbsLimitError`, Markdown, KaTeX and CSS errors, a `TypeError` in
  the pipeline, an unknown provider error. `markParsing`'s `catch`: an abort returns quietly (D1); a
  deterministic error alerts once with the wrapped message and the original stack (as the fourth attempt does
  today) and returns `data`; a transient error waits 250 ms, then 1,000 ms, under the run's signal (a
  `setTimeout` raced with the signal's `abort` event, in a small helper beside `sleep` in `src/ts/util.ts`), and
  retries at most twice; a third failure alerts as a deterministic one. The default errs toward fewer runs: a
  transient error left unmarked costs one failed render that the next edit, remount or Re-render repairs, while
  a deterministic error marked transient costs two more runs of a reproducible failure. The transform's own
  failures stay out of this: `serverProcessScript` answers the text as it came in and the display-transform
  recovery rounds retry it. Rejected: classifying by message or type (`TypeError: Failed to fetch` is
  browser-specific, and a `TypeError` is also what a parser bug throws); retrying everything after a delay
  (keeps the four-fold work for the reproducible case); no retry at all (Q1); marking the translator's provider
  request (`runTranslator` around its provider call) and the highlight language loader, while leaving the inlay
  and file source reads unmarked (the first two never reject into `markParsing`, and the reads that do would
  have been classified deterministic: design audit RW5); making the highlight loader rethrow so it can retry (it
  would turn a fallback that renders today into a failed render).
- **D3. Transform batches count subscribers; the request is cancelled only when the last one leaves.** In
  `transformClient.ts`, each `serverProcessScript` call that passes a signal is a subscriber of its `Operation`;
  its abort unsubscribes. A caller without a signal (a plugin's `editprocess` call in `v3.svelte.ts`,
  `BackgroundDom.svelte`'s background render, `translateHTML`'s per-job step until Slice 2 passes one) is a
  subscriber for the operation's lifetime, so nothing changes for it; the greeting is a `Chat` row with a
  `ChatBody` and has D1's signal. When an operation's count reaches zero: not yet dispatched (its batch still in
  `batches`), the target leaves `batch.pending` and `batch.shared` and is never sent; dispatched, nothing
  happens unless every operation of its chunk has zero subscribers, in which case the chunk is cancelled: its
  `AbortController` aborts the `fetch`, the plugin handlers of that chunk do not run, and the second call is not
  made (the server's snapshot expires with `TRANSFORM_SNAPSHOT_TTL_MS`). That controller replaces `postOnce`'s
  `AbortSignal.timeout`: a timer forwards the deadline and the last subscriber's departure forwards the
  cancellation, by hand, as `src/ts/storage/assetClient.ts` forwards its caller's abort because
  `AbortSignal.any` is missing before Safari 17.4; the chunk records which of the two aborted it.

  A chunk cancelled because its last subscriber left settles its open targets as `cancelled`, a settlement
  distinct from a failure and from the deadline timeout (which stays a failure, as today). `sendChunk`'s answer
  loop accepts it (today an answer without `ok` that is not a matching confirmation is skipped), and its `catch`
  and residual-open loop answer every open target `cancelled` rather than `ok: false`; `settle` raises no
  failure toast for it; and every caller's completion treats it as no answer: no `replaceTransformResult`
  eviction, no `transformFailed` client event, no `markDisplayTransformFailed` retry round, no `onProvisional`
  call (a provisional caller gives back the count it raised), and the caller's promise resolves with its input
  text, its `ParseMarkdown` ending on the next `throwIfAborted`. While any subscriber remains, nothing is
  cancelled: an answer that arrives after one subscriber left reaches the subscribers that remain as a real
  result, and the unsubscribed caller's promise has already resolved with its input text.

  Dispatched operations also stay in an in-flight map, so a new subscriber with identical inputs (a row
  unmounted and mounted again, a chat switched away and back) joins the running request instead of sending
  again. The map is keyed by the batch key plus `inputs`: `inputs` already includes the cache generation, the
  Re-render generation and `knownKey`, and the batch key adds the plugin context the handlers run under, which
  `inputs` lacks. An operation leaves the map the moment its chunk is cancelled, so no caller joins a cancelled
  request, and otherwise when it settles; a settlement removes only its own entry, so an older cancelled request
  that settles late never removes the request that replaced it. The completion's fences stay (D7). Rejected:
  cancelling a caller's own target (two rows sharing one operation is the case this decision exists for); never
  cancelling a dispatched request (a screenshot or a global reload after a switch keeps the server's four active
  slots and its queue busy for rows nobody shows: the burst F6 and F7 describe); a grace period before the abort
  (Q4 covers the trade-off it would approximate); combining the deadline and the subscriber abort through
  `AbortSignal.any` (missing before Safari 17.4, the reason `assetClient.ts` forwards by hand: design audit);
  letting a cancelled chunk end in `sendChunk`'s failure path (every open target answered `ok: false`: a failure
  toast, the good tab-cache entry evicted, a `transformFailed` event and a retry round for rows nobody shows:
  design audit RW2); keying the in-flight map by `inputs` alone and keeping an operation in it until it settles
  (callers under different plugin contexts would join, and a remount would join a cancelled request: design
  audit RW3).

- **D4. Rendered translation gets a global worker cap and a per-key in-flight map.** `translateHTML`'s non-LLM
  workers draw from a module-level semaphore of `MAX_TRANSLATION_WORKERS = 10` across every call, instead of ten
  per call. The caller's signal gates taking a job only: a worker checks it before taking the next job, and an
  aborted call takes no further job. A job already requested runs to its answer, since
  `translate(text, reverse)` takes no signal, and writes the memory pair cache, so the next render of that text
  is a hit; its slot is released only when it answers, so at most ten requests are open at any time. The LLM
  path keeps an in-flight map keyed by the LLM cache key (`llmCacheKeyPrefix(context) + html`, what the cache is
  keyed by): a second ordinary rendered call with the same key awaits the same `translateLLM` promise, whose own
  `signal` is a shared controller aborted only when every awaiting caller has aborted; the result is written to
  the cache once. A `regenerate` call (Retranslate) never joins an in-flight ordinary call, whose answer may be
  the cached text `translateLLM` returns without a request, and an ordinary call never joins a regeneration; a
  regeneration joins nothing. Each key keeps a generation number, taken by every rendered call that is not a
  join, and a request publishes its result to the cache (`translateLLM`'s closing `writeLLMCacheEntry`) only
  while its generation is still the key's newest: an older request that finishes after a fresh regeneration
  still resolves its own callers but does not overwrite the regeneration's cache value. The key is the cache key
  rather than a message id because identical texts in two messages should be one request, and a message id
  exists only in a capture, which a render without a server context does not have (`chatID` is an index, never
  an address after an await). Duplicate provider billing was not reproduced by the investigation; this map is a
  bound, and Slice 5 counts `translateLLM` calls per key before and after. The stored path's `inFlight` map is
  unchanged. Rejected: a per-message map on the rendered path (no message id without a capture, and identical
  texts in two messages would be two requests); a global cap on LLM steps (`requestChatData`'s own queueing is
  the LLM request guide's concern); passing the caller's signal on to the jobs already requested (the provider
  request is aborted, so its answer never warms the memory cache, and releasing the slot while such a job still
  ran would open more than ten requests: design audit); one join per key whatever `regenerate` says (a
  Retranslate joining an ordinary call gets the old or cached text back: design audit RW4); letting whichever
  request finishes last write the cache (an older ordinary request finishing after a regeneration would
  overwrite the fresh translation).
- **D5. The CSS scope cache is keyed by the post-CBS CSS text, bounded, and never by the raw style.**
  `decodeStyleContent` splits into the uncached part (hex decode, `risuChatParser`) and `scopeCss(text)`: the
  `css.parse`, `decodeStyleRule` and `css.stringify` stage, cached in a module-level map of `parser.svelte.ts`
  keyed by the exact string handed to `css.parse`, valued with the stringified scoped CSS. A parse error is not
  cached, and its fallback text reads `settings.ui.returnCSSError` at the time, as today. The key holds no mode
  flag at `7e184d3c8` because none reaches the cached stage: `.chattext` and `x-risu-` are constants, safe mode
  acts in `Chat.svelte` (`SafeModeStore`, the custom HTML theme), and the sanitizer runs outside it; the rule for
  a later flag is that anything `decodeStyleRule` or the stringify reads joins the key. Bound: 256 entries and
  4 MiB of key plus value UTF-16 code units, evicted oldest first by last use in the insertion-order `Map` with
  a byte counter that `src/ts/parser/transformResults.ts` uses (one shape in the parser directory; `mnemonist`'s
  `LRUMap` of `tokenizer.ts` has no byte bound). Acceptance: identical content still shares one live sheet,
  which holds without a registry change because `ChatStyleRegistry` keys by the final `css` value the cache
  returns unchanged; the test counts one `css.parse` and one sheet for thirty rows. The pending body is retained
  too: the `{#await}` block's pending branch memoizes its last `shownBody` result keyed by the source string and
  `modelShortName`, the two inputs `shownBody` takes directly, so a render pending across paints prepares
  `lastParsed` once; the `:then` branch is not memoized. A memo hit reads no state, so CSS using CBS variables
  inside the pending body updates on the next run, not while the run is pending. This memo lives in
  `ChatBody.svelte` and lands with Slice 1, which owns that file. Rejected: caching by the raw `<risu-style>`
  hex (CBS variables change its meaning); caching the sanitized DOM tree (`RETURN_DOM` gives a live tree the
  template consumes, and cloning it costs what it saves); a cache inside the registry (it sees only final CSS,
  after the work); memoizing both branches by the source string alone (`shownBody` also reads `modelShortName`,
  and a hit drops the CBS variables the style restore reads from the template's dependencies: design audit).
- **D6. The screenshot sizes its output once, releases each source, exports a Blob, and pages large exports.**
  The merge moves into a new pure module `src/lib/ChatScreens/screenshotExport.ts` with injected capture and
  canvas factories (so a test counts with fake canvases; happy-dom has no 2D context): `planScreenshotPages`
  measures each row with the rule `html-to-image` uses for its canvas (`getImageSize` from the library's `util`
  module if the installed version exports it, else `clientWidth` plus border widths times the pixel ratio,
  scaled down as the library scales a side over 16,384 px), keeps the order the export has today (reverse DOM
  order, as `screenShot` reverses its captures), sums the heights and the maximum width, and splits whole rows
  into pages so that no page exceeds `MAX_EXPORT_PIXELS = 64_000_000` (256 MiB of RGBA) or 16,384 px on a side
  (Safari's canvas limit, under Chrome's). A row whose capture `html-to-image` scales down (any side over
  16,384 px: version 1.11.13 does this itself without `skipAutoScale`, which the capture options do not set)
  takes a page alone at its scaled size; no other row is split across pages. `composeScreenshot` then, per page,
  sizes the page canvas once, captures one row at a time with `toCanvas` inside `withFileSrcFetch`, draws it,
  and releases it (`width = 0`, `height = 0`: the way a canvas's backing store is freed; `remove()` did nothing
  for a detached canvas), so one source canvas is alive at a time; a capture that still differs from its
  measured slot is drawn clipped to the slot with a console warning. Each page goes out through
  `canvas.toBlob("image/png")` and a `downloadFile` that accepts a `Blob` and passes it to `URL.createObjectURL`
  without the data URL string, the Buffer and the `Uint8Array` copy; the names are `chat-<uuid>.png` for one
  page and `chat-<uuid>-<n>of<m>.png` for several. `screenShot` keeps `loadPages = Infinity`, the `whenRendered`
  waits, the `alertWait` progress per row, the `finally` restoration of the window and the scroll offset, and
  `takingScreenshot`. Whether 64 MP fits iOS Safari's canvas area limit is a device check (**Verification**); a
  lower budget under `isMobile` follows if it does not. Whether a "selected range" export is a UI feature of
  this plan is Q2. Rejected: capturing every row to a PNG Blob first and decoding one at a time (sizes from the
  PNG headers; it retains the compressed bytes of every row and decodes each twice); `OffscreenCanvas` in a
  worker (`html-to-image` needs the DOM, and the merge is the cheap part); JPEG or WebP output (a format change
  users would notice); keeping every row whole on a page of at most 16,384 px whatever its size (a row over that
  limit fits no page, and its capture comes back scaled down, not at its measured size: design audit).
- **D7. What stays unchanged.** The `run === parseRun` and `destroyed` guards of `ChatBody.svelte`, the
  `display.replaced` and `reportMixed` logic, the `isCurrent` fences and `appliedEmotions` of
  `transformClient.ts`, the tab cache's conditional replacement by version, the display-transform recovery
  rounds, the `ChatStyleRegistry`'s keying, ordering and microtask reconcile, and `whenRendered`'s loop. An
  aborted operation can still settle (an answer already on the wire when the abort arrives), so the
  stale-display and stale-transform-effect guards remain the correctness layer; cancellation only removes work,
  and a `cancelled` settlement touches none of the above (D3).
- **D8. Slice 0 is included, with two items.** The investigation's one-screen items F5 and F8 are not in
  `docs/research/found-issues.md` (only F8 is recorded, as the `removeHighlight` Issue of the CBS and rendering
  guide), so leaving them means re-finding them. They land as one commit with a count test each, before or
  beside the other slices: F5 in `src/lib/ChatScreens/PartialEditController.svelte` (the early return compares
  against `"flex"`, the display it sets, and `hasTextContent`'s clone runs once per hovered block, remembered
  until the block or its content changes); F8 in `src/ts/gui/highlight.ts` (`highlighter` deletes the owned
  categories absent from `formatedRanges`, `removeHighlight` clears the registry entries of that id, and a
  delayed highlight callback after `TextAreaInput.svelte`'s destroy does nothing). F1, the streaming paths'
  message lookup, is not in this plan: the [Incremental Chat Transport plan](incremental-chat-transport.md)
  Slice 0 owns the per-chat message position index in a validated form (a position is trusted only while the row
  at it still has the id) and serves every caller, `applyServerGeneration` and `showStreamText` among them. Q3
  kept Slice 0 in the plan; had it been declined, the two would have moved to `found-issues.md` under one
  heading. Rejected: F1 as a validated last-position memo in `src/ts/storage/chatStore.svelte.ts` (the transport
  plan's index serves the same lookups and the stored-translation one, and both plans put their Slice 0 early,
  so the memo would be built in the same file and tests only to be removed: design audit X3); the full index in
  this plan (every write path of the chat store would have to maintain it; the transport plan takes it in its
  validated form).
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

All four were answered on 2026-11-03 with the recommended option; they are kept here as the record of why. Q3's
answer was narrowed on 2026-11-04.

- **Q1. Retry policy.** Recommended: D2's bounded transient retry (two retries, 250 ms then 1,000 ms, only
  while the run is live, only for marked I/O failures). Alternative: no retry in `markParsing` at all; a
  provider failure during auto-translate then leaves the row untranslated until its next render, and the
  translator's own alert is the only notice.
- **Q2. A selected-range export.** Recommended: no UI change in this plan; D6's pages bound the memory, and a
  long chat exports as several files. Alternative: a range picker (from message to message) on the screenshot
  menu entry, which is a composer and menu change in `DefaultChatScreen.svelte` and a string in `src/lang/en.ts`,
  added to Slice 4.
- **Q3. Slice 0.** Recommended: include it (D8). Alternative: leave the three items out and move them to
  `docs/research/found-issues.md` in the first slice's commit. Answer revised on 2026-11-04 after the design
  audit: Slice 0 stays with two items (F5, F8); F1 moved to the Incremental Chat Transport plan's Slice 0, whose
  index covers it.
- **Q4. Cancel dispatched transform requests, or let them finish.** Recommended: D3 as written, cancel when
  the chunk's last subscriber leaves, which bounds the server's queue occupancy in the burst cases. Alternative:
  withdraw only never-dispatched targets and let a dispatched request finish, because its answer still warms
  the server transform cache and the tab result cache (the completion's fences are by generation, not by mount),
  so a chat switched away and back shows the provisional text at once; D3's in-flight join covers the return
  while the request still runs, the alternative covers the return after it answered.

## Slices

Slices 1, 3 and 4 touch disjoint source files except `src/ts/parser/parser.svelte.ts`, which Slice 1 edits in
`ParseMarkdown` and its asset and inlay reads (the signal, the transient marks) and Slice 3 in
`decodeStyleContent` (the cache): a textual rebase, no shared logic. The guides rebase textually too:
`docs/structure/cbs-rendering.md` for Slices 1 and 3, `docs/structure/ui-theming.md` for Slices 1 and 4. Slices
1, 3 and 4 may run in parallel worktrees; Slice 2 needs Slice 1's signal; Slice 5's baseline run comes first and
its comparison last; Slice 6 needs 0–5. Each slice lands alone with the gates in **Verification** and updates
the guides it changes (T5: no slice labels in code, comments or test titles).

### Slice 0: the two small items (D8; needs nothing)

Files: `src/lib/ChatScreens/PartialEditController.svelte` (the hover guard, `hasTextContent`),
`src/ts/gui/highlight.ts` (`highlighter`, `removeHighlight`), `src/lib/UI/GUI/TextAreaInput.svelte` (the delayed
callback after destroy), the CBS and rendering guide (the `removeHighlight` Issue deleted).

- Tests (`src/lib/ChatScreens/PartialEditController.test.ts`, a new `src/ts/gui/highlight.test.ts` under
  happy-dom with a `CSS.highlights` stand-in): ten mousemoves over one block clone it once and read its
  rectangle once, and the buttons end displayed `flex`; highlighting `{{user}}` then plain text leaves no
  `cbsnest` category in the registry, `removeHighlight` empties the registry of that id, and a callback after
  destroy adds nothing.

### Slice 1: the render lifetime and failure classification (D1, D2, D5's pending-body memo, D7; needs nothing)

Files: `src/lib/ChatScreens/ChatBody.svelte` (the controller beside `parseRun`, the signal through
`markParsing`, the probe's rethrow, its remembered inputs and flip owned by the run, the `finally` of
`translating`, the `catch` with the three outcomes, the pending branch's `shownBody` memo), new
`src/ts/parser/renderErrors.ts`, `src/ts/parser/parser.svelte.ts` (`ParseMarkdown`'s `signal` and its checks;
the inlay media and file source reads mark their failures), `src/ts/translator/translator.ts` (`translateHTML`'s
`signal` and its checks, passed on to `translateLLM`; the direct Google `fetch` and `readLLMCacheEntry` mark
their failures), `src/ts/util.ts` (the abortable delay), `src/ts/parser/transformClient.ts`
(`serverProcessScript` accepts the signal and checks it on entry; the accounting is Slice 2), the UI and theming
guide (Message row: the run's controller, the probe's ownership, `translating`, the three outcomes of a
failure), the CBS and rendering guide (Display: the signal's checkpoints and the transient boundaries;
Invariants: an abort never skips the guards), the media guide (Translator: `translateHTML`'s signal).

- Tests (`src/lib/ChatScreens/ChatBody.svelte.test.ts`, a new
  `src/ts/parser/tests/parseMarkdownLifetime.test.ts`, a new `src/ts/translator/translateHtmlLifetime.test.ts`):
  on the translated path, a run superseded while its `pretranslate` parse is pending makes no `translateHTML`
  call and no further `ParseMarkdown` call once that parse settles (counts 0 for the old text), and the newest
  render's body still wins; a run whose row unmounts mid-parse makes no further call; a deterministic error
  calls `ParseMarkdown` once and `alertError` once with the original stack (the existing case, renamed and
  tightened from four calls to one); a marked transient error retries after 250 ms and again after 1,000 ms
  under fake timers, and a supersede during the first delay makes no second call; a cached-only probe whose run
  is superseded before `getLLMCache` answers starts no second parse and logs no error; a probe superseded by a
  same-character text change still ends translated, also when the supersede falls between the probe and its
  10 ms flip, and `whenRendered` resolves in both cases; a run superseded mid-translation by turning translation
  off ends with `translating` false, and an older run that settles after a newer one set `translating` leaves it
  true; `shownBody` prepares a pending `lastParsed` once across two template re-renders (one `trimMarkdown`
  call) and again when `modelShortName` changes; a rejected inlay record read and a rejected file source read
  reject `ParseMarkdown` with a transient-marked error; `ParseMarkdown` with a signal aborted after the first
  asset pass calls `serverProcessScript` zero times; `translateHTML` with an aborted signal calls `translate`
  zero times and with a signal aborted after the first job takes no further job; a rejected direct Google
  `fetch` and a rejected `readLLMCacheEntry` reject `translateHTML` with a transient-marked error.

### Slice 2: subscriber accounting for shared requests (D3, D4; needs 1)

Files: `src/ts/parser/transformClient.ts` (subscribers per `Operation`, withdrawal before dispatch, the chunk
controller with the deadline and the cancellation forwarded by hand in place of `postOnce`'s
`AbortSignal.timeout`, the `cancelled` settlement through the answer loops, `settle` and the completion, the
in-flight map by batch key plus `inputs`), `src/ts/translator/translator.ts` (the worker semaphore, the LLM
in-flight map and its shared controller, the regeneration rule and the per-key generations fencing the cache
write, the signal through the per-job display-script step), the CBS and rendering guide (Script transform
client: subscribers, withdrawal, the cancelled settlement, the join; Display transform: the batch-join sentence
extended with the in-flight join of a dispatched request), the media guide (Translator: the global cap and the
map; LLM translation: regeneration and the generation fence; State: the map beside the caches).

- Tests (`src/ts/parser/tests/transformClient.test.ts`, `src/ts/translator/translatorLLM.test.ts`, a new
  `src/ts/translator/translateHtmlWorkers.test.ts`): two rows awaiting one operation make one request, and when
  one row aborts the request is kept and its answer reaches the other; both aborting before the frame make no
  request; both aborting after dispatch abort the `fetch`'s signal, make no second call, show no toast, record
  no `transformFailed` event, schedule no retry round and keep the tab-cache entry; a chunk past its deadline
  still fails as today (one toast); a late answer after one abort reaches the remaining subscriber and the
  aborted caller's promise has resolved with its input; a third render with identical inputs during the flight
  joins it (one request); a render with identical inputs after its chunk was cancelled sends a new request and
  gets its real answer, and the cancelled request settling afterwards leaves the new one joinable (a fourth
  render joins it); a render with identical inputs under another plugin context during the flight makes its own
  request; a caller without a signal keeps the request alive; two rendered LLM translations of one key make one
  `requestChatData` and one cache write, one abort keeps it, two abort it; a Retranslate while an ordinary
  translation of its key is in flight makes its own request and returns the new text, an ordinary call during a
  regeneration does not join it, and an ordinary request that finishes after the regeneration resolves its own
  callers and leaves the regeneration's text in the cache; three `translateHTML` calls of twenty jobs each hold
  at most ten `translate` calls open at once (a deferred provider, the count read at the peak), and an aborted
  call takes no new job while its jobs already requested finish, write the memory pair cache and hold their
  slots until they answer.

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
  assignments and `drawImage` calls, a stubbed `URL.createObjectURL` for the download): N rows produce one
  output resize per page and N source releases, each release after its draw; rows are split into pages at the
  pixel budget and the side limit with no row split across pages, in reverse DOM order as today; a row taller
  than 16,384 px takes a page alone at its scaled size; a capture taller than its slot is clipped and warned
  once; the download receives one Blob per page with the `<n>of<m>` names; a capture that throws leaves the
  window and scroll restoration to the caller's `finally` (the caller's test: `screenShot`'s `finally` path
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
- Split into two slices, each its own commit (owner, 2026-11-05):
  - **Slice 5a: the driver and the baseline** (needs nothing; before Slices 1–4): the driver, the test harness
    guide's recipes, and the audit document with the baseline table.
  - **Slice 5b: the comparison** (needs 0–4 and 5a): the driver run again after Slices 1–4, the after table and
    the acceptance verdicts in the same audit document, and driver fixes the new code needs.

### Slice 6: the guide pass (needs 0–5)

Files: a final pass over the four owning guides and the global API guide for the sections the slices touched,
the `Tests` sections naming the new files and the driver, `docs/research/rendering-performance-investigation.md`
left as history with one line at its top pointing at the audit document (Slice 0 already deleted the
`removeHighlight` Issue).

## Recommended order

5a (baseline) → 0 → 1 → 2, with 3 and 4 in parallel worktrees beside 1 → 5b (comparison) → 6. Slice 1 alone
removes the four-fold retry and the obsolete parses; 2 needs its signal; 3 and 4 depend on nothing and can land
first if the baseline run shows the CSS or screenshot numbers to be the worst.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for every changed signature (`ParseMarkdown`,
  `translateHTML`, `serverProcessScript`, `downloadFile`: `rg` their callers across `src`, `e2e`, `util` and
  `docs`), V6 for every new test (shown to fail with the guarded line broken; the count assertions make this
  one-line breaks).
- Counts, not time: every test above asserts a number of calls, requests, sheets, resizes or releases, under
  fake timers or deferred answers (V3 and the Timing-Dependent Tests archive entry); the only durations are the
  driver's, in the audit document.
- Focused: `pnpm --silent test:agent src/lib/ChatScreens/ChatBody.svelte.test.ts
src/lib/ChatScreens/ChatBody.styles.svelte.test.ts src/ts/parser/tests src/ts/translator` for Slices 1–3;
  `pnpm --silent test:agent src/lib/ChatScreens/screenshotExport.test.ts src/ts/screenshotCaptureCache.test.ts`
  for Slice 4; `pnpm --silent test:agent src/lib/ChatScreens/PartialEditController.test.ts src/ts/gui/highlight.test.ts`
  for Slice 0 (file names as the slices create them).
- `e2e`, one run at a time: `e2e/openChat.spec.ts` and `e2e/perChatSends.spec.ts` after Slices 1 and 2 (the
  chat open and the sends of two chats render through the signal), `e2e/serverTransform.spec.ts` after Slice 2
  (the final render once, existing rows untouched, under the subscriber accounting), `e2e/transformGolden.spec.ts`
  after Slice 3 (the final browser HTML against the baseline fixture proves the cache changes no output).
- The driver (Slice 5) runs under `util/playwright/offline.sh` on a Linux host with no other dev stack of the
  checkout; its numbers are reported with the run, never as a gate.
- Not covered by any gate, the owner's device checklist: Firefox and Safari (the screenshot's page size at
  Safari's canvas limit, the far-row containment the 3f leftover already names), iOS Safari's canvas area limit
  against `MAX_EXPORT_PIXELS` (commonly cited near 16.7 MP, unverified; if a page fails there, D6's budget
  becomes lower under `isMobile`), a phone switching chats mid-auto-translate (no stale translation appears, the
  provider request count in the server's request log), a long chat's multi-page export opening in an image
  viewer.

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
- F1 and the whole per-chat message index: the [Incremental Chat Transport plan](incremental-chat-transport.md)
  Slice 0 (D8).
- The `measureChats.mjs` settling delay and wheel input the investigation found, if that driver is run again
  for the production frame numbers.
