# Audit: docs/plan/render-work-budget.md at d31fa9a48

Code anchors: the only commits after 7e184d3c8 are documentation changes (`git diff --stat 7e184d3c8 HEAD` lists only docs/plan files), so the code anchors have not moved.

## Findings, most severe first

### 1. Aborting a run during the cached-only probe loses the auto-translate decision for good

- Severity: P1 design flaw
- Plan: D1, lines 155-173 (the check "before the cached-only probe" and "after each ParseMarkdown", lines 161-162; "The 10 ms `translated` flip stays as it is", lines 169-170). Current state, lines 89-93.
- Evidence:
  - `src/lib/ChatScreens/ChatBody.svelte:243-247` sets `lastCharArg`, `lastChatId` and `lastAutoTranslate` before the probe's first await.
  - The probe awaits `ParseMarkdown`/`getLLMCache` at `:256-271`, and only after that schedules the `translated` flip at `:280-293`.
  - A superseding run with the same character, chat and flag fails the check at `:242` (`!isEqual(lastCharArg, charArg) || chatID !== lastChatId || auto !== lastAutoTranslate`), so it skips the probe and renders untranslated.
  - Today the superseded run keeps going and still flips `translated`, because the `setTimeout` has no run guard. Under D1 the aborted run never flips it, and nothing ever probes again.
  - The probe's inner `try { … } catch (error) { console.error(error); }` (`:248-297`) also swallows the `AbortError` from the plan's in-probe checks. It logs the error and carries on into the parse path.
- Correction: either set the `last*` fields only after the probe completes, or reset them in the abort path, so the next run probes again. Move the in-probe abort checks outside the inner `try`, or rethrow `AbortError` from it. Add a test: a probe superseded by a same-character text change still ends translated.
- Confidence: verified (code reading).

### 2. Cancelling a dispatched chunk goes through the transform failure path (toast, retry rounds, cache eviction)

- Severity: P1 design flaw
- Plan: D3, lines 192-209 (the chunk's `AbortController` aborts the `fetch`); D7, lines 263-268 ("cancellation only removes work").
- Evidence:
  - An aborted `post` rejects into `sendChunk`'s `catch` (`src/ts/parser/transformClient.ts:512-528`). That `catch` answers every open target with `ok:false`.
  - `settle` then calls `reportFailure` and an `alertToast` whenever `isCurrent(entry.captured)` (`:381-386`, `:372-378`). `isCurrent` depends on generations, not on mount (`:533-538`), so the toast still fires after a chat switch.
  - Each caller's `completion` was chained at call time (`:673`), so it runs for aborted callers too:
    - `replaceTransformResult(identity, shared.version, key)` with no result (`:686-687`) evicts the good tab-cache entry (`transformResults.ts:67-70`).
    - `recordClientEvent({ notice: "transformFailed" })` (`:690`) records a failure notice.
    - `markDisplayTransformFailed` (`:697`) schedules a retry round (`displayTransformRecovery.svelte.ts:52-55`), and a retry round re-renders rows (`ui-theming.md` Message row).
- Correction: give a cancelled chunk its own settlement, for example a `cancelled` answer or a `cancelledChunks` WeakSet like `epochRefusals`. It must skip `reportFailure`, the client event, `markDisplayTransformFailed` and the cache removal, and resolve the remaining completions with their input text. Add a test that both callers aborting after dispatch show no toast, mark no failure and keep the tab-cache entry.
- Confidence: verified.

### 3. The in-flight join key `inputs` omits the batch's plugin context, and the map must drop a cancelled operation

- Severity: P1 design flaw
- Plan: D3, lines 202-205 ("`inputs` already includes … so the join is exact").
- Evidence:
  - `inputs` (`transformClient.ts:645-652`) is `[identity, data, noCache, cacheGeneration, generation, knownKey]`. `identity` (`:597-609`) holds no `pluginContext`.
  - The batch key includes it on purpose: `JSON.stringify([mode, captured.context, captured.pluginContext, handlers?.id ?? null, client])`, with the comment "purpose, owner and job parent must also agree" (`:638-643`).
  - Handlers run with `batch.captured.pluginContext` (`:400-407`), which carries `owner: chatOwnerToken(...)` (`plugins/apiV3/pluginContext.ts:56-70`).
  - Today `batch.shared` is per batch, so the plugin contexts always agree. A module-level in-flight map, needed because `batches.clear()` (`:289`) drops the batch at dispatch, would join callers across plugin contexts.
  - The plan also keeps an operation in the map "until they settle". An operation whose chunk was just cancelled (zero subscribers) would stay joinable, and the new caller would get the cancellation as its answer.
- Correction: key the in-flight map by `batchKey + inputs`. Remove an operation from it when its chunk is cancelled, not only when it settles.
- Confidence: likely (the cross-context part depends on plugin contexts differing for the same `inputs`). The removal gap is verified from the text.

### 4. The rendered LLM translation in-flight map ignores `regenerate`

- Severity: P1 design flaw
- Plan: D4, lines 214-217 (map keyed by `llmCacheKeyPrefix(context) + html`).
- Evidence: `translator.ts:424-425` calls `translateLLM(html, llmContext, regenerate)`, and `translateLLM` skips the cache read only when `regenerate` is set (`:723-729`). A Retranslate call (`retranslate` → `regenerate=true`, `ChatBody.svelte:312,330,338`) that joins an in-flight non-regenerate call for the same key gets the old or cached text back. The user's explicit retranslate is silently lost. The plan never mentions `regenerate`.
- Correction: a `regenerate` call never joins. It starts its own request, and may replace the map entry so that later plain callers join it. Alternatively, put `regenerate` in the map key.
- Confidence: verified (code reading).

### 5. D2's transient boundaries are mostly unreachable from `markParsing`, and the reachable one is missing

- Severity: P1 design flaw (the retry as specified would almost never fire)
- Plan: D2, lines 174-191 (the list of boundaries at lines 177-180).
- Evidence:
  - **Highlight loader:** the dynamic imports sit inside `try { … } catch (error) {}` in `renderHighlightableMarkdown` (`parser.svelte.ts:227-417`). A rejection never leaves `ParseMarkdown`.
  - **Translator providers:**
    - DeepL and DeepLX non-2xx answers return `"ERR::…"` strings rather than throwing (`translator.ts:267`, `:311`). `runTranslator` alerts and returns the text (`:200-208`).
    - `globalFetch` never throws: it returns `{ ok:false }` (`globalApi.svelte.ts:602-646`).
    - The LLM path's `translateLLM` catches every non-abort error, alerts, and returns the text (`translator.ts:785-792`).
    - Only the direct Google `fetch` (`:342-347`) can reject into `markParsing`.
  - **`getLLMCache`:** in the probe it sits under the inner `catch … console.error` (`ChatBody.svelte:296`), so a marked failure there is never retried.
  - **Missing boundaries:** the real network reads on the render path, `parseInlayAssets` → `getInlayMedia` → `getResource` (`parser.svelte.ts:859`, `process/files/inlays.ts:188`), and `getFileSrc`/`getFileSrcCached` in the asset passes (`parser.svelte.ts:623`, `:863`), are not listed. They would be classified deterministic.
- Correction: list the boundaries that can actually reject into `markParsing` (inlay metadata read, file source reads, the direct Google `fetch`, `readLLMCacheEntry` on the `translateHTML`/`translateLLM` path). State that translator provider failures are already alerted and answered by the translator itself (Q1's alternative already says so). Drop the highlight loader, or make it rethrow.
- Confidence: verified.

### 6. Contradiction: in-flight translation jobs both answer and get aborted, and released slots overrun the cap

- Severity: P2 contradiction
- Plan: D1, lines 158-160 (the signal goes to `translate`/`runTranslator`); Slice 1 Files, lines 357-358 ("passed on to `translateLLM` and `runTranslator`"); D4, lines 211-214 ("an aborted call releases its slots … a job already requested still writes the memory pair cache when it answers"); Slice 2 test, lines 393-395.
- Evidence: `runTranslator` forwards `exarg.signal` to `translateMain` (`translator.ts:157,166`), which hands it to `globalFetch`'s `abortSignal` or `fetch`'s `signal` (`:258`, `:303`, `:344`). The in-flight request is therefore aborted, and `translate` writes the memory cache only after a non-throwing answer (`:141-145`). If instead the job keeps running while its slot is released, more than `MAX_TRANSLATION_WORKERS` requests are open, which breaks the Slice 2 "at most ten open" test.
- Correction: choose one behavior.
  - (a) The signal only gates taking a job, and in-flight jobs finish holding their slot. `translate` then gets no signal.
  - (b) In-flight jobs are aborted, and D4's sentence about the cache write is dropped.
- Confidence: verified.

### 7. An abort between `translating = true` and `translating = false` leaves the bound flag stuck

- Severity: P2 design flaw
- Plan: D1, lines 165-168 (the `catch` resolves quietly with no other effect).
- Evidence: `ChatBody.svelte:311-313`, `:327-331` and `:337-339` set `translating = true`, await `translateHTML`, then set it back to `false`, with no `finally`. `translating` is `$bindable` (`:96`) and drives `class:translating` on the translate button (`Chat.svelte:1349`, `:1753`). A run superseded mid-translation, for example by turning translation off, never resets it, and the next run may take a path that never touches it.
- Correction: reset `translating` in a `finally` around each translate await, guarded by `run === parseRun || signal.aborted`, or in the abort branch. Add an assertion to the supersede test.
- Confidence: verified.

### 8. The `shownBody` memo keyed by source string alone misses the reactive inputs `shownBody` reads

- Severity: P2 design flaw
- Plan: D5, lines 236-239.
- Evidence:
  - `shownBody` also reads the `modelShortName` prop (`ChatBody.svelte:466`, `:472`). Today that input is dormant because `aiWatermarkingLawApplies()` returns false (`globalApi.svelte.ts:1495-1500`).
  - Through `trimMarkdown`/`trimMarkdownSharingStyles` → `restoreStyles` → `decodeStyleContent`, it also reads `risuChatParser(text)` (`parser.svelte.ts:1277`), which reads chat variables and settings through the CBS host (`:1368-1376`).
  - The `{@const shown = shownBody(...)}` (`:509`, `:512`) re-runs today when that state changes. A memo hit returns the old `{ html, styles }` and reads no state, so the `{@const}` loses those dependencies altogether.
- Correction: key the memo by `source` and `modelShortName`. Either accept and document that CBS-in-CSS reacts only on the next run, or memoize only the pending-branch `lastParsed` preparation (the case the plan targets) and leave the `:then` branch unmemoized.
- Confidence: likely (whether the CBS reads are tracked under the template was not run, but nothing untracks them).

### 9. `AbortSignal.any` goes against the client's existing Safari < 17.4 precedent

- Severity: P2 contradiction with the codebase
- Plan: D3, lines 198-199; Slice 2 Files, line 380; device checklist, line 479.
- Evidence: `src/ts/storage/assetClient.ts:220` says "The caller's abort is forwarded by hand: `AbortSignal.any` is missing before Safari 17.4.", and `src/ts/storage/tests/assetClient.test.ts:552-554` tests the code without it. No client file uses `AbortSignal.any`; all uses are under `server/`. Type-checking passes (`lib.dom.d.ts:2787`, `target: es2023`), so `pnpm check` would not catch the problem.
- Correction: forward the chunk controller's abort by hand, as `assetClient.ts` does (a listener plus the existing `AbortSignal.timeout`), or add a shared helper. Then drop the device-checklist item.
- Confidence: verified (the precedent). The browser floor itself was not checked.

### 10. The Relation paragraph's "shares no file" is wrong, and the Incremental Chat Transport overlap is missing

- Severity: P2 contradiction
- Plan: Relation, lines 39-46; D8, lines 281-284; Slice 0 Files, lines 337-341.
- Evidence:
  - Job Handoff Slice 3 edits `src/lib/ChatScreens/DefaultChatScreen.svelte` (the "Hand off to…" control beside Stop) and `src/lang/en.ts`/`ko.ts` (`docs/plan/job-handoff.md`, Slice 3 Files). This plan's Slice 4 edits the same Svelte file and, conditionally, the same language files.
  - Asset Lifecycle Slice 4 edits `src/lang/en.ts` (`asset-lifecycle.md:342`).
  - Incremental Chat Transport Slice 0 edits `src/ts/storage/chatStore.svelte.ts` and its tests in `src/ts/storage/tests/chatStore.test.ts` (`incremental-chat-transport.md:294-305`), the same file and test file as this plan's Slice 0. The Relation paragraph does not mention that plan.
  - "Whichever lands first" is worded the same in both plans (`:283-284` here; `incremental-chat-transport.md:34`, `:300-301`). Only the transport plan states the other order ("if its Slice 0 landed first, this slice removes the memo"). This plan's Slice 0 does not say it skips F1 if the index already landed.
- Correction:
  - Name Job Handoff Slice 3 alongside Reroll Candidates Slice 2 for `DefaultChatScreen.svelte` ("not in the same worktree at once"), and note `en.ts`/`ko.ts`.
  - Add the transport plan with its shared files (`chatStore.svelte.ts`, `chatStore.test.ts`, the chat store guide).
  - Add to Slice 0: "if the transport index landed first, F1 is dropped from this slice."
- Confidence: verified.

### 11. Slice sequencing statements contradict the files they list

- Severity: P2 contradiction
- Plan: lines 329-333, Slice 1 Files (lines 360-362), Slice 3 Files (lines 401-402), Slice 4 Files (lines 416-418), Slice 6 (lines 443-448), Slice 0 Files (lines 340-341).
- Evidence:
  - "Slices 1, 3 and 4 touch disjoint files except `parser.svelte.ts`" does not hold: Slices 1 and 3 both edit `docs/structure/cbs-rendering.md`, and Slices 1 and 4 both edit `docs/structure/ui-theming.md`, while being run in parallel worktrees.
  - Slice 6 "needs 1–5", yet it re-lists the `removeHighlight` Issue deletion and the chat store guide that Slice 0 already owns. So it either depends on 0 or duplicates 0's edit.
- Correction: say "disjoint source files; the guides rebase textually", and make Slice 6 "needs 0–5" without re-listing Slice 0's deletion.
- Confidence: verified.

### 12. D6's page rule cannot be met for a row over the side limit, and the 64 MP budget may exceed iOS Safari

- Severity: P2 design gap
- Plan: D6, lines 245-253; Slice 4 tests, lines 422-423.
- Evidence:
  - `html-to-image@1.11.13` `toCanvas` sizes `width*ratio × height*ratio` and, without `skipAutoScale`, rescales any side over 16,384 (`node_modules/html-to-image/es/index.js:15-28`, `es/util.js:103-126`). `SCREENSHOT_CAPTURE_OPTIONS` sets only `includeQueryParams` (`src/lib/ChatScreens/screenshotCapture.ts:4`).
  - A single row taller than 16,384 device px therefore fits no page under "no row split across pages", and its capture comes back smaller than its measured slot, not larger (the plan handles only "taller").
  - Unverified: iOS Safari is commonly cited with a per-canvas area cap of about 16.7 MP (4,096²), well under `MAX_EXPORT_PIXELS = 64_000_000`.
  - The existing code reverses the DOM order (`DefaultChatScreen.svelte:916`). `planScreenshotPages` must keep that order, which D6 does not say.
- Correction: state that an oversized row takes a page alone at its auto-scaled size, and that a capture of a different size is scaled into its slot. Keep the reversed order. Make the pixel budget platform-dependent (a lower cap when `isMobile`), or add it to the device checklist.
- Confidence: verified for the oversized row and the order; unverified for the iOS area cap (needs a device check).

### 13. Stale or wrong guide anchors in slice Files

- Severity: P3
- Plan: Slice 2 Files, lines 382-383; Slice 0 Files, line 340.
- Evidence:
  - No "later render does not join a dispatched batch" fact exists in `docs/structure/cbs-rendering.md` (`rg -n -i "dispatch|join|later render"` finds only line 210, in Display transform). Known Hazards (`:442-504`) has no such entry.
  - `applyServerGeneration`/`showStreamText`/`heldStreamText` are documented under "Job chunks" (`docs/structure/chat-store.md:276`), not "Job hydration" (`:311`). The transport plan correctly cites "Job chunks".
- Correction: point Slice 2 at Display transform (line 210, the batch join) and add the fact there. Change Slice 0 to "Job chunks".
- Confidence: verified.

### 14. Smaller wrong claims about current behavior

- Severity: P3
- Plan, with evidence for each:
  - Line 80: the spinner write is guarded only by `run === parseRun`, not by `destroyed` (`ChatBody.svelte:300`).
  - Line 99: `ParseMarkdown` has five awaits, not four: two `parseAdditionalAssets`, `serverProcessScript`, `parseInlayAssets`, `renderHighlightableMarkdown` (`parser.svelte.ts:961,968,982,988,994`). The Display guide also lists `trimMarkdown` in step 7, but `ChatBody` always passes `notrim`/`pretranslate`, so no sanitizer runs inside its `ParseMarkdown` on the `notrim` path. The "before the sanitizer" checkpoint (line 164) is a no-op for the main path.
  - Line 194: "the greeting" is not a signal-less caller. The greeting is a `Chat` row with a `ChatBody` (`DefaultChatScreen.svelte:1637-1638`), so it gets D1's signal. `BackgroundDom.svelte:16` and plugin `editprocess` (`v3.svelte.ts:1980`) are real signal-less callers.
  - Line 178: "a non-2xx answer it throws" is wrong (see finding 5).
  - Line 218: `translateHTML` does have an identity when a capture exists (`capturedTransform.messageId`/`chatRef`, `transformClient.ts:118-120`). The argument for the cache key (identical text in two messages, and no capture without a server context) still stands; only the "no identity" wording is wrong.
  - Lines 133-135: `downloadFile` makes one more copy, `new Uint8Array(dat)` on the Buffer (`globalApi.svelte.ts:82`), so four copies exist, not three.
- Correction: fix the wording. None of these changes a decision.
- Confidence: verified.

## Checked and found sound

- The four-attempt retry: `tries` goes undefined → 1 → 2 → 3, with the alert at `tries > 2` (`ChatBody.svelte:358-374`). The retries keep `run`, the capture and the stored state (`:367-379`). The `finally` guard `!destroyed && run === parseRun` (`:388`).
- The 10 ms flip, `pendingAutoTranslate`, and the `whenRendered` loop (`ChatBody.svelte:280-293`, `:483-491`). The `{#await}` shows `lastParsed` pending and `md` in `:then` (`:508-513`), and the `finally` sets `lastParsed = lastParsedQueue`, which equals the returned body. A one-entry memo therefore covers the then→pending alternation, apart from the key gap in finding 8.
- The `ParseMarkdown` signature (`parser.svelte.ts:931-938`). The trailing `signal` parameter fits after `capturedTransform`, and after `kind` in `serverProcessScript` (`transformClient.ts:568-576`).
- transformClient:
  - `Batch`, `Operation`, `batch.shared`, `schedule` (frame or 16 ms), `batches.clear()`, `MAX_TRANSFORM_*` splitting, `CHUNK_DEADLINE_MS`.
  - `postOnce` uses `AbortSignal.timeout` (`:349`).
  - The `epochRefusals`/`permanentRefusals` WeakSets (`:339-341`).
  - `inputs` includes both generations and `knownKey` (`:645-652`).
  - Each caller has its own `completion` promise (`shared.answer.then` per call, `:673`), so an aborted caller can race its own promise to its input text without disturbing the other caller. The side effects in finding 2 still run, though.
- CSS scope cache key completeness: `decodeStyleRule` reads only constants (`.chattext `, `x-risu-`, `data:,`), and `css.stringify` takes fixed options. `settings.ui.returnCSSError` is read only in the `catch` (`parser.svelte.ts:1228-1298`). Safe mode never reaches it (`SafeModeStore` is used only at `Chat.svelte:2248` and `colorscheme.ts:373`). So the post-CBS text is a complete key, and a parse or selector error throws inside the `try` and is not cached.
- `ChatStyleRegistry.acquire` keys by `JSON.stringify([css, attributes])` (`chatStyles.ts:64`). `transformResults.ts` has the insertion-order `Map` with a byte counter and oldest-first eviction.
- Translator anchors:
  - `Math.min(10, jobs.length)` workers per call (`translator.ts:554`).
  - `translateLLM(text, context, regenerate, failure?, signal?)` checks its signal between steps (`:714-786`) and is called without one from `translateHTML` (`:425`).
  - `runTranslator`'s `exarg.signal` (`:155`).
  - `readLLMCacheEntry` is a localforage (IndexedDB) storage read (`:93`, `:704-705`).
  - The stored path's `inFlight` map (`storedTranslation.svelte.ts:50`, `:123-143`).
- `screenShot`: as described, including the `width`/`height` reallocation inside the summing loop, `canvas.remove()` on canvases that never entered the DOM, and `toDataURL` → `Buffer` → `downloadFile` (`DefaultChatScreen.svelte:894-962`).
- `downloadFile(name, dat: Uint8Array | ArrayBuffer | string)` (`globalApi.svelte.ts:78`).
- `html-to-image` 1.11.13 has no `exports` map and exports `getImageSize` from `es/util.js:77`.
- The named tests exist by title: `ChatBody.svelte.test.ts:103` and `:198`. `hoisted.parses` exists (`:11`). The other named test and driver files exist. `stack.mjs` exports `isolateContext` (`:57`) and `startStack` (`:128`).
- Slice 0 anchors:
  - `PartialEditController.svelte:166` compares against `"block"` while `:192` sets `"flex"`.
  - `hasTextContent` is at `:108`.
  - `highlight.ts` `formatedRanges` (`:107-121`) and `removeHighlight` (`:130`).
  - The `removeHighlight` Issue is at `cbs-rendering.md:447`.
- The Reroll Candidates Slice 2 overlap (the `reroll` function in `DefaultChatScreen.svelte`) is stated correctly.
- No Svelte runes constraint is broken today. Aborting inside `$derived.by` runs abort listeners synchronously, but none of the client's existing listeners write `$state`. New listeners added by Slices 1-2 should keep it that way.
